// lib/rsiEngine.js
// RUNNER RSI ENGINE
// Doel:
// - Momentum-continuation detectie
// - RSI 70+ is niet automatisch bearish
// - Extreme exhaustion alleen blokkeren bij slope-verlies
// - Backward-compatible met tradeSystem.js:
//   valid, strength, trend, blocked, rsi, zones, mean1h

// ================= CONFIG =================
const RSI_LENGTH = 14;
const RSI_SMOOTH = 14;
const RSI_FAST = 5;
const RSI_MEAN = 55;
const MIN_CANDLES = 80;

const ZONE_1 = 12; // U1 62 / L1 38
const ZONE_2 = 20; // U2 70 / L2 30
const ZONE_3 = 28; // U3 78 / L3 22

// ================= HELPERS =================
function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(x, min, max) {
  return Math.max(min, Math.min(max, Number(x)));
}

function last(arr, fallback = null) {
  return Array.isArray(arr) && arr.length ? arr[arr.length - 1] : fallback;
}

function ema(values, length) {
  if (!Array.isArray(values) || values.length === 0) return [];

  const k = 2 / (length + 1);
  const out = [];
  let prev = safeNumber(values[0], 0);

  for (let i = 0; i < values.length; i++) {
    const val = safeNumber(values[i], prev);
    prev = i === 0 ? val : (val * k + prev * (1 - k));
    out.push(prev);
  }

  return out;
}

function getSlope(values, bars = 3) {
  if (!Array.isArray(values) || values.length <= bars) return 0;

  const now = safeNumber(values[values.length - 1], 0);
  const prev = safeNumber(values[values.length - 1 - bars], now);

  return safeNumber(now - prev, 0);
}

function getZone(rsi, zones) {
  if (!Number.isFinite(Number(rsi)) || !zones) return "MID";

  if (rsi >= zones.U3) return "UPPER_3";
  if (rsi >= zones.U2) return "UPPER_2";
  if (rsi >= zones.U1) return "UPPER_1";

  if (rsi <= zones.L3) return "LOWER_3";
  if (rsi <= zones.L2) return "LOWER_2";
  if (rsi <= zones.L1) return "LOWER_1";

  return "MID";
}

function isLowerZone(zone) {
  return String(zone || "").startsWith("LOWER");
}

function isUpperZone(zone) {
  return String(zone || "").startsWith("UPPER");
}

function normalizeSide(side) {
  return String(side || "").toLowerCase() === "bear" ? "bear" : "bull";
}

// ================= RSI CALC =================
function rsiCalc(closes, length = RSI_LENGTH) {
  if (!Array.isArray(closes) || closes.length < length + 2) return [];

  const gains = [];
  const losses = [];

  for (let i = 1; i < closes.length; i++) {
    const diff = safeNumber(closes[i], 0) - safeNumber(closes[i - 1], 0);
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? Math.abs(diff) : 0);
  }

  const avgGain = ema(gains, length);
  const avgLoss = ema(losses, length);
  const rsi = [];

  for (let i = 0; i < avgGain.length; i++) {
    const gain = safeNumber(avgGain[i], 0);
    const loss = safeNumber(avgLoss[i], 0);

    if (loss === 0 && gain === 0) {
      rsi.push(50);
      continue;
    }

    if (loss === 0) {
      rsi.push(100);
      continue;
    }

    if (gain === 0) {
      rsi.push(0);
      continue;
    }

    const rs = gain / loss;
    rsi.push(100 - (100 / (1 + rs)));
  }

  return rsi;
}

function getMomentumState({ rsi, fast, mean, slope3, fastSlope3 }) {
  if (rsi >= 58 && fast >= rsi && slope3 > 0) return "BULL_CONTINUATION";
  if (rsi <= 42 && fast <= rsi && slope3 < 0) return "BEAR_CONTINUATION";

  if (rsi > mean && slope3 >= -0.35) return "BULL_BIAS";
  if (rsi < mean && slope3 <= 0.35) return "BEAR_BIAS";

  if (fastSlope3 > 1.0) return "BULL_ACCELERATION";
  if (fastSlope3 < -1.0) return "BEAR_ACCELERATION";

  return "NEUTRAL";
}

function getExhaustionState({ rsi, zone, slope3, fastSlope3 }) {
  if (zone === "UPPER_3" && rsi > 88 && slope3 < 0) return "BULL_EXHAUSTION";
  if (zone === "LOWER_3" && rsi < 12 && slope3 > 0) return "BEAR_EXHAUSTION";

  if (zone === "UPPER_3" && fastSlope3 < -1.25) return "BULL_MOMENTUM_LOSS";
  if (zone === "LOWER_3" && fastSlope3 > 1.25) return "BEAR_MOMENTUM_LOSS";

  return "NONE";
}

