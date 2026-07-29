// ================= FILE: api/scanner/run.js =================


import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import {
     getVolatileRedis,
     setJson
} from '../../src/redis.js';
import { withRedisLock } from '../../src/lock.js';
import { runScanner } from '../../src/market/scanner.js';
import { sideToTradeSide } from '../../src/utils.js';


const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const TARGET_SCANNER_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';


const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;


const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';




const MEASUREMENT_FIX_VERSION =
  'LONG_MEASUREMENT_FIX_TRIGGER_BOUNDARY_EXIT_FILL_V2';
const EXIT_FILL_MODEL_VERSION =
  'LONG_TRIGGER_BOUNDARY_FILL_PLUS_COST_MODEL_V1';
const EMPIRICAL_VETO_POLICY_VERSION =
  'LONG_EXACT_75_CHILD_NET_EDGE_VETO_V1';
const OUTCOME_MEASUREMENT_GATE_MODE = 'STRICT_EXACT_VERSION';
const EMPIRICAL_VETO_MIN_COMPLETED = 35;
const EMPIRICAL_VETO_MAX_AVG_R = 0;

const TEMPORAL_CONTEXT_VERSION =
  'LONG_TEMPORAL_CONTEXT_UTC_V1';
const WEEKEND_POLICY_VERSION =
  'LONG_WEEKEND_OBSERVE_DISCORD_BLOCK_V1';
const SESSION_POLICY_VERSION =
  'LONG_SESSION_OBSERVE_V1';
const WEEKEND_MODE = 'OBSERVE';
const SESSION_MODE = 'OBSERVE';

const UTC_DAY_NAMES = Object.freeze([
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY'
]);

const SESSION_BUCKETS = Object.freeze([
  'ASIA',
  'EUROPE',
  'US',
  'ASIA_EU_OVERLAP',
  'EU_US_OVERLAP',
  'OFF_HOURS'
]);

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const LEARNING_GRANULARITY =
'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_V1';


const DEFAULT_LOCK_TTL_SEC = 540;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;
const MIN_COMPLETED_ACTIVE_LEARNING = 20;


const LONG_SETUP_TYPES = [
     'BREAKOUT',
     'RETEST',
     'SWEEP_REVERSAL',
     'CONTINUATION',
     'COMPRESSION'
];


const LONG_REGIME_BUCKETS = [
     'TREND',
     'CHOP',
     'SQUEEZE'
];


const LONG_CONFIRMATION_PROFILES = [
     'A_STRONG_ALIGN',
     'B_FLOW_ALIGN',
     'C_VOLUME_ALIGN',
     'D_MIXED_OK',
     'E_WEAK_CONTRA'
];


function now() {
     return Date.now();
}

