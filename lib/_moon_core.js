// /lib/_moon_core.js
import { kv } from "@vercel/kv";

// ---------- Configuratie ----------
export const RUNTIME_CONFIG = {
  runtime: "edge",
};

// Depth‑factor voor vloerberekening (verlaagd van 0.0014)
export const depthK = 0.00045;

// Tier‑definities met realistischere minimale diepte (verlaagd)
export const TIERS = [
  {
    name: "small",
    marketCapMax: 100_000_000,
    depthMinUsd: 1_000,          // was 3_000
  },
  {
    name: "mid",
    marketCapMax: 500_000_000,
    depthMinUsd: 4_000,           // was 12_000
  },
  {
    name: "upper-mid",
    marketCapMax: 2_000_000_000,
    depthMinUsd: 12_000,          // was 40_000
  },
  {
    name: "large",
    marketCapMax: Infinity,
    depthMinUsd: 50_000,
  },
];

// Bouwstenen voor stage‑promotie (versoepeld)
export const BUILDUP_CONFIG = {
  minVolAcc: 1.02,                // minimale volume‑accumulatie
  minConfidence: 42,              // minimale confidence (was wellicht hoger)
};

export const ALMOST_CONFIG = {
  minConfidence: 52,
  maxFlat60Pct: 8.5,               // max percentage vlak in laatste 60 candles
};

export const ELITE_CONFIG = {
  minConfidence: 64,
  consistencyMin: 0.50,            // minimale consistentie‑ratio (was 0.60?)
  obScoreMin: 0.030,               // minimale orderbook‑score (was 0.045)
  spreadMaxPct: 0.95,              // maximale spread in % (was 0.75)
  largestOrderRatioMax: 0.78,      // maximale ratio grootste order
  depthFactor: 1.0,
  minDepthRatio: 0.8,
};

// Blokkadelijst (voorbeeld)
const BLOCKED_SYMBOLS = ["USDT", "BUSD", "DAI", "USDC", "TUSD", "PAX", "UST", "LUNC", "LUNA"];

// ---------- Hulpfuncties ----------
export function isBlockedMoonAsset(coin) {
  if (!coin || !coin.symbol) return true;
  const sym = coin.symbol.toUpperCase();
  return BLOCKED_SYMBOLS.includes(sym) || sym.endsWith("USD") || sym.endsWith("EUR");
}

export function getTierForMcap(mcap) {
  for (const tier of TIERS) {
    if (mcap < tier.marketCapMax) return tier;
  }
  return TIERS[TIERS.length - 1];
}

export function depthFloorUsd(mcap, tier) {
  // depthK * sqrt(mcap) * (tier factor)
  const factor = tier === TIERS[0] ? 0.8 : tier === TIERS[1] ? 1.0 : tier === TIERS[2] ? 1.5 : 2.0;
  return Math.max(tier.depthMinUsd, Math.round(depthK * Math.sqrt(mcap) * factor));
}

// ---------- Confidence & Gates ----------
export function computeConfidence({ obScore, obAgree, vm, volAcc, btc, change24, range24 }) {
  let base = 40;
  base += Math.min(25, obScore * 100 * 2.5);
  base += Math.min(15, obAgree * 100);
  base += Math.min(20, vm * 40);
  base += Math.min(10, (volAcc - 1) * 200);
  base += btc?.state === "BULL" ? 8 : 0;
  base += Math.min(10, Math.abs(change24) / 2);
  base -= Math.min(15, range24 * 2);
  return Math.max(20, Math.min(98, base));
}

export function passRadarMoon(coin, mode, btc) {
  if (!coin) return false;
  if (coin.volume < 200_000) return false;
  if (mode === "bull" && btc?.state === "BEAR") return false;
  if (mode === "bear" && btc?.state === "BULL") return false;
  return true;
}

export function passBuildupMoon({ c, volAcc, confidence }) {
  if (!c) return { ok: false, why: "no_coin" };
  if (volAcc < BUILDUP_CONFIG.minVolAcc) return { ok: false, why: "low_vol_acc" };
  if (confidence < BUILDUP_CONFIG.minConfidence) return { ok: false, why: "low_confidence" };
  return { ok: true };
}

export function passAlmostMoon({ priceHist, volAcc, confidence, consistencyRatio, c }) {
  if (!c) return { ok: false, why: "no_coin" };
  if (confidence < ALMOST_CONFIG.minConfidence) return { ok: false, why: "low_confidence" };
  if (consistencyRatio < 0.33) return { ok: false, why: "low_consistency" };
  // bereken vlakheid (maxFlat60Pct)
  if (priceHist.length < 10) return { ok: false, why: "short_history" };
  const recent = priceHist.slice(-60);
  const maxPct = Math.max(...recent) / Math.min(...recent) - 1;
  if (maxPct * 100 < ALMOST_CONFIG.maxFlat60Pct) return { ok: false, why: "too_flat" };
  return { ok: true };
}

