import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, requireSecret, getMode } from "../lib/_runtime.js";
import { pushEvent } from "../lib/_analytics.js";
import { getObSnapshot, obMapKey } from "../lib/obStore.js";

export const config = RUNTIME_CONFIG;

// ======================================================
// ✅ 30 MIN SCAN LOCK (ATOMISCH) – NU BOUNDARY-BASED
// ======================================================
async function tryAcquireScanLock(mode) {
  const key = `scan:lock:${String(mode).toLowerCase()}`;
  const now = Date.now();

  // ✅ lock loopt altijd tot de volgende :00 of :30
  const d = new Date(now);
  const m = d.getMinutes();

  const next = new Date(d);
  next.setSeconds(0, 0);

  if (m < 30) {
    next.setMinutes(30);
  } else {
    next.setMinutes(0);
    next.setHours(d.getHours() + 1);
  }

  const nextUntil = next.getTime();
  const ttlSec = Math.max(60, Math.ceil((nextUntil - now) / 1000)); // minimaal 60s

  // Atomisch: alleen lock zetten als hij niet bestaat (NX)
  const ok = await kv.set(key, { until: nextUntil, setAt: now }, { nx: true, ex: ttlSec });

  if (ok) {
    return { ok: true, key, until: nextUntil, now, waitMs: 0 };
  }

  // Lock bestond al → lees huidige
  const cur = await kv.get(key);
  const until = Number(cur?.until || 0);

  if (until > now) {
    return { ok: false, key, until, now, waitMs: until - now };
  }

  // stale → refresh tot volgende boundary
  await kv.set(key, { until: nextUntil, setAt: now }, { ex: ttlSec });
  return { ok: true, key, until: nextUntil, now, waitMs: 0 };
}

// ======================================================
// ✅ Universe keys (gelijk aan universe.js)
// ======================================================
const K_UNIVERSE_LATEST = "universe:latest";
const K_LOCK_UNIVERSE = "scan:lock:universe";

// ======================================================
// ✅ Design rationale (voor transparantie)
// ======================================================
const DESIGN_RATIONALE = [
  "Zonder coin-typische momentum en zonder consistency-blokkade krijg je bij 30m cadence te veel false positives (micro moves, random spikes, liquidity noise).",
  "OB gates zijn goed, maar spread/score zijn coin-dependent → daarom percentiles.",
].join(" ");

// ======================================================
// ✅ Tier gating config (single place to tune)
// ======================================================
const TIER_CFG = {
  // Basic OB sanity for anything above RADAR
  buildup: {
    spreadMaxPct: 1.40,
    depthMinUsd1p: 18_000,
    obScoreAbsMin: 0.00, // buildup doesn't require imbalance, just sanity
  },

  // Medium filters
  almost: {
    spreadMaxPct: 1.10,
    depthMinUsd1p: 28_000,
    obScoreAbsMin: 0.030, // require some imbalance
    requireWall: false,   // optional: set true if you want wall presence
  },

  // Hard filters
  entry: {
    spreadMaxPct: 0.95,
    depthMinUsd1p: 45_000,
    obScoreAbsMin: 0.045,
    requireWall: false,
    requirePressureAlign: true, // bull => pressureDelta>=0, bear => <=0
  },

  // Sample-based gate thresholds
  samples: {
    minForSpoof: 3,
    minForAbsorption: 4,
  },
};

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

// --------------------
// Helpers
// --------------------
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
const COIN_STATS_TTL_SEC = 60 * 60 * 24 * 8; // 8 dagen bewaren
const COIN_STATS_WINDOW_SEC = 60 * 60 * 24 * 7; // 7 dagen window
const COIN_STATS_KEEP_MAX = 700; // hard cap

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

  const next = arr.filter((x) => Number(x?.ts || 0) >= cutoff).concat([row]).slice(-COIN_STATS_KEEP_MAX);

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
// ✅ BTC state / compat (geen fetch meer, alleen rekenen)
// ======================================================
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
// ✅ OB ophalen
// ======================================================
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
    stageScans: scans,
    consistency: { ok, ratio, same, total, need, minAgree },
  };
}

