// /api/_moon_core.js
import { kv } from "@vercel/kv";

// ✅ Vercel runtime mag alleen "nodejs"
export const RUNTIME_CONFIG = { runtime: "nodejs" };

export const MOON = {
  // ================== COINGECKO UNIVERSE ==================
  // We combineren 2 “orders” zodat je wél rotatie/nieuwe coins ziet:
  // - market_cap_desc (klassiek)
  // - volume_desc (zorgt voor nieuwe movers)
  CG_PER_PAGE: 250,
  CG_PAGES_PER_ORDER: 2, // 2 pages * 250 = 500 per order
  CG_ORDERS: ["market_cap_desc", "volume_desc"], // totaal ~1000 unieke coins (als CG ze heeft)
  RADAR_LIMIT: 120,

  // ================== BTC GATE ==================
  // (laat staan zoals jij had)
  btcChgGate: 0.6,
  btcRangeMin: 2,
  btcRangeMaxBull: 10,
  btcRangeMaxBear: 12,

  // ================== UNIVERSE CAPS (SOEPELER) ==================
  // → zodat er meer coins door RADAR komen
  mcapMin: 2_000_000,      // was 5M
  mcapMax: 250_000_000,    // was 150M

  // ================== RADAR (SOEPELER) ==================
  radar: {
    volMin: 100_000,       // was 250k
    vmMin: 0.05,           // was 0.10
    range24Max: 25,        // was 15

    // breder zodat je meer kandidaten ziet
    bullChg24Min: -10,
    bullChg24Max: +15,

    bearChg24Min: -15,
    bearChg24Max: +10,
  },

  // ================== ALMOST (SOEPELER) ==================
  almost: {
    volAccMin: 1.00,       // was 1.05 (nu sneller door)
    priceFlatMax: 3.0,     // was 1.8 (nu minder streng)
    minConfidence: 30,     // was 45
    consistencyMin: 0.45,  // was 0.60
  },

  // ================== ELITE (SOEPELER VOOR TEST) ==================
  elite: {
    minConfidence: 45,     // was 60
    consistencyMin: 0.55,  // was 0.70

    obScoreMin: 0.03,           // was 0.05
    spreadMaxPct: 0.80,         // was 0.55
    largestOrderRatioMax: 0.45, // was 0.35

    // sneller “valid” krijgen
    samplesNeed: 2,         // was 3
    samplesWindowSec: 120,  // was 90
    minAgree: 1,            // was 2

    obSlopeEnabled: true,
    obSlopeMinSamples: 3,
    obSlopeMinBull: 0.0,
    obSlopeMaxBear: 0.0,

    // ✅ voor debug eerst UIT, anders blokkeert ELITE vaak
    depthFloorEnabled: false,
    depthHysteresisExitMul: 0.85,
    depthK: 28,
    depthMinUsd: 60_000,
    depthMaxUsd: 600_000,
  },

  // stage moves
  minScansPerStage: 2,

  // cache (iets korter voor “ik wil verandering zien”)
  cgCacheSec: 60 * 2,      // was 10 min
  btcCacheSec: 60 * 5,     // was 10 min
  bitgetSymbolsCacheSec: 60 * 60 * 6, // was 24h (mag, maar 6h is prima)

  // rotatie (zoals jij al had)
  buildupMaxAgeMin: 240,
  almostMaxAgeMin: 240,
};

// ================== AUTH ==================
export function requireSecret(req, res) {
  // ✅ Vercel Cron header
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

export const keyMoonEliteLog = `moon:log:elite`;

const keyCgTopCache = `moon:cache:cg:universe:${MOON.CG_ORDERS.join(",")}:${MOON.CG_PAGES_PER_ORDER * MOON.CG_PER_PAGE}`;
const keyCgBtcCache = `moon:cache:cg:btc`;

// ================== DISCORD ==================
export async function sendDiscord(webhookUrl, content) {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
  } catch {}
}

export function moonWebhookForStage(stage) {
  if (stage === "BUILDUP") return process.env.DISCORD_WEBHOOK_BUILDUP_MOON;
  if (stage === "ALMOST")  return process.env.DISCORD_WEBHOOK_ALMOST_MOON;
  if (stage === "ELITE")   return process.env.DISCORD_WEBHOOK_ELITE_MOON;
  return null;
}

export function fmtMoonLine(c, mode, stage, extra = "") {
  const page = `/moon.html?mode=${encodeURIComponent(mode)}`;
  const lines = [
    `🌙 **${c.symbol}** → **${stage}** (${mode.toUpperCase()})`,
    `prijs: $${num(c.price)} | chg24: ${sign(c.change24)}% | range24: ${num(c.range24)}%`,
    `vol: $${short(c.volume)} | mc: $${short(c.marketCap)} | vm: ${num(c.vm)}`,
  ];
  if (extra) lines.push(extra);
  lines.push(`open: ${page}`);
  return lines.join("\n");
}

