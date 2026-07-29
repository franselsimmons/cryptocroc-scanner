// ================= FILE: api/admin/scanner.js =================

import { KEYS } from '../../src/keys.js';
import {
getVolatileRedis,
getJson,
getKeys
} from '../../src/redis.js';
import { sideToTradeSide, safeNumber } from '../../src/utils.js';

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

const SNAPSHOT_SEARCH_LIMIT = 80;
const STALE_8M_SEC = 8 * 60;
const STALE_30M_SEC = 30 * 60;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;
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

function methodNotAllowed(res) {
res.setHeader('Allow', 'GET');

return res.status(405).json({
ok: false,
error: 'METHOD_NOT_ALLOWED',
allowed: ['GET'],
...modeFlags()
});
}

function taxonomyMeta() {
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
parentIdsAreMetadataOnly: true,
scannerCreatesNoLearningFamily: true,
analyzeCreatesTrueMicroFamily: true
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

scannerOnly: true,
scannerDoesNotTrade: true,
scannerDoesNotSelectMicroFamilies: true,
scannerDoesNotSendDiscord: true,
scannerDoesNotWriteLearningFamilies: true,
scannerFingerprintRole: 'METADATA_ONLY',
scannerFingerprintsMetadataOnly: true,
scannerFingerprintsUsedAsLearningFamily: false,

scannerBucketsDebugMetadataOnly: true,
legacy25BucketsDebugMetadataOnly: true,
scannerBucketsAreNotSelectable: true,

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

manualSelectionOnly: true,
manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
manualSelectionMustUseSelectable75ChildId: true,
autoRotationActivationDisabled: true,
activateFreezeCronDisabled: true,
resetCronDisabled: true,
discordOnlyForSelectedMicroFamilies: true,
discordOnlyForExactTrueMicroMatch: true,

discordSelectionRule: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY',
parentMatchDoesNotTriggerDiscord: true,
macroMatchDoesNotTriggerDiscord: true,

bucketsCoarseOnly: true,
bucketGranularity: 'LOW_MID_HIGH',
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
redisNamespace: LONG_NAMESPACE,
redisKeyPrefix: LONG_KEY_PREFIX,
redisKeysSeparatedFromShortRoot: true,
shortRootTouched: false
};
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

function num(value, fallback = 0) {
const n = safeNumber(value, fallback);

return Number.isFinite(n) ? n : fallback;
}

function round(value, decimals = 4) {
return Number(num(value, 0).toFixed(decimals));
}