// ---------- toegevoegde helpers voor spoof en absorption ----------
function spoofRiskFromSamples(samples) {
  const a = Array.isArray(samples) ? samples : [];
  if (a.length < TIER_CFG.samples.minForSpoof) return { ok: true, risk: 0, why: "not_enough_samples" };

  const s2 = a[a.length - 1];
  const s1 = a[a.length - 2];

  const lorNow = Number(s2?.lor || 0);
  const lorPrev = Number(s1?.lor || 0);

  const wallNow = lorNow >= 0.22;
  const wallPrev = lorPrev >= 0.22;

  const toggledOff = wallPrev && !wallNow;

  const scoreNow = Number(s2?.score || 0);
  const scorePrev = Number(s1?.score || 0);
  const scoreFlip = Math.sign(scorePrev) !== Math.sign(scoreNow);

  const spreadNow = Number(s2?.spreadPct || 999);
  const spreadPrev = Number(s1?.spreadPct || 999);
  const spreadWorse = spreadNow > spreadPrev * 1.05;

  const risk = (toggledOff ? 1 : 0) + (scoreFlip ? 1 : 0) + (spreadWorse ? 1 : 0);

  return { ok: risk <= 1, risk, why: risk >= 2 ? "spoof_like_wall_behavior" : "ok" };
}

function absorptionFromSamples(samples, mode) {
  const a = Array.isArray(samples) ? samples : [];
  if (a.length < TIER_CFG.samples.minForAbsorption) return { ok: true, why: "not_enough_samples" };

  // Gebruik de centrale instelling voor het aantal samples
  const last = a.slice(-TIER_CFG.samples.minForAbsorption);

  const scores = last.map((x) => Number(x?.score || 0));
  const depths = last.map((x) => Number(x?.depthMinUsd1p || 0));

  const avgScore = scores.reduce((p, c) => p + c, 0) / scores.length;
  const avgDepth = depths.reduce((p, c) => p + c, 0) / depths.length;

  const wantUp = String(mode) === "bull";
  const aligned = wantUp ? avgScore > 0.03 : avgScore < -0.03;

  // Absorption proxy: deep liquidity but weak/non-aligned pressure
  const absorption = avgDepth > 40_000 && !aligned;

  return absorption ? { ok: false, why: "liquidity_absorption_proxy" } : { ok: true, why: "ok" };
}
// ----------------------------------------------------------------

