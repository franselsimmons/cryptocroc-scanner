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
const OPPOSITE_TRADE_SIDE = 'SHORT';

const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;

const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 80;

const CACHE_TTL_MS = {
  tickers: 20_000,
  candles: 45_000,
  orderBook: 4_000,
  funding: 60_000
};

const MARKET_PATH_PREFIXES = [
  '/api/v2/mix/market/'
];

const memoryCache = new Map();

let lastRequestAt = 0;

function now() {
  return Date.now();
}

function bitgetConfig() {
  return {
    baseUrl: CONFIG.bitget?.baseUrl || 'https://api.bitget.com',
    productType: CONFIG.bitget?.productType || 'USDT-FUTURES',
    timeoutMs: Math.max(500, safeNumber(CONFIG.bitget?.timeoutMs, DEFAULT_TIMEOUT_MS)),
    minRequestIntervalMs: Math.max(
      0,
      safeNumber(CONFIG.bitget?.minRequestIntervalMs, DEFAULT_MIN_REQUEST_INTERVAL_MS)
    ),
    cacheEnabled: CONFIG.bitget?.cacheEnabled !== false,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    namespace: LONG_NAMESPACE,
    keyPrefix: LONG_KEY_PREFIX,

    marketDataOnly: true,
    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true
  };
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
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, String(value)])
  );
}

function cacheKey(path, params = {}) {
  return JSON.stringify({
    namespace: LONG_NAMESPACE,
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
  return `${prefix}_${JSON.stringify(details).slice(0, 500)}`;
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

async function fetchJsonOnce(path, params = {}, timeoutMs = bitgetConfig().timeoutMs) {
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
        'user-agent': CONFIG.strategyVersion || 'LONG_ONLY_VIRTUAL_MF_TS_V1'
      },
      signal: controller.signal
    });

    const text = await response.text();
    const json = parseJsonText(text);

    if (!response.ok) {
      const error = new Error(bitgetErrorMessage(`BITGET_HTTP_${response.status}`, {
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

      const baseDelayMs = safeNumber(CONFIG.bitget?.retryDelayMs, 250);
      const jitterMs = Math.floor(Math.random() * 80);
      const delayMs = baseDelayMs * (attempt + 1) + jitterMs;

      await sleep(delayMs);
    }
  }

  throw lastError;
}

function isRisingTicker(change24h) {
  return safeNumber(change24h, 0) > 0;
}

function longCandidateMeta(change24h) {
  const rising = isRisingTicker(change24h);

  return {
    side: rising ? TARGET_DASHBOARD_SIDE : 'rejected',
    tradeSide: rising ? TARGET_TRADE_SIDE : 'UNKNOWN',
    scannerSide: rising ? TARGET_DASHBOARD_SIDE : 'UNKNOWN',
    actualScannerSide: rising ? TARGET_DASHBOARD_SIDE : 'UNKNOWN',
    positionSide: rising ? TARGET_TRADE_SIDE : 'UNKNOWN',
    direction: rising ? TARGET_TRADE_SIDE : 'UNKNOWN',

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    virtualLearning: true,
    virtualOnly: true,
    virtualTracked: true,

    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    exchangeCallsDisabled: true,

    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,

    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    shortRootTouched: false,

    isRising: rising,
    eligibleLongCandidate: rising,
    rejectReason: rising ? null : 'NOT_RISING_LONG_ONLY'
  };
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

      return Array.isArray(data) ? data : [];
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

  const rawChange = safeNumber(
    row.change24h ??
    row.changeUtc24h ??
    row.priceChangePercent ??
    row.priceChange24h ??
    row.chgUtc,
    0
  );

  const change24h = Math.abs(rawChange) <= 1
    ? rawChange * 100
    : rawChange;

  return {
    symbol: contractSymbol,
    contractSymbol,
    baseSymbol,
    price,
    volume24h: quoteVolume,
    change24h,

    ...longCandidateMeta(change24h),

    source: 'BITGET_MARKET_DATA',
    marketDataOnly: true,
    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    exchangeCallsDisabled: true,

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
  const contractSymbol = normalizeContractSymbol(symbol);
  const granularity = normalizeGranularity(timeframe);
  const safeLimit = Math.max(1, Math.min(Number(limit || 100), 1000));

  if (!contractSymbol) return [];

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
        timeframe,
        targetTradeSide: TARGET_TRADE_SIDE,
        dashboardSide: TARGET_DASHBOARD_SIDE,
        marketDataOnly: true,
        noRealOrders: true,
        error: lastError?.message || 'EMPTY'
      }));

      return [];
    }
  );
}

