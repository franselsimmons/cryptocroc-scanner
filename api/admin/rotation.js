// ================= FILE: api/admin/rotation.js =================


import {
  safeNumber,
  sideToTradeSide
} from '../../src/utils.js';
import { getWeekMicros } from '../../src/analyze/analyzeEngine.js';
import {
  activateSelectedMicroFamilies,
  getActiveRotation,
  getRotationDashboard
} from '../../src/analyze/rotationEngine.js';


const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const TARGET_SCANNER_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';


const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;


const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';

const TEMPORAL_CONTEXT_VERSION =
'LONG_TEMPORAL_CONTEXT_UTC_V1';
const WEEKEND_POLICY_VERSION =
'LONG_WEEKEND_OBSERVE_DISCORD_BLOCK_V1';
const SESSION_POLICY_VERSION =
'LONG_SESSION_OBSERVE_V1';
const WEEKEND_MODE = 'OBSERVE';
const SESSION_MODE = 'OBSERVE';

const DAY_NAMES_UTC = Object.freeze([
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY'
]);

const PRIMARY_SESSION_BUCKETS = Object.freeze([
  'ASIA',
  'EUROPE',
  'US',
  'ASIA_EU_OVERLAP',
  'EU_US_OVERLAP',
  'OFF_HOURS'
]);

const MIN_COMPLETED_ACTIVE_LEARNING = 20;
const EMPIRICAL_VETO_MIN_COMPLETED = 35;
const EMPIRICAL_VETO_MAX_AVG_R = 0;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;


const MEASUREMENT_FIX_VERSION =
  'LONG_MEASUREMENT_FIX_TRIGGER_BOUNDARY_EXIT_FILL_V2';


const EXIT_FILL_MODEL_VERSION =
  'LONG_TRIGGER_BOUNDARY_FILL_PLUS_COST_MODEL_V1';


const EMPIRICAL_VETO_POLICY_VERSION =
  'LONG_EXACT_75_CHILD_NET_EDGE_VETO_V1';


const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const LEARNING_GRANULARITY =
'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';


const LONG_FIXED_SETUP_TYPES = new Set([
  'BREAKOUT',
  'RETEST',
     'SWEEP_REVERSAL',
     'CONTINUATION',
     'COMPRESSION'
]);


const LONG_FIXED_REGIME_BUCKETS = new Set([
     'TREND',
     'CHOP',
     'SQUEEZE'
]);


const LONG_CONFIRMATION_PROFILES = new Set([
     'A_STRONG_ALIGN',
     'B_FLOW_ALIGN',
     'C_VOLUME_ALIGN',
     'D_MIXED_OK',
     'E_WEAK_CONTRA'
]);


const SETUP_ORDER = [
     'BREAKOUT',
     'RETEST',
     'SWEEP_REVERSAL',
     'CONTINUATION',
     'COMPRESSION'
];


const REGIME_ORDER = [
     'TREND',
     'CHOP',
     'SQUEEZE'
];


const CONFIRMATION_PROFILE_ORDER = [
     'A_STRONG_ALIGN',
     'B_FLOW_ALIGN',
     'C_VOLUME_ALIGN',
     'D_MIXED_OK',
     'E_WEAK_CONTRA'
];


const ALLOWED_ACTIONS = [
     'activateSelected',
     'activateSelectedMicroFamilies',
     'activateSelectedMacroFamilies'
];
const BLOCKED_AUTO_ACTIONS = new Set([
    'activateBestBalanced',
    'activateBestSideMicro',
    'activateBestSideMicroFamily',
    'activateBestLongMicroFamily',
    'activateBestShortMicroFamily',
    'activateBestBullMicroFamily',
    'activateBestBearMicroFamily',
    'activateBestShort',
    'activateShort',
    'activateBestLong',
    'activateLong',
    'activateNextRotation',
    'autoActivate',
    'autoBootstrap'
]);


const ALLOWED_MODES = new Set([
    'manual',
    'selected',
    'balanced',
    'winrate',
    'totalR',
    'avgR',
    'directSL',
    'observed'
]);


const DEFAULT_AVAILABLE_LIMIT = 120;
const MAX_AVAILABLE_LIMIT = 500;


const DEFAULT_ACTIVE_ROWS_LIMIT = 160;
const MAX_ACTIVE_ROWS_LIMIT = 500;


function now() {
    return Date.now();
}

function normalizeTemporalTimestamp(value, fallback = Date.now()) {
  const n = Number(value);

  if (!Number.isFinite(n) || n <= 0) {
    return Number.isFinite(Number(fallback))
      ? Number(fallback)
      : Date.now();
  }

  return n < 10_000_000_000
    ? Math.floor(n * 1000)
    : Math.floor(n);
}

function buildTemporalContext(value = Date.now()) {
  const contextTs = normalizeTemporalTimestamp(value, Date.now());
  const date = new Date(contextTs);
  const hourUtc = date.getUTCHours();
  const dayIndexUtc = date.getUTCDay();
  const dayOfWeekUtc = DAY_NAMES_UTC[dayIndexUtc] || 'UNKNOWN';
  const isWeekend = dayIndexUtc === 0 || dayIndexUtc === 6;

  const asiaActive = hourUtc >= 0 && hourUtc < 8;
  const europeActive = hourUtc >= 7 && hourUtc < 16;
  const usActive = hourUtc >= 13 && hourUtc < 22;

  const sessionTags = [];
  if (asiaActive) sessionTags.push('ASIA');
  if (europeActive) sessionTags.push('EUROPE');
  if (usActive) sessionTags.push('US');

  let primarySessionBucket = 'OFF_HOURS';

  if (europeActive && usActive) {
    primarySessionBucket = 'EU_US_OVERLAP';
  } else if (asiaActive && europeActive) {
    primarySessionBucket = 'ASIA_EU_OVERLAP';
  } else if (asiaActive) {
    primarySessionBucket = 'ASIA';
  } else if (europeActive) {
    primarySessionBucket = 'EUROPE';
  } else if (usActive) {
    primarySessionBucket = 'US';
  }

  return {
    temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
    contextTs,
    hourUtc,
    dayOfWeekUtc,
    dayType: isWeekend ? 'WEEKEND' : 'WEEKDAY',
    isWeekend,
    sessionTags,
    primarySessionBucket,
    sessionOverlap: sessionTags.length > 1,
    offHours: primarySessionBucket === 'OFF_HOURS'
  };
}

function resolveRecordTemporalContext(record = {}, fallbackTs = Date.now()) {
  const source = record && typeof record === 'object'
    ? record
    : {};

  const rawTs =
    source.contextTs ??
    source.entryTs ??
    source.createdAt ??
    source.completedAt ??
    source.ts ??
    source.scannerTs ??
    source.updatedAt ??
    fallbackTs;

  const computed = buildTemporalContext(rawTs);
  const explicitBucket = String(
    source.primarySessionBucket ||
    source.sessionBucket ||
    ''
  ).trim().toUpperCase();

  const explicitTags = Array.isArray(source.sessionTags)
    ? source.sessionTags
        .map((value) => String(value || '').trim().toUpperCase())
        .filter((value) => ['ASIA', 'EUROPE', 'US'].includes(value))
    : computed.sessionTags;

  const primarySessionBucket = PRIMARY_SESSION_BUCKETS.includes(explicitBucket)
    ? explicitBucket
    : computed.primarySessionBucket;

  const isWeekend = typeof source.isWeekend === 'boolean'
    ? source.isWeekend
    : computed.isWeekend;

  return {
    temporalContextVersion:
      source.temporalContextVersion ||
      TEMPORAL_CONTEXT_VERSION,
    contextTs: normalizeTemporalTimestamp(
      source.contextTs ?? rawTs,
      computed.contextTs
    ),
    hourUtc: Number.isFinite(Number(source.hourUtc))
      ? Number(source.hourUtc)
      : computed.hourUtc,
    dayOfWeekUtc:
      source.dayOfWeekUtc ||
      computed.dayOfWeekUtc,
    dayType:
      source.dayType ||
      (isWeekend ? 'WEEKEND' : 'WEEKDAY'),
    isWeekend,
    sessionTags: explicitTags,
    primarySessionBucket,
    sessionOverlap: typeof source.sessionOverlap === 'boolean'
      ? source.sessionOverlap
      : explicitTags.length > 1,
    offHours: typeof source.offHours === 'boolean'
      ? source.offHours
      : primarySessionBucket === 'OFF_HOURS'
  };
}

function buildEntryExitTemporalMetadata(record = {}) {
  const source = record && typeof record === 'object'
    ? record
    : {};

  const entryTsRaw =
    source.entryTs ??
    source.openedAt ??
    source.openTs ??
    source.positionOpenedAt ??
    source.createdAt ??
    null;

  const exitTsRaw =
    source.exitTs ??
    source.closedAt ??
    source.closeTs ??
    source.positionClosedAt ??
    null;

  const output = {};

  if (entryTsRaw !== null && entryTsRaw !== undefined && entryTsRaw !== '') {
    const entry = buildTemporalContext(entryTsRaw);

    output.entryTs = normalizeTemporalTimestamp(entryTsRaw, entry.contextTs);
    output.entryHourUtc = Number.isFinite(Number(source.entryHourUtc))
      ? Number(source.entryHourUtc)
      : entry.hourUtc;
    output.entryDayOfWeekUtc =
      source.entryDayOfWeekUtc ||
      entry.dayOfWeekUtc;
    output.entryDayType =
      source.entryDayType ||
      entry.dayType;
    output.entryIsWeekend = typeof source.entryIsWeekend === 'boolean'
      ? source.entryIsWeekend
      : entry.isWeekend;
    output.entrySessionTags = Array.isArray(source.entrySessionTags)
      ? source.entrySessionTags
      : entry.sessionTags;
    output.entrySessionBucket =
      source.entrySessionBucket ||
      entry.primarySessionBucket;
    output.entrySessionOverlap =
      typeof source.entrySessionOverlap === 'boolean'
        ? source.entrySessionOverlap
        : entry.sessionOverlap;
    output.entryOffHours = typeof source.entryOffHours === 'boolean'
      ? source.entryOffHours
      : entry.offHours;
  }

  if (exitTsRaw !== null && exitTsRaw !== undefined && exitTsRaw !== '') {
    const exit = buildTemporalContext(exitTsRaw);

    output.exitTs = normalizeTemporalTimestamp(exitTsRaw, exit.contextTs);
    output.exitHourUtc = Number.isFinite(Number(source.exitHourUtc))
      ? Number(source.exitHourUtc)
      : exit.hourUtc;
    output.exitDayOfWeekUtc =
      source.exitDayOfWeekUtc ||
      exit.dayOfWeekUtc;
    output.exitDayType =
      source.exitDayType ||
      exit.dayType;
    output.exitIsWeekend = typeof source.exitIsWeekend === 'boolean'
      ? source.exitIsWeekend
      : exit.isWeekend;
    output.exitSessionTags = Array.isArray(source.exitSessionTags)
      ? source.exitSessionTags
      : exit.sessionTags;
    output.exitSessionBucket =
      source.exitSessionBucket ||
      exit.primarySessionBucket;
    output.exitSessionOverlap =
      typeof source.exitSessionOverlap === 'boolean'
        ? source.exitSessionOverlap
        : exit.sessionOverlap;
    output.exitOffHours = typeof source.exitOffHours === 'boolean'
      ? source.exitOffHours
      : exit.offHours;
  }

  return output;
}

