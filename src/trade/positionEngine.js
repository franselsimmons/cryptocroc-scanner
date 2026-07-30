// ================= FILE: src/trade/positionEngine.js =================
import { KEYS } from '../keys.js';
import { CONFIG } from '../config.js';
import {
getDurableRedis,
getJson,
setJson,
getKeys
} from '../redis.js';
import {
safeNumber,
randomId,
sideToTradeSide,
normalizeBaseSymbol,
mapConcurrent
} from '../utils.js';
import {
buildOutcomeFromPosition,
recordOutcome
} from '../analyze/analyzeEngine.js';
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
import { sendExitAlert } from '../discord/discord.js';
import { applyCosts } from './costModel.js';
const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const TARGET_SCANNER_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';
const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';
const ENTRY_DECISION_SNAPSHOT_VERSION =
'LONG_TEMPORAL_ENTRY_DECISION_SNAPSHOT_V1';
const EXIT_PUBLICATION_RESULT_VERSION = 'LONG_EXIT_PUBLICATION_RESULT_V1';
const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = TRUE_MICRO_SCHEMA;
const LEARNING_GRANULARITY =
'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const POSITION_SOURCE = 'VIRTUAL';
const OUTCOME_SOURCE = 'VIRTUAL';
const COST_MODEL_VERSION = 'POSITION_ENGINE_LONG_NET_COST_V8';
const EXIT_FILL_MODEL_VERSION = 'LONG_TRIGGER_BOUNDARY_FILL_PLUS_COST_MODEL_V1';

