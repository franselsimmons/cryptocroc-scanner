// ================= FILE: api/admin/reset-learning.js =================


import { randomUUID } from 'node:crypto';


import { KEYS } from '../../src/keys.js';
import {
  getIsoWeekKey,
  getPreviousIsoWeekKey
} from '../../src/utils.js';
import {
  getDurableRedis,
  pushJsonLog,
  delPattern
} from '../../src/redis.js';
import { sendResetReport } from '../../src/discord/discord.js';


const CONFIRM_TEXT = 'RESET_LEARNING_LONG';
const LOCK_TTL_SEC = 180;


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

const DEFAULT_POSITION_TIME_STOP_MIN = 720;


const DELETE_SCAN_COUNT = 10_000;


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


function namespacedLongPattern(pattern, fallback = null) {
    return namespacedLongKey(pattern, fallback);
}


const LONG_KEYS = {
    reset: {
         logList: namespacedLongKey(
              KEYS.long?.reset?.logList ||
                KEYS.reset?.longLogList ||
                KEYS.reset?.logList,
              'RESET:LOGS'
         )
    },


    trade: {
         lock: namespacedLongKey(
              KEYS.long?.trade?.lock ||
                KEYS.trade?.longLock ||
                KEYS.trade?.lock,
              'TRADE:LOCK'
         )
    },


    analyze: {
         resetLearningLock: namespacedLongKey('ADMIN:RESET_LEARNING:LOCK'),


         freezeLock: namespacedLongKey(
              KEYS.long?.analyze?.freezeLock ||
                KEYS.analyze?.longFreezeLock ||
                KEYS.analyze?.freezeLock,
              'ANALYZE:WEEKLY_FREEZE_LOCK'
         ),


         activateLock: namespacedLongKey(
              KEYS.long?.analyze?.activateLock ||
       KEYS.analyze?.longActivateLock ||
       KEYS.analyze?.activateLock,
     'ANALYZE:ROTATION_ACTIVATE_LOCK'
),


nextRotation: namespacedLongKey(
     KEYS.long?.analyze?.nextRotation ||
       KEYS.analyze?.longNextRotation ||
       KEYS.analyze?.nextRotation,
     'ANALYZE:NEXT_ROTATION'
),


rotationValidFrom: namespacedLongKey(
     KEYS.long?.analyze?.rotationValidFrom ||
       KEYS.analyze?.longRotationValidFrom ||
       KEYS.analyze?.rotationValidFrom,
     'ANALYZE:ROTATION_VALID_FROM'
),


activeRotation: namespacedLongKey(
     KEYS.long?.analyze?.activeRotation ||
       KEYS.analyze?.longActiveRotation ||
       KEYS.analyze?.activeRotation,
     'ANALYZE:ACTIVE_ROTATION'
),


obsLastPattern: namespacedLongPattern(
     KEYS.long?.analyze?.obsLastPattern ||
       KEYS.analyze?.longObsLastPattern,
     'ANALYZE:OBS:LAST:*'
),


outcomePattern: namespacedLongPattern(
     KEYS.long?.analyze?.outcomePattern ||
       KEYS.analyze?.longOutcomePattern,
     'ANALYZE:OUTCOME:*'
),


shadowPattern: namespacedLongPattern(
     KEYS.long?.analyze?.shadowPattern ||
       KEYS.analyze?.longShadowPattern,
     'ANALYZE:SHADOW:*'
),


microPattern: namespacedLongPattern(
     KEYS.long?.analyze?.microPattern ||
       KEYS.analyze?.longMicroPattern,
              'ANALYZE:MICRO:*'
         ),


         weekPattern: namespacedLongPattern(
              KEYS.long?.analyze?.weekPattern ||
                KEYS.analyze?.longWeekPattern,
              'ANALYZE:WEEK:*'
         ),


         scannerFingerprintPattern: namespacedLongPattern(
              KEYS.long?.analyze?.scannerFingerprintPattern ||
                KEYS.analyze?.longScannerFingerprintPattern,
              'ANALYZE:*SCANNER*'
         ),


         executionFingerprintPattern: namespacedLongPattern(
              KEYS.long?.analyze?.executionFingerprintPattern ||
                KEYS.analyze?.longExecutionFingerprintPattern,
              'ANALYZE:*EXECUTION*'
         ),

         temporalContextPattern: namespacedLongPattern(
              KEYS.long?.analyze?.temporalContextPattern ||
                KEYS.analyze?.longTemporalContextPattern,
              'ANALYZE:TEMPORAL:*'
         ),

         contextStatsPattern: namespacedLongPattern(
              KEYS.long?.analyze?.contextStatsPattern ||
                KEYS.analyze?.longContextStatsPattern,
              'ANALYZE:CONTEXT:*'
         ),

         sessionStatsPattern: namespacedLongPattern(
              KEYS.long?.analyze?.sessionStatsPattern ||
                KEYS.analyze?.longSessionStatsPattern,
              'ANALYZE:SESSION:*'
         )
     }
};


