// lib/_trade_engine.js

// ======================================================
// Filosofie
// ======================================================
// Scanner doet de zware filtering.
// Trade engine gaat er dus vanuit dat coins die hier komen
// al serieus sterk zijn.
//
// Daarom:
// - scannerGate bepaalt alleen of een coin de funnel in mag
// - scannerGate geldt ALLEEN voor coins zonder positie
// - zodra een positie open is, beslist trade engine volledig zelf
// - als scannerGate OPEN is, dan is entry ook echt entry
// - moon krijgt meer ruimte dan main
// - grace period direct na entry
// - WEAK_HOLD voor tijdelijke shakeout
// - CLOSE alleen bij echte damage / risk
//
// V2 versterkingen:
// - PnL-aware state
// - break-even move
// - trailing activation
// - partial reduce
// - damage memory
// - stale-entry block
// - re-entry block
// - portfolio guard hook
//
// Verwachte input voor bestaande posities:
// positionState = {
//   inPosition: true,
//   cyclesInTrade: 3,
//   minHoldCycles: 5,
//   weakHoldCount: 1,
//   maxWeakHoldCycles: 2,
//
//   currentPnlPct: 1.4,
//   maxPnlPct: 2.8,
//   minPnlPct: -0.7,
//   entryAt: 1710000000000,
//
//   breakevenArmed: false,
//   trailingActive: false,
//   trailingDistancePct: 0.9,
//
//   damageCount: 0,
//   recoveryCount: 0,
//   lastDamageReason: null,
//
//   recentStopout: false,
//   lastExitAt: 0,
// }
//
// scannerGate:
// - "OPEN"   => scanner/funnel zegt: nu echt openen
// - "WATCH"  => scanner ziet sterke coin, maar nog niet openen
// - "IGNORE" => scanner laat coin niet door
//
// portfolioGuard (optioneel):
// {
//   allowEntry: true,
//   allowReduce: true,
//   maxedOut: false,
//   reason: null,
// }
//
// Zodra inPosition === true wordt scannerGate genegeerd.
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

function normalizeScannerGate(scannerGate) {
  const g = up(scannerGate || "IGNORE");
  if (g === "OPEN" || g === "WATCH" || g === "IGNORE") return g;
  return "IGNORE";
}

