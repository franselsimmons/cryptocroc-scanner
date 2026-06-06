// ================= FILE: src/analyze/analyzeEngine.js =================

import { gzipSync, gunzipSync } from 'zlib';
import { createHash } from 'crypto';
import { CONFIG } from '../config.js';
import { KEYS } from '../keys.js';
import { getDurableRedis, getJson, setJson } from '../redis.js';
import {
  getIsoWeekKey,
  randomId,
  safeNumber,
  sideToTradeSide
} from '../utils.js';
import {
  classifyMicroFamily,
  classifyMacroFamily,
  isMicroFamilyV1Id,
  isMicroFamilyV2Id
} from './microFamilies.js';
import {
  createMicroStats,
  updateObservation,
  updateOutcome,
  refreshStats
} from './scoring.js';
import { applyCosts } from '../trade/costModel.js';

const WEEK_MICROS_CODEC = 'ANALYZE_WEEK_MICROS_GZIP_V1';
const WEEK_MICRO_ROW_CODEC = 'ANALYZE_WEEK_MICRO_ROW_GZIP_V1';
const WEEK_MICROS_TOP_CODEC = 'ANALYZE_WEEK_MICROS_TOP_GZIP_V1';

const DEFAULT_MAX_REDIS_SET_BYTES = 9_500_000;
const DEFAULT_MAX_ROW_SET_BYTES = 250_000;

const DEFAULT_TOP_MICROS_SNAPSHOT_LIMIT = 300;
const DEFAULT_MAX_FULL_READ_MICRO_ROWS = 1_500;
const DEFAULT_FULL_READ_SOFT_TIMEOUT_MS = 2_400;

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';

const VALID_TRADE_SIDES = new Set([TARGET_TRADE_SIDE]);

const EXECUTION_MICRO_SUFFIX = 'XR';
const EXECUTION_MICRO_HASH_LEN = 10;

function now() {
  return Date.now();
}

function normalizeSource(source) {
  return String(source || 'REAL').toUpperCase();
}

function mirrorConfig() {
  return {
    enabled: false,
    mirrorOutcomes: false
  };
}

function sideTextToTradeSide(value) {
  const raw = String(value || '').trim().toUpperCase();

  if (!raw) return 'UNKNOWN';

  const direct = sideToTradeSide(raw);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;

  if ([
    'LONG',
    'BULL',
    'BULLISH',
    'BUY',
    'BID',
    'UP',
    'UPSIDE',
    'GREEN'
  ].includes(raw)) {
    return TARGET_TRADE_SIDE;
  }

  const normalized = raw.replace(/[^A-Z0-9]+/g, '_');

  const longPatterns = [
    'LONG',
    'BULL',
    'BULLISH',
    'BUY',
    'SIDE_LONG',
    'TRADE_SIDE_LONG',
    'TRADESIDE_LONG',
    'DIRECTION_LONG',
    'SIDE_BULL',
    'TRADE_SIDE_BULL',
    'DIRECTION_BULL',
    'SIDE_BUY',
    'DIRECTION_BUY',
    'MICRO_LONG',
    'FAMILY_LONG'
  ];

  const longHit = longPatterns.some((pattern) => (
    normalized === pattern ||
    normalized.startsWith(`${pattern}_`) ||
    normalized.endsWith(`_${pattern}`) ||
    normalized.includes(`_${pattern}_`)
  ));

  if (longHit) return TARGET_TRADE_SIDE;

  return 'UNKNOWN';
}

function sideProbeValues(row = {}, classified = {}) {
  return [
    row.tradeSide,
    row.side,
    row.positionSide,
    row.direction,
    row.signalSide,
    row.intentSide,
    row.entrySide,

    classified.tradeSide,
    classified.side,
    classified.positionSide,
    classified.direction,

    row.familyId,
    row.family,
    row.baseFamilyId,

    row.microFamilyId,
    row.trueMicroFamilyId,
    row.id,
    row.key,

    row.macroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId,
    row.parentFamilyId,
    row.macroId,

    row.definition,
    row.microDefinition,
    row.macroDefinition,
    row.parentDefinition,

    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts : []),
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : [])
  ];
}

function inferTradeSide(row = {}, classified = {}) {
  for (const value of sideProbeValues(row, classified)) {
    const side = sideTextToTradeSide(value);

    if (VALID_TRADE_SIDES.has(side)) return side;
  }

  return 'UNKNOWN';
}

function isTargetOnlyRow(row = {}, classified = {}) {
  return inferTradeSide(row, classified) === TARGET_TRADE_SIDE;
}

function dashboardSideFromTradeSide(side) {
  const tradeSide = sideTextToTradeSide(side);

  if (tradeSide === TARGET_TRADE_SIDE) return TARGET_DASHBOARD_SIDE;

  return 'unknown';
}

function oppositeTradeSide() {
  return 'UNKNOWN';
}

function normalizeClassificationInput(row = {}, forcedSide = null) {
  const tradeSide = forcedSide || inferTradeSide(row);

  if (tradeSide !== TARGET_TRADE_SIDE) return null;

  return {
    ...row,

    side: TARGET_TRADE_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE
  };
}

function normalizeClassifiedSide(classified = {}) {
  return {
    ...classified,
    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE
  };
}

function buildOppositeSideRow() {
  return null;
}

function isLongSide() {
  return true;
}

function getAnalyzeSchemaMeta() {
  return {
    schema: CONFIG?.analyze?.schema,
    macroSchema: CONFIG?.analyze?.macroSchema || CONFIG?.analyze?.schema || 'MF_V1',
    microSchema: CONFIG?.analyze?.microSchema || 'MF_V2',
    strategyVersion: CONFIG.strategyVersion
  };
}

function getWeekStorageConfig() {
  return {
    compressionEnabled: CONFIG.analyze?.weekMicrosCompressionEnabled !== false,

    compressionLevel: Math.max(
      1,
      Math.min(9, Math.floor(safeNumber(CONFIG.analyze?.weekMicrosCompressionLevel, 6)))
    ),

    maxRedisSetBytes: Math.max(
      500_000,
      Math.floor(safeNumber(CONFIG.redis?.maxRequestBytes, DEFAULT_MAX_REDIS_SET_BYTES))
    ),

    maxRowSetBytes: Math.max(
      50_000,
      Math.floor(safeNumber(CONFIG.analyze?.maxMicroRowSetBytes, DEFAULT_MAX_ROW_SET_BYTES))
    ),

    weekMicrosTtlSec: Math.max(
      60 * 60,
      Math.floor(safeNumber(CONFIG.analyze?.weekMicrosTtlSec, 60 * 60 * 24 * 21))
    ),

    weekMetaTtlSec: Math.max(
      60 * 60,
      Math.floor(safeNumber(CONFIG.analyze?.weekMetaTtlSec, 60 * 60 * 24 * 90))
    ),

    storageConcurrency: Math.max(
      1,
      Math.min(20, Math.floor(safeNumber(CONFIG.analyze?.storageConcurrency, 8)))
    ),

    topMicrosSnapshotLimit: Math.max(
      25,
      Math.min(
        1_000,
        Math.floor(safeNumber(CONFIG.analyze?.topMicrosSnapshotLimit, DEFAULT_TOP_MICROS_SNAPSHOT_LIMIT))
      )
    ),

    maxFullReadMicroRows: Math.max(
      25,
      Math.floor(safeNumber(CONFIG.analyze?.maxFullReadMicroRows, DEFAULT_MAX_FULL_READ_MICRO_ROWS))
    ),

    fullReadSoftTimeoutMs: Math.max(
      250,
      Math.floor(safeNumber(CONFIG.analyze?.fullReadSoftTimeoutMs, DEFAULT_FULL_READ_SOFT_TIMEOUT_MS))
    ),

    preferTopSnapshotOnLargeIndex: CONFIG.analyze?.preferTopSnapshotOnLargeIndex !== false,

    maxExamplesPerMicro: Math.max(
      0,
      Math.floor(safeNumber(CONFIG.analyze?.maxExamplesPerMicro, 8))
    ),

    maxRecentOutcomesPerMicro: Math.max(
      0,
      Math.floor(safeNumber(CONFIG.analyze?.maxRecentOutcomesPerMicro, 8))
    ),

    maxDefinitionPartsPerMicro: Math.max(
      4,
      Math.floor(safeNumber(CONFIG.analyze?.maxDefinitionPartsPerMicro, 64))
    ),

    maxParentDefinitionPartsPerMicro: Math.max(
      4,
      Math.floor(safeNumber(CONFIG.analyze?.maxParentDefinitionPartsPerMicro, 48))
    ),

    maxCounterKeysPerMicro: Math.max(
      4,
      Math.floor(safeNumber(CONFIG.analyze?.maxCounterKeysPerMicro, 18))
    ),

    maxCounterValuesPerCounter: Math.max(
      4,
      Math.floor(safeNumber(CONFIG.analyze?.maxCounterValuesPerCounter, 24))
    ),

    maxStringLength: Math.max(
      80,
      Math.floor(safeNumber(CONFIG.analyze?.maxStoredStringLength, 480))
    )
  };
}

function getWeekMicrosBaseKey(weekKey) {
  return KEYS.analyze.weekMicros(weekKey);
}

function getWeekMicrosIndexKey(weekKey) {
  return `${getWeekMicrosBaseKey(weekKey)}:INDEX`;
}

function getWeekMicrosTopKey(weekKey) {
  return `${getWeekMicrosBaseKey(weekKey)}:TOP`;
}

function getWeekMicroRowKey(weekKey, microFamilyId) {
  return `${getWeekMicrosBaseKey(weekKey)}:ROW:${microFamilyId}`;
}

async function mapLimit(items = [], concurrency = 8, worker) {
  const rows = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Math.floor(Number(concurrency) || 1));
  const results = new Array(rows.length);

  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < rows.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(rows[index], index);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(limit, rows.length) },
      () => runWorker()
    )
  );

  return results;
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function normalizeStatsSide() {
  return TARGET_DASHBOARD_SIDE;
}

function hasUsableDefinitionParts(value) {
  return Array.isArray(value) && value.length > 0;
}

function idSide(row = {}) {
  const values = [
    row.microFamilyId,
    row.trueMicroFamilyId,
    row.id,
    row.key,
    row.familyId,
    row.macroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId
  ];

  for (const value of values) {
    const side = sideTextToTradeSide(value);

    if (VALID_TRADE_SIDES.has(side)) return side;
  }

  return 'UNKNOWN';
}

