// lib/orderbookMemory.js

const memory = new Map();

const MAX_SNAPSHOTS_PER_SYMBOL = 48;
const MAX_MEMORY_AGE_MS = 12 * 60 * 1000;
const MAX_LEVELS = 25;

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeBaseSymbol(raw) {
  return String(raw || "")
    .toUpperCase()
    .trim()
    .replace(/_UMCBL$/, "")
    .replace(/_DMCBL$/, "")
    .replace(/_CMCBL$/, "")
    .replace(/-UMCBL$/, "")
    .replace(/-DMCBL$/, "")
    .replace(/-CMCBL$/, "")
    .replace(/USDT$/, "")
    .replace(/USDC$/, "");
}

function normalizeRows(rows) {
  if (!Array.isArray(rows)) return [];

  return rows
    .map(row => {
      if (Array.isArray(row)) {
        const price = safeNumber(row[0]);
        const qty = safeNumber(row[1]);

        return {
          price,
          qty,
          usd: price * qty
        };
      }

      const price = safeNumber(row?.price || row?.p);
      const qty = safeNumber(row?.qty || row?.size || row?.amount || row?.q);
      const usd = safeNumber(row?.usd, price * qty);

      return {
        price,
        qty,
        usd
      };
    })
    .filter(row => row.price > 0 && row.qty > 0)
    .sort((a, b) => b.usd - a.usd);
}

function toLegacyRows(rows, side = "bid") {
  const normalized = normalizeRows(rows);

  const sorted = [...normalized].sort((a, b) => {
    if (side === "bid") return b.price - a.price;
    return a.price - b.price;
  });

  return sorted
    .slice(0, MAX_LEVELS)
    .map(row => [row.price, row.qty]);
}

function levelsToLegacyRows(levels, side = "bid") {
  if (!Array.isArray(levels)) return [];

  const rows = levels
    .map(level => {
      const price = safeNumber(level?.price);
      const usd = safeNumber(level?.usd);
      const qty = price > 0 ? usd / price : safeNumber(level?.qty);

      return { price, qty };
    })
    .filter(row => row.price > 0 && row.qty > 0);

  rows.sort((a, b) => {
    if (side === "bid") return b.price - a.price;
    return a.price - b.price;
  });

  return rows
    .slice(0, MAX_LEVELS)
    .map(row => [row.price, row.qty]);
}

function calculateMidFromRows(bids, asks) {
  const bestBid = Array.isArray(bids?.[0])
    ? safeNumber(bids[0][0])
    : safeNumber(bids?.[0]?.price);

  const bestAsk = Array.isArray(asks?.[0])
    ? safeNumber(asks[0][0])
    : safeNumber(asks?.[0]?.price);

  if (!bestBid || !bestAsk || bestAsk <= bestBid) return 0;

  return (bestBid + bestAsk) / 2;
}

function buildSnapshot(rawOb = {}, analyzedOb = {}) {
  let bids = toLegacyRows(rawOb?.bids || [], "bid");
  let asks = toLegacyRows(rawOb?.asks || [], "ask");

  if (!bids.length && Array.isArray(analyzedOb?.supportLevels)) {
    bids = levelsToLegacyRows(analyzedOb.supportLevels, "bid");
  }

  if (!asks.length && Array.isArray(analyzedOb?.resistanceLevels)) {
    asks = levelsToLegacyRows(analyzedOb.resistanceLevels, "ask");
  }

  if (!bids.length || !asks.length) return null;

  const bidRows = normalizeRows(bids);
  const askRows = normalizeRows(asks);

  const mid =
    safeNumber(analyzedOb?.mid) ||
    safeNumber(rawOb?.mid) ||
    calculateMidFromRows(bids, asks);

  return {
    ts: Date.now(),

    bids,
    asks,
    mid,

    bidRows,
    askRows,

    spreadPct: safeNumber(analyzedOb?.spreadPct),
    depthMinUsd1p: safeNumber(analyzedOb?.depthMinUsd1p),
    bidDepthUsd1p: safeNumber(analyzedOb?.bidDepthUsd1p),
    askDepthUsd1p: safeNumber(analyzedOb?.askDepthUsd1p),

    bias: analyzedOb?.bias || "NEUTRAL",
    biasRatio: safeNumber(analyzedOb?.biasRatio, 1),
    imbalance: safeNumber(analyzedOb?.imbalance ?? analyzedOb?.biasRatio, 1),

    runnerPressureSide: analyzedOb?.runnerPressureSide || "NEUTRAL",
    runnerPressureScore: safeNumber(analyzedOb?.runnerPressureScore),
    runnerTradable: Boolean(analyzedOb?.runnerTradable),

    spoof: Boolean(analyzedOb?.spoof),
    spoofSide: analyzedOb?.spoofSide || "NONE",
    spoofUsd: safeNumber(analyzedOb?.spoofUsd),

    nearestBidWallPrice: analyzedOb?.nearestBidWallPrice || null,
    nearestAskWallPrice: analyzedOb?.nearestAskWallPrice || null,
    nearestBidWallUsd: safeNumber(analyzedOb?.nearestBidWallUsd),
    nearestAskWallUsd: safeNumber(analyzedOb?.nearestAskWallUsd),

    marketQuality: analyzedOb?.marketQuality || "UNKNOWN",
    qualityScore: safeNumber(analyzedOb?.qualityScore)
  };
}

