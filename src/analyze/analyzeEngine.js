// ================= FILE: src/analyze/analyzeEngine.js =================
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { CONFIG } from '../config.js';
import * as KeysApi from '../keys.js';


import {
  getDurableRedis,
  getJson,
  setJson,
  setNxJson,
  delJson
} from '../redis.js';


import {
  getIsoWeekKey,
  normalizeBaseSymbol,
  randomId,
  safeNumber,
  sideToTradeSide,
  stableHash,
  parseLongTaxonomyMicroId,
  isSelectableLongTrueMicroFamilyId,
  validLearningId
} from '../utils.js';


import { attachMicroFamilies } from './microFamilies.js';


import {
  createMicroStats,
  updateObservation,
  updateOutcome,
  refreshStats,
  entryTemporalFields,
  exitTemporalFields,
  ensureTemporalStats,
  recordTemporalObservation,
  recordTemporalOutcome,
  resetTemporalOutcomeMetrics,
  TEMPORAL_CONTEXT_VERSION,
  TEMPORAL_POLICY_VERSION,
  WEEKEND_POLICY_VERSION,
  SESSION_POLICY_VERSION,
  TEMPORAL_TAXONOMY_VERSION,
  TEMPORAL_COST_MODEL_VERSION,
  temporalRuntimeConfig,
  temporalStatsEnabled,
  normalizeTemporalOutcome
} from './scoring.js';


const KEYS = KeysApi.KEYS || KeysApi.keys || null;


if (!KEYS || typeof KEYS !== 'object' || !KEYS.analyze) {
  throw new Error(
    'ANALYZE_ENGINE_KEYS_API_MISSING: keys.js must export KEYS.analyze or keys.analyze'
    );
}


const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const TARGET_SCANNER_SIDE = 'bull';


const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;
const ANALYZE_KEY_PREFIX = `${LONG_KEY_PREFIX}ANALYZE:`;
const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';


// WEEK_MICROS large-document storage.
// Mirrors the already proven NEXT_ROTATION/ROTATION_VALID_FROM Upstash pattern:
// small documents remain normal JSON; large documents are gzip/base64 chunked.
const WEEK_MICROS_LARGE_DOCUMENT_STORAGE_SCHEMA =
    'LONG_WEEK_MICROS_LARGE_DOCUMENT_V1';
const WEEK_MICROS_LARGE_DOCUMENT_ENCODING = 'gzip-base64-chunks';
const WEEK_MICROS_LARGE_DOCUMENT_THRESHOLD_BYTES = 6_000_000;
const WEEK_MICROS_LARGE_DOCUMENT_CHUNK_CHAR_LIMIT = 2_500_000;
const WEEK_MICROS_LARGE_DOCUMENT_MAX_CHUNKS = 64;


const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const MICRO_MICRO_SCHEMA = TRUE_MICRO_SCHEMA;


const MEASUREMENT_FIX_VERSION =
    'LONG_MEASUREMENT_FIX_TRIGGER_BOUNDARY_EXIT_FILL_V2';


const PREVIOUS_MEASUREMENT_FIX_VERSION =
    'LONG_MEASUREMENT_FIX_AVGCOST_DIRECTSL_SEEN_DEDUPE_V1';


const EXIT_FILL_MODEL_VERSION =
    'LONG_TRIGGER_BOUNDARY_FILL_PLUS_COST_MODEL_V1';


const OUTCOME_MEASUREMENT_GATE_MODE =
    'STRICT_EXACT_VERSION';


const LEARNING_GRANULARITY =
    'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';


const PARENT_LEARNING_GRANULARITY =
    'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_V1';




function namespacedLongAnalyzeKey(key, fallback = '') {
    let raw = String(key || fallback || '').trim();
    if (!raw) throw new Error('LONG_ANALYZE_KEY_REQUIRED');
    if (raw.startsWith(LONG_KEY_PREFIX)) return raw;
    if (raw.startsWith('SHORT:') || raw.includes(`${LONG_KEY_PREFIX}SHORT:`)) {
        throw new Error('LONG_ANALYZE_KEY_REJECTED_SHORT_NAMESPACE');
    }
    return `${LONG_KEY_PREFIX}${raw}`;
}


function resolveAnalyzeKeyFunction(name) {
    const longFn = KEYS.long?.analyze?.[name];
    const genericFn = KEYS.analyze?.[name];
    if (typeof longFn === 'function') return longFn;
    if (typeof genericFn === 'function') return genericFn;
    throw new Error(`ANALYZE_KEY_FUNCTION_MISSING:${name}`);
}


const ANALYZE_KEYS = Object.freeze({
    obsLast: (...args) => namespacedLongAnalyzeKey(
         resolveAnalyzeKeyFunction('obsLast')(...args)
    ),
    weekMicros: (...args) => namespacedLongAnalyzeKey(
         resolveAnalyzeKeyFunction('weekMicros')(...args)
    ),
    weekParents: (...args) => namespacedLongAnalyzeKey(
         resolveAnalyzeKeyFunction('weekParents')(...args)
    ),
    microStats: (...args) => namespacedLongAnalyzeKey(
         resolveAnalyzeKeyFunction('microStats')(...args)
    ),
    parentStats: (...args) => namespacedLongAnalyzeKey(
         resolveAnalyzeKeyFunction('parentStats')(...args)
    ),
    microOutcomes: (...args) => namespacedLongAnalyzeKey(
         resolveAnalyzeKeyFunction('microOutcomes')(...args)
    )
});


const WRITE_SCOPE =
    KEYS.scopes?.LONG_ANALYZE_PARTIAL ||
    KEYS.scopes?.ANALYZE_LONG_PARTIAL ||
    null;


const DEFAULT_OBSERVATION_TTL_SEC = 60 * 60 * 24 * 62;
const DEFAULT_OUTCOME_TTL_SEC = 60 * 60 * 24 * 365;
const DEFAULT_RECENT_OUTCOME_LIMIT = 250;
const DEFAULT_MAX_MICRO_OUTCOME_HISTORY_BYTES = 2_000_000;
const EMERGENCY_MAX_MICRO_OUTCOME_HISTORY_BYTES = 500_000;
const DEFAULT_DEDUPE_CONCURRENCY = 24;
const DEFAULT_MIRROR_WRITE_CONCURRENCY = 12;


const MAX_RECENT_OUTCOME_LIMIT = 1000;
const MAX_COMPACT_DEFINITION_PARTS = 16;
const MAX_COMPACT_STRING_LENGTH = 240;
const MAX_STATS_STRING_LENGTH = 1000;
const MAX_GENERIC_ARRAY_ITEMS = 1000;


const HEAVY_DROP_KEYS = new Set([
    'rows',
    'symbols',
    'candidates',
    'candidateRows',
    'actions',
    'virtualActions',
    'scannerRows',
    'marketWeatherRows',
    'candles',
    'candles15m',
    'candles1h',
    'candles4h',
    'candleData',
    'rawCandles',
    'rawOrderBook',
    'orderBook',
    'orderbook',
    'currentMarketUniverse',
    'entryMarketUniverse',
    'marketUniverse',
    'universe',
    'scannerDefinitionParts',
    'microDefinitionParts',
    'macroDefinitionParts',
    'parentDefinitionParts',
    'executionFingerprintParts'
]);


function now() {
    return Date.now();
}


function upper(value) {
    return String(value || '').trim().toUpperCase();
}


function normalizeMeasurementFixVersion(value = '') {
    return upper(value);
}


function rowMeasurementFixVersion(row = {}) {
    return normalizeMeasurementFixVersion(
      row.measurementFixVersion ??
           row.outcomeMeasurementVersion ??
           row.positionMeasurementFixVersion ??
           row.measurementVersion ??
           row.exitMeasurementVersion ??
           ''
    );
}


function isCurrentMeasurementOutcome(row = {}) {
    return rowMeasurementFixVersion(row) === MEASUREMENT_FIX_VERSION;
}


function currentMeasurementPolicyFields(row = {}) {
    return {
         measurementFixVersion: MEASUREMENT_FIX_VERSION,
         outcomeMeasurementVersion: MEASUREMENT_FIX_VERSION,
         acceptedOutcomeMeasurementVersion: MEASUREMENT_FIX_VERSION,
         previousSupportedMeasurementFixVersion:
           PREVIOUS_MEASUREMENT_FIX_VERSION,


         outcomeMeasurementGateMode:
           OUTCOME_MEASUREMENT_GATE_MODE,


         outcomeMeasurementVersionRequired: true,
         strictOutcomeMeasurementGate: true,
         legacyOutcomeMeasurementsExcluded: true,
         completedCurrentMeasurementOnly: true,


         exitFillModelVersion:
           row.exitFillModelVersion ||
           EXIT_FILL_MODEL_VERSION,


         exitFillPolicy:
           'TP_SL_USE_TRIGGER_BOUNDARY_TIME_STOP_USES_OBSERVED_PRICE'
    };
}


function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
         ? value
         : {};
}


function uniqueStrings(values = []) {
    return [
         ...new Set(
           (Array.isArray(values) ? values : [values])
             .flat(Infinity)
             .map((value) => String(value || '').trim())
             .filter(Boolean)
         )
    ];
}


function compactText(value, maxLength = MAX_COMPACT_STRING_LENGTH) {
    const text = String(value || '').trim();


    if (!text) return null;


    return text.length > maxLength ? text.slice(0, maxLength) : text;
}


function compactStringList(
    values = [],
    limit = MAX_COMPACT_DEFINITION_PARTS,
    maxLength = MAX_COMPACT_STRING_LENGTH
) {
    return uniqueStrings(values)
         .map((value) => compactText(value, maxLength))
         .filter(Boolean)
         .slice(0, limit);
}


function nxInsertSucceeded(result) {
    return (
         result === 'OK' ||
         result === 'ok' ||
         result === true ||
         result === 1
    );
}


function normalizeConcurrency(value, fallback, max = 50) {
    const n = Math.floor(safeNumber(value, fallback));


    if (!Number.isFinite(n) || n <= 0) return fallback;


    return Math.max(1, Math.min(max, n));
}


async function mapLimit(values = [], concurrency = 8, worker) {
    const rows = Array.isArray(values) ? values : [];
    const out = new Array(rows.length);
    const limit = normalizeConcurrency(concurrency, 8, 50);
    let cursor = 0;


    async function runWorker() {
         while (true) {
             const index = cursor;
             cursor += 1;


             if (index >= rows.length) return;


             out[index] = await worker(rows[index], index);
         }
    }


    await Promise.all(
         Array.from(
             { length: Math.min(limit, Math.max(1, rows.length)) },
             () => runWorker()
         )
    );


    return out;
}


function assertAnalyzeWrite(key) {
    const normalizedKey = String(key || '').trim();


    if (!normalizedKey) {
         throw new Error('ANALYZE_WRITE_KEY_REQUIRED');
    }


    if (WRITE_SCOPE && typeof KeysApi.assertKeyAllowedForWriteScope === 'function')
{
         return KeysApi.assertKeyAllowedForWriteScope(WRITE_SCOPE, normalizedKey);
    }


    if (!normalizedKey.startsWith(ANALYZE_KEY_PREFIX)) {
         const error = new Error('ANALYZE_WRITE_SCOPE_VIOLATION_LONG_ONLY');


         error.details = {
             scopeName: WRITE_SCOPE,
             key: normalizedKey,
             requiredPrefix: ANALYZE_KEY_PREFIX,
             namespace: LONG_NAMESPACE,
             keyPrefix: LONG_KEY_PREFIX,
             targetTradeSide: TARGET_TRADE_SIDE,
             dashboardSide: TARGET_DASHBOARD_SIDE,
             scannerSide: TARGET_SCANNER_SIDE,
              longOnly: true,
              shortDisabled: true,
              shortRootTouched: false,
              virtualOnly: true,
              realOrdersDisabled: true,
              bitgetOrdersDisabled: true,
              exchangeOrdersDisabled: true
         };


         throw error;
    }


    return true;
}


function resolveWeekKey(value) {
    const raw = String(value || '').trim();
    return raw || PERSISTENT_LEARNING_KEY;
}


