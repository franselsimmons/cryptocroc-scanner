// ================= FILE: src/historical/researchEngine.js =================
// Point-in-time historical research/replay engine.
// IMPORTANT: this module never writes live learning keys. Publishing is isolated under LONG:HISTORICAL:*.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { runScanner } from '../market/scanner.js';
import { buildRiskAndLiveMetricsForBothSides } from '../trade/riskEngine.js';
import { attachMicroFamilies } from '../analyze/microFamilies.js';
import { applyCostsFromPrices } from '../trade/costModel.js';
import { getDurableRedis, getJson, setJson } from '../redis.js';
import {
  TEMPORAL_CONTEXT_VERSION,
  TEMPORAL_TAXONOMY_VERSION,
  TEMPORAL_COST_MODEL_VERSION,
  buildTemporalContext
} from '../analyze/scoring.js';

export const HISTORICAL_REPLAY_VERSION = 'LONG_POINT_IN_TIME_REPLAY_V1';
export const HISTORICAL_EVIDENCE_VERSION = 'LONG_HISTORICAL_WALK_FORWARD_EVIDENCE_V1';
export const HISTORICAL_SELECTION_VERSION = 'LONG_HISTORICAL_SELECTION_BRIDGE_V1';

const SIDE = 'LONG';
const DASHBOARD_SIDE = 'bull';
const OPPOSITE_SIDE = 'SHORT';
const NAMESPACE = SIDE;
const PREFIX = `${NAMESPACE}:`;
const PRODUCT_TYPE = 'usdt-futures';
const BASE_URL = String(process.env.BITGET_BASE_URL || 'https://api.bitget.com').replace(/\/+$/, '');
const MEASUREMENT_FIX_VERSION = 'LONG_MEASUREMENT_FIX_TRIGGER_BOUNDARY_EXIT_FILL_V2';
const EXIT_FILL_MODEL_VERSION = 'LONG_TRIGGER_BOUNDARY_FILL_PLUS_COST_MODEL_V1';
const TIME_STOP_MIN = 720;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const FIFTEEN_MS = 15 * MINUTE_MS;
const CACHE_DIR = process.env.HISTORICAL_CACHE_DIR || '.historical-cache';
const DEPTH_DIR = process.env.HISTORICAL_DEPTH_DIR || '.historical-depth';
const MAX_HISTORY_DAYS = Math.max(90, Number(process.env.HISTORICAL_MAX_DAYS || 365));
const MAX_OUTCOMES_PER_FAMILY = Math.max(200, Math.min(800, Number(process.env.HISTORICAL_MAX_OUTCOMES_PER_FAMILY || 600)));
const API_CONCURRENCY = Math.max(1, Math.min(12, Number(process.env.HISTORICAL_API_CONCURRENCY || 8)));
const API_RETRIES = Math.max(2, Math.min(8, Number(process.env.HISTORICAL_API_RETRIES || 5)));
const WARMUP_DAYS = Math.max(2, Number(process.env.HISTORICAL_WARMUP_DAYS || 3));

const SETUPS = ['BREAKOUT', 'RETEST', 'SWEEP_REVERSAL', 'CONTINUATION', 'COMPRESSION'];
const REGIMES = ['TREND', 'CHOP', 'SQUEEZE'];
const CONFIRMATIONS = ['A_STRONG_ALIGN', 'B_FLOW_ALIGN', 'C_VOLUME_ALIGN', 'D_MIXED_OK', 'E_WEAK_CONTRA'];
const ALL_FAMILY_IDS = Object.freeze(
  SETUPS.flatMap((setup) => REGIMES.flatMap((regime) => CONFIRMATIONS.map((confirmation) =>
    `MICRO_${SIDE}_${setup}_${regime}_${confirmation}`
  )))
);
const FAMILY_SET = new Set(ALL_FAMILY_IDS);

function now() { return Date.now(); }
function finite(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, finite(value, min))); }
function upper(value = '') { return String(value || '').trim().toUpperCase(); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function sha(value) { return createHash('sha256').update(String(value)).digest('hex'); }
function mkdir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
function normalizeSymbol(value = '') { return upper(value).replace(/[^A-Z0-9]/g, ''); }
function baseSymbol(value = '') { return normalizeSymbol(value).replace(/USDT$/u, ''); }
function iso(ts) { return new Date(ts).toISOString(); }
function floorTo(ts, interval) { return Math.floor(finite(ts, 0) / interval) * interval; }
function ceilTo(ts, interval) { return Math.ceil(finite(ts, 0) / interval) * interval; }
function dateKey(ts) { return new Date(ts).toISOString().slice(0, 10); }
function weekKey(ts) {
  const d = new Date(ts); const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / DAY_MS) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
function familyIdOf(row = {}) {
  const id = upper(row.trueMicroFamilyId || row.childTrueMicroFamilyId || row.microFamilyId || row.familyId);
  return FAMILY_SET.has(id) ? id : null;
}
function jsonWrite(file, value) { mkdir(path.dirname(file)); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function jsonRead(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function jsonlWrite(file, rows = []) { mkdir(path.dirname(file)); fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')); }
function jsonlRead(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)); }
  catch { return []; }
}
function parseArgs(argv = process.argv.slice(2)) {
  const command = argv.find((arg) => !arg.startsWith('--')) || 'help';
  const args = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const index = raw.indexOf('=');
    const key = (index >= 0 ? raw.slice(2, index) : raw.slice(2)).replace(/-/g, '_');
    const value = index >= 0 ? raw.slice(index + 1) : 'true';
    args[key] = value;
  }
  return { command, args };
}
function bool(value, fallback = false) {
  if (value == null) return fallback;
  return ['1', 'true', 'yes', 'on', 'y'].includes(String(value).trim().toLowerCase());
}
function parseTs(value, fallback) {
  if (value == null || value === '') return fallback;
  const numeric = Number(value); if (Number.isFinite(numeric) && numeric > 10_000_000_000) return numeric;
  const parsed = Date.parse(String(value)); return Number.isFinite(parsed) ? parsed : fallback;
}
function cacheFile(name) { return path.join(CACHE_DIR, `${sha(name).slice(0, 24)}.json.gz`); }
function cacheGet(name) {
  const file = cacheFile(name); if (!fs.existsSync(file)) return null;
  try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')); } catch { return null; }
}
function cacheSet(name, value) {
  mkdir(CACHE_DIR); fs.writeFileSync(cacheFile(name), zlib.gzipSync(Buffer.from(JSON.stringify(value)))); return value;
}

let apiPaceChain = Promise.resolve();
let nextApiRequestAt = 0;
async function pacePublicApi() {
  let release;
  const previous = apiPaceChain;
  apiPaceChain = new Promise((resolve) => { release = resolve; });
  await previous;
  const waitMs = Math.max(0, nextApiRequestAt - Date.now());
  if (waitMs > 0) await sleep(waitMs);
  nextApiRequestAt = Date.now() + 70; // ~14 req/s, safely under 20 req/s/IP.
  release();
}