// ================== SAFE FETCH (429/5xx) ==================
async function fetchJsonRetry(url, tries = 3) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { accept: "application/json" } });

      // CoinGecko rate limit: even wachten en retry
      if (r.status === 429) {
        await sleep(800 + i * 600);
        continue;
      }

      if (!r.ok) {
        lastErr = new Error(`fetch failed ${r.status}`);
        await sleep(300 + i * 300);
        continue;
      }

      return await r.json();
    } catch (e) {
      lastErr = e;
      await sleep(300 + i * 300);
    }
  }
  throw lastErr || new Error("fetch failed");
}

// ================== DATA FETCH ==================
export async function fetchCoinGeckoTopCached() {
  const cached = await kv.get(keyCgTopCache);
  if (Array.isArray(cached) && cached.length) return cached;

  const fresh = await fetchCoinGeckoUniverse();
  await kv.set(keyCgTopCache, fresh, { ex: MOON.cgCacheSec });
  return fresh;
}

async function fetchCoinGeckoUniverse() {
  // We halen pages parallel per order (sneller, minder kans op timeout)
  const tasks = [];
  for (const order of MOON.CG_ORDERS) {
    for (let page = 1; page <= MOON.CG_PAGES_PER_ORDER; page++) {
      tasks.push(fetchCoinGeckoPage({ order, page }));
    }
  }

  const results = await Promise.all(tasks);
  const combined = results.flat();

  // unieke symbols
  const seen = new Set();
  const uniq = [];
  for (const c of combined) {
    if (!c?.symbol) continue;
    if (seen.has(c.symbol)) continue;
    seen.add(c.symbol);
    uniq.push(c);
  }
  return uniq;
}

async function fetchCoinGeckoPage({ order, page }) {
  const url =
    `https://api.coingecko.com/api/v3/coins/markets?` +
    `vs_currency=usd&order=${encodeURIComponent(order)}` +
    `&per_page=${MOON.CG_PER_PAGE}&page=${page}` +
    `&sparkline=false&price_change_percentage=24h`;

  const arr = await fetchJsonRetry(url, 3);
  return Array.isArray(arr) ? arr.map(normalizeCG) : [];
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

  const [x] = await fetchJsonRetry(url, 3);
  const btc = normalizeCG(x || {});
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
  const j = await fetchJsonRetry(url, 3);

  const list = (j?.data || [])
    .filter((s) => String(s?.quoteCoin || "").toUpperCase() === "USDT")
    .map((s) => String(s?.baseCoin || "").toUpperCase())
    .filter(Boolean);

  await kv.set(keyMoonBitgetSymbols, list, { ex: MOON.bitgetSymbolsCacheSec });
  return new Set(list);
}

// ================== HISTORY ==================
export function updatePriceHist(prev, price) {
  const now = Date.now();
  const h = normalizePriceHist(prev).slice(-120);
  const p = Number(price || 0);
  if (p > 0) h.push({ ts: now, price: p });
  return h;
}

