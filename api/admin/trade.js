// ================= FILE: api/admin/trade.js =================
import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import {
getDurableRedis,
getVolatileRedis,
getJson
} from '../../src/redis.js';
import { getOpenPositions } from '../../src/trade/positionEngine.js';
import {
safeNumber,
sideToTradeSide,
normalizeBaseSymbol,
normalizeContractSymbol
} from '../../src/utils.js';
import { getActiveRotation } from '../../src/analyze/rotationEngine.js';
const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const TARGET_SCANNER_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';
const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';
const TEMPORAL_CONTEXT_VERSION = 'LONG_TEMPORAL_CONTEXT_UTC_V2';
const WEEKEND_POLICY_VERSION = 'LONG_WEEKEND_POSITIVE_OVERRIDE_V2';
const SESSION_POLICY_VERSION = 'LONG_SESSION_NEGATIVE_VETO_V2';
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
function normalizeTimestampMs(value, fallback = Date.now()) {
const n = Number(value);
if (!Number.isFinite(n) || n <= 0) return Number(fallback);
return n < 10_000_000_000 ? n * 1000 : n;
}
function buildTemporalContext(timestamp = Date.now()) {
const contextTs = normalizeTimestampMs(timestamp, Date.now());
const date = new Date(contextTs);
const dayIndex = date.getUTCDay();
const hourUtc = date.getUTCHours();
const dayOfWeekUtc = DAY_NAMES_UTC[dayIndex] || 'UNKNOWN';
const isWeekend = dayIndex === 0 || dayIndex === 6;
const asiaActive = hourUtc >= 0 && hourUtc < 8;
const europeActive = hourUtc >= 7 && hourUtc < 16;
const usActive = hourUtc >= 13 && hourUtc < 22;
const sessionTags = [];
if (asiaActive) sessionTags.push('ASIA');
if (europeActive) sessionTags.push('EUROPE');
if (usActive) sessionTags.push('US');
let primarySessionBucket = 'OFF_HOURS';
if (europeActive && usActive) primarySessionBucket = 'EU_US_OVERLAP';
else if (asiaActive && europeActive) primarySessionBucket = 'ASIA_EU_OVERLAP';
else if (asiaActive) primarySessionBucket = 'ASIA';
else if (europeActive) primarySessionBucket = 'EUROPE';
else if (usActive) primarySessionBucket = 'US';
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
offHours: sessionTags.length === 0
};

}
function firstTemporalValue(row = {}, keys = []) {
for (const key of keys) {
const value = row?.[key];
if (value !== undefined && value !== null && value !== '') return value;
}
return null;
}
function buildEntryTemporalContext(row = {}, fallbackTs = Date.now()) {
const entryTs = normalizeTimestampMs(
firstTemporalValue(row, [
'entryTs',
'openedAt',
'openTs',
'entryAt',
'createdAt',
'ts'
]),
fallbackTs
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
function buildExitTemporalContext(row = {}, fallbackTs = null) {
const rawExitTs = firstTemporalValue(row, [
'exitTs',
'closedAt',
'closeTs',
'exitAt',
'completedAt',
'updatedAt'
]);
if (rawExitTs === null && fallbackTs === null) {
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
const context = buildTemporalContext(
normalizeTimestampMs(rawExitTs, fallbackTs ?? Date.now())
);
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
function emptyTemporalMetricBucket() {
return {
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
};
}

function normalizeTemporalMetricBucket(value = {}) {
const source = value && typeof value === 'object' && !Array.isArray(value)
? value
: {};
const base = emptyTemporalMetricBucket();
const output = { ...base };
for (const key of Object.keys(base)) {
const n = Number(source[key]);
output[key] = Number.isFinite(n) ? n : base[key];
}
return output;
}
function normalizeTemporalStats(row = {}) {
const contextSource = row.contextStats || row.dayTypeStats || {};
const sessionSource = row.sessionStats || row.primarySessionStats || {};
const available = Boolean(
row.contextStats ||
row.dayTypeStats ||
row.sessionStats ||
row.primarySessionStats
);
return {
temporalStatsAvailable: available,
temporalStatsSource: available ? 'ANALYZE_AGGREGATE' : 'NOT_YET_AVAILABLE',
contextStats: {
WEEKDAY: normalizeTemporalMetricBucket(contextSource.WEEKDAY),
WEEKEND: normalizeTemporalMetricBucket(contextSource.WEEKEND)
},
sessionStats: Object.fromEntries(
PRIMARY_SESSION_BUCKETS.map((bucket) => [
bucket,
normalizeTemporalMetricBucket(sessionSource[bucket])
])
)
};
}
function temporalPolicyPayload(timestamp = Date.now()) {
const context = buildTemporalContext(timestamp);
return {
temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
weekendPolicyVersion: WEEKEND_POLICY_VERSION,
sessionPolicyVersion: SESSION_POLICY_VERSION,
weekendMode: WEEKEND_MODE,
sessionMode: SESSION_MODE,
...context,

weekendLearningAllowed: true,
weekendVirtualEntryAllowed: true,
weekendDiscordEntryAllowed: !context.isWeekend,
weekendExitMonitoringAllowed: true,
weekendOutcomeRecordingAllowed: true,
sessionLearningAllowed: true,
sessionVirtualEntryAllowed: true,
sessionDiscordEntryAllowed: true,
sessionPolicyObservedOnly: true,
weekendBlocksNewDiscordEntriesOnly: true,
existingPositionMonitoringNeverBlockedByWeekend: true,
temporalContextExcludedFromFamilyId: true,
sessionContextExcludedFromFamilyId: true
};
}
function temporalRowPayload(row = {}, fallbackTs = Date.now()) {
const contextTs = normalizeTimestampMs(
firstTemporalValue(row, [
'contextTs',
'entryTs',
'openedAt',
'createdAt',
'ts',
'updatedAt'
]),
fallbackTs
);
const context = buildTemporalContext(contextTs);
const entry = buildEntryTemporalContext(row, contextTs);
const exit = buildExitTemporalContext(row, null);
return {
temporalAdmin: buildTemporalAdminEnvelope(row, contextTs),
temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
weekendPolicyVersion: WEEKEND_POLICY_VERSION,
sessionPolicyVersion: SESSION_POLICY_VERSION,
weekendMode: WEEKEND_MODE,
sessionMode: SESSION_MODE,
...context,
...entry,
...exit,
weekendLearningAllowed: true,
weekendVirtualEntryAllowed: true,
weekendDiscordEntryAllowed: !entry.entryIsWeekend,
weekendExitMonitoringAllowed: true,
weekendOutcomeRecordingAllowed: true,
sessionLearningAllowed: true,
sessionVirtualEntryAllowed: true,

sessionDiscordEntryAllowed: true,
sessionPolicyObservedOnly: true,
weekendBlocksNewDiscordEntriesOnly: true,
existingPositionMonitoringNeverBlockedByWeekend: true,
temporalContextExcludedFromFamilyId: true,
sessionContextExcludedFromFamilyId: true,
...normalizeTemporalStats(row)
};
}
const MIN_COMPLETED_ACTIVE_LEARNING = 20;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;
const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
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
function now() {
return Date.now();
}
function upper(value) {
return String(value || '').trim().toUpperCase();
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

),
lastProcessedSnapshot: namespacedLongKey(
KEYS.long?.trade?.lastProcessedSnapshot ||
KEYS.trade?.longLastProcessedSnapshot ||
KEYS.trade?.lastProcessedSnapshot,
'TRADE:LAST_PROCESSED_SNAPSHOT'
)
}
};
function taxonomyFlags() {
return {
trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
exactTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
fixedTaxonomyPreferred: true,
parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
learningGranularity: LEARNING_GRANULARITY,
parentMicroFamilyCount: 15,
selectableChildMicroFamilyCount: 75,
setupTypes: SETUP_ORDER,
regimeBuckets: REGIME_ORDER,
confirmationProfiles: CONFIRMATION_PROFILE_ORDER,
parentFamilyFormat: 'MICRO_LONG_{SETUP}_{REGIME}',
selectableChildFamilyFormat:
'MICRO_LONG_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',
exampleParentTrueMicroFamilyId: 'MICRO_LONG_BREAKOUT_TREND',
exampleSelectableTrueMicroFamilyId:
'MICRO_LONG_BREAKOUT_TREND_A_STRONG_ALIGN',
parentIdsAreMetadataOnly: true,
selectableIdsAre75ChildOnly: true,
discordSelectionGranularity: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID'
};
}
function modeFlags() {
return {
         temporalAdmin: buildTemporalAdminEnvelope(),
...temporalPolicyPayload(now()),
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
shadowOnly: false,
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
exchangeOrdersDisabled: true,
bitgetOrdersDisabled: true,
exchangeCallsDisabled: true,
ignoreGlobalMaxOpenPositions: true,
noGlobalMaxOpenPositionsBlock: true,
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
...taxonomyFlags(),
learningMode: 'MICRO_FAMILY_LONG_ONLY_VIRTUAL_75_CHILD',
discordOnlyForManualSelection: true,
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
shortRootTouched: false,
adminReadOnly: true
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
function asArray(value) {
if (Array.isArray(value)) return value;
if (value && typeof value === 'object') return Object.values(value);
return [];
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
.map((part) => String(part || '').trim())
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
function getPositionTimeStopMin() {
const value = num(
CONFIG.long?.trade?.positionTimeStopMin ??
CONFIG.trade?.longPositionTimeStopMin ??
CONFIG.trade?.positionTimeStopMin,
DEFAULT_POSITION_TIME_STOP_MIN
);
if (!Number.isFinite(value) || value <= 0) return
DEFAULT_POSITION_TIME_STOP_MIN;
return value;
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
function hasShortToken(text = '') {
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
function hasLongToken(text = '') {
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
function parseLongTaxonomyMicroId(id = '') {
const value = upper(id);
if (!value.startsWith('MICRO_LONG_')) {
return {

valid: false,
selectable: false,
isParent: false,
isChild: false,
rawId: String(id || '').trim(),
parentTrueMicroFamilyId: null,
childTrueMicroFamilyId: null
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
for (const candidateRegime of REGIME_ORDER) {
const suffix = `_${candidateRegime}`;
if (body.endsWith(suffix)) {
regime = candidateRegime;
setup = body.slice(0, -suffix.length);
break;
}
}
const validParent =
Boolean(setup) &&
Boolean(regime) &&
LONG_FIXED_SETUP_TYPES.has(setup) &&
LONG_FIXED_REGIME_BUCKETS.has(regime);
const validChild =
validParent &&
Boolean(confirmationProfile) &&
LONG_CONFIRMATION_PROFILES.has(confirmationProfile);
const parentTrueMicroFamilyId = validParent
? `MICRO_LONG_${setup}_${regime}`
: null;
const childTrueMicroFamilyId = validChild
? `${parentTrueMicroFamilyId}_${confirmationProfile}`
: null;
return {
valid: validParent || validChild,
selectable: validChild,

isParent: validParent && !validChild,
isChild: validChild,
rawId: String(id || '').trim(),
setup,
regime,
confirmationProfile,
parentTrueMicroFamilyId,
childTrueMicroFamilyId,
trueMicroFamilyId: childTrueMicroFamilyId || parentTrueMicroFamilyId,
trueMicroFamilySchema: validChild ? CHILD_TRUE_MICRO_SCHEMA : validParent ?
PARENT_TRUE_MICRO_SCHEMA : null,
learningGranularity: validChild ? LEARNING_GRANULARITY : validParent ?
PARENT_LEARNING_GRANULARITY : null
};
}
function isParentLongTaxonomyMicroId(id = '') {
const parsed = parseLongTaxonomyMicroId(id);
return parsed.valid && parsed.isParent;
}
function isChildLongTaxonomyMicroId(id = '') {
const parsed = parseLongTaxonomyMicroId(id);
return parsed.valid && parsed.isChild;
}
function isFixedLongTaxonomyMicroId(id = '') {
return parseLongTaxonomyMicroId(id).valid;
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
function idLooksLikeLongFamily(id = '') {
const value = String(id || '').trim();
if (!validLearningId(value)) return false;
if (isFixedLongTaxonomyMicroId(value)) return true;
return hasLongToken(value);
}
function idLooksLikeShortFamily(id = '') {
const value = String(id || '').trim();
if (!validLearningId(value)) return false;
return hasShortToken(value);
}
function isSelectableTrueMicroId(id = '') {
const value = String(id || '').trim();
if (!validLearningId(value)) return false;
if (!idLooksLikeLongFamily(value)) return false;
if (idLooksLikeShortFamily(value) && !idLooksLikeLongFamily(value)) return
false;
return isChildLongTaxonomyMicroId(value);
}
function firstValidLearningId(values = [], fallback = null) {
for (const value of values) {
const id = String(value || '').trim();
if (validLearningId(id)) return id;
}
return fallback;
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
const longHit = hasLongToken(raw);
const shortHit = hasShortToken(raw);
if (longHit && !shortHit) return TARGET_TRADE_SIDE;
if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;
if (longHit && shortHit) {
if (raw.includes('TRADE_SIDE=LONG') || raw.includes('TRADESIDE=LONG'))
return TARGET_TRADE_SIDE;
if (raw.includes('TRADE_SIDE=SHORT') || raw.includes('TRADESIDE=SHORT')) return
OPPOSITE_TRADE_SIDE;
if (raw.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
if (raw.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
}
return 'UNKNOWN';
}
function validShortRiskShape({
entry,
initialSl,
sl,
tp
} = {}) {
const e = num(entry, 0);
const stop = num(sl ?? initialSl, 0);
const initialStop = num(initialSl ?? sl, 0);
const target = num(tp, 0);
return e > 0 && stop > 0 && initialStop > 0 && stop > e && initialStop > e &&
target > 0 && target < e;
}
function validLongRiskShape({
entry,
initialSl,
sl,
tp
} = {}) {
const e = num(entry, 0);
const stop = num(sl ?? initialSl, 0);
const initialStop = num(initialSl ?? sl, 0);
const target = num(tp, 0);
return e > 0 && stop > 0 && initialStop > 0 && stop < e && initialStop < e &&
target > 0 && target > e;
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
return values.reduce((total, value) => total + Math.sign(value), 0);
}
function inferTradeSide(row = {}) {
if (typeof row === 'string') {
if (hasLongToken(row)) return TARGET_TRADE_SIDE;
if (hasShortToken(row)) return OPPOSITE_TRADE_SIDE;
return 'UNKNOWN';
}
if (!row || typeof row !== 'object') return 'UNKNOWN';
const explicitSourceSide = normalizeDirectSide(
row.rawInferredTradeSide ||
row.originalTradeSide ||
null
);
if (explicitSourceSide === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
if (explicitSourceSide === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
const inferredSide = normalizeDirectSide(row.inferredTradeSide);
if (inferredSide === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
if (inferredSide === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
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
row.parentMacroFamilyId,
row.macroFamilyId,
row.parentMicroFamilyId,
row.parentFamilyId,
row.macroId,
row.macroFamily,
row.originalMicroFamilyId,
row.parentTrueMicroFamilyId,
row.childTrueMicroFamilyId,
row.microFamilyId,
row.trueMicroFamilyId,
row.liveMicroFamilyId,
row.realMicroFamilyId,
row.executionMicroFamilyId,
row.coarseMicroFamilyId,
row.baseMicroFamilyId,
row.legacyMicroFamilyId,
row.id,
row.key
]
.map((value) => cleanSideText(value))
.filter(Boolean)
.join(' | ');
const familyLong = hasLongToken(familyText);
const familyShort = hasShortToken(familyText);
if (familyLong && !familyShort) return TARGET_TRADE_SIDE;
if (familyShort && !familyLong) return OPPOSITE_TRADE_SIDE;
if (familyLong && familyShort) {
const microText = cleanSideText(
row.trueMicroFamilyId ||
row.microFamilyId ||
row.childTrueMicroFamilyId ||

row.parentTrueMicroFamilyId ||
row.liveMicroFamilyId ||
row.realMicroFamilyId ||
row.executionMicroFamilyId ||
row.coarseMicroFamilyId ||
row.id ||
row.key
);
if (hasLongToken(microText)) return TARGET_TRADE_SIDE;
if (hasShortToken(microText)) return OPPOSITE_TRADE_SIDE;
}
const reasonText = [
row.scannerReason,
row.reason,
row.signalReason,
row.actionReason,
row.exitReason,
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
if (row.longOnly === true || row.shortDisabled === true) return
TARGET_TRADE_SIDE;
if (row.shortOnly === true || row.longDisabled === true) return
OPPOSITE_TRADE_SIDE;
if (validLongRiskShape(row)) return TARGET_TRADE_SIDE;
if (validShortRiskShape(row)) return OPPOSITE_TRADE_SIDE;
const moveScore = directionalMoveScore(row);
if (moveScore > 0) return TARGET_TRADE_SIDE;
if (moveScore < 0) return OPPOSITE_TRADE_SIDE;
return 'UNKNOWN';
}
function isLongRow(row = {}) {
return inferTradeSide(row) === TARGET_TRADE_SIDE;
}
function isShortRow(row = {}) {
return inferTradeSide(row) === OPPOSITE_TRADE_SIDE;

}
function isUnknownSideRow(row = {}) {
return inferTradeSide(row) === 'UNKNOWN';
}
function getFamilyId(row = {}) {
return firstValidLearningId([
row.familyId,
row.family,
row.baseFamilyId
], null);
}
function getMacroFamilyId(row = {}) {
return firstValidLearningId([
row.parentMacroFamilyId,
row.macroFamilyId,
row.parentMicroFamilyId,
row.parentFamilyId,
row.parentTrueMicroFamilyId,
row.macroId,
row.macroFamily,
row.originalMicroFamilyId
], null);
}
function getMicroFamilyId(row = {}) {
return firstValidLearningId([
row.trueMicroFamilyId,
row.childTrueMicroFamilyId,
row.learningMicroFamilyId,
row.analyzeMicroFamilyId,
row.microFamilyId,
row.liveMicroFamilyId,
row.realMicroFamilyId,
row.id,
row.key
], null);
}
function getCoarseMicroFamilyId(row = {}) {
return firstValidLearningId([
row.parentTrueMicroFamilyId,
row.coarseMicroFamilyId,
row.baseMicroFamilyId,
row.legacyMicroFamilyId,
row.trueMicroFamilyId,
row.learningMicroFamilyId,
row.analyzeMicroFamilyId,
row.microFamilyId
], null);

}
function resolveTaxonomyIds(row = {}) {
const exactCandidate = firstValidLearningId([
row.trueMicroFamilyId,
row.childTrueMicroFamilyId,
row.learningMicroFamilyId,
row.analyzeMicroFamilyId,
row.microFamilyId,
row.id,
row.key
], null);
const parsedExact = parseLongTaxonomyMicroId(exactCandidate);
const parsedParent = parseLongTaxonomyMicroId(
row.parentTrueMicroFamilyId ||
row.coarseMicroFamilyId ||
row.parentMacroFamilyId ||
row.macroFamilyId ||
null
);
const parentTrueMicroFamilyId =
parsedExact.parentTrueMicroFamilyId ||
parsedParent.parentTrueMicroFamilyId ||
row.parentTrueMicroFamilyId ||
null;
const childTrueMicroFamilyId =
parsedExact.childTrueMicroFamilyId ||
row.childTrueMicroFamilyId ||
null;
const trueMicroFamilyId =
childTrueMicroFamilyId ||
parsedExact.trueMicroFamilyId ||
exactCandidate ||
null;
return {
parsedExact,
parentTrueMicroFamilyId,
childTrueMicroFamilyId,
trueMicroFamilyId,
isParentTrueMicroFamilyId: Boolean(parsedExact.isParent),
isChildTrueMicroFamilyId: Boolean(parsedExact.isChild),
selectableTrueMicroFamilyId: Boolean(parsedExact.selectable),
fixedTaxonomyLearningId: Boolean(parsedExact.valid || parsedParent.valid)
};
}
function forceLongRow(row = {}) {
return {
...row,

...modeFlags(),
source: row.source || 'VIRTUAL',
outcomeSource: row.outcomeSource || row.source || 'VIRTUAL',
virtualOnly: true,
virtualTracked: true,
shadowOnly: Boolean(row.shadowOnly),
realTrade: false,
realOrder: false,
exchangeOrder: false,
bitgetOrderPlaced: false,
realOrdersDisabled: true,
exchangeOrdersDisabled: true,
bitgetOrdersDisabled: true,
exchangeCallsDisabled: true,
noRealOrders: true,
inferredTradeSide: TARGET_TRADE_SIDE
};
}
function calcAgeSec(ts) {
const value = num(ts, 0);
if (value <= 0) return null;
return Math.max(0, Math.floor((now() - value) / 1000));
}
function calcRiskDistance(entry, initialSl) {
const e = num(entry, 0);
const sl = num(initialSl, 0);
if (e <= 0 || sl <= 0 || sl >= e) return 0;
return e - sl;
}
function calcRewardDistance(entry, tp) {
const e = num(entry, 0);
const target = num(tp, 0);
if (e <= 0 || target <= 0 || target <= e) return 0;
return target - e;
}
function calcCurrentR({
entry,
initialSl,
currentPrice,
fallback = 0
} = {}) {
const e = num(entry, 0);
const sl = num(initialSl, 0);
const price = num(currentPrice, 0);
const riskDistance = calcRiskDistance(e, sl);
if (e <= 0 || sl <= 0 || price <= 0 || riskDistance <= 0) {
return num(fallback, 0);

}
return (price - e) / riskDistance;
}
function calcGrossR({
entry,
initialSl,
exitPrice,
fallback = 0
} = {}) {
const e = num(entry, 0);
const sl = num(initialSl, 0);
const price = num(exitPrice, 0);
const riskDistance = calcRiskDistance(e, sl);
if (e <= 0 || sl <= 0 || price <= 0 || riskDistance <= 0) {
return num(fallback, 0);
}
return (price - e) / riskDistance;
}
function normalizeDefinitionParts(value) {
if (Array.isArray(value)) return value;
if (typeof value === 'string') {
return value
.split('|')
.map((part) => part.trim())
.filter(Boolean);
}
return [];
}
function safeBaseSymbol(value) {
try {
return normalizeBaseSymbol(value);
} catch {
return String(value || '').trim();
}
}
function safeContractSymbol(value) {
try {
return normalizeContractSymbol(value);
} catch {
return String(value || '').trim();
}
}
function getRawPositionSide(position = {}) {
return inferTradeSide({
...position,
rawInferredTradeSide: null,
inferredTradeSide: null

});
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
function buildExitDebug({
entry,
sl,
initialSl,
tp,
currentPrice,
openedAt
} = {}) {
const ageSec = calcAgeSec(openedAt);
const timeStopMin = getPositionTimeStopMin();
const timeStopSec = timeStopMin * 60;
const tpHitNow = currentPrice > 0 && tp > 0 && currentPrice >= tp;
const slHitNow = currentPrice > 0 && sl > 0 && currentPrice <= sl;
const timeStopHitNow = ageSec !== null && ageSec >= timeStopSec;
let exitReasonNow = null;
if (tpHitNow) exitReasonNow = 'TP';
else if (slHitNow) exitReasonNow = 'SL';
else if (timeStopHitNow) exitReasonNow = 'TIME_STOP';
return {
tpHitNow,
slHitNow,
timeStopHitNow,
exitReadyNow: Boolean(exitReasonNow),
exitReasonNow,
longExitPriority: ['TP', 'SL', 'TIME_STOP'],
tpSlIndependentFromTimeStop: true,
timeStopMin,
timeStopSec,
ageSec,
secondsUntilTimeStop: ageSec === null
? null
: Math.max(0, timeStopSec - ageSec),
grossRIfClosedNow: round(
calcCurrentR({
entry,
initialSl,
currentPrice,
fallback: 0

}),
4
)
};
}
function normalizePosition(position = {}) {
const rawSymbol =
position.symbol ||
position.baseSymbol ||
position.contractSymbol ||
position.instId ||
position.instrumentId ||
null;
const symbol = safeBaseSymbol(rawSymbol);
const contractSymbol = safeContractSymbol(
position.contractSymbol ||
position.symbol ||
position.instId ||
position.instrumentId ||
symbol
);
const taxonomy = resolveTaxonomyIds(position);
const microFamilyId = taxonomy.trueMicroFamilyId || getMicroFamilyId(position);
const trueMicroFamilyId = taxonomy.trueMicroFamilyId ||
position.trueMicroFamilyId || microFamilyId;
const parentTrueMicroFamilyId = taxonomy.parentTrueMicroFamilyId ||
position.parentTrueMicroFamilyId || null;
const childTrueMicroFamilyId = taxonomy.childTrueMicroFamilyId || null;
const coarseMicroFamilyId = parentTrueMicroFamilyId ||
getCoarseMicroFamilyId(position) || trueMicroFamilyId || microFamilyId;
const macroFamilyId = parentTrueMicroFamilyId || getMacroFamilyId(position) ||
position.parentMacroFamilyId || null;
const familyId = getFamilyId(position);
const rawInferredTradeSide = getRawPositionSide({
...position,
microFamilyId,
trueMicroFamilyId,
parentTrueMicroFamilyId,
childTrueMicroFamilyId,
coarseMicroFamilyId,
macroFamilyId,
familyId
});
const entry = num(position.entry ?? position.entryPrice, 0);
const sl = num(position.sl ?? position.stopLoss, 0);
const initialSl = num(
position.initialSl ??

position.initialStopLoss ??
sl,
sl
);
const tp = num(position.tp ?? position.takeProfit, 0);
const lastPrice = num(
position.lastPrice ??
position.currentPrice ??
position.markPrice ??
position.price,
0
);
const currentPrice = num(
position.currentPrice ??
position.lastPrice ??
position.markPrice ??
position.price,
lastPrice
);
const riskDistance = calcRiskDistance(entry, initialSl);
const rewardDistance = calcRewardDistance(entry, tp);
const rr = num(
position.rr,
riskDistance > 0 ? rewardDistance / riskDistance : 0
);
const currentR = calcCurrentR({
entry,
initialSl,
currentPrice,
fallback: position.currentR
});
const openedAt = num(
position.openedAt ??
position.createdAt ??
position.ts,
0
);
const macroDefinitionParts = normalizeDefinitionParts(
position.macroDefinitionParts ||
position.parentDefinitionParts ||
position.macroDefinition ||
position.parentDefinition
);
const definitionParts = normalizeDefinitionParts(
position.definitionParts ||
position.microDefinitionParts ||
position.definition ||

position.microDefinition
);
const riskShapeValid = validLongRiskShape({
entry,
sl,
initialSl,
tp
});
const exitDebug = buildExitDebug({
entry,
sl,
initialSl,
tp,
currentPrice,
openedAt
});
const fit = getLongCurrentFit(position);
const grossR = calcGrossR({
entry,
initialSl,
exitPrice: currentPrice,
fallback: currentR
});
return {
...position,
...temporalRowPayload(position),
symbol: symbol || position.symbol || null,
baseSymbol: symbol || position.baseSymbol || null,
contractSymbol,
...modeFlags(),
rawInferredTradeSide,
inferredTradeSide: rawInferredTradeSide,
source: 'VIRTUAL',
outcomeSource: position.outcomeSource || 'VIRTUAL',
virtualOnly: true,
virtualTracked: true,
shadowOnly: Boolean(position.shadowOnly),
realTrade: false,
realOrder: false,
exchangeOrder: false,
bitgetOrderPlaced: false,
realOrdersDisabled: true,
exchangeOrdersDisabled: true,
bitgetOrdersDisabled: true,
exchangeCallsDisabled: true,
noRealOrders: true,
entry,

sl,
initialSl,
tp,
rr: round(rr, 4),
longRiskShapeValid: riskShapeValid,
validLongRiskShape: riskShapeValid,
validLongGeometry: riskShapeValid,
riskGeometryRule: 'LONG: sl < entry < tp',
tpHitRule: 'LONG: price >= tp',
slHitRule: 'LONG: price <= sl',
grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
currentRFormula: '(currentPrice - entry) / (entry - initialSl)',
lastPrice,
currentPrice,
currentR: round(currentR, 4),
longCurrentR: round(currentR, 4),
grossR: round(grossR, 4),
longGrossR: round(grossR, 4),
mfeR: round(position.mfeR, 4),
maeR: round(position.maeR, 4),
currentFit: fit.label,
currentFitLabel: fit.label,
currentFitScore: round(fit.score, 4),
fitScore: round(fit.score, 4),
longCurrentFit: round(fit.score, 4),
bullCurrentFit: round(fit.score, 4),
bearishCurrentFit: round(-Math.abs(fit.score), 4),
currentFitSource: fit.source,
currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
riskPct: round(position.riskPct, 6),
riskFraction: round(position.riskFraction, 6),
familyId,
macroFamilyId,
parentMacroFamilyId: position.parentMacroFamilyId || macroFamilyId || null,
parentTrueMicroFamilyId,
childTrueMicroFamilyId,
microFamilyId: trueMicroFamilyId || microFamilyId,
trueMicroFamilyId,
analyzeMicroFamilyId: position.analyzeMicroFamilyId || trueMicroFamilyId ||
microFamilyId,
learningMicroFamilyId: position.learningMicroFamilyId || trueMicroFamilyId ||
microFamilyId,
coarseMicroFamilyId,
fixedTaxonomyLearningId: taxonomy.fixedTaxonomyLearningId,
parentFixedTaxonomyLearningId: Boolean(parentTrueMicroFamilyId &&
isParentLongTaxonomyMicroId(parentTrueMicroFamilyId)),

childFixedTaxonomyLearningId: Boolean(childTrueMicroFamilyId &&
isChildLongTaxonomyMicroId(childTrueMicroFamilyId)),
selectableTrueMicroFamilyId: Boolean(trueMicroFamilyId &&
isSelectableTrueMicroId(trueMicroFamilyId)),
trueMicroFamilySchema: taxonomy.selectableTrueMicroFamilyId
? CHILD_TRUE_MICRO_SCHEMA
: taxonomy.fixedTaxonomyLearningId
? TRUE_MICRO_SCHEMA
: position.trueMicroFamilySchema || position.schema || null,
parentTrueMicroFamilySchema: parentTrueMicroFamilyId ?
PARENT_TRUE_MICRO_SCHEMA : null,
childTrueMicroFamilySchema: childTrueMicroFamilyId ? CHILD_TRUE_MICRO_SCHEMA :
null,
broadTrueMicroFamilySchema: taxonomy.fixedTaxonomyLearningId
? TRUE_MICRO_SCHEMA
: position.broadTrueMicroFamilySchema || position.trueMicroFamilySchema ||
position.schema || null,
scannerMicroFamilyId: position.scannerMicroFamilyId || null,
scannerFamilyId: position.scannerFamilyId || null,
scannerDefinition: position.scannerDefinition || null,
scannerDefinitionParts: Array.isArray(position.scannerDefinitionParts)
? position.scannerDefinitionParts
: [],
scannerFingerprintRole: 'METADATA_ONLY',
scannerFingerprintsMetadataOnly: true,
scannerFingerprintsUsedAsLearningFamily: false,
executionMicroFamilyId: position.executionMicroFamilyId || null,
executionFingerprintHash: position.executionFingerprintHash || null,
executionFingerprintParts: Array.isArray(position.executionFingerprintParts)
? position.executionFingerprintParts
: [],
executionFingerprintSchema: position.executionFingerprintSchema || null,
executionFingerprintRole: 'METADATA_ONLY',
executionFingerprintsMetadataOnly: true,
executionFingerprintsUsedAsLearningFamily: false,
macroDefinition: position.macroDefinition || position.parentDefinition ||
null,
macroDefinitionParts,
definition: position.definition || position.microDefinition || null,
definitionParts,
microDefinitionParts: normalizeDefinitionParts(
position.microDefinitionParts ||
position.definitionParts ||
position.microDefinition ||
position.definition
),
activeRotationId: position.activeRotationId || null,

selectedRotationId: position.selectedRotationId || position.activeRotationId
|| null,
discordAlertEligible: Boolean(position.discordAlertEligible),
selectedMicroFamilyAlert: Boolean(position.selectedMicroFamilyAlert),
discordEntryAlertSent: Boolean(position.discordEntryAlertSent),
discordExitAlertEligible: Boolean(position.discordExitAlertEligible),
discordExitAlertSent: Boolean(position.discordExitAlertSent),
openedAt,
ageSec: exitDebug.ageSec,
riskDistance: round(riskDistance, 10),
rewardDistance: round(rewardDistance, 10),
ticksObserved: num(position.ticksObserved, 0),
favorableTicks: num(position.favorableTicks, 0),
adverseTicks: num(position.adverseTicks, 0),
priceFetchFailures: num(position.priceFetchFailures, 0),
lastPriceFetchFailedAt: position.lastPriceFetchFailedAt || null,
reachedHalfR: Boolean(position.reachedHalfR),
reachedOneR: Boolean(position.reachedOneR),
nearTpSeen: Boolean(position.nearTpSeen),
beArmed: Boolean(position.beArmed),
beWouldExit: Boolean(position.beWouldExit),
beExitR: num(position.beExitR, 0),
gaveBackAfterHalfR: Boolean(position.gaveBackAfterHalfR),
gaveBackAfterOneR: Boolean(position.gaveBackAfterOneR),
nearTpThenLoss: Boolean(position.nearTpThenLoss),
liveManaged: false,
beLiveApplied: false,
trailLiveApplied: false,
slManagementSource: position.slManagementSource || null,
breakEvenArmed: Boolean(position.beArmed || position.breakEvenArmed),
trailingActive: Boolean(
position.trailLiveApplied ||
position.trailingActive ||
upper(position.slManagementSource) === 'TRAIL'
),
longTpHit: exitDebug.tpHitNow,
longSlHit: exitDebug.slHitNow,
tpHit: exitDebug.tpHitNow,
slHit: exitDebug.slHitNow,
...exitDebug
};
}
function sum(rows, selector) {
return rows.reduce((total, row) => total + num(selector(row), 0), 0);
}
function average(rows, selector) {
if (!rows.length) return 0;

return sum(rows, selector) / rows.length;
}
function countBy(rows, selector) {
return rows.reduce((acc, row) => {
const key = selector(row) || 'unknown';
acc[key] = (acc[key] || 0) + 1;
return acc;
}, {});
}
function buildPositionStats(positions = [], ignored = {}) {
const longRows = positions.filter(isLongRow);
const totalCurrentR = sum(longRows, (p) => p.currentR);
const totalMfeR = sum(longRows, (p) => p.mfeR);
const totalMaeR = sum(longRows, (p) => p.maeR);
const totalRiskFraction = sum(longRows, (p) => p.riskFraction);
const profitable = longRows.filter((p) => num(p.currentR, 0) > 0);
const losing = longRows.filter((p) => num(p.currentR, 0) < 0);
const uniqueParentFamilies = uniqueStrings(
longRows.map((position) => position.parentTrueMicroFamilyId ||
position.macroFamilyId)
);
const uniqueChildFamilies = uniqueStrings(
longRows.map((position) => position.trueMicroFamilyId ||
position.microFamilyId)
);
const discordEligiblePositions = longRows.filter((position) =>
position.discordAlertEligible);
const selectedMicroFamilyPositions = longRows.filter((position) =>
position.selectedMicroFamilyAlert);
const invalidRiskShapePositions = longRows.filter((position) =>
!position.longRiskShapeValid);
return {
...modeFlags(),
openPositions: longRows.length,
openVirtualPositions: longRows.length,
bullPositions: longRows.length,
bearPositions: 0,
unknownSidePositions: num(ignored.ignoredUnknownSidePositions, 0),
longPositions: longRows.length,
shortPositions: 0,
rawOpenPositions: num(ignored.rawOpenPositions, longRows.length),
ignoredShortPositions: num(ignored.ignoredShortPositions, 0),
ignoredUnknownSidePositions: num(ignored.ignoredUnknownSidePositions, 0),
invalidLongRiskShapePositions: invalidRiskShapePositions.length,
profitablePositions: profitable.length,
losingPositions: losing.length,
flatPositions: longRows.length - profitable.length - losing.length,

exitReadyNow: longRows.filter((p) => p.exitReadyNow).length,
tpHitNow: longRows.filter((p) => p.tpHitNow).length,
slHitNow: longRows.filter((p) => p.slHitNow).length,
timeStopHitNow: longRows.filter((p) => p.timeStopHitNow).length,
totalCurrentR: round(totalCurrentR, 4),
avgCurrentR: round(average(longRows, (p) => p.currentR), 4),
totalMfeR: round(totalMfeR, 4),
avgMfeR: round(average(longRows, (p) => p.mfeR), 4),
totalMaeR: round(totalMaeR, 4),
avgMaeR: round(average(longRows, (p) => p.maeR), 4),
totalRiskFraction: round(totalRiskFraction, 6),
longRiskFraction: round(totalRiskFraction, 6),
shortRiskFraction: 0,
reachedHalfR: longRows.filter((p) => p.reachedHalfR).length,
reachedOneR: longRows.filter((p) => p.reachedOneR).length,
nearTpSeen: longRows.filter((p) => p.nearTpSeen).length,
beArmed: longRows.filter((p) => p.beArmed).length,
beWouldExit: longRows.filter((p) => p.beWouldExit).length,
breakEvenArmed: longRows.filter((p) => p.breakEvenArmed).length,
trailingActive: longRows.filter((p) => p.trailingActive).length,
gaveBackAfterHalfR: longRows.filter((p) => p.gaveBackAfterHalfR).length,
gaveBackAfterOneR: longRows.filter((p) => p.gaveBackAfterOneR).length,
nearTpThenLoss: longRows.filter((p) => p.nearTpThenLoss).length,
discordEligiblePositions: discordEligiblePositions.length,
selectedMicroFamilyPositions: selectedMicroFamilyPositions.length,
silentLearningPositions: longRows.length - discordEligiblePositions.length,
uniqueParentMicroFamilies: uniqueParentFamilies.length,
uniqueSelectableChildMicroFamilies: uniqueChildFamilies.length,
uniqueMacroFamilies: uniqueParentFamilies.length,
uniqueMicroFamilies: uniqueChildFamilies.length,
byParentTrueMicroFamily: countBy(longRows, (p) => p.parentTrueMicroFamilyId
|| p.macroFamilyId),
byTrueMicroFamily: countBy(longRows, (p) => p.trueMicroFamilyId ||
p.microFamilyId),
byMacroFamily: countBy(longRows, (p) => p.parentTrueMicroFamilyId ||
p.macroFamilyId),
byMicroFamily: countBy(longRows, (p) => p.trueMicroFamilyId ||
p.microFamilyId),
bySide: {
bull: longRows.length,
bear: 0,
unknown: num(ignored.ignoredUnknownSidePositions, 0)
}
};
}
function extractSnapshotId(value) {
if (!value) return null;

if (typeof value === 'string') return value;
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
function normalizeLastProcessed(lastProcessed) {
const snapshotId = extractSnapshotId(lastProcessed);
if (!lastProcessed) {
return {
snapshotId: null,
raw: null,
...modeFlags()
};
}
if (typeof lastProcessed === 'string') {
return {
snapshotId: lastProcessed,
raw: lastProcessed,
...modeFlags()
};
}
return {
...lastProcessed,
...modeFlags(),
snapshotId,
raw: lastProcessed
};
}
function getRawActionSide(action = {}) {
return inferTradeSide({
...action,
rawInferredTradeSide: null,
inferredTradeSide: null
});
}
function normalizeAction(action = {}) {
const taxonomy = resolveTaxonomyIds(action);
const microFamilyId = taxonomy.trueMicroFamilyId || getMicroFamilyId(action);
const trueMicroFamilyId = taxonomy.trueMicroFamilyId || action.trueMicroFamilyId
|| microFamilyId;

const parentTrueMicroFamilyId = taxonomy.parentTrueMicroFamilyId ||
action.parentTrueMicroFamilyId || null;
const childTrueMicroFamilyId = taxonomy.childTrueMicroFamilyId || null;
const coarseMicroFamilyId = parentTrueMicroFamilyId ||
getCoarseMicroFamilyId(action);
const macroFamilyId = parentTrueMicroFamilyId || getMacroFamilyId(action) ||
action.parentMacroFamilyId || null;
const familyId = getFamilyId(action);
const rawInferredTradeSide = getRawActionSide({
...action,
microFamilyId,
trueMicroFamilyId,
parentTrueMicroFamilyId,
childTrueMicroFamilyId,
coarseMicroFamilyId,
macroFamilyId,
familyId
});
const fit = getLongCurrentFit(action);
return {
...action,
...temporalRowPayload(action),
...modeFlags(),
rawInferredTradeSide,
inferredTradeSide: rawInferredTradeSide,
source: action.source || 'VIRTUAL',
outcomeSource: action.outcomeSource || action.source || 'VIRTUAL',
virtualOnly: action.virtualOnly !== false,
virtualTracked: true,
shadowOnly: Boolean(action.shadowOnly),
realTrade: false,
realOrder: false,
exchangeOrder: false,
bitgetOrderPlaced: false,
realOrdersDisabled: true,
bitgetOrdersDisabled: true,
exchangeOrdersDisabled: true,
exchangeCallsDisabled: true,
familyId,
macroFamilyId,
parentMacroFamilyId: action.parentMacroFamilyId || macroFamilyId || null,
parentTrueMicroFamilyId,
childTrueMicroFamilyId,
microFamilyId: trueMicroFamilyId || microFamilyId,
trueMicroFamilyId,
analyzeMicroFamilyId: action.analyzeMicroFamilyId || trueMicroFamilyId ||
microFamilyId,

learningMicroFamilyId: action.learningMicroFamilyId || trueMicroFamilyId ||
microFamilyId,
coarseMicroFamilyId,
fixedTaxonomyLearningId: taxonomy.fixedTaxonomyLearningId,
parentFixedTaxonomyLearningId: Boolean(parentTrueMicroFamilyId &&
isParentLongTaxonomyMicroId(parentTrueMicroFamilyId)),
childFixedTaxonomyLearningId: Boolean(childTrueMicroFamilyId &&
isChildLongTaxonomyMicroId(childTrueMicroFamilyId)),
selectableTrueMicroFamilyId: Boolean(trueMicroFamilyId &&
isSelectableTrueMicroId(trueMicroFamilyId)),
trueMicroFamilySchema: taxonomy.selectableTrueMicroFamilyId
? CHILD_TRUE_MICRO_SCHEMA
: taxonomy.fixedTaxonomyLearningId
? TRUE_MICRO_SCHEMA
: action.trueMicroFamilySchema || action.schema || null,
parentTrueMicroFamilySchema: parentTrueMicroFamilyId ?
PARENT_TRUE_MICRO_SCHEMA : null,
childTrueMicroFamilySchema: childTrueMicroFamilyId ? CHILD_TRUE_MICRO_SCHEMA :
null,
scannerMicroFamilyId: action.scannerMicroFamilyId || null,
scannerFamilyId: action.scannerFamilyId || null,
scannerFingerprintRole: 'METADATA_ONLY',
scannerFingerprintsMetadataOnly: true,
scannerFingerprintsUsedAsLearningFamily: false,
executionMicroFamilyId: action.executionMicroFamilyId || null,
executionFingerprintRole: 'METADATA_ONLY',
executionFingerprintsMetadataOnly: true,
executionFingerprintsUsedAsLearningFamily: false,
scannerScore: action.scannerScore ?? action.moveScore ?? null,
currentFit: fit.label,
currentFitLabel: fit.label,
currentFitScore: round(fit.score, 4),
fitScore: round(fit.score, 4),
longCurrentFit: round(fit.score, 4),
bullCurrentFit: round(fit.score, 4),
bearishCurrentFit: round(-Math.abs(fit.score), 4),
currentFitSource: fit.source,
currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
confluence: round(action.confluence, 4),
sniperScore: round(action.sniperScore, 4),
rr: round(action.rr, 4),
spreadPct: round(action.spreadPct, 6),
depthMinUsd1p: round(action.depthMinUsd1p, 2),
liveEligible: false,
riskValid: Boolean(action.riskValid || action.liveRiskValid),
discordAlertEligible: Boolean(action.discordAlertEligible),

selectedMicroFamilyAlert: Boolean(action.selectedMicroFamilyAlert),
discordAlertSent: Boolean(action.discordAlertSent),
discordEntryAlertSent: Boolean(action.discordEntryAlertSent),
discordExitAlertEligible: Boolean(action.discordExitAlertEligible),
discordExitAlertSent: Boolean(action.discordExitAlertSent)
};
}
function normalizeExit(row = {}) {
const action = normalizeAction(row);
const entry = num(row.entry ?? row.entryPrice, 0);
const initialSl = num(row.initialSl ?? row.initialStopLoss ?? row.sl ??
row.stopLoss, 0);
const exitPrice = num(row.exitPrice ?? row.currentPrice ?? row.lastPrice, 0);
const grossR = hasValue(row.longGrossR)
? num(row.longGrossR, 0)
: hasValue(row.grossR)
? num(row.grossR, 0)
: calcGrossR({
entry,
initialSl,
exitPrice,
fallback: row.r
});
const costR = num(row.costR ?? row.totalCostR, 0);
const netR = hasValue(row.longNetR)
? num(row.longNetR, 0)
: hasValue(row.netR)
? num(row.netR, 0)
: grossR - costR;
return {
...temporalRowPayload(row),
...action,
action: 'VIRTUAL_EXIT',
source: 'VIRTUAL',
outcomeSource: 'VIRTUAL',
virtualOnly: true,
virtualTracked: true,
shadowOnly: Boolean(row.shadowOnly),
realTrade: false,
realOrder: false,
exchangeOrder: false,
bitgetOrderPlaced: false,
realOrdersDisabled: true,
bitgetOrdersDisabled: true,
exchangeOrdersDisabled: true,
exchangeCallsDisabled: true,
grossR: round(grossR, 4),

longGrossR: round(grossR, 4),
costR: round(costR, 4),
avgCostR: round(row.avgCostR ?? costR, 4),
netR: round(netR, 4),
longNetR: round(netR, 4),
r: round(netR, 4),
realizedR: round(row.realizedR ?? netR, 4),
pnlPct: round(row.pnlPct ?? row.netPnlPct, 4),
grossPnlPct: round(row.grossPnlPct, 4),
totalCostR: round(row.totalCostR ?? costR, 4),
exitPrice: round(exitPrice, 10),
entry: round(entry, 10),
initialSl: round(initialSl, 10),
sl: round(row.sl ?? row.stopLoss, 10),
tp: round(row.tp ?? row.takeProfit, 10),
validLongGeometry: validLongRiskShape({
entry,
initialSl,
sl: row.sl ?? row.stopLoss ?? initialSl,
tp: row.tp ?? row.takeProfit
}),
riskGeometryRule: 'LONG: sl < entry < tp',
tpHitRule: 'LONG: price >= tp',
slHitRule: 'LONG: price <= sl',
grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
currentRFormula: '(currentPrice - entry) / (entry - initialSl)',
exitReason: row.exitReason || row.reason || null,
exitedAt: row.exitedAt || row.closedAt || row.ts || null,
win: Boolean(row.win ?? netR > 0),
loss: Boolean(row.loss ?? netR < 0),
flat: Boolean(row.flat ?? netR === 0)
};
}
function actionCounts(actions = []) {
return actions.reduce((acc, action) => {
const key = action.action || action.type || 'UNKNOWN';
acc[key] = (acc[key] || 0) + 1;
return acc;
}, {});
}
function mergeActionCounts(...counts) {
return counts.reduce((acc, row) => {
for (const [key, value] of Object.entries(row || {})) {
acc[key] = num(acc[key], 0) + num(value, 0);
}
return acc;
}, {});

}
function selectRunExitRows(runMeta = {}) {
if (Array.isArray(runMeta.virtualExits)) return runMeta.virtualExits;
if (Array.isArray(runMeta.shadowExits)) return runMeta.shadowExits;
if (Array.isArray(runMeta.exits)) return runMeta.exits;
if (Array.isArray(runMeta.closedPositions)) return runMeta.closedPositions;
if (Array.isArray(runMeta.outcomes)) return runMeta.outcomes;
return [];
}
function normalizeRunMeta(runMeta) {
if (!runMeta || typeof runMeta !== 'object') return null;
const rawActionRows = asArray(runMeta.actions);
const normalizedActions = rawActionRows.map(normalizeAction);
const allLongActions = normalizedActions
.filter(isLongRow)
.map(forceLongRow);
const ignoredShortActions = normalizedActions.filter(isShortRow).length;
const ignoredUnknownSideActions =
normalizedActions.filter(isUnknownSideRow).length;
const entryActions = allLongActions.filter((action) => (
action.action === 'VIRTUAL_ENTRY' ||
action.action === 'ENTRY'
));
const waitActions = allLongActions.filter((action) => action.action ===
'WAIT');
const observationActions = allLongActions.filter((action) => (
action.action === 'OBSERVATION' ||
action.observationWritten ||
action.analysisInputOnly ||
action.observationOnly
));
const skippedActions = allLongActions.filter((action) => (
action.action === 'SKIP' ||
action.skipped ||
(
action.reason &&
action.action !== 'VIRTUAL_ENTRY' &&
action.action !== 'ENTRY'
)
));
const runVirtualExitsRaw = selectRunExitRows(runMeta);
const normalizedExitRows = runVirtualExitsRaw.map(normalizeExit);
const virtualExits = normalizedExitRows
.filter(isLongRow)
.map(forceLongRow);
const ignoredShortExitRows = normalizedExitRows.filter(isShortRow).length;
const ignoredUnknownSideExitRows =

normalizedExitRows.filter(isUnknownSideRow).length;
const exitActionCounts = virtualExits.length
? { VIRTUAL_EXIT: virtualExits.length }
: {};
const normalizedActionCounts = mergeActionCounts(
actionCounts(allLongActions),
exitActionCounts
);
const discordEntryAlerts = allLongActions.filter((action) => (
action.discordAlertEligible &&
action.selectedMicroFamilyAlert &&
(
action.discordEntryAlertSent ||
action.discordAlertSent ||
action.discordAlertQueued ||
action.action === 'VIRTUAL_ENTRY' ||
action.action === 'ENTRY'
)
));
const discordExitAlerts = virtualExits.filter((exit) => (
exit.discordAlertEligible &&
exit.selectedMicroFamilyAlert &&
(
exit.discordExitAlertSent ||
exit.discordAlertSent
)
));
return {
...temporalRowPayload(runMeta || {}),
...runMeta,
...modeFlags(),
ok: runMeta.ok !== false,
runId: runMeta.runId || null,
actions: allLongActions,
actionsCount: allLongActions.length,
virtualActions: allLongActions,
virtualActionsCount: allLongActions.length,
rawActionsCount: rawActionRows.length,
ignoredShortActions,
ignoredUnknownSideActions,
actionCounts: normalizedActionCounts,
rawActionCounts: runMeta.actionCounts || actionCounts(normalizedActions),
entryRows: num(runMeta.entryRows ?? entryActions.length, entryActions.length),
waitRows: num(runMeta.waitRows ?? waitActions.length, waitActions.length),
virtualCreatedRows: num(
runMeta.virtualCreatedRows ??
runMeta.shadowCreatedRows ??

entryActions.length,
entryActions.length
),
virtualSkippedRows: num(runMeta.virtualSkippedRows ??
runMeta.shadowSkippedRows, 0),
virtualFailedRows: num(runMeta.virtualFailedRows ?? runMeta.shadowFailedRows,
0),
entries: entryActions,
entriesCount: entryActions.length,
waits: waitActions,
waitsCount: waitActions.length,
observations: observationActions,
observationsCount: observationActions.length,
skippedActions,
skippedActionsCount: skippedActions.length,
virtualExits,
virtualExitsCount: virtualExits.length,
virtualExitRows: virtualExits.length,
exits: virtualExits,
exitsCount: virtualExits.length,
realExits: [],
realExitsCount: 0,
shadowExits: virtualExits,
shadowExitsCount: virtualExits.length,
shadowExitRows: virtualExits.length,
rawExitRowsCount: runVirtualExitsRaw.length,
ignoredShortExitRows,
ignoredUnknownSideExitRows,
discordEntryAlerts: discordEntryAlerts.length,
discordExitAlerts: discordExitAlerts.length,
parentMicroFamiliesSeen: uniqueStrings(
allLongActions.map((action) => action.parentTrueMicroFamilyId ||
action.macroFamilyId)
).length,
selectableChildMicroFamiliesSeen: uniqueStrings(
allLongActions.map((action) => action.trueMicroFamilyId ||
action.microFamilyId)
).length,
macroFamiliesSeen: uniqueStrings(
allLongActions.map((action) => action.parentTrueMicroFamilyId ||
action.macroFamilyId)
).length,
microFamiliesSeen: uniqueStrings(
allLongActions.map((action) => action.trueMicroFamilyId ||
action.microFamilyId)
).length,
startedAt: runMeta.startedAt || null,

completedAt: runMeta.completedAt || null,
durationMs: runMeta.durationMs ?? null,
snapshotId: runMeta.snapshotId || null,
snapshotAgeSec: runMeta.snapshotAgeSec ?? null,
skippedNewEntries: Boolean(runMeta.skippedNewEntries),
skipReason: runMeta.skipReason || runMeta.reason || null,
reason: runMeta.reason || runMeta.skipReason || null
};
}
function idsFromRotation(rotation = {}) {
const rows = Array.isArray(rotation.microFamilies)
? rotation.microFamilies
: [];
const normalizedRows = rows.map(normalizeAction);
const longRows = normalizedRows
.filter(isLongRow)
.map(forceLongRow)
.filter((row) => isSelectableTrueMicroId(row.trueMicroFamilyId ||
row.microFamilyId));
const explicitMicroFamilyIds = uniqueStrings([
rotation.microFamilyIds,
rotation.activeMicroFamilyIds,
rotation.trueMicroFamilyIds,
rotation.ids
]).filter(isSelectableTrueMicroId);
const rowMicroFamilyIds = uniqueStrings(
longRows.map((row) => row.trueMicroFamilyId || row.microFamilyId)
).filter(isSelectableTrueMicroId);
const microFamilyIds = uniqueStrings([
rowMicroFamilyIds,
explicitMicroFamilyIds
]).filter(isSelectableTrueMicroId);
const macroFamilyIds = uniqueStrings([
rotation.macroFamilyIds,
rotation.activeMacroFamilyIds,
rotation.macroIds,
longRows.map((row) => row.parentTrueMicroFamilyId || row.macroFamilyId ||
row.parentMacroFamilyId)
])
.filter(validLearningId)
.filter(idLooksLikeLongFamily);
return {
microFamilyIds,
macroFamilyIds,
longRows,
rawRows: normalizedRows
};

}
function normalizeActiveRotation(activeRotation) {
if (!activeRotation) {
return {
...modeFlags(),
rotationId: null,
activeMicroFamilyIds: [],
activeMacroFamilyIds: [],
activeMicroCount: 0,
activeMacroCount: 0,
microFamilies: [],
manualSelectionActive: false,
discordAlertsEnabled: false,
bestLong: null,
bestShort: null,
raw: null
};
}
const ids = idsFromRotation(activeRotation);
const longRows = ids.longRows;
const manualSelectionActive = ids.microFamilyIds.length > 0;
return {
...modeFlags(),
rotationId: activeRotation.rotationId || null,
activeMicroFamilyIds: ids.microFamilyIds,
activeMacroFamilyIds: ids.macroFamilyIds,
microFamilyIds: ids.microFamilyIds,
trueMicroFamilyIds: ids.microFamilyIds,
macroFamilyIds: ids.macroFamilyIds,
activeMicroCount: ids.microFamilyIds.length,
activeMacroCount: ids.macroFamilyIds.length,
sourceWeekKey: activeRotation.sourceWeekKey || PERSISTENT_LEARNING_KEY,
activeWeekKey: activeRotation.activeWeekKey || PERSISTENT_LEARNING_KEY,
mode: activeRotation.mode || null,
source: activeRotation.source || null,
manualSelectionActive,
discordAlertsEnabled: manualSelectionActive,
trueMicroOnly: true,
exactTrueMicroOnly: true,
exact75ChildOnly: true,
usedLegacyFallback: false,
usedSoftFallback: Boolean(activeRotation.usedSoftFallback),
usedObservationFallback: Boolean(activeRotation.usedObservationFallback),
usedRawFallback: Boolean(activeRotation.usedRawFallback),
usedPreviousWeekMerge: Boolean(activeRotation.usedPreviousWeekMerge),
microFamilies: longRows,
bestLong: longRows[0] || null,

bestShort: null,
rawRowsCount: ids.rawRows.length,
ignoredShortRows: ids.rawRows.filter(isShortRow).length,
ignoredUnknownSideRows: ids.rawRows.filter(isUnknownSideRow).length,
raw: {
...activeRotation,
...modeFlags(),
microFamilies: longRows,
microFamilyIds: ids.microFamilyIds,
activeMicroFamilyIds: ids.microFamilyIds,
trueMicroFamilyIds: ids.microFamilyIds,
macroFamilyIds: ids.macroFamilyIds,
activeMacroFamilyIds: ids.macroFamilyIds,
bestLong: longRows[0] || null,
bestShort: null
}
};
}
function buildRotationMatchStats(positions = [], activeRotationMeta = {}) {
const activeMicroSet = new Set(activeRotationMeta.activeMicroFamilyIds || []);
const selectedMicroPositions = positions.filter((position) => (
position.trueMicroFamilyId &&
activeMicroSet.has(position.trueMicroFamilyId)
));
const silentLearningPositions = positions.filter((position) => (
!position.trueMicroFamilyId ||
!activeMicroSet.has(position.trueMicroFamilyId)
));
return {
...modeFlags(),
manualSelectionActive: activeMicroSet.size > 0,
discordAlertsEnabled: activeMicroSet.size > 0,
selectedMicroPositions: selectedMicroPositions.length,
selectedMacroPositions: 0,
discordEligiblePositions: selectedMicroPositions.length,
silentLearningPositions: silentLearningPositions.length,
silentLearningSymbols: silentLearningPositions
.map((position) => position.symbol)
.filter(Boolean),
activeMicroFamilyIds: [...activeMicroSet],
activeMacroFamilyIds: activeRotationMeta.activeMacroFamilyIds || [],
selectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
selectionGranularity: 'EXACT_75_CHILD',
parentMatchDoesNotTriggerDiscord: true,
macroMatchDoesNotTriggerDiscord: true
};
}

function normalizeLatestScan(latestScan) {
if (!latestScan || typeof latestScan !== 'object') return latestScan;
const candidates = Array.isArray(latestScan.candidates)
? latestScan.candidates
: [];
const normalized = candidates.map(normalizeAction);
const longCandidates = normalized
.filter(isLongRow)
.map(forceLongRow);
const shortCandidates = normalized.filter(isShortRow);
const unknownSideCandidates = normalized.filter(isUnknownSideRow);
return {
...temporalRowPayload(latestScan || {}),
...latestScan,
...modeFlags(),
candidates: longCandidates,
candidatesCount: longCandidates.length,
longCandidatesCount: longCandidates.length,
shortCandidatesCount: shortCandidates.length,
rawCandidatesCount: candidates.length,
ignoredShortCandidates: shortCandidates.length,
ignoredUnknownSideCandidates: unknownSideCandidates.length
};
}
function buildSummary({
positions = [],
runMeta = null,
activeRotation = null,
latestScannerSnapshotId = null,
lastProcessedSnapshotId = null
} = {}) {
return {
...modeFlags(),
openVirtualPositions: positions.length,
virtualEntriesLastRun: num(runMeta?.entryRows ?? runMeta?.entriesCount, 0),
virtualExitsLastRun: num(runMeta?.virtualExitsCount, 0),
shadowExitsLastRun: num(runMeta?.shadowExitsCount, 0),
observationsLastRun: num(runMeta?.observationsCount, 0),
skippedActionsLastRun: num(runMeta?.skippedActionsCount, 0),
waitRowsLastRun: num(runMeta?.waitRows ?? runMeta?.waitsCount, 0),
actionCountsLastRun: runMeta?.actionCounts || {},
exitReadyNow: positions.filter((position) => position.exitReadyNow).length,
tpHitNow: positions.filter((position) => position.tpHitNow).length,
slHitNow: positions.filter((position) => position.slHitNow).length,
timeStopHitNow: positions.filter((position) =>
position.timeStopHitNow).length,
activeMicroFamilies: num(activeRotation?.activeMicroCount, 0),

activeMacroFamilies: num(activeRotation?.activeMacroCount, 0),
manualSelectionActive: Boolean(activeRotation?.manualSelectionActive),
discordAlertsEnabled: Boolean(activeRotation?.discordAlertsEnabled),
latestScannerSnapshotId,
lastProcessedSnapshotId,
scannerAndTradeInSync: Boolean(
latestScannerSnapshotId &&
lastProcessedSnapshotId &&
latestScannerSnapshotId === lastProcessedSnapshotId
)
};
}
async function getLongOpenPositionsSafe() {
return getOpenPositions({
tradeSide: TARGET_TRADE_SIDE,
side: TARGET_DASHBOARD_SIDE,
namespace: LONG_NAMESPACE,
keyPrefix: LONG_KEY_PREFIX,
virtualOnly: true
});
}
async function getActiveRotationSafe() {
return getActiveRotation({
tradeSide: TARGET_TRADE_SIDE,
side: TARGET_DASHBOARD_SIDE,
weekKey: PERSISTENT_LEARNING_KEY,
namespace: LONG_NAMESPACE,
keyPrefix: LONG_KEY_PREFIX
}).catch(() => null);
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
res.setHeader('X-Temporal-Context-Version', TEMPORAL_CONTEXT_VERSION);
res.setHeader('X-Weekend-Policy-Version', WEEKEND_POLICY_VERSION);
res.setHeader('X-Session-Policy-Version', SESSION_POLICY_VERSION);
res.setHeader('X-Weekend-Mode', WEEKEND_MODE);
res.setHeader('X-Session-Mode', SESSION_MODE);
res.setHeader('X-Admin-Trade-Mode', 'long-only-virtual-learning-75-child-truemicro-v1');
res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
res.setHeader('X-Long-Only', 'true');
res.setHeader('X-Short-Disabled', 'true');
res.setHeader('X-Virtual-Only', 'true');
res.setHeader('X-Virtual-Learning-Forced', 'true');
res.setHeader('X-No-Real-Orders', 'true');
res.setHeader('X-Real-Orders-Disabled', 'true');
res.setHeader('X-Bitget-Orders-Disabled', 'true');

res.setHeader('X-Exchange-Calls-Disabled', 'true');
res.setHeader('X-Exact-True-Micro-Only', 'true');
res.setHeader('X-True-Micro-Family-Schema', TRUE_MICRO_SCHEMA);
res.setHeader('X-Exact-True-Micro-Family-Schema', CHILD_TRUE_MICRO_SCHEMA);
res.setHeader('X-Learning-Granularity', LEARNING_GRANULARITY);
res.setHeader('X-Manual-Selection-Match-Mode', 'EXACT_TRUE_MICRO_FAMILY_ID');
res.setHeader('X-Discord-Selection-Rule',
'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY');
res.setHeader('X-Admin-Read-Only', 'true');
res.setHeader('X-Redis-Namespace', LONG_NAMESPACE);
res.setHeader('X-Short-Root-Touched', 'false');
if (req.method !== 'GET') {
return methodNotAllowed(res);
}
try {
const durable = getDurableRedis();
const volatile = getVolatileRedis();
const [
rawPositions,
runMetaRaw,
lastProcessedRaw,
latestScanRaw,
activeRotationRaw
] = await Promise.all([
getLongOpenPositionsSafe(),
getJson(durable, LONG_KEYS.trade.runMeta, null),
getJson(durable, LONG_KEYS.trade.lastProcessedSnapshot, null),
getJson(volatile, LONG_KEYS.scan.latest, null),
getActiveRotationSafe()
]);
const allPositions = asArray(rawPositions).map(normalizePosition);
const positions = allPositions
.filter(isLongRow)
.map(forceLongRow);
const ignoredShortPositions = allPositions.filter(isShortRow).length;
const ignoredUnknownSidePositions =
allPositions.filter(isUnknownSideRow).length;
const stats = buildPositionStats(positions, {
rawOpenPositions: allPositions.length,
ignoredShortPositions,
ignoredUnknownSidePositions
});
const runMeta = normalizeRunMeta(runMetaRaw);
const lastProcessed = normalizeLastProcessed(lastProcessedRaw);
const latestScan = normalizeLatestScan(latestScanRaw);
const latestScannerSnapshotId = extractSnapshotId(latestScanRaw);
const scannerAndTradeInSync =

Boolean(latestScannerSnapshotId) &&
Boolean(lastProcessed.snapshotId) &&
latestScannerSnapshotId === lastProcessed.snapshotId;
const activeRotation = normalizeActiveRotation(activeRotationRaw);
const rotationMatchStats = buildRotationMatchStats(
positions,
activeRotation
);
const summary = buildSummary({
positions,
runMeta,
activeRotation,
latestScannerSnapshotId,
lastProcessedSnapshotId: lastProcessed.snapshotId
});
return res.status(200).json({
ok: true,
...modeFlags(),
longKeys: {
namespace: LONG_NAMESPACE,
prefix: LONG_KEY_PREFIX,
tradeRunMeta: LONG_KEYS.trade.runMeta,
tradeLastProcessedSnapshot: LONG_KEYS.trade.lastProcessedSnapshot,
scanLatest: LONG_KEYS.scan.latest
},
positions,
openPositions: positions,
virtualPositions: positions,
openVirtualPositions: positions.length,
positionsCount: positions.length,
rawPositionsCount: allPositions.length,
ignoredShortPositions,
ignoredUnknownSidePositions,
stats,
rotationMatchStats,
summary,
runMeta,
lastRunMeta: runMeta
? {
runId: runMeta.runId || null,
shadowExits: runMeta.shadowExits || [],
virtualExits: runMeta.virtualExits || [],
actionCounts: runMeta.actionCounts || {},
skipReason: runMeta.skipReason || runMeta.reason || null,
entryRows: runMeta.entryRows,
waitRows: runMeta.waitRows,
virtualCreatedRows: runMeta.virtualCreatedRows

}
: null,
lastProcessed,
lastProcessedSnapshotId: lastProcessed.snapshotId,
latestScan,
latestScannerSnapshotId,
scannerAndTradeInSync,
activeRotationId: activeRotation.rotationId,
activeMicroFamilyIds: activeRotation.activeMicroFamilyIds,
activeMacroFamilyIds: activeRotation.activeMacroFamilyIds,
activeMicroCount: activeRotation.activeMicroCount,
activeMacroCount: activeRotation.activeMacroCount,
activeRotation,
debugFields: {
longPositionExitChecks: [
'currentPrice',
'lastPrice',
'entry',
'sl',
'initialSl',
'tp',
'ageSec',
'currentR',
'longCurrentR',
'mfeR',
'maeR',
'reachedHalfR',
'reachedOneR',
'nearTpSeen',
'tpHitNow',
'slHitNow',
'timeStopHitNow',
'exitReadyNow',
'exitReasonNow',
'discordExitAlertEligible',
'discordExitAlertSent',
'realOrdersDisabled',
'bitgetOrdersDisabled'
],
longExitRules: {
validRiskShape: 'entry > 0 && sl < entry && tp > entry',
tp: 'currentPrice >= tp',
sl: 'currentPrice <= sl',
timeStop: `ageSec >= ${getPositionTimeStopMin() * 60}`,
grossR: '(exitPrice - entry) / (entry - initialSl)',
currentR: '(currentPrice - entry) / (entry - initialSl)',
outcomeSource: 'VIRTUAL'

},
microFamilyRules: {
parent15: 'MICRO_LONG_{SETUP}_{REGIME}',
selectable75Child:
'MICRO_LONG_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',
discordMatch: 'exact selected 75-child trueMicroFamilyId only',
scannerBuckets: 'metadata only',
executionFingerprints: 'metadata only'
},
runMetaExitFields: [
'virtualExits',
'shadowExits',
'virtualExitsCount',
'shadowExitsCount',
'actionCounts'
]
},
warnings: uniqueStrings([
activeRotation.activeMicroCount <= 0
? 'NO_MANUAL_75_CHILD_MICRO_FAMILY_SELECTION_ACTIVE_DISCORD_DISABLED'
: null,
ignoredShortPositions > 0
? `SHORT_POSITIONS_IGNORED:${ignoredShortPositions}`
: null,
ignoredUnknownSidePositions > 0
? `UNKNOWN_SIDE_POSITIONS_IGNORED:${ignoredUnknownSidePositions}`
: null,
runMeta?.ignoredShortActions > 0
? `SHORT_ACTIONS_IGNORED:${runMeta.ignoredShortActions}`
: null,
runMeta?.ignoredUnknownSideActions > 0
? `UNKNOWN_SIDE_ACTIONS_IGNORED:${runMeta.ignoredUnknownSideActions}`
: null,
runMeta?.ignoredShortExitRows > 0
? `SHORT_EXIT_ROWS_IGNORED:${runMeta.ignoredShortExitRows}`
: null,
runMeta?.ignoredUnknownSideExitRows > 0
? `UNKNOWN_SIDE_EXIT_ROWS_IGNORED:${runMeta.ignoredUnknownSideExitRows}`
: null,
stats.invalidLongRiskShapePositions > 0
?
`INVALID_LONG_RISK_SHAPE_POSITIONS:${stats.invalidLongRiskShapePositions}`
: null,
stats.exitReadyNow > 0
?
`LONG_POSITIONS_READY_TO_CLOSE_ON_NEXT_TRADE_RUN:${stats.exitReadyNow}`
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
