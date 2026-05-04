// lib/timeframe.js
// RUNNER TIMEFRAME ENGINE
// Scanner MTF-context zonder echte candles.
// Output:
// - score: signed tf score voor bull/bear filters
// - strength: abs(score)
// - alignment: BULLISH / BEARISH / NEUTRAL
// - atrPct15m/1h/4h/24h als decimal.
//   0.012 = 1.2%

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function pctToDecimal(pct) {
  return Number(pct || 0) / 100;
}

function normalizeSide(side) {
  return String(side || "bull").toLowerCase() === "bear" ? "bear" : "bull";
}

function normalizeFlow(flow) {
  return String(flow || "NEUTRAL").toUpperCase();
}

function estimateAtrPcts({ ch1Abs, ch24Abs, freshness, vm, pressureAbs, accelerationAbs }) {
  const atr15Pct = clamp(
    (ch1Abs * 0.34) +
      (freshness * 0.018) +
      (vm * 0.75) +
      (pressureAbs * 0.12) +
      (accelerationAbs * 0.08),
    0.10,
    3.20
  );

  const atr1hPct = clamp(
    Math.max(ch1Abs * 0.92, atr15Pct * 1.38),
    0.18,
    4.80
  );

  const atr4hPct = clamp(
    Math.max(ch24Abs * 0.26, atr1hPct * 1.55),
    0.35,
    8.50
  );

  const atr24hPct = clamp(
    Math.max(ch24Abs * 0.62, atr4hPct * 1.70),
    0.75,
    18.00
  );

  return {
    atrPct15m: pctToDecimal(atr15Pct),
    atrPct1h: pctToDecimal(atr1hPct),
    atrPct4h: pctToDecimal(atr4hPct),
    atrPct24h: pctToDecimal(atr24hPct),

    atrPct15mDisplay: atr15Pct,
    atrPct1hDisplay: atr1hPct,
    atrPct4hDisplay: atr4hPct,
    atrPct24hDisplay: atr24hPct
  };
}

function getRunnerPressure(c, side) {
  if (Number.isFinite(Number(c?.runnerPressure))) {
    return Number(c.runnerPressure);
  }

  const dir = side === "bear" ? -1 : 1;
  const ch1 = safeNumber(c?.change1h) * dir;
  const ch24 = safeNumber(c?.change24) * dir;

  return (ch1 * 0.78) + (ch24 * 0.22);
}

function getRunnerAcceleration(c, side) {
  if (Number.isFinite(Number(c?.runnerAcceleration))) {
    return Number(c.runnerAcceleration);
  }

  const dir = side === "bear" ? -1 : 1;
  const ch1 = safeNumber(c?.change1h) * dir;
  const ch24 = safeNumber(c?.change24) * dir;

  return ch1 - (ch24 / 24);
}

function flowBonus(flow) {
  if (flow === "SQUEEZE") return 4;
  if (flow === "RUNNING") return 3;
  if (flow === "BREAKOUT") return 2;
  if (flow === "BUILDING") return 1;
  if (flow === "TREND") return 2;
  return 0;
}

export function buildTimeframeContext(c) {
  const side = normalizeSide(c?.side);
  const dir = side === "bear" ? -1 : 1;

  const ch1Raw = safeNumber(c?.change1h);
  const ch24Raw = safeNumber(c?.change24);

  const ch1 = ch1Raw * dir;
  const ch24 = ch24Raw * dir;

  const ch1Abs = Math.abs(ch1Raw);
  const ch24Abs = Math.abs(ch24Raw);

  const freshness = safeNumber(c?.freshness);
  const vm = safeNumber(c?.vm);
  const flow = normalizeFlow(c?.flow);

  const pressure = getRunnerPressure(c, side);
  const acceleration = getRunnerAcceleration(c, side);

  let raw = 0;

  // ================= PRICE ALIGNMENT =================
  if (ch1 > 0.03) raw += 1;
  if (ch1 > 0.18) raw += 1;
  if (ch1 > 0.45) raw += 1;
  if (ch1 > 0.95) raw += 1;
  if (ch1 > 1.80) raw += 1;

  if (ch24 > 0.35) raw += 1;
  if (ch24 > 1.00) raw += 1;
  if (ch24 > 2.50) raw += 1;
  if (ch24 > 5.00) raw += 1;

  // ================= RUNNER PRESSURE =================
  if (pressure > 0.08) raw += 1;
  if (pressure > 0.35) raw += 1;
  if (pressure > 0.85) raw += 1;
  if (pressure > 1.60) raw += 1;

  // ================= ACCELERATION =================
  if (acceleration > -0.25) raw += 1;
  if (acceleration > 0.20) raw += 1;
  if (acceleration > 0.75) raw += 1;

  // ================= FLOW BONUS =================
  raw += flowBonus(flow);

  // ================= FRESHNESS BONUS =================
  if (freshness >= 4) raw += 1;
  if (freshness >= 9) raw += 1;
  if (freshness >= 15) raw += 1;
  if (freshness >= 22) raw += 1;

  // ================= LIQUIDITY / PARTICIPATION BONUS =================
  if (vm >= 0.025) raw += 1;
  if (vm >= 0.055) raw += 1;
  if (vm >= 0.12) raw += 1;

  // ================= PENALTIES =================
  if (ch1 <= 0 && ch24 <= 0) raw -= 3;
  if (pressure < 0) raw -= 3;
  if (acceleration < -0.50) raw -= 2;
  if (flow === "NEUTRAL" && freshness < 4) raw -= 2;

  // Late move penalty.
  if (ch24 > 9 && ch1 < 0.25) raw -= 2;
  if (ch24 > 14 && ch1 < 0.45) raw -= 3;

  // Directionele mismatch.
  if (side === "bull" && ch1Raw < 0 && ch24Raw < 0) raw -= 3;
  if (side === "bear" && ch1Raw > 0 && ch24Raw > 0) raw -= 3;

  // ================= LEVEL =================
  let level = 0;

  if (raw >= 16) level = 4;
  else if (raw >= 12) level = 3;
  else if (raw >= 8) level = 2;
  else if (raw >= 4) level = 1;

  const signedScore = side === "bear" ? -level : level;

  const alignment =
    level <= 0
      ? "NEUTRAL"
      : side === "bear"
        ? "BEARISH"
        : "BULLISH";

  const atr = estimateAtrPcts({
    ch1Abs,
    ch24Abs,
    freshness,
    vm,
    pressureAbs: Math.abs(pressure),
    accelerationAbs: Math.abs(acceleration)
  });

  return {
    profile: "RUNNER",

    score: signedScore,
    strength: Math.abs(signedScore),
    rawScore: raw,
    level,
    alignment,
    side,

    ch1,
    ch24,
    ch1Raw,
    ch24Raw,
    ch1Abs,
    ch24Abs,

    freshness,
    vm,
    flow,

    runnerPressure: pressure,
    runnerAcceleration: acceleration,

    runnerContinuation:
      level >= 2 &&
      pressure >= 0.10 &&
      acceleration >= -0.35,

    runnerHot:
      level >= 3 &&
      pressure >= 0.35 &&
      ["SQUEEZE", "RUNNING", "BREAKOUT"].includes(flow),

    ...atr
  };
}

export function multiTFScore(c) {
  return buildTimeframeContext(c).score;
}