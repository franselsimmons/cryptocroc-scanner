// /api/_moon_core.js
import { kv } from "@vercel/kv";

// ✅ Vercel runtime: "nodejs"
export const RUNTIME_CONFIG = { runtime: "nodejs" };

export const MOON = {
  // ✅ 250 coins per scan, vanaf pagina 5
  CG_PER_PAGE: 250,
  CG_START_PAGE: 5,
  CG_PAGES: 1,

  RADAR_LIMIT: 120,

  // BTC gate
  btcChgGate: 0.6,
  btcRangeMin: 2,
  btcRangeMaxBull: 10,
  btcRangeMaxBear: 12,

  // Universe caps
  mcapMin: 5_000_000,
  mcapMax: 150_000_000,

  // ✅ PROACTIEF radar
  radar: {
    volMin: 200_000,
    vmMin: 0.12,
    range24Min: 2.0,
    range24Max: 12.0,
    bullChg24Min: -6,
    bullChg24Max: +6,
    bearChg24Min: -6,
    bearChg24Max: +6,
  },

  // ✅ BUILDUP
  buildup: {
    volAccMin: 1.05,
    vmMin: 0.18,
    range24Min: 3.5,
    chgAbsMin: 0.8,
    chgAbsMax: 12.0,
  },

  // ✅ ALMOST
  almost: {
    volAccMin: 1.10,
    vmMin: 0.25,
    range24Min: 5.5,
    range24Max: 16.0,
    minConfidence: 50,
    consistencyMin: 0.60,
    priceFlatMax: 2.8,
  },

  // ✅ ELITE = instap
  elite: {
    minConfidence: 65,
    consistencyMin: 0.70,

    obScoreMin: 0.04,
    spreadMaxPct: 0.70,
    largestOrderRatioMax: 0.40,
    samplesNeed: 3,
    samplesWindowSec: 90,
    minAgree: 2,

    // “niet te laat”
    range24Max: 18.0,

    // Rolling (15m) requirements voor 9.7 niveau
    roll: {
      maxDeltaPrice15mPct: 4.0,   // prijs mag nog niet exploderen
      minDeltaVol15m: 0.15,       // druk moet oplopen
      needCompression: true,      // range krimpt
      minObSlope: 8,              // OB bouwt op
      maxObStability: 20,         // OB niet “flipt”
    },
  },

  // caches
  cgCacheSec: 60 * 10,
  btcCacheSec: 60 * 10,
  bitgetSymbolsCacheSec: 60 * 60 * 24,

  // rotatie
  buildupMaxAgeMin: 240,
  almostMaxAgeMin: 240,

  // Portfolio instellingen (virtueel)
  portfolio: {
    posUsd: 100,          // $100 per entry (kan later env maken)
    maxOpen: 8,           // max open posities tegelijk
    closeOnBtcFlip: true, // BTC gate flip => posities sluiten
  },
};

