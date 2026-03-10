// /lib/_moon_core.js
import { kv } from "@vercel/kv";

// ---------- Runtime config ----------
export const RUNTIME_CONFIG = {
  runtime: "nodejs",
};

// ========== MOON-SPECIFIEKE CONFIGURATIE (explosie-focus) ==========
export const MOON_RADAR = {
  minVolume: 300_000,               // minimale 24h volume
  minVM: 0.2,                       // volume/market cap > 20%
  minChange24Bull: 8,                // bull mode: 24h stijging > 8%
  maxChange24Bear: -8,               // bear mode: 24h daling < -8%
  minChange1hBull: 2,                 // bull mode: 1h stijging > 2%
  maxChange1hBear: -2,                // bear mode: 1h daling < -2%
  maxMcap: 250_000_000,               // max market cap (kleine/mid caps)
  minMcap: 2_000_000,                  // min market cap (geen dust)
};

export const MOON_BUILDUP = {
  minVolAcc: 1.05,                    // volume accumulatie > 5%
  minConfidence: 50,                   // minimale confidence
};

export const MOON_ALMOST = {
  minConfidence: 60,
  maxFlat60Pct: 10,                    // max 10% vlak in laatste 60 candles
  consistencyMin: 0.4,                  // consistentie minder streng
};

export const MOON_ELITE = {
  minConfidence: 70,
  consistencyMin: 0.5,                  // iets strenger dan ALMOST
  obScoreMin: 0.01,                     // orderbook score (was 0.03) – veel soepeler
  spreadMaxPct: 2.0,                     // spread tot 2% toegestaan (was 0.95)
  largestOrderRatioMax: 0.9,             // grootste order mag 90% zijn (was 0.78)
  minDepthRatio: 0.5,                    // diepte mag 50% van floor zijn (was 0.8)
};

// Depth‑factor voor vloerberekening (verlaagd van 0.0014)
export const depthK = 0.00045;

// Tier‑definities met realistischere minimale diepte (verlaagd)
export const TIERS = [
  {
    name: "small",
    marketCapMax: 100_000_000,
    depthMinUsd: 1_000,
  },
  {
    name: "mid",
    marketCapMax: 500_000_000,
    depthMinUsd: 4_000,
  },
  {
    name: "upper-mid",
    marketCapMax: 2_000_000_000,
    depthMinUsd: 12_000,
  },
  {
    name: "large",
    marketCapMax: Infinity,
    depthMinUsd: 50_000,
  },
];

// Blokkadelijst
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
  const factor = tier === TIERS[0] ? 0.8 : tier === TIERS[1] ? 1.0 : tier === TIERS[2] ? 1.5 : 2.0;
  return Math.max(tier.depthMinUsd, Math.round(depthK * Math.sqrt(mcap) * factor));
}

// ---------- Confidence & Gates (Moon-aangepast) ----------
export function computeConfidence({ obScore, obAgree, vm, volAcc, btc, change24, range24 }) {
  let base = 30;                          // lagere basis

  // VM (volume/mcap ratio) – heel belangrijk
  base += Math.min(30, vm * 60);           // max 30 bij vm = 0.5

  // Volume accumulatie
  base += Math.min(20, (volAcc - 1) * 200); // max 20 bij volAcc = 1.1

  // 24h change (absoluut)
  base += Math.min(15, Math.abs(change24) * 1.5);

  // OB score bonus, minder zwaar
  base += Math.min(10, obScore * 100 * 2);

  // OB agreement bonus
  base += Math.min(8, obAgree * 20);

  // BTC regime bonus
  base += btc?.state === "BULL" ? 5 : 0;

  // Range penalty
  base -= Math.min(15, range24 * 2);

  return Math.max(20, Math.min(98, base));
}

export function passRadarMoon(coin, mode, btc) {
  if (!coin) return false;

  if (isBlockedMoonAsset(coin)) return false;
  if (coin.volume < MOON_RADAR.minVolume) return false;
  if (coin.marketCap < MOON_RADAR.minMcap || coin.marketCap > MOON_RADAR.maxMcap) return false;
  if (coin.vm < MOON_RADAR.minVM) return false;

  if (mode === "bull") {
    if (btc?.state === "BEAR") return false;
    if (coin.change24 < MOON_RADAR.minChange24Bull) return false;
    if (coin.change1h < MOON_RADAR.minChange1hBull) return false;
  } else { // bear
    if (btc?.state === "BULL") return false;
    if (coin.change24 > MOON_RADAR.maxChange24Bear) return false;
    if (coin.change1h > MOON_RADAR.maxChange1hBear) return false;
  }

  return true;
}

export function passBuildupMoon({ c, volAcc, confidence }) {
  if (!c) return { ok: false, why: "no_coin" };
  if (volAcc < MOON_BUILDUP.minVolAcc) return { ok: false, why: "low_vol_acc" };
  if (confidence < MOON_BUILDUP.minConfidence) return { ok: false, why: "low_confidence" };
  return { ok: true };
}

export function passAlmostMoon({ priceHist, volAcc, confidence, consistencyRatio, c }) {
  if (!c) return { ok: false, why: "no_coin" };
  if (confidence < MOON_ALMOST.minConfidence) return { ok: false, why: "low_confidence" };
  if (consistencyRatio < MOON_ALMOST.consistencyMin) return { ok: false, why: "low_consistency" };

  if (priceHist.length < 10) return { ok: false, why: "short_history" };
  const recent = priceHist.slice(-60);
  const maxPct = Math.max(...recent) / Math.min(...recent) - 1;
  if (maxPct * 100 < MOON_ALMOST.maxFlat60Pct) return { ok: false, why: "too_flat" };

  return { ok: true };
}

export function passEliteMoon({ mode, obView, confidence, consistencyRatio, depthUsd, floorUsd, range24, tier }) {
  if (confidence < MOON_ELITE.minConfidence) return { ok: false, why: "low_confidence" };
  if (consistencyRatio < MOON_ELITE.consistencyMin) return { ok: false, why: "low_consistency" };

  if (obView.score < MOON_ELITE.obScoreMin) return { ok: false, why: "low_ob_score" };
  if (obView.spreadPct > MOON_ELITE.spreadMaxPct) return { ok: false, why: "high_spread" };
  if (obView.lor > MOON_ELITE.largestOrderRatioMax) return { ok: false, why: "high_lor" };
  if (depthUsd < floorUsd * MOON_ELITE.minDepthRatio) return { ok: false, why: "low_depth" };

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

// ---------- Data‐ophaling (gecorrigeerd) ----------

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

      const range24 =
        high24 > 0 && low24 > 0
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

    const range24 =
      high > 0 && low > 0
        ? ((high - low) / ((high + low) / 2)) * 100
        : 0;

    const state = chg24 >= 1 ? "BULL" : chg24 <= -1 ? "BEAR" : "NEUTRAL";

    return {
      price,
      chg24,
      chg1h: 0,
      range24,
      state,
    };
  } catch (e) {
    console.error("fetchBTCGateCached error", e);
    return { price: 0, chg24: 0, chg1h: 0, range24: 0, state: "NEUTRAL" };
  }
}

export const fetchBTCGateFromUniverse = fetchBTCGateCached;

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

// ---------- Authenticatie ----------
export function requireSecret(req, res) {
  const token = req.query?.token || req.headers?.authorization?.replace("Bearer ", "");
  if (token === process.env.CRON_SECRET) return true;
  res.statusCode = 401;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
  return false;
}