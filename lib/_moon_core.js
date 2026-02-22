// /lib/_moon_core.js
import { kv } from "@vercel/kv";

export const RUNTIME_CONFIG = { runtime: "nodejs" };

// ================== SECRETS / AUTH ==================
export function requireSecret(req, res) {
  const token =
    String(req.query?.token || "") ||
    String(req.headers?.["x-cron-secret"] || "") ||
    String(req.headers?.["x-token"] || "");

  const secret = String(process.env.CRON_SECRET || "");
  if (!secret) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "Missing CRON_SECRET env var" }));
    return false;
  }
  if (!token || token !== secret) {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
    return false;
  }
  return true;
}

export function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return String(v);
}

// ================== DISCORD ==================
export async function sendDiscord(webhookUrl, content) {
  const url = String(webhookUrl || "").trim();
  if (!url) return { ok: false, skip: true };
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: String(content || "").slice(0, 1900) }),
    });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export function webhookForMoonStage(stage) {
  const s = String(stage || "").toUpperCase();
  if (s === "RADAR") return process.env.DISCORD_WEBHOOK_MOON_RADAR || "";
  if (s === "BUILDUP") return process.env.DISCORD_WEBHOOK_MOON_BUILDUP || "";
  if (s === "ALMOST") return process.env.DISCORD_WEBHOOK_MOON_ALMOST || "";
  if (s === "ELITE") return process.env.DISCORD_WEBHOOK_MOON_ELITE || "";
  return "";
}

export function webhookMoonPortfolio() {
  return process.env.DISCORD_WEBHOOK_MOON_PORTFOLIO || "";
}

export function fmtModeLabel(mode) {
  return mode === "bear" ? "SHORT" : "LONG";
}

