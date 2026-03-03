import { kv } from "@vercel/kv";
import { createHash } from "crypto";
import { RUNTIME_CONFIG, requireSecret, getMode } from "../lib/_runtime.js";
import { pushEvent } from "../lib/_analytics.js";
import { getObSnapshot, obMapKey } from "../lib/obStore.js";

export const config = RUNTIME_CONFIG;

// ======================================================
// ✅ 30 MIN SCAN LOCK (ATOMISCH)
// ======================================================
const SCAN_INTERVAL_SEC = 30 * 60; // 30 minuten

// ======================================================
// ✅ Design rationale (voor transparantie)
// ======================================================
const DESIGN_RATIONALE = [
  "Zonder coin-typische momentum en zonder consistency-blokkade krijg je bij 30m cadence te veel false positives (micro moves, random spikes, liquidity noise).",
  "OB gates zijn goed, maar spread/score zijn coin-dependent → daarom percentiles.",
].join(" ");

// ---------- hulpfunctie voor null-safe getallen ----------
function fnum(x) {
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  return res.end(JSON.stringify(obj));
}

async function tryAcquireScanLock(mode) {
  const key = `scan:lock:${String(mode).toLowerCase()}`;
  const now = Date.now();
  const nextUntil = now + SCAN_INTERVAL_SEC * 1000;

  // Atomisch: alleen lock zetten als hij niet bestaat (NX)
  const ok = await kv.set(key, { until: nextUntil, setAt: now }, { nx: true, ex: SCAN_INTERVAL_SEC });

  if (ok) {
    return { ok: true, key, until: nextUntil, now, waitMs: 0 };
  }

  // Lock bestond al → lees huidige
  const cur = await kv.get(key);
  const until = Number(cur?.until || 0);

  if (until > now) {
    return { ok: false, key, until, now, waitMs: until - now };
  }

  // Edge case: lock is “stale” maar key bestaat nog (bijv. KV glitch) → force refresh
  await kv.set(key, { until: nextUntil, setAt: now }, { ex: SCAN_INTERVAL_SEC });
  return { ok: true, key, until: nextUntil, now, waitMs: 0 };
}

// --------------------
// Helpers
// --------------------
function cgKey(url) {
  const h = createHash("sha1").update(String(url || "")).digest("hex");
  return `cg:${h}`;
}

// ✅ CoinGecko KV cache (anti-429)
const CG_FRESH_TTL_SEC = 60;
const CG_STALE_TTL_SEC = 10 * 60;

async function fetchJson(url) {
  const key = cgKey(url);
  const staleKey = `${key}:stale`;

  const cached = await kv.get(key);
  if (cached) return cached;

  const r = await fetch(url, { headers: { accept: "application/json" } });
  const t = await r.text();

  if (r.status === 429) {
    const stale = await kv.get(staleKey);
    if (stale) return stale;
    throw new Error(`Fetch failed 429: ${t.slice(0, 220)}`);
  }

  let j = null;
  try {
    j = JSON.parse(t);
  } catch {}

  if (!r.ok) throw new Error(`Fetch failed ${r.status}: ${t.slice(0, 160)}`);

  await kv.set(key, j, { ex: CG_FRESH_TTL_SEC });
  await kv.set(staleKey, j, { ex: CG_STALE_TTL_SEC });

  return j;
}

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}
function safeObj(x) {
  return x && typeof x === "object" ? x : null;
}
function up(x) {
  return String(x || "").toUpperCase();
}

async function safePushEvent(funnel, data) {
  try {
    await pushEvent(funnel, data);
  } catch {}
}

// ✅ OB max age (stale gate)
const OB_MAX_AGE_MS = 120 * 60 * 1000;
const OB_MAX_AGE_SEC = Math.floor(OB_MAX_AGE_MS / 1000);

// ======================================================
// ✅ Per-coin rolling medians & percentiles (range/spread/obScore)
// ======================================================
const COIN_STATS_TTL_SEC = 60 * 60 * 24 * 8;       // 8 dagen bewaren
const COIN_STATS_WINDOW_SEC = 60 * 60 * 24 * 7;    // 7 dagen window
const COIN_STATS_KEEP_MAX = 700;                   // hard cap (7d @ 15m/30m safe)

function kCoinStats(mode, sym) {
  return `coin:stats:${String(mode).toLowerCase()}:${String(sym).toUpperCase()}`;
}

