// ================= confluenceEngine.js - RUNNER VERSION =================

const RUNNER_FLOWS = new Set([
  "SQUEEZE",
  "RUNNING",
  "BREAKOUT",
  "BUILDING"
]);

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampScore(score) {
  return Math.max(0, Math.min(Math.round(score), 100));
}

function normalizeFlow(flow) {
  return String(flow || "NEUTRAL").toUpperCase();
}

function isBullSide(c) {
  return String(c?.side || "").toLowerCase() !== "bear";
}

function getRunnerPressure(c) {
  if (Number.isFinite(Number(c?.runnerPressure))) {
    return Number(c.runnerPressure);
  }

  const dir = isBullSide(c) ? 1 : -1;
  const ch24 = safeNumber(c?.change24, 0) * dir;
  const ch1 = safeNumber(c?.change1h, 0) * dir;

  return (ch1 * 0.78) + (ch24 * 0.22);
}

function getRunnerAcceleration(c) {
  if (Number.isFinite(Number(c?.runnerAcceleration))) {
    return Number(c.runnerAcceleration);
  }

  const dir = isBullSide(c) ? 1 : -1;
  const ch24 = safeNumber(c?.change24, 0) * dir;
  const ch1 = safeNumber(c?.change1h, 0) * dir;

  return ch1 - (ch24 / 24);
}

function addFlowScore(flow) {
  if (flow === "SQUEEZE") return 24;
  if (flow === "RUNNING") return 22;
  if (flow === "BREAKOUT") return 16;
  if (flow === "BUILDING") return 9;
  return 0;
}

function addMomentumScore(moveScore) {
  if (moveScore >= 92) return 24;
  if (moveScore >= 86) return 21;
  if (moveScore >= 78) return 17;
  if (moveScore >= 70) return 12;
  if (moveScore >= 62) return 7;
  return 0;
}

function addPressureScore(pressure) {
  if (pressure >= 2.5) return 12;
  if (pressure >= 1.2) return 9;
  if (pressure >= 0.55) return 6;
  if (pressure >= 0.18) return 3;
  return -6;
}

function addAccelerationScore(acceleration) {
  if (acceleration >= 1.5) return 10;
  if (acceleration >= 0.75) return 7;
  if (acceleration >= 0.25) return 4;
  if (acceleration >= -0.25) return 0;
  if (acceleration >= -0.60) return -5;
  return -10;
}

function addFreshnessScore(freshness) {
  if (freshness >= 24) return 10;
  if (freshness >= 16) return 8;
  if (freshness >= 10) return 5;
  if (freshness >= 6) return 2;
  return -5;
}

function addOrderbookScore(isBull, ob = {}) {
  let score = 0;

  if (isBull && ob?.bias === "BULLISH") score += 14;
  if (!isBull && ob?.bias === "BEARISH") score += 14;

  const imbalance = safeNumber(ob?.imbalance, 1);

  if (isBull && imbalance >= 1.25) score += 5;
  if (!isBull && imbalance <= 0.80) score += 5;

  const spreadPct = safeNumber(ob?.spreadPct, 0.06);
  const depth = safeNumber(ob?.depthMinUsd1p, 0);

  if (spreadPct <= 0.04) score += 3;
  if (spreadPct > 0.12) score -= 7;

  if (depth >= 250000) score += 3;
  if (depth > 0 && depth < 50000) score -= 5;

  if (ob?.spoof) score -= 18;

  return score;
}

function addLiquidityScore(isBull, price, liquidity = {}) {
  let score = 0;

  if (!price) return score;

  if (isBull) {
    if (liquidity?.resistance && price < safeNumber(liquidity.resistance)) score += 8;
    if (liquidity?.resistanceSweep && price < safeNumber(liquidity.resistanceSweep)) score += 7;
    if (liquidity?.support && price > safeNumber(liquidity.support)) score += 4;
  } else {
    if (liquidity?.support && price > safeNumber(liquidity.support)) score += 8;
    if (liquidity?.supportSweep && price > safeNumber(liquidity.supportSweep)) score += 7;
    if (liquidity?.resistance && price < safeNumber(liquidity.resistance)) score += 4;
  }

  return score;
}

