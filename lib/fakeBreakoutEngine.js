// lib/fakeBreakoutEngine.js
// Runner-versie:
// - Detecteert sweep/reclaim setups.
// - Detecteert breakout-traps tegen de runner-richting.
// - Geeft expliciet terug of runner entry bevestigd of geblokkeerd moet worden.

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(Number(value || 0), max));
}

function pctDistance(a, b) {
  const x = safeNumber(a);
  const y = safeNumber(b);

  if (!x || !y) return Infinity;

  return Math.abs(x - y) / y;
}

function hasZoneNearPrice(price, zone, maxDistPct = 0.018) {
  if (!price || !zone) return false;
  return pctDistance(price, zone) <= maxDistPct;
}

function getRecentHighLow(candles, lookback = 20) {
  const list = Array.isArray(candles) ? candles.slice(-lookback) : [];

  if (list.length < 5) {
    return {
      high: null,
      low: null,
      lastClose: null,
      lastOpen: null,
      lastHigh: null,
      lastLow: null,
      bodyPct: 0,
      wickTopPct: 0,
      wickBottomPct: 0
    };
  }

  const highs = list.map(c => safeNumber(c.high)).filter(Boolean);
  const lows = list.map(c => safeNumber(c.low)).filter(Boolean);
  const last = list[list.length - 1];

  const open = safeNumber(last?.open, null);
  const high = safeNumber(last?.high, null);
  const low = safeNumber(last?.low, null);
  const close = safeNumber(last?.close, null);

  const range = high && low ? Math.max(high - low, 0) : 0;
  const body = open && close ? Math.abs(close - open) : 0;

  return {
    high: highs.length ? Math.max(...highs) : null,
    low: lows.length ? Math.min(...lows) : null,
    lastClose: close,
    lastOpen: open,
    lastHigh: high,
    lastLow: low,
    bodyPct: range > 0 ? body / range : 0,
    wickTopPct: range > 0 && high && close ? (high - Math.max(open, close)) / range : 0,
    wickBottomPct: range > 0 && low && close ? (Math.min(open, close) - low) / range : 0
  };
}

function zoneListHasNearPrice(zones, price, maxDistPct) {
  if (!Array.isArray(zones) || !zones.length) return false;
  return zones.some(z => hasZoneNearPrice(price, z, maxDistPct));
}

function getRunnerPressure(c) {
  if (Number.isFinite(Number(c?.runnerPressure))) {
    return Number(c.runnerPressure);
  }

  const side = String(c?.side || "").toLowerCase();
  const dir = side === "bear" ? -1 : 1;

  const ch24 = safeNumber(c?.change24, 0) * dir;
  const ch1 = safeNumber(c?.change1h, 0) * dir;

  return (ch1 * 0.78) + (ch24 * 0.22);
}

function getRunnerAcceleration(c) {
  if (Number.isFinite(Number(c?.runnerAcceleration))) {
    return Number(c.runnerAcceleration);
  }

  const side = String(c?.side || "").toLowerCase();
  const dir = side === "bear" ? -1 : 1;

  const ch24 = safeNumber(c?.change24, 0) * dir;
  const ch1 = safeNumber(c?.change1h, 0) * dir;

  return ch1 - (ch24 / 24);
}

function buildBaseResult(overrides = {}) {
  return {
    valid: false,
    type: "NONE",
    score: 0,
    zone: null,
    price: 0,
    confirmsRunner: false,
    blocksRunner: false,
    trapRisk: "LOW",
    runnerPressure: 0,
    runnerAcceleration: 0,
    ...overrides
  };
}