// ======================================================
// MAIN HANDLER
// ======================================================
export default async function handler(req, res) {
  const startedAt = Date.now();

  try {
    if (!requireSecret(req, res)) return;

    // ✅ FIX: mode normaliseren zodat keys altijd latest:bull/bear zijn
    const mode = String(getMode(req)).toLowerCase().trim(); // bull/bear
    const coreMod = await import(`../lib/_core_${mode}.js`);
    const core = coreMod?.default ? coreMod.default : coreMod;

    // ✅ LOCK CHECK: binnen 30 min -> return latest, geen scan
    const lock = await tryAcquireScanLock(mode);
    if (!lock.ok) {
      const latest = await kv.get(core.keyLatest(mode));

      // ✅ FAIL-OPEN: lock actief maar geen latest => lock droppen en toch scannen
      if (!latest) {
        await kv.del(`scan:lock:${String(mode).toLowerCase()}`);
      } else {
        latest.meta = latest.meta || {};
        latest.meta.scanLock = { active: true, until: lock.until, waitMs: lock.waitMs };
        return send(res, 200, latest);
      }
    }

    const now = Date.now();

    // ✅ 1) Universe uit KV (wordt 1x per 30m gevuld door /api/universe)
    const uni = await kv.get(K_UNIVERSE_LATEST);
    if (!uni?.ok || !Array.isArray(uni?.coins) || uni.coins.length === 0) {
      return send(res, 200, {
        ok: false,
        mode,
        error: `Universe missing/empty in KV (${K_UNIVERSE_LATEST}). Run /api/universe (cron) first.`,
        meta: {
          universe: { key: K_UNIVERSE_LATEST, has: !!uni, count: Array.isArray(uni?.coins) ? uni.coins.length : 0 },
          universeLockKey: K_LOCK_UNIVERSE,
        },
      });
    }

    // ✅ 2) BTC komt uit universe (geen aparte fetch)
    const btcBase = uni?.btc || { chg1h: 0, chg24: 0, range24: 0 };
    const btcState = computeBtcStateCompat(btcBase, core.SETTINGS);
    const btcTune = btcConfidenceAdjustCompat(mode, btcState, btcBase, core.SETTINGS);
    const btc = { ...btcBase, state: btcState, tune: btcTune };

    const cap = computeStageCap(mode, btc.state);

    // ✅ 3) Slice tot gewenste aantal (core.SETTINGS.CG_TOP staat nu op 1500)
    const cgTop = Number(core?.SETTINGS?.CG_TOP ?? 1500);
    const cg = uni.coins.slice(0, Math.max(1, cgTop));

    // ✅ OB coverage map laden (geen hgetall, gewoon get)
    const obMapBlob = await kv.get(obMapKey(mode));
    const obCoverageMap = obMapBlob && obMapBlob.map ? obMapBlob.map : null;

    // 👇 NIEUW: fail-closed als map ontbreekt of ongeldig is
    if (!obCoverageMap || typeof obCoverageMap !== "object") {
      return send(res, 200, {
        ok: false,
        mode,
        error: `No OB coverage map in KV (${obMapKey(mode)}). Run /api/ob/map_refresh first.`,
      });
    }

    const radar = [];
    const buildup = [];
    const almost = [];
    const entry = [];
    const openTrades = []; // placeholder

    const state = (await kv.get(core.keyState(mode))) || {};

    for (const c of cg) {
      const sym = up(c.symbol);

      // skip coins zonder coverage (geen Bitget USDT pair)
      if (!obCoverageMap[sym]) continue;

      // 1) Radar gate eerst (mcap/vol/vm/range/direction)
      const dyn = typeof core.dynamicRadarThresholds === "function"
        ? core.dynamicRadarThresholds(n(c.range24, 0), core.SETTINGS)
        : null;

      const radarGate = passRadar(core, mode, c, dyn);
      if (!radarGate.ok) continue;

      const vm = radarGate.vm;
      const usedDyn = radarGate.dyn || dyn;

      // 2) HARD OB gate: no fresh+valid OB => RADAR only
      const ob = await getObForSymbol({ mode, symbol: sym });
      if (!ob?.ok || !ob?.valid || !ob?.fresh) {
        radar.push({
          symbol: sym,
          name: c.name || sym,
          price: n(c.price, 0),
          marketCap: n(c.marketCap, 0),
          volume: n(c.volume, 0),
          vm: +n(vm, 0).toFixed(6),
          change1h: +n(c.change1h, 0).toFixed(3),
          change24: +n(c.change24, 0).toFixed(3),
          range24: +n(c.range24, 0).toFixed(3),

          confidence: 0,
          stage: "RADAR",
          stageBase: "RADAR",
          gates: {
            radar: "passed",
            almost: "blocked: missing/invalid/stale orderbook",
            entry: "blocked: missing/invalid/stale orderbook",
          },
          ob: {
            fresh: !!ob?.fresh,
            valid: !!ob?.valid,
            reason: ob?.reason || "no_ob",
            ageSec: ob?.ageSec ?? null,
          },
        });
        continue;
      }

      // OB is ok -> extraheer basis OB-waarden
      const obFresh = !!ob?.fresh;
      const obValid = !!ob?.valid;
      const spreadPct = n(ob?.spreadPct, 999);
      const depthMinUsd1p = n(ob?.depthMinUsd1p, 0);
      const obScore = n(ob?.score, 0);
      const obScoreAbs = Math.abs(obScore);

      // ======================================================
      // Tier baseline: BUILDUP sanity check (als die faalt -> RADAR)
      // ======================================================
      const B = TIER_CFG.buildup;
      const A = TIER_CFG.almost;
      const E = TIER_CFG.entry;

      const buildupOk =
        spreadPct <= B.spreadMaxPct &&
        depthMinUsd1p >= B.depthMinUsd1p &&
        obScoreAbs >= B.obScoreAbsMin;

      if (!buildupOk) {
        radar.push({
          symbol: sym,
          name: c.name || sym,
          price: n(c.price, 0),
          marketCap: n(c.marketCap, 0),
          volume: n(c.volume, 0),
          vm: +n(vm, 0).toFixed(6),
          change1h: +n(c.change1h, 0).toFixed(3),
          change24: +n(c.change24, 0).toFixed(3),
          range24: +n(c.range24, 0).toFixed(3),

          confidence: 0,
          stage: "RADAR",
          stageBase: "RADAR",
          gates: {
            radar: "passed",
            almost: "blocked: OB sanity failed for BUILDUP",
            entry: "blocked: OB sanity failed for BUILDUP",
          },
          ob: {
            fresh: obFresh,
            valid: obValid,
            spreadPct,
            depthMinUsd1p,
            score: obScore,
          },
        });
        continue;
      }

      // Vanaf hier: coin voldoet aan BUILDUP-eisen en heeft een geldig OB

      // Coin stats (voor thresholds en anomaly)
      const coinStats = await updateCoinStatsAndGetMetrics({
        mode,
        sym,
        range24: n(c.range24, 0),
        spreadPct: Number.isFinite(spreadPct) ? spreadPct : null,
        obScore: Number.isFinite(obScore) ? obScore : null,
        now,
      });

      // Bepaal initiële stage op basis van swing (gebruik usedDyn)
      let stageBase = stageFromSwing(mode, { ...c, vm }, usedDyn);

      // Spike detectie
      const curRange = n(c.range24, 0);
      const medRange = Number.isFinite(coinStats?.medRange24) ? coinStats.medRange24 : null;
      const hasStats = n(coinStats?.samples, 0) >= 30;
      const isSpike = hasStats && medRange && medRange > 0 && curRange > 2.2 * medRange && curRange > 10;

      let anomaly = null;
      if (isSpike) {
        anomaly = { type: "RANGE_SPIKE", curRange, medRange, factor: +(curRange / medRange).toFixed(2) };
        if (stageBase === "ALMOST" || stageBase === "ENTRY") stageBase = "BUILDUP";
      }

      // Confidence
      const confidenceBase = core.computeConfidence({
        vm,
        change24: c.change24,
        range24: c.range24,
        obValid: !!obValid,
      });
      const confidence = Math.max(0, Math.min(100, n(confidenceBase, 0) + n(btcTune.adj, 0)));

      // Thresholds (adaptief, maar spread/depth/obScore worden nu door tiers overschreven)
      const baseThr = adaptiveEntryThresholds(core, c, vm);
      let thr =
        typeof core.dynamicEntryThresholds === "function"
          ? core.dynamicEntryThresholds({ marketCap: c.marketCap, volume: c.volume, vm }, baseThr, core.SETTINGS)
          : baseThr;

      // Dynamische aanpassingen op basis van percentiles (optioneel)
      if (thr && Number.isFinite(coinStats?.p80SpreadPct)) {
        const hardMax = Number(core?.SETTINGS?.entry?.dyn?.spreadHardMaxPct ?? 1.6);
        const hardMin = Number(core?.SETTINGS?.entry?.dyn?.spreadHardMinPct ?? 0.55);
        const coinBaseline = coinStats.p80SpreadPct * 1.25;
        const base = Number(thr.spreadMaxPct || 0);
        thr.spreadMaxPct = 0.70 * base + 0.30 * coinBaseline;
        thr.spreadMaxPct = Math.max(hardMin, Math.min(hardMax, thr.spreadMaxPct));
      }

      if (thr && Number.isFinite(coinStats?.p70ObAbs)) {
        const hardMax = Number(core?.SETTINGS?.entry?.dyn?.obScoreHardMax ?? 0.075);
        const hardMin = Number(core?.SETTINGS?.entry?.dyn?.obScoreHardMin ?? 0.04);
        const base = Number(thr.obScoreMin || 0);
        const coin = Number(coinStats.p70ObAbs || 0) * 0.85;
        const blended = 0.65 * base + 0.35 * coin;
        thr.obScoreMin = Math.max(hardMin, Math.min(hardMax, blended));
      }

      let stage = stageBase;
      let almostGate = "n/a";
      let entryGate = "n/a";

      // BTC cap check
      if (cap.cap && (stageBase === "ALMOST" || stageBase === "ENTRY")) {
        stage = "BUILDUP";
        stageBase = "BUILDUP";
        almostGate = `capped: ${cap.capStage}`;
        entryGate = `capped: ${cap.capStage}`;
      } else {
        // ======================================================
        // ALMOST gate (medium filters + slope + spoof)
        // ======================================================
        if (stageBase === "ALMOST") {
          // Tier baseline checks (ALMOST)
          if (spreadPct > A.spreadMaxPct) {
            stage = "BUILDUP";
            stageBase = "BUILDUP";
            almostGate = `blocked: spread>${A.spreadMaxPct}%`;
          } else if (depthMinUsd1p < A.depthMinUsd1p) {
            stage = "BUILDUP";
            stageBase = "BUILDUP";
            almostGate = `blocked: depth1%<${A.depthMinUsd1p}`;
          } else if (obScoreAbs < A.obScoreAbsMin) {
            stage = "BUILDUP";
            stageBase = "BUILDUP";
            almostGate = `blocked: |obScore|<${A.obScoreAbsMin}`;
          } else {
            // slope gate
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
              // spoof gate
              const spoof = spoofRiskFromSamples(obSamples);
              if (!spoof.ok) {
                stage = "BUILDUP";
                stageBase = "BUILDUP";
                almostGate = `blocked: spoof risk (${spoof.why})`;
              } else {
                almostGate = "passed";
              }
            }
          }
        }

        // ======================================================
        // ENTRY gate (hard filters + slope + pressure + absorption)
        // ======================================================
        // Gebruik de huidige stage (na ALMOST gate) in plaats van stageBase
        if (stage === "ALMOST") {
          // Eerst confidence check (adaptief)
          if (confidence < n(thr.minConfidence, 0)) {
            entryGate = `Confidence < ${thr.minConfidence}`;
          }
          // Daarna tier harde grenzen
          else if (spreadPct > E.spreadMaxPct) {
            entryGate = `blocked: spread>${E.spreadMaxPct}%`;
          } else if (depthMinUsd1p < E.depthMinUsd1p) {
            entryGate = `blocked: depth1%<${E.depthMinUsd1p}`;
          } else if (obScoreAbs < E.obScoreAbsMin) {
            entryGate = `blocked: |obScore|<${E.obScoreAbsMin}`;
          } else {
            // Nu de geavanceerde checks
            const obSamples2 = await kv.get(core.keyObSamples(mode, sym));
            // slope gate at entry (met correcte parameter `obSamples`)
            const slopeCheck2 =
              typeof core.checkObSlopeGate === "function"
                ? core.checkObSlopeGate({ stage: "entry", mode, obSamples: obSamples2, settings: core.SETTINGS })
                : { ok: true };

            if (!slopeCheck2.ok) {
              entryGate = slopeCheck2.reason || "OB slope failed at ENTRY";
            } else {
              // pressure align (indien vereist)
              if (E.requirePressureAlign) {
                const pressureDelta = n(ob?.pressureDeltaUsd, 0);
                const pressureOk = mode === "bull" ? pressureDelta >= 0 : pressureDelta <= 0;
                if (!pressureOk) {
                  entryGate = "blocked: pressure contra";
                }
              }

              if (entryGate === "n/a" || entryGate === "passed") {
                // absorption gate
                const absorb = absorptionFromSamples(obSamples2, mode);
                if (!absorb.ok) {
                  entryGate = `blocked: ${absorb.why}`;
                } else {
                  stage = "ENTRY";
                  entryGate = "passed";
                }
              }
            }
          }
        }
      }

      // Anomaly gate (range spike) overschrijft eventuele gates
      if (anomaly?.type === "RANGE_SPIKE") {
        if (almostGate === "n/a") almostGate = `anomaly: range spike x${anomaly.factor}`;
        if (entryGate === "n/a") entryGate = `anomaly: range spike x${anomaly.factor}`;
      }

      // Consistency check
      const upd = updateStateAndConsistency(state, sym, stage, core, now);

      if ((stage === "ALMOST" || stage === "ENTRY") && !upd.consistency?.ok) {
        stage = "BUILDUP";
        if (almostGate === "n/a" || almostGate === "passed") {
          almostGate = `consistency blocked (${upd.consistency.same}/${upd.consistency.need}, minAgree=${upd.consistency.minAgree})`;
        }
        if (entryGate === "n/a" || entryGate === "passed") {
          entryGate = `consistency blocked (${upd.consistency.same}/${upd.consistency.need}, minAgree=${upd.consistency.minAgree})`;
        }
        if (state[sym]) {
          state[sym].stage = "BUILDUP";
          if (Array.isArray(state[sym].hist) && state[sym].hist.length) {
            state[sym].hist[state[sym].hist.length - 1] = "BUILDUP";
          }
        }
      }

      // Bouw item
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

        rationale: DESIGN_RATIONALE,

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

        thr: {
          minConfidence: thr.minConfidence,
          spreadMaxPct: +n(thr.spreadMaxPct, 0).toFixed(3),
          depthMinUsd1p: thr.depthMinUsd1p,
          obScoreMin: +n(thr.obScoreMin, 0).toFixed(5),
          liqScore: thr.liqScore != null ? +n(thr.liqScore, 0).toFixed(3) : null,
        },

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
          fresh: obFresh,
          valid: obValid,
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
      funnel: { radar: outRadar, buildup: outBuildup, almost: outAlmost, entry: outEntry },
      openTrades,
      meta: {
        scanLock: { active: false, until: lock.until, waitMs: 0 },
        counts: { cg: cg.length, radar: radar.length, buildup: buildup.length, almost: almost.length, entry: entry.length },
        rationale: DESIGN_RATIONALE,
        universe: {
          key: K_UNIVERSE_LATEST,
          ts: uni.ts || null,
          pages: uni.pages || null,
          perPage: uni.perPage || null,
          count: uni.count || (Array.isArray(uni.coins) ? uni.coins.length : 0),
          lockKey: K_LOCK_UNIVERSE,
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

// ======================================================
// ✅ Hulpfuncties die in de loop gebruikt worden (moesten na import)
// ======================================================
function passRadar(core, mode, c, dyn) {
  const R = core?.SETTINGS?.radar || {};
  const vm = core.computeVm(c.volume, c.marketCap);

  if (c.marketCap < n(R.mcapMin, 0)) return { ok: false, why: "mcap too low" };
  if (c.marketCap > n(R.mcapMax, Number.MAX_SAFE_INTEGER)) return { ok: false, why: "mcap too high" };
  if (c.volume < n(R.volMin, 0)) return { ok: false, why: "volume too low" };
  if (vm < n(R.vmMin, 0)) return { ok: false, why: "vm too low" };
  if (Math.abs(c.change24) > n(R.maxAbsChg24, 999)) return { ok: false, why: "chg24 too high" };

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

function stageFromSwing(mode, c, dyn) {
  const vm = c.vm;
  const range = c.range24;
  const ch1h = c.change1h;

  const wantUp = mode === "bull";
  const dir1h = wantUp ? n(dyn?.dir1hMinBull, 0.2) : n(dyn?.dir1hMaxBear, -0.2);
  const inDir = wantUp ? ch1h >= dir1h : ch1h <= dir1h;

  if (vm >= 0.24 && range <= n(dyn?.maxRange24, 22) && inDir) return "ALMOST";
  if (vm >= 0.18 && range <= n(dyn?.maxRange24, 28) + 4) return "BUILDUP";
  return "RADAR";
}