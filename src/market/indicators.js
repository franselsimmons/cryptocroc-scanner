// ================= FILE: src/market/indicators.js =================

import {
  safeNumber,
  sideToTradeSide
} from '../utils.js';

const TARGET_TRADE_SIDE = 'SHORT';

function normalizeCandleTs(value) {
  const ts = safeNumber(value, 0);

  if (ts <= 0) return 0;

  // Bitget geeft meestal milliseconds terug. Als het seconds zijn: omzetten.
  return ts < 10_000_000_000 ? ts * 1000 : ts;
}

function normalizeTradeSide(value) {
  const direct = sideToTradeSide(value);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;

  const raw = String(value || '').trim().toUpperCase();

  if (
    raw === 'SHORT' ||
    raw === 'BEAR' ||
    raw === 'BEARISH' ||
    raw === 'SELL' ||
    raw === 'DOWN' ||
    raw === 'DOWNSIDE'
  ) {
    return TARGET_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

export function parseBitgetCandle(row) {
  if (!Array.isArray(row) || row.length < 6) return null;

  const ts = normalizeCandleTs(row[0]);
  const open = safeNumber(row[1], NaN);
  const high = safeNumber(row[2], NaN);
  const low = safeNumber(row[3], NaN);
  const close = safeNumber(row[4], NaN);
  const volume = safeNumber(row[5], 0);
  const quoteVolume = safeNumber(row[6] ?? row[7], 0);

  if (![ts, open, high, low, close].every(Number.isFinite)) return null;
  if (ts <= 0 || open <= 0 || high <= 0 || low <= 0 || close <= 0) return null;
  if (high < low) return null;

  return {
    ts,
    open,
    high,
    low,
    close,
    volume,
    quoteVolume
  };
}

export function candleBodyPct(candle) {
  const high = safeNumber(candle?.high, 0);
  const low = safeNumber(candle?.low, 0);
  const open = safeNumber(candle?.open, 0);
  const close = safeNumber(candle?.close, 0);

  const range = high - low;

  if (range <= 0) return 0;

  return Math.abs(close - open) / range;
}

export function upperWickPct(candle) {
  const high = safeNumber(candle?.high, 0);
  const low = safeNumber(candle?.low, 0);
  const open = safeNumber(candle?.open, 0);
  const close = safeNumber(candle?.close, 0);

  const range = high - low;

  if (range <= 0) return 0;

  return (high - Math.max(open, close)) / range;
}

export function lowerWickPct(candle) {
  const high = safeNumber(candle?.high, 0);
  const low = safeNumber(candle?.low, 0);
  const open = safeNumber(candle?.open, 0);
  const close = safeNumber(candle?.close, 0);

  const range = high - low;

  if (range <= 0) return 0;

  return (Math.min(open, close) - low) / range;
}

export function candleDirection(candle) {
  const open = safeNumber(candle?.open, 0);
  const close = safeNumber(candle?.close, 0);

  if (close > open) return 'BULL';
  if (close < open) return 'BEAR';

  return 'DOJI';
}

export function calculateRsi(candles, period = 14) {
  const rows = Array.isArray(candles) ? candles : [];

  const closes = rows
    .map((candle) => safeNumber(candle?.close, NaN))
    .filter(Number.isFinite);

  const p = Math.max(2, Math.floor(Number(period) || 14));

  if (closes.length < p + 1) return null;

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= p; i += 1) {
    const diff = closes[i] - closes[i - 1];

    if (diff >= 0) {
      avgGain += diff;
    } else {
      avgLoss += Math.abs(diff);
    }
  }

  avgGain /= p;
  avgLoss /= p;

  for (let i = p + 1; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;

    avgGain = ((avgGain * (p - 1)) + gain) / p;
    avgLoss = ((avgLoss * (p - 1)) + loss) / p;
  }

  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;

  const rs = avgGain / avgLoss;

  return Number((100 - (100 / (1 + rs))).toFixed(3));
}

export function calculateAtrPct(candles, period = 14) {
  const p = Math.max(2, Math.floor(Number(period) || 14));
  const rows = Array.isArray(candles) ? candles.slice(-(p + 1)) : [];

  if (rows.length < p + 1) return 0;

  const trueRanges = [];

  for (let i = 1; i < rows.length; i += 1) {
    const high = safeNumber(rows[i]?.high, 0);
    const low = safeNumber(rows[i]?.low, 0);
    const prevClose = safeNumber(rows[i - 1]?.close, 0);

    if (high <= 0 || low <= 0 || prevClose <= 0) continue;

    trueRanges.push(
      Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      )
    );
  }

  if (trueRanges.length === 0) return 0;

  const atr = trueRanges.reduce((sum, value) => sum + value, 0) / trueRanges.length;
  const price = safeNumber(rows.at(-1)?.close, 0);

  return price > 0 ? atr / price : 0;
}

export function getRsiZone(rsi) {
  const n = safeNumber(rsi, 50);

  if (n <= 26) return 'LOWER_3';
  if (n <= 33) return 'LOWER_2';
  if (n <= 40) return 'LOWER_1';

  if (n >= 74) return 'UPPER_3';
  if (n >= 67) return 'UPPER_2';
  if (n >= 60) return 'UPPER_1';

  return 'MID';
}

export function getRsiSlope(candles, lookbackCandles = 3) {
  const rows = Array.isArray(candles) ? candles : [];
  const lookback = Math.max(1, Math.floor(Number(lookbackCandles) || 3));

  const rsiNow = calculateRsi(rows, 14);
  const rsiPrev = calculateRsi(rows.slice(0, -lookback), 14);

  if (!Number.isFinite(rsiNow) || !Number.isFinite(rsiPrev)) return 0;

  return Number((rsiNow - rsiPrev).toFixed(3));
}

export function getRecentRange(candles, lookback = 24) {
  const lb = Math.max(1, Math.floor(Number(lookback) || 24));
  const rows = (Array.isArray(candles) ? candles : []).slice(-lb);

  if (!rows.length) {
    return {
      recentHigh: 0,
      recentLow: 0,
      rangePct: 0,
      mid: 0
    };
  }

  const highs = rows
    .map((row) => safeNumber(row?.high, 0))
    .filter((n) => n > 0);

  const lows = rows
    .map((row) => safeNumber(row?.low, 0))
    .filter((n) => n > 0);

  if (!highs.length || !lows.length) {
    return {
      recentHigh: 0,
      recentLow: 0,
      rangePct: 0,
      mid: 0
    };
  }

  const recentHigh = Math.max(...highs);
  const recentLow = Math.min(...lows);
  const mid = (recentHigh + recentLow) / 2;

  return {
    recentHigh,
    recentLow,
    rangePct: recentHigh > 0 ? (recentHigh - recentLow) / recentHigh : 0,
    mid
  };
}

export function calcMovePct(candles, lookback = 8) {
  const lb = Math.max(2, Math.floor(Number(lookback) || 8));
  const rows = Array.isArray(candles) ? candles.slice(-lb) : [];

  if (rows.length < 2) return 0;

  const first = safeNumber(rows[0]?.close, 0);
  const last = safeNumber(rows.at(-1)?.close, 0);

  if (first <= 0 || last <= 0) return 0;

  return ((last - first) / first) * 100;
}

export function calcVolumeExpansion(candles, lookback = 20) {
  const lb = Math.max(5, Math.floor(Number(lookback) || 20));
  const rows = Array.isArray(candles) ? candles.slice(-(lb + 1)) : [];

  if (rows.length < 6) return 1;

  const last = safeNumber(
    rows.at(-1)?.quoteVolume || rows.at(-1)?.volume,
    0
  );

  const previous = rows
    .slice(0, -1)
    .map((row) => safeNumber(row?.quoteVolume || row?.volume, 0))
    .filter((n) => n > 0);

  if (last <= 0 || previous.length === 0) return 1;

  const avg = previous.reduce((sum, value) => sum + value, 0) / previous.length;

  return avg > 0 ? Number((last / avg).toFixed(3)) : 1;
}

export function classifyFlow({
  side = TARGET_TRADE_SIDE,
  change1h,
  change24h,
  candles15m
} = {}) {
  const tradeSide = normalizeTradeSide(side);

  if (tradeSide !== TARGET_TRADE_SIDE) return 'NEUTRAL';

  const ch1 = safeNumber(change1h, 0);
  const ch24 = safeNumber(change24h, 0);
  const shortMovePct = calcMovePct(candles15m, 8);
  const volumeExpansion = calcVolumeExpansion(candles15m, 20);

  const directional =
    ch1 < 0 &&
    shortMovePct < 0;

  const strong =
    ch1 < -0.8 ||
    ch24 < -3 ||
    shortMovePct < -1.2;

  const volumeBacked = volumeExpansion >= 1.25;

  if (directional && strong && volumeBacked) return 'TREND';
  if (directional && strong) return 'IMPULSE';
  if (directional) return 'BUILDING';

  return 'NEUTRAL';
}

export function classifyVolatilityRegime(candles, atrPct = null) {
  const atr = Number.isFinite(Number(atrPct))
    ? safeNumber(atrPct, 0)
    : calculateAtrPct(candles, 14);

  if (atr >= 0.025) return 'EXTREME_VOL';
  if (atr >= 0.014) return 'HIGH_VOL';
  if (atr <= 0.004) return 'LOW_VOL';

  return 'NORMAL_VOL';
}

export function calcCandleStructure(candles) {
  const rows = Array.isArray(candles) ? candles : [];
  const last = rows.at(-1);

  if (!last) {
    return {
      direction: 'NA',
      bodyPct: 0,
      upperWickPct: 0,
      lowerWickPct: 0
    };
  }

  return {
    direction: candleDirection(last),
    bodyPct: candleBodyPct(last),
    upperWickPct: upperWickPct(last),
    lowerWickPct: lowerWickPct(last)
  };
}