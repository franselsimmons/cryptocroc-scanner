// ================= FILE: src/analyze/microFamilies.js =================

import { CONFIG } from '../config.js';
import {
  getObRelation,
  sideToTradeSide,
  stableHash,
  safeNumber
} from '../utils.js';

const FALLBACK_MACRO_SCHEMA = 'MF_V1';
const FALLBACK_MICRO_SCHEMA = 'MF_V2';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';

const EXECUTION_MICRO_SUFFIX = 'XR';
const EXECUTION_MICRO_HASH_LEN = 10;

/*
  Bijna dezelfde precisie als eerst.
  Enige bewuste versoepeling:
  - liqDistance wordt niet meer gebruikt in de echte Analyze learning-hash.
  - liqDistance blijft wel metadata/debug.
*/
const LEARNING_GRANULARITY = 'LONG_PRECISE_TINY_LOOSER_V2';

const MIN_COMPLETED_ACTIVE_LEARNING = 20;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;

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
    CONFIG?.analyze?.legacySchema ||
    FALLBACK_MACRO_SCHEMA
  ).toUpperCase();
}

function getMicroSchema() {
  return String(
    CONFIG?.analyze?.microSchema ||
    FALLBACK_MICRO_SCHEMA
  ).toUpperCase();
}

function shouldBuildExecutionFingerprintMetadata() {
  return CONFIG.analyze?.buildExecutionFingerprintMetadata !== false;
}

function toUpper(value, fallback = 'UNKNOWN') {
  const raw = String(value ?? '').trim();

  if (!raw) return fallback;

  return raw.toUpperCase();
}

