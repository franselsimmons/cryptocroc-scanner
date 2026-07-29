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
'LONG_TEMPORAL_CONTEXT_UTC_V2';
const WEEKEND_POLICY_VERSION =
'LONG_WEEKEND_POSITIVE_OVERRIDE_V2';
const SESSION_POLICY_VERSION =
'LONG_SESSION_NEGATIVE_VETO_V2';
const WEEKEND_MODE = 'POSITIVE_OVERRIDE';
const SESSION_MODE = 'NEGATIVE_VETO';


const TEMPORAL_STATS_VERSION = 'LONG_TEMPORAL_FAMILY_STATS_V1';
const TEMPORAL_POLICY_VERSION = 'LONG_TEMPORAL_NEGATIVE_VETO_WEEKLY_GENERATION_V1';
const TEMPORAL_AGGREGATION_VERSION = 'LONG_TEMPORAL_CANONICAL_OUTCOME_V1';
const TEMPORAL_GENERATION_VERSION = 'LONG_TEMPORAL_ROOT_GENERATION_V1';
const TEMPORAL_POLICY_MODES = Object.freeze(['OFF', 'OBSERVE', 'ENFORCE']);
const TEMPORAL_GENERATION_STATES = Object.freeze([
  'BUILDING',
  'INTEGRITY_CHECK_RUNNING',
  'READY',
  'ACTIVE',
  'SUPERSEDED',
  'INVALID',
  'EXPIRED',
  'ACTIVATION_WINDOW_EXPIRED'
]);
const TEMPORAL_ACTIVE_DECISIONS = Object.freeze([
  'INHERIT_GLOBAL',
  'NO_VETO',
  'VETO_ACTIVE',
  'CONFOUNDED_NO_VETO'
]);
const TEMPORAL_CANDIDATE_DECISIONS = Object.freeze([
  'VETO_CANDIDATE',
  'RECOVERY_CANDIDATE',
  'CONFOUNDED_CANDIDATE',
  'WEEKEND_APPROVAL_CANDIDATE'
]);
const TEMPORAL_DAY_TYPES = Object.freeze(['WEEKDAY', 'WEEKEND']);
const TEMPORAL_GATE_WINDOW_MAX_OUTCOMES = 50;
const TEMPORAL_GATE_WINDOW_MAX_AGE_DAYS = 180;
const TEMPORAL_VETO_MIN_COMPLETED = 35;
const TEMPORAL_WEEKEND_APPROVAL_MIN_COMPLETED = 50;
const TEMPORAL_GENERATION_MAX_AGE_DAYS = 14;
const TEMPORAL_VETO_STALE_DAYS = 60;
const TEMPORAL_WEEKEND_FRESHNESS_DAYS = 45;

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
         temporalAdmin: buildTemporalAdminEnvelope(source),
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
         temporalAdmin: buildTemporalAdminEnvelope(),
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
`completed >= ${MIN_COMPLETED_ACTIVE_LEARNING} && completed <
${EMPIRICAL_VETO_MIN_COMPLETED}`,
PASSED:
`completed >= ${EMPIRICAL_VETO_MIN_COMPLETED} && avgR >
${EMPIRICAL_VETO_MAX_AVG_R}`,
EMPIRICAL_VETO:
`completed >= ${EMPIRICAL_VETO_MIN_COMPLETED} && avgR <=
${EMPIRICAL_VETO_MAX_AVG_R}`
},
activationGateRules: {
PASSED:
`completed >= ${EMPIRICAL_VETO_MIN_COMPLETED} && avgR >
${EMPIRICAL_VETO_MAX_AVG_R}`,
EMPIRICAL_VETO:
`completed >= ${EMPIRICAL_VETO_MIN_COMPLETED} && avgR <=
${EMPIRICAL_VETO_MAX_AVG_R}`
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
selectableChildFormat:
'MICRO_LONG_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',

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



// ============================================================================
// TEMPORAL ADMIN PROJECTION - READ-ONLY NORMALIZATION
// ============================================================================
// This route does not build generations, aggregate outcomes or apply Discord
// entry gates. It only exposes the state produced by the authoritative LONG
// trade/analyze/temporal modules. Unknown fields are normalized fail-safely.

function temporalAdminFinite(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function temporalAdminBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function temporalAdminObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function temporalAdminFirst(source = {}, keys = [], fallback = null) {
  const row = temporalAdminObject(source);
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallback;
}

function temporalAdminPolicyMode(value, fallback = 'OBSERVE') {
  const normalized = String(value || '').trim().toUpperCase();
  if (TEMPORAL_POLICY_MODES.includes(normalized)) return normalized;
  const normalizedFallback = String(fallback || '').trim().toUpperCase();
  return TEMPORAL_POLICY_MODES.includes(normalizedFallback)
    ? normalizedFallback
    : 'OBSERVE';
}

function temporalAdminStatsEnabled(source = {}) {
  return temporalAdminBool(
    temporalAdminFirst(source, [
      'temporalStatsEnabled',
      'longTemporalStatsEnabled',
      'TEMPORAL_STATS_ENABLED'
    ], process.env.LONG_TEMPORAL_STATS_ENABLED ?? process.env.TEMPORAL_STATS_ENABLED),
    true
  );
}

function temporalAdminResolvedPolicyMode(source = {}) {
  if (!temporalAdminStatsEnabled(source)) return 'OFF';
  return temporalAdminPolicyMode(
    temporalAdminFirst(source, [
      'temporalPolicyMode',
      'policyMode',
      'longTemporalPolicyMode',
      'TEMPORAL_POLICY_MODE'
    ], process.env.LONG_TEMPORAL_POLICY_MODE ?? process.env.TEMPORAL_POLICY_MODE),
    'OBSERVE'
  );
}

function temporalAdminNormalizeTimestamp(value, fallback = Date.now()) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    const fallbackNumber = Number(fallback);
    return Number.isFinite(fallbackNumber) && fallbackNumber > 0
      ? Math.floor(fallbackNumber)
      : Date.now();
  }
  return n < 10_000_000_000 ? Math.floor(n * 1000) : Math.floor(n);
}

