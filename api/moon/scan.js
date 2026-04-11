import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG } from "../lib/_runtime.js";
import { buildCoinProfile, buildMainExecutionDecision } from "../lib/_trade_engine.js";

export const config = RUNTIME_CONFIG;

const BITGET_OB = "https://api.bitget.com/api/v2/spot/market/orderbook";
const BITGET_SYMBOLS = "https://api.bitget.com/api/v2/spot/public/symbols";
const CG_MARKETS = "https://api.coingecko.com/api/v3/coins/markets";

// =========================
// HARD PERFORMANCE LIMITS
// =========================
const MAX_COINS_FROM_CG = 260;
const MAX_OB_CANDIDATES = 160;
const OB_CONCURRENCY = 10;

// =========================
// UI / DESK HANDOFF
// =========================
const UI_ENTRY_LOCK_MS_MAIN = 8 * 60 * 60 * 1000;
const WATCH_HOLD_MS = 8 * 60 * 1000;

// ======================================================
// MAIN KV KEYS
// ======================================================
function keyMainLatest(mode) {
  return `main:latest:${String(mode || "bull").toLowerCase()}`;
}
function keyMainState(mode) {
  return `main:state:${String(mode || "bull").toLowerCase()}`;
}
function keyScanLock(mode) {
  return `main:scan:lock:${String(mode || "bull").toLowerCase()}`;
}
function keyMainConfigSnapshot(mode) {
  return `main:config:snapshot:${String(mode || "bull").toLowerCase()}`;
}

// ======================================================
// TRADE FUNNEL KV KEYS
// ======================================================
function keyTradeFunnelLatest(mode) {
  return `trade_funnel:latest:${String(mode || "bull").toLowerCase()}`;
}
function keyTradeFunnelQueue(mode) {
  return `trade_funnel:queue:${String(mode || "bull").toLowerCase()}`;
}
function keyTradeFunnelLatestGlobal() {
  return "trade_funnel:latest";
}
function keyTradeFunnelQueueGlobal() {
  return "trade_funnel:queue";
}

// ======================================================
// Helpers
// ======================================================
function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v)? v : d;
}
function up(x) {
  return String(x || "").toUpperCase();
}
function arr(x) {
  return Array.isArray(x)? x :;
}

function pipelineRank(stage) {
  const s = up(stage);
  if (s === "ENTRY_READY") return 5;
  if (s === "SETUP") return 4;
  if (s === "WARMUP") return 3;
  if (s === "RADAR") return 2;
  if (s === "UNIVERSE") return 1;
  return 0;
}

function pipelineToLegacyStage(stage) {
  const s = up(stage);
  if (s === "ENTRY_READY") return "ALMOST";
  if (s === "SETUP") return "BUILDUP";
  if (s === "WARMUP") return "RADAR";
  if (s === "RADAR") return "RADAR";
  return "RADAR";
}

function gateFromPipelineStage(stage) {
  return up(stage) === "ENTRY_READY"? "WATCH" : "IGNORE";
}

function effectiveGate(item) {
  return up(
    item?.deskGate ||
      item?.tradeDeskStatus ||
      item?.engineGate ||
      item?.scannerGate ||
      "IGNORE"
  );
}

function gatePriority(gate) {
  const g = up(gate);
  if (g === "WATCH") return 2;
  return 1;
}

function isForwardableMainCoin(item) {
  const gate = effectiveGate(item);
  const stage = up(item?.stage || item?.pipelineStage);
  if (gate!== "WATCH") return false;
  if (!item?.tradePlan) return false;
  return stage === "ENTRY_READY";
}

function resolveDeskGate({ prevGate, prevMeta, engineGate, now }) {
  const prev = up(prevGate || "IGNORE");
  const engine = up(engineGate || "IGNORE");
  const holdUntil = n(prevMeta?.deskHoldUntil, 0);

  if (engine === "WATCH") return "WATCH";
  if ((prev === "WATCH" || prev === "OPEN") && holdUntil > now) return "WATCH";
  return "IGNORE";
}

function buildDeskMeta({ prevGate, prevMeta, deskGate, engineGate, now }) {
  const prev = up(prevGate || "IGNORE");
  const desk = up(deskGate || "IGNORE");
  const engine = up(engineGate || "IGNORE");
  const meta = prevMeta && typeof prevMeta === "object"? prevMeta : {};

  let holdUntil = 0;

  if (engine === "WATCH") {
    holdUntil = now + WATCH_HOLD_MS;
  } else if ((prev === "WATCH" || prev === "OPEN") && n(meta.deskHoldUntil, 0) > now && desk === "WATCH") {
    holdUntil = n(meta.deskHoldUntil, 0);
  }

  return {
    deskGateSince: prev === desk? n(meta.deskGateSince, now) : now,
    deskHoldUntil: holdUntil,
    openStreak: 0,
    watchStreak: engine === "WATCH"? n(meta.watchStreak, 0) + 1 : 0,
  };
}

