// ../lib/_trade_engine.js
// VolatilityForge Trade Engine (MAIN + MOON)
// - Scanner gate bepaalt of entries zijn toegestaan (OPEN/WATCH/IGNORE)
// - Anti-flip: hysteresis + minHoldCycles + weakHold limiter
// - PnL: correct voor LONG en SHORT (side altijd vanuit mode geforceerd)
// - Meta payload consistent voor Discord / analytics

import { hitStopOrTp } from "./_moon_core.js";

// ------------------------------------------------------
// helpers
// ------------------------------------------------------
function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}
function up(x) {
  return String(x || "").toUpperCase();
}

function sideFromMode(mode) {
  return String(mode || "bull").toLowerCase() === "bear" ? "SHORT" : "LONG";
}

// Correct PnL for LONG and SHORT
function pnlPctForSide({ entryPrice, lastPrice, side }) {
  const e = n(entryPrice, 0);
  const p = n(lastPrice, 0);
  if (!(e > 0 && p > 0)) return 0;

  const s = up(side);
  if (s === "SHORT") {
    // SHORT wins if price goes DOWN
    return ((e - p) / e) * 100;
  }
  // LONG
  return ((p - e) / e) * 100;
}

// Basic spread sanity (optional)
function isBadSpread(spreadPct, maxPct) {
  const sp = n(spreadPct, 999);
  return sp > maxPct;
}

// Determine if breakout is truly “ready” + pressure
function breakoutOk(breakout, minPressure = 0) {
  const ready = !!breakout?.ready;
  const pressure = n(breakout?.pressure, 0);
  return ready || pressure >= minPressure;
}

// ------------------------------------------------------
// Build a normalized profile used by Discord + scoring
// NOTE: side wordt NIET meer uit coin.mode gehaald (te vaak undefined)
// Side wordt altijd geforceerd vanuit de wrapper (mode).
// ------------------------------------------------------
export function buildCoinProfile({ systemType, coin }) {
  const c = coin || {};
  const ob = c.ob || {};
  const th = c.thresholds || {};
  const br = c.breakout || {};
  const comp = c.compression || {};

  return {
    systemType: String(systemType || "main"),
    id: c.id,
    symbol: up(c.symbol),
    name: c.name || "",
    image: c.image || "",

    // ⚠️ side wordt later geforceerd vanuit wrapper (buildMain/MoonExecutionDecision)
    side: up(c.side || ""),

    stage: up(c.stage || ""),
    stageWhy: String(c.stageWhy || ""),
    eliteType: c.eliteType || null,

    price: n(c.price, 0),
    marketCap: n(c.marketCap, 0),
    volume: n(c.volume, 0),
    change1h: n(c.change1h, 0),
    change24: n(c.change24, 0),
    range24: n(c.range24, 0),
    vm: n(c.vm, 0),

    // Scores
    confidence: n(c.confidence, 0),
    entryQuality: n(c.entryQuality, 0),
    persistenceScore: n(c.persistenceScore, 0),
    qualityScore: n(c.qualityScore, 0),
    liquidityScore: n(c.liquidityScore, 0),
    timingScore: n(c.timingScore, 0),
    marketScore: n(c.marketScore, 0),
    btcAlignmentScore: n(c.btcAlignmentScore, 0),
    perfectCandidateScore: n(c.perfectCandidateScore, 0),

    // OB
    ob: {
      bestBid: n(ob.bestBid, 0),
      bestAsk: n(ob.bestAsk, 0),
      spreadPct: n(ob.spreadPct, 999),
      depthMinUsd1p: n(ob.depthMinUsd1p, 0),
      score: n(ob.score, 0),
      lor: n(ob.lor, 0),
      valid: !!ob.valid,
      fresh: !!ob.fresh,
      stale: !!ob.stale,
      reason: String(ob.reason || ""),
    },

    // Liquidity thresholds
    thresholds: {
      depthFloorUsd: n(th.depthFloorUsd, 0),
      depthOk: !!th.depthOk,
    },

    // Breakout & compression
    breakout: {
      ready: !!br.ready,
      pressure: n(br.pressure, 0),
      breakoutPct: n(br.breakoutPct, 0),
    },
    compression: {
      isCompressed: !!comp.isCompressed,
      flatPct: n(comp.flatPct, 0),
    },

    // Plan
    tradePlan: c.tradePlan || null,

    // flags
    tradeCandidate: !!c.tradeCandidate,
    superScannerCoin: !!c.superScannerCoin,
    scannerOnly: !!c.scannerOnly,

    // scanner gate
    scannerGate: up(c.tradeDeskStatus || c.scannerGate || "IGNORE"),
  };
}

