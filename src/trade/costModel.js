// ================= FILE: src/trade/costModel.js =================
//
// LONG-only cost model.
//
// Doel:
// - Gross LONG price moves omzetten naar fee+slippage-adjusted NET outcomes.
// - Analyze/scoring leert uitsluitend op netR na kosten.
// - avgCostR wordt gevoed met echte costR.
// - wins/losses/flats worden bepaald op netR.
// - Explicit SHORT/BEAR/SELL input wordt geweigerd en produceert geen learnable outcome.
//
// Architectuur:
// - Learning blijft breed.
// - Selection wordt later adaptief.
// - Discord wordt later streng.
// - CurrentFit is zacht en blokkeert geen virtual/shadow learning.

import { CONFIG } from '../config.js';
import { safeNumber, sideToTradeSide } from '../utils.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const TARGET_SCANNER_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = TRUE_MICRO_SCHEMA;
const LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_V1';

const COST_MODEL_VERSION = 'LONG_TAKER_NET_COST_MEASUREMENT_FIX_V4';
const MEASUREMENT_FIX_VERSION = 'LONG_MEASUREMENT_FIX_AVGCOST_DIRECTSL_SEEN_DEDUPE_V1';

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
    takerFeePct: Math.max(
      0,
      safeNumber(
        CONFIG.long?.cost?.takerFeePct ??
          CONFIG.cost?.takerFeePct,
        0.0006
      )
    ),

    makerFeePct: Math.max(
      0,
      safeNumber(
        CONFIG.long?.cost?.makerFeePct ??
          CONFIG.cost?.makerFeePct,
        0.0002
      )
    ),

    marketImpactPct: Math.max(
      0,
      safeNumber(
        CONFIG.long?.cost?.marketImpactPct ??
          CONFIG.cost?.marketImpactPct,
        0.0003
      )
    ),

    fallbackSpreadPct: Math.max(
      0,
      safeNumber(
        CONFIG.long?.cost?.fallbackSpreadPct ??
          CONFIG.cost?.fallbackSpreadPct,
        0.0008
      )
    ),

    maxSpreadPct: Math.max(
      0,
      safeNumber(
        CONFIG.long?.cost?.maxSpreadPct ??
          CONFIG.cost?.maxSpreadPct,
        0.05
      )
    )
  };
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function cleanSideText(value = '') {
  return upper(value)
    .replaceAll('SHORT_DISABLED_TRUE', '')
    .replaceAll('SHORTDISABLED_TRUE', '')
    .replaceAll('BLOCK_SHORT_TRUE', '')
    .replaceAll('SHORT_DISABLED_FALSE', '')
    .replaceAll('SHORTDISABLED_FALSE', '')
    .replaceAll('BLOCK_SHORT_FALSE', '')
    .replaceAll('SHORT_ENABLED_FALSE', '')
    .replaceAll('SHORT_ONLY_FALSE', '')
    .replaceAll('LONG_DISABLED_FALSE', '')
    .replaceAll('LONGDISABLED_FALSE', '')
    .replaceAll('LONG_ENABLED_FALSE', '')
    .replaceAll('LONG_ONLY_FALSE', '')
    .replaceAll('SHORT_DISABLED_LONG_ONLY', '')
    .replaceAll('SHORTDISABLED_LONG_ONLY', '')
    .replaceAll('BLOCK_SHORT', '')
    .replaceAll('SHORT_DISABLED', '')
    .replaceAll('SHORTDISABLED', '')
    .replaceAll('LONG_ONLY_MODE', 'LONG')
    .replaceAll('LONG_ONLY', 'LONG')
    .replaceAll('LONG-ONLY', 'LONG')
    .replaceAll('SHORT_ONLY_MODE', 'SHORT')
    .replaceAll('SHORT_ONLY', 'SHORT')
    .replaceAll('SHORT-ONLY', 'SHORT');
}

function hasPattern(value = '', patterns = []) {
  const text = cleanSideText(value)
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!text) return false;

  return patterns.some((pattern) => (
    text === pattern ||
    text.startsWith(`${pattern}_`) ||
    text.endsWith(`_${pattern}`) ||
    text.includes(`_${pattern}_`)
  ));
}

function hasLongSignal(value = '') {
  const raw = cleanSideText(value);

  if (!raw) return false;
  if (LONG_TOKENS.has(raw)) return true;

  return hasPattern(raw, [
    'LONG',
    'BULL',
    'BULLISH',
    'BUY',
    'SIDE_LONG',
    'TRADE_SIDE_LONG',
    'TRADESIDE_LONG',
    'POSITION_SIDE_LONG',
    'POSITIONSIDE_LONG',
    'DIRECTION_LONG',
    'SIDE_BULL',
    'TRADE_SIDE_BULL',
    'DIRECTION_BULL',
    'SIDE_BUY',
    'DIRECTION_BUY',
    'MICRO_LONG',
    'FAMILY_LONG'
  ]);
}

function hasShortSignal(value = '') {
  const raw = cleanSideText(value);

  if (!raw) return false;
  if (SHORT_TOKENS.has(raw)) return true;

  return hasPattern(raw, [
    'SHORT',
    'BEAR',
    'BEARISH',
    'SELL',
    'SIDE_SHORT',
    'TRADE_SIDE_SHORT',
    'TRADESIDE_SHORT',
    'POSITION_SIDE_SHORT',
    'POSITIONSIDE_SHORT',
    'DIRECTION_SHORT',
    'SIDE_BEAR',
    'TRADE_SIDE_BEAR',
    'DIRECTION_BEAR',
    'SIDE_SELL',
    'DIRECTION_SELL',
    'MICRO_SHORT',
    'FAMILY_SHORT'
  ]);
}

