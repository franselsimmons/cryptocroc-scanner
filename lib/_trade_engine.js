// lib/_trade_engine.js

// ======================================================
// Filosofie
// ======================================================
// Verbeterde versie:
// - Meer entries zonder kwaliteit te verliezen
// - Minder onnodige closes
// - Winner protection sterker
// - Damage memory iets minder agressief
// - Spread tolerantie realistischer
// ======================================================

// ------------------------------------------------------
// Helpers
// ------------------------------------------------------

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function up(x) {
  return String(x || "").toUpperCase();
}

// ------------------------------------------------------
// BTC alignment
// ------------------------------------------------------

function isBtcAligned({ mode, btc }) {
  const btcState = up(btc?.state || "NEUTRAL");
  const btcChg24 = n(btc?.chg24, 0);
  const btcRange24 = n(btc?.range24, 0);

  // minder streng dan oude versie
  if (mode === "bull" && btcState === "BEAR" && btcChg24 < -2.2 && btcRange24 > 4.2)
    return false;

  if (mode === "bear" && btcState === "BULL" && btcChg24 > 2.2 && btcRange24 > 4.2)
    return false;

  return true;
}

// ------------------------------------------------------
// Elite stage
// ------------------------------------------------------

function isEliteStage(stage) {
  const s = up(stage || "");
  return (
    s === "ELITE_IGNITION" ||
    s === "ELITE_EXPANSION" ||
    s === "ELITE_CASCADE"
  );
}

// ------------------------------------------------------
// Score
// ------------------------------------------------------

function calcScore(parts) {
  const passed = parts.filter(Boolean).length;
  return Math.round((passed / Math.max(parts.length, 1)) * 100);
}

// ------------------------------------------------------
// MAIN EXECUTION DECISION
// ------------------------------------------------------

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
  const inPosition = !!positionState.inPosition;
  const entryQuality = n(coin.entryQuality);
  const persistence = n(coin.persistenceScore);
  const breakoutPressure = n(coin.breakout?.pressure);
  const breakoutReady = !!coin.breakout?.ready;
  const spread = n(coin.ob?.spreadPct, 999);
  const depthOk = !!coin.thresholds?.depthOk;
  const tradeCandidate = !!coin.tradeCandidate;
  const stageOk = isEliteStage(coin.stage);
  const btcOk = isBtcAligned({ mode, btc });

  const score = calcScore([
    btcOk,
    depthOk,
    tradeCandidate,
    stageOk,
    entryQuality >= 52,
    persistence >= 45,
    spread < 1.35,
  ]);

  // ======================================================
  // ENTRY
  // ======================================================

  if (!inPosition) {
    if (scannerGate !== "OPEN") {
      return decision("WATCH", "scanner_gate", score);
    }

    if (!btcOk || !depthOk || !tradeCandidate || !stageOk) {
      return decision("WATCH", "filters_not_met", score);
    }

    // IETS SOEPELER DAN OUDE
    if (
      entryQuality >= 52 &&
      persistence >= 45 &&
      (breakoutReady || breakoutPressure >= 48) &&
      spread < 1.35
    ) {
      return decision("OPEN", "strong_setup", score);
    }

    return decision("WATCH", "not_strong_enough", score);
  }

  // ======================================================
  // POSITION MANAGEMENT
  // ======================================================

  const currentPnl = n(positionState.currentPnlPct);
  const maxPnl = n(positionState.maxPnlPct);
  const cycles = n(positionState.cyclesInTrade);

  // BREAK EVEN sneller
  if (
    !positionState.breakevenArmed &&
    currentPnl >= 1.0 &&
    maxPnl >= 1.2 &&
    cycles >= 2
  ) {
    return decision("MOVE_SL_TO_BE", "protect_profit", score);
  }

  // TRAILING soepeler
  if (
    !positionState.trailingActive &&
    maxPnl >= 2.0 &&
    currentPnl >= 1.5
  ) {
    return decision("TRAIL", "winner_running", score);
  }

  // WINNER HOLD
  if (maxPnl >= 2.5 && currentPnl > 0.8) {
    return decision("HOLD", "winner_protected", score);
  }

  // NORMALE HOLD (minder streng)
  if (
    tradeCandidate &&
    stageOk &&
    persistence >= 32 &&
    spread < 1.6
  ) {
    return decision("HOLD", "valid_hold", score);
  }

  // DAMAGE CLOSE (iets minder agressief)
  if (entryQuality < 30 || persistence < 22) {
    return decision("CLOSE", "structure_lost", score);
  }

  return decision("CLOSE", "setup_invalidated", score);
}

// ------------------------------------------------------
// MOON EXECUTION (iets agressiever)
// ------------------------------------------------------

export function buildMoonExecutionDecision(args) {
  const base = buildMainExecutionDecision(args);

  // Moon mag iets sneller openen
  if (!args.positionState?.inPosition) {
    if (
      args.coin.entryQuality >= 50 &&
      args.coin.persistenceScore >= 42 &&
      args.coin.ob?.spreadPct < 1.25
    ) {
      return decision("OPEN", "moon_fast_entry", 70);
    }
  }

  return base;
}

// ------------------------------------------------------
// Decision Builder
// ------------------------------------------------------

function decision(action, reasonCode, score) {
  return {
    action,
    ready:
      action === "OPEN" ||
      action === "HOLD" ||
      action === "MOVE_SL_TO_BE" ||
      action === "TRAIL",
    score,
    reasonCode,
  };
}