// ================= FILE: src/market/scanner.js =================

import { CONFIG } from '../config.js';
import { KEYS } from '../keys.js';
import { getVolatileRedis, setJson } from '../redis.js';
import {
  classifyBtcState,
  mapConcurrent,
  normalizeBaseSymbol,
  normalizeContractSymbol,
  randomId,
  safeNumber
} from '../utils.js';
import {
  calculateAtrPct,
  classifyVolatilityRegime,
  calcVolumeExpansion
} from './indicators.js';
import { detectFakeBreakout } from './fakeBreakout.js';
import {
  fetchBitgetTickers,
  parseTicker,
  fetchCandles
} from './bitgetClient.js';

const DEFAULT_ANALYZE_SYMBOLS = 300;
const DEFAULT_MAX_CANDIDATES = 300;
const DEFAULT_MIN_QUOTE_VOLUME_24H = 50_000;
const DEFAULT_SOFT_MIN_QUOTE_VOLUME_24H = 10_000;

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_SCANNER_SIDE = 'bear';

const TRUE_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'n', 'off']);

const BLOCKED_BASE_SYMBOLS = new Set([
  'USDT',
  'USDC',
  'USD',
  'BUSD',
  'FDUSD',
  'TUSD',
  'DAI',
  'EUR',
  'TRY',
  'BRL'
]);

function cfgNumber(pathValue, fallback) {
  const value = safeNumber(pathValue, fallback);

  return Number.isFinite(value) ? value : fallback;
}

function cfgBoolean(pathValue, fallback = false) {
  if (pathValue === undefined || pathValue === null || pathValue === '') {
    return fallback;
  }

  const normalized = String(pathValue).trim().toLowerCase();

  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;

  return fallback;
}

function scannerConcurrency() {
  const value =
    CONFIG.scanner?.dataConcurrency ||
    CONFIG.trade?.dataConcurrency ||
    8;

  const n = Number(value);

  if (!Number.isFinite(n) || n <= 0) return 8;

  return Math.max(1, Math.min(20, Math.floor(n)));
}

function scannerMaxSymbols() {
  const configured = cfgNumber(CONFIG.scanner?.maxSymbols, 0);
  const analyzeMax = cfgNumber(
    CONFIG.scanner?.analyzeMaxSymbols ??
    CONFIG.scanner?.maxAnalyzeSymbols ??
    CONFIG.scanner?.maxUniverseSymbols,
    DEFAULT_ANALYZE_SYMBOLS
  );

  return Math.max(1, Math.floor(Math.max(configured, analyzeMax)));
}

function scannerMaxCandidates() {
  const configured = cfgNumber(CONFIG.scanner?.maxCandidates, 0);
  const analyzeMax = cfgNumber(
    CONFIG.scanner?.analyzeMaxCandidates ??
    CONFIG.scanner?.maxAnalyzeCandidates,
    DEFAULT_MAX_CANDIDATES
  );

  return Math.max(1, Math.floor(Math.max(configured, analyzeMax)));
}

function minQuoteVolume24h() {
  return Math.max(
    0,
    cfgNumber(CONFIG.scanner?.minQuoteVolume24h, DEFAULT_MIN_QUOTE_VOLUME_24H)
  );
}

function softMinQuoteVolume24h() {
  return Math.max(
    0,
    cfgNumber(CONFIG.scanner?.softMinQuoteVolume24h, DEFAULT_SOFT_MIN_QUOTE_VOLUME_24H)
  );
}

function minAbsChange1h() {
  return Math.max(
    0,
    cfgNumber(CONFIG.scanner?.minAbsChange1h, 0.15)
  );
}

function minAbsChange24h() {
  return Math.max(
    0,
    cfgNumber(CONFIG.scanner?.minAbsChange24h, 0.8)
  );
}

function strictScannerFiltersEnabled() {
  return cfgBoolean(CONFIG.scanner?.strictFilters, false);
}

function blockFakeBreakoutEnabled() {
  return cfgBoolean(CONFIG.scanner?.blockFakeBreakout, false);
}

function blockNoDirectionEnabled() {
  return cfgBoolean(CONFIG.scanner?.blockNoDirection, false);
}

function blockSmallMoveEnabled() {
  return cfgBoolean(CONFIG.scanner?.blockSmallMove, false);
}