export function fmtTs(ts) {
  const d = new Date(Number(ts || 0) || Date.now());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${da} ${h}:${mi}`;
}

export function durMinutes(a, b) {
  const A = Number(a || 0), B = Number(b || 0);
  if (!(A > 0 && B > 0 && B >= A)) return 0;
  return Math.round((B - A) / 60000);
}

export function fmtMoonLine(item, mode, extra = "", tsNow = Date.now()) {
  const side = fmtModeLabel(mode);
  const sym = String(item?.symbol || "");
  const stage = String(item?.stage || "");
  const px = Number(item?.price || 0);
  const ch = Number(item?.change24 || 0);
  const vm = Number(item?.vm || 0);
  const conf = Number(item?.confidence || 0);

  const ob = item?.ob || {};
  const obScore = Number(ob?.score ?? 0);
  const spread = Number(ob?.spreadPct ?? 0);

  const line1 = `**${sym}** → **${stage}** (MOON ${side})`;
  const line2 = `t: ${fmtTs(tsNow)} | $${px.toFixed(8)} | 24h: ${ch >= 0 ? "+" : ""}${ch.toFixed(2)}% | VM: ${vm.toFixed(3)} | conf: ${conf}/100`;
  const line3 = `OB: score ${obScore.toFixed(4)} | spread ${spread.toFixed(3)}%`;
  const line4 = extra ? `\n${extra}` : "";
  return `${line1}\n${line2}\n${line3}${line4}`;
}

// ================== KEYS (KV) ==================
const NS = "cc:moon";

export const keyMoonLatest = (mode) => `${NS}:latest:${mode}`;
export const keyMoonState = (mode) => `${NS}:state:${mode}`;
export const keyMoonReset = (mode) => `${NS}:reset:${mode}`;

export const keyMoonPortfolio = (mode) => `${NS}:portfolio:${mode}`;
export const keyMoonPositions = (mode) => `${NS}:positions:${mode}`;

export const keyMoonObSamples = (mode, symbol) => `${NS}:ob:samples:${mode}:${String(symbol).toUpperCase()}`;
export const keyMoonObResult = (mode, symbol) => `${NS}:ob:result:${mode}:${String(symbol).toUpperCase()}`;

export const keyMoonDiagList = (mode) => `${NS}:diag:list:${mode}`;
export const keyMoonDiagSnap = (mode) => `${NS}:diag:snap:${mode}`;

// ================== CONFIG (MOON) ==================
export const MOON = {
  CG_PER_PAGE: 250,
  CG_START_PAGE: 1,
  CG_PAGES: 2,
  RADAR_LIMIT: 120,
  btcChgGate: 0.35,
  btcRangeMin: 0.8,
  btcRangeMaxBull: 9.5,
  btcRangeMaxBear: 11.0,
  mcapMin: 8_000_000,
  mcapMax: 450_000_000,
  radar: {
    minVol24h: 2_000_000,
    minVm: 0.10,
    maxRange24: 40,
  },
  buildup: {
    minVolAcc: 1.2,
  },
  almost: {
    minConfidence: 55,
    maxFlat60Pct: 2.2,
  },
  elite: {
    minConfidence: 65,
    consistencyMin: 1.0,
    obScoreMin: 0.06,
    spreadMaxPct: 0.35,
    largestOrderRatioMax: 0.65,
    samplesNeed: 4,
    samplesWindowSec: 240,
    minAgree: 3,
    depthK: 0.0012,
    depthMinUsd: 2_000,
    depthMaxUsd: 500_000,
    range24Max: 28,
    obSlopeEnabled: true,
    obSlopeMinBull: 0.0008,
    obSlopeMaxBear: -0.0008,
    roll: {
      maxDeltaPrice15mPct: 2.6,
      minDeltaVol15m: 0.8,
      needCompression: false,
      minObSlope: 0.0003,
      maxObStability: 0.12,
    },
  },
  portfolio: {
    posUsd: 50,
    maxOpen: 4,
    closeOnBtcFlip: true,
  },
};

// ================== HELPERS ==================
function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

// ================== BTC GATE (cached) ==================
const KEY_BTC = "cc:btc:gate";
export async function fetchBTCGateCached() {
  const cached = await kv.get(KEY_BTC);
  const now = Date.now();
  if (cached?.ts && now - cached.ts < 60_000) return cached;

  const url =
    "https://api.coingecko.com/api/v3/coins/markets?" +
    new URLSearchParams({
      vs_currency: "usd",
      ids: "bitcoin",
      order: "market_cap_desc",
      per_page: "1",
      page: "1",
      sparkline: "false",
      price_change_percentage: "24h",
    });

  const r = await fetch(url, { headers: { accept: "application/json" } });
  const j = await r.json().catch(() => null);

  const row = Array.isArray(j) ? j[0] : null;

  const chg24 = n(row?.price_change_percentage_24h, 0);
  const high = n(row?.high_24h, 0);
  const low = n(row?.low_24h, 0);
  const range24 = high > 0 && low > 0 ? ((high - low) / ((high + low) / 2)) * 100 : 0;

  let state = "NEUTRAL";
  if (chg24 >= MOON.btcChgGate) state = "BULL";
  else if (chg24 <= -MOON.btcChgGate) state = "BEAR";

  const out = { ts: now, state, chg24: +chg24.toFixed(3), range24: +range24.toFixed(3) };
  await kv.set(KEY_BTC, out, { ex: 70 });
  return out;
}

export function isModeAllowedByBtc(mode, btcState) {
  const s = String(btcState || "NEUTRAL").toUpperCase();
  if (s === "NEUTRAL") return true;
  if (mode === "bull") return s === "BULL";
  return s === "BEAR";
}

// ================== COINGECKO TOP (cached) ==================
const KEY_CG = "cc:cg:top";
export async function fetchCoinGeckoTopCached() {
  const cached = await kv.get(KEY_CG);
  const now = Date.now();
  if (cached?.ts && now - cached.ts < 120_000 && Array.isArray(cached?.list)) return cached.list;

  const all = [];
  for (let p = MOON.CG_START_PAGE; p < MOON.CG_START_PAGE + MOON.CG_PAGES; p++) {
    const url =
      "https://api.coingecko.com/api/v3/coins/markets?" +
      new URLSearchParams({
        vs_currency: "usd",
        order: "volume_desc",
        per_page: String(MOON.CG_PER_PAGE),
        page: String(p),
        sparkline: "false",
        price_change_percentage: "1h,24h",
      });

    const r = await fetch(url, { headers: { accept: "application/json" } });
    const j = await r.json().catch(() => []);
    if (!Array.isArray(j)) continue;

    for (const row of j) {
      const price = n(row?.current_price, 0);
      const volume = n(row?.total_volume, 0);
      const marketCap = n(row?.market_cap, 0);
      const high = n(row?.high_24h, 0);
      const low = n(row?.low_24h, 0);

      const range24 = high > 0 && low > 0 ? ((high - low) / ((high + low) / 2)) * 100 : 0;

      all.push({
        id: String(row?.id || ""),
        symbol: String(row?.symbol || "").toUpperCase(),
        name: String(row?.name || ""),
        price,
        volume,
        marketCap,
        change24: n(row?.price_change_percentage_24h, 0),
        change1h: n(row?.price_change_percentage_1h_in_currency, 0),
        range24,
        vm: marketCap > 0 ? volume / marketCap : 0,
      });
    }
  }

  await kv.set(KEY_CG, { ts: now, list: all }, { ex: 130 });
  return all;
}

// ================== BITGET SYMBOLS (cached) ==================
const KEY_BG = "cc:bitget:spot:usdt:symbols";
export async function getBitgetSpotUsdtSymbols() {
  const cached = await kv.get(KEY_BG);
  const now = Date.now();
  if (cached?.ts && now - cached.ts < 10 * 60_000 && Array.isArray(cached?.symbols)) {
    return new Set(cached.symbols);
  }

  const url = "https://api.bitget.com/api/v2/spot/public/symbols";
  const r = await fetch(url, { headers: { accept: "application/json" } });
  const j = await r.json().catch(() => null);

  if (!r.ok || String(j?.code || "") !== "00000") {
    return new Set();
  }

  const set = new Set();
  for (const row of j?.data || []) {
    const status = String(row?.status || "").toLowerCase();
    const quote = String(row?.quoteCoin || "");
    const base = String(row?.baseCoin || "");
    if (status !== "online") continue;
    if (quote !== "USDT") continue;
    if (!base) continue;
    set.add(base.toUpperCase());
  }

  await kv.set(KEY_BG, { ts: now, symbols: Array.from(set) }, { ex: 12 * 60 });
  return set;
}

// ================== HIST / ACC ==================
export function updatePriceHist(prev, price) {
  const arr = Array.isArray(prev) ? [...prev] : [];
  const p = n(price, 0);
  if (p > 0) arr.push(p);
  return arr.slice(-120);
}

export function updateVolHist(prev, vol) {
  const arr = Array.isArray(prev) ? [...prev] : [];
  const v = n(vol, 0);
  if (v >= 0) arr.push(v);
  return arr.slice(-120);
}

export function volAccFromHist(volHist) {
  const a = Array.isArray(volHist) ? volHist : [];
  if (a.length < 2) return 1;
  const first = n(a[0], 0);
  const last = n(a[a.length - 1], 0);
  if (!(first > 0 && last > 0)) return 1;
  return clamp(last / first, 0, 50);
}

export function priceFlatPct(priceHist, lastN = 60) {
  const a = Array.isArray(priceHist) ? priceHist : [];
  const slice = a.slice(-Math.max(2, lastN));
  if (slice.length < 2) return 0;
  const min = Math.min(...slice);
  const max = Math.max(...slice);
  const mid = (min + max) / 2;
  if (!(mid > 0)) return 0;
  return ((max - min) / mid) * 100;
}

// ================== CONFIDENCE / DEPTH FLOOR ==================
export function depthFloorUsd(mcap) {
  const mc = n(mcap, 0);
  const floor = mc * n(MOON.elite.depthK, 0.0012);
  return clamp(floor, MOON.elite.depthMinUsd, MOON.elite.depthMaxUsd);
}

export function computeConfidence({ obScore, obAgree, vm, volAcc, btc }) {
  const vmN = clamp(n(vm, 0), 0, 6);
  const volN = clamp(n(volAcc, 1), 0, 8);
  const obN = clamp(Math.abs(n(obScore, 0)) * 8, 0, 2.5);
  const agreeN = clamp(n(obAgree, 0), 0, 6);

  const btcCh = Math.abs(n(btc?.chg24, 0));
  const btcN = clamp(btcCh / 3, 0, 1);

  let score =
    18 +
    vmN * 10 +
    volN * 6 +
    obN * 18 +
    agreeN * 5 -
    btcN * 8;

  return clamp(Math.round(score), 0, 100);
}

// ================== FILTERS (PASS) ==================
export function passRadarMoon(c, mode) {
  const mc = n(c?.marketCap, 0);
  const vol = n(c?.volume, 0);
  const vm = n(c?.vm, 0);
  const range24 = n(c?.range24, 0);

  if (!(mc >= MOON.mcapMin && mc <= MOON.mcapMax)) return false;
  if (vol < MOON.radar.minVol24h) return false;
  if (vm < MOON.radar.minVm) return false;
  if (range24 > MOON.radar.maxRange24) return false;

  const ch24 = n(c?.change24, 0);
  if (mode === "bull" && ch24 < -22) return false;
  if (mode === "bear" && ch24 > 22) return false;

  return true;
}

export function passBuildupMoon({ c, volAcc }) {
  const acc = n(volAcc, 1);
  if (acc >= MOON.buildup.minVolAcc) return { ok: true, why: "OK" };
  return { ok: false, why: "Vol acc too low" };
}

export function passAlmostMoon({ priceHist, volAcc, confidence, consistencyRatio }) {
  const flat = priceFlatPct(priceHist, 60);
  if (n(confidence, 0) < MOON.almost.minConfidence) return { ok: false, why: "Confidence low" };
  if (flat > MOON.almost.maxFlat60Pct) return { ok: false, why: "Too flat" };
  if (n(volAcc, 1) < MOON.buildup.minVolAcc) return { ok: false, why: "Vol acc too low" };
  if (n(consistencyRatio, 0) < 0.99) return { ok: false, why: "Consistency fail" };
  return { ok: true, why: "OK" };
}

export function passEliteMoon({ mode, obView, confidence, consistencyRatio, depthUsd, floorUsd, range24 }) {
  if (n(confidence, 0) < MOON.elite.minConfidence) return { ok: false, why: "Confidence low" };
  if (n(consistencyRatio, 0) < MOON.elite.consistencyMin) return { ok: false, why: "Consistency low" };
  if (n(range24, 0) > MOON.elite.range24Max) return { ok: false, why: "Range24 too high" };

  if (!obView || obView.status === "none") return { ok: false, why: "No OB" };
  if (!obView.valid) return { ok: false, why: `OB invalid: ${String(obView.reason || "bad")}` };

  const score = n(obView.score, 0);
  const min = n(MOON.elite.obScoreMin, 0.06);

  if (mode === "bull") {
    if (score < min) return { ok: false, why: "OB score low" };
  } else {
    if (score > -min) return { ok: false, why: "OB score low" };
  }

  if (n(obView.spreadPct, 999) > MOON.elite.spreadMaxPct) return { ok: false, why: "Spread too wide" };
  if (n(obView.lor, 1) > MOON.elite.largestOrderRatioMax) return { ok: false, why: "Largest order suspicious" };

  if (n(depthUsd, 0) < n(floorUsd, 0)) return { ok: false, why: "Depth too thin" };

  return { ok: true, why: "OK" };
}

// ================== RISK / PNL / HIT ==================
export function computeMoonRisk({ mode, price, range24, confidence, depthOk }) {
  const px = n(price, 0);
  if (!(px > 0)) return null;

  const r = clamp(n(range24, 5), 1.2, 35);
  const conf = clamp(n(confidence, 50), 0, 100);
  const confK = clamp(conf / 100, 0.15, 1);

  const slMul = clamp(0.30 + (1 - confK) * 0.10, 0.26, 0.42);
  const tpMul = clamp(0.55 + confK * 0.25, 0.60, 0.82);

  const safe = depthOk ? 1 : 0.92;

  const slPct = (r * slMul) * safe;
  const tpPct = (r * tpMul) * safe;

  let sl = 0, tp3 = 0;

  if (mode === "bull") {
    sl = px * (1 - slPct / 100);
    tp3 = px * (1 + tpPct / 100);
  } else {
    sl = px * (1 + slPct / 100);
    tp3 = px * (1 - tpPct / 100);
  }

  return {
    sl: +sl.toFixed(8),
    tp3: +tp3.toFixed(8),
    slPct: +slPct.toFixed(2),
    tpPct: +tpPct.toFixed(2),
  };
}

export function calcPnlPct({ mode, entryPrice, priceNow }) {
  const e = n(entryPrice, 0);
  const p = n(priceNow, 0);
  if (!(e > 0 && p > 0)) return 0;
  if (mode === "bull") return ((p - e) / e) * 100;
  return ((e - p) / e) * 100;
}

export function hitStopOrTp({ mode, priceNow, sl, tp3 }) {
  const p = n(priceNow, 0);
  const SL = n(sl, 0);
  const TP = n(tp3, 0);

  if (!(p > 0 && SL > 0 && TP > 0)) return { hit: false, kind: null };

  if (mode === "bull") {
    if (p <= SL) return { hit: true, kind: "SL" };
    if (p >= TP) return { hit: true, kind: "TP" };
  } else {
    if (p >= SL) return { hit: true, kind: "SL" };
    if (p <= TP) return { hit: true, kind: "TP" };
  }

  return { hit: false, kind: null };
}

// ================== DIAG SAVE ==================
export async function saveMoonDiag(mode, diag) {
  try {
    const m = mode === "bear" ? "bear" : "bull";
    const payload = typeof diag === "object" ? diag : { ts: Date.now(), mode: m, note: "bad diag" };

    await kv.set(keyMoonDiagSnap(m), payload);

    const listKey = keyMoonDiagList(m);
    const max = 50;

    if (typeof kv.lpush === "function" && typeof kv.ltrim === "function") {
      await kv.lpush(listKey, JSON.stringify(payload));
      await kv.ltrim(listKey, 0, max - 1);
    }
  } catch {}
}