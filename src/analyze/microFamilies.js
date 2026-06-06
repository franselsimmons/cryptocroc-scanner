// ================= FILE: src/analyze/microFamilies.js =================

import { CONFIG } from '../config.js';
import {
  bucketDepth,
  bucketFunding,
  bucketSpread,
  bucketStep,
  getObRelation,
  sideToTradeSide,
  stableHash,
  safeNumber
} from '../utils.js';

const FALLBACK_MACRO_SCHEMA = 'MF_V1';
const FALLBACK_MICRO_SCHEMA = 'MF_V2';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';

const EXECUTION_MICRO_SUFFIX = 'XR';
const EXECUTION_MICRO_HASH_LEN = 10;

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

function getMacroSchema() {
  return String(
    CONFIG?.analyze?.macroSchema ||
    CONFIG?.analyze?.schema ||
    FALLBACK_MACRO_SCHEMA
  ).toUpperCase();
}

function getMicroSchema() {
  return String(
    CONFIG?.analyze?.microSchema ||
    FALLBACK_MICRO_SCHEMA
  ).toUpperCase();
}

function shouldRefineExecutionMicroIds() {
  return CONFIG.analyze?.refineExecutionMicroIds !== false;
}

function toUpper(value, fallback = 'UNKNOWN') {
  const raw = String(value ?? '').trim();

  if (!raw) return fallback;

  return raw.toUpperCase();
}

function boolToken(value) {
  return Boolean(value) ? 'true' : 'false';
}

function normalizeToken(value, fallback = 'NA', maxLength = 56) {
  const text = String(value ?? '').trim();

  if (!text) return fallback;

  return text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLength) || fallback;
}

function normalizeTradeSideValue(value) {
  const direct = sideToTradeSide(value);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === 'SHORT') return 'SHORT';

  const raw = toUpper(value, '');

  if (!raw) return 'UNKNOWN';
  if (LONG_TOKENS.has(raw)) return TARGET_TRADE_SIDE;
  if (SHORT_TOKENS.has(raw)) return 'SHORT';

  return 'UNKNOWN';
}

function inferSideFromIds(metrics = {}) {
  const haystack = [
    metrics.familyId,
    metrics.microFamilyId,
    metrics.macroFamilyId,
    metrics.parentMacroFamilyId,
    metrics.parentMicroFamilyId,
    metrics.trueMicroFamilyId,
    metrics.id,
    metrics.key
  ]
    .map((value) => String(value || '').toUpperCase())
    .filter(Boolean)
    .join('|');

  if (!haystack) return 'UNKNOWN';

  if (
    haystack.startsWith('LONG_') ||
    haystack.includes('_LONG_') ||
    haystack.includes('|LONG_') ||
    haystack.includes('MICRO_LONG_') ||
    haystack.includes('SIDE=LONG') ||
    haystack.includes('TRADESIDE=LONG') ||
    haystack.includes('TRADE_SIDE=LONG') ||
    haystack.includes('BULL') ||
    haystack.includes('BUY')
  ) {
    return TARGET_TRADE_SIDE;
  }

  if (
    haystack.startsWith('SHORT_') ||
    haystack.includes('_SHORT_') ||
    haystack.includes('|SHORT_') ||
    haystack.includes('MICRO_SHORT_') ||
    haystack.includes('SIDE=SHORT') ||
    haystack.includes('TRADESIDE=SHORT') ||
    haystack.includes('TRADE_SIDE=SHORT') ||
    haystack.includes('BEAR') ||
    haystack.includes('SELL')
  ) {
    return 'SHORT';
  }

  return 'UNKNOWN';
}

function inferSideFromScannerReason(metrics = {}) {
  const reason = toUpper(
    metrics.scannerReason ||
    metrics.reason ||
    metrics.signalReason ||
    '',
    ''
  );

  if (!reason) return 'UNKNOWN';

  if (
    reason.includes('LONG') ||
    reason.includes('BULL') ||
    reason.includes('BUY') ||
    reason.includes('UPSIDE')
  ) {
    return TARGET_TRADE_SIDE;
  }

  if (
    reason.includes('SHORT') ||
    reason.includes('BEAR') ||
    reason.includes('SELL') ||
    reason.includes('DOWNSIDE')
  ) {
    return 'SHORT';
  }

  return 'UNKNOWN';
}