function getArray(value) {
return Array.isArray(value) ? value : [];
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

function snapshotPattern() {
return LONG_KEYS.scan.snapshotPattern;
}

function snapshotKey(snapshotId) {
return LONG_KEYS.scan.snapshot(snapshotId);
}

function extractSnapshotId(latest) {
if (!latest) return null;
if (typeof latest === 'string') return latest;

if (typeof latest === 'object') {
return (
latest.snapshotId ||
latest.id ||
latest.latestSnapshotId ||
latest.scanId ||
null
);
}

return null;
}

function hasFullSnapshotShape(value) {
return Boolean(
value &&
typeof value === 'object' &&
Array.isArray(value.candidates)
);
}

function snapshotCreatedAt(snapshot = {}) {
return num(
snapshot.createdAt ||
snapshot.completedAt ||
snapshot.ts ||
snapshot.scannerTs,
0
);
}

function snapshotAgeSec(snapshot = {}) {
const createdAt = snapshotCreatedAt(snapshot);

if (createdAt <= 0) return null;

return Math.max(0, Math.floor((now() - createdAt) / 1000));
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

function getDefinitionHaystack(row = {}) {
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

function hasShortToken(text = '') {
const value = ` ${cleanSideText(text)} `;

return (
value.includes('MICRO_SHORT_') ||
value.includes('TRADESIDE=SHORT') ||
value.includes('TRADE_SIDE=SHORT') ||
value.includes('POSITION_SIDE=SHORT') ||
value.includes('POSITIONSIDE=SHORT') ||
value.includes('SIDE=SHORT') ||
value.includes('SIDE=BEAR') ||
value.includes('SIDE=SELL') ||
value.includes('DIRECTION=SHORT') ||
value.includes('DIRECTION=BEAR') ||
value.includes('DIRECTION=SELL') ||
value.includes(' SHORT_') ||
value.includes('_SHORT ') ||
value.includes('_SHORT_') ||
value.includes('|SHORT|') ||
value.includes(':SHORT') ||
value.includes('=SHORT') ||
value.includes(' BEAR ') ||
value.includes('_BEAR') ||
value.includes('BEAR_') ||
value.includes('|BEAR|') ||
value.includes(':BEAR') ||
value.includes('=BEAR') ||
value.includes(' SELL ') ||
value.includes('_SELL') ||
value.includes('SELL_') ||
value.includes('|SELL|') ||
value.includes(':SELL') ||
value.includes('=SELL') ||
value.includes('DOWNSIDE')
);
}

function hasLongToken(text = '') {
const value = ` ${cleanSideText(text)} `;

return (
value.includes('MICRO_LONG_') ||
value.includes('TRADESIDE=LONG') ||
value.includes('TRADE_SIDE=LONG') ||
value.includes('POSITION_SIDE=LONG') ||
value.includes('POSITIONSIDE=LONG') ||
value.includes('SIDE=LONG') ||

value.includes('SIDE=BULL') ||
value.includes('SIDE=BUY') ||
value.includes('DIRECTION=LONG') ||
value.includes('DIRECTION=BULL') ||
value.includes('DIRECTION=BUY') ||
value.includes(' LONG_') ||
value.includes('_LONG ') ||
value.includes('_LONG_') ||
value.includes('|LONG|') ||
value.includes(':LONG') ||
value.includes('=LONG') ||
value.includes(' BULL ') ||
value.includes('_BULL') ||
value.includes('BULL_') ||
value.includes('|BULL|') ||
value.includes(':BULL') ||
value.includes('=BULL') ||
value.includes(' BUY ') ||
value.includes('_BUY') ||
value.includes('BUY_') ||
value.includes('|BUY|') ||
value.includes(':BUY') ||
value.includes('=BUY') ||
value.includes('UPSIDE')
);
}

function normalizeDirectSide(value) {
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

return 'UNKNOWN';
}

function directionalMoveScore(row = {}) {
const values = [
row.change1m,
row.change5m,
row.change15m,
row.change30m,
row.change1h,
row.change4h,
row.change24h,
row.priceChange1mPct,
row.priceChange5mPct,
row.priceChange15mPct,
row.priceChange30mPct,
row.priceChange1hPct,
row.priceChange4hPct,
row.priceChange24hPct,
row.priceChangePercent,
row.priceChangePct,
row.movePct,
row.move,
row.percentChange
]
.map((value) => num(value, 0))
.filter((value) => Number.isFinite(value) && value !== 0);

if (!values.length) return 0;

return values.reduce((sum, value) => sum + Math.sign(value), 0);
}

function hasBullishMove(row = {}) {
return directionalMoveScore(row) > 0;
}
function hasBearishMove(row = {}) {
return directionalMoveScore(row) < 0;
}

function inferTradeSide(row = {}) {
if (typeof row === 'string') {
if (parseLongTaxonomyMicroId(row).valid) return TARGET_TRADE_SIDE;
if (hasLongToken(row)) return TARGET_TRADE_SIDE;
if (hasShortToken(row)) return OPPOSITE_TRADE_SIDE;

return 'UNKNOWN';
}

const directSources = [
row.tradeSide,
row.positionSide,
row.direction,
row.signalSide,
row.scannerSide,
row.actualScannerSide,
row.analysisSide,
row.entrySide,
row.side,
row.bias,
row.marketBias
];

for (const source of directSources) {
const side = normalizeDirectSide(source);

if (side === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
if (side === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
}

const familyText = [
row.familyId,
row.family,
row.baseFamilyId,
row.macroFamilyId,
row.parentMacroFamilyId,
row.parentMicroFamilyId,
row.parentFamilyId,
row.macroId,
row.microFamilyId,
row.trueMicroFamilyId,

row.parentTrueMicroFamilyId,
row.childTrueMicroFamilyId,
row.coarseMicroFamilyId,
row.id,
row.key
]
.map((value) => cleanSideText(value))
.filter(Boolean)
.join(' | ');

if (parseLongTaxonomyMicroId(row.trueMicroFamilyId || row.microFamilyId).valid)
return TARGET_TRADE_SIDE;
if (hasLongToken(familyText)) return TARGET_TRADE_SIDE;
if (hasShortToken(familyText)) return OPPOSITE_TRADE_SIDE;

const reasonText = [
row.scannerReason,
row.reason,
row.signalReason,
row.actionReason,
row.rejectionReason
]
.map((value) => cleanSideText(value))
.filter(Boolean)
.join(' | ');

const reasonLong = hasLongToken(reasonText);
const reasonShort = hasShortToken(reasonText);

if (reasonLong && !reasonShort) return TARGET_TRADE_SIDE;
if (reasonShort && !reasonLong) return OPPOSITE_TRADE_SIDE;

const definition = getDefinitionHaystack(row);
const definitionLong = hasLongToken(definition);
const definitionShort = hasShortToken(definition);

if (definitionLong && !definitionShort) return TARGET_TRADE_SIDE;
if (definitionShort && !definitionLong) return OPPOSITE_TRADE_SIDE;

if (row.longOnly === true || row.shortDisabled === true) {

return TARGET_TRADE_SIDE;
}

if (row.shortOnly === true || row.longDisabled === true) {
return OPPOSITE_TRADE_SIDE;
}

if (hasBullishMove(row)) return TARGET_TRADE_SIDE;
if (hasBearishMove(row)) return OPPOSITE_TRADE_SIDE;

return 'UNKNOWN';
}

function isLongCandidate(candidate = {}) {
return inferTradeSide(candidate) === TARGET_TRADE_SIDE;
}

function isShortCandidate(candidate = {}) {
return inferTradeSide(candidate) === OPPOSITE_TRADE_SIDE;
}

function normalizeContractSymbol(candidate = {}) {
return (
candidate.contractSymbol ||
candidate.symbol ||
candidate.instId ||
candidate.instrumentId ||
null
);
}

function normalizeSymbol(candidate = {}) {
const symbol = (
candidate.symbol ||
candidate.baseSymbol ||
candidate.contractSymbol ||
candidate.instId ||
candidate.instrumentId ||
''
);

return String(symbol || '').trim();
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

function normalizeLongCandidate(candidate = {}) {
const symbol = normalizeSymbol(candidate);
const contractSymbol = normalizeContractSymbol(candidate);
const createdAt = num(candidate.createdAt || candidate.ts || now(), now());
const temporalContext = resolveRecordTemporalContext(candidate, createdAt);

const trueMicroFamilyId =
candidate.trueMicroFamilyId ||
candidate.microFamilyId ||
candidate.analyzeMicroFamilyId ||
candidate.learningMicroFamilyId ||
null;

const parsedTrueMicro = parseLongTaxonomyMicroId(trueMicroFamilyId);
const scannerMicroFamilyId =
candidate.scannerMicroFamilyId ||
candidate.scannerFamilyId ||
candidate.scannerFingerprintId ||
null;

const fit = getLongCurrentFit(candidate);
const risk = getLongRiskGeometry(candidate);

return {
...candidate,
...temporalContext,
...buildEntryExitTemporalMetadata(candidate),
...temporalPolicyFlags(temporalContext),
symbol,
contractSymbol,

side: TARGET_DASHBOARD_SIDE,
tradeSide: TARGET_TRADE_SIDE,
positionSide: TARGET_TRADE_SIDE,
direction: TARGET_TRADE_SIDE,

targetTradeSide: TARGET_TRADE_SIDE,
dashboardSide: TARGET_DASHBOARD_SIDE,
scannerSide: TARGET_SCANNER_SIDE,

longOnly: true,
shortDisabled: true,
shortOnly: false,
longDisabled: false,

scannerOnly: true,
scannerDoesNotTrade: true,
scannerDoesNotSelectMicroFamilies: true,
scannerDoesNotSendDiscord: true,
scannerDoesNotWriteLearningFamilies: true,

scannerMicroFamilyId,
scannerFamilyId: candidate.scannerFamilyId || scannerMicroFamilyId,
scannerFingerprintId: candidate.scannerFingerprintId || scannerMicroFamilyId,
scannerFingerprintRole: 'METADATA_ONLY',
scannerFingerprintsMetadataOnly: true,
scannerFingerprintsUsedAsLearningFamily: false,

scannerBucketsDebugMetadataOnly: true,
legacy25BucketsDebugMetadataOnly: true,

trueMicroFamilyId: parsedTrueMicro.selectable ?
parsedTrueMicro.trueMicroFamilyId : trueMicroFamilyId,
microFamilyId: parsedTrueMicro.selectable ? parsedTrueMicro.trueMicroFamilyId
: trueMicroFamilyId,
parentTrueMicroFamilyId: parsedTrueMicro.parentTrueMicroFamilyId ||
candidate.parentTrueMicroFamilyId || null,
childTrueMicroFamilyId: parsedTrueMicro.childTrueMicroFamilyId || null,

trueMicroFamilySchema: parsedTrueMicro.selectable
? TRUE_MICRO_SCHEMA
: candidate.trueMicroFamilySchema || null,
learningGranularity: parsedTrueMicro.selectable
? LEARNING_GRANULARITY
: candidate.learningGranularity || null,
analyzeMustAssignTrueMicroFamily: true,
analyzeMicroFamiliesOnly: true,
learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
selectable75ChildCandidate: Boolean(parsedTrueMicro.selectable),

scannerScore: num(candidate.scannerScore ?? candidate.moveScore, 0),
change1h: num(candidate.change1h ?? candidate.priceChange1hPct, 0),
change24h: num(candidate.change24h ?? candidate.priceChange24hPct, 0),
volume24h: num(candidate.volume24h ?? candidate.quoteVolume24h ??
candidate.quoteVolume, 0),

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

validLongRiskShape: Boolean(risk.validGeometry),
validLongGeometry: Boolean(risk.validGeometry),
longTpHit: risk.longTpHit,
longSlHit: risk.longSlHit,
tpHit: risk.longTpHit,
slHit: risk.longSlHit,
longGrossR: risk.longGrossR === null ? null : round(risk.longGrossR, 4),
longCurrentR: risk.longCurrentR === null ? null : round(risk.longCurrentR,
4),
currentR: risk.longCurrentR === null ? candidate.currentR ?? null :
round(risk.longCurrentR, 4),
riskGeometryRule: risk.riskGeometryRule,
tpHitRule: risk.tpHitRule,
slHitRule: risk.slHitRule,
grossRFormula: risk.grossRFormula,
currentRFormula: risk.currentRFormula,

btcState: candidate.btcState || null,
regime: candidate.regime || null,
fakeBreakout: Boolean(candidate.fakeBreakout),
fakeBreakoutRisk: Boolean(candidate.fakeBreakoutRisk),

scannerReason: candidate.scannerReason || candidate.reason || null,
createdAt
};
}

function splitCandidatesBySide(candidates = []) {
const rows = Array.isArray(candidates) ? candidates : [];

const longCandidates = [];
const shortCandidates = [];
const unknownSideCandidates = [];

for (const candidate of rows) {
const tradeSide = inferTradeSide(candidate);

if (tradeSide === TARGET_TRADE_SIDE) {
longCandidates.push(candidate);
continue;
}

if (tradeSide === OPPOSITE_TRADE_SIDE) {
shortCandidates.push(candidate);
continue;
}

unknownSideCandidates.push(candidate);
}

return {
longCandidates,
shortCandidates,
unknownSideCandidates

};
}

function averageScannerScore(candidates = []) {
if (!candidates.length) return 0;

const total = candidates.reduce((sum, candidate) => {
return sum + num(candidate?.scannerScore ?? candidate?.moveScore, 0);
}, 0);

return round(total / candidates.length, 2);
}

function topSymbols(candidates = [], limit = 20) {
return candidates
.slice(0, limit)
.map((candidate) => candidate.symbol || candidate.contractSymbol)
.filter(Boolean);
}

function buildCandidateStats(rawCandidates = [], candidates = []) {
const {
longCandidates,
shortCandidates,
unknownSideCandidates
} = splitCandidatesBySide(rawCandidates);

const scannerGateCandidates = candidates.filter((candidate) =>
candidate.scannerGatePassed);
const analyzeOnlyCandidates = candidates.filter((candidate) => (
candidate.tradeDiscoveryOnly ||
candidate.discoveryOnly ||
candidate.analyzeOnly
));

const cleanCandidates = candidates.filter((candidate) =>
!candidate.fakeBreakout);
const fakeBreakouts = candidates.filter((candidate) =>
candidate.fakeBreakout);
const fakeRiskCandidates = candidates.filter((candidate) =>

candidate.fakeBreakoutRisk);

return {
candidates: candidates.length,
cleanCandidates: cleanCandidates.length,
fakeBreakouts: fakeBreakouts.length,
fakeRiskCandidates: fakeRiskCandidates.length,

scannerGateCandidates: scannerGateCandidates.length,
analyzeOnlyCandidates: analyzeOnlyCandidates.length,

longCandidates: candidates.length,
shortCandidates: 0,
unknownSideCandidates: 0,

bullCandidates: candidates.length,
bearCandidates: 0,

rawCandidates: rawCandidates.length,
rawLongCandidates: longCandidates.length,
rawShortCandidatesIgnored: shortCandidates.length,
rawUnknownSideCandidatesIgnored: unknownSideCandidates.length,

avgScannerScore: averageScannerScore(candidates)
};
}

function normalizeLatest(latest, snapshot = null, meta = {}) {
const snapshotId = extractSnapshotId(latest) || snapshot?.snapshotId ||
meta.snapshotId || null;

const candidates = Array.isArray(snapshot?.candidates)
? snapshot.candidates
: [];

const scannerGateCandidates = candidates.filter((candidate) =>
candidate.scannerGatePassed);
const analyzeOnlyCandidates = candidates.filter((candidate) => (

candidate.tradeDiscoveryOnly ||
candidate.discoveryOnly ||
candidate.analyzeOnly
));

const base = latest && typeof latest === 'object'
? latest
: { snapshotId };

const createdAt = snapshotCreatedAt(snapshot || base);
const temporalContext = resolveRecordTemporalContext(
snapshot || base,
createdAt || now()
);
const ageSec = createdAt > 0
? Math.max(0, Math.floor((now() - createdAt) / 1000))
: null;

const hasSnapshot = Boolean(snapshot);

const fallbackCount = num(
base.longCandidatesCount ??
base.selectedTargetCandidateCount ??
base.scannerGateCandidatesCount ??
base.candidatesCount ??
base.count,
0
);

return {
...base,
...temporalContext,
...buildEntryExitTemporalMetadata(base),
...modeFlags(),
...temporalPolicyFlags(temporalContext),

taxonomy: taxonomyMeta(),

snapshotId,
selectedSnapshotSource: meta.snapshotSource || null,

selectedSnapshotReason: meta.snapshotReason || null,

createdAt: createdAt || base.createdAt || null,
snapshotAgeSec: ageSec,

candidatesCount: hasSnapshot ? candidates.length : fallbackCount,
longCandidatesCount: hasSnapshot ? candidates.length : fallbackCount,
shortCandidatesCount: 0,

scannerGateCandidatesCount: hasSnapshot
? scannerGateCandidates.length
: num(base.scannerGateCandidatesCount, 0),

analyzeOnlyCandidatesCount: hasSnapshot
? analyzeOnlyCandidates.length
: num(base.analyzeOnlyCandidatesCount, 0),

topSymbols: hasSnapshot
? topSymbols(candidates)
: Array.isArray(base.topSymbols)
? base.topSymbols.slice(0, 20)
: [],

scannerGateSymbols: topSymbols(scannerGateCandidates),

isStale8m: ageSec === null ? null : ageSec > STALE_8M_SEC,
isStale30m: ageSec === null ? null : ageSec > STALE_30M_SEC
};
}

function normalizeSnapshot(snapshot, fallbackId = null, meta = {}) {
if (!snapshot || typeof snapshot !== 'object') {
return null;
}

const rawCandidates = Array.isArray(snapshot.candidates)
? snapshot.candidates
: [];

const {
longCandidates,
shortCandidates,
unknownSideCandidates
} = splitCandidatesBySide(rawCandidates);
const candidates = longCandidates.map(normalizeLongCandidate);
const temporalContext = resolveRecordTemporalContext(
snapshot,
snapshotCreatedAt(snapshot) || now()
);
const ageSec = snapshotAgeSec(snapshot);

const scannerGateCandidates = candidates.filter((candidate) =>
candidate.scannerGatePassed);
const analyzeOnlyCandidates = candidates.filter((candidate) => (
candidate.tradeDiscoveryOnly ||
candidate.discoveryOnly ||
candidate.analyzeOnly
));

return {
...snapshot,
...temporalContext,
...buildEntryExitTemporalMetadata(snapshot),
...modeFlags(),
...temporalPolicyFlags(temporalContext),

taxonomy: taxonomyMeta(),

snapshotId: snapshot.snapshotId || fallbackId || null,

selectedSnapshotSource: meta.snapshotSource || null,
selectedSnapshotReason: meta.snapshotReason || null,

rawCandidatesCount: rawCandidates.length,
rawLongCandidatesCount: longCandidates.length,
rawShortCandidatesIgnored: shortCandidates.length,
rawUnknownSideCandidatesIgnored: unknownSideCandidates.length,

candidates,
candidatesCount: candidates.length,
longCandidatesCount: candidates.length,
shortCandidatesCount: 0,

scannerGateCandidatesCount: scannerGateCandidates.length,
analyzeOnlyCandidatesCount: analyzeOnlyCandidates.length,

topSymbols: topSymbols(candidates),
scannerGateSymbols: topSymbols(scannerGateCandidates),

stats: buildCandidateStats(rawCandidates, candidates),

snapshotAgeSec: ageSec,
isStale8m: ageSec === null ? null : ageSec > STALE_8M_SEC,
isStale30m: ageSec === null ? null : ageSec > STALE_30M_SEC
};
}
function targetCandidateCount(snapshot = {}) {
const candidates = Array.isArray(snapshot.candidates)
? snapshot.candidates
: [];

return candidates.filter(isLongCandidate).length;
}

function oppositeCandidateCount(snapshot = {}) {
const candidates = Array.isArray(snapshot.candidates)
? snapshot.candidates
: [];

return candidates.filter(isShortCandidate).length;
}

async function safeGetSnapshotJson(redis, key, fallback = null) {
return getJson(redis, key, fallback).catch(() => fallback);
}

async function loadRecentSnapshotCandidates(redis) {
const keys = await getKeys(
redis,
snapshotPattern(),
SNAPSHOT_SEARCH_LIMIT
).catch(() => []);

if (!keys.length) return [];

const rows = await Promise.all(
keys.map(async (key) => {
const snapshot = await safeGetSnapshotJson(redis, key, null);

if (!hasFullSnapshotShape(snapshot)) return null;

return {
source: `LONG_SCAN:RECENT_SEARCH:${key}`,
snapshot,
snapshotId: snapshot.snapshotId || key,
targetCount: targetCandidateCount(snapshot),
oppositeCount: oppositeCandidateCount(snapshot),
createdAt: snapshotCreatedAt(snapshot)
};
})
);

return rows
.filter(Boolean)
.sort((a, b) => b.createdAt - a.createdAt);
}

function dedupeSnapshotCandidates(candidates = []) {
const unique = new Map();

for (const item of candidates) {
if (!item?.snapshot || !hasFullSnapshotShape(item.snapshot)) continue;

const id = item.snapshot?.snapshotId || item.snapshotId ||

item.snapshotSource;

if (!id) continue;

const previous = unique.get(id);

if (!previous) {
unique.set(id, item);
continue;
}

if (
item.createdAt > previous.createdAt ||
(
item.createdAt === previous.createdAt &&
item.targetCount > previous.targetCount
)
) {
unique.set(id, item);
}
}

return [...unique.values()]
.filter((item) => hasFullSnapshotShape(item.snapshot))
.sort((a, b) => b.createdAt - a.createdAt);
}

async function loadSnapshot(redis, latest) {
const snapshotId = extractSnapshotId(latest);
const candidates = [];

if (hasFullSnapshotShape(latest)) {
candidates.push({
snapshot: latest,
snapshotSource: 'LONG_SCAN:LATEST_FULL_SNAPSHOT',
snapshotReason: 'LATEST_FULL_SNAPSHOT',
snapshotId: latest.snapshotId || snapshotId,
targetCount: targetCandidateCount(latest),
oppositeCount: oppositeCandidateCount(latest),
createdAt: snapshotCreatedAt(latest)

});
}

if (snapshotId) {
const byId = await safeGetSnapshotJson(
redis,
snapshotKey(snapshotId),
null
);

if (hasFullSnapshotShape(byId)) {
candidates.push({
snapshot: byId,
snapshotSource: 'LONG_SCAN:SNAPSHOT_BY_ID',
snapshotReason: 'SNAPSHOT_REFERENCED_BY_LATEST_ID',
snapshotId,
targetCount: targetCandidateCount(byId),
oppositeCount: oppositeCandidateCount(byId),
createdAt: snapshotCreatedAt(byId)
});
}
}

const recent = await loadRecentSnapshotCandidates(redis);

for (const item of recent) {
candidates.push({
...item,
snapshotSource: item.source,
snapshotReason: 'RECENT_SNAPSHOT_SEARCH'
});
}

const sorted = dedupeSnapshotCandidates(candidates);

const selectedTarget = sorted.find((item) => item.targetCount > 0);

if (selectedTarget) {
return {
snapshot: normalizeSnapshot(

selectedTarget.snapshot,
selectedTarget.snapshotId,
{
snapshotSource: selectedTarget.snapshotSource,
snapshotReason: 'NEWEST_LONG_SNAPSHOT_WITH_CANDIDATES'
}
),
snapshotSource: selectedTarget.snapshotSource,
snapshotReason: 'NEWEST_LONG_SNAPSHOT_WITH_CANDIDATES',
snapshotId: selectedTarget.snapshotId,
rawTargetCount: selectedTarget.targetCount,
rawOppositeCount: selectedTarget.oppositeCount,
snapshotsScanned: sorted.length
};
}

const selectedAny = sorted[0] || null;

if (!selectedAny) {
return {
snapshot: null,
snapshotSource: snapshotId ? 'LONG_SNAPSHOT_NOT_FOUND' :
'NO_LONG_SNAPSHOT_ID',
snapshotReason: snapshotId ?
'LATEST_REFERENCED_MISSING_LONG_SNAPSHOT' :
'NO_LATEST_LONG_SNAPSHOT_ID',
snapshotId: snapshotId || null,
rawTargetCount: 0,
rawOppositeCount: 0,
snapshotsScanned: 0
};
}

return {
snapshot: normalizeSnapshot(
selectedAny.snapshot,
selectedAny.snapshotId,
{
snapshotSource: selectedAny.snapshotSource,
snapshotReason: 'NO_LONG_SNAPSHOT_FOUND_USING_NEWEST_AVAILABLE'
}
),
snapshotSource: selectedAny.snapshotSource,
snapshotReason: 'NO_LONG_SNAPSHOT_FOUND_USING_NEWEST_AVAILABLE',

snapshotId: selectedAny.snapshotId,
rawTargetCount: selectedAny.targetCount,
rawOppositeCount: selectedAny.oppositeCount,
snapshotsScanned: sorted.length
};
}
function emptyStats() {
return {
candidates: 0,
cleanCandidates: 0,
fakeBreakouts: 0,
fakeRiskCandidates: 0,

scannerGateCandidates: 0,
analyzeOnlyCandidates: 0,

longCandidates: 0,
shortCandidates: 0,
unknownSideCandidates: 0,

bullCandidates: 0,
bearCandidates: 0,

rawCandidates: 0,
rawLongCandidates: 0,
rawShortCandidatesIgnored: 0,
rawUnknownSideCandidatesIgnored: 0,

avgScannerScore: 0
};
}

function buildSummary({
latest,
snapshot,
candidates,
rawTargetCount,
rawOppositeCount,
snapshotsScanned
}) {
return {

...modeFlags(),

taxonomy: taxonomyMeta(),

latestSnapshotId: latest?.snapshotId || null,
selectedSnapshotId: snapshot?.snapshotId || null,

snapshotsScanned: num(snapshotsScanned, 0),

candidates: candidates.length,
longCandidates: candidates.length,
shortCandidates: 0,
rawTargetCount: num(rawTargetCount, 0),
rawOppositeCount: num(rawOppositeCount, 0),

rawCandidates: num(snapshot?.rawCandidatesCount, 0),
rawShortCandidatesIgnored: num(snapshot?.rawShortCandidatesIgnored, 0),
rawUnknownSideCandidatesIgnored:
num(snapshot?.rawUnknownSideCandidatesIgnored, 0),

scannerGateCandidates: num(snapshot?.scannerGateCandidatesCount, 0),
analyzeOnlyCandidates: num(snapshot?.analyzeOnlyCandidatesCount, 0),

avgScannerScore: averageScannerScore(candidates),

topSymbols: topSymbols(candidates)
};
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
res.setHeader('X-Admin-Scanner-Mode', 'long-only-scanner-discovery-75-childcontract-v1');
res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
res.setHeader('X-Long-Only', 'true');
res.setHeader('X-Short-Disabled', 'true');
res.setHeader('X-Scanner-Side', TARGET_SCANNER_SIDE);
res.setHeader('X-Scanner-Only', 'true');

res.setHeader('X-Scanner-Fingerprints-Metadata-Only', 'true');
res.setHeader('X-Scanner-Fingerprints-Used-As-Learning-Family', 'false');
res.setHeader('X-True-Micro-Family-Schema', TRUE_MICRO_SCHEMA);
res.setHeader('X-Learning-Granularity', LEARNING_GRANULARITY);
res.setHeader('X-Selectable-Child-Micro-Families', '75');
res.setHeader('X-Parent-Micro-Families', '15');
res.setHeader('X-Manual-Selection-Match-Mode', 'EXACT_TRUE_MICRO_FAMILY_ID');
res.setHeader('X-Discord-Selection-Rule',
'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY');
res.setHeader('X-Real-Orders-Disabled', 'true');
res.setHeader('X-Bitget-Orders-Disabled', 'true');
res.setHeader('X-Exchange-Calls-Disabled', 'true');
res.setHeader('X-Virtual-Learning-Forced', 'true');
res.setHeader('X-Redis-Namespace', LONG_NAMESPACE);
res.setHeader('X-Short-Root-Touched', 'false');

if (req.method !== 'GET') {
return methodNotAllowed(res);
}
try {
const redis = getVolatileRedis();
const latestRaw = await getJson(redis, LONG_KEYS.scan.latest, null);

const {
snapshot,
snapshotSource,
snapshotReason,
snapshotId,
rawTargetCount,
rawOppositeCount,
snapshotsScanned
} = await loadSnapshot(redis, latestRaw);

const candidates = Array.isArray(snapshot?.candidates)
? snapshot.candidates
: [];

const latest = normalizeLatest(latestRaw, snapshot, {
snapshotId,
snapshotSource,
snapshotReason
});

return res.status(200).json({
ok: true,

...modeFlags(),

taxonomy: taxonomyMeta(),

longKeys: {
namespace: LONG_NAMESPACE,
prefix: LONG_KEY_PREFIX,
scanLatest: LONG_KEYS.scan.latest,
snapshotPattern: LONG_KEYS.scan.snapshotPattern
},

latest,
snapshot,
candidates,

snapshotId,
snapshotSource,
snapshotReason,

candidatesCount: candidates.length,
longCandidatesCount: candidates.length,
shortCandidatesCount: 0,

rawTargetCount,
rawOppositeCount,
snapshotsScanned,

stats: snapshot?.stats || emptyStats(),

summary: buildSummary({
latest,
snapshot,
candidates,
rawTargetCount,

rawOppositeCount,
snapshotsScanned
}),

warnings: uniqueStrings([
!snapshot ? 'NO_LONG_SCANNER_SNAPSHOT_AVAILABLE' : null,
snapshot?.isStale8m ? 'LONG_SCANNER_SNAPSHOT_STALE_8M' : null,
snapshot?.isStale30m ? 'LONG_SCANNER_SNAPSHOT_STALE_30M' : null,
rawOppositeCount > 0 ? `SHORT_CANDIDATES_IGNORED:${rawOppositeCount}`
:
null,
snapshot?.rawUnknownSideCandidatesIgnored > 0
?
`UNKNOWN_SIDE_CANDIDATES_IGNORED:${snapshot.rawUnknownSideCandidatesIgnored}`
: null,
snapshot && candidates.length <= 0
? 'NO_LONG_CANDIDATES_IN_SELECTED_SNAPSHOT'
: null
].filter(Boolean)),

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