// ------------------------------------------------------
// Shared decision core (MAIN + MOON)
// ------------------------------------------------------
function buildExecutionDecisionCore({
  systemType,
  coin,
  btc,
  regime,
  mode,
  coinProfile,
  positionState,
  scannerGate,
  cfg,
}) {
  const gate = up(scannerGate || coin?.tradeDeskStatus || "IGNORE");
  const profile = coinProfile || buildCoinProfile({ systemType, coin });

  // Normalize state
  const ps = positionState || {};
  const inPosition = !!ps.inPosition;
  const cyclesInTrade = n(ps.cyclesInTrade, 0);
  const minHoldCycles = Math.max(1, n(ps.minHoldCycles, cfg.minHoldCycles));
  const weakHoldCount = n(ps.weakHoldCount, 0);
  const maxWeakHoldCycles = Math.max(1, n(ps.maxWeakHoldCycles, cfg.maxWeakHoldCycles));

  // Prices
  const last = n(coin?.price, profile.price);
  const plan = coin?.tradePlan || profile.tradePlan;

  // Base meta that all signals can reuse
  const baseMeta = {
    systemType,
    gate,
    mode: String(mode || "bull"),
    // ✅ side komt 100% vanuit wrapper en is dus altijd correct
    side: up(profile.side || sideFromMode(mode)),
    regime: String(regime || ""),
    btcState: String(btc?.state || "NEUTRAL").toUpperCase(),

    symbol: profile.symbol,
    stage: profile.stage,
    eliteType: profile.eliteType,
    stageWhy: profile.stageWhy,

    price: last,

    // scoring
    entryQuality: profile.entryQuality,
    persistenceScore: profile.persistenceScore,
    qualityScore: profile.qualityScore,
    liquidityScore: profile.liquidityScore,
    timingScore: profile.timingScore,
    marketScore: profile.marketScore,
    perfectCandidateScore: profile.perfectCandidateScore,

    // breakout
    breakoutReady: !!profile.breakout?.ready,
    breakoutPressure: n(profile.breakout?.pressure, 0),
    breakoutPct: n(profile.breakout?.breakoutPct, 0),

    // ob
    spreadPct: n(profile.ob?.spreadPct, 999),
    depthUsd: n(profile.ob?.depthMinUsd1p, 0),
    obScore: n(profile.ob?.score, 0),

    tradePlan: plan
      ? {
          entry: n(plan.entry, 0),
          sl: n(plan.sl, 0),
          tp: n(plan.tp, 0),
          rr: n(plan.rr, 0),
          tpPct: n(plan.tpPct, 0),
          slPct: n(plan.slPct, 0),
        }
      : null,

    // position state
    inPosition,
    cyclesInTrade,
    minHoldCycles,
    weakHoldCount,
    maxWeakHoldCycles,
  };

  // --------------------------------------------------
  // If NOT in position: engine only says "ALLOW_ENTRY" when gate is OPEN
  // Scanner actually opens position in your scan script.
  // --------------------------------------------------
  if (!inPosition) {
    if (gate !== "OPEN") {
      return {
        action: "NO_TRADE",
        meta: { ...baseMeta, reason: "gate_not_open" },
      };
    }

    // gate OPEN but still apply some sanity checks (anti-trash)
    if (!plan) {
      return { action: "NO_TRADE", meta: { ...baseMeta, reason: "missing_trade_plan" } };
    }

    if (cfg.blockBadSpread && isBadSpread(profile.ob?.spreadPct, cfg.maxSpreadPct)) {
      return { action: "NO_TRADE", meta: { ...baseMeta, reason: "spread_too_wide" } };
    }

    if (cfg.requireBreakoutForEntry && !breakoutOk(profile.breakout, cfg.minBreakoutPressure)) {
      return { action: "NO_TRADE", meta: { ...baseMeta, reason: "breakout_not_ready" } };
    }

    return {
      action: "ALLOW_ENTRY",
      meta: { ...baseMeta, reason: "gate_open_allow_entry" },
    };
  }

  // --------------------------------------------------
  // In position: HOLD / WEAK_HOLD / EXIT
  // --------------------------------------------------

  // PnL needs entry price.
  // Prefer coin.entryPrice (position manager), fallback to plan.entry.
  const entryPrice = n(coin?.entryPrice, n(plan?.entry, 0));
  const pnlPct = pnlPctForSide({ entryPrice, lastPrice: last, side: baseMeta.side });

  // Stop/TP hit check
  const stopTp = plan
    ? hitStopOrTp({
        side: baseMeta.side,
        price: last,
        entry: n(plan.entry, entryPrice),
        sl: n(plan.sl, 0),
        tp: n(plan.tp, 0),
      })
    : null;

  if (stopTp?.hit === "SL") {
    return {
      action: "EXIT",
      meta: { ...baseMeta, pnlPct, reason: "stop_loss", exitReason: "sl" },
    };
  }
  if (stopTp?.hit === "TP") {
    return {
      action: "EXIT",
      meta: { ...baseMeta, pnlPct, reason: "take_profit", exitReason: "tp" },
    };
  }

  // Hard anti-flip: minimum hold cycles before any soft exits
  if (cyclesInTrade < minHoldCycles) {
    return {
      action: "HOLD",
      meta: { ...baseMeta, pnlPct, reason: "min_hold_cycles" },
    };
  }

  // Thesis validity & weakening
  const obScore = n(profile.ob?.score, 0);
  const psScore = n(profile.persistenceScore, 0);
  const eqScore = n(profile.entryQuality, 0);

  const breakoutStillOk = breakoutOk(profile.breakout, cfg.minBreakoutPressureHold);
  const obAgainst =
    baseMeta.side === "LONG" ? obScore <= -cfg.obContraAbs : obScore >= cfg.obContraAbs;

  const weakSignals =
    (breakoutStillOk ? 0 : 1) +
    (psScore < cfg.minPersistenceHold ? 1 : 0) +
    (eqScore < cfg.minEntryQualityHold ? 1 : 0) +
    (obAgainst ? 1 : 0);

  if (weakSignals === 0) {
    return { action: "HOLD", meta: { ...baseMeta, pnlPct, reason: "healthy_hold" } };
  }

  if (weakSignals <= 2 && weakHoldCount < maxWeakHoldCycles) {
    return {
      action: "WEAK_HOLD",
      meta: {
        ...baseMeta,
        pnlPct,
        reason: "weak_but_not_break",
        weakSignals,
        weakHoldCount: weakHoldCount + 1,
      },
    };
  }

  // Timeout exit (if stuck and not moving)
  if (cyclesInTrade >= cfg.timeoutBars && pnlPct < cfg.timeoutMinPnlPct) {
    return {
      action: "EXIT",
      meta: { ...baseMeta, pnlPct, reason: "timeout_exit", exitReason: "timeout" },
    };
  }

  // Thesis break exit
  return {
    action: "EXIT",
    meta: { ...baseMeta, pnlPct, reason: "thesis_break", exitReason: "thesis_break" },
  };
}

