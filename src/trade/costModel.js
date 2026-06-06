// ================= FILE: src/trade/costModel.js =================
//
// Turns gross price moves into fee+slippage-adjusted NET outcomes.
// Everything Analyze learns from must pass through here, otherwise the system
// ranks micro-families on paper profit and trades on net loss.
//
// Execution model: TAKER on both sides by default.
// A family that survives taker costs is more robust; if maker execution is added later,
// real net R can improve.

import { CONFIG } from '../config.js';
import { safeNumber, sideToTradeSide } from '../utils.js';

function costConfig() {
  return {
    takerFeePct: Math.max(0, safeNumber(CONFIG.cost?.takerFeePct, 0.0006)),
    makerFeePct: Math.max(0, safeNumber(CONFIG.cost?.makerFeePct, 0.0002)),
    marketImpactPct: Math.max(0, safeNumber(CONFIG.cost?.marketImpactPct, 0.0003)),
    fallbackSpreadPct: Math.max(0, safeNumber(CONFIG.cost?.fallbackSpreadPct, 0.0008))
  };
}

function normalizeLeg(leg) {
  const l = String(leg || '').toLowerCase();

  if (l === 'entry') return 'entry';
  if (l === 'exit') return 'exit';

  return 'unknown';
}

function spreadForCost(spreadPct) {
  const cfg = costConfig();
  const spread = safeNumber(spreadPct, 0);

  return Math.max(spread, cfg.fallbackSpreadPct);
}

function round4(value) {
  return Number(safeNumber(value, 0).toFixed(4));
}

function round6(value) {
  return Number(safeNumber(value, 0).toFixed(6));
}

export function modelFillPrice({
  midPrice,
  side,
  leg,
  spreadPct
} = {}) {
  const mid = safeNumber(midPrice, 0);

  if (mid <= 0) return 0;

  const tradeSide = sideToTradeSide(side);
  const normalizedLeg = normalizeLeg(leg);

  if (tradeSide === 'UNKNOWN' || normalizedLeg === 'unknown') {
    return mid;
  }

  const cfg = costConfig();
  const halfSpread = spreadForCost(spreadPct) / 2;
  const adverse = halfSpread + cfg.marketImpactPct;

  const buying =
    (tradeSide === 'LONG' && normalizedLeg === 'entry') ||
    (tradeSide === 'SHORT' && normalizedLeg === 'exit');

  return buying
    ? mid * (1 + adverse)
    : mid * (1 - adverse);
}

export function roundTripCostRatio(entrySpreadPct, exitSpreadPct) {
  const cfg = costConfig();

  const feeRoundTrip = cfg.takerFeePct * 2;

  const entrySlip =
    spreadForCost(entrySpreadPct) / 2 +
    cfg.marketImpactPct;

  const exitSlip =
    spreadForCost(exitSpreadPct) / 2 +
    cfg.marketImpactPct;

  return feeRoundTrip + entrySlip + exitSlip;
}

// Backwards-compatible alias.
// Returns decimal ratio, not percent.
export function roundTripCostPct(entrySpreadPct, exitSpreadPct) {
  return roundTripCostRatio(entrySpreadPct, exitSpreadPct);
}

export function applyCosts({
  grossMovePct,
  riskPct,
  entrySpreadPct,
  exitSpreadPct
} = {}) {
  const cfg = costConfig();

  const move = safeNumber(grossMovePct, 0);
  const risk = safeNumber(riskPct, 0);

  const feeRatio = cfg.takerFeePct * 2;
  const costRatio = roundTripCostRatio(entrySpreadPct, exitSpreadPct);
  const slippageRatio = Math.max(0, costRatio - feeRatio);

  const netMovePct = move - costRatio;

  const grossPnlPct = move * 100;
  const netPnlPct = netMovePct * 100;

  const grossR = risk > 0 ? move / risk : 0;
  const costR = risk > 0 ? costRatio / risk : 0;
  const netR = grossR - costR;

  return {
    feeRatio: round6(feeRatio),
    slippageRatio: round6(slippageRatio),
    costRatio: round6(costRatio),
    grossMovePct: round6(move),
    netMovePct: round6(netMovePct),
    breakEvenMovePct: round6(costRatio),

    feePct: round4(feeRatio * 100),
    slippagePct: round4(slippageRatio * 100),
    costPct: round4(costRatio * 100),
    grossPnlPct: round4(grossPnlPct),
    netPnlPct: round4(netPnlPct),

    grossR: round4(grossR),
    costR: round4(costR),
    netR: round4(netR)
  };
}