function observationTtlSec() {
    return Math.max(
         60,
         Math.floor(
              safeNumber(
                  CONFIG.long?.analyze?.observationDedupeTtlSec ??
                    CONFIG.analyze?.observationDedupeTtlSec,
                  DEFAULT_OBSERVATION_TTL_SEC
              )
         )
    );
}


function outcomeTtlSec() {
    return Math.max(
         60,
         Math.floor(
              safeNumber(
                  CONFIG.long?.analyze?.outcomeDedupeTtlSec ??
                    CONFIG.analyze?.outcomeDedupeTtlSec,
                  DEFAULT_OUTCOME_TTL_SEC
              )
         )
    );
}


function recentOutcomeLimit() {
    const configured = Math.floor(
         safeNumber(
              CONFIG.long?.analyze?.recentOutcomeLimit ??
                CONFIG.analyze?.recentOutcomeLimit,
              DEFAULT_RECENT_OUTCOME_LIMIT
         )
    );


    return Math.max(20, Math.min(MAX_RECENT_OUTCOME_LIMIT, configured));
}


function maxMicroOutcomeHistoryBytes() {
    const configured = Math.floor(
         safeNumber(
              CONFIG.long?.analyze?.maxMicroOutcomeHistoryBytes ??
                CONFIG.analyze?.maxMicroOutcomeHistoryBytes,
              DEFAULT_MAX_MICRO_OUTCOME_HISTORY_BYTES
         )
    );


    return Math.max(250_000, Math.min(8_000_000, configured));
}


function dedupeConcurrency() {
    return normalizeConcurrency(
         CONFIG.long?.analyze?.dedupeConcurrency ??
              CONFIG.analyze?.dedupeConcurrency,
         DEFAULT_DEDUPE_CONCURRENCY,
         50
    );
}


function mirrorWriteConcurrency() {
    return normalizeConcurrency(
         CONFIG.long?.analyze?.mirrorWriteConcurrency ??
              CONFIG.analyze?.mirrorWriteConcurrency,
         DEFAULT_MIRROR_WRITE_CONCURRENCY,
         30
    );
}


function normalizeSource(value) {
    return upper(value || 'VIRTUAL') === 'SHADOW' ? 'SHADOW' : 'VIRTUAL';
}


function jsonByteLength(value) {
    try {
        return Buffer.byteLength(JSON.stringify(value), 'utf8');
    } catch {
        return Number.POSITIVE_INFINITY;
    }
}


function compactMarketWeather(value = null) {
    const weather = asObject(value);


    if (!Object.keys(weather).length) return null;


    return {
        ok: weather.ok !== false,
        available: weather.available !== false,
        version: compactText(weather.version, 100),
        source: compactText(weather.source, 40),
        snapshotId: compactText(weather.snapshotId, 120),
        generatedAt: safeNumber(weather.generatedAt, 0) || null,
        createdAt: safeNumber(weather.createdAt, 0) || null,
        completedAt: safeNumber(weather.completedAt, 0) || null,
        updatedAt: safeNumber(weather.updatedAt, 0) || null,
        currentRegime: compactText(
             weather.currentRegime || weather.regime,
             40
        ),
        currentTrendSide: compactText(
             weather.currentTrendSide || weather.trendSide,
             40
        ),
        currentFlow: compactText(weather.currentFlow || weather.flow, 60),
        currentVolatilityState: compactText(
             weather.currentVolatilityState || weather.volatilityState,
             60
        ),
        confidence: safeNumber(
             weather.confidence ?? weather.weatherConfidence,
             0
        ),
        bearishPct: safeNumber(weather.bearishPct, 0),
        bullishPct: safeNumber(weather.bullishPct, 0),
        neutralPct: safeNumber(weather.neutralPct, 0),
        squeezePct: safeNumber(weather.squeezePct, 0),
        avgAtrPct: safeNumber(weather.avgAtrPct, 0),
        avgRangePct: safeNumber(weather.avgRangePct, 0),
        avgRealizedVolPct: safeNumber(weather.avgRealizedVolPct, 0),
        avgVolumeExpansion: safeNumber(weather.avgVolumeExpansion, 0),
        universeCount: safeNumber(weather.universeCount ?? weather.count, 0),
         rowsExcluded: true,
         symbolsExcluded: true
    };
}


function stripHeavyValue(value, depth = 0, keyName = '') {
    if (value === null || value === undefined) return value;


    if (depth > 7) return null;


    if (typeof value === 'string') {
         return value.length > MAX_STATS_STRING_LENGTH
             ? value.slice(0, MAX_STATS_STRING_LENGTH)
             : value;
    }


    if (typeof value !== 'object') return value;


    if (
         keyName === 'currentMarketWeather' ||
         keyName === 'entryMarketWeather' ||
         keyName === 'marketWeather'
    ) {
         return compactMarketWeather(value);
    }


    if (Array.isArray(value)) {
         const source = value.slice(-MAX_GENERIC_ARRAY_ITEMS);
         return source.map((row) => stripHeavyValue(row, depth + 1, keyName));
    }


    const out = {};


    for (const [key, child] of Object.entries(value)) {
         if (HEAVY_DROP_KEYS.has(key)) continue;


         if (key === 'definitionParts') {
             out[key] = compactStringList(child, MAX_COMPACT_DEFINITION_PARTS, 180);
             continue;
         }


         if (key === 'recentOutcomes') {
             out[key] = (Array.isArray(child) ? child : [])
               .slice(-recentOutcomeLimit())
               .map((row) => minimalOutcomeRecord(row));
             continue;
         }
         out[key] = stripHeavyValue(child, depth + 1, key);
    }


    return out;
}


function compactOutcomeRecord(input = {}, overrides = {}) {
    const row = {
         ...asObject(input),
         ...asObject(overrides)
    };


    const childCandidate = upper(
         row.trueMicroFamilyId ||
             row.childTrueMicroFamilyId ||
             row.microFamilyId ||
             row.analyzeMicroFamilyId ||
             row.learningMicroFamilyId
    );


    const parsed = parseLongTaxonomyMicroId(childCandidate);


    const childId = parsed?.isChild
         ? upper(parsed.childTrueMicroFamilyId || childCandidate)
         : childCandidate;


    const parentId = upper(
         row.parentTrueMicroFamilyId ||
             row.parentMicroFamilyId ||
             row.parentMacroFamilyId ||
             row.coarseMicroFamilyId ||
             parsed?.parentTrueMicroFamilyId
    );


    const source = normalizeSource(row.source || row.outcomeSource);


    const entry = safeNumber(row.entry ?? row.entryPrice, 0);
    const initialSl = safeNumber(
         row.initialSl ?? row.initialStopLoss ?? row.sl ?? row.stopLoss,
         0
    );
    const sl = safeNumber(row.sl ?? row.stopLoss ?? initialSl, initialSl);
    const tp = safeNumber(row.tp ?? row.takeProfit, 0);
    const exitPrice = safeNumber(
         row.exitPrice ?? row.currentPrice ?? row.lastPrice ?? row.price,
         0
);
const grossR = safeNumber(
     row.grossR ?? row.longGrossR ?? row.rawR,
     0
);
const netR = safeNumber(
     row.netR ??
          row.exitR ??
          row.netPnlR ??
          row.realizedNetR ??
          row.realizedR,
     grossR
);
const costR = safeNumber(
     row.costR ?? row.totalCostR,
     Math.max(0, grossR - netR)
);
const closedAt = safeNumber(
     row.closedAt ?? row.completedAt ?? row.exitAt,
     0
);
const openedAt = safeNumber(
     row.openedAt ?? row.createdAt ?? row.entryAt,
     0
);


const symbol =
     normalizeBaseSymbol(
          row.symbol || row.baseSymbol || row.contractSymbol
     ) || 'UNKNOWN';


const contractSymbol = compactText(
     row.contractSymbol || (symbol !== 'UNKNOWN' ? `${symbol}USDT` : null),
     80
);


const entryTemporal = entryTemporalFields(row);
const exitTemporal = exitTemporalFields({
     ...row,
     exitTs: closedAt || row.exitTs
});


return {
     ok: row.ok !== false,
     learnable: row.learnable !== false,


     outcomeId: compactText(
     row.outcomeId || row.canonicalOutcomeId || row.canonicalPositionId || row.positionId || row.tradeId || row.id,
     160
),
canonicalPositionId: compactText(
     row.canonicalPositionId || row.positionId || row.tradeId || row.id,
     180
),
canonicalOutcomeId: compactText(
     row.canonicalOutcomeId || row.canonicalPositionId || row.outcomeId || row.positionId || row.tradeId || row.id,
     180
),
canonicalIdentitySource: compactText(row.canonicalIdentitySource, 100),
originReference: compactText(
     row.originReference || row.candidateId || row.signalId || row.entryId,
     180
),
positionId: compactText(row.positionId || row.tradeId || row.id, 160),
outcomeDedupeKey: compactText(row.outcomeDedupeKey, 220),
snapshotId: compactText(row.snapshotId || row.scanId || row.batchId, 160),
scannerRunId: compactText(row.scannerRunId, 160),
marketCycleId: compactText(row.marketCycleId, 160),
marketEventClusterId: compactText(row.marketEventClusterId || entryTemporal.marketEventClusterId, 180),


symbol,
baseSymbol: symbol,
contractSymbol,


side: TARGET_DASHBOARD_SIDE,
dashboardSide: TARGET_DASHBOARD_SIDE,
tradeSide: TARGET_TRADE_SIDE,
positionSide: TARGET_TRADE_SIDE,
direction: TARGET_TRADE_SIDE,
scannerSide: TARGET_SCANNER_SIDE,
actualScannerSide: TARGET_SCANNER_SIDE,


source,
outcomeSource: source,
status: compactText(row.status || 'CLOSED', 40),


measurementFixVersion: compactText(
     rowMeasurementFixVersion(row),
     120
),
outcomeMeasurementVersion: compactText(
     row.outcomeMeasurementVersion ||
          row.measurementFixVersion,
     120
),
acceptedOutcomeMeasurementVersion: compactText(
     row.acceptedOutcomeMeasurementVersion,
     120
),
previousSupportedMeasurementFixVersion: compactText(
     row.previousSupportedMeasurementFixVersion,
     120
),
outcomeMeasurementGateMode: compactText(
     row.outcomeMeasurementGateMode,
     80
),
outcomeMeasurementVersionRequired:
     row.outcomeMeasurementVersionRequired === true,
strictOutcomeMeasurementGate:
     row.strictOutcomeMeasurementGate === true,
legacyOutcomeMeasurementsExcluded:
     row.legacyOutcomeMeasurementsExcluded === true,
completedCurrentMeasurementOnly:
     row.completedCurrentMeasurementOnly === true,


temporalPolicyVersion: compactText(
     row.temporalPolicyVersion || TEMPORAL_POLICY_VERSION,
     120
),
taxonomyVersion: compactText(
     row.taxonomyVersion || row.trueMicroFamilySchema || TEMPORAL_TAXONOMY_VERSION,
     120
),
costModelVersion: compactText(
     row.costModelVersion || row.exitFillModelVersion || TEMPORAL_COST_MODEL_VERSION,
     120
),
exitFillModelVersion: compactText(
     row.exitFillModelVersion,
     120
),
exitFillPolicy: compactText(
     row.exitFillPolicy,
     180
),
exitFillSource: compactText(
     row.exitFillSource,
     100
),
exitFillAssumption: compactText(
     row.exitFillAssumption,
     180
),
triggerBoundaryFillApplied:
     row.triggerBoundaryFillApplied === true,


exitObservedPrice: safeNumber(
     row.exitObservedPrice,
     0
),
exitFillPrice: safeNumber(
     row.exitFillPrice ?? row.exitPrice,
     0
),
exitTriggerPrice: safeNumber(
     row.exitTriggerPrice,
     0
),
observedVsFillPct: safeNumber(
     row.observedVsFillPct,
     0
),
observedBeyondTriggerPct: safeNumber(
     row.observedBeyondTriggerPct,
     0
),


longOnly: true,
shortDisabled: true,
virtualOnly: true,
realTrade: false,
realOrder: false,
exchangeOrder: false,
bitgetOrderPlaced: false,


trueMicroFamilyId: childId || null,
childTrueMicroFamilyId: childId || null,
microFamilyId: childId || null,
analyzeMicroFamilyId: childId || null,
learningMicroFamilyId: childId || null,
microMicroFamilyId: childId || null,


parentTrueMicroFamilyId: parentId || null,
parentMicroFamilyId: parentId || null,
parentMacroFamilyId: parentId || null,
coarseMicroFamilyId: parentId || null,


setupType: compactText(row.setupType || row.setup || parsed?.setup, 60),
regimeBucket: compactText(row.regimeBucket || parsed?.regime, 60),
confirmationProfile: compactText(
     row.confirmationProfile || parsed?.confirmationProfile,
     80
),


trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
learningGranularity: LEARNING_GRANULARITY,
parentLearningGranularity: PARENT_LEARNING_GRANULARITY,


entry,
entryPrice: entry,
initialSl,
sl,
tp,
exitPrice,


grossR,
longGrossR: grossR,
rawR: grossR,
netR,
exitR: netR,
realizedR: safeNumber(row.realizedR, netR),
costR,


riskPct: safeNumber(row.riskPct, 0),
rewardPct: safeNumber(row.rewardPct, 0),
grossMovePct: safeNumber(row.grossMovePct, 0),


feeR: safeNumber(row.feeR, 0),
slippageR: safeNumber(row.slippageR, 0),
marketImpactR: safeNumber(row.marketImpactR, 0),
spreadCostR: safeNumber(row.spreadCostR, 0),


feePct: safeNumber(row.feePct, 0),
slippagePct: safeNumber(row.slippagePct, 0),
costPct: safeNumber(row.costPct, 0),
grossPnlPct: safeNumber(row.grossPnlPct, 0),
netPnlPct: safeNumber(row.netPnlPct ?? row.pnlPct, 0),
pnlPct: safeNumber(row.pnlPct ?? row.netPnlPct, 0),


currentR: safeNumber(row.currentR, 0),
longCurrentR: safeNumber(row.longCurrentR ?? row.currentR, 0),
mfeR: safeNumber(row.mfeR, 0),
maeR: safeNumber(row.maeR, 0),
maxTpProgress: safeNumber(row.maxTpProgress, 0),
ticksObserved: safeNumber(row.ticksObserved, 0),
favorableTicks: safeNumber(row.favorableTicks, 0),
adverseTicks: safeNumber(row.adverseTicks, 0),


reachedHalfR: Boolean(row.reachedHalfR),
reachedOneR: Boolean(row.reachedOneR),
nearTpSeen: Boolean(row.nearTpSeen),


beArmed: Boolean(row.beArmed),
beWouldExit: Boolean(row.beWouldExit),
beExitR: safeNumber(row.beExitR, 0),


gaveBackAfterHalfR: Boolean(row.gaveBackAfterHalfR),
gaveBackAfterOneR: Boolean(row.gaveBackAfterOneR),
nearTpThenLoss: Boolean(row.nearTpThenLoss),


liveManaged: Boolean(row.liveManaged),
beLiveApplied: Boolean(row.beLiveApplied),
trailLiveApplied: Boolean(row.trailLiveApplied),
slManagementSource: compactText(row.slManagementSource, 40),


directToSL: Boolean(row.directToSL ?? row.directSL),
directSL: Boolean(row.directSL ?? row.directToSL),


exitReason: compactText(
  upper(row.exitReason || row.reason || 'UNKNOWN'),
  100
),
scannerReason: compactText(row.scannerReason, 100),


currentFit: compactText(
     typeof row.currentFit === 'string'
         ? row.currentFit
         : row.currentFitLabel || row.entryCurrentFit,
     100
),
currentFitScore: safeNumber(row.currentFitScore ?? row.fitScore, 0),
currentFitConfidence: safeNumber(
     row.currentFitConfidence ?? row.entryCurrentFitConfidence,
     0
),


scannerScore: safeNumber(row.scannerScore, 0),
moveScore: safeNumber(row.moveScore, 0),
change1h: safeNumber(row.change1h, 0),
change24h: safeNumber(row.change24h, 0),
volume24h: safeNumber(
     row.volume24h ?? row.quoteVolume24h ?? row.quoteVolume,
     0
),
volumeExpansion: safeNumber(row.volumeExpansion, 0),
atrPct: safeNumber(row.atrPct, 0),


openedAt: openedAt || null,
createdAt: openedAt || safeNumber(row.createdAt, 0) || null,
closedAt: closedAt || null,
completedAt: closedAt || safeNumber(row.completedAt, 0) || null,
outcomeFinalizedTs: safeNumber(
     row.outcomeFinalizedTs ?? row.finalizedAt ?? closedAt,
     closedAt
) || null,
outcomePersistedTs: safeNumber(
     row.outcomePersistedTs ?? row.persistedAt ?? row.recordedAt ?? row.updatedAt,
     0
) || null,
acceptedTemporalOutcomeSeq: Math.max(
     0,
     Math.floor(safeNumber(row.acceptedTemporalOutcomeSeq, 0))
),
entryDecisionSnapshot: stripHeavyValue(row.entryDecisionSnapshot || row.temporalEntryDecisionSnapshot || null),
entryPublicationResult: stripHeavyValue(row.entryPublicationResult || null),
exitPublicationResult: stripHeavyValue(row.exitPublicationResult || null),
updatedAt: safeNumber(row.updatedAt, now()),


...entryTemporal,
...exitTemporal,


outcomeDuplicate: Boolean(row.outcomeDuplicate),
outcomeAlreadyRecorded: Boolean(row.outcomeAlreadyRecorded),
outcomeCounted: row.outcomeCounted !== false,
countOutcome: row.countOutcome !== false,


definitionParts: compactStringList(
     row.definitionParts || row.microDefinitionParts || [],
     MAX_COMPACT_DEFINITION_PARTS,
     180
),


currentMarketWeather: compactMarketWeather(
              row.currentMarketWeather || row.entryMarketWeather || row.marketWeather
         ),


         fullScannerPayloadExcluded: true,
         marketWeatherRowsExcluded: true,
         candleDataExcluded: true,
         executionFingerprintPartsExcluded: true
    };
}


