// lib/_moon_core.js
import { kv } from "@vercel/kv";

// ==================== CONFIG ====================
export const SETTINGS = {
  CG_TOP: 1500,
  RADAR_LIMIT: 60,
};

// ==================== RUNTIME ====================
export const RUNTIME_CONFIG = { maxDuration: 60 };

// ==================== AUTH ====================
export function requireSecret(req, res) {
  const token = req.query?.token || req.headers?.authorization?.replace("Bearer ", "");
  const ok = token && (token === process.env.API_SECRET || token === process.env.CRON_SECRET);
  if (!ok) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}

// ==================== KV KEYS ====================
export function keyMainLatest(mode) { return `main:latest:${mode}`; }
export function keyMoonLatest(mode) { return `moon:latest:${mode}`; }
export function keyMainPositions(mode) { return `main:positions:${mode}`; }
export function keyMoonPositions(mode) { return `moon:positions:${mode}`; }
export function keyMainState(mode) { return `main:state:${mode}`; }
export function keyMoonState(mode) { return `moon:state:${mode}`; }
export function keyMainPortfolio(mode) { return `main:portfolio:${mode}`; }
export function keyMoonPortfolio(mode) { return `moon:portfolio:${mode}`; }

// ==================== DATA FETCHERS ====================
const CG_TOP_CACHE_KEY = `cg:top:cache:${SETTINGS.CG_TOP}`;
const CG_TOP_TTL = 60 * 60; // 1 hour

export async function fetchCoinGeckoTopCached() {
  try {
    const cached = await kv.get(CG_TOP_CACHE_KEY);
    if (cached && Array.isArray(cached) && cached.length) return cached;

    const allCoins = [];
    const perPage = 250;
    const maxPages = Math.ceil(SETTINGS.CG_TOP / perPage);
    for (let page = 1; page <= maxPages; page++) {
      const url =
        `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc` +
        `&per_page=${perPage}&page=${page}&sparkline=false&price_change_percentage=1h,24h`;
      const res = await fetch(url);
      if (!res.ok) break;
      const data = await res.json();
      if (!data.length) break;

      for (const c of data) {
        const low = Number(c.low_24h || 0);
        const high = Number(c.high_24h || 0);
        const range24 = low > 0 && high > 0 ? ((high - low) / low) * 100 : 0;

        allCoins.push({
          id: c.id,
          symbol: (c.symbol || "").toUpperCase(),
          name: c.name || "",
          image: c.image || "",
          price: c.current_price || 0,
          marketCap: c.market_cap || 0,
          volume: c.total_volume || 0,
          change24: c.price_change_percentage_24h ?? 0,
          change1h: c.price_change_percentage_1h_in_currency ?? 0,
          high24: high,
          low24: low,
          range24,
          vm: (c.total_volume || 0) / (c.market_cap || 1),
        });
      }

      if (data.length < perPage) break;
    }

    await kv.set(CG_TOP_CACHE_KEY, allCoins, { ex: CG_TOP_TTL });
    return allCoins;
  } catch (e) {
    console.error("fetchCoinGeckoTopCached error:", e);
    return [];
  }
}

const BITGET_SYMBOLS_CACHE_KEY = "bitget:symbols:usdt";
const BITGET_SYMBOLS_TTL = 60 * 60; // 1 hour