export function detectFakeBreakout(
  c,
  liquidation = null,
  liquidity = null,
  candles15m = [],
  options = {}
) {
  const price = safeNumber(c?.price);
  const side = String(c?.side || "").toLowerCase();
  const isBull = side === "bull";

  if (!price || (side !== "bull" && side !== "bear")) {
    return buildBaseResult({
      type: "INVALID_INPUT",
      price
    });
  }

  const maxZoneDistPct = safeNumber(options.maxZoneDistPct, 0.018);
  const reclaimBufferPct = safeNumber(options.reclaimBufferPct, 0.0015);
  const trapBufferPct = safeNumber(options.trapBufferPct, 0.0020);

  const recent = getRecentHighLow(candles15m, safeNumber(options.lookback, 20));

  const support = safeNumber(liquidity?.support);
  const resistance = safeNumber(liquidity?.resistance);

  const nearestBelow = safeNumber(liquidation?.nearestBelow);
  const nearestAbove = safeNumber(liquidation?.nearestAbove);
  const majorBelow = safeNumber(liquidation?.majorBelow);
  const majorAbove = safeNumber(liquidation?.majorAbove);

  const runnerPressure = getRunnerPressure(c);
  const runnerAcceleration = getRunnerAcceleration(c);

  let score = 0;
  let type = "NONE";
  let zone = null;
  let confirmsRunner = false;
  let blocksRunner = false;

  if (isBull) {
    const sweepZone = majorBelow || nearestBelow || support;
    const reclaimLevel = support || nearestBelow || majorBelow;
    const breakoutLevel = resistance || nearestAbove || majorAbove;

    const sweptBelow =
      Boolean(recent.low) &&
      Boolean(sweepZone) &&
      recent.low <= sweepZone * (1 - reclaimBufferPct);

    const reclaimed =
      Boolean(reclaimLevel) &&
      price >= reclaimLevel * (1 + reclaimBufferPct);

    const failedAbove =
      Boolean(recent.high) &&
      Boolean(breakoutLevel) &&
      recent.high >= breakoutLevel * (1 + trapBufferPct) &&
      price <= breakoutLevel * (1 - reclaimBufferPct);

    const nearSweepZone =
      hasZoneNearPrice(price, sweepZone, maxZoneDistPct) ||
      hasZoneNearPrice(price, reclaimLevel, maxZoneDistPct);

    if (sweptBelow && reclaimed) {
      score += 74;
      type = "BULLISH_SWEEP_RECLAIM";
      zone = sweepZone;
      confirmsRunner = true;
    } else if (sweptBelow && nearSweepZone) {
      score += 48;
      type = "BULLISH_SWEEP_PENDING_RECLAIM";
      zone = sweepZone;
    }

    if (failedAbove) {
      score += 78;
      type = "BULLISH_BREAKOUT_TRAP";
      zone = breakoutLevel;
      blocksRunner = true;
      confirmsRunner = false;
    }

    if (zoneListHasNearPrice(liquidation?.longZones, price, maxZoneDistPct)) score += 8;
    if (support && price > support) score += 7;
    if (runnerPressure > 0.15 && runnerAcceleration > -0.25 && confirmsRunner) score += 8;
    if (recent.wickBottomPct > 0.45 && reclaimed) score += 6;
  }

  if (!isBull) {
    const sweepZone = majorAbove || nearestAbove || resistance;
    const rejectLevel = resistance || nearestAbove || majorAbove;
    const breakdownLevel = support || nearestBelow || majorBelow;

    const sweptAbove =
      Boolean(recent.high) &&
      Boolean(sweepZone) &&
      recent.high >= sweepZone * (1 + reclaimBufferPct);

    const rejected =
      Boolean(rejectLevel) &&
      price <= rejectLevel * (1 - reclaimBufferPct);

    const failedBelow =
      Boolean(recent.low) &&
      Boolean(breakdownLevel) &&
      recent.low <= breakdownLevel * (1 - trapBufferPct) &&
      price >= breakdownLevel * (1 + reclaimBufferPct);

    const nearSweepZone =
      hasZoneNearPrice(price, sweepZone, maxZoneDistPct) ||
      hasZoneNearPrice(price, rejectLevel, maxZoneDistPct);

    if (sweptAbove && rejected) {
      score += 74;
      type = "BEARISH_SWEEP_REJECT";
      zone = sweepZone;
      confirmsRunner = true;
    } else if (sweptAbove && nearSweepZone) {
      score += 48;
      type = "BEARISH_SWEEP_PENDING_REJECT";
      zone = sweepZone;
    }

    if (failedBelow) {
      score += 78;
      type = "BEARISH_BREAKDOWN_TRAP";
      zone = breakdownLevel;
      blocksRunner = true;
      confirmsRunner = false;
    }

    if (zoneListHasNearPrice(liquidation?.shortZones, price, maxZoneDistPct)) score += 8;
    if (resistance && price < resistance) score += 7;
    if (runnerPressure > 0.15 && runnerAcceleration > -0.25 && confirmsRunner) score += 8;
    if (recent.wickTopPct > 0.45 && rejected) score += 6;
  }

  score = clamp(Math.round(score), 0, 100);

  let trapRisk = "LOW";
  if (blocksRunner && score >= 70) trapRisk = "HIGH";
  else if (blocksRunner || score >= 55) trapRisk = "MID";

  return {
    valid: score >= 60,
    type,
    score,
    zone,
    price,

    confirmsRunner,
    blocksRunner,
    trapRisk,

    runnerPressure,
    runnerAcceleration,

    recentHigh: recent.high,
    recentLow: recent.low,
    recentLastClose: recent.lastClose,
    recentWickTopPct: recent.wickTopPct,
    recentWickBottomPct: recent.wickBottomPct,

    nearestAbove,
    nearestBelow,
    majorAbove,
    majorBelow
  };
}