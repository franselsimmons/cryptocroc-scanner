// ================= FILE: src/trade/tradeSystem.js =================
import { CONFIG } from '../config.js';
import {
KEYS,
assertKeyAllowedForWriteScope
} from '../keys.js';
import {
getDurableRedis,
getVolatileRedis,
getJson,
setJson,
delJson,
getKeys
} from '../redis.js';
import {
mapConcurrent,
normalizeBaseSymbol,
normalizeContractSymbol,
randomId,
safeNumber,
sideToTradeSide
} from '../utils.js';
import {
fetchCandles,
fetchFunding,
fetchOrderBook,
analyzeOrderBook
} from '../market/bitgetClient.js';
import {
analyzeCandidatesBatch
} from '../analyze/analyzeEngine.js';
import {
getActiveRotation,
evaluateTemporalEntryPolicy
} from '../analyze/rotationEngine.js';
import {
buildTemporalContext,
entryTemporalFields as buildCentralEntryTemporalFields,
exitTemporalFields as buildCentralExitTemporalFields,
temporalRuntimeConfig,
TEMPORAL_CONTEXT_VERSION,
TEMPORAL_POLICY_VERSION,
WEEKEND_POLICY_VERSION,
SESSION_POLICY_VERSION,
TEMPORAL_GENERATION_SCHEMA_VERSION,
TEMPORAL_TAXONOMY_VERSION,
TEMPORAL_COST_MODEL_VERSION
} from '../analyze/scoring.js';
import {
buildRiskAndLiveMetricsForBothSides
} from './riskEngine.js';
import {
buildOpenPositionFromEntry,
getOpenPositions,
saveOpenPosition,
saveExistingOpenPosition,
monitorOpenPositions
} from './positionEngine.js';
import {
riskFractionForEntry
} from './positionSizing.js';

import { sendEntryAlert } from '../discord/discord.js';
const DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT = 1000;
const DEFAULT_MAX_CANDIDATES_PER_INVOCATION = 40;
const DEFAULT_RUNTIME_BUDGET_MS = 50_000;
const DEFAULT_STOP_BEFORE_DEADLINE_MS = 7_000;
const DEFAULT_MIN_REMAINING_FOR_ENTRY_MS = 3_000;
const DEFAULT_MAX_CONTINUATION_AGE_SEC = 30 * 60;
const DEFAULT_RUN_RESPONSE_ACTION_LIMIT = 100;
const DEFAULT_RUN_META_ACTION_SAMPLE_LIMIT = 20;
const DEFAULT_MAX_TRADE_RUN_META_BYTES = 1_000_000;
const SNAPSHOT_SEARCH_LIMIT = 12;
const CANDIDATE_ORDER_VERSION = 'SNAPSHOT_ID_ROTATION_V1';
const LEGACY_CANDIDATE_ORDER_VERSION = 'LEGACY_SCANNER_ORDER_V0';
const SNAPSHOT_SELECTION_POLICY = 'UNFINISHED_PROGRESS_FIRST_THEN_LATEST_V1';
const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const TARGET_SCANNER_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';
const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';
const TEMPORAL_ENTRY_DECISION_SNAPSHOT_VERSION =
'LONG_TEMPORAL_ENTRY_DECISION_SNAPSHOT_V1';
const ENTRY_PUBLICATION_RESULT_VERSION = 'LONG_ENTRY_PUBLICATION_RESULT_V1';
const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = TRUE_MICRO_SCHEMA;
const LEARNING_GRANULARITY =
'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const RUN_SCOPE = 'TRADE_ONLY';
const WRITE_SCOPE = 'TRADE_AND_ANALYZE_PARTIAL_ONLY';
const READ_SCOPE = 'READ_LONG_SCANNER_LATEST_ONLY';
const ENTRY_RELAXATION_PROFILE = 'LONG_SCANNER_WIDE_VIRTUAL_LEARNING_V1';
const QUALITY_MEASUREMENT_PROFILE = 'LONG_MICRO_FAMILY_TP_SL_LEARNING_V1';
const DEFAULT_MIN_LIVE_CANDLES_15M = 25;
const DEFAULT_MIN_RISK_PCT = 0.0035;
const DEFAULT_MAX_RISK_PCT = 0.03;
const DEFAULT_FALLBACK_RISK_PCT = 0.005;
const DEFAULT_TRADE_EVERY_SCANNER_CANDIDATE_VIRTUAL = true;
const DEFAULT_ALLOW_STANDARDIZED_LEARNING_RISK_FALLBACK = true;
const DEFAULT_ALLOW_STANDARDIZED_LEARNING_RISK_VIRTUAL_ENTRIES = true;
const DEFAULT_DISCORD_REQUIRE_CURRENT_FIT = true;
const DEFAULT_DISCORD_MIN_CURRENT_FIT_CONFIDENCE = 35;
const DEFAULT_CURRENT_FIT_MAX_WEATHER_AGE_SEC = 15 * 60;

const MARKET_WEATHER_KEY = `${LONG_KEY_PREFIX}MARKET:WEATHER:LATEST`;
const MARKET_UNIVERSE_KEY = `${LONG_KEY_PREFIX}MARKET:UNIVERSE:LATEST`;
const FREEZE_MEASUREMENT_RECOMMENDED_DAYS = 14;
const MIN_COMPLETED_EARLY_SIGNAL = 20;
const MIN_COMPLETED_REASONABLE_SIGNAL = 50;
const MIN_COMPLETED_STRONG_SIGNAL = 100;
const MIN_COMPLETED_ACTIVE_LEARNING = 20;
const SETUP_ORDER = Object.freeze([
'BREAKOUT',
'RETEST',
'SWEEP_REVERSAL',
'CONTINUATION',
'COMPRESSION'
]);
const REGIME_ORDER = Object.freeze([
'TREND',
'CHOP',
'SQUEEZE'
]);
const CONFIRMATION_PROFILE_ORDER = Object.freeze([
'A_STRONG_ALIGN',
'B_FLOW_ALIGN',
'C_VOLUME_ALIGN',
'D_MIXED_OK',
'E_WEAK_CONTRA'
]);
const LONG_FIXED_SETUP_TYPES = new Set(SETUP_ORDER);
const LONG_FIXED_REGIME_BUCKETS = new Set(REGIME_ORDER);
const LONG_CONFIRMATION_PROFILES = new Set(CONFIRMATION_PROFILE_ORDER);
const KNOWN_TRADE_SIDES = new Set([
TARGET_TRADE_SIDE,
OPPOSITE_TRADE_SIDE
]);
const LONG_TOKENS = new Set([
'LONG',
'BULL',
'BULLISH',
'BUY',
'BID',
'UP',
'UPSIDE',
'GREEN'
]);
const SHORT_TOKENS = new Set([
'SHORT',
'BEAR',
'BEARISH',

'SELL',
'ASK',
'DOWN',
'DOWNSIDE',
'RED'
]);
const TRUE_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'n', 'off']);
function now() {
return Date.now();
}
export function buildTemporalContextUtc(value = Date.now()) {
return buildTemporalContext(value);
}
function entryTemporalFields(source = {}, fallbackTs = Date.now()) {
const entryTs = source.entryTs ?? source.entryCreatedAt ?? source.openedAt ??
source.createdAt ?? source.contextTs ?? fallbackTs;
return buildCentralEntryTemporalFields({
entryTs,
marketEventClusterId: source.marketEventClusterId,
scannerRunId: source.scannerRunId,
snapshotId: source.snapshotId,
marketCycleId: source.marketCycleId
});
}
function exitTemporalFields(value = Date.now()) {
return buildCentralExitTemporalFields(
typeof value === 'object' && value !== null
? value
: { exitTs: value }
);
}
const MEASUREMENT_FIX_VERSION =
'LONG_MEASUREMENT_FIX_TRIGGER_BOUNDARY_EXIT_FILL_V2';
const EXIT_FILL_MODEL_VERSION = 'LONG_TRIGGER_BOUNDARY_FILL_PLUS_COST_MODEL_V1';
const EMPIRICAL_VETO_POLICY_VERSION = 'LONG_EXACT_75_CHILD_NET_EDGE_VETO_V1';
const OUTCOME_MEASUREMENT_GATE_MODE = 'STRICT_EXACT_VERSION';
const EMPIRICAL_VETO_MIN_COMPLETED = 35;
function rowMeasurementVersion(row = {}) {
return upper(
row.measurementFixVersion ??
row.outcomeMeasurementVersion ??
row.acceptedOutcomeMeasurementVersion ??
row.positionMeasurementFixVersion ??
row.measurementVersion ??
''
);

}
function rowCompleted(row = {}) {
const virtualCompleted = Math.max(0, safeNumber(row.virtualCompleted, 0));
const shadowCompleted = Math.max(0, safeNumber(row.shadowCompleted, 0));
const sourceCompleted = virtualCompleted + shadowCompleted;
const explicitCompleted = Math.max(
0,
safeNumber(row.completed ?? row.outcomesCompleted, 0)
);
return sourceCompleted > 0 ? sourceCompleted : explicitCompleted;
}
function rowAvgR(row = {}) {
return safeNumber(row.avgR ?? row.sampleAdjustedAvgR, 0);
}
function deriveFamilyGate(row = {}) {
const completed = rowCompleted(row);
if (completed >= EMPIRICAL_VETO_MIN_COMPLETED) {
return rowAvgR(row) > 0 ? 'PASSED' : 'EMPIRICAL_VETO';
}
if (completed >= 20) return 'ACTIVE_LEARNING';
if (completed > 0) return 'EARLY_OUTCOMES';
return 'OBSERVING';
}
function discordFamilyGate(row = {}) {
const measurementFixVersion = rowMeasurementVersion(row);
const familyGate = deriveFamilyGate(row);
const currentMeasurement = measurementFixVersion === MEASUREMENT_FIX_VERSION;
return {
ok: currentMeasurement && familyGate === 'PASSED',
familyGate,
measurementFixVersion,
requiredMeasurementFixVersion: MEASUREMENT_FIX_VERSION,
outcomeMeasurementGateMode: OUTCOME_MEASUREMENT_GATE_MODE,
empiricalVetoPolicyVersion: EMPIRICAL_VETO_POLICY_VERSION,
completed: rowCompleted(row),
avgR: rowAvgR(row),
reason: !currentMeasurement
? 'DISCORD_BLOCKED_NON_CURRENT_V2_MEASUREMENT'
: familyGate !== 'PASSED'
? `DISCORD_BLOCKED_FAMILY_GATE_${familyGate}`
: 'DISCORD_FAMILY_GATE_PASSED'
};
}
function discordTemporalGate(context = {}) {
const runtime = temporalRuntimeConfig();
return {
ok: true,
evaluatedAtPositionOpen: false,
temporalPolicyOwner: 'ROTATION_ENGINE_AT_POSITION_OPEN',
temporalStatsEnabled: runtime.temporalStatsEnabled,
temporalPolicyMode: runtime.temporalPolicyMode,
entryDayOfWeekUtc: context.entryDayOfWeekUtc || null,
entrySessionBucket: context.entrySessionBucket || null,
reason: 'TEMPORAL_POLICY_DEFERRED_TO_IMMUTABLE_POSITION_OPEN_DECISION'
};
}
function discordCompositeEntryGate({
row = {},
selectedWeeklyStats = null,
selectedExactMicroMatch = false,
currentFitGate = { ok: false, reason: 'CURRENT_FIT_UNKNOWN' },
entryTemporal = {}
} = {}) {
const familyGate = discordFamilyGate(selectedWeeklyStats || row);
const temporalGate = discordTemporalGate(entryTemporal);
const cooldownBlocked = Boolean(row.cooldownBlocked ||
row.discordCooldownBlocked);
const duplicateBlocked = Boolean(row.duplicateBlocked || row.dedupeBlocked ||
row.discordDuplicateBlocked);
const ok = Boolean(
selectedExactMicroMatch &&
familyGate.ok &&
currentFitGate.ok &&
temporalGate.ok &&
!cooldownBlocked &&
!duplicateBlocked
);
return {
ok,
exactSelected75ChildMatch: Boolean(selectedExactMicroMatch),
familyGate,
currentFitGate,
temporalGate,
cooldownBlocked,
duplicateBlocked,
reason: !selectedExactMicroMatch
? 'DISCORD_BLOCKED_NO_EXACT_SELECTED_75_CHILD_MATCH'
: !familyGate.ok
? familyGate.reason
: !currentFitGate.ok
? currentFitGate.reason
: !temporalGate.ok
? temporalGate.reason

: cooldownBlocked
? 'DISCORD_BLOCKED_COOLDOWN'
: duplicateBlocked
? 'DISCORD_BLOCKED_DUPLICATE'
: 'DISCORD_LONG_ENTRY_ALL_GATES_PASSED'
};
}
function upper(value, fallback = '') {
const text = String(value ?? '').trim();
return text ? text.toUpperCase() : fallback;
}
function namespacedLongKey(key, fallback = 'UNKNOWN') {
const raw = String(key || fallback || '').trim();
if (!raw) return `${LONG_KEY_PREFIX}${fallback}`;
if (raw.startsWith(LONG_KEY_PREFIX)) return raw;
if (raw.startsWith('SHORT:') || raw.includes(`${LONG_KEY_PREFIX}SHORT:`)) {
throw new Error('LONG_TRADE_KEY_REJECTED_SHORT_NAMESPACE');
}
return `${LONG_KEY_PREFIX}${raw}`;
}
function keyFromMaybeFunction(fn, arg, fallback) {
try {
if (typeof fn === 'function') {
return fn(arg);
}
} catch {
return fallback;
}
return fallback;
}
function longScanSnapshotKey(snapshotId) {
const fromLong = keyFromMaybeFunction(
KEYS.long?.scan?.snapshot,
snapshotId,
null
);
if (fromLong) return namespacedLongKey(fromLong,
`SCAN:SNAPSHOT:${snapshotId}`);
const fromGenericLong = keyFromMaybeFunction(
KEYS.scan?.longSnapshot,
snapshotId,
null
);
if (fromGenericLong) return namespacedLongKey(fromGenericLong,
`SCAN:SNAPSHOT:${snapshotId}`);
const fromGeneric = keyFromMaybeFunction(
KEYS.scan?.snapshot,
snapshotId,

null
);
return namespacedLongKey(fromGeneric, `SCAN:SNAPSHOT:${snapshotId}`);
}
function longScanSnapshotPattern() {
const fromLong = keyFromMaybeFunction(
KEYS.long?.scan?.snapshot,
'*',
null
);
if (fromLong) return namespacedLongKey(fromLong, 'SCAN:SNAPSHOT:*');
const fromGenericLong = keyFromMaybeFunction(
KEYS.scan?.longSnapshot,
'*',
null
);
if (fromGenericLong) return namespacedLongKey(fromGenericLong,
'SCAN:SNAPSHOT:*');
const fromGeneric = keyFromMaybeFunction(
KEYS.scan?.snapshot,
'*',
null
);
return namespacedLongKey(fromGeneric, 'SCAN:SNAPSHOT:*');
}
const LONG_KEYS = {
scan: {
latest: namespacedLongKey(
KEYS.long?.scan?.latest ||
KEYS.scan?.longLatest ||
KEYS.scan?.latest,
'SCAN:LATEST'
),
snapshot: longScanSnapshotKey,
snapshotPattern: longScanSnapshotPattern
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
),
snapshotProgress: namespacedLongKey(
KEYS.long?.trade?.snapshotProgress ||
KEYS.trade?.longSnapshotProgress ||
KEYS.trade?.snapshotProgress,
'TRADE:SNAPSHOT_PROGRESS'
)
}
};
function isolationFlags() {
return {
runScope: RUN_SCOPE,
writeScope: WRITE_SCOPE,
readScope: READ_SCOPE,
namespace: LONG_NAMESPACE,
redisNamespace: LONG_NAMESPACE,
keyPrefix: LONG_KEY_PREFIX,
redisKeyPrefix: LONG_KEY_PREFIX,
persistentLearningKey: PERSISTENT_LEARNING_KEY,
measurementFixVersion: MEASUREMENT_FIX_VERSION,
acceptedOutcomeMeasurementVersion: MEASUREMENT_FIX_VERSION,
exitFillModelVersion: EXIT_FILL_MODEL_VERSION,
outcomeMeasurementGateMode: OUTCOME_MEASUREMENT_GATE_MODE,
empiricalVetoPolicyVersion: EMPIRICAL_VETO_POLICY_VERSION,
temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
temporalGenerationSchemaVersion: TEMPORAL_GENERATION_SCHEMA_VERSION,
temporalTaxonomyVersion: TEMPORAL_TAXONOMY_VERSION,
temporalCostModelVersion: TEMPORAL_COST_MODEL_VERSION,
temporalStatsEnabled: temporalRuntimeConfig().temporalStatsEnabled,
temporalPolicyMode: temporalRuntimeConfig().temporalPolicyMode,
weekendPolicyVersion: WEEKEND_POLICY_VERSION,
sessionPolicyVersion: SESSION_POLICY_VERSION,
weekendMode: temporalRuntimeConfig().temporalPolicyMode,
sessionMode: temporalRuntimeConfig().temporalPolicyMode,
weekendLearningAllowed: true,
weekendVirtualEntryAllowed: true,
weekendExitMonitoringAllowed: true,
weekendOutcomeRecordingAllowed: true,
sessionLearningAllowed: true,
sessionVirtualEntryAllowed: true,
sessionDiscordEntryAllowed: true,
sessionPolicyObservedOnly: true,
redisKeysSeparatedFromShortRoot: true,
adminPageIsolation: true,
doesNotOverwriteOtherAdminPages: true,
readsScannerLatest: true,
scannerLatestReadOnly: true,
preserveScannerLatest: true,
preserveScannerSnapshot: true,
preserveScannerHistory: true,
scannerRunAllowed: false,

scannerRunDisabledInsideTradeRun: true,
noScannerRun: true,
noScannerRefresh: true,
noScannerLatestWrite: true,
noScannerSnapshotWrite: true,
noScannerHistoryWrite: true,
writesScanner: false,
writesScannerLatest: false,
writesScannerSnapshot: false,
writesScannerHistory: false,
writesLiveCache: false,
liveCacheReadOnly: true,
writesTrade: true,
writesTradeRunMeta: true,
writesTradeLastProcessedSnapshot: true,
writesTradePositions: true,
writesAnalyze: true,
writesAnalyzePartial: true,
writesMicroFamilies: true,
microFamiliesAppendOnly: true,
microFamiliesAntiWipe: true,
analyzePartialOnly: true,
analyzeFullOverwriteDisabled: true,
writesRotation: false,
writesManualSelection: false,
writesDiscordSelection: false,
preserveRotation: true,
preserveManualSelection: true,
preserveDiscordSelection: true,
noResetCron: true,
resetCronDisabled: true,
noActivateCron: true,
activateCronDisabled: true,
noFreezeCron: true,
freezeCronDisabled: true,
autoRotationActivationDisabled: true,
manualSelectionPreserved: true,
realOrdersDisabled: true,
exchangeCallsDisabled: true,
exchangeOrdersDisabled: true,
bitgetOrdersDisabled: true,
noRealOrders: true,
noExchangeOrders: true,
ignoreGlobalMaxOpenPositions: true,
noGlobalMaxOpenPositionsBlock: true,
oneOpenPositionPerSymbol: true,
maxOneOpenPositionPerSymbol: true,

shortRootTouched: false
};
}
function sideFlags() {
return {
sideMode: 'LONG_ONLY',
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
longDisabled: false
};
}
function taxonomyFlags(row = {}) {
const taxonomy = parseLongTaxonomyMicroId(
row.childTrueMicroFamilyId ||
row.trueMicroFamilyId ||
row.microFamilyId ||
''
);
return {
trueMicroOnly: true,
exactTrueMicroOnly: true,
exactTrueMicroFamilyRequired: true,
fixedTaxonomyPreferred: true,
exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
microFamilySchema: TRUE_MICRO_SCHEMA,
schema: TRUE_MICRO_SCHEMA,
parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
learningGranularity: LEARNING_GRANULARITY,
parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
parentLearningEnabled: true,
childLearningEnabled: true,
selectionGranularity: 'EXACT_75_CHILD',
fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED',

setupType: taxonomy.setup || row.setupType || null,
regimeBucket: taxonomy.regime || row.regimeBucket || null,
confirmationProfile: taxonomy.confirmationProfile || row.confirmationProfile
|| null,
parentTrueMicroFamilyId: taxonomy.parentTrueMicroFamilyId ||
row.parentTrueMicroFamilyId || null,
childTrueMicroFamilyId: taxonomy.childTrueMicroFamilyId ||
row.childTrueMicroFamilyId || null,
coarseMicroFamilyId: taxonomy.parentTrueMicroFamilyId ||
row.coarseMicroFamilyId || null,
parent15MetadataOnly: true,
parentTrueMicroSelectable: false,
child75Selectable: Boolean(taxonomy.selectable)
};
}
function virtualFlags(row = {}) {
return {
virtualOnly: true,
virtualTracked: true,
virtualLearning: true,
source: 'VIRTUAL',
outcomeSource: 'VIRTUAL',
realTrade: false,
realOrder: false,
exchangeOrder: false,
bitgetOrderPlaced: false,
realOrdersDisabled: true,
exchangeCallsDisabled: true,
exchangeOrdersDisabled: true,
bitgetOrdersDisabled: true,
noExchangeOrders: true,
noRealOrders: true,
learningOnly: false,
microFamilyLearning: true,
scannerWideVirtualLearning: true,
tradeEveryScannerCandidateVirtual:
DEFAULT_TRADE_EVERY_SCANNER_CANDIDATE_VIRTUAL,
riskEnginePreferredButNotRequiredForLearning: true,
standardizedLearningRiskFallbackEnabled:
DEFAULT_ALLOW_STANDARDIZED_LEARNING_RISK_FALLBACK,
observationFirst: true,
observationFirstLearning: true,
everyAnalyzeRowCountsSeen: false,
observationAlwaysCounted: false,
observationDedupeRequired: true,
observationDedupeEnabled: true,
seenDefinition: 'UNIQUE_SNAPSHOT_SYMBOL_TRUE_MICRO_OBSERVATION_ONLY',

observationDedupeKeySource: 'snapshotId|symbol|trueMicroFamilyId|entry',
scannerFingerprintRole: 'METADATA_ONLY',
scannerFingerprintOnlyMetadata: true,
scannerFingerprintsMetadataOnly: true,
scannerFingerprintsUsedAsLearningFamily: false,
scannerBucketsMetadataOnly: true,
legacy25BucketsMetadataOnly: true,
executionFingerprintRole: 'METADATA_ONLY',
executionFingerprintOnlyMetadata: true,
executionFingerprintsMetadataOnly: true,
executionFingerprintsUsedAsLearningFamily: false,
learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
symbolExcludedFromFamilyId: true,
coinNameExcludedFromFamilyId: true,
hashesExcludedFromFamilyId: true,
entryRelaxationProfile: ENTRY_RELAXATION_PROFILE,
entrySlightlyLoosened: true,
qualityMeasurementProfile: QUALITY_MEASUREMENT_PROFILE,
noSyntheticShadowLayer: true,
disciplinedMeasurement: true,
recommendedFreezeDays: FREEZE_MEASUREMENT_RECOMMENDED_DAYS,
currentFitSoftOnly: true,
currentFitBlocksLearning: false,
currentFitBlocksVirtualLearning: false,
currentFitBlocksShadowLearning: false,
currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
learningRemainsBroad: true,
selectionIsAdaptive: true,
discordWillBeStrict: true,
discordOnlyForSelectedMicroFamilies: true,
discordOnlyForExactTrueMicroMatch: true,
discordRequiresCurrentFit: discordRequiresCurrentFit(),
manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
completedOnlyClosedVirtualOrShadow: true,
scoringRSource: 'netR',
winsLossesFlatsSource: 'netR',
winrateDefinition: 'netR > 0',
avgRSource: 'netR',
totalRSource: 'netR',
avgCostRShown: true,
avgCostRSource: 'costR',
defaultRanking:
'adaptiveScore|dashboardBalancedScore|balancedScore|fairWinrate|totalR|avgR|avgCostR',
defaultRankingNeverBareWinrate: true,
noBareWinrateRanking: true,

rawWinrateRankingDisabled: true,
minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,
learningStatusRules: {
OBSERVING: 'completed == 0',
EARLY_OUTCOMES: 'completed > 0 && completed < 20',
ACTIVE_LEARNING: 'completed >= 20 && completed < 35',
PASSED: 'completed >= 35 && avgR > 0',
EMPIRICAL_VETO: 'completed >= 35 && avgR <= 0'
},
completedThresholds: {
earlySignal: MIN_COMPLETED_EARLY_SIGNAL,
reasonableSignal: MIN_COMPLETED_REASONABLE_SIGNAL,
strongSignal: MIN_COMPLETED_STRONG_SIGNAL
},
riskTradeSide: TARGET_TRADE_SIDE,
validLongRiskShape: 'sl < entry < tp',
longRiskShape: 'sl < entry < tp',
riskGeometryRule: 'LONG: sl < entry < tp',
tpHitRule: 'LONG: price >= tp',
slHitRule: 'LONG: price <= sl',
grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
currentRFormula: '(currentPrice - entry) / (entry - initialSl)',
longGrossRFormula: '(exitPrice - entry) / (entry - initialSl)',
longCurrentRFormula: '(currentPrice - entry) / (entry - initialSl)',
...taxonomyFlags(row)
};
}
function cfgNumber(value, fallback) {
const n = safeNumber(value, fallback);
return Number.isFinite(n) ? n : fallback;
}
function cfgBoolean(value, fallback = false) {
if (value === undefined || value === null || value === '') return fallback;
const raw = String(value).trim().toLowerCase();
if (TRUE_VALUES.has(raw)) return true;
if (FALSE_VALUES.has(raw)) return false;
return fallback;
}
function positiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
const n = Math.floor(cfgNumber(value, fallback));
return Math.max(min, Math.min(max, n));
}
function clampNumber(value, min, max) {
const n = Number(value);
if (!Number.isFinite(n)) return min;
return Math.max(min, Math.min(max, n));
}

