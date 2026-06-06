// ================= FILE: src/market/fakeBreakout.js =================

import {
  getRecentRange,
  calcVolumeExpansion,
  candleBodyPct,
  lowerWickPct
} from './indicators.js';
import {
  safeNumber,
  sideToTradeSide
} from '../utils.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';

const DEFAULT_LOOKBACK = 24;
const RETEST_TOLERANCE_PCT = 0.004;
const BREAKOUT_BUFFER_PCT = 0.0015;
const WICK_REJECT_THRESHOLD = 0.45;
const WEAK_BODY_THRESHOLD = 0.35;
const EXHAUSTION_VOLUME_EXPANSION = 1.4;

function normalizeSide(side) {
  const tradeSide = sideToTradeSide(side);

  if (tradeSide === TARGET_TRADE_SIDE) return TARGET_DASHBOARD_SIDE;

  const raw = String(side || '').trim().toUpperCase();

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE'].includes(raw)) {
    return TARGET_DASHBOARD_SIDE;
  }

  return 'unknown';
}

function normalizeBtcState(btcState) {
  return String(btcState || 'NEUTRAL').trim().toUpperCase();
}

function emptyResult(reason = 'INSUFFICIENT_DATA') {
  return {
    fakeBreakout: false,
    fakeBreakoutRisk: false,
    fakeBreakoutReason: null,

    breakoutType: 'UNKNOWN',

    pullbackConfirmed: false,
    sweepConfirmed: false,
    retestConfirmed: false,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    targetTradeSide: TARGET_TRADE_SIDE,
    shortOnly: true,
    longDisabled: true,

    reason
  };
}

function pctDistance(a, b) {
  const x = safeNumber(a, 0);
  const y = safeNumber(b, 0);

  if (x <= 0 || y <= 0) return Infinity;

  return Math.abs(x - y) / Math.max(x, y);
}

function isBtcAgainstBear(btcState) {
  return ['BULLISH', 'STRONG_BULL'].includes(btcState);
}

function isBtcWithBear(btcState) {
  return ['BEARISH', 'STRONG_BEAR'].includes(btcState);
}

function analyzeBearBreakout({
  last,
  recentHigh,
  recentLow,
  volumeExpansion,
  btcState
}) {
  const close = safeNumber(last.close, 0);
  const high = safeNumber(last.high, 0);
  const low = safeNumber(last.low, 0);

  const lowerWick = lowerWickPct(last);
  const body = candleBodyPct(last);

  const sweptLow = low < recentLow && close > recentLow;
  const closedBelowRange = close < recentLow * (1 - BREAKOUT_BUFFER_PCT);

  const btcAgainst = isBtcAgainstBear(btcState);
  const btcWith = isBtcWithBear(btcState);

  const wickReject = lowerWick >= WICK_REJECT_THRESHOLD;
  const weakBody = body <= WEAK_BODY_THRESHOLD;
  const volumeExhaustion = volumeExpansion >= EXHAUSTION_VOLUME_EXPANSION;

  const fake =
    sweptLow &&
    wickReject &&
    (
      volumeExhaustion ||
      btcAgainst ||
      weakBody
    );

  const retestConfirmed =
    pctDistance(close, recentLow) <= RETEST_TOLERANCE_PCT ||
    pctDistance(high, recentLow) <= RETEST_TOLERANCE_PCT;

  const pullbackConfirmed =
    close > recentLow &&
    close < recentHigh;

  const validBreakout =
    closedBelowRange &&
    !wickReject &&
    (
      btcWith ||
      volumeExpansion >= 1.15
    );

  return {
    fakeBreakout: fake,
    fakeBreakoutRisk: !fake && (sweptLow || (closedBelowRange && !btcWith)),
    fakeBreakoutReason: fake ? 'LOW_SWEEP_CLOSE_BACK_IN_RANGE' : null,

    breakoutType: fake
      ? 'FAKE_BREAKDOWN'
      : validBreakout
        ? 'VALID_BREAKDOWN'
        : 'NONE',

    pullbackConfirmed,
    sweepConfirmed: sweptLow,
    retestConfirmed,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    targetTradeSide: TARGET_TRADE_SIDE,
    shortOnly: true,
    longDisabled: true,

    details: {
      recentHigh,
      recentLow,

      close,
      high,
      low,

      lowerWick,
      body,

      volumeExpansion,
      btcState,
      btcAgainst,
      btcWith,

      sweptLow,
      closedBelowRange,
      wickReject,
      weakBody,
      volumeExhaustion,
      validBreakout
    }
  };
}

export function detectFakeBreakout({
  side = TARGET_TRADE_SIDE,
  candles15m,
  btcState = 'NEUTRAL',
  lookback = DEFAULT_LOOKBACK
} = {}) {
  const rows = Array.isArray(candles15m)
    ? candles15m.filter(Boolean)
    : [];

  const lb = Math.max(
    5,
    Math.floor(Number(lookback) || DEFAULT_LOOKBACK)
  );

  if (rows.length < lb + 2) {
    return emptyResult('INSUFFICIENT_CANDLES');
  }

  const normalizedSide = normalizeSide(side);

  if (normalizedSide !== TARGET_DASHBOARD_SIDE) {
    return emptyResult('SHORT_ONLY_UNKNOWN_OR_LONG_SIDE_SKIPPED');
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

  return analyzeBearBreakout({
    last,
    recentHigh,
    recentLow,
    volumeExpansion,
    btcState: normalizedBtcState
  });
}