function addLiquidationScore(isBull, price, liquidation = null, flow = "NEUTRAL", moveScore = 0) {
  if (!liquidation?.clusters?.length) {
    return RUNNER_FLOWS.has(flow) && moveScore >= 75 ? 5 : 2;
  }

  let liqScore = 0;

  for (const cl of liquidation.clusters) {
    const clPrice = safeNumber(cl.price, 0);
    if (!clPrice || !price) continue;

    const dist = Math.abs(price - clPrice) / price;
    if (dist > 0.025) continue;

    const total = safeNumber(cl.longs, 0) + safeNumber(cl.shorts, 0);
    if (total <= 0) continue;

    const longRatio = safeNumber(cl.longs, 0) / total;
    const shortRatio = safeNumber(cl.shorts, 0) / total;

    if (isBull && clPrice > price && shortRatio > 0.55) liqScore += 12;
    if (!isBull && clPrice < price && longRatio > 0.55) liqScore += 12;

    if (isBull && clPrice < price && longRatio > 0.60) liqScore += 4;
    if (!isBull && clPrice > price && shortRatio > 0.60) liqScore += 4;
  }

  return Math.min(liqScore, 22);
}

function addFundingScore(isBull, funding = { rate: 0 }) {
  const rate = safeNumber(funding?.rate, 0);

  let score = 0;

  if (isBull && rate < 0) score += 6;
  if (!isBull && rate > 0) score += 6;

  if (Math.abs(rate) > 0.015) score -= 5;
  if (Math.abs(rate) > 0.030) score -= 5;

  return score;
}

function addRegimeScore(regime) {
  const r = String(regime || "").toUpperCase();

  if (r === "HIGH" || r === "HIGH_VOL") return 5;
  if (r === "LOW" || r === "LOW_VOL") return -5;

  return 0;
}

function addRsiRunnerScore(isBull, rsiCtx = null) {
  if (!rsiCtx?.valid) return 2;

  const rsi = safeNumber(rsiCtx.rsi, 50);
  const slope = safeNumber(rsiCtx.slope ?? rsiCtx.rsiSlope, 0);
  const zones = rsiCtx.zones || {};

  let score = 0;

  if (isBull) {
    if (rsi >= 58 && rsi <= 78) score += 10;
    else if (rsi > 78 && rsi <= 86) score += 5;
    else if (rsi > 88) score -= 8;
    else if (rsi < 45) score -= 5;

    if (slope > 0) score += 4;

    if (zones.L2 && rsi <= zones.L2 && slope > 0) score += 4;
  } else {
    if (rsi <= 42 && rsi >= 22) score += 10;
    else if (rsi < 22 && rsi >= 14) score += 5;
    else if (rsi < 12) score -= 8;
    else if (rsi > 55) score -= 5;

    if (slope < 0) score += 4;

    if (zones.U2 && rsi >= zones.U2 && slope < 0) score += 4;
  }

  return score;
}

export function calculateConfluence(
  c,
  ob = {},
  liquidity = {},
  funding = { rate: 0 },
  regime = "MEDIUM",
  liquidation = null,
  rsiCtx = null
) {
  let score = 0;

  const isBull = isBullSide(c);
  const price = safeNumber(c?.price, 0);
  const flow = normalizeFlow(c?.flow);
  const moveScore = safeNumber(c?.moveScore, 0);
  const freshness = safeNumber(c?.freshness, 0);
  const pressure = getRunnerPressure(c);
  const acceleration = getRunnerAcceleration(c);

  score += addFlowScore(flow);
  score += addMomentumScore(moveScore);
  score += addPressureScore(pressure);
  score += addAccelerationScore(acceleration);
  score += addFreshnessScore(freshness);

  score += addOrderbookScore(isBull, ob);
  score += addLiquidityScore(isBull, price, liquidity);
  score += addLiquidationScore(isBull, price, liquidation, flow, moveScore);
  score += addFundingScore(isBull, funding);
  score += addRegimeScore(regime);
  score += addRsiRunnerScore(isBull, rsiCtx);

  // Anti-exhaustion.
  if (moveScore >= 92 && acceleration < 0) score -= 7;
  if (flow === "SQUEEZE" && freshness < 8) score -= 6;
  if (!RUNNER_FLOWS.has(flow)) score -= 15;

  if (
    (liquidity?.resistance && liquidity?.resistanceSweep) ||
    (liquidity?.support && liquidity?.supportSweep)
  ) {
    score -= 3;
  }

  return clampScore(score);
}