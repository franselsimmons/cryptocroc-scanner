// api/scan.js
import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG } from "../lib/_runtime.js";

export const config = RUNTIME_CONFIG;

const BITGET_OB = "https://api.bitget.com/api/v2/spot/market/orderbook";
const BITGET_SYMBOLS = "https://api.bitget.com/api/v2/spot/public/symbols";

// CoinGecko
const CG_MARKETS = "https://api.coingecko.com/api/v3/coins/markets";

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
        // Small but helpful: CG sometimes rate-limits harder without UA.
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
// ✅ Secret gate (no dependency on moon core)
// - Allows Vercel cron OR valid token OR manual secret
// ======================================================
function requireSecret(req, res) {
  const qToken = String(req.query?.token || "");
  const bearer = String(req.headers?.authorization || "");
  const headerToken = bearer.toLowerCase().startsWith("bearer ")
    ? bearer.slice(7).trim()
    : "";

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
// ✅ CoinGecko caching strategy (prevents 429 crashes)
// - cache pages (short TTL)
// - cache full snapshot (longer TTL)
// - on 429: use cached snapshot (stale allowed)
// ======================================================
const KV_CG_TOP = "main:cg:top:v1";
const KV_CG_BTC = "main:cg:btc:v1";
const KV_CG_PAGE_PREFIX = "main:cg:markets:v1:page:";

// TTLs
const CG_PAGE_TTL_SEC = 60 * 5;   // 5 min
const CG_TOP_TTL_SEC = 60 * 12;   // 12 min (safe under 30m cron)
const CG_BTC_TTL_SEC = 60 * 5;    // 5 min

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
    change24: n(
      c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h,
      0
    ),
    change1h: n(
      c.price_change_percentage_1h_in_currency ?? c.price_change_percentage_1h,
      0
    ),
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

async function fetchCoinGeckoTopFresh(maxCoins = 1500) {
  const perPage = 250;
  const maxPages = Math.max(1, Math.ceil(maxCoins / perPage)); // usually 6
  const out = [];
  const meta = { usedCache: false, partial: false, rateLimited: false };

  for (let page = 1; page <= maxPages; page++) {
    try {
      const rows = await fetchCoinGeckoMarketsPage(page, perPage);
      if (!rows.length) break;

      out.push(...rows);

      // cache this page
      await kv.set(`${KV_CG_PAGE_PREFIX}${page}`, rows, { ex: CG_PAGE_TTL_SEC });

      // small delay to reduce burst
      await sleep(250);

      if (out.length >= maxCoins) break;
    } catch (e) {
      const status = Number(e?.status || 0);
      if (status === 429) {
        meta.rateLimited = true;

        // If we already have some rows, return partial (better than failing)
        if (out.length > 0) {
          meta.partial = true;
          return { coins: out.slice(0, maxCoins), meta };
        }

        // No rows yet: try cached pages first
        const cachedCoins = [];
        for (let p = 1; p <= maxPages; p++) {
          const cachedPage = await kv.get(`${KV_CG_PAGE_PREFIX}${p}`);
          if (Array.isArray(cachedPage) && cachedPage.length) {
            cachedCoins.push(...cachedPage);
          }
          if (cachedCoins.length >= maxCoins) break;
        }

        if (cachedCoins.length) {
          meta.usedCache = true;
          meta.partial = cachedCoins.length < maxCoins;
          return { coins: cachedCoins.slice(0, maxCoins), meta };
        }

        // Last resort: full snapshot cache
        const snap = await kv.get(KV_CG_TOP);
        if (Array.isArray(snap) && snap.length) {
          meta.usedCache = true;
          meta.partial = snap.length < maxCoins;
          return { coins: snap.slice(0, maxCoins), meta };
        }

        // If nothing cached at all, return empty but do not crash hard
        return { coins: [], meta };
      }

      // non-429 error: if we already have partial, return it
      if (out.length > 0) {
        meta.partial = true;
        return { coins: out.slice(0, maxCoins), meta };
      }

      throw e;
    }
  }

  return { coins: out.slice(0, maxCoins), meta };
}

async function fetchCoinGeckoTopCached(maxCoins = 1500) {
  // Try fresh first
  try {
    const fresh = await fetchCoinGeckoTopFresh(maxCoins);

    if (Array.isArray(fresh.coins) && fresh.coins.length) {
      // cache full snapshot (even if partial – still useful)
      await kv.set(KV_CG_TOP, fresh.coins, { ex: CG_TOP_TTL_SEC });
      return { coins: fresh.coins, meta: fresh.meta };
    }

    // If fresh returned empty, fallback to cached snapshot
    const snap = await kv.get(KV_CG_TOP);
    if (Array.isArray(snap) && snap.length) {
      return { coins: snap.slice(0, maxCoins), meta: { usedCache: true, partial: false, rateLimited: false } };
    }

    return { coins: [], meta: { usedCache: false, partial: false, rateLimited: false } };
  } catch (e) {
    // fallback to cached snapshot on any error
    const snap = await kv.get(KV_CG_TOP);
    if (Array.isArray(snap) && snap.length) {
      return { coins: snap.slice(0, maxCoins), meta: { usedCache: true, partial: false, rateLimited: false, _err: String(e?.message || e) } };
    }
    throw e;
  }
}

// ======================================================
// ✅ BTC snapshot (cache + 429 safe)
// ======================================================
async function fetchBTCGateFromUniverse() {
  // Try fresh
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
    const status = Number(e?.status || 0);
    if (status === 429) {
      // fallback cache
      const cached = await kv.get(KV_CG_BTC);
      if (cached && typeof cached === "object") return cached;
      return { price: 0, chg24: 0, chg1h: 0, range24: 0, state: "NEUTRAL", _err: "btc_429_no_cache" };
    }
    // fallback cache on any error
    const cached = await kv.get(KV_CG_BTC);
    if (cached && typeof cached === "object") return cached;
    return { price: 0, chg24: 0, chg1h: 0, range24: 0, state: "NEUTRAL", _err: String(e?.message || e) };
  }
}

