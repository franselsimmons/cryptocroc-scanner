// ================= FILE: src/market/bitgetClient.js =================
import { CONFIG } from '../config.js';
import {
normalizeBaseSymbol,
normalizeContractSymbol,
safeNumber,
sleep
} from '../utils.js';
import { parseBitgetCandle } from './indicators.js';
const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const DEFAULT_RETRIES = 2;
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
const WEEKEND_MODE = 'DEFER_TO_ACTIVE_GENERATION';
const SESSION_MODE = 'DEFER_TO_ACTIVE_GENERATION';
const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = TRUE_MICRO_SCHEMA;
const LEARNING_GRANULARITY =
'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 80;
const CACHE_TTL_MS = {
tickers: 20_000,
candles: 45_000,
orderBook: 4_000,
funding: 60_000,

contracts: 10 * 60_000
};
const NON_CRYPTO_RWA_BASE_SYMBOLS = new Set([
'AAPL','AMZN','GOOG','GOOGL','META','MSFT','NVDA','TSLA','NFLX','AMD','INTC','AVGO',
'ORCL','CRM','COIN','MSTR','HOOD','PLTR','SPY','QQQ','DIA','IWM','VOO','VTI',
'ARKK','GLD','SLV','TLT','EEM','VIX','DXY','USO','SOXL','SOXS','KORU','SPCX',
'SPX','MU','MUU','SNDK','SKHY','SKHYNIX','SAMSUNG','DRAM','SNXX','NBIS','MRVL','BANK',
'CRC','CRCL','CBRS','BZ','CL','CLUS','XAU','XAG','XAUT','PAXG','WTI','BRENT',
'EUR','GBP','JPY','CHF','AUD','CAD','NZD'
]);
const MARKET_DATA_UNIT_VERSION = 'MARKET_DATA_FUTURES_OPEN24H_RWA_FAIL_CLOSED_V3';
const MARKET_PATH_PREFIXES = [
'/api/v2/mix/market/'
];
const memoryCache = new Map();
let lastRequestAt = 0;
function now() {
return Date.now();
}
function longMachineFlags() {
return {
targetTradeSide: TARGET_TRADE_SIDE,
dashboardSide: TARGET_DASHBOARD_SIDE,
scannerSide: TARGET_SCANNER_SIDE,
oppositeTradeSide: OPPOSITE_TRADE_SIDE,
longOnly: true,
shortDisabled: true,
shortOnly: false,
longDisabled: false,
virtualLearning: true,
virtualOnly: true,
virtualTracked: true,
shadowOnly: true,
realTrade: false,
realOrder: false,
exchangeOrder: false,
bitgetOrderPlaced: false,
marketDataOnly: true,
noRealOrders: true,
realOrdersDisabled: true,
bitgetOrdersDisabled: true,
exchangeOrdersDisabled: true,
exchangeTradeCallsDisabled: true,
orderPlacementDisabled: true,
scannerBullishOnly: true,

temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
weekendPolicyVersion: WEEKEND_POLICY_VERSION,
sessionPolicyVersion: SESSION_POLICY_VERSION,
temporalGenerationSchemaVersion: TEMPORAL_GENERATION_SCHEMA_VERSION,
weekendMode: WEEKEND_MODE,
sessionMode: SESSION_MODE,
sessionPolicyObservedOnly: false,
temporalPolicyModeOwner: 'TRADE_SYSTEM_ACTIVE_GENERATION',
temporalContextCalculatedHere: false,
temporalStatsOwnedHere: false,
temporalPolicyEvaluatedHere: false,
weekendLearningAllowed: true,
weekendVirtualEntryAllowed: true,
weekendDiscordEntryAllowed: true,
weekendDiscordEntryDecisionDeferred: true,
weekendExitMonitoringAllowed: true,
weekendOutcomeRecordingAllowed: true,
sessionLearningAllowed: true,
sessionVirtualEntryAllowed: true,
sessionDiscordEntryAllowed: true,
sessionDiscordEntryDecisionDeferred: true,
familyIdentityIncludesTemporalBucket: false,
scannerSearchSide: TARGET_SCANNER_SIDE,
scannerDoesNotTrade: true,
scannerDoesNotSelectMicroFamilies: true,
scannerDoesNotSendDiscord: true,
scannerDoesNotWriteLearningFamilies: true,
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
childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
parentLearningEnabled: true,
childLearningEnabled: true,
learningGranularity: LEARNING_GRANULARITY,
parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
selectionGranularity: 'EXACT_75_CHILD',
fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED',
completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',

scoringRSource: 'netR',
winsLossesFlatsSource: 'netR',
winrateDefinition: 'netR > 0',
avgRSource: 'netR',
totalRSource: 'netR',
avgCostRShown: true,
manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
discordOnlyForExactTrueMicroMatch: true,
validLongRiskShape: 'entry > 0 && sl < entry && entry < tp',
longRiskShape: 'sl < entry < tp',
riskTradeSide: TARGET_TRADE_SIDE,
riskGeometryRule: 'LONG: sl < entry < tp',
tpHitRule: 'LONG: price >= tp',
slHitRule: 'LONG: price <= initialSl',
grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
currentRFormula: '(currentPrice - entry) / (entry - initialSl)',
longGrossRFormula: '(exitPrice - entry) / (entry - initialSl)',
longCurrentRFormula: '(currentPrice - entry) / (entry - initialSl)',
currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
redisNamespace: LONG_NAMESPACE,
redisKeyPrefix: LONG_KEY_PREFIX,
persistentLearningKey: PERSISTENT_LEARNING_KEY,
redisKeysSeparatedFromShortRoot: true,
shortRootTouched: false
};
}
function bitgetConfig() {
const cfg = CONFIG.long?.bitget || CONFIG.bitget || {};
return {
baseUrl: cfg.baseUrl || 'https://api.bitget.com',
productType: cfg.productType || 'USDT-FUTURES',
timeoutMs: Math.max(500, safeNumber(cfg.timeoutMs, DEFAULT_TIMEOUT_MS)),
minRequestIntervalMs: Math.max(
0,
safeNumber(cfg.minRequestIntervalMs, DEFAULT_MIN_REQUEST_INTERVAL_MS)
),
cacheEnabled: cfg.cacheEnabled !== false,
...longMachineFlags()
};

}
function shouldLogSkippedSymbols() {
return (CONFIG.long?.bitget || CONFIG.bitget || {})?.logSkippedSymbols === true;
}
function normalizeProductType(value = bitgetConfig().productType) {
return String(value || 'USDT-FUTURES')
.trim()
.toUpperCase()
.replaceAll('_', '-');
}
function assertMarketDataPath(path) {
const value = String(path || '');
const allowed = MARKET_PATH_PREFIXES.some((prefix) => value.startsWith(prefix));
if (!allowed) {
throw new Error(`BITGET_MARKET_DATA_PATH_ONLY_${value}`);
}
}
function stableParams(params = {}) {
return Object.fromEntries(
Object.entries(params || {})
.filter(([, value]) => value !== undefined && value !== null && value !==
'')
.sort(([a], [b]) => a.localeCompare(b))
.map(([key, value]) => [key, String(value)])
);
}
function cacheKey(path, params = {}) {
return JSON.stringify({
namespace: LONG_NAMESPACE,
keyPrefix: LONG_KEY_PREFIX,
persistentLearningKey: PERSISTENT_LEARNING_KEY,
path,
params: stableParams(params)
});
}
function getCache(key) {
const cfg = bitgetConfig();
if (!cfg.cacheEnabled) return null;

const row = memoryCache.get(key);
if (!row) return null;
if (row.expiresAt <= now()) {
memoryCache.delete(key);
return null;
}
return row.value;
}
function setCache(key, value, ttlMs) {
const cfg = bitgetConfig();
if (!cfg.cacheEnabled || ttlMs <= 0) return value;
memoryCache.set(key, {
value,
expiresAt: now() + ttlMs
});
return value;
}
async function withCache(key, ttlMs, loader) {
const cached = getCache(key);
if (cached !== null && cached !== undefined) return cached;
const value = await loader();
return setCache(key, value, ttlMs);
}
function buildUrl(path, params = {}) {
assertMarketDataPath(path);
const cfg = bitgetConfig();
const url = new URL(path, cfg.baseUrl);
for (const [key, value] of Object.entries(params || {})) {
if (value === undefined || value === null || value === '') continue;
url.searchParams.set(key, String(value));
}
return url;

}
function parseJsonText(text) {
if (!text) return null;
try {
return JSON.parse(text);
} catch {
return null;
}
}
function bitgetErrorMessage(prefix, details = {}) {
return `${prefix}_${JSON.stringify({
...details,
targetTradeSide: TARGET_TRADE_SIDE,
dashboardSide: TARGET_DASHBOARD_SIDE,
marketDataOnly: true,
noRealOrders: true,
redisNamespace: LONG_NAMESPACE
}).slice(0, 500)}`;
}
function isLikelyNetworkError(error) {
const message = String(error?.message || '').toLowerCase();
return (
error?.name === 'TypeError' ||
message.includes('fetch failed') ||
message.includes('network') ||
message.includes('econnreset') ||
message.includes('etimedout')
);
}
async function paceRequest() {
const minIntervalMs = bitgetConfig().minRequestIntervalMs;
if (minIntervalMs <= 0) return;
const elapsed = now() - lastRequestAt;
const waitMs = Math.max(0, minIntervalMs - elapsed);
if (waitMs > 0) {
await sleep(waitMs);
}

lastRequestAt = now();
}
async function fetchJsonOnce(path, params = {}, timeoutMs =
bitgetConfig().timeoutMs) {
assertMarketDataPath(path);
await paceRequest();
const url = buildUrl(path, params);
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeoutMs);
try {
const response = await fetch(url, {
method: 'GET',
headers: {
accept: 'application/json',
'user-agent': CONFIG.strategyVersion ||
'LONG_ONLY_VIRTUAL_75_TRUE_MICRO_MARKET_DATA_V1'
},
signal: controller.signal
});
const text = await response.text();
const json = parseJsonText(text);
if (!response.ok) {
const error = new Error(bitgetErrorMessage(`BITGET_HTTP_${response.status}`,
{
path,
params,
body: text.slice(0, 240)
}));
error.status = response.status;
error.retryable = RETRYABLE_HTTP_STATUS.has(response.status);
throw error;
}
if (!json) {
const error = new Error(bitgetErrorMessage('BITGET_INVALID_JSON', {
path,
params,
body: text.slice(0, 240)

}));
error.retryable = false;
throw error;
}
if (json.code && json.code !== '00000') {
const error = new Error(bitgetErrorMessage(`BITGET_API_${json.code}`, {
path,
params,
msg: json.msg || json.message || 'UNKNOWN'
}));
error.code = json.code;
error.retryable = ['40010', '40725', '429'].includes(String(json.code));
throw error;
}
return json.data ?? json;
} catch (error) {
if (error?.name === 'AbortError') {
const timeoutError = new Error(bitgetErrorMessage('BITGET_TIMEOUT', {
path,
params,
timeoutMs
}));
timeoutError.retryable = true;
throw timeoutError;
}
if (isLikelyNetworkError(error)) {
error.retryable = true;
}
throw error;
} finally {
clearTimeout(timer);
}
}
async function fetchJson(path, params = {}, options = {}) {
const timeoutMs = Math.max(
500,

options.timeoutMs ?? bitgetConfig().timeoutMs
);
const retries = Math.max(0, Number(options.retries ?? DEFAULT_RETRIES) || 0);
let lastError = null;
for (let attempt = 0; attempt <= retries; attempt += 1) {
try {
return await fetchJsonOnce(path, params, timeoutMs);
} catch (error) {
lastError = error;
const retryable =
error?.retryable === true ||
RETRYABLE_HTTP_STATUS.has(Number(error?.status));
if (!retryable || attempt >= retries) break;
const baseDelayMs = safeNumber((CONFIG.long?.bitget || CONFIG.bitget ||
{})?.retryDelayMs, 250);
const jitterMs = Math.floor(Math.random() * 80);
const delayMs = baseDelayMs * (attempt + 1) + jitterMs;
await sleep(delayMs);
}
}
throw lastError;
}
export async function fetchBitgetContracts() {
const params = {
productType: normalizeProductType()
};
return withCache(
cacheKey('/api/v2/mix/market/contracts', params),
CACHE_TTL_MS.contracts,
async () => {
const data = await fetchJson('/api/v2/mix/market/contracts', params, {
retries: 1,
timeoutMs: Math.max(1500, bitgetConfig().timeoutMs)
});
return Array.isArray(data) ? data : [];
}

);
}
function isRwaBitgetContract(row = {}) {
const rwaFlag = String(
row.isRwa ??
row.rwa ??
row.isRWA ??
''
).trim().toUpperCase();
if (['YES', 'TRUE', '1', 'RWA'].includes(rwaFlag)) return true;
const realityFlag = String(
row.isReality ??
row.reality ??
row.realityType ??
''
).trim().toUpperCase();
if (['YES', 'TRUE', '1', 'STOCK', 'REALITY'].includes(realityFlag)) return true;
const base = contractBaseSymbol(row);
return NON_CRYPTO_RWA_BASE_SYMBOLS.has(base);
}
function isTradableBitgetContract(row = {}) {
if (isRwaBitgetContract(row)) return false;
const status = String(
row.status ||
row.symbolStatus ||
row.state ||
row.tradeStatus ||
''
).trim().toLowerCase();
if (!status) return true;
return !(
status.includes('off') ||
status.includes('delist') ||
status.includes('suspend') ||
status.includes('close') ||
status.includes('disabled')
);
}
function contractSymbolValue(row = {}) {
return normalizeContractSymbol(
row.symbol ||
row.instId ||
row.contractCode ||
row.symbolName ||
''
);
}
function contractBaseSymbol(row = {}) {
const directBase = normalizeBaseSymbol(
row.baseCoin ||
row.baseSymbol ||
row.coin ||
''
);
if (directBase) return directBase;
return normalizeBaseSymbol(contractSymbolValue(row));
}
function buildContractIndexes(contracts = []) {

const validSymbols = new Set();
const byBase = new Map();
for (const row of contracts) {
if (!row || typeof row !== 'object') continue;
if (!isTradableBitgetContract(row)) continue;
const contractSymbol = contractSymbolValue(row);
const base = contractBaseSymbol(row);
if (!contractSymbol) continue;
validSymbols.add(contractSymbol);
if (base && !byBase.has(base)) {
byBase.set(base, contractSymbol);
}
}
return {
validSymbols,
byBase
};
}
async function fetchContractIndexes() {
const contracts = await fetchBitgetContracts();
return buildContractIndexes(contracts);
}
export async function resolveBitgetContractSymbol(symbol) {
const requested = normalizeContractSymbol(symbol);
if (!requested) {
return {
ok: false,
requestedSymbol: symbol,
contractSymbol: '',
reason: 'EMPTY_SYMBOL'
};
}
let indexes;
try {
indexes = await fetchContractIndexes();
} catch (error) {

console.warn('BITGET_CONTRACTS_FAILED', JSON.stringify({
symbol: requested,
...longMachineFlags(),
error: error?.message || String(error)
}));
return {
ok: false,
requestedSymbol: requested,
contractSymbol: '',
reason: 'CONTRACT_LIST_UNAVAILABLE'
};
}
const requestedBase = normalizeBaseSymbol(requested);
if (indexes.validSymbols.has(requested)) {
return {
ok: true,
requestedSymbol: requested,
contractSymbol: requested,
reason: 'DIRECT_MATCH'
};
}
if (requestedBase && indexes.byBase.has(requestedBase)) {
return {
ok: true,
requestedSymbol: requested,
contractSymbol: indexes.byBase.get(requestedBase),
reason: 'BASE_MATCH'
};
}
return {
ok: false,
requestedSymbol: requested,
contractSymbol: '',
reason: 'BITGET_SYMBOL_NOT_USDT_FUTURES'
};
}
export async function isBitgetUsdtFuturesSymbol(symbol) {
const resolved = await resolveBitgetContractSymbol(symbol);
return Boolean(resolved.ok && resolved.contractSymbol);
}

