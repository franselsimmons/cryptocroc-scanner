// lib/orderbook.js

const DEFAULT_OB = {
  mid: 0,
  bestBid: 0,
  bestAsk: 0,
  spreadPct: 0.001,

  depthMinUsd05p: 0,
  depthMinUsd1p: 0,

  bidDepthUsd05p: 0,
  askDepthUsd05p: 0,
  bidDepthUsd1p: 0,
  askDepthUsd1p: 0,

  bias: "NEUTRAL",
  biasRatio: 1,
  imbalance: 1,

  spoof: false,
  spoofSide: "NONE",
  spoofUsd: 0,

  supportLevels: [],
  resistanceLevels: [],

  nearestBidWallPrice: null,
  nearestAskWallPrice: null,
  nearestBidWallUsd: 0,
  nearestAskWallUsd: 0,

  liveSupport: null,
  liveResistance: null,

  runnerPressureSide: "NEUTRAL",
  runnerPressureScore: 0,
  runnerTradable: false,

  marketQuality: "BAD",
  qualityScore: 0,

  fetchFailed: true
};

const ORDERBOOK_CACHE = new Map();
const BAD_SYMBOL_CACHE = new Map();
const IN_FLIGHT = new Map();

const ORDERBOOK_CACHE_MS = 12 * 1000;
const BAD_SYMBOL_CACHE_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 7_000;

function normalizeSymbol(symbol) {
  const clean = String(symbol || "")
    .toUpperCase()
    .trim()
    .replace(/_UMCBL$/, "")
    .replace(/_DMCBL$/, "")
    .replace(/_CMCBL$/, "")
    .replace(/-UMCBL$/, "")
    .replace(/-DMCBL$/, "")
    .replace(/-CMCBL$/, "");

  if (!clean) return "";

  return clean.endsWith("USDT")
    ? clean
    : `${clean}USDT`;
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function fetchJsonWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json"
      }
    });

    const json = await res.json().catch(() => null);

    return { res, json };
  } finally {
    clearTimeout(timeout);
  }
}

// ================= FETCH ORDERBOOK =================
export async function fetchOrderBook(symbol) {
  const clean = normalizeSymbol(symbol);
  const now = Date.now();

  if (!clean) {
    throw new Error("orderbook_invalid_symbol");
  }

  const cached = ORDERBOOK_CACHE.get(clean);
  if (cached && now - cached.ts < ORDERBOOK_CACHE_MS) {
    return cached.data;
  }

  const badUntil = BAD_SYMBOL_CACHE.get(clean) || 0;
  if (now < badUntil) {
    throw new Error(`orderbook bad-symbol cooldown: ${clean}`);
  }

  if (IN_FLIGHT.has(clean)) {
    return IN_FLIGHT.get(clean);
  }

  const promise = (async () => {
    const url =
      `https://api.bitget.com/api/v2/mix/market/merge-depth?symbol=${encodeURIComponent(clean)}&productType=USDT-FUTURES&limit=50`;

    const { res, json } = await fetchJsonWithTimeout(url);

    const bids = Array.isArray(json?.data?.bids) ? json.data.bids : [];
    const asks = Array.isArray(json?.data?.asks) ? json.data.asks : [];

    const ok =
      res.ok &&
      json &&
      (json.code === undefined || json.code === "00000") &&
      bids.length > 0 &&
      asks.length > 0;

    if (!ok) {
      if (res.status === 400) {
        BAD_SYMBOL_CACHE.set(clean, now + BAD_SYMBOL_CACHE_MS);
      }

      throw new Error(
        `orderbook failed ${res.status} ${clean} ${json?.msg || json?.code || ""}`.trim()
      );
    }

    const data = {
      symbol: clean,
      bids,
      asks,
      ts: json?.data?.ts || now
    };

    ORDERBOOK_CACHE.set(clean, {
      ts: now,
      data
    });

    return data;
  })();

  IN_FLIGHT.set(clean, promise);

  try {
    return await promise;
  } finally {
    IN_FLIGHT.delete(clean);
  }
}

// ================= HELPERS =================
function normalizeRows(rows) {
  if (!Array.isArray(rows)) return [];

  return rows
    .map(r => {
      if (Array.isArray(r)) {
        return {
          price: safeNumber(r[0]),
          qty: safeNumber(r[1])
        };
      }

      return {
        price: safeNumber(r?.price || r?.p),
        qty: safeNumber(r?.size || r?.qty || r?.amount || r?.q)
      };
    })
    .filter(r => r.price > 0 && r.qty > 0)
    .map(r => ({
      ...r,
      usd: r.price * r.qty
    }));
}

