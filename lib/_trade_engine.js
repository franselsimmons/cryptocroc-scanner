import {
  hitStopOrTpLocal,
  entryTriggerOk,
  hardBreakDetected,
} from "./_trade_engine_core.js";

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
function clamp(x, lo, hi) {
  const v = n(x, lo);
  return Math.min(hi, Math.max(lo, v));
}

function sideFromMode(mode) {
  return String(mode || "bull").toLowerCase() === "bear" ? "SHORT" : "LONG";
}

function pnlPctForSide({ entryPrice, lastPrice, side }) {
  const e = n(entryPrice, 0);
  const p = n(lastPrice, 0);
  if (!(e > 0 && p > 0)) return 0;

  const s = up(side);
  if (s === "SHORT") return ((e - p) / e) * 100;
  return ((p - e) / e) * 100;
}

function netPnlPctForSide({ entryPrice, lastPrice, side, spreadPct, feePct, slipPct }) {
  const gross = pnlPctForSide({ entryPrice, lastPrice, side });
  const sp = Math.max(0, n(spreadPct, 0));
  const fees = Math.max(0, n(feePct, 0));
  const slip = Math.max(0, n(slipPct, 0));
  return gross - sp / 2 - fees - slip;
}

function isBadSpread(spreadPct, maxPct) {
  const sp = n(spreadPct, 999);
  return sp > maxPct;
}

// ------------------------------------------------------
// Gate normalizer
// ------------------------------------------------------
function normalizeGate(gateLike) {
  const g = up(gateLike);

  if (g === "OPEN" || g === "WATCH" || g === "IGNORE") return g;

  if (g === "ENTRY" || g === "ENTRYREADY" || g === "ENTRY_READY") return "OPEN";
  if (g === "TRADE_READY" || g === "TRADEREADY" || g === "READY") return "WATCH";

  if (g === "ALMOST") return "IGNORE";
  if (g === "BUILDUP" || g === "RADAR") return "IGNORE";

  return "IGNORE";
}

// ------------------------------------------------------
// Execution score
// ------------------------------------------------------
function computeExecutionScore(profile, gate) {
  const pcs = n(profile?.perfectCandidateScore, NaN);
  const eq = n(profile?.entryQuality, NaN);
  const conf = n(profile?.confidence, NaN);

  let base = 0;
  if (Number.isFinite(pcs)) base = pcs;
  else if (Number.isFinite(eq)) base = eq;
  else if (Number.isFinite(conf)) base = conf;

  const g = normalizeGate(gate);
  if (g === "OPEN") base += 8;
  else if (g === "WATCH") base += 3;

  const sp = n(profile?.ob?.spreadPct, 999);
  if (sp > 2.0) base -= 6;
  else if (sp > 1.2) base -= 3;

  return Math.max(0, Math.round(base));
}

// ------------------------------------------------------
// Build profile
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

    confidence: n(c.confidence, 0),
    entryQuality: n(c.entryQuality, 0),
    persistenceScore: n(c.persistenceScore, 0),
    qualityScore: n(c.qualityScore, 0),
    liquidityScore: n(c.liquidityScore, 0),
    timingScore: n(c.timingScore, 0),
    marketScore: n(c.marketScore, 0),
    btcAlignmentScore: n(c.btcAlignmentScore, 0),
    perfectCandidateScore: n(c.perfectCandidateScore, 0),

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

    thresholds: {
      depthFloorUsd: n(th.depthFloorUsd, 0),
      depthOk: !!th.depthOk,
    },

    breakout: {
      ready: !!br.ready,
      pressure: n(br.pressure, 0),
      breakoutPct: n(br.breakoutPct, 0),
    },
    compression: {
      isCompressed: !!comp.isCompressed,
      flatPct: n(comp.flatPct, 0),
    },

    tradePlan: c.tradePlan || null,

    tradeCandidate: !!c.tradeCandidate,
    superScannerCoin: !!c.superScannerCoin,
    scannerOnly: !!c.scannerOnly,

    scannerGate: up(c.tradeDeskStatus || c.scannerGate || "IGNORE"),
  };
}

// Helper for breakout check in position logic
function breakoutOk(breakout, minPressure) {
  return breakout?.ready === true && (breakout?.pressure || 0) >= minPressure;
}

