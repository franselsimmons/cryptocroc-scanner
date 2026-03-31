// ../lib/_trade_engine.js
// VolatilityForge Trade Engine (MAIN + MOON)
// - Scanner gate bepaalt of entries zijn toegestaan (OPEN/WATCH/IGNORE)
// - Anti-flip: hysteresis + minHoldCycles + weakHold limiter + emergency override
// - PnL: correct voor LONG en SHORT (side altijd vanuit mode geforceerd)
// - Truth PnL: netto PnL (fees + spread/slip) voor TP1/timeout/win-label
// - MAIN: TP1 -> partial exit -> SL naar BE+buffer (profit protection)
// - Weighted weakness: hard-fails vs soft-fails
// - Meta payload consistent voor Discord / analytics
//
// ✅ NEW (anti-flip voor entry):
// - "ENTRY TICKET" support: ALLOW_ENTRY wordt een sticky contract.
//   Scanner/UI kan dit pinnen zodat een coin niet meer "zomaar verdwijnt".
//   Engine kan nu:
//   - issueEntryTicket (bij ALLOW_ENTRY)
//   - PENDING_ENTRY teruggeven als ticket actief is, zelfs als gate even niet OPEN is
//   - CANCEL_ENTRY teruggeven als ticket hard breekt (spread explode / plan weg / ticket expired)

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
function clamp(x, lo, hi) {
  const v = n(x, lo);
  return Math.min(hi, Math.max(lo, v));
}

function sideFromMode(mode) {
  return String(mode || "bull").toLowerCase() === "bear" ? "SHORT" : "LONG";
}

// Correct PnL for LONG and SHORT (gross/theoretical)
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