function pruneHistory(history) {
  const now = Date.now();

  return history
    .filter(item => item && now - safeNumber(item.ts) <= MAX_MEMORY_AGE_MS)
    .slice(-MAX_SNAPSHOTS_PER_SYMBOL);
}

function summarizeHistory(history) {
  const list = pruneHistory(history);

  if (!list.length) {
    return {
      snapshots: 0,
      avgImbalance: 1,
      avgRunnerPressureScore: 0,
      latestBias: "NEUTRAL",
      latestSpoof: false,
      stableDirection: "NEUTRAL"
    };
  }

  const avgImbalance =
    list.reduce((sum, item) => sum + safeNumber(item.imbalance, 1), 0) / list.length;

  const avgRunnerPressureScore =
    list.reduce((sum, item) => sum + safeNumber(item.runnerPressureScore, 0), 0) / list.length;

  const bullish = list.filter(item => item.bias === "BULLISH").length;
  const bearish = list.filter(item => item.bias === "BEARISH").length;

  let stableDirection = "NEUTRAL";

  if (bullish >= Math.ceil(list.length * 0.60)) stableDirection = "BULLISH";
  if (bearish >= Math.ceil(list.length * 0.60)) stableDirection = "BEARISH";

  const latest = list[list.length - 1];

  return {
    snapshots: list.length,
    avgImbalance,
    avgRunnerPressureScore,
    latestBias: latest?.bias || "NEUTRAL",
    latestSpoof: Boolean(latest?.spoof),
    stableDirection
  };
}

// ================= PUBLIC API =================
export function updateOrderbookMemory(symbol, rawOb, analyzedOb = {}) {
  const key = normalizeBaseSymbol(symbol);

  if (!key) return false;

  const snapshot = buildSnapshot(rawOb, analyzedOb);

  if (!snapshot) return false;

  const prev = memory.get(key) || [];
  const next = pruneHistory([...prev, snapshot]);

  memory.set(key, next);

  return true;
}

export function getOrderbookHistory(symbol) {
  const key = normalizeBaseSymbol(symbol);

  if (!key) return [];

  const history = memory.get(key) || [];
  const cleaned = pruneHistory(history);

  if (cleaned.length !== history.length) {
    memory.set(key, cleaned);
  }

  return cleaned;
}

export function getOrderbookMemorySummary(symbol) {
  return summarizeHistory(getOrderbookHistory(symbol));
}

export function clearOrderbookMemory(symbol = null) {
  if (!symbol) {
    memory.clear();
    return true;
  }

  const key = normalizeBaseSymbol(symbol);
  memory.delete(key);

  return true;
}

export function getOrderbookMemoryStats() {
  const out = [];

  for (const [symbol, history] of memory.entries()) {
    const cleaned = pruneHistory(history);
    const summary = summarizeHistory(cleaned);

    out.push({
      symbol,
      snapshots: cleaned.length,
      oldestTs: cleaned[0]?.ts || null,
      newestTs: cleaned[cleaned.length - 1]?.ts || null,
      ...summary
    });
  }

  return out.sort((a, b) => b.snapshots - a.snapshots);
}