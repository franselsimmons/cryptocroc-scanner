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

const DEFAULT_BASE_URL = 'https://api.bitget.com';
const DEFAULT_PRODUCT_TYPE = 'USDT-FUTURES';
const DEFAULT_TIMEOUT_MS = 6500;
const DEFAULT_RETRIES = 2;
const DEFAULT_STRATEGY_UA = 'CLEAN_MF_TS_V1';

function bitgetConfig() {
  return {
    baseUrl: CONFIG.bitget?.baseUrl || DEFAULT_BASE_URL,
    productType: CONFIG.bitget?.productType || DEFAULT_PRODUCT_TYPE,
    timeoutMs: Math.max(500, safeNumber(CONFIG.bitget?.timeoutMs, DEFAULT_TIMEOUT_MS)),
    retries: Math.max(0, Math.floor(safeNumber(CONFIG.bitget?.retries, DEFAULT_RETRIES))),
    userAgent: CONFIG.strategyVersion || DEFAULT_STRATEGY_UA
  };
}

function normalizeProductType(value = bitgetConfig().productType) {
  return String(value || DEFAULT_PRODUCT_TYPE)
    .trim()
    .toUpperCase()
    .replaceAll('_', '-');
}

function buildUrl(path, params = {}) {
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
    message.includes('socket') ||
    message.includes('econnreset') ||
    message.includes('etimedout')
  );
}

function retryAfterMs(response) {
  const header = response.headers?.get?.('retry-after');
  const value = Number(header);

  if (!Number.isFinite(value) || value <= 0) return 0;

  return Math.min(5000, value * 1000);
}

function retryDelayMs(attempt, error = null) {
  const explicit = safeNumber(error?.retryAfterMs, 0);

  if (explicit > 0) return explicit;

  const base = 250 * (attempt + 1);
  const jitter = Math.floor(Math.random() * 120);

  return Math.min(2500, base + jitter);
}

async function fetchJsonOnce(path, params = {}, timeoutMs = bitgetConfig().timeoutMs) {
  const cfg = bitgetConfig();
  const url = buildUrl(path, params);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': cfg.userAgent
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
      error.retryAfterMs = retryAfterMs(response);

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
  const cfg = bitgetConfig();

  const timeoutMs = options.timeoutMs ?? cfg.timeoutMs;
  const retries = Math.max(0, Number(options.retries ?? cfg.retries) || 0);

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

      await sleep(retryDelayMs(attempt, error));
    }
  }

  throw lastError;
}

function asArrayData(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.list)) return data.list;
  if (Array.isArray(data?.rows)) return data.rows;
  if (Array.isArray(data?.data)) return data.data;

  return [];
}

export async function fetchBitgetTickers() {
  const data = await fetchJson('/api/v2/mix/market/tickers', {
    productType: normalizeProductType()
  });

  return asArrayData(data);
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
    '2h': '2H',
    '4h': '4H',
    '6h': '6H',
    '12h': '12H',

    '1d': '1D',
    '1w': '1W'
  };

  return map[tf] || timeframe;
}

export async function fetchCandles(symbol, timeframe = '15m', limit = 100) {
  const contractSymbol = normalizeContractSymbol(symbol);
  const granularity = normalizeGranularity(timeframe);
  const safeLimit = Math.max(1, Math.min(Math.floor(Number(limit || 100)), 1000));

  if (!contractSymbol) return [];

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

      const candles = asArrayData(raw)
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
    error: lastError?.message || 'EMPTY'
  }));

  return [];
}

export async function fetchOrderBook(symbol) {
  const contractSymbol = normalizeContractSymbol(symbol);

  if (!contractSymbol) return null;

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
    error: lastError?.message || 'EMPTY'
  }));

  return null;
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

function bookPayload(raw = {}) {
  if (raw?.bids || raw?.asks) return raw;
  if (raw?.data?.bids || raw?.data?.asks) return raw.data;
  if (raw?.orderBook?.bids || raw?.orderBook?.asks) return raw.orderBook;

  return raw || {};
}

function depthWithinPct(rows = [], mid, pct, side) {
  if (mid <= 0) return 0;

  const minBid = mid * (1 - pct);
  const maxAsk = mid * (1 + pct);

  return rows.reduce((sum, [price, qty]) => {
    if (side === 'bid' && price < minBid) return sum;
    if (side === 'ask' && price > maxAsk) return sum;

    return sum + price * qty;
  }, 0);
}

