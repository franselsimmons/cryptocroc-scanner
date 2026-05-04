// lib/structureEngine.js

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeCandles(candles) {
  return Array.isArray(candles)
    ? candles
        .map(c => ({
          open: safeNumber(c?.open, 0),
          high: safeNumber(c?.high, 0),
          low: safeNumber(c?.low, 0),
          close: safeNumber(c?.close, 0),
          openTime: safeNumber(c?.openTime || c?.time || c?.ts, 0)
        }))
        .filter(c => c.high > 0 && c.low > 0 && c.close > 0)
    : [];
}

function getRange(candles) {
  const list = safeCandles(candles);
  if (!list.length) return null;

  const highs = list.map(c => c.high);
  const lows = list.map(c => c.low);

  return {
    high: Math.max(...highs),
    low: Math.min(...lows),
    close: list[list.length - 1].close
  };
}

function pctDistance(a, b) {
  const x = safeNumber(a, 0);
  const y = safeNumber(b, 0);

  if (!x || !y) return 0;

  return Math.abs(x - y) / y;
}

// ================= MARKET STRUCTURE =================
export function getStructureState(candles) {
  const list = safeCandles(candles);

  if (list.length < 20) {
    return {
      profile: "RUNNER",
      trend: "UNKNOWN",
      breakout: false,
      breakdown: false,
      compression: false,
      rangeHigh: null,
      rangeLow: null
    };
  }

  const recent = list.slice(-10);
  const prev = list.slice(-20, -10);

  const recentRange = getRange(recent);
  const prevRange = getRange(prev);
  const fullRange = getRange(list.slice(-30));

  const HH = recentRange.high > prevRange.high;
  const HL = recentRange.low > prevRange.low;

  const LH = recentRange.high < prevRange.high;
  const LL = recentRange.low < prevRange.low;

  const lastClose = recentRange.close;

  let trend = "RANGE";

  if (HH && HL) trend = "BULLISH";
  if (LH && LL) trend = "BEARISH";

  const breakout = Boolean(fullRange?.high && lastClose > fullRange.high * 0.998);
  const breakdown = Boolean(fullRange?.low && lastClose < fullRange.low * 1.002);

  const recentWidth = pctDistance(recentRange.high, recentRange.low);
  const prevWidth = pctDistance(prevRange.high, prevRange.low);
  const compression = recentWidth < prevWidth * 0.72;

  let runnerStructure = "NEUTRAL";

  if (trend === "BULLISH" && breakout) runnerStructure = "BULL_BREAKOUT";
  else if (trend === "BEARISH" && breakdown) runnerStructure = "BEAR_BREAKDOWN";
  else if (trend === "BULLISH") runnerStructure = "BULL_CONTINUATION";
  else if (trend === "BEARISH") runnerStructure = "BEAR_CONTINUATION";
  else if (compression) runnerStructure = "SQUEEZE_BUILDUP";

  return {
    profile: "RUNNER",
    trend,
    runnerStructure,

    HH,
    HL,
    LH,
    LL,

    breakout,
    breakdown,
    compression,

    rangeHigh: fullRange?.high || recentRange.high,
    rangeLow: fullRange?.low || recentRange.low,
    recentHigh: recentRange.high,
    recentLow: recentRange.low,
    previousHigh: prevRange.high,
    previousLow: prevRange.low,
    lastClose,

    recentWidth,
    prevWidth
  };
}

export function isStructureAligned(structure, side) {
  const s = String(side || "").toLowerCase() === "bear" ? "bear" : "bull";
  const trend = String(structure?.trend || "").toUpperCase();
  const runnerStructure = String(structure?.runnerStructure || "").toUpperCase();

  if (s === "bull") {
    return (
      trend === "BULLISH" ||
      runnerStructure === "BULL_BREAKOUT" ||
      runnerStructure === "BULL_CONTINUATION" ||
      runnerStructure === "SQUEEZE_BUILDUP"
    );
  }

  return (
    trend === "BEARISH" ||
    runnerStructure === "BEAR_BREAKDOWN" ||
    runnerStructure === "BEAR_CONTINUATION" ||
    runnerStructure === "SQUEEZE_BUILDUP"
  );
}