// ================== AUTH ==================
export function requireSecret(req, res) {
  const isVercelCron = String(req.headers?.["x-vercel-cron"] || "") === "1";
  if (isVercelCron) return true;

  const secret = process.env.CRON_SECRET;
  if (!secret) return true;

  const auth = req.headers?.authorization || "";
  const token = req.query?.token ? String(req.query.token) : "";
  const ok = auth === `Bearer ${secret}` || token === secret;

  if (!ok) {
    res.statusCode = 401;
    res.setHeader?.("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
    return false;
  }
  return true;
}

// ================== KV KEYS ==================
export const keyMoonLatest = (mode) => `moon:latest:${mode}`;
export const keyMoonState  = (mode) => `moon:state:${mode}`;
export const keyMoonReset  = (mode) => `moon:resetAt:${mode}`;

export const keyMoonBitgetSymbols = `moon:bitget:symbols:spotusdt`;

export const keyMoonObSamples = (mode, symbol) => `moon:ob:samples:${mode}:${symbol}`;
export const keyMoonObResult  = (mode, symbol) => `moon:ob:result:${mode}:${symbol}`;

// Portfolio keys
export const keyMoonPositions = (mode) => `moon:positions:${mode}`;   // open + closed
export const keyMoonPortfolio = (mode) => `moon:portfolio:${mode}`;   // totals

// cache keys
const keyCgTopCache = `moon:cache:cg:top:per${MOON.CG_PER_PAGE}:start${MOON.CG_START_PAGE}:pages${MOON.CG_PAGES}`;
const keyCgBtcCache = `moon:cache:cg:btc`;

// ================== COINGECKO HEADERS ==================
function cgHeaders() {
  const h = { accept: "application/json" };
  const k = process.env.CG_API_KEY;
  if (k) h["x-cg-pro-api-key"] = k;
  return h;
}

// ================== DATA FETCH ==================
export async function fetchCoinGeckoTopCached() {
  const cached = await kv.get(keyCgTopCache);
  if (Array.isArray(cached) && cached.length) return cached;

  const fresh = await fetchCoinGeckoSlice();
  await kv.set(keyCgTopCache, fresh, { ex: MOON.cgCacheSec });
  return fresh;
}

async function fetchCoinGeckoSlice() {
  const out = [];
  const start = MOON.CG_START_PAGE;
  const end = start + MOON.CG_PAGES - 1;

  for (let page = start; page <= end; page++) {
    const url =
      `https://api.coingecko.com/api/v3/coins/markets?` +
      `vs_currency=usd&order=market_cap_desc&per_page=${MOON.CG_PER_PAGE}&page=${page}` +
      `&sparkline=false&price_change_percentage=24h`;

    const r = await fetch(url, { headers: cgHeaders() });
    if (r.status === 429) throw new Error("CoinGecko markets failed 429");
    if (!r.ok) throw new Error(`CoinGecko markets failed ${r.status} (page ${page})`);

    const arr = await r.json();
    out.push(...arr.map(normalizeCG));
  }

  const seen = new Set();
  const uniq = [];
  for (const c of out) {
    if (!c?.symbol) continue;
    if (seen.has(c.symbol)) continue;
    seen.add(c.symbol);
    uniq.push(c);
  }
  return uniq;
}

export async function fetchBTCGateCached() {
  const cached = await kv.get(keyCgBtcCache);
  if (cached && cached.state) return cached;

  const fresh = await fetchBTCGate();
  await kv.set(keyCgBtcCache, fresh, { ex: MOON.btcCacheSec });
  return fresh;
}

async function fetchBTCGate() {
  const url =
    `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin&sparkline=false&price_change_percentage=24h`;

  const r = await fetch(url, { headers: cgHeaders() });
  if (r.status === 429) throw new Error("CoinGecko BTC failed 429");
  if (!r.ok) throw new Error(`CoinGecko BTC failed ${r.status}`);

  const [x] = await r.json();
  const btc = normalizeCG(x);

  const chg24 = btc.change24;
  const range24 = btc.range24;

  const bull =
    chg24 >= MOON.btcChgGate &&
    range24 >= MOON.btcRangeMin &&
    range24 <= MOON.btcRangeMaxBull;

  const bear =
    chg24 <= -MOON.btcChgGate &&
    range24 >= MOON.btcRangeMin &&
    range24 <= MOON.btcRangeMaxBear;

  let state = "NEUTRAL";
  if (bull) state = "BULL";
  else if (bear) state = "BEAR";

  return { state, chg24, range24 };
}

function normalizeCG(x) {
  const high = Number(x.high_24h || 0);
  const low  = Number(x.low_24h || 0);
  const range24 = low > 0 ? ((high - low) / low) * 100 : 0;

  const volume = Number(x.total_volume || 0);
  const marketCap = Number(x.market_cap || 0);
  const vm = marketCap > 0 ? volume / marketCap : 0;

  return {
    id: x.id,
    symbol: String(x.symbol || "").toUpperCase(),
    name: x.name,
    price: Number(x.current_price || 0),
    change24: Number(x.price_change_percentage_24h || 0),
    range24,
    volume,
    marketCap,
    vm,
  };
}

export async function getBitgetSpotUsdtSymbols() {
  const cached = await kv.get(keyMoonBitgetSymbols);
  if (Array.isArray(cached) && cached.length) return new Set(cached);

  const url = "https://api.bitget.com/api/v2/spot/public/symbols";
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`Bitget symbols failed ${r.status}`);
  const j = await r.json();

  const list = (j?.data || [])
    .filter((s) => String(s?.quoteCoin || "").toUpperCase() === "USDT")
    .map((s) => String(s?.baseCoin || "").toUpperCase())
    .filter(Boolean);

  await kv.set(keyMoonBitgetSymbols, list, { ex: MOON.bitgetSymbolsCacheSec });
  return new Set(list);
}

