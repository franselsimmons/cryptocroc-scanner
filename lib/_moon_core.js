// /lib/_moon_core.js
import { kv } from "@vercel/kv";

// ✅ Vercel runtime (GEEN nodejs20.x)
export const RUNTIME_CONFIG = { runtime: "nodejs" };

export const MOON = {
  CG_PER_PAGE: 250,
  CG_START_PAGE: 5,
  CG_PAGES: 1,

  RADAR_LIMIT: 180,

  btcChgGate: 0.6,
  btcRangeMin: 2,
  btcRangeMaxBull: 10,
  btcRangeMaxBear: 12,

  mcapMin: 5_000_000,
  mcapMax: 250_000_000,

  radar: {
    volMin: 150_000,
    vmMin: 0.09,
    range24Min: 1.5,
    range24Max: 16.0,
    bullChg24Min: -10,
    bullChg24Max: +10,
    bearChg24Min: -10,
    bearChg24Max: +10
  },

  buildup: {
    volAccMin: 1.01,
    vmMin: 0.12,
    range24Min: 2.5,
    chgAbsMin: 0.3,
    chgAbsMax: 18.0
  },

  almost: {
    volAccMin: 1.02,
    vmMin: 0.16,
    range24Min: 3.0,
    range24Max: 22.0,
    minConfidence: 35,
    consistencyMin: 0.50,
    priceFlatMax: 5.0
  },

  elite: {
    minConfidence: 50,
    consistencyMin: 0.60,

    obScoreMin: 0.015,
    spreadMaxPct: 1.20,
    largestOrderRatioMax: 0.80,

    samplesNeed: 2,
    samplesWindowSec: 180,
    minAgree: 1,

    obSlopeEnabled: true,
    obSlopeMinBull: 0.0,
    obSlopeMaxBear: 0.0,

    depthFloorEnabled: true,
    depthK: 20,
    depthMinUsd: 15_000,
    depthMaxUsd: 500_000,

    range24Max: 22.0,

    roll: {
      maxDeltaPrice15mPct: 7.0,
      minDeltaVol15m: 0.005,
      needCompression: false,
      minObSlope: 0.0,
      maxObStability: 1.40
    }
  },

  cgCacheSec: 60 * 10,
  btcCacheSec: 60 * 10,
  bitgetSymbolsCacheSec: 60 * 60 * 24,

  buildupMaxAgeMin: 240,
  almostMaxAgeMin: 240,

  portfolio: {
    posUsd: 100,
    maxOpen: 8,
    closeOnBtcFlip: true
  }
};

// ================== AUTH ==================
export function requireSecret(req, res) {
  const cronHeader = String(req.headers?.["x-vercel-cron"] || "").toLowerCase();
  const isVercelCron = cronHeader === "1" || cronHeader === "true";
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
export const keyMoonState = (mode) => `moon:state:${mode}`;
export const keyMoonReset = (mode) => `moon:resetAt:${mode}`;

export const keyMoonBitgetSymbols = `moon:bitget:symbols:spotusdt`;

export const keyMoonObSamples = (mode, symbol) => `moon:ob:samples:${mode}:${symbol}`;
export const keyMoonObResult = (mode, symbol) => `moon:ob:result:${mode}:${symbol}`;

export const keyMoonPositions = (mode) => `moon:positions:${mode}`;
export const keyMoonPortfolio = (mode) => `moon:portfolio:${mode}`;

export const keyMoonDiagList = (mode) => `moon:diag:list:${mode}`;
export const keyMoonDiagSnap = (mode) => `moon:diag:snap:${mode}`;

export async function saveMoonDiag(mode, diag) {
  try {
    if (typeof kv.lpush === "function" && typeof kv.ltrim === "function") {
      await kv.lpush(keyMoonDiagList(mode), JSON.stringify(diag));
      await kv.ltrim(keyMoonDiagList(mode), 0, 200);
    } else {
      await kv.set(keyMoonDiagSnap(mode), diag, { ex: 60 * 60 * 24 * 7 });
    }
  } catch {}
}

const keyCgTopCache = `moon:cache:cg:top:per${MOON.CG_PER_PAGE}:start${MOON.CG_START_PAGE}:pages${MOON.CG_PAGES}`;
const keyCgBtcCache = `moon:cache:cg:btc`;

function cgHeaders() {
  const h = { accept: "application/json" };
  const k = process.env.CG_API_KEY;
  if (k) h["x-cg-pro-api-key"] = k;
  return h;
}

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
    if (r.status === 429) throw new Error(`CoinGecko markets failed 429 (page ${page})`);
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
  const low = Number(x.low_24h || 0);
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
    vm
  };
}

// (rest van je file blijft exact hetzelfde)