function stripUsdtQuote(symbol = '') {
  const value = String(symbol || '').trim().toUpperCase();

  if (!value.endsWith('USDT')) return value;

  return value.slice(0, -4);
}

function isBlockedBaseSymbol(baseSymbol = '') {
  const base = String(baseSymbol || '').trim().toUpperCase();

  if (!base) return true;

  return BLOCKED_BASE_SYMBOLS.has(base);
}

function isValidUsdtFuturesContractSymbol(symbol = '') {
  const value = String(symbol || '').trim().toUpperCase();

  if (!value) return false;
  if (value === 'USDT') return false;
  if (!value.endsWith('USDT')) return false;
  if (!/^[A-Z0-9]+USDT$/.test(value)) return false;

  const base = stripUsdtQuote(value);

  if (isBlockedBaseSymbol(base)) return false;

  return true;
}

function normalizeScannerTicker(rawTicker = {}) {
  const parsed = parseTicker(rawTicker);

  const contractSymbol = normalizeContractSymbol(
    rawTicker.contractSymbol ||
    rawTicker.symbol ||
    parsed.contractSymbol ||
    parsed.symbol
  );

  if (!isValidUsdtFuturesContractSymbol(contractSymbol)) {
    return null;
  }

  const derivedBaseSymbol = stripUsdtQuote(contractSymbol);

  const parsedBaseSymbol = normalizeBaseSymbol(
    rawTicker.baseSymbol ||
    parsed.baseSymbol ||
    derivedBaseSymbol
  );

  const baseSymbol = isBlockedBaseSymbol(parsedBaseSymbol)
    ? derivedBaseSymbol
    : parsedBaseSymbol;

  if (isBlockedBaseSymbol(baseSymbol)) {
    return null;
  }

  const directPrice = safeNumber(rawTicker.price, NaN);
  const directVolume24h = safeNumber(rawTicker.volume24h, NaN);
  const directChange24h = safeNumber(rawTicker.change24h, NaN);

  return {
    ...parsed,
    ...rawTicker,

    symbol: contractSymbol,
    contractSymbol,
    baseSymbol,

    price: Number.isFinite(directPrice) && directPrice > 0
      ? directPrice
      : safeNumber(parsed.price, 0),

    volume24h: Number.isFinite(directVolume24h) && directVolume24h > 0
      ? directVolume24h
      : safeNumber(parsed.volume24h, 0),

    change24h: Number.isFinite(directChange24h)
      ? directChange24h
      : safeNumber(parsed.change24h, 0)
  };
}

function inferSide({ change1h, change24h, btcState }) {
  const ch1 = safeNumber(change1h, 0);
  const ch24 = safeNumber(change24h, 0);
  const min24 = minAbsChange24h();

  if (ch1 < 0 && ch24 < 0.5) return TARGET_SCANNER_SIDE;
  if (ch24 < -min24) return TARGET_SCANNER_SIDE;
  if (ch1 < 0) return TARGET_SCANNER_SIDE;

  const state = String(btcState || '').toUpperCase();

  if (state.includes('BEAR')) return TARGET_SCANNER_SIDE;

  return 'neutral';
}

function sideConfidence({ side, change1h, change24h }) {
  if (side !== TARGET_SCANNER_SIDE) return 'LOW';

  const ch1 = Math.abs(safeNumber(change1h, 0));
  const ch24 = Math.abs(safeNumber(change24h, 0));

  if (ch1 >= minAbsChange1h() * 2 || ch24 >= minAbsChange24h() * 2) return 'HIGH';
  if (ch1 >= minAbsChange1h() || ch24 >= minAbsChange24h()) return 'MID';

  return 'LOW';
}

function calcChangePct(first, last) {
  const a = safeNumber(first, 0);
  const b = safeNumber(last, 0);

  if (a <= 0 || b <= 0) return 0;

  return ((b - a) / a) * 100;
}

function calcOneHourChange(candles15m) {
  const rows = Array.isArray(candles15m) ? candles15m : [];

  if (rows.length < 5) return 0;

  const first = rows.at(-5)?.close;
  const last = rows.at(-1)?.close;

  return calcChangePct(first, last);
}

