// ================= FILE: api/trade/run.js =================
// LONG-only virtual trade runner.
//
// Belangrijk:
// - deze route start de scanner niet opnieuw;
// - /api/scanner/run onderhoudt LONG:SCAN:LATEST;
// - alleen compacte runmetadata wordt opgeslagen;
// - grote scanner-, candle-, candidate- en market-weather-rows worden niet
// naar LONG:TRADE:RUN_META geschreven;
// - echte exchange-orders blijven uitgeschakeld.
import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import {
getDurableRedis,
getVolatileRedis,
setJson,
getJson
} from '../../src/redis.js';
import * as LockApi from '../../src/lock.js';
import { runTradeSystem } from '../../src/trade/tradeSystem.js';
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
'LONG_TEMPORAL_CONTEXT_UTC_V2';
const WEEKEND_POLICY_VERSION =
'LONG_WEEKEND_DEFAULT_BLOCK_POSITIVE_OVERRIDE_V1';
const SESSION_POLICY_VERSION =
'LONG_SESSION_NEGATIVE_VETO_WEEKLY_PROFILE_V1';
const WEEKEND_MODE = 'OBSERVE';

const SESSION_MODE = 'OBSERVE';
const TEMPORAL_STATS_VERSION = 'LONG_TEMPORAL_FAMILY_STATS_V1';
const TEMPORAL_POLICY_VERSION =
'LONG_TEMPORAL_NEGATIVE_VETO_WEEKLY_GENERATION_V1';
const TEMPORAL_AGGREGATION_VERSION = 'LONG_TEMPORAL_CANONICAL_OUTCOME_V1';
const TEMPORAL_GENERATION_VERSION = 'LONG_TEMPORAL_ROOT_GENERATION_V1';
const TEMPORAL_POLICY_MODES = Object.freeze(['OFF', 'OBSERVE', 'ENFORCE']);
const TEMPORAL_GATE_WINDOW_MAX_OUTCOMES = 50;
const TEMPORAL_GATE_WINDOW_MAX_AGE_DAYS = 180;
const TEMPORAL_VETO_MIN_COMPLETED = 35;
const TEMPORAL_WEEKEND_APPROVAL_MIN_COMPLETED = 50;
const TEMPORAL_VETO_MATERIAL_AVG_R = -0.10;
const TEMPORAL_RECOVERY_MATERIAL_AVG_R = 0.05;
const TEMPORAL_WEEKEND_MATERIAL_AVG_R = 0.10;
const TEMPORAL_FDR_Q_MAX = 0.05;
const TEMPORAL_VETO_CONFIRM_NEW_OUTCOMES = 5;
const TEMPORAL_RECOVERY_START_NEW_OUTCOMES = 10;
const TEMPORAL_RECOVERY_CONFIRM_NEW_OUTCOMES = 5;
const TEMPORAL_WEEKEND_CONFIRM_NEW_OUTCOMES = 10;
const TEMPORAL_CANDIDATE_MAX_FREEZES = 4;
const TEMPORAL_GENERATION_MAX_AGE_DAYS = 14;
const TEMPORAL_WEEKEND_FRESHNESS_DAYS = 45;
const TEMPORAL_VETO_STALE_DAYS = 60;
const TEMPORAL_ACTIVATION_WINDOW_MS = 24 * 60 * 60 * 1000;
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
const PARENT_LEARNING_GRANULARITY =
'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_V1';

const RUN_SCOPE =
'TRADE_FROM_EXISTING_SCANNER_SNAPSHOT';
const WRITE_SCOPE =
'TRADE_AND_ANALYZE_PARTIAL';
const READ_SCOPE =
'READ_LONG_SCANNER_AND_MARKET_WEATHER';
const TRADE_LOCK_RESOURCE =
'TRADE_RUN';
const DEFAULT_LOCK_TTL_SEC = 55;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;
const DEFAULT_RUNTIME_BUDGET_MS = 40000;
const MAX_RUNTIME_BUDGET_MS = 42000;
const ROUTE_HARD_TIMEOUT_MS = 47000;
const DEFAULT_RESPONSE_ROW_LIMIT = 50;
const MAX_RESPONSE_ROW_LIMIT = 250;
const MAX_RUN_META_BYTES = 1_000_000;
const MAX_ID_LIST = 100;
const MAX_WARNING_LIST = 50;
const TRADE_RUNTIME_FAIRNESS_VERSION = 'LONG_TRADE_RUNTIME_FAIRNESS_ADAPTIVE_RETRY_V5';
const ADAPTIVE_NO_PROGRESS_BATCH_VERSION = 'LONG_ADAPTIVE_NO_PROGRESS_BATCH_V1';
const AUTHORITATIVE_OPEN_SYMBOL_CHECK_VERSION = 'LONG_AUTHORITATIVE_OPEN_SYMBOL_CHECK_V1';
const SNAPSHOT_CONTINUATION_VERSION = 'LONG_SNAPSHOT_CONTINUATION_NO_FORCE_RESET_V2';
const MARKET_UNIVERSE_PRELOAD_VERSION = 'LONG_MARKET_UNIVERSE_EMBEDDED_FALLBACK_V2';
const SNAPSHOT_COMPLETION_PERSISTENCE_VERSION =
'LONG_LAST_PROCESSED_ONLY_WHEN_COMPLETE_V2';
const TRADE_RESPONSE_CONTRACT_VERSION =
'LONG_TRADE_RESPONSE_OPEN_VS_EXIT_V4';
const API_MARKET_EVENT_CLUSTER_CANONICALIZATION_VERSION =
'LONG_API_MARKET_EVENT_CLUSTER_IDEMPOTENT_V3';
const SNAPSHOT_PROGRESS_PROJECTION_VERSION =
'LONG_SNAPSHOT_PROGRESS_DERIVED_FROM_CURSOR_V3';
const EXIT_SOURCE_SEPARATION_VERSION =
'LONG_VIRTUAL_SHADOW_EXIT_SEPARATION_V2';

