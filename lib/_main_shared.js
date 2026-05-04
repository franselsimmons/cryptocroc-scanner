// lib/_main_shared.js

const COINGECKO_CACHE_TTL_MS = 45 * 1000;
const BITGET_CACHE_TTL_MS = 20 * 1000;
const BTC_CACHE_TTL_MS = 30 * 1000;

const REQUEST_TIMEOUT_MS = 8_000;

const VALID_STAGES = ["entry", "almost", "buildup", "radar"];

const RUNNER_PROFILE = "RUNNER";

function getGlobalCache() {
  if (!globalThis.__RUNNER_SHARED_CACHE__) {
    globalThis.__RUNNER_SHARED_CACHE__ = {
      coingecko: {
        data: [],
        expiresAt: 0,
        inFlight: null
      },
      bitgetFutures: {
        data: new Map(),
        expiresAt: 0,
        inFlight: null
      },
      btcGate: {
        data: { state: "UNKNOWN", chg24: 0, chg1h: 0, pressure: 0 },
        expiresAt: 0,
        inFlight: null
      }
    };
  }

  return globalThis.__RUNNER_SHARED_CACHE__;
}

export function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeString(value) {
  return String(value || "").trim();
}

function normalizeBitgetUniverseSymbol(symbol) {
  const clean = safeString(symbol)
    .toUpperCase()
    .replace(/_UMCBL$/, "")
    .replace(/_DMCBL$/, "")
    .replace(/_CMCBL$/, "")
    .replace(/-UMCBL$/, "")
    .replace(/-DMCBL$/, "")
    .replace(/-CMCBL$/, "");

  if (!clean) return "";
  if (clean.endsWith("USDC")) return "";
  if (clean.endsWith("USDT")) return clean;

  return `${clean}USDT`;
}

function extractBitgetTickerRows(json) {
  if (Array.isArray(json?.data?.list)) return json.data.list;
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json?.list)) return json.list;
  return [];
}

async function fetchJsonWithTimeout(url, options = {}) {
  const timeoutMs = safeNumber(options.timeoutMs, REQUEST_TIMEOUT_MS);
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(options.headers || {})
      }
    });

    if (!res.ok) {
      throw new Error(`${options.errorPrefix || "http"}_${res.status}`);
    }

    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

function buildRunnerBtcState(chg24, chg1h) {
  const pressure = (chg1h * 0.78) + (chg24 * 0.22);

  if (chg24 > 2.5 && chg1h > 0.45) return { state: "RUNNER_BULL", pressure };
  if (chg24 < -2.5 && chg1h < -0.45) return { state: "RUNNER_BEAR", pressure };

  if (chg1h > 0.25 || pressure > 0.45) return { state: "BULLISH", pressure };
  if (chg1h < -0.25 || pressure < -0.45) return { state: "BEARISH", pressure };

  return { state: "NEUTRAL", pressure };
}

// ================= BTC CONTEXT =================
export async function fetchBTCGateFromUniverse() {
  const cache = getGlobalCache();
  const now = Date.now();

  if (cache.btcGate.expiresAt > now && cache.btcGate.data) {
    return cache.btcGate.data;
  }

  if (cache.btcGate.inFlight) {
    return cache.btcGate.inFlight;
  }

  cache.btcGate.inFlight = (async () => {
    try {
      const url = [
        "https://api.coingecko.com/api/v3/coins/markets",
        "?vs_currency=usd",
        "&ids=bitcoin",
        "&price_change_percentage=1h,24h"
      ].join("");

      const data = await fetchJsonWithTimeout(url, {
        errorPrefix: "btc_gate_http"
      });

      const btc = Array.isArray(data) ? data[0] : null;
      const chg24 = safeNumber(btc?.price_change_percentage_24h, 0);
      const chg1h = safeNumber(btc?.price_change_percentage_1h_in_currency, 0);
      const state = buildRunnerBtcState(chg24, chg1h);

      const payload = {
        state: state.state,
        chg24,
        chg1h,
        pressure: state.pressure,
        profile: RUNNER_PROFILE,
        updatedAt: Date.now()
      };

      cache.btcGate.data = payload;
      cache.btcGate.expiresAt = Date.now() + BTC_CACHE_TTL_MS;

      return payload;
    } catch {
      return {
        state: "UNKNOWN",
        chg24: 0,
        chg1h: 0,
        pressure: 0,
        profile: RUNNER_PROFILE,
        updatedAt: Date.now()
      };
    } finally {
      cache.btcGate.inFlight = null;
    }
  })();

  return cache.btcGate.inFlight;
}