// "Truth PnL" (fees + spread/slip buffer)
function netPnlPctForSide({ entryPrice, lastPrice, side, spreadPct, feePct, slipPct }) {
  const gross = pnlPctForSide({ entryPrice, lastPrice, side });
  const sp = Math.max(0, n(spreadPct, 0));
  const fees = Math.max(0, n(feePct, 0));
  const slip = Math.max(0, n(slipPct, 0));
  // Conservative: pay half-spread to get out + fees (in+out) + slippage buffer
  return gross - sp / 2 - fees - slip;
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
  const now = n(ps.now, Date.now());

  // IMPORTANT: "inPosition" moet door de caller (scan) correct gezet worden (openMap => true).
  const inPosition = !!ps.inPosition;
  const cyclesInTrade = n(ps.cyclesInTrade, 0);
  const minHoldCycles = Math.max(1, n(ps.minHoldCycles, cfg.minHoldCycles));
  const weakHoldCount = n(ps.weakHoldCount, 0);
  const maxWeakHoldCycles = Math.max(1, n(ps.maxWeakHoldCycles, cfg.maxWeakHoldCycles));

  // NEW: profit protection state
  const partialExitDone = !!ps.partialExitDone; // set by position manager after PARTIAL_EXIT executed
  const tp1TakenPct = clamp(ps.tp1TakenPct, 0, 1) || clamp(cfg.tp1TakePct, 0, 1); // fraction already taken

  // NEW: entry ticket state (sticky entry)
  const entryTicketActive = !!ps.entryTicketActive;
  const entryTicketSince = n(ps.entryTicketSince, 0);
  const entryTicketTtlMs = Math.max(60_000, n(ps.entryTicketTtlMs, cfg.entryTicketTtlMs));
  const entryTicketExpiresAt = entryTicketSince > 0 ? entryTicketSince + entryTicketTtlMs : 0;

  // Prices
  const last = n(coin?.price, profile.price);
  const plan = coin?.tradePlan || profile.tradePlan;

  const spreadPct = n(profile.ob?.spreadPct, 999);

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
    spreadPct,
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

    // profit protection state
    partialExitDone,
    tp1TakenPct,

    // entry ticket
    entryTicketActive,
    entryTicketSince,
    entryTicketTtlMs,
    entryTicketExpiresAt,
    now,
  };

  // --------------------------------------------------
  // NOT in position: ENTRY logic (sticky ticket)
  // --------------------------------------------------
  if (!inPosition) {
    // If we already have an active entry ticket, keep it alive unless "hard break".
    if (entryTicketActive) {
      const expired = entryTicketSince > 0 && now >= entryTicketExpiresAt;

      // Hard-break rules for cancelling a pinned entry
      const cancelBecause =
        !plan
          ? "missing_trade_plan"
          : expired
            ? "entry_ticket_expired"
            : cfg.cancelEntryOnBadSpread && spreadPct > cfg.entryTicketMaxSpreadPct
              ? "spread_too_wide_for_entry"
              : cfg.cancelEntryRequireBreakout && !breakoutOk(profile.breakout, cfg.entryTicketMinBreakoutPressure)
                ? "breakout_lost_for_entry"
                : null;

      if (cancelBecause) {
        return {
          action: "CANCEL_ENTRY",
          meta: {
            ...baseMeta,
            reason: cancelBecause,
            cancelEntry: true,
          },
        };
      }

      // Keep showing as pending even if gate temporarily drops.
      // Scanner/UI should keep it in the funnel until OPENED or CANCELLED.
      return {
        action: "PENDING_ENTRY",
        meta: {
          ...baseMeta,
          reason: "entry_ticket_active",
          keepPinned: true,
        },
      };
    }

    // No ticket yet: only allow when gate is OPEN
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

    if (cfg.blockBadSpread && isBadSpread(spreadPct, cfg.maxSpreadPct)) {
      return { action: "NO_TRADE", meta: { ...baseMeta, reason: "spread_too_wide" } };
    }

    if (cfg.requireBreakoutForEntry && !breakoutOk(profile.breakout, cfg.minBreakoutPressure)) {
      return { action: "NO_TRADE", meta: { ...baseMeta, reason: "breakout_not_ready" } };
    }

    // ✅ Issue ticket signal: caller should persist entryTicketActive=true + entryTicketSince=now
    return {
      action: "ALLOW_ENTRY",
      meta: {
        ...baseMeta,
        reason: "gate_open_allow_entry",
        issueEntryTicket: true,
        entryTicketTtlMs,
      },
    };
  }

  // --------------------------------------------------
  // In position: HOLD / WEAK_HOLD / PARTIAL_EXIT / EXIT
  // --------------------------------------------------

  // PnL needs entry price.
  // Prefer coin.entryPrice (position manager), fallback to plan.entry.
  const entryPrice = n(coin?.entryPrice, n(plan?.entry, 0));
  const grossPnlPct = pnlPctForSide({ entryPrice, lastPrice: last, side: baseMeta.side });

  // Truth PnL (used for TP1/timeout/win labeling)
  const feePct = n(ps.feePct, cfg.feePct); // allow override per exchange/account
  const slipPct = n(ps.slipPct, cfg.slipPct); // conservative buffer
  const netPnlPct = netPnlPctForSide({
    entryPrice,
    lastPrice: last,
    side: baseMeta.side,
    spreadPct,
    feePct,
    slipPct,
  });

  // --------------------------------------------------
  // 0) Emergency override: ignore minHoldCycles
  // --------------------------------------------------
  if (netPnlPct <= -Math.abs(cfg.emergencyExitNetPct)) {
    return {
      action: "EXIT",
      meta: {
        ...baseMeta,
        pnlPct: grossPnlPct,
        netPnlPct,
        reason: "emergency_exit",
        exitReason: "emergency",
      },
    };
  }

  // --------------------------------------------------
  // 1) MAIN profit protection: TP1 -> PARTIAL_EXIT -> BE+buffer
  // --------------------------------------------------
  if (systemType === "main" && !partialExitDone && netPnlPct >= cfg.tp1NetPct) {
    return {
      action: "PARTIAL_EXIT",
      meta: {
        ...baseMeta,
        pnlPct: grossPnlPct,
        netPnlPct,
        reason: "tp1_reached",
        tp1TakePct: cfg.tp1TakePct, // execution layer uses this to close partial
      },
    };
  }

  // --------------------------------------------------
  // 2) Stop/TP hit check (after TP1, SL becomes BE+buffer)
  // --------------------------------------------------
  const bePrice =
    entryPrice > 0 ? entryPrice * (1 + Math.abs(cfg.beBufferPct) / 100) : entryPrice;

  const effectiveSl = partialExitDone ? bePrice : n(plan?.sl, 0);

  const stopTp = plan
    ? hitStopOrTp({
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
      meta: {
        ...baseMeta,
        pnlPct: grossPnlPct,
        netPnlPct,
        reason: "take_profit",
        exitReason: "tp",
      },
    };
  }

  // --------------------------------------------------
  // Hard anti-flip: minimum hold cycles before any soft exits
  // (still applies, but emergency already handled above)
  // --------------------------------------------------
  if (cyclesInTrade < minHoldCycles) {
    return {
      action: "HOLD",
      meta: { ...baseMeta, pnlPct: grossPnlPct, netPnlPct, reason: "min_hold_cycles" },
    };
  }

  // --------------------------------------------------
  // Weighted weakness: hard fails vs soft fails
  // --------------------------------------------------
  const obScore = n(profile.ob?.score, 0);
  const psScore = n(profile.persistenceScore, 0);
  const eqScore = n(profile.entryQuality, 0);

  const breakoutStillOk = breakoutOk(profile.breakout, cfg.minBreakoutPressureHold);

  const obAgainst =
    baseMeta.side === "LONG" ? obScore <= -cfg.obContraAbs : obScore >= cfg.obContraAbs;

  const extremeObAgainst =
    baseMeta.side === "LONG"
      ? obScore <= -cfg.obContraExtremeAbs
      : obScore >= cfg.obContraExtremeAbs;

  // Hard fails first
  if (cfg.exitOnExtremeObAgainst && extremeObAgainst) {
    return {
      action: "EXIT",
      meta: {
        ...baseMeta,
        pnlPct: grossPnlPct,
        netPnlPct,
        reason: "orderbook_extreme_against",
        exitReason: "ob_extreme",
        obScore,
      },
    };
  }

  if (cfg.exitOnSpreadSpikeInTrade && spreadPct > cfg.maxSpreadPctInTrade) {
    return {
      action: "EXIT",
      meta: {
        ...baseMeta,
        pnlPct: grossPnlPct,
        netPnlPct,
        reason: "spread_spike_exit",
        exitReason: "spread_spike",
        spreadPct,
      },
    };
  }

  // Soft weakness scoring
  const weakSignals =
    (breakoutStillOk ? 0 : 1) +
    (psScore < cfg.minPersistenceHold ? 1 : 0) +
    (eqScore < cfg.minEntryQualityHold ? 1 : 0) +
    (obAgainst ? 1 : 0);

  if (weakSignals === 0) {
    return {
      action: "HOLD",
      meta: { ...baseMeta, pnlPct: grossPnlPct, netPnlPct, reason: "healthy_hold" },
    };
  }

  if (weakSignals <= 2 && weakHoldCount < maxWeakHoldCycles) {
    return {
      action: "WEAK_HOLD",
      meta: {
        ...baseMeta,
        pnlPct: grossPnlPct,
        netPnlPct,
        reason: "weak_but_not_break",
        weakSignals,
        weakHoldCount: weakHoldCount + 1,
      },
    };
  }

  // --------------------------------------------------
  // Timeout exit (use NET pnl so we don't "exit for a net loss")
  // --------------------------------------------------
  if (cyclesInTrade >= cfg.timeoutBars && netPnlPct < cfg.timeoutMinNetPnlPct) {
    return {
      action: "EXIT",
      meta: {
        ...baseMeta,
        pnlPct: grossPnlPct,
        netPnlPct,
        reason: "timeout_exit",
        exitReason: "timeout",
      },
    };
  }

  // Thesis break exit
  return {
    action: "EXIT",
    meta: {
      ...baseMeta,
      pnlPct: grossPnlPct,
      netPnlPct,
      reason: "thesis_break",
      exitReason: "thesis_break",
    },
  };
}