function calcDepthUsdWithinPct(rows, mid, pct, side) {
  if (!mid || !rows.length) return 0;

  const lower = mid * (1 - pct);
  const upper = mid * (1 + pct);

  return rows.reduce((sum, r) => {
    if (side === "bid" && r.price >= lower && r.price <= mid) {
      return sum + r.usd;
    }

    if (side === "ask" && r.price <= upper && r.price >= mid) {
      return sum + r.usd;
    }

    return sum;
  }, 0);
}

function getNearRows(rows, mid, pct, side) {
  if (!mid || !Array.isArray(rows)) return [];

  const lower = mid * (1 - pct);
  const upper = mid * (1 + pct);

  return rows.filter(r => {
    if (side === "bid") {
      return r.price >= lower && r.price <= mid;
    }

    return r.price <= upper && r.price >= mid;
  });
}

function getNearestWall(rows, mid, side) {
  const nearRows = getNearRows(rows, mid, 0.012, side);

  if (!nearRows.length) return null;

  const avgUsd =
    nearRows.reduce((sum, r) => sum + safeNumber(r.usd), 0) /
    nearRows.length;

  const threshold = Math.max(avgUsd * 2.5, 25_000);

  const candidates = nearRows
    .filter(r => safeNumber(r.usd) >= threshold)
    .sort((a, b) => {
      const distA = Math.abs(safeNumber(a.price) - mid);
      const distB = Math.abs(safeNumber(b.price) - mid);

      if (distA !== distB) return distA - distB;

      return safeNumber(b.usd) - safeNumber(a.usd);
    });

  return candidates[0] || null;
}

function getTopLevels(rows, mid, side) {
  const nearRows = getNearRows(rows, mid, 0.015, side);

  return nearRows
    .sort((a, b) => safeNumber(b.usd) - safeNumber(a.usd))
    .slice(0, 6)
    .sort((a, b) => {
      return side === "bid"
        ? safeNumber(b.price) - safeNumber(a.price)
        : safeNumber(a.price) - safeNumber(b.price);
    })
    .map(r => ({
      price: safeNumber(r.price),
      qty: safeNumber(r.qty),
      usd: safeNumber(r.usd)
    }));
}

function detectSpoof({ bids, asks, mid }) {
  const all = [
    ...bids.map(r => ({ ...r, side: "bid" })),
    ...asks.map(r => ({ ...r, side: "ask" }))
  ];

  if (!all.length || !mid) {
    return {
      spoof: false,
      spoofSide: "NONE",
      spoofUsd: 0
    };
  }

  const near = all.filter(r => Math.abs(r.price - mid) / mid <= 0.012);

  if (near.length < 4) {
    return {
      spoof: false,
      spoofSide: "NONE",
      spoofUsd: 0
    };
  }

  const avgUsd =
    near.reduce((sum, r) => sum + safeNumber(r.usd), 0) /
    near.length;

  const max = [...near].sort((a, b) => safeNumber(b.usd) - safeNumber(a.usd))[0];

  const spoof =
    avgUsd > 0 &&
    safeNumber(max?.usd) > avgUsd * 8 &&
    safeNumber(max?.usd) > 35_000;

  return {
    spoof,
    spoofSide: spoof ? String(max.side || "UNKNOWN").toUpperCase() : "NONE",
    spoofUsd: spoof ? safeNumber(max.usd) : 0
  };
}

function getMarketQuality({ spreadPct, depthMinUsd1p, bidDepthUsd1p, askDepthUsd1p }) {
  let score = 0;

  if (spreadPct <= 0.0010) score += 30;
  else if (spreadPct <= 0.0025) score += 22;
  else if (spreadPct <= 0.0040) score += 10;

  if (depthMinUsd1p >= 500_000) score += 35;
  else if (depthMinUsd1p >= 250_000) score += 25;
  else if (depthMinUsd1p >= 150_000) score += 12;
  else if (depthMinUsd1p >= 50_000) score += 5;

  const depthSum = bidDepthUsd1p + askDepthUsd1p;

  if (depthSum >= 1_000_000) score += 20;
  else if (depthSum >= 500_000) score += 12;
  else if (depthSum >= 250_000) score += 6;

  const balance =
    Math.min(bidDepthUsd1p, askDepthUsd1p) /
    Math.max(bidDepthUsd1p, askDepthUsd1p, 1);

  if (balance >= 0.70) score += 15;
  else if (balance >= 0.50) score += 8;

  score = Math.max(0, Math.min(100, Math.round(score)));

  let marketQuality = "BAD";
  if (score >= 75) marketQuality = "GOOD";
  else if (score >= 55) marketQuality = "OK";
  else if (score >= 35) marketQuality = "WEAK";

  return {
    qualityScore: score,
    marketQuality
  };
}