function temporalAdminMarketEventClusterId(source = {}, entryTs = Date.now()) {
  const explicit = temporalAdminFirst(source, [
    'marketEventClusterId',
    'scannerRunId',
    'marketSnapshotId',
    'snapshotId',
    'marketCycleId',
    'scanRunId'
  ]);
  if (explicit !== null) return String(explicit);
  const normalizedEntryTs = temporalAdminNormalizeTimestamp(entryTs, Date.now());
  const hourStartTs = Math.floor(normalizedEntryTs / 3_600_000) * 3_600_000;
  return `${TARGET_TRADE_SIDE}:UTC_HOUR:${hourStartTs}`;
}

function temporalAdminContextFromRecord(source = {}, prefix = 'entry', fallbackTs = Date.now()) {
  const row = temporalAdminObject(source);
  const isEntry = prefix === 'entry';
  const timestampKeys = isEntry
    ? ['entryTs', 'openedAt', 'openTs', 'entryAt', 'positionOpenedAt', 'createdAt', 'ts']
    : ['exitTs', 'closedAt', 'closeTs', 'exitAt', 'positionClosedAt', 'completedAt', 'updatedAt'];
  const explicitTs = temporalAdminFirst(row, timestampKeys, null);
  if (!isEntry && explicitTs === null) {
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
  const ts = temporalAdminNormalizeTimestamp(explicitTs, fallbackTs);
  const computed = buildTemporalContext(ts);
  const field = (suffix) => `${prefix}${suffix}`;
  const explicitTags = temporalAdminFirst(row, [field('SessionTags')], computed.sessionTags);
  const tags = Array.isArray(explicitTags)
    ? explicitTags.map((value) => String(value || '').trim().toUpperCase())
      .filter((value) => ['ASIA', 'EUROPE', 'US'].includes(value))
    : computed.sessionTags;
  const explicitBucket = String(
    temporalAdminFirst(row, [field('SessionBucket')], computed.primarySessionBucket) || ''
  ).trim().toUpperCase();
  const bucket = PRIMARY_SESSION_BUCKETS.includes(explicitBucket)
    ? explicitBucket
    : computed.primarySessionBucket;
  const day = String(
    temporalAdminFirst(row, [field('DayOfWeekUtc')], computed.dayOfWeekUtc) || computed.dayOfWeekUtc
  ).trim().toUpperCase();
  const weekend = temporalAdminBool(
    temporalAdminFirst(row, [field('IsWeekend')], computed.isWeekend),
    computed.isWeekend
  );
  return {
    [field('Ts')]: ts,
    [field('HourUtc')]: temporalAdminFinite(
      temporalAdminFirst(row, [field('HourUtc')], computed.hourUtc),
      computed.hourUtc
    ),
    [field('DayOfWeekUtc')]: DAY_NAMES_UTC.includes(day) ? day : computed.dayOfWeekUtc,
    [field('DayType')]: String(
      temporalAdminFirst(row, [field('DayType')], weekend ? 'WEEKEND' : 'WEEKDAY')
    ).trim().toUpperCase(),
    [field('IsWeekend')]: weekend,
    [field('SessionTags')]: tags,
    [field('SessionBucket')]: bucket,
    [field('SessionOverlap')]: temporalAdminBool(
      temporalAdminFirst(row, [field('SessionOverlap')], tags.length > 1),
      tags.length > 1
    ),
    [field('OffHours')]: temporalAdminBool(
      temporalAdminFirst(row, [field('OffHours')], bucket === 'OFF_HOURS'),
      bucket === 'OFF_HOURS'
    )
  };
}

function temporalAdminGateMaturity(completed) {
  const n = Math.max(0, Math.floor(temporalAdminFinite(completed, 0) || 0));
  if (n === 0) return 'OBSERVING';
  if (n < 20) return 'EARLY_OUTCOMES';
  if (n < 35) return 'ACTIVE_LEARNING';
  return 'MATURE';
}

function temporalAdminActiveDecision(value, fallback = 'INHERIT_GLOBAL') {
  const normalized = String(value || '').trim().toUpperCase();
  return TEMPORAL_ACTIVE_DECISIONS.includes(normalized) ? normalized : fallback;
}

function temporalAdminCandidateDecision(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return TEMPORAL_CANDIDATE_DECISIONS.includes(normalized) ? normalized : null;
}

function temporalAdminNormalizeBucket(value = {}) {
  const source = temporalAdminObject(value);
  const lifetimeSource = temporalAdminObject(source.lifetimeStats || source.lifetime || source);
  const windowSource = temporalAdminObject(
    source.gateWindowStats || source.gateWindow || source.recentWindow || {}
  );
  const completed = Math.max(0, Math.floor(temporalAdminFinite(
    temporalAdminFirst(lifetimeSource, ['completed', 'lifetimeCompleted'], 0),
    0
  ) || 0));
  const sumNetR = temporalAdminFinite(
    temporalAdminFirst(lifetimeSource, ['sumNetR', 'totalR', 'lifetimeSumNetR'], 0),
    0
  );
  const sumNetR2 = temporalAdminFinite(
    temporalAdminFirst(lifetimeSource, ['sumNetR2', 'lifetimeSumNetR2'], 0),
    0
  );
  const gateWindowCompleted = Math.max(0, Math.min(
    TEMPORAL_GATE_WINDOW_MAX_OUTCOMES,
    Math.floor(temporalAdminFinite(
      temporalAdminFirst(windowSource, ['gateWindowCompleted', 'completed', 'n'], 0),
      0
    ) || 0)
  ));
  const avgNetR = completed > 0
    ? temporalAdminFinite(
      temporalAdminFirst(lifetimeSource, ['avgNetR', 'avgR'], sumNetR / completed),
      sumNetR / completed
    )
    : 0;
  const gateWindowAvgNetR = gateWindowCompleted > 0
    ? temporalAdminFinite(
      temporalAdminFirst(windowSource, ['gateWindowAvgNetR', 'avgNetR', 'avgR'], 0),
      0
    )
    : 0;
  const decisionSource = temporalAdminObject(source.activeDecision || source.decision || source);
  const diversity = temporalAdminObject(
    source.sampleDiversityDiagnostics || source.diversity || windowSource.sampleDiversityDiagnostics
  );
  const eventDiversity = temporalAdminObject(
    source.marketEventDiversityDiagnostics || source.eventDiversity || windowSource.marketEventDiversityDiagnostics
  );
  const confounding = temporalAdminObject(
    source.confoundingDiagnostics || source.confounding || windowSource.confoundingDiagnostics
  );
  return {
    observations: Math.max(0, Math.floor(temporalAdminFinite(
      temporalAdminFirst(lifetimeSource, ['observations', 'seen'], 0), 0
    ) || 0)),
    completed,
    wins: Math.max(0, Math.floor(temporalAdminFinite(lifetimeSource.wins, 0) || 0)),
    losses: Math.max(0, Math.floor(temporalAdminFinite(lifetimeSource.losses, 0) || 0)),
    flats: Math.max(0, Math.floor(temporalAdminFinite(lifetimeSource.flats, 0) || 0)),
    sumNetR,
    sumNetR2,
    avgNetR,
    grossWinR: temporalAdminFinite(lifetimeSource.grossWinR, 0),
    grossLossR: temporalAdminFinite(lifetimeSource.grossLossR, 0),
    totalCostR: temporalAdminFinite(lifetimeSource.totalCostR, 0),
    directSLCount: Math.max(0, Math.floor(temporalAdminFinite(lifetimeSource.directSLCount, 0) || 0)),
    lastOutcomeTs: temporalAdminFinite(lifetimeSource.lastOutcomeTs, null),
    acceptedTemporalOutcomeSeq: Math.max(0, Math.floor(temporalAdminFinite(
      temporalAdminFirst(source, ['acceptedTemporalOutcomeSeq', 'outcomeSeq'], 0), 0
    ) || 0)),
    gateWindowCompleted,
    gateWindowSumNetR: temporalAdminFinite(
      temporalAdminFirst(windowSource, ['gateWindowSumNetR', 'sumNetR', 'totalR'], 0), 0
    ),
    gateWindowSumNetR2: temporalAdminFinite(
      temporalAdminFirst(windowSource, ['gateWindowSumNetR2', 'sumNetR2'], 0), 0
    ),
    gateWindowAvgNetR,
    gateWindowStddev: temporalAdminFinite(
      temporalAdminFirst(windowSource, ['gateWindowStddev', 'stddev'], null), null
    ),
    gateWindowSE: temporalAdminFinite(
      temporalAdminFirst(windowSource, ['gateWindowSE', 'se'], null), null
    ),
    gateWindowLCB95: temporalAdminFinite(
      temporalAdminFirst(windowSource, ['gateWindowLCB95', 'lcb95'], null), null
    ),
    gateWindowUCB95: temporalAdminFinite(
      temporalAdminFirst(windowSource, ['gateWindowUCB95', 'ucb95'], null), null
    ),
    rawPValue: temporalAdminFinite(
      temporalAdminFirst(windowSource, ['rawPValue', 'gateWindowRawPValue'], null), null
    ),
    adjustedQValue: temporalAdminFinite(
      temporalAdminFirst(windowSource, ['adjustedQValue', 'gateWindowAdjustedQValue'], null), null
    ),
    oldestOutcomeTs: temporalAdminFinite(
      temporalAdminFirst(windowSource, ['oldestOutcomeTs', 'gateWindowOldestOutcomeTs'], null), null
    ),
    newestOutcomeTs: temporalAdminFinite(
      temporalAdminFirst(windowSource, ['newestOutcomeTs', 'gateWindowNewestOutcomeTs'], null), null
    ),
    gateMaturityStatus: String(
      temporalAdminFirst(source, ['gateMaturityStatus', 'maturityStatus'], temporalAdminGateMaturity(gateWindowCompleted))
    ).trim().toUpperCase(),
    activeTemporalDecision: temporalAdminActiveDecision(
      temporalAdminFirst(decisionSource, ['activeTemporalDecision', 'decision', 'status'], 'INHERIT_GLOBAL')
    ),
    candidateTemporalDecision: temporalAdminCandidateDecision(
      temporalAdminFirst(source, ['candidateTemporalDecision', 'candidateDecision', 'evaluationStatus'], null)
    ),
    candidateEnteredAtSeq: temporalAdminFinite(source.candidateEnteredAtSeq, null),
    vetoActivatedAtSeq: temporalAdminFinite(source.vetoActivatedAtSeq, null),
    candidateEnteredFreezeSeq: temporalAdminFinite(source.candidateEnteredFreezeSeq, null),
    candidateAgeFreezes: temporalAdminFinite(source.candidateAgeFreezes, null),
    sampleDiversityStatus: String(
      temporalAdminFirst(diversity, ['sampleDiversityStatus', 'status'], 'UNKNOWN')
    ).trim().toUpperCase(),
    distinctEntryDates: temporalAdminFinite(diversity.distinctEntryDates, null),
    distinctIsoWeeks: temporalAdminFinite(diversity.distinctIsoWeeks, null),
    distinctSymbols: temporalAdminFinite(diversity.distinctSymbols, null),
    dominantDateShare: temporalAdminFinite(
      temporalAdminFirst(diversity, ['dominantDateShare', 'maxDayShare'], null), null
    ),
    dominantSymbolShare: temporalAdminFinite(
      temporalAdminFirst(diversity, ['dominantSymbolShare', 'maxSymbolShare'], null), null
    ),
    marketEventDiversityStatus: String(
      temporalAdminFirst(eventDiversity, ['marketEventDiversityStatus', 'status'], 'UNKNOWN')
    ).trim().toUpperCase(),
    distinctMarketEventClusters: temporalAdminFinite(eventDiversity.distinctMarketEventClusters, null),
    dominantMarketEventClusterShare: temporalAdminFinite(
      temporalAdminFirst(eventDiversity, ['dominantMarketEventClusterShare', 'dominantClusterShare'], null), null
    ),
    confoundingStatus: String(
      temporalAdminFirst(confounding, ['confoundingStatus', 'status'], 'UNKNOWN')
    ).trim().toUpperCase(),
    dominantLossShare: temporalAdminFinite(confounding.dominantLossShare, null),
    supportingNegativeCellCount: temporalAdminFinite(
      temporalAdminFirst(confounding, ['supportingNegativeCellCount', 'supportingCellCount'], null), null
    ),
    vetoReason: temporalAdminFirst(source, ['vetoReason', 'blockReason'], null)
  };
}

function temporalAdminNormalizeStats(record = {}) {
  const row = temporalAdminObject(record);
  const root = temporalAdminObject(row.temporalStats || row.temporalFamilyStats || {});
  const dayTypeSource = temporalAdminObject(
    root.dayType || row.dayTypeStats || row.contextStats || {}
  );
  const dayOfWeekSource = temporalAdminObject(
    root.dayOfWeek || row.dayOfWeekStats || {}
  );
  const sessionSource = temporalAdminObject(
    root.session || row.sessionStats || row.primarySessionStats || {}
  );
  const hasSource = Boolean(
    row.temporalStats || row.temporalFamilyStats || row.dayTypeStats ||
    row.contextStats || row.dayOfWeekStats || row.sessionStats || row.primarySessionStats
  );
  return {
    available: hasSource,
    source: hasSource ? 'AUTHORITATIVE_TEMPORAL_AGGREGATE' : 'NOT_YET_AVAILABLE',
    temporalStatsVersion: temporalAdminFirst(row, ['temporalStatsVersion'], TEMPORAL_STATS_VERSION),
    temporalAggregationVersion: temporalAdminFirst(
      row, ['temporalAggregationVersion'], TEMPORAL_AGGREGATION_VERSION
    ),
    dayType: Object.fromEntries(
      TEMPORAL_DAY_TYPES.map((bucket) => [bucket, temporalAdminNormalizeBucket(dayTypeSource[bucket])])
    ),
    dayOfWeek: Object.fromEntries(
      DAY_NAMES_UTC.map((bucket) => [bucket, temporalAdminNormalizeBucket(dayOfWeekSource[bucket])])
    ),
    session: Object.fromEntries(
      PRIMARY_SESSION_BUCKETS.map((bucket) => [bucket, temporalAdminNormalizeBucket(sessionSource[bucket])])
    )
  };
}

function temporalAdminNormalizeGeneration(value = {}, fallbackStatus = 'MISSING', referenceTs = Date.now()) {
  const source = temporalAdminObject(value);
  const manifest = temporalAdminObject(source.manifest || source.generationMetadata || source);
  const projectionCount = temporalAdminFinite(
    temporalAdminFirst(manifest, ['familyCount', 'projectionCount'], null), null
  );
  const cutoffTs = temporalAdminFinite(
    temporalAdminFirst(manifest, ['generationCutoffTs', 'profileCutoffTs', 'cutoffTs'], null), null
  );
  const ageDays = cutoffTs
    ? Math.max(0, (temporalAdminNormalizeTimestamp(referenceTs) - temporalAdminNormalizeTimestamp(cutoffTs)) / 86_400_000)
    : null;
  let status = String(
    temporalAdminFirst(source, ['generationStatus', 'status', 'profileStatus'], fallbackStatus)
  ).trim().toUpperCase();
  if (!TEMPORAL_GENERATION_STATES.includes(status) && status !== 'MISSING' && status !== 'CORRUPT' && status !== 'VERSION_INCOMPATIBLE') {
    status = fallbackStatus;
  }
  if (ageDays !== null && ageDays > TEMPORAL_GENERATION_MAX_AGE_DAYS && status === 'ACTIVE') {
    status = 'EXPIRED';
  }
  return {
    generationId: temporalAdminFirst(source, [
      'generationId', 'activeTemporalGenerationId', 'nextTemporalGenerationId', 'profileId'
    ], null),
    generationStatus: status,
    generationCutoffTs: cutoffTs,
    generationAgeDays: ageDays,
    temporalPolicyVersion: temporalAdminFirst(manifest, ['temporalPolicyVersion'], TEMPORAL_POLICY_VERSION),
    temporalGenerationVersion: temporalAdminFirst(manifest, ['temporalGenerationVersion'], TEMPORAL_GENERATION_VERSION),
    temporalAggregationVersion: temporalAdminFirst(manifest, ['temporalAggregationVersion'], TEMPORAL_AGGREGATION_VERSION),
    measurementVersion: temporalAdminFirst(manifest, ['measurementVersion', 'measurementFixVersion'], null),
    costModelVersion: temporalAdminFirst(manifest, ['costModelVersion', 'exitFillModelVersion'], null),
    taxonomyVersion: temporalAdminFirst(manifest, ['taxonomyVersion', 'trueMicroFamilySchema'], null),
    side: String(temporalAdminFirst(manifest, ['side', 'tradeSide'], TARGET_TRADE_SIDE)).trim().toUpperCase(),
    familyCount: projectionCount,
    expectedFamilyCount: 75,
    familyCountValid: projectionCount === null ? null : projectionCount === 75,
    checksum: temporalAdminFirst(manifest, ['checksum', 'checksumJson'], null),
    freezeSequence: temporalAdminFinite(manifest.freezeSequence, null),
    activationWindowExpiresTs: temporalAdminFinite(manifest.activationWindowExpiresTs, null),
    readyForActivation: status === 'READY',
    usableInEnforce: status === 'ACTIVE' && (ageDays === null || ageDays <= TEMPORAL_GENERATION_MAX_AGE_DAYS)
  };
}

function temporalAdminProjectionSource(record = {}) {
  const row = temporalAdminObject(record);
  return temporalAdminObject(
    row.activeTemporalProjection ||
    row.temporalProjection ||
    row.activeTemporalProfile ||
    row.activeTemporalGeneration?.projection ||
    row.activeTemporalGeneration?.activeProjection ||
    {}
  );
}

function temporalAdminProjectionDecision(projection = {}, dimension, bucket, fallback = 'INHERIT_GLOBAL') {
  const source = temporalAdminObject(projection);
  const maps = dimension === 'dayOfWeek'
    ? [source.dayOfWeekDecisions, source.dayDecisions, source.dayOfWeek]
    : [source.sessionDecisions, source.session];
  for (const mapValue of maps) {
    const map = temporalAdminObject(mapValue);
    const raw = map[bucket];
    if (raw === undefined || raw === null) continue;
    const value = typeof raw === 'object'
      ? raw.decision || raw.activeTemporalDecision || raw.status
      : raw;
    return temporalAdminActiveDecision(value, fallback);
  }
  return fallback;
}

function temporalAdminWeekendApproval(projection = {}, dayOfWeekUtc) {
  const source = temporalAdminObject(projection);
  const weekend = temporalAdminObject(source.weekendOverrides || source.weekendApprovals || {});
  const raw = weekend[dayOfWeekUtc];
  if (typeof raw === 'boolean') return raw;
  const value = temporalAdminObject(raw);
  return temporalAdminBool(
    temporalAdminFirst(value, ['discordAllowed', 'approved'], false), false
  ) || String(temporalAdminFirst(value, ['status', 'decision'], '')).trim().toUpperCase() === 'WEEKEND_APPROVED';
}

function temporalAdminDecisionSnapshot(record = {}) {
  const row = temporalAdminObject(record);
  const source = temporalAdminObject(
    row.entryDecisionSnapshot || row.decisionSnapshot || row.temporalDecisionSnapshot || {}
  );
  if (Object.keys(source).length === 0) return null;
  return {
    entryDecisionId: temporalAdminFirst(source, ['entryDecisionId'], temporalAdminFirst(row, ['entryDecisionId'], null)),
    capturedAtTs: temporalAdminFinite(source.capturedAtTs, null),
    temporalPolicyMode: temporalAdminPolicyMode(source.temporalPolicyMode, 'OBSERVE'),
    temporalPolicyVersion: temporalAdminFirst(source, ['temporalPolicyVersion'], TEMPORAL_POLICY_VERSION),
    activeTemporalGenerationId: temporalAdminFirst(source, ['activeTemporalGenerationId'], null),
    evaluatedDayOfWeek: temporalAdminFirst(source, ['evaluatedDayOfWeek'], null),
    evaluatedSessionBucket: temporalAdminFirst(source, ['evaluatedSessionBucket'], null),
    evaluatedIsWeekend: temporalAdminBool(source.evaluatedIsWeekend, false),
    dayOfWeekDecision: temporalAdminActiveDecision(source.dayOfWeekDecision, 'INHERIT_GLOBAL'),
    sessionDecision: temporalAdminActiveDecision(source.sessionDecision, 'INHERIT_GLOBAL'),
    weekendDecision: temporalAdminFirst(source, ['weekendDecision'], null),
    exactSelected75ChildMatch: temporalAdminBool(source.exactSelected75ChildMatch, false),
    globalFamilyGate: temporalAdminFirst(source, ['globalFamilyGate', 'globalGate'], null),
    currentFitEligible: temporalAdminBool(source.currentFitEligible, false),
    cooldownBlocked: temporalAdminBool(source.cooldownBlocked, false),
    duplicateBlocked: temporalAdminBool(source.duplicateBlocked, false),
    wouldPublishWithoutTemporal: temporalAdminBool(source.wouldPublishWithoutTemporal, false),
    temporalWouldBlock: temporalAdminBool(source.temporalWouldBlock, false),
    temporallyAllowed: temporalAdminBool(
      temporalAdminFirst(source, ['temporallyAllowed', 'temporalAllowed'], true), true
    ),
    temporalBlockReasons: Array.isArray(source.temporalBlockReasons)
      ? source.temporalBlockReasons.map(String)
      : []
  };
}

function temporalAdminPublication(record = {}, type = 'ENTRY') {
  const row = temporalAdminObject(record);
  const keys = type === 'ENTRY'
    ? ['entryPublicationResult', 'entryPublicationAttempt', 'discordEntryPublication']
    : ['exitPublicationResult', 'exitPublicationAttempt', 'discordExitPublication'];
  let source = {};
  for (const key of keys) {
    const candidate = temporalAdminObject(row[key]);
    if (Object.keys(candidate).length > 0) {
      source = candidate;
      break;
    }
  }
  if (Object.keys(source).length === 0) return null;
  const attempted = temporalAdminBool(
    temporalAdminFirst(source, ['attempted', 'webhookAttempted'], false), false
  );
  const rawSucceeded = temporalAdminFirst(source, ['succeeded', 'successfullyPosted', 'webhookSucceeded'], null);
  const succeeded = attempted ? temporalAdminBool(rawSucceeded, false) : null;
  return {
    publicationType: type,
    attempted,
    succeeded,
    discordChannelAlias: temporalAdminFirst(source, ['discordChannelAlias', 'channelAlias'], null),
    messageReference: temporalAdminFirst(source, ['messageReference', 'messageId'], null),
    statusCode: temporalAdminFinite(temporalAdminFirst(source, ['statusCode', 'webhookResponseStatus'], null), null),
    errorCode: temporalAdminFirst(source, ['errorCode'], null),
    attemptedTs: temporalAdminFinite(temporalAdminFirst(source, ['attemptedTs', 'attemptedAtTs'], null), null),
    completedTs: temporalAdminFinite(temporalAdminFirst(source, ['completedTs', 'completedAtTs'], null), null),
    durationMs: temporalAdminFinite(source.durationMs, null),
    secretsExcluded: true
  };
}

function buildTemporalAdminEnvelope(record = {}, fallbackTs = Date.now()) {
  const row = temporalAdminObject(record);
  const entry = temporalAdminContextFromRecord(row, 'entry', fallbackTs);
  const exit = temporalAdminContextFromRecord(row, 'exit', fallbackTs);
  const activeGenerationSource = row.activeTemporalGeneration || row.activeTemporalProfile || {
    activeTemporalGenerationId: row.activeTemporalGenerationId,
    generationCutoffTs: row.activeTemporalGenerationCutoffTs,
    generationStatus: row.activeTemporalGenerationStatus
  };
  const nextGenerationSource = row.nextTemporalGeneration || row.nextTemporalProfile || {
    nextTemporalGenerationId: row.nextTemporalGenerationId,
    generationCutoffTs: row.nextTemporalGenerationCutoffTs,
    generationStatus: row.nextTemporalGenerationStatus
  };
  const activeGeneration = temporalAdminNormalizeGeneration(activeGenerationSource, 'MISSING', fallbackTs);
  const nextGeneration = temporalAdminNormalizeGeneration(nextGenerationSource, 'MISSING', fallbackTs);
  const projection = temporalAdminProjectionSource(row);
  const entryDay = entry.entryDayOfWeekUtc;
  const entrySession = entry.entrySessionBucket;
  const dayDecision = temporalAdminProjectionDecision(projection, 'dayOfWeek', entryDay);
  const sessionDecision = temporalAdminProjectionDecision(projection, 'session', entrySession);
  const weekendApproved = entry.entryIsWeekend
    ? temporalAdminWeekendApproval(projection, entryDay)
    : false;
  const generationUnavailable = ['MISSING', 'CORRUPT', 'INVALID', 'VERSION_INCOMPATIBLE', 'EXPIRED']
    .includes(activeGeneration.generationStatus);
  const temporalBlockReasons = [];
  if (generationUnavailable) temporalBlockReasons.push('TEMPORAL_GENERATION_UNAVAILABLE');
  if (dayDecision === 'VETO_ACTIVE') temporalBlockReasons.push('DAY_VETO_ACTIVE');
  if (sessionDecision === 'VETO_ACTIVE') temporalBlockReasons.push('SESSION_VETO_ACTIVE');
  if (entry.entryIsWeekend && !weekendApproved) temporalBlockReasons.push('WEEKEND_NOT_APPROVED');
  const policyMode = temporalAdminResolvedPolicyMode(row);
  const temporalWouldBlock = temporalBlockReasons.length > 0;
  return {
    architectureVersion: 'LONG_TEMPORAL_ADMIN_PROJECTION_V2',
    temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
    temporalStatsVersion: TEMPORAL_STATS_VERSION,
    temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
    temporalAggregationVersion: TEMPORAL_AGGREGATION_VERSION,
    temporalGenerationVersion: TEMPORAL_GENERATION_VERSION,
    weekendPolicyVersion: WEEKEND_POLICY_VERSION,
    sessionPolicyVersion: SESSION_POLICY_VERSION,
    temporalStatsEnabled: temporalAdminStatsEnabled(row),
    temporalPolicyMode: policyMode,
    policyModes: TEMPORAL_POLICY_MODES,
    gateWindow: {
      maxOutcomes: TEMPORAL_GATE_WINDOW_MAX_OUTCOMES,
      maxAgeDays: TEMPORAL_GATE_WINDOW_MAX_AGE_DAYS,
      vetoMinCompleted: TEMPORAL_VETO_MIN_COMPLETED,
      weekendApprovalMinCompleted: TEMPORAL_WEEKEND_APPROVAL_MIN_COMPLETED
    },
    freshness: {
      generationMaxAgeDays: TEMPORAL_GENERATION_MAX_AGE_DAYS,
      vetoStaleDays: TEMPORAL_VETO_STALE_DAYS,
      weekendApprovalFreshnessDays: TEMPORAL_WEEKEND_FRESHNESS_DAYS
    },
    entryContext: {
      ...entry,
      temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
      marketEventClusterId: temporalAdminMarketEventClusterId(row, entry.entryTs)
    },
    exitContext: exit,
    temporalStats: temporalAdminNormalizeStats(row),
    activeTemporalGeneration: activeGeneration,
    nextTemporalGeneration: nextGeneration,
    runtimeProjection: {
      activeTemporalGenerationId: activeGeneration.generationId,
      evaluatedDayOfWeek: entryDay,
      evaluatedSessionBucket: entrySession,
      evaluatedIsWeekend: entry.entryIsWeekend,
      dayOfWeekDecision: dayDecision,
      sessionDecision,
      weekendApproved,
      temporalWouldBlock,
      temporalBlockReasons,
      enforceWouldBlock: policyMode === 'ENFORCE' && temporalWouldBlock,
      observeOnly: policyMode === 'OBSERVE'
    },
    entryDecisionSnapshot: temporalAdminDecisionSnapshot(row),
    entryPublicationResult: temporalAdminPublication(row, 'ENTRY'),
    exitPublicationResult: temporalAdminPublication(row, 'EXIT'),
    invariants: {
      exact75ChildFamilyIdentityPreserved: true,
      temporalContextExcludedFromFamilyId: true,
      scannerDoesNotApplyTemporalGate: true,
      virtualLearningNeverBlocked: true,
      exitPublicationNeverBlockedByTemporal: true,
      shortRootTouched: false
    }
  };
}

function applyTemporalAdminHeaders(res, record = {}) {
  if (!res || typeof res.setHeader !== 'function') return;
  const envelope = buildTemporalAdminEnvelope(record);
  res.setHeader('X-Temporal-Context-Version', TEMPORAL_CONTEXT_VERSION);
  res.setHeader('X-Temporal-Stats-Version', TEMPORAL_STATS_VERSION);
  res.setHeader('X-Temporal-Policy-Version', TEMPORAL_POLICY_VERSION);
  res.setHeader('X-Temporal-Aggregation-Version', TEMPORAL_AGGREGATION_VERSION);
  res.setHeader('X-Temporal-Generation-Version', TEMPORAL_GENERATION_VERSION);
  res.setHeader('X-Temporal-Stats-Enabled', String(envelope.temporalStatsEnabled));
  res.setHeader('X-Temporal-Policy-Mode', envelope.temporalPolicyMode);
  res.setHeader('X-Weekend-Policy-Version', WEEKEND_POLICY_VERSION);
  res.setHeader('X-Session-Policy-Version', SESSION_POLICY_VERSION);
}


export default async function handler(req, res) {
    applyTemporalAdminHeaders(res);
res.setHeader('Cache-Control', 'no-store, max-age=0');
res.setHeader('X-Admin-Reset-Learning-Mode', 'long-only-75-child-virtuallearning-v1');
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
note: 'reset-learning wist alleen LONG leerdata. Handmatige LONG 75child selectie blijft bewaard.',
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
temporalResetPolicy: {
     temporalLifetimeStatsRemovedWhereMapped: true,
     temporalRollingSourcesRemovedWhereMapped: true,
     temporalCandidateStateRemovedWhereMapped: true,
     temporalGenerationsMustBeInvalidatedByAuthoritativeKeyOwner: true,
     globalStatsMustNotBeReaggregatedByTemporalReset: true,
     shortRootTouched: false
},
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