function isFallingTicker(change24h) {
return safeNumber(change24h, 0) < 0;
}
function longCandidateMeta(change24h) {
const falling = isFallingTicker(change24h);
const currentFit = falling ? Math.min(100, Math.abs(safeNumber(change24h, 0))) :
-Math.min(100, Math.abs(safeNumber(change24h, 0)));
return {
side: falling ? TARGET_DASHBOARD_SIDE : 'rejected',
tradeSide: falling ? TARGET_TRADE_SIDE : 'UNKNOWN',
scannerSide: falling ? TARGET_SCANNER_SIDE : 'UNKNOWN',
actualScannerSide: falling ? TARGET_SCANNER_SIDE : 'UNKNOWN',
positionSide: falling ? TARGET_TRADE_SIDE : 'UNKNOWN',
direction: falling ? TARGET_TRADE_SIDE : 'UNKNOWN',
bullishScannerCandidate: falling,
eligibleLongCandidate: falling,
isFalling: falling,
rejectReason: falling ? null : 'NOT_BULLISH_LONG_SCANNER_ONLY',
scannerBucket: falling ? 'BULLISH_FALLING' : 'REJECTED_NOT_FALLING',
legacyScannerBucket: null,
scannerBucketRole: 'DEBUG_METADATA_ONLY',
legacy25BucketRole: 'DEBUG_METADATA_ONLY',
currentFit,
longCurrentFit: currentFit,
bullCurrentFit: currentFit,
bearishCurrentFit: -Math.abs(currentFit),
currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
scannerMicroFamilyId: null,
scannerFamilyId: null,
trueMicroFamilyId: null,
microFamilyId: null,
childTrueMicroFamilyId: null,
parentTrueMicroFamilyId: null,
coarseMicroFamilyId: null,
...longMachineFlags()
};
}
async function filterTickersToKnownContracts(tickers = []) {

let indexes;
try {
indexes = await fetchContractIndexes();
} catch (error) {
if (shouldLogSkippedSymbols()) {
console.warn('BITGET_TICKER_CONTRACT_FILTER_SKIPPED', JSON.stringify({
...longMachineFlags(),
error: error?.message || String(error)
}));
}
return tickers.filter((row) => !isRwaBitgetContract(row));
}
return tickers.filter((row) => {
const symbol = contractSymbolValue(row);
if (!symbol) return false;
return indexes.validSymbols.has(symbol) && !isRwaBitgetContract(row);
});
}
export async function fetchBitgetTickers() {
const params = {
productType: normalizeProductType()
};
return withCache(
cacheKey('/api/v2/mix/market/tickers', params),
CACHE_TTL_MS.tickers,
async () => {
const data = await fetchJson('/api/v2/mix/market/tickers', params);
const tickers = Array.isArray(data) ? data : [];
return filterTickersToKnownContracts(tickers);
}
);
}
export function parseTicker(row = {}) {
const contractSymbol = normalizeContractSymbol(
row.symbol ||
row.instId ||
row.contractCode ||
row.symbolName

);
const baseSymbol = normalizeBaseSymbol(contractSymbol);
const price = safeNumber(
row.lastPr ??
row.last ??
row.close ??
row.markPrice ??
row.indexPrice,
0
);
const baseVolume = safeNumber(
row.baseVolume ??
row.baseVol ??
row.volume ??
row.vol,
0
);
const quoteVolumeRaw = safeNumber(
row.quoteVolume ??
row.quoteVol ??
row.usdtVolume ??
row.turnover ??
row.quoteTurnover,
0
);
const quoteVolume = quoteVolumeRaw > 0
? quoteVolumeRaw
: baseVolume * price;
const open24h = safeNumber(
row.open24h ??
row.openPrice24h ??
row.open ??
row.openUtc,
0
);
const calculatedChange24h = price > 0 && open24h > 0
? ((price - open24h) / open24h) * 100
: Number.NaN;
const rawChange = safeNumber(
row.change24h ??
row.changeUtc24h ??
row.priceChangePercent ??
row.priceChange24h ??
row.chgUtc,
0
);
// Bitget USDT-futures ticker change24h is already expressed in percentage points.
// Prefer the price/open24h calculation so field-unit ambiguity cannot multiply the move twice.
const change24h = Number.isFinite(calculatedChange24h) && Math.abs(calculatedChange24h) <= 200
? calculatedChange24h
: rawChange;

return {
symbol: contractSymbol,
contractSymbol,
baseSymbol,
price,
volume24h: quoteVolume,
open24h,
change24h,
marketDataUnitVersion: MARKET_DATA_UNIT_VERSION,
source: 'BITGET_MARKET_DATA',
marketDataOnly: true,
...longCandidateMeta(change24h),
raw: row
};
}
export function normalizeGranularity(timeframe) {
const tf = String(timeframe || '15m').trim().toLowerCase();
const map = {
'1m': '1m',
'3m': '3m',
'5m': '5m',
'15m': '15m',
'30m': '30m',
'1h': '1H',
'60m': '1H',
'4h': '4H',
'1d': '1D'
};
return map[tf] || timeframe;
}
export async function fetchCandles(symbol, timeframe = '15m', limit = 100) {
const resolved = await resolveBitgetContractSymbol(symbol);
if (!resolved.ok || !resolved.contractSymbol) {
if (shouldLogSkippedSymbols()) {
console.warn('BITGET_CANDLES_SKIPPED', JSON.stringify({
symbol,
requestedSymbol: resolved.requestedSymbol,
reason: resolved.reason,
productType: normalizeProductType(),
...longMachineFlags()
}));

}
return [];
}
const contractSymbol = resolved.contractSymbol;
const granularity = normalizeGranularity(timeframe);
const safeLimit = Math.max(1, Math.min(Number(limit || 100), 1000));
const params = {
symbol: contractSymbol,
productType: normalizeProductType(),
granularity,
limit: safeLimit,
kLineType: 'MARKET'
};
return withCache(
cacheKey('/api/v2/mix/market/candles', params),
CACHE_TTL_MS.candles,
async () => {
const endpoints = [
{
path: '/api/v2/mix/market/candles',
limit: safeLimit
},
{
path: '/api/v2/mix/market/history-candles',
limit: Math.min(safeLimit, 200)
}
];
let lastError = null;
for (const endpoint of endpoints) {
try {
const raw = await fetchJson(endpoint.path, {
symbol: contractSymbol,
productType: normalizeProductType(),
granularity,
limit: endpoint.limit,
kLineType: 'MARKET'
});
const candles = (Array.isArray(raw) ? raw : [])
.map(parseBitgetCandle)
.filter(Boolean)

.sort((a, b) => a.ts - b.ts);
if (candles.length > 0) {
return candles.slice(-safeLimit);
}
} catch (error) {
lastError = error;
}
}
console.warn('BITGET_CANDLES_FAILED', JSON.stringify({
symbol: contractSymbol,
requestedSymbol: resolved.requestedSymbol,
timeframe,
...longMachineFlags(),
error: lastError?.message || 'EMPTY'
}));
return [];
}
);
}
export async function fetchOrderBook(symbol) {
const resolved = await resolveBitgetContractSymbol(symbol);
if (!resolved.ok || !resolved.contractSymbol) {
if (shouldLogSkippedSymbols()) {
console.warn('BITGET_ORDERBOOK_SKIPPED', JSON.stringify({
symbol,
requestedSymbol: resolved.requestedSymbol,
reason: resolved.reason,
productType: normalizeProductType(),
...longMachineFlags()
}));
}
return null;
}
const contractSymbol = resolved.contractSymbol;
const cacheParams = {
symbol: contractSymbol,
productType: normalizeProductType(),
limit: 100
};

return withCache(
cacheKey('/api/v2/mix/market/orderbook:merged', cacheParams),
CACHE_TTL_MS.orderBook,
async () => {
const attempts = [
{
path: '/api/v2/mix/market/merge-depth',
params: {
symbol: contractSymbol,
productType: normalizeProductType(),
precision: 'scale0',
limit: 100
}
},
{
path: '/api/v2/mix/market/orderbook',
params: {
symbol: contractSymbol,
productType: normalizeProductType(),
limit: 100
}
}
];
let lastError = null;
for (const attempt of attempts) {
try {
const data = await fetchJson(attempt.path, attempt.params, {
retries: 1
});
if (data) return data;
} catch (error) {
lastError = error;
}
}
console.warn('BITGET_ORDERBOOK_FAILED', JSON.stringify({
symbol: contractSymbol,
requestedSymbol: resolved.requestedSymbol,
resolveReason: resolved.reason,
...longMachineFlags(),
error: lastError?.message || 'EMPTY'
}));

return null;
}
);
}
function parseBookRow(row) {
if (Array.isArray(row)) {
const price = safeNumber(row[0], 0);
const qty = safeNumber(row[1], 0);
if (price <= 0 || qty <= 0) return null;
return [price, qty];
}
if (row && typeof row === 'object') {
const price = safeNumber(
row.price ??
row.px ??
row[0],
0
);
const qty = safeNumber(
row.size ??
row.qty ??
row.quantity ??
row.sz ??
row[1],
0
);
if (price <= 0 || qty <= 0) return null;
return [price, qty];
}
return null;
}
function parseBookSide(side) {
if (!Array.isArray(side)) return [];
return side
.map(parseBookRow)
.filter(Boolean);
}

