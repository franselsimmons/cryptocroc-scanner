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

function isBtcHardAgainst({ mode, btc }) {
  const btcState = up(btc?.state || "NEUTRAL");
  const btcChg24 = n(btc?.chg24, 0);
  const btcRange24 = n(btc?.range24, 0);

  if (mode === "bull") {
    return btcState === "BEAR" && btcChg24 <= -2.0 && btcRange24 >= 3.5;
  }

  if (mode === "bear") {
    return btcState === "BULL" && btcChg24 >= 2.0 && btcRange24 >= 3.5;
  }

  return false;
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
// Shared helper
// ======================================================
function buildBaseChecklist({ coin, btc, regime }) {
  const checklist = [];

  const entryQuality = n(coin.entryQuality, 0);
  const persistence = n(coin.persistenceScore, 0);
  const breakoutReady = !!coin.breakout?.ready;
  const breakoutPressure = n(coin.breakout?.pressure, 0);
  const depthOk = !!coin.thresholds?.depthOk;
  const spread = n(coin.ob?.spreadPct, 999);
  const freshOb = coin.ob?.fresh === true;
  const tradeCandidate = !!coin.tradeCandidate;
  const stage = up(coin.stage || "");

  const stageOk =
    stage === "ELITE_IGNITION" ||
    stage === "ELITE_EXPANSION" ||
    stage === "ELITE_CASCADE";

  const regimeOk = regime !== "CRASH" && regime !== "PANIC";

  checklist.push({ name: "Regime", ok: regimeOk, value: regime, need: "geen crash/panic" });
  checklist.push({ name: "Entry quality", ok: true, value: entryQuality.toFixed(1), need: "context" });
  checklist.push({ name: "Persistence", ok: true, value: persistence.toFixed(1), need: "context" });
  checklist.push({
    name: "Breakout",
    ok: breakoutReady || breakoutPressure >= 0,
    value: breakoutReady ? "ready" : `${breakoutPressure.toFixed(1)} pressure`,
    need: "context",
  });
  checklist.push({ name: "Depth OK", ok: depthOk, value: depthOk ? "ja" : "nee", need: "ja" });
  checklist.push({ name: "Spread", ok: true, value: `${spread.toFixed(3)}%`, need: "context" });
  checklist.push({ name: "Fresh OB", ok: freshOb, value: freshOb ? "ja" : "nee", need: "liefst ja" });
  checklist.push({ name: "Trade candidate", ok: tradeCandidate, value: tradeCandidate ? "ja" : "nee", need: "ja" });
  checklist.push({ name: "Elite stage", ok: stageOk, value: stage || "UNKNOWN", need: "ELITE" });

  return {
    checklist,
    entryQuality,
    persistence,
    breakoutReady,
    breakoutPressure,
    depthOk,
    spread,
    freshOb,
    tradeCandidate,
    stage,
    stageOk,
    regimeOk,
  };
}

function finalizeDecision({
  action,
  reason,
  mode,
  score,
  checklist,
  breakoutReady,
  breakoutPressure,
  coinProfile,
  graceActive = false,
  cyclesInTrade = 0,
}) {
  return {
    action,
    ready: action === "OPEN" || action === "HOLD",
    score,
    checklist,
    reason,
    side: mode === "bull" ? "LONG" : "SHORT",
    positionSizeUsd: 50,
    meta: {
      breakoutReady,
      breakoutPressure,
      coinProfile,
      graceActive,
      cyclesInTrade,
    },
  };
}

// ======================================================
// Main execution decision
// ======================================================
export function buildMainExecutionDecision({
  coin,
  btc,
  regime,
  mode,
  coinProfile,
  positionState = {},
}) {
  const inPosition = !!positionState.inPosition;
  const cyclesInTrade = n(positionState.cyclesInTrade, 0);
  const minHoldCycles = n(positionState.minHoldCycles, 4);

  const btcOk = isBtcAligned({ mode, btc, strict: false });
  const btcHardAgainst = isBtcHardAgainst({ mode, btc });

  const {
    checklist,
    entryQuality,
    persistence,
    breakoutReady,
    breakoutPressure,
    depthOk,
    spread,
    freshOb,
    tradeCandidate,
    stageOk,
    regimeOk,
  } = buildBaseChecklist({ coin, btc, regime });

  const qualityOpenOk = entryQuality >= 64;
  const persistenceOpenOk = persistence >= 56;
  const breakoutOpenOk = breakoutReady || breakoutPressure >= 58;
  const spreadOpenOk = spread < 0.90;

  const qualityHoldOk = entryQuality >= 52;
  const persistenceHoldOk = persistence >= 44;
  const spreadHoldOk = spread < 1.20;
  const scoreComponents = [
    btcOk,
    regimeOk,
    qualityOpenOk,
    persistenceOpenOk,
    breakoutOpenOk,
    depthOk,
    spreadOpenOk,
    freshOb,
    tradeCandidate,
    stageOk,
  ];

  const passed = scoreComponents.filter(Boolean).length;
  const total = scoreComponents.length;
  const score = Math.round((passed / total) * 100);

  const emergencyExit =
    !regimeOk ||
    btcHardAgainst ||
    !depthOk ||
    spread >= 1.80 ||
    !tradeCandidate ||
    !stageOk;

  const graceActive = inPosition && cyclesInTrade < minHoldCycles;

  if (!inPosition) {
    if (
      tradeCandidate &&
      stageOk &&
      btcOk &&
      regimeOk &&
      qualityOpenOk &&
      persistenceOpenOk &&
      breakoutOpenOk &&
      depthOk &&
      spreadOpenOk &&
      freshOb &&
      score >= 64
    ) {
      return finalizeDecision({
        action: "OPEN",
        reason: breakoutReady
          ? "Elite setup klaar voor entry"
          : "Elite setup vroeg geopend vóór volledige breakout",
        mode,
        score,
        checklist,
        breakoutReady,
        breakoutPressure,
        coinProfile,
        graceActive: true,
        cyclesInTrade: 0,
      });
    }

    if (
      tradeCandidate &&
      stageOk &&
      qualityOpenOk &&
      persistenceOpenOk &&
      depthOk &&
      freshOb &&
      score >= 52
    ) {
      return finalizeDecision({
        action: "WATCH",
        reason: "Sterke setup, nog net niet volledig klaar",
        mode,
        score,
        checklist,
        breakoutReady,
        breakoutPressure,
        coinProfile,
      });
    }

    return finalizeDecision({
      action: "IGNORE",
      reason: "Onvoldoende kwaliteit",
      mode,
      score,
      checklist,
      breakoutReady,
      breakoutPressure,
      coinProfile,
    });
  }

  // IN POSITION: eerst emergency check
  if (emergencyExit) {
    return finalizeDecision({
      action: "CLOSE",
      reason: "Exit door hard risk event",
      mode,
      score,
      checklist,
      breakoutReady,
      breakoutPressure,
      coinProfile,
      graceActive,
      cyclesInTrade,
    });
  }

  // Grace period: niet flippen in eerste cycles
  if (graceActive) {
    return finalizeDecision({
      action: "HOLD",
      reason: `Trade krijgt ademruimte (${cyclesInTrade}/${minHoldCycles} cycles)`,
      mode,
      score,
      checklist,
      breakoutReady,
      breakoutPressure,
      coinProfile,
      graceActive,
      cyclesInTrade,
    });
  }

  const holdOk =
    tradeCandidate &&
    stageOk &&
    regimeOk &&
    qualityHoldOk &&
    persistenceHoldOk &&
    depthOk &&
    spreadHoldOk &&
    score >= 45;

  if (holdOk) {
    return finalizeDecision({
      action: "HOLD",
      reason: "Trade blijft open: normale pullback/ruis toegestaan",
      mode,
      score,
      checklist,
      breakoutReady,
      breakoutPressure,
      coinProfile,
      graceActive,
      cyclesInTrade,
    });
  }

  return finalizeDecision({
    action: "CLOSE",
    reason: "Setup verzwakt onder hold-drempel",
    mode,
    score,
    checklist,
    breakoutReady,
    breakoutPressure,
    coinProfile,
    graceActive,
    cyclesInTrade,
  });
}

// ======================================================
// Moon execution decision
// ======================================================
export function buildMoonExecutionDecision({
  coin,
  btc,
  regime,
  mode,
  coinProfile,
  positionState = {},
}) {
  const inPosition = !!positionState.inPosition;
  const cyclesInTrade = n(positionState.cyclesInTrade, 0);
  const minHoldCycles = n(positionState.minHoldCycles, 4);

  const btcOk = isBtcAligned({ mode, btc, strict: false });
  const btcHardAgainst = isBtcHardAgainst({ mode, btc });

  const {
    checklist,
    entryQuality,
    persistence,
    breakoutReady,
    breakoutPressure,
    depthOk,
    spread,
    freshOb,
    tradeCandidate,
    stageOk,
    regimeOk,
  } = buildBaseChecklist({ coin, btc, regime });

  const qualityOpenOk = entryQuality >= 60;
  const persistenceOpenOk = persistence >= 50;
  const breakoutOpenOk = breakoutReady || breakoutPressure >= 56;
  const spreadOpenOk = spread < 0.80;

  const qualityHoldOk = entryQuality >= 48;
  const persistenceHoldOk = persistence >= 40;
  const spreadHoldOk = spread < 1.10;

  const scoreComponents = [
    btcOk,
    regimeOk,
    qualityOpenOk,
    persistenceOpenOk,
    breakoutOpenOk,
    depthOk,
    spreadOpenOk,
    freshOb,
    tradeCandidate,
    stageOk,
  ];

  const passed = scoreComponents.filter(Boolean).length;
  const total = scoreComponents.length;
  const score = Math.round((passed / total) * 100);

  const emergencyExit =
    !regimeOk ||
    btcHardAgainst ||
    !depthOk ||
    spread >= 1.60 ||
    !tradeCandidate ||
    !stageOk;

  const graceActive = inPosition && cyclesInTrade < minHoldCycles;

  if (!inPosition) {
    if (
      tradeCandidate &&
      stageOk &&
      btcOk &&
      regimeOk &&
      qualityOpenOk &&
      persistenceOpenOk &&
      breakoutOpenOk &&
      depthOk &&
      spreadOpenOk &&
      freshOb &&
      score >= 60
    ) {
      return finalizeDecision({
        action: "OPEN",
        reason: breakoutReady
          ? "Moon elite setup klaar voor entry"
          : "Moon elite setup vroeg geopend vóór volledige breakout",
        mode,
        score,
        checklist,
        breakoutReady,
        breakoutPressure,
        coinProfile,
        graceActive: true,
        cyclesInTrade: 0,
      });
    }

    if (
      tradeCandidate &&
      stageOk &&
      qualityOpenOk &&
      persistenceOpenOk &&
      depthOk &&
      freshOb &&
      score >= 48
    ) {
      return finalizeDecision({
        action: "WATCH",
        reason: "Moon setup sterk, nog net niet volledig klaar",
        mode,
        score,
        checklist,
        breakoutReady,
        breakoutPressure,
        coinProfile,
      });
    }

    return finalizeDecision({
      action: "IGNORE",
      reason: "Onvoldoende kwaliteit",
      mode,
      score,
      checklist,
      breakoutReady,
      breakoutPressure,
      coinProfile,
    });
  }

  if (emergencyExit) {
    return finalizeDecision({
      action: "CLOSE",
      reason: "Exit door hard risk event",
      mode,
      score,
      checklist,
      breakoutReady,
      breakoutPressure,
      coinProfile,
      graceActive,
      cyclesInTrade,
    });
  }

  if (graceActive) {
    return finalizeDecision({
      action: "HOLD",
      reason: `Trade krijgt ademruimte (${cyclesInTrade}/${minHoldCycles} cycles)`,
      mode,
      score,
      checklist,
      breakoutReady,
      breakoutPressure,
      coinProfile,
      graceActive,
      cyclesInTrade,
    });
  }

  const holdOk =
    tradeCandidate &&
    stageOk &&
    regimeOk &&
    qualityHoldOk &&
    persistenceHoldOk &&
    depthOk &&
    spreadHoldOk &&
    score >= 42;

  if (holdOk) {
    return finalizeDecision({
      action: "HOLD",
      reason: "Moon trade blijft open: normale ruis toegestaan",
      mode,
      score,
      checklist,
      breakoutReady,
      breakoutPressure,
      coinProfile,
      graceActive,
      cyclesInTrade,
    });
  }

  return finalizeDecision({
    action: "CLOSE",
    reason: "Moon setup verzwakt onder hold-drempel",
    mode,
    score,
    checklist,
    breakoutReady,
    breakoutPressure,
    coinProfile,
    graceActive,
    cyclesInTrade,
  });
}

// ======================================================
// Hulpfuncties
// ======================================================
function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function up(x) {
  return String(x || "").toUpperCase();
}