const LOCK_KEYS = {
     resetLearning: LONG_KEYS.analyze.resetLearningLock,
     trade: LONG_KEYS.trade.lock,
     freeze: LONG_KEYS.analyze.freezeLock,
     activate: LONG_KEYS.analyze.activateLock
};


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
observationFirstAnalyze: true,
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
manualSelectionPreserved: true,
activeRotationPreserved: true,
autoRotationActivationDisabled: true,
activateFreezeCronDisabled: true,
resetCronDisabled: true,
discordOnlyForSelectedMicroFamilies: true,
         discordOnlyForExactTrueMicroMatch: true,
         discordSelectionRule: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY',
         parentMatchDoesNotTriggerDiscord: true,
         macroMatchDoesNotTriggerDiscord: true,


         minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,
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


         persistentLearningKey: PERSISTENT_LEARNING_KEY,
         weekResetDisabled: true,
         isoWeekLearningDisabled: true,


         redisNamespace: LONG_NAMESPACE,
         redisKeyPrefix: LONG_KEY_PREFIX,
         redisKeysSeparatedFromShortRoot: true,
         shortRootTouched: false
    };
}


function methodNotAllowed(res) {
    res.setHeader('Allow', 'POST');


    return res.status(405).json({
         ok: false,
         error: 'METHOD_NOT_ALLOWED',
         allowed: ['POST'],
         ...modeFlags()
    });
}


function parseJson(text) {
    if (!text) return {};


    try {
         return JSON.parse(text);
    } catch {
         const error = new Error('INVALID_JSON_BODY');
         error.statusCode = 400;
         throw error;
    }
}
async function readBody(req) {
    if (req.body) {
         if (typeof req.body === 'string') return parseJson(req.body.trim());
         if (Buffer.isBuffer(req.body)) return
parseJson(req.body.toString('utf8').trim());


         return req.body;
    }


    const chunks = [];


    for await (const chunk of req) {
         chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }


    const text = Buffer.concat(chunks).toString('utf8').trim();


    return parseJson(text);
}


function isConfirmed(body = {}) {
    return (
         body.confirm === CONFIRM_TEXT ||
         body.confirmed === CONFIRM_TEXT ||
         body.confirmation === CONFIRM_TEXT
    );
}


function isTrue(value) {
    return (
         value === true ||
         value === 'true' ||
         value === 'TRUE' ||
         value === 1 ||
         value === '1' ||
         value === 'yes' ||
         value === 'YES' ||
         value === 'on' ||
         value === 'ON'
    );
}


function wantsForbiddenRotationReset(body = {}) {
    return (
         isTrue(body.resetRotation) ||
         isTrue(body.clearRotation) ||
         isTrue(body.resetManualSelection) ||
         isTrue(body.clearManualSelection) ||
         isTrue(body.wipeRotation)
    );
}


async function acquireLock(redis, key, token) {
    if (!redis || !key || !token) return true;


    const acquired = await redis.set(key, token, {
         nx: true,
         ex: LOCK_TTL_SEC
    });


    return Boolean(acquired);
}


