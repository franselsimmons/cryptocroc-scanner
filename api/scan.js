/* EOF: /api/scan.js */
import { kv } from "@vercel/kv";
import { createHash } from "crypto";
import { RUNTIME_CONFIG, requireSecret, getMode } from "../lib/_runtime.js";
import { pushEvent } from "../lib/_analytics.js";
import { getObSnapshot, obMapKey } from "../lib/obStore.js";

export const config = RUNTIME_CONFIG;

// ======================================================
// ✅ 30 MIN SCAN LOCK (ATOMISCH)
//   - Handmatig verkeer: lock actief (anti-spam)
//   - Vercel Cron verkeer: BYPASS lock, MAAR lock wordt WEL gezet/refresh (fix)
//   - Force: alleen via POST ?force=1 (zodat refresh nooit kan forcen)
// ======================================================
const SCAN_INTERVAL_SEC = 30 * 60; // 30 minuten

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  return res.end(JSON.stringify(obj));
}

function isVercelCron(req) {
  const h = req?.headers || {};
  // Node/Vercel headers zijn normaliter lowercase
  const v = h["x-vercel-cron"] || h["x-vercel-cron-job"];
  const s = String(v || "").trim().toLowerCase();
  // ✅ stricter: alleen echte cron waarden
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function wantsForce(req) {
  // ✅ Force alleen via POST, zodat browser refresh nooit “per ongeluk” force kan triggeren
  const method = String(req?.method || "GET").toUpperCase();
  if (method !== "POST") return false;

  const q = req?.query || {};
  const f = q.force ?? q.FORCE;
  const s = String(f || "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

function scanLockKey(mode) {
  return `scan:lock:${String(mode).toLowerCase()}`;
}

// ✅ NEW: force-set/refresh lock (used by cron/force bypass)
async function setScanLock(mode, now = Date.now()) {
  const key = scanLockKey(mode);
  const nextUntil = now + SCAN_INTERVAL_SEC * 1000;
  await kv.set(key, { until: nextUntil, setAt: now }, { ex: SCAN_INTERVAL_SEC });
  return { key, until: nextUntil, now };
}

async function tryAcquireScanLock(mode) {
  const key = scanLockKey(mode);
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

  // Edge case: lock is “stale” maar key bestaat nog → force refresh
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

// ✅ CoinGecko KV cache (anti-429) per-request
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
// ✅ Haal meerdere CoinGecko pagina's op (RAW)
// ======================================================
async function fetchCgTopRaw(limit = 1000) {
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
// ✅ Universe cache (gratis meer coins zonder extra calls)
// ======================================================
const CG_UNIVERSE_CACHE_TTL_SEC = 10 * 60; // 10 minuten
const CG_MAX_LIMIT = 2500; // 10 pages * 250

function cgUniverseKey(limit) {
  const lim = Math.max(1, Math.min(CG_MAX_LIMIT, Number(limit) || 1000));
  return `cg:universe:vol_desc:usd:${lim}`;
}

async function fetchCgTop(limit = 1000) {
  const lim = Math.max(1, Math.min(CG_MAX_LIMIT, Number(limit) || 1000));
  const key = cgUniverseKey(lim);

  const cached = await kv.get(key);
  if (Array.isArray(cached) && cached.length) return cached;

  const coins = await fetchCgTopRaw(lim);
  await kv.set(key, coins, { ex: CG_UNIVERSE_CACHE_TTL_SEC });
  return coins;
}

// ======================================================
// ✅ RADAR gate (NU COIN-ADAPTIEF)
// ======================================================
function passRadar(core, mode, c) {
  const R = core?.SETTINGS?.radar || {};
  const vm = core.computeVm(c.volume, c.marketCap);

  if (c.marketCap < n(R.mcapMin, 0)) return { ok: false, why: "mcap too low" };
  if (c.marketCap > n(R.mcapMax, Number.MAX_SAFE_INTEGER)) return { ok: false, why: "mcap too high" };
  if (c.volume < n(R.volMin, 0)) return { ok: false, why: "volume too low" };
  if (vm < n(R.vmMin, 0)) return { ok: false, why: "vm too low" };

  const dyn =
    typeof core.dynamicRadarThresholds === "function"
      ? core.dynamicRadarThresholds(c.range24, core.SETTINGS)
      : null;

  const maxAbsChg24 = n(R.maxAbsChg24, 999);
  const maxRange24 = dyn ? n(dyn.maxRange24, n(R.maxRange24, 999)) : n(R.maxRange24, 999);

  if (Math.abs(c.change24) > maxAbsChg24) return { ok: false, why: "chg24 too high" };
  if (c.range24 > maxRange24) return { ok: false, why: "range24 too high" };

  const m = String(mode || "").toLowerCase();
  if (m === "bull") {
    const dir1hMin = dyn ? n(dyn.dir1hMinBull, n(R.dir1hMinBull, 0.2)) : n(R.dir1hMinBull, 0.2);
    const dir24Min = dyn ? n(dyn.dir24MinBull, n(R.dir24MinBull, 0.5)) : n(R.dir24MinBull, 0.5);
    if (n(c.change1h, 0) < dir1hMin) return { ok: false, why: "dir fail (1h not up)" };
    if (n(c.change24, 0) < dir24Min) return { ok: false, why: "dir fail (24h not up)" };
  } else if (m === "bear") {
    const dir1hMax = dyn ? n(dyn.dir1hMaxBear, n(R.dir1hMaxBear, -0.2)) : n(R.dir1hMaxBear, -0.2);
    const dir24Max = dyn ? n(dyn.dir24MaxBear, n(R.dir24MaxBear, -0.5)) : n(R.dir24MaxBear, -0.5);
    if (n(c.change1h, 0) > dir1hMax) return { ok: false, why: "dir fail (1h not down)" };
    if (n(c.change24, 0) > dir24Max) return { ok: false, why: "dir fail (24h not down)" };
  }

  return {
    ok: true,
    vm,
    dynRadar: dyn
      ? {
          maxRange24: +n(dyn.maxRange24, 0).toFixed(2),
          dir1h: m === "bull" ? +n(dyn.dir1hMinBull, 0).toFixed(3) : +n(dyn.dir1hMaxBear, 0).toFixed(3),
          dir24: m === "bull" ? +n(dyn.dir24MinBull, 0).toFixed(3) : +n(dyn.dir24MaxBear, 0).toFixed(3),
          scale: +n(dyn.scale, 0).toFixed(3),
        }
      : null,
  };
}

// ======================================================
// Stage logic (NU COIN-ADAPTIEF op range24)
// ======================================================
function stageFromSwing(core, mode, c) {
  const vm = c.vm;
  const range = c.range24;
  const ch1h = c.change1h;

  const dyn =
    typeof core.dynamicRadarThresholds === "function"
      ? core.dynamicRadarThresholds(range, core.SETTINGS)
      : null;

  const wantUp = mode === "bull";
  const dir1h = dyn
    ? wantUp
      ? n(dyn.dir1hMinBull, 0.2)
      : n(dyn.dir1hMaxBear, -0.2)
    : wantUp
    ? 0.2
    : -0.2;

  const inDir = wantUp ? ch1h >= dir1h : ch1h <= dir1h;

  const r = n(range, 0);
  const s = Math.max(0, Math.min(1, (r - 8) / 22)); // 8..30 → 0..1
  const vmAlmost = 0.24 + 0.04 * s; // 0.24..0.28
  const vmBuildup = 0.18 + 0.03 * s; // 0.18..0.21

  const maxRangeAlmost = dyn ? n(dyn.maxRange24, 22) - 2 : 22;
  const maxRangeBuildup = dyn ? n(dyn.maxRange24, 28) : 28;

  if (vm >= vmAlmost && range <= maxRangeAlmost && inDir) return "ALMOST";
  if (vm >= vmBuildup && range <= maxRangeBuildup) return "BUILDUP";
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

// ======================================================
// ENTRY thresholds (tiers + coin-adaptieve OB tuning)
// ======================================================
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

  const thrBase = { minConfidence, spreadMaxPct, depthMinUsd1p, obScoreMin };

  if (typeof core.dynamicEntryThresholds === "function") {
    const tuned = core.dynamicEntryThresholds(
      { marketCap: c.marketCap, volume: c.volume, vm },
      {
        minConfidence: thrBase.minConfidence,
        spreadMaxPct: thrBase.spreadMaxPct,
        depthMinUsd1p: thrBase.depthMinUsd1p,
        obScoreMin: thrBase.obScoreMin,
      },
      core.SETTINGS
    );

    return {
      minConfidence: n(tuned.minConfidence, thrBase.minConfidence),
      spreadMaxPct: n(tuned.spreadMaxPct, thrBase.spreadMaxPct),
      depthMinUsd1p: Math.round(n(tuned.depthMinUsd1p, thrBase.depthMinUsd1p)),
      obScoreMin: n(tuned.obScoreMin, thrBase.obScoreMin),
      liqScore: tuned.liqScore ?? null,
    };
  }

  return thrBase;
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
// ✅ NEW: async pool (concurrency limiter) voor OB batching
// ======================================================
async function asyncPool(limit, items, worker) {
  const nLimit = Math.max(1, Number(limit || 8));
  const arr = Array.isArray(items) ? items : [];
  const out = new Array(arr.length);

  let idx = 0;

  async function runOne() {
    while (idx < arr.length) {
      const i = idx++;
      out[i] = await worker(arr[i], i);
    }
  }

  const runners = Array.from({ length: Math.min(nLimit, arr.length) }, () => runOne());
  await Promise.all(runners);
  return out;
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

    // ✅ cron/force bypass lock-check, maar lock wordt WEL gezet (fix)
    const fromCron = isVercelCron(req);
    const force = wantsForce(req);

    let lock = null;

    if (fromCron || force) {
      const now0 = Date.now();
      const l = await setScanLock(mode, now0);
      lock = { ok: true, key: l.key, until: l.until, now: l.now, waitMs: 0 };
    } else {
      lock = await tryAcquireScanLock(mode);
    }

    // ✅ IMPORTANT: als locked → NOOIT scannen, alleen latest teruggeven (fix “refresh rescans”)
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

    // ✅ 2500 coins als core.SETTINGS.CG_TOP = 2500
    const cg = await fetchCgTop(core.SETTINGS.CG_TOP || 1000);

    const radar = [];
    const buildup = [];
    const almost = [];
    const entry = [];
    const openTrades = [];

    const state = (await kv.get(core.keyState(mode))) || {};
    await loadObMap(mode);

    // ======================================================
    // ✅ PASS 1: geen OB calls voor iedereen (performance)
    // - Bepaal stageBase + vm
    // - Verzamel ALMOST candidates apart voor OB batch
    // ======================================================
    const almostCandidates = [];

    for (const c of cg) {
      const radarGate = passRadar(core, mode, c);
      if (!radarGate.ok) continue;

      const vm = radarGate.vm;
      const sym = up(c.symbol);

      let stageBase = stageFromSwing(core, mode, { ...c, vm });

      // BTC cap kan ALMOST/ENTRY naar BUILDUP drukken zonder OB
      if (cap.cap && (stageBase === "ALMOST" || stageBase === "ENTRY")) {
        stageBase = "BUILDUP";
      }

      // Voor RADAR/BUILDUP doen we geen OB fetch (snel)
      if (stageBase !== "ALMOST") {
        const confidenceBase = core.computeConfidence({
          vm,
          change24: c.change24,
          range24: c.range24,
          obValid: false,
        });
        const confidence = Math.max(0, Math.min(100, n(confidenceBase, 0) + n(btcTune.adj, 0)));

        const upd = updateStateAndConsistency(state, sym, stageBase, core, now);

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
          stage: stageBase,
          stageBase,

          gates: {
            radar: radarGate.why || "passed",
            almost: "n/a",
            entry: "n/a",
          },
          consistency: upd.consistency,

          dyn: {
            radar: radarGate.dynRadar || null,
            entry: null,
          },

          ob: {
            fresh: false,
            valid: false,
            spreadPct: null,
            depthMinUsd1p: null,
            score: null,
            pressureDeltaUsd: 0,
            ts: null,
            ageSec: null,
            reason: "skipped (fast path)",
          },
        };

        if (stageBase === "BUILDUP") buildup.push(item);
        else radar.push(item);

        continue;
      }

      // ALMOST → later OB batch
      almostCandidates.push({ c, vm, sym, radarGate });
    }

    // ======================================================
    // ✅ PASS 2: OB batching alleen voor ALMOST candidates
    // - parallel met concurrency limiter
    // - hier kan ENTRY worden
    // ======================================================
    const OB_CONCURRENCY = 12; // tweak: 8..20 veilig

    const almostProcessed = await asyncPool(OB_CONCURRENCY, almostCandidates, async (x) => {
      const { c, vm, sym, radarGate } = x;

      // OB fetch (nu pas)
      const ob = await getObForSymbol({ mode, symbol: sym });
      const obFresh = !!ob?.fresh;
      const obValid = !!ob?.valid;

      const spreadPct = n(ob?.spreadPct, 999);
      const depthMinUsd1p = n(ob?.depthMinUsd1p, 0);
      const obScore = n(ob?.score, 0);

      const confidenceBase = core.computeConfidence({
        vm,
        change24: c.change24,
        range24: c.range24,
        obValid: !!obValid,
      });
      const confidence = Math.max(0, Math.min(100, n(confidenceBase, 0) + n(btcTune.adj, 0)));

      const thr = adaptiveEntryThresholds(core, c, vm);

      let stage = "ALMOST";
      let stageBase = "ALMOST";
      let almostGate = "passed";
      let entryGate = "n/a";

      // BTC cap check (double safety)
      if (cap.cap) {
        stage = "BUILDUP";
        stageBase = "BUILDUP";
        almostGate = `capped: ${cap.capStage}`;
        entryGate = `capped: ${cap.capStage}`;
      } else {
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
          // ENTRY gate
          if (!ob || ob.ok === false) entryGate = "OB missing";
          else if (!obFresh) entryGate = "OB stale";
          else if (!obValid) entryGate = "OB invalid";
          else if (confidence < n(thr.minConfidence, 0)) entryGate = `Confidence < ${thr.minConfidence}`;
          else if (spreadPct > n(thr.spreadMaxPct, 999)) entryGate = `Spread > ${thr.spreadMaxPct}%`;
          else if (depthMinUsd1p < n(thr.depthMinUsd1p, 0)) entryGate = `Depth1% < $${thr.depthMinUsd1p}`;
          else if (Math.abs(obScore) < n(thr.obScoreMin, 0)) entryGate = `OB score < ${thr.obScoreMin}`;
          else {
            const obSamples2 = obSamples; // reuse
            const slopeCheck2 =
              typeof core.checkObSlopeGate === "function"
                ? core.checkObSlopeGate({ stage: "entry", mode, obSamples: obSamples2, settings: core.SETTINGS })
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

      const upd = updateStateAndConsistency(state, sym, stage, core, now);

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

        gates: {
          radar: radarGate.why || "passed",
          almost: almostGate,
          entry: entryGate,
        },
        consistency: upd.consistency,

        dyn: {
          radar: radarGate.dynRadar || null,
          entry: {
            minConfidence: thr.minConfidence,
            spreadMaxPct: +n(thr.spreadMaxPct, 0).toFixed(3),
            depthMinUsd1p: Math.round(n(thr.depthMinUsd1p, 0)),
            obScoreMin: +n(thr.obScoreMin, 0).toFixed(4),
            liqScore: thr.liqScore != null ? +n(thr.liqScore, 0).toFixed(3) : null,
          },
        },

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

      return item;
    });

    // push processed almost/entry/buildup
    for (const item of almostProcessed) {
      if (!item) continue;
      if (item.stage === "ENTRY") {
        entry.push(item);
        await safePushEvent("scan_entry", { mode, symbol: item.symbol, confidence: item.confidence, btcState: btc.state });
      } else if (item.stage === "ALMOST") {
        almost.push(item);
      } else if (item.stage === "BUILDUP") {
        buildup.push(item);
      } else {
        radar.push(item);
      }
    }

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
        scanLock: {
          active: !(fromCron || force),
          until: lock.until ?? null,
          waitMs: lock.waitMs ?? 0,
          bypass: fromCron ? "vercel_cron" : force ? "force_post" : "",
        },
        cgUniverse: {
          cachedTtlSec: CG_UNIVERSE_CACHE_TTL_SEC,
          maxLimit: CG_MAX_LIMIT,
          requested: Number(core.SETTINGS.CG_TOP || 1000),
          got: cg.length,
        },
        perf: {
          obConcurrency: OB_CONCURRENCY,
          almostCandidates: almostCandidates.length,
          obFetched: almostProcessed.length,
        },
        counts: {
          cg: cg.length,
          radar: radar.length,
          buildup: buildup.length,
          almost: almost.length,
          entry: entry.length,
        },
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