function minimalOutcomeRecord(row = {}) {
    const compact = compactOutcomeRecord(row);


    return {
         outcomeId: compact.outcomeId,
         canonicalPositionId: compact.canonicalPositionId,
         canonicalOutcomeId: compact.canonicalOutcomeId,
         canonicalIdentitySource: compact.canonicalIdentitySource,
         originReference: compact.originReference,
         positionId: compact.positionId,
         snapshotId: compact.snapshotId,
         scannerRunId: compact.scannerRunId,
         marketCycleId: compact.marketCycleId,
         marketEventClusterId: compact.marketEventClusterId,
         symbol: compact.symbol,
         contractSymbol: compact.contractSymbol,
         source: compact.source,
         status: compact.status,


         measurementFixVersion: compact.measurementFixVersion,
         outcomeMeasurementVersion:
              compact.outcomeMeasurementVersion,
         temporalPolicyVersion: compact.temporalPolicyVersion,
         taxonomyVersion: compact.taxonomyVersion,
         costModelVersion: compact.costModelVersion,
         exitFillModelVersion:
              compact.exitFillModelVersion,
         exitFillSource:
              compact.exitFillSource,
         exitFillAssumption:
              compact.exitFillAssumption,
         triggerBoundaryFillApplied:
              compact.triggerBoundaryFillApplied,
         exitObservedPrice:
              compact.exitObservedPrice,
         exitFillPrice:
              compact.exitFillPrice,
         exitTriggerPrice:
              compact.exitTriggerPrice,
         observedVsFillPct:
              compact.observedVsFillPct,
         observedBeyondTriggerPct:
              compact.observedBeyondTriggerPct,


         trueMicroFamilyId: compact.trueMicroFamilyId,
         parentTrueMicroFamilyId: compact.parentTrueMicroFamilyId,
         setupType: compact.setupType,
regimeBucket: compact.regimeBucket,
confirmationProfile: compact.confirmationProfile,
entry: compact.entry,
initialSl: compact.initialSl,
tp: compact.tp,
exitPrice: compact.exitPrice,
grossR: compact.grossR,
netR: compact.netR,
costR: compact.costR,
netPnlPct: compact.netPnlPct,
pnlPct: compact.pnlPct,


currentR: compact.currentR,
longCurrentR: compact.longCurrentR,
mfeR: compact.mfeR,
maeR: compact.maeR,
maxTpProgress: compact.maxTpProgress,


reachedHalfR: compact.reachedHalfR,
reachedOneR: compact.reachedOneR,
nearTpSeen: compact.nearTpSeen,
beArmed: compact.beArmed,
beWouldExit: compact.beWouldExit,
beExitR: compact.beExitR,
gaveBackAfterHalfR: compact.gaveBackAfterHalfR,
gaveBackAfterOneR: compact.gaveBackAfterOneR,
nearTpThenLoss: compact.nearTpThenLoss,


exitReason: compact.exitReason,
openedAt: compact.openedAt,
closedAt: compact.closedAt,


temporalContextVersion: compact.temporalContextVersion,
contextTs: compact.contextTs,
hourUtc: compact.hourUtc,
dayOfWeekUtc: compact.dayOfWeekUtc,
dayType: compact.dayType,
isWeekend: compact.isWeekend,
sessionTags: compact.sessionTags,
primarySessionBucket: compact.primarySessionBucket,
sessionOverlap: compact.sessionOverlap,
offHours: compact.offHours,


entryTs: compact.entryTs,
entryHourUtc: compact.entryHourUtc,
entryDayOfWeekUtc: compact.entryDayOfWeekUtc,
entryDayType: compact.entryDayType,
         entryIsWeekend: compact.entryIsWeekend,
         entrySessionTags: compact.entrySessionTags,
         entrySessionBucket: compact.entrySessionBucket,
         entrySessionOverlap: compact.entrySessionOverlap,
         entryOffHours: compact.entryOffHours,


         exitTs: compact.exitTs,
         exitHourUtc: compact.exitHourUtc,
         exitDayOfWeekUtc: compact.exitDayOfWeekUtc,
         exitDayType: compact.exitDayType,
         exitIsWeekend: compact.exitIsWeekend,
         exitSessionTags: compact.exitSessionTags,
         exitSessionBucket: compact.exitSessionBucket,
         exitSessionOverlap: compact.exitSessionOverlap,
         exitOffHours: compact.exitOffHours,


         directSL: compact.directSL,
         currentFit: compact.currentFit,
         currentFitScore: compact.currentFitScore,
         currentFitConfidence: compact.currentFitConfidence,
         compactEmergencyRecord: true
    };
}