function normalizeTradeSide(value = TARGET_TRADE_SIDE) {
  const raw = cleanSideText(value);

  if (!raw) return TARGET_TRADE_SIDE;

  const direct = sideToTradeSide(raw);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  const longHit = hasLongSignal(raw);
  const shortHit = hasShortSignal(raw);

  if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;
  if (longHit && !shortHit) return TARGET_TRADE_SIDE;

  if (longHit && shortHit) {
    if (raw.includes('TRADE_SIDE=LONG') || raw.includes('TRADESIDE=LONG')) return TARGET_TRADE_SIDE;
    if (raw.includes('TRADE_SIDE=SHORT') || raw.includes('TRADESIDE=SHORT')) return OPPOSITE_TRADE_SIDE;
    if (raw.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
    if (raw.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function isLongSide(side = TARGET_TRADE_SIDE) {
  return normalizeTradeSide(side) === TARGET_TRADE_SIDE;
}

function isShortSide(side = TARGET_TRADE_SIDE) {
  return normalizeTradeSide(side) === OPPOSITE_TRADE_SIDE;
}

function normalizeSource(source = DEFAULT_SOURCE) {
  const src = upper(source || DEFAULT_SOURCE);

  if (src === 'SHADOW') return 'SHADOW';
  if (src === 'VIRTUAL') return 'VIRTUAL';

  return DEFAULT_SOURCE;
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

function validLongRiskShape({ entry, sl, tp } = {}) {
  const e = safeNumber(entry, 0);
  const s = safeNumber(sl, 0);
  const t = safeNumber(tp, 0);

  return e > 0 && s > 0 && t > 0 && s < e && e < t;
}

function calcRiskPct({ entry, sl } = {}) {
  const e = safeNumber(entry, 0);
  const s = safeNumber(sl, 0);

  if (e <= 0 || s <= 0 || s >= e) return 0;

  return (e - s) / e;
}

function calcGrossMovePct({ entry, exit } = {}) {
  const e = safeNumber(entry, 0);
  const x = safeNumber(exit, 0);

  if (e <= 0 || x <= 0) return 0;

  return (x - e) / e;
}

function calcLongGrossR({ entry, initialSl, exit } = {}) {
  const e = safeNumber(entry, 0);
  const s = safeNumber(initialSl, 0);
  const x = safeNumber(exit, 0);

  if (e <= 0 || s <= 0 || x <= 0 || s >= e) return 0;

  const riskDistance = e - s;

  if (riskDistance <= 0) return 0;

  return (x - e) / riskDistance;
}

function isPositiveNetR(value) {
  return safeNumber(value, 0) > 0;
}

function isNegativeNetR(value) {
  return safeNumber(value, 0) < 0;
}

function identityFlags() {
  return {
    virtualLearning: true,
    virtualOnly: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    exchangeOrdersDisabled: true,
    noRealOrders: true,
    noExchangeOrders: true,

    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,

    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintRole: 'METADATA_ONLY',

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    exactTrueMicroFamilyRequired: true,
    fixedTaxonomyPreferred: true,

    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    discordOnlyForExactTrueMicroMatch: true,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    completedOnlyClosedVirtualOrShadow: true,

    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,
    avgCostRSource: 'costR',

    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    seenDefinition: 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY',
    observationDedupeRequired: true,
    outcomeDedupeRequired: true,

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    learningRemainsBroad: true,
    selectionWillBeAdaptive: true,
    discordWillBeStrict: true,

    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,

    parentLearningEnabled: true,
    childLearningEnabled: true,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    selectionGranularity: 'EXACT_75_CHILD',
    fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED',

    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    shortRootTouched: false
  };
}

function baseLongOnlyMeta({
  skipped = false,
  reason = null,
  source = DEFAULT_SOURCE
} = {}) {
  return {
    source: normalizeSource(source),

    costModel: COST_MODEL_VERSION,
    costModelVersion: COST_MODEL_VERSION,
    costModelApplied: !skipped,
    netCostModelApplied: !skipped,

    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_SCANNER_SIDE,
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
    outcomeSource: normalizeSource(source),

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    exchangeCallsDisabled: true,
    noRealOrders: true,
    noExchangeOrders: true,

    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,
    avgCostRSource: 'costR',

    measurementFixVersion: MEASUREMENT_FIX_VERSION,

    skipped,
    reason,

    ...identityFlags()
  };
}

function emptyCostResult(reason = 'NON_LONG_COST_MODEL_SKIPPED', source = DEFAULT_SOURCE) {
  return {
    ...baseLongOnlyMeta({
      skipped: true,
      reason,
      source
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
    rawR: 0,
    realizedGrossR: 0,

    costR: 0,
    avgCostR: 0,
    totalCostR: 0,

    netR: 0,
    exitR: 0,
    realizedNetR: 0,
    realizedR: 0,
    r: 0,

    win: false,
    loss: false,
    flat: true,
    isWin: false
  };
}

export function validateLongRiskShape({ entry, sl, tp } = {}) {
  const e = safeNumber(entry, 0);
  const s = safeNumber(sl, 0);
  const t = safeNumber(tp, 0);
  const valid = validLongRiskShape({
    entry: e,
    sl: s,
    tp: t
  });

  return {
    valid,
    reason: valid ? null : 'INVALID_LONG_RISK_SHAPE_REQUIRES_SL_LT_ENTRY_LT_TP',
    entry: e,
    sl: s,
    tp: t,
    riskPct: valid
      ? calcRiskPct({
        entry: e,
        sl: s
      })
      : 0,
    rewardPct: valid
      ? (t - e) / e
      : 0,
    ...baseLongOnlyMeta({
      skipped: !valid,
      reason: valid ? null : 'INVALID_LONG_RISK_SHAPE_REQUIRES_SL_LT_ENTRY_LT_TP'
    })
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

export function roundTripCostPct(entrySpreadPct, exitSpreadPct) {
  return roundTripCostRatio(entrySpreadPct, exitSpreadPct);
}

export function applyCosts({
  grossMovePct,
  grossR = null,
  riskPct,
  entrySpreadPct,
  exitSpreadPct,
  side = TARGET_TRADE_SIDE,
  tradeSide = side,
  source = DEFAULT_SOURCE
} = {}) {
  const normalizedSide = normalizeTradeSide(tradeSide || side);

  if (normalizedSide === OPPOSITE_TRADE_SIDE) {
    return emptyCostResult('SHORT_DISABLED_LONG_ONLY_COST_MODEL', source);
  }

  if (normalizedSide !== TARGET_TRADE_SIDE) {
    return emptyCostResult('UNKNOWN_OR_NON_LONG_COST_MODEL_SKIPPED', source);
  }

  const cfg = costConfig();

  const move = safeNumber(grossMovePct, 0);
  const risk = Math.max(0, safeNumber(riskPct, 0));

  if (risk <= 0) {
    return emptyCostResult('INVALID_OR_ZERO_LONG_RISK_PCT', source);
  }

  const feeRatio = cfg.takerFeePct * 2;
  const costRatio = roundTripCostRatio(entrySpreadPct, exitSpreadPct);
  const slippageRatio = Math.max(0, costRatio - feeRatio);

  const netMovePct = move - costRatio;

  const grossPnlPct = move * 100;
  const netPnlPct = netMovePct * 100;

  const calculatedGrossR = Number.isFinite(safeNumber(grossR, null))
    ? safeNumber(grossR, 0)
    : move / risk;

  const costR = costRatio / risk;
  const netR = calculatedGrossR - costR;

  return {
    ...baseLongOnlyMeta({
      source
    }),

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

    feePct: round6(feeRatio * 100),
    slippagePct: round6(slippageRatio * 100),
    costPct: round6(costRatio * 100),

    grossPnlPct: round6(grossPnlPct),
    netPnlPct: round6(netPnlPct),

    grossR: round6(calculatedGrossR),
    rawR: round6(calculatedGrossR),
    realizedGrossR: round6(calculatedGrossR),

    costR: round6(costR),
    avgCostR: round6(costR),
    totalCostR: round6(costR),

    netR: round6(netR),
    exitR: round6(netR),
    realizedNetR: round6(netR),
    realizedR: round6(netR),
    r: round6(netR),

    win: isPositiveNetR(netR),
    loss: isNegativeNetR(netR),
    flat: !isPositiveNetR(netR) && !isNegativeNetR(netR),
    isWin: isPositiveNetR(netR)
  };
}

export function applyCostsFromPrices({
  entry,
  exit,
  exitPrice = exit,
  sl,
  initialSl = sl,
  tp,
  side = TARGET_TRADE_SIDE,
  tradeSide = side,
  source = DEFAULT_SOURCE,
  entrySpreadPct,
  exitSpreadPct
} = {}) {
  const normalizedSide = normalizeTradeSide(tradeSide || side);

  if (normalizedSide === OPPOSITE_TRADE_SIDE) {
    return emptyCostResult('SHORT_DISABLED_LONG_ONLY_COST_MODEL', source);
  }

  if (normalizedSide !== TARGET_TRADE_SIDE) {
    return emptyCostResult('UNKNOWN_OR_NON_LONG_COST_MODEL_SKIPPED', source);
  }

  const e = safeNumber(entry, 0);
  const s = safeNumber(initialSl, 0);
  const t = safeNumber(tp, 0);
  const x = safeNumber(exitPrice, 0);

  if (!validLongRiskShape({
    entry: e,
    sl: s,
    tp: t
  })) {
    return emptyCostResult('INVALID_LONG_RISK_SHAPE_REQUIRES_SL_LT_ENTRY_LT_TP', source);
  }

  if (x <= 0) {
    return emptyCostResult('INVALID_LONG_EXIT_PRICE', source);
  }

  const riskPct = calcRiskPct({
    entry: e,
    sl: s
  });

  const grossMovePct = calcGrossMovePct({
    entry: e,
    exit: x
  });

  const grossR = calcLongGrossR({
    entry: e,
    initialSl: s,
    exit: x
  });

  const result = applyCosts({
    grossMovePct,
    grossR,
    riskPct,
    entrySpreadPct,
    exitSpreadPct,
    side: TARGET_TRADE_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    source
  });

  const netR = safeNumber(result.netR, grossR - safeNumber(result.costR, 0));

  return {
    ...result,

    entry: e,
    exit: x,
    exitPrice: x,
    sl: s,
    initialSl: s,
    tp: t,

    validLongRiskShape: true,
    longRiskFormula: 'sl < entry < tp',
    longGrossRFormula: '(exitPrice - entry) / (entry - initialSl)',

    riskPct: round6(riskPct),
    grossMovePct: round6(grossMovePct),

    grossR: round6(grossR),
    rawR: round6(grossR),
    realizedGrossR: round6(grossR),

    costR: round6(result.costR),
    avgCostR: round6(result.costR),
    totalCostR: round6(result.costR),

    netR: round6(netR),
    exitR: round6(netR),
    realizedNetR: round6(netR),
    realizedR: round6(netR),
    r: round6(netR),

    win: isPositiveNetR(netR),
    loss: isNegativeNetR(netR),
    flat: !isPositiveNetR(netR) && !isNegativeNetR(netR),
    isWin: isPositiveNetR(netR),

    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,
    avgCostRSource: 'costR'
  };
}

export {
  calcLongGrossR,
  calcGrossMovePct,
  calcRiskPct,
  validLongRiskShape
};