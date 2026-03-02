/* EOF: /api/scan.js */
import { kv } from "@vercel/kv";
import { createHash } from "crypto";
import { RUNTIME_CONFIG, requireSecret, getMode } from "../lib/_runtime.js";
import { pushEvent } from "../lib/_analytics.js";
import { getObSnapshot, obMapKey } from "../lib/obStore.js";

export const config = RUNTIME_CONFIG;

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
function fmtPct(x, d = 2) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "—";
  const s = v >= 0 ? "+" : "";
  return `${s}${v.toFixed(d)}%`;
}
function fmtNum(x, d = 2) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "—";
  return v.toFixed(d);
}
function fmtUsd(x, d = 6) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "—";
  return `$${v.toFixed(d)}`;
}

function makeTradeId(mode, sym) {
  return `trd_${String(mode)}_${String(sym)}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

async function safePushEvent(funnel, data) {
  try {
    await pushEvent(funnel, data);
  } catch {}
}

// ✅ OB max age (stale gate)
const OB_MAX_AGE_MS = 120 * 60 * 1000;
const OB_MAX_AGE_SEC = Math.floor(OB_MAX_AGE_MS / 1000);

// ✅ Discord anti-spam
const NOTIFY_COOLDOWN_MS = 25 * 60 * 1000;

// ======================================================
// ✅ TRADE ENGINE
// ======================================================
const TRADE_TTL_SEC = 60 * 60 * 48;
const REENTRY_COOLDOWN_SEC = 60 * 60;

const TIME_STOP_SCANS = 6;
const TIME_STOP_MAXPNL = 0.015;

const HOLD_AFTER_SCANS = 2;

const TP1_PNL = 0.025;
const TP2_PNL = 0.05;
const TRAIL_AFTER_TP1 = 0.022;
const TRAIL_AFTER_TP2 = 0.016;

const SELLS_TTL_SEC = 60 * 60 * 48;
const SELLS_KEEP = 50;

function kTrade(mode, sym) {
  return `trade:${String(mode).toLowerCase()}:${up(sym)}`;
}
function kCooldown(mode, sym) {
  return `trade:cooldown:${String(mode).toLowerCase()}:${up(sym)}`;
}
function kSells(mode) {
  return `trade:sells:${String(mode).toLowerCase()}`;
}

async function logSell(mode, sellObj) {
  const key = kSells(mode);
  const prev = (await kv.get(key)) || [];
  const arr = Array.isArray(prev) ? prev : [];
  arr.push(sellObj);
  const last = arr.slice(-SELLS_KEEP);
  await kv.set(key, last, { ex: SELLS_TTL_SEC });
  return last;
}

function calcPnlPct(mode, entryPrice, nowPrice) {
  const e = n(entryPrice, 0);
  const p = n(nowPrice, 0);
  if (!(e > 0) || !(p > 0)) return 0;

  if (String(mode).toLowerCase() === "bear") return (e - p) / e;
  return (p - e) / e;
}

function stopPctFromRange24(range24Pct) {
  const r = n(range24Pct, 0);
  if (r <= 18) return 0.03;
  if (r <= 28) return 0.035;
  return 0.045;
}

// ✅ Risk/TP helper (voor UI)
function calcRiskLevels(mode, basePrice, range24Pct) {
  const e = n(basePrice, 0);
  if (!(e > 0)) {
    return {
      atrPctProxy: 0,
      stopPct: 0,
      slPrice: null,
      tp1Price: null,
      tp2Price: null,
      tp1Pct: TP1_PNL * 100,
      tp2Pct: TP2_PNL * 100,
    };
  }

  const stopPct = stopPctFromRange24(range24Pct);
  const m = String(mode || "bull").toLowerCase();

  const slPrice = m === "bear" ? e * (1 + stopPct) : e * (1 - stopPct);
  const tp1Price = m === "bear" ? e * (1 - TP1_PNL) : e * (1 + TP1_PNL);
  const tp2Price = m === "bear" ? e * (1 - TP2_PNL) : e * (1 + TP2_PNL);

  return {
    atrPctProxy: stopPct * 100,
    stopPct,
    slPrice,
    tp1Price,
    tp2Price,
    tp1Pct: TP1_PNL * 100,
    tp2Pct: TP2_PNL * 100,
  };
}

function isObAgainst(mode, ob) {
  const pd = n(ob?.pressureDeltaUsd, 0);
  const sc = n(ob?.score, 0);
  if (String(mode).toLowerCase() === "bear") return pd > 0 && sc > 0;
  return pd < 0 && sc < 0;
}

function isObInvalidFresh(obFresh, ob) {
  if (!obFresh) return false;
  if (!ob) return true;
  if (ob.valid === false) return true;
  return false;
}

function pageTradeStatus(tradeInfo) {
  if (!tradeInfo) return "—";
  if (tradeInfo.status === "OPEN") {
    if (Number(tradeInfo.barsOpen) === 0) return "ENTRY";
    return "HOLD";
  }
  return "—";
}

function computeStatsFromSells(sellsOldestToNewest) {
  const arr = Array.isArray(sellsOldestToNewest) ? sellsOldestToNewest : [];
  const totalSells = arr.length;

  const newestFirst = arr.slice().reverse();
  const last50 = newestFirst.slice(0, 50);

  if (!last50.length) {
    return {
      totalSells,
      n50: 0,
      winrate50: 0,
      avgPnl50: 0,
      avgBarsOpen50: 0,
      wins50: 0,
      losses50: 0,
    };
  }

  let wins = 0;
  let pnlSum = 0;
  let barsSum = 0;

  for (const s of last50) {
    const pnl = Number(s?.pnlPct || 0);
    const bars = Number(s?.barsOpen || 0);
    if (pnl > 0) wins++;
    pnlSum += pnl;
    barsSum += bars;
  }

  const n50 = last50.length;
  const losses = n50 - wins;

  return {
    totalSells,
    n50,
    winrate50: wins / n50,
    avgPnl50: pnlSum / n50,
    avgBarsOpen50: barsSum / n50,
    wins50: wins,
    losses50: losses,
  };
}

// --------------------
// Discord helpers
// --------------------
async function sendDiscord(webhook, content) {
  const url = String(webhook || "").trim();
  if (!url) return { ok: false, skipped: true };

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });

    const txt = await r.text().catch(() => "");
    if (!r.ok) return { ok: false, status: r.status, preview: txt.slice(0, 200) };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function stageWebhook(stageUpper) {
  if (stageUpper === "ENTRY") return process.env.DISCORD_WEBHOOK_ELITE;
  if (stageUpper === "HOLD") return process.env.DISCORD_WEBHOOK_ELITE;
  if (stageUpper === "SELL") return process.env.DISCORD_WEBHOOK_ELITE;

  if (stageUpper === "ALMOST") return process.env.DISCORD_WEBHOOK_ALMOST;
  if (stageUpper === "BUILDUP") return process.env.DISCORD_WEBHOOK_BUILDUP;
  if (stageUpper === "RADAR") return process.env.DISCORD_WEBHOOK_RADAR;

  return "";
}

function pushNotice(noticesByHook, webhook, line) {
  const url = String(webhook || "").trim();
  if (!url) return;
  if (!noticesByHook[url]) noticesByHook[url] = [];
  noticesByHook[url].push(line);
}

async function flushNotices(noticesByHook) {
  const urls = Object.keys(noticesByHook || {});
  if (!urls.length) return { sent: 0, failed: 0, details: [] };

  let sent = 0;
  let failed = 0;
  const details = [];

  for (const url of urls) {
    const lines = noticesByHook[url] || [];
    if (!lines.length) continue;

    const CHUNK = 15;
    for (let i = 0; i < lines.length; i += CHUNK) {
      const part = lines.slice(i, i + CHUNK);
      const msg = part.join("\n");

      const r = await sendDiscord(url, msg);
      if (r.ok) sent++;
      else {
        failed++;
        details.push({ webhook: url, ...r });
      }
    }
  }

  return { sent, failed, details };
}

// --------------------
// BTC fetch
// --------------------
async function fetchBtc() {
  const url =
    "https://api.coingecko.com/api/v3/coins/markets" +
    "?vs_currency=usd&ids=bitcoin&order=market_cap_desc&per_page=1&page=1" +
    "&sparkline=false&price_change_percentage=1h,24h";

  const arr = await fetchJson(url);
  const b = arr?.[0] || {};

  const chg1h = n(
    b?.price_change_percentage_1h_in_currency ?? b?.price_change_percentage_1h ?? 0,
    0
  );

  const chg24 = n(
    b?.price_change_percentage_24h_in_currency ?? b?.price_change_percentage_24h ?? 0,
    0
  );

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

// ========== COMPAT-BTC HELPERS ==========
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

  if (st === "NEUTRAL" && cfg.softOpenNeutral) {
    return { adj: 0, why: "BTC NEUTRAL (soft open)" };
  }
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

// --------------------
// Stage cap
// --------------------
function computeStageCap(mode, btcState) {
  const st = normBtcState(btcState);
  const m = String(mode || "").toLowerCase();

  let capStage = "BUILDUP";
  let allowFull = false;

  if (st === "BULL" && m === "bull") allowFull = true;
  if (st === "BEAR" && m === "bear") allowFull = true;

  if (allowFull) {
    return { cap: false, capStage: "FULL", reason: `BTC ${st}: ${m} mag door naar ALMOST/ENTRY` };
  }

  if (st === "NEUTRAL") {
    return { cap: true, capStage, reason: "BTC NEUTRAL: scannen + OB door, maar max BUILDUP (prep-mode)" };
  }

  return { cap: true, capStage, reason: `BTC ${st}: ${m} blijft prep-mode (max BUILDUP)` };
}

// --------------------
// Universe top coins
// --------------------
async function fetchCgTop(limit) {
  const per = Math.min(250, Math.max(50, Number(limit || 250)));
  const url =
    `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc` +
    `&per_page=${per}&page=1&sparkline=false&price_change_percentage=1h,24h`;

  const arr = await fetchJson(url);

  return (arr || []).map((c) => {
    const price = n(c?.current_price, 0);
    const high = n(c?.high_24h, 0);
    const low = n(c?.low_24h, 0);
    const range24 = low > 0 ? ((high - low) / low) * 100 : 0;

    const change24 = n(
      c?.price_change_percentage_24h_in_currency ?? c?.price_change_percentage_24h ?? 0,
      0
    );

    const change1h = n(
      c?.price_change_percentage_1h_in_currency ?? c?.price_change_percentage_1h ?? 0,
      0
    );

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
}

// --------------------
// ✅ Radar gate (MODE-AWARE vanaf start)
// --------------------
function passRadar(core, mode, c) {
  const R = core?.SETTINGS?.radar || {};
  const vm = core.computeVm(c.volume, c.marketCap);

  if (c.marketCap < n(R.mcapMin, 0)) return { ok: false, why: "mcap too low" };
  if (c.marketCap > n(R.mcapMax, Number.MAX_SAFE_INTEGER)) return { ok: false, why: "mcap too high" };
  if (c.volume < n(R.volMin, 0)) return { ok: false, why: "volume too low" };
  if (vm < n(R.vmMin, 0)) return { ok: false, why: "vm too low" };
  if (Math.abs(c.change24) > n(R.maxAbsChg24, 999)) return { ok: false, why: "chg24 too high" };
  if (c.range24 > n(R.maxRange24, 999)) return { ok: false, why: "range24 too high" };

  const m = String(mode || "").toLowerCase();

  if (m === "bull") {
    if (n(c.change1h, 0) < n(R.dir1hMinBull, 0.2)) return { ok: false, why: "dir fail (1h not up)" };
    if (n(c.change24, 0) < n(R.dir24MinBull, 0.5)) return { ok: false, why: "dir fail (24h not up)" };
  } else if (m === "bear") {
    if (n(c.change1h, 0) > n(R.dir1hMaxBear, -0.2)) return { ok: false, why: "dir fail (1h not down)" };
    if (n(c.change24, 0) > n(R.dir24MaxBear, -0.5)) return { ok: false, why: "dir fail (24h not down)" };
  }

  return { ok: true, vm };
}

// --------------------
// Stage logic (SWING)
// --------------------
function stageFromSwing(mode, c) {
  const vm = c.vm;
  const range = c.range24;
  const ch1h = c.change1h;

  const wantUp = mode === "bull";
  const inDir = wantUp ? ch1h >= 0.20 : ch1h <= -0.20;

  if (vm >= 0.24 && range <= 22 && inDir) return "ALMOST";
  if (vm >= 0.18 && range <= 28) return "BUILDUP";
  return "RADAR";
}

// --------------------
// OB loaders
// --------------------
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

// --------------------
// Adaptive entry thresholds
// --------------------
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

  const minConfidenceRaw = Math.max(0, Math.max(baseMinConf, tierMinConf - vmBonus));
  const minConfidence = Math.max(0, minConfidenceRaw);

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

// --------------------
// Consistency + scans
// --------------------
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

  S[sym] = {
    ...prev,
    scans,
    hist,
    lastSeenAt: nowTs,
    stage: st,
  };

  return {
    state: S,
    prevStage,
    stageScans: scans,
    consistency: { ok, ratio, same, total, need, minAgree },
  };
}

function canNotify(stateEntry, nowTs) {
  const lastAt = n(stateEntry?.lastNotifyAt, 0);
  if (lastAt > 0 && nowTs - lastAt < NOTIFY_COOLDOWN_MS) return false;
  return true;
}

function markNotified(stateObj, sym, nowTs) {
  if (!stateObj?.[sym]) return;
  stateObj[sym].lastNotifyAt = nowTs;
}

// ======================================================
// MAIN HANDLER
// ======================================================
export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const mode = getMode(req); // "bull" or "bear"

    const coreMod = await import(`../lib/_core_${mode}.js`);
    const core = coreMod?.default ? coreMod.default : coreMod;

    const now = Date.now();

    const btcBase = await fetchBtc();
    const btcState = computeBtcStateCompat(btcBase, core.SETTINGS);
    const btcTune = btcConfidenceAdjustCompat(mode, btcState, btcBase, core.SETTINGS);
    const btc = { ...btcBase, state: btcState, tune: btcTune };

    const cap = computeStageCap(mode, btc.state);
    const allowEntry = cap.cap === false;

    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");

    const cg = await fetchCgTop(core.SETTINGS.CG_TOP);

    const radar = [];
    const buildup = [];
    const almost = [];
    const entry = [];
    const openTrades = [];

    const state = (await kv.get(core.keyState(mode))) || {};
    await loadObMap(mode); // keep warm (optional)
    const noticesByHook = {};

    for (const c of cg) {
      const radarGate = passRadar(core, mode, c);
      if (!radarGate.ok) continue;

      const vm = radarGate.vm;
      const sym = up(c.symbol);
      const priceNow = n(c.price, 0);

      let stageBase = stageFromSwing(mode, { ...c, vm });

      // OB
      const ob = await getObForSymbol({ mode, symbol: sym });

      const obTs = n(ob?.ts, 0);
      const obAge = obTs > 0 ? now - obTs : Number.POSITIVE_INFINITY;
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

      let almostGate = "n/a";
      let entryGate = "n/a";
      let stage = stageBase;

      if (cap.cap && (stageBase === "ALMOST" || stageBase === "ENTRY")) {
        stage = "BUILDUP";
        almostGate = `capped: ${cap.capStage}`;
        entryGate = `capped: ${cap.capStage}`;
      } else {
        let obSamples = null;

        if (stageBase === "ALMOST") {
          obSamples = await kv.get(core.keyObSamples(mode, sym));
          const slopeCheck =
            typeof core.checkObSlopeGate === "function"
              ? core.checkObSlopeGate({ stage: "almost", mode, obSamples, settings: core.SETTINGS })
              : { ok: true };

          if (!slopeCheck.ok) {
            stageBase = "BUILDUP";
            stage = "BUILDUP";
            almostGate = slopeCheck.reason || "OB slope failed in ALMOST";
          } else {
            almostGate = "passed";
          }
        }

        if (stageBase === "ALMOST") {
          if (!ob || ob.ok === false) entryGate = "OB missing";
          else if (!obFresh) entryGate = `OB stale (${Math.round(obAge / 1000)}s)`;
          else if (!obValid) entryGate = "OB invalid";
          else if (confidence < n(thr.minConfidence, 0)) entryGate = `Confidence < ${thr.minConfidence}`;
          else if (spreadPct > n(thr.spreadMaxPct, 999)) entryGate = `Spread > ${thr.spreadMaxPct}%`;
          else if (depthMinUsd1p < n(thr.depthMinUsd1p, 0)) entryGate = `Depth1% < $${thr.depthMinUsd1p}`;
          else if (Math.abs(obScore) < n(thr.obScoreMin, 0)) entryGate = `OB score < ${thr.obScoreMin}`;
          else {
            if (!obSamples) obSamples = await kv.get(core.keyObSamples(mode, sym));

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

      // ======================================================
      // TRADE ENGINE
      // ======================================================
      const tKey = kTrade(mode, sym);
      const cdKey = kCooldown(mode, sym);

      const cooldown = await kv.get(cdKey);
      const tradeExisting = await kv.get(tKey);

      let tradeInfo = null;

      if (tradeExisting && tradeExisting?.status === "OPEN") {
        const entryPrice = n(tradeExisting.entryPrice, 0);
        const barsOpen = n(tradeExisting.barsOpen, 0) + 1;

        const pnl = calcPnlPct(mode, entryPrice, priceNow);
        const maxPnl = Math.max(n(tradeExisting.maxPnl, 0), pnl);

        const stopPct = stopPctFromRange24(c.range24);

        const hardStopHit =
          String(mode).toLowerCase() === "bear"
            ? priceNow >= entryPrice * (1 + stopPct)
            : priceNow <= entryPrice * (1 - stopPct);

        const obAgainst = obFresh ? isObAgainst(mode, ob) : false;
        const obInvalid = isObInvalidFresh(obFresh, ob);
        const badNow = obFresh && (obAgainst || obInvalid);
        const obBadStreak = badNow ? n(tradeExisting.obBadStreak, 0) + 1 : 0;

        const obBreakHit = obBadStreak >= 2;
        const timeStopHit = barsOpen >= TIME_STOP_SCANS && maxPnl < TIME_STOP_MAXPNL;

        const drawdown = maxPnl - pnl;

        let trailHit = false;
        let trailCfg = null;

        if (maxPnl >= TP2_PNL) {
          trailHit = drawdown >= TRAIL_AFTER_TP2;
          trailCfg = { level: "TP2", trail: TRAIL_AFTER_TP2, drawdown };
        } else if (maxPnl >= TP1_PNL) {
          trailHit = drawdown >= TRAIL_AFTER_TP1;
          trailCfg = { level: "TP1", trail: TRAIL_AFTER_TP1, drawdown };
        }

        let exit = null;
        if (hardStopHit) exit = { reason: "HARD_STOP", stopPct, pnl };
        else if (trailHit) exit = { reason: "TRAILING_TP", pnl, maxPnl, trailCfg };
        else if (obBreakHit) exit = { reason: "OB_BREAK_2X", obBadStreak, obFresh, obValid, obAgainst, pnl };
        else if (timeStopHit) exit = { reason: "TIME_STOP_NO_MOMENTUM", barsOpen, maxPnl, pnl };

        if (exit) {
          await kv.del(tKey);
          await kv.set(cdKey, { ts: now, reason: exit.reason }, { ex: REENTRY_COOLDOWN_SEC });

          const tradeId = String(tradeExisting.tradeId || "");

          await logSell(mode, {
            ts: now,
            tradeId,
            symbol: sym,
            side: String(mode).toLowerCase(),
            reason: exit.reason,
            pnlPct: pnl,
            maxPnlPct: maxPnl,
            entryPrice,
            exitPrice: priceNow,
            barsOpen,
            extra: exit?.trailCfg ? { trailCfg: exit.trailCfg } : undefined,
          });

          const givebackPct = Math.max(0, (maxPnl - pnl) * 100);

          await safePushEvent("main", {
            type: "trade_close",
            tradeId,
            mode,
            symbol: sym,
            reason: exit.reason,
            entryPrice,
            exitPrice: priceNow,
            pnlPct: pnl * 100,
            maxPnlPct: maxPnl * 100,
            givebackPct,
            barsOpen,
          });

          const hook = stageWebhook("SELL");
          const line =
            `**${sym}** (${mode.toUpperCase()})  ` +
            `**SELL** • ${exit.reason}  ` +
            `pnl ${fmtPct(pnl * 100, 2)} • max ${fmtPct(maxPnl * 100, 2)} • ` +
            `giveback ${fmtPct(givebackPct, 2)} • ` +
            `price ${fmtUsd(priceNow, 6)}`;
          pushNotice(noticesByHook, hook, line);

          tradeInfo = { status: "CLOSED", exit, pnl, maxPnl, exitAt: now, barsOpen };
        } else {
          const updated = {
            ...tradeExisting,
            barsOpen,
            maxPnl,
            lastPrice: priceNow,
            lastSeenAt: now,
            obBadStreak,
          };

          if (!updated.holdNotified && barsOpen >= HOLD_AFTER_SCANS) {
            const hook = stageWebhook("HOLD");
            const line =
              `**${sym}** (${mode.toUpperCase()})  ` +
              `**HOLD** • trade loopt  ` +
              `pnl ${fmtPct(pnl * 100, 2)} • max ${fmtPct(maxPnl * 100, 2)} • ` +
              `price ${fmtUsd(priceNow, 6)}`;
            pushNotice(noticesByHook, hook, line);
            updated.holdNotified = true;
          }

          await kv.set(tKey, updated, { ex: TRADE_TTL_SEC });

          tradeInfo = {
            status: "OPEN",
            tradeId: String(updated.tradeId || ""),
            entryPrice,
            entryAt: n(updated.entryAt, 0),
            barsOpen,
            pnl,
            maxPnl,
            stopPct,
            obBadStreak,
            trail: { tp1: TP1_PNL, tp2: TP2_PNL, dd: maxPnl - pnl },
          };
        }
      }

      if (!tradeInfo) {
        const inCooldown = !!cooldown;
        const isEntrySignal = stage === "ENTRY" && allowEntry;

        if (isEntrySignal && !inCooldown && priceNow > 0) {
          const tradeId = makeTradeId(mode, sym);

          const tradeObj = {
            status: "OPEN",
            tradeId,
            mode,
            symbol: sym,
            entryPrice: priceNow,
            entryAt: now,
            barsOpen: 0,
            maxPnl: 0,
            obBadStreak: 0,
            holdNotified: false,
            lastSeenAt: now,
            lastPrice: priceNow,
            entryConfidence: confidence,
            entryVm: vm,
            entryRange24: c.range24,
            entryMeta: { entryGate, almostGate, confidence, vm, spreadPct, depthMinUsd1p, obScore },
          };

          await kv.set(tKey, tradeObj, { ex: TRADE_TTL_SEC });

          await safePushEvent("main", {
            type: "trade_open",
            tradeId,
            mode,
            symbol: sym,
            entryPrice: priceNow,
            confidence,
            vm,
            entryGate,
          });

          const hook = stageWebhook("ENTRY");
          const line =
            `**${sym}** (${mode.toUpperCase()})  ` +
            `**ENTRY** • instap  ` +
            `conf ${n(confidence, 0)}/100 • vm ${fmtNum(vm, 2)} • ` +
            `price ${fmtUsd(priceNow, 6)}`;
          pushNotice(noticesByHook, hook, line);

          tradeInfo = {
            status: "OPEN",
            tradeId,
            entryPrice: priceNow,
            entryAt: now,
            barsOpen: 0,
            pnl: 0,
            maxPnl: 0,
          };
        }
      }

      const prevEntry = safeObj(state[sym]) || {};
      const stFix = updateStateAndConsistency(state, sym, stage, core, now);

      const prevStage = up(stFix.prevStage);
      const currStage = up(stage);

      if (prevStage && prevStage !== currStage) {
        await safePushEvent("main", {
          type: "stage_change",
          mode,
          symbol: sym,
          from: prevStage,
          to: currStage,
          reason: currStage === "ENTRY" ? entryGate : currStage === "ALMOST" ? almostGate : "stage_logic",
          confidence,
          vm,
        });
      }

      const hasOpenTrade = tradeInfo?.status === "OPEN";

      if (!hasOpenTrade && prevStage) {
        const doNotify = canNotify(prevEntry, now);
        const isFunnelStage = currStage === "RADAR" || currStage === "BUILDUP" || currStage === "ALMOST";

        if (doNotify && isFunnelStage && prevStage !== currStage) {
          const hook = stageWebhook(currStage);
          const line =
            `**${sym}** (${mode.toUpperCase()})  ` +
            `${prevStage} → **${currStage}**  ` +
            `conf ${n(confidence, 0)}/100 • vm ${fmtNum(vm, 2)} • ` +
            `1h ${fmtPct(c.change1h, 2)} • 24h ${fmtPct(c.change24, 2)} • ` +
            `price ${fmtUsd(priceNow, 6)}`;
          pushNotice(noticesByHook, hook, line);
          markNotified(state, sym, now);
        }
      }

      if (tradeInfo?.status === "OPEN") {
        openTrades.push({
          symbol: sym,
          side: String(mode).toLowerCase(),
          tradeId: String(tradeInfo.tradeId || ""),
          entryPrice: n(tradeInfo.entryPrice, 0),
          entryAt: n(tradeInfo.entryAt, 0),
          barsOpen: n(tradeInfo.barsOpen, 0),
          pnlPct: n(tradeInfo.pnl, 0),
          maxPnlPct: n(tradeInfo.maxPnl, 0),
          price: priceNow,
          confidence,
          vm,
        });
      }

      const riskBasePrice = tradeInfo?.status === "OPEN" ? n(tradeInfo.entryPrice, priceNow) : priceNow;
      const risk = calcRiskLevels(mode, riskBasePrice, c.range24);

      const item = {
        id: c.id,
        symbol: sym,
        name: c.name,
        price: priceNow,
        volume: c.volume,
        marketCap: c.marketCap,
        change24: +c.change24.toFixed(4),
        change1h: +c.change1h.toFixed(4),
        range24: +c.range24.toFixed(4),
        vm: +vm.toFixed(6),
        volAcc: +vm.toFixed(6),

        confidenceBase,
        confidence,
        confidenceBtcAdj: btcTune.adj,

        stage: currStage,

        trade: tradeInfo,
        tradeStatus: pageTradeStatus(tradeInfo),

        stageScans: stFix.stageScans,
        consistency: stFix.consistency,

        risk: {
          atrPctProxy: Number(n(risk.atrPctProxy, 0)),
          stopPct: Number(n(risk.stopPct, 0)),
          slPrice: risk.slPrice == null ? null : Number(risk.slPrice),
          tp1Price: risk.tp1Price == null ? null : Number(risk.tp1Price),
          tp2Price: risk.tp2Price == null ? null : Number(risk.tp2Price),
          tp1Pct: Number(n(risk.tp1Pct, TP1_PNL * 100)),
          tp2Pct: Number(n(risk.tp2Pct, TP2_PNL * 100)),
          basePrice: Number(n(riskBasePrice, 0)),
          basis: tradeInfo?.status === "OPEN" ? "ENTRY_PRICE" : "CURRENT_PRICE",
        },

        req: {
          minConfidence: thr.minConfidence,
          spreadMaxPct: thr.spreadMaxPct,
          depthMinUsd1p: thr.depthMinUsd1p,
          obScoreMin: thr.obScoreMin,
        },

        ob: ob
          ? {
              valid: !!ob.valid,
              fresh: !!ob.fresh,
              stale: !!ob.stale,
              ageSec: obTs > 0 ? Math.round(obAge / 1000) : ob.ageSec ?? null,
              reason: String(ob.reason || ""),
              score: Number(n(obScore, 0)),
              spreadPct: Number(n(spreadPct, 999)),
              depthMinUsd1p: Number(n(depthMinUsd1p, 0)),
              pressureDeltaUsd: Number(n(ob.pressureDeltaUsd, 0)),
              ts: obTs || null,
            }
          : { status: "none" },

        why: { almostGate, entryGate },
      };

      if (currStage === "ENTRY") entry.push(item);
      else if (currStage === "ALMOST") almost.push(item);
      else if (currStage === "BUILDUP") buildup.push(item);
      else radar.push(item);
    }

    entry.sort((a, b) => b.confidence - a.confidence || b.vm - a.vm);
    almost.sort((a, b) => b.confidence - a.confidence || b.vm - a.vm);
    buildup.sort((a, b) => b.vm - a.vm);
    radar.sort((a, b) => b.vm - a.vm);

    openTrades.sort((a, b) => b.pnlPct - a.pnlPct || b.maxPnlPct - a.maxPnlPct);

    const discord = await flushNotices(noticesByHook);

    const sellsRaw = (await kv.get(kSells(mode))) || [];
    const sellsArr = Array.isArray(sellsRaw) ? sellsRaw.slice(-SELLS_KEEP) : [];
    const recentSells = sellsArr.slice().reverse();
    const stats = computeStatsFromSells(sellsArr);

    const result = {
      ok: true,
      ts: now,
      mode,
      btc,
      meta: {
        cadence: "30m",
        cgCache: {
          freshTtlSec: CG_FRESH_TTL_SEC,
          staleTtlSec: CG_STALE_TTL_SEC,
          note: "Fresh cache voorkomt dubbele bull/bear calls; stale fallback houdt scanner draaiend bij 429.",
        },
        btcPolicy:
          "24h regime + 1h confidence fine-tune; NEUTRAL/opposite => cap to BUILDUP (prep), maar scan+OB blijven lopen",
        capActive: !!cap.cap,
        capStage: cap.capStage,
        capReason: cap.reason,
        allowEntry,
      },
      counts: {
        entry: entry.length,
        almost: almost.length,
        buildup: buildup.length,
        radar: radar.length,
        openTrades: openTrades.length,
        recentSells: recentSells.length,
      },
      funnel: { entry, almost, buildup, radar },
      trading: {
        openTrades,
        recentSells,
        stats: {
          ...stats,
          winrate50Pct: stats.winrate50 * 100,
          avgPnl50Pct: stats.avgPnl50 * 100,
        },
      },
      discord: {
        enabled: true,
        sent: discord.sent,
        failed: discord.failed,
        errors: (discord.details || []).slice(0, 5),
      },
    };

    await kv.set(core.keyLatest(mode), result);
    await kv.set(core.keyState(mode), state);

    res.statusCode = 200;
    return res.end(JSON.stringify(result));
  } catch (e) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}