// ------------------------------------------------------
// Core execution decision
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
  const gate = normalizeGate(scannerGate || coin?.tradeDeskStatus || coin?.scannerGate || "IGNORE");
  const profile = coinProfile || buildCoinProfile({ systemType, coin });

  const ps = positionState || {};
  const now = n(ps.now, Date.now());

  const inPosition = !!ps.inPosition;
  const cyclesInTrade = n(ps.cyclesInTrade, 0);
  const minHoldCycles = Math.max(1, n(ps.minHoldCycles, cfg.minHoldCycles));

  const partialExitDone = !!ps.partialExitDone;
  const tp1TakenPct = clamp(ps.tp1TakenPct, 0, 1) || clamp(cfg.tp1TakePct, 0, 1);

  const entryTicketActive = !!ps.entryTicketActive;
  const entryTicketSince = n(ps.entryTicketSince, 0);
  const entryTicketTtlMs = Math.max(60_000, n(ps.entryTicketTtlMs, cfg.entryTicketTtlMs));
  const entryTicketExpiresAt = entryTicketSince > 0 ? entryTicketSince + entryTicketTtlMs : 0;

  const last = n(coin?.price, profile.price);
  const plan = coin?.tradePlan || profile.tradePlan;
  const spreadPct = n(profile.ob?.spreadPct, 999);
  const obScore = n(profile.ob?.score, 0);

  const baseMeta = {
    systemType,
    gate,
    mode: String(mode || "bull"),
    side: up(profile.side || sideFromMode(mode)),
    regime: String(regime || ""),
    btcState: String(btc?.state || "NEUTRAL").toUpperCase(),

    symbol: profile.symbol,
    stage: profile.stage,
    eliteType: profile.eliteType,
    stageWhy: profile.stageWhy,

    price: last,

    entryQuality: profile.entryQuality,
    persistenceScore: profile.persistenceScore,
    qualityScore: profile.qualityScore,
    liquidityScore: profile.liquidityScore,
    timingScore: profile.timingScore,
    marketScore: profile.marketScore,
    perfectCandidateScore: profile.perfectCandidateScore,

    breakoutReady: !!profile.breakout?.ready,
    breakoutPressure: n(profile.breakout?.pressure, 0),
    breakoutPct: n(profile.breakout?.breakoutPct, 0),

    spreadPct,
    depthUsd: n(profile.ob?.depthMinUsd1p, 0),
    obScore,

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

    inPosition,
    cyclesInTrade,
    minHoldCycles,

    partialExitDone,
    tp1TakenPct,

    entryTicketActive,
    entryTicketSince,
    entryTicketTtlMs,
    entryTicketExpiresAt,
    now,
  };

  // --------------------------------------------------
  // ENTRY logic
  // WATCH -> ARM_ENTRY -> ALLOW_ENTRY
  // --------------------------------------------------
  if (!inPosition) {
    if (entryTicketActive) {
      const expired = entryTicketSince > 0 && now >= entryTicketExpiresAt;

      const cancelBecause =
        !plan
          ? "missing_trade_plan"
          : expired
            ? "entry_ticket_expired"
            : cfg.cancelEntryOnBadSpread && spreadPct > cfg.entryTicketMaxSpreadPct
              ? "spread_too_wide_for_entry"
              : null;

      if (cancelBecause) {
        return {
          action: "CANCEL_ENTRY",
          score: computeExecutionScore(profile, gate),
          meta: {
            ...baseMeta,
            reason: cancelBecause,
            cancelEntry: true,
          },
        };
      }

      const triggerReady = entryTriggerOk({
        side: baseMeta.side,
        price: last,
        entry: n(plan?.entry, 0),
        spreadPct,
        maxSpreadPct: cfg.entryTicketMaxSpreadPct,
        obScore,
        minObScoreAbs: cfg.entryMinObScoreAbs,
        breakout: profile.breakout,
        requireBreakout: cfg.requireBreakoutForEntry,
        minBreakoutPressure: cfg.minBreakoutPressure,
        maxEntryDistancePct: cfg.maxEntryDistancePct,
      });

      if (!triggerReady) {
        return {
          action: "PENDING_ENTRY",
          score: computeExecutionScore(profile, gate),
          meta: {
            ...baseMeta,
            reason: "waiting_entry_trigger",
            keepPinned: true,
          },
        };
      }

      return {
        action: "ALLOW_ENTRY",
        score: computeExecutionScore(profile, gate),
        meta: {
          ...baseMeta,
          reason: "watch_trigger_confirmed",
        },
      };
    }

    if (gate === "WATCH") {
      if (!plan) {
        return {
          action: "WATCH",
          score: computeExecutionScore(profile, gate),
          meta: { ...baseMeta, reason: "watch_missing_trade_plan" },
        };
      }

      if (cfg.blockBadSpread && isBadSpread(spreadPct, cfg.watchMaxSpreadPct)) {
        return {
          action: "WATCH",
          score: computeExecutionScore(profile, gate),
          meta: { ...baseMeta, reason: "watch_spread_too_wide" },
        };
      }

      return {
        action: "ARM_ENTRY",
        score: computeExecutionScore(profile, gate),
        meta: {
          ...baseMeta,
          reason: "watch_ready_arm_entry",
          issueEntryTicket: true,
          entryTicketTtlMs,
        },
      };
    }

    if (gate !== "OPEN") {
      return {
        action: "NO_TRADE",
        score: computeExecutionScore(profile, gate),
        meta: { ...baseMeta, reason: "gate_not_open" },
      };
    }

    if (!plan) {
      return {
        action: "NO_TRADE",
        score: computeExecutionScore(profile, gate),
        meta: { ...baseMeta, reason: "missing_trade_plan" },
      };
    }

    if (cfg.blockBadSpread && isBadSpread(spreadPct, cfg.maxSpreadPct)) {
      return {
        action: "NO_TRADE",
        score: computeExecutionScore(profile, gate),
        meta: { ...baseMeta, reason: "spread_too_wide" },
      };
    }

    return {
      action: "ALLOW_ENTRY",
      score: computeExecutionScore(profile, gate),
      meta: {
        ...baseMeta,
        reason: "scanner_open_allow_entry",
        issueEntryTicket: true,
        entryTicketTtlMs,
      },
    };
  }

  // --------------------------------------------------
  // POSITION logic
  // HOLD until TP / SL / SELL / timeout
  // --------------------------------------------------
  const entryPrice = n(coin?.entryPrice, n(plan?.entry, 0));
  const grossPnlPct = pnlPctForSide({ entryPrice, lastPrice: last, side: baseMeta.side });

  const feePct = n(ps.feePct, cfg.feePct);
  const slipPct = n(ps.slipPct, cfg.slipPct);
  const netPnlPct = netPnlPctForSide({
    entryPrice,
    lastPrice: last,
    side: baseMeta.side,
    spreadPct,
    feePct,
    slipPct,
  });

  if (netPnlPct <= -Math.abs(cfg.emergencyExitNetPct)) {
    return {
      action: "EXIT",
      score: computeExecutionScore(profile, gate),
      meta: {
        ...baseMeta,
        pnlPct: grossPnlPct,
        netPnlPct,
        reason: "emergency_exit",
        exitReason: "emergency",
      },
    };
  }

  if (systemType === "main" && !partialExitDone && netPnlPct >= cfg.tp1NetPct) {
    return {
      action: "PARTIAL_EXIT",
      score: computeExecutionScore(profile, gate),
      meta: {
        ...baseMeta,
        pnlPct: grossPnlPct,
        netPnlPct,
        reason: "tp1_reached",
        tp1TakePct: cfg.tp1TakePct,
      },
    };
  }

  const bePrice =
    entryPrice > 0 ? entryPrice * (1 + Math.abs(cfg.beBufferPct) / 100) : entryPrice;

  const effectiveSl = partialExitDone ? bePrice : n(plan?.sl, 0);

  const stopTp = plan
    ? hitStopOrTpLocal({
        side: baseMeta.side,
        price: last,
        entry: n(plan.entry, entryPrice),
        sl: effectiveSl,
        tp: n(plan.tp, 0),
      })
    : null;

  if (stopTp?.hit === "SL") {
    return {
      action: "EXIT",
      score: computeExecutionScore(profile, gate),
      meta: {
        ...baseMeta,
        pnlPct: grossPnlPct,
        netPnlPct,
        reason: partialExitDone ? "breakeven_protect" : "stop_loss",
        exitReason: partialExitDone ? "be" : "sl",
        effectiveSl,
        bePrice,
      },
    };
  }

  if (stopTp?.hit === "TP") {
    return {
      action: "EXIT",
      score: computeExecutionScore(profile, gate),
      meta: {
        ...baseMeta,
        pnlPct: grossPnlPct,
        netPnlPct,
        reason: "take_profit",
        exitReason: "tp",
      },
    };
  }

  if (cyclesInTrade < minHoldCycles) {
    return {
      action: "HOLD",
      score: computeExecutionScore(profile, gate),
      meta: { ...baseMeta, pnlPct: grossPnlPct, netPnlPct, reason: "min_hold_cycles" },
    };
  }

  const hardBreak = hardBreakDetected({
    side: baseMeta.side,
    obScore,
    obContraExtremeAbs: cfg.obContraExtremeAbs,
    spreadPct,
    maxSpreadPctInTrade: cfg.maxSpreadPctInTrade,
  });

  if (hardBreak.hit) {
    return {
      action: "EXIT",
      score: computeExecutionScore(profile, gate),
      meta: {
        ...baseMeta,
        pnlPct: grossPnlPct,
        netPnlPct,
        reason: hardBreak.reason === "spread_spike" ? "spread_spike_exit" : "sell_break",
        exitReason: hardBreak.reason === "spread_spike" ? "spread_spike" : "sell_break",
        obScore,
        spreadPct,
      },
    };
  }

  // New hard break logic for Moon (breakout lost + mild OB against + net loss)
  const breakoutLost = !breakoutOk(profile.breakout, cfg.minBreakoutPressure || 52);
  const mildObAgainst =
    baseMeta.side === "LONG"
      ? obScore <= -(cfg.obContraAbs || 0.03)
      : obScore >= (cfg.obContraAbs || 0.03);

  if (
    breakoutLost &&
    mildObAgainst &&
    netPnlPct <= n(cfg.hardBreakMaxNetLossPct, -0.9)
  ) {
    return {
      action: "EXIT",
      score: computeExecutionScore(profile, gate),
      meta: {
        ...baseMeta,
        pnlPct: grossPnlPct,
        netPnlPct,
        reason: "sell_break",
        exitReason: "sell_break",
        breakoutLost: true,
        obScore,
      },
    };
  }

  if (cyclesInTrade >= cfg.timeoutBars && netPnlPct < cfg.timeoutMinNetPnlPct) {
    return {
      action: "EXIT",
      score: computeExecutionScore(profile, gate),
      meta: {
        ...baseMeta,
        pnlPct: grossPnlPct,
        netPnlPct,
        reason: "timeout_exit",
        exitReason: "timeout",
      },
    };
  }

  return {
    action: "HOLD",
    score: computeExecutionScore(profile, gate),
    meta: {
      ...baseMeta,
      pnlPct: grossPnlPct,
      netPnlPct,
      reason: "hold_until_tp_or_sl",
    },
  };
}

