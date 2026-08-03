
====================================================================================================
FILE: src/market/marketWeather.js
====================================================================================================

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
const change1h = normalizeChangePct(
row.change1h,
row.change1hPct,
row.priceChange1hPct,
row.pctChange1h,
row.return1h,
row.ret1h
);
const change24h = normalizeChangePct(
row.change24h,
row.change24hPct,
row.priceChange24hPct,
row.priceChangePercent,
row.pctChange24h,
row.return24h,
row.ret24h
);
const rangePct = normalizeChangePct(
row.rangePct,
row.range24hPct,
row.dailyRangePct,
row.highLowRangePct
);
const atrPct = normalizeChangePct(
row.atrPct,
row.atrPercent,
row.atrPct14

);
const realizedVolPct = normalizeChangePct(
row.realizedVolPct,
row.realizedVolatilityPct,
row.volatilityPct
);
const quoteVolume = safeNumber(
row.quoteVolume ??
row.quoteVolume24h ??
row.turnover24h ??
row.volumeUsd ??
row.volumeUSDT,
0
);
const baseVolume = safeNumber(
row.volume ??
row.baseVolume ??
row.volume24h,
0
);
return {
raw: row,
symbol,
baseSymbol: normalizeSymbol(row.baseSymbol ||
symbol.replace(/USDT$|USDC$|USD$/g, '')),
change1h,
change24h,
absChange1h: Math.abs(change1h),
absChange24h: Math.abs(change24h),
rangePct,
atrPct,
realizedVolPct,
quoteVolume,
baseVolume,
spreadPct: safeNumber(row.spreadPct ?? row.spread ?? row.bidAskSpreadPct, 0),
updatedAt: safeNumber(row.updatedAt ?? row.ts ?? row.timestamp, 0)
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
btcRouterState: btcRouterStateFromTrendSide(
weather.btcRouterState || weather.btcState || weather.btc?.btcRouterState ||
weather.btc?.btcState || weather.btc?.state || weather.btc?.trendSide || weather.btcTrendSide
),
btcState: btcRouterStateFromTrendSide(
weather.btcRouterState || weather.btcState || weather.btc?.btcRouterState ||
weather.btc?.btcState || weather.btc?.state || weather.btc?.trendSide || weather.btcTrendSide
),
btcDirection: normalizeWeatherTrendSide(
weather.btcDirection || weather.btcTrendSide || weather.btc?.direction || weather.btc?.trendSide || weather.btcState
),
btcTrendSide: normalizeWeatherTrendSide(
weather.btcTrendSide || weather.btcDirection || weather.btc?.trendSide || weather.btc?.direction || weather.btcState
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
trendSide: normalizeWeatherTrendSide(weather.btc?.trendSide || weather.btcTrendSide || weather.btcDirection || weather.btcState),
direction: normalizeWeatherTrendSide(weather.btc?.direction || weather.btc?.trendSide || weather.btcTrendSide || weather.btcDirection || weather.btcState),
state: btcRouterStateFromTrendSide(weather.btc?.state || weather.btc?.trendSide || weather.btcTrendSide || weather.btcDirection || weather.btcState),
btcState: btcRouterStateFromTrendSide(weather.btc?.btcState || weather.btc?.state || weather.btc?.trendSide || weather.btcTrendSide || weather.btcDirection || weather.btcState),
btcRouterState: btcRouterStateFromTrendSide(weather.btc?.btcRouterState || weather.btc?.btcState || weather.btc?.state || weather.btc?.trendSide || weather.btcTrendSide || weather.btcDirection || weather.btcState)
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
.filter((row) => row.symbol);
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



====================================================================================================
FILE: src/analyze/scoring.js
====================================================================================================

// ================= FILE: src/analyze/scoring.js =================


import { CONFIG } from '../config.js';
import { clamp, safeNumber, sideToTradeSide } from '../utils.js';


const DEFAULT_WILSON_Z = 1.96;
const DEFAULT_PRIOR_TRADES = 24;
const DEFAULT_PRIOR_WINRATE = 0.5;
const DEFAULT_SAMPLE_CAP = 50;
const DEFAULT_AVG_R_CAP = 5;
const DEFAULT_AVG_R_SAMPLE_EXPONENT = 1.35;
const DEFAULT_OBSERVATION_DEDUPE_CACHE_LIMIT = 5000;


const MIN_COMPLETED_ACTIVE = 20;


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


const MEASUREMENT_FIX_VERSION =
'LONG_MEASUREMENT_FIX_TRIGGER_BOUNDARY_EXIT_FILL_V2';
const PREVIOUS_MEASUREMENT_FIX_VERSION =
'LONG_MEASUREMENT_FIX_AVGCOST_DIRECTSL_SEEN_DEDUPE_V1';
const EXIT_FILL_MODEL_VERSION = 'LONG_TRIGGER_BOUNDARY_FILL_PLUS_COST_MODEL_V1';
const OUTCOME_MEASUREMENT_GATE_MODE = 'STRICT_EXACT_VERSION';
const CURRENT_FIT_VERSION = 'LONG_CURRENTFIT_PERSISTENCE_SNAPSHOT_V2';


const SOURCE_VIRTUAL = 'VIRTUAL';
const SOURCE_REAL = 'REAL';
const SOURCE_SHADOW = 'SHADOW';


const LONG_FIXED_SETUP_TYPES = new Set([
     'BREAKOUT',
     'RETEST',
     'SWEEP_REVERSAL',
     'CONTINUATION',
     'COMPRESSION'
]);


const LONG_FIXED_REGIME_ORDER = [
     'TREND',
     'CHOP',
     'SQUEEZE'
];


const LONG_FIXED_REGIME_BUCKETS = new Set(LONG_FIXED_REGIME_ORDER);


const CONFIRMATION_PROFILE_ORDER = Object.freeze([
     'A_STRONG_ALIGN',
     'B_FLOW_ALIGN',
     'C_VOLUME_ALIGN',
     'D_MIXED_OK',
     'E_WEAK_CONTRA'
]);


const LONG_CONFIRMATION_PROFILES = new Set(CONFIRMATION_PROFILE_ORDER);


export const TEMPORAL_CONTEXT_VERSION = 'LONG_TEMPORAL_CONTEXT_UTC_V1';
export const TEMPORAL_POLICY_VERSION = 'LONG_TEMPORAL_FAMILY_PROFILE_V1';
export const WEEKEND_POLICY_VERSION = 'LONG_WEEKEND_PER_FAMILY_DAY_APPROVAL_V1';
export const SESSION_POLICY_VERSION = 'LONG_DAY_SESSION_VETO_RECOVERY_V1';
export const TEMPORAL_GENERATION_SCHEMA_VERSION = 'LONG_TEMPORAL_ROOT_GENERATION_V1';
export const TEMPORAL_TAXONOMY_VERSION = TRUE_MICRO_SCHEMA;
export const TEMPORAL_COST_MODEL_VERSION = EXIT_FILL_MODEL_VERSION;
export const TEMPORAL_HOURLY_PROFILE_VERSION =
    'LONG_TEMPORAL_DAY_HOUR_PROFILE_V2';
export const TEMPORAL_MARKET_WEATHER_PROFILE_VERSION =
    'LONG_TEMPORAL_DAY_HOUR_MARKET_WEATHER_PROFILE_V1';
export const BTC_DIRECTION_ROUTER_PROFILE_VERSION =
    'LONG_BTC_DIRECTION_ROUTER_PROFILE_V1';
export const BTC_DIRECTION_ROUTER_POLICY_VERSION =
    'LONG_BTC_DIRECTION_ROUTER_COUNTER_SIDE_PROOF_V1';

const DAY_OF_WEEK_UTC = Object.freeze([
    'SUNDAY',
    'MONDAY',
    'TUESDAY',
    'WEDNESDAY',
    'THURSDAY',
    'FRIDAY',
    'SATURDAY'
]);

export const TEMPORAL_DAY_BUCKETS = Object.freeze([
    'MONDAY',
    'TUESDAY',
    'WEDNESDAY',
    'THURSDAY',
    'FRIDAY',
    'SATURDAY',
    'SUNDAY'
]);

export const TEMPORAL_DAY_TYPE_BUCKETS = Object.freeze([
    'WEEKDAY',
    'WEEKEND'
]);

export const TEMPORAL_PRIMARY_SESSION_BUCKETS = Object.freeze([
    'ASIA',
    'ASIA_EU_OVERLAP',
    'EUROPE',
    'EU_US_OVERLAP',
    'US',
    'OFF_HOURS'
]);

export const TEMPORAL_HOUR_BUCKETS = Object.freeze(
    Array.from({ length: 24 }, (_, hour) => `H${String(hour).padStart(2, '0')}`)
);

export function temporalHourKey(hourUtc) {
    const hour = Math.max(0, Math.min(23, Math.floor(safeNumber(hourUtc, 0))));
    return `H${String(hour).padStart(2, '0')}`;
}

export function temporalDayHourKey(dayOfWeekUtc, hourUtc) {
    const day = String(dayOfWeekUtc || '').trim().toUpperCase();
    if (!TEMPORAL_DAY_BUCKET_SET.has(day)) return null;
    return `${day}:${temporalHourKey(hourUtc)}`;
}

export const TEMPORAL_MARKET_WEATHER_KEYS = Object.freeze([
    'TREND|LONG',
    'TREND|NEUTRAL',
    'TREND|SHORT',
    'CHOP|LONG',
    'CHOP|NEUTRAL',
    'CHOP|SHORT',
    'SQUEEZE|LONG',
    'SQUEEZE|NEUTRAL',
    'SQUEEZE|SHORT',
    'UNKNOWN'
]);

const TEMPORAL_MARKET_WEATHER_KEY_SET = new Set(TEMPORAL_MARKET_WEATHER_KEYS);

export const BTC_ROUTER_STATES = Object.freeze([
    'STRONG_BULLISH',
    'BULLISH',
    'NEUTRAL',
    'BEARISH',
    'STRONG_BEARISH',
    'UNKNOWN'
]);
export const BTC_ROUTER_SELECTABLE_STATES = Object.freeze(
    BTC_ROUTER_STATES.filter((state) => state !== 'UNKNOWN')
);
const BTC_ROUTER_STATE_SET = new Set(BTC_ROUTER_STATES);


export function normalizeTemporalWeatherRegime(value = '') {
    const raw = String(value || '').trim().toUpperCase();
    if (!raw) return 'UNKNOWN';
    if (raw.includes('SQUEEZE') || raw.includes('COMPRESSION') || raw.includes('COIL')) {
        return 'SQUEEZE';
    }
    if (raw.includes('CHOP') || raw.includes('RANGE') || raw.includes('SIDEWAYS') || raw.includes('MIXED')) {
        return 'CHOP';
    }
    if (raw.includes('TREND') || raw.includes('MOMENTUM') || raw.includes('FLOW') || raw.includes('IMPULSE')) {
        return 'TREND';
    }
    return 'UNKNOWN';
}

export function normalizeTemporalWeatherTrendSide(value = '') {
    const raw = String(value || '').trim().toUpperCase();
    if (!raw) return 'UNKNOWN';
    if (
        ['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'UPSIDE', 'GREEN', 'RISK_ON'].includes(raw) ||
        raw.includes('BULLISH') || raw.includes('FLOW_WITH_LONG')
    ) {
        return 'LONG';
    }
    if (
        ['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE', 'RED', 'RISK_OFF'].includes(raw) ||
        raw.includes('BEARISH') || raw.includes('FLOW_WITH_SHORT')
    ) {
        return 'SHORT';
    }
    if (
        ['NEUTRAL', 'MIXED', 'FLAT', 'SIDEWAYS', 'CHOP', 'UNKNOWN'].includes(raw) ||
        raw.includes('NEUTRAL') || raw.includes('MIXED')
    ) {
        return 'NEUTRAL';
    }
    return 'UNKNOWN';
}

function temporalWeatherObjectCandidates(row = {}) {
    const source = row && typeof row === 'object' && !Array.isArray(row) ? row : {};
    return [
        source.entryMarketWeather,
        source.currentMarketWeather,
        source.marketWeather,
        source.weather,
        source.marketWeatherSummary,
        source.entryMarketWeather?.current,
        source.entryMarketWeather?.summary,
        source.currentMarketWeather?.current,
        source.currentMarketWeather?.summary
    ].filter((value) => value && typeof value === 'object' && !Array.isArray(value));
}

function firstTemporalWeatherValue(candidates = [], fields = []) {
    for (const candidate of candidates) {
        for (const field of fields) {
            const value = candidate?.[field];
            if (value !== undefined && value !== null && value !== '') return value;
        }
    }
    return null;
}

export function temporalMarketWeatherKey(value = null, trendSideValue = null) {
    if (typeof value === 'string' && value.includes('|') && trendSideValue == null) {
        const [regimePart, sidePart] = value.split('|');
        const key = `${normalizeTemporalWeatherRegime(regimePart)}|${normalizeTemporalWeatherTrendSide(sidePart)}`;
        return TEMPORAL_MARKET_WEATHER_KEY_SET.has(key) ? key : 'UNKNOWN';
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const context = resolveEntryMarketWeatherContext(value);
        return context.marketWeatherKey;
    }
    const regime = normalizeTemporalWeatherRegime(value);
    const trendSide = normalizeTemporalWeatherTrendSide(trendSideValue);
    const key = `${regime}|${trendSide}`;
    return regime === 'UNKNOWN' || trendSide === 'UNKNOWN' || !TEMPORAL_MARKET_WEATHER_KEY_SET.has(key)
        ? 'UNKNOWN'
        : key;
}

export function resolveEntryMarketWeatherContext(row = {}) {
    const source = row && typeof row === 'object' && !Array.isArray(row) ? row : {};
    const explicitKeyValues = [
        source.entryMarketWeatherKey,
        source.marketWeatherProfileKey,
        source.currentMarketWeatherProfileKey,
        source.currentMarketWeatherKey,
        source.marketWeatherKey,
        source.entryMarketWeather?.currentMarketWeatherKey,
        source.entryMarketWeather?.marketWeatherKey,
        source.currentMarketWeather?.currentMarketWeatherKey,
        source.currentMarketWeather?.marketWeatherKey,
        source.marketWeather?.currentMarketWeatherKey,
        source.marketWeather?.marketWeatherKey,
        source.weather?.currentMarketWeatherKey,
        source.weather?.marketWeatherKey
    ];
    for (const value of explicitKeyValues) {
        const explicitKey = String(value || '').trim().toUpperCase();
        if (!TEMPORAL_MARKET_WEATHER_KEY_SET.has(explicitKey) || explicitKey === 'UNKNOWN') continue;
        const [regime, trendSide] = explicitKey.split('|');
        return {
            marketWeatherKey: explicitKey,
            regime,
            trendSide,
            available: true,
            source: 'EXPLICIT_ENTRY_MARKET_WEATHER_KEY'
        };
    }

    const candidates = temporalWeatherObjectCandidates(source);
    const regimeValues = [
        source.entryMarketWeatherRegime,
        source.entryCurrentRegime,
        source.entryMarketRegime,
        source.currentRegime,
        source.currentMarketRegime,
        ...candidates.flatMap((candidate) => [
            candidate?.currentRegime,
            candidate?.regime,
            candidate?.marketRegime,
            candidate?.regimeBucket,
            candidate?.breadthRegime,
            candidate?.volatilityRegime
        ])
    ];
    const sideValues = [
        source.entryMarketWeatherTrendSide,
        source.entryCurrentTrendSide,
        source.entryMarketTrendSide,
        source.currentTrendSide,
        source.currentMarketTrendSide,
        ...candidates.flatMap((candidate) => [
            candidate?.currentTrendSide,
            candidate?.trendSide,
            candidate?.marketTrendSide,
            candidate?.marketSide,
            candidate?.side,
            candidate?.direction,
            candidate?.breadthSide
        ])
    ];

    let regime = 'UNKNOWN';
    for (const value of regimeValues) {
        const normalized = normalizeTemporalWeatherRegime(value);
        if (normalized !== 'UNKNOWN') { regime = normalized; break; }
    }
    let trendSide = 'UNKNOWN';
    for (const value of sideValues) {
        const normalized = normalizeTemporalWeatherTrendSide(value);
        if (normalized !== 'UNKNOWN') { trendSide = normalized; break; }
    }
    const key = regime !== 'UNKNOWN' && trendSide !== 'UNKNOWN'
        ? `${regime}|${trendSide}`
        : 'UNKNOWN';
    return {
        marketWeatherKey: TEMPORAL_MARKET_WEATHER_KEY_SET.has(key) ? key : 'UNKNOWN',
        regime,
        trendSide,
        available: key !== 'UNKNOWN',
        source: key !== 'UNKNOWN'
            ? 'ENTRY_MARKET_WEATHER_SNAPSHOT'
            : 'MARKET_WEATHER_UNAVAILABLE'
    };
}


function btcContextObjectCandidates(row = {}) {
    const source = row && typeof row === 'object' && !Array.isArray(row) ? row : {};
    const values = [
        source.entryBtcRouterContext,
        source.entryBtcContext,
        source.btcRouterContext,
        source.btcContext,
        source.entryBtc,
        source.currentBtc,
        source.btc,
        source.entryMarketWeather,
        source.currentMarketWeather,
        source.marketWeather,
        source.weather,
        source.entryMarketWeather?.btc,
        source.currentMarketWeather?.btc,
        source.marketWeather?.btc,
        source.weather?.btc,
        source.market?.btc,
        source.source?.btc,
        source.raw?.btc
    ];
    return values.filter((value, index) =>
        value && typeof value === 'object' && !Array.isArray(value) && values.indexOf(value) === index
    );
}

function usableContextValue(value) {
    if (value === undefined || value === null || value === '') return false;
    const text = String(value).trim().toUpperCase();
    return !['UNKNOWN', 'UNAVAILABLE', 'NOT_AVAILABLE', 'N/A', 'NA', 'NONE', 'NULL', 'UNDEFINED'].includes(text);
}

function firstBtcContextValue(candidates = [], fields = []) {
    for (const candidate of candidates) {
        for (const field of fields) {
            const value = candidate?.[field];
            if (usableContextValue(value)) return value;
        }
    }
    return null;
}

function finiteBtcValue(...values) {
    for (const value of values) {
        const number = Number(value);
        if (Number.isFinite(number)) return number;
    }
    return null;
}

function pctBtcValue(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Math.abs(number) <= 1 ? number * 100 : number;
}

export function normalizeBtcRouterState(value = '') {
    const raw = String(value || '').trim().toUpperCase();
    if (!raw) return 'UNKNOWN';
    if (BTC_ROUTER_STATE_SET.has(raw)) return raw;
    if (
        raw.includes('STRONG_BULL') || raw.includes('VERY_BULL') ||
        raw.includes('HARD_BULL') || raw.includes('POWER_BULL') ||
        raw.includes('BTC_RISK_ON_STRONG')
    ) return 'STRONG_BULLISH';
    if (
        raw.includes('STRONG_BEAR') || raw.includes('VERY_BEAR') ||
        raw.includes('HARD_BEAR') || raw.includes('POWER_BEAR') ||
        raw.includes('BTC_RISK_OFF_STRONG')
    ) return 'STRONG_BEARISH';
    if (
        ['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'UPSIDE', 'GREEN', 'RISK_ON'].includes(raw) ||
        raw.includes('BULLISH') || raw.includes('BTC_LONG') || raw.includes('FLOW_WITH_LONG')
    ) return 'BULLISH';
    if (
        ['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE', 'RED', 'RISK_OFF'].includes(raw) ||
        raw.includes('BEARISH') || raw.includes('BTC_SHORT') || raw.includes('FLOW_WITH_SHORT')
    ) return 'BEARISH';
    if (
        ['NEUTRAL', 'MIXED', 'FLAT', 'SIDEWAYS', 'CHOP', 'BALANCED'].includes(raw) ||
        raw.includes('NEUTRAL') || raw.includes('MIXED') || raw.includes('CHOP')
    ) return 'NEUTRAL';
    return 'UNKNOWN';
}

function firstKnownBtcRouterState(...values) {
    for (const value of values) {
        const normalized = normalizeBtcRouterState(value);
        if (normalized !== 'UNKNOWN') return normalized;
    }
    return 'UNKNOWN';
}

export function btcRouterDirection(state = 'UNKNOWN') {
    const normalized = normalizeBtcRouterState(state);
    if (normalized === 'STRONG_BULLISH' || normalized === 'BULLISH') return 'LONG';
    if (normalized === 'STRONG_BEARISH' || normalized === 'BEARISH') return 'SHORT';
    if (normalized === 'NEUTRAL') return 'NEUTRAL';
    return 'UNKNOWN';
}

export function resolveEntryBtcRouterContext(row = {}) {
    const source = row && typeof row === 'object' && !Array.isArray(row) ? row : {};
    const candidates = btcContextObjectCandidates(source);
    const explicitState = firstKnownBtcRouterState(
        source.entryBtcRouterState,
        source.entryBtcState,
        source.btcRouterState,
        source.btcState,
        source.btcRelation,
        source.btc?.btcRouterState,
        source.btc?.btcState,
        source.btc?.state,
        firstBtcContextValue(candidates, [
            'entryBtcRouterState', 'btcRouterState', 'btcState', 'btcRelation',
            'state', 'directionState', 'trendState'
        ])
    );
    const sideRaw = firstBtcContextValue([
        source,
        source.btc,
        ...candidates
    ].filter(Boolean), [
        'entryBtcTrendSide', 'entryBtcDirection', 'btcTrendSide', 'btcDirection',
        'btcSide', 'trendSide', 'direction', 'side'
    ]);
    const sideState = firstKnownBtcRouterState(sideRaw);
    const confidence = Math.max(0, Math.min(100, finiteBtcValue(
        source.entryBtcConfidence,
        source.entryBtcDirectionConfidence,
        source.btcDirectionConfidence,
        source.btcConfidence,
        source.btcTrendConfidence,
        firstBtcContextValue(candidates, [
            'entryBtcConfidence', 'btcDirectionConfidence', 'btcConfidence',
            'trendConfidence', 'confidence'
        ]),
        0
    ) ?? 0));
    const trendStrength = Math.max(0, Math.min(100, Math.abs(finiteBtcValue(
        source.entryBtcTrendStrength,
        source.btcTrendStrength,
        source.btcStrength,
        source.btcMomentumStrength,
        source.btcScore,
        firstBtcContextValue(candidates, [
            'entryBtcTrendStrength', 'btcTrendStrength', 'btcStrength',
            'momentumStrength', 'trendStrength', 'strength', 'score'
        ]),
        0
    ) ?? 0)));
    const marketWeather = resolveEntryMarketWeatherContext(source);
    const bullishPct = pctBtcValue(finiteBtcValue(
        source.entryBullishPct,
        source.currentBullishPct,
        source.bullishPct,
        source.breadthBullishPct,
        firstBtcContextValue(candidates, ['bullishPct', 'breadthBullishPct', 'longPct'])
    ));
    const bearishPct = pctBtcValue(finiteBtcValue(
        source.entryBearishPct,
        source.currentBearishPct,
        source.bearishPct,
        source.breadthBearishPct,
        firstBtcContextValue(candidates, ['bearishPct', 'breadthBearishPct', 'shortPct'])
    ));
    let state = explicitState !== 'UNKNOWN' ? explicitState : sideState;
    const allowMarketWeatherFallback = source.allowMarketWeatherBtcFallback === true;
    if (allowMarketWeatherFallback && state === 'UNKNOWN' && marketWeather.trendSide === 'LONG') state = 'BULLISH';
    if (allowMarketWeatherFallback && state === 'UNKNOWN' && marketWeather.trendSide === 'SHORT') state = 'BEARISH';
    if (allowMarketWeatherFallback && state === 'UNKNOWN' && marketWeather.trendSide === 'NEUTRAL') state = 'NEUTRAL';
    const direction = btcRouterDirection(state);
    const alignedBreadthPct = direction === 'LONG'
        ? bullishPct
        : direction === 'SHORT'
          ? bearishPct
          : null;
    const breadthConfirmed = direction === 'NEUTRAL'
        ? true
        : Number.isFinite(alignedBreadthPct) && alignedBreadthPct >= 55;
    const strongEvidence = confidence >= 72 && trendStrength >= 60 &&
        (breadthConfirmed || !Number.isFinite(alignedBreadthPct));
    if (state === 'BULLISH' && strongEvidence) state = 'STRONG_BULLISH';
    if (state === 'BEARISH' && strongEvidence) state = 'STRONG_BEARISH';
    const normalizedState = BTC_ROUTER_STATE_SET.has(state) ? state : 'UNKNOWN';
    const normalizedDirection = btcRouterDirection(normalizedState);
    return {
        btcRouterState: normalizedState,
        direction: normalizedDirection,
        confidence,
        trendStrength,
        bullishPct,
        bearishPct,
        alignedBreadthPct,
        breadthConfirmed,
        available: normalizedState !== 'UNKNOWN',
        strong: normalizedState === 'STRONG_BULLISH' || normalizedState === 'STRONG_BEARISH',
        againstLong: normalizedDirection === 'SHORT',
        withLong: normalizedDirection === 'LONG',
        counterDirectionRequiresProof: normalizedDirection === 'SHORT',
        source: explicitState !== 'UNKNOWN'
            ? 'EXPLICIT_ENTRY_BTC_STATE'
            : sideState !== 'UNKNOWN'
              ? 'ENTRY_BTC_DIRECTION_FIELDS'
              : allowMarketWeatherFallback && marketWeather.available
                ? 'MARKET_WEATHER_BTC_FALLBACK'
                : 'BTC_CONTEXT_UNAVAILABLE',
        profileVersion: BTC_DIRECTION_ROUTER_PROFILE_VERSION,
        policyVersion: BTC_DIRECTION_ROUTER_POLICY_VERSION
    };
}

export function temporalBtcRouterKey(value = null) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return resolveEntryBtcRouterContext(value).btcRouterState;
    }
    return normalizeBtcRouterState(value);
}

export function temporalMarketWeatherBtcKey(marketWeatherKey, btcState) {
    return `${temporalMarketWeatherKey(marketWeatherKey)}|BTC:${temporalBtcRouterKey(btcState)}`;
}

export function temporalDayBtcKey(dayOfWeekUtc, btcState) {
    const day = String(dayOfWeekUtc || '').trim().toUpperCase();
    if (!TEMPORAL_DAY_BUCKET_SET.has(day)) return null;
    return `${day}|BTC:${temporalBtcRouterKey(btcState)}`;
}

export function temporalHourBtcKey(hourUtc, btcState) {
    return `${temporalHourKey(hourUtc)}|BTC:${temporalBtcRouterKey(btcState)}`;
}

export function temporalDayHourBtcKey(dayOfWeekUtc, hourUtc, btcState) {
    const dayHour = temporalDayHourKey(dayOfWeekUtc, hourUtc);
    return dayHour ? `${dayHour}|BTC:${temporalBtcRouterKey(btcState)}` : null;
}

export function temporalDayWeatherBtcKey(dayOfWeekUtc, marketWeatherKey, btcState) {
    const dayWeather = temporalDayWeatherKey(dayOfWeekUtc, marketWeatherKey);
    return dayWeather ? `${dayWeather}|BTC:${temporalBtcRouterKey(btcState)}` : null;
}

export function temporalHourWeatherBtcKey(hourUtc, marketWeatherKey, btcState) {
    return `${temporalHourWeatherKey(hourUtc, marketWeatherKey)}|BTC:${temporalBtcRouterKey(btcState)}`;
}

export function temporalDayHourWeatherBtcKey(dayOfWeekUtc, hourUtc, marketWeatherKey, btcState) {
    const dayHourWeather = temporalDayHourWeatherKey(dayOfWeekUtc, hourUtc, marketWeatherKey);
    return dayHourWeather ? `${dayHourWeather}|BTC:${temporalBtcRouterKey(btcState)}` : null;
}

export function temporalDayWeatherKey(dayOfWeekUtc, marketWeatherKey) {
    const day = String(dayOfWeekUtc || '').trim().toUpperCase();
    const weather = temporalMarketWeatherKey(marketWeatherKey);
    if (!TEMPORAL_DAY_BUCKET_SET.has(day)) return null;
    return `${day}|${weather}`;
}

export function temporalHourWeatherKey(hourUtc, marketWeatherKey) {
    return `${temporalHourKey(hourUtc)}|${temporalMarketWeatherKey(marketWeatherKey)}`;
}

export function temporalDayHourWeatherKey(dayOfWeekUtc, hourUtc, marketWeatherKey) {
    const dayHour = temporalDayHourKey(dayOfWeekUtc, hourUtc);
    if (!dayHour) return null;
    return `${dayHour}|${temporalMarketWeatherKey(marketWeatherKey)}`;
}

const PRIMARY_SESSION_BUCKET_SET = new Set(TEMPORAL_PRIMARY_SESSION_BUCKETS);
const TEMPORAL_DAY_BUCKET_SET = new Set(TEMPORAL_DAY_BUCKETS);
const TEMPORAL_SOURCE_SET = new Set([SOURCE_VIRTUAL, SOURCE_SHADOW]);
const TEMPORAL_POLICY_MODES = new Set(['OFF', 'OBSERVE', 'ENFORCE']);
const TEMPORAL_MAX_WINDOW_OUTCOMES = 50;
const TEMPORAL_MAX_WINDOW_AGE_DAYS = 180;
const TEMPORAL_MS_PER_DAY = 24 * 60 * 60 * 1000;
const TEMPORAL_FLOAT_TOLERANCE = 1e-9;

function temporalBoolean(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    if (value === 1 || value === '1') return true;
    if (value === 0 || value === '0') return false;
    const normalized = String(value ?? '').trim().toLowerCase();
    if (['true', 'yes', 'y', 'on', 'enabled'].includes(normalized)) return true;
    if (['false', 'no', 'n', 'off', 'disabled'].includes(normalized)) return false;
    return fallback;
}

export function temporalStatsEnabled() {
    return temporalBoolean(
        CONFIG.long?.temporal?.statsEnabled ??
        CONFIG.temporal?.statsEnabled ??
        process.env.TEMPORAL_STATS_ENABLED,
        true
    );
}

export function temporalPolicyMode() {
    if (!temporalStatsEnabled()) return 'OFF';
    const configured = String(
        CONFIG.long?.temporal?.policyMode ??
        CONFIG.temporal?.policyMode ??
        process.env.TEMPORAL_POLICY_MODE ??
        'OBSERVE'
    ).trim().toUpperCase();
    return TEMPORAL_POLICY_MODES.has(configured) ? configured : 'OBSERVE';
}

export function temporalRuntimeConfig() {
    const statsEnabled = temporalStatsEnabled();
    const policyMode = statsEnabled ? temporalPolicyMode() : 'OFF';
    return {
        temporalStatsEnabled: statsEnabled,
        temporalPolicyMode: policyMode,
        effectiveTemporalPolicyMode: policyMode,
        temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
        temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
        weekendPolicyVersion: WEEKEND_POLICY_VERSION,
        sessionPolicyVersion: SESSION_POLICY_VERSION,
        temporalGenerationSchemaVersion: TEMPORAL_GENERATION_SCHEMA_VERSION,
        temporalTaxonomyVersion: TEMPORAL_TAXONOMY_VERSION,
        temporalCostModelVersion: TEMPORAL_COST_MODEL_VERSION,
        temporalHourlyProfileVersion: TEMPORAL_HOURLY_PROFILE_VERSION,
        temporalMarketWeatherProfileVersion: TEMPORAL_MARKET_WEATHER_PROFILE_VERSION,
        btcDirectionRouterProfileVersion: BTC_DIRECTION_ROUTER_PROFILE_VERSION,
        btcDirectionRouterPolicyVersion: BTC_DIRECTION_ROUTER_POLICY_VERSION,
        temporalMarketWeatherKeys: TEMPORAL_MARKET_WEATHER_KEYS,
        btcRouterStates: BTC_ROUTER_STATES,
        temporalStatsCollecting: statsEnabled,
        temporalFreezeEnabled: statsEnabled,
        temporalActivationEnabled: statsEnabled,
        temporalDiscordFilteringEnabled: statsEnabled && policyMode === 'ENFORCE'
    };
}

function normalizeTimestampMs(value, fallback = now()) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
    return numeric < 10_000_000_000
        ? Math.floor(numeric * 1000)
        : Math.floor(numeric);
}

function temporalTimestamp(...values) {
    for (const value of values) {
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric > 0) {
            return normalizeTimestampMs(numeric);
        }
    }
    return now();
}

function uniqueTemporalStrings(values = []) {
    return [...new Set(
        (Array.isArray(values) ? values : [values])
          .flat(Infinity)
          .map((value) => String(value || '').trim().toUpperCase())
          .filter(Boolean)
    )];
}

export function buildTemporalContext(timestamp = now()) {
    const contextTs = temporalTimestamp(timestamp);
    const date = new Date(contextTs);
    const hourUtc = date.getUTCHours();
    const dayIndex = date.getUTCDay();
    const dayOfWeekUtc = DAY_OF_WEEK_UTC[dayIndex] || 'UNKNOWN';
    const isWeekend = dayIndex === 0 || dayIndex === 6;

    const asia = hourUtc >= 0 && hourUtc < 8;
    const europe = hourUtc >= 7 && hourUtc < 16;
    const us = hourUtc >= 13 && hourUtc < 22;

    const sessionTags = [];
    if (asia) sessionTags.push('ASIA');
    if (europe) sessionTags.push('EUROPE');
    if (us) sessionTags.push('US');

    let primarySessionBucket = 'OFF_HOURS';
    if (europe && us) primarySessionBucket = 'EU_US_OVERLAP';
    else if (asia && europe) primarySessionBucket = 'ASIA_EU_OVERLAP';
    else if (asia) primarySessionBucket = 'ASIA';
    else if (europe) primarySessionBucket = 'EUROPE';
    else if (us) primarySessionBucket = 'US';

    return {
        temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
        contextTs,
        hourUtc,
        hourBucket: temporalHourKey(hourUtc),
        dayOfWeekUtc,
        dayHourBucket: temporalDayHourKey(dayOfWeekUtc, hourUtc),
        dayType: isWeekend ? 'WEEKEND' : 'WEEKDAY',
        isWeekend,
        sessionTags,
        primarySessionBucket,
        sessionOverlap: sessionTags.length > 1,
        offHours: sessionTags.length === 0
    };
}

function normalizeTemporalContext(value = {}, fallbackTs = now()) {
    const source = value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
    const derived = buildTemporalContext(
        temporalTimestamp(source.contextTs, source.ts, fallbackTs)
    );
    const dayType = String(source.dayType || '').trim().toUpperCase();
    const explicitWeekend = source.isWeekend;
    const isWeekend = dayType === 'WEEKEND'
        ? true
        : dayType === 'WEEKDAY'
          ? false
          : typeof explicitWeekend === 'boolean'
            ? explicitWeekend
            : derived.isWeekend;
    const tags = uniqueTemporalStrings(source.sessionTags)
        .filter((tag) => ['ASIA', 'EUROPE', 'US'].includes(tag));
    const sessionTags = tags.length > 0 ? tags : derived.sessionTags;
    const requestedBucket = String(source.primarySessionBucket || '')
        .trim()
        .toUpperCase();
    const primarySessionBucket = PRIMARY_SESSION_BUCKET_SET.has(requestedBucket)
        ? requestedBucket
        : derived.primarySessionBucket;
    const requestedDay = String(source.dayOfWeekUtc || '')
        .trim()
        .toUpperCase();

    const hourUtc = Number.isInteger(Number(source.hourUtc))
        ? Math.max(0, Math.min(23, Number(source.hourUtc)))
        : derived.hourUtc;
    const dayOfWeekUtc = TEMPORAL_DAY_BUCKET_SET.has(requestedDay)
        ? requestedDay
        : derived.dayOfWeekUtc;

    return {
        temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
        temporalHourlyProfileVersion: TEMPORAL_HOURLY_PROFILE_VERSION,
        contextTs: derived.contextTs,
        hourUtc,
        hourBucket: temporalHourKey(hourUtc),
        dayOfWeekUtc,
        dayHourBucket: temporalDayHourKey(dayOfWeekUtc, hourUtc),
        dayType: isWeekend ? 'WEEKEND' : 'WEEKDAY',
        isWeekend,
        sessionTags,
        primarySessionBucket,
        sessionOverlap: typeof source.sessionOverlap === 'boolean'
          ? source.sessionOverlap
          : sessionTags.length > 1,
        offHours: typeof source.offHours === 'boolean'
          ? source.offHours
          : primarySessionBucket === 'OFF_HOURS'
    };
}

export function buildMarketEventClusterId(row = {}, contextInput = null) {
    const context = contextInput || resolveEntryTemporalContext(row);
    const explicit = String(
        row.marketEventClusterId ||
        row.scannerRunId ||
        row.marketCycleId ||
        row.snapshotId ||
        row.scanId ||
        row.batchId ||
        ''
    ).trim();
    if (explicit) return explicit;
    const utcHourWindow = Math.floor(normalizeTimestampMs(context.contextTs) / 3_600_000);
    return `${TARGET_TRADE_SIDE}:UTC60:${utcHourWindow}`;
}

export function resolveEntryTemporalContext(row = {}) {
    const nested = row.entryTemporalContext || row.temporalContext || {};
    return normalizeTemporalContext({
        ...nested,
        contextTs:
          row.entryTs ??
          row.openedAt ??
          row.entryAt ??
          row.createdAt ??
          row.observedAt ??
          row.contextTs ??
          row.ts,
        hourUtc: row.entryHourUtc ?? nested.hourUtc ?? row.hourUtc,
        dayOfWeekUtc: row.entryDayOfWeekUtc ?? nested.dayOfWeekUtc ?? row.dayOfWeekUtc,
        dayType: row.entryDayType ?? nested.dayType ?? row.dayType,
        isWeekend: row.entryIsWeekend ?? nested.isWeekend ?? row.isWeekend,
        sessionTags: row.entrySessionTags ?? nested.sessionTags ?? row.sessionTags,
        primarySessionBucket:
          row.entrySessionBucket ??
          nested.primarySessionBucket ??
          row.primarySessionBucket,
        sessionOverlap:
          row.entrySessionOverlap ??
          nested.sessionOverlap ??
          row.sessionOverlap,
        offHours: row.entryOffHours ?? nested.offHours ?? row.offHours
    }, temporalTimestamp(row.createdAt, row.observedAt, row.ts));
}

export function resolveExitTemporalContext(row = {}) {
    const nested = row.exitTemporalContext || {};
    return normalizeTemporalContext({
        ...nested,
        contextTs:
          row.exitTs ??
          row.closedAt ??
          row.completedAt ??
          row.exitAt ??
          row.updatedAt ??
          row.ts,
        hourUtc: row.exitHourUtc ?? nested.hourUtc,
        dayOfWeekUtc: row.exitDayOfWeekUtc ?? nested.dayOfWeekUtc,
        dayType: row.exitDayType ?? nested.dayType,
        isWeekend: row.exitIsWeekend ?? nested.isWeekend,
        sessionTags: row.exitSessionTags ?? nested.sessionTags,
        primarySessionBucket: row.exitSessionBucket ?? nested.primarySessionBucket,
        sessionOverlap: row.exitSessionOverlap ?? nested.sessionOverlap,
        offHours: row.exitOffHours ?? nested.offHours
    }, temporalTimestamp(row.closedAt, row.completedAt, row.updatedAt, row.ts));
}

export function temporalPolicyFlags(context = buildTemporalContext()) {
    const normalized = normalizeTemporalContext(context, context?.contextTs);
    const runtime = temporalRuntimeConfig();
    return {
        ...runtime,
        temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
        temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
        weekendPolicyVersion: WEEKEND_POLICY_VERSION,
        sessionPolicyVersion: SESSION_POLICY_VERSION,
        weekendLearningAllowed: true,
        weekendVirtualEntryAllowed: true,
        weekendDiscordEntryAllowed: runtime.temporalPolicyMode !== 'ENFORCE' || !normalized.isWeekend,
        weekendExitMonitoringAllowed: true,
        weekendOutcomeRecordingAllowed: true,
        sessionLearningAllowed: true,
        sessionVirtualEntryAllowed: true,
        sessionDiscordEntryAllowed: true,
        sessionPolicyObservedOnly: runtime.temporalPolicyMode !== 'ENFORCE',
        familyIdentityIncludesTemporalBucket: false
    };
}

export function entryTemporalFields(row = {}) {
    const context = resolveEntryTemporalContext(row);
    const weather = resolveEntryMarketWeatherContext(row);
    const marketEventClusterId = buildMarketEventClusterId(row, context);
    return {
        ...context,
        ...temporalPolicyFlags(context),
        temporalMarketWeatherProfileVersion: TEMPORAL_MARKET_WEATHER_PROFILE_VERSION,
        entryTs: context.contextTs,
        entryHourUtc: context.hourUtc,
        entryHourBucket: context.hourBucket,
        entryDayOfWeekUtc: context.dayOfWeekUtc,
        entryDayHourBucket: context.dayHourBucket,
        entryDayType: context.dayType,
        entryIsWeekend: context.isWeekend,
        entrySessionTags: [...context.sessionTags],
        entrySessionBucket: context.primarySessionBucket,
        entrySessionOverlap: context.sessionOverlap,
        entryOffHours: context.offHours,
        entryMarketWeatherKey: weather.marketWeatherKey,
        entryMarketWeatherRegime: weather.regime,
        entryMarketWeatherTrendSide: weather.trendSide,
        entryMarketWeatherAvailable: weather.available,
        entryMarketWeatherContext: weather,
        marketEventClusterId,
        entryTemporalContext: {
            ...context,
            marketEventClusterId
        }
    };
}

export function exitTemporalFields(row = {}) {
    const context = resolveExitTemporalContext(row);
    return {
        exitTs: context.contextTs,
        exitHourUtc: context.hourUtc,
        exitHourBucket: context.hourBucket,
        exitDayOfWeekUtc: context.dayOfWeekUtc,
        exitDayHourBucket: context.dayHourBucket,
        exitDayType: context.dayType,
        exitIsWeekend: context.isWeekend,
        exitSessionTags: [...context.sessionTags],
        exitSessionBucket: context.primarySessionBucket,
        exitSessionOverlap: context.sessionOverlap,
        exitOffHours: context.offHours,
        exitTemporalContext: context
    };
}

function createTemporalMetricBucket() {
    return {
        seen: 0,
        observations: 0,
        completed: 0,
        wins: 0,
        losses: 0,
        flats: 0,
        sumNetR: 0,
        sumNetR2: 0,
        sumNetPnlPct: 0,
        sumNetPnlPct2: 0,
        totalNetPnlPct: 0,
        avgNetPnlPct: 0,
        totalR: 0,
        avgNetR: 0,
        avgR: 0,
        variance: 0,
        sampleVariance: 0,
        standardError: 0,
        lcb95: 0,
        ucb95: 0,
        grossWinR: 0,
        grossLossR: 0,
        profitFactor: 0,
        winrate: 0,
        directSLCount: 0,
        directSLPct: 0,
        totalCostR: 0,
        avgCostR: 0,
        lastOutcomeTs: null,
        acceptedTemporalOutcomeSeq: 0
    };
}

export function createTemporalStatsShape() {
    return {
        ...temporalRuntimeConfig(),
        temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
        temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
        weekendPolicyVersion: WEEKEND_POLICY_VERSION,
        sessionPolicyVersion: SESSION_POLICY_VERSION,
        temporalTaxonomyVersion: TEMPORAL_TAXONOMY_VERSION,
        temporalCostModelVersion: TEMPORAL_COST_MODEL_VERSION,
        temporalHourlyProfileVersion: TEMPORAL_HOURLY_PROFILE_VERSION,
        temporalMarketWeatherProfileVersion: TEMPORAL_MARKET_WEATHER_PROFILE_VERSION,
        btcDirectionRouterProfileVersion: BTC_DIRECTION_ROUTER_PROFILE_VERSION,
        btcDirectionRouterPolicyVersion: BTC_DIRECTION_ROUTER_POLICY_VERSION,
        acceptedTemporalOutcomeSeq: 0,
        contextStats: Object.fromEntries(
            TEMPORAL_DAY_TYPE_BUCKETS.map((bucket) => [bucket, createTemporalMetricBucket()])
        ),
        dayTypeStats: Object.fromEntries(
            TEMPORAL_DAY_TYPE_BUCKETS.map((bucket) => [bucket, createTemporalMetricBucket()])
        ),
        dayOfWeekStats: Object.fromEntries(
            TEMPORAL_DAY_BUCKETS.map((bucket) => [bucket, createTemporalMetricBucket()])
        ),
        sessionStats: Object.fromEntries(
            TEMPORAL_PRIMARY_SESSION_BUCKETS.map((bucket) => [bucket, createTemporalMetricBucket()])
        ),
        hourOfDayStats: Object.fromEntries(
            TEMPORAL_HOUR_BUCKETS.map((bucket) => [bucket, createTemporalMetricBucket()])
        ),
        dayHourStats: Object.fromEntries(
            TEMPORAL_DAY_BUCKETS.map((day) => [
                day,
                Object.fromEntries(
                    TEMPORAL_HOUR_BUCKETS.map((bucket) => [bucket, createTemporalMetricBucket()])
                )
            ])
        ),
        marketWeatherStats: {},
        dayWeatherStats: Object.fromEntries(TEMPORAL_DAY_BUCKETS.map((day) => [day, {}])),
        hourWeatherStats: Object.fromEntries(TEMPORAL_HOUR_BUCKETS.map((hour) => [hour, {}])),
        dayHourWeatherStats: Object.fromEntries(
            TEMPORAL_DAY_BUCKETS.map((day) => [
                day,
                Object.fromEntries(TEMPORAL_HOUR_BUCKETS.map((hour) => [hour, {}]))
            ])
        ),
        btcRouterStats: {},
        dayBtcStats: Object.fromEntries(TEMPORAL_DAY_BUCKETS.map((day) => [day, {}])),
        hourBtcStats: Object.fromEntries(TEMPORAL_HOUR_BUCKETS.map((hour) => [hour, {}])),
        dayHourBtcStats: Object.fromEntries(
            TEMPORAL_DAY_BUCKETS.map((day) => [
                day,
                Object.fromEntries(TEMPORAL_HOUR_BUCKETS.map((hour) => [hour, {}]))
            ])
        ),
        marketWeatherBtcStats: {},
        dayWeatherBtcStats: Object.fromEntries(TEMPORAL_DAY_BUCKETS.map((day) => [day, {}])),
        hourWeatherBtcStats: Object.fromEntries(TEMPORAL_HOUR_BUCKETS.map((hour) => [hour, {}])),
        dayHourWeatherBtcStats: Object.fromEntries(
            TEMPORAL_DAY_BUCKETS.map((day) => [
                day,
                Object.fromEntries(TEMPORAL_HOUR_BUCKETS.map((hour) => [hour, {}]))
            ])
        ),
        weekendLearningAllowed: true,
        weekendVirtualEntryAllowed: true,
        weekendDiscordEntryAllowed: false,
        weekendExitMonitoringAllowed: true,
        weekendOutcomeRecordingAllowed: true,
        sessionLearningAllowed: true,
        sessionVirtualEntryAllowed: true,
        sessionDiscordEntryAllowed: true,
        familyIdentityIncludesTemporalBucket: false
    };
}

function normalizeTemporalMetricBucket(value = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
    const bucket = {
        ...createTemporalMetricBucket(),
        ...source
    };
    bucket.seen = Math.max(0, safeNumber(bucket.seen, 0));
    bucket.observations = Math.max(0, safeNumber(bucket.observations, bucket.seen));
    bucket.completed = Math.max(0, safeNumber(bucket.completed, 0));
    bucket.wins = Math.max(0, safeNumber(bucket.wins, 0));
    bucket.losses = Math.max(0, safeNumber(bucket.losses, 0));
    bucket.flats = Math.max(0, safeNumber(bucket.flats, 0));
    bucket.sumNetR = safeNumber(bucket.sumNetR ?? bucket.totalR, 0);
    bucket.sumNetR2 = Math.max(0, safeNumber(bucket.sumNetR2, 0));
    bucket.sumNetPnlPct = safeNumber(bucket.sumNetPnlPct ?? bucket.totalNetPnlPct, 0);
    bucket.sumNetPnlPct2 = Math.max(0, safeNumber(bucket.sumNetPnlPct2, 0));
    bucket.grossWinR = Math.max(0, safeNumber(bucket.grossWinR, 0));
    bucket.grossLossR = Math.max(0, safeNumber(bucket.grossLossR, 0));
    bucket.totalCostR = Math.max(0, safeNumber(bucket.totalCostR, 0));
    bucket.directSLCount = Math.max(0, safeNumber(bucket.directSLCount, 0));
    bucket.lastOutcomeTs = Number.isFinite(Number(bucket.lastOutcomeTs))
        ? normalizeTimestampMs(bucket.lastOutcomeTs)
        : null;
    bucket.acceptedTemporalOutcomeSeq = Math.max(
        0,
        Math.floor(safeNumber(bucket.acceptedTemporalOutcomeSeq, 0))
    );
    return refreshTemporalMetricBucket(bucket);
}

function normalizeSparseTemporalMetricMap(value = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return Object.fromEntries(
        Object.entries(source)
            .map(([key, bucket]) => [temporalMarketWeatherKey(key), bucket])
            .filter(([key]) => TEMPORAL_MARKET_WEATHER_KEY_SET.has(key))
            .map(([key, bucket]) => [key, normalizeTemporalMetricBucket(bucket)])
    );
}

function sparseTemporalMetricBucket(container = {}, key = 'UNKNOWN') {
    const normalizedKey = temporalMarketWeatherKey(key);
    if (!container[normalizedKey]) container[normalizedKey] = createTemporalMetricBucket();
    else container[normalizedKey] = normalizeTemporalMetricBucket(container[normalizedKey]);
    return container[normalizedKey];
}


function normalizeSparseBtcMetricMap(value = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return Object.fromEntries(
        Object.entries(source)
            .map(([key, bucket]) => [temporalBtcRouterKey(key), bucket])
            .filter(([key]) => BTC_ROUTER_STATE_SET.has(key))
            .map(([key, bucket]) => [key, normalizeTemporalMetricBucket(bucket)])
    );
}

function normalizeSparseWeatherBtcMetricMap(value = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return Object.fromEntries(
        Object.entries(source)
            .map(([weatherKey, btcMap]) => [
                temporalMarketWeatherKey(weatherKey),
                normalizeSparseBtcMetricMap(btcMap)
            ])
            .filter(([weatherKey]) => TEMPORAL_MARKET_WEATHER_KEY_SET.has(weatherKey))
    );
}

function sparseBtcMetricBucket(container = {}, key = 'UNKNOWN') {
    const normalizedKey = temporalBtcRouterKey(key);
    if (!container[normalizedKey]) container[normalizedKey] = createTemporalMetricBucket();
    else container[normalizedKey] = normalizeTemporalMetricBucket(container[normalizedKey]);
    return container[normalizedKey];
}

function sparseWeatherBtcMetricBucket(container = {}, weatherKey = 'UNKNOWN', btcState = 'UNKNOWN') {
    const normalizedWeather = temporalMarketWeatherKey(weatherKey);
    if (!container[normalizedWeather] || typeof container[normalizedWeather] !== 'object') {
        container[normalizedWeather] = {};
    }
    return sparseBtcMetricBucket(container[normalizedWeather], btcState);
}

function btcMetricBuckets(stats = {}) {
    return [
        ...Object.values(stats.btcRouterStats || {}),
        ...Object.values(stats.dayBtcStats || {}).flatMap((day) => Object.values(day || {})),
        ...Object.values(stats.hourBtcStats || {}).flatMap((hour) => Object.values(hour || {})),
        ...Object.values(stats.dayHourBtcStats || {}).flatMap((day) =>
            Object.values(day || {}).flatMap((hour) => Object.values(hour || {}))
        ),
        ...Object.values(stats.marketWeatherBtcStats || {}).flatMap((weather) => Object.values(weather || {})),
        ...Object.values(stats.dayWeatherBtcStats || {}).flatMap((day) =>
            Object.values(day || {}).flatMap((weather) => Object.values(weather || {}))
        ),
        ...Object.values(stats.hourWeatherBtcStats || {}).flatMap((hour) =>
            Object.values(hour || {}).flatMap((weather) => Object.values(weather || {}))
        ),
        ...Object.values(stats.dayHourWeatherBtcStats || {}).flatMap((day) =>
            Object.values(day || {}).flatMap((hour) =>
                Object.values(hour || {}).flatMap((weather) => Object.values(weather || {}))
            )
        )
    ];
}

function weatherMetricBuckets(stats = {}) {
    return [
        ...Object.values(stats.marketWeatherStats || {}),
        ...Object.values(stats.dayWeatherStats || {}).flatMap((day) => Object.values(day || {})),
        ...Object.values(stats.hourWeatherStats || {}).flatMap((hour) => Object.values(hour || {})),
        ...Object.values(stats.dayHourWeatherStats || {}).flatMap((day) =>
            Object.values(day || {}).flatMap((hour) => Object.values(hour || {}))
        ),
        ...btcMetricBuckets(stats)
    ];
}

function logGamma(value) {
    const coefficients = [
        676.5203681218851,
        -1259.1392167224028,
        771.32342877765313,
        -176.61502916214059,
        12.507343278686905,
        -0.13857109526572012,
        9.9843695780195716e-6,
        1.5056327351493116e-7
    ];
    if (value < 0.5) {
        return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
    }
    let x = 0.99999999999980993;
    const z = value - 1;
    for (let index = 0; index < coefficients.length; index += 1) {
        x += coefficients[index] / (z + index + 1);
    }
    const t = z + coefficients.length - 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function betaContinuedFraction(a, b, x) {
    const maxIterations = 200;
    const epsilon = 3e-14;
    const floor = 1e-300;
    const qab = a + b;
    const qap = a + 1;
    const qam = a - 1;
    let c = 1;
    let d = 1 - (qab * x) / qap;
    if (Math.abs(d) < floor) d = floor;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= maxIterations; m += 1) {
        const m2 = 2 * m;
        let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
        d = 1 + aa * d;
        if (Math.abs(d) < floor) d = floor;
        c = 1 + aa / c;
        if (Math.abs(c) < floor) c = floor;
        d = 1 / d;
        h *= d * c;
        aa = -((a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
        d = 1 + aa * d;
        if (Math.abs(d) < floor) d = floor;
        c = 1 + aa / c;
        if (Math.abs(c) < floor) c = floor;
        d = 1 / d;
        const delta = d * c;
        h *= delta;
        if (Math.abs(delta - 1) < epsilon) break;
    }
    return h;
}

function regularizedIncompleteBeta(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const logFront = logGamma(a + b) - logGamma(a) - logGamma(b) +
        a * Math.log(x) + b * Math.log(1 - x);
    const front = Math.exp(logFront);
    if (x < (a + 1) / (a + b + 2)) {
        return (front * betaContinuedFraction(a, b, x)) / a;
    }
    return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

export function studentTCdf(value, degreesOfFreedom) {
    const t = Number(value);
    const df = Number(degreesOfFreedom);
    if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return NaN;
    if (t === 0) return 0.5;
    const x = df / (df + t * t);
    const ibeta = regularizedIncompleteBeta(x, df / 2, 0.5);
    return t > 0 ? 1 - 0.5 * ibeta : 0.5 * ibeta;
}

export function studentTQuantile(probability, degreesOfFreedom) {
    const p = Number(probability);
    const df = Number(degreesOfFreedom);
    if (!(p > 0 && p < 1) || !(df > 0)) return NaN;
    if (p === 0.5) return 0;
    if (p < 0.5) return -studentTQuantile(1 - p, df);
    let low = 0;
    let high = 32;
    for (let index = 0; index < 90; index += 1) {
        const mid = (low + high) / 2;
        const cdf = studentTCdf(mid, df);
        if (cdf < p) low = mid;
        else high = mid;
    }
    return (low + high) / 2;
}

function refreshTemporalMetricBucket(bucket = {}) {
    const completed = Math.max(0, safeNumber(bucket.completed, 0));
    const sumNetR = safeNumber(bucket.sumNetR ?? bucket.totalR, 0);
    const sumNetR2 = Math.max(0, safeNumber(bucket.sumNetR2, 0));
    const mean = completed > 0 ? sumNetR / completed : 0;
    const sampleVariance = completed > 1
        ? Math.max(0, (sumNetR2 - (sumNetR * sumNetR) / completed) / (completed - 1))
        : 0;
    const standardError = completed > 1
        ? Math.sqrt(sampleVariance / completed)
        : 0;
    const critical = completed > 1 ? studentTQuantile(0.95, completed - 1) : 0;
    const sumNetPnlPct = safeNumber(bucket.sumNetPnlPct ?? bucket.totalNetPnlPct, 0);
    bucket.sumNetR = sumNetR;
    bucket.totalR = sumNetR;
    bucket.sumNetPnlPct = sumNetPnlPct;
    bucket.totalNetPnlPct = sumNetPnlPct;
    bucket.avgNetPnlPct = completed > 0 ? sumNetPnlPct / completed : 0;
    bucket.avgNetR = mean;
    bucket.avgR = mean;
    bucket.variance = completed > 0 ? Math.max(0, sumNetR2 / completed - mean * mean) : 0;
    bucket.sampleVariance = sampleVariance;
    bucket.standardError = standardError;
    bucket.lcb95 = completed > 1 ? mean - critical * standardError : mean;
    bucket.ucb95 = completed > 1 ? mean + critical * standardError : mean;
    bucket.avgCostR = completed > 0 ? safeNumber(bucket.totalCostR, 0) / completed : 0;
    bucket.directSLPct = completed > 0 ? safeNumber(bucket.directSLCount, 0) / completed : 0;
    bucket.winrate = completed > 0 ? safeNumber(bucket.wins, 0) / completed : 0;
    const grossLossR = Math.max(0, safeNumber(bucket.grossLossR, 0));
    const grossWinR = Math.max(0, safeNumber(bucket.grossWinR, 0));
    bucket.profitFactor = grossLossR > 0
        ? grossWinR / grossLossR
        : grossWinR > 0
          ? 999
          : 0;
    return bucket;
}

export function ensureTemporalStats(stats = {}) {
    const storedVersions = {
        temporalContextVersion: String(stats.temporalContextVersion || '').trim(),
        temporalPolicyVersion: String(stats.temporalPolicyVersion || '').trim(),
        taxonomyVersion: String(
            stats.temporalTaxonomyVersion || stats.taxonomyVersion || ''
        ).trim(),
        costModelVersion: String(
            stats.temporalCostModelVersion || stats.costModelVersion || ''
        ).trim()
    };
    const rawTemporalBuckets = [
        ...Object.values(stats.contextStats || stats.dayTypeStats || {}),
        ...Object.values(stats.dayOfWeekStats || {}),
        ...Object.values(stats.sessionStats || {}),
        ...Object.values(stats.hourOfDayStats || {}),
        ...Object.values(stats.dayHourStats || {}).flatMap((day) => Object.values(day || {})),
        ...weatherMetricBuckets(stats)
    ];
    const hadTemporalOutcomeData = rawTemporalBuckets.some((bucket) =>
        safeNumber(bucket?.completed, 0) > 0 ||
        Math.abs(safeNumber(bucket?.sumNetR ?? bucket?.totalR, 0)) > 0
    ) || safeNumber(stats.acceptedTemporalOutcomeSeq, 0) > 0;
    const temporalVersionsCompatible =
        storedVersions.temporalContextVersion === TEMPORAL_CONTEXT_VERSION &&
        storedVersions.temporalPolicyVersion === TEMPORAL_POLICY_VERSION &&
        storedVersions.taxonomyVersion === TEMPORAL_TAXONOMY_VERSION &&
        storedVersions.costModelVersion === TEMPORAL_COST_MODEL_VERSION;
    const resetIncompatibleTemporalOutcomes = hadTemporalOutcomeData &&
        !temporalVersionsCompatible;

    const contextSource = stats.contextStats && typeof stats.contextStats === 'object'
        ? stats.contextStats
        : stats.dayTypeStats && typeof stats.dayTypeStats === 'object'
          ? stats.dayTypeStats
          : {};
    const daySource = stats.dayOfWeekStats && typeof stats.dayOfWeekStats === 'object'
        ? stats.dayOfWeekStats
        : {};
    const sessionSource = stats.sessionStats && typeof stats.sessionStats === 'object'
        ? stats.sessionStats
        : {};
    const hourSource = stats.hourOfDayStats && typeof stats.hourOfDayStats === 'object'
        ? stats.hourOfDayStats
        : {};
    const dayHourSource = stats.dayHourStats && typeof stats.dayHourStats === 'object'
        ? stats.dayHourStats
        : {};
    const marketWeatherSource = stats.marketWeatherStats && typeof stats.marketWeatherStats === 'object'
        ? stats.marketWeatherStats
        : {};
    const dayWeatherSource = stats.dayWeatherStats && typeof stats.dayWeatherStats === 'object'
        ? stats.dayWeatherStats
        : {};
    const hourWeatherSource = stats.hourWeatherStats && typeof stats.hourWeatherStats === 'object'
        ? stats.hourWeatherStats
        : {};
    const dayHourWeatherSource = stats.dayHourWeatherStats && typeof stats.dayHourWeatherStats === 'object'
        ? stats.dayHourWeatherStats
        : {};
    const btcRouterSource = stats.btcRouterStats && typeof stats.btcRouterStats === 'object'
        ? stats.btcRouterStats : {};
    const dayBtcSource = stats.dayBtcStats && typeof stats.dayBtcStats === 'object'
        ? stats.dayBtcStats : {};
    const hourBtcSource = stats.hourBtcStats && typeof stats.hourBtcStats === 'object'
        ? stats.hourBtcStats : {};
    const dayHourBtcSource = stats.dayHourBtcStats && typeof stats.dayHourBtcStats === 'object'
        ? stats.dayHourBtcStats : {};
    const marketWeatherBtcSource = stats.marketWeatherBtcStats && typeof stats.marketWeatherBtcStats === 'object'
        ? stats.marketWeatherBtcStats : {};
    const dayWeatherBtcSource = stats.dayWeatherBtcStats && typeof stats.dayWeatherBtcStats === 'object'
        ? stats.dayWeatherBtcStats : {};
    const hourWeatherBtcSource = stats.hourWeatherBtcStats && typeof stats.hourWeatherBtcStats === 'object'
        ? stats.hourWeatherBtcStats : {};
    const dayHourWeatherBtcSource = stats.dayHourWeatherBtcStats && typeof stats.dayHourWeatherBtcStats === 'object'
        ? stats.dayHourWeatherBtcStats : {};
    const dayTypeStats = Object.fromEntries(
        TEMPORAL_DAY_TYPE_BUCKETS.map((bucket) => [
            bucket,
            normalizeTemporalMetricBucket(contextSource[bucket])
        ])
    );
    stats.contextStats = dayTypeStats;
    stats.dayTypeStats = dayTypeStats;
    stats.dayOfWeekStats = Object.fromEntries(
        TEMPORAL_DAY_BUCKETS.map((bucket) => [
            bucket,
            normalizeTemporalMetricBucket(daySource[bucket])
        ])
    );
    stats.sessionStats = Object.fromEntries(
        TEMPORAL_PRIMARY_SESSION_BUCKETS.map((bucket) => [
            bucket,
            normalizeTemporalMetricBucket(sessionSource[bucket])
        ])
    );
    stats.hourOfDayStats = Object.fromEntries(
        TEMPORAL_HOUR_BUCKETS.map((bucket) => [
            bucket,
            normalizeTemporalMetricBucket(hourSource[bucket])
        ])
    );
    stats.dayHourStats = Object.fromEntries(
        TEMPORAL_DAY_BUCKETS.map((day) => [
            day,
            Object.fromEntries(
                TEMPORAL_HOUR_BUCKETS.map((bucket) => [
                    bucket,
                    normalizeTemporalMetricBucket(dayHourSource?.[day]?.[bucket])
                ])
            )
        ])
    );
    stats.marketWeatherStats = normalizeSparseTemporalMetricMap(marketWeatherSource);
    stats.dayWeatherStats = Object.fromEntries(
        TEMPORAL_DAY_BUCKETS.map((day) => [
            day,
            normalizeSparseTemporalMetricMap(dayWeatherSource?.[day])
        ])
    );
    stats.hourWeatherStats = Object.fromEntries(
        TEMPORAL_HOUR_BUCKETS.map((hour) => [
            hour,
            normalizeSparseTemporalMetricMap(hourWeatherSource?.[hour])
        ])
    );
    stats.dayHourWeatherStats = Object.fromEntries(
        TEMPORAL_DAY_BUCKETS.map((day) => [
            day,
            Object.fromEntries(
                TEMPORAL_HOUR_BUCKETS.map((hour) => [
                    hour,
                    normalizeSparseTemporalMetricMap(dayHourWeatherSource?.[day]?.[hour])
                ])
            )
        ])
    );
    stats.btcRouterStats = normalizeSparseBtcMetricMap(btcRouterSource);
    stats.dayBtcStats = Object.fromEntries(
        TEMPORAL_DAY_BUCKETS.map((day) => [day, normalizeSparseBtcMetricMap(dayBtcSource?.[day])])
    );
    stats.hourBtcStats = Object.fromEntries(
        TEMPORAL_HOUR_BUCKETS.map((hour) => [hour, normalizeSparseBtcMetricMap(hourBtcSource?.[hour])])
    );
    stats.dayHourBtcStats = Object.fromEntries(
        TEMPORAL_DAY_BUCKETS.map((day) => [
            day,
            Object.fromEntries(TEMPORAL_HOUR_BUCKETS.map((hour) => [
                hour,
                normalizeSparseBtcMetricMap(dayHourBtcSource?.[day]?.[hour])
            ]))
        ])
    );
    stats.marketWeatherBtcStats = normalizeSparseWeatherBtcMetricMap(marketWeatherBtcSource);
    stats.dayWeatherBtcStats = Object.fromEntries(
        TEMPORAL_DAY_BUCKETS.map((day) => [
            day,
            normalizeSparseWeatherBtcMetricMap(dayWeatherBtcSource?.[day])
        ])
    );
    stats.hourWeatherBtcStats = Object.fromEntries(
        TEMPORAL_HOUR_BUCKETS.map((hour) => [
            hour,
            normalizeSparseWeatherBtcMetricMap(hourWeatherBtcSource?.[hour])
        ])
    );
    stats.dayHourWeatherBtcStats = Object.fromEntries(
        TEMPORAL_DAY_BUCKETS.map((day) => [
            day,
            Object.fromEntries(TEMPORAL_HOUR_BUCKETS.map((hour) => [
                hour,
                normalizeSparseWeatherBtcMetricMap(dayHourWeatherBtcSource?.[day]?.[hour])
            ]))
        ])
    );
    stats.acceptedTemporalOutcomeSeq = Math.max(
        0,
        Math.floor(safeNumber(stats.acceptedTemporalOutcomeSeq, 0))
    );
    if (resetIncompatibleTemporalOutcomes) {
        const buckets = [
            ...Object.values(stats.dayTypeStats),
            ...Object.values(stats.dayOfWeekStats),
            ...Object.values(stats.sessionStats),
            ...Object.values(stats.hourOfDayStats),
            ...Object.values(stats.dayHourStats).flatMap((day) => Object.values(day || {})),
            ...weatherMetricBuckets(stats)
        ];
        for (const bucket of buckets) {
            const seen = safeNumber(bucket.seen, 0);
            const observations = safeNumber(bucket.observations, seen);
            Object.assign(bucket, createTemporalMetricBucket(), { seen, observations });
        }
        stats.acceptedTemporalOutcomeSeq = 0;
        stats.temporalOutcomeMigrationRequired = true;
        stats.temporalOutcomeMigrationReason = 'INCOMPATIBLE_TEMPORAL_VERSION_RESET_REQUIRES_BACKFILL';
        stats.previousTemporalVersions = storedVersions;
        stats.temporalOutcomeMigrationAt = now();
    }
    Object.assign(stats, temporalRuntimeConfig(), {
        temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
        temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
        weekendPolicyVersion: WEEKEND_POLICY_VERSION,
        sessionPolicyVersion: SESSION_POLICY_VERSION,
        temporalTaxonomyVersion: TEMPORAL_TAXONOMY_VERSION,
        temporalCostModelVersion: TEMPORAL_COST_MODEL_VERSION,
        temporalHourlyProfileVersion: TEMPORAL_HOURLY_PROFILE_VERSION,
        temporalMarketWeatherProfileVersion: TEMPORAL_MARKET_WEATHER_PROFILE_VERSION,
        btcDirectionRouterProfileVersion: BTC_DIRECTION_ROUTER_PROFILE_VERSION,
        btcDirectionRouterPolicyVersion: BTC_DIRECTION_ROUTER_POLICY_VERSION,
        temporalMarketWeatherKeys: TEMPORAL_MARKET_WEATHER_KEYS,
        btcRouterStates: BTC_ROUTER_STATES,
        weekendLearningAllowed: true,
        weekendVirtualEntryAllowed: true,
        weekendDiscordEntryAllowed: false,
        weekendExitMonitoringAllowed: true,
        weekendOutcomeRecordingAllowed: true,
        sessionLearningAllowed: true,
        sessionVirtualEntryAllowed: true,
        sessionDiscordEntryAllowed: true,
        familyIdentityIncludesTemporalBucket: false
    });
    return stats;
}

function temporalBucketsForContext(stats, context, row = {}) {
    const hourBucket = temporalHourKey(context.hourUtc);
    const weather = resolveEntryMarketWeatherContext(row);
    const weatherKey = weather.marketWeatherKey;
    const btc = resolveEntryBtcRouterContext({
        ...row,
        entryMarketWeatherKey: weatherKey,
        entryMarketWeatherRegime: weather.regime,
        entryMarketWeatherTrendSide: weather.trendSide
    });
    const btcState = btc.btcRouterState;
    const weatherBuckets = [
        sparseTemporalMetricBucket(stats.marketWeatherStats, weatherKey),
        sparseTemporalMetricBucket(stats.dayWeatherStats?.[context.dayOfWeekUtc], weatherKey),
        sparseTemporalMetricBucket(stats.hourWeatherStats?.[hourBucket], weatherKey),
        sparseTemporalMetricBucket(
            stats.dayHourWeatherStats?.[context.dayOfWeekUtc]?.[hourBucket],
            weatherKey
        )
    ];
    const btcBuckets = [
        sparseBtcMetricBucket(stats.btcRouterStats, btcState),
        sparseBtcMetricBucket(stats.dayBtcStats?.[context.dayOfWeekUtc], btcState),
        sparseBtcMetricBucket(stats.hourBtcStats?.[hourBucket], btcState),
        sparseBtcMetricBucket(stats.dayHourBtcStats?.[context.dayOfWeekUtc]?.[hourBucket], btcState),
        sparseWeatherBtcMetricBucket(stats.marketWeatherBtcStats, weatherKey, btcState),
        sparseWeatherBtcMetricBucket(stats.dayWeatherBtcStats?.[context.dayOfWeekUtc], weatherKey, btcState),
        sparseWeatherBtcMetricBucket(stats.hourWeatherBtcStats?.[hourBucket], weatherKey, btcState),
        sparseWeatherBtcMetricBucket(
            stats.dayHourWeatherBtcStats?.[context.dayOfWeekUtc]?.[hourBucket],
            weatherKey,
            btcState
        )
    ];
    return [
        stats.dayTypeStats[context.dayType],
        stats.dayOfWeekStats[context.dayOfWeekUtc],
        stats.sessionStats[context.primarySessionBucket],
        stats.hourOfDayStats?.[hourBucket],
        stats.dayHourStats?.[context.dayOfWeekUtc]?.[hourBucket],
        ...weatherBuckets,
        ...btcBuckets
    ].filter(Boolean);
}

export function recordTemporalObservation(stats = {}, row = {}) {
    ensureTemporalStats(stats);
    const context = resolveEntryTemporalContext(row);
    if (!temporalStatsEnabled() || !statsRepresentsExactChild(stats)) return context;
    for (const bucket of temporalBucketsForContext(stats, context, row)) {
        bucket.seen = safeNumber(bucket.seen, 0) + 1;
        bucket.observations = safeNumber(bucket.observations, 0) + 1;
        refreshTemporalMetricBucket(bucket);
    }
    stats.lastTemporalContext = context;
    stats.lastObservationTemporalContext = context;
    stats.lastObservationDayType = context.dayType;
    stats.lastObservationDayOfWeekUtc = context.dayOfWeekUtc;
    stats.lastObservationHourUtc = context.hourUtc;
    stats.lastObservationHourBucket = context.hourBucket;
    const weather = resolveEntryMarketWeatherContext(row);
    stats.lastObservationDayHourBucket = context.dayHourBucket;
    stats.lastObservationMarketWeatherKey = weather.marketWeatherKey;
    stats.lastObservationMarketWeatherRegime = weather.regime;
    stats.lastObservationMarketWeatherTrendSide = weather.trendSide;
    const btc = resolveEntryBtcRouterContext(row);
    stats.lastObservationBtcRouterState = btc.btcRouterState;
    stats.lastObservationBtcDirection = btc.direction;
    stats.lastObservationBtcConfidence = btc.confidence;
    stats.lastObservationBtcTrendStrength = btc.trendStrength;
    stats.lastObservationBtcBreadthConfirmed = btc.breadthConfirmed;
    stats.lastObservationSessionBucket = context.primarySessionBucket;
    return context;
}

function statsRepresentsExactChild(stats = {}) {
    const id = String(
        stats.childTrueMicroFamilyId ||
        stats.trueMicroFamilyId ||
        stats.microFamilyId ||
        ''
    ).trim().toUpperCase();
    return /^MICRO_LONG_(BREAKOUT|RETEST|SWEEP_REVERSAL|CONTINUATION|COMPRESSION)_(TREND|CHOP|SQUEEZE)_(A_STRONG_ALIGN|B_FLOW_ALIGN|C_VOLUME_ALIGN|D_MIXED_OK|E_WEAK_CONTRA)$/.test(id);
}

export function recordTemporalOutcome(stats = {}, row = {}, metrics = {}) {
    ensureTemporalStats(stats);
    const context = resolveEntryTemporalContext(row);
    if (!temporalStatsEnabled() || !statsRepresentsExactChild(stats)) return context;
    const netR = Number(metrics.netR ?? row.netR ?? row.exitR);
    if (!Number.isFinite(netR)) return context;
    const grossR = safeNumber(metrics.grossR ?? row.grossR ?? row.rawR, netR);
    const costR = Math.max(0, safeNumber(metrics.costR ?? row.costR, Math.max(0, grossR - netR)));
    const directSL = Boolean(metrics.directSL ?? row.directSL ?? row.directToSL);
    const rawNetPnlPct = Number(
        metrics.netPnlPct ?? row.netPnlPct ?? row.pnlPct ?? row.realizedNetPnlPct
    );
    const netPnlPct = Number.isFinite(rawNetPnlPct) ? rawNetPnlPct : 0;
    const outcomeTs = temporalTimestamp(
        row.outcomePersistedTs,
        row.outcomeFinalizedTs,
        row.exitTs,
        row.closedAt,
        row.completedAt,
        now()
    );
    const nextSequence = Math.max(0, safeNumber(stats.acceptedTemporalOutcomeSeq, 0)) + 1;
    stats.acceptedTemporalOutcomeSeq = nextSequence;
    if (statsRepresentsExactChild(stats)) {
        row.acceptedTemporalOutcomeSeq = nextSequence;
    }
    for (const bucket of temporalBucketsForContext(stats, context, row)) {
        bucket.completed = safeNumber(bucket.completed, 0) + 1;
        bucket.wins = safeNumber(bucket.wins, 0) + (netR > 0 ? 1 : 0);
        bucket.losses = safeNumber(bucket.losses, 0) + (netR < 0 ? 1 : 0);
        bucket.flats = safeNumber(bucket.flats, 0) + (netR === 0 ? 1 : 0);
        bucket.sumNetR = safeNumber(bucket.sumNetR, 0) + netR;
        bucket.sumNetR2 = safeNumber(bucket.sumNetR2, 0) + netR * netR;
        bucket.sumNetPnlPct = safeNumber(bucket.sumNetPnlPct, 0) + netPnlPct;
        bucket.sumNetPnlPct2 = safeNumber(bucket.sumNetPnlPct2, 0) + netPnlPct * netPnlPct;
        bucket.grossWinR = safeNumber(bucket.grossWinR, 0) + (netR > 0 ? netR : 0);
        bucket.grossLossR = safeNumber(bucket.grossLossR, 0) + (netR < 0 ? Math.abs(netR) : 0);
        bucket.directSLCount = safeNumber(bucket.directSLCount, 0) + (directSL ? 1 : 0);
        bucket.totalCostR = safeNumber(bucket.totalCostR, 0) + costR;
        bucket.lastOutcomeTs = outcomeTs;
        bucket.acceptedTemporalOutcomeSeq = nextSequence;
        refreshTemporalMetricBucket(bucket);
    }
    stats.lastOutcomeTemporalContext = context;
    stats.lastOutcomeDayType = context.dayType;
    stats.lastOutcomeDayOfWeekUtc = context.dayOfWeekUtc;
    stats.lastOutcomeHourUtc = context.hourUtc;
    stats.lastOutcomeHourBucket = context.hourBucket;
    const weather = resolveEntryMarketWeatherContext(row);
    stats.lastOutcomeDayHourBucket = context.dayHourBucket;
    stats.lastOutcomeMarketWeatherKey = weather.marketWeatherKey;
    stats.lastOutcomeMarketWeatherRegime = weather.regime;
    stats.lastOutcomeMarketWeatherTrendSide = weather.trendSide;
    const btc = resolveEntryBtcRouterContext(row);
    stats.lastOutcomeBtcRouterState = btc.btcRouterState;
    stats.lastOutcomeBtcDirection = btc.direction;
    stats.lastOutcomeBtcConfidence = btc.confidence;
    stats.lastOutcomeBtcTrendStrength = btc.trendStrength;
    stats.lastOutcomeBtcBreadthConfirmed = btc.breadthConfirmed;
    stats.lastOutcomeSessionBucket = context.primarySessionBucket;
    stats.lastTemporalOutcomeTs = outcomeTs;
    return context;
}

export function resetTemporalOutcomeMetrics(stats = {}) {
    ensureTemporalStats(stats);
    const buckets = [
        ...Object.values(stats.dayTypeStats),
        ...Object.values(stats.dayOfWeekStats),
        ...Object.values(stats.sessionStats),
        ...Object.values(stats.hourOfDayStats),
        ...Object.values(stats.dayHourStats).flatMap((day) => Object.values(day || {})),
        ...weatherMetricBuckets(stats)
    ];
    for (const bucket of buckets) {
        const seen = safeNumber(bucket.seen, 0);
        const observations = safeNumber(bucket.observations, 0);
        Object.assign(bucket, createTemporalMetricBucket(), { seen, observations });
    }
    stats.acceptedTemporalOutcomeSeq = 0;
    return stats;
}

function exactLongChildFamilyId(value) {
    const id = String(value || '').trim().toUpperCase();
    return /^MICRO_LONG_(BREAKOUT|RETEST|SWEEP_REVERSAL|CONTINUATION|COMPRESSION)_(TREND|CHOP|SQUEEZE)_(A_STRONG_ALIGN|B_FLOW_ALIGN|C_VOLUME_ALIGN|D_MIXED_OK|E_WEAK_CONTRA)$/.test(id)
        ? id
        : null;
}

function temporalOutcomeCanonicalId(row = {}) {
    const value = String(
        row.canonicalOutcomeId ||
        row.canonicalPositionId ||
        row.outcomeId ||
        row.positionId ||
        ''
    ).trim();
    return value || null;
}

function rowVersion(row = {}, keys = []) {
    for (const key of keys) {
        const value = String(row[key] || '').trim();
        if (value) return value;
    }
    return '';
}

export function normalizeTemporalOutcome(row = {}, expectedFamilyId = null) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const familyId = exactLongChildFamilyId(
        row.trueMicroFamilyId || row.childTrueMicroFamilyId || row.microFamilyId
    );
    if (!familyId || (expectedFamilyId && familyId !== exactLongChildFamilyId(expectedFamilyId))) {
        return null;
    }
    const source = String(row.source || row.outcomeSource || '').trim().toUpperCase();
    if (!TEMPORAL_SOURCE_SET.has(source)) return null;
    const side = sideToTradeSide(
        row.tradeSide || row.positionSide || row.direction || row.side || TARGET_TRADE_SIDE
    );
    if (side !== TARGET_TRADE_SIDE) return null;
    const netR = Number(row.netR ?? row.exitR ?? row.netPnlR);
    if (!Number.isFinite(netR)) return null;
    const canonicalOutcomeId = temporalOutcomeCanonicalId(row);
    if (!canonicalOutcomeId) return null;
    const entryContext = resolveEntryTemporalContext(row);
    const exitContext = resolveExitTemporalContext(row);
    const entryTs = normalizeTimestampMs(row.entryTs ?? entryContext.contextTs, 0);
    const exitTs = normalizeTimestampMs(row.exitTs ?? row.closedAt ?? row.completedAt ?? exitContext.contextTs, 0);
    const outcomeFinalizedTs = normalizeTimestampMs(
        row.outcomeFinalizedTs ?? row.finalizedAt ?? row.closedAt ?? row.completedAt,
        0
    );
    const outcomePersistedTs = normalizeTimestampMs(
        row.outcomePersistedTs ?? row.persistedAt ?? row.recordedAt ?? row.updatedAt,
        0
    );
    if (!(entryTs > 0 && exitTs > 0 && outcomeFinalizedTs > 0 && outcomePersistedTs > 0)) {
        return null;
    }
    const measurementVersion = rowVersion(row, [
        'measurementFixVersion',
        'outcomeMeasurementVersion',
        'acceptedOutcomeMeasurementVersion'
    ]);
    const costModelVersion = rowVersion(row, [
        'costModelVersion',
        'exitFillModelVersion'
    ]);
    const taxonomyVersion = rowVersion(row, [
        'taxonomyVersion',
        'trueMicroFamilySchema',
        'childTrueMicroFamilySchema'
    ]);
    const temporalContextVersion = rowVersion(row, ['temporalContextVersion']);
    if (measurementVersion !== MEASUREMENT_FIX_VERSION) return null;
    if (costModelVersion !== TEMPORAL_COST_MODEL_VERSION) return null;
    if (taxonomyVersion !== TEMPORAL_TAXONOMY_VERSION) return null;
    if (temporalContextVersion !== TEMPORAL_CONTEXT_VERSION) return null;
    return {
        ...row,
        familyId,
        trueMicroFamilyId: familyId,
        source,
        canonicalOutcomeId,
        canonicalPositionId: String(row.canonicalPositionId || canonicalOutcomeId),
        netR,
        netPnlPct: safeNumber(
            row.netPnlPct ?? row.pnlPct ?? row.realizedNetPnlPct,
            0
        ),
        grossR: safeNumber(row.grossR ?? row.rawR, netR),
        costR: Math.max(0, safeNumber(row.costR, 0)),
        directSL: Boolean(row.directSL ?? row.directToSL),
        symbol: String(row.symbol || row.baseSymbol || row.contractSymbol || 'UNKNOWN').trim().toUpperCase(),
        entryTs,
        exitTs,
        outcomeFinalizedTs,
        outcomePersistedTs,
        entryHourUtc: entryContext.hourUtc,
        entryHourBucket: entryContext.hourBucket,
        entryDayOfWeekUtc: entryContext.dayOfWeekUtc,
        entryDayHourBucket: entryContext.dayHourBucket,
        entryDayType: entryContext.dayType,
        entrySessionBucket: entryContext.primarySessionBucket,
        entrySessionTags: [...entryContext.sessionTags],
        entryIsWeekend: entryContext.isWeekend,
        ...(() => {
            const weather = resolveEntryMarketWeatherContext(row);
            const btc = resolveEntryBtcRouterContext({
                ...row,
                entryMarketWeatherKey: weather.marketWeatherKey,
                entryMarketWeatherRegime: weather.regime,
                entryMarketWeatherTrendSide: weather.trendSide
            });
            return {
                entryMarketWeatherKey: weather.marketWeatherKey,
                entryMarketWeatherRegime: weather.regime,
                entryMarketWeatherTrendSide: weather.trendSide,
                entryMarketWeatherAvailable: weather.available,
                entryBtcRouterState: btc.btcRouterState,
                entryBtcDirection: btc.direction,
                entryBtcConfidence: btc.confidence,
                entryBtcTrendStrength: btc.trendStrength,
                entryBtcBullishPct: btc.bullishPct,
                entryBtcBearishPct: btc.bearishPct,
                entryBtcAlignedBreadthPct: btc.alignedBreadthPct,
                entryBtcBreadthConfirmed: btc.breadthConfirmed,
                entryBtcAgainstLong: btc.againstLong,
                btcDirectionRouterProfileVersion: BTC_DIRECTION_ROUTER_PROFILE_VERSION,
                btcDirectionRouterPolicyVersion: BTC_DIRECTION_ROUTER_POLICY_VERSION
            };
        })(),
        marketEventClusterId: buildMarketEventClusterId(row, entryContext),
        acceptedTemporalOutcomeSeq: Math.max(0, Math.floor(safeNumber(row.acceptedTemporalOutcomeSeq, 0))),
        measurementVersion,
        costModelVersion,
        taxonomyVersion,
        temporalContextVersion
    };
}

function temporalBucketMatches(row, bucketType, bucketValue) {
    if (bucketType === 'dayType') return row.entryDayType === bucketValue;
    if (bucketType === 'dayOfWeek') return row.entryDayOfWeekUtc === bucketValue;
    if (bucketType === 'session') return row.entrySessionBucket === bucketValue;
    if (bucketType === 'hourOfDay') {
        return temporalHourKey(row.entryHourUtc) === temporalHourKey(bucketValue);
    }
    if (bucketType === 'dayHour') {
        const expected = String(bucketValue || '').trim().toUpperCase();
        return temporalDayHourKey(row.entryDayOfWeekUtc, row.entryHourUtc) === expected;
    }
    if (bucketType === 'marketWeather') {
        return temporalMarketWeatherKey(row.entryMarketWeatherKey) === temporalMarketWeatherKey(bucketValue);
    }
    if (bucketType === 'dayWeather') {
        return temporalDayWeatherKey(row.entryDayOfWeekUtc, row.entryMarketWeatherKey) ===
            String(bucketValue || '').trim().toUpperCase();
    }
    if (bucketType === 'hourWeather') {
        return temporalHourWeatherKey(row.entryHourUtc, row.entryMarketWeatherKey) ===
            String(bucketValue || '').trim().toUpperCase();
    }
    if (bucketType === 'dayHourWeather') {
        return temporalDayHourWeatherKey(
            row.entryDayOfWeekUtc,
            row.entryHourUtc,
            row.entryMarketWeatherKey
        ) === String(bucketValue || '').trim().toUpperCase();
    }
    if (bucketType === 'btcRouter') {
        return temporalBtcRouterKey(row.entryBtcRouterState) === temporalBtcRouterKey(bucketValue);
    }
    if (bucketType === 'marketWeatherBtc') {
        return temporalMarketWeatherBtcKey(row.entryMarketWeatherKey, row.entryBtcRouterState) ===
            String(bucketValue || '').trim().toUpperCase();
    }
    if (bucketType === 'dayBtc') {
        return temporalDayBtcKey(row.entryDayOfWeekUtc, row.entryBtcRouterState) ===
            String(bucketValue || '').trim().toUpperCase();
    }
    if (bucketType === 'hourBtc') {
        return temporalHourBtcKey(row.entryHourUtc, row.entryBtcRouterState) ===
            String(bucketValue || '').trim().toUpperCase();
    }
    if (bucketType === 'dayHourBtc') {
        return temporalDayHourBtcKey(row.entryDayOfWeekUtc, row.entryHourUtc, row.entryBtcRouterState) ===
            String(bucketValue || '').trim().toUpperCase();
    }
    if (bucketType === 'dayWeatherBtc') {
        return temporalDayWeatherBtcKey(
            row.entryDayOfWeekUtc,
            row.entryMarketWeatherKey,
            row.entryBtcRouterState
        ) === String(bucketValue || '').trim().toUpperCase();
    }
    if (bucketType === 'hourWeatherBtc') {
        return temporalHourWeatherBtcKey(
            row.entryHourUtc,
            row.entryMarketWeatherKey,
            row.entryBtcRouterState
        ) === String(bucketValue || '').trim().toUpperCase();
    }
    if (bucketType === 'dayHourWeatherBtc') {
        return temporalDayHourWeatherBtcKey(
            row.entryDayOfWeekUtc,
            row.entryHourUtc,
            row.entryMarketWeatherKey,
            row.entryBtcRouterState
        ) === String(bucketValue || '').trim().toUpperCase();
    }
    return true;
}

export function prepareTemporalOutcomePool(outcomes = [], {
    familyId,
    cutoffTs = now(),
    maxAgeDays = TEMPORAL_MAX_WINDOW_AGE_DAYS
} = {}) {
    const normalizedCutoffTs = normalizeTimestampMs(cutoffTs);
    const minimumEntryTs = normalizedCutoffTs - Math.max(1, maxAgeDays) * TEMPORAL_MS_PER_DAY;
    const deduped = new Map();
    for (const raw of Array.isArray(outcomes) ? outcomes : []) {
        const row = normalizeTemporalOutcome(raw, familyId);
        if (!row) continue;
        if (row.entryTs < minimumEntryTs || row.entryTs > normalizedCutoffTs) continue;
        if (row.exitTs > normalizedCutoffTs) continue;
        if (row.outcomeFinalizedTs > normalizedCutoffTs) continue;
        if (row.outcomePersistedTs > normalizedCutoffTs) continue;
        const existing = deduped.get(row.canonicalOutcomeId);
        if (!existing || row.outcomePersistedTs < existing.outcomePersistedTs) {
            deduped.set(row.canonicalOutcomeId, row);
        }
    }
    return [...deduped.values()].sort((left, right) => {
        if (right.entryTs !== left.entryTs) return right.entryTs - left.entryTs;
        return left.canonicalOutcomeId.localeCompare(right.canonicalOutcomeId);
    });
}

export function buildTemporalGateWindowFromPrepared(preparedOutcomes = [], {
    bucketType,
    bucketValue,
    maxOutcomes = TEMPORAL_MAX_WINDOW_OUTCOMES
} = {}) {
    return (Array.isArray(preparedOutcomes) ? preparedOutcomes : [])
        .filter((row) => temporalBucketMatches(row, bucketType, bucketValue))
        .slice(0, Math.max(1, Math.min(TEMPORAL_MAX_WINDOW_OUTCOMES, maxOutcomes)));
}

export function buildTemporalGateWindow(outcomes = [], {
    familyId,
    bucketType,
    bucketValue,
    cutoffTs = now(),
    maxOutcomes = TEMPORAL_MAX_WINDOW_OUTCOMES,
    maxAgeDays = TEMPORAL_MAX_WINDOW_AGE_DAYS
} = {}) {
    const prepared = prepareTemporalOutcomePool(outcomes, {
        familyId,
        cutoffTs,
        maxAgeDays
    });
    return buildTemporalGateWindowFromPrepared(prepared, {
        bucketType,
        bucketValue,
        maxOutcomes
    });
}

export function computeTemporalWindowStats(members = []) {
    const rows = Array.isArray(members) ? members : [];
    const bucket = createTemporalMetricBucket();
    for (const row of rows) {
        const netR = Number(row.netR);
        if (!Number.isFinite(netR)) continue;
        bucket.completed += 1;
        bucket.wins += netR > 0 ? 1 : 0;
        bucket.losses += netR < 0 ? 1 : 0;
        bucket.flats += netR === 0 ? 1 : 0;
        bucket.sumNetR += netR;
        bucket.sumNetR2 += netR * netR;
        const netPnlPct = safeNumber(
            row.netPnlPct ?? row.pnlPct ?? row.realizedNetPnlPct,
            0
        );
        bucket.sumNetPnlPct += netPnlPct;
        bucket.sumNetPnlPct2 += netPnlPct * netPnlPct;
        bucket.grossWinR += netR > 0 ? netR : 0;
        bucket.grossLossR += netR < 0 ? Math.abs(netR) : 0;
        bucket.totalCostR += Math.max(0, safeNumber(row.costR, 0));
        bucket.directSLCount += row.directSL ? 1 : 0;
        bucket.lastOutcomeTs = Math.max(
            safeNumber(bucket.lastOutcomeTs, 0),
            safeNumber(row.outcomePersistedTs, 0)
        ) || null;
        bucket.acceptedTemporalOutcomeSeq = Math.max(
            bucket.acceptedTemporalOutcomeSeq,
            Math.max(0, Math.floor(safeNumber(row.acceptedTemporalOutcomeSeq, 0)))
        );
    }
    return refreshTemporalMetricBucket(bucket);
}

export function temporalGateMaturity(gateWindowCompleted) {
    const completed = Math.max(0, Math.floor(safeNumber(gateWindowCompleted, 0)));
    if (completed === 0) return 'OBSERVING';
    if (completed <= 19) return 'EARLY_OUTCOMES';
    if (completed <= 34) return 'ACTIVE_LEARNING';
    return 'MATURE';
}

function utcDateKey(timestamp) {
    return new Date(normalizeTimestampMs(timestamp)).toISOString().slice(0, 10);
}

function isoWeekKeyUtc(timestamp) {
    const date = new Date(normalizeTimestampMs(timestamp));
    const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const day = utc.getUTCDay() || 7;
    utc.setUTCDate(utc.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((utc - yearStart) / TEMPORAL_MS_PER_DAY) + 1) / 7);
    return `${utc.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function concentration(values = []) {
    const counts = new Map();
    for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
    const maxCount = counts.size > 0 ? Math.max(...counts.values()) : 0;
    return {
        unique: counts.size,
        maxCount,
        maxShare: values.length > 0 ? maxCount / values.length : 0,
        counts: Object.fromEntries(counts)
    };
}

export function evaluateTemporalDiversity(members = [], { weekend = false, hourly = false } = {}) {
    const rows = Array.isArray(members) ? members : [];
    const dateStats = concentration(rows.map((row) => utcDateKey(row.entryTs)));
    const weekStats = concentration(rows.map((row) => isoWeekKeyUtc(row.entryTs)));
    const symbolStats = concentration(rows.map((row) => row.symbol || 'UNKNOWN'));
    const clusterStats = concentration(rows.map((row) => row.marketEventClusterId || 'UNKNOWN'));
    const limits = weekend
        ? {
            completed: 50,
            minDates: 10,
            minWeeks: 8,
            maxDateShare: 0.20,
            minSymbols: 5,
            maxSymbolShare: 0.35,
            minClusters: 12,
            maxClusterShare: 0.20
        }
        : hourly
          ? {
              completed: 12,
              minDates: 6,
              minWeeks: 4,
              maxDateShare: 0.34,
              minSymbols: 3,
              maxSymbolShare: 0.50,
              minClusters: 6,
              maxClusterShare: 0.34
          }
          : {
              completed: 35,
              minDates: 10,
              minWeeks: 4,
              maxDateShare: 0.25,
              minSymbols: 4,
              maxSymbolShare: 0.40,
              minClusters: 10,
              maxClusterShare: 0.20
          };
    const checks = {
        completed: rows.length >= limits.completed,
        dates: dateStats.unique >= limits.minDates,
        weeks: weekStats.unique >= limits.minWeeks,
        dateConcentration: dateStats.maxShare <= limits.maxDateShare + TEMPORAL_FLOAT_TOLERANCE,
        symbols: symbolStats.unique >= limits.minSymbols,
        symbolConcentration: symbolStats.maxShare <= limits.maxSymbolShare + TEMPORAL_FLOAT_TOLERANCE,
        clusters: clusterStats.unique >= limits.minClusters,
        clusterConcentration: clusterStats.maxShare <= limits.maxClusterShare + TEMPORAL_FLOAT_TOLERANCE
    };
    return {
        passed: Object.values(checks).every(Boolean),
        weekend,
        hourly,
        checks,
        limits,
        distinctEntryDates: dateStats.unique,
        distinctIsoWeeks: weekStats.unique,
        maxEntryDateShare: dateStats.maxShare,
        distinctSymbols: symbolStats.unique,
        maxSymbolShare: symbolStats.maxShare,
        distinctMarketEventClusters: clusterStats.unique,
        maxMarketEventClusterShare: clusterStats.maxShare
    };
}

export function evaluateTemporalConfounding(members = [], { broadAxis } = {}) {
    const rows = Array.isArray(members) ? members : [];
    const axis = String(broadAxis || '').trim().toUpperCase();
    const keyFor = axis === 'DAY'
        ? (row) => row.entrySessionBucket
        : (row) => row.entryDayOfWeekUtc;
    const cells = new Map();
    for (const row of rows) {
        const key = keyFor(row);
        if (!key) continue;
        const cell = cells.get(key) || { key, completed: 0, sumNetR: 0 };
        cell.completed += 1;
        cell.sumNetR += safeNumber(row.netR, 0);
        cells.set(key, cell);
    }
    const cellRows = [...cells.values()].map((cell) => ({
        ...cell,
        meanNetR: cell.completed > 0 ? cell.sumNetR / cell.completed : 0,
        supported: cell.completed >= 5,
        negativeContribution: Math.max(0, -cell.sumNetR)
    }));
    const supported = cellRows.filter((cell) => cell.supported);
    const negativeSupported = supported.filter((cell) => cell.meanNetR < 0);
    const totalNegativeContribution = supported.reduce(
        (sum, cell) => sum + cell.negativeContribution,
        0
    );
    const maxNegativeContribution = supported.reduce(
        (max, cell) => Math.max(max, cell.negativeContribution),
        0
    );
    const dominantLossShare = totalNegativeContribution > 0
        ? maxNegativeContribution / totalNegativeContribution
        : 1;
    const interactionCompleted = cellRows.reduce((sum, cell) => sum + cell.completed, 0);
    const interactionSumNetR = cellRows.reduce((sum, cell) => sum + cell.sumNetR, 0);
    const marginalSumNetR = rows.reduce((sum, row) => sum + safeNumber(row.netR, 0), 0);
    const integrity = interactionCompleted === rows.length &&
        Math.abs(interactionSumNetR - marginalSumNetR) <= TEMPORAL_FLOAT_TOLERANCE;
    return {
        passed: integrity &&
            supported.length >= 2 &&
            negativeSupported.length >= 2 &&
            totalNegativeContribution > 0 &&
            dominantLossShare <= 0.70 + TEMPORAL_FLOAT_TOLERANCE,
        broadAxis: axis,
        supportedCellCount: supported.length,
        negativeSupportedCellCount: negativeSupported.length,
        totalNegativeContribution,
        maxNegativeContribution,
        dominantLossShare,
        interactionCompleted,
        interactionSumNetR,
        marginalCompleted: rows.length,
        marginalSumNetR,
        integrity,
        cells: Object.fromEntries(cellRows.map((cell) => [cell.key, cell]))
    };
}

export function temporalOneSidedPValue(stats = {}, direction = 'NEGATIVE') {
    const completed = Math.max(0, Math.floor(safeNumber(stats.completed, 0)));
    const mean = safeNumber(stats.avgNetR ?? stats.avgR, 0);
    const se = Math.max(0, safeNumber(stats.standardError, 0));
    const normalizedDirection = String(direction || '').trim().toUpperCase();
    if (completed < 2) return 1;
    if (se === 0) {
        if (normalizedDirection === 'NEGATIVE') return mean < 0 ? 0 : 1;
        return mean > 0 ? 0 : 1;
    }
    const t = mean / se;
    const cdf = studentTCdf(t, completed - 1);
    return normalizedDirection === 'NEGATIVE'
        ? Math.max(0, Math.min(1, cdf))
        : Math.max(0, Math.min(1, 1 - cdf));
}

export function benjaminiHochberg(tests = []) {
    const rows = (Array.isArray(tests) ? tests : [])
        .map((test, index) => ({
            ...test,
            __index: index,
            pValue: Math.max(0, Math.min(1, safeNumber(test.pValue, 1)))
        }))
        .sort((left, right) => left.pValue - right.pValue || left.__index - right.__index);
    const count = rows.length;
    let nextQ = 1;
    for (let index = count - 1; index >= 0; index -= 1) {
        const rank = index + 1;
        const rawQ = Math.min(1, (rows[index].pValue * count) / rank);
        nextQ = Math.min(nextQ, rawQ);
        rows[index].qValue = nextQ;
        rows[index].bhRank = rank;
        rows[index].bhBatchSize = count;
    }
    return rows
        .sort((left, right) => left.__index - right.__index)
        .map(({ __index, ...row }) => row);
}

function now() {
    return Date.now();
}


function round4(value) {
    return Number(safeNumber(value, 0).toFixed(4));
}


function upper(value, fallback = '') {
    const text = String(value ?? '').trim();


    return text ? text.toUpperCase() : fallback;
}


function rotationNumber(key, fallback) {
    return safeNumber(
         CONFIG.long?.rotation?.[key] ??
           CONFIG.rotation?.[key],
         fallback
    );
}


function analyzeNumber(key, fallback) {
    return safeNumber(
         CONFIG.long?.analyze?.[key] ??
           CONFIG.analyze?.[key],
         fallback
    );
}


function observationDedupeCacheLimit() {
    return Math.max(
         100,
         Math.floor(analyzeNumber('observationDedupeCacheLimit',
DEFAULT_OBSERVATION_DEDUPE_CACHE_LIMIT))
    );
}


function schemaConfig() {
    const macroSchema = String(
         CONFIG.long?.analyze?.macroSchema ??
           CONFIG.analyze?.macroSchema ??
           CONFIG.analyze?.legacySchema ??
           'MF_V1'
    ).toUpperCase();
    const configuredLegacyMicroSchema = String(
         CONFIG.long?.analyze?.legacyMicroSchema ??
           CONFIG.long?.analyze?.microSchema ??
           CONFIG.analyze?.legacyMicroSchema ??
           CONFIG.analyze?.microSchema ??
           'MF_V2'
    ).toUpperCase();


    return {
         currentSchema: TRUE_MICRO_SCHEMA,
         macroSchema,
         microSchema: TRUE_MICRO_SCHEMA,
         legacyMicroSchema: configuredLegacyMicroSchema,
         trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
         childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
         parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
         learningGranularity: LEARNING_GRANULARITY,
         parentLearningGranularity: PARENT_LEARNING_GRANULARITY
    };
}


function shadowWeight() {
    return clamp(analyzeNumber('shadowWeight', 0.35), 0, 1);
}


function priorTrades() {
    return Math.max(0, rotationNumber('priorTrades', DEFAULT_PRIOR_TRADES));
}


function priorWinrate() {
    return clamp(rotationNumber('priorWinrate', DEFAULT_PRIOR_WINRATE), 0, 1);
}


function wilsonZ() {
    return Math.max(0.1, rotationNumber('wilsonZ', DEFAULT_WILSON_Z));
}


function sampleCap() {
    return Math.max(1, rotationNumber('sampleReliabilityCap', DEFAULT_SAMPLE_CAP));
}


function avgRCap() {
    return Math.max(0.5, rotationNumber('avgRCap', DEFAULT_AVG_R_CAP));
}


function avgRSampleExponent() {
    return clamp(
         rotationNumber('avgRSampleExponent', DEFAULT_AVG_R_SAMPLE_EXPONENT),
         0.5,
         3
    );
}


function positive(value) {
    return Math.max(0, safeNumber(value, 0));
}


function finiteOrNull(value) {
    if (value === undefined || value === null || value === '') return null;


    const n = Number(value);


    return Number.isFinite(n) ? n : null;
}



function normalizeMeasurementFixVersion(value = '') {
    return upper(value);
}


function rowMeasurementFixVersion(row = {}) {
    return normalizeMeasurementFixVersion(
         row.measurementFixVersion ??
             row.outcomeMeasurementVersion ??
             row.positionMeasurementFixVersion ??
             row.measurementVersion ??
             row.exitMeasurementVersion ??
             ''
    );
}


function isCurrentMeasurementOutcome(row = {}) {
    return rowMeasurementFixVersion(row) === MEASUREMENT_FIX_VERSION;
}


function outcomeResetNumericFields() {
    return [
         'virtualCompleted',
         'realCompleted',
         'shadowCompleted',
         'completed',
         'winrateSample',


         'wins',
'losses',
'flats',


'virtualWins',
'virtualLosses',
'virtualFlats',


'realWins',
'realLosses',
'realFlats',


'shadowWins',
'shadowLosses',
'shadowFlats',


'totalR',
'virtualTotalR',
'realTotalR',
'shadowTotalR',


'totalPnlPct',
'virtualTotalPnlPct',
'realTotalPnlPct',
'shadowTotalPnlPct',


'totalCostR',
'virtualTotalCostR',
'realTotalCostR',
'shadowTotalCostR',


'grossWinR',
'grossLossR',


'virtualGrossWinR',
'virtualGrossLossR',
'realGrossWinR',
'realGrossLossR',
'shadowGrossWinR',
'shadowGrossLossR',


'avgR',
'avgWinR',
'avgLossR',
'sampleAdjustedAvgR',
'avgRScore',
'avgPnlPct',
'avgCostR',
         'directSLCount',
         'nearTpCount',
         'reachedHalfRCount',
         'reachedOneRCount',


         'beWouldExitCount',
         'gaveBackAfterHalfRCount',
         'gaveBackAfterOneRCount',
         'nearTpThenLossCount',


         'winrate',
         'bayesianWinrate',
         'wilsonLowerBound',
         'fairWinrate',
         'sampleAdjustedWinrate',


         'sampleRawWinrate',
         'sampleBayesianWinrate',
         'sampleWilsonLowerBound',
         'sampleReliabilityOld',


         'profitFactor',
         'sampleReliability',
         'balancedScore',
         'dashboardBalancedScore',


         'directSLPct',
         'nearTpPct',
         'reachedHalfRPct',
         'reachedOneRPct',


         'beWouldExitPct',
         'gaveBackAfterHalfRPct',
         'gaveBackAfterOneRPct',
         'nearTpThenLossPct'
    ];
}


function hasStoredOutcomeMeasurementData(stats = {}) {
    if (
         Array.isArray(stats.recentOutcomes) &&
         stats.recentOutcomes.length > 0
    ) {
         return true;
    }
    return outcomeResetNumericFields().some(
         (field) => safeNumber(stats[field], 0) !== 0
    );
}


function storedCompletedForMeasurementIntegrity(stats = {}) {
    const sourceCompleted =
         safeNumber(stats.virtualCompleted, 0) +
         safeNumber(stats.shadowCompleted, 0);


    return Math.max(
         sourceCompleted,
         safeNumber(stats.completed, 0),
         0
    );
}


function currentMeasurementAggregateIntegrity(stats = {}) {
    const completed = storedCompletedForMeasurementIntegrity(stats);
    const acceptedOutcomeCount = Math.max(
         0,
         safeNumber(stats.measurementVersionAcceptedOutcomeCount, 0)
    );


    const recentOutcomes = Array.isArray(stats.recentOutcomes)
         ? stats.recentOutcomes
         : [];


    const nonCurrentRecentOutcomeCount = recentOutcomes
         .filter((outcome) => !isCurrentMeasurementOutcome(outcome))
         .length;


    const acceptedCountCoversCompleted =
         completed <= 0 || acceptedOutcomeCount >= completed;


    return {
         valid:
              acceptedCountCoversCompleted &&
              nonCurrentRecentOutcomeCount === 0,
         completed,
         acceptedOutcomeCount,
         acceptedCountCoversCompleted,
         recentOutcomeCount: recentOutcomes.length,
         nonCurrentRecentOutcomeCount
    };
}
function applyOutcomeMeasurementPolicyFlags(stats = {}) {
    stats.measurementFixVersion = MEASUREMENT_FIX_VERSION;
    stats.outcomeMeasurementVersion = MEASUREMENT_FIX_VERSION;
    stats.acceptedOutcomeMeasurementVersion = MEASUREMENT_FIX_VERSION;
    stats.previousSupportedMeasurementFixVersion = PREVIOUS_MEASUREMENT_FIX_VERSION;


    stats.outcomeMeasurementGateMode = OUTCOME_MEASUREMENT_GATE_MODE;
    stats.outcomeMeasurementVersionRequired = true;
    stats.strictOutcomeMeasurementGate = true;
    stats.legacyOutcomeMeasurementsExcluded = true;
    stats.completedCurrentMeasurementOnly = true;


    stats.exitFillModelVersion = EXIT_FILL_MODEL_VERSION;
    stats.exitFillPolicy =
'TP_SL_USE_TRIGGER_BOUNDARY_TIME_STOP_USES_OBSERVED_PRICE';
    stats.exitFillAssumption = 'TRIGGER_BOUNDARY_PLUS_COST_MODEL';


    return stats;
}


function migrateOutcomeMeasurementVersion(stats = {}) {
    const storedVersion = rowMeasurementFixVersion(stats);
    const alreadyCurrent = storedVersion === MEASUREMENT_FIX_VERSION;
    const integrity = currentMeasurementAggregateIntegrity(stats);


    if (alreadyCurrent && integrity.valid) {
        stats.recentOutcomes = Array.isArray(stats.recentOutcomes)
          ? stats.recentOutcomes
              .filter(isCurrentMeasurementOutcome)
              .slice(-50)
          : [];


        stats.currentMeasurementAggregateIntegrityValid = true;
        stats.currentMeasurementAggregateIntegrityCheckedAt =
          stats.currentMeasurementAggregateIntegrityCheckedAt || now();
        stats.currentMeasurementAggregateCompleted = integrity.completed;
        stats.currentMeasurementAcceptedOutcomeCount =
          integrity.acceptedOutcomeCount;
        stats.currentMeasurementNonCurrentRecentOutcomeCount = 0;


        return applyOutcomeMeasurementPolicyFlags(stats);
    }


    const migrationAt = now();
    const hadLegacyOutcomeData = hasStoredOutcomeMeasurementData(stats);


    const legacyCompleted = integrity.completed;
const legacyAcceptedOutcomeCount = integrity.acceptedOutcomeCount;
const legacyTotalR = safeNumber(stats.totalR, 0);
const legacyTotalCostR = safeNumber(stats.totalCostR, 0);
const legacyAvgR = legacyCompleted > 0
    ? legacyTotalR / legacyCompleted
    : 0;


const legacyRecentOutcomeCount = Array.isArray(stats.recentOutcomes)
    ? stats.recentOutcomes.length
    : 0;


for (const field of outcomeResetNumericFields()) {
    stats[field] = 0;
}


resetTemporalOutcomeMetrics(stats);


stats.measurementVersionAcceptedOutcomeCount = 0;
stats.lastAcceptedOutcomeMeasurementVersion = null;
stats.lastAcceptedOutcomeMeasurementAt = null;


stats.recentOutcomes = [];
stats.costStatsInferredFromRecent = false;
stats.directSLStatsInferredFromRecent = false;


stats.learningStatus = 'OBSERVING';
stats.status = 'OBSERVING';
stats.awaitingOutcomes = safeNumber(stats.seen, 0) > 0;
stats.tooEarly = true;


stats.previousMeasurementFixVersion = alreadyCurrent
    ? 'CURRENT_VERSION_WITH_UNVERIFIED_AGGREGATES'
    : storedVersion || 'UNVERSIONED';


stats.outcomeMeasurementMigrationApplied = true;
stats.outcomeMeasurementMigrationAt =
    stats.outcomeMeasurementMigrationAt ||
    migrationAt;


stats.outcomeMeasurementMigrationReason = alreadyCurrent
    ? 'CURRENT_VERSION_AGGREGATE_INTEGRITY_MISMATCH_LEGACY_DATA_EXCLUDED'
    : 'LEGACY_TRIGGER_OVERSHOOT_OUTCOMES_EXCLUDED_FROM_CLEAN_DATASET';


stats.currentMeasurementAggregateIntegrityValid = true;
stats.currentMeasurementAggregateIntegrityMismatchDetected = alreadyCurrent;
stats.currentMeasurementAggregateIntegrityCheckedAt = migrationAt;
stats.currentMeasurementAggregateCompleted = 0;
    stats.currentMeasurementAcceptedOutcomeCount = 0;
    stats.currentMeasurementNonCurrentRecentOutcomeCount = 0;


    stats.legacyOutcomeDataWasPresent = hadLegacyOutcomeData;
    stats.legacyExcludedCompleted = round4(legacyCompleted);
    stats.legacyExcludedTotalR = round4(legacyTotalR);
    stats.legacyExcludedAvgR = round4(legacyAvgR);
    stats.legacyExcludedTotalCostR = round4(legacyTotalCostR);
    stats.legacyExcludedRecentOutcomeCount = legacyRecentOutcomeCount;
    stats.legacyExcludedAcceptedOutcomeCount = round4(
         legacyAcceptedOutcomeCount
    );
    stats.legacyExcludedNonCurrentRecentOutcomeCount =
         integrity.nonCurrentRecentOutcomeCount;


    stats.lastOutcomeMeasurementResetAt = migrationAt;
    stats.updatedAt = migrationAt;


    return applyOutcomeMeasurementPolicyFlags(stats);
}


function normalizeCurrentFitLabel(value = '') {
    const raw = upper(value);


    if (
         raw === 'MATCH' ||
         raw === 'FIT'
    ) {
         return 'FIT';
    }


    if (
         raw === 'WEAK_MATCH' ||
         raw === 'WEAKMATCH' ||
         raw === 'OK'
    ) {
         return 'OK';
    }


    if (raw === 'NEUTRAL') return 'NEUTRAL';
    if (raw === 'MISFIT') return 'MISFIT';


    return 'UNKNOWN';
}


function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(
         object || {},
         key
    );
}


function hasUsableCurrentFitSnapshot(value = {}) {
    const label = normalizeCurrentFitLabel(
         value.currentFit ||
           value.currentFitLabel ||
           value.entryCurrentFit ||
           value.lastKnownCurrentFit
    );


    return (
         label !== 'UNKNOWN' ||
         value.currentMarketWeatherAvailable === true ||
         value.currentFitScoreBuilt === true
    );
}


function applyCurrentFitSnapshot(stats = {}, row = {}) {
    const hasExplicitLabel =
         hasOwn(row, 'currentFit') ||
         hasOwn(row, 'currentFitLabel') ||
         hasOwn(row, 'entryCurrentFit');


    const hasExplicitScore =
         hasOwn(row, 'currentFitScore') ||
         hasOwn(row, 'fitScore');


    const hasExplicitConfidence =
         hasOwn(row, 'currentFitConfidence') ||
         hasOwn(row, 'entryCurrentFitConfidence') ||
         hasOwn(row, 'currentMarketFitConfidence');


    const hasWeatherContext = Boolean(
         row.currentMarketWeather ||
         row.entryMarketWeather ||
         row.currentMarketWeatherAvailable === true ||
         row.currentRegime ||
         row.currentMarketRegime ||
         row.currentTrendSide ||
         row.currentMarketTrendSide
    );


    if (
         !hasExplicitLabel &&
     !hasExplicitScore &&
     !hasExplicitConfidence &&
     !hasWeatherContext
) {
     return stats;
}


const label = normalizeCurrentFitLabel(
     row.currentFit ||
       row.currentFitLabel ||
       row.entryCurrentFit
);


const score = finiteOrNull(
     row.currentFitScore ??
       row.fitScore
);


const confidence = finiteOrNull(
     row.currentFitConfidence ??
       row.entryCurrentFitConfidence ??
       row.currentMarketFitConfidence
);


const reasons = Array.isArray(row.currentFitReasons)
     ? row.currentFitReasons
         .map((value) => String(value || '').trim())
         .filter(Boolean)
         .slice(0, 20)
     : [];


const updatedAt = safeNumber(
     row.currentFitUpdatedAt ??
       row.liveDataTs ??
       row.updatedAt ??
       row.createdAt ??
       row.ts,
     now()
);


if (hasExplicitLabel) {
     stats.currentFit = label;
     stats.currentFitLabel = label;
} else {
     stats.currentFit ||= 'UNKNOWN';
     stats.currentFitLabel ||= stats.currentFit;
}
if (score !== null) {
    stats.currentFitScore = score;
    stats.fitScore = score;
}


if (confidence !== null) {
    stats.currentFitConfidence = confidence;
}


stats.currentFitReason =
    row.currentFitReason ||
    stats.currentFitReason ||
    null;


if (reasons.length > 0) {
    stats.currentFitReasons = reasons;
} else if (!Array.isArray(stats.currentFitReasons)) {
    stats.currentFitReasons = [];
}


stats.currentRegime =
    row.currentRegime ||
    row.currentMarketRegime ||
    stats.currentRegime ||
    'UNKNOWN';


stats.currentMarketRegime =
    row.currentMarketRegime ||
    row.currentRegime ||
    stats.currentMarketRegime ||
    'UNKNOWN';


stats.currentTrendSide =
    row.currentTrendSide ||
    row.currentMarketTrendSide ||
    stats.currentTrendSide ||
    'UNKNOWN';


stats.currentMarketTrendSide =
    row.currentMarketTrendSide ||
    row.currentTrendSide ||
    stats.currentMarketTrendSide ||
    'UNKNOWN';


stats.currentBearishPct = finiteOrNull(
    row.currentBearishPct ??
         row.bearishPct
  ) ?? stats.currentBearishPct ?? null;


  stats.currentBullishPct = finiteOrNull(
       row.currentBullishPct ??
         row.bullishPct
  ) ?? stats.currentBullishPct ?? null;


  stats.currentSqueezePct = finiteOrNull(
       row.currentSqueezePct ??
         row.squeezePct
  ) ?? stats.currentSqueezePct ?? null;


  stats.currentMarketWeatherAgeSec = finiteOrNull(
       row.currentMarketWeatherAgeSec
  ) ?? stats.currentMarketWeatherAgeSec ?? null;


  stats.currentMarketWeatherStale = Boolean(
       row.currentMarketWeatherStale
  );


  stats.currentMarketWeatherAvailable = Boolean(
       row.currentMarketWeatherAvailable === true ||
       row.currentMarketWeather ||
       row.entryMarketWeather
  );


  stats.currentFitVersion =
       row.currentFitVersion ||
       stats.currentFitVersion ||
       CURRENT_FIT_VERSION;


  stats.currentFitUpdatedAt = updatedAt;
  stats.currentFitScoreBuilt =
       label !== 'UNKNOWN' &&
       score !== null;


  if (label !== 'UNKNOWN') {
       stats.lastKnownCurrentFit = label;
       stats.lastKnownCurrentFitScore = score ?? safeNumber(stats.currentFitScore,
0);
       stats.lastKnownCurrentFitConfidence = confidence ??
safeNumber(stats.currentFitConfidence, 0);
       stats.lastKnownCurrentFitAt = updatedAt;
  }


  return stats;
}


function inc(obj, key, amount = 1) {
    const k = String(key || 'UNKNOWN').toUpperCase();


    obj[k] = safeNumber(obj[k], 0) + amount;
}


function makeCounters() {
    return {
         rsiZone: {},
         flow: {},
         obRelation: {},
         btcState: {},
         regime: {},
         scannerReason: {}
    };
}


function isExecutionFingerprintId(id = '') {
    const value = upper(id);


    return (
         value.includes('_XR_') ||
         value.includes('__XR__') ||
         value.includes('|XR|') ||
         value.includes('EXECUTION_FINGERPRINT') ||
         value.includes('EXECUTION_MICRO') ||
         value.includes('EXECUTIONMICRO') ||
         value.includes('REFINED_EXECUTION')
    );
}


function isScannerFamilyId(id = '') {
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


function validLearningId(id = '') {
    const value = String(id || '').trim();


    if (!value) return false;
    if (isScannerFamilyId(value)) return false;
    if (isExecutionFingerprintId(value)) return false;


    return true;
}


function parseLongTaxonomyMicroId(id = '') {
    const rawId = String(id || '').trim();
    const value = upper(rawId);


    if (!value.startsWith('MICRO_LONG_')) {
         return {
              valid: false,
              selectable: false,
              isParent: false,
              isChild: false,
              rawId
         };
    }


    if (isScannerFamilyId(value) || isExecutionFingerprintId(value)) {
         return {
              valid: false,
              selectable: false,
              isParent: false,
              isChild: false,
              rawId
         };
    }


    if (
         value.includes('_MF_V1_') ||
         value.includes('_MF_V2_') ||
         value.includes('_MF_V3_')
    ) {
         return {
              valid: false,
              selectable: false,
              isParent: false,
         isChild: false,
         rawId
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


for (const candidateRegime of LONG_FIXED_REGIME_ORDER) {
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
         rawId,
         id: validChild ? childId : validParent ? parentId : value,
         setup,
         regime,
         setupType: setup,
         regimeBucket: regime,
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


function isSelectableLongChildTrueMicroId(id = '') {
    return parseLongTaxonomyMicroId(id).isChild === true;
}


function isParentLongTrueMicroId(id = '') {
    return parseLongTaxonomyMicroId(id).isParent === true;
}


function cleanSideText(value = '') {
    return String(value || '')
         .trim()
         .toUpperCase()
         .replaceAll('SHORT_DISABLED_TRUE', '')
         .replaceAll('SHORTDISABLED_TRUE', '')
         .replaceAll('BLOCK_SHORT_TRUE', '')
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
      .replaceAll('LONG_DISABLED_SHORT_ONLY', 'SHORT')
      .replaceAll('LONGDISABLED_SHORT_ONLY', 'SHORT')
      .replaceAll('BLOCK_LONG', 'SHORT')
      .replaceAll('LONG_DISABLED', 'SHORT')
      .replaceAll('LONGDISABLED', 'SHORT')
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
    return hasSignalPattern(value, [
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
    return hasSignalPattern(value, [
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


function normalizeTradeSide(value) {
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


    const longHit = hasLongSignal(raw);
    const shortHit = hasShortSignal(raw);


    if (longHit && !shortHit) return TARGET_TRADE_SIDE;
    if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;


    if (longHit && shortHit) {
         if (raw.includes('TRADE_SIDE=LONG') || raw.includes('TRADESIDE=LONG')) return
TARGET_TRADE_SIDE;
         if (raw.includes('TRADE_SIDE=SHORT') || raw.includes('TRADESIDE=SHORT'))
return OPPOSITE_TRADE_SIDE;
         if (raw.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
         if (raw.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
    }


    return 'UNKNOWN';
}


function directSide(row = {}) {
    const values = [
         row.tradeSide,
         row.positionSide,
         row.direction,
         row.signalSide,
         row.intentSide,
         row.entrySide,
         row.scannerSide,
         row.actualScannerSide,
         row.analysisSide,
         row.side
    ];


    for (const value of values) {
         const side = normalizeTradeSide(value);


         if (side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE) {
             return side;
         }
    }


    return 'UNKNOWN';
}


function definitionValues(row = {}) {
    return [
         row.familyId,
         row.family,
         row.baseFamilyId,


         row.microFamilyId,
         row.trueMicroFamilyId,
         row.childTrueMicroFamilyId,
         row.analyzeMicroFamilyId,
         row.learningMicroFamilyId,
         row.coarseMicroFamilyId,
         row.parentTrueMicroFamilyId,
         row.baseMicroFamilyId,
         row.legacyMicroFamilyId,
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
    ];
}


function definitionText(row = {}) {
    return definitionValues(row)
         .map((value) => cleanSideText(value))
        .filter(Boolean)
        .join('|');
}


function definitionSide(row = {}) {
    const values = definitionValues(row);


    let longHit = false;
    let shortHit = false;


    for (const value of values) {
        const side = normalizeTradeSide(value);


        if (side === TARGET_TRADE_SIDE) longHit = true;
        if (side === OPPOSITE_TRADE_SIDE) shortHit = true;
    }


    if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;
    if (longHit && !shortHit) return TARGET_TRADE_SIDE;


    if (longHit && shortHit) {
        const text = values
          .map((value) => cleanSideText(value))
          .filter(Boolean)
          .join('|');


        if (text.includes('TRADE_SIDE=LONG') || text.includes('TRADESIDE=LONG'))
return TARGET_TRADE_SIDE;
        if (text.includes('TRADE_SIDE=SHORT') || text.includes('TRADESIDE=SHORT'))
return OPPOSITE_TRADE_SIDE;
        if (text.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
        if (text.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
    }


    return 'UNKNOWN';
}


function inferTradeSide(row = {}) {
    if (typeof row === 'string') return normalizeTradeSide(row);


    if (!row || typeof row !== 'object') return 'UNKNOWN';


    const direct = directSide(row);


    if (direct === TARGET_TRADE_SIDE || direct === OPPOSITE_TRADE_SIDE) {
        return direct;
    }
    const fromDefinition = definitionSide(row);


    if (fromDefinition === TARGET_TRADE_SIDE || fromDefinition ===
OPPOSITE_TRADE_SIDE) {
        return fromDefinition;
    }


    if (row.longOnly === true || row.shortDisabled === true) {
        return TARGET_TRADE_SIDE;
    }


    if (row.shortOnly === true || row.longDisabled === true) {
        return OPPOSITE_TRADE_SIDE;
    }


    return 'UNKNOWN';
}


function isLongRow(row = {}) {
    return inferTradeSide(row) === TARGET_TRADE_SIDE;
}


function rowSchema(row = {}) {
    return String(
        row.trueMicroFamilySchema ||
          row.childTrueMicroFamilySchema ||
          row.exactTrueMicroFamilySchema ||
          row.broadTrueMicroFamilySchema ||
          row.microFamilySchema ||
          row.schema ||
          row.versionSchema ||
          ''
    ).toUpperCase();
}


function rowMicroId(row = {}) {
    const value = String(
        row.trueMicroFamilyId ||
          row.childTrueMicroFamilyId ||
          row.microFamilyId ||
          row.analyzeMicroFamilyId ||
          row.learningMicroFamilyId ||
          row.id ||
          row.key ||
          ''
    ).trim();
    return validLearningId(value) ? value.toUpperCase() : '';
}


function rowParentTrueMicroId(row = {}) {
    const direct = String(
        row.parentTrueMicroFamilyId ||
             row.coarseMicroFamilyId ||
             row.baseMicroFamilyId ||
             row.legacyMicroFamilyId ||
             row.parentMacroFamilyId ||
             row.parentMicroFamilyId ||
             row.macroFamilyId ||
             ''
    ).trim();


    const parsedDirect = parseLongTaxonomyMicroId(direct);


    if (parsedDirect.valid) {
        return parsedDirect.parentTrueMicroFamilyId;
    }


    const parsedMicro = parseLongTaxonomyMicroId(rowMicroId(row));


    if (parsedMicro.valid) {
        return parsedMicro.parentTrueMicroFamilyId;
    }


    return '';
}


function idHasSchema(id, schema) {
    const value = upper(id);
    const target = upper(schema);


    if (!value || !target) return false;


    if (target === TRUE_MICRO_SCHEMA) {
        return (
             isSelectableLongChildTrueMicroId(value) ||
             value.includes(`_${TRUE_MICRO_SCHEMA}_`) ||
             value.endsWith(`_${TRUE_MICRO_SCHEMA}`) ||
             value.includes(`|SCHEMA=${TRUE_MICRO_SCHEMA}`) ||
             value.includes(`SCHEMA=${TRUE_MICRO_SCHEMA}`)
        );
    }
    if (target === PARENT_TRUE_MICRO_SCHEMA) {
         return (
              isParentLongTrueMicroId(value) ||
              value.includes(`_${PARENT_TRUE_MICRO_SCHEMA}_`) ||
              value.endsWith(`_${PARENT_TRUE_MICRO_SCHEMA}`) ||
              value.includes(`|SCHEMA=${PARENT_TRUE_MICRO_SCHEMA}`) ||
              value.includes(`SCHEMA=${PARENT_TRUE_MICRO_SCHEMA}`)
         );
    }


    return (
         value.includes(`_${target}_`) ||
         value.endsWith(`_${target}`) ||
         value.includes(`|SCHEMA=${target}`) ||
         value.includes(`SCHEMA=${target}`)
    );
}


function definitionHasSchema(row = {}, schema) {
    const target = upper(schema);


    if (!target) return false;


    const parts = [
         ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
         ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
         ...(Array.isArray(row.broadTrueDefinitionParts) ? row.broadTrueDefinitionParts
: []),
         ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts :
[]),
         ...(Array.isArray(row.executionFingerprintParts) ?
row.executionFingerprintParts : [])
    ];


    const upperParts = parts.map((part) => String(part || '').toUpperCase());


    if (target === TRUE_MICRO_SCHEMA) {
         return (
              upperParts.some((part) => (
                part === `SCHEMA=${TRUE_MICRO_SCHEMA}` ||
                part === `TRUEMICROFAMILYSCHEMA=${TRUE_MICRO_SCHEMA}` ||
                part === `CHILDTRUEMICROFAMILYSCHEMA=${TRUE_MICRO_SCHEMA}` ||
                part === `BROADTRUEMICROFAMILYSCHEMA=${TRUE_MICRO_SCHEMA}` ||
                part.includes(`SCHEMA=${TRUE_MICRO_SCHEMA}`) ||
                part.includes('FIXED_TAXONOMY_75') ||
                part.includes('LEARNINGIDENTITY=ANALYZE_TRUE_MICRO_FAMILY_FIXED_TAXONOMY')
              )) ||
              definitionText(row).includes('FIXED_TAXONOMY_75')
         );
    }


    if (target === PARENT_TRUE_MICRO_SCHEMA) {
         return (
              upperParts.some((part) => (
                part === `SCHEMA=${PARENT_TRUE_MICRO_SCHEMA}` ||
                part === `PARENTTRUEMICROFAMILYSCHEMA=${PARENT_TRUE_MICRO_SCHEMA}` ||
                part.includes(`SCHEMA=${PARENT_TRUE_MICRO_SCHEMA}`) ||
                part.includes('FIXED_TAXONOMY_15')
              )) ||
              definitionText(row).includes('FIXED_TAXONOMY_15')
         );
    }


    if (upperParts.some((part) => part === `SCHEMA=${target}`)) {
         return true;
    }


    return definitionText(row).includes(`SCHEMA=${target}`);
}


function idLooksLikeSimpleMacroFamily(id = '') {
    const value = String(id || '').trim();


    return (
         /^LONG(?:_F)?_?\d+$/iu.test(value) ||
         /^LONG_F\d+$/iu.test(value)
    );
}


function idLooksLikeLongMicroFamily(id = '') {
    const value = upper(id);


    if (!value) return false;
    if (!validLearningId(value)) return false;


    return value.startsWith('MICRO_LONG_');
}


function isTrueAnalyzeMicroRow(row = {}) {
    const { macroSchema, legacyMicroSchema } = schemaConfig();


    const id = rowMicroId(row);
    const schema = rowSchema(row);
    const version = upper(row.version);
    if (!row || !id) return false;
    if (!validLearningId(id)) return false;
    if (!isLongRow(row) && !idLooksLikeLongMicroFamily(id)) return false;


    if (row.isLegacyMacro === true) return false;
    if (row.isParentTrueMicro === true) return false;
    if (isParentLongTrueMicroId(id)) return false;
    if (idLooksLikeSimpleMacroFamily(id)) return false;
    if (version.includes('MACRO') || version.includes('PARENT')) return false;


    if (schema === macroSchema) return false;
    if (schema === PARENT_TRUE_MICRO_SCHEMA) return false;
    if (idHasSchema(id, macroSchema)) return false;
    if (idHasSchema(id, PARENT_TRUE_MICRO_SCHEMA)) return false;
    if (definitionHasSchema(row, macroSchema)) return false;


    if (isSelectableLongChildTrueMicroId(id)) return true;


    if (
        row.fixedTaxonomyLearningId === true &&
        row.exactTrueMicroFamilyRequired === true &&
        idLooksLikeLongMicroFamily(id) &&
        !idHasSchema(id, legacyMicroSchema) &&
        !idHasSchema(id, macroSchema)
    ) {
        return isSelectableLongChildTrueMicroId(id);
    }


    return false;
}


function isRealAnalyzeMicroRow(row = {}) {
    return isTrueAnalyzeMicroRow(row);
}


function dashboardSideFromTradeSide(side, fallback = 'unknown') {
    const tradeSide = normalizeTradeSide(side);


    if (tradeSide === TARGET_TRADE_SIDE) return TARGET_DASHBOARD_SIDE;


    return String(fallback || 'unknown').toLowerCase();
}


function normalizeSource(source = SOURCE_VIRTUAL) {
    const src = String(source || SOURCE_VIRTUAL).trim().toUpperCase();
    if (src === SOURCE_REAL) return SOURCE_REAL;
    if (src === SOURCE_SHADOW) return SOURCE_SHADOW;
    if (src === SOURCE_VIRTUAL) return SOURCE_VIRTUAL;


    return SOURCE_VIRTUAL;
}


function sourceWeight(source) {
    return normalizeSource(source) === SOURCE_SHADOW
         ? shadowWeight()
         : 1;
}


function fixedTaxonomyMeta(row = {}) {
    const id = rowMicroId(row);
    const parsed = parseLongTaxonomyMicroId(id);


    if (!parsed.valid) {
         return {
              setupType: row.setupType || null,
              regimeBucket: row.regimeBucket || null,
              confirmationProfile: row.confirmationProfile || null,
              parentTrueMicroFamilyId: rowParentTrueMicroId(row) || null,
              childTrueMicroFamilyId: null,
              fixedTaxonomyLearningId: false,
              selectableChild: false
         };
    }


    return {
         setupType: parsed.setup,
         regimeBucket: parsed.regime,
         confirmationProfile: parsed.confirmationProfile || row.confirmationProfile ||
null,
         parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
         childTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
         fixedTaxonomyLearningId: parsed.isChild,
         fixedTaxonomyBaseId: parsed.parentTrueMicroFamilyId,
         selectableChild: parsed.isChild,
         isParentTrueMicro: parsed.isParent
    };
}


function longRiskGeometry(row = {}) {
    const entry = safeNumber(row.entry ?? row.entryPrice, 0);
    const initialSl = safeNumber(row.initialSl ?? row.sl ?? row.stopLoss, 0);
    const tp = safeNumber(row.tp ?? row.takeProfit, 0);
  const exitPrice = safeNumber(row.exitPrice ?? row.exit ?? row.closePrice, 0);
  const currentPrice = safeNumber(row.currentPrice ?? row.markPrice ?? row.price,
0);


  const riskDistance =
      entry > 0 &&
      initialSl > 0 &&
      initialSl < entry
         ? entry - initialSl
         : 0;


  const validLongRiskShape =
      entry > 0 &&
      initialSl > 0 &&
      tp > 0 &&
      initialSl < entry &&
      entry < tp;


  const longGrossR =
      validLongRiskShape &&
      riskDistance > 0 &&
      exitPrice > 0
         ? (exitPrice - entry) / riskDistance
         : null;


  const longCurrentR =
      validLongRiskShape &&
      riskDistance > 0 &&
      currentPrice > 0
         ? (currentPrice - entry) / riskDistance
         : null;


  return {
      entry,
      initialSl,
      sl: initialSl,
      tp,
      exitPrice,
      currentPrice,
      riskDistance,
      validLongRiskShape,
      validLongGeometry: validLongRiskShape,
      longTpHit: validLongRiskShape && currentPrice > 0 ? currentPrice >= tp :
false,
      longSlHit: validLongRiskShape && currentPrice > 0 ? currentPrice <= initialSl
: false,
      longGrossR,
         longCurrentR
    };
}


function outcomeExitR(row = {}) {
    const explicitLong = finiteOrNull(
         row.longNetR ??
           row.netLongR ??
           row.longExitR ??
           row.realizedLongR
    );


    if (explicitLong !== null) return explicitLong;


    const explicitGeneric = finiteOrNull(
         row.netR ??
           row.exitR ??
           row.realizedNetR ??
           row.realizedR ??
           row.r
    );


    if (explicitGeneric !== null) return explicitGeneric;


    const geometry = longRiskGeometry(row);


    if (geometry.longGrossR !== null) return geometry.longGrossR;


    const explicitLongGross = finiteOrNull(row.longGrossR ?? row.grossLongR);


    if (explicitLongGross !== null) return explicitLongGross;


    const explicitGross = finiteOrNull(
         row.grossR ??
           row.rawR ??
           row.realizedGrossR
    );


    if (explicitGross !== null) return explicitGross;


    return 0;
}


function applyLearningIdentityFlags(stats = {}, row = {}) {
    const id = rowMicroId({
         ...stats,
         ...row
  });


  const taxonomy = fixedTaxonomyMeta({
    ...stats,
    ...row
  });


  stats.redisNamespace = LONG_NAMESPACE;
  stats.redisKeyPrefix = LONG_KEY_PREFIX;
  stats.persistentLearningKey = PERSISTENT_LEARNING_KEY;
  stats.redisKeysSeparatedFromShortRoot = true;
  stats.shortRootTouched = false;


  stats.trueMicroOnly = true;
  stats.exactTrueMicroOnly = true;
  stats.exactTrueMicroFamilyRequired = true;
  stats.trueMicroFamilySchema = TRUE_MICRO_SCHEMA;
  stats.childTrueMicroFamilySchema = CHILD_TRUE_MICRO_SCHEMA;
  stats.exactTrueMicroFamilySchema = TRUE_MICRO_SCHEMA;
  stats.parentTrueMicroFamilySchema = PARENT_TRUE_MICRO_SCHEMA;
  stats.broadTrueMicroFamilySchema = TRUE_MICRO_SCHEMA;
  stats.microFamilySchema = TRUE_MICRO_SCHEMA;
  stats.schema = TRUE_MICRO_SCHEMA;
  stats.learningGranularity = LEARNING_GRANULARITY;
  stats.parentLearningGranularity = PARENT_LEARNING_GRANULARITY;
  stats.fixedTaxonomyPreferred = true;
  stats.fixedTaxonomyLearningId = taxonomy.fixedTaxonomyLearningId;
  stats.selectableChild = taxonomy.selectableChild;
  stats.fixedTaxonomyBaseId = taxonomy.fixedTaxonomyBaseId ||
stats.fixedTaxonomyBaseId || null;


  stats.setupType = taxonomy.setupType || stats.setupType || null;
  stats.regimeBucket = taxonomy.regimeBucket || stats.regimeBucket || null;
  stats.confirmationProfile = taxonomy.confirmationProfile ||
stats.confirmationProfile || null;


  if (id) {
    stats.microFamilyId = id;
    stats.trueMicroFamilyId = id;
    stats.childTrueMicroFamilyId = taxonomy.childTrueMicroFamilyId || id;
    stats.analyzeMicroFamilyId = id;
    stats.learningMicroFamilyId = id;


    stats.parentTrueMicroFamilyId =
        taxonomy.parentTrueMicroFamilyId ||
        rowParentTrueMicroId(stats) ||
        rowParentTrueMicroId(row) ||
        null;


      stats.coarseMicroFamilyId = stats.parentTrueMicroFamilyId;
      stats.baseMicroFamilyId = stats.parentTrueMicroFamilyId;
      stats.legacyMicroFamilyId = stats.parentTrueMicroFamilyId;


      stats.macroFamilyId = stats.parentTrueMicroFamilyId;
      stats.parentMacroFamilyId = stats.parentTrueMicroFamilyId;
      stats.parentMicroFamilyId = stats.parentTrueMicroFamilyId;
  }


  stats.parentSelectionAllowed = false;
  stats.selectionGranularity = 'EXACT_75_CHILD';
  stats.fallbackRankingGranularity = 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED';


  stats.scannerFingerprintRole = 'METADATA_ONLY';
  stats.scannerFingerprintsMetadataOnly = true;
  stats.scannerFingerprintsUsedAsLearningFamily = false;
  stats.scannerBucketsMetadataOnly = true;
  stats.legacy25BucketsMetadataOnly = true;


  stats.executionFingerprintRole = stats.executionFingerprintRole ||
'METADATA_ONLY';
  stats.executionFingerprintsMetadataOnly = true;
  stats.executionFingerprintsUsedAsLearningFamily = false;


  stats.analyzeMicroFamiliesOnly = true;
  stats.learningIdentitySource = 'ANALYZE_TRUE_MICRO_FAMILY';
  stats.symbolExcludedFromFamilyId = true;
  stats.coinNameExcludedFromFamilyId = true;
  stats.hashesExcludedFromFamilyId = true;


  stats.completedDefinition = 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES';
  stats.completedOnlyClosedVirtualOrShadow = true;
  stats.completedMeasurementFilter = MEASUREMENT_FIX_VERSION;
  stats.completedCurrentMeasurementOnly = true;
  stats.scoringRSource = 'netR';
  stats.winsLossesFlatsSource = 'netR';
  stats.winrateDefinition = 'netR > 0';
  stats.avgRSource = 'netR';
  stats.totalRSource = 'netR';
  stats.avgCostRShown = true;
  stats.avgCostRSource = 'costR';


  applyOutcomeMeasurementPolicyFlags(stats);
  stats.seenDefinition = 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY';
  stats.observationDedupeRequired = true;
    stats.observationAlwaysCounted = false;


    stats.defaultRanking =
'dashboardBalancedScore|balancedScore|fairWinrate|totalR|avgR|avgCostR';
    stats.bareWinrateRankingDisabled = true;
    stats.rawWinrateRankingDisabled = true;
    stats.rankingUsesBalancedScore = true;
    stats.rankingUsesFairWinrate = true;
    stats.rankingUsesTotalR = true;
    stats.rankingUsesAvgR = true;
    stats.rankingUsesAvgCostR = true;


    stats.currentFitSoftOnly = true;
    stats.currentFitBlocksLearning = false;
    stats.currentFitPolarity = 'BULLISH_POSITIVE_BEARISH_NEGATIVE';
    stats.currentFitDefinition = 'LONG_MIRRORED_CURRENT_FIT';
    stats.learningRemainsBroad = true;
    stats.selectionWillBeAdaptive = true;
    stats.discordWillBeStrict = true;


    stats.adaptiveLayerBuilt = false;
    stats.adaptiveScoreBuilt = false;
    stats.recentMomentumScoreBuilt = false;
    stats.currentFitScoreBuilt = hasUsableCurrentFitSnapshot(stats);
    stats.parentDiversificationBuilt = false;


    stats.validLongRiskShape = 'entry > 0 && sl > 0 && sl < entry && tp > entry';
    stats.longRiskShape = 'sl < entry < tp';
    stats.riskTradeSide = TARGET_TRADE_SIDE;
    stats.riskGeometryRule = 'LONG: sl < entry < tp';
    stats.tpHitRule = 'LONG: price >= tp';
    stats.slHitRule = 'LONG: price <= sl';
    stats.grossRFormula = '(exitPrice - entry) / (entry - initialSl)';
    stats.currentRFormula = '(currentPrice - entry) / (entry - initialSl)';
    stats.longGrossRFormula = '(exitPrice - entry) / (entry - initialSl)';
    stats.longCurrentRFormula = '(currentPrice - entry) / (entry - initialSl)';


    stats.realOrdersDisabled = true;
    stats.exchangeOrdersDisabled = true;
    stats.bitgetOrdersDisabled = true;
    stats.exchangeCallsDisabled = true;
    stats.noRealOrders = true;
    stats.noExchangeOrders = true;


    return stats;
}
function applySideIdentity(stats = {}, row = {}) {
    const tradeSide = inferTradeSide({
         ...stats,
         ...row
    });


    stats.longOnly = true;
    stats.shortDisabled = true;
    stats.shortOnly = false;
    stats.longDisabled = false;


    applyLearningIdentityFlags(stats, row);


    if (tradeSide !== TARGET_TRADE_SIDE) {
         stats.tradeSide = null;
         stats.side = 'unknown';
         return stats;
    }


    stats.tradeSide = TARGET_TRADE_SIDE;
    stats.side = TARGET_DASHBOARD_SIDE;
    stats.positionSide = TARGET_TRADE_SIDE;
    stats.direction = TARGET_TRADE_SIDE;
    stats.targetTradeSide = TARGET_TRADE_SIDE;
    stats.targetScannerSide = TARGET_SCANNER_SIDE;
    stats.dashboardSide = TARGET_DASHBOARD_SIDE;


    return stats;
}


function hasSourceBuckets(stats = {}) {
    return (
         safeNumber(stats.virtualCompleted, 0) > 0 ||
         safeNumber(stats.shadowCompleted, 0) > 0 ||
         safeNumber(stats.virtualWins, 0) > 0 ||
         safeNumber(stats.virtualLosses, 0) > 0 ||
         safeNumber(stats.virtualFlats, 0) > 0 ||
         safeNumber(stats.shadowWins, 0) > 0 ||
         safeNumber(stats.shadowLosses, 0) > 0 ||
         safeNumber(stats.shadowFlats, 0) > 0 ||
         safeNumber(stats.virtualTotalR, 0) !== 0 ||
         safeNumber(stats.shadowTotalR, 0) !== 0 ||
         safeNumber(stats.virtualTotalCostR, 0) !== 0 ||
         safeNumber(stats.shadowTotalCostR, 0) !== 0
    );
}
function closedCompletedCount(stats = {}) {
    return (
         safeNumber(stats.virtualCompleted, 0) +
         safeNumber(stats.shadowCompleted, 0)
    );
}


function actualOutcomeCounts(stats = {}) {
    if (hasSourceBuckets(stats)) {
         const virtualCompleted = safeNumber(stats.virtualCompleted, 0);
         const shadowCompleted = safeNumber(stats.shadowCompleted, 0);


         const virtualWins = safeNumber(stats.virtualWins, 0);
         const virtualLosses = safeNumber(stats.virtualLosses, 0);
         const virtualFlats = safeNumber(stats.virtualFlats, 0);


         const shadowWins = safeNumber(stats.shadowWins, 0);
         const shadowLosses = safeNumber(stats.shadowLosses, 0);
         const shadowFlats = safeNumber(stats.shadowFlats, 0);


         const completed = virtualCompleted + shadowCompleted;
         const bucketCompleted =
              virtualWins +
              virtualLosses +
              virtualFlats +
              shadowWins +
              shadowLosses +
              shadowFlats;


         const inferredFlats = Math.max(0, completed - bucketCompleted);


         return {
              wins: virtualWins + shadowWins,
              losses: virtualLosses + shadowLosses,
              flats: virtualFlats + shadowFlats + inferredFlats,
              completed: Math.max(completed, bucketCompleted)
         };
    }


    return {
         wins: safeNumber(stats.wins, 0),
         losses: safeNumber(stats.losses, 0),
         flats: safeNumber(stats.flats, 0),
         completed: safeNumber(stats.completed, 0)
    };
}
function weightedCompletedCount(stats = {}) {
    const virtualCompleted = safeNumber(stats.virtualCompleted, 0);
    const shadowCompleted = safeNumber(stats.shadowCompleted, 0);


    return virtualCompleted + shadowCompleted * shadowWeight();
}


function weightedSourceCounts(stats = {}) {
    const w = shadowWeight();


    return {
         wins:
           safeNumber(stats.virtualWins, 0) +
           safeNumber(stats.shadowWins, 0) * w,


         losses:
           safeNumber(stats.virtualLosses, 0) +
           safeNumber(stats.shadowLosses, 0) * w,


         flats:
           safeNumber(stats.virtualFlats, 0) +
           safeNumber(stats.shadowFlats, 0) * w,


         completed:
           safeNumber(stats.virtualCompleted, 0) +
           safeNumber(stats.shadowCompleted, 0) * w
    };
}


function weightedSourceTotals(stats = {}) {
    const w = shadowWeight();


    return {
         totalR:
           safeNumber(stats.virtualTotalR, 0) +
           safeNumber(stats.shadowTotalR, 0) * w,


         totalPnlPct:
           safeNumber(stats.virtualTotalPnlPct, 0) +
           safeNumber(stats.shadowTotalPnlPct, 0) * w,


         totalCostR:
           safeNumber(stats.virtualTotalCostR, 0) +
           safeNumber(stats.shadowTotalCostR, 0) * w,


         grossWinR:
           safeNumber(stats.virtualGrossWinR, 0) +
           safeNumber(stats.shadowGrossWinR, 0) * w,


         grossLossR:
           safeNumber(stats.virtualGrossLossR, 0) +
           safeNumber(stats.shadowGrossLossR, 0) * w
    };
}


function isSlExitReason(value = '') {
    const reason = upper(value);


    return [
         'SL',
         'HIT_SL',
         'STOP',
         'STOP_LOSS',
         'STOPLOSS',
         'STOPPED',
         'HIT_STOP',
         'HARD_SL',
         'DIRECT_SL'
    ].includes(reason) ||
         reason.includes('STOP_LOSS') ||
         reason.includes('STOPLOSS') ||
         reason.includes('HIT_SL') ||
         reason.includes('DIRECT_SL');
}


function isDirectSL(row = {}) {
    if (
         row.directToSL === true ||
         row.directSL === true ||
         row.directStopLoss === true ||
         row.isDirectSL === true
    ) {
         return true;
    }


    if (!isSlExitReason(row.exitReason || row.reason)) {
         return false;
    }


    if (
         row.nearTpSeen === true ||
         row.reachedHalfR === true ||
         row.reachedOneR === true
    ) {
         return false;
    }


    const mfeR = safeNumber(row.mfeR, 0);
    const maeR = safeNumber(row.maeR, 0);


    return mfeR < 0.25 || maeR <= -0.8;
}


function inferCostR(row = {}, exitR = 0) {
    const explicit = finiteOrNull(
         row.costR ??
           row.avgCostR ??
           row.estimatedCostR ??
           row.netCostR
    );


    if (explicit !== null && explicit >= 0) {
         return explicit;
    }


    const geometry = longRiskGeometry(row);
    const longGrossR = finiteOrNull(
         row.longGrossR ??
           row.grossLongR ??
           geometry.longGrossR
    );


    if (longGrossR !== null) {
         return Math.max(0, longGrossR - safeNumber(exitR, 0));
    }


    const grossR = finiteOrNull(
         row.grossR ??
           row.rawR ??
           row.realizedGrossR
    );


    if (grossR !== null) {
         return Math.max(0, grossR - safeNumber(exitR, 0));
    }


    const costPct = finiteOrNull(row.costPct);
    const riskPct = finiteOrNull(row.riskPct);


    if (costPct !== null && riskPct !== null && riskPct > 0) {
         return Math.max(0, costPct / riskPct);
    }


    return 0;
}


function normalizeDedupeKey(value = '') {
    return String(value || '')
         .trim()
         .toUpperCase()
         .slice(0, 240);
}


function observationDedupeKey(row = {}) {
    const direct = normalizeDedupeKey(
         row.observationDedupeKey ||
           row.observationKey ||
           row.obsKey ||
           row.dedupeKey ||
           ''
    );


    if (direct) return direct;


    const microId = rowMicroId(row);
    const snapshotId = normalizeDedupeKey(row.snapshotId || row.scanId ||
row.batchId || '');
    const symbol = normalizeDedupeKey(row.symbol || row.baseSymbol ||
row.contractSymbol || '');
    const entry = safeNumber(row.entry || row.entryPrice, 0);


    if (!microId || !symbol) return '';


    if (snapshotId) {
         return normalizeDedupeKey(`${snapshotId}|${symbol}|${microId}|${entry ||
'NO_ENTRY'}`);
    }


    return normalizeDedupeKey(`NO_SNAPSHOT|${symbol}|${microId}|${entry ||
'NO_ENTRY'}`);
}


function observationAlreadySeen(stats = {}, key = '') {
    const normalized = normalizeDedupeKey(key);


    if (!normalized) return false;


    const keys = Array.isArray(stats.observationDedupeKeys)
        ? stats.observationDedupeKeys
        : [];


    return keys.includes(normalized);
}


function rememberObservationKey(stats = {}, key = '') {
    const normalized = normalizeDedupeKey(key);


    if (!normalized) return stats;


    const keys = Array.isArray(stats.observationDedupeKeys)
        ? stats.observationDedupeKeys
        : [];


    keys.push(normalized);


    stats.observationDedupeKeys = [...new Set(keys)].slice(-
observationDedupeCacheLimit());
    stats.lastObservationDedupeKey = normalized;


    return stats;
}


function observationIsDuplicate(stats = {}, row = {}) {
    if (
        row.observationDuplicate === true ||
        row.observationAlreadyCounted === true ||
        row.observationCounted === false ||
        row.countObservation === false ||
        row.skipObservationCount === true ||
        row.observationSkipped === true
    ) {
        return true;
    }


    const key = observationDedupeKey(row);


    return Boolean(key && observationAlreadySeen(stats, key));
}


function outcomeIsDuplicate(row = {}) {
    return (
        row.outcomeDuplicate === true ||
        row.outcomeAlreadyRecorded === true ||
        row.outcomeCounted === false ||
        row.countOutcome === false ||
         row.skipOutcomeCount === true ||
         row.outcomeSkipped === true
    );
}


function aggregateRecentOutcomes(stats = {}) {
    const statsId = rowMicroId(stats);


    const outcomes = Array.isArray(stats.recentOutcomes)
         ? stats.recentOutcomes
               .filter(isLongRow)
               .filter(isCurrentMeasurementOutcome)
         : [];


    return outcomes.reduce(
         (acc, row) => {
           const src = normalizeSource(row.source);


           if (src !== SOURCE_VIRTUAL && src !== SOURCE_SHADOW) {
               return acc;
           }


           const rowId = rowMicroId(row);


           if (statsId && rowId && rowId !== statsId) {
               return acc;
           }


           const weight = sourceWeight(src);


           const exitR = outcomeExitR(row);
           const pnlPct = safeNumber(row.netPnlPct ?? row.pnlPct, 0);
           const costR = inferCostR(row, exitR);


           const win = exitR > 0;
           const loss = exitR < 0;
           const flat = !win && !loss;


           acc.completed += weight;
           acc.actualCompleted += 1;


           if (win) {
               acc.wins += weight;
               acc.actualWins += 1;
               acc.grossWinR += exitR * weight;
           }
     if (loss) {
         acc.losses += weight;
         acc.actualLosses += 1;
         acc.grossLossR += Math.abs(exitR) * weight;
     }


     if (flat) {
         acc.flats += weight;
         acc.actualFlats += 1;
     }


     acc.totalR += exitR * weight;
     acc.totalPnlPct += pnlPct * weight;
     acc.totalCostR += costR * weight;


     if (isDirectSL(row)) acc.directSLCount += weight;
     if (row.nearTpSeen) acc.nearTpCount += weight;
     if (row.reachedHalfR) acc.reachedHalfRCount += weight;
     if (row.reachedOneR) acc.reachedOneRCount += weight;


     if (row.beWouldExit) acc.beWouldExitCount += weight;
     if (row.gaveBackAfterHalfR) acc.gaveBackAfterHalfRCount += weight;
     if (row.gaveBackAfterOneR) acc.gaveBackAfterOneRCount += weight;
     if (row.nearTpThenLoss) acc.nearTpThenLossCount += weight;


     return acc;
},
{
     completed: 0,
     wins: 0,
     losses: 0,
     flats: 0,


     actualCompleted: 0,
     actualWins: 0,
     actualLosses: 0,
     actualFlats: 0,


     totalR: 0,
     totalPnlPct: 0,
     totalCostR: 0,
     grossWinR: 0,
     grossLossR: 0,


     directSLCount: 0,
     nearTpCount: 0,
     reachedHalfRCount: 0,
             reachedOneRCount: 0,


             beWouldExitCount: 0,
             gaveBackAfterHalfRCount: 0,
             gaveBackAfterOneRCount: 0,
             nearTpThenLossCount: 0
         }
    );
}


function maxPositive(...values) {
    return Math.max(0, ...values.map((value) => positive(value)));
}


function chooseTotal({
    sourceValue,
    storedValue,
    recentValue,
    sourceCompleted,
    storedCompleted,
    recentCompleted,
    allowRecentFallback = true
}) {
    if (sourceCompleted > 0) return safeNumber(sourceValue, 0);
    if (storedCompleted > 0) return safeNumber(storedValue, 0);
    if (allowRecentFallback && recentCompleted > 0) return safeNumber(recentValue,
0);


    return safeNumber(storedValue ?? sourceValue ?? recentValue, 0);
}


function sampleReliability(completed) {
    const n = safeNumber(completed, 0);


    if (n <= 0) return 0;


    return clamp(Math.sqrt(Math.min(n, sampleCap()) / sampleCap()), 0, 1);
}


function sampleAdjustedAvgR(avgR, reliability) {
    const cappedAvgR = clamp(
         safeNumber(avgR, 0),
         -avgRCap(),
         avgRCap()
    );


    const samplePenalty = Math.pow(
         clamp(reliability, 0, 1),
         avgRSampleExponent()
    );


    return cappedAvgR * samplePenalty;
}


function learningStatus(stats = {}) {
    const completed = safeNumber(stats.completed, 0);


    if (completed <= 0) return 'OBSERVING';
    if (completed < MIN_COMPLETED_ACTIVE) return 'EARLY_OUTCOMES';


    return 'ACTIVE_LEARNING';
}


export function createMicroStats({
    microFamilyId,
    familyId,
    side = TARGET_DASHBOARD_SIDE,
    tradeSide = TARGET_TRADE_SIDE,
    definitionParts = []
} = {}) {
    const ts = now();


    const parsed = parseLongTaxonomyMicroId(microFamilyId);
    const resolvedMicroFamilyId = parsed.isChild
         ? parsed.childTrueMicroFamilyId
         : String(microFamilyId || '').trim().toUpperCase();


    const parentTrueMicroFamilyId = parsed.parentTrueMicroFamilyId || null;


    const inferredTradeSide = inferTradeSide({
         microFamilyId: resolvedMicroFamilyId,
         familyId,
         side,
         tradeSide,
         definitionParts
    });


    const cleanTradeSide = inferredTradeSide === TARGET_TRADE_SIDE
         ? TARGET_TRADE_SIDE
         : normalizeTradeSide(tradeSide || side);


    const isLong = cleanTradeSide === TARGET_TRADE_SIDE;
    const isChild = parsed.isChild === true;
return {
  microFamilyId: resolvedMicroFamilyId,
  trueMicroFamilyId: resolvedMicroFamilyId,
  childTrueMicroFamilyId: isChild ? resolvedMicroFamilyId : null,
  analyzeMicroFamilyId: resolvedMicroFamilyId,
  learningMicroFamilyId: resolvedMicroFamilyId,


  coarseMicroFamilyId: parentTrueMicroFamilyId,
  baseMicroFamilyId: parentTrueMicroFamilyId,
  legacyMicroFamilyId: parentTrueMicroFamilyId,


  parentTrueMicroFamilyId,
  parentMacroFamilyId: parentTrueMicroFamilyId,
  parentMicroFamilyId: parentTrueMicroFamilyId,
  macroFamilyId: parentTrueMicroFamilyId,


  familyId,


  side: isLong ? TARGET_DASHBOARD_SIDE : 'unknown',
  tradeSide: isLong ? TARGET_TRADE_SIDE : null,
  positionSide: isLong ? TARGET_TRADE_SIDE : null,
  direction: isLong ? TARGET_TRADE_SIDE : null,


  targetTradeSide: TARGET_TRADE_SIDE,
  targetScannerSide: TARGET_SCANNER_SIDE,
  dashboardSide: TARGET_DASHBOARD_SIDE,


  longOnly: true,
  shortDisabled: true,
  shortOnly: false,
  longDisabled: false,


  source: SOURCE_VIRTUAL,


  schema: TRUE_MICRO_SCHEMA,
  microFamilySchema: TRUE_MICRO_SCHEMA,
  trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
  childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
  exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
  parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
  broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
  learningGranularity: LEARNING_GRANULARITY,
  parentLearningGranularity: PARENT_LEARNING_GRANULARITY,


  setupType: parsed.setupType || null,
  regimeBucket: parsed.regimeBucket || null,
  confirmationProfile: parsed.confirmationProfile || null,
    fixedTaxonomyLearningId: isChild,
    fixedTaxonomyBaseId: parentTrueMicroFamilyId,
    selectableChild: isChild,


    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    exactTrueMicroFamilyRequired: true,
    selectionGranularity: 'EXACT_75_CHILD',
    parentSelectionAllowed: false,


    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisKeysSeparatedFromShortRoot: true,
    shortRootTouched: false,


    definitionParts,
    definition: definitionParts.join(' | '),


    seen: 0,
    observations: 0,
    observationDuplicateSkippedCount: 0,
    observationDedupeKeys: [],
    observationAlwaysCounted: false,
    ...createTemporalStatsShape(),
virtualCompleted: 0,
realCompleted: 0,
shadowCompleted: 0,
completed: 0,
winrateSample: 0,


wins: 0,
losses: 0,
flats: 0,


virtualWins: 0,
virtualLosses: 0,
virtualFlats: 0,


realWins: 0,
realLosses: 0,
realFlats: 0,


shadowWins: 0,
shadowLosses: 0,
shadowFlats: 0,


totalR: 0,
virtualTotalR: 0,
realTotalR: 0,
shadowTotalR: 0,


totalPnlPct: 0,
virtualTotalPnlPct: 0,
realTotalPnlPct: 0,
shadowTotalPnlPct: 0,


totalCostR: 0,
virtualTotalCostR: 0,
realTotalCostR: 0,
shadowTotalCostR: 0,


grossWinR: 0,
grossLossR: 0,


virtualGrossWinR: 0,
virtualGrossLossR: 0,
realGrossWinR: 0,
realGrossLossR: 0,
shadowGrossWinR: 0,
shadowGrossLossR: 0,
avgR: 0,
avgWinR: 0,
avgLossR: 0,
sampleAdjustedAvgR: 0,
avgRScore: 0,


avgPnlPct: 0,


directSLCount: 0,
nearTpCount: 0,
reachedHalfRCount: 0,
reachedOneRCount: 0,


beWouldExitCount: 0,
gaveBackAfterHalfRCount: 0,
gaveBackAfterOneRCount: 0,
nearTpThenLossCount: 0,


avgCostR: 0,


winrate: 0,
bayesianWinrate: 0,
wilsonLowerBound: 0,
fairWinrate: 0,
sampleAdjustedWinrate: 0,


sampleRawWinrate: 0,
sampleBayesianWinrate: 0,
sampleWilsonLowerBound: 0,
sampleReliabilityOld: 0,


profitFactor: 0,
sampleReliability: 0,
balancedScore: 0,
dashboardBalancedScore: 0,


directSLPct: 0,
nearTpPct: 0,
reachedHalfRPct: 0,
reachedOneRPct: 0,


beWouldExitPct: 0,
gaveBackAfterHalfRPct: 0,
gaveBackAfterOneRPct: 0,
nearTpThenLossPct: 0,
costStatsInferredFromRecent: false,
directSLStatsInferredFromRecent: false,


validLongRiskShape: 'entry > 0 && sl > 0 && sl < entry && tp > entry',
longRiskShape: 'sl < entry < tp',
riskTradeSide: TARGET_TRADE_SIDE,
riskGeometryRule: 'LONG: sl < entry < tp',
tpHitRule: 'LONG: price >= tp',
slHitRule: 'LONG: price <= sl',
grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
currentRFormula: '(currentPrice - entry) / (entry - initialSl)',
longGrossRFormula: '(exitPrice - entry) / (entry - initialSl)',
longCurrentRFormula: '(currentPrice - entry) / (entry - initialSl)',


scannerFingerprintRole: 'METADATA_ONLY',
scannerFingerprintsMetadataOnly: true,
scannerFingerprintsUsedAsLearningFamily: false,
scannerBucketsMetadataOnly: true,
legacy25BucketsMetadataOnly: true,


executionFingerprintRole: 'METADATA_ONLY',
executionFingerprintsMetadataOnly: true,
executionFingerprintsUsedAsLearningFamily: false,


analyzeMicroFamiliesOnly: true,
learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
symbolExcludedFromFamilyId: true,
coinNameExcludedFromFamilyId: true,
hashesExcludedFromFamilyId: true,


completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
completedOnlyClosedVirtualOrShadow: true,
completedMeasurementFilter: MEASUREMENT_FIX_VERSION,
completedCurrentMeasurementOnly: true,
scoringRSource: 'netR',
winsLossesFlatsSource: 'netR',
winrateDefinition: 'netR > 0',
avgRSource: 'netR',
totalRSource: 'netR',
avgCostRShown: true,
avgCostRSource: 'costR',


measurementFixVersion: MEASUREMENT_FIX_VERSION,
outcomeMeasurementVersion: MEASUREMENT_FIX_VERSION,
acceptedOutcomeMeasurementVersion: MEASUREMENT_FIX_VERSION,
previousSupportedMeasurementFixVersion: PREVIOUS_MEASUREMENT_FIX_VERSION,
outcomeMeasurementGateMode: OUTCOME_MEASUREMENT_GATE_MODE,
    outcomeMeasurementVersionRequired: true,
    strictOutcomeMeasurementGate: true,
    legacyOutcomeMeasurementsExcluded: true,
    completedCurrentMeasurementOnly: true,
    exitFillModelVersion: EXIT_FILL_MODEL_VERSION,
    exitFillPolicy: 'TP_SL_USE_TRIGGER_BOUNDARY_TIME_STOP_USES_OBSERVED_PRICE',
    exitFillAssumption: 'TRIGGER_BOUNDARY_PLUS_COST_MODEL',
    measurementVersionAcceptedOutcomeCount: 0,
    measurementVersionRejectedOutcomeCount: 0,
    seenDefinition: 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY',
    observationDedupeRequired: true,


    defaultRanking:
'dashboardBalancedScore|balancedScore|fairWinrate|totalR|avgR|avgCostR',
    bareWinrateRankingDisabled: true,
    rawWinrateRankingDisabled: true,
    rankingUsesBalancedScore: true,
    rankingUsesFairWinrate: true,
    rankingUsesTotalR: true,
    rankingUsesAvgR: true,
    rankingUsesAvgCostR: true,


    currentFit: 'UNKNOWN',
    currentFitLabel: 'UNKNOWN',
    currentFitScore: 0,
    fitScore: 0,
    currentFitConfidence: 0,
    currentFitReason: null,
    currentFitReasons: [],
    currentFitVersion: CURRENT_FIT_VERSION,
    currentFitUpdatedAt: null,
    lastKnownCurrentFit: 'UNKNOWN',
    lastKnownCurrentFitScore: 0,
    lastKnownCurrentFitConfidence: 0,
    lastKnownCurrentFitAt: null,
    currentRegime: 'UNKNOWN',
    currentMarketRegime: 'UNKNOWN',
    currentTrendSide: 'UNKNOWN',
    currentMarketTrendSide: 'UNKNOWN',
    currentBearishPct: null,
    currentBullishPct: null,
    currentSqueezePct: null,
    currentMarketWeatherAgeSec: null,
    currentMarketWeatherStale: false,
    currentMarketWeatherAvailable: false,


    currentFitSoftOnly: true,
         currentFitBlocksLearning: false,
         currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
         currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
         learningRemainsBroad: true,
         selectionWillBeAdaptive: true,
         discordWillBeStrict: true,


         adaptiveLayerBuilt: false,
         adaptiveScoreBuilt: false,
         recentMomentumScoreBuilt: false,
         currentFitScoreBuilt: false,
         parentDiversificationBuilt: false,


         learningStatus: 'OBSERVING',
         status: 'OBSERVING',
         awaitingOutcomes: true,
         tooEarly: true,
         minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE,


         counters: makeCounters(),


         examples: [],
         recentOutcomes: [],


         createdAt: ts,
         updatedAt: ts
    };
}


function ensureStatsShape(stats = {}) {
    migrateOutcomeMeasurementVersion(stats);
    ensureTemporalStats(stats);


    stats.counters ||= makeCounters();
    stats.counters.rsiZone ||= {};
    stats.counters.flow ||= {};
    stats.counters.obRelation ||= {};
    stats.counters.btcState ||= {};
    stats.counters.regime ||= {};
    stats.counters.scannerReason ||= {};


    stats.examples = Array.isArray(stats.examples) ?
stats.examples.filter(isLongRow) : [];
    stats.recentOutcomes = Array.isArray(stats.recentOutcomes)
         ? stats.recentOutcomes
             .filter(isLongRow)
             .filter(isCurrentMeasurementOutcome)
           .slice(-50)
       : [];


  stats.definitionParts = Array.isArray(stats.definitionParts)
       ? stats.definitionParts
       : [];


  stats.observationDedupeKeys = Array.isArray(stats.observationDedupeKeys)
       ? stats.observationDedupeKeys.map(normalizeDedupeKey).filter(Boolean).slice(-
observationDedupeCacheLimit())
       : [];


  stats.definition ||= stats.definitionParts.join(' | ');


  stats.longOnly = true;
  stats.shortDisabled = true;
  stats.shortOnly = false;
  stats.longDisabled = false;
  stats.source ||= SOURCE_VIRTUAL;


  stats.minCompletedForActiveLearning = MIN_COMPLETED_ACTIVE;


  stats.currentFit = normalizeCurrentFitLabel(
       stats.currentFit ||
         stats.currentFitLabel ||
         stats.entryCurrentFit
  );
  stats.currentFitLabel = stats.currentFit;
  stats.currentFitReasons = Array.isArray(stats.currentFitReasons)
       ? stats.currentFitReasons
       : [];
  stats.currentFitVersion ||= CURRENT_FIT_VERSION;
  stats.currentMarketRegime ||= stats.currentRegime || 'UNKNOWN';
  stats.currentRegime ||= stats.currentMarketRegime || 'UNKNOWN';
  stats.currentMarketTrendSide ||= stats.currentTrendSide || 'UNKNOWN';
  stats.currentTrendSide ||= stats.currentMarketTrendSide || 'UNKNOWN';
  stats.currentMarketWeatherAvailable =
Boolean(stats.currentMarketWeatherAvailable);
  stats.currentMarketWeatherStale = Boolean(stats.currentMarketWeatherStale);


  applySideIdentity(stats);


  const numericFields = [
       'seen',
       'observations',
       'observationDuplicateSkippedCount',
       'outcomeDuplicateSkippedCount',
'measurementVersionAcceptedOutcomeCount',
'measurementVersionRejectedOutcomeCount',


'virtualCompleted',
'realCompleted',
'shadowCompleted',
'completed',
'winrateSample',


'wins',
'losses',
'flats',


'virtualWins',
'virtualLosses',
'virtualFlats',


'realWins',
'realLosses',
'realFlats',


'shadowWins',
'shadowLosses',
'shadowFlats',


'totalR',
'virtualTotalR',
'realTotalR',
'shadowTotalR',


'totalPnlPct',
'virtualTotalPnlPct',
'realTotalPnlPct',
'shadowTotalPnlPct',


'totalCostR',
'virtualTotalCostR',
'realTotalCostR',
'shadowTotalCostR',


'grossWinR',
'grossLossR',


'virtualGrossWinR',
'virtualGrossLossR',
'realGrossWinR',
'realGrossLossR',
'shadowGrossWinR',
'shadowGrossLossR',


'avgR',
'avgWinR',
'avgLossR',
'sampleAdjustedAvgR',
'avgRScore',


'avgPnlPct',
'avgCostR',


'directSLCount',
'nearTpCount',
'reachedHalfRCount',
'reachedOneRCount',


'beWouldExitCount',
'gaveBackAfterHalfRCount',
'gaveBackAfterOneRCount',
'nearTpThenLossCount',


'winrate',
'bayesianWinrate',
'wilsonLowerBound',
'fairWinrate',
'sampleAdjustedWinrate',


'sampleRawWinrate',
'sampleBayesianWinrate',
'sampleWilsonLowerBound',
'sampleReliabilityOld',


'profitFactor',
'sampleReliability',
'balancedScore',
'dashboardBalancedScore',


'currentFitScore',
'fitScore',
'currentFitConfidence',
'lastKnownCurrentFitScore',
'lastKnownCurrentFitConfidence',


'directSLPct',
'nearTpPct',
'reachedHalfRPct',
         'reachedOneRPct',


         'beWouldExitPct',
         'gaveBackAfterHalfRPct',
         'gaveBackAfterOneRPct',
         'nearTpThenLossPct'
    ];


    for (const field of numericFields) {
         stats[field] = safeNumber(stats[field], 0);
    }


    stats.realCompleted = 0;
    stats.realWins = 0;
    stats.realLosses = 0;
    stats.realFlats = 0;
    stats.realTotalR = 0;
    stats.realTotalPnlPct = 0;
    stats.realTotalCostR = 0;
    stats.realGrossWinR = 0;
    stats.realGrossLossR = 0;


    stats.currentFitSoftOnly = true;
    stats.currentFitBlocksLearning = false;
    stats.currentFitPolarity = 'BULLISH_POSITIVE_BEARISH_NEGATIVE';
    stats.currentFitDefinition = 'LONG_MIRRORED_CURRENT_FIT';
    stats.learningRemainsBroad = true;
    stats.selectionWillBeAdaptive = true;
    stats.discordWillBeStrict = true;


    stats.adaptiveLayerBuilt = false;
    stats.adaptiveScoreBuilt = false;
    stats.recentMomentumScoreBuilt = false;
    stats.currentFitScoreBuilt = hasUsableCurrentFitSnapshot(stats);
    stats.parentDiversificationBuilt = false;


    applyOutcomeMeasurementPolicyFlags(stats);


    stats.createdAt ||= now();
    stats.updatedAt ||= now();


    return stats;
}


export function updateObservation(stats, row = {}) {
    ensureStatsShape(stats);
  if (!isLongRow({ ...stats, ...row })) {
      return stats;
  }


  applySideIdentity(stats, row);
  applyCurrentFitSnapshot(stats, row);


  const dedupeKey = observationDedupeKey({
      ...stats,
      ...row
  });


  if (observationIsDuplicate(stats, row)) {
      stats.observationDuplicateSkippedCount =
safeNumber(stats.observationDuplicateSkippedCount, 0) + 1;
      stats.observationDuplicateLastSkippedAt = now();
      stats.lastObservationDedupeKey = dedupeKey || stats.lastObservationDedupeKey
|| null;
      stats.observationRecorded = false;
      stats.observationDuplicate = true;
      stats.observationAlwaysCounted = false;
      stats.updatedAt = now();


      stats.learningStatus = learningStatus(stats);
      stats.status = stats.learningStatus;
      stats.awaitingOutcomes = safeNumber(stats.completed, 0) <= 0 &&
safeNumber(stats.seen, 0) > 0;
      stats.tooEarly = safeNumber(stats.completed, 0) < MIN_COMPLETED_ACTIVE;


      return stats;
  }


  if (dedupeKey) {
      rememberObservationKey(stats, dedupeKey);
  }


  stats.seen = safeNumber(stats.seen, 0) + 1;
  stats.observations = safeNumber(stats.observations, 0) + 1;
  stats.observationRecorded = true;
  stats.observationDuplicate = false;
  stats.observationAlwaysCounted = false;


  const observationTemporalContext = recordTemporalObservation(stats, row);


  inc(stats.counters.rsiZone, row.rsiZone);
  inc(stats.counters.flow, row.flow);
  inc(stats.counters.obRelation, row.obRelation);
  inc(stats.counters.btcState, row.btcState ?? row.btcRelation);
  inc(stats.counters.regime, row.regime);
  inc(stats.counters.scannerReason, row.scannerReason);


  if (stats.examples.length < 20) {
    const microId = rowMicroId(row) || stats.microFamilyId || null;
    const parsed = parseLongTaxonomyMicroId(microId);
    const parentId = parsed.parentTrueMicroFamilyId || rowParentTrueMicroId(row)
|| stats.parentTrueMicroFamilyId || null;


    stats.examples.push({
      symbol: row.symbol || null,
      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      source: row.source || SOURCE_VIRTUAL,


      microFamilyId: microId,
      trueMicroFamilyId: microId,
      childTrueMicroFamilyId: parsed.childTrueMicroFamilyId || microId,
      parentTrueMicroFamilyId: parentId,
      coarseMicroFamilyId: parentId,


      setupType: row.setupType || stats.setupType || parsed.setupType || null,
      regimeBucket: row.regimeBucket || stats.regimeBucket || parsed.regimeBucket
|| null,
      confirmationProfile: row.confirmationProfile || stats.confirmationProfile ||
parsed.confirmationProfile || null,


      scannerMicroFamilyId: row.scannerMicroFamilyId || null,
      scannerFingerprintRole: row.scannerFingerprintRole || 'METADATA_ONLY',


      rsiZone: row.rsiZone || null,
      flow: row.flow || null,
      obRelation: row.obRelation || null,
      btcState: row.btcState || null,
      btcRelation: row.btcRelation || null,
      regime: row.regime || null,
      scannerReason: row.scannerReason || null,


      observationDedupeKey: dedupeKey || null,
      observationRecorded: true,
      observationDuplicate: false,
      observationAlwaysCounted: false,


      isMirrorMicroFamily: false,
      observationMirror: false,
      mirrorOfSide: null,
        trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
        childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
        parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
        learningGranularity: LEARNING_GRANULARITY,


        longOnly: true,
        shortDisabled: true,
        shortOnly: false,
        longDisabled: false,


        riskGeometryRule: 'LONG: sl < entry < tp',
        tpHitRule: 'LONG: price >= tp',
        slHitRule: 'LONG: price <= sl',
        grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
        currentRFormula: '(currentPrice - entry) / (entry - initialSl)',
        currentFit: normalizeCurrentFitLabel(
             row.currentFit ||
             row.currentFitLabel ||
             row.entryCurrentFit
        ),
        currentFitScore: safeNumber(row.currentFitScore ?? row.fitScore, 0),
        currentFitConfidence: safeNumber(
             row.currentFitConfidence ??
             row.entryCurrentFitConfidence,
             0
        ),
        currentFitReason: row.currentFitReason || null,
        currentRegime: row.currentRegime || row.currentMarketRegime || null,
        currentTrendSide: row.currentTrendSide || row.currentMarketTrendSide ||
null,
        currentMarketWeatherAvailable: Boolean(
             row.currentMarketWeatherAvailable === true ||
             row.currentMarketWeather ||
             row.entryMarketWeather
        ),
        currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
        currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',


        ...entryTemporalFields({
             ...row,
             entryTemporalContext: observationTemporalContext
        }),


        ts: row.createdAt || row.ts || now()
      });
  }
    stats.learningStatus = learningStatus(stats);
    stats.status = stats.learningStatus;
    stats.awaitingOutcomes = safeNumber(stats.completed, 0) <= 0 &&
safeNumber(stats.seen, 0) > 0;
    stats.tooEarly = safeNumber(stats.completed, 0) < MIN_COMPLETED_ACTIVE;


    stats.updatedAt = now();


    return stats;
}


export function updateOutcome(stats, row = {}, source = SOURCE_VIRTUAL) {
    ensureStatsShape(stats);


    if (!isLongRow({ ...stats, ...row })) {
        return refreshStats(stats);
    }


    applySideIdentity(stats, row);
    applyCurrentFitSnapshot(stats, row);


    const incomingMeasurementVersion = rowMeasurementFixVersion(row);


    if (!isCurrentMeasurementOutcome(row)) {
        stats.measurementVersionRejectedOutcomeCount =
          safeNumber(stats.measurementVersionRejectedOutcomeCount, 0) + 1;


        stats.lastRejectedOutcomeMeasurementVersion =
          incomingMeasurementVersion ||
          'UNVERSIONED';


        stats.lastRejectedOutcomeMeasurementAt = now();
        stats.lastRejectedOutcomeMeasurementReason =
          'OUTCOME_MEASUREMENT_VERSION_NOT_CURRENT';


        stats.outcomeRecorded = false;
        stats.outcomeMeasurementRejected = true;
        stats.updatedAt = now();


        return refreshStats(stats);
    }


    if (outcomeIsDuplicate(row)) {
        stats.outcomeDuplicateSkippedCount =
safeNumber(stats.outcomeDuplicateSkippedCount, 0) + 1;
        stats.outcomeDuplicateLastSkippedAt = now();
    stats.updatedAt = now();


    return refreshStats(stats);
}


const statsId = rowMicroId(stats);
const rowId = rowMicroId(row);


if (statsId && rowId && statsId !== rowId) {
    return refreshStats(stats);
}


const src = normalizeSource(source || row.source || SOURCE_VIRTUAL);


if (src !== SOURCE_VIRTUAL && src !== SOURCE_SHADOW) {
    return refreshStats(stats);
}


stats.measurementVersionAcceptedOutcomeCount =
    safeNumber(stats.measurementVersionAcceptedOutcomeCount, 0) + 1;


stats.lastAcceptedOutcomeMeasurementVersion =
    incomingMeasurementVersion;


stats.lastAcceptedOutcomeMeasurementAt = now();
stats.outcomeMeasurementRejected = false;


const weight = sourceWeight(src);
const geometry = longRiskGeometry(row);


const exitR = outcomeExitR(row);
const pnlPct = safeNumber(row.netPnlPct ?? row.pnlPct, 0);
const costR = inferCostR(row, exitR);


const win = exitR > 0;
const loss = exitR < 0;
const flat = !win && !loss;


if (src === SOURCE_SHADOW) {
    stats.shadowCompleted += 1;
    stats.shadowTotalR += exitR;
    stats.shadowTotalPnlPct += pnlPct;
    stats.shadowTotalCostR += costR;


    if (win) {
      stats.shadowWins += 1;
      stats.shadowGrossWinR += exitR;
    }


    if (loss) {
        stats.shadowLosses += 1;
        stats.shadowGrossLossR += Math.abs(exitR);
    }


    if (flat) stats.shadowFlats += 1;
} else {
    stats.virtualCompleted += 1;
    stats.virtualTotalR += exitR;
    stats.virtualTotalPnlPct += pnlPct;
    stats.virtualTotalCostR += costR;


    if (win) {
        stats.virtualWins += 1;
        stats.virtualGrossWinR += exitR;
    }


    if (loss) {
        stats.virtualLosses += 1;
        stats.virtualGrossLossR += Math.abs(exitR);
    }


    if (flat) stats.virtualFlats += 1;
}


stats.completed = closedCompletedCount(stats);


stats.wins += win ? weight : 0;
stats.losses += loss ? weight : 0;
stats.flats += flat ? weight : 0;


stats.totalR += exitR * weight;
stats.totalPnlPct += pnlPct * weight;
stats.totalCostR += costR * weight;


if (win) stats.grossWinR += exitR * weight;
if (loss) stats.grossLossR += Math.abs(exitR) * weight;


const directSL = isDirectSL(row);


recordTemporalOutcome(stats, row, {
    netR: exitR,
    grossR: safeNumber(
        row.grossR ?? row.rawR ?? row.realizedGrossR ?? geometry.longGrossR,
        exitR
    ),
    costR,
    directSL
  });


  if (directSL) stats.directSLCount += weight;
  if (row.nearTpSeen) stats.nearTpCount += weight;
  if (row.reachedHalfR) stats.reachedHalfRCount += weight;
  if (row.reachedOneR) stats.reachedOneRCount += weight;


  if (row.beWouldExit) stats.beWouldExitCount += weight;
  if (row.gaveBackAfterHalfR) stats.gaveBackAfterHalfRCount += weight;
  if (row.gaveBackAfterOneR) stats.gaveBackAfterOneRCount += weight;
  if (row.nearTpThenLoss) stats.nearTpThenLossCount += weight;


  const parsed = parseLongTaxonomyMicroId(rowId || statsId);
  const parentId = parsed.parentTrueMicroFamilyId || rowParentTrueMicroId(row) ||
stats.parentTrueMicroFamilyId || null;


  stats.recentOutcomes.push({
    source: src,
    sourceType: src,
    canonicalPositionId: row.canonicalPositionId || null,
    canonicalOutcomeId: row.canonicalOutcomeId || row.canonicalPositionId || row.outcomeId || null,
    acceptedTemporalOutcomeSeq: Math.max(0, Math.floor(safeNumber(row.acceptedTemporalOutcomeSeq, 0))),
    outcomeFinalizedTs: safeNumber(row.outcomeFinalizedTs ?? row.closedAt ?? row.completedAt, 0),
    outcomePersistedTs: safeNumber(row.outcomePersistedTs ?? row.updatedAt, 0),
    marketEventClusterId: row.marketEventClusterId || buildMarketEventClusterId(row),
    temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
    taxonomyVersion: TEMPORAL_TAXONOMY_VERSION,
    costModelVersion: TEMPORAL_COST_MODEL_VERSION,
    symbol: row.symbol || null,


    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,


    microFamilyId: rowId || stats.microFamilyId || null,
    trueMicroFamilyId: rowId || stats.trueMicroFamilyId || stats.microFamilyId ||
null,
    childTrueMicroFamilyId: parsed.childTrueMicroFamilyId || rowId ||
stats.childTrueMicroFamilyId || null,
    parentTrueMicroFamilyId: parentId,
    coarseMicroFamilyId: parentId,


    setupType: row.setupType || stats.setupType || parsed.setupType || null,
    regimeBucket: row.regimeBucket || stats.regimeBucket || parsed.regimeBucket ||
null,
    confirmationProfile: row.confirmationProfile || stats.confirmationProfile ||
parsed.confirmationProfile || null,


    exitReason: row.exitReason || row.reason || null,


    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    outcomeMeasurementVersion: MEASUREMENT_FIX_VERSION,
    exitFillModelVersion: row.exitFillModelVersion || EXIT_FILL_MODEL_VERSION,
    exitFillSource: row.exitFillSource || null,
    exitFillAssumption: row.exitFillAssumption || null,
      triggerBoundaryFillApplied: Boolean(row.triggerBoundaryFillApplied),
      exitObservedPrice: safeNumber(row.exitObservedPrice, null),
      exitFillPrice: safeNumber(row.exitFillPrice ?? row.exitPrice, null),
      exitTriggerPrice: safeNumber(row.exitTriggerPrice, null),
      observedVsFillPct: safeNumber(row.observedVsFillPct, 0),
      observedBeyondTriggerPct: safeNumber(row.observedBeyondTriggerPct, 0),


      entry: geometry.entry || row.entry || row.entryPrice || null,
      exit: geometry.exitPrice || row.exit || row.exitPrice || null,
      exitPrice: geometry.exitPrice || row.exitPrice || row.exit || null,
      initialSl: geometry.initialSl || row.initialSl || row.sl || null,
      sl: geometry.sl || row.sl || null,
      tp: geometry.tp || row.tp || null,
      currentPrice: geometry.currentPrice || row.currentPrice || null,


      validLongRiskShape: geometry.validLongRiskShape,
      validLongGeometry: geometry.validLongGeometry,
      riskTradeSide: TARGET_TRADE_SIDE,
      riskGeometryRule: 'LONG: sl < entry < tp',
      tpHitRule: 'LONG: price >= tp',
      slHitRule: 'LONG: price <= sl',
      longTpHit: geometry.longTpHit,
      longSlHit: geometry.longSlHit,


      exitR,
      netR: safeNumber(row.netR ?? row.longNetR ?? exitR, exitR),
      longNetR: safeNumber(row.longNetR ?? row.netR ?? exitR, exitR),
      grossR: safeNumber(row.grossR ?? row.rawR ?? row.realizedGrossR ??
geometry.longGrossR, 0),
      longGrossR: safeNumber(row.longGrossR ?? geometry.longGrossR ?? row.grossR,
0),
      longCurrentR: safeNumber(row.longCurrentR ?? geometry.longCurrentR, 0),


      grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
      currentRFormula: '(currentPrice - entry) / (entry - initialSl)',
      longGrossRFormula: '(exitPrice - entry) / (entry - initialSl)',
      longCurrentRFormula: '(currentPrice - entry) / (entry - initialSl)',


      pnlPct,
      netPnlPct: safeNumber(row.netPnlPct ?? pnlPct, pnlPct),
      grossPnlPct: safeNumber(row.grossPnlPct, 0),


      costR,
      avgCostR: costR,
      costPct: safeNumber(row.costPct, 0),
      feePct: safeNumber(row.feePct, 0),
      slippagePct: safeNumber(row.slippagePct, 0),
    mfeR: safeNumber(row.mfeR, 0),
    maeR: safeNumber(row.maeR, 0),


    directToSL: directSL,
    directSL,
    nearTpSeen: Boolean(row.nearTpSeen),
    reachedHalfR: Boolean(row.reachedHalfR),
    reachedOneR: Boolean(row.reachedOneR),


    beArmed: Boolean(row.beArmed),
    beWouldExit: Boolean(row.beWouldExit),
    beExitR: safeNumber(row.beExitR, 0),


    gaveBackAfterHalfR: Boolean(row.gaveBackAfterHalfR),
    gaveBackAfterOneR: Boolean(row.gaveBackAfterOneR),
    nearTpThenLoss: Boolean(row.nearTpThenLoss),


    entryMarketWeather: row.entryMarketWeather || null,
    entryCurrentRegime: row.entryCurrentRegime || row.currentRegime || null,
    entryCurrentTrendSide: row.entryCurrentTrendSide || row.currentTrendSide ||
null,
    entryCurrentFit: row.entryCurrentFit ?? row.currentFit ?? null,
    entryCurrentFitConfidence: safeNumber(row.entryCurrentFitConfidence ??
row.currentMarketFitConfidence, null),
    entryWeatherFitMatchedFamily: row.entryWeatherFitMatchedFamily ?? null,


    currentFit: normalizeCurrentFitLabel(
         row.currentFit ||
         row.currentFitLabel ||
         row.entryCurrentFit
    ),
    currentFitScore: safeNumber(row.currentFitScore ?? row.fitScore, 0),
    currentFitConfidence: safeNumber(
         row.currentFitConfidence ??
         row.entryCurrentFitConfidence,
         0
    ),
    currentFitReason: row.currentFitReason || null,
    currentRegime: row.currentRegime || row.currentMarketRegime || null,
    currentTrendSide: row.currentTrendSide || row.currentMarketTrendSide || null,
    currentMarketWeatherAvailable: Boolean(
         row.currentMarketWeatherAvailable === true ||
         row.currentMarketWeather ||
         row.entryMarketWeather
    ),
      currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
      currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',


      ...entryTemporalFields(row),
      ...exitTemporalFields(row),


      isMirrorMicroFamily: false,
      outcomeMirror: false,
      mirrorOfSide: null,


      trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
      childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
      parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
      learningGranularity: LEARNING_GRANULARITY,


      longOnly: true,
      shortDisabled: true,
      shortOnly: false,
      longDisabled: false,


      ts: row.closedAt || row.completedAt || now()
    });


    stats.recentOutcomes = stats.recentOutcomes.slice(-50);
    stats.updatedAt = now();


    return refreshStats(stats);
}


export function wilsonLowerBound(wins, completed, z = wilsonZ()) {
    const n = safeNumber(completed, 0);
    const w = clamp(safeNumber(wins, 0), 0, n);


    if (n <= 0) return 0;


    const p = w / n;
    const z2 = z * z;
    const denominator = 1 + z2 / n;
    const centre = p + z2 / (2 * n);
    const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);


    return clamp((centre - margin) / denominator, 0, 1);
}


export function bayesianWinrate(wins, completed) {
    const n = safeNumber(completed, 0);
    const w = safeNumber(wins, 0);
    const priorN = priorTrades();
    const priorW = priorN * priorWinrate();


    const denominator = n + priorN;


    return denominator > 0
         ? clamp((w + priorW) / denominator, 0, 1)
         : 0;
}


function buildBalancedScore({
    fair,
    avgR,
    totalR,
    sampleRel,
    profitFactor,
    nearTpPct,
    reachedOneRPct,
    directSLPct,
    nearTpThenLossPct,
    gaveBackAfterOneRPct,
    avgCostR
}) {
    const pfNorm = clamp(profitFactor, 0, 10) / 10;


    const totalRComponent = Math.log1p(positive(totalR)) * 12;
    const avgRComponent = Math.log1p(positive(avgR)) * 8;


    return (
         fair * 100 +
         sampleRel * 25 +
         totalRComponent +
         avgRComponent +
         pfNorm * 8 +
         nearTpPct * 4 +
         reachedOneRPct * 4 -
         directSLPct * 35 -
         nearTpThenLossPct * 15 -
         gaveBackAfterOneRPct * 10 -
         Math.max(0, avgCostR) * 8
    );
}


function buildAvgRScore({
    sampleAdjustedAvgRValue,
    fair,
    totalR,
    sampleRel,
    profitFactor,
    nearTpPct,
    reachedOneRPct,
    directSLPct,
    nearTpThenLossPct,
    gaveBackAfterOneRPct,
    avgCostR
}) {
    const pfNorm = clamp(profitFactor, 0, 10) / 10;
    const totalRComponent = Math.log1p(positive(totalR)) * 8;


    return (
         sampleAdjustedAvgRValue * 100 +
         fair * 35 +
         sampleRel * 25 +
         totalRComponent +
         pfNorm * 8 +
         nearTpPct * 3 +
         reachedOneRPct * 3 -
         directSLPct * 35 -
         nearTpThenLossPct * 15 -
         gaveBackAfterOneRPct * 10 -
         Math.max(0, avgCostR) * 8
    );
}


export function refreshStats(stats) {
    ensureStatsShape(stats);


    const hasBuckets = hasSourceBuckets(stats);
    const sourceCounts = weightedSourceCounts(stats);
    const sourceTotals = weightedSourceTotals(stats);
    const recent = aggregateRecentOutcomes(stats);


    const actualCounts = actualOutcomeCounts(stats);


    const closedCompleted = hasBuckets
         ? closedCompletedCount(stats)
         : Math.max(
              safeNumber(stats.completed, 0),
              actualCounts.completed,
              recent.actualCompleted
         );


    const weightedCompletedForR = hasBuckets
  ? weightedCompletedCount(stats)
  : Math.max(
       safeNumber(stats.completed, 0),
       sourceCounts.completed,
       recent.completed
  );


const weightedWins = hasBuckets
  ? sourceCounts.wins
  : Math.max(
       safeNumber(stats.wins, 0),
       recent.wins
  );


const weightedLosses = hasBuckets
  ? sourceCounts.losses
  : Math.max(
       safeNumber(stats.losses, 0),
       recent.losses
  );


const weightedFlats = hasBuckets
  ? sourceCounts.flats
  : Math.max(
       safeNumber(stats.flats, 0),
       recent.flats
  );


const totalR = chooseTotal({
  sourceValue: sourceTotals.totalR,
  storedValue: stats.totalR,
  recentValue: recent.totalR,
  sourceCompleted: sourceCounts.completed,
  storedCompleted: safeNumber(stats.completed, 0),
  recentCompleted: recent.completed
});


const totalPnlPct = chooseTotal({
  sourceValue: sourceTotals.totalPnlPct,
  storedValue: stats.totalPnlPct,
  recentValue: recent.totalPnlPct,
  sourceCompleted: sourceCounts.completed,
  storedCompleted: safeNumber(stats.completed, 0),
  recentCompleted: recent.completed
});


let totalCostR = chooseTotal({
    sourceValue: sourceTotals.totalCostR,
    storedValue: stats.totalCostR,
    recentValue: recent.totalCostR,
    sourceCompleted: sourceCounts.completed,
    storedCompleted: safeNumber(stats.completed, 0),
    recentCompleted: recent.completed
});


let costStatsInferredFromRecent = false;


if (
    weightedCompletedForR > 0 &&
    totalCostR <= 0 &&
    recent.completed > 0 &&
    recent.totalCostR > 0
) {
    const recentAvgCostR = recent.totalCostR / recent.completed;
    totalCostR = recentAvgCostR * weightedCompletedForR;
    costStatsInferredFromRecent = true;
}


const grossWinR = hasBuckets
    ? sourceTotals.grossWinR
    : maxPositive(
         stats.grossWinR,
         recent.grossWinR,
         totalR > 0 && weightedLosses <= 0 ? totalR : 0
    );


const grossLossR = hasBuckets
    ? sourceTotals.grossLossR
    : maxPositive(
         stats.grossLossR,
         recent.grossLossR,
         totalR < 0 && weightedWins <= 0 ? Math.abs(totalR) : 0
    );


const winrateSample = safeNumber(actualCounts.completed, 0);
const winrateWins = safeNumber(actualCounts.wins, 0);


const rawWinrate = winrateSample > 0
    ? winrateWins / winrateSample
    : 0;


const bayes = bayesianWinrate(winrateWins, winrateSample);
const wilson = wilsonLowerBound(winrateWins, winrateSample);
const fair = winrateSample > 0
  ? wilson * 0.8 + bayes * 0.15 + rawWinrate * 0.05
  : 0;


const reliability = sampleReliability(winrateSample);


const avgR = weightedCompletedForR > 0
  ? totalR / weightedCompletedForR
  : 0;


const avgPnlPct = weightedCompletedForR > 0
  ? totalPnlPct / weightedCompletedForR
  : 0;


const avgWinR = weightedWins > 0
  ? grossWinR / weightedWins
  : 0;


const avgLossR = weightedLosses > 0
  ? -grossLossR / weightedLosses
  : 0;


const profitFactor =
  grossLossR > 0 ? grossWinR / grossLossR :
    grossWinR > 0 ? 99 :
         0;


const directSLCount = safeNumber(stats.directSLCount, 0) > 0
  ? safeNumber(stats.directSLCount, 0)
  : recent.directSLCount;


const directSLStatsInferredFromRecent =
  safeNumber(stats.directSLCount, 0) <= 0 && recent.directSLCount > 0;


const nearTpCount = safeNumber(stats.nearTpCount, 0) > 0
  ? safeNumber(stats.nearTpCount, 0)
  : recent.nearTpCount;


const reachedHalfRCount = safeNumber(stats.reachedHalfRCount, 0) > 0
  ? safeNumber(stats.reachedHalfRCount, 0)
  : recent.reachedHalfRCount;


const reachedOneRCount = safeNumber(stats.reachedOneRCount, 0) > 0
  ? safeNumber(stats.reachedOneRCount, 0)
  : recent.reachedOneRCount;


const beWouldExitCount = safeNumber(stats.beWouldExitCount, 0) > 0
  ? safeNumber(stats.beWouldExitCount, 0)
  : recent.beWouldExitCount;


const gaveBackAfterHalfRCount = safeNumber(stats.gaveBackAfterHalfRCount, 0) > 0
  ? safeNumber(stats.gaveBackAfterHalfRCount, 0)
  : recent.gaveBackAfterHalfRCount;


const gaveBackAfterOneRCount = safeNumber(stats.gaveBackAfterOneRCount, 0) > 0
  ? safeNumber(stats.gaveBackAfterOneRCount, 0)
  : recent.gaveBackAfterOneRCount;


const nearTpThenLossCount = safeNumber(stats.nearTpThenLossCount, 0) > 0
  ? safeNumber(stats.nearTpThenLossCount, 0)
  : recent.nearTpThenLossCount;


const directSLPct = weightedCompletedForR > 0
  ? directSLCount / weightedCompletedForR
  : 0;


const nearTpPct = weightedCompletedForR > 0
  ? nearTpCount / weightedCompletedForR
  : 0;


const reachedHalfRPct = weightedCompletedForR > 0
  ? reachedHalfRCount / weightedCompletedForR
  : 0;


const reachedOneRPct = weightedCompletedForR > 0
  ? reachedOneRCount / weightedCompletedForR
  : 0;


const beWouldExitPct = weightedCompletedForR > 0
  ? beWouldExitCount / weightedCompletedForR
  : 0;


const gaveBackAfterHalfRPct = weightedCompletedForR > 0
  ? gaveBackAfterHalfRCount / weightedCompletedForR
  : 0;


const gaveBackAfterOneRPct = weightedCompletedForR > 0
  ? gaveBackAfterOneRCount / weightedCompletedForR
  : 0;


const nearTpThenLossPct = weightedCompletedForR > 0
  ? nearTpThenLossCount / weightedCompletedForR
  : 0;
const avgCostR = weightedCompletedForR > 0
  ? totalCostR / weightedCompletedForR
  : 0;


const sampleAdjustedAvgRValue = sampleAdjustedAvgR(avgR, reliability);


const balancedScore = buildBalancedScore({
  fair,
  avgR,
  totalR,
  sampleRel: reliability,
  profitFactor,
  nearTpPct,
  reachedOneRPct,
  directSLPct,
  nearTpThenLossPct,
  gaveBackAfterOneRPct,
  avgCostR
});


const avgRScore = buildAvgRScore({
  sampleAdjustedAvgRValue,
  fair,
  totalR,
  sampleRel: reliability,
  profitFactor,
  nearTpPct,
  reachedOneRPct,
  directSLPct,
  nearTpThenLossPct,
  gaveBackAfterOneRPct,
  avgCostR
});


Object.assign(stats, {
  longOnly: true,
  shortDisabled: true,
  shortOnly: false,
  longDisabled: false,


  source: stats.source || SOURCE_VIRTUAL,


  completed: round4(closedCompleted),
  winrateSample: round4(winrateSample),


  wins: round4(weightedWins),
  losses: round4(weightedLosses),
flats: round4(weightedFlats),


totalR: round4(totalR),
totalPnlPct: round4(totalPnlPct),
totalCostR: round4(totalCostR),


virtualTotalR: round4(stats.virtualTotalR),
realTotalR: 0,
shadowTotalR: round4(stats.shadowTotalR),


virtualTotalPnlPct: round4(stats.virtualTotalPnlPct),
realTotalPnlPct: 0,
shadowTotalPnlPct: round4(stats.shadowTotalPnlPct),


virtualTotalCostR: round4(stats.virtualTotalCostR),
realTotalCostR: 0,
shadowTotalCostR: round4(stats.shadowTotalCostR),


virtualGrossWinR: round4(stats.virtualGrossWinR),
virtualGrossLossR: round4(stats.virtualGrossLossR),
realGrossWinR: 0,
realGrossLossR: 0,
shadowGrossWinR: round4(stats.shadowGrossWinR),
shadowGrossLossR: round4(stats.shadowGrossLossR),


grossWinR: round4(grossWinR),
grossLossR: round4(grossLossR),


winrate: round4(rawWinrate),
bayesianWinrate: round4(bayes),
wilsonLowerBound: round4(wilson),
fairWinrate: round4(fair),


sampleRawWinrate: round4(rawWinrate),
sampleBayesianWinrate: round4(bayes),
sampleWilsonLowerBound: round4(wilson),
sampleAdjustedWinrate: round4(fair),
sampleReliabilityOld: round4(reliability),


sampleReliability: round4(reliability),


avgR: round4(avgR),
avgPnlPct: round4(avgPnlPct),
avgWinR: round4(avgWinR),
avgLossR: round4(avgLossR),
sampleAdjustedAvgR: round4(sampleAdjustedAvgRValue),
avgRScore: round4(avgRScore),
profitFactor: round4(profitFactor),


directSLCount: round4(directSLCount),
nearTpCount: round4(nearTpCount),
reachedHalfRCount: round4(reachedHalfRCount),
reachedOneRCount: round4(reachedOneRCount),


beWouldExitCount: round4(beWouldExitCount),
gaveBackAfterHalfRCount: round4(gaveBackAfterHalfRCount),
gaveBackAfterOneRCount: round4(gaveBackAfterOneRCount),
nearTpThenLossCount: round4(nearTpThenLossCount),


directSLPct: round4(directSLPct),
nearTpPct: round4(nearTpPct),
reachedHalfRPct: round4(reachedHalfRPct),
reachedOneRPct: round4(reachedOneRPct),


beWouldExitPct: round4(beWouldExitPct),
gaveBackAfterHalfRPct: round4(gaveBackAfterHalfRPct),
gaveBackAfterOneRPct: round4(gaveBackAfterOneRPct),
nearTpThenLossPct: round4(nearTpThenLossPct),


avgCostR: round4(avgCostR),
costStatsInferredFromRecent,
directSLStatsInferredFromRecent,


balancedScore: round4(balancedScore),
dashboardBalancedScore: round4(balancedScore),


realCompleted: 0,
realWins: 0,
realLosses: 0,
realFlats: 0,


scannerFingerprintRole: 'METADATA_ONLY',
scannerFingerprintsMetadataOnly: true,
scannerFingerprintsUsedAsLearningFamily: false,
scannerBucketsMetadataOnly: true,
legacy25BucketsMetadataOnly: true,


executionFingerprintRole: stats.executionFingerprintRole || 'METADATA_ONLY',
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
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    microFamilySchema: TRUE_MICRO_SCHEMA,
    schema: TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,


    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    completedOnlyClosedVirtualOrShadow: true,
    completedMeasurementFilter: MEASUREMENT_FIX_VERSION,
    completedCurrentMeasurementOnly: true,
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,
    avgCostRSource: 'costR',


    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    outcomeMeasurementVersion: MEASUREMENT_FIX_VERSION,
    acceptedOutcomeMeasurementVersion: MEASUREMENT_FIX_VERSION,
    previousSupportedMeasurementFixVersion: PREVIOUS_MEASUREMENT_FIX_VERSION,
    outcomeMeasurementGateMode: OUTCOME_MEASUREMENT_GATE_MODE,
    outcomeMeasurementVersionRequired: true,
    strictOutcomeMeasurementGate: true,
    legacyOutcomeMeasurementsExcluded: true,
    completedCurrentMeasurementOnly: true,
    exitFillModelVersion: EXIT_FILL_MODEL_VERSION,
    exitFillPolicy: 'TP_SL_USE_TRIGGER_BOUNDARY_TIME_STOP_USES_OBSERVED_PRICE',
    exitFillAssumption: 'TRIGGER_BOUNDARY_PLUS_COST_MODEL',
    measurementVersionAcceptedOutcomeCount:
round4(stats.measurementVersionAcceptedOutcomeCount),
    measurementVersionRejectedOutcomeCount:
round4(stats.measurementVersionRejectedOutcomeCount),
    seenDefinition: 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY',
    observationDedupeRequired: true,
    observationAlwaysCounted: false,


    defaultRanking:
'dashboardBalancedScore|balancedScore|fairWinrate|totalR|avgR|avgCostR',
    bareWinrateRankingDisabled: true,
    rawWinrateRankingDisabled: true,
    rankingUsesBalancedScore: true,
    rankingUsesFairWinrate: true,
    rankingUsesTotalR: true,
    rankingUsesAvgR: true,
    rankingUsesAvgCostR: true,


    currentFit: normalizeCurrentFitLabel(
         stats.currentFit ||
         stats.currentFitLabel ||
         stats.lastKnownCurrentFit
    ),
    currentFitLabel: normalizeCurrentFitLabel(
         stats.currentFit ||
         stats.currentFitLabel ||
         stats.lastKnownCurrentFit
    ),
    currentFitScore: round4(stats.currentFitScore),
    fitScore: round4(stats.fitScore ?? stats.currentFitScore),
    currentFitConfidence: round4(stats.currentFitConfidence),
    currentFitVersion: stats.currentFitVersion || CURRENT_FIT_VERSION,
    currentFitReasons: Array.isArray(stats.currentFitReasons)
         ? stats.currentFitReasons.slice(0, 20)
         : [],
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
    currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
    learningRemainsBroad: true,
    selectionWillBeAdaptive: true,
    discordWillBeStrict: true,


    adaptiveLayerBuilt: false,
    adaptiveScoreBuilt: false,
    recentMomentumScoreBuilt: false,
    currentFitScoreBuilt: hasUsableCurrentFitSnapshot(stats),
    parentDiversificationBuilt: false,


    validLongRiskShape: 'entry > 0 && sl > 0 && sl < entry && tp > entry',
    longRiskShape: 'sl < entry < tp',
    riskTradeSide: TARGET_TRADE_SIDE,
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
         redisKeysSeparatedFromShortRoot: true,
         shortRootTouched: false,


         tooEarly: closedCompleted < MIN_COMPLETED_ACTIVE,
         minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE,


         updatedAt: now()
    });


    applySideIdentity(stats);


    stats.learningStatus = learningStatus(stats);
    stats.status = stats.learningStatus;
    stats.awaitingOutcomes = safeNumber(stats.completed, 0) <= 0 &&
safeNumber(stats.seen, 0) > 0;


    return stats;
}


export function normalizeDashboardMicro(row = {}, rank = null) {
    const stats = refreshStats(row);


    const normalized = {
         ...stats,


         sampleRawWinrate: stats.winrate,
         sampleBayesianWinrate: stats.bayesianWinrate,
         sampleWilsonLowerBound: stats.wilsonLowerBound,
         sampleAdjustedWinrate: stats.fairWinrate,
         sampleReliabilityOld: stats.sampleReliability,


         dashboardBalancedScore: stats.balancedScore,


         tooEarly: safeNumber(stats.completed, 0) < MIN_COMPLETED_ACTIVE,
         minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE
    };
    applySideIdentity(normalized);


    if (rank !== null && rank !== undefined) {
         normalized.rank = rank;
    }


    return normalized;
}


export function normalizeDashboardSummary(summary = {}) {
    const out = { ...summary };


    for (const key of ['bestBalanced', 'bestTotalR', 'bestWinrate',
'lowestDirectSL']) {
         if (out[key] && typeof out[key] === 'object' &&
isRealAnalyzeMicroRow(out[key])) {
             out[key] = normalizeDashboardMicro(out[key]);
         } else {
             out[key] = null;
         }
    }


    return out;
}


function sortById(a, b) {
    return String(a.microFamilyId || '').localeCompare(String(b.microFamilyId ||
''));
}


function compareWinrate(a, b) {
    return (
         safeNumber(b.fairWinrate, 0) - safeNumber(a.fairWinrate, 0) ||
         safeNumber(b.wilsonLowerBound, 0) - safeNumber(a.wilsonLowerBound, 0) ||
         safeNumber(b.bayesianWinrate, 0) - safeNumber(a.bayesianWinrate, 0) ||
         safeNumber(b.sampleReliability, 0) - safeNumber(a.sampleReliability, 0) ||
         safeNumber(b.winrateSample, 0) - safeNumber(a.winrateSample, 0) ||
         safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
         safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
         safeNumber(a.avgCostR, 0) - safeNumber(b.avgCostR, 0) ||
         sortById(a, b)
    );
}


function compareAvgR(a, b) {
    return (
         safeNumber(b.avgRScore, 0) - safeNumber(a.avgRScore, 0) ||
         safeNumber(b.sampleAdjustedAvgR, 0) - safeNumber(a.sampleAdjustedAvgR, 0) ||
         safeNumber(b.fairWinrate, 0) - safeNumber(a.fairWinrate, 0) ||
         safeNumber(b.sampleReliability, 0) - safeNumber(a.sampleReliability, 0) ||
         safeNumber(b.winrateSample, 0) - safeNumber(a.winrateSample, 0) ||
         safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
         safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
         safeNumber(a.avgCostR, 0) - safeNumber(b.avgCostR, 0) ||
         sortById(a, b)
    );
}


function compareTotalR(a, b) {
    return (
         safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
         safeNumber(b.dashboardBalancedScore ?? b.balancedScore, 0) -
           safeNumber(a.dashboardBalancedScore ?? a.balancedScore, 0) ||
         safeNumber(b.fairWinrate, 0) - safeNumber(a.fairWinrate, 0) ||
         safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
         safeNumber(a.avgCostR, 0) - safeNumber(b.avgCostR, 0) ||
         safeNumber(b.sampleReliability, 0) - safeNumber(a.sampleReliability, 0) ||
         sortById(a, b)
    );
}


function compareBalanced(a, b) {
    return (
         safeNumber(b.dashboardBalancedScore ?? b.balancedScore, 0) -
           safeNumber(a.dashboardBalancedScore ?? a.balancedScore, 0) ||
         safeNumber(b.balancedScore, 0) - safeNumber(a.balancedScore, 0) ||
         safeNumber(b.fairWinrate, 0) - safeNumber(a.fairWinrate, 0) ||
         safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
         safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
         safeNumber(a.avgCostR, 0) - safeNumber(b.avgCostR, 0) ||
         compareWinrate(a, b)
    );
}


export function rankMicros(micros = {}, mode = 'balanced') {
    const safeMode = mode === 'winrate'
         ? 'balanced'
         : String(mode || 'balanced');


    const rows = Object.values(micros || {})
         .filter(Boolean)
         .filter(isRealAnalyzeMicroRow)
         .map((row) => refreshStats(row))
         .filter((row) => row.tradeSide === TARGET_TRADE_SIDE)
      .filter((row) => validLearningId(row.microFamilyId))
      .filter((row) => validLearningId(row.trueMicroFamilyId))
      .filter((row) => isSelectableLongChildTrueMicroId(row.trueMicroFamilyId ||
row.microFamilyId));


    const sorted = [...rows].sort((a, b) => {
      if (safeMode === 'totalR') {
          return compareTotalR(a, b);
      }


      if (safeMode === 'avgR') {
          return compareAvgR(a, b);
      }


      if (safeMode === 'directSL') {
          return (
               safeNumber(a.directSLPct, 0) - safeNumber(b.directSLPct, 0) ||
               safeNumber(b.dashboardBalancedScore ?? b.balancedScore, 0) -
                 safeNumber(a.dashboardBalancedScore ?? a.balancedScore, 0) ||
               safeNumber(b.fairWinrate, 0) - safeNumber(a.fairWinrate, 0) ||
               safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
               safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
               safeNumber(a.avgCostR, 0) - safeNumber(b.avgCostR, 0) ||
               safeNumber(b.winrateSample, 0) - safeNumber(a.winrateSample, 0) ||
               sortById(a, b)
          );
      }


      if (safeMode === 'observed') {
          return (
               safeNumber(b.seen, 0) - safeNumber(a.seen, 0) ||
               safeNumber(b.observations, 0) - safeNumber(a.observations, 0) ||
               safeNumber(b.dashboardBalancedScore ?? b.balancedScore, 0) -
                 safeNumber(a.dashboardBalancedScore ?? a.balancedScore, 0) ||
               safeNumber(b.fairWinrate, 0) - safeNumber(a.fairWinrate, 0) ||
               safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
               safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
               safeNumber(a.avgCostR, 0) - safeNumber(b.avgCostR, 0) ||
               sortById(a, b)
          );
      }


      return compareBalanced(a, b);
    });


    return sorted.map((row, index) => normalizeDashboardMicro(row, index + 1));
}
export {
     dashboardSideFromTradeSide
};


====================================================================================================
FILE: src/trade/tradeSystem.js
====================================================================================================

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
TEMPORAL_COST_MODEL_VERSION,
TEMPORAL_MARKET_WEATHER_PROFILE_VERSION,
BTC_DIRECTION_ROUTER_PROFILE_VERSION,
BTC_DIRECTION_ROUTER_POLICY_VERSION,
resolveEntryMarketWeatherContext,
resolveEntryBtcRouterContext
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
...source,
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
function createTradeAbortError(code = 'TRADE_SYSTEM_ABORTED', details = {}) {
const error = new Error(code);
error.code = code;
Object.assign(error, details);
return error;
}
function throwIfTradeStopped(options = {}, phase = 'UNKNOWN') {
if (options.signal?.aborted) {
throw createTradeAbortError('TRADE_SYSTEM_ABORTED', {
phase,
reason: options.signal.reason?.message || options.signal.reason || null
});
}
const deadlineAt = safeNumber(options.deadlineAt, 0);
if (deadlineAt > 0 && now() >= deadlineAt) {
throw createTradeAbortError('TRADE_SYSTEM_DEADLINE_REACHED', {
phase,
deadlineAt,
now: now()
});
}
}
async function withRuntimeBound(promise, {
signal = null,
deadlineAt = 0,
maxWaitMs = 8000,
code = 'TRADE_RUNTIME_OPERATION_TIMEOUT'
} = {}) {
throwIfTradeStopped({ signal, deadlineAt }, code);
const remainingMs = deadlineAt > 0
? Math.max(1, deadlineAt - now() - 1000)
: maxWaitMs;
const timeoutMs = Math.max(250, Math.min(maxWaitMs, remainingMs));
let timer = null;
let abortListener = null;
const task = Promise.resolve(promise);
task.catch(() => null);
try {
return await Promise.race([
task,
new Promise((_, reject) => {
timer = setTimeout(() => reject(createTradeAbortError(code, {
deadlineAt,
timeoutMs
})), timeoutMs);
if (signal) {
abortListener = () => reject(createTradeAbortError('TRADE_SYSTEM_ABORTED', {
phase: code,
reason: signal.reason?.message || signal.reason || null
}));
if (signal.aborted) abortListener();
else signal.addEventListener('abort', abortListener, { once: true });
}
})
]);
} finally {
if (timer) clearTimeout(timer);
if (signal && abortListener) signal.removeEventListener('abort', abortListener);
}
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
signal: options.signal || null,
stopBeforeDeadlineMs,
remainingMs() {
return Math.max(
0,
deadlineAt - now()
);
},
shouldStop(extraBufferMs = 0) {
return (
Boolean(options.signal?.aborted) ||
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
btcRouterState:
result.marketContext.btcRouterState ||
'UNKNOWN',
btcDirection:
result.marketContext.btcDirection ||
'UNKNOWN',
btcDirectionConfidence:
result.marketContext.btcDirectionConfidence ??
null,
btcTrendStrength:
result.marketContext.btcTrendStrength ??
null,
btcAlignedBreadthPct:
result.marketContext.btcAlignedBreadthPct ??
null,
btcBreadthConfirmed:
Boolean(result.marketContext.btcBreadthConfirmed),
btcAgainstLong:
Boolean(result.marketContext.btcAgainstLong),
btcRouterAvailable:
Boolean(result.marketContext.btcRouterAvailable),
btcRouterSource:
result.marketContext.btcRouterSource ||
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
function firstKnownNormalizedValue(normalizer, ...values) {
for (const value of values) {
const normalized = normalizer(value);
if (normalized !== 'UNKNOWN') return normalized;
}
return 'UNKNOWN';
}
function marketWeatherKeyParts(...values) {
for (const value of values) {
const raw = upper(value);
if (!raw.includes('|')) continue;
const [regimePart, sidePart] = raw.split('|');
const regime = normalizeMarketRegime(regimePart);
const trendSide = normalizeMarketTrendSide(sidePart);
if (regime !== 'UNKNOWN' && trendSide !== 'UNKNOWN') return { regime, trendSide };
}
return { regime: 'UNKNOWN', trendSide: 'UNKNOWN' };
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
const nestedSources = [
source,
source.currentMarketWeather,
source.marketWeather,
source.weather,
source.latest,
source.snapshot,
universeSource,
universeSource.currentMarketWeather,
universeSource.marketWeather,
universeSource.weather
].filter((value) => value && typeof value === 'object' && !Array.isArray(value));
const createdAt = firstFinite(
...nestedSources.flatMap((value) => [
value.generatedAt,
value.updatedAt,
value.savedAt,
value.completedAt,
value.createdAt,
value.ts
])
) || 0;
const keyParts = marketWeatherKeyParts(
...nestedSources.flatMap((value) => [
value.currentMarketWeatherKey,
value.marketWeatherKey,
value.entryMarketWeatherKey,
value.marketWeatherProfileKey
])
);
const regime = keyParts.regime !== 'UNKNOWN'
? keyParts.regime
: firstKnownNormalizedValue(
normalizeMarketRegime,
...nestedSources.flatMap((value) => [
value.currentRegime,
value.regime,
value.marketRegime,
value.breadthRegime,
value.volatilityRegime
])
);
const trendSide = keyParts.trendSide !== 'UNKNOWN'
? keyParts.trendSide
: firstKnownNormalizedValue(
normalizeMarketTrendSide,
...nestedSources.flatMap((value) => [
value.currentTrendSide,
value.trendSide,
value.marketTrendSide,
value.marketSide,
value.side,
value.direction,
value.breadthSide
])
);
const bullishPct = firstFinite(
...nestedSources.flatMap((value) => [
value.bullishPct,
value.longPct,
value.upPct,
value.breadthBullishPct,
value.universeBullishPct,
value.breadth?.bullishPct,
value.breadth?.longPct,
value.breadth?.upPct,
value.breadth?.advancePct,
value.breadth?.advanceRatio != null ? Number(value.breadth.advanceRatio) * 100 : null
])
);
const bearishPct = firstFinite(
...nestedSources.flatMap((value) => [
value.bearishPct,
value.shortPct,
value.downPct,
value.breadthBearishPct,
value.universeBearishPct,
value.breadth?.bearishPct,
value.breadth?.shortPct,
value.breadth?.downPct,
value.breadth?.declinePct,
value.breadth?.declineRatio != null ? Number(value.breadth.declineRatio) * 100 : null
])
);
const squeezePct = firstFinite(
...nestedSources.flatMap((value) => [
value.squeezePct,
value.compressionPct,
value.breadthSqueezePct,
value.breadth?.squeezePct,
value.breadth?.compressionPct
])
);
const confidence = clampNumber(
firstFinite(
...nestedSources.flatMap((value) => [
value.currentMarketFitConfidence,
value.confidence,
value.weatherConfidence,
value.currentTrendConfidence,
value.breadthConfidence
])
) ?? 50,
0,
100
);
const stale = createdAt > 0
? (now() - createdAt) / 1000 > currentFitMaxWeatherAgeSec()
: true;
const btcObjects = nestedSources.flatMap((value) => [value.btc, value.btcContext, value.btcRouterContext])
.filter((value) => value && typeof value === 'object' && !Array.isArray(value));
const btcRouterContext = resolveEntryBtcRouterContext({
...universeSource,
...source,
btc: source.btc || universeSource.btc || btcObjects[0] || null,
btcContext: source.btcContext || universeSource.btcContext || btcObjects[0] || null,
btcRouterState: firstKnownNormalizedValue(
(value) => resolveEntryBtcRouterContext({ btcState: value }).btcRouterState,
...nestedSources.flatMap((value) => [value.btcRouterState, value.btcState, value.currentBtcRouterState]),
...btcObjects.flatMap((value) => [value.btcRouterState, value.btcState, value.state])
),
btcTrendSide: firstKnownNormalizedValue(
normalizeMarketTrendSide,
...nestedSources.flatMap((value) => [value.btcTrendSide, value.btcDirection]),
...btcObjects.flatMap((value) => [value.trendSide, value.direction, value.side])
),
entryMarketWeather: source,
currentMarketWeather: source,
currentBullishPct: bullishPct,
currentBearishPct: bearishPct,
allowMarketWeatherBtcFallback: false
});
return {
ok: Boolean(source && Object.keys(source).length) && (createdAt > 0 || regime !== 'UNKNOWN' || trendSide !== 'UNKNOWN'),
source,
universe: universeSource,
createdAt,
ageSec: createdAt > 0 ? Math.round((now() - createdAt) / 1000) : null,
stale,
regime,
trendSide,
marketWeatherKey: regime !== 'UNKNOWN' && trendSide !== 'UNKNOWN' ? `${regime}|${trendSide}` : 'UNKNOWN',
bearishPct,
bullishPct,
squeezePct,
confidence,
btcRouterContext,
btcRouterState: btcRouterContext.btcRouterState,
btcDirection: btcRouterContext.direction,
btcDirectionConfidence: btcRouterContext.confidence,
btcTrendStrength: btcRouterContext.trendStrength,
btcAlignedBreadthPct: btcRouterContext.alignedBreadthPct,
btcBreadthConfirmed: btcRouterContext.breadthConfirmed,
btcAgainstLong: btcRouterContext.againstLong,
btcRouterAvailable: btcRouterContext.available,
btcRouterSource: btcRouterContext.source,
btcDirectionRouterProfileVersion: BTC_DIRECTION_ROUTER_PROFILE_VERSION,
btcDirectionRouterPolicyVersion: BTC_DIRECTION_ROUTER_POLICY_VERSION,
key: MARKET_WEATHER_KEY,
universeKey: MARKET_UNIVERSE_KEY
};
}
async function readMarketContextFromRedis(redis, redisSource = 'UNKNOWN') {
if (!redis) return { ...extractMarketWeatherShape({}, {}), redisSource };
const [weather, universe] = await Promise.all([
getJson(redis, MARKET_WEATHER_KEY, null).catch(() => null),
getJson(redis, MARKET_UNIVERSE_KEY, null).catch(() => null)
]);
return { ...extractMarketWeatherShape(weather || {}, universe || {}), redisSource };
}
function marketContextNeedsRefresh(context = {}) {
return !context.ok || context.stale || context.regime === 'UNKNOWN' || context.trendSide === 'UNKNOWN';
}
async function loadMarketContext() {
const durableRedis = getDurableRedis();
let context = await readMarketContextFromRedis(durableRedis, 'DURABLE_REDIS');
if (marketContextNeedsRefresh(context)) {
try {
const marketModule = await import('../market/marketWeather.js');
if (typeof marketModule.getMarketWeather === 'function') {
const refreshed = await marketModule.getMarketWeather({
redis: durableRedis,
refresh: true,
save: true,
allowStale: false
});
context = {
...extractMarketWeatherShape(refreshed || {}, refreshed?.marketUniverse || refreshed?.universe || {}),
redisSource: 'DURABLE_REDIS_REFRESHED'
};
}
} catch (error) {
context.refreshError = error?.message || String(error);
}
}
if (marketContextNeedsRefresh(context)) {
const volatileContext = await readMarketContextFromRedis(getVolatileRedis(), 'VOLATILE_REDIS_FALLBACK');
if (!marketContextNeedsRefresh(volatileContext) || !context.ok) context = volatileContext;
}
return context;
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
const entryWeatherContext = resolveEntryMarketWeatherContext({
...row,
entryMarketWeather: marketContext?.source || null,
entryCurrentRegime: marketContext?.regime || 'UNKNOWN',
entryCurrentTrendSide: marketContext?.trendSide || 'UNKNOWN'
});
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
entryMarketWeatherKey: entryWeatherContext.marketWeatherKey,
entryMarketWeatherRegime: entryWeatherContext.regime,
entryMarketWeatherTrendSide: entryWeatherContext.trendSide,
entryMarketWeatherAvailable: entryWeatherContext.available,
temporalMarketWeatherProfileVersion: TEMPORAL_MARKET_WEATHER_PROFILE_VERSION,
btcDirectionRouterProfileVersion: BTC_DIRECTION_ROUTER_PROFILE_VERSION,
btcDirectionRouterPolicyVersion: BTC_DIRECTION_ROUTER_POLICY_VERSION,
entryBtcRouterContext: marketContext?.btcRouterContext || null,
entryBtcRouterState: marketContext?.btcRouterState || 'UNKNOWN',
entryBtcState: marketContext?.btcRouterState || 'UNKNOWN',
entryBtcDirection: marketContext?.btcDirection || 'UNKNOWN',
entryBtcTrendSide: marketContext?.btcDirection || 'UNKNOWN',
entryBtcConfidence: marketContext?.btcDirectionConfidence ?? 0,
entryBtcDirectionConfidence: marketContext?.btcDirectionConfidence ?? 0,
entryBtcTrendStrength: marketContext?.btcTrendStrength ?? 0,
entryBtcAlignedBreadthPct: marketContext?.btcAlignedBreadthPct ?? null,
entryBtcBreadthConfirmed: Boolean(marketContext?.btcBreadthConfirmed),
entryBtcAgainstLong: Boolean(marketContext?.btcAgainstLong),
entryBtcRouterAvailable: Boolean(marketContext?.btcRouterAvailable),
entryBtcRouterSource: marketContext?.btcRouterSource || 'BTC_CONTEXT_UNAVAILABLE',
btcDirectionRouterProfileVersion: BTC_DIRECTION_ROUTER_PROFILE_VERSION,
btcDirectionRouterPolicyVersion: BTC_DIRECTION_ROUTER_POLICY_VERSION,
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
async function fetchLiveCandidateData(candidate, options = {}) {
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
const [rawOrderBook, funding, candles15m, candles1h] = await withRuntimeBound(
Promise.all([
fetchOrderBook(symbol).catch(() => null),
fetchFunding(symbol).catch(() => ({ rate: 0, fetchFailed: true })),
fetchCandles(symbol, '15m', cfg.candleLimit).catch(() => []),
fetchCandles(symbol, '1h', cfg.candleLimit).catch(() => [])
]),
{
signal: options.signal,
deadlineAt: options.deadlineAt,
maxWaitMs: 8000,
code: 'TRADE_CANDIDATE_MARKET_DATA_TIMEOUT'
}
);
const ob = analyzeOrderBook(rawOrderBook);
return {
symbol,
ob,
funding,
candles15m: Array.isArray(candles15m) ? candles15m : [],
candles1h: Array.isArray(candles1h) ? candles1h : []
};
}
async function fetchMidPrice(symbol, options = {}) {
const contractSymbol = normalizeContractSymbol(symbol);
if (!contractSymbol) return 0;
const rawOrderBook = await withRuntimeBound(
fetchOrderBook(contractSymbol).catch(() => null),
{
signal: options.signal,
deadlineAt: options.deadlineAt,
maxWaitMs: 6000,
code: 'TRADE_POSITION_PRICE_FETCH_TIMEOUT'
}
).catch(() => null);
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
async function processCandidate(candidate, options = {}) {
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
const data = await fetchLiveCandidateData(normalized, options)
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
async function safeProcessCandidate(candidate, options = {}) {
try {
throwIfTradeStopped(options, 'PROCESS_CANDIDATE_START');
return await processCandidate(candidate, options);
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
confidence: marketContext?.confidence ?? null,
btcRouterState: marketContext?.btcRouterState || 'UNKNOWN',
btcDirection: marketContext?.btcDirection || 'UNKNOWN',
btcDirectionConfidence: marketContext?.btcDirectionConfidence ?? null,
btcTrendStrength: marketContext?.btcTrendStrength ?? null,
btcAlignedBreadthPct: marketContext?.btcAlignedBreadthPct ?? null,
btcBreadthConfirmed: Boolean(marketContext?.btcBreadthConfirmed),
btcAgainstLong: Boolean(marketContext?.btcAgainstLong),
btcRouterAvailable: Boolean(marketContext?.btcRouterAvailable),
btcRouterSource: marketContext?.btcRouterSource || null,
btcDirectionRouterProfileVersion: BTC_DIRECTION_ROUTER_PROFILE_VERSION,
btcDirectionRouterPolicyVersion: BTC_DIRECTION_ROUTER_POLICY_VERSION
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
btcRouterState:
result.marketContext.btcRouterState ||
'UNKNOWN',
btcDirection:
result.marketContext.btcDirection ||
'UNKNOWN',
btcDirectionConfidence:
result.marketContext.btcDirectionConfidence ??
null,
btcTrendStrength:
result.marketContext.btcTrendStrength ??
null,
btcAlignedBreadthPct:
result.marketContext.btcAlignedBreadthPct ??
null,
btcBreadthConfirmed:
Boolean(result.marketContext.btcBreadthConfirmed),
btcAgainstLong:
Boolean(result.marketContext.btcAgainstLong),
btcRouterAvailable:
Boolean(result.marketContext.btcRouterAvailable),
btcRouterSource:
result.marketContext.btcRouterSource ||
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
throwIfTradeStopped(options, 'RUN_START');
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
const priceFetcher = async (symbol, fetchOptions = {}) => fetchMidPrice(symbol, {
...fetchOptions,
signal: options.signal,
deadlineAt: runtime.deadlineAt
});
const realExits = [];
const virtualExits = await monitorOpenPositions({
priceFetcher,
signal: options.signal,
deadlineAt: runtime.deadlineAt,
stopBeforeDeadlineMs: runtime.stopBeforeDeadlineMs,
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
throwIfTradeStopped(options, 'AFTER_OPEN_POSITION_MONITORING');
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
const availableCandidateRuntimeMs = Math.max(
0,
runtime.remainingMs() -
runtime.stopBeforeDeadlineMs -
5000
);
const estimatedCandidateWaveMs = 7000;
const affordableCandidateWaves = Math.max(
1,
Math.min(
4,
Math.floor(availableCandidateRuntimeMs / estimatedCandidateWaveMs)
)
);
const runtimeSafeCandidateLimit = Math.max(
1,
Math.min(
cfg.maxCandidatesPerInvocation,
cfg.dataConcurrency * affordableCandidateWaves
)
);
const candidateEndExclusive =
Math.min(
totalSnapshotCandidateCount,
candidateStartIndex +
runtimeSafeCandidateLimit
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
(candidate) => safeProcessCandidate(candidate, {
signal: options.signal,
deadlineAt: runtime.deadlineAt
})
);
throwIfTradeStopped(options, 'AFTER_CANDIDATE_MARKET_DATA');
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
const finalSelectionEligible =
entryDecisionSnapshot.wouldPublishWithoutTemporalAndComposition === true;
const finalEntry = {
...entry,
entryDecisionSnapshot,
temporalEntryDecisionSnapshot: entryDecisionSnapshot,
temporalDecisionPending: false,
temporalWouldBlock: entryDecisionSnapshot.temporalWouldBlock === true,
temporalBlockReasons: entryDecisionSnapshot.temporalBlockReasons || [],
weekCompositionApplied: entryDecisionSnapshot.weekCompositionApplied === true,
weekCompositionWouldBlock:
entryDecisionSnapshot.weekCompositionWouldBlock === true,
weekCompositionBlockReasons:
entryDecisionSnapshot.weekCompositionBlockReasons || [],
activeWeekCompositionId:
entryDecisionSnapshot.activeWeekCompositionId || null,
activeWeekCompositionMode:
entryDecisionSnapshot.activeWeekCompositionMode || null,
weekCompositionSlot:
entryDecisionSnapshot.weekCompositionSlot || null,
btcDirectionRouterApplied:
entryDecisionSnapshot.btcDirectionRouterApplied === true,
btcDirectionRouterWouldBlock:
entryDecisionSnapshot.btcDirectionRouterWouldBlock === true,
btcDirectionRouterBlockReasons:
entryDecisionSnapshot.btcDirectionRouterBlockReasons || [],
counterBtcExceptionUsed:
entryDecisionSnapshot.counterBtcExceptionUsed === true,
entryBtcRouterState:
entryDecisionSnapshot.entryBtcRouterState || entry.entryBtcRouterState || 'UNKNOWN',
entryBtcDirection:
entryDecisionSnapshot.entryBtcDirection || entry.entryBtcDirection || 'UNKNOWN',
entryBtcConfidence:
entryDecisionSnapshot.entryBtcConfidence ?? entry.entryBtcConfidence ?? 0,
entryBtcTrendStrength:
entryDecisionSnapshot.entryBtcTrendStrength ?? entry.entryBtcTrendStrength ?? 0,
entryBtcAlignedBreadthPct:
entryDecisionSnapshot.entryBtcAlignedBreadthPct ?? entry.entryBtcAlignedBreadthPct ?? null,
entryBtcBreadthConfirmed:
entryDecisionSnapshot.entryBtcBreadthConfirmed === true,
entryBtcAgainstLong:
entryDecisionSnapshot.entryBtcAgainstLong === true,
activeTemporalGenerationId:
entryDecisionSnapshot.activeTemporalGenerationId || null,
finalDiscordEntryAllowed:
entryDecisionSnapshot.finalDiscordEntryAllowed === true,
discordAlertEligible:
entryDecisionSnapshot.finalDiscordEntryAllowed === true,
selectedMicroFamilyAlert: finalSelectionEligible,
selectedForDiscord: finalSelectionEligible,
liveEligible:
entryDecisionSnapshot.finalDiscordEntryAllowed === true,
discordAlertReason:
entryDecisionSnapshot.finalDiscordEntryAllowed === true
? 'SELECTED_LONG_75_CHILD_MATCH_DAY_HOUR_WEATHER_BTC_AND_TEMPORAL_POLICY_ALLOWED'
: entryDecisionSnapshot.weekCompositionBlockReasons?.[0] ||
entryDecisionSnapshot.temporalBlockReasons?.[0] ||
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



====================================================================================================
FILE: api/admin/market-weather.js
====================================================================================================

// ================= FILE: api/admin/market-weather.js =================
//
// Veilige admin route voor MarketWeather.
// Deze route mag nooit stil {} teruggeven.
// Als import/build faalt, krijg je de echte fout in JSON.
const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const TARGET_SCANNER_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';
const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';

const TEMPORAL_CONTEXT_VERSION = 'LONG_TEMPORAL_CONTEXT_UTC_V1';
const WEEKEND_POLICY_VERSION = 'LONG_WEEKEND_OBSERVE_DISCORD_BLOCK_V1';
const SESSION_POLICY_VERSION = 'LONG_SESSION_OBSERVE_V1';
const WEEKEND_MODE = 'OBSERVE';
const SESSION_MODE = 'OBSERVE';

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

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = TRUE_MICRO_SCHEMA;
const LEARNING_GRANULARITY = 
'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const MEASUREMENT_FIX_VERSION = 
'LONG_MEASUREMENT_FIX_TRIGGER_BOUNDARY_EXIT_FILL_V2';
const ADMIN_ROUTE_VERSION = 'LONG_ADMIN_MARKET_WEATHER_SAFE_ROUTE_V1';
function sendJson(res, statusCode, data) {
 res.statusCode = statusCode;
 res.setHeader('Content-Type', 'application/json; charset=utf-8');
 res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
 res.end(JSON.stringify(data, null, 2));
}
function bool(value, fallback = false) {
 if (value === undefined || value === null || value === '') return fallback;
 if (typeof value === 'boolean') return value;
 if (typeof value === 'number') return value !== 0;
 const raw = String(value).trim().toLowerCase();
 if (['1', 'true', 'yes', 'y', 'on'].includes(raw)) return true;
 if (['0', 'false', 'no', 'n', 'off'].includes(raw)) return false;
 return fallback;
}
function num(value, fallback = 0) {
 const n = Number(value);
 return Number.isFinite(n) ? n : fallback;
}
function upper(value) {
 return String(value || '').trim().toUpperCase();
}
function firstFinite(...values) {
 for (const value of values) {
   const n = Number(value);
   if (Number.isFinite(n)) return n;
 }
 return null;
}
function clamp(value, min = 0, max = 100) {
 const n = num(value, min);
 if (n < min) return min;
 if (n > max) return max;
 return n;
}
function normalizeRegime(value) {
 const raw = upper(value);
 if (raw.includes('TREND')) return 'TREND';
 if (raw.includes('SQUEEZE')) return 'SQUEEZE';
 if (raw.includes('COMPRESSION')) return 'SQUEEZE';
 if (raw.includes('CHOP')) return 'CHOP';
 if (raw.includes('RANGE')) return 'CHOP';
 if (raw.includes('SIDEWAYS')) return 'CHOP';
 return raw || 'UNKNOWN';
}
function normalizeTrendSide(value) {
 const raw = upper(value);
 if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE'].includes(raw)) return 
'SHORT';
 if (['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'UPSIDE'].includes(raw)) 
return 'LONG';
 if (['NEUTRAL', 'MIXED', 'CHOP', 'SIDEWAYS', 'FLAT'].includes(raw)) return 
'NEUTRAL';
 return raw || 'UNKNOWN';
}
function dashboardTrendSide(value) {
 const side = normalizeTrendSide(value);
 if (side === 'SHORT') return 'BEAR';
 if (side === 'LONG') return 'BULL';
 if (side === 'NEUTRAL') return 'MIXED';
 return 'UNKNOWN';
}
function pct(value) {
 const n = Number(value);
 if (!Number.isFinite(n)) return null;
 if (Math.abs(n) <= 1) return Number((n * 100).toFixed(2));
 return Number(n.toFixed(2));
}
function signedPct(value) {
 const n = Number(value);
 if (!Number.isFinite(n)) return null;
 if (Math.abs(n) <= 1) return Number((n * 100).toFixed(4));
 return Number(n.toFixed(4));
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
function hasShortSignal(text = '') {
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
function hasLongSignal(text = '') {
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
function makeFallbackWeather(reason = 'NO_MARKET_WEATHER') {
 return {
   ok: false,
   available: false,
   reason,
   currentRegime: 'UNKNOWN',
   regime: 'UNKNOWN',
   currentTrendSide: 'UNKNOWN',
   trendSide: 'UNKNOWN',
   marketTrendSide: 'UNKNOWN',
   confidence: 0,
   weatherConfidence: 0,
   currentMarketFitConfidence: 0,
   currentFit: 0,
   longCurrentFit: 0,
   bullCurrentFit: 0,
   bearishCurrentFit: 0,
   bearishPct: null,
   bullishPct: null,
   neutralPct: null,
   squeezePct: null,
   sampleSize: 0,
   universeSize: 0,
   universeCount: 0,
   count: 0,
   breadth: {},
   btc: {},
   symbols: [],
   rows: [],
   universe: []
 };
}
function marketBiasText(weather = {}, breadth = {}) {
 return [
   weather.currentTrendSide,
   weather.trendSide,
   weather.marketTrendSide,
   weather.marketSide,
   weather.side,
   weather.direction,
   weather.bias,
   weather.marketBias,
   weather.currentMarketBias,
   weather.regime,
   weather.currentRegime,
   weather.marketRegime,
   weather.breadthRegime,
   breadth.currentTrendSide,
   breadth.trendSide,
   breadth.marketTrendSide,
   breadth.marketSide,
   breadth.side,
   breadth.direction,
   breadth.bias,
   breadth.marketBias,
   breadth.currentMarketBias,
   breadth.regime
 ]
   .map((value) => cleanSideText(value))
   .filter(Boolean)
   .join(' | ');
}
function resolveLongCurrentFit({
 weather = {},
 breadth = {},
 currentTrendSide = 'UNKNOWN',
 bearishPct = null,
 bullishPct = null
} = {}) {
 const explicitLongFit = firstFinite(
   weather.longCurrentFit,
   weather.currentLongFit,
   weather.bullCurrentFit,
   weather.bullishCurrentFit,
   weather.longFit,
   weather.bullFit,
   weather.bullishFit,
   breadth.longCurrentFit,
   breadth.currentLongFit,
   breadth.bullCurrentFit,
   breadth.bullishCurrentFit
 );
 if (explicitLongFit !== null) return signedPct(explicitLongFit);
 const explicitShortFit = firstFinite(
   weather.shortCurrentFit,
   weather.currentShortFit,
   weather.bearCurrentFit,
   weather.bearishCurrentFit,
   weather.shortFit,
   weather.bearFit,
   weather.bearishFit,
   breadth.shortCurrentFit,
   breadth.currentShortFit,
   breadth.bearCurrentFit,
   breadth.bearishCurrentFit
 );
 if (explicitShortFit !== null) return signedPct(-explicitShortFit);
 const rawFit = firstFinite(
   weather.currentFit,
   weather.marketCurrentFit,
   weather.marketFit,
   weather.fitScore,
   breadth.currentFit,
   breadth.marketCurrentFit,
   breadth.marketFit,
   breadth.fitScore
 );
 const normalizedSide = normalizeTrendSide(currentTrendSide);
 if (rawFit !== null) {
   if (normalizedSide === 'LONG') return signedPct(Math.abs(rawFit));
   if (normalizedSide === 'SHORT') return signedPct(-Math.abs(rawFit));
   const text = marketBiasText(weather, breadth);
   const bullish = hasLongSignal(text);
   const bearish = hasShortSignal(text);
   if (bullish && !bearish) return signedPct(Math.abs(rawFit));
   if (bearish && !bullish) return signedPct(-Math.abs(rawFit));
   return signedPct(-rawFit);
 }
 if (bullishPct !== null || bearishPct !== null) {
   return Number((num(bullishPct, 0) - num(bearishPct, 0)).toFixed(4));
 }
 if (normalizedSide === 'LONG') return 1;
 if (normalizedSide === 'SHORT') return -1;
 return 0;
}
function firstKnownNormalizedValue(normalizer, values = []) {
 for (const value of values) {
   const normalized = normalizer(value);
   if (normalized !== 'UNKNOWN') return normalized;
 }
 return 'UNKNOWN';
}
function normalizeAdminBtcState(value = '') {
 const raw = String(value || '').trim().toUpperCase();
 if (!raw || ['UNKNOWN', 'UNAVAILABLE', 'N/A', 'NA', 'NONE'].includes(raw)) return 'UNKNOWN';
 if (raw.includes('STRONG_BULL') || raw.includes('VERY_BULL') || raw.includes('HARD_BULL')) return 'STRONG_BULLISH';
 if (raw.includes('STRONG_BEAR') || raw.includes('VERY_BEAR') || raw.includes('HARD_BEAR')) return 'STRONG_BEARISH';
 if (['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'RISK_ON'].some((token) => raw.includes(token))) return 'BULLISH';
 if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'RISK_OFF'].some((token) => raw.includes(token))) return 'BEARISH';
 if (['NEUTRAL', 'MIXED', 'FLAT', 'SIDEWAYS', 'CHOP'].some((token) => raw.includes(token))) return 'NEUTRAL';
 return 'UNKNOWN';
}
function normalizeWeatherForAdmin(weatherInput = {}) {
 const weather = weatherInput && typeof weatherInput === 'object'
   ? weatherInput
   : makeFallbackWeather('INVALID_WEATHER');
 const breadth = weather.breadth || {};
 const weatherSources = [
   weather,
   weather.currentMarketWeather,
   weather.marketWeather,
   weather.weather,
   weather.latest,
   weather.snapshot,
   weather.raw,
   weather.source
 ].filter((value) => value && typeof value === 'object' && !Array.isArray(value));
 const currentRegime = firstKnownNormalizedValue(normalizeRegime,
   weatherSources.flatMap((value) => [
     value.currentRegime, value.regime, value.marketRegime,
     value.breadthRegime, value.volatilityRegime
   ])
 );
 const currentTrendSide = firstKnownNormalizedValue(normalizeTrendSide,
   weatherSources.flatMap((value) => [
     value.currentTrendSide, value.trendSide, value.marketTrendSide,
     value.marketSide, value.side, value.direction, value.breadthSide
   ])
 );
 const confidence = clamp(
   weather.currentMarketFitConfidence ??
     weather.confidence ??
     weather.weatherConfidence ??
     weather.currentTrendConfidence,
   0,
   100
 );
 const sampleSize = num(
   weather.sampleSize ??
     weather.universeSize ??
     weather.universeCount ??
     weather.count,
   0
 );
 const createdAt = firstFinite(
   weather.generatedAt,
   weather.updatedAt,
   weather.savedAt,
   weather.loadedAt,
   weather.completedAt,
   weather.createdAt,
   weather.ts
 );
 const bullishPct = pct(firstFinite(
   weather.bullishPct,
   weather.longPct,
   weather.upPct,
   weather.breadthBullishPct,
   breadth.bullishPct,
   breadth.longPct,
   breadth.upPct,
   breadth.advancePct,
   breadth.advanceRatio
 ));
 const bearishPct = pct(firstFinite(
   weather.bearishPct,
   weather.shortPct,
   weather.downPct,
   weather.breadthBearishPct,
   breadth.bearishPct,
   breadth.shortPct,
   breadth.downPct,
   breadth.declinePct,
   breadth.declineRatio
 ));
 const neutralPct = pct(firstFinite(
   weather.neutralPct,
   weather.flatPct,
   breadth.neutralPct,
   breadth.flatPct,
   breadth.neutralRatio
 ));
 const squeezePct = pct(firstFinite(
   weather.squeezePct,
   weather.compressionPct,
   breadth.squeezePct,
   breadth.compressionPct
 ));
 const longCurrentFit = resolveLongCurrentFit({
   weather,
   breadth,
   currentTrendSide,
   bearishPct,
   bullishPct
 });
 const ok =
   weather.ok === true ||
   weather.available === true ||
   sampleSize > 0 ||
   currentRegime !== 'UNKNOWN' ||
   currentTrendSide !== 'UNKNOWN';

 const marketWeatherKey = currentRegime !== 'UNKNOWN' && currentTrendSide !== 'UNKNOWN'
   ? `${currentRegime}|${currentTrendSide}`
   : 'UNKNOWN';
 const btcObjects = weatherSources.flatMap((value) => [value.btc, value.btcContext, value.btcRouterContext])
   .filter((value) => value && typeof value === 'object' && !Array.isArray(value));
 const btcRouterState = firstKnownNormalizedValue(normalizeAdminBtcState, [
   ...weatherSources.flatMap((value) => [
     value.btcRouterState, value.currentBtcRouterState, value.btcState,
     value.btcDirection, value.btcTrendSide, value.currentBtcRelation
   ]),
   ...btcObjects.flatMap((value) => [
     value.btcRouterState, value.btcState, value.state,
     value.direction, value.trendSide, value.side
   ])
 ]);
 return {
   ...temporalPolicyPayload(createdAt || Date.now()),
   ...weather,
   ok,
   available: ok,
   adminRouteVersion: ADMIN_ROUTE_VERSION,
   file: 'src/market/marketWeather.js',
   apiRoute: '/api/admin/market-weather',
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
   virtualLearning: true,
   virtualLearningForced: true,
   virtualOutcomesIncluded: true,
   shadowOutcomesIncluded: true,
   realOutcomesExcluded: true,
   realOrdersDisabled: true,
   bitgetOrdersDisabled: true,
   exchangeCallsDisabled: true,
   currentRegime,
   regime: currentRegime,
   currentTrendSide,
   currentMarketWeatherKey: marketWeatherKey,
   marketWeatherKey,
   btcRouterState,
   currentBtcRouterState: btcRouterState,
   btcState: btcRouterState,
   btcDirection: btcRouterState,
   trendSide: dashboardTrendSide(currentTrendSide),
   marketTrendSide: dashboardTrendSide(currentTrendSide),
   confidence,
   weatherConfidence: confidence,
   currentMarketFitConfidence: confidence,
   currentFit: longCurrentFit,
   longCurrentFit,
   bullCurrentFit: longCurrentFit,
   bullishCurrentFit: longCurrentFit,
   bearishCurrentFit: Number((-longCurrentFit).toFixed(4)),
   shortCurrentFit: Number((-longCurrentFit).toFixed(4)),
   currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
   currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
   bearishPct,
   bullishPct,
   neutralPct,
   squeezePct,
   sampleSize,
   universeSize: num(weather.universeSize ?? weather.universeCount ?? 
weather.count, sampleSize),
   universeCount: num(weather.universeCount ?? weather.universeSize ?? 
weather.count, sampleSize),
   count: num(weather.count ?? sampleSize, sampleSize),
   createdAt: createdAt || null,
   updatedAt: firstFinite(weather.updatedAt, weather.savedAt, 
weather.generatedAt, createdAt) || null,
   generatedAt: firstFinite(weather.generatedAt, weather.updatedAt, 
weather.savedAt, createdAt) || null,
   currentFitSoftOnly: true,
   currentFitBlocksLearning: false,
   currentFitBlocksVirtualLearning: false,
   currentFitBlocksShadowLearning: false,
   learningRemainsBroad: true,
   adaptiveLayerBuilt: false,
   adaptiveScoreBuilt: false,
   recentMomentumScoreBuilt: false,
   parentDiversificationBuilt: false,
   trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
   exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
   childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
   parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
   learningGranularity: LEARNING_GRANULARITY,
   parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
   redisNamespace: LONG_NAMESPACE,
   redisKeyPrefix: LONG_KEY_PREFIX,
   persistentLearningKey: PERSISTENT_LEARNING_KEY,
   redisKeysSeparatedFromShortRoot: true,
   shortRootTouched: false,
   riskTradeSide: TARGET_TRADE_SIDE,
   riskGeometryRule: 'LONG: sl < entry < tp',
   tpHitRule: 'LONG: price >= tp',
   slHitRule: 'LONG: price <= sl',
   grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
   currentRFormula: '(currentPrice - entry) / (entry - initialSl)',
   measurementFixVersion: MEASUREMENT_FIX_VERSION
 };
}
function buildResponse(weather, extra = {}) {
 const normalized = normalizeWeatherForAdmin(weather);
 const universe =
   Array.isArray(normalized.universe) ? normalized.universe :
   Array.isArray(normalized.rows) ? normalized.rows :
   [];
 return {
   ...temporalPolicyPayload(normalized.generatedAt || Date.now()),
   ok: normalized.ok,
   available: normalized.available,
   route: '/api/admin/market-weather',
   adminRouteVersion: ADMIN_ROUTE_VERSION,
   file: 'src/market/marketWeather.js',
   ...extra,
   currentRegime: normalized.currentRegime,
   currentTrendSide: normalized.currentTrendSide,
   currentMarketWeatherKey: normalized.currentMarketWeatherKey || normalized.marketWeatherKey || 'UNKNOWN',
   marketWeatherKey: normalized.marketWeatherKey || normalized.currentMarketWeatherKey || 'UNKNOWN',
   btcRouterState: normalized.btcRouterState || normalized.btcState || 'UNKNOWN',
   currentBtcRouterState: normalized.currentBtcRouterState || normalized.btcRouterState || normalized.btcState || 'UNKNOWN',
   btcState: normalized.btcState || normalized.btcRouterState || 'UNKNOWN',
   btcDirection: normalized.btcDirection || normalized.btcRouterState || normalized.btcState || 'UNKNOWN',
   regime: normalized.regime,
   trendSide: normalized.trendSide,
   marketTrendSide: normalized.marketTrendSide,
   confidence: normalized.confidence,
   weatherConfidence: normalized.weatherConfidence,
   currentMarketFitConfidence: normalized.currentMarketFitConfidence,
   currentFit: normalized.currentFit,
   longCurrentFit: normalized.longCurrentFit,
   bullCurrentFit: normalized.bullCurrentFit,
   bullishCurrentFit: normalized.bullishCurrentFit,
   bearishCurrentFit: normalized.bearishCurrentFit,
   shortCurrentFit: normalized.shortCurrentFit,
   currentFitPolarity: normalized.currentFitPolarity,
   currentFitDefinition: normalized.currentFitDefinition,
   bearishPct: normalized.bearishPct,
   bullishPct: normalized.bullishPct,
   neutralPct: normalized.neutralPct,
   squeezePct: normalized.squeezePct,
   sampleSize: normalized.sampleSize,
   universeSize: normalized.universeSize,
   universeCount: normalized.universeCount,
   count: normalized.count,
   createdAt: normalized.createdAt,
   updatedAt: normalized.updatedAt,
   generatedAt: normalized.generatedAt,
   breadth: normalized.breadth || {},
   btc: normalized.btc || {},
   symbols: normalized.symbols || [],
   marketUniverse: universe,
   universe,
   currentFitSoftOnly: true,
   currentFitBlocksLearning: false,
   currentFitBlocksVirtualLearning: false,
   currentFitBlocksShadowLearning: false,
   learningRemainsBroad: true,
   adaptiveLayerBuilt: false,
   adaptiveScoreBuilt: false,
   recentMomentumScoreBuilt: false,
   parentDiversificationBuilt: false,
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
   virtualLearning: true,
   virtualLearningForced: true,
   virtualOutcomesIncluded: true,
   shadowOutcomesIncluded: true,
   realOutcomesExcluded: true,
   realOrdersDisabled: true,
   bitgetOrdersDisabled: true,
   exchangeCallsDisabled: true,
   riskTradeSide: TARGET_TRADE_SIDE,
   riskGeometryRule: 'LONG: sl < entry < tp',
   tpHitRule: 'LONG: price >= tp',
   slHitRule: 'LONG: price <= sl',
   grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
   currentRFormula: '(currentPrice - entry) / (entry - initialSl)',
   trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
   exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
   childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
   parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
   learningGranularity: LEARNING_GRANULARITY,
   parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
   redisNamespace: LONG_NAMESPACE,
   redisKeyPrefix: LONG_KEY_PREFIX,
   persistentLearningKey: PERSISTENT_LEARNING_KEY,
   redisKeysSeparatedFromShortRoot: true,
   shortRootTouched: false,
   measurementFixVersion: MEASUREMENT_FIX_VERSION,
   marketWeather: normalized,
   weather: normalized,
   currentMarketWeather: normalized,
   latest: normalized,
   snapshot: normalized,
   raw: normalized
 };
}
function buildMarketWeatherOptions({
 redis,
 save,
 refresh = false
} = {}) {
 return {
   redis,
   save,
   refresh,
   allowStale: false,
   tradeSide: TARGET_TRADE_SIDE,
   side: TARGET_DASHBOARD_SIDE,
   scannerSide: TARGET_SCANNER_SIDE,
   namespace: LONG_NAMESPACE,
   keyPrefix: LONG_KEY_PREFIX,
   redisNamespace: LONG_NAMESPACE,
   redisKeyPrefix: LONG_KEY_PREFIX,
   weekKey: PERSISTENT_LEARNING_KEY,
   persistentLearningKey: PERSISTENT_LEARNING_KEY,
   trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
   childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
   parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
   learningGranularity: LEARNING_GRANULARITY,
   parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
   longOnly: true,
   shortDisabled: true,
   virtualLearning: true,
   virtualLearningForced: true,
   realOrdersDisabled: true,
   bitgetOrdersDisabled: true,
   exchangeCallsDisabled: true,
   realOutcomesExcluded: true
 };
}
export default async function handler(req, res) {
 res.setHeader('X-Temporal-Context-Version', TEMPORAL_CONTEXT_VERSION);
 res.setHeader('X-Weekend-Policy-Version', WEEKEND_POLICY_VERSION);
 res.setHeader('X-Session-Policy-Version', SESSION_POLICY_VERSION);
 res.setHeader('X-Weekend-Mode', WEEKEND_MODE);
 res.setHeader('X-Session-Mode', SESSION_MODE);
 const method = String(req?.method || 'GET').toUpperCase();
 if (method === 'OPTIONS') {
   res.setHeader('Allow', 'GET, POST, OPTIONS');
   return sendJson(res, 200, { ok: true });
 }
 if (!['GET', 'POST'].includes(method)) {
   return sendJson(res, 405, {
     ok: false,
     available: false,
     error: 'METHOD_NOT_ALLOWED',
     targetTradeSide: TARGET_TRADE_SIDE,
     dashboardSide: TARGET_DASHBOARD_SIDE,
     scannerSide: TARGET_SCANNER_SIDE,
     redisNamespace: LONG_NAMESPACE,
     persistentLearningKey: PERSISTENT_LEARNING_KEY,
     shortRootTouched: false
   });
 }
 try {
   const query = req?.query || {};
   const refresh = bool(query.refresh, false) || bool(query.force, false);
   const save = query.save === undefined ? true : bool(query.save, true);
   let marketModule;
   let redisModule;
   try {
     marketModule = await import('../../src/market/marketWeather.js');
   } catch (error) {
     return sendJson(res, 200, 
buildResponse(makeFallbackWeather('IMPORT_MARKET_WEATHER_FAILED'), {
       importOk: false,
       importError: error?.message || String(error),
       importStack: process.env.NODE_ENV === 'production' ? undefined : 
error?.stack
     }));
   }
   try {
     redisModule = await import('../../src/redis.js');
   } catch (error) {
     return sendJson(res, 200, 
buildResponse(makeFallbackWeather('IMPORT_REDIS_FAILED'), {
       importOk: false,
       importError: error?.message || String(error),
       importStack: process.env.NODE_ENV === 'production' ? undefined : 
error?.stack
     }));
   }
   const redis = redisModule.getDurableRedis
     ? redisModule.getDurableRedis()
     : undefined;
   let weather;
   let source;
   try {
     if (refresh && typeof marketModule.buildMarketWeather === 'function') {
       weather = await 
marketModule.buildMarketWeather(buildMarketWeatherOptions({
         redis,
         save,
         refresh: true
       }));
       source = 'buildMarketWeather';
     } else if (typeof marketModule.getMarketWeather === 'function') {
       weather = await marketModule.getMarketWeather(buildMarketWeatherOptions({
         redis,
         save,
         refresh: false
       }));
       source = 'getMarketWeather';
     } else if (typeof marketModule.loadMarketWeather === 'function') {
       weather = await marketModule.loadMarketWeather(buildMarketWeatherOptions({
         redis,
         save,
         refresh: false
       }));
       source = 'loadMarketWeather';
     } else {
       weather = makeFallbackWeather('NO_MARKET_WEATHER_EXPORT_FOUND');
       source = 'fallback';
     }
   } catch (error) {
     return sendJson(res, 200, 
buildResponse(makeFallbackWeather('MARKET_WEATHER_FUNCTION_FAILED'), {
       importOk: true,
       source: 'error',
       functionError: error?.message || String(error),
       functionStack: process.env.NODE_ENV === 'production' ? undefined : 
error?.stack
     }));
   }
   return sendJson(res, 200, buildResponse(weather, {
     importOk: true,
     source,
     refreshed: refresh
   }));
 } catch (error) {
   return sendJson(res, 200, 
buildResponse(makeFallbackWeather('ADMIN_ROUTE_FAILED'), {
     routeError: error?.message || String(error),
     routeStack: process.env.NODE_ENV === 'production' ? undefined : error?.stack
   }));
 }
}


====================================================================================================
FILE: public/index.html
====================================================================================================

<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>LONG 75 Micro-Family Learning Admin</title>


  <style>
    :root {
         --bg: #f3f5f9;
         --panel: #ffffff;
         --panel-soft: #f8fafc;
         --text: #0f172a;
         --muted: #64748b;
         --border: #e2e8f0;
         --border-strong: #cbd5e1;
         --dark: #0f172a;
         --green: #16a34a;
         --red: #dc2626;
         --amber: #d97706;
         --blue: #2563eb;
         --purple: #7c3aed;
         --cyan: #0891b2;
         --shadow: 0 2px 12px rgba(15, 23, 42, 0.07);
         font-family: Inter, ui-sans-serif, system-ui, -apple-system,
BlinkMacSystemFont, "Segoe UI", sans-serif;
    }


    * { box-sizing: border-box; }


    body {
         margin: 0;
         color: var(--text);
         background:
           radial-gradient(circle at top left, rgba(22, 163, 74, 0.12), transparent
30%),
           radial-gradient(circle at top right, rgba(15, 23, 42, 0.12), transparent
32%),
           var(--bg);
    }


    button,
    select,
    input,
    textarea {
        font: inherit;
    }


    button {
        border: 1px solid var(--border-strong);
        border-radius: 12px;
        padding: 10px 14px;
        background: white;
        color: var(--text);
        cursor: pointer;
        transition: 0.14s ease;
        box-shadow: 0 1px 2px rgba(15, 23, 42, 0.05);
    }


    button:hover:not(:disabled) {
        transform: translateY(-1px);
        box-shadow: 0 8px 22px rgba(15, 23, 42, 0.12);
    }


    button:disabled {
        opacity: 0.45;
        cursor: not-allowed;
        transform: none;
    }


    button.primary { background: var(--dark); color: white; border-color: var(--
dark); }
    button.success { background: var(--green); color: white; border-color: var(--
green); }
    button.warn { background: var(--amber); color: white; border-color: var(--
amber); }
    button.danger { background: var(--red); color: white; border-color: var(--
red); }
    button.long-action { background: var(--green); color: white; border-color:
var(--green); }
    button.small { padding: 6px 9px; border-radius: 9px; font-size: 12px; }


    select,
    input,
    textarea {
        border: 1px solid var(--border-strong);
        border-radius: 12px;
        padding: 10px 12px;
        background: white;
        color: var(--text);
        min-height: 42px;
}


input[type="search"] { min-width: 340px; }


textarea {
    width: 100%;
    min-height: 110px;
    resize: vertical;
    line-height: 1.45;
}


header {
    background: linear-gradient(135deg, #0f172a 0%, #111827 46%, #14532d 100%);
    color: white;
    padding: 24px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}


.header-inner {
    max-width: 1540px;
    margin: 0 auto;
    display: flex;
    justify-content: space-between;
    gap: 18px;
    align-items: flex-start;
}


.brand-title {
    display: flex;
    align-items: center;
    gap: 12px;
}


.brand-logo {
    width: 44px;
    height: 44px;
    border-radius: 16px;
    display: grid;
    place-items: center;
    background: linear-gradient(135deg, #16a34a, #86efac);
    box-shadow: 0 12px 32px rgba(22, 163, 74, 0.30);
    font-weight: 900;
    letter-spacing: -0.04em;
}


.brand-title strong {
    display: block;
    font-size: 24px;
    line-height: 1.12;
    letter-spacing: -0.03em;
}


.brand-subtitle {
    color: #cbd5e1;
    margin-top: 6px;
    font-size: 14px;
    line-height: 1.45;
}


.header-actions {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
    justify-content: flex-end;
}


.live-pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 9px 12px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.12);
    color: #cbd5e1;
    font-size: 13px;
}


.live-dot {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: #86efac;
    box-shadow: 0 0 0 4px rgba(134, 239, 172, 0.18);
}


main {
    max-width: 1540px;
    margin: 0 auto;
    padding: 20px;
}


.tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 16px;
    position: sticky;
    top: 0;
    z-index: 5;
    background: rgba(243, 245, 249, 0.88);
    backdrop-filter: blur(14px);
    padding: 10px 0;
}


.tab {
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.80);
    border-color: rgba(203, 213, 225, 0.90);
}


.tab.active {
    background: var(--dark);
    color: white;
    border-color: var(--dark);
}


.hidden,
.panel.hidden { display: none; }


.message {
    border-radius: 16px;
    padding: 13px 15px;
    margin-bottom: 14px;
    border: 1px solid var(--border);
    background: white;
    box-shadow: var(--shadow);
    white-space: pre-wrap;
}


.message.ok { color: #166534; background: #dcfce7; border-color: #bbf7d0; }
.message.error { color: #991b1b; background: #fee2e2; border-color: #fecaca; }
.message.warn { color: #92400e; background: #fef3c7; border-color: #fde68a; }


.grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(180px, 1fr));
    gap: 14px;
    margin-bottom: 14px;
}
.grid-3 {
    display: grid;
    grid-template-columns: repeat(3, minmax(220px, 1fr));
    gap: 14px;
    margin-bottom: 14px;
}


.coin-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(240px, 1fr));
    gap: 14px;
    margin-bottom: 16px;
}


.card {
    background: rgba(255, 255, 255, 0.94);
    border: 1px solid var(--border);
    border-radius: 20px;
    padding: 16px;
    box-shadow: var(--shadow);
    margin-bottom: 14px;
}


.card h3 {
    margin: 0 0 10px;
    font-size: 14px;
    color: #334155;
}


.metric-card {
    min-height: 112px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
}


.metric-label {
    color: var(--muted);
    font-size: 13px;
    font-weight: 800;
}


.metric-value {
    font-size: 26px;
    line-height: 1.1;
    font-weight: 850;
    letter-spacing: -0.04em;
    word-break: break-word;
}


.metric-extra {
    color: var(--muted);
    font-size: 12px;
    margin-top: 5px;
    line-height: 1.45;
}


.section-title {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: 12px;
    margin: 22px 0 10px;
}


.section-title h2 {
    margin: 0;
    font-size: 18px;
    letter-spacing: -0.02em;
}


.section-title p {
    margin: 4px 0 0;
    color: var(--muted);
    font-size: 13px;
}


.toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 9px;
    align-items: center;
    margin: 12px 0 14px;
}


.pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 8px;
    border-radius: 999px;
    background: #e2e8f0;
    color: #334155;
    font-size: 11px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    white-space: nowrap;
}


.pill.active { background: #dcfce7; color: #166534; }
.pill.long { background: #dcfce7; color: #166534; }
.pill.danger { background: #fee2e2; color: #991b1b; }
.pill.warn { background: #fef3c7; color: #92400e; }
.pill.info { background: #dbeafe; color: #1d4ed8; }
.pill.purple { background: #ede9fe; color: #5b21b6; }
.pill.dark { background: #0f172a; color: white; }
.pill.soft { background: #e0f2fe; color: #075985; }
.pill.observation { background: #fef9c3; color: #854d0e; }
.pill.raw { background: #f1f5f9; color: #475569; }
.pill.fit { background: #dcfce7; color: #166534; }
.pill.weakfit { background: #ccfbf1; color: #0f766e; }
.pill.neutral { background: #f1f5f9; color: #475569; }
.pill.misfit { background: #fee2e2; color: #991b1b; }
.pill.passed { background: #dcfce7; color: #166534; }
.pill.veto { background: #7f1d1d; color: #ffffff; }
.pill.blocked { background: #fee2e2; color: #991b1b; }


.score-bar {
    height: 8px;
    background: #e2e8f0;
    border-radius: 999px;
    overflow: hidden;
    margin-top: 8px;
}


.score-bar > span {
    display: block;
    height: 100%;
    width: var(--w);
    background: linear-gradient(90deg, #dc2626, #fca5a5);
    border-radius: inherit;
}


.table-wrap {
    width: 100%;
    overflow-x: auto;
    background: white;
    border: 1px solid var(--border);
    border-radius: 18px;
    box-shadow: var(--shadow);
    margin-bottom: 14px;
}


table {
    border-collapse: collapse;
    width: 100%;
    min-width: 1560px;
    background: white;
}


th,
td {
    text-align: left;
    border-bottom: 1px solid var(--border);
    padding: 10px;
    font-size: 13px;
    vertical-align: middle;
    white-space: nowrap;
}


th {
    background: #f8fafc;
    color: #334155;
    font-weight: 800;
    position: sticky;
    top: 0;
    z-index: 1;
}


tr:hover td { background: #f8fafc; }


code {
    font-size: 12px;
    background: #f1f5f9;
    padding: 3px 5px;
    border-radius: 6px;
    color: #334155;
    white-space: nowrap;
}


pre {
    white-space: pre-wrap;
    word-break: break-word;
    background: #0b1020;
    color: #e5e7eb;
    padding: 14px;
        border-radius: 16px;
        max-height: 520px;
        overflow: auto;
        margin: 0 0 10px;
        font-size: 12px;
        line-height: 1.48;
    }


    .api-url-box {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
        background: #f8fafc;
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 10px;
        margin-bottom: 10px;
    }


    .api-url-box code {
        white-space: normal;
        word-break: break-all;
    }


    .api-output-textarea {
        width: 100%;
        min-height: 360px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
"Liberation Mono", monospace;
        font-size: 12px;
        line-height: 1.45;
        background: #0b1020;
        color: #e5e7eb;
        border: 1px solid #1e293b;
        border-radius: 16px;
        padding: 14px;
        white-space: pre;
        user-select: all;
    }


    .api-output-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
    margin-bottom: 10px;
}


.api-output-head h3 {
    margin: 0;
}


.copy-big {
    background: var(--dark);
    color: white;
    border-color: var(--dark);
    font-weight: 800;
}


.micro-desktop-table table {
    min-width: 1180px;
}


.micro-id-cell {
    max-width: 360px;
    white-space: normal;
    word-break: break-word;
}


.micro-id-cell code {
    white-space: normal;
    word-break: break-all;
    line-height: 1.5;
}


.micro-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}


.micro-mobile-cards {
    display: none;
}


.micro-card {
    background: white;
    border: 1px solid var(--border);
    border-radius: 20px;
    padding: 14px;
    box-shadow: var(--shadow);
    margin-bottom: 12px;
}


.micro-card-top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 10px;
    margin-bottom: 10px;
}


.micro-card-title {
    font-size: 18px;
    font-weight: 900;
    letter-spacing: -0.03em;
}


.micro-id-button {
    width: 100%;
    text-align: left;
    padding: 10px;
    border-radius: 14px;
    margin: 8px 0;
    background: #f8fafc;
}


.micro-id-button code {
    white-space: normal;
    word-break: break-all;
    line-height: 1.55;
    font-size: 12px;
}


.micro-stat-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
    margin-top: 10px;
}


.micro-stat-box {
    background: #f8fafc;
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 9px;
}


.micro-stat-box span {
    display: block;
    color: var(--muted);
    font-size: 11px;
    font-weight: 800;
    margin-bottom: 4px;
}


.micro-stat-box strong {
    display: block;
    font-size: 14px;
    word-break: break-word;
}


    .winner-hero {
        background: linear-gradient(135deg, #052e16 0%, #14532d 55%, #166534 100%);
        color: white;
        border: 0;
    }

    .winner-hero h2,
    .winner-hero h3 {
        color: white;
    }

    .winner-hero .metric-extra {
        color: #dcfce7;
    }

    .winner-filter-grid {
        display: grid;
        grid-template-columns: repeat(5, minmax(170px, 1fr));
        gap: 10px;
        align-items: end;
    }

    .winner-filter-field label {
        display: block;
        color: var(--muted);
        font-size: 11px;
        font-weight: 900;
        margin-bottom: 5px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }

    .winner-filter-field select,
    .winner-filter-field input {
        width: 100%;
        min-width: 0;
    }

    .winner-check {
        display: inline-flex;
        gap: 8px;
        align-items: center;
        min-height: 42px;
        padding: 8px 10px;
        border: 1px solid var(--border-strong);
        border-radius: 12px;
        background: white;
        font-size: 13px;
        font-weight: 800;
    }

    .winner-check input {
        min-height: auto;
        width: 18px;
        height: 18px;
    }

    .winner-selection-bar {
        position: sticky;
        bottom: 10px;
        z-index: 4;
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
        padding: 12px;
        margin: 14px 0;
        border: 1px solid #86efac;
        border-radius: 16px;
        background: rgba(240, 253, 244, 0.96);
        box-shadow: 0 12px 34px rgba(20, 83, 45, 0.18);
        backdrop-filter: blur(12px);
    }

    .winner-selection-count {
        font-size: 15px;
        font-weight: 900;
        color: #166534;
    }

    .temporal-chip-grid {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
        max-width: 520px;
    }

    .temporal-chip {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 36px;
        padding: 5px 7px;
        border-radius: 9px;
        font-size: 10px;
        font-weight: 900;
        border: 1px solid transparent;
        cursor: default;
    }

    .temporal-chip.proven {
        color: #14532d;
        background: #bbf7d0;
        border-color: #86efac;
    }

    .temporal-chip.positive {
        color: #166534;
        background: #dcfce7;
        border-color: #bbf7d0;
    }

    .temporal-chip.learning {
        color: #854d0e;
        background: #fef9c3;
        border-color: #fde68a;
    }

    .temporal-chip.blocked,
    .temporal-chip.negative {
        color: #991b1b;
        background: #fee2e2;
        border-color: #fecaca;
    }

    .temporal-chip.confounded {
        color: #6b21a8;
        background: #f3e8ff;
        border-color: #e9d5ff;
    }

    .temporal-chip.unknown,
    .temporal-chip.neutral {
        color: #475569;
        background: #f1f5f9;
        border-color: #e2e8f0;
    }

    .temporal-profile-box {
        min-width: 170px;
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 9px;
        background: #f8fafc;
    }

    .temporal-profile-box strong {
        display: block;
        margin-bottom: 5px;
    }

    .temporal-profile-meta {
        color: var(--muted);
        font-size: 11px;
        line-height: 1.45;
    }

    .winner-verdict {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
        padding: 7px 10px;
        font-size: 11px;
        font-weight: 950;
        white-space: nowrap;
    }

    .winner-verdict.proven {
        color: white;
        background: #15803d;
    }

    .winner-verdict.positive {
        color: #14532d;
        background: #bbf7d0;
    }

    .winner-verdict.selectable {
        color: #075985;
        background: #e0f2fe;
    }

    .winner-verdict.blocked {
        color: white;
        background: #991b1b;
    }

    .winner-verdict.learning,
    .winner-verdict.unknown {
        color: #854d0e;
        background: #fef3c7;
    }

    .winner-table table {
        min-width: 1920px;
    }

    .winner-family-cell {
        max-width: 420px;
        white-space: normal;
    }

    .winner-family-cell code {
        white-space: normal;
        word-break: break-all;
    }

    .winner-mobile-cards {
        display: none;
    }

    .winner-card {
        border-left: 5px solid #cbd5e1;
    }

    .winner-card.proven { border-left-color: #16a34a; }
    .winner-card.positive { border-left-color: #86efac; }
    .winner-card.blocked { border-left-color: #dc2626; }
    .winner-card.learning { border-left-color: #f59e0b; }

    .winner-context-title {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 7px;
        margin-bottom: 8px;
    }

    .winner-explain {
        display: grid;
        grid-template-columns: repeat(4, minmax(180px, 1fr));
        gap: 10px;
    }

    .winner-explain > div {
        padding: 10px;
        border-radius: 14px;
        border: 1px solid var(--border);
        background: #f8fafc;
        font-size: 12px;
        line-height: 1.5;
    }

    .composition-plan-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(260px, 1fr));
        gap: 14px;
        margin: 14px 0;
    }

    .composition-plan-card {
        position: relative;
        border: 2px solid var(--border);
        border-radius: 18px;
        padding: 16px;
        background: white;
        cursor: pointer;
        transition: transform .15s ease, border-color .15s ease, box-shadow .15s ease;
    }

    .composition-plan-card:hover {
        transform: translateY(-2px);
        border-color: #86efac;
        box-shadow: 0 12px 30px rgba(15, 118, 110, .10);
    }

    .composition-plan-card.selected {
        border-color: #15803d;
        box-shadow: 0 0 0 3px rgba(22, 163, 74, .13);
    }

    .composition-plan-card.active::after {
        content: "ACTIEF";
        position: absolute;
        top: 12px;
        right: 12px;
        padding: 5px 8px;
        border-radius: 999px;
        background: #15803d;
        color: white;
        font-size: 10px;
        font-weight: 950;
    }

    .composition-plan-rank {
        display: inline-flex;
        min-width: 28px;
        height: 28px;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
        background: #ecfdf5;
        color: #166534;
        font-weight: 950;
        margin-right: 7px;
    }

    .composition-plan-metrics {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
        margin-top: 12px;
    }

    .composition-plan-metrics > div,
    .composition-mini-stat {
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 9px;
        background: #f8fafc;
    }

    .composition-plan-metrics span,
    .composition-mini-stat span {
        display: block;
        color: var(--muted);
        font-size: 10px;
        font-weight: 900;
        text-transform: uppercase;
        margin-bottom: 3px;
    }

    .composition-plan-metrics strong,
    .composition-mini-stat strong {
        font-size: 14px;
    }

    .composition-weather-tabs {
        display: flex;
        flex-wrap: wrap;
        gap: 7px;
        margin: 12px 0;
    }

    .composition-weather-tab {
        border: 1px solid var(--border-strong);
        border-radius: 999px;
        background: white;
        padding: 8px 11px;
        font-size: 12px;
        font-weight: 900;
    }

    .composition-weather-tab.selected {
        color: white;
        background: #166534;
        border-color: #166534;
    }

    .composition-weather-tab.disabled-weather {
        color: #991b1b;
        background: #fee2e2;
        border-color: #fecaca;
        text-decoration: line-through;
    }

    .composition-grid-wrap {
        overflow-x: auto;
        border: 1px solid var(--border);
        border-radius: 16px;
        background: white;
    }

    .composition-grid {
        width: 100%;
        min-width: 2460px;
        border-collapse: separate;
        border-spacing: 3px;
        padding: 5px;
    }

    .composition-grid th {
        position: sticky;
        top: 0;
        z-index: 2;
        min-width: 92px;
        padding: 6px;
        background: #f8fafc;
        font-size: 10px;
        text-align: center;
    }

    .composition-grid th:first-child,
    .composition-grid td:first-child {
        position: sticky;
        left: 0;
        z-index: 3;
        min-width: 130px;
        background: #f8fafc;
    }

    .composition-hour-head,
    .composition-day-head {
        width: 100%;
        border: 0;
        background: transparent;
        color: inherit;
        padding: 5px;
        min-height: auto;
        font-size: 10px;
    }

    .composition-grid td {
        min-width: 92px;
        padding: 0;
        vertical-align: stretch;
    }

    .composition-slot {
        width: 100%;
        min-height: 76px;
        border: 1px solid #dbe3ed;
        border-radius: 10px;
        padding: 7px;
        background: #f8fafc;
        color: #475569;
        text-align: left;
        font-size: 10px;
        line-height: 1.3;
    }

    .composition-slot.on {
        border-color: #86efac;
        background: #dcfce7;
        color: #14532d;
    }

    .composition-slot.override-off {
        border-color: #fecaca;
        background: #fee2e2;
        color: #991b1b;
    }

    .composition-slot.auto-off {
        background: #f1f5f9;
        color: #64748b;
    }

    .composition-slot.selected {
        outline: 3px solid rgba(2, 132, 199, .32);
        border-color: #0284c7;
    }

    .composition-slot strong,
    .composition-slot span {
        display: block;
    }

    .composition-slot strong {
        font-size: 11px;
        margin-bottom: 3px;
    }

    .composition-coverage .composition-slot {
        min-height: 54px;
        text-align: center;
    }

    .composition-detail-grid {
        display: grid;
        grid-template-columns: minmax(300px, 1fr) minmax(420px, 2fr);
        gap: 14px;
        align-items: start;
    }

    .composition-family-detail {
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 11px;
        margin-top: 8px;
        background: #f8fafc;
    }

    .composition-override-list {
        max-height: 220px;
        overflow: auto;
        padding: 8px;
        border: 1px solid var(--border);
        border-radius: 12px;
        background: #f8fafc;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11px;
        white-space: pre-wrap;
    }

    .composition-summary-table table {
        min-width: 1150px;
    }


@media (max-width: 920px) {
    .composition-plan-grid,
    .composition-detail-grid {
        grid-template-columns: 1fr;
    }
}

@media (max-width: 720px) {
    .micro-desktop-table {
        display: none;
    }


    .micro-mobile-cards {
        display: block;
    }


    .winner-filter-grid,
    .winner-explain {
        grid-template-columns: 1fr;
    }

    .winner-selection-bar {
        position: static;
    }

    .winner-table {
        display: none;
    }

    .winner-mobile-cards {
        display: block;
    }

    .api-output-textarea {
        min-height: 420px;
        font-size: 11px;
    }
}


.empty {
    padding: 22px;
    text-align: center;
    color: var(--muted);
    border: 1px dashed var(--border-strong);
    border-radius: 18px;
    background: rgba(255, 255, 255, 0.70);
}


.coin-card,
.manual-card {
    position: relative;
    overflow: hidden;
    background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%);
    border: 1px solid var(--border);
    border-radius: 22px;
    padding: 16px;
    box-shadow: var(--shadow);
}
.coin-card::before,
.manual-card::before {
    content: "";
    position: absolute;
    inset: 0 0 auto 0;
    height: 4px;
    background: linear-gradient(90deg, #dc2626, #fca5a5);
}


.coin-head {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: flex-start;
    margin-bottom: 14px;
}


.coin-symbol {
    font-weight: 850;
    font-size: 16px;
    letter-spacing: -0.02em;
}


.coin-name {
    color: var(--muted);
    font-size: 12px;
    margin-top: 3px;
}


.coin-price {
    text-align: right;
}


.coin-price strong {
    display: block;
    font-size: 16px;
}


.coin-price span {
    display: block;
    color: var(--muted);
    font-size: 12px;
    margin-top: 3px;
}


.coin-stats,
.manual-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 8px;
    margin-top: 10px;
}


.coin-stat,
.manual-stat {
    background: #f8fafc;
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 9px;
}


.coin-stat span,
.manual-stat span {
    display: block;
    color: var(--muted);
    font-size: 11px;
    margin-bottom: 3px;
    font-weight: 700;
}


.coin-stat strong,
.manual-stat strong {
    font-size: 13px;
    word-break: break-word;
}


.coin-foot {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
    align-items: center;
}


.manual-card {
    max-width: 1100px;
    margin-bottom: 14px;
}


.drawer {
    position: fixed;
    right: 0;
    top: 0;
         bottom: 0;
         width: min(900px, 94vw);
         background: white;
         border-left: 1px solid var(--border);
         box-shadow: -12px 0 42px rgba(15, 23, 42, 0.18);
         padding: 20px;
         overflow: auto;
         z-index: 30;
    }


    .drawer-head {
         display: flex;
         justify-content: space-between;
         align-items: flex-start;
         gap: 12px;
         margin-bottom: 14px;
    }


    .drawer h2 {
         margin: 0;
         font-size: 20px;
         letter-spacing: -0.03em;
         word-break: break-word;
    }


    @media (max-width: 1180px) {
         .grid,
         .coin-grid { grid-template-columns: repeat(2, minmax(220px, 1fr)); }
         .grid-3 { grid-template-columns: 1fr; }
    }


    @media (max-width: 720px) {
         header { padding: 18px 14px; }
         .header-inner { flex-direction: column; }
         main { padding: 14px; }
         .grid,
         .coin-grid { grid-template-columns: 1fr; }
         .tab { flex: 1 1 auto; padding: 9px 10px; }
         input[type="search"] { min-width: 100%; }
         .manual-grid,
         .coin-stats { grid-template-columns: repeat(2, 1fr); }
    }
  </style>
</head>


<body>
  <header>
    <div class="header-inner">
      <div class="brand-title">
           <div class="brand-logo">75</div>
           <div>
             <strong>LONG 75 Micro-Family Learning Admin</strong>
             <div class="brand-subtitle">
               Scanner → Analyze 75-child trueMicroFamilyId → virtual/shadow outcomes
→ netR scoring → werkende dagen/sessies → winnende selectie → strict Discord
             </div>
           </div>
      </div>


      <div class="header-actions">
           <div class="live-pill"><span class="live-dot"></span><span
id="liveLabel">LONG-only · broad learning · adaptive selection</span></div>
           <button id="refreshBtn" type="button">Refresh</button>
      </div>
    </div>
  </header>


  <main>
    <div class="tabs">
      <button type="button" class="tab active" data-
tab="overview">Overview</button>
      <button type="button" class="tab" data-
tab="market">marketWeather.js</button>
      <button type="button" class="tab" data-tab="scanner">Scanner</button>
      <button type="button" class="tab" data-tab="trade">TradeSystem</button>
      <button type="button" class="tab" data-tab="micros">75
MicroFamilies</button>
      <button type="button" class="tab" data-tab="winners">Winnende signalen</button>
      <button type="button" class="tab" data-tab="rotation">Manual Discord
Selection</button>
      <button type="button" class="tab" data-tab="discord">Discord Logs</button>
      <button type="button" class="tab" data-tab="reset">Reset</button>
    </div>


    <div id="message"></div>


    <section id="overview" class="panel"></section>
    <section id="market" class="panel hidden"></section>
    <section id="scanner" class="panel hidden"></section>
    <section id="trade" class="panel hidden"></section>
    <section id="micros" class="panel hidden"></section>
    <section id="winners" class="panel hidden"></section>
    <section id="rotation" class="panel hidden"></section>
    <section id="discord" class="panel hidden"></section>
    <section id="reset" class="panel hidden"></section>
  </main>
  <div id="drawer" class="drawer hidden"></div>


  <script>
    const ONLY_SIDE = "LONG";
    const OPPOSITE_SIDE = "SHORT";
    const DASHBOARD_SIDE = "bull";
    const LONG_NAMESPACE = "LONG";
    const LONG_KEY_PREFIX = "LONG:";
    const PERSISTENT_LEARNING_KEY = "LONG_LIVE";


    const MIN_COMPLETED_ACTIVE_LEARNING = 20;
    const DEFAULT_POSITION_TIME_STOP_MIN = 720;


    const TRUE_MICRO_SCHEMA = "FIXED_TAXONOMY_75";
    const PARENT_TRUE_MICRO_SCHEMA = "FIXED_TAXONOMY_15";
    const LEARNING_GRANULARITY =
"LONG_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1";
    const PARENT_LEARNING_GRANULARITY = "LONG_FIXED_TAXONOMY_SETUP_X_REGIME_V1";


    const MEASUREMENT_FIX_VERSION =
"LONG_MEASUREMENT_FIX_TRIGGER_BOUNDARY_EXIT_FILL_V2";
    const PREVIOUS_MEASUREMENT_FIX_VERSION =
"LONG_MEASUREMENT_FIX_AVGCOST_DIRECTSL_SEEN_DEDUPE_V1";
    const OUTCOME_MEASUREMENT_GATE_MODE = "STRICT_EXACT_VERSION";
    const EXIT_FILL_MODEL_VERSION =
"LONG_TRIGGER_BOUNDARY_FILL_PLUS_COST_MODEL_V1";


    const EMPIRICAL_VETO_POLICY_VERSION = "LONG_EXACT_75_CHILD_NET_EDGE_VETO_V1";
    const EMPIRICAL_VETO_MIN_COMPLETED = 35;
    const EMPIRICAL_VETO_MAX_AVG_R = 0;



    const TEMPORAL_CONTEXT_VERSION = "LONG_TEMPORAL_CONTEXT_UTC_V1";
    const TEMPORAL_POLICY_VERSION = "LONG_TEMPORAL_FAMILY_PROFILE_POLICY_V1";
    const TEMPORAL_GENERATION_SCHEMA_VERSION = "LONG_TEMPORAL_ROOT_GENERATION_V1";
    const WEEKEND_POLICY_VERSION = "LONG_WEEKEND_APPROVAL_EXACT_DAY_V1";
    const SESSION_POLICY_VERSION = "LONG_DAY_SESSION_VETO_RECOVERY_FDR_V1";
    const TEMPORAL_POLICY_MODE_DEFAULT = "OBSERVE";
    const TEMPORAL_POLICY_MODES = Object.freeze(["OFF", "OBSERVE", "ENFORCE"]);
    const TEMPORAL_WINDOW_MAX_OUTCOMES = 50;
    const TEMPORAL_WINDOW_MAX_AGE_DAYS = 180;
    const TEMPORAL_GENERATION_MAX_AGE_DAYS = 14;
    const TEMPORAL_EXPECTED_CHILD_FAMILY_COUNT = 75;
    const UTC_DAY_NAMES = Object.freeze([
      "SUNDAY",
      "MONDAY",
      "TUESDAY",
      "WEDNESDAY",
      "THURSDAY",
      "FRIDAY",
      "SATURDAY"
    ]);
    const WINNER_DAY_OPTIONS = Object.freeze([
      "MONDAY",
      "TUESDAY",
      "WEDNESDAY",
      "THURSDAY",
      "FRIDAY",
      "SATURDAY",
      "SUNDAY"
    ]);
    const WINNER_SESSION_OPTIONS = Object.freeze([
      "ASIA",
      "ASIA_EU_OVERLAP",
      "EUROPE",
      "EU_US_OVERLAP",
      "US",
      "OFF_HOURS"
    ]);
    const WINNER_PRESETS = Object.freeze([
      {
        value: "STRICT_PROVEN",
        label: "Bewezen winnaars",
        help: "Global PASSED, dag én sessie minimaal 35 resultaten, gemiddeld minimaal +0,05R en LCB95 boven nul."
      },
      {
        value: "BALANCED_POSITIVE",
        label: "Positief en bruikbaar",
        help: "Global PASSED, dag en sessie niet geblokkeerd, minimaal 20 resultaten en positief gemiddelde."
      },
      {
        value: "GLOBAL_PASSED",
        label: "Alle global PASSED",
        help: "Bestaande globale gate is geslaagd; actieve temporal veto's en niet-goedgekeurde weekenden blijven uitgesloten."
      }
    ]);
    const CURRENT_FIT_VERSION = "LONG_CURRENTFIT_MARKETWEATHER_SOFT_V2";
    const ADAPTIVE_UI_VERSION = "LONG_ADAPTIVE_UI_MARKETWEATHER_CURRENTFIT_V1";
    const FRONTEND_FIX_VERSION =
"LONG_ADMIN_FRONTEND_MEASUREMENT_V2_EMPIRICAL_VETO_V1";
    const WINNER_SELECTOR_VERSION = "LONG_TEMPORAL_WINNER_SELECTOR_UI_V1";
    const WEEK_COMPOSITION_UI_VERSION = "LONG_DAY_HOUR_MARKET_WEATHER_BTC_ROUTER_UI_V3";
    const COMPOSITION_DAYS = Object.freeze([
      "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"
    ]);
    const COMPOSITION_HOURS = Object.freeze(
      Array.from({ length: 24 }, (_, hour) => `H${String(hour).padStart(2, "0")}`)
    );
    const COMPOSITION_WEATHER_KEYS = Object.freeze([
      "TREND|LONG", "TREND|NEUTRAL", "TREND|SHORT",
      "CHOP|LONG", "CHOP|NEUTRAL", "CHOP|SHORT",
      "SQUEEZE|LONG", "SQUEEZE|NEUTRAL", "SQUEEZE|SHORT", "UNKNOWN"
    ]);
    const COMPOSITION_BTC_STATES = Object.freeze([
      "STRONG_BULLISH", "BULLISH", "NEUTRAL",
      "BEARISH", "STRONG_BEARISH", "UNKNOWN"
    ]);
    const COMPOSITION_SELECTABLE_BTC_STATES = Object.freeze(
      COMPOSITION_BTC_STATES.filter((state) => state !== "UNKNOWN")
    );


    const LONG_FIXED_SETUP_TYPES = new Set([
         "BREAKOUT",
         "RETEST",
         "SWEEP_REVERSAL",
         "CONTINUATION",
         "COMPRESSION"
    ]);


    const LONG_FIXED_REGIME_BUCKETS = new Set([
         "TREND",
         "CHOP",
         "SQUEEZE"
    ]);


    const LONG_FIXED_CONFIRMATION_PROFILES = new Set([
         "A_STRONG_ALIGN",
         "B_FLOW_ALIGN",
         "C_VOLUME_ALIGN",
         "D_MIXED_OK",
         "E_WEAK_CONTRA"
    ]);


    const state = {
         activeTab: "overview",
         overview: null,
         market: null,
         scanner: null,
         trade: null,
         micros: null,
         rotation: null,
         discord: null,
         microMode: "adaptive",
         microSearch: "",
         winnerPreset: "STRICT_PROVEN",
         winnerDay: "CURRENT",
         winnerSession: "CURRENT",
         winnerSearch: "",
         winnerOnlyCurrentFit: true,
         winnerShowAll: false,
         winnerSelectedIds: [],
         compositionSelectedMode: "BALANCED",
         compositionSelectedWeather: "TREND|LONG",
         compositionSelectedBtc: "BULLISH",
         compositionSelectedSlotKey: null,
         compositionDisabledDays: [],
         compositionDisabledHours: [],
         compositionDisabledWeatherKeys: [],
         compositionDisabledBtcStates: [],
         compositionDisabledWeatherBtcKeys: [],
         compositionDisabledDayHours: [],
         compositionDisabledSlotWeatherKeys: [],
         compositionDisabledDayHourWeatherBtcKeys: [],
         compositionOverridesSourceId: null,
         apiTimeoutMs: 22000,
         microLimit: 75,
         bestLimit: 75
    };


    const endpoints = {
         overview: "/api/admin/overview",
         market: "/api/admin/market-weather",
         scanner: "/api/admin/scanner",
         trade: "/api/admin/trade",
         micros: "/api/admin/micro-families",
         rotation: "/api/admin/rotation",
         discord: "/api/admin/discord-logs",
         microDetail: "/api/admin/micro-family",
         runScanner: "/api/scanner/run?force=true",
         runTrade: "/api/trade/run?force=true&forceProcessSnapshot=true",
         resetLearning: "/api/admin/reset-learning",
         resetRotation: "/api/admin/reset-rotation",
         factoryReset: "/api/admin/factory-reset"
    };


    const tabs = ["overview", "market", "scanner", "trade", "micros", "winners", "rotation",
"discord", "reset"];
    const validMicroModes = ["adaptive", "balanced", "winrate", "totalR", "avgR",
"directSL", "observed", "cost", "currentFit"];


    const $ = (id) => document.getElementById(id);


    class ApiError extends Error {
         constructor(message, details = {}) {
             super(message);
             this.name = "ApiError";
             this.status = details.status || 0;
             this.url = details.url || "";
             this.data = details.data || null;
             this.timeout = Boolean(details.timeout);
         }
    }


    function escapeHtml(value) {
         return String(value ?? "")
             .replaceAll("&", "&amp;")
             .replaceAll("<", "&lt;")
             .replaceAll(">", "&gt;")
             .replaceAll('"', "&quot;")
             .replaceAll("'", "&#039;");
    }


    function escapeAttr(value) {
         return escapeHtml(value).replaceAll("`", "&#096;");
    }


    function upper(value) {
         return String(value || "").trim().toUpperCase();
    }
    function normalizeTimestampMs(value, fallback = Date.now()) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
        return numeric < 10_000_000_000 ? Math.floor(numeric * 1000) :
Math.floor(numeric);
    }


    function buildTemporalContext(timestamp = Date.now()) {
        const contextTs = normalizeTimestampMs(timestamp, Date.now());
        const date = new Date(contextTs);
        const hourUtc = date.getUTCHours();
        const dayIndex = date.getUTCDay();
        const dayOfWeekUtc = UTC_DAY_NAMES[dayIndex] || "UNKNOWN";
        const isWeekend = dayIndex === 0 || dayIndex === 6;
        const sessionTags = [];


        if (hourUtc >= 0 && hourUtc < 8) sessionTags.push("ASIA");
        if (hourUtc >= 7 && hourUtc < 16) sessionTags.push("EUROPE");
        if (hourUtc >= 13 && hourUtc < 22) sessionTags.push("US");


        let primarySessionBucket = "OFF_HOURS";
        if (sessionTags.includes("EUROPE") && sessionTags.includes("US")) {
             primarySessionBucket = "EU_US_OVERLAP";
        } else if (sessionTags.includes("ASIA") && sessionTags.includes("EUROPE")) {
             primarySessionBucket = "ASIA_EU_OVERLAP";
        } else if (sessionTags.includes("ASIA")) {
             primarySessionBucket = "ASIA";
        } else if (sessionTags.includes("EUROPE")) {
             primarySessionBucket = "EUROPE";
        } else if (sessionTags.includes("US")) {
             primarySessionBucket = "US";
        }


        return {
             temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
             contextTs,
             hourUtc,
             dayOfWeekUtc,
             dayType: isWeekend ? "WEEKEND" : "WEEKDAY",
             isWeekend,
             sessionTags,
             primarySessionBucket,
             sessionOverlap: sessionTags.length > 1,
             offHours: sessionTags.length === 0
        };
    }


    function normalizeTemporalPolicyMode(value) {
        const mode = upper(value || TEMPORAL_POLICY_MODE_DEFAULT);
        return TEMPORAL_POLICY_MODES.includes(mode)
          ? mode
          : TEMPORAL_POLICY_MODE_DEFAULT;
    }

    function temporalPolicyForContext(context = buildTemporalContext(), payload = {}) {
        const temporalStatsEnabled = payload.temporalStatsEnabled !== false;
        const configuredMode = normalizeTemporalPolicyMode(
          payload.temporalPolicyMode ||
          payload.effectiveTemporalPolicyMode ||
          payload.temporal?.policyMode
        );
        const temporalPolicyMode = temporalStatsEnabled ? configuredMode : "OFF";
        const temporalWouldBlock =
          typeof payload.temporalWouldBlock === "boolean"
            ? payload.temporalWouldBlock
            : null;
        const finalDiscordEntryAllowed =
          typeof payload.finalDiscordEntryAllowed === "boolean"
            ? payload.finalDiscordEntryAllowed
            : null;

        return {
             temporalStatsEnabled,
             temporalPolicyMode,
             temporalPolicyVersion: payload.temporalPolicyVersion || TEMPORAL_POLICY_VERSION,
             temporalGenerationSchemaVersion:
               payload.temporalGenerationSchemaVersion || TEMPORAL_GENERATION_SCHEMA_VERSION,
             weekendPolicyVersion: payload.weekendPolicyVersion || WEEKEND_POLICY_VERSION,
             sessionPolicyVersion: payload.sessionPolicyVersion || SESSION_POLICY_VERSION,
             temporalWindowMaxOutcomes: TEMPORAL_WINDOW_MAX_OUTCOMES,
             temporalWindowMaxAgeDays: TEMPORAL_WINDOW_MAX_AGE_DAYS,
             temporalGenerationMaxAgeDays: TEMPORAL_GENERATION_MAX_AGE_DAYS,
             temporalExpectedChildFamilyCount: TEMPORAL_EXPECTED_CHILD_FAMILY_COUNT,
             weekendLearningAllowed: true,
             weekendVirtualEntryAllowed: true,
             weekendExitMonitoringAllowed: true,
             weekendOutcomeRecordingAllowed: true,
             sessionLearningAllowed: true,
             sessionVirtualEntryAllowed: true,
             weekendDefaultWouldBlock: Boolean(context.isWeekend),
             temporalWouldBlock,
             finalDiscordEntryAllowed,
             temporalPolicyAppliesTo: "DISCORD_ENTRY_PUBLICATION_ONLY",
             exitPublicationTemporalBlocked: false,
             temporalGenerationPointerAuthoritative: true
        };
    }

    function temporalGenerationFromPayload(payload = {}) {
        return payload.activeTemporalGeneration ||
          payload.temporalGeneration ||
          payload.temporal?.activeGeneration ||
          payload.temporal?.generation ||
          payload.active?.activeTemporalGeneration ||
          payload.active?.temporalGeneration ||
          payload.activeRotation?.activeTemporalGeneration ||
          payload.activeRotation?.temporalGeneration ||
          payload.pointerDocument?.activeTemporalGeneration ||
          payload.activeGenerationPointer?.activeTemporalGeneration ||
          null;
    }

    function temporalContextFromPayload(payload = {}) {
        const source = payload.temporalContext || payload.currentTemporalContext ||
payload;
        const timestamp = firstFinite(
             source.contextTs,
             source.entryTs,
             source.scannerTs,
             source.createdAt,
             source.ts,
             Date.now()
        );
        const derived = buildTemporalContext(timestamp || Date.now());
        return {
             ...derived,
             ...source,
             temporalContextVersion: source.temporalContextVersion ||
derived.temporalContextVersion,
             sessionTags: Array.isArray(source.sessionTags) ? source.sessionTags :
derived.sessionTags,
             primarySessionBucket: source.primarySessionBucket ||
source.entrySessionBucket || derived.primarySessionBucket,
             dayType: source.dayType || source.entryDayType || derived.dayType,
             isWeekend: source.isWeekend ?? source.entryIsWeekend ?? derived.isWeekend
        };
    }


    function cleanSideText(value = "") {
        return upper(value)
          .replaceAll("SHORT_DISABLED_TRUE", "LONG")
          .replaceAll("SHORTDISABLED_TRUE", "LONG")
          .replaceAll("BLOCK_SHORT_TRUE", "LONG")
          .replaceAll("SHORT_DISABLED_FALSE", "")
          .replaceAll("SHORTDISABLED_FALSE", "")
          .replaceAll("BLOCK_SHORT_FALSE", "")
          .replaceAll("SHORT_ENABLED_FALSE", "")
          .replaceAll("SHORT_ONLY_FALSE", "")
          .replaceAll("LONG_DISABLED_FALSE", "")
          .replaceAll("LONGDISABLED_FALSE", "")
          .replaceAll("BLOCK_LONG_FALSE", "")
          .replaceAll("LONG_ENABLED_FALSE", "")
          .replaceAll("LONG_ONLY_FALSE", "")
          .replaceAll("SHORT_DISABLED_LONG_ONLY", "LONG")
          .replaceAll("SHORTDISABLED_LONG_ONLY", "LONG")
          .replaceAll("BLOCK_SHORT", "LONG")
          .replaceAll("SHORT_DISABLED", "LONG")
          .replaceAll("SHORTDISABLED", "LONG")
          .replaceAll("LONG_DISABLED_SHORT_ONLY", "SHORT")
          .replaceAll("LONGDISABLED_SHORT_ONLY", "SHORT")
          .replaceAll("BLOCK_LONG", "SHORT")
          .replaceAll("LONG_DISABLED", "SHORT")
          .replaceAll("LONGDISABLED", "SHORT")
          .replaceAll("LONG_ONLY_MODE", "LONG")
          .replaceAll("LONG_ONLY", "LONG")
          .replaceAll("LONG-ONLY", "LONG")
          .replaceAll("SHORT_ONLY_MODE", "SHORT")
          .replaceAll("SHORT_ONLY", "SHORT")
          .replaceAll("SHORT-ONLY", "SHORT");
    }


    function parseFixedLongTaxonomyId(id = "") {
        const value = upper(id);
        const match = /^MICRO_LONG_([A-Z_]+)_(TREND|CHOP|SQUEEZE)(?:_(A_STRONG_ALIGN|B_FLOW_ALIGN|C_VOLUME_ALIGN|D_MIXED_OK|E_WEAK_CONTRA))?$/.exec(value);


        if (!match) return null;


        const setup = match[1];
        const regime = match[2];
        const confirmation = match[3] || null;


        if (!LONG_FIXED_SETUP_TYPES.has(setup)) return null;
        if (!LONG_FIXED_REGIME_BUCKETS.has(regime)) return null;
        if (confirmation && !LONG_FIXED_CONFIRMATION_PROFILES.has(confirmation))
return null;


        const parentTrueMicroFamilyId = `MICRO_LONG_${setup}_${regime}`;
        const childTrueMicroFamilyId = confirmation
             ? `${parentTrueMicroFamilyId}_${confirmation}`
             : null;


        return {
             setup,
             regime,
             confirmation,
             parentTrueMicroFamilyId,
             childTrueMicroFamilyId,
             isParent: !confirmation,
             isChild: Boolean(confirmation)
        };
    }


    function isFixedLongTaxonomyParentId(id = "") {
        return parseFixedLongTaxonomyId(id)?.isParent === true;
    }


    function isFixedLongTaxonomyChildId(id = "") {
        return parseFixedLongTaxonomyId(id)?.isChild === true;
    }


    function parentFromChildTrueMicroFamilyId(id = "") {
        const parsed = parseFixedLongTaxonomyId(id);


        if (!parsed?.isChild) return "";


        return parsed.parentTrueMicroFamilyId;
    }


    function normalizeSide(value) {
        const raw = cleanSideText(value);


        if (["LONG", "BULL", "BULLISH", "BUY", "DOWN", "DOWNSIDE"].includes(raw))
return ONLY_SIDE;
        if (["SHORT", "BEAR", "BEARISH", "SELL", "UP", "UPSIDE"].includes(raw))
return OPPOSITE_SIDE;


        return "UNKNOWN";
    }


    function hasLongSignal(value = "") {
        const text = ` ${cleanSideText(value)} `;
    return (
         text.includes("MICRO_LONG_") ||
         text.includes("TRADESIDE=LONG") ||
         text.includes("TRADE_SIDE=LONG") ||
         text.includes("POSITION_SIDE=LONG") ||
         text.includes("POSITIONSIDE=LONG") ||
         text.includes("SIDE=LONG") ||
         text.includes("SIDE=BULL") ||
         text.includes("SIDE=BUY") ||
         text.includes("DIRECTION=LONG") ||
         text.includes("DIRECTION=BULL") ||
         text.includes("DIRECTION=BUY") ||
         text.includes(" LONG ") ||
         text.includes(" LONG_") ||
         text.includes("_LONG ") ||
         text.includes("_LONG_") ||
         text.includes("|LONG|") ||
         text.includes(":LONG") ||
         text.includes("=LONG") ||
         text.includes(" BULL ") ||
         text.includes("_BULL") ||
         text.includes("BULL_") ||
         text.includes("|BULL|") ||
         text.includes(":BULL") ||
         text.includes("=BULL") ||
         text.includes(" BUY ") ||
         text.includes("_BUY") ||
         text.includes("BUY_") ||
         text.includes("|BUY|") ||
         text.includes(":BUY") ||
         text.includes("=BUY")
    );
}


function hasShortSignal(value = "") {
    const text = ` ${cleanSideText(value)} `;


    return (
         text.includes("MICRO_SHORT_") ||
         text.includes("TRADESIDE=SHORT") ||
         text.includes("TRADE_SIDE=SHORT") ||
         text.includes("POSITION_SIDE=SHORT") ||
         text.includes("POSITIONSIDE=SHORT") ||
         text.includes("SIDE=SHORT") ||
         text.includes("SIDE=BEAR") ||
         text.includes("SIDE=SELL") ||
         text.includes("DIRECTION=SHORT") ||
         text.includes("DIRECTION=BEAR") ||
         text.includes("DIRECTION=SELL") ||
         text.includes(" SHORT ") ||
         text.includes(" SHORT_") ||
         text.includes("_SHORT ") ||
         text.includes("_SHORT_") ||
         text.includes("|SHORT|") ||
         text.includes(":SHORT") ||
         text.includes("=SHORT") ||
         text.includes(" BEAR ") ||
         text.includes("_BEAR") ||
         text.includes("BEAR_") ||
         text.includes("|BEAR|") ||
         text.includes(":BEAR") ||
         text.includes("=BEAR") ||
         text.includes(" SELL ") ||
         text.includes("_SELL") ||
         text.includes("SELL_") ||
         text.includes("|SELL|") ||
         text.includes(":SELL")
    );
}


function isScannerFingerprintId(id = "") {
    const value = upper(id);


    return (
         value.startsWith("MICRO_LONG_SCANNER__") ||
         value.includes("MICRO_LONG_SCANNER__") ||
         value.startsWith("LONG_SCANNER_") ||
         value.includes("LONG_SCANNER_") ||
         value.startsWith("MICRO_SHORT_SCANNER__") ||
         value.includes("MICRO_SHORT_SCANNER__") ||
         value.startsWith("SHORT_SCANNER_") ||
         value.includes("SHORT_SCANNER_") ||
         value.includes("__SCANNER__") ||
         value.includes("SCANNER_GATE_PASS") ||
         value.includes("SCANNER_GATE_FAIL")
    );
}


function isExecutionFingerprintId(id = "") {
    const value = upper(id);


    return (
         value.includes("_XR_") ||
         value.includes("__XR__") ||
         value.includes("|XR|") ||
         value.includes("EXECUTION_FINGERPRINT") ||
         value.includes("EXECUTION_MICRO") ||
         value.includes("EXECUTIONMICRO") ||
         value.includes("REFINED_EXECUTION")
    );
}


function validLearningId(id = "") {
    const value = String(id || "").trim();


    if (!value) return false;
    if (isScannerFingerprintId(value)) return false;
    if (isExecutionFingerprintId(value)) return false;


    return true;
}


function isSelectableTrueMicroId(id = "") {
    const value = String(id || "").trim();


    if (!validLearningId(value)) return false;
    if (!isFixedLongTaxonomyChildId(value)) return false;


    return true;
}


function isSelectableParentMicroId(id = "") {
    const value = String(id || "").trim();


    if (!validLearningId(value)) return false;
    if (!isFixedLongTaxonomyParentId(value)) return false;


    return true;
}


function inferSide(input = {}) {
    if (typeof input === "string") {
         const direct = normalizeSide(input);
         if (direct !== "UNKNOWN") return direct;


         const text = cleanSideText(input);
         const longSignal = hasLongSignal(text);
         const shortSignal = hasShortSignal(text);


         if (longSignal && !shortSignal) return ONLY_SIDE;
     if (shortSignal) return OPPOSITE_SIDE;


     return "UNKNOWN";
}


if (!input || typeof input !== "object") return "UNKNOWN";


const directFields = [
     input.tradeSide,
     input.targetTradeSide,
     input.positionSide,
     input.direction,
     input.scannerSide,
     input.actualScannerSide,
     input.analysisSide,
     input.signalSide,
     input.entrySide,
     input.dashboardSide,
     input.side,
     input.bias,
     input.marketBias
];


for (const field of directFields) {
     const direct = normalizeSide(field);
     if (direct !== "UNKNOWN") return direct;
}


const haystack = [
     input.familyId,
     input.family,
     input.baseFamilyId,


     input.parentTrueMicroFamilyId,
     input.microFamilyId,
     input.trueMicroFamilyId,
     input.childTrueMicroFamilyId,
     input.coarseMicroFamilyId,
     input.liveMicroFamilyId,
     input.realMicroFamilyId,
     input.executionMicroFamilyId,
     input.analyzeMicroFamilyId,
     input.learningMicroFamilyId,
     input.id,
     input.key,


     input.macroFamilyId,
          input.parentMacroFamilyId,
          input.parentMicroFamilyId,
          input.parentFamilyId,
          input.macroId,


          input.definition,
          input.microDefinition,
          input.macroDefinition,
          input.parentDefinition,


          input.scannerReason,
          input.reason,
          input.signalReason,
          input.actionReason,
          input.exitReason,
          input.rejectionReason,


          Array.isArray(input.definitionParts) ? input.definitionParts.join("|") :
"",
          Array.isArray(input.microDefinitionParts) ?
input.microDefinitionParts.join("|") : "",
          Array.isArray(input.macroDefinitionParts) ?
input.macroDefinitionParts.join("|") : "",
          Array.isArray(input.parentDefinitionParts) ?
input.parentDefinitionParts.join("|") : "",
          Array.isArray(input.executionFingerprintParts) ?
input.executionFingerprintParts.join("|") : ""
      ].join(" | ");


      const longSignal = hasLongSignal(haystack);
      const shortSignal = hasShortSignal(haystack);


      if (longSignal && !shortSignal) return ONLY_SIDE;
      if (shortSignal) return OPPOSITE_SIDE;


      if (
          input.longOnly === true ||
          input.shortDisabled === true ||
          input.targetTradeSide === ONLY_SIDE ||
          input.tradeSide === ONLY_SIDE ||
          input.dashboardSide === DASHBOARD_SIDE
      ) {
          return ONLY_SIDE;
      }


      if (input.shortOnly === true || input.longDisabled === true) {
          return OPPOSITE_SIDE;
    }


    return "UNKNOWN";
}


function microId(row = {}) {
    return String(
        row.trueMicroFamilyId ||
        row.childTrueMicroFamilyId ||
        row.microFamilyId ||
        row.analyzeMicroFamilyId ||
        row.learningMicroFamilyId ||
        row.liveMicroFamilyId ||
        row.realMicroFamilyId ||
        row.executionMicroFamilyId ||
        row.id ||
        row.key ||
        ""
    ).trim().toUpperCase();
}


function parentMicroId(row = {}) {
    const id = microId(row);


    return String(
        row.parentTrueMicroFamilyId ||
        row.parentMicroFamilyId ||
        row.parentMacroFamilyId ||
        row.coarseMicroFamilyId ||
        row.baseMicroFamilyId ||
        row.legacyMicroFamilyId ||
        parentFromChildTrueMicroFamilyId(id) ||
        ""
    ).trim().toUpperCase();
}


function macroId(row = {}) {
    return parentMicroId(row);
}


function familyId(row = {}) {
    return String(row.familyId || row.family || row.baseFamilyId || "").trim();
}


function isRealAnalyzeMicroRow(row = {}) {
    const id = microId(row);
    const parentId = parentMicroId(row);
    if (!id) return false;
    if (!isSelectableTrueMicroId(id)) return false;
    if (parentId && !isSelectableParentMicroId(parentId)) return false;
    if (row.legacyScannerFamilyFallback === true) return false;


    const side = inferSide(row);
    if (side === OPPOSITE_SIDE) return false;


    return true;
}


function idAllowedInLongOnly(id = "") {
    return isSelectableTrueMicroId(id);
}


function parentIdAllowedInLongOnly(id = "") {
    return isSelectableParentMicroId(id);
}


function uniqueStrings(values = []) {
    const stack = Array.isArray(values) ? [...values] : [values];
    const out = [];


    while (stack.length) {
        const value = stack.shift();


        if (Array.isArray(value)) {
            stack.unshift(...value);
            continue;
        }


        if (typeof value === "string") {
            out.push(...value.split(/[\s,;\n\r]+/g));
            continue;
        }


        if (value !== undefined && value !== null) out.push(value);
    }


    return [...new Set(
        out
            .map((value) => String(value || "").trim().toUpperCase())
            .filter(Boolean)
    )];
}
function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") return Object.values(value);


    return [];
}


function num(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}


function firstFinite(...values) {
    for (const value of values) {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
    }


    return null;
}


function clamp(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
}


function fmt(value, decimals = 3) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "-";
    return n.toFixed(decimals);
}


function fmtInt(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "0";
    return Math.round(n).toLocaleString();
}


function fmtPct(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "-";
    return `${(n * 100).toFixed(1)}%`;
}


function fmtRawPct(value) {
    const n = Number(value);
          if (!Number.isFinite(n)) return "-";
          return `${n.toFixed(2)}%`;
      }


      function fmtPrice(value) {
          const n = Number(value);


          if (!Number.isFinite(n)) return "-";
          if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2
});
          if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4
});


          return n.toLocaleString(undefined, { maximumFractionDigits: 8 });
      }


      function fmtMoney(value) {
          const n = Number(value);


          if (!Number.isFinite(n)) return "-";
          if (Math.abs(n) >= 1_000_000_000) return `${(n /
1_000_000_000).toFixed(2)}B`;
          if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
          if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;


          return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
      }


      function fmtTs(value) {
          if (!value) return "-";


          const n = Number(value);
          const date = Number.isFinite(n) ? new Date(n) : new Date(value);


          if (Number.isNaN(date.getTime())) return "-";


          return date.toLocaleString();
      }


      function ageText(ts) {
          const n = Number(ts);


          if (!Number.isFinite(n) || n <= 0) return "-";


          const seconds = Math.max(0, Math.floor((Date.now() - n) / 1000));


          if (seconds < 60) return `${seconds}s geleden`;
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m geleden`;


        return `${Math.floor(seconds / 3600)}u geleden`;
    }


    function baseSymbol(row = {}) {
        const raw = typeof row === "string"
             ? row
             : row.symbol || row.baseSymbol || row.coin || row.contractSymbol ||
row.instId || row.instrumentId || "";


        let symbol = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, "");


        for (const suffix of ["USDTUMCBL", "USDCUMCBL", "USDTPERP", "USDCPERP",
"USDT", "USDC", "BUSD", "PERP", "SWAP", "USD"]) {
             if (symbol.endsWith(suffix) && symbol.length > suffix.length) {
                  symbol = symbol.slice(0, -suffix.length);
                  break;
             }
        }


        return symbol || "COIN";
    }


    function outcomeMeasurementVersion(row = {}) {
        return String(
             row.outcomeMeasurementVersion ||
             row.measurementFixVersion ||
             row.acceptedOutcomeMeasurementVersion ||
             ""
        ).trim();
    }


    function isCurrentMeasurementRow(row = {}) {
        const version = outcomeMeasurementVersion(row);


        if (version) return version === MEASUREMENT_FIX_VERSION;


        return (
             row.completedCurrentMeasurementOnly === true &&
             row.legacyOutcomeMeasurementsExcluded === true
        );
    }


    function completed(row = {}) {
        if (!isCurrentMeasurementRow(row)) return 0;
    const explicitVirtual = num(row.virtualCompleted, 0);
    const explicitShadow = num(row.shadowCompleted, 0);
    const closed = explicitVirtual + explicitShadow;


    if (closed > 0) return closed;


    const outcome = Number(row.outcomeSample);
    if (Number.isFinite(outcome) && outcome >= 0) return outcome;


    const explicit = Number(row.completed);
    if (Number.isFinite(explicit) && explicit >= 0) return explicit;


    const wins = num(row.wins, 0);
    const losses = num(row.losses, 0);
    const flats = num(row.flats, 0);
    const sum = wins + losses + flats;


    return sum > 0 ? sum : 0;
}


function observationSample(row = {}) {
    return Math.max(
         num(row.observationSample, 0),
         num(row.seen, 0),
         num(row.observations, 0),
         completed(row),
         0
    );
}


function seenCompletedRatio(row = {}) {
    const done = completed(row);
    return done > 0 ? observationSample(row) / done : 0;
}


function learningStatus(row = {}) {
    const done = completed(row);


    if (done >= EMPIRICAL_VETO_MIN_COMPLETED) {
         return netAvgR(row) > EMPIRICAL_VETO_MAX_AVG_R
             ? "PASSED"
             : "EMPIRICAL_VETO";
    }
    if (done >= MIN_COMPLETED_ACTIVE_LEARNING) return "ACTIVE_LEARNING";
    if (done > 0) return "EARLY_OUTCOMES";


    return "OBSERVING";
    }


    function tooEarly(row = {}) {
        return completed(row) < MIN_COMPLETED_ACTIVE_LEARNING;
    }


    function activationGateStatus(row = {}) {
        const explicit = upper(
             row.activationGateStatus ||
             row.discordActivationGateStatus ||
             row.empiricalGateStatus ||
             ""
        );


        if (["PASSED", "OBSERVING", "EMPIRICAL_VETO"].includes(explicit)) {
             return explicit;
        }


        const done = completed(row);
        if (done < EMPIRICAL_VETO_MIN_COMPLETED) return "OBSERVING";


        return netAvgR(row) > EMPIRICAL_VETO_MAX_AVG_R
             ? "PASSED"
             : "EMPIRICAL_VETO";
    }


    function isEmpiricalVeto(row = {}) {
        return (
             row.empiricalVeto === true ||
             row.empiricalVetoed === true ||
             activationGateStatus(row) === "EMPIRICAL_VETO"
        );
    }


    function activationGatePassed(row = {}) {
        if (isEmpiricalVeto(row)) return false;
        if (row.activationGatePassed === true || row.discordActivationGatePassed ===
true) return true;


        return activationGateStatus(row) === "PASSED";
    }


    function discordSelectionAllowed(row = {}) {
        return (
             isSelectableTrueMicroId(microId(row)) &&
             isCurrentMeasurementRow(row) &&
             activationGatePassed(row) &&
             !isEmpiricalVeto(row)
        );
    }


    function discordSelectionBlockReason(row = {}) {
        if (!isSelectableTrueMicroId(microId(row))) return "INVALID_75_CHILD_ID";
        if (!isCurrentMeasurementRow(row)) return "NOT_CURRENT_MEASUREMENT_V2";
        if (isEmpiricalVeto(row)) return "EMPIRICAL_VETO";
        if (activationGateStatus(row) === "OBSERVING") return "COMPLETED_BELOW_35";


        return String(row.discordBlockReason || row.activationGateReason ||
"ACTIVATION_GATE_NOT_PASSED");
    }


    function tier(row = {}) {
        if (isEmpiricalVeto(row)) return "EMPIRICAL_VETO";


        const done = completed(row);
        const obs = observationSample(row);


        if (done >= MIN_COMPLETED_ACTIVE_LEARNING) return "HARD";
        if (done > 0) return "SOFT";
        if (obs > 0) return "OBSERVATION";


        return String(row.selectedTier || row.rotationEligibilityTier ||
row.eligibilityTier || row.tier || "RAW").toUpperCase();
    }


    function currentMarketRegimeForFit() {
        return upper(
             state.market?.regime ||
             state.market?.currentRegime ||
             state.market?.source?.currentRegime ||
             state.market?.source?.regime ||
             state.market?.raw?.currentRegime ||
             state.market?.raw?.regime ||
             ""
        );
    }


    function currentMarketTrendForFit() {
        const raw = upper(
             state.market?.trendSide ||
             state.market?.currentTrendSide ||
             state.market?.source?.currentTrendSide ||
             state.market?.source?.trendSide ||
             state.market?.raw?.currentTrendSide ||
             state.market?.raw?.trendSide ||
             ""
        );


        if (["LONG", "BULL", "BULLISH", "BUY", "DOWN", "DOWNSIDE"].includes(raw))
return "LONG";
        if (["SHORT", "BEAR", "BEARISH", "SELL", "UP", "UPSIDE"].includes(raw))
return "SHORT";
        if (["NEUTRAL", "MIXED", "CHOP", "SIDEWAYS", "FLAT"].includes(raw)) return
"NEUTRAL";


        return raw || "UNKNOWN";
    }


    function fallbackCurrentFitScore(row = {}) {
        const parsed = parseFixedLongTaxonomyId(microId(row));
        if (!parsed?.isChild) return 0;


        const marketRegime = currentMarketRegimeForFit();
        const marketTrend = currentMarketTrendForFit();


        let score = 0;
        let hasSignal = false;


        if (marketTrend === "LONG") {
             score += 30;
             hasSignal = true;
        } else if (marketTrend === "NEUTRAL") {
             score += 8;
             hasSignal = true;
        } else if (marketTrend === "SHORT") {
             score -= 35;
             hasSignal = true;
        }


        if (marketRegime && marketRegime !== "UNKNOWN") {
             hasSignal = true;


             if (marketRegime === parsed.regime) {
                  score += 40;
             } else if (
                  (marketRegime === "TREND" && parsed.regime === "SQUEEZE") ||
                  (marketRegime === "SQUEEZE" && parsed.regime === "TREND")
             ) {
                  score += 12;
             } else {
                  score -= 10;
             }
        }


        if (parsed.confirmation === "A_STRONG_ALIGN") score += 18;
        if (parsed.confirmation === "B_FLOW_ALIGN") score += 14;
        if (parsed.confirmation === "C_VOLUME_ALIGN") score += 10;
        if (parsed.confirmation === "D_MIXED_OK") score += 4;
        if (parsed.confirmation === "E_WEAK_CONTRA") score -= 8;


        if (!hasSignal) return 0;


        return clamp(score, -80, 100);
    }


    function canonicalCurrentFit(value = "") {
        const fit = upper(value);


        if (["MATCH", "GOOD", "FIT", "ALIGNED", "STRONG_MATCH"].includes(fit))
return "MATCH";
        if (["WEAK_MATCH", "OK", "PARTIAL_MATCH", "SOFT_MATCH"].includes(fit))
return "WEAK_MATCH";
        if (["MISFIT", "BAD", "AGAINST", "CONTRA", "NO_FIT"].includes(fit)) return
"MISFIT";
        if (["NEUTRAL", "MIXED"].includes(fit)) return "NEUTRAL";
        if (["UNKNOWN", "NA", "N/A"].includes(fit)) return "UNKNOWN";


        return "";
    }


    function currentFit(row = {}) {
        const explicitValues = [
             row.currentFitCanonical,
             row.currentFit,
             row.currentFitLabel,
             row.entryCurrentFitCanonical,
             row.entryCurrentFit,
             row.entryCurrentFitLabel,
             row.currentMarketFit,
             row.currentMarketFitLabel,
             row.fit,
             row.fitLabel,
             row.marketFit,
             row.marketFitLabel
        ];


        for (const value of explicitValues) {
             const canonical = canonicalCurrentFit(value);
         if (canonical) return canonical;
    }


    const score = currentFitScore(row);
    if (score >= 70) return "MATCH";
    if (score >= 45) return "WEAK_MATCH";
    if (score <= -20) return "MISFIT";
    if (score !== 0) return "NEUTRAL";


    return "UNKNOWN";
}


function currentFitScore(row = {}) {
    const direct = firstFinite(
         row.currentFitScore,
         row.entryCurrentFitScore,
         row.currentMarketFitScore,
         row.fitScore,
         row.longCurrentFit,
         row.bullCurrentFit,
         row.currentFitLong,
         row.currentFitBull,
         row.longFitScore,
         row.bullFitScore
    );


    if (direct !== null) return direct;


    const explicitShort = firstFinite(
         row.shortCurrentFit,
         row.bearCurrentFit,
         row.bearishCurrentFit,
         row.currentFitShort,
         row.currentFitBear,
         row.shortFitScore,
         row.bearFitScore
    );


    if (explicitShort !== null) return -Math.abs(explicitShort);


    const fit =
         canonicalCurrentFit(row.currentFitCanonical) ||
         canonicalCurrentFit(row.currentFit) ||
         canonicalCurrentFit(row.currentFitLabel) ||
         "UNKNOWN";


    if (fit === "MATCH") return 80;
        if (fit === "WEAK_MATCH") return 60;
        if (fit === "MISFIT") return -60;
        if (fit === "NEUTRAL") return 0;


        return fallbackCurrentFitScore(row);
    }


    function currentFitConfidence(row = {}) {
        const direct = firstFinite(
             row.currentFitConfidence,
             row.entryCurrentFitConfidence,
             row.currentMarketFitConfidence,
             row.fitConfidence,
             row.marketFitConfidence,
             row.weatherConfidence,
             row.currentMarketWeatherConfidence
        );


        if (direct !== null) return direct;


        const fit = currentFit(row);
        if (fit === "MATCH") return 0.8;
        if (fit === "WEAK_MATCH") return 0.6;
        if (fit === "NEUTRAL") return 0.4;
        if (fit === "MISFIT") return 0.7;


        return 0;
    }


    function confidencePercent(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 0;
        return n <= 1 ? n * 100 : n;
    }


    function currentFitPill(row = {}) {
        const fit = currentFit(row);
        const score = currentFitScore(row);
        const conf = confidencePercent(currentFitConfidence(row));


        if (fit === "MATCH") return `<span class="pill fit">FIT
${escapeHtml(fmt(score, 0))}</span>`;
        if (fit === "WEAK_MATCH") return `<span class="pill weakfit">OK
${escapeHtml(fmt(score, 0))}</span>`;
        if (fit === "MISFIT") return `<span class="pill misfit">MISFIT
${escapeHtml(fmt(score, 0))}</span>`;
        if (fit === "NEUTRAL") return `<span class="pill neutral">NEUTRAL
${escapeHtml(fmt(conf, 0))}%</span>`;


        return '<span class="pill raw">UNKNOWN</span>';
    }


    function recentMomentumScore(row = {}) {
        const direct = firstFinite(
             row.recentMomentumScore,
             row.momentumScore,
             row.recentScore,
             row.recentNetRScore
        );


        if (direct !== null) return direct;


        const recentRows = Array.isArray(row.recentOutcomes) ?
row.recentOutcomes.slice(-12) : [];


        if (!recentRows.length) return 0;


        const netR = recentRows.reduce((sum, outcome) => {
             return sum + num(outcome.longNetR ?? outcome.netLongR ?? outcome.netR ??
outcome.exitR ?? outcome.realizedR ?? outcome.r, 0);
        }, 0);


        const directSLPenalty = recentRows.filter((outcome) => outcome.directSL ||
outcome.directToSL).length * 6;
        const costPenalty = recentRows.reduce((sum, outcome) => sum + Math.max(0,
num(outcome.costR, 0)), 0) * 2;


        return clamp(netR * 8 - directSLPenalty - costPenalty, -80, 80);
    }


    function fairWinrate(row = {}) {
        return num(
             row.fairWinrate ??
             row.sampleAdjustedWinrate ??
             row.sampleWilsonLowerBound ??
             row.wilsonLowerBound ??
             row.bayesianWinrate,
             0
        );
    }


    function balancedScore(row = {}) {
        return num(row.dashboardBalancedScore ?? row.balancedScore ??
row.learningQualityRank, 0);
    }


    function netTotalR(row = {}) {
        return num(row.totalR ?? row.netTotalR ?? row.totalNetR, 0);
    }


    function netAvgR(row = {}) {
        return num(row.avgR ?? row.avgNetR ?? row.netAvgR, 0);
    }


    function avgCostR(row = {}) {
        return Math.max(0, num(row.avgCostR ?? row.costR, 0));
    }


    function directSLPct(row = {}) {
        return Math.max(0, num(row.directSLPct, 0));
    }


    function sampleReliability(row = {}) {
        return num(row.sampleReliability, 0);
    }


    function adaptiveScore(row = {}) {
        if (isEmpiricalVeto(row)) return -1000000;


        const direct = firstFinite(
             row.adaptiveScore,
             row.selectionScore,
             row.currentAdaptiveScore
        );


        if (direct !== null) return direct;


        const base = balancedScore(row);
        const fit = currentFitScore(row);
        const momentum = recentMomentumScore(row);
        const reliability = sampleReliability(row);
        const directSLPenalty = directSLPct(row) * 35;
        const costPenalty = avgCostR(row) * 8;


        return base + fit * 0.35 + momentum * 0.25 + reliability * 10 -
directSLPenalty - costPenalty;
    }


    function tierPill(value) {
        const t = String(value || "NA").toUpperCase();
        if (t === "EMPIRICAL_VETO") return '<span class="pill veto">EMPIRICAL VETO</span>';
        if (t === "HARD") return '<span class="pill active">ACTIVE</span>';
        if (t === "SOFT") return '<span class="pill soft">EARLY</span>';
        if (t === "OBSERVATION") return '<span class="pill observation">OBS</span>';
        if (t === "RAW") return '<span class="pill raw">RAW</span>';
        if (t === "MANUAL") return '<span class="pill purple">MANUAL</span>';


        return `<span class="pill">${escapeHtml(t)}</span>`;
    }


    function statusPill(row = {}) {
        const status = learningStatus(row);
        const done = completed(row);


        if (status === "ACTIVE_LEARNING") {
            return '<span class="pill active">ACTIVE_LEARNING</span>';
        }


        if (status === "EARLY_OUTCOMES") {
            return `<span class="pill soft">EARLY_OUTCOMES · ${escapeHtml(fmt(done,
0))}/${MIN_COMPLETED_ACTIVE_LEARNING}</span>`;
        }


        return '<span class="pill observation">OBSERVING</span>';
    }


    function activationGatePill(row = {}) {
        const gate = activationGateStatus(row);


        if (gate === "PASSED") return '<span class="pill passed">PASSED ≥35 + avgR&gt; 0</span>';
        if (gate === "EMPIRICAL_VETO") return '<span class="pill veto">EMPIRICAL VETO</span>';


        return `<span class="pill observation">GATE OBSERVING
${escapeHtml(fmt(completed(row), 0))}/${EMPIRICAL_VETO_MIN_COMPLETED}</span>`;
    }


    function jsonBlock(data) {
        return `<pre>${escapeHtml(JSON.stringify(data ?? null, null, 2))}</pre>`;
    }


    function setMessage(message = "", type = "") {
        $("message").innerHTML = message
            ? `<div class="message ${escapeAttr(type)}">${escapeHtml(message)}</div>`
            : "";
    }


    function showLoading(tabId, label = "Laden...") {
        $(tabId).innerHTML = `
             <div class="card">
               <h3>${escapeHtml(label)}</h3>
               <div class="empty">Data ophalen voor ${escapeHtml(tabId)}...</div>
             </div>
        `;
    }


    function friendlyApiMessage(error) {
        if (error?.timeout) return "API-timeout: request is afgebroken door de admin UI.";


        const status = Number(error?.status || 0);
        const raw = String(error?.message || error || "");


        if (status === 409 || raw.includes("LOCK")) return "Lock actief. Vorige run is nog bezig.";
        if (status === 504 || raw.includes("504")) return "Backend timeout op deze admin-route.";
        if (status === 500) return "Backend error op deze admin-route. Check server logs.";
        if (status === 404) return "Endpoint niet gevonden.";


        return raw || "Onbekende API fout.";
    }


    function timeoutSignal(timeoutMs = state.apiTimeoutMs) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);


        return {
             signal: controller.signal,
             clear: () => clearTimeout(timer)
        };
    }


    function noCacheUrl(url) {
        const join = String(url).includes("?") ? "&" : "?";
        return `${url}${join}_ts=${Date.now()}`;
    }


    async function api(url, options = {}) {
        const timeout = timeoutSignal(options.timeoutMs || state.apiTimeoutMs);
      const headers = {
           accept: "application/json",
           ...(options.headers || {})
      };


      if (options.body !== undefined && !headers["content-type"]) {
           headers["content-type"] = "application/json";
      }


      try {
           const response = await fetch(noCacheUrl(url), {
               cache: "no-store",
               ...options,
               headers,
               signal: options.signal || timeout.signal
           });


           const rawText = await response.text();


           let data = {};


           try {
               data = rawText ? JSON.parse(rawText) : {};
           } catch {
               data = { raw: rawText };
           }


           if (!response.ok) {
               throw new ApiError(`${response.status} ${data.error || data.reason ||
response.statusText}`, {
                 status: response.status,
                 url,
                 data
               });
           }


           return data;
      } catch (error) {
           if (error?.name === "AbortError") {
               throw new ApiError("REQUEST_ABORTED_TIMEOUT", {
                 status: 0,
                 url,
                 timeout: true
               });
           }


           if (error instanceof ApiError) throw error;
             throw new ApiError(error?.message || String(error), {
               status: 0,
               url
             });
        } finally {
             timeout.clear();
        }
    }


    async function optionalApi(url, fallback = null) {
        try {
             return await api(url, { timeoutMs: 12000 });
        } catch {
             return fallback;
        }
    }


    function metricCard(label, value, extra = "") {
        return `
             <div class="card metric-card">
               <div class="metric-label">${escapeHtml(label)}</div>
               <div>
                    <div class="metric-value">${escapeHtml(value)}</div>
                    ${extra ? `<div class="metric-extra">${escapeHtml(extra)}</div>` : ""}
               </div>
             </div>
        `;
    }


    function scoreBar(value, min = 0, max = 100) {
        const n = Number(value);
        const width = Number.isFinite(n)
             ? Math.max(0, Math.min(100, ((n - min) / (max - min)) * 100))
             : 0;


        return `<div class="score-bar"><span style="--w:${width.toFixed(1)}%">
</span></div>`;
    }


    function table(rows, cols, emptyText = "Geen data.") {
        if (!Array.isArray(rows) || rows.length === 0) {
             return `<div class="empty">${escapeHtml(emptyText)}</div>`;
        }


        const head = cols.map((col) => `<th>${escapeHtml(col.label)}
</th>`).join("");
    const body = rows.map((row, index) => {
         const cells = cols.map((col) => {
             const value = col.render
               ? col.render(row, index)
               : escapeHtml(row?.[col.key]);


             return `<td>${value}</td>`;
         }).join("");


         return `<tr>${cells}</tr>`;
    }).join("");


    return `
         <div class="table-wrap">
             <table>
               <thead><tr>${head}</tr></thead>
               <tbody>${body}</tbody>
             </table>
         </div>
    `;
}


function extractObjectArrays(data, keys = []) {
    const rows = [];


    for (const key of keys) {
         const value = data?.[key];


         if (Array.isArray(value)) {
             rows.push(...value);
         } else if (value && typeof value === "object") {
             rows.push(...Object.values(value));
         }
    }


    return rows;
}


function extractDeepMicroRows(data) {
    const output = [];
    const seenObjects = new Set();
    const seenIds = new Set();


    function add(row) {
         if (!row || typeof row !== "object") return;
    const id = microId(row);


    if (!id || seenIds.has(id)) return;
    if (!isRealAnalyzeMicroRow(row)) return;


    seenIds.add(id);
    output.push(row);
}


function walk(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 7) return;
    if (seenObjects.has(value)) return;


    seenObjects.add(value);


    if (Array.isArray(value)) {
        for (const item of value) {
            if (item && typeof item === "object" && microId(item)) add(item);
            walk(item, depth + 1);
        }
        return;
    }


    if (microId(value)) add(value);


    for (const key of [
        "best75MicroFamilies",
        "top75MicroFamilies",
        "bestMicroFamilies",
        "topMicroFamilies",
        "longRows",
        "rows",
        "microFamilies",
        "micros",
        "items",
        "data",
        "result",
        "payload",
        "response",
        "activeRotation",
        "active",
        "balanced",
        "adaptive",
        "winrate",
        "totalR",
        "avgR",
        "directSL",
                 "observed"
             ]) {
                 walk(value[key], depth + 1);
             }
        }


        walk(data, 0);


        return output;
    }


    function extractMicroRowsFromApiPayload(data = {}) {
        const preferred = extractObjectArrays(data, [
             "best75MicroFamilies",
             "top75MicroFamilies",
             "bestMicroFamilies",
             "topMicroFamilies"
        ]);


        const direct = extractObjectArrays(data, [
             "longRows",
             "rows",
             "microFamilies",
             "micros",
             "items"
        ]);


        const nestedPreferred = [
             ...extractObjectArrays(data.result || {}, ["best75MicroFamilies",
"top75MicroFamilies", "bestMicroFamilies", "topMicroFamilies"]),
             ...extractObjectArrays(data.payload || {}, ["best75MicroFamilies",
"top75MicroFamilies", "bestMicroFamilies", "topMicroFamilies"])
        ];


        const deep = extractDeepMicroRows(data);


        const source = preferred.length
             ? preferred
             : nestedPreferred.length
                 ? nestedPreferred
                 : direct.length
                    ? direct
                    : deep;


        const byId = new Map();


        for (const row of source) {
         if (!row || typeof row !== "object") continue;
         if (!isRealAnalyzeMicroRow(row)) continue;


         const id = microId(row);
         if (!id || byId.has(id)) continue;


         byId.set(id, row);
    }


    if (byId.size === 0) {
         for (const row of deep) {
             const id = microId(row);
             if (!id || byId.has(id)) continue;


             byId.set(id, row);
         }
    }


    return [...byId.values()];
}


function compareNumberDesc(a, b) {
    return num(b, 0) - num(a, 0);
}


function compareNumberAsc(a, b) {
    return num(a, 0) - num(b, 0);
}


function compareMicroIds(a = {}, b = {}) {
    return String(microId(a) || "").localeCompare(String(microId(b) || ""));
}


function compareBestDataFirst(a, b) {
    return (
         compareNumberDesc(balancedScore(a), balancedScore(b)) ||
         compareNumberDesc(netTotalR(a), netTotalR(b)) ||
         compareNumberDesc(netAvgR(a), netAvgR(b)) ||
         compareNumberDesc(sampleReliability(a), sampleReliability(b)) ||
         compareNumberDesc(fairWinrate(a), fairWinrate(b)) ||
         compareNumberAsc(avgCostR(a), avgCostR(b)) ||
         compareNumberAsc(directSLPct(a), directSLPct(b)) ||
         compareNumberDesc(observationSample(a), observationSample(b)) ||
         compareNumberDesc(completed(a), completed(b)) ||
         compareMicroIds(a, b)
    );
}
function compareMicroRows(a, b, mode = state.microMode) {
  if (mode === "adaptive") {
      return (
           compareNumberDesc(adaptiveScore(a), adaptiveScore(b)) ||
           compareBestDataFirst(a, b)
      );
  }


  if (mode === "currentFit") {
      return (
           compareNumberDesc(currentFitScore(a), currentFitScore(b)) ||
           compareNumberDesc(currentFitConfidence(a), currentFitConfidence(b)) ||
           compareBestDataFirst(a, b)
      );
  }


  if (mode === "cost") {
      return (
           compareNumberAsc(avgCostR(a), avgCostR(b)) ||
           compareBestDataFirst(a, b)
      );
  }


  if (mode === "observed") {
      return (
           compareNumberDesc(observationSample(a), observationSample(b)) ||
           compareBestDataFirst(a, b)
      );
  }


  if (mode === "directSL") {
      return (
           compareNumberAsc(directSLPct(a), directSLPct(b)) ||
           compareBestDataFirst(a, b)
      );
  }


  if (mode === "totalR") {
      return (
           compareNumberDesc(netTotalR(a), netTotalR(b)) ||
           compareBestDataFirst(a, b)
      );
  }


  if (mode === "avgR") {
      return (
                 compareNumberDesc(netAvgR(a), netAvgR(b)) ||
                 compareBestDataFirst(a, b)
            );
        }


        if (mode === "winrate") {
            return (
                 compareNumberDesc(fairWinrate(a), fairWinrate(b)) ||
                 compareNumberDesc(a.sampleWilsonLowerBound ?? a.wilsonLowerBound,
b.sampleWilsonLowerBound ?? b.wilsonLowerBound) ||
                 compareNumberDesc(a.sampleBayesianWinrate ?? a.bayesianWinrate,
b.sampleBayesianWinrate ?? b.bayesianWinrate) ||
                 compareNumberDesc(completed(a), completed(b)) ||
                 compareBestDataFirst(a, b)
            );
        }


        return compareBestDataFirst(a, b);
    }


    function normalizeMicroRowForUi(row = {}) {
        const id = microId(row);
        const parentId = parentMicroId(row) || parentFromChildTrueMicroFamilyId(id);
        const done = completed(row);
        const obs = observationSample(row);
        const status = learningStatus(row);
        const rowTier = tier(row);


        return {
            ...row,
            microFamilyId: id,
            trueMicroFamilyId: id,
            childTrueMicroFamilyId: id,


            parentTrueMicroFamilyId: parentId,
            parentMicroFamilyId: parentId,
            parentMacroFamilyId: parentId,
            macroFamilyId: parentId,
            coarseMicroFamilyId: parentId,


            side: DASHBOARD_SIDE,
            dashboardSide: DASHBOARD_SIDE,
            tradeSide: ONLY_SIDE,
            targetTradeSide: ONLY_SIDE,
            positionSide: ONLY_SIDE,
            direction: ONLY_SIDE,
        longOnly: true,
        shortDisabled: true,
        shortOnly: false,
        longDisabled: false,


        completed: done,
        outcomeSample: done,
        observationSample: obs,
        learningStatus: status,
        status,


        tooEarly: done < MIN_COMPLETED_ACTIVE_LEARNING,
        tooEarlyReason: done < MIN_COMPLETED_ACTIVE_LEARNING
          ? `completed ${done}/${MIN_COMPLETED_ACTIVE_LEARNING}`
          : null,


        tier: rowTier,
        selectedTier: rowTier,
        rotationEligibilityTier: rowTier,


        dashboardBalancedScore: balancedScore(row),
        balancedScore: num(row.balancedScore ?? row.dashboardBalancedScore ??
row.learningQualityRank, 0),
        fairWinrate: fairWinrate(row),
        recentMomentumScore: recentMomentumScore(row),
        currentFitScore: currentFitScore(row),
        adaptiveScore: adaptiveScore(row),


        avgCostR: avgCostR(row),
        directSLPct: directSLPct(row),


        trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
        parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
        learningGranularity: LEARNING_GRANULARITY,
        parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
        selectionGranularity: "EXACT_75_CHILD",


        measurementFixVersion: outcomeMeasurementVersion(row) ||
MEASUREMENT_FIX_VERSION,
        outcomeMeasurementVersion: outcomeMeasurementVersion(row) ||
MEASUREMENT_FIX_VERSION,
        acceptedOutcomeMeasurementVersion: MEASUREMENT_FIX_VERSION,
        previousSupportedMeasurementFixVersion: PREVIOUS_MEASUREMENT_FIX_VERSION,
        outcomeMeasurementGateMode: OUTCOME_MEASUREMENT_GATE_MODE,
        strictOutcomeMeasurementGate: true,
        legacyOutcomeMeasurementsExcluded: true,
        completedCurrentMeasurementOnly: true,
        exitFillModelVersion: row.exitFillModelVersion || EXIT_FILL_MODEL_VERSION,
        exitFillPolicy: row.exitFillPolicy ||
"TP_SL_USE_TRIGGER_BOUNDARY_TIME_STOP_USES_OBSERVED_PRICE",
        adaptiveUiVersion: ADAPTIVE_UI_VERSION,
        frontendFixVersion: FRONTEND_FIX_VERSION,


        empiricalVetoPolicyVersion: row.empiricalVetoPolicyVersion ||
EMPIRICAL_VETO_POLICY_VERSION,
        empiricalVetoMinCompleted: EMPIRICAL_VETO_MIN_COMPLETED,
        empiricalVetoMaxAvgR: EMPIRICAL_VETO_MAX_AVG_R,
        activationGateStatus: activationGateStatus(row),
        activationGatePassed: activationGatePassed(row),
        empiricalVeto: isEmpiricalVeto(row),
        empiricalVetoed: isEmpiricalVeto(row),
        discordEligible: discordSelectionAllowed(row),
        discordBlocked: !discordSelectionAllowed(row),
        discordBlockReason: discordSelectionAllowed(row) ? null :
discordSelectionBlockReason(row),


        completedDefinition:
"CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES_CURRENT_MEASUREMENT_ONLY",
        completedOnlyClosedVirtualOrShadow: true,
        scoringRSource: "netR",
        winsLossesFlatsSource: "netR",
        avgRSource: "netR",
        totalRSource: "netR",
        avgCostRSource: "costR",
        seenDefinition: "UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY",


        riskTradeSide: ONLY_SIDE,
        riskGeometryRule: "LONG: sl < entry < tp",
        tpHitRule: "LONG: price >= tp",
        slHitRule: "LONG: price <= sl",
        grossRFormula: "(exitPrice - entry) / (entry - initialSl)",
        currentRFormula: "(currentPrice - entry) / (entry - initialSl)",


        currentFitVersion: row.currentFitVersion || CURRENT_FIT_VERSION,
        currentFitPolarity: "BULLISH_POSITIVE_BEARISH_NEGATIVE",
        currentFitDefinition: "LONG_MIRRORED_CURRENT_FIT",
        currentFitSoftOnly: true,
        currentFitBlocksLearning: false,
        currentFitBlocksVirtualLearning: false,
        currentFitBlocksShadowLearning: false,
        learningRemainsBroad: true,
        selectionIsAdaptive: true,
        discordWillBeStrict: true,
             scannerFingerprintRole: row.scannerFingerprintRole || "METADATA_ONLY",
             scannerFingerprintsMetadataOnly: true,
             scannerFingerprintsUsedAsLearningFamily: false,
             executionFingerprintsMetadataOnly: true,
             executionFingerprintsUsedAsLearningFamily: false,


             legacyScannerFamilyFallback: false,
             scannerFingerprintLegacy: false,
             learningIdentitySource: row.learningIdentitySource ||
"ANALYZE_TRUE_MICRO_FAMILY",
             symbolExcludedFromFamilyId: row.symbolExcludedFromFamilyId !== false
        };
    }


    function rankMicroRows(rows = [], mode = state.microMode) {
        return rows
             .filter(isRealAnalyzeMicroRow)
             .map((row) => ({
                  ...normalizeMicroRowForUi(row),
                  apiRank: Number.isFinite(Number(row.rank)) ? Number(row.rank) : null
             }))
             .sort((a, b) => {
                  const vetoOrder = Number(isEmpiricalVeto(a)) -
Number(isEmpiricalVeto(b));
                  if (vetoOrder !== 0) return vetoOrder;


                  if (a.apiRank !== null && b.apiRank !== null) return a.apiRank -
b.apiRank;


                  return compareMicroRows(a, b, mode);
             })
             .map((row, index) => ({ ...row, rank: index + 1 }));
    }


    function microApiUrl() {
        const params = new URLSearchParams();
        params.set("mode", state.microMode);
        params.set("side", ONLY_SIDE);
        params.set("tradeSide", ONLY_SIDE);
        params.set("targetTradeSide", ONLY_SIDE);
        params.set("dashboardSide", DASHBOARD_SIDE);
        params.set("weekKey", PERSISTENT_LEARNING_KEY);
        params.set("persistentLearningKey", PERSISTENT_LEARNING_KEY);
        params.set("trueMicroFamilySchema", TRUE_MICRO_SCHEMA);
        params.set("parentTrueMicroFamilySchema", PARENT_TRUE_MICRO_SCHEMA);
        params.set("selectionGranularity", "EXACT_75_CHILD");
        params.set("limit", String(state.microLimit));
    params.set("bestLimit", String(state.bestLimit));
    params.set("sideLimit", String(state.bestLimit));
    params.set("sideEnsureLimit", String(state.bestLimit));
    params.set("includeActiveRotation", "1");
    params.set("includeMarketWeather", "1");
    params.set("includeCurrentFit", "1");
    params.set("includeAdaptive", "1");
    params.set("includeTemporal", "1");
    params.set("includeTemporalProfiles", "1");
    params.set("includeActiveTemporalGeneration", "1");
    params.set("compact", "1");


    if (state.microSearch.trim()) params.set("q", state.microSearch.trim());


    return `${endpoints.micros}?${params.toString()}`;
}


function rotationApiUrl() {
    const params = new URLSearchParams();


    params.set("side", ONLY_SIDE);
    params.set("tradeSide", ONLY_SIDE);
    params.set("targetTradeSide", ONLY_SIDE);
    params.set("dashboardSide", DASHBOARD_SIDE);
    params.set("weekKey", PERSISTENT_LEARNING_KEY);
    params.set("trueMicroFamilySchema", TRUE_MICRO_SCHEMA);
    params.set("parentTrueMicroFamilySchema", PARENT_TRUE_MICRO_SCHEMA);
    params.set("selectionGranularity", "EXACT_75_CHILD");
    params.set("includeAvailable", "1");
    params.set("includeAdaptive", "1");
    params.set("includeCurrentFit", "1");
    params.set("includeTemporal", "1");
    params.set("includeTemporalProfiles", "1");
    params.set("includeTemporalGeneration", "1");
    params.set("includeActiveTemporalGeneration", "1");
    params.set("activeRowsLimit", "160");
    params.set("availableLimit", "240");


    return `${endpoints.rotation}?${params.toString()}`;
}


function marketApiUrl() {
    const params = new URLSearchParams();


    params.set("side", ONLY_SIDE);
    params.set("tradeSide", ONLY_SIDE);
    params.set("targetTradeSide", ONLY_SIDE);
    params.set("dashboardSide", DASHBOARD_SIDE);
    params.set("includeUniverse", "1");
    params.set("includeBreadth", "1");
    params.set("includeCurrentFit", "1");


    return `${endpoints.market}?${params.toString()}`;
}
function extractMarketData(data = {}) {
  const source =
       data.marketWeather ||
       data.weather ||
       data.currentMarketWeather ||
       data.latest ||
       data.snapshot ||
       data;


  const universe =
       data.marketUniverse ||
       data.universe ||
       source.universe ||
       source.marketUniverse ||
       {};


  const createdAt = num(
       source.createdAt ||
       source.completedAt ||
       source.updatedAt ||
       source.ts ||
       universe.createdAt ||
       universe.updatedAt,
       0
  );


  const regime = upper(
       source.currentRegime ||
       source.regime ||
       source.marketRegime ||
       source.breadthRegime ||
       universe.currentRegime ||
       universe.regime ||
       "UNKNOWN"
  );


  const trendSide = upper(
       source.currentTrendSide ||
       source.trendSide ||
       source.marketSide ||
       source.side ||
       source.direction ||
       source.breadthSide ||
       universe.currentTrendSide ||
       universe.trendSide ||
       "UNKNOWN"
);


const bearishPct = firstFinite(
     source.bearishPct,
     source.shortPct,
     source.downPct,
     source.breadthBearishPct,
     source.universeBearishPct,
     universe.bearishPct,
     universe.shortPct,
     universe.downPct
);


const bullishPct = firstFinite(
     source.bullishPct,
     source.longPct,
     source.upPct,
     source.breadthBullishPct,
     source.universeBullishPct,
     universe.bullishPct,
     universe.longPct,
     universe.upPct
);


const squeezePct = firstFinite(
     source.squeezePct,
     source.compressionPct,
     source.breadthSqueezePct,
     universe.squeezePct,
     universe.compressionPct
);


const confidence = firstFinite(
     source.confidence,
     source.weatherConfidence,
     source.currentTrendConfidence,
     source.breadthConfidence,
     universe.confidence
);


return {
     raw: data,
     source,
     universe,
     ok: Boolean(data && Object.keys(data).length),
     createdAt,
     ageText: ageText(createdAt),
         regime,
         trendSide,
         bearishPct,
         bullishPct,
         squeezePct,
         confidence
    };
}


async function fetchMarket() {
    const url = marketApiUrl();


    try {
         const data = await api(url, {
           timeoutMs: 18000
         });


         const market = extractMarketData(data || {});
         state.market = market;


         return market;
    } catch (error) {
         const data = {
           ok: false,
           available: false,
           reason: "MARKET_WEATHER_API_ERROR",
           url,
           status: error?.status || 0,
           message: friendlyApiMessage(error),
           rawError: error?.message || String(error),
           file: "src/market/marketWeather.js",
           apiRoute: "/api/admin/market-weather",
           currentRegime: "UNKNOWN",
           currentTrendSide: "UNKNOWN",
           regime: "UNKNOWN",
           trendSide: "UNKNOWN",
           confidence: 0,
           breadth: {},
           btc: {},
           currentFitPolarity: "BULLISH_POSITIVE_BEARISH_NEGATIVE",
           currentFitDefinition: "LONG_MIRRORED_CURRENT_FIT",
           currentFitSoftOnly: true,
           currentFitBlocksLearning: false,
           currentFitBlocksVirtualLearning: false,
           currentFitBlocksShadowLearning: false,
           learningRemainsBroad: true,
           measurementFixVersion: MEASUREMENT_FIX_VERSION,
             outcomeMeasurementGateMode: OUTCOME_MEASUREMENT_GATE_MODE,
             exitFillModelVersion: EXIT_FILL_MODEL_VERSION,
             currentFitVersion: CURRENT_FIT_VERSION
        };


        const market = extractMarketData(data);
        state.market = market;


        return market;
    }
}


function activeMicroIds() {
    return uniqueStrings([
        state.rotation?.activeMicroFamilyIds || [],
        state.rotation?.activeRotation?.activeMicroFamilyIds || [],
        state.rotation?.activeRotation?.microFamilyIds || [],
        state.rotation?.activeRotation?.trueMicroFamilyIds || [],
        state.rotation?.active?.activeMicroFamilyIds || [],
        state.rotation?.active?.microFamilyIds || [],
        state.rotation?.active?.trueMicroFamilyIds || [],
        state.micros?.activeMicroFamilyIds || [],
        state.micros?.activeRotation?.activeMicroFamilyIds || [],
        state.micros?.activeRotation?.microFamilyIds || [],
        state.micros?.activeRotation?.trueMicroFamilyIds || [],
        state.overview?.activeMicroFamilyIds || [],
        state.trade?.activeMicroFamilyIds || []
    ]).filter(idAllowedInLongOnly);
}


function activeParentIds() {
    return uniqueStrings([
        state.rotation?.activeMacroFamilyIds || [],
        state.rotation?.activeRotation?.activeMacroFamilyIds || [],
        state.rotation?.activeRotation?.macroFamilyIds || [],
        state.rotation?.active?.activeMacroFamilyIds || [],
        state.rotation?.active?.macroFamilyIds || [],
        state.micros?.activeMacroFamilyIds || [],
        state.micros?.activeRotation?.activeMacroFamilyIds || [],
        state.micros?.activeRotation?.macroFamilyIds || [],
        state.overview?.activeMacroFamilyIds || [],
        state.trade?.activeMacroFamilyIds || []
    ]).filter(parentIdAllowedInLongOnly);
}


function longRows(rows = []) {
    return (Array.isArray(rows) ? rows : [])
           .filter(Boolean)
           .filter((row) => inferSide(row) !== OPPOSITE_SIDE);
    }


    function coinCard(row = {}) {
         const symbol = baseSymbol(row);
         const score = row.scannerScore ?? row.moveScore ?? row.sniperScore ??
row.confluence ?? 0;
         const price = row.price ?? row.currentPrice ?? row.markPrice ?? row.entry;


         return `
           <article class="coin-card">
             <div class="coin-head">
               <div>
                    <div class="coin-symbol">${escapeHtml(symbol)}</div>
                    <div class="coin-name">${escapeHtml(row.name || row.coinName ||
row.contractSymbol || `${symbol}USDT`)}</div>
               </div>
               <div class="coin-price">
                    <strong>$${escapeHtml(fmtPrice(price))}</strong>
                    <span>${escapeHtml(row.contractSymbol || `${symbol}USDT`)}</span>
               </div>
             </div>


             <div class="coin-foot">
               <span class="pill long">LONG</span>
               <span class="pill purple">${escapeHtml(row.source || "SCANNER")}
</span>
               <span class="pill info">Score ${escapeHtml(fmt(score, 1))}</span>
               <span class="pill raw">metadata only</span>
             </div>


             ${scoreBar(score, 0, 100)}


             <div class="coin-stats">
               <div class="coin-stat"><span>1h</span>
<strong>${escapeHtml(fmtRawPct(row.change1h))}</strong></div>
               <div class="coin-stat"><span>24h</span>
<strong>${escapeHtml(fmtRawPct(row.change24h))}</strong></div>
               <div class="coin-stat"><span>Volume</span>
<strong>${escapeHtml(fmtMoney(row.volume24h || row.quoteVolume24h))}</strong>
</div>
               <div class="coin-stat"><span>BTC</span>
<strong>${escapeHtml(row.btcState || "-")}</strong></div>
               <div class="coin-stat"><span>Regime</span>
<strong>${escapeHtml(row.regime || "-")}</strong></div>
               <div class="coin-stat"><span>FakeBO</span><strong>${row.fakeBreakout ?
"YES" : "NO"}</strong></div>
                 <div class="coin-stat"><span>Fit</span>
<strong>${escapeHtml(currentFit(row))}</strong></div>
                 <div class="coin-stat"><span>FitScore</span>
<strong>${escapeHtml(fmt(currentFitScore(row), 0))}</strong></div>
               </div>
             </article>
        `;
    }


    function positionCard(row = {}) {
        const symbol = baseSymbol(row);
        const currentR = num(row.currentR ?? row.longCurrentR, 0);


        return `
             <article class="coin-card">
               <div class="coin-head">
                 <div>
                   <div class="coin-symbol">${escapeHtml(symbol)}</div>
                   <div class="coin-name">${escapeHtml(row.contractSymbol ||
`${symbol}USDT`)}</div>
                 </div>
                 <div class="coin-price">
                   <strong>${escapeHtml(fmt(currentR, 3))}R</strong>
                   <span>current R</span>
                 </div>
               </div>


               <div class="coin-foot">
                 <span class="pill long">LONG</span>
                 <span class="pill purple">VIRTUAL</span>
                 <span class="pill ${currentR >= 0 ? "active" :
"danger"}">${escapeHtml(fmt(currentR, 2))}R</span>
                 ${currentFitPill(row)}
               </div>


               <div class="coin-stats">
                 <div class="coin-stat"><span>Entry</span>
<strong>${escapeHtml(fmtPrice(row.entry))}</strong></div>
                 <div class="coin-stat"><span>SL</span>
<strong>${escapeHtml(fmtPrice(row.sl || row.stopLoss))}</strong></div>
                 <div class="coin-stat"><span>TP</span>
<strong>${escapeHtml(fmtPrice(row.tp || row.takeProfit))}</strong></div>
                 <div class="coin-stat"><span>RR</span><strong>${escapeHtml(fmt(row.rr,
2))}</strong></div>
                 <div class="coin-stat"><span>MFE</span>
<strong>${escapeHtml(fmt(row.mfeR, 2))}R</strong></div>
                 <div class="coin-stat"><span>MAE</span>
<strong>${escapeHtml(fmt(row.maeR, 2))}R</strong></div>
                 <div class="coin-stat"><span>CostR</span>
<strong>${escapeHtml(fmt(row.costR || row.avgCostR, 3))}</strong></div>
                 <div class="coin-stat"><span>DirectSL</span><strong>${row.directSL ||
row.directToSL ? "YES" : "NO"}</strong></div>
               </div>


               <div class="coin-foot">
                 <code>${escapeHtml(microId(row) || "NO_75_CHILD")}</code>
               </div>
             </article>
        `;
    }


    function microTable(rows = []) {
        if (!Array.isArray(rows) || rows.length === 0) {
             return `<div class="empty">Geen geldige LONG 75-child Analyze micro-
families.</div>`;
        }


        const activeSet = new Set(activeMicroIds());


        const desktopRows = rows.map((row, index) => {
             const id = microId(row);
             const parentId = parentMicroId(row);
             const active = activeSet.has(id);
             const obs = observationSample(row);
             const selectable = discordSelectionAllowed(row);
             const selectionReason = selectable ? "" :
discordSelectionBlockReason(row);


             return `
               <tr>
                 <td><strong>${escapeHtml(row.rank ?? index + 1)}</strong></td>
                 <td><span class="pill ${active ? "active" : ""}">${active ? "ACTIVE" :
"OFF"}</span></td>
                 <td class="micro-id-cell">
                      <button class="small" type="button" data-open-
micro="${escapeAttr(id)}">
                        <code>${escapeHtml(id || "NO_75_CHILD")}</code>
                      </button>
                 </td>
                 <td class="micro-id-cell"><code>${escapeHtml(parentId || "NO_PARENT")}
</code></td>
                 <td><span class="pill long">LONG</span></td>
                 <td>${tierPill(tier(row))}</td>
               <td>${statusPill(row)}</td>
               <td>${activationGatePill(row)}</td>
               <td>${tooEarly(row)
                 ? `<span class="pill warn">${escapeHtml(fmt(completed(row),
0))}/${MIN_COMPLETED_ACTIVE_LEARNING}</span>`
                 : '<span class="pill active">OK</span>'
               }</td>
               <td>${fmtInt(obs)}</td>
               <td>${fmt(completed(row), 2)}</td>
               <td>${fmtPct(row.fairWinrate ?? row.sampleAdjustedWinrate ??
row.bayesianWinrate ?? row.wilsonLowerBound)}</td>
               <td>${fmt(row.avgR, 3)}</td>
               <td>${fmt(row.totalR, 3)}</td>
               <td>${fmt(avgCostR(row), 3)}</td>
               <td>${fmtPct(directSLPct(row))}</td>
               <td>${currentFitPill(row)}</td>
               <td><strong>${escapeHtml(fmt(adaptiveScore(row), 2))}</strong></td>
               <td>
                 <div class="micro-actions">
                      <button type="button" class="small long-action" data-activate-
one="${escapeAttr(id)}" title="${escapeAttr(selectionReason)}" ${selectable ? "" :
"disabled"}>Select exact</button>
                      <button type="button" class="small" data-copy="${escapeAttr(id)}"
${isSelectableTrueMicroId(id) ? "" : "disabled"}>Copy</button>
                 </div>
               </td>
             </tr>
        `;
      }).join("");


      const mobileCards = rows.map((row, index) => {
        const id = microId(row);
        const parentId = parentMicroId(row);
        const active = activeSet.has(id);
        const obs = observationSample(row);
        const selectable = discordSelectionAllowed(row);
        const selectionReason = selectable ? "" :
discordSelectionBlockReason(row);


        return `
             <article class="micro-card">
               <div class="micro-card-top">
                 <div>
                      <div class="micro-card-title">#${escapeHtml(row.rank ?? index +
1)}</div>
                      <div class="metric-extra">75-child true micro</div>
                 </div>
                <div class="toolbar" style="margin:0">
                    <span class="pill ${active ? "active" : ""}">${active ? "ACTIVE" :
"OFF"}</span>
                    <span class="pill long">LONG</span>
                </div>
            </div>


            <button class="micro-id-button" type="button" data-open-
micro="${escapeAttr(id)}">
                <code>${escapeHtml(id || "NO_75_CHILD")}</code>
            </button>


            <div class="metric-extra">Parent 15</div>
            <code>${escapeHtml(parentId || "NO_PARENT")}</code>


            <div class="toolbar">
                ${tierPill(tier(row))}
                ${statusPill(row)}
                ${activationGatePill(row)}
                ${tooEarly(row)
                    ? `<span class="pill warn">${escapeHtml(fmt(completed(row),
0))}/${MIN_COMPLETED_ACTIVE_LEARNING}</span>`
                    : '<span class="pill active">OK</span>'
                }
                ${currentFitPill(row)}
            </div>


            <div class="micro-stat-grid">
                <div class="micro-stat-box"><span>Seen</span>
<strong>${escapeHtml(fmtInt(obs))}</strong></div>
                <div class="micro-stat-box"><span>Completed</span>
<strong>${escapeHtml(fmt(completed(row), 2))}</strong></div>
                <div class="micro-stat-box"><span>Fair WR</span>
<strong>${escapeHtml(fmtPct(row.fairWinrate ?? row.sampleAdjustedWinrate ??
row.bayesianWinrate ?? row.wilsonLowerBound))}</strong></div>
                <div class="micro-stat-box"><span>AvgR net</span>
<strong>${escapeHtml(fmt(row.avgR, 3))}</strong></div>
                <div class="micro-stat-box"><span>TotalR net</span>
<strong>${escapeHtml(fmt(row.totalR, 3))}</strong></div>
                <div class="micro-stat-box"><span>AvgCostR</span>
<strong>${escapeHtml(fmt(avgCostR(row), 3))}</strong></div>
                <div class="micro-stat-box"><span>DirectSL</span>
<strong>${escapeHtml(fmtPct(directSLPct(row)))}</strong></div>
                <div class="micro-stat-box"><span>FitScore</span>
<strong>${escapeHtml(fmt(currentFitScore(row), 1))}</strong></div>
                <div class="micro-stat-box"><span>CurrentFit</span>
<strong>${escapeHtml(currentFit(row))}</strong></div>
                 <div class="micro-stat-box"><span>Adaptive</span>
<strong>${escapeHtml(fmt(adaptiveScore(row), 2))}</strong></div>
               </div>


               <div class="toolbar">
                 <button type="button" class="long-action" data-activate-
one="${escapeAttr(id)}" title="${escapeAttr(selectionReason)}" ${selectable ? "" :
"disabled"}>Select exact</button>
                 <button type="button" data-copy="${escapeAttr(id)}"
${isSelectableTrueMicroId(id) ? "" : "disabled"}>Copy</button>
               </div>
             </article>
        `;
      }).join("");


      return `
        <div class="table-wrap micro-desktop-table">
             <table>
               <thead>
                 <tr>
                   <th>Rank</th>
                   <th>Discord</th>
                   <th>75-child true micro</th>
                   <th>Parent 15</th>
                   <th>Side</th>
                   <th>Tier</th>
                   <th>Status</th>
                   <th>Activation gate</th>
                   <th>Sample</th>
                   <th>Seen</th>
                   <th>Completed</th>
                   <th>Fair WR</th>
                   <th>AvgR</th>
                   <th>TotalR</th>
                   <th>AvgCostR</th>
                   <th>DirectSL</th>
                   <th>CurrentFit</th>
                   <th>Adaptive</th>
                   <th>Actie</th>
                 </tr>
               </thead>
               <tbody>${desktopRows}</tbody>
             </table>
        </div>


        <div class="micro-mobile-cards">
             ${mobileCards}
             </div>
        `;
    }


    function bindMicroEvents() {
        document.querySelectorAll("[data-activate-one]").forEach((btn) => {
             btn.addEventListener("click", () =>
activateSelectedMicroFamilies([btn.dataset.activateOne]));
        });


        document.querySelectorAll("[data-copy]").forEach((btn) => {
             btn.addEventListener("click", () => copyText(btn.dataset.copy, "75-child trueMicroFamilyId gekopieerd."));
        });


        document.querySelectorAll("[data-open-micro]").forEach((btn) => {
             btn.addEventListener("click", () => openMicro(btn.dataset.openMicro));
        });
    }


    async function copyText(text, message = "Gekopieerd.") {
        try {
             await navigator.clipboard.writeText(String(text || ""));
             setMessage(message, "ok");
        } catch {
             const area = document.createElement("textarea");
             area.value = String(text || "");
             document.body.appendChild(area);
             area.select();
             document.execCommand("copy");
             area.remove();
             setMessage(message, "ok");
        }
    }


    function downloadJson(filename, data) {
        const blob = new Blob([JSON.stringify(data ?? {}, null, 2)], {
             type: "application/json"
        });


        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");


        link.href = url;
        link.download = filename;
        link.click();
        URL.revokeObjectURL(url);
    }


    async function fetchMicros() {
        const data = await api(microApiUrl(), {
             timeoutMs: 22000
        });


        const acceptedMeasurementVersion = String(
             data.acceptedOutcomeMeasurementVersion ||
             data.outcomeMeasurementVersion ||
             data.measurementFixVersion ||
             MEASUREMENT_FIX_VERSION
        );


        const rawRows = extractMicroRowsFromApiPayload(data).map((row) => ({
             ...row,
             measurementFixVersion: row.measurementFixVersion ||
acceptedMeasurementVersion,
             outcomeMeasurementVersion: row.outcomeMeasurementVersion ||
acceptedMeasurementVersion,
             acceptedOutcomeMeasurementVersion: acceptedMeasurementVersion,
             exitFillModelVersion: row.exitFillModelVersion ||
data.exitFillModelVersion || EXIT_FILL_MODEL_VERSION,
             outcomeMeasurementGateMode: row.outcomeMeasurementGateMode ||
data.outcomeMeasurementGateMode || OUTCOME_MEASUREMENT_GATE_MODE,
             completedCurrentMeasurementOnly: row.completedCurrentMeasurementOnly ??
data.completedCurrentMeasurementOnly ?? true,
             legacyOutcomeMeasurementsExcluded: row.legacyOutcomeMeasurementsExcluded
?? data.legacyOutcomeMeasurementsExcluded ?? true
        }));
        const rows = rankMicroRows(rawRows, state.microMode);


        return {
             ...data,
             rows,
             rawExtractedRows: rawRows.length,
             activeMicroFamilyIds: uniqueStrings([
               data.activeMicroFamilyIds || [],
               data.selectedMicroFamilyIds || [],
               data.activeRotation?.activeMicroFamilyIds || [],
               data.activeRotation?.microFamilyIds || [],
               data.activeRotation?.trueMicroFamilyIds || []
             ]).filter(idAllowedInLongOnly),
             activeMacroFamilyIds: uniqueStrings([
               data.activeMacroFamilyIds || [],
               data.selectedMacroFamilyIds || [],
           data.activeRotation?.activeMacroFamilyIds || [],
           data.activeRotation?.macroFamilyIds || []
         ]).filter(parentIdAllowedInLongOnly)
    };
}


function currentMicroRows() {
    const rows = state.micros?.rows || [];
    const search = state.microSearch.trim().toLowerCase();


    const filtered = search
         ? rows.filter((row) => JSON.stringify(row).toLowerCase().includes(search))
         : rows;


    return rankMicroRows(filtered, state.microMode);
}


async function ensureMicrosLoaded() {
    if (state.micros?.rows?.length) return state.micros;


    try {
         state.micros = await fetchMicros();
    } catch {
         state.micros = state.micros || { rows: [] };
    }


    return state.micros;
}


async function renderOverview() {
    showLoading("overview");


    const [data, microData, market] = await Promise.all([
         api(endpoints.overview).catch((error) => ({
           ok: false,
           error: friendlyApiMessage(error)
         })),
         ensureMicrosLoaded(),
         fetchMarket()
    ]);


    state.overview = data;
    state.market = market;


    const microRows = microData?.rows || [];
    const activeCount = uniqueStrings([
         data.activeMicroFamilyIds || [],
              data.activeRotation?.activeMicroFamilyIds || [],
              data.activeRotation?.microFamilyIds || [],
              data.activeRotation?.trueMicroFamilyIds || [],
              microData?.activeMicroFamilyIds || []
         ]).filter(idAllowedInLongOnly).length;


         const observing = microRows.filter((row) => learningStatus(row) ===
"OBSERVING").length;
         const early = microRows.filter((row) => learningStatus(row) ===
"EARLY_OUTCOMES").length;
         const active = microRows.filter((row) => learningStatus(row) ===
"ACTIVE_LEARNING").length;
         const gatePassed = microRows.filter((row) => activationGateStatus(row) ===
"PASSED").length;
         const empiricalVeto = microRows.filter((row) =>
isEmpiricalVeto(row)).length;
         const avgCost = microRows.length ? microRows.reduce((sum, row) => sum +
avgCostR(row), 0) / microRows.length : 0;
         const avgDirectSL = microRows.length ? microRows.reduce((sum, row) => sum +
directSLPct(row), 0) / microRows.length : 0;
         const temporalContext = temporalContextFromPayload(
              data.temporalContext ||
              data.currentTemporalContext ||
              data.latestScan ||
              data.tradeRunMeta ||
              {}
         );
         const temporalPolicy = temporalPolicyForContext(temporalContext, data);
         const temporalGeneration = temporalGenerationFromPayload(data);
         const contextStats = data.contextStats || data.temporalStats?.contextStats
|| {};
         const sessionStats = data.sessionStats || data.temporalStats?.sessionStats
|| {};


         $("overview").innerHTML = `
              <div class="grid">
                   ${metricCard("Learning key", PERSISTENT_LEARNING_KEY)}
                   ${metricCard("Redis namespace", LONG_KEY_PREFIX)}
                   ${metricCard("Selectable children", "75", "5 setups × 3 regimes × 5 confirmations")}
                   ${metricCard("Parent families", "15", "metadata/context, not Discord match")}
                   ${metricCard("Discord selected 75-child IDs", fmtInt(activeCount))}
                   ${metricCard("Open virtual positions", fmtInt(data.openPositions ||
data.positionsCount))}
                   ${metricCard("Scanner LONG candidates",
fmtInt(data.longScannerCandidates || data.scannerCandidates ||
data.latestScan?.longCandidatesCount))}
            ${metricCard("Analyze 75-child rows", fmtInt(microRows.length ||
data.currentWeekMicroFamilies))}
          </div>


          <div class="grid">
            ${metricCard("OBSERVING", fmtInt(observing), "completed = 0")}
            ${metricCard("EARLY_OUTCOMES", fmtInt(early), `completed 1-
${MIN_COMPLETED_ACTIVE_LEARNING - 1}`)}
            ${metricCard("ACTIVE_LEARNING", fmtInt(active), `completed
${MIN_COMPLETED_ACTIVE_LEARNING}-${EMPIRICAL_VETO_MIN_COMPLETED - 1}`)}
            ${metricCard("Gate PASSED", fmtInt(gatePassed), `completed ≥
${EMPIRICAL_VETO_MIN_COMPLETED} en avgR > 0`)}
            ${metricCard("EMPIRICAL VETO", fmtInt(empiricalVeto), `completed ≥
${EMPIRICAL_VETO_MIN_COMPLETED} en avgR ≤ 0`)}
            ${metricCard("Ranking", "adaptive", "veto last → API rank → netR/cost")}
            ${metricCard("AvgCostR", fmt(avgCost, 3), "gemiddelde over zichtbare 75-child rows")}
            ${metricCard("Avg DirectSL", fmtPct(avgDirectSL), "directSL hoort correct te tellen")}
            ${metricCard("Market regime", market.regime || "UNKNOWN",
market.ageText)}
            ${metricCard("Trend side", market.trendSide || "UNKNOWN", "CurrentFit is soft")}
            ${metricCard("UTC day type", temporalContext.dayType,
temporalContext.dayOfWeekUtc)}
            ${metricCard("UTC session", temporalContext.primarySessionBucket,
`${String(temporalContext.hourUtc).padStart(2, "0")}:00 UTC`)}
            ${metricCard("Temporal policy mode", temporalPolicy.temporalPolicyMode,
temporalPolicy.temporalStatsEnabled ? "stats actief" : "stats uitgeschakeld")}
            ${metricCard("Weekend default", temporalPolicy.weekendDefaultWouldBlock ? "BLOCK UNLESS APPROVED" : "NORMAL",
"Saturday/Sunday worden afzonderlijk per exacte family beoordeeld")}
            ${metricCard("Active generation", temporalGeneration?.generationId || "NONE",
temporalGeneration?.status || "geen generation-status")}
            ${metricCard("Generation cutoff", fmtTs(temporalGeneration?.generationCutoffTs),
`max age ${TEMPORAL_GENERATION_MAX_AGE_DAYS} dagen`)}
          </div>


          <div class="grid-3">
            <div class="card">
              <h3>Architectuurregels</h3>
              <div class="toolbar">
                   <span class="pill long">Learning breed</span>
                   <span class="pill info">Selection adaptief</span>
                   <span class="pill danger">Discord streng</span>
                   <span class="pill soft">CurrentFit soft</span>
              </div>
              <div class="metric-extra">
                   CurrentFit blokkeert geen virtual/shadow learning. Het beïnvloedt
ranking, rotation en Discord-eligibility.
              </div>
          </div>


          <div class="card">
              <h3>Meetlat</h3>
              ${jsonBlock({
                measurementFixVersion: MEASUREMENT_FIX_VERSION,
                previousMeasurementFixVersion: PREVIOUS_MEASUREMENT_FIX_VERSION,
                outcomeMeasurementGateMode: OUTCOME_MEASUREMENT_GATE_MODE,
                exitFillModelVersion: EXIT_FILL_MODEL_VERSION,
                empiricalVetoPolicyVersion: EMPIRICAL_VETO_POLICY_VERSION,
                completed: "closed virtual/shadow outcomes, exact current measurement only",
                scoring: "netR after costs",
                avgCostR: "costR",
                directSL: "directToSL/directSL/SL before meaningful favorable excursion",
                seen: "deduped unique observation key",
                rawWinrateRanking: "disabled",
                riskGeometryRule: "LONG: sl < entry < tp",
                grossRFormula: "(exitPrice - entry) / (entry - initialSl)",
                currentRFormula: "(currentPrice - entry) / (entry - initialSl)"
              })}
          </div>


          <div class="card">
              <h3>Weekend- en sessiebeleid</h3>
              ${jsonBlock({
                temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
                weekendPolicyVersion: WEEKEND_POLICY_VERSION,
                sessionPolicyVersion: SESSION_POLICY_VERSION,
                temporalPolicyMode: temporalPolicy.temporalPolicyMode,
                temporalStatsEnabled: temporalPolicy.temporalStatsEnabled,
                temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
                temporalGenerationSchemaVersion: TEMPORAL_GENERATION_SCHEMA_VERSION,
                currentTemporalContext: temporalContext,
                currentPolicy: temporalPolicy,
                activeGeneration: temporalGeneration,
                contextStats,
                sessionStats,
                familyIdentityIncludesTemporalBucket: false,
                primarySessionCounting: "één outcome telt één keer in één primaire bucket"
              })}
          </div>


          <div class="card">
              <h3>Identity</h3>
              ${jsonBlock({
                trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
                parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
                      selectionGranularity: "EXACT_75_CHILD",
                      discordMatch: "candidate.trueMicroFamilyId ===manuallySelected75ChildId",
                      parentMatchTriggersDiscord: false,
                      scannerFingerprintAsLearningFamily: false,
                      executionFingerprintAsLearningFamily: false,
                      currentFitPolarity: "BULLISH_POSITIVE_BEARISH_NEGATIVE",
                      temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
                      temporalPolicyMode: temporalPolicy.temporalPolicyMode,
                      temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
                      temporalGenerationSchemaVersion: TEMPORAL_GENERATION_SCHEMA_VERSION,
                      weekendDiscordEntryRule:
"BLOCK_SATURDAY_OR_SUNDAY_UNLESS_EXACT_FAMILY_DAY_APPROVED",
                      sessionDiscordEntryRule:
"ACTIVE_GENERATION_DAY_OR_SESSION_VETO_ONLY",
                      temporalBucketsAreSubprofilesOnly: true,
                      familyIdNeverContainsDaySessionOrSymbol: true,
                      exitPublicationTemporalBlocked: false
                 })}
               </div>
             </div>


             <div class="card">
               <h3>Overview raw</h3>
               ${jsonBlock(data)}
             </div>
        `;
    }


    async function renderMarket() {
        showLoading("market");


        const endpointUrl = marketApiUrl();
        const market = await fetchMarket();
        const outputData = market.raw || market;
        const outputJson = JSON.stringify(outputData ?? {}, null, 2);


        $("market").innerHTML = `
             <div class="section-title">
               <div>
                 <h2>marketWeather.js</h2>
                 <p>Bestand: <code>src/market/marketWeather.js</code> · API:
<code>/api/admin/market-weather</code></p>
               </div>
             </div>


             <div class="toolbar">
               <button type="button" class="primary" id="copyMarketOutputBtn">Copy API
output</button>
               <button type="button" id="copyMarketUrlBtn">Copy API URL</button>
               <button type="button" id="selectMarketOutputBtn">Select output</button>
          <button type="button" id="openMarketApiBtn">Open API</button>
          <button type="button" id="exportMarketBtn">Export JSON</button>
        </div>


        <div class="api-url-box">
          <strong>API URL:</strong>
          <code>${escapeHtml(endpointUrl)}</code>
        </div>


        <div class="grid">
          ${metricCard("Bestand", "marketWeather.js",
"src/market/marketWeather.js")}
          ${metricCard("API route", "/api/admin/market-weather", "admin output")}
          ${metricCard("Available", market.ok ? "YES" : "NO")}
          ${metricCard("Age", market.ageText || "-", fmtTs(market.createdAt))}
          ${metricCard("Regime", market.regime || "UNKNOWN")}
          ${metricCard("Trend side", market.trendSide || "UNKNOWN")}
          ${metricCard("Bearish breadth", market.bearishPct === null ? "-" :
`${fmt(market.bearishPct, 1)}%`)}
          ${metricCard("Bullish breadth", market.bullishPct === null ? "-" :
`${fmt(market.bullishPct, 1)}%`)}
          ${metricCard("Squeeze breadth", market.squeezePct === null ? "-" :
`${fmt(market.squeezePct, 1)}%`)}
          ${metricCard("Confidence", market.confidence === null ? "-" :
fmt(market.confidence, 1))}
        </div>


        <div class="card">
          <h3>CurrentFit policy</h3>
          <div class="toolbar">
            <span class="pill soft">soft gate</span>
            <span class="pill active">bullish positive</span>
            <span class="pill danger">bearish negative</span>
            <span class="pill info">ranking influence</span>
            <span class="pill danger">discord strict later</span>
          </div>
          <div class="metric-extra">
            MarketWeather is alleen context. Learning blijft gewoon doorlopen.
          </div>
        </div>


        <div class="card">
          <div class="api-output-head">
            <h3>API output — makkelijk kopiëren</h3>
            <button type="button" class="copy-big"
id="copyMarketOutputBtn2">Kopieer alles</button>
          </div>
               <textarea id="marketApiOutput" class="api-output-textarea"
readonly>${escapeHtml(outputJson)}</textarea>
             </div>
        `;


        function copyMarketOutput() {
             const box = $("marketApiOutput");
             copyText(box?.value || outputJson, "marketWeather.js API output volledig gekopieerd.");
        }


        $("copyMarketOutputBtn")?.addEventListener("click", copyMarketOutput);
        $("copyMarketOutputBtn2")?.addEventListener("click", copyMarketOutput);


        $("copyMarketUrlBtn")?.addEventListener("click", () => {
             copyText(endpointUrl, "marketWeather.js API URL gekopieerd.");
        });


        $("selectMarketOutputBtn")?.addEventListener("click", () => {
             const box = $("marketApiOutput");
             if (!box) return;


             box.focus();
             box.select();
             setMessage("API output geselecteerd. Je kunt nu kopiëren.", "ok");
        });


        $("openMarketApiBtn")?.addEventListener("click", () => {
             window.open(endpointUrl, "_blank", "noopener,noreferrer");
        });


        $("exportMarketBtn")?.addEventListener("click", () => {
             downloadJson("marketWeather.js-api-output.json", outputData);
        });
    }


    async function renderScanner() {
        showLoading("scanner");


        const data = await api(endpoints.scanner);
        state.scanner = data;


        const snapshot = data.snapshot || data.latest || {};
        const candidates = longRows(snapshot.candidates || data.candidates || []);


        $("scanner").innerHTML = `
        <div class="toolbar">
          <button type="button" class="primary" id="runScannerBtn">Run Scanner
now</button>
          <button type="button" id="copyScannerBtn">Copy JSON</button>
        </div>


        <div class="grid">
          ${metricCard("Snapshot ID", snapshot.snapshotId || data.snapshotId || "-")}
          ${metricCard("Age", ageText(snapshot.createdAt),
fmtTs(snapshot.createdAt))}
          ${metricCard("LONG candidates", fmtInt(candidates.length))}
          ${metricCard("Scanner gate", fmtInt(candidates.filter((row) =>
row.scannerGatePassed).length))}
          ${metricCard("Analyze-only", fmtInt(candidates.filter((row) =>
row.analyzeOnly || row.discoveryOnly || row.tradeDiscoveryOnly).length))}
          ${metricCard("Ignored SHORT", fmtInt(snapshot.rawShortCandidatesIgnored
|| data.rawOppositeCount || 0))}
          ${metricCard("Learning identity", "Analyze only")}
          ${metricCard("Scanner IDs", "metadata only")}
        </div>


        <div class="section-title">
          <div>
               <h2>Scanner LONG candidates</h2>
               <p>Scanner zoekt bullish coins. Scanner schrijft geen learning family,
geen trade, geen Discord.</p>
          </div>
        </div>


        <div class="coin-grid">
          ${candidates.slice(0, 12).map(coinCard).join("") || '<div class="empty">Geen LONG scanner candidates.</div>'}
        </div>


        ${table(candidates, [
          { label: "Symbol", render: (row) => escapeHtml(baseSymbol(row)) },
          { label: "Contract", render: (row) => escapeHtml(row.contractSymbol ||
`${baseSymbol(row)}USDT`) },
          { label: "Side", render: () => '<span class="pill long">LONG</span>' },
          { label: "Role", render: () => '<span class="pill raw">scanner metadata</span>' },
          { label: "Price", render: (row) => fmtPrice(row.price) },
          { label: "Score", render: (row) => fmt(row.scannerScore ??
row.moveScore, 2) },
          { label: "1h", render: (row) => fmtRawPct(row.change1h) },
          { label: "24h", render: (row) => fmtRawPct(row.change24h) },
               { label: "Vol24h", render: (row) => fmtMoney(row.volume24h ||
row.quoteVolume24h) },
               { label: "BTC", render: (row) => escapeHtml(row.btcState || "-") },
               { label: "Regime", render: (row) => escapeHtml(row.regime || "-") },
               { label: "Reason", render: (row) => escapeHtml(row.scannerReason ||
row.reason || "-") }
             ], "Geen LONG scanner candidates.")}
        `;


        $("runScannerBtn")?.addEventListener("click", runScannerNow);
        $("copyScannerBtn")?.addEventListener("click", () =>
copyText(JSON.stringify(data, null, 2), "Scanner JSON gekopieerd."));
    }


    async function runScannerNow() {
        try {
             const data = await api(endpoints.runScanner, {
               method: "POST",
               timeoutMs: 30000,
               body: JSON.stringify({
                 force: true,
                 forced: true,


                 targetTradeSide: ONLY_SIDE,
                 tradeSide: ONLY_SIDE,
                 side: DASHBOARD_SIDE,
                 scannerSide: DASHBOARD_SIDE,
                 direction: ONLY_SIDE,


                 longOnly: true,
                 shortDisabled: true,
                 disableShort: true,


                 scannerOnly: true,
                 scannerDecidesTrade: false,
                 scannerDoesNotTrade: true,
                 scannerDoesNotSelectMicroFamilies: true,
                 scannerDoesNotSendDiscord: true,


                 scannerFingerprintRole: "METADATA_ONLY",
                 scannerFingerprintsMetadataOnly: true,
                 scannerFingerprintsUsedAsLearningFamily: false,


                 noTradeExecution: true,
                 noDiscord: true,
                 noMicroFamilySelection: true,
                    persistentLearningKey: PERSISTENT_LEARNING_KEY,
                    redisNamespace: LONG_NAMESPACE,
                    redisKeyPrefix: LONG_KEY_PREFIX
               })
             });


             setMessage(`Scanner klaar. LONG candidates=${data.longCandidatesCount ||
data.candidatesCount || 0}`, "ok");
             await renderScanner();
         } catch (error) {
             setMessage(friendlyApiMessage(error), "warn");
         }
    }


    async function renderTrade() {
         showLoading("trade");


         const data = await api(endpoints.trade);
         state.trade = data;


         const positions = longRows(data.positions || data.openPositions ||
data.virtualPositions || []);
         const runMeta = data.runMeta || data.lastRunMeta || data.tradeMeta || {};


         $("trade").innerHTML = `
             <div class="toolbar">
               <button type="button" class="primary" id="runTradeBtn">Run TradeSystem
now</button>
               <button type="button" id="copyTradeBtn">Copy JSON</button>
             </div>


             <div class="grid">
               ${metricCard("Open virtual LONG", fmtInt(positions.length))}
               ${metricCard("Scanner/trade sync", data.scannerAndTradeInSync ? "YES" :
"NO")}
               ${metricCard("Last processed", data.lastProcessedSnapshotId ||
data.lastProcessed?.snapshotId || "-")}
               ${metricCard("Latest scanner", data.latestScannerSnapshotId || "-")}
               ${metricCard("Active 75-child IDs", fmtInt((data.activeMicroFamilyIds ||
[]).filter(idAllowedInLongOnly).length))}
               ${metricCard("Parent IDs", fmtInt((data.activeMacroFamilyIds ||
[]).filter(parentIdAllowedInLongOnly).length))}
               ${metricCard("Last run", fmtTs(runMeta.completedAt ||
runMeta.startedAt))}
               ${metricCard("Orders", "0", "exchange disabled")}
             </div>
        <div class="section-title">
          <div>
            <h2>Open virtual LONG positions</h2>
            <p>Risk moet zijn: tp &lt; entry &lt; sl. Exit: price &lt;= tp, price
&gt;= sl, of TIME_STOP.</p>
          </div>
        </div>


        <div class="coin-grid">
          ${positions.slice(0, 12).map(positionCard).join("") || '<div class="empty">Geen open virtual LONG posities.</div>'}
        </div>


        ${table(positions, [
          { label: "Symbol", render: (row) => escapeHtml(baseSymbol(row)) },
          { label: "Source", render: () => '<span class="pill purple">VIRTUAL</span>' },
          { label: "Side", render: () => '<span class="pill long">LONG</span>' },
          { label: "Entry", render: (row) => fmtPrice(row.entry) },
          { label: "SL", render: (row) => fmtPrice(row.sl || row.stopLoss) },
          { label: "TP", render: (row) => fmtPrice(row.tp || row.takeProfit) },
          { label: "RR", render: (row) => fmt(row.rr, 2) },
          { label: "CurrentR", render: (row) => fmt(row.currentR ??
row.longCurrentR, 3) },
          { label: "MFE", render: (row) => fmt(row.mfeR, 3) },
          { label: "MAE", render: (row) => fmt(row.maeR, 3) },
          { label: "CostR", render: (row) => fmt(row.costR || row.avgCostR, 3) },
          { label: "DirectSL", render: (row) => row.directSL || row.directToSL ?
'<span class="pill danger">YES</span>' : '<span class="pill active">NO</span>' },
          { label: "CurrentFit", render: (row) => currentFitPill(row) },
          { label: "Exit flags", render: (row) => `
            ${row.tpHitNow || row.tpExitArmed || row.longTpHit ? '<span class="pill active">TP</span>' : ""}
            ${row.slHitNow || row.slExitArmed || row.longSlHit ? '<span class="pill danger">SL</span>' : ""}
            ${row.timeStopHitNow || row.timeStopExitArmed ? '<span class="pill warn">TIME</span>' : ""}
          ` || "-" },
          { label: "75-child true micro", render: (row) =>
`<code>${escapeHtml(microId(row) || "NO_75_CHILD")}</code>` },
          { label: "Parent 15", render: (row) =>
`<code>${escapeHtml(parentMicroId(row) || "NO_PARENT")}</code>` },
          { label: "Opened", render: (row) => fmtTs(row.openedAt || row.createdAt)
}
        ], "Geen open virtual LONG posities.")}


        <div class="card">
               <h3>Run meta</h3>
               ${jsonBlock(runMeta)}
             </div>
        `;


        $("runTradeBtn")?.addEventListener("click", runTradeNow);
        $("copyTradeBtn")?.addEventListener("click", () =>
copyText(JSON.stringify(data, null, 2), "Trade JSON gekopieerd."));
    }


    async function runTradeNow() {
        try {
             const data = await api(endpoints.runTrade, {
               method: "POST",
               timeoutMs: 30000,
               body: JSON.stringify({
                 force: true,
                 forced: true,
                 forceProcessSnapshot: true,


                 monitorOpenPositionsFirst: true,
                 monitorOpenPositions: true,
                 processScannerSnapshot: true,


                 targetTradeSide: ONLY_SIDE,
                 tradeSide: ONLY_SIDE,
                 side: DASHBOARD_SIDE,
                 positionSide: ONLY_SIDE,
                 direction: ONLY_SIDE,


                 longOnly: true,
                 shortDisabled: true,
                 disableShort: true,


                 virtualOnly: true,
                 virtualTracked: true,
                 source: "VIRTUAL",
                 outcomeSource: "VIRTUAL",


                 realOrdersDisabled: true,
                 exchangeOrdersDisabled: true,
                 bitgetOrdersDisabled: true,
                 noExchangeOrders: true,
                 noRealOrders: true,


                 allowLearningWithoutActiveRotation: true,
                 ignoreMaxOpenPositionsForLearning: true,
            ignoreGlobalMaxOpenPositions: true,
            oneOpenPositionPerSymbol: true,
            maxOneOpenPositionPerSymbol: true,


            trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
            parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
            learningGranularity: LEARNING_GRANULARITY,
            parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
            selectionGranularity: "EXACT_75_CHILD",


            completedDefinition:
"CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES_CURRENT_MEASUREMENT_ONLY",
            scoringRSource: "netR",
            winsLossesFlatsSource: "netR",
            avgCostRSource: "costR",
            seenDefinition: "UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY",
            measurementFixVersion: MEASUREMENT_FIX_VERSION,
            outcomeMeasurementVersion: MEASUREMENT_FIX_VERSION,
            acceptedOutcomeMeasurementVersion: MEASUREMENT_FIX_VERSION,
            outcomeMeasurementGateMode: OUTCOME_MEASUREMENT_GATE_MODE,
            strictOutcomeMeasurementGate: true,
            exitFillModelVersion: EXIT_FILL_MODEL_VERSION,
            exitFillPolicy:
"TP_SL_USE_TRIGGER_BOUNDARY_TIME_STOP_USES_OBSERVED_PRICE",
            empiricalVetoPolicyVersion: EMPIRICAL_VETO_POLICY_VERSION,
            empiricalVetoMinCompleted: EMPIRICAL_VETO_MIN_COMPLETED,
            empiricalVetoMaxAvgR: EMPIRICAL_VETO_MAX_AVG_R,


            currentFitVersion: CURRENT_FIT_VERSION,
            currentFitPolarity: "BULLISH_POSITIVE_BEARISH_NEGATIVE",
            currentFitDefinition: "LONG_MIRRORED_CURRENT_FIT",
            currentFitSoftOnly: true,
            currentFitBlocksLearning: false,
            currentFitBlocksVirtualLearning: false,
            currentFitBlocksShadowLearning: false,


            longRiskShape: {
                 expression: "sl < entry < tp"
            },
            riskGeometryRule: "LONG: sl < entry < tp",
            tpHitRule: "LONG: price >= tp",
            slHitRule: "LONG: price <= sl",
            grossRFormula: "(exitPrice - entry) / (entry - initialSl)",
            currentRFormula: "(currentPrice - entry) / (entry - initialSl)",


            discordOnlyForSelectedMicroFamilies: true,
            discordOnlyForExactTrueMicroMatch: true,
                      discordRequiresCurrentFit: true,
                      macroMatchDoesNotTriggerDiscord: true,
                      parentMacroMatchDoesNotTriggerDiscord: true,


                      persistentLearningKey: PERSISTENT_LEARNING_KEY,
                      redisNamespace: LONG_NAMESPACE,
                      redisKeyPrefix: LONG_KEY_PREFIX
                 })
            });


            const counts = data.counts || {};
            setMessage(
                 `TradeSystem klaar.\nEntries=${counts.entries || data.entryRows || 0},
waits=${counts.waits || data.waitRows || 0}, virtualExits=${counts.virtualExits ||
data.virtualExitRows || 0}.`,
                 "ok"
            );


            await renderTrade();
        } catch (error) {
            setMessage(friendlyApiMessage(error), "warn");
        }
    }


    function manualCard(row) {
        if (!row) {
            return `
                 <div class="manual-card">
                      <h3>Manual Discord selection</h3>
                      <div class="empty">Geen geldige LONG 75-child micro-family
beschikbaar. Laat scanner + TradeSystem eerst Analyze rows schrijven.</div>
                 </div>
            `;
        }


        const id = microId(row);
        const parentId = parentMicroId(row);
        const isActive = activeMicroIds().includes(id);
        const selectable = discordSelectionAllowed(row);
        const selectionReason = selectable ? "" : discordSelectionBlockReason(row);


        return `
            <div class="manual-card">
                 <h3>Beste zichtbare LONG 75-child true micro</h3>


                 <div class="toolbar">
                      <span class="pill long">LONG</span>
            <span class="pill dark">75-child exact</span>
            ${isActive ? '<span class="pill active">DISCORD ACTIVE</span>' :
'<span class="pill info">NOT SELECTED</span>'}
            ${tierPill(tier(row))}
            ${statusPill(row)}
            ${activationGatePill(row)}
            ${currentFitPill(row)}
            ${tooEarly(row) ? `<span class="pill
warn">${escapeHtml(fmt(completed(row), 0))}/${MIN_COMPLETED_ACTIVE_LEARNING}
</span>` : ""}
          </div>


          <div>
            <div class="metric-extra">Selectable trueMicroFamilyId</div>
            <code>${escapeHtml(id || "NO_75_CHILD_ID")}</code>
          </div>


          <div style="margin-top:8px">
            <div class="metric-extra">Parent 15 context</div>
            <code>${escapeHtml(parentId || "NO_PARENT_ID")}</code>
          </div>


          <div class="manual-grid">
            <div class="manual-stat"><span>Seen</span>
<strong>${escapeHtml(fmt(observationSample(row), 2))}</strong></div>
            <div class="manual-stat"><span>Completed</span>
<strong>${escapeHtml(fmt(completed(row), 2))}</strong></div>
            <div class="manual-stat"><span>Status</span>
<strong>${escapeHtml(learningStatus(row))}</strong></div>
            <div class="manual-stat"><span>Activation gate</span>
<strong>${escapeHtml(activationGateStatus(row))}</strong></div>
            <div class="manual-stat"><span>Sample</span><strong>${tooEarly(row) ?
`TE VROEG ${fmt(completed(row), 0)}/${MIN_COMPLETED_ACTIVE_LEARNING}` : "OK"}
</strong></div>
            <div class="manual-stat"><span>Fair WR</span>
<strong>${escapeHtml(fmtPct(row.fairWinrate ?? row.sampleAdjustedWinrate))}
</strong></div>
            <div class="manual-stat"><span>Net TotalR</span>
<strong>${escapeHtml(fmt(row.totalR, 3))}</strong></div>
            <div class="manual-stat"><span>AvgCostR</span>
<strong>${escapeHtml(fmt(avgCostR(row), 3))}</strong></div>
            <div class="manual-stat"><span>DirectSL</span>
<strong>${escapeHtml(fmtPct(directSLPct(row)))}</strong></div>
            <div class="manual-stat"><span>CurrentFit</span>
<strong>${escapeHtml(currentFit(row))}</strong></div>
            <div class="manual-stat"><span>FitScore</span>
<strong>${escapeHtml(fmt(currentFitScore(row), 1))}</strong></div>
                    <div class="manual-stat"><span>Momentum</span>
<strong>${escapeHtml(fmt(recentMomentumScore(row), 1))}</strong></div>
                    <div class="manual-stat"><span>Adaptive</span>
<strong>${escapeHtml(fmt(adaptiveScore(row), 2))}</strong></div>
                  </div>


                  <div class="metric-extra">
                    Discord wordt alleen actief voor exact deze 75-child
trueMicroFamilyId.
                    Parent 15, macro, scanner buckets, coinnaam en fingerprints mogen
nooit Discord-match zijn.
                    CurrentFit blijft soft voor learning, maar Discord mag streng
blokkeren.
                  </div>


                  <div class="toolbar">
                    <button type="button" class="long-action" data-activate-
one="${escapeAttr(id)}" title="${escapeAttr(selectionReason)}" ${selectable ? "" :
"disabled"}>Select exact 75-child</button>
                    <button type="button" data-copy="${escapeAttr(id)}"
${isSelectableTrueMicroId(id) ? "" : "disabled"}>Copy</button>
                  </div>
             </div>
        `;
    }



    function winnerDayLabel(day) {
        return ({
             MONDAY: "Maandag",
             TUESDAY: "Dinsdag",
             WEDNESDAY: "Woensdag",
             THURSDAY: "Donderdag",
             FRIDAY: "Vrijdag",
             SATURDAY: "Zaterdag",
             SUNDAY: "Zondag"
        })[upper(day)] || String(day || "Onbekend");
    }


    function winnerDayShort(day) {
        return ({
             MONDAY: "MA",
             TUESDAY: "DI",
             WEDNESDAY: "WO",
             THURSDAY: "DO",
             FRIDAY: "VR",
             SATURDAY: "ZA",
             SUNDAY: "ZO"
        })[upper(day)] || "?";
    }


    function winnerSessionLabel(session) {
        return ({
             ASIA: "Asia",
             ASIA_EU_OVERLAP: "Asia + Europa",
             EUROPE: "Europa",
             EU_US_OVERLAP: "Europa + US",
             US: "US",
             OFF_HOURS: "Buiten sessies"
        })[upper(session)] || String(session || "Onbekend");
    }


    function winnerSessionShort(session) {
        return ({
             ASIA: "ASIA",
             ASIA_EU_OVERLAP: "AS/EU",
             EUROPE: "EU",
             EU_US_OVERLAP: "EU/US",
             US: "US",
             OFF_HOURS: "OFF"
        })[upper(session)] || "?";
    }


    function activeTemporalGenerationFromState() {
        return temporalGenerationFromPayload(state.rotation || {}) ||
             temporalGenerationFromPayload(state.micros || {}) ||
             null;
    }


    function temporalProjectionMap(generation = activeTemporalGenerationFromState()) {
        const projections = Array.isArray(generation?.familyProjections)
             ? generation.familyProjections
             : [];
        return new Map(
             projections
               .map((projection) => [
                    String(
                         projection.familyId ||
                         projection.trueMicroFamilyId ||
                         projection.childTrueMicroFamilyId ||
                         ""
                    ).trim(),
                    projection
               ])
               .filter(([id]) => idAllowedInLongOnly(id))
        );
    }


    function temporalGateStats(profile = {}) {
        const source = profile?.gateWindow || profile?.windowStats || profile?.stats || {};
        return {
             completed: Math.max(0, num(source.completed, 0)),
             observations: Math.max(0, num(source.observations, source.completed || 0)),
             wins: Math.max(0, num(source.wins, 0)),
             losses: Math.max(0, num(source.losses, 0)),
             flats: Math.max(0, num(source.flats, 0)),
             avgNetR: firstFinite(source.avgNetR, source.avgR, source.averageNetR, 0) ?? 0,
             sumNetR: firstFinite(source.sumNetR, source.totalR, 0) ?? 0,
             lcb95: firstFinite(source.lcb95, source.oneSidedLcb95, source.lowerConfidenceBound),
             ucb95: firstFinite(source.ucb95, source.oneSidedUcb95, source.upperConfidenceBound),
             winrate: firstFinite(source.winrate, source.winRate, source.fairWinrate),
             qValue: firstFinite(
                  profile?.negativeTest?.qValue,
                  profile?.positiveTest?.qValue,
                  profile?.recoveryTest?.qValue,
                  source.qValue
             )
        };
    }


    function temporalProfileDecision(profile = {}) {
        return upper(
             profile?.activeDecision ||
             profile?.decision ||
             profile?.evaluationStatus ||
             "INHERIT_GLOBAL"
        );
    }


    function temporalProfileVisualState(profile = {}) {
        if (!profile || typeof profile !== "object") return "unknown";
        const decision = temporalProfileDecision(profile);
        const stats = temporalGateStats(profile);

        if (decision === "VETO_ACTIVE") return "blocked";
        if (decision.includes("CONFOUNDED")) return "confounded";
        if (stats.completed <= 0) return "unknown";
        if (stats.completed < EMPIRICAL_VETO_MIN_COMPLETED) return "learning";
        if (stats.avgNetR >= 0.05 && stats.lcb95 !== null && stats.lcb95 > 0) {
             return "proven";
        }
        if (stats.avgNetR > 0) return "positive";
        if (stats.avgNetR <= -0.10 && stats.ucb95 !== null && stats.ucb95 < 0) {
             return "negative";
        }
        return "neutral";
    }


    function temporalStateLabel(stateName) {
        return ({
             proven: "BEWEZEN",
             positive: "POSITIEF",
             learning: "LEREN",
             blocked: "VETO",
             negative: "NEGATIEF",
             confounded: "ONZEKER",
             neutral: "NEUTRAAL",
             unknown: "GEEN DATA"
        })[stateName] || "ONBEKEND";
    }


    function temporalProfileTitle(profile = {}, label = "") {
        const stats = temporalGateStats(profile);
        const decision = temporalProfileDecision(profile);
        return [
             label,
             `status=${decision}`,
             `n=${fmtInt(stats.completed)}`,
             `avg=${fmt(stats.avgNetR, 3)}R`,
             `LCB95=${stats.lcb95 === null ? "-" : `${fmt(stats.lcb95, 3)}R`}`,
             `UCB95=${stats.ucb95 === null ? "-" : `${fmt(stats.ucb95, 3)}R`}`,
             `q=${stats.qValue === null ? "-" : fmt(stats.qValue, 4)}`
        ].join(" · ");
    }


    function temporalChip(profile, label, fullLabel = label) {
        const visual = temporalProfileVisualState(profile);
        return `<span class="temporal-chip ${escapeAttr(visual)}" title="${escapeAttr(
             temporalProfileTitle(profile, fullLabel)
        )}">${escapeHtml(label)}</span>`;
    }


    function temporalProfileBox(profile, title) {
        const stats = temporalGateStats(profile);
        const visual = temporalProfileVisualState(profile);
        return `
             <div class="temporal-profile-box">
               <strong>${temporalChip(profile, temporalStateLabel(visual), title)}</strong>
               <div class="temporal-profile-meta">
                 ${escapeHtml(title)}<br />
                 n=${escapeHtml(fmtInt(stats.completed))} · avg=${escapeHtml(fmt(stats.avgNetR, 3))}R<br />
                 LCB95=${escapeHtml(stats.lcb95 === null ? "-" : fmt(stats.lcb95, 3))}R
               </div>
             </div>
        `;
    }


    function weekendApproval(projection = {}, day = "") {
        return projection?.weekendApprovals?.[upper(day)] || null;
    }


    function weekendApproved(projection = {}, day = "") {
        if (!["SATURDAY", "SUNDAY"].includes(upper(day))) return true;
        return upper(weekendApproval(projection, day)?.approvalStatus) === "WEEKEND_APPROVED";
    }


    function weekendApprovalPill(projection = {}, day = "") {
        const normalizedDay = upper(day);
        if (!["SATURDAY", "SUNDAY"].includes(normalizedDay)) {
             return '<span class="pill neutral">Niet van toepassing</span>';
        }
        const profile = weekendApproval(projection, normalizedDay);
        const status = upper(profile?.approvalStatus || "NO_APPROVAL");
        const approved = status === "WEEKEND_APPROVED";
        const stats = temporalGateStats(profile);
        return `<span class="pill ${approved ? "passed" : "blocked"}" title="${escapeAttr(
             `${winnerDayLabel(normalizedDay)} · n=${fmtInt(stats.completed)} · avg=${fmt(stats.avgNetR, 3)}R`
        )}">${approved ? "WEEKEND APPROVED" : "GEEN APPROVAL"}</span>`;
    }


    function selectedWinnerContext() {
        const current = buildTemporalContext(Date.now());
        return {
             current,
             day: state.winnerDay === "CURRENT" ? current.dayOfWeekUtc : upper(state.winnerDay),
             session: state.winnerSession === "CURRENT"
               ? current.primarySessionBucket
               : upper(state.winnerSession)
        };
    }


    function profilePassesPositive(profile, { strict = false } = {}) {
        const stats = temporalGateStats(profile);
        if (temporalProfileDecision(profile) === "VETO_ACTIVE") return false;
        if (strict) {
             return stats.completed >= EMPIRICAL_VETO_MIN_COMPLETED &&
                  stats.avgNetR >= 0.05 &&
                  stats.lcb95 !== null &&
                  stats.lcb95 > 0;
        }
        return stats.completed >= MIN_COMPLETED_ACTIVE_LEARNING && stats.avgNetR > 0;
    }


    function winnerEligibility(row = {}, projection = null, context = selectedWinnerContext()) {
        const reasons = [];
        const globallyAllowed = discordSelectionAllowed(row);
        const fit = currentFit(row);
        const dayProfile = projection?.dayProfiles?.[context.day] || null;
        const sessionProfile = projection?.sessionProfiles?.[context.session] || null;
        const dayDecision = temporalProfileDecision(dayProfile);
        const sessionDecision = temporalProfileDecision(sessionProfile);

        if (!globallyAllowed) reasons.push(discordSelectionBlockReason(row));
        if (!projection) reasons.push("GEEN_TEMPORAL_PROJECTION");
        if (dayDecision === "VETO_ACTIVE") reasons.push(`DAG_VETO:${context.day}`);
        if (sessionDecision === "VETO_ACTIVE") reasons.push(`SESSIE_VETO:${context.session}`);
        if (!weekendApproved(projection || {}, context.day)) {
             reasons.push(`WEEKEND_NIET_GOEDGEKEURD:${context.day}`);
        }
        if (state.winnerOnlyCurrentFit && fit === "MISFIT") reasons.push("CURRENTFIT_MISFIT");

        let presetPassed = false;
        if (state.winnerPreset === "STRICT_PROVEN") {
             presetPassed = globallyAllowed &&
                  Boolean(projection) &&
                  profilePassesPositive(dayProfile, { strict: true }) &&
                  profilePassesPositive(sessionProfile, { strict: true }) &&
                  weekendApproved(projection, context.day) &&
                  (!state.winnerOnlyCurrentFit || fit !== "MISFIT");
             if (!profilePassesPositive(dayProfile, { strict: true })) reasons.push("DAG_NIET_BEWEZEN_POSITIEF");
             if (!profilePassesPositive(sessionProfile, { strict: true })) reasons.push("SESSIE_NIET_BEWEZEN_POSITIEF");
        } else if (state.winnerPreset === "BALANCED_POSITIVE") {
             presetPassed = globallyAllowed &&
                  Boolean(projection) &&
                  profilePassesPositive(dayProfile) &&
                  profilePassesPositive(sessionProfile) &&
                  weekendApproved(projection, context.day) &&
                  (!state.winnerOnlyCurrentFit || fit !== "MISFIT");
             if (!profilePassesPositive(dayProfile)) reasons.push("DAG_NOG_NIET_POSITIEF");
             if (!profilePassesPositive(sessionProfile)) reasons.push("SESSIE_NOG_NIET_POSITIEF");
        } else {
             presetPassed = globallyAllowed &&
                  Boolean(projection) &&
                  dayDecision !== "VETO_ACTIVE" &&
                  sessionDecision !== "VETO_ACTIVE" &&
                  weekendApproved(projection, context.day) &&
                  (!state.winnerOnlyCurrentFit || fit !== "MISFIT");
        }

        return {
             passed: presetPassed,
             globallyAllowed,
             projectionFound: Boolean(projection),
             fit,
             dayProfile,
             sessionProfile,
             reasons: uniqueStrings(reasons),
             context
        };
    }


    function winnerVerdict(eligibility = {}) {
        if (eligibility.passed && state.winnerPreset === "STRICT_PROVEN") {
             return { key: "proven", label: "BEWEZEN WINNAAR" };
        }
        if (eligibility.passed && state.winnerPreset === "BALANCED_POSITIVE") {
             return { key: "positive", label: "POSITIEF" };
        }
        if (eligibility.passed) {
             return { key: "selectable", label: "SELECTEERBAAR" };
        }
        if (eligibility.reasons.some((reason) => reason.includes("VETO") || reason.includes("NIET_GOEDGEKEURD"))) {
             return { key: "blocked", label: "GEBLOKKEERD" };
        }
        if (eligibility.reasons.some((reason) => reason.includes("NIET_BEWEZEN") || reason.includes("NOG_NIET"))) {
             return { key: "learning", label: "NOG LEREN" };
        }
        return { key: "unknown", label: "NIET SELECTEERBAAR" };
    }


    function winnerScore(row = {}, eligibility = {}) {
        const dayStats = temporalGateStats(eligibility.dayProfile);
        const sessionStats = temporalGateStats(eligibility.sessionProfile);
        return (
             (eligibility.passed ? 1_000_000 : 0) +
             adaptiveScore(row) * 100 +
             netAvgR(row) * 1_000 +
             Math.min(completed(row), 100) * 10 +
             dayStats.avgNetR * 2_000 +
             sessionStats.avgNetR * 2_000 +
             Math.min(dayStats.completed, 50) * 5 +
             Math.min(sessionStats.completed, 50) * 5 +
             currentFitScore(row)
        );
    }


    function workingDayChips(projection = {}) {
        return `<div class="temporal-chip-grid">${WINNER_DAY_OPTIONS.map((day) =>
             temporalChip(projection?.dayProfiles?.[day], winnerDayShort(day), winnerDayLabel(day))
        ).join("")}</div>`;
    }


    function workingSessionChips(projection = {}) {
        return `<div class="temporal-chip-grid">${WINNER_SESSION_OPTIONS.map((session) =>
             temporalChip(
                  projection?.sessionProfiles?.[session],
                  winnerSessionShort(session),
                  winnerSessionLabel(session)
             )
        ).join("")}</div>`;
    }


    function winnerSelectedSet() {
        return new Set(uniqueStrings(state.winnerSelectedIds).filter(idAllowedInLongOnly));
    }


    function setWinnerSelectedIds(ids = []) {
        state.winnerSelectedIds = uniqueStrings(ids).filter(idAllowedInLongOnly);
    }


    function winnerRowsForDisplay(rows = [], projectionMap = new Map(), context = selectedWinnerContext()) {
        const search = state.winnerSearch.trim().toLowerCase();
        return rows
             .map((row) => {
                  const projection = projectionMap.get(microId(row)) || null;
                  const eligibility = winnerEligibility(row, projection, context);
                  return {
                       row,
                       projection,
                       eligibility,
                       score: winnerScore(row, eligibility)
                  };
             })
             .filter((item) => {
                  if (!search) return true;
                  return JSON.stringify({ row: item.row, projection: item.projection })
                       .toLowerCase()
                       .includes(search);
             })
             .filter((item) => state.winnerShowAll || item.eligibility.passed)
             .sort((a, b) => b.score - a.score);
    }


    function winnerTable(items = [], context = selectedWinnerContext()) {
        if (!items.length) {
             return `<div class="empty">Geen families voldoen aan deze combinatie. Kies eventueel “Positief en bruikbaar” of zet “toon ook afgevallen families” aan.</div>`;
        }
        const selected = winnerSelectedSet();
        const activeSet = new Set(activeMicroIds());
        const desktopRows = items.map((item, index) => {
             const { row, projection, eligibility } = item;
             const id = microId(row);
             const verdict = winnerVerdict(eligibility);
             const checked = selected.has(id);
             return `
               <tr>
                 <td><input type="checkbox" data-winner-select="${escapeAttr(id)}" ${checked ? "checked" : ""} ${eligibility.passed ? "" : "disabled"} /></td>
                 <td><strong>${escapeHtml(index + 1)}</strong></td>
                 <td><span class="winner-verdict ${escapeAttr(verdict.key)}">${escapeHtml(verdict.label)}</span></td>
                 <td><span class="pill ${activeSet.has(id) ? "active" : "neutral"}">${activeSet.has(id) ? "ACTIVE" : "OFF"}</span></td>
                 <td class="winner-family-cell">
                   <button class="small" type="button" data-open-micro="${escapeAttr(id)}"><code>${escapeHtml(id)}</code></button>
                 </td>
                 <td>${activationGatePill(row)}</td>
                 <td>${currentFitPill(row)}</td>
                 <td>n=${escapeHtml(fmtInt(completed(row)))}<br />avg=${escapeHtml(fmt(netAvgR(row), 3))}R<br />WR=${escapeHtml(fmtPct(row.fairWinrate ?? row.sampleAdjustedWinrate))}</td>
                 <td>${temporalProfileBox(eligibility.dayProfile, winnerDayLabel(context.day))}</td>
                 <td>${temporalProfileBox(eligibility.sessionProfile, winnerSessionLabel(context.session))}</td>
                 <td>${weekendApprovalPill(projection, context.day)}</td>
                 <td>${workingDayChips(projection)}</td>
                 <td>${workingSessionChips(projection)}</td>
                 <td>${escapeHtml(eligibility.reasons.join(" · ") || "OK")}</td>
               </tr>
             `;
        }).join("");

        const mobileCards = items.map((item, index) => {
             const { row, projection, eligibility } = item;
             const id = microId(row);
             const verdict = winnerVerdict(eligibility);
             const checked = selected.has(id);
             return `
               <article class="micro-card winner-card ${escapeAttr(verdict.key)}">
                 <div class="micro-card-top">
                   <div>
                     <div class="micro-card-title">#${escapeHtml(index + 1)}</div>
                     <span class="winner-verdict ${escapeAttr(verdict.key)}">${escapeHtml(verdict.label)}</span>
                   </div>
                   <label class="winner-check">
                     <input type="checkbox" data-winner-select="${escapeAttr(id)}" ${checked ? "checked" : ""} ${eligibility.passed ? "" : "disabled"} /> Selecteer
                   </label>
                 </div>
                 <button class="micro-id-button" type="button" data-open-micro="${escapeAttr(id)}"><code>${escapeHtml(id)}</code></button>
                 <div class="toolbar">${activationGatePill(row)} ${currentFitPill(row)} ${weekendApprovalPill(projection, context.day)}</div>
                 <div class="winner-context-title"><strong>Gekozen dag:</strong> ${temporalProfileBox(eligibility.dayProfile, winnerDayLabel(context.day))}</div>
                 <div class="winner-context-title"><strong>Gekozen sessie:</strong> ${temporalProfileBox(eligibility.sessionProfile, winnerSessionLabel(context.session))}</div>
                 <div class="metric-extra">Werkende dagen</div>
                 ${workingDayChips(projection)}
                 <div class="metric-extra" style="margin-top:10px">Werkende sessies</div>
                 ${workingSessionChips(projection)}
                 <div class="metric-extra" style="margin-top:10px">${escapeHtml(eligibility.reasons.join(" · ") || "Alles is groen voor deze keuze.")}</div>
               </article>
             `;
        }).join("");

        return `
          <div class="table-wrap winner-table">
            <table>
              <thead>
                <tr>
                  <th>Select</th>
                  <th>Rank</th>
                  <th>Uitkomst</th>
                  <th>Discord</th>
                  <th>Exacte 75-child family</th>
                  <th>Global gate</th>
                  <th>CurrentFit</th>
                  <th>Globaal</th>
                  <th>${escapeHtml(winnerDayLabel(context.day))}</th>
                  <th>${escapeHtml(winnerSessionLabel(context.session))}</th>
                  <th>Weekend</th>
                  <th>Alle dagen</th>
                  <th>Alle sessies</th>
                  <th>Waarom</th>
                </tr>
              </thead>
              <tbody>${desktopRows}</tbody>
            </table>
          </div>
          <div class="winner-mobile-cards">${mobileCards}</div>
        `;
    }


    async function ensureRotationLoaded() {
        if (state.rotation) return state.rotation;
        state.rotation = await api(rotationApiUrl(), { timeoutMs: 22000 });
        return state.rotation;
    }


    function compositionWeatherLabel(value = "UNKNOWN") {
        const labels = {
          "TREND|LONG": "Trend omhoog",
          "TREND|NEUTRAL": "Trend neutraal",
          "TREND|SHORT": "Trend omlaag",
          "CHOP|LONG": "Chop bullish",
          "CHOP|NEUTRAL": "Chop neutraal",
          "CHOP|SHORT": "Chop bearish",
          "SQUEEZE|LONG": "Squeeze bullish",
          "SQUEEZE|NEUTRAL": "Squeeze neutraal",
          "SQUEEZE|SHORT": "Squeeze bearish",
          UNKNOWN: "Onbekend"
        };
        return labels[upper(value)] || String(value || "UNKNOWN");
    }

    function compositionDayLabel(day) {
        return winnerDayLabel(day);
    }

    function compositionHourLabel(hourBucket = "H00") {
        const hour = Number(String(hourBucket).replace(/^H/i, ""));
        if (!Number.isFinite(hour)) return String(hourBucket || "-");
        return `${String(hour).padStart(2, "0")}:00–${String((hour + 1) % 24).padStart(2, "0")}:00`;
    }

    function compositionBtcLabel(stateValue = "UNKNOWN") {
        const labels = {
          STRONG_BULLISH: "BTC sterk bullish",
          BULLISH: "BTC bullish",
          NEUTRAL: "BTC neutraal",
          BEARISH: "BTC bearish",
          STRONG_BEARISH: "BTC sterk bearish",
          UNKNOWN: "BTC onbekend"
        };
        return labels[upper(stateValue)] || String(stateValue || "UNKNOWN");
    }

    function compositionSlotKey(day, hourBucket, weatherKey, btcState = state.compositionSelectedBtc) {
        return `${upper(day)}:${upper(hourBucket)}|${upper(weatherKey)}|BTC:${upper(btcState)}`;
    }

    function parseCompositionSlotKey(value = "") {
        const raw = upper(value);
        const btcMarker = raw.lastIndexOf("|BTC:");
        const withoutBtc = btcMarker >= 0 ? raw.slice(0, btcMarker) : raw;
        const btcState = btcMarker >= 0 ? raw.slice(btcMarker + 5) : "UNKNOWN";
        const firstPipe = withoutBtc.indexOf("|");
        const dayHour = firstPipe >= 0 ? withoutBtc.slice(0, firstPipe) : withoutBtc;
        const weatherKey = firstPipe >= 0 ? withoutBtc.slice(firstPipe + 1) : "UNKNOWN";
        const [day, hourBucket] = dayHour.split(":");
        return { day, hourBucket, weatherKey, btcState };
    }

    function compositionWeatherBtcKey(weatherKey, btcState) {
        return `${upper(weatherKey)}|BTC:${upper(btcState)}`;
    }

    function compositionUnique(values = []) {
        return [...new Set((Array.isArray(values) ? values : [values])
          .map((value) => upper(value))
          .filter(Boolean))];
    }

    function compositionOverrides() {
        return {
          disabledDays: compositionUnique(state.compositionDisabledDays),
          disabledHours: compositionUnique(state.compositionDisabledHours),
          disabledWeatherKeys: compositionUnique(state.compositionDisabledWeatherKeys),
          disabledBtcStates: compositionUnique(state.compositionDisabledBtcStates),
          disabledWeatherBtcKeys: compositionUnique(state.compositionDisabledWeatherBtcKeys),
          disabledDayHours: compositionUnique(state.compositionDisabledDayHours),
          disabledSlotWeatherKeys: compositionUnique(state.compositionDisabledSlotWeatherKeys),
          disabledDayHourWeatherBtcKeys: compositionUnique(
            state.compositionDisabledDayHourWeatherBtcKeys
          )
        };
    }

    function setCompositionOverride(field, value, disabled) {
        const current = new Set(compositionUnique(state[field] || []));
        const normalized = upper(value);
        if (disabled) current.add(normalized);
        else current.delete(normalized);
        state[field] = [...current];
    }

    function compositionProposalList(rotation = state.rotation || {}) {
        const candidates = [
          rotation.weekCompositionProposals,
          rotation.dashboard?.weekCompositionProposals,
          rotation.dashboard?.activeTemporalGeneration?.weekCompositionProposals,
          rotation.activeTemporalGeneration?.weekCompositionProposals
        ];
        return candidates.find(Array.isArray) || [];
    }

    function activeWeekComposition(rotation = state.rotation || {}) {
        return rotation.activeWeekComposition ||
          rotation.dashboard?.activeWeekComposition ||
          rotation.active?.activeWeekComposition ||
          null;
    }

    function compositionProposalByMode(proposals = [], mode = state.compositionSelectedMode) {
        return proposals.find((proposal) => upper(proposal?.mode) === upper(mode)) || proposals[0] || null;
    }

    function hydrateCompositionOverrides(proposal, active) {
        if (!proposal) return;
        const sameBase = active && (
          active.baseCompositionId === proposal.baseCompositionId ||
          active.baseCompositionId === proposal.compositionId ||
          (active.generationId === proposal.generationId && upper(active.mode) === upper(proposal.mode))
        );
        const sourceId = sameBase ? active.compositionId : proposal.compositionId;
        if (state.compositionOverridesSourceId === sourceId) return;
        const source = sameBase ? (active.overrides || {}) : {};
        state.compositionDisabledDays = compositionUnique(source.disabledDays || []);
        state.compositionDisabledHours = compositionUnique(source.disabledHours || []);
        state.compositionDisabledWeatherKeys = compositionUnique(source.disabledWeatherKeys || []);
        state.compositionDisabledBtcStates = compositionUnique(source.disabledBtcStates || []);
        state.compositionDisabledWeatherBtcKeys = compositionUnique(source.disabledWeatherBtcKeys || []);
        state.compositionDisabledDayHours = compositionUnique(source.disabledDayHours || []);
        state.compositionDisabledSlotWeatherKeys = compositionUnique(source.disabledSlotWeatherKeys || []);
        state.compositionDisabledDayHourWeatherBtcKeys = compositionUnique(
          source.disabledDayHourWeatherBtcKeys || source.disabledSlotWeatherKeys || []
        );
        state.compositionOverridesSourceId = sourceId;
    }

    function compositionDisabled(slot, overrides = compositionOverrides()) {
        if (!slot) return false;
        const weatherBtc = compositionWeatherBtcKey(slot.marketWeatherKey, slot.btcRouterState);
        return overrides.disabledDays.includes(slot.day) ||
          overrides.disabledHours.includes(slot.hourBucket) ||
          overrides.disabledWeatherKeys.includes(slot.marketWeatherKey) ||
          overrides.disabledBtcStates.includes(slot.btcRouterState) ||
          overrides.disabledWeatherBtcKeys.includes(weatherBtc) ||
          overrides.disabledDayHours.includes(`${slot.day}:${slot.hourBucket}`) ||
          overrides.disabledSlotWeatherKeys.includes(slot.key) ||
          overrides.disabledDayHourWeatherBtcKeys.includes(slot.key);
    }

    function compositionPreviewSlots(proposal, overrides = compositionOverrides()) {
        return Object.fromEntries(Object.entries(proposal?.slots || {})
          .filter(([, slot]) => slot?.enabled === true && !compositionDisabled(slot, overrides)));
    }

    function compositionSummaryFromSlots(slots = {}) {
        const rows = Object.values(slots || {});
        const completed = rows.reduce((sum, slot) => sum + Number(slot?.stats?.historicalCompleted || 0), 0);
        const wins = rows.reduce((sum, slot) => sum + Number(slot?.stats?.historicalWins || 0), 0);
        const totalR = rows.reduce((sum, slot) => sum + Number(slot?.stats?.historicalTotalNetR || 0), 0);
        const totalPnl = rows.reduce((sum, slot) => sum + Number(slot?.stats?.historicalTotalNetPnlPct || 0), 0);
        const expectedSignals = rows.reduce((sum, slot) => sum + Number(slot?.stats?.expectedSignalsPerWeek || 0), 0);
        const expectedR = rows.reduce((sum, slot) => sum + Number(slot?.stats?.expectedNetRPerWeek || 0), 0);
        const expectedPnl = rows.reduce((sum, slot) => sum + Number(slot?.stats?.expectedNetPnlPctPerWeek || 0), 0);
        const families = uniqueStrings(rows.flatMap((slot) => slot.selectedFamilyIds || []));
        const dayHours = new Set(rows.map((slot) => `${slot.day}:${slot.hourBucket}`));
        return {
          activeSlots: rows.length,
          activeDayHours: dayHours.size,
          familyCount: families.length,
          familyIds: families,
          historicalCompleted: completed,
          historicalWinrate: completed > 0 ? wins / completed : 0,
          historicalAvgNetR: completed > 0 ? totalR / completed : 0,
          historicalTotalNetR: totalR,
          historicalAvgNetPnlPct: completed > 0 ? totalPnl / completed : 0,
          historicalTotalNetPnlPct: totalPnl,
          expectedSignalsPerWeek: expectedSignals,
          expectedNetRPerWeek: expectedR,
          expectedNetPnlPctPerWeek: expectedPnl
        };
    }

    function normalizeCompositionRegime(value = "") {
        const raw = upper(value);
        if (raw.includes("SQUEEZE") || raw.includes("COMPRESSION")) return "SQUEEZE";
        if (raw.includes("CHOP") || raw.includes("RANGE") || raw.includes("SIDEWAYS")) return "CHOP";
        if (raw.includes("TREND") || raw.includes("MOMENTUM") || raw.includes("FLOW")) return "TREND";
        return "UNKNOWN";
    }

    function normalizeCompositionTrendSide(value = "") {
        const raw = upper(value);
        if (["LONG", "BULL", "BULLISH", "BUY", "UP"].some((token) => raw.includes(token))) return "LONG";
        if (["SHORT", "BEAR", "BEARISH", "SELL", "DOWN"].some((token) => raw.includes(token))) return "SHORT";
        if (["NEUTRAL", "MIXED", "FLAT", "SIDEWAYS"].some((token) => raw.includes(token))) return "NEUTRAL";
        return "UNKNOWN";
    }

    function normalizeCompositionBtcState(value = "") {
        const raw = upper(value);
        if (COMPOSITION_BTC_STATES.includes(raw)) return raw;
        if (raw.includes("STRONG_BULL") || raw.includes("VERY_BULL") || raw.includes("HARD_BULL")) return "STRONG_BULLISH";
        if (raw.includes("STRONG_BEAR") || raw.includes("VERY_BEAR") || raw.includes("HARD_BEAR")) return "STRONG_BEARISH";
        if (["BULLISH", "BULL", "LONG", "BUY", "UP"].some((token) => raw.includes(token))) return "BULLISH";
        if (["BEARISH", "BEAR", "SHORT", "SELL", "DOWN"].some((token) => raw.includes(token))) return "BEARISH";
        if (["NEUTRAL", "MIXED", "FLAT", "SIDEWAYS", "CHOP"].some((token) => raw.includes(token))) return "NEUTRAL";
        return "UNKNOWN";
    }

    function firstKnownCompositionValue(normalizer, values = []) {
        for (const value of values) {
          const normalized = normalizer(value);
          if (normalized !== "UNKNOWN") return normalized;
        }
        return "UNKNOWN";
    }

    function compositionObjectCandidates(market = {}) {
        const values = [
          market,
          market.source,
          market.raw,
          market.currentMarketWeather,
          market.marketWeather,
          market.weather,
          market.latest,
          market.snapshot,
          market.source?.currentMarketWeather,
          market.source?.marketWeather,
          market.source?.weather,
          market.raw?.currentMarketWeather,
          market.raw?.marketWeather,
          market.raw?.weather
        ];
        return values.filter((value, index) =>
          value && typeof value === "object" && !Array.isArray(value) && values.indexOf(value) === index
        );
    }

    function currentCompositionWeatherKey() {
        const market = state.market || {};
        const candidates = compositionObjectCandidates(market);

        const explicitKeys = [];
        for (const candidate of candidates) {
          explicitKeys.push(
            candidate?.currentMarketWeatherKey,
            candidate?.marketWeatherKey,
            candidate?.entryMarketWeatherKey,
            candidate?.marketWeatherProfileKey
          );
        }
        for (const value of explicitKeys) {
          const raw = upper(value);
          if (!raw.includes("|")) continue;
          const [regimePart, sidePart] = raw.split("|");
          const regime = normalizeCompositionRegime(regimePart);
          const side = normalizeCompositionTrendSide(sidePart);
          if (regime !== "UNKNOWN" && side !== "UNKNOWN") return `${regime}|${side}`;
        }

        const regimeValues = [];
        const sideValues = [];
        for (const candidate of candidates) {
          regimeValues.push(
            candidate?.currentRegime,
            candidate?.regime,
            candidate?.marketRegime,
            candidate?.breadthRegime,
            candidate?.volatilityRegime
          );
          sideValues.push(
            candidate?.currentTrendSide,
            candidate?.trendSide,
            candidate?.marketTrendSide,
            candidate?.marketSide,
            candidate?.side,
            candidate?.direction,
            candidate?.breadthSide
          );
        }
        const regime = firstKnownCompositionValue(normalizeCompositionRegime, regimeValues);
        const side = firstKnownCompositionValue(normalizeCompositionTrendSide, sideValues);
        return regime === "UNKNOWN" || side === "UNKNOWN" ? "UNKNOWN" : `${regime}|${side}`;
    }

    function currentCompositionBtcState() {
        const market = state.market || {};
        const candidates = compositionObjectCandidates(market);
        const values = [];
        for (const candidate of candidates) {
          values.push(
            candidate?.btcRouterState,
            candidate?.currentBtcRouterState,
            candidate?.btcState,
            candidate?.btcRelation,
            candidate?.currentBtcRelation,
            candidate?.btcDirection,
            candidate?.btcTrendSide,
            candidate?.btc?.btcRouterState,
            candidate?.btc?.btcState,
            candidate?.btc?.state,
            candidate?.btc?.direction,
            candidate?.btc?.trendSide,
            candidate?.btcContext?.btcRouterState,
            candidate?.btcContext?.btcState,
            candidate?.btcContext?.direction,
            candidate?.btcContext?.trendSide
          );
        }
        return firstKnownCompositionValue(normalizeCompositionBtcState, values);
    }

function compositionPlanCard(proposal, active, selected) {
        const summary = proposal?.summary || {};
        const impact = proposal?.btcRouterImpact || summary?.btcRouterImpact || {};
        const isActive = active && (
          active.baseCompositionId === proposal?.baseCompositionId ||
          active.baseCompositionId === proposal?.compositionId ||
          (active.generationId === proposal?.generationId && upper(active.mode) === upper(proposal?.mode))
        );
        return `
          <article class="composition-plan-card ${selected ? "selected" : ""} ${isActive ? "active" : ""}" data-composition-mode="${escapeAttr(proposal?.mode || "")}">
            <h3><span class="composition-plan-rank">${escapeHtml(proposal?.rank || "-")}</span>${escapeHtml(proposal?.title || proposal?.mode || "Plan")}</h3>
            <div class="metric-extra">${escapeHtml(proposal?.description || "")}</div>
            <div class="composition-plan-metrics">
              <div><span>Actieve vakken</span><strong>${fmtInt(summary.activeSlots || 0)}</strong></div>
              <div><span>Families</span><strong>${fmtInt(summary.familyCount || 0)}</strong></div>
              <div><span>Historische WR</span><strong>${fmtPct(summary.historicalWinrate || 0)}</strong></div>
              <div><span>Gem. netto-R</span><strong>${fmt(summary.historicalAvgNetR || 0, 3)}R</strong></div>
              <div><span>BTC geblokkeerd</span><strong>${fmtInt(impact.slotsBlockedByBtcRouter || 0)}</strong></div>
              <div><span>WR-winst BTC-filter</span><strong>${fmtPct(impact.winrateDelta || 0)}</strong></div>
              <div><span>Verwacht R/week</span><strong>${fmt(summary.expectedNetRPerWeek || 0, 2)}R</strong></div>
              <div><span>Verwacht PnL/week</span><strong>${fmtRawPct(summary.expectedNetPnlPctPerWeek || 0)}</strong></div>
            </div>
          </article>`;
    }

    function compositionSlotCell({ proposal, day, hourBucket, weatherKey, btcState, selectedKey, coverage = false }) {
        const overrides = compositionOverrides();
        if (coverage) {
          const candidateSlots = COMPOSITION_WEATHER_KEYS.filter((key) => key !== "UNKNOWN")
            .flatMap((key) => COMPOSITION_SELECTABLE_BTC_STATES.map((btc) =>
              proposal?.slots?.[compositionSlotKey(day, hourBucket, key, btc)] || null
            ));
          const active = candidateSlots.filter((slot) => slot?.enabled && !compositionDisabled(slot, overrides)).length;
          const available = candidateSlots.filter((slot) => slot?.enabled).length;
          const anyOverride = candidateSlots.some((slot) => slot?.enabled && compositionDisabled(slot, overrides));
          const key = compositionSlotKey(day, hourBucket, state.compositionSelectedWeather, state.compositionSelectedBtc);
          return `<td><button type="button" class="composition-slot ${active ? "on" : (anyOverride ? "override-off" : "auto-off")} ${selectedKey === key ? "selected" : ""}" data-composition-slot="${escapeAttr(key)}">
            <strong>${active}/45 aan</strong><span>${available ? `${available} bewezen` : "geen bewijs"}</span>
          </button></td>`;
        }
        const key = compositionSlotKey(day, hourBucket, weatherKey, btcState);
        const slot = proposal?.slots?.[key] || null;
        const disabled = slot && compositionDisabled(slot, overrides);
        const className = slot ? (disabled ? "override-off" : "on") : "auto-off";
        const stats = slot?.stats || {};
        const exception = (slot?.counterBtcExceptionFamilyIds || []).length > 0;
        return `<td><button type="button" class="composition-slot ${className} ${selectedKey === key ? "selected" : ""}" data-composition-slot="${escapeAttr(key)}">
          <strong>${slot ? (disabled ? "HANDMATIG UIT" : `AAN · ${(slot.selectedFamilyIds || []).length}F`) : "AUTOMATISCH UIT"}</strong>
          <span>${slot ? `WR ${fmtPct(stats.historicalWinrate || 0)}` : "geen sterke combinatie"}</span>
          <span>${slot ? `${fmt(stats.historicalAvgNetR || 0, 2)}R · ${fmtRawPct(stats.historicalAvgNetPnlPct || 0)}` : ""}</span>
          ${exception ? `<span>BEWEZEN TEGEN-BTC UITZONDERING</span>` : ""}
        </button></td>`;
    }

    function compositionGrid(proposal, weatherKey, btcState, { coverage = false } = {}) {
        const selectedKey = state.compositionSelectedSlotKey;
        return `<div class="composition-grid-wrap ${coverage ? "composition-coverage" : ""}">
          <table class="composition-grid">
            <thead><tr><th>Dag / UTC</th>${COMPOSITION_HOURS.map((hour) => `<th><button type="button" class="composition-hour-head" data-toggle-global-hour="${escapeAttr(hour)}">${escapeHtml(hour.replace("H", ""))}:00<br><small>${compositionOverrides().disabledHours.includes(hour) ? "UIT" : "alle dagen"}</small></button></th>`).join("")}</tr></thead>
            <tbody>${COMPOSITION_DAYS.map((day) => `<tr>
              <td><button type="button" class="composition-day-head" data-toggle-composition-day="${escapeAttr(day)}"><strong>${escapeHtml(compositionDayLabel(day))}</strong><br><small>${compositionOverrides().disabledDays.includes(day) ? "HELE DAG UIT" : "klik om uit te zetten"}</small></button></td>
              ${COMPOSITION_HOURS.map((hour) => compositionSlotCell({ proposal, day, hourBucket: hour, weatherKey, btcState, selectedKey, coverage })).join("")}
            </tr>`).join("")}</tbody>
          </table>
        </div>`;
    }

    function compositionFamilyDetails(slot) {
        if (!slot) return `<div class="empty">Dit vak staat automatisch uit omdat geen family genoeg exact bewijs heeft voor deze dag, dit uur, dit marketWeather en deze BTC-richting.</div>`;
        const rows = Array.isArray(slot.selectedFamilies) ? slot.selectedFamilies : [];
        return rows.map((row, index) => `
          <div class="composition-family-detail">
            <strong>#${index + 1} ${escapeHtml(row.familyId || "-")}</strong>
            <div class="metric-extra">${escapeHtml([row.setupType, row.regimeBucket, row.confirmationProfile].filter(Boolean).join(" · "))}</div>
            ${row.counterBtcException?.proven ? `<div class="winner-verdict proven">BEWEZEN TEGEN-BTC UITZONDERING</div>` : ""}
            <div class="composition-plan-metrics">
              <div><span>Exact BTC n</span><strong>${fmtInt(row.exactBtc?.completed || row.exact?.completed || 0)}</strong></div>
              <div><span>Exact BTC WR</span><strong>${fmtPct(row.exactBtc?.winrate || row.exact?.winrate || 0)}</strong></div>
              <div><span>Exact BTC avg R</span><strong>${fmt(row.exactBtc?.avgNetR || row.exact?.avgNetR || 0, 3)}R</strong></div>
              <div><span>Exact BTC PnL</span><strong>${fmtRawPct(row.exactBtc?.avgNetPnlPct || row.exact?.avgNetPnlPct || 0)}</strong></div>
              <div><span>LCB95</span><strong>${fmt(row.exactBtc?.lcb95 || row.exact?.lcb95 || 0, 3)}</strong></div>
              <div><span>Profit factor</span><strong>${fmt(row.exactBtc?.profitFactor || row.exact?.profitFactor || 0, 2)}</strong></div>
              <div><span>Direct SL</span><strong>${fmtPct(row.exactBtc?.directSLPct || row.exact?.directSLPct || 0)}</strong></div>
              <div><span>Confidence</span><strong>${fmt(row.confidenceScore || 0, 0)}/100</strong></div>
              <div><span>Verwacht signalen/week</span><strong>${fmt(row.expectedSignalsPerWeek || 0, 2)}</strong></div>
              <div><span>Verwacht R/week</span><strong>${fmt(row.expectedNetRPerWeek || 0, 3)}R</strong></div>
            </div>
          </div>`).join("") || `<div class="empty">Familydetails ontbreken in deze proposal.</div>`;
    }

    function compositionDetail(proposal) {
        let key = state.compositionSelectedSlotKey;
        const expectedSuffix = `|BTC:${state.compositionSelectedBtc}`;
        if (!key || !key.includes(`|${state.compositionSelectedWeather}|`) || !key.endsWith(expectedSuffix)) {
          key = compositionSlotKey("MONDAY", "H00", state.compositionSelectedWeather, state.compositionSelectedBtc);
        }
        const slot = proposal?.slots?.[key] || null;
        const parsed = parseCompositionSlotKey(key);
        const disabled = slot ? compositionDisabled(slot) : false;
        const dayHourKey = `${parsed.day}:${parsed.hourBucket}`;
        const exactDisabled = compositionOverrides().disabledDayHourWeatherBtcKeys.includes(key) ||
          compositionOverrides().disabledSlotWeatherKeys.includes(key);
        return `<div class="card">
          <div class="section-title"><div><h3>Vakdetails: ${escapeHtml(compositionDayLabel(parsed.day))} ${escapeHtml(compositionHourLabel(parsed.hourBucket))} UTC</h3><p>${escapeHtml(compositionWeatherLabel(parsed.weatherKey))} · ${escapeHtml(compositionBtcLabel(parsed.btcState))}</p></div></div>
          <div class="composition-detail-grid">
            <div>
              ${slot ? `<div class="winner-verdict ${disabled ? "blocked" : "proven"}">${disabled ? "HANDMATIG UIT" : "ACTIEF IN PLAN"}</div>` : `<div class="winner-verdict learning">AUTOMATISCH UIT</div>`}
              <div class="composition-plan-metrics">
                <div><span>Families</span><strong>${fmtInt(slot?.selectedFamilyIds?.length || 0)}</strong></div>
                <div><span>Historische n</span><strong>${fmtInt(slot?.stats?.historicalCompleted || 0)}</strong></div>
                <div><span>Winrate</span><strong>${fmtPct(slot?.stats?.historicalWinrate || 0)}</strong></div>
                <div><span>Avg netto-R</span><strong>${fmt(slot?.stats?.historicalAvgNetR || 0, 3)}R</strong></div>
                <div><span>Avg PnL</span><strong>${fmtRawPct(slot?.stats?.historicalAvgNetPnlPct || 0)}</strong></div>
                <div><span>BTC-router</span><strong>${escapeHtml(slot?.btcRouterDecision?.againstLong ? (slot?.btcRouterDecision?.provenCounterExceptionUsed ? "UITZONDERING" : "TEGEN LONG") : "MEE/NEUTRAAL")}</strong></div>
              </div>
              <div class="toolbar" style="margin-top:12px">
                <button type="button" id="toggleExactCompositionSlot" ${slot ? "" : "disabled"}>${exactDisabled ? "Zet exact vak weer aan" : "Zet exact dag/uur/weather/BTC-vak uit"}</button>
                <button type="button" id="toggleDayHourCompositionSlot">${compositionOverrides().disabledDayHours.includes(dayHourKey) ? "Zet dit uur op deze dag weer aan" : "Zet dit uur op deze dag bij elk weertype en iedere BTC-richting uit"}</button>
              </div>
            </div>
            <div>${compositionFamilyDetails(slot)}</div>
          </div>
        </div>`;
    }

    function compositionBtcImpactTable(proposal) {
        const impact = proposal?.btcRouterImpact || proposal?.summary?.btcRouterImpact || {};
        return `<div class="table-wrap"><table><thead><tr><th>Meetpunt</th><th>Zonder BTC-router</th><th>Met BTC-router</th><th>Verschil</th></tr></thead><tbody>
          <tr><td>Actieve bewijs-vakken</td><td>${fmtInt(impact.preFilterActiveSlots || 0)}</td><td>${fmtInt(impact.postFilterActiveSlots || 0)}</td><td>-${fmtInt(impact.slotsBlockedByBtcRouter || 0)}</td></tr>
          <tr><td>Historische outcomes</td><td>${fmtInt(impact.preFilterHistoricalCompleted || 0)}</td><td>${fmtInt(impact.postFilterHistoricalCompleted || 0)}</td><td>${fmtInt((impact.postFilterHistoricalCompleted || 0) - (impact.preFilterHistoricalCompleted || 0))}</td></tr>
          <tr><td>Winrate</td><td>${fmtPct(impact.preFilterHistoricalWinrate || 0)}</td><td>${fmtPct(impact.postFilterHistoricalWinrate || 0)}</td><td>${fmtPct(impact.winrateDelta || 0)}</td></tr>
          <tr><td>Gemiddelde netto-R</td><td>${fmt(impact.preFilterHistoricalAvgNetR || 0, 3)}R</td><td>${fmt(impact.postFilterHistoricalAvgNetR || 0, 3)}R</td><td>${fmt(impact.avgNetRDelta || 0, 3)}R</td></tr>
          <tr><td>Gemiddelde PnL</td><td>${fmtRawPct(impact.preFilterHistoricalAvgNetPnlPct || 0)}</td><td>${fmtRawPct(impact.postFilterHistoricalAvgNetPnlPct || 0)}</td><td>${fmtRawPct(impact.avgNetPnlPctDelta || 0)}</td></tr>
          <tr><td>Verwacht R/week</td><td>${fmt(impact.preFilterExpectedNetRPerWeek || 0, 2)}R</td><td>${fmt(impact.postFilterExpectedNetRPerWeek || 0, 2)}R</td><td>${fmt((impact.postFilterExpectedNetRPerWeek || 0) - (impact.preFilterExpectedNetRPerWeek || 0), 2)}R</td></tr>
        </tbody></table></div>`;
    }

    function compositionBtcSummaryTable(previewSlots = {}) {
        const rows = COMPOSITION_BTC_STATES.map((btcState) => {
          const slots = Object.values(previewSlots).filter((slot) => slot.btcRouterState === btcState);
          const summary = compositionSummaryFromSlots(Object.fromEntries(slots.map((slot) => [slot.key, slot])));
          const exceptions = slots.filter((slot) => (slot.counterBtcExceptionFamilyIds || []).length > 0).length;
          return `<tr><td>${escapeHtml(compositionBtcLabel(btcState))}</td><td>${fmtInt(summary.activeSlots)}</td><td>${fmtInt(summary.historicalCompleted)}</td><td>${fmtPct(summary.historicalWinrate)}</td><td>${fmt(summary.historicalAvgNetR, 3)}R</td><td>${fmtRawPct(summary.historicalAvgNetPnlPct)}</td><td>${fmt(summary.expectedNetRPerWeek, 2)}R</td><td>${fmtInt(exceptions)}</td></tr>`;
        }).join("");
        return `<div class="table-wrap"><table><thead><tr><th>BTC-toestand</th><th>Vakken</th><th>n</th><th>WR</th><th>Avg R</th><th>Avg PnL</th><th>R/week</th><th>Tegen-BTC uitzonderingen</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    }

    async function activateSelectedWeekComposition(proposal) {
        if (!proposal?.compositionId) return;
        const overrides = compositionOverrides();
        const preview = compositionSummaryFromSlots(compositionPreviewSlots(proposal, overrides));
        if (!confirm(
          `${proposal.title || proposal.mode} activeren?\n\n` +
          `${preview.activeSlots} actieve dag/uur/weather/BTC-vakken\n` +
          `${preview.familyCount} exacte families\n` +
          `Historische winrate ${fmtPct(preview.historicalWinrate)}\n` +
          `Verwacht ${fmt(preview.expectedNetRPerWeek, 2)}R per week\n\n` +
          `Automatisch afgekeurde vakken en BTC-tegenrichting zonder bewijs blijven uit.`
        )) return;
        const result = await api(endpoints.rotation, {
          method: "POST",
          timeoutMs: 30000,
          body: JSON.stringify({
            action: "activateWeekComposition",
            compositionId: proposal.compositionId,
            mode: proposal.mode,
            ...overrides,
            side: DASHBOARD_SIDE,
            tradeSide: ONLY_SIDE,
            targetTradeSide: ONLY_SIDE,
            dashboardSide: DASHBOARD_SIDE,
            longOnly: true,
            shortDisabled: true
          })
        });
        setMessage(`${proposal.title || proposal.mode} is actief. Discord gebruikt nu exact dag × UTC-uur × marketWeather × BTC-richting.`, "success");
        state.rotation = null;
        state.compositionOverridesSourceId = null;
        await renderWinners();
        return result;
    }

    async function renderWinners() {
        showLoading("winners");
        const results = await Promise.allSettled([
          ensureRotationLoaded(),
          state.market ? Promise.resolve(state.market) : fetchMarket()
        ]);
        const rotationError = results[0].status === "rejected" ? results[0].reason : null;
        if (rotationError && !state.rotation) throw rotationError;

        const proposals = compositionProposalList();
        const active = activeWeekComposition();
        if (active && !state.compositionSelectedMode) state.compositionSelectedMode = upper(active.mode);
        if (!proposals.some((proposal) => upper(proposal.mode) === upper(state.compositionSelectedMode))) {
          state.compositionSelectedMode = proposals.some((proposal) => upper(proposal.mode) === "BALANCED")
            ? "BALANCED"
            : upper(proposals[0]?.mode || "BALANCED");
        }
        const proposal = compositionProposalByMode(proposals);
        hydrateCompositionOverrides(proposal, active);

        const currentWeather = currentCompositionWeatherKey();
        const currentBtc = currentCompositionBtcState();
        if (!state.compositionSelectedSlotKey) {
          if (currentWeather !== "UNKNOWN") state.compositionSelectedWeather = currentWeather;
          if (currentBtc !== "UNKNOWN") state.compositionSelectedBtc = currentBtc;
        }
        const previewSlots = compositionPreviewSlots(proposal);
        const preview = compositionSummaryFromSlots(previewSlots);
        const overrides = compositionOverrides();
        const manualDisabledCount = Object.values(proposal?.slots || {})
          .filter((slot) => slot?.enabled && compositionDisabled(slot, overrides)).length;
        const totalPossible = Number(proposal?.dimensions?.totalPossibleSlots || proposal?.summary?.totalPossibleSlots || 10080);
        const automaticOff = Math.max(0, totalPossible - Object.keys(proposal?.slots || {}).length);
        const selectedWeatherDisabled = overrides.disabledWeatherKeys.includes(state.compositionSelectedWeather);
        const selectedBtcDisabled = overrides.disabledBtcStates.includes(state.compositionSelectedBtc);
        const selectedWeatherBtcKey = compositionWeatherBtcKey(
          state.compositionSelectedWeather,
          state.compositionSelectedBtc
        );
        const selectedWeatherBtcDisabled = overrides.disabledWeatherBtcKeys.includes(selectedWeatherBtcKey);

        if (!state.compositionSelectedSlotKey) {
          state.compositionSelectedSlotKey = compositionSlotKey(
            "MONDAY", "H00", state.compositionSelectedWeather, state.compositionSelectedBtc
          );
        }

        $("winners").innerHTML = `
          <div class="card winner-hero">
            <h2>Top 3 automatische BTC-gestuurde weekcomposities</h2>
            <div class="metric-extra">Het systeem kiest per <strong>weekdag × UTC-uur × marketWeather × BTC-richting</strong> alleen de beste bewezen exacte 75-child families. Bij bearish BTC staat LONG standaard uit, behalve wanneer juist die exacte combinatie een statistisch bewezen tegen-BTC uitzondering is.</div>
          </div>

          ${rotationError ? `<div class="message warn">Samenstellingen konden niet volledig worden geladen: ${escapeHtml(friendlyApiMessage(rotationError))}</div>` : ""}
          ${!proposals.length ? `<div class="message warn">Er zijn nog geen drie BTC-proposals. Draai eerst een nieuwe weekly freeze nadat outcomes met entry-BTC-context zijn verzameld.</div>` : ""}

          <div class="composition-plan-grid">
            ${proposals.map((item) => compositionPlanCard(item, active, upper(item.mode) === upper(state.compositionSelectedMode))).join("") || `<div class="empty">Nog geen proposals beschikbaar.</div>`}
          </div>

          <div class="grid">
            ${metricCard("Gekozen plan", proposal?.title || "GEEN", proposal?.mode || "-")}
            ${metricCard("Huidig marketWeather", compositionWeatherLabel(currentWeather), currentWeather)}
            ${metricCard("Huidige BTC-richting", compositionBtcLabel(currentBtc), currentBtc)}
            ${metricCard("Actieve vakken", fmtInt(preview.activeSlots), `van ${fmtInt(totalPossible)} mogelijke vakken`)}
            ${metricCard("Automatisch uit", fmtInt(automaticOff), "geen exact bewijs of routerblokkade")}
            ${metricCard("Handmatig uit", fmtInt(manualDisabledCount), "jouw extra beperkingen")}
            ${metricCard("Families in plan", fmtInt(preview.familyCount), "exacte child-75 IDs")}
            ${metricCard("Historische winrate", fmtPct(preview.historicalWinrate), `${fmtInt(preview.historicalCompleted)} exacte outcomes`)}
            ${metricCard("Historische avg R", `${fmt(preview.historicalAvgNetR, 3)}R`, `totaal ${fmt(preview.historicalTotalNetR, 1)}R`)}
            ${metricCard("Historische avg PnL", fmtRawPct(preview.historicalAvgNetPnlPct), `totaal ${fmtRawPct(preview.historicalTotalNetPnlPct)}`)}
            ${metricCard("Verwacht signalen/week", fmt(preview.expectedSignalsPerWeek, 1), "historische frequentie")}
            ${metricCard("Verwacht R/week", `${fmt(preview.expectedNetRPerWeek, 2)}R`, "modelinschatting")}
          </div>

          <div class="card">
            <div class="section-title"><div><h2>1. Hele week in één oogopslag</h2><p>Elk uur toont hoeveel van 45 bekende marketWeather/BTC-combinaties actief zijn. Ontbrekend bewijs blijft automatisch uit.</p></div></div>
            ${proposal ? compositionGrid(proposal, state.compositionSelectedWeather, state.compositionSelectedBtc, { coverage: true }) : `<div class="empty">Geen plan beschikbaar.</div>`}
          </div>

          <div class="card">
            <div class="section-title"><div><h2>2. Kies marketWeather en BTC-richting</h2><p>Hetzelfde uur kan bij bullish BTC AAN zijn en bij bearish BTC UIT. UNKNOWN staat fail-closed.</p></div></div>
            <h3>MarketWeather</h3>
            <div class="composition-weather-tabs">
              ${COMPOSITION_WEATHER_KEYS.map((weatherKey) => `<button type="button" class="composition-weather-tab ${weatherKey === state.compositionSelectedWeather ? "selected" : ""} ${overrides.disabledWeatherKeys.includes(weatherKey) ? "disabled-weather" : ""}" data-composition-weather="${escapeAttr(weatherKey)}">${escapeHtml(compositionWeatherLabel(weatherKey))}</button>`).join("")}
            </div>
            <label class="winner-check"><input type="checkbox" id="compositionWeatherEnabled" ${selectedWeatherDisabled ? "" : "checked"} ${state.compositionSelectedWeather === "UNKNOWN" ? "disabled" : ""}/> ${escapeHtml(compositionWeatherLabel(state.compositionSelectedWeather))} voor de hele week toegestaan</label>
            <h3 style="margin-top:16px">BTC-richting</h3>
            <div class="composition-weather-tabs">
              ${COMPOSITION_BTC_STATES.map((btcState) => `<button type="button" class="composition-weather-tab ${btcState === state.compositionSelectedBtc ? "selected" : ""} ${overrides.disabledBtcStates.includes(btcState) ? "disabled-weather" : ""}" data-composition-btc="${escapeAttr(btcState)}">${escapeHtml(compositionBtcLabel(btcState))}</button>`).join("")}
            </div>
            <label class="winner-check"><input type="checkbox" id="compositionBtcEnabled" ${selectedBtcDisabled ? "" : "checked"} ${state.compositionSelectedBtc === "UNKNOWN" ? "disabled" : ""}/> ${escapeHtml(compositionBtcLabel(state.compositionSelectedBtc))} voor de hele week toegestaan</label>
            <label class="winner-check"><input type="checkbox" id="compositionWeatherBtcEnabled" ${selectedWeatherBtcDisabled ? "" : "checked"} ${state.compositionSelectedWeather === "UNKNOWN" || state.compositionSelectedBtc === "UNKNOWN" ? "disabled" : ""}/> Exact ${escapeHtml(compositionWeatherLabel(state.compositionSelectedWeather))} + ${escapeHtml(compositionBtcLabel(state.compositionSelectedBtc))} toegestaan</label>
            <div class="metric-extra">Alle tijden zijn UTC. Rood is handmatig uit. Grijs is automatisch afgekeurd en kan niet worden geforceerd.</div>
            ${proposal ? compositionGrid(proposal, state.compositionSelectedWeather, state.compositionSelectedBtc) : `<div class="empty">Geen plan beschikbaar.</div>`}
          </div>

          ${proposal ? compositionDetail(proposal) : ""}

          <div class="card">
            <div class="section-title"><div><h2>3. Effect van de BTC-router</h2><p>Vergelijking van dezelfde bewijsvensters vóór en na het uitschakelen van LONG tegen BTC zonder bewezen uitzondering.</p></div></div>
            ${compositionBtcImpactTable(proposal)}
          </div>

          <div class="card">
            <div class="section-title"><div><h2>4. Resultaten per BTC-toestand</h2><p>Winrate, netto-R, PnL en uitzonderingen van de gekozen samenstelling na jouw handmatige uitschakelingen.</p></div></div>
            ${compositionBtcSummaryTable(previewSlots)}
          </div>

          <div class="card">
            <h3>Jouw extra uitschakelingen</h3>
            <div class="composition-override-list">${escapeHtml(JSON.stringify(overrides, null, 2))}</div>
            <div class="toolbar" style="margin-top:12px">
              <button type="button" id="resetCompositionOverrides">Wis alleen handmatige uitschakelingen</button>
              <button type="button" id="openManualRotation">Open handmatige familyselectie</button>
              <button type="button" class="long-action" id="activateCompositionBtn" ${proposal && preview.activeSlots ? "" : "disabled"}>Activeer deze complete BTC-samenstelling</button>
            </div>
          </div>

          <div class="card">
            <h3>Technische status</h3>
            ${jsonBlock({
              uiVersion: WEEK_COMPOSITION_UI_VERSION,
              selectedProposalId: proposal?.compositionId || null,
              selectedMode: proposal?.mode || null,
              activeCompositionId: active?.compositionId || null,
              activeBaseCompositionId: active?.baseCompositionId || null,
              generationId: proposal?.generationId || active?.generationId || state.rotation?.activeTemporalGenerationId || state.rotation?.validFrom?.activeTemporalGenerationId || null,
              currentMarketWeatherKey: currentWeather,
              currentBtcRouterState: currentBtc,
              selectedMarketWeatherKey: state.compositionSelectedWeather,
              selectedBtcRouterState: state.compositionSelectedBtc,
              previewSummary: preview,
              btcRouterImpact: proposal?.btcRouterImpact || proposal?.summary?.btcRouterImpact || null,
              overrides,
              automaticOff,
              manualDisabledCount
            })}
          </div>`;

        document.querySelectorAll("[data-composition-mode]").forEach((card) => {
          card.addEventListener("click", () => {
            state.compositionSelectedMode = upper(card.dataset.compositionMode);
            state.compositionOverridesSourceId = null;
            state.compositionSelectedSlotKey = null;
            renderWinners();
          });
        });
        document.querySelectorAll("[data-composition-weather]").forEach((button) => {
          button.addEventListener("click", () => {
            state.compositionSelectedWeather = upper(button.dataset.compositionWeather);
            state.compositionSelectedSlotKey = compositionSlotKey("MONDAY", "H00", state.compositionSelectedWeather, state.compositionSelectedBtc);
            renderWinners();
          });
        });
        document.querySelectorAll("[data-composition-btc]").forEach((button) => {
          button.addEventListener("click", () => {
            state.compositionSelectedBtc = upper(button.dataset.compositionBtc);
            state.compositionSelectedSlotKey = compositionSlotKey("MONDAY", "H00", state.compositionSelectedWeather, state.compositionSelectedBtc);
            renderWinners();
          });
        });
        document.querySelectorAll("[data-composition-slot]").forEach((button) => {
          button.addEventListener("click", () => {
            state.compositionSelectedSlotKey = button.dataset.compositionSlot;
            const parsed = parseCompositionSlotKey(state.compositionSelectedSlotKey);
            state.compositionSelectedWeather = parsed.weatherKey;
            state.compositionSelectedBtc = parsed.btcState;
            renderWinners();
          });
        });
        document.querySelectorAll("[data-toggle-composition-day]").forEach((button) => {
          button.addEventListener("click", (event) => {
            event.stopPropagation();
            const day = upper(button.dataset.toggleCompositionDay);
            setCompositionOverride("compositionDisabledDays", day, !overrides.disabledDays.includes(day));
            renderWinners();
          });
        });
        document.querySelectorAll("[data-toggle-global-hour]").forEach((button) => {
          button.addEventListener("click", (event) => {
            event.stopPropagation();
            const hour = upper(button.dataset.toggleGlobalHour);
            setCompositionOverride("compositionDisabledHours", hour, !overrides.disabledHours.includes(hour));
            renderWinners();
          });
        });
        $("compositionWeatherEnabled")?.addEventListener("change", (event) => {
          setCompositionOverride("compositionDisabledWeatherKeys", state.compositionSelectedWeather, !event.target.checked);
          renderWinners();
        });
        $("compositionBtcEnabled")?.addEventListener("change", (event) => {
          setCompositionOverride("compositionDisabledBtcStates", state.compositionSelectedBtc, !event.target.checked);
          renderWinners();
        });
        $("compositionWeatherBtcEnabled")?.addEventListener("change", (event) => {
          const key = compositionWeatherBtcKey(state.compositionSelectedWeather, state.compositionSelectedBtc);
          setCompositionOverride("compositionDisabledWeatherBtcKeys", key, !event.target.checked);
          renderWinners();
        });
        $("toggleExactCompositionSlot")?.addEventListener("click", () => {
          const key = state.compositionSelectedSlotKey;
          const disabled = overrides.disabledDayHourWeatherBtcKeys.includes(key) ||
            overrides.disabledSlotWeatherKeys.includes(key);
          setCompositionOverride("compositionDisabledDayHourWeatherBtcKeys", key, !disabled);
          renderWinners();
        });
        $("toggleDayHourCompositionSlot")?.addEventListener("click", () => {
          const parsed = parseCompositionSlotKey(state.compositionSelectedSlotKey || "");
          const dayHour = `${parsed.day}:${parsed.hourBucket}`;
          setCompositionOverride("compositionDisabledDayHours", dayHour, !overrides.disabledDayHours.includes(dayHour));
          renderWinners();
        });
        $("resetCompositionOverrides")?.addEventListener("click", () => {
          state.compositionDisabledDays = [];
          state.compositionDisabledHours = [];
          state.compositionDisabledWeatherKeys = [];
          state.compositionDisabledBtcStates = [];
          state.compositionDisabledWeatherBtcKeys = [];
          state.compositionDisabledDayHours = [];
          state.compositionDisabledSlotWeatherKeys = [];
          state.compositionDisabledDayHourWeatherBtcKeys = [];
          state.compositionOverridesSourceId = `RESET:${proposal?.compositionId || Date.now()}`;
          renderWinners();
        });
        $("openManualRotation")?.addEventListener("click", () => showTab("rotation"));
        $("activateCompositionBtn")?.addEventListener("click", () => activateSelectedWeekComposition(proposal));
    }


    async function renderMicros() {
        showLoading("micros");


        try {
             state.micros = await fetchMicros();
        } catch (error) {
             state.micros = {
                  rows: [],
                  error: friendlyApiMessage(error)
             };


             setMessage(state.micros.error, "warn");
        }


        const rows = currentMicroRows();
        const top = rows.find(discordSelectionAllowed) || rows[0] || null;


        const observingRows = rows.filter((row) => learningStatus(row) ===
"OBSERVING");
        const earlyRows = rows.filter((row) => learningStatus(row) ===
"EARLY_OUTCOMES");
      const activeRows = rows.filter((row) => learningStatus(row) ===
"ACTIVE_LEARNING");
      const passedRows = rows.filter((row) => activationGateStatus(row) ===
"PASSED");
      const vetoRows = rows.filter((row) => isEmpiricalVeto(row));
      const gateObservingRows = rows.filter((row) => activationGateStatus(row) ===
"OBSERVING");
      const misfitRows = rows.filter((row) => currentFit(row) === "MISFIT");


      $("micros").innerHTML = `
        <div class="toolbar">
             <select id="microMode">
               ${validMicroModes.map((mode) => `
                 <option value="${escapeAttr(mode)}" ${mode === state.microMode ?
"selected" : ""}>${escapeHtml(mode)}</option>
               `).join("")}
             </select>


             <input id="microSearch" type="search" placeholder="Zoek 75-child, parent
15, setup, regime, confirmation..." value="${escapeAttr(state.microSearch)}" />


             <button type="button" class="primary" id="openWinnersBtn">Open winnende signalen</button>
             <button type="button" class="success" id="copyVisibleIdsBtn">Copy
visible 75-child IDs</button>
             <button type="button" class="success"
id="activateVisibleIdsBtn">Activate visible PASSED IDs</button>
             <button type="button" id="exportMicrosBtn">Export JSON</button>
        </div>


        <div class="card">
             <h3>MicroFamilies ranking policy</h3>
             <div class="toolbar">
               <span class="pill dark">75 selectable children</span>
               <span class="pill dark">15 parent context rows</span>
               <span class="pill dark">adaptive/balanced/fair/netR/cost</span>
               <span class="pill observation">OBSERVING = completed 0</span>
               <span class="pill soft">EARLY_OUTCOMES = completed 1-19</span>
               <span class="pill active">ACTIVE_LEARNING = completed ≥
${MIN_COMPLETED_ACTIVE_LEARNING}</span>
               <span class="pill long">scanner fingerprints hidden</span>
               <span class="pill soft">CurrentFit soft</span>
             </div>
             <div class="metric-extra">
               Dashboard toont alleen echte Analyze 75-child trueMicroFamilyIds.
               Scanner fingerprints, execution fingerprints, oude 25 buckets en
coinnamen worden niet als leerfamilie getoond.
             </div>
        </div>
        <div class="section-title">
          <div>
            <h2>Manual Discord selection candidate</h2>
            <p>Alleen exacte LONG 75-child IDs worden actief gezet. CurrentFit
beïnvloedt Discord, niet learning.</p>
          </div>
        </div>


        ${manualCard(top)}


        <div class="grid">
          ${metricCard("Analyze 75-child rows", fmtInt(rows.length), `API
totalAvailable=${fmtInt(state.micros?.totalAvailable || rows.length)}`)}
          ${metricCard("OBSERVING", fmtInt(observingRows.length), "completed =0")}
          ${metricCard("EARLY_OUTCOMES", fmtInt(earlyRows.length), `completed 1-
${MIN_COMPLETED_ACTIVE_LEARNING - 1}`)}
          ${metricCard("ACTIVE_LEARNING", fmtInt(activeRows.length), `completed ≥
${MIN_COMPLETED_ACTIVE_LEARNING}`)}
          ${metricCard("Gate PASSED", fmtInt(passedRows.length), `completed ≥
${EMPIRICAL_VETO_MIN_COMPLETED} en avgR > 0`)}
          ${metricCard("Gate OBSERVING", fmtInt(gateObservingRows.length),
`completed < ${EMPIRICAL_VETO_MIN_COMPLETED}`)}
          ${metricCard("EMPIRICAL VETO", fmtInt(vetoRows.length), `completed ≥
${EMPIRICAL_VETO_MIN_COMPLETED} en avgR ≤ 0`)}
          ${metricCard("CurrentFit MISFIT", fmtInt(misfitRows.length), "blocks Discord only")}
          ${metricCard("Discord active 75-child IDs",
fmtInt(activeMicroIds().length))}
          ${metricCard("Parent 15 active context",
fmtInt(activeParentIds().length), "does not trigger Discord")}
          ${metricCard("Outcomes", "NET R", "virtual/shadow closed outcomes")}
        </div>


        ${microTable(rows.slice(0, state.bestLimit))}


        <div class="card">
          <h3>Micro API status</h3>
          ${jsonBlock({
            ok: state.micros?.ok,
            rowsRendered: rows.length,
            rawExtractedRows: state.micros?.rawExtractedRows || 0,
            best75Count: state.micros?.best75Count ?? null,
            best25CountLegacyIgnored: state.micros?.best25Count ?? null,
            totalAvailable: state.micros?.totalAvailable ?? null,
            weekRows: state.micros?.weekRows ?? null,
                 primaryWeekRows: state.micros?.primaryWeekRows ?? null,
                 rawScannerFingerprintRowsHidden:
state.micros?.rawScannerFingerprintRowsHidden ?? null,
                 trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
                 parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
                 rankingPolicy:
"adaptiveScore|balancedScore|fairWinrate|totalR|avgR|avgCostR",
                 measurementFixVersion: state.micros?.measurementFixVersion ||
MEASUREMENT_FIX_VERSION,
                 outcomeMeasurementVersion: state.micros?.outcomeMeasurementVersion ||
MEASUREMENT_FIX_VERSION,
                 outcomeMeasurementGateMode: state.micros?.outcomeMeasurementGateMode
|| OUTCOME_MEASUREMENT_GATE_MODE,
                 exitFillModelVersion: state.micros?.exitFillModelVersion ||
EXIT_FILL_MODEL_VERSION,
                 empiricalVetoPolicyVersion: state.micros?.empiricalVetoPolicyVersion
|| EMPIRICAL_VETO_POLICY_VERSION,
                 empiricalVetoCount: vetoRows.length,
                 adaptiveUiVersion: ADAPTIVE_UI_VERSION,
                 frontendFixVersion: FRONTEND_FIX_VERSION,
                 currentFitVersion: state.micros?.currentFitVersion ||
CURRENT_FIT_VERSION,
                 currentFitPolarity: "BULLISH_POSITIVE_BEARISH_NEGATIVE",
                 riskGeometryRule: "LONG: sl < entry < tp",
                 warnings: state.micros?.warnings || [],
                 error: state.micros?.error || null
               })}
           </div>
      `;


      $("microMode")?.addEventListener("change", (event) => {
           state.microMode = event.target.value;
           renderMicros();
      });


      $("microSearch")?.addEventListener("change", (event) => {
           state.microSearch = event.target.value;
           renderMicros();
      });


      $("microSearch")?.addEventListener("keydown", (event) => {
           if (event.key === "Enter") {
               state.microSearch = event.target.value;
               renderMicros();
           }
      });
           $("openWinnersBtn")?.addEventListener("click", () => showTab("winners"));

           $("copyVisibleIdsBtn")?.addEventListener("click", () => {
             const ids = uniqueStrings(rows.map(microId)).filter(idAllowedInLongOnly);
             copyText(JSON.stringify(ids, null, 2), `Visible ${ids.length} LONG 75-
child IDs gekopieerd.`);
           });


           $("activateVisibleIdsBtn")?.addEventListener("click", () => {
             const ids =
uniqueStrings(rows.filter(discordSelectionAllowed).map(microId)).filter(idAllowedInLongOnly);
             activateSelectedMicroFamilies(ids);
           });


           $("exportMicrosBtn")?.addEventListener("click", () => {
             downloadJson("long-75-child-micro-families.json", state.micros);
           });


           bindMicroEvents();
       }


       async function renderRotation() {
           showLoading("rotation");


           const data = await api(rotationApiUrl(), {
             timeoutMs: 22000
           });


           state.rotation = data;


           const active = data.active || data.activeRotation || {};
           const activeIds = uniqueStrings([
             active.activeMicroFamilyIds || [],
             active.microFamilyIds || [],
             active.trueMicroFamilyIds || [],
             data.activeMicroFamilyIds || []
           ]).filter(idAllowedInLongOnly);


           const parentIds = uniqueStrings([
             active.activeMacroFamilyIds || [],
             active.macroFamilyIds || [],
             data.activeMacroFamilyIds || []
           ]).filter(parentIdAllowedInLongOnly);


           const activeRows = rankMicroRows(data.activeRows || active.microFamilies ||
[]);


           const rows = activeRows
             .concat(
            activeIds.map((id, index) => ({
              rank: index + 1,
              microFamilyId: id,
              trueMicroFamilyId: id,
              childTrueMicroFamilyId: id,
              parentTrueMicroFamilyId: parentFromChildTrueMicroFamilyId(id),
              tradeSide: ONLY_SIDE,
              side: DASHBOARD_SIDE,
              selectedTier: "MANUAL",
              longOnly: true,
              shortDisabled: true
            }))
        )
        .filter((row, index, arr) => arr.findIndex((candidate) =>
microId(candidate) === microId(row)) === index);


      $("rotation").innerHTML = `
        <div class="section-title">
            <div>
              <h2>Manual Discord selection</h2>
              <p>Geen auto-rotatie. Alleen PASSED exacte LONG 75-child
trueMicroFamilyIds. Empirical veto en completed < 35 worden geweigerd.</p>
            </div>
        </div>


        <div class="grid">
            ${metricCard("Active 75-child IDs", fmtInt(activeIds.length))}
            ${metricCard("Parent 15 context IDs", fmtInt(parentIds.length))}
            ${metricCard("Rotation ID", active.rotationId || "-")}
            ${metricCard("Mode", active.mode || "manual")}
            ${metricCard("Source", active.source || "-")}
            ${metricCard("Discord alerts", activeIds.length > 0 ? "STRICT" : "OFF")}
            ${metricCard("Virtual learning", "UNCHANGED")}
            ${metricCard("Auto rotation", "DISABLED")}
        </div>


        <div class="card">
            <h3>Manual exact 75-child IDs</h3>
            <p class="metric-extra">
              Plak één of meer trueMicroFamilyIds zoals
MICRO_LONG_BREAKOUT_TREND_A_STRONG_ALIGN.
              Parent IDs zoals MICRO_LONG_BREAKOUT_TREND worden geweigerd voor
Discord selectie.
            </p>


            <textarea id="manualMicroIds"
placeholder="MICRO_LONG_..._A_STRONG_ALIGN">${escapeHtml(activeIds.join("\n"))}
</textarea>


             <div class="toolbar">
               <button type="button" class="long-action" id="activateManualBtn">Save
PASSED exact selection</button>
               <button type="button" id="clearManualBtn">Clear input</button>
               <button type="button" class="success" id="copyActiveBtn">Copy active
75-child IDs</button>
               <button type="button" id="exportRotationBtn">Export JSON</button>
             </div>
           </div>


           <div class="section-title">
             <div>
               <h2>Active selected LONG 75-child micro-families</h2>
               <p>Deze IDs bepalen Discord eligibility. Niet-geselecteerde setups
blijven stil leren.</p>
             </div>
           </div>


           ${microTable(rows)}


           <div class="card">
             <h3>Raw rotation dashboard</h3>
             ${jsonBlock(data)}
           </div>
      `;


      $("activateManualBtn")?.addEventListener("click", () => {
           const ids = uniqueStrings(($("manualMicroIds")?.value ||
"").split(/[\n,;\r]+/g));
           activateSelectedMicroFamilies(ids);
      });


      $("clearManualBtn")?.addEventListener("click", () => {
           $("manualMicroIds").value = "";
      });


      $("copyActiveBtn")?.addEventListener("click", () => {
           copyText(JSON.stringify(activeIds, null, 2), "Active 75-child IDs gekopieerd.");
      });


      $("exportRotationBtn")?.addEventListener("click", () => {
           downloadJson("manual-discord-selection-long-75-child.json", data);
      });
         bindMicroEvents();
    }


    async function activateSelectedMicroFamilies(ids = []) {
         const requestedIds = uniqueStrings(ids);
         const invalidIds = requestedIds.filter((id) => !idAllowedInLongOnly(id));


         await ensureMicrosLoaded();


         const rowMap = new Map((state.micros?.rows || []).map((row) =>
[microId(row), row]));
         const missingIds = requestedIds.filter((id) => idAllowedInLongOnly(id) &&
!rowMap.has(id));
         const blockedIds = requestedIds.filter((id) => rowMap.has(id) &&
!discordSelectionAllowed(rowMap.get(id)));
         const microFamilyIds = requestedIds.filter((id) => rowMap.has(id) &&
discordSelectionAllowed(rowMap.get(id)));


         const rejectionLines = [
              ...invalidIds.map((id) => `${id}: INVALID_75_CHILD_ID`),
              ...missingIds.map((id) => `${id}: NOT_FOUND_IN_CURRENT_75_ROWS`),
              ...blockedIds.map((id) => `${id}:
${discordSelectionBlockReason(rowMap.get(id))}`)
         ];


         if (!microFamilyIds.length) {
              setMessage(
                   `Geen Discord-eligible LONG 75-child ID geselecteerd.` +
                   (rejectionLines.length ? `\n\nGeweigerd:\n${rejectionLines.join("\n")}`
: ""),
                   "warn"
              );
              return;
         }


         if (!confirm(
              `Activeer Discord alerts voor ${microFamilyIds.length} PASSED LONG 75-
child ID(s)?\n\n` +
              `${microFamilyIds.slice(0, 8).join("\n")}` +
              `${microFamilyIds.length > 8 ? "\n..." : ""}\n\n` +
              `Voorwaarde: completed ≥ ${EMPIRICAL_VETO_MIN_COMPLETED}, avgR > 0 en geen
empirical veto. ` +
              "CurrentFit wordt bij iedere Discord-trigger opnieuw streng gecontroleerd. " +
              "De actieve temporal generation blijft slechte dagen, sessies en niet-goedgekeurde weekenden blokkeren."
         )) return;


         const data = await api(endpoints.rotation, {
method: "POST",
timeoutMs: 28000,
body: JSON.stringify({
  action: "activateSelectedMicroFamilies",


  microFamilyIds,
  activeMicroFamilyIds: microFamilyIds,
  trueMicroFamilyIds: microFamilyIds,
  childTrueMicroFamilyIds: microFamilyIds,


  macroFamilyIds: [],
  activeMacroFamilyIds: [],


  side: DASHBOARD_SIDE,
  tradeSide: ONLY_SIDE,
  positionSide: ONLY_SIDE,
  direction: ONLY_SIDE,
  targetTradeSide: ONLY_SIDE,
  dashboardSide: DASHBOARD_SIDE,


  longOnly: true,
  shortDisabled: true,
  disableShort: true,


  manualOnly: true,
  adminSelected: true,
  autoRotation: false,


  trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
  parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
  learningGranularity: LEARNING_GRANULARITY,
  parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
  selectionGranularity: "EXACT_75_CHILD",


  measurementFixVersion: MEASUREMENT_FIX_VERSION,
  outcomeMeasurementVersion: MEASUREMENT_FIX_VERSION,
  acceptedOutcomeMeasurementVersion: MEASUREMENT_FIX_VERSION,
  outcomeMeasurementGateMode: OUTCOME_MEASUREMENT_GATE_MODE,
  strictOutcomeMeasurementGate: true,
  exitFillModelVersion: EXIT_FILL_MODEL_VERSION,
  empiricalVetoPolicyVersion: EMPIRICAL_VETO_POLICY_VERSION,
  empiricalVetoMinCompleted: EMPIRICAL_VETO_MIN_COMPLETED,
  empiricalVetoMaxAvgR: EMPIRICAL_VETO_MAX_AVG_R,
  discordRequiresPassedActivationGate: true,
  discordRequiresMinCompleted: EMPIRICAL_VETO_MIN_COMPLETED,
  discordRequiresPositiveAvgR: true,
                currentFitVersion: CURRENT_FIT_VERSION,
                currentFitPolarity: "BULLISH_POSITIVE_BEARISH_NEGATIVE",
                currentFitDefinition: "LONG_MIRRORED_CURRENT_FIT",
                currentFitSoftOnly: true,
                currentFitBlocksLearning: false,
                selectionIsAdaptive: true,


                riskGeometryRule: "LONG: sl < entry < tp",
                tpHitRule: "LONG: price >= tp",
                slHitRule: "LONG: price <= sl",
                grossRFormula: "(exitPrice - entry) / (entry - initialSl)",
                currentRFormula: "(currentPrice - entry) / (entry - initialSl)",


                discordOnlyForSelectedMicroFamilies: true,
                discordOnlyForExactTrueMicroMatch: true,
                discordRequiresCurrentFit: true,
                macroMatchDoesNotTriggerDiscord: true,
                parentMacroMatchDoesNotTriggerDiscord: true
           })
      });


      const active = data.active || data.activeRotation || {};
      const activeIds = uniqueStrings([
           active.activeMicroFamilyIds || [],
           active.microFamilyIds || [],
           active.trueMicroFamilyIds || [],
           data.activeMicroFamilyIds || []
      ]).filter(idAllowedInLongOnly);


      state.rotation = {
           ...(state.rotation || {}),
           ...data,
           active,
           activeRotation: active,
           activeMicroFamilyIds: activeIds
      };


      setMessage(
           `Manual Discord selection opgeslagen.\nActive LONG 75-child IDs:
${activeIds.length}\nVirtual/shadow learning blijft breed doorlopen.` +
           (rejectionLines.length ? `\n\nNiet
geactiveerd:\n${rejectionLines.join("\n")}` : ""),
           rejectionLines.length ? "warn" : "ok"
      );


      if (state.activeTab === "rotation") await renderRotation();
      if (state.activeTab === "micros") await renderMicros();
      if (state.activeTab === "winners") await renderWinners();
    }


    async function openMicro(id) {
        if (!id) return;


        const drawer = $("drawer");


        drawer.classList.remove("hidden");
        drawer.innerHTML = `
             <div class="drawer-head">
               <div>
                   <h2>${escapeHtml(id)}</h2>
                   <div class="metric-extra">Detail wordt geladen...</div>
               </div>
               <button type="button" id="closeDrawerBtn">Close</button>
             </div>
        `;


        $("closeDrawerBtn")?.addEventListener("click", closeDrawer);


        try {
             const data = await
api(`${endpoints.microDetail}/${encodeURIComponent(id)}`, {
               timeoutMs: 18000
             });


             const row = normalizeMicroRowForUi(data.row || data.microFamily || data);


             drawer.innerHTML = `
               <div class="drawer-head">
                   <div>
                      <h2>${escapeHtml(id)}</h2>
                      <div class="metric-extra">75-child=${escapeHtml(microId(row))} ·
parent=${escapeHtml(parentMicroId(row))}</div>
                   </div>
                   <button type="button" id="closeDrawerBtn">Close</button>
               </div>


               <div class="toolbar">
                   <span class="pill long">LONG</span>
                   <span class="pill dark">75-child exact</span>
                   ${statusPill(row)}
                   ${activationGatePill(row)}
                   ${currentFitPill(row)}
                   ${tooEarly(row) ? `<span class="pill
warn">${escapeHtml(fmt(completed(row), 0))}/${MIN_COMPLETED_ACTIVE_LEARNING}
</span>` : ""}
               <button type="button" class="long-action" id="activateDrawerBtn"
title="${escapeAttr(discordSelectionBlockReason(row))}"
${discordSelectionAllowed(row) ? "" : "disabled"}>Select exact</button>
               <button type="button" id="copyDrawerBtn">Copy</button>
             </div>


             <div class="grid">
               ${metricCard("Seen", fmtInt(observationSample(row)))}
               ${metricCard("Observations", fmtInt(observationSample(row)))}
               ${metricCard("Obs dedupe skipped",
fmtInt(row.observationDuplicateSkippedCount))}
               ${metricCard("Completed", fmt(completed(row), 2), tooEarly(row) ?
`minimum ${MIN_COMPLETED_ACTIVE_LEARNING}` : "active learning")}
               ${metricCard("Activation gate", activationGateStatus(row),
discordSelectionAllowed(row) ? "Discord selectable" :
discordSelectionBlockReason(row))}
               ${metricCard("Winrate raw", fmtPct(row.winrate))}
               ${metricCard("Fair WR", fmtPct(row.fairWinrate ??
row.sampleAdjustedWinrate))}
               ${metricCard("AvgR net", fmt(row.avgR, 3))}
               ${metricCard("TotalR net", fmt(row.totalR, 3))}
               ${metricCard("AvgCostR", fmt(avgCostR(row), 3))}
               ${metricCard("DirectSL", fmtPct(directSLPct(row)))}
               ${metricCard("CurrentFit", currentFit(row))}
               ${metricCard("Adaptive", fmt(adaptiveScore(row), 2))}
             </div>


             <div class="card">
               <h3>Raw detail JSON</h3>
               ${jsonBlock(data)}
             </div>
        `;


        $("closeDrawerBtn")?.addEventListener("click", closeDrawer);
        $("activateDrawerBtn")?.addEventListener("click", () =>
activateSelectedMicroFamilies([microId(row)]));
        $("copyDrawerBtn")?.addEventListener("click", () => copyText(microId(row),
"75-child trueMicroFamilyId gekopieerd."));
      } catch (error) {
        drawer.innerHTML = `
             <div class="drawer-head">
               <div>
                 <h2>${escapeHtml(id)}</h2>
                 <div class="metric-extra">Detail API niet geladen.</div>
               </div>
               <button type="button" id="closeDrawerBtn">Close</button>
             </div>
                 <div class="message warn">${escapeHtml(friendlyApiMessage(error))}</div>
            `;


            $("closeDrawerBtn")?.addEventListener("click", closeDrawer);
        }
    }


    function closeDrawer() {
        $("drawer").classList.add("hidden");
        $("drawer").innerHTML = "";
    }


    async function renderDiscord() {
        showLoading("discord");


        const data = await api(`${endpoints.discord}?limit=60`, {
            timeoutMs: 18000
        });


        state.discord = data;


        const logs = asArray(data.logs || data.items || data.data);


        $("discord").innerHTML = `
            <div class="toolbar">
                 <button type="button" id="copyDiscordBtn">Copy JSON</button>
                 <button type="button" id="exportDiscordBtn">Export JSON</button>
            </div>


            <div class="grid">
                 ${metricCard("Logs", fmtInt(logs.length))}
                 ${metricCard("Last log", fmtTs(logs[0]?.ts || logs[0]?.createdAt))}
                 ${metricCard("Entry alerts", fmtInt(logs.filter((row) => upper(row.type
|| row.event).includes("ENTRY")).length))}
                 ${metricCard("Exit alerts", fmtInt(logs.filter((row) => upper(row.type
|| row.event).includes("EXIT")).length))}
                 ${metricCard("Match mode", "EXACT 75-child")}
                 ${metricCard("CurrentFit", "STRICT")}
                 ${metricCard("Parent match", "OFF")}
                 ${metricCard("Scanner match", "OFF")}
            </div>


            ${table(logs, [
                 { label: "TS", render: (row) => fmtTs(row.ts || row.createdAt) },
                 { label: "Type", render: (row) => escapeHtml(row.type || row.level ||
row.event || "-") },
               { label: "Symbol", render: (row) => escapeHtml(baseSymbol(row.payload ||
row)) },
               { label: "Side", render: () => '<span class="pill long">LONG</span>' },
               { label: "Selected exact", render: (row) => {
                 const payload = row.payload || row;
                 const id = microId(payload);
                 const selected = Boolean(
                     payload.selectedMicroFamilyAlert ||
                     payload.discordAlertEligible ||
                     payload.selectedForDiscord ||
                     payload.wasSelected ||
                     row.selectedOnly
                 ) && isSelectableTrueMicroId(id);


                 return `<span class="pill ${selected ? "active" : ""}">${selected ?
"YES" : "NO"}</span>`;
               }},
               { label: "CurrentFit", render: (row) => currentFitPill(row.payload ||
row) },
               { label: "75-child true micro", render: (row) =>
`<code>${escapeHtml(microId(row.payload || row) || "-")}</code>` },
               { label: "Parent 15", render: (row) =>
`<code>${escapeHtml(parentMicroId(row.payload || row) || "-")}</code>` },
               { label: "Message", render: (row) => escapeHtml(row.message ||
row.content || row.result || row.reason || "") }
             ], "Geen Discord logs.")}
        `;


        $("copyDiscordBtn")?.addEventListener("click", () =>
copyText(JSON.stringify(data, null, 2), "Discord JSON gekopieerd."));
        $("exportDiscordBtn")?.addEventListener("click", () =>
downloadJson("discord-logs-long-75-child.json", data));
    }


    function renderReset() {
        $("reset").innerHTML = `
             <div class="grid-3">
               <div class="card">
                 <h3>Reset learning only</h3>
                 <p class="metric-extra">
                     Wist LONG learning data onder ${LONG_KEY_PREFIX}. Manual Discord
selection, open virtual positions en scanner snapshots blijven staan.
                 </p>
                 <button type="button" class="warn" id="resetLearningBtn">Reset
learning</button>
               </div>
               <div class="card">
                 <h3>Reset manual selection</h3>
                 <p class="metric-extra">
                      Wist active/next LONG rotation. Learning en virtual positions
blijven staan.
                 </p>
                 <button type="button" class="warn" id="resetRotationBtn">Reset
rotation</button>
               </div>


               <div class="card">
                 <h3>Factory reset</h3>
                 <p class="metric-extra">
                      Wist LONG scanner snapshots, trade memory, open positions, analyze
stats en rotations.
                 </p>
                 <input id="factoryConfirm" style="width: 100%; margin-bottom: 8px;"
placeholder="LONG_FACTORY_RESET_CONFIRMED" />
                 <label style="display: block; margin-bottom: 8px;">
                      <input id="factoryForce" type="checkbox" />
                      force even with open positions
                 </label>
                 <button type="button" class="danger" id="factoryResetBtn">Factory
reset</button>
               </div>
             </div>


             <div class="card">
               <h3>Reset result</h3>
               <pre id="resetResult">Nog geen reset uitgevoerd.</pre>
             </div>
        `;


        $("resetLearningBtn")?.addEventListener("click", postResetLearning);
        $("resetRotationBtn")?.addEventListener("click", postResetRotation);
        $("factoryResetBtn")?.addEventListener("click", postFactoryReset);
    }


    async function postResetLearning() {
        const confirmValue = prompt("Typ RESET_LEARNING_LONG om LONG learning te wissen.");


        if (confirmValue !== "RESET_LEARNING_LONG") return;


        try {
             const data = await api(endpoints.resetLearning, {
               method: "POST",
              timeoutMs: 30000,
              body: JSON.stringify({
                   confirm: "RESET_LEARNING_LONG",
                   confirmed: "RESET_LEARNING_LONG",
                   confirmation: "RESET_LEARNING_LONG",
                   side: DASHBOARD_SIDE,
                   tradeSide: ONLY_SIDE,
                   targetTradeSide: ONLY_SIDE,
                   longOnly: true,
                   shortDisabled: true,
                   trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
                   parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
                   persistentLearningKey: PERSISTENT_LEARNING_KEY,
                   redisNamespace: LONG_NAMESPACE,
                   redisKeyPrefix: LONG_KEY_PREFIX
              })
            });


            $("resetResult").textContent = JSON.stringify(data, null, 2);
            setMessage("LONG learning reset uitgevoerd.", "ok");
        } catch (error) {
            setMessage(friendlyApiMessage(error), "warn");
        }
    }


    async function postResetRotation() {
        const confirmValue = prompt("Typ RESET_ROTATION_LONG om manual Discord selection te wissen.");


        if (confirmValue !== "RESET_ROTATION_LONG") return;


        try {
            const data = await api(endpoints.resetRotation, {
              method: "POST",
              timeoutMs: 30000,
              body: JSON.stringify({
                   confirm: "RESET_ROTATION_LONG",
                   confirmed: "RESET_ROTATION_LONG",
                   confirmation: "RESET_ROTATION_LONG",
                   side: DASHBOARD_SIDE,
                   tradeSide: ONLY_SIDE,
                   targetTradeSide: ONLY_SIDE,
                   longOnly: true,
                   shortDisabled: true,
                   trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
                   parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
                   persistentLearningKey: PERSISTENT_LEARNING_KEY,
                   redisNamespace: LONG_NAMESPACE,
                   redisKeyPrefix: LONG_KEY_PREFIX
              })
            });


            $("resetResult").textContent = JSON.stringify(data, null, 2);
            setMessage("LONG rotation reset uitgevoerd.", "ok");
        } catch (error) {
            setMessage(friendlyApiMessage(error), "warn");
        }
    }


    async function postFactoryReset() {
        const confirmValue = $("factoryConfirm").value.trim();
        const force = $("factoryForce").checked;


        if (confirmValue !== "LONG_FACTORY_RESET_CONFIRMED") {
            setMessage("Factory reset geblokkeerd: bevestiging is niet exact LONG_FACTORY_RESET_CONFIRMED.", "error");
            return;
        }


        if (!confirm("LONG FACTORY RESET wist alles in de LONG namespace.Doorgaan?")) return;


        try {
            const data = await api(endpoints.factoryReset, {
              method: "POST",
              timeoutMs: 30000,
              body: JSON.stringify({
                   confirm: "LONG_FACTORY_RESET_CONFIRMED",
                   confirmed: "LONG_FACTORY_RESET_CONFIRMED",
                   confirmation: "LONG_FACTORY_RESET_CONFIRMED",
                   force,
                   forceClosePositions: force,


                   side: DASHBOARD_SIDE,
                   tradeSide: ONLY_SIDE,
                   targetTradeSide: ONLY_SIDE,


                   longOnly: true,
                   shortDisabled: true,
                   trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
                   parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
                   persistentLearningKey: PERSISTENT_LEARNING_KEY,
                   redisNamespace: LONG_NAMESPACE,
                   redisKeyPrefix: LONG_KEY_PREFIX
               })
             });


             $("resetResult").textContent = JSON.stringify(data, null, 2);
             setMessage("LONG factory reset uitgevoerd.", "ok");
        } catch (error) {
             setMessage(friendlyApiMessage(error), "warn");
        }
    }


    function showTab(id) {
        const next = tabs.includes(id) ? id : "overview";


        state.activeTab = next;


        document.querySelectorAll(".panel").forEach((panel) =>
panel.classList.add("hidden"));
        document.querySelectorAll(".tab").forEach((tab) =>
tab.classList.remove("active"));


        $(next).classList.remove("hidden");
        document.querySelector(`[data-tab="${next}"]`)?.classList.add("active");


        location.hash = next;
        refresh(next);
    }


    function renderSoftError(tab, error) {
        const message = friendlyApiMessage(error);


        setMessage(message, "warn");


        $(tab).innerHTML = `
             <div class="card">
               <h3>Niet geladen</h3>
               <div class="empty">${escapeHtml(message)}</div>
             </div>
        `;
    }


    async function refresh(tab = state.activeTab) {
        setMessage("");
        $("liveLabel").textContent = `LONG-only · broad learning · adaptive
selection · ${new Date().toLocaleTimeString()}`;


        try {
             if (tab === "overview") return await renderOverview();
            if (tab === "market") return await renderMarket();
            if (tab === "scanner") return await renderScanner();
            if (tab === "trade") return await renderTrade();
            if (tab === "micros") return await renderMicros();
            if (tab === "winners") return await renderWinners();
            if (tab === "rotation") return await renderRotation();
            if (tab === "discord") return await renderDiscord();
            if (tab === "reset") return renderReset();
        } catch (error) {
            renderSoftError(tab, error);
        }
    }


    document.querySelectorAll(".tab").forEach((button) => {
        button.addEventListener("click", () => showTab(button.dataset.tab));
    });


    $("refreshBtn").addEventListener("click", () => refresh(state.activeTab));


    window.addEventListener("error", (event) => {
        setMessage(event.message || "Browser error", "error");
    });


    window.addEventListener("unhandledrejection", (event) => {
        setMessage(friendlyApiMessage(event.reason), "warn");
    });


    const initialTab = location.hash.replace("#", "") || "overview";
    showTab(tabs.includes(initialTab) ? initialTab : "overview");
  </script>
</body>
</html>