// ======================================================
// ✅ Bitget USDT symbols set (no dependency)
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
      status: "ok",
      reason: "",
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
// ✅ scan lock (30m boundaries: :00 / :30)
// ======================================================
function scanLockKey(mode) {
  return `main:scan:lock:${String(mode || "bull").toLowerCase()}`;
}
async function acquireScanLock(mode) {
  const key = scanLockKey(mode);
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
    await kv.del(scanLockKey(mode));
  } catch {}
}

// ======================================================
// Main scan (uses ONLY core_bull / core_bear)
// ======================================================
export default async function handler(req, res) {
  let mode = "bull";
  let lockAcquired = false;

  try {
    // ✅ allow cron by header OR by token
    const isVercelCron = String(req.headers?.["x-vercel-cron"] || "") === "1";
    const tokenOk =
      process.env.CRON_SECRET &&
      String(req.query?.token || "") === String(process.env.CRON_SECRET);

    if (!isVercelCron && !tokenOk) {
      if (!requireSecret(req, res)) return;
    }

    mode = String(req.query?.mode || "bull").toLowerCase() === "bear" ? "bear" : "bull";

    // ✅ ONLY main cores
    const CORE =
      mode === "bear"
        ? await import("../lib/_core_bear.js")
        : await import("../lib/_core_bull.js");

    const CFG = CORE.getCfg();

    const lock = await acquireScanLock(mode);
    if (!lock.ok) {
      const latest = await kv.get(CORE.keyLatest(mode));
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
      return res.end(
        JSON.stringify({ ok: true, skipped: true, reason: "scan_lock_active", mode, until: lock.until || null })
      );
    }
    lockAcquired = true;

    const now = Date.now();

    // BTC snapshot (safe)
    const btcRaw = await fetchBTCGateFromUniverse();
    const btc = {
      price: n(btcRaw?.price, 0),
      chg24: n(btcRaw?.chg24, 0),
      chg1h: n(btcRaw?.chg1h, 0),
      range24: n(btcRaw?.range24, 0),
      state: CORE.computeBtcState(btcRaw, CFG),
    };

    // Universe + Bitget symbols (CG cache-first)
    const cg = await fetchCoinGeckoTopCached(Number(CFG.CG_TOP || 1500));
    const rawCoins = Array.isArray(cg?.coins) ? cg.coins : [];
    const cgMeta = cg?.meta || {};

    const bitgetSymbols = await getBitgetSpotUsdtSymbols();
    const tradable = rawCoins
      .filter((c) => bitgetSymbols.has(up(c.symbol)))
      .slice(0, Number(CFG.CG_TOP || 1500));

    // State for histories
    const prevState = (await kv.get(CORE.keyState(mode))) || {};
    const nextState = {};

    // Funnels
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

      // histories
      const priceHist = Array.isArray(prev?.priceHist) ? [...prev.priceHist] : [];
      const volHist = Array.isArray(prev?.volHist) ? [...prev.volHist] : [];
      priceHist.push(n(coin.price, 0));
      volHist.push(volume);

      const priceHistNext = priceHist.slice(-120);
      const volHistNext = volHist.slice(-120);

      // volAcc short (now vs 5 samples ago)
      let volAcc = 1;
      if (volHistNext.length >= 6) {
        const nowVol = volHistNext[volHistNext.length - 1];
        const ago = volHistNext[volHistNext.length - 1 - 5] || nowVol;
        volAcc = nowVol / Math.max(ago, 1e-9);
      }

      // radar dyn thresholds
      const dynRadar = CORE.dynamicRadarThresholds(range24, CFG);

      // RADAR gate
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

      // BUILDUP gate
      const buildupOk = radarOk && volAcc >= n(CFG.buildup?.minVolAcc, 1.0);
      if (buildupOk) stage = "BUILDUP";

      // ALMOST gate
      let flat60Pct = 999;
      if (priceHistNext.length >= 10) {
        const tail = priceHistNext.slice(-60);
        const hi = Math.max(...tail.map((x) => n(x, 0)));
        const lo = Math.min(...tail.map((x) => n(x, 0)));
        flat60Pct = lo > 0 ? ((hi - lo) / lo) * 100 : 999;
      }

      const confidence = CORE.computeConfidence({
        vm,
        change24,
        range24,
        obValid: false,
      });

      const almostOk =
        buildupOk &&
        confidence >= n(CFG.almost?.minConfidence, 0) &&
        flat60Pct <= n(CFG.almost?.maxFlat60Pct, 999);

      if (almostOk) stage = "ALMOST";

      // ENTRY gate (OB)
      let ob = null;
      let entryOk = false;
      let entryReason = "";
      let obSlope = { ok: true, slope: 0, reason: "disabled" };

      if (stage === "ALMOST") {
        ob = await fetchOrderbook(`${sym}USDT`);
        const entryCfg = CFG.entry || {};

        // persist samples
        const samplesKey = CORE.keyObSamples(mode, sym);
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

        // tier thresholds
        const tier = pickTier(marketCap, entryCfg);
        const baseThr = {
          minConfidence: n(tier?.minConf, n(entryCfg.minConfidence, 40)),
          spreadMaxPct: n(tier?.spreadMax, n(entryCfg.spreadMaxPct, 1.8)),
          depthMinUsd1p: n(tier?.depth1pMin, n(entryCfg.depthMinUsd1p, 11_000)),
          obScoreMin: n(tier?.obScoreMin, n(entryCfg.obScoreMin, 0.02)),
        };

        // dynamic adjust (liq-adaptive)
        const dynThr = CORE.dynamicEntryThresholds({ marketCap, volume, vm }, baseThr, CFG);

        const spreadOk = ob?.valid ? n(ob.spreadPct, 999) <= n(dynThr.spreadMaxPct, 999) : false;
        const depthOk = ob?.valid ? n(ob.depthMinUsd1p, 0) >= n(dynThr.depthMinUsd1p, 0) : false;

        const score = n(ob?.score, 0);
        const scoreOk =
          ob?.valid
            ? mode === "bull"
              ? score >= n(dynThr.obScoreMin, 0)
              : score <= -n(dynThr.obScoreMin, 0)
            : false;

        obSlope = CORE.checkObSlopeGate({ stage: "entry", mode, obSamples: trimmed, settings: CFG });

        const confOk = confidence >= n(dynThr.minConfidence, n(entryCfg.minConfidence, 0));

        entryOk = spreadOk && depthOk && scoreOk && confOk && obSlope.ok;

        if (!ob?.valid) entryReason = "no_ob";
        else if (!confOk) entryReason = "conf_low";
        else if (!spreadOk) entryReason = "spread";
        else if (!depthOk) entryReason = "depth";
        else if (!scoreOk) entryReason = "ob_score";
        else if (!obSlope.ok) entryReason = "ob_slope";
        else entryReason = "ok";

        if (entryOk) stage = "ENTRY";
      }

      nextState[sym] = {
        symbol: sym,
        stage,
        lastSeen: now,
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
        ob: ob
          ? {
              spreadPct: Number(n(ob.spreadPct, 999).toFixed(4)),
              depthMinUsd1p: Math.round(n(ob.depthMinUsd1p, 0)),
              score: Number(n(ob.score, 0).toFixed(6)),
              valid: !!ob.valid,
            }
          : null,
        entry: {
          ok: !!entryOk,
          reason: entryReason,
          slopeOk: !!obSlope?.ok,
          slope: Number(n(obSlope?.slope, 0).toFixed(8)),
        },
        priceHist: priceHistNext,
        volHist: volHistNext,
      };

      const outCoin = {
        id: coin.id,
        symbol: sym,
        name: coin.name || "",
        image: coin.image || "",
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
        ob: nextState[sym].ob,
        entry: nextState[sym].entry,
        stage,
      };

      if (stage === "ENTRY") funnel.entry.push(outCoin);
      else if (stage === "ALMOST") funnel.almost.push(outCoin);
      else if (stage === "BUILDUP") funnel.buildup.push(outCoin);
      else funnel.radar.push(outCoin);

      // keep overall runtime sane
      await sleep(6);
    }

    const byConf = (a, b) => n(b.confidence, 0) - n(a.confidence, 0);
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
        cfg: {
          radar: CFG.radar,
          buildup: CFG.buildup,
          almost: CFG.almost,
          entry: {
            samplesNeed: CFG.entry?.samplesNeed,
            minConfidence: CFG.entry?.minConfidence,
            obScoreMin: CFG.entry?.obScoreMin,
            spreadMaxPct: CFG.entry?.spreadMaxPct,
            depthMinUsd1p: CFG.entry?.depthMinUsd1p,
          },
          btc: CFG.btc,
        },
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

    await kv.set(CORE.keyState(mode), nextState, { ex: 60 * 60 * 24 * 3 });
    await kv.set(CORE.keyLatest(mode), latest, { ex: 60 * 60 });

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