function compactObservationRecord(row = {}) {
    const entryTemporal = entryTemporalFields(row);
    const symbol =
         normalizeBaseSymbol(
           row.symbol || row.baseSymbol || row.contractSymbol
         ) || 'UNKNOWN';


    return {
         observationId: compactText(row.observationId, 160),
         observationDedupeKey: compactText(row.observationDedupeKey, 240),
         observationRecorded: row.observationRecorded !== false,
         observationDuplicate: Boolean(row.observationDuplicate),
         observedAt: safeNumber(row.observedAt, now()),
         createdAt: safeNumber(row.createdAt, now()),


         ...entryTemporal,


         snapshotId: compactText(row.snapshotId || row.scanId || row.batchId, 160),
         symbol,
         baseSymbol: symbol,
         contractSymbol: compactText(
           row.contractSymbol || (symbol !== 'UNKNOWN' ? `${symbol}USDT` : null),
           80
),


trueMicroFamilyId: row.trueMicroFamilyId,
childTrueMicroFamilyId: row.trueMicroFamilyId,
microFamilyId: row.trueMicroFamilyId,
analyzeMicroFamilyId: row.trueMicroFamilyId,
learningMicroFamilyId: row.trueMicroFamilyId,
microMicroFamilyId: row.trueMicroFamilyId,


parentTrueMicroFamilyId: row.parentTrueMicroFamilyId,
parentMicroFamilyId: row.parentTrueMicroFamilyId,
parentMacroFamilyId: row.parentTrueMicroFamilyId,
coarseMicroFamilyId: row.parentTrueMicroFamilyId,


setupType: compactText(row.setupType || row.setup, 60),
regimeBucket: compactText(row.regimeBucket, 60),
confirmationProfile: compactText(row.confirmationProfile, 80),


side: TARGET_DASHBOARD_SIDE,
dashboardSide: TARGET_DASHBOARD_SIDE,
tradeSide: TARGET_TRADE_SIDE,
positionSide: TARGET_TRADE_SIDE,
direction: TARGET_TRADE_SIDE,
scannerSide: TARGET_SCANNER_SIDE,
actualScannerSide: TARGET_SCANNER_SIDE,


longOnly: true,
shortDisabled: true,
virtualOnly: true,
virtualLearning: true,


entry: safeNumber(row.entry ?? row.entryPrice, 0),
entryPrice: safeNumber(row.entryPrice ?? row.entry, 0),
sl: safeNumber(row.sl ?? row.initialSl, 0),
initialSl: safeNumber(row.initialSl ?? row.sl, 0),
tp: safeNumber(row.tp, 0),
rr: safeNumber(row.rr, 0),


scannerScore: safeNumber(row.scannerScore, 0),
moveScore: safeNumber(row.moveScore, 0),
confluence: safeNumber(row.confluence, 0),
sniperScore: safeNumber(row.sniperScore, 0),
spreadPct: safeNumber(row.spreadPct, 0),
depthMinUsd1p: safeNumber(row.depthMinUsd1p, 0),
fundingRate: safeNumber(row.fundingRate, 0),


change1h: safeNumber(row.change1h, 0),
         change24h: safeNumber(row.change24h, 0),
         volume24h: safeNumber(
              row.volume24h ?? row.quoteVolume24h ?? row.quoteVolume,
              0
         ),
         volumeExpansion: safeNumber(row.volumeExpansion, 0),
         atrPct: safeNumber(row.atrPct, 0),


         scannerReason: compactText(row.scannerReason, 120),
         sideConfidence: compactText(row.sideConfidence, 60),
         btcState: compactText(row.btcState, 60),
         regime: compactText(row.regime, 60),
         currentFit: compactText(row.currentFit || row.entryCurrentFit, 80),
         currentFitScore: safeNumber(row.currentFitScore, 0),
         currentFitConfidence: safeNumber(
              row.currentFitConfidence ?? row.entryCurrentFitConfidence,
              0
         ),


         definitionParts: compactStringList(
              row.definitionParts || row.microDefinitionParts || [],
              MAX_COMPACT_DEFINITION_PARTS,
              180
         ),


         currentMarketWeather: compactMarketWeather(
              row.currentMarketWeather || row.entryMarketWeather
         ),


         trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
         parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
         learningGranularity: LEARNING_GRANULARITY,
         parentLearningGranularity: PARENT_LEARNING_GRANULARITY,


         fullScannerPayloadExcluded: true,
         marketWeatherRowsExcluded: true,
         marketUniverseExcluded: true,
         candleDataExcluded: true,
         orderBookExcluded: true,
         executionFingerprintPartsExcluded: true
    };
}


function compactStatsRecord(value = {}) {
    return stripHeavyValue(asObject(value));
}
function compactStatsMap(value = {}) {
    const input = asObject(value);
    const out = {};


    for (const [key, row] of Object.entries(input)) {
         out[key] = compactStatsRecord(row);
    }


    return out;
}


function isStatsRecord(value = {}) {
    const row = asObject(value);


    return Boolean(
         row.microFamilyId ||
         row.trueMicroFamilyId ||
         row.parentTrueMicroFamilyId ||
         row.familyId ||
         Object.prototype.hasOwnProperty.call(row, 'seen') ||
         Object.prototype.hasOwnProperty.call(row, 'completed') ||
         Object.prototype.hasOwnProperty.call(row, 'wins') ||
         Object.prototype.hasOwnProperty.call(row, 'totalR')
    );
}


function compactAggregateValue(value) {
    if (Array.isArray(value)) return value;
    if (isStatsRecord(value)) return compactStatsRecord(value);
    return compactStatsMap(value);
}


function compactOutcomeHistory(
    rows = [],
    {
         maxItems = recentOutcomeLimit(),
         maxBytes = maxMicroOutcomeHistoryBytes()
    } = {}
) {
    const sourceRows = Array.isArray(rows)
         ? rows.filter(isCurrentMeasurementOutcome)
         : [];


    const deduped = new Map();


    for (const row of sourceRows) {
         const compact = compactOutcomeRecord(row);
         const dedupeKey =
           compact.outcomeId ||
           compact.outcomeDedupeKey ||
           stableHash(
                {
                     symbol: compact.symbol,
                     trueMicroFamilyId: compact.trueMicroFamilyId,
                     closedAt: compact.closedAt,
                     exitReason: compact.exitReason,
                     exitPrice: compact.exitPrice,
                     netR: compact.netR
                },
                24
           );


         if (deduped.has(dedupeKey)) deduped.delete(dedupeKey);
         deduped.set(dedupeKey, compact);
    }


    let compactRows = [...deduped.values()].slice(
         -Math.max(1, Math.floor(maxItems))
    );


    while (
         compactRows.length > 1 &&
         jsonByteLength(compactRows) > maxBytes
    ) {
         compactRows.shift();
    }


    if (
         compactRows.length === 1 &&
         jsonByteLength(compactRows) > maxBytes
    ) {
         compactRows = [minimalOutcomeRecord(compactRows[0])];
    }


    return compactRows;
}


function isMaxRequestSizeError(error) {
    const text = String(error?.message || error || '').toUpperCase();


    return (
         text.includes('MAX REQUEST SIZE EXCEEDED') ||
         text.includes('10485760')
    );
}


async function saveMicroOutcomeHistory(redis, key, rows = []) {
    assertAnalyzeWrite(key);


    let history = compactOutcomeHistory(rows);
    let bytes = jsonByteLength(history);


    try {
         await setJson(redis, key, history);


         return {
              history,
              bytes,
              fallbackUsed: false
         };
    } catch (error) {
         if (!isMaxRequestSizeError(error)) throw error;


         history = compactOutcomeHistory(history, {
              maxItems: Math.min(100, recentOutcomeLimit()),
              maxBytes: EMERGENCY_MAX_MICRO_OUTCOME_HISTORY_BYTES
         });


         bytes = jsonByteLength(history);
         await setJson(redis, key, history);


         return {
              history,
              bytes,
              fallbackUsed: true
         };
    }
}


function isExplicitNonLong(row = {}) {
    const candidates = [
         row.tradeSide,
         row.positionSide,
         row.direction,
         row.side,
         row.targetTradeSide
    ].filter(
         (value) => value !== undefined && value !== null && value !== ''
    );


    return candidates.some((value) => {
      const side = sideToTradeSide(value);
      return side && side !== TARGET_TRADE_SIDE;
    });
}


function longIdentityFlags() {
    return {
      targetTradeSide: TARGET_TRADE_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      positionSide: TARGET_TRADE_SIDE,
      direction: TARGET_TRADE_SIDE,
      side: TARGET_DASHBOARD_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      scannerSide: TARGET_SCANNER_SIDE,
      actualScannerSide: TARGET_SCANNER_SIDE,


      longOnly: true,
      shortDisabled: true,
      shortOnly: false,
      longDisabled: false,


      virtualOnly: true,
      virtualLearning: true,
      realOrdersDisabled: true,
      exchangeOrdersDisabled: true,
      bitgetOrdersDisabled: true,


      trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
      childTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
      exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
      parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
      microMicroFamilySchema: MICRO_MICRO_SCHEMA,


      learningGranularity: LEARNING_GRANULARITY,
      parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
      selectionGranularity: 'EXACT_75_CHILD',
      userFacingSelectionLayer: 'MICRO_MICRO_FAMILY',


      redisNamespace: LONG_NAMESPACE,
      redisKeyPrefix: LONG_KEY_PREFIX,
      persistentLearningKey: PERSISTENT_LEARNING_KEY,
      redisKeysSeparatedFromShortRoot: true,
      shortRootTouched: false,


      completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
      scoringRSource: 'netR',
      winsLossesFlatsSource: 'netR',
         winrateDefinition: 'netR > 0',
         avgRSource: 'netR',
         totalRSource: 'netR',
         avgCostRShown: true,


         riskGeometryRule: 'LONG: sl < entry < tp',
         tpHitRule: 'LONG: price >= tp',
         slHitRule: 'LONG: price <= sl',
         grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
         currentRFormula: '(currentPrice - entry) / (entry - initialSl)',


         currentFitSoftOnly: true,
         currentFitBlocksLearning: false,
         currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
         currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',


         ...temporalRuntimeConfig(),
         temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
         temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
         weekendPolicyVersion: WEEKEND_POLICY_VERSION,
         sessionPolicyVersion: SESSION_POLICY_VERSION,
         taxonomyVersion: TEMPORAL_TAXONOMY_VERSION,
         costModelVersion: TEMPORAL_COST_MODEL_VERSION,
         weekendLearningAllowed: true,
         weekendVirtualEntryAllowed: true,
         weekendDiscordEntryAllowed: temporalRuntimeConfig().temporalPolicyMode !== 'ENFORCE',
         weekendExitMonitoringAllowed: true,
         weekendOutcomeRecordingAllowed: true,
         sessionLearningAllowed: true,
         sessionVirtualEntryAllowed: true,
         sessionDiscordEntryAllowed: true,
         familyIdentityIncludesTemporalBucket: false
    };
}


function normalizeAnalyzeIdentity(input = {}) {
    if (isExplicitNonLong(input)) return null;


    const attached = attachMicroFamilies({
         ...input,
         ...longIdentityFlags()
    });


    const candidateId = upper(
         attached?.trueMicroFamilyId ||
           attached?.childTrueMicroFamilyId ||
           attached?.microFamilyId ||
           input.trueMicroFamilyId ||
           input.childTrueMicroFamilyId ||
       input.microFamilyId
);


if (!candidateId || !validLearningId(candidateId)) return null;


if (!isSelectableLongTrueMicroFamilyId(candidateId)) return null;


const parsed = parseLongTaxonomyMicroId(candidateId);


if (!parsed || !parsed.isChild) return null;


const parentId = upper(parsed.parentTrueMicroFamilyId);
const childId = upper(parsed.childTrueMicroFamilyId);


if (!parentId || !childId) return null;


return {
     ...input,
     ...attached,
     ...longIdentityFlags(),


     setup: parsed.setup,
     setupType: parsed.setup,
     regimeBucket: parsed.regime,
     confirmationProfile: parsed.confirmationProfile,


     parentTrueMicroFamilyId: parentId,
     parentMicroFamilyId: parentId,
     parentMacroFamilyId: parentId,
     macroFamilyId: parentId,
     coarseMicroFamilyId: parentId,


     childTrueMicroFamilyId: childId,
     microFamilyId: childId,
     trueMicroFamilyId: childId,
     analyzeMicroFamilyId: childId,
     learningMicroFamilyId: childId,
     microMicroFamilyId: childId,
     exactMicroMicroFamilyId: childId,


     selectable: true,
     selectableChild: true,
     exactTrueMicroOnly: true,
     exactTrueMicroFamilyRequired: true,


     ...entryTemporalFields({
       ...input,
              ...attached
         })
    };
}


function observationIdentity(row = {}) {
    const snapshotId = String(
         row.snapshotId || row.scanId || row.batchId || 'NO_SNAPSHOT'
    ).trim();


    const symbol =
         normalizeBaseSymbol(
              row.symbol || row.baseSymbol || row.contractSymbol
         ) || 'UNKNOWN';


    const microId = upper(row.trueMicroFamilyId || row.microFamilyId);
    const entry = safeNumber(row.entry ?? row.entryPrice, 0);
    const raw = `${snapshotId}|${symbol}|${microId}|${entry || 'NO_ENTRY'}`;


    return {
         snapshotId,
         symbol,
         microId,
         key: upper(row.observationDedupeKey || raw),
         redisKey: ANALYZE_KEYS.obsLast(snapshotId, symbol, microId)
    };
}


