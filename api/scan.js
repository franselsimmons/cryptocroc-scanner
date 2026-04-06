// api/scan.js
import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG } from "../lib/_runtime.js";
import { sendSignal } from "../lib/discordRouter.js";
import { buildCoinProfile, buildMainExecutionDecision } from "../lib/_trade_engine.js";

export const config = RUNTIME_CONFIG;

const BITGET_OB = "https://api.bitget.com/api/v2/spot/market/orderbook";
const BITGET_SYMBOLS = "https://api.bitget.com/api/v2/spot/public/symbols";
const CG_MARKETS = "https://api.coingecko.com/api/v3/coins/markets";

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

// ======================================================
// Helpers
// ======================================================
function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}
function up(x) {
  return String(x || "").toUpperCase();
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sideFromMode(mode) {
  return String(mode || "bull").toLowerCase() === "bear" ? "SHORT" : "LONG";
}

function pickRetryAfterSeconds(res) {
  const ra = res?.headers?.get?.("retry-after");
  const s = Number(ra);
  return Number.isFinite(s) && s > 0 ? s : null;
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
      const ra = pickRetryAfterSeconds(res);
      if (ra != null) err.retryAfter = String(ra);
      throw err;
    }

    return await res.json();
  } finally {
    clearTimeout(id);
  }
}

// ======================================================
// Secret gate
// ======================================================
function requireSecret(req, res) {
  const qToken = String(req.query?.token || "");
  const bearer = String(req.headers?.authorization || "");
  const headerToken = bearer.toLowerCase().startsWith("bearer ") ? bearer.slice(7).trim() : "";

  const ok =
    (process.env.CRON_SECRET && qToken && qToken === String(process.env.CRON_SECRET)) ||
    (process.env.SCAN_SECRET && qToken && qToken === String(process.env.SCAN_SECRET)) ||
    (process.env.CRON_SECRET && headerToken && headerToken === String(process.env.CRON_SECRET)) ||
    (process.env.SCAN_SECRET && headerToken && headerToken === String(process.env.SCAN_SECRET));

  if (ok) return true;

  res.statusCode = 401;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
  return false;
}

// ======================================================
// Scan lock (30m boundaries)
// ======================================================
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
  if (ok) return { ok: true, key, until };

  const cur = await kv.get(key);
  const curUntil = Number(cur?.until || 0);
  if (curUntil > now) return { ok: false, key, until: curUntil };

  await kv.set(key, { ts: now, until, mode }, { ex: ttlSec });
  return { ok: true, key, until };
}
async function releaseScanLock(mode) {
  try {
    await kv.del(keyScanLock(mode));
  } catch {}
}

// ======================================================
// CoinGecko caching
// ======================================================
const KV_CG_TOP = "main:cg:top:v2";
const KV_CG_BTC = "main:cg:btc:v2";
const KV_CG_PAGE_PREFIX = "main:cg:markets:v2:page:";

const CG_PAGE_TTL_SEC = 60 * 5;
const CG_TOP_TTL_SEC = 60 * 12;
const CG_BTC_TTL_SEC = 60 * 5;

function normalizeCgMarketRow(c) {
  const hi = n(c.high_24h, 0);
  const lo = n(c.low_24h, 0);
  const range24 = hi > 0 && lo > 0 ? ((hi - lo) / lo) * 100 : 0;

  return {
    id: String(c.id || ""),
    symbol: up(c.symbol),
    name: String(c.name || ""),
    image: String(c.image || ""),
    price: n(c.current_price, 0),
    marketCap: n(c.market_cap, 0),
    volume: n(c.total_volume, 0),
    change24: n(c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h, 0),
    change1h: n(c.price_change_percentage_1h_in_currency ?? c.price_change_percentage_1h, 0),
    range24,
  };
}

