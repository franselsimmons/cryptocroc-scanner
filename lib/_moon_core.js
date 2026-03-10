// /lib/_moon_core.js
import { kv } from "@vercel/kv";

// ---------- Runtime config ----------
export const RUNTIME_CONFIG = {
  runtime: "nodejs",
};

// ========== MOON V2 CONFIGURATIE ==========
export const MOON_V2 = {
  bull: {
    minVol24h: 350_000,
    minVmRadar: 0.08,
    minVmBuildup: 0.18,
    minVmAlmost: 0.28,
    minVmElite: 0.40,

    minCh1hRadar: -0.8,
    minCh1hBuildup: 0.6,
    minCh1hAlmost: 1.2,
    minCh1hIgnition: 2.2,
    minCh1hExpansion: 3.5,

    minCh24Radar: 1.5,
    minCh24Buildup: 4,
    minCh24Almost: 8,
    minCh24Ignition: 12,
    minCh24Expansion: 20,

    minObBull: 0.025,
    minObStrong: 0.055,
    spreadMaxRadar: 1.40,
    spreadMaxElite: 1.05,

    maxExhaust24: 85,
    minVelocity: 0.10,
    strongVelocity: 0.20,
    explosiveVelocity: 0.30,
  },

  bear: {
    minVol24h: 350_000,
    minVmRadar: 0.08,
    minVmBuildup: 0.18,
    minVmAlmost: 0.28,
    minVmElite: 0.40,

    maxCh1hRadar: 0.8,
    maxCh1hBuildup: -0.6,
    maxCh1hAlmost: -1.2,
    maxCh1hIgnition: -2.2,
    maxCh1hCascade: -3.5,

    maxCh24Radar: -1.5,
    maxCh24Buildup: -4,
    maxCh24Almost: -8,
    maxCh24Ignition: -12,
    maxCh24Cascade: -20,

    minObBearAbs: 0.025,
    minObStrongAbs: 0.055,
    spreadMaxRadar: 1.60,
    spreadMaxElite: 1.20,

    maxBounce1h: 2.8,
    minVelocity: 0.10,
    strongVelocity: 0.20,
    explosiveVelocity: 0.30,
  },
};

// Depth‑factor (blijft)
export const depthK = 0.00025;

// Tiers (blijven)
export const TIERS = [
  { name: "small",     marketCapMax: 100_000_000, depthMinUsd: 1_000 },
  { name: "mid",       marketCapMax: 500_000_000, depthMinUsd: 4_000 },
  { name: "upper-mid", marketCapMax: 2_000_000_000, depthMinUsd: 12_000 },
  { name: "large",     marketCapMax: Infinity,     depthMinUsd: 50_000 },
];

// Blokkadelijst (uitgebreid)
const BLOCKED_SYMBOLS = [
  "USDT", "BUSD", "DAI", "USDC", "TUSD", "PAX", "UST", "LUNC", "LUNA",
  "USTC", "LUNA2", "MIM", "FRAX", "WBTC", "WETH", "renBTC",
  "3X", "BEAR", "BULL", "DOWN", "UP", "HEDGE",
];

// ---------- Hulpfuncties ----------
export function isBlockedMoonAsset(coin) {
  if (!coin || !coin.symbol) return true;
  const sym = coin.symbol.toUpperCase();
  if (BLOCKED_SYMBOLS.some(b => sym.includes(b))) return true;
  if (sym.endsWith("USD") || sym.endsWith("EUR")) return true;
  return false;
}

export function getTierForMcap(mcap) {
  for (const tier of TIERS) {
    if (mcap < tier.marketCapMax) return tier;
  }
  return TIERS[TIERS.length - 1];
}

export function depthFloorUsd(mcap, tier, depthHist = []) {
  const factor = tier === TIERS[0] ? 0.8 : tier === TIERS[1] ? 1.0 : tier === TIERS[2] ? 1.5 : 2.0;
  const base = Math.max(tier.depthMinUsd, Math.round(depthK * Math.sqrt(mcap) * factor));
  if (depthHist.length > 0) {
    const sorted = [...depthHist].sort((a,b) => a-b);
    const median = sorted[Math.floor(sorted.length/2)];
    return Math.max(base, Math.round(median * 0.7));
  }
  return base;
}