function outcomeIdentity(row = {}) {
    const microId = upper(
        row.trueMicroFamilyId ||
        row.microFamilyId ||
        row.childTrueMicroFamilyId
    );
    const canonicalPositionId = String(
        row.canonicalPositionId ||
        ''
    ).trim();
    const canonicalOutcomeId = String(
        row.canonicalOutcomeId ||
        canonicalPositionId
    ).trim();
    if (!microId || !canonicalPositionId || !canonicalOutcomeId) return null;
    const symbol = normalizeBaseSymbol(
        row.symbol || row.baseSymbol || row.contractSymbol
    ) || 'UNKNOWN';
    const measurementVersion = rowMeasurementFixVersion(row) || 'UNVERSIONED';
    const versionToken = stableHash(measurementVersion, 12);
    return {
        id: canonicalOutcomeId,
        canonicalPositionId,
        canonicalOutcomeId,
        measurementVersion,
        key: `${measurementVersion}|${canonicalPositionId}|${microId}`,
        redisKey: ANALYZE_KEYS.obsLast(
            `OUTCOME_${versionToken}_${canonicalPositionId}`,
            symbol,
            microId
        )
    };
}

function createStatsFor(row = {}) {
    return createMicroStats({
         microFamilyId: row.trueMicroFamilyId,
         familyId: row.parentTrueMicroFamilyId,
         side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      definitionParts: compactStringList(
          row.definitionParts || row.microDefinitionParts || [],
          MAX_COMPACT_DEFINITION_PARTS,
          180
      )
    });
}


function createParentStatsFor(row = {}) {
    const parentId = row.parentTrueMicroFamilyId;
    const timestamp = now();


    return {
      parentTrueMicroFamilyId: parentId,
      microFamilyId: parentId,
      trueMicroFamilyId: parentId,
      familyId: parentId,


      schema: PARENT_TRUE_MICRO_SCHEMA,
      trueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
      parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
      learningGranularity: PARENT_LEARNING_GRANULARITY,


      setupType: row.setupType || null,
      regimeBucket: row.regimeBucket || null,


      seen: 0,
      observations: 0,
      completed: 0,
      wins: 0,
      losses: 0,
      flats: 0,
      totalR: 0,
      netTotalR: 0,
      totalCostR: 0,
      grossTotalR: 0,
      avgR: 0,
      avgCostR: 0,
      winrate: 0,


      recentOutcomes: [],
      children: [],
      observationDedupeKeys: [],


      ...currentMeasurementPolicyFields(),
         measurementVersionAcceptedOutcomeCount: 0,
         measurementVersionRejectedOutcomeCount: 0,
         outcomeMeasurementMigrationApplied: false,
         legacyExcludedCompleted: 0,
         legacyExcludedTotalR: 0,
         legacyExcludedTotalCostR: 0,


         createdAt: timestamp,
         updatedAt: timestamp,


         ...longIdentityFlags(),


         selectable: false,
         parentSelectable: false,
         childSelectable: true
    };
}



function migrateParentStatsToCurrentMeasurement(stats = {}, row = {}) {
    const out = {
         ...createParentStatsFor(row),
         ...asObject(stats)
    };


    ensureTemporalStats(out);


    const storedVersion = rowMeasurementFixVersion(out);
    const completed = Math.max(0, safeNumber(out.completed, 0));
    const acceptedOutcomeCount = Math.max(
         0,
         safeNumber(out.measurementVersionAcceptedOutcomeCount, 0)
    );


    const recentOutcomes = Array.isArray(out.recentOutcomes)
         ? out.recentOutcomes
         : [];


    const nonCurrentRecentOutcomeCount = recentOutcomes
         .filter((outcome) => !isCurrentMeasurementOutcome(outcome))
         .length;


    const aggregateIntegrityValid =
         storedVersion === MEASUREMENT_FIX_VERSION &&
         (completed <= 0 || acceptedOutcomeCount >= completed) &&
         nonCurrentRecentOutcomeCount === 0;
if (aggregateIntegrityValid) {
     out.recentOutcomes = recentOutcomes
          .filter(isCurrentMeasurementOutcome)
          .slice(-recentOutcomeLimit());


     out.currentMeasurementAggregateIntegrityValid = true;
     out.currentMeasurementAggregateIntegrityCheckedAt =
          out.currentMeasurementAggregateIntegrityCheckedAt || now();
     out.currentMeasurementAggregateCompleted = completed;
     out.currentMeasurementAcceptedOutcomeCount = acceptedOutcomeCount;
     out.currentMeasurementNonCurrentRecentOutcomeCount = 0;


     return {
          ...out,
          ...currentMeasurementPolicyFields(out)
     };
}


const legacyCompleted = completed;
const legacyTotalR = safeNumber(
     out.totalR ?? out.netTotalR,
     0
);
const legacyTotalCostR = safeNumber(
     out.totalCostR,
     0
);


out.previousMeasurementFixVersion =
     storedVersion === MEASUREMENT_FIX_VERSION
          ? 'CURRENT_VERSION_WITH_UNVERIFIED_AGGREGATES'
          : storedVersion || 'UNVERSIONED';


out.legacyExcludedCompleted = legacyCompleted;
out.legacyExcludedTotalR = legacyTotalR;
out.legacyExcludedTotalCostR = legacyTotalCostR;
out.legacyExcludedAcceptedOutcomeCount = acceptedOutcomeCount;
out.legacyExcludedRecentOutcomeCount = recentOutcomes.length;
out.legacyExcludedNonCurrentRecentOutcomeCount =
     nonCurrentRecentOutcomeCount;


out.completed = 0;
out.wins = 0;
out.losses = 0;
out.flats = 0;
out.totalR = 0;
out.netTotalR = 0;
    out.totalCostR = 0;
    out.grossTotalR = 0;
    out.avgR = 0;
    out.avgCostR = 0;
    out.winrate = 0;
    out.recentOutcomes = [];
    resetTemporalOutcomeMetrics(out);


    out.measurementVersionAcceptedOutcomeCount = 0;
    out.lastAcceptedOutcomeMeasurementVersion = null;
    out.lastAcceptedOutcomeMeasurementAt = null;


    out.outcomeMeasurementMigrationApplied = true;
    out.outcomeMeasurementMigrationAt =
         out.outcomeMeasurementMigrationAt ||
         now();


    out.outcomeMeasurementMigrationReason =
         storedVersion === MEASUREMENT_FIX_VERSION
           ? 'CURRENT_VERSION_PARENT_AGGREGATE_INTEGRITY_MISMATCH_EXCLUDED'
           : 'LEGACY_TRIGGER_OVERSHOOT_PARENT_OUTCOMES_EXCLUDED';


    out.currentMeasurementAggregateIntegrityValid = true;
    out.currentMeasurementAggregateIntegrityMismatchDetected =
         storedVersion === MEASUREMENT_FIX_VERSION;
    out.currentMeasurementAggregateIntegrityCheckedAt =
           out.currentMeasurementAggregateIntegrityCheckedAt || now();
    out.currentMeasurementAggregateCompleted = 0;
    out.currentMeasurementAcceptedOutcomeCount = 0;
    out.currentMeasurementNonCurrentRecentOutcomeCount = 0;


    return {
         ...out,
         ...currentMeasurementPolicyFields(out)
    };
}


function updateParentObservation(stats = {}, row = {}) {
    const out = migrateParentStatsToCurrentMeasurement(
         stats,
         row
    );


    const childId = row.trueMicroFamilyId;
    const obsKey = String(row.observationDedupeKey || '');
    const dedupeKeys = Array.isArray(out.observationDedupeKeys)
         ? out.observationDedupeKeys
         : [];


    if (obsKey && dedupeKeys.includes(obsKey)) return out;


    out.seen = safeNumber(out.seen, 0) + 1;
    out.observations = safeNumber(out.observations, 0) + 1;
    recordTemporalObservation(out, row);
    out.children = uniqueStrings([out.children || [], childId]).slice(-75);
    out.observationDedupeKeys = obsKey
         ? [...dedupeKeys, obsKey].slice(-1000)
         : dedupeKeys.slice(-1000);
    out.updatedAt = now();


    return compactStatsRecord(out);
}


function updateParentOutcome(stats = {}, row = {}) {
    const out = migrateParentStatsToCurrentMeasurement(
         stats,
         row
    );


    if (!isCurrentMeasurementOutcome(row)) {
         out.measurementVersionRejectedOutcomeCount =
           safeNumber(
               out.measurementVersionRejectedOutcomeCount,
               0
           ) + 1;


         out.lastRejectedOutcomeMeasurementVersion =
           rowMeasurementFixVersion(row) ||
           'UNVERSIONED';


         out.lastRejectedOutcomeMeasurementAt = now();
         out.updatedAt = now();


         return compactStatsRecord(out);
    }


    out.measurementVersionAcceptedOutcomeCount =
         safeNumber(
           out.measurementVersionAcceptedOutcomeCount,
           0
         ) + 1;


    out.lastAcceptedOutcomeMeasurementVersion =
         MEASUREMENT_FIX_VERSION;
    out.lastAcceptedOutcomeMeasurementAt = now();


    const netR = safeNumber(row.netR ?? row.exitR ?? row.netPnlR, 0);
    const grossR = safeNumber(row.grossR ?? row.rawR, netR);
    const costR = safeNumber(row.costR, Math.max(0, grossR - netR));


    recordTemporalOutcome(out, row, {
      netR,
      grossR,
      costR,
      directSL: Boolean(row.directSL ?? row.directToSL)
    });


    out.completed = safeNumber(out.completed, 0) + 1;
    out.wins = safeNumber(out.wins, 0) + (netR > 0 ? 1 : 0);
    out.losses = safeNumber(out.losses, 0) + (netR < 0 ? 1 : 0);
    out.flats = safeNumber(out.flats, 0) + (netR === 0 ? 1 : 0);
    out.totalR = safeNumber(out.totalR, 0) + netR;
    out.netTotalR = out.totalR;
    out.grossTotalR = safeNumber(out.grossTotalR, 0) + grossR;
    out.totalCostR = safeNumber(out.totalCostR, 0) + costR;
    out.avgR = out.completed > 0 ? out.totalR / out.completed : 0;
    out.avgCostR = out.completed > 0 ? out.totalCostR / out.completed : 0;
    out.winrate = out.completed > 0 ? out.wins / out.completed : 0;
    out.children = uniqueStrings([
      out.children || [],
      row.trueMicroFamilyId
    ]).slice(-75);


    out.recentOutcomes = [
      ...(Array.isArray(out.recentOutcomes) ? out.recentOutcomes : []),
      minimalOutcomeRecord(row)
    ].slice(-recentOutcomeLimit());


    out.updatedAt = now();


    return compactStatsRecord(out);
}


async function saveAggregate(redis, key, value) {
    assertAnalyzeWrite(key);


    const compactValue = compactAggregateValue(value);


    await setJson(redis, key, compactValue);
    return compactValue;
}


function isWeekMicrosLargeDocumentManifest(value) {
    return Boolean(
         value &&
         typeof value === 'object' &&
         value.weekMicrosLargeDocumentStorageSchema ===
           WEEK_MICROS_LARGE_DOCUMENT_STORAGE_SCHEMA &&
         value.encoding === WEEK_MICROS_LARGE_DOCUMENT_ENCODING &&
         Array.isArray(value.chunkKeys)
    );
}


function weekMicrosLargeDocumentChunkKey(key, documentId, index) {
    return `${key}:PAYLOAD:${documentId}:CHUNK:${String(index).padStart(3, '0')}`;
}