const MEASUREMENT_FIX_VERSION =
'LONG_MEASUREMENT_FIX_TRIGGER_BOUNDARY_EXIT_FILL_V2';
const DEFAULT_POSITION_TIME_STOP_MIN = 720;
const MIN_COMPLETED_ACTIVE_LEARNING = 20;
const MIN_COMPLETED_FAMILY_GATE = 35;
const LONG_FIXED_SETUP_TYPES = new Set([
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
const LONG_FIXED_REGIME_BUCKETS = new Set(REGIME_ORDER);
const CONFIRMATION_PROFILE_ORDER = Object.freeze([
'A_STRONG_ALIGN',
'B_FLOW_ALIGN',
'C_VOLUME_ALIGN',
'D_MIXED_OK',
'E_WEAK_CONTRA'
]);
const LONG_CONFIRMATION_PROFILES = new Set(CONFIRMATION_PROFILE_ORDER);
const LONG_DIRECT = new Set([
'LONG',
'BULL',
'BULLISH',
'BUY',
'BID',
'UP',
'UPSIDE',
'GREEN'
]);
const SHORT_DIRECT = new Set([
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
function cloneImmutableSnapshot(value) {
if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
return JSON.parse(JSON.stringify(value));
}
function immutableEntryFields(position = {}, fallbackTs = now()) {
const snapshot = position.entryDecisionSnapshot ||
position.temporalEntryDecisionSnapshot || null;
const entryTs = safeNumber(
snapshot?.entryTs ?? position.entryTs ?? position.openedAt ?? position.createdAt,
fallbackTs
);
return entryTemporalFields({
entryTs,
marketEventClusterId: position.marketEventClusterId,
scannerRunId: position.scannerRunId,
snapshotId: position.snapshotId,
marketCycleId: position.marketCycleId
}, entryTs);
}
function upper(value) {
return String(value || '').trim().toUpperCase();
}
function namespacedLongKey(key, fallback) {
const raw = String(key || fallback || '').trim();
if (!raw) return `${LONG_KEY_PREFIX}MISSING_KEY`;
if (raw.startsWith(LONG_KEY_PREFIX)) return raw;
if (raw.startsWith('SHORT:') || raw.includes(`${LONG_KEY_PREFIX}SHORT:`)) {
throw new Error('LONG_POSITION_KEY_REJECTED_SHORT_NAMESPACE');
}
return `${LONG_KEY_PREFIX}${raw}`;
}
function storageSymbol(input) {
const raw = typeof input === 'object'
? input?.symbol || input?.baseSymbol || input?.contractSymbol
: input;
const base = normalizeBaseSymbol(raw);
return base || String(raw || '').toUpperCase().trim();
}
function resolveOpenPatternKey() {
const configured =
KEYS.long?.trade?.openPattern ||
KEYS.trade?.longOpenPattern ||
KEYS.trade?.openPattern;
return namespacedLongKey(configured, 'TRADE:OPEN:*');

}
function resolveOpenKey(symbol) {
const keySymbol = storageSymbol(symbol);
if (!keySymbol) return null;
if (typeof KEYS.long?.trade?.open === 'function') {
return namespacedLongKey(
KEYS.long.trade.open(keySymbol),
`TRADE:OPEN:${keySymbol}`
);
}
if (typeof KEYS.trade?.longOpen === 'function') {
return namespacedLongKey(
KEYS.trade.longOpen(keySymbol),
`TRADE:OPEN:${keySymbol}`
);
}
if (typeof KEYS.trade?.open === 'function') {
return namespacedLongKey(
KEYS.trade.open(keySymbol),
`TRADE:OPEN:${keySymbol}`
);
}
return namespacedLongKey(null, `TRADE:OPEN:${keySymbol}`);
}
const LONG_KEYS = {
trade: {
openPattern: resolveOpenPatternKey(),
open: resolveOpenKey
}
};
function tradeConfig() {
return {
dataConcurrency: Math.max(
1,
Math.floor(safeNumber(
CONFIG.long?.trade?.dataConcurrency ??
CONFIG.trade?.dataConcurrency,
5
))
),
positionTimeStopMin: Math.max(
1,
safeNumber(
CONFIG.long?.trade?.positionTimeStopMin ??
CONFIG.trade?.positionTimeStopMin,
DEFAULT_POSITION_TIME_STOP_MIN
)

)
};
}
function manageConfig() {
return {
applyLive: CONFIG.long?.manage?.applyLive === true ||
CONFIG.manage?.applyLive === true,
beArmR: safeNumber(CONFIG.long?.manage?.beArmR ?? CONFIG.manage?.beArmR,
0.70),
beLockR: safeNumber(CONFIG.long?.manage?.beLockR ?? CONFIG.manage?.beLockR,
0.05),
trailArmR: safeNumber(CONFIG.long?.manage?.trailArmR ??
CONFIG.manage?.trailArmR, 1.00),
trailLockR: safeNumber(CONFIG.long?.manage?.trailLockR ??
CONFIG.manage?.trailLockR, 0.35)
};
}
function round4(value) {
return Number(safeNumber(value, 0).toFixed(4));
}
function round6(value) {
return Number(safeNumber(value, 0).toFixed(6));
}
function roundPrice(value) {
const n = safeNumber(value, 0);
if (n >= 1000) return Number(n.toFixed(2));
if (n >= 1) return Number(n.toFixed(6));
return Number(n.toFixed(10));
}
function clonePlainObject(value) {
if (typeof structuredClone === 'function') {
return structuredClone(value);
}
return JSON.parse(JSON.stringify(value ?? null));
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
function isExactLongChildTrueMicroId(id = '') {
const parsed = parseLongTaxonomyMicroId(id);
return Boolean(parsed.valid && parsed.selectable && parsed.isChild);
}
function isParentLongTrueMicroId(id = '') {
const parsed = parseLongTaxonomyMicroId(id);
return Boolean(parsed.valid && parsed.isParent && !parsed.selectable);
}
function stripSymbolTokensFromLearningId(id = '', row = {}) {
const raw = String(id || '').trim();
if (!raw) return raw;
if (isExactLongChildTrueMicroId(raw) || isParentLongTrueMicroId(raw)) {
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
function cleanSideText(value = '') {
return String(value || '')
.trim()
.toUpperCase()
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
function normalizeTradeSide(value) {
const raw = cleanSideText(value);
if (!raw) return 'UNKNOWN';
const direct = sideToTradeSide(raw);
if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
if (LONG_DIRECT.has(raw)) return TARGET_TRADE_SIDE;
if (SHORT_DIRECT.has(raw)) return OPPOSITE_TRADE_SIDE;
const normalized = raw
.replace(/[^A-Z0-9]+/g, '_')
.replace(/^_+|_+$/g, '');
const longHit =
normalized === 'LONG' ||
normalized === 'BULL' ||
normalized === 'BUY' ||
normalized.includes('MICRO_LONG_') ||
normalized.includes('TRADESIDE_LONG') ||
normalized.includes('TRADE_SIDE_LONG') ||
normalized.includes('POSITION_SIDE_LONG') ||
normalized.includes('POSITIONSIDE_LONG') ||
normalized.includes('SIDE_LONG') ||
normalized.includes('SIDE_BULL') ||
normalized.includes('DIRECTION_LONG') ||
normalized.includes('DIRECTION_BULL') ||
normalized.includes('SIDE_BUY') ||
normalized.includes('DIRECTION_BUY') ||
normalized.startsWith('LONG_') ||
normalized.includes('_LONG_') ||
normalized.endsWith('_LONG') ||

normalized.startsWith('BULL_') ||
normalized.includes('_BULL_') ||
normalized.endsWith('_BULL') ||
normalized.startsWith('BUY_') ||
normalized.includes('_BUY_') ||
normalized.endsWith('_BUY');
const shortHit =
normalized === 'SHORT' ||
normalized === 'BEAR' ||
normalized === 'SELL' ||
normalized.includes('MICRO_SHORT_') ||
normalized.includes('TRADESIDE_SHORT') ||
normalized.includes('TRADE_SIDE_SHORT') ||
normalized.includes('POSITION_SIDE_SHORT') ||
normalized.includes('POSITIONSIDE_SHORT') ||
normalized.includes('SIDE_SHORT') ||
normalized.includes('SIDE_BEAR') ||
normalized.includes('DIRECTION_SHORT') ||
normalized.includes('DIRECTION_BEAR') ||
normalized.includes('SIDE_SELL') ||
normalized.includes('DIRECTION_SELL') ||
normalized.startsWith('SHORT_') ||
normalized.includes('_SHORT_') ||
normalized.endsWith('_SHORT') ||
normalized.startsWith('BEAR_') ||
normalized.includes('_BEAR_') ||
normalized.endsWith('_BEAR') ||
normalized.startsWith('SELL_') ||
normalized.includes('_SELL_') ||
normalized.endsWith('_SELL');
if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;
if (longHit && !shortHit) return TARGET_TRADE_SIDE;
if (longHit && shortHit) {
if (normalized.includes('TRADE_SIDE_LONG') ||
normalized.includes('TRADESIDE_LONG')) {
return TARGET_TRADE_SIDE;
}
if (normalized.includes('TRADE_SIDE_SHORT') ||
normalized.includes('TRADESIDE_SHORT')) {
return OPPOSITE_TRADE_SIDE;
}
if (normalized.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
if (normalized.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
}
return 'UNKNOWN';
}
function normalizedTextParts(row = {}) {

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
.map((value) => String(value || '').toUpperCase())
.filter(Boolean);
}
function idText(row = {}) {
return [
row.familyId,
row.family,
row.baseFamilyId,
row.childTrueMicroFamilyId,
row.trueMicroFamilyId,
row.microFamilyId,
row.analyzeMicroFamilyId,
row.learningMicroFamilyId,
row.fixedTaxonomyMicroFamilyId,
row.coarseMicroFamilyId,
row.baseMicroFamilyId,
row.legacyMicroFamilyId,
row.scannerMicroFamilyId,
row.scannerFamilyId,
row.executionMicroFamilyId,
row.parentTrueMicroFamilyId,
row.macroFamilyId,
row.parentMacroFamilyId,
row.parentMicroFamilyId,
row.parentFamilyId,
row.id,
row.key
]
.map((value) => String(value || '').toUpperCase())
.filter(Boolean)
.join('|');
}
function hasLongIdSignal(text = '') {
const raw = String(text || '').toUpperCase();

return (
raw.includes('MICRO_LONG_') ||
raw.includes('LONG_') ||
raw.includes('_LONG_') ||
raw.endsWith('_LONG') ||
raw.includes('TRADESIDE=LONG') ||
raw.includes('TRADE_SIDE=LONG') ||
raw.includes('SIDE=LONG') ||
raw.includes('SIDE=BULL') ||
raw.includes('DIRECTION=LONG') ||
raw.includes('DIRECTION=BULL') ||
raw.includes('POSITION_SIDE=LONG') ||
raw.includes('POSITIONSIDE=LONG')
);
}
function hasShortIdSignal(text = '') {
const raw = String(text || '').toUpperCase();
return (
raw.includes('MICRO_SHORT_') ||
raw.includes('SHORT_') ||
raw.includes('_SHORT_') ||
raw.endsWith('_SHORT') ||
raw.includes('TRADESIDE=SHORT') ||
raw.includes('TRADE_SIDE=SHORT') ||
raw.includes('SIDE=SHORT') ||
raw.includes('SIDE=BEAR') ||
raw.includes('DIRECTION=SHORT') ||
raw.includes('DIRECTION=BEAR') ||
raw.includes('POSITION_SIDE=SHORT') ||
raw.includes('POSITIONSIDE=SHORT')
);
}
function hasLongDefinitionSignal(parts = []) {
const haystack = parts.join('|');
return (
haystack.includes('TRADESIDE=LONG') ||
haystack.includes('TRADE_SIDE=LONG') ||
haystack.includes('SIDE=LONG') ||
haystack.includes('SIDE=BULL') ||
haystack.includes('DIRECTION=LONG') ||
haystack.includes('DIRECTION=BULL') ||
haystack.includes('POSITION_SIDE=LONG') ||
haystack.includes('POSITIONSIDE=LONG') ||
haystack.includes('SIDE=BUY') ||
haystack.includes('DIRECTION=BUY') ||
haystack.includes('MICRO_LONG_')
);

}
function hasShortDefinitionSignal(parts = []) {
const haystack = parts.join('|');
return (
haystack.includes('TRADESIDE=SHORT') ||
haystack.includes('TRADE_SIDE=SHORT') ||
haystack.includes('SIDE=SHORT') ||
haystack.includes('SIDE=BEAR') ||
haystack.includes('DIRECTION=SHORT') ||
haystack.includes('DIRECTION=BEAR') ||
haystack.includes('POSITION_SIDE=SHORT') ||
haystack.includes('POSITIONSIDE=SHORT') ||
haystack.includes('SIDE=SELL') ||
haystack.includes('DIRECTION=SELL') ||
haystack.includes('MICRO_SHORT_')
);
}
function inferTradeSideFromIds(row = {}) {
const haystack = idText(row);
if (!haystack) return 'UNKNOWN';
if (hasLongIdSignal(haystack) && !hasShortIdSignal(haystack)) return
TARGET_TRADE_SIDE;
if (hasShortIdSignal(haystack) && !hasLongIdSignal(haystack)) return
OPPOSITE_TRADE_SIDE;
if (haystack.includes('TRADE_SIDE=LONG') ||
haystack.includes('TRADESIDE=LONG')) return TARGET_TRADE_SIDE;
if (haystack.includes('TRADE_SIDE=SHORT') || haystack.includes('TRADESIDE=SHORT'))
return OPPOSITE_TRADE_SIDE;
if (haystack.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
if (haystack.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
return 'UNKNOWN';
}
function inferTradeSideFromDefinitions(row = {}) {
const parts = normalizedTextParts(row);
if (!parts.length) return 'UNKNOWN';
if (hasLongDefinitionSignal(parts) && !hasShortDefinitionSignal(parts)) return
TARGET_TRADE_SIDE;
if (hasShortDefinitionSignal(parts) && !hasLongDefinitionSignal(parts)) return
OPPOSITE_TRADE_SIDE;
const haystack = parts.join('|');
if (haystack.includes('TRADE_SIDE=LONG') ||
haystack.includes('TRADESIDE=LONG')) return TARGET_TRADE_SIDE;
if (haystack.includes('TRADE_SIDE=SHORT') || haystack.includes('TRADESIDE=SHORT'))
return OPPOSITE_TRADE_SIDE;
if (haystack.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
if (haystack.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
return 'UNKNOWN';

}
function inferPositionTradeSide(row = {}) {
if (typeof row === 'string') return normalizeTradeSide(row);
if (!row || typeof row !== 'object') return 'UNKNOWN';
const directSources = [
row.tradeSide,
row.positionSide,
row.direction,
row.signalSide,
row.scannerSide,
row.analysisSide,
row.actualScannerSide,
row.side
];
for (const value of directSources) {
const side = normalizeTradeSide(value);
if (side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE) return side;
}
const fromIds = inferTradeSideFromIds(row);
if (fromIds === TARGET_TRADE_SIDE || fromIds === OPPOSITE_TRADE_SIDE) {
return fromIds;
}
const fromDefinitions = inferTradeSideFromDefinitions(row);
if (fromDefinitions === TARGET_TRADE_SIDE || fromDefinitions ===
OPPOSITE_TRADE_SIDE) {
return fromDefinitions;
}
if (row.longOnly === true && row.shortDisabled === true) {
return TARGET_TRADE_SIDE;
}
if (row.shortOnly === true || row.longDisabled === true) {
return OPPOSITE_TRADE_SIDE;
}
return 'UNKNOWN';
}
function isLongPosition(row = {}) {
return inferPositionTradeSide(row) === TARGET_TRADE_SIDE;
}
function firstValidLearningId(row = {}, candidates = []) {
for (const candidate of candidates) {
const raw = String(candidate || '').trim();
if (!raw) continue;
if (isScannerFingerprintId(raw)) continue;
if (isExecutionFingerprintId(raw)) continue;
const clean = stripSymbolTokensFromLearningId(raw, row);
if (!clean) continue;
if (isScannerFingerprintId(clean)) continue;

if (isExecutionFingerprintId(clean)) continue;
return clean.toUpperCase();
}
return '';
}
function rowMicroId(row = {}) {
return firstValidLearningId(row, [
row.childTrueMicroFamilyId,
row.trueMicroFamilyId,
row.microFamilyId,
row.analyzeMicroFamilyId,
row.learningMicroFamilyId,
row.fixedTaxonomyMicroFamilyId
]);
}
function rowParentMicroId(row = {}) {
const direct = firstValidLearningId(row, [
row.parentTrueMicroFamilyId,
row.coarseMicroFamilyId,
row.parentMacroFamilyId,
row.parentMicroFamilyId,
row.macroFamilyId
]);
if (isParentLongTrueMicroId(direct)) return direct;
const child = rowMicroId(row);
const parsed = parseLongTaxonomyMicroId(child);
return parsed.parentTrueMicroFamilyId || '';
}
function scannerMicroId(row = {}) {
const candidates = [
row.scannerMicroFamilyId,
isScannerFingerprintId(row.microFamilyId) ? row.microFamilyId : null,
isScannerFingerprintId(row.trueMicroFamilyId) ? row.trueMicroFamilyId : null,
isScannerFingerprintId(row.id) ? row.id : null,
isScannerFingerprintId(row.key) ? row.key : null
];
return candidates.find(Boolean) || null;
}
function executionMicroId(row = {}) {
const candidates = [
row.executionMicroFamilyId,
isExecutionFingerprintId(row.microFamilyId) ? row.microFamilyId : null,
isExecutionFingerprintId(row.trueMicroFamilyId) ? row.trueMicroFamilyId :
null,
isExecutionFingerprintId(row.analyzeMicroFamilyId) ? row.analyzeMicroFamilyId
: null,
isExecutionFingerprintId(row.id) ? row.id : null,

isExecutionFingerprintId(row.key) ? row.key : null
];
return candidates.find(Boolean) || null;
}
function isScannerFamilyRow(row = {}) {
return Boolean(
isScannerFingerprintId(row.microFamilyId) ||
isScannerFingerprintId(row.trueMicroFamilyId) ||
isScannerFingerprintId(row.childTrueMicroFamilyId) ||
isScannerFingerprintId(row.coarseMicroFamilyId) ||
isScannerFingerprintId(row.id) ||
isScannerFingerprintId(row.key)
);
}
function isTrueMicroFamilyRow(row = {}) {
const id = rowMicroId(row);
const parsed = parseLongTaxonomyMicroId(id);
if (!row || !id) return false;
if (!validLearningId(id)) return false;
if (isScannerFamilyRow(row)) return false;
if (!isLongPosition(row) && !hasLongIdSignal(id)) return false;
return Boolean(parsed.selectable && parsed.isChild);
}
function fallbackFamilyId(row = {}) {
const parentId = rowParentMicroId(row);
if (parentId) return parentId;
const direct = String(
row.familyId ||
row.family ||
row.baseFamilyId ||
''
).trim();
if (direct && !isScannerFingerprintId(direct) &&
!isExecutionFingerprintId(direct)) {
return stripSymbolTokensFromLearningId(direct, row);
}
return rowMicroId(row) || 'MICRO_LONG_UNKNOWN_PARENT';
}
function normalizeMicroIdentity(row = {}) {
const microFamilyId = rowMicroId(row);
const parsed = parseLongTaxonomyMicroId(microFamilyId);
if (!microFamilyId) {
throw new Error('ANALYZE_TRUE_MICRO_FAMILY_ID_REQUIRED');
}
if (isScannerFingerprintId(microFamilyId)) {
throw new Error('SCANNER_FINGERPRINT_CANNOT_BE_LEARNING_FAMILY_ID');
}

if (isExecutionFingerprintId(microFamilyId)) {
throw new Error('EXECUTION_FINGERPRINT_CANNOT_BE_LEARNING_FAMILY_ID');
}
if (!parsed.selectable || !parsed.isChild) {
throw new Error('EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_REQUIRED');
}
const parentId = parsed.parentTrueMicroFamilyId;
const scannerId = scannerMicroId(row);
const executionId = executionMicroId(row);
return {
microFamilyId,
trueMicroFamilyId: microFamilyId,
childTrueMicroFamilyId: microFamilyId,
analyzeMicroFamilyId: microFamilyId,
learningMicroFamilyId: microFamilyId,
fixedTaxonomyMicroFamilyId: microFamilyId,
parentTrueMicroFamilyId: parentId,
coarseMicroFamilyId: parentId,
baseMicroFamilyId: parentId,
legacyMicroFamilyId: parentId,
familyId: fallbackFamilyId({
...row,
parentTrueMicroFamilyId: parentId
}) || parentId,
parentMacroFamilyId: parentId,
parentMicroFamilyId: parentId,
macroFamilyId: parentId,
setupType: parsed.setup,
regimeBucket: parsed.regime,
confirmationProfile: parsed.confirmationProfile,
scannerMicroFamilyId: scannerId,
scannerFamilyId: row.scannerFamilyId || null,
scannerDefinition: row.scannerDefinition || null,
scannerDefinitionParts: Array.isArray(row.scannerDefinitionParts)
? row.scannerDefinitionParts
: [],
executionMicroFamilyId: executionId,
executionFingerprintRole: 'METADATA_ONLY',
executionFingerprintOnlyMetadata: Boolean(executionId),
executionFingerprintsMetadataOnly: true,
executionFingerprintsUsedAsLearningFamily: false,
scannerFingerprintRole: 'METADATA_ONLY',
scannerFingerprintOnlyMetadata: Boolean(scannerId),
scannerFingerprintsMetadataOnly: true,
scannerFingerprintsUsedAsLearningFamily: false,
learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
exactTrueMicroFamilyRequired: true,

symbolExcludedFromFamilyId: true,
coinNameExcludedFromFamilyId: true,
hashesExcludedFromFamilyId: true,
fixedTaxonomyLearningId: true,
fixedTaxonomyPreferred: true,
schema: TRUE_MICRO_SCHEMA,
microFamilySchema: TRUE_MICRO_SCHEMA,
trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
learningGranularity: LEARNING_GRANULARITY,
parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
parentLearningEnabled: true,
childLearningEnabled: true,
selectionGranularity: 'EXACT_75_CHILD',
fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED',
isTrueMicro: true,
trueMicro: true,
isLegacyMacro: false,
trueMicroOnly: true,
exactTrueMicroOnly: true
};
}
function validLongRiskGeometry(row = {}) {
const entryPrice = safeNumber(row.entry, 0);
const sl = safeNumber(row.sl, 0);
const tp = safeNumber(row.tp, 0);
return entryPrice > 0 && sl > 0 && tp > 0 && sl < entryPrice && entryPrice < tp;
}
function assertLongRiskGeometry(row = {}) {
if (!validLongRiskGeometry(row)) {
throw new
Error('OPEN_POSITION_LONG_RISK_GEOMETRY_INVALID_SL_LT_ENTRY_LT_TP_REQUIRED');
}
}
function assertLearningFamilyIdentity(row = {}) {
const microFamilyId = rowMicroId(row);
if (!microFamilyId) {
throw new Error('OPEN_POSITION_TRUE_MICRO_FAMILY_ID_MISSING');
}
if (isScannerFingerprintId(microFamilyId) || isScannerFamilyRow(row)) {
throw new Error('OPEN_POSITION_SCANNER_FINGERPRINT_METADATA_ONLY');
}
if (isExecutionFingerprintId(microFamilyId)) {
throw new Error('OPEN_POSITION_EXECUTION_FINGERPRINT_METADATA_ONLY');
}

if (!isExactLongChildTrueMicroId(microFamilyId)) {
throw new Error('OPEN_POSITION_REQUIRES_EXACT_75_CHILD_TRUE_MICRO_FAMILY');
}
if (!isTrueMicroFamilyRow(row)) {
throw new Error('OPEN_POSITION_REQUIRES_ANALYZE_TRUE_MICRO_FAMILY');
}
}
function assertBasePositionFields(row = {}) {
if (inferPositionTradeSide(row) !== TARGET_TRADE_SIDE) {
throw new Error('OPEN_POSITION_LONG_ONLY_SYSTEM_REJECTED_NON_LONG_ENTRY');
}
if (!row.entry || !row.sl || !row.tp) {
throw new Error('OPEN_POSITION_RISK_GEOMETRY_MISSING');
}
assertLearningFamilyIdentity(row);
assertLongRiskGeometry(row);
}
function assertPositionPersistable(position = {}) {
assertBasePositionFields(position);
if (position.status && String(position.status).toUpperCase() !== 'OPEN') {
throw new Error('OPEN_POSITION_STATUS_MUST_BE_OPEN');
}
if (!String(position.canonicalPositionId || '').trim()) {
throw new Error('OPEN_POSITION_CANONICAL_POSITION_ID_REQUIRED');
}
if (!String(position.canonicalOutcomeId || '').trim()) {
throw new Error('OPEN_POSITION_CANONICAL_OUTCOME_ID_REQUIRED');
}
if (!Number.isFinite(Number(position.entryTs)) || Number(position.entryTs) <= 0) {
throw new Error('OPEN_POSITION_IMMUTABLE_ENTRY_TS_REQUIRED');
}
const snapshot = position.entryDecisionSnapshot || null;
if (snapshot && Number(snapshot.entryTs) !== Number(position.entryTs)) {
throw new Error('OPEN_POSITION_ENTRY_DECISION_TS_MISMATCH');
}
}
function assertLongInput(row = {}, context = 'POSITION') {
const side = inferPositionTradeSide(row);
if (side !== TARGET_TRADE_SIDE) {
throw new Error(`${context}_LONG_ONLY_REJECTED_${side}`);
}
}
function calcStopFromR({
entry,
initialSl,
stopR
} = {}) {
const e = safeNumber(entry, 0);
const sl = safeNumber(initialSl, 0);
const r = safeNumber(stopR, 0);
if (e <= 0 || sl <= 0 || sl >= e) return 0;
const riskDist = e - sl;
if (riskDist <= 0) return 0;
return e + riskDist * r;
}
function shouldTightenStop({
currentSl,
nextSl
} = {}) {
const current = safeNumber(currentSl, 0);

const next = safeNumber(nextSl, 0);
if (current <= 0 || next <= 0) return false;
return next > current;
}
function applyLiveStopManagement(position) {
const cfg = manageConfig();
if (!cfg.applyLive) return position;
if (!isLongPosition(position)) return position;
const entry = safeNumber(position.entry, 0);
const initialSl = safeNumber(position.initialSl || position.sl, 0);
const currentSl = safeNumber(position.sl, 0);
const currentR = safeNumber(position.currentR, 0);
if (entry <= 0 || initialSl <= 0 || currentSl <= 0 || initialSl >= entry) return
position;
let nextStopR = null;
let source = null;
if (currentR >= cfg.beArmR) {
nextStopR = cfg.beLockR;
source = 'BE';
}
if (currentR >= cfg.trailArmR) {
nextStopR = Math.max(
safeNumber(nextStopR, cfg.beLockR),
cfg.trailLockR
);
source = 'TRAIL';
}
if (nextStopR === null) return position;
const nextSl = calcStopFromR({
entry,
initialSl,
stopR: nextStopR
});
if (!shouldTightenStop({
currentSl,
nextSl
})) {
return position;
}
position.sl = roundPrice(nextSl);
position.slManagementSource = source;
position.slMovedAt = now();
position.liveManaged = true;
if (source === 'BE') {
position.beLiveApplied = true;
}
if (source === 'TRAIL') {

position.trailLiveApplied = true;
}
return position;
}
function detectExit({
position,
price,
timestamp
} = {}) {
const cfg = tradeConfig();
const current = safeNumber(price, 0);
const tp = safeNumber(position.tp, 0);
const sl = safeNumber(position.sl, 0);
const openedAt = safeNumber(position.openedAt || position.createdAt, 0);
if (current <= 0 || tp <= 0 || sl <= 0) {
return {
shouldExit: false,
reason: null,
trigger: null
};
}
if (!isLongPosition(position)) {
return {
shouldExit: false,
reason: 'NON_LONG_POSITION_IGNORED',
trigger: null
};
}
if (current >= tp) {
return {
shouldExit: true,
reason: 'TP',
trigger: 'price >= tp'
};
}
if (current <= sl) {
return {
shouldExit: true,
reason: 'SL',
trigger: 'price <= sl'
};
}
const expired =
openedAt > 0 &&
timestamp - openedAt >= cfg.positionTimeStopMin * 60 * 1000;
if (expired) {
return {

shouldExit: true,
reason: 'TIME_STOP',
trigger: 'TIME_STOP'
};
}
return {
shouldExit: false,
reason: null,
trigger: null
};
}
function resolveExitFill({
position,
observedPrice,
exitReason
} = {}) {
const reason = upper(exitReason);
const observed = roundPrice(observedPrice);
const tp = roundPrice(position?.tp);
const sl = roundPrice(position?.sl);
let fillPrice = observed;
let triggerPrice = null;
let fillSource = 'OBSERVED_MARKET_PRICE';
let triggerBoundaryFillApplied = false;
if (reason === 'TP' && tp > 0) {
fillPrice = tp;
triggerPrice = tp;
fillSource = 'TP_TRIGGER_BOUNDARY';
triggerBoundaryFillApplied = true;
} else if (reason === 'SL' && sl > 0) {
fillPrice = sl;
triggerPrice = sl;
fillSource = 'SL_TRIGGER_BOUNDARY';
triggerBoundaryFillApplied = true;
} else if (reason === 'TIME_STOP') {
fillPrice = observed;
fillSource = 'TIME_STOP_OBSERVED_MARKET_PRICE';
}
if (fillPrice <= 0) {
throw new Error('EXIT_FILL_PRICE_INVALID');
}
const observedVsFillPct =
observed > 0 && fillPrice > 0
? (observed - fillPrice) / fillPrice
: 0;
return {
exitPrice: fillPrice,

exitFillPrice: fillPrice,
exitObservedPrice: observed,
exitTriggerPrice: triggerPrice,
exitFillSource: fillSource,
exitFillModelVersion: EXIT_FILL_MODEL_VERSION,
triggerBoundaryFillApplied,
observedVsFillPct: round6(observedVsFillPct),
observedBeyondTriggerPct: round6(Math.abs(observedVsFillPct)),
exitFillAssumption: triggerBoundaryFillApplied
? 'TRIGGER_BOUNDARY_PLUS_COST_MODEL'
: 'OBSERVED_MARKET_PRICE_PLUS_COST_MODEL'
};
}
function identityFlags() {
return {
virtualLearning: true,
virtualOnly: true,
realOrdersDisabled: true,
bitgetOrdersDisabled: true,
exchangeCallsDisabled: true,
exchangeOrdersDisabled: true,
noRealOrders: true,
noExchangeOrders: true,
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
manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
discordOnlyForExactTrueMicroMatch: true,
completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
scoringRSource: 'netR',
winsLossesFlatsSource: 'netR',
winrateDefinition: 'netR > 0',
avgRSource: 'netR',
totalRSource: 'netR',
avgCostRShown: true,
measurementFixVersion: MEASUREMENT_FIX_VERSION,
exitFillModelVersion: EXIT_FILL_MODEL_VERSION,

exitFillPolicy: 'TP_SL_USE_TRIGGER_BOUNDARY_TIME_STOP_USES_OBSERVED_PRICE',
exitFillAssumption: 'TRIGGER_BOUNDARY_PLUS_COST_MODEL',
directSLDefinition: 'SL_EXIT_WITHOUT_MEANINGFUL_MFE',
directSLMfeThresholdR: 0.25,
seenDefinition: 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY',
completedOnlyClosedVirtualOrShadow: true,
currentFitSoftOnly: true,
currentFitBlocksLearning: false,
currentFitBlocksVirtualLearning: false,
currentFitBlocksShadowLearning: false,
currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
learningRemainsBroad: true,
selectionWillBeAdaptive: true,
discordWillBeStrict: true,
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
exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
childTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
parentLearningEnabled: true,
childLearningEnabled: true,
learningGranularity: LEARNING_GRANULARITY,
parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
selectionGranularity: 'EXACT_75_CHILD',
fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED',
minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,
minCompletedForFamilyGate: MIN_COMPLETED_FAMILY_GATE,
statusRules: {
OBSERVING: 'completed == 0',
EARLY_OUTCOMES: 'completed > 0 && completed < 20',
ACTIVE_LEARNING: 'completed >= 20 && completed < 35',
PASSED: 'completed >= 35 && avgR > 0',
EMPIRICAL_VETO: 'completed >= 35 && avgR <= 0'
},
redisNamespace: LONG_NAMESPACE,
redisKeyPrefix: LONG_KEY_PREFIX,
persistentLearningKey: PERSISTENT_LEARNING_KEY,

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
shortRootTouched: false
};
}
function forceLongPositionFields(row = {}) {
return {
...row,
side: TARGET_DASHBOARD_SIDE,
tradeSide: TARGET_TRADE_SIDE,
positionSide: TARGET_TRADE_SIDE,
direction: TARGET_TRADE_SIDE,
targetTradeSide: TARGET_TRADE_SIDE,
targetScannerSide: TARGET_SCANNER_SIDE,
dashboardSide: TARGET_DASHBOARD_SIDE,
oppositeTradeSide: OPPOSITE_TRADE_SIDE,
longOnly: true,
shortDisabled: true,
shortOnly: false,
longDisabled: false,
virtualOnly: true,
virtualTracked: true,
realTrade: false,
realOrder: false,
exchangeOrder: false,
bitgetOrderPlaced: false,
realOrdersDisabled: true,
bitgetOrdersDisabled: true,
exchangeOrdersDisabled: true,
exchangeCallsDisabled: true,
noRealOrders: true,
noExchangeOrders: true,
...identityFlags()
};
}

function buildVirtualFlags(row = {}) {
return {
source: POSITION_SOURCE,
outcomeSource: OUTCOME_SOURCE,
positionSource: POSITION_SOURCE,
virtualOnly: true,
virtualTracked: true,
shadowOnly: false,
realTrade: false,
realOrder: false,
exchangeOrder: false,
realOrdersDisabled: true,
bitgetOrdersDisabled: true,
exchangeOrdersDisabled: true,
exchangeCallsDisabled: true,
bitgetOrderPlaced: false,
liveEligible: false,
discordAlertEligible: Boolean(row.discordAlertEligible),
selectedMicroFamilyAlert: Boolean(row.selectedMicroFamilyAlert),
selectedForDiscord: Boolean(row.selectedForDiscord || row.discordAlertEligible
|| row.selectedMicroFamilyAlert),
currentFitSoftOnly: true,
currentFitBlocksLearning: false,
currentFitBlocksVirtualLearning: false,
currentFitBlocksShadowLearning: false,
currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
learningRemainsBroad: true,
selectionWillBeAdaptive: true,
discordWillBeStrict: true
};
}
function calcGrossMovePctFromPosition({
position,
exitPrice
} = {}) {
const entry = safeNumber(position.entry, 0);
const exit = safeNumber(exitPrice, 0);
if (entry <= 0 || exit <= 0) return 0;
return (exit - entry) / entry;
}
function calcGrossRFromPosition({
position,
exitPrice
} = {}) {
const entry = safeNumber(position.entry, 0);
const initialSl = safeNumber(position.initialSl || position.sl, 0);

const exit = safeNumber(exitPrice, 0);
if (entry <= 0 || initialSl <= 0 || exit <= 0) return 0;
const riskDistance = entry - initialSl;
if (riskDistance <= 0) return 0;
return (exit - entry) / riskDistance;
}
function calcRiskPctFromPosition(position = {}) {
const entry = safeNumber(position.entry, 0);
const initialSl = safeNumber(position.initialSl || position.sl, 0);
if (entry <= 0 || initialSl <= 0 || initialSl >= entry) return 0;
return (entry - initialSl) / entry;
}
function calcRewardPctFromPosition(position = {}) {
const entry = safeNumber(position.entry, 0);
const tp = safeNumber(position.tp, 0);
if (entry <= 0 || tp <= entry || tp <= 0) return 0;
return (tp - entry) / entry;
}
function calcNetCostOutcome({
position,
exitPrice
} = {}) {
const riskPct = calcRiskPctFromPosition(position);
const grossMovePct = calcGrossMovePctFromPosition({
position,
exitPrice
});
const grossR = calcGrossRFromPosition({
position,
exitPrice
});
const entrySpreadPct = safeNumber(
position.spreadPct ??
position.liveSpreadPct ??
position.orderbookSpreadPct ??
CONFIG.long?.cost?.fallbackSpreadPct ??
CONFIG.cost?.fallbackSpreadPct,
0
);
const exitSpreadPct = safeNumber(
position.exitSpreadPct ??
position.spreadPct ??
position.liveSpreadPct ??
position.orderbookSpreadPct ??
CONFIG.long?.cost?.fallbackSpreadPct ??
CONFIG.cost?.fallbackSpreadPct,
0

);
const cost = applyCosts({
side: TARGET_TRADE_SIDE,
tradeSide: TARGET_TRADE_SIDE,
source: OUTCOME_SOURCE,
grossMovePct,
riskPct,
entrySpreadPct,
exitSpreadPct
}) || {};
const costGrossR = Number(cost.grossR);
const hasCostGrossR =
cost.grossR !== null &&
cost.grossR !== undefined &&
cost.grossR !== '' &&
Number.isFinite(costGrossR);
const appliedGrossR = hasCostGrossR
? costGrossR
: grossR;
const costR = Math.max(
0,
safeNumber(
cost.costR ??
position.costR ??
position.estimatedCostR ??
position.avgCostR,
0
)
);
const netR = appliedGrossR - costR;
return {
cost,
riskPct,
rewardPct: calcRewardPctFromPosition(position),
grossMovePct,
grossR: appliedGrossR,
costR,
netR,
feeR: Math.max(0, safeNumber(cost.feeR, 0)),
slippageR: Math.max(0, safeNumber(cost.slippageR, 0)),
marketImpactR: Math.max(0, safeNumber(cost.marketImpactR, 0)),
spreadCostR: Math.max(0, safeNumber(cost.spreadCostR, 0)),
feePct: safeNumber(cost.feePct, 0),
slippagePct: safeNumber(cost.slippagePct, 0),
costPct: safeNumber(cost.costPct, 0),
grossPnlPct: safeNumber(cost.grossPnlPct, grossMovePct * 100),
netPnlPct: safeNumber(cost.netPnlPct, (grossMovePct -

safeNumber(cost.costRatio, 0)) * 100)
};
}
function applyNetCostModelToOutcome({
outcome,
position,
exitPrice
} = {}) {
if (!outcome || typeof outcome !== 'object') return outcome;
if (!isLongPosition(position) || !isLongPosition(outcome)) {
return {
...outcome,
skipped: true,
reason: 'NON_LONG_OUTCOME_COST_MODEL_REJECTED',
source: OUTCOME_SOURCE,
longOnly: true,
shortDisabled: true,
shortOnly: false,
longDisabled: false,
realTrade: false,
realOrdersDisabled: true,
bitgetOrdersDisabled: true
};
}
const net = calcNetCostOutcome({
position,
exitPrice
});
return forceLongPositionFields({
...outcome,
source: OUTCOME_SOURCE,
outcomeSource: OUTCOME_SOURCE,
positionSource: position.source || POSITION_SOURCE,
virtualOnly: true,
virtualTracked: true,
shadowOnly: false,
realTrade: false,
realOrdersDisabled: true,
bitgetOrdersDisabled: true,
realOrder: false,
exchangeOrder: false,
bitgetOrderPlaced: false,
riskPct: round6(net.riskPct),
rewardPct: round6(net.rewardPct),
grossMovePct: round6(net.grossMovePct),
grossR: round6(net.grossR),
rawR: round6(net.grossR),

realizedGrossR: round6(net.grossR),
longGrossR: round6(net.grossR),
costR: round6(net.costR),
avgCostR: round6(net.costR),
totalCostR: round6(net.costR),
feeR: round6(net.feeR),
slippageR: round6(net.slippageR),
marketImpactR: round6(net.marketImpactR),
spreadCostR: round6(net.spreadCostR),
feePct: round6(net.feePct),
slippagePct: round6(net.slippagePct),
costPct: round6(net.costPct),
grossPnlPct: round6(net.grossPnlPct),
netPnlPct: round6(net.netPnlPct),
pnlPct: round6(net.netPnlPct),
netR: round6(net.netR),
longNetR: round6(net.netR),
exitR: round6(net.netR),
realizedNetR: round6(net.netR),
realizedR: round6(net.netR),
r: round6(net.netR),
win: net.netR > 0,
loss: net.netR < 0,
flat: net.netR === 0,
isWin: net.netR > 0,
costModelApplied: true,
netCostModelApplied: true,
costModel: COST_MODEL_VERSION,
costModelVersion: COST_MODEL_VERSION,
measurementFixVersion: MEASUREMENT_FIX_VERSION,
exitFillModelVersion: outcome.exitFillModelVersion ||
position.exitFillModelVersion || EXIT_FILL_MODEL_VERSION,
exitFillPolicy: 'TP_SL_USE_TRIGGER_BOUNDARY_TIME_STOP_USES_OBSERVED_PRICE',
exitFillAssumption: outcome.exitFillAssumption || position.exitFillAssumption
|| null,
scoringRSource: 'netR',
winsLossesFlatsSource: 'netR',
winrateDefinition: 'netR > 0',
avgRSource: 'netR',
totalRSource: 'netR',
avgCostRShown: true,
riskGeometryRule: 'LONG: sl < entry < tp',
tpHitRule: 'LONG: price >= tp',
slHitRule: 'LONG: price <= sl',
grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
currentRFormula: '(currentPrice - entry) / (entry - initialSl)'
});

}
export async function getOpenPositions() {
const redis = getDurableRedis();
const keys = await getKeys(redis, LONG_KEYS.trade.openPattern, 1000);
if (!keys.length) return [];
const rows = await Promise.all(
keys.map((key) => getJson(redis, key, null))
);
return rows
.filter(Boolean)
.filter((row) => String(row.status || 'OPEN').toUpperCase() === 'OPEN')
.filter(isLongPosition)
.filter((row) => !isScannerFamilyRow(row))
.filter((row) => isExactLongChildTrueMicroId(rowMicroId(row)))
.sort((a, b) => (
safeNumber(a.openedAt || a.createdAt, 0) -
safeNumber(b.openedAt || b.createdAt, 0)
));
}
export async function getOpenPosition(symbol) {
const keySymbol = storageSymbol(symbol);
if (!keySymbol) return null;
const row = await getJson(
getDurableRedis(),
LONG_KEYS.trade.open(keySymbol),
null
);
if (!row) return null;
if (String(row.status || 'OPEN').toUpperCase() !== 'OPEN') return null;
if (!isLongPosition(row)) return null;
if (isScannerFamilyRow(row)) return null;
if (!isExactLongChildTrueMicroId(rowMicroId(row))) return null;
return row;
}
function normalizeOpenPositionForStorage(position, keySymbol) {
const normalized = forceLongPositionFields(position);
const identity = normalizeMicroIdentity(normalized);
const entryTemporal = immutableEntryFields(normalized);
const canonicalPositionId = String(normalized.canonicalPositionId || '').trim();
const canonicalOutcomeId = String(
normalized.canonicalOutcomeId || canonicalPositionId
).trim();
const row = forceLongPositionFields({
...normalized,
...identity,
...buildVirtualFlags(normalized),
...entryTemporal,
canonicalPositionId,
canonicalOutcomeId,
canonicalIdentitySource: 'POSITION_CREATION_CANONICAL_ID',
entryDecisionSnapshot: cloneImmutableSnapshot(normalized.entryDecisionSnapshot),
temporalEntryDecisionSnapshot: cloneImmutableSnapshot(
normalized.entryDecisionSnapshot || normalized.temporalEntryDecisionSnapshot
),
entryContextImmutable: true,
symbol: normalized.symbol || keySymbol,
baseSymbol: normalized.baseSymbol || keySymbol,
contractSymbol: normalized.contractSymbol || null,
status: normalized.status || 'OPEN',
strategyVersion: normalized.strategyVersion || CONFIG.strategyVersion,
updatedAt: now()
});
assertPositionPersistable(row);
return row;
}
async function persistOpenPositionWithoutDuplicateRead(position, context =
'SAVE_EXISTING_OPEN_POSITION') {
assertLongInput(position, context);
const keySymbol = storageSymbol(position);
if (!keySymbol) {
throw new Error('OPEN_POSITION_SYMBOL_MISSING');
}
const row = normalizeOpenPositionForStorage(
position,
keySymbol
);
await setJson(
getDurableRedis(),
LONG_KEYS.trade.open(keySymbol),
row
);
return row;
}
export async function saveOpenPosition(position) {
assertLongInput(position, 'SAVE_OPEN_POSITION');
const keySymbol = storageSymbol(position);
if (!keySymbol) {
throw new Error('OPEN_POSITION_SYMBOL_MISSING');
}
const existing = await getOpenPosition(keySymbol);
if (
existing &&
existing.tradeId &&
position.tradeId &&
existing.tradeId !== position.tradeId
) {
throw new Error('OPEN_POSITION_SYMBOL_ALREADY_OPEN_LONG_ONLY');
}
return persistOpenPositionWithoutDuplicateRead(
position,
'SAVE_OPEN_POSITION'
);
}
export async function saveExistingOpenPosition(position) {
return persistOpenPositionWithoutDuplicateRead(
position,
'SAVE_EXISTING_OPEN_POSITION'
);

}
export async function deleteOpenPosition(symbol) {
const keySymbol = storageSymbol(symbol);
if (!keySymbol) return 0;
const key = LONG_KEYS.trade.open(keySymbol);
if (!key) return 0;
return getDurableRedis().del(key);
}
export function updatePathMetrics(position, price) {
const cfg = manageConfig();
if (!isLongPosition(position)) {
position.updatedAt = now();
position.longOnly = true;
position.shortDisabled = true;
position.shortOnly = false;
position.longDisabled = false;
position.liveManagementSkippedReason = 'NON_LONG_POSITION_IGNORED';
return position;
}
const current = safeNumber(price, 0);
const entry = safeNumber(position.entry, 0);
const initialSl = safeNumber(position.initialSl || position.sl, 0);
const tp = safeNumber(position.tp, 0);
if (entry <= 0 || initialSl <= 0 || tp <= 0 || current <= 0 || initialSl >=
entry || tp <= entry) {
return forceLongPositionFields({
...position,
updatedAt: now()
});
}
const riskDist = entry - initialSl;
const rewardDist = tp - entry;
const directionalMove = current - entry;
const currentR = directionalMove / riskDist;
const tpProgress = directionalMove / rewardDist;
position.lastPrice = current;
position.currentPrice = current;
position.currentR = round4(currentR);
position.longCurrentR = round4(currentR);
position.mfeR = round4(Math.max(
safeNumber(position.mfeR, 0),
position.currentR
));
position.maeR = round4(Math.min(
safeNumber(position.maeR, 0),
position.currentR
));

position.maxTpProgress = round4(Math.max(
safeNumber(position.maxTpProgress, 0),
tpProgress
));
position.ticksObserved = safeNumber(position.ticksObserved, 0) + 1;
if (currentR > 0) {
position.favorableTicks = safeNumber(position.favorableTicks, 0) + 1;
}
if (currentR < 0) {
position.adverseTicks = safeNumber(position.adverseTicks, 0) + 1;
}
if (position.mfeR >= 0.5) position.reachedHalfR = true;
if (position.mfeR >= 1.0) position.reachedOneR = true;
if (tpProgress >= 0.8) position.nearTpSeen = true;
if (position.mfeR >= cfg.beArmR) {
position.beArmed = true;
if (currentR <= cfg.beLockR && !position.beWouldExit) {
position.beWouldExit = true;
position.beExitR = cfg.beLockR;
position.beWouldExitAt = now();
}
}
if (position.reachedHalfR && currentR < 0) {
position.gaveBackAfterHalfR = true;
}
if (position.reachedOneR && currentR < cfg.trailLockR) {
position.gaveBackAfterOneR = true;
}
if (position.nearTpSeen && currentR < 0) {
position.nearTpThenLoss = true;
}
applyLiveStopManagement(position);
Object.assign(position, forceLongPositionFields(position));
position.riskGeometryRule = 'LONG: sl < entry < tp';
position.tpHitRule = 'LONG: price >= tp';
position.slHitRule = 'LONG: price <= sl';
position.grossRFormula = '(exitPrice - entry) / (entry - initialSl)';
position.currentRFormula = '(currentPrice - entry) / (entry - initialSl)';
position.updatedAt = now();
return position;
}
export function buildOpenPositionFromEntry(entry) {
assertLongInput(entry, 'BUILD_OPEN_POSITION_FROM_ENTRY');
const normalizedEntry = forceLongPositionFields(entry);
const keySymbol = storageSymbol(normalizedEntry);
const decisionSnapshot = cloneImmutableSnapshot(
normalizedEntry.entryDecisionSnapshot || normalizedEntry.temporalEntryDecisionSnapshot
);
const openedAt = safeNumber(
decisionSnapshot?.entryTs ?? normalizedEntry.entryTs,
now()
);
const entryTemporal = entryTemporalFields({
entryTs: openedAt,
marketEventClusterId: normalizedEntry.marketEventClusterId,
scannerRunId: normalizedEntry.scannerRunId,
snapshotId: normalizedEntry.snapshotId,
marketCycleId: normalizedEntry.marketCycleId
}, openedAt);
const canonicalPositionId = String(
normalizedEntry.canonicalPositionId || randomId('position_long')
).trim();
const canonicalOutcomeId = String(
normalizedEntry.canonicalOutcomeId || canonicalPositionId
).trim();
const originReference = normalizedEntry.originReference ||
normalizedEntry.candidateId || normalizedEntry.entryId || normalizedEntry.scannerCandidateId || null;

const identity = normalizeMicroIdentity(normalizedEntry);
const position = forceLongPositionFields({
...normalizedEntry,
...identity,
...buildVirtualFlags(normalizedEntry),
...entryTemporal,
canonicalPositionId,
canonicalOutcomeId,
canonicalIdentitySource: 'POSITION_CREATION_CANONICAL_ID',
originReference,
positionId: normalizedEntry.positionId || canonicalPositionId,
entryDecisionSnapshot: decisionSnapshot,
temporalEntryDecisionSnapshot: decisionSnapshot,
entryDecisionSnapshotVersion:
decisionSnapshot?.snapshotVersion || ENTRY_DECISION_SNAPSHOT_VERSION,
entryContextImmutable: true,
tradeId: normalizedEntry.tradeId || randomId('trade_long'),
symbol: normalizedEntry.symbol || keySymbol,
baseSymbol: normalizedEntry.baseSymbol || keySymbol,
contractSymbol: normalizedEntry.contractSymbol || null,
status: 'OPEN',
strategyVersion: normalizedEntry.strategyVersion || CONFIG.strategyVersion,
openedAt,
createdAt: openedAt,
updatedAt: openedAt,
initialSl: normalizedEntry.initialSl || normalizedEntry.sl,
currentR: 0,
longCurrentR: 0,
mfeR: 0,
maeR: 0,
maxTpProgress: 0,
ticksObserved: 0,
favorableTicks: 0,
adverseTicks: 0,
priceFetchFailures: 0,
lastPriceFetchFailedAt: null,
reachedHalfR: false,
reachedOneR: false,
nearTpSeen: false,
directToSL: false,
directSL: false,
beArmed: false,
beWouldExit: false,
beExitR: 0,
gaveBackAfterHalfR: false,
gaveBackAfterOneR: false,
nearTpThenLoss: false,
liveManaged: false,
beLiveApplied: false,
trailLiveApplied: false,
slManagementSource: null,
entryMarketWeather: normalizedEntry.entryMarketWeather || null,
entryCurrentRegime: normalizedEntry.entryCurrentRegime ||
normalizedEntry.currentRegime || null,
entryCurrentTrendSide: normalizedEntry.entryCurrentTrendSide ||
normalizedEntry.currentTrendSide || null,
entryCurrentFit: normalizedEntry.entryCurrentFit ?? normalizedEntry.currentFit

?? null,
entryCurrentFitConfidence: normalizedEntry.entryCurrentFitConfidence ??
normalizedEntry.currentMarketFitConfidence ?? null,
entryWeatherFitMatchedFamily: normalizedEntry.entryWeatherFitMatchedFamily ??
null,
currentFitSoftOnly: true,
currentFitBlocksLearning: false,
currentFitBlocksVirtualLearning: false,
currentFitBlocksShadowLearning: false,
currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
learningRemainsBroad: true,
temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
temporalGenerationSchemaVersion: TEMPORAL_GENERATION_SCHEMA_VERSION,
temporalTaxonomyVersion: TEMPORAL_TAXONOMY_VERSION,
temporalCostModelVersion: TEMPORAL_COST_MODEL_VERSION,
exitFillModelVersion: EXIT_FILL_MODEL_VERSION,
exitFillPolicy: 'TP_SL_USE_TRIGGER_BOUNDARY_TIME_STOP_USES_OBSERVED_PRICE',
exitFillAssumption: 'TRIGGER_BOUNDARY_PLUS_COST_MODEL',
validLongRiskShape: validLongRiskGeometry(normalizedEntry),
longRiskFormula: 'sl < entry < tp',
longGrossRFormula: '(exitPrice - entry) / (entry - initialSl)',
longCurrentRFormula: '(currentPrice - entry) / (entry - initialSl)',
riskGeometryRule: 'LONG: sl < entry < tp',
tpHitRule: 'LONG: price >= tp',
slHitRule: 'LONG: price <= sl',
grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
currentRFormula: '(currentPrice - entry) / (entry - initialSl)',
longExitRules: {
tp: 'price >= tp',
sl: 'price <= sl',
timeStop: 'TIME_STOP'
}
});
assertPositionPersistable(position);
return position;
}
async function markPriceFetchFailed(position) {
position.priceFetchFailures = safeNumber(position.priceFetchFailures, 0) + 1;
position.lastPriceFetchFailedAt = now();
position.updatedAt = now();
await saveExistingOpenPosition(forceLongPositionFields(position));
return position;
}
function isDirectSLExit({
position,
exitReason
} = {}) {
const reason = upper(exitReason);
const stoppedOut =
reason === 'SL' ||

reason === 'HIT_SL' ||
reason === 'STOP' ||
reason === 'STOP_LOSS' ||
reason === 'STOPLOSS' ||
reason === 'HARD_SL' ||
reason === 'DIRECT_SL';
if (!stoppedOut) return false;
if (
Boolean(position.nearTpSeen) ||
Boolean(position.reachedHalfR) ||
Boolean(position.reachedOneR)
) {
return false;
}
const mfeR = safeNumber(position.mfeR, 0);
const maeR = safeNumber(position.maeR, 0);
return Boolean(position.directToSL || position.directSL) ||
mfeR < 0.25 ||
maeR <= -0.8;
}
function enrichOutcomeIdentity(outcome = {}, position = {}) {
const identity = normalizeMicroIdentity(position);
const openedAt = safeNumber(position.openedAt || position.createdAt, 0);
const closedAt = safeNumber(outcome.closedAt || outcome.completedAt, now());
const ageSec = openedAt > 0 && closedAt > 0
? Math.max(0, Math.floor((closedAt - openedAt) / 1000))
: 0;
const exitReason = String(outcome.exitReason || '').toUpperCase();
const directSL = isDirectSLExit({
position,
exitReason
});
const entryTemporal = immutableEntryFields(position, openedAt || closedAt);
const exitTemporal = exitTemporalFields({ exitTs: closedAt });
const canonicalPositionId = String(position.canonicalPositionId || '').trim();
if (!canonicalPositionId) {
throw new Error('CLOSED_POSITION_CANONICAL_POSITION_ID_MISSING');
}
const canonicalOutcomeId = String(
position.canonicalOutcomeId || canonicalPositionId
).trim();
const outcomeIdentity = canonicalOutcomeId;
return forceLongPositionFields({
...outcome,
...identity,

...entryTemporal,
...exitTemporal,
source: OUTCOME_SOURCE,
outcomeSource: OUTCOME_SOURCE,
positionSource: position.source || POSITION_SOURCE,
tradeId: position.tradeId || outcome.tradeId || null,
canonicalPositionId,
canonicalOutcomeId,
canonicalIdentitySource: 'POSITION_CREATION_CANONICAL_ID',
originReference: position.originReference || outcome.originReference || null,
positionId: position.positionId || canonicalPositionId,
outcomeId: canonicalOutcomeId,
outcomeIdentity,
outcomeIdentityHashSource: 'CANONICAL_POSITION_ID_FROM_POSITION_CREATION',
activeRotationId: position.activeRotationId || null,
selectedRotationId: position.selectedRotationId || position.activeRotationId
|| null,
activeMacroFamilyId:
position.activeMacroFamilyId ||
identity.parentTrueMicroFamilyId ||
null,
selectedMacroFamilyId:
position.selectedMacroFamilyId ||
position.activeMacroFamilyId ||
identity.parentTrueMicroFamilyId ||
null,
selectedMicroFamilyAlert: Boolean(position.selectedMicroFamilyAlert),
discordAlertEligible: Boolean(position.discordAlertEligible),
selectedForDiscord: Boolean(position.selectedForDiscord ||
position.discordAlertEligible || position.selectedMicroFamilyAlert),
entryDecisionSnapshot: cloneImmutableSnapshot(position.entryDecisionSnapshot),
temporalEntryDecisionSnapshot: cloneImmutableSnapshot(
position.entryDecisionSnapshot || position.temporalEntryDecisionSnapshot
),
entryPublicationResult: cloneImmutableSnapshot(position.entryPublicationResult),
temporalPolicyAppliedToExit: false,
rotationMatchType: position.rotationMatchType || outcome.rotationMatchType ||
null,
weeklyStats: position.weeklyStats || null,
virtualOnly: true,
virtualTracked: true,
shadowOnly: false,
realTrade: false,
realOrdersDisabled: true,
bitgetOrdersDisabled: true,
realOrder: false,
exchangeOrder: false,
bitgetOrderPlaced: false,
scannerMicroFamilyId: position.scannerMicroFamilyId ||
identity.scannerMicroFamilyId || null,
scannerFamilyId: position.scannerFamilyId || identity.scannerFamilyId || null,
scannerDefinition: position.scannerDefinition || identity.scannerDefinition ||
null,
scannerDefinitionParts: Array.isArray(position.scannerDefinitionParts)
? position.scannerDefinitionParts
: identity.scannerDefinitionParts || [],
executionMicroFamilyId: position.executionMicroFamilyId ||

identity.executionMicroFamilyId || null,
executionFingerprintRole: 'METADATA_ONLY',
executionFingerprintOnlyMetadata: Boolean(position.executionMicroFamilyId ||
identity.executionMicroFamilyId),
executionFingerprintsMetadataOnly: true,
executionFingerprintsUsedAsLearningFamily: false,
scannerFingerprintRole: 'METADATA_ONLY',
scannerFingerprintOnlyMetadata: Boolean(position.scannerMicroFamilyId ||
identity.scannerMicroFamilyId),
scannerFingerprintsMetadataOnly: true,
scannerFingerprintsUsedAsLearningFamily: false,
outcomeIdentityLocked: true,
outcomeIdentitySource: 'POSITION_TRUE_MICRO_IDENTITY',
learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
exactTrueMicroFamilyRequired: true,
symbolExcludedFromFamilyId: true,
coinNameExcludedFromFamilyId: true,
hashesExcludedFromFamilyId: true,
isTrueMicro: true,
trueMicro: true,
isLegacyMacro: false,
trueMicroOnly: true,
exactTrueMicroOnly: true,
currentPrice: safeNumber(position.currentPrice ?? position.lastPrice ??
outcome.exitPrice, 0),
lastPrice: safeNumber(position.lastPrice ?? position.currentPrice ??
outcome.exitPrice, 0),
entry: safeNumber(position.entry ?? outcome.entry, 0),
sl: safeNumber(position.sl ?? outcome.sl, 0),
tp: safeNumber(position.tp ?? outcome.tp, 0),
initialSl: safeNumber(position.initialSl ?? outcome.initialSl ?? position.sl,
0),
ageSec,
currentR: safeNumber(position.currentR ?? outcome.currentR, 0),
longCurrentR: safeNumber(position.longCurrentR ?? position.currentR ??
outcome.longCurrentR ?? outcome.currentR, 0),
mfeR: safeNumber(position.mfeR ?? outcome.mfeR, 0),
maeR: safeNumber(position.maeR ?? outcome.maeR, 0),
reachedHalfR: Boolean(position.reachedHalfR || outcome.reachedHalfR),
reachedOneR: Boolean(position.reachedOneR || outcome.reachedOneR),
nearTpSeen: Boolean(position.nearTpSeen || outcome.nearTpSeen),
directToSL: directSL,
directSL,
exitFillPrice: safeNumber(outcome.exitFillPrice ?? position.exitFillPrice ??
outcome.exitPrice, 0),
exitObservedPrice: safeNumber(outcome.exitObservedPrice ??
position.exitObservedPrice ?? outcome.exitPrice, 0),

exitTriggerPrice: safeNumber(outcome.exitTriggerPrice ??
position.exitTriggerPrice, 0) || null,
exitFillSource: outcome.exitFillSource || position.exitFillSource || null,
exitFillModelVersion: outcome.exitFillModelVersion ||
position.exitFillModelVersion || EXIT_FILL_MODEL_VERSION,
triggerBoundaryFillApplied: Boolean(outcome.triggerBoundaryFillApplied ??
position.triggerBoundaryFillApplied),
observedVsFillPct: safeNumber(outcome.observedVsFillPct ??
position.observedVsFillPct, 0),
observedBeyondTriggerPct: safeNumber(outcome.observedBeyondTriggerPct ??
position.observedBeyondTriggerPct, 0),
exitFillAssumption: outcome.exitFillAssumption || position.exitFillAssumption
|| null,
exitFillPolicy: 'TP_SL_USE_TRIGGER_BOUNDARY_TIME_STOP_USES_OBSERVED_PRICE',
tpExitTriggered: exitReason === 'TP',
slExitTriggered: exitReason === 'SL',
timeStopExitTriggered: exitReason === 'TIME_STOP',
exitRuleMatched:
exitReason === 'TP'
? 'price >= tp'
: exitReason === 'SL'
? 'price <= sl'
: exitReason === 'TIME_STOP'
? 'TIME_STOP'
: null,
validLongRiskShape: validLongRiskGeometry(position),
longRiskFormula: 'sl < entry < tp',
longGrossRFormula: '(exitPrice - entry) / (entry - initialSl)',
longCurrentRFormula: '(currentPrice - entry) / (entry - initialSl)',
riskGeometryRule: 'LONG: sl < entry < tp',
tpHitRule: 'LONG: price >= tp',
slHitRule: 'LONG: price <= sl',
grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
currentRFormula: '(currentPrice - entry) / (entry - initialSl)',
entryMarketWeather: position.entryMarketWeather || outcome.entryMarketWeather
|| null,
entryCurrentRegime: position.entryCurrentRegime || position.currentRegime ||
outcome.entryCurrentRegime || outcome.currentRegime || null,
entryCurrentTrendSide: position.entryCurrentTrendSide ||
position.currentTrendSide || outcome.entryCurrentTrendSide ||
outcome.currentTrendSide || null,
entryCurrentFit: position.entryCurrentFit ?? position.currentFit ??
outcome.entryCurrentFit ?? outcome.currentFit ?? null,
entryCurrentFitConfidence: position.entryCurrentFitConfidence ??
position.currentMarketFitConfidence ?? outcome.entryCurrentFitConfidence ??
outcome.currentMarketFitConfidence ?? null,
entryWeatherFitMatchedFamily: position.entryWeatherFitMatchedFamily ??

outcome.entryWeatherFitMatchedFamily ?? null,
currentFitSoftOnly: true,
currentFitBlocksLearning: false,
currentFitBlocksVirtualLearning: false,
currentFitBlocksShadowLearning: false,
currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
learningRemainsBroad: true,
outcomeFinalizedTs: closedAt,
outcomePersistedTs: 0,
temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
temporalGenerationSchemaVersion: TEMPORAL_GENERATION_SCHEMA_VERSION,
taxonomyVersion: TEMPORAL_TAXONOMY_VERSION,
costModelVersion: TEMPORAL_COST_MODEL_VERSION,
measurementFixVersion: MEASUREMENT_FIX_VERSION,
directSLDefinition: 'SL_EXIT_WITHOUT_MEANINGFUL_MFE',
completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
scoringRSource: 'netR',
winsLossesFlatsSource: 'netR',
winrateDefinition: 'netR > 0',
avgRSource: 'netR',
totalRSource: 'netR',
avgCostRShown: true
});
}
function sanitizeExitPublicationResult(result = {}, fallbackReason = null) {
return {
exitPublicationResultVersion: EXIT_PUBLICATION_RESULT_VERSION,
ok: result?.ok === true,
sent: result?.ok === true && result?.skipped !== true,
skipped: result?.skipped === true,
failed: result?.ok === false && result?.skipped !== true,
reason: String(result?.reason || fallbackReason || '').trim() || null,
status: Number.isFinite(Number(result?.status)) ? Number(result.status) : null,
publicationType: result?.publicationType || 'DISCORD_WEBHOOK',
responseBodyStored: false,
sensitiveTransportMetadataStored: false,
temporalPolicyAppliedToExit: false,
recordedAt: now()
};
}
async function maybeSendExitAlert(position, outcome) {
if (!position.discordAlertEligible && !position.selectedMicroFamilyAlert &&
!position.selectedForDiscord) {
return sanitizeExitPublicationResult({
ok: true,
skipped: true,
reason: 'POSITION_NOT_SELECTED_FOR_DISCORD_EXIT_ALERT'
});
}
if (!isExactLongChildTrueMicroId(outcome.trueMicroFamilyId)) {
return sanitizeExitPublicationResult({
ok: true,
skipped: true,
reason: 'EXIT_ALERT_REQUIRES_EXACT_75_CHILD_TRUE_MICRO_FAMILY'
});
}
try {
const result = await sendExitAlert(outcome);
return sanitizeExitPublicationResult(result);
} catch (error) {
return sanitizeExitPublicationResult({
ok: false,
skipped: false,
reason: 'DISCORD_EXIT_ALERT_FAILED'
}, error?.message || String(error));
}
}
async function monitorOnePosition({
position,
priceFetcher,
timestamp
}) {
if (!isLongPosition(position)) {
return {
type: 'IGNORED_NON_LONG',
position,
outcome: null
};
}
if (isScannerFamilyRow(position)) {
return {
type: 'IGNORED_SCANNER_FINGERPRINT_POSITION',
position,
outcome: null
};
}
if (!isExactLongChildTrueMicroId(rowMicroId(position))) {
return {
type: 'IGNORED_NON_EXACT_75_CHILD_POSITION',
position,
outcome: null
};
}
const fetchSymbol = position.contractSymbol || position.symbol;
const price = await priceFetcher(fetchSymbol).catch(() => 0);
if (!price) {
await markPriceFetchFailed(position);
return {
type: 'NO_PRICE',
position,
outcome: null
};
}
position.priceFetchFailures = 0;
position.lastPriceFetchFailedAt = null;
let exit = detectExit({
position,
price,
timestamp

});
let exitFill = null;
if (exit.shouldExit) {
exitFill = resolveExitFill({
position,
observedPrice: price,
exitReason: exit.reason
});
// TP/SL padmetingen stoppen op de vooraf ingestelde triggerprijs.
// Daardoor kan een late monitor-tick geen kunstmatige +15R of -4R creëren.
updatePathMetrics(
position,
exitFill.exitFillPrice
);
} else {
updatePathMetrics(position, price);
// Een tweede controle bewaart TIME_STOP en eventueel aangescherpte stops.
exit = detectExit({
position,
price,
timestamp
});
if (exit.shouldExit) {
exitFill = resolveExitFill({
position,
observedPrice: price,
exitReason: exit.reason
});
}
}
if (!exit.shouldExit) {
await saveExistingOpenPosition(position);
return {
type: 'UPDATED',
position,
outcome: null
};
}
if (!exitFill) {
exitFill = resolveExitFill({
position,
observedPrice: price,
exitReason: exit.reason
});
}
const closedAt = timestamp;
const exitPrice = exitFill.exitFillPrice;

const directSL = isDirectSLExit({
position,
exitReason: exit.reason
});
const closedPosition = forceLongPositionFields({
...position,
...exitFill,
status: 'CLOSED',
closedAt,
completedAt: closedAt,
outcomeFinalizedTs: closedAt,
outcomePersistedTs: 0,
exitPrice,
exitReason: exit.reason,
exitTrigger: exit.trigger,
outcomeSource: OUTCOME_SOURCE,
source: POSITION_SOURCE,
directToSL: directSL,
directSL
});
const baseOutcome = buildOutcomeFromPosition({
position: closedPosition,
exitPrice,
exitReason: exit.reason,
source: OUTCOME_SOURCE
});
const netOutcome = applyNetCostModelToOutcome({
outcome: {
...baseOutcome,
status: 'CLOSED',
closedAt,
completedAt: closedAt,
...exitFill,
exitPrice,
exitReason: exit.reason,
exitTrigger: exit.trigger,
source: OUTCOME_SOURCE,
outcomeSource: OUTCOME_SOURCE,
directToSL: directSL,
directSL
},
position: closedPosition,
exitPrice
});
const outcome = enrichOutcomeIdentity(netOutcome, closedPosition);
const analyzeOutcome = clonePlainObject(outcome);
const discordOutcome = clonePlainObject(outcome);
const analyzeResult = await recordOutcome(analyzeOutcome, {
source: OUTCOME_SOURCE,

weekKey: PERSISTENT_LEARNING_KEY
});
const analyzeAccepted =
analyzeResult?.ok === true &&
(
analyzeResult?.skipped !== true ||
analyzeResult?.duplicate === true
);
if (!analyzeAccepted) {
const error = new Error(
analyzeResult?.reason ||
'ANALYZE_OUTCOME_NOT_ACCEPTED'
);
error.details = {
positionId: closedPosition.positionId || closedPosition.id || null,
symbol: closedPosition.symbol || closedPosition.contractSymbol || null,
trueMicroFamilyId: rowMicroId(closedPosition),
measurementFixVersion: MEASUREMENT_FIX_VERSION,
analyzeResult
};
throw error;
}
const exitPublicationResult = await maybeSendExitAlert(
closedPosition,
discordOutcome
);
await deleteOpenPosition(closedPosition.symbol ||
closedPosition.contractSymbol);
return {
type: 'EXIT',
position: {
...closedPosition,
exitPublicationResult
},
outcome: {
...discordOutcome,
analyzeOutcomeAccepted: true,
analyzeOutcomeDuplicate: Boolean(analyzeResult?.duplicate),
analyzeOutcomeId: analyzeResult?.outcomeId || null,
exitPublicationResult,
discordExitAlertResult: exitPublicationResult,
discordExitAlertSent: Boolean(exitPublicationResult.sent),
temporalPolicyAppliedToExit: false
}
};
}
export async function monitorOpenPositions({ priceFetcher } = {}) {
if (typeof priceFetcher !== 'function') {
throw new Error('PRICE_FETCHER_REQUIRED');
}
const positions = await getOpenPositions();
if (!positions.length) return [];
const cfg = tradeConfig();
const timestamp = now();
const results = await mapConcurrent(

positions,
cfg.dataConcurrency,
async (position) => monitorOnePosition({
position,
priceFetcher,
timestamp
})
);
return results
.filter((row) => row?.type === 'EXIT' && row.outcome)
.map((row) => row.outcome);
}

