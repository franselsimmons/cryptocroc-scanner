// lib/_trade_engine.js

// ======================================================
// BTC alignment check
// ======================================================
function isBtcAligned({ mode, btc, strict = false }) {
  const btcState = up(btc?.state || "NEUTRAL");
  const btcChg24 = n(btc?.chg24, 0);
  const btcRange24 = n(btc?.range24, 0);

  if (strict) {
    if (mode === "bull" && btcState !== "BULL") return false;
    if (mode === "bear" && btcState !== "BEAR") return false;
    return true;
  }

  if (mode === "bull" && btcState === "BEAR" && btcChg24 < -1.5 && btcRange24 > 3.0) return false;
  if (mode === "bear" && btcState === "BULL" && btcChg24 > 1.5 && btcRange24 > 3.0) return false;

  return true;
}

// ======================================================
// Coin profiel opbouwen
// ======================================================
export function buildCoinProfile({ systemType, coin }) {
  const marketCap = n(coin.marketCap, 0);
  const volume = n(coin.volume, 0);
  const spread = n(coin.ob?.spreadPct, 999);
  const depth = n(coin.ob?.depthMinUsd1p, 0);

  let tradabilityBand = "unknown";

  if (marketCap >= 1e9 && volume >= 10e6 && spread < 0.2 && depth > 500_000) {
    tradabilityBand = "premium";
  } else if (marketCap >= 300e6 && volume >= 3e6 && spread < 0.4 && depth > 200_000) {
    tradabilityBand = "high";
  } else if (marketCap >= 100e6 && volume >= 1e6 && spread < 0.8 && depth > 100_000) {
    tradabilityBand = "medium";
  } else {
    tradabilityBand = "low";
  }

  return {
    symbol: coin.symbol,
    marketCap,
    volume,
    spread,
    depth,
    tradabilityBand,
    liquidityScore: n(coin.liquidityScore, 0),
    qualityScore: n(coin.qualityScore, 0),
    systemType: String(systemType || "unknown"),
  };
}

// ======================================================
// Main execution decision
// ======================================================
export function buildMainExecutionDecision({ coin, btc, regime, mode, coinProfile }) {
  const checklist = [];

  const btcOk = isBtcAligned({ mode, btc, strict: true });           // gewijzigd false -> true
  checklist.push({
    name: "BTC alignment",
    ok: btcOk,
    value: btc?.state || "NEUTRAL",
    need: "niet tegen",
  });

  const regimeOk = regime !== "CRASH" && regime !== "PANIC";
  checklist.push({
    name: "Regime",
    ok: regimeOk,
    value: regime,
    need: "geen crash/panic",
  });

  const entryQuality = n(coin.entryQuality, 0);
  const qualityOk = entryQuality >= 68;           // gewijzigd 64 -> 68
  checklist.push({
    name: "Entry quality",
    ok: qualityOk,
    value: entryQuality.toFixed(1),
    need: "≥68",
  });

  const persistence = n(coin.persistenceScore, 0);
  const persistenceOk = persistence >= 60;         // gewijzigd 56 -> 60
  checklist.push({
    name: "Persistence",
    ok: persistenceOk,
    value: persistence.toFixed(1),
    need: "≥60",
  });

  const breakoutReady = !!coin.breakout?.ready;
  const breakoutPressure = n(coin.breakout?.pressure, 0);
  const breakoutSoftOk = breakoutReady || breakoutPressure >= 63;   // gewijzigd 58 -> 63
  checklist.push({
    name: "Breakout",
    ok: breakoutSoftOk,
    value: breakoutReady ? "ready" : `${breakoutPressure.toFixed(1)} pressure`,
    need: "ready of bijna ready",
  });

  const depthOk = !!coin.thresholds?.depthOk;
  checklist.push({
    name: "Depth OK",
    ok: depthOk,
    value: depthOk ? "ja" : "nee",
    need: "ja",
  });

  const spread = n(coin.ob?.spreadPct, 999);
  const spreadOk = spread < 0.90;
  checklist.push({
    name: "Spread",
    ok: spreadOk,
    value: `${spread.toFixed(3)}%`,
    need: "<0.90%",
  });

  const freshOb = coin.ob?.fresh === true;
  checklist.push({
    name: "Fresh OB",
    ok: freshOb,
    value: freshOb ? "ja" : "nee",
    need: "ja",
  });

  const tradeCandidate = !!coin.tradeCandidate;
  checklist.push({
    name: "Trade candidate",
    ok: tradeCandidate,
    value: tradeCandidate ? "ja" : "nee",
    need: "ja",
  });

  const stage = up(coin.stage || "");
  const stageOk =
    stage === "ELITE_IGNITION" ||
    stage === "ELITE_EXPANSION" ||
    stage === "ELITE_CASCADE";
  checklist.push({
    name: "Elite stage",
    ok: stageOk,
    value: stage || "UNKNOWN",
    need: "ELITE",
  });

  const passed = checklist.filter((c) => c.ok).length;
  const total = checklist.length;
  const score = Math.round((passed / total) * 100);

  let action = "IGNORE";
  let reason = "";

  if (
    tradeCandidate &&
    stageOk &&
    btcOk &&
    regimeOk &&
    qualityOk &&
    persistenceOk &&
    depthOk &&
    spreadOk &&
    freshOb &&
    score >= 64
  ) {
    action = "OPEN";
    reason = breakoutReady
      ? "Elite setup klaar voor entry"
      : "Elite setup vroeg geopend vóór volledige breakout";
  } else if (
    tradeCandidate &&
    stageOk &&
    qualityOk &&
    persistenceOk &&
    depthOk &&
    freshOb &&
    score >= 52
  ) {
    action = "WATCH";
    reason = "Sterke setup, nog net niet volledig klaar";
  } else {
    reason = "Onvoldoende kwaliteit";
  }

  return {
    action,
    ready: action === "OPEN",
    score,
    checklist,
    reason,
    side: mode === "bull" ? "LONG" : "SHORT",
    positionSizeUsd: 50,
    meta: {
      breakoutReady,
      breakoutPressure,
      coinProfile,
    },
  };
}