function temporalPolicyFlags(context = buildTemporalContext()) {
  const resolved = context && typeof context === 'object'
    ? context
    : buildTemporalContext();

  return {
    temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
    weekendPolicyVersion: WEEKEND_POLICY_VERSION,
    sessionPolicyVersion: SESSION_POLICY_VERSION,
    weekendMode: WEEKEND_MODE,
    sessionMode: SESSION_MODE,

    weekendLearningAllowed: true,
    weekendVirtualEntryAllowed: true,
    weekendDiscordEntryAllowed: resolved.isWeekend !== true,
    weekendDiscordEntryBlocked: resolved.isWeekend === true,
    weekendExitMonitoringAllowed: true,
    weekendOutcomeRecordingAllowed: true,

    sessionLearningAllowed: true,
    sessionVirtualEntryAllowed: true,
    sessionDiscordEntryAllowed: true,
    sessionPolicyObservedOnly: true,

    temporalContextDoesNotSplitMicroFamily: true,
    dayTypeExcludedFromFamilyId: true,
    sessionExcludedFromFamilyId: true,
    primarySessionBucketCountedOnce: true,
    sessionTagsMetadataOnly: true,
    familyGateStillRequired: true,
    currentFitCannotOverrideFamilyGate: true
  };
}

function emptyTemporalStats() {
  const emptyBucket = () => ({
    seen: 0,
    observations: 0,
    completed: 0,
    wins: 0,
    losses: 0,
    flats: 0,
    totalR: 0,
    avgR: 0,
    grossWinR: 0,
    grossLossR: 0,
    profitFactor: 0,
    directSLCount: 0,
    directSLPct: 0,
    totalCostR: 0,
    avgCostR: 0
  });

  return {
    contextStats: {
      WEEKDAY: emptyBucket(),
      WEEKEND: emptyBucket()
    },
    sessionStats: {
      ASIA: emptyBucket(),
      EUROPE: emptyBucket(),
      US: emptyBucket(),
      ASIA_EU_OVERLAP: emptyBucket(),
      EU_US_OVERLAP: emptyBucket(),
      OFF_HOURS: emptyBucket()
    }
  };
}

function temporalStatsFields(record = {}) {
  const defaults = emptyTemporalStats();
  const source = record && typeof record === 'object'
    ? record
    : {};

  return {
    contextStats:
      source.contextStats &&
      typeof source.contextStats === 'object' &&
      !Array.isArray(source.contextStats)
        ? source.contextStats
        : defaults.contextStats,
    sessionStats:
      source.sessionStats &&
      typeof source.sessionStats === 'object' &&
      !Array.isArray(source.sessionStats)
        ? source.sessionStats
        : defaults.sessionStats
  };
}



function modeFlags() {
    return {
         ...temporalPolicyFlags(),
      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      scannerSide: TARGET_SCANNER_SIDE,
      oppositeTradeSide: OPPOSITE_TRADE_SIDE,


      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
positionSide: TARGET_TRADE_SIDE,
direction: TARGET_TRADE_SIDE,


longOnly: true,
shortDisabled: true,
shortOnly: false,
longDisabled: false,


virtualLearning: true,
virtualLearningForced: true,
virtualOnly: true,
virtualTracked: true,
virtualOutcomesIncluded: true,
shadowOutcomesIncluded: true,
realOutcomesExcluded: true,
learningOutcomesOnly: true,
outcomesSourceMode: 'VIRTUAL_AND_SHADOW_NET_OUTCOMES',
outcomeSource: 'VIRTUAL',


observationFirst: true,
netOutcomesOnly: true,
completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
scoringRSource: 'netR',
winsLossesFlatsSource: 'netR',
winrateDefinition: 'netR > 0',
avgRSource: 'netR',
totalRSource: 'netR',
avgCostRShown: true,


measurementFixVersion: MEASUREMENT_FIX_VERSION,
acceptedOutcomeMeasurementVersion: MEASUREMENT_FIX_VERSION,
completedCurrentMeasurementOnly: true,
strictOutcomeMeasurementGate: true,
legacyOutcomeMeasurementsExcluded: true,
exitFillModelVersion: EXIT_FILL_MODEL_VERSION,
exitFillPolicy: 'TP_SL_USE_TRIGGER_BOUNDARY_TIME_STOP_USES_OBSERVED_PRICE',


empiricalVetoEnabled: true,
empiricalVetoPolicyVersion: EMPIRICAL_VETO_POLICY_VERSION,
empiricalVetoMinCompleted: EMPIRICAL_VETO_MIN_COMPLETED,
empiricalVetoMaxAvgR: EMPIRICAL_VETO_MAX_AVG_R,
empiricalVetoRule:
  'completed >= 35 && avgR <= 0',
empiricalVetoBlocksAdaptiveSelection: true,
empiricalVetoBlocksManualActivation: true,
empiricalVetoRemovesActiveDiscordSelection: true,
empiricalVetoCanRecover: true,
noRealOrders: true,
realOrdersDisabled: true,
bitgetOrdersDisabled: true,
exchangeCallsDisabled: true,


globalMaxOpenPositionsBlockDisabled: true,
maxOneOpenPositionPerSymbol: true,


positionTimeStopMinDefault: DEFAULT_POSITION_TIME_STOP_MIN,
longRiskShape: 'sl < entry < tp',
riskTradeSide: TARGET_TRADE_SIDE,
riskGeometryRule: 'LONG: sl < entry < tp',
tpRule: 'price >= tp',
slRule: 'price <= sl',
tpHitRule: 'LONG: price >= tp',
slHitRule: 'LONG: price <= sl',
grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
currentRFormula: '(currentPrice - entry) / (entry - initialSl)',
timeStopEnabled: true,


currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
currentFitSoftOnly: true,
currentFitBlocksLearning: false,
currentFitBlocksVirtualLearning: false,
currentFitBlocksShadowLearning: false,


scannerFingerprintRole: 'METADATA_ONLY',
scannerFingerprintsMetadataOnly: true,
scannerFingerprintsUsedAsLearningFamily: false,
scannerBucketsDebugMetadataOnly: true,
legacy25BucketsDebugMetadataOnly: true,


executionFingerprintRole: 'METADATA_ONLY',
executionFingerprintsMetadataOnly: true,
executionFingerprintsUsedAsLearningFamily: false,


analyzeMicroFamiliesOnly: true,
learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
symbolExcludedFromFamilyId: true,
coinNameExcludedFromFamilyId: true,
hashesExcludedFromFamilyId: true,


trueMicroOnly: true,
exactTrueMicroOnly: true,
exactTrueMicroFamilyRequired: true,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    fixedTaxonomyPreferred: true,
    learningGranularity: LEARNING_GRANULARITY,


    parentMicroFamilyCount: 15,
    selectableChildMicroFamilyCount: 75,
    parentFamilyRule: 'MICRO_LONG_{SETUP}_{REGIME}',
    selectableFamilyRule: 'MICRO_LONG_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',
    selectableIdsAreChildrenOnly: true,
    parentIdsAreMetadataOnly: true,


    manualSelectionOnly: true,
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    manualSelectionMustUseSelectable75ChildId: true,
    macroActivationExpansionDisabled: true,
    parentActivationExpansionDisabled: true,
    autoRotationDisabled: true,
    autoRotationActivationDisabled: true,
    activateFreezeCronDisabled: true,
    resetCronDisabled: true,
    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForExactTrueMicroMatch: true,
    discordSelectionRule: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY',
    parentMatchDoesNotTriggerDiscord: true,
    macroMatchDoesNotTriggerDiscord: true,


    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    weekResetDisabled: true,
    isoWeekLearningDisabled: true,


    minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,
    statusRules: {
         OBSERVING: 'completed == 0',
         EARLY_OUTCOMES:
           `completed >= 1 && completed < ${MIN_COMPLETED_ACTIVE_LEARNING}`,
         ACTIVE_LEARNING:
           `completed >= ${MIN_COMPLETED_ACTIVE_LEARNING} && completed < ${EMPIRICAL_VETO_MIN_COMPLETED}`,
         PASSED:
           `completed >= ${EMPIRICAL_VETO_MIN_COMPLETED} && avgR > ${EMPIRICAL_VETO_MAX_AVG_R}`,
         EMPIRICAL_VETO:
           `completed >= ${EMPIRICAL_VETO_MIN_COMPLETED} && avgR <= ${EMPIRICAL_VETO_MAX_AVG_R}`
    },


    activationGateRules: {
         OBSERVING: `completed < ${EMPIRICAL_VETO_MIN_COMPLETED}`,
         PASSED:
           `completed >= ${EMPIRICAL_VETO_MIN_COMPLETED} && avgR >
${EMPIRICAL_VETO_MAX_AVG_R}`,
         EMPIRICAL_VETO:
           `completed >= ${EMPIRICAL_VETO_MIN_COMPLETED} && avgR <=
${EMPIRICAL_VETO_MAX_AVG_R}`
         },


         redisNamespace: LONG_NAMESPACE,
         redisKeyPrefix: LONG_KEY_PREFIX,
         redisKeysSeparatedFromShortRoot: true,
         shortRootTouched: false
    };
}


function taxonomyMeta() {
    return {
         trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
         childTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
         parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
         learningGranularity: LEARNING_GRANULARITY,


         parentMicroFamilyCount: 15,
         selectableChildMicroFamilyCount: 75,


         setups: SETUP_ORDER,
         regimes: REGIME_ORDER,
         confirmationProfiles: CONFIRMATION_PROFILE_ORDER,


         validSetupTypes: [...LONG_FIXED_SETUP_TYPES],
         validRegimeBuckets: [...LONG_FIXED_REGIME_BUCKETS],
         validConfirmationProfiles: [...LONG_CONFIRMATION_PROFILES],


         parentFormat: 'MICRO_LONG_{SETUP}_{REGIME}',
         selectableChildFormat: 'MICRO_LONG_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',


         exampleParent: 'MICRO_LONG_BREAKOUT_TREND',
         exampleSelectableChild: 'MICRO_LONG_BREAKOUT_TREND_A_STRONG_ALIGN',


         selectableIdsAreChildrenOnly: true,
         parentIdsAreMetadataOnly: true
    };
}


function methodNotAllowed(res) {
    res.setHeader('Allow', 'GET, POST');


    return res.status(405).json({
         ok: false,
         error: 'METHOD_NOT_ALLOWED',
         allowed: ['GET', 'POST'],
         ...modeFlags()
    });
}


function parseJson(text) {
    const clean = String(text || '').trim();


    if (!clean) return {};


    try {
        return JSON.parse(clean);
    } catch {
        const error = new Error('INVALID_JSON_BODY');
        error.statusCode = 400;
        throw error;
    }
}


async function readBody(req) {
    if (req.body) {
        if (typeof req.body === 'string') return parseJson(req.body);
        if (Buffer.isBuffer(req.body)) return parseJson(req.body.toString('utf8'));


        return req.body;
    }


    const chunks = [];


    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }


    return parseJson(Buffer.concat(chunks).toString('utf8'));
}


function firstValue(value, fallback = null) {
    if (Array.isArray(value)) return value[0] ?? fallback;
    if (value === undefined || value === null || value === '') return fallback;


    return value;
}


function isTrue(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;


    const raw = String(value).trim().toLowerCase();


    if (['true', '1', 'yes', 'y', 'on'].includes(raw)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(raw)) return false;
    return fallback;
}


function toLimit(value, fallback = DEFAULT_AVAILABLE_LIMIT, max =
MAX_AVAILABLE_LIMIT) {
    const n = Math.floor(Number(value));


    if (!Number.isFinite(n) || n < 1) return fallback;


    return Math.min(n, max);
}


function normalizeMode(value, fallback = 'manual') {
    const mode = String(value || fallback).trim();


    return ALLOWED_MODES.has(mode) ? mode : fallback;
}


function hasValue(value) {
    return value !== undefined && value !== null && value !== '';
}


function num(value, fallback = 0) {
    const n = safeNumber(value, fallback);


    return Number.isFinite(n) ? n : fallback;
}


function round(value, decimals = 4) {
    return Number(num(value, 0).toFixed(decimals));
}


function upper(value) {
    return String(value || '').trim().toUpperCase();
}


