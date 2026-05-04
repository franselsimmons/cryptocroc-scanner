// lib/flowEngine.js

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

function normalizeSide(side) {
  return String(side || "").toLowerCase() === "bear" ? "bear" : "bull";
}

function getDirectionalValues(c) {
  const side = normalizeSide(c?.side);
  const dir = side === "bear" ? -1 : 1;

  const rawCh1 = safeNumber(c?.change1h, 0);
  const rawCh24 = safeNumber(c?.change24, 0);

  const ch1 = rawCh1 * dir;
  const ch24 = rawCh24 * dir;
  const vm = safeNumber(c?.vm, 0);

  const pressure = Number.isFinite(Number(c?.runnerPressure))
    ? Number(c.runnerPressure)
    : (ch1 * 0.78) + (ch24 * 0.22);

  const acceleration = Number.isFinite(Number(c?.runnerAcceleration))
    ? Number(c.runnerAcceleration)
    : ch1 - (ch24 / 24);

  return {
    side,
    rawCh1,
    rawCh24,
    ch1,
    ch24,
    vm,
    pressure,
    acceleration
  };
}

function getStrength(score) {
  if (score >= 85) return "EXTREME";
  if (score >= 70) return "HIGH";
  if (score >= 50) return "MID";
  if (score >= 30) return "LOW";
  return "WEAK";
}

export function analyzeFlow(c) {
  const v = getDirectionalValues(c);
  const score = safeNumber(c?.moveScore, 0);
  const freshness = safeNumber(c?.freshness, 0);

  let type = "NEUTRAL";
  let strengthScore = 0;

  if (v.ch1 < 0 && v.pressure < 0) {
    return {
      type: "EXHAUSTION",
      strength: "HIGH",
      direction: v.side,
      runnerFlow: false,
      pressure: v.pressure,
      acceleration: v.acceleration,
      reason: "directional_pressure_reversed"
    };
  }

  if (v.ch24 > 12 && v.ch1 < 0.25 && v.acceleration < 0) {
    return {
      type: "EXHAUSTION",
      strength: "HIGH",
      direction: v.side,
      runnerFlow: false,
      pressure: v.pressure,
      acceleration: v.acceleration,
      reason: "old_move_no_continuation"
    };
  }

  if (v.ch1 > 2.2 && v.vm > 0.10 && v.pressure > 0.8) {
    type = "SQUEEZE";
    strengthScore = 90;
  } else if (v.ch1 > 1.0 && v.ch24 > 2.0 && v.pressure > 0.45) {
    type = "RUNNING";
    strengthScore = 78;
  } else if (v.ch1 > 0.45 || v.ch24 > 2.5) {
    type = "BREAKOUT";
    strengthScore = 62;
  } else if (v.ch1 > 0.18 || v.ch24 > 0.75) {
    type = "BUILDING";
    strengthScore = 44;
  }

  if (v.acceleration > 1.0) strengthScore += 8;
  else if (v.acceleration > 0.35) strengthScore += 4;
  else if (v.acceleration < -0.35) strengthScore -= 10;

  if (freshness >= 16) strengthScore += 5;
  if (score >= 80) strengthScore += 5;
  if (v.vm >= 0.25) strengthScore += 4;

  strengthScore = Math.max(0, Math.min(100, Math.round(strengthScore)));

  return {
    type,
    strength: getStrength(strengthScore),
    strengthScore,

    direction: v.side,
    runnerFlow: RUNNER_FLOWS.has(type),

    pressure: v.pressure,
    acceleration: v.acceleration,

    ch1: v.ch1,
    ch24: v.ch24,
    vm: v.vm
  };
}

export function isRunnerFlow(flow) {
  const type = typeof flow === "string"
    ? flow.toUpperCase()
    : String(flow?.type || "").toUpperCase();

  return RUNNER_FLOWS.has(type);
}