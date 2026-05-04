// lib/liquidationEngine.js

const LIQ_CACHE_MS = 45 * 1000;
const REQUEST_TIMEOUT_MS = 7_000;

const cache = new Map();
const inFlight = new Map();

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeSymbol(symbol) {
  const clean = String(symbol || "")
    .trim()
    .toUpperCase()
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

function pctDistance(a, b) {
  const x = safeNumber(a, 0);
  const y = safeNumber(b, 0);

  if (!x || !y) return Infinity;

  return Math.abs(x - y) / y;
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

    if (!res.ok) {
      throw new Error(`liquidation_http_${res.status}`);
    }

    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

// ================= EMPTY =================
function empty(price = 0) {
  return {
    valid: false,
    source: "binance_force_orders",
    price: safeNumber(price, 0),

    clusters: [],
    longZones: [],
    shortZones: [],

    nearestAbove: null,
    nearestBelow: null,
    majorAbove: null,
    majorBelow: null,

    top: null,

    runnerTargets: {
      bull: null,
      bear: null
    },

    runnerProtection: {
      bull: null,
      bear: null
    },

    squeezePotential: {
      bull: 0,
      bear: 0
    },

    updatedAt: Date.now()
  };
}

// ================= STEP =================
function getStep(price) {
  const p = safeNumber(price, 0);

  if (p > 50000) return 100;
  if (p > 10000) return 50;
  if (p > 1000) return 10;
  if (p > 100) return 1;
  if (p > 10) return 0.1;
  if (p > 1) return 0.01;
  if (p > 0.1) return 0.001;

  return 0.0001;
}

// ================= RAW NORMALIZER =================
function normalizeLiquidationRows(data) {
  if (!Array.isArray(data)) return [];

  return data
    .map(row => {
      const price = safeNumber(row?.ap ?? row?.avgPrice ?? row?.price, 0);
      const qty = safeNumber(row?.q ?? row?.origQty ?? row?.qty, 0);
      const usd = price * qty;
      const side = String(row?.S ?? row?.side ?? "").toUpperCase();

      return {
        price,
        qty,
        usd,
        side
      };
    })
    .filter(row => {
      return row.price > 0 && row.qty > 0 && row.usd > 0;
    });
}

// ================= CLUSTER ENGINE =================
function buildClusters(liqs) {
  const clusters = {};

  for (const l of liqs) {
    const step = getStep(l.price);
    const key = Number((Math.round(l.price / step) * step).toFixed(8));

    if (!clusters[key]) {
      clusters[key] = {
        price: key,
        volume: 0,
        usd: 0,
        longs: 0,
        shorts: 0,
        count: 0
      };
    }

    clusters[key].volume += l.qty;
    clusters[key].usd += l.usd;
    clusters[key].count++;

    // Binance force order:
    // SELL = long liquidated.
    // BUY = short liquidated.
    if (l.side === "SELL") {
      clusters[key].longs += l.usd;
    } else if (l.side === "BUY") {
      clusters[key].shorts += l.usd;
    }
  }

  return Object.values(clusters)
    .map(cluster => {
      const total = safeNumber(cluster.longs, 0) + safeNumber(cluster.shorts, 0);

      return {
        ...cluster,
        longRatio: total > 0 ? cluster.longs / total : 0,
        shortRatio: total > 0 ? cluster.shorts / total : 0
      };
    })
    .sort((a, b) => safeNumber(b.usd, 0) - safeNumber(a.usd, 0))
    .slice(0, 16);
}

function pickNearestCluster(clusters, price, side) {
  const list = Array.isArray(clusters) ? clusters : [];
  const p = safeNumber(price, 0);

  if (!p) return null;

  if (side === "above") {
    const above = list
      .map(c => safeNumber(c.price, 0))
      .filter(level => level > p)
      .sort((a, b) => a - b);

    return above[0] || null;
  }

  const below = list
    .map(c => safeNumber(c.price, 0))
    .filter(level => level < p)
    .sort((a, b) => b - a);

  return below[0] || null;
}

function pickMajorCluster(clusters, price, side) {
  const list = Array.isArray(clusters) ? clusters : [];
  const p = safeNumber(price, 0);

  if (!p) return null;

  const filtered = list.filter(c => {
    const level = safeNumber(c?.price, 0);
    return side === "above" ? level > p : level < p;
  });

  if (!filtered.length) return null;

  const maxUsd = Math.max(
    ...filtered.map(c => safeNumber(c?.usd, 0)),
    0
  );

  const minMajorUsd = Math.max(maxUsd * 0.35, 25_000);

  const majorCandidates = filtered
    .filter(c => {
      const usd = safeNumber(c?.usd, 0);
      const count = safeNumber(c?.count, 0);

      return usd >= minMajorUsd || count >= 2;
    })
    .sort((a, b) => {
      if (side === "above") {
        return safeNumber(a.price, 0) - safeNumber(b.price, 0);
      }

      return safeNumber(b.price, 0) - safeNumber(a.price, 0);
    });

  if (majorCandidates.length) {
    return safeNumber(majorCandidates[0]?.price, null);
  }

  const densest = [...filtered]
    .sort((a, b) => safeNumber(b.usd, 0) - safeNumber(a.usd, 0))[0];

  return safeNumber(densest?.price, null);
}

function getClusterAtPrice(clusters, price) {
  const p = safeNumber(price, 0);
  if (!p) return null;

  return clusters.find(c => safeNumber(c.price, 0) === p) || null;
}

function scoreSqueezePotential(clusters, price, direction) {
  const p = safeNumber(price, 0);
  if (!p) return 0;

  const relevant = clusters.filter(cluster => {
    const level = safeNumber(cluster.price, 0);

    if (direction === "bull") {
      return level > p && cluster.shortRatio > 0.55;
    }

    return level < p && cluster.longRatio > 0.55;
  });

  if (!relevant.length) return 0;

  let score = 0;

  for (const cluster of relevant) {
    const dist = pctDistance(cluster.price, p);
    if (dist > 0.04) continue;

    const usd = safeNumber(cluster.usd, 0);

    if (usd > 250_000) score += 25;
    else if (usd > 100_000) score += 16;
    else if (usd > 35_000) score += 9;
    else score += 4;

    if (dist < 0.01) score += 8;
    else if (dist < 0.02) score += 5;
  }

  return Math.max(0, Math.min(Math.round(score), 100));
}

// ================= ZONES =================
function buildZones(clusters, price) {
  const p = safeNumber(price, 0);

  if (!p || !Array.isArray(clusters) || !clusters.length) {
    return empty(p);
  }

  const longZones = [];
  const shortZones = [];

  for (const cl of clusters) {
    const total = safeNumber(cl.longs, 0) + safeNumber(cl.shorts, 0);
    if (total <= 0) continue;

    const longRatio = safeNumber(cl.longs, 0) / total;
    const shortRatio = safeNumber(cl.shorts, 0) / total;

    if (longRatio > 0.6) longZones.push(cl.price);
    if (shortRatio > 0.6) shortZones.push(cl.price);
  }

  const nearestAbove = pickNearestCluster(clusters, p, "above");
  const nearestBelow = pickNearestCluster(clusters, p, "below");

  const majorAbove = pickMajorCluster(clusters, p, "above");
  const majorBelow = pickMajorCluster(clusters, p, "below");

  const bullTarget = majorAbove || nearestAbove || null;
  const bearTarget = majorBelow || nearestBelow || null;

  return {
    valid: true,
    source: "binance_force_orders",
    price: p,

    clusters,
    longZones,
    shortZones,

    nearestAbove,
    nearestBelow,
    majorAbove,
    majorBelow,

    top: clusters[0] || null,

    runnerTargets: {
      bull: bullTarget,
      bear: bearTarget
    },

    runnerProtection: {
      bull: majorBelow || nearestBelow || null,
      bear: majorAbove || nearestAbove || null
    },

    targetClusters: {
      bull: getClusterAtPrice(clusters, bullTarget),
      bear: getClusterAtPrice(clusters, bearTarget)
    },

    squeezePotential: {
      bull: scoreSqueezePotential(clusters, p, "bull"),
      bear: scoreSqueezePotential(clusters, p, "bear")
    },

    updatedAt: Date.now()
  };
}

// ================= REAL LIQUIDATIONS =================
export async function getLiquidationZones(symbol, price) {
  const clean = normalizeSymbol(symbol);
  const p = safeNumber(price, 0);

  if (!clean) return empty(p);

  const cached = cache.get(clean);

  if (cached && Date.now() - cached.ts < LIQ_CACHE_MS) {
    return buildZones(cached.clusters, p);
  }

  if (inFlight.has(clean)) {
    const clusters = await inFlight.get(clean);
    return buildZones(clusters, p);
  }

  const promise = (async () => {
    try {
      const url = `https://fapi.binance.com/fapi/v1/allForceOrders?symbol=${encodeURIComponent(clean)}&limit=100`;

      const data = await fetchJsonWithTimeout(url);
      const liqs = normalizeLiquidationRows(data);

      if (!liqs.length) return [];

      const clusters = buildClusters(liqs);

      cache.set(clean, {
        ts: Date.now(),
        clusters
      });

      return clusters;
    } catch {
      return cached?.clusters || [];
    } finally {
      inFlight.delete(clean);
    }
  })();

  inFlight.set(clean, promise);

  const clusters = await promise;

  if (!clusters.length) return empty(p);

  return buildZones(clusters, p);
}

export function clearLiquidationCache() {
  cache.clear();
  inFlight.clear();

  return {
    ok: true,
    cleared: true,
    at: Date.now()
  };
}