function inferTradeSide(metrics = {}) {
  const sideCandidates = [
    metrics.tradeSide,
    metrics.side,
    metrics.positionSide,
    metrics.direction,
    metrics.signalSide,
    metrics.scannerSide,
    metrics.expectedSide,
    metrics.predictedSide,
    metrics.intentSide,
    metrics.biasSide
  ];

  for (const value of sideCandidates) {
    const side = normalizeTradeSideValue(value);

    if (side === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
    if (side === 'SHORT') return 'SHORT';
  }

  const fromIds = inferSideFromIds(metrics);

  if (fromIds === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (fromIds === 'SHORT') return 'SHORT';

  const fromReason = inferSideFromScannerReason(metrics);

  if (fromReason === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (fromReason === 'SHORT') return 'SHORT';

  return 'UNKNOWN';
}

function normalizeSide() {
  return TARGET_DASHBOARD_SIDE;
}

function firstFinite(...values) {
  for (const value of values) {
    const n = safeNumber(value, NaN);

    if (Number.isFinite(n)) return n;
  }

  return NaN;
}

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }

  return null;
}

function formatBucketNumber(value, decimals = 0) {
  if (!Number.isFinite(value)) return 'NA';

  return Number(value)
    .toFixed(decimals)
    .replace(/\.?0+$/u, '')
    .replace('-', 'M')
    .replace('.', 'P');
}

function ratioToBps(value) {
  const n = safeNumber(value, NaN);

  if (!Number.isFinite(n)) return NaN;

  return Math.abs(n) * 10000;
}

function numericBps(value) {
  const bps = ratioToBps(value);

  if (!Number.isFinite(bps)) return null;

  return Number(formatBucketNumber(bps, 3));
}

function coarseRsi(zone) {
  const z = toUpper(zone, 'MID');

  if (z.startsWith('LOWER')) return 'LOWER';
  if (z.startsWith('UPPER')) return 'UPPER';

  return 'MID';
}

function exactRsiZone(zone) {
  const z = toUpper(zone, 'MID');

  if (z === 'UNKNOWN' || z === 'NA') return 'MID';

  return z;
}

function tier(score) {
  const s = safeNumber(score, NaN);

  if (!Number.isFinite(s)) return 'NA';
  if (s >= 70) return 'HI';
  if (s >= 45) return 'MID';

  return 'LO';
}

function scoreBucket(score, prefix) {
  const s = safeNumber(score, NaN);

  if (!Number.isFinite(s)) return `${prefix}_NA`;
  if (s >= 85) return `${prefix}_85_100`;
  if (s >= 70) return `${prefix}_70_85`;
  if (s >= 55) return `${prefix}_55_70`;
  if (s >= 45) return `${prefix}_45_55`;
  if (s >= 30) return `${prefix}_30_45`;
  if (s >= 15) return `${prefix}_15_30`;

  return `${prefix}_LT_15`;
}

function signedScoreBucket(score, prefix) {
  const s = safeNumber(score, NaN);

  if (!Number.isFinite(s)) return `${prefix}_NA`;
  if (s >= 70) return `${prefix}_POS_HI`;
  if (s >= 35) return `${prefix}_POS_MID`;
  if (s > 5) return `${prefix}_POS_LO`;
  if (s <= -70) return `${prefix}_NEG_HI`;
  if (s <= -35) return `${prefix}_NEG_MID`;
  if (s < -5) return `${prefix}_NEG_LO`;

  return `${prefix}_NEUTRAL`;
}

function bucketBps(value, prefix) {
  const bps = ratioToBps(value);

  if (!Number.isFinite(bps)) return `${prefix}_NA`;
  if (bps < 2) return `${prefix}_LT_2BPS`;
  if (bps < 4) return `${prefix}_2_4BPS`;
  if (bps < 8) return `${prefix}_4_8BPS`;
  if (bps < 12) return `${prefix}_8_12BPS`;
  if (bps < 20) return `${prefix}_12_20BPS`;
  if (bps < 40) return `${prefix}_20_40BPS`;
  if (bps < 75) return `${prefix}_40_75BPS`;
  if (bps < 150) return `${prefix}_75_150BPS`;

  return `${prefix}_GT_150BPS`;
}

function bucketDistancePct(value, prefix) {
  const bps = ratioToBps(value);

  if (!Number.isFinite(bps)) return `${prefix}_NA`;
  if (bps < 5) return `${prefix}_LT_5BPS`;
  if (bps < 10) return `${prefix}_5_10BPS`;
  if (bps < 20) return `${prefix}_10_20BPS`;
  if (bps < 35) return `${prefix}_20_35BPS`;
  if (bps < 50) return `${prefix}_35_50BPS`;
  if (bps < 75) return `${prefix}_50_75BPS`;
  if (bps < 100) return `${prefix}_75_100BPS`;
  if (bps < 150) return `${prefix}_100_150BPS`;

  return `${prefix}_GT_150BPS`;
}

function bucketVolatilityPct(value) {
  const bps = ratioToBps(value);

  if (!Number.isFinite(bps)) return 'VOL_NA';
  if (bps < 20) return 'VOL_LT_20BPS';
  if (bps < 40) return 'VOL_20_40BPS';
  if (bps < 75) return 'VOL_40_75BPS';
  if (bps < 125) return 'VOL_75_125BPS';
  if (bps < 200) return 'VOL_125_200BPS';

  return 'VOL_GT_200BPS';
}

function microDepthBucket(value) {
  const usd = safeNumber(value, NaN);

  if (!Number.isFinite(usd)) return 'DEPTH_MICRO_NA';
  if (usd < 50_000) return 'DEPTH_MICRO_LT_50K';
  if (usd < 100_000) return 'DEPTH_MICRO_50K_100K';
  if (usd < 250_000) return 'DEPTH_MICRO_100K_250K';
  if (usd < 500_000) return 'DEPTH_MICRO_250K_500K';
  if (usd < 1_000_000) return 'DEPTH_MICRO_500K_1M';
  if (usd < 2_500_000) return 'DEPTH_MICRO_1M_2P5M';

  return 'DEPTH_MICRO_GT_2P5M';
}

function rrMicroBucket(rr) {
  const r = safeNumber(rr, NaN);

  if (!Number.isFinite(r)) return 'RR_MICRO_NA';
  if (r < 1) return 'RR_MICRO_LT_1';
  if (r < 1.25) return 'RR_MICRO_1_1P25';
  if (r < 1.5) return 'RR_MICRO_1P25_1P5';
  if (r < 1.75) return 'RR_MICRO_1P5_1P75';
  if (r < 2) return 'RR_MICRO_1P75_2';
  if (r < 2.5) return 'RR_MICRO_2_2P5';
  if (r < 3) return 'RR_MICRO_2P5_3';
  if (r < 4) return 'RR_MICRO_3_4';

  return 'RR_MICRO_GT_4';
}

function entryQuality(metrics = {}) {
  if (metrics.retestConfirmed) return 'RETEST';
  if (metrics.pullbackConfirmed) return 'PULLBACK';
  if (metrics.sweepConfirmed) return 'SWEEP';

  return 'RAW';
}

function btcRelation(sideOrMetrics, btcStateInput = null) {
  const btcState = sideOrMetrics && typeof sideOrMetrics === 'object'
    ? sideOrMetrics.btcState
    : btcStateInput;

  const btc = toUpper(btcState, 'NEUTRAL');

  if (btc === 'NEUTRAL' || btc === 'UNKNOWN') return 'BTC_NEUTRAL';

  if (['BULLISH', 'STRONG_BULL'].includes(btc)) {
    return 'BTC_WITH';
  }

  if (['BEARISH', 'STRONG_BEAR'].includes(btc)) {
    return 'BTC_AGAINST';
  }

  return 'BTC_NEUTRAL';
}

function coarseBtcState(sideOrMetrics, btcStateInput = null) {
  return btcRelation(sideOrMetrics, btcStateInput);
}

function coarseRegime(regime) {
  const r = toUpper(regime, 'NORMAL_VOL');

  if (r.includes('HIGH') || r.includes('EXTREME')) return 'HIGH_VOL';
  if (r.includes('LOW')) return 'LOW_VOL';

  return 'NORMAL_VOL';
}

function exactRegime(regime) {
  const r = toUpper(regime, 'NORMAL_VOL');

  if (r === 'UNKNOWN' || r === 'NA') return 'NORMAL_VOL';

  return r;
}

function coarseFlow(flow) {
  const f = toUpper(flow, 'NEUTRAL');

  if (['TREND', 'IMPULSE'].includes(f)) return 'TREND';
  if (f === 'BUILDING') return 'BUILDING';

  return 'NEUTRAL';
}

function exactFlow(flow) {
  const f = toUpper(flow, 'NEUTRAL');

  if (['IMPULSE', 'TREND', 'BUILDING', 'NEUTRAL', 'CHOP', 'RANGE', 'REVERSAL'].includes(f)) {
    return f;
  }

  return 'NEUTRAL';
}

function coarseScannerReason(reason) {
  const r = toUpper(reason, 'UNKNOWN');

  if (r.includes('RETEST')) return 'RETEST';
  if (r.includes('PULLBACK')) return 'PULLBACK';
  if (r.includes('BREAKOUT')) return 'BREAKOUT';
  if (r.includes('VOLUME')) return 'VOLUME';
  if (r.includes('MOMENTUM')) return 'MOMENTUM';

  return 'UNKNOWN';
}

function exactScannerReason(reason) {
  const r = toUpper(reason, 'UNKNOWN');

  if (r === 'UNKNOWN' || r === 'NA') return 'UNKNOWN';

  return r;
}

function normalizeObRelation(metrics = {}) {
  const explicit = toUpper(metrics.obRelation || '', '');

  if (explicit) return explicit;

  return toUpper(
    getObRelation(TARGET_TRADE_SIDE, metrics.obBias) ||
    'UNKNOWN'
  );
}

function assetClass(metrics = {}) {
  const explicit = toUpper(
    metrics.assetClass ||
    metrics.marketClass ||
    metrics.instrumentClass ||
    '',
    ''
  );

  if (explicit) return explicit;

  const symbol = toUpper(metrics.symbol || metrics.baseSymbol || '');

  if (!symbol) return 'UNKNOWN';

  const equityLike = new Set([
    'NVDA',
    'SOXL',
    'MRVL',
    'AVGO',
    'ARM',
    'MSTR',
    'CRCL',
    'RKLB',
    'SPCX',
    'H',
    'BZ',
    'XAG',
    'USAR',
    'CBRS',
    'LITE'
  ]);

  if (equityLike.has(symbol)) return 'EQUITY_PROXY';

  return 'CRYPTO';
}

function getCleanSymbol(metrics = {}) {
  const raw = toUpper(
    metrics.symbol ||
    metrics.baseSymbol ||
    metrics.contractSymbol ||
    '',
    ''
  );

  const cleaned = raw
    .replace(/USDTUMCBL|USDCUMCBL|USDTPERP|USDCPERP|USDT|USDC|BUSD|PERP|SWAP|USD/gu, '')
    .replace(/[^A-Z0-9]/gu, '');

  return cleaned || 'UNKNOWN';
}

function symbolClassBucket(metrics = {}) {
  const symbol = getCleanSymbol(metrics);

  const majors = new Set([
    'BTC',
    'ETH',
    'SOL',
    'XRP',
    'BNB',
    'DOGE',
    'ADA',
    'AVAX',
    'LINK',
    'DOT',
    'TON',
    'TRX',
    'LTC',
    'BCH'
  ]);

  const memes = new Set([
    'PEPE',
    'SHIB',
    'WIF',
    'BONK',
    'FLOKI',
    'DOGE'
  ]);

  if (majors.has(symbol)) return `SYMBOL_MAJOR_${symbol}`;
  if (memes.has(symbol)) return `SYMBOL_MEME_${symbol}`;

  return `SYMBOL_HASH_${stableHash(symbol, 4)}`;
}

function getEntryDistancePct(metrics = {}) {
  return firstFinite(
    metrics.entryDistancePct,
    metrics.entryDistanceToMidPct,
    metrics.pullbackDistancePct,
    metrics.distanceToEntryPct,
    metrics.distancePct
  );
}

function getSlDistancePct(metrics = {}) {
  return firstFinite(
    metrics.slDistancePct,
    metrics.stopDistancePct,
    metrics.stopLossDistancePct,
    metrics.riskPct
  );
}

function getTpDistancePct(metrics = {}) {
  return firstFinite(
    metrics.tpDistancePct,
    metrics.takeProfitDistancePct,
    metrics.rewardPct
  );
}

function getLiquidationDistancePct(metrics = {}) {
  return firstFinite(
    metrics.liqDistancePct,
    metrics.liquidationDistancePct,
    metrics.distanceToLiquidationPct,
    metrics.nearestLiqDistancePct
  );
}

function getVolatilityPct(metrics = {}) {
  return firstFinite(
    metrics.atrPct,
    metrics.volatilityPct,
    metrics.rangePct,
    metrics.realizedVolPct
  );
}

function getSpoofScore(metrics = {}) {
  return firstFinite(
    metrics.spoofScore,
    metrics.orderbookSpoofScore,
    metrics.obSpoofScore,
    metrics.fakeLiquidityScore
  );
}

function getOrderbookImbalance(metrics = {}) {
  return firstFinite(
    metrics.orderbookImbalance,
    metrics.bookImbalance,
    metrics.obImbalance,
    metrics.bidAskImbalance
  );
}

function getRsiSlope(metrics = {}) {
  return firstFinite(
    metrics.rsiSlope,
    metrics.rsiVelocity,
    metrics.rsiDelta,
    metrics.rsiMomentum
  );
}

function getCostR(metrics = {}) {
  return firstFinite(
    metrics.costR,
    metrics.avgCostR,
    metrics.estimatedCostR
  );
}

function getConfluenceScore(metrics = {}) {
  return firstFinite(
    metrics.confluence,
    metrics.sniperScore,
    metrics.scannerScore,
    metrics.moveScore
  );
}

function getSpreadPct(metrics = {}) {
  const spreadPct = firstFinite(metrics.spreadPct);

  if (Number.isFinite(spreadPct)) return spreadPct;

  const spreadBps = firstFinite(metrics.spreadBps);

  if (Number.isFinite(spreadBps)) return spreadBps / 10000;

  return NaN;
}

function costBucket(costR) {
  const c = safeNumber(costR, NaN);

  if (!Number.isFinite(c)) return 'COST_R_NA';
  if (c < 0.1) return 'COST_R_LT_0P10';
  if (c < 0.2) return 'COST_R_0P10_0P20';
  if (c < 0.3) return 'COST_R_0P20_0P30';
  if (c < 0.4) return 'COST_R_0P30_0P40';
  if (c < 0.5) return 'COST_R_0P40_0P50';

  return 'COST_R_GT_0P50';
}

function numberBucket(value, prefix, {
  step = 1,
  min = -Infinity,
  max = Infinity,
  decimals = 0,
  scale = 1
} = {}) {
  const n = safeNumber(value, NaN);

  if (!Number.isFinite(n)) return `${prefix}_NA`;

  const scaled = n * scale;
  const clipped = Math.max(min, Math.min(max, scaled));
  const bucket = Math.round(clipped / step) * step;

  return `${prefix}_${formatBucketNumber(bucket, decimals)}`;
}

function ratioBucket(value, prefix, {
  stepBps = 10,
  maxBps = 300
} = {}) {
  const bps = ratioToBps(value);

  if (!Number.isFinite(bps)) return `${prefix}_NA`;

  const clipped = Math.max(0, Math.min(maxBps, bps));
  const bucket = Math.round(clipped / stepBps) * stepBps;

  return `${prefix}_${formatBucketNumber(bucket, 0)}BPS`;
}

function signedRatioBucket(value, prefix, {
  stepBps = 10,
  maxBps = 300
} = {}) {
  const n = safeNumber(value, NaN);

  if (!Number.isFinite(n)) return `${prefix}_NA`;

  const bps = n * 10000;
  const clipped = Math.max(-maxBps, Math.min(maxBps, bps));
  const bucket = Math.round(clipped / stepBps) * stepBps;

  return `${prefix}_${formatBucketNumber(bucket, 0)}BPS`;
}

function buildMacroDefinitionParts(metrics = {}, familyId) {
  const normalizedSide = normalizeSide(metrics);
  const obRelation = normalizeObRelation(metrics);
  const btcRel = btcRelation(metrics);
  const regime = coarseRegime(metrics.regime);
  const flow = coarseFlow(metrics.flow);
  const scannerReason = coarseScannerReason(metrics.scannerReason);

  return [
    `schema=${getMacroSchema()}`,
    `side=${normalizedSide}`,
    `tradeSide=${TARGET_TRADE_SIDE}`,
    `family=${familyId}`,

    `rsiZone=${exactRsiZone(metrics.rsiZone)}`,

    `flow=${flow}`,
    `obRelation=${obRelation}`,
    `btcRelation=${btcRel}`,
    `regime=${regime}`,

    `confluenceTier=${tier(metrics.confluence)}`,
    `sniperTier=${tier(metrics.sniperScore)}`,

    `rrBucket=${bucketStep(metrics.rr, 0.5, 'RR', 1)}`,
    `spreadBucket=${bucketSpread(metrics.spreadPct)}`,
    `depthBucket=${bucketDepth(metrics.depthMinUsd1p)}`,
    `fundingBucket=${bucketFunding(metrics.fundingRate)}`,

    `entryQuality=${entryQuality(metrics)}`,
    `fakeBreakout=${boolToken(metrics.fakeBreakout)}`,
    `scannerReason=${scannerReason}`
  ];
}

function buildMicroDefinitionParts(metrics = {}, parent) {
  const spreadPct = getSpreadPct(metrics);
  const entryDistancePct = getEntryDistancePct(metrics);
  const slDistancePct = getSlDistancePct(metrics);
  const tpDistancePct = getTpDistancePct(metrics);
  const liqDistancePct = getLiquidationDistancePct(metrics);
  const volatilityPct = getVolatilityPct(metrics);
  const spoofScore = getSpoofScore(metrics);
  const orderbookImbalance = getOrderbookImbalance(metrics);
  const rsiSlope = getRsiSlope(metrics);
  const costR = getCostR(metrics);

  return [
    `schema=${getMicroSchema()}`,
    `parent=${parent.microFamilyId}`,
    `side=${TARGET_DASHBOARD_SIDE}`,
    `tradeSide=${TARGET_TRADE_SIDE}`,
    `family=${parent.familyId}`,

    `assetClass=${assetClass(metrics)}`,

    `rsiZone=${exactRsiZone(metrics.rsiZone)}`,
    `rsiCoarse=${coarseRsi(metrics.rsiZone)}`,
    `rsiSlope=${signedScoreBucket(rsiSlope, 'RSI_SLOPE')}`,

    `flow=${exactFlow(metrics.flow)}`,
    `flowCoarse=${coarseFlow(metrics.flow)}`,

    `obRelation=${normalizeObRelation(metrics)}`,
    `obImbalance=${signedScoreBucket(orderbookImbalance, 'OB_IMB')}`,
    `spoofBucket=${scoreBucket(spoofScore, 'SPOOF')}`,

    `btcState=${toUpper(metrics.btcState, 'NEUTRAL')}`,
    `btcRelation=${btcRelation(TARGET_TRADE_SIDE, metrics.btcState)}`,

    `regime=${exactRegime(metrics.regime)}`,
    `regimeCoarse=${coarseRegime(metrics.regime)}`,
    `volBucket=${bucketVolatilityPct(volatilityPct)}`,

    `confluenceBucket=${scoreBucket(metrics.confluence, 'CONF')}`,
    `sniperBucket=${scoreBucket(metrics.sniperScore, 'SNIPER')}`,

    `rrBucket=${rrMicroBucket(metrics.rr)}`,
    `rrCoarseBucket=${bucketStep(metrics.rr, 0.5, 'RR', 1)}`,

    `spreadBucket=${bucketSpread(spreadPct)}`,
    `spreadMicroBucket=${bucketBps(spreadPct, 'SPREAD_MICRO')}`,

    `depthBucket=${bucketDepth(metrics.depthMinUsd1p)}`,
    `depthMicroBucket=${microDepthBucket(metrics.depthMinUsd1p)}`,

    `fundingBucket=${bucketFunding(metrics.fundingRate)}`,

    `entryQuality=${entryQuality(metrics)}`,
    `entryDistance=${bucketDistancePct(entryDistancePct, 'ENTRY_DIST')}`,
    `slDistance=${bucketDistancePct(slDistancePct, 'SL_DIST')}`,
    `tpDistance=${bucketDistancePct(tpDistancePct, 'TP_DIST')}`,
    `liqDistance=${bucketDistancePct(liqDistancePct, 'LIQ_DIST')}`,

    `costBucket=${costBucket(costR)}`,

    `fakeBreakout=${boolToken(metrics.fakeBreakout)}`,
    `scannerReason=${exactScannerReason(metrics.scannerReason)}`,
    `scannerReasonCoarse=${coarseScannerReason(metrics.scannerReason)}`
  ];
}

function buildExecutionFingerprintParts(metrics = {}, parent) {
  const spreadPct = getSpreadPct(metrics);
  const entryDistancePct = getEntryDistancePct(metrics);
  const slDistancePct = getSlDistancePct(metrics);
  const tpDistancePct = getTpDistancePct(metrics);
  const liqDistancePct = getLiquidationDistancePct(metrics);
  const volatilityPct = getVolatilityPct(metrics);
  const spoofScore = getSpoofScore(metrics);
  const orderbookImbalance = getOrderbookImbalance(metrics);
  const rsiSlope = getRsiSlope(metrics);
  const costR = getCostR(metrics);
  const confluence = getConfluenceScore(metrics);

  const scannerReason = firstValue(
    metrics.scannerReasonCoarse,
    metrics.scannerReason,
    metrics.reason,
    metrics.signalReason
  );

  return [
    `xrSchema=${EXECUTION_MICRO_SUFFIX}`,
    `tradeSide=${TARGET_TRADE_SIDE}`,
    `family=${normalizeToken(parent.familyId)}`,
    `macro=${normalizeToken(parent.microFamilyId)}`,

    `symbolClass=${symbolClassBucket(metrics)}`,
    `assetClass=${normalizeToken(assetClass(metrics))}`,

    `rsiExact=${normalizeToken(exactRsiZone(metrics.rsiZone))}`,
    `rsiCoarse=${normalizeToken(coarseRsi(metrics.rsiZone))}`,
    `rsiSlopeFine=${numberBucket(rsiSlope, 'RSI_SLOPE_FINE', {
      step: 2.5,
      min: -100,
      max: 100,
      decimals: 1
    })}`,

    `flowExact=${normalizeToken(exactFlow(metrics.flow))}`,
    `flowCoarse=${normalizeToken(coarseFlow(metrics.flow))}`,

    `obRelation=${normalizeToken(normalizeObRelation(metrics))}`,
    `obImbFine=${numberBucket(orderbookImbalance, 'OB_IMB_FINE', {
      step: 0.05,
      min: -2,
      max: 2,
      decimals: 2
    })}`,
    `spoofFine=${numberBucket(spoofScore, 'SPOOF_FINE', {
      step: 2.5,
      min: 0,
      max: 100,
      decimals: 1
    })}`,

    `btcState=${normalizeToken(metrics.btcState || 'NEUTRAL')}`,
    `btcRelation=${normalizeToken(btcRelation(TARGET_TRADE_SIDE, metrics.btcState))}`,

    `regimeExact=${normalizeToken(exactRegime(metrics.regime))}`,
    `regimeCoarse=${normalizeToken(coarseRegime(metrics.regime))}`,

    `scannerExact=${normalizeToken(exactScannerReason(scannerReason))}`,
    `scannerCoarse=${normalizeToken(coarseScannerReason(scannerReason))}`,

    `spreadFine=${ratioBucket(spreadPct, 'SPREAD_FINE', {
      stepBps: 1,
      maxBps: 120
    })}`,
    `entryDistFine=${ratioBucket(entryDistancePct, 'ENTRY_DIST_FINE', {
      stepBps: 5,
      maxBps: 500
    })}`,
    `slDistFine=${ratioBucket(slDistancePct, 'SL_DIST_FINE', {
      stepBps: 5,
      maxBps: 500
    })}`,
    `tpDistFine=${ratioBucket(tpDistancePct, 'TP_DIST_FINE', {
      stepBps: 10,
      maxBps: 1000
    })}`,
    `liqDistFine=${ratioBucket(liqDistancePct, 'LIQ_DIST_FINE', {
      stepBps: 10,
      maxBps: 1500
    })}`,
    `volFine=${ratioBucket(volatilityPct, 'VOL_FINE', {
      stepBps: 5,
      maxBps: 500
    })}`,

    `depthFine=${numberBucket(metrics.depthMinUsd1p, 'DEPTH_FINE_USD', {
      step: 25_000,
      min: 0,
      max: 3_000_000
    })}`,
    `fundingFine=${signedRatioBucket(metrics.fundingRate, 'FUNDING_FINE', {
      stepBps: 1,
      maxBps: 100
    })}`,

    `rrFine=${numberBucket(metrics.rr, 'RR_FINE', {
      step: 0.1,
      min: 0,
      max: 10,
      decimals: 1
    })}`,
    `costFine=${numberBucket(costR, 'COST_R_FINE', {
      step: 0.05,
      min: 0,
      max: 2,
      decimals: 2
    })}`,
    `confluenceFine=${numberBucket(confluence, 'CONFLUENCE_FINE', {
      step: 2.5,
      min: 0,
      max: 100,
      decimals: 1
    })}`,

    `entryQuality=${normalizeToken(entryQuality(metrics))}`,
    `retest=${boolToken(metrics.retestConfirmed)}`,
    `pullback=${boolToken(metrics.pullbackConfirmed)}`,
    `sweep=${boolToken(metrics.sweepConfirmed)}`,
    `fakeBreakout=${boolToken(metrics.fakeBreakout)}`,
    `fakeBreakoutRisk=${boolToken(metrics.fakeBreakoutRisk)}`
  ];
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .flatMap((value) => {
        if (Array.isArray(value)) return value;

        return [value];
      })
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function classifyFamily(metrics = {}) {
  const sideSafeMetrics = {
    ...metrics,
    side: TARGET_TRADE_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE
  };

  const seedParts = [
    TARGET_TRADE_SIDE,
    coarseFlow(sideSafeMetrics.flow),
    coarseRsi(sideSafeMetrics.rsiZone),
    normalizeObRelation(sideSafeMetrics),
    coarseBtcState(TARGET_TRADE_SIDE, sideSafeMetrics.btcState),
    coarseRegime(sideSafeMetrics.regime)
  ];

  const bucket = (parseInt(stableHash(seedParts.join('|'), 6), 16) % 50) + 1;

  return `${TARGET_TRADE_SIDE}_${bucket}`;
}

export function buildMicroFamilyV1(metrics = {}) {
  const tradeSide = TARGET_TRADE_SIDE;

  const sideSafeMetrics = {
    ...metrics,
    side: tradeSide,
    tradeSide,
    positionSide: tradeSide,
    direction: tradeSide
  };

  const familyId = metrics.familyId && String(metrics.familyId).toUpperCase().startsWith(`${TARGET_TRADE_SIDE}_`)
    ? metrics.familyId
    : classifyFamily(sideSafeMetrics);

  const normalizedSide = TARGET_DASHBOARD_SIDE;
  const obRelation = normalizeObRelation(sideSafeMetrics);
  const btcRel = btcRelation(tradeSide, metrics.btcState);
  const regime = coarseRegime(metrics.regime);
  const flow = coarseFlow(metrics.flow);
  const scannerReason = coarseScannerReason(metrics.scannerReason);
  const definitionParts = buildMacroDefinitionParts(sideSafeMetrics, familyId);
  const hash = stableHash(definitionParts.join('|'), 8);
  const schema = getMacroSchema();

  const microFamilyId = `MICRO_${tradeSide}_${familyId}_${schema}_${hash}`;

  return {
    schema,
    version: 'macro',
    familyId,
    microFamilyId,
    macroFamilyId: microFamilyId,
    parentMacroFamilyId: null,
    parentMicroFamilyId: null,

    definition: definitionParts.join(' | '),
    definitionParts,

    side: normalizedSide,
    tradeSide,

    obRelation,
    btcRelation: btcRel,
    regime,
    flow,
    scannerReason,

    longOnly: true,
    shortDisabled: true,

    spreadBps: Number((safeNumber(getSpreadPct(metrics), 0) * 10000).toFixed(3))
  };
}

export function buildMicroFamilyV2(metrics = {}) {
  const tradeSide = TARGET_TRADE_SIDE;

  const sideSafeMetrics = {
    ...metrics,
    side: tradeSide,
    tradeSide,
    positionSide: tradeSide,
    direction: tradeSide
  };

  const parent = buildMicroFamilyV1(sideSafeMetrics);

  const baseDefinitionParts = buildMicroDefinitionParts(sideSafeMetrics, parent);
  const coarseHash = stableHash(baseDefinitionParts.join('|'), 8);
  const schema = getMicroSchema();

  const baseMicroFamilyId = `MICRO_${TARGET_TRADE_SIDE}_${parent.familyId}_${schema}_${coarseHash}`;

  const executionFingerprintParts = shouldRefineExecutionMicroIds()
    ? buildExecutionFingerprintParts(sideSafeMetrics, parent)
    : [];

  const executionFingerprintHash = executionFingerprintParts.length
    ? stableHash(executionFingerprintParts.join('|'), EXECUTION_MICRO_HASH_LEN)
    : null;

  const microFamilyId = executionFingerprintHash
    ? `${baseMicroFamilyId}_${EXECUTION_MICRO_SUFFIX}_${executionFingerprintHash}`
    : baseMicroFamilyId;

  const definitionParts = uniqueStrings([
    ...baseDefinitionParts,
    ...executionFingerprintParts,
    `coarseMicroFamilyId=${baseMicroFamilyId}`,
    executionFingerprintHash ? `executionFingerprintHash=${executionFingerprintHash}` : null,
    executionFingerprintHash ? `executionFingerprintSchema=${EXECUTION_MICRO_SUFFIX}` : null
  ].filter(Boolean));

  return {
    schema,
    version: 'micro',
    familyId: parent.familyId,
    microFamilyId,
    trueMicroFamilyId: microFamilyId,

    coarseMicroFamilyId: baseMicroFamilyId,
    baseMicroFamilyId,
    legacyMicroFamilyId: baseMicroFamilyId,

    executionFingerprintHash,
    executionFingerprintParts,
    executionFingerprintSchema: executionFingerprintHash ? EXECUTION_MICRO_SUFFIX : null,

    macroFamilyId: parent.microFamilyId,
    parentMacroFamilyId: parent.microFamilyId,
    parentMicroFamilyId: parent.microFamilyId,

    parentDefinition: parent.definition,
    parentDefinitionParts: parent.definitionParts,

    definition: definitionParts.join(' | '),
    definitionParts,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,

    assetClass: assetClass(sideSafeMetrics),

    obRelation: normalizeObRelation(sideSafeMetrics),
    btcRelation: btcRelation(TARGET_TRADE_SIDE, metrics.btcState),
    btcState: toUpper(metrics.btcState, 'NEUTRAL'),

    regime: exactRegime(metrics.regime),
    regimeCoarse: coarseRegime(metrics.regime),

    flow: exactFlow(metrics.flow),
    flowCoarse: coarseFlow(metrics.flow),

    scannerReason: exactScannerReason(metrics.scannerReason),
    scannerReasonCoarse: coarseScannerReason(metrics.scannerReason),

    rsiZone: exactRsiZone(metrics.rsiZone),
    rsiCoarse: coarseRsi(metrics.rsiZone),

    longOnly: true,
    shortDisabled: true,

    spreadBps: Number((safeNumber(getSpreadPct(metrics), 0) * 10000).toFixed(3)),
    entryDistanceBps: numericBps(getEntryDistancePct(metrics)),
    slDistanceBps: numericBps(getSlDistancePct(metrics)),
    tpDistanceBps: numericBps(getTpDistancePct(metrics)),
    liqDistanceBps: numericBps(getLiquidationDistancePct(metrics))
  };
}

export function buildMicroFamily(metrics = {}, options = {}) {
  const schema = toUpper(options.schema || options.version || getMicroSchema());

  const sideSafeMetrics = {
    ...metrics,
    side: TARGET_TRADE_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE
  };

  if (schema === getMacroSchema() || schema === 'V1' || schema === 'MACRO') {
    return buildMicroFamilyV1(sideSafeMetrics);
  }

  return buildMicroFamilyV2(sideSafeMetrics);
}

export function buildMicroFamilyForSide(metrics = {}, side = TARGET_TRADE_SIDE, options = {}) {
  const requestedSide = normalizeTradeSideValue(side);

  if (requestedSide !== TARGET_TRADE_SIDE) {
    throw new Error(`LONG_ONLY_MICRO_FAMILY_SYSTEM:${side}`);
  }

  return buildMicroFamily(
    {
      ...metrics,
      side: TARGET_TRADE_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      positionSide: TARGET_TRADE_SIDE,
      direction: TARGET_TRADE_SIDE
    },
    options
  );
}

export function classifyMacroFamily(metrics = {}) {
  return buildMicroFamilyV1(metrics);
}

export function classifyMicroFamily(metrics = {}) {
  return buildMicroFamilyV2(metrics);
}

export function getMicroFamilyId(metrics = {}, options = {}) {
  return buildMicroFamily(metrics, options).microFamilyId;
}

export function getParentMacroFamilyId(metrics = {}) {
  return buildMicroFamilyV1(metrics).microFamilyId;
}

export function isMicroFamilyV1Id(id) {
  const value = String(id || '').toUpperCase();

  return (
    value.includes(`_${getMacroSchema()}_`) &&
    value.includes('MICRO_LONG_')
  );
}

export function isMicroFamilyV2Id(id) {
  const value = String(id || '').toUpperCase();

  return (
    value.includes(`_${getMicroSchema()}_`) &&
    value.includes('MICRO_LONG_')
  );
}

export function isExecutionRefinedMicroFamilyId(id) {
  const value = String(id || '').toUpperCase();

  return (
    isMicroFamilyV2Id(value) &&
    value.includes(`_${EXECUTION_MICRO_SUFFIX}_`)
  );
}

export function attachMicroFamilies(metrics = {}) {
  const sideSafeMetrics = {
    ...metrics,
    side: TARGET_TRADE_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,
    longOnly: true,
    shortDisabled: true
  };

  const macro = buildMicroFamilyV1(sideSafeMetrics);
  const micro = buildMicroFamilyV2(sideSafeMetrics);

  return {
    ...metrics,

    side: micro.side,
    tradeSide: micro.tradeSide,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,

    familyId: micro.familyId,

    macroFamilyId: macro.microFamilyId,
    parentMacroFamilyId: macro.microFamilyId,
    parentMicroFamilyId: macro.microFamilyId,

    microFamilyId: micro.microFamilyId,
    trueMicroFamilyId: micro.trueMicroFamilyId || micro.microFamilyId,

    coarseMicroFamilyId: micro.coarseMicroFamilyId,
    baseMicroFamilyId: micro.baseMicroFamilyId,
    legacyMicroFamilyId: micro.legacyMicroFamilyId,

    executionFingerprintHash: micro.executionFingerprintHash,
    executionFingerprintParts: micro.executionFingerprintParts,
    executionFingerprintSchema: micro.executionFingerprintSchema,

    microFamilySchema: micro.schema,

    microFamilyDefinition: micro.definition,
    microFamilyDefinitionParts: micro.definitionParts,

    macroFamilyDefinition: macro.definition,
    macroFamilyDefinitionParts: macro.definitionParts
  };
}

export function attachMicroFamiliesForBothSides(metrics = {}) {
  const long = attachMicroFamilies({
    ...metrics,
    side: TARGET_TRADE_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE
  });

  return {
    short: null,
    long
  };
}