function cleanSideText(value = '') {
    return upper(value)
      .replaceAll('SHORT_DISABLED_FALSE', '')
      .replaceAll('SHORTDISABLED_FALSE', '')
      .replaceAll('BLOCK_SHORT_FALSE', '')
      .replaceAll('SHORT_ENABLED_FALSE', '')
      .replaceAll('SHORT_ONLY_FALSE', '')
      .replaceAll('LONG_DISABLED_FALSE', '')
      .replaceAll('LONGDISABLED_FALSE', '')
      .replaceAll('BLOCK_LONG_FALSE', '')
        .replaceAll('LONG_ENABLED_FALSE', '')
        .replaceAll('LONG_ONLY_FALSE', '')
        .replaceAll('SHORT_DISABLED_LONG_ONLY', 'LONG')
        .replaceAll('SHORTDISABLED_LONG_ONLY', 'LONG')
        .replaceAll('BLOCK_SHORT', 'LONG')
        .replaceAll('SHORT_DISABLED', 'LONG')
        .replaceAll('SHORTDISABLED', 'LONG')
        .replaceAll('LONG_DISABLED_SHORT_ONLY', 'SHORT')
        .replaceAll('LONGDISABLED_SHORT_ONLY', 'SHORT')
        .replaceAll('BLOCK_LONG', 'SHORT')
        .replaceAll('LONG_DISABLED', 'SHORT')
        .replaceAll('LONGDISABLED', 'SHORT')
        .replaceAll('SHORT_ONLY_MODE', 'SHORT')
        .replaceAll('SHORT_ONLY', 'SHORT')
        .replaceAll('SHORT-ONLY', 'SHORT')
        .replaceAll('LONG_ONLY_MODE', 'LONG')
        .replaceAll('LONG_ONLY', 'LONG')
        .replaceAll('LONG-ONLY', 'LONG');
}


function flattenValues(values = []) {
    const stack = Array.isArray(values) ? [...values] : [values];
    const output = [];


    while (stack.length > 0) {
        const value = stack.shift();


        if (Array.isArray(value)) {
            stack.unshift(...value);
            continue;
        }


        output.push(value);
    }


    return output;
}


function uniqueStrings(values = []) {
    return [...new Set(
        flattenValues(values)
            .flatMap((value) => {
              if (typeof value === 'string') {
                  return value
                    .split(/[\s,;\n\r]+/g)
                    .map((part) => part.trim());
              }
               return [value];
          })
          .map((value) => String(value || '').trim())
          .filter(Boolean)
    )];
}


function firstFiniteNumber(values = []) {
    for (const value of flattenValues(values)) {
        if (value === undefined || value === null || value === '') continue;


        const n = Number(value);


        if (Number.isFinite(n)) return n;
    }


    return null;
}


function getArray(value) {
    return Array.isArray(value) ? value : [];
}


function getDefinitionParts(row = {}) {
    if (Array.isArray(row.definitionParts)) return row.definitionParts;
    if (Array.isArray(row.microDefinitionParts)) return row.microDefinitionParts;


    return [];
}


function getMacroDefinitionParts(row = {}) {
    if (Array.isArray(row.macroDefinitionParts)) return row.macroDefinitionParts;
    if (Array.isArray(row.parentDefinitionParts)) return row.parentDefinitionParts;


    return [];
}


function parseLongTaxonomyMicroId(id = '') {
    const value = upper(id);


    if (!value.startsWith('MICRO_LONG_')) {
        return {
          valid: false,
          selectable: false,
          isParent: false,
          isChild: false,
         rawId: String(id || '').trim()
    };
}


let body = value.slice('MICRO_LONG_'.length);
let confirmationProfile = null;


for (const profile of CONFIRMATION_PROFILE_ORDER) {
    const suffix = `_${profile}`;


    if (body.endsWith(suffix)) {
         confirmationProfile = profile;
         body = body.slice(0, -suffix.length);
         break;
    }
}


let setup = null;
let regime = null;


for (const candidateRegime of LONG_FIXED_REGIME_BUCKETS) {
    const suffix = `_${candidateRegime}`;


    if (body.endsWith(suffix)) {
         regime = candidateRegime;
         setup = body.slice(0, -suffix.length);
         break;
    }
}


const parentId = setup && regime
    ? `MICRO_LONG_${setup}_${regime}`
    : null;


const childId = parentId && confirmationProfile
    ? `${parentId}_${confirmationProfile}`
    : null;


const validParent =
    Boolean(parentId) &&
    LONG_FIXED_SETUP_TYPES.has(setup) &&
    LONG_FIXED_REGIME_BUCKETS.has(regime);


const validChild =
    validParent &&
    Boolean(confirmationProfile) &&
    LONG_CONFIRMATION_PROFILES.has(confirmationProfile);
    return {
         valid: validParent || validChild,
         selectable: validChild,
         isParent: validParent && !validChild,
         isChild: validChild,
         rawId: String(id || '').trim(),
         setup,
         regime,
         confirmationProfile,
         parentTrueMicroFamilyId: validParent ? parentId : null,
         trueMicroFamilyId: validChild ? childId : validParent ? parentId : null,
         childTrueMicroFamilyId: validChild ? childId : null,
         trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
         learningGranularity: LEARNING_GRANULARITY
    };
}


function isFixedLongParentMicroId(id = '') {
    const parsed = parseLongTaxonomyMicroId(id);


    return parsed.valid && parsed.isParent;
}


function isFixedLongChildMicroId(id = '') {
    const parsed = parseLongTaxonomyMicroId(id);


    return parsed.valid && parsed.isChild;
}


function isScannerFingerprintId(id = '') {
    const value = upper(id);


    return (
         value.startsWith('MICRO_LONG_SCANNER__') ||
         value.includes('MICRO_LONG_SCANNER__') ||
         value.startsWith('LONG_SCANNER_') ||
         value.includes('LONG_SCANNER_') ||
         value.startsWith('MICRO_SHORT_SCANNER__') ||
         value.includes('MICRO_SHORT_SCANNER__') ||
         value.startsWith('SHORT_SCANNER_') ||
         value.includes('SHORT_SCANNER_') ||
         value.includes('__SCANNER__') ||
         value.includes('SCANNER_GATE_PASS') ||
         value.includes('SCANNER_GATE_FAIL')
    );
}
function isExecutionFingerprintId(id = '') {
    const value = upper(id);


    return (
         value.includes('_XR_') ||
         value.includes('__XR__') ||
         value.includes('EXECUTION_FINGERPRINT') ||
         value.includes('EXECUTION_MICRO') ||
         value.includes('REFINED_EXECUTION')
    );
}


function validLearningId(id = '') {
    const value = String(id || '').trim();


    if (!value) return false;
    if (isScannerFingerprintId(value)) return false;
    if (isExecutionFingerprintId(value)) return false;


    return true;
}


function firstValidLearningId(values = [], fallback = null) {
    for (const value of values) {
         const id = String(value || '').trim();


         if (validLearningId(id)) return id;
    }


    return fallback;
}


function getMicroFamilyId(row = {}, fallback = null) {
    return firstValidLearningId([
         row.trueMicroFamilyId,
         row.learningMicroFamilyId,
         row.analyzeMicroFamilyId,
         row.microFamilyId,
         row.id,
         row.key,
         fallback
    ], null);
}


function getTrueMicroFamilyId(row = {}, fallback = null) {
    return firstValidLearningId([
      row.trueMicroFamilyId,
      row.learningMicroFamilyId,
      row.analyzeMicroFamilyId,
      row.microFamilyId,
      row.id,
      row.key,
      fallback
    ], null);
}


function getParentTrueMicroFamilyId(row = {}, fallback = null) {
    const trueMicroFamilyId = getTrueMicroFamilyId(row, fallback);
    const parsed = parseLongTaxonomyMicroId(trueMicroFamilyId);


    if (parsed.parentTrueMicroFamilyId) return parsed.parentTrueMicroFamilyId;


    return firstValidLearningId([
      row.parentTrueMicroFamilyId,
      row.coarseMicroFamilyId,
      row.baseMicroFamilyId,
      row.legacyMicroFamilyId,
      row.parentMacroFamilyId,
      row.macroFamilyId,
      row.parentMicroFamilyId,
      row.parentFamilyId,
      row.macroId,
      row.familyId
    ], null);
}


function getFamilyId(row = {}) {
    const parent = getParentTrueMicroFamilyId(row);


    return firstValidLearningId([
      row.familyId,
      row.family,
      row.baseFamilyId,
      parent
    ], null);
}


function getMacroFamilyId(row = {}) {
    const parent = getParentTrueMicroFamilyId(row);


    return firstValidLearningId([
      parent,
      row.parentMacroFamilyId,
        row.macroFamilyId,
        row.parentMicroFamilyId,
        row.parentFamilyId,
        row.macroId,
        row.familyId
    ], null);
}


function definitionHaystack(row = {}) {
    return [
        row.definition,
        row.microDefinition,
        row.macroDefinition,
        row.parentDefinition,
        ...getArray(row.definitionParts),
        ...getArray(row.microDefinitionParts),
        ...getArray(row.macroDefinitionParts),
        ...getArray(row.parentDefinitionParts),
        ...getArray(row.executionFingerprintParts)
    ]
        .map((value) => cleanSideText(value))
        .filter(Boolean)
        .join(' | ');
}


