// ================= FILE: src/trade/costModel.js =================
//
// Turns gross price moves into fee+slippage-adjusted NET outcomes.
// Everything Analyze learns from must pass through here, otherwise the system
// ranks micro-families on paper profit and trades on net loss.
//
// Execution model: TAKER on both sides by default.
// Long-only: explicit SHORT/BEAR/SELL input is rejected and never produces a
// learnable net outcome.

import { CONFIG } from '../config.js';
import { safeNumber, sideToTradeSide } from '../utils.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

const COST_MODEL_VERSION = 'LONG_TAKER_NET_COST_V2';
const DEFAULT_SOURCE = 'VIRTUAL';

const SHORT_TOKENS = new Set([
  'SHORT',
  'BEAR',
  'BEARISH',
  'SELL',
  'ASK',
  'DOWN',
  'DOWNSIDE',
  'RED'
]);

const LONG_TOKENS = new Set([
  'LONG',
  'BULL',
  'BULLISH',
  'BUY',
  'BID',
  'UP',
  'UPSIDE',
  'GREEN'
]);

function costConfig() {
  return {
    takerFeePct: Math.max(0, safeNumber(CONFIG.cost?.takerFeePct, 0.0006)),
    makerFeePct: Math.max(0, safeNumber(CONFIG.cost?.makerFeePct, 0.0002)),
    marketImpactPct: Math.max(0, safeNumber(CONFIG.cost?.marketImpactPct, 0.0003)),
    fallbackSpreadPct: Math.max(0, safeNumber(CONFIG.cost?.fallbackSpreadPct, 0.0008)),
    maxSpreadPct: Math.max(0, safeNumber(CONFIG.cost?.maxSpreadPct, 0.05))
  };
}

function cleanSideText(value = '') {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replaceAll('SHORT_DISABLED', '')
    .replaceAll('SHORTDISABLED', '')
    .replaceAll('BLOCK_SHORT', '')
    .replaceAll('SHORT_ENABLED_FALSE', '')
    .replaceAll('SHORT_ONLY_FALSE', '')
    .replaceAll('LONG_DISABLED_FALSE', '')
    .replaceAll('LONG_ONLY_MODE', 'LONG')
    .replaceAll('LONG_ONLY', 'LONG')
    .replaceAll('LONG-ONLY', 'LONG');
}

