// ================= FILE: src/market/fakeBreakout.js =================

import {
  getRecentRange,
  calcVolumeExpansion,
  candleBodyPct
} from './indicators.js';
import {
  safeNumber,
  sideToTradeSide
} from '../utils.js';

const DEFAULT_LOOKBACK = 24;

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_SCANNER_SIDE = 'bull';
const TARGET_DASHBOARD_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = TRUE_MICRO_SCHEMA;
const LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_V1';

const RETEST_TOLERANCE_PCT = 0.004;
const BREAKOUT_BUFFER_PCT = 0.0015;
const WICK_REJECT_THRESHOLD = 0.45;
const WEAK_BODY_THRESHOLD = 0.35;
const EXHAUSTION_VOLUME_EXPANSION = 1.4;

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

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function longMachineFlags() {
  return {
    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_SCANNER_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    scannerSide: TARGET_SCANNER_SIDE,
    actualScannerSide: TARGET_SCANNER_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    directionalSide: TARGET_DASHBOARD_SIDE,
    inferredDirectionalSide: TARGET_DASHBOARD_SIDE,
    marketSide: TARGET_DASHBOARD_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    virtualLearning: true,
    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: true,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    exchangeCallsDisabled: true,

    scannerBullishOnly: true,
    scannerDoesNotTrade: true,
    scannerDoesNotSelectMicroFamilies: true,
    scannerDoesNotSendDiscord: true,
    scannerDoesNotWriteLearningFamilies: true,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    executionFingerprintRole: 'METADATA_ONLY',
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    exactTrueMicroFamilyRequired: true,
    fixedTaxonomyPreferred: true,

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentLearningEnabled: true,
    childLearningEnabled: true,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    selectionGranularity: 'EXACT_75_CHILD',
    fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED',

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    discordOnlyForExactTrueMicroMatch: true,

    bucketGranularity: 'LOW_MID_HIGH',
    bucketsCoarseOnly: true,

    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    shortRootTouched: false
  };
}

function learningIdentityPlaceholders() {
  return {
    trueMicroFamilyId: null,
    microFamilyId: null,
    childTrueMicroFamilyId: null,
    parentTrueMicroFamilyId: null,
    coarseMicroFamilyId: null,
    analyzeMicroFamilyId: null,
    learningMicroFamilyId: null,
    broadTrueMicroFamilyId: null,
    fixedTaxonomyMicroFamilyId: null,

    scannerMicroFamilyId: null,
    scannerFamilyId: null,
    scannerDefinition: null,
    scannerDefinitionParts: [],

    executionMicroFamilyId: null,
    executionFingerprintHash: null,
    executionFingerprintParts: [],
    executionFingerprintSchema: null,

    scannerBucketRole: 'DEBUG_METADATA_ONLY',
    legacy25BucketRole: 'DEBUG_METADATA_ONLY',
    coinNameRole: 'DEBUG_METADATA_ONLY',
    hashesRole: 'DEBUG_METADATA_ONLY'
  };
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
    .replaceAll('SHORT_DISABLED_LONG_ONLY', '')
    .replaceAll('SHORTDISABLED_LONG_ONLY', '')
    .replaceAll('SHORT_DISABLED', '')
    .replaceAll('SHORTDISABLED', '')
    .replaceAll('BLOCK_SHORT', '')
    .replaceAll('LONG_DISABLED_FALSE', '')
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

function textHasShortSignal(value = '') {
  const raw = cleanSideText(value);

  if (!raw) return false;
  if (SHORT_TOKENS.has(raw)) return true;

  return hasSignalPattern(raw, [
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

function textHasLongSignal(value = '') {
  const raw = cleanSideText(value);

  if (!raw) return false;
  if (LONG_TOKENS.has(raw)) return true;

  return hasSignalPattern(raw, [
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

function normalizeSide(side) {
  const raw = cleanSideText(side);

  if (!raw) return 'unknown';

  const direct = sideToTradeSide(raw);

  if (direct === TARGET_TRADE_SIDE) return TARGET_SCANNER_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return 'short_disabled';

  const shortHit = textHasShortSignal(raw);
  const longHit = textHasLongSignal(raw);

  if (shortHit && !longHit) return 'short_disabled';
  if (longHit && !shortHit) return TARGET_SCANNER_SIDE;

  if (longHit) return TARGET_SCANNER_SIDE;
  if (shortHit) return 'short_disabled';

  if (raw === TARGET_DASHBOARD_SIDE.toUpperCase()) return TARGET_SCANNER_SIDE;

  return 'unknown';
}

function normalizeBtcState(btcState) {
  return upper(btcState || 'NEUTRAL');
}

function isBtcAgainstBull(btcState) {
  return ['BEARISH', 'STRONG_BEAR', 'BEAR', 'DOWN'].includes(upper(btcState));
}

function isBtcWithBull(btcState) {
  return ['BULLISH', 'STRONG_BULL', 'BULL', 'UP'].includes(upper(btcState));
}

function scannerBucketFromBreakout({
  fake,
  fakeBreakoutRisk,
  validBreakout,
  sweptHigh,
  retestConfirmed,
  pullbackConfirmed,
  volumeExpansion
}) {
  if (fake) return 'BULL_FAKE_BREAKOUT_HIGH_SWEEP';
  if (fakeBreakoutRisk) return 'BULL_BREAKOUT_RISK';
  if (validBreakout && retestConfirmed) return 'BULL_BREAKOUT_RETEST_CONFIRMED';
  if (validBreakout) return 'BULL_VALID_BREAKOUT';
  if (sweptHigh) return 'BULL_HIGH_SWEEP';
  if (pullbackConfirmed) return 'BULL_PULLBACK_IN_RANGE';
  if (volumeExpansion >= EXHAUSTION_VOLUME_EXPANSION) return 'BULL_VOLUME_EXPANSION';

  return 'BULL_RANGE_NEUTRAL';
}

function baseResult(reason = null) {
  return {
    fakeBreakout: false,
    fakeBreakoutRisk: false,
    fakeBreakoutReason: null,

    breakoutType: 'UNKNOWN',
    breakoutValid: false,
    longContinuation: false,
    shortContinuation: false,
    avoidLong: false,
    avoidShort: false,

    pullbackConfirmed: false,
    sweepConfirmed: false,
    retestConfirmed: false,

    setupTypeHint: null,
    regimeBucketHint: null,
    confirmationProfileHint: null,
    analyzeSetupHintSource: 'MARKET_METADATA_ONLY',

    rangeHigh: null,
    rangeLow: null,
    volumeExpansion: 0,

    scannerBucket: reason || 'BULL_BREAKOUT_UNCLASSIFIED',
    legacy25Bucket: null,

    reason,
    createdAt: now(),

    ...learningIdentityPlaceholders(),
    ...longMachineFlags()
  };
}

function emptyResult(reason = 'INSUFFICIENT_DATA') {
  return {
    ...baseResult(reason),
    breakoutType: 'NONE',
    scannerBucket: reason,
    side: 'unknown',
    tradeSide: 'UNKNOWN',
    positionSide: 'UNKNOWN',
    direction: 'UNKNOWN',
    scannerSide: 'UNKNOWN',
    actualScannerSide: 'UNKNOWN',
    analysisSide: 'UNKNOWN',
    directionalSide: 'unknown',
    inferredDirectionalSide: 'unknown',
    marketSide: 'unknown'
  };
}

function pctDistance(a, b) {
  const x = safeNumber(a, 0);
  const y = safeNumber(b, 0);

  if (x <= 0 || y <= 0) return Infinity;

  return Math.abs(x - y) / Math.max(x, y);
}

function normalizeCandle(candle = {}) {
  return {
    ...candle,
    open: safeNumber(candle.open, 0),
    high: safeNumber(candle.high, 0),
    low: safeNumber(candle.low, 0),
    close: safeNumber(candle.close, 0),
    volume: safeNumber(candle.volume ?? candle.baseVolume ?? candle.vol, 0),
    ts: safeNumber(candle.ts ?? candle.time ?? candle.timestamp, 0)
  };
}

function validCandle(candle = {}) {
  return (
    safeNumber(candle.open, 0) > 0 &&
    safeNumber(candle.high, 0) > 0 &&
    safeNumber(candle.low, 0) > 0 &&
    safeNumber(candle.close, 0) > 0 &&
    safeNumber(candle.high, 0) >= safeNumber(candle.low, 0)
  );
}

function upperWickPct(candle = {}) {
  const high = safeNumber(candle.high, 0);
  const low = safeNumber(candle.low, 0);
  const open = safeNumber(candle.open, 0);
  const close = safeNumber(candle.close, 0);

  const range = high - low;

  if (range <= 0) return 0;

  const bodyTop = Math.max(open, close);
  const wick = Math.max(0, high - bodyTop);

  return wick / range;
}

function inferSetupHint({
  fake,
  sweptHigh,
  validBreakout,
  retestConfirmed,
  pullbackConfirmed,
  volumeExpansion
}) {
  if (fake || sweptHigh) return 'SWEEP_REVERSAL';
  if (validBreakout && retestConfirmed) return 'RETEST';
  if (pullbackConfirmed) return 'RETEST';
  if (volumeExpansion >= EXHAUSTION_VOLUME_EXPANSION) return 'BREAKOUT';

  return 'BREAKOUT';
}

function inferRegimeHint({
  validBreakout,
  volumeExpansion,
  btcWith,
  btcAgainst,
  fakeBreakoutRisk
}) {
  if (validBreakout && btcWith && volumeExpansion >= 1.15) return 'TREND';
  if (fakeBreakoutRisk || btcAgainst) return 'CHOP';
  if (volumeExpansion < 1.05) return 'SQUEEZE';

  return 'CHOP';
}

function inferConfirmationProfileHint({
  validBreakout,
  fake,
  fakeBreakoutRisk,
  btcWith,
  btcAgainst,
  volumeExpansion,
  wickReject,
  weakBody,
  retestConfirmed
}) {
  if (validBreakout && btcWith && volumeExpansion >= 1.4 && retestConfirmed) {
    return 'A_STRONG_ALIGN';
  }

  if (validBreakout && btcWith) {
    return 'B_FLOW_ALIGN';
  }

  if (validBreakout && volumeExpansion >= 1.25) {
    return 'C_VOLUME_ALIGN';
  }

  if (!fake && !fakeBreakoutRisk && !btcAgainst && !wickReject && !weakBody) {
    return 'D_MIXED_OK';
  }

  return 'E_WEAK_CONTRA';
}

function analyzeBullBreakout({
  last,
  recentHigh,
  recentLow,
  volumeExpansion,
  btcState
}) {
  const close = safeNumber(last.close, 0);
  const high = safeNumber(last.high, 0);
  const low = safeNumber(last.low, 0);

  const upperWick = upperWickPct(last);
  const body = candleBodyPct(last);

  const sweptHigh = high > recentHigh && close < recentHigh;
  const closedAboveRange = close > recentHigh * (1 + BREAKOUT_BUFFER_PCT);

  const btcAgainst = isBtcAgainstBull(btcState);
  const btcWith = isBtcWithBull(btcState);

  const wickReject = upperWick >= WICK_REJECT_THRESHOLD;
  const weakBody = body <= WEAK_BODY_THRESHOLD;
  const volumeExhaustion = volumeExpansion >= EXHAUSTION_VOLUME_EXPANSION;

  const fake =
    sweptHigh &&
    wickReject &&
    (
      volumeExhaustion ||
      btcAgainst ||
      weakBody
    );

  const retestConfirmed =
    pctDistance(close, recentHigh) <= RETEST_TOLERANCE_PCT ||
    pctDistance(low, recentHigh) <= RETEST_TOLERANCE_PCT;

  const pullbackConfirmed =
    close < recentHigh &&
    close > recentLow;

  const validBreakout =
    closedAboveRange &&
    !wickReject &&
    (
      btcWith ||
      volumeExpansion >= 1.15
    );

  const fakeBreakoutRisk = !fake && (
    sweptHigh ||
    (
      closedAboveRange &&
      !btcWith
    )
  );

  const setupTypeHint = inferSetupHint({
    fake,
    sweptHigh,
    validBreakout,
    retestConfirmed,
    pullbackConfirmed,
    volumeExpansion
  });

  const regimeBucketHint = inferRegimeHint({
    validBreakout,
    volumeExpansion,
    btcWith,
    btcAgainst,
    fakeBreakoutRisk
  });

  const confirmationProfileHint = inferConfirmationProfileHint({
    validBreakout,
    fake,
    fakeBreakoutRisk,
    btcWith,
    btcAgainst,
    volumeExpansion,
    wickReject,
    weakBody,
    retestConfirmed
  });

  const scannerBucket = scannerBucketFromBreakout({
    fake,
    fakeBreakoutRisk,
    validBreakout,
    sweptHigh,
    retestConfirmed,
    pullbackConfirmed,
    volumeExpansion
  });

  return {
    ...baseResult(null),

    fakeBreakout: fake,
    fakeBreakoutRisk,

    fakeBreakoutReason: fake
      ? 'HIGH_SWEEP_CLOSE_BACK_IN_RANGE'
      : null,

    breakoutType: fake
      ? 'FAKE_BREAKOUT'
      : validBreakout
        ? 'VALID_BREAKOUT'
        : 'NONE',

    breakoutValid: validBreakout,
    longContinuation: validBreakout,
    shortContinuation: false,
    avoidLong: fake || fakeBreakoutRisk,
    avoidShort: false,

    pullbackConfirmed,
    sweepConfirmed: sweptHigh,
    retestConfirmed,

    setupTypeHint,
    regimeBucketHint,
    confirmationProfileHint,

    setupType: setupTypeHint,
    regimeBucket: regimeBucketHint,
    confirmationProfile: confirmationProfileHint,

    rangeHigh: recentHigh,
    rangeLow: recentLow,
    volumeExpansion,

    scannerBucket,
    legacy25Bucket: scannerBucket,

    details: {
      recentHigh,
      recentLow,

      close,
      high,
      low,

      upperWick,
      body,
      volumeExpansion,

      btcState,
      btcAgainst,
      btcWith,

      sweptHigh,
      closedAboveRange,
      wickReject,
      weakBody,
      volumeExhaustion,
      validBreakout,
      fakeBreakoutRisk,

      scannerBucket,
      legacy25Bucket: scannerBucket,

      setupTypeHint,
      regimeBucketHint,
      confirmationProfileHint,

      ...learningIdentityPlaceholders(),
      ...longMachineFlags()
    }
  };
}

export function detectFakeBreakout({
  side,
  candles15m,
  btcState = 'NEUTRAL',
  lookback = DEFAULT_LOOKBACK
} = {}) {
  const rows = Array.isArray(candles15m)
    ? candles15m
      .filter(Boolean)
      .map(normalizeCandle)
      .filter(validCandle)
    : [];

  const lb = Math.max(
    5,
    Math.floor(Number(lookback) || DEFAULT_LOOKBACK)
  );

  if (rows.length < lb + 2) {
    return emptyResult('INSUFFICIENT_CANDLES');
  }

  const normalizedSide = normalizeSide(side);

  if (normalizedSide === 'short_disabled') {
    return emptyResult('SHORT_DISABLED_LONG_ONLY');
  }

  if (normalizedSide !== TARGET_SCANNER_SIDE) {
    return emptyResult('UNKNOWN_OR_NON_BULL_SIDE');
  }

  const last = rows.at(-1);
  const prior = rows.slice(-(lb + 1), -1);
  const { recentHigh, recentLow } = getRecentRange(prior, lb);

  if (
    !last ||
    recentHigh <= 0 ||
    recentLow <= 0 ||
    recentHigh <= recentLow
  ) {
    return emptyResult('INVALID_RANGE');
  }

  const normalizedBtcState = normalizeBtcState(btcState);
  const volumeExpansion = calcVolumeExpansion(rows, lb);

  return analyzeBullBreakout({
    last,
    recentHigh,
    recentLow,
    volumeExpansion,
    btcState: normalizedBtcState
  });
}