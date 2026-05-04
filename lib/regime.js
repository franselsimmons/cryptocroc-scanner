// lib/regime.js

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getChange24(c) {
  return safeNumber(
    c?.price_change_percentage_24h ??
      c?.change24 ??
      c?.price_change_percentage_24h_in_currency,
    0
  );
}

function getChange1h(c) {
  return safeNumber(
    c?.price_change_percentage_1h_in_currency ??
      c?.change1h,
    0
  );
}

export function detectRegime(coins) {
  try {
    if (!Array.isArray(coins) || coins.length === 0) {
      return "MID_VOL";
    }

    const sample = coins.slice(0, 250);

    const avg24 =
      sample.reduce((sum, c) => sum + Math.abs(getChange24(c)), 0) / sample.length;

    const avg1h =
      sample.reduce((sum, c) => sum + Math.abs(getChange1h(c)), 0) / sample.length;

    const runnerShare =
      sample.filter(c => Math.abs(getChange1h(c)) > 0.65).length / sample.length;

    const composite =
      (avg24 * 0.65) +
      (avg1h * 5.5) +
      (runnerShare * 10);

    if (composite < 3.2) return "LOW_VOL";
    if (composite < 7.0) return "MID_VOL";
    return "HIGH_VOL";
  } catch {
    return "MID_VOL";
  }
}

export function getRegimeContext(coins) {
  const regime = detectRegime(coins);

  return {
    regime,
    profile: "RUNNER",
    isLowVol: regime === "LOW_VOL",
    isHighVol: regime === "HIGH_VOL",
    isMidVol: regime === "MID_VOL",
    updatedAt: Date.now()
  };
}