// ================= CORE RSI CONTEXT =================
export function getAdvancedRSIContext(candles) {
  if (!Array.isArray(candles) || candles.length < MIN_CANDLES) {
    return { valid: false };
  }

  const closes = candles
    .map(c => safeNumber(c?.close, 0))
    .filter(v => v > 0);

  if (closes.length < MIN_CANDLES) {
    return { valid: false };
  }

  const rsiRaw = rsiCalc(closes, RSI_LENGTH);

  if (rsiRaw.length < 20) {
    return { valid: false };
  }

  const rsiSmooth = ema(rsiRaw, RSI_SMOOTH);
  const rsiFast = ema(rsiRaw, RSI_FAST);
  const rsiMeanArr = ema(rsiSmooth, RSI_MEAN);

  const rsi = last(rsiSmooth, 50);
  const fast = last(rsiFast, rsi);
  const mean = last(rsiMeanArr, 50);

  const slope1 = getSlope(rsiSmooth, 1);
  const slope3 = getSlope(rsiSmooth, 3);
  const slope5 = getSlope(rsiSmooth, 5);
  const fastSlope3 = getSlope(rsiFast, 3);

  const zones = {
    U1: 50 + ZONE_1,
    U2: 50 + ZONE_2,
    U3: 50 + ZONE_3,
    L1: 50 - ZONE_1,
    L2: 50 - ZONE_2,
    L3: 50 - ZONE_3
  };

  const zone = getZone(rsi, zones);

  const recent = rsiSmooth.slice(-20);
  const recentHigh = recent.length ? Math.max(...recent) : rsi;
  const recentLow = recent.length ? Math.min(...recent) : rsi;
  const range20 = recentHigh - recentLow;

  const distanceFromMean = rsi - mean;

  const rising = slope3 > 0.75 || fastSlope3 > 1.0;
  const falling = slope3 < -0.75 || fastSlope3 < -1.0;

  const reclaimFromLower =
    (isLowerZone(zone) || zone === "MID") &&
    fast > rsi &&
    slope3 > 0;

  const rejectionFromUpper =
    (isUpperZone(zone) || zone === "MID") &&
    fast < rsi &&
    slope3 < 0;

  const momentumState = getMomentumState({
    rsi,
    fast,
    mean,
    slope3,
    fastSlope3
  });

  const exhaustionState = getExhaustionState({
    rsi,
    zone,
    slope3,
    fastSlope3
  });

  return {
    valid: true,

    // Backward-compatible
    rsi,
    mean,
    zones,

    // Extra runner context
    fast,
    zone,
    slope1,
    slope3,
    slope5,
    fastSlope3,
    rising,
    falling,
    reclaimFromLower,
    rejectionFromUpper,
    distanceFromMean,
    range20,

    momentumState,
    exhaustionState,

    bullishContinuation: ["BULL_CONTINUATION", "BULL_BIAS", "BULL_ACCELERATION"].includes(momentumState),
    bearishContinuation: ["BEAR_CONTINUATION", "BEAR_BIAS", "BEAR_ACCELERATION"].includes(momentumState),

    // Debug
    recentHigh,
    recentLow
  };
}

// ================= MTF =================
export function getMTFRSI({ m15, h1, h4 = null }) {
  const rsi15 = getAdvancedRSIContext(m15);
  const rsi1h = getAdvancedRSIContext(h1);
  const rsi4h = h4 ? getAdvancedRSIContext(h4) : null;

  return {
    m15: rsi15,
    h1: rsi1h,
    h4: rsi4h
  };
}