async function fetchCoinGeckoMarketsPage(page, perPage = 250) {
  const url =
    `${CG_MARKETS}?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=${page}` +
    `&sparkline=false&price_change_percentage=1h,24h`;

  const arr = await fetchJsonWithTimeout(url, {}, 9000);
  if (!Array.isArray(arr)) return [];
  return arr.map(normalizeCgMarketRow);
}

async function fetchCoinGeckoTopCached(maxCoins = 1500) {
  const perPage = 250;
  const maxPages = Math.max(1, Math.ceil(maxCoins / perPage));
  const out = [];
  const meta = { usedCache: false, partial: false, rateLimited: false };

  for (let page = 1; page <= maxPages; page++) {
    try {
      const rows = await fetchCoinGeckoMarketsPage(page, perPage);
      if (!rows.length) break;

      out.push(...rows);
      await kv.set(`${KV_CG_PAGE_PREFIX}${page}`, rows, { ex: CG_PAGE_TTL_SEC });
      await sleep(250);

      if (out.length >= maxCoins) break;
    } catch (e) {
      const status = Number(e?.status || 0);
      if (status === 429) {
        meta.rateLimited = true;

        if (out.length > 0) {
          meta.partial = true;
          await kv.set(KV_CG_TOP, out.slice(0, maxCoins), { ex: CG_TOP_TTL_SEC });
          return { coins: out.slice(0, maxCoins), meta };
        }

        const cachedCoins = [];
        for (let p = 1; p <= maxPages; p++) {
          const cachedPage = await kv.get(`${KV_CG_PAGE_PREFIX}${p}`);
          if (Array.isArray(cachedPage) && cachedPage.length) cachedCoins.push(...cachedPage);
          if (cachedCoins.length >= maxCoins) break;
        }

        if (cachedCoins.length) {
          meta.usedCache = true;
          meta.partial = cachedCoins.length < maxCoins;
          return { coins: cachedCoins.slice(0, maxCoins), meta };
        }

        const snap = await kv.get(KV_CG_TOP);
        if (Array.isArray(snap) && snap.length) {
          meta.usedCache = true;
          meta.partial = snap.length < maxCoins;
          return { coins: snap.slice(0, maxCoins), meta };
        }

        return { coins: [], meta };
      }

      if (out.length > 0) {
        meta.partial = true;
        await kv.set(KV_CG_TOP, out.slice(0, maxCoins), { ex: CG_TOP_TTL_SEC });
        return { coins: out.slice(0, maxCoins), meta };
      }

      throw e;
    }
  }

  if (out.length) await kv.set(KV_CG_TOP, out.slice(0, maxCoins), { ex: CG_TOP_TTL_SEC });
  return { coins: out.slice(0, maxCoins), meta };
}

// ======================================================
// BTC
// ======================================================
async function fetchBTCGateFromUniverse() {
  try {
    const url =
      `${CG_MARKETS}?vs_currency=usd&ids=bitcoin&order=market_cap_desc&per_page=1&page=1` +
      `&sparkline=false&price_change_percentage=1h,24h`;

    const arr = await fetchJsonWithTimeout(url, {}, 8000);
    const btc = Array.isArray(arr) && arr.length ? arr[0] : null;
    if (!btc) throw new Error("no_btc");

    const price = n(btc.current_price, 0);
    const chg24 = n(btc.price_change_percentage_24h_in_currency ?? btc.price_change_percentage_24h, 0);
    const chg1h = n(btc.price_change_percentage_1h_in_currency ?? btc.price_change_percentage_1h, 0);
    const hi = n(btc.high_24h, 0);
    const lo = n(btc.low_24h, 0);
    const range24 = hi > 0 && lo > 0 ? ((hi - lo) / lo) * 100 : 0;

    const out = { price, chg24, chg1h, range24, state: "NEUTRAL" };
    await kv.set(KV_CG_BTC, out, { ex: CG_BTC_TTL_SEC });
    return out;
  } catch (e) {
    const cached = await kv.get(KV_CG_BTC);
    if (cached && typeof cached === "object") return cached;
    return { price: 0, chg24: 0, chg1h: 0, range24: 0, state: "NEUTRAL", _err: String(e?.message || e) };
  }
}

