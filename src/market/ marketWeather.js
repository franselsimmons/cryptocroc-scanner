// ================= FILE: src/market/marketWeather.js =================
//
// MarketWeatherEngine.
//
// Belangrijke bouwregel:
// - Dit bestand berekent marktcontext en soft currentFit.
// - Dit bestand blokkeert GEEN virtual/shadow learning.
// - Dit bestand activeert GEEN adaptiveScore, recentMomentumScore of parent-diversificatie.
// - Selection/rotation/Discord mogen dit later gebruiken.
// - Learning blijft breed.
//
// Meetlat-regel:
// - Geen nieuwe architectuur bouwen bovenop vervuilde data.
// - Deze engine schrijft alleen context/fit-metadata.
// - completed, avgCostR, directSL en seen-dedupe blijven de verantwoordelijkheid van
//   analyzeEngine/scoring/positionEngine/costModel.

import { CONFIG } from '../config.js';
import { KEYS } from '../keys.js';
import { getDurableRedis, getJson, setJson } from '../redis.js';
import { clamp, safeNumber, sideToTradeSide } from '../utils.js';

const MARKET_WEATHER_VERSION = 'MARKET_WEATHER_ENGINE_V1';
const MEASUREMENT_FIX_VERSION = 'MEASUREMENT_FIRST_AVGCOST_DIRECTSL_SEEN_DEDUPE_V1';

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

const LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
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
  LONG: 'LONG',
  SHORT: 'SHORT',
  NEUTRAL: 'NEUTRAL',
  UNKNOWN: 'UNKNOWN'
});

const FLOW_STATE = Object.freeze({
  FLOW_WITH_LONG: 'FLOW_WITH_LONG',
  FLOW_WITH_SHORT: 'FLOW_WITH_SHORT',
  FLOW_MIXED: 'FLOW_MIXED',
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
  STRONG_FIT: 'STRONG_FIT',
  FIT: 'FIT',
  MIXED: 'MIXED',
  MISFIT: 'MISFIT',
  UNKNOWN: 'UNKNOWN'
});

const DEFAULT_UNIVERSE_LIMIT = 100;
const DEFAULT_MIN_UNIVERSE_SIZE = 15;
const DEFAULT_STALE_AFTER_MS = 90_000;

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

function safeClamp(value, min = 0, max = 100) {
  const n = safeNumber(value, min);

  return clamp(n, min, max);
}

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }

  return null;
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
    Math.floor(configNumber(['long', 'marketWeather', 'universeLimit'], configNumber(['marketWeather', 'universeLimit'], DEFAULT_UNIVERSE_LIMIT)))
  );
}

function minUniverseSize() {
  return Math.max(
    1,
    Math.floor(configNumber(['long', 'marketWeather', 'minUniverseSize'], configNumber(['marketWeather', 'minUniverseSize'], DEFAULT_MIN_UNIVERSE_SIZE)))
  );
}

function staleAfterMs() {
  return Math.max(
    10_000,
    Math.floor(configNumber(['long', 'marketWeather', 'staleAfterMs'], configNumber(['marketWeather', 'staleAfterMs'], DEFAULT_STALE_AFTER_MS)))
  );
}

function keyCandidate(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.trim() || null;

  return null;
}

function defaultUniverseKeys() {
  return uniqueStrings([
    keyCandidate(KEYS.market?.universeLatest),
    keyCandidate(KEYS.market?.universe),
    keyCandidate(KEYS.long?.market?.universeLatest),
    keyCandidate(KEYS.long?.scan?.universeLatest),
    keyCandidate(KEYS.scanner?.universeLatest),
    keyCandidate(KEYS.scan?.universeLatest),
    keyCandidate(KEYS.long?.scan?.latest),
    keyCandidate(KEYS.scan?.latest),

    'MARKET:UNIVERSE:LATEST',
    'MARKET:SCANNER:UNIVERSE:LATEST',
    'LONG:MARKET:UNIVERSE:LATEST',
    'LONG:SCAN:LATEST',
    'LONG:SCANNER:LATEST'
  ]);
}