// ------------------------------------------------------
// MAIN + MOON wrappers
// ------------------------------------------------------
const MAIN_ENGINE_CFG = {
  minHoldCycles: 5,
  maxWeakHoldCycles: 2,
  timeoutBars: 12,
  timeoutMinPnlPct: 0.3,

  // sanity
  blockBadSpread: true,
  maxSpreadPct: 0.9,

  // breakout gating
  requireBreakoutForEntry: false,
  minBreakoutPressure: 52,
  minBreakoutPressureHold: 48,

  // thesis thresholds
  minPersistenceHold: 50,
  minEntryQualityHold: 58,
  obContraAbs: 0.02,
};

const MOON_ENGINE_CFG = {
  minHoldCycles: 6,
  maxWeakHoldCycles: 3,
  timeoutBars: 24,
  timeoutMinPnlPct: 0.2,

  blockBadSpread: true,
  maxSpreadPct: 1.1,

  requireBreakoutForEntry: false,
  minBreakoutPressure: 52,
  minBreakoutPressureHold: 48,

  minPersistenceHold: 48,
  minEntryQualityHold: 56,
  obContraAbs: 0.02,
};

export function buildMainExecutionDecision({
  coin,
  btc,
  regime,
  mode,
  coinProfile,
  positionState,
  scannerGate,
}) {
  const profile = coinProfile || buildCoinProfile({ systemType: "main", coin });

  // ✅ FIX: side altijd forceren vanuit scan mode (bull=LONG, bear=SHORT)
  profile.side = sideFromMode(mode);

  return buildExecutionDecisionCore({
    systemType: "main",
    coin,
    btc,
    regime,
    mode,
    coinProfile: profile,
    positionState,
    scannerGate,
    cfg: MAIN_ENGINE_CFG,
  });
}

export function buildMoonExecutionDecision({
  coin,
  btc,
  regime,
  mode,
  coinProfile,
  positionState,
  scannerGate,
}) {
  const profile = coinProfile || buildCoinProfile({ systemType: "moon", coin });

  // ✅ FIX: side altijd forceren vanuit scan mode (bull=LONG, bear=SHORT)
  profile.side = sideFromMode(mode);

  return buildExecutionDecisionCore({
    systemType: "moon",
    coin,
    btc,
    regime,
    mode,
    coinProfile: profile,
    positionState,
    scannerGate,
    cfg: MOON_ENGINE_CFG,
  });
}