function isExecutionRefinedMicroId(value = '') {
  const text = String(value || '').toUpperCase();

  return text.includes(`_${EXECUTION_MICRO_SUFFIX}_`);
}

function shouldRefineExecutionMicroIds() {
  return CONFIG.analyze?.refineExecutionMicroIds !== false;
}

function shouldReclassifyAsTrueMicro(row = {}) {
  const inferredTradeSide = inferTradeSide(row);
  const existingIdSide = idSide(row);

  if (inferredTradeSide === TARGET_TRADE_SIDE && existingIdSide !== TARGET_TRADE_SIDE) {
    return true;
  }

  if (!row.microFamilyId || !row.familyId) return true;

  if (isMicroFamilyV1Id(row.microFamilyId)) return true;

  if (
    shouldRefineExecutionMicroIds() &&
    isMicroFamilyV2Id(row.microFamilyId) &&
    !isExecutionRefinedMicroId(row.microFamilyId)
  ) {
    return true;
  }

  if (isMicroFamilyV2Id(row.microFamilyId)) return false;

  return !row.parentMacroFamilyId && !row.macroFamilyId;
}

function truncateString(value, maxLength = 480) {
  const text = String(value ?? '');

  if (text.length <= maxLength) return text;

  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function compactDefinitionParts(parts = [], maxItems = 64, maxStringLength = 480) {
  if (!Array.isArray(parts)) return [];

  return parts
    .slice(0, maxItems)
    .map((part) => truncateString(part, maxStringLength))
    .filter(Boolean);
}

function compactCounterValues(counter = {}, maxValues = 24) {
  if (!counter || typeof counter !== 'object') return {};

  return Object.fromEntries(
    Object.entries(counter)
      .sort((a, b) => safeNumber(b[1], 0) - safeNumber(a[1], 0))
      .slice(0, maxValues)
      .map(([key, value]) => [
        truncateString(key, 160),
        safeNumber(value, 0)
      ])
  );
}

function compactCounters(counters = {}, maxKeys = 18, maxValues = 24) {
  if (!counters || typeof counters !== 'object') return {};

  return Object.fromEntries(
    Object.entries(counters)
      .slice(0, maxKeys)
      .map(([key, value]) => [
        truncateString(key, 160),
        compactCounterValues(value, maxValues)
      ])
  );
}

function compactExample(example, maxStringLength = 480) {
  if (typeof example === 'string') {
    return truncateString(example, maxStringLength);
  }

  if (!example || typeof example !== 'object') {
    return example ?? null;
  }

  return {
    symbol: example.symbol || example.baseSymbol || example.contractSymbol || null,
    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    rsiZone: example.rsiZone || null,
    rsiCoarse: example.rsiCoarse || null,
    flow: example.flow || null,
    flowCoarse: example.flowCoarse || null,
    obRelation: example.obRelation || null,
    btcRelation: example.btcRelation || null,
    btcState: example.btcState || null,
    regime: example.regime || null,
    scannerReason: example.scannerReason || null,
    scannerReasonCoarse: example.scannerReasonCoarse || null,
    isMirrorMicroFamily: false,
    ts: safeNumber(example.ts || example.createdAt, null)
  };
}

function compactExamples(examples = [], maxItems = 8, maxStringLength = 480) {
  if (!Array.isArray(examples) || maxItems <= 0) return [];

  return examples
    .slice(-maxItems)
    .map((example) => compactExample(example, maxStringLength))
    .filter((example) => example !== null && example !== undefined);
}

function compactOutcome(outcome = {}) {
  if (!outcome || typeof outcome !== 'object') return null;

  const inferred = inferTradeSide(outcome);

  if (inferred !== TARGET_TRADE_SIDE) return null;

  return {
    source: outcome.source || null,

    tradeId: outcome.tradeId || null,
    shadowId: outcome.shadowId || outcome.id || null,

    symbol: outcome.symbol || outcome.baseSymbol || outcome.contractSymbol || null,
    contractSymbol: outcome.contractSymbol || null,
    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,

    exitReason: outcome.exitReason || outcome.reason || null,

    exitR: safeNumber(outcome.exitR ?? outcome.netR, 0),
    netR: safeNumber(outcome.netR ?? outcome.exitR, 0),
    grossR: safeNumber(outcome.grossR, 0),

    pnlPct: safeNumber(outcome.pnlPct ?? outcome.netPnlPct, 0),
    netPnlPct: safeNumber(outcome.netPnlPct ?? outcome.pnlPct, 0),
    grossPnlPct: safeNumber(outcome.grossPnlPct, 0),

    costR: safeNumber(outcome.costR, 0),
    costPct: safeNumber(outcome.costPct, 0),

    mfeR: safeNumber(outcome.mfeR, 0),
    maeR: safeNumber(outcome.maeR, 0),

    directToSL: Boolean(outcome.directToSL),
    nearTpSeen: Boolean(outcome.nearTpSeen),
    reachedHalfR: Boolean(outcome.reachedHalfR),
    reachedOneR: Boolean(outcome.reachedOneR),

    beArmed: Boolean(outcome.beArmed),
    beWouldExit: Boolean(outcome.beWouldExit),
    beExitR: safeNumber(outcome.beExitR, 0),

    gaveBackAfterHalfR: Boolean(outcome.gaveBackAfterHalfR),
    gaveBackAfterOneR: Boolean(outcome.gaveBackAfterOneR),
    nearTpThenLoss: Boolean(outcome.nearTpThenLoss),

    isMirrorMicroFamily: false,

    ts: safeNumber(
      outcome.ts ||
      outcome.closedAt ||
      outcome.completedAt ||
      outcome.updatedAt,
      now()
    )
  };
}

function compactRecentOutcomes(outcomes = [], maxItems = 8) {
  if (!Array.isArray(outcomes) || maxItems <= 0) return [];

  return outcomes
    .slice(-maxItems)
    .map(compactOutcome)
    .filter(Boolean);
}

function removeKnownBulkyFields(row = {}) {
  const clean = { ...row };

  const bulkyKeys = [
    'raw',
    'payload',
    'debug',
    'request',
    'response',
    'stack',
    'html',
    'candles',
    'candles15m',
    'candles1h',
    'candles4h',
    'candles1d',
    'orderBook',
    'rawOrderBook',
    'bids',
    'asks',
    'ticks',
    'prices',
    'history',
    'marketData'
  ];

  for (const key of bulkyKeys) {
    delete clean[key];
  }

  return clean;
}

function normalizeBucketText(value, fallback = 'NA') {
  const text = String(value ?? '').trim();

  if (!text) return fallback;

  return text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || fallback;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }

  return null;
}

function boolBucket(value, label) {
  return `${label}=${value ? 'YES' : 'NO'}`;
}

function numericBucket(value, {
  label,
  scale = 1,
  step = 1,
  min = -Infinity,
  max = Infinity,
  fallback = 'NA'
} = {}) {
  const n = safeNumber(value, null);

  if (!Number.isFinite(n)) return `${label}=${fallback}`;

  const scaled = n * scale;
  const clipped = Math.max(min, Math.min(max, scaled));
  const bucket = Math.round(clipped / step) * step;

  return `${label}=${bucket}`;
}

function ratioBucket(value, label, stepPct = 5, maxPct = 100) {
  return numericBucket(value, {
    label,
    scale: 100,
    step: stepPct,
    min: -maxPct,
    max: maxPct,
    fallback: 'NA'
  });
}

function bpsBucket(value, label, step = 2, max = 80) {
  return numericBucket(value, {
    label,
    scale: 1,
    step,
    min: 0,
    max,
    fallback: 'NA'
  });
}

function stableHash(value, length = EXECUTION_MICRO_HASH_LEN) {
  return createHash('sha256')
    .update(String(value || ''))
    .digest('hex')
    .toUpperCase()
    .slice(0, length);
}

function mergeDefinitionParts(...groups) {
  return uniqueStrings(
    groups.flatMap((group) => {
      if (!group) return [];
      if (Array.isArray(group)) return group;

      return [group];
    })
  );
}

function getSymbolBucket(row = {}) {
  const raw = String(
    row.symbol ||
    row.baseSymbol ||
    row.contractSymbol ||
    ''
  ).toUpperCase();

  const symbol = raw
    .replace(/USDTUMCBL|USDCUMCBL|USDTPERP|USDCPERP|USDT|USDC|BUSD|PERP|SWAP|USD/g, '')
    .replace(/[^A-Z0-9]/g, '');

  if (!symbol) return 'SYM=NA';

  const major = new Set([
    'BTC',
    'ETH',
    'SOL',
    'XRP',
    'BNB',
    'DOGE',
    'ADA',
    'AVAX',
    'LINK',
    'DOT',
    'TON',
    'TRX',
    'LTC',
    'BCH'
  ]);

  const meme = new Set([
    'PEPE',
    'SHIB',
    'WIF',
    'BONK',
    'FLOKI',
    'DOGE'
  ]);

  if (major.has(symbol)) return `SYM_CLASS=MAJOR_${symbol}`;
  if (meme.has(symbol)) return `SYM_CLASS=MEME_${symbol}`;

  return `SYM_BUCKET=${stableHash(symbol, 4)}`;
}

