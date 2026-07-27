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
const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = TRUE_MICRO_SCHEMA;
const LEARNING_GRANULARITY = 
'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const MEASUREMENT_FIX_VERSION = 
'LONG_MEASUREMENT_FIX_AVGCOST_DIRECTSL_SEEN_DEDUPE_V1';
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
function normalizeWeatherForAdmin(weatherInput = {}) {
  const weather = weatherInput && typeof weatherInput === 'object'
    ? weatherInput
    : makeFallbackWeather('INVALID_WEATHER');
  const breadth = weather.breadth || {};
  const currentRegime = normalizeRegime(
    weather.currentRegime ||
    weather.regime ||
    weather.marketRegime ||
    weather.breadthRegime
  );
  const currentTrendSide = normalizeTrendSide(
    weather.currentTrendSide ||
    weather.trendSide ||
    weather.marketTrendSide ||
    weather.marketSide ||
    weather.side ||
    weather.direction
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
  return {
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
    ok: normalized.ok,
    available: normalized.available,
    route: '/api/admin/market-weather',
    adminRouteVersion: ADMIN_ROUTE_VERSION,
    file: 'src/market/marketWeather.js',
    ...extra,
    currentRegime: normalized.currentRegime,
    currentTrendSide: normalized.currentTrendSide,
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
    allowStale: true,
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