async function fetchJson(endpoint, params = {}, { retries = API_RETRIES } = {}) {
  const url = new URL(endpoint.startsWith('http') ? endpoint : `${BASE_URL}${endpoint}`);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await pacePublicApi();
      const response = await fetch(url, { headers: { 'User-Agent': `CryptoCroc-${SIDE}-HistoricalResearch/1.0` } });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP_${response.status}:${text.slice(0, 240)}`);
      const body = JSON.parse(text);
      if (String(body?.code || '00000') !== '00000') throw new Error(`BITGET_${body?.code}:${body?.msg || 'ERROR'}`);
      return body?.data ?? body;
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;
      await sleep(Math.min(5000, 250 * (2 ** attempt)) + Math.floor(Math.random() * 150));
    }
  }
  throw lastError || new Error('BITGET_FETCH_FAILED');
}

function candleInterval(granularity) {
  const map = { '1m': MINUTE_MS, '3m': 3 * MINUTE_MS, '5m': 5 * MINUTE_MS, '15m': FIFTEEN_MS, '30m': 30 * MINUTE_MS, '1H': HOUR_MS, '4H': 4 * HOUR_MS, '1D': DAY_MS };
  return map[granularity] || FIFTEEN_MS;
}
function parseCandle(row) {
  if (!Array.isArray(row) || row.length < 5) return null;
  const ts = finite(row[0], 0), open = finite(row[1], 0), high = finite(row[2], 0), low = finite(row[3], 0), close = finite(row[4], 0);
  if (!(ts > 0 && open > 0 && high > 0 && low > 0 && close > 0)) return null;
  return { ts, open, high, low, close, volume: Math.max(0, finite(row[5], 0)), quoteVolume: Math.max(0, finite(row[6], 0)) };
}
async function historicalCandles(symbol, granularity, startTs, endTs) {
  const contractSymbol = normalizeSymbol(symbol); const interval = candleInterval(granularity);
  const start = floorTo(startTs, interval), end = floorTo(endTs, interval);
  const key = `candles|${contractSymbol}|${granularity}|${start}|${end}`;
  const cached = cacheGet(key); if (Array.isArray(cached)) return cached;
  const rows = new Map(); let cursorEnd = end; let guard = 0;
  while (cursorEnd >= start && guard < 10_000) {
    guard += 1;
    const raw = await fetchJson('/api/v2/mix/market/history-candles', {
      symbol: contractSymbol, productType: PRODUCT_TYPE, granularity, startTime: start, endTime: cursorEnd, limit: 200
    });
    const batch = (Array.isArray(raw) ? raw : []).map(parseCandle).filter(Boolean);
    if (!batch.length) break;
    for (const row of batch) if (row.ts >= start && row.ts <= end) rows.set(row.ts, row);
    const earliest = Math.min(...batch.map((row) => row.ts));
    if (!Number.isFinite(earliest) || earliest <= start) break;
    const nextEnd = earliest - interval; if (nextEnd >= cursorEnd) break; cursorEnd = nextEnd;
    await sleep(35);
  }
  return cacheSet(key, [...rows.values()].sort((a, b) => a.ts - b.ts));
}

async function contracts() {
  const key = `contracts|usdt-futures|v3|${weekKey(now())}`; const cached = cacheGet(key); if (Array.isArray(cached) && cached.length) return cached;
  const raw = await fetchJson('/api/v2/mix/market/contracts', { productType: PRODUCT_TYPE });
  const list = (Array.isArray(raw) ? raw : []).filter((row) => {
    const symbol = normalizeSymbol(row?.symbol); const quote = upper(row?.quoteCoin);
    const perpetual = !row?.symbolType || upper(row.symbolType) === 'PERPETUAL';
    return symbol.endsWith('USDT') && quote === 'USDT' && perpetual && upper(row?.isRwa) !== 'YES';
  }).map((row) => ({
    symbol: normalizeSymbol(row.symbol), baseCoin: upper(row.baseCoin || baseSymbol(row.symbol)), quoteCoin: 'USDT',
    launchTime: finite(row.launchTime, 0), offTime: finite(row.offTime, -1), symbolStatus: upper(row.symbolStatus || 'NORMAL'),
    makerFeeRate: finite(row.makerFeeRate, 0.0004), takerFeeRate: finite(row.takerFeeRate, 0.0006), isRwa: upper(row.isRwa || 'NO')
  }));
  return cacheSet(key, list);
}

async function mapLimit(items, limit, fn) {
  const source = Array.from(items || []); const out = new Array(source.length); let cursor = 0;
  async function worker() { while (true) { const index = cursor++; if (index >= source.length) return; out[index] = await fn(source[index], index); } }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), Math.max(1, source.length)) }, () => worker())); return out;
}
function rightClosedIndex(rows, asOfTs, interval) {
  let low = 0, high = rows.length - 1, answer = -1;
  while (low <= high) { const mid = (low + high) >> 1; if (rows[mid].ts + interval <= asOfTs) { answer = mid; low = mid + 1; } else high = mid - 1; }
  return answer;
}
function aggregate1h(rows = []) {
  const buckets = new Map();
  for (const row of rows) {
    const ts = floorTo(row.ts, HOUR_MS); let bucket = buckets.get(ts);
    if (!bucket) { bucket = { ts, open: row.open, high: row.high, low: row.low, close: row.close, volume: 0, quoteVolume: 0 }; buckets.set(ts, bucket); }
    bucket.high = Math.max(bucket.high, row.high); bucket.low = Math.min(bucket.low, row.low); bucket.close = row.close; bucket.volume += row.volume; bucket.quoteVolume += row.quoteVolume;
  }
  return [...buckets.values()].sort((a, b) => a.ts - b.ts);
}

class HistoricalStore {
  constructor({ startTs, endTs, maxContracts = 0 } = {}) {
    this.startTs = startTs; this.endTs = endTs; this.maxContracts = Math.max(0, Number(maxContracts || 0));
    this.series15m = new Map(); this.funding = new Map(); this.depth = new Map(); this.asOfTs = startTs; this.contractRows = [];
  }
  async prepare() {
    const list = await contracts();
    const eligible = list.filter((row) => (!row.launchTime || row.launchTime <= this.endTs) && (row.offTime < 0 || row.offTime >= this.startTs));
    const limited = this.maxContracts > 0 ? eligible.slice(0, this.maxContracts) : eligible;
    const warmStart = this.startTs - WARMUP_DAYS * DAY_MS;
    const loaded = await mapLimit(limited, API_CONCURRENCY, async (contract) => {
      try {
        const candles = await historicalCandles(contract.symbol, '15m', warmStart, this.endTs);
        if (candles.length < 120) return null;
        this.series15m.set(contract.symbol, candles); return contract;
      } catch (error) {
        console.warn('HISTORICAL_15M_LOAD_FAILED', JSON.stringify({ side: SIDE, symbol: contract.symbol, error: error?.message || String(error) })); return null;
      }
    });
    this.contractRows = loaded.filter(Boolean);
    return { contractsRequested: limited.length, contractsLoaded: this.contractRows.length, universeQuality: 'CURRENT_CONTRACT_CATALOG_WITH_LAUNCH_OFF_FILTER' };
  }
  setAsOf(ts) { this.asOfTs = ts; }
  async getCandles(symbol, timeframe = '15m', limit = 100) {
    const contractSymbol = normalizeSymbol(symbol); const rows15 = this.series15m.get(contractSymbol) || [];
    const safeLimit = Math.max(1, Math.floor(finite(limit, 100)));
    if (!rows15.length) return [];
    if (String(timeframe).toLowerCase() === '1h' || String(timeframe).toUpperCase() === '1H') {
      const idx = rightClosedIndex(rows15, this.asOfTs, FIFTEEN_MS); if (idx < 0) return [];
      return aggregate1h(rows15.slice(Math.max(0, idx - safeLimit * 4 - 8), idx + 1)).slice(-safeLimit);
    }
    const idx = rightClosedIndex(rows15, this.asOfTs, FIFTEEN_MS); if (idx < 0) return [];
    return rows15.slice(Math.max(0, idx - safeLimit + 1), idx + 1);
  }
  tickerRows(asOfTs) {
    this.setAsOf(asOfTs); const out = [];
    for (const contract of this.contractRows) {
      if (contract.launchTime && contract.launchTime > asOfTs) continue;
      if (contract.offTime >= 0 && contract.offTime < asOfTs) continue;
      const rows = this.series15m.get(contract.symbol) || []; const idx = rightClosedIndex(rows, asOfTs, FIFTEEN_MS); if (idx < 20) continue;
      const window = rows.slice(Math.max(0, idx - 95), idx + 1); const last = window.at(-1); const first = window[0];
      if (!last || !first) continue;
      const quoteVolume = window.reduce((sum, row) => sum + Math.max(0, row.quoteVolume || row.volume * row.close), 0);
      const baseVolume = window.reduce((sum, row) => sum + Math.max(0, row.volume), 0);
      const high24h = Math.max(...window.map((row) => row.high)), low24h = Math.min(...window.map((row) => row.low));
      const spread = this.proxySpread(contract.symbol, asOfTs);
      out.push({
        symbol: contract.symbol, lastPr: String(last.close), markPrice: String(last.close), indexPrice: String(last.close),
        open24h: String(first.open), high24h: String(high24h), low24h: String(low24h), baseVolume: String(baseVolume),
        quoteVolume: String(quoteVolume), usdtVolume: String(quoteVolume), ts: String(asOfTs),
        bidPr: String(last.close * (1 - spread / 2)), askPr: String(last.close * (1 + spread / 2)),
        change24h: String(((last.close - first.open) / first.open) * 100), fundingRate: '0'
      });
    }
    return out;
  }
  proxySpread(symbol, asOfTs = this.asOfTs) {
    const rows = this.series15m.get(normalizeSymbol(symbol)) || []; const idx = rightClosedIndex(rows, asOfTs, FIFTEEN_MS); if (idx < 0) return 0.0008;
    const sample = rows.slice(Math.max(0, idx - 19), idx + 1); const range = sample.reduce((sum, row) => sum + ((row.high - row.low) / Math.max(row.close, 1e-12)), 0) / Math.max(1, sample.length);
    return clamp(range * 0.045, 0.00008, 0.0035);
  }
  quoteVolume24h(symbol, asOfTs = this.asOfTs) {
    const rows = this.series15m.get(normalizeSymbol(symbol)) || []; const idx = rightClosedIndex(rows, asOfTs, FIFTEEN_MS); if (idx < 0) return 0;
    return rows.slice(Math.max(0, idx - 95), idx + 1).reduce((sum, row) => sum + Math.max(0, row.quoteVolume || row.volume * row.close), 0);
  }
  async fundingAsOf(symbol, asOfTs = this.asOfTs) {
    const contractSymbol = normalizeSymbol(symbol);
    if (!this.funding.has(contractSymbol)) {
      const values = []; let page = 1;
      while (page <= 20) {
        try {
          const raw = await fetchJson('/api/v2/mix/market/history-fund-rate', { symbol: contractSymbol, productType: PRODUCT_TYPE, pageSize: 100, pageNo: page });
          const batch = (Array.isArray(raw) ? raw : []).map((row) => ({ rate: finite(row.fundingRate, 0), ts: finite(row.fundingTime, 0) })).filter((row) => row.ts > 0);
          values.push(...batch); if (batch.length < 100 || Math.min(...batch.map((row) => row.ts)) < this.startTs - 2 * DAY_MS) break; page += 1; await sleep(30);
        } catch { break; }
      }
      values.sort((a, b) => a.ts - b.ts); this.funding.set(contractSymbol, values);
    }
    const values = this.funding.get(contractSymbol) || []; let result = null;
    for (const row of values) { if (row.ts <= asOfTs) result = row; else break; }
    return { rate: result?.rate ?? 0, fundingTime: result?.ts || null, quality: result ? 'BITGET_HISTORICAL' : 'MISSING_NEUTRAL' };
  }
  depthFile(symbol) { return path.join(DEPTH_DIR, `${normalizeSymbol(symbol)}.jsonl`); }
  loadDepth(symbol) {
    const contractSymbol = normalizeSymbol(symbol); if (this.depth.has(contractSymbol)) return this.depth.get(contractSymbol);
    const file = this.depthFile(contractSymbol); const rows = fs.existsSync(file) ? jsonlRead(file).filter((row) => finite(row.ts, 0) > 0).sort((a, b) => finite(a.ts, 0) - finite(b.ts, 0)) : [];
    this.depth.set(contractSymbol, rows); return rows;
  }
  orderBookAsOf(symbol, asOfTs = this.asOfTs) {
    const contractSymbol = normalizeSymbol(symbol); const snapshots = this.loadDepth(contractSymbol); let exact = null;
    for (let i = snapshots.length - 1; i >= 0; i -= 1) { const ts = finite(snapshots[i].ts, 0); if (ts <= asOfTs && asOfTs - ts <= 5 * MINUTE_MS) { exact = snapshots[i]; break; } if (ts < asOfTs - 5 * MINUTE_MS) break; }
    if (exact && Array.isArray(exact.bids) && Array.isArray(exact.asks) && exact.bids.length && exact.asks.length) {
      const bestBid = finite(exact.bids[0]?.[0], 0), bestAsk = finite(exact.asks[0]?.[0], 0), mid = (bestBid + bestAsk) / 2;
      const bidDepth = exact.bids.filter(([p]) => finite(p, 0) >= mid * 0.99).reduce((s, [p, q]) => s + finite(p, 0) * finite(q, 0), 0);
      const askDepth = exact.asks.filter(([p]) => finite(p, 0) <= mid * 1.01).reduce((s, [p, q]) => s + finite(p, 0) * finite(q, 0), 0);
      return { spreadPct: mid > 0 ? (bestAsk - bestBid) / mid : 0, bidDepthUsd1p: bidDepth, askDepthUsd1p: askDepth, depthMinUsd1p: Math.min(bidDepth, askDepth), bias: bidDepth > askDepth * 1.12 ? 'BULLISH' : askDepth > bidDepth * 1.12 ? 'BEARISH' : 'NEUTRAL', historicalOrderBookQuality: 'EXACT_DEPTH_SNAPSHOT' };
    }
    const spreadPct = this.proxySpread(contractSymbol, asOfTs); const quote = this.quoteVolume24h(contractSymbol, asOfTs); const depth = clamp(quote * 0.0025, 100_000, 15_000_000);
    return { spreadPct, bidDepthUsd1p: depth, askDepthUsd1p: depth, depthMinUsd1p: depth, bias: 'NEUTRAL', historicalOrderBookQuality: 'CONSERVATIVE_CANDLE_VOLUME_PROXY' };
  }
  async exitCandles1m(symbol, entryTs, deadlineTs) {
    const rows = [];
    const firstDay = floorTo(entryTs, DAY_MS);
    const lastDay = floorTo(deadlineTs, DAY_MS);
    for (let day = firstDay; day <= lastDay; day += DAY_MS) {
      const dayRows = await historicalCandles(symbol, '1m', day, day + DAY_MS - MINUTE_MS);
      rows.push(...dayRows);
    }
    return rows.filter((row) => row.ts >= entryTs && row.ts < deadlineTs).sort((a, b) => a.ts - b.ts);
  }
  async exitCandles15m(symbol, entryTs, deadlineTs) {
    const rows = this.series15m.get(normalizeSymbol(symbol)) || [];
    return rows.filter((row) => row.ts >= entryTs && row.ts < deadlineTs);
  }
}

function normalizedBtcState(value) {
  const v = upper(value); if (['STRONG_BULL', 'STRONG_BULLISH'].includes(v)) return 'STRONG_BULLISH';
  if (['BULL', 'BULLISH'].includes(v)) return 'BULLISH'; if (['BEAR', 'BEARISH'].includes(v)) return 'BEARISH';
  if (['STRONG_BEAR', 'STRONG_BEARISH'].includes(v)) return 'STRONG_BEARISH'; if (v === 'NEUTRAL') return 'NEUTRAL'; return 'UNKNOWN';
}
function weatherContext(payload = {}) {
  const regime = upper(payload.currentRegime || payload.regime || 'UNKNOWN'); const trendSide = upper(payload.currentTrendSide || payload.trendSide || 'UNKNOWN');
  return { entryMarketWeatherKey: `${regime}|${trendSide}`, entryMarketWeatherRegime: regime, entryMarketWeatherTrendSide: trendSide, entryMarketWeatherAvailable: regime !== 'UNKNOWN' && trendSide !== 'UNKNOWN' };
}
function entryTemporalContext(ts) {
  const context = buildTemporalContext(ts);
  const hourUtc = Math.max(0, Math.min(23, Math.floor(finite(context?.hourUtc, new Date(ts).getUTCHours()))));
  return {
    entryHourUtc: hourUtc,
    entryHourBucket: `H${String(hourUtc).padStart(2, '0')}`,
    entryDayOfWeekUtc: context?.dayOfWeekUtc || null,
    entryDayType: context?.dayType || null,
    entryIsWeekend: context?.isWeekend === true,
    entrySessionTags: Array.isArray(context?.sessionTags) ? context.sessionTags : [],
    entrySessionBucket: context?.primarySessionBucket || null,
    entrySessionOverlap: context?.sessionOverlap === true,
    entryOffHours: context?.offHours === true,
    entryDateUtc: context?.entryDateUtc || dateKey(ts),
    entryIsoWeekUtc: context?.isoWeekUtc || weekKey(ts)
  };
}
function validGeometry({ entry, sl, tp }) { return SIDE === 'LONG' ? sl < entry && entry < tp : tp < entry && entry < sl; }
function exitHits(candle, sl, tp) {
  const hitTp = SIDE === 'LONG' ? candle.high >= tp : candle.low <= tp; const hitSl = SIDE === 'LONG' ? candle.low <= sl : candle.high >= sl;
  return { hitTp, hitSl };
}
async function simulateExit(store, { symbol, entryTs, entry, sl, tp }) {
  const deadlineTs = entryTs + TIME_STOP_MIN * MINUTE_MS;
  let candles = await store.exitCandles1m(symbol, entryTs, deadlineTs); let pathQuality = 'ONE_MINUTE_RESOLVED'; let interval = MINUTE_MS;
  if (!candles.length) { candles = await store.exitCandles15m(symbol, entryTs, deadlineTs); pathQuality = 'FIFTEEN_MINUTE_PROXY'; interval = FIFTEEN_MS; }
  let maxFav = 0, maxAdv = 0;
  for (const candle of candles.sort((a, b) => a.ts - b.ts)) {
    const { hitTp, hitSl } = exitHits(candle, sl, tp);
    const fav = SIDE === 'LONG' ? candle.high - entry : entry - candle.low; const adv = SIDE === 'LONG' ? entry - candle.low : candle.high - entry;
    maxFav = Math.max(maxFav, fav); maxAdv = Math.max(maxAdv, adv);
    if (hitTp && hitSl) return { exitTs: candle.ts + interval, exitPrice: sl, exitReason: 'SL', exitTrigger: 'AMBIGUOUS_TP_AND_SL_SAME_CANDLE_WORST_CASE', exitPathQuality: `AMBIGUOUS_CONSERVATIVE_${pathQuality}`, maxFavorableMove: maxFav, maxAdverseMove: maxAdv };
    if (hitSl) return { exitTs: candle.ts + interval, exitPrice: sl, exitReason: 'SL', exitTrigger: 'STOP_TRIGGER_BOUNDARY', exitPathQuality: pathQuality, maxFavorableMove: maxFav, maxAdverseMove: maxAdv };
    if (hitTp) return { exitTs: candle.ts + interval, exitPrice: tp, exitReason: 'TP', exitTrigger: 'TARGET_TRIGGER_BOUNDARY', exitPathQuality: pathQuality, maxFavorableMove: maxFav, maxAdverseMove: maxAdv };
  }
  const last = candles.filter((c) => c.ts + interval <= deadlineTs).at(-1) || candles.at(-1);
  return { exitTs: Math.min(deadlineTs, last ? last.ts + interval : deadlineTs), exitPrice: last?.close || entry, exitReason: 'TIME_STOP', exitTrigger: 'TIME_STOP_720M', exitPathQuality: last ? pathQuality : 'NO_FORWARD_CANDLES_FLAT', maxFavorableMove: maxFav, maxAdverseMove: maxAdv };
}
function replayQuality({ obQuality, exitPathQuality, fundingQuality }) {
  let score = 1;
  if (obQuality !== 'EXACT_DEPTH_SNAPSHOT') score -= 0.18;
  if (String(exitPathQuality).startsWith('FIFTEEN')) score -= 0.15;
  if (String(exitPathQuality).startsWith('AMBIGUOUS')) score -= 0.08;
  if (fundingQuality !== 'BITGET_HISTORICAL') score -= 0.04;
  score -= 0.05; // current contract catalogue cannot recover every delisted historical contract.
  return clamp(score, 0, 1);
}
function canonicalOutcomeId({ symbol, entryTs, familyId }) { return `HIST_${SIDE}_${sha(`${symbol}|${entryTs}|${familyId}|${HISTORICAL_REPLAY_VERSION}`).slice(0, 24)}`; }

export async function replayShard({ startTs, endTs, outDir, shardId = 'shard', maxContracts = 0 } = {}) {
  const startedWall = now(); const start = ceilTo(startTs, FIFTEEN_MS), end = floorTo(endTs, FIFTEEN_MS);
  const store = new HistoricalStore({ startTs: start, endTs: end, maxContracts }); const preparation = await store.prepare();
  const outcomes = []; const openUntil = new Map(); const counters = { timestamps: 0, scannerCandidates: 0, riskRows: 0, exact75: 0, outcomes: 0, skippedAlreadyOpen: 0, invalidFamily: 0, invalidGeometry: 0 };
  for (let ts = start; ts < end; ts += FIFTEEN_MS) {
    counters.timestamps += 1; store.setAsOf(ts); const rawTickers = store.tickerRows(ts); if (!rawTickers.length) continue;
    const snapshot = await runScanner({ historicalMode: true, persist: false, asOfTs: ts, startedAt: ts, snapshotIdOverride: `hist_${SIDE.toLowerCase()}_${ts}`, rawTickers, fetchCandles: store.getCandles.bind(store), source: 'HISTORICAL_POINT_IN_TIME_REPLAY' });
    const weather = weatherContext(snapshot.historicalMarketWeather || {}); const temporalEntry = entryTemporalContext(ts); const btcRouterState = normalizedBtcState(snapshot.btcState);
    const candidates = Array.isArray(snapshot.candidates) ? snapshot.candidates : []; counters.scannerCandidates += candidates.length;
    for (const candidate of candidates) {
      const symbol = normalizeSymbol(candidate.contractSymbol || candidate.symbol); if (!symbol) continue;
      if (finite(openUntil.get(symbol), 0) > ts) { counters.skippedAlreadyOpen += 1; continue; }
      const candles15m = await store.getCandles(symbol, '15m', 120); const candles1h = await store.getCandles(symbol, '1h', 120); if (candles15m.length < 30 || candles1h.length < 20) continue;
      const ob = store.orderBookAsOf(symbol, ts); const funding = await store.fundingAsOf(symbol, ts);
      const riskRows = buildRiskAndLiveMetricsForBothSides({ candidate, ob, funding, candles15m, candles1h, btcState: snapshot.btcState, regime: snapshot.regime });
      if (!Array.isArray(riskRows) || !riskRows.length) continue; counters.riskRows += 1;
      const metrics = riskRows[0];
      const attached = attachMicroFamilies({ ...metrics, ...weather, entryBtcRouterState: btcRouterState, btcState: snapshot.btcState, entryTs: ts, createdAt: ts, scannerRunId: snapshot.snapshotId, snapshotId: snapshot.snapshotId, marketEventClusterId: `${SIDE}_EVENT_HIST_${ts}` });
      const familyId = familyIdOf(attached); if (!familyId) { counters.invalidFamily += 1; continue; } counters.exact75 += 1;
      const entry = finite(attached.entry ?? metrics.entry, 0), sl = finite(attached.initialSl ?? attached.sl ?? metrics.sl, 0), tp = finite(attached.tp ?? metrics.tp, 0);
      if (!(entry > 0 && sl > 0 && tp > 0 && validGeometry({ entry, sl, tp }))) { counters.invalidGeometry += 1; continue; }
      const exit = await simulateExit(store, { symbol, entryTs: ts, entry, sl, tp }); const exitOb = store.orderBookAsOf(symbol, exit.exitTs);
      const costs = applyCostsFromPrices({ entry, exitPrice: exit.exitPrice, currentPrice: exit.exitPrice, sl, initialSl: sl, tp, side: SIDE, tradeSide: SIDE, source: 'SHADOW', entrySpreadPct: finite(ob.spreadPct, 0), exitSpreadPct: finite(exitOb.spreadPct, finite(ob.spreadPct, 0)), finalized: true, status: 'CLOSED' });
      const qualityScore = replayQuality({ obQuality: ob.historicalOrderBookQuality, exitPathQuality: exit.exitPathQuality, fundingQuality: funding.quality });
      const outcomeId = canonicalOutcomeId({ symbol, entryTs: ts, familyId });
      const outcome = {
        historicalReplay: true, historicalReplayVersion: HISTORICAL_REPLAY_VERSION, historicalEvidenceVersion: HISTORICAL_EVIDENCE_VERSION,
        replayQualityScore: qualityScore, historicalOrderBookQuality: ob.historicalOrderBookQuality, fundingHistoryQuality: funding.quality, exitPathQuality: exit.exitPathQuality,
        universeQuality: 'CURRENT_CONTRACT_CATALOG_WITH_LAUNCH_OFF_FILTER', pointInTimeNoLookAhead: true, triggerBoundaryFillApplied: ['TP','SL'].includes(exit.exitReason), conservativeAmbiguousFill: String(exit.exitPathQuality).startsWith('AMBIGUOUS'),
        side: DASHBOARD_SIDE, tradeSide: SIDE, positionSide: SIDE, direction: SIDE, source: 'SHADOW', outcomeSource: 'SHADOW', virtualOnly: true, realTrade: false, realOrder: false,
        status: 'CLOSED', outcomeFinal: true, realized: true,
        canonicalOutcomeId: outcomeId, canonicalPositionId: outcomeId, positionId: outcomeId, outcomeId,
        symbol: baseSymbol(symbol), baseSymbol: baseSymbol(symbol), contractSymbol: symbol,
        microFamilyId: familyId, trueMicroFamilyId: familyId, childTrueMicroFamilyId: familyId,
        parentTrueMicroFamilyId: attached.parentTrueMicroFamilyId || null, setupType: attached.setupType || null, regimeBucket: attached.regimeBucket || null, confirmationProfile: attached.confirmationProfile || null,
        trueMicroFamilySchema: TEMPORAL_TAXONOMY_VERSION, childTrueMicroFamilySchema: TEMPORAL_TAXONOMY_VERSION, taxonomyVersion: TEMPORAL_TAXONOMY_VERSION,
        measurementFixVersion: MEASUREMENT_FIX_VERSION, outcomeMeasurementVersion: MEASUREMENT_FIX_VERSION, acceptedOutcomeMeasurementVersion: MEASUREMENT_FIX_VERSION,
        costModelVersion: TEMPORAL_COST_MODEL_VERSION, exitFillModelVersion: TEMPORAL_COST_MODEL_VERSION, exitFillSource: ['TP','SL'].includes(exit.exitReason) ? 'TRIGGER_BOUNDARY' : 'TIME_STOP_MARK',
        temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
        entryTs: ts, createdAt: ts, exitTs: exit.exitTs, closedAt: exit.exitTs, completedAt: exit.exitTs, outcomeFinalizedTs: exit.exitTs, outcomePersistedTs: exit.exitTs,
        marketEventClusterId: `${SIDE}_EVENT_HIST_${ts}`, scannerRunId: snapshot.snapshotId, snapshotId: snapshot.snapshotId,
        ...temporalEntry, ...weather, entryBtcRouterState: btcRouterState, entryBtcDirection: ['BULLISH','STRONG_BULLISH'].includes(btcRouterState) ? 'LONG' : ['BEARISH','STRONG_BEARISH'].includes(btcRouterState) ? 'SHORT' : btcRouterState,
        entry, initialSl: sl, sl, tp, exitPrice: exit.exitPrice, exitReason: exit.exitReason, exitTrigger: exit.exitTrigger,
        grossR: finite(costs.grossR, 0), rawR: finite(costs.grossR, 0), costR: Math.max(0, finite(costs.costR, 0)), netR: finite(costs.netR ?? costs.realizedR, 0), realizedR: finite(costs.netR ?? costs.realizedR, 0),
        grossPnlPct: finite(costs.grossPnlPct, 0), netPnlPct: finite(costs.netPnlPct, 0), win: finite(costs.netR ?? costs.realizedR, 0) > 0, loss: finite(costs.netR ?? costs.realizedR, 0) < 0,
        directSL: exit.exitReason === 'SL', directToSL: exit.exitReason === 'SL', entrySpreadPct: finite(ob.spreadPct, 0), exitSpreadPct: finite(exitOb.spreadPct, 0),
        maxFavorableMove: exit.maxFavorableMove, maxAdverseMove: exit.maxAdverseMove,
        historicalStrictDiscordEligible: false, liveForwardConfirmationRequired: true
      };
      outcomes.push(outcome); openUntil.set(symbol, exit.exitTs); counters.outcomes += 1;
    }
    if (counters.timestamps % 96 === 0) console.log('HISTORICAL_REPLAY_PROGRESS', JSON.stringify({ side: SIDE, shardId, ts, iso: iso(ts), outcomes: outcomes.length }));
  }
  const dir = mkdir(outDir || '.historical-shard'); const outcomeFile = path.join(dir, `${shardId}.outcomes.jsonl`); const manifestFile = path.join(dir, `${shardId}.manifest.json`);
  jsonlWrite(outcomeFile, outcomes); jsonWrite(manifestFile, { ok: true, side: SIDE, shardId, historicalReplayVersion: HISTORICAL_REPLAY_VERSION, startTs: start, endTs: end, startIso: iso(start), endIso: iso(end), preparation, counters, outcomeCount: outcomes.length, durationMs: now() - startedWall, generatedAt: now() });
  return { outcomeFile, manifestFile, outcomeCount: outcomes.length, counters };
}

function mean(values) { return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0; }
function std(values) { if (values.length < 2) return 0; const m = mean(values); return Math.sqrt(values.reduce((s, v) => s + ((v - m) ** 2), 0) / (values.length - 1)); }
function erf(x) { const sign = x < 0 ? -1 : 1; const a = Math.abs(x); const t = 1 / (1 + 0.3275911 * a); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a); return sign * y; }
function normalCdf(x) { return 0.5 * (1 + erf(x / Math.sqrt(2))); }
function maxDrawdownR(values = []) {
  let equity = 0, peak = 0, maxDd = 0;
  for (const value of values) { equity += finite(value, 0); peak = Math.max(peak, equity); maxDd = Math.max(maxDd, peak - equity); }
  return maxDd;
}
function maxLosingStreak(values = []) {
  let streak = 0, maxStreak = 0;
  for (const value of values) { if (finite(value, 0) < 0) { streak += 1; maxStreak = Math.max(maxStreak, streak); } else streak = 0; }
  return maxStreak;
}
function metrics(rows = []) {
  const chronological = [...rows].sort((a, b) => finite(a.entryTs, 0) - finite(b.entryTs, 0));
  const values = chronological.map((r) => finite(r.netR, NaN)).filter(Number.isFinite);
  const n = values.length;
  const totalR = values.reduce((s, v) => s + v, 0);
  const avgR = n ? totalR / n : 0;
  const wins = values.filter((v) => v > 0).length;
  const losses = values.filter((v) => v < 0).length;
  const flats = n - wins - losses;
  const grossWinR = values.filter((v) => v > 0).reduce((s, v) => s + v, 0);
  const grossLossR = values.filter((v) => v < 0).reduce((s, v) => s + Math.abs(v), 0);
  const sd = std(values);
  const se = n > 1 ? sd / Math.sqrt(n) : Infinity;
  const priorStrength = 20;
  const priorMean = 0;
  const shrunkAvgR = n ? ((avgR * n) + (priorMean * priorStrength)) / (n + priorStrength) : 0;
  const shrunkSe = Number.isFinite(se) ? se * Math.sqrt(n / Math.max(1, n + priorStrength)) : Infinity;
  const lcb95 = Number.isFinite(shrunkSe) ? shrunkAvgR - 1.96 * shrunkSe : -Infinity;
  const ucb95 = Number.isFinite(shrunkSe) ? shrunkAvgR + 1.96 * shrunkSe : Infinity;
  const z = n > 1 && se > 0 ? avgR / se : avgR > 0 ? 9 : -9;
  const pValue = n > 1 ? clamp(1 - normalCdf(z), 0, 1) : 1;
  return {
    completed: n, wins, losses, flats,
    winrate: n ? wins / n : 0,
    totalR, avgR, rawAvgR: avgR, shrunkAvgR,
    standardDeviation: sd,
    standardError: Number.isFinite(se) ? se : null,
    lcb95: Number.isFinite(lcb95) ? lcb95 : 0,
    ucb95: Number.isFinite(ucb95) ? ucb95 : 0,
    profitFactor: grossLossR > 0 ? grossWinR / grossLossR : grossWinR > 0 ? 999 : 0,
    grossWinR, grossLossR,
    avgCostR: n ? mean(chronological.map((r) => finite(r.costR, 0))) : 0,
    directSLPct: n ? chronological.filter((r) => r.directSL === true).length / n : 0,
    avgReplayQuality: n ? mean(chronological.map((r) => finite(r.replayQualityScore, 0))) : 0,
    oneMinutePathPct: n ? chronological.filter((r) => String(r.exitPathQuality || '').includes('ONE_MINUTE')).length / n : 0,
    exactDepthPct: n ? chronological.filter((r) => r.historicalOrderBookQuality === 'EXACT_DEPTH_SNAPSHOT').length / n : 0,
    maxDrawdownR: maxDrawdownR(values),
    maxLosingStreak: maxLosingStreak(values),
    pValue
  };
}
function bh(rows = []) {
  const sorted = rows.map((r, i) => ({ ...r, __i: i })).sort((a, b) => finite(a.pValue, 1) - finite(b.pValue, 1));
  let next = 1;
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const q = Math.min(1, finite(sorted[i].pValue, 1) * sorted.length / (i + 1));
    next = Math.min(next, q);
    sorted[i].qValue = next;
  }
  return sorted.sort((a, b) => a.__i - b.__i).map(({ __i, ...r }) => r);
}
function recencyWeighted(rows = [], rangeEnd = now(), halfLifeDays = 90) {
  if (!rows.length) return { completed: 0, weightedAvgR: 0, effectiveN: 0 };
  const lambda = Math.log(2) / Math.max(1, halfLifeDays * DAY_MS);
  let numerator = 0, denominator = 0, weightSq = 0;
  for (const row of rows) {
    const age = Math.max(0, rangeEnd - finite(row.entryTs, rangeEnd));
    const weight = Math.exp(-lambda * age);
    numerator += weight * finite(row.netR, 0);
    denominator += weight;
    weightSq += weight * weight;
  }
  return {
    completed: rows.length,
    weightedAvgR: denominator > 0 ? numerator / denominator : 0,
    effectiveN: weightSq > 0 ? (denominator * denominator) / weightSq : 0,
    halfLifeDays
  };
}
function rollingWalkForward(rows = [], rangeStart, rangeEnd) {
  const INITIAL_TRAIN_DAYS = 84;
  const TEST_DAYS = 28;
  const step = TEST_DAYS * DAY_MS;
  const windows = [];
  for (let cutoff = rangeStart + INITIAL_TRAIN_DAYS * DAY_MS; cutoff + 14 * DAY_MS <= rangeEnd; cutoff += step) {
    const trainRows = rows.filter((r) => finite(r.entryTs, 0) < cutoff);
    const testEnd = Math.min(rangeEnd, cutoff + step);
    const testRows = rows.filter((r) => finite(r.entryTs, 0) >= cutoff && finite(r.entryTs, 0) < testEnd);
    const train = metrics(trainRows);
    const test = metrics(testRows);
    const selectedAtCutoff =
      train.completed >= 25 &&
      train.shrunkAvgR > 0.015 &&
      train.lcb95 > -0.12 &&
      train.profitFactor >= 1.0;
    const evaluable = selectedAtCutoff && test.completed >= 5;
    windows.push({
      cutoffTs: cutoff,
      testEndTs: testEnd,
      selectedAtCutoff,
      evaluable,
      trainCompleted: train.completed,
      trainShrunkAvgR: train.shrunkAvgR,
      trainLcb95: train.lcb95,
      testCompleted: test.completed,
      testAvgR: test.avgR,
      testTotalR: test.totalR,
      testWinrate: test.winrate,
      positive: evaluable && test.avgR > 0
    });
  }
  const evaluated = windows.filter((w) => w.evaluable);
  const positive = evaluated.filter((w) => w.positive);
  const totalTestOutcomes = evaluated.reduce((sum, w) => sum + w.testCompleted, 0);
  const totalTestR = evaluated.reduce((sum, w) => sum + w.testTotalR, 0);
  return {
    initialTrainDays: INITIAL_TRAIN_DAYS,
    testDays: TEST_DAYS,
    windowsPlanned: windows.length,
    evaluatedWindows: evaluated.length,
    positiveWindows: positive.length,
    positiveWindowRatio: evaluated.length ? positive.length / evaluated.length : 0,
    walkForwardTestOutcomes: totalTestOutcomes,
    walkForwardTestAvgR: totalTestOutcomes > 0 ? totalTestR / totalTestOutcomes : 0,
    windows
  };
}
function pearson(a, b) { if (a.length !== b.length || a.length < 3) return 0; const ma = mean(a), mb = mean(b); let num = 0, da = 0, db = 0; for (let i = 0; i < a.length; i += 1) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; } return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0; }
function correlationClusters(familyRows, outcomes) {
  const passed = familyRows.filter((r) => r.selectionEligible === true);
  const parent = new Map(passed.map((r) => [r.familyId, r.familyId]));
  const find = (x) => { let p = parent.get(x); while (p && p !== parent.get(p)) p = parent.get(p); return p || x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra); };
  const daily = new Map();
  for (const row of outcomes) {
    const f = familyIdOf(row); if (!parent.has(f)) continue;
    const key = dateKey(row.entryTs); if (!daily.has(f)) daily.set(f, new Map());
    const m = daily.get(f); m.set(key, finite(m.get(key), 0) + finite(row.netR, 0));
  }
  const maxPeer = new Map();
  for (let i = 0; i < passed.length; i += 1) for (let j = i + 1; j < passed.length; j += 1) {
    const a = passed[i].familyId, b = passed[j].familyId, ma = daily.get(a) || new Map(), mb = daily.get(b) || new Map();
    const keys = [...ma.keys()].filter((k) => mb.has(k)); if (keys.length < 10) continue;
    const corr = pearson(keys.map((k) => ma.get(k)), keys.map((k) => mb.get(k)));
    maxPeer.set(a, Math.max(finite(maxPeer.get(a), 0), Math.abs(corr)));
    maxPeer.set(b, Math.max(finite(maxPeer.get(b), 0), Math.abs(corr)));
    if (corr >= 0.75) union(a, b);
  }
  const clusterNames = new Map(); let count = 0; const result = new Map();
  for (const row of passed) {
    const root = find(row.familyId);
    if (!clusterNames.has(root)) clusterNames.set(root, `CORR_${SIDE}_${String(++count).padStart(2, '0')}`);
    result.set(row.familyId, { cluster: clusterNames.get(root), maxPeerCorrelation: finite(maxPeer.get(row.familyId), 0) });
  }
  return result;
}
async function loadPublishedOutcomes() {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return [];
  const redis = getDurableRedis(); const out = [];
  await mapLimit(ALL_FAMILY_IDS, 8, async (familyId) => {
    const rows = await getJson(redis, `${PREFIX}HISTORICAL:OUTCOMES:V1:${familyId}`, []).catch(() => []);
    if (Array.isArray(rows)) out.push(...rows);
  });
  return out;
}
function collectFiles(dir, suffix, out = []) {
  if (!dir || !fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(p, suffix, out);
    else if (entry.name.endsWith(suffix)) out.push(p);
  }
  return out;
}
function removeCrossShardOverlaps(rows = []) {
  const sorted = [...rows].sort((a, b) => finite(a.entryTs, 0) - finite(b.entryTs, 0) || String(a.canonicalOutcomeId || '').localeCompare(String(b.canonicalOutcomeId || '')));
  const blockedUntil = new Map(); const kept = []; let dropped = 0;
  for (const row of sorted) {
    const symbol = normalizeSymbol(row.contractSymbol || row.symbol);
    const entryTs = finite(row.entryTs, 0);
    const closedAt = Math.max(entryTs, finite(row.closedAt ?? row.exitTs ?? row.completedAt, entryTs));
    if (symbol && entryTs < finite(blockedUntil.get(symbol), 0)) { dropped += 1; continue; }
    kept.push(row); if (symbol) blockedUntil.set(symbol, closedAt);
  }
  return { rows: kept, dropped };
}
function compactHistoricalOutcome(row = {}) {
  return {
    historicalReplay: true,
    historicalReplayVersion: row.historicalReplayVersion,
    historicalEvidenceVersion: HISTORICAL_EVIDENCE_VERSION,
    replayQualityScore: finite(row.replayQualityScore, 0),
    historicalOrderBookQuality: row.historicalOrderBookQuality || 'UNKNOWN',
    fundingHistoryQuality: row.fundingHistoryQuality || 'UNKNOWN',
    exitPathQuality: row.exitPathQuality || 'UNKNOWN',
    universeQuality: row.universeQuality || 'UNKNOWN',
    pointInTimeNoLookAhead: row.pointInTimeNoLookAhead === true,
    side: DASHBOARD_SIDE, tradeSide: SIDE, positionSide: SIDE, direction: SIDE,
    source: 'SHADOW', outcomeSource: 'SHADOW', status: 'CLOSED', outcomeFinal: true, realized: true,
    canonicalOutcomeId: row.canonicalOutcomeId,
    canonicalPositionId: row.canonicalPositionId || row.canonicalOutcomeId,
    symbol: row.symbol, baseSymbol: row.baseSymbol, contractSymbol: row.contractSymbol,
    microFamilyId: row.microFamilyId, trueMicroFamilyId: row.trueMicroFamilyId, childTrueMicroFamilyId: row.childTrueMicroFamilyId,
    parentTrueMicroFamilyId: row.parentTrueMicroFamilyId || null,
    setupType: row.setupType || null, regimeBucket: row.regimeBucket || null, confirmationProfile: row.confirmationProfile || null,
    measurementFixVersion: row.measurementFixVersion || MEASUREMENT_FIX_VERSION,
    outcomeMeasurementVersion: row.outcomeMeasurementVersion || MEASUREMENT_FIX_VERSION,
    acceptedOutcomeMeasurementVersion: row.acceptedOutcomeMeasurementVersion || MEASUREMENT_FIX_VERSION,
    costModelVersion: row.costModelVersion || TEMPORAL_COST_MODEL_VERSION,
    taxonomyVersion: row.taxonomyVersion || TEMPORAL_TAXONOMY_VERSION,
    temporalContextVersion: row.temporalContextVersion || TEMPORAL_CONTEXT_VERSION,
    entryTs: finite(row.entryTs, 0), exitTs: finite(row.exitTs, 0), closedAt: finite(row.closedAt, 0), completedAt: finite(row.completedAt, 0),
    outcomeFinalizedTs: finite(row.outcomeFinalizedTs, 0), outcomePersistedTs: finite(row.outcomePersistedTs, 0),
    entryHourUtc: row.entryHourUtc, entryHourBucket: row.entryHourBucket,
    entryDayOfWeekUtc: row.entryDayOfWeekUtc, entryDayType: row.entryDayType, entryIsWeekend: row.entryIsWeekend,
    entrySessionTags: row.entrySessionTags, entrySessionBucket: row.entrySessionBucket, entrySessionOverlap: row.entrySessionOverlap, entryOffHours: row.entryOffHours,
    entryDateUtc: row.entryDateUtc, entryIsoWeekUtc: row.entryIsoWeekUtc,
    entryMarketWeatherKey: row.entryMarketWeatherKey, entryMarketWeatherRegime: row.entryMarketWeatherRegime, entryMarketWeatherTrendSide: row.entryMarketWeatherTrendSide,
    entryBtcRouterState: row.entryBtcRouterState, entryBtcDirection: row.entryBtcDirection,
    marketEventClusterId: row.marketEventClusterId,
    netR: finite(row.netR, 0), realizedR: finite(row.realizedR ?? row.netR, 0), costR: Math.max(0, finite(row.costR, 0)), netPnlPct: finite(row.netPnlPct, 0),
    directSL: row.directSL === true, directToSL: row.directToSL === true, exitReason: row.exitReason || null,
    historicalStrictDiscordEligible: false, liveForwardConfirmationRequired: true
  };
}

export async function buildEvidence({ inputDir, outDir, includePublished = true } = {}) {
  const manifestFiles = collectFiles(inputDir, '.manifest.json');
  const outcomeFiles = collectFiles(inputDir, '.outcomes.jsonl');
  const manifests = manifestFiles.map((f) => jsonRead(f, {}));
  let incoming = outcomeFiles.flatMap(jsonlRead);
  if (includePublished) incoming.push(...await loadPublishedOutcomes());

  const dedupe = new Map();
  for (const row of incoming) {
    const id = String(row.canonicalOutcomeId || '').trim();
    if (!id || row.historicalReplay !== true || upper(row.tradeSide) !== SIDE) continue;
    if (finite(row.replayQualityScore, 0) < 0.62) continue;
    if (!familyIdOf(row)) continue;
    const previous = dedupe.get(id);
    if (!previous || finite(row.replayQualityScore, 0) >= finite(previous.replayQualityScore, 0)) dedupe.set(id, row);
  }

  const historyCutoff = now() - MAX_HISTORY_DAYS * DAY_MS;
  let accepted = [...dedupe.values()]
    .filter((row) => finite(row.entryTs, 0) >= historyCutoff)
    .sort((a, b) => finite(a.entryTs, 0) - finite(b.entryTs, 0));
  const overlapResolution = removeCrossShardOverlaps(accepted);
  accepted = overlapResolution.rows;

  const manifestStarts = manifests.map((m) => finite(m.startTs, NaN)).filter(Number.isFinite);
  const manifestEnds = manifests.map((m) => finite(m.endTs, NaN)).filter(Number.isFinite);
  const outcomeStarts = accepted.map((r) => finite(r.entryTs, NaN)).filter(Number.isFinite);
  const defaultEnd = floorTo(now(), DAY_MS);
  const rangeStart = Math.min(...manifestStarts, ...outcomeStarts, defaultEnd - Math.min(MAX_HISTORY_DAYS, 180) * DAY_MS);
  const rangeEnd = Math.max(...manifestEnds, ...outcomeStarts, defaultEnd);
  const safeRangeStart = Number.isFinite(rangeStart) ? rangeStart : defaultEnd - 180 * DAY_MS;
  const safeRangeEnd = Number.isFinite(rangeEnd) && rangeEnd > safeRangeStart ? rangeEnd : defaultEnd;
  const span = Math.max(DAY_MS, safeRangeEnd - safeRangeStart);
  const trainEnd = safeRangeStart + span * 0.60;
  const validationEnd = safeRangeStart + span * 0.80;

  const preliminary = [];
  for (const familyId of ALL_FAMILY_IDS) {
    const rows = accepted.filter((r) => familyIdOf(r) === familyId);
    const trainRows = rows.filter((r) => finite(r.entryTs, 0) < trainEnd);
    const validationRows = rows.filter((r) => finite(r.entryTs, 0) >= trainEnd && finite(r.entryTs, 0) < validationEnd);
    const oosRows = rows.filter((r) => finite(r.entryTs, 0) >= validationEnd);
    const all = metrics(rows);
    const train = metrics(trainRows);
    const validation = metrics(validationRows);
    const oos = metrics(oosRows);
    const recent30 = metrics(rows.filter((r) => finite(r.entryTs, 0) >= safeRangeEnd - 30 * DAY_MS));
    const recent90 = metrics(rows.filter((r) => finite(r.entryTs, 0) >= safeRangeEnd - 90 * DAY_MS));
    const recency = recencyWeighted(rows, safeRangeEnd, 90);
    const walkForward = rollingWalkForward(rows, safeRangeStart, safeRangeEnd);
    preliminary.push({ familyId, train, validation, oos, all, recent30, recent90, recency, walkForward, pValue: oos.pValue });
  }

  const adjusted = bh(preliminary);
  const familyRows = adjusted.map((row) => {
    const trainPass =
      row.train.completed >= 30 &&
      row.train.shrunkAvgR > 0.02 &&
      row.train.lcb95 > -0.10 &&
      row.train.profitFactor >= 1.03;
    const validationPass =
      row.validation.completed >= 10 &&
      row.validation.avgR > 0 &&
      row.validation.shrunkAvgR > 0.005 &&
      row.validation.profitFactor >= 1.00;
    const oosPass =
      row.oos.completed >= 10 &&
      row.oos.avgR > 0 &&
      row.oos.shrunkAvgR > 0.01 &&
      row.oos.lcb95 > -0.10 &&
      row.oos.profitFactor >= 1.02 &&
      row.qValue <= 0.05;
    const stabilityPass =
      row.walkForward.evaluatedWindows >= 2 &&
      row.walkForward.positiveWindowRatio >= 0.60 &&
      row.walkForward.walkForwardTestAvgR > 0;
    const qualityPass =
      row.all.avgReplayQuality >= 0.68 &&
      row.all.oneMinutePathPct >= 0.70;
    const recencyPass =
      row.recency.weightedAvgR > 0 &&
      (row.recent90.completed < 8 || row.recent90.avgR > -0.02) &&
      (row.recent30.completed < 5 || row.recent30.avgR > -0.10);
    const driftStatus = !recencyPass
      ? 'DEGRADING'
      : row.recent30.completed >= 5 && row.recent30.avgR < row.all.avgR * 0.35
        ? 'WATCH'
        : 'STABLE';
    const historicalStatus =
      trainPass && validationPass && oosPass && stabilityPass && qualityPass && recencyPass
        ? 'OOS_PASSED'
        : trainPass && validationPass && qualityPass
          ? (recencyPass ? 'HISTORICALLY_PROMISING' : 'DEGRADED')
          : 'UNPROVEN';
    const selectionScore = clamp(
      row.oos.shrunkAvgR * 175 +
      row.oos.lcb95 * 135 +
      (row.oos.winrate - 0.5) * 85 +
      Math.log1p(row.oos.completed) * 5 +
      row.walkForward.positiveWindowRatio * 20 +
      row.walkForward.walkForwardTestAvgR * 90 +
      row.recency.weightedAvgR * 100 +
      row.all.avgReplayQuality * 12 -
      row.all.maxDrawdownR * 1.5 -
      Math.max(0, row.all.maxLosingStreak - 5) * 1.5,
      0,
      100
    );
    return {
      ...row,
      trainPass, validationPass, oosPass, stabilityPass, qualityPass, recencyPass,
      driftStatus,
      historicalStatus,
      selectionScore,
      selectionEligible: historicalStatus === 'OOS_PASSED',
      strictDiscordEligible: false,
      liveForwardConfirmationRequired: true
    };
  });

  const corr = correlationClusters(familyRows, accepted);
  for (const row of familyRows) {
    const c = corr.get(row.familyId) || {};
    row.historicalCorrelationCluster = c.cluster || null;
    row.maxPeerCorrelation = finite(c.maxPeerCorrelation, 0);
    row.selectionRow = {
      familyId: row.familyId,
      trueMicroFamilyId: row.familyId,
      childTrueMicroFamilyId: row.familyId,
      microFamilyId: row.familyId,
      historicalSelectionGate: row.selectionEligible,
      historicalStatus: row.historicalStatus,
      historicalCompleted: row.all.completed,
      historicalOosCompleted: row.oos.completed,
      historicalWalkForwardEvaluatedWindows: row.walkForward.evaluatedWindows,
      historicalWalkForwardPositiveRatio: row.walkForward.positiveWindowRatio,
      historicalRecencyWeightedAvgR: row.recency.weightedAvgR,
      historicalDriftStatus: row.driftStatus,
      historicalSelectionScore: row.selectionScore,
      completedCurrentMeasurement: row.all.completed,
      completed: row.all.completed,
      wins: row.all.wins,
      losses: row.all.losses,
      flats: row.all.flats,
      avgR: row.all.shrunkAvgR,
      avgNetR: row.all.shrunkAvgR,
      totalR: row.all.totalR,
      fairWinrate: row.all.winrate,
      winrate: row.all.winrate,
      profitFactor: row.all.profitFactor,
      directSLPct: row.all.directSLPct,
      avgCostR: row.all.avgCostR,
      avgRLowerBound: row.oos.lcb95,
      lcb95: row.oos.lcb95,
      historicalCorrelationCluster: row.historicalCorrelationCluster,
      maxPeerCorrelation: row.maxPeerCorrelation,
      measurementFixVersion: MEASUREMENT_FIX_VERSION,
      trueMicroFamilySchema: TEMPORAL_TAXONOMY_VERSION,
      strictDiscordEligible: false,
      liveForwardConfirmationRequired: true
    };
  }

  const evidence = {
    ok: true,
    side: SIDE,
    historicalReplayVersion: HISTORICAL_REPLAY_VERSION,
    historicalEvidenceVersion: HISTORICAL_EVIDENCE_VERSION,
    historicalSelectionVersion: HISTORICAL_SELECTION_VERSION,
    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    costModelVersion: TEMPORAL_COST_MODEL_VERSION,
    taxonomyVersion: TEMPORAL_TAXONOMY_VERSION,
    temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
    generatedAt: now(),
    rangeStartTs: safeRangeStart,
    rangeEndTs: safeRangeEnd,
    trainEndTs: trainEnd,
    validationEndTs: validationEnd,
    splitPolicy: 'CHRONOLOGICAL_60_20_20_PLUS_ROLLING_WALK_FORWARD',
    fdrPolicy: 'BENJAMINI_HOCHBERG_ONE_SIDED_OOS_Q_LE_0_05',
    shrinkagePolicy: 'EMPIRICAL_BAYES_ZERO_MEAN_PRIOR_STRENGTH_20',
    recencyPolicy: 'EXPONENTIAL_HALF_LIFE_90D_PLUS_30D_90D_DRIFT_GATES',
    crossShardOverlapPolicy: 'EARLIEST_POSITION_WINS_MAX_ONE_OPEN_PER_SYMBOL',
    crossShardOverlapsDropped: overlapResolution.dropped,
    universeQuality: 'CURRENT_CONTRACT_CATALOG_WITH_LAUNCH_OFF_FILTER_SURVIVORSHIP_PENALTY',
    exactDepthOptional: true,
    totalOutcomes: accepted.length,
    selectionEligibleFamilies: familyRows.filter((r) => r.selectionEligible).map((r) => r.familyId),
    familyRows,
    strictDiscordRequiresLiveForward: true,
    historicalEvidenceNeverDirectlyPublishesDiscord: true,
    historyNeverWritesLiveLearning: true
  };

  const dir = mkdir(outDir || '.historical-evidence');
  jsonWrite(path.join(dir, 'historical-evidence.json'), evidence);
  const byFamily = Object.fromEntries(ALL_FAMILY_IDS.map((id) => [
    id,
    accepted
      .filter((r) => familyIdOf(r) === id)
      .slice(-MAX_OUTCOMES_PER_FAMILY)
      .map(compactHistoricalOutcome)
  ]));
  jsonWrite(path.join(dir, 'historical-outcomes-by-family.json'), byFamily);
  jsonWrite(path.join(dir, 'historical-evidence-summary.json'), {
    side: SIDE,
    generatedAt: evidence.generatedAt,
    totalOutcomes: evidence.totalOutcomes,
    crossShardOverlapsDropped: overlapResolution.dropped,
    selectionEligibleFamilies: evidence.selectionEligibleFamilies,
    topFamilies: familyRows
      .filter((r) => r.selectionEligible)
      .sort((a, b) => b.selectionScore - a.selectionScore)
      .slice(0, 20)
      .map((r) => ({
        familyId: r.familyId,
        score: r.selectionScore,
        oos: r.oos,
        walkForward: r.walkForward,
        recent30: r.recent30,
        recent90: r.recent90,
        recency: r.recency,
        driftStatus: r.driftStatus,
        correlationCluster: r.historicalCorrelationCluster
      }))
  });
  return evidence;
}

export async function publishEvidence({ evidenceFile, outcomesFile } = {}) {
  const evidence=jsonRead(evidenceFile,null), byFamily=jsonRead(outcomesFile,{}); if(!evidence||evidence.side!==SIDE||evidence.historicalEvidenceVersion!==HISTORICAL_EVIDENCE_VERSION) throw new Error('HISTORICAL_EVIDENCE_FILE_INVALID');
  if(!process.env.UPSTASH_REDIS_REST_URL||!process.env.UPSTASH_REDIS_REST_TOKEN) throw new Error('UPSTASH_REDIS_REST_URL_TOKEN_REQUIRED');
  const redis=getDurableRedis(); await setJson(redis,`${PREFIX}HISTORICAL:EVIDENCE:V1`,evidence); await mapLimit(ALL_FAMILY_IDS,8,async familyId=>setJson(redis,`${PREFIX}HISTORICAL:OUTCOMES:V1:${familyId}`,Array.isArray(byFamily[familyId])?byFamily[familyId]:[])); const pointer={ok:true,side:SIDE,historicalEvidenceVersion:HISTORICAL_EVIDENCE_VERSION,historicalSelectionVersion:HISTORICAL_SELECTION_VERSION,generatedAt:evidence.generatedAt,publishedAt:now(),totalOutcomes:evidence.totalOutcomes,selectionEligibleFamilies:evidence.selectionEligibleFamilies,strictDiscordRequiresLiveForward:true}; await setJson(redis,`${PREFIX}HISTORICAL:RUN:LATEST`,pointer); return pointer;
}


export async function refreshWeeklyPreview() {
  if(!process.env.UPSTASH_REDIS_REST_URL||!process.env.UPSTASH_REDIS_REST_TOKEN) throw new Error('UPSTASH_REDIS_REST_URL_TOKEN_REQUIRED');
  const { freezeWeeklyRotation } = await import('../analyze/rotationEngine.js');
  const freezeResult = await freezeWeeklyRotation({ cutoffTs: now(), sendReport: false });
  const nextRotation = freezeResult?.rotation || freezeResult || {};
  return {
    ok: true,
    side: SIDE,
    previewOnly: true,
    activeRotationChanged: false,
    rotationId: nextRotation?.rotationId || freezeResult?.rotationId || null,
    temporalGenerationId: nextRotation?.temporalGenerationId || nextRotation?.temporalGeneration?.generationId || null,
    temporalGenerationStatus: nextRotation?.temporalGenerationStatus || nextRotation?.temporalGeneration?.status || null,
    historicalEvidenceApplied: nextRotation?.historicalEvidenceApplied === true,
    strictDiscordRequiresLiveForward: true
  };
}

export function planShards({ days = 180, chunkDays = 30, endTs = null } = {}) {
  const end=floorTo(endTs||Date.UTC(new Date().getUTCFullYear(),new Date().getUTCMonth(),new Date().getUTCDate()),DAY_MS); const start=end-Math.max(7,Number(days))*DAY_MS; const chunk=Math.max(1,Number(chunkDays))*DAY_MS; const shards=[]; let i=0; for(let s=start;s<end;s+=chunk){ const e=Math.min(end,s+chunk); shards.push({id:`s${String(++i).padStart(2,'0')}_${dateKey(s)}_${dateKey(e)}`,startTs:s,endTs:e,startIso:iso(s),endIso:iso(e)}); } return shards;
}

async function cli() {
  const {command,args}=parseArgs();
  if(command==='plan'){ const rows=planShards({days:Number(args.days||180),chunkDays:Number(args.chunk_days||30),endTs:parseTs(args.end,null)}); process.stdout.write(JSON.stringify(rows)); return; }
  if(command==='replay'){ const startTs=parseTs(args.start,NaN),endTs=parseTs(args.end,NaN); if(!Number.isFinite(startTs)||!Number.isFinite(endTs)||endTs<=startTs) throw new Error('VALID_START_END_REQUIRED'); const result=await replayShard({startTs,endTs,outDir:args.out||'.historical-shard',shardId:args.shard||'shard',maxContracts:Number(args.max_contracts||0)}); console.log(JSON.stringify({ok:true,command,side:SIDE,...result})); return; }
  if(command==='evidence'){ const evidence=await buildEvidence({inputDir:args.input||'.historical-shards',outDir:args.out||'.historical-evidence',includePublished:bool(args.include_published,true)}); console.log(JSON.stringify({ok:true,command,side:SIDE,totalOutcomes:evidence.totalOutcomes,selectionEligibleFamilies:evidence.selectionEligibleFamilies})); return; }
  if(command==='publish'){ const result=await publishEvidence({evidenceFile:args.evidence||'.historical-evidence/historical-evidence.json',outcomesFile:args.outcomes||'.historical-evidence/historical-outcomes-by-family.json'}); console.log(JSON.stringify({ok:true,command,side:SIDE,...result})); return; }
  if(command==='refresh-preview'){ const result=await refreshWeeklyPreview(); console.log(JSON.stringify({ok:true,command,side:SIDE,...result})); return; }
  console.log('Commands: plan | replay | evidence | publish | refresh-preview');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) cli().catch((error)=>{ console.error('HISTORICAL_RESEARCH_FATAL', error?.stack || error?.message || String(error)); process.exitCode=1; });
