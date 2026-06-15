// ================= FILE: api/admin/market-weather.js =================
//
// Admin API voor MarketWeather.
//
// Doel:
// - admin.html kan GEEN src/market/marketWeather.js direct lezen.
// - Deze route geeft MarketWeather via /api/admin/market-weather.
// - Geen learning blokkeren.
// - Geen adaptiveScore activeren.
// - Geen reset.
// - Alleen marktcontext + CurrentFit metadata tonen.

import {
  getMarketWeather,
  loadMarketWeather,
  buildMarketWeather,
  marketWeatherIdentityFlags
} from '../../src/market/marketWeather.js';

import { getDurableRedis } from '../../src/redis.js';

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

const MEASUREMENT_FIX_VERSION = 'LONG_MEASUREMENT_FIX_AVGCOST_DIRECTSL_SEEN_DEDUPE_V1';
const ADMIN_ROUTE_VERSION = 'LONG_ADMIN_MARKET_WEATHER_ROUTE_V1';

function now() {
  return Date.now();
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

function ageMsFromTs(ts) {
  const n = Number(ts);

  if (!Number.isFinite(n) || n <= 0) return null;

  return Math.max(0, now() - n);
}

function asQuery(req) {
  if (req?.query && typeof req.query === 'object') return req.query;

  try {
    const url = new URL(req.url || '', 'http://localhost');
    return Object.fromEntries(url.searchParams.entries());
  } catch {
    return {};
  }
}

function methodAllowed(req) {
  const method = String(req?.method || 'GET').toUpperCase();
  return method === 'GET' || method === 'POST' || method === 'OPTIONS';
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.end(JSON.stringify(payload, null, 2));
}

function normalizeTrendSideForAdmin(value) {
  const raw = upper(value);

  if (['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'UPSIDE'].includes(raw)) return 'LONG';
  if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE'].includes(raw)) return 'SHORT';
  if (['NEUTRAL', 'MIXED', 'CHOP', 'SIDEWAYS', 'FLAT'].includes(raw)) return 'NEUTRAL';

  return raw || 'UNKNOWN';
}

function dashboardTrendSide(value) {
  const side = normalizeTrendSideForAdmin(value);

  if (side === 'LONG') return 'BULL';
  if (side === 'SHORT') return 'BEAR';
  if (side === 'NEUTRAL') return 'MIXED';

  return 'UNKNOWN';
}

function normalizeRegime(value) {
  const raw = upper(value);

  if (raw.includes('TREND')) return 'TREND';
  if (raw.includes('SQUEEZE') || raw.includes('COMPRESSION')) return 'SQUEEZE';
  if (raw.includes('CHOP') || raw.includes('RANGE') || raw.includes('SIDEWAYS')) return 'CHOP';

  return raw || 'UNKNOWN';
}

function normalizeBreadthPct(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return null;

  if (Math.abs(n) <= 1) return Number((n * 100).toFixed(2));

  return Number(n.toFixed(2));
}

function deriveBreadth(weather = {}) {
  const breadth = weather.breadth || {};

  const bullishPct = firstFinite(
    weather.bullishPct,
    weather.longPct,
    weather.upPct,
    weather.breadthBullishPct,
    breadth.bullishPct,
    breadth.longPct,
    breadth.upPct,
    breadth.advancePct,
    breadth.advanceRatio
  );

  const bearishPct = firstFinite(
    weather.bearishPct,
    weather.shortPct,
    weather.downPct,
    weather.breadthBearishPct,
    breadth.bearishPct,
    breadth.shortPct,
    breadth.downPct,
    breadth.declinePct,
    breadth.declineRatio
  );

  const neutralPct = firstFinite(
    weather.neutralPct,
    weather.flatPct,
    breadth.neutralPct,
    breadth.flatPct,
    breadth.neutralRatio
  );

  const squeezePct = firstFinite(
    weather.squeezePct,
    weather.compressionPct,
    breadth.squeezePct,
    breadth.compressionPct
  );

  return {
    bullishPct: normalizeBreadthPct(bullishPct),
    bearishPct: normalizeBreadthPct(bearishPct),
    neutralPct: normalizeBreadthPct(neutralPct),
    squeezePct: normalizeBreadthPct(squeezePct)
  };
}

function safeWeatherObject(weather = {}) {
  if (!weather || typeof weather !== 'object') return {};

  return weather;
}

function normalizeForAdmin(weatherInput = {}) {
  const weather = safeWeatherObject(weatherInput);
  const flags = marketWeatherIdentityFlags();

  const generatedAt = firstFinite(
    weather.generatedAt,
    weather.updatedAt,
    weather.savedAt,
    weather.loadedAt,
    weather.completedAt,
    weather.createdAt,
    weather.ts
  );

  const updatedAt = firstFinite(
    weather.updatedAt,
    weather.savedAt,
    weather.generatedAt,
    weather.loadedAt,
    weather.completedAt,
    weather.createdAt,
    weather.ts
  );

  const ageMs = firstFinite(weather.ageMs, ageMsFromTs(generatedAt), ageMsFromTs(updatedAt));

  const currentRegime = normalizeRegime(
    weather.currentRegime ||
      weather.regime ||
      weather.marketRegime ||
      weather.breadthRegime
  );

  const currentTrendSide = normalizeTrendSideForAdmin(
    weather.currentTrendSide ||
      weather.trendSide ||
      weather.marketTrendSide ||
      weather.marketSide ||
      weather.side ||
      weather.direction
  );

  const confidence = Math.max(
    0,
    Math.min(
      100,
      num(
        weather.currentMarketFitConfidence ??
          weather.confidence ??
          weather.weatherConfidence ??
          weather.currentTrendConfidence,
        0
      )
    )
  );

  const sampleSize = num(
    weather.sampleSize ??
      weather.universeSize ??
      weather.universeCount ??
      weather.count,
    0
  );

  const breadthPct = deriveBreadth(weather);

  const ok =
    weather.ok !== false &&
    weather.available !== false &&
    (
      sampleSize > 0 ||
      currentRegime !== 'UNKNOWN' ||
      currentTrendSide !== 'UNKNOWN'
    );

  const available = ok;

  const normalized = {
    ...weather,

    ok,
    available,

    adminRouteVersion: ADMIN_ROUTE_VERSION,

    file: 'src/market/marketWeather.js',
    apiRoute: '/api/admin/market-weather',

    targetTradeSide: TARGET_TRADE_SIDE,
    targetDashboardSide: TARGET_DASHBOARD_SIDE,
    targetScannerSide: TARGET_SCANNER_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,

    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

    measurementFixVersion: MEASUREMENT_FIX_VERSION,

    currentRegime,
    regime: currentRegime,

    currentTrendSide,
    trendSide: dashboardTrendSide(currentTrendSide),
    marketTrendSide: dashboardTrendSide(currentTrendSide),

    confidence,
    weatherConfidence: confidence,
    currentMarketFitConfidence: confidence,

    bullishPct: breadthPct.bullishPct,
    bearishPct: breadthPct.bearishPct,
    neutralPct: breadthPct.neutralPct,
    squeezePct: breadthPct.squeezePct,

    sampleSize,
    universeSize: num(weather.universeSize ?? weather.universeCount ?? weather.count, sampleSize),
    universeCount: num(weather.universeCount ?? weather.universeSize ?? weather.count, sampleSize),
    count: num(weather.count ?? sampleSize, sampleSize),

    generatedAt: generatedAt || null,
    updatedAt: updatedAt || generatedAt || null,
    createdAt: generatedAt || updatedAt || null,
    ageMs,

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    learningRemainsBroad: true,

    adaptiveLayerBuilt: false,
    adaptiveScoreBuilt: false,
    recentMomentumScoreBuilt: false,
    parentDiversificationBuilt: false,

    avgCostRRequiredBeforeAdaptiveSelection: true,
    directSLRequiredBeforeAdaptiveSelection: true,
    observationDedupeRequiredBeforeAdaptiveSelection: true,

    identityFlags: flags
  };

  if (!normalized.ok) {
    normalized.reason = normalized.reason || 'NO_VALID_MARKET_WEATHER';
  }

  return normalized;
}

function buildResponse({
  weather,
  source = 'UNKNOWN',
  refreshed = false,
  loadedOnly = false,
  query = {}
} = {}) {
  const normalized = normalizeForAdmin(weather);

  const marketUniverse =
    normalized.marketUniverse ||
    normalized.universe ||
    normalized.rows ||
    [];

  return {
    ok: normalized.ok,
    available: normalized.available,

    route: '/api/admin/market-weather',
    adminRouteVersion: ADMIN_ROUTE_VERSION,
    file: 'src/market/marketWeather.js',

    source,
    refreshed,
    loadedOnly,

    currentRegime: normalized.currentRegime,
    currentTrendSide: normalized.currentTrendSide,
    regime: normalized.regime,
    trendSide: normalized.trendSide,
    marketTrendSide: normalized.marketTrendSide,

    confidence: normalized.confidence,
    weatherConfidence: normalized.weatherConfidence,
    currentMarketFitConfidence: normalized.currentMarketFitConfidence,

    bullishPct: normalized.bullishPct,
    bearishPct: normalized.bearishPct,
    neutralPct: normalized.neutralPct,
    squeezePct: normalized.squeezePct,

    sampleSize: normalized.sampleSize,
    universeSize: normalized.universeSize,
    universeCount: normalized.universeCount,
    count: normalized.count,

    generatedAt: normalized.generatedAt,
    updatedAt: normalized.updatedAt,
    createdAt: normalized.createdAt,
    ageMs: normalized.ageMs,

    measurementFixVersion: MEASUREMENT_FIX_VERSION,

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

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,

    request: {
      includeUniverse: bool(query.includeUniverse, false),
      includeBreadth: bool(query.includeBreadth, false),
      includeCurrentFit: bool(query.includeCurrentFit, false),
      refresh: bool(query.refresh, false)
    },

    marketWeather: normalized,
    weather: normalized,
    currentMarketWeather: normalized,
    latest: normalized,
    snapshot: normalized,

    marketUniverse,
    universe: marketUniverse,

    raw: normalized
  };
}

export default async function handler(req, res) {
  if (!methodAllowed(req)) {
    return sendJson(res, 405, {
      ok: false,
      error: 'METHOD_NOT_ALLOWED',
      allowed: ['GET', 'POST', 'OPTIONS']
    });
  }

  if (String(req.method || '').toUpperCase() === 'OPTIONS') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return sendJson(res, 200, {
      ok: true
    });
  }

  const query = asQuery(req);

  const refresh = bool(query.refresh, false) || bool(query.force, false);
  const save = query.save === undefined ? true : bool(query.save, true);
  const allowStale = query.allowStale === undefined ? true : bool(query.allowStale, true);
  const loadOnly = bool(query.loadOnly, false);

  try {
    const redis = getDurableRedis();

    let weather;
    let source = 'getMarketWeather';

    if (loadOnly) {
      weather = await loadMarketWeather({
        redis
      });

      source = 'loadMarketWeather';
    } else if (refresh) {
      weather = await buildMarketWeather({
        redis,
        save
      });

      source = 'buildMarketWeather';
    } else {
      weather = await getMarketWeather({
        redis,
        refresh: false,
        save,
        allowStale
      });

      source = 'getMarketWeather';
    }

    const response = buildResponse({
      weather,
      source,
      refreshed: refresh,
      loadedOnly: loadOnly,
      query
    });

    return sendJson(res, 200, response);
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      available: false,

      error: 'MARKET_WEATHER_ADMIN_ROUTE_ERROR',
      message: error?.message || String(error),

      route: '/api/admin/market-weather',
      file: 'src/market/marketWeather.js',
      adminRouteVersion: ADMIN_ROUTE_VERSION,

      currentRegime: 'UNKNOWN',
      currentTrendSide: 'UNKNOWN',
      regime: 'UNKNOWN',
      trendSide: 'UNKNOWN',
      confidence: 0,

      currentFitSoftOnly: true,
      currentFitBlocksLearning: false,
      currentFitBlocksVirtualLearning: false,
      currentFitBlocksShadowLearning: false,
      learningRemainsBroad: true,

      measurementFixVersion: MEASUREMENT_FIX_VERSION
    });
  }
}