function defaultWeatherKeys() {
  return uniqueStrings([
    keyCandidate(KEYS.market?.weatherLatest),
    keyCandidate(KEYS.market?.weather),
    keyCandidate(KEYS.long?.market?.weatherLatest),
    keyCandidate(KEYS.long?.market?.weather),

    'MARKET:WEATHER:LATEST',
    'LONG:MARKET:WEATHER:LATEST'
  ]);
}

function normalizeTradeSide(value = '') {
  const raw = upper(value);

  if (!raw) return 'UNKNOWN';

  const direct = sideToTradeSide(raw);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  if (['LONG', 'BULL', 'BULLISH', 'BUY', 'BID', 'UP', 'UPSIDE', 'GREEN'].includes(raw)) {
    return TARGET_TRADE_SIDE;
  }

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'ASK', 'DOWN', 'DOWNSIDE', 'RED'].includes(raw)) {
    return OPPOSITE_TRADE_SIDE;
  }

  if (raw.includes('MICRO_LONG_') || raw.includes('TRADE_SIDE=LONG') || raw.includes('TRADESIDE=LONG')) {
    return TARGET_TRADE_SIDE;
  }

  if (raw.includes('MICRO_SHORT_') || raw.includes('TRADE_SIDE=SHORT') || raw.includes('TRADESIDE=SHORT')) {
    return OPPOSITE_TRADE_SIDE;
  }

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
    baseSymbol: normalizeSymbol(row.baseSymbol || symbol.replace(/USDT$|USDC$|USD$/g, '')),
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

  if (input.tickers && typeof input.tickers === 'object') return Object.values(input.tickers);
  if (input.rows && typeof input.rows === 'object') return Object.values(input.rows);
  if (input.universe && typeof input.universe === 'object') return Object.values(input.universe);
  if (input.candidates && typeof input.candidates === 'object') return Object.values(input.candidates);

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

  if (
    btc.change1h > t.btcTrend1hPct &&
    btc.change24h > t.btcTrend24hPct
  ) {
    return TREND_SIDE.LONG;
  }

  if (
    btc.change1h < -t.btcTrend1hPct &&
    btc.change24h < -t.btcTrend24hPct
  ) {
    return TREND_SIDE.SHORT;
  }

  return TREND_SIDE.NEUTRAL;
}

function classifyTickerDirection(row, t = thresholds()) {
  const advancing =
    row.change1h > t.advancing1hPct &&
    row.change24h > t.advancing24hPct;

  const declining =
    row.change1h < t.declining1hPct &&
    row.change24h < t.declining24hPct;

  const strongBullish =
    row.change1h > t.strongBullish1hPct ||
    row.change24h > t.strongBullish24hPct;

  const strongBearish =
    row.change1h < t.strongBearish1hPct ||
    row.change24h < t.strongBearish24hPct;

  return {
    advancing,
    declining,
    neutral: !advancing && !declining,
    strongBullish,
    strongBearish
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
  strongBullishRatio,
  strongBearishRatio,
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

  const strongDominance = Math.max(strongBullishRatio, strongBearishRatio);
  confidence += clamp(strongDominance * 50, 0, 15);

  const directionalMedian =
    Math.abs(medianChange1h) > 0.1 ||
    Math.abs(medianChange24h) > 0.3;

  if (directionalMedian) confidence += 8;

  if (currentRegime === WEATHER_REGIME.SQUEEZE && volatilityState === VOLATILITY_STATE.COMPRESSION) {
    confidence += 12;
  }

  if (currentRegime === WEATHER_REGIME.TREND && currentTrendSide !== TREND_SIDE.NEUTRAL) {
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
  strongBullishCount,
  strongBearishCount,
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
  const strongBullishRatio = sampleSize > 0 ? strongBullishCount / sampleSize : 0;
  const strongBearishRatio = sampleSize > 0 ? strongBearishCount / sampleSize : 0;
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
      strongBullishRatio,
      strongBearishRatio,
      medianChange1h,
      medianChange24h,
      volatilityState,
      currentRegime: WEATHER_REGIME.SQUEEZE,
      currentTrendSide: TREND_SIDE.NEUTRAL
    });

    return {
      currentRegime: WEATHER_REGIME.SQUEEZE,
      currentTrendSide: TREND_SIDE.NEUTRAL,
      currentFlow: FLOW_STATE.FLOW_MIXED,
      currentVolatilityState: volatilityState,
      currentBtcRelation: btcTrendSide === TREND_SIDE.UNKNOWN ? 'BTC_UNKNOWN' : 'BTC_MIXED',
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
      strongBullishRatio,
      strongBearishRatio,
      medianChange1h,
      medianChange24h,
      volatilityState,
      currentRegime: WEATHER_REGIME.TREND,
      currentTrendSide: TREND_SIDE.LONG
    });

    return {
      currentRegime: WEATHER_REGIME.TREND,
      currentTrendSide: TREND_SIDE.LONG,
      currentFlow: FLOW_STATE.FLOW_WITH_LONG,
      currentVolatilityState: volatilityState,
      currentBtcRelation: 'BTC_WITH_LONG',
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
      strongBullishRatio,
      strongBearishRatio,
      medianChange1h,
      medianChange24h,
      volatilityState,
      currentRegime: WEATHER_REGIME.TREND,
      currentTrendSide: TREND_SIDE.SHORT
    });

    return {
      currentRegime: WEATHER_REGIME.TREND,
      currentTrendSide: TREND_SIDE.SHORT,
      currentFlow: FLOW_STATE.FLOW_WITH_SHORT,
      currentVolatilityState: volatilityState,
      currentBtcRelation: 'BTC_AGAINST_LONG',
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
    strongBullishRatio,
    strongBearishRatio,
    medianChange1h,
    medianChange24h,
    volatilityState,
    currentRegime: WEATHER_REGIME.CHOP,
    currentTrendSide: TREND_SIDE.NEUTRAL
  });

  return {
    currentRegime: WEATHER_REGIME.CHOP,
    currentTrendSide: TREND_SIDE.NEUTRAL,
    currentFlow: FLOW_STATE.FLOW_MIXED,
    currentVolatilityState: volatilityState,
    currentBtcRelation: btcTrendSide === TREND_SIDE.UNKNOWN
      ? 'BTC_UNKNOWN'
      : btcTrendSide === TREND_SIDE.LONG
        ? 'BTC_MIXED_LONG'
        : btcTrendSide === TREND_SIDE.SHORT
          ? 'BTC_MIXED_SHORT'
          : 'BTC_MIXED',
    confidence
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
    version: MARKET_WEATHER_VERSION,
    reason,
    source,
    sourceKey,

    generatedAt: ts,
    updatedAt: ts,

    currentRegime: WEATHER_REGIME.UNKNOWN,
    currentTrendSide: TREND_SIDE.UNKNOWN,
    currentBtcRelation: 'BTC_UNKNOWN',
    currentFlow: FLOW_STATE.FLOW_UNKNOWN,
    currentVolatilityState: VOLATILITY_STATE.UNKNOWN,
    currentMarketFitConfidence: 0,
    confidence: 0,

    cacheHealthy: false,
    sampleSize: 0,
    universeSize: 0,

    breadth: {
      advancingCount: 0,
      decliningCount: 0,
      neutralCount: 0,
      strongBullishCount: 0,
      strongBearishCount: 0,
      advanceRatio: 0,
      declineRatio: 0,
      neutralRatio: 0,
      strongBullishRatio: 0,
      strongBearishRatio: 0,
      medianChange1h: 0,
      medianChange24h: 0,
      medianAbs1h: 0,
      medianAbs24h: 0,
      medianRangePct: 0,
      change24hDispersion: 0
    },

    btc: {
      symbol: null,
      change1h: 0,
      change24h: 0,
      trendSide: TREND_SIDE.UNKNOWN
    },

    thresholds: thresholds(),

    softOnly: true,
    blocksLearning: false,
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    learningRemainsBroad: true,
    selectionWillBeAdaptive: true,
    discordWillBeStrict: true,

    adaptiveLayerBuilt: false,
    adaptiveScoreBuilt: false,
    recentMomentumScoreBuilt: false,
    currentFitScoreBuilt: false,
    parentDiversificationBuilt: false,

    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    avgCostRRequiredBeforeAdaptiveSelection: true,
    directSLRequiredBeforeAdaptiveSelection: true,
    observationDedupeRequiredBeforeAdaptiveSelection: true,

    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY
  };
}

export function buildMarketWeatherFromTickers(tickers = [], {
  source = 'DIRECT_INPUT',
  sourceKey = null,
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
  let strongBullishCount = 0;
  let strongBearishCount = 0;

  for (const row of universe) {
    const direction = classifyTickerDirection(row, t);

    if (direction.advancing) advancingCount += 1;
    if (direction.declining) decliningCount += 1;
    if (direction.neutral) neutralCount += 1;
    if (direction.strongBullish) strongBullishCount += 1;
    if (direction.strongBearish) strongBearishCount += 1;
  }

  const change1hValues = universe.map((row) => row.change1h);
  const change24hValues = universe.map((row) => row.change24h);
  const abs1hValues = universe.map((row) => row.absChange1h);
  const abs24hValues = universe.map((row) => row.absChange24h);
  const rangeValues = universe.map((row) => Math.max(row.rangePct, row.atrPct, row.realizedVolPct, 0));

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
    strongBullishCount,
    strongBearishCount,
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
  const strongBullishRatio = sampleSize > 0 ? strongBullishCount / sampleSize : 0;
  const strongBearishRatio = sampleSize > 0 ? strongBearishCount / sampleSize : 0;

  return {
    ok: true,
    version: MARKET_WEATHER_VERSION,
    source,
    sourceKey,

    generatedAt,
    updatedAt: generatedAt,

    currentRegime: classified.currentRegime,
    currentTrendSide: classified.currentTrendSide,
    currentBtcRelation: classified.currentBtcRelation,
    currentFlow: classified.currentFlow,
    currentVolatilityState: classified.currentVolatilityState,
    currentMarketFitConfidence: classified.confidence,
    confidence: classified.confidence,

    cacheHealthy,
    sampleSize,
    universeSize: normalized.length,
    universeLimit: limit,

    breadth: {
      advancingCount,
      decliningCount,
      neutralCount,
      strongBullishCount,
      strongBearishCount,

      advanceRatio: round4(advanceRatio),
      declineRatio: round4(declineRatio),
      neutralRatio: round4(neutralRatio),
      strongBullishRatio: round4(strongBullishRatio),
      strongBearishRatio: round4(strongBearishRatio),

      medianChange1h: round4(medianChange1h),
      medianChange24h: round4(medianChange24h),
      medianAbs1h: round4(medianAbs1h),
      medianAbs24h: round4(medianAbs24h),
      medianRangePct: round4(medianRangePct),
      meanChange1h: round4(mean(change1hValues)),
      meanChange24h: round4(mean(change24hValues)),
      change24hDispersion: round4(change24hDispersion)
    },

    btc: {
      symbol: btc?.symbol || null,
      change1h: round4(btc?.change1h || 0),
      change24h: round4(btc?.change24h || 0),
      trendSide: btcTrendSide
    },

    thresholds: t,

    softOnly: true,
    blocksLearning: false,
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    learningRemainsBroad: true,
    selectionWillBeAdaptive: true,
    discordWillBeStrict: true,

    adaptiveLayerBuilt: false,
    adaptiveScoreBuilt: false,
    recentMomentumScoreBuilt: false,
    currentFitScoreBuilt: false,
    parentDiversificationBuilt: false,

    measurementFixVersion: MEASUREMENT_FIX_VERSION,
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

    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY
  };
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
          cacheUpdatedAt: safeNumber(payload?.updatedAt || payload?.generatedAt || payload?.ts, 0)
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
  weather.cacheAgeMs = cacheUpdatedAt > 0 ? Math.max(0, generatedAt - cacheUpdatedAt) : null;
  weather.cacheStale = cacheUpdatedAt > 0 ? generatedAt - cacheUpdatedAt > staleAfterMs() : false;

  if (save) {
    await saveMarketWeather(weather, {
      redis
    });
  }

  return weather;
}

export async function saveMarketWeather(weather, {
  redis = getDurableRedis(),
  keys = defaultWeatherKeys()
} = {}) {
  const payload = {
    ...weather,
    savedAt: now(),
    version: MARKET_WEATHER_VERSION,

    softOnly: true,
    blocksLearning: false,
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    learningRemainsBroad: true,
    selectionWillBeAdaptive: true,
    discordWillBeStrict: true,

    adaptiveLayerBuilt: false,
    adaptiveScoreBuilt: false,
    recentMomentumScoreBuilt: false,
    currentFitScoreBuilt: false,
    parentDiversificationBuilt: false
  };

  const savedKeys = [];

  for (const key of keys) {
    try {
      await setJson(redis, key, payload);
      savedKeys.push(key);
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
      const weather = await getJson(redis, key, null);

      if (!weather) continue;

      const generatedAt = safeNumber(weather.generatedAt || weather.updatedAt || weather.savedAt, 0);
      const ageMs = generatedAt > 0 ? now() - generatedAt : null;
      const stale = ageMs !== null ? ageMs > maxAgeMs : true;

      return {
        ...weather,
        loadedFromKey: key,
        loadedAt: now(),
        ageMs,
        stale,
        softOnly: true,
        blocksLearning: false,
        currentFitSoftOnly: true,
        currentFitBlocksLearning: false
      };
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
  const regime = weather.currentRegime;
  const trendSide = weather.currentTrendSide;
  const volState = weather.currentVolatilityState;

  if (!setup) return 0;

  if (setup === 'COMPRESSION') {
    if (regime === WEATHER_REGIME.SQUEEZE || volState === VOLATILITY_STATE.COMPRESSION) return 22;
    if (regime === WEATHER_REGIME.CHOP) return 10;
    return -8;
  }

  if (setup === 'BREAKOUT') {
    if (regime === WEATHER_REGIME.TREND && trendSide === TARGET_TRADE_SIDE) return 20;
    if (regime === WEATHER_REGIME.SQUEEZE) return 12;
    if (volState === VOLATILITY_STATE.EXPANSION) return 10;
    if (trendSide === OPPOSITE_TRADE_SIDE) return -18;
    return 0;
  }

  if (setup === 'CONTINUATION') {
    if (regime === WEATHER_REGIME.TREND && trendSide === TARGET_TRADE_SIDE) return 24;
    if (trendSide === OPPOSITE_TRADE_SIDE) return -22;
    if (regime === WEATHER_REGIME.CHOP) return -4;
    return 4;
  }

  if (setup === 'RETEST') {
    if (regime === WEATHER_REGIME.TREND && trendSide === TARGET_TRADE_SIDE) return 18;
    if (regime === WEATHER_REGIME.CHOP) return 8;
    if (trendSide === OPPOSITE_TRADE_SIDE) return -14;
    return 2;
  }

  if (setup === 'SWEEP_REVERSAL') {
    if (regime === WEATHER_REGIME.CHOP) return 15;
    if (regime === WEATHER_REGIME.SQUEEZE) return 8;
    if (regime === WEATHER_REGIME.TREND && trendSide === TARGET_TRADE_SIDE) return 5;
    if (trendSide === OPPOSITE_TRADE_SIDE) return -8;
    return 0;
  }

  return 0;
}

function regimeFitScore({
  familyRegime,
  weather
}) {
  const regime = weather.currentRegime;
  const trendSide = weather.currentTrendSide;

  if (!familyRegime || regime === WEATHER_REGIME.UNKNOWN) return 0;

  if (familyRegime === regime) {
    if (regime === WEATHER_REGIME.TREND && trendSide === TARGET_TRADE_SIDE) return 35;
    if (regime === WEATHER_REGIME.TREND && trendSide === OPPOSITE_TRADE_SIDE) return -35;
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
  const trendSide = weather.currentTrendSide;
  const confidence = safeNumber(weather.currentMarketFitConfidence ?? weather.confidence, 0);

  if (!confirmationProfile) return 0;

  if (confirmationProfile === 'A_STRONG_ALIGN') {
    if (trendSide === TARGET_TRADE_SIDE && confidence >= 60) return 16;
    if (trendSide === OPPOSITE_TRADE_SIDE && confidence >= 55) return -22;
    return 4;
  }

  if (confirmationProfile === 'B_FLOW_ALIGN') {
    if (trendSide === TARGET_TRADE_SIDE) return 12;
    if (trendSide === OPPOSITE_TRADE_SIDE) return -18;
    return 2;
  }

  if (confirmationProfile === 'C_VOLUME_ALIGN') {
    if (weather.currentVolatilityState === VOLATILITY_STATE.EXPANSION) return 10;
    if (weather.currentVolatilityState === VOLATILITY_STATE.COMPRESSION) return 2;
    return 4;
  }

  if (confirmationProfile === 'D_MIXED_OK') {
    if (weather.currentRegime === WEATHER_REGIME.CHOP) return 8;
    return 0;
  }

  if (confirmationProfile === 'E_WEAK_CONTRA') {
    if (trendSide === OPPOSITE_TRADE_SIDE) return -5;
    return -12;
  }

  return 0;
}

function fitLabel(score) {
  const n = safeNumber(score, 0);

  if (n >= 75) return FIT_LABEL.STRONG_FIT;
  if (n >= 58) return FIT_LABEL.FIT;
  if (n >= 38) return FIT_LABEL.MIXED;
  if (n > 0) return FIT_LABEL.MISFIT;

  return FIT_LABEL.UNKNOWN;
}

export function computeCurrentFit(rowOrMicroId = {}, weather = null) {
  const weatherRow = weather || emptyWeather({
    reason: 'NO_WEATHER_FOR_FIT',
    source: 'COMPUTE_CURRENT_FIT'
  });

  const microFamilyId = typeof rowOrMicroId === 'string'
    ? rowOrMicroId
    : microIdFromRow(rowOrMicroId);

  const parsed = parseTaxonomyMicroId(microFamilyId);

  if (!parsed.valid || !parsed.isChild) {
    return {
      currentFit: 0,
      currentFitLabel: FIT_LABEL.UNKNOWN,
      currentFitReason: 'NO_EXACT_75_CHILD_MICRO_ID',
      currentFitConfidence: 0,
      currentFitMatchedFamily: null,
      currentFitBlocksLearning: false,
      currentFitSoftOnly: true,
      learningRemainsBroad: true,
      selectionWillBeAdaptive: true,
      discordWillBeStrict: true
    };
  }

  const tradeSide = parsed.tradeSide || normalizeTradeSide(rowOrMicroId.tradeSide);

  if (tradeSide !== TARGET_TRADE_SIDE) {
    return {
      currentFit: 0,
      currentFitLabel: FIT_LABEL.MISFIT,
      currentFitReason: 'NON_LONG_FAMILY_FOR_LONG_WEATHER',
      currentFitConfidence: safeNumber(weatherRow.currentMarketFitConfidence ?? weatherRow.confidence, 0),
      currentFitMatchedFamily: parsed.childTrueMicroFamilyId,
      currentFitBlocksLearning: false,
      currentFitSoftOnly: true,
      learningRemainsBroad: true,
      selectionWillBeAdaptive: true,
      discordWillBeStrict: true
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

  const confidence = safeNumber(weatherRow.currentMarketFitConfidence ?? weatherRow.confidence, 0);
  const confidenceAdjustment = clamp((confidence - 50) / 5, -8, 10);

  const rawScore = base + regimeScore + setupScore + confirmationScore + confidenceAdjustment;
  const currentFit = Math.round(clamp(rawScore, 0, 100));

  return {
    currentFit,
    currentFitLabel: fitLabel(currentFit),
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
    currentFitSoftOnly: true,
    learningRemainsBroad: true,
    selectionWillBeAdaptive: true,
    discordWillBeStrict: true
  };
}

export function compactMarketWeatherForEntry(weather = {}) {
  return {
    version: weather.version || MARKET_WEATHER_VERSION,
    generatedAt: weather.generatedAt || weather.updatedAt || null,

    currentRegime: weather.currentRegime || WEATHER_REGIME.UNKNOWN,
    currentTrendSide: weather.currentTrendSide || TREND_SIDE.UNKNOWN,
    currentBtcRelation: weather.currentBtcRelation || 'BTC_UNKNOWN',
    currentFlow: weather.currentFlow || FLOW_STATE.FLOW_UNKNOWN,
    currentVolatilityState: weather.currentVolatilityState || VOLATILITY_STATE.UNKNOWN,
    currentMarketFitConfidence: safeNumber(weather.currentMarketFitConfidence ?? weather.confidence, 0),

    cacheHealthy: Boolean(weather.cacheHealthy),
    cacheStale: Boolean(weather.cacheStale),
    sampleSize: safeNumber(weather.sampleSize, 0),

    breadth: {
      advanceRatio: safeNumber(weather.breadth?.advanceRatio, 0),
      declineRatio: safeNumber(weather.breadth?.declineRatio, 0),
      neutralRatio: safeNumber(weather.breadth?.neutralRatio, 0),
      medianChange1h: safeNumber(weather.breadth?.medianChange1h, 0),
      medianChange24h: safeNumber(weather.breadth?.medianChange24h, 0),
      change24hDispersion: safeNumber(weather.breadth?.change24hDispersion, 0)
    },

    btc: {
      symbol: weather.btc?.symbol || null,
      change1h: safeNumber(weather.btc?.change1h, 0),
      change24h: safeNumber(weather.btc?.change24h, 0),
      trendSide: weather.btc?.trendSide || TREND_SIDE.UNKNOWN
    },

    softOnly: true,
    blocksLearning: false,
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    learningRemainsBroad: true
  };
}

export function annotateWithCurrentFit(row = {}, weather = {}) {
  const fit = computeCurrentFit(row, weather);
  const entryMarketWeather = compactMarketWeatherForEntry(weather);

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
    currentFitAffectsSelectionOnly: true,
    learningRemainsBroad: true,
    selectionWillBeAdaptive: true,
    discordWillBeStrict: true,

    adaptiveScoreBuilt: false,
    adaptiveScore: row.adaptiveScore ?? null,
    currentFitScoreBuilt: false,

    measurementFixVersion: MEASUREMENT_FIX_VERSION
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
      return loaded;
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

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitAffectsSelectionOnly: true,

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

    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    avgCostRRequiredBeforeAdaptiveSelection: true,
    directSLRequiredBeforeAdaptiveSelection: true,
    observationDedupeRequiredBeforeAdaptiveSelection: true,

    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX
  };
}

export {
  MARKET_WEATHER_VERSION,
  WEATHER_REGIME,
  TREND_SIDE,
  FLOW_STATE,
  VOLATILITY_STATE,
  FIT_LABEL
};