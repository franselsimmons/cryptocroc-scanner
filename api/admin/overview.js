// ================= FILE: api/admin/overview.js =================


import { KEYS } from '../../src/keys.js';
import {
  getDurableRedis,
  getVolatileRedis,
  getJson,
  readJsonLogs
} from '../../src/redis.js';
import {
  safeNumber,
  sideToTradeSide
} from '../../src/utils.js';
import { getOpenPositions } from '../../src/trade/positionEngine.js';
import { getWeekMicros } from '../../src/analyze/analyzeEngine.js';
import { getRotationDashboard } from '../../src/analyze/rotationEngine.js';


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



const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY';
const LEARNING_GRANULARITY =
'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';


const MIN_COMPLETED_ACTIVE_LEARNING = 20;

const EMPIRICAL_VETO_MIN_COMPLETED = 35;
const EMPIRICAL_VETO_MAX_AVG_R = 0;
const MEASUREMENT_FIX_VERSION =
'LONG_MEASUREMENT_FIX_TRIGGER_BOUNDARY_EXIT_FILL_V2';
const EXIT_FILL_MODEL_VERSION =
'LONG_TRIGGER_BOUNDARY_FILL_PLUS_COST_MODEL_V1';
const EMPIRICAL_VETO_POLICY_VERSION =
'LONG_EXACT_75_CHILD_NET_EDGE_VETO_V1';
const OUTCOME_MEASUREMENT_GATE_MODE = 'STRICT_EXACT_VERSION';



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



function callMaybeKey(value, fallback = null) {
     if (typeof value === 'function') {
         try {
             return value();
         } catch {
             return fallback;
         }
     }


     return value || fallback;
}


function namespacedLongKey(key, fallback = null) {
     let raw = String(callMaybeKey(key, fallback) || '').trim();


     if (!raw) return null;
     if (raw.startsWith(LONG_KEY_PREFIX)) return raw;
     if (raw.startsWith('SHORT:')) raw = raw.slice('SHORT:'.length);


     return `${LONG_KEY_PREFIX}${raw}`;
}


const LONG_KEYS = {
     scan: {
          latest: namespacedLongKey(
              KEYS.long?.scan?.latest ||
                KEYS.scan?.longLatest ||
                KEYS.scan?.latest,
              'SCAN:LATEST'
          )
     },


     trade: {
          runMeta: namespacedLongKey(
              KEYS.long?.trade?.runMeta ||
                KEYS.trade?.longRunMeta ||
                KEYS.trade?.runMeta,
              'TRADE:RUN_META'
          )
     },


     discord: {
          logList: namespacedLongKey(
              KEYS.long?.discord?.logList ||
                KEYS.discord?.longLogList ||
                KEYS.discordLong?.logList ||
                KEYS.discord?.logList,
              'DISCORD:LOGS'
          )
     }
};


function methodNotAllowed(res) {
     res.setHeader('Allow', 'GET');


     return res.status(405).json({
          ok: false,
          error: 'METHOD_NOT_ALLOWED',
      allowed: ['GET'],
      ...modeFlags()
    });
}


function modeFlags() {
    return {
         ...temporalPolicyFlags(),
      persistentLearningKey: PERSISTENT_LEARNING_KEY,
      weekResetDisabled: true,
      isoWeekLearningDisabled: true,


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


      virtualOnly: true,
      virtualLearning: true,
      virtualLearningForced: true,
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
noRealOrders: true,
realOrdersDisabled: true,
bitgetOrdersDisabled: true,
exchangeOrdersDisabled: true,
exchangeCallsDisabled: true,


globalMaxOpenPositionsBlockDisabled: true,
maxOneOpenPositionPerSymbol: true,
oneOpenPositionPerSymbol: true,


tradePositionTimeStopMinDefault: 720,
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
coinNameExcludedFromLearningIdentity: true,
hashesExcludedFromLearningIdentity: true,


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
         manualSelectionRequired: true,
         manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
         discordSelectionRule: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY',
         autoRotationActivationDisabled: true,
         activateFreezeCronDisabled: true,
         resetCronDisabled: true,
         discordOnlyForSelectedMicroFamilies: true,
         discordOnlyForExactTrueMicroMatch: true,
         parentMatchDoesNotTriggerDiscord: true,
         macroMatchDoesNotTriggerDiscord: true,


         measurementFixVersion: MEASUREMENT_FIX_VERSION,
         acceptedOutcomeMeasurementVersion: MEASUREMENT_FIX_VERSION,
         outcomeMeasurementGateMode: OUTCOME_MEASUREMENT_GATE_MODE,
         completedCurrentMeasurementOnly: true,
         legacyOutcomeMeasurementsExcluded: true,
         exitFillModelVersion: EXIT_FILL_MODEL_VERSION,
         empiricalVetoEnabled: true,
         empiricalVetoPolicyVersion: EMPIRICAL_VETO_POLICY_VERSION,
         empiricalVetoMinCompleted: EMPIRICAL_VETO_MIN_COMPLETED,
         empiricalVetoMaxAvgR: EMPIRICAL_VETO_MAX_AVG_R,
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
              PASSED:
                `completed >= ${EMPIRICAL_VETO_MIN_COMPLETED} && avgR > ${EMPIRICAL_VETO_MAX_AVG_R}`,
              EMPIRICAL_VETO:
                `completed >= ${EMPIRICAL_VETO_MIN_COMPLETED} && avgR <= ${EMPIRICAL_VETO_MAX_AVG_R}`
         },

         redisNamespace: LONG_NAMESPACE,
         redisKeyPrefix: LONG_KEY_PREFIX,
         redisKeysSeparatedFromShortRoot: true,
         shortRootTouched: false,


         minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING
    };
}


function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') return Object.values(value);


    return [];
}


function safeObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
         ? value
         : {};
}
function sourceEntries(value = {}) {
    if (Array.isArray(value)) {
        return value.map((row, index) => [
          row?.trueMicroFamilyId ||
              row?.learningMicroFamilyId ||
              row?.analyzeMicroFamilyId ||
              row?.microFamilyId ||
              row?.id ||
              row?.key ||
              String(index),
          row
        ]);
    }


    if (value && typeof value === 'object') {
        return Object.entries(value);
    }


    return [];
}


function uniqueStrings(values = []) {
    return [...new Set(
        (Array.isArray(values) ? values : [])
          .flatMap((value) => Array.isArray(value) ? value : [value])
          .map((value) => String(value || '').trim())
          .filter(Boolean)
    )];
}


function upper(value) {
    return String(value || '').trim().toUpperCase();
}


function hasValue(value) {
    return value !== undefined && value !== null && value !== '';
}