// ========== MOON V2 HELPERS ==========

// Velocity: 1h / 24h (absoluut)
export function computeVelocity(change1h, change24) {
  const a1 = Math.abs(Number(change1h || 0));
  const a24 = Math.abs(Number(change24 || 0));
  if (a24 <= 0.0001) return 0;
  return a1 / a24;
}

// Market cap asymmetrie bonus
export function marketCapMoveBonus(mcap) {
  const mc = Number(mcap || 0);
  if (mc <= 20_000_000) return 18;
  if (mc <= 50_000_000) return 14;
  if (mc <= 120_000_000) return 10;
  if (mc <= 300_000_000) return 6;
  if (mc <= 800_000_000) return 2;
  return 0;
}

// Compressie detectie
export function computeCompression(priceHist = []) {
  const arr = Array.isArray(priceHist) ? priceHist.slice(-12) : [];
  if (arr.length < 6) {
    return { flatPct: 999, isCompressed: false };
  }

  const hi = Math.max(...arr);
  const lo = Math.min(...arr);
  const mid = (hi + lo) / 2;

  if (!(mid > 0)) {
    return { flatPct: 999, isCompressed: false };
  }

  const flatPct = ((hi - lo) / mid) * 100;

  return {
    flatPct: Number(flatPct.toFixed(2)),
    isCompressed: flatPct <= 4.5,
  };
}

// Bull exhaustion
export function isBullExhausted(coin) {
  const ch24 = Number(coin?.change24 || 0);
  const ch1h = Number(coin?.change1h || 0);
  const vm = Number(coin?.vm || 0);

  if (ch24 >= 85 && ch1h < 1.0) return true;
  if (ch24 >= 60 && vm < 0.18) return true;
  return false;
}

// Bear bounce trap
export function isBearBounceTrap(coin) {
  const ch24 = Number(coin?.change24 || 0);
  const ch1h = Number(coin?.change1h || 0);

  return ch24 <= -10 && ch1h >= 2.8;
}

// Bull move score
export function computeBullMoveScore(coin, obx) {
  const vm = Number(coin?.vm || 0);
  const ch1h = Number(coin?.change1h || 0);
  const ch24 = Number(coin?.change24 || 0);
  const ob = Number(obx?.score || 0);
  const spread = Number(obx?.spreadPct || 999);
  const depth = Number(obx?.depthMinUsd1p || 0);
  const mcBonus = marketCapMoveBonus(coin?.marketCap);

  let score = 0;

  if (vm >= 0.10) score += 8;
  if (vm >= 0.20) score += 14;
  if (vm >= 0.40) score += 22;
  if (vm >= 0.80) score += 30;
  if (vm >= 1.50) score += 36;

  if (ch1h >= 0.5) score += 6;
  if (ch1h >= 1.2) score += 12;
  if (ch1h >= 2.5) score += 18;
  if (ch1h >= 4.0) score += 24;
  if (ch1h >= 7.0) score += 30;

  if (ch24 >= 3) score += 6;
  if (ch24 >= 8) score += 12;
  if (ch24 >= 15) score += 18;
  if (ch24 >= 25) score += 24;
  if (ch24 >= 40) score += 28;

  if (ob >= 0.02) score += 5;
  if (ob >= 0.05) score += 10;
  if (ob >= 0.09) score += 15;

  if (spread <= 1.2) score += 3;
  if (spread <= 0.7) score += 5;
  if (spread <= 0.3) score += 7;

  if (depth >= 2000) score += 3;
  if (depth >= 8000) score += 5;
  if (depth >= 20000) score += 7;

  score += mcBonus;

  return Math.max(0, Math.min(100, Math.round(score)));
}

