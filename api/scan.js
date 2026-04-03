// api/scan.js
import { kv } from "@vercel/kv";

import {
  RUNTIME_CONFIG,
  requireSecret,
  fetchBTCGateFromUniverse,
  fetchCoinGeckoTopCached,
  getBitgetSpotUsdtSymbols,
} from "../lib/_moon_core.js";

export const config = RUNTIME_CONFIG;

const BITGET_OB = "https://api.bitget.com/api/v2/spot/market/orderbook";

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

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(id);
  }
}

async function fetchOrderbook(symbol) {
  try {
    const url = `${BITGET_OB}?symbol=${symbol}&type=step0&limit=20`;
    const j = await fetchJsonWithTimeout(url, { headers: { accept: "application/json" } }, 6500);
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
// scan lock (15m boundaries)
// ======================================================
function scanLockKey(mode) {
  return `scan:lock:${String(mode || "bull").toLowerCase()}`;
}
async function acquireScanLock(mode) {
  const key = scanLockKey(mode);
  const now = Date.now();
  const d = new Date(now);
  const next = new Date(d);
  next.setSeconds(0, 0);
  const m = d.getMinutes();
  if (m < 15) next.setMinutes(15);
  else if (m < 30) next.setMinutes(30);
  else if (m < 45) next.setMinutes(45);
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
// Main scan
// ======================================================
export default async function handler(req, res) {
  let mode = "bull";
  let lockAcquired = false;

  try {
    // ✅ Allow Vercel Cron without secret. Manual calls still require secret.
    const isVercelCron = String(req.headers["x-vercel-cron"] || "") === "1";
    if (!isVercelCron) {
      if (!requireSecret(req, res)) return;
    }

    mode = String(req.query?.mode || "bull").toLowerCase() === "bear" ? "bear" : "bull";

    // ✅ load correct core by mode
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
            },
          })
        );
      }
      return res.end(JSON.stringify({ ok: true, skipped: true, reason: "scan_lock_active", mode }));
    }
    lockAcquired = true;

    const now = Date.now();

    // btc snapshot
    const btcRaw = await fetchBTCGateFromUniverse();
    const btc = {
      price: n(btcRaw?.price, 0),
      chg24: n(btcRaw?.chg24, 0),
      chg1h: n(btcRaw?.chg1h, 0),
      range24: n(btcRaw?.range24, 0),
      state: CORE.computeBtcState(btcRaw, CFG),
    };

    // universe
    const rawCoins = await fetchCoinGeckoTopCached();
    const bitgetSymbols = await getBitgetSpotUsdtSymbols();

    const tradable = rawCoins
      .filter((c) => bitgetSymbols.has(up(c.symbol)))
      .slice(0, Number(CFG.CG_TOP || 1500));

    // state for histories
    const prevState = (await kv.get(CORE.keyState(mode))) || {};
    const nextState = {};

    // funnels
    const funnel = { entry: [], almost: [], buildup: [], radar: [] };

    // ========== stage pipeline ==========
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

      // ========= RADAR gate =========
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

      // ========= BUILDUP gate =========
      const buildupOk = radarOk && volAcc >= n(CFG.buildup?.minVolAcc, 1.0);
      if (buildupOk) stage = "BUILDUP";

      // ========= ALMOST gate =========
      // flatness proxy: use last 60 points range%
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

      // ========= ENTRY gate (OB) =========
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

        // OB score direction:
        // bull: wants positive score
        // bear: wants negative score (we use abs check + sign)
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

      // store state
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

      // push into funnel
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
      };

      if (stage === "ENTRY") funnel.entry.push(outCoin);
      else if (stage === "ALMOST") funnel.almost.push(outCoin);
      else if (stage === "BUILDUP") funnel.buildup.push(outCoin);
      else funnel.radar.push(outCoin);

      await sleep(6);
    }

    // sort best-first (confidence)
    const byConf = (a, b) => n(b.confidence, 0) - n(a.confidence, 0);
    funnel.entry.sort(byConf);
    funnel.almost.sort(byConf);
    funnel.buildup.sort(byConf);
    funnel.radar.sort(byConf);

    // apply limits
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
        // keep it small
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
        trigger: isVercelCron ? "vercel_cron" : "manual_secret",
      },
    };

    // persist
    await kv.set(CORE.keyState(mode), nextState, { ex: 60 * 60 * 24 * 3 });
    await kv.set(CORE.keyLatest(mode), latest, { ex: 60 * 60 });

    res.status(200).json(latest);
  } catch (err) {
    console.error("scan error:", err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  } finally {
    if (lockAcquired) await releaseScanLock(mode);
  }
}