// ------------------------------------------------------
// MAIN + MOON configs
// ------------------------------------------------------
const MAIN_ENGINE_CFG = {
  minHoldCycles: 5,
  maxWeakHoldCycles: 2,
  timeoutBars: 12,

  // Use NET PnL for timeout decisions
  timeoutMinNetPnlPct: 0.05, // small positive after costs; tweak if needed

  // sanity
  blockBadSpread: true,
  maxSpreadPct: 0.9,
  maxSpreadPctInTrade: 1.2,
  exitOnSpreadSpikeInTrade: true,

  // breakout gating
  requireBreakoutForEntry: false,
  minBreakoutPressure: 52,
  minBreakoutPressureHold: 48,

  // thesis thresholds
  minPersistenceHold: 50,
  minEntryQualityHold: 58,
  obContraAbs: 0.02,

  // Weighted / hard fail
  exitOnExtremeObAgainst: true,
  obContraExtremeAbs: 0.04,

  // Emergency override (NET)
  emergencyExitNetPct: 2.2, // exit if net <= -2.2%

  // Truth PnL assumptions (defaults; can be overridden by positionState)
  feePct: 0.20, // chosen: 0.20% (in+out)
  slipPct: 0.05, // buffer

  // MAIN TP1 -> BE+
  tp1NetPct: 0.60, // TP1 trigger on NET
  tp1TakePct: 0.60, // chosen: 60% partial
  beBufferPct: 0.15, // chosen: BE = entry + 0.15%

  // ✅ ENTRY TICKET (sticky ALLOW_ENTRY)
  entryTicketTtlMs: 60 * 60 * 1000, // 60 min pinned unless opened/cancelled
  cancelEntryOnBadSpread: true,
  entryTicketMaxSpreadPct: 1.25, // if spread explodes after allow_entry → cancel
  cancelEntryRequireBreakout: false, // keep false unless je echt breakout als must wilt
  entryTicketMinBreakoutPressure: 52,
};