function medianOf(nums) {
  const a = (Array.isArray(nums) ? nums : []).map(Number).filter(Number.isFinite);
  if (!a.length) return null;
  a.sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// p in [0..100], e.g. 70 => 70e percentiel
function percentileOf(nums, p) {
  const a = (Array.isArray(nums) ? nums : []).map(Number).filter(Number.isFinite);
  if (!a.length) return null;
  const q = Math.max(0, Math.min(100, Number(p))) / 100;
  a.sort((x, y) => x - y);
  const idx = (a.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return a[lo];
  const w = idx - lo;
  return a[lo] * (1 - w) + a[hi] * w;
}

async function updateCoinStatsAndGetMetrics({ mode, sym, range24, spreadPct, obScore, now }) {
  const key = kCoinStats(mode, sym);
  const prev = (await kv.get(key)) || [];
  const arr = Array.isArray(prev) ? prev : [];

  const cutoff = now - COIN_STATS_WINDOW_SEC * 1000;

  const r = fnum(range24);
  const sp = fnum(spreadPct);
  const sc = fnum(obScore);

  const row = { ts: now };
  if (r != null) row.range24 = r;
  if (sp != null) row.spreadPct = sp;
  if (sc != null) {
    row.obScore = sc;
    row.obScoreAbs = Math.abs(sc);
  }

  const next = arr
    .filter((x) => Number(x?.ts || 0) >= cutoff)
    .concat([row])
    .slice(-COIN_STATS_KEEP_MAX);

  await kv.set(key, next, { ex: COIN_STATS_TTL_SEC });

  const ranges = next.map((x) => x?.range24).filter(Number.isFinite);
  const spreads = next.map((x) => x?.spreadPct).filter(Number.isFinite);
  const scoresAbs = next.map((x) => x?.obScoreAbs).filter(Number.isFinite);

  return {
    samples: next.length,
    medRange24: medianOf(ranges),
    p80Range24: percentileOf(ranges, 80),
    medSpreadPct: medianOf(spreads),
    p80SpreadPct: percentileOf(spreads, 80),
    medObAbs: medianOf(scoresAbs),
    p60ObAbs: percentileOf(scoresAbs, 60),
    p70ObAbs: percentileOf(scoresAbs, 70),
    p80ObAbs: percentileOf(scoresAbs, 80),
  };
}

// ======================================================
// ✅ BTC fetch
// ======================================================
async function fetchBtc() {
  const url =
    "https://api.coingecko.com/api/v3/coins/markets" +
    "?vs_currency=usd&ids=bitcoin&order=market_cap_desc&per_page=1&page=1" +
    "&sparkline=false&price_change_percentage=1h,24h";

  const arr = await fetchJson(url);
  const b = arr?.[0] || {};

  const chg1h = n(b?.price_change_percentage_1h_in_currency ?? b?.price_change_percentage_1h ?? 0, 0);
  const chg24 = n(b?.price_change_percentage_24h_in_currency ?? b?.price_change_percentage_24h ?? 0, 0);

  const high = n(b?.high_24h, 0);
  const low = n(b?.low_24h, 0);
  const range24 = low > 0 ? ((high - low) / low) * 100 : 0;

  return {
    chg1h: +chg1h.toFixed(3),
    chg24: +chg24.toFixed(3),
    range24: +range24.toFixed(3),
  };
}

function normBtcState(x) {
  const s = String(x || "").toUpperCase().trim();
  if (s === "BULL" || s === "BEAR" || s === "NEUTRAL") return s;
  return "NEUTRAL";
}

function getBtcCfg(SETTINGS) {
  const b = SETTINGS && SETTINGS.btc ? SETTINGS.btc : {};
  return {
    bullMinChg24: Number.isFinite(Number(b.bullMinChg24)) ? Number(b.bullMinChg24) : 1.0,
    bearMaxChg24: Number.isFinite(Number(b.bearMaxChg24)) ? Number(b.bearMaxChg24) : -1.0,
    softOpenNeutral: !!b.softOpenNeutral,

    neutral24Pct: Number.isFinite(Number(b.neutral24Pct)) ? Number(b.neutral24Pct) : null,
    fine1hAbsPct: Number.isFinite(Number(b.fine1hAbsPct)) ? Number(b.fine1hAbsPct) : 0.25,
    confBoost: Number.isFinite(Number(b.confBoost)) ? Number(b.confBoost) : 4,
  };
}

function computeBtcStateCompat(btcBase, SETTINGS) {
  const cfg = getBtcCfg(SETTINGS);
  const chg24 = n(btcBase?.chg24, 0);

  if (cfg.neutral24Pct != null) {
    if (chg24 >= cfg.neutral24Pct) return "BULL";
    if (chg24 <= -cfg.neutral24Pct) return "BEAR";
    return "NEUTRAL";
  }

  if (chg24 >= cfg.bullMinChg24) return "BULL";
  if (chg24 <= cfg.bearMaxChg24) return "BEAR";
  return "NEUTRAL";
}

function btcConfidenceAdjustCompat(mode, btcState, btcBase, SETTINGS) {
  const cfg = getBtcCfg(SETTINGS);
  const st = normBtcState(btcState);

  if (st === "NEUTRAL" && cfg.softOpenNeutral) return { adj: 0, why: "BTC NEUTRAL (soft open)" };
  if (st === "NEUTRAL") return { adj: 0, why: "BTC NEUTRAL" };

  const fine1hAbs = cfg.fine1hAbsPct;
  const boost = cfg.confBoost;

  const chg1h = n(btcBase?.chg1h, 0);
  const wantUp = String(mode).toLowerCase() === "bull";

  const pos = chg1h >= fine1hAbs;
  const neg = chg1h <= -fine1hAbs;

  if (wantUp && pos) return { adj: +boost, why: `BTC 1h aligns (+${boost})` };
  if (!wantUp && neg) return { adj: +boost, why: `BTC 1h aligns (+${boost})` };

  if (wantUp && neg) return { adj: -boost, why: `BTC 1h contra (-${boost})` };
  if (!wantUp && pos) return { adj: -boost, why: `BTC 1h contra (-${boost})` };

  return { adj: 0, why: "BTC 1h small/neutral" };
}

function computeStageCap(mode, btcState) {
  const st = normBtcState(btcState);
  const m = String(mode || "").toLowerCase();

  let capStage = "BUILDUP";
  let allowFull = false;

  if (st === "BULL" && m === "bull") allowFull = true;
  if (st === "BEAR" && m === "bear") allowFull = true;

  if (allowFull) return { cap: false, capStage: "FULL", reason: `BTC ${st}: ${m} mag door naar ALMOST/ENTRY` };
  if (st === "NEUTRAL") return { cap: true, capStage, reason: "BTC NEUTRAL: scannen + OB door, maar max BUILDUP" };
  return { cap: true, capStage, reason: `BTC ${st}: ${m} blijft prep-mode (max BUILDUP)` };
}

// ======================================================
// ✅ Haal meerdere CoinGecko pagina's op
// ======================================================
async function fetchCgTop(limit = 1000) {
  const perPage = 250;
  const maxPages = 10;
  const pages = Math.min(maxPages, Math.ceil(limit / perPage));
  let allCoins = [];

  for (let page = 1; page <= pages; page++) {
    const url =
      `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd` +
      `&order=volume_desc&per_page=${perPage}&page=${page}&sparkline=false` +
      `&price_change_percentage=1h,24h`;

    const arr = await fetchJson(url);
    if (!arr || !Array.isArray(arr) || arr.length === 0) break;

    const mapped = arr.map((c) => {
      const price = n(c?.current_price, 0);
      const high = n(c?.high_24h, 0);
      const low = n(c?.low_24h, 0);
      const range24 = low > 0 ? ((high - low) / low) * 100 : 0;

      const change24 = n(c?.price_change_percentage_24h_in_currency ?? c?.price_change_percentage_24h ?? 0, 0);
      const change1h = n(c?.price_change_percentage_1h_in_currency ?? c?.price_change_percentage_1h ?? 0, 0);

      return {
        id: c?.id,
        symbol: up(c?.symbol),
        name: c?.name,
        price,
        volume: n(c?.total_volume, 0),
        marketCap: n(c?.market_cap, 0),
        change24,
        change1h,
        range24,
      };
    });

    allCoins = allCoins.concat(mapped);

    if (mapped.length < perPage) break;

    if (page < pages) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  return allCoins;
}

// ======================================================
// ✅ passRadar – gebruikt meegegeven dyn (geen eigen aanroep)
// ======================================================
function passRadar(core, mode, c, dyn) {
  const R = core?.SETTINGS?.radar || {};
  const vm = core.computeVm(c.volume, c.marketCap);

  // basis harde filters blijven
  if (c.marketCap < n(R.mcapMin, 0)) return { ok: false, why: "mcap too low" };
  if (c.marketCap > n(R.mcapMax, Number.MAX_SAFE_INTEGER)) return { ok: false, why: "mcap too high" };
  if (c.volume < n(R.volMin, 0)) return { ok: false, why: "volume too low" };
  if (vm < n(R.vmMin, 0)) return { ok: false, why: "vm too low" };
  if (Math.abs(c.change24) > n(R.maxAbsChg24, 999)) return { ok: false, why: "chg24 too high" };

  // ✅ gebruik de meegegeven dyn (of fallback naar vaste waarden)
  const maxRange = n(dyn?.maxRange24, n(R.maxRange24, 999));
  if (c.range24 > maxRange) return { ok: false, why: `range24 too high (> ${maxRange.toFixed(2)}%)` };

  const m = String(mode || "").toLowerCase();

  if (m === "bull") {
    const dir1hMin = n(dyn?.dir1hMinBull, n(R.dir1hMinBull, 0.2));
    const dir24Min = n(dyn?.dir24MinBull, n(R.dir24MinBull, 0.5));
    if (n(c.change1h, 0) < dir1hMin) return { ok: false, why: `dir fail 1h (< ${dir1hMin.toFixed(2)}%)` };
    if (n(c.change24, 0) < dir24Min) return { ok: false, why: `dir fail 24h (< ${dir24Min.toFixed(2)}%)` };
  } else if (m === "bear") {
    const dir1hMax = n(dyn?.dir1hMaxBear, n(R.dir1hMaxBear, -0.2));
    const dir24Max = n(dyn?.dir24MaxBear, n(R.dir24MaxBear, -0.5));
    if (n(c.change1h, 0) > dir1hMax) return { ok: false, why: `dir fail 1h (> ${dir1hMax.toFixed(2)}%)` };
    if (n(c.change24, 0) > dir24Max) return { ok: false, why: `dir fail 24h (> ${dir24Max.toFixed(2)}%)` };
  }

  return { ok: true, vm, dyn };
}

// ======================================================
// ✅ stageFromSwing – gebruikt dyn voor richting en range
// ======================================================
function stageFromSwing(mode, c, dyn) {
  const vm = c.vm;
  const range = c.range24;
  const ch1h = c.change1h;

  const wantUp = mode === "bull";

  const dir1h = wantUp
    ? n(dyn?.dir1hMinBull, 0.2)
    : n(dyn?.dir1hMaxBear, -0.2);

  const inDir = wantUp ? ch1h >= dir1h : ch1h <= dir1h;

  if (vm >= 0.24 && range <= (n(dyn?.maxRange24, 22)) && inDir) return "ALMOST";
  if (vm >= 0.18 && range <= (n(dyn?.maxRange24, 28) + 4)) return "BUILDUP";
  return "RADAR";
}

async function loadObMap(mode) {
  try {
    const m = await kv.hgetall(obMapKey(mode));
    return safeObj(m) || null;
  } catch {
    return null;
  }
}

async function getObForSymbol({ mode, symbol }) {
  const sym = up(symbol);
  const ob = await getObSnapshot(mode, sym, OB_MAX_AGE_SEC);
  return obSnapshotToFlat(ob, sym);
}

function obSnapshotToFlat(ob, sym) {
  const snap = safeObj(ob?.snap) || null;
  return {
    symbol: sym,
    ok: !!ob?.ok,
    valid: !!ob?.valid,
    fresh: !!ob?.fresh,
    stale: !!ob?.stale,
    reason: String(ob?.reason || ""),
    ageSec: ob?.ageSec ?? null,

    ts: n(snap?.ts, 0) || null,
    spreadPct: Number.isFinite(Number(snap?.spreadPct)) ? Number(snap.spreadPct) : null,
    depthMinUsd1p: Number.isFinite(Number(snap?.depthMinUsd1p)) ? Number(snap.depthMinUsd1p) : null,
    pressureDeltaUsd: Number.isFinite(Number(snap?.pressureDeltaUsd)) ? Number(snap.pressureDeltaUsd) : 0,
    score: Number.isFinite(Number(snap?.score)) ? Number(snap.score) : null,
  };
}

function adaptiveEntryThresholds(core, c, vm) {
  const base = core?.SETTINGS?.entry || {};
  const mc = n(c?.marketCap, 0);

  const tiers = Array.isArray(base?.adaptiveTiers) ? base.adaptiveTiers : null;

  const oneTier = {
    maxMc: Infinity,
    minConf: n(base.minConfidence, 60),
    spreadMax: n(base.spreadMaxPct, 0.95),
    depth1pMin: n(base.depthMinUsd1p, 45_000),
    obScoreMin: n(base.obScoreMin, 0.05),
  };

  const list = tiers?.length ? tiers : [oneTier];
  const t = list.find((x) => mc <= n(x.maxMc, Infinity)) || list[list.length - 1];

  const vmBonus = vm >= 0.8 ? 4 : vm >= 0.5 ? 2 : 0;

  const baseMinConf = n(base.minConfidence, n(t.minConf, 60));
  const tierMinConf = n(t.minConf, baseMinConf);
  const minConfidence = Math.max(0, Math.max(baseMinConf, tierMinConf - vmBonus));

  const baseSpread = n(base.spreadMaxPct, n(t.spreadMax, 0.95));
  const tierSpread = n(t.spreadMax, baseSpread);
  const spreadMaxPct = Math.min(baseSpread, tierSpread);

  const baseDepth = n(base.depthMinUsd1p, n(t.depth1pMin, 45_000));
  const tierDepth = n(t.depth1pMin, baseDepth);
  const depthMinUsd1p = Math.round(Math.max(baseDepth, tierDepth));

  const baseScore = n(base.obScoreMin, n(t.obScoreMin, 0.05));
  const tierScore = n(t.obScoreMin, baseScore);
  const obScoreMin = Math.max(baseScore, tierScore);

  return { minConfidence, spreadMaxPct, depthMinUsd1p, obScoreMin };
}

function updateStateAndConsistency(stateObj, symbol, stageFinal, core, nowTs) {
  const S = stateObj || {};
  const sym = up(symbol);
  const entryCfg = core?.SETTINGS?.entry || {};

  const need = Math.max(2, n(entryCfg.samplesNeed, 4));
  const minAgree = Math.max(1, n(entryCfg.minAgree, 3));

  const prev = safeObj(S[sym]) || {};
  const prevStage = up(prev.stage || "");

  const scans = n(prev.scans, 0) + 1;

  const histPrev = Array.isArray(prev.hist) ? prev.hist : [];
  const st = up(stageFinal);
  const hist = histPrev.concat([st]).slice(-Math.max(need, 12));

  const same = hist.filter((x) => x === st).length;
  const total = hist.length;
  const ratio = total > 0 ? same / total : 0;

  const ok = total >= need && same >= minAgree;

  S[sym] = { ...prev, scans, hist, lastSeenAt: nowTs, stage: st };

  return {
    state: S,
    prevStage,
    stageScans: scans,
    consistency: { ok, ratio, same, total, need, minAgree },
  };
}

// ======================================================
// MAIN HANDLER
// ======================================================
export default async function handler(req, res) {
  const startedAt = Date.now();

  try {
    if (!requireSecret(req, res)) return;

    const mode = getMode(req); // bull / bear
    const coreMod = await import(`../lib/_core_${mode}.js`);
    const core = coreMod?.default ? coreMod.default : coreMod;

    // ✅ LOCK CHECK: binnen 30 min -> return latest, geen scan
    const lock = await tryAcquireScanLock(mode);
    if (!lock.ok) {
      const latest = await kv.get(core.keyLatest(mode));
      if (latest) {
        latest.meta = latest.meta || {};
        latest.meta.scanLock = { active: true, until: lock.until, waitMs: lock.waitMs };
        return send(res, 200, latest);
      }
      return send(res, 200, {
        ok: false,
        mode,
        error: "scan locked and no latest yet",
        meta: { scanLock: { active: true, until: lock.until, waitMs: lock.waitMs } },
      });
    }

    const now = Date.now();

    const btcBase = await fetchBtc();
    const btcState = computeBtcStateCompat(btcBase, core.SETTINGS);
    const btcTune = btcConfidenceAdjustCompat(mode, btcState, btcBase, core.SETTINGS);
    const btc = { ...btcBase, state: btcState, tune: btcTune };

    const cap = computeStageCap(mode, btc.state);

    const cg = await fetchCgTop(core.SETTINGS.CG_TOP || 1000);

    const radar = [];
    const buildup = [];
    const almost = [];
    const entry = [];
    const openTrades = []; // placeholder

    const state = (await kv.get(core.keyState(mode))) || {};
    await loadObMap(mode);

    for (const c of cg) {
      // OB ophalen (altijd, ook als radar later faalt, voor stats)
      const sym = up(c.symbol);
      const ob = await getObForSymbol({ mode, symbol: sym });
      const obFresh = !!ob?.fresh;
      const obValid = !!ob?.valid;
      const spreadPct = n(ob?.spreadPct, 999);
      const depthMinUsd1p = n(ob?.depthMinUsd1p, 0);
      const obScore = n(ob?.score, 0);

      // ✅ per-coin medians/percentiles (range/spread/obScore) – nu met null‑filter
      const coinStats = await updateCoinStatsAndGetMetrics({
        mode,
        sym,
        range24: n(c.range24, 0),
        spreadPct: Number.isFinite(spreadPct) ? spreadPct : null,
        obScore: Number.isFinite(obScore) ? obScore : null,
        now,
      });

      // ✅ Bepaal range voor dynamische drempels (mediaan of fallback)
      const rangeForDyn = Number.isFinite(coinStats?.medRange24) ? coinStats.medRange24 : n(c.range24, 0);

      // ✅ Dynamische radar thresholds (op basis van gestabiliseerde range)
      const dyn = typeof core.dynamicRadarThresholds === "function"
        ? core.dynamicRadarThresholds(rangeForDyn, core.SETTINGS)
        : null;

      // ✅ Radar gate (met meegegeven dyn)
      const radarGate = passRadar(core, mode, c, dyn);
      if (!radarGate.ok) continue;

      const vm = radarGate.vm;
      // gebruik de dyn uit radarGate (kan null zijn)
      const usedDyn = radarGate.dyn || dyn; // voorkom dat dyn verloren gaat

      // ✅ stage base (met dezelfde dyn)
      let stageBase = stageFromSwing(mode, { ...c, vm }, usedDyn);

      // ✅ Anomaly detector: range spike vs coin median => downgrade
      const curRange = n(c.range24, 0);
      const medRange = Number.isFinite(coinStats?.medRange24) ? coinStats.medRange24 : null;

      const hasStats = n(coinStats?.samples, 0) >= 30; // ~15 uur bij 30m cadence
      const isSpike = hasStats && medRange && medRange > 0 && curRange > 2.2 * medRange && curRange > 10;

      let anomaly = null;
      if (isSpike) {
        anomaly = { type: "RANGE_SPIKE", curRange, medRange, factor: +(curRange / medRange).toFixed(2) };

        // downgrade only if it wanted to get aggressive
        if (stageBase === "ALMOST" || stageBase === "ENTRY") {
          stageBase = "BUILDUP";
        }
      }

      // confidence
      const confidenceBase = core.computeConfidence({
        vm,
        change24: c.change24,
        range24: c.range24,
        obValid: !!obValid,
      });
      const confidence = Math.max(0, Math.min(100, n(confidenceBase, 0) + n(btcTune.adj, 0)));

      // ✅ entry thresholds: eerst tiers, dan dynamisch (core functie)
      const baseThr = adaptiveEntryThresholds(core, c, vm);
      let thr = typeof core.dynamicEntryThresholds === "function"
        ? core.dynamicEntryThresholds(
            { marketCap: c.marketCap, volume: c.volume, vm },
            baseThr,
            core.SETTINGS
          )
        : baseThr;

      // ✅ Spread aanpassen op basis van coin-historie (p80 spread) – nu blended
      if (thr && Number.isFinite(coinStats?.p80SpreadPct)) {
        const hardMax = Number(core?.SETTINGS?.entry?.dyn?.spreadHardMaxPct ?? 1.6);
        const hardMin = Number(core?.SETTINGS?.entry?.dyn?.spreadHardMinPct ?? 0.55);

        const coinBaseline = coinStats.p80SpreadPct * 1.25; // iets boven "bad typical"
        const base = Number(thr.spreadMaxPct || 0);

        // blend: 70% base, 30% coin
        thr.spreadMaxPct = 0.70 * base + 0.30 * coinBaseline;
        thr.spreadMaxPct = Math.max(hardMin, Math.min(hardMax, thr.spreadMaxPct));
      }

      // ✅ OB score aanpassen op basis van coin-historie (p70 absolute score)
      if (thr && Number.isFinite(coinStats?.p70ObAbs)) {
        const hardMax = Number(core?.SETTINGS?.entry?.dyn?.obScoreHardMax ?? 0.075);
        const hardMin = Number(core?.SETTINGS?.entry?.dyn?.obScoreHardMin ?? 0.04);

        const base = Number(thr.obScoreMin || 0);
        const coin = Number(coinStats.p70ObAbs || 0) * 0.85; // require ~near typical strength

        // blend (can go slightly up/down but respects hard clamps)
        const blended = 0.65 * base + 0.35 * coin;

        thr.obScoreMin = Math.max(hardMin, Math.min(hardMax, blended));
      }

      let stage = stageBase;
      let almostGate = "n/a";
      let entryGate = "n/a";

      // BTC cap: ALMOST/ENTRY max naar BUILDUP als contra/neutral
      if (cap.cap && (stageBase === "ALMOST" || stageBase === "ENTRY")) {
        stage = "BUILDUP";
        stageBase = "BUILDUP";
        almostGate = `capped: ${cap.capStage}`;
        entryGate = `capped: ${cap.capStage}`;
      } else {
        // ALMOST gate (optioneel slope check)
        if (stageBase === "ALMOST") {
          const obSamples = await kv.get(core.keyObSamples(mode, sym));
          const slopeCheck =
            typeof core.checkObSlopeGate === "function"
              ? core.checkObSlopeGate({ stage: "almost", mode, obSamples, settings: core.SETTINGS })
              : { ok: true };

          if (!slopeCheck.ok) {
            stage = "BUILDUP";
            stageBase = "BUILDUP";
            almostGate = slopeCheck.reason || "OB slope failed in ALMOST";
          } else {
            almostGate = "passed";
          }
        }

        // ENTRY gate (alleen als nog ALMOST)
        if (stageBase === "ALMOST") {
          if (!ob || ob.ok === false) entryGate = "OB missing";
          else if (!obFresh) entryGate = "OB stale";
          else if (!obValid) entryGate = "OB invalid";
          else if (confidence < n(thr.minConfidence, 0)) entryGate = `Confidence < ${thr.minConfidence}`;
          else if (spreadPct > n(thr.spreadMaxPct, 999)) entryGate = `Spread > ${thr.spreadMaxPct}%`;
          else if (depthMinUsd1p < n(thr.depthMinUsd1p, 0)) entryGate = `Depth1% < $${thr.depthMinUsd1p}`;
          else if (Math.abs(obScore) < n(thr.obScoreMin, 0)) entryGate = `OB score < ${thr.obScoreMin}`;
          else {
            const obSamples = await kv.get(core.keyObSamples(mode, sym));
            const slopeCheck2 =
              typeof core.checkObSlopeGate === "function"
                ? core.checkObSlopeGate({ stage: "entry", mode, obSamples, settings: core.SETTINGS })
                : { ok: true };

            const pressureDelta = n(ob?.pressureDeltaUsd, 0);
            const pressureOk = mode === "bull" ? pressureDelta >= 0 : pressureDelta <= 0;

            if (!slopeCheck2.ok) entryGate = slopeCheck2.reason || "OB slope failed at ENTRY";
            else if (!pressureOk) entryGate = "Pressure contra";
            else {
              stage = "ENTRY";
              entryGate = "passed";
            }
          }
        }
      }

      // Anomaly notitie in gates als die actief is
      if (anomaly?.type === "RANGE_SPIKE") {
        if (almostGate === "n/a") almostGate = `anomaly: range spike x${anomaly.factor}`;
        if (entryGate === "n/a") entryGate = `anomaly: range spike x${anomaly.factor}`;
      }

      // consistency/state update (eerst de uiteindelijke stage)
      const upd = updateStateAndConsistency(state, sym, stage, core, now);

      // ✅ Consistency blockade: bij onvoldoende historische overeenstemming geen ALMOST/ENTRY
      if ((stage === "ALMOST" || stage === "ENTRY") && !upd.consistency?.ok) {
        stage = "BUILDUP";
        if (almostGate === "n/a" || almostGate === "passed") {
          almostGate = `consistency blocked (${upd.consistency.same}/${upd.consistency.need}, minAgree=${upd.consistency.minAgree})`;
        }
        if (entryGate === "n/a" || entryGate === "passed") {
          entryGate = `consistency blocked (${upd.consistency.same}/${upd.consistency.need}, minAgree=${upd.consistency.minAgree})`;
        }
        // ✅ Fix: corrigeer ook hist, anders “vervuilt” consistency zichzelf
        if (state[sym]) {
          state[sym].stage = "BUILDUP";
          if (Array.isArray(state[sym].hist) && state[sym].hist.length) {
            state[sym].hist[state[sym].hist.length - 1] = "BUILDUP";
          }
        }
      }

      const item = {
        symbol: sym,
        name: c.name || sym,
        price: n(c.price, 0),
        marketCap: n(c.marketCap, 0),
        volume: n(c.volume, 0),
        vm: +n(vm, 0).toFixed(6),
        change1h: +n(c.change1h, 0).toFixed(3),
        change24: +n(c.change24, 0).toFixed(3),
        range24: +n(c.range24, 0).toFixed(3),

        confidence,
        stage,
        stageBase,

        gates: { radar: radarGate.why || "passed", almost: almostGate, entry: entryGate },
        consistency: upd.consistency,

        // ✅ rationale voor deze coin (design keuze)
        rationale: DESIGN_RATIONALE,

        // Telemetrie: dynamische radar thresholds
        dyn: usedDyn
          ? {
              maxRange24: +n(usedDyn.maxRange24, 0).toFixed(3),
              dir1hMinBull: +n(usedDyn.dir1hMinBull, 0).toFixed(3),
              dir24MinBull: +n(usedDyn.dir24MinBull, 0).toFixed(3),
              dir1hMaxBear: +n(usedDyn.dir1hMaxBear, 0).toFixed(3),
              dir24MaxBear: +n(usedDyn.dir24MaxBear, 0).toFixed(3),
              scale: +n(usedDyn.scale, 0).toFixed(3),
            }
          : null,

        // Telemetrie: gebruikte entry thresholds
        thr: {
          minConfidence: thr.minConfidence,
          spreadMaxPct: +n(thr.spreadMaxPct, 0).toFixed(3),
          depthMinUsd1p: thr.depthMinUsd1p,
          obScoreMin: +n(thr.obScoreMin, 0).toFixed(5),
          liqScore: thr.liqScore != null ? +n(thr.liqScore, 0).toFixed(3) : null,
        },

        // Telemetrie: coin historische stats
        coinStats: {
          samples: coinStats?.samples ?? 0,
          medRange24: coinStats?.medRange24 ?? null,
          p80Range24: coinStats?.p80Range24 ?? null,
          medSpreadPct: coinStats?.medSpreadPct ?? null,
          p80SpreadPct: coinStats?.p80SpreadPct ?? null,
          medObAbs: coinStats?.medObAbs ?? null,
          p70ObAbs: coinStats?.p70ObAbs ?? null,
        },
        anomaly: anomaly || null,

        ob: {
          fresh: !!obFresh,
          valid: !!obValid,
          spreadPct: ob?.spreadPct ?? null,
          depthMinUsd1p: ob?.depthMinUsd1p ?? null,
          score: ob?.score ?? null,
          pressureDeltaUsd: ob?.pressureDeltaUsd ?? 0,
          ts: ob?.ts ?? null,
          ageSec: ob?.ageSec ?? null,
          reason: ob?.reason || "",
        },
      };

      if (stage === "ENTRY") entry.push(item);
      else if (stage === "ALMOST") almost.push(item);
      else if (stage === "BUILDUP") buildup.push(item);
      else radar.push(item);

      if (stage === "ENTRY") {
        await safePushEvent("scan_entry", { mode, symbol: sym, confidence, btcState: btc.state });
      }
    }

    // Sort
    const byScore = (a, b) =>
      (b.confidence - a.confidence) ||
      (b.vm - a.vm) ||
      (Math.abs(b.change24) - Math.abs(a.change24));

    radar.sort(byScore);
    buildup.sort(byScore);
    almost.sort(byScore);
    entry.sort(byScore);

    const radarLimit = n(core?.SETTINGS?.RADAR_LIMIT, 60);
    const outRadar = radar.slice(0, radarLimit);
    const outBuildup = buildup.slice(0, radarLimit);
    const outAlmost = almost.slice(0, radarLimit);
    const outEntry = entry.slice(0, radarLimit);

    const out = {
      ok: true,
      mode,
      ts: Date.now(),
      tookMs: Date.now() - startedAt,
      btc,
      cap,
      funnel: {
        radar: outRadar,
        buildup: outBuildup,
        almost: outAlmost,
        entry: outEntry,
      },
      openTrades,
      meta: {
        scanLock: { active: false, until: lock.until, waitMs: 0 },
        counts: {
          cg: cg.length,
          radar: radar.length,
          buildup: buildup.length,
          almost: almost.length,
          entry: entry.length,
        },
        rationale: DESIGN_RATIONALE, // ✅ toegevoegd
      },
    };

    const ttl = n(core?.SETTINGS?.entry?.resultTtlSec, 60 * 45);
    await kv.set(core.keyLatest(mode), out, { ex: Math.max(60, ttl) });
    await kv.set(core.keyState(mode), state, { ex: 60 * 60 * 24 * 7 });

    return send(res, 200, out);
  } catch (e) {
    return send(res, 200, { ok: false, error: String(e?.message || e) });
  }
}