function emptyOrderBookAnalysis() {
return {
bias: 'NEUTRAL',
obBias: 'NEUTRAL',
tradeSide: 'UNKNOWN',
scannerSide: 'UNKNOWN',
actualScannerSide: 'UNKNOWN',
side: 'unknown',
positionSide: 'UNKNOWN',
direction: 'UNKNOWN',
spreadPct: CONFIG.cost?.fallbackSpreadPct ?? 0.0008,
spreadBps: safeNumber(CONFIG.cost?.fallbackSpreadPct ?? 0.0008, 0) * 10_000,
depthMinUsd1p: 0,
bidDepthUsd1p: 0,
askDepthUsd1p: 0,
imbalance: 0,
orderbookImbalance: 0,
shortPressure: 0,
longPressure: 0,
mid: 0,
bestBid: 0,
bestAsk: 0,
bullishOrderBookCandidate: false,
eligibleLongCandidate: false,
rejectReason: 'ORDERBOOK_UNAVAILABLE_OR_INVALID',
currentFit: 0,
longCurrentFit: 0,
bullCurrentFit: 0,
bearishCurrentFit: 0,
currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
fetchFailed: true,
scannerBucket: 'ORDERBOOK_INVALID',
scannerBucketRole: 'DEBUG_METADATA_ONLY',
trueMicroFamilyId: null,
microFamilyId: null,
childTrueMicroFamilyId: null,

parentTrueMicroFamilyId: null,
coarseMicroFamilyId: null,
...longMachineFlags()
};
}
export function analyzeOrderBook(raw) {
const bids = parseBookSide(raw?.bids);
const asks = parseBookSide(raw?.asks);
const bestBid = safeNumber(bids[0]?.[0], 0);
const bestAsk = safeNumber(asks[0]?.[0], 0);
const mid = bestBid > 0 && bestAsk > 0
? (bestBid + bestAsk) / 2
: safeNumber(raw?.mid ?? raw?.price ?? raw?.last, 0);
if (mid <= 0 || bestBid <= 0 || bestAsk <= 0) {
return emptyOrderBookAnalysis();
}
const spreadPct = Math.max(0, (bestAsk - bestBid) / mid);
const spreadBps = spreadPct * 10_000;
const minBidPrice = mid * 0.99;
const maxAskPrice = mid * 1.01;
const bidDepth = bids.reduce((sum, [price, qty]) => {
if (price < minBidPrice) return sum;
return sum + price * qty;
}, 0);
const askDepth = asks.reduce((sum, [price, qty]) => {
if (price > maxAskPrice) return sum;
return sum + price * qty;
}, 0);
const depthTotal = bidDepth + askDepth;
const imbalance = depthTotal > 0
? (bidDepth - askDepth) / depthTotal
: 0;
const longPressure = depthTotal > 0

? (bidDepth - askDepth) / depthTotal
: 0;
const shortPressure = depthTotal > 0
? (askDepth - bidDepth) / depthTotal
: 0;
const bias =
imbalance > 0.12 ? 'BID_HEAVY' :
imbalance < -0.12 ? 'ASK_HEAVY' :
'NEUTRAL';
const longAligned = longPressure > 0.12;
const currentFit = longAligned
? Math.min(100, longPressure * 100)
: -Math.min(100, Math.abs(shortPressure) * 100);
return {
bias,
obBias: bias,
tradeSide: longAligned ? TARGET_TRADE_SIDE : 'UNKNOWN',
scannerSide: longAligned ? TARGET_SCANNER_SIDE : 'UNKNOWN',
actualScannerSide: longAligned ? TARGET_SCANNER_SIDE : 'UNKNOWN',
side: longAligned ? TARGET_DASHBOARD_SIDE : 'unknown',
positionSide: longAligned ? TARGET_TRADE_SIDE : 'UNKNOWN',
direction: longAligned ? TARGET_TRADE_SIDE : 'UNKNOWN',
spreadPct,
spreadBps,
depthMinUsd1p: Math.min(bidDepth, askDepth),
bidDepthUsd1p: bidDepth,
askDepthUsd1p: askDepth,
imbalance,
orderbookImbalance: imbalance,
shortPressure,
longPressure,
mid,
bestBid,
bestAsk,
bullishOrderBookCandidate: longAligned,
eligibleLongCandidate: longAligned,
rejectReason: longAligned ? null : 'ORDERBOOK_NOT_BULLISH_LONG_ONLY',

currentFit,
longCurrentFit: currentFit,
bullCurrentFit: currentFit,
bearishCurrentFit: -Math.abs(currentFit),
currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
fetchFailed: false,
scannerBucket: longAligned ? 'ORDERBOOK_BID_HEAVY' : 'ORDERBOOK_NOT_BULLISH',
scannerBucketRole: 'DEBUG_METADATA_ONLY',
trueMicroFamilyId: null,
microFamilyId: null,
childTrueMicroFamilyId: null,
parentTrueMicroFamilyId: null,
coarseMicroFamilyId: null,
...longMachineFlags()
};
}
export async function fetchFunding(symbol) {
const resolved = await resolveBitgetContractSymbol(symbol);
if (!resolved.ok || !resolved.contractSymbol) {
return {
rate: 0,
fetchFailed: true,
fundingBucket: 'FUNDING_SYMBOL_NOT_USDT_FUTURES',
fundingBucketRole: 'DEBUG_METADATA_ONLY',
requestedSymbol: resolved.requestedSymbol || symbol,
resolvedSymbol: null,
reason: resolved.reason,
trueMicroFamilyId: null,
microFamilyId: null,
childTrueMicroFamilyId: null,
parentTrueMicroFamilyId: null,
coarseMicroFamilyId: null,
...longMachineFlags()
};
}
const contractSymbol = resolved.contractSymbol;
const params = {

symbol: contractSymbol,
productType: normalizeProductType()
};
return withCache(
cacheKey('/api/v2/mix/market/current-fund-rate', params),
CACHE_TTL_MS.funding,
async () => {
try {
const data = await fetchJson('/api/v2/mix/market/current-fund-rate',
params, {
retries: 1
});
const row = Array.isArray(data) ? data[0] : data;
const rate = safeNumber(
row?.fundingRate ??
row?.fundRate ??
row?.rate,
0
);
const bullishFundingFit =
rate < -0.0001 ? 8 :
rate > 0.0001 ? -8 :
0;
return {
rate,
fetchFailed: false,
fundingBucket:
rate < -0.0001 ? 'FUNDING_NEG' :
rate > 0.0001 ? 'FUNDING_POS' :
'FUNDING_FLAT',
fundingBucketRole: 'DEBUG_METADATA_ONLY',
requestedSymbol: resolved.requestedSymbol,
resolvedSymbol: contractSymbol,
currentFit: bullishFundingFit,
longCurrentFit: bullishFundingFit,
bullCurrentFit: bullishFundingFit,
bearishCurrentFit: -Math.abs(bullishFundingFit),
currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
trueMicroFamilyId: null,
microFamilyId: null,

childTrueMicroFamilyId: null,
parentTrueMicroFamilyId: null,
coarseMicroFamilyId: null,
...longMachineFlags()
};
} catch (error) {
console.warn('BITGET_FUNDING_FAILED', JSON.stringify({
symbol: contractSymbol,
requestedSymbol: resolved.requestedSymbol,
...longMachineFlags(),
error: error?.message || String(error)
}));
return {
rate: 0,
fetchFailed: true,
fundingBucket: 'FUNDING_FETCH_FAILED',
fundingBucketRole: 'DEBUG_METADATA_ONLY',
requestedSymbol: resolved.requestedSymbol,
resolvedSymbol: contractSymbol,
currentFit: 0,
longCurrentFit: 0,
bullCurrentFit: 0,
bearishCurrentFit: 0,
currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
trueMicroFamilyId: null,
microFamilyId: null,
childTrueMicroFamilyId: null,
parentTrueMicroFamilyId: null,
coarseMicroFamilyId: null,
...longMachineFlags()
};
}
}
);
}