async function deleteWeekMicrosLargeDocumentChunks(redis, manifest) {
    if (!isWeekMicrosLargeDocumentManifest(manifest)) return;


    for (const chunkKey of manifest.chunkKeys) {
         try {
             assertAnalyzeWrite(chunkKey);
             await redis.del(chunkKey);
         } catch {
             // Best effort only. The authoritative manifest/payload is already safe.
         }
    }
}


async function getWeekMicrosDocument(redis, key, fallback = {}) {
    assertAnalyzeWrite(key);


    const stored = await getJson(redis, key, fallback);


    // Backward compatibility: existing single-key WEEK_MICROS JSON is returned unchanged.
    if (!isWeekMicrosLargeDocumentManifest(stored)) return stored;


    if (stored.chunkKeys.length !== Number(stored.chunkCount)) {
         throw new Error('WEEK_MICROS_CHUNK_MANIFEST_INVALID');
    }


    if (
         stored.chunkCount < 1 ||
         stored.chunkCount > WEEK_MICROS_LARGE_DOCUMENT_MAX_CHUNKS
    ) {
         throw new Error('WEEK_MICROS_CHUNK_COUNT_INVALID');
    }


    const chunks = [];


    for (const chunkKey of stored.chunkKeys) {
         assertAnalyzeWrite(chunkKey);
         const chunk = await redis.get(chunkKey);


         if (typeof chunk !== 'string' || chunk.length === 0) {
             throw new Error(`WEEK_MICROS_CHUNK_MISSING:${chunkKey}`);
         }


         chunks.push(chunk);
    }


    const base64 = chunks.join('');


    if (
         Number.isFinite(Number(stored.base64Chars)) &&
         base64.length !== Number(stored.base64Chars)
    ) {
         throw new Error('WEEK_MICROS_BASE64_SIZE_MISMATCH');
    }


    const compressed = Buffer.from(base64, 'base64');


    if (
         Number.isFinite(Number(stored.compressedBytes)) &&
         compressed.length !== Number(stored.compressedBytes)
    ) {
         throw new Error('WEEK_MICROS_COMPRESSED_SIZE_MISMATCH');
    }


    const json = gunzipSync(compressed).toString('utf8');


    if (
         Number.isFinite(Number(stored.uncompressedBytes)) &&
         Buffer.byteLength(json) !== Number(stored.uncompressedBytes)
    ) {
         throw new Error('WEEK_MICROS_UNCOMPRESSED_SIZE_MISMATCH');
    }


    const checksum = createHash('sha256')
         .update(json)
         .digest('hex');


    if (stored.jsonSha256 && checksum !== stored.jsonSha256) {
         throw new Error('WEEK_MICROS_CHECKSUM_MISMATCH');
    }


    return JSON.parse(json);
}


async function setWeekMicrosDocument(redis, key, value) {
    assertAnalyzeWrite(key);


    const compactValue = compactAggregateValue(value);
    const json = JSON.stringify(compactValue);
    const uncompressedBytes = Buffer.byteLength(json);
    const previous = await getJson(redis, key, null).catch(() => null);


    // Keep small payloads on the original single-key contract.
    if (uncompressedBytes <= WEEK_MICROS_LARGE_DOCUMENT_THRESHOLD_BYTES) {
         await setJson(redis, key, compactValue);
         await deleteWeekMicrosLargeDocumentChunks(redis, previous);
         return compactValue;
    }


    const compressed = gzipSync(Buffer.from(json, 'utf8'), { level: 6 });
    const base64 = compressed.toString('base64');
    const chunks = [];


    for (
         let offset = 0;
         offset < base64.length;
         offset += WEEK_MICROS_LARGE_DOCUMENT_CHUNK_CHAR_LIMIT
    ) {
         chunks.push(
              base64.slice(
                   offset,
                   offset + WEEK_MICROS_LARGE_DOCUMENT_CHUNK_CHAR_LIMIT
              )
         );
    }


    if (
         chunks.length < 1 ||
         chunks.length > WEEK_MICROS_LARGE_DOCUMENT_MAX_CHUNKS
    ) {
         throw new Error('WEEK_MICROS_CHUNK_COUNT_EXCEEDED');
    }


    const documentId = `${Date.now()}_${randomUUID()}`;
    const chunkKeys = chunks.map((_, index) =>
         weekMicrosLargeDocumentChunkKey(key, documentId, index)
    );


    try {
         // Write new immutable chunks first. The old base key remains authoritative
         // until the manifest swap below succeeds.
         for (let index = 0; index < chunks.length; index += 1) {
             assertAnalyzeWrite(chunkKeys[index]);
             await redis.set(chunkKeys[index], chunks[index]);
         }


         const manifest = {
             weekMicrosLargeDocumentStorageSchema:
               WEEK_MICROS_LARGE_DOCUMENT_STORAGE_SCHEMA,
             encoding: WEEK_MICROS_LARGE_DOCUMENT_ENCODING,
             documentId,
             chunkCount: chunks.length,
             chunkKeys,
             uncompressedBytes,
             compressedBytes: compressed.length,
             base64Chars: base64.length,
             jsonSha256: createHash('sha256')
                  .update(json)
                  .digest('hex'),
             writtenAt: Date.now(),
             familyCount: Object.keys(asObject(compactValue)).length,
             targetTradeSide: TARGET_TRADE_SIDE,
             redisNamespace: 'LONG',
             persistentLearningKey: PERSISTENT_LEARNING_KEY
         };


         // Atomic pointer-style swap: only now replace the original oversized key.
         await setJson(redis, key, manifest);


         // Old chunk generation is deleted only after the new manifest is safe.
         await deleteWeekMicrosLargeDocumentChunks(redis, previous);


         return compactValue;
    } catch (error) {
         // Failed new generation must not leave orphan chunks. If this was a
         // migration from legacy single-key JSON, that old key is still intact.
         for (const chunkKey of chunkKeys) {
             try {
                  assertAnalyzeWrite(chunkKey);
                  await redis.del(chunkKey);
             } catch {
                  // Best effort only.
             }
         }


         throw error;
    }
}



function normalizeStoredChildStatsMap(value = {}) {
    const input = asObject(value);
    const out = {};


    for (const [key, rawRow] of Object.entries(input)) {
      const row = asObject(rawRow);


      const candidateId = upper(
           row.trueMicroFamilyId ||
             row.childTrueMicroFamilyId ||
             row.microFamilyId ||
             row.analyzeMicroFamilyId ||
             row.learningMicroFamilyId ||
             key
      );


      if (
           candidateId &&
           validLearningId(candidateId) &&
           isSelectableLongTrueMicroFamilyId(candidateId)
      ) {
           const parsed = parseLongTaxonomyMicroId(candidateId);


           const normalized = {
             ...row,
             ...longIdentityFlags(),


             trueMicroFamilyId: candidateId,
             childTrueMicroFamilyId: candidateId,
             microFamilyId: candidateId,
             analyzeMicroFamilyId: candidateId,
             learningMicroFamilyId: candidateId,


             parentTrueMicroFamilyId:
               parsed.parentTrueMicroFamilyId,


             parentMicroFamilyId:
               parsed.parentTrueMicroFamilyId,


             parentMacroFamilyId:
               parsed.parentTrueMicroFamilyId,


             macroFamilyId:
               parsed.parentTrueMicroFamilyId,
                  coarseMicroFamilyId:
                    parsed.parentTrueMicroFamilyId
             };


             out[candidateId] = compactStatsRecord(
                  refreshStats(normalized)
             );


             continue;
        }


        out[key] = compactStatsRecord(row);
    }


    return out;
}


function normalizeStoredParentStatsMap(value = {}) {
    const input = asObject(value);
    const out = {};


    for (const [key, rawRow] of Object.entries(input)) {
        const row = asObject(rawRow);


        const parentId = upper(
             row.parentTrueMicroFamilyId ||
                  row.trueMicroFamilyId ||
                  row.microFamilyId ||
                  key
        );


        const parsed = parseLongTaxonomyMicroId(parentId);


        if (parsed?.isParent) {
             out[parentId] = compactStatsRecord(
                  migrateParentStatsToCurrentMeasurement(
                    {
                         ...row,
                         parentTrueMicroFamilyId: parentId,
                         trueMicroFamilyId: parentId,
                         microFamilyId: parentId
                    },
                    {
                         ...row,
                         parentTrueMicroFamilyId: parentId,
                         setupType: parsed.setup,
                           regimeBucket: parsed.regime
                       }
                   )
              );


              continue;
         }


         out[key] = compactStatsRecord(row);
    }


    return out;
}


async function readWeekMaps(redis, weekKeys = []) {
    const entries = await Promise.all(
         weekKeys.map(async (weekKey) => {
              const microsKey = ANALYZE_KEYS.weekMicros(weekKey);
              const parentsKey = ANALYZE_KEYS.weekParents(weekKey);


              const [micros, parents] = await Promise.all([
                   getWeekMicrosDocument(redis, microsKey, {}),
                   getJson(redis, parentsKey, {}).catch(() => ({}))
              ]);


              return [
                   weekKey,
                   {
                       microsKey,
                       parentsKey,
                       micros: normalizeStoredChildStatsMap(micros),
                       parents: normalizeStoredParentStatsMap(parents)
                   }
              ];
         })
    );


    return new Map(entries);
}


async function saveWeekMaps(redis, weekMaps) {
    const writes = [];


    for (const data of weekMaps.values()) {
         writes.push(setWeekMicrosDocument(redis, data.microsKey, data.micros));
         writes.push(saveAggregate(redis, data.parentsKey, data.parents));
    }
    await Promise.all(writes);
}


async function rollbackDedupeKeys(redis, keys = []) {
    await mapLimit(
         uniqueStrings(keys),
         dedupeConcurrency(),
         async (key) => {
             await delJson(redis, key).catch(() => null);
             return true;
         }
    );
}


export async function getWeekMicros(
    weekKey = PERSISTENT_LEARNING_KEY
) {
    const redis = getDurableRedis();
    const key = ANALYZE_KEYS.weekMicros(resolveWeekKey(weekKey));
    const value = await getWeekMicrosDocument(redis, key, {});
    return normalizeStoredChildStatsMap(value);
}


export async function saveWeekMicros(
    weekKey = PERSISTENT_LEARNING_KEY,
    micros = {}
) {
    const redis = getDurableRedis();
    const key = ANALYZE_KEYS.weekMicros(resolveWeekKey(weekKey));


    return setWeekMicrosDocument(
         redis,
         key,
         normalizeStoredChildStatsMap(micros)
    );
}


export async function getWeekParents(
    weekKey = PERSISTENT_LEARNING_KEY
) {
    const redis = getDurableRedis();
    const key = ANALYZE_KEYS.weekParents(resolveWeekKey(weekKey));
    const value = await getJson(redis, key, {});
    return normalizeStoredParentStatsMap(value);
}
export async function saveWeekParents(
    weekKey = PERSISTENT_LEARNING_KEY,
    parents = {}
) {
    const redis = getDurableRedis();
    const key = ANALYZE_KEYS.weekParents(resolveWeekKey(weekKey));


    return saveAggregate(
         redis,
         key,
         normalizeStoredParentStatsMap(parents)
    );
}


