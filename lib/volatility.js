// lib/volatility.js
// RUNNER VOLATILITY ENGINE
// Compatibel met tradeSystem:
// - getVolatility(c) => "LOW" | "MEDIUM" | "HIGH"
// - getVolatilityRegime(c) => object met level/tpMultiplier/slMultiplier/trailPerc

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function absNum(value, fallback = 0) {
  return Math.abs(num(value, fallback));
}

function normalizeAtrPct(value) {
  const n = absNum(value, 0);
  if (!n) return 0;

  // 0.012 = 1.2%
  if (n > 0 && n < 0.30) return n * 100;

  return n;
}

function normalizeFlow(flow) {
  return String(flow || "NEUTRAL").toUpperCase();
}

function getAtrComposite(c = {}) {
  const atr15 = normalizeAtrPct(c.atrPct15m);
  const atr1h = normalizeAtrPct(c.atrPct1h);
  const atr4h = normalizeAtrPct(c.atrPct4h);
  const atr24 = normalizeAtrPct(c.atrPct24h);

  const values = [];

  if (atr15 > 0) values.push({ value: atr15, weight: 0.45 });
  if (atr1h > 0) values.push({ value: atr1h, weight: 0.32 });
  if (atr4h > 0) values.push({ value: atr4h, weight: 0.15 });
  if (atr24 > 0) values.push({ value: atr24, weight: 0.08 });

  if (!values.length) return 0;

  const weightSum = values.reduce((sum, x) => sum + x.weight, 0);
  const weighted = values.reduce((sum, x) => sum + x.value * x.weight, 0);

  return weighted / weightSum;
}

function getVolatilityScore(c = {}) {
  const ch1 = absNum(c.change1h);
  const ch24 = absNum(c.change24);
  const vm = num(c.vm, 0);
  const moveScore = num(c.moveScore, 0);
  const atr = getAtrComposite(c);
  const flow = normalizeFlow(c.flow);
  const pressure = Math.abs(num(c.runnerPressure, 0));
  const acceleration = Math.abs(num(c.runnerAcceleration, 0));

  let score = 0;

  // 1h impulse
  if (ch1 >= 3.0) score += 34;
  else if (ch1 >= 2.0) score += 27;
  else if (ch1 >= 1.2) score += 20;
  else if (ch1 >= 0.65) score += 13;
  else if (ch1 >= 0.30) score += 7;
  else if (ch1 >= 0.12) score += 3;

  // 24h expansion
  if (ch24 >= 15) score += 28;
  else if (ch24 >= 10) score += 23;
  else if (ch24 >= 6) score += 16;
  else if (ch24 >= 3) score += 10;
  else if (ch24 >= 1.5) score += 5;

  // ATR expansion
  if (atr >= 4.0) score += 24;
  else if (atr >= 2.5) score += 18;
  else if (atr >= 1.5) score += 11;
  else if (atr >= 0.8) score += 6;
  else if (atr >= 0.4) score += 3;

  // Participation
  if (vm >= 0.30) score += 10;
  else if (vm >= 0.18) score += 7;
  else if (vm >= 0.10) score += 4;
  else if (vm >= 0.05) score += 2;

  // Runner pressure
  if (pressure >= 1.5) score += 8;
  else if (pressure >= 0.75) score += 5;
  else if (pressure >= 0.25) score += 2;

  if (acceleration >= 1.0) score += 7;
  else if (acceleration >= 0.35) score += 4;

  if (flow === "SQUEEZE") score += 10;
  else if (flow === "RUNNING") score += 7;
  else if (flow === "BREAKOUT") score += 5;
  else if (flow === "BUILDING") score += 2;

  if (moveScore >= 90) score += 8;
  else if (moveScore >= 80) score += 5;
  else if (moveScore >= 70) score += 3;

  return clamp(Math.round(score), 0, 100);
}

function classifyVolatility(c = {}) {
  const ch1 = absNum(c.change1h);
  const ch24 = absNum(c.change24);
  const atr = getAtrComposite(c);
  const volScore = getVolatilityScore(c);
  const flow = normalizeFlow(c.flow);

  if (
    volScore >= 58 ||
    ch1 >= 2.5 ||
    ch24 >= 10 ||
    atr >= 3.5 ||
    flow === "SQUEEZE"
  ) {
    return "HIGH";
  }

  if (
    volScore <= 18 &&
    ch1 < 0.25 &&
    ch24 < 1.5 &&
    atr < 0.75 &&
    flow !== "BUILDING"
  ) {
    return "LOW";
  }

  return "MEDIUM";
}

// ================= PUBLIC API =================
export function getVolatility(c) {
  return classifyVolatility(c);
}

export function getVolatilityRegime(c) {
  const level = classifyVolatility(c);
  const score = getVolatilityScore(c);
  const atrPct = getAtrComposite(c);
  const flow = normalizeFlow(c?.flow);

  if (level === "HIGH") {
    const isSqueeze = flow === "SQUEEZE";

    return {
      profile: "RUNNER",
      level: "HIGH",
      score,
      atrPct,

      tpMultiplier: isSqueeze ? 1.28 : 1.18,
      slMultiplier: isSqueeze ? 1.05 : 1.10,
      trailPerc: isSqueeze ? 0.38 : 0.45,

      entryAggression: "selective",
      reason: isSqueeze ? "RUNNER_SQUEEZE_VOL" : "VOL_EXPANSION"
    };
  }

  if (level === "LOW") {
    return {
      profile: "RUNNER",
      level: "LOW",
      score,
      atrPct,

      tpMultiplier: 0.88,
      slMultiplier: 0.92,
      trailPerc: 0.22,

      entryAggression: "strict",
      reason: "LOW_ACTIVITY"
    };
  }

  return {
    profile: "RUNNER",
    level: "MEDIUM",
    score,
    atrPct,

    tpMultiplier: 1.00,
    slMultiplier: 1.00,
    trailPerc: 0.30,

    entryAggression: "normal",
    reason: "NORMAL_ACTIVITY"
  };
}

export function getVolatilityDebug(c) {
  return {
    profile: "RUNNER",
    level: classifyVolatility(c),
    score: getVolatilityScore(c),
    atrPct: getAtrComposite(c),
    change1hAbs: absNum(c.change1h),
    change24Abs: absNum(c.change24),
    vm: num(c.vm, 0),
    moveScore: num(c.moveScore, 0),
    runnerPressure: num(c.runnerPressure, 0),
    runnerAcceleration: num(c.runnerAcceleration, 0),
    flow: normalizeFlow(c.flow)
  };
}