const MARKET_UNIVERSE_KEY =
`${LONG_KEY_PREFIX}MARKET:UNIVERSE:LATEST`;
const MARKET_WEATHER_KEY =
`${LONG_KEY_PREFIX}MARKET:WEATHER:LATEST`;
const SETUP_TYPES = new Set([
'BREAKOUT',
'RETEST',
'SWEEP_REVERSAL',
'CONTINUATION',
'COMPRESSION'
]);
const REGIME_BUCKETS = new Set([
'TREND',
'CHOP',
'SQUEEZE'
]);
const CONFIRMATION_PROFILES = new Set([
'A_STRONG_ALIGN',
'B_FLOW_ALIGN',
'C_VOLUME_ALIGN',
'D_MIXED_OK',
'E_WEAK_CONTRA'
]);
function now() {
return Date.now();
}
function normalizeTimestampMs(value, fallback = now()) {
const numeric = Number(value);
if (!Number.isFinite(numeric) || numeric <= 0) {

const safeFallback = Number(fallback);
return Number.isFinite(safeFallback) && safeFallback > 0
? Math.floor(safeFallback)
: now();
}
return numeric < 10_000_000_000
? Math.floor(numeric * 1000)
: Math.floor(numeric);
}
function isoWeekKeyUtc(timestamp) {
const date = new Date(normalizeTimestampMs(timestamp));
const target = new Date(Date.UTC(
date.getUTCFullYear(),
date.getUTCMonth(),
date.getUTCDate()
));
const day = target.getUTCDay() || 7;
target.setUTCDate(target.getUTCDate() + 4 - day);
const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
const week = Math.ceil((((target - yearStart) / 86_400_000) + 1) / 7);
return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
function buildTemporalContext(value = now()) {
const contextTs = normalizeTimestampMs(value, now());
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
if (inEurope && inUs) primarySessionBucket = 'EU_US_OVERLAP';
else if (inAsia && inEurope) primarySessionBucket = 'ASIA_EU_OVERLAP';
else if (inAsia) primarySessionBucket = 'ASIA';
else if (inEurope) primarySessionBucket = 'EUROPE';
else if (inUs) primarySessionBucket = 'US';
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
offHours: primarySessionBucket === 'OFF_HOURS',
entryDateUtc: date.toISOString().slice(0, 10),
isoWeekUtc: isoWeekKeyUtc(contextTs)
};
}
function parseBooleanFlag(value, fallback = false) {
if (typeof value === 'boolean') return value;
if (value === 1 || value === 0) return value === 1;
const normalized = String(value ?? '').trim().toLowerCase();
if (['1', 'true', 'yes', 'y', 'on', 'enabled'].includes(normalized)) return
true;
if (['0', 'false', 'no', 'n', 'off', 'disabled'].includes(normalized)) return
false;
return Boolean(fallback);
}
function normalizeTemporalPolicyMode(value, fallback = 'OBSERVE') {
const normalized = String(value || '').trim().toUpperCase();
if (TEMPORAL_POLICY_MODES.includes(normalized)) return normalized;
const fallbackMode = String(fallback || 'OBSERVE').trim().toUpperCase();
return TEMPORAL_POLICY_MODES.includes(fallbackMode) ? fallbackMode :
'OBSERVE';
}
function temporalConfigSource() {
const root = typeof CONFIG === 'object' && CONFIG ? CONFIG : {};
return root.long?.temporal || root.temporal?.long || root.temporal || {};
}
function resolveTemporalControls() {
const cfg = temporalConfigSource();
const requestedMode = normalizeTemporalPolicyMode(
cfg.policyMode ?? cfg.mode ??
process.env.LONG_TEMPORAL_POLICY_MODE ??
process.env.TEMPORAL_POLICY_MODE,
'OBSERVE'
);
const temporalStatsEnabled = parseBooleanFlag(
cfg.statsEnabled ?? cfg.enabled ??
process.env.LONG_TEMPORAL_STATS_ENABLED ??
process.env.TEMPORAL_STATS_ENABLED,
true
);
return {
temporalStatsEnabled,

requestedTemporalPolicyMode: requestedMode,
temporalPolicyMode: temporalStatsEnabled ? requestedMode : 'OFF',
temporalConfigurationValid: temporalStatsEnabled || requestedMode ===
'OFF'
};
}
function stripRepeatedOwnEventPrefix(value = '') {
const ownPrefix = 'LONG_EVENT_';
let text = String(value || '').trim();
let stripped = false;
while (text.toUpperCase().startsWith(ownPrefix)) {
text = text.slice(ownPrefix.length);
stripped = true;
}
return { text, stripped };
}
function resolveMarketEventClusterId(row = {}, timestamp = now()) {
const source = row && typeof row === 'object' ? row : {};
const explicit =
source.marketEventClusterId ||
source.scannerRunId ||
source.marketSnapshotId ||
source.snapshotId ||
source.marketCycleId ||
source.scanId ||
null;
if (explicit) {
const safe = String(explicit)
.trim()
.replace(/[^A-Za-z0-9:_-]/g, '_');
const normalized = stripRepeatedOwnEventPrefix(safe);
return `LONG_EVENT_${normalized.text || 'UNKNOWN'}`;
}
const ts = normalizeTimestampMs(timestamp, now());
const hourBucket = Math.floor(ts / 3_600_000) * 3_600_000;
return `LONG_EVENT_HOUR_${new Date(hourBucket).toISOString().slice(0, 13)}:00Z`;
}
function temporalPolicyFlags(value = now()) {
const temporalContext = (
value && typeof value === 'object' &&
value.temporalContextVersion === TEMPORAL_CONTEXT_VERSION
) ? value : buildTemporalContext(value);
const controls = resolveTemporalControls();
return {
...temporalContext,
temporalContext,
...controls,
temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
temporalStatsVersion: TEMPORAL_STATS_VERSION,
temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
temporalAggregationVersion: TEMPORAL_AGGREGATION_VERSION,
temporalGenerationVersion: TEMPORAL_GENERATION_VERSION,
temporalPolicyModes: TEMPORAL_POLICY_MODES,
temporalGateWindowMaxOutcomes: TEMPORAL_GATE_WINDOW_MAX_OUTCOMES,
temporalGateWindowMaxAgeDays: TEMPORAL_GATE_WINDOW_MAX_AGE_DAYS,
temporalVetoMinCompleted: TEMPORAL_VETO_MIN_COMPLETED,
temporalWeekendApprovalMinCompleted:
TEMPORAL_WEEKEND_APPROVAL_MIN_COMPLETED,
temporalGenerationMaxAgeDays: TEMPORAL_GENERATION_MAX_AGE_DAYS,
temporalWeekendFreshnessDays: TEMPORAL_WEEKEND_FRESHNESS_DAYS,
temporalVetoStaleDays: TEMPORAL_VETO_STALE_DAYS,
weekendMode: controls.temporalPolicyMode,
weekendPolicyVersion: WEEKEND_POLICY_VERSION,
weekendLearningAllowed: controls.temporalStatsEnabled,

weekendVirtualEntryAllowed: true,
weekendDiscordEntryAllowed: !temporalContext.isWeekend,
weekendExitMonitoringAllowed: true,
weekendOutcomeRecordingAllowed: controls.temporalStatsEnabled,
weekendPolicyObservedOnly: controls.temporalPolicyMode !== 'ENFORCE',
sessionMode: controls.temporalPolicyMode,
sessionPolicyVersion: SESSION_POLICY_VERSION,
sessionLearningAllowed: controls.temporalStatsEnabled,
sessionVirtualEntryAllowed: true,
sessionDiscordEntryAllowed: true,
sessionPolicyObservedOnly: controls.temporalPolicyMode !== 'ENFORCE',
temporalContextExcludedFromFamilyId: true,
sessionContextExcludedFromFamilyId: true,
symbolExcludedFromTemporalFamilyId: true
};
}
function entryTemporalFields(row = {}) {
const source = row && typeof row === 'object' ? row : {};
const entryTs = normalizeTimestampMs(
source.entryTs ?? source.openedAt ?? source.openTs ??
source.positionOpenedAt ?? source.createdAt ?? source.signalTs ??
source.ts ?? now(),
now()
);
const context = buildTemporalContext(entryTs);
return {
temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
entryTs: context.contextTs,
entryHourUtc: context.hourUtc,
entryDayOfWeekUtc: context.dayOfWeekUtc,
entryDayType: context.dayType,
entryIsWeekend: context.isWeekend,
entrySessionTags: context.sessionTags,
entrySessionBucket: context.primarySessionBucket,
entrySessionOverlap: context.sessionOverlap,
entryOffHours: context.offHours,
entryDateUtc: context.entryDateUtc,
entryIsoWeekUtc: context.isoWeekUtc,
marketEventClusterId: resolveMarketEventClusterId(source, entryTs)
};
}
function exitTemporalFields(row = {}) {
const source = row && typeof row === 'object' ? row : {};
const rawExitTs = source.exitTs ?? source.closedAt ?? source.closeTs ??
source.positionClosedAt ?? source.completedAt ?? source.updatedAt ?? null;
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
exitOffHours: null,
exitDateUtc: null,
exitIsoWeekUtc: null
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
exitOffHours: context.offHours,
exitDateUtc: context.entryDateUtc,
exitIsoWeekUtc: context.isoWeekUtc
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
function safeNumber(
value,
fallback = 0
) {
const number = Number(value);
return Number.isFinite(number)
? number
: fallback;

}
function round(
value,
decimals = 4
) {
return Number(
safeNumber(value, 0)
.toFixed(decimals)
);
}
function upper(value) {
return String(value || '')
.trim()
.toUpperCase();
}
function firstValue(
value,
fallback = null
) {
if (Array.isArray(value)) {
return value[0] ?? fallback;
}
if (
value === undefined ||
value === null ||
value === ''
) {
return fallback;
}
return value;
}
const REQUEST_QUERY_CACHE = new WeakMap();
function requestQuery(req) {
if (!req || typeof req !== 'object') return Object.freeze({});
const cached = REQUEST_QUERY_CACHE.get(req);
if (cached) return cached;
let query = {};
try {
const parsed = new URL(
String(req.url || '/'),
'http://localhost'
);
query = Object.fromEntries(parsed.searchParams.entries());
} catch {
query = {};
}
const frozen = Object.freeze(query);

REQUEST_QUERY_CACHE.set(req, frozen);
return frozen;
}
function queryValue(req, key, fallback = null) {
return firstValue(requestQuery(req)?.[key], fallback);
}
function isTrue(value) {
if (
value === true ||
value === 1
) {
return true;
}
return [
'true',
'1',
'yes',
'y',
'on',
'force',
'forced'
].includes(
String(value ?? '')
.trim()
.toLowerCase()
);
}
function callMaybeKey(
value,
fallback = null
) {
if (typeof value !== 'function') {
return value || fallback;
}
try {
return value();
} catch {
return fallback;
}
}
function namespacedLongKey(
value,
fallback = null
) {
let key = String(
callMaybeKey(
value,

fallback
) || ''
).trim();
if (!key) {
return null;
}
if (
key.startsWith(
LONG_KEY_PREFIX
)
) {
return key;
}
if (key.startsWith('SHORT:')) {
key = key.slice(
'SHORT:'.length
);
}
return `${LONG_KEY_PREFIX}${key}`;
}
function resolveTradeLockKey() {
if (
typeof LockApi.normalizeLongLockKey ===
'function'
) {
return LockApi.normalizeLongLockKey(
TRADE_LOCK_RESOURCE
);
}
return (
`${LONG_KEY_PREFIX}` +
`LOCK:${TRADE_LOCK_RESOURCE}`
);
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
lock:
resolveTradeLockKey(),
legacyConfiguredLock:

namespacedLongKey(
KEYS.long?.trade?.lock ||
KEYS.trade?.longLock ||
KEYS.trade?.lock,
'TRADE:LOCK'
),
runMeta:
namespacedLongKey(
KEYS.long?.trade?.runMeta ||
KEYS.trade?.longRunMeta ||
KEYS.trade?.runMeta,
'TRADE:RUN_META'
),
lastProcessedSnapshot:
namespacedLongKey(
KEYS.long?.trade
?.lastProcessedSnapshot ||
KEYS.trade
?.longLastProcessedSnapshot ||
KEYS.trade
?.lastProcessedSnapshot,
'TRADE:LAST_PROCESSED_SNAPSHOT'
)
},
temporal: {
activeGenerationId: namespacedLongKey(
KEYS.long?.analyze?.activeTemporalGenerationId ||
KEYS.analyze?.longActiveTemporalGenerationId,
'ANALYZE:TEMPORAL:ACTIVE_GENERATION_ID'
),
nextGenerationId: namespacedLongKey(
KEYS.long?.analyze?.nextTemporalGenerationId ||
KEYS.analyze?.longNextTemporalGenerationId,
'ANALYZE:TEMPORAL:NEXT_GENERATION_ID'
),
generation: (generationId) => namespacedLongKey(
null,
`ANALYZE:TEMPORAL:GENERATION:${generationId}`
)
}
};
function getPositionTimeStopMin() {
const value = Number(
CONFIG.long?.trade
?.positionTimeStopMin ??
CONFIG.trade
?.longPositionTimeStopMin ??

CONFIG.trade
?.positionTimeStopMin ??
DEFAULT_POSITION_TIME_STOP_MIN
);
return (
Number.isFinite(value) &&
value > 0
)
? Math.floor(value)
: DEFAULT_POSITION_TIME_STOP_MIN;
}
function getLockTtlSec() {
const value = Number(
CONFIG.long?.trade?.lockTtlSec ??
CONFIG.trade?.longLockTtlSec ??
CONFIG.trade?.lockTtlSec ??
DEFAULT_LOCK_TTL_SEC
);
if (
!Number.isFinite(value) ||
value <= 0
) {
return DEFAULT_LOCK_TTL_SEC;
}
return Math.max(
5,
Math.min(
55,
Math.floor(value)
)
);
}
function getRuntimeBudgetMs() {
const value = Number(
CONFIG.long?.trade
?.runtimeBudgetMs ??
CONFIG.trade?.runtimeBudgetMs ??
DEFAULT_RUNTIME_BUDGET_MS
);
if (
!Number.isFinite(value) ||
value < 5000
) {
return DEFAULT_RUNTIME_BUDGET_MS;
}
return Math.min(
MAX_RUNTIME_BUDGET_MS,

Math.floor(value)
);
}
function getResponseRowLimit(
req,
body = {}
) {
const value = Number(
firstValue(
queryValue(req, 'responseRowLimit'),
body.responseRowLimit
)
);
if (
!Number.isFinite(value) ||
value <= 0
) {
return DEFAULT_RESPONSE_ROW_LIMIT;
}
return Math.max(
10,
Math.min(
MAX_RESPONSE_ROW_LIMIT,
Math.floor(value)
)
);
}
function isolationFlags() {
return {
runScope:
RUN_SCOPE,
writeScope:
WRITE_SCOPE,
readScope:
READ_SCOPE,
adminPageIsolation:
true,
doesNotOverwriteOtherAdminPages:
true,
scannerPreloadBeforeTrade:
true,
scannerPreloadMode:
'READ_EXISTING_LATEST',
readsScannerLatest:
true,
scannerLatestReadOnlyInsideTradeSystem:
true,

preserveScannerLatest:
true,
preserveScannerSnapshot:
true,
preserveScannerHistory:
true,
scannerRunAllowed:
false,
scannerRunBeforeTrade:
false,
scannerRunDisabledInsideTradeSystem:
true,
noInternalScannerRunInsideTradeSystem:
true,
writesScanner:
false,
writesScannerLatest:
false,
writesScannerSnapshot:
false,
writesScannerHistory:
false,
writesMarketUniverse:
false,
writesMarketWeather:
false,
writesTrade:
true,
writesTradeRunMeta:
true,
writesTradePositions:
true,
writesAnalyze:
true,
writesAnalyzePartial:
true,
writesMicroFamilies:
true,
microFamiliesAppendOnly:
true,
microFamiliesAntiWipe:
true,
analyzePartialOnly:
true,
analyzeFullOverwriteDisabled:
true,
writesRotation:

false,
writesDiscordSelection:
false,
writesManualSelection:
false,
preserveRotation:
true,
preserveManualSelection:
true,
preserveDiscordSelection:
true,
noResetCron:
true,
noActivateCron:
true,
noFreezeCron:
true,
autoRotationActivationDisabled:
true,
ignoreGlobalMaxOpenPositions:
true,
noGlobalMaxOpenPositionsBlock:
true,
maxOneOpenPositionPerSymbol:
true,
oneOpenPositionPerSymbol:
true
};
}
function baseFlags() {
return {
...temporalPolicyFlags(),
targetTradeSide:
TARGET_TRADE_SIDE,
dashboardSide:
TARGET_DASHBOARD_SIDE,
scannerSide:
TARGET_SCANNER_SIDE,
oppositeTradeSide:
OPPOSITE_TRADE_SIDE,
side:
TARGET_DASHBOARD_SIDE,
tradeSide:
TARGET_TRADE_SIDE,
positionSide:
TARGET_TRADE_SIDE,
direction:

TARGET_TRADE_SIDE,
actualScannerSide:
TARGET_SCANNER_SIDE,
analysisSide:
TARGET_TRADE_SIDE,
longOnly:
true,
shortDisabled:
true,
shortOnly:
false,
longDisabled:
false,
virtualOnly:
true,
virtualLearning:
true,
virtualLearningForced:
true,
virtualTracked:
true,
source:
'VIRTUAL',
outcomeSource:
'VIRTUAL',
realTrade:
false,
realOrder:
false,
exchangeOrder:
false,
bitgetOrderPlaced:
false,
realOrdersDisabled:
true,
exchangeOrdersDisabled:
true,
bitgetOrdersDisabled:
true,
exchangeCallsDisabled:
true,
noExchangeOrders:
true,
noRealOrders:
true,
learningOnly:
true,

microFamilyLearning:
true,
observationFirst:
true,
completedDefinition:
'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
scoringRSource:
'netR',
winsLossesFlatsSource:
'netR',
winrateDefinition:
'netR > 0',
avgRSource:
'netR',
totalRSource:
'netR',
avgCostRShown:
true,
scannerFingerprintRole:
'METADATA_ONLY',
scannerFingerprintsMetadataOnly:
true,
scannerFingerprintsUsedAsLearningFamily:
false,
scannerBucketsMetadataOnly:
true,
legacy25BucketsMetadataOnly:
true,
executionFingerprintRole:
'METADATA_ONLY',
executionFingerprintsMetadataOnly:
true,
executionFingerprintsUsedAsLearningFamily:
false,
analyzeMicroFamiliesOnly:
true,
learningIdentitySource:
'ANALYZE_TRUE_MICRO_FAMILY',
trueMicroOnly:
true,
exactTrueMicroOnly:
true,
exactTrueMicroFamilyRequired:
true,
trueMicroFamilySchema:
TRUE_MICRO_SCHEMA,
parentTrueMicroFamilySchema:

PARENT_TRUE_MICRO_SCHEMA,
learningGranularity:
LEARNING_GRANULARITY,
parentLearningGranularity:
PARENT_LEARNING_GRANULARITY,
selectionGranularity:
'EXACT_75_CHILD',
symbolExcludedFromFamilyId:
true,
positionTimeStopMin:
getPositionTimeStopMin(),
riskGeometryRule:
'LONG: sl < entry < tp',
tpHitRule:
'LONG: price >= tp',
slHitRule:
'LONG: price <= sl',
grossRFormula:
'(exitPrice - entry) / (entry - initialSl)',
currentRFormula:
'(currentPrice - entry) / (entry - initialSl)',
currentFitPolarity:
'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition:
'LONG_MIRRORED_CURRENT_FIT',
currentFitSoftOnly:
true,
currentFitBlocksLearning:
false,
discordOnlyForSelectedMicroFamilies:
true,
discordOnlyForManualSelection:
true,
discordOnlyForExactTrueMicroMatch:
true,
manualSelectionMatchMode:
'EXACT_TRUE_MICRO_FAMILY_ID',
manualSelectionRequires75ChildTrueMicroFamilyId:
true,
persistentLearningKey:
PERSISTENT_LEARNING_KEY,
redisNamespace:
LONG_NAMESPACE,
redisKeyPrefix:
LONG_KEY_PREFIX,
redisKeysSeparatedFromShortRoot:
true,

shortRootTouched:
false,
...isolationFlags()
};
}
function parseJson(text) {
const raw =
String(text || '').trim();
if (!raw) {
return {};
}
try {
return JSON.parse(raw);
} catch {
const error =
new Error(
'INVALID_JSON_BODY'
);
error.statusCode = 400;
throw error;
}
}
async function readBody(req) {
if (req.method === 'GET') {
return {};
}
if (req.body) {
if (
typeof req.body === 'string'
) {
return parseJson(req.body);
}
if (
Buffer.isBuffer(req.body)
) {
return parseJson(
req.body.toString('utf8')
);
}
return req.body;
}
const chunks = [];
for await (const chunk of req) {
chunks.push(
Buffer.isBuffer(chunk)
? chunk
: Buffer.from(chunk)

);
}
return parseJson(
Buffer.concat(chunks)
.toString('utf8')
);
}
function shouldForceProcessSnapshot(
req,
body = {}
) {
return (
isTrue(
firstValue(
queryValue(req, 'force'),
false
)
) ||
isTrue(
firstValue(
queryValue(req, 'forced'),
false
)
) ||
isTrue(
firstValue(
queryValue(req, 'forceProcessSnapshot'),
false
)
) ||
isTrue(
firstValue(
queryValue(req, 'force_process_snapshot'),
false
)
) ||
isTrue(body.force) ||
isTrue(body.forced) ||
isTrue(
body.forceProcessSnapshot
) ||
isTrue(
body.force_process_snapshot
)
);
}
function shouldRestartSnapshotProgress(req, body = {}) {
return (
isTrue(firstValue(queryValue(req, 'restartSnapshot'), false)) ||
isTrue(firstValue(queryValue(req, 'restart_snapshot'), false)) ||
isTrue(firstValue(queryValue(req, 'resetSnapshotProgress'), false)) ||
isTrue(firstValue(queryValue(req, 'reset_snapshot_progress'), false)) ||
isTrue(body.restartSnapshot) ||
isTrue(body.restart_snapshot) ||
isTrue(body.resetSnapshotProgress) ||
isTrue(body.reset_snapshot_progress)
);
}
function shouldMonitorOnly(

req,
body = {}
) {
return (
isTrue(
firstValue(
queryValue(req, 'monitorOnly'),
false
)
) ||
isTrue(
firstValue(
queryValue(req, 'monitor_only'),
false
)
) ||
isTrue(body.monitorOnly) ||
isTrue(body.monitor_only)
);
}
function getRunSource(
req,
body = {}
) {
const manual =
isTrue(
firstValue(
queryValue(req, 'manual'),
false
)
) ||
shouldForceProcessSnapshot(
req,
body
) ||
isTrue(body.manual);
return manual
? 'ADMIN_MANUAL_LONG_TRADE_RUN_FROM_EXISTING_SCANNER_SNAPSHOT'
: 'CRON_OR_API_LONG_TRADE_RUN_FROM_EXISTING_SCANNER_SNAPSHOT';
}
function cleanSideText(value = '') {
return upper(value)
.replaceAll(
'SHORT_DISABLED_LONG_ONLY',
'LONG'
)
.replaceAll(

'SHORT_DISABLED',
'LONG'
)
.replaceAll(
'SHORTDISABLED',
'LONG'
)
.replaceAll(
'LONG_DISABLED_SHORT_ONLY',
'SHORT'
)
.replaceAll(
'LONG_DISABLED',
'SHORT'
)
.replaceAll(
'LONGDISABLED',
'SHORT'
)
.replaceAll(
'SHORT_ONLY_MODE',
'SHORT'
)
.replaceAll(
'SHORT_ONLY',
'SHORT'
)
.replaceAll(
'SHORT-ONLY',
'SHORT'
)
.replaceAll(
'LONG_ONLY_MODE',
'LONG'
)
.replaceAll(
'LONG_ONLY',
'LONG'
)
.replaceAll(
'LONG-ONLY',
'LONG'
);
}
function normalizeTradeSide(value) {
const raw =
cleanSideText(value);

if (!raw) {
return 'UNKNOWN';
}
const converted =
sideToTradeSide(raw);
if (
converted ===
TARGET_TRADE_SIDE
) {
return TARGET_TRADE_SIDE;
}
if (
converted ===
OPPOSITE_TRADE_SIDE
) {
return OPPOSITE_TRADE_SIDE;
}
if (
[
'LONG',
'BULL',
'BULLISH',
'BUY',
'UP'
].includes(raw)
) {
return TARGET_TRADE_SIDE;
}
if (
[
'SHORT',
'BEAR',
'BEARISH',
'SELL',
'DOWN'
].includes(raw)
) {
return OPPOSITE_TRADE_SIDE;
}
if (
raw.includes(
'MICRO_LONG_'
)
) {
return TARGET_TRADE_SIDE;
}
if (

raw.includes(
'MICRO_SHORT_'
)
) {
return OPPOSITE_TRADE_SIDE;
}
return 'UNKNOWN';
}
function inferActionTradeSide(
row = {}
) {
if (
typeof row === 'string'
) {
return normalizeTradeSide(row);
}
if (
!row ||
typeof row !== 'object'
) {
return 'UNKNOWN';
}
const direct = [
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
for (const value of direct) {
const side =
normalizeTradeSide(value);
if (
side !== 'UNKNOWN'
) {
return side;
}
}
const text = [
row.trueMicroFamilyId,
row.microFamilyId,

row.analyzeMicroFamilyId,
row.parentTrueMicroFamilyId,
row.scannerMicroFamilyId,
row.executionMicroFamilyId,
row.familyId,
row.id,
row.key,
row.scannerReason,
row.reason,
row.exitReason,
row.definition,
...(
Array.isArray(
row.definitionParts
)
? row.definitionParts
: []
)
]
.map(
(item) =>
String(item || '').trim()
)
.filter(Boolean)
.join('|');
const inferred =
normalizeTradeSide(text);
if (
inferred !== 'UNKNOWN'
) {
return inferred;
}
if (
row.longOnly === true ||
row.shortDisabled === true
) {
return TARGET_TRADE_SIDE;
}
if (
row.shortOnly === true ||
row.longDisabled === true
) {
return OPPOSITE_TRADE_SIDE;
}
return 'UNKNOWN';
}
function isLongAction(

row = {}
) {
return (
inferActionTradeSide(row) !==
OPPOSITE_TRADE_SIDE
);
}
function isShortAction(
row = {}
) {
return (
inferActionTradeSide(row) ===
OPPOSITE_TRADE_SIDE
);
}
function parseTaxonomyId(
id = ''
) {
const match =
/^MICRO_LONG_([A-Z_]+)_(TREND|CHOP|SQUEEZE)(?:_(A_STRONG_ALIGN|B_FLOW_ALIGN|C_VOLUME_ALIGN|D_MIXED_OK|E_WEAK_CONTRA))?$/
.exec(upper(id));
if (!match) {
return null;
}
const setup =
match[1];
const regime =
match[2];
const confirmation =
match[3] || null;
if (
!SETUP_TYPES.has(setup)
) {
return null;
}
if (
!REGIME_BUCKETS.has(regime)
) {
return null;
}
if (
confirmation &&
!CONFIRMATION_PROFILES
.has(confirmation)
) {
return null;

}
const parent =
`MICRO_LONG_${setup}_${regime}`;
return {
parent,
child:
confirmation
? `${parent}_${confirmation}`
: null,
isParent:
!confirmation,
isChild:
Boolean(confirmation)
};
}
function normalizeLearningIdentity(
row = {}
) {
const childCandidates = [
row.trueMicroFamilyId,
row.learningMicroFamilyId,
row.analyzeMicroFamilyId,
row.childTrueMicroFamilyId,
row.microFamilyId
];
let child = null;
for (
const value
of childCandidates
) {
const parsed =
parseTaxonomyId(value);
if (parsed?.isChild) {
child = parsed.child;
break;
}
}
const childParsed =
parseTaxonomyId(child);
const parent =
childParsed?.parent ||
null;
return {
microFamilyId:
child,
trueMicroFamilyId:
child,

analyzeMicroFamilyId:
child,
learningMicroFamilyId:
child,
childTrueMicroFamilyId:
child,
parentTrueMicroFamilyId:
parent,
parentMicroFamilyId:
parent,
parentMacroFamilyId:
parent,
macroFamilyId:
parent,
coarseMicroFamilyId:
parent,
trueMicroFamilySchema:
child
? TRUE_MICRO_SCHEMA
: null,
parentTrueMicroFamilySchema:
parent
? PARENT_TRUE_MICRO_SCHEMA
: null,
learningGranularity:
LEARNING_GRANULARITY,
parentLearningGranularity:
PARENT_LEARNING_GRANULARITY
};
}
function normalizeExitMath(
row = {}
) {
const entry =
safeNumber(
row.entry ??
row.entryPrice,
0
);
const initialSl =
safeNumber(
row.initialSl ??
row.initialStopLoss ??
row.sl ??
row.stopLoss,
0
);

const exitPrice =
safeNumber(
row.exitPrice ??
row.currentPrice ??
row.lastPrice ??
row.price,
0
);
const currentPrice =
safeNumber(
row.currentPrice ??
row.lastPrice ??
row.price ??
exitPrice,
0
);
const tp =
safeNumber(
row.tp ??
row.takeProfit,
0
);
const risk =
entry > 0 &&
initialSl > 0 &&
initialSl < entry
? entry - initialSl
: 0;
const grossR =
risk > 0
? (
exitPrice -
entry
) / risk
: safeNumber(
row.longGrossR ??
row.grossR,
0
);
const currentR =
risk > 0
? (
currentPrice -
entry
) / risk
: safeNumber(
row.longCurrentR ??

row.currentR,
0
);
const netR =
safeNumber(
row.longNetR ??
row.netLongR ??
row.netR ??
row.r ??
row.realizedR ??
grossR,
grossR
);
return {
entry:
round(entry, 10),
initialSl:
round(initialSl, 10),
sl:
round(
row.sl ??
row.stopLoss ??
initialSl,
10
),
tp:
round(tp, 10),
exitPrice:
round(exitPrice, 10),
currentPrice:
round(currentPrice, 10),
validLongGeometry:
tp > 0 &&
entry > 0 &&
initialSl > 0 &&
initialSl < entry &&
entry < tp,
longTpHit:
exitPrice > 0 &&
tp > 0 &&
exitPrice >= tp,
longSlHit:
exitPrice > 0 &&
initialSl > 0 &&
exitPrice <= initialSl,
grossR:
round(grossR, 4),

currentR:
round(currentR, 4),
netR:
round(netR, 4),
r:
round(netR, 4),
realizedR:
round(
row.realizedR ??
netR,
4
),
costR:
round(
row.costR ??
row.totalCostR,
4
)
};
}
function isFinalizedExitRow(row = {}, forcedAction = null) {
const action = String(
forcedAction ||
row.action ||
row.type ||
''
).trim().toUpperCase();
return (
action === 'VIRTUAL_EXIT' ||
action === 'SHADOW_EXIT' ||
action === 'EXIT' ||
Boolean(
row.closedAt ||
row.completedAt ||
row.exitTs ||
row.outcomeFinal === true ||
row.realized === true
)
);
}
function normalizeOpenMath(row = {}, forcedAction = null) {
const entry = safeNumber(row.entry ?? row.entryPrice, 0);
const initialSl = safeNumber(
row.initialSl ??
row.initialStopLoss ??
row.sl ??
row.stopLoss,
0
);
const tp = safeNumber(row.tp ?? row.takeProfit, 0);
const currentPrice = safeNumber(
row.currentPrice ??
row.lastPrice ??
row.price ??
entry,
entry
);
const risk =
entry > 0 &&
initialSl > 0 &&
tp > 0 &&
initialSl < entry && entry < tp
? entry - initialSl
: 0;
const currentR =
risk > 0
? (currentPrice - entry) / risk
: safeNumber(
row.longCurrentR ??
row.currentR ??
row.unrealizedR,
0
);
const action = String(
forcedAction ||
row.action ||
row.type ||
''
).trim().toUpperCase();
const reason = String(row.reason || '').trim().toUpperCase();
const openLike =
action === 'VIRTUAL_ENTRY' ||
action === 'ENTRY' ||
String(row.status || '').trim().toUpperCase() === 'OPEN' ||
reason.includes('ALREADY_OPEN');
return {
entry: round(entry, 10),
initialSl: round(initialSl, 10),
sl: round(row.sl ?? row.stopLoss ?? initialSl, 10),
tp: round(tp, 10),
currentPrice: round(currentPrice, 10),
validLongGeometry:
tp > 0 &&
entry > 0 &&
initialSl > 0 &&
initialSl < entry && entry < tp,
currentR: round(currentR, 4),
longCurrentR: round(currentR, 4),
unrealizedR: round(currentR, 4),
estimatedCostR: round(
row.estimatedCostR ??
row.costR ??
row.avgCostR,
4
),
status: openLike ? 'OPEN' : 'WAIT',
outcomeFinal: false,
realized: false,
unrealized: openLike
};
}
function compactTradeRow(
row = {},
forcedAction = null
) {
if (
!row ||
typeof row !== 'object'
) {
return null;
}
const identity = normalizeLearningIdentity(row);
const action =
forcedAction ||
row.action ||
row.type ||
null;
const finalized = isFinalizedExitRow(row, action);
const lifecycleMath = finalized
? normalizeExitMath(row)
: normalizeOpenMath(row, action);
const temporalFields = finalized
? {
...entryTemporalFields(row),
...exitTemporalFields(row)
}
: entryTemporalFields(row);
return {
action,
reason:
row.reason ||
row.exitReason ||
row.skipReason ||
null,
error:
row.error ||
row.createError ||
row.persistError ||
null,
symbol:
row.symbol ||
row.contractSymbol ||
null,
contractSymbol:
row.contractSymbol ||
row.symbol ||
null,
baseSymbol:
row.baseSymbol ||
null,
side:
TARGET_DASHBOARD_SIDE,
tradeSide:
TARGET_TRADE_SIDE,
positionSide:
TARGET_TRADE_SIDE,
direction:
TARGET_TRADE_SIDE,
...identity,
...lifecycleMath,
...temporalFields,
currentFit:
row.currentFit ||
row.currentFitLabel ||
null,
currentFitScore:
round(
row.currentFitScore ??
row.fitScore,
4
),
selectedMicroFamilyAlert:
Boolean(
row.selectedMicroFamilyAlert &&
identity.trueMicroFamilyId
),
discordAlertEligible:
Boolean(
row.discordAlertEligible &&
row.selectedMicroFamilyAlert &&
identity.trueMicroFamilyId
),
source:
String(row.source || 'VIRTUAL').toUpperCase(),
outcomeSource:
String(row.outcomeSource || row.source || 'VIRTUAL').toUpperCase(),
virtualOnly:
true,
realTrade:
false,
realOrder:
false,
createdAt:
row.createdAt ||
row.openedAt ||
null,
closedAt:
finalized
? (
row.closedAt ||
row.completedAt ||
row.exitTs ||
null
)
: null,
tradeResponseContractVersion:
TRADE_RESPONSE_CONTRACT_VERSION,
marketEventClusterCanonicalizationVersion:
API_MARKET_EVENT_CLUSTER_CANONICALIZATION_VERSION
};
}
function compactRows(
rows = [],
limit = DEFAULT_RESPONSE_ROW_LIMIT,
action = null
) {
return (
Array.isArray(rows)
? rows
: []
)
.filter(isLongAction)
.slice(0, limit)
.map(
(row) =>
compactTradeRow(
row,
action
)
)
.filter(Boolean);
}
function firstArray(
payload,
names = []
) {
for (const name of names) {
if (
Array.isArray(
payload?.[name]
)
) {
return payload[name];
}
}

return [];
}
function compactPrimitiveObject(
value = {},
limit = 100
) {
if (
!value ||
typeof value !== 'object' ||
Array.isArray(value)
) {
return {};
}
const result = {};
for (
const [key, item]
of Object.entries(value)
.slice(0, limit)
) {
if (
item === null ||
typeof item === 'string' ||
typeof item === 'number' ||
typeof item === 'boolean'
) {
result[key] = item;
}
}
return result;
}
function compactIdList(
value = [],
limit = MAX_ID_LIST
) {
return [
...new Set(
(
Array.isArray(value)
? value
: [value]
)
.flat(Infinity)
.map(
(item) =>
String(item || '')
.trim()
)

.filter(Boolean)
)
].slice(0, limit);
}
function countActions(
rows = []
) {
return (
Array.isArray(rows)
? rows
: []
).reduce(
(result, row) => {
const key =
row?.action ||
row?.type ||
'UNKNOWN';
result[key] =
safeNumber(
result[key],
0
) + 1;
return result;
},
{}
);
}
function mergeCounts(
...objects
) {
return objects.reduce(
(result, object) => {
for (
const [key, value]
of Object.entries(
object || {}
)
) {
result[key] =
safeNumber(
result[key],
0
) +
safeNumber(
value,
0
);

}
return result;
},
{}
);
}
function compactMarketWeather(
weather = null
) {
if (
!weather ||
typeof weather !== 'object'
) {
return null;
}
return {
ok:
weather.ok !== false,
available:
weather.available !== false,
version:
weather.version ||
null,
source:
weather.source ||
null,
snapshotId:
weather.snapshotId ||
null,
generatedAt:
weather.generatedAt ||
null,
updatedAt:
weather.updatedAt ||
null,
currentRegime:
weather.currentRegime ||
weather.regime ||
null,
currentTrendSide:
weather.currentTrendSide ||
weather.trendSide ||
null,
currentFlow:
weather.currentFlow ||
weather.flow ||
null,

currentVolatilityState:
weather.currentVolatilityState ||
weather.volatilityState ||
null,
confidence:
safeNumber(
weather.confidence ??
weather.weatherConfidence,
0
),
bearishCount:
safeNumber(
weather.bearishCount,
0
),
bullishCount:
safeNumber(
weather.bullishCount,
0
),
neutralCount:
safeNumber(
weather.neutralCount,
0
),
squeezeCount:
safeNumber(
weather.squeezeCount,
0
),
bearishPct:
safeNumber(
weather.bearishPct,
0
),
bullishPct:
safeNumber(
weather.bullishPct,
0
),
neutralPct:
safeNumber(
weather.neutralPct,
0
),
squeezePct:
safeNumber(

weather.squeezePct,
0
),
avgAtrPct:
safeNumber(
weather.avgAtrPct,
0
),
avgRangePct:
safeNumber(
weather.avgRangePct,
0
),
avgRealizedVolPct:
safeNumber(
weather.avgRealizedVolPct,
0
),
avgVolumeExpansion:
safeNumber(
weather.avgVolumeExpansion,
0
),
count:
safeNumber(
weather.count ??
weather.universeCount,
0
),
universeCount:
safeNumber(
weather.universeCount ??
weather.count,
0
),
symbols:
compactIdList(
weather.symbols,
40
),
rowsExcluded:
true
};
}
function sanitizeRunPayload(
payload = {},
rowLimit = DEFAULT_RESPONSE_ROW_LIMIT

) {
const rawActions =
Array.isArray(
payload.actions
)
? payload.actions
: [];
const rawVirtualExits =
firstArray(
payload,
[
'virtualExits',
'exits',
'closedPositions',
'outcomes'
]
);
const rawShadowExits =
Array.isArray(payload.shadowExits)
? payload.shadowExits
: [];
const rawEntries =
firstArray(
payload,
[
'entryRows',
'entries',
'virtualCreatedRows',
'shadowCreatedRows'
]
);
const rawWaits =
firstArray(
payload,
[
'waitRows',
'waits'
]
);
const longActions =
rawActions.filter(
isLongAction
);
const longVirtualExits =
rawVirtualExits
.filter(
isLongAction
)
.filter(
(row) =>
String(
row?.outcomeSource ||
row?.source ||
'VIRTUAL'
).trim().toUpperCase() !== 'SHADOW'
);
const longShadowExits =
rawShadowExits
.filter(
isLongAction
)
.filter(
(row) =>
String(
row?.outcomeSource ||
row?.source ||
''
).trim().toUpperCase() === 'SHADOW'
);
const entriesSource =
rawEntries.length
? rawEntries

: longActions.filter(
(row) => (
row?.action ===
'VIRTUAL_ENTRY' ||
row?.action ===
'ENTRY'
)
);
const waitsSource =
rawWaits.length
? rawWaits
: longActions.filter(
(row) =>
row?.action ===
'WAIT'
);
const activeMicroFamilyIds =
compactIdList(
payload.activeMicroFamilyIds ||
payload.selectedMicroFamilyIds ||
[],
MAX_ID_LIST
).filter(
(id) =>
parseTaxonomyId(id)
?.isChild === true
);
const selectedMicroFamilyIds =
compactIdList(
payload.selectedMicroFamilyIds ||
payload.activeMicroFamilyIds ||
[],
MAX_ID_LIST
).filter(
(id) =>
parseTaxonomyId(id)
?.isChild === true
);
const activeMacroFamilyIds =
compactIdList(
payload.activeMacroFamilyIds ||
payload.selectedMacroFamilyIds ||
[],
MAX_ID_LIST
).filter(
(id) =>
parseTaxonomyId(id)

?.isParent === true
);
const selectedMacroFamilyIds =
compactIdList(
payload.selectedMacroFamilyIds ||
payload.activeMacroFamilyIds ||
[],
MAX_ID_LIST
).filter(
(id) =>
parseTaxonomyId(id)
?.isParent === true
);
const actions =
compactRows(
longActions,
rowLimit
);
const entryRowsList =
compactRows(
entriesSource,
rowLimit,
'VIRTUAL_ENTRY'
);
const waitRowsList =
compactRows(
waitsSource,
rowLimit,
'WAIT'
);
const virtualExits =
compactRows(
longVirtualExits,
rowLimit,
'VIRTUAL_EXIT'
);
const shadowExits =
compactRows(
longShadowExits,
rowLimit,
'SHADOW_EXIT'
);
return {
ok:
payload.ok !== false,
runId:
payload.runId ||
null,
startedAt:
payload.startedAt ||
null,
completedAt:
payload.completedAt ||

now(),
durationMs:
safeNumber(
payload.durationMs,
0
),
snapshotId:
payload.snapshotId ||
null,
snapshotCreatedAt:
payload.snapshotCreatedAt ||
null,
snapshotAgeSec:
safeNumber(
payload.snapshotAgeSec,
0
),
candidateStartIndex: safeNumber(payload.candidateStartIndex, 0),
candidateEndExclusive: safeNumber(payload.candidateEndExclusive, 0),
nextCandidateIndex: safeNumber(payload.nextCandidateIndex, 0),
snapshotCandidateCount: safeNumber(payload.snapshotCandidateCount, 0),
batchCandidateCount: safeNumber(payload.batchCandidateCount, 0),
batchNumber: safeNumber(payload.batchNumber, 0),
batchProcessingComplete: payload.batchProcessingComplete === true,
snapshotProcessingComplete: payload.snapshotProcessingComplete === true,
snapshotContinuation: payload.snapshotContinuation === true,
snapshotProgressAdvanced:
payload.snapshotProgressAdvanced === true ||
safeNumber(payload.nextCandidateIndex, 0) >
safeNumber(payload.candidateStartIndex, 0),
noProgressRetryCount: safeNumber(payload.noProgressRetryCount, 0),
entryProcessingIncomplete: payload.entryProcessingIncomplete === true,
entryProcessingStoppedAtIndex:
payload.entryProcessingIncomplete === true
? safeNumber(payload.entryProcessingStoppedAtIndex, 0)
: null,
selectedSnapshotSource:
payload.selectedSnapshotSource ||
null,
selectedSnapshotReason:
payload.selectedSnapshotReason ||
null,
skipped:
Boolean(
payload.skipped ||
payload.skippedNewEntries
),
skippedNewEntries:
Boolean(
payload.skippedNewEntries
),
reason:
payload.reason ||
payload.skipReason ||
null,
skipReason:
payload.skipReason ||
payload.reason ||
null,
candidates:
safeNumber(
payload.candidates ??
payload.candidatesCount,
0
),
candidatesCount:

safeNumber(
payload.candidatesCount ??
payload.candidates,
0
),
longCandidateCount:
safeNumber(
payload.longCandidateCount ??
payload.targetCandidateCount,
0
),
nonLongCandidateCount:
safeNumber(
payload.nonLongCandidateCount ??
payload.nonTargetCandidateCount,
0
),
processed:
safeNumber(
payload.processed,
0
),
earlyActions:
safeNumber(
payload.earlyActions,
0
),
liveRows:
safeNumber(
payload.liveRows,
0
),
analyzeInputRows:
safeNumber(
payload.analyzeInputRows,
0
),
observationOnlyRows:
safeNumber(
payload.observationOnlyRows,
0
),
selectedTargetCandidateCount:
safeNumber(
payload.selectedTargetCandidateCount,
0
),

selectedOppositeCandidateCount:
0,
entryRows:
safeNumber(
Array.isArray(
payload.entryRows
)
? entriesSource.length
: payload.entryRows,
entriesSource.length
),
waitRows:
safeNumber(
Array.isArray(
payload.waitRows
)
? waitsSource.length
: payload.waitRows,
waitsSource.length
),
virtualCreatedRows:
safeNumber(
Array.isArray(
payload.virtualCreatedRows
)
? payload
.virtualCreatedRows
.length
: payload
.virtualCreatedRows,
entriesSource.length
),
virtualSkippedRows:
safeNumber(
payload.virtualSkippedRows,
0
),
virtualFailedRows:
safeNumber(
payload.virtualFailedRows,
0
),
actions,
actionsCount:
longActions.length,
responseActionsTruncated:
longActions.length >

actions.length,
entryRowsList,
waitRowsList,
virtualCreatedRowsList:
entryRowsList,
virtualExits,
shadowExits,
realExits:
[],
virtualExitRows:
longVirtualExits.length,
shadowExitRows:
longShadowExits.length,
realExitRows:
0,
responseExitsTruncated:
longVirtualExits.length >
virtualExits.length ||
longShadowExits.length >
shadowExits.length,
actionCounts:
mergeCounts(
compactPrimitiveObject(
payload.actionCounts,
100
),
countActions(
longActions
),
countActions(
[
...longVirtualExits.map(
(row) => ({
...row,
action:
'VIRTUAL_EXIT'
})
),
...longShadowExits.map(
(row) => ({
...row,
action:
'SHADOW_EXIT'
})
)
]
)
),
ignoredShortActions:
rawActions.filter(
isShortAction
).length,
ignoredShortExitRows:
[
...rawVirtualExits,
...rawShadowExits
].filter(
isShortAction
).length,
activeRotationId:

payload.activeRotationId ||
null,
selectedRotationId:
payload.selectedRotationId ||
payload.activeRotationId ||
null,
activeMicroFamilyIds,
selectedMicroFamilyIds,
activeMacroFamilyIds,
selectedMacroFamilyIds,
activeMicroFamilies:
activeMicroFamilyIds.length,
activeMacroFamilies:
activeMacroFamilyIds.length,
currentMarketWeather:
compactMarketWeather(
payload.currentMarketWeather ||
payload.marketWeather
),
warnings:
compactIdList(
payload.warnings,
MAX_WARNING_LIST
),
fullPayloadExcluded:
true,
candidateRowsExcluded:
true,
candleDataExcluded:
true,
scannerRowsExcluded:
true,
marketWeatherRowsExcluded:
true,
...baseFlags()
};
}
function compactForPersistence(
payload = {}
) {
return {
ok:
payload.ok !== false,
skipped:
Boolean(
payload.skipped ||
payload.skippedNewEntries

),
reason:
payload.reason ||
payload.skipReason ||
null,
skipReason:
payload.skipReason ||
null,
runId:
payload.runId ||
null,
startedAt:
payload.startedAt ||
null,
completedAt:
payload.completedAt ||
now(),
durationMs:
safeNumber(
payload.durationMs,
0
),
snapshotId:
payload.snapshotId ||
null,
snapshotCreatedAt:
payload.snapshotCreatedAt ||
null,
snapshotAgeSec:
safeNumber(
payload.snapshotAgeSec,
0
),
candidateStartIndex: safeNumber(payload.candidateStartIndex, 0),
candidateEndExclusive: safeNumber(payload.candidateEndExclusive, 0),
nextCandidateIndex: safeNumber(payload.nextCandidateIndex, 0),
snapshotCandidateCount: safeNumber(payload.snapshotCandidateCount, 0),
batchCandidateCount: safeNumber(payload.batchCandidateCount, 0),
batchNumber: safeNumber(payload.batchNumber, 0),
batchProcessingComplete: payload.batchProcessingComplete === true,
snapshotProcessingComplete: payload.snapshotProcessingComplete === true,
snapshotContinuation: payload.snapshotContinuation === true,
snapshotProgressAdvanced:
payload.snapshotProgressAdvanced === true ||
safeNumber(payload.nextCandidateIndex, 0) >
safeNumber(payload.candidateStartIndex, 0),
noProgressRetryCount: safeNumber(payload.noProgressRetryCount, 0),
entryProcessingIncomplete: payload.entryProcessingIncomplete === true,
entryProcessingStoppedAtIndex:
payload.entryProcessingIncomplete === true
? safeNumber(payload.entryProcessingStoppedAtIndex, 0)
: null,
selectedSnapshotSource:
payload.selectedSnapshotSource ||
null,
selectedSnapshotReason:
payload.selectedSnapshotReason ||
null,
candidates:
safeNumber(
payload.candidates ??
payload.candidatesCount,
0
),
processed:
safeNumber(

payload.processed,
0
),
entryRows:
safeNumber(
payload.entryRows,
0
),
waitRows:
safeNumber(
payload.waitRows,
0
),
virtualCreatedRows:
safeNumber(
payload.virtualCreatedRows,
0
),
virtualExitRows:
safeNumber(
payload.virtualExitRows,
0
),
shadowExitRows:
safeNumber(
payload.shadowExitRows,
0
),
selectedTargetCandidateCount:
safeNumber(
payload.selectedTargetCandidateCount,
0
),
selectedOppositeCandidateCount:
0,
actionCounts:
compactPrimitiveObject(
payload.actionCounts,
100
),
activeRotationId:
payload.activeRotationId ||
null,
selectedRotationId:
payload.selectedRotationId ||
payload.activeRotationId ||
null,

activeMicroFamilyIds:
compactIdList(
payload.activeMicroFamilyIds,
MAX_ID_LIST
),
selectedMicroFamilyIds:
compactIdList(
payload.selectedMicroFamilyIds,
MAX_ID_LIST
),
activeMacroFamilyIds:
compactIdList(
payload.activeMacroFamilyIds,
MAX_ID_LIST
),
selectedMacroFamilyIds:
compactIdList(
payload.selectedMacroFamilyIds,
MAX_ID_LIST
),
currentMarketWeather:
compactMarketWeather(
payload.currentMarketWeather
),
warnings:
compactIdList(
payload.warnings,
MAX_WARNING_LIST
),
fullPayloadPersisted:
false,
actionsPersisted:
false,
scannerRowsPersisted:
false,
marketWeatherRowsPersisted:
false,
candidateRowsPersisted:
false,
candleDataPersisted:
false
};
}
function jsonByteLength(value) {
try {
return Buffer.byteLength(
JSON.stringify(value),

'utf8'
);
} catch {
return Number.POSITIVE_INFINITY;
}
}
function compactScannerPreload(
preload = null
) {
if (
!preload ||
typeof preload !== 'object'
) {
return null;
}
return {
ok:
preload.ok === true,
reason:
preload.reason ||
null,
durationMs:
safeNumber(
preload.durationMs,
0
),
scanner: {
available:
preload.scanner
?.available === true,
source:
preload.scanner
?.source ||
null
},
market: {
universeAvailable:
preload.market
?.universeAvailable === true,
weatherAvailable:
preload.market
?.weatherAvailable === true
},
scannerExecutedInsideTradeRoute:
false,
scannerPreloadMode:
'READ_EXISTING_LATEST',

fullScannerPayloadExcluded:
true
};
}
function emergencyRunMeta(
compact = {},
preload = null
) {
return {
ok:
compact.ok !== false,
skipped:
Boolean(
compact.skipped
),
reason:
compact.reason ||
null,
runId:
compact.runId ||
null,
snapshotId:
compact.snapshotId ||
null,
candidates:
safeNumber(
compact.candidates,
0
),
processed:
safeNumber(
compact.processed,
0
),
entryRows:
safeNumber(
compact.entryRows,
0
),
waitRows:
safeNumber(
compact.waitRows,
0
),
virtualCreatedRows:
safeNumber(
compact.virtualCreatedRows,

0
),
virtualExitRows:
safeNumber(
compact.virtualExitRows,
0
),
scannerPreload:
compactScannerPreload(
preload
),
persistedAt:
now(),
persistedBy:
'api/trade/run.js',
emergencyCompactMeta:
true,
fullPayloadPersisted:
false,
...baseFlags()
};
}
async function persistLongRunMeta(
redis,
payload = {},
preload = null
) {
const compact =
compactForPersistence(
payload
);
const compactPreload =
compactScannerPreload(
preload
);
const persistedTemporal = temporalPolicyFlags(
compact.startedAt ??
compact.createdAt ??
now()
);
let runMeta = {
...compact,
...baseFlags(),
...persistedTemporal,
runTemporalContext: persistedTemporal.temporalContext,
scannerPreload:
compactPreload,

persistedAt:
now(),
persistedBy:
'api/trade/run.js',
persistedNamespace:
LONG_NAMESPACE
};
let runMetaBytes =
jsonByteLength(
runMeta
);
if (
runMetaBytes >
MAX_RUN_META_BYTES
) {
runMeta =
emergencyRunMeta(
compact,
preload
);
runMetaBytes =
jsonByteLength(
runMeta
);
}
let runMetaPersisted =
false;
let runMetaFallbackUsed =
false;
let runMetaError =
null;
try {
await setJson(
redis,
LONG_KEYS.trade.runMeta,
runMeta
);
runMetaPersisted =
true;
} catch (error) {
runMetaError =
error?.message ||
String(error);
try {
const fallback =
emergencyRunMeta(
compact,

preload
);
await setJson(
redis,
LONG_KEYS.trade.runMeta,
fallback
);
runMetaPersisted =
true;
runMetaFallbackUsed =
true;
runMetaBytes =
jsonByteLength(
fallback
);
} catch (fallbackError) {
console.error(
'[api/trade/run] run-meta write failed:',
{
primaryError:
runMetaError,
fallbackError:
fallbackError
?.message ||
String(
fallbackError
),
runId:
compact.runId,
snapshotId:
compact.snapshotId
}
);
}
}
let snapshotPersisted =
false;
const snapshotProcessingComplete = Boolean(
compact.snapshotProcessingComplete === true ||
compact.reason === 'SNAPSHOT_PROCESSING_COMPLETE' ||
compact.reason === 'SNAPSHOT_BATCH_CURSOR_AT_END'
);
if (compact.snapshotId && snapshotProcessingComplete) {
snapshotPersisted =
await setJson(
redis,
LONG_KEYS.trade
.lastProcessedSnapshot,
{
snapshotId:
compact.snapshotId,
runId:
compact.runId,
processedAt:
now(),
snapshotProcessingComplete: true,
snapshotCompletionPersistenceVersion:
SNAPSHOT_COMPLETION_PERSISTENCE_VERSION,
scannerPreload:
compactPreload,
compactPersistence:
true,
...baseFlags()
}
)
.then(() => true)
.catch((error) => {
console.error(
'[api/trade/run] snapshot-meta write failed:',
{
message:
error?.message ||
String(error),
snapshotId:
compact.snapshotId
}
);
return false;
});
}
return {
persistedLongRunMeta:
runMetaPersisted,
persistedLongLastProcessedSnapshot:
snapshotPersisted,
tradeRunMeta:
LONG_KEYS.trade.runMeta,
tradeLastProcessedSnapshot:
LONG_KEYS.trade
.lastProcessedSnapshot,
compactPersistence:
true,
fullPayloadPersisted:
false,
runMetaBytes,
maxRunMetaBytes:
MAX_RUN_META_BYTES,
runMetaFallbackUsed,
runMetaError,
snapshotProcessingComplete,
snapshotCompletionPersistenceVersion:
SNAPSHOT_COMPLETION_PERSISTENCE_VERSION
};
}
async function keyExists(

redis,
key
) {
if (!redis || !key) {
return false;
}
try {
return (
safeNumber(
await redis.exists(key),
0
) > 0
);
} catch {
return false;
}
}
function isPlainObject(value) {
return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function extractEmbeddedMarketUniverse(value, depth = 0) {
if (depth > 4 || !value) return [];
if (Array.isArray(value)) return value.filter(Boolean);
if (!isPlainObject(value)) return [];
for (const key of ['marketUniverse', 'currentMarketUniverse', 'universe', 'rows', 'items']) {
const candidate = value[key];
if (Array.isArray(candidate) && candidate.length) return candidate.filter(Boolean);
}
for (const key of ['currentMarketWeather', 'marketWeather', 'weather', 'latest', 'snapshot', 'payload']) {
const rows = extractEmbeddedMarketUniverse(value[key], depth + 1);
if (rows.length) return rows;
}
return [];
}
async function readJsonSafe(redis, key) {
if (!redis || !key) return null;
return getJson(redis, key, null).catch(() => null);
}
async function mirrorJsonIfMissing({ sourceRedis, targetRedis, key, existingTarget }) {
if (existingTarget || !sourceRedis || !targetRedis || !key) return existingTarget;
const payload = await readJsonSafe(sourceRedis, key);
if (!payload) return false;
return setJson(targetRedis, key, payload).then(() => true).catch(() => false);
}
async function loadScannerPreload({
volatileRedis,
durableRedis
}) {
const startedAt = now();
let [
durableScanner,
volatileScanner,
durableUniverse,
volatileUniverse,
durableWeather,
volatileWeather
] = await Promise.all([
keyExists(durableRedis, LONG_KEYS.scan.latest),
keyExists(volatileRedis, LONG_KEYS.scan.latest),
keyExists(durableRedis, MARKET_UNIVERSE_KEY),
keyExists(volatileRedis, MARKET_UNIVERSE_KEY),
keyExists(durableRedis, MARKET_WEATHER_KEY),
keyExists(volatileRedis, MARKET_WEATHER_KEY)
]);
if (!durableUniverse && volatileUniverse) {
durableUniverse = await mirrorJsonIfMissing({
sourceRedis: volatileRedis,
targetRedis: durableRedis,
key: MARKET_UNIVERSE_KEY,
existingTarget: durableUniverse
});
}
if (!durableWeather && volatileWeather) {
durableWeather = await mirrorJsonIfMissing({
sourceRedis: volatileRedis,
targetRedis: durableRedis,
key: MARKET_WEATHER_KEY,
existingTarget: durableWeather
});
}
let embeddedUniverseSource = null;
let embeddedUniverseRows = [];
if (!durableUniverse && !volatileUniverse && (durableWeather || volatileWeather)) {
const weatherRedis = durableWeather ? durableRedis : volatileRedis;
const weatherPayload = await readJsonSafe(weatherRedis, MARKET_WEATHER_KEY);
embeddedUniverseRows = extractEmbeddedMarketUniverse(weatherPayload);
if (embeddedUniverseRows.length) {
embeddedUniverseSource = durableWeather
? 'EMBEDDED_IN_DURABLE_MARKET_WEATHER'
: 'EMBEDDED_IN_VOLATILE_MARKET_WEATHER';
if (durableRedis) {
durableUniverse = await setJson(
durableRedis,
MARKET_UNIVERSE_KEY,
embeddedUniverseRows
).then(() => true).catch(() => false);
}
}
}
const scannerAvailable = durableScanner || volatileScanner;
const universeAvailable = durableUniverse || volatileUniverse ||
embeddedUniverseRows.length > 0;
return {
ok: scannerAvailable,
reason: scannerAvailable ? null : 'SCANNER_LATEST_NOT_FOUND',
scanner: {
available: scannerAvailable,
source: durableScanner
? 'DURABLE_SCANNER_LATEST'
: volatileScanner
? 'VOLATILE_SCANNER_LATEST'
: null,
fullSnapshotReadSkipped: true
},
market: {
universeAvailable,
weatherAvailable: durableWeather || volatileWeather,
universeSource: durableUniverse
? 'DURABLE'
: volatileUniverse
? 'VOLATILE'
: embeddedUniverseSource,
weatherSource: durableWeather
? 'DURABLE'
: volatileWeather
? 'VOLATILE'
: null,
embeddedUniverseFallbackUsed: Boolean(embeddedUniverseSource),
embeddedUniverseRows: embeddedUniverseRows.length,
marketUniversePreloadVersion: MARKET_UNIVERSE_PRELOAD_VERSION
},
mirror: {
marketUniverseMirrored: durableUniverse,
marketWeatherMirrored: durableWeather
},
durationMs: now() - startedAt,
scannerExecutedInsideTradeRoute: false,
scannerRunSkippedToPreventVercelTimeout: true,
scannerPreloadMode: 'READ_EXISTING_LATEST'
};
}
function temporalRuntimeOptions() {
const controls = resolveTemporalControls();
return {
...controls,
temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
temporalStatsVersion: TEMPORAL_STATS_VERSION,
temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
temporalAggregationVersion: TEMPORAL_AGGREGATION_VERSION,
temporalGenerationVersion: TEMPORAL_GENERATION_VERSION,
temporalGenerationMaxAgeDays: TEMPORAL_GENERATION_MAX_AGE_DAYS,
temporalActiveGenerationPointerKey: LONG_KEYS.temporal.activeGenerationId,
temporalNextGenerationPointerKey: LONG_KEYS.temporal.nextGenerationId,
temporalGenerationKeyPrefix:
`${LONG_KEY_PREFIX}ANALYZE:TEMPORAL:GENERATION:`,
temporalProjectionReadMode:
'UNIQUE_EXACT_75_CHILD_FAMILIES_FROM_CANDIDATE_BATCH',
temporalGenerationReadOncePerInvocation: true,
temporalMixedGenerationReadsForbidden: true,
temporalMissingRootGenerationFailClosedInEnforce: true,
temporalMissingFamilyProjectionFailClosedInEnforce: true,
temporalEntryGateOnly: true,
temporalExitGateDisabled: true
};
}
function buildRunOptions(
req,
body,

startedAt,
deadlineAt,
runtimeBudgetMs,
signal = null
) {
const runTemporal = temporalPolicyFlags(startedAt);
const temporalRuntime = temporalRuntimeOptions();
const forceProcessSnapshot =
shouldForceProcessSnapshot(
req,
body
);
const restartSnapshotProgress =
shouldRestartSnapshotProgress(
req,
body
);
const monitorOnly =
shouldMonitorOnly(
req,
body
);
return {
...runTemporal,
...temporalRuntime,
entryTemporalContext: runTemporal.temporalContext,
weekendEntryPolicyEnforced: temporalRuntime.temporalPolicyMode ===
'ENFORCE',
sessionPolicyObservedOnly: temporalRuntime.temporalPolicyMode !==
'ENFORCE',
finalDiscordEntryFormula: "wouldPublishWithoutTemporal && (temporalPolicyMode !== 'ENFORCE' || temporalWouldBlock === false)",
force:
forceProcessSnapshot,
forceProcessSnapshot,
restartSnapshotProgress,
tradeRuntimeFairnessVersion: TRADE_RUNTIME_FAIRNESS_VERSION,
adaptiveNoProgressBatchVersion: ADAPTIVE_NO_PROGRESS_BATCH_VERSION,
authoritativeOpenSymbolCheckVersion: AUTHORITATIVE_OPEN_SYMBOL_CHECK_VERSION,
snapshotContinuationVersion: SNAPSHOT_CONTINUATION_VERSION,
tradeResponseContractVersion: TRADE_RESPONSE_CONTRACT_VERSION,
apiMarketEventClusterCanonicalizationVersion:
API_MARKET_EVENT_CLUSTER_CANONICALIZATION_VERSION,
snapshotProgressProjectionVersion:
SNAPSHOT_PROGRESS_PROJECTION_VERSION,
exitSourceSeparationVersion:
EXIT_SOURCE_SEPARATION_VERSION,
monitorOnly,
monitorOpenPositionsFirst:
true,
monitorOpenPositions:
true,
processOpenPositions:
true,
closeVirtualPositions:
true,
processScannerSnapshot:
!monitorOnly,
targetTradeSide:
TARGET_TRADE_SIDE,
tradeSide:
TARGET_TRADE_SIDE,
side:
TARGET_DASHBOARD_SIDE,

positionSide:
TARGET_TRADE_SIDE,
direction:
TARGET_TRADE_SIDE,
scannerSide:
TARGET_SCANNER_SIDE,
actualScannerSide:
TARGET_SCANNER_SIDE,
analysisSide:
TARGET_TRADE_SIDE,
dashboardSide:
TARGET_DASHBOARD_SIDE,
longOnly:
true,
shortDisabled:
true,
disableShort:
true,
shortOnly:
false,
longDisabled:
false,
virtualOnly:
true,
virtualLearning:
true,
virtualLearningForced:
true,
virtualTracked:
true,
source:
'VIRTUAL',
outcomeSource:
'VIRTUAL',
learningOnly:
true,
microFamilyLearning:
true,
observationFirst:
true,
realTrade:
false,
realOrder:
false,
exchangeOrder:
false,
bitgetOrderPlaced:

false,
realOrdersDisabled:
true,
exchangeOrdersDisabled:
true,
bitgetOrdersDisabled:
true,
exchangeCallsDisabled:
true,
noExchangeOrders:
true,
noRealOrders:
true,
scannerFingerprintRole:
'METADATA_ONLY',
scannerFingerprintsMetadataOnly:
true,
scannerFingerprintsUsedAsLearningFamily:
false,
executionFingerprintRole:
'METADATA_ONLY',
executionFingerprintsMetadataOnly:
true,
executionFingerprintsUsedAsLearningFamily:
false,
analyzeMicroFamiliesOnly:
true,
learningIdentitySource:
'ANALYZE_TRUE_MICRO_FAMILY',
exactTrueMicroFamilyRequired:
true,
trueMicroOnly:
true,
exactTrueMicroOnly:
true,
trueMicroFamilySchema:
TRUE_MICRO_SCHEMA,
parentTrueMicroFamilySchema:
PARENT_TRUE_MICRO_SCHEMA,
learningGranularity:
LEARNING_GRANULARITY,
parentLearningGranularity:
PARENT_LEARNING_GRANULARITY,
selectionGranularity:
'EXACT_75_CHILD',
symbolExcludedFromFamilyId:
true,

allowLearningWithoutActiveRotation:
true,
ignoreMaxOpenPositionsForLearning:
true,
ignoreGlobalMaxOpenPositions:
true,
ignoreRiskCapsForLearning:
true,
oneOpenPositionPerSymbol:
true,
maxOneOpenPositionPerSymbol:
true,
positionTimeStopMin:
getPositionTimeStopMin(),
riskGeometryRule:
'LONG: sl < entry < tp',
tpHitRule:
'LONG: price >= tp',
slHitRule:
'LONG: price <= sl',
grossRFormula:
'(exitPrice - entry) / (entry - initialSl)',
currentRFormula:
'(currentPrice - entry) / (entry - initialSl)',
currentFitPolarity:
'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition:
'LONG_MIRRORED_CURRENT_FIT',
discordOnlyForSelectedMicroFamilies:
true,
discordOnlyForManualSelection:
true,
discordOnlyForExactTrueMicroMatch:
true,
manualSelectionMatchMode:
'EXACT_TRUE_MICRO_FAMILY_ID',
manualSelectionRequires75ChildTrueMicroFamilyId:
true,
runScope:
RUN_SCOPE,
writeScope:
WRITE_SCOPE,
readScope:
READ_SCOPE,
namespace:
LONG_NAMESPACE,
keyPrefix:

LONG_KEY_PREFIX,
redisNamespace:
LONG_NAMESPACE,
redisKeyPrefix:
LONG_KEY_PREFIX,
persistentLearningKey:
PERSISTENT_LEARNING_KEY,
weekKey:
PERSISTENT_LEARNING_KEY,
keys: {
scannerLatest:
LONG_KEYS.scan.latest,
tradeLock:
LONG_KEYS.trade.lock,
tradeRunMeta:
LONG_KEYS.trade.runMeta,
tradeLastProcessedSnapshot:
LONG_KEYS.trade
.lastProcessedSnapshot,
marketUniverseLatest:
MARKET_UNIVERSE_KEY,
longMarketUniverseLatest:
MARKET_UNIVERSE_KEY,
marketWeatherLatest:
MARKET_WEATHER_KEY,
longMarketWeatherLatest:
MARKET_WEATHER_KEY
},
scannerPreloadBeforeTrade:
true,
scannerPreloadMode:
'READ_EXISTING_LATEST',
scannerRunAllowed:
false,
scannerRunDisabledInsideTradeSystem:
true,
preventScannerRun:
true,
doNotRunScanner:
true,
noInternalScannerRun:
true,
scannerLatestReadOnly:
true,
readScannerLatestOnly:
true,
allowTradeWrite:

true,
allowAnalyzePartialWrite:
true,
allowScannerWrite:
false,
allowRotationWrite:
false,
allowDiscordSelectionWrite:
false,
analyzePartialOnly:
true,
microFamiliesAppendOnly:
true,
analyzeFullOverwriteDisabled:
true,
microFamiliesAntiWipe:
true,
preserveRotation:
true,
preserveManualSelection:
true,
preserveDiscordSelection:
true,
requestStartedAt:
startedAt,
deadlineAt,
runtimeBudgetMs,
signal,
stopBeforeDeadlineMs:
7000,
abortBeforeDeadline:
true,
adminPageIsolation:
true,
doesNotOverwriteOtherAdminPages:
true
};
}
async function executeWithTradeLock({
durableRedis,
lockTtlSec,
callback
}) {
if (
typeof LockApi.withLock ===
'function'
) {

return LockApi.withLock(
TRADE_LOCK_RESOURCE,
callback,
lockTtlSec
);
}
if (
typeof LockApi.withRedisLock ===
'function'
) {
return LockApi.withRedisLock(
durableRedis,
LONG_KEYS.trade.lock,
lockTtlSec,
callback
);
}
throw new Error(
'TRADE_LOCK_API_MISSING'
);
}
function unwrapLockResult(value) {
if (!value) {
return null;
}
if (
value.result
?.result
?.result
) {
return value
.result
.result
.result;
}
if (
value.result?.result
) {
return value
.result
.result;
}
if (value.result) {
return value.result;
}
return value;
}

function lockText(value) {
const payload =
unwrapLockResult(value);
return [
value?.reason,
value?.error,
value?.message,
value?.code,
payload?.reason,
payload?.error,
payload?.message,
payload?.code,
value instanceof Error
? value.message
: ''
]
.filter(Boolean)
.map(
(part) =>
String(part)
.toUpperCase()
)
.join('|');
}
function isLockConflict(value) {
const text =
lockText(value);
return (
text.includes(
'LOCK_HELD'
) ||
text.includes(
'LOCK_NOT_ACQUIRED'
) ||
text.includes(
'TRADE_RUN_LOCK_ACTIVE'
) ||
text.includes(
'LOCK_ACTIVE'
) ||
text.includes(
'ALREADY_RUNNING'
) ||
text.includes(
'CONFLICT_LOCK'
) ||
text.includes(

'MAX_RETRIES_EXCEEDED'
)
);
}
function lockSkippedResponse(
req,
body,
startedAt,
lockTtlSec,
error = null
) {
return {
ok:
true,
tradeOk:
true,
scannerPreloadOk:
null,
skipped:
true,
skippedNewEntries:
true,
reason:
'TRADE_RUN_LOCK_ACTIVE',
skipReason:
'TRADE_RUN_LOCK_ACTIVE',
message:
'Trade run overgeslagen: vorige LONG trade-run is nog actief.',
...baseFlags(),
runSource:
getRunSource(
req,
body
),
lock: {
resource:
TRADE_LOCK_RESOURCE,
key:
LONG_KEYS.trade.lock,
ttlSec:
lockTtlSec,
active:
true
},
entryRows:
0,
waitRows:

0,
virtualCreatedRows:
0,
virtualExitRows:
0,
entryRowsList:
[],
waitRowsList:
[],
virtualExits:
[],
shadowExits:
[],
realExits:
[],
actionCounts:
{},
counts:
{},
warnings: [
'TRADE_RUN_SKIPPED_BECAUSE_LOCK_ACTIVE'
],
error:
error?.message ||
null,
durationMs:
now() - startedAt,
completedAt:
now()
};
}
function responseCounts(
payload = {}
) {
return {
candidates:
safeNumber(
payload.candidates ??
payload.candidatesCount,
0
),
longCandidateCount:
safeNumber(
payload.longCandidateCount,
0
),
nonLongCandidateCount:

safeNumber(
payload.nonLongCandidateCount,
0
),
processed:
safeNumber(
payload.processed,
0
),
liveRows:
safeNumber(
payload.liveRows,
0
),
analyzeInputRows:
safeNumber(
payload.analyzeInputRows,
0
),
observationOnlyRows:
safeNumber(
payload.observationOnlyRows,
0
),
entryRows:
safeNumber(
payload.entryRows,
0
),
waitRows:
safeNumber(
payload.waitRows,
0
),
virtualCreatedRows:
safeNumber(
payload.virtualCreatedRows,
0
),
actions:
safeNumber(
payload.actionsCount,
0
),
entries:
safeNumber(
payload.entryRows,

0
),
waits:
safeNumber(
payload.waitRows,
0
),
realExits:
0,
shadowExits:
safeNumber(
payload.shadowExitRows,
0
),
virtualExits:
safeNumber(
payload.virtualExitRows,
0
),
activeMicroFamilies:
safeNumber(
payload.activeMicroFamilies,
0
),
activeMacroFamilies:
safeNumber(
payload.activeMacroFamilies,
0
),
selectedTargetCandidateCount:
safeNumber(
payload.selectedTargetCandidateCount,
0
),
selectedOppositeCandidateCount:
0,
ignoredShortActions:
safeNumber(
payload.ignoredShortActions,
0
),
ignoredShortExitRows:
safeNumber(
payload.ignoredShortExitRows,
0
)
};

}
function createRouteDeadlineError({ deadlineAt, startedAt } = {}) {
const error = new Error('TRADE_ROUTE_HARD_DEADLINE_REACHED');
error.code = 'TRADE_ROUTE_HARD_DEADLINE_REACHED';
error.reason = 'RETRY_NEXT_INVOCATION';
error.statusCode = 200;
error.deadlineAt = deadlineAt || null;
error.durationMs = now() - safeNumber(startedAt, now());
return error;
}
async function withRouteHardDeadline(task, {
signalController,
deadlineAt,
startedAt
} = {}) {
const remainingMs = Math.max(1, safeNumber(deadlineAt, now() + 1) - now());
let timer = null;
const taskPromise = Promise.resolve().then(task);
taskPromise.catch(() => null);
const timeoutPromise = new Promise((_, reject) => {
timer = setTimeout(() => {
try {
signalController?.abort(
createRouteDeadlineError({ deadlineAt, startedAt
})
);
} catch {
signalController?.abort();
}
reject(createRouteDeadlineError({ deadlineAt, startedAt }));
}, remainingMs);
});
try {
return await Promise.race([taskPromise, timeoutPromise]);
} finally {
if (timer) clearTimeout(timer);
}
}
function isControlledDeadlineError(error) {
return [
'TRADE_ROUTE_HARD_DEADLINE_REACHED',
'TRADE_SYSTEM_DEADLINE_REACHED',
'TRADE_SYSTEM_ABORTED'
].includes(String(error?.code || error?.message || '').trim());
}
function resolveStatus(error) {
return Number.isFinite(

error?.statusCode
)
? error.statusCode
: 500;
}
export default async function handler(
req,
res
) {
res.setHeader(
'Cache-Control',
'no-store, max-age=0'
);
res.setHeader(
'X-Trade-Target-Side',
TARGET_TRADE_SIDE
);
res.setHeader(
'X-Dashboard-Side',
TARGET_DASHBOARD_SIDE
);
res.setHeader(
'X-Long-Only',
'true'
);
res.setHeader(
'X-Short-Disabled',
'true'
);
res.setHeader(
'X-Virtual-Only',
'true'
);
res.setHeader(
'X-No-Real-Orders',
'true'
);
res.setHeader(
'X-Scanner-Run-Allowed',
'false'
);
res.setHeader(
'X-Scanner-Preload-Before-Trade',
'READ_EXISTING_LATEST'
);
res.setHeader(
'X-Compact-Run-Meta',

'true'
);
const temporalControls = resolveTemporalControls();
res.setHeader('X-Weekend-Mode', temporalControls.temporalPolicyMode);
res.setHeader('X-Session-Mode', temporalControls.temporalPolicyMode);
res.setHeader('X-Temporal-Context-Version', TEMPORAL_CONTEXT_VERSION);
res.setHeader('X-Temporal-Stats-Version', TEMPORAL_STATS_VERSION);
res.setHeader('X-Temporal-Policy-Version', TEMPORAL_POLICY_VERSION);
res.setHeader('X-Temporal-Aggregation-Version', TEMPORAL_AGGREGATION_VERSION);
res.setHeader('X-Temporal-Generation-Version', TEMPORAL_GENERATION_VERSION);
res.setHeader('X-Temporal-Policy-Mode', temporalControls.temporalPolicyMode);
res.setHeader('X-Temporal-Stats-Enabled',
String(temporalControls.temporalStatsEnabled));
res.setHeader(
'X-Weekend-Discord-Entry-Allowed',
String(!buildTemporalContext(now()).isWeekend)
);
res.setHeader(
'X-Full-Payload-Persisted',
'false'
);
const startedAt =
now();
const runtimeBudgetMs =
getRuntimeBudgetMs();
const deadlineAt =
startedAt +
runtimeBudgetMs;
const routeHardDeadlineAt =
startedAt +
ROUTE_HARD_TIMEOUT_MS;
const abortController = new AbortController();
let body = {};
try {
if (
req.method !== 'GET' &&
req.method !== 'POST'
) {
res.setHeader(
'Allow',
'GET, POST'
);
return res
.status(405)
.json({
ok:
false,

error:
'METHOD_NOT_ALLOWED',
allowed: [
'GET',
'POST'
],
...baseFlags()
});
}
body =
await readBody(req);
const rowLimit =
getResponseRowLimit(
req,
body
);
const runOptions =
buildRunOptions(
req,
body,
startedAt,
deadlineAt,
runtimeBudgetMs,
abortController.signal
);
const durableRedis =
getDurableRedis();
const volatileRedis =
getVolatileRedis();
const lockTtlSec =
getLockTtlSec();
let scannerPreload =
null;
const rawResult =
await withRouteHardDeadline(
() => executeWithTradeLock({
durableRedis,
lockTtlSec,
callback:
async () => {
scannerPreload =
await loadScannerPreload({
volatileRedis,
durableRedis
});
return runTradeSystem({
...runOptions,

signal: abortController.signal,
routeHardDeadlineAt,
scannerPreloadOk:
scannerPreload
?.ok === true,
scannerSnapshotAvailable:
scannerPreload
?.ok === true,
scannerPreloadMode:
'READ_EXISTING_LATEST',
marketWeatherMirroredToDurable:
scannerPreload
?.mirror
?.marketWeatherMirrored ===
true,
marketUniverseMirroredToDurable:
scannerPreload
?.mirror
?.marketUniverseMirrored ===
true,
remainingRuntimeMs:
Math.max(
0,
deadlineAt -
now()
)
});
}
}),
{
signalController: abortController,
deadlineAt: routeHardDeadlineAt,
startedAt
}
);
if (
isLockConflict(
rawResult
)
) {
return res
.status(200)
.json(
lockSkippedResponse(
req,
body,
startedAt,

lockTtlSec
)
);
}
const rawPayload =
unwrapLockResult(
rawResult
) || {};
const payload =
sanitizeRunPayload(
rawPayload,
rowLimit
);
const compactRun =
compactForPersistence(
payload
);
const tradeOk =
rawResult?.ok !== false &&
payload.ok !== false;
const scannerOk =
scannerPreload
?.ok === true;
const persistence =
now() <
deadlineAt - 2000
? await persistLongRunMeta(
durableRedis,
payload,
scannerPreload
)
: {
persistedLongRunMeta:
false,
persistedLongLastProcessedSnapshot:
false,
reason:
'SKIPPED_NEAR_RUNTIME_DEADLINE',
compactPersistence:
true,
fullPayloadPersisted:
false
};
return res
.status(200)
.json({
ok:

tradeOk,
tradeOk,
scannerPreloadOk:
scannerOk,
skipped:
Boolean(
rawResult?.skipped ||
payload.skipped
),
reason:
rawResult?.reason ||
payload.reason ||
(
!scannerOk
? 'SCANNER_LATEST_NOT_AVAILABLE'
: null
),
skipReason:
payload.skipReason ||
null,
...baseFlags(),
runSource:
getRunSource(
req,
body
),
force:
runOptions.force,
forceProcessSnapshot:
runOptions
.forceProcessSnapshot,
restartSnapshotProgress:
runOptions.restartSnapshotProgress,
tradeRuntimeFairnessVersion:
TRADE_RUNTIME_FAIRNESS_VERSION,
snapshotContinuationVersion:
SNAPSHOT_CONTINUATION_VERSION,
marketUniversePreloadVersion:
MARKET_UNIVERSE_PRELOAD_VERSION,
snapshotCompletionPersistenceVersion:
SNAPSHOT_COMPLETION_PERSISTENCE_VERSION,
tradeResponseContractVersion:
TRADE_RESPONSE_CONTRACT_VERSION,
apiMarketEventClusterCanonicalizationVersion:
API_MARKET_EVENT_CLUSTER_CANONICALIZATION_VERSION,
snapshotProgressProjectionVersion:
SNAPSHOT_PROGRESS_PROJECTION_VERSION,
exitSourceSeparationVersion:
EXIT_SOURCE_SEPARATION_VERSION,
monitorOnly:
runOptions.monitorOnly,
monitorOpenPositionsFirst:
true,
monitorOpenPositions:
true,
processScannerSnapshot:
runOptions
.processScannerSnapshot,
runtimeBudgetMs,
deadlineAt,
routeHardDeadlineAt,
remainingRuntimeMs:
Math.max(
0,
deadlineAt -

now()
),
scannerPreload:
compactScannerPreload(
scannerPreload
),
scannerExecutedInsideTradeRoute:
false,
scannerRunSkippedToPreventVercelTimeout:
true,
marketWeatherAvailableAfterRun:
scannerPreload
?.market
?.weatherAvailable ===
true,
marketUniverseAvailableAfterRun:
scannerPreload
?.market
?.universeAvailable ===
true,
runId:
payload.runId,
snapshotId:
payload.snapshotId,
candidateStartIndex: payload.candidateStartIndex,
candidateEndExclusive: payload.candidateEndExclusive,
nextCandidateIndex: payload.nextCandidateIndex,
snapshotCandidateCount: payload.snapshotCandidateCount,
batchCandidateCount: payload.batchCandidateCount,
batchNumber: payload.batchNumber,
batchProcessingComplete: payload.batchProcessingComplete,
snapshotProcessingComplete: payload.snapshotProcessingComplete,
snapshotContinuation: payload.snapshotContinuation,
snapshotProgressAdvanced: payload.snapshotProgressAdvanced,
noProgressRetryCount: payload.noProgressRetryCount,
entryProcessingIncomplete: payload.entryProcessingIncomplete,
entryProcessingStoppedAtIndex: payload.entryProcessingStoppedAtIndex,
entryRows:
payload.entryRows,
waitRows:
payload.waitRows,
virtualCreatedRows:
payload.virtualCreatedRows,
virtualExitRows:
payload.virtualExitRows,
shadowExitRows:
payload.shadowExitRows,
entryRowsList:
payload.entryRowsList,
waitRowsList:
payload.waitRowsList,
virtualCreatedRowsList:
payload
.virtualCreatedRowsList,
virtualExits:
payload.virtualExits,
shadowExits:
payload.shadowExits,
realExits:
[],

actionCounts:
payload.actionCounts,
counts:
responseCounts(
payload
),
activeRotationId:
payload.activeRotationId,
selectedRotationId:
payload.selectedRotationId,
activeMicroFamilies:
payload.activeMicroFamilies,
activeMacroFamilies:
payload.activeMacroFamilies,
activeMicroFamilyIds:
payload.activeMicroFamilyIds,
activeMacroFamilyIds:
payload.activeMacroFamilyIds,
selectedMicroFamilyIds:
payload.selectedMicroFamilyIds,
selectedMacroFamilyIds:
payload.selectedMacroFamilyIds,
selectedSnapshotSource:
payload.selectedSnapshotSource,
selectedSnapshotReason:
payload.selectedSnapshotReason,
selectedTargetCandidateCount:
payload
.selectedTargetCandidateCount,
selectedOppositeCandidateCount:
0,
scannerLatestPreserved:
true,
scannerSnapshotPreserved:
true,
scannerHistoryPreserved:
true,
scannerRunBlockedInsideTradeRun:
true,
scannerRunDisabledInsideTradeSystem:
true,
microFamiliesAppendOnly:
true,
analyzePartialOnly:
true,
analyzeFullOverwriteDisabled:
true,

rotationPreserved:
true,
manualSelectionPreserved:
true,
discordSelectionPreserved:
true,
longPersistence:
persistence,
compactResponse:
true,
compactPersistence:
true,
fullPayloadReturned:
false,
fullPayloadPersisted:
false,
maxRunMetaBytes:
MAX_RUN_META_BYTES,
lock: {
resource:
TRADE_LOCK_RESOURCE,
key:
LONG_KEYS.trade.lock,
ttlSec:
lockTtlSec,
acquired:
rawResult?.ok !==
false,
released:
rawResult
?.lockReleased ??
null,
releaseReason:
rawResult
?.lockReleaseReason ||
null
},
longKeys: {
namespace:
LONG_NAMESPACE,
prefix:
LONG_KEY_PREFIX,
scanLatest:
LONG_KEYS.scan.latest,
tradeLock:
LONG_KEYS.trade.lock,
legacyConfiguredTradeLock:

LONG_KEYS.trade
.legacyConfiguredLock,
tradeRunMeta:
LONG_KEYS.trade
.runMeta,
tradeLastProcessedSnapshot:
LONG_KEYS.trade
.lastProcessedSnapshot,
marketUniverseLatest:
MARKET_UNIVERSE_KEY,
marketWeatherLatest:
MARKET_WEATHER_KEY,
temporalActiveGenerationId:
LONG_KEYS.temporal.activeGenerationId,
temporalNextGenerationId:
LONG_KEYS.temporal.nextGenerationId
},
warnings: [
!scannerOk
? 'SCANNER_LATEST_NOT_AVAILABLE_TRADE_MONITORING_CONTINUES'
: null,
scannerPreload
?.market
?.weatherAvailable !==
true
? 'MARKET_WEATHER_NOT_AVAILABLE'
: null,
scannerPreload
?.market
?.universeAvailable !==
true
? 'MARKET_UNIVERSE_NOT_AVAILABLE'
: null,
payload
.ignoredShortActions > 0
? `SHORT_ACTIONS_IGNORED:${payload.ignoredShortActions}`
: null,
payload
.ignoredShortExitRows > 0
? `SHORT_EXIT_ROWS_IGNORED:${payload.ignoredShortExitRows}`
: null,
payload
.responseActionsTruncated
? `RESPONSE_ACTIONS_TRUNCATED_TO:${rowLimit}`
: null,
payload
.responseExitsTruncated

? `RESPONSE_EXITS_TRUNCATED_TO:${rowLimit}`
: null,
persistence
.runMetaFallbackUsed
? 'RUN_META_EMERGENCY_COMPACT_FALLBACK_USED'
: null,
persistence
.persistedLongRunMeta ===
false
? 'RUN_META_NOT_PERSISTED'
: null,
now() >=
deadlineAt - 2000
? 'RUNTIME_BUDGET_ALMOST_EXHAUSTED'
: null
].filter(Boolean),
responseRowLimit:
rowLimit,
durationMs:
now() - startedAt,
completedAt:
now(),
run: {
...compactRun,
entryRowsList:
payload.entryRowsList,
waitRowsList:
payload.waitRowsList,
virtualExits:
payload.virtualExits,
compactResponse:
true
},
result: {
ok:
tradeOk,
skipped:
Boolean(
rawResult?.skipped ||
payload.skipped
),
reason:
rawResult?.reason ||
payload.reason ||
null,
...baseFlags(),
result:

compactRun
}
});
} catch (error) {
const controlledDeadline = isControlledDeadlineError(error);
if (!controlledDeadline) {
console.error(
'[api/trade/run] fatal handler error:',
{
name:
error?.name ||
null,
message:
error?.message ||
String(error),
code:
error?.code ||
null,
reason:
error?.reason ||
null,
stack:
error?.stack ||
null
}
);
}
const lockTtlSec =
getLockTtlSec();
if (controlledDeadline) {
return res.status(200).json({
ok: true,
tradeOk: false,
skipped: true,
reason: 'TRADE_RUN_DEFERRED_RUNTIME_DEADLINE',
skipReason: error?.code || error?.message ||
'TRADE_RUNTIME_DEADLINE',
retryNextInvocation: true,
runtimeBudgetMs,
deadlineAt,
routeHardDeadlineAt,
remainingRuntimeMs: Math.max(0, deadlineAt - now()),
durationMs: now() - startedAt,
warnings: [
'TRADE_RUN_STOPPED_BEFORE_VERCEL_60S_TIMEOUT',
'OPEN_POSITION_MONITORING_AND_SNAPSHOT_PROGRESS_CONTINUE_NEXT_RUN'

],
...baseFlags()
});
}
if (
isLockConflict(
error
)
) {
return res
.status(200)
.json(
lockSkippedResponse(
req,
body,
startedAt,
lockTtlSec,
error
)
);
}
return res
.status(
resolveStatus(error)
)
.json({
ok:
false,
...baseFlags(),
error:
error?.message ||
String(error),
code:
error?.code ||
null,
reason:
error?.reason ||
null,
durationMs:
now() - startedAt,
stack:
process.env.NODE_ENV ===
'production'
? undefined
: error?.stack
});
}

}