// ======================================================
// Bitget symbols
// ======================================================
async function getBitgetSpotUsdtSymbols() {
  try {
    const j = await fetchJsonWithTimeout(BITGET_SYMBOLS, {}, 8000);
    if (String(j?.code || "") !== "00000") return new Set();
    const data = Array.isArray(j?.data) ? j.data : [];

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

// ======================================================
// Orderbook
// ======================================================
async function fetchOrderbook(symbol) {
  try {
    const url = `${BITGET_OB}?symbol=${symbol}&type=step0&limit=20`;
    const j = await fetchJsonWithTimeout(url, {}, 6500);
    if (String(j?.code || "") !== "00000") return null;

    const bids = j?.data?.bids || [];
    const asks = j?.data?.asks || [];
    if (!bids.length || !asks.length) return null;

    const bestBid = n(bids[0]?.[0], 0);
    const bestAsk = n(asks[0]?.[0], 0);
    if (!(bestBid > 0 && bestAsk > 0)) return null;

    const spreadPct = ((bestAsk - bestBid) / bestBid) * 100;
    const depthBidUsd = bids.slice(0, 8).reduce((a, b) => a + n(b?.[1]) * n(b?.[0]), 0);
    const depthAskUsd = asks.slice(0, 8).reduce((a, b) => a + n(b?.[1]) * n(b?.[0]), 0);

    const total = depthBidUsd + depthAskUsd;
    const score = total > 0 ? (depthBidUsd - depthAskUsd) / total : 0;

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
  const tiers = Array.isArray(entryCfg?.adaptiveTiers) ? entryCfg.adaptiveTiers : [];
  const mc = Number(marketCap || 0);
  for (const t of tiers) {
    if (mc <= Number(t?.maxMc || 0)) return t;
  }
  return tiers[tiers.length - 1] || null;
}

// ======================================================
// Main helpers for trade engine compatibility
// ======================================================
function buildMainTradePlan({ price, range24, confidence, stage, ob, mode }) {
  const p = n(price, 0);
  if (!(p > 0)) return null;
  if (String(stage || "").toUpperCase() !== "ENTRY") return null;

  const r24 = Math.max(2, Math.min(18, n(range24, 0)));
  const conf = Math.max(0, Math.min(100, n(confidence, 0)));
  const spread = n(ob?.spreadPct, 999);

  let slPct = 3.2 + r24 * 0.06;
  let tpPct = 6.8 + r24 * 0.14;

  if (conf >= 40) tpPct += 0.4;
  if (conf >= 50) tpPct += 0.5;
  if (spread <= 0.7) slPct -= 0.15;
  if (spread > 1.2) slPct += 0.2;

  slPct = Math.max(2.8, Math.min(4.8, slPct));
  tpPct = Math.max(5.8, Math.min(10.5, tpPct));

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

  if (state === "BULL" && chg24 >= 1.5 && range24 >= 4.0) return "EXPANSION";
  if (state === "BULL") return "TREND";
  if (state === "BEAR") return "HEADWIND";
  if (range24 <= 1.5 && Math.abs(chg24) <= 0.5) return "DRY";
  return "CHOP";
}

function gateFromStage(stage) {
  const st = up(stage);
  if (st === "ENTRY") return "OPEN";
  if (st === "ALMOST") return "WATCH";
  return "IGNORE";
}

// ======================================================
// NEW: Macro mode for neutral BTC selectivity
// ======================================================
function getMainMacroMode({ btc, mode }) {
  const state = up(btc?.state || "NEUTRAL");
  const chg24 = n(btc?.chg24, 0);
  const range24 = n(btc?.range24, 0);

  if (mode === "bull") {
    if (state === "BULL" && chg24 >= 1.2 && range24 >= 3.2) return "PERMISSIVE";
    if (state === "NEUTRAL") return "SELECTIVE";
    return "RESTRICTIVE";
  }

  if (mode === "bear") {
    if (state === "BEAR" && chg24 <= -1.2 && range24 >= 3.2) return "PERMISSIVE";
    if (state === "NEUTRAL") return "SELECTIVE";
    return "RESTRICTIVE";
  }

  return "SELECTIVE";
}

// ======================================================
// Main scan
// ======================================================
export default async function handler(req, res) {
  let mode = "bull";
  let lockAcquired = false;

  try {
    const isVercelCron = String(req.headers?.["x-vercel-cron"] || "") === "1";
    const tokenOk =
      process.env.CRON_SECRET &&
      String(req.query?.token || "") === String(process.env.CRON_SECRET);

    if (!isVercelCron && !tokenOk) {
      if (!requireSecret(req, res)) return;
    }

    mode = String(req.query?.mode || "bull").toLowerCase() === "bear" ? "bear" : "bull";

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
      if (latest) {
        return res.end(
          JSON.stringify({
            ...latest,
            meta: {
              ...(latest.meta || {}),
              scanLock: { active: true, until: lock.until || null },
              trigger: isVercelCron ? "vercel_cron" : tokenOk ? "cron_token" : "manual_secret",
            },
          })
        );
      }
      return res.end(JSON.stringify({ ok: true, skipped: true, reason: "scan_lock_active", mode, until: lock.until || null }));
    }
    lockAcquired = true;

    const now = Date.now();

    // BTC
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

    // Universe
    const cg = await fetchCoinGeckoTopCached(Number(CFG.CG_TOP || 1500));
    const rawCoins = Array.isArray(cg?.coins) ? cg.coins : [];
    const cgMeta = cg?.meta || {};
    const bitgetSymbols = await getBitgetSpotUsdtSymbols();

    const tradable = rawCoins
      .filter((c) => bitgetSymbols.has(up(c.symbol)))
      .slice(0, Number(CFG.CG_TOP || 1500));

    const prevState = (await kv.get(keyMainState(mode))) || {};
    const nextState = {};

    const funnel = { entry: [], almost: [], buildup: [], radar: [] };

    for (const coin of tradable) {
      const sym = up(coin.symbol);
      const prev = prevState?.[sym] || {};

      const marketCap = n(coin.marketCap, 0);
      const volume = n(coin.volume, 0);
      const change24 = n(coin.change24, 0);
      const change1h = n(coin.change1h, 0);
      const range24 = n(coin.range24, 0);
      const vm = CORE.computeVm(volume, marketCap);

      const priceHist = Array.isArray(prev?.priceHist) ? [...prev.priceHist] : [];
      const volHist = Array.isArray(prev?.volHist) ? [...prev.volHist] : [];
      priceHist.push(n(coin.price, 0));
      volHist.push(volume);

      const priceHistNext = priceHist.slice(-120);
      const volHistNext = volHist.slice(-120);

      let volAcc = 1;
      if (volHistNext.length >= 6) {
        const nowVol = volHistNext[volHistNext.length - 1];
        const ago = volHistNext[volHistNext.length - 1 - 5] || nowVol;
        volAcc = nowVol / Math.max(ago, 1e-9);
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
          ? change1h >= n(dynRadar.dir1hMinBull, n(R.dir1hMinBull, 0)) &&
            change24 >= n(dynRadar.dir24MinBull, n(R.dir24MinBull, 0))
          : change1h <= n(dynRadar.dir1hMaxBear, n(R.dir1hMaxBear, 0)) &&
            change24 <= n(dynRadar.dir24MaxBear, n(R.dir24MaxBear, 0)));

      let stage = "RADAR";

      const buildupOk = radarOk && volAcc >= n(CFG.buildup?.minVolAcc, 1.0);
      if (buildupOk) stage = "BUILDUP";

      let flat60Pct = 999;
      if (priceHistNext.length >= 10) {
        const tail = priceHistNext.slice(-60);
        const hi = Math.max(...tail.map((x) => n(x, 0)));
        const lo = Math.min(...tail.map((x) => n(x, 0)));
        flat60Pct = lo > 0 ? ((hi - lo) / lo) * 100 : 999;
      }

      const confidence = CORE.computeConfidence({ vm, change24, range24, obValid: false });

      const almostOk =
        buildupOk &&
        confidence >= n(CFG.almost?.minConfidence, 0) &&
        flat60Pct <= n(CFG.almost?.maxFlat60Pct, 999);

      if (almostOk) stage = "ALMOST";

      let ob = null;
      let entryOk = false;
      let entryReason = "";
      let obSlope = { ok: true, slope: 0, reason: "disabled" };
      let spreadOk = false;
      let depthOk = false;
      let scoreOk = false;
      let confOk = false;
      let dynThr = null;

      if (stage === "ALMOST") {
        ob = await fetchOrderbook(`${sym}USDT`);
        const entryCfg = CFG.entry || {};

        const samplesKey = `main:ob:samples:${mode}:${sym}`;
        const prevSamples = (await kv.get(samplesKey)) || [];
        const samplesArr = Array.isArray(prevSamples) ? prevSamples : [];

        if (ob?.valid) {
          samplesArr.push({
            ts: now,
            score: n(ob.score, 0),
            spreadPct: n(ob.spreadPct, 999),
            depthMinUsd1p: n(ob.depthMinUsd1p, 0),
          });
        }

        const trimmed = samplesArr.slice(-Math.max(2, n(entryCfg.samplesMax, 24)));
        await kv.set(samplesKey, trimmed, { ex: n(entryCfg.samplesTtlSec, 3600) });

        const tier = pickTier(marketCap, entryCfg);
        const baseThr = {
          minConfidence: n(tier?.minConf, n(entryCfg.minConfidence, 40)),
          spreadMaxPct: n(tier?.spreadMax, n(entryCfg.spreadMaxPct, 1.8)),
          depthMinUsd1p: n(tier?.depth1pMin, n(entryCfg.depthMinUsd1p, 11_000)),
          obScoreMin: n(tier?.obScoreMin, n(entryCfg.obScoreMin, 0.02)),
        };

        dynThr = CORE.dynamicEntryThresholds({ marketCap, volume, vm }, baseThr, CFG);

        spreadOk = ob?.valid ? n(ob.spreadPct, 999) <= n(dynThr.spreadMaxPct, 999) : false;
        depthOk = ob?.valid ? n(ob.depthMinUsd1p, 0) >= n(dynThr.depthMinUsd1p, 0) : false;

        const score = n(ob?.score, 0);
        scoreOk =
          ob?.valid
            ? mode === "bull"
              ? score >= n(dynThr.obScoreMin, 0)
              : score <= -n(dynThr.obScoreMin, 0)
            : false;

        obSlope = CORE.checkObSlopeGate({ stage: "entry", mode, obSamples: trimmed, settings: CFG });
        confOk = confidence >= n(dynThr.minConfidence, n(entryCfg.minConfidence, 0));

        // Macro mode based extra restrictions
        let macroEntryOk = true;
        if (macroMode === "SELECTIVE") {
          const selectiveConfOk = confidence >= (n(dynThr.minConfidence, n(entryCfg.minConfidence, 0)) + 4);
          const selectiveSpreadOk = ob?.valid ? n(ob.spreadPct, 999) <= Math.min(n(dynThr.spreadMaxPct, 999), 1.25) : false;
          const selectiveScoreOk =
            ob?.valid
              ? mode === "bull"
                ? score >= (n(dynThr.obScoreMin, 0) + 0.004)
                : score <= -(n(dynThr.obScoreMin, 0) + 0.004)
              : false;
          macroEntryOk = selectiveConfOk && selectiveSpreadOk && selectiveScoreOk;
        }
        if (macroMode === "RESTRICTIVE") {
          macroEntryOk = false;
        }

        entryOk = spreadOk && depthOk && scoreOk && confOk && obSlope.ok && macroEntryOk;

        if (!ob?.valid) entryReason = "no_ob";
        else if (!confOk) entryReason = "conf_low";
        else if (!spreadOk) entryReason = "spread";
        else if (!depthOk) entryReason = "depth";
        else if (!scoreOk) entryReason = "ob_score";
        else if (!obSlope.ok) entryReason = "ob_slope";
        else if (!macroEntryOk) entryReason = "macro_selective";
        else entryReason = "ok";

        if (entryOk) stage = "ENTRY";
      }

      const compression = {
        isCompressed: flat60Pct <= n(CFG.almost?.maxFlat60Pct, 999),
        flatPct: Number(n(flat60Pct, 0).toFixed(3)),
      };

      const breakout = {
        ready: stage === "ENTRY",
        pressure: stage === "ENTRY" ? 60 : stage === "ALMOST" ? 48 : 0,
        breakoutPct: 0,
      };

      const thresholds = {
        depthFloorUsd: stage === "ENTRY" && dynThr ? n(dynThr.depthMinUsd1p, 0) : 0,
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

      const scannerGate = gateFromStage(stage);

      const engineCoin = {
        id: coin.id,
        symbol: sym,
        name: coin.name || "",
        image: coin.image || "",
        side: sideFromMode(mode),
        price: n(coin.price, 0),
        marketCap,
        volume,
        change24,
        change1h,
        range24,
        vm,
        confidence,
        entryQuality: confidence,
        persistenceScore: Math.round(Math.max(0, Math.min(100, confidence * 0.85 + Math.min(volAcc * 10, 12)))),
        stage,
        stageWhy: entryOk ? "entry_ok" : stage === "ALMOST" ? "almost_ready" : stage === "BUILDUP" ? "momentum_building" : "radar_only",
        ob: ob
          ? {
              bestBid: n(ob.bestBid, 0),
              bestAsk: n(ob.bestAsk, 0),
              spreadPct: Number(n(ob.spreadPct, 999).toFixed(4)),
              depthMinUsd1p: Math.round(n(ob.depthMinUsd1p, 0)),
              score: Number(n(ob.score, 0).toFixed(6)),
              valid: !!ob.valid,
              fresh: !!ob.fresh,
              stale: !!ob.stale,
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
        volAcc: { short: Number(volAcc.toFixed(3)), medium: Number(volAcc.toFixed(3)) },
        tradePlan,
        scannerGate,
        tradeDeskStatus: scannerGate,
        qualityScore: confidence,
        liquidityScore: ob?.valid ? Math.max(0, Math.min(100, 55 + (n(ob.score, 0) * 100) / 2 - Math.max(0, n(ob.spreadPct, 0) - 0.8) * 8)) : 35,
        timingScore: stage === "ENTRY" ? 82 : stage === "ALMOST" ? 68 : stage === "BUILDUP" ? 54 : 35,
        marketScore: regime === "EXPANSION" ? 82 : regime === "TREND" ? 70 : regime === "HEADWIND" ? 35 : 50,
        perfectCandidateScore: stage === "ENTRY" ? 78 : stage === "ALMOST" ? 66 : stage === "BUILDUP" ? 52 : 30,
        tradeCandidate: stage === "ENTRY",
        superScannerCoin: stage === "ENTRY",
        scannerOnly: stage !== "ENTRY",
        entry: {
          ok: !!entryOk,
          reason: entryReason,
          slopeOk: !!obSlope?.ok,
          slope: Number(n(obSlope?.slope, 0).toFixed(8)),
        },
        flat60Pct: Number(n(flat60Pct, 0).toFixed(3)),
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
        positionState: {
          inPosition: false,
          cyclesInTrade: 0,
          minHoldCycles: 5,
          weakHoldCount: 0,
          maxWeakHoldCycles: 2,
        },
        scannerGate,
      });

      const outCoin = {
        ...engineCoin,
        coinProfile,
        execution,
      };

      nextState[sym] = {
        symbol: sym,
        stage,
        lastSeen: now,
        side: sideFromMode(mode),
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
        entryQuality: engineCoin.entryQuality,
        persistenceScore: engineCoin.persistenceScore,
        ob: outCoin.ob,
        thresholds,
        breakout,
        compression,
        tradePlan,
        scannerGate,
        tradeDeskStatus: scannerGate,
        execution,
        coinProfile,
        entry: engineCoin.entry,
        priceHist: priceHistNext,
        volHist: volHistNext,
      };

      if (stage === "ENTRY") funnel.entry.push(outCoin);
      else if (stage === "ALMOST") funnel.almost.push(outCoin);
      else if (stage === "BUILDUP") funnel.buildup.push(outCoin);
      else funnel.radar.push(outCoin);

      const oldStage = up(prev?.stage || "RADAR");

      if (stage !== oldStage && stage !== "RADAR") {
        const isUpgrade =
          (oldStage === "RADAR" && (stage === "BUILDUP" || stage === "ALMOST" || stage === "ENTRY")) ||
          (oldStage === "BUILDUP" && (stage === "ALMOST" || stage === "ENTRY")) ||
          (oldStage === "ALMOST" && stage === "ENTRY");

        if (isUpgrade) {
          console.log(`[Scanner] 🚀 Upgrade voor ${sym}: ${oldStage} -> ${stage}. Discord aanroepen...`);

          await sendSignal({
            source: "main",   // FIXED: was "scanner"
            stage,
            mode,
            coin: outCoin,
            btcState: btc.state,
            kind: "signal",
          }).catch((err) => console.error("Discord send error:", err));
        }
      }

      await sleep(6);
    }

    const byConf = (a, b) => n(b.execution?.score, n(b.confidence, 0)) - n(a.execution?.score, n(a.confidence, 0));

    funnel.entry.sort(byConf);
    funnel.almost.sort(byConf);
    funnel.buildup.sort(byConf);
    funnel.radar.sort(byConf);

    funnel.entry = funnel.entry.slice(0, n(CFG.ENTRY_LIMIT, 12));
    funnel.almost = funnel.almost.slice(0, n(CFG.ALMOST_LIMIT, 25));
    funnel.buildup = funnel.buildup.slice(0, n(CFG.BUILDUP_LIMIT, 40));
    funnel.radar = funnel.radar.slice(0, n(CFG.RADAR_LIMIT, 80));

    const latest = {
      ok: true,
      mode,
      regime,
      btc,
      funnel,
      counts: {
        entry: funnel.entry.length,
        almost: funnel.almost.length,
        buildup: funnel.buildup.length,
        radar: funnel.radar.length,
      },
      ts: now,
      scannedAt: now,
      meta: {
        scanLock: { active: false, until: null },
        trigger: isVercelCron ? "vercel_cron" : tokenOk ? "cron_token" : "manual_secret",
        cg: {
          coinsFetched: rawCoins.length,
          tradable: tradable.length,
          usedCache: !!cgMeta.usedCache,
          partial: !!cgMeta.partial,
          rateLimited: !!cgMeta.rateLimited,
        },
      },
    };

    await kv.set(keyMainState(mode), nextState, { ex: 60 * 60 * 24 * 3 });
    await kv.set(keyMainLatest(mode), latest, { ex: 60 * 60 });

    res.status(200).json(latest);
  } catch (err) {
    console.error("scan error:", err);
    res.status(500).json({
      ok: false,
      error: err?.message || String(err),
      status: err?.status || null,
      retryAfter: err?.retryAfter || null,
    });
  } finally {
    if (lockAcquired) await releaseScanLock(mode);
  }
}