// ------------------------------------------------------
// Configs
// ------------------------------------------------------
const MAIN_ENGINE_CFG = {
  minHoldCycles: 5,
  timeoutBars: 12,

  timeoutMinNetPnlPct: 0.05,

  blockBadSpread: true,
  maxSpreadPct: 0.9,
  watchMaxSpreadPct: 1.0,
  maxSpreadPctInTrade: 1.2,

  requireBreakoutForEntry: false,
  minBreakoutPressure: 52,
  maxEntryDistancePct: 1.0,
  entryMinObScoreAbs: 0.0,

  obContraExtremeAbs: 0.04,
  obContraAbs: 0.03, // used for new hard break

  emergencyExitNetPct: 2.2,

  feePct: 0.20,
  slipPct: 0.05,

  tp1NetPct: 0.60,
  tp1TakePct: 0.60,
  beBufferPct: 0.15,

  entryTicketTtlMs: 60 * 60 * 1000,
  cancelEntryOnBadSpread: true,
  entryTicketMaxSpreadPct: 1.25,
};

const MOON_ENGINE_CFG = {
  minHoldCycles: 6,
  timeoutBars: 16,          // was 24
  timeoutMinNetPnlPct: 0.35, // was 0.0

  blockBadSpread: true,
  maxSpreadPct: 1.1,
  watchMaxSpreadPct: 1.10,   // was 1.35
  maxSpreadPctInTrade: 1.35, // was 1.6

  requireBreakoutForEntry: false,
  minBreakoutPressure: 52,
  maxEntryDistancePct: 1.25,
  entryMinObScoreAbs: 0.0,

  obContraExtremeAbs: 0.05,
  obContraAbs: 0.03,

  emergencyExitNetPct: 2.4,   // was 3.0
  hardBreakMaxNetLossPct: -0.9, // new

  feePct: 0.20,
  slipPct: 0.05,

  tp1NetPct: 999,
  tp1TakePct: 0,
  beBufferPct: 0.15,

  entryTicketTtlMs: 90 * 60 * 1000,
  cancelEntryOnBadSpread: true,
  entryTicketMaxSpreadPct: 1.6,
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