function ratio(part, total) {
const p = safeNumber(part, 0);
const t = safeNumber(total, 0);
if (t <= 0) return 0;
return p / t;
}
function pct(part, total) {
return Number((ratio(part, total) * 100).toFixed(2));
}
function tradeConfig() {
const configuredTradeMax = cfgNumber(
CONFIG.long?.trade?.maxCandidatesPerSnapshot ??
CONFIG.trade?.longMaxCandidatesPerSnapshot ??
CONFIG.trade?.maxCandidatesPerSnapshot,
0
);
const configuredAnalyzeMax = cfgNumber(
CONFIG.long?.trade?.analyzeMaxCandidatesPerSnapshot ??
CONFIG.long?.trade?.maxAnalyzeCandidatesPerSnapshot ??
CONFIG.trade?.longAnalyzeMaxCandidatesPerSnapshot ??
CONFIG.trade?.longMaxAnalyzeCandidatesPerSnapshot ??
CONFIG.trade?.analyzeMaxCandidatesPerSnapshot ??
CONFIG.trade?.maxAnalyzeCandidatesPerSnapshot ??
CONFIG.long?.scanner?.maxCandidates ??
CONFIG.scanner?.longMaxCandidates ??
CONFIG.scanner?.maxCandidates ??
CONFIG.long?.scanner?.analyzeMaxCandidates ??
CONFIG.scanner?.longAnalyzeMaxCandidates ??
CONFIG.scanner?.analyzeMaxCandidates,
DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT
);
const allowStandardizedLearningRiskFallback = cfgBoolean(
CONFIG.long?.trade?.allowStandardizedLearningRiskFallback ??
CONFIG.long?.trade?.allowLearningRiskFallback ??
CONFIG.long?.trade?.allowSyntheticRiskFallback ??
CONFIG.trade?.longAllowStandardizedLearningRiskFallback ??
CONFIG.trade?.longAllowLearningRiskFallback ??
CONFIG.trade?.longAllowSyntheticRiskFallback ??
CONFIG.trade?.allowStandardizedLearningRiskFallback ??
CONFIG.trade?.allowLearningRiskFallback ??
CONFIG.trade?.allowSyntheticRiskFallback,
DEFAULT_ALLOW_STANDARDIZED_LEARNING_RISK_FALLBACK
);
const allowStandardizedLearningRiskVirtualEntries = cfgBoolean(
CONFIG.long?.trade?.allowStandardizedLearningRiskVirtualEntries ??
CONFIG.long?.trade?.allowLearningRiskVirtualEntries ??
CONFIG.long?.trade?.allowSyntheticRiskVirtualEntries ??

CONFIG.trade?.longAllowStandardizedLearningRiskVirtualEntries ??
CONFIG.trade?.longAllowLearningRiskVirtualEntries ??
CONFIG.trade?.longAllowSyntheticRiskVirtualEntries ??
CONFIG.trade?.allowStandardizedLearningRiskVirtualEntries ??
CONFIG.trade?.allowLearningRiskVirtualEntries ??
CONFIG.trade?.allowSyntheticRiskVirtualEntries,
DEFAULT_ALLOW_STANDARDIZED_LEARNING_RISK_VIRTUAL_ENTRIES
);
return {
entryRelaxationProfile: ENTRY_RELAXATION_PROFILE,
qualityMeasurementProfile: QUALITY_MEASUREMENT_PROFILE,
scannerWideVirtualLearning: true,
tradeEveryScannerCandidateVirtual: cfgBoolean(
CONFIG.long?.trade?.tradeEveryScannerCandidateVirtual ??
CONFIG.trade?.longTradeEveryScannerCandidateVirtual ??
CONFIG.trade?.tradeEveryScannerCandidateVirtual,
DEFAULT_TRADE_EVERY_SCANNER_CANDIDATE_VIRTUAL
),
maxCandidatesPerSnapshot: positiveInt(
Math.max(
configuredTradeMax,
configuredAnalyzeMax,
cfgNumber(CONFIG.long?.scanner?.maxSymbols ??
CONFIG.scanner?.longMaxSymbols ?? CONFIG.scanner?.maxSymbols, 0),
cfgNumber(CONFIG.long?.scanner?.maxCandidates ??
CONFIG.scanner?.longMaxCandidates ?? CONFIG.scanner?.maxCandidates, 0),
cfgNumber(CONFIG.long?.scanner?.analyzeMaxCandidates ??
CONFIG.scanner?.longAnalyzeMaxCandidates ?? CONFIG.scanner?.analyzeMaxCandidates,
0),
DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT
),
DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT,
1,
1000
),
maxCandidatesPerInvocation: positiveInt(
CONFIG.long?.trade?.maxCandidatesPerInvocation ??
CONFIG.long?.trade?.candidateBatchSize ??
CONFIG.trade?.longMaxCandidatesPerInvocation ??
CONFIG.trade?.longCandidateBatchSize ??
CONFIG.trade?.maxCandidatesPerInvocation ??
CONFIG.trade?.candidateBatchSize,
DEFAULT_MAX_CANDIDATES_PER_INVOCATION,
10,
250
),
maxSnapshotAgeSec: cfgNumber(

CONFIG.long?.trade?.maxSnapshotAgeSec ??
CONFIG.trade?.longMaxSnapshotAgeSec ??
CONFIG.trade?.maxSnapshotAgeSec,
8 * 60
),
maxContinuationAgeSec: cfgNumber(
CONFIG.long?.trade?.maxContinuationAgeSec ??
CONFIG.trade?.longMaxContinuationAgeSec ??
CONFIG.trade?.maxContinuationAgeSec,
DEFAULT_MAX_CONTINUATION_AGE_SEC
),
dataConcurrency: positiveInt(
CONFIG.long?.trade?.dataConcurrency ??
CONFIG.trade?.longDataConcurrency ??
CONFIG.trade?.dataConcurrency,
8,
1,
20
),
maxSpreadPct: cfgNumber(
CONFIG.long?.trade?.maxSpreadPct ??
CONFIG.trade?.longMaxSpreadPct ??
CONFIG.trade?.maxSpreadPct,
0.0015
),
minLiveCandles15m: positiveInt(
CONFIG.long?.trade?.minLiveCandles15m ??
CONFIG.long?.trade?.minLiveCandles15M ??
CONFIG.long?.trade?.minCandles15m ??
CONFIG.long?.trade?.minCandles15M ??
CONFIG.trade?.longMinLiveCandles15m ??
CONFIG.trade?.longMinLiveCandles15M ??
CONFIG.trade?.longMinCandles15m ??
CONFIG.trade?.longMinCandles15M ??
CONFIG.trade?.minLiveCandles15m ??
CONFIG.trade?.minLiveCandles15M ??
CONFIG.trade?.minCandles15m ??
CONFIG.trade?.minCandles15M,
DEFAULT_MIN_LIVE_CANDLES_15M,
0,
100
),
candleLimit: positiveInt(
CONFIG.long?.trade?.candleLimit ??
CONFIG.trade?.longCandleLimit ??
CONFIG.trade?.candleLimit,
100,

30,
500
),
allowStandardizedLearningRiskFallback,
allowStandardizedLearningRiskVirtualEntries,
allowSyntheticRiskFallback: allowStandardizedLearningRiskFallback,
allowSyntheticRiskVirtualEntries: allowStandardizedLearningRiskVirtualEntries,
standardizedLearningRiskRequiresScannerGatePassed: cfgBoolean(
CONFIG.long?.trade?.standardizedLearningRiskRequiresScannerGatePassed ??
CONFIG.long?.trade?.syntheticRiskRequiresScannerGatePassed ??
CONFIG.trade?.longStandardizedLearningRiskRequiresScannerGatePassed ??
CONFIG.trade?.longSyntheticRiskRequiresScannerGatePassed ??
CONFIG.trade?.standardizedLearningRiskRequiresScannerGatePassed ??
CONFIG.trade?.syntheticRiskRequiresScannerGatePassed,
false
),
standardizedLearningRiskRequiresAnalyzeEligible: cfgBoolean(
CONFIG.long?.trade?.standardizedLearningRiskRequiresAnalyzeEligible ??
CONFIG.long?.trade?.syntheticRiskRequiresAnalyzeEligible ??
CONFIG.trade?.longStandardizedLearningRiskRequiresAnalyzeEligible ??
CONFIG.trade?.longSyntheticRiskRequiresAnalyzeEligible ??
CONFIG.trade?.standardizedLearningRiskRequiresAnalyzeEligible ??
CONFIG.trade?.syntheticRiskRequiresAnalyzeEligible,
false
),
standardizedLearningRiskRequiresSpreadGatePassed: cfgBoolean(
CONFIG.long?.trade?.standardizedLearningRiskRequiresSpreadGatePassed ??
CONFIG.long?.trade?.syntheticRiskRequiresSpreadGatePassed ??
CONFIG.trade?.longStandardizedLearningRiskRequiresSpreadGatePassed ??
CONFIG.trade?.longSyntheticRiskRequiresSpreadGatePassed ??
CONFIG.trade?.standardizedLearningRiskRequiresSpreadGatePassed ??
CONFIG.trade?.syntheticRiskRequiresSpreadGatePassed,
false
),
minRiskPct: cfgNumber(
CONFIG.long?.trade?.minRiskPct ??
CONFIG.trade?.longMinRiskPct ??
CONFIG.trade?.minRiskPct,
DEFAULT_MIN_RISK_PCT
),
maxRiskPct: cfgNumber(
CONFIG.long?.trade?.maxRiskPct ??
CONFIG.trade?.longMaxRiskPct ??
CONFIG.trade?.maxRiskPct,
DEFAULT_MAX_RISK_PCT
),
fallbackRiskPct: cfgNumber(

CONFIG.long?.trade?.fallbackRiskPct ??
CONFIG.trade?.longFallbackRiskPct ??
CONFIG.trade?.fallbackRiskPct,
DEFAULT_FALLBACK_RISK_PCT
),
defaultRR: cfgNumber(
CONFIG.long?.trade?.defaultRR ??
CONFIG.trade?.longDefaultRR ??
CONFIG.trade?.defaultRR,
1.5
),
minRR: cfgNumber(
CONFIG.long?.trade?.minRR ??
CONFIG.trade?.longMinRR ??
CONFIG.trade?.minRR,
0.5
),
positionTimeStopMin: cfgNumber(
CONFIG.long?.trade?.positionTimeStopMin ??
CONFIG.trade?.longPositionTimeStopMin ??
CONFIG.trade?.positionTimeStopMin,
720
),
runResponseActionLimit: positiveInt(
CONFIG.long?.trade?.runResponseActionLimit ??
CONFIG.trade?.longRunResponseActionLimit ??
CONFIG.trade?.runResponseActionLimit,
DEFAULT_RUN_RESPONSE_ACTION_LIMIT,
20,
500
)
};
}
function sizingConfig() {
return {
enabled: CONFIG.long?.sizing?.enabled ?? CONFIG.sizing?.longEnabled ??
CONFIG.sizing?.enabled ?? true,
baseRiskPct: cfgNumber(
CONFIG.long?.sizing?.baseRiskPct ??
CONFIG.sizing?.longBaseRiskPct ??
CONFIG.sizing?.baseRiskPct,
0.0025
)
};
}
function discordRequiresCurrentFit() {
return cfgBoolean(

CONFIG.long?.trade?.discordRequiresCurrentFit ??
CONFIG.trade?.longDiscordRequiresCurrentFit ??
CONFIG.trade?.discordRequiresCurrentFit,
DEFAULT_DISCORD_REQUIRE_CURRENT_FIT
);
}
function discordMinCurrentFitConfidence() {
return clampNumber(
CONFIG.long?.trade?.discordMinCurrentFitConfidence ??
CONFIG.trade?.longDiscordMinCurrentFitConfidence ??
CONFIG.trade?.discordMinCurrentFitConfidence,
0,
100
) || DEFAULT_DISCORD_MIN_CURRENT_FIT_CONFIDENCE;
}
function currentFitMaxWeatherAgeSec() {
return positiveInt(
CONFIG.long?.trade?.currentFitMaxWeatherAgeSec ??
CONFIG.trade?.longCurrentFitMaxWeatherAgeSec ??
CONFIG.trade?.currentFitMaxWeatherAgeSec,
DEFAULT_CURRENT_FIT_MAX_WEATHER_AGE_SEC,
30,
24 * 3600
);
}
function runtimeState(options = {}, startedAt = now()) {
const runtimeBudgetMs = Math.max(
5_000,
Math.min(
55_000,
Math.floor(
safeNumber(
options.runtimeBudgetMs,
DEFAULT_RUNTIME_BUDGET_MS
)
)
)
);
const deadlineAt = safeNumber(
options.deadlineAt,
startedAt + runtimeBudgetMs
);
const stopBeforeDeadlineMs = Math.max(
2_000,
Math.min(
15_000,
Math.floor(

safeNumber(
options.stopBeforeDeadlineMs,
DEFAULT_STOP_BEFORE_DEADLINE_MS
)
)
)
);
return {
runtimeBudgetMs,
deadlineAt,
stopBeforeDeadlineMs,
remainingMs() {
return Math.max(
0,
deadlineAt - now()
);
},
shouldStop(extraBufferMs = 0) {
return (
deadlineAt - now() <=
stopBeforeDeadlineMs +
Math.max(
0,
safeNumber(
extraBufferMs,
0
)
)
);
}
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
function compactTextForStorage(
value,
maxLength = 240
) {
const text =

String(value || '').trim();
if (!text) return null;
return text.length > maxLength
? text.slice(0, maxLength)
: text;
}
function compactStringArrayForStorage(
values = [],
limit = 24,
maxLength = 180
) {
return (
Array.isArray(values)
? values
: []
)
.map(
(value) =>
compactTextForStorage(
value,
maxLength
)
)
.filter(Boolean)
.slice(0, limit);
}
function compactMarketWeatherForStorage(
value = null
) {
const weather =
value &&
typeof value === 'object' &&
!Array.isArray(value)
? value
: {};
if (!Object.keys(weather).length) {
return null;
}
return {
ok:
weather.ok !== false,
available:
weather.available !== false,
version:
compactTextForStorage(
weather.version,
100

),
source:
compactTextForStorage(
weather.source,
60
),
snapshotId:
compactTextForStorage(
weather.snapshotId,
160
),
generatedAt:
safeNumber(
weather.generatedAt,
0
) || null,
createdAt:
safeNumber(
weather.createdAt,
0
) || null,
completedAt:
safeNumber(
weather.completedAt,
0
) || null,
updatedAt:
safeNumber(
weather.updatedAt,
0
) || null,
currentRegime:
compactTextForStorage(
weather.currentRegime ||
weather.regime,
60
),
regime:
compactTextForStorage(
weather.regime ||
weather.currentRegime,
60
),
currentTrendSide:
compactTextForStorage(
weather.currentTrendSide ||
weather.trendSide,

60
),
trendSide:
compactTextForStorage(
weather.trendSide ||
weather.currentTrendSide,
60
),
currentFlow:
compactTextForStorage(
weather.currentFlow ||
weather.flow,
80
),
flow:
compactTextForStorage(
weather.flow ||
weather.currentFlow,
80
),
currentVolatilityState:
compactTextForStorage(
weather.currentVolatilityState ||
weather.volatilityState,
80
),
volatilityState:
compactTextForStorage(
weather.volatilityState ||
weather.currentVolatilityState,
80
),
confidence:
safeNumber(
weather.confidence ??
weather.weatherConfidence,
0
),
weatherConfidence:
safeNumber(
weather.weatherConfidence ??
weather.confidence,
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
rowsExcluded:
true,
symbolsExcluded:
true
};
}
function compactMarketUniverseForStorage(
value = null
) {
const universe =
value &&
typeof value === 'object' &&
!Array.isArray(value)
? value
: {};
if (!Object.keys(universe).length) {
return null;
}
return {
ok:
universe.ok !== false,
source:
compactTextForStorage(
universe.source,
60

),
snapshotId:
compactTextForStorage(
universe.snapshotId,
160
),
createdAt:
safeNumber(
universe.createdAt ??
universe.completedAt ??
universe.updatedAt,
0
) || null,
count:
safeNumber(
universe.count ??
universe.universeCount ??
universe.rows?.length ??
universe.symbols?.length,
0
),
universeCount:
safeNumber(
universe.universeCount ??
universe.count ??
universe.rows?.length ??
universe.symbols?.length,
0
),
currentRegime:
compactTextForStorage(
universe.currentRegime ||
universe.regime,
60
),
currentTrendSide:
compactTextForStorage(
universe.currentTrendSide ||
universe.trendSide,
60
),
bearishPct:
safeNumber(
universe.bearishPct,
0
),
bullishPct:

safeNumber(
universe.bullishPct,
0
),
squeezePct:
safeNumber(
universe.squeezePct,
0
),
rowsExcluded:
true,
symbolsExcluded:
true
};
}
function compactStatsForStorage(
value = null
) {
const stats =
value &&
typeof value === 'object' &&
!Array.isArray(value)
? value
: null;
if (!stats) return null;
return {
microFamilyId:
stats.microFamilyId ||
stats.trueMicroFamilyId ||
null,
trueMicroFamilyId:
stats.trueMicroFamilyId ||
stats.microFamilyId ||
null,
parentTrueMicroFamilyId:
stats.parentTrueMicroFamilyId ||
stats.familyId ||
null,
completed:
safeNumber(
stats.completed,
0
),
seen:
safeNumber(
stats.seen ??
stats.observations,

0
),
wins:
safeNumber(
stats.wins,
0
),
losses:
safeNumber(
stats.losses,
0
),
flats:
safeNumber(
stats.flats,
0
),
winrate:
safeNumber(
stats.winrate ??
stats.fairWinrate,
0
),
fairWinrate:
safeNumber(
stats.fairWinrate ??
stats.winrate,
0
),
totalR:
safeNumber(
stats.totalR ??
stats.netTotalR,
0
),
avgR:
safeNumber(
stats.avgR,
0
),
avgCostR:
safeNumber(
stats.avgCostR,
0
),
balancedScore:
safeNumber(

stats.balancedScore ??
stats.dashboardBalancedScore,
0
),
dashboardBalancedScore:
safeNumber(
stats.dashboardBalancedScore ??
stats.balancedScore,
0
),
status:
compactTextForStorage(
stats.status,
60
),
compactStats:
true
};
}
function stripHeavyTradeRow(
row = {}
) {
if (
!row ||
typeof row !== 'object' ||
Array.isArray(row)
) {
return row;
}
const out = {
...row
};
out.currentMarketWeather =
compactMarketWeatherForStorage(
row.currentMarketWeather
);
out.entryMarketWeather =
compactMarketWeatherForStorage(
row.entryMarketWeather
);
out.marketWeather =
compactMarketWeatherForStorage(
row.marketWeather
);
out.currentMarketUniverse =
compactMarketUniverseForStorage(
row.currentMarketUniverse

);
out.entryMarketUniverse =
compactMarketUniverseForStorage(
row.entryMarketUniverse
);
out.marketUniverse =
compactMarketUniverseForStorage(
row.marketUniverse
);
if (row.selectedWeeklyStats) {
out.selectedWeeklyStats =
compactStatsForStorage(
row.selectedWeeklyStats
);
}
if (row.weeklyStats) {
out.weeklyStats =
compactStatsForStorage(
row.weeklyStats
);
}
const listFields = [
'definitionParts',
'microDefinitionParts',
'macroDefinitionParts',
'parentDefinitionParts',
'scannerDefinitionParts',
'scannerMacroDefinitionParts',
'executionFingerprintParts'
];
for (const field of listFields) {
if (Array.isArray(row[field])) {
out[field] =
compactStringArrayForStorage(
row[field]
);
}
}
const removeFields = [
'candles',
'candles15m',
'candles1h',
'candles4h',
'klines',
'ohlcv',
'rawCandles',
'rawOrderBook',

'orderBook',
'bids',
'asks',
'marketWeatherRows',
'marketUniverseRows',
'candidateRows',
'scannerRows',
'allCandidates',
'fullScannerPayload'
];
for (const field of removeFields) {
if (field in out) {
delete out[field];
}
}
return out;
}
function compactVirtualExitForStorage(
outcome = {}
) {
const row =
stripHeavyTradeRow(outcome);
return {
action:
'VIRTUAL_EXIT',
reason:
row.exitReason ||
row.reason ||
'VIRTUAL_POSITION_CLOSED',
source:
'VIRTUAL',
outcomeSource:
'VIRTUAL',
symbol:
row.symbol ||
null,
contractSymbol:
row.contractSymbol ||
null,
trueMicroFamilyId:
getTrueMicroFamilyId(row) ||
null,
childTrueMicroFamilyId:
getTrueMicroFamilyId(row) ||
null,
parentTrueMicroFamilyId:
getParentTrueMicroFamilyId(row) ||

null,
setupType:
row.setupType ||
null,
regimeBucket:
row.regimeBucket ||
null,
confirmationProfile:
row.confirmationProfile ||
null,
exitReason:
row.exitReason ||
null,
exitPrice:
row.exitPrice ??
null,
grossR:
row.grossR ??
row.realizedGrossR ??
row.longGrossR ??
null,
netR:
row.netR ??
row.realizedR ??
row.r ??
null,
realizedR:
row.realizedR ??
row.netR ??
row.r ??
null,
costR:
row.costR ??
null,
entry:
row.entry ??
null,
initialSl:
row.initialSl ??
row.sl ??
null,
sl:
row.sl ??
null,
tp:
row.tp ??
null,

currentPrice:
row.currentPrice ??
row.lastPrice ??
row.exitPrice ??
null,
ageSec:
row.ageSec ??
null,
currentR:
row.currentR ??
row.longCurrentR ??
null,
directToSL:
Boolean(
row.directToSL ||
row.directSL
),
directSL:
Boolean(
row.directSL ||
row.directToSL
),
entryMarketWeather:
compactMarketWeatherForStorage(
row.entryMarketWeather
),
entryCurrentFit:
row.entryCurrentFit ||
row.currentFit ||
null,
entryCurrentFitConfidence:
row.entryCurrentFitConfidence ??
row.currentFitConfidence ??
null,
...sideFlags(),
...virtualFlags(row),
...isolationFlags()
};
}
function compactActionForStorage(
row = {}
) {
const compact =
stripHeavyTradeRow(row);
return {
action:
compact.action ||

compact.type ||
'UNKNOWN',
reason:
compact.reason ||
compact.liveEntryBlockedReason ||
null,
symbol:
compact.symbol ||
null,
contractSymbol:
compact.contractSymbol ||
null,
trueMicroFamilyId:
getTrueMicroFamilyId(compact) ||
null,
parentTrueMicroFamilyId:
getParentTrueMicroFamilyId(compact) ||
null,
entry:
safeNumber(
compact.entry,
0
) || null,
sl:
safeNumber(
compact.sl,
0
) || null,
tp:
safeNumber(
compact.tp,
0
) || null,
rr:
safeNumber(
compact.rr,
0
) || null,
currentFit:
compact.currentFit ||
compact.entryCurrentFit ||
null,
currentFitConfidence:
compact.currentFitConfidence ??
compact.entryCurrentFitConfidence ??
null,
discordAlertEligible:

Boolean(
compact.discordAlertEligible
),
selectedMicroFamilyAlert:
Boolean(
compact.selectedMicroFamilyAlert
)
};
}
function compactRunMetaForStorage(
result = {}
) {
const actions =
Array.isArray(result.actions)
? result.actions
: [];
const virtualExits =
Array.isArray(result.virtualExits)
? result.virtualExits
: Array.isArray(result.shadowExits)
? result.shadowExits
: [];
const compact = {
...result,
actions:
actions
.slice(
0,
DEFAULT_RUN_META_ACTION_SAMPLE_LIMIT
)
.map(
compactActionForStorage
),
actionsCount:
safeNumber(
result.actionsCount,
actions.length
),
rawActionsCount:
safeNumber(
result.rawActionsCount,
actions.length
),
responseActionsTruncated:
actions.length >
DEFAULT_RUN_META_ACTION_SAMPLE_LIMIT,
virtualExits:

virtualExits
.slice(
0,
DEFAULT_RUN_META_ACTION_SAMPLE_LIMIT
)
.map(
compactVirtualExitForStorage
),
shadowExits:
virtualExits
.slice(
0,
DEFAULT_RUN_META_ACTION_SAMPLE_LIMIT
)
.map(
compactVirtualExitForStorage
),
realExits:
[],
currentMarketWeather:
compactMarketWeatherForStorage(
result.currentMarketWeather
),
currentMarketUniverse:
compactMarketUniverseForStorage(
result.currentMarketUniverse
),
marketContext:
result.marketContext
? {
ok:
Boolean(
result.marketContext.ok
),
createdAt:
result.marketContext.createdAt ||
null,
ageSec:
result.marketContext.ageSec ??
null,
stale:
Boolean(
result.marketContext.stale
),
regime:
result.marketContext.regime ||
'UNKNOWN',

trendSide:
result.marketContext.trendSide ||
'UNKNOWN',
bearishPct:
result.marketContext.bearishPct ??
null,
bullishPct:
result.marketContext.bullishPct ??
null,
squeezePct:
result.marketContext.squeezePct ??
null,
confidence:
result.marketContext.confidence ??
null,
source:
compactMarketWeatherForStorage(
result.marketContext.source
),
universe:
compactMarketUniverseForStorage(
result.marketContext.universe
)
}
: null,
selectedMicroFamilyIds:
Array.isArray(
result.selectedMicroFamilyIds
)
? result.selectedMicroFamilyIds
.slice(0, 75)
: [],
selectedTrueMicroFamilyIds:
Array.isArray(
result.selectedTrueMicroFamilyIds
)
? result.selectedTrueMicroFamilyIds
.slice(0, 75)
: [],
selectedChildTrueMicroFamilyIds:
Array.isArray(
result.selectedChildTrueMicroFamilyIds
)
? result.selectedChildTrueMicroFamilyIds
.slice(0, 75)
: [],
selectedParentTrueMicroFamilyIds:

Array.isArray(
result.selectedParentTrueMicroFamilyIds
)
? result.selectedParentTrueMicroFamilyIds
.slice(0, 15)
: [],
activeMicroFamilyIds:
Array.isArray(
result.activeMicroFamilyIds
)
? result.activeMicroFamilyIds
.slice(0, 75)
: [],
activeTrueMicroFamilyIds:
Array.isArray(
result.activeTrueMicroFamilyIds
)
? result.activeTrueMicroFamilyIds
.slice(0, 75)
: [],
activeChildTrueMicroFamilyIds:
Array.isArray(
result.activeChildTrueMicroFamilyIds
)
? result.activeChildTrueMicroFamilyIds
.slice(0, 75)
: [],
activeParentTrueMicroFamilyIds:
Array.isArray(
result.activeParentTrueMicroFamilyIds
)
? result.activeParentTrueMicroFamilyIds
.slice(0, 15)
: [],
compactPersistence:
true,
fullPayloadPersisted:
false,
actionsPersisted:
false,
scannerRowsPersisted:
false,
marketWeatherRowsPersisted:
false,
marketUniverseRowsPersisted:
false,
candidateRowsPersisted:

false,
candleDataPersisted:
false
};
const compactBytes =
jsonByteLength(compact);
if (
compactBytes <=
DEFAULT_MAX_TRADE_RUN_META_BYTES
) {
return {
...compact,
runMetaBytes:
compactBytes,
maxRunMetaBytes:
DEFAULT_MAX_TRADE_RUN_META_BYTES,
runMetaFallbackUsed:
false
};
}
return {
ok:
compact.ok !== false,
runId:
compact.runId ||
null,
startedAt:
compact.startedAt ||
null,
completedAt:
compact.completedAt ||
now(),
durationMs:
safeNumber(
compact.durationMs,
0
),
reason:
compact.reason ||
compact.skipReason ||
null,
skipReason:
compact.skipReason ||
compact.reason ||
null,
skippedNewEntries:
Boolean(

compact.skippedNewEntries
),
snapshotId:
compact.snapshotId ||
null,
snapshotCreatedAt:
compact.snapshotCreatedAt ||
null,
snapshotAgeSec:
safeNumber(
compact.snapshotAgeSec,
0
),
candidateStartIndex:
safeNumber(
compact.candidateStartIndex,
0
),
candidateEndExclusive:
safeNumber(
compact.candidateEndExclusive,
0
),
nextCandidateIndex:
safeNumber(
compact.nextCandidateIndex,
0
),
snapshotCandidateCount:
safeNumber(
compact.snapshotCandidateCount,
0
),
snapshotProcessingComplete:
Boolean(
compact.snapshotProcessingComplete
),
candidateOrderVersion:
compact.candidateOrderVersion ||
null,
candidateRotationOffset:
safeNumber(
compact.candidateRotationOffset,
0
),
candidateOrderDeterministic:
Boolean(

compact.candidateOrderDeterministic
),
legacyProgressOrderPreserved:
Boolean(
compact.legacyProgressOrderPreserved
),
snapshotSelectionPolicy:
compact.snapshotSelectionPolicy ||
SNAPSHOT_SELECTION_POLICY,
resumedUnfinishedSnapshot:
Boolean(
compact.resumedUnfinishedSnapshot
),
continuationProgressStale:
Boolean(
compact.continuationProgressStale
),
batchProcessingComplete:
Boolean(
compact.batchProcessingComplete
),
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
liveRows:
safeNumber(
compact.liveRows,
0
),
analyzedRows:
safeNumber(
compact.analyzedRows,
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
virtualExits.length
),
actionCounts:
compact.actionCounts ||
actionCounts(actions),
actions:
actions
.slice(0, 10)
.map(
compactActionForStorage
),
virtualExits:
virtualExits
.slice(0, 10)
.map(
compactVirtualExitForStorage
),
currentMarketWeather:
compactMarketWeatherForStorage(
result.currentMarketWeather
),
currentMarketUniverse:
compactMarketUniverseForStorage(
result.currentMarketUniverse
),
selectedRotationId:
compact.selectedRotationId ||
compact.activeRotationId ||
null,
selectedMicroFamilyIds:
Array.isArray(
compact.selectedMicroFamilyIds
)
? compact.selectedMicroFamilyIds
.slice(0, 75)

: [],
analyzeError:
compact.analyzeError ||
null,
analyzeBatchMeta:
compact.analyzeBatchMeta ||
null,
runtimeBudgetMs:
safeNumber(
compact.runtimeBudgetMs,
0
),
remainingRuntimeMs:
safeNumber(
compact.remainingRuntimeMs,
0
),
compactPersistence:
true,
fullPayloadPersisted:
false,
actionsPersisted:
false,
scannerRowsPersisted:
false,
marketWeatherRowsPersisted:
false,
marketUniverseRowsPersisted:
false,
candidateRowsPersisted:
false,
candleDataPersisted:
false,
runMetaBytes:
compactBytes,
maxRunMetaBytes:
DEFAULT_MAX_TRADE_RUN_META_BYTES,
runMetaFallbackUsed:
true,
...sideFlags(),
...virtualFlags(),
...isolationFlags()
};
}
function positionSymbolKey(
row = {}
) {

return (
normalizeBaseSymbol(
row.symbol ||
row.baseSymbol ||
row.contractSymbol
) || ''
);
}
function stableStringHash(value = '') {
const text = String(value || '');
let hash = 2166136261;
for (let index = 0; index < text.length; index += 1) {
hash ^= text.charCodeAt(index);
hash = Math.imul(hash, 16777619);
}
return hash >>> 0;
}
function normalizeRotationOffset(value, length) {
const size = Math.max(
0,
Math.floor(
safeNumber(
length,
0
)
)
);
if (size <= 0) return 0;
const raw = Math.floor(
safeNumber(
value,
0
)
);
return (
(
raw % size
) +
size
) % size;
}
function deterministicCandidateRotationOffset(
snapshotId,
candidateCount
) {
const count = Math.max(
0,

Math.floor(
safeNumber(
candidateCount,
0
)
)
);
if (count <= 1) return 0;
return stableStringHash(
`${LONG_NAMESPACE}|${snapshotId}|${CANDIDATE_ORDER_VERSION}`
) % count;
}
function buildSnapshotCandidateOrder({
snapshotId,
candidates = [],
progress = null
} = {}) {
const rows =
Array.isArray(candidates)
? [...candidates]
: [];
const hasMatchingProgress =
Boolean(
progress &&
progress.snapshotId === snapshotId
);
const progressVersion =
hasMatchingProgress
? String(
progress.candidateOrderVersion ||
''
).trim()
: '';
const resumeLegacyOrder =
hasMatchingProgress &&
!progressVersion &&
safeNumber(
progress.nextCandidateIndex,
0
) > 0;
const candidateOrderVersion =
resumeLegacyOrder ||
progressVersion ===
LEGACY_CANDIDATE_ORDER_VERSION
? LEGACY_CANDIDATE_ORDER_VERSION
: CANDIDATE_ORDER_VERSION;
if (

rows.length <= 1 ||
candidateOrderVersion ===
LEGACY_CANDIDATE_ORDER_VERSION
) {
return {
candidates:
rows,
candidateOrderVersion,
candidateRotationOffset:
0,
candidateOrderDeterministic:
candidateOrderVersion ===
CANDIDATE_ORDER_VERSION,
legacyProgressOrderPreserved:
resumeLegacyOrder ||
candidateOrderVersion ===
LEGACY_CANDIDATE_ORDER_VERSION
};
}
const calculatedOffset =
deterministicCandidateRotationOffset(
snapshotId,
rows.length
);
const candidateRotationOffset =
hasMatchingProgress &&
progressVersion ===
CANDIDATE_ORDER_VERSION
? normalizeRotationOffset(
progress.candidateRotationOffset,
rows.length
)
: calculatedOffset;
const rotated =
candidateRotationOffset === 0
? rows
: [
...rows.slice(
candidateRotationOffset
),
...rows.slice(
0,
candidateRotationOffset
)
];
return {
candidates:

rotated,
candidateOrderVersion:
CANDIDATE_ORDER_VERSION,
candidateRotationOffset,
candidateOrderDeterministic:
true,
legacyProgressOrderPreserved:
false
};
}
async function loadSnapshotProgress(
redis,
snapshotId = null
) {
const value =
await getJson(
redis,
LONG_KEYS.trade.snapshotProgress,
null
).catch(() => null);
if (
!value ||
typeof value !== 'object' ||
!value.snapshotId
) {
return null;
}
if (
snapshotId &&
value.snapshotId !== snapshotId
) {
return null;
}
return value;
}
async function saveSnapshotProgress(
redis,
progress = {}
) {
return scopedSetJson(
redis,
LONG_KEYS.trade.snapshotProgress,
{
...progress,
snapshotId:
progress.snapshotId ||
null,

nextCandidateIndex:
Math.max(
0,
Math.floor(
safeNumber(
progress.nextCandidateIndex,
0
)
)
),
snapshotCandidateCount:
Math.max(
0,
Math.floor(
safeNumber(
progress.snapshotCandidateCount,
0
)
)
),
candidateOrderVersion:
progress.candidateOrderVersion ||
CANDIDATE_ORDER_VERSION,
candidateRotationOffset:
Math.max(
0,
Math.floor(
safeNumber(
progress.candidateRotationOffset,
0
)
)
),
candidateOrderDeterministic:
progress.candidateOrderDeterministic !== false,
legacyProgressOrderPreserved:
Boolean(
progress.legacyProgressOrderPreserved
),
snapshotSelectionPolicy:
SNAPSHOT_SELECTION_POLICY,
completed:
Boolean(
progress.completed
),
updatedAt:
now(),

currentMarketWeather:
compactMarketWeatherForStorage(
progress.currentMarketWeather
),
currentMarketUniverse:
compactMarketUniverseForStorage(
progress.currentMarketUniverse
),
fullPayloadPersisted:
false,
candidateRowsPersisted:
false,
marketWeatherRowsPersisted:
false,
marketUniverseRowsPersisted:
false,
candleDataPersisted:
false,
...sideFlags(),
...isolationFlags()
}
);
}
async function clearSnapshotProgress(
redis
) {
return delJson(
redis,
LONG_KEYS.trade.snapshotProgress
).catch(() => 0);
}
function actionCounts(actions = []) {
return actions.reduce((acc, row) => {
const key = row?.action || row?.type || 'UNKNOWN';
acc[key] = (acc[key] || 0) + 1;
return acc;
}, {});
}
function reasonCounts(actions = []) {
return actions.reduce((acc, row) => {
const key = row?.reason || row?.liveEntryBlockedReason || 'UNKNOWN_REASON';
acc[key] = (acc[key] || 0) + 1;
return acc;
}, {});
}
function topReasonCounts(actions = [], limit = 10) {
return Object.entries(reasonCounts(actions))

.sort((a, b) => b[1] - a[1])
.slice(0, limit)
.map(([reason, count]) => ({
reason,
count
}));
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
function cleanSideText(value = '') {
return upper(value, '')
.replaceAll('SHORT_DISABLED_TRUE', 'LONG')
.replaceAll('SHORTDISABLED_TRUE', 'LONG')
.replaceAll('BLOCK_SHORT_TRUE', 'LONG')
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
.replaceAll('LONG_ONLY_MODE', 'LONG')
.replaceAll('LONG_ONLY', 'LONG')
.replaceAll('LONG-ONLY', 'LONG')
.replaceAll('SHORT_ONLY_MODE', 'SHORT')
.replaceAll('SHORT_ONLY', 'SHORT')
.replaceAll('SHORT-ONLY', 'SHORT');
}
function normalizedSignalText(value = '') {
return cleanSideText(value)
.replace(/[^A-Z0-9]+/g, '_')
.replace(/^_+|_+$/g, '');
}
function hasSignalPattern(value = '', patterns = []) {
const text = normalizedSignalText(value);
if (!text) return false;
return patterns.some((pattern) => (
text === pattern ||
text.startsWith(`${pattern}_`) ||
text.endsWith(`_${pattern}`) ||
text.includes(`_${pattern}_`)
));
}
function hasLongSignal(value = '') {
const raw = normalizedSignalText(value);
if (!raw) return false;
if (LONG_TOKENS.has(raw)) return true;
return hasSignalPattern(raw, [
'LONG',
'BULL',
'BULLISH',
'BUY',
'SIDE_LONG',
'TRADE_SIDE_LONG',
'TRADESIDE_LONG',
'POSITION_SIDE_LONG',
'POSITIONSIDE_LONG',
'DIRECTION_LONG',
'SIDE_BULL',
'TRADE_SIDE_BULL',

'DIRECTION_BULL',
'SIDE_BUY',
'DIRECTION_BUY',
'MICRO_LONG',
'FAMILY_LONG'
]);
}
function hasShortSignal(value = '') {
const raw = normalizedSignalText(value);
if (!raw) return false;
if (SHORT_TOKENS.has(raw)) return true;
return hasSignalPattern(raw, [
'SHORT',
'BEAR',
'BEARISH',
'SELL',
'SIDE_SHORT',
'TRADE_SIDE_SHORT',
'TRADESIDE_SHORT',
'POSITION_SIDE_SHORT',
'POSITIONSIDE_SHORT',
'DIRECTION_SHORT',
'SIDE_BEAR',
'TRADE_SIDE_BEAR',
'DIRECTION_BEAR',
'SIDE_SELL',
'DIRECTION_SELL',
'MICRO_SHORT',
'FAMILY_SHORT'
]);
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
value.includes('EXECUTIONMICRO') ||
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
for (const candidateRegime of REGIME_ORDER) {
const suffix = `_${candidateRegime}`;
if (body.endsWith(suffix)) {
regime = candidateRegime;
setup = body.slice(0, -suffix.length);
break;

}
}
const parentId = setup && regime ? `MICRO_LONG_${setup}_${regime}` : null;
const childId = parentId && confirmationProfile ?
`${parentId}_${confirmationProfile}` : null;
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
parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
learningGranularity: LEARNING_GRANULARITY,
parentLearningGranularity: PARENT_LEARNING_GRANULARITY
};
}
function isSelectableTrueMicroId(id = '') {
const parsed = parseLongTaxonomyMicroId(id);
return Boolean(parsed.selectable && parsed.childTrueMicroFamilyId);
}
function isParentTrueMicroId(id = '') {
const parsed = parseLongTaxonomyMicroId(id);
return Boolean(parsed.isParent && !parsed.selectable);
}
function exactChildId(id = '') {
const parsed = parseLongTaxonomyMicroId(id);
return parsed.selectable ? parsed.childTrueMicroFamilyId : '';
}
function parentIdFromChild(id = '') {
const parsed = parseLongTaxonomyMicroId(id);
return parsed.parentTrueMicroFamilyId || '';

}
function normalizeSymbolToken(value = '') {
return String(value || '')
.toUpperCase()
.replace(/USDT|USDC|USD|PERP|SWAP|FUTURES|SPOT/g, '')
.replace(/[^A-Z0-9]+/g, '_')
.replace(/^_+|_+$/g, '');
}
function symbolTokensFromRow(row = {}) {
return [
row.symbol,
row.baseSymbol,
row.contractSymbol
]
.map(normalizeSymbolToken)
.filter(Boolean)
.filter((token) => token.length >= 2);
}
function stripSymbolTokensFromFamilyId(id = '', row = {}) {
const raw = String(id || '').trim();
if (!raw) return raw;
if (isSelectableTrueMicroId(raw) || isParentTrueMicroId(raw)) {
return raw.toUpperCase();
}
const tokens = symbolTokensFromRow(row);
if (!tokens.length) return raw;
let next = raw;
for (const token of tokens) {
const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
next = next
.replace(new RegExp(`(^|[_|:=\\-])${escaped}([_|:=\\-]|$)`, 'gi'),
'$1ASSET$2')
.replace(new RegExp(`(^|[_|:=\\-])${escaped}USDT([_|:=\\-]|$)`, 'gi'),
'$1ASSET$2')
.replace(new RegExp(`(^|[_|:=\\-])${escaped}USDC([_|:=\\-]|$)`, 'gi'),
'$1ASSET$2');
}
return next
.replace(/_{2,}/g, '_')
.replace(/\|{2,}/g, '|')
.replace(/^[_|:=\-\s]+|[_|:=\-\s]+$/g, '') || raw;
}
function cleanLearningFamilyId(id = '', row = {}) {
const raw = String(id || '').trim();
if (!raw) return '';
if (isScannerFingerprintId(raw)) return '';
if (isExecutionFingerprintId(raw)) return '';

const clean = stripSymbolTokensFromFamilyId(raw, row);
if (!clean) return '';
if (isScannerFingerprintId(clean)) return '';
if (isExecutionFingerprintId(clean)) return '';
return clean.toUpperCase();
}
function getTrueMicroFamilyId(row = {}) {
const direct = [
row.childTrueMicroFamilyId,
row.trueMicroFamilyId,
row.learningMicroFamilyId,
row.analyzeMicroFamilyId,
row.microFamilyId
]
.map((id) => cleanLearningFamilyId(id, row))
.find((id) => isSelectableTrueMicroId(id));
return direct || '';
}
function getParentTrueMicroFamilyId(row = {}) {
const child = getTrueMicroFamilyId(row);
if (child) return parentIdFromChild(child);
const parent = [
row.parentTrueMicroFamilyId,
row.coarseMicroFamilyId,
row.parentMicroFamilyId,
row.parentMacroFamilyId,
row.macroFamilyId
]
.map((id) => cleanLearningFamilyId(id, row))
.find((id) => isParentTrueMicroId(id));
return parent || '';
}
function normalizeCandidate(candidate = {}) {
const contractSymbol = normalizeContractSymbol(
candidate.contractSymbol ||
candidate.symbol
);
const symbol =
normalizeBaseSymbol(candidate.symbol || contractSymbol) ||
normalizeBaseSymbol(contractSymbol);
return {
...candidate,
symbol,
baseSymbol: symbol,
contractSymbol
};
}

function scannerMicroFamilyIdFrom(row = {}) {
return (
row.scannerMicroFamilyId ||
(isScannerFingerprintId(row.microFamilyId) ? row.microFamilyId : null) ||
(isScannerFingerprintId(row.trueMicroFamilyId) ? row.trueMicroFamilyId : null)
||
(isScannerFingerprintId(row.id) ? row.id : null) ||
(isScannerFingerprintId(row.key) ? row.key : null) ||
null
);
}
function scannerFamilyIdFrom(row = {}) {
return (
row.scannerFamilyId ||
(isScannerFingerprintId(row.familyId) ? row.familyId : null) ||
(isScannerFingerprintId(row.baseFamilyId) ? row.baseFamilyId : null) ||
null
);
}
function executionMicroFamilyIdFrom(row = {}) {
return (
row.executionMicroFamilyId ||
(isExecutionFingerprintId(row.microFamilyId) ? row.microFamilyId : null) ||
(isExecutionFingerprintId(row.trueMicroFamilyId) ? row.trueMicroFamilyId :
null) ||
(isExecutionFingerprintId(row.analyzeMicroFamilyId) ? row.analyzeMicroFamilyId
: null) ||
null
);
}
function scannerMetadataFrom(...rows) {
const merged = Object.assign({}, ...rows.filter(Boolean));
const scannerMicroFamilyId = rows.map(scannerMicroFamilyIdFrom).find(Boolean) ||
null;
const scannerFamilyId = rows.map(scannerFamilyIdFrom).find(Boolean) || null;
const executionMicroFamilyId =
rows.map(executionMicroFamilyIdFrom).find(Boolean) || null;
return {
scannerMicroFamilyId,
scannerFamilyId,
scannerDefinition: merged.scannerDefinition || (
scannerMicroFamilyId
? merged.definition || merged.microDefinition || null
: null
),
scannerDefinitionParts: Array.isArray(merged.scannerDefinitionParts)
? merged.scannerDefinitionParts

: scannerMicroFamilyId && Array.isArray(merged.definitionParts)
? merged.definitionParts
: [],
executionMicroFamilyId,
executionFingerprintRole: 'METADATA_ONLY',
executionFingerprintOnlyMetadata: Boolean(executionMicroFamilyId),
executionFingerprintsMetadataOnly: true,
executionFingerprintsUsedAsLearningFamily: false,
scannerFingerprintRole: 'METADATA_ONLY',
scannerFingerprintOnlyMetadata: true,
scannerFingerprintsMetadataOnly: true,
scannerFingerprintsUsedAsLearningFamily: false,
scannerBucketsMetadataOnly: true,
legacy25BucketsMetadataOnly: true,
learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
exactTrueMicroFamilyRequired: true,
symbolExcludedFromFamilyId: true,
coinNameExcludedFromFamilyId: true,
hashesExcludedFromFamilyId: true,
fixedTaxonomyPreferred: true
};
}
function normalizeTradeSide(side) {
const raw = cleanSideText(side);
if (!raw) return 'UNKNOWN';
const direct = sideToTradeSide(raw);
if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
if (LONG_TOKENS.has(raw)) return TARGET_TRADE_SIDE;
if (SHORT_TOKENS.has(raw)) return OPPOSITE_TRADE_SIDE;
const longHit = hasLongSignal(raw);
const shortHit = hasShortSignal(raw);
if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;
if (longHit && !shortHit) return TARGET_TRADE_SIDE;
if (longHit && shortHit) {
if (raw.includes('TRADESIDE=LONG') || raw.includes('TRADE_SIDE=LONG'))
return TARGET_TRADE_SIDE;
if (raw.includes('TRADESIDE=SHORT') || raw.includes('TRADE_SIDE=SHORT')) return
OPPOSITE_TRADE_SIDE;
if (raw.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
if (raw.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
}
if (longHit) return TARGET_TRADE_SIDE;
if (shortHit) return OPPOSITE_TRADE_SIDE;
return 'UNKNOWN';
}
function inferSideFromIds(row = {}) {

const haystack = [
row.familyId,
row.family,
row.baseFamilyId,
row.childTrueMicroFamilyId,
row.trueMicroFamilyId,
row.microFamilyId,
row.analyzeMicroFamilyId,
row.learningMicroFamilyId,
row.coarseMicroFamilyId,
row.baseMicroFamilyId,
row.legacyMicroFamilyId,
row.liveMicroFamilyId,
row.realMicroFamilyId,
row.executionMicroFamilyId,
row.scannerMicroFamilyId,
row.scannerFamilyId,
row.parentTrueMicroFamilyId,
row.macroFamilyId,
row.parentMacroFamilyId,
row.parentMicroFamilyId,
row.parentFamilyId,
row.macroId,
row.id,
row.key
]
.map((value) => cleanSideText(value))
.filter(Boolean)
.join('|');
if (!haystack) return 'UNKNOWN';
const longHit = hasLongSignal(haystack);
const shortHit = hasShortSignal(haystack);
if (longHit && !shortHit) return TARGET_TRADE_SIDE;
if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;
if (longHit && shortHit) {
if (haystack.includes('TRADESIDE=LONG') ||
haystack.includes('TRADE_SIDE=LONG')) return TARGET_TRADE_SIDE;
if (haystack.includes('TRADESIDE=SHORT') ||
haystack.includes('TRADE_SIDE=SHORT')) return OPPOSITE_TRADE_SIDE;
if (haystack.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
if (haystack.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
}
return 'UNKNOWN';
}
function inferSideFromDefinitions(row = {}) {
const haystack = [
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
.filter(Boolean)
.join('|');
if (!haystack) return 'UNKNOWN';
const longHit = hasLongSignal(haystack);
const shortHit = hasShortSignal(haystack);
if (longHit && !shortHit) return TARGET_TRADE_SIDE;
if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;
if (longHit && shortHit) {
if (haystack.includes('TRADESIDE=LONG') ||
haystack.includes('TRADE_SIDE=LONG')) return TARGET_TRADE_SIDE;
if (haystack.includes('TRADESIDE=SHORT') ||
haystack.includes('TRADE_SIDE=SHORT')) return OPPOSITE_TRADE_SIDE;
if (haystack.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
if (haystack.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
}
return 'UNKNOWN';
}
function inferRowTradeSide(row = {}) {
if (typeof row !== 'object' || row === null) {
return normalizeTradeSide(row);
}
const directSources = [
row.tradeSide,
row.positionSide,
row.direction,
row.scannerSide,
row.actualScannerSide,
row.analysisSide,
row.signalSide,
row.entrySide,
row.side
];
for (const value of directSources) {
const direct = normalizeTradeSide(value);
if (KNOWN_TRADE_SIDES.has(direct)) return direct;

}
const fromIds = inferSideFromIds(row);
if (KNOWN_TRADE_SIDES.has(fromIds)) return fromIds;
const fromDefinitions = inferSideFromDefinitions(row);
if (KNOWN_TRADE_SIDES.has(fromDefinitions)) return fromDefinitions;
if (row.longOnly === true || row.shortDisabled === true) {
return TARGET_TRADE_SIDE;
}
if (row.shortOnly === true || row.longDisabled === true) {
return OPPOSITE_TRADE_SIDE;
}
return 'UNKNOWN';
}
function isTargetRow(row = {}) {
return inferRowTradeSide(row) === TARGET_TRADE_SIDE;
}
function isMirrorAnalysisRow(row = {}) {
return Boolean(
row.isMirrorMicroFamily ||
row.observationMirror ||
row.analysisMirror ||
row.mirrorAnalysisOnly
);
}
function isLiveScannerRow(row = {}) {
return !isMirrorAnalysisRow(row);
}
function normalizeExactTrueMicroRow(row = {}) {
const trueMicroFamilyId = getTrueMicroFamilyId(row);
const parsed = parseLongTaxonomyMicroId(trueMicroFamilyId);
if (!trueMicroFamilyId || !parsed.selectable) {
return {
...row,
exact75ChildTrueMicro: false,
trueMicroFamilyId: null,
microFamilyId: null,
childTrueMicroFamilyId: null,
parentTrueMicroFamilyId: getParentTrueMicroFamilyId(row) || null,
exactTrueMicroMissingReason: 'EXACT_75_CHILD_TRUE_MICRO_REQUIRED'
};
}
return {
...row,
trueMicroFamilyId,
microFamilyId: trueMicroFamilyId,
analyzeMicroFamilyId: trueMicroFamilyId,
learningMicroFamilyId: trueMicroFamilyId,

childTrueMicroFamilyId: trueMicroFamilyId,
parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
coarseMicroFamilyId: parsed.parentTrueMicroFamilyId,
baseMicroFamilyId: parsed.parentTrueMicroFamilyId,
legacyMicroFamilyId: parsed.parentTrueMicroFamilyId,
familyId: trueMicroFamilyId,
setupType: parsed.setup,
regimeBucket: parsed.regime,
confirmationProfile: parsed.confirmationProfile,
exact75ChildTrueMicro: true,
fixedTaxonomyLearningId: true,
...taxonomyFlags({
...row,
trueMicroFamilyId
})
};
}
function normalizeMarketRegime(value = '') {
const text = upper(value);
if (!text) return 'UNKNOWN';
if (text.includes('SQUEEZE') || text.includes('COMPRESS')) return 'SQUEEZE';
if (text.includes('CHOP') || text.includes('RANGE') || text.includes('SIDEWAY'))
return 'CHOP';
if (text.includes('TREND') || text.includes('MOMENTUM') ||
text.includes('DIRECTION')) return 'TREND';
return 'UNKNOWN';
}
function normalizeMarketTrendSide(value = '') {
const side = normalizeTradeSide(value);
if (side === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
if (side === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
const text = upper(value);
if (!text) return 'UNKNOWN';
if (text.includes('NEUTRAL') || text.includes('MIXED') || text.includes('FLAT'))
return 'NEUTRAL';
if (text.includes('RISK_OFF')) return TARGET_TRADE_SIDE;
if (text.includes('RISK_ON')) return OPPOSITE_TRADE_SIDE;
return 'UNKNOWN';
}
function firstFinite(...values) {
for (const value of values) {
const n = Number(value);
if (Number.isFinite(n)) return n;
}
return null;
}
function extractMarketWeatherShape(weather = {}, universe = {}) {

const source = weather && typeof weather === 'object' ? weather : {};
const universeSource = universe && typeof universe === 'object' ? universe : {};
const createdAt = safeNumber(
source.createdAt ??
source.completedAt ??
source.updatedAt ??
source.ts ??
universeSource.createdAt ??
universeSource.completedAt ??
universeSource.updatedAt ??
universeSource.ts,
0
);
const regime = normalizeMarketRegime(
source.currentRegime ??
source.regime ??
source.marketRegime ??
source.breadthRegime ??
source.volatilityRegime ??
universeSource.currentRegime ??
universeSource.regime
);
const trendSide = normalizeMarketTrendSide(
source.currentTrendSide ??
source.trendSide ??
source.marketSide ??
source.side ??
source.direction ??
source.breadthSide ??
source.btcTrendSide ??
universeSource.currentTrendSide ??
universeSource.trendSide ??
universeSource.marketSide
);
const bearishPct = firstFinite(
source.bearishPct,
source.shortPct,
source.upPct,
source.breadthBearishPct,
source.universeBearishPct,
universeSource.bearishPct,
universeSource.shortPct,
universeSource.upPct
);
const bullishPct = firstFinite(
source.bullishPct,
source.longPct,

source.downPct,
source.breadthBullishPct,
source.universeBullishPct,
universeSource.bullishPct,
universeSource.longPct,
universeSource.downPct
);
const squeezePct = firstFinite(
source.squeezePct,
source.compressionPct,
source.breadthSqueezePct,
universeSource.squeezePct,
universeSource.compressionPct
);
const confidence = clampNumber(
firstFinite(
source.confidence,
source.weatherConfidence,
source.currentTrendConfidence,
source.breadthConfidence,
universeSource.confidence
) ?? 50,
0,
100
);
const stale = createdAt > 0
? (now() - createdAt) / 1000 > currentFitMaxWeatherAgeSec()
: true;
return {
ok: Boolean(source && Object.keys(source).length),
source,
universe: universeSource,
createdAt,
ageSec: createdAt > 0 ? Math.round((now() - createdAt) / 1000) : null,
stale,
regime,
trendSide,
bearishPct,
bullishPct,
squeezePct,
confidence,
key: MARKET_WEATHER_KEY,
universeKey: MARKET_UNIVERSE_KEY
};
}
async function loadMarketContext() {
const redis = getVolatileRedis();

const [weather, universe] = await Promise.all([
getJson(redis, MARKET_WEATHER_KEY, null).catch(() => null),
getJson(redis, MARKET_UNIVERSE_KEY, null).catch(() => null)
]);
return extractMarketWeatherShape(weather || {}, universe || {});
}
function scoreMarketFit(row = {}, marketContext = {}) {
if (!marketContext?.ok) {
return {
currentFit: 'UNKNOWN',
currentFitScore: 0,
currentFitConfidence: 0,
currentFitReason: 'MARKET_WEATHER_UNAVAILABLE',
currentFitSoftOnly: true,
currentFitBlocksLearning: false,
currentFitBlocksVirtualLearning: false,
currentFitBlocksShadowLearning: false,
currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT'
};
}
if (marketContext.stale) {
return {
currentFit: 'UNKNOWN',
currentFitScore: 0,
currentFitConfidence: 0,
currentFitReason: 'MARKET_WEATHER_STALE',
currentFitSoftOnly: true,
currentFitBlocksLearning: false,
currentFitBlocksVirtualLearning: false,
currentFitBlocksShadowLearning: false,
currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT'
};
}
const familyRegime = normalizeMarketRegime(row.regimeBucket || row.regime ||
row.regimeCoarse);
const confirmation = upper(row.confirmationProfile);
const marketRegime = marketContext.regime;
const trendSide = marketContext.trendSide;
let score = 0;
const reasons = [];
if (trendSide === TARGET_TRADE_SIDE) {
score += 30;
reasons.push('MARKET_TREND_LONG');
} else if (trendSide === 'NEUTRAL' || trendSide === 'UNKNOWN') {
score += 4;

reasons.push('MARKET_TREND_NEUTRAL_OR_UNKNOWN');
} else {
score -= 45;
reasons.push('MARKET_TREND_AGAINST_LONG');
}
if (familyRegime !== 'UNKNOWN' && marketRegime !== 'UNKNOWN') {
if (familyRegime === marketRegime) {
score += 25;
reasons.push('FAMILY_REGIME_MATCH');
} else if (
(familyRegime === 'TREND' && marketRegime === 'SQUEEZE') ||
(familyRegime === 'SQUEEZE' && marketRegime === 'TREND')
) {
score += 8;
reasons.push('FAMILY_REGIME_ADJACENT');
} else {
score -= 15;
reasons.push('FAMILY_REGIME_MISMATCH');
}
} else {
reasons.push('FAMILY_OR_MARKET_REGIME_UNKNOWN');
}
const bearishPct = marketContext.bearishPct;
const bullishPct = marketContext.bullishPct;
const squeezePct = marketContext.squeezePct;
if (Number.isFinite(bullishPct)) {
if (bullishPct >= 60) {
score += 15;
reasons.push('BULLISH_BREADTH_STRONG');
} else if (bullishPct >= 50) {
score += 8;
reasons.push('BULLISH_BREADTH_OK');
} else if (bullishPct < 40) {
score -= 12;
reasons.push('BULLISH_BREADTH_WEAK');
}
}
if (Number.isFinite(bearishPct) && bearishPct >= 60) {
score -= 20;
reasons.push('BEARISH_BREADTH_STRONG');
}
if (familyRegime === 'SQUEEZE' && Number.isFinite(squeezePct) && squeezePct >=
40) {
score += 10;
reasons.push('SQUEEZE_BREADTH_SUPPORTS_SETUP');
}
if (confirmation === 'A_STRONG_ALIGN') score += 8;

if (confirmation === 'B_FLOW_ALIGN') score += 5;
if (confirmation === 'C_VOLUME_ALIGN') score += 3;
if (confirmation === 'E_WEAK_CONTRA') {
score -= 18;
reasons.push('WEAK_CONTRA_CONFIRMATION');
}
const confidence = clampNumber(
marketContext.confidence + Math.min(20, Math.abs(score) / 2),
0,
100
);
const finalScore = clampNumber(score, -100, 100);
let currentFit = 'NEUTRAL';
if (finalScore >= 45) currentFit = 'MATCH';
else if (finalScore >= 18) currentFit = 'WEAK_MATCH';
else if (finalScore <= -25) currentFit = 'MISFIT';
return {
currentFit,
currentFitScore: Number(finalScore.toFixed(4)),
currentFitConfidence: Number(confidence.toFixed(2)),
currentFitReason: reasons.join('|') || 'NO_CURRENT_FIT_REASON',
currentFitSoftOnly: true,
currentFitBlocksLearning: false,
currentFitBlocksVirtualLearning: false,
currentFitBlocksShadowLearning: false,
currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT'
};
}
function attachCurrentFitContext(row = {}, marketContext = {}) {
const fit = scoreMarketFit(row, marketContext);
return {
...row,
currentMarketWeather: marketContext?.source || null,
currentMarketUniverse: marketContext?.universe || null,
currentMarketWeatherKey: MARKET_WEATHER_KEY,
currentMarketUniverseKey: MARKET_UNIVERSE_KEY,
currentMarketWeatherAgeSec: marketContext?.ageSec ?? null,
currentMarketWeatherStale: Boolean(marketContext?.stale),
currentRegime: marketContext?.regime || 'UNKNOWN',
currentTrendSide: marketContext?.trendSide || 'UNKNOWN',
currentBearishPct: marketContext?.bearishPct ?? null,
currentBullishPct: marketContext?.bullishPct ?? null,
currentSqueezePct: marketContext?.squeezePct ?? null,
entryMarketWeather: marketContext?.source || null,
entryCurrentRegime: marketContext?.regime || 'UNKNOWN',
entryCurrentTrendSide: marketContext?.trendSide || 'UNKNOWN',

entryCurrentFit: fit.currentFit,
entryCurrentFitConfidence: fit.currentFitConfidence,
entryWeatherFitMatchedFamily: fit.currentFit === 'MATCH' || fit.currentFit ===
'WEAK_MATCH',
...fit
};
}
function discordCurrentFitGate(row = {}) {
if (!discordRequiresCurrentFit()) {
return {
ok: true,
reason: 'CURRENT_FIT_NOT_REQUIRED_BY_CONFIG',
currentFit: row.currentFit || row.entryCurrentFit || 'NOT_REQUIRED',
currentFitConfidence: safeNumber(row.currentFitConfidence ??
row.entryCurrentFitConfidence, 0)
};
}
const fit = upper(row.currentFit || row.entryCurrentFit);
const confidence = safeNumber(row.currentFitConfidence ??
row.entryCurrentFitConfidence, 0);
if (!fit || fit === 'UNKNOWN') {
return {
ok: false,
reason: 'DISCORD_BLOCKED_CURRENT_FIT_UNKNOWN',
currentFit: fit || 'UNKNOWN',
currentFitConfidence: confidence
};
}
if (confidence < discordMinCurrentFitConfidence()) {
return {
ok: false,
reason: 'DISCORD_BLOCKED_CURRENT_FIT_CONFIDENCE_TOO_LOW',
currentFit: fit,
currentFitConfidence: confidence,
minCurrentFitConfidence: discordMinCurrentFitConfidence()
};
}
if (fit === 'MATCH' || fit === 'WEAK_MATCH') {
return {
ok: true,
reason: 'DISCORD_CURRENT_FIT_OK',
currentFit: fit,
currentFitConfidence: confidence
};
}
return {
ok: false,

reason: `DISCORD_BLOCKED_CURRENT_FIT_${fit}`,
currentFit: fit,
currentFitConfidence: confidence
};
}
function buildAnalysisVariant(candidate = {}, side, scannerSide) {
const tradeSide = normalizeTradeSide(side);
const actualScannerSide = normalizeTradeSide(scannerSide);
if (tradeSide !== TARGET_TRADE_SIDE) return null;
if (actualScannerSide !== TARGET_TRADE_SIDE) return null;
return {
...candidate,
...scannerMetadataFrom(candidate),
...sideFlags(),
...isolationFlags(),
...virtualFlags(candidate),
isMirrorMicroFamily: false,
observationMirror: false,
analysisMirror: false,
mirrorAnalysisOnly: false,
analyzeOnly: Boolean(candidate.analyzeOnly),
discoveryOnly: Boolean(candidate.discoveryOnly),
tradeDiscoveryOnly: Boolean(candidate.tradeDiscoveryOnly)
};
}
function waitAction(candidate, reason, extra = {}) {
const tradeSide = inferRowTradeSide(candidate);
return {
action: 'WAIT',
reason,
symbol: candidate?.symbol || null,
contractSymbol: candidate?.contractSymbol || null,
side: tradeSide === TARGET_TRADE_SIDE ? TARGET_DASHBOARD_SIDE :
candidate?.side || null,
tradeSide,
snapshotId: candidate?.snapshotId || null,
scannerScore: candidate?.scannerScore ?? candidate?.moveScore ?? null,
virtualTracked: false,
liveEligible: false,
discordAlertEligible: false,
currentFit: candidate?.currentFit || candidate?.entryCurrentFit || null,
currentFitScore: candidate?.currentFitScore ?? null,
currentFitConfidence: candidate?.currentFitConfidence ??
candidate?.entryCurrentFitConfidence ?? null,
currentFitSoftOnly: true,
currentFitBlocksLearning: false,
currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',

currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
...sideFlags(),
...virtualFlags(candidate),
...isolationFlags(),
...extra
};
}
function buildVirtualExitAction(outcome = {}) {
const trueMicroFamilyId = getTrueMicroFamilyId(outcome);
const parentTrueMicroFamilyId = getParentTrueMicroFamilyId(outcome);
const parsed = parseLongTaxonomyMicroId(trueMicroFamilyId);
return {
action: 'VIRTUAL_EXIT',
reason: outcome.exitReason || outcome.reason || 'VIRTUAL_POSITION_CLOSED',
source: 'VIRTUAL',
outcomeSource: 'VIRTUAL',
virtualOnly: true,
virtualTracked: true,
shadowOnly: false,
symbol: outcome.symbol || null,
contractSymbol: outcome.contractSymbol || null,
microFamilyId: trueMicroFamilyId || null,
trueMicroFamilyId: trueMicroFamilyId || null,
childTrueMicroFamilyId: trueMicroFamilyId || null,
parentTrueMicroFamilyId: parentTrueMicroFamilyId || null,
coarseMicroFamilyId: parentTrueMicroFamilyId || null,
setupType: parsed.setup || outcome.setupType || null,
regimeBucket: parsed.regime || outcome.regimeBucket || null,
confirmationProfile: parsed.confirmationProfile || outcome.confirmationProfile
|| null,
exact75ChildTrueMicro: Boolean(trueMicroFamilyId),
trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
learningGranularity: LEARNING_GRANULARITY,
parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
scannerMicroFamilyId: outcome.scannerMicroFamilyId || null,
scannerFingerprintRole: 'METADATA_ONLY',
scannerFingerprintOnlyMetadata: true,
scannerFingerprintsMetadataOnly: true,
scannerFingerprintsUsedAsLearningFamily: false,
executionMicroFamilyId: outcome.executionMicroFamilyId || null,
executionFingerprintRole: 'METADATA_ONLY',
executionFingerprintOnlyMetadata: Boolean(outcome.executionMicroFamilyId),
executionFingerprintsMetadataOnly: true,
executionFingerprintsUsedAsLearningFamily: false,
learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',

exactTrueMicroFamilyRequired: true,
symbolExcludedFromFamilyId: true,
coinNameExcludedFromFamilyId: true,
hashesExcludedFromFamilyId: true,
exitReason: outcome.exitReason || null,
exitPrice: outcome.exitPrice ?? null,
grossR: outcome.grossR ?? outcome.realizedGrossR ?? outcome.longGrossR ??
null,
netR: outcome.netR ?? outcome.realizedR ?? outcome.r ?? null,
realizedR: outcome.realizedR ?? outcome.netR ?? outcome.r ?? null,
costR: outcome.costR ?? null,
avgCostR: outcome.avgCostR ?? outcome.costR ?? null,
currentPrice: outcome.currentPrice ?? outcome.lastPrice ?? outcome.exitPrice
?? null,
lastPrice: outcome.lastPrice ?? outcome.currentPrice ?? outcome.exitPrice ??
null,
entry: outcome.entry ?? null,
sl: outcome.sl ?? null,
tp: outcome.tp ?? null,
ageSec: outcome.ageSec ?? null,
currentR: outcome.currentR ?? outcome.longCurrentR ?? null,
mfeR: outcome.mfeR ?? null,
maeR: outcome.maeR ?? null,
reachedHalfR: Boolean(outcome.reachedHalfR),
reachedOneR: Boolean(outcome.reachedOneR),
nearTpSeen: Boolean(outcome.nearTpSeen),
directToSL: Boolean(outcome.directToSL || outcome.directSL),
directSL: Boolean(outcome.directSL || outcome.directToSL),
tpHitNow: Boolean(outcome.tpHitNow || outcome.longTpHit || outcome.exitReason
=== 'TP'),
slHitNow: Boolean(outcome.slHitNow || outcome.longSlHit || outcome.exitReason
=== 'SL'),
timeStopHitNow: Boolean(outcome.timeStopHitNow || outcome.exitReason ===
'TIME_STOP'),
riskGeometryRule: 'LONG: sl < entry < tp',
tpHitRule: 'LONG: price >= tp',
slHitRule: 'LONG: price <= sl',
grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
currentRFormula: '(currentPrice - entry) / (entry - initialSl)',
entryMarketWeather: outcome.entryMarketWeather || null,
entryCurrentRegime: outcome.entryCurrentRegime || outcome.currentRegime ||
null,
entryCurrentTrendSide: outcome.entryCurrentTrendSide ||
outcome.currentTrendSide || null,
entryCurrentFit: outcome.entryCurrentFit || outcome.currentFit || null,
entryCurrentFitConfidence: outcome.entryCurrentFitConfidence ??
outcome.currentFitConfidence ?? null,

entryWeatherFitMatchedFamily: outcome.entryWeatherFitMatchedFamily ?? null,
currentFitSoftOnly: true,
currentFitBlocksLearning: false,
currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
discordExitAlertSent: Boolean(outcome.discordExitAlertSent),
realTrade: false,
realOrdersDisabled: true,
bitgetOrdersDisabled: true,
realOrder: false,
exchangeOrder: false,
bitgetOrderPlaced: false,
entryRelaxationProfile: ENTRY_RELAXATION_PROFILE,
qualityMeasurementProfile: QUALITY_MEASUREMENT_PROFILE,
...sideFlags(),
...isolationFlags()
};
}
function buildVirtualExitActions(exits = []) {
return (Array.isArray(exits) ? exits : [])
.filter(Boolean)
.map(buildVirtualExitAction);
}
function buildRunActionCounts(actions = [], virtualExits = []) {
return actionCounts([
...(Array.isArray(actions) ? actions : []),
...buildVirtualExitActions(virtualExits)
]);
}
function rowMicroAliasIds(row = {}) {
return uniqueStrings([
row.childTrueMicroFamilyId,
row.trueMicroFamilyId,
row.learningMicroFamilyId,
row.analyzeMicroFamilyId,
row.microFamilyId
])
.map((id) => cleanLearningFamilyId(id, row))
.filter((id) => isSelectableTrueMicroId(id));
}
function parentContextIds(row = {}) {
return uniqueStrings([
row.parentTrueMicroFamilyId,
row.coarseMicroFamilyId,
row.parentMicroFamilyId,
row.parentMacroFamilyId,
row.macroFamilyId,

parentIdFromChild(getTrueMicroFamilyId(row))
])
.map((id) => cleanLearningFamilyId(id, row))
.filter((id) => isParentTrueMicroId(id));
}
function isTrueMicroFamilyRow(row = {}) {
if (!row) return false;
if (!isTargetRow(row)) return false;
if (isScannerFingerprintId(row.trueMicroFamilyId || row.microFamilyId)) return
false;
if (isExecutionFingerprintId(row.trueMicroFamilyId || row.microFamilyId)) return
false;
return Boolean(getTrueMicroFamilyId(row));
}
function buildSelectedAlertContext(activeRotation) {
const rawRows = Array.isArray(activeRotation?.microFamilies)
? activeRotation.microFamilies
: [];
const rowByMicroId = new Map();
for (const row of rawRows) {
const normalized = normalizeExactTrueMicroRow(row);
const childId = getTrueMicroFamilyId(normalized);
if (childId) {
rowByMicroId.set(childId, normalized);
}
}
const configuredIds = uniqueStrings([
activeRotation?.microFamilyIds || [],
activeRotation?.activeMicroFamilyIds || [],
activeRotation?.trueMicroFamilyIds || [],
activeRotation?.childTrueMicroFamilyIds || [],
activeRotation?.ids || [],
rawRows.map(getTrueMicroFamilyId)
]);
const selectedMicroFamilyIds = uniqueStrings(
configuredIds
.map((id) => cleanLearningFamilyId(id, {}))
.filter((id) => isSelectableTrueMicroId(id))
);
const selectedMicroSet = new Set(selectedMicroFamilyIds);
const selectedParentTrueMicroFamilyIds = uniqueStrings([
activeRotation?.parentTrueMicroFamilyIds || [],
activeRotation?.parentMicroFamilyIds || [],
activeRotation?.macroFamilyIds || [],
activeRotation?.activeMacroFamilyIds || [],
selectedMicroFamilyIds.map(parentIdFromChild),
rawRows.flatMap(parentContextIds)

])
.map((id) => cleanLearningFamilyId(id, {}))
.filter((id) => isParentTrueMicroId(id));
const microToParentTrueMicroFamilyId = {};
for (const childId of selectedMicroFamilyIds) {
microToParentTrueMicroFamilyId[childId] = parentIdFromChild(childId);
}
return {
rotationId: activeRotation?.rotationId || null,
selectedRotation: activeRotation || null,
selectedMicroFamilyIds,
selectedTrueMicroFamilyIds: selectedMicroFamilyIds,
selectedChildTrueMicroFamilyIds: selectedMicroFamilyIds,
selectedMicroSet,
selectedParentTrueMicroFamilyIds,
selectedMacroFamilyIds: [],
rowByMicroId,
microToParentTrueMicroFamilyId,
trueMicroOnly: true,
exactTrueMicroOnly: true,
allowCoarseMicroAliasLiveEntries: false,
allowCoarseMicroAliasForDiscord: false,
empty: !selectedMicroFamilyIds.length,
targetTradeSide: TARGET_TRADE_SIDE,
dashboardSide: TARGET_DASHBOARD_SIDE,
oppositeTradeSide: OPPOSITE_TRADE_SIDE,
longOnly: true,
shortDisabled: true,
shortOnly: false,
longDisabled: false,
selectionPurpose: 'DISCORD_ALERT_ONLY',
manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
discordSelectionRule: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY',
discordRequiresCurrentFit: discordRequiresCurrentFit(),
...taxonomyFlags(),
...isolationFlags()
};
}
function rowMatchesSelectedAlertMicro(alertContext, row = {}) {
if (!alertContext || alertContext.empty) return false;
if (!isTrueMicroFamilyRow(row)) return false;
const exactTrueMicroId = getTrueMicroFamilyId(row);
if (!exactTrueMicroId) return false;
if (!isSelectableTrueMicroId(exactTrueMicroId)) return false;
return alertContext.selectedMicroSet.has(exactTrueMicroId);
}
function getSelectedWeeklyStats(alertContext, microFamilyId, row = {}) {

if (!alertContext) return null;
const exactId = getTrueMicroFamilyId({
...row,
trueMicroFamilyId: microFamilyId || row.trueMicroFamilyId
});
if (!exactId) return null;
return alertContext.rowByMicroId.get(exactId) || null;
}
function hasValidRiskShape(row = {}) {
const entry = safeNumber(row.entry, 0);
const sl = safeNumber(row.sl, 0);
const tp = safeNumber(row.tp, 0);
const rr = safeNumber(row.rr, 0);
const tradeSide = inferRowTradeSide(row);
if (row.learningOnly === true) return false;
if (tradeSide !== TARGET_TRADE_SIDE) return false;
if (entry <= 0 || sl <= 0 || tp <= 0 || rr <= 0) return false;
return sl < entry && entry < tp;
}
function validateVirtualEntry(row = {}) {
const cfg = tradeConfig();
const tradeSide = inferRowTradeSide(row);
const trueMicroFamilyId = getTrueMicroFamilyId(row);
if (tradeSide !== TARGET_TRADE_SIDE) {
return {
ok: false,
reason: 'SHORT_DISABLED_LONG_ONLY_SYSTEM',
tradeSide
};
}
if (isMirrorAnalysisRow(row)) {
return {
ok: false,
reason: 'MIRROR_ANALYSIS_ONLY'
};
}
if (!trueMicroFamilyId) {
return {
ok: false,
reason: 'ANALYZE_EXACT_75_CHILD_TRUE_MICRO_FAMILY_REQUIRED'
};
}
if (!isSelectableTrueMicroId(trueMicroFamilyId)) {
return {
ok: false,
reason: 'ENTRY_REQUIRES_EXACT_75_CHILD_TRUE_MICRO_FAMILY'
};

}
if (isScannerFingerprintId(trueMicroFamilyId)) {
return {
ok: false,
reason: 'SCANNER_FINGERPRINT_METADATA_ONLY'
};
}
if (isExecutionFingerprintId(trueMicroFamilyId)) {
return {
ok: false,
reason: 'EXECUTION_FINGERPRINT_METADATA_ONLY'
};
}
if (!isTrueMicroFamilyRow(row)) {
return {
ok: false,
reason: 'ENTRY_REQUIRES_TRUE_ANALYZE_MICRO_FAMILY'
};
}
if (row.standardizedLearningRisk &&
!cfg.allowStandardizedLearningRiskVirtualEntries) {
return {
ok: false,
reason: 'STANDARDIZED_LEARNING_RISK_NOT_ALLOWED_FOR_VIRTUAL_TRACKING',
standardizedLearningRisk: true,
riskSource: row.riskSource || null
};
}
if (row.syntheticRisk && !cfg.allowSyntheticRiskVirtualEntries) {
return {
ok: false,
reason: 'SYNTHETIC_RISK_NOT_ALLOWED_FOR_VIRTUAL_TRACKING',
syntheticRisk: true,
syntheticRiskReason: row.syntheticRiskReason || null
};
}
if (!hasValidRiskShape(row)) {
return {
ok: false,
reason: row.liveEntryBlockedReason || 'LONG_RISK_INVALID'
};
}
return {
ok: true,
reason: row.standardizedLearningRisk
? 'LONG_VIRTUAL_LEARNING_STANDARDIZED_TP_SL'
: row.syntheticRisk

? 'LONG_VIRTUAL_RISK_VALID_SYNTHETIC_EXPLICITLY_ENABLED'
: 'LONG_VIRTUAL_RISK_ENGINE_VALID'
};
}
async function fetchLiveCandidateData(candidate) {
const cfg = tradeConfig();
const normalized = normalizeCandidate(candidate);
const symbol = normalized.contractSymbol;
if (!symbol) {
return {
symbol,
ob: {
fetchFailed: true,
mid: 0,
bias: 'NEUTRAL',
spreadPct: CONFIG.long?.cost?.fallbackSpreadPct ||
CONFIG.cost?.longFallbackSpreadPct || CONFIG.cost?.fallbackSpreadPct || 0.0008,
depthMinUsd1p: 0
},
funding: { rate: 0, fetchFailed: true },
candles15m: [],
candles1h: []
};
}
const [rawOrderBook, funding, candles15m, candles1h] = await Promise.all([
fetchOrderBook(symbol).catch(() => null),
fetchFunding(symbol).catch(() => ({ rate: 0, fetchFailed: true })),
fetchCandles(symbol, '15m', cfg.candleLimit).catch(() => []),
fetchCandles(symbol, '1h', cfg.candleLimit).catch(() => [])
]);
const ob = analyzeOrderBook(rawOrderBook);
return {
symbol,
ob,
funding,
candles15m: Array.isArray(candles15m) ? candles15m : [],
candles1h: Array.isArray(candles1h) ? candles1h : []
};
}
async function fetchMidPrice(symbol) {
const contractSymbol = normalizeContractSymbol(symbol);
if (!contractSymbol) return 0;
const rawOrderBook = await fetchOrderBook(contractSymbol).catch(() => null);
const ob = analyzeOrderBook(rawOrderBook);
return safeNumber(ob?.mid, 0);
}
function hasFullSnapshotShape(value) {

return Boolean(
value &&
typeof value === 'object' &&
Array.isArray(value.candidates)
);
}
function snapshotPattern() {
return LONG_KEYS.scan.snapshotPattern();
}
function snapshotCreatedAt(snapshot = {}) {
return safeNumber(
snapshot.createdAt ||
snapshot.completedAt ||
snapshot.ts ||
snapshot.scannerTs,
0
);
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
function candidateTradeSide(candidate = {}) {
return inferRowTradeSide(candidate);
}
function countTargetCandidates(snapshot = {}) {
const rows = Array.isArray(snapshot.candidates)
? snapshot.candidates
: [];
return rows.filter((candidate) => candidateTradeSide(candidate) ===
TARGET_TRADE_SIDE).length;
}
function countOppositeCandidates(snapshot = {}) {
const rows = Array.isArray(snapshot.candidates)
? snapshot.candidates
: [];
return rows.filter((candidate) => candidateTradeSide(candidate) ===

OPPOSITE_TRADE_SIDE).length;
}
async function safeGetSnapshotJson(redis, key, fallback = null) {
return getJson(redis, key, fallback).catch(() => fallback);
}
async function loadRecentTargetSnapshots(redis) {
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
key,
snapshot,
targetCount: countTargetCandidates(snapshot),
oppositeCount: countOppositeCandidates(snapshot),
createdAt: snapshotCreatedAt(snapshot)
};
})
);
return rows
.filter(Boolean)
.sort((a, b) => b.createdAt - a.createdAt);
}
function normalizeSelectedSnapshot(snapshot = {}, meta = {}) {
const rows = Array.isArray(snapshot.candidates)
? snapshot.candidates
: [];
const targetRows = rows
.filter((candidate) => candidateTradeSide(candidate) === TARGET_TRADE_SIDE)
.map((candidate) => ({
...candidate,
...scannerMetadataFrom(candidate),
...sideFlags(),
...isolationFlags(),
...virtualFlags(candidate)
}));
const blockedNonLongCandidates = rows
.filter((candidate) => candidateTradeSide(candidate) !== TARGET_TRADE_SIDE)
.slice(0, 100)
.map((candidate) => waitAction(
normalizeCandidate(candidate),

'SHORT_DISABLED_LONG_ONLY_SYSTEM',
{
skippedBeforeAnalyze: true,
skippedBeforeLiveFetch: true,
detectedScannerSide: candidateTradeSide(candidate)
}
));
return {
...snapshot,
selectedSnapshotSource: meta.source || null,
selectedSnapshotReason: meta.reason || null,
selectedTargetCandidateCount: targetRows.length,
selectedLongCandidateCount: targetRows.length,
selectedOppositeCandidateCount: countOppositeCandidates(snapshot),
selectedShortCandidateCount: countOppositeCandidates(snapshot),
blockedNonLongCandidates,
blockedNonLongCandidatesCount: rows.length - targetRows.length,
blockedNonShortCandidates: blockedNonLongCandidates,
blockedNonShortCandidatesCount: rows.length - targetRows.length,
...sideFlags(),
...isolationFlags(),
...virtualFlags(),
candidates: targetRows,
candidatesCount: targetRows.length,
longCandidatesCount: targetRows.length,
shortCandidatesCount: 0,
scannerGateCandidatesCount: targetRows.filter((row) =>
row.scannerGatePassed).length,
analyzeOnlyCandidatesCount: targetRows.filter((row) => (
row.tradeDiscoveryOnly ||
row.discoveryOnly ||
row.analyzeOnly
)).length,
topSymbols: targetRows
.slice(0, 20)
.map((row) => row.symbol)
.filter(Boolean),
scannerGateSymbols: targetRows
.filter((row) => row.scannerGatePassed)
.slice(0, 20)
.map((row) => row.symbol)
.filter(Boolean)
};
}
async function getSnapshotById(snapshotId) {
const requestedSnapshotId =
String(snapshotId || '').trim();

if (!requestedSnapshotId) return null;
const volatileRedis = getVolatileRedis();
const direct = await safeGetSnapshotJson(
volatileRedis,
LONG_KEYS.scan.snapshot(requestedSnapshotId),
null
);
if (hasFullSnapshotShape(direct)) {
return normalizeSelectedSnapshot(direct, {
source: 'LONG:SCAN:SNAPSHOT_BY_ACTIVE_PROGRESS_ID',
reason: 'RESUME_UNFINISHED_SNAPSHOT_BEFORE_LATEST'
});
}
const latest = await safeGetSnapshotJson(
volatileRedis,
LONG_KEYS.scan.latest,
null
);
const latestSnapshotId = extractSnapshotId(latest);
if (
hasFullSnapshotShape(latest) &&
latestSnapshotId === requestedSnapshotId
) {
return normalizeSelectedSnapshot(latest, {
source: 'LONG:SCAN:LATEST_MATCHED_ACTIVE_PROGRESS_ID',
reason: 'RESUME_UNFINISHED_SNAPSHOT_BEFORE_LATEST'
});
}
const recent = await loadRecentTargetSnapshots(
volatileRedis
);
const matched = recent.find((item) => (
item.snapshot?.snapshotId ===
requestedSnapshotId
));
if (!matched) return null;
return normalizeSelectedSnapshot(matched.snapshot, {
source: `LONG:SCAN:RECENT_PROGRESS_SEARCH:${matched.key}`,
reason: 'RESUME_UNFINISHED_SNAPSHOT_BEFORE_LATEST'
});
}
async function getLatestSnapshot() {
const volatileRedis = getVolatileRedis();
const latest = await safeGetSnapshotJson(
volatileRedis,
LONG_KEYS.scan.latest,
null

);
const latestSnapshotId = extractSnapshotId(latest);
const candidates = [];
if (hasFullSnapshotShape(latest)) {
candidates.push({
source: 'LONG:SCAN:LATEST_FULL_SNAPSHOT',
snapshot: latest,
targetCount: countTargetCandidates(latest),
oppositeCount: countOppositeCandidates(latest),
createdAt: snapshotCreatedAt(latest)
});
}
if (latestSnapshotId) {
const byId = await safeGetSnapshotJson(
volatileRedis,
LONG_KEYS.scan.snapshot(latestSnapshotId),
null
);
if (hasFullSnapshotShape(byId)) {
candidates.push({
source: 'LONG:SCAN:SNAPSHOT_BY_LATEST_ID',
snapshot: byId,
targetCount: countTargetCandidates(byId),
oppositeCount: countOppositeCandidates(byId),
createdAt: snapshotCreatedAt(byId)
});
}
}
const recent = await loadRecentTargetSnapshots(volatileRedis);
for (const item of recent) {
candidates.push({
source: `LONG:SCAN:RECENT_SEARCH:${item.key}`,
snapshot: item.snapshot,
targetCount: item.targetCount,
oppositeCount: item.oppositeCount,
createdAt: item.createdAt
});
}
const unique = new Map();
for (const item of candidates) {
const id = item.snapshot?.snapshotId || item.source;
if (!id) continue;
const previous = unique.get(id);
if (!previous) {
unique.set(id, item);
continue;
}

if (
item.targetCount > previous.targetCount ||
(
item.targetCount === previous.targetCount &&
item.createdAt > previous.createdAt
)
) {
unique.set(id, item);
}
}
const sorted = [...unique.values()]
.filter((item) => hasFullSnapshotShape(item.snapshot))
.sort((a, b) => b.createdAt - a.createdAt);
const latestAvailable = sorted[0] || null;
if (!latestAvailable) return null;
return normalizeSelectedSnapshot(latestAvailable.snapshot, {
source: latestAvailable.source,
reason: latestAvailable.targetCount > 0
? 'LATEST_LONG_SCANNER_SNAPSHOT'
: 'LATEST_LONG_SCANNER_SNAPSHOT_WITH_NO_LONG_CANDIDATES'
});
}
function enrichMetricsWithScannerAndLiveGates({
metrics,
candidate,
ob
}) {
const cfg = tradeConfig();
const normalized = normalizeCandidate(candidate);
const scannerMeta = scannerMetadataFrom(candidate, metrics);
const spreadPct = safeNumber(
metrics?.spreadPct ??
ob?.spreadPct,
CONFIG.long?.cost?.fallbackSpreadPct ||
CONFIG.cost?.longFallbackSpreadPct ||
CONFIG.cost?.fallbackSpreadPct ||
0.0008
);
const enriched = {
...metrics,
...scannerMeta,
...sideFlags(),
...isolationFlags(),
...virtualFlags(metrics),
entryRelaxationProfile: cfg.entryRelaxationProfile,
qualityMeasurementProfile: cfg.qualityMeasurementProfile,
scannerWideVirtualLearning: true,

tradeEveryScannerCandidateVirtual: cfg.tradeEveryScannerCandidateVirtual,
riskEnginePreferredButNotRequiredForLearning: true,
standardizedLearningRiskFallbackEnabled:
cfg.allowStandardizedLearningRiskFallback,
currentFitSoftOnly: true,
currentFitBlocksLearning: false,
currentFitBlocksVirtualLearning: false,
currentFitBlocksShadowLearning: false,
currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
minLiveCandles15m: cfg.minLiveCandles15m,
snapshotId: normalized.snapshotId || metrics.snapshotId || null,
symbol: normalized.symbol || metrics.symbol,
baseSymbol: normalized.baseSymbol || metrics.baseSymbol,
contractSymbol: normalized.contractSymbol || metrics.contractSymbol,
price: safeNumber(normalized.price ?? metrics.price ?? ob?.mid, 0),
scannerScore: safeNumber(
normalized.scannerScore ??
normalized.moveScore ??
metrics.scannerScore,
0
),
moveScore: safeNumber(
normalized.moveScore ??
normalized.scannerScore ??
metrics.moveScore,
0
),
scannerReason: normalized.scannerReason || metrics.scannerReason || null,
scannerTs: normalized.scannerTs || metrics.scannerTs || null,
scannerGatePassed: normalized.scannerGatePassed !== false,
scannerGateReason: normalized.scannerGateReason || null,
analyzeEligible: normalized.analyzeEligible !== false,
tradeDiscoveryOnly: Boolean(normalized.tradeDiscoveryOnly),
discoveryOnly: Boolean(normalized.discoveryOnly),
analyzeOnly: Boolean(normalized.analyzeOnly),
isMirrorMicroFamily: false,
observationMirror: false,
analysisMirror: false,
mirrorAnalysisOnly: false,
mirrorOfSide: null,
passesMoveFilter: normalized.passesMoveFilter !== false,
passesVolumeFilter: normalized.passesVolumeFilter !== false,
hasDirectionalSide: normalized.hasDirectionalSide !== false,
sideConfidence: normalized.sideConfidence || metrics.sideConfidence || null,
fakeBreakout: Boolean(normalized.fakeBreakout || metrics.fakeBreakout),
fakeBreakoutRisk: Boolean(normalized.fakeBreakoutRisk ||

metrics.fakeBreakoutRisk),
fakeBreakoutReason: normalized.fakeBreakoutReason ||
metrics.fakeBreakoutReason || null,
breakoutType: normalized.breakoutType || metrics.breakoutType || null,
pullbackConfirmed: Boolean(normalized.pullbackConfirmed ||
metrics.pullbackConfirmed),
retestConfirmed: Boolean(normalized.retestConfirmed ||
metrics.retestConfirmed),
sweepConfirmed: Boolean(normalized.sweepConfirmed || metrics.sweepConfirmed),
spreadPct,
liveSpreadPct: spreadPct,
maxSpreadPct: cfg.maxSpreadPct,
liveSpreadGatePassed: spreadPct <= cfg.maxSpreadPct,
learningOnly: Boolean(metrics.learningOnly),
validLongRiskShape: hasValidRiskShape({
...metrics,
...sideFlags()
}),
longRiskRule: 'sl < entry < tp',
longTpExitRule: 'price >= tp',
longSlExitRule: 'price <= sl',
longTimeStopExitRule: 'TIME_STOP',
longGrossRFormula: '(exitPrice - entry) / (entry - initialSl)',
longCurrentRFormula: '(currentPrice - entry) / (entry - initialSl)',
riskGeometryRule: 'LONG: sl < entry < tp',
tpHitRule: 'LONG: price >= tp',
slHitRule: 'LONG: price <= sl',
grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
currentRFormula: '(currentPrice - entry) / (entry - initialSl)',
positionTimeStopMin: cfg.positionTimeStopMin,
liveDataTs: now()
};
return {
...enriched,
liveRiskValid: hasValidRiskShape(enriched)
};
}
function candidateFallbackPrice(normalized = {}, data = {}) {
const ob = data.ob || {};
return safeNumber(
ob.mid ??
normalized.price ??
normalized.markPrice ??
normalized.currentPrice ??
normalized.lastPrice ??
normalized.close ??
normalized.entry,

0
);
}
function buildObservationOnlyMetrics({
normalized,
data = {},
reason = 'LONG_RISK_INVALID'
}) {
const ob = data.ob || {};
const spreadPct = safeNumber(
ob.spreadPct ??
normalized.spreadPct ??
CONFIG.long?.cost?.fallbackSpreadPct ??
CONFIG.cost?.longFallbackSpreadPct ??
CONFIG.cost?.fallbackSpreadPct,
0.0008
);
const mid = candidateFallbackPrice(normalized, data);
return enrichMetricsWithScannerAndLiveGates({
metrics: {
symbol: normalized.symbol,
baseSymbol: normalized.baseSymbol,
contractSymbol: normalized.contractSymbol,
...scannerMetadataFrom(normalized),
...sideFlags(),
price: mid,
entry: 0,
sl: 0,
tp: 0,
rr: 0,
riskPct: 0,
rewardPct: 0,
confluence: safeNumber(normalized.scannerScore ?? normalized.moveScore, 0),
sniperScore: safeNumber(normalized.scannerScore ?? normalized.moveScore, 0),
spreadPct,
depthMinUsd1p: safeNumber(ob.depthMinUsd1p, 0),
fundingRate: safeNumber(data.funding?.rate, 0),
rsiZone: normalized.rsiZone || null,
rsiCoarse: normalized.rsiCoarse || null,
flow: normalized.flow || null,
flowCoarse: normalized.flowCoarse || null,
obRelation: normalized.obRelation || null,
btcRelation: normalized.btcRelation || null,
btcState: normalized.btcState || null,
regime: normalized.regime || null,
regimeCoarse: normalized.regimeCoarse || null,
observationOnly: true,

analysisInputOnly: true,
learningOnly: true,
liveRiskValid: false,
liveEntryBlockedReason: reason,
scannerWideVirtualLearning: true,
tradeEveryScannerCandidateVirtual:
tradeConfig().tradeEveryScannerCandidateVirtual,
entryRelaxationProfile: ENTRY_RELAXATION_PROFILE,
qualityMeasurementProfile: QUALITY_MEASUREMENT_PROFILE
},
candidate: {
...normalized,
liveEntryBlockedReason: reason
},
ob
});
}
function buildStandardizedLongLearningRiskMetrics({
normalized,
data = {},
reason = 'STANDARDIZED_LONG_LEARNING_TP_SL'
}) {
const cfg = tradeConfig();
const ob = data.ob || {};
const spreadPct = safeNumber(
ob.spreadPct ??
normalized.spreadPct ??
CONFIG.long?.cost?.fallbackSpreadPct ??
CONFIG.cost?.longFallbackSpreadPct ??
CONFIG.cost?.fallbackSpreadPct,
0.0008
);
const mid = candidateFallbackPrice(normalized, data);
const scannerGatePassed = normalized.scannerGatePassed !== false;
const analyzeEligible = normalized.analyzeEligible !== false;
const spreadGatePassed = spreadPct <= cfg.maxSpreadPct;
if (!cfg.allowStandardizedLearningRiskFallback) {
return buildObservationOnlyMetrics({
normalized,
data,
reason: 'STANDARDIZED_LEARNING_RISK_FALLBACK_DISABLED'
});
}
if (cfg.standardizedLearningRiskRequiresScannerGatePassed && !scannerGatePassed)
{
return buildObservationOnlyMetrics({
normalized,

data,
reason: 'STANDARDIZED_LONG_RISK_BLOCKED_SCANNER_GATE_FAILED'
});
}
if (cfg.standardizedLearningRiskRequiresAnalyzeEligible && !analyzeEligible) {
return buildObservationOnlyMetrics({
normalized,
data,
reason: 'STANDARDIZED_LONG_RISK_BLOCKED_ANALYZE_NOT_ELIGIBLE'
});
}
if (cfg.standardizedLearningRiskRequiresSpreadGatePassed && !spreadGatePassed) {
return buildObservationOnlyMetrics({
normalized,
data,
reason: 'STANDARDIZED_LONG_RISK_BLOCKED_SPREAD_TOO_WIDE'
});
}
if (mid <= 0) {
return buildObservationOnlyMetrics({
normalized,
data,
reason: 'STANDARDIZED_LONG_RISK_NO_PRICE'
});
}
const rr = Math.max(
cfg.minRR,
cfg.defaultRR,
0.5
);
const riskPct = clampNumber(
cfg.fallbackRiskPct,
Math.max(0.0005, cfg.minRiskPct),
Math.max(cfg.minRiskPct, cfg.maxRiskPct)
);
const entry = mid;
const sl = Math.max(entry * (1 - riskPct), entry * 0.0001);
const tp = entry * (1 + riskPct * rr);
const rewardPct = Math.max(0, (tp - entry) / entry);
return enrichMetricsWithScannerAndLiveGates({
metrics: {
symbol: normalized.symbol,
baseSymbol: normalized.baseSymbol,
contractSymbol: normalized.contractSymbol,
...scannerMetadataFrom(normalized),
...sideFlags(),
price: mid,

entry,
sl,
tp,
rr,
riskPct,
rewardPct,
confluence: safeNumber(normalized.scannerScore ?? normalized.moveScore, 0),
sniperScore: safeNumber(normalized.scannerScore ?? normalized.moveScore, 0),
spreadPct,
depthMinUsd1p: safeNumber(ob.depthMinUsd1p, 0),
fundingRate: safeNumber(data.funding?.rate, 0),
rsiZone: normalized.rsiZone || null,
rsiCoarse: normalized.rsiCoarse || null,
flow: normalized.flow || null,
flowCoarse: normalized.flowCoarse || null,
obRelation: normalized.obRelation || null,
btcRelation: normalized.btcRelation || null,
btcState: normalized.btcState || null,
regime: normalized.regime || null,
regimeCoarse: normalized.regimeCoarse || null,
riskSource: 'LEARNING_STANDARDIZED_TP_SL',
riskEngineRisk: false,
standardizedLearningRisk: true,
standardizedLearningRiskReason: reason,
standardizedLearningRiskEntry: true,
standardizedLearningRiskVirtualEntryAllowed:
cfg.allowStandardizedLearningRiskVirtualEntries,
syntheticRisk: false,
syntheticRiskReason: null,
observationOnly: false,
analysisInputOnly: false,
learningOnly: false,
liveRiskValid: true,
liveEntryBlockedReason: null,
scannerWideVirtualLearning: true,
tradeEveryScannerCandidateVirtual: cfg.tradeEveryScannerCandidateVirtual,
entryRelaxationProfile: cfg.entryRelaxationProfile,
qualityMeasurementProfile: cfg.qualityMeasurementProfile
},
candidate: {
...normalized,
liveEntryBlockedReason: null
},
ob
});
}
function buildActualRiskWaitIfNeeded({

normalized,
scannerSide,
metricsRows
}) {
if (scannerSide !== TARGET_TRADE_SIDE) {
return waitAction(
{
...normalized,
side: scannerSide,
tradeSide: scannerSide
},
'SHORT_DISABLED_LONG_ONLY_SYSTEM'
);
}
const hasLongMetrics = metricsRows.some((row) => (
inferRowTradeSide(row) === TARGET_TRADE_SIDE &&
hasValidRiskShape(row)
));
if (hasLongMetrics) return null;
return waitAction(
{
...normalized,
side: TARGET_DASHBOARD_SIDE,
tradeSide: TARGET_TRADE_SIDE
},
'LONG_NO_TP_SL_AVAILABLE_FOR_VIRTUAL_LEARNING'
);
}
async function processCandidate(candidate) {
const cfg = tradeConfig();
const normalized = normalizeCandidate(candidate);
if (!normalized.symbol || !normalized.contractSymbol) {
return {
actions: [waitAction(normalized, 'INVALID_SYMBOL')],
metrics: []
};
}
const scannerSide = inferRowTradeSide(normalized);
if (scannerSide !== TARGET_TRADE_SIDE) {
return {
actions: [
waitAction(
{
...normalized,
tradeSide: scannerSide,
side: normalized.side
},

'SHORT_DISABLED_LONG_ONLY_SYSTEM',
{
skippedBeforeAnalyze: true,
skippedBeforeLiveFetch: true,
detectedScannerSide: scannerSide
}
)
],
metrics: []
};
}
const data = await fetchLiveCandidateData(normalized)
.catch((error) => ({ error }));
if (data.error || data.ob?.fetchFailed) {
const fallback = buildStandardizedLongLearningRiskMetrics({
normalized,
data,
reason: 'LIVE_DATA_FAILED_STANDARDIZED_LEARNING_TP_SL'
});
const riskWait = buildActualRiskWaitIfNeeded({
normalized,
scannerSide,
metricsRows: [fallback]
});
return {
actions: riskWait ? [riskWait] : [],
metrics: [fallback]
};
}
const hasEnough15mCandles = (
Array.isArray(data.candles15m) &&
data.candles15m.length >= cfg.minLiveCandles15m
);
if (!hasEnough15mCandles) {
const fallback = buildStandardizedLongLearningRiskMetrics({
normalized,
data,
reason: 'INSUFFICIENT_LIVE_CANDLES_STANDARDIZED_LEARNING_TP_SL'
});
const riskWait = buildActualRiskWaitIfNeeded({
normalized,
scannerSide,
metricsRows: [fallback]
});
return {
actions: riskWait
? [

waitAction(normalized,
'INSUFFICIENT_LIVE_CANDLES_15M_BUT_LEARNING_FALLBACK_FAILED', {
candleCount: data.candles15m?.length || 0,
requiredCandleCount: cfg.minLiveCandles15m
})
]
: [],
metrics: [fallback]
};
}
const generatedMetrics = buildRiskAndLiveMetricsForBothSides({
candidate: {
...normalized,
side: TARGET_DASHBOARD_SIDE,
tradeSide: TARGET_TRADE_SIDE,
positionSide: TARGET_TRADE_SIDE,
direction: TARGET_TRADE_SIDE
},
ob: data.ob,
funding: data.funding,
candles15m: data.candles15m,
candles1h: data.candles1h,
btcState: normalized.btcState || candidate.btcState,
regime: normalized.regime || candidate.regime
});
const rawMetrics = Array.isArray(generatedMetrics)
? generatedMetrics
: [];
const metrics = rawMetrics
.map((row) => {
const rowSide = inferRowTradeSide(row);
if (rowSide !== TARGET_TRADE_SIDE) return null;
const variant = buildAnalysisVariant(
normalized,
TARGET_TRADE_SIDE,
scannerSide
);
if (!variant) return null;
return enrichMetricsWithScannerAndLiveGates({
metrics: {
...row,
riskSource: row.riskSource || 'RISK_ENGINE',
riskEngineRisk: true,
standardizedLearningRisk: false
},
candidate: variant,
ob: data.ob

});
})
.filter(Boolean);
const hasValidLongRisk = metrics.some(hasValidRiskShape);
const finalMetrics = hasValidLongRisk
? metrics
: [
buildStandardizedLongLearningRiskMetrics({
normalized,
data,
reason: 'RISK_ENGINE_EMPTY_STANDARDIZED_LONG_LEARNING_TP_SL'
})
];
const riskWait = buildActualRiskWaitIfNeeded({
normalized,
scannerSide,
metricsRows: finalMetrics
});
return {
actions: riskWait ? [riskWait] : [],
metrics: finalMetrics
};
}
async function safeProcessCandidate(candidate) {
try {
return await processCandidate(candidate);
} catch (error) {
const normalized = normalizeCandidate(candidate);
const fallback = buildStandardizedLongLearningRiskMetrics({
normalized,
reason: 'CANDIDATE_PROCESS_ERROR_STANDARDIZED_LEARNING_TP_SL'
});
const fallbackValid = hasValidRiskShape(fallback);
const riskWait = buildActualRiskWaitIfNeeded({
normalized,
scannerSide: TARGET_TRADE_SIDE,
metricsRows: [fallback]
});
return {
actions: fallbackValid && !riskWait
? []
: [
waitAction(normalized, 'CANDIDATE_PROCESS_ERROR', {
error: error?.message || String(error),
learningFallbackAttempted: true,
learningFallbackValid: fallbackValid
}),

...(riskWait ? [riskWait] : [])
],
metrics: [fallback]
};
}
}
function buildVirtualEntryAction({
row,
alertContext,
selectedWeeklyStats,
riskFraction,
virtualGate,
selectedExactMicroMatch,
discordAlertEligible,
entryTs = now()
}) {
const normalized = normalizeExactTrueMicroRow(row);
const trueMicroFamilyId = getTrueMicroFamilyId(normalized);
const parentTrueMicroFamilyId = getParentTrueMicroFamilyId(normalized);
const parsed = parseLongTaxonomyMicroId(trueMicroFamilyId);
const entryTemporal = entryTemporalFields({
...row,
entryTs
}, entryTs);
const currentFitGate = discordCurrentFitGate(row);
const discordEntryGate = discordCompositeEntryGate({
row,
selectedWeeklyStats,
selectedExactMicroMatch,
currentFitGate,
entryTemporal
});
const wouldPublishWithoutTemporal = Boolean(
discordAlertEligible && discordEntryGate.ok
);
const finalDiscordAlertEligible = wouldPublishWithoutTemporal;
return {
...normalized,
trueMicroFamilyId,
microFamilyId: trueMicroFamilyId,
analyzeMicroFamilyId: trueMicroFamilyId,
learningMicroFamilyId: trueMicroFamilyId,
childTrueMicroFamilyId: trueMicroFamilyId,
parentTrueMicroFamilyId,
coarseMicroFamilyId: parentTrueMicroFamilyId,
baseMicroFamilyId: parentTrueMicroFamilyId,
legacyMicroFamilyId: parentTrueMicroFamilyId,
familyId: trueMicroFamilyId,
setupType: parsed.setup,
regimeBucket: parsed.regime,
confirmationProfile: parsed.confirmationProfile,
...scannerMetadataFrom(row),

...sideFlags(),
...virtualFlags({
...row,
trueMicroFamilyId
}),
...isolationFlags(),
...entryTemporal,
action: 'ENTRY',
entryType: 'VIRTUAL_ENTRY',
virtualAction: 'VIRTUAL_ENTRY',
positionEvent: 'ENTRY',
reason: virtualGate.reason || (
row.standardizedLearningRisk
? 'LONG_VIRTUAL_LEARNING_STANDARDIZED_TP_SL'
: 'LONG_VIRTUAL_RISK_ENGINE_VALID'
),
shadowOnly: false,
selectedRotationId: alertContext.rotationId,
activeRotationId: alertContext.rotationId,
selectedMicroFamilyAlert: Boolean(finalDiscordAlertEligible),
selectedExactMicroMatch: Boolean(selectedExactMicroMatch),
discordAlertEligible: Boolean(finalDiscordAlertEligible),
wouldPublishWithoutTemporal,
temporalDecisionPending: true,
discordCurrentFitGate: currentFitGate,
discordFamilyGate: discordEntryGate.familyGate,
discordTemporalGate: discordEntryGate.temporalGate,
discordEntryGate,
temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
temporalGenerationSchemaVersion: TEMPORAL_GENERATION_SCHEMA_VERSION,
temporalTaxonomyVersion: TEMPORAL_TAXONOMY_VERSION,
temporalCostModelVersion: TEMPORAL_COST_MODEL_VERSION,
familyGate: discordEntryGate.familyGate.familyGate,
measurementFixVersion: discordEntryGate.familyGate.measurementFixVersion ||
MEASUREMENT_FIX_VERSION,
acceptedOutcomeMeasurementVersion: MEASUREMENT_FIX_VERSION,
outcomeMeasurementGateMode: OUTCOME_MEASUREMENT_GATE_MODE,
empiricalVetoPolicyVersion: EMPIRICAL_VETO_POLICY_VERSION,
discordAlertReason: finalDiscordAlertEligible
? 'SELECTED_LONG_TRUE_MICRO_FAMILY_EXACT_75_CHILD_MATCH_AND_CURRENT_FIT_OK'
: !selectedExactMicroMatch
? alertContext.empty
? 'NO_MANUAL_75_CHILD_TRUE_MICRO_FAMILY_SELECTED'
: 'TRUE_MICRO_FAMILY_NOT_SELECTED_FOR_DISCORD_ALERT'
: discordEntryGate.reason || 'DISCORD_ENTRY_GATE_BLOCKED',
selectedMacroFamilyId: null,
activeMacroFamilyId: null,
selectedParentTrueMicroFamilyId: parentTrueMicroFamilyId,
activeParentTrueMicroFamilyId: parentTrueMicroFamilyId,
selectedWeeklyStats,
weeklyStats: selectedWeeklyStats,
riskFraction,
virtualGate,
btcRelation: row.btcRelation,
liveEligible: Boolean(finalDiscordAlertEligible),
outcomeIdentityLocked: true,

outcomeIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
exactTrueMicroFamilyRequired: true,
exactTrueMicroOnly: true,
symbolExcludedFromFamilyId: true,
coinNameExcludedFromFamilyId: true,
hashesExcludedFromFamilyId: true,
validLongRiskShape: true,
longRiskRule: 'sl < entry < tp',
longTpExitRule: 'price >= tp',
longSlExitRule: 'price <= sl',
longTimeStopExitRule: 'TIME_STOP',
longGrossRFormula: '(exitPrice - entry) / (entry - initialSl)',
longCurrentRFormula: '(currentPrice - entry) / (entry - initialSl)',
riskGeometryRule: 'LONG: sl < entry < tp',
tpHitRule: 'LONG: price >= tp',
slHitRule: 'LONG: price <= sl',
grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
currentRFormula: '(currentPrice - entry) / (entry - initialSl)',
positionTimeStopMin: tradeConfig().positionTimeStopMin,
scannerWideVirtualLearning: true,
tradeEveryScannerCandidateVirtual: true,
riskSource: row.riskSource || (
row.standardizedLearningRisk
? 'LEARNING_STANDARDIZED_TP_SL'
: 'RISK_ENGINE'
),
riskEngineRisk: Boolean(row.riskEngineRisk),
standardizedLearningRisk: Boolean(row.standardizedLearningRisk),
entryMarketWeather: row.entryMarketWeather || row.currentMarketWeather ||
null,
entryCurrentRegime: row.entryCurrentRegime || row.currentRegime || null,
entryCurrentTrendSide: row.entryCurrentTrendSide || row.currentTrendSide ||
null,
entryCurrentFit: row.entryCurrentFit || row.currentFit || null,
entryCurrentFitConfidence: row.entryCurrentFitConfidence ??
row.currentFitConfidence ?? null,
entryWeatherFitMatchedFamily: row.entryWeatherFitMatchedFamily ?? (
row.currentFit === 'MATCH' ||
row.currentFit === 'WEAK_MATCH'
),
currentMarketWeather: row.currentMarketWeather || null,
currentMarketWeatherAgeSec: row.currentMarketWeatherAgeSec ?? null,
currentMarketWeatherStale: Boolean(row.currentMarketWeatherStale),
currentFit: row.currentFit || row.entryCurrentFit || null,
currentFitScore: row.currentFitScore ?? null,
currentFitConfidence: row.currentFitConfidence ??

row.entryCurrentFitConfidence ?? null,
currentFitReason: row.currentFitReason || null,
currentFitSoftOnly: true,
currentFitBlocksLearning: false,
currentFitBlocksVirtualLearning: false,
currentFitBlocksShadowLearning: false,
currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
entryRelaxationProfile: ENTRY_RELAXATION_PROFILE,
qualityMeasurementProfile: QUALITY_MEASUREMENT_PROFILE,
entryCreatedAt: entryTs
};
}
function sanitizeEntryPublicationResult(result = {}, fallbackReason = null) {
return {
entryPublicationResultVersion: ENTRY_PUBLICATION_RESULT_VERSION,
ok: result?.ok === true,
sent: result?.ok === true && result?.skipped !== true,
skipped: result?.skipped === true,
failed: result?.ok === false && result?.skipped !== true,
reason: String(result?.reason || fallbackReason || '').trim() || null,
status: Number.isFinite(Number(result?.status)) ? Number(result.status) : null,
publicationType: result?.publicationType || 'DISCORD_WEBHOOK',
responseBodyStored: false,
sensitiveTransportMetadataStored: false,
recordedAt: now()
};
}
async function maybeSendDiscordEntryAlert(entry = {}) {
const decision = entry.entryDecisionSnapshot || null;
if (
entry.discordAlertEligible !== true ||
decision?.finalDiscordEntryAllowed !== true
) {
return sanitizeEntryPublicationResult({
ok: true,
skipped: true,
reason:
decision?.temporalBlockReasons?.[0] ||
entry.discordEntryGate?.reason ||
entry.discordAlertReason ||
'TRUE_MICRO_FAMILY_NOT_SELECTED_OR_RUNTIME_GATE_BLOCKED'
});
}
try {
const result = await sendEntryAlert(entry);
return sanitizeEntryPublicationResult(result);
} catch (error) {
return sanitizeEntryPublicationResult({
ok: false,
skipped: false,
reason: 'DISCORD_ENTRY_ALERT_FAILED'
}, error?.message || String(error));
}
}
function inferPrimaryBottleneck({
candidates,
processed,
liveRows,
riskValidRows,
analyzedRows,
analyzedRiskValidRows,
analyzedExact75Rows,
virtualCreatedRows,
virtualExitRows,
openPositionCountAfterEntries
}) {
if (candidates <= 0) return 'NO_LONG_CANDIDATES';
if (processed <= 0) return 'NO_CANDIDATES_PROCESSED';
if (liveRows <= 0) return 'NO_LIVE_ROWS_OR_NO_FALLBACK_PRICE';

if (riskValidRows <= 0) {
return 'NO_TP_SL_AVAILABLE_FOR_SCANNER_WIDE_VIRTUAL_LEARNING';
}
if (analyzedRows <= 0) {
return 'ANALYZE_RETURNED_NO_LONG_ROWS';
}
if (analyzedRiskValidRows <= 0) {
return 'ANALYZE_DID_NOT_RETURN_RISK_VALID_ROWS';
}
if (analyzedExact75Rows <= 0) {
return 'ANALYZE_DID_NOT_ASSIGN_EXACT_75_CHILD_TRUE_MICRO_FAMILY';
}
if (virtualCreatedRows <= 0) {
return 'VIRTUAL_ENTRY_GATE_OR_SYMBOL_ALREADY_OPEN';
}
if (virtualCreatedRows > 0 && virtualExitRows <= 0 &&
openPositionCountAfterEntries > 0) {
return 'POSITIONS_OPEN_WAITING_FOR_TP_SL_OR_TIME_STOP';
}
if (virtualCreatedRows > 0 && virtualExitRows > 0) {
return 'HEALTHY_LONG_75_CHILD_LEARNING_PIPELINE';
}
return 'PIPELINE_ACTIVE_MONITOR_REQUIRED';
}
function buildQualityAudit({
snapshot,
candidates,
processed,
liveRows,
analyzedRowsRaw,
analyzedRows,
actions,
virtualExits,
counts,
openPositionCountBeforeEntries,
openPositionCountAfterEntries,
marketContext
}) {
const candidateCount = candidates.length;
const processedCount = processed.length;
const liveRowsCount = liveRows.length;
const analyzedRowsRawCount = analyzedRowsRaw.length;
const analyzedRowsCount = analyzedRows.length;
const virtualExitRows = virtualExits.length;
const riskValidRows = counts.riskValidRows;
const analyzedRiskValidRows = counts.analyzedRiskValidRows;
const analyzedExact75Rows = counts.analyzedExact75Rows;

const entryRows = counts.entryRows;
const virtualCreatedRows = counts.virtualCreatedRows;
const waitRows = counts.waitRows;
const primaryBottleneck = inferPrimaryBottleneck({
candidates: candidateCount,
processed: processedCount,
liveRows: liveRowsCount,
riskValidRows,
analyzedRows: analyzedRowsCount,
analyzedRiskValidRows,
analyzedExact75Rows,
virtualCreatedRows,
virtualExitRows,
openPositionCountAfterEntries
});
return {
profile: QUALITY_MEASUREMENT_PROFILE,
entryRelaxationProfile: ENTRY_RELAXATION_PROFILE,
targetTradeSide: TARGET_TRADE_SIDE,
dashboardSide: TARGET_DASHBOARD_SIDE,
scannerSide: TARGET_SCANNER_SIDE,
trueMicroSchema: TRUE_MICRO_SCHEMA,
parentTrueMicroSchema: PARENT_TRUE_MICRO_SCHEMA,
childTrueMicroSchema: CHILD_TRUE_MICRO_SCHEMA,
learningGranularity: LEARNING_GRANULARITY,
parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
scannerWideVirtualLearning: true,
tradeEveryScannerCandidateVirtual: true,
riskEnginePreferredButNotRequiredForLearning: true,
standardizedLearningRiskFallbackEnabled: true,
currentFitSoftOnly: true,
currentFitBlocksLearning: false,
currentFitBlocksVirtualLearning: false,
currentFitBlocksShadowLearning: false,
currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
selectionIsAdaptive: true,
discordWillBeStrict: true,
discordOnlyForSelectedMicroFamilies: true,
discordOnlyForExactTrueMicroMatch: true,
discordSelectionRule: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY',
discordRequiresCurrentFit: discordRequiresCurrentFit(),
discordMinCurrentFitConfidence: discordMinCurrentFitConfidence(),
completedIsPureClosedVirtualOutcome: true,
completedComesOnlyFrom: 'TP_SL_OR_TIME_STOP',
scoringRSource: 'netR',
riskGeometryRule: 'LONG: sl < entry < tp',

tpHitRule: 'LONG: price >= tp',
slHitRule: 'LONG: price <= sl',
grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
currentRFormula: '(currentPrice - entry) / (entry - initialSl)',
recommendedFreezeDays: FREEZE_MEASUREMENT_RECOMMENDED_DAYS,
completedThresholds: {
earlySignal: MIN_COMPLETED_EARLY_SIGNAL,
reasonableSignal: MIN_COMPLETED_REASONABLE_SIGNAL,
strongSignal: MIN_COMPLETED_STRONG_SIGNAL,
activeLearning: MIN_COMPLETED_ACTIVE_LEARNING
},
marketWeather: {
available: Boolean(marketContext?.ok),
key: MARKET_WEATHER_KEY,
universeKey: MARKET_UNIVERSE_KEY,
ageSec: marketContext?.ageSec ?? null,
stale: Boolean(marketContext?.stale),
regime: marketContext?.regime || 'UNKNOWN',
trendSide: marketContext?.trendSide || 'UNKNOWN',
bearishPct: marketContext?.bearishPct ?? null,
bullishPct: marketContext?.bullishPct ?? null,
squeezePct: marketContext?.squeezePct ?? null,
confidence: marketContext?.confidence ?? null
},
snapshot: {
snapshotId: snapshot?.snapshotId || null,
selectedSnapshotSource: snapshot?.selectedSnapshotSource || null,
selectedSnapshotReason: snapshot?.selectedSnapshotReason || null,
selectedTargetCandidateCount: snapshot?.selectedTargetCandidateCount || 0,
selectedLongCandidateCount: snapshot?.selectedLongCandidateCount || 0,
selectedOppositeCandidateCount: snapshot?.selectedOppositeCandidateCount ||
0,
selectedShortCandidateCount: snapshot?.selectedShortCandidateCount || 0
},
pipelineCounts: {
candidates: candidateCount,
processed: processedCount,
liveRows: liveRowsCount,
riskValidRows,
analyzedRowsRaw: analyzedRowsRawCount,
analyzedRows: analyzedRowsCount,
analyzedRiskValidRows,
analyzedExact75Rows,
entryRows,
virtualCreatedRows,
virtualExitRows,
waitRows,

skippedByExistingSymbol: counts.skippedByExistingSymbol || 0,
selectedAlertMicroMatches: counts.selectedAlertMicroMatches || 0,
discordCurrentFitBlockedRows: counts.discordCurrentFitBlockedRows || 0,
openPositionCountBeforeEntries,
openPositionCountAfterEntries
},
conversionRatesPct: {
processedPerCandidate: pct(processedCount, candidateCount),
liveRowsPerCandidate: pct(liveRowsCount, candidateCount),
riskValidPerLiveRow: pct(riskValidRows, liveRowsCount),
analyzedPerLiveRow: pct(analyzedRowsCount, liveRowsCount),
analyzedRiskValidPerAnalyzed: pct(analyzedRiskValidRows, analyzedRowsCount),
analyzedExact75PerAnalyzedRiskValid: pct(analyzedExact75Rows,
analyzedRiskValidRows),
virtualCreatedPerExact75: pct(virtualCreatedRows, analyzedExact75Rows),
virtualExitPerCreatedThisRun: pct(virtualExitRows, virtualCreatedRows)
},
primaryBottleneck,
topWaitReasons: topReasonCounts(actions, 12),
interpretation: {
healthy: 'Scanner coins worden breed virtueel getraded. Analyze zet risk-valid rows exact in een 75-child trueMicroFamilyId. completed komt later via TP/SL/TIME_STOP.',
currentFit: 'CurrentFit blokkeert geen virtual learning. Het beïnvloedt alleen Discord-eligibility en downstream adaptive selection.',
ifVirtualCreatedLow: 'Meestal symbol-lock, geen exact 75-child trueMicroFamilyId, of geen geldige TP/SL fallback.',
ifVirtualCreatedHighAndExitLow: 'Posities lopen nog; completed komt later.',
ifRiskValidLow: 'Er is geen TP/SL beschikbaar, ook fallback kon geen prijs vinden.',
ifAnalyzedExact75Low: 'Analyze gaf geen exact selecteerbare 75-child trueMicroFamilyId terug.',
ifSymbolAlreadyOpenHigh: 'Eén open positie per symbol blokkeert extra entries. Dit voorkomt dubbele vervuiling.',
ifSnapshotAlreadyProcessedHigh: 'Geen nieuwe entries totdat scanner een nieuwe snapshot levert.',
ifDiscordCurrentFitBlockedHigh: 'Discord is streng. Virtual learning loopt door, maar alerts wachten op betere huidige markt-fit.'
},
measurementPrinciple: 'Alles bullish van scanner virtueel laten leren; Discord alleen voor exact geselecteerde bewezen 75-child trueMicroFamilyIds met geldige CurrentFit.'
};
}
async function scopedSetJson(redis, key, value, options = {}) {
try {
assertKeyAllowedForWriteScope(

KEYS.scopes?.TRADE_RUN || 'TRADE_RUN',
key
);
} catch (error) {
if (!String(key || '').startsWith(LONG_KEY_PREFIX)) {
throw error;
}
}
return setJson(redis, key, value, options);
}
async function saveRunMeta(result = {}) {
const durableRedis =
getDurableRedis();
const completedAt =
now();
const rawVirtualExits =
Array.isArray(
result.virtualExits
)
? result.virtualExits
: Array.isArray(
result.shadowExits
)
? result.shadowExits
: [];
const virtualExits =
rawVirtualExits.map(
compactVirtualExitForStorage
);
const rawActions =
Array.isArray(
result.actions
)
? result.actions
: [];
const actions =
rawActions.map(
stripHeavyTradeRow
);
const virtualExitActions =
buildVirtualExitActions(
virtualExits
).map(
stripHeavyTradeRow
);
const compactMarketContext =
result.marketContext

? {
ok:
Boolean(
result.marketContext.ok
),
createdAt:
result.marketContext.createdAt ||
null,
ageSec:
result.marketContext.ageSec ??
null,
stale:
Boolean(
result.marketContext.stale
),
regime:
result.marketContext.regime ||
'UNKNOWN',
trendSide:
result.marketContext.trendSide ||
'UNKNOWN',
bearishPct:
result.marketContext.bearishPct ??
null,
bullishPct:
result.marketContext.bullishPct ??
null,
squeezePct:
result.marketContext.squeezePct ??
null,
confidence:
result.marketContext.confidence ??
null,
key:
result.marketContext.key ||
MARKET_WEATHER_KEY,
universeKey:
result.marketContext.universeKey ||
MARKET_UNIVERSE_KEY,
source:
compactMarketWeatherForStorage(
result.marketContext.source
),
universe:
compactMarketUniverseForStorage(
result.marketContext.universe
)

}
: null;
const finalResult = {
ok:
result.ok !== false,
...result,
actions,
entryRelaxationProfile:
ENTRY_RELAXATION_PROFILE,
qualityMeasurementProfile:
QUALITY_MEASUREMENT_PROFILE,
...sideFlags(),
...virtualFlags(),
...isolationFlags(),
longKeys: {
scanLatest:
LONG_KEYS.scan.latest,
tradeRunMeta:
LONG_KEYS.trade.runMeta,
tradeLastProcessedSnapshot:
LONG_KEYS.trade
.lastProcessedSnapshot,
tradeSnapshotProgress:
LONG_KEYS.trade
.snapshotProgress,
scanSnapshotPattern:
LONG_KEYS.scan
.snapshotPattern(),
marketWeather:
MARKET_WEATHER_KEY,
marketUniverse:
MARKET_UNIVERSE_KEY
},
currentMarketWeather:
compactMarketWeatherForStorage(
result.currentMarketWeather
),
currentMarketUniverse:
compactMarketUniverseForStorage(
result.currentMarketUniverse
),
marketContext:
compactMarketContext,
virtualExits,
shadowExits:
virtualExits,
realExits:

[],
virtualExitRows:
safeNumber(
result.virtualExitRows,
virtualExits.length
),
shadowExitRows:
safeNumber(
result.shadowExitRows,
virtualExits.length
),
realExitRows:
0,
virtualExitActions,
skipReason:
result.skipReason ||
result.reason ||
null,
completedAt,
durationMs:
completedAt -
safeNumber(
result.startedAt,
completedAt
),
actionCounts:
result.actionCounts ||
buildRunActionCounts(
rawActions,
rawVirtualExits
),
qualityAudit:
result.qualityAudit ||
null,
compactPersistence:
true,
fullPayloadPersisted:
false,
actionsPersisted:
false,
scannerRowsPersisted:
false,
marketWeatherRowsPersisted:
false,
marketUniverseRowsPersisted:
false,
candidateRowsPersisted:

false,
candleDataPersisted:
false
};
await scopedSetJson(
durableRedis,
LONG_KEYS.trade.runMeta,
compactRunMetaForStorage(
finalResult
)
);
return finalResult;
}
export async function runTradeSystem(options = {}) {
const cfg = tradeConfig();
const sizing = sizingConfig();
const durableRedis = getDurableRedis();
const runId = randomId('trade_run_long');
const startedAt = now();
const runtime =
runtimeState(
options,
startedAt
);
const forceProcessSnapshot = Boolean(options.forceProcessSnapshot ||
options.force);
const monitorOnly = Boolean(options.monitorOnly);
const marketContext = await loadMarketContext().catch(() =>
extractMarketWeatherShape({}, {}));
const priceFetcher = async (symbol) => fetchMidPrice(symbol);
const realExits = [];
const virtualExits = await monitorOpenPositions({
priceFetcher,
tradeSide: TARGET_TRADE_SIDE,
side: TARGET_DASHBOARD_SIDE,
namespace: LONG_NAMESPACE,
keyPrefix: LONG_KEY_PREFIX,
weekKey: PERSISTENT_LEARNING_KEY,
persistentLearningKey: PERSISTENT_LEARNING_KEY,
virtualOnly: true,
realOrdersDisabled: true,
bitgetOrdersDisabled: true,
exchangeCallsDisabled: true
});
const shadowExits = virtualExits;
if (monitorOnly) {
const actions = [];

return saveRunMeta({
runId,
startedAt,
actions,
realExits,
virtualExits,
shadowExits,
entryRows: 0,
waitRows: 0,
virtualCreatedRows: 0,
skippedNewEntries: true,
reason: 'MONITOR_ONLY',
actionCounts: buildRunActionCounts(actions, virtualExits),
marketContext,
monitorOpenPositions: true,
monitorOpenPositionsFirst: true,
processScannerSnapshot: false,
...isolationFlags()
});
}
if (forceProcessSnapshot) {
await clearSnapshotProgress(
durableRedis
);
}
let snapshotProgress =
forceProcessSnapshot
? null
: await loadSnapshotProgress(
durableRedis
);
if (
snapshotProgress?.completed === true
) {
await clearSnapshotProgress(
durableRedis
);
snapshotProgress =
null;
}
const progressUpdatedAt =
safeNumber(
snapshotProgress?.updatedAt ??
snapshotProgress?.processedAt,
0
);
const progressAgeSec =

progressUpdatedAt > 0
? (
now() -
progressUpdatedAt
) / 1000
: 0;
const continuationProgressStale =
Boolean(
snapshotProgress &&
progressAgeSec >
cfg.maxContinuationAgeSec
);
let snapshot =
null;
let resumedUnfinishedSnapshot =
false;
let abandonedSnapshotProgressId =
null;
let abandonedSnapshotProgressReason =
null;
if (
snapshotProgress?.snapshotId
) {
snapshot =
await getSnapshotById(
snapshotProgress.snapshotId
);
if (snapshot?.snapshotId) {
resumedUnfinishedSnapshot =
true;
} else {
abandonedSnapshotProgressId =
snapshotProgress.snapshotId;
abandonedSnapshotProgressReason =
'UNFINISHED_SNAPSHOT_PAYLOAD_NOT_FOUND';
await clearSnapshotProgress(
durableRedis
);
snapshotProgress =
null;
}
}
if (!snapshot?.snapshotId) {
snapshot =
await getLatestSnapshot();
}
if (!snapshot?.snapshotId) {

const actions = [];
return saveRunMeta({
runId,
startedAt,
actions,
realExits,
virtualExits,
shadowExits,
entryRows: 0,
waitRows: 0,
virtualCreatedRows: 0,
skippedNewEntries: true,
reason: 'NO_LONG_SCANNER_SNAPSHOT',
actionCounts: buildRunActionCounts(actions, virtualExits),
marketContext,
snapshotSelectionPolicy:
SNAPSHOT_SELECTION_POLICY,
resumedUnfinishedSnapshot,
continuationProgressStale,
abandonedSnapshotProgressId,
abandonedSnapshotProgressReason,
monitorOpenPositions: true,
monitorOpenPositionsFirst: true,
processScannerSnapshot: true,
...isolationFlags()
});
}
const snapshotAgeSec =
(
now() -
safeNumber(
snapshot.createdAt,
0
)
) / 1000;
const continuationActive =
Boolean(
snapshotProgress &&
snapshotProgress.snapshotId ===
snapshot.snapshotId &&
snapshotProgress.completed !==
true
);
if (
snapshotAgeSec >
cfg.maxSnapshotAgeSec &&
!continuationActive

) {
const actions =
Array.isArray(
snapshot
.blockedNonLongCandidates
)
? snapshot
.blockedNonLongCandidates
: [];
return saveRunMeta({
runId,
startedAt,
snapshotId:
snapshot.snapshotId,
snapshotAgeSec:
Math.round(
snapshotAgeSec
),
selectedSnapshotSource:
snapshot
.selectedSnapshotSource ||
null,
selectedSnapshotReason:
snapshot
.selectedSnapshotReason ||
null,
selectedTargetCandidateCount:
snapshot
.selectedTargetCandidateCount ||
0,
selectedLongCandidateCount:
snapshot
.selectedLongCandidateCount ||
0,
selectedOppositeCandidateCount:
snapshot
.selectedOppositeCandidateCount ||
0,
selectedShortCandidateCount:
snapshot
.selectedShortCandidateCount ||
0,
blockedNonLongCandidatesCount:
snapshot
.blockedNonLongCandidatesCount ||
0,
blockedNonShortCandidatesCount:

snapshot
.blockedNonShortCandidatesCount ||
0,
actions,
realExits,
virtualExits,
shadowExits,
entryRows:
0,
waitRows:
actions.length,
virtualCreatedRows:
0,
skippedNewEntries:
true,
reason:
'SNAPSHOT_TOO_STALE',
actionCounts:
buildRunActionCounts(
actions,
virtualExits
),
marketContext,
runtimeBudgetMs:
runtime.runtimeBudgetMs,
deadlineAt:
runtime.deadlineAt,
remainingRuntimeMs:
runtime.remainingMs(),
monitorOpenPositions:
true,
monitorOpenPositionsFirst:
true,
processScannerSnapshot:
false,
...isolationFlags()
});
}
const lastProcessed =
await getJson(
durableRedis,
LONG_KEYS.trade
.lastProcessedSnapshot,
null
);
const sameSnapshot =
lastProcessed?.snapshotId ===

snapshot.snapshotId;
if (
sameSnapshot &&
!forceProcessSnapshot &&
!continuationActive
) {
const actions =
Array.isArray(
snapshot
.blockedNonLongCandidates
)
? snapshot
.blockedNonLongCandidates
: [];
return saveRunMeta({
runId,
startedAt,
snapshotId:
snapshot.snapshotId,
selectedSnapshotSource:
snapshot
.selectedSnapshotSource ||
null,
selectedSnapshotReason:
snapshot
.selectedSnapshotReason ||
null,
selectedTargetCandidateCount:
snapshot
.selectedTargetCandidateCount ||
0,
selectedLongCandidateCount:
snapshot
.selectedLongCandidateCount ||
0,
selectedOppositeCandidateCount:
snapshot
.selectedOppositeCandidateCount ||
0,
selectedShortCandidateCount:
snapshot
.selectedShortCandidateCount ||
0,
blockedNonLongCandidatesCount:
snapshot
.blockedNonLongCandidatesCount ||
0,

blockedNonShortCandidatesCount:
snapshot
.blockedNonShortCandidatesCount ||
0,
actions,
realExits,
virtualExits,
shadowExits,
entryRows:
0,
waitRows:
actions.length,
virtualCreatedRows:
0,
skippedNewEntries:
true,
reason:
'SNAPSHOT_ALREADY_PROCESSED',
actionCounts:
buildRunActionCounts(
actions,
virtualExits
),
marketContext,
runtimeBudgetMs:
runtime.runtimeBudgetMs,
deadlineAt:
runtime.deadlineAt,
remainingRuntimeMs:
runtime.remainingMs(),
monitorOpenPositions:
true,
monitorOpenPositionsFirst:
true,
processScannerSnapshot:
false,
...isolationFlags()
});
}
const activeRotation = await getActiveRotation({
weekKey: PERSISTENT_LEARNING_KEY,
persistentLearningKey: PERSISTENT_LEARNING_KEY,
targetTradeSide: TARGET_TRADE_SIDE,
tradeSide: TARGET_TRADE_SIDE,
side: TARGET_DASHBOARD_SIDE,
dashboardSide: TARGET_DASHBOARD_SIDE,
namespace: LONG_NAMESPACE,

keyPrefix: LONG_KEY_PREFIX,
redisNamespace: LONG_NAMESPACE,
redisKeyPrefix: LONG_KEY_PREFIX,
longOnly: true,
shortDisabled: true,
exactTrueMicroOnly: true,
selectionGranularity: 'EXACT_75_CHILD',
trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA
}).catch(() => null);
const alertContext = buildSelectedAlertContext(activeRotation);
const rawCandidates =
(
Array.isArray(
snapshot.candidates
)
? snapshot.candidates
: []
)
.filter(
(candidate) =>
candidateTradeSide(
candidate
) ===
TARGET_TRADE_SIDE
)
.slice(
0,
cfg.maxCandidatesPerSnapshot
);
const candidateOrder =
buildSnapshotCandidateOrder({
snapshotId:
snapshot.snapshotId,
candidates:
rawCandidates,
progress:
snapshotProgress
});
const allCandidates =
candidateOrder.candidates;
const candidateOrderVersion =
candidateOrder
.candidateOrderVersion;
const candidateRotationOffset =
candidateOrder

.candidateRotationOffset;
const candidateOrderDeterministic =
candidateOrder
.candidateOrderDeterministic;
const legacyProgressOrderPreserved =
candidateOrder
.legacyProgressOrderPreserved;
const totalSnapshotCandidateCount =
allCandidates.length;
const previousNextCandidateIndex =
continuationActive
? Math.max(
0,
Math.min(
totalSnapshotCandidateCount,
Math.floor(
safeNumber(
snapshotProgress
?.nextCandidateIndex,
0
)
)
)
)
: 0;
const candidateStartIndex =
forceProcessSnapshot
? 0
: previousNextCandidateIndex;
const candidateEndExclusive =
Math.min(
totalSnapshotCandidateCount,
candidateStartIndex +
cfg.maxCandidatesPerInvocation
);
const preAnalyzeBlockedActions =
candidateStartIndex === 0 &&
Array.isArray(
snapshot
.blockedNonLongCandidates
)
? snapshot
.blockedNonLongCandidates
: [];
const candidates =
allCandidates
.slice(

candidateStartIndex,
candidateEndExclusive
)
.map(
(candidate) =>
attachCurrentFitContext(
{
...candidate,
...scannerMetadataFrom(
candidate
),
...sideFlags(),
...isolationFlags(),
...virtualFlags(
candidate
),
btcState:
snapshot.btcState,
regime:
snapshot.regime
},
marketContext
)
);
const longCandidateCount =
totalSnapshotCandidateCount;
const batchLongCandidateCount =
candidates.length;
const nonLongCandidateCount =
snapshot
.blockedNonLongCandidatesCount ||
0;
if (
candidateStartIndex >=
totalSnapshotCandidateCount
) {
await clearSnapshotProgress(
durableRedis
);
const actions =
preAnalyzeBlockedActions;
const completedRow = {
snapshotId:
snapshot.snapshotId,
runId,
processedAt:
now(),

forceProcessSnapshot,
candidateStartIndex,
candidateEndExclusive,
nextCandidateIndex:
totalSnapshotCandidateCount,
snapshotCandidateCount:
totalSnapshotCandidateCount,
candidateOrderVersion,
candidateRotationOffset,
candidateOrderDeterministic,
legacyProgressOrderPreserved,
snapshotSelectionPolicy:
SNAPSHOT_SELECTION_POLICY,
resumedUnfinishedSnapshot,
continuationProgressStale,
abandonedSnapshotProgressId,
abandonedSnapshotProgressReason,
snapshotProcessingComplete:
true,
batchProcessingComplete:
true,
selectedSnapshotSource:
snapshot
.selectedSnapshotSource ||
null,
selectedSnapshotReason:
snapshot
.selectedSnapshotReason ||
null,
currentMarketWeather:
compactMarketWeatherForStorage(
marketContext.source
),
currentMarketUniverse:
compactMarketUniverseForStorage(
marketContext.universe
),
...sideFlags(),
...virtualFlags(),
...isolationFlags()
};
await scopedSetJson(
durableRedis,
LONG_KEYS.trade
.lastProcessedSnapshot,
completedRow
);

return saveRunMeta({
runId,
startedAt,
snapshotId:
snapshot.snapshotId,
snapshotCreatedAt:
snapshot.createdAt,
snapshotAgeSec:
Math.round(
snapshotAgeSec
),
actions,
realExits,
virtualExits,
shadowExits,
entryRows:
0,
waitRows:
actions.length,
virtualCreatedRows:
0,
skippedNewEntries:
true,
reason:
'SNAPSHOT_BATCH_CURSOR_AT_END',
candidateStartIndex,
candidateEndExclusive,
nextCandidateIndex:
totalSnapshotCandidateCount,
snapshotCandidateCount:
totalSnapshotCandidateCount,
candidateOrderVersion,
candidateRotationOffset,
candidateOrderDeterministic,
legacyProgressOrderPreserved,
snapshotSelectionPolicy:
SNAPSHOT_SELECTION_POLICY,
resumedUnfinishedSnapshot,
continuationProgressStale,
abandonedSnapshotProgressId,
abandonedSnapshotProgressReason,
snapshotProcessingComplete:
true,
batchProcessingComplete:
true,
actionCounts:
buildRunActionCounts(

actions,
virtualExits
),
marketContext,
runtimeBudgetMs:
runtime.runtimeBudgetMs,
deadlineAt:
runtime.deadlineAt,
remainingRuntimeMs:
runtime.remainingMs(),
monitorOpenPositions:
true,
monitorOpenPositionsFirst:
true,
processScannerSnapshot:
false,
...isolationFlags()
});
}
if (
runtime.shouldStop(
DEFAULT_MIN_REMAINING_FOR_ENTRY_MS
)
) {
await saveSnapshotProgress(
durableRedis,
{
snapshotId:
snapshot.snapshotId,
runId,
startedAt,
nextCandidateIndex:
candidateStartIndex,
snapshotCandidateCount:
totalSnapshotCandidateCount,
candidateOrderVersion,
candidateRotationOffset,
candidateOrderDeterministic,
legacyProgressOrderPreserved,
snapshotSelectionPolicy:
SNAPSHOT_SELECTION_POLICY,
resumedUnfinishedSnapshot,
continuationProgressStale,
completed:
false,
reason:
'RUNTIME_BUDGET_LOW_BEFORE_CANDIDATE_BATCH',

selectedSnapshotSource:
snapshot
.selectedSnapshotSource ||
null,
selectedSnapshotReason:
snapshot
.selectedSnapshotReason ||
null,
currentMarketWeather:
marketContext.source,
currentMarketUniverse:
marketContext.universe
}
);
return saveRunMeta({
runId,
startedAt,
snapshotId:
snapshot.snapshotId,
snapshotCreatedAt:
snapshot.createdAt,
snapshotAgeSec:
Math.round(
snapshotAgeSec
),
actions:
preAnalyzeBlockedActions,
realExits,
virtualExits,
shadowExits,
entryRows:
0,
waitRows:
preAnalyzeBlockedActions.length,
virtualCreatedRows:
0,
skippedNewEntries:
true,
reason:
'SNAPSHOT_BATCH_RETRY_REQUIRED_RUNTIME_BUDGET',
candidateStartIndex,
candidateEndExclusive,
nextCandidateIndex:
candidateStartIndex,
snapshotCandidateCount:
totalSnapshotCandidateCount,
candidateOrderVersion,

candidateRotationOffset,
candidateOrderDeterministic,
legacyProgressOrderPreserved,
snapshotSelectionPolicy:
SNAPSHOT_SELECTION_POLICY,
resumedUnfinishedSnapshot,
continuationProgressStale,
abandonedSnapshotProgressId,
abandonedSnapshotProgressReason,
snapshotProcessingComplete:
false,
batchProcessingComplete:
false,
runtimeBudgetMs:
runtime.runtimeBudgetMs,
deadlineAt:
runtime.deadlineAt,
remainingRuntimeMs:
runtime.remainingMs(),
marketContext,
actionCounts:
buildRunActionCounts(
preAnalyzeBlockedActions,
virtualExits
),
monitorOpenPositions:
true,
monitorOpenPositionsFirst:
true,
processScannerSnapshot:
true,
...isolationFlags()
});
}
const processed =
await mapConcurrent(
candidates,
cfg.dataConcurrency,
safeProcessCandidate
);
const earlyActions = [
...preAnalyzeBlockedActions,
...processed
.flatMap((row) => Array.isArray(row?.actions) ? row.actions : [])
.filter(Boolean)
];
const liveRows = processed

.flatMap((row) => Array.isArray(row?.metrics) ? row.metrics : [])
.filter(Boolean)
.filter(isTargetRow)
.map((row) => attachCurrentFitContext({
...row,
...sideFlags(),
...isolationFlags(),
...virtualFlags(row)
}, marketContext));
const actualLiveRows = liveRows.filter(isLiveScannerRow).length;
const mirrorRows = liveRows.filter(isMirrorAnalysisRow).length;
const observationOnlyRows = liveRows.filter((row) => row.observationOnly ||
row.analysisInputOnly).length;
const standardizedLearningRiskRows = liveRows.filter((row) =>
row.standardizedLearningRisk).length;
const syntheticRiskRows = liveRows.filter((row) => row.syntheticRisk).length;
const learningOnlyRows = liveRows.filter((row) => row.learningOnly).length;
const riskValidRows = liveRows.filter(hasValidRiskShape).length;
let analyzedRowsRaw = [];
let analyzeError = null;
let analyzeBatchMeta = null;
try {
analyzedRowsRaw = await analyzeCandidatesBatch(liveRows, {
weekKey: PERSISTENT_LEARNING_KEY,
persistentLearningKey: PERSISTENT_LEARNING_KEY,
targetTradeSide: TARGET_TRADE_SIDE,
tradeSide: TARGET_TRADE_SIDE,
positionSide: TARGET_TRADE_SIDE,
direction: TARGET_TRADE_SIDE,
side: TARGET_DASHBOARD_SIDE,
scannerSide: TARGET_SCANNER_SIDE,
actualScannerSide: TARGET_SCANNER_SIDE,
dashboardSide: TARGET_DASHBOARD_SIDE,
longOnly: true,
shortDisabled: true,
shortOnly: false,
longDisabled: false,
virtualOnly: true,
virtualLearning: true,
realOrdersDisabled: true,
bitgetOrdersDisabled: true,
exchangeCallsDisabled: true,
observationAlwaysCounted: false,
observationDedupeRequired: true,
observationDedupeEnabled: true,
seenDefinition: 'UNIQUE_SNAPSHOT_SYMBOL_TRUE_MICRO_OBSERVATION_ONLY',
scannerFingerprintsMetadataOnly: true,

scannerFingerprintsUsedAsLearningFamily: false,
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
fixedTaxonomyPreferred: true,
trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
learningGranularity: LEARNING_GRANULARITY,
parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
parentLearningEnabled: true,
childLearningEnabled: true,
selectionGranularity: 'EXACT_75_CHILD',
fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED',
currentMarketWeather: marketContext.source || null,
currentMarketUniverse: marketContext.universe || null,
currentMarketWeatherKey: MARKET_WEATHER_KEY,
currentMarketUniverseKey: MARKET_UNIVERSE_KEY,
currentRegime: marketContext.regime,
currentTrendSide: marketContext.trendSide,
currentFitSoftOnly: true,
currentFitBlocksLearning: false,
currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
riskGeometryRule: 'LONG: sl < entry < tp',
tpHitRule: 'LONG: price >= tp',
slHitRule: 'LONG: price <= sl',
grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
currentRFormula: '(currentPrice - entry) / (entry - initialSl)',
runtimeBudgetMs:
runtime.runtimeBudgetMs,
deadlineAt:
runtime.deadlineAt,
stopBeforeDeadlineMs:
runtime.stopBeforeDeadlineMs
});
analyzeBatchMeta =
analyzedRowsRaw?.batchMeta ||
null;

} catch (error) {
analyzeError = error?.message || String(error);
analyzedRowsRaw = [];
}
const analyzedRows = analyzedRowsRaw
.filter(Boolean)
.filter(isTargetRow)
.filter((row) => !isMirrorAnalysisRow(row))
.map((row) => attachCurrentFitContext({
...normalizeExactTrueMicroRow(row),
...scannerMetadataFrom(row),
...sideFlags(),
...virtualFlags(row),
...isolationFlags()
}, marketContext));
const analyzedActualRows = analyzedRows.filter(isLiveScannerRow).length;
const analyzedMirrorRows = analyzedRows.filter(isMirrorAnalysisRow).length;
const analyzedRiskValidRows = analyzedRows.filter(hasValidRiskShape).length;
const analyzedExact75Rows = analyzedRows.filter((row) =>
Boolean(getTrueMicroFamilyId(row))).length;
const analyzedStandardizedLearningRiskRows = analyzedRows.filter((row) =>
row.standardizedLearningRisk).length;
const analyzedSyntheticRiskRows = analyzedRows.filter((row) =>
row.syntheticRisk).length;
const openPositions =
await getOpenPositions({
tradeSide:
TARGET_TRADE_SIDE,
side:
TARGET_DASHBOARD_SIDE,
namespace:
LONG_NAMESPACE,
keyPrefix:
LONG_KEY_PREFIX,
virtualOnly:
true
});
const openPositionCountBeforeEntries =
openPositions.length;
const openSymbolSet =
new Set(
openPositions
.map(
positionSymbolKey
)
.filter(Boolean)
);

const actions = [
...earlyActions.map(
stripHeavyTradeRow
)
];
let entryRows = 0;
let waitRows =
earlyActions.length;
let virtualCreatedRows = 0;
let virtualSkippedRows = 0;
let virtualFailedRows = 0;
let skippedByExistingSymbol = 0;
let discordAlertEligibleRows = 0;
let discordAlertsQueued = 0;
let discordAlertsSkippedNoSelectedMicro = 0;
let discordAlertsSkippedCurrentFit = 0;
let selectedMicroMatchRows = 0;
let unselectedMicroEntryRows = 0;
let entryProcessingIncomplete =
false;
let entryProcessingStoppedAtIndex =
null;
for (
let rowIndex = 0;
rowIndex < analyzedRows.length;
rowIndex += 1
) {
if (
runtime.shouldStop(
DEFAULT_MIN_REMAINING_FOR_ENTRY_MS
)
) {
entryProcessingIncomplete =
true;
entryProcessingStoppedAtIndex =
rowIndex;
break;
}
const row =
analyzedRows[rowIndex];
const trueMicroFamilyId =
getTrueMicroFamilyId(row);
if (!isTargetRow(row)) {
waitRows += 1;
virtualSkippedRows += 1;
actions.push(
stripHeavyTradeRow({

...row,
action:
'WAIT',
reason:
'SHORT_DISABLED_LONG_ONLY_SYSTEM',
selectedRotationId:
alertContext.rotationId,
activeRotationId:
alertContext.rotationId,
virtualTracked:
false,
liveEligible:
false,
...sideFlags(),
...isolationFlags()
})
);
continue;
}
const virtualGate =
validateVirtualEntry(row);
if (!virtualGate.ok) {
waitRows += 1;
virtualSkippedRows += 1;
actions.push(
stripHeavyTradeRow({
...row,
action:
'WAIT',
reason:
virtualGate.reason,
selectedRotationId:
alertContext.rotationId,
activeRotationId:
alertContext.rotationId,
activeParentTrueMicroFamilyId:
getParentTrueMicroFamilyId(
row
) || null,
virtualGate,
virtualTracked:
false,
liveEligible:
false,
currentFitSoftOnly:
true,
currentFitBlocksLearning:

false,
currentFitPolarity:
'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition:
'LONG_MIRRORED_CURRENT_FIT',
...sideFlags(),
...isolationFlags()
})
);
continue;
}
const symbolKey =
positionSymbolKey(row);
const alreadyOpen =
Boolean(
symbolKey &&
openSymbolSet.has(
symbolKey
)
);
if (alreadyOpen) {
waitRows += 1;
virtualSkippedRows += 1;
skippedByExistingSymbol += 1;
actions.push(
stripHeavyTradeRow({
...row,
action:
'WAIT',
reason:
'SYMBOL_ALREADY_OPEN_VIRTUAL_POSITION',
selectedRotationId:
alertContext.rotationId,
activeRotationId:
alertContext.rotationId,
virtualTracked:
true,
liveEligible:
false,
oneOpenPositionPerSymbol:
true,
globalMaxOpenPositionsBlockDisabled:
true,
currentFitSoftOnly:
true,
currentFitBlocksLearning:
false,

currentFitPolarity:
'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition:
'LONG_MIRRORED_CURRENT_FIT',
...sideFlags(),
...isolationFlags()
})
);
continue;
}
const selectedWeeklyStats =
getSelectedWeeklyStats(
alertContext,
trueMicroFamilyId,
row
);
const sizingStats =
selectedWeeklyStats ||
row;
const riskFraction =
sizing.enabled
? riskFractionForEntry({
weeklyStats:
sizingStats,
side:
TARGET_DASHBOARD_SIDE,
tradeSide:
TARGET_TRADE_SIDE
})
: sizing.baseRiskPct;
const selectedExactMicroMatch =
rowMatchesSelectedAlertMicro(
alertContext,
row
);
const currentFitGate =
discordCurrentFitGate(row);
const previewEntryTemporal = entryTemporalFields(row, row.entryTs ??
row.entryCreatedAt ?? now());
const previewDiscordEntryGate = discordCompositeEntryGate({
row,
selectedWeeklyStats,
selectedExactMicroMatch,
currentFitGate,
entryTemporal: previewEntryTemporal
});
const discordAlertEligible = previewDiscordEntryGate.ok;

if (selectedExactMicroMatch) {
selectedMicroMatchRows += 1;
} else {
discordAlertsSkippedNoSelectedMicro +=
1;
unselectedMicroEntryRows +=
1;
}
if (
selectedExactMicroMatch &&
!currentFitGate.ok
) {
discordAlertsSkippedCurrentFit +=
1;
}
if (discordAlertEligible) {
discordAlertEligibleRows +=
1;
}
const actualEntryTs = now();
const entry = buildVirtualEntryAction({
row,
alertContext,
selectedWeeklyStats,
riskFraction,
virtualGate,
selectedExactMicroMatch,
discordAlertEligible,
entryTs: actualEntryTs
});
try {
const entryDecisionSnapshot = await evaluateTemporalEntryPolicy({
row: entry,
wouldPublishWithoutTemporal: entry.wouldPublishWithoutTemporal === true,
nowTs: actualEntryTs
});
const finalEntry = {
...entry,
entryDecisionSnapshot,
temporalEntryDecisionSnapshot: entryDecisionSnapshot,
temporalDecisionPending: false,
temporalWouldBlock: entryDecisionSnapshot.temporalWouldBlock === true,
temporalBlockReasons: entryDecisionSnapshot.temporalBlockReasons || [],
activeTemporalGenerationId:
entryDecisionSnapshot.activeTemporalGenerationId || null,
finalDiscordEntryAllowed:
entryDecisionSnapshot.finalDiscordEntryAllowed === true,
discordAlertEligible:
entryDecisionSnapshot.finalDiscordEntryAllowed === true,
selectedMicroFamilyAlert:
entryDecisionSnapshot.wouldPublishWithoutTemporal === true,
selectedForDiscord:
entryDecisionSnapshot.wouldPublishWithoutTemporal === true,
liveEligible:
entryDecisionSnapshot.finalDiscordEntryAllowed === true,
discordAlertReason:
entryDecisionSnapshot.finalDiscordEntryAllowed === true
? 'SELECTED_LONG_TRUE_MICRO_FAMILY_EXACT_75_CHILD_MATCH_AND_TEMPORAL_POLICY_ALLOWED'
: entryDecisionSnapshot.temporalBlockReasons?.[0] ||
entry.discordAlertReason ||
'DISCORD_ENTRY_GATE_BLOCKED'
};
const entryForStorage = stripHeavyTradeRow(finalEntry);
const position = buildOpenPositionFromEntry(entryForStorage);
let positionForStorage = stripHeavyTradeRow({
...position,
...isolationFlags()
});
positionForStorage = await saveOpenPosition(positionForStorage);
const entryPublicationResult = await maybeSendDiscordEntryAlert(
positionForStorage
);
let entryPublicationResultPersisted = false;
try {
positionForStorage = await saveExistingOpenPosition({
...positionForStorage,
entryPublicationResult,
discordAlertResult: entryPublicationResult,
discordAlertQueued: false,
discordAlertSent: entryPublicationResult.sent === true,
entryPublicationResultPersisted: true
});
entryPublicationResultPersisted = true;
} catch (publicationPersistError) {
positionForStorage = {
...positionForStorage,
entryPublicationResult,
discordAlertResult: entryPublicationResult,
discordAlertQueued: false,
discordAlertSent: entryPublicationResult.sent === true,
entryPublicationResultPersisted: false,
entryPublicationResultPersistError:
publicationPersistError?.message || String(publicationPersistError)
};
}
openPositions.push(positionForStorage);
if (symbolKey) {
openSymbolSet.add(symbolKey);
}
entryRows += 1;
virtualCreatedRows += 1;
if (entryPublicationResult.sent) {
discordAlertsQueued += 1;
}
actions.push(
stripHeavyTradeRow({
...positionForStorage,
entryPublicationResult,
entryPublicationResultPersisted,
discordAlertResult: entryPublicationResult,
discordAlertQueued: false,
discordAlertSent: entryPublicationResult.sent === true,
...isolationFlags()
})
);
} catch (error) {
waitRows += 1;
virtualFailedRows += 1;
actions.push(
stripHeavyTradeRow({
...row,
action:
'WAIT',
reason:
'VIRTUAL_POSITION_CREATE_FAILED',
error:
error?.message ||
String(error),
selectedRotationId:
alertContext.rotationId,
activeRotationId:
alertContext.rotationId,

virtualTracked:
false,
liveEligible:
false,
currentFitSoftOnly:
true,
currentFitBlocksLearning:
false,
currentFitPolarity:
'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition:
'LONG_MIRRORED_CURRENT_FIT',
...sideFlags(),
...isolationFlags()
})
);
}
}
const counts =
buildRunActionCounts(
actions,
virtualExits
);
const batchProcessingComplete =
!analyzeError &&
!entryProcessingIncomplete;
const nextCandidateIndex =
batchProcessingComplete
? candidateEndExclusive
: candidateStartIndex;
const snapshotProcessingComplete =
batchProcessingComplete &&
nextCandidateIndex >=
totalSnapshotCandidateCount;
const qualityAudit =
buildQualityAudit({
snapshot,
candidates,
processed,
liveRows,
analyzedRowsRaw,
analyzedRows,
actions,
virtualExits,
counts: {
riskValidRows,
analyzedRiskValidRows,

analyzedExact75Rows,
entryRows,
virtualCreatedRows,
waitRows,
skippedByExistingSymbol,
selectedAlertMicroMatches:
selectedMicroMatchRows,
discordCurrentFitBlockedRows:
discordAlertsSkippedCurrentFit
},
openPositionCountBeforeEntries,
openPositionCountAfterEntries:
openPositions.length,
marketContext
});
qualityAudit.runtime = {
mode:
'RESUMABLE_SNAPSHOT_BATCH',
runtimeBudgetMs:
runtime.runtimeBudgetMs,
deadlineAt:
runtime.deadlineAt,
remainingRuntimeMs:
runtime.remainingMs(),
candidateStartIndex,
candidateEndExclusive,
nextCandidateIndex,
batchCandidateCount:
candidates.length,
totalSnapshotCandidateCount,
candidateOrderVersion,
candidateRotationOffset,
candidateOrderDeterministic,
legacyProgressOrderPreserved,
snapshotSelectionPolicy:
SNAPSHOT_SELECTION_POLICY,
resumedUnfinishedSnapshot,
continuationProgressStale,
abandonedSnapshotProgressId,
abandonedSnapshotProgressReason,
batchProcessingComplete,
snapshotProcessingComplete,
entryProcessingIncomplete,
entryProcessingStoppedAtIndex,
analyzeBatchMeta,
analyzeError
};

const lastProcessedRow = {
snapshotId:
snapshot.snapshotId,
runId,
processedAt:
now(),
forceProcessSnapshot,
candidateStartIndex,
candidateEndExclusive,
nextCandidateIndex,
snapshotCandidateCount:
totalSnapshotCandidateCount,
candidateOrderVersion,
candidateRotationOffset,
candidateOrderDeterministic,
legacyProgressOrderPreserved,
snapshotSelectionPolicy:
SNAPSHOT_SELECTION_POLICY,
resumedUnfinishedSnapshot,
continuationProgressStale,
abandonedSnapshotProgressId,
abandonedSnapshotProgressReason,
batchCandidateCount:
candidates.length,
batchProcessingComplete,
snapshotProcessingComplete,
entryProcessingIncomplete,
entryProcessingStoppedAtIndex,
selectedSnapshotSource:
snapshot
.selectedSnapshotSource ||
null,
selectedSnapshotReason:
snapshot
.selectedSnapshotReason ||
null,
selectedTargetCandidateCount:
snapshot
.selectedTargetCandidateCount ||
0,
selectedLongCandidateCount:
snapshot
.selectedLongCandidateCount ||
0,
selectedOppositeCandidateCount:
snapshot
.selectedOppositeCandidateCount ||

0,
selectedShortCandidateCount:
snapshot
.selectedShortCandidateCount ||
0,
blockedNonLongCandidatesCount:
snapshot
.blockedNonLongCandidatesCount ||
0,
blockedNonShortCandidatesCount:
snapshot
.blockedNonShortCandidatesCount ||
0,
entryRelaxationProfile:
cfg.entryRelaxationProfile,
qualityMeasurementProfile:
cfg.qualityMeasurementProfile,
scannerWideVirtualLearning:
cfg.scannerWideVirtualLearning,
tradeEveryScannerCandidateVirtual:
cfg.tradeEveryScannerCandidateVirtual,
minLiveCandles15m:
cfg.minLiveCandles15m,
allowStandardizedLearningRiskFallback:
cfg.allowStandardizedLearningRiskFallback,
allowStandardizedLearningRiskVirtualEntries:
cfg.allowStandardizedLearningRiskVirtualEntries,
standardizedLearningRiskRequiresScannerGatePassed:
cfg.standardizedLearningRiskRequiresScannerGatePassed,
standardizedLearningRiskRequiresAnalyzeEligible:
cfg.standardizedLearningRiskRequiresAnalyzeEligible,
standardizedLearningRiskRequiresSpreadGatePassed:
cfg.standardizedLearningRiskRequiresSpreadGatePassed,
minRiskPct:
cfg.minRiskPct,
maxRiskPct:
cfg.maxRiskPct,
fallbackRiskPct:
cfg.fallbackRiskPct,
...sideFlags(),
...virtualFlags(),
...isolationFlags(),
currentMarketWeather:
compactMarketWeatherForStorage(
marketContext.source
),
currentMarketUniverse:

compactMarketUniverseForStorage(
marketContext.universe
),
currentMarketWeatherKey:
MARKET_WEATHER_KEY,
currentMarketUniverseKey:
MARKET_UNIVERSE_KEY,
currentMarketWeatherAgeSec:
marketContext.ageSec,
currentMarketWeatherStale:
marketContext.stale,
currentRegime:
marketContext.regime,
currentTrendSide:
marketContext.trendSide,
currentBearishPct:
marketContext.bearishPct,
currentBullishPct:
marketContext.bullishPct,
currentSqueezePct:
marketContext.squeezePct,
candidates:
candidates.length,
totalSnapshotCandidates:
totalSnapshotCandidateCount,
longCandidateCount,
batchLongCandidateCount,
shortCandidateCount:
0,
nonLongCandidateCount,
processed:
processed.length,
earlyActions:
earlyActions.length,
liveRows:
liveRows.length,
analyzeInputRows:
liveRows.length,
actualLiveRows,
mirrorRows,
observationOnlyRows,
standardizedLearningRiskRows,
syntheticRiskRows,
learningOnlyRows,
riskValidRows,
analyzedRows:
analyzedRows.length,

analyzedRowsRaw:
analyzedRowsRaw.length,
analyzedActualRows,
analyzedMirrorRows,
analyzedRiskValidRows,
analyzedExact75Rows,
analyzedStandardizedLearningRiskRows,
analyzedSyntheticRiskRows,
analyzeError,
analyzeBatchMeta,
analyzeWeekKey:
PERSISTENT_LEARNING_KEY,
entryRows,
waitRows,
virtualCreatedRows,
virtualSkippedRows,
virtualFailedRows,
skippedByExistingSymbol,
shadowCreatedRows:
virtualCreatedRows,
shadowSkippedRows:
virtualSkippedRows,
shadowFailedRows:
virtualFailedRows,
shadowDisabled:
false,
virtualExits:
virtualExits.map(
compactVirtualExitForStorage
),
shadowExits:
shadowExits.map(
compactVirtualExitForStorage
),
realExits:
[],
virtualExitRows:
virtualExits.length,
shadowExitRows:
shadowExits.length,
realExitRows:
0,
discordRequiresCurrentFit:
discordRequiresCurrentFit(),
discordMinCurrentFitConfidence:
discordMinCurrentFitConfidence(),
discordAlertEligibleRows,

discordAlertsQueued,
discordAlertsSent:
0,
discordAlertsSkippedNoSelectedMicro,
discordAlertsSkippedCurrentFit,
selectedMicroMatchRows,
selectedAlertMicroMatches:
selectedMicroMatchRows,
unselectedMicroEntryRows,
openPositionCountBeforeEntries,
openPositionCountAfterEntries:
openPositions.length,
actions:
actions.length,
actionCounts:
counts,
qualityAudit,
selectedRotationId:
alertContext.rotationId,
activeRotationId:
alertContext.rotationId,
selectedMicroFamilies:
alertContext
.selectedMicroFamilyIds
.length,
selectedTrueMicroFamilies:
alertContext
.selectedMicroFamilyIds
.length,
selectedChildTrueMicroFamilies:
alertContext
.selectedMicroFamilyIds
.length,
selectedParentTrueMicroFamilies:
alertContext
.selectedParentTrueMicroFamilyIds
.length,
selectedMicroFamilyIds:
alertContext
.selectedMicroFamilyIds,
selectedTrueMicroFamilyIds:
alertContext
.selectedTrueMicroFamilyIds,
selectedChildTrueMicroFamilyIds:
alertContext
.selectedChildTrueMicroFamilyIds,
selectedParentTrueMicroFamilyIds:

alertContext
.selectedParentTrueMicroFamilyIds,
selectedMacroFamilyIds:
[],
activeMicroFamilies:
alertContext
.selectedMicroFamilyIds
.length,
activeTrueMicroFamilies:
alertContext
.selectedMicroFamilyIds
.length,
activeChildTrueMicroFamilies:
alertContext
.selectedMicroFamilyIds
.length,
activeParentTrueMicroFamilies:
alertContext
.selectedParentTrueMicroFamilyIds
.length,
activeMicroFamilyIds:
alertContext
.selectedMicroFamilyIds,
activeTrueMicroFamilyIds:
alertContext
.selectedTrueMicroFamilyIds,
activeChildTrueMicroFamilyIds:
alertContext
.selectedChildTrueMicroFamilyIds,
activeParentTrueMicroFamilyIds:
alertContext
.selectedParentTrueMicroFamilyIds,
activeMacroFamilyIds:
[],
trueMicroOnly:
alertContext.trueMicroOnly,
exactTrueMicroOnly:
true,
exactTrueMicroFamilyRequired:
true,
allowCoarseMicroAliasLiveEntries:
false,
allowCoarseMicroAliasForDiscord:
false,
selectionPurpose:
'DISCORD_ALERT_ONLY',
runtimeBudgetMs:

runtime.runtimeBudgetMs,
deadlineAt:
runtime.deadlineAt,
remainingRuntimeMs:
runtime.remainingMs(),
monitorOpenPositions:
true,
monitorOpenPositionsFirst:
true,
processScannerSnapshot:
true,
fullPayloadPersisted:
false,
marketWeatherRowsPersisted:
false,
marketUniverseRowsPersisted:
false,
candidateRowsPersisted:
false,
candleDataPersisted:
false
};
if (snapshotProcessingComplete) {
await clearSnapshotProgress(
durableRedis
);
await scopedSetJson(
durableRedis,
LONG_KEYS.trade
.lastProcessedSnapshot,
lastProcessedRow
);
} else {
await saveSnapshotProgress(
durableRedis,
{
snapshotId:
snapshot.snapshotId,
runId,
startedAt,
processedAt:
now(),
nextCandidateIndex,
snapshotCandidateCount:
totalSnapshotCandidateCount,
candidateOrderVersion,
candidateRotationOffset,

candidateOrderDeterministic,
legacyProgressOrderPreserved,
snapshotSelectionPolicy:
SNAPSHOT_SELECTION_POLICY,
resumedUnfinishedSnapshot,
continuationProgressStale,
batchCandidateCount:
candidates.length,
candidateStartIndex,
candidateEndExclusive,
batchProcessingComplete,
snapshotProcessingComplete:
false,
completed:
false,
entryProcessingIncomplete,
entryProcessingStoppedAtIndex,
analyzeError,
analyzeBatchMeta,
selectedSnapshotSource:
snapshot
.selectedSnapshotSource ||
null,
selectedSnapshotReason:
snapshot
.selectedSnapshotReason ||
null,
currentMarketWeather:
marketContext.source,
currentMarketUniverse:
marketContext.universe
}
);
}
const responseActions =
actions
.slice(
0,
cfg.runResponseActionLimit
)
.map(
stripHeavyTradeRow
);
const runReason =
snapshotProcessingComplete
? 'SNAPSHOT_PROCESSING_COMPLETE'
: batchProcessingComplete

? 'SNAPSHOT_BATCH_COMPLETE_MORE_REMAINING'
: analyzeError
? 'SNAPSHOT_BATCH_RETRY_REQUIRED_ANALYZE_ERROR'
: 'SNAPSHOT_BATCH_RETRY_REQUIRED_RUNTIME_BUDGET';
return saveRunMeta({
runId,
startedAt,
snapshotId:
snapshot.snapshotId,
snapshotCreatedAt:
snapshot.createdAt,
snapshotAgeSec:
Math.round(
snapshotAgeSec
),
selectedSnapshotSource:
snapshot
.selectedSnapshotSource ||
null,
selectedSnapshotReason:
snapshot
.selectedSnapshotReason ||
null,
selectedTargetCandidateCount:
snapshot
.selectedTargetCandidateCount ||
0,
selectedLongCandidateCount:
snapshot
.selectedLongCandidateCount ||
0,
selectedOppositeCandidateCount:
snapshot
.selectedOppositeCandidateCount ||
0,
selectedShortCandidateCount:
snapshot
.selectedShortCandidateCount ||
0,
blockedNonLongCandidatesCount:
snapshot
.blockedNonLongCandidatesCount ||
0,
blockedNonShortCandidatesCount:
snapshot
.blockedNonShortCandidatesCount ||
0,

candidateStartIndex,
candidateEndExclusive,
nextCandidateIndex,
snapshotCandidateCount:
totalSnapshotCandidateCount,
candidateOrderVersion,
candidateRotationOffset,
candidateOrderDeterministic,
legacyProgressOrderPreserved,
snapshotSelectionPolicy:
SNAPSHOT_SELECTION_POLICY,
resumedUnfinishedSnapshot,
continuationProgressStale,
abandonedSnapshotProgressId,
abandonedSnapshotProgressReason,
batchCandidateCount:
candidates.length,
batchNumber:
Math.floor(
candidateStartIndex /
cfg.maxCandidatesPerInvocation
) + 1,
batchProcessingComplete,
snapshotProcessingComplete,
snapshotContinuation:
continuationActive,
entryProcessingIncomplete,
entryProcessingStoppedAtIndex,
reason:
runReason,
skipReason:
null,
entryRelaxationProfile:
cfg.entryRelaxationProfile,
qualityMeasurementProfile:
cfg.qualityMeasurementProfile,
scannerWideVirtualLearning:
cfg.scannerWideVirtualLearning,
tradeEveryScannerCandidateVirtual:
cfg.tradeEveryScannerCandidateVirtual,
minLiveCandles15m:
cfg.minLiveCandles15m,
allowStandardizedLearningRiskFallback:
cfg.allowStandardizedLearningRiskFallback,
allowStandardizedLearningRiskVirtualEntries:
cfg.allowStandardizedLearningRiskVirtualEntries,
standardizedLearningRiskRequiresScannerGatePassed:

cfg.standardizedLearningRiskRequiresScannerGatePassed,
standardizedLearningRiskRequiresAnalyzeEligible:
cfg.standardizedLearningRiskRequiresAnalyzeEligible,
standardizedLearningRiskRequiresSpreadGatePassed:
cfg.standardizedLearningRiskRequiresSpreadGatePassed,
minRiskPct:
cfg.minRiskPct,
maxRiskPct:
cfg.maxRiskPct,
fallbackRiskPct:
cfg.fallbackRiskPct,
...sideFlags(),
...virtualFlags(),
...isolationFlags(),
currentMarketWeather:
compactMarketWeatherForStorage(
marketContext.source
),
currentMarketUniverse:
compactMarketUniverseForStorage(
marketContext.universe
),
currentMarketWeatherKey:
MARKET_WEATHER_KEY,
currentMarketUniverseKey:
MARKET_UNIVERSE_KEY,
currentMarketWeatherAgeSec:
marketContext.ageSec,
currentMarketWeatherStale:
marketContext.stale,
currentRegime:
marketContext.regime,
currentTrendSide:
marketContext.trendSide,
currentBearishPct:
marketContext.bearishPct,
currentBullishPct:
marketContext.bullishPct,
currentSqueezePct:
marketContext.squeezePct,
candidates:
candidates.length,
totalSnapshotCandidates:
totalSnapshotCandidateCount,
longCandidateCount,
batchLongCandidateCount,
shortCandidateCount:

0,
nonLongCandidateCount,
processed:
processed.length,
earlyActions:
earlyActions.length,
liveRows:
liveRows.length,
analyzeInputRows:
liveRows.length,
actualLiveRows,
mirrorRows,
observationOnlyRows,
standardizedLearningRiskRows,
syntheticRiskRows,
learningOnlyRows,
riskValidRows,
analyzedRows:
analyzedRows.length,
analyzedRowsRaw:
analyzedRowsRaw.length,
analyzedActualRows,
analyzedMirrorRows,
analyzedRiskValidRows,
analyzedExact75Rows,
analyzedStandardizedLearningRiskRows,
analyzedSyntheticRiskRows,
analyzeError,
analyzeBatchMeta,
analyzeWeekKey:
PERSISTENT_LEARNING_KEY,
entryRows,
waitRows,
virtualCreatedRows,
virtualSkippedRows,
virtualFailedRows,
skippedByExistingSymbol,
shadowCreatedRows:
virtualCreatedRows,
shadowSkippedRows:
virtualSkippedRows,
shadowFailedRows:
virtualFailedRows,
shadowDisabled:
false,
virtualExits:
virtualExits.map(

compactVirtualExitForStorage
),
shadowExits:
shadowExits.map(
compactVirtualExitForStorage
),
realExits:
[],
virtualExitRows:
virtualExits.length,
shadowExitRows:
shadowExits.length,
realExitRows:
0,
discordRequiresCurrentFit:
discordRequiresCurrentFit(),
discordMinCurrentFitConfidence:
discordMinCurrentFitConfidence(),
discordAlertEligibleRows,
discordAlertsQueued,
discordAlertsSent:
0,
discordAlertsSkippedNoSelectedMicro,
discordAlertsSkippedCurrentFit,
selectedMicroMatchRows,
selectedAlertMicroMatches:
selectedMicroMatchRows,
unselectedMicroEntryRows,
openPositionCountBeforeEntries,
openPositionCountAfterEntries:
openPositions.length,
actions:
responseActions,
rawActionsCount:
actions.length,
responseActionsTruncated:
actions.length >
responseActions.length,
actionCounts:
counts,
qualityAudit,
selectedRotationId:
alertContext.rotationId,
activeRotationId:
alertContext.rotationId,
selectedMicroFamilies:
alertContext

.selectedMicroFamilyIds
.length,
selectedTrueMicroFamilies:
alertContext
.selectedMicroFamilyIds
.length,
selectedChildTrueMicroFamilies:
alertContext
.selectedMicroFamilyIds
.length,
selectedParentTrueMicroFamilies:
alertContext
.selectedParentTrueMicroFamilyIds
.length,
selectedMicroFamilyIds:
alertContext
.selectedMicroFamilyIds,
selectedTrueMicroFamilyIds:
alertContext
.selectedTrueMicroFamilyIds,
selectedChildTrueMicroFamilyIds:
alertContext
.selectedChildTrueMicroFamilyIds,
selectedParentTrueMicroFamilyIds:
alertContext
.selectedParentTrueMicroFamilyIds,
selectedMacroFamilyIds:
[],
activeMicroFamilies:
alertContext
.selectedMicroFamilyIds
.length,
activeTrueMicroFamilies:
alertContext
.selectedMicroFamilyIds
.length,
activeChildTrueMicroFamilies:
alertContext
.selectedMicroFamilyIds
.length,
activeParentTrueMicroFamilies:
alertContext
.selectedParentTrueMicroFamilyIds
.length,
activeMicroFamilyIds:
alertContext
.selectedMicroFamilyIds,

activeTrueMicroFamilyIds:
alertContext
.selectedTrueMicroFamilyIds,
activeChildTrueMicroFamilyIds:
alertContext
.selectedChildTrueMicroFamilyIds,
activeParentTrueMicroFamilyIds:
alertContext
.selectedParentTrueMicroFamilyIds,
activeMacroFamilyIds:
[],
trueMicroOnly:
alertContext.trueMicroOnly,
exactTrueMicroOnly:
true,
exactTrueMicroFamilyRequired:
true,
allowCoarseMicroAliasLiveEntries:
false,
allowCoarseMicroAliasForDiscord:
false,
selectionPurpose:
'DISCORD_ALERT_ONLY',
scannerSnapshotStats: {
candidatesCount:
snapshot.candidatesCount ||
totalSnapshotCandidateCount,
scannerGateCandidatesCount:
snapshot
.scannerGateCandidatesCount ||
null,
analyzeOnlyCandidatesCount:
snapshot
.analyzeOnlyCandidatesCount ||
null,
filteredUniverse:
snapshot.filteredUniverse ||
null,
rawCount:
snapshot.rawCount ||
null,
blockedNonLongCandidatesCount:
snapshot
.blockedNonLongCandidatesCount ||
0,
blockedNonShortCandidatesCount:
snapshot

.blockedNonShortCandidatesCount ||
0
},
scannerLatestPreserved:
true,
scannerSnapshotPreserved:
true,
scannerHistoryPreserved:
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
monitorOpenPositions:
true,
monitorOpenPositionsFirst:
true,
processScannerSnapshot:
true,
skippedNewEntries:
false,
runtimeBudgetMs:
runtime.runtimeBudgetMs,
deadlineAt:
runtime.deadlineAt,
remainingRuntimeMs:
runtime.remainingMs(),
compactPersistence:
true,
fullPayloadPersisted:
false,
marketWeatherRowsPersisted:
false,
marketUniverseRowsPersisted:
false,
candidateRowsPersisted:
false,
candleDataPersisted:
false

});
}