async function releaseLock(redis, key, token) {
    try {
         if (!redis || !key || !token) return false;


         const current = await redis.get(key);


         if (current !== token) return false;


         await redis.del(key);


         return true;
    } catch {
         return false;
    }
}


async function acquireOneLock({
    redis,
    key,
    token,
    reason,
    acquired
}) {
    if (!key) {
         return {
              ok: true,
              acquired
         };
    }


    const ok = await acquireLock(redis, key, token);
    if (!ok) {
         return {
              ok: false,
              reason,
              acquired
         };
    }


    acquired.push(key);


    return {
         ok: true,
         acquired
    };
}


async function acquireResetLearningLocks(redis, token) {
    const acquired = [];


    const steps = [
         {
              key: LOCK_KEYS.resetLearning,
              reason: 'LONG_RESET_LEARNING_ALREADY_RUNNING'
         },
         {
              key: LOCK_KEYS.trade,
              reason: 'LONG_TRADE_RUN_ACTIVE'
         },
         {
              key: LOCK_KEYS.freeze,
              reason: 'LONG_WEEKLY_FREEZE_ACTIVE'
         },
         {
              key: LOCK_KEYS.activate,
              reason: 'LONG_ROTATION_ACTIVATE_ACTIVE'
         }
    ];


    for (const step of steps) {
         const result = await acquireOneLock({
              redis,
              key: step.key,
              token,
              reason: step.reason,
              acquired
         });
         if (!result.ok) return result;
    }


    return {
         ok: true,
         acquired
    };
}


async function releaseLocks(redis, keys, token) {
    const released = [];


    for (const key of [...keys].reverse()) {
         const ok = await releaseLock(redis, key, token);


         released.push({
           key,
           released: ok
         });
    }


    return released;
}


async function delKey(redis, key) {
    if (!redis || !key) return 0;


    return redis.del(key).catch(() => 0);
}


async function delPatternSafe(redis, pattern, count = DELETE_SCAN_COUNT) {
    if (!redis || !pattern) return 0;


    return delPattern(redis, pattern, count).catch(() => 0);
}


function uniqueStrings(values = []) {
    return [...new Set(
         (Array.isArray(values) ? values : [])
           .flatMap((value) => Array.isArray(value) ? value : [value])
           .map((value) => String(value || '').trim())
           .filter(Boolean)
    )];
}


function firstValue(value, fallback = null) {
    if (Array.isArray(value)) return value[0] ?? fallback;
    if (value === undefined || value === null || value === '') return fallback;


    return value;
}


function getWeekKeyCandidates(body = {}) {
    return uniqueStrings([
        PERSISTENT_LEARNING_KEY,
        getPreviousIsoWeekKey(),
        getIsoWeekKey(),
        firstValue(body.weekKey, null),
        firstValue(body.currentWeekKey, null),
        firstValue(body.previousWeekKey, null),
        ...(Array.isArray(body.weekKeys) ? body.weekKeys : [])
    ]);
}


function baseWeekMicrosKey(weekKey) {
    if (typeof KEYS.long?.analyze?.weekMicros === 'function') {
        return KEYS.long.analyze.weekMicros(weekKey);
    }


    if (typeof KEYS.analyze?.longWeekMicros === 'function') {
        return KEYS.analyze.longWeekMicros(weekKey);
    }


    if (typeof KEYS.analyze?.weekMicros === 'function') {
        return KEYS.analyze.weekMicros(weekKey);
    }


    return `ANALYZE:WEEK:${weekKey}:MICROS`;
}


function baseWeekMetaKey(weekKey) {
    if (typeof KEYS.long?.analyze?.weekMeta === 'function') {
        return KEYS.long.analyze.weekMeta(weekKey);
    }


    if (typeof KEYS.analyze?.longWeekMeta === 'function') {
        return KEYS.analyze.longWeekMeta(weekKey);
    }


    if (typeof KEYS.analyze?.weekMeta === 'function') {
        return KEYS.analyze.weekMeta(weekKey);
    }
    return `ANALYZE:WEEK:${weekKey}:META`;
}


