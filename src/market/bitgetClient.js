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

function normalizeProductType(value = CONFIG.bitget.productType) {
  return String(value || 'USDT-FUTURES')
    .trim()
    .toUpperCase()
    .replaceAll('_', '-');
}

function buildUrl(path, params = {}) {
  const url = new URL(path, CONFIG.bitget.baseUrl);

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
  return (
    error?.name === 'TypeError' ||
    String(error?.message || '').toLowerCase().includes('fetch failed') ||
    String(error?.message || '').toLowerCase().includes('network')
  );
}

function getCaseInsensitive(row = {}, key = '') {
  if (!row || typeof row !== 'object') return undefined;

  if (Object.prototype.hasOwnProperty.call(row, key)) {
    return row[key];
  }

  const lowerKey = String(key).toLowerCase();

  const foundKey = Object.keys(row).find((candidate) => (
    String(candidate).toLowerCase() === lowerKey
  ));

  return foundKey ? row[foundKey] : undefined;
}

function firstNumber(row = {}, keys = [], fallback = 0) {
  for (const key of keys) {
    const value = getCaseInsensitive(row, key);
    const n = safeNumber(value, NaN);

    if (Number.isFinite(n)) return n;
  }

  return fallback;
}

async function fetchJsonOnce(path, params = {}, timeoutMs = CONFIG.bitget.timeoutMs) {
  const url = buildUrl(path, params);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': CONFIG.strategyVersion || 'CLEAN_MF_TS_V1'
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
  const timeoutMs = options.timeoutMs ?? CONFIG.bitget.timeoutMs;
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

      await sleep(250 * (attempt + 1));
    }
  }

  throw lastError;
}

export async function fetchBitgetTickers() {
  const data = await fetchJson('/api/v2/mix/market/tickers', {
    productType: normalizeProductType()
  });

  return Array.isArray(data) ? data : [];
}

export function parseTicker(row = {}) {
  const contractSymbol = normalizeContractSymbol(
    row.symbol ||
    row.instId ||
    row.contractCode ||
    row.symbolName ||
    row.contractSymbol
  );

  const baseSymbol = normalizeBaseSymbol(
    row.baseSymbol ||
    row.baseCoin ||
    row.coin ||
    contractSymbol
  );

  const price = firstNumber(row, [
    'price',
    'lastPr',
    'last',
    'lastPrice',
    'close',
    'closePrice',
    'markPrice',
    'indexPrice'
  ], 0);

  const baseVolume = firstNumber(row, [
    'baseVolume',
    'baseVol',
    'baseVolume24h',
    'volume',
    'vol',
    'size'
  ], 0);

  const quoteVolumeRaw = firstNumber(row, [
    'volume24h',
    'quoteVolume',
    'quoteVol',
    'quoteVolume24h',
    'usdtVolume',
    'turnover',
    'turnover24h',
    'quoteTurnover',
    'quoteAmount',
    'amount'
  ], 0);

  const quoteVolume = quoteVolumeRaw > 0
    ? quoteVolumeRaw
    : baseVolume * price;

  const rawChange = firstNumber(row, [
    'change24h',
    'changeUtc24h',
    'priceChangePercent',
    'priceChange24h',
    'chgUtc',
    'change'
  ], 0);

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

export function analyzeOrderBook(raw) {
  const bids = parseBookSide(raw?.bids);
  const asks = parseBookSide(raw?.asks);

  const bestBid = safeNumber(bids[0]?.[0], 0);
  const bestAsk = safeNumber(asks[0]?.[0], 0);

  const mid = bestBid > 0 && bestAsk > 0
    ? (bestBid + bestAsk) / 2
    : safeNumber(raw?.mid ?? raw?.price ?? raw?.last, 0);

  if (mid <= 0 || bestBid <= 0 || bestAsk <= 0) {
    return {
      bias: 'NEUTRAL',
      spreadPct: CONFIG.cost?.fallbackSpreadPct ?? 0.0008,
      depthMinUsd1p: 0,
      bidDepthUsd1p: 0,
      askDepthUsd1p: 0,
      imbalance: 0,
      mid: 0,
      bestBid: 0,
      bestAsk: 0,
      fetchFailed: true
    };
  }

  const spreadPct = Math.max(0, (bestAsk - bestBid) / mid);

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

  const bias =
    imbalance > 0.12 ? 'BULLISH' :
    imbalance < -0.12 ? 'BEARISH' :
    'NEUTRAL';

  return {
    bias,
    spreadPct,
    depthMinUsd1p: Math.min(bidDepth, askDepth),
    bidDepthUsd1p: bidDepth,
    askDepthUsd1p: askDepth,
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