export function passEliteMoon({ mode, obView, confidence, consistencyRatio, depthUsd, floorUsd, range24, tier }) {
  if (confidence < ELITE_CONFIG.minConfidence) return { ok: false, why: "low_confidence" };
  if (consistencyRatio < ELITE_CONFIG.consistencyMin) return { ok: false, why: "low_consistency" };
  if (obView.score < ELITE_CONFIG.obScoreMin) return { ok: false, why: "low_ob_score" };
  if (obView.spreadPct > ELITE_CONFIG.spreadMaxPct) return { ok: false, why: "high_spread" };
  if (obView.lor > ELITE_CONFIG.largestOrderRatioMax) return { ok: false, why: "high_lor" };
  if (depthUsd < floorUsd * ELITE_CONFIG.minDepthRatio) return { ok: false, why: "low_depth" };
  return { ok: true };
}

// ---------- Risico & Tradeplan ----------
export function computeMoonRisk({ mode, price, range24, confidence, depthOk, tier }) {
  if (!price || price <= 0) return null;
  const atrFactor = Math.min(0.15, Math.max(0.02, range24 / price || 0.02));
  const baseSlPct = mode === "bull" ? 0.06 : 0.05;
  const baseTpPct = mode === "bull" ? 0.15 : 0.12;

  let slPct = baseSlPct + atrFactor * 0.5;
  let tpPct = baseTpPct + atrFactor * 1.5;

  // aanpassen op basis van confidence
  if (confidence > 80) {
    tpPct *= 1.2;
  } else if (confidence < 50) {
    slPct *= 1.1;
  }

  // stop loss en take profit prijzen
  const sl = mode === "bull" ? price * (1 - slPct) : price * (1 + slPct);
  const tp3 = mode === "bull" ? price * (1 + tpPct) : price * (1 - tpPct);

  return {
    sl,
    tp3,
    slPct,
    tpPct,
  };
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

// ---------- Data‐ophaling ----------
export async function fetchBTCGateCached() {
  try {
    const r = await fetch("https://api.gateio.ws/api/v4/spot/tickers?currency_pair=BTC_USDT");
    if (!r.ok) throw new Error("Gate io BTC fetch failed");
    const data = await r.json();
    const ticker = data[0];
    const price = parseFloat(ticker.last);
    const change24 = parseFloat(ticker.change_percentage);
    const high = parseFloat(ticker.high_24h);
    const low = parseFloat(ticker.low_24h);
    const range24 = high - low;
    const state = change24 > 2 ? "BULL" : change24 < -2 ? "BEAR" : "NEUTRAL";
    return {
      price,
      chg24: change24,
      range24,
      state,
    };
  } catch (e) {
    console.error("fetchBTCGateCached error", e);
    return { price: 0, chg24: 0, range24: 0, state: "NEUTRAL" };
  }
}

// Alias voor consistentie met scan.js
export const fetchBTCGateFromUniverse = fetchBTCGateCached;

export async function fetchCoinGeckoTopCached() {
  try {
    const r = await fetch(
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=250&page=1&sparkline=false"
    );
    if (!r.ok) throw new Error("CoinGecko fetch failed");
    const data = await r.json();
    return data.map((c) => ({
      id: c.id,
      symbol: c.symbol.toUpperCase(),
      name: c.name,
      image: c.image,
      price: c.current_price,
      marketCap: c.market_cap,
      volume: c.total_volume,
      change24: c.price_change_percentage_24h || 0,
      change1h: 0, // niet geleverd
      vm: (c.total_volume / c.market_cap) * 100 || 0,
      range24: c.high_24h - c.low_24h || 0,
    }));
  } catch (e) {
    console.error("fetchCoinGeckoTopCached error", e);
    return [];
  }
}

export async function getBitgetSpotUsdtSymbols() {
  try {
    const r = await fetch("https://api.bitget.com/api/v2/spot/public/symbols");
    if (!r.ok) return new Set();
    const json = await r.json();
    if (json.code !== "00000") return new Set();
    const symbols = json.data
      .filter((s) => s.quoteCoin === "USDT" && s.status === "online")
      .map((s) => s.symbol);
    return new Set(symbols);
  } catch {
    return new Set();
  }
}

// ---------- KV‐sleutels ----------
export function keyMoonLatest(mode) {
  return `moon:latest:${mode}`;
}
export function keyMoonPortfolio(mode) {
  return `moon:portfolio:${mode}`;
}
export function keyMoonPositions(mode) {
  return `moon:positions:${mode}`;
}
export function keyMoonState(mode) {
  return `moon:state:${mode}`;
}

// ---------- Authenticatie voor cron/scan ----------
export function requireSecret(req, res) {
  const token = req.query?.token || req.headers?.authorization?.replace("Bearer ", "");
  if (token === process.env.CRON_SECRET) return true;
  res.statusCode = 401;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
  return false;
}