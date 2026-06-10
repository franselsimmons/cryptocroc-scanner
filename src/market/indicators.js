// ================= FILE: src/market/indicators.js =================

import {
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

function hasLongSignal(value = '') {
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

function hasShortSignal(value = '') {
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

function normalizeTradeSide(value) {
  const raw = cleanSideText(value);

  if (!raw) return 'UNKNOWN';

  const direct = sideToTradeSide(raw);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  const longHit = hasLongSignal(raw);
  const shortHit = hasShortSignal(raw);

  if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;
  if (longHit && !shortHit) return TARGET_TRADE_SIDE;

  if (longHit) return TARGET_TRADE_SIDE;
  if (shortHit) return OPPOSITE_TRADE_SIDE;

  if (raw === TARGET_DASHBOARD_SIDE.toUpperCase()) return TARGET_TRADE_SIDE;

  return 'UNKNOWN';
}

function clamp01(value) {
  const n = safeNumber(value, 0);

  if (n <= 0) return 0;
  if (n >= 1) return 1;

  return n;
}

function normalizeCandleTs(value) {
  const ts = safeNumber(value, 0);

  if (ts <= 0) return 0;

  // Bitget geeft meestal milliseconds terug. Als het seconds zijn: omzetten.
  return ts < 10_000_000_000 ? ts * 1000 : ts;
}

function normalizeCandle(row = {}) {
  if (!row || typeof row !== 'object') return null;

  const ts = normalizeCandleTs(row.ts ?? row.time ?? row.timestamp ?? row[0]);
  const open = safeNumber(row.open ?? row[1], NaN);
  const high = safeNumber(row.high ?? row[2], NaN);
  const low = safeNumber(row.low ?? row[3], NaN);
  const close = safeNumber(row.close ?? row[4], NaN);
  const volume = safeNumber(row.volume ?? row.baseVolume ?? row.vol ?? row[5], 0);
  const quoteVolume = safeNumber(row.quoteVolume ?? row.quoteVol ?? row.turnover ?? row[6] ?? row[7], 0);

  if (![open, high, low, close].every(Number.isFinite)) return null;
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0) return null;
  if (high < low) return null;

  return {
    ...row,
    ts,
    open,
    high,
    low,
    close,
    volume,
    quoteVolume
  };
}

function normalizeCandles(candles) {
  return (Array.isArray(candles) ? candles : [])
    .map(normalizeCandle)
    .filter(Boolean);
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
  const row = normalizeCandle(candle);

  if (!row) return 0;

  const range = row.high - row.low;

  if (range <= 0) return 0;

  return clamp01(Math.abs(row.close - row.open) / range);
}

export function upperWickPct(candle) {
  const row = normalizeCandle(candle);

  if (!row) return 0;

  const range = row.high - row.low;

  if (range <= 0) return 0;

  return clamp01((row.high - Math.max(row.open, row.close)) / range);
}

export function lowerWickPct(candle) {
  const row = normalizeCandle(candle);

  if (!row) return 0;

  const range = row.high - row.low;

  if (range <= 0) return 0;

  return clamp01((Math.min(row.open, row.close) - row.low) / range);
}

export function candleDirection(candle) {
  const row = normalizeCandle(candle);

  if (!row) return 'NA';

  if (row.close > row.open) return 'BULL';
  if (row.close < row.open) return 'BEAR';

  return 'DOJI';
}

export function calculateRsi(candles, period = 14) {
  const rows = normalizeCandles(candles);

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
  const rows = normalizeCandles(candles).slice(-(p + 1));

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
  const rows = normalizeCandles(candles);
  const lookback = Math.max(1, Math.floor(Number(lookbackCandles) || 3));

  const rsiNow = calculateRsi(rows, 14);
  const rsiPrev = calculateRsi(rows.slice(0, -lookback), 14);

  if (!Number.isFinite(rsiNow) || !Number.isFinite(rsiPrev)) return 0;

  return Number((rsiNow - rsiPrev).toFixed(3));
}

export function getRecentRange(candles, lookback = 24) {
  const lb = Math.max(1, Math.floor(Number(lookback) || 24));
  const rows = normalizeCandles(candles).slice(-lb);

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
  const rows = normalizeCandles(candles).slice(-lb);

  if (rows.length < 2) return 0;

  const first = safeNumber(rows[0]?.close, 0);
  const last = safeNumber(rows.at(-1)?.close, 0);

  if (first <= 0 || last <= 0) return 0;

  return ((last - first) / first) * 100;
}

export function calcVolumeExpansion(candles, lookback = 20) {
  const lb = Math.max(5, Math.floor(Number(lookback) || 20));
  const rows = normalizeCandles(candles).slice(-(lb + 1));

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

function inferLongSideFromMomentum({
  change1h,
  change24h,
  candles15m
} = {}) {
  const ch1 = safeNumber(change1h, 0);
  const ch24 = safeNumber(change24h, 0);
  const shortMovePct = calcMovePct(candles15m, 8);

  if (ch1 < 0 || shortMovePct < 0 || ch24 < 0) {
    return OPPOSITE_TRADE_SIDE;
  }

  if (ch1 > 0 || shortMovePct > 0 || ch24 > 0) {
    return TARGET_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

export function classifyFlow({
  side,
  change1h,
  change24h,
  candles15m
} = {}) {
  const explicitSide = normalizeTradeSide(side);

  if (explicitSide === OPPOSITE_TRADE_SIDE) {
    return 'SHORT_DISABLED_LONG_ONLY';
  }

  const inferredSide = explicitSide === TARGET_TRADE_SIDE
    ? TARGET_TRADE_SIDE
    : inferLongSideFromMomentum({
      change1h,
      change24h,
      candles15m
    });

  if (inferredSide === OPPOSITE_TRADE_SIDE) {
    return 'SHORT_DISABLED_LONG_ONLY';
  }

  if (inferredSide !== TARGET_TRADE_SIDE) {
    return 'NEUTRAL';
  }

  const ch1 = safeNumber(change1h, 0);
  const ch24 = safeNumber(change24h, 0);
  const shortMovePct = calcMovePct(candles15m, 8);
  const volumeExpansion = calcVolumeExpansion(candles15m, 20);

  const directional = ch1 > 0 && shortMovePct > 0;
  const strong = ch1 > 0.8 || ch24 > 3 || shortMovePct > 1.2;
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
  const rows = normalizeCandles(candles);
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