export function normalizePriceHist(prev) {
  if (!Array.isArray(prev)) return [];
  if (prev.length && typeof prev[0] === "number") {
    return prev
      .map((p, i) => ({ ts: Date.now() - (prev.length - i) * 10 * 60 * 1000, price: Number(p || 0) }))
      .filter((x) => x.price > 0);
  }
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

export function updateSideHistory(prevHist, side) {
  const now = Date.now();
  const arr = Array.isArray(prevHist) ? prevHist.slice(-80) : [];
  arr.push({ ts: now, side });
  return arr;
}

export function calcConsistency(hist, wantedSide, windowMin = 120, minSamples = 6) {
  const cutoff = Date.now() - windowMin * 60 * 1000;
  const h = (hist || []).filter((x) => Number(x?.ts || 0) >= cutoff);
  const total = h.length;
  if (total < minSamples) return { ok: false, ratio: 0, total, same: 0 };
  const same = h.filter((x) => x.side === wantedSide).length;
  const ratio = total ? same / total : 0;
  return { ok: true, ratio, total, same };
}

// ================== CONFIDENCE ==================
export function computeConfidence({ obScore, obAgree, vm, volAcc, btc }) {
  const obStrength = clamp01(mapLinear(Math.abs(obScore), 0.02, 0.18));
  const obBonus = obAgree === 3 ? 1.0 : obAgree === 2 ? 0.85 : obAgree === 1 ? 0.7 : 0.5;
  const ob = obStrength * obBonus;

  const vmStrength = clamp01(mapLinear(vm, MOON.radar.vmMin, 0.35));
  const vaStrength = clamp01(mapLinear(volAcc, 1.0, 1.6));
  const btcStrength = clamp01(mapLinear(Math.abs(btc?.chg24 || 0), MOON.btcChgGate, 2.5));

  const score = 40 * ob + 25 * vmStrength + 20 * vaStrength + 15 * btcStrength;
  return Math.round(clamp(score, 0, 100));
}

// ================== OB / DEPTH ==================
export function passObBase(obView, mode) {
  if (!obView || !obView.valid) return { ok: false, why: "OB validating" };
  if (obView.stale) return { ok: false, why: "OB stale" };

  const score = Number(obView.score ?? obView.avgScore ?? 0);
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

export function calcObSlope(samples) {
  if (!Array.isArray(samples) || samples.length < MOON.elite.obSlopeMinSamples) return null;
  const s = samples
    .map((x) => ({
      ts: Number(x?.ts || 0),
      score: Number(x?.score ?? x?.obScore ?? x?.avgScore ?? 0),
    }))
    .filter((x) => x.ts > 0 && Number.isFinite(x.score))
    .sort((a, b) => a.ts - b.ts);

  if (s.length < MOON.elite.obSlopeMinSamples) return null;
  const first = s[0].score;
  const last = s[s.length - 1].score;
  const n = s.length - 1;
  if (n <= 0) return null;
  return (last - first) / n;
}

export function depthFloorUsd(marketCapUsd) {
  const mcapM = Math.max(0, Number(marketCapUsd || 0)) / 1_000_000;
  const raw = MOON.elite.depthK * Math.sqrt(mcapM) * 1000;
  return clamp(raw, MOON.elite.depthMinUsd, MOON.elite.depthMaxUsd);
}

export function passDepthFloor({ depthUsd, floorUsd, wasOk }) {
  if (!MOON.elite.depthFloorEnabled) return { ok: true, why: "Depth disabled" };
  const need = wasOk ? floorUsd * MOON.elite.depthHysteresisExitMul : floorUsd;
  const ok = Number(depthUsd || 0) >= Number(need || 0);
  return { ok, why: ok ? "Depth ok" : `Depth < ${Math.round(need).toLocaleString()} USD` };
}

// ================== FILTERS ==================
export function passRadarMoon(c, mode) {
  if (c.marketCap < MOON.mcapMin) return false;
  if (c.marketCap > MOON.mcapMax) return false;

  if (c.volume < MOON.radar.volMin) return false;
  if (c.vm < MOON.radar.vmMin) return false;
  if (c.range24 > MOON.radar.range24Max) return false;

  if (mode === "bull") {
    if (c.change24 < MOON.radar.bullChg24Min) return false;
    if (c.change24 > MOON.radar.bullChg24Max) return false;
  } else {
    if (c.change24 < MOON.radar.bearChg24Min) return false;
    if (c.change24 > MOON.radar.bearChg24Max) return false;
  }

  return true;
}

export function passAlmostMoon({ priceHist, volAcc, confidence, consistencyRatio }) {
  const flat = priceFlatPct(priceHist, 60);
  if (volAcc < MOON.almost.volAccMin) return { ok: false, why: "VolAcc low" };
  if (flat > MOON.almost.priceFlatMax) return { ok: false, why: "Price not flat" };
  if (confidence < MOON.almost.minConfidence) return { ok: false, why: "Confidence low" };
  if (consistencyRatio < MOON.almost.consistencyMin) return { ok: false, why: "Consistency low" };
  return { ok: true, why: "ALMOST ok" };
}

export function passEliteMoon({ mode, obView, obSlope, confidence, consistencyRatio, depthUsd, floorUsd, depthWasOk }) {
  const ob = passObBase(obView, mode);
  if (!ob.ok) return { ok: false, why: ob.why };

  if (MOON.elite.obSlopeEnabled && Number.isFinite(obSlope)) {
    if (mode === "bull" && obSlope < MOON.elite.obSlopeMinBull) return { ok: false, why: "OB slope down" };
    if (mode === "bear" && obSlope > MOON.elite.obSlopeMaxBear) return { ok: false, why: "OB slope up" };
  }

  if (confidence < MOON.elite.minConfidence) return { ok: false, why: "Confidence < elite" };
  if (consistencyRatio < MOON.elite.consistencyMin) return { ok: false, why: "Consistency < elite" };

  const depth = passDepthFloor({ depthUsd, floorUsd, wasOk: depthWasOk });
  if (!depth.ok) return { ok: false, why: depth.why };

  return { ok: true, why: "ELITE ok" };
}

export function stageRank(stage) {
  if (stage === "BUILDUP") return 1;
  if (stage === "ALMOST") return 2;
  if (stage === "ELITE") return 3;
  return 0;
}

// ================== HELPERS ==================
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function clamp01(n){ return clamp(n, 0, 1); }
function mapLinear(x, a, b){
  if (b === a) return 0;
  return (Number(x || 0) - a) / (b - a);
}
function num(n) { return (Number(n) || 0).toFixed(2); }
function sign(n){ return `${n >= 0 ? "+" : ""}${num(n)}`; }
function short(n){
  n = Number(n)||0;
  if (n >= 1e9) return (n/1e9).toFixed(2)+"B";
  if (n >= 1e6) return (n/1e6).toFixed(2)+"M";
  if (n >= 1e3) return (n/1e3).toFixed(2)+"K";
  return n.toFixed(0);
}
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }