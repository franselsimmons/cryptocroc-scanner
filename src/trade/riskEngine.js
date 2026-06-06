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

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';

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
    spreadRiskMult: safeNumber(CONFIG.trade?.spreadRiskMult, 5)
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

function normalizeTradeSideValue(value) {
  const direct = sideToTradeSide(value);

  if (direct === 'SHORT') return 'SHORT';
  if (direct === 'LONG') return 'LONG';

  const raw = upper(value, '');

  if (!raw) return 'UNKNOWN';
  if (SHORT_TOKENS.has(raw)) return 'SHORT';
  if (LONG_TOKENS.has(raw)) return 'LONG';

  return 'UNKNOWN';
}

function idLooksLikeShort(value = '') {
  const raw = String(value || '').toUpperCase();

  return (
    raw.includes('MICRO_SHORT_') ||
    raw.includes('TRADESIDE=SHORT') ||
    raw.includes('TRADE_SIDE=SHORT') ||
    raw.includes('SIDE=SHORT') ||
    raw.includes('SIDE=BEAR') ||
    raw.includes('DIRECTION=SHORT') ||
    raw.includes('DIRECTION=BEAR') ||
    raw.includes('SHORT') ||
    raw.includes('BEAR') ||
    raw.includes('SELL')
  );
}

function idLooksLikeLong(value = '') {
  const raw = String(value || '').toUpperCase();

  return (
    raw.includes('MICRO_LONG_') ||
    raw.includes('TRADESIDE=LONG') ||
    raw.includes('TRADE_SIDE=LONG') ||
    raw.includes('SIDE=LONG') ||
    raw.includes('SIDE=BULL') ||
    raw.includes('DIRECTION=LONG') ||
    raw.includes('DIRECTION=BULL') ||
    raw.includes('LONG') ||
    raw.includes('BULL') ||
    raw.includes('BUY')
  );
}

function inferTradeSideFromIds(row = {}) {
  const haystack = [
    row.familyId,
    row.microFamilyId,
    row.trueMicroFamilyId,
    row.macroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId,
    row.id,
    row.key
  ]
    .map((value) => String(value || '').toUpperCase())
    .filter(Boolean)
    .join('|');

  if (!haystack) return 'UNKNOWN';

  if (idLooksLikeLong(haystack)) return 'LONG';
  if (idLooksLikeShort(haystack)) return 'SHORT';

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
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : [])
  ]
    .map((value) => String(value || '').toUpperCase())
    .filter(Boolean)
    .join('|');

  if (!haystack) return 'UNKNOWN';

  if (
    haystack.includes('TRADESIDE=LONG') ||
    haystack.includes('TRADE_SIDE=LONG') ||
    haystack.includes('SIDE=LONG') ||
    haystack.includes('SIDE=BULL') ||
    haystack.includes('DIRECTION=LONG') ||
    haystack.includes('DIRECTION=BULL') ||
    haystack.includes('SIDE=BUY') ||
    haystack.includes('DIRECTION=BUY')
  ) {
    return 'LONG';
  }

  if (
    haystack.includes('TRADESIDE=SHORT') ||
    haystack.includes('TRADE_SIDE=SHORT') ||
    haystack.includes('SIDE=SHORT') ||
    haystack.includes('SIDE=BEAR') ||
    haystack.includes('DIRECTION=SHORT') ||
    haystack.includes('DIRECTION=BEAR') ||
    haystack.includes('SIDE=SELL') ||
    haystack.includes('DIRECTION=SELL')
  ) {
    return 'SHORT';
  }

  if (idLooksLikeLong(haystack)) return 'LONG';
  if (idLooksLikeShort(haystack)) return 'SHORT';

  return 'UNKNOWN';
}

function inferTradeSideFromReason(row = {}) {
  const reason = upper(
    row.scannerReason ||
    row.reason ||
    row.signalReason ||
    row.actionReason ||
    '',
    ''
  );

  if (!reason) return 'UNKNOWN';

  if (idLooksLikeLong(reason)) return 'LONG';
  if (idLooksLikeShort(reason)) return 'SHORT';

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

  if (row.shortOnly === true || row.longDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function hasExplicitLongSide(row = {}) {
  if (typeof row !== 'object' || row === null) {
    return normalizeTradeSideValue(row) === 'LONG';
  }

  const directCandidates = [
    row.tradeSide,
    row.positionSide,
    row.direction,
    row.signalSide,
    row.scannerSide,
    row.expectedSide,
    row.predictedSide,
    row.intentSide,
    row.biasSide,
    row.side
  ];

  for (const value of directCandidates) {
    if (normalizeTradeSideValue(value) === 'LONG') return true;
  }

  return (
    inferTradeSideFromIds(row) === 'LONG' ||
    inferTradeSideFromDefinition(row) === 'LONG' ||
    inferTradeSideFromReason(row) === 'LONG'
  );
}

function sideLabel(sideOrRow) {
  return typeof sideOrRow === 'object' && sideOrRow !== null
    ? inferTradeSide(sideOrRow)
    : normalizeTradeSideValue(sideOrRow);
}

function isShort(side) {
  return sideLabel(side) === TARGET_TRADE_SIDE;
}

function dashboardSideFromTradeSide(side) {
  return isShort(side) ? TARGET_DASHBOARD_SIDE : 'unknown';
}

function withTradeSide(candidate = {}, side = TARGET_TRADE_SIDE) {
  const requestedTradeSide = normalizeTradeSideValue(side);

  if (requestedTradeSide !== TARGET_TRADE_SIDE) return null;
  if (hasExplicitLongSide(candidate)) return null;

  const inferredSide = inferTradeSide(candidate);

  if (inferredSide === 'LONG') return null;

  return {
    ...candidate,

    originalSide: candidate.side ?? candidate.tradeSide ?? null,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    scannerSide: TARGET_TRADE_SIDE,
    analysisSide: TARGET_TRADE_SIDE,
    actualScannerSide: TARGET_TRADE_SIDE,

    shortOnly: true,
    longDisabled: true
  };
}

function btcRelation(side, btcState) {
  const tradeSide = sideLabel(side);
  const btc = upper(btcState, 'NEUTRAL');

  if (btc === 'NEUTRAL' || btc === 'UNKNOWN') return 'BTC_NEUTRAL';

  if (tradeSide === 'SHORT' && ['BEARISH', 'STRONG_BEAR'].includes(btc)) {
    return 'BTC_WITH';
  }

  if (tradeSide === 'SHORT') return 'BTC_AGAINST';

  return 'BTC_UNKNOWN';
}

function directionalReward({
  entry,
  tp,
  side
} = {}) {
  if (!isShort(side)) return 0;

  return entry - tp;
}

function directionalChange({
  side,
  change
} = {}) {
  const value = safeNumber(change, 0);

  if (!isShort(side)) return 0;

  return -value;
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
  if (!isShort(side)) return 'RSI_UNKNOWN';

  const slope = safeNumber(rsiSlope, 0);
  const local = safeNumber(rsi, 50);
  const htf = safeNumber(rsiHTF, 50);

  if (slope < -0.5 && htf <= 55 && local >= 28) return 'RSI_WITH';
  if (slope > 0.5 || htf > 62 || local < 22) return 'RSI_AGAINST';

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
  if (!isShort(side)) return 'FUNDING_UNKNOWN';

  return rate > 0 ? 'FUNDING_WITH' : 'FUNDING_AGAINST';
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
  if (!isShort(side)) return -20;

  const zone = upper(rsiZone, 'MID');
  const slope = safeNumber(rsiSlope, 0);
  const htf = safeNumber(rsiHTF, 50);

  let score = 0;

  if (zone.startsWith('UPPER')) score += 10;
  if (zone === 'MID') score += 5;
  if (slope < 0) score += 5;
  if (htf >= 32 && htf <= 55) score += 5;
  if (htf < 26) score -= 6;

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
    `shortOnly=true`,
    `longDisabled=true`,
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

export function buildRiskGeometry({
  candidate,
  ob,
  candles15m,
  sideOverride = TARGET_TRADE_SIDE
} = {}) {
  const cfg = tradeConfig();

  if (hasExplicitLongSide(candidate)) return null;

  const overrideSide = normalizeTradeSideValue(sideOverride);
  const inferredSide = inferTradeSide(candidate);

  if (inferredSide === 'LONG') return null;

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

  const rewardPct = riskPct * cfg.defaultRR;

  const sl = entry * (1 + riskPct);
  const tp = entry * (1 - rewardPct);

  const rr = calculateRR({
    entry,
    sl,
    tp,
    side: TARGET_TRADE_SIDE
  });

  if (rr <= 0) return null;

  return {
    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    entry: roundPrice(entry),
    sl: roundPrice(sl),
    tp: roundPrice(tp),

    rr: round4(rr),

    slSource: 'SHORT_ATR_SPREAD_FALLBACK',
    tpSource: 'SHORT_DEFAULT_RR_TARGET',
    riskRewardSource: 'SHORT_ATR_SPREAD_DEFAULT_RR',

    atrPct: round6(atrPct),
    spreadPct: round6(spreadPct),
    riskPct: round6(riskPct),
    rewardPct: round6(rewardPct),

    atrBucket: volatilityBucket(atrPct),
    riskBucket: riskPctBucket(riskPct),
    spreadBucket: spreadBucket(spreadPct),

    shortOnly: true,
    longDisabled: true
  };
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
  if (hasExplicitLongSide(candidate)) return null;

  const overrideSide = normalizeTradeSideValue(sideOverride);
  const inferredSide = inferTradeSide(candidate);

  if (inferredSide === 'LONG') return null;

  const tradeSide = overrideSide !== 'UNKNOWN'
    ? overrideSide
    : inferredSide;

  if (tradeSide !== TARGET_TRADE_SIDE) return null;

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
  const spreadPct = safeNumber(ob?.spreadPct, fallbackSpreadPct());
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
    analysisSide: TARGET_TRADE_SIDE,
    actualScannerSide: TARGET_TRADE_SIDE,

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

    shortOnly: true,
    longDisabled: true,

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
  if (hasExplicitLongSide(candidate)) return [];

  const inferredSide = inferTradeSide(candidate);

  if (inferredSide === 'LONG') return [];

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
      analysisSide: TARGET_TRADE_SIDE,
      actualScannerSide: TARGET_TRADE_SIDE,
      shortOnly: true,
      longDisabled: true
    }
  ];
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

  if (!(sl > entry && tp < entry)) return false;

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

  const spreadPct = safeNumber(risk.spreadPct, 0);

  if (spreadPct > cfg.maxSpreadPct) return false;

  return true;
}