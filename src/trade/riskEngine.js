// ================= FILE: src/trade/riskEngine.js =================
import { CONFIG } from '../config.js';
import {
calculateAtrPct,
calculateRsi,
getRsiSlope,
getRsiZone,
classifyFlow
} from '../market/indicators.js';
import {
clamp,
getObRelation,
safeNumber,
sideToTradeSide
} from '../utils.js';
const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const TARGET_SCANNER_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';
const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';
const TEMPORAL_CONTEXT_VERSION = 'LONG_TEMPORAL_CONTEXT_UTC_V1';
const TEMPORAL_POLICY_VERSION = 'LONG_TEMPORAL_FAMILY_PROFILE_V1';
const WEEKEND_POLICY_VERSION = 'LONG_WEEKEND_PER_FAMILY_DAY_APPROVAL_V1';
const SESSION_POLICY_VERSION = 'LONG_DAY_SESSION_VETO_RECOVERY_V1';
const TEMPORAL_GENERATION_SCHEMA_VERSION = 'LONG_TEMPORAL_ROOT_GENERATION_V1';
const WEEKEND_MODE = 'RUNTIME_CONTROLLED';
const SESSION_MODE = 'RUNTIME_CONTROLLED';
const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = TRUE_MICRO_SCHEMA;
const LEARNING_GRANULARITY =
'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const MIN_COMPLETED_ACTIVE_LEARNING = 20;
const MIN_COMPLETED_FAMILY_GATE = 35;
const MEASUREMENT_FIX_VERSION =
'LONG_MEASUREMENT_FIX_TRIGGER_BOUNDARY_EXIT_FILL_V2';
const EXIT_FILL_MODEL_VERSION =
'LONG_TRIGGER_BOUNDARY_FILL_PLUS_COST_MODEL_V1';
const EMPIRICAL_VETO_POLICY_VERSION =
'LONG_EXACT_75_CHILD_NET_EDGE_VETO_V1';
const OUTCOME_MEASUREMENT_GATE_MODE = 'STRICT_EXACT_VERSION';
const DEFAULT_POSITION_TIME_STOP_MIN = 720;
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
function now() {
return Date.now();
}
function tradeConfig() {
return {
minRR: safeNumber(CONFIG.long?.trade?.minRR ?? CONFIG.trade?.longMinRR ??

CONFIG.trade?.minRR, 0.5),
defaultRR: safeNumber(CONFIG.long?.trade?.defaultRR ??
CONFIG.trade?.longDefaultRR ?? CONFIG.trade?.defaultRR, 1.5),
maxSpreadPct: safeNumber(CONFIG.long?.trade?.maxSpreadPct ??
CONFIG.trade?.longMaxSpreadPct ?? CONFIG.trade?.maxSpreadPct, 0.015),
minRiskPct: safeNumber(CONFIG.long?.trade?.minRiskPct ??
CONFIG.trade?.longMinRiskPct ?? CONFIG.trade?.minRiskPct, 0.004),
maxRiskPct: safeNumber(CONFIG.long?.trade?.maxRiskPct ??
CONFIG.trade?.longMaxRiskPct ?? CONFIG.trade?.maxRiskPct, 0.025),
fallbackRiskPct: safeNumber(CONFIG.long?.trade?.fallbackRiskPct ??
CONFIG.trade?.longFallbackRiskPct ?? CONFIG.trade?.fallbackRiskPct, 0.005),
atrRiskMult: safeNumber(CONFIG.long?.trade?.atrRiskMult ??
CONFIG.trade?.longAtrRiskMult ?? CONFIG.trade?.atrRiskMult, 1.2),
spreadRiskMult: safeNumber(CONFIG.long?.trade?.spreadRiskMult ??
CONFIG.trade?.longSpreadRiskMult ?? CONFIG.trade?.spreadRiskMult, 5),
positionTimeStopMin: safeNumber(
CONFIG.long?.trade?.positionTimeStopMin ??
CONFIG.trade?.longPositionTimeStopMin ??
CONFIG.trade?.positionTimeStopMin,
DEFAULT_POSITION_TIME_STOP_MIN
)
};
}
function fallbackSpreadPct() {
return safeNumber(
CONFIG.long?.cost?.fallbackSpreadPct ??
CONFIG.cost?.longFallbackSpreadPct ??
CONFIG.cost?.fallbackSpreadPct,
0.0008
);
}
function scoreInput(candidate = {}) {
return safeNumber(
candidate.scannerScore ?? candidate.moveScore,
0
);
}
function roundPrice(value) {
const n = safeNumber(value, 0);
if (n >= 1000) return Number(n.toFixed(2));
if (n >= 1) return Number(n.toFixed(6));
return Number(n.toFixed(10));
}
function round2(value) {
return Number(safeNumber(value, 0).toFixed(2));
}
function round4(value) {

return Number(safeNumber(value, 0).toFixed(4));
}
function round6(value) {
return Number(safeNumber(value, 0).toFixed(6));
}
function bool(value) {
if (typeof value === 'boolean') return value;
if (typeof value === 'number') return value !== 0;
const text = String(value || '').toLowerCase().trim();
return ['true', '1', 'yes', 'y'].includes(text);
}
function upper(value, fallback = 'UNKNOWN') {
const text = String(value || '').trim();
return text
? text.toUpperCase()
: fallback;
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
function normalizeTradeSideValue(value) {
const raw = cleanSideText(value);
if (!raw) return 'UNKNOWN';
const direct = sideToTradeSide(raw);
if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
const longHit = hasLongSignal(raw);
const shortHit = hasShortSignal(raw);
if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;
if (longHit && !shortHit) return TARGET_TRADE_SIDE;
if (longHit && shortHit) {
if (raw.includes('TRADE_SIDE=LONG') || raw.includes('TRADESIDE=LONG'))
return TARGET_TRADE_SIDE;
if (raw.includes('TRADE_SIDE=SHORT') || raw.includes('TRADESIDE=SHORT')) return
OPPOSITE_TRADE_SIDE;
if (raw.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
if (raw.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
}
if (longHit) return TARGET_TRADE_SIDE;
if (shortHit) return OPPOSITE_TRADE_SIDE;
return 'UNKNOWN';
}
function isScannerFingerprintId(id = '') {
const value = upper(id, '');
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
const value = upper(id, '');
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
function parseLongTaxonomyMicroId(id = '') {
const value = upper(id, '');
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
function identityFromCandidate(row = {}) {
const rawId = String(
row.childTrueMicroFamilyId ||
row.trueMicroFamilyId ||
row.microFamilyId ||
row.analyzeMicroFamilyId ||
row.learningMicroFamilyId ||
''
).trim().toUpperCase();
if (!rawId || !validLearningId(rawId)) {
return {
trueMicroFamilyId: null,

childTrueMicroFamilyId: null,
parentTrueMicroFamilyId: null,
setupType: null,
regimeBucket: null,
confirmationProfile: null,
exact75Child: false,
parent15: false
};
}
const parsed = parseLongTaxonomyMicroId(rawId);
if (!parsed.valid) {
return {
trueMicroFamilyId: rawId,
childTrueMicroFamilyId: null,
parentTrueMicroFamilyId: null,
setupType: null,
regimeBucket: null,
confirmationProfile: null,
exact75Child: false,
parent15: false
};
}
return {
trueMicroFamilyId: parsed.childTrueMicroFamilyId || parsed.trueMicroFamilyId,
childTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
setupType: parsed.setup,
regimeBucket: parsed.regime,
confirmationProfile: parsed.confirmationProfile,
exact75Child: parsed.selectable,
parent15: parsed.isParent
};
}
function inferTradeSideFromIds(row = {}) {
const haystack = [
row.familyId,
row.family,
row.baseFamilyId,
row.childTrueMicroFamilyId,
row.trueMicroFamilyId,
row.microFamilyId,
row.analyzeMicroFamilyId,
row.learningMicroFamilyId,
row.liveMicroFamilyId,
row.realMicroFamilyId,
row.executionMicroFamilyId,
row.parentTrueMicroFamilyId,

row.coarseMicroFamilyId,
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
function inferTradeSideFromDefinition(row = {}) {
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
function inferTradeSideFromReason(row = {}) {
const reason = cleanSideText(
row.scannerReason ||
row.reason ||
row.signalReason ||
row.actionReason ||
''
);
if (!reason) return 'UNKNOWN';
if (hasLongSignal(reason) && !hasShortSignal(reason)) return TARGET_TRADE_SIDE;
if (hasShortSignal(reason) && !hasLongSignal(reason)) return
OPPOSITE_TRADE_SIDE;
if (hasLongSignal(reason)) return TARGET_TRADE_SIDE;
if (hasShortSignal(reason)) return OPPOSITE_TRADE_SIDE;
return 'UNKNOWN';
}
function inferTradeSide(row = {}) {
if (typeof row !== 'object' || row === null) {
return normalizeTradeSideValue(row);
}
const candidates = [
row.tradeSide,
row.positionSide,
row.direction,
row.signalSide,
row.scannerSide,
row.actualScannerSide,
row.analysisSide,
row.expectedSide,
row.predictedSide,
row.intentSide,
row.biasSide,
row.side
];
for (const value of candidates) {

const side = normalizeTradeSideValue(value);
if (side !== 'UNKNOWN') return side;
}
const fromIds = inferTradeSideFromIds(row);
if (fromIds !== 'UNKNOWN') return fromIds;
const fromDefinition = inferTradeSideFromDefinition(row);
if (fromDefinition !== 'UNKNOWN') return fromDefinition;
const fromReason = inferTradeSideFromReason(row);
if (fromReason !== 'UNKNOWN') return fromReason;
if (row.longOnly === true || row.shortDisabled === true) {
return TARGET_TRADE_SIDE;
}
if (row.shortOnly === true || row.longDisabled === true) {
return OPPOSITE_TRADE_SIDE;
}
return 'UNKNOWN';
}
function hasExplicitShortSide(row = {}) {
if (typeof row !== 'object' || row === null) {
return normalizeTradeSideValue(row) === OPPOSITE_TRADE_SIDE;
}
const directCandidates = [
row.tradeSide,
row.positionSide,
row.direction,
row.signalSide,
row.scannerSide,
row.actualScannerSide,
row.analysisSide,
row.expectedSide,
row.predictedSide,
row.intentSide,
row.biasSide,
row.side
];
for (const value of directCandidates) {
if (normalizeTradeSideValue(value) === OPPOSITE_TRADE_SIDE) return true;
}
return (
inferTradeSideFromIds(row) === OPPOSITE_TRADE_SIDE ||
inferTradeSideFromDefinition(row) === OPPOSITE_TRADE_SIDE ||
inferTradeSideFromReason(row) === OPPOSITE_TRADE_SIDE
);
}
function sideLabel(sideOrRow) {
return typeof sideOrRow === 'object' && sideOrRow !== null
? inferTradeSide(sideOrRow)

: normalizeTradeSideValue(sideOrRow);
}
function isLong(side) {
return sideLabel(side) === TARGET_TRADE_SIDE;
}
function modeFlags(row = {}) {
const identity = identityFromCandidate(row);
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
longDisabled: false,
virtualLearning: true,
virtualOnly: true,
virtualTracked: true,
shadowOnly: true,
outcomeSource: 'VIRTUAL',
realTrade: false,
realOrder: false,
exchangeOrder: false,
bitgetOrderPlaced: false,
noRealOrders: true,
noExchangeOrders: true,
realOrdersDisabled: true,
bitgetOrdersDisabled: true,
exchangeOrdersDisabled: true,
exchangeCallsDisabled: true,
scannerFingerprintRole: 'METADATA_ONLY',
scannerFingerprintsMetadataOnly: true,
scannerFingerprintsUsedAsLearningFamily: false,
executionFingerprintRole: 'METADATA_ONLY',
executionFingerprintsMetadataOnly: true,
executionFingerprintsUsedAsLearningFamily: false,
scannerBucketsMetadataOnly: true,
legacy25BucketsMetadataOnly: true,

scannerBucketsUsedAsLearningFamily: false,
analyzeMicroFamiliesOnly: true,
analyzeAssignsTrueMicroFamily: true,
learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
symbolExcludedFromFamilyId: true,
coinNameExcludedFromFamilyId: true,
hashesExcludedFromFamilyId: true,
trueMicroOnly: true,
exactTrueMicroOnly: true,
exactTrueMicroFamilyRequired: true,
fixedTaxonomyPreferred: true,
trueMicroFamilyId: identity.exact75Child ? identity.childTrueMicroFamilyId :
identity.trueMicroFamilyId,
microFamilyId: identity.exact75Child ? identity.childTrueMicroFamilyId :
identity.trueMicroFamilyId,
childTrueMicroFamilyId: identity.childTrueMicroFamilyId,
parentTrueMicroFamilyId: identity.parentTrueMicroFamilyId,
coarseMicroFamilyId: identity.parentTrueMicroFamilyId,
setupType: identity.setupType,
regimeBucket: identity.regimeBucket,
confirmationProfile: identity.confirmationProfile,
exact75ChildTrueMicro: identity.exact75Child,
parent15TrueMicroMetadataOnly: identity.parent15,
exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
learningGranularity: LEARNING_GRANULARITY,
parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
parentLearningEnabled: true,
childLearningEnabled: true,
selectionGranularity: 'EXACT_75_CHILD',
fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED',
manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
discordOnlyForExactTrueMicroMatch: true,
completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
scoringRSource: 'netR',
winsLossesFlatsSource: 'netR',
winrateDefinition: 'netR > 0',
avgRSource: 'netR',
totalRSource: 'netR',
avgCostRShown: true,
minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,
minCompletedForFamilyGate: MIN_COMPLETED_FAMILY_GATE,
observingStatusRule: 'completed == 0',
earlyOutcomesStatusRule: 'completed > 0 && completed < 20',
activeLearningStatusRule: 'completed >= 20 && completed < 35',

passedStatusRule: 'completed >= 35 && avgR > 0',
empiricalVetoStatusRule: 'completed >= 35 && avgR <= 0',
statusRules: {
OBSERVING: 'completed == 0',
EARLY_OUTCOMES: 'completed > 0 && completed < 20',
ACTIVE_LEARNING: 'completed >= 20 && completed < 35',
PASSED: 'completed >= 35 && avgR > 0',
EMPIRICAL_VETO: 'completed >= 35 && avgR <= 0'
},
defaultRanking: 'dashboardBalancedScore/balancedScore/fairWinrate',
noBareWinrateRanking: true,
currentFitSoftOnly: true,
currentFitBlocksLearning: false,
currentFitBlocksVirtualLearning: false,
currentFitBlocksShadowLearning: false,
currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
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
redisNamespace: LONG_NAMESPACE,
redisKeyPrefix: LONG_KEY_PREFIX,
persistentLearningKey: PERSISTENT_LEARNING_KEY,
measurementFixVersion: MEASUREMENT_FIX_VERSION,
acceptedOutcomeMeasurementVersion: MEASUREMENT_FIX_VERSION,
exitFillModelVersion: EXIT_FILL_MODEL_VERSION,
outcomeMeasurementGateMode: OUTCOME_MEASUREMENT_GATE_MODE,
empiricalVetoPolicyVersion: EMPIRICAL_VETO_POLICY_VERSION,
empiricalVetoCanRecover: true,
temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
weekendPolicyVersion: WEEKEND_POLICY_VERSION,
sessionPolicyVersion: SESSION_POLICY_VERSION,
weekendMode: WEEKEND_MODE,
sessionMode: SESSION_MODE,
weekendLearningAllowed: true,
weekendVirtualEntryAllowed: true,
weekendExitMonitoringAllowed: true,
weekendOutcomeRecordingAllowed: true,
sessionLearningAllowed: true,
sessionVirtualEntryAllowed: true,

sessionDiscordEntryAllowed: true,
sessionPolicyObservedOnly: true,
temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
temporalGenerationSchemaVersion: TEMPORAL_GENERATION_SCHEMA_VERSION,
temporalPolicyOwner: 'TRADE_SYSTEM_AND_ROTATION_ENGINE',
temporalPolicyAppliedHere: false,
temporalStatsAggregatedHere: false,
temporalFamilyIdentityIncludesBucket: false,
redisKeysSeparatedFromShortRoot: true,
shortRootTouched: false
};
}
function dashboardSideFromTradeSide(side) {
return isLong(side) ? TARGET_DASHBOARD_SIDE : 'unknown';
}
function withTradeSide(candidate = {}, side = TARGET_TRADE_SIDE) {
const requestedTradeSide = normalizeTradeSideValue(side);
if (requestedTradeSide !== TARGET_TRADE_SIDE) return null;
if (hasExplicitShortSide(candidate)) return null;
const inferredSide = inferTradeSide(candidate);
if (inferredSide === OPPOSITE_TRADE_SIDE) return null;
return {
...candidate,
originalSide: candidate.side ?? candidate.tradeSide ?? null,
...modeFlags(candidate)
};
}
function btcRelation(side, btcState) {
const tradeSide = sideLabel(side);
const btc = upper(btcState, 'NEUTRAL');
if (btc === 'NEUTRAL' || btc === 'UNKNOWN') return 'BTC_NEUTRAL';
if (tradeSide === TARGET_TRADE_SIDE && ['BULLISH', 'STRONG_BULL', 'BULL',
'UP'].includes(btc)) {
return 'BTC_WITH';
}
if (tradeSide === TARGET_TRADE_SIDE) return 'BTC_AGAINST';
return 'BTC_UNKNOWN';
}
function directionalReward({
entry,
tp,
side
} = {}) {
if (!isLong(side)) return 0;
return tp - entry;
}
function directionalChange({
side,
change
} = {}) {
const value = safeNumber(change, 0);
if (!isLong(side)) return 0;
return value;

}
function rsiBucket(value) {
const rsi = safeNumber(value, 50);
if (rsi < 25) return 'RSI_LT_25';
if (rsi < 30) return 'RSI_25_30';
if (rsi < 35) return 'RSI_30_35';
if (rsi < 40) return 'RSI_35_40';
if (rsi < 45) return 'RSI_40_45';
if (rsi < 50) return 'RSI_45_50';
if (rsi < 55) return 'RSI_50_55';
if (rsi < 60) return 'RSI_55_60';
if (rsi < 65) return 'RSI_60_65';
if (rsi < 70) return 'RSI_65_70';
if (rsi < 75) return 'RSI_70_75';
return 'RSI_GT_75';
}
function rsiSlopeBucket(value) {
const slope = safeNumber(value, 0);
if (slope <= -5) return 'SLOPE_STRONG_DOWN';
if (slope <= -2) return 'SLOPE_DOWN';
if (slope < -0.5) return 'SLOPE_SOFT_DOWN';
if (slope <= 0.5) return 'SLOPE_FLAT';
if (slope < 2) return 'SLOPE_SOFT_UP';
if (slope < 5) return 'SLOPE_UP';
return 'SLOPE_STRONG_UP';
}
function rsiAlignment({
side,
rsi,
rsiHTF,
rsiSlope
} = {}) {
if (!isLong(side)) return 'RSI_UNKNOWN';
const slope = safeNumber(rsiSlope, 0);
const local = safeNumber(rsi, 50);
const htf = safeNumber(rsiHTF, 50);
if (slope > 0.5 && htf >= 45 && local <= 72) return 'RSI_WITH';
if (slope < -0.5 || htf < 38 || local > 78) return 'RSI_AGAINST';
return 'RSI_NEUTRAL';
}
function momentumBucket({
side,
change1h,
change24h
} = {}) {
const d1h = directionalChange({ side, change: change1h });
const d24h = directionalChange({ side, change: change24h });

if (d1h >= 3 || d24h >= 10) return 'MOM_STRONG_WITH';
if (d1h >= 1 || d24h >= 4) return 'MOM_WITH';
if (d1h <= -3 || d24h <= -10) return 'MOM_STRONG_AGAINST';
if (d1h <= -1 || d24h <= -4) return 'MOM_AGAINST';
return 'MOM_NEUTRAL';
}
function volatilityBucket(atrPct) {
const atr = safeNumber(atrPct, 0);
if (atr <= 0) return 'ATR_UNKNOWN';
if (atr < 0.003) return 'ATR_LT_30BPS';
if (atr < 0.006) return 'ATR_30_60BPS';
if (atr < 0.010) return 'ATR_60_100BPS';
if (atr < 0.015) return 'ATR_100_150BPS';
if (atr < 0.025) return 'ATR_150_250BPS';
return 'ATR_GT_250BPS';
}
function riskPctBucket(riskPct) {
const risk = safeNumber(riskPct, 0);
if (risk <= 0) return 'RISK_UNKNOWN';
if (risk < 0.005) return 'RISK_LT_50BPS';
if (risk < 0.008) return 'RISK_50_80BPS';
if (risk < 0.012) return 'RISK_80_120BPS';
if (risk < 0.018) return 'RISK_120_180BPS';
if (risk < 0.025) return 'RISK_180_250BPS';
return 'RISK_GT_250BPS';
}
function spreadBps(spreadPct) {
return round4(safeNumber(spreadPct, 0) * 10000);
}
function spreadBucket(spreadPct) {
const bps = spreadBps(spreadPct);
if (bps <= 0) return 'SPREAD_UNKNOWN';
if (bps < 4) return 'SPREAD_LT_4BPS';
if (bps < 8) return 'SPREAD_4_8BPS';
if (bps < 12) return 'SPREAD_8_12BPS';
if (bps < 20) return 'SPREAD_12_20BPS';
return 'SPREAD_GT_20BPS';
}
function depthBucket(depthUsd) {
const depth = safeNumber(depthUsd, 0);
if (depth >= 1_000_000) return 'DEPTH_GT_1M';
if (depth >= 500_000) return 'DEPTH_500K_1M';
if (depth >= 250_000) return 'DEPTH_250K_500K';
if (depth >= 100_000) return 'DEPTH_100K_250K';
if (depth >= 50_000) return 'DEPTH_50K_100K';
if (depth > 0) return 'DEPTH_LT_50K';
return 'DEPTH_UNKNOWN';

}
function fundingBucket(rate) {
const funding = safeNumber(rate, 0);
if (funding >= 0.0005) return 'FUNDING_POS_EXTREME';
if (funding >= 0.0002) return 'FUNDING_POS_HIGH';
if (funding > 0.00005) return 'FUNDING_POS';
if (funding <= -0.0005) return 'FUNDING_NEG_EXTREME';
if (funding <= -0.0002) return 'FUNDING_NEG_HIGH';
if (funding < -0.00005) return 'FUNDING_NEG';
return 'FUNDING_NEUTRAL';
}
function fundingAlignment({
side,
fundingRate
} = {}) {
const rate = safeNumber(fundingRate, 0);
if (Math.abs(rate) < 0.00005) return 'FUNDING_NEUTRAL';
if (!isLong(side)) return 'FUNDING_UNKNOWN';
return rate < 0 ? 'FUNDING_WITH' : 'FUNDING_AGAINST';
}
function obDepthValue(ob = {}) {
return safeNumber(
ob.depthMinUsd1p ??
ob.minDepthUsd1p ??
ob.depthUsd1p ??
ob.depthUsd ??
0,
0
);
}
function obImbalance(ob = {}) {
const bidDepth = safeNumber(
ob.bidDepthUsd1p ??
ob.bidUsd1p ??
ob.bidsUsd1p ??
ob.bidDepthUsd ??
0,
0
);
const askDepth = safeNumber(
ob.askDepthUsd1p ??
ob.askUsd1p ??
ob.asksUsd1p ??
ob.askDepthUsd ??
0,
0
);

const total = bidDepth + askDepth;
if (total <= 0) return 0;
return clamp((bidDepth - askDepth) / total, -1, 1);
}
function obImbalanceBucket(value) {
const imbalance = safeNumber(value, 0);
if (imbalance >= 0.35) return 'OB_BID_STRONG';
if (imbalance >= 0.12) return 'OB_BID';
if (imbalance <= -0.35) return 'OB_ASK_STRONG';
if (imbalance <= -0.12) return 'OB_ASK';
return 'OB_BALANCED';
}
function scannerReason(candidate = {}) {
const reason = upper(
candidate.scannerReason ||
candidate.reason ||
candidate.signalReason ||
'UNKNOWN'
);
if (reason.includes('RETEST')) return 'RETEST';
if (reason.includes('PULLBACK')) return 'PULLBACK';
if (reason.includes('BREAKOUT')) return 'BREAKOUT';
if (reason.includes('VOLUME')) return 'VOLUME';
if (reason.includes('MOMENTUM')) return 'MOMENTUM';
if (reason.includes('SWEEP')) return 'SWEEP';
return reason;
}
function inferEntryFlags(candidate = {}) {
const reason = scannerReason(candidate);
const pullbackConfirmed =
bool(candidate.pullbackConfirmed) ||
reason.includes('PULLBACK');
const retestConfirmed =
bool(candidate.retestConfirmed) ||
reason.includes('RETEST');
const sweepConfirmed =
bool(candidate.sweepConfirmed) ||
reason.includes('SWEEP');
const fakeBreakout =
bool(candidate.fakeBreakout) ||
bool(candidate.fakeBreakoutRisk);
let entryQuality = 'RAW';
if (retestConfirmed) entryQuality = 'RETEST';
else if (pullbackConfirmed) entryQuality = 'PULLBACK';
else if (sweepConfirmed) entryQuality = 'SWEEP';
else if (reason.includes('BREAKOUT')) entryQuality = 'BREAKOUT';
else if (reason.includes('MOMENTUM')) entryQuality = 'MOMENTUM';

return {
pullbackConfirmed,
retestConfirmed,
sweepConfirmed,
fakeBreakout,
fakeBreakoutRisk: fakeBreakout,
entryQuality
};
}
function directionalMoveScore({
side,
rsiZone,
rsiSlope,
rsiHTF,
rsiAlign
} = {}) {
if (!isLong(side)) return -20;
const zone = upper(rsiZone, 'MID');
const slope = safeNumber(rsiSlope, 0);
const htf = safeNumber(rsiHTF, 50);
let score = 0;
if (zone.startsWith('LOWER')) score += 10;
if (zone === 'MID') score += 5;
if (slope > 0) score += 5;
if (htf >= 45 && htf <= 68) score += 5;
if (htf > 74) score -= 6;
if (rsiAlign === 'RSI_WITH') score += 4;
if (rsiAlign === 'RSI_AGAINST') score -= 6;
return score;
}
function spreadQualityScore(spreadPct) {
const cfg = tradeConfig();
const spread = safeNumber(spreadPct, 0);
if (spread <= 0) return -4;
if (spread <= 0.0004) return 8;
if (spread <= 0.0008) return 5;
if (spread <= 0.0015) return 1;
if (spread <= cfg.maxSpreadPct) return -4;
return -12;
}
function depthQualityScore(depthUsd) {
const depth = safeNumber(depthUsd, 0);
if (depth >= 1_000_000) return 10;
if (depth >= 500_000) return 8;
if (depth >= 250_000) return 6;
if (depth >= 100_000) return 4;
if (depth >= 50_000) return 1;

if (depth > 0) return -4;
return -8;
}
function rrScore(rr) {
const cfg = tradeConfig();
const r = safeNumber(rr, 0);
if (r >= 2.5) return 14;
if (r >= 2.0) return 12;
if (r >= 1.5) return 10;
if (r >= 1.0) return 6;
if (r >= cfg.minRR) return 2;
return -12;
}
function flowScore(flow) {
const f = upper(flow, 'NEUTRAL');
if (f === 'TREND') return 18;
if (f === 'IMPULSE') return 15;
if (f === 'BUILDING') return 10;
return 2;
}
function obRelationScore(obRelation) {
const relation = upper(obRelation, 'UNKNOWN');
if (relation === 'WITH') return 15;
if (relation === 'NEUTRAL') return 4;
if (relation === 'AGAINST') return -12;
return -4;
}
function sniperObScore(obRelation) {
const relation = upper(obRelation, 'UNKNOWN');
if (relation === 'WITH') return 18;
if (relation === 'NEUTRAL') return 6;
if (relation === 'AGAINST') return -15;
return -5;
}
function btcScore(relationToBtc) {
const relation = upper(relationToBtc, 'BTC_UNKNOWN');
if (relation === 'BTC_WITH') return 8;
if (relation === 'BTC_NEUTRAL') return 2;
if (relation === 'BTC_AGAINST') return -8;
return -3;
}
function entryQualityScore(flags = {}) {
if (flags.retestConfirmed) return 8;
if (flags.pullbackConfirmed) return 7;
if (flags.sweepConfirmed) return 5;
if (flags.entryQuality === 'MOMENTUM') return 3;
return 0;

}
function fundingScore(alignment) {
const value = upper(alignment, 'FUNDING_UNKNOWN');
if (value === 'FUNDING_WITH') return 3;
if (value === 'FUNDING_NEUTRAL') return 1;
if (value === 'FUNDING_AGAINST') return -3;
return 0;
}
function buildMicroSignalParts({
tradeSide,
rsiZone,
rsiLocalBucket,
rsiHtfBucket,
rsiSlopeGroup,
rsiAlign,
flow,
momentum,
obRelation,
obImbalanceGroup,
btcRel,
regime,
atrGroup,
spreadGroup,
depthGroup,
fundingGroup,
fundingAlign,
riskGroup,
entryQuality,
fakeBreakout
} = {}) {
return [
`schema=${TRUE_MICRO_SCHEMA}`,
`parentSchema=${PARENT_TRUE_MICRO_SCHEMA}`,
`childSchema=${CHILD_TRUE_MICRO_SCHEMA}`,
`granularity=${LEARNING_GRANULARITY}`,
`parentGranularity=${PARENT_LEARNING_GRANULARITY}`,
`tradeSide=${tradeSide}`,
`side=${TARGET_DASHBOARD_SIDE}`,
`positionSide=${TARGET_TRADE_SIDE}`,
`direction=${TARGET_TRADE_SIDE}`,
`longOnly=true`,
`shortDisabled=true`,
`rsiZone=${rsiZone}`,
`rsiBucket=${rsiLocalBucket}`,
`rsiHTFBucket=${rsiHtfBucket}`,
`rsiSlopeBucket=${rsiSlopeGroup}`,
`rsiAlignment=${rsiAlign}`,

`flow=${flow}`,
`momentum=${momentum}`,
`obRelation=${obRelation}`,
`obImbalance=${obImbalanceGroup}`,
`btcRelation=${btcRel}`,
`regime=${upper(regime, 'UNKNOWN')}`,
`atrBucket=${atrGroup}`,
`spreadBucket=${spreadGroup}`,
`depthBucket=${depthGroup}`,
`fundingBucket=${fundingGroup}`,
`fundingAlignment=${fundingAlign}`,
`riskBucket=${riskGroup}`,
`entryQuality=${entryQuality}`,
`fakeBreakout=${Boolean(fakeBreakout)}`,
'scannerFingerprintRole=METADATA_ONLY',
'executionFingerprintRole=METADATA_ONLY',
'learningIdentitySource=ANALYZE_TRUE_MICRO_FAMILY',
'symbolExcludedFromFamilyId=true',
'coinNameExcludedFromFamilyId=true',
'hashesExcludedFromFamilyId=true',
'currentFitPolarity=BULLISH_POSITIVE_BEARISH_NEGATIVE',
'currentFitDefinition=LONG_MIRRORED_CURRENT_FIT',
'riskGeometry=LONG:tp<entry<sl'
];
}
export function calculateRR({
entry,
sl,
tp,
side = TARGET_TRADE_SIDE
} = {}) {
const e = safeNumber(entry, 0);
const s = safeNumber(sl, 0);
const t = safeNumber(tp, 0);
if (e <= 0 || s <= 0 || t <= 0) return 0;
if (!(s < e && e < t)) return 0;
const risk = e - s;
if (risk <= 0) return 0;
const reward = directionalReward({
entry: e,
tp: t,
side
});
return reward > 0
? reward / risk
: 0;
}

export function isValidRiskGeometry(risk, side = TARGET_TRADE_SIDE) {
if (!risk) return false;
const cfg = tradeConfig();
const tradeSide = sideLabel(side || risk.side || risk.tradeSide);
if (tradeSide !== TARGET_TRADE_SIDE) return false;
const entry = safeNumber(risk.entry, 0);
const sl = safeNumber(risk.sl, 0);
const tp = safeNumber(risk.tp, 0);
if (entry <= 0 || sl <= 0 || tp <= 0) return false;
if (!(sl < entry && entry < tp)) return false;
const rr = calculateRR({
entry,
sl,
tp,
side: TARGET_TRADE_SIDE
});
if (rr < cfg.minRR) return false;
const riskPct = safeNumber(risk.riskPct, 0);
if (riskPct <= 0) return false;
if (riskPct > cfg.maxRiskPct * 1.05) return false;
return true;
}
export function buildRiskGeometry({
candidate,
ob,
candles15m,
sideOverride = TARGET_TRADE_SIDE
} = {}) {
const cfg = tradeConfig();
if (hasExplicitShortSide(candidate)) return null;
const overrideSide = normalizeTradeSideValue(sideOverride);
const inferredSide = inferTradeSide(candidate);
if (inferredSide === OPPOSITE_TRADE_SIDE) return null;
const tradeSide = overrideSide !== 'UNKNOWN'
? overrideSide
: inferredSide;
if (tradeSide !== TARGET_TRADE_SIDE) return null;
const entry = safeNumber(ob?.mid || candidate?.price, 0);
if (entry <= 0) return null;
const atrPct = safeNumber(calculateAtrPct(candles15m, 14), 0);
const spreadPct = safeNumber(ob?.spreadPct, fallbackSpreadPct());
const rawRiskPct = Math.max(
cfg.fallbackRiskPct,
atrPct * cfg.atrRiskMult,
spreadPct * cfg.spreadRiskMult
);
const riskPct = clamp(

rawRiskPct,
cfg.minRiskPct,
cfg.maxRiskPct
);
const effectiveRR = Math.max(
cfg.minRR,
cfg.defaultRR
);
const rewardPct = riskPct * effectiveRR;
const sl = entry * (1 - riskPct);
const tp = entry * (1 + rewardPct);
const roundedEntry = roundPrice(entry);
const roundedSl = roundPrice(sl);
const roundedTp = roundPrice(tp);
const rr = calculateRR({
entry: roundedEntry,
sl: roundedSl,
tp: roundedTp,
side: TARGET_TRADE_SIDE
});
const rowForFlags = {
...(candidate || {}),
entry: roundedEntry,
sl: roundedSl,
tp: roundedTp
};
const risk = {
...modeFlags(rowForFlags),
entry: roundedEntry,
sl: roundedSl,
tp: roundedTp,
rr: round4(rr),
slSource: 'LONG_ATR_SPREAD_FALLBACK',
tpSource: 'LONG_DEFAULT_RR_TARGET',
riskRewardSource: 'LONG_ATR_SPREAD_DEFAULT_RR',
atrPct: round6(atrPct),
spreadPct: round6(spreadPct),
riskPct: round6(riskPct),
rewardPct: round6(rewardPct),
atrBucket: volatilityBucket(atrPct),
riskBucket: riskPctBucket(riskPct),
spreadBucket: spreadBucket(spreadPct),
positionTimeStopMin: cfg.positionTimeStopMin,
validLongRiskShape: roundedSl < roundedEntry && roundedEntry < roundedTp,
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
riskEngineAssignedTrueMicroFamily: false,
analyzeAssignsTrueMicroFamily: true,
scannerBucketsMetadataOnly: true,
legacy25BucketsMetadataOnly: true
};
return isValidRiskGeometry(risk, TARGET_TRADE_SIDE)
? risk
: null;
}
export function buildRiskGeometryForSide({
candidate,
ob,
candles15m,
side
} = {}) {
const tradeSide = normalizeTradeSideValue(side);
if (tradeSide !== TARGET_TRADE_SIDE) return null;
return buildRiskGeometry({
candidate,
ob,
candles15m,
sideOverride: TARGET_TRADE_SIDE
});
}
export function buildLiveMetrics({
candidate,
ob,
funding,
candles15m,
candles1h,
btcState,
regime,
risk,
sideOverride = TARGET_TRADE_SIDE
} = {}) {
if (!candidate || !risk) return null;
if (hasExplicitShortSide(candidate)) return null;
const overrideSide = normalizeTradeSideValue(sideOverride);
const inferredSide = inferTradeSide(candidate);

if (inferredSide === OPPOSITE_TRADE_SIDE) return null;
const tradeSide = overrideSide !== 'UNKNOWN'
? overrideSide
: inferredSide;
if (tradeSide !== TARGET_TRADE_SIDE) return null;
if (!isValidRiskGeometry(risk, TARGET_TRADE_SIDE)) return null;
const sideCandidate = withTradeSide(candidate, TARGET_TRADE_SIDE);
if (!sideCandidate) return null;
const rsi = safeNumber(calculateRsi(candles15m, 14) ?? 50, 50);
const rsiHTF = safeNumber(calculateRsi(candles1h, 14) ?? rsi, rsi);
const rsiZone = getRsiZone(rsi);
const rsiSlope = safeNumber(getRsiSlope(candles15m), 0);
const flow = classifyFlow({
side: TARGET_TRADE_SIDE,
change1h: sideCandidate.change1h,
change24h: sideCandidate.change24h,
candles15m
});
if (flow === 'SHORT_DISABLED_LONG_ONLY') return null;
const obBias = ob?.bias || 'NEUTRAL';
const obRelation = getObRelation(TARGET_TRADE_SIDE, obBias);
const relationToBtc = btcRelation(TARGET_TRADE_SIDE, btcState);
const depthMinUsd1p = obDepthValue(ob);
const spreadPct = safeNumber(ob?.spreadPct, risk.spreadPct ?? 0);
const fundingRate = safeNumber(funding?.rate, 0);
const imbalance = obImbalance(ob);
const flags = inferEntryFlags(sideCandidate);
const rsiLocalBucket = rsiBucket(rsi);
const rsiHtfBucket = rsiBucket(rsiHTF);
const rsiSlopeGroup = rsiSlopeBucket(rsiSlope);
const rsiAlign = rsiAlignment({
side: TARGET_TRADE_SIDE,
rsi,
rsiHTF,
rsiSlope
});
const momentum = momentumBucket({
side: TARGET_TRADE_SIDE,
change1h: sideCandidate.change1h,
change24h: sideCandidate.change24h
});
const atrGroup = volatilityBucket(risk?.atrPct);
const spreadGroup = spreadBucket(spreadPct);
const depthGroup = depthBucket(depthMinUsd1p);
const fundingGroup = fundingBucket(fundingRate);
const fundingAlign = fundingAlignment({
side: TARGET_TRADE_SIDE,

fundingRate
});
const riskGroup = riskPctBucket(risk?.riskPct);
const obImbalanceGroup = obImbalanceBucket(imbalance);
const baseScore = scoreInput(sideCandidate);
let confluence = 0;
confluence += clamp(baseScore, 0, 100) * 0.30;
confluence += flowScore(flow);
confluence += obRelationScore(obRelation);
confluence += btcScore(relationToBtc);
confluence += rrScore(risk?.rr);
confluence += spreadQualityScore(spreadPct);
confluence += depthQualityScore(depthMinUsd1p);
confluence += entryQualityScore(flags);
confluence += fundingScore(fundingAlign);
confluence += flags.fakeBreakoutRisk ? -10 : 0;
confluence += Math.abs(rsiSlope) > 2 ? 3 : 0;
confluence += rsiAlign === 'RSI_WITH' ? 4 : 0;
confluence += rsiAlign === 'RSI_AGAINST' ? -6 : 0;
confluence = Math.round(clamp(confluence, 0, 100));
let sniperScore = 0;
sniperScore += clamp(baseScore, 0, 100) * 0.32;
sniperScore += sniperObScore(obRelation);
sniperScore += btcScore(relationToBtc);
sniperScore += flowScore(flow);
sniperScore += rrScore(risk?.rr);
sniperScore += directionalMoveScore({
side: TARGET_TRADE_SIDE,
rsiZone,
rsiSlope,
rsiHTF,
rsiAlign
});
sniperScore += spreadQualityScore(spreadPct);
sniperScore += depthQualityScore(depthMinUsd1p) * 0.35;
sniperScore += entryQualityScore(flags);
sniperScore += fundingScore(fundingAlign);
sniperScore += flags.fakeBreakoutRisk ? -10 : 0;
sniperScore = Math.round(clamp(sniperScore, 0, 100));
const microSignalParts = buildMicroSignalParts({
tradeSide: TARGET_TRADE_SIDE,
rsiZone,
rsiLocalBucket,
rsiHtfBucket,
rsiSlopeGroup,
rsiAlign,
flow,

momentum,
obRelation,
obImbalanceGroup,
btcRel: relationToBtc,
regime,
atrGroup,
spreadGroup,
depthGroup,
fundingGroup,
fundingAlign,
riskGroup,
entryQuality: flags.entryQuality,
fakeBreakout: flags.fakeBreakout
});
const base = {
...sideCandidate,
...modeFlags(sideCandidate),
confluence,
sniperScore,
rr: safeNumber(risk?.rr, 0),
rsi: round2(rsi),
rsiHTF: round2(rsiHTF),
rsiZone,
rsiBucket: rsiLocalBucket,
rsiHTFBucket: rsiHtfBucket,
rsiSlope: round4(rsiSlope),
rsiSlopeBucket: rsiSlopeGroup,
rsiAlignment: rsiAlign,
rsiContinuationScore: round4(Math.abs(rsiSlope)),
flow,
momentumBucket: momentum,
obBias,
obRelation,
obImbalance: round4(imbalance),
obImbalanceBucket: obImbalanceGroup,
spreadPct,
spreadBps: spreadBps(spreadPct),
spreadBucket: spreadGroup,
depthMinUsd1p,
depthBucket: depthGroup,
fundingRate,
fundingBucket: fundingGroup,
fundingAlignment: fundingAlign,
btcState,
btcRelation: relationToBtc,
regime,
scannerReason: scannerReason(sideCandidate),

pullbackConfirmed: flags.pullbackConfirmed,
retestConfirmed: flags.retestConfirmed,
sweepConfirmed: flags.sweepConfirmed,
fakeBreakout: flags.fakeBreakout,
fakeBreakoutRisk: flags.fakeBreakoutRisk,
entryQuality: flags.entryQuality,
entry: risk.entry,
sl: risk.sl,
tp: risk.tp,
atrPct: risk.atrPct,
atrBucket: atrGroup,
riskPct: risk.riskPct,
riskBucket: riskGroup,
rewardPct: risk.rewardPct,
slSource: risk.slSource,
tpSource: risk.tpSource,
riskRewardSource: risk.riskRewardSource,
microSignalParts,
executionFingerprintParts: microSignalParts,
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
currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
riskEngineAssignedTrueMicroFamily: false,
analyzeAssignsTrueMicroFamily: true,
positionTimeStopMin: tradeConfig().positionTimeStopMin,
ts: now()
};
return {
...base,
...modeFlags(base)
};
}
export function buildLiveMetricsForSide(params = {}, side) {
const tradeSide = normalizeTradeSideValue(side);
if (tradeSide !== TARGET_TRADE_SIDE) return null;
return buildLiveMetrics({

...params,
sideOverride: TARGET_TRADE_SIDE
});
}
export function buildRiskAndLiveMetricsForBothSides({
candidate,
ob,
funding,
candles15m,
candles1h,
btcState,
regime
} = {}) {
if (!candidate) return [];
if (hasExplicitShortSide(candidate)) return [];
const inferredSide = inferTradeSide(candidate);
if (inferredSide === OPPOSITE_TRADE_SIDE) return [];
const sideCandidate = withTradeSide(candidate, TARGET_TRADE_SIDE);
if (!sideCandidate) return [];
const risk = buildRiskGeometry({
candidate: sideCandidate,
ob,
candles15m,
sideOverride: TARGET_TRADE_SIDE
});
if (!isValidRiskGeometry(risk, TARGET_TRADE_SIDE)) {
return [];
}
const metrics = buildLiveMetrics({
candidate: sideCandidate,
ob,
funding,
candles15m,
candles1h,
btcState,
regime,
risk,
sideOverride: TARGET_TRADE_SIDE
});
if (!metrics) return [];
const outputSide = inferTradeSide(metrics);
if (outputSide !== TARGET_TRADE_SIDE) return [];
const out = {
...metrics,
...modeFlags(metrics),
validLongRiskShape: true,
longRiskRule: 'sl < entry < tp',

riskValidForAnalyzeTrueMicroAssignment: true
};
return [out];
}
export {
dashboardSideFromTradeSide
};