function boolToken(value) {
  return Boolean(value) ? 'YES' : 'NO';
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

function cleanSideText(value = '') {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replaceAll('SHORT_DISABLED_FALSE', '')
    .replaceAll('SHORTDISABLED_FALSE', '')
    .replaceAll('BLOCK_SHORT_FALSE', '')
    .replaceAll('SHORT_ENABLED_FALSE', '')
    .replaceAll('SHORT_ONLY_FALSE', '')
    .replaceAll('LONG_DISABLED_FALSE', '')
    .replaceAll('LONGDISABLED_FALSE', '')
    .replaceAll('LONG_ENABLED_FALSE', '')
    .replaceAll('SHORT_DISABLED', '')
    .replaceAll('SHORTDISABLED', '')
    .replaceAll('BLOCK_SHORT', '')
    .replaceAll('LONG_DISABLED_SHORT_ONLY', 'SHORT')
    .replaceAll('LONGDISABLED_SHORT_ONLY', 'SHORT')
    .replaceAll('BLOCK_LONG', 'SHORT')
    .replaceAll('LONG_DISABLED', 'SHORT')
    .replaceAll('LONGDISABLED', 'SHORT')
    .replaceAll('SHORT_ONLY_MODE', 'SHORT')
    .replaceAll('SHORT_ONLY', 'SHORT')
    .replaceAll('SHORT-ONLY', 'SHORT')
    .replaceAll('LONG_ONLY_MODE', 'LONG')
    .replaceAll('LONG_ONLY', 'LONG')
    .replaceAll('LONG-ONLY', 'LONG');
}

function normalizedSignalText(value = '') {
  return cleanSideText(value)
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function hasSignalPattern(value = '', patterns = []) {
  const text = normalizedSignalText(value);

  if (!text) return false;

  return patterns.some((pattern) => (
    text === pattern ||
    text.startsWith(`${pattern}_`) ||
    text.endsWith(`_${pattern}`) ||
    text.includes(`_${pattern}_`)
  ));
}

function hasLongSignal(value = '') {
  const text = normalizedSignalText(value);

  if (!text) return false;
  if (LONG_TOKENS.has(text)) return true;

  return hasSignalPattern(text, [
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
  const text = normalizedSignalText(value);

  if (!text) return false;
  if (SHORT_TOKENS.has(text)) return true;

  return hasSignalPattern(text, [
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

function tradeSideFromText(value = '') {
  const raw = cleanSideText(value);

  if (!raw) return 'UNKNOWN';

  const direct = sideToTradeSide(raw);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  const longHit = hasLongSignal(raw);
  const shortHit = hasShortSignal(raw);

  if (longHit && !shortHit) return TARGET_TRADE_SIDE;
  if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;
  if (longHit && shortHit) return 'MIXED';

  return 'UNKNOWN';
}

function normalizeTradeSideValue(value) {
  const side = tradeSideFromText(value);

  if (side === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
  if (side === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;

  return TARGET_TRADE_SIDE;
}

function inferSideFromValues(values = []) {
  let hasLong = false;
  let hasShort = false;

  for (const value of values) {
    const side = tradeSideFromText(value);

    if (side === TARGET_TRADE_SIDE) hasLong = true;
    if (side === OPPOSITE_TRADE_SIDE) hasShort = true;
  }

  if (hasLong && !hasShort) return TARGET_TRADE_SIDE;
  if (hasShort && !hasLong) return OPPOSITE_TRADE_SIDE;
  if (hasLong && hasShort) return 'MIXED';

  return 'UNKNOWN';
}

function inferSideFromIds(metrics = {}) {
  return inferSideFromValues([
    metrics.familyId,
    metrics.microFamilyId,
    metrics.macroFamilyId,
    metrics.parentMacroFamilyId,
    metrics.parentMicroFamilyId,
    metrics.trueMicroFamilyId,
    metrics.coarseMicroFamilyId,
    metrics.baseMicroFamilyId,
    metrics.legacyMicroFamilyId,
    metrics.id,
    metrics.key
  ]);
}

function inferSideFromScannerReason(metrics = {}) {
  return inferSideFromValues([
    metrics.scannerReason,
    metrics.reason,
    metrics.signalReason,
    metrics.actionReason
  ]);
}

function inferTradeSide(metrics = {}) {
  const directSide = inferSideFromValues([
    metrics.tradeSide,
    metrics.side,
    metrics.positionSide,
    metrics.direction,
    metrics.signalSide,
    metrics.scannerSide,
    metrics.actualScannerSide,
    metrics.analysisSide,
    metrics.expectedSide,
    metrics.predictedSide,
    metrics.intentSide,
    metrics.biasSide
  ]);

  if (directSide === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
  if (directSide === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;

  const idSide = inferSideFromIds(metrics);

  if (idSide === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
  if (idSide === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;

  const reasonSide = inferSideFromScannerReason(metrics);

  if (reasonSide === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
  if (reasonSide === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;

  if (metrics.longOnly === true || metrics.shortDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  if (metrics.shortOnly === true || metrics.longDisabled === true) {
    return OPPOSITE_TRADE_SIDE;
  }

  return TARGET_TRADE_SIDE;
}

function modeFlags() {
  return {
    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    virtualOnly: true,
    virtualLearning: true,
    virtualTracked: true,
    shadowOnly: true,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,
    noRealOrders: true,
    realOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    noExchangeOrders: true,

    observationFirst: true,
    observationAlwaysCounted: true,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    statusRules: {
      OBSERVING: 'completed == 0',
      EARLY_OUTCOMES: `completed > 0 && completed < ${MIN_COMPLETED_ACTIVE_LEARNING}`,
      ACTIVE_LEARNING: `completed >= ${MIN_COMPLETED_ACTIVE_LEARNING}`
    },

    defaultRanking: 'dashboardBalancedScore|balancedScore|fairWinrate',
    bareWinrateRankingDisabled: true,

    globalMaxOpenPositionsBlockDisabled: true,
    maxOneOpenPositionPerSymbol: true,
    positionTimeStopMinDefault: DEFAULT_POSITION_TIME_STOP_MIN,

    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForExactTrueMicroMatch: true,

    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerFingerprintRole: 'METADATA_ONLY',

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,

    bucketGranularity: 'LOW_MID_HIGH',
    bucketsCoarseOnly: true,

    autoRotationDisabled: true,
    activateNextDisabled: true,
    freezeCronDisabled: true,
    activateCronDisabled: true,
    resetCronDisabled: true,

    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    shortRootTouched: false
  };
}

function assertLongOnly(metrics = {}) {
  const side = inferTradeSide(metrics);

  if (side === OPPOSITE_TRADE_SIDE) {
    const error = new Error('LONG_ONLY_MICRO_FAMILY_SYSTEM:SHORT_DISABLED');
    error.reason = 'SHORT_DISABLED_LONG_ONLY';
    error.tradeSide = OPPOSITE_TRADE_SIDE;
    throw error;
  }

  return {
    ...metrics,
    ...modeFlags()
  };
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

function threeTier(value, {
  prefix,
  low,
  high,
  scale = 1,
  fallback = 'NA',
  lowLabel = 'LOW',
  midLabel = 'MID',
  highLabel = 'HIGH'
} = {}) {
  const n = safeNumber(value, NaN);

  if (!Number.isFinite(n)) return `${prefix}_${fallback}`;

  const scaled = n * scale;

  if (scaled < low) return `${prefix}_${lowLabel}`;
  if (scaled >= high) return `${prefix}_${highLabel}`;

  return `${prefix}_${midLabel}`;
}

function signedThreeTier(value, {
  prefix,
  low = -0.25,
  high = 0.25,
  fallback = 'NA',
  lowLabel = 'NEG',
  midLabel = 'MID',
  highLabel = 'POS'
} = {}) {
  const n = safeNumber(value, NaN);

  if (!Number.isFinite(n)) return `${prefix}_${fallback}`;
  if (n < low) return `${prefix}_${lowLabel}`;
  if (n >= high) return `${prefix}_${highLabel}`;

  return `${prefix}_${midLabel}`;
}

function pctThreeTier(value, {
  prefix,
  lowBps,
  highBps,
  fallback = 'NA',
  lowLabel = 'NEAR',
  midLabel = 'MID',
  highLabel = 'FAR'
} = {}) {
  const bps = ratioToBps(value);

  if (!Number.isFinite(bps)) return `${prefix}_${fallback}`;
  if (bps < lowBps) return `${prefix}_${lowLabel}`;
  if (bps >= highBps) return `${prefix}_${highLabel}`;

  return `${prefix}_${midLabel}`;
}

function scoreTier(score, prefix) {
  return threeTier(score, {
    prefix,
    low: 35,
    high: 70
  });
}

function signedScoreTier(score, prefix) {
  return signedThreeTier(score, {
    prefix,
    low: -35,
    high: 35,
    lowLabel: 'NEG',
    midLabel: 'FLAT',
    highLabel: 'POS'
  });
}

function spreadTier(value) {
  const bps = ratioToBps(value);

  if (!Number.isFinite(bps)) return 'SPREAD_NA';
  if (bps < 4) return 'SPREAD_TIGHT';
  if (bps >= 15) return 'SPREAD_WIDE';

  return 'SPREAD_NORMAL';
}

function volatilityTier(value) {
  const bps = ratioToBps(value);

  if (!Number.isFinite(bps)) return 'VOL_NA';
  if (bps < 100) return 'VOL_LOW';
  if (bps >= 400) return 'VOL_HIGH';

  return 'VOL_MID';
}

function depthTier(value) {
  const usd = safeNumber(value, NaN);

  if (!Number.isFinite(usd)) return 'DEPTH_NA';
  if (usd < 50_000) return 'DEPTH_LOW';
  if (usd >= 300_000) return 'DEPTH_HIGH';

  return 'DEPTH_MID';
}

function rrTier(rr) {
  const r = safeNumber(rr, NaN);

  if (!Number.isFinite(r)) return 'RR_NA';
  if (r < 1.2) return 'RR_LOW';
  if (r >= 2.0) return 'RR_HIGH';

  return 'RR_MID';
}

function fundingTier(value) {
  const n = safeNumber(value, NaN);

  if (!Number.isFinite(n)) return 'FUNDING_NA';
  if (n < -0.0001) return 'FUNDING_NEG';
  if (n > 0.0001) return 'FUNDING_POS';

  return 'FUNDING_FLAT';
}

function costTier(costR) {
  const c = safeNumber(costR, NaN);

  if (!Number.isFinite(c)) return 'COST_R_NA';
  if (c < 0.15) return 'COST_R_LOW';
  if (c >= 0.35) return 'COST_R_HIGH';

  return 'COST_R_MID';
}

function coarseRsi(zone) {
  const z = toUpper(zone, 'MID');

  if (z.startsWith('LOWER') || z.includes('OVERSOLD')) return 'LOWER';
  if (z.startsWith('UPPER') || z.includes('OVERBOUGHT')) return 'UPPER';

  return 'MID';
}

function tier(score) {
  const s = safeNumber(score, NaN);

  if (!Number.isFinite(s)) return 'NA';
  if (s >= 70) return 'HIGH';
  if (s >= 35) return 'MID';

  return 'LOW';
}

function scoreBucket(score, prefix) {
  return scoreTier(score, prefix);
}

function signedScoreBucket(score, prefix) {
  return signedScoreTier(score, prefix);
}

function bucketDistancePct(value, prefix) {
  return pctThreeTier(value, {
    prefix,
    lowBps: 25,
    highBps: 150,
    lowLabel: 'NEAR',
    midLabel: 'MID',
    highLabel: 'FAR'
  });
}

function bucketVolatilityPct(value) {
  return volatilityTier(value);
}

function microDepthBucket(value) {
  return depthTier(value);
}

function rrMicroBucket(rr) {
  return rrTier(rr);
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

  if (btc === 'NEUTRAL' || btc === 'UNKNOWN' || btc === 'NA') return 'BTC_NEUTRAL';

  if (['BULLISH', 'STRONG_BULL', 'BULL', 'UP'].includes(btc)) {
    return 'BTC_WITH';
  }

  return 'BTC_AGAINST';
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

function coarseFlow(flow) {
  const f = toUpper(flow, 'NEUTRAL');

  if (['TREND', 'IMPULSE', 'PUMP', 'BUY_IMPULSE'].includes(f)) return 'TREND';
  if (f === 'BUILDING') return 'BUILDING';

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

  if (majors.has(symbol)) return 'SYMBOL_MAJOR';
  if (memes.has(symbol)) return 'SYMBOL_MEME';

  return 'SYMBOL_ALT';
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

function isScannerFamilyId(id = '') {
  const value = String(id || '').toUpperCase();

  return (
    value.startsWith('MICRO_LONG_SCANNER__') ||
    value.includes('MICRO_LONG_SCANNER__') ||
    value.startsWith('LONG_SCANNER_') ||
    value.startsWith('MICRO_SHORT_SCANNER__') ||
    value.includes('MICRO_SHORT_SCANNER__') ||
    value.startsWith('SHORT_SCANNER_') ||
    value.includes('__SCANNER__')
  );
}

function isAnalyzeFamilyId(id = '') {
  const value = String(id || '').toUpperCase();

  if (!value) return false;
  if (isScannerFamilyId(value)) return false;

  return (
    /^LONG_F\d{2}$/u.test(value) ||
    (
      value.startsWith('LONG_') &&
      !value.startsWith('LONG_SCANNER_')
    )
  );
}

function getScannerMetadata(metrics = {}) {
  const scannerMicroFamilyId = firstValue(
    metrics.scannerMicroFamilyId,
    isScannerFamilyId(metrics.trueMicroFamilyId) ? metrics.trueMicroFamilyId : null,
    isScannerFamilyId(metrics.microFamilyId) ? metrics.microFamilyId : null,
    isScannerFamilyId(metrics.id) ? metrics.id : null,
    isScannerFamilyId(metrics.key) ? metrics.key : null
  );

  const scannerFamilyId = firstValue(
    metrics.scannerFamilyId,
    isScannerFamilyId(metrics.familyId) ? metrics.familyId : null,
    isScannerFamilyId(metrics.baseFamilyId) ? metrics.baseFamilyId : null
  );

  const scannerDefinitionParts = Array.isArray(metrics.scannerDefinitionParts)
    ? metrics.scannerDefinitionParts
    : Array.isArray(metrics.definitionParts) && scannerMicroFamilyId
      ? metrics.definitionParts
      : [];

  const scannerDefinition = firstValue(
    metrics.scannerDefinition,
    scannerMicroFamilyId ? metrics.definition : null,
    scannerMicroFamilyId ? metrics.microDefinition : null
  );

  return {
    scannerMicroFamilyId: scannerMicroFamilyId || null,
    scannerFamilyId: scannerFamilyId || null,
    scannerDefinition: scannerDefinition || null,
    scannerDefinitionParts
  };
}

function resolveAnalyzeFamilyId(metrics = {}) {
  const candidate = firstValue(
    metrics.analyzeFamilyId,
    metrics.learningFamilyId,
    metrics.familyId
  );

  if (isAnalyzeFamilyId(candidate)) {
    return String(candidate).toUpperCase();
  }

  return classifyFamily(metrics);
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

    `rsi=${coarseRsi(metrics.rsiZone)}`,
    `flow=${flow}`,
    `obRelation=${obRelation}`,
    `btcRelation=${btcRel}`,
    `regime=${regime}`,

    `confluenceTier=${tier(getConfluenceScore(metrics))}`,
    `rrTier=${rrTier(metrics.rr)}`,
    `spreadTier=${spreadTier(getSpreadPct(metrics))}`,
    `depthTier=${depthTier(metrics.depthMinUsd1p)}`,
    `fundingTier=${fundingTier(metrics.fundingRate)}`,

    `entryQuality=${entryQuality(metrics)}`,
    `fakeBreakout=${boolToken(metrics.fakeBreakout)}`,
    `scannerReason=${scannerReason}`
  ];
}

/*
  Dit is de echte Analyze learning-ID.

  Hij is maar heel klein beetje losser dan eerst:
  - parent blijft parent.microFamilyId
  - entryDistance blijft erin
  - risk/slDistance blijft erin
  - reward/tpDistance blijft erin
  - spoof blijft erin
  - spread/depth/funding/cost blijven erin
  - alleen liqDistance is eruit gehaald om mini-versnippering te verminderen

  liqDistance wordt later nog wel als metadata/debug toegevoegd.
*/
function buildMicroDefinitionParts(metrics = {}, parent) {
  const spreadPct = getSpreadPct(metrics);
  const entryDistancePct = getEntryDistancePct(metrics);
  const slDistancePct = getSlDistancePct(metrics);
  const tpDistancePct = getTpDistancePct(metrics);
  const volatilityPct = getVolatilityPct(metrics);
  const spoofScore = getSpoofScore(metrics);
  const orderbookImbalance = getOrderbookImbalance(metrics);
  const rsiSlope = getRsiSlope(metrics);
  const costR = getCostR(metrics);

  return [
    `schema=${getMicroSchema()}`,
    `granularity=${LEARNING_GRANULARITY}`,
    `parent=${parent.microFamilyId}`,
    `side=${TARGET_DASHBOARD_SIDE}`,
    `tradeSide=${TARGET_TRADE_SIDE}`,
    `family=${parent.familyId}`,

    `assetClass=${assetClass(metrics)}`,
    `symbolClass=${symbolClassBucket(metrics)}`,

    `rsi=${coarseRsi(metrics.rsiZone)}`,
    `rsiSlope=${signedScoreBucket(rsiSlope, 'RSI_SLOPE')}`,

    `flow=${coarseFlow(metrics.flow)}`,

    `obRelation=${normalizeObRelation(metrics)}`,
    `obImbalance=${signedThreeTier(orderbookImbalance, {
      prefix: 'OB_IMB',
      low: -0.25,
      high: 0.25,
      lowLabel: 'ASK_HEAVY',
      midLabel: 'BALANCED',
      highLabel: 'BID_HEAVY'
    })}`,
    `spoof=${scoreBucket(spoofScore, 'SPOOF')}`,

    `btcState=${btcRelation(TARGET_TRADE_SIDE, metrics.btcState)}`,

    `regime=${coarseRegime(metrics.regime)}`,
    `vol=${bucketVolatilityPct(volatilityPct)}`,

    `confluence=${scoreBucket(getConfluenceScore(metrics), 'CONF')}`,

    `rr=${rrMicroBucket(metrics.rr)}`,

    `spread=${spreadTier(spreadPct)}`,
    `depth=${microDepthBucket(metrics.depthMinUsd1p)}`,
    `funding=${fundingTier(metrics.fundingRate)}`,

    `entryQuality=${entryQuality(metrics)}`,
    `entryDistance=${bucketDistancePct(entryDistancePct, 'ENTRY_DIST')}`,
    `slDistance=${pctThreeTier(slDistancePct, {
      prefix: 'RISK',
      lowBps: 70,
      highBps: 200,
      lowLabel: 'TIGHT',
      midLabel: 'NORMAL',
      highLabel: 'WIDE'
    })}`,
    `tpDistance=${pctThreeTier(tpDistancePct, {
      prefix: 'REWARD',
      lowBps: 100,
      highBps: 350,
      lowLabel: 'SMALL',
      midLabel: 'NORMAL',
      highLabel: 'LARGE'
    })}`,

    `cost=${costTier(costR)}`,

    `fakeBreakout=${boolToken(metrics.fakeBreakout)}`,
    `fakeBreakoutRisk=${boolToken(metrics.fakeBreakoutRisk)}`,
    `scannerReason=${coarseScannerReason(metrics.scannerReason)}`
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

    `assetClass=${normalizeToken(assetClass(metrics))}`,
    `symbolClass=${symbolClassBucket(metrics)}`,

    `rsi=${normalizeToken(coarseRsi(metrics.rsiZone))}`,
    `rsiSlope=${signedScoreBucket(rsiSlope, 'RSI_SLOPE')}`,

    `flow=${normalizeToken(coarseFlow(metrics.flow))}`,

    `obRelation=${normalizeToken(normalizeObRelation(metrics))}`,
    `obImb=${signedThreeTier(orderbookImbalance, {
      prefix: 'OB_IMB',
      low: -0.25,
      high: 0.25,
      lowLabel: 'ASK_HEAVY',
      midLabel: 'BALANCED',
      highLabel: 'BID_HEAVY'
    })}`,
    `spoof=${scoreBucket(spoofScore, 'SPOOF')}`,

    `btc=${normalizeToken(btcRelation(TARGET_TRADE_SIDE, metrics.btcState))}`,

    `regime=${normalizeToken(coarseRegime(metrics.regime))}`,

    `scanner=${normalizeToken(coarseScannerReason(scannerReason))}`,

    `spread=${spreadTier(spreadPct)}`,
    `entryDist=${bucketDistancePct(entryDistancePct, 'ENTRY_DIST')}`,
    `risk=${pctThreeTier(slDistancePct, {
      prefix: 'RISK',
      lowBps: 70,
      highBps: 200,
      lowLabel: 'TIGHT',
      midLabel: 'NORMAL',
      highLabel: 'WIDE'
    })}`,
    `reward=${pctThreeTier(tpDistancePct, {
      prefix: 'REWARD',
      lowBps: 100,
      highBps: 350,
      lowLabel: 'SMALL',
      midLabel: 'NORMAL',
      highLabel: 'LARGE'
    })}`,
    `liqDist=${pctThreeTier(liqDistancePct, {
      prefix: 'LIQ_DIST',
      lowBps: 100,
      highBps: 500,
      lowLabel: 'NEAR',
      midLabel: 'MID',
      highLabel: 'FAR'
    })}`,
    `vol=${bucketVolatilityPct(volatilityPct)}`,

    `depth=${depthTier(metrics.depthMinUsd1p)}`,
    `funding=${fundingTier(metrics.fundingRate)}`,

    `rr=${rrTier(metrics.rr)}`,
    `cost=${costTier(costR)}`,
    `confluence=${scoreBucket(confluence, 'CONF')}`,

    `entryQuality=${normalizeToken(entryQuality(metrics))}`,
    `fakeBreakout=${boolToken(metrics.fakeBreakout)}`,
    `fakeBreakoutRisk=${boolToken(metrics.fakeBreakoutRisk)}`
  ];
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function classifyFamily(metrics = {}) {
  const sideSafeMetrics = assertLongOnly(metrics);

  const seedParts = [
    TARGET_TRADE_SIDE,
    coarseFlow(sideSafeMetrics.flow),
    coarseRsi(sideSafeMetrics.rsiZone),
    normalizeObRelation(sideSafeMetrics),
    coarseBtcState(TARGET_TRADE_SIDE, sideSafeMetrics.btcState),
    coarseRegime(sideSafeMetrics.regime),
    rrTier(sideSafeMetrics.rr),
    scoreTier(getConfluenceScore(sideSafeMetrics), 'CONF')
  ];

  const bucket = (parseInt(stableHash(seedParts.join('|'), 6), 16) % 24) + 1;

  return `${TARGET_TRADE_SIDE}_F${String(bucket).padStart(2, '0')}`;
}

export function buildMicroFamilyV1(metrics = {}) {
  const sideSafeMetrics = assertLongOnly(metrics);
  const tradeSide = TARGET_TRADE_SIDE;

  const familyId = resolveAnalyzeFamilyId(sideSafeMetrics);

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
    positionSide: tradeSide,
    direction: tradeSide,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    obRelation,
    btcRelation: btcRel,
    regime,
    flow,
    scannerReason,

    ...modeFlags(),

    spreadBps: Number((safeNumber(getSpreadPct(metrics), 0) * 10000).toFixed(3))
  };
}

export function buildMicroFamilyV2(metrics = {}) {
  const sideSafeMetrics = assertLongOnly(metrics);
  const tradeSide = TARGET_TRADE_SIDE;

  const scannerMetadata = getScannerMetadata(sideSafeMetrics);
  const parent = buildMicroFamilyV1(sideSafeMetrics);

  const baseDefinitionParts = buildMicroDefinitionParts(sideSafeMetrics, parent);
  const coarseHash = stableHash(baseDefinitionParts.join('|'), 8);
  const schema = getMicroSchema();

  const analyzeMicroFamilyId = `MICRO_${TARGET_TRADE_SIDE}_${parent.familyId}_${schema}_${coarseHash}`;

  const executionFingerprintParts = shouldBuildExecutionFingerprintMetadata()
    ? buildExecutionFingerprintParts(sideSafeMetrics, parent)
    : [];

  const executionFingerprintHash = executionFingerprintParts.length
    ? stableHash(executionFingerprintParts.join('|'), EXECUTION_MICRO_HASH_LEN)
    : null;

  const liqDistancePct = getLiquidationDistancePct(sideSafeMetrics);

  const definitionParts = uniqueStrings([
    ...baseDefinitionParts,
    `liqDistanceMetadataOnly=${pctThreeTier(liqDistancePct, {
      prefix: 'LIQ_DIST',
      lowBps: 100,
      highBps: 500,
      lowLabel: 'NEAR',
      midLabel: 'MID',
      highLabel: 'FAR'
    })}`,
    `analyzeMicroFamilyId=${analyzeMicroFamilyId}`,
    `trueMicroFamilyId=${analyzeMicroFamilyId}`,
    `coarseMicroFamilyId=${analyzeMicroFamilyId}`,
    `learningGranularity=${LEARNING_GRANULARITY}`,
    `learningIdentity=ANALYZE_TRUE_MICRO_FAMILY`,
    `scannerFingerprintRole=METADATA_ONLY`,
    `executionFingerprintRole=METADATA_ONLY`
  ]);

  return {
    schema,
    version: 'micro',

    familyId: parent.familyId,

    microFamilyId: analyzeMicroFamilyId,
    trueMicroFamilyId: analyzeMicroFamilyId,

    coarseMicroFamilyId: analyzeMicroFamilyId,
    baseMicroFamilyId: analyzeMicroFamilyId,
    legacyMicroFamilyId: analyzeMicroFamilyId,

    analyzeMicroFamilyId,
    learningMicroFamilyId: analyzeMicroFamilyId,

    learningGranularity: LEARNING_GRANULARITY,
    learningHashInputParts: baseDefinitionParts,

    scannerMicroFamilyId: scannerMetadata.scannerMicroFamilyId,
    scannerFamilyId: scannerMetadata.scannerFamilyId,
    scannerDefinition: scannerMetadata.scannerDefinition,
    scannerDefinitionParts: scannerMetadata.scannerDefinitionParts,

    executionFingerprintHash,
    executionFingerprintParts,
    executionFingerprintSchema: executionFingerprintHash ? EXECUTION_MICRO_SUFFIX : null,
    executionMicroFamilyId: executionFingerprintHash
      ? `${analyzeMicroFamilyId}_${EXECUTION_MICRO_SUFFIX}_${executionFingerprintHash}`
      : null,
    executionFingerprintRole: 'METADATA_ONLY',

    macroFamilyId: parent.microFamilyId,
    parentMacroFamilyId: parent.microFamilyId,
    parentMicroFamilyId: parent.microFamilyId,

    parentDefinition: parent.definition,
    parentDefinitionParts: parent.definitionParts,

    definition: definitionParts.join(' | '),
    definitionParts,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    assetClass: assetClass(sideSafeMetrics),

    obRelation: normalizeObRelation(sideSafeMetrics),
    btcRelation: btcRelation(TARGET_TRADE_SIDE, metrics.btcState),
    btcState: toUpper(metrics.btcState, 'NEUTRAL'),

    regime: coarseRegime(metrics.regime),
    regimeCoarse: coarseRegime(metrics.regime),

    flow: coarseFlow(metrics.flow),
    flowCoarse: coarseFlow(metrics.flow),

    scannerReason: coarseScannerReason(metrics.scannerReason),
    scannerReasonCoarse: coarseScannerReason(metrics.scannerReason),

    rsiZone: coarseRsi(metrics.rsiZone),
    rsiCoarse: coarseRsi(metrics.rsiZone),

    ...modeFlags(),

    spreadBps: Number((safeNumber(getSpreadPct(metrics), 0) * 10000).toFixed(3)),
    entryDistanceBps: numericBps(getEntryDistancePct(metrics)),
    slDistanceBps: numericBps(getSlDistancePct(metrics)),
    tpDistanceBps: numericBps(getTpDistancePct(metrics)),
    liqDistanceBps: numericBps(getLiquidationDistancePct(metrics))
  };
}

export function buildMicroFamily(metrics = {}, options = {}) {
  const sideSafeMetrics = assertLongOnly(metrics);
  const schema = toUpper(options.schema || options.version || getMicroSchema());

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
      ...modeFlags()
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
    value.includes('MICRO_LONG_') &&
    !isScannerFamilyId(value)
  );
}

export function isMicroFamilyV2Id(id) {
  const value = String(id || '').toUpperCase();

  return (
    value.includes(`_${getMicroSchema()}_`) &&
    value.includes('MICRO_LONG_') &&
    !isScannerFamilyId(value)
  );
}

export function isExecutionRefinedMicroFamilyId(id) {
  const value = String(id || '').toUpperCase();

  return (
    isMicroFamilyV2Id(value) &&
    value.includes(`_${EXECUTION_MICRO_SUFFIX}_`)
  );
}

export function isScannerMicroFamilyId(id) {
  return isScannerFamilyId(id);
}

export function attachMicroFamilies(metrics = {}) {
  const sideSafeMetrics = assertLongOnly(metrics);

  const scannerMetadata = getScannerMetadata(sideSafeMetrics);
  const macro = buildMicroFamilyV1(sideSafeMetrics);
  const micro = buildMicroFamilyV2(sideSafeMetrics);

  return {
    ...metrics,

    side: micro.side,
    tradeSide: micro.tradeSide,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    familyId: micro.familyId,

    macroFamilyId: macro.microFamilyId,
    parentMacroFamilyId: macro.microFamilyId,
    parentMicroFamilyId: macro.microFamilyId,

    microFamilyId: micro.microFamilyId,
    trueMicroFamilyId: micro.trueMicroFamilyId || micro.microFamilyId,

    coarseMicroFamilyId: micro.coarseMicroFamilyId,
    baseMicroFamilyId: micro.baseMicroFamilyId,
    legacyMicroFamilyId: micro.legacyMicroFamilyId,

    analyzeMicroFamilyId: micro.analyzeMicroFamilyId,
    learningMicroFamilyId: micro.learningMicroFamilyId,

    learningGranularity: micro.learningGranularity,
    learningHashInputParts: micro.learningHashInputParts,

    scannerMicroFamilyId: scannerMetadata.scannerMicroFamilyId || micro.scannerMicroFamilyId,
    scannerFamilyId: scannerMetadata.scannerFamilyId || micro.scannerFamilyId,
    scannerDefinition: scannerMetadata.scannerDefinition || micro.scannerDefinition,
    scannerDefinitionParts: scannerMetadata.scannerDefinitionParts?.length
      ? scannerMetadata.scannerDefinitionParts
      : micro.scannerDefinitionParts,

    executionFingerprintHash: micro.executionFingerprintHash,
    executionFingerprintParts: micro.executionFingerprintParts,
    executionFingerprintSchema: micro.executionFingerprintSchema,
    executionMicroFamilyId: micro.executionMicroFamilyId,
    executionFingerprintRole: 'METADATA_ONLY',

    microFamilySchema: micro.schema,

    microFamilyDefinition: micro.definition,
    microFamilyDefinitionParts: micro.definitionParts,

    macroFamilyDefinition: macro.definition,
    macroFamilyDefinitionParts: macro.definitionParts,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    defaultRanking: 'dashboardBalancedScore|balancedScore|fairWinrate',
    bareWinrateRankingDisabled: true,

    bucketGranularity: 'LOW_MID_HIGH',
    bucketsCoarseOnly: true,

    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    shortRootTouched: false,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,
    noRealOrders: true,
    realOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    noExchangeOrders: true
  };
}

export function attachMicroFamiliesForBothSides(metrics = {}) {
  const long = attachMicroFamilies({
    ...metrics,
    ...modeFlags()
  });

  return {
    long,
    short: null
  };
}