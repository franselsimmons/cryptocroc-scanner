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

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function cleanSideText(value = '') {
  return upper(value)
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

function textHasShortSignal(value = '') {
  const raw = cleanSideText(value);

  if (!raw) return false;
  if (SHORT_TOKENS.has(raw)) return true;

  return (
    raw.includes('MICRO_SHORT_') ||
    raw.includes('TRADE_SIDE=SHORT') ||
    raw.includes('TRADESIDE=SHORT') ||
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

function textHasLongSignal(value = '') {
  const raw = cleanSideText(value);

  if (!raw) return false;
  if (LONG_TOKENS.has(raw)) return true;

  return (
    raw.includes('MICRO_LONG_') ||
    raw.includes('TRADE_SIDE=LONG') ||
    raw.includes('TRADESIDE=LONG') ||
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

    rangeHigh: null,
    rangeLow: null,
    volumeExpansion: 0,

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

    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    exchangeCallsDisabled: true,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,

    bucketGranularity: 'LOW_MID_HIGH',

    reason
  };
}

function emptyResult(reason = 'INSUFFICIENT_DATA') {
  return baseResult(reason);
}

function pctDistance(a, b) {
  const x = safeNumber(a, 0);
  const y = safeNumber(b, 0);

  if (x <= 0 || y <= 0) return Infinity;

  return Math.abs(x - y) / Math.max(x, y);
}

function isBtcAgainstBull(btcState) {
  return ['BEARISH', 'STRONG_BEAR'].includes(btcState);
}

function isBtcWithBull(btcState) {
  return ['BULLISH', 'STRONG_BULL'].includes(btcState);
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

    rangeHigh: recentHigh,
    rangeLow: recentLow,
    volumeExpansion,

    details: {
      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      positionSide: TARGET_TRADE_SIDE,
      direction: TARGET_TRADE_SIDE,

      targetTradeSide: TARGET_TRADE_SIDE,
      targetScannerSide: TARGET_SCANNER_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      oppositeTradeSide: OPPOSITE_TRADE_SIDE,

      longOnly: true,
      shortDisabled: true,
      shortOnly: false,
      longDisabled: false,

      virtualLearning: true,
      virtualOnly: true,
      virtualTracked: true,

      noRealOrders: true,
      realOrdersDisabled: true,
      bitgetOrdersDisabled: true,
      exchangeOrdersDisabled: true,
      exchangeCallsDisabled: true,

      scannerFingerprintRole: 'METADATA_ONLY',
      scannerFingerprintsMetadataOnly: true,
      scannerFingerprintsUsedAsLearningFamily: false,
      analyzeMicroFamiliesOnly: true,
      learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
      symbolExcludedFromFamilyId: true,

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
      fakeBreakoutRisk
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