function buildTemporalContext(value = now()) {
  const numeric = Number(value);
  const contextTs = Number.isFinite(numeric) ? numeric : now();
  const date = new Date(contextTs);
  const hourUtc = date.getUTCHours();
  const dayIndex = date.getUTCDay();
  const dayOfWeekUtc = UTC_DAY_NAMES[dayIndex] || 'UNKNOWN';
  const isWeekend = dayIndex === 0 || dayIndex === 6;

  const inAsia = hourUtc >= 0 && hourUtc < 8;
  const inEurope = hourUtc >= 7 && hourUtc < 16;
  const inUs = hourUtc >= 13 && hourUtc < 22;

  const sessionTags = [];
  if (inAsia) sessionTags.push('ASIA');
  if (inEurope) sessionTags.push('EUROPE');
  if (inUs) sessionTags.push('US');

  let primarySessionBucket = 'OFF_HOURS';
  if (inEurope && inUs) {
    primarySessionBucket = 'EU_US_OVERLAP';
  } else if (inAsia && inEurope) {
    primarySessionBucket = 'ASIA_EU_OVERLAP';
  } else if (inAsia) {
    primarySessionBucket = 'ASIA';
  } else if (inEurope) {
    primarySessionBucket = 'EUROPE';
  } else if (inUs) {
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

function temporalPolicyFlags(value = now()) {
  const temporalContext = (
    value &&
    typeof value === 'object' &&
    value.temporalContextVersion === TEMPORAL_CONTEXT_VERSION
  ) ? value : buildTemporalContext(value);

  return {
    ...temporalContext,
    temporalContext,
    weekendMode: WEEKEND_MODE,
    weekendPolicyVersion: WEEKEND_POLICY_VERSION,
    weekendLearningAllowed: true,
    weekendVirtualEntryAllowed: true,
    weekendDiscordEntryAllowed: !temporalContext.isWeekend,
    weekendExitMonitoringAllowed: true,
    weekendOutcomeRecordingAllowed: true,
    weekendPolicyObservedOnly: true,
    sessionMode: SESSION_MODE,
    sessionPolicyVersion: SESSION_POLICY_VERSION,
    sessionLearningAllowed: true,
    sessionVirtualEntryAllowed: true,
    sessionDiscordEntryAllowed: true,
    sessionPolicyObservedOnly: true
  };
}

function entryTemporalFields(row = {}) {
  const entryTs = Number(
    row.entryTs ??
    row.openedAt ??
    row.createdAt ??
    row.signalTs ??
    row.ts ??
    now()
  );
  const context = buildTemporalContext(entryTs);

  return {
    entryTs: context.contextTs,
    entryHourUtc: context.hourUtc,
    entryDayOfWeekUtc: context.dayOfWeekUtc,
    entryDayType: context.dayType,
    entryIsWeekend: context.isWeekend,
    entrySessionTags: context.sessionTags,
    entrySessionBucket: context.primarySessionBucket,
    entrySessionOverlap: context.sessionOverlap,
    entryOffHours: context.offHours
  };
}

function exitTemporalFields(row = {}) {
  const rawExitTs =
    row.exitTs ??
    row.closedAt ??
    row.completedAt ??
    row.updatedAt ??
    null;

  if (rawExitTs === null || rawExitTs === undefined || rawExitTs === '') {
    return {
      exitTs: null,
      exitHourUtc: null,
      exitDayOfWeekUtc: null,
      exitDayType: null,
      exitIsWeekend: null,
      exitSessionTags: [],
      exitSessionBucket: null,
      exitSessionOverlap: false,
      exitOffHours: null
    };
  }

  const context = buildTemporalContext(rawExitTs);
  return {
    exitTs: context.contextTs,
    exitHourUtc: context.hourUtc,
    exitDayOfWeekUtc: context.dayOfWeekUtc,
    exitDayType: context.dayType,
    exitIsWeekend: context.isWeekend,
    exitSessionTags: context.sessionTags,
    exitSessionBucket: context.primarySessionBucket,
    exitSessionOverlap: context.sessionOverlap,
    exitOffHours: context.offHours
  };
}

function emptyContextStats() {
  return {
    WEEKDAY: {},
    WEEKEND: {}
  };
}

function emptySessionStats() {
  return Object.fromEntries(
    SESSION_BUCKETS.map((bucket) => [bucket, {}])
  );
}



function namespacedLongKey(key, fallback = null) {
     let raw = String(key || fallback || '').trim();


     if (!raw) return null;
     if (raw.startsWith(LONG_KEY_PREFIX)) return raw;
     if (raw.startsWith('SHORT:')) raw = raw.slice('SHORT:'.length);


     return `${LONG_KEY_PREFIX}${raw}`;
}


function callMaybe(fn, arg, fallback) {
     try {
         if (typeof fn === 'function') return fn(arg);
     } catch {
         return fallback;
     }


     return fallback;
}


const LONG_KEYS = {
     scan: {
         lock: namespacedLongKey(
              KEYS.long?.scan?.lock ||
                KEYS.scan?.longLock ||
                KEYS.scan?.lock,
              'SCAN:LOCK'
         ),


         latest: namespacedLongKey(
              KEYS.long?.scan?.latest ||
                KEYS.scan?.longLatest ||
                KEYS.scan?.latest,
              'SCAN:LATEST'
         ),


         snapshotPattern: namespacedLongKey(
              callMaybe(KEYS.long?.scan?.snapshot, '*', null) ||
                callMaybe(KEYS.scan?.longSnapshot, '*', null) ||
                callMaybe(KEYS.scan?.snapshot, '*', null),
              'SCAN:SNAPSHOT:*'
         ),


         snapshot: (snapshotId) => namespacedLongKey(
              callMaybe(KEYS.long?.scan?.snapshot, snapshotId, null) ||
                callMaybe(KEYS.scan?.longSnapshot, snapshotId, null) ||
                callMaybe(KEYS.scan?.snapshot, snapshotId, null),
              `SCAN:SNAPSHOT:${snapshotId}`
         )
     }
};


function baseFlags() {
     return {
         ...temporalPolicyFlags(),
         targetTradeSide: TARGET_TRADE_SIDE,
         targetScannerSide: TARGET_SCANNER_SIDE,
         dashboardSide: TARGET_DASHBOARD_SIDE,
         oppositeTradeSide: OPPOSITE_TRADE_SIDE,


         side: TARGET_DASHBOARD_SIDE,
         tradeSide: TARGET_TRADE_SIDE,
         positionSide: TARGET_TRADE_SIDE,
         direction: TARGET_TRADE_SIDE,


         scannerSide: TARGET_SCANNER_SIDE,
         actualScannerSide: TARGET_SCANNER_SIDE,
         analysisSide: TARGET_TRADE_SIDE,


         longOnly: true,
         shortDisabled: true,
         shortOnly: false,
         longDisabled: false,


         scannerOnly: true,
         scannerDecidesTrade: false,
         scannerDoesNotTrade: true,
         scannerDoesNotOpenPositions: true,
         scannerDoesNotSelectMicroFamilies: true,
         scannerDoesNotSendDiscord: true,
scannerFingerprintRole: 'METADATA_ONLY',
scannerFingerprintsMetadataOnly: true,
scannerFingerprintsUsedAsLearningFamily: false,
scannerBucketsMetadataOnly: true,
legacy25BucketsMetadataOnly: true,
scannerHashesMetadataOnly: true,
coinNameMetadataOnly: true,


noTradeExecution: true,
noMicroFamilySelection: true,
noDiscord: true,


noRealOrders: true,
realOrdersDisabled: true,
bitgetOrdersDisabled: true,
exchangeCallsDisabled: true,


virtualLearning: true,
virtualLearningForced: true,
virtualOnly: true,
virtualTracked: true,
shadowOnly: true,
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
         measurementFixVersion: MEASUREMENT_FIX_VERSION,
         acceptedOutcomeMeasurementVersion: MEASUREMENT_FIX_VERSION,
         completedCurrentMeasurementOnly: true,
         strictOutcomeMeasurementGate: true,
         legacyOutcomeMeasurementsExcluded: true,
         exitFillModelVersion: EXIT_FILL_MODEL_VERSION,
         empiricalVetoEnabled: true,
         empiricalVetoPolicyVersion: EMPIRICAL_VETO_POLICY_VERSION,
         empiricalVetoMinCompleted: EMPIRICAL_VETO_MIN_COMPLETED,
         empiricalVetoMaxAvgR: EMPIRICAL_VETO_MAX_AVG_R,



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


currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
currentFitSoftOnly: true,
currentFitBlocksLearning: false,
currentFitBlocksVirtualLearning: false,
currentFitBlocksShadowLearning: false,


analyzeMicroFamiliesOnly: true,
learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
scannerIsNotLearningIdentitySource: true,
scannerIdentitySource: 'SCANNER_METADATA_ONLY',
symbolExcludedFromFamilyId: true,


trueMicroOnly: true,
exactTrueMicroOnly: true,
exactTrueMicroFamilyRequired: true,
trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
learningGranularity: LEARNING_GRANULARITY,
parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
selectableMicroFamilyCount: 75,
parentMicroFamilyCount: 15,
taxonomySetups: LONG_SETUP_TYPES,
taxonomyRegimes: LONG_REGIME_BUCKETS,
taxonomyConfirmationProfiles: LONG_CONFIRMATION_PROFILES,


parentTrueMicroFamilyExample: 'MICRO_LONG_BREAKOUT_TREND',
selectableTrueMicroFamilyExample: 'MICRO_LONG_BREAKOUT_TREND_A_STRONG_ALIGN',


bucketsCoarseOnly: true,
bucketGranularity: 'LOW_MID_HIGH',


manualSelectionOnly: true,
manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
manualSelectionRequires75ChildTrueMicroFamilyId: true,
discordOnlyForSelectedMicroFamilies: true,
discordOnlyForExactTrueMicroMatch: true,
discordMatchSource: 'MANUAL_SELECTED_75_CHILD_TRUE_MICRO_FAMILY_ID',


autoRotationActivationDisabled: true,
         activateFreezeCronDisabled: true,
         resetCronDisabled: true,


         persistentLearningKey: PERSISTENT_LEARNING_KEY,
         weekResetDisabled: true,
         isoWeekLearningDisabled: true,


         minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,
         statusRules: {
              OBSERVING: 'completed == 0',
              EARLY_OUTCOMES: `completed > 0 && completed <
${MIN_COMPLETED_ACTIVE_LEARNING}`,
              ACTIVE_LEARNING: `completed >= ${MIN_COMPLETED_ACTIVE_LEARNING}`
         },


         redisNamespace: LONG_NAMESPACE,
         redisKeyPrefix: LONG_KEY_PREFIX,
         redisKeysSeparatedFromShortRoot: true,
         shortRootTouched: false
    };
}


function methodNotAllowed(res) {
    res.setHeader('Allow', 'GET, POST');


    return res.status(405).json({
         ok: false,
         error: 'METHOD_NOT_ALLOWED',
         allowed: ['GET', 'POST'],
         ...baseFlags()
    });
}


function isAllowedMethod(method) {
    return method === 'GET' || method === 'POST';
}


function parseJson(text) {
    const raw = String(text || '').trim();


    if (!raw) return {};


    try {
         return JSON.parse(raw);
    } catch {
         const error = new Error('INVALID_JSON_BODY');
         error.statusCode = 400;
         throw error;
    }
}


async function readBody(req) {
    if (req.method === 'GET') return {};


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


function isTrue(value) {
    if (value === true || value === 1) return true;


    const raw = String(value ?? '').trim().toLowerCase();


    return ['true', '1', 'yes', 'y', 'on', 'force', 'forced'].includes(raw);
}


function getLockTtlSec() {
    const ttl = Number(
         CONFIG.long?.scanner?.lockTtlSec ||
           CONFIG.scanner?.longLockTtlSec ||
           CONFIG.scanner?.lockTtlSec ||
           DEFAULT_LOCK_TTL_SEC
    );


    if (!Number.isFinite(ttl)) return DEFAULT_LOCK_TTL_SEC;
    if (ttl <= 0) return DEFAULT_LOCK_TTL_SEC;


    return Math.floor(ttl);
}


function shouldForce(req, body = {}) {
    return (
         isTrue(firstValue(req.query?.force, false)) ||
         isTrue(firstValue(req.query?.forced, false)) ||
         isTrue(body.force) ||
         isTrue(body.forced)
    );
}


function sourceLabel(req, body = {}) {
    const manual = (
         isTrue(firstValue(req.query?.manual, false)) ||
         isTrue(firstValue(req.query?.force, false)) ||
         isTrue(firstValue(req.query?.forced, false)) ||
         isTrue(body.manual) ||
         isTrue(body.force) ||
         isTrue(body.forced)
    );


    return manual
         ? 'ADMIN_MANUAL_LONG_SCANNER_RUN'
         : 'CRON_OR_API_LONG_SCANNER_RUN';
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


function safeNumber(value, fallback = 0) {
    const n = Number(value);


    if (!Number.isFinite(n)) return fallback;


    return n;
}


function round(value, decimals = 4) {
    return Number(safeNumber(value, 0).toFixed(decimals));
}


function normalizeTradeSide(value) {
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


function hasLongSignal(value = '') {
    const text = ` ${cleanSideText(value)} `;


    return (
         text.includes('MICRO_LONG_') ||
         text.includes('TRADESIDE=LONG') ||
         text.includes('TRADE_SIDE=LONG') ||
         text.includes('POSITION_SIDE=LONG') ||
         text.includes('POSITIONSIDE=LONG') ||
         text.includes('SIDE=LONG') ||
         text.includes('SIDE=BULL') ||
         text.includes('SIDE=BUY') ||
         text.includes('DIRECTION=LONG') ||
         text.includes('DIRECTION=BULL') ||
         text.includes('DIRECTION=BUY') ||
         text.includes(' LONG_') ||
         text.includes('_LONG ') ||
         text.includes('_LONG_') ||
         text.includes('|LONG|') ||
         text.includes(':LONG') ||
         text.includes('=LONG') ||
         text.includes(' BULL ') ||
         text.includes('_BULL') ||
         text.includes('BULL_') ||
         text.includes('|BULL|') ||
         text.includes(':BULL') ||
         text.includes('=BULL') ||
         text.includes(' BUY ') ||
         text.includes('_BUY') ||
         text.includes('BUY_') ||
         text.includes('|BUY|') ||
         text.includes(':BUY') ||
         text.includes('=BUY')
    );
}


function hasShortSignal(value = '') {
    const text = ` ${cleanSideText(value)} `;


    return (
         text.includes('MICRO_SHORT_') ||
         text.includes('TRADESIDE=SHORT') ||
         text.includes('TRADE_SIDE=SHORT') ||
         text.includes('POSITION_SIDE=SHORT') ||
         text.includes('POSITIONSIDE=SHORT') ||
         text.includes('SIDE=SHORT') ||
         text.includes('SIDE=BEAR') ||
         text.includes('SIDE=SELL') ||
         text.includes('DIRECTION=SHORT') ||
         text.includes('DIRECTION=BEAR') ||
         text.includes('DIRECTION=SELL') ||
         text.includes(' SHORT_') ||
         text.includes('_SHORT ') ||
         text.includes('_SHORT_') ||
         text.includes('|SHORT|') ||
         text.includes(':SHORT') ||
         text.includes('=SHORT') ||
         text.includes(' BEAR ') ||
         text.includes('_BEAR') ||
         text.includes('BEAR_') ||
         text.includes('|BEAR|') ||
         text.includes(':BEAR') ||
         text.includes('=BEAR') ||
         text.includes(' SELL ') ||
         text.includes('_SELL') ||
         text.includes('SELL_') ||
         text.includes('|SELL|') ||
         text.includes(':SELL') ||
         text.includes('=SELL')
    );
}


function inferTradeSideFromText(value) {
    const text = cleanSideText(value);


    if (!text) return 'UNKNOWN';


    const direct = normalizeTradeSide(text);


    if (direct === TARGET_TRADE_SIDE || direct === OPPOSITE_TRADE_SIDE) {
         return direct;
    }


    const longHit = hasLongSignal(text);
    const shortHit = hasShortSignal(text);


    if (longHit && !shortHit) return TARGET_TRADE_SIDE;
    if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;


    if (longHit && shortHit) {
         if (text.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
         if (text.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
        if (text.includes('TRADE_SIDE=LONG') || text.includes('TRADESIDE=LONG'))
return TARGET_TRADE_SIDE;
        if (text.includes('TRADE_SIDE=SHORT') || text.includes('TRADESIDE=SHORT'))
return OPPOSITE_TRADE_SIDE;
    }


    return 'UNKNOWN';
}


function moveMetricValues(row = {}) {
    return [
        row.change1m,
        row.change3m,
        row.change5m,
        row.change15m,
        row.change30m,
        row.change1h,
        row.change2h,
        row.change4h,
        row.change24h,


        row.priceChange1m,
        row.priceChange3m,
        row.priceChange5m,
        row.priceChange15m,
        row.priceChange30m,
        row.priceChange1h,
        row.priceChange2h,
        row.priceChange4h,
        row.priceChange24h,


        row.priceChange1mPct,
        row.priceChange3mPct,
        row.priceChange5mPct,
        row.priceChange15mPct,
        row.priceChange30mPct,
        row.priceChange1hPct,
        row.priceChange2hPct,
        row.priceChange4hPct,
        row.priceChange24hPct,


        row.percentChange,
        row.changePct,
        row.movePct,
        row.pctMove,
        row.scoreMovePct
    ]
        .map((value) => Number(value))
        .filter(Number.isFinite);
}


function hasBullishMove(row = {}) {
    const values = moveMetricValues(row);


    if (!values.length) return false;


    return values.some((value) => value > 0);
}


function hasOnlyBearishMove(row = {}) {
    const values = moveMetricValues(row);


    if (!values.length) return false;


    return values.every((value) => value < 0);
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


function currentFitLabel(score = 0, fallback = 'UNKNOWN') {
    if (!Number.isFinite(score)) return fallback || 'UNKNOWN';
    if (score >= 45) return 'FIT';
    if (score >= 20) return 'OK';
    if (score <= -20) return 'MISFIT';


    return 'NEUTRAL';
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
        row.scannerReason,
        row.reason,
        ...(Array.isArray(row.currentFitReasons) ? row.currentFitReasons : [])
    ]
        .map((value) => upper(value))
        .join(' | ');
}


function directionalMoveScore(row = {}) {
    const values = moveMetricValues(row).filter((value) => value !== 0);


    if (!values.length) return 0;


    return values.reduce((total, value) => total + Math.sign(value), 0);
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
    row.currentFitNumeric,
    row.scannerScore,
    row.moveScore
]);


if (rawFit === null) {
    const moveScore = directionalMoveScore(row);
    const score = moveScore > 0
         ? Math.abs(moveScore)
         : moveScore < 0
                ? -Math.abs(moveScore)
                : 0;


         return {
              score,
              label: currentFitLabel(score, row.currentFit || row.currentFitLabel ||
'UNKNOWN'),
              source: 'LONG_MIRRORED_MOVE_SCORE'
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
         score = rawFit;
    }


    return {
         score,
         label: currentFitLabel(score, row.currentFit || row.currentFitLabel ||
'UNKNOWN'),
         source: 'LONG_MIRRORED_GENERIC_CURRENT_FIT'
    };
}


function rowSide(row = {}) {
    if (typeof row === 'string') return inferTradeSideFromText(row);


    if (!row || typeof row !== 'object') return 'UNKNOWN';
const direct = normalizeTradeSide(
     row.tradeSide ||
     row.positionSide ||
     row.direction ||
     row.scannerSide ||
     row.actualScannerSide ||
     row.analysisSide ||
     row.signalSide ||
     row.entrySide ||
     row.side ||
     row.bias ||
     row.marketBias
);


if (direct !== 'UNKNOWN') return direct;


const reasonSide = inferTradeSideFromText(
     row.scannerReason ||
     row.reason ||
     row.signalReason ||
     row.actionReason ||
     row.rejectionReason ||
     ''
);


if (reasonSide !== 'UNKNOWN') return reasonSide;


const haystack = [
     row.familyId,
     row.family,
     row.baseFamilyId,


     row.microFamilyId,
     row.trueMicroFamilyId,
     row.liveMicroFamilyId,
     row.realMicroFamilyId,
     row.executionMicroFamilyId,
     row.coarseMicroFamilyId,
     row.parentTrueMicroFamilyId,
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
        ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts :
[]),
        ...(Array.isArray(row.executionFingerprintParts) ?
row.executionFingerprintParts : [])
    ]
        .map((value) => String(value || '').trim())
        .filter(Boolean)
        .join('|');


    const textSide = inferTradeSideFromText(haystack);


    if (textSide !== 'UNKNOWN') return textSide;


    if (row.longOnly === true || row.shortDisabled === true) {
        return TARGET_TRADE_SIDE;
    }


    if (row.shortOnly === true || row.longDisabled === true) {
        return OPPOSITE_TRADE_SIDE;
    }


    if (hasBullishMove(row)) return TARGET_TRADE_SIDE;
    if (hasOnlyBearishMove(row)) return OPPOSITE_TRADE_SIDE;


    return 'UNKNOWN';
}


function isLongCandidate(row = {}) {
    return rowSide(row) === TARGET_TRADE_SIDE;
}


function isShortCandidate(row = {}) {
    return rowSide(row) === OPPOSITE_TRADE_SIDE;
}


function normalizeSymbol(value = '') {
    return String(value || '')
        .trim()
      .toUpperCase()
      .replace(/_?USDT$/i, '');
}


function normalizeContractSymbol(value = '') {
    const raw = String(value || '').trim().toUpperCase();


    if (!raw) return '';


    if (raw.endsWith('USDT')) return raw;


    return `${normalizeSymbol(raw)}USDT`;
}


function normalizeScannerMetadata(candidate = {}) {
    return {
      scannerMicroFamilyId:
        candidate.scannerMicroFamilyId ||
        candidate.scannerFamilyId ||
        candidate.scannerBucket ||
        candidate.bucket ||
        null,


      scannerFamilyId:
        candidate.scannerFamilyId ||
        candidate.scannerMicroFamilyId ||
        candidate.scannerBucket ||
        candidate.bucket ||
        null,


      scannerBucket: candidate.scannerBucket || candidate.bucket || null,
      scannerBucket25: candidate.scannerBucket25 || candidate.legacyBucket25 ||
null,
      scannerReason: candidate.scannerReason || candidate.reason ||
'LONG_SCANNER_CANDIDATE',
      scannerReasonCoarse: candidate.scannerReasonCoarse || null,
      scannerDefinition: candidate.scannerDefinition || null,
      scannerDefinitionParts: Array.isArray(candidate.scannerDefinitionParts)
        ? candidate.scannerDefinitionParts
        : [],


      scannerFingerprintHash: candidate.scannerFingerprintHash ||
candidate.fingerprintHash || null,
      scannerFingerprintParts: Array.isArray(candidate.scannerFingerprintParts)
        ? candidate.scannerFingerprintParts
        : [],
         scannerFingerprintRole: 'METADATA_ONLY',
         scannerFingerprintsMetadataOnly: true,
         scannerFingerprintsUsedAsLearningFamily: false,
         scannerBucketsMetadataOnly: true,
         legacy25BucketsMetadataOnly: true,


         analyzeTrueMicroFamilyId: null,
         trueMicroFamilyId: null,
         parentTrueMicroFamilyId: null,
         childTrueMicroFamilyId: null,
         microFamilyId: null,
         learningMicroFamilyId: null,


         learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
         scannerIsLearningIdentitySource: false,
         scannerDoesNotSelectMicroFamilies: true
    };
}


function normalizeLongCandidate(candidate = {}) {
    const symbol = normalizeSymbol(
         candidate.symbol ||
         candidate.baseSymbol ||
         candidate.contractSymbol ||
         candidate.instId ||
         candidate.instrumentId
    );


    const contractSymbol = normalizeContractSymbol(
         candidate.contractSymbol ||
         candidate.symbol ||
         candidate.instId ||
         candidate.instrumentId ||
         symbol
    );


    const createdAt = safeNumber(
         candidate.createdAt ||
           candidate.ts ||
           candidate.scannerTs ||
           Date.now(),
         Date.now()
    );


    const currentFit = getLongCurrentFit(candidate);


    const temporal = temporalPolicyFlags(createdAt);


    return {
...candidate,

...temporal,
scannerTemporalContext: temporal.temporalContext,


symbol,
baseSymbol: symbol,
contractSymbol,


side: TARGET_DASHBOARD_SIDE,
tradeSide: TARGET_TRADE_SIDE,
positionSide: TARGET_TRADE_SIDE,
direction: TARGET_TRADE_SIDE,


scannerSide: TARGET_SCANNER_SIDE,
actualScannerSide: TARGET_SCANNER_SIDE,
analysisSide: TARGET_TRADE_SIDE,


directionalSide: TARGET_DASHBOARD_SIDE,
inferredDirectionalSide: TARGET_DASHBOARD_SIDE,
marketSide: TARGET_DASHBOARD_SIDE,


targetTradeSide: TARGET_TRADE_SIDE,
targetScannerSide: TARGET_SCANNER_SIDE,
dashboardSide: TARGET_DASHBOARD_SIDE,


longOnly: true,
shortDisabled: true,
shortOnly: false,
longDisabled: false,


scannerOnly: true,
scannerDecidesTrade: false,
scannerDoesNotTrade: true,
scannerDoesNotOpenPositions: true,
scannerDoesNotSelectMicroFamilies: true,
scannerDoesNotSendDiscord: true,


noTradeExecution: true,
noMicroFamilySelection: true,
noDiscord: true,


noRealOrders: true,
realOrdersDisabled: true,
bitgetOrdersDisabled: true,
exchangeCallsDisabled: true,


riskTradeSide: TARGET_TRADE_SIDE,
riskGeometryRule: 'LONG: sl < entry < tp',
tpHitRule: 'LONG: price >= tp',
         slHitRule: 'LONG: price <= sl',
         grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
         currentRFormula: '(currentPrice - entry) / (entry - initialSl)',


         currentFit: currentFit.label,
         currentFitLabel: currentFit.label,
         currentFitScore: round(currentFit.score, 4),
         fitScore: round(currentFit.score, 4),
         currentFitSource: currentFit.source,
         longCurrentFit: round(currentFit.score, 4),
         bullCurrentFit: round(currentFit.score, 4),
         bearishCurrentFit: round(-Math.abs(currentFit.score), 4),
         currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
         currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',


         ...normalizeScannerMetadata(candidate),


         scannerScore: safeNumber(candidate.scannerScore ?? candidate.moveScore, 0),
         moveScore: safeNumber(candidate.moveScore ?? candidate.scannerScore, 0),


         change1h: safeNumber(candidate.change1h ?? candidate.priceChange1hPct, 0),
         change24h: safeNumber(candidate.change24h ?? candidate.priceChange24hPct, 0),
         volume24h: safeNumber(candidate.volume24h ?? candidate.quoteVolume24h ??
candidate.quoteVolume, 0),


         btcState: candidate.btcState || null,
         regime: candidate.regime || null,


         fakeBreakout: Boolean(candidate.fakeBreakout),
         fakeBreakoutRisk: Boolean(candidate.fakeBreakoutRisk),


         createdAt,


         isMirrorMicroFamily: false,
         observationMirror: false,
         analysisMirror: false,
         mirrorAnalysisOnly: false
    };
}


function scannerGatePassed(row = {}) {
    if (row.scannerGatePassed === undefined || row.scannerGatePassed === null) {
         return false;
    }


    return Boolean(row.scannerGatePassed);
}
function isAnalyzeOnly(row = {}) {
    return Boolean(
         row.tradeDiscoveryOnly ||
         row.discoveryOnly ||
         row.analyzeOnly ||
         !scannerGatePassed(row)
    );
}


function unwrapPayload(result) {
    if (!result) return null;


    if (result.result?.result?.result?.candidates) return
result.result.result.result;
    if (result.result?.result?.candidates) return result.result.result;
    if (result.result?.candidates) return result.result;
    if (result.candidates) return result;


    if (result.result?.result?.result) return result.result.result.result;
    if (result.result?.result) return result.result.result;
    if (result.result) return result.result;


    return result;
}


function normalizePayload(payload = {}) {
    if (!payload || typeof payload !== 'object') {
         return {
              ok: false,
              reason: 'EMPTY_SCANNER_PAYLOAD',
              ...baseFlags(),
              candidates: [],
              candidatesCount: 0,
              longCandidatesCount: 0,
              shortCandidatesCount: 0,
              rawCandidatesCount: 0,
              rawShortCandidatesIgnored: 0,
              rawUnknownSideCandidatesIgnored: 0
         };
    }


    const payloadTemporal = temporalPolicyFlags(
         payload.createdAt ??
         payload.ts ??
         payload.scannerTs ??
         now()
    );


    const rawCandidates = Array.isArray(payload.candidates)
         ? payload.candidates
         : [];


    const candidates = rawCandidates
    .filter(isLongCandidate)
    .map(normalizeLongCandidate)
    .filter((candidate) => candidate.symbol && candidate.contractSymbol);


  const scannerGateCandidates = candidates.filter(scannerGatePassed);
  const analyzeOnlyCandidates = candidates.filter(isAnalyzeOnly);


  const rawShortCandidatesIgnored = rawCandidates.filter(isShortCandidate).length;
  const rawUnknownSideCandidatesIgnored = rawCandidates.filter((row) =>
rowSide(row) === 'UNKNOWN').length;


  const analyze = payload.analyze && typeof payload.analyze === 'object'
    ? {
        ...payload.analyze,
        ...baseFlags(),
        scannerOutputOnly: true,
        scannerDoesNotWriteLearning: true,
        analyzeMustAssignTrueMicroFamily: true
    }
    : payload.analyze || null;


  return {
    ...payload,
    ...baseFlags(),
    ...payloadTemporal,
    scannerTemporalContext: payloadTemporal.temporalContext,


    sideMode: 'LONG_ONLY',
    payloadRole: 'LONG_SCANNER_DISCOVERY_ONLY',


    candidates,
    candidatesCount: candidates.length,


    longCandidatesCount: candidates.length,
    shortCandidatesCount: 0,


    scannerGateCandidatesCount: scannerGateCandidates.length,
    analyzeOnlyCandidatesCount: analyzeOnlyCandidates.length,


    rawCandidatesCount: rawCandidates.length,
    rawShortCandidatesIgnored,
    rawUnknownSideCandidatesIgnored,


    bullCandidates: candidates.length,
    bearCandidates: 0,


    topSymbols: candidates
        .slice(0, 20)
        .map((candidate) => candidate.symbol)
              .filter(Boolean),


         scannerGateSymbols: scannerGateCandidates
              .slice(0, 20)
              .map((candidate) => candidate.symbol)
              .filter(Boolean),


         analyzeOnlySymbols: analyzeOnlyCandidates
              .slice(0, 20)
              .map((candidate) => candidate.symbol)
              .filter(Boolean),


         analyze
    };
}


function normalizeLockResult(rawResult = {}) {
    if (!rawResult || typeof rawResult !== 'object') {
         return {
              ok: false,
              reason: 'EMPTY_LOCK_RESULT',
              ...baseFlags()
         };
    }


    const payload = normalizePayload(unwrapPayload(rawResult));


    if (rawResult.result?.result?.result?.candidates) {
         return {
              ...rawResult,
              ...baseFlags(),
              result: {
                  ...rawResult.result,
                  result: {
                      ...rawResult.result.result,
                      result: payload
                  }
              }
         };
    }


    if (rawResult.result?.result?.candidates) {
         return {
              ...rawResult,
              ...baseFlags(),
              result: {
                  ...rawResult.result,
                  result: payload
              }
         };
    }


    if (rawResult.result?.candidates) {
         return {
              ...rawResult,
              ...baseFlags(),
              result: payload
         };
    }


    if (rawResult.candidates) {
         return payload;
    }


    return {
         ...rawResult,
         ...baseFlags(),
         result: payload
    };
}


function resolveStatus(error) {
    if (Number.isFinite(error?.statusCode)) return error.statusCode;


    if (
         error?.reason === 'LOCK_NOT_ACQUIRED' ||
         error?.message === 'LOCK_NOT_ACQUIRED' ||
         String(error?.message || '').includes('LOCK')
    ) {
         return 409;
    }


    return 500;
}


function buildScannerOptions(req, body = {}) {
    const force = shouldForce(req, body);


    const temporal = temporalPolicyFlags(now());


    return {
         force,
         ...temporal,
         scannerTemporalContext: temporal.temporalContext,
         forced: force,


         targetTradeSide: TARGET_TRADE_SIDE,
         tradeSide: TARGET_TRADE_SIDE,
positionSide: TARGET_TRADE_SIDE,
direction: TARGET_TRADE_SIDE,


side: TARGET_DASHBOARD_SIDE,
scannerSide: TARGET_SCANNER_SIDE,
actualScannerSide: TARGET_SCANNER_SIDE,
dashboardSide: TARGET_DASHBOARD_SIDE,
analysisSide: TARGET_TRADE_SIDE,


longOnly: true,
shortDisabled: true,
disableShort: true,


shortOnly: false,
longDisabled: false,


scannerOnly: true,
scannerDecidesTrade: false,
scannerDoesNotTrade: true,
scannerDoesNotOpenPositions: true,
scannerDoesNotSelectMicroFamilies: true,
scannerDoesNotSendDiscord: true,


scannerFingerprintRole: 'METADATA_ONLY',
scannerFingerprintsMetadataOnly: true,
scannerFingerprintsUsedAsLearningFamily: false,
scannerBucketsMetadataOnly: true,
legacy25BucketsMetadataOnly: true,
scannerHashesMetadataOnly: true,
coinNameMetadataOnly: true,


noTradeExecution: true,
noDiscord: true,
noMicroFamilySelection: true,


noRealOrders: true,
realOrdersDisabled: true,
bitgetOrdersDisabled: true,
exchangeCallsDisabled: true,


virtualLearning: true,
virtualLearningForced: true,
virtualOnly: true,


analyzeMicroFamiliesOnly: true,
learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
scannerIsNotLearningIdentitySource: true,
         symbolExcludedFromFamilyId: true,


         trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
         parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
         learningGranularity: LEARNING_GRANULARITY,
         parentLearningGranularity: PARENT_LEARNING_GRANULARITY,


         riskGeometryRule: 'LONG: sl < entry < tp',
         tpHitRule: 'LONG: price >= tp',
         slHitRule: 'LONG: price <= sl',
         grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
         currentRFormula: '(currentPrice - entry) / (entry - initialSl)',
         currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
         currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',


         persistentLearningKey: PERSISTENT_LEARNING_KEY,
         namespace: LONG_NAMESPACE,
         keyPrefix: LONG_KEY_PREFIX,
         redisNamespace: LONG_NAMESPACE,
         redisKeyPrefix: LONG_KEY_PREFIX,


         keys: {
             scanLock: LONG_KEYS.scan.lock,
             scanLatest: LONG_KEYS.scan.latest,
             scanSnapshotPattern: LONG_KEYS.scan.snapshotPattern
         }
    };
}


async function persistLongScannerPayload(redis, payload = {}) {
    const snapshotId = payload?.snapshotId || payload?.id || payload?.scanId ||
null;


    const persistedTemporal = temporalPolicyFlags(
         payload.contextTs ??
         payload.createdAt ??
         payload.ts ??
         now()
    );


    const latestPayload = {
         ...payload,
         ...baseFlags(),
         ...persistedTemporal,
         scannerTemporalContext: persistedTemporal.temporalContext,


         snapshotId,
         persistedAt: now(),
         persistedBy: 'api/scanner/run.js',
         persistedNamespace: LONG_NAMESPACE,


         scannerPayloadRole: 'DISCOVERY_METADATA_ONLY',
         scannerDoesNotTrade: true,
         scannerDoesNotSelectMicroFamilies: true,
         scannerDoesNotSendDiscord: true,
         longKeys: {
             namespace: LONG_NAMESPACE,
             prefix: LONG_KEY_PREFIX,
             scanLatest: LONG_KEYS.scan.latest,
             snapshotKey: snapshotId ? LONG_KEYS.scan.snapshot(snapshotId) : null
         }
    };


    await setJson(redis, LONG_KEYS.scan.latest, latestPayload).catch(() => null);


    if (snapshotId) {
         await setJson(
             redis,
             LONG_KEYS.scan.snapshot(snapshotId),
             latestPayload
         ).catch(() => null);
    }


    return {
         persistedLongLatest: true,
         persistedLongSnapshot: Boolean(snapshotId),
         scanLatest: LONG_KEYS.scan.latest,
         snapshotKey: snapshotId ? LONG_KEYS.scan.snapshot(snapshotId) : null
    };
}


export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('X-Scanner-Target-Side', TARGET_TRADE_SIDE);
    res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
    res.setHeader('X-Dashboard-Side', TARGET_DASHBOARD_SIDE);
    res.setHeader('X-Long-Only', 'true');
    res.setHeader('X-Short-Disabled', 'true');
    res.setHeader('X-Scanner-Only', 'true');
    res.setHeader('X-No-Trade-Execution', 'true');
    res.setHeader('X-No-Discord', 'true');
    res.setHeader('X-No-Micro-Family-Selection', 'true');
    res.setHeader('X-Scanner-Fingerprints-Metadata-Only', 'true');
    res.setHeader('X-Scanner-Fingerprints-Used-As-Learning-Family', 'false');
    res.setHeader('X-Learning-Identity-Source', 'ANALYZE_TRUE_MICRO_FAMILY');
    res.setHeader('X-True-Micro-Family-Schema', TRUE_MICRO_SCHEMA);
    res.setHeader('X-Parent-True-Micro-Family-Schema', PARENT_TRUE_MICRO_SCHEMA);
    res.setHeader('X-Learning-Granularity', LEARNING_GRANULARITY);
    res.setHeader('X-Real-Orders-Disabled', 'true');
    res.setHeader('X-Bitget-Orders-Disabled', 'true');
    res.setHeader('X-Exchange-Calls-Disabled', 'true');
    res.setHeader('X-Virtual-Learning-Forced', 'true');
    res.setHeader('X-Weekend-Mode', WEEKEND_MODE);
    res.setHeader('X-Session-Mode', SESSION_MODE);
    res.setHeader('X-Weekend-Discord-Entry-Allowed', String(!buildTemporalContext(now()).isWeekend));
res.setHeader('X-Persistent-Learning-Key', PERSISTENT_LEARNING_KEY);
res.setHeader('X-Redis-Namespace', LONG_NAMESPACE);
res.setHeader('X-Short-Root-Touched', 'false');


const startedAt = now();


try {
  if (!isAllowedMethod(req.method)) {
       return methodNotAllowed(res);
  }


  const body = await readBody(req);
  const scannerOptions = buildScannerOptions(req, body);


  const redis = getVolatileRedis();
  const lockKey = LONG_KEYS.scan.lock;
  const lockTtlSec = getLockTtlSec();


  const rawResult = await withRedisLock(
       redis,
       lockKey,
       lockTtlSec,
       async () => runScanner(scannerOptions)
  );


  const result = normalizeLockResult(rawResult);
  const payload = normalizePayload(unwrapPayload(result));


  const persistence = await persistLongScannerPayload(redis, payload);


  const ok = result?.ok !== false && payload?.ok !== false;


  return res.status(200).json({
       ok,
       skipped: Boolean(result?.skipped || payload?.skipped || false),
       reason: result?.reason || payload?.reason || null,


       source: sourceLabel(req, body),


       ...baseFlags(),


       force: scannerOptions.force,


       persisted: payload?.persisted ?? result?.persisted ?? null,
       longPersistence: persistence,


       snapshotId: payload?.snapshotId || result?.snapshotId || null,
         candidatesCount: Number(payload?.candidatesCount || 0),
         longCandidatesCount: Number(payload?.longCandidatesCount ||
payload?.candidatesCount || 0),
         shortCandidatesCount: 0,


         scannerGateCandidatesCount: Number(payload?.scannerGateCandidatesCount ||
0),
         analyzeOnlyCandidatesCount: Number(payload?.analyzeOnlyCandidatesCount ||
0),


         rawCandidatesCount: Number(payload?.rawCandidatesCount || payload?.rawCount
|| 0),
         rawShortCandidatesIgnored: Number(payload?.rawShortCandidatesIgnored || 0),
         rawUnknownSideCandidatesIgnored:
Number(payload?.rawUnknownSideCandidatesIgnored || 0),


         topSymbols: payload?.topSymbols || [],
         scannerGateSymbols: payload?.scannerGateSymbols || [],
         analyzeOnlySymbols: payload?.analyzeOnlySymbols || [],


         analyze: payload?.analyze || null,


         longKeys: {
              namespace: LONG_NAMESPACE,
              prefix: LONG_KEY_PREFIX,
              scanLock: LONG_KEYS.scan.lock,
              scanLatest: LONG_KEYS.scan.latest,
              scanSnapshotPattern: LONG_KEYS.scan.snapshotPattern,
              snapshotKey: payload?.snapshotId ?
LONG_KEYS.scan.snapshot(payload.snapshotId) : null
         },


         durationMs: now() - startedAt,


         result
      });
  } catch (error) {
      return res.status(resolveStatus(error)).json({
         ok: false,


         ...baseFlags(),


         error: error?.message || String(error),
         durationMs: now() - startedAt,
         stack: process.env.NODE_ENV === 'production'
              ? undefined
              : error?.stack
        });
    }
}
