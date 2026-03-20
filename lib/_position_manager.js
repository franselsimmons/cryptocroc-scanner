// lib/_position_manager.js

// ======================================================
// Shared helpers voor open-position management
// ======================================================

const BITGET_OB = "https://api.bitget.com/api/v2/spot/market/orderbook";

export function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

export function up(x) {
  return String(x || "").toUpperCase();
}

export async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(id);
  }
}

export async function fetchOrderbook(symbol) {
  try {
    const url = `${BITGET_OB}?symbol=${symbol}&type=step0&limit=20`;
    const j = await fetchJsonWithTimeout(
      url,
      { headers: { accept: "application/json" } },
      6000
    );

    if (String(j?.code || "") !== "00000") return null;

    const bids = j?.data?.bids || [];
    const asks = j?.data?.asks || [];
    if (!bids.length || !asks.length) return null;

    const bestBid = n(bids[0]?.[0], 0);
    const bestAsk = n(asks[0]?.[0], 0);
    if (!(bestBid > 0 && bestAsk > 0)) return null;

    const spreadPct = ((bestAsk - bestBid) / bestBid) * 100;
    const depthBidUsd = bids
      .slice(0, 8)
      .reduce((a, b) => a + n(b?.[1]) * n(b?.[0]), 0);
    const depthAskUsd = asks
      .slice(0, 8)
      .reduce((a, b) => a + n(b?.[1]) * n(b?.[0]), 0);

    const total = depthBidUsd + depthAskUsd;
    const score = total > 0 ? (depthBidUsd - depthAskUsd) / total : 0;

    const largestBidUsd = Math.max(
      ...bids.slice(0, 8).map((b) => n(b?.[1]) * n(b?.[0])),
      0
    );
    const largestAskUsd = Math.max(
      ...asks.slice(0, 8).map((b) => n(b?.[1]) * n(b?.[0])),
      0
    );
    const largestOrderRatio =
      total > 0 ? Math.max(largestBidUsd, largestAskUsd) / total : 0;

    return {
      status: "ok",
      valid: true,
      fresh: true,
      stale: false,
      reason: "",
      bestBid,
      bestAsk,
      spreadPct,
      depthBidUsd,
      depthAskUsd,
      depthMinUsd1p: Math.min(depthBidUsd, depthAskUsd),
      score,
      lor: largestOrderRatio,
    };
  } catch {
    return null;
  }
}

export function computeObScore(ob) {
  if (!ob) {
    return {
      bestBid: 0,
      bestAsk: 0,
      spreadPct: 999,
      depthBidUsd: 0,
      depthAskUsd: 0,
      depthMinUsd1p: 0,
      score: 0,
      lor: 1,
      valid: false,
      fresh: false,
      stale: true,
      reason: "missing_snapshot",
      status: "none",
    };
  }

  return {
    bestBid: n(ob.bestBid, 0),
    bestAsk: n(ob.bestAsk, 0),
    spreadPct: n(ob.spreadPct, 999),
    depthBidUsd: n(ob.depthBidUsd, 0),
    depthAskUsd: n(ob.depthAskUsd, 0),
    depthMinUsd1p: n(ob.depthMinUsd1p, 0),
    score: n(ob.score, 0),
    lor: n(ob.lor, 0),
    valid: !!ob.valid,
    fresh: !!ob.fresh,
    stale: !!ob.stale,
    reason: String(ob.reason || ""),
    status: String(ob.status || "ok"),
  };
}

export async function enrichOpenPositionCoin(scannedCoin, fallbackState = {}, symbol) {
  const sym = up(symbol);
  const ob = await fetchOrderbook(`${sym}USDT`);
  const obx = computeObScore(ob);

  const liveMid =
    n(obx.bestBid, 0) > 0 && n(obx.bestAsk, 0) > 0
      ? (n(obx.bestBid, 0) + n(obx.bestAsk, 0)) / 2
      : 0;

  const base = scannedCoin || fallbackState || {};
  const price =
    liveMid > 0
      ? liveMid
      : n(base.price, 0) ||
        n(fallbackState.lastPrice, 0) ||
        n(fallbackState.price, 0) ||
        0;

  return {
    ...base,
    symbol: sym,
    price,
    lastPrice: price,
    ob: {
      bestBid: n(obx.bestBid, 0),
      bestAsk: n(obx.bestAsk, 0),
      spreadPct: Number(n(obx.spreadPct, 999).toFixed(4)),
      depthBidUsd: Math.round(n(obx.depthBidUsd, 0)),
      depthAskUsd: Math.round(n(obx.depthAskUsd, 0)),
      depthMinUsd1p: Math.round(n(obx.depthMinUsd1p, 0)),
      score: Number(n(obx.score, 0).toFixed(5)),
      lor: Number(n(obx.lor, 0).toFixed(4)),
      valid: !!obx.valid,
      fresh: !!obx.fresh,
      stale: !!obx.stale,
      reason: String(obx.reason || ""),
      status: String(obx.status || "ok"),
    },
    breakout: base.breakout || { ready: false, breakoutPct: 0, pressure: 0 },
    compression: base.compression || { isCompressed: false, flatPct: 999 },
    volAcc: base.volAcc || { short: 1, medium: 1 },
    thresholds: base.thresholds || { depthFloorUsd: 0, depthOk: false },
    tradePlan: base.tradePlan || null,
    stage: String(base.stage || "HOLD"),
    stageWhy: String(base.stageWhy || "open_position_live_tracker"),
    change1h: n(base.change1h, 0),
    change24: n(base.change24, 0),
    vm: n(base.vm, 0),
    entryQuality: n(base.entryQuality, 0),
    persistenceScore: n(base.persistenceScore, 0),
    moveScore: n(base.moveScore, 0),
    velocity: n(base.velocity, 0),
    marketCap: n(base.marketCap, 0),
    volume: n(base.volume, 0),
    range24: n(base.range24, 0),
    name: base.name || sym,
    image: base.image || "",
  };
}