export async function getBitgetSpotUsdtSymbols() {
  try {
    const cached = await kv.get(BITGET_SYMBOLS_CACHE_KEY);
    if (Array.isArray(cached) && cached.length) return new Set(cached);

    const url = "https://api.bitget.com/api/v2/spot/public/symbols";
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Bitget status ${res.status}`);
    const json = await res.json();
    if (String(json?.code) !== "00000") throw new Error(`Bitget error: ${json?.msg}`);

    const symbols = json.data
      .filter((s) => s.quoteCoin === "USDT")
      .map((s) => String(s.symbol || "").toUpperCase());

    await kv.set(BITGET_SYMBOLS_CACHE_KEY, symbols, { ex: BITGET_SYMBOLS_TTL });
    return new Set(symbols);
  } catch (e) {
    console.error("getBitgetSpotUsdtSymbols error:", e);
    return new Set();
  }
}

export async function fetchBTCGateFromUniverse() {
  try {
    const coins = await fetchCoinGeckoTopCached();
    const btc = coins.find((c) => c.symbol === "BTC");
    if (!btc) throw new Error("BTC not found in CG top");
    return {
      price: btc.price,
      chg24: btc.change24,
      chg1h: btc.change1h,
      range24: btc.range24 ?? 0,
      state: btc.change24 >= 1.0 ? "BULL" : btc.change24 <= -1.0 ? "BEAR" : "NEUTRAL",
    };
  } catch (e) {
    console.error("fetchBTCGateFromUniverse error:", e);
    return { price: 0, chg24: 0, chg1h: 0, range24: 0, state: "NEUTRAL" };
  }
}

// ==================== SCORING HELPERS ====================
export function computeMarketRegime({ btc, whaleFlow, mode }) {
  const btcState = btc?.state || "NEUTRAL";
  const chg24 = btc?.chg24 || 0;
  if (btcState === "BULL" && chg24 > 1.5 && whaleFlow > 10) return "EXPANSION";
  if (btcState === "BEAR" && chg24 < -1.5 && whaleFlow < 5) return "CONTRACTION";
  if ((btcState === "BULL" && chg24 < 0.5) || (btcState === "BEAR" && chg24 > -0.5)) return "HEADWIND";
  return "TREND";
}

export function computeQualityScore({ coin, moveScore, entryQuality, persistenceScore, velocity, compression, breakout }) {
  let score =
    (moveScore * 0.25) +
    (entryQuality * 0.25) +
    (persistenceScore * 0.2) +
    (velocity * 100 * 0.15);
  if (compression?.isCompressed) score += 5;
  if (breakout?.ready) score += 8;
  return Math.min(100, Math.max(0, Math.round(score)));
}

export function computeLiquidityScore({ ob, depthOk, spreadPct, depthMinUsd1p }) {
  let score = 0;
  if (depthOk) score += 25;
  if (ob?.valid && ob?.fresh) score += 25;
  if (spreadPct < 0.8) score += 25;
  else if (spreadPct < 1.2) score += 15;
  else if (spreadPct < 1.8) score += 5;
  if (depthMinUsd1p > 50000) score += 25;
  else if (depthMinUsd1p > 20000) score += 15;
  else if (depthMinUsd1p > 10000) score += 5;
  return Math.min(100, score);
}

export function computeTimingScore({ mode, stage, breakout, volAcc, strongScans, eliteScans, lateEntry, exhausted, bounceTrap }) {
  let score = 50;
  if (stage === "ELITE_IGNITION" || stage === "ELITE_EXPANSION" || stage === "ELITE_CASCADE") score += 20;
  else if (stage === "ALMOST") score += 10;
  else if (stage === "BUILDUP") score += 5;
  if (breakout?.ready) score += 15;
  if (volAcc.short > 1.2 && volAcc.medium > 1.1) score += 10;
  if (strongScans >= 3) score += 5;
  if (eliteScans >= 2) score += 8;
  if (lateEntry || exhausted || bounceTrap) score -= 20;
  return Math.min(100, Math.max(0, score));
}

export function computeMarketScore({ btc, mode, regime, whaleFlow }) {
  const btcState = btc?.state || "NEUTRAL";
  let score = 50;

  if (mode === "bull" && btcState === "BULL") score += 25;
  else if (mode === "bull" && btcState === "NEUTRAL") score += 10;
  else if (mode === "bear" && btcState === "BEAR") score += 25;
  else if (mode === "bear" && btcState === "NEUTRAL") score += 10;
  else score -= 20;

  if (regime === "EXPANSION") score += 15;
  else if (regime === "CONTRACTION") score -= 15;
  else if (regime === "HEADWIND") score -= 10;

  if (whaleFlow > 12) score += 10;
  else if (whaleFlow < 5) score -= 10;

  return Math.min(100, Math.max(0, score));
}

export function computeBtcAlignmentScore({ btc, mode, regime }) {
  const btcState = btc?.state || "NEUTRAL";
  let score = 50;

  if (mode === "bull" && btcState === "BULL") score += 30;
  else if (mode === "bull" && btcState === "NEUTRAL") score += 10;
  else if (mode === "bear" && btcState === "BEAR") score += 30;
  else if (mode === "bear" && btcState === "NEUTRAL") score += 10;
  else score -= 25;

  if (regime === "EXPANSION") score += 15;
  else if (regime === "CONTRACTION") score -= 15;

  return Math.min(100, Math.max(0, score));
}

export function computePerfectCandidateScore({ qualityScore, liquidityScore, timingScore, marketScore }) {
  return Math.round(
    (qualityScore * 0.3) +
    (liquidityScore * 0.25) +
    (timingScore * 0.25) +
    (marketScore * 0.2)
  );
}

// ==================== RISK / TRADE PLAN ====================
export function computeMoonRisk({ mode, price, range24, confidence, depthOk, tier, regime, persistenceScore, performance }) {
  if (!price || !range24) return null;

  const volatilityFactor = range24 / 100;
  const confidenceFactor = confidence / 100;
  const persistenceFactor = persistenceScore / 100;

  const baseSlPct = 1.2;
  let slPct = baseSlPct + volatilityFactor * 2;

  if (depthOk) slPct *= 0.9;
  if (tier?.name === "micro") slPct *= 1.2;
  if (regime === "HEADWIND") slPct *= 1.15;
  if (performance?.winRate < 45) slPct *= 1.1;

  slPct = Math.min(8, Math.max(1.2, slPct));

  const tpPct = slPct * (1.5 + confidenceFactor * 0.8 + persistenceFactor * 0.5);
  const sl = price * (1 - slPct / 100);
  const tp = price * (1 + tpPct / 100);

  return { sl, tp, tp3: tp, slPct, tpPct };
}

// ==================== MAIN CONFIG ====================
export const MAIN_V2 = {
  bull: {
    minCh1hExpansion: 2.2, minCh24Expansion: 12, minVmElite: 0.32, minObStrong: 0.03,
    explosiveVelocity: 0.28, minPersistenceExpansion: 74,
    minCh1hIgnition: 1.2, minCh24Ignition: 6, strongVelocity: 0.18, minPersistenceIgnition: 64,
    minCh1hAlmost: 0.8, minCh24Almost: 4.5, minVmAlmost: 0.20,
    minCh1hBuildup: 0.3, minCh24Buildup: 1.5, minVmBuildup: 0.12, minVelocity: 0.06,
  },
  bear: {
    maxCh1hCascade: -2.2, maxCh24Cascade: -12, minVmElite: 0.32, minObStrongAbs: 0.03,
    explosiveVelocity: 0.28, minPersistenceExpansion: 74,
    maxCh1hIgnition: -1.2, maxCh24Ignition: -6, strongVelocity: 0.18, minPersistenceIgnition: 64,
    maxCh1hAlmost: -0.8, maxCh24Almost: -4.5, minVmAlmost: 0.20,
    maxCh1hBuildup: -0.3, maxCh24Buildup: -1.5, minVmBuildup: 0.12, minVelocity: 0.06,
  },
};

export function adjustMoonConfigForRegime(cfg, regime) {
  if (regime === "EXPANSION") {
    return { ...cfg, minCh1hExpansion: cfg.minCh1hExpansion * 0.8, minCh24Expansion: cfg.minCh24Expansion * 0.8 };
  }
  if (regime === "CONTRACTION") {
    return { ...cfg, minCh1hExpansion: cfg.minCh1hExpansion * 1.2, minCh24Expansion: cfg.minCh24Expansion * 1.2 };
  }
  return cfg;
}

// ==================== STAGE HELPERS ====================
export function computeVelocity(ch1, ch24) { return (Math.abs(ch1) * 0.4) + (Math.abs(ch24) * 0.6); }

export function computeCompression(priceHist) {
  if (priceHist.length < 5) return { isCompressed: false, flatPct: 100 };
  const slice = priceHist.slice(-5);
  const max = Math.max(...slice);
  const min = Math.min(...slice);
  const flatPct = ((max - min) / min) * 100;
  return { isCompressed: flatPct < 3, flatPct };
}

export function computeBreakoutPressure(priceHist) {
  if (priceHist.length < 10) return { ready: false, pressure: 0, breakoutPct: 0 };
  const recent = priceHist.slice(-5);
  const older = priceHist.slice(-10, -5);
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
  const pressure = ((recentAvg - olderAvg) / olderAvg) * 100;
  return { ready: pressure > 2.5, pressure, breakoutPct: pressure };
}

export function computePersistenceScore({ priceHist, volHist, stageHist, mode }) {
  if (priceHist.length < 10) return 50;
  const recentPrice = priceHist.slice(-5);
  const olderPrice = priceHist.slice(-10, -5);
  const priceChange =
    (recentPrice.reduce((a, b) => a + b, 0) / recentPrice.length) /
    (olderPrice.reduce((a, b) => a + b, 0) / olderPrice.length) - 1;

  const volChange =
    volHist.length > 5
      ? (volHist.slice(-5).reduce((a, b) => a + b, 0) / volHist.slice(-10, -5).reduce((a, b) => a + b, 0))
      : 1;

  let score = 50 + priceChange * 50 + (volChange - 1) * 30;
  return Math.min(100, Math.max(0, Math.round(score)));
}

export function computeEliteQuality({ moveScore, velocity, vm, obScore, compression, volAcc, persistenceScore, regime, breakoutReady }) {
  let score =
    (moveScore * 0.2) +
    (velocity * 100 * 0.2) +
    (vm * 100 * 0.2) +
    (obScore * 100 * 0.1) +
    (persistenceScore * 0.2);

  if (compression?.isCompressed) score += 5;
  if (volAcc.short > 1.2) score += 5;
  if (breakoutReady) score += 8;
  if (regime === "EXPANSION") score += 8;

  return Math.min(100, Math.max(0, Math.round(score)));
}

export function computeBullMoveScore(coin, obx) {
  return Math.min(100, Math.max(0, (coin.change1h * 15) + (coin.change24 * 5) + (coin.vm * 100) + (obx.score * 50)));
}

export function computeBearMoveScore(coin, obx) {
  return Math.min(100, Math.max(0, (Math.abs(coin.change1h) * 15) + (Math.abs(coin.change24) * 5) + (coin.vm * 100) + (Math.abs(obx.score) * 50)));
}

export function isBullExhausted(coin) { return coin.change1h < 0 && coin.change24 > 20 && coin.vm < 0.1; }
export function isBearBounceTrap(coin) { return coin.change1h > 0 && coin.change24 < -20 && coin.vm < 0.1; }
export function isLateBullEntry(coin) { return coin.change24 > 35; }
export function isLateBearEntry(coin) { return coin.change24 < -35; }

export function computeMoonProbabilities({ mode, coin, moveScore, velocity, compression, persistenceScore }) {
  const moon = (moveScore * 0.3 + velocity * 0.2 + (compression.isCompressed ? 1 : 0) * 0.2 + persistenceScore * 0.3) / 100;
  const dump = (100 - moveScore) / 100;
  return { moonProbability: Math.min(0.95, moon), dumpProbability: Math.min(0.8, dump) };
}

// ==================== FILTERS / ASSET BLOCK ====================
export function isBlockedMoonAsset(coin) {
  const blocked = ["USDT", "USDC", "DAI", "BUSD", "TUSD", "UST", "LUNA", "WETH", "WBTC", "STETH"];
  return blocked.includes(coin.symbol?.toUpperCase());
}

export function getTierForMcap(mcap) {
  if (mcap < 50_000_000) return { name: "micro", factor: 1.2 };
  if (mcap < 200_000_000) return { name: "small", factor: 1.0 };
  if (mcap < 500_000_000) return { name: "mid", factor: 0.8 };
  return { name: "large", factor: 0.6 };
}

export function depthFloorUsd(mcap, tier, depthHist) {
  const base = mcap / 1000;
  if (tier?.name === "micro") return Math.max(8000, base * 0.2);
  if (tier?.name === "small") return Math.max(15000, base * 0.15);
  if (tier?.name === "mid") return Math.max(25000, base * 0.1);
  return Math.max(40000, base * 0.05);
}