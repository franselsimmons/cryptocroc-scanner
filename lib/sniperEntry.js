// lib/sniperEntry.js
// Compat-bestand.
// Oude export getSniperEntry blijft bestaan, maar logica is runner-entry scoring.

import {
  detectWallPersistence,
  detectAbsorption,
  detectSpoofing,
  detectOrderbookPressure
} from "./institutional.js";

import {
  getOrderbookHistory,
  getOrderbookMemorySummary
} from "./orderbookMemory.js";

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

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(Number(value || 0), max));
}

function normalizeSide(side) {
  return String(side || "").toLowerCase() === "bear" ? "bear" : "bull";
}

function normalizeFlow(flow) {
  return String(flow || "NEUTRAL").toUpperCase();
}

function getRunnerPressure(c) {
  if (Number.isFinite(Number(c?.runnerPressure))) {
    return Number(c.runnerPressure);
  }

  const side = normalizeSide(c?.side);
  const dir = side === "bear" ? -1 : 1;

  const ch24 = safeNumber(c?.change24, 0) * dir;
  const ch1 = safeNumber(c?.change1h, 0) * dir;

  return (ch1 * 0.78) + (ch24 * 0.22);
}

function getRunnerAcceleration(c) {
  if (Number.isFinite(Number(c?.runnerAcceleration))) {
    return Number(c.runnerAcceleration);
  }

  const side = normalizeSide(c?.side);
  const dir = side === "bear" ? -1 : 1;

  const ch24 = safeNumber(c?.change24, 0) * dir;
  const ch1 = safeNumber(c?.change1h, 0) * dir;

  return ch1 - (ch24 / 24);
}

function flowScore(flow) {
  if (flow === "SQUEEZE") return 20;
  if (flow === "RUNNING") return 17;
  if (flow === "BREAKOUT") return 13;
  if (flow === "BUILDING") return 6;
  return -12;
}

function classifyRunnerEntry(score, flow, pressure, acceleration) {
  if (flow === "SQUEEZE" && score >= 86) return "RUNNER_C_SQUEEZE";
  if (flow === "RUNNING" && pressure >= 0.45 && acceleration >= 0.15) return "RUNNER_A_BREAKOUT";
  if (flow === "BREAKOUT" && score >= 74) return "RUNNER_A_BREAKOUT";
  if (score >= 68) return "RUNNER_B_CONTINUATION";

  return "RUNNER_WEAK";
}

function scoreRsi(rsiSignal, side) {
  if (!rsiSignal?.valid) {
    return {
      score: 2,
      blocked: false,
      reason: "RSI_UNAVAILABLE"
    };
  }

  if (rsiSignal.blocked || rsiSignal.exhaustion) {
    return {
      score: -18,
      blocked: true,
      reason: rsiSignal.blockReason || "RSI_EXHAUSTION"
    };
  }

  const normalizedSide = normalizeSide(side);
  const isBull = normalizedSide === "bull";

  let score = 0;

  const continuationScore = safeNumber(rsiSignal.continuationScore, 0);
  const strength = safeNumber(rsiSignal.strength, 0);
  const slope3 = safeNumber(rsiSignal.slope3, 0);

  score += Math.min(continuationScore * 1.5, 12);
  score += Math.min(strength * 3, 9);

  if (isBull && rsiSignal.rising) score += 5;
  if (!isBull && rsiSignal.falling) score += 5;

  if (isBull && slope3 < -1.5) score -= 7;
  if (!isBull && slope3 > 1.5) score -= 7;

  return {
    score,
    blocked: false,
    reason: "RSI_OK"
  };
}

function scoreOrderbook(c, ob, history) {
  const side = normalizeSide(c?.side);
  const isBull = side === "bull";

  const walls = detectWallPersistence(history);
  const absorption = detectAbsorption(c, history);
  const spoof = detectSpoofing(history);
  const pressure = detectOrderbookPressure(c, history);

  if (spoof.spoof || ob?.spoof) {
    return {
      score: -30,
      blocked: true,
      reason: "SPOOF_DETECTED",
      walls,
      absorption,
      spoof,
      pressure
    };
  }

  let score = 0;

  if (isBull && ob?.bias === "BULLISH") score += 12;
  if (!isBull && ob?.bias === "BEARISH") score += 12;

  if (isBull && ob?.bias === "BEARISH") score -= 10;
  if (!isBull && ob?.bias === "BULLISH") score -= 10;

  if (isBull && walls.bidWallStrong) score += 7;
  if (!isBull && walls.askWallStrong) score += 7;

  if (absorption.runnerAbsorption) score += 8;

  if (pressure.valid) score += 8;
  if (isBull && pressure.bias === "BULLISH") score += 8;
  if (!isBull && pressure.bias === "BEARISH") score += 8;

  if (ob?.runnerTradable) score += 6;
  if (safeNumber(ob?.qualityScore, 0) >= 55) score += 5;
  if (safeNumber(ob?.spreadPct, 0) > 0.14) score -= 10;

  return {
    score,
    blocked: false,
    reason: "OB_OK",
    walls,
    absorption,
    spoof,
    pressure
  };
}