function largestWallUsd(rows = [], mid, pct, side) {
  if (mid <= 0) return 0;

  const minBid = mid * (1 - pct);
  const maxAsk = mid * (1 + pct);

  return rows.reduce((max, [price, qty]) => {
    if (side === 'bid' && price < minBid) return max;
    if (side === 'ask' && price > maxAsk) return max;

    return Math.max(max, price * qty);
  }, 0);
}

export function analyzeOrderBook(raw) {
  const payload = bookPayload(raw);

  const bids = parseBookSide(payload?.bids);
  const asks = parseBookSide(payload?.asks);

  const bestBid = safeNumber(bids[0]?.[0], 0);
  const bestAsk = safeNumber(asks[0]?.[0], 0);

  const mid = bestBid > 0 && bestAsk > 0
    ? (bestBid + bestAsk) / 2
    : safeNumber(payload?.mid ?? payload?.price ?? payload?.last, 0);

  if (mid <= 0 || bestBid <= 0 || bestAsk <= 0) {
    return {
      bias: 'NEUTRAL',
      spreadPct: CONFIG.cost?.fallbackSpreadPct ?? 0.0008,

      depthMinUsd1p: 0,
      bidDepthUsd1p: 0,
      askDepthUsd1p: 0,

      bidDepthUsd05p: 0,
      askDepthUsd05p: 0,
      depthMinUsd05p: 0,

      bidWallUsd1p: 0,
      askWallUsd1p: 0,
      wallImbalance: 0,

      imbalance: 0,
      mid: 0,
      bestBid: 0,
      bestAsk: 0,

      fetchFailed: true
    };
  }

  const spreadPct = Math.max(0, (bestAsk - bestBid) / mid);

  const bidDepthUsd1p = depthWithinPct(bids, mid, 0.01, 'bid');
  const askDepthUsd1p = depthWithinPct(asks, mid, 0.01, 'ask');

  const bidDepthUsd05p = depthWithinPct(bids, mid, 0.005, 'bid');
  const askDepthUsd05p = depthWithinPct(asks, mid, 0.005, 'ask');

  const depthTotal = bidDepthUsd1p + askDepthUsd1p;

  const imbalance = depthTotal > 0
    ? (bidDepthUsd1p - askDepthUsd1p) / depthTotal
    : 0;

  const bidWallUsd1p = largestWallUsd(bids, mid, 0.01, 'bid');
  const askWallUsd1p = largestWallUsd(asks, mid, 0.01, 'ask');

  const wallTotal = bidWallUsd1p + askWallUsd1p;

  const wallImbalance = wallTotal > 0
    ? (bidWallUsd1p - askWallUsd1p) / wallTotal
    : 0;

  const bias =
    imbalance > 0.12 ? 'BULLISH' :
    imbalance < -0.12 ? 'BEARISH' :
    'NEUTRAL';

  return {
    bias,
    spreadPct,

    depthMinUsd1p: Math.min(bidDepthUsd1p, askDepthUsd1p),
    bidDepthUsd1p,
    askDepthUsd1p,

    depthMinUsd05p: Math.min(bidDepthUsd05p, askDepthUsd05p),
    bidDepthUsd05p,
    askDepthUsd05p,

    bidWallUsd1p,
    askWallUsd1p,
    wallImbalance,

    imbalance,
    mid,
    bestBid,
    bestAsk,

    fetchFailed: false
  };
}

export async function fetchFunding(symbol) {
  const contractSymbol = normalizeContractSymbol(symbol);

  if (!contractSymbol) {
    return {
      rate: 0,
      fetchFailed: true
    };
  }

  try {
    const data = await fetchJson('/api/v2/mix/market/current-fund-rate', {
      symbol: contractSymbol,
      productType: normalizeProductType()
    }, {
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
      fetchFailed: false
    };
  } catch (error) {
    console.warn('BITGET_FUNDING_FAILED', JSON.stringify({
      symbol: contractSymbol,
      error: error?.message || String(error)
    }));

    return {
      rate: 0,
      fetchFailed: true
    };
  }
}