function getRunnerPressure({ ratio, bias, qualityScore, spoof }) {
  let score = 0;
  let side = "NEUTRAL";

  if (ratio > 1.22) {
    side = "BULLISH";
    score += 35;
  }

  if (ratio < 0.82) {
    side = "BEARISH";
    score += 35;
  }

  if (ratio > 1.45 || ratio < 0.68) score += 15;
  if (qualityScore >= 55) score += 15;
  if (qualityScore >= 75) score += 10;

  if (bias !== "NEUTRAL") score += 10;
  if (spoof) score -= 25;

  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    runnerPressureSide: side,
    runnerPressureScore: score,
    runnerTradable: score >= 45 && !spoof
  };
}

// ================= ANALYZE ORDERBOOK =================
export function analyzeOrderBookAdvanced(ob) {
  try {
    const bids = normalizeRows(ob?.bids || []);
    const asks = normalizeRows(ob?.asks || []);

    if (!bids.length || !asks.length) {
      return { ...DEFAULT_OB };
    }

    bids.sort((a, b) => b.price - a.price);
    asks.sort((a, b) => a.price - b.price);

    const bestBid = bids[0].price;
    const bestAsk = asks[0].price;

    if (!bestBid || !bestAsk || bestAsk <= bestBid) {
      return { ...DEFAULT_OB };
    }

    const mid = (bestBid + bestAsk) / 2;
    const spreadPct = mid > 0 ? (bestAsk - bestBid) / mid : 0.001;

    const bidDepthUsd05p = calcDepthUsdWithinPct(bids, mid, 0.005, "bid");
    const askDepthUsd05p = calcDepthUsdWithinPct(asks, mid, 0.005, "ask");

    const bidDepthUsd1p = calcDepthUsdWithinPct(bids, mid, 0.01, "bid");
    const askDepthUsd1p = calcDepthUsdWithinPct(asks, mid, 0.01, "ask");

    const depthMinUsd05p = Math.min(bidDepthUsd05p, askDepthUsd05p);
    const depthMinUsd1p = Math.min(bidDepthUsd1p, askDepthUsd1p);

    const ratio05 = bidDepthUsd05p / Math.max(askDepthUsd05p, 1);
    const ratio1 = bidDepthUsd1p / Math.max(askDepthUsd1p, 1);
    const ratio = (ratio05 * 0.60) + (ratio1 * 0.40);

    let bias = "NEUTRAL";

    if (ratio > 1.22) bias = "BULLISH";
    if (ratio < 0.82) bias = "BEARISH";

    const spoofData = detectSpoof({ bids, asks, mid });

    const nearestBidWall = getNearestWall(bids, mid, "bid");
    const nearestAskWall = getNearestWall(asks, mid, "ask");

    const supportLevels = getTopLevels(bids, mid, "bid");
    const resistanceLevels = getTopLevels(asks, mid, "ask");

    const quality = getMarketQuality({
      spreadPct,
      depthMinUsd1p,
      bidDepthUsd1p,
      askDepthUsd1p
    });

    const runnerPressure = getRunnerPressure({
      ratio,
      bias,
      qualityScore: quality.qualityScore,
      spoof: spoofData.spoof
    });

    return {
      mid,
      bestBid,
      bestAsk,
      spreadPct,

      bidDepthUsd05p,
      askDepthUsd05p,
      bidDepthUsd1p,
      askDepthUsd1p,
      depthMinUsd05p,
      depthMinUsd1p,

      bias,
      biasRatio: ratio,
      imbalance: ratio,

      spoof: spoofData.spoof,
      spoofSide: spoofData.spoofSide,
      spoofUsd: spoofData.spoofUsd,

      supportLevels,
      resistanceLevels,

      nearestBidWallPrice: nearestBidWall?.price || null,
      nearestAskWallPrice: nearestAskWall?.price || null,
      nearestBidWallUsd: safeNumber(nearestBidWall?.usd),
      nearestAskWallUsd: safeNumber(nearestAskWall?.usd),

      liveSupport: nearestBidWall?.price || supportLevels[0]?.price || null,
      liveResistance: nearestAskWall?.price || resistanceLevels[0]?.price || null,

      runnerPressureSide: runnerPressure.runnerPressureSide,
      runnerPressureScore: runnerPressure.runnerPressureScore,
      runnerTradable: runnerPressure.runnerTradable,

      marketQuality: quality.marketQuality,
      qualityScore: quality.qualityScore,

      fetchFailed: false
    };
  } catch {
    return { ...DEFAULT_OB };
  }
}

export async function getAnalyzedOrderBook(symbol) {
  const raw = await fetchOrderBook(symbol);
  const analyzed = analyzeOrderBookAdvanced(raw);

  return {
    raw,
    analyzed
  };
}

export function clearOrderBookCache() {
  ORDERBOOK_CACHE.clear();
  BAD_SYMBOL_CACHE.clear();
  IN_FLIGHT.clear();

  return {
    ok: true,
    cleared: true,
    at: Date.now()
  };
}