function mergeTradeItems(existingItems, incomingItems, limit = 120) {
  const merged = [...arr(incomingItems),...arr(existingItems)];
  const out =;
  const seen = new Set();

  merged.sort((a, b) => {
    const gp = gatePriority(effectiveGate(b)) - gatePriority(effectiveGate(a));
    if (gp!== 0) return gp;

    const stageDiff =
      pipelineRank(b?.stage || b?.pipelineStage) - pipelineRank(a?.stage || a?.pipelineStage);
    if (stageDiff!== 0) return stageDiff;

    const scoreDiff =
      n(b?.execution?.score, n(b?.confidence, 0)) -
      n(a?.execution?.score, n(a?.confidence, 0));
    if (scoreDiff!== 0) return scoreDiff;

    return n(b?.queuedAt || b?.ts || 0) - n(a?.queuedAt || a?.ts || 0);
  });

  for (const item of merged) {
    const sym = up(item?.symbol);
    const mode = String(item?.sourceMode || item?.mode || "").toLowerCase();
    const gate = effectiveGate(item);
    const sourceSystem = String(item?.sourceSystem || "unknown").toLowerCase();

    if (!sym) continue;

    const key = `${sourceSystem}:${mode}:${sym}:${gate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);

    if (out.length >= limit) break;
  }

  return out;
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
     ...options,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": "CryptoCrocScanner/1.0",
       ...(options.headers || {}),
      },
    });

    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }

    return await res.json();
  } finally {
    clearTimeout(id);
  }
}

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let idx = 0;

  async function worker() {
    while (idx < list.length) {
      const i = idx++;
      out[i] = await fn(list[i], i);
    }
  }

  const workers = Array.from({ length: Math.max(1, limit) }, () => worker());
  await Promise.all(workers);
  return out;
}

function requireSecret(req, res) {
  const qToken = String(req.query?.token || "");
  const bearer = String(req.headers?.authorization || "");
  const headerToken = bearer.toLowerCase().startsWith("bearer ")
   ? bearer.slice(7).trim()
    : "";

  const ok =
    (process.env.CRON_SECRET && qToken && qToken === String(process.env.CRON_SECRET)) ||
    (process.env.SCAN_SECRET && qToken && qToken === String(process.env.SCAN_SECRET)) ||
    (process.env.CRON_SECRET &&
      headerToken &&
      headerToken === String(process.env.CRON_SECRET)) ||
    (process.env.SCAN_SECRET &&
      headerToken &&
      headerToken === String(process.env.SCAN_SECRET));

  if (ok) return true;

  res.statusCode = 401;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
  return false;
}

async function acquireScanLock(mode) {
  const key = keyScanLock(mode);
  const now = Date.now();

  const d = new Date(now);
  const next = new Date(d);
  next.setSeconds(0, 0);

  if (d.getMinutes() < 30) next.setMinutes(30);
  else {
    next.setMinutes(0);
    next.setHours(d.getHours() + 1);
  }

  const until = next.getTime();
  const ttlSec = Math.max(60, Math.ceil((until - now) / 1000));

  const ok = await kv.set(key, { ts: now, until, mode }, { nx: true, ex: ttlSec });
  if (ok) return { ok: true, until };

  const cur = await kv.get(key);
  const curUntil = Number(cur?.until || 0);
  if (curUntil > now) return { ok: false, until: curUntil };

  await kv.set(key, { ts: now, until, mode }, { ex: ttlSec });
  return { ok: true, until };
}

async function releaseScanLock(mode) {
  try {
    await kv.del(keyScanLock(mode));
  } catch {}
}

const KV_CG_TOP = "main:cg:top:v3";
const KV_CG_BTC = "main:cg:btc:v3";

function normalizeCgMarketRow(c) {
  const hi = n(c.high_24h, 0);
  const lo = n(c.low_24h, 0);
  const range24 = hi > 0 && lo > 0? ((hi - lo) / lo) * 100 : 0;

  return {
    id: String(c.id || ""),
    symbol: up(c.symbol),
    name: String(c.name || ""),
    image: String(c.image || ""),
    price: n(c.current_price, 0),
    marketCap: n(c.market_cap, 0),
    volume: n(c.total_volume, 0),
    change24: n(
      c.price_change_percentage_24h_in_currency?? c.price_change_percentage_24h,
      0
    ),
    change1h: n(
      c.price_change_percentage_1h_in_currency?? c.price_change_percentage_1h,
      0
    ),
    range24,
  };
}

async function fetchCoinGeckoTopCached(maxCoins = MAX_COINS_FROM_CG) {
  try {
    const url =
      `${CG_MARKETS}?vs_currency=usd&order=market_cap_desc&per_page=${Math.min(maxCoins, 250)}&page=1` +
      `&sparkline=false&price_change_percentage=1h,24h`;

    const rows = await fetchJsonWithTimeout(url, {}, 9000);
    const coins = Array.isArray(rows)? rows.map(normalizeCgMarketRow) :;
    await kv.set(KV_CG_TOP, coins, { ex: 60 * 10 });
    return { coins, meta: { usedCache: false, partial: false, rateLimited: false } };
  } catch (e) {
    const cached = await kv.get(KV_CG_TOP);
    return {
      coins: Array.isArray(cached)? cached.slice(0, maxCoins) :,
      meta: {
        usedCache: true,
        partial: true,
        rateLimited: false,
        error: String(e?.message || e),
      },
    };
  }
}

async function fetchBTCGateFromUniverse() {
  try {
    const url =
      `${CG_MARKETS}?vs_currency=usd&ids=bitcoin&order=market_cap_desc&per_page=1&page=1` +
      `&sparkline=false&price_change_percentage=1h,24h`;

    const arr = await fetchJsonWithTimeout(url, {}, 8000);
    const btc = Array.isArray(arr) && arr.length? arr : null;
    if (!btc) throw new Error("no_btc");

    const price = n(btc.current_price, 0);
    const chg24 = n(
      btc.price_change_percentage_24h_in_currency?? btc.price_change_percentage_24h,
      0
    );
    const chg1h = n(
      btc.price_change_percentage_1h_in_currency?? btc.price_change_percentage_1h,
      0
    );
    const hi = n(btc.high_24h, 0);
    const lo = n(btc.low_24h, 0);
    const range24 = hi > 0 && lo > 0? ((hi - lo) / lo) * 100 : 0;

    const out = { price, chg24, chg1h, range24, state: "NEUTRAL" };
    await kv.set(KV_CG_BTC, out, { ex: 60 * 5 });
    return out;
  } catch (e) {
    const cached = await kv.get(KV_CG_BTC);
    if (cached && typeof cached === "object") return cached;
    return { price: 0, chg24: 0, chg1h: 0, range24: 0, state: "NEUTRAL" };
  }
}

async function getBitgetSpotUsdtSymbols() {
  try {
    const j = await fetchJsonWithTimeout(BITGET_SYMBOLS, {}, 8000);
    if (String(j?.code || "")!== "00000") return new Set();

    const data = Array.isArray(j?.data)? j.data :;
    const set = new Set();

    for (const s of data) {
      const quote = up(s?.quoteCoin || s?.quoteCoinName || "");
      const base = up(s?.baseCoin || s?.baseCoinName || "");
      if (quote === "USDT" && base) set.add(base);
    }

    return set;
  } catch {
    return new Set();
  }
}

async function fetchOrderbook(symbol) {
  try {
    const url = `${BITGET_OB}?symbol=${symbol}&type=step0&limit=20`;
    const j = await fetchJsonWithTimeout(url, {}, 6000);
    if (String(j?.code || "")!== "00000") return null;

    const bids = j?.data?.bids ||;
    const asks = j?.data?.asks ||;
    if (!bids.length ||!asks.length) return null;

    const bestBid = n(bids?., 0);
    const bestAsk = n(asks?., 0);
    if (!(bestBid > 0 && bestAsk > 0)) return null;

    const spreadPct = ((bestAsk - bestBid) / bestBid) * 100;
    const depthBidUsd = bids.slice(0, 8).reduce((a, b) => a + n(b?.[1]) * n(b?.), 0);
    const depthAskUsd = asks.slice(0, 8).reduce((a, b) => a + n(b?.[1]) * n(b?.), 0);
    const total = depthBidUsd + depthAskUsd;
    const score = total > 0? (depthBidUsd - depthAskUsd) / total : 0;

    return {
      bestBid,
      bestAsk,
      spreadPct,
      depthBidUsd,
      depthAskUsd,
      depthMinUsd1p: Math.min(depthBidUsd, depthAskUsd),
      score,
      valid: true,
      fresh: true,
      stale: false,
      reason: "",
      lor: 0,
    };
  } catch {
    return null;
  }
}

function pickTier(marketCap, entryCfg) {
  const tiers = Array.isArray(entryCfg?.adaptiveTiers)? entryCfg.adaptiveTiers :;
  const mc = Number(marketCap || 0);
  for (const t of tiers) {
    if (mc <= Number(t?.maxMc || 0)) return t;
  }
  return tiers[tiers.length - 1] || null;
}

function buildMainTradePlan({ price, range24, confidence, stage, ob, mode }) {
  const p = n(price, 0);
  if (!(p > 0)) return null;

  const st = up(stage);
  if (st!== "ENTRY_READY" && st!== "SETUP" && st!== "WARMUP" && st!== "RADAR") {
    return null;
  }

  const r24 = Math.max(1.5, Math.min(20, n(range24, 0)));
  const conf = Math.max(0, Math.min(100, n(confidence, 0)));
  const spread = n(ob?.spreadPct, 999);

  let slPct = 3.0 + r24 * 0.055;
  let tpPct = 6.6 + r24 * 0.16;

  if (conf >= 20) tpPct += 0.2;
  if (conf >= 30) tpPct += 0.35;
  if (conf >= 40) tpPct += 0.45;

  if (spread <= 1.0) slPct -= 0.1;
  if (spread > 2.0) slPct += 0.2;

  if (st === "SETUP") {
    slPct += 0.18;
    tpPct -= 0.2;
  }

  if (st === "WARMUP") {
    slPct += 0.25;
    tpPct -= 0.35;
  }

  if (st === "RADAR") {
    slPct += 0.4;
    tpPct -= 0.6;
  }

  slPct = Math.max(2.6, Math.min(5.7, slPct));
  tpPct = Math.max(4.8, Math.min(11.0, tpPct));

  if (String(mode || "bull").toLowerCase() === "bear") {
    const sl = p * (1 + slPct / 100);
    const tp = p * (1 - tpPct / 100);
    return {
      entry: Number(p.toFixed(8)),
      sl: Number(sl.toFixed(8)),
      tp: Number(tp.toFixed(8)),
      rr: Number((tpPct / Math.max(slPct, 0.0001)).toFixed(2)),
      tpPct: Number(tpPct.toFixed(2)),
      slPct: Number(slPct.toFixed(2)),
    };
  }

  const sl = p * (1 - slPct / 100);
  const tp = p * (1 + tpPct / 100);
  return {
    entry: Number(p.toFixed(8)),
    sl: Number(sl.toFixed(8)),
    tp: Number(tp.toFixed(8)),
    rr: Number((tpPct / Math.max(slPct, 0.0001)).toFixed(2)),
    tpPct: Number(tpPct.toFixed(2)),
    slPct: Number(slPct.toFixed(2)),
  };
}

function deriveMainRegime({ btc }) {
  const state = up(btc?.state || "NEUTRAL");
  const chg24 = n(btc?.chg24, 0);
  const range24 = n(btc?.range24, 0);

  if (state === "BULL" && chg24 >= 1.3 && range24 >= 3.5) return "EXPANSION";
  if (state === "BULL") return "TREND";
  if (state === "BEAR") return "HEADWIND";
  if (range24 <= 1.6 && Math.abs(chg24) <= 0.6) return "DRY";
  return "CHOP";
}

function getMainMacroMode({ btc, mode }) {
  const state = up(btc?.state || "NEUTRAL");
  const chg24 = n(btc?.chg24, 0);
  const range24 = n(btc?.range24, 0);

  if (mode === "bull") {
    if (state === "BULL" && chg24 >= 0.8 && range24 >= 2.2) return "PERMISSIVE";
    if (state === "NEUTRAL") return "SELECTIVE";
    if (state === "BEAR" && chg24 <= -2.0 && range24 >= 4.2) return "RESTRICTIVE";
    return "SELECTIVE";
  }

  if (mode === "bear") {
    if (state === "BEAR" && chg24 <= -0.8 && range24 >= 2.2) return "PERMISSIVE";
    if (state === "NEUTRAL") return "SELECTIVE";
    if (state === "BULL" && chg24 >= 2.0 && range24 >= 4.2) return "RESTRICTIVE";
    return "SELECTIVE";
  }

  return "SELECTIVE";
}

function preScoreCoin(coin, CORE, CFG, mode, prevStateRow = {}) {
  const marketCap = n(coin.marketCap, 0);
  const volume = n(coin.volume, 0);
  const change24 = n(coin.change24, 0);
  const range24 = n(coin.range24, 0);
  const vm = CORE.computeVm(volume, marketCap);

  const volHist = Array.isArray(prevStateRow?.volHist)? prevStateRow.volHist :;
  let volAcc = 1;
  if (volHist.length >= 6) {
    const ago = volHist[volHist.length - 5] || volume;
    volAcc = volume / Math.max(ago, 1e-9);
  }

  const dynRadar = CORE.dynamicRadarThresholds(range24, CFG);
  const R = CFG.radar || {};

  const radarOk =
    marketCap >= n(R.mcapMin, 0) &&
    marketCap <= n(R.mcapMax, Number.MAX_SAFE_INTEGER) &&
    volume >= n(R.volMin, 0) &&
    vm >= n(R.vmMin, 0) &&
    Math.abs(change24) <= n(R.maxAbsChg24, 999) &&
    range24 <= n(dynRadar.maxRange24, n(R.maxRange24, 999)) &&
    (mode === "bull"
     ? n(coin.change1h, 0) >= n(dynRadar.dir1hMinBull, n(R.dir1hMinBull, 0)) &&
        change24 >= n(dynRadar.dir24MinBull, n(R.dir24MinBull, 0))
      : n(coin.change1h, 0) <= n(dynRadar.dir1hMaxBear, n(R.dir1hMaxBear, 0)) &&
        change24 <= n(dynRadar.dir24MaxBear, n(R.dir24MaxBear, 0)));

  const warmupOk = radarOk && volAcc >= n(CFG.buildup?.minVolAcc, 1.0);
  const confidence = CORE.computeConfidence({ vm, change24, range24, obValid: false });

  // Memory Overflow Bonus: Behoud coins die al bezig waren
  const prevGate = up(prevStateRow?.deskGate || "IGNORE");
  const prevStage = up(prevStateRow?.stage || "");
  let memoryBonus = 0;
  if (prevGate === "WATCH" || prevGate === "OPEN") memoryBonus = 100;
  else if (prevStage === "ENTRY_READY" || prevStage === "SETUP" || prevStage === "ALMOST" || prevStage.includes("ELITE")) memoryBonus = 50;
  else if (prevStage === "WARMUP" || prevStage === "BUILDUP") memoryBonus = 20;

  return {
    score: (radarOk? 20 : 0) + (warmupOk? 18 : 0) + confidence + Math.min(24, volAcc * 10) + memoryBonus,
  };
}

function toFunnelCoin(coin, mode, now) {
  const gate = effectiveGate(coin);
  return {
   ...coin,
    sourceSystem: "main",
    sourceMode: mode,
    sourceKey: `main:${mode}:${String(coin?.symbol || "").toUpperCase()}`,
    queuedAt: now,
    engineGate: up(coin?.engineGate || gate),
    deskGate: up(coin?.deskGate || gate),
    tradeDeskStatus: up(coin?.tradeDeskStatus || gate),
    funnelEligible: gate === "WATCH",
  };
}

async function pushMainScannerToTradeFunnel({
  mode,
  regime,
  btc,
  macroMode,
  latest,
  now,
}) {
  const entryReady = arr(latest?.funnel?.entry_ready);
  const candidates =;

  candidates.sort((a, b) => {
    const gp = gatePriority(effectiveGate(b)) - gatePriority(effectiveGate(a));
    if (gp!== 0) return gp;
    return n(b?.execution?.score, n(b?.confidence, 0)) - n(a?.execution?.score, n(a?.confidence, 0));
  });

  const deduped =;
  const seen = new Set();

  for (const c of candidates) {
    const sym = up(c?.symbol);
    const gate = effectiveGate(c);
    if (!sym) continue;

    const key = `${sym}:${gate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(toFunnelCoin(c, mode, now));
  }

  const modeLatestExisting = await kv.get(keyTradeFunnelLatest(mode));
  const globalLatestExisting = await kv.get(keyTradeFunnelLatestGlobal());
  const modeQueueExisting = await kv.get(keyTradeFunnelQueue(mode));
  const globalQueueExisting = await kv.get(keyTradeFunnelQueueGlobal());

  const mergedModeLatestItems = mergeTradeItems(modeLatestExisting?.items, deduped, 120);
  const mergedGlobalLatestItems = mergeTradeItems(globalLatestExisting?.items, deduped, 160);
  const mergedModeQueueItems = mergeTradeItems(modeQueueExisting?.items, deduped, 120);
  const mergedGlobalQueueItems = mergeTradeItems(globalQueueExisting?.items, deduped, 180);

  const buildPayload = (items, payloadMode) => ({
    ok: true,
    sourceSystem: "aggregate",
    mode: payloadMode,
    regime,
    btc,
    macroMode,
    counts: {
      open: 0,
      watch: items.filter((c) => effectiveGate(c) === "WATCH").length,
      total: items.length,
    },
    items,
    ts: now,
  });

  const modeLatestPayload = buildPayload(mergedModeLatestItems, mode);
  const globalLatestPayload = buildPayload(mergedGlobalLatestItems, "all");
  const modeQueuePayload = buildPayload(mergedModeQueueItems, mode);
  const globalQueuePayload = buildPayload(mergedGlobalQueueItems, "all");

  await kv.set(keyTradeFunnelLatest(mode), modeLatestPayload, { ex: 60 * 60 });
  await kv.set(keyTradeFunnelLatestGlobal(), globalLatestPayload, { ex: 60 * 60 });
  await kv.set(keyTradeFunnelQueue(mode), modeQueuePayload, { ex: 60 * 60 * 6 });
  await kv.set(keyTradeFunnelQueueGlobal(), globalQueuePayload, { ex: 60 * 60 * 6 });

  return {
    ok: true,
    sourceSystem: "main",
    mode,
    regime,
    btc,
    macroMode,
    counts: {
      open: 0,
      watch: deduped.filter((c) => effectiveGate(c) === "WATCH").length,
      total: deduped.length,
    },
    items: deduped,
    ts: now,
  };
}

export default async function handler(req, res) {
  let mode = "bull";
  let lockAcquired = false;

  try {
    const isVercelCron = String(req.headers?.["x-vercel-cron"] || "") === "1";
    const tokenOk =
      process.env.CRON_SECRET &&
      String(req.query?.token || "") === String(process.env.CRON_SECRET);

    if (!isVercelCron &&!tokenOk) {
      if (!requireSecret(req, res)) return;
    }

    mode = String(req.query?.mode || "bull").toLowerCase() === "bear"? "bear" : "bull";

    const CORE =
      mode === "bear"
       ? await import("../lib/_core_bear.js")
        : await import("../lib/_core_bull.js");

    const CFG = CORE.getCfg();

    const lock = await acquireScanLock(mode);
    if (!lock.ok) {
      const latest = await kv.get(keyMainLatest(mode));
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      return res.end(
        JSON.stringify(
          latest || {
            ok: true,
            skipped: true,
            reason: "scan_lock_active",
            mode,
            until: lock.until,
          }
        )
      );
    }
    lockAcquired = true;

    const now = Date.now();

    const btcRaw = await fetchBTCGateFromUniverse();
    const btc = {
      price: n(btcRaw?.price, 0),
      chg24: n(btcRaw?.chg24, 0),
      chg1h: n(btcRaw?.chg1h, 0),
      range24: n(btcRaw?.range24, 0),
      state: CORE.computeBtcState(btcRaw, CFG),
    };

    const regime = deriveMainRegime({ btc });
    const macroMode = getMainMacroMode({ btc, mode });

    const cg = await fetchCoinGeckoTopCached(MAX_COINS_FROM_CG);
    const rawCoins = Array.isArray(cg?.coins)? cg.coins :;
    const cgMeta = cg?.meta || {};
    const bitgetSymbols = await getBitgetSpotUsdtSymbols();

    const tradable = rawCoins
     .filter((c) => bitgetSymbols.has(up(c.symbol)))
     .filter((c) => (typeof CORE.isBlockedMainAsset === "function"?!CORE.isBlockedMainAsset(c) : true))
     .filter((c) => n(c?.price, 0) > 0)
     .slice(0, MAX_COINS_FROM_CG);

    const prevState = (await kv.get(keyMainState(mode))) || {};
    const nextState = {};

    const funnel = {
      entry_ready:,
      setup:,
      warmup:,
      radar:,

      // legacy aliases
      trade_ready:,
      almost:,
      buildup:,
    };

    const prescored = tradable.map((coin) => ({
      coin,
      sym: up(coin.symbol),
      prev: prevState?.[up(coin.symbol)] || {},
     ...preScoreCoin(coin, CORE, CFG, mode, prevState?.[up(coin.symbol)] || {}),
    }));

    const obCandidates = [...prescored]
     .sort((a, b) => n(b.score, 0) - n(a.score, 0))
     .slice(0, MAX_OB_CANDIDATES);

    const obMap = new Map();

    await mapLimit(obCandidates, OB_CONCURRENCY, async (row) => {
      const ob = await fetchOrderbook(`${row.sym}USDT`);
      obMap.set(row.sym, ob);
    });

    for (const row of prescored) {
      const { coin, sym, prev } = row;

      const marketCap = n(coin.marketCap, 0);
      const volume = n(coin.volume, 0);
      const change24 = n(coin.change24, 0);
      const change1h = n(coin.change1h, 0);
      const range24 = n(coin.range24, 0);
      const vm = CORE.computeVm(volume, marketCap);
      const ob = obMap.get(sym) || null;

      const priceHist = Array.isArray(prev?.priceHist)? [...prev.priceHist] :;
      const volHist = Array.isArray(prev?.volHist)? [...prev.volHist] :;
      const stageHist = Array.isArray(prev?.stageHist)? [...prev.stageHist] :;
      
      // V3: Fast Pulse KV voor micro-features
      const pulseHist = Array.isArray(prev?.pulseHist)? [...prev.pulseHist] :;

      priceHist.push(n(coin.price, 0));
      volHist.push(volume);

      if (ob?.valid) {
        pulseHist.push({
          ts: now,
          midPrice: (ob.bestBid + ob.bestAsk) / 2,
          spreadPct: ob.spreadPct,
          obScore: ob.score,
          depthBid: ob.depthBidUsd,
          depthAsk: ob.depthAskUsd
        });
      }

      const priceHistNext = priceHist.slice(-120);
      const volHistNext = volHist.slice(-120);
      const pulseHistNext = pulseHist.slice(-15); // ca. 15 metingen

      // Bereken V3 Micro-features
      let obScoreSlope = 0, spreadSlope = 0, askDepletionRate = 0, bidRefillRate = 0, fastAnomalyScore = 0;
      
      if (pulseHistNext.length >= 3) {
        const firstP = pulseHistNext;
        const lastP = pulseHistNext[pulseHistNext.length - 1];
        obScoreSlope = lastP.obScore - firstP.obScore;
        spreadSlope = lastP.spreadPct - firstP.spreadPct;

        if (firstP.depthAsk > 0) askDepletionRate = (firstP.depthAsk - lastP.depthAsk) / firstP.depthAsk;
        if (firstP.depthBid > 0) bidRefillRate = (lastP.depthBid - firstP.depthBid) / firstP.depthBid;

        let fas = 0;
        if (mode === "bull") {
            if (obScoreSlope > 0.03) fas += 25; else if (obScoreSlope > 0.01) fas += 10;
            if (spreadSlope < -0.05) fas += 20;
            if (askDepletionRate > 0.10) fas += 25;
            if (bidRefillRate > 0.10) fas += 30;
        } else {
            if (obScoreSlope < -0.03) fas += 25; else if (obScoreSlope < -0.01) fas += 10;
            if (spreadSlope < -0.05) fas += 20;
            let bidDepletion = firstP.depthBid > 0? (firstP.depthBid - lastP.depthBid) / firstP.depthBid : 0;
            let askRefill = firstP.depthAsk > 0? (lastP.depthAsk - firstP.depthAsk) / firstP.depthAsk : 0;
            if (bidDepletion > 0.10) fas += 25;
            if (askRefill > 0.10) fas += 30;
        }
        fastAnomalyScore = Math.max(0, Math.min(100, Math.round(fas)));
      }

      let volAcc = 1;
      if (volHistNext.length >= 6) {
        const nowVol = volHistNext[volHistNext.length - 1];
        const ago = volHistNext[volHistNext.length - 1 - 5] || nowVol;
        volAcc = nowVol / Math.max(ago, 1e-9);
      }

      let flat60Pct = 999;
      if (priceHistNext.length >= 10) {
        const tail = priceHistNext.slice(-60);
        const hi = Math.max(...tail.map((x) => n(x, 0)));
        const lo = Math.min(...tail.map((x) => n(x, 0)));
        flat60Pct = lo > 0? ((hi - lo) / lo) * 100 : 999;
      }

      const dynRadar = CORE.dynamicRadarThresholds(range24, CFG);
      const R = CFG.radar || {};

      const confidence = CORE.computeConfidence({
        vm,
        change24,
        range24,
        obValid:!!ob?.valid,
      });

      const radarPass =
        marketCap >= n(R.mcapMin, 0) &&
        marketCap <= n(R.mcapMax, Number.MAX_SAFE_INTEGER) &&
        volume >= n(R.volMin, 0) &&
        vm >= n(R.vmMin, 0) &&
        Math.abs(change24) <= n(R.maxAbsChg24, 999) &&
        range24 <= n(dynRadar.maxRange24, n(R.maxRange24, 999)) &&
        (mode === "bull"
         ? change1h >= n(dynRadar.dir1hMinBull, n(R.dir1hMinBull, 0)) &&
            change24 >= n(dynRadar.dir24MinBull, n(R.dir24MinBull, 0))
          : change1h <= n(dynRadar.dir1hMaxBear, n(R.dir1hMaxBear, 0)) &&
            change24 <= n(dynRadar.dir24MaxBear, n(R.dir24MaxBear, 0)));

      const warmupPass =
        radarPass &&
        volAcc >= n(CFG.buildup?.minVolAcc, 1.0);

      const setupPass =
        warmupPass &&
        confidence >= n(CFG.almost?.minConfidence, 0) &&
        flat60Pct <= n(CFG.almost?.maxFlat60Pct, 999);

      let entryReadyPass = false;
      let entryReason = "";
      let depthOk = false;
      let dynThr = null;

      if (setupPass && ob?.valid) {
        const entryCfg = CFG.entry || {};
        const tier = pickTier(marketCap, entryCfg);

        const baseThr = {
          minConfidence: n(tier?.minConf, n(entryCfg.minConfidence, 10)),
          spreadMaxPct: n(tier?.spreadMax, n(entryCfg.spreadMaxPct, 5.6)),
          depthMinUsd1p: n(tier?.depth1pMin, n(entryCfg.depthMinUsd1p, 800)),
          obScoreMin: n(tier?.obScoreMin, n(entryCfg.obScoreMin, 0.0008)),
        };

        dynThr = CORE.dynamicEntryThresholds({ marketCap, volume, vm }, baseThr, CFG);

        const score = n(ob.score, 0);

        let spreadLimit = n(dynThr.spreadMaxPct, 999);
        let confNeed = n(dynThr.minConfidence, n(entryCfg.minConfidence, 0));
        let depthNeed = n(dynThr.depthMinUsd1p, 0);
        let scoreNeed = n(dynThr.obScoreMin, 0);

        if (macroMode === "PERMISSIVE") {
          spreadLimit = Math.min(6.8, spreadLimit + 0.8);
          confNeed = Math.max(5, confNeed - 3);
          depthNeed = Math.max(500, depthNeed * 0.72);
          scoreNeed = Math.max(0.00035, scoreNeed * 0.58);
        } else if (macroMode === "SELECTIVE") {
          spreadLimit = Math.min(6.2, spreadLimit + 0.45);
          confNeed = Math.max(6, confNeed - 2);
          depthNeed = Math.max(650, depthNeed * 0.84);
          scoreNeed = Math.max(0.0005, scoreNeed * 0.72);
        } else if (macroMode === "RESTRICTIVE") {
          spreadLimit = Math.min(5.0, spreadLimit + 0.1);
          confNeed = Math.max(8, confNeed - 1);
          depthNeed = Math.max(750, depthNeed * 0.95);
          scoreNeed = Math.max(0.0007, scoreNeed * 0.9);
        }

        // V3 Fast Anomaly Versoepeling voor ENTRY GATE
        if (fastAnomalyScore >= 50) {
            spreadLimit = Math.min(3.0, spreadLimit * 1.4); // Laat wijdere spread toe bij sterke momentum
            depthNeed = depthNeed * 0.6; // Lagere bodem voor orderboek depth
            confNeed = Math.max(0, confNeed - 5);
            scoreNeed = scoreNeed * 0.5;
        }

        const spreadOk = n(ob.spreadPct, 999) <= spreadLimit;
        depthOk = n(ob.depthMinUsd1p, 0) >= depthNeed;
        const confOk = confidence >= confNeed;
        const scoreOk = mode === "bull"? score >= scoreNeed : score <= -scoreNeed;

        entryReadyPass = spreadOk && depthOk && confOk && scoreOk;

        if (!confOk) entryReason = "conf_low";
        else if (!spreadOk) entryReason = "spread";
        else if (!depthOk) entryReason = "depth";
        else if (!scoreOk) entryReason = "ob_score";
        else entryReason = "ok";
      } else if (!setupPass) {
        entryReason = "setup_not_ready";
      } else if (!ob?.valid) {
        entryReason = "missing_ob";
      }

      let stage = "UNIVERSE";
      if (radarPass) stage = "RADAR";
      if (warmupPass) stage = "WARMUP";
      if (setupPass) stage = "SETUP";
      if (entryReadyPass) stage = "ENTRY_READY";

      const scannerGate = gateFromPipelineStage(stage);
      const engineGate = scannerGate;

      const prevGate =
        prev?.deskGate ||
        prev?.tradeDeskStatus ||
        prev?.engineGate ||
        prev?.scannerGate ||
        "IGNORE";

      const deskGate = resolveDeskGate({
        prevGate,
        prevMeta: prev?.deskMeta || {},
        engineGate,
        now,
      });

      const deskMeta = buildDeskMeta({
        prevGate,
        prevMeta: prev?.deskMeta || {},
        deskGate,
        engineGate,
        now,
      });

      const uiLockUntil = Math.max(
        n(prev?.uiLockUntil, 0),
        deskGate === "WATCH"? now + UI_ENTRY_LOCK_MS_MAIN : 0
      );

      const compression = {
        isCompressed: flat60Pct <= n(CFG.almost?.maxFlat60Pct, 999),
        flatPct: Number(n(flat60Pct, 0).toFixed(3)),
      };

      const breakout = {
        ready: stage === "ENTRY_READY",
        pressure:
          stage === "ENTRY_READY"
           ? 60
            : stage === "SETUP"
             ? 46
              : stage === "WARMUP"
               ? 34
                : 18,
        breakoutPct: 0,
      };

      const thresholds = {
        depthFloorUsd: dynThr? n(dynThr.depthMinUsd1p, 0) : 0,
        depthOk,
      };

      const tradePlan = buildMainTradePlan({
        price: n(coin.price, 0),
        range24,
        confidence,
        stage,
        ob,
        mode,
      });

      const entryQuality = confidence;
      const persistenceScore = Math.round(
        Math.max(0, Math.min(100, confidence * 0.82 + Math.min(volAcc * 12, 16)))
      );

      const stageLegacy = pipelineToLegacyStage(stage);

      const coinProfileBase = {
        id: coin.id,
        symbol: sym,
        name: coin.name || "",
        image: coin.image || "",
        side: mode === "bear"? "SHORT" : "LONG",
        price: n(coin.price, 0),
        marketCap,
        volume,
        change24,
        change1h,
        range24,
        vm,
        confidence,
        entryQuality,
        persistenceScore,

        stage,
        pipelineStage: stage,
        stageLegacy,

        stageWhy:
          entryReadyPass
           ? "entry_ready"
            : stage === "SETUP"
             ? "setup_ready"
              : stage === "WARMUP"
               ? "warmup_ready"
                : stage === "RADAR"
                 ? "radar_ready"
                  : "universe_only",

        ob: ob
         ? {
              bestBid: n(ob.bestBid, 0),
              bestAsk: n(ob.bestAsk, 0),
              spreadPct: Number(n(ob.spreadPct, 999).toFixed(4)),
              depthMinUsd1p: Math.round(n(ob.depthMinUsd1p, 0)),
              score: Number(n(ob.score, 0).toFixed(6)),
              valid:!!ob.valid,
              fresh:!!ob.fresh,
              stale:!!ob.stale,
              reason: String(ob.reason || ""),
              lor: n(ob.lor, 0),
            }
          : {
              bestBid: 0,
              bestAsk: 0,
              spreadPct: 999,
              depthMinUsd1p: 0,
              score: 0,
              valid: false,
              fresh: false,
              stale: true,
              reason: "missing_ob",
              lor: 0,
            },

        thresholds,
        breakout,
        compression,
        volAcc: {
          short: Number(volAcc.toFixed(3)),
          medium: Number(volAcc.toFixed(3)),
        },

        tradePlan,
        scannerGate,
        engineGate,
        deskGate,
        tradeDeskStatus: deskGate,
        deskMeta,
        uiLockUntil,

        qualityScore: confidence,
        liquidityScore: ob?.valid
         ? Math.max(
              0,
              Math.min(
                100,
                55 + (n(ob.score, 0) * 100) / 2 - Math.max(0, n(ob.spreadPct, 0) - 1.0) * 6
              )
            )
          : 35,

        timingScore:
          stage === "ENTRY_READY"
           ? 82
            : stage === "SETUP"
             ? 70
              : stage === "WARMUP"
               ? 58
                : 40,

        marketScore:
          regime === "EXPANSION"
           ? 82
            : regime === "TREND"
             ? 70
              : regime === "HEADWIND"
               ? 35
                : 50,

        perfectCandidateScore:
          stage === "ENTRY_READY"
           ? 78
            : stage === "SETUP"
             ? 68
              : stage === "WARMUP"
               ? 56
                : 36,

        tradeCandidate: stage === "ENTRY_READY" && effectiveGate({ deskGate, engineGate, scannerGate }) === "WATCH",
        superScannerCoin:
          stage === "ENTRY_READY" ||
          stage === "SETUP" ||
          stage === "WARMUP" ||
          stage === "RADAR",

        scannerOnly: effectiveGate({ deskGate, engineGate, scannerGate }) === "IGNORE",

        entry: {
          ok:!!entryReadyPass,
          reason: entryReason,
          slopeOk: true,
          slope: Number(obScoreSlope.toFixed(4)),
          fastAnomalyScore: fastAnomalyScore
        },

        flat60Pct: Number(n(flat60Pct, 0).toFixed(3)),

        filterSnapshot: {
          system: "main",
          mode,
          regime,
          macroMode,
          stage,
          pipelineStage: stage,
          stageLegacy,
          engineGate,
          tradeDeskStatus: deskGate,
          liveMetrics: {
            confidence: n(confidence, 0),
            volAcc: n(volAcc, 0),
            flat60Pct: n(flat60Pct, 0),
            spreadPct: n(ob?.spreadPct, 999),
            depthMinUsd1p: n(ob?.depthMinUsd1p, 0),
            obScore: n(ob?.score, 0),
            fastAnomalyScore: fastAnomalyScore
          },
        },
      };

      const engineCoin = {
       ...coinProfileBase,
        stage: stageLegacy,
        pipelineStage: stage,
      };

      const coinProfile = buildCoinProfile({
        systemType: "main",
        coin: engineCoin,
      });

      const execution = buildMainExecutionDecision({
        coin: engineCoin,
        btc,
        regime,
        mode,
        coinProfile,
        positionState: prev?.positionState || {
          inPosition: false,
          cyclesInTrade: 0,
          minHoldCycles: 5,
          weakHoldCount: 0,
          maxWeakHoldCycles: 2,
        },
        scannerGate: engineGate,
      });

      const outCoin = {
       ...coinProfileBase,
        coinProfile,
        execution,
      };

      const stageHistNext = [...stageHist, stage].slice(-12);

      nextState[sym] = {
        symbol: sym,
        stage,
        pipelineStage: stage,
        stageLegacy,
        lastSeen: now,
        side: mode === "bear"? "SHORT" : "LONG",
        price: n(coin.price, 0),
        marketCap,
        volume,
        change24,
        change1h,
        range24,
        vm,
        volAcc: Number(volAcc.toFixed(3)),
        flat60Pct: Number(n(flat60Pct, 0).toFixed(3)),
        confidence,
        entryQuality,
        persistenceScore,
        fastAnomalyScore,
        ob: outCoin.ob,
        thresholds,
        breakout,
        compression,
        tradePlan,
        scannerGate,
        engineGate,
        deskGate,
        tradeDeskStatus: deskGate,
        deskMeta,
        uiLockUntil,
        execution,
        coinProfile,
        entry: coinProfileBase.entry,
        priceHist: priceHistNext,
        volHist: volHistNext,
        stageHist: stageHistNext,
        pulseHist: pulseHistNext,
        filterSnapshot: outCoin.filterSnapshot,
        positionState: prev?.positionState || {
          inPosition: false,
          cyclesInTrade: 0,
          minHoldCycles: 5,
          weakHoldCount: 0,
          maxWeakHoldCycles: 2,
        },
      };

      if (stage === "ENTRY_READY") funnel.entry_ready.push(outCoin);
      else if (stage === "SETUP") funnel.setup.push(outCoin);
      else if (stage === "WARMUP") funnel.warmup.push(outCoin);
      else if (stage === "RADAR") funnel.radar.push(outCoin);
    }

    const byConf = (a, b) =>
      n(b.execution?.score, n(b.confidence, 0)) - n(a.execution?.score, n(a.confidence, 0));

    funnel.entry_ready.sort(byConf);
    funnel.setup.sort(byConf);
    funnel.warmup.sort(byConf);
    funnel.radar.sort(byConf);

    funnel.entry_ready = funnel.entry_ready.slice(0, n(CFG.ENTRY_LIMIT, 18));
    funnel.setup = funnel.setup.slice(0, n(CFG.ALMOST_LIMIT, 35));
    funnel.warmup = funnel.warmup.slice(0, n(CFG.BUILDUP_LIMIT, 55));
    funnel.radar = funnel.radar.slice(0, n(CFG.RADAR_LIMIT, 100));

    funnel.trade_ready = [...funnel.entry_ready];
    funnel.almost = [...funnel.setup];
    funnel.buildup = [...funnel.warmup];

    const latest = {
      ok: true,
      mode,
      regime,
      btc,
      funnel,
      counts: {
        entry_ready: funnel.entry_ready.length,
        setup: funnel.setup.length,
        warmup: funnel.warmup.length,
        radar: funnel.radar.length,

        trade_ready: funnel.trade_ready.length,
        almost: funnel.almost.length,
        buildup: funnel.buildup.length,
      },
      ts: now,
      scannedAt: now,
      meta: {
        scanLock: { active: false, until: null },
        trigger: isVercelCron? "vercel_cron" : tokenOk? "cron_token" : "manual_secret",
        macroMode,
        performance: {
          maxCoinsFromCg: MAX_COINS_FROM_CG,
          maxObCandidates: MAX_OB_CANDIDATES,
          obConcurrency: OB_CONCURRENCY,
        },
        cg: {
          coinsFetched: rawCoins.length,
          tradable: tradable.length,
          usedCache:!!cgMeta.usedCache,
          partial:!!cgMeta.partial,
          rateLimited:!!cgMeta.rateLimited,
        },
      },
    };

    await kv.set(keyMainState(mode), nextState, { ex: 60 * 60 * 24 * 3 });
    await kv.set(keyMainLatest(mode), latest, { ex: 60 * 60 });

    const funnelForward = await pushMainScannerToTradeFunnel({
      mode,
      regime,
      btc,
      macroMode,
      latest,
      now,
    });

    await kv.set(
      keyMainConfigSnapshot(mode),
      {
        system: "main",
        mode,
        regime,
        macroMode,
        scanner: {
          radar: CFG?.radar || {},
          warmup: CFG?.buildup || {},
          setup: CFG?.almost || {},
          entry_ready: CFG?.entry || {},
        },
        limits: {
          ENTRY_LIMIT: CFG?.ENTRY_LIMIT?? null,
          ALMOST_LIMIT: CFG?.ALMOST_LIMIT?? null,
          BUILDUP_LIMIT: CFG?.BUILDUP_LIMIT?? null,
          RADAR_LIMIT: CFG?.RADAR_LIMIT?? null,
          CG_TOP: CFG?.CG_TOP?? null,
        },
        forwarding: {
          pushedToTradeFunnel: true,
          open: 0,
          watch: n(funnelForward?.counts?.watch, 0),
          total: n(funnelForward?.counts?.total, 0),
        },
        updatedAt: now,
      },
      { ex: 60 * 60 * 24 * 7 }
    );

    res.status(200).json({
     ...latest,
      forwarding: funnelForward,
    });
  } catch (err) {
    console.error("scan error:", err);
    res.status(500).json({
      ok: false,
      error: err?.message || String(err),
      status: err?.status || null,
    });
  } finally {
    if (lockAcquired) await releaseScanLock(mode);
  }
}