function normalizeDirectSide(value) {
    const raw = cleanSideText(value);


    if (!raw) return 'UNKNOWN';


    const converted = sideToTradeSide(raw);


    if (converted === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
    if (converted === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;


    if (['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'UPSIDE'].includes(raw)) {
        return TARGET_TRADE_SIDE;
    }


    if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE'].includes(raw)) {
        return OPPOSITE_TRADE_SIDE;
    }


    return 'UNKNOWN';
}


function inferTradeSide(input = {}) {
  if (typeof input === 'string') {
       if (parseLongTaxonomyMicroId(input).valid) return TARGET_TRADE_SIDE;


       const value = cleanSideText(input);


       if (value.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
       if (value.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
       if (value.includes('SHORT') || value.includes('BEAR') || value.includes('SELL'))
return OPPOSITE_TRADE_SIDE;
       if (value.includes('LONG') || value.includes('BULL') ||
value.includes('BUY')) return TARGET_TRADE_SIDE;


       return 'UNKNOWN';
  }


  const directSources = [
       input.tradeSide,
       input.positionSide,
       input.direction,
       input.signalSide,
       input.scannerSide,
       input.actualScannerSide,
       input.analysisSide,
       input.entrySide,
       input.side,
       input.bias,
       input.marketBias
  ];


  for (const source of directSources) {
       const side = normalizeDirectSide(source);


       if (side === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
       if (side === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
  }


  const trueMicroFamilyId = cleanSideText(getTrueMicroFamilyId(input) ||
getMicroFamilyId(input));
  const macroFamilyId = cleanSideText(getMacroFamilyId(input));


  if (parseLongTaxonomyMicroId(trueMicroFamilyId).valid) return
TARGET_TRADE_SIDE;
  if (trueMicroFamilyId.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;


  if (parseLongTaxonomyMicroId(macroFamilyId).valid) return TARGET_TRADE_SIDE;
  if (macroFamilyId.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
    const definition = definitionHaystack(input);


    if (definition.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
    if (definition.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;


    if (input.longOnly === true || input.shortDisabled === true) {
        return TARGET_TRADE_SIDE;
    }


    if (input.shortOnly === true || input.longDisabled === true) {
        return OPPOSITE_TRADE_SIDE;
    }


    return 'UNKNOWN';
}


function isSelectableTrueMicroId(id = '') {
    const value = String(id || '').trim();


    if (!validLearningId(value)) return false;


    return isFixedLongChildMicroId(value);
}


function isLongFamilyId(id = '') {
    const value = String(id || '').trim();


    if (!validLearningId(value)) return false;
    if (upper(value).includes('MICRO_SHORT_')) return false;


    return parseLongTaxonomyMicroId(value).valid;
}


function isLongRow(row = {}) {
    const id = getTrueMicroFamilyId(row) || getMicroFamilyId(row);


    if (!validLearningId(id)) return false;
    if (inferTradeSide(row) === OPPOSITE_TRADE_SIDE) return false;


    return true;
}


function isTrueMicroFamilyRow(row = {}) {
    const id = getTrueMicroFamilyId(row) || getMicroFamilyId(row);


    if (!validLearningId(id)) return false;
    if (!isLongRow(row)) return false;
    return isSelectableTrueMicroId(id);
}


function sourceEntries(value = {}) {
    if (Array.isArray(value)) {
        return value.map((row, index) => [
          getMicroFamilyId(row, String(index)),
          row
        ]);
    }


    if (!value || typeof value !== 'object') return [];


    return Object.entries(value);
}


function hasVirtualShadowOutcomeFields(row = {}) {
    return [
        'virtualCompleted',
        'shadowCompleted',
        'virtualWins',
        'virtualLosses',
        'virtualFlats',
        'shadowWins',
        'shadowLosses',
        'shadowFlats',
        'virtualTotalR',
        'shadowTotalR'
    ].some((key) => hasValue(row[key]));
}


function virtualKeyFromReal(realKey = '') {
    if (!realKey || !String(realKey).startsWith('real')) return null;


    return `virtual${String(realKey).slice(4)}`;
}


function shadowKeyFromReal(realKey = '') {
    if (!realKey || !String(realKey).startsWith('real')) return null;


    return `shadow${String(realKey).slice(4)}`;
}


function getLearningCount(row = {}, aggregateKey, realKey = null, shadowKey =
null) {
    const virtualKey = virtualKeyFromReal(realKey);
    const resolvedShadowKey = shadowKey || shadowKeyFromReal(realKey);


    const virtualShadow =
        num(virtualKey ? row[virtualKey] : 0, 0) +
        num(resolvedShadowKey ? row[resolvedShadowKey] : 0, 0);


    if (virtualShadow > 0 || hasVirtualShadowOutcomeFields(row)) {
        return virtualShadow;
    }


    if (aggregateKey && hasValue(row[aggregateKey])) {
        return num(row[aggregateKey], 0);
    }


    return 0;
}


function getLongRiskGeometry(row = {}) {
    const entry = firstFiniteNumber([
        row.entryPrice,
        row.entry,
        row.avgEntryPrice,
        row.averageEntryPrice,
        row.averageEntry,
        row.openPrice
    ]);


    const initialSl = firstFiniteNumber([
        row.initialSl,
        row.initialSL,
        row.initialStopLoss,
        row.initialStopLossPrice,
        row.stopLoss,
        row.stopLossPrice,
        row.sl,
        row.slPrice
    ]);


    const tp = firstFiniteNumber([
        row.tp,
        row.takeProfit,
        row.takeProfitPrice,
        row.targetPrice,
        row.finalTp,
        row.finalTakeProfit
    ]);
const exitPrice = firstFiniteNumber([
  row.exitPrice,
  row.closePrice,
  row.closedPrice,
  row.outcomePrice,
  row.fillExitPrice,
  row.exit
]);


const currentPrice = firstFiniteNumber([
  row.currentPrice,
  row.markPrice,
  row.lastPrice,
  row.price
]);


const denominator =
  Number.isFinite(entry) && Number.isFinite(initialSl)
       ? entry - initialSl
       : 0;


const validGeometry =
  Number.isFinite(entry) &&
  Number.isFinite(initialSl) &&
  Number.isFinite(tp) &&
  denominator > 0 &&
  initialSl < entry &&
  entry < tp;


const longGrossR =
  validGeometry && Number.isFinite(exitPrice)
       ? (exitPrice - entry) / denominator
       : null;


const longCurrentR =
  validGeometry && Number.isFinite(currentPrice)
       ? (currentPrice - entry) / denominator
       : null;


const longTpHit =
  validGeometry &&
  (
       row.longTpHit === true ||
       row.tpHit === true ||
       (Number.isFinite(exitPrice) && exitPrice >= tp) ||
       (Number.isFinite(currentPrice) && currentPrice >= tp)
  );
    const longSlHit =
         validGeometry &&
         (
              row.longSlHit === true ||
              row.slHit === true ||
              (Number.isFinite(exitPrice) && exitPrice <= initialSl) ||
              (Number.isFinite(currentPrice) && currentPrice <= initialSl)
         );


    return {
         entry,
         initialSl,
         tp,
         exitPrice,
         currentPrice,
         denominator,
         validGeometry,
         longTpHit: Boolean(longTpHit),
         longSlHit: Boolean(longSlHit),
         longGrossR,
         longCurrentR,
         riskGeometryRule: 'LONG: sl < entry < tp',
         tpHitRule: 'LONG: price >= tp',
         slHitRule: 'LONG: price <= sl',
         grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
         currentRFormula: '(currentPrice - entry) / (entry - initialSl)'
    };
}


function outcomeNetR(row = {}) {
    const explicitLongR = firstFiniteNumber([
         row.longNetR,
         row.netLongR,
         row.longExitR,
         row.longRealizedNetR,
         row.longRealizedR
    ]);


    if (explicitLongR !== null) return explicitLongR;


    const geometry = getLongRiskGeometry(row);
    const costR = num(row.costR ?? row.avgCostR, 0);


    if (geometry.validGeometry && geometry.longGrossR !== null) {
         return geometry.longGrossR - costR;
    }
    return num(
         row.netR ??
              row.exitR ??
              row.realizedNetR ??
              row.realizedR ??
              row.r,
         0
    );
}


function outcomeCounts(row = {}) {
    const wins = getLearningCount(row, 'wins', 'realWins', 'shadowWins');
    const losses = getLearningCount(row, 'losses', 'realLosses', 'shadowLosses');
    const flats = getLearningCount(row, 'flats', 'realFlats', 'shadowFlats');


    const virtualShadowCompleted =
         num(row.virtualCompleted, 0) +
         num(row.shadowCompleted, 0);


    const aggregateCompleted = hasVirtualShadowOutcomeFields(row)
         ? 0
         : Math.max(
              num(row.completed, 0),
              num(row.outcomeSample, 0),
              0
         );


    const countedTotal = wins + losses + flats;
    const total = Math.max(countedTotal, virtualShadowCompleted, aggregateCompleted,
0);
    const inferredFlats = Math.max(0, total - wins - losses);


    return {
         wins,
         losses,
         flats: Math.max(flats, inferredFlats),
         total
    };
}


function rowMeasurementFixVersion(row = {}) {
    return upper(
         row.measurementFixVersion ??
              row.outcomeMeasurementVersion ??
              row.acceptedOutcomeMeasurementVersion ??
              row.positionMeasurementFixVersion ??
              row.measurementVersion ??
              row.exitMeasurementVersion ??
              ''
    );
}


function hasStoredOutcomeData(row = {}) {
    return (
         num(row.completed, 0) > 0 ||
         num(row.virtualCompleted, 0) > 0 ||
         num(row.shadowCompleted, 0) > 0 ||
         num(row.totalR ?? row.netTotalR ?? row.totalNetR, 0) !== 0 ||
         (Array.isArray(row.recentOutcomes) && row.recentOutcomes.length > 0)
    );
}


function isCurrentMeasurementOutcome(row = {}) {
    const source = upper(row.source || row.outcomeSource);
    const hasR = Number.isFinite(Number(
         row.netR ??
              row.exitR ??
              row.realizedNetR ??
              row.realizedR ??
              row.r
    ));


    return (
         hasR &&
         ['VIRTUAL', 'SHADOW'].includes(source) &&
         rowMeasurementFixVersion(row) === MEASUREMENT_FIX_VERSION
    );
}


function measurementAggregateIntegrity(row = {}) {
    const counts = outcomeCounts(row);
    const completed = Math.max(counts.total, 0);
    const acceptedOutcomeCount = Math.max(
         0,
         num(row.measurementVersionAcceptedOutcomeCount, 0)
    );


    const recentOutcomes = Array.isArray(row.recentOutcomes)
         ? row.recentOutcomes
         : [];


    const nonCurrentRecentOutcomeCount = recentOutcomes
         .filter((outcome) => !isCurrentMeasurementOutcome(outcome))
         .length;


    const currentVersion =
         rowMeasurementFixVersion(row) === MEASUREMENT_FIX_VERSION;


    return {
         valid:
             currentVersion &&
             (completed <= 0 || acceptedOutcomeCount >= completed) &&
             nonCurrentRecentOutcomeCount === 0,
         currentVersion,
         completed,
         acceptedOutcomeCount,
         recentOutcomeCount: recentOutcomes.length,
         nonCurrentRecentOutcomeCount
    };
}


function completedSample(row = {}) {
    const integrity = measurementAggregateIntegrity(row);


    if (hasStoredOutcomeData(row) && !integrity.valid) {
         return 0;
    }


    return integrity.completed;
}


function observationSample(row = {}) {
    return Math.max(
         num(row.seen, 0),
         num(row.observations, 0),
         completedSample(row),
         0
    );
}


function totalR(row = {}) {
    const completed = completedSample(row);


    if (completed <= 0) return 0;


    const virtualShadowTotalR =
         num(row.virtualTotalR, 0) +
         num(row.shadowTotalR, 0);


    if (virtualShadowTotalR !== 0 || hasVirtualShadowOutcomeFields(row)) {
        return virtualShadowTotalR;
    }


    if (hasValue(row.longNetTotalR)) return num(row.longNetTotalR, 0);
    if (hasValue(row.netLongTotalR)) return num(row.netLongTotalR, 0);
    if (hasValue(row.netTotalR)) return num(row.netTotalR, 0);
    if (hasValue(row.totalNetR)) return num(row.totalNetR, 0);
    if (hasValue(row.totalR)) return num(row.totalR, 0);


    if (Array.isArray(row.recentOutcomes)) {
        return row.recentOutcomes
          .filter(Boolean)
          .filter(isCurrentMeasurementOutcome)
          .filter((outcome) => inferTradeSide({ ...row, ...outcome }) !==
OPPOSITE_TRADE_SIDE)
          .reduce((sum, outcome) => sum + outcomeNetR(outcome), 0);
    }


    return 0;
}


function avgR(row = {}) {
    const completed = completedSample(row);


    if (completed <= 0) return 0;


    return totalR(row) / completed;
}


function totalCostR(row = {}) {
    const completed = completedSample(row);


    if (completed <= 0) return 0;


    const virtualShadowCost =
        num(row.virtualTotalCostR, 0) +
        num(row.shadowTotalCostR, 0);


    if (virtualShadowCost > 0 || hasVirtualShadowOutcomeFields(row)) return
virtualShadowCost;


    if (hasValue(row.totalCostR)) return num(row.totalCostR, 0);
    if (hasValue(row.avgCostR)) return num(row.avgCostR, 0) * completed;


    return 0;
}
function avgCostR(row = {}) {
    const completed = completedSample(row);


    if (completed <= 0) return 0;


    return totalCostR(row) / completed;
}


function empiricalActivationGate(row = {}) {
    const completed = completedSample(row);
    const averageR = avgR(row);
    const netTotalR = totalR(row);
    const measurementVersion =
        rowMeasurementFixVersion(row) ||
        MEASUREMENT_FIX_VERSION;


    if (completed < EMPIRICAL_VETO_MIN_COMPLETED) {
        return {
             status: 'OBSERVING',
             blocked: false,
             discordEligible: true,
             reason: `COMPLETED_BELOW_${EMPIRICAL_VETO_MIN_COMPLETED}`,
             completed,
             minCompleted: EMPIRICAL_VETO_MIN_COMPLETED,
             avgR: averageR,
             totalR: netTotalR,
             maxAvgR: EMPIRICAL_VETO_MAX_AVG_R,
             measurementVersion
        };
    }


    if (averageR <= EMPIRICAL_VETO_MAX_AVG_R) {
        return {
             status: 'EMPIRICAL_VETO',
             blocked: true,
             discordEligible: false,
             reason: 'CURRENT_MEASUREMENT_NET_EDGE_NOT_POSITIVE',
             completed,
             minCompleted: EMPIRICAL_VETO_MIN_COMPLETED,
             avgR: averageR,
             totalR: netTotalR,
             maxAvgR: EMPIRICAL_VETO_MAX_AVG_R,
             measurementVersion
        };
    }


    return {
         status: 'PASSED',
         blocked: false,
         discordEligible: true,
         reason: null,
         completed,
         minCompleted: EMPIRICAL_VETO_MIN_COMPLETED,
         avgR: averageR,
         totalR: netTotalR,
         maxAvgR: EMPIRICAL_VETO_MAX_AVG_R,
         measurementVersion
    };
}


function isEmpiricallyVetoed(row = {}) {
    return empiricalActivationGate(row).blocked === true;
}


function marketBiasHaystack(row = {}) {
    return [
         row.currentMarketTrendSide,
         row.marketTrendSide,
         row.trendSide,
         row.dashboardSide,
         row.marketSide,
         row.marketBias,
         row.bias,
         row.direction,
         row.currentRegime,
         row.marketRegime,
         row.regime,
         row.currentFitReason,
         ...(Array.isArray(row.currentFitReasons) ? row.currentFitReasons : [])
    ]
         .map((value) => upper(value))
         .join(' | ');
}


function currentFitLabel(score = 0, fallback = 'UNKNOWN') {
    if (!Number.isFinite(score)) return fallback || 'UNKNOWN';
    if (score >= 45) return 'FIT';
    if (score >= 20) return 'OK';
    if (score <= -20) return 'MISFIT';


    return 'NEUTRAL';
}


function getLongCurrentFit(row = {}) {
const explicitLong = firstFiniteNumber([
    row.longCurrentFit,
    row.bullCurrentFit,
    row.currentFitLong,
    row.currentFitBull,
    row.longFitScore,
    row.bullFitScore
]);


if (explicitLong !== null) {
    return {
         score: explicitLong,
         label: currentFitLabel(explicitLong, row.currentFit || 'UNKNOWN'),
         source: 'EXPLICIT_LONG_OR_BULL_CURRENT_FIT'
    };
}


const explicitShort = firstFiniteNumber([
    row.shortCurrentFit,
    row.bearCurrentFit,
    row.bearishCurrentFit,
    row.currentFitShort,
    row.currentFitBear,
    row.shortFitScore,
    row.bearFitScore
]);


if (explicitShort !== null) {
    const score = -Math.abs(explicitShort);


    return {
         score,
         label: currentFitLabel(score, row.currentFit || 'UNKNOWN'),
         source: 'INVERTED_SHORT_OR_BEAR_CURRENT_FIT'
    };
}


const rawFit = firstFiniteNumber([
    row.currentFitScore,
    row.fitScore,
    row.marketFitScore,
    row.marketFit,
    row.currentFitNumeric
]);


if (rawFit === null) {
    return {
              score: 0,
              label: row.currentFit || row.currentFitLabel || 'UNKNOWN',
              source: 'NO_NUMERIC_CURRENT_FIT'
         };
    }


    const haystack = marketBiasHaystack(row);
    let score;


    if (
         haystack.includes('BULL') ||
         haystack.includes('BULLISH') ||
         haystack.includes('LONG') ||
         haystack.includes('BUY') ||
         haystack.includes('UPSIDE')
    ) {
         score = Math.abs(rawFit);
    } else if (
         haystack.includes('BEAR') ||
         haystack.includes('BEARISH') ||
         haystack.includes('SHORT') ||
         haystack.includes('SELL') ||
         haystack.includes('DOWNSIDE')
    ) {
         score = -Math.abs(rawFit);
    } else {
         score = -rawFit;
    }


    return {
         score,
         label: currentFitLabel(score, row.currentFit || row.currentFitLabel ||
'UNKNOWN'),
         source: 'LONG_MIRRORED_GENERIC_CURRENT_FIT'
    };
}


function learningStatus(row = {}) {
    const completed = completedSample(row);
    const avgR = getLearningAvgR(row);


    if (completed >= EMPIRICAL_VETO_MIN_COMPLETED) {
         return avgR > EMPIRICAL_VETO_MAX_AVG_R
           ? 'PASSED'
           : 'EMPIRICAL_VETO';
    }
    if (completed >= MIN_COMPLETED_ACTIVE_LEARNING) return 'ACTIVE_LEARNING';
    if (completed > 0) return 'EARLY_OUTCOMES';


    return 'OBSERVING';
}


function eligibilityTier(row = {}) {
    const completed = completedSample(row);
    const observed = observationSample(row);
    const avgR = getLearningAvgR(row);


    if (completed >= EMPIRICAL_VETO_MIN_COMPLETED && avgR <= EMPIRICAL_VETO_MAX_AVG_R) {
         return 'EMPIRICAL_VETO';
    }
    if (completed >= EMPIRICAL_VETO_MIN_COMPLETED && avgR > EMPIRICAL_VETO_MAX_AVG_R) {
         return 'HARD';
    }
    if (completed >= MIN_COMPLETED_ACTIVE_LEARNING) return 'SOFT';
    if (completed > 0) return 'SOFT';
    if (observed > 0) return 'OBSERVATION';


    return 'RAW';
}


function learningQualityRank(row = {}) {
    const completed = completedSample(row);
    const observed = observationSample(row);


    if (isEmpiricallyVetoed(row)) return -1;
    if (completed >= MIN_COMPLETED_ACTIVE_LEARNING) return 3;
    if (completed > 0) return 2;
    if (observed > 0) return 1;


    return 0;
}


function normalizeRotationRow(row = {}, index = 0) {
    const trueMicroFamilyId = getTrueMicroFamilyId(row) || getMicroFamilyId(row);


    if (!isSelectableTrueMicroId(trueMicroFamilyId)) return null;


    const parsed = parseLongTaxonomyMicroId(trueMicroFamilyId);
    const rawSide = inferTradeSide({
      ...row,
      microFamilyId: trueMicroFamilyId,
      trueMicroFamilyId
    });


    if (rawSide === OPPOSITE_TRADE_SIDE) return null;


    const parentTrueMicroFamilyId = parsed.parentTrueMicroFamilyId;
    const counts = outcomeCounts(row);
    const completed = completedSample(row);
    const observed = observationSample(row);
    const gate = empiricalActivationGate(row);
    const computedTier = eligibilityTier(row);
    const tier = gate.blocked
      ? 'EMPIRICAL_VETO'
      : row.selectedTier || row.rotationEligibilityTier || computedTier;
    const risk = getLongRiskGeometry(row);
const fit = getLongCurrentFit(row);
const temporalContext = resolveRecordTemporalContext(row, now());


return {
  ...temporalContext,
  ...buildEntryExitTemporalMetadata(row),
  ...temporalStatsFields(row),
  ...temporalPolicyFlags(temporalContext),
  rank: index + 1,


  microFamilyId: trueMicroFamilyId,
  trueMicroFamilyId,
  analyzeMicroFamilyId: trueMicroFamilyId,
  learningMicroFamilyId: trueMicroFamilyId,
  childTrueMicroFamilyId: trueMicroFamilyId,


  parentTrueMicroFamilyId,
  coarseMicroFamilyId: parentTrueMicroFamilyId,
  baseMicroFamilyId: parentTrueMicroFamilyId,
  legacyMicroFamilyId: parentTrueMicroFamilyId,


  familyId: parentTrueMicroFamilyId,
  macroFamilyId: parentTrueMicroFamilyId,


  parentMacroFamilyId: parentTrueMicroFamilyId,
  parentMicroFamilyId: parentTrueMicroFamilyId,


  setupType: parsed.setup,
  regimeBucket: parsed.regime,
  confirmationProfile: parsed.confirmationProfile,


  ...modeFlags(),


  fixedTaxonomyLearningId: true,
  selectableTrueMicroFamily: true,
  trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
  broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,


  inferredTradeSide: rawSide === 'UNKNOWN' ? TARGET_TRADE_SIDE : rawSide,
  inferredFromLongOnlyMode: rawSide === 'UNKNOWN',


  schema: TRUE_MICRO_SCHEMA,
  microFamilySchema: TRUE_MICRO_SCHEMA,
  trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
  childTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
  parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
  version: row.version || null,


  measurementFixVersion:
    rowMeasurementFixVersion(row) ||
    MEASUREMENT_FIX_VERSION,
  acceptedOutcomeMeasurementVersion:
  row.acceptedOutcomeMeasurementVersion ||
  MEASUREMENT_FIX_VERSION,
completedCurrentMeasurementOnly: true,
strictOutcomeMeasurementGate: true,
legacyOutcomeMeasurementsExcluded: true,
exitFillModelVersion:
  row.exitFillModelVersion ||
  EXIT_FILL_MODEL_VERSION,
exitFillPolicy:
  row.exitFillPolicy ||
  'TP_SL_USE_TRIGGER_BOUNDARY_TIME_STOP_USES_OBSERVED_PRICE',


activationGateStatus: gate.status,
activationGateReason: gate.reason,
activationGatePassed: gate.status === 'PASSED',
activationGateStillRequiredDuringWeekend: true,
activationGateStillRequiredInEverySession: true,
weekendAndSessionCannotPromoteFamilyGate: true,
empiricalVeto: gate.blocked,
empiricalVetoed: gate.blocked,
empiricalVetoPolicyVersion: EMPIRICAL_VETO_POLICY_VERSION,
empiricalVetoMinCompleted: gate.minCompleted,
empiricalVetoMaxAvgR: gate.maxAvgR,
empiricalVetoCompleted: gate.completed,
empiricalVetoAvgR: round(gate.avgR, 4),
empiricalVetoTotalR: round(gate.totalR, 4),
empiricalVetoReason: gate.blocked ? gate.reason : null,
empiricalVetoBlocksAdaptiveSelection: true,
empiricalVetoBlocksManualActivation: true,
empiricalVetoCanRecover: true,
discordEligible: gate.discordEligible,
discordBlocked: gate.blocked,
discordBlockReason: gate.blocked
  ? 'EMPIRICAL_VETO_CURRENT_MEASUREMENT_NET_EDGE_NOT_POSITIVE'
  : null,


isTrueMicro: true,
isLegacyMacro: false,


seen: num(row.seen, 0),
observations: num(row.observations, 0),


completed: round(completed, 4),
virtualCompleted: round(row.virtualCompleted, 4),
shadowCompleted: round(row.shadowCompleted, 4),
realCompleted: 0,


currentMeasurementAggregateIntegrityValid:
  measurementAggregateIntegrity(row).valid,
currentMeasurementAcceptedOutcomeCount:
      measurementAggregateIntegrity(row).acceptedOutcomeCount,
    currentMeasurementNonCurrentRecentOutcomeCount:
      measurementAggregateIntegrity(row).nonCurrentRecentOutcomeCount,


    outcomeSample: round(completed, 4),
    observationSample: round(observed, 4),
    awaitingOutcomes: completed <= 0 && observed > 0,
    learningStatus: learningStatus(row),
    status: learningStatus(row),


    tooEarly: completed < MIN_COMPLETED_ACTIVE_LEARNING,
    tooEarlyReason: completed < MIN_COMPLETED_ACTIVE_LEARNING
      ? `COMPLETED_BELOW_${MIN_COMPLETED_ACTIVE_LEARNING}`
      : null,


    wins: round(counts.wins, 4),
    losses: round(counts.losses, 4),
    flats: round(counts.flats, 4),


    virtualWins: round(row.virtualWins, 4),
    virtualLosses: round(row.virtualLosses, 4),
    virtualFlats: round(row.virtualFlats, 4),


    shadowWins: round(row.shadowWins, 4),
    shadowLosses: round(row.shadowLosses, 4),
    shadowFlats: round(row.shadowFlats, 4),


    realWins: 0,
    realLosses: 0,
    realFlats: 0,


    winrate: round(row.winrate, 4),
    bayesianWinrate: round(row.bayesianWinrate, 4),
    wilsonLowerBound: round(row.wilsonLowerBound, 4),
    fairWinrate: round(row.fairWinrate ?? row.sampleAdjustedWinrate, 4),


    winrateSample: round(row.winrateSample ?? completed, 4),
    sampleAdjustedWinrate: round(row.sampleAdjustedWinrate, 4),
    sampleWilsonLowerBound: round(row.sampleWilsonLowerBound ??
row.wilsonLowerBound, 4),
    sampleReliability: round(row.sampleReliability, 4),


    avgR: round(avgR(row), 4),
    totalR: round(totalR(row), 4),


    virtualTotalR: round(row.virtualTotalR, 4),
    shadowTotalR: round(row.shadowTotalR, 4),
      realTotalR: 0,


      avgWinR: round(row.avgWinR, 4),
      avgLossR: round(row.avgLossR, 4),


      profitFactor: round(row.profitFactor, 4),


      directSLPct: round(row.directSLPct, 4),
      nearTpPct: round(row.nearTpPct, 4),
      reachedHalfRPct: round(row.reachedHalfRPct, 4),
      reachedOneRPct: round(row.reachedOneRPct, 4),


      beWouldExitPct: round(row.beWouldExitPct, 4),
      gaveBackAfterHalfRPct: round(row.gaveBackAfterHalfRPct, 4),
      gaveBackAfterOneRPct: round(row.gaveBackAfterOneRPct, 4),
      nearTpThenLossPct: round(row.nearTpThenLossPct, 4),


      totalCostR: round(totalCostR(row), 4),
      avgCostR: round(avgCostR(row), 4),


      balancedScore: round(row.balancedScore, 4),
      dashboardBalancedScore: round(row.dashboardBalancedScore ?? row.balancedScore,
4),


      currentFit: fit.label,
      currentFitLabel: fit.label,
      currentFitScore: round(fit.score, 4),
      fitScore: round(fit.score, 4),
      currentFitSource: fit.source,
      longCurrentFit: round(fit.score, 4),
      bullCurrentFit: round(fit.score, 4),
      bearishCurrentFit: round(-Math.abs(fit.score), 4),
      currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
      currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',


      entry: risk.entry ?? row.entry ?? null,
      entryPrice: risk.entry ?? row.entryPrice ?? null,
      sl: risk.initialSl ?? row.sl ?? null,
      initialSl: risk.initialSl ?? row.initialSl ?? null,
      tp: risk.tp ?? row.tp ?? null,
      validLongRiskShape: Boolean(risk.validGeometry),
      validLongGeometry: Boolean(risk.validGeometry),
      longTpHit: risk.longTpHit,
      longSlHit: risk.longSlHit,
      tpHit: risk.longTpHit,
      slHit: risk.longSlHit,
      longGrossR: risk.longGrossR === null ? null : round(risk.longGrossR, 4),
      longCurrentR: risk.longCurrentR === null ? null : round(risk.longCurrentR,
4),
      currentR: risk.longCurrentR === null ? row.currentR ?? null :
round(risk.longCurrentR, 4),
      riskGeometryRule: risk.riskGeometryRule,
      tpHitRule: risk.tpHitRule,
      slHitRule: risk.slHitRule,
      grossRFormula: risk.grossRFormula,
      currentRFormula: risk.currentRFormula,


      selectedTier: tier,
      rotationEligibilityTier: tier,


      assetClass: row.assetClass || null,


      rsiZone: row.rsiZone || null,
      rsiCoarse: row.rsiCoarse || null,


      flow: row.flow || null,
      flowCoarse: row.flowCoarse || null,


      obRelation: row.obRelation || null,


      btcState: row.btcState || null,
      btcRelation: row.btcRelation || null,


      regime: row.regime || null,
      regimeCoarse: row.regimeCoarse || null,


      scannerReason: row.scannerReason || null,
      scannerReasonCoarse: row.scannerReasonCoarse || null,


      scannerMicroFamilyId: row.scannerMicroFamilyId || null,
      scannerFamilyId: row.scannerFamilyId || null,
      scannerDefinition: row.scannerDefinition || null,
      scannerDefinitionParts: Array.isArray(row.scannerDefinitionParts)
        ? row.scannerDefinitionParts
        : [],


      scannerFingerprintRole: 'METADATA_ONLY',
      scannerFingerprintsMetadataOnly: true,
      scannerFingerprintsUsedAsLearningFamily: false,


      executionMicroFamilyId: row.executionMicroFamilyId || null,
      executionFingerprintHash: row.executionFingerprintHash || null,
      executionFingerprintParts: Array.isArray(row.executionFingerprintParts)
        ? row.executionFingerprintParts
           : [],
         executionFingerprintSchema: row.executionFingerprintSchema || null,
         executionFingerprintRole: 'METADATA_ONLY',
         executionFingerprintsMetadataOnly: true,
         executionFingerprintsUsedAsLearningFamily: false,


         definitionParts: getDefinitionParts(row),
         definition: row.definition || '',


         macroDefinitionParts: getMacroDefinitionParts(row),
         macroDefinition: row.macroDefinition || row.parentDefinition || '',


         sourceWeekKey: row.sourceWeekKey || PERSISTENT_LEARNING_KEY,
         sourceWeekPrimary: row.sourceWeekPrimary !== false,
         sourceWeekFallback: Boolean(row.sourceWeekFallback),


         createdAt: row.createdAt || null,
         updatedAt: row.updatedAt || null
    };
}


function compareRows(a = {}, b = {}) {
    return (
         learningQualityRank(b) - learningQualityRank(a) ||
         num(b.outcomeSample ?? completedSample(b), 0) - num(a.outcomeSample ??
completedSample(a), 0) ||
         num(b.dashboardBalancedScore, 0) - num(a.dashboardBalancedScore, 0) ||
         num(b.balancedScore, 0) - num(a.balancedScore, 0) ||
         num(b.fairWinrate, 0) - num(a.fairWinrate, 0) ||
         num(b.totalR, 0) - num(a.totalR, 0) ||
         num(b.avgR, 0) - num(a.avgR, 0) ||
         num(b.currentFitScore, 0) - num(a.currentFitScore, 0) ||
         num(b.observationSample, 0) - num(a.observationSample, 0) ||
         String(a.trueMicroFamilyId || a.microFamilyId ||
'').localeCompare(String(b.trueMicroFamilyId || b.microFamilyId || ''))
    );
}


function dedupeRows(rows = []) {
    const seen = new Set();
    const output = [];


    for (const row of rows) {
         const key = row?.trueMicroFamilyId || row?.microFamilyId;


         if (!key) continue;
         if (seen.has(key)) continue;
         if (!isLongRow(row)) continue;
         if (!isTrueMicroFamilyRow(row)) continue;


         seen.add(key);
         output.push(row);
    }


    return output;
}


async function loadAvailableRows({
    weekKey,
    includePrevious = true,
    limit = DEFAULT_AVAILABLE_LIMIT
} = {}) {
    const requestedWeekKey = String(weekKey || PERSISTENT_LEARNING_KEY).trim();
    const currentWeekKey = PERSISTENT_LEARNING_KEY;
    const previousWeekKey = PERSISTENT_LEARNING_KEY;


    const current = await getWeekMicros(PERSISTENT_LEARNING_KEY).catch(() => ({}));


    const previous = includePrevious && previousWeekKey !== currentWeekKey
         ? await getWeekMicros(previousWeekKey).catch(() => ({}))
         : {};


    const merged = {
         ...(previous || {}),
         ...(current || {})
    };


    const rows = sourceEntries(merged)
         .map(([key, row], index) => {
           const rowId = getTrueMicroFamilyId(row, getMicroFamilyId(row, key));
           const currentHasKey = Boolean(current?.[key] || current?.[rowId]);
           const previousHasKey = Boolean(previous?.[key] || previous?.[rowId]);


           return normalizeRotationRow({
             ...(row || {}),
             key,
             microFamilyId: rowId,
             trueMicroFamilyId: rowId,
             analyzeMicroFamilyId: rowId,
             learningMicroFamilyId: rowId,
             sourceWeekKey: row?.sourceWeekKey || PERSISTENT_LEARNING_KEY,
             sourceWeekPrimary: currentHasKey || !previousHasKey,
             sourceWeekFallback: Boolean(!currentHasKey && previousHasKey)
           }, index);
         })
         .filter(Boolean)
         .filter(isLongRow)
         .filter(isTrueMicroFamilyRow)
         .sort(compareRows);


    return {
         requestedWeekKey,
         currentWeekKey,
         previousWeekKey,
         queryWeekKeyIgnored: requestedWeekKey !== PERSISTENT_LEARNING_KEY
              ? requestedWeekKey
              : null,
         currentRows: sourceEntries(current).length,
         previousRows: sourceEntries(previous).length,
         mergedRows: rows.length,
         rows: dedupeRows(rows).slice(0, limit)
    };
}


function extractIdsFromRotation(rotation = {}) {
    const rows = Array.isArray(rotation?.microFamilies)
         ? rotation.microFamilies
         : [];


    return uniqueStrings([
         rotation?.microFamilyIds || [],
         rotation?.activeMicroFamilyIds || [],
         rotation?.trueMicroFamilyIds || [],
         rotation?.ids || [],
         rows.map((row) => getTrueMicroFamilyId(row, getMicroFamilyId(row)))
    ]).filter(isSelectableTrueMicroId);
}


function extractMacroIdsFromRotation(rotation = {}) {
    const rows = Array.isArray(rotation?.microFamilies)
         ? rotation.microFamilies
         : [];


    return uniqueStrings([
         rotation?.macroFamilyIds || [],
         rotation?.activeMacroFamilyIds || [],
         rows.map((row) => getMacroFamilyId(row))
    ])
         .filter(validLearningId)
         .filter(isFixedLongParentMicroId);
}
function manualActiveRowFromId(id, index = 0) {
    if (!id || !isSelectableTrueMicroId(id)) return null;


    const parsed = parseLongTaxonomyMicroId(id);


    return normalizeRotationRow({
      microFamilyId: id,
      trueMicroFamilyId: id,
      analyzeMicroFamilyId: id,
      learningMicroFamilyId: id,
      childTrueMicroFamilyId: id,
      parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
      coarseMicroFamilyId: parsed.parentTrueMicroFamilyId,
      trueMicro: true,
      isTrueMicro: true,
      active: true,
      fixedTaxonomyLearningId: true,
      trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
      broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
      selectedTier: 'RAW',
      rotationEligibilityTier: 'RAW',
      seen: 0,
      observations: 0,
      completed: 0,
      virtualCompleted: 0,
      shadowCompleted: 0,
      wins: 0,
      losses: 0,
      flats: 0,
      virtualWins: 0,
      virtualLosses: 0,
      virtualFlats: 0,
      shadowWins: 0,
      shadowLosses: 0,
      shadowFlats: 0,
      totalR: 0,
      avgR: 0,
      totalCostR: 0,
      avgCostR: 0
    }, index);
}


function compactActiveRotation(rotation = null) {
    if (!rotation || typeof rotation !== 'object') return null;


    const requestedActiveMicroFamilyIds = extractIdsFromRotation(rotation);
const requestedActiveMacroFamilyIds = extractMacroIdsFromRotation(rotation);
const explicitlyRemovedIds = new Set(
     uniqueStrings(rotation.empiricalVetoRemovedMicroFamilyIds || [])
);


const rowList = Array.isArray(rotation.microFamilies)
     ? rotation.microFamilies
     : [];


const normalizedRows = rowList
     .map((row, index) => normalizeRotationRow(row, index))
     .filter(Boolean)
     .filter(isLongRow)
     .filter(isTrueMicroFamilyRow);


const vetoedRows = normalizedRows.filter(
     (row) => row.empiricalVeto === true ||
         row.empiricalVetoed === true ||
         row.discordBlocked === true
);


const rows = normalizedRows.filter(
     (row) => !(
         row.empiricalVeto === true ||
         row.empiricalVetoed === true ||
         row.discordBlocked === true
     )
);


const vetoedIds = new Set([
     ...explicitlyRemovedIds,
     ...vetoedRows
         .map((row) => row.trueMicroFamilyId || row.microFamilyId)
         .filter(Boolean)
]);


const existing = new Set(
     rows
         .map((row) => row.trueMicroFamilyId || row.microFamilyId)
         .filter(Boolean)
);


for (const id of requestedActiveMicroFamilyIds) {
     if (existing.has(id)) continue;
     if (vetoedIds.has(id)) continue;


     const manualRow = manualActiveRowFromId(id, rows.length);
     if (!manualRow) continue;


     rows.push(manualRow);
     existing.add(id);
}


rows.sort(compareRows);


const activeMicroFamilyIds = uniqueStrings(
     rows.map((row) => row.trueMicroFamilyId || row.microFamilyId)
).filter(isSelectableTrueMicroId);


const activeMacroFamilyIds = uniqueStrings([
     rows.map((row) => row.parentTrueMicroFamilyId),
     requestedActiveMacroFamilyIds.filter((parentId) =>
         rows.some((row) => row.parentTrueMicroFamilyId === parentId)
     )
])
     .filter(validLearningId)
     .filter(isFixedLongParentMicroId);


return {
     rotationId: rotation.rotationId || null,
     source: rotation.source || null,
     mode: rotation.mode || null,
     sourceWeekKey: rotation.sourceWeekKey || PERSISTENT_LEARNING_KEY,
     activeWeekKey: rotation.activeWeekKey || PERSISTENT_LEARNING_KEY,
     generatedAt: rotation.generatedAt || null,
     activatedAt: rotation.activatedAt || null,


     ...modeFlags(),


     taxonomy: taxonomyMeta(),


     manualOnly: true,
     adminSelected: true,
     autoRotation: false,
     liveSelectable: activeMicroFamilyIds.length > 0,


     empiricalVetoPolicyVersion: EMPIRICAL_VETO_POLICY_VERSION,
     empiricalVetoRemovedCount: vetoedIds.size,
     empiricalVetoRemovedMicroFamilyIds: [...vetoedIds],


     empty: activeMicroFamilyIds.length === 0,
     emptyReason: activeMicroFamilyIds.length === 0
         ? vetoedIds.size > 0
           ? 'ACTIVE_ROTATION_REMOVED_BY_EMPIRICAL_VETO'
             : 'NO_MANUAL_LONG_75_CHILD_TRUE_MICRO_SELECTION_ACTIVE'
           : null,


         microFamilyIds: activeMicroFamilyIds,
         activeMicroFamilyIds,
         trueMicroFamilyIds: activeMicroFamilyIds,


         macroFamilyIds: activeMacroFamilyIds,
         activeMacroFamilyIds,


         microFamilies: rows,


         count: activeMicroFamilyIds.length,
         activeCount: activeMicroFamilyIds.length,


         bestLong: rows[0] || null,
         bestShort: null,
         missingSides: activeMicroFamilyIds.length ? [] : [TARGET_TRADE_SIDE]
    };
}


function parseSelectedIds(body = {}) {
    const microFamilyIds = uniqueStrings([
         body.microFamilyIds,
         body.activeMicroFamilyIds,
         body.trueMicroFamilyIds,
         body.ids,
         body.id,
         body.microFamilyId,
         body.trueMicroFamilyId
    ]);


    const macroFamilyIds = uniqueStrings([
         body.macroFamilyIds,
         body.activeMacroFamilyIds,
         body.macroIds,
         body.macroFamilyId,
         body.parentTrueMicroFamilyId,
         body.parentMicroFamilyId
    ]);


    const requestedIds = uniqueStrings([
         microFamilyIds,
         macroFamilyIds
    ]);


    const acceptedIds = microFamilyIds.filter(isSelectableTrueMicroId);
    const ignoredRequestedIds = requestedIds
         .filter((id) => !acceptedIds.includes(id))
         .map((id) => {
           const side = inferTradeSide(id);
           const parsed = parseLongTaxonomyMicroId(id);
           const isMacroRequest = macroFamilyIds.includes(id) || parsed.isParent;


           return {
                id,
                reason: side === OPPOSITE_TRADE_SIDE
                  ? 'SHORT_DISABLED_LONG_ONLY'
                  : isMacroRequest
                      ?
'PARENT_OR_MACRO_ID_REJECTED_EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_REQUIRED'
                      : isScannerFingerprintId(id)
                          ? 'SCANNER_FINGERPRINT_METADATA_ONLY_NOT_SELECTABLE'
                          : isExecutionFingerprintId(id)
                            ? 'EXECUTION_FINGERPRINT_METADATA_ONLY_NOT_SELECTABLE'
                            : parsed.valid && !parsed.selectable
                              ? 'PARENT_15_ID_REJECTED_SELECT_75_CHILD_ID'
                              : 'UNKNOWN_OR_NON_SELECTABLE_LONG_TRUE_MICRO_ID_REJECTED'
           };
         });


    return {
         requestedIds,
         microFamilyIds: acceptedIds,
         macroFamilyIds: [],
         requestedMacroFamilyIds: macroFamilyIds,
         acceptedIds,
         ignoredRequestedIds
    };
}


function normalizeAction(body = {}) {
    const raw = String(body?.action || '').trim();


    if (raw) return raw;


    const ids = parseSelectedIds(body);


    if (ids.acceptedIds.length > 0) return 'activateSelectedMicroFamilies';


    return '';
}
function buildTierSummary(rows = []) {
    return rows.reduce((acc, row) => {
         const tier = row.empiricalVeto === true
           ? 'EMPIRICAL_VETO'
           : row.rotationEligibilityTier || row.selectedTier || eligibilityTier(row);


         acc.total += 1;
         acc[tier] = (acc[tier] || 0) + 1;


         return acc;
    }, {
         total: 0,
         HARD: 0,
         SOFT: 0,
         OBSERVATION: 0,
         RAW: 0,
         EMPIRICAL_VETO: 0
    });
}


async function resolveSelectedIdsForActivation({
    selected,
    action
}) {
    const microFamilyIds = uniqueStrings(selected.microFamilyIds)
         .filter(isSelectableTrueMicroId);


    return {
         microFamilyIds,
         macroFamilyIds: [],
         requestedMacroFamilyIds: selected.requestedMacroFamilyIds || [],
         expandedFromMacro: [],
         unresolvedMacroFamilyIds: selected.requestedMacroFamilyIds || [],
         macroExpansionDisabled: action === 'activateSelectedMacroFamilies' ||
           (selected.requestedMacroFamilyIds || []).length > 0,
         parentExpansionDisabled: true,
         matchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
         selectionRule: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY'
    };
}


async function handleGet(req, res) {
    const startedAt = now();


    // Parse the querystring with the WHATWG URL API instead of relying on
    // the runtime's legacy query getter. This avoids url.parse() entirely.
    const requestHost = String(req?.headers?.host || 'localhost').trim() || 'localhost';
    const requestUrl = new URL(
         String(req?.url || '/api/admin/rotation'),
         `https://${requestHost}`
    );
    const queryValue = (name, fallback = null) => {
         const value = requestUrl.searchParams.get(String(name));
         return value === null || value === undefined || value === ''
              ? fallback
              : value;
    };


    const requestedWeekKey = String(
         firstValue(queryValue('weekKey', PERSISTENT_LEARNING_KEY), PERSISTENT_LEARNING_KEY)
    ).trim();
const availableLimit = toLimit(
     firstValue(queryValue('availableLimit', DEFAULT_AVAILABLE_LIMIT), DEFAULT_AVAILABLE_LIMIT),
     DEFAULT_AVAILABLE_LIMIT,
     MAX_AVAILABLE_LIMIT
);


const activeRowsLimit = toLimit(
     firstValue(queryValue('activeRowsLimit', DEFAULT_ACTIVE_ROWS_LIMIT), DEFAULT_ACTIVE_ROWS_LIMIT),
     DEFAULT_ACTIVE_ROWS_LIMIT,
     MAX_ACTIVE_ROWS_LIMIT
);


const includeAvailable = isTrue(
     firstValue(queryValue('includeAvailable', true), true),
     true
);


const includePrevious = isTrue(
     firstValue(queryValue('includePrevious', true), true),
     true
);


// Mobile/admin compact mode intentionally skips the heavy rotation dashboard.
// Default GET behaviour remains unchanged for existing callers.
const compact = isTrue(
     firstValue(queryValue('compact', false), false),
     false
);


const [dashboard, activeRotation, availableResult] = await Promise.all([
     compact
       ? Promise.resolve(null)
       : getRotationDashboard({
           tradeSide: TARGET_TRADE_SIDE,
           side: TARGET_DASHBOARD_SIDE,
           weekKey: PERSISTENT_LEARNING_KEY,
           namespace: LONG_NAMESPACE,
           keyPrefix: LONG_KEY_PREFIX,
           trueMicroOnly: true,
           exactTrueMicroOnly: true,
           trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
           learningGranularity: LEARNING_GRANULARITY
         }).catch(() => null),


     getActiveRotation({
       tradeSide: TARGET_TRADE_SIDE,
       side: TARGET_DASHBOARD_SIDE,
       weekKey: PERSISTENT_LEARNING_KEY,
       namespace: LONG_NAMESPACE,
       keyPrefix: LONG_KEY_PREFIX,
       trueMicroOnly: true,
       exactTrueMicroOnly: true,
       trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
       learningGranularity: LEARNING_GRANULARITY
     }).catch(() => null),
  (!compact && includeAvailable)
      ? loadAvailableRows({
           weekKey: requestedWeekKey,
           includePrevious,
           limit: availableLimit
      }).catch((error) => ({
           requestedWeekKey,
           currentWeekKey: PERSISTENT_LEARNING_KEY,
           previousWeekKey: PERSISTENT_LEARNING_KEY,
           queryWeekKeyIgnored: requestedWeekKey !== PERSISTENT_LEARNING_KEY
             ? requestedWeekKey
             : null,
           currentRows: 0,
           previousRows: 0,
           mergedRows: 0,
           rows: [],
           warning: error?.message || String(error)
      }))
      : Promise.resolve({
           requestedWeekKey,
           currentWeekKey: PERSISTENT_LEARNING_KEY,
           previousWeekKey: PERSISTENT_LEARNING_KEY,
           queryWeekKeyIgnored: requestedWeekKey !== PERSISTENT_LEARNING_KEY
             ? requestedWeekKey
             : null,
           currentRows: 0,
           previousRows: 0,
           mergedRows: 0,
           rows: []
      })
]);


const active = compactActiveRotation(activeRotation);
const availableRows = availableResult.rows || [];


return res.status(200).json({
  ok: true,
  compact,


  ...modeFlags(),


  taxonomy: taxonomyMeta(),


  currentWeekKey: PERSISTENT_LEARNING_KEY,
  previousWeekKey: PERSISTENT_LEARNING_KEY,
  requestedWeekKey,
  queryWeekKeyIgnored: availableResult.queryWeekKeyIgnored || null,
persistentLearningKey: PERSISTENT_LEARNING_KEY,


activeRowsLimit,
availableLimit,
includeAvailable: compact ? false : includeAvailable,
includePrevious: compact ? false : includePrevious,


activeRotation: active,
active,


activeRotationId: active?.rotationId || null,
activeMicroFamilyIds: active?.activeMicroFamilyIds || [],
activeMacroFamilyIds: active?.activeMacroFamilyIds || [],


activeRows: (active?.microFamilies || []).slice(0, activeRowsLimit),
activeCount: active?.activeMicroFamilyIds?.length || 0,


dashboard: compact ? null : (dashboard || null),
nextRotation: compact ? null : (dashboard?.next || dashboard?.nextRotation || null),
nextRotationStoredOnly: true,
nextRotationAutoActivationDisabled: true,


availableMicroFamilies: availableRows,
availableRows,
availableCount: availableRows.length,


availableTierSummary: buildTierSummary(availableRows),
availableEmpiricalVetoCount: availableRows.filter(
     (row) => row.empiricalVeto === true
).length,
availableEmpiricalVetoMicroFamilyIds: availableRows
     .filter((row) => row.empiricalVeto === true)
     .map((row) => row.trueMicroFamilyId)
     .filter(Boolean),


sourceRows: {
     currentWeekRows: availableResult.currentRows,
     previousWeekRows: availableResult.previousRows,
     mergedRows: availableResult.mergedRows,
     warning: availableResult.warning || null
},


allowedActions: ALLOWED_ACTIONS,
blockedAutoActions: [...BLOCKED_AUTO_ACTIONS],


buttons: {
     selectExact75Child: true,
             selectParent15Disabled: true,
             copy: true,
             activateVisibleIdsForDiscord: true
        },


        perf: {
             durationMs: now() - startedAt,
             source:
'long_manual_selection_only_exact_75_child_true_micro_rotation_dashboard'
        },


        serverTs: Date.now()
    });
}


async function handlePost(req, res) {
    const startedAt = now();
    const body = await readBody(req);
    const action = normalizeAction(body);


    if (!action) {
        return res.status(400).json({
             ok: false,
             reason: 'ACTION_REQUIRED',
             allowedActions: ALLOWED_ACTIONS,
             blockedAutoActions: [...BLOCKED_AUTO_ACTIONS],
             ...modeFlags()
        });
    }


    if (BLOCKED_AUTO_ACTIONS.has(action)) {
        return res.status(400).json({
             ok: false,
             reason: 'AUTO_ROTATION_DISABLED_MANUAL_SELECTION_ONLY',
             action,
             allowedActions: ALLOWED_ACTIONS,
             blockedAutoActions: [...BLOCKED_AUTO_ACTIONS],
             ...modeFlags()
        });
    }


    if (!ALLOWED_ACTIONS.includes(action)) {
        return res.status(400).json({
             ok: false,
             reason: 'UNKNOWN_OR_DISABLED_ACTION',
             action,
             allowedActions: ALLOWED_ACTIONS,
         blockedAutoActions: [...BLOCKED_AUTO_ACTIONS],
         ...modeFlags()
       });
  }


  const selected = parseSelectedIds(body);


  if (selected.acceptedIds.length === 0) {
       return res.status(400).json({
         ok: false,
         reason: selected.ignoredRequestedIds.some((row) => row.reason ===
'SHORT_DISABLED_LONG_ONLY')
             ? 'SHORT_DISABLED_LONG_ONLY'
             : 'LONG_75_CHILD_TRUE_MICRO_FAMILY_IDS_REQUIRED',


         requestedIds: selected.requestedIds,
         ignoredRequestedIds: selected.ignoredRequestedIds,


         expectedFormat: 'MICRO_LONG_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',
         example: 'MICRO_LONG_BREAKOUT_TREND_A_STRONG_ALIGN',
         parentExampleRejected: 'MICRO_LONG_BREAKOUT_TREND',


         allowedActions: ALLOWED_ACTIONS,
         ...modeFlags()
       });
  }


  const requestedWeekKey = String(
       firstValue(body.weekKey, PERSISTENT_LEARNING_KEY)
  ).trim();


  const weekKey = PERSISTENT_LEARNING_KEY;


  const mode = normalizeMode(
       firstValue(body.mode, action === 'activateSelected' ? 'selected' : 'manual'),
       'manual'
  );


  const resolved = await resolveSelectedIdsForActivation({
       selected,
       action,
       weekKey
  });


  if (resolved.microFamilyIds.length === 0) {
       return res.status(400).json({
         ok: false,
      reason: 'NO_EXACT_LONG_75_CHILD_TRUE_MICRO_FAMILIES_RESOLVED',


      requestedMicroFamilyIds: selected.microFamilyIds,
      requestedMacroFamilyIds: selected.requestedMacroFamilyIds,
      requestedIds: selected.requestedIds,
      ignoredRequestedIds: selected.ignoredRequestedIds,
      unresolvedMacroFamilyIds: resolved.unresolvedMacroFamilyIds,
      macroExpansionDisabled: true,
      parentExpansionDisabled: true,


      ...modeFlags()
    });
}


const activation = await activateSelectedMicroFamilies({
    microFamilyIds: resolved.microFamilyIds,
    trueMicroFamilyIds: resolved.microFamilyIds,
    activeMicroFamilyIds: resolved.microFamilyIds,
    ids: resolved.microFamilyIds,


    macroFamilyIds: [],
    activeMacroFamilyIds: [],
    macroIds: [],


    weekKey,
    mode,


    tradeSide: TARGET_TRADE_SIDE,
    side: TARGET_DASHBOARD_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    namespace: LONG_NAMESPACE,
    keyPrefix: LONG_KEY_PREFIX,


    manualOnly: true,
    exactTrueMicroFamilyOnly: true,
    exactTrueMicroOnly: true,
    trueMicroOnly: true,
    selectableChildOnly: true,
    selectableIdsAreChildrenOnly: true,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,


    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,
     macroActivationExpansionDisabled: true,
     parentActivationExpansionDisabled: true,
     autoRotationActivationDisabled: true,


     discordOnlyForExactTrueMicroMatch: true,
     manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
     discordSelectionRule: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY'
});


const active = compactActiveRotation(activation);


const activationIgnoredRequestedIds = [
     ...selected.ignoredRequestedIds,
     ...(Array.isArray(activation?.ignoredRequestedIds)
       ? activation.ignoredRequestedIds
       : [])
];


const activationIgnoredIdSet = new Set(
     activationIgnoredRequestedIds
       .map((row) => upper(row?.normalizedId || row?.id))
       .filter(Boolean)
);


const acceptedRequestedIds = resolved.microFamilyIds
     .filter((id) => !activationIgnoredIdSet.has(upper(id)));


return res.status(200).json({
     ok: activation?.ok !== false,
     skipped: activation?.skipped === true,
     changed: activation?.changed === true,
     reason: activation?.reason || null,
     action,


     ...modeFlags(),


     taxonomy: taxonomyMeta(),


     weekKey,
     requestedWeekKey,
     queryWeekKeyIgnored: requestedWeekKey !== PERSISTENT_LEARNING_KEY
       ? requestedWeekKey
       : null,
     mode,


     requestedMicroFamilyIds: selected.microFamilyIds,
requestedMacroFamilyIds: selected.requestedMacroFamilyIds,
requestedIds: selected.requestedIds,


resolvedMicroFamilyIds: resolved.microFamilyIds,
resolvedTrueMicroFamilyIds: resolved.microFamilyIds,
resolvedMacroFamilyIds: [],
expandedFromMacro: [],
unresolvedMacroFamilyIds: resolved.unresolvedMacroFamilyIds,
macroExpansionDisabled: true,
parentExpansionDisabled: true,


acceptedIds: acceptedRequestedIds,
ignoredRequestedIds: activationIgnoredRequestedIds,


empiricalVetoPolicyVersion: EMPIRICAL_VETO_POLICY_VERSION,
empiricalVetoBlockedCount:
  num(activation?.empiricalVetoBlockedCount, 0),
empiricalVetoBlockedMicroFamilyIds:
  activation?.empiricalVetoBlockedMicroFamilyIds || [],
empiricalVetoRemovedFromActiveCount:
  num(active?.empiricalVetoRemovedCount, 0),
empiricalVetoRemovedFromActiveMicroFamilyIds:
  active?.empiricalVetoRemovedMicroFamilyIds || [],


activeRotation: active,
active,


activatedCount: active?.activeMicroFamilyIds?.length || 0,
activatedMicroCount: active?.activeMicroFamilyIds?.length || 0,
activatedMacroCount: 0,


activeMicroFamilyIds: active?.activeMicroFamilyIds || [],
activeMacroFamilyIds: active?.activeMacroFamilyIds || [],


bestLong: active?.bestLong || null,
bestShort: null,


discordEntryAlertsEnabledForSelectedMicroFamiliesOnly:
  (active?.activeMicroFamilyIds || []).length > 0,


noSelectionMeansNoDiscord:
  (active?.activeMicroFamilyIds || []).length === 0,


rawActivation: activation,


perf: {
  durationMs: now() - startedAt,
           source:
'activateSelectedLong75ChildTrueMicroFamilies_manual_only_exact_match'
      },


      serverTs: Date.now()
    });
}


export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('X-Admin-Rotation-Mode', 'long-only-manual-selection-exact-75-child-true-micro-v2-empirical-veto');
    res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
    res.setHeader('X-Long-Only', 'true');
    res.setHeader('X-Short-Disabled', 'true');
    res.setHeader('X-True-Micro-Only', 'true');
    res.setHeader('X-Exact-True-Micro-Only', 'true');
    res.setHeader('X-True-Micro-Family-Schema', TRUE_MICRO_SCHEMA);
    res.setHeader('X-Parent-True-Micro-Family-Schema', PARENT_TRUE_MICRO_SCHEMA);
    res.setHeader('X-Learning-Granularity', LEARNING_GRANULARITY);
    res.setHeader('X-Measurement-Fix-Version', MEASUREMENT_FIX_VERSION);
    res.setHeader('X-Accepted-Outcome-Measurement-Version',
MEASUREMENT_FIX_VERSION);
    res.setHeader('X-Exit-Fill-Model-Version', EXIT_FILL_MODEL_VERSION);
    res.setHeader('X-Empirical-Veto-Policy-Version', EMPIRICAL_VETO_POLICY_VERSION);
    res.setHeader('X-Empirical-Veto-Min-Completed',
String(EMPIRICAL_VETO_MIN_COMPLETED));
    res.setHeader('X-Empirical-Veto-Max-Avg-R', String(EMPIRICAL_VETO_MAX_AVG_R));
    res.setHeader('X-Empirical-Veto-Blocks-Manual-Activation', 'true');
    res.setHeader('X-Selectable-Child-Micro-Families', '75');
    res.setHeader('X-Parent-Micro-Families', '15');
    res.setHeader('X-Manual-Selection-Match-Mode', 'EXACT_TRUE_MICRO_FAMILY_ID');
    res.setHeader('X-Discord-Selection-Rule',
'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY');
    res.setHeader('X-Auto-Rotation-Disabled', 'true');
    res.setHeader('X-Virtual-Only', 'true');
    res.setHeader('X-Virtual-Learning-Forced', 'true');
    res.setHeader('X-Real-Orders-Disabled', 'true');
    res.setHeader('X-Bitget-Orders-Disabled', 'true');
    res.setHeader('X-Exchange-Calls-Disabled', 'true');
    res.setHeader('X-Persistent-Learning-Key', PERSISTENT_LEARNING_KEY);
    res.setHeader('X-Redis-Namespace', LONG_NAMESPACE);
    res.setHeader('X-Short-Root-Touched', 'false');


    try {
      if (req.method === 'GET') {
           return await handleGet(req, res);
        }


        if (req.method === 'POST') {
            return await handlePost(req, res);
        }


        return methodNotAllowed(res);
    } catch (error) {
        const status = error.statusCode || 500;


        return res.status(status).json({
            ok: false,


            ...modeFlags(),


            error: error?.message || String(error),
            stack: process.env.NODE_ENV === 'production'
              ? undefined
              : error?.stack
        });
    }
}
