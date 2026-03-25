// lib/_trade_engine.js

// ======================================================
// Filosofie
// ======================================================
// Scanner doet de zware filtering.
// Trade engine gaat er dus vanuit dat coins die hier komen
// al serieus sterk zijn.
//
// Daarom:
// - makkelijker OPEN dan eerst
// - veel makkelijker HOLD dan OPEN
// - grace period direct na entry
// - WEAK_HOLD voor tijdelijke shakeout
// - CLOSE alleen bij echte damage / risk
//
// Verwachte input voor bestaande posities:
// positionState = {
//   inPosition: true,
//   cyclesInTrade: 3,
//   minHoldCycles: 5,
//   weakHoldCount: 1,
//   maxWeakHoldCycles: 2,
// }
//
// De manager buiten deze file moet cyclesInTrade / weakHoldCount bijhouden.
// ======================================================

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
// Shared helpers
// ======================================================
function isEliteStage(stage) {
  const s = up(stage || "");
  return s === "ELITE_IGNITION" || s === "ELITE_EXPANSION" || s === "ELITE_CASCADE";
}

function buildBaseChecklist({ coin, btc, regime, mode }) {
  const checklist = [];

  const btcOk = isBtcAligned({ mode, btc, strict: false });
  const btcHardAgainst = isBtcHardAgainst({ mode, btc });

  const entryQuality = n(coin.entryQuality, 0);
  const persistence = n(coin.persistenceScore, 0);
  const breakoutReady = !!coin.breakout?.ready;
  const breakoutPressure = n(coin.breakout?.pressure, 0);
  const depthOk = !!coin.thresholds?.depthOk;
  const spread = n(coin.ob?.spreadPct, 999);
  const freshOb = coin.ob?.fresh === true;
  const tradeCandidate = !!coin.tradeCandidate;
  const stage = up(coin.stage || "");
  const stageOk = isEliteStage(stage);
  const regimeOk = regime !== "CRASH" && regime !== "PANIC";

  checklist.push({
    name: "BTC alignment",
    ok: btcOk,
    value: btc?.state || "NEUTRAL",
    need: "niet hard tegen",
  });

  checklist.push({
    name: "Regime",
    ok: regimeOk,
    value: regime,
    need: "geen crash/panic",
  });

  checklist.push({
    name: "Entry quality",
    ok: true,
    value: entryQuality.toFixed(1),
    need: "context",
  });

  checklist.push({
    name: "Persistence",
    ok: true,
    value: persistence.toFixed(1),
    need: "context",
  });

  checklist.push({
    name: "Breakout",
    ok: breakoutReady || breakoutPressure >= 0,
    value: breakoutReady ? "ready" : `${breakoutPressure.toFixed(1)} pressure`,
    need: "context",
  });

  checklist.push({
    name: "Depth OK",
    ok: depthOk,
    value: depthOk ? "ja" : "nee",
    need: "ja",
  });

  checklist.push({
    name: "Spread",
    ok: true,
    value: `${spread.toFixed(3)}%`,
    need: "context",
  });

  checklist.push({
    name: "Fresh OB",
    ok: freshOb,
    value: freshOb ? "ja" : "nee",
    need: "liefst ja bij entry",
  });

  checklist.push({
    name: "Trade candidate",
    ok: tradeCandidate,
    value: tradeCandidate ? "ja" : "nee",
    need: "ja",
  });

  checklist.push({
    name: "Elite stage",
    ok: stageOk,
    value: stage || "UNKNOWN",
    need: "ELITE",
  });

  return {
    checklist,
    btcOk,
    btcHardAgainst,
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

function calcScore(parts) {
  const passed = parts.filter(Boolean).length;
  return Math.round((passed / parts.length) * 100);
}

function finalizeDecision({
  action,
  reason,
  reasonCode,
  mode,
  score,
  checklist,
  breakoutReady,
  breakoutPressure,
  coinProfile,
  graceActive = false,
  cyclesInTrade = 0,
  weakHoldCount = 0,
  holdState = "NONE",
}) {
  return {
    action,
    ready: action === "OPEN" || action === "HOLD" || action === "WEAK_HOLD",
    score,
    checklist,
    reason,
    reasonCode,
    side: mode === "bull" ? "LONG" : "SHORT",
    positionSizeUsd: 50,
    meta: {
      breakoutReady,
      breakoutPressure,
      coinProfile,
      graceActive,
      cyclesInTrade,
      weakHoldCount,
      holdState,
    },
  };
}

function getEmergencyExitReason({
  regimeOk,
  btcHardAgainst,
  depthOk,
  spread,
  tradeCandidate,
  stageOk,
  emergencySpread,
}) {
  if (!regimeOk) return "regime_panic";
  if (btcHardAgainst) return "btc_hard_against";
  if (!depthOk) return "depth_failed";
  if (spread >= emergencySpread) return "spread_explosion";
  if (!tradeCandidate) return "trade_candidate_lost";
  if (!stageOk) return "stage_lost";
  return null;
}

function getWeaknessReason({
  entryQuality,
  persistence,
  breakoutPressure,
  qualityCloseFloor,
  persistenceCloseFloor,
  breakoutCloseFloor,
}) {
  if (entryQuality < qualityCloseFloor) return "quality_collapse";
  if (persistence < persistenceCloseFloor) return "persistence_collapse";
  if (breakoutPressure < breakoutCloseFloor) return "timeout_no_followthrough";
  return "thesis_damage_confirmed";
}

function buildExecutionDecision({
  coin,
  btc,
  regime,
  mode,
  coinProfile,
  positionState = {},
  scannerGate = "OPEN",
  config,
}) {
  const inPosition = !!positionState.inPosition;
  const cyclesInTrade = n(positionState.cyclesInTrade, 0);
  const minHoldCycles = n(positionState.minHoldCycles, config.minHoldCycles);
  const weakHoldCount = n(positionState.weakHoldCount, 0);
  const maxWeakHoldCycles = n(positionState.maxWeakHoldCycles, config.maxWeakHoldCycles);

  const {
    checklist,
    btcOk,
    btcHardAgainst,
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
  } = buildBaseChecklist({ coin, btc, regime, mode });

  const qualityOpenOk = entryQuality >= config.openQualityMin;
  const persistenceOpenOk = persistence >= config.openPersistenceMin;
  const breakoutOpenOk = breakoutReady || breakoutPressure >= config.openBreakoutPressureMin;
  const spreadOpenOk = spread < config.openSpreadMax;
  const freshEntrySoftOk = freshOb || breakoutReady || breakoutPressure >= config.openBreakoutPressureMin + 4;

  const qualityHoldOk = entryQuality >= config.holdQualityMin;
  const persistenceHoldOk = persistence >= config.holdPersistenceMin;
  const spreadHoldOk = spread < config.holdSpreadMax;

  const qualityWeakOk = entryQuality >= config.weakHoldQualityMin;
  const persistenceWeakOk = persistence >= config.weakHoldPersistenceMin;
  const spreadWeakOk = spread < config.weakHoldSpreadMax;

  // Score wordt nu voor alle takken berekend
  const score = calcScore([
    btcOk,
    regimeOk,
    qualityOpenOk,
    persistenceOpenOk,
    breakoutOpenOk,
    depthOk,
    spreadOpenOk,
    tradeCandidate,
    stageOk,
    freshEntrySoftOk,
  ]);

  const emergencyReason = getEmergencyExitReason({
    regimeOk,
    btcHardAgainst,
    depthOk,
    spread,
    tradeCandidate,
    stageOk,
    emergencySpread: config.emergencySpread,
  });

  const graceActive = inPosition && cyclesInTrade < minHoldCycles;

  // ======================================================
  // NIEUWE SCANNER GATE LOGICA
  // ======================================================
  if (!inPosition) {
    // ======================================================
    // SCANNER GATE (NIEUW)
    // ======================================================

    if (scannerGate === "IGNORE") {
      return finalizeDecision({
        action: "IGNORE",
        reason: "Scanner heeft coin niet doorgelaten",
        reasonCode: "scanner_block",
        mode,
        score,
        checklist,
        breakoutReady,
        breakoutPressure,
        coinProfile,
      });
    }

    if (scannerGate === "WATCH") {
      return finalizeDecision({
        action: "WATCH",
        reason: "Scanner zegt: bijna klaar, nog niet openen",
        reasonCode: "scanner_watch",
        mode,
        score,
        checklist,
        breakoutReady,
        breakoutPressure,
        coinProfile,
      });
    }

    // ======================================================
    // NORMALE ENTRY LOGIC (ALLEEN ALS scannerGate === OPEN)
    // ======================================================

    const openOk =
      tradeCandidate &&
      stageOk &&
      btcOk &&
      regimeOk &&
      qualityOpenOk &&
      persistenceOpenOk &&
      breakoutOpenOk &&
      depthOk &&
      spreadOpenOk &&
      score >= config.openScoreMin;

    if (openOk) {
      return finalizeDecision({
        action: "OPEN",
        reason: breakoutReady
          ? "Scanner-setup bevestigd, trade direct geopend"
          : "Scanner-setup sterk genoeg om vroeg te traden",
        reasonCode: breakoutReady ? "entry_confirmed" : "entry_early_strength",
        mode,
        score,
        checklist,
        breakoutReady,
        breakoutPressure,
        coinProfile,
        graceActive: true,
        cyclesInTrade: 0,
        weakHoldCount: 0,
        holdState: "GRACE_HOLD",
      });
    }

    return finalizeDecision({
      action: "WATCH",
      reason: "Scanner gaf groen licht, maar timing nog niet perfect",
      reasonCode: "watch_after_gate",
      mode,
      score,
      checklist,
      breakoutReady,
      breakoutPressure,
      coinProfile,
    });
  }

  // ======================================================
  // BESTAANDE POSITIE LOGIC (ONGEWIJZIGD)
  // ======================================================
  if (emergencyReason) {
    return finalizeDecision({
      action: "CLOSE",
      reason: humanizeReason(emergencyReason),
      reasonCode: emergencyReason,
      mode,
      score,
      checklist,
      breakoutReady,
      breakoutPressure,
      coinProfile,
      graceActive,
      cyclesInTrade,
      weakHoldCount,
      holdState: "EMERGENCY_EXIT",
    });
  }

  if (graceActive) {
    return finalizeDecision({
      action: "HOLD",
      reason: `Trade krijgt ademruimte (${cyclesInTrade}/${minHoldCycles} cycles)`,
      reasonCode: "grace_hold",
      mode,
      score,
      checklist,
      breakoutReady,
      breakoutPressure,
      coinProfile,
      graceActive,
      cyclesInTrade,
      weakHoldCount: 0,
      holdState: "GRACE_HOLD",
    });
  }

  const holdOk =
    tradeCandidate &&
    stageOk &&
    regimeOk &&
    depthOk &&
    qualityHoldOk &&
    persistenceHoldOk &&
    spreadHoldOk &&
    score >= config.holdScoreMin;

  if (holdOk) {
    return finalizeDecision({
      action: "HOLD",
      reason: "Positie blijft open; normale shakeout en pullback toegestaan",
      reasonCode: "hold_valid",
      mode,
      score,
      checklist,
      breakoutReady,
      breakoutPressure,
      coinProfile,
      graceActive,
      cyclesInTrade,
      weakHoldCount: 0,
      holdState: "HOLD",
    });
  }

  const weakHoldOk =
    tradeCandidate &&
    stageOk &&
    regimeOk &&
    depthOk &&
    qualityWeakOk &&
    persistenceWeakOk &&
    spreadWeakOk &&
    score >= config.weakHoldScoreMin;

  if (weakHoldOk && weakHoldCount < maxWeakHoldCycles) {
    return finalizeDecision({
      action: "WEAK_HOLD",
      reason: "Tijdelijke zwakte gedetecteerd, maar nog geen bevestigde thesis break",
      reasonCode: "weak_hold",
      mode,
      score,
      checklist,
      breakoutReady,
      breakoutPressure,
      coinProfile,
      graceActive,
      cyclesInTrade,
      weakHoldCount: weakHoldCount + 1,
      holdState: "WEAK_HOLD",
    });
  }

  const closeReason = getWeaknessReason({
    entryQuality,
    persistence,
    breakoutPressure,
    qualityCloseFloor: config.closeQualityFloor,
    persistenceCloseFloor: config.closePersistenceFloor,
    breakoutCloseFloor: config.closeBreakoutFloor,
  });

  return finalizeDecision({
    action: "CLOSE",
    reason: humanizeReason(closeReason),
    reasonCode: closeReason,
    mode,
    score,
    checklist,
    breakoutReady,
    breakoutPressure,
    coinProfile,
    graceActive,
    cyclesInTrade,
    weakHoldCount,
    holdState: "CLOSE",
  });
}

export function buildMainExecutionDecision({
  coin,
  btc,
  regime,
  mode,
  coinProfile,
  positionState = {},
  scannerGate = "OPEN",
}) {
  return buildExecutionDecision({
    coin,
    btc,
    regime,
    mode,
    coinProfile,
    positionState,
    scannerGate,
    config: {
      minHoldCycles: 5,
      maxWeakHoldCycles: 2,

      openQualityMin: 58,
      openPersistenceMin: 50,
      openBreakoutPressureMin: 52,
      openSpreadMax: 1.05,
      openScoreMin: 58,

      watchSpreadMax: 1.20,
      watchScoreMin: 50,

      holdQualityMin: 46,
      holdPersistenceMin: 38,
      holdSpreadMax: 1.35,
      holdScoreMin: 42,

      weakHoldQualityMin: 40,
      weakHoldPersistenceMin: 32,
      weakHoldSpreadMax: 1.55,
      weakHoldScoreMin: 36,

      closeQualityFloor: 36,
      closePersistenceFloor: 28,
      closeBreakoutFloor: 26,

      emergencySpread: 1.90,
    },
  });
}

export function buildMoonExecutionDecision({
  coin,
  btc,
  regime,
  mode,
  coinProfile,
  positionState = {},
}) {
  return buildExecutionDecision({
    coin,
    btc,
    regime,
    mode,
    coinProfile,
    positionState,
    scannerGate: "OPEN", // Moon gebruikt geen scannerGate, standaard open
    config: {
      minHoldCycles: 5,
      maxWeakHoldCycles: 2,

      openQualityMin: 54,
      openPersistenceMin: 46,
      openBreakoutPressureMin: 50,
      openSpreadMax: 0.95,
      openScoreMin: 56,

      watchSpreadMax: 1.10,
      watchScoreMin: 48,

      holdQualityMin: 42,
      holdPersistenceMin: 34,
      holdSpreadMax: 1.25,
      holdScoreMin: 40,

      weakHoldQualityMin: 36,
      weakHoldPersistenceMin: 28,
      weakHoldSpreadMax: 1.45,
      weakHoldScoreMin: 34,

      closeQualityFloor: 32,
      closePersistenceFloor: 24,
      closeBreakoutFloor: 24,

      emergencySpread: 1.70,
    },
  });
}

function humanizeReason(reasonCode) {
  switch (String(reasonCode || "").toLowerCase()) {
    case "entry_confirmed":
      return "Scanner-setup bevestigd en positie geopend";
    case "entry_early_strength":
      return "Vroege entry op sterke scanner-setup";
    case "watch_timing":
      return "Sterke setup, maar timing nog niet optimaal";
    case "ignore_not_ready":
      return "Nog niet klaar voor trade-uitvoering";
    case "scanner_block":
      return "Scanner heeft coin niet doorgelaten";
    case "scanner_watch":
      return "Scanner zegt: bijna klaar, nog niet openen";
    case "watch_after_gate":
      return "Scanner gaf groen licht, maar timing nog niet perfect";

    case "grace_hold":
      return "Grace hold actief";
    case "hold_valid":
      return "Positie blijft valide";
    case "weak_hold":
      return "Tijdelijke zwakte zonder bevestigde break";

    case "regime_panic":
      return "Marktregime werd te riskant";
    case "btc_hard_against":
      return "BTC draaide hard tegen de positie";
    case "depth_failed":
      return "Orderboek-depth viel weg";
    case "spread_explosion":
      return "Spread liep te ver op";
    case "trade_candidate_lost":
      return "Coin verloor trade-candidate status";
    case "stage_lost":
      return "Elite-structuur viel weg";

    case "quality_collapse":
      return "Entry quality zakte te ver weg";
    case "persistence_collapse":
      return "Persistence verloor te veel kracht";
    case "timeout_no_followthrough":
      return "Geen follow-through na de entry";
    case "thesis_damage_confirmed":
      return "Setup verloor op meerdere punten overtuiging";

    default:
      return reasonCode || "Onbekende reden";
  }
}

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function up(x) {
  return String(x || "").toUpperCase();
}