// ================== HISTORY (price + volume) ==================
export function updatePriceHist(prev, price) {
  const now = Date.now();
  const h = normalizePriceHist(prev).slice(-120);
  const p = Number(price || 0);
  if (p > 0) h.push({ ts: now, price: p });
  return h;
}
export function normalizePriceHist(prev) {
  if (!Array.isArray(prev)) return [];
  return prev
    .map((x) => ({ ts: Number(x?.ts || 0), price: Number(x?.price || 0) }))
    .filter((x) => x.ts > 0 && x.price > 0);
}
export function priceFlatPct(priceHist, minutes = 60) {
  const h = normalizePriceHist(priceHist).sort((a, b) => a.ts - b.ts);
  const cutoff = Date.now() - minutes * 60 * 1000;
  const w = h.filter((x) => x.ts >= cutoff);
  if (w.length < 2) return 0;

  const prices = w.map((x) => x.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  if (min <= 0) return 0;
  return ((max - min) / min) * 100;
}

export function updateVolHist(prev, volume) {
  const arr = Array.isArray(prev) ? prev.slice(-6) : [];
  arr.push(Number(volume || 0));
  return arr;
}
export function volAccFromHist(volHist) {
  const h = Array.isArray(volHist) ? volHist : [];
  const last3 = h.slice(-3);
  const prev3 = h.slice(-6, -3);
  const sum = (a) => a.reduce((x, y) => x + (Number(y) || 0), 0);
  const a = sum(last3);
  const b = sum(prev3);
  if (prev3.length < 3 || b <= 0) return 1.0;
  return a / b;
}

// ================== CONFIDENCE ==================
export function computeConfidence({ obScore, obAgree, vm, volAcc, btc }) {
  const obStrength = clamp01(mapLinear(Math.abs(obScore), 0.03, 0.18));
  const obBonus = obAgree === 3 ? 1.0 : obAgree === 2 ? 0.85 : 0.6;
  const ob = obStrength * obBonus;

  const vmStrength = clamp01(mapLinear(vm, MOON.radar.vmMin, 0.35));
  const vaStrength = clamp01(mapLinear(volAcc, 1.0, 1.6));
  const btcStrength = clamp01(mapLinear(Math.abs(btc?.chg24 || 0), MOON.btcChgGate, 2.5));

  const score = 40 * ob + 25 * vmStrength + 20 * vaStrength + 15 * btcStrength;
  return Math.round(clamp(score, 0, 100));
}

// ================== OB / DEPTH gates ==================
export function passObBase(obView, mode) {
  if (!obView || !obView.valid) return { ok: false, why: "OB validating" };
  if (obView.stale) return { ok: false, why: "OB stale" };

  const score = Number(obView.score ?? 0);
  const spreadPct = Number(obView.spreadPct ?? 999);
  const lor = Number(obView.lor ?? 1);

  if (lor > MOON.elite.largestOrderRatioMax) return { ok: false, why: "OB suspicious (largest order)" };
  if (spreadPct > MOON.elite.spreadMaxPct) return { ok: false, why: "Spread too wide" };

  if (mode === "bull") {
    if (score < MOON.elite.obScoreMin) return { ok: false, why: "OB score too low" };
  } else {
    if (score > -MOON.elite.obScoreMin) return { ok: false, why: "OB score too low" };
  }
  return { ok: true, why: "OB ok" };
}

export function depthFloorUsd(marketCapUsd) {
  const mcapM = Math.max(0, Number(marketCapUsd || 0)) / 1_000_000;
  const raw = MOON.elite.depthK * Math.sqrt(mcapM) * 1000;
  return clamp(raw, MOON.elite.depthMinUsd, MOON.elite.depthMaxUsd);
}
export function passDepthFloor({ depthUsd, floorUsd }) {
  const ok = Number(depthUsd || 0) >= Number(floorUsd || 0);
  return { ok, why: ok ? "Depth ok" : `Depth < ${Math.round(floorUsd).toLocaleString()} USD` };
}

// ================== FILTERS ==================
export function passRadarMoon(c, mode) {
  if (c.marketCap < MOON.mcapMin) return false;
  if (c.marketCap > MOON.mcapMax) return false;

  if (c.volume < MOON.radar.volMin) return false;
  if (c.vm < MOON.radar.vmMin) return false;

  const rng = Number(c.range24 || 0);
  if (rng < MOON.radar.range24Min) return false;
  if (rng > MOON.radar.range24Max) return false;

  const chg = Number(c.change24 || 0);
  if (mode === "bull") {
    if (chg < MOON.radar.bullChg24Min) return false;
    if (chg > MOON.radar.bullChg24Max) return false;
  } else {
    if (chg < MOON.radar.bearChg24Min) return false;
    if (chg > MOON.radar.bearChg24Max) return false;
  }
  return true;
}

export function passBuildupMoon({ c, volAcc }) {
  const chgAbs = Math.abs(Number(c.change24 || 0));
  if (volAcc < MOON.buildup.volAccMin) return { ok: false, why: "VolAcc low" };
  if (Number(c.vm || 0) < MOON.buildup.vmMin) return { ok: false, why: "VM low" };
  if (Number(c.range24 || 0) < MOON.buildup.range24Min) return { ok: false, why: "Range low" };
  if (chgAbs < MOON.buildup.chgAbsMin) return { ok: false, why: "Change too small" };
  if (chgAbs > MOON.buildup.chgAbsMax) return { ok: false, why: "Already too hot" };
  return { ok: true, why: "BUILDUP ok" };
}

export function passAlmostMoon({ priceHist, volAcc, confidence, consistencyRatio }) {
  const flat = priceFlatPct(priceHist, 60);
  if (volAcc < MOON.almost.volAccMin) return { ok: false, why: "VolAcc low" };
  if (Number(confidence || 0) < MOON.almost.minConfidence) return { ok: false, why: "Confidence low" };
  if (Number(consistencyRatio || 0) < MOON.almost.consistencyMin) return { ok: false, why: "Consistency low" };
  if (flat > MOON.almost.priceFlatMax) return { ok: false, why: "Price not flat" };
  return { ok: true, why: "ALMOST ok" };
}

export function passEliteMoon({ mode, obView, confidence, consistencyRatio, depthUsd, floorUsd, range24 }) {
  if (Number(range24 || 0) > MOON.elite.range24Max) return { ok: false, why: "Range too high (late)" };

  const ob = passObBase(obView, mode);
  if (!ob.ok) return { ok: false, why: ob.why };

  if (Number(confidence || 0) < MOON.elite.minConfidence) return { ok: false, why: "Confidence < elite" };
  if (Number(consistencyRatio || 0) < MOON.elite.consistencyMin) return { ok: false, why: "Consistency < elite" };

  const depth = passDepthFloor({ depthUsd, floorUsd });
  if (!depth.ok) return { ok: false, why: depth.why };

  return { ok: true, why: "ELITE ok" };
}

// ================== RISK (SL/TP) ==================
export function computeMoonRisk({ mode, price, range24, confidence, depthOk }) {
  const p = Number(price || 0);
  if (!(p > 0)) return null;

  const r = clamp(Number(range24 || 0), 1.0, 25.0) / 100;
  const conf = clamp(Number(confidence || 0), 0, 100);

  let slMul = 0.30;
  slMul += mapLinear(conf, 0, 100) * (-0.10);
  if (!depthOk) slMul += 0.08;
  slMul = clamp(slMul, 0.18, 0.42);

  const slPct = clamp(r * slMul, 0.006, 0.06);
  const sl = mode === "bull" ? p * (1 - slPct) : p * (1 + slPct);

  const R = slPct;
  const tp1 = mode === "bull" ? p * (1 + 1.8 * R) : p * (1 - 1.8 * R);
  const tp2 = mode === "bull" ? p * (1 + 3.0 * R) : p * (1 - 3.0 * R);
  const tp3 = mode === "bull" ? p * (1 + 4.2 * R) : p * (1 - 4.2 * R);

  return {
    slPct: +(slPct * 100).toFixed(2),
    sl: +sl.toFixed(8),
    tp1: +tp1.toFixed(8),
    tp2: +tp2.toFixed(8),
    tp3: +tp3.toFixed(8),
    note: depthOk ? "Depth ok" : "Depth weak → SL wider",
  };
}

// ================== BTC HARD GATE ==================
export function isModeAllowedByBtc(mode, btcState) {
  // A: hard block. Alleen scannen als btcState matcht.
  // Bull scan alleen als BTC=BULL; Bear scan alleen als BTC=BEAR.
  if (btcState !== "BULL" && btcState !== "BEAR") return false;
  return mode === "bull" ? btcState === "BULL" : btcState === "BEAR";
}

// ================== PORTFOLIO HELPERS ==================
export function calcPnlPct({ mode, entryPrice, priceNow }) {
  const e = Number(entryPrice || 0);
  const p = Number(priceNow || 0);
  if (!(e > 0 && p > 0)) return 0;

  // bull: winst als p>e, bear: winst als p<e
  if (mode === "bull") return ((p - e) / e) * 100;
  return ((e - p) / e) * 100;
}

export function hitStopOrTp({ mode, priceNow, sl, tp3 }) {
  const p = Number(priceNow || 0);
  if (!(p > 0)) return { hit: false };

  if (mode === "bull") {
    if (sl && p <= Number(sl)) return { hit: true, kind: "SL" };
    if (tp3 && p >= Number(tp3)) return { hit: true, kind: "TP" };
  } else {
    if (sl && p >= Number(sl)) return { hit: true, kind: "SL" };
    if (tp3 && p <= Number(tp3)) return { hit: true, kind: "TP" };
  }
  return { hit: false };
}

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function clamp01(n){ return clamp(n, 0, 1); }
function mapLinear(x, a, b){
  if (b === a) return 0;
  return (Number(x || 0) - a) / (b - a);
}