// Bear move score
export function computeBearMoveScore(coin, obx) {
  const vm = Number(coin?.vm || 0);
  const ch1h = Number(coin?.change1h || 0);
  const ch24 = Number(coin?.change24 || 0);
  const ob = Number(obx?.score || 0);
  const spread = Number(obx?.spreadPct || 999);
  const depth = Number(obx?.depthMinUsd1p || 0);
  const mcBonus = marketCapMoveBonus(coin?.marketCap);

  let score = 0;

  if (vm >= 0.10) score += 8;
  if (vm >= 0.20) score += 14;
  if (vm >= 0.40) score += 22;
  if (vm >= 0.80) score += 30;
  if (vm >= 1.50) score += 36;

  if (ch1h <= -0.5) score += 6;
  if (ch1h <= -1.2) score += 12;
  if (ch1h <= -2.5) score += 18;
  if (ch1h <= -4.0) score += 24;
  if (ch1h <= -7.0) score += 30;

  if (ch24 <= -3) score += 6;
  if (ch24 <= -8) score += 12;
  if (ch24 <= -15) score += 18;
  if (ch24 <= -25) score += 24;
  if (ch24 <= -40) score += 28;

  if (ob <= -0.02) score += 5;
  if (ob <= -0.05) score += 10;
  if (ob <= -0.09) score += 15;

  if (spread <= 1.4) score += 3;
  if (spread <= 0.9) score += 5;

  if (depth >= 2000) score += 3;
  if (depth >= 8000) score += 5;
  if (depth >= 20000) score += 7;

  score += mcBonus;

  return Math.max(0, Math.min(100, Math.round(score)));
}

// Moon probabilities (gebaseerd op moveScore, velocity, compressie)
export function computeMoonProbabilities({ mode, coin, moveScore, velocity, compression }) {
  const velScore =
    velocity >= 0.30 ? 100 :
    velocity >= 0.20 ? 75 :
    velocity >= 0.10 ? 50 : 20;

  const compScore = compression?.isCompressed ? 70 : 25;

  const moonProbability =
    mode === "bull"
      ? Math.max(0, Math.min(1,
          moveScore * 0.55 / 100 +
          velScore * 0.20 / 100 +
          compScore * 0.10 / 100 +
          (Number(coin?.ob?.score || 0) > 0 ? 0.10 : 0) +
          (Number(coin?.vm || 0) >= 0.4 ? 0.05 : 0)
        ))
      : 0;

  const dumpProbability =
    mode === "bear"
      ? Math.max(0, Math.min(1,
          moveScore * 0.55 / 100 +
          velScore * 0.20 / 100 +
          compScore * 0.05 / 100 +
          (Number(coin?.ob?.score || 0) < 0 ? 0.15 : 0) +
          (Number(coin?.vm || 0) >= 0.4 ? 0.05 : 0)
        ))
      : 0;

  return {
    moonProbability: Number(moonProbability.toFixed(3)),
    dumpProbability: Number(dumpProbability.toFixed(3)),
  };
}

// ---------- Risico & Tradeplan (ongewijzigd) ----------
export function computeMoonRisk({ mode, price, range24, confidence, depthOk, tier }) {
  if (!price || price <= 0) return null;
  const atrFactor = Math.min(0.15, Math.max(0.02, range24 / price || 0.02));
  const baseSlPct = mode === "bull" ? 0.06 : 0.05;
  const baseTpPct = mode === "bull" ? 0.15 : 0.12;

  let slPct = baseSlPct + atrFactor * 0.5;
  let tpPct = baseTpPct + atrFactor * 1.5;

  if (confidence > 80) {
    tpPct *= 1.2;
  } else if (confidence < 50) {
    slPct *= 1.1;
  }

  const sl = mode === "bull" ? price * (1 - slPct) : price * (1 + slPct);
  const tp3 = mode === "bull" ? price * (1 + tpPct) : price * (1 - tpPct);

  return { sl, tp3, slPct, tpPct };
}

export function calcPnlPct({ mode, entryPrice, priceNow }) {
  if (!entryPrice || entryPrice <= 0) return 0;
  if (mode === "bull") {
    return ((priceNow - entryPrice) / entryPrice) * 100;
  } else {
    return ((entryPrice - priceNow) / entryPrice) * 100;
  }
}

export function hitStopOrTp({ mode, priceNow, sl, tp3 }) {
  if (mode === "bull") {
    if (priceNow <= sl) return { hit: true, kind: "SL" };
    if (priceNow >= tp3) return { hit: true, kind: "TP" };
  } else {
    if (priceNow >= sl) return { hit: true, kind: "SL" };
    if (priceNow <= tp3) return { hit: true, kind: "TP" };
  }
  return { hit: false };
}

