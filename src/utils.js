// ================= FILE: src/utils.js =================

import { createHash, randomUUID } from 'node:crypto';

export const MS_PER_DAY = 86_400_000;

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';

const TRUE_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'n', 'off']);

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

const QUOTE_SUFFIXES = [
  'USDT',
  'USDC',
  'BUSD',
  'FDUSD',
  'TUSD',
  'USD'
];

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const safeNumber = (value, fallback = 0) => {
  if (value === undefined || value === null || value === '') return fallback;

  const n = Number(value);

  return Number.isFinite(n) ? n : fallback;
};

export const clamp = (value, min, max) => {
  const lo = safeNumber(min, 0);
  const hi = safeNumber(max, lo);
  const n = safeNumber(value, lo);

  if (hi < lo) return lo;

  return Math.max(lo, Math.min(hi, n));
};

export const round = (value, decimals = 4) => {
  const n = safeNumber(value, 0);
  const d = Math.max(0, Math.floor(Number(decimals) || 0));
  const factor = 10 ** d;

  return Math.round(n * factor) / factor;
};

export const pct = (value, decimals = 1) => {
  const d = Math.max(0, Math.floor(Number(decimals) || 1));

  return `${(safeNumber(value) * 100).toFixed(d)}%`;
};

export const envBool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;

  const normalized = String(value).trim().toLowerCase();

  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;

  return fallback;
};