export function calculateThesisDamage(coin, prevState, mode) {
  let damage = 0;
  const reasons = {};

  const obScore = n(coin?.ob?.score, 0);
  if (mode === "bull" && obScore < -0.02) {
    damage += 2;
    reasons.obContra = true;
  }
  if (mode === "bear" && obScore > 0.02) {
    damage += 2;
    reasons.obContra = true;
  }

  const v1 = n(coin?.volAcc?.short, 1);
  const v2 = n(coin?.volAcc?.medium, 1);
  if (v1 < 1.01 && v2 < 1.04) {
    damage += 1;
    reasons.volDead = true;
  }

  if (!coin?.breakout?.ready) {
    damage += 1;
    reasons.breakoutLost = true;
  }

  const ps = n(coin?.persistenceScore, 0);
  const prevPs = n(prevState?.persistenceScore, 0);
  if (ps < prevPs - 15) {
    damage += 2;
    reasons.persistDrop = true;
  }

  return { damage, reasons };
}

export function isThesisStillValid(coin, prevState, mode) {
  const { damage } = calculateThesisDamage(coin, prevState, mode);
  return damage < 3;
}

export function makePortfolio(mode, positions) {
  const open = Array.isArray(positions?.open) ? positions.open : [];
  const closed = Array.isArray(positions?.closed) ? positions.closed : [];

  let realizedUsd = 0;
  let avgRealizedPct = 0;

  if (closed.length) {
    realizedUsd = closed.reduce((a, b) => a + n(b.pnlUsd), 0);
    avgRealizedPct = closed.reduce((a, b) => a + n(b.pnlPct), 0) / closed.length;
  }

  return {
    mode,
    posUsd: 50,
    openCount: open.length,
    closedCount: closed.length,
    realizedUsd: Number(realizedUsd.toFixed(2)),
    avgRealizedPct: Number(avgRealizedPct.toFixed(2)),
    updatedAt: Date.now(),
  };
}

export function buildHoldCoins({ positions, universeMap, stateMap, now }) {
  return positions.open
    .map((p) => {
      const sym = up(p.symbol);
      const coin = universeMap.get(sym);
      const state = stateMap?.[sym] || {};

      return {
        symbol: sym,
        name: coin?.name || state?.name || sym,
        image: coin?.image || state?.image || "",
        price:
          n(coin?.price, 0) ||
          n(state?.lastPrice, 0) ||
          n(state?.price, 0) ||
          n(p.lastPrice, 0),
        marketCap: n(coin?.marketCap, 0) || n(state?.marketCap, 0),
        volume: n(coin?.volume, 0) || n(state?.volume, 0),
        change24: n(coin?.change24, 0) || n(state?.change24, 0),
        change1h: n(coin?.change1h, 0) || n(state?.change1h, 0),
        vm: n(coin?.vm, 0) || n(state?.vm, 0),
        stage: "HOLD",
        breakout:
          coin?.breakout ||
          state?.breakout || { ready: false, breakoutPct: 0, pressure: 0 },
        compression:
          coin?.compression ||
          state?.compression || { isCompressed: false, flatPct: 999 },
        ob: coin?.ob || state?.ob || null,
        tradePlan: coin?.tradePlan || state?.tradePlan || null,
        pnlPct: n(p.pnlPct, 0),
        holdTime: Math.floor((now - n(p.entryAt, now)) / (60 * 1000)),
      };
    })
    .filter(Boolean)
    .sort((a, b) => Math.abs(n(b.pnlPct, 0)) - Math.abs(n(a.pnlPct, 0)));
}