function normalizeTradeSide(value = TARGET_TRADE_SIDE) {
  const raw = cleanSideText(value);

  if (!raw) return TARGET_TRADE_SIDE;

  const direct = sideToTradeSide(raw);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  if (LONG_TOKENS.has(raw)) return TARGET_TRADE_SIDE;
  if (SHORT_TOKENS.has(raw)) return OPPOSITE_TRADE_SIDE;

  const normalized = raw
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  const longHit = (
    normalized.includes('MICRO_LONG_') ||
    normalized.includes('TRADESIDE_LONG') ||
    normalized.includes('TRADE_SIDE_LONG') ||
    normalized.includes('POSITION_SIDE_LONG') ||
    normalized.includes('POSITIONSIDE_LONG') ||
    normalized.includes('SIDE_LONG') ||
    normalized.includes('SIDE_BULL') ||
    normalized.includes('DIRECTION_LONG') ||
    normalized.includes('DIRECTION_BULL') ||
    normalized.includes('SIDE_BUY') ||
    normalized.includes('DIRECTION_BUY') ||
    normalized.startsWith('LONG_') ||
    normalized.includes('_LONG_') ||
    normalized.endsWith('_LONG') ||
    normalized.startsWith('BULL_') ||
    normalized.includes('_BULL_') ||
    normalized.endsWith('_BULL') ||
    normalized.startsWith('BUY_') ||
    normalized.includes('_BUY_') ||
    normalized.endsWith('_BUY')
  );

  const shortHit = (
    normalized.includes('MICRO_SHORT_') ||
    normalized.includes('TRADESIDE_SHORT') ||
    normalized.includes('TRADE_SIDE_SHORT') ||
    normalized.includes('POSITION_SIDE_SHORT') ||
    normalized.includes('POSITIONSIDE_SHORT') ||
    normalized.includes('SIDE_SHORT') ||
    normalized.includes('SIDE_BEAR') ||
    normalized.includes('DIRECTION_SHORT') ||
    normalized.includes('DIRECTION_BEAR') ||
    normalized.includes('SIDE_SELL') ||
    normalized.includes('DIRECTION_SELL') ||
    normalized.startsWith('SHORT_') ||
    normalized.includes('_SHORT_') ||
    normalized.endsWith('_SHORT') ||
    normalized.startsWith('BEAR_') ||
    normalized.includes('_BEAR_') ||
    normalized.endsWith('_BEAR') ||
    normalized.startsWith('SELL_') ||
    normalized.includes('_SELL_') ||
    normalized.endsWith('_SELL')
  );

  if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;
  if (longHit && !shortHit) return TARGET_TRADE_SIDE;

  if (longHit) return TARGET_TRADE_SIDE;
  if (shortHit) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function isLongSide(side = TARGET_TRADE_SIDE) {
  return normalizeTradeSide(side) === TARGET_TRADE_SIDE;
}

function isShortSide(side = TARGET_TRADE_SIDE) {
  return normalizeTradeSide(side) === OPPOSITE_TRADE_SIDE;
}

function normalizeLeg(leg) {
  const l = String(leg || '').toLowerCase();

  if (l === 'entry') return 'entry';
  if (l === 'exit') return 'exit';

  return 'unknown';
}

function clampSpread(spreadPct) {
  const cfg = costConfig();
  const spread = Math.max(0, safeNumber(spreadPct, 0));

  if (cfg.maxSpreadPct <= 0) return spread;

  return Math.min(spread, cfg.maxSpreadPct);
}

function spreadForCost(spreadPct) {
  const cfg = costConfig();
  const spread = clampSpread(spreadPct);

  return Math.max(spread, cfg.fallbackSpreadPct);
}

function round4(value) {
  return Number(safeNumber(value, 0).toFixed(4));
}

function round6(value) {
  return Number(safeNumber(value, 0).toFixed(6));
}

function baseLongOnlyMeta({
  skipped = false,
  reason = null
} = {}) {
  return {
    source: DEFAULT_SOURCE,

    costModel: COST_MODEL_VERSION,
    costModelApplied: !skipped,
    netCostModelApplied: !skipped,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: true,
    outcomeSource: DEFAULT_SOURCE,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    noRealOrders: true,
    noExchangeOrders: true,

    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    skipped,
    reason
  };
}

function emptyCostResult(reason = 'NON_LONG_COST_MODEL_SKIPPED') {
  return {
    ...baseLongOnlyMeta({
      skipped: true,
      reason
    }),

    feeRatio: 0,
    slippageRatio: 0,
    costRatio: 0,

    grossMovePct: 0,
    netMovePct: 0,
    breakEvenMovePct: 0,

    feePct: 0,
    slippagePct: 0,
    costPct: 0,

    grossPnlPct: 0,
    netPnlPct: 0,

    grossR: 0,
    costR: 0,
    netR: 0
  };
}

export function modelFillPrice({
  midPrice,
  side = TARGET_TRADE_SIDE,
  leg,
  spreadPct
} = {}) {
  const mid = safeNumber(midPrice, 0);

  if (mid <= 0) return 0;

  if (isShortSide(side)) return 0;
  if (!isLongSide(side)) return 0;

  const normalizedLeg = normalizeLeg(leg);

  if (normalizedLeg === 'unknown') {
    return mid;
  }

  const cfg = costConfig();
  const halfSpread = spreadForCost(spreadPct) / 2;
  const adverse = halfSpread + cfg.marketImpactPct;

  const buyingEntry = normalizedLeg === 'entry';

  return buyingEntry
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
  exitSpreadPct,
  side = TARGET_TRADE_SIDE,
  tradeSide = side,
  source = DEFAULT_SOURCE
} = {}) {
  const normalizedSide = normalizeTradeSide(tradeSide || side);

  if (normalizedSide === OPPOSITE_TRADE_SIDE) {
    return emptyCostResult('SHORT_DISABLED_LONG_ONLY_COST_MODEL');
  }

  if (normalizedSide !== TARGET_TRADE_SIDE) {
    return emptyCostResult('UNKNOWN_OR_NON_LONG_COST_MODEL_SKIPPED');
  }

  const cfg = costConfig();

  const move = safeNumber(grossMovePct, 0);
  const risk = Math.max(0, safeNumber(riskPct, 0));

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
    ...baseLongOnlyMeta(),

    source: String(source || DEFAULT_SOURCE).trim().toUpperCase() || DEFAULT_SOURCE,

    takerFeePct: round6(cfg.takerFeePct),
    makerFeePct: round6(cfg.makerFeePct),
    marketImpactPct: round6(cfg.marketImpactPct),
    fallbackSpreadPct: round6(cfg.fallbackSpreadPct),

    entrySpreadPct: round6(spreadForCost(entrySpreadPct)),
    exitSpreadPct: round6(spreadForCost(exitSpreadPct)),

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
    rawR: round4(grossR),
    realizedGrossR: round4(grossR),

    costR: round4(costR),
    avgCostR: round4(costR),

    netR: round4(netR),
    exitR: round4(netR),
    realizedNetR: round4(netR),
    realizedR: round4(netR),
    r: round4(netR),

    win: netR > 0,
    loss: netR < 0,
    flat: netR === 0,
    isWin: netR > 0
  };
}