// ======================================================
// Moon execution decision
// ======================================================
export function buildMoonExecutionDecision({ coin, btc, regime, mode, coinProfile }) {
  const checklist = [];

  const btcOk = isBtcAligned({ mode, btc, strict: true });           // gewijzigd false -> true
  checklist.push({
    name: "BTC alignment",
    ok: btcOk,
    value: btc?.state || "NEUTRAL",
    need: "niet tegen",
  });

  const regimeOk = regime !== "CRASH" && regime !== "PANIC";
  checklist.push({
    name: "Regime",
    ok: regimeOk,
    value: regime,
    need: "geen crash/panic",
  });

  const entryQuality = n(coin.entryQuality, 0);
  const qualityOk = entryQuality >= 64;           // gewijzigd 60 -> 64
  checklist.push({
    name: "Entry quality",
    ok: qualityOk,
    value: entryQuality.toFixed(1),
    need: "≥64",
  });

  const persistence = n(coin.persistenceScore, 0);
  const persistenceOk = persistence >= 56;         // gewijzigd 50 -> 56
  checklist.push({
    name: "Persistence",
    ok: persistenceOk,
    value: persistence.toFixed(1),
    need: "≥56",
  });

  const breakoutReady = !!coin.breakout?.ready;
  const breakoutPressure = n(coin.breakout?.pressure, 0);
  const breakoutSoftOk = breakoutReady || breakoutPressure >= 61;   // gewijzigd 56 -> 61
  checklist.push({
    name: "Breakout",
    ok: breakoutSoftOk,
    value: breakoutReady ? "ready" : `${breakoutPressure.toFixed(1)} pressure`,
    need: "ready of bijna ready",
  });

  const depthOk = !!coin.thresholds?.depthOk;
  checklist.push({
    name: "Depth OK",
    ok: depthOk,
    value: depthOk ? "ja" : "nee",
    need: "ja",
  });

  const spread = n(coin.ob?.spreadPct, 999);
  const spreadOk = spread < 0.80;
  checklist.push({
    name: "Spread",
    ok: spreadOk,
    value: `${spread.toFixed(3)}%`,
    need: "<0.80%",
  });

  const freshOb = coin.ob?.fresh === true;
  checklist.push({
    name: "Fresh OB",
    ok: freshOb,
    value: freshOb ? "ja" : "nee",
    need: "ja",
  });

  const tradeCandidate = !!coin.tradeCandidate;
  checklist.push({
    name: "Trade candidate",
    ok: tradeCandidate,
    value: tradeCandidate ? "ja" : "nee",
    need: "ja",
  });

  const stage = up(coin.stage || "");
  const stageOk =
    stage === "ELITE_IGNITION" ||
    stage === "ELITE_EXPANSION" ||
    stage === "ELITE_CASCADE";
  checklist.push({
    name: "Elite stage",
    ok: stageOk,
    value: stage || "UNKNOWN",
    need: "ELITE",
  });

  const passed = checklist.filter((c) => c.ok).length;
  const total = checklist.length;
  const score = Math.round((passed / total) * 100);

  let action = "IGNORE";
  let reason = "";

  if (
    tradeCandidate &&
    stageOk &&
    btcOk &&
    regimeOk &&
    qualityOk &&
    persistenceOk &&
    depthOk &&
    spreadOk &&
    freshOb &&
    score >= 60
  ) {
    action = "OPEN";
    reason = breakoutReady
      ? "Moon elite setup klaar voor entry"
      : "Moon elite setup vroeg geopend vóór volledige breakout";
  } else if (
    tradeCandidate &&
    stageOk &&
    qualityOk &&
    persistenceOk &&
    depthOk &&
    freshOb &&
    score >= 48
  ) {
    action = "WATCH";
    reason = "Moon setup sterk, nog net niet volledig klaar";
  } else {
    reason = "Onvoldoende kwaliteit";
  }

  return {
    action,
    ready: action === "OPEN",
    score,
    checklist,
    reason,
    side: mode === "bull" ? "LONG" : "SHORT",
    positionSizeUsd: 50,
    meta: {
      breakoutReady,
      breakoutPressure,
      coinProfile,
    },
  };
}

// ======================================================
// Hulpfuncties (n, up)
// ======================================================
function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function up(x) {
  return String(x || "").toUpperCase();
}