function upper(value, fallback = '') {
  const text = String(value ?? '').trim();

  return text ? text.toUpperCase() : fallback;
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

function normalizeTokenText(value) {
  return cleanSideText(value)
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function tokenHit(normalized, token) {
  return (
    normalized === token ||
    normalized.startsWith(`${token}_`) ||
    normalized.endsWith(`_${token}`) ||
    normalized.includes(`_${token}_`)
  );
}

function hasLongSignal(value) {
  const normalized = normalizeTokenText(value);

  if (!normalized) return false;

  for (const token of LONG_TOKENS) {
    if (tokenHit(normalized, token)) return true;
  }

  return (
    normalized.includes('MICRO_LONG_') ||
    normalized.includes('TRADESIDE_LONG') ||
    normalized.includes('TRADE_SIDE_LONG') ||
    normalized.includes('SIDE_LONG') ||
    normalized.includes('SIDE_BULL') ||
    normalized.includes('DIRECTION_LONG') ||
    normalized.includes('DIRECTION_BULL') ||
    normalized.includes('POSITION_SIDE_LONG') ||
    normalized.includes('POSITIONSIDE_LONG')
  );
}

function hasShortSignal(value) {
  const normalized = normalizeTokenText(value);

  if (!normalized) return false;

  for (const token of SHORT_TOKENS) {
    if (tokenHit(normalized, token)) return true;
  }

  return (
    normalized.includes('MICRO_SHORT_') ||
    normalized.includes('TRADESIDE_SHORT') ||
    normalized.includes('TRADE_SIDE_SHORT') ||
    normalized.includes('SIDE_SHORT') ||
    normalized.includes('SIDE_BEAR') ||
    normalized.includes('DIRECTION_SHORT') ||
    normalized.includes('DIRECTION_BEAR') ||
    normalized.includes('POSITION_SIDE_SHORT') ||
    normalized.includes('POSITIONSIDE_SHORT')
  );
}

export const normalizeTradeSide = (side) => {
  const raw = cleanSideText(side);

  if (!raw) return 'UNKNOWN';

  if (LONG_TOKENS.has(raw)) return TARGET_TRADE_SIDE;
  if (SHORT_TOKENS.has(raw)) return OPPOSITE_TRADE_SIDE;

  const longHit = hasLongSignal(raw);
  const shortHit = hasShortSignal(raw);

  if (longHit && !shortHit) return TARGET_TRADE_SIDE;
  if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;

  if (longHit && shortHit) {
    const normalized = normalizeTokenText(raw);

    if (
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
      normalized.includes('DIRECTION_BUY')
    ) {
      return TARGET_TRADE_SIDE;
    }

    if (
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
      normalized.includes('DIRECTION_SELL')
    ) {
      return OPPOSITE_TRADE_SIDE;
    }
  }

  if (longHit) return TARGET_TRADE_SIDE;
  if (shortHit) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
};

function parseAllowedTradeSides() {
  return [TARGET_TRADE_SIDE];
}

export const LONG_ONLY_MODE = true;

// Backward-compatible export for older modules.
// In de LONG-root is SHORT-only expliciet uit.
export const SHORT_ONLY_MODE = false;

export const DEFAULT_ALLOWED_TRADE_SIDES = parseAllowedTradeSides();

export function getAllowedTradeSides() {
  return [TARGET_TRADE_SIDE];
}

export function isAllowedTradeSide(side) {
  return normalizeTradeSide(side) === TARGET_TRADE_SIDE;
}

export function shouldBlockTradeSide(side) {
  return normalizeTradeSide(side) !== TARGET_TRADE_SIDE;
}

export function isLongOnlyRuntime() {
  return true;
}

export function isShortOnlyRuntime() {
  return false;
}

export function filterAllowedTradeSides(rows = [], sideGetter = (row) => row?.tradeSide || row?.side) {
  if (!Array.isArray(rows)) return [];

  return rows.filter((row) => isAllowedTradeSide(sideGetter(row)));
}

export function rejectShortSide(side, fallback = 'UNKNOWN') {
  const tradeSide = normalizeTradeSide(side);

  if (tradeSide === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;

  return fallback;
}

// Backward-compatible alias voor oudere imports.
// In deze root betekent dit: non-LONG blokkeren.
export function rejectLongSide(side, fallback = 'UNKNOWN') {
  return rejectShortSide(side, fallback);
}

export function rootModeFlags() {
  return {
    namespace: LONG_NAMESPACE,
    redisNamespace: LONG_NAMESPACE,
    keyPrefix: LONG_KEY_PREFIX,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_DASHBOARD_SIDE,
    targetScannerSide: TARGET_DASHBOARD_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

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
    source: 'VIRTUAL',
    outcomeSource: 'VIRTUAL',

    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,

    noGlobalMaxOpenPositionsBlock: true,
    oneOpenPositionPerSymbol: true,

    manualDiscordSelectionExactTrueMicroOnly: true,
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    defaultRanking: 'dashboardBalancedScore',
    defaultRankingNeverBareWinrate: true,

    learningStatusRules: {
      observing: 'completed = 0',
      earlyOutcomes: 'completed > 0 && completed < 20',
      activeLearning: 'completed >= 20'
    },

    noResetCron: true,
    noActivateCron: true,
    noFreezeCron: true,
    manualSelectionPreserved: true,

    longGrossRFormula: '(exitPrice - entry) / (entry - initialSl)',
    longCurrentRFormula: '(currentPrice - entry) / (entry - initialSl)',
    validLongRiskShape: {
      entryGtZero: true,
      slBelowEntry: true,
      tpAboveEntry: true
    },
    longExitPriority: ['TP', 'SL', 'TIME_STOP'],

    shortRootTouched: false
  };
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

function stripKnownQuote(symbol) {
  const value = String(symbol || '');

  for (const suffix of QUOTE_SUFFIXES) {
    if (value.endsWith(suffix) && value.length > suffix.length) {
      return value.slice(0, -suffix.length);
    }
  }

  return value;
}

export function normalizeBaseSymbol(raw) {
  let symbol = cleanSymbolInput(raw);

  if (!symbol) return '';

  symbol = stripBitgetProductSuffix(symbol);
  symbol = removeSeparators(symbol);

  return stripKnownQuote(symbol);
}

export function normalizeContractSymbol(raw) {
  let symbol = cleanSymbolInput(raw);

  if (!symbol) return '';

  symbol = stripBitgetProductSuffix(symbol);
  symbol = removeSeparators(symbol);

  for (const suffix of QUOTE_SUFFIXES) {
    if (symbol.endsWith(suffix) && symbol.length > suffix.length) {
      return suffix === 'USDT'
        ? symbol
        : `${stripKnownQuote(symbol)}USDT`;
    }
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
  const safeLength = Math.max(4, Math.min(64, Math.floor(Number(length) || 8)));

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
  const tradeSide = normalizeTradeSide(side);

  if (tradeSide === TARGET_TRADE_SIDE) return TARGET_DASHBOARD_SIDE;
  if (tradeSide === OPPOSITE_TRADE_SIDE) return 'bear';

  return 'neutral';
}

export function isLongSide(side) {
  return normalizeTradeSide(side) === TARGET_TRADE_SIDE;
}

export function isShortSide(side) {
  return normalizeTradeSide(side) === OPPOSITE_TRADE_SIDE;
}

export function isTradeSide(side) {
  const tradeSide = normalizeTradeSide(side);

  return tradeSide === TARGET_TRADE_SIDE || tradeSide === OPPOSITE_TRADE_SIDE;
}

export function isLongAllowed() {
  return true;
}

export function isShortAllowed() {
  return false;
}

export function getObRelation(side, obBias) {
  const tradeSide = normalizeTradeSide(side);
  const ob = upper(obBias, 'NEUTRAL');

  if (tradeSide !== TARGET_TRADE_SIDE) return 'BLOCKED';
  if (!['BULLISH', 'BEARISH'].includes(ob)) return 'NEUTRAL';

  return ob === 'BULLISH' ? 'WITH' : 'AGAINST';
}

function bucketClean(value, decimals = 0) {
  const d = Math.max(0, Math.floor(Number(decimals) || 0));

  return String(Number(value).toFixed(d))
    .replace('-', 'M')
    .replace('.', 'P');
}

export function bucketStep(value, step, prefix, decimals = 0) {
  const n = Number(value);
  const s = Number(step);
  const p = String(prefix || 'BUCKET').toUpperCase();

  if (!Number.isFinite(n)) return `${p}_NA`;
  if (!Number.isFinite(s) || s <= 0) return `${p}_NA`;

  const lower = Math.floor(n / s) * s;
  const upperBound = lower + s;

  return `${p}_${bucketClean(lower, decimals)}_${bucketClean(upperBound, decimals)}`.toUpperCase();
}

export function bucketScore(value, prefix = 'SCORE') {
  const n = safeNumber(value, NaN);
  const p = String(prefix || 'SCORE').toUpperCase();

  if (!Number.isFinite(n)) return `${p}_NA`;
  if (n < 40) return `${p}_LOW`;
  if (n < 70) return `${p}_MID`;

  return `${p}_HIGH`;
}

export function bucketSpread(spreadPct) {
  const bps = safeNumber(spreadPct, NaN) * 10_000;

  if (!Number.isFinite(bps)) return 'SPREAD_NA';
  if (bps < 6) return 'SPREAD_LOW';
  if (bps < 15) return 'SPREAD_MID';

  return 'SPREAD_HIGH';
}

export function bucketDepth(depthUsd) {
  const d = safeNumber(depthUsd, NaN);

  if (!Number.isFinite(d) || d <= 0) return 'DEPTH_NA';
  if (d < 100_000) return 'DEPTH_LOW';
  if (d < 500_000) return 'DEPTH_MID';

  return 'DEPTH_HIGH';
}

export function bucketFunding(rate) {
  const r = safeNumber(rate, NaN);

  if (!Number.isFinite(r)) return 'FUNDING_NA';
  if (r < -0.0001) return 'FUNDING_NEG';
  if (r > 0.0001) return 'FUNDING_POS';

  return 'FUNDING_NEUTRAL';
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

  if (!rows.length) return [];

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