function rowMeasurementFixVersion(row = {}) {
    return upper(
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

function currentMeasurementAggregateAllowed(row = {}) {
    const completed = Math.max(
         num(row.virtualCompleted, 0) + num(row.shadowCompleted, 0),
         num(row.completed, 0),
         num(row.outcomeSample, 0),
         0
    );

    const acceptedOutcomeCount = Math.max(
         num(row.measurementVersionAcceptedOutcomeCount, 0),
         0
    );

    return (
         rowMeasurementFixVersion(row) === MEASUREMENT_FIX_VERSION &&
         (completed <= 0 || acceptedOutcomeCount <= 0 || acceptedOutcomeCount >= completed)
    );
}


function num(value, fallback = 0) {
    const n = safeNumber(value, fallback);


    return Number.isFinite(n) ? n : fallback;
}


function round(value, decimals = 4) {
    return Number(num(value, 0).toFixed(decimals));
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


function firstFiniteNumber(values = []) {
    for (const value of flattenValues(values)) {
        if (value === undefined || value === null || value === '') continue;


        const n = Number(value);


        if (Number.isFinite(n)) return n;
    }


    return null;
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


function normalizeSignalText(value = '') {
    return cleanSideText(value)
      .replace(/[^A-Z0-9=:_|]+/g, '_')
      .replace(/^_+|_+$/g, '');
}


function hasSignalPattern(value = '', patterns = []) {
    const text = normalizeSignalText(value);


    if (!text) return false;


    return patterns.some((pattern) => (
      text === pattern ||
      text.startsWith(`${pattern}_`) ||
      text.endsWith(`_${pattern}`) ||
      text.includes(`_${pattern}_`) ||
      text.includes(`=${pattern}`) ||
      text.includes(`:${pattern}`) ||
      text.includes(`|${pattern}|`)
    ));
}


function hasShortSignal(text = '') {
    return hasSignalPattern(text, [
      'SHORT',
      'BEAR',
      'BEARISH',
      'SELL',
      'DOWN',
      'DOWNSIDE',
      'MICRO_SHORT',
      'SIDE_SHORT',
      'SIDE_BEAR',
        'SIDE_SELL',
        'TRADE_SIDE_SHORT',
        'TRADESIDE_SHORT',
        'POSITION_SIDE_SHORT',
        'POSITIONSIDE_SHORT',
        'DIRECTION_SHORT',
        'DIRECTION_BEAR',
        'DIRECTION_SELL'
    ]);
}


function hasLongSignal(text = '') {
    return hasSignalPattern(text, [
        'LONG',
        'BULL',
        'BULLISH',
        'BUY',
        'UP',
        'UPSIDE',
        'MICRO_LONG',
        'SIDE_LONG',
        'SIDE_BULL',
        'SIDE_BUY',
        'TRADE_SIDE_LONG',
        'TRADESIDE_LONG',
        'POSITION_SIDE_LONG',
        'POSITIONSIDE_LONG',
        'DIRECTION_LONG',
        'DIRECTION_BULL',
        'DIRECTION_BUY'
    ]);
}


function normalizeSideToken(value) {
    const raw = cleanSideText(value);


    if (!raw) return 'UNKNOWN';


    const direct = sideToTradeSide(raw);


    if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
    if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;


    if (['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'UPSIDE'].includes(raw)) {
        return TARGET_TRADE_SIDE;
    }
    if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE'].includes(raw)) {
        return OPPOSITE_TRADE_SIDE;
    }


    const shortHit = hasShortSignal(raw);
    const longHit = hasLongSignal(raw);


    if (longHit && !shortHit) return TARGET_TRADE_SIDE;
    if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;


    if (shortHit && longHit) {
        if (raw.includes('TRADE_SIDE=LONG') || raw.includes('TRADESIDE=LONG'))
return TARGET_TRADE_SIDE;
        if (raw.includes('TRADE_SIDE=SHORT') || raw.includes('TRADESIDE=SHORT')) return
OPPOSITE_TRADE_SIDE;
        if (raw.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
        if (raw.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
    }


    return 'UNKNOWN';
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


function isSelectableTrueMicroId(id = '') {
    const value = String(id || '').trim();


    if (!validLearningId(value)) return false;


    return isFixedLongChildMicroId(value);
}


function extractSnapshotId(value) {
    if (!value) return null;


    if (typeof value === 'string') {
        return value;
    }


    if (typeof value === 'object') {
        return (
             value.snapshotId ||
             value.id ||
             value.latestSnapshotId ||
             value.scanId ||
             null
        );
    }


    return null;
}


function getDefinitionHaystack(row = {}) {
    return [
        row.definition,
        row.microDefinition,
        row.macroDefinition,
        row.parentDefinition,
        ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
        ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
        ...(Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts : []),
        ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts :
[]),
        ...(Array.isArray(row.executionFingerprintParts) ?
row.executionFingerprintParts : [])
    ]
        .map((value) => cleanSideText(value))
        .join(' | ');
}


function inferTradeSide(input = {}) {
    if (typeof input === 'string') {
        const value = cleanSideText(input);


        if (!value) return 'UNKNOWN';


        const direct = normalizeSideToken(value);


        if (direct === TARGET_TRADE_SIDE || direct === OPPOSITE_TRADE_SIDE) {
            return direct;
        }


        const parsed = parseLongTaxonomyMicroId(value);
        if (parsed.valid) return TARGET_TRADE_SIDE;


        const shortSignal = hasShortSignal(value);
        const longSignal = hasLongSignal(value);


        if (longSignal && !shortSignal) return TARGET_TRADE_SIDE;
        if (shortSignal && !longSignal) return OPPOSITE_TRADE_SIDE;


        if (shortSignal && longSignal) {
            if (value.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
            if (value.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
        }


        return 'UNKNOWN';
    }


    const directSources = [
        input.tradeSide,
        input.side,
        input.positionSide,
        input.direction,
        input.signalSide,
        input.scannerSide,
        input.actualScannerSide,
        input.analysisSide,
        input.entrySide,
        input.bias,
        input.marketBias
];


for (const source of directSources) {
     const side = normalizeSideToken(source);


     if (side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE) {
         return side;
     }
}


const microFamilyId = cleanSideText(
     input.trueMicroFamilyId ||
         input.learningMicroFamilyId ||
         input.analyzeMicroFamilyId ||
         input.microFamilyId ||
         input.childTrueMicroFamilyId ||
         input.parentTrueMicroFamilyId ||
         input.coarseMicroFamilyId ||
         input.baseMicroFamilyId ||
         input.legacyMicroFamilyId ||
         input.id ||
         input.key
);


if (parseLongTaxonomyMicroId(microFamilyId).valid) return TARGET_TRADE_SIDE;
if (microFamilyId.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;


const definition = getDefinitionHaystack(input);
const shortSignal = hasShortSignal(definition);
const longSignal = hasLongSignal(definition);


if (longSignal && !shortSignal) return TARGET_TRADE_SIDE;
if (shortSignal && !longSignal) return OPPOSITE_TRADE_SIDE;


if (shortSignal && longSignal) {
     if (microFamilyId.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
     if (microFamilyId.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
}


if (input.longOnly === true || input.shortDisabled === true) {
     return TARGET_TRADE_SIDE;
}


if (input.shortOnly === true || input.longDisabled === true) {
     return OPPOSITE_TRADE_SIDE;
}
    return 'UNKNOWN';
}


function isLongRow(row = {}) {
    if (!row) return false;


    const id = String(
         row.trueMicroFamilyId ||
           row.learningMicroFamilyId ||
           row.analyzeMicroFamilyId ||
           row.microFamilyId ||
           row.coarseMicroFamilyId ||
           row.id ||
           row.key ||
           ''
    ).trim();


    if (id && isScannerFingerprintId(id)) return false;
    if (id && isExecutionFingerprintId(id)) return false;
    if (inferTradeSide(row) === OPPOSITE_TRADE_SIDE) return false;


    return true;
}


function isShortRow(row = {}) {
    return inferTradeSide(row) === OPPOSITE_TRADE_SIDE;
}


function getTrueMicroFamilyId(row = {}, key = '') {
    const candidates = [
         row.trueMicroFamilyId,
         row.learningMicroFamilyId,
         row.analyzeMicroFamilyId,
         row.childTrueMicroFamilyId,
         row.microFamilyId,
         row.id,
         row.key,
         key
    ];


    for (const candidate of candidates) {
         const id = String(candidate || '').trim();


         if (isSelectableTrueMicroId(id)) return id;
    }


    return null;
}


function getAnyMicroFamilyId(row = {}, key = '') {
    return (
         row.trueMicroFamilyId ||
         row.learningMicroFamilyId ||
         row.analyzeMicroFamilyId ||
         row.microFamilyId ||
         row.id ||
         row.key ||
         key ||
         null
    );
}


function getParentTrueMicroFamilyId(row = {}, key = '') {
    const childId = getTrueMicroFamilyId(row, key);
    const parsedChild = parseLongTaxonomyMicroId(childId);


    if (parsedChild.parentTrueMicroFamilyId) return
parsedChild.parentTrueMicroFamilyId;


    const candidates = [
         row.parentTrueMicroFamilyId,
         row.coarseMicroFamilyId,
         row.baseMicroFamilyId,
         row.legacyMicroFamilyId,
         row.parentMacroFamilyId,
         row.macroFamilyId,
         row.parentMicroFamilyId,
         row.parentFamilyId,
         row.familyId,
         row.macroId
    ];


    for (const candidate of candidates) {
         const id = String(candidate || '').trim();


         if (isFixedLongParentMicroId(id)) return id;
    }


    return null;
}


function filterLongRows(rows = []) {
    return (Array.isArray(rows) ? rows : [])
         .filter(Boolean)
         .filter(isLongRow);
}


function normalizeLongSide(row = {}) {
    const temporalContext = resolveRecordTemporalContext(row, now());

    return {
         ...row,
         ...temporalContext,
         ...buildEntryExitTemporalMetadata(row),
         ...temporalStatsFields(row),
         ...modeFlags(),
         ...temporalPolicyFlags(temporalContext),


         side: TARGET_DASHBOARD_SIDE,
         tradeSide: TARGET_TRADE_SIDE,
         positionSide: TARGET_TRADE_SIDE,
         direction: TARGET_TRADE_SIDE,


         inferredTradeSide: TARGET_TRADE_SIDE
    };
}


function countMapOrArray(value) {
    return sourceEntries(value)
         .filter(([key, row]) => {
              const id = getTrueMicroFamilyId(row, key);


              return Boolean(id && isLongRow({
                ...(row || {}),
                trueMicroFamilyId: id
              }));
         })
         .length;
}


function countShortMapOrArray(value) {
    return sourceEntries(value)
         .filter(([key, row]) => isShortRow({
              ...(row || {}),
              microFamilyId: getAnyMicroFamilyId(row, key)
         }))
         .length;
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


function isLearningOutcomeSource(source = '') {
    const value = upper(source || 'VIRTUAL');


    return value === 'VIRTUAL' || value === 'SHADOW' || value === 'PAPER' || value
=== '';
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


function aggregateRecentOutcomes(row = {}) {
    const outcomes = Array.isArray(row.recentOutcomes)
         ? row.recentOutcomes
         : [];


    return outcomes.reduce(
         (acc, outcome) => {
              if (!outcome || typeof outcome !== 'object') return acc;
              if (!isCurrentMeasurementOutcome(outcome)) return acc;
              if (!isLearningOutcomeSource(outcome.source || outcome.outcomeSource ||
'VIRTUAL')) return acc;
              if (!isLongRow({ ...row, ...outcome })) return acc;


              const netR = outcomeNetR(outcome);
              const costR = num(outcome.costR ?? outcome.avgCostR, 0);


              acc.completed += 1;
              acc.totalR += netR;
              acc.totalCostR += costR;


              if (netR > 0) acc.wins += 1;
              else if (netR < 0) acc.losses += 1;
              else acc.flats += 1;


              return acc;
         },
         {
              completed: 0,
              wins: 0,
              losses: 0,
              flats: 0,
              totalR: 0,
              totalCostR: 0
         }
    );
}


function getOutcomeCounts(row = {}) {
    const recent = aggregateRecentOutcomes(row);

    if (!currentMeasurementAggregateAllowed(row)) {
         return {
              wins: recent.wins,
              losses: recent.losses,
              flats: recent.flats,
              total: recent.completed
         };
    }


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
    if (
         wins + losses + flats <= 0 &&
         virtualShadowCompleted <= 0 &&
         aggregateCompleted <= 0 &&
         recent.completed > 0
    ) {
         return {
              wins: recent.wins,
              losses: recent.losses,
              flats: recent.flats,
              total: recent.completed
         };
    }


    const countedTotal = wins + losses + flats;
    const total = Math.max(
         countedTotal,
         virtualShadowCompleted,
         aggregateCompleted,
         recent.completed,
         0
    );


    const inferredFlats = Math.max(0, total - wins - losses);


    return {
         wins,
         losses,
         flats: Math.max(flats, inferredFlats),
         total
    };
}


function getOutcomeSample(row = {}) {
    return getOutcomeCounts(row).total;
}


function getObservationSample(row = {}) {
    return Math.max(
         num(row.seen, 0),
         num(row.observations, 0),
         getOutcomeSample(row),
         0
    );
}
function getTotalR(row = {}) {
    const completed = getOutcomeSample(row);
    const recent = aggregateRecentOutcomes(row);


    if (completed <= 0) return 0;
    if (!currentMeasurementAggregateAllowed(row)) return recent.totalR;


    const virtualShadowTotalR =
        num(row.virtualTotalR, 0) +
        num(row.shadowTotalR, 0);


    if (virtualShadowTotalR !== 0 || hasVirtualShadowOutcomeFields(row)) {
        return virtualShadowTotalR;
    }


    if (recent.completed > 0) return recent.totalR;


    if (hasValue(row.longNetTotalR)) return num(row.longNetTotalR, 0);
    if (hasValue(row.netLongTotalR)) return num(row.netLongTotalR, 0);
    if (hasValue(row.netTotalR)) return num(row.netTotalR, 0);
    if (hasValue(row.totalNetR)) return num(row.totalNetR, 0);
    if (hasValue(row.totalR)) return num(row.totalR, 0);


    return 0;
}


function getTotalCostR(row = {}) {
    const completed = getOutcomeSample(row);
    const recent = aggregateRecentOutcomes(row);


    if (completed <= 0) return 0;
    if (!currentMeasurementAggregateAllowed(row)) return recent.totalCostR;


    const virtualShadowCost =
        num(row.virtualTotalCostR, 0) +
        num(row.shadowTotalCostR, 0);


    if (virtualShadowCost > 0 || hasVirtualShadowOutcomeFields(row)) return
virtualShadowCost;


    if (recent.completed > 0 && recent.totalCostR > 0) return recent.totalCostR;


    if (hasValue(row.totalCostR)) return num(row.totalCostR, 0);
    if (hasValue(row.avgCostR)) return num(row.avgCostR, 0) * completed;


    return 0;
}


function getAvgR(row = {}) {
    const completed = getOutcomeSample(row);


    if (completed <= 0) return 0;


    return getTotalR(row) / completed;
}


function getAvgCostR(row = {}) {
    const completed = getOutcomeSample(row);


    if (completed <= 0) return 0;


    return getTotalCostR(row) / completed;
}


function tierForMicro(row = {}) {
    const completed = getOutcomeSample(row);
    const observed = getObservationSample(row);
    const avgR = getAvgR(row);


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


function statusForMicro(row = {}) {
    const completed = getOutcomeSample(row);
    const avgR = getAvgR(row);


    if (completed >= EMPIRICAL_VETO_MIN_COMPLETED) {
         return avgR > EMPIRICAL_VETO_MAX_AVG_R
           ? 'PASSED'
           : 'EMPIRICAL_VETO';
    }
    if (completed >= MIN_COMPLETED_ACTIVE_LEARNING) return 'ACTIVE_LEARNING';
    if (completed > 0) return 'EARLY_OUTCOMES';


    return 'OBSERVING';
}


function summarizeMicros(micros = {}) {
    const rows = sourceEntries(micros)
      .map(([key, row]) => {
        const trueMicroFamilyId = getTrueMicroFamilyId(row, key);
        const parentTrueMicroFamilyId = getParentTrueMicroFamilyId(row, key);


        return {
          ...(row || {}),
          trueMicroFamilyId,
          microFamilyId: trueMicroFamilyId,
          learningMicroFamilyId: trueMicroFamilyId,
          analyzeMicroFamilyId: trueMicroFamilyId,
                 parentTrueMicroFamilyId,
                 coarseMicroFamilyId: parentTrueMicroFamilyId
            };
       })
       .filter((row) => row.trueMicroFamilyId &&
isSelectableTrueMicroId(row.trueMicroFamilyId))
       .filter(isLongRow);


     const summary = rows.reduce((acc, row) => {
       const tier = tierForMicro(row);
       const status = statusForMicro(row);
       const completed = getOutcomeSample(row);
       const observed = getObservationSample(row);


       acc.rows += 1;
       acc.seen += num(row.seen, 0);
       acc.observations += num(row.observations, 0);
       acc.completed += completed;
       acc.totalR += getTotalR(row);
       acc.totalCostR += getTotalCostR(row);


       acc.tierCounts[tier] = (acc.tierCounts[tier] || 0) + 1;
       acc.statusCounts[status] = (acc.statusCounts[status] || 0) + 1;


       if (completed > 0) acc.completedFamilies += 1;
       if (
            completed >= MIN_COMPLETED_ACTIVE_LEARNING &&
            completed < EMPIRICAL_VETO_MIN_COMPLETED
       ) acc.activeLearningFamilies += 1;
       if (status === 'PASSED') acc.passedFamilies += 1;
       if (status === 'EMPIRICAL_VETO') acc.empiricalVetoFamilies += 1;
       if (completed > 0 && completed < MIN_COMPLETED_ACTIVE_LEARNING)
acc.earlyOutcomeFamilies += 1;
       if (observed > 0 && completed <= 0) acc.observationOnlyFamilies += 1;


       return acc;
     }, {
       rows: 0,
       seen: 0,
       observations: 0,
       completed: 0,
       totalR: 0,
       totalCostR: 0,
       completedFamilies: 0,
       activeLearningFamilies: 0,
       passedFamilies: 0,
       empiricalVetoFamilies: 0,
       earlyOutcomeFamilies: 0,
       observationOnlyFamilies: 0,
       tierCounts: {
            HARD: 0,
            SOFT: 0,
            OBSERVATION: 0,
            EMPIRICAL_VETO: 0,
               RAW: 0
          },
          statusCounts: {
               PASSED: 0,
               EMPIRICAL_VETO: 0,
               ACTIVE_LEARNING: 0,
               EARLY_OUTCOMES: 0,
               OBSERVING: 0
          }
     });


     return {
          ...summary,
          ...modeFlags(),


          selectableChildFamiliesWithRows: summary.rows,
          selectableChildFamiliesTotal: 75,
          parentFamiliesTotal: 15,


          seen: round(summary.seen, 4),
          observations: round(summary.observations, 4),
          completed: round(summary.completed, 4),
          totalR: round(summary.totalR, 4),
          totalCostR: round(summary.totalCostR, 4),
          avgR: summary.completed > 0 ? round(summary.totalR / summary.completed, 4) :
0,
          avgCostR: summary.completed > 0 ? round(summary.totalCostR /
summary.completed, 4) : 0
     };
}


function normalizeLatestScan(latestScan) {
     if (!latestScan || typeof latestScan !== 'object') {
          return null;
     }


     const rawCandidates = Array.isArray(latestScan.candidates)
          ? latestScan.candidates
          : [];


     const candidates = filterLongRows(rawCandidates)
          .map((row) => normalizeLongSide({
               ...row,
               source: row.source || 'SCANNER',
               scannerOnly: true,
               scannerFingerprintRole: 'METADATA_ONLY',
               scannerFingerprintsUsedAsLearningFamily: false
          }));
const createdAt = safeNumber(
     latestScan.createdAt ||
     latestScan.completedAt ||
     latestScan.ts ||
     latestScan.scannerTs,
     0
);


const snapshotAgeSec = createdAt > 0
     ? Math.max(0, Math.floor((now() - createdAt) / 1000))
     : null;

const temporalContext = resolveRecordTemporalContext(
     latestScan,
     createdAt || now()
);


const fallbackCandidatesCount = safeNumber(
     latestScan.longCandidatesCount ??
     latestScan.selectedTargetCandidateCount ??
     latestScan.scannerGateCandidatesCount ??
     latestScan.candidatesCount ??
     latestScan.count,
     0
);


const topSymbols = candidates.length > 0
     ? candidates
         .slice(0, 20)
         .map((row) => row.symbol || row.contractSymbol)
         .filter(Boolean)
     : Array.isArray(latestScan.topSymbols)
         ? latestScan.topSymbols.slice(0, 20)
         : [];


return {
     ...latestScan,
     ...temporalContext,
     ...buildEntryExitTemporalMetadata(latestScan),
     ...modeFlags(),
     ...temporalPolicyFlags(temporalContext),


     snapshotId: extractSnapshotId(latestScan),


     createdAt: createdAt || null,
     snapshotAgeSec,


     rawCandidatesCount: rawCandidates.length,


     candidatesCount: rawCandidates.length > 0
         ? candidates.length
         : fallbackCandidatesCount,


     longCandidatesCount: rawCandidates.length > 0
         ? candidates.length
              : fallbackCandidatesCount,


         shortCandidatesIgnored: rawCandidates.filter(isShortRow).length,


         scannerBucketsDebugMetadataOnly: true,
         scannerFingerprintsUsedAsLearningFamily: false,


         topSymbols,
         candidates
    };
}


function normalizeRotation(rotation) {
    if (!rotation || typeof rotation !== 'object') {
         return null;
    }


    const rawMicroFamilies = Array.isArray(rotation.microFamilies)
         ? rotation.microFamilies
         : [];


    const microFamilies = rawMicroFamilies
         .filter(isLongRow)
         .map((row) => {
              const trueMicroFamilyId = getTrueMicroFamilyId(row);
              const parentTrueMicroFamilyId = getParentTrueMicroFamilyId(row);


              return normalizeLongSide({
                ...row,
                trueMicroFamilyId,
                microFamilyId: trueMicroFamilyId,
                learningMicroFamilyId: trueMicroFamilyId,
                analyzeMicroFamilyId: trueMicroFamilyId,
                parentTrueMicroFamilyId,
                coarseMicroFamilyId: parentTrueMicroFamilyId,
                selectableTrueMicroFamily: Boolean(trueMicroFamilyId)
              });
         })
         .filter((row) => row.trueMicroFamilyId &&
isSelectableTrueMicroId(row.trueMicroFamilyId));


    const rowIds = microFamilies
         .map((row) => row.trueMicroFamilyId)
         .filter(Boolean);


    const explicitIds = uniqueStrings([
         ...(Array.isArray(rotation.microFamilyIds) ? rotation.microFamilyIds : []),
       ...(Array.isArray(rotation.activeMicroFamilyIds) ?
rotation.activeMicroFamilyIds : []),
       ...(Array.isArray(rotation.trueMicroFamilyIds) ? rotation.trueMicroFamilyIds :
[]),
       ...(Array.isArray(rotation.ids) ? rotation.ids : [])
  ]).filter(isSelectableTrueMicroId);


  const microFamilyIds = uniqueStrings([
       ...explicitIds,
       ...rowIds
  ]).filter(isSelectableTrueMicroId);


  const macroFamilyIds = uniqueStrings([
       ...(Array.isArray(rotation.macroFamilyIds) ? rotation.macroFamilyIds : []),
       ...(Array.isArray(rotation.activeMacroFamilyIds) ?
rotation.activeMacroFamilyIds : []),
       ...(Array.isArray(rotation.macroIds) ? rotation.macroIds : []),
       ...microFamilies.map((row) => row.parentTrueMicroFamilyId ||
row.coarseMicroFamilyId)
  ])
       .filter(validLearningId)
       .filter(isFixedLongParentMicroId);


  const bestLongRaw =
       rotation.bestLong ||
       microFamilies.find((row) => isLongRow(row)) ||
       null;


  const bestLong = bestLongRaw
       ? normalizeLongSide(bestLongRaw)
       : null;


  return {
       ...rotation,
       ...modeFlags(),


       sideMode: 'long_only',


       manualOnly: true,
       adminSelected: rotation.adminSelected === true || rotation.manualOnly ===
true,
       autoRotation: false,
       autoActivationDisabled: true,
       liveSelectable: Boolean(microFamilyIds.length > 0),


       exactTrueMicroOnly: true,
       selectableChildOnly: true,
         parentMatchDoesNotTriggerDiscord: true,
         macroMatchDoesNotTriggerDiscord: true,


         bestLong,
         bestShort: null,


         microFamilyIds,
         activeMicroFamilyIds: microFamilyIds,
         trueMicroFamilyIds: microFamilyIds,


         macroFamilyIds,
         activeMacroFamilyIds: macroFamilyIds,


         microFamilies,


         count: microFamilyIds.length || microFamilies.length,


         rawMicroFamiliesCount: rawMicroFamilies.length,
         shortMicroFamiliesIgnored: rawMicroFamilies.filter(isShortRow).length,


         missingSides: microFamilyIds.length || microFamilies.length
           ? []
           : [TARGET_TRADE_SIDE]
    };
}


function actionIsLearningVirtual(action = {}) {
    return Boolean(
         action.virtualOnly !== false ||
         action.virtualTracked !== false ||
         action.shadowOnly !== false ||
         action.learningOnly ||
         action.observationOnly ||
         action.analysisInputOnly ||
         action.source === 'VIRTUAL' ||
         action.source === 'SHADOW' ||
         action.shadowResult ||
         action.reason === 'LONG_RISK_INVALID' ||
         action.reason === 'RISK_ENGINE_EMPTY_LONG_RISK_OBSERVATION_ONLY'
    );
}


function normalizeTradeAction(action = {}) {
    const trueMicroFamilyId = getTrueMicroFamilyId(action);
    const parentTrueMicroFamilyId = getParentTrueMicroFamilyId(action);
    const riskGeometry = getLongRiskGeometry(action);
    return normalizeLongSide({
      ...action,


      source: action.source || 'VIRTUAL',


      trueMicroFamilyId,
      microFamilyId: trueMicroFamilyId,
      learningMicroFamilyId: trueMicroFamilyId,
      analyzeMicroFamilyId: trueMicroFamilyId,
      parentTrueMicroFamilyId,
      coarseMicroFamilyId: parentTrueMicroFamilyId,


      selectableTrueMicroFamily: Boolean(trueMicroFamilyId),


      virtualOnly: true,
      virtualTracked: true,
      learningOnly: true,
      realOrderPlaced: false,
      exchangeOrder: false,
      bitgetOrderPlaced: false,


      scannerScore: action.scannerScore ?? action.moveScore ?? null,


      validLongRiskShape: Boolean(riskGeometry.validGeometry),
      validLongGeometry: Boolean(riskGeometry.validGeometry),
      longTpHit: riskGeometry.longTpHit,
      longSlHit: riskGeometry.longSlHit,
      tpHit: riskGeometry.longTpHit,
      slHit: riskGeometry.longSlHit,
      longGrossR: riskGeometry.longGrossR,
      longCurrentR: riskGeometry.longCurrentR,
      currentR: riskGeometry.longCurrentR ?? action.currentR ?? null,


      learningAction: actionIsLearningVirtual(action),
      discordAlertEligible: Boolean(action.discordAlertEligible),
      selectedMicroFamilyAlert: Boolean(action.selectedMicroFamilyAlert),
      exactSelectedTrueMicroMatch: Boolean(action.exactSelectedTrueMicroMatch ||
action.selectedMicroFamilyAlert),
      discordAlertSent: Boolean(action.discordAlertSent ||
action.discordEntryAlertSent)
    });
}


function buildActionCounts(actions = []) {
    return actions.reduce((acc, row) => {
      const key = row?.action || row?.type || 'UNKNOWN';
        acc[key] = (acc[key] || 0) + 1;


        return acc;
    }, {});
}


function buildTradeSummary(tradeMeta) {
    if (!tradeMeta || typeof tradeMeta !== 'object') {
        return {
             lastRunAt: null,
             actionCounts: {},


             actions: 0,
             learningActions: 0,


             virtualEntries: 0,
             virtualWaits: 0,
             virtualExits: 0,
             shadowExits: 0,


             discordEligibleActions: 0,
             selectedMicroFamilyActions: 0,
             exactSelectedTrueMicroActions: 0,
             discordAlertsSent: 0,


             skippedNewEntries: null,
             reason: null,
             skipReason: null,


             ...modeFlags()
        };
    }


    const rawActions = Array.isArray(tradeMeta.actions)
        ? tradeMeta.actions
        : [];


    const rawLongActions = filterLongRows(rawActions);
    const allLongActions = rawLongActions.map(normalizeTradeAction);
    const learningActions = allLongActions.filter((row) => row.learningAction ||
row.virtualOnly);
    const shortActionsIgnored = rawActions.filter(isShortRow).length;


    const entries = allLongActions.filter((row) => (
        row.action === 'ENTRY' ||
        row.action === 'VIRTUAL_ENTRY'
    ));
const waits = allLongActions.filter((row) => row.action === 'WAIT');


const exitArrays = [
     ...(Array.isArray(tradeMeta.exits) ? tradeMeta.exits : []),
     ...(Array.isArray(tradeMeta.virtualExits) ? tradeMeta.virtualExits : []),
     ...(Array.isArray(tradeMeta.shadowExits) ? tradeMeta.shadowExits : []),
     ...(Array.isArray(tradeMeta.outcomes) ? tradeMeta.outcomes : [])
];


const virtualExits = filterLongRows(exitArrays).map((row) => {
     const riskGeometry = getLongRiskGeometry(row);


     return normalizeLongSide({
       ...row,
       source: row.source || 'VIRTUAL',
       outcomeSource: row.outcomeSource || 'VIRTUAL',
       virtualOnly: true,
       virtualTracked: true,
       learningOnly: true,
       realOrderPlaced: false,
       exchangeOrder: false,
       bitgetOrderPlaced: false,
       trueMicroFamilyId: getTrueMicroFamilyId(row),
       parentTrueMicroFamilyId: getParentTrueMicroFamilyId(row),
       validLongRiskShape: Boolean(riskGeometry.validGeometry),
       validLongGeometry: Boolean(riskGeometry.validGeometry),
       longTpHit: riskGeometry.longTpHit,
       longSlHit: riskGeometry.longSlHit,
       tpHit: riskGeometry.longTpHit,
       slHit: riskGeometry.longSlHit,
       longGrossR: riskGeometry.longGrossR,
       longCurrentR: riskGeometry.longCurrentR,
       netR: round(outcomeNetR(row), 4)
     });
});


const shadowExits = filterLongRows(
     Array.isArray(tradeMeta.shadowExits) ? tradeMeta.shadowExits : []
).map((row) => {
     const riskGeometry = getLongRiskGeometry(row);


     return normalizeLongSide({
       ...row,
       source: row.source || 'VIRTUAL',
       shadowOnly: true,
       virtualOnly: true,
        trueMicroFamilyId: getTrueMicroFamilyId(row),
        parentTrueMicroFamilyId: getParentTrueMicroFamilyId(row),
        validLongRiskShape: Boolean(riskGeometry.validGeometry),
        validLongGeometry: Boolean(riskGeometry.validGeometry),
        longTpHit: riskGeometry.longTpHit,
        longSlHit: riskGeometry.longSlHit,
        longGrossR: riskGeometry.longGrossR,
        longCurrentR: riskGeometry.longCurrentR,
        netR: round(outcomeNetR(row), 4)
    });
  });


  const discordEligibleActions = allLongActions.filter((row) =>
row.discordAlertEligible);
  const selectedMicroFamilyActions = allLongActions.filter((row) =>
row.selectedMicroFamilyAlert);
  const exactSelectedTrueMicroActions = allLongActions.filter((row) =>
row.exactSelectedTrueMicroMatch);
  const discordAlertsSent = allLongActions.filter((row) => row.discordAlertSent);


  return {
    lastRunAt: tradeMeta.completedAt || tradeMeta.startedAt || tradeMeta.ts ||
null,
    durationMs: tradeMeta.durationMs ?? null,


    runId: tradeMeta.runId || null,
    snapshotId: tradeMeta.snapshotId || null,
    snapshotAgeSec: tradeMeta.snapshotAgeSec ?? null,


    ...modeFlags(),


    actionCounts: buildActionCounts(allLongActions),
    rawActionCounts: tradeMeta.actionCounts || buildActionCounts(rawActions),
    learningActionCounts: buildActionCounts(learningActions),


    actions: allLongActions.length,
    rawActions: rawActions.length,
    allLongActions: allLongActions.length,
    learningActions: learningActions.length,
    shortActionsIgnored,


    virtualEntries: entries.length,
    virtualWaits: waits.length,
    virtualExits: virtualExits.length,
    shadowExits: shadowExits.length,


    entries: entries.length,
         waits: waits.length,
         exits: virtualExits.length,


         entryRows: entries,
         waitRows: waits,
         virtualCreatedRows: entries,
         virtualExitsRows: virtualExits,
         shadowExitsRows: shadowExits,


         discordEligibleActions: discordEligibleActions.length,
         selectedMicroFamilyActions: selectedMicroFamilyActions.length,
         exactSelectedTrueMicroActions: exactSelectedTrueMicroActions.length,
         discordAlertsSent: discordAlertsSent.length,


         skippedNewEntries: Boolean(tradeMeta.skippedNewEntries),
         reason: tradeMeta.reason || tradeMeta.skipReason || null,
         skipReason: tradeMeta.skipReason || tradeMeta.reason || null,


         activeRotationId: tradeMeta.activeRotationId || null,
         activeMicroFamilies: tradeMeta.activeMicroFamilies ?? null,


         entriesSymbols: entries
           .map((row) => row.symbol || row.contractSymbol)
           .filter(Boolean)
           .slice(0, 20),


         exitSymbols: virtualExits
           .map((row) => row.symbol || row.contractSymbol)
           .filter(Boolean)
           .slice(0, 20)
    };
}


function compactRotationDashboard(rotationDashboard = {}) {
    const active = normalizeRotation(
         rotationDashboard.active ||
         rotationDashboard.activeRotation ||
         null
    );


    const nextRaw =
         rotationDashboard.next ||
         rotationDashboard.nextRotation ||
         null;


    const next = normalizeRotation(nextRaw);
    const activeRows = filterLongRows(rotationDashboard.activeRows || [])
         .map(normalizeLongSide)
         .filter((row) => isSelectableTrueMicroId(row.trueMicroFamilyId ||
row.microFamilyId));


    const nextRows = filterLongRows(rotationDashboard.nextRows || [])
         .map((row) => normalizeLongSide({
           ...row,
           autoActivationDisabled: true
         }))
         .filter((row) => isSelectableTrueMicroId(row.trueMicroFamilyId ||
row.microFamilyId));


    return {
         ...rotationDashboard,
         ...modeFlags(),


         active,
         next,
         activeRotation: active,
         nextRotation: next,


         activeRows,
         nextRows,


         activeCount: active?.count || activeRows.length || 0,
         nextCount: next?.count || nextRows.length || 0,


         activeMicroFamilyIds: active?.microFamilyIds || [],
         nextMicroFamilyIds: next?.microFamilyIds || [],


         activeMacroFamilyIds: active?.macroFamilyIds || active?.activeMacroFamilyIds
|| [],
         nextMacroFamilyIds: next?.macroFamilyIds || next?.activeMacroFamilyIds || [],


         bestLong: active?.bestLong || null,
         bestShort: null,


         nextBestLong: next?.bestLong || null,
         nextBestShort: null,


         missingSides: active?.missingSides || [],
         nextMissingSides: next?.missingSides || [],


         autoRotationActivationDisabled: true
    };
}
function normalizePosition(position = {}) {
  const riskGeometry = getLongRiskGeometry(position);


  const entry = riskGeometry.entry ?? num(position.entry ?? position.entryPrice,
0);
  const sl = riskGeometry.initialSl ?? num(position.sl ?? position.stopLoss ??
position.initialSl, 0);
  const tp = riskGeometry.tp ?? num(position.tp ?? position.takeProfit, 0);
  const initialSl = riskGeometry.initialSl ?? sl;
  const currentPrice = riskGeometry.currentPrice ?? num(position.currentPrice ??
position.lastPrice, 0);


  const trueMicroFamilyId = getTrueMicroFamilyId(position);
  const parentTrueMicroFamilyId = getParentTrueMicroFamilyId(position);


  return normalizeLongSide({
      ...position,


      source: position.source || 'VIRTUAL',


      trueMicroFamilyId,
      microFamilyId: trueMicroFamilyId,
      learningMicroFamilyId: trueMicroFamilyId,
      analyzeMicroFamilyId: trueMicroFamilyId,
      parentTrueMicroFamilyId,
      coarseMicroFamilyId: parentTrueMicroFamilyId,


      selectableTrueMicroFamily: Boolean(trueMicroFamilyId),


      virtualOnly: true,
      virtualTracked: true,


      realOrderPlaced: false,
      exchangeOrder: false,
      bitgetOrderPlaced: false,


      entry,
      entryPrice: entry,
      sl,
      tp,
      initialSl,


      validLongRiskShape: Boolean(riskGeometry.validGeometry),
      validLongGeometry: Boolean(riskGeometry.validGeometry),


      currentPrice: currentPrice || null,
      lastPrice: currentPrice || null,


      ageSec: position.ageSec ?? null,
      currentR: position.currentR ?? riskGeometry.longCurrentR,
      longCurrentR: riskGeometry.longCurrentR,
      longGrossR: riskGeometry.longGrossR,
      mfeR: position.mfeR ?? null,
      maeR: position.maeR ?? null,


      reachedHalfR: Boolean(position.reachedHalfR),
      reachedOneR: Boolean(position.reachedOneR),
      nearTpSeen: Boolean(position.nearTpSeen),


      tpHit: riskGeometry.longTpHit,
      slHit: riskGeometry.longSlHit,
      longTpHit: riskGeometry.longTpHit,
      longSlHit: riskGeometry.longSlHit,


      tpExitArmed: Boolean(currentPrice > 0 && tp > 0 && currentPrice >= tp),
      slExitArmed: Boolean(currentPrice > 0 && initialSl > 0 && currentPrice <=
initialSl),
      timeStopExitArmed: Boolean(position.timeStopExitArmed),


      selectedMicroFamily: Boolean(
           position.selectedMicroFamily ||
           position.selectedMicroFamilyAlert
      ),
      discordAlertEligible: Boolean(position.discordAlertEligible),
      selectedMicroFamilyAlert: Boolean(position.selectedMicroFamilyAlert),
      exactSelectedTrueMicroMatch: Boolean(position.exactSelectedTrueMicroMatch ||
position.selectedMicroFamilyAlert),
      discordEntryAlertSent: Boolean(position.discordEntryAlertSent),
      discordExitAlertEligible: Boolean(position.discordExitAlertEligible),
      discordExitAlertSent: Boolean(position.discordExitAlertSent)
    });
}


function buildPositionSummary(rawPositions = []) {
    const positions = filterLongRows(rawPositions).map(normalizePosition);
    const ignoredShortPositions = rawPositions.filter(isShortRow).length;
    const unknownPositions = rawPositions.filter((row) => inferTradeSide(row) ===
'UNKNOWN').length;


    return {
      positions,
      positionsCount: positions.length,
      rawPositionsCount: rawPositions.length,
         ignoredShortPositions,
         unknownPositions,
         ignoredUnknownPositions: unknownPositions,


         virtualPositions: positions.length,
         selectedPositions: positions.filter((row) => row.selectedMicroFamily ||
row.selectedMicroFamilyAlert).length,
         exactSelectedTrueMicroPositions: positions.filter((row) =>
row.exactSelectedTrueMicroMatch).length,
         discordEntryAlertSentPositions: positions.filter((row) =>
row.discordEntryAlertSent).length,
         discordExitAlertEligiblePositions: positions.filter((row) =>
row.discordExitAlertEligible).length
    };
}


function normalizeDiscordLog(row = {}) {
    const payload = safeObject(row.payload);
    const result = safeObject(row.result || payload.result);


    const trueMicroFamilyId =
         getTrueMicroFamilyId(row) ||
         getTrueMicroFamilyId(payload) ||
         getTrueMicroFamilyId(result);


    const parentTrueMicroFamilyId =
         getParentTrueMicroFamilyId(row) ||
         getParentTrueMicroFamilyId(payload) ||
         getParentTrueMicroFamilyId(result);


    const selectedTrueMicroFamilyId = String(
         row.selectedTrueMicroFamilyId ||
           payload.selectedTrueMicroFamilyId ||
           result.selectedTrueMicroFamilyId ||
           row.selectedMicroFamilyId ||
           payload.selectedMicroFamilyId ||
           result.selectedMicroFamilyId ||
           ''
    ).trim();


    const rawInferredTradeSide = inferTradeSide({
         ...row,
         ...payload,
         ...result,
         trueMicroFamilyId,
         microFamilyId: trueMicroFamilyId,
         parentTrueMicroFamilyId,
       coarseMicroFamilyId: parentTrueMicroFamilyId
  });


  const selectedMicroFamilyAlert = Boolean(
       row.selectedMicroFamilyAlert ||
       payload.selectedMicroFamilyAlert ||
       result.selectedMicroFamilyAlert ||
       row.alertAllowed ||
       payload.alertAllowed ||
       result.alertAllowed
  );


  const discordAlertEligible = Boolean(
       row.discordAlertEligible ||
       payload.discordAlertEligible ||
       result.discordAlertEligible
  );


  const exactSelectedTrueMicroMatch = Boolean(
       trueMicroFamilyId &&
       isSelectableTrueMicroId(trueMicroFamilyId) &&
       selectedMicroFamilyAlert &&
       (
           !selectedTrueMicroFamilyId ||
           selectedTrueMicroFamilyId === trueMicroFamilyId
       )
  );


  const alertAllowed = exactSelectedTrueMicroMatch;
  const temporalContext = resolveRecordTemporalContext(
       {
         ...row,
         ...payload,
         ...result
       },
       now()
  );


  return {
       ...row,
       payload,
       result,
       ...temporalContext,
       ...buildEntryExitTemporalMetadata({
         ...row,
         ...payload,
         ...result
       }),
       ...modeFlags(),
       ...temporalPolicyFlags(temporalContext),


       type: row.type || payload.type || result.type || row.level || payload.level ||
'UNKNOWN',


       rawInferredTradeSide,
       inferredTradeSide: rawInferredTradeSide,


       symbol:
           row.symbol ||
           payload.symbol ||
           payload.contractSymbol ||
      result.symbol ||
      result.contractSymbol ||
      null,


    microFamilyId: trueMicroFamilyId,
    trueMicroFamilyId,
    learningMicroFamilyId: trueMicroFamilyId,
    analyzeMicroFamilyId: trueMicroFamilyId,
    parentTrueMicroFamilyId,
    coarseMicroFamilyId: parentTrueMicroFamilyId,


    familyId:
      parentTrueMicroFamilyId ||
      row.familyId ||
      payload.familyId ||
      result.familyId ||
      null,


    macroFamilyId:
      parentTrueMicroFamilyId ||
      row.macroFamilyId ||
      row.parentMacroFamilyId ||
      payload.macroFamilyId ||
      payload.parentMacroFamilyId ||
      result.macroFamilyId ||
      result.parentMacroFamilyId ||
      null,


    discordAlertEligible,
    selectedMicroFamilyAlert,
    selectedTrueMicroFamilyId: selectedTrueMicroFamilyId || null,
    exactSelectedTrueMicroMatch,


    selectedOnly: alertAllowed,


    manualSelectionRequired: true,
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    alertAllowed,
    blockedByManualSelection: discordAlertEligible && !alertAllowed,
    policyViolation: Boolean((row.sent || payload.sent || result.sent || result.ok
=== true) && !alertAllowed),


    sent: Boolean(
      row.sent ||
      payload.sent ||
      result.sent ||
      result.ok === true
         ),


         failed: Boolean(
              row.failed ||
              payload.failed ||
              result.failed ||
              result.ok === false
         ),


         skipped: Boolean(
              row.skipped ||
              payload.skipped ||
              result.skipped
         ),


         source:
              row.source ||
              payload.source ||
              result.source ||
              null,


         ts:
              row.ts ||
              row.createdAt ||
              payload.ts ||
              payload.createdAt ||
              result.ts ||
              result.createdAt ||
              null
    };
}


function summarizeDiscordLogs(logs = []) {
    const normalized = logs
         .map(normalizeDiscordLog)
         .filter((log) => log.rawInferredTradeSide !== OPPOSITE_TRADE_SIDE)
         .filter((log) => !log.trueMicroFamilyId ||
isSelectableTrueMicroId(log.trueMicroFamilyId));


    return normalized.reduce((acc, log) => {
         const type = upper(log.type || 'UNKNOWN');


         acc.total += 1;
         acc.byType[type] = (acc.byType[type] || 0) + 1;


         if (log.discordAlertEligible) acc.eligible += 1;
         if (log.selectedOnly || log.alertAllowed) acc.selectedOnly += 1;
      if (log.exactSelectedTrueMicroMatch) acc.exactSelectedTrueMicroMatch += 1;
      if (log.sent) acc.sent += 1;
      if (log.failed) acc.failed += 1;
      if (log.skipped) acc.skipped += 1;
      if (log.policyViolation) acc.policyViolations += 1;
      if (log.blockedByManualSelection) acc.blockedByManualSelection += 1;


      return acc;
    }, {
      total: 0,
      eligible: 0,
      selectedOnly: 0,
      exactSelectedTrueMicroMatch: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      policyViolations: 0,
      blockedByManualSelection: 0,
      byType: {}
    });
}


function buildTaxonomySummary(micros = {}, activeMicroFamilyIds = []) {
    const activeSet = new Set(activeMicroFamilyIds || []);
    const rows = sourceEntries(micros)
      .map(([key, row]) => {
           const trueMicroFamilyId = getTrueMicroFamilyId(row, key);
           const parsed = parseLongTaxonomyMicroId(trueMicroFamilyId);


           return {
                ...(row || {}),
                trueMicroFamilyId,
                parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
                taxonomySetup: parsed.setup,
                taxonomyRegime: parsed.regime,
                confirmationProfile: parsed.confirmationProfile
           };
      })
      .filter((row) => row.trueMicroFamilyId &&
isSelectableTrueMicroId(row.trueMicroFamilyId));


    const completedChildren = rows.filter((row) => getOutcomeSample(row) > 0);
    const activeLearningChildren = rows.filter((row) => getOutcomeSample(row) >=
MIN_COMPLETED_ACTIVE_LEARNING);
    const observingChildren = rows.filter((row) => getOutcomeSample(row) === 0 &&
getObservationSample(row) > 0);
    return {
         ...modeFlags(),


         parentFamiliesTotal: 15,
         selectableChildFamiliesTotal: 75,


         selectableChildFamiliesWithRows: rows.length,
         selectableChildFamiliesWithCompleted: completedChildren.length,
         selectableChildFamiliesActiveLearning: activeLearningChildren.length,
         selectableChildFamiliesObserving: observingChildren.length,


         activeSelectedChildFamilies: activeSet.size,


         setupCount: SETUP_ORDER.length,
         regimeCount: REGIME_ORDER.length,
         confirmationProfileCount: CONFIRMATION_PROFILE_ORDER.length,


         setups: SETUP_ORDER,
         regimes: REGIME_ORDER,
         confirmationProfiles: CONFIRMATION_PROFILE_ORDER
    };
}


async function safeRead(label, fn, fallback) {
    try {
         const value = await fn();


         return {
              ok: true,
              label,
              value
         };
    } catch (error) {
         return {
              ok: false,
              label,
              value: fallback,
              error: error?.message || String(error)
         };
    }
}


export default async function handler(req, res) {
    const startedAt = now();


    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('X-Admin-Overview-Mode', 'long-only-75-child-persistent-virtual-learning-v1');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Long-Only', 'true');
  res.setHeader('X-Short-Disabled', 'true');
  res.setHeader('X-Virtual-Only', 'true');
  res.setHeader('X-Virtual-Learning-Forced', 'true');
  res.setHeader('X-Net-Outcomes-Only', 'true');
  res.setHeader('X-Manual-Selection-Only', 'true');
  res.setHeader('X-Manual-Selection-Match-Mode', 'EXACT_TRUE_MICRO_FAMILY_ID');
  res.setHeader('X-Discord-Selection-Rule',
'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY');
  res.setHeader('X-True-Micro-Family-Schema', TRUE_MICRO_SCHEMA);
  res.setHeader('X-Learning-Granularity', LEARNING_GRANULARITY);
  res.setHeader('X-Real-Orders-Disabled', 'true');
  res.setHeader('X-Bitget-Orders-Disabled', 'true');
  res.setHeader('X-Exchange-Calls-Disabled', 'true');
  res.setHeader('X-Persistent-Learning-Key', PERSISTENT_LEARNING_KEY);
  res.setHeader('X-Week-Reset-Disabled', 'true');
  res.setHeader('X-Redis-Namespace', LONG_NAMESPACE);
  res.setHeader('X-Short-Root-Touched', 'false');


  if (req.method !== 'GET') {
      return methodNotAllowed(res);
  }


  try {
      const durable = getDurableRedis();
      const volatile = getVolatileRedis();


      const weekKey = PERSISTENT_LEARNING_KEY;
      const currentWeekKey = PERSISTENT_LEARNING_KEY;
      const previousWeekKey = PERSISTENT_LEARNING_KEY;


      const [
        latestScanRead,
        tradeMetaRead,
        positionsRead,
        currentMicrosRead,
        previousMicrosRead,
        rotationRead,
        discordLogsRead
      ] = await Promise.all([
        safeRead(
             'latestScan',
             () => getJson(volatile, LONG_KEYS.scan.latest, null),
             null
        ),
safeRead(
     'tradeMeta',
     () => getJson(durable, LONG_KEYS.trade.runMeta, null),
     null
),


safeRead(
     'openPositions',
     () => getOpenPositions({
          tradeSide: TARGET_TRADE_SIDE,
          side: TARGET_DASHBOARD_SIDE,
          namespace: LONG_NAMESPACE,
          keyPrefix: LONG_KEY_PREFIX,
          virtualOnly: true
     }),
     []
),


safeRead(
     'persistentLearningMicros',
     () => getWeekMicros(PERSISTENT_LEARNING_KEY),
     {}
),


safeRead(
     'previousWeekMicrosDisabledPersistentLearning',
     () => getWeekMicros(PERSISTENT_LEARNING_KEY),
     {}
),


safeRead(
     'rotationDashboard',
     () => getRotationDashboard({
          tradeSide: TARGET_TRADE_SIDE,
          side: TARGET_DASHBOARD_SIDE,
          weekKey: PERSISTENT_LEARNING_KEY,
          namespace: LONG_NAMESPACE,
          keyPrefix: LONG_KEY_PREFIX
     }),
     {
          active: null,
          next: null,
          validFrom: null,
          activeRows: [],
          nextRows: [],
          activeCount: 0,
                nextCount: 0
           }
      ),


      safeRead(
           'discordLogs',
           () => readJsonLogs(durable, LONG_KEYS.discord.logList, 10),
           []
      )
    ]);


    const latestScan = normalizeLatestScan(latestScanRead.value);
    const tradeMeta = tradeMetaRead.value || null;
    const tradeSummary = buildTradeSummary(tradeMeta);


    const rawPositions = asArray(positionsRead.value);
    const positionSummary = buildPositionSummary(rawPositions);


    const currentMicros = currentMicrosRead.value || {};
    const previousMicros = previousMicrosRead.value || {};


    const rawRotationDashboard = rotationRead.value || {};
    const rotationDashboard = compactRotationDashboard(rawRotationDashboard);


    const activeRotation = rotationDashboard.active || null;
    const nextRotation = rotationDashboard.next || null;


    const activeMicroFamilyIds = activeRotation?.microFamilyIds || [];
    const activeMacroFamilyIds = activeRotation?.macroFamilyIds || [];


    const currentMicroSummary = summarizeMicros(currentMicros);
    const previousMicroSummary = summarizeMicros(previousMicros);
    const taxonomySummary = buildTaxonomySummary(currentMicros,
activeMicroFamilyIds);


    const rawDiscordLogs = Array.isArray(discordLogsRead.value)
      ? discordLogsRead.value
      : [];


    const discordLogs = rawDiscordLogs
      .map(normalizeDiscordLog)
      .filter((log) => log.rawInferredTradeSide !== OPPOSITE_TRADE_SIDE)
      .filter((log) => !log.trueMicroFamilyId ||
isSelectableTrueMicroId(log.trueMicroFamilyId))
      .map((log) => normalizeLongSide(log));


    const warnings = [
         latestScanRead,
         tradeMetaRead,
         positionsRead,
         currentMicrosRead,
         previousMicrosRead,
         rotationRead,
         discordLogsRead
    ]
         .filter((row) => !row.ok)
         .map((row) => ({
              source: row.label,
              error: row.error
         }));


    const shortIgnored = {
         positions: positionSummary.ignoredShortPositions,
         currentWeekMicroFamilies: countShortMapOrArray(currentMicros),
         previousWeekMicroFamilies: countShortMapOrArray(previousMicros),
         scannerCandidates: latestScan?.shortCandidatesIgnored || 0,
         tradeActions: tradeSummary.shortActionsIgnored || 0,
         discordLogs: rawDiscordLogs.filter((row) =>
inferTradeSide(normalizeDiscordLog(row)) === OPPOSITE_TRADE_SIDE).length,
         activeRotationRows: activeRotation?.shortMicroFamiliesIgnored || 0,
         nextRotationRows: nextRotation?.shortMicroFamiliesIgnored || 0
    };


    const parentRowsHidden = sourceEntries(currentMicros)
         .filter(([key, row]) => {
              const id = String(
                   row?.trueMicroFamilyId ||
                     row?.learningMicroFamilyId ||
                     row?.analyzeMicroFamilyId ||
                     row?.microFamilyId ||
                     key ||
                     ''
              );


              return isFixedLongParentMicroId(id);
         })
         .length;


    const scannerFingerprintRowsHidden = sourceEntries(currentMicros)
         .filter(([key, row]) => {
              const id = String(
                   row?.trueMicroFamilyId ||
                     row?.learningMicroFamilyId ||
                     row?.analyzeMicroFamilyId ||
                  row?.microFamilyId ||
                  key ||
                  ''
           );


           return (
                isScannerFingerprintId(id) ||
                isScannerFingerprintId(row?.scannerMicroFamilyId) ||
                isScannerFingerprintId(row?.coarseMicroFamilyId)
           );
      })
      .length;


    const executionFingerprintRowsHidden = sourceEntries(currentMicros)
      .filter(([key, row]) => {
           const id = String(
                row?.trueMicroFamilyId ||
                  row?.learningMicroFamilyId ||
                  row?.analyzeMicroFamilyId ||
                  row?.microFamilyId ||
                  key ||
                  ''
           );


           return (
                isExecutionFingerprintId(id) ||
                isExecutionFingerprintId(row?.executionMicroFamilyId) ||
                isExecutionFingerprintId(row?.coarseMicroFamilyId)
           );
      })
      .length;


    return res.status(200).json({
      ok: true,
      ...modeFlags(),


      weekKey,
      currentWeekKey: weekKey,
      previousWeekKey,


      persistentLearningKey: PERSISTENT_LEARNING_KEY,
      requestedLearningKey: PERSISTENT_LEARNING_KEY,
      activeLearningStoreKey:
`${LONG_KEY_PREFIX}ANALYZE:WEEK:${PERSISTENT_LEARNING_KEY}:MICROS`,
      weekResetDisabled: true,
      isoWeekLearningDisabled: true,
      previousWeekComparisonDisabled: true,
      longKeys: {
           namespace: LONG_NAMESPACE,
           prefix: LONG_KEY_PREFIX,
           scanLatest: LONG_KEYS.scan.latest,
           tradeRunMeta: LONG_KEYS.trade.runMeta,
           discordLogList: LONG_KEYS.discord.logList
      },


      taxonomy: {
           parentCount: 15,
           selectableChildCount: 75,
           setups: SETUP_ORDER,
           regimes: REGIME_ORDER,
           confirmationProfiles: CONFIRMATION_PROFILE_ORDER,
           parentFormat: 'MICRO_LONG_{SETUP}_{REGIME}',
           childFormat: 'MICRO_LONG_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',
           selectableIdsAreChildrenOnly: true,
           parentIdsAreMetadataOnly: true
      },


      taxonomySummary,


      latestScan,
      latestScannerSnapshotId: latestScan?.snapshotId || null,


      scannerCandidates: latestScan?.candidatesCount || 0,
      longScannerCandidates: latestScan?.longCandidatesCount ||
latestScan?.candidatesCount || 0,


      tradeMeta,
      tradeSummary,


      runMeta: tradeMeta,
      latestRunMeta: tradeMeta
           ? {
               runId: tradeMeta.runId || null,
               shadowExits: tradeMeta.shadowExits || [],
               virtualExits: tradeMeta.virtualExits || tradeMeta.exits || [],
               actionCounts: tradeSummary.actionCounts || {},
               skipReason: tradeSummary.skipReason || null
           }
           : null,


      openPositions: positionSummary.positionsCount,
      positionsCount: positionSummary.positionsCount,
      rawPositionsCount: positionSummary.rawPositionsCount,
      virtualPositions: positionSummary.virtualPositions,
      selectedPositions: positionSummary.selectedPositions,
      exactSelectedTrueMicroPositions:
positionSummary.exactSelectedTrueMicroPositions,


      ignoredShortPositions: positionSummary.ignoredShortPositions,
      ignoredUnknownPositions: positionSummary.ignoredUnknownPositions,
      unknownPositions: positionSummary.unknownPositions,


      positions: positionSummary.positions,


      currentWeekMicroFamilies: currentMicroSummary.rows,
      previousWeekMicroFamilies: previousMicroSummary.rows,


      persistentMicroFamilies: currentMicroSummary.rows,
      persistentMicroSummary: currentMicroSummary,


      currentMicroSummary,
      previousMicroSummary,


      observingMicroFamilies: currentMicroSummary.observationOnlyFamilies,
      completedMicroFamilies: currentMicroSummary.completedFamilies,
      activeLearningMicroFamilies: currentMicroSummary.activeLearningFamilies,
      earlyOutcomeMicroFamilies: currentMicroSummary.earlyOutcomeFamilies,


      activeRotation,
      nextRotation,


      activeRotationId: activeRotation?.rotationId || null,
      nextRotationId: nextRotation?.rotationId || null,


      activeRotationCount: activeRotation?.count || 0,
      nextRotationCount: nextRotation?.count || 0,


      activeMicroFamilyIds,
      nextMicroFamilyIds: nextRotation?.microFamilyIds || [],


      activeMacroFamilyIds,
      nextMacroFamilyIds: nextRotation?.macroFamilyIds || [],


      bestLong: activeRotation?.bestLong || null,
      bestShort: null,
      nextBestLong: nextRotation?.bestLong || null,
      nextBestShort: null,


      rotationDashboard,
          discordLogs,
          discordSummary: summarizeDiscordLogs(discordLogs),


          hiddenMetadataRows: {
               parentRowsHidden,
               scannerFingerprintRowsHidden,
               executionFingerprintRowsHidden
          },


          shortIgnored,
          warnings,


          perf: {
               durationMs: now() - startedAt,
               source: 'long_only_75_child_persistent_virtual_learning_overview'
          },


          serverTs: Date.now()
        });
    } catch (error) {
        return res.status(500).json({
          ok: false,
          ...modeFlags(),


          error: error?.message || String(error),
          stack: process.env.NODE_ENV === 'production'
               ? undefined
               : error?.stack
        });
    }
}