function weekMicrosKey(weekKey) {
    return namespacedLongKey(baseWeekMicrosKey(weekKey));
}


function weekMetaKey(weekKey) {
    return namespacedLongKey(baseWeekMetaKey(weekKey));
}


function getWeekStorageKeys(weekKey) {
    const base = weekMicrosKey(weekKey);


    return [
        base,
        `${base}:INDEX`,
        `${base}:TOP`,
        weekMetaKey(weekKey)
    ].filter(Boolean);
}


function getWeekRowPatterns(weekKey) {
    const base = weekMicrosKey(weekKey);


    return [
        `${base}:ROW:*`
    ].filter(Boolean);
}


async function deleteExactKeys(redis, keys = []) {
    const safeKeys = uniqueStrings(keys);


    if (!safeKeys.length) return 0;


    let deleted = 0;


    for (const key of safeKeys) {
        deleted += await delKey(redis, key);
    }


    return deleted;
}


async function deletePatterns(redis, patterns = []) {
    const safePatterns = uniqueStrings(patterns);
    if (!safePatterns.length) return 0;


    let deleted = 0;


    for (const pattern of safePatterns) {
         deleted += await delPatternSafe(redis, pattern);
    }


    return deleted;
}


function buildTaxonomyMeta() {
    return {
         trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
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


async function runLearningDeleteSteps(redis, body = {}) {
    const allWeeks = isTrue(body.allWeeks ?? body.full ?? true);
    const weekKeys = getWeekKeyCandidates(body);


    const weekMainKeys = weekKeys.flatMap(getWeekStorageKeys);
    const weekRowPatterns = weekKeys.flatMap(getWeekRowPatterns);


    const deleted = {
         weekKeys,
     allWeeks,


     exactWeekStorageKeys: await deleteExactKeys(redis, weekMainKeys),
     shardedWeekRows: await deletePatterns(redis, weekRowPatterns),


     observationDedupe: await delPatternSafe(
          redis,
          LONG_KEYS.analyze.obsLastPattern
     ),


     outcomeDedupe: await delPatternSafe(
          redis,
          LONG_KEYS.analyze.outcomePattern
     ),


     shadowAnalyzeData: await delPatternSafe(
          redis,
          LONG_KEYS.analyze.shadowPattern
     ),


     legacyMicroData: await delPatternSafe(
          redis,
          LONG_KEYS.analyze.microPattern
     ),

     temporalContextData: await delPatternSafe(
          redis,
          LONG_KEYS.analyze.temporalContextPattern
     ),

     contextStatsData: await delPatternSafe(
          redis,
          LONG_KEYS.analyze.contextStatsPattern
     ),

     sessionStatsData: await delPatternSafe(
          redis,
          LONG_KEYS.analyze.sessionStatsPattern
     )
};


if (allWeeks) {
     deleted.allWeekAnalyzeData = await delPatternSafe(
          redis,
          LONG_KEYS.analyze.weekPattern
     );
} else {
     deleted.allWeekAnalyzeData = 0;
}


deleted.nextRotation = await delKey(
     redis,
     LONG_KEYS.analyze.nextRotation
);


deleted.rotationValidFrom = await delKey(
     redis,
     LONG_KEYS.analyze.rotationValidFrom
);


deleted.activeRotation = 0;
    return deleted;
}


export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('X-Admin-Reset-Learning-Mode', 'long-only-75-child-virtual-learning-v1');
    res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
    res.setHeader('X-Long-Only', 'true');
    res.setHeader('X-Short-Disabled', 'true');
    res.setHeader('X-Virtual-Only', 'true');
    res.setHeader('X-Virtual-Learning-Forced', 'true');
    res.setHeader('X-Net-Outcomes-Only', 'true');
    res.setHeader('X-True-Micro-Family-Schema', TRUE_MICRO_SCHEMA);
    res.setHeader('X-Learning-Granularity', LEARNING_GRANULARITY);
    res.setHeader('X-Selectable-Child-Micro-Families', '75');
    res.setHeader('X-Parent-Micro-Families', '15');
    res.setHeader('X-Manual-Selection-Preserved', 'true');
    res.setHeader('X-Manual-Selection-Match-Mode', 'EXACT_TRUE_MICRO_FAMILY_ID');
    res.setHeader('X-Discord-Selection-Rule',
'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY');
    res.setHeader('X-Active-Rotation-Preserved', 'true');
    res.setHeader('X-Real-Orders-Disabled', 'true');
    res.setHeader('X-Bitget-Orders-Disabled', 'true');
    res.setHeader('X-Exchange-Calls-Disabled', 'true');
    res.setHeader('X-Redis-Namespace', LONG_NAMESPACE);
    res.setHeader('X-Short-Root-Touched', 'false');


    const token = randomUUID();
    let redis = null;
    let acquiredLocks = [];


    try {
      if (req.method !== 'POST') {
          return methodNotAllowed(res);
      }


      const body = await readBody(req);


      if (!isConfirmed(body)) {
          return res.status(400).json({
            ok: false,
            blocked: true,
            reason: 'LONG_CONFIRMATION_REQUIRED',
            required: CONFIRM_TEXT,
            ...modeFlags()
          });
    }


    if (wantsForbiddenRotationReset(body)) {
        return res.status(400).json({
          ok: false,
          blocked: true,
          reason: 'LONG_ROTATION_RESET_NOT_ALLOWED_HERE',
          note: 'reset-learning wist alleen LONG leerdata. Handmatige LONG 75-child selectie blijft bewaard.',
          ...modeFlags()
        });
    }


    redis = getDurableRedis();


    const lockResult = await acquireResetLearningLocks(redis, token);
    acquiredLocks = lockResult.acquired || [];


    if (!lockResult.ok) {
        const released = await releaseLocks(redis, acquiredLocks, token);
        acquiredLocks = [];


        return res.status(409).json({
          ok: false,
          blocked: true,
          reason: lockResult.reason,
          released,
          ...modeFlags()
        });
    }


    const deleted = await runLearningDeleteSteps(redis, body);


    const report = {
        ok: true,
        type: 'RESET_LEARNING_LONG_75_CHILD_ONLY_VIRTUAL',


        ...modeFlags(),


        taxonomy: buildTaxonomyMeta(),


        exchangeTouched: false,
        bitgetOrdersTouched: false,
        realOrdersTouched: false,
        shortRootTouched: false,


        deleted,
preserved: {
     shortRoot: true,
     shortRedisKeys: true,
     activeRotation: true,
     manualSelection: true,
     selected75ChildTrueMicroFamilyIds: true,
     openVirtualPositions: true,
     scannerSnapshots: true,
     tradeRunMeta: true,
     resetLogs: true,
     discordLogs: true,
     environmentVariables: true,
     deploymentConfig: true
},


removed: {
     weekMicros: true,
     weekMeta: true,
     weekTopSnapshots: true,
     shardedWeekRows: true,
     observationDedupe: true,
     outcomeDedupe: true,
     shadowAnalyzeData: true,
     legacyMicroData: true,
     temporalContextData: true,
     contextStatsData: true,
     sessionStatsData: true,
     nextRotation: true,
     rotationValidFrom: true,


     activeRotation: false,
     manualSelection: false,
     selected75ChildTrueMicroFamilyIds: false,
     openVirtualPositions: false,
     scannerSnapshots: false,
     tradeRunMeta: false,
     discordLogs: false,
     shortRoot: false
},


longKeys: {
     namespace: LONG_NAMESPACE,
     prefix: LONG_KEY_PREFIX,
     resetLogList: LONG_KEYS.reset.logList,
     locks: LOCK_KEYS,
     analyze: LONG_KEYS.analyze
},


temporalContext: buildTemporalContext(),
resetAt: now()
        };


        await pushJsonLog(
             redis,
             LONG_KEYS.reset.logList,
             report,
             100
        ).catch(() => null);


        await sendResetReport(report).catch(() => null);


        return res.status(200).json(report);
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
    } finally {
        if (redis && acquiredLocks.length > 0) {
             await releaseLocks(redis, acquiredLocks, token);
        }
    }
}