export async function fetchOrderBook(symbol) {
  const contractSymbol = normalizeContractSymbol(symbol);

  if (!contractSymbol) return null;

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
        targetTradeSide: TARGET_TRADE_SIDE,
        dashboardSide: TARGET_DASHBOARD_SIDE,
        marketDataOnly: true,
        noRealOrders: true,
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

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    virtualLearning: true,
    virtualOnly: true,
    virtualTracked: true,

    spreadPct: CONFIG.cost?.fallbackSpreadPct ?? 0.0008,
    spreadBps: safeNumber(CONFIG.cost?.fallbackSpreadPct ?? 0.0008, 0) * 10_000,

    depthMinUsd1p: 0,
    bidDepthUsd1p: 0,
    askDepthUsd1p: 0,

    imbalance: 0,
    orderbookImbalance: 0,
    longPressure: 0,
    shortPressure: 0,

    mid: 0,
    bestBid: 0,
    bestAsk: 0,

    fetchFailed: true,
    marketDataOnly: true,
    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    exchangeCallsDisabled: true,

    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    analyzeMicroFamiliesOnly: true,
    symbolExcludedFromFamilyId: true,

    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    shortRootTouched: false
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

  return {
    bias,
    obBias: bias,

    tradeSide: longAligned ? TARGET_TRADE_SIDE : 'UNKNOWN',
    scannerSide: longAligned ? TARGET_DASHBOARD_SIDE : 'UNKNOWN',
    actualScannerSide: longAligned ? TARGET_DASHBOARD_SIDE : 'UNKNOWN',
    side: longAligned ? TARGET_DASHBOARD_SIDE : 'unknown',
    positionSide: longAligned ? TARGET_TRADE_SIDE : 'UNKNOWN',
    direction: longAligned ? TARGET_TRADE_SIDE : 'UNKNOWN',

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    virtualLearning: true,
    virtualOnly: true,
    virtualTracked: true,

    spreadPct,
    spreadBps,

    depthMinUsd1p: Math.min(bidDepth, askDepth),
    bidDepthUsd1p: bidDepth,
    askDepthUsd1p: askDepth,

    imbalance,
    orderbookImbalance: imbalance,
    longPressure,
    shortPressure,

    mid,
    bestBid,
    bestAsk,

    fetchFailed: false,
    marketDataOnly: true,
    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    exchangeCallsDisabled: true,

    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,

    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    shortRootTouched: false
  };
}

export async function fetchFunding(symbol) {
  const contractSymbol = normalizeContractSymbol(symbol);

  if (!contractSymbol) {
    return {
      rate: 0,
      fetchFailed: true,

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      oppositeTradeSide: OPPOSITE_TRADE_SIDE,

      longOnly: true,
      shortDisabled: true,
      shortOnly: false,
      longDisabled: false,

      virtualLearning: true,
      virtualOnly: true,
      virtualTracked: true,

      marketDataOnly: true,
      noRealOrders: true,
      realOrdersDisabled: true,
      bitgetOrdersDisabled: true,
      exchangeOrdersDisabled: true,
      exchangeCallsDisabled: true,

      redisNamespace: LONG_NAMESPACE,
      redisKeyPrefix: LONG_KEY_PREFIX,
      shortRootTouched: false
    };
  }

  const params = {
    symbol: contractSymbol,
    productType: normalizeProductType()
  };

  return withCache(
    cacheKey('/api/v2/mix/market/current-fund-rate', params),
    CACHE_TTL_MS.funding,
    async () => {
      try {
        const data = await fetchJson('/api/v2/mix/market/current-fund-rate', params, {
          retries: 1
        });

        const row = Array.isArray(data) ? data[0] : data;

        return {
          rate: safeNumber(
            row?.fundingRate ??
            row?.fundRate ??
            row?.rate,
            0
          ),
          fetchFailed: false,

          targetTradeSide: TARGET_TRADE_SIDE,
          dashboardSide: TARGET_DASHBOARD_SIDE,
          oppositeTradeSide: OPPOSITE_TRADE_SIDE,

          longOnly: true,
          shortDisabled: true,
          shortOnly: false,
          longDisabled: false,

          virtualLearning: true,
          virtualOnly: true,
          virtualTracked: true,

          marketDataOnly: true,
          noRealOrders: true,
          realOrdersDisabled: true,
          bitgetOrdersDisabled: true,
          exchangeOrdersDisabled: true,
          exchangeCallsDisabled: true,

          redisNamespace: LONG_NAMESPACE,
          redisKeyPrefix: LONG_KEY_PREFIX,
          shortRootTouched: false
        };
      } catch (error) {
        console.warn('BITGET_FUNDING_FAILED', JSON.stringify({
          symbol: contractSymbol,
          targetTradeSide: TARGET_TRADE_SIDE,
          dashboardSide: TARGET_DASHBOARD_SIDE,
          marketDataOnly: true,
          noRealOrders: true,
          error: error?.message || String(error)
        }));

        return {
          rate: 0,
          fetchFailed: true,

          targetTradeSide: TARGET_TRADE_SIDE,
          dashboardSide: TARGET_DASHBOARD_SIDE,
          oppositeTradeSide: OPPOSITE_TRADE_SIDE,

          longOnly: true,
          shortDisabled: true,
          shortOnly: false,
          longDisabled: false,

          virtualLearning: true,
          virtualOnly: true,
          virtualTracked: true,

          marketDataOnly: true,
          noRealOrders: true,
          realOrdersDisabled: true,
          bitgetOrdersDisabled: true,
          exchangeOrdersDisabled: true,
          exchangeCallsDisabled: true,

          redisNamespace: LONG_NAMESPACE,
          redisKeyPrefix: LONG_KEY_PREFIX,
          shortRootTouched: false
        };
      }
    }
  );
}