// ================= SIGNAL =================
export function getRSISignal(mtfrsi, side) {
  const { m15, h1, h4 } = mtfrsi || {};

  if (!m15?.valid || !h1?.valid) {
    return { valid: false };
  }

  const normalizedSide = normalizeSide(side);
  const isBull = normalizedSide === "bull";

  const m15Zone = m15.zone || getZone(m15.rsi, m15.zones);
  const h1Distance = h1.rsi - h1.mean;

  // Runner HTF trend:
  // LONG mag bij RSI boven mean of rising reclaim.
  // SHORT mag bij RSI onder mean of falling rejection.
  const trendLong =
    h1.rsi >= h1.mean - 3 ||
    h1.rising ||
    h1.bullishContinuation;

  const trendShort =
    h1.rsi <= h1.mean + 3 ||
    h1.falling ||
    h1.bearishContinuation;

  let blocked = false;
  let blockReason = null;

  // Hard block alleen bij HTF extreme + slope tegen richting.
  if (h4?.valid) {
    if (isBull && h4.exhaustionState === "BULL_EXHAUSTION") {
      blocked = true;
      blockReason = "H4_BULL_EXHAUSTION";
    }

    if (!isBull && h4.exhaustionState === "BEAR_EXHAUSTION") {
      blocked = true;
      blockReason = "H4_BEAR_EXHAUSTION";
    }

    if (isBull && h4.rsi < 32 && h4.slope3 < -0.75) {
      blocked = true;
      blockReason = "H4_BEAR_CONTROL";
    }

    if (!isBull && h4.rsi > 68 && h4.slope3 > 0.75) {
      blocked = true;
      blockReason = "H4_BULL_CONTROL";
    }
  }

  let pullbackStrength = 0;

  if (isBull) {
    if (m15.rsi <= m15.zones.L3) pullbackStrength = 3;
    else if (m15.rsi <= m15.zones.L2) pullbackStrength = 2;
    else if (m15.rsi <= m15.zones.L1) pullbackStrength = 1;
  } else {
    if (m15.rsi >= m15.zones.U3) pullbackStrength = 3;
    else if (m15.rsi >= m15.zones.U2) pullbackStrength = 2;
    else if (m15.rsi >= m15.zones.U1) pullbackStrength = 1;
  }

  let continuationScore = 0;

  if (isBull) {
    if (trendLong) continuationScore += 2;
    if (m15.rsi >= 55 && m15.rsi <= 82) continuationScore += 2;
    if (m15Zone === "MID" || m15Zone === "UPPER_1") continuationScore += 1;
    if (m15.rising) continuationScore += 2;
    if (m15.bullishContinuation) continuationScore += 2;
    if (h1.slope3 > -0.75) continuationScore += 1;
    if (m15Zone === "UPPER_3" && m15.slope3 < 0) continuationScore -= 4;
    if (m15.rsi > 88) continuationScore -= 3;
  } else {
    if (trendShort) continuationScore += 2;
    if (m15.rsi <= 45 && m15.rsi >= 18) continuationScore += 2;
    if (m15Zone === "MID" || m15Zone === "LOWER_1") continuationScore += 1;
    if (m15.falling) continuationScore += 2;
    if (m15.bearishContinuation) continuationScore += 2;
    if (h1.slope3 < 0.75) continuationScore += 1;
    if (m15Zone === "LOWER_3" && m15.slope3 > 0) continuationScore -= 4;
    if (m15.rsi < 12) continuationScore -= 3;
  }

  continuationScore = clamp(continuationScore, 0, 10);

  const pullbackOK = isBull
    ? ["LOWER_1", "LOWER_2", "LOWER_3", "MID"].includes(m15Zone) && m15.slope3 >= -1
    : ["UPPER_1", "UPPER_2", "UPPER_3", "MID"].includes(m15Zone) && m15.slope3 <= 1;

  const continuationOK = continuationScore >= 5;

  const exhaustion = isBull
    ? (
        (m15.rsi > 88 && m15.slope3 < 0) ||
        (m15Zone === "UPPER_3" && m15.fastSlope3 < -1.25)
      )
    : (
        (m15.rsi < 12 && m15.slope3 > 0) ||
        (m15Zone === "LOWER_3" && m15.fastSlope3 > 1.25)
      );

  const runnerRsiScore = clamp(
    pullbackStrength * 2 + continuationScore + (exhaustion ? -5 : 0),
    0,
    14
  );

  return {
    valid: !blocked,

    // Backward-compatible
    strength: pullbackStrength,
    trend: isBull ? trendLong : trendShort,
    blocked,
    rsi: m15.rsi,
    zones: m15.zones,
    mean1h: h1.mean,

    // Runner context
    profile: "RUNNER",
    blockReason,
    zone: m15Zone,
    m15,
    h1,
    h4,
    h1Distance,
    slope3: m15.slope3,
    fastSlope3: m15.fastSlope3,
    rising: m15.rising,
    falling: m15.falling,
    pullbackOK,
    continuationOK,
    continuationScore,
    runnerRsiScore,
    exhaustion,
    momentumState: m15.momentumState,
    exhaustionState: m15.exhaustionState
  };
}

// ================= TYPE 1 =================
// Compat: oude naam blijft.
// Runner Type 1 = pullback/reclaim entry in richting van momentum.
export function isType1RSIEntry(rsiCtx, side) {
  if (!rsiCtx?.valid) return false;

  const normalizedSide = normalizeSide(side);
  const isBull = normalizedSide === "bull";

  const rsi = Number(rsiCtx.rsi);
  const zones = rsiCtx.zones;
  const zone = rsiCtx.zone || getZone(rsi, zones);

  if (!Number.isFinite(rsi) || !zones) return false;

  if (isBull) {
    return (
      zone === "LOWER_2" ||
      zone === "LOWER_3" ||
      (zone === "LOWER_1" && Number(rsiCtx.slope3 || 0) > -0.25) ||
      (zone === "MID" && Number(rsiCtx.continuationScore || 0) >= 6)
    );
  }

  return (
    zone === "UPPER_2" ||
    zone === "UPPER_3" ||
    (zone === "UPPER_1" && Number(rsiCtx.slope3 || 0) < 0.25) ||
    (zone === "MID" && Number(rsiCtx.continuationScore || 0) >= 6)
  );
}