// ---------- Data‐ophaling (ongewijzigd) ----------
export async function getBitgetSpotUsdtSymbols() {
  try {
    const r = await fetch("https://api.bitget.com/api/v2/spot/public/symbols");
    if (!r.ok) {
      console.error("Bitget symbols HTTP error:", r.status);
      return new Set();
    }
    const json = await r.json();
    if (String(json?.code || "") !== "00000") {
      console.error("Bitget symbols API error:", json);
      return new Set();
    }
    const set = new Set();
    for (const s of json.data || []) {
      const status = String(s?.status || "").toLowerCase();
      const quoteCoin = String(s?.quoteCoin || "").toUpperCase();
      const baseCoin = String(s?.baseCoin || "").toUpperCase();
      if (status !== "online") continue;
      if (quoteCoin !== "USDT") continue;
      if (!baseCoin) continue;
      set.add(baseCoin);
    }
    console.log("Bitget USDT base symbols loaded:", set.size);
    return set;
  } catch (e) {
    console.error("getBitgetSpotUsdtSymbols error:", e);
    return new Set();
  }
}

export async function fetchCoinGeckoTopCached() {
  try {
    const r = await fetch(
      "https://api.coingecko.com/api/v3/coins/markets?" +
      new URLSearchParams({
        vs_currency: "usd",
        order: "volume_desc",
        per_page: "250",
        page: "1",
        sparkline: "false",
        price_change_percentage: "1h,24h",
      })
    );
    if (!r.ok) throw new Error("CoinGecko fetch failed");
    const data = await r.json();
    return data.map((c) => {
      const marketCap = Number(c.market_cap || 0);
      const volume = Number(c.total_volume || 0);
      const high24 = Number(c.high_24h || 0);
      const low24 = Number(c.low_24h || 0);
      const range24 = high24 > 0 && low24 > 0
        ? ((high24 - low24) / ((high24 + low24) / 2)) * 100
        : 0;
      return {
        id: c.id,
        symbol: String(c.symbol || "").toUpperCase(),
        name: c.name || "",
        image: c.image || "",
        price: Number(c.current_price || 0),
        marketCap,
        volume,
        change24: Number(c.price_change_percentage_24h || 0),
        change1h: Number(c.price_change_percentage_1h_in_currency || 0),
        vm: marketCap > 0 ? volume / marketCap : 0,
        range24,
      };
    });
  } catch (e) {
    console.error("fetchCoinGeckoTopCached error", e);
    return [];
  }
}

export async function fetchBTCGateCached() {
  try {
    const r = await fetch("https://api.gateio.ws/api/v4/spot/tickers?currency_pair=BTC_USDT");
    if (!r.ok) throw new Error("Gate io BTC fetch failed");
    const data = await r.json();
    const ticker = Array.isArray(data) ? data[0] : null;
    if (!ticker) throw new Error("No BTC ticker");
    const price = Number(ticker.last || 0);
    const chg24 = Number(ticker.change_percentage || 0);
    const high = Number(ticker.high_24h || 0);
    const low = Number(ticker.low_24h || 0);
    const range24 = high > 0 && low > 0
      ? ((high - low) / ((high + low) / 2)) * 100
      : 0;
    const state = chg24 >= 1 ? "BULL" : chg24 <= -1 ? "BEAR" : "NEUTRAL";
    return { price, chg24, chg1h: 0, range24, state };
  } catch (e) {
    console.error("fetchBTCGateCached error", e);
    return { price: 0, chg24: 0, chg1h: 0, range24: 0, state: "NEUTRAL" };
  }
}

export const fetchBTCGateFromUniverse = fetchBTCGateCached;

// ---------- KV‐sleutels ----------
export function keyMoonLatest(mode) { return `moon:latest:${mode}`; }
export function keyMoonPortfolio(mode) { return `moon:portfolio:${mode}`; }
export function keyMoonPositions(mode) { return `moon:positions:${mode}`; }
export function keyMoonState(mode) { return `moon:state:${mode}`; }

// ---------- Authenticatie ----------
export function requireSecret(req, res) {
  const token = req.query?.token || req.headers?.authorization?.replace("Bearer ", "");
  if (token === process.env.CRON_SECRET) return true;
  res.statusCode = 401;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
  return false;
}