function buildExecutionFingerprintParts(row = {}, classified = {}, macro = {}) {
  const scannerReason = firstDefined(
    classified.scannerReasonCoarse,
    row.scannerReasonCoarse,
    classified.scannerReason,
    row.scannerReason
  );

  const spreadBps = firstDefined(
    classified.spreadBps,
    row.spreadBps,
    row.spreadPct !== undefined ? safeNumber(row.spreadPct, 0) * 10_000 : null
  );

  const orderbookImbalance = firstDefined(
    row.orderbookImbalance,
    row.bookImbalance,
    row.bidAskImbalance,
    row.obImbalance,
    row.obBias
  );

  const spoofScore = firstDefined(
    row.spoofScore,
    row.orderbookSpoofScore,
    row.obSpoofScore,
    row.fakeLiquidityScore
  );

  const liqDistancePct = firstDefined(
    row.liqDistancePct,
    row.liquidationDistancePct,
    row.distanceToLiquidationPct,
    row.nearestLiqDistancePct
  );

  const entryDistancePct = firstDefined(
    row.entryDistancePct,
    row.entryDistanceToMidPct,
    row.pullbackDistancePct,
    row.distanceToEntryPct,
    row.distancePct
  );

  const slDistancePct = firstDefined(
    row.slDistancePct,
    row.stopDistancePct,
    row.stopLossDistancePct
  );

  const tpDistancePct = firstDefined(
    row.tpDistancePct,
    row.takeProfitDistancePct
  );

  const volatilityPct = firstDefined(
    row.atrPct,
    row.volatilityPct,
    row.rangePct,
    row.realizedVolPct
  );

  const confluence = firstDefined(
    row.confluence,
    row.sniperScore,
    row.scannerScore,
    row.moveScore
  );

  return mergeDefinitionParts([
    `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
    `FAMILY=${normalizeBucketText(classified.familyId || row.familyId || 'NO_FAMILY')}`,
    `MACRO=${normalizeBucketText(classified.macroFamilyId || classified.parentMacroFamilyId || macro.microFamilyId || row.macroFamilyId || row.parentMacroFamilyId || 'NO_MACRO')}`,

    `ASSET=${normalizeBucketText(classified.assetClass || row.assetClass || 'NA')}`,

    `RSI=${normalizeBucketText(classified.rsiZone || row.rsiZone || 'NA')}`,
    `RSI_COARSE=${normalizeBucketText(classified.rsiCoarse || row.rsiCoarse || 'NA')}`,
    numericBucket(row.rsiSlope, { label: 'RSI_SLOPE', step: 5, min: -100, max: 100 }),
    numericBucket(row.rsiVelocity, { label: 'RSI_VEL', step: 5, min: -100, max: 100 }),
    numericBucket(row.rsiDelta, { label: 'RSI_DELTA', step: 5, min: -100, max: 100 }),
    numericBucket(row.rsiMomentum, { label: 'RSI_MOM', step: 5, min: -100, max: 100 }),

    `FLOW=${normalizeBucketText(classified.flow || row.flow || 'NA')}`,
    `FLOW_COARSE=${normalizeBucketText(classified.flowCoarse || row.flowCoarse || 'NA')}`,

    `OB_REL=${normalizeBucketText(classified.obRelation || row.obRelation || 'NA')}`,
    numericBucket(orderbookImbalance, { label: 'OB_IMB', step: 0.1, min: -2, max: 2 }),
    numericBucket(spoofScore, { label: 'SPOOF', step: 5, min: 0, max: 100 }),

    `BTC_STATE=${normalizeBucketText(classified.btcState || row.btcState || 'NA')}`,
    `BTC_REL=${normalizeBucketText(classified.btcRelation || row.btcRelation || 'NA')}`,

    `REGIME=${normalizeBucketText(classified.regime || row.regime || 'NA')}`,
    `REGIME_COARSE=${normalizeBucketText(classified.regimeCoarse || row.regimeCoarse || 'NA')}`,

    `SCANNER=${normalizeBucketText(scannerReason || 'NA')}`,

    bpsBucket(spreadBps, 'SPREAD_BPS', 2, 80),
    numericBucket(row.depthMinUsd1p, { label: 'DEPTH_1P_USD', step: 25_000, min: 0, max: 2_000_000 }),
    ratioBucket(row.fundingRate, 'FUNDING', 0.01, 1),

    ratioBucket(entryDistancePct, 'ENTRY_DIST', 0.25, 15),
    ratioBucket(slDistancePct, 'SL_DIST', 0.25, 20),
    ratioBucket(tpDistancePct, 'TP_DIST', 0.5, 40),
    ratioBucket(liqDistancePct, 'LIQ_DIST', 0.5, 50),
    ratioBucket(volatilityPct, 'VOL', 0.25, 25),

    numericBucket(confluence, { label: 'CONFLUENCE', step: 5, min: 0, max: 100 }),

    `ENTRY_QUALITY=${normalizeBucketText(row.entryQuality || 'NA')}`,

    boolBucket(Boolean(row.retestConfirmed), 'RETEST'),
    boolBucket(Boolean(row.pullbackConfirmed), 'PULLBACK'),
    boolBucket(Boolean(row.sweepConfirmed), 'SWEEP'),
    boolBucket(Boolean(row.fakeBreakout), 'FAKE_BO'),
    boolBucket(Boolean(row.fakeBreakoutRisk), 'FAKE_RISK'),

    getSymbolBucket(row)
  ]);
}

function refineExecutionMicroFamily(classified = {}, row = {}, macro = {}) {
  if (!shouldRefineExecutionMicroIds()) {
    return classified;
  }

  const coarseMicroFamilyId = classified.microFamilyId || row.microFamilyId || row.trueMicroFamilyId || null;
  const familyId = classified.familyId || row.familyId || row.family || 'LONG_UNKNOWN';

  if (!coarseMicroFamilyId) {
    return classified;
  }

  if (isExecutionRefinedMicroId(coarseMicroFamilyId)) {
    return classified;
  }

  const executionParts = buildExecutionFingerprintParts(row, classified, macro);
  const executionHash = stableHash(executionParts.join('|'), EXECUTION_MICRO_HASH_LEN);

  const refinedMicroFamilyId = `${coarseMicroFamilyId}_${EXECUTION_MICRO_SUFFIX}_${executionHash}`;

  const definitionParts = mergeDefinitionParts(
    classified.definitionParts || [],
    executionParts,
    [
      `COARSE_MICRO=${coarseMicroFamilyId}`,
      `EXECUTION_HASH=${executionHash}`,
      `EXECUTION_SCHEMA=${EXECUTION_MICRO_SUFFIX}`
    ]
  );

  return {
    ...classified,

    microFamilyId: refinedMicroFamilyId,
    trueMicroFamilyId: refinedMicroFamilyId,

    coarseMicroFamilyId,
    baseMicroFamilyId: coarseMicroFamilyId,
    legacyMicroFamilyId: coarseMicroFamilyId,

    familyId,

    executionFingerprintHash: executionHash,
    executionFingerprintParts: executionParts,
    executionFingerprintSchema: EXECUTION_MICRO_SUFFIX,

    definitionParts,
    definition: definitionParts.join(' | ')
  };
}

function enrichWithMicroFamily(row = {}, { forcedSide = null } = {}) {
  const classifyInput = normalizeClassificationInput(row, forcedSide);

  if (!classifyInput) return null;

  const rawMacro = classifyMacroFamily(classifyInput);
  const macro = normalizeClassifiedSide(rawMacro);

  const rawClassified = classifyMicroFamily(classifyInput);
  const classified = refineExecutionMicroFamily(
    normalizeClassifiedSide(rawClassified),
    classifyInput,
    macro
  );

  const outputTradeSide = TARGET_TRADE_SIDE;
  const outputSide = TARGET_DASHBOARD_SIDE;

  const classificationDefinitionParts = mergeDefinitionParts(
    classified.definitionParts || [],
    hasUsableDefinitionParts(row.definitionParts) ? row.definitionParts : []
  );

  const parentDefinitionParts = hasUsableDefinitionParts(row.parentDefinitionParts)
    ? row.parentDefinitionParts
    : classified.parentDefinitionParts || macro.definitionParts || [];

  if (shouldReclassifyAsTrueMicro(classifyInput)) {
    return {
      ...row,

      familyId: classified.familyId,
      microFamilyId: classified.microFamilyId,
      trueMicroFamilyId: classified.microFamilyId,

      coarseMicroFamilyId: classified.coarseMicroFamilyId || null,
      baseMicroFamilyId: classified.baseMicroFamilyId || null,
      legacyMicroFamilyId: classified.legacyMicroFamilyId || null,

      executionFingerprintHash: classified.executionFingerprintHash || null,
      executionFingerprintParts: classified.executionFingerprintParts || [],
      executionFingerprintSchema: classified.executionFingerprintSchema || null,

      macroFamilyId: classified.macroFamilyId || macro.microFamilyId,
      parentMacroFamilyId: classified.parentMacroFamilyId || macro.microFamilyId,
      parentMicroFamilyId: classified.parentMicroFamilyId || macro.microFamilyId,

      definitionParts: classificationDefinitionParts,
      definition: classificationDefinitionParts.length
        ? classificationDefinitionParts.join(' | ')
        : row.definition || classified.definition,

      parentDefinition: row.parentDefinition || classified.parentDefinition || macro.definition,
      parentDefinitionParts,

      schema: classified.schema,
      microFamilySchema: classified.schema,
      version: classified.version,

      side: outputSide,
      tradeSide: outputTradeSide,
      positionSide: outputTradeSide,
      direction: outputTradeSide,

      longOnly: true,
      shortDisabled: true,

      assetClass: classified.assetClass || row.assetClass,

      obRelation: classified.obRelation || row.obRelation,
      btcRelation: classified.btcRelation || row.btcRelation,
      btcState: classified.btcState || row.btcState,

      flow: classified.flow || row.flow,
      flowCoarse: classified.flowCoarse || row.flowCoarse,

      regime: classified.regime || row.regime,
      regimeCoarse: classified.regimeCoarse || row.regimeCoarse,

      scannerReason: classified.scannerReason || row.scannerReason,
      scannerReasonCoarse: classified.scannerReasonCoarse || row.scannerReasonCoarse,

      rsiZone: classified.rsiZone || row.rsiZone,
      rsiCoarse: classified.rsiCoarse || row.rsiCoarse,

      spreadBps: classified.spreadBps ?? row.spreadBps
    };
  }

  return {
    ...row,

    familyId: row.familyId || classified.familyId,

    microFamilyId: row.microFamilyId || classified.microFamilyId,
    trueMicroFamilyId: row.trueMicroFamilyId || row.microFamilyId || classified.microFamilyId,

    coarseMicroFamilyId: row.coarseMicroFamilyId || classified.coarseMicroFamilyId || null,
    baseMicroFamilyId: row.baseMicroFamilyId || classified.baseMicroFamilyId || null,
    legacyMicroFamilyId: row.legacyMicroFamilyId || classified.legacyMicroFamilyId || null,

    executionFingerprintHash: row.executionFingerprintHash || classified.executionFingerprintHash || null,
    executionFingerprintParts: row.executionFingerprintParts || classified.executionFingerprintParts || [],
    executionFingerprintSchema: row.executionFingerprintSchema || classified.executionFingerprintSchema || null,

    macroFamilyId: row.macroFamilyId || row.parentMacroFamilyId || classified.macroFamilyId || macro.microFamilyId,
    parentMacroFamilyId: row.parentMacroFamilyId || row.macroFamilyId || classified.parentMacroFamilyId || macro.microFamilyId,
    parentMicroFamilyId: row.parentMicroFamilyId || row.parentMacroFamilyId || row.macroFamilyId || classified.parentMicroFamilyId || macro.microFamilyId,

    definitionParts: classificationDefinitionParts,
    definition: classificationDefinitionParts.length
      ? classificationDefinitionParts.join(' | ')
      : row.definition || classified.definition,

    parentDefinition: row.parentDefinition || classified.parentDefinition || macro.definition,
    parentDefinitionParts,

    schema: row.schema || classified.schema,
    microFamilySchema: row.microFamilySchema || row.schema || classified.schema,
    version: row.version || classified.version,

    side: outputSide,
    tradeSide: outputTradeSide,
    positionSide: outputTradeSide,
    direction: outputTradeSide,

    longOnly: true,
    shortDisabled: true,

    assetClass: row.assetClass || classified.assetClass,

    obRelation: row.obRelation || classified.obRelation,
    btcRelation: row.btcRelation || classified.btcRelation,
    btcState: row.btcState || classified.btcState,

    flow: row.flow || classified.flow,
    flowCoarse: row.flowCoarse || classified.flowCoarse,

    regime: row.regime || classified.regime,
    regimeCoarse: row.regimeCoarse || classified.regimeCoarse,

    scannerReason: row.scannerReason || classified.scannerReason,
    scannerReasonCoarse: row.scannerReasonCoarse || classified.scannerReasonCoarse,

    rsiZone: row.rsiZone || classified.rsiZone,
    rsiCoarse: row.rsiCoarse || classified.rsiCoarse,

    spreadBps: row.spreadBps ?? classified.spreadBps
  };
}

function compactMicroForStorage(row = {}, aggressive = false) {
  const cfg = getWeekStorageConfig();
  const refreshed = refreshStats(removeKnownBulkyFields(row));

  const maxStringLength = aggressive
    ? Math.max(80, Math.floor(cfg.maxStringLength / 2))
    : cfg.maxStringLength;

  const definitionParts = compactDefinitionParts(
    refreshed.definitionParts,
    aggressive ? 32 : cfg.maxDefinitionPartsPerMicro,
    maxStringLength
  );

  const parentDefinitionParts = compactDefinitionParts(
    refreshed.parentDefinitionParts,
    aggressive ? 24 : cfg.maxParentDefinitionPartsPerMicro,
    maxStringLength
  );

  return {
    ...refreshed,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,

    definitionParts,
    definition: definitionParts.length
      ? definitionParts.join(' | ')
      : truncateString(refreshed.definition || '', maxStringLength * 4),

    parentDefinitionParts,
    parentDefinition: parentDefinitionParts.length
      ? parentDefinitionParts.join(' | ')
      : truncateString(refreshed.parentDefinition || '', maxStringLength * 4),

    counters: aggressive
      ? {}
      : compactCounters(
        refreshed.counters,
        cfg.maxCounterKeysPerMicro,
        cfg.maxCounterValuesPerCounter
      ),

    examples: compactExamples(
      refreshed.examples,
      aggressive ? Math.min(3, cfg.maxExamplesPerMicro) : cfg.maxExamplesPerMicro,
      maxStringLength
    ),

    recentOutcomes: compactRecentOutcomes(
      refreshed.recentOutcomes,
      aggressive ? Math.min(3, cfg.maxRecentOutcomesPerMicro) : cfg.maxRecentOutcomesPerMicro
    )
  };
}

function getMinimalMicroForStorage(row = {}) {
  const refreshed = refreshStats(removeKnownBulkyFields(row));

  return {
    microFamilyId: refreshed.microFamilyId,
    trueMicroFamilyId: refreshed.trueMicroFamilyId || refreshed.microFamilyId,

    coarseMicroFamilyId: refreshed.coarseMicroFamilyId || null,
    baseMicroFamilyId: refreshed.baseMicroFamilyId || null,
    legacyMicroFamilyId: refreshed.legacyMicroFamilyId || null,

    executionFingerprintHash: refreshed.executionFingerprintHash || null,
    executionFingerprintParts: refreshed.executionFingerprintParts || [],
    executionFingerprintSchema: refreshed.executionFingerprintSchema || null,

    familyId: refreshed.familyId,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,

    schema: refreshed.schema,
    microFamilySchema: refreshed.microFamilySchema,
    version: refreshed.version,

    macroFamilyId: refreshed.macroFamilyId,
    parentMacroFamilyId: refreshed.parentMacroFamilyId,
    parentMicroFamilyId: refreshed.parentMicroFamilyId,

    definitionParts: compactDefinitionParts(refreshed.definitionParts, 24, 180),
    definition: truncateString(refreshed.definition || '', 800),

    parentDefinitionParts: compactDefinitionParts(refreshed.parentDefinitionParts, 18, 180),
    parentDefinition: truncateString(refreshed.parentDefinition || '', 800),

    assetClass: refreshed.assetClass,

    obRelation: refreshed.obRelation,
    btcRelation: refreshed.btcRelation,
    btcState: refreshed.btcState,

    flow: refreshed.flow,
    flowCoarse: refreshed.flowCoarse,

    regime: refreshed.regime,
    regimeCoarse: refreshed.regimeCoarse,

    scannerReason: refreshed.scannerReason,
    scannerReasonCoarse: refreshed.scannerReasonCoarse,

    rsiZone: refreshed.rsiZone,
    rsiCoarse: refreshed.rsiCoarse,
    spreadBps: refreshed.spreadBps,

    seen: safeNumber(refreshed.seen, 0),
    observations: safeNumber(refreshed.observations, 0),

    completed: safeNumber(refreshed.completed, 0),
    realCompleted: safeNumber(refreshed.realCompleted, 0),
    shadowCompleted: safeNumber(refreshed.shadowCompleted, 0),

    wins: safeNumber(refreshed.wins, 0),
    losses: safeNumber(refreshed.losses, 0),
    flats: safeNumber(refreshed.flats, 0),

    realWins: safeNumber(refreshed.realWins, 0),
    realLosses: safeNumber(refreshed.realLosses, 0),
    realFlats: safeNumber(refreshed.realFlats, 0),

    shadowWins: safeNumber(refreshed.shadowWins, 0),
    shadowLosses: safeNumber(refreshed.shadowLosses, 0),
    shadowFlats: safeNumber(refreshed.shadowFlats, 0),

    winrate: safeNumber(refreshed.winrate, 0),
    bayesianWinrate: safeNumber(refreshed.bayesianWinrate, 0),
    wilsonLowerBound: safeNumber(refreshed.wilsonLowerBound, 0),
    fairWinrate: safeNumber(refreshed.fairWinrate, 0),

    totalR: safeNumber(refreshed.totalR, 0),
    realTotalR: safeNumber(refreshed.realTotalR, 0),
    shadowTotalR: safeNumber(refreshed.shadowTotalR, 0),

    avgR: safeNumber(refreshed.avgR, 0),
    avgWinR: safeNumber(refreshed.avgWinR, 0),
    avgLossR: safeNumber(refreshed.avgLossR, 0),

    profitFactor: safeNumber(refreshed.profitFactor, 0),

    directSLCount: safeNumber(refreshed.directSLCount, 0),
    directSLPct: safeNumber(refreshed.directSLPct, 0),

    nearTpCount: safeNumber(refreshed.nearTpCount, 0),
    nearTpPct: safeNumber(refreshed.nearTpPct, 0),

    reachedHalfRCount: safeNumber(refreshed.reachedHalfRCount, 0),
    reachedOneRCount: safeNumber(refreshed.reachedOneRCount, 0),
    reachedHalfRPct: safeNumber(refreshed.reachedHalfRPct, 0),
    reachedOneRPct: safeNumber(refreshed.reachedOneRPct, 0),

    beWouldExitCount: safeNumber(refreshed.beWouldExitCount, 0),
    beWouldExitPct: safeNumber(refreshed.beWouldExitPct, 0),

    gaveBackAfterHalfRCount: safeNumber(refreshed.gaveBackAfterHalfRCount, 0),
    gaveBackAfterOneRCount: safeNumber(refreshed.gaveBackAfterOneRCount, 0),
    gaveBackAfterHalfRPct: safeNumber(refreshed.gaveBackAfterHalfRPct, 0),
    gaveBackAfterOneRPct: safeNumber(refreshed.gaveBackAfterOneRPct, 0),

    nearTpThenLossCount: safeNumber(refreshed.nearTpThenLossCount, 0),
    nearTpThenLossPct: safeNumber(refreshed.nearTpThenLossPct, 0),

    totalCostR: safeNumber(refreshed.totalCostR, 0),
    avgCostR: safeNumber(refreshed.avgCostR, 0),

    sampleReliability: safeNumber(refreshed.sampleReliability, 0),
    balancedScore: safeNumber(refreshed.balancedScore, 0),

    examples: compactExamples(refreshed.examples, 2, 120),
    recentOutcomes: compactRecentOutcomes(refreshed.recentOutcomes, 2),

    createdAt: refreshed.createdAt || null,
    updatedAt: refreshed.updatedAt || now()
  };
}

function getOrCreateMicro(micros, classified, side) {
  if (!classified) {
    throw new Error('CLASSIFIED_MICRO_REQUIRED');
  }

  const microFamilyId = classified.microFamilyId;
  const familyId = classified.familyId;

  if (!microFamilyId) {
    throw new Error('MICRO_FAMILY_ID_MISSING');
  }

  if (!familyId) {
    throw new Error('FAMILY_ID_MISSING');
  }

  const normalizedSide = normalizeStatsSide(side, classified);

  if (!micros[microFamilyId]) {
    micros[microFamilyId] = createMicroStats({
      microFamilyId,
      familyId,
      side: normalizedSide,
      definitionParts: classified.definitionParts || []
    });
  }

  const micro = micros[microFamilyId];

  micro.microFamilyId ||= microFamilyId;
  micro.trueMicroFamilyId ||= microFamilyId;
  micro.familyId ||= familyId;

  micro.coarseMicroFamilyId ||= classified.coarseMicroFamilyId || null;
  micro.baseMicroFamilyId ||= classified.baseMicroFamilyId || null;
  micro.legacyMicroFamilyId ||= classified.legacyMicroFamilyId || null;

  micro.executionFingerprintHash ||= classified.executionFingerprintHash || null;
  micro.executionFingerprintParts ||= classified.executionFingerprintParts || [];
  micro.executionFingerprintSchema ||= classified.executionFingerprintSchema || null;

  micro.side = TARGET_DASHBOARD_SIDE;
  micro.tradeSide = TARGET_TRADE_SIDE;
  micro.positionSide = TARGET_TRADE_SIDE;
  micro.direction = TARGET_TRADE_SIDE;

  micro.longOnly = true;
  micro.shortDisabled = true;

  micro.schema ||= classified.schema || classified.microFamilySchema || getAnalyzeSchemaMeta().microSchema;
  micro.microFamilySchema ||= classified.microFamilySchema || classified.schema || getAnalyzeSchemaMeta().microSchema;
  micro.version ||= classified.version || 'micro';

  micro.macroFamilyId ||= classified.macroFamilyId || classified.parentMacroFamilyId || null;
  micro.parentMacroFamilyId ||= classified.parentMacroFamilyId || classified.macroFamilyId || null;
  micro.parentMicroFamilyId ||= classified.parentMicroFamilyId || classified.parentMacroFamilyId || classified.macroFamilyId || null;

  micro.parentDefinition ||= classified.parentDefinition || '';
  micro.parentDefinitionParts ||= classified.parentDefinitionParts || [];

  micro.definitionParts = mergeDefinitionParts(
    micro.definitionParts || [],
    classified.definitionParts || []
  );

  micro.definition = micro.definitionParts.length
    ? micro.definitionParts.join(' | ')
    : classified.definition || '';

  micro.assetClass ||= classified.assetClass || null;

  micro.obRelation ||= classified.obRelation || null;
  micro.btcRelation ||= classified.btcRelation || null;
  micro.btcState ||= classified.btcState || null;

  micro.flow ||= classified.flow || null;
  micro.flowCoarse ||= classified.flowCoarse || null;

  micro.regime ||= classified.regime || null;
  micro.regimeCoarse ||= classified.regimeCoarse || null;

  micro.scannerReason ||= classified.scannerReason || null;
  micro.scannerReasonCoarse ||= classified.scannerReasonCoarse || null;

  micro.rsiZone ||= classified.rsiZone || null;
  micro.rsiCoarse ||= classified.rsiCoarse || null;

  if (classified.spreadBps !== undefined && micro.spreadBps === undefined) {
    micro.spreadBps = classified.spreadBps;
  }

  return micro;
}

function normalizeMicros(micros = {}) {
  return Object.fromEntries(
    Object.entries(micros || {})
      .filter(([id, row]) => id && row && isTargetOnlyRow(row))
      .map(([id, row]) => {
        const microFamilyId = row.microFamilyId || id;

        return [
          microFamilyId,
          compactMicroForStorage({
            ...row,
            microFamilyId,
            trueMicroFamilyId: row.trueMicroFamilyId || microFamilyId,
            side: TARGET_DASHBOARD_SIDE,
            tradeSide: TARGET_TRADE_SIDE,
            positionSide: TARGET_TRADE_SIDE,
            direction: TARGET_TRADE_SIDE,
            longOnly: true,
            shortDisabled: true
          })
        ];
      })
  );
}

function maybeParseJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function decodeCompressedBase64(data) {
  const buffer = Buffer.from(data, 'base64');
  const json = gunzipSync(buffer).toString('utf8');

  return JSON.parse(json);
}

function decodeStoragePayload(payload) {
  const parsed = maybeParseJson(payload);

  if (!parsed) return {};

  if (
    typeof parsed === 'object' &&
    [WEEK_MICROS_CODEC, WEEK_MICRO_ROW_CODEC, WEEK_MICROS_TOP_CODEC].includes(parsed.codec) &&
    typeof parsed.data === 'string'
  ) {
    return decodeCompressedBase64(parsed.data);
  }

  if (
    typeof parsed === 'object' &&
    parsed.__compressed === true &&
    parsed.codec === 'gzip-base64' &&
    typeof parsed.data === 'string'
  ) {
    return decodeCompressedBase64(parsed.data);
  }

  if (typeof parsed === 'object') {
    return parsed;
  }

  throw new Error('STORAGE_PAYLOAD_UNREADABLE');
}

function encodeStoragePayload(value = {}, {
  codec,
  maxBytes,
  count,
  extraMeta = {}
} = {}) {
  const cfg = getWeekStorageConfig();
  const schemaMeta = getAnalyzeSchemaMeta();

  const json = JSON.stringify(value || {});
  const rawBytes = Buffer.byteLength(json, 'utf8');

  if (!cfg.compressionEnabled) {
    if (rawBytes > maxBytes) {
      const error = new Error('STORAGE_RAW_PAYLOAD_TOO_LARGE');
      error.details = {
        rawBytes,
        maxBytes,
        count
      };
      throw error;
    }

    return {
      payload: json,
      meta: {
        compressed: false,
        codec: 'json',
        rawBytes,
        payloadBytes: rawBytes,
        count,
        ...extraMeta
      }
    };
  }

  const compressed = gzipSync(Buffer.from(json, 'utf8'), {
    level: cfg.compressionLevel
  });

  const wrapper = {
    codec,
    compressed: true,

    rawBytes,
    compressedBytes: compressed.length,

    count,

    schema: schemaMeta.schema,
    macroSchema: schemaMeta.macroSchema,
    microSchema: schemaMeta.microSchema,
    strategyVersion: schemaMeta.strategyVersion,

    encodedAt: now(),
    data: compressed.toString('base64'),

    ...extraMeta
  };

  const payload = JSON.stringify(wrapper);
  const payloadBytes = Buffer.byteLength(payload, 'utf8');

  if (payloadBytes > maxBytes) {
    const error = new Error('STORAGE_COMPRESSED_PAYLOAD_TOO_LARGE');
    error.details = {
      rawBytes,
      compressedBytes: compressed.length,
      payloadBytes,
      maxBytes,
      count,
      codec
    };
    throw error;
  }

  return {
    payload,
    meta: {
      compressed: true,
      codec,
      rawBytes,
      compressedBytes: compressed.length,
      payloadBytes,
      count,
      ...extraMeta
    }
  };
}

function encodeMicroRowPayload(row = {}) {
  const cfg = getWeekStorageConfig();

  try {
    return encodeStoragePayload(row, {
      codec: WEEK_MICRO_ROW_CODEC,
      maxBytes: cfg.maxRowSetBytes,
      count: 1,
      extraMeta: {
        microFamilyId: row.microFamilyId || null,
        rowMode: 'compact'
      }
    });
  } catch (firstError) {
    const aggressive = compactMicroForStorage(row, true);

    try {
      return encodeStoragePayload(aggressive, {
        codec: WEEK_MICRO_ROW_CODEC,
        maxBytes: cfg.maxRowSetBytes,
        count: 1,
        extraMeta: {
          microFamilyId: row.microFamilyId || null,
          rowMode: 'aggressive'
        }
      });
    } catch {
      const minimal = getMinimalMicroForStorage(row);

      return encodeStoragePayload(minimal, {
        codec: WEEK_MICRO_ROW_CODEC,
        maxBytes: cfg.maxRowSetBytes,
        count: 1,
        extraMeta: {
          microFamilyId: row.microFamilyId || null,
          rowMode: 'minimal',
          previousError: firstError?.message || null
        }
      });
    }
  }
}

function encodeLegacyWeekMicrosPayload(micros = {}) {
  const cfg = getWeekStorageConfig();

  return encodeStoragePayload(micros, {
    codec: WEEK_MICROS_CODEC,
    maxBytes: cfg.maxRedisSetBytes,
    count: Object.keys(micros || {}).length,
    extraMeta: {
      storageMode: 'legacy-single-key'
    }
  });
}

async function redisSetRawWithTtl(redis, key, value, ttlSec) {
  const ttl = Math.max(1, Math.floor(safeNumber(ttlSec, 1)));

  try {
    return await redis.set(key, value, { ex: ttl });
  } catch (errorA) {
    try {
      return await redis.set(key, value, { EX: ttl });
    } catch (errorB) {
      try {
        return await redis.set(key, value, 'EX', ttl);
      } catch {
        throw errorA || errorB;
      }
    }
  }
}

async function withSoftTimeout(promise, timeoutMs, fallbackValue = null) {
  let timer = null;

  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallbackValue), timeoutMs);
  });

  return Promise
    .race([
      promise.catch(() => fallbackValue),
      timeout
    ])
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

async function getRawRedisValue(redis, key, fallback = null) {
  const direct = await redis.get(key).catch(() => undefined);

  if (direct !== undefined && direct !== null) return direct;

  return getJson(redis, key, fallback);
}

async function getWeekMicrosIndex(redis, weekKey) {
  return getJson(
    redis,
    getWeekMicrosIndexKey(weekKey),
    null
  ).catch(() => null);
}

async function hasWeekMicrosIndex(redis, weekKey) {
  const index = await getWeekMicrosIndex(redis, weekKey);

  return Boolean(index && Array.isArray(index.ids));
}

function rowToObjectEntries(rows) {
  if (!rows) return {};

  if (Array.isArray(rows)) {
    return Object.fromEntries(
      rows
        .filter(Boolean)
        .map((row) => [
          row.microFamilyId || row.trueMicroFamilyId || row.id || row.key,
          row
        ])
        .filter(([id]) => Boolean(id))
    );
  }

  if (typeof rows === 'object') return rows;

  return {};
}

function compareTopMicros(a = {}, b = {}) {
  const ar = refreshStats(a);
  const br = refreshStats(b);

  return (
    safeNumber(br.dashboardBalancedScore ?? br.balancedScore, 0) -
    safeNumber(ar.dashboardBalancedScore ?? ar.balancedScore, 0) ||

    safeNumber(br.balancedScore, 0) -
    safeNumber(ar.balancedScore, 0) ||

    safeNumber(br.totalR, 0) -
    safeNumber(ar.totalR, 0) ||

    safeNumber(br.avgR, 0) -
    safeNumber(ar.avgR, 0) ||

    safeNumber(br.sampleAdjustedWinrate ?? br.fairWinrate ?? br.wilsonLowerBound, 0) -
    safeNumber(ar.sampleAdjustedWinrate ?? ar.fairWinrate ?? ar.wilsonLowerBound, 0) ||

    safeNumber(br.completed, 0) -
    safeNumber(ar.completed, 0) ||

    safeNumber(br.seen ?? br.observations, 0) -
    safeNumber(ar.seen ?? ar.observations, 0) ||

    String(ar.microFamilyId || '').localeCompare(String(br.microFamilyId || ''))
  );
}

function selectTopMicrosObject(micros = {}, limit = DEFAULT_TOP_MICROS_SNAPSHOT_LIMIT) {
  const safeLimit = Math.max(1, Math.floor(safeNumber(limit, DEFAULT_TOP_MICROS_SNAPSHOT_LIMIT)));

  const normalized = normalizeMicros(micros);

  return Object.fromEntries(
    Object.values(normalized)
      .filter(Boolean)
      .filter(isTargetOnlyRow)
      .sort(compareTopMicros)
      .slice(0, safeLimit)
      .map((row) => [
        row.microFamilyId,
        row
      ])
      .filter(([id]) => Boolean(id))
  );
}

async function readWeekMicrosTopSnapshot(redis, weekKey) {
  const raw = await getRawRedisValue(
    redis,
    getWeekMicrosTopKey(weekKey),
    null
  ).catch(() => null);

  if (!raw) return null;

  const decoded = decodeStoragePayload(raw);
  const rows = decoded?.rows || decoded?.micros || decoded;

  return normalizeMicros(rowToObjectEntries(rows));
}

async function saveWeekMicrosTopSnapshot(redis, weekKey, micros = {}, {
  mergeExisting = true
} = {}) {
  const cfg = getWeekStorageConfig();
  const schemaMeta = getAnalyzeSchemaMeta();

  const currentTop = mergeExisting
    ? await readWeekMicrosTopSnapshot(redis, weekKey).catch(() => ({}))
    : {};

  const merged = {
    ...(currentTop || {}),
    ...normalizeMicros(micros)
  };

  const topMicros = selectTopMicrosObject(
    merged,
    cfg.topMicrosSnapshotLimit
  );

  const ids = Object.keys(topMicros);

  const encoded = encodeStoragePayload(
    {
      weekKey,
      ids,
      count: ids.length,
      rows: topMicros,

      longOnly: true,
      shortDisabled: true,

      storageMode: 'TOP_MICROS_SNAPSHOT',
      codec: WEEK_MICROS_TOP_CODEC,

      executionMicroRefined: shouldRefineExecutionMicroIds(),
      executionMicroSuffix: EXECUTION_MICRO_SUFFIX,

      schema: schemaMeta.schema,
      macroSchema: schemaMeta.macroSchema,
      microSchema: schemaMeta.microSchema,
      strategyVersion: schemaMeta.strategyVersion,

      updatedAt: now()
    },
    {
      codec: WEEK_MICROS_TOP_CODEC,
      maxBytes: cfg.maxRedisSetBytes,
      count: ids.length,
      extraMeta: {
        storageMode: 'top-micros-snapshot'
      }
    }
  );

  await redisSetRawWithTtl(
    redis,
    getWeekMicrosTopKey(weekKey),
    encoded.payload,
    cfg.weekMicrosTtlSec
  );

  return {
    ids,
    count: ids.length,
    payloadBytes: encoded.meta.payloadBytes,
    rawBytes: encoded.meta.rawBytes,
    compressedBytes: encoded.meta.compressedBytes || 0
  };
}

async function readWeekMicroRowsByIds(redis, weekKey, ids = []) {
  const cfg = getWeekStorageConfig();
  const safeIds = uniqueStrings(ids);

  if (!safeIds.length) return {};

  const entries = await mapLimit(
    safeIds,
    cfg.storageConcurrency,
    async (id) => {
      const raw = await getRawRedisValue(
        redis,
        getWeekMicroRowKey(weekKey, id),
        null
      ).catch(() => null);

      if (!raw) return null;

      const row = decodeStoragePayload(raw);

      if (!row || !isTargetOnlyRow(row)) return null;

      return [
        row.microFamilyId || id,
        row
      ];
    }
  );

  return Object.fromEntries(entries.filter(Boolean));
}

async function readWeekMicrosSharded(redis, weekKey) {
  const cfg = getWeekStorageConfig();
  const index = await getWeekMicrosIndex(redis, weekKey);

  if (!index || !Array.isArray(index.ids)) {
    return null;
  }

  const ids = index.ids
    .filter(Boolean)
    .filter((id) => sideTextToTradeSide(id) === TARGET_TRADE_SIDE);

  if (!ids.length) return {};

  if (
    cfg.preferTopSnapshotOnLargeIndex &&
    ids.length > cfg.maxFullReadMicroRows
  ) {
    const top = await readWeekMicrosTopSnapshot(redis, weekKey).catch(() => null);

    if (top && Object.keys(top).length > 0) return top;

    return readWeekMicroRowsByIds(
      redis,
      weekKey,
      ids.slice(0, cfg.maxFullReadMicroRows)
    );
  }

  return readWeekMicroRowsByIds(redis, weekKey, ids);
}

async function getWeekMicrosByIds(weekKey, ids = []) {
  const redis = getDurableRedis();
  const safeIds = uniqueStrings(ids)
    .filter((id) => sideTextToTradeSide(id) === TARGET_TRADE_SIDE);

  if (!safeIds.length) return {};

  const index = await getWeekMicrosIndex(redis, weekKey);

  if (index && Array.isArray(index.ids)) {
    const indexedIds = new Set(index.ids || []);
    const existingIds = safeIds.filter((id) => indexedIds.has(id));

    return normalizeMicros(
      await readWeekMicroRowsByIds(redis, weekKey, existingIds)
    );
  }

  const top = await readWeekMicrosTopSnapshot(redis, weekKey).catch(() => null);

  if (top && Object.keys(top).length > 0) {
    const normalizedTop = normalizeMicros(top);

    return Object.fromEntries(
      safeIds
        .filter((id) => normalizedTop[id])
        .map((id) => [id, normalizedTop[id]])
    );
  }

  const raw = await getRawRedisValue(
    redis,
    getWeekMicrosBaseKey(weekKey),
    null
  );

  if (!raw) return {};

  const decoded = decodeStoragePayload(raw);
  const normalized = normalizeMicros(decoded || {});

  return Object.fromEntries(
    safeIds
      .filter((id) => normalized[id])
      .map((id) => [id, normalized[id]])
  );
}

async function saveWeekMicrosSharded(redis, weekKey, micros, {
  onlyIds = null
} = {}) {
  const cfg = getWeekStorageConfig();

  const cleanIds = Object.keys(micros || {})
    .filter(Boolean)
    .filter((id) => sideTextToTradeSide(id) === TARGET_TRADE_SIDE)
    .sort();

  const writeIds = onlyIds
    ? uniqueStrings(onlyIds)
      .filter((id) => sideTextToTradeSide(id) === TARGET_TRADE_SIDE)
      .filter((id) => micros[id])
    : cleanIds;

  const fullSave = !onlyIds;

  const rowMeta = await mapLimit(
    writeIds,
    cfg.storageConcurrency,
    async (id) => {
      const row = {
        ...micros[id],
        microFamilyId: micros[id]?.microFamilyId || id,
        trueMicroFamilyId: micros[id]?.trueMicroFamilyId || micros[id]?.microFamilyId || id,
        side: TARGET_DASHBOARD_SIDE,
        tradeSide: TARGET_TRADE_SIDE,
        positionSide: TARGET_TRADE_SIDE,
        direction: TARGET_TRADE_SIDE,
        longOnly: true,
        shortDisabled: true
      };

      const encoded = encodeMicroRowPayload(row);

      await redisSetRawWithTtl(
        redis,
        getWeekMicroRowKey(weekKey, id),
        encoded.payload,
        cfg.weekMicrosTtlSec
      );

      return {
        id,
        bytes: encoded.meta.payloadBytes,
        rawBytes: encoded.meta.rawBytes,
        compressedBytes: encoded.meta.compressedBytes || 0,
        rowMode: encoded.meta.rowMode || 'json'
      };
    }
  );

  const existingIndex = await getWeekMicrosIndex(redis, weekKey);
  const existingIds = Array.isArray(existingIndex?.ids)
    ? existingIndex.ids.filter((id) => sideTextToTradeSide(id) === TARGET_TRADE_SIDE)
    : [];

  const ids = fullSave
    ? cleanIds
    : uniqueStrings([...existingIds, ...writeIds]).sort();

  const totalPayloadBytes = rowMeta.reduce(
    (sum, row) => sum + safeNumber(row.bytes, 0),
    0
  );

  const totalRawBytes = rowMeta.reduce(
    (sum, row) => sum + safeNumber(row.rawBytes, 0),
    0
  );

  const maxRowBytes = rowMeta.reduce(
    (max, row) => Math.max(max, safeNumber(row.bytes, 0)),
    0
  );

  const schemaMeta = getAnalyzeSchemaMeta();

  await setJson(
    redis,
    getWeekMicrosIndexKey(weekKey),
    {
      weekKey,
      ids,
      count: ids.length,

      storageMode: 'SHARDED_COMPRESSED_ROWS',
      codec: WEEK_MICRO_ROW_CODEC,

      longOnly: true,
      shortDisabled: true,

      executionMicroRefined: shouldRefineExecutionMicroIds(),
      executionMicroSuffix: EXECUTION_MICRO_SUFFIX,

      lastWriteMode: fullSave ? 'FULL' : 'PARTIAL',
      lastWrittenCount: writeIds.length,

      totalPayloadBytes,
      totalRawBytes,
      maxRowBytes,

      updatedAt: now(),

      schema: schemaMeta.schema,
      macroSchema: schemaMeta.macroSchema,
      microSchema: schemaMeta.microSchema,
      strategyVersion: schemaMeta.strategyVersion
    },
    {
      ex: cfg.weekMicrosTtlSec
    }
  );

  const topInput = Object.fromEntries(
    writeIds
      .filter((id) => micros[id])
      .map((id) => [id, micros[id]])
  );

  await saveWeekMicrosTopSnapshot(
    redis,
    weekKey,
    fullSave ? micros : topInput,
    {
      mergeExisting: !fullSave
    }
  ).catch(() => null);

  await redis.del(getWeekMicrosBaseKey(weekKey)).catch(() => null);

  return {
    ids,
    writtenIds: writeIds,
    rowMeta,
    totalPayloadBytes,
    totalRawBytes,
    maxRowBytes,
    fullSave
  };
}

export async function getWeekMicros(weekKey = getIsoWeekKey()) {
  const redis = getDurableRedis();
  const cfg = getWeekStorageConfig();

  const sharded = await withSoftTimeout(
    readWeekMicrosSharded(redis, weekKey),
    cfg.fullReadSoftTimeoutMs,
    null
  );

  if (sharded !== null) {
    return normalizeMicros(sharded || {});
  }

  const top = await readWeekMicrosTopSnapshot(redis, weekKey).catch(() => null);

  if (top && Object.keys(top).length > 0) {
    return normalizeMicros(top);
  }

  const raw = await withSoftTimeout(
    getRawRedisValue(
      redis,
      getWeekMicrosBaseKey(weekKey),
      null
    ),
    cfg.fullReadSoftTimeoutMs,
    null
  );

  if (!raw) return {};

  const decoded = decodeStoragePayload(raw);
  const normalized = normalizeMicros(decoded || {});

  if (Object.keys(normalized).length > 0) {
    await saveWeekMicrosTopSnapshot(
      redis,
      weekKey,
      normalized,
      {
        mergeExisting: false
      }
    ).catch(() => null);
  }

  return normalized;
}

export async function getWeekTopMicros(weekKey = getIsoWeekKey(), {
  limit = 25
} = {}) {
  const redis = getDurableRedis();
  const top = await readWeekMicrosTopSnapshot(redis, weekKey).catch(() => null);

  if (top && Object.keys(top).length > 0) {
    return selectTopMicrosObject(top, limit);
  }

  return selectTopMicrosObject(
    await getWeekMicros(weekKey),
    limit
  );
}

export async function saveWeekMicros(
  weekKey,
  micros,
  {
    onlyIds = null
  } = {}
) {
  if (!weekKey) {
    throw new Error('WEEK_KEY_MISSING');
  }

  const redis = getDurableRedis();
  const cfg = getWeekStorageConfig();
  const clean = normalizeMicros(micros);
  const schemaMeta = getAnalyzeSchemaMeta();

  let storage;
  let topStorage = null;

  try {
    storage = await saveWeekMicrosSharded(
      redis,
      weekKey,
      clean,
      {
        onlyIds
      }
    );

    topStorage = await readWeekMicrosTopSnapshot(redis, weekKey)
      .then((rows) => ({
        count: Object.keys(rows || {}).length
      }))
      .catch(() => null);
  } catch (error) {
    if (onlyIds) {
      throw error;
    }

    const legacy = encodeLegacyWeekMicrosPayload(clean);

    await redisSetRawWithTtl(
      redis,
      getWeekMicrosBaseKey(weekKey),
      legacy.payload,
      cfg.weekMicrosTtlSec
    );

    topStorage = await saveWeekMicrosTopSnapshot(
      redis,
      weekKey,
      clean,
      {
        mergeExisting: false
      }
    ).catch(() => null);

    storage = {
      ids: Object.keys(clean),
      writtenIds: Object.keys(clean),
      fallbackToLegacy: true,
      fallbackReason: error?.message || String(error),
      totalPayloadBytes: legacy.meta.payloadBytes,
      totalRawBytes: legacy.meta.rawBytes,
      maxRowBytes: 0,
      fullSave: true
    };
  }

  await setJson(
    redis,
    KEYS.analyze.weekMeta(weekKey),
    {
      weekKey,
      updatedAt: now(),
      microFamilies: storage.ids.length,

      longOnly: true,
      shortDisabled: true,
      executionMicroRefined: shouldRefineExecutionMicroIds(),
      executionMicroSuffix: EXECUTION_MICRO_SUFFIX,

      schema: schemaMeta.schema,
      macroSchema: schemaMeta.macroSchema,
      microSchema: schemaMeta.microSchema,
      strategyVersion: schemaMeta.strategyVersion,

      storage: {
        storageMode: storage.fallbackToLegacy
          ? 'LEGACY_COMPRESSED_SINGLE_KEY_FALLBACK'
          : 'SHARDED_COMPRESSED_ROWS',

        codec: storage.fallbackToLegacy
          ? WEEK_MICROS_CODEC
          : WEEK_MICRO_ROW_CODEC,

        count: storage.ids.length,
        writtenCount: storage.writtenIds?.length || 0,
        fullSave: Boolean(storage.fullSave),

        totalPayloadBytes: storage.totalPayloadBytes,
        totalRawBytes: storage.totalRawBytes,
        maxRowBytes: storage.maxRowBytes,

        fallbackToLegacy: Boolean(storage.fallbackToLegacy),
        fallbackReason: storage.fallbackReason || null,

        topSnapshot: {
          enabled: true,
          codec: WEEK_MICROS_TOP_CODEC,
          limit: cfg.topMicrosSnapshotLimit,
          count: topStorage?.count ?? topStorage?.ids?.length ?? null
        },

        ttlSec: cfg.weekMicrosTtlSec
      }
    },
    {
      ex: cfg.weekMetaTtlSec
    }
  );

  return clean;
}

function buildAnalyzeVariants(metrics = {}) {
  const primary = enrichWithMicroFamily(metrics);

  if (!primary) {
    return {
      primary: null,
      mirrors: []
    };
  }

  return {
    primary,
    mirrors: []
  };
}

export async function analyzeCandidatesBatch(
  metricsRows = [],
  { weekKey = getIsoWeekKey() } = {}
) {
  const rows = Array.isArray(metricsRows)
    ? metricsRows.filter(Boolean).filter((row) => isTargetOnlyRow(row))
    : [];

  if (rows.length === 0) {
    return [];
  }

  const redis = getDurableRedis();

  const variantRows = rows
    .map((metrics) => ({
      metrics,
      ...buildAnalyzeVariants(metrics)
    }))
    .filter((row) => row.primary);

  if (variantRows.length === 0) {
    return [];
  }

  const allClassifiedRows = variantRows.flatMap((row) => [
    row.primary,
    ...row.mirrors
  ]).filter(Boolean);

  const touchedIds = uniqueStrings(
    allClassifiedRows.map((row) => row.microFamilyId)
  );

  if (touchedIds.length === 0) {
    return [];
  }

  const partialMode = await hasWeekMicrosIndex(redis, weekKey);

  const micros = partialMode
    ? await getWeekMicrosByIds(weekKey, touchedIds)
    : await getWeekMicros(weekKey);

  const analyzed = [];
  const actuallyTouchedIds = new Set();

  for (const batch of variantRows) {
    const processRows = [
      {
        row: batch.primary,
        returnToCaller: true
      }
    ];

    for (const item of processRows) {
      const classified = item.row;

      if (!classified || !classified.microFamilyId) continue;

      const obsKey = KEYS.analyze.obsLast(
        batch.metrics.snapshotId || 'NO_SNAPSHOT',
        batch.metrics.symbol || batch.metrics.contractSymbol || 'UNKNOWN',
        classified.microFamilyId
      );

      const firstObservation = await redis.set(obsKey, '1', {
        nx: true,
        ex: CONFIG.analyze.obsDedupeTtlSec
      });

      const micro = getOrCreateMicro(
        micros,
        classified,
        TARGET_DASHBOARD_SIDE
      );

      if (firstObservation) {
        updateObservation(micro, {
          ...batch.metrics,
          ...classified,
          side: TARGET_DASHBOARD_SIDE,
          tradeSide: TARGET_TRADE_SIDE,
          positionSide: TARGET_TRADE_SIDE,
          direction: TARGET_TRADE_SIDE,
          longOnly: true,
          shortDisabled: true,
          weekKey,
          strategyVersion: CONFIG.strategyVersion,
          createdAt: batch.metrics.createdAt || now()
        });

        actuallyTouchedIds.add(classified.microFamilyId);
      }

      if (item.returnToCaller) {
        analyzed.push({
          ...batch.metrics,
          ...classified,
          side: TARGET_DASHBOARD_SIDE,
          tradeSide: TARGET_TRADE_SIDE,
          positionSide: TARGET_TRADE_SIDE,
          direction: TARGET_TRADE_SIDE,
          longOnly: true,
          shortDisabled: true,
          analysisType: 'OBSERVATION',
          observationRecorded: Boolean(firstObservation),
          mirrorMicroFamiliesCreated: 0,
          mirrorMicroFamilyIds: [],
          weekKey,
          strategyVersion: CONFIG.strategyVersion
        });
      }
    }
  }

  if (actuallyTouchedIds.size > 0) {
    await saveWeekMicros(
      weekKey,
      micros,
      partialMode
        ? { onlyIds: [...actuallyTouchedIds] }
        : {}
    );
  }

  return analyzed;
}

function buildMirroredOutcome() {
  return null;
}

export async function recordOutcome(
  outcome = {},
  {
    source = outcome.source || 'REAL',
    weekKey = getIsoWeekKey(outcome.closedAt || outcome.completedAt || now())
  } = {}
) {
  if (!isTargetOnlyRow(outcome)) {
    return {
      ...outcome,
      source: normalizeSource(source),
      weekKey,
      skipped: true,
      reason: 'LONG_ONLY_OUTCOME_SKIPPED',
      recordedAt: now(),
      mirrorOutcomeRecorded: false,
      mirrorMicroFamilyId: null
    };
  }

  const src = normalizeSource(source);

  const row = enrichWithMicroFamily({
    ...outcome,
    source: src,
    weekKey,
    strategyVersion: CONFIG.strategyVersion
  });

  if (!row) {
    return {
      ...outcome,
      source: src,
      weekKey,
      skipped: true,
      reason: 'LONG_ONLY_CLASSIFICATION_SKIPPED',
      recordedAt: now(),
      mirrorOutcomeRecorded: false,
      mirrorMicroFamilyId: null
    };
  }

  const mirrorOutcome = buildMirroredOutcome(row);

  const touchedIds = uniqueStrings([
    row.microFamilyId,
    mirrorOutcome?.microFamilyId
  ]);

  const redis = getDurableRedis();
  const partialMode = await hasWeekMicrosIndex(redis, weekKey);

  const micros = partialMode
    ? await getWeekMicrosByIds(weekKey, touchedIds)
    : await getWeekMicros(weekKey);

  const micro = getOrCreateMicro(
    micros,
    row,
    TARGET_DASHBOARD_SIDE
  );

  updateOutcome(micro, {
    ...row,
    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,
    longOnly: true,
    shortDisabled: true
  }, src);

  await saveWeekMicros(
    weekKey,
    micros,
    partialMode
      ? { onlyIds: touchedIds }
      : {}
  );

  return {
    ...row,
    source: src,
    weekKey,
    recordedAt: now(),
    mirrorOutcomeRecorded: false,
    mirrorMicroFamilyId: null
  };
}

export async function createShadowPosition(metrics = {}) {
  if (!CONFIG.analyze.shadowEnabled) {
    return {
      ok: false,
      skipped: true,
      reason: 'SHADOW_DISABLED'
    };
  }

  if (!isTargetOnlyRow(metrics)) {
    return {
      ok: false,
      skipped: true,
      reason: 'LONG_ONLY_SHADOW_SKIPPED'
    };
  }

  const classified = enrichWithMicroFamily(metrics);

  if (!classified?.microFamilyId) {
    return {
      ok: false,
      skipped: true,
      reason: 'MICRO_MISSING'
    };
  }

  if (!classified.entry || !classified.sl || !classified.tp) {
    return {
      ok: false,
      skipped: true,
      reason: 'RISK_MISSING'
    };
  }

  const redis = getDurableRedis();

  const dedupeKey = KEYS.analyze.shadowLast(
    classified.symbol || classified.contractSymbol || 'UNKNOWN',
    classified.microFamilyId
  );

  const first = await redis.set(dedupeKey, '1', {
    nx: true,
    ex: CONFIG.analyze.shadowDedupeTtlSec
  });

  if (!first) {
    return {
      ok: false,
      skipped: true,
      reason: 'SHADOW_DEDUPED'
    };
  }

  const id = randomId('shadow');
  const createdAt = now();

  const row = {
    ...classified,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,

    id,
    source: 'SHADOW',
    status: 'OPEN',

    strategyVersion: CONFIG.strategyVersion,

    createdAt,
    monitorUntil: createdAt + CONFIG.analyze.shadowHorizonMin * 60 * 1000,

    ticks: 0,
    maxPnlPct: 0,
    minPnlPct: 0,
    mfeR: 0,
    maeR: 0,

    beArmed: false,
    beWouldExit: false,
    beExitR: 0,

    gaveBackAfterHalfR: false,
    gaveBackAfterOneR: false,
    nearTpThenLoss: false
  };

  await setJson(
    redis,
    KEYS.analyze.shadowOpen(id),
    row,
    {
      ex: Math.ceil(CONFIG.analyze.shadowHorizonMin * 60 * 1.2)
    }
  );

  return {
    ok: true,
    shadowId: id,
    microFamilyId: row.microFamilyId,
    macroFamilyId: row.parentMacroFamilyId || row.macroFamilyId || null
  };
}

function calcGrossMovePct({ side, entry, exit }) {
  if (entry <= 0 || exit <= 0) return 0;

  return isLongSide(side)
    ? (exit - entry) / entry
    : (entry - exit) / entry;
}

function calcRiskPct({ entry, sl }) {
  if (entry <= 0 || sl <= 0) return 0;

  return Math.abs(entry - sl) / entry;
}

function inferDirectToSL({ position, exitReason }) {
  const reason = String(exitReason || '').toUpperCase();

  const mfeR = safeNumber(position.mfeR, 0);
  const maeR = safeNumber(position.maeR, 0);

  const stoppedOut = [
    'SL',
    'HIT_SL',
    'STOP',
    'STOP_LOSS',
    'STOPLOSS'
  ].includes(reason);

  return Boolean(position.directToSL) ||
    (
      stoppedOut &&
      mfeR < 0.25 &&
      maeR <= -0.8
    );
}

function copyMicroClassificationFields(position = {}) {
  return {
    familyId: position.familyId,
    microFamilyId: position.microFamilyId,
    trueMicroFamilyId: position.trueMicroFamilyId || position.microFamilyId,

    coarseMicroFamilyId: position.coarseMicroFamilyId || null,
    baseMicroFamilyId: position.baseMicroFamilyId || null,
    legacyMicroFamilyId: position.legacyMicroFamilyId || null,

    executionFingerprintHash: position.executionFingerprintHash || null,
    executionFingerprintParts: position.executionFingerprintParts || [],
    executionFingerprintSchema: position.executionFingerprintSchema || null,

    macroFamilyId: position.macroFamilyId,
    parentMacroFamilyId: position.parentMacroFamilyId,
    parentMicroFamilyId: position.parentMicroFamilyId,

    definitionParts: position.definitionParts || [],
    definition: position.definition || null,

    parentDefinition: position.parentDefinition || null,
    parentDefinitionParts: position.parentDefinitionParts || [],

    schema: position.schema || position.microFamilySchema || null,
    microFamilySchema: position.microFamilySchema || position.schema || null,
    version: position.version || null,

    assetClass: position.assetClass || null,

    rsiZone: position.rsiZone || null,
    rsiCoarse: position.rsiCoarse || null,
    rsiSlope: position.rsiSlope ?? null,
    rsiVelocity: position.rsiVelocity ?? null,
    rsiDelta: position.rsiDelta ?? null,
    rsiMomentum: position.rsiMomentum ?? null,

    obRelation: position.obRelation || null,
    obBias: position.obBias ?? null,
    obImbalance: position.obImbalance ?? null,
    orderbookImbalance: position.orderbookImbalance ?? null,
    bookImbalance: position.bookImbalance ?? null,
    bidAskImbalance: position.bidAskImbalance ?? null,

    spoofScore: position.spoofScore ?? null,
    orderbookSpoofScore: position.orderbookSpoofScore ?? null,
    obSpoofScore: position.obSpoofScore ?? null,
    fakeLiquidityScore: position.fakeLiquidityScore ?? null,

    btcState: position.btcState || null,
    btcRelation: position.btcRelation || null,

    flow: position.flow || null,
    flowCoarse: position.flowCoarse || null,

    regime: position.regime || null,
    regimeCoarse: position.regimeCoarse || null,

    confluence: position.confluence ?? null,
    sniperScore: position.sniperScore ?? null,

    scannerReason: position.scannerReason || null,
    scannerReasonCoarse: position.scannerReasonCoarse || null,

    spreadPct: position.spreadPct ?? null,
    exitSpreadPct: position.exitSpreadPct ?? null,
    spreadBps: position.spreadBps ?? null,

    depthMinUsd1p: position.depthMinUsd1p ?? null,
    fundingRate: position.fundingRate ?? null,

    entryQuality: position.entryQuality || null,
    retestConfirmed: Boolean(position.retestConfirmed),
    pullbackConfirmed: Boolean(position.pullbackConfirmed),
    sweepConfirmed: Boolean(position.sweepConfirmed),
    fakeBreakout: Boolean(position.fakeBreakout),
    fakeBreakoutRisk: Boolean(position.fakeBreakoutRisk),

    entryDistancePct: position.entryDistancePct ?? null,
    entryDistanceToMidPct: position.entryDistanceToMidPct ?? null,
    pullbackDistancePct: position.pullbackDistancePct ?? null,
    distanceToEntryPct: position.distanceToEntryPct ?? null,
    distancePct: position.distancePct ?? null,

    slDistancePct: position.slDistancePct ?? null,
    stopDistancePct: position.stopDistancePct ?? null,
    stopLossDistancePct: position.stopLossDistancePct ?? null,

    tpDistancePct: position.tpDistancePct ?? null,
    takeProfitDistancePct: position.takeProfitDistancePct ?? null,

    liqDistancePct: position.liqDistancePct ?? null,
    liquidationDistancePct: position.liquidationDistancePct ?? null,
    distanceToLiquidationPct: position.distanceToLiquidationPct ?? null,
    nearestLiqDistancePct: position.nearestLiqDistancePct ?? null,

    atrPct: position.atrPct ?? null,
    volatilityPct: position.volatilityPct ?? null,
    rangePct: position.rangePct ?? null,
    realizedVolPct: position.realizedVolPct ?? null,

    costR: position.costR ?? position.estimatedCostR ?? null,
    avgCostR: position.avgCostR ?? null,
    estimatedCostR: position.estimatedCostR ?? null
  };
}

export function buildOutcomeFromPosition({
  position,
  exitPrice,
  exitReason,
  source = 'REAL'
}) {
  if (!position) {
    throw new Error('POSITION_REQUIRED_FOR_OUTCOME');
  }

  const entry = safeNumber(position.entry, 0);
  const initialSl = safeNumber(position.initialSl || position.sl, 0);
  const exit = safeNumber(exitPrice, 0);

  const riskPct =
    safeNumber(position.riskPct, 0) ||
    calcRiskPct({
      entry,
      sl: initialSl
    });

  const grossMovePct = calcGrossMovePct({
    side: TARGET_TRADE_SIDE,
    entry,
    exit
  });

  const cost = applyCosts({
    grossMovePct,
    riskPct,
    entrySpreadPct: safeNumber(position.spreadPct, 0),
    exitSpreadPct: safeNumber(position.exitSpreadPct ?? position.spreadPct, 0)
  });

  const closedAt = now();

  return {
    type: 'OUTCOME',
    source: normalizeSource(source),
    strategyVersion: CONFIG.strategyVersion,

    tradeId: position.tradeId,
    shadowId: position.shadowId || position.id || null,

    symbol: position.symbol,
    contractSymbol: position.contractSymbol,
    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,

    ...copyMicroClassificationFields(position),

    entry,
    exit,
    sl: safeNumber(position.sl, 0),
    initialSl,
    tp: safeNumber(position.tp, 0),
    rr: safeNumber(position.rr, 0),
    riskPct,

    exitReason,

    grossR: cost.grossR,
    grossPnlPct: cost.grossPnlPct,

    exitR: cost.netR,
    pnlPct: cost.netPnlPct,
    netR: cost.netR,
    netPnlPct: cost.netPnlPct,

    costR: cost.costR,
    costPct: cost.costPct,
    feePct: cost.feePct,
    slippagePct: cost.slippagePct,

    mfeR: safeNumber(position.mfeR, 0),
    maeR: safeNumber(position.maeR, 0),

    directToSL: inferDirectToSL({
      position,
      exitReason
    }),

    nearTpSeen: Boolean(position.nearTpSeen),
    reachedHalfR: Boolean(position.reachedHalfR),
    reachedOneR: Boolean(position.reachedOneR),

    beArmed: Boolean(position.beArmed),
    beWouldExit: Boolean(position.beWouldExit),
    beExitR: safeNumber(position.beExitR, 0),

    gaveBackAfterHalfR: Boolean(position.gaveBackAfterHalfR),
    gaveBackAfterOneR: Boolean(position.gaveBackAfterOneR),
    nearTpThenLoss: Boolean(position.nearTpThenLoss),

    openedAt: position.openedAt || position.createdAt || null,
    closedAt
  };
}