// ================= FILE: src/market/marketWeather.js =================
import { CONFIG } from '../config.js';
import { KEYS } from '../keys.js';
import { getDurableRedis, getJson, setJson } from '../redis.js';
import { clamp, safeNumber, sideToTradeSide } from '../utils.js';
import {
buildTemporalContext,
buildMarketEventClusterId,
temporalRuntimeConfig,
TEMPORAL_CONTEXT_VERSION,
TEMPORAL_POLICY_VERSION,
WEEKEND_POLICY_VERSION,
SESSION_POLICY_VERSION,
TEMPORAL_GENERATION_SCHEMA_VERSION
} from '../analyze/scoring.js';
const MARKET_WEATHER_VERSION = 'MARKET_WEATHER_ENGINE_V1';
const MEASUREMENT_FIX_VERSION =
'LONG_MEASUREMENT_FIX_TRIGGER_BOUNDARY_EXIT_FILL_V2';
const PREVIOUS_MEASUREMENT_FIX_VERSION =
'LONG_MEASUREMENT_FIX_AVGCOST_DIRECTSL_SEEN_DEDUPE_V1';
const EXIT_FILL_MODEL_VERSION = 'LONG_TRIGGER_BOUNDARY_FILL_PLUS_COST_MODEL_V1';
const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const TARGET_SCANNER_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';
const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';
const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = TRUE_MICRO_SCHEMA;
const LEARNING_GRANULARITY =
'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
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
const SETUPS = new Set(SETUP_ORDER);
const REGIMES = new Set(REGIME_ORDER);
const CONFIRMATIONS = new Set(CONFIRMATION_PROFILE_ORDER);
const NON_CRYPTO_BASE_SYMBOLS = new Set([
'AAPL','AMZN','GOOG','GOOGL','META','MSFT','NVDA','TSLA','NFLX','AMD','INTC','AVGO',
'ORCL','CRM','COIN','MSTR','HOOD','PLTR','SPY','QQQ','DIA','IWM','VOO','VTI',
'ARKK','GLD','SLV','TLT','EEM','VIX','DXY','USO','SOXL','SOXS','KORU','SPCX',
'SPX','MU','MUU','SNDK','SKHY','SKHYNIX','SAMSUNG','DRAM','SNXX','NBIS','MRVL','BANK',
'CRC','CRCL','CBRS','BZ','CL','CLUS','XAU','XAG','XAUT','PAXG','WTI','BRENT',
'EUR','GBP','JPY','CHF','AUD','CAD','NZD'
]);
const MARKET_DATA_UNIT_VERSION = 'MARKET_DATA_FUTURES_OPEN24H_RWA_FAIL_CLOSED_V3';
const MARKET_WEATHER_NORMALIZATION_VERSION = 'LONG_MARKET_WEATHER_KNOWN_CONTEXT_FIRST_V4';
const WEATHER_REGIME = Object.freeze({
TREND: 'TREND',
CHOP: 'CHOP',
SQUEEZE: 'SQUEEZE',
UNKNOWN: 'UNKNOWN'
});
const TREND_SIDE = Object.freeze({
SHORT: 'SHORT',
LONG: 'LONG',
NEUTRAL: 'NEUTRAL',
UNKNOWN: 'UNKNOWN'
});
const FLOW_STATE = Object.freeze({
FLOW_WITH_SHORT: 'FLOW_WITH_SHORT',
FLOW_WITH_LONG: 'FLOW_WITH_LONG',
FLOW_MIXED: 'FLOW_MIXED',
FLOW_QUIET: 'FLOW_QUIET',
FLOW_UNKNOWN: 'FLOW_UNKNOWN'
});
const VOLATILITY_STATE = Object.freeze({
COMPRESSION: 'COMPRESSION',
EXPANSION: 'EXPANSION',
NOISY: 'NOISY',
NORMAL: 'NORMAL',
UNKNOWN: 'UNKNOWN'

});
const FIT_LABEL = Object.freeze({
MATCH: 'MATCH',
WEAK_MATCH: 'WEAK_MATCH',
NEUTRAL: 'NEUTRAL',
MISFIT: 'MISFIT',
UNKNOWN: 'UNKNOWN'
});
const DEFAULT_UNIVERSE_LIMIT = 100;
const DEFAULT_MIN_UNIVERSE_SIZE = 15;
const DEFAULT_STALE_AFTER_MS = 180_000;
const DEFAULT_THRESHOLDS = Object.freeze({
advancing1hPct: 0.15,
advancing24hPct: 0.5,
declining1hPct: -0.15,
declining24hPct: -0.5,
strongBullish1hPct: 1.0,
strongBullish24hPct: 4.0,
strongBearish1hPct: -1.0,
strongBearish24hPct: -4.0,
trendBreadthRatio: 0.55,
strongBreadthRatio: 0.62,
squeezeMedianAbs1hPct: 0.25,
squeezeMedianAbs24hPct: 0.8,
squeezeMedianRangePct: 0.7,
squeezeNeutralRatio: 0.5,
squeezeDispersionPct: 1.2,
chopDispersionPct: 2.8,
chopMixedBreadthMax: 0.55,
btcTrend1hPct: 0.15,
btcTrend24hPct: 0.5
});
function now() {
return Date.now();
}
export function buildTemporalContextUtc(value = Date.now(), metadata = {}) {
const context = buildTemporalContext(value);
const runtime = temporalRuntimeConfig();
const snapshotId = String(metadata.snapshotId || metadata.marketCycleId || '').trim() || null;
const marketEventClusterId = buildMarketEventClusterId({
...metadata,
snapshotId,
marketCycleId: snapshotId
}, context);
return {
...context,
...runtime,
temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
weekendPolicyVersion: WEEKEND_POLICY_VERSION,
sessionPolicyVersion: SESSION_POLICY_VERSION,
temporalGenerationSchemaVersion: TEMPORAL_GENERATION_SCHEMA_VERSION,
weekendMode: runtime.effectiveTemporalPolicyMode,
sessionMode: runtime.effectiveTemporalPolicyMode,
sessionPolicyObservedOnly: runtime.effectiveTemporalPolicyMode === 'OBSERVE',
marketEventClusterId,
marketWeatherTemporalContext: context,
marketWeatherTemporalContextVersion: TEMPORAL_CONTEXT_VERSION,
marketWeatherTemporalContextIsSnapshotMetadata: true,
entryTemporalContextAuthoritative: false,
entryContextImmutable: false,
temporalPolicyEvaluatedHere: false,
temporalWouldBlock: null,
finalDiscordEntryAllowed: null,
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
temporalMetadataSource: metadata.source || 'MARKET_WEATHER_SNAPSHOT_METADATA'
};
}
function upper(value) {
return String(value || '').trim().toUpperCase();
}
function lower(value) {
return String(value || '').trim().toLowerCase();
}
function bool(value, fallback = false) {
if (value === undefined || value === null || value === '') return fallback;
if (typeof value === 'boolean') return value;
if (typeof value === 'number') return value !== 0;
const raw = lower(value);
if (['true', '1', 'yes', 'y', 'on'].includes(raw)) return true;
if (['false', '0', 'no', 'n', 'off'].includes(raw)) return false;
return fallback;
}
function asArray(value) {
if (Array.isArray(value)) return value;
if (!value) return [];

return [value];
}
function uniqueStrings(values = []) {
return [...new Set(
asArray(values)
.flatMap((value) => Array.isArray(value) ? value : [value])
.map((value) => String(value || '').trim())
.filter(Boolean)
)];
}
function round2(value) {
return Number(safeNumber(value, 0).toFixed(2));
}
function round4(value) {
return Number(safeNumber(value, 0).toFixed(4));
}
function firstValue(...values) {
for (const value of values) {
if (value !== undefined && value !== null && value !== '') return value;
}
return null;
}
function namespacedLongKey(key, fallback) {
const raw = String(key || fallback || '').trim();
if (!raw) return `${LONG_KEY_PREFIX}MARKET:WEATHER:LATEST`;
const normalized = raw.toUpperCase();
if (
normalized.startsWith('SHORT:') ||
normalized.includes('LONG:SHORT:') ||
normalized.includes('SHORT:LONG:')
) {
throw new Error('LONG_MARKET_WEATHER_KEY_REJECTED_SHORT_NAMESPACE');
}
if (normalized.startsWith(LONG_KEY_PREFIX)) {
return `${LONG_KEY_PREFIX}${raw.slice(LONG_KEY_PREFIX.length)}`;
}
return `${LONG_KEY_PREFIX}${raw}`;
}
function configNumber(path = [], fallback) {
let cur = CONFIG;
for (const part of path) {
if (!cur || typeof cur !== 'object') return fallback;
cur = cur[part];
}

return safeNumber(cur, fallback);
}
function thresholds() {
return {
...DEFAULT_THRESHOLDS,
...(CONFIG.marketWeather?.thresholds || {}),
...(CONFIG.long?.marketWeather?.thresholds || {})
};
}
function universeLimit() {
return Math.max(
10,
Math.floor(configNumber(['long', 'marketWeather', 'universeLimit'],
configNumber(['marketWeather', 'universeLimit'], DEFAULT_UNIVERSE_LIMIT)))
);
}
function minUniverseSize() {
return Math.max(
1,
Math.floor(configNumber(['long', 'marketWeather', 'minUniverseSize'],
configNumber(['marketWeather', 'minUniverseSize'], DEFAULT_MIN_UNIVERSE_SIZE)))
);
}
function staleAfterMs() {
return Math.max(
10_000,
Math.floor(configNumber(['long', 'marketWeather', 'staleAfterMs'],
configNumber(['marketWeather', 'staleAfterMs'], DEFAULT_STALE_AFTER_MS)))
);
}
function keyCandidate(value) {
if (!value) return null;
if (typeof value === 'string') return value.trim() || null;
return null;
}
function defaultUniverseKeys() {
return uniqueStrings([
keyCandidate(KEYS.long?.market?.universeLatest),
keyCandidate(KEYS.long?.market?.universe),

keyCandidate(KEYS.long?.scan?.universeLatest),
keyCandidate(KEYS.long?.scan?.latest),
keyCandidate(KEYS.market?.longUniverseLatest),
keyCandidate(KEYS.scan?.longUniverseLatest),
keyCandidate(KEYS.scan?.longLatest),
'MARKET:UNIVERSE:LATEST',
'MARKET:SCANNER:UNIVERSE:LATEST',
'SCAN:LATEST',
'SCANNER:LATEST'
]).map((key) => namespacedLongKey(key));
}
function defaultWeatherKeys() {
return uniqueStrings([
keyCandidate(KEYS.long?.market?.weatherLatest),
keyCandidate(KEYS.long?.market?.weather),
keyCandidate(KEYS.market?.longWeatherLatest),
keyCandidate(KEYS.market?.longWeather),
'MARKET:WEATHER:LATEST'
]).map((key) => namespacedLongKey(key));
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
.replaceAll('SHORT_DISABLED_TRUE', 'LONG')
.replaceAll('SHORTDISABLED_TRUE', 'LONG')
.replaceAll('BLOCK_SHORT_TRUE', 'LONG')
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
function normalizeTradeSide(value = '') {
const raw = cleanSideText(value);
if (!raw) return 'UNKNOWN';
const direct = sideToTradeSide(raw);
if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
if (['LONG', 'BULL', 'BULLISH', 'BUY', 'BID', 'UP', 'UPSIDE',
'GREEN'].includes(raw)) {
return TARGET_TRADE_SIDE;
}
if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'ASK', 'DOWN', 'DOWNSIDE',
'RED'].includes(raw)) {
return OPPOSITE_TRADE_SIDE;
}
if (raw.includes('MICRO_LONG_') || raw.includes('TRADE_SIDE=LONG') ||
raw.includes('TRADESIDE=LONG')) {
return TARGET_TRADE_SIDE;
}
if (raw.includes('MICRO_SHORT_') || raw.includes('TRADE_SIDE=SHORT') ||
raw.includes('TRADESIDE=SHORT')) {
return OPPOSITE_TRADE_SIDE;
}
return 'UNKNOWN';
}
function normalizeWeatherRegime(value) {
const raw = upper(value);
if (raw.includes('SQUEEZE') || raw.includes('COMPRESSION')) return
WEATHER_REGIME.SQUEEZE;
if (raw.includes('TREND')) return WEATHER_REGIME.TREND;
if (raw.includes('CHOP') || raw.includes('RANGE') || raw.includes('SIDEWAYS'))
return WEATHER_REGIME.CHOP;

return WEATHER_REGIME.UNKNOWN;
}
function normalizeWeatherTrendSide(value) {
const raw = upper(value);
if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE',
'RED'].includes(raw)) return TREND_SIDE.SHORT;
if (['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'UPSIDE', 'GREEN'].includes(raw))
return TREND_SIDE.LONG;
if (['NEUTRAL', 'MIXED', 'SIDEWAYS', 'CHOP', 'FLAT'].includes(raw)) return
TREND_SIDE.NEUTRAL;
return TREND_SIDE.UNKNOWN;
}
function normalizeWeatherFlow(value) {
const raw = upper(value);
if (raw.includes('LONG') || raw.includes('BULLISH') || raw.includes('BULL'))
return FLOW_STATE.FLOW_WITH_LONG;
if (raw.includes('SHORT') || raw.includes('BEARISH') || raw.includes('BEAR'))
return FLOW_STATE.FLOW_WITH_SHORT;
if (raw.includes('QUIET')) return FLOW_STATE.FLOW_QUIET;
if (raw.includes('MIXED') || raw.includes('NEUTRAL')) return
FLOW_STATE.FLOW_MIXED;
return FLOW_STATE.FLOW_UNKNOWN;
}
function normalizeWeatherVolatilityState(value) {
const raw = upper(value);
if (raw.includes('COMPRESSION') || raw.includes('SQUEEZE') ||
raw.includes('LOW_VOL')) return VOLATILITY_STATE.COMPRESSION;
if (raw.includes('EXPANSION') || raw.includes('HIGH_VOL')) return
VOLATILITY_STATE.EXPANSION;
if (raw.includes('NOISY')) return VOLATILITY_STATE.NOISY;
if (raw.includes('NORMAL')) return VOLATILITY_STATE.NORMAL;
return VOLATILITY_STATE.UNKNOWN;
}
function trendSideForDashboard(value) {
const normalized = normalizeWeatherTrendSide(value);
if (normalized === TREND_SIDE.LONG) return 'BULL';

if (normalized === TREND_SIDE.SHORT) return 'BEAR';
if (normalized === TREND_SIDE.NEUTRAL) return 'MIXED';
return 'UNKNOWN';
}
function parseTaxonomyMicroId(id = '') {
const rawId = String(id || '').trim();
const value = upper(rawId);
const sidePrefix = value.startsWith('MICRO_LONG_')
? 'MICRO_LONG_'
: value.startsWith('MICRO_SHORT_')
? 'MICRO_SHORT_'
: null;
if (!sidePrefix) {
return {
valid: false,
selectable: false,
isParent: false,
isChild: false,
rawId
};
}
let body = value.slice(sidePrefix.length);
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
const tradeSide = sidePrefix === 'MICRO_LONG_'
? TARGET_TRADE_SIDE
: OPPOSITE_TRADE_SIDE;
const sideName = tradeSide === TARGET_TRADE_SIDE
? 'LONG'
: 'SHORT';
const parentId = setup && regime
? `MICRO_${sideName}_${setup}_${regime}`
: null;
const childId = parentId && confirmationProfile
? `${parentId}_${confirmationProfile}`
: null;
const validParent =
Boolean(parentId) &&
SETUPS.has(setup) &&
REGIMES.has(regime);
const validChild =
validParent &&
Boolean(confirmationProfile) &&
CONFIRMATIONS.has(confirmationProfile);
return {
valid: validParent || validChild,
selectable: validChild,
isParent: validParent && !validChild,
isChild: validChild,
rawId,
tradeSide,
sideName,
setup,
regime,
confirmationProfile,
parentTrueMicroFamilyId: validParent ? parentId : null,
trueMicroFamilyId: validChild ? childId : validParent ? parentId : null,
childTrueMicroFamilyId: validChild ? childId : null,
trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,

parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
learningGranularity: LEARNING_GRANULARITY,
parentLearningGranularity: PARENT_LEARNING_GRANULARITY
};
}
function microIdFromRow(row = {}) {
return String(
row.trueMicroFamilyId ||
row.childTrueMicroFamilyId ||
row.microFamilyId ||
row.analyzeMicroFamilyId ||
row.learningMicroFamilyId ||
row.id ||
row.key ||
''
).trim();
}
function normalizeSymbol(value = '') {
return upper(value)
.replace(/[^A-Z0-9]+/g, '')
.replace(/PERP$/g, '')
.replace(/SWAP$/g, '');
}
function tickerSymbol(row = {}) {
return normalizeSymbol(
row.symbol ||
row.contractSymbol ||
row.baseSymbol ||
row.instId ||
row.pair ||
row.market ||
row.id ||
''
);
}
function safePercent(value, fallback = 0) {
const n = safeNumber(value, fallback);
if (!Number.isFinite(n)) return fallback;
return n;
}

function normalizeChangePct(...values) {
const value = firstValue(...values);
if (value === null) return 0;
const n = safePercent(value, 0);
if (Math.abs(n) <= 1 && String(value).includes('%') === false) {
return n * 100;
}
return n;
}
function normalizeTicker(row = {}) {
const symbol = tickerSymbol(row);
const baseSymbol = normalizeSymbol(row.baseSymbol || symbol.replace(/USDT$|USDC$|USD$/g, ''));
const percentPoint = (value, fallback = 0) => {
if (value === undefined || value === null || value === '') return fallback;
const parsed = Number(String(value).replace('%', '').trim());
return Number.isFinite(parsed) ? parsed : fallback;
};
const ratioToPct = (value, fallback = 0) => {
if (value === undefined || value === null || value === '') return fallback;
const parsed = Number(String(value).replace('%', '').trim());
if (!Number.isFinite(parsed)) return fallback;
return String(value).includes('%') ? parsed : Math.abs(parsed) <= 1 ? parsed * 100 : parsed;
};
const direct1h = firstValue(row.change1h, row.change1hPct, row.priceChange1hPct, row.pctChange1h);
const direct24h = firstValue(row.change24h, row.change24hPct, row.priceChange24hPct, row.priceChangePercent, row.pctChange24h);
const change1h = direct1h !== null
? percentPoint(direct1h, 0)
: ratioToPct(firstValue(row.return1h, row.ret1h), 0);
const change24h = direct24h !== null
? percentPoint(direct24h, 0)
: ratioToPct(firstValue(row.return24h, row.ret24h), 0);
const rangePct = percentPoint(firstValue(row.rangePct, row.range24hPct, row.dailyRangePct, row.highLowRangePct), 0);
const atrPct = percentPoint(firstValue(row.atrPct, row.atrPercent, row.atrPct14), 0);
const realizedVolPct = percentPoint(firstValue(row.realizedVolPct, row.realizedVolatilityPct, row.volatilityPct), 0);
const quoteVolume = safeNumber(
row.quoteVolume ?? row.quoteVolume24h ?? row.turnover24h ?? row.volumeUsd ?? row.volumeUSDT,
0
);
const baseVolume = safeNumber(row.volume ?? row.baseVolume ?? row.volume24h, 0);
const raw = row.raw && typeof row.raw === 'object' ? row.raw : {};
const explicitNonCrypto = row.cryptoBreadthEligible === false ||
String(row.instrumentClass || '').toUpperCase().includes('NON_CRYPTO') ||
['YES','TRUE','1','RWA'].includes(String(row.isRwa ?? raw.isRwa ?? '').trim().toUpperCase()) ||
['YES','TRUE','1','STOCK','REALITY'].includes(String(row.isReality ?? raw.isReality ?? '').trim().toUpperCase());
const cryptoBreadthEligible = !explicitNonCrypto && !NON_CRYPTO_BASE_SYMBOLS.has(baseSymbol);
return {
raw: row,
symbol,
baseSymbol,
instrumentClass: cryptoBreadthEligible ? 'CRYPTO' : 'NON_CRYPTO_TOKENIZED',
cryptoBreadthEligible,
change1h,
change24h,
absChange1h: Math.abs(change1h),
absChange24h: Math.abs(change24h),
rangePct,
atrPct,
realizedVolPct,
marketDataUnitVersion: MARKET_DATA_UNIT_VERSION,
quoteVolume,
baseVolume,
spreadPct: safeNumber(row.spreadPct ?? row.spread ?? row.bidAskSpreadPct, 0),
updatedAt: safeNumber(row.updatedAt ?? row.ts ?? row.timestamp, 0),
marketDataUnitVersion: MARKET_DATA_UNIT_VERSION
};
}
function extractTickerRows(input) {
if (!input) return [];
if (Array.isArray(input)) return input;

if (Array.isArray(input.tickers)) return input.tickers;
if (Array.isArray(input.rows)) return input.rows;
if (Array.isArray(input.universe)) return input.universe;
if (Array.isArray(input.candidates)) return input.candidates;
if (Array.isArray(input.markets)) return input.markets;
if (Array.isArray(input.data)) return input.data;
if (input.tickers && typeof input.tickers === 'object') return
Object.values(input.tickers);
if (input.rows && typeof input.rows === 'object') return
Object.values(input.rows);
if (input.universe && typeof input.universe === 'object') return
Object.values(input.universe);
if (input.candidates && typeof input.candidates === 'object') return
Object.values(input.candidates);
return [];
}
function median(values = []) {
const clean = values
.map((value) => safeNumber(value, null))
.filter((value) => Number.isFinite(value))
.sort((a, b) => a - b);
if (!clean.length) return 0;
const mid = Math.floor(clean.length / 2);
return clean.length % 2
? clean[mid]
: (clean[mid - 1] + clean[mid]) / 2;
}
function mean(values = []) {
const clean = values
.map((value) => safeNumber(value, null))
.filter((value) => Number.isFinite(value));
if (!clean.length) return 0;
return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}
function percentile(values = [], pct = 0.5) {
const clean = values

.map((value) => safeNumber(value, null))
.filter((value) => Number.isFinite(value))
.sort((a, b) => a - b);
if (!clean.length) return 0;
const index = clamp((clean.length - 1) * pct, 0, clean.length - 1);
const lo = Math.floor(index);
const hi = Math.ceil(index);
if (lo === hi) return clean[lo];
const weight = index - lo;
return clean[lo] * (1 - weight) + clean[hi] * weight;
}
function dispersion(values = []) {
const p75 = percentile(values, 0.75);
const p25 = percentile(values, 0.25);
return Math.abs(p75 - p25);
}
function topByLiquidity(rows = [], limit = DEFAULT_UNIVERSE_LIMIT) {
return [...rows]
.filter((row) => row.symbol)
.sort((a, b) => (
safeNumber(b.quoteVolume, 0) - safeNumber(a.quoteVolume, 0) ||
safeNumber(b.baseVolume, 0) - safeNumber(a.baseVolume, 0) ||
String(a.symbol).localeCompare(String(b.symbol))
))
.slice(0, Math.max(1, Math.floor(limit)));
}
function findBtcTicker(rows = []) {
return rows.find((row) => (
row.symbol === 'BTCUSDT' ||
row.symbol === 'BTCUSD' ||
row.symbol === 'BTCUSDC' ||
row.baseSymbol === 'BTC'
)) || null;
}
function classifyBtcTrendSide(btc = null, t = thresholds()) {
if (!btc) return TREND_SIDE.UNKNOWN;

if (btc.change1h > t.btcTrend1hPct && btc.change24h > t.btcTrend24hPct) {
return TREND_SIDE.LONG;
}
if (btc.change1h < -t.btcTrend1hPct && btc.change24h < -t.btcTrend24hPct) {
return TREND_SIDE.SHORT;
}
return TREND_SIDE.NEUTRAL;
}
function classifyTickerDirection(row, t = thresholds()) {
const advancing = row.change1h > t.advancing1hPct && row.change24h >
t.advancing24hPct;
const declining = row.change1h < t.declining1hPct && row.change24h <
t.declining24hPct;
const strongBullish = row.change1h > t.strongBullish1hPct || row.change24h >
t.strongBullish24hPct;
const strongBearish = row.change1h < t.strongBearish1hPct || row.change24h <
t.strongBearish24hPct;
return {
advancing,
declining,
neutral: !advancing && !declining,
strongBearish,
strongBullish
};
}
function classifyVolatilityState({
medianAbs1h,
medianAbs24h,
medianRangePct,
change24hDispersion,
neutralRatio,
trendDominance
}, t = thresholds()) {
const squeeze =
medianAbs1h <= t.squeezeMedianAbs1hPct &&
medianAbs24h <= t.squeezeMedianAbs24hPct &&
medianRangePct <= t.squeezeMedianRangePct &&
neutralRatio >= t.squeezeNeutralRatio &&
change24hDispersion <= t.squeezeDispersionPct;
if (squeeze) return VOLATILITY_STATE.COMPRESSION;

const noisy =
change24hDispersion >= t.chopDispersionPct &&
trendDominance <= t.chopMixedBreadthMax;
if (noisy) return VOLATILITY_STATE.NOISY;
const expansion =
medianAbs1h > t.squeezeMedianAbs1hPct * 2 ||
medianAbs24h > t.squeezeMedianAbs24hPct * 2 ||
medianRangePct > t.squeezeMedianRangePct * 2;
if (expansion) return VOLATILITY_STATE.EXPANSION;
return VOLATILITY_STATE.NORMAL;
}
function confidenceFromSignals({
sampleSize,
cacheHealthy,
btcTrendSide,
advanceRatio,
declineRatio,
neutralRatio,
strongBearishRatio,
strongBullishRatio,
medianChange1h,
medianChange24h,
volatilityState,
currentRegime,
currentTrendSide
}) {
let confidence = 0;
confidence += Math.min(25, Math.sqrt(Math.max(0, sampleSize)) * 3);
if (cacheHealthy) confidence += 10;
if (btcTrendSide !== TREND_SIDE.UNKNOWN) confidence += 10;
const breadthDominance = Math.max(advanceRatio, declineRatio);
confidence += clamp((breadthDominance - 0.5) * 80, 0, 25);
const strongDominance = Math.max(strongBearishRatio, strongBullishRatio);
confidence += clamp(strongDominance * 50, 0, 15);
const directionalMedian =
Math.abs(medianChange1h) > 0.1 ||
Math.abs(medianChange24h) > 0.3;

if (directionalMedian) confidence += 8;
if (currentRegime === WEATHER_REGIME.SQUEEZE && volatilityState ===
VOLATILITY_STATE.COMPRESSION) {
confidence += 12;
}
if (currentRegime === WEATHER_REGIME.TREND && currentTrendSide !==
TREND_SIDE.NEUTRAL) {
confidence += 12;
}
if (currentRegime === WEATHER_REGIME.CHOP && neutralRatio > 0.35) {
confidence += 6;
}
return Math.round(clamp(confidence, 0, 100));
}
function classifyWeatherFromBreadth({
sampleSize,
cacheHealthy,
advancingCount,
decliningCount,
neutralCount,
strongBearishCount,
strongBullishCount,
medianChange1h,
medianChange24h,
medianAbs1h,
medianAbs24h,
medianRangePct,
change24hDispersion,
btcTrendSide
}, t = thresholds()) {
const advanceRatio = sampleSize > 0 ? advancingCount / sampleSize : 0;
const declineRatio = sampleSize > 0 ? decliningCount / sampleSize : 0;
const neutralRatio = sampleSize > 0 ? neutralCount / sampleSize : 0;
const strongBearishRatio = sampleSize > 0 ? strongBearishCount / sampleSize : 0;
const strongBullishRatio = sampleSize > 0 ? strongBullishCount / sampleSize : 0;
const trendDominance = Math.max(advanceRatio, declineRatio);
const volatilityState = classifyVolatilityState({
medianAbs1h,
medianAbs24h,
medianRangePct,

change24hDispersion,
neutralRatio,
trendDominance
}, t);
const squeeze =
volatilityState === VOLATILITY_STATE.COMPRESSION;
if (squeeze) {
const confidence = confidenceFromSignals({
sampleSize,
cacheHealthy,
btcTrendSide,
advanceRatio,
declineRatio,
neutralRatio,
strongBearishRatio,
strongBullishRatio,
medianChange1h,
medianChange24h,
volatilityState,
currentRegime: WEATHER_REGIME.SQUEEZE,
currentTrendSide: TREND_SIDE.NEUTRAL
});
return {
currentRegime: WEATHER_REGIME.SQUEEZE,
currentTrendSide: TREND_SIDE.NEUTRAL,
currentBtcRelation: btcTrendSide === TREND_SIDE.UNKNOWN ? 'BTC_UNKNOWN' :
'BTC_MIXED',
currentFlow: FLOW_STATE.FLOW_MIXED,
currentVolatilityState: volatilityState,
confidence
};
}
const longTrend =
btcTrendSide === TREND_SIDE.LONG &&
advanceRatio >= t.trendBreadthRatio &&
medianChange1h > 0 &&
medianChange24h > 0 &&
strongBullishCount >= strongBearishCount;
if (longTrend) {
const confidence = confidenceFromSignals({
sampleSize,
cacheHealthy,

btcTrendSide,
advanceRatio,
declineRatio,
neutralRatio,
strongBearishRatio,
strongBullishRatio,
medianChange1h,
medianChange24h,
volatilityState,
currentRegime: WEATHER_REGIME.TREND,
currentTrendSide: TREND_SIDE.LONG
});
return {
currentRegime: WEATHER_REGIME.TREND,
currentTrendSide: TREND_SIDE.LONG,
currentBtcRelation: 'BTC_WITH_LONG',
currentFlow: FLOW_STATE.FLOW_WITH_LONG,
currentVolatilityState: volatilityState,
confidence
};
}
const shortTrend =
btcTrendSide === TREND_SIDE.SHORT &&
declineRatio >= t.trendBreadthRatio &&
medianChange1h < 0 &&
medianChange24h < 0 &&
strongBearishCount >= strongBullishCount;
if (shortTrend) {
const confidence = confidenceFromSignals({
sampleSize,
cacheHealthy,
btcTrendSide,
advanceRatio,
declineRatio,
neutralRatio,
strongBearishRatio,
strongBullishRatio,
medianChange1h,
medianChange24h,
volatilityState,
currentRegime: WEATHER_REGIME.TREND,
currentTrendSide: TREND_SIDE.SHORT
});

return {
currentRegime: WEATHER_REGIME.TREND,
currentTrendSide: TREND_SIDE.SHORT,
currentBtcRelation: 'BTC_AGAINST_LONG',
currentFlow: FLOW_STATE.FLOW_WITH_SHORT,
currentVolatilityState: volatilityState,
confidence
};
}
const confidence = confidenceFromSignals({
sampleSize,
cacheHealthy,
btcTrendSide,
advanceRatio,
declineRatio,
neutralRatio,
strongBearishRatio,
strongBullishRatio,
medianChange1h,
medianChange24h,
volatilityState,
currentRegime: WEATHER_REGIME.CHOP,
currentTrendSide: TREND_SIDE.NEUTRAL
});
return {
currentRegime: WEATHER_REGIME.CHOP,
currentTrendSide: TREND_SIDE.NEUTRAL,
currentBtcRelation: btcTrendSide === TREND_SIDE.UNKNOWN
? 'BTC_UNKNOWN'
: btcTrendSide === TREND_SIDE.LONG
? 'BTC_MIXED_LONG'
: btcTrendSide === TREND_SIDE.SHORT
? 'BTC_MIXED_SHORT'
: 'BTC_MIXED',
currentFlow: FLOW_STATE.FLOW_MIXED,
currentVolatilityState: volatilityState,
confidence
};
}
function currentFitLabels() {
return [
FIT_LABEL.MATCH,
FIT_LABEL.WEAK_MATCH,
FIT_LABEL.NEUTRAL,

FIT_LABEL.MISFIT,
FIT_LABEL.UNKNOWN
];
}
function longModeFlags() {
const runtime = temporalRuntimeConfig();
return {
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
...runtime,
temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
weekendPolicyVersion: WEEKEND_POLICY_VERSION,
sessionPolicyVersion: SESSION_POLICY_VERSION,
temporalGenerationSchemaVersion: TEMPORAL_GENERATION_SCHEMA_VERSION,
weekendMode: runtime.effectiveTemporalPolicyMode,
sessionMode: runtime.effectiveTemporalPolicyMode,
sessionPolicyObservedOnly: runtime.effectiveTemporalPolicyMode === 'OBSERVE',
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
marketWeatherTemporalContextIsSnapshotMetadata: true,
entryTemporalContextAuthoritative: false,
temporalPolicyEvaluatedHere: false,
familyIdentityIncludesTemporalBucket: false,
virtualOnly: true,
virtualLearning: true,
virtualTracked: true,
shadowOnly: true,
realTrade: false,
realOrder: false,

exchangeOrder: false,
bitgetOrderPlaced: false,
noRealOrders: true,
realOrdersDisabled: true,
exchangeOrdersDisabled: true,
bitgetOrdersDisabled: true,
exchangeCallsDisabled: true,
noExchangeOrders: true,
riskTradeSide: TARGET_TRADE_SIDE,
longRiskShape: 'sl < entry < tp',
validLongRiskShape: 'entry > 0 && sl < entry && entry < tp',
validLongGeometry: 'sl < entry < tp',
riskGeometryRule: 'LONG: sl < entry < tp',
tpHitRule: 'LONG: price >= tp',
slHitRule: 'LONG: price <= initialSl',
grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
currentRFormula: '(currentPrice - entry) / (entry - initialSl)',
longGrossRFormula: '(exitPrice - entry) / (entry - initialSl)',
longCurrentRFormula: '(currentPrice - entry) / (entry - initialSl)',
longExitRules: {
tp: 'price >= tp',
sl: 'price <= initialSl',
timeStop: 'TIME_STOP'
},
currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
redisNamespace: LONG_NAMESPACE,
redisKeyPrefix: LONG_KEY_PREFIX,
persistentLearningKey: PERSISTENT_LEARNING_KEY,
redisKeysSeparatedFromShortRoot: true,
shortRootTouched: false
};
}
function emptyWeather({
reason = 'NO_UNIVERSE',
source = 'EMPTY_INPUT',
sourceKey = null
} = {}) {
const ts = now();
return {
ok: false,
available: false,

version: MARKET_WEATHER_VERSION,
reason,
source,
sourceKey,
generatedAt: ts,
updatedAt: ts,
currentRegime: WEATHER_REGIME.UNKNOWN,
regime: WEATHER_REGIME.UNKNOWN,
currentTrendSide: TREND_SIDE.UNKNOWN,
trendSide: 'UNKNOWN',
marketTrendSide: 'UNKNOWN',
currentBtcRelation: 'BTC_UNKNOWN',
currentFlow: FLOW_STATE.FLOW_UNKNOWN,
flow: FLOW_STATE.FLOW_UNKNOWN,
currentVolatilityState: VOLATILITY_STATE.UNKNOWN,
volatilityState: VOLATILITY_STATE.UNKNOWN,
currentMarketFitConfidence: 0,
confidence: 0,
weatherConfidence: 0,
cacheHealthy: false,
cacheStale: true,
sampleSize: 0,
universeSize: 0,
count: 0,
universeCount: 0,
breadth: {
advancingCount: 0,
decliningCount: 0,
neutralCount: 0,
strongBearishCount: 0,
strongBullishCount: 0,
advanceRatio: 0,
declineRatio: 0,
neutralRatio: 0,
strongBearishRatio: 0,
strongBullishRatio: 0,
medianChange1h: 0,
medianChange24h: 0,
medianAbs1h: 0,

medianAbs24h: 0,
medianRangePct: 0,
change24hDispersion: 0
},
currentMarketWeatherKey: 'UNKNOWN',
marketWeatherKey: 'UNKNOWN',
btcRouterState: 'UNKNOWN',
btcState: 'UNKNOWN',
btcDirection: 'UNKNOWN',
btcTrendSide: 'UNKNOWN',
bullishPct: 0,
bearishPct: 0,
neutralPct: 0,
btc: {
symbol: null,
change1h: 0,
change24h: 0,
trendSide: TREND_SIDE.UNKNOWN
},
thresholds: thresholds(),
currentFitLabels: currentFitLabels(),
softOnly: true,
blocksLearning: false,
currentFitSoftOnly: true,
currentFitBlocksLearning: false,
currentFitBlocksVirtualLearning: false,
currentFitBlocksShadowLearning: false,
learningRemainsBroad: true,
selectionWillBeAdaptive: true,
discordWillBeStrict: true,
adaptiveLayerBuilt: false,
adaptiveScoreBuilt: false,
recentMomentumScoreBuilt: false,
currentFitScoreBuilt: false,
parentDiversificationBuilt: false,
measurementFixVersion: MEASUREMENT_FIX_VERSION,
previousMeasurementFixVersion: PREVIOUS_MEASUREMENT_FIX_VERSION,
exitFillModelVersion: EXIT_FILL_MODEL_VERSION,
avgCostRRequiredBeforeAdaptiveSelection: true,
directSLRequiredBeforeAdaptiveSelection: true,
observationDedupeRequiredBeforeAdaptiveSelection: true,
...buildTemporalContextUtc(ts, { source: 'EMPTY_MARKET_WEATHER' }),
...longModeFlags()
};
}
function btcRouterStateFromTrendSide(value = '') {
const side = normalizeWeatherTrendSide(value);
if (side === TREND_SIDE.LONG) return 'BULLISH';
if (side === TREND_SIDE.SHORT) return 'BEARISH';
if (side === TREND_SIDE.NEUTRAL) return 'NEUTRAL';
return 'UNKNOWN';
}
function firstKnownWeatherValue(normalizer, ...values) {
for (const value of values) {
const normalized = normalizer(value);
if (normalized !== 'UNKNOWN') return normalized;
}
return 'UNKNOWN';
}
function firstKnownBtcRouterState(...values) {
return firstKnownWeatherValue(btcRouterStateFromTrendSide, ...values);
}
function firstKnownBtcDirection(...values) {
return firstKnownWeatherValue(normalizeWeatherTrendSide, ...values);
}
function normalizeMarketWeatherPayload(weather = {}) {
if (!weather || typeof weather !== 'object') {
return emptyWeather({
reason: 'INVALID_WEATHER_PAYLOAD',
source: 'NORMALIZE_MARKET_WEATHER'

});
}
const currentRegime = firstKnownWeatherValue(
normalizeWeatherRegime,
weather.currentRegime,
weather.regime,
weather.marketRegime,
weather.breadthRegime,
weather.volatilityRegime
);
const currentTrendSide = firstKnownWeatherValue(
normalizeWeatherTrendSide,
weather.currentTrendSide,
weather.trendSide,
weather.marketTrendSide,
weather.marketSide,
weather.side,
weather.direction,
weather.breadthSide
);
const currentFlow = normalizeWeatherFlow(weather.currentFlow || weather.flow);
const currentVolatilityState =
normalizeWeatherVolatilityState(weather.currentVolatilityState ||
weather.volatilityState);
const confidence =
Math.round(clamp(safeNumber(weather.currentMarketFitConfidence ??
weather.confidence ?? weather.weatherConfidence, 0), 0, 100));
const sampleSize = safeNumber(
weather.sampleSize ??
weather.count ??
weather.universeCount,
0
);
const generatedAt = safeNumber(weather.generatedAt || weather.updatedAt ||
weather.savedAt || weather.completedAt || 0, 0);
const ageMs = generatedAt > 0 ? Math.max(0, now() - generatedAt) : null;
const cacheStale = ageMs !== null ? ageMs > staleAfterMs() :
bool(weather.cacheStale, false);
const bearishPctRaw = safeNumber(weather.bearishPct, null);
const bullishPctRaw = safeNumber(weather.bullishPct, null);
const neutralPctRaw = safeNumber(weather.neutralPct, null);
const advanceRatio = weather.breadth?.advanceRatio !== undefined
? safeNumber(weather.breadth.advanceRatio, 0)
: Number.isFinite(bullishPctRaw)
? bullishPctRaw / 100
: 0;
const declineRatio = weather.breadth?.declineRatio !== undefined
? safeNumber(weather.breadth.declineRatio, 0)
: Number.isFinite(bearishPctRaw)
? bearishPctRaw / 100
: 0;
const neutralRatio = weather.breadth?.neutralRatio !== undefined
? safeNumber(weather.breadth.neutralRatio, 0)
: Number.isFinite(neutralPctRaw)

? neutralPctRaw / 100
: 0;
const normalized = {
...weather,
ok: weather.ok !== false && sampleSize > 0,
available: weather.available !== false && sampleSize > 0,
version: weather.version || MARKET_WEATHER_VERSION,
marketWeatherNormalizationVersion: MARKET_WEATHER_NORMALIZATION_VERSION,
currentRegime,
regime: currentRegime,
currentTrendSide,
trendSide: trendSideForDashboard(currentTrendSide),
marketTrendSide: trendSideForDashboard(currentTrendSide),
currentFlow,
flow: currentFlow,
currentVolatilityState,
volatilityState: currentVolatilityState,
currentMarketFitConfidence: confidence,
confidence,
weatherConfidence: confidence,
cacheHealthy: bool(weather.cacheHealthy, sampleSize >= minUniverseSize()),
cacheStale,
ageMs,
sampleSize,
universeSize: safeNumber(weather.universeSize ?? weather.universeCount ??
weather.count, sampleSize),
count: sampleSize,
universeCount: sampleSize,
breadth: {
advancingCount: safeNumber(weather.breadth?.advancingCount ??
weather.bullishCount, 0),
decliningCount: safeNumber(weather.breadth?.decliningCount ??
weather.bearishCount, 0),
neutralCount: safeNumber(weather.breadth?.neutralCount ??
weather.neutralCount, 0),
strongBearishCount: safeNumber(weather.breadth?.strongBearishCount, 0),
strongBullishCount: safeNumber(weather.breadth?.strongBullishCount, 0),

advanceRatio: round4(advanceRatio),
declineRatio: round4(declineRatio),
neutralRatio: round4(neutralRatio),
strongBearishRatio: safeNumber(weather.breadth?.strongBearishRatio, 0),
strongBullishRatio: safeNumber(weather.breadth?.strongBullishRatio, 0),
medianChange1h: safeNumber(weather.breadth?.medianChange1h, 0),
medianChange24h: safeNumber(weather.breadth?.medianChange24h, 0),
medianAbs1h: safeNumber(weather.breadth?.medianAbs1h, 0),
medianAbs24h: safeNumber(weather.breadth?.medianAbs24h, 0),
medianRangePct: safeNumber(weather.breadth?.medianRangePct, 0),
meanChange1h: safeNumber(weather.breadth?.meanChange1h, 0),
meanChange24h: safeNumber(weather.breadth?.meanChange24h, 0),
change24hDispersion: safeNumber(weather.breadth?.change24hDispersion, 0)
},
btcRouterState: firstKnownBtcRouterState(
weather.btcRouterState,
weather.currentBtcRouterState,
weather.btcState,
weather.btc?.btcRouterState,
weather.btc?.btcState,
weather.btc?.state,
weather.btc?.trendSide,
weather.btc?.direction,
weather.btcTrendSide,
weather.btcDirection
),
btcState: firstKnownBtcRouterState(
weather.btcState,
weather.btcRouterState,
weather.currentBtcRouterState,
weather.btc?.btcState,
weather.btc?.btcRouterState,
weather.btc?.state,
weather.btc?.trendSide,
weather.btc?.direction,
weather.btcTrendSide,
weather.btcDirection
),
btcDirection: firstKnownBtcDirection(
weather.btcDirection,
weather.btcTrendSide,
weather.btc?.direction,
weather.btc?.trendSide,
weather.btcState,
weather.btcRouterState
),
btcTrendSide: firstKnownBtcDirection(
weather.btcTrendSide,
weather.btcDirection,
weather.btc?.trendSide,
weather.btc?.direction,
weather.btcState,
weather.btcRouterState
),
currentMarketWeatherKey: currentRegime !== WEATHER_REGIME.UNKNOWN && currentTrendSide !== TREND_SIDE.UNKNOWN
? `${currentRegime}|${currentTrendSide}`
: 'UNKNOWN',
marketWeatherKey: currentRegime !== WEATHER_REGIME.UNKNOWN && currentTrendSide !== TREND_SIDE.UNKNOWN
? `${currentRegime}|${currentTrendSide}`
: 'UNKNOWN',
bullishPct: round4(advanceRatio * 100),
bearishPct: round4(declineRatio * 100),
neutralPct: round4(neutralRatio * 100),
btc: {
symbol: weather.btc?.symbol || 'BTCUSDT',
change1h: safeNumber(weather.btc?.change1h ?? weather.btcChange1h, 0),
change24h: safeNumber(weather.btc?.change24h ?? weather.btcChange24h, 0),
trendSide: firstKnownBtcDirection(
weather.btc?.trendSide,
weather.btc?.direction,
weather.btcTrendSide,
weather.btcDirection,
weather.btcState,
weather.btcRouterState
),
direction: firstKnownBtcDirection(
weather.btc?.direction,
weather.btc?.trendSide,
weather.btcDirection,
weather.btcTrendSide,
weather.btcState,
weather.btcRouterState
),
state: firstKnownBtcRouterState(
weather.btc?.state,
weather.btc?.btcState,
weather.btc?.btcRouterState,
weather.btc?.trendSide,
weather.btc?.direction,
weather.btcState,
weather.btcRouterState
),
btcState: firstKnownBtcRouterState(
weather.btc?.btcState,
weather.btc?.btcRouterState,
weather.btc?.state,
weather.btc?.trendSide,
weather.btc?.direction,
weather.btcState,
weather.btcRouterState
),
btcRouterState: firstKnownBtcRouterState(
weather.btc?.btcRouterState,
weather.btc?.btcState,
weather.btc?.state,
weather.btc?.trendSide,
weather.btc?.direction,
weather.btcRouterState,
weather.btcState
)
},
currentFitLabels: currentFitLabels(),
softOnly: true,
blocksLearning: false,
currentFitSoftOnly: true,
currentFitBlocksLearning: false,
currentFitBlocksVirtualLearning: false,
currentFitBlocksShadowLearning: false,
learningRemainsBroad: true,
selectionWillBeAdaptive: true,
discordWillBeStrict: true,
adaptiveLayerBuilt: false,
adaptiveScoreBuilt: false,
recentMomentumScoreBuilt: false,
currentFitScoreBuilt: false,
parentDiversificationBuilt: false,
measurementFixVersion: MEASUREMENT_FIX_VERSION,
previousMeasurementFixVersion: PREVIOUS_MEASUREMENT_FIX_VERSION,
exitFillModelVersion: EXIT_FILL_MODEL_VERSION,
avgCostRRequiredBeforeAdaptiveSelection: true,

directSLRequiredBeforeAdaptiveSelection: true,
observationDedupeRequiredBeforeAdaptiveSelection: true,
targetTradeSide: TARGET_TRADE_SIDE,
targetScannerSide: TARGET_SCANNER_SIDE,
dashboardSide: TARGET_DASHBOARD_SIDE,
oppositeTradeSide: OPPOSITE_TRADE_SIDE,
trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
learningGranularity: LEARNING_GRANULARITY,
parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
...longModeFlags()
};
if (
normalized.currentRegime === WEATHER_REGIME.UNKNOWN &&
normalized.currentTrendSide === TREND_SIDE.UNKNOWN &&
normalized.sampleSize <= 0
) {
normalized.ok = false;
normalized.available = false;
}
return normalized;
}
export function buildMarketWeatherFromTickers(tickers = [], {
source = 'DIRECT_INPUT',
sourceKey = null,
snapshotId = null,
generatedAt = now(),
limit = universeLimit()
} = {}) {
const normalized = extractTickerRows(tickers)
.map(normalizeTicker)
.filter((row) => row.symbol && row.cryptoBreadthEligible !== false);
const universe = topByLiquidity(normalized, limit);
const sampleSize = universe.length;
if (sampleSize <= 0) {
return emptyWeather({
reason: 'NO_TICKERS_AFTER_NORMALIZATION',
source,
sourceKey

});
}
const t = thresholds();
let advancingCount = 0;
let decliningCount = 0;
let neutralCount = 0;
let strongBearishCount = 0;
let strongBullishCount = 0;
for (const row of universe) {
const direction = classifyTickerDirection(row, t);
if (direction.advancing) advancingCount += 1;
if (direction.declining) decliningCount += 1;
if (direction.neutral) neutralCount += 1;
if (direction.strongBearish) strongBearishCount += 1;
if (direction.strongBullish) strongBullishCount += 1;
}
const change1hValues = universe.map((row) => row.change1h);
const change24hValues = universe.map((row) => row.change24h);
const abs1hValues = universe.map((row) => row.absChange1h);
const abs24hValues = universe.map((row) => row.absChange24h);
const rangeValues = universe.map((row) => Math.max(row.rangePct, row.atrPct,
row.realizedVolPct, 0));
const medianChange1h = median(change1hValues);
const medianChange24h = median(change24hValues);
const medianAbs1h = median(abs1hValues);
const medianAbs24h = median(abs24hValues);
const medianRangePct = median(rangeValues);
const change24hDispersion = dispersion(change24hValues);
const btc = findBtcTicker(normalized);
const btcTrendSide = classifyBtcTrendSide(btc, t);
const latestTickerTs = Math.max(
0,
...normalized.map((row) => safeNumber(row.updatedAt, 0))
);
const cacheHealthy =
sampleSize >= minUniverseSize() &&
(
latestTickerTs <= 0 ||

generatedAt - latestTickerTs <= staleAfterMs()
);
const classified = classifyWeatherFromBreadth({
sampleSize,
cacheHealthy,
advancingCount,
decliningCount,
neutralCount,
strongBearishCount,
strongBullishCount,
medianChange1h,
medianChange24h,
medianAbs1h,
medianAbs24h,
medianRangePct,
change24hDispersion,
btcTrendSide
}, t);
const advanceRatio = sampleSize > 0 ? advancingCount / sampleSize : 0;
const declineRatio = sampleSize > 0 ? decliningCount / sampleSize : 0;
const neutralRatio = sampleSize > 0 ? neutralCount / sampleSize : 0;
const strongBearishRatio = sampleSize > 0 ? strongBearishCount / sampleSize : 0;
const strongBullishRatio = sampleSize > 0 ? strongBullishCount / sampleSize : 0;
return normalizeMarketWeatherPayload({
ok: true,
available: true,
version: MARKET_WEATHER_VERSION,
source,
sourceKey,
snapshotId,
generatedAt,
updatedAt: generatedAt,
...buildTemporalContextUtc(generatedAt || now(), {
snapshotId,
source: 'MARKET_WEATHER_BUILD'
}),
currentRegime: classified.currentRegime,
regime: classified.currentRegime,
currentTrendSide: classified.currentTrendSide,
trendSide: trendSideForDashboard(classified.currentTrendSide),
marketTrendSide: trendSideForDashboard(classified.currentTrendSide),
currentBtcRelation: classified.currentBtcRelation,
currentFlow: classified.currentFlow,

flow: classified.currentFlow,
currentVolatilityState: classified.currentVolatilityState,
volatilityState: classified.currentVolatilityState,
currentMarketFitConfidence: classified.confidence,
confidence: classified.confidence,
weatherConfidence: classified.confidence,
cacheHealthy,
sampleSize,
universeSize: normalized.length,
universeLimit: limit,
count: sampleSize,
universeCount: sampleSize,
breadth: {
advancingCount,
decliningCount,
neutralCount,
strongBearishCount,
strongBullishCount,
advanceRatio: round4(advanceRatio),
declineRatio: round4(declineRatio),
neutralRatio: round4(neutralRatio),
strongBearishRatio: round4(strongBearishRatio),
strongBullishRatio: round4(strongBullishRatio),
medianChange1h: round4(medianChange1h),
medianChange24h: round4(medianChange24h),
medianAbs1h: round4(medianAbs1h),
medianAbs24h: round4(medianAbs24h),
medianRangePct: round4(medianRangePct),
meanChange1h: round4(mean(change1hValues)),
meanChange24h: round4(mean(change24hValues)),
change24hDispersion: round4(change24hDispersion)
},
currentMarketWeatherKey: classified.currentRegime !== WEATHER_REGIME.UNKNOWN && classified.currentTrendSide !== TREND_SIDE.UNKNOWN
? `${classified.currentRegime}|${classified.currentTrendSide}`
: 'UNKNOWN',
marketWeatherKey: classified.currentRegime !== WEATHER_REGIME.UNKNOWN && classified.currentTrendSide !== TREND_SIDE.UNKNOWN
? `${classified.currentRegime}|${classified.currentTrendSide}`
: 'UNKNOWN',
bullishPct: round4(advanceRatio * 100),
bearishPct: round4(declineRatio * 100),
neutralPct: round4(neutralRatio * 100),
btcRouterState: btcRouterStateFromTrendSide(btcTrendSide),
btcState: btcRouterStateFromTrendSide(btcTrendSide),
btcDirection: btcTrendSide,
btcTrendSide,
btc: {
symbol: btc?.symbol || null,
change1h: round4(btc?.change1h || 0),
change24h: round4(btc?.change24h || 0),
trendSide: btcTrendSide,
direction: btcTrendSide,
state: btcRouterStateFromTrendSide(btcTrendSide),
btcState: btcRouterStateFromTrendSide(btcTrendSide),
btcRouterState: btcRouterStateFromTrendSide(btcTrendSide)
},
thresholds: t,

symbols: universe.slice(0, 40).map((row) => row.symbol).filter(Boolean),
rows: universe.slice(0, 120),
universe: universe.slice(0, 120)
});
}
export async function loadScannerUniverse({
redis = getDurableRedis(),
keys = defaultUniverseKeys()
} = {}) {
for (const key of keys) {
try {
const payload = await getJson(redis, key, null);
const rows = extractTickerRows(payload);
if (rows.length > 0) {
return {
ok: true,
key,
payload,
rows,
source: payload?.source || 'SCANNER_CACHE',
cacheUpdatedAt: safeNumber(payload?.updatedAt || payload?.generatedAt ||
payload?.ts, 0)
};
}
} catch {
// Try next key.
}
}
return {
ok: false,
key: null,
payload: null,
rows: [],
source: 'NO_SCANNER_CACHE',
cacheUpdatedAt: 0
};
}
export async function buildMarketWeather({
redis = getDurableRedis(),
universe = null,
source = null,

sourceKey = null,
save = false
} = {}) {
let rows = extractTickerRows(universe);
let resolvedSource = source || 'DIRECT_INPUT';
let resolvedSourceKey = sourceKey || null;
let cachePayload = null;
if (!rows.length) {
const loaded = await loadScannerUniverse({
redis
});
rows = loaded.rows || [];
resolvedSource = loaded.source || 'SCANNER_CACHE';
resolvedSourceKey = loaded.key || null;
cachePayload = loaded.payload;
}
const generatedAt = now();
const weather = buildMarketWeatherFromTickers(rows, {
source: resolvedSource,
sourceKey: resolvedSourceKey,
snapshotId: cachePayload?.snapshotId || null,
generatedAt,
limit: universeLimit()
});
const cacheUpdatedAt = safeNumber(
cachePayload?.updatedAt ||
cachePayload?.generatedAt ||
cachePayload?.ts,
0
);
weather.cachePayloadUpdatedAt = cacheUpdatedAt || null;
weather.cacheAgeMs = cacheUpdatedAt > 0 ? Math.max(0, generatedAt -
cacheUpdatedAt) : null;
weather.cacheStale = cacheUpdatedAt > 0 ? generatedAt - cacheUpdatedAt >
staleAfterMs() : false;
if (save) {
await saveMarketWeather(weather, {
redis
});
}

return normalizeMarketWeatherPayload(weather);
}
export async function saveMarketWeather(weather, {
redis = getDurableRedis(),
keys = defaultWeatherKeys()
} = {}) {
const payload = normalizeMarketWeatherPayload({
...weather,
savedAt: now(),
version: weather.version || MARKET_WEATHER_VERSION,
softOnly: true,
blocksLearning: false,
currentFitSoftOnly: true,
currentFitBlocksLearning: false,
currentFitBlocksVirtualLearning: false,
currentFitBlocksShadowLearning: false,
learningRemainsBroad: true,
selectionWillBeAdaptive: true,
discordWillBeStrict: true,
adaptiveLayerBuilt: false,
adaptiveScoreBuilt: false,
recentMomentumScoreBuilt: false,
currentFitScoreBuilt: false,
parentDiversificationBuilt: false,
measurementFixVersion: MEASUREMENT_FIX_VERSION,
previousMeasurementFixVersion: PREVIOUS_MEASUREMENT_FIX_VERSION,
exitFillModelVersion: EXIT_FILL_MODEL_VERSION,
...longModeFlags()
});
const savedKeys = [];
for (const key of keys) {
try {
await setJson(redis, namespacedLongKey(key), payload);
savedKeys.push(namespacedLongKey(key));
} catch {
// Keep saving other compatibility keys.
}
}
return {

ok: savedKeys.length > 0,
savedKeys,
payload
};
}
export async function loadMarketWeather({
redis = getDurableRedis(),
keys = defaultWeatherKeys(),
maxAgeMs = staleAfterMs()
} = {}) {
for (const key of keys) {
try {
const rawWeather = await getJson(redis, namespacedLongKey(key), null);
if (!rawWeather) continue;
const generatedAt = safeNumber(rawWeather.generatedAt ||
rawWeather.updatedAt || rawWeather.savedAt || rawWeather.completedAt, 0);
const ageMs = generatedAt > 0 ? now() - generatedAt : null;
const stale = ageMs !== null ? ageMs > maxAgeMs : true;
return normalizeMarketWeatherPayload({
...rawWeather,
loadedFromKey: namespacedLongKey(key),
loadedAt: now(),
ageMs,
stale,
cacheStale: stale,
softOnly: true,
blocksLearning: false,
currentFitSoftOnly: true,
currentFitBlocksLearning: false,
currentFitBlocksVirtualLearning: false,
currentFitBlocksShadowLearning: false,
...longModeFlags()
});
} catch {
// Try next key.
}
}
return emptyWeather({
reason: 'NO_SAVED_MARKET_WEATHER',
source: 'LOAD_MARKET_WEATHER'
});
}

function setupFitScore({
setup,
weather
}) {
const weatherRow = normalizeMarketWeatherPayload(weather);
const regime = weatherRow.currentRegime;
const trendSide = weatherRow.currentTrendSide;
const volState = weatherRow.currentVolatilityState;
if (!setup) return 0;
if (setup === 'COMPRESSION') {
if (regime === WEATHER_REGIME.SQUEEZE || volState ===
VOLATILITY_STATE.COMPRESSION) return 22;
if (regime === WEATHER_REGIME.CHOP) return 10;
return -8;
}
if (setup === 'BREAKOUT') {
if (regime === WEATHER_REGIME.TREND && trendSide === TREND_SIDE.LONG) return
20;
if (regime === WEATHER_REGIME.SQUEEZE) return 12;
if (volState === VOLATILITY_STATE.EXPANSION) return 10;
if (trendSide === TREND_SIDE.SHORT) return -18;
return 0;
}
if (setup === 'CONTINUATION') {
if (regime === WEATHER_REGIME.TREND && trendSide === TREND_SIDE.LONG) return
24;
if (trendSide === TREND_SIDE.SHORT) return -22;
if (regime === WEATHER_REGIME.CHOP) return -4;
return 4;
}
if (setup === 'RETEST') {
if (regime === WEATHER_REGIME.TREND && trendSide === TREND_SIDE.LONG) return
18;
if (regime === WEATHER_REGIME.CHOP) return 8;
if (trendSide === TREND_SIDE.SHORT) return -14;
return 2;
}
if (setup === 'SWEEP_REVERSAL') {
if (regime === WEATHER_REGIME.CHOP) return 15;
if (regime === WEATHER_REGIME.SQUEEZE) return 8;

if (regime === WEATHER_REGIME.TREND && trendSide === TREND_SIDE.LONG) return
5;
if (trendSide === TREND_SIDE.SHORT) return -8;
return 0;
}
return 0;
}
function regimeFitScore({
familyRegime,
weather
}) {
const weatherRow = normalizeMarketWeatherPayload(weather);
const regime = weatherRow.currentRegime;
const trendSide = weatherRow.currentTrendSide;
if (!familyRegime || regime === WEATHER_REGIME.UNKNOWN) return 0;
if (familyRegime === regime) {
if (regime === WEATHER_REGIME.TREND && trendSide === TREND_SIDE.LONG) return
35;
if (regime === WEATHER_REGIME.TREND && trendSide === TREND_SIDE.SHORT) return
-35;
return 30;
}
if (familyRegime === 'TREND' && regime === WEATHER_REGIME.CHOP) return -8;
if (familyRegime === 'TREND' && regime === WEATHER_REGIME.SQUEEZE) return -4;
if (familyRegime === 'SQUEEZE' && regime === WEATHER_REGIME.TREND) return -10;
if (familyRegime === 'SQUEEZE' && regime === WEATHER_REGIME.CHOP) return 4;
if (familyRegime === 'CHOP' && regime === WEATHER_REGIME.SQUEEZE) return 8;
if (familyRegime === 'CHOP' && regime === WEATHER_REGIME.TREND) return -6;
return 0;
}
function confirmationFitScore({
confirmationProfile,
weather
}) {
const weatherRow = normalizeMarketWeatherPayload(weather);
const trendSide = weatherRow.currentTrendSide;
const confidence = safeNumber(weatherRow.currentMarketFitConfidence ??
weatherRow.confidence, 0);

if (!confirmationProfile) return 0;
if (confirmationProfile === 'A_STRONG_ALIGN') {
if (trendSide === TREND_SIDE.LONG && confidence >= 60) return 16;
if (trendSide === TREND_SIDE.SHORT && confidence >= 55) return -22;
return 4;
}
if (confirmationProfile === 'B_FLOW_ALIGN') {
if (trendSide === TREND_SIDE.LONG) return 12;
if (trendSide === TREND_SIDE.SHORT) return -18;
return 2;
}
if (confirmationProfile === 'C_VOLUME_ALIGN') {
if (weatherRow.currentVolatilityState === VOLATILITY_STATE.EXPANSION) return
10;
if (weatherRow.currentVolatilityState === VOLATILITY_STATE.COMPRESSION) return
2;
return 4;
}
if (confirmationProfile === 'D_MIXED_OK') {
if (weatherRow.currentRegime === WEATHER_REGIME.CHOP) return 8;
return 0;
}
if (confirmationProfile === 'E_WEAK_CONTRA') {
if (trendSide === TREND_SIDE.SHORT) return -5;
return -12;
}
return 0;
}
function fitLabel(score, weather = null) {
const weatherRow = weather ? normalizeMarketWeatherPayload(weather) : null;
const n = safeNumber(score, 0);
if (
!weatherRow ||
weatherRow.available === false ||
weatherRow.ok === false ||
weatherRow.currentRegime === WEATHER_REGIME.UNKNOWN ||
weatherRow.currentTrendSide === TREND_SIDE.UNKNOWN
) {

return FIT_LABEL.UNKNOWN;
}
if (n >= 70) return FIT_LABEL.MATCH;
if (n >= 55) return FIT_LABEL.WEAK_MATCH;
if (n >= 35) return FIT_LABEL.NEUTRAL;
if (n > 0) return FIT_LABEL.MISFIT;
return FIT_LABEL.UNKNOWN;
}
export function computeCurrentFit(rowOrMicroId = {}, weather = null) {
const weatherRow = normalizeMarketWeatherPayload(weather || emptyWeather({
reason: 'NO_WEATHER_FOR_FIT',
source: 'COMPUTE_CURRENT_FIT'
}));
const microFamilyId = typeof rowOrMicroId === 'string'
? rowOrMicroId
: microIdFromRow(rowOrMicroId);
const parsed = parseTaxonomyMicroId(microFamilyId);
if (!parsed.valid || !parsed.isChild) {
return {
currentFit: 0,
currentFitScore: 0,
longCurrentFit: 0,
bullCurrentFit: 0,
bullishCurrentFit: 0,
shortCurrentFit: 0,
bearCurrentFit: 0,
bearishCurrentFit: 0,
currentFitLabel: FIT_LABEL.UNKNOWN,
currentFitReason: 'NO_EXACT_75_CHILD_MICRO_ID',
currentFitConfidence: 0,
currentFitMatchedFamily: null,
currentFitBlocksLearning: false,
currentFitBlocksVirtualLearning: false,
currentFitBlocksShadowLearning: false,
currentFitSoftOnly: true,
learningRemainsBroad: true,
selectionWillBeAdaptive: true,
discordWillBeStrict: true,
currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT'
};

}
const tradeSide = parsed.tradeSide ||
normalizeTradeSide(rowOrMicroId.tradeSide);
if (tradeSide !== TARGET_TRADE_SIDE) {
return {
currentFit: 0,
currentFitScore: 0,
longCurrentFit: 0,
bullCurrentFit: 0,
bullishCurrentFit: 0,
shortCurrentFit: 0,
bearCurrentFit: 0,
bearishCurrentFit: 0,
currentFitLabel: FIT_LABEL.MISFIT,
currentFitReason: 'NON_LONG_FAMILY_FOR_LONG_WEATHER',
currentFitConfidence: safeNumber(weatherRow.currentMarketFitConfidence ??
weatherRow.confidence, 0),
currentFitMatchedFamily: parsed.childTrueMicroFamilyId,
currentFitBlocksLearning: false,
currentFitBlocksVirtualLearning: false,
currentFitBlocksShadowLearning: false,
currentFitSoftOnly: true,
learningRemainsBroad: true,
selectionWillBeAdaptive: true,
discordWillBeStrict: true,
currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT'
};
}
if (
weatherRow.available === false ||
weatherRow.ok === false ||
weatherRow.currentRegime === WEATHER_REGIME.UNKNOWN ||
weatherRow.currentTrendSide === TREND_SIDE.UNKNOWN
) {
return {
currentFit: 0,
currentFitScore: 0,
longCurrentFit: 0,
bullCurrentFit: 0,
bullishCurrentFit: 0,
shortCurrentFit: 0,
bearCurrentFit: 0,
bearishCurrentFit: 0,

currentFitLabel: FIT_LABEL.UNKNOWN,
currentFitReason: 'NO_VALID_MARKET_WEATHER',
currentFitConfidence: 0,
currentFitMatchedFamily: parsed.childTrueMicroFamilyId,
currentFitMatchedParentFamily: parsed.parentTrueMicroFamilyId,
entryWeatherFitMatchedFamily: parsed.childTrueMicroFamilyId,
currentFitBlocksLearning: false,
currentFitBlocksVirtualLearning: false,
currentFitBlocksShadowLearning: false,
currentFitSoftOnly: true,
learningRemainsBroad: true,
selectionWillBeAdaptive: true,
discordWillBeStrict: true,
currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT'
};
}
const base = 35;
const regimeScore = regimeFitScore({
familyRegime: parsed.regime,
weather: weatherRow
});
const setupScore = setupFitScore({
setup: parsed.setup,
weather: weatherRow
});
const confirmationScore = confirmationFitScore({
confirmationProfile: parsed.confirmationProfile,
weather: weatherRow
});
const confidence = safeNumber(weatherRow.currentMarketFitConfidence ??
weatherRow.confidence, 0);
const confidenceAdjustment = clamp((confidence - 50) / 5, -8, 10);
const rawScore = base + regimeScore + setupScore + confirmationScore +
confidenceAdjustment;
const currentFit = Math.round(clamp(rawScore, 0, 100));
return {
currentFit,
currentFitScore: currentFit,
longCurrentFit: currentFit,

bullCurrentFit: currentFit,
bullishCurrentFit: currentFit,
shortCurrentFit: -currentFit,
bearCurrentFit: -currentFit,
bearishCurrentFit: -currentFit,
currentFitLabel: fitLabel(currentFit, weatherRow),
currentFitReason: [
`REGIME=${parsed.regime}:${round2(regimeScore)}`,
`SETUP=${parsed.setup}:${round2(setupScore)}`,
`CONFIRMATION=${parsed.confirmationProfile}:${round2(confirmationScore)}`,
`WEATHER_CONFIDENCE=${round2(confidence)}`
].join('|'),
currentFitConfidence: Math.round(clamp(confidence, 0, 100)),
currentFitMatchedFamily: parsed.childTrueMicroFamilyId,
currentFitMatchedParentFamily: parsed.parentTrueMicroFamilyId,
entryWeatherFitMatchedFamily: parsed.childTrueMicroFamilyId,
currentFitBlocksLearning: false,
currentFitBlocksVirtualLearning: false,
currentFitBlocksShadowLearning: false,
currentFitSoftOnly: true,
learningRemainsBroad: true,
selectionWillBeAdaptive: true,
discordWillBeStrict: true,
currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT'
};
}
export function compactMarketWeatherForEntry(weather = {}) {
const weatherRow = normalizeMarketWeatherPayload(weather);
return {
...buildTemporalContextUtc(weatherRow.generatedAt || weatherRow.updatedAt ||
now(), { snapshotId: weatherRow.snapshotId, source: 'COMPACT_MARKET_WEATHER' }),
version: weatherRow.version || MARKET_WEATHER_VERSION,
generatedAt: weatherRow.generatedAt || weatherRow.updatedAt || null,
currentRegime: weatherRow.currentRegime || WEATHER_REGIME.UNKNOWN,
currentTrendSide: weatherRow.currentTrendSide || TREND_SIDE.UNKNOWN,
trendSide: weatherRow.trendSide ||
trendSideForDashboard(weatherRow.currentTrendSide),
currentBtcRelation: weatherRow.currentBtcRelation || 'BTC_UNKNOWN',
currentFlow: weatherRow.currentFlow || FLOW_STATE.FLOW_UNKNOWN,

currentVolatilityState: weatherRow.currentVolatilityState ||
VOLATILITY_STATE.UNKNOWN,
currentMarketFitConfidence: safeNumber(weatherRow.currentMarketFitConfidence
?? weatherRow.confidence, 0),
cacheHealthy: Boolean(weatherRow.cacheHealthy),
cacheStale: Boolean(weatherRow.cacheStale),
sampleSize: safeNumber(weatherRow.sampleSize, 0),
breadth: {
advanceRatio: safeNumber(weatherRow.breadth?.advanceRatio, 0),
declineRatio: safeNumber(weatherRow.breadth?.declineRatio, 0),
neutralRatio: safeNumber(weatherRow.breadth?.neutralRatio, 0),
medianChange1h: safeNumber(weatherRow.breadth?.medianChange1h, 0),
medianChange24h: safeNumber(weatherRow.breadth?.medianChange24h, 0),
change24hDispersion: safeNumber(weatherRow.breadth?.change24hDispersion, 0)
},
btc: {
symbol: weatherRow.btc?.symbol || null,
change1h: safeNumber(weatherRow.btc?.change1h, 0),
change24h: safeNumber(weatherRow.btc?.change24h, 0),
trendSide: weatherRow.btc?.trendSide || TREND_SIDE.UNKNOWN
},
softOnly: true,
blocksLearning: false,
currentFitSoftOnly: true,
currentFitBlocksLearning: false,
currentFitBlocksVirtualLearning: false,
currentFitBlocksShadowLearning: false,
currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
learningRemainsBroad: true,
...longModeFlags()
};
}
export function annotateWithCurrentFit(row = {}, weather = {}) {
const weatherRow = normalizeMarketWeatherPayload(weather);
const fit = computeCurrentFit(row, weatherRow);
const entryMarketWeather = compactMarketWeatherForEntry(weatherRow);
return {
...row,

entryMarketWeather,
entryCurrentRegime: entryMarketWeather.currentRegime,
entryCurrentTrendSide: entryMarketWeather.currentTrendSide,
entryCurrentBtcRelation: entryMarketWeather.currentBtcRelation,
entryCurrentFlow: entryMarketWeather.currentFlow,
entryCurrentVolatilityState: entryMarketWeather.currentVolatilityState,
currentRegime: entryMarketWeather.currentRegime,
currentTrendSide: entryMarketWeather.currentTrendSide,
currentBtcRelation: entryMarketWeather.currentBtcRelation,
currentFlow: entryMarketWeather.currentFlow,
currentVolatilityState: entryMarketWeather.currentVolatilityState,
entryCurrentFit: fit.currentFit,
currentFit: fit.currentFit,
entryCurrentFitScore: fit.currentFitScore,
currentFitScore: fit.currentFitScore,
longCurrentFit: fit.longCurrentFit,
bullCurrentFit: fit.bullCurrentFit,
bullishCurrentFit: fit.bullishCurrentFit,
shortCurrentFit: fit.shortCurrentFit,
bearCurrentFit: fit.bearCurrentFit,
bearishCurrentFit: fit.bearishCurrentFit,
entryCurrentFitLabel: fit.currentFitLabel,
currentFitLabel: fit.currentFitLabel,
entryCurrentFitReason: fit.currentFitReason,
currentFitReason: fit.currentFitReason,
entryCurrentFitConfidence: fit.currentFitConfidence,
currentMarketFitConfidence: fit.currentFitConfidence,
entryWeatherFitMatchedFamily: fit.currentFitMatchedFamily,
currentFitMatchedFamily: fit.currentFitMatchedFamily,
currentFitMatchedParentFamily: fit.currentFitMatchedParentFamily,
currentFitSoftOnly: true,
currentFitBlocksLearning: false,
currentFitBlocksVirtualLearning: false,
currentFitBlocksShadowLearning: false,
currentFitAffectsSelectionOnly: true,
currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
learningRemainsBroad: true,

selectionWillBeAdaptive: true,
discordWillBeStrict: true,
adaptiveScoreBuilt: false,
adaptiveScore: row.adaptiveScore ?? null,
currentFitScoreBuilt: false,
measurementFixVersion: MEASUREMENT_FIX_VERSION,
previousMeasurementFixVersion: PREVIOUS_MEASUREMENT_FIX_VERSION,
exitFillModelVersion: EXIT_FILL_MODEL_VERSION,
...longModeFlags()
};
}
export async function getMarketWeather({
redis = getDurableRedis(),
refresh = false,
save = true,
allowStale = true
} = {}) {
if (!refresh) {
const loaded = await loadMarketWeather({
redis
});
if (loaded.ok && (allowStale || loaded.stale !== true)) {
return normalizeMarketWeatherPayload(loaded);
}
}
return buildMarketWeather({
redis,
save
});
}
export async function annotateWithLatestCurrentFit(row = {}, {
redis = getDurableRedis(),
refresh = false
} = {}) {
const weather = await getMarketWeather({
redis,
refresh,
save: refresh,
allowStale: true
});

return annotateWithCurrentFit(row, weather);
}
export function marketWeatherIdentityFlags() {
return {
version: MARKET_WEATHER_VERSION,
targetTradeSide: TARGET_TRADE_SIDE,
targetScannerSide: TARGET_SCANNER_SIDE,
dashboardSide: TARGET_DASHBOARD_SIDE,
oppositeTradeSide: OPPOSITE_TRADE_SIDE,
longOnly: true,
shortDisabled: true,
shortOnly: false,
longDisabled: false,
virtualOnly: true,
virtualLearning: true,
virtualTracked: true,
shadowOnly: true,
realTrade: false,
realOrder: false,
exchangeOrder: false,
bitgetOrderPlaced: false,
noRealOrders: true,
realOrdersDisabled: true,
exchangeOrdersDisabled: true,
bitgetOrdersDisabled: true,
exchangeCallsDisabled: true,
noExchangeOrders: true,
persistentLearningKey: PERSISTENT_LEARNING_KEY,
trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
learningGranularity: LEARNING_GRANULARITY,
parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
learningRemainsBroad: true,
selectionWillBeAdaptive: true,
discordWillBeStrict: true,

currentFitLabels: currentFitLabels(),
currentFitSoftOnly: true,
currentFitBlocksLearning: false,
currentFitBlocksVirtualLearning: false,
currentFitBlocksShadowLearning: false,
currentFitAffectsSelectionOnly: true,
currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
adaptiveLayerBuilt: false,
adaptiveScoreBuilt: false,
recentMomentumScoreBuilt: false,
currentFitScoreBuilt: false,
parentDiversificationBuilt: false,
completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
scoringRSource: 'netR',
winsLossesFlatsSource: 'netR',
winrateDefinition: 'netR > 0',
avgRSource: 'netR',
totalRSource: 'netR',
avgCostRShown: true,
avgCostRSource: 'costR',
riskTradeSide: TARGET_TRADE_SIDE,
longRiskShape: 'sl < entry < tp',
validLongRiskShape: 'entry > 0 && sl < entry && entry < tp',
validLongGeometry: 'sl < entry < tp',
riskGeometryRule: 'LONG: sl < entry < tp',
tpHitRule: 'LONG: price >= tp',
slHitRule: 'LONG: price <= initialSl',
grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
currentRFormula: '(currentPrice - entry) / (entry - initialSl)',
longGrossRFormula: '(exitPrice - entry) / (entry - initialSl)',
longCurrentRFormula: '(currentPrice - entry) / (entry - initialSl)',
longExitRules: {
tp: 'price >= tp',
sl: 'price <= initialSl',
timeStop: 'TIME_STOP'
},
measurementFixVersion: MEASUREMENT_FIX_VERSION,
previousMeasurementFixVersion: PREVIOUS_MEASUREMENT_FIX_VERSION,
exitFillModelVersion: EXIT_FILL_MODEL_VERSION,
avgCostRRequiredBeforeAdaptiveSelection: true,
directSLRequiredBeforeAdaptiveSelection: true,

observationDedupeRequiredBeforeAdaptiveSelection: true,
redisNamespace: LONG_NAMESPACE,
redisKeyPrefix: LONG_KEY_PREFIX,
redisKeysSeparatedFromShortRoot: true,
shortRootTouched: false
};
}
export {
MARKET_WEATHER_VERSION,
MEASUREMENT_FIX_VERSION,
WEATHER_REGIME,
TREND_SIDE,
FLOW_STATE,
VOLATILITY_STATE,
FIT_LABEL
};