function estimateQuoteVolumeFromCandles(candles = [], lookback = 96) {
  const rows = (Array.isArray(candles) ? candles : [])
    .slice(-Math.max(1, Math.floor(Number(lookback) || 96)));

  return rows.reduce((sum, candle) => {
    const quoteVolume = safeNumber(candle?.quoteVolume, 0);

    if (quoteVolume > 0) return sum + quoteVolume;

    const close = safeNumber(candle?.close, 0);
    const baseVolume = safeNumber(candle?.volume, 0);

    if (close <= 0 || baseVolume <= 0) return sum;

    return sum + close * baseVolume;
  }, 0);
}

function calcScannerScore({
  change1h,
  change24h,
  volume24h,
  volumeExpansion,
  fakeBreakoutRisk,
  fakeBreakout,
  pullbackConfirmed,
  sweepConfirmed,
  retestConfirmed,
  breakoutType,
  sideConfidenceLevel
}) {
  let score = 0;

  score += Math.min(35, Math.abs(safeNumber(change1h, 0)) * 12);
  score += Math.min(22, Math.abs(safeNumber(change24h, 0)) * 2.7);
  score += Math.min(20, Math.log10(Math.max(10, safeNumber(volume24h, 0))) * 2.0);

  if (safeNumber(volumeExpansion, 1) >= 1.15) score += 3;
  if (safeNumber(volumeExpansion, 1) >= 1.25) score += 6;
  if (safeNumber(volumeExpansion, 1) >= 1.75) score += 4;

  if (pullbackConfirmed) score += 7;
  if (retestConfirmed) score += 5;
  if (sweepConfirmed) score += 3;
  if (breakoutType === 'VALID_BREAKOUT') score += 4;

  if (sideConfidenceLevel === 'HIGH') score += 5;
  if (sideConfidenceLevel === 'MID') score += 2;
  if (sideConfidenceLevel === 'LOW') score -= 3;

  if (fakeBreakoutRisk) score -= 8;
  if (fakeBreakout) score -= 7;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function scannerReasonFrom({
  fake,
  volumeExpansion,
  passesMoveFilter,
  passesVolumeFilter,
  sideConfidenceLevel
}) {
  if (!passesVolumeFilter) return 'SHORT_LOW_VOLUME_ANALYZE_ONLY';
  if (fake?.pullbackConfirmed && fake?.retestConfirmed) return 'SHORT_MOMENTUM_PULLBACK_RETEST';
  if (fake?.pullbackConfirmed) return 'SHORT_MOMENTUM_PULLBACK';
  if (fake?.breakoutType === 'VALID_BREAKOUT') return 'SHORT_VALID_BREAKOUT';
  if (volumeExpansion >= 1.5) return 'SHORT_VOLUME_EXPANSION';
  if (passesMoveFilter) return 'SHORT_MOMENTUM_EXPANSION';
  if (sideConfidenceLevel === 'LOW') return 'SHORT_WEAK_DIRECTION_ANALYZE_ONLY';

  return 'SHORT_ANALYZE_DISCOVERY';
}

function cleanFakeResult(fake = {}) {
  return {
    fakeBreakout: Boolean(fake.fakeBreakout),
    fakeBreakoutRisk: Boolean(fake.fakeBreakoutRisk),
    fakeBreakoutReason: fake.fakeBreakoutReason || null,
    breakoutType: fake.breakoutType || 'UNKNOWN',
    pullbackConfirmed: Boolean(fake.pullbackConfirmed),
    sweepConfirmed: Boolean(fake.sweepConfirmed),
    retestConfirmed: Boolean(fake.retestConfirmed)
  };
}

function isTradableTicker(ticker) {
  if (!ticker?.symbol) return false;
  if (!ticker?.contractSymbol) return false;
  if (!ticker?.baseSymbol) return false;

  if (!isValidUsdtFuturesContractSymbol(ticker.contractSymbol)) return false;
  if (isBlockedBaseSymbol(ticker.baseSymbol)) return false;

  if (safeNumber(ticker.price, 0) <= 0) return false;

  const volume24h = safeNumber(ticker.volume24h, 0);

  if (volume24h <= 0) {
    return !strictScannerFiltersEnabled();
  }

  const hardMinVolume = strictScannerFiltersEnabled()
    ? minQuoteVolume24h()
    : softMinQuoteVolume24h();

  if (volume24h < hardMinVolume) return false;

  return true;
}

function dedupeByBaseSymbol(tickers) {
  const byBase = new Map();

  for (const ticker of tickers) {
    const normalized = normalizeScannerTicker(ticker);

    if (!normalized) continue;

    const baseSymbol = normalized.baseSymbol;
    const contractSymbol = normalized.contractSymbol;

    if (!baseSymbol || !contractSymbol) continue;
    if (isBlockedBaseSymbol(baseSymbol)) continue;
    if (!isValidUsdtFuturesContractSymbol(contractSymbol)) continue;

    const existing = byBase.get(baseSymbol);

    if (!existing || safeNumber(normalized.volume24h, 0) > safeNumber(existing.volume24h, 0)) {
      byBase.set(baseSymbol, normalized);
    }
  }

  return [...byBase.values()];
}

function shortUniverseScore(ticker = {}) {
  const change24h = safeNumber(ticker.change24h, 0);
  const volume24h = safeNumber(ticker.volume24h, 0);

  const bearishPressure = change24h < 0
    ? Math.abs(change24h) * 100
    : 0;

  const volumeScore = volume24h > 0
    ? Math.log10(Math.max(10, volume24h))
    : 0;

  return bearishPressure + volumeScore;
}

function sortShortUniverse(a, b) {
  const scoreDelta = shortUniverseScore(b) - shortUniverseScore(a);

  if (scoreDelta !== 0) return scoreDelta;

  return safeNumber(b.volume24h, 0) - safeNumber(a.volume24h, 0);
}

function buildTickerUniverse(rawTickers) {
  const normalized = (Array.isArray(rawTickers) ? rawTickers : [])
    .map(normalizeScannerTicker)
    .filter(Boolean)
    .filter(isTradableTicker);

  return dedupeByBaseSymbol(normalized)
    .sort(sortShortUniverse)
    .slice(0, scannerMaxSymbols());
}

function createCandleCache() {
  const cache = new Map();

  return async function getCandles(symbol, timeframe = '15m', limit = CONFIG.scanner.candleLimit) {
    const contractSymbol = normalizeContractSymbol(symbol);
    const candleLimit = Math.max(30, Math.floor(safeNumber(limit, CONFIG.scanner.candleLimit || 80)));

    if (!isValidUsdtFuturesContractSymbol(contractSymbol)) {
      return [];
    }

    const key = `${contractSymbol}:${timeframe}:${candleLimit}`;

    if (cache.has(key)) return cache.get(key);

    const promise = fetchCandles(contractSymbol, timeframe, candleLimit).catch(() => []);
    cache.set(key, promise);

    return promise;
  };
}

async function buildBtcContext({ universe, getCandles }) {
  const btcTicker =
    universe.find((row) => row.baseSymbol === 'BTC') ||
    normalizeScannerTicker({
      symbol: 'BTCUSDT',
      last: 0,
      quoteVolume: 0,
      change24h: 0
    }) ||
    {
      symbol: 'BTCUSDT',
      contractSymbol: 'BTCUSDT',
      baseSymbol: 'BTC',
      price: 0,
      volume24h: 0,
      change24h: 0
    };

  const btcCandles15m = await getCandles(
    'BTCUSDT',
    '15m',
    CONFIG.scanner.candleLimit
  );

  const btcChange1h = calcOneHourChange(btcCandles15m);
  const btcChange24h = safeNumber(btcTicker.change24h, 0);

  const btcState = classifyBtcState({
    change24: btcChange24h,
    change1h: btcChange1h
  });

  const btcAtrPct = calculateAtrPct(btcCandles15m, 14);
  const volRegime = classifyVolatilityRegime(btcCandles15m, btcAtrPct);

  const regime =
    volRegime === 'EXTREME_VOL' ? 'HIGH_VOL' :
    volRegime === 'HIGH_VOL' ? 'HIGH_VOL' :
    volRegime === 'LOW_VOL' ? 'LOW_VOL' :
    'NORMAL_VOL';

  return {
    btcState,
    regime,
    btcChange1h: Number(btcChange1h.toFixed(3)),
    btcChange24h: Number(btcChange24h.toFixed(3)),
    btcAtrPct: Number(btcAtrPct.toFixed(6))
  };
}

function buildGateFlags({
  change1h,
  change24h,
  fake,
  side,
  volume24h
}) {
  const passesMoveFilter =
    Math.abs(change1h) >= minAbsChange1h() ||
    Math.abs(change24h) >= minAbsChange24h();

  const passesVolumeFilter = safeNumber(volume24h, 0) >= minQuoteVolume24h();
  const hasDirectionalSide = side === TARGET_SCANNER_SIDE;

  const hardBlockedByDirection =
    blockNoDirectionEnabled() &&
    !hasDirectionalSide;

  const hardBlockedByMove =
    blockSmallMoveEnabled() &&
    !passesMoveFilter;

  const hardBlockedByFake =
    blockFakeBreakoutEnabled() &&
    Boolean(fake.fakeBreakout);

  const hardBlocked =
    hardBlockedByDirection ||
    hardBlockedByMove ||
    hardBlockedByFake;

  const scannerGatePassed =
    !hardBlocked &&
    passesMoveFilter &&
    passesVolumeFilter &&
    hasDirectionalSide &&
    !fake.fakeBreakout;

  return {
    passesMoveFilter,
    passesVolumeFilter,
    hasDirectionalSide,

    hardBlocked,
    hardBlockedByDirection,
    hardBlockedByMove,
    hardBlockedByFake,

    scannerGatePassed,
    scannerGateReason: scannerGatePassed
      ? null
      : !passesVolumeFilter
        ? 'SHORT_VOLUME_FILTER_NOT_PASSED'
        : !passesMoveFilter
          ? 'SHORT_MOVE_FILTER_NOT_PASSED'
          : !hasDirectionalSide
            ? 'SHORT_DIRECTION_FILTER_NOT_PASSED'
            : fake.fakeBreakout
              ? 'SHORT_FAKE_BREAKOUT'
              : 'SHORT_SCANNER_GATE_NOT_PASSED',

    analyzeEligible: !hardBlocked && hasDirectionalSide,
    tradeDiscoveryOnly: !scannerGatePassed
  };
}

async function analyzeTickerCandidate({
  ticker,
  snapshotId,
  startedAt,
  btcState,
  regime,
  getCandles
}) {
  const normalizedTicker = normalizeScannerTicker(ticker);

  if (!normalizedTicker) {
    return {
      candidate: null,
      skippedReason: 'INVALID_SYMBOL'
    };
  }

  const contractSymbol = normalizedTicker.contractSymbol;
  const baseSymbol = normalizedTicker.baseSymbol;

  if (!isValidUsdtFuturesContractSymbol(contractSymbol)) {
    return {
      candidate: null,
      skippedReason: 'INVALID_CONTRACT_SYMBOL'
    };
  }

  if (isBlockedBaseSymbol(baseSymbol)) {
    return {
      candidate: null,
      skippedReason: 'BLOCKED_BASE_SYMBOL'
    };
  }

  const candles15m = await getCandles(
    contractSymbol,
    '15m',
    CONFIG.scanner.candleLimit
  );

  if (candles15m.length < 30) {
    return {
      candidate: null,
      skippedReason: 'INSUFFICIENT_CANDLES'
    };
  }

  const change1h = calcOneHourChange(candles15m);
  const change24h = safeNumber(normalizedTicker.change24h, 0);
  const side = inferSide({
    change1h,
    change24h,
    btcState
  });

  if (side !== TARGET_SCANNER_SIDE) {
    return {
      candidate: null,
      skippedReason: 'SHORT_ONLY_NOT_BEARISH'
    };
  }

  const tickerVolume24h = safeNumber(normalizedTicker.volume24h, 0);
  const candleVolume24h = estimateQuoteVolumeFromCandles(candles15m, 96);
  const volume24h = tickerVolume24h > 0
    ? tickerVolume24h
    : candleVolume24h;

  const fakeRaw = detectFakeBreakout({
    side,
    candles15m,
    btcState,
    lookback: CONFIG.scanner.fakeBreakoutLookback
  });

  const fake = cleanFakeResult(fakeRaw);

  const gates = buildGateFlags({
    change1h,
    change24h,
    fake,
    side,
    volume24h
  });

  if (gates.hardBlocked) {
    return {
      candidate: null,
      skippedReason: gates.hardBlockedByDirection
        ? 'NO_SHORT_DIRECTION'
        : gates.hardBlockedByMove
          ? 'SHORT_MOVE_TOO_SMALL'
          : 'SHORT_FAKE_BREAKOUT'
    };
  }

  const volumeExpansion = calcVolumeExpansion(candles15m, 20);
  const sideConfidenceLevel = sideConfidence({
    side,
    change1h,
    change24h
  });

  const scannerScore = calcScannerScore({
    change1h,
    change24h,
    volume24h,
    volumeExpansion,
    sideConfidenceLevel,
    ...fake
  });

  const lastClose = safeNumber(candles15m.at(-1)?.close, 0);
  const price = lastClose > 0 ? lastClose : safeNumber(normalizedTicker.price, 0);

  return {
    candidate: {
      snapshotId,

      symbol: baseSymbol,
      baseSymbol,
      contractSymbol,

      side: TARGET_SCANNER_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      positionSide: TARGET_TRADE_SIDE,
      direction: TARGET_TRADE_SIDE,

      scannerSide: TARGET_TRADE_SIDE,
      actualScannerSide: TARGET_TRADE_SIDE,
      analysisSide: TARGET_TRADE_SIDE,

      directionalSide: TARGET_SCANNER_SIDE,
      inferredDirectionalSide: TARGET_SCANNER_SIDE,
      marketSide: TARGET_SCANNER_SIDE,

      shortOnly: true,
      longDisabled: true,

      price,

      scannerScore,
      moveScore: scannerScore,

      change1h: Number(change1h.toFixed(3)),
      change24h: Number(change24h.toFixed(3)),
      volume24h: Number(volume24h.toFixed(2)),
      tickerVolume24h: Number(tickerVolume24h.toFixed(2)),
      candleVolume24h: Number(candleVolume24h.toFixed(2)),
      volumeSource: tickerVolume24h > 0 ? 'TICKER' : 'CANDLES_15M_ESTIMATE',
      volumeExpansion: Number(volumeExpansion.toFixed(3)),

      btcState,
      regime,

      sideConfidence: sideConfidenceLevel,

      ...fake,
      ...gates,

      scannerReason: scannerReasonFrom({
        fake,
        volumeExpansion,
        passesMoveFilter: gates.passesMoveFilter,
        passesVolumeFilter: gates.passesVolumeFilter,
        sideConfidenceLevel
      }),

      scannerTs: startedAt
    },
    skippedReason: null
  };
}

function countSkipped(results) {
  return results.reduce((acc, row) => {
    const reason = row?.skippedReason || (row?.candidate ? 'SELECTED' : 'UNKNOWN');

    acc[reason] = (acc[reason] || 0) + 1;

    return acc;
  }, {});
}

function isShortCandidate(candidate = {}) {
  return (
    candidate.side === TARGET_SCANNER_SIDE ||
    candidate.tradeSide === TARGET_TRADE_SIDE ||
    candidate.positionSide === TARGET_TRADE_SIDE ||
    candidate.direction === TARGET_TRADE_SIDE
  );
}

function sortCandidates(candidates = []) {
  return [...candidates].sort((a, b) => {
    const gateDelta = Number(Boolean(b.scannerGatePassed)) - Number(Boolean(a.scannerGatePassed));
    if (gateDelta !== 0) return gateDelta;

    const scoreDelta = safeNumber(b.scannerScore, 0) - safeNumber(a.scannerScore, 0);
    if (scoreDelta !== 0) return scoreDelta;

    const changeDelta = Math.abs(safeNumber(b.change1h, 0)) - Math.abs(safeNumber(a.change1h, 0));
    if (changeDelta !== 0) return changeDelta;

    return safeNumber(b.volume24h, 0) - safeNumber(a.volume24h, 0);
  });
}

export async function runScanner() {
  const redis = getVolatileRedis();

  const startedAt = Date.now();
  const snapshotId = randomId('scan_short');
  const getCandles = createCandleCache();

  const rawTickers = await fetchBitgetTickers();
  const universe = buildTickerUniverse(rawTickers);

  const btcContext = await buildBtcContext({
    universe,
    getCandles
  });

  const results = await mapConcurrent(
    universe,
    scannerConcurrency(),
    async (ticker) => analyzeTickerCandidate({
      ticker,
      snapshotId,
      startedAt,
      btcState: btcContext.btcState,
      regime: btcContext.regime,
      getCandles
    })
  );

  const allCandidates = results
    .map((row) => row?.candidate)
    .filter(Boolean)
    .filter(isShortCandidate);

  const cleanCandidates = sortCandidates(allCandidates)
    .slice(0, scannerMaxCandidates());

  const scannerGateCandidates = cleanCandidates.filter((candidate) => candidate.scannerGatePassed);
  const analyzeOnlyCandidates = cleanCandidates.filter((candidate) => candidate.tradeDiscoveryOnly);

  const completedAt = Date.now();

  const snapshot = {
    ok: true,

    sideMode: 'SHORT_ONLY',
    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_SCANNER_SIDE,
    dashboardSide: TARGET_SCANNER_SIDE,
    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    snapshotId,
    createdAt: startedAt,
    completedAt,
    durationMs: completedAt - startedAt,

    btcState: btcContext.btcState,
    regime: btcContext.regime,
    btcChange1h: btcContext.btcChange1h,
    btcChange24h: btcContext.btcChange24h,
    btcAtrPct: btcContext.btcAtrPct,

    rawCount: Array.isArray(rawTickers) ? rawTickers.length : 0,
    filteredUniverse: universe.length,

    candidatesCount: cleanCandidates.length,
    scannerGateCandidatesCount: scannerGateCandidates.length,
    analyzeOnlyCandidatesCount: analyzeOnlyCandidates.length,

    maxSymbols: scannerMaxSymbols(),
    maxCandidates: scannerMaxCandidates(),

    strictFilters: strictScannerFiltersEnabled(),
    blockFakeBreakout: blockFakeBreakoutEnabled(),
    blockNoDirection: blockNoDirectionEnabled(),
    blockSmallMove: blockSmallMoveEnabled(),

    minQuoteVolume24h: minQuoteVolume24h(),
    softMinQuoteVolume24h: softMinQuoteVolume24h(),
    minAbsChange1h: minAbsChange1h(),
    minAbsChange24h: minAbsChange24h(),

    skippedCounts: countSkipped(results),

    topSymbols: cleanCandidates
      .slice(0, 20)
      .map((candidate) => candidate.symbol),

    scannerGateSymbols: scannerGateCandidates
      .slice(0, 20)
      .map((candidate) => candidate.symbol),

    analyzeOnlySymbols: analyzeOnlyCandidates
      .slice(0, 20)
      .map((candidate) => candidate.symbol),

    candidates: cleanCandidates
  };

  await setJson(
    redis,
    KEYS.scan.snapshot(snapshotId),
    snapshot,
    {
      ex: CONFIG.scanner.snapshotTtlSec
    }
  );

  await setJson(
    redis,
    KEYS.scan.latest,
    {
      ok: true,

      sideMode: 'SHORT_ONLY',
      targetTradeSide: TARGET_TRADE_SIDE,
      targetScannerSide: TARGET_SCANNER_SIDE,
      dashboardSide: TARGET_SCANNER_SIDE,
      shortOnly: true,
      longDisabled: true,
      longOnly: false,
      shortDisabled: false,

      snapshotId,
      createdAt: startedAt,
      completedAt,
      durationMs: snapshot.durationMs,

      candidatesCount: cleanCandidates.length,
      scannerGateCandidatesCount: scannerGateCandidates.length,
      analyzeOnlyCandidatesCount: analyzeOnlyCandidates.length,

      btcState: btcContext.btcState,
      regime: btcContext.regime,

      rawCount: snapshot.rawCount,
      filteredUniverse: snapshot.filteredUniverse,
      maxSymbols: snapshot.maxSymbols,
      maxCandidates: snapshot.maxCandidates,

      strictFilters: snapshot.strictFilters,
      blockFakeBreakout: snapshot.blockFakeBreakout,
      blockNoDirection: snapshot.blockNoDirection,
      blockSmallMove: snapshot.blockSmallMove,

      minQuoteVolume24h: snapshot.minQuoteVolume24h,
      softMinQuoteVolume24h: snapshot.softMinQuoteVolume24h,
      minAbsChange1h: snapshot.minAbsChange1h,
      minAbsChange24h: snapshot.minAbsChange24h,

      skippedCounts: snapshot.skippedCounts,

      topSymbols: snapshot.topSymbols,
      scannerGateSymbols: snapshot.scannerGateSymbols,
      analyzeOnlySymbols: snapshot.analyzeOnlySymbols
    },
    {
      ex: CONFIG.scanner.snapshotTtlSec
    }
  );

  return snapshot;
}