function normalizePortfolioGuard(portfolioGuard) {
  return {
    allowEntry: portfolioGuard?.allowEntry !== false,
    allowReduce: portfolioGuard?.allowReduce !== false,
    maxedOut: portfolioGuard?.maxedOut === true,
    reason: portfolioGuard?.reason || null,
  };
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
  return Math.round((passed / Math.max(parts.length, 1)) * 100);
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
  scannerGate = "IGNORE",
  inPosition = false,
  graceActive = false,
  cyclesInTrade = 0,
  weakHoldCount = 0,
  holdState = "NONE",
  winnerRunning = false,
  softDamage = false,
  minHoldCycles = 0,
  maxWeakHoldCycles = 0,

  currentPnlPct = 0,
  maxPnlPct = 0,
  minPnlPct = 0,
  breakevenArmed = false,
  trailingActive = false,
  trailingDistancePct = 0,
  damageCount = 0,
  recoveryCount = 0,
  lastDamageReason = null,
  reduceFraction = 0,
  suggestedStopMode = "NONE",
  portfolioGuard = null,
}) {
  return {
    action,
    ready:
      action === "OPEN" ||
      action === "HOLD" ||
      action === "WEAK_HOLD" ||
      action === "MOVE_SL_TO_BE" ||
      action === "TRAIL" ||
      action === "REDUCE",
    score,
    checklist,
    reason,
    reasonCode,
    side: mode === "bull" ? "LONG" : "SHORT",
    positionSizeUsd: 50,
    reduceFraction,
    meta: {
      breakoutReady,
      breakoutPressure,
      coinProfile,
      scannerGate,
      inPosition,
      graceActive,
      cyclesInTrade,
      weakHoldCount,
      holdState,
      winnerRunning,
      softDamage,
      minHoldCycles,
      maxWeakHoldCycles,

      currentPnlPct,
      maxPnlPct,
      minPnlPct,
      breakevenArmed,
      trailingActive,
      trailingDistancePct,
      damageCount,
      recoveryCount,
      lastDamageReason,
      suggestedStopMode,
      portfolioGuard,
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

function isWinnerRunning({ coin, mode, maxPnlPct }) {
  const ch1h = n(coin?.change1h, 0);
  const breakoutReady = !!coin?.breakout?.ready;
  const breakoutPressure = n(coin?.breakout?.pressure, 0);
  const persistence = n(coin?.persistenceScore, 0);
  const obScore = n(coin?.ob?.score, 0);
  const bestPnl = n(maxPnlPct, 0);

  if (mode === "bull") {
    return (
      (ch1h >= 1.2 || breakoutReady || breakoutPressure >= 68 || bestPnl >= 2.0) &&
      persistence >= 52 &&
      obScore >= -0.01
    );
  }

  if (mode === "bear") {
    return (
      (ch1h <= -1.2 || breakoutReady || breakoutPressure >= 68 || bestPnl >= 2.0) &&
      persistence >= 52 &&
      obScore <= 0.01
    );
  }

  return false;
}

function isSoftDamage({
  entryQuality,
  persistence,
  breakoutPressure,
  spread,
  config,
}) {
  if (entryQuality < config.weakHoldQualityMin) return true;
  if (persistence < config.weakHoldPersistenceMin) return true;
  if (breakoutPressure < config.closeBreakoutFloor + 6) return true;
  if (spread >= config.weakHoldSpreadMax) return true;
  return false;
}

function isEntryStale({ breakoutReady, breakoutPressure, ageMinutes, config }) {
  if (breakoutReady) return false;
  if (breakoutPressure >= config.openBreakoutPressureMin + 8) return false;
  return ageMinutes > config.maxEntryAgeMinutes;
}

function shouldMoveToBreakEven({
  inPosition,
  breakevenArmed,
  currentPnlPct,
  maxPnlPct,
  cyclesInTrade,
  minHoldCycles,
  config,
}) {
  if (!inPosition) return false;
  if (breakevenArmed) return false;
  if (cyclesInTrade < Math.max(1, minHoldCycles - 2)) return false;
  if (currentPnlPct < config.breakEvenTriggerPnlPct) return false;
  if (maxPnlPct < config.breakEvenTriggerPnlPct + 0.15) return false;
  return true;
}

function shouldActivateTrailing({
  inPosition,
  trailingActive,
  currentPnlPct,
  maxPnlPct,
  winnerRunning,
  config,
}) {
  if (!inPosition) return false;
  if (trailingActive) return false;
  if (!winnerRunning) return false;
  if (currentPnlPct < config.trailingTriggerPnlPct) return false;
  if (maxPnlPct < config.trailingTriggerPnlPct) return false;
  return true;
}

function shouldReduce({
  inPosition,
  currentPnlPct,
  maxPnlPct,
  trailingActive,
  softDamage,
  portfolioGuard,
  config,
}) {
  if (!inPosition) return false;
  if (!portfolioGuard.allowReduce) return false;

  // winst veiligstellen als trade al mooi heeft gelopen en damage zichtbaar wordt
  if (maxPnlPct >= config.reduceAfterPnlPct && softDamage && currentPnlPct > 0.6) return true;

  // portfolio pressure: exposure te hoog -> winnaars deels afbouwen
  if (portfolioGuard.maxedOut && currentPnlPct >= 1.0) return true;

  // trailing al actief en duidelijke retrace vanaf beste PnL
  if (trailingActive && maxPnlPct >= config.reduceAfterPnlPct && (maxPnlPct - currentPnlPct) >= config.reduceDrawbackPct) {
    return true;
  }

  return false;
}

function updateDamageMemory({
  softDamage,
  reasonCode,
  prevDamageCount,
  prevRecoveryCount,
  lastDamageReason,
}) {
  let damageCount = n(prevDamageCount, 0);
  let recoveryCount = n(prevRecoveryCount, 0);
  let nextLastDamageReason = lastDamageReason || null;

  if (softDamage) {
    damageCount += 1;
    recoveryCount = 0;
    if (reasonCode) nextLastDamageReason = reasonCode;
  } else {
    recoveryCount += 1;
    if (recoveryCount >= 2) {
      damageCount = Math.max(0, damageCount - 1);
    }
  }

  return {
    damageCount,
    recoveryCount,
    lastDamageReason: nextLastDamageReason,
  };
}

// ======================================================
// Adaptive config per coin
// ======================================================
function getAdaptiveConfig(baseConfig, coin, coinProfile, systemType) {
  const cfg = { ...baseConfig };

  const spread = n(coin?.ob?.spreadPct, 999);
  const depth = n(coin?.ob?.depthMinUsd1p, 0);
  const breakoutPressure = n(coin?.breakout?.pressure, 0);
  const velocity = n(coin?.velocity, 0);
  const persistence = n(coin?.persistenceScore, 0);
  const band = String(coinProfile?.tradabilityBand || "unknown").toLowerCase();
  const system = String(systemType || coinProfile?.systemType || "unknown").toLowerCase();

  if (system === "moon") {
    cfg.minHoldCycles += 1;
    cfg.maxWeakHoldCycles += 1;
    cfg.holdSpreadMax += 0.08;
    cfg.weakHoldSpreadMax += 0.10;
    cfg.emergencySpread += 0.05;
    cfg.holdPersistenceMin = Math.max(20, cfg.holdPersistenceMin - 2);
    cfg.weakHoldPersistenceMin = Math.max(16, cfg.weakHoldPersistenceMin - 2);
    cfg.maxEntryAgeMinutes += 10;
    cfg.trailingDistancePct += 0.15;
  }

  if (band === "premium" || band === "high") {
    cfg.openSpreadMax = Math.max(0.65, cfg.openSpreadMax - 0.05);
    cfg.emergencySpread = Math.max(cfg.openSpreadMax + 0.45, cfg.emergencySpread - 0.10);
    cfg.trailingDistancePct = Math.max(0.55, cfg.trailingDistancePct - 0.05);
  }

  if (band === "low") {
    cfg.maxWeakHoldCycles += 1;
    cfg.weakHoldSpreadMax += 0.10;
    cfg.emergencySpread += 0.10;
    cfg.maxEntryAgeMinutes = Math.max(12, cfg.maxEntryAgeMinutes - 3);
  }

  if (breakoutPressure >= 72 || velocity >= 0.22) {
    cfg.maxWeakHoldCycles += 1;
    cfg.holdScoreMin = Math.max(28, cfg.holdScoreMin - 2);
    cfg.weakHoldScoreMin = Math.max(24, cfg.weakHoldScoreMin - 2);
    cfg.trailingTriggerPnlPct = Math.max(1.0, cfg.trailingTriggerPnlPct - 0.2);
  }

  if (persistence >= 72 && depth >= 50000 && spread <= 0.60) {
    cfg.holdPersistenceMin = Math.max(20, cfg.holdPersistenceMin - 3);
    cfg.closePersistenceFloor = Math.max(12, cfg.closePersistenceFloor - 2);
  }

  return cfg;
}

// ======================================================
// Core decision engine
// ======================================================
function buildExecutionDecision({
  coin,
  btc,
  regime,
  mode,
  coinProfile,
  positionState = {},
  scannerGate = "OPEN",
  config,
  portfolioGuard = {},
}) {
  const gate = normalizeScannerGate(scannerGate);
  const inPosition = !!positionState.inPosition;
  const pg = normalizePortfolioGuard(portfolioGuard);

  const adaptiveConfig = getAdaptiveConfig(
    config,
    coin,
    coinProfile,
    coinProfile?.systemType
  );

  const cyclesInTrade = n(positionState.cyclesInTrade, 0);
  const minHoldCycles = n(positionState.minHoldCycles, adaptiveConfig.minHoldCycles);
  const weakHoldCount = n(positionState.weakHoldCount, 0);
  const maxWeakHoldCycles = n(positionState.maxWeakHoldCycles, adaptiveConfig.maxWeakHoldCycles);

  const currentPnlPct = n(positionState.currentPnlPct, 0);
  const maxPnlPct = n(positionState.maxPnlPct, 0);
  const minPnlPct = n(positionState.minPnlPct, 0);
  const breakevenArmed = !!positionState.breakevenArmed;
  const trailingActive = !!positionState.trailingActive;
  const trailingDistancePct = n(positionState.trailingDistancePct, adaptiveConfig.trailingDistancePct);
  const damageCountPrev = n(positionState.damageCount, 0);
  const recoveryCountPrev = n(positionState.recoveryCount, 0);
  const lastDamageReasonPrev = positionState.lastDamageReason || null;
  const recentStopout = !!positionState.recentStopout;
  const entryAgeMinutes = n(positionState.entryAgeMinutes, 0);

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

  const qualityOpenOk = entryQuality >= adaptiveConfig.openQualityMin;
  const persistenceOpenOk = persistence >= adaptiveConfig.openPersistenceMin;
  const breakoutOpenOk = breakoutReady || breakoutPressure >= adaptiveConfig.openBreakoutPressureMin;
  const spreadOpenOk = spread < adaptiveConfig.openSpreadMax;
  const freshEntrySoftOk =
    freshOb ||
    breakoutReady ||
    breakoutPressure >= adaptiveConfig.openBreakoutPressureMin + 4;

  const qualityHoldOk = entryQuality >= adaptiveConfig.holdQualityMin;
  const persistenceHoldOk = persistence >= adaptiveConfig.holdPersistenceMin;
  const spreadHoldOk = spread < adaptiveConfig.holdSpreadMax;

  const qualityWeakOk = entryQuality >= adaptiveConfig.weakHoldQualityMin;
  const persistenceWeakOk = persistence >= adaptiveConfig.weakHoldPersistenceMin;
  const spreadWeakOk = spread < adaptiveConfig.weakHoldSpreadMax;

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
    emergencySpread: adaptiveConfig.emergencySpread,
  });

  const graceActive = inPosition && cyclesInTrade < minHoldCycles;
  const winnerRunning = isWinnerRunning({ coin, mode, maxPnlPct });
  const softDamage = isSoftDamage({
    entryQuality,
    persistence,
    breakoutPressure,
    spread,
    config: adaptiveConfig,
  });

  const weaknessReasonCode = getWeaknessReason({
    entryQuality,
    persistence,
    breakoutPressure,
    qualityCloseFloor: adaptiveConfig.closeQualityFloor,
    persistenceCloseFloor: adaptiveConfig.closePersistenceFloor,
    breakoutCloseFloor: adaptiveConfig.closeBreakoutFloor,
  });

  const memory = updateDamageMemory({
    softDamage,
    reasonCode: softDamage ? weaknessReasonCode : null,
    prevDamageCount: damageCountPrev,
    prevRecoveryCount: recoveryCountPrev,
    lastDamageReason: lastDamageReasonPrev,
  });

  // ======================================================
  // ENTRY LOGIC
  // ======================================================
  if (!inPosition) {
    if (gate === "IGNORE") {
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
        scannerGate: gate,
        inPosition: false,
        minHoldCycles,
        maxWeakHoldCycles,
        portfolioGuard: pg,
      });
    }

    if (gate === "WATCH") {
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
        scannerGate: gate,
        inPosition: false,
        minHoldCycles,
        maxWeakHoldCycles,
        portfolioGuard: pg,
      });
    }

    if (!pg.allowEntry || pg.maxedOut) {
      return finalizeDecision({
        action: "WATCH",
        reason: pg.reason || "Portfolio guard blokkeert nieuwe entry",
        reasonCode: "portfolio_guard_block",
        mode,
        score,
        checklist,
        breakoutReady,
        breakoutPressure,
        coinProfile,
        scannerGate: gate,
        inPosition: false,
        minHoldCycles,
        maxWeakHoldCycles,
        portfolioGuard: pg,
      });
    }

    if (recentStopout) {
      return finalizeDecision({
        action: "WATCH",
        reason: "Recente stopout op deze coin; eerst bevestiging afwachten",
        reasonCode: "recent_stopout_block",
        mode,
        score,
        checklist,
        breakoutReady,
        breakoutPressure,
        coinProfile,
        scannerGate: gate,
        inPosition: false,
        minHoldCycles,
        maxWeakHoldCycles,
        portfolioGuard: pg,
      });
    }

    if (isEntryStale({
      breakoutReady,
      breakoutPressure,
      ageMinutes: entryAgeMinutes,
      config: adaptiveConfig,
    })) {
      return finalizeDecision({
        action: "WATCH",
        reason: "Entry-signaal is te oud geworden zonder overtuigende doorzetting",
        reasonCode: "entry_stale",
        mode,
        score,
        checklist,
        breakoutReady,
        breakoutPressure,
        coinProfile,
        scannerGate: gate,
        inPosition: false,
        minHoldCycles,
        maxWeakHoldCycles,
        portfolioGuard: pg,
      });
    }

    return finalizeDecision({
      action: "OPEN",
      reason: breakoutReady
        ? "Scanner gaf entry door en trade is direct geopend"
        : "Scanner gaf entry door en trade is vroeg geopend",
      reasonCode: breakoutReady ? "entry_confirmed" : "entry_early_strength",
      mode,
      score,
      checklist,
      breakoutReady,
      breakoutPressure,
      coinProfile,
      scannerGate: gate,
      inPosition: false,
      graceActive: true,
      cyclesInTrade: 0,
      weakHoldCount: 0,
      holdState: "GRACE_HOLD",
      minHoldCycles,
      maxWeakHoldCycles,
      currentPnlPct: 0,
      maxPnlPct: 0,
      minPnlPct: 0,
      breakevenArmed: false,
      trailingActive: false,
      trailingDistancePct,
      damageCount: 0,
      recoveryCount: 0,
      lastDamageReason: null,
      suggestedStopMode: "INITIAL",
      portfolioGuard: pg,
    });
  }

  // ======================================================
  // EMERGENCY EXIT
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
      scannerGate: gate,
      inPosition: true,
      graceActive,
      cyclesInTrade,
      weakHoldCount,
      holdState: "EMERGENCY_EXIT",
      winnerRunning,
      softDamage,
      minHoldCycles,
      maxWeakHoldCycles,
      currentPnlPct,
      maxPnlPct,
      minPnlPct,
      breakevenArmed,
      trailingActive,
      trailingDistancePct,
      damageCount: memory.damageCount,
      recoveryCount: memory.recoveryCount,
      lastDamageReason: memory.lastDamageReason,
      suggestedStopMode: "EMERGENCY_CLOSE",
      portfolioGuard: pg,
    });
  }

  // ======================================================
  // BREAK-EVEN MOVE
  // ======================================================
  if (shouldMoveToBreakEven({
    inPosition,
    breakevenArmed,
    currentPnlPct,
    maxPnlPct,
    cyclesInTrade,
    minHoldCycles,
    config: adaptiveConfig,
  })) {
    return finalizeDecision({
      action: "MOVE_SL_TO_BE",
      reason: "Trade heeft voldoende winst opgebouwd om break-even bescherming te activeren",
      reasonCode: "move_sl_to_be",
      mode,
      score,
      checklist,
      breakoutReady,
      breakoutPressure,
      coinProfile,
      scannerGate: gate,
      inPosition: true,
      graceActive,
      cyclesInTrade,
      weakHoldCount,
      holdState: "BREAKEVEN_ARM",
      winnerRunning,
      softDamage,
      minHoldCycles,
      maxWeakHoldCycles,
      currentPnlPct,
      maxPnlPct,
      minPnlPct,
      breakevenArmed: true,
      trailingActive,
      trailingDistancePct,
      damageCount: memory.damageCount,
      recoveryCount: memory.recoveryCount,
      lastDamageReason: memory.lastDamageReason,
      suggestedStopMode: "BREAK_EVEN",
      portfolioGuard: pg,
    });
  }

  // ======================================================
  // TRAILING ACTIVATE
  // ======================================================
  if (shouldActivateTrailing({
    inPosition,
    trailingActive,
    currentPnlPct,
    maxPnlPct,
    winnerRunning,
    config: adaptiveConfig,
  })) {
    return finalizeDecision({
      action: "TRAIL",
      reason: "Sterke winner: trailing protection wordt geactiveerd",
      reasonCode: "activate_trailing",
      mode,
      score,
      checklist,
      breakoutReady,
      breakoutPressure,
      coinProfile,
      scannerGate: gate,
      inPosition: true,
      graceActive,
      cyclesInTrade,
      weakHoldCount,
      holdState: "TRAILING",
      winnerRunning,
      softDamage,
      minHoldCycles,
      maxWeakHoldCycles,
      currentPnlPct,
      maxPnlPct,
      minPnlPct,
      breakevenArmed,
      trailingActive: true,
      trailingDistancePct,
      damageCount: memory.damageCount,
      recoveryCount: memory.recoveryCount,
      lastDamageReason: memory.lastDamageReason,
      suggestedStopMode: "TRAILING",
      portfolioGuard: pg,
    });
  }

  // ======================================================
  // GRACE HOLD
  // ======================================================
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
      scannerGate: gate,
      inPosition: true,
      graceActive,
      cyclesInTrade,
      weakHoldCount: 0,
      holdState: "GRACE_HOLD",
      winnerRunning,
      softDamage,
      minHoldCycles,
      maxWeakHoldCycles,
      currentPnlPct,
      maxPnlPct,
      minPnlPct,
      breakevenArmed,
      trailingActive,
      trailingDistancePct,
      damageCount: memory.damageCount,
      recoveryCount: memory.recoveryCount,
      lastDamageReason: memory.lastDamageReason,
      suggestedStopMode: breakevenArmed ? "BREAK_EVEN" : "INITIAL",
      portfolioGuard: pg,
    });
  }

  // ======================================================
  // REDUCE
  // ======================================================
  if (shouldReduce({
    inPosition,
    currentPnlPct,
    maxPnlPct,
    trailingActive,
    softDamage,
    portfolioGuard: pg,
    config: adaptiveConfig,
  })) {
    return finalizeDecision({
      action: "REDUCE",
      reason: "Deelwinst veiligstellen terwijl de trade nog leefbaar blijft",
      reasonCode: "reduce_partial",
      mode,
      score,
      checklist,
      breakoutReady,
      breakoutPressure,
      coinProfile,
      scannerGate: gate,
      inPosition: true,
      graceActive,
      cyclesInTrade,
      weakHoldCount,
      holdState: "REDUCE",
      winnerRunning,
      softDamage,
      minHoldCycles,
      maxWeakHoldCycles,
      currentPnlPct,
      maxPnlPct,
      minPnlPct,
      breakevenArmed,
      trailingActive,
      trailingDistancePct,
      damageCount: memory.damageCount,
      recoveryCount: memory.recoveryCount,
      lastDamageReason: memory.lastDamageReason,
      reduceFraction: adaptiveConfig.reduceFraction,
      suggestedStopMode: trailingActive ? "TRAILING" : (breakevenArmed ? "BREAK_EVEN" : "INITIAL"),
      portfolioGuard: pg,
    });
  }

  // ======================================================
  // NORMAL HOLD
  // ======================================================
  const holdOk =
    tradeCandidate &&
    stageOk &&
    regimeOk &&
    depthOk &&
    (
      (
        qualityHoldOk &&
        persistenceHoldOk &&
        spreadHoldOk &&
        score >= adaptiveConfig.holdScoreMin
      ) ||
      (
        winnerRunning &&
        spread < adaptiveConfig.weakHoldSpreadMax &&
        score >= Math.max(adaptiveConfig.weakHoldScoreMin, adaptiveConfig.holdScoreMin - 4)
      )
    );

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
      scannerGate: gate,
      inPosition: true,
      graceActive,
      cyclesInTrade,
      weakHoldCount: 0,
      holdState: "HOLD",
      winnerRunning,
      softDamage,
      minHoldCycles,
      maxWeakHoldCycles,
      currentPnlPct,
      maxPnlPct,
      minPnlPct,
      breakevenArmed,
      trailingActive,
      trailingDistancePct,
      damageCount: memory.damageCount,
      recoveryCount: memory.recoveryCount,
      lastDamageReason: memory.lastDamageReason,
      suggestedStopMode: trailingActive ? "TRAILING" : (breakevenArmed ? "BREAK_EVEN" : "INITIAL"),
      portfolioGuard: pg,
    });
  }

  // ======================================================
  // WEAK HOLD
  // ======================================================
  const weakHoldOk =
    tradeCandidate &&
    stageOk &&
    regimeOk &&
    depthOk &&
    qualityWeakOk &&
    persistenceWeakOk &&
    spreadWeakOk &&
    score >= adaptiveConfig.weakHoldScoreMin;

  const weakHoldLimit = winnerRunning
    ? maxWeakHoldCycles + 1
    : maxWeakHoldCycles;

  if (weakHoldOk && weakHoldCount < weakHoldLimit) {
    return finalizeDecision({
      action: "WEAK_HOLD",
      reason: winnerRunning
        ? "Lopende winner toont tijdelijke zwakte, maar mag nog ademen"
        : "Tijdelijke zwakte gedetecteerd, maar nog geen bevestigde thesis break",
      reasonCode: winnerRunning ? "weak_hold_winner" : "weak_hold",
      mode,
      score,
      checklist,
      breakoutReady,
      breakoutPressure,
      coinProfile,
      scannerGate: gate,
      inPosition: true,
      graceActive,
      cyclesInTrade,
      weakHoldCount: weakHoldCount + 1,
      holdState: "WEAK_HOLD",
      winnerRunning,
      softDamage,
      minHoldCycles,
      maxWeakHoldCycles,
      currentPnlPct,
      maxPnlPct,
      minPnlPct,
      breakevenArmed,
      trailingActive,
      trailingDistancePct,
      damageCount: memory.damageCount,
      recoveryCount: memory.recoveryCount,
      lastDamageReason: memory.lastDamageReason,
      suggestedStopMode: trailingActive ? "TRAILING" : (breakevenArmed ? "BREAK_EVEN" : "INITIAL"),
      portfolioGuard: pg,
    });
  }

  if (softDamage && weakHoldCount === 0 && weaknessReasonCode !== "thesis_damage_confirmed") {
    return finalizeDecision({
      action: "WEAK_HOLD",
      reason: "Zwakte gezien, maar eerst bevestiging afwachten",
      reasonCode: "weakness_needs_confirmation",
      mode,
      score,
      checklist,
      breakoutReady,
      breakoutPressure,
      coinProfile,
      scannerGate: gate,
      inPosition: true,
      graceActive,
      cyclesInTrade,
      weakHoldCount: weakHoldCount + 1,
      holdState: "WEAK_HOLD",
      winnerRunning,
      softDamage,
      minHoldCycles,
      maxWeakHoldCycles,
      currentPnlPct,
      maxPnlPct,
      minPnlPct,
      breakevenArmed,
      trailingActive,
      trailingDistancePct,
      damageCount: memory.damageCount,
      recoveryCount: memory.recoveryCount,
      lastDamageReason: memory.lastDamageReason,
      suggestedStopMode: trailingActive ? "TRAILING" : (breakevenArmed ? "BREAK_EVEN" : "INITIAL"),
      portfolioGuard: pg,
    });
  }

  // Extra bescherming: te veel damage-cycli = close
  if (memory.damageCount >= adaptiveConfig.maxDamageCycles) {
    return finalizeDecision({
      action: "CLOSE",
      reason: "Setup verloor over meerdere cycles overtuiging",
      reasonCode: "damage_memory_close",
      mode,
      score,
      checklist,
      breakoutReady,
      breakoutPressure,
      coinProfile,
      scannerGate: gate,
      inPosition: true,
      graceActive,
      cyclesInTrade,
      weakHoldCount,
      holdState: "CLOSE",
      winnerRunning,
      softDamage,
      minHoldCycles,
      maxWeakHoldCycles,
      currentPnlPct,
      maxPnlPct,
      minPnlPct,
      breakevenArmed,
      trailingActive,
      trailingDistancePct,
      damageCount: memory.damageCount,
      recoveryCount: memory.recoveryCount,
      lastDamageReason: memory.lastDamageReason,
      suggestedStopMode: "CLOSE",
      portfolioGuard: pg,
    });
  }

  // Hard retrace sluiting voor winners met trailing actief
  if (
    trailingActive &&
    maxPnlPct >= adaptiveConfig.trailingTriggerPnlPct &&
    (maxPnlPct - currentPnlPct) >= adaptiveConfig.trailingCloseDrawbackPct &&
    currentPnlPct > 0
  ) {
    return finalizeDecision({
      action: "CLOSE",
      reason: "Winner gaf te veel winst terug onder trailing-regime",
      reasonCode: "trailing_close",
      mode,
      score,
      checklist,
      breakoutReady,
      breakoutPressure,
      coinProfile,
      scannerGate: gate,
      inPosition: true,
      graceActive,
      cyclesInTrade,
      weakHoldCount,
      holdState: "TRAIL_CLOSE",
      winnerRunning,
      softDamage,
      minHoldCycles,
      maxWeakHoldCycles,
      currentPnlPct,
      maxPnlPct,
      minPnlPct,
      breakevenArmed,
      trailingActive,
      trailingDistancePct,
      damageCount: memory.damageCount,
      recoveryCount: memory.recoveryCount,
      lastDamageReason: memory.lastDamageReason,
      suggestedStopMode: "CLOSE",
      portfolioGuard: pg,
    });
  }

  return finalizeDecision({
    action: "CLOSE",
    reason: humanizeReason(weaknessReasonCode),
    reasonCode: weaknessReasonCode,
    mode,
    score,
    checklist,
    breakoutReady,
    breakoutPressure,
    coinProfile,
    scannerGate: gate,
    inPosition: true,
    graceActive,
    cyclesInTrade,
    weakHoldCount,
    holdState: "CLOSE",
    winnerRunning,
    softDamage,
    minHoldCycles,
    maxWeakHoldCycles,
    currentPnlPct,
    maxPnlPct,
    minPnlPct,
    breakevenArmed,
    trailingActive,
    trailingDistancePct,
    damageCount: memory.damageCount,
    recoveryCount: memory.recoveryCount,
    lastDamageReason: memory.lastDamageReason,
    suggestedStopMode: "CLOSE",
    portfolioGuard: pg,
  });
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
  scannerGate = "OPEN",
  portfolioGuard = {},
}) {
  return buildExecutionDecision({
    coin,
    btc,
    regime,
    mode,
    coinProfile,
    positionState,
    scannerGate,
    portfolioGuard,
    config: {
      minHoldCycles: 5,
      maxWeakHoldCycles: 2,
      maxDamageCycles: 3,

      openQualityMin: 58,
      openPersistenceMin: 50,
      openBreakoutPressureMin: 52,
      openSpreadMax: 1.05,
      openScoreMin: 58,
      maxEntryAgeMinutes: 20,

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

      breakEvenTriggerPnlPct: 1.2,
      trailingTriggerPnlPct: 2.2,
      trailingDistancePct: 0.85,
      trailingCloseDrawbackPct: 1.25,

      reduceAfterPnlPct: 2.8,
      reduceDrawbackPct: 1.0,
      reduceFraction: 0.35,
    },
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
  scannerGate = "OPEN",
  portfolioGuard = {},
}) {
  return buildExecutionDecision({
    coin,
    btc,
    regime,
    mode,
    coinProfile,
    positionState,
    scannerGate,
    portfolioGuard,
    config: {
      minHoldCycles: 6,
      maxWeakHoldCycles: 3,
      maxDamageCycles: 4,

      openQualityMin: 54,
      openPersistenceMin: 46,
      openBreakoutPressureMin: 50,
      openSpreadMax: 0.95,
      openScoreMin: 56,
      maxEntryAgeMinutes: 26,

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

      breakEvenTriggerPnlPct: 1.4,
      trailingTriggerPnlPct: 2.6,
      trailingDistancePct: 1.00,
      trailingCloseDrawbackPct: 1.45,

      reduceAfterPnlPct: 3.4,
      reduceDrawbackPct: 1.2,
      reduceFraction: 0.30,
    },
  });
}

// ======================================================
// Human readable reasons
// ======================================================
function humanizeReason(reasonCode) {
  switch (String(reasonCode || "").toLowerCase()) {
    case "entry_confirmed":
      return "Scanner-setup bevestigd en positie geopend";
    case "entry_early_strength":
      return "Vroege entry op sterke scanner-setup";
    case "scanner_block":
      return "Scanner heeft coin niet doorgelaten";
    case "scanner_watch":
      return "Scanner houdt deze coin nog in watch-fase";
    case "portfolio_guard_block":
      return "Portfolio guard blokkeert nieuwe entry";
    case "recent_stopout_block":
      return "Recente stopout: eerst nieuwe bevestiging afwachten";
    case "entry_stale":
      return "Entry-signaal werd te oud zonder overtuigende doorzetting";

    case "grace_hold":
      return "Grace hold actief";
    case "hold_valid":
      return "Positie blijft valide";
    case "weak_hold":
      return "Tijdelijke zwakte zonder bevestigde break";
    case "weak_hold_winner":
      return "Lopende winner kreeg extra ruimte tijdens tijdelijke zwakte";
    case "weakness_needs_confirmation":
      return "Zwakte gezien, maar nog geen bevestigde break";
    case "move_sl_to_be":
      return "Break-even bescherming activeren";
    case "activate_trailing":
      return "Trailing protection activeren";
    case "reduce_partial":
      return "Deelwinst veiligstellen";
    case "damage_memory_close":
      return "Te veel opeenvolgende schadecycli";
    case "trailing_close":
      return "Te veel winst teruggegeven onder trailing-regime";

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