const MOON_ENGINE_CFG = {
  minHoldCycles: 6,
  maxWeakHoldCycles: 3,
  timeoutBars: 24,

  timeoutMinNetPnlPct: 0.0, // runners can breathe; timeout only if truly dead

  blockBadSpread: true,
  maxSpreadPct: 1.1,
  maxSpreadPctInTrade: 1.6,
  exitOnSpreadSpikeInTrade: true,

  requireBreakoutForEntry: false,
  minBreakoutPressure: 52,
  minBreakoutPressureHold: 48,

  minPersistenceHold: 48,
  minEntryQualityHold: 56,
  obContraAbs: 0.02,

  exitOnExtremeObAgainst: true,
  obContraExtremeAbs: 0.05,

  emergencyExitNetPct: 3.0, // moon gets more room but still has a schietstoel

  feePct: 0.20, // chosen: 0.20% (in+out)
  slipPct: 0.05, // buffer

  // Moon: no TP1 by default (runner logic)
  tp1NetPct: 999,
  tp1TakePct: 0,
  beBufferPct: 0.15,

  // ✅ ENTRY TICKET (sticky ALLOW_ENTRY)
  entryTicketTtlMs: 90 * 60 * 1000, // 90 min pinned for moon (meer ruimte)
  cancelEntryOnBadSpread: true,
  entryTicketMaxSpreadPct: 1.6,
  cancelEntryRequireBreakout: false,
  entryTicketMinBreakoutPressure: 52,
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