export function getRunnerEntry(c, ob = {}, rsiSignal = null, options = {}) {
  const symbol = c?.symbol;
  const side = normalizeSide(c?.side);
  const flow = normalizeFlow(c?.flow);

  const history = getOrderbookHistory(symbol);
  const memorySummary = getOrderbookMemorySummary(symbol);

  const runnerPressure = getRunnerPressure(c);
  const runnerAcceleration = getRunnerAcceleration(c);

  const obScore = scoreOrderbook(c, ob, history);
  if (obScore.blocked && options.blockSpoof !== false) {
    return {
      valid: false,
      type: "SPOOF_DETECTED",
      entryType: "RUNNER_BLOCKED_SPOOF",
      score: 0,
      runnerScore: 0,
      reason: obScore.reason,
      blocked: true,
      runnerPressure,
      runnerAcceleration,
      memorySummary
    };
  }

  const rsiScore = scoreRsi(rsiSignal, side);
  if (rsiScore.blocked && options.blockRsiExhaustion !== false) {
    return {
      valid: false,
      type: "RSI_EXHAUSTION",
      entryType: "RUNNER_BLOCKED_RSI",
      score: 0,
      runnerScore: 0,
      reason: rsiScore.reason,
      blocked: true,
      runnerPressure,
      runnerAcceleration,
      memorySummary
    };
  }

  let score = 0;

  const confluence = safeNumber(c?.confluence, 0);
  const moveScore = safeNumber(c?.moveScore ?? c?.score, 0);
  const freshness = safeNumber(c?.freshness, 0);
  const edge = safeNumber(c?.edge, 0);

  score += confluence * 0.32;
  score += moveScore * 0.28;
  score += flowScore(flow);
  score += obScore.score;
  score += rsiScore.score;

  if (freshness >= 20) score += 9;
  else if (freshness >= 12) score += 6;
  else if (freshness >= 6) score += 3;
  else score -= 6;

  if (runnerPressure >= 1.2) score += 10;
  else if (runnerPressure >= 0.45) score += 7;
  else if (runnerPressure >= 0.12) score += 3;
  else score -= 8;

  if (runnerAcceleration >= 1.0) score += 8;
  else if (runnerAcceleration >= 0.25) score += 5;
  else if (runnerAcceleration >= -0.25) score += 1;
  else score -= 9;

  if (edge >= 5) score += 5;
  else if (edge >= 2.5) score += 3;

  if (memorySummary.stableDirection === "BULLISH" && side === "bull") score += 4;
  if (memorySummary.stableDirection === "BEARISH" && side === "bear") score += 4;

  if (memorySummary.latestSpoof) score -= 8;
  if (!RUNNER_FLOWS.has(flow)) score -= 15;

  score = clamp(Math.round(score), 0, 100);

  const entryType = classifyRunnerEntry(
    score,
    flow,
    runnerPressure,
    runnerAcceleration
  );

  const valid =
    score >= 74 ||
    (score >= 68 && confluence >= 72 && RUNNER_FLOWS.has(flow)) ||
    (score >= 64 && flow === "SQUEEZE" && runnerPressure >= 0.45);

  return {
    valid,
    score,
    runnerScore: score,

    type:
      score >= 86 ? "RUNNER_ELITE" :
      score >= 76 ? "RUNNER_STRONG" :
      score >= 66 ? "RUNNER_OK" :
      "RUNNER_WEAK",

    entryType,
    runnerEntryType: entryType,

    blocked: false,
    reason: valid ? "RUNNER_ENTRY_OK" : "RUNNER_SCORE_TOO_LOW",

    flow,
    runnerPressure,
    runnerAcceleration,

    obScore: obScore.score,
    rsiScore: rsiScore.score,

    walls: obScore.walls,
    absorption: obScore.absorption,
    spoof: obScore.spoof,
    orderbookPressure: obScore.pressure,
    memorySummary
  };
}

// Backward-compatible export.
// Oude tradeSystem.js mag getSniperEntry blijven aanroepen.
export function getSniperEntry(c, ob, rsiSignal) {
  return getRunnerEntry(c, ob, rsiSignal);
}