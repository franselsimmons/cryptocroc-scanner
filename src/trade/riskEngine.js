// ================= FILE: src/trade/riskEngine.js =================

import { CONFIG } from '../config.js';
import {
  calculateAtrPct,
  calculateRsi,
  getRsiSlope,
  getRsiZone,
  classifyFlow
} from '../market/indicators.js';
import {
  clamp,
  getObRelation,
  safeNumber,
  sideToTradeSide
} from '../utils.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

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

function now() {
  return Date.now();
}

function tradeConfig() {
  return {
    minRR: safeNumber(CONFIG.trade?.minRR, 0.5),
    defaultRR: safeNumber(CONFIG.trade?.defaultRR, 1.5),
    maxSpreadPct: safeNumber(CONFIG.trade?.maxSpreadPct, 0.015),

    minRiskPct: safeNumber(CONFIG.trade?.minRiskPct, 0.004),
    maxRiskPct: safeNumber(CONFIG.trade?.maxRiskPct, 0.025),
    fallbackRiskPct: safeNumber(CONFIG.trade?.fallbackRiskPct, 0.005),

    atrRiskMult: safeNumber(CONFIG.trade?.atrRiskMult, 1.2),
    spreadRiskMult: safeNumber(CONFIG.trade?.spreadRiskMult, 5),

    positionTimeStopMin: safeNumber(CONFIG.trade?.positionTimeStopMin, 720)
  };
}

function fallbackSpreadPct() {
  return safeNumber(CONFIG.cost?.fallbackSpreadPct, 0.0008);
}

function scoreInput(candidate = {}) {
  return safeNumber(
    candidate.scannerScore ?? candidate.moveScore,
    0
  );
}

function roundPrice(value) {
  const n = safeNumber(value, 0);

  if (n >= 1000) return Number(n.toFixed(2));
  if (n >= 1) return Number(n.toFixed(6));

  return Number(n.toFixed(10));
}

function round2(value) {
  return Number(safeNumber(value, 0).toFixed(2));
}

function round4(value) {
  return Number(safeNumber(value, 0).toFixed(4));
}

function round6(value) {
  return Number(safeNumber(value, 0).toFixed(6));
}

function bool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;

  const text = String(value || '').toLowerCase().trim();

  return ['true', '1', 'yes', 'y'].includes(text);
}

function upper(value, fallback = 'UNKNOWN') {
  const text = String(value || '').trim();

  return text
    ? text.toUpperCase()
    : fallback;
}

function cleanSideText(value = '') {
  return upper(value, '')
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

function normalizeTradeSideValue(value) {
  const raw = cleanSideText(value);

  if (!raw) return 'UNKNOWN';

  const direct = sideToTradeSide(raw);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  if (LONG_TOKENS.has(raw)) return TARGET_TRADE_SIDE;
  if (SHORT_TOKENS.has(raw)) return OPPOSITE_TRADE_SIDE;

  const normalized = raw
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  const longHit =
    normalized === 'LONG' ||
    normalized === 'BULL' ||
    normalized === 'BUY' ||
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
    normalized.endsWith('_BUY');

  const shortHit =
    normalized === 'SHORT' ||
    normalized === 'BEAR' ||
    normalized === 'SELL' ||
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
    normalized.endsWith('_SELL');

  if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;
  if (longHit && !shortHit) return TARGET_TRADE_SIDE;

  if (longHit && shortHit) {
    if (normalized.includes('TRADE_SIDE_LONG') || normalized.includes('TRADESIDE_LONG')) {
      return TARGET_TRADE_SIDE;
    }

    if (normalized.includes('TRADE_SIDE_SHORT') || normalized.includes('TRADESIDE_SHORT')) {
      return OPPOSITE_TRADE_SIDE;
    }

    if (normalized.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
    if (normalized.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
  }

  if (longHit) return TARGET_TRADE_SIDE;
  if (shortHit) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function idLooksLikeLong(value = '') {
  const raw = cleanSideText(value);

  if (!raw) return false;

  return (
    raw.includes('MICRO_LONG_') ||
    raw.includes('TRADESIDE=LONG') ||
    raw.includes('TRADE_SIDE=LONG') ||
    raw.includes('POSITION_SIDE=LONG') ||
    raw.includes('POSITIONSIDE=LONG') ||
    raw.includes('SIDE=LONG') ||
    raw.includes('SIDE=BULL') ||
    raw.includes('DIRECTION=LONG') ||
    raw.includes('DIRECTION=BULL') ||
    raw.includes('SIDE=BUY') ||
    raw.includes('DIRECTION=BUY') ||
    raw.startsWith('LONG_') ||
    raw.includes('_LONG_') ||
    raw.endsWith('_LONG') ||
    raw.startsWith('BULL_') ||
    raw.includes('_BULL_') ||
    raw.endsWith('_BULL') ||
    raw.startsWith('BUY_') ||
    raw.includes('_BUY_') ||
    raw.endsWith('_BUY')
  );
}

function idLooksLikeShort(value = '') {
  const raw = cleanSideText(value);

  if (!raw) return false;

  return (
    raw.includes('MICRO_SHORT_') ||
    raw.includes('TRADESIDE=SHORT') ||
    raw.includes('TRADE_SIDE=SHORT') ||
    raw.includes('POSITION_SIDE=SHORT') ||
    raw.includes('POSITIONSIDE=SHORT') ||
    raw.includes('SIDE=SHORT') ||
    raw.includes('SIDE=BEAR') ||
    raw.includes('DIRECTION=SHORT') ||
    raw.includes('DIRECTION=BEAR') ||
    raw.includes('SIDE=SELL') ||
    raw.includes('DIRECTION=SELL') ||
    raw.startsWith('SHORT_') ||
    raw.includes('_SHORT_') ||
    raw.endsWith('_SHORT') ||
    raw.startsWith('BEAR_') ||
    raw.includes('_BEAR_') ||
    raw.endsWith('_BEAR') ||
    raw.startsWith('SELL_') ||
    raw.includes('_SELL_') ||
    raw.endsWith('_SELL')
  );
}

function inferTradeSideFromIds(row = {}) {
  const haystack = [
    row.familyId,
    row.family,
    row.baseFamilyId,

    row.microFamilyId,
    row.trueMicroFamilyId,
    row.liveMicroFamilyId,
    row.realMicroFamilyId,
    row.executionMicroFamilyId,

    row.macroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId,
    row.parentFamilyId,
    row.macroId,

    row.id,
    row.key
  ]
    .map((value) => cleanSideText(value))
    .filter(Boolean)
    .join('|');

  if (!haystack) return 'UNKNOWN';

  const longHit = idLooksLikeLong(haystack);
  const shortHit = idLooksLikeShort(haystack);

  if (longHit && !shortHit) return TARGET_TRADE_SIDE;
  if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;

  if (longHit && shortHit) {
    if (haystack.includes('TRADESIDE=LONG') || haystack.includes('TRADE_SIDE=LONG')) return TARGET_TRADE_SIDE;
    if (haystack.includes('TRADESIDE=SHORT') || haystack.includes('TRADE_SIDE=SHORT')) return OPPOSITE_TRADE_SIDE;
    if (haystack.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
    if (haystack.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferTradeSideFromDefinition(row = {}) {
  const haystack = [
    row.definition,
    row.microDefinition,
    row.macroDefinition,
    row.parentDefinition,

    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts : []),
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : []),
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : [])
  ]
    .map((value) => cleanSideText(value))
    .filter(Boolean)
    .join('|');

  if (!haystack) return 'UNKNOWN';

  if (
    haystack.includes('TRADESIDE=LONG') ||
    haystack.includes('TRADE_SIDE=LONG') ||
    haystack.includes('POSITION_SIDE=LONG') ||
    haystack.includes('POSITIONSIDE=LONG') ||
    haystack.includes('SIDE=LONG') ||
    haystack.includes('SIDE=BULL') ||
    haystack.includes('DIRECTION=LONG') ||
    haystack.includes('DIRECTION=BULL') ||
    haystack.includes('SIDE=BUY') ||
    haystack.includes('DIRECTION=BUY')
  ) {
    return TARGET_TRADE_SIDE;
  }

  if (
    haystack.includes('TRADESIDE=SHORT') ||
    haystack.includes('TRADE_SIDE=SHORT') ||
    haystack.includes('POSITION_SIDE=SHORT') ||
    haystack.includes('POSITIONSIDE=SHORT') ||
    haystack.includes('SIDE=SHORT') ||
    haystack.includes('SIDE=BEAR') ||
    haystack.includes('DIRECTION=SHORT') ||
    haystack.includes('DIRECTION=BEAR') ||
    haystack.includes('SIDE=SELL') ||
    haystack.includes('DIRECTION=SELL')
  ) {
    return OPPOSITE_TRADE_SIDE;
  }

  if (idLooksLikeLong(haystack)) return TARGET_TRADE_SIDE;
  if (idLooksLikeShort(haystack)) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function inferTradeSideFromReason(row = {}) {
  const reason = cleanSideText(
    row.scannerReason ||
    row.reason ||
    row.signalReason ||
    row.actionReason ||
    ''
  );

  if (!reason) return 'UNKNOWN';

  if (idLooksLikeLong(reason)) return TARGET_TRADE_SIDE;
  if (idLooksLikeShort(reason)) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function inferTradeSide(row = {}) {
  if (typeof row !== 'object' || row === null) {
    return normalizeTradeSideValue(row);
  }

  const candidates = [
    row.tradeSide,
    row.positionSide,
    row.direction,
    row.signalSide,
    row.scannerSide,
    row.actualScannerSide,
    row.analysisSide,
    row.expectedSide,
    row.predictedSide,
    row.intentSide,
    row.biasSide,
    row.side
  ];

  for (const value of candidates) {
    const side = normalizeTradeSideValue(value);

    if (side !== 'UNKNOWN') return side;
  }

  const fromIds = inferTradeSideFromIds(row);

  if (fromIds !== 'UNKNOWN') return fromIds;

  const fromDefinition = inferTradeSideFromDefinition(row);

  if (fromDefinition !== 'UNKNOWN') return fromDefinition;

  const fromReason = inferTradeSideFromReason(row);

  if (fromReason !== 'UNKNOWN') return fromReason;

  if (row.longOnly === true || row.shortDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  if (row.shortOnly === true || row.longDisabled === true) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function hasExplicitShortSide(row = {}) {
  if (typeof row !== 'object' || row === null) {
    return normalizeTradeSideValue(row) === OPPOSITE_TRADE_SIDE;
  }

  const directCandidates = [
    row.tradeSide,
    row.positionSide,
    row.direction,
    row.signalSide,
    row.scannerSide,
    row.actualScannerSide,
    row.analysisSide,
    row.expectedSide,
    row.predictedSide,
    row.intentSide,
    row.biasSide,
    row.side
  ];

  for (const value of directCandidates) {
    if (normalizeTradeSideValue(value) === OPPOSITE_TRADE_SIDE) return true;
  }

  return (
    inferTradeSideFromIds(row) === OPPOSITE_TRADE_SIDE ||
    inferTradeSideFromDefinition(row) === OPPOSITE_TRADE_SIDE ||
    inferTradeSideFromReason(row) === OPPOSITE_TRADE_SIDE
  );
}

function sideLabel(sideOrRow) {
  return typeof sideOrRow === 'object' && sideOrRow !== null
    ? inferTradeSide(sideOrRow)
    : normalizeTradeSideValue(sideOrRow);
}

function isLong(side) {
  return sideLabel(side) === TARGET_TRADE_SIDE;
}

function dashboardSideFromTradeSide(side) {
  return isLong(side) ? TARGET_DASHBOARD_SIDE : 'unknown';
}

function withTradeSide(candidate = {}, side = TARGET_TRADE_SIDE) {
  const requestedTradeSide = normalizeTradeSideValue(side);

  if (requestedTradeSide !== TARGET_TRADE_SIDE) return null;
  if (hasExplicitShortSide(candidate)) return null;

  const inferredSide = inferTradeSide(candidate);

  if (inferredSide === OPPOSITE_TRADE_SIDE) return null;

  return {
    ...candidate,

    originalSide: candidate.side ?? candidate.tradeSide ?? null,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    scannerSide: TARGET_TRADE_SIDE,
    actualScannerSide: TARGET_TRADE_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    virtualOnly: true,
    virtualLearning: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true
  };
}

function btcRelation(side, btcState) {
  const tradeSide = sideLabel(side);
  const btc = upper(btcState, 'NEUTRAL');

  if (btc === 'NEUTRAL' || btc === 'UNKNOWN') return 'BTC_NEUTRAL';

  if (tradeSide === TARGET_TRADE_SIDE && ['BULLISH', 'STRONG_BULL'].includes(btc)) {
    return 'BTC_WITH';
  }

  if (tradeSide === TARGET_TRADE_SIDE) return 'BTC_AGAINST';

  return 'BTC_UNKNOWN';
}

function directionalReward({
  entry,
  tp,
  side
} = {}) {
  if (!isLong(side)) return 0;

  return tp - entry;
}

function directionalChange({
  side,
  change
} = {}) {
  const value = safeNumber(change, 0);

  if (!isLong(side)) return 0;

  return value;
}

function rsiBucket(value) {
  const rsi = safeNumber(value, 50);

  if (rsi < 25) return 'RSI_LT_25';
  if (rsi < 30) return 'RSI_25_30';
  if (rsi < 35) return 'RSI_30_35';
  if (rsi < 40) return 'RSI_35_40';
  if (rsi < 45) return 'RSI_40_45';
  if (rsi < 50) return 'RSI_45_50';
  if (rsi < 55) return 'RSI_50_55';
  if (rsi < 60) return 'RSI_55_60';
  if (rsi < 65) return 'RSI_60_65';
  if (rsi < 70) return 'RSI_65_70';
  if (rsi < 75) return 'RSI_70_75';

  return 'RSI_GT_75';
}

function rsiSlopeBucket(value) {
  const slope = safeNumber(value, 0);

  if (slope <= -5) return 'SLOPE_STRONG_DOWN';
  if (slope <= -2) return 'SLOPE_DOWN';
  if (slope < -0.5) return 'SLOPE_SOFT_DOWN';
  if (slope <= 0.5) return 'SLOPE_FLAT';
  if (slope < 2) return 'SLOPE_SOFT_UP';
  if (slope < 5) return 'SLOPE_UP';

  return 'SLOPE_STRONG_UP';
}

function rsiAlignment({
  side,
  rsi,
  rsiHTF,
  rsiSlope
} = {}) {
  if (!isLong(side)) return 'RSI_UNKNOWN';

  const slope = safeNumber(rsiSlope, 0);
  const local = safeNumber(rsi, 50);
  const htf = safeNumber(rsiHTF, 50);

  if (slope > 0.5 && htf >= 45 && local <= 72) return 'RSI_WITH';
  if (slope < -0.5 || htf < 38 || local > 78) return 'RSI_AGAINST';

  return 'RSI_NEUTRAL';
}

function momentumBucket({
  side,
  change1h,
  change24h
} = {}) {
  const d1h = directionalChange({ side, change: change1h });
  const d24h = directionalChange({ side, change: change24h });

  if (d1h >= 3 || d24h >= 10) return 'MOM_STRONG_WITH';
  if (d1h >= 1 || d24h >= 4) return 'MOM_WITH';
  if (d1h <= -3 || d24h <= -10) return 'MOM_STRONG_AGAINST';
  if (d1h <= -1 || d24h <= -4) return 'MOM_AGAINST';

  return 'MOM_NEUTRAL';
}

function volatilityBucket(atrPct) {
  const atr = safeNumber(atrPct, 0);

  if (atr <= 0) return 'ATR_UNKNOWN';
  if (atr < 0.003) return 'ATR_LT_30BPS';
  if (atr < 0.006) return 'ATR_30_60BPS';
  if (atr < 0.010) return 'ATR_60_100BPS';
  if (atr < 0.015) return 'ATR_100_150BPS';
  if (atr < 0.025) return 'ATR_150_250BPS';

  return 'ATR_GT_250BPS';
}

function riskPctBucket(riskPct) {
  const risk = safeNumber(riskPct, 0);

  if (risk <= 0) return 'RISK_UNKNOWN';
  if (risk < 0.005) return 'RISK_LT_50BPS';
  if (risk < 0.008) return 'RISK_50_80BPS';
  if (risk < 0.012) return 'RISK_80_120BPS';
  if (risk < 0.018) return 'RISK_120_180BPS';
  if (risk < 0.025) return 'RISK_180_250BPS';

  return 'RISK_GT_250BPS';
}

function spreadBps(spreadPct) {
  return round4(safeNumber(spreadPct, 0) * 10000);
}

function spreadBucket(spreadPct) {
  const bps = spreadBps(spreadPct);

  if (bps <= 0) return 'SPREAD_UNKNOWN';
  if (bps < 4) return 'SPREAD_LT_4BPS';
  if (bps < 8) return 'SPREAD_4_8BPS';
  if (bps < 12) return 'SPREAD_8_12BPS';
  if (bps < 20) return 'SPREAD_12_20BPS';

  return 'SPREAD_GT_20BPS';
}

function depthBucket(depthUsd) {
  const depth = safeNumber(depthUsd, 0);

  if (depth >= 1_000_000) return 'DEPTH_GT_1M';
  if (depth >= 500_000) return 'DEPTH_500K_1M';
  if (depth >= 250_000) return 'DEPTH_250K_500K';
  if (depth >= 100_000) return 'DEPTH_100K_250K';
  if (depth >= 50_000) return 'DEPTH_50K_100K';
  if (depth > 0) return 'DEPTH_LT_50K';

  return 'DEPTH_UNKNOWN';
}

function fundingBucket(rate) {
  const funding = safeNumber(rate, 0);

  if (funding >= 0.0005) return 'FUNDING_POS_EXTREME';
  if (funding >= 0.0002) return 'FUNDING_POS_HIGH';
  if (funding > 0.00005) return 'FUNDING_POS';
  if (funding <= -0.0005) return 'FUNDING_NEG_EXTREME';
  if (funding <= -0.0002) return 'FUNDING_NEG_HIGH';
  if (funding < -0.00005) return 'FUNDING_NEG';

  return 'FUNDING_NEUTRAL';
}

function fundingAlignment({
  side,
  fundingRate
} = {}) {
  const rate = safeNumber(fundingRate, 0);

  if (Math.abs(rate) < 0.00005) return 'FUNDING_NEUTRAL';
  if (!isLong(side)) return 'FUNDING_UNKNOWN';

  return rate < 0 ? 'FUNDING_WITH' : 'FUNDING_AGAINST';
}

function obDepthValue(ob = {}) {
  return safeNumber(
    ob.depthMinUsd1p ??
    ob.minDepthUsd1p ??
    ob.depthUsd1p ??
    ob.depthUsd ??
    0,
    0
  );
}

function obImbalance(ob = {}) {
  const bidDepth = safeNumber(
    ob.bidDepthUsd1p ??
    ob.bidUsd1p ??
    ob.bidsUsd1p ??
    ob.bidDepthUsd ??
    0,
    0
  );

  const askDepth = safeNumber(
    ob.askDepthUsd1p ??
    ob.askUsd1p ??
    ob.asksUsd1p ??
    ob.askDepthUsd ??
    0,
    0
  );

  const total = bidDepth + askDepth;

  if (total <= 0) return 0;

  return clamp((bidDepth - askDepth) / total, -1, 1);
}

function obImbalanceBucket(value) {
  const imbalance = safeNumber(value, 0);

  if (imbalance >= 0.35) return 'OB_BID_STRONG';
  if (imbalance >= 0.12) return 'OB_BID';
  if (imbalance <= -0.35) return 'OB_ASK_STRONG';
  if (imbalance <= -0.12) return 'OB_ASK';

  return 'OB_BALANCED';
}

function scannerReason(candidate = {}) {
  const reason = upper(
    candidate.scannerReason ||
    candidate.reason ||
    candidate.signalReason ||
    'UNKNOWN'
  );

  if (reason.includes('RETEST')) return 'RETEST';
  if (reason.includes('PULLBACK')) return 'PULLBACK';
  if (reason.includes('BREAKOUT')) return 'BREAKOUT';
  if (reason.includes('VOLUME')) return 'VOLUME';
  if (reason.includes('MOMENTUM')) return 'MOMENTUM';
  if (reason.includes('SWEEP')) return 'SWEEP';

  return reason;
}

function inferEntryFlags(candidate = {}) {
  const reason = scannerReason(candidate);

  const pullbackConfirmed =
    bool(candidate.pullbackConfirmed) ||
    reason.includes('PULLBACK');

  const retestConfirmed =
    bool(candidate.retestConfirmed) ||
    reason.includes('RETEST');

  const sweepConfirmed =
    bool(candidate.sweepConfirmed) ||
    reason.includes('SWEEP');

  const fakeBreakout =
    bool(candidate.fakeBreakout) ||
    bool(candidate.fakeBreakoutRisk);

  let entryQuality = 'RAW';

  if (retestConfirmed) entryQuality = 'RETEST';
  else if (pullbackConfirmed) entryQuality = 'PULLBACK';
  else if (sweepConfirmed) entryQuality = 'SWEEP';
  else if (reason.includes('BREAKOUT')) entryQuality = 'BREAKOUT';
  else if (reason.includes('MOMENTUM')) entryQuality = 'MOMENTUM';

  return {
    pullbackConfirmed,
    retestConfirmed,
    sweepConfirmed,
    fakeBreakout,
    fakeBreakoutRisk: fakeBreakout,
    entryQuality
  };
}

function directionalMoveScore({
  side,
  rsiZone,
  rsiSlope,
  rsiHTF,
  rsiAlign
} = {}) {
  if (!isLong(side)) return -20;

  const zone = upper(rsiZone, 'MID');
  const slope = safeNumber(rsiSlope, 0);
  const htf = safeNumber(rsiHTF, 50);

  let score = 0;

  if (zone.startsWith('LOWER')) score += 10;
  if (zone === 'MID') score += 5;
  if (slope > 0) score += 5;
  if (htf >= 45 && htf <= 68) score += 5;
  if (htf > 74) score -= 6;

  if (rsiAlign === 'RSI_WITH') score += 4;
  if (rsiAlign === 'RSI_AGAINST') score -= 6;

  return score;
}

function spreadQualityScore(spreadPct) {
  const cfg = tradeConfig();
  const spread = safeNumber(spreadPct, 0);

  if (spread <= 0) return -4;
  if (spread <= 0.0004) return 8;
  if (spread <= 0.0008) return 5;
  if (spread <= 0.0015) return 1;
  if (spread <= cfg.maxSpreadPct) return -4;

  return -12;
}

function depthQualityScore(depthUsd) {
  const depth = safeNumber(depthUsd, 0);

  if (depth >= 1_000_000) return 10;
  if (depth >= 500_000) return 8;
  if (depth >= 250_000) return 6;
  if (depth >= 100_000) return 4;
  if (depth >= 50_000) return 1;
  if (depth > 0) return -4;

  return -8;
}

function rrScore(rr) {
  const cfg = tradeConfig();
  const r = safeNumber(rr, 0);

  if (r >= 2.5) return 14;
  if (r >= 2.0) return 12;
  if (r >= 1.5) return 10;
  if (r >= 1.0) return 6;
  if (r >= cfg.minRR) return 2;

  return -12;
}

function flowScore(flow) {
  const f = upper(flow, 'NEUTRAL');

  if (f === 'TREND') return 18;
  if (f === 'IMPULSE') return 15;
  if (f === 'BUILDING') return 10;

  return 2;
}

function obRelationScore(obRelation) {
  const relation = upper(obRelation, 'UNKNOWN');

  if (relation === 'WITH') return 15;
  if (relation === 'NEUTRAL') return 4;
  if (relation === 'AGAINST') return -12;

  return -4;
}

function sniperObScore(obRelation) {
  const relation = upper(obRelation, 'UNKNOWN');

  if (relation === 'WITH') return 18;
  if (relation === 'NEUTRAL') return 6;
  if (relation === 'AGAINST') return -15;

  return -5;
}

function btcScore(relationToBtc) {
  const relation = upper(relationToBtc, 'BTC_UNKNOWN');

  if (relation === 'BTC_WITH') return 8;
  if (relation === 'BTC_NEUTRAL') return 2;
  if (relation === 'BTC_AGAINST') return -8;

  return -3;
}

function entryQualityScore(flags = {}) {
  if (flags.retestConfirmed) return 8;
  if (flags.pullbackConfirmed) return 7;
  if (flags.sweepConfirmed) return 5;
  if (flags.entryQuality === 'MOMENTUM') return 3;

  return 0;
}

function fundingScore(alignment) {
  const value = upper(alignment, 'FUNDING_UNKNOWN');

  if (value === 'FUNDING_WITH') return 3;
  if (value === 'FUNDING_NEUTRAL') return 1;
  if (value === 'FUNDING_AGAINST') return -3;

  return 0;
}

function buildMicroSignalParts({
  tradeSide,
  rsiZone,
  rsiLocalBucket,
  rsiHtfBucket,
  rsiSlopeGroup,
  rsiAlign,
  flow,
  momentum,
  obRelation,
  obImbalanceGroup,
  btcRel,
  regime,
  atrGroup,
  spreadGroup,
  depthGroup,
  fundingGroup,
  fundingAlign,
  riskGroup,
  entryQuality,
  fakeBreakout
} = {}) {
  return [
    `tradeSide=${tradeSide}`,
    `side=${TARGET_DASHBOARD_SIDE}`,
    `positionSide=${TARGET_TRADE_SIDE}`,
    `direction=${TARGET_TRADE_SIDE}`,
    `longOnly=true`,
    `shortDisabled=true`,

    `rsiZone=${rsiZone}`,
    `rsiBucket=${rsiLocalBucket}`,
    `rsiHTFBucket=${rsiHtfBucket}`,
    `rsiSlopeBucket=${rsiSlopeGroup}`,
    `rsiAlignment=${rsiAlign}`,

    `flow=${flow}`,
    `momentum=${momentum}`,

    `obRelation=${obRelation}`,
    `obImbalance=${obImbalanceGroup}`,

    `btcRelation=${btcRel}`,
    `regime=${upper(regime, 'UNKNOWN')}`,

    `atrBucket=${atrGroup}`,
    `spreadBucket=${spreadGroup}`,
    `depthBucket=${depthGroup}`,

    `fundingBucket=${fundingGroup}`,
    `fundingAlignment=${fundingAlign}`,

    `riskBucket=${riskGroup}`,
    `entryQuality=${entryQuality}`,
    `fakeBreakout=${Boolean(fakeBreakout)}`
  ];
}

export function calculateRR({
  entry,
  sl,
  tp,
  side
} = {}) {
  const e = safeNumber(entry, 0);
  const s = safeNumber(sl, 0);
  const t = safeNumber(tp, 0);

  if (e <= 0 || s <= 0 || t <= 0) return 0;

  const risk = Math.abs(e - s);

  if (risk <= 0) return 0;

  const reward = directionalReward({
    entry: e,
    tp: t,
    side
  });

  return reward > 0
    ? reward / risk
    : 0;
}

export function isValidRiskGeometry(risk, side = TARGET_TRADE_SIDE) {
  if (!risk) return false;

  const cfg = tradeConfig();
  const tradeSide = sideLabel(side || risk.side || risk.tradeSide);

  if (tradeSide !== TARGET_TRADE_SIDE) return false;

  const entry = safeNumber(risk.entry, 0);
  const sl = safeNumber(risk.sl, 0);
  const tp = safeNumber(risk.tp, 0);

  if (entry <= 0 || sl <= 0 || tp <= 0) return false;
  if (!(sl < entry && tp > entry)) return false;

  const rr = calculateRR({
    entry,
    sl,
    tp,
    side: TARGET_TRADE_SIDE
  });

  if (rr < cfg.minRR) return false;

  const riskPct = safeNumber(risk.riskPct, 0);

  if (riskPct <= 0) return false;
  if (riskPct > cfg.maxRiskPct * 1.05) return false;

  // Spread is GEEN gate meer: elke geldige long-geometry wordt virtueel gevolgd.
  // De spread wordt als KOSTEN verrekend in het cost-model (netto R), niet vooraf geblokkeerd.
  // Zo krijgt elke binnenkomende long-coin een TP/SL en leert elke micro-family.

  return true;
}

export function buildRiskGeometry({
  candidate,
  ob,
  candles15m,
  sideOverride = TARGET_TRADE_SIDE
} = {}) {
  const cfg = tradeConfig();

  if (hasExplicitShortSide(candidate)) return null;

  const overrideSide = normalizeTradeSideValue(sideOverride);
  const inferredSide = inferTradeSide(candidate);

  if (inferredSide === OPPOSITE_TRADE_SIDE) return null;

  const tradeSide = overrideSide !== 'UNKNOWN'
    ? overrideSide
    : inferredSide;

  if (tradeSide !== TARGET_TRADE_SIDE) return null;

  const entry = safeNumber(ob?.mid || candidate?.price, 0);

  if (entry <= 0) return null;

  const atrPct = safeNumber(calculateAtrPct(candles15m, 14), 0);
  const spreadPct = safeNumber(ob?.spreadPct, fallbackSpreadPct());

  const rawRiskPct = Math.max(
    cfg.fallbackRiskPct,
    atrPct * cfg.atrRiskMult,
    spreadPct * cfg.spreadRiskMult
  );

  const riskPct = clamp(
    rawRiskPct,
    cfg.minRiskPct,
    cfg.maxRiskPct
  );

  const effectiveRR = Math.max(
    cfg.minRR,
    cfg.defaultRR
  );

  const rewardPct = riskPct * effectiveRR;

  const sl = entry * (1 - riskPct);
  const tp = entry * (1 + rewardPct);

  const roundedEntry = roundPrice(entry);
  const roundedSl = roundPrice(sl);
  const roundedTp = roundPrice(tp);

  const rr = calculateRR({
    entry: roundedEntry,
    sl: roundedSl,
    tp: roundedTp,
    side: TARGET_TRADE_SIDE
  });

  const risk = {
    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    entry: roundedEntry,
    sl: roundedSl,
    tp: roundedTp,

    rr: round4(rr),

    slSource: 'LONG_ATR_SPREAD_FALLBACK',
    tpSource: 'LONG_DEFAULT_RR_TARGET',
    riskRewardSource: 'LONG_ATR_SPREAD_DEFAULT_RR',

    atrPct: round6(atrPct),
    spreadPct: round6(spreadPct),
    riskPct: round6(riskPct),
    rewardPct: round6(rewardPct),

    atrBucket: volatilityBucket(atrPct),
    riskBucket: riskPctBucket(riskPct),
    spreadBucket: spreadBucket(spreadPct),

    positionTimeStopMin: cfg.positionTimeStopMin,

    validLongRiskShape: true,
    longGrossRFormula: '(exitPrice - entry) / (entry - initialSl)',
    longCurrentRFormula: '(currentPrice - entry) / (entry - initialSl)',
    virtualOnly: true,
    virtualLearning: true,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true
  };

  return isValidRiskGeometry(risk, TARGET_TRADE_SIDE)
    ? risk
    : null;
}

export function buildRiskGeometryForSide({
  candidate,
  ob,
  candles15m,
  side
} = {}) {
  const tradeSide = normalizeTradeSideValue(side);

  if (tradeSide !== TARGET_TRADE_SIDE) return null;

  return buildRiskGeometry({
    candidate,
    ob,
    candles15m,
    sideOverride: TARGET_TRADE_SIDE
  });
}

export function buildLiveMetrics({
  candidate,
  ob,
  funding,
  candles15m,
  candles1h,
  btcState,
  regime,
  risk,
  sideOverride = TARGET_TRADE_SIDE
} = {}) {
  if (!candidate || !risk) return null;
  if (hasExplicitShortSide(candidate)) return null;

  const overrideSide = normalizeTradeSideValue(sideOverride);
  const inferredSide = inferTradeSide(candidate);

  if (inferredSide === OPPOSITE_TRADE_SIDE) return null;

  const tradeSide = overrideSide !== 'UNKNOWN'
    ? overrideSide
    : inferredSide;

  if (tradeSide !== TARGET_TRADE_SIDE) return null;
  if (!isValidRiskGeometry(risk, TARGET_TRADE_SIDE)) return null;

  const sideCandidate = withTradeSide(candidate, TARGET_TRADE_SIDE);

  if (!sideCandidate) return null;

  const rsi = safeNumber(calculateRsi(candles15m, 14) ?? 50, 50);
  const rsiHTF = safeNumber(calculateRsi(candles1h, 14) ?? rsi, rsi);
  const rsiZone = getRsiZone(rsi);
  const rsiSlope = safeNumber(getRsiSlope(candles15m), 0);

  const flow = classifyFlow({
    side: TARGET_TRADE_SIDE,
    change1h: sideCandidate.change1h,
    change24h: sideCandidate.change24h,
    candles15m
  });

  const obBias = ob?.bias || 'NEUTRAL';
  const obRelation = getObRelation(TARGET_TRADE_SIDE, obBias);
  const relationToBtc = btcRelation(TARGET_TRADE_SIDE, btcState);

  const depthMinUsd1p = obDepthValue(ob);
  const spreadPct = safeNumber(ob?.spreadPct, risk.spreadPct ?? 0);
  const fundingRate = safeNumber(funding?.rate, 0);
  const imbalance = obImbalance(ob);

  const flags = inferEntryFlags(sideCandidate);

  const rsiLocalBucket = rsiBucket(rsi);
  const rsiHtfBucket = rsiBucket(rsiHTF);
  const rsiSlopeGroup = rsiSlopeBucket(rsiSlope);

  const rsiAlign = rsiAlignment({
    side: TARGET_TRADE_SIDE,
    rsi,
    rsiHTF,
    rsiSlope
  });

  const momentum = momentumBucket({
    side: TARGET_TRADE_SIDE,
    change1h: sideCandidate.change1h,
    change24h: sideCandidate.change24h
  });

  const atrGroup = volatilityBucket(risk?.atrPct);
  const spreadGroup = spreadBucket(spreadPct);
  const depthGroup = depthBucket(depthMinUsd1p);
  const fundingGroup = fundingBucket(fundingRate);

  const fundingAlign = fundingAlignment({
    side: TARGET_TRADE_SIDE,
    fundingRate
  });

  const riskGroup = riskPctBucket(risk?.riskPct);
  const obImbalanceGroup = obImbalanceBucket(imbalance);

  const baseScore = scoreInput(sideCandidate);

  let confluence = 0;

  confluence += clamp(baseScore, 0, 100) * 0.30;
  confluence += flowScore(flow);
  confluence += obRelationScore(obRelation);
  confluence += btcScore(relationToBtc);
  confluence += rrScore(risk?.rr);
  confluence += spreadQualityScore(spreadPct);
  confluence += depthQualityScore(depthMinUsd1p);
  confluence += entryQualityScore(flags);
  confluence += fundingScore(fundingAlign);
  confluence += flags.fakeBreakoutRisk ? -10 : 0;
  confluence += Math.abs(rsiSlope) > 2 ? 3 : 0;
  confluence += rsiAlign === 'RSI_WITH' ? 4 : 0;
  confluence += rsiAlign === 'RSI_AGAINST' ? -6 : 0;

  confluence = Math.round(clamp(confluence, 0, 100));

  let sniperScore = 0;

  sniperScore += clamp(baseScore, 0, 100) * 0.32;
  sniperScore += sniperObScore(obRelation);
  sniperScore += btcScore(relationToBtc);
  sniperScore += flowScore(flow);
  sniperScore += rrScore(risk?.rr);
  sniperScore += directionalMoveScore({
    side: TARGET_TRADE_SIDE,
    rsiZone,
    rsiSlope,
    rsiHTF,
    rsiAlign
  });
  sniperScore += spreadQualityScore(spreadPct);
  sniperScore += depthQualityScore(depthMinUsd1p) * 0.35;
  sniperScore += entryQualityScore(flags);
  sniperScore += fundingScore(fundingAlign);
  sniperScore += flags.fakeBreakoutRisk ? -10 : 0;

  sniperScore = Math.round(clamp(sniperScore, 0, 100));

  const microSignalParts = buildMicroSignalParts({
    tradeSide: TARGET_TRADE_SIDE,
    rsiZone,
    rsiLocalBucket,
    rsiHtfBucket,
    rsiSlopeGroup,
    rsiAlign,
    flow,
    momentum,
    obRelation,
    obImbalanceGroup,
    btcRel: relationToBtc,
    regime,
    atrGroup,
    spreadGroup,
    depthGroup,
    fundingGroup,
    fundingAlign,
    riskGroup,
    entryQuality: flags.entryQuality,
    fakeBreakout: flags.fakeBreakout
  });

  return {
    ...sideCandidate,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    scannerSide: TARGET_TRADE_SIDE,
    actualScannerSide: TARGET_TRADE_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    confluence,
    sniperScore,

    rr: safeNumber(risk?.rr, 0),

    rsi: round2(rsi),
    rsiHTF: round2(rsiHTF),
    rsiZone,
    rsiBucket: rsiLocalBucket,
    rsiHTFBucket: rsiHtfBucket,
    rsiSlope: round4(rsiSlope),
    rsiSlopeBucket: rsiSlopeGroup,
    rsiAlignment: rsiAlign,
    rsiContinuationScore: round4(Math.abs(rsiSlope)),

    flow,
    momentumBucket: momentum,

    obBias,
    obRelation,
    obImbalance: round4(imbalance),
    obImbalanceBucket: obImbalanceGroup,

    spreadPct,
    spreadBps: spreadBps(spreadPct),
    spreadBucket: spreadGroup,

    depthMinUsd1p,
    depthBucket: depthGroup,

    fundingRate,
    fundingBucket: fundingGroup,
    fundingAlignment: fundingAlign,

    btcState,
    btcRelation: relationToBtc,
    regime,

    scannerReason: scannerReason(sideCandidate),

    pullbackConfirmed: flags.pullbackConfirmed,
    retestConfirmed: flags.retestConfirmed,
    sweepConfirmed: flags.sweepConfirmed,
    fakeBreakout: flags.fakeBreakout,
    fakeBreakoutRisk: flags.fakeBreakoutRisk,
    entryQuality: flags.entryQuality,

    entry: risk.entry,
    sl: risk.sl,
    tp: risk.tp,

    atrPct: risk.atrPct,
    atrBucket: atrGroup,
    riskPct: risk.riskPct,
    riskBucket: riskGroup,
    rewardPct: risk.rewardPct,

    slSource: risk.slSource,
    tpSource: risk.tpSource,
    riskRewardSource: risk.riskRewardSource,

    microSignalParts,
    executionFingerprintParts: microSignalParts,

    validLongRiskShape: true,
    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    virtualOnly: true,
    virtualLearning: true,

    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,

    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    positionTimeStopMin: tradeConfig().positionTimeStopMin,

    ts: now()
  };
}

export function buildLiveMetricsForSide(params = {}, side) {
  const tradeSide = normalizeTradeSideValue(side);

  if (tradeSide !== TARGET_TRADE_SIDE) return null;

  return buildLiveMetrics({
    ...params,
    sideOverride: TARGET_TRADE_SIDE
  });
}

export function buildRiskAndLiveMetricsForBothSides({
  candidate,
  ob,
  funding,
  candles15m,
  candles1h,
  btcState,
  regime
} = {}) {
  if (!candidate) return [];
  if (hasExplicitShortSide(candidate)) return [];

  const inferredSide = inferTradeSide(candidate);

  if (inferredSide === OPPOSITE_TRADE_SIDE) return [];

  const sideCandidate = withTradeSide(candidate, TARGET_TRADE_SIDE);

  if (!sideCandidate) return [];

  const risk = buildRiskGeometry({
    candidate: sideCandidate,
    ob,
    candles15m,
    sideOverride: TARGET_TRADE_SIDE
  });

  if (!isValidRiskGeometry(risk, TARGET_TRADE_SIDE)) {
    return [];
  }

  const metrics = buildLiveMetrics({
    candidate: sideCandidate,
    ob,
    funding,
    candles15m,
    candles1h,
    btcState,
    regime,
    risk,
    sideOverride: TARGET_TRADE_SIDE
  });

  if (!metrics) return [];

  const outputSide = inferTradeSide(metrics);

  if (outputSide !== TARGET_TRADE_SIDE) return [];

  return [
    {
      ...metrics,

      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      positionSide: TARGET_TRADE_SIDE,
      direction: TARGET_TRADE_SIDE,

      scannerSide: TARGET_TRADE_SIDE,
      actualScannerSide: TARGET_TRADE_SIDE,
      analysisSide: TARGET_TRADE_SIDE,

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      oppositeTradeSide: OPPOSITE_TRADE_SIDE,

      validLongRiskShape: true,
      longOnly: true,
      shortDisabled: true,
      shortOnly: false,
      longDisabled: false,

      virtualOnly: true,
      virtualLearning: true,

      realOrdersDisabled: true,
      bitgetOrdersDisabled: true,
      exchangeOrdersDisabled: true
    }
  ];
}