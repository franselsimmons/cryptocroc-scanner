/* EOF: /api/scan.js */
import { kv } from "@vercel/kv";
import { createHash } from "crypto";
import { RUNTIME_CONFIG, requireSecret, getMode } from "../lib/_runtime.js";
import { pushEvent } from "../lib/_analytics.js";
import { getObSnapshot, obMapKey } from "../lib/obStore.js";

export const config = RUNTIME_CONFIG;

// ======================================================
// ✅ 30 MIN SCAN LOCK (BELANGRIJK)
// ======================================================
const SCAN_INTERVAL_SEC = 30 * 60; // 30 minuten

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  return res.end(JSON.stringify(obj));
}

async function tryAcquireScanLock(mode) {
  const key = `scan:lock:${String(mode).toLowerCase()}`;
  const now = Date.now();

  const cur = await kv.get(key);
  const until = Number(cur?.until || 0);

  // lock actief
  if (until > now) {
    return { ok: false, key, until, now, waitMs: until - now };
  }

  // lock zetten
  const nextUntil = now + SCAN_INTERVAL_SEC * 1000;
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
  try { j = JSON.parse(t); } catch {}

  if (!r.ok) throw new Error(`Fetch failed ${r.status}: ${t.slice(0, 160)}`);

  await kv.set(key, j, { ex: CG_FRESH_TTL_SEC });
  await kv.set(staleKey, j, { ex: CG_STALE_TTL_SEC });

  return j;
}

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}
function safeObj(x) { return x && typeof x === "object" ? x : null; }
function up(x) { return String(x || "").toUpperCase(); }
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
  try { await pushEvent(funnel, data); } catch {}
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

function kTrade(mode, sym) { return `trade:${String(mode).toLowerCase()}:${up(sym)}`; }
function kCooldown(mode, sym) { return `trade:cooldown:${String(mode).toLowerCase()}:${up(sym)}`; }
function kSells(mode) { return `trade:sells:${String(mode).toLowerCase()}`; }

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

function stageFromSwing(mode, c) {
  const vm = c.vm;
  const range = c.range24;
  const ch1h = c.change1h;

  const wantUp = mode === "bull";
  const inDir = wantUp ? ch1h >= 0.2 : ch1h <= -0.2;

  if (vm >= 0.24 && range <= 22 && inDir) return "ALMOST";
  if (vm >= 0.18 && range <= 28) return "BUILDUP";
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

    const mode = getMode(req); // bull / bear
    const coreMod = await import(`../lib/_core_${mode}.js`);
    const core = coreMod?.default ? coreMod.default : coreMod;

    const now = Date.now();

    // ✅ LOCK CHECK: binnen 30 min -> return latest, geen scan
    const lock = await tryAcquireScanLock(mode);
    if (!lock.ok) {
      const latest = await kv.get(core.keyLatest(mode));
      if (latest) {
        // handige meta erbij: laat zien dat dit “snapshot” is
        latest.meta = latest.meta || {};
        latest.meta.scanLock = { active: true, until: lock.until, waitMs: lock.waitMs };
        return send(res, 200, latest);
      }
      return send(res, 200, {
        ok: false,
        mode,
        error: "scan locked and no latest yet",
        scanLock: { active: true, until: lock.until, waitMs: lock.waitMs },
      });
    }

    // ======= jouw bestaande scan code vanaf hier (ongewijzigd gedrag) =======
    const btcBase = await fetchBtc();
    const btcState = computeBtcStateCompat(btcBase, core.SETTINGS);
    const btcTune = btcConfidenceAdjustCompat(mode, btcState, btcBase, core.SETTINGS);
    const btc = { ...btcBase, state: btcState, tune: btcTune };

    const cap = computeStageCap(mode, btc.state);
    const allowEntry = cap.cap === false;

    const cg = await fetchCgTop(core.SETTINGS.CG_TOP);

    const radar = [];
    const buildup = [];
    const almost = [];
    const entry = [];
    const openTrades = [];

    const state = (await kv.get(core.keyState(mode))) || {};
    await loadObMap(mode);

    const noticesByHook = {};

    for (const c of cg) {
      const radarGate = passRadar(core, mode, c);
      if (!radarGate.ok) continue;

      const vm = radarGate.vm;
      const sym = up(c.symbol);
      const priceNow = n(c.price, 0);

      let stageBase = stageFromSwing(mode, { ...c, vm });

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

      // ===== trade engine + rest van jouw code blijft hetzelfde =====
      // (hierna exact jouw bestaande code: trades, push events, sorting, kv.set latest/state)

      // ---- jouw bestaande trade engine etc. (niet nog eens herhaald) ----

      // TIP: plak hier jouw bestaande “for loop body” door tot het einde.
      // In jouw repo vervang je alleen het begin + lock + send helpers.
    }

    // ✅ LET OP: jij moet hier je bestaande sort + result + kv.set blok laten staan.
    // Ik kan jouw hele einde er ook onder zetten, maar dat is 1-op-1 copy van wat je al hebt.

    // Als je wil: stuur het laatste stuk (na de for-loop) mee, dan plak ik hem er exact onder.
    return send(res, 200, { ok: false, error: "You must paste your existing tail (sort/result/kv.set) below." });
  } catch (e) {
    return send(res, 200, { ok: false, error: String(e?.message || e) });
  }
}