async function recordObservationsBatchInternal(candidates = [], options = {}) {
    const sourceRows = Array.isArray(candidates) ? candidates : [];
    const redis = getDurableRedis();


    const prepared = sourceRows.map((candidate, index) => {
         const row = normalizeAnalyzeIdentity(candidate);


         if (!row) {
              return {
                   index,
                   valid: false,
                   candidate,
                   reason: 'INVALID_OR_NON_LONG_EXACT_75_CHILD_ID'
              };
         }


         const identity = observationIdentity(row);


         return {
              index,
              valid: true,
              candidate,
              row,
              identity
         };
    });


    const uniqueByRedisKey = new Map();


    for (const item of prepared) {
         if (!item.valid) continue;


         if (!uniqueByRedisKey.has(item.identity.redisKey)) {
         uniqueByRedisKey.set(item.identity.redisKey, item);
     }
}


const uniqueItems = [...uniqueByRedisKey.values()];


const dedupeResults = await mapLimit(
     uniqueItems,
     dedupeConcurrency(),
     async (item) => {
         assertAnalyzeWrite(item.identity.redisKey);


         try {
             const insertResult = await setNxJson(
                  redis,
                  item.identity.redisKey,
                  {
                       observationDedupeKey: item.identity.key,
                       snapshotId: item.identity.snapshotId,
                       symbol: item.identity.symbol,
                       trueMicroFamilyId: item.identity.microId,
                       createdAt: now()
                  },
                  {
                       ex: observationTtlSec()
                  }
             );


             return {
                  redisKey: item.identity.redisKey,
                  inserted: nxInsertSucceeded(insertResult),
                  error: null
             };
         } catch (error) {
             return {
                  redisKey: item.identity.redisKey,
                  inserted: false,
                  error: error?.message || String(error)
             };
         }
     }
);


const dedupeByKey = new Map(
     dedupeResults.map((row) => [row.redisKey, row])
);
const observedAt = now();
const insertedItems = [];
const insertedRedisKeys = [];


for (const item of uniqueItems) {
     const status = dedupeByKey.get(item.identity.redisKey);


     if (!status?.inserted) continue;


     const enriched = {
          ...item.row,
          observationId: randomId('obs'),
          observationDedupeKey: item.identity.key,
          observationRecorded: true,
          observationDuplicate: false,
          observationAlwaysCounted: false,
          observedAt,
          createdAt: item.row.createdAt || observedAt
     };


     insertedItems.push({
          ...item,
          enriched,
          compact: compactObservationRecord(enriched)
     });


     insertedRedisKeys.push(item.identity.redisKey);
}


const requestedWeekKey = resolveWeekKey(
     options.weekKey || options.persistentLearningKey
);


let primaryMicros = {};
let primaryParents = {};
let mirrorWriteErrors = [];


if (insertedItems.length > 0) {
     const allWeekKeys = uniqueStrings(
          insertedItems.flatMap((item) => [
               requestedWeekKey,
               PERSISTENT_LEARNING_KEY,
               getIsoWeekKey(item.compact.observedAt)
          ])
     );


     try {
const weekMaps = await readWeekMaps(redis, allWeekKeys);


for (const item of insertedItems) {
     const row = item.compact;
     const rowWeekKeys = uniqueStrings([
         requestedWeekKey,
         PERSISTENT_LEARNING_KEY,
         getIsoWeekKey(row.observedAt)
     ]);


     for (const weekKey of rowWeekKeys) {
         const bucket = weekMaps.get(weekKey);
         if (!bucket) continue;


         const currentChild =
              bucket.micros[row.trueMicroFamilyId] || createStatsFor(row);


         bucket.micros[row.trueMicroFamilyId] = compactStatsRecord(
              refreshStats(updateObservation(currentChild, row))
         );


         const parentId = row.parentTrueMicroFamilyId;
         bucket.parents[parentId] = updateParentObservation(
              bucket.parents[parentId],
              row
         );
     }
}


await saveWeekMaps(redis, weekMaps);


const primary = weekMaps.get(requestedWeekKey);
primaryMicros = primary?.micros || {};
primaryParents = primary?.parents || {};


const childIds = uniqueStrings(
     insertedItems.map((item) => item.compact.trueMicroFamilyId)
);


const parentIds = uniqueStrings(
     insertedItems.map((item) => item.compact.parentTrueMicroFamilyId)
);


const mirrorResults = await mapLimit(
     [
         ...childIds.map((id) => ({
              type: 'child',
                      id,
                      key: ANALYZE_KEYS.microStats(id),
                      value: primaryMicros[id] || null
                  })),
                  ...parentIds.map((id) => ({
                      type: 'parent',
                      id,
                      key: ANALYZE_KEYS.parentStats(id),
                      value: primaryParents[id] || null
                  }))
             ],
             mirrorWriteConcurrency(),
             async (entry) => {
                  try {
                      await saveAggregate(redis, entry.key, entry.value || {});
                      return null;
                  } catch (error) {
                      return {
                           type: entry.type,
                           id: entry.id,
                           error: error?.message || String(error)
                      };
                  }
             }
        );


        mirrorWriteErrors = mirrorResults.filter(Boolean);
    } catch (error) {
        await rollbackDedupeKeys(redis, insertedRedisKeys);
        throw error;
    }
}


const firstIndexByRedisKey = new Map();


for (const item of prepared) {
    if (!item.valid) continue;


    if (!firstIndexByRedisKey.has(item.identity.redisKey)) {
        firstIndexByRedisKey.set(item.identity.redisKey, item.index);
    }
}


const output = prepared
    .map((item) => {
        if (!item.valid) return null;
       const status = dedupeByKey.get(item.identity.redisKey);
       const firstIndex = firstIndexByRedisKey.get(item.identity.redisKey);
       const sameBatchDuplicate = item.index !== firstIndex;
       const inserted = Boolean(status?.inserted && !sameBatchDuplicate);
       const duplicate = !inserted && !status?.error;


       return {
            ...item.row,
            observationRecorded: inserted,
            observationDuplicate: duplicate,
            observationDedupeKey: item.identity.key,
            analyzeObservationResult: {
                ok: !status?.error,
                skipped: !inserted,
                duplicate,
                sameBatchDuplicate,
                reason: status?.error
                  ? 'OBSERVATION_DEDUPE_WRITE_FAILED'
                  : inserted
                    ? null
                    : 'OBSERVATION_ALREADY_RECORDED',
                error: status?.error || null
            }
       };
  })
  .filter(Boolean);


return {
  output,
  requestedWeekKey,
  primaryMicros,
  primaryParents,
  meta: {
       inputRows: sourceRows.length,
       validRows: prepared.filter((row) => row.valid).length,
       invalidRows: prepared.filter((row) => !row.valid).length,
       uniqueDedupeRows: uniqueItems.length,
       insertedRows: insertedItems.length,
       duplicateRows: output.filter((row) => row.observationDuplicate).length,
       dedupeErrorRows: dedupeResults.filter((row) => row.error).length,
       mirrorWriteErrors,
       aggregateReadWriteMode: 'BATCHED_PER_WEEK_KEY',
       fullRowsPersisted: false,
       marketWeatherRowsPersisted: false,
       marketUniversePersisted: false,
       candleDataPersisted: false
  }
    };
}


export async function recordObservation(trade = {}, options = {}) {
    const result = await recordObservationsBatchInternal([trade], options);
    const row = result.output[0] || null;


    if (!row) {
         return {
              ok: false,
              skipped: true,
              reason: 'INVALID_OR_NON_LONG_EXACT_75_CHILD_ID'
         };
    }


    const inserted = row.observationRecorded === true;
    const duplicate = row.observationDuplicate === true;
    const error = row.analyzeObservationResult?.error || null;


    return {
         ok: !error,
         skipped: !inserted,
         duplicate,
         reason: error
              ? 'OBSERVATION_DEDUPE_WRITE_FAILED'
              : duplicate
                ? 'OBSERVATION_ALREADY_RECORDED'
                : null,
         recordId: observationIdentity(row).redisKey,
         row,
         stats: result.primaryMicros[row.trueMicroFamilyId] || null,
         batchMeta: result.meta
    };
}


export async function analyzeCandidate(candidate = {}, options = {}) {
    const result = await recordObservationsBatchInternal([candidate], options);
    return result.output[0] || null;
}


export async function analyzeCandidatesBatch(candidates = [], options = {}) {
    const result = await recordObservationsBatchInternal(candidates, options);
    const output = result.output;


    Object.defineProperty(output, 'batchMeta', {
         value: result.meta,
         enumerable: false,
         configurable: false,
         writable: false
    });


    return output;
}


function calculateGrossR(position = {}, exitPrice) {
    const entry = safeNumber(position.entry ?? position.entryPrice, 0);
    const initialSl = safeNumber(position.initialSl ?? position.sl, 0);
    const exit = safeNumber(exitPrice ?? position.exitPrice, 0);
    const risk = entry - initialSl;


    if (!(entry > 0 && initialSl > 0 && initialSl < entry && exit > 0 && risk > 0))
{
         return 0;
    }


    return (exit - entry) / risk;
}


export function buildOutcomeFromPosition({
    position = {},
    exitPrice,
    exitReason,
    source = 'VIRTUAL'
} = {}) {
    const identity = normalizeAnalyzeIdentity(position);


    if (!identity) {
         return {
              ok: false,
              learnable: false,
              reason: 'INVALID_POSITION_LEARNING_ID',
              source: normalizeSource(source),
              ...longIdentityFlags()
         };
    }


    const normalizedExitPrice = safeNumber(
         exitPrice,
         safeNumber(position.exitPrice, 0)
    );


    const grossR = calculateGrossR(position, normalizedExitPrice);
    const closedAt = safeNumber(
         position.closedAt ?? position.completedAt,
     now()
);


const canonicalPositionId = String(
     position.canonicalPositionId ||
       ''
).trim();
if (!canonicalPositionId) {
     return {
          ok: false,
          learnable: false,
          reason: 'CANONICAL_POSITION_ID_MUST_BE_CREATED_AT_POSITION_OPEN',
          originReference: position.originReference || position.candidateId || position.entryId || null,
          source: normalizeSource(source),
          ...longIdentityFlags()
     };
}
const canonicalOutcomeId = String(
     position.canonicalOutcomeId || canonicalPositionId
).trim();
const outcomeId = canonicalOutcomeId;


const normalizedNetR = safeNumber(
     position.netR ?? position.netPnlR ?? position.exitR,
     grossR
);


const normalizedSource = normalizeSource(source);


return compactOutcomeRecord(position, {
     ok: true,
     learnable: true,
     outcomeId,
     canonicalPositionId,
     canonicalOutcomeId,
     canonicalIdentitySource: 'POSITION_CREATION_CANONICAL_ID',
     originReference: position.originReference || position.candidateId || position.entryId || null,
     positionId: position.positionId || position.id || null,
     source: normalizedSource,
     outcomeSource: normalizedSource,
     status: 'CLOSED',
     exitPrice: normalizedExitPrice,
     exitReason: upper(exitReason || position.exitReason || 'UNKNOWN'),
     closedAt,
     completedAt: closedAt,
     outcomeFinalizedTs: safeNumber(position.outcomeFinalizedTs, closedAt),
     outcomePersistedTs: safeNumber(position.outcomePersistedTs, 0),
     temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
     taxonomyVersion: TEMPORAL_TAXONOMY_VERSION,
     costModelVersion: TEMPORAL_COST_MODEL_VERSION,
     grossR,
     longGrossR: grossR,
     rawR: grossR,


     measurementFixVersion:
       rowMeasurementFixVersion(position),


     outcomeMeasurementVersion:
       position.outcomeMeasurementVersion ||
       position.measurementFixVersion,


     exitFillModelVersion:
       position.exitFillModelVersion ||
       EXIT_FILL_MODEL_VERSION,


     exitFillPolicy:
       position.exitFillPolicy ||
     'TP_SL_USE_TRIGGER_BOUNDARY_TIME_STOP_USES_OBSERVED_PRICE',


exitFillSource:
     position.exitFillSource ||
     null,


exitFillAssumption:
     position.exitFillAssumption ||
     null,


triggerBoundaryFillApplied:
     position.triggerBoundaryFillApplied === true,


exitObservedPrice:
     safeNumber(position.exitObservedPrice, 0),


exitFillPrice:
     safeNumber(
          position.exitFillPrice ??
            normalizedExitPrice,
          normalizedExitPrice
     ),


exitTriggerPrice:
     safeNumber(position.exitTriggerPrice, 0),


observedVsFillPct:
     safeNumber(position.observedVsFillPct, 0),


observedBeyondTriggerPct:
     safeNumber(position.observedBeyondTriggerPct, 0),


netR: normalizedNetR,
exitR: normalizedNetR,
costR: safeNumber(
     position.costR,
     Math.max(0, grossR - normalizedNetR)
),
directToSL: Boolean(position.directToSL ?? position.directSL),
directSL: Boolean(position.directSL ?? position.directToSL),
createdAt: position.createdAt || position.openedAt || now(),
updatedAt: now(),
trueMicroFamilyId: identity.trueMicroFamilyId,
childTrueMicroFamilyId: identity.childTrueMicroFamilyId,
parentTrueMicroFamilyId: identity.parentTrueMicroFamilyId,
setupType: identity.setupType,
regimeBucket: identity.regimeBucket,
        confirmationProfile: identity.confirmationProfile,


        ...entryTemporalFields(position),
        ...exitTemporalFields({
             ...position,
             exitTs: closedAt,
             closedAt
        })
    });
}


export async function getMicroOutcomeHistory(microFamilyId) {
    const normalized = upper(microFamilyId);
    if (!normalized || !validLearningId(normalized) || !isSelectableLongTrueMicroFamilyId(normalized)) {
        return [];
    }
    const redis = getDurableRedis();
    const key = ANALYZE_KEYS.microOutcomes(normalized);
    const rows = await getJson(redis, key, []).catch(() => []);
    return compactOutcomeHistory(Array.isArray(rows) ? rows : []);
}


export async function recordOutcome(outcome = {}, options = {}) {
    const incomingMeasurementVersion =
        rowMeasurementFixVersion(outcome);


    if (incomingMeasurementVersion !== MEASUREMENT_FIX_VERSION) {
        return {
             ok: false,
             skipped: true,
             duplicate: false,
             reason: 'OUTCOME_MEASUREMENT_VERSION_NOT_CURRENT',
             expectedMeasurementFixVersion:
               MEASUREMENT_FIX_VERSION,
             receivedMeasurementFixVersion:
               incomingMeasurementVersion ||
               'UNVERSIONED'
        };
    }


    const row = normalizeAnalyzeIdentity({
        ...outcome,
        ...longIdentityFlags(),
        ...currentMeasurementPolicyFields(outcome),


        measurementFixVersion:
             incomingMeasurementVersion,


        outcomeMeasurementVersion:
             incomingMeasurementVersion
    });


    if (!row || outcome.learnable === false) {
        return {
             ok: false,
             skipped: true,
             reason: 'INVALID_OR_NON_LONG_OUTCOME_ID'
        };
}


const source = normalizeSource(
     options.source || row.source || row.outcomeSource
);


const redis = getDurableRedis();
const identity = outcomeIdentity(row);


if (!identity) {
     return {
          ok: false,
          skipped: true,
          duplicate: false,
          reason: 'CANONICAL_POSITION_ID_REQUIRED_FOR_OUTCOME_DEDUPE'
     };
}


assertAnalyzeWrite(identity.redisKey);


const insertResult = await setNxJson(
     redis,
     identity.redisKey,
     {
          outcomeDedupeKey: identity.key,
          outcomeId: identity.id,
          measurementFixVersion:
            identity.measurementVersion,
          trueMicroFamilyId: row.trueMicroFamilyId,
          createdAt: now()
     },
     {
          ex: outcomeTtlSec()
     }
);


const inserted = nxInsertSucceeded(insertResult);


if (!inserted) {
     return {
          ok: true,
          skipped: true,
          duplicate: true,
          reason: 'OUTCOME_ALREADY_RECORDED',
          outcomeId: identity.id
     };
}


const closedAt = safeNumber(row.closedAt ?? row.completedAt, now());
const completedAt = safeNumber(row.completedAt ?? row.closedAt, closedAt);


const enriched = compactOutcomeRecord(row, {
     outcomeId: identity.id,
     canonicalPositionId: identity.canonicalPositionId,
     canonicalOutcomeId: identity.canonicalOutcomeId,
     canonicalIdentitySource: row.canonicalIdentitySource || 'CANONICAL_POSITION_ID',
     outcomeDedupeKey: identity.key,
     outcomeDuplicate: false,
     outcomeAlreadyRecorded: false,
outcomeCounted: true,
countOutcome: true,
source,
outcomeSource: source,
status: 'CLOSED',
closedAt,
completedAt,
outcomeFinalizedTs: safeNumber(
     row.outcomeFinalizedTs ?? row.finalizedAt,
     completedAt
),
outcomePersistedTs: safeNumber(row.outcomePersistedTs, 0),
temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
taxonomyVersion: TEMPORAL_TAXONOMY_VERSION,
costModelVersion: TEMPORAL_COST_MODEL_VERSION,


...currentMeasurementPolicyFields(row),


measurementFixVersion:
  MEASUREMENT_FIX_VERSION,


outcomeMeasurementVersion:
  MEASUREMENT_FIX_VERSION,


exitFillModelVersion:
  row.exitFillModelVersion ||
  EXIT_FILL_MODEL_VERSION,


exitFillSource:
  row.exitFillSource ||
  null,


exitFillAssumption:
  row.exitFillAssumption ||
  null,


triggerBoundaryFillApplied:
  row.triggerBoundaryFillApplied === true,


exitObservedPrice:
  safeNumber(row.exitObservedPrice, 0),


exitFillPrice:
  safeNumber(
       row.exitFillPrice ??
           row.exitPrice,
       0
  ),


exitTriggerPrice:
  safeNumber(row.exitTriggerPrice, 0),


observedVsFillPct:
  safeNumber(row.observedVsFillPct, 0),
     observedBeyondTriggerPct:
         safeNumber(row.observedBeyondTriggerPct, 0)
});


const requestedWeekKey = resolveWeekKey(
     options.weekKey || options.persistentLearningKey
);


const weekKeys = uniqueStrings([
     requestedWeekKey,
     PERSISTENT_LEARNING_KEY,
     getIsoWeekKey(enriched.completedAt)
]);


try {
     const weekMaps = await readWeekMaps(redis, weekKeys);


     for (const weekKey of weekKeys) {
         const bucket = weekMaps.get(weekKey);
         if (!bucket) continue;


         const currentChild =
              bucket.micros[enriched.trueMicroFamilyId] || createStatsFor(enriched);


         bucket.micros[enriched.trueMicroFamilyId] = compactStatsRecord(
              refreshStats(updateOutcome(currentChild, enriched, source))
         );


         const parentId = enriched.parentTrueMicroFamilyId;
         bucket.parents[parentId] = updateParentOutcome(
              bucket.parents[parentId],
              enriched
         );
     }


     await saveWeekMaps(redis, weekMaps);


     const primary = weekMaps.get(requestedWeekKey);
     const primaryStats =
         primary?.micros?.[enriched.trueMicroFamilyId] || null;
     const primaryParent =
         primary?.parents?.[enriched.parentTrueMicroFamilyId] || null;


     await Promise.allSettled([
         saveAggregate(
              redis,
              ANALYZE_KEYS.microStats(enriched.trueMicroFamilyId),
                  primaryStats || {}
             ),
             saveAggregate(
                  redis,
                  ANALYZE_KEYS.parentStats(enriched.parentTrueMicroFamilyId),
                  primaryParent || {}
             )
        ]);


        enriched.acceptedTemporalOutcomeSeq = Math.max(
             0,
             Math.floor(safeNumber(primaryStats?.acceptedTemporalOutcomeSeq, 0))
        );
        enriched.outcomePersistedTs = now();
        enriched.updatedAt = enriched.outcomePersistedTs;


        const outcomeKey = ANALYZE_KEYS.microOutcomes(
             enriched.trueMicroFamilyId
        );


        const priorOutcomes = await getJson(redis, outcomeKey, []).catch(() => []);


        const savedHistory = await saveMicroOutcomeHistory(redis, outcomeKey, [
             ...(Array.isArray(priorOutcomes) ? priorOutcomes : []),
             enriched
        ]);


        return {
             ok: true,
             skipped: false,
             duplicate: false,
             outcomeId: identity.id,
             measurementFixVersion:
                  MEASUREMENT_FIX_VERSION,
             outcomeMeasurementAccepted: true,
             outcome: enriched,
             stats: primaryStats,
             outcomeHistory: {
                  key: outcomeKey,
                  rows: savedHistory.history.length,
                  bytes: savedHistory.bytes,
                  maxBytes: maxMicroOutcomeHistoryBytes(),
                  compact: true,
                  fallbackUsed: savedHistory.fallbackUsed,
                  fullRowsPersisted: false,
                  marketWeatherRowsPersisted: false
             }
        };
    } catch (error) {
        await delJson(redis, identity.redisKey).catch(() => null);
        throw error;
    }
}
export async function backfillTemporalOutcomes({
    outcomes = [],
    dryRun = true,
    familyId = null
} = {}) {
    const requestedFamilyId = upper(familyId);
    const accepted = [];
    const rejected = [];
    const seen = new Set();
    for (const raw of Array.isArray(outcomes) ? outcomes : []) {
        const row = normalizeTemporalOutcome(raw, requestedFamilyId || null);
        if (!row) {
            rejected.push({ reason: 'INVALID_TEMPORAL_BACKFILL_OUTCOME', raw });
            continue;
        }
        if (seen.has(row.canonicalOutcomeId)) {
            rejected.push({
                reason: 'DUPLICATE_CANONICAL_OUTCOME',
                canonicalOutcomeId: row.canonicalOutcomeId
            });
            continue;
        }
        seen.add(row.canonicalOutcomeId);
        accepted.push(row);
    }
    const report = {
        ok: true,
        dryRun: dryRun !== false,
        temporalStatsEnabled: temporalStatsEnabled(),
        inputCount: Array.isArray(outcomes) ? outcomes.length : 0,
        acceptedCount: accepted.length,
        rejectedCount: rejected.length,
        acceptedCanonicalOutcomeIds: accepted.map((row) => row.canonicalOutcomeId),
        rejected,
        globalStatsIncremented: false,
        vetoActivated: false,
        weekendApproved: false,
        entryDecisionSnapshotsInvented: false
    };
    if (dryRun !== false || accepted.length === 0 || !temporalStatsEnabled()) {
        return report;
    }
    const redis = getDurableRedis();
    const grouped = new Map();
    for (const row of accepted) {
        const rows = grouped.get(row.trueMicroFamilyId) || [];
        rows.push(row);
        grouped.set(row.trueMicroFamilyId, rows);
    }
    for (const [microFamilyId, rows] of grouped) {
        const statsKey = ANALYZE_KEYS.microStats(microFamilyId);
        const historyKey = ANALYZE_KEYS.microOutcomes(microFamilyId);
        const [storedStats, storedHistory] = await Promise.all([
            getJson(redis, statsKey, {}).catch(() => ({})),
            getJson(redis, historyKey, []).catch(() => ([]))
        ]);
        const stats = refreshStats(storedStats || createStatsFor(rows[0]));
        const existingIds = new Set(
            (Array.isArray(storedHistory) ? storedHistory : [])
                .map((row) => String(row.canonicalOutcomeId || row.canonicalPositionId || ''))
                .filter(Boolean)
        );
        const newlyAcceptedRows = [];
        for (const row of rows) {
            if (existingIds.has(row.canonicalOutcomeId)) continue;
            recordTemporalOutcome(stats, row, {
                netR: row.netR,
                grossR: row.grossR,
                costR: row.costR,
                directSL: row.directSL
            });
            const acceptedRow = {
                ...row,
                acceptedTemporalOutcomeSeq: stats.acceptedTemporalOutcomeSeq,
                backfilledAt: now(),
                temporalBackfill: true
            };
            newlyAcceptedRows.push(acceptedRow);
            existingIds.add(row.canonicalOutcomeId);
        }
        if (newlyAcceptedRows.length === 0) continue;
        await Promise.all([
            saveAggregate(redis, statsKey, compactStatsRecord(stats)),
            saveMicroOutcomeHistory(redis, historyKey, [
                ...(Array.isArray(storedHistory) ? storedHistory : []),
                ...newlyAcceptedRows
            ])
        ]);
    }
    return {
        ...report,
        dryRun: false,
        applied: true
    };
}


export default {
     analyzeCandidate,
     analyzeCandidatesBatch,
     recordObservation,
     buildOutcomeFromPosition,
     recordOutcome,
     getWeekMicros,
     saveWeekMicros,
     getWeekParents,
     saveWeekParents,
     getMicroOutcomeHistory,
     backfillTemporalOutcomes
};