// ================= COINGECKO =================
export async function fetchCoinGeckoTopCached() {
  const cache = getGlobalCache();
  const now = Date.now();

  if (cache.coingecko.expiresAt > now && Array.isArray(cache.coingecko.data)) {
    return cache.coingecko.data;
  }

  if (cache.coingecko.inFlight) {
    return cache.coingecko.inFlight;
  }

  cache.coingecko.inFlight = (async () => {
    const buildUrl = (page) => [
      "https://api.coingecko.com/api/v3/coins/markets",
      "?vs_currency=usd",
      "&order=volume_desc",
      "&per_page=250",
      `&page=${page}`,
      "&sparkline=false",
      "&price_change_percentage=1h,24h"
    ].join("");

    const pages = [1, 2, 3, 4];

    try {
      const results = await Promise.allSettled(
        pages.map(async (page) => {
          const json = await fetchJsonWithTimeout(buildUrl(page), {
            errorPrefix: "coingecko_http"
          });

          return Array.isArray(json) ? json : [];
        })
      );

      const flat = [];

      for (const result of results) {
        if (result.status === "fulfilled") {
          flat.push(...result.value);
        }
      }

      if (!flat.length) {
        return cache.coingecko.data || [];
      }

      const bestBySymbol = new Map();

      for (const coin of flat) {
        const symbol = safeString(coin?.symbol).toUpperCase();
        if (!symbol) continue;

        const prev = bestBySymbol.get(symbol);
        const prevVol = safeNumber(prev?.total_volume, 0);
        const currVol = safeNumber(coin?.total_volume, 0);

        if (!prev || currVol > prevVol) {
          bestBySymbol.set(symbol, coin);
        }
      }

      const data = Array.from(bestBySymbol.values());

      cache.coingecko.data = data;
      cache.coingecko.expiresAt = Date.now() + COINGECKO_CACHE_TTL_MS;

      return data;
    } catch {
      return cache.coingecko.data || [];
    } finally {
      cache.coingecko.inFlight = null;
    }
  })();

  return cache.coingecko.inFlight;
}

// ================= BITGET FUTURES =================
export async function fetchFuturesTickers() {
  const cache = getGlobalCache();
  const now = Date.now();

  if (cache.bitgetFutures.expiresAt > now && cache.bitgetFutures.data instanceof Map) {
    return cache.bitgetFutures.data;
  }

  if (cache.bitgetFutures.inFlight) {
    return cache.bitgetFutures.inFlight;
  }

  cache.bitgetFutures.inFlight = (async () => {
    const endpoints = [
      "https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES",
      "https://api.bitget.com/api/mix/v1/market/tickers?productType=umcbl"
    ];

    let lastError = null;

    for (const url of endpoints) {
      try {
        const json = await fetchJsonWithTimeout(url, {
          errorPrefix: "bitget_http"
        });

        const rows = extractBitgetTickerRows(json);
        if (!rows.length) continue;

        const map = new Map();

        for (const row of rows) {
          const rawSymbol = row?.symbol || row?.instId || row?.ticker || row?.symbolName || "";
          const symbol = normalizeBitgetUniverseSymbol(rawSymbol);

          if (!symbol) continue;

          const price = safeNumber(
            row?.lastPr ?? row?.last ?? row?.close ?? row?.markPrice,
            0
          );

          const volume = safeNumber(
            row?.baseVolume ??
              row?.baseVol ??
              row?.usdtVolume ??
              row?.quoteVolume ??
              row?.turnover ??
              row?.volume,
            0
          );

          if (price <= 0) continue;

          map.set(symbol, {
            symbol,
            rawSymbol,
            price,
            volume,
            productType: "USDT-FUTURES",
            updatedAt: Date.now()
          });
        }

        if (map.size > 0) {
          cache.bitgetFutures.data = map;
          cache.bitgetFutures.expiresAt = Date.now() + BITGET_CACHE_TTL_MS;

          return map;
        }
      } catch (err) {
        lastError = err;
      }
    }

    if (lastError) {
      console.error("BITGET ERROR:", lastError.message);
    }

    return cache.bitgetFutures.data instanceof Map
      ? cache.bitgetFutures.data
      : new Map();
  })();

  try {
    return await cache.bitgetFutures.inFlight;
  } finally {
    cache.bitgetFutures.inFlight = null;
  }
}

// ================= SHALLOW OB =================
export function generateShallowOb() {
  return {
    spreadPct: 0.055,
    depthMinUsd1p: 250000,
    imbalance: 1,
    score: 1,
    source: "shallow_runner_fallback"
  };
}

// ================= SCANNER HELPERS =================
export function safeStage(stage) {
  return VALID_STAGES.includes(stage) ? stage : "radar";
}

export function scannerStageLabel(stage) {
  const s = safeStage(stage);

  if (s === "entry") return "RUNNER_HOT";
  if (s === "almost") return "RUNNER_ALMOST";
  if (s === "buildup") return "RUNNER_BUILDUP";

  return "RUNNER_RADAR";
}

export function tradeIntentFromScannerStage(stage, uiOnly = false) {
  const s = safeStage(stage);

  if (uiOnly) return "WATCH_ONLY";
  if (s === "entry") return "HOT_RUNNER_CANDIDATE";
  if (s === "almost") return "RUNNER_CANDIDATE";
  if (s === "buildup") return "EARLY_RUNNER_WATCH";

  return "WATCH";
}

export function normalizeFallbackStage(stage) {
  const s = safeStage(stage);

  // Fallback-coins mogen nooit echte hot candidates worden.
  return s === "entry" ? "almost" : s;
}

export function decorateScannerCoin(coin) {
  const stage = safeStage(coin?.stage);
  const uiOnly = Boolean(coin?.uiOnly);

  return {
    ...coin,
    runnerProfile: coin?.runnerProfile || RUNNER_PROFILE,

    stage,
    scannerStage: stage,
    scannerStageLabel: scannerStageLabel(stage),
    tradeIntent: tradeIntentFromScannerStage(stage, uiOnly),

    isScannerCandidate: true,
    isHotCandidate: stage === "entry" && !uiOnly,
    isRealEntry: false
  };
}