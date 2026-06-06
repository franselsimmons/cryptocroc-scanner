// ================= FILE: src/utils.js =================

import { createHash, randomUUID } from 'node:crypto';

export const MS_PER_DAY = 86_400_000;

const TRUE_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'n', 'off']);

const LONG_TOKENS = new Set([
  'LONG',
  'BULL',
  'BUY',
  'BULLISH'
]);

const SHORT_TOKENS = new Set([
  'SHORT',
  'BEAR',
  'SELL',
  'BEARISH',
  'ASK',
  'DOWN',
  'DOWNSIDE',
  'RED'
]);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const safeNumber = (value, fallback = 0) => {
  if (value === undefined || value === null || value === '') return fallback;

  const n = Number(value);

  return Number.isFinite(n) ? n : fallback;
};

export const clamp = (value, min, max) => {
  const n = safeNumber(value, min);
  const lo = safeNumber(min, 0);
  const hi = safeNumber(max, lo);

  return Math.max(lo, Math.min(hi, n));
};

export const round = (value, decimals = 4) => {
  const n = safeNumber(value, 0);
  const factor = 10 ** Math.max(0, Number(decimals) || 0);

  return Math.round(n * factor) / factor;
};

export const pct = (value, decimals = 1) => {
  return `${(safeNumber(value) * 100).toFixed(decimals)}%`;
};

export const envBool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;

  const normalized = String(value).trim().toLowerCase();

  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;

  return fallback;
};

function normalizeSideText(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export const normalizeTradeSide = (side) => {
  const raw = String(side || '').trim().toUpperCase();

  if (!raw) return 'UNKNOWN';

  if (LONG_TOKENS.has(raw)) return 'LONG';
  if (SHORT_TOKENS.has(raw)) return 'SHORT';

  const normalized = normalizeSideText(raw);

  const longHit =
    normalized === 'LONG' ||
    normalized === 'BULL' ||
    normalized === 'BUY' ||
    normalized === 'BULLISH' ||
    normalized === 'SIDE_LONG' ||
    normalized === 'TRADE_SIDE_LONG' ||
    normalized === 'TRADESIDE_LONG' ||
    normalized === 'POSITION_SIDE_LONG' ||
    normalized === 'POSITIONSIDE_LONG' ||
    normalized === 'DIRECTION_LONG' ||
    normalized === 'SIDE_BULL' ||
    normalized === 'TRADE_SIDE_BULL' ||
    normalized === 'DIRECTION_BULL' ||
    normalized === 'SIDE_BUY' ||
    normalized === 'DIRECTION_BUY' ||
    normalized.startsWith('LONG_') ||
    normalized.startsWith('BULL_') ||
    normalized.startsWith('BUY_') ||
    normalized.endsWith('_LONG') ||
    normalized.endsWith('_BULL') ||
    normalized.endsWith('_BUY') ||
    normalized.includes('_LONG_') ||
    normalized.includes('_BULL_') ||
    normalized.includes('_BUY_') ||
    normalized.includes('MICRO_LONG') ||
    normalized.includes('FAMILY_LONG');

  if (longHit) return 'LONG';

  const shortHit =
    normalized === 'SHORT' ||
    normalized === 'BEAR' ||
    normalized === 'SELL' ||
    normalized === 'BEARISH' ||
    normalized === 'ASK' ||
    normalized === 'DOWN' ||
    normalized === 'DOWNSIDE' ||
    normalized === 'RED' ||
    normalized === 'SIDE_SHORT' ||
    normalized === 'TRADE_SIDE_SHORT' ||
    normalized === 'TRADESIDE_SHORT' ||
    normalized === 'POSITION_SIDE_SHORT' ||
    normalized === 'POSITIONSIDE_SHORT' ||
    normalized === 'DIRECTION_SHORT' ||
    normalized === 'SIDE_BEAR' ||
    normalized === 'TRADE_SIDE_BEAR' ||
    normalized === 'DIRECTION_BEAR' ||
    normalized === 'SIDE_SELL' ||
    normalized === 'DIRECTION_SELL' ||
    normalized.startsWith('SHORT_') ||
    normalized.startsWith('BEAR_') ||
    normalized.startsWith('SELL_') ||
    normalized.endsWith('_SHORT') ||
    normalized.endsWith('_BEAR') ||
    normalized.endsWith('_SELL') ||
    normalized.includes('_SHORT_') ||
    normalized.includes('_BEAR_') ||
    normalized.includes('_SELL_') ||
    normalized.includes('MICRO_SHORT') ||
    normalized.includes('FAMILY_SHORT');

  if (shortHit) return 'SHORT';

  return 'UNKNOWN';
};

function parseAllowedTradeSides(value) {
  const raw = String(value || 'SHORT')
    .split(/[\s,|;]+/g)
    .map((part) => normalizeTradeSide(part))
    .filter((side) => side === 'LONG' || side === 'SHORT');

  const unique = [...new Set(raw)];

  return unique.length ? unique : ['SHORT'];
}

export const DEFAULT_ALLOWED_TRADE_SIDES = parseAllowedTradeSides(
  process.env.ALLOWED_TRADE_SIDES ||
  process.env.TRADE_ALLOWED_TRADE_SIDES ||
  process.env.SCANNER_ALLOWED_TRADE_SIDES ||
  process.env.ANALYZE_ALLOWED_TRADE_SIDES ||
  process.env.ROTATION_ALLOWED_TRADE_SIDES ||
  'SHORT'
);

export const SHORT_ONLY_MODE =
  envBool(process.env.LONG_ENABLED, false) === false &&
  !DEFAULT_ALLOWED_TRADE_SIDES.includes('LONG');

export function getAllowedTradeSides() {
  const longEnabled = envBool(process.env.LONG_ENABLED, false);
  const shortEnabled = envBool(process.env.SHORT_ENABLED, true);

  const sides = DEFAULT_ALLOWED_TRADE_SIDES.filter((side) => {
    if (side === 'LONG') return longEnabled;
    if (side === 'SHORT') return shortEnabled;

    return false;
  });

  return sides.length ? sides : ['SHORT'];
}

export function isAllowedTradeSide(side) {
  const tradeSide = normalizeTradeSide(side);

  if (tradeSide === 'UNKNOWN') return false;

  return getAllowedTradeSides().includes(tradeSide);
}

export function shouldBlockTradeSide(side) {
  return !isAllowedTradeSide(side);
}

export function isShortOnlyRuntime() {
  const allowed = getAllowedTradeSides();

  return allowed.length === 1 && allowed[0] === 'SHORT';
}

export function filterAllowedTradeSides(rows = [], sideGetter = (row) => row?.tradeSide || row?.side) {
  if (!Array.isArray(rows)) return [];

  return rows.filter((row) => isAllowedTradeSide(sideGetter(row)));
}

export function rejectLongSide(side, fallback = 'UNKNOWN') {
  const tradeSide = normalizeTradeSide(side);

  if (tradeSide === 'LONG') return fallback;
  if (tradeSide === 'SHORT') return 'SHORT';

  return fallback;
}

function cleanSymbolInput(raw) {
  return String(raw || '')
    .toUpperCase()
    .trim()
    .replace(/\s+/g, '')
    .replace(/[/:]/g, '')
    .replace(/[^A-Z0-9_.-]/g, '');
}

function stripBitgetProductSuffix(symbol) {
  return String(symbol || '')
    .replace(/[_-]?(USDTUMCBL|USDCUMCBL|UMCBL|DMCBL|CMCBL)$/i, '')
    .replace(/[_-]?(PERP|SWAP)$/i, '');
}

function removeSeparators(symbol) {
  return String(symbol || '').replace(/[_-]/g, '');
}

export function normalizeBaseSymbol(raw) {
  let symbol = cleanSymbolInput(raw);

  symbol = stripBitgetProductSuffix(symbol);
  symbol = removeSeparators(symbol);

  const quoteSuffixes = [
    'USDT',
    'USDC',
    'BUSD',
    'USD'
  ];

  for (const suffix of quoteSuffixes) {
    if (symbol.endsWith(suffix) && symbol.length > suffix.length) {
      return symbol.slice(0, -suffix.length);
    }
  }

  return symbol;
}

export function normalizeContractSymbol(raw) {
  let symbol = cleanSymbolInput(raw);

  if (!symbol) return '';

  symbol = stripBitgetProductSuffix(symbol);
  symbol = removeSeparators(symbol);

  if (
    symbol.endsWith('USDT') ||
    symbol.endsWith('USDC') ||
    symbol.endsWith('BUSD') ||
    symbol.endsWith('USD')
  ) {
    return symbol;
  }

  return `${symbol}USDT`;
}

export function getUtcDayKey(ts = Date.now()) {
  const date = new Date(ts);

  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }

  return date.toISOString().slice(0, 10);
}

export function getIsoWeekKey(ts = Date.now()) {
  const date = new Date(ts);

  if (Number.isNaN(date.getTime())) {
    return getIsoWeekKey(Date.now());
  }

  const utc = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  ));

  const dayNum = utc.getUTCDay() || 7;

  utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);

  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((utc - yearStart) / MS_PER_DAY) + 1) / 7);

  return `${utc.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

export function getNextIsoWeekKey(ts = Date.now()) {
  const date = new Date(ts);

  if (Number.isNaN(date.getTime())) {
    return getNextIsoWeekKey(Date.now());
  }

  date.setUTCDate(date.getUTCDate() + 7);

  return getIsoWeekKey(date.getTime());
}

export function getPreviousIsoWeekKey(ts = Date.now()) {
  const date = new Date(ts);

  if (Number.isNaN(date.getTime())) {
    return getPreviousIsoWeekKey(Date.now());
  }

  date.setUTCDate(date.getUTCDate() - 7);

  return getIsoWeekKey(date.getTime());
}

export function stableHash(value, length = 8) {
  const safeLength = Math.max(4, Math.min(64, Number(length) || 8));
  const text = typeof value === 'string'
    ? value
    : JSON.stringify(value ?? null);

  return createHash('sha256')
    .update(text)
    .digest('hex')
    .slice(0, safeLength)
    .toUpperCase();
}

export function randomId(prefix = 'id') {
  const cleanPrefix = String(prefix || 'id')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_');

  return `${cleanPrefix}_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

export function sideToTradeSide(side) {
  return normalizeTradeSide(side);
}

export function tradeSideToDirection(side) {
  const s = normalizeTradeSide(side);

  if (s === 'LONG') return 'bull';
  if (s === 'SHORT') return 'bear';

  return 'neutral';
}

export function isLongSide(side) {
  if (!envBool(process.env.LONG_ENABLED, false)) return false;

  return sideToTradeSide(side) === 'LONG';
}

export function isShortSide(side) {
  return sideToTradeSide(side) === 'SHORT';
}

export function isTradeSide(side) {
  const tradeSide = sideToTradeSide(side);

  return tradeSide === 'LONG' || tradeSide === 'SHORT';
}

export function isShortAllowed() {
  return isAllowedTradeSide('SHORT');
}

export function isLongAllowed() {
  return isAllowedTradeSide('LONG');
}

export function getObRelation(side, obBias) {
  const tradeSide = sideToTradeSide(side);
  const ob = String(obBias || 'NEUTRAL').toUpperCase();

  if (shouldBlockTradeSide(tradeSide)) return 'BLOCKED';
  if (!['BULLISH', 'BEARISH'].includes(ob)) return 'NEUTRAL';

  if (tradeSide === 'LONG' && ob === 'BULLISH') return 'WITH';
  if (tradeSide === 'SHORT' && ob === 'BEARISH') return 'WITH';

  return 'AGAINST';
}

function bucketClean(value, decimals = 0) {
  return String(value.toFixed(decimals))
    .replace('-', 'M')
    .replace('.', 'P');
}

export function bucketStep(value, step, prefix, decimals = 0) {
  const n = Number(value);
  const s = Number(step);

  if (!Number.isFinite(n)) return `${prefix}_NA`;
  if (!Number.isFinite(s) || s <= 0) return `${prefix}_NA`;

  const lower = Math.floor(n / s) * s;
  const upper = lower + s;

  return `${prefix}_${bucketClean(lower, decimals)}_${bucketClean(upper, decimals)}`.toUpperCase();
}

export function bucketScore(value, prefix = 'SCORE') {
  const n = safeNumber(value, NaN);

  if (!Number.isFinite(n)) return `${prefix}_NA`;
  if (n < 40) return `${prefix}_LT_40`;
  if (n < 55) return `${prefix}_40_55`;
  if (n < 70) return `${prefix}_55_70`;
  if (n < 80) return `${prefix}_70_80`;
  if (n < 90) return `${prefix}_80_90`;

  return `${prefix}_GT_90`;
}

export function bucketSpread(spreadPct) {
  const bps = safeNumber(spreadPct, NaN) * 10_000;

  if (!Number.isFinite(bps)) return 'SPREAD_NA';
  if (bps < 4) return 'SPREAD_LT_4BPS';
  if (bps < 8) return 'SPREAD_4_8BPS';
  if (bps < 12) return 'SPREAD_8_12BPS';
  if (bps < 20) return 'SPREAD_12_20BPS';
  if (bps < 35) return 'SPREAD_20_35BPS';

  return 'SPREAD_GT_35BPS';
}

export function bucketDepth(depthUsd) {
  const d = safeNumber(depthUsd, NaN);

  if (!Number.isFinite(d) || d <= 0) return 'DEPTH_NA';
  if (d < 10_000) return 'DEPTH_LT_10K';
  if (d < 50_000) return 'DEPTH_10K_50K';
  if (d < 100_000) return 'DEPTH_50K_100K';
  if (d < 250_000) return 'DEPTH_100K_250K';
  if (d < 500_000) return 'DEPTH_250K_500K';

  return 'DEPTH_GT_500K';
}

export function bucketFunding(rate) {
  const r = safeNumber(rate, NaN);

  if (!Number.isFinite(r)) return 'FUNDING_NA';

  // Funding is expected as decimal ratio.
  // 0.0001 = 0.01%.
  if (r <= -0.0015) return 'FUNDING_NEG_EXTREME';
  if (r <= -0.0006) return 'FUNDING_NEG_HIGH';
  if (r < -0.0001) return 'FUNDING_NEG';
  if (r <= 0.0001) return 'FUNDING_NEUTRAL';
  if (r < 0.0006) return 'FUNDING_POS';
  if (r < 0.0015) return 'FUNDING_POS_HIGH';

  return 'FUNDING_POS_EXTREME';
}

export function classifyBtcState({ change24 = 0, change1h = 0 } = {}) {
  const ch24 = safeNumber(change24);
  const ch1 = safeNumber(change1h);

  if (ch24 > 1.5 && ch1 > 0.5) return 'STRONG_BULL';
  if (ch24 < -1.5 && ch1 < -0.5) return 'STRONG_BEAR';
  if (ch24 > 0.6 || ch1 > 0.25) return 'BULLISH';
  if (ch24 < -0.6 || ch1 < -0.25) return 'BEARISH';

  return 'NEUTRAL';
}

export async function mapConcurrent(items, concurrency, mapper) {
  const rows = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Math.floor(Number(concurrency) || 1));

  if (typeof mapper !== 'function') {
    throw new Error('MAP_CONCURRENT_MAPPER_MUST_BE_FUNCTION');
  }

  const out = new Array(rows.length);
  let cursor = 0;

  async function worker() {
    while (cursor < rows.length) {
      const index = cursor;
      cursor += 1;

      out[index] = await mapper(rows[index], index);
    }
  }

  const workerCount = Math.min(limit, rows.length);

  await Promise.all(
    Array.from({ length: workerCount }, () => worker())
  );

  return out;
}

export function compactObject(object) {
  return Object.fromEntries(
    Object.entries(object || {}).filter(([, value]) => (
      value !== undefined &&
      value !== null &&
      value !== ''
    ))
  );
}

export function uniq(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}