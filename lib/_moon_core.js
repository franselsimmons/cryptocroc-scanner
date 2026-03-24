// lib/_moon_core.js
import { kv } from "@vercel/kv";

// ======================================================
// Runtime config (Vercel)
// ======================================================
export const RUNTIME_CONFIG = {
  runtime: "nodejs",
  maxDuration: 60,
};

// ======================================================
// Helpers
// ======================================================
function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}
function up(x) {
  return String(x || "").toUpperCase();
}
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// ======================================================
// AUTH (token query + Bearer token)
// ======================================================
export function requireSecret(req, res) {
  const token =
    req.query?.token ||
    req.query?.secret ||
    req.headers?.authorization?.replace("Bearer ", "");

  if (token === process.env.CRON_SECRET) return true;

  res.statusCode = 401;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
  return false;
}

// ======================================================
// Configuraties – Main en Moon
// ======================================================
export const MAIN_V2 = {
  bull: {
    minCh1hBuildup: 0.8,
    minCh24Buildup: 5.0,
    minVmBuildup: 0.12,
    minVelocity: 0.06,
    minCh1hAlmost: 1.2,
    minCh24Almost: 7.0,
    minVmAlmost: 0.22,
    minCh1hIgnition: 1.8,
    minCh24Ignition: 12.0,
    minVmElite: 0.35,
    minObStrong: 0.03,
    strongVelocity: 0.14,
    explosiveVelocity: 0.22,
    minPersistenceIgnition: 60,
    minPersistenceExpansion: 70,
  },
  bear: {
    maxCh1hBuildup: -0.8,
    maxCh24Buildup: -5.0,
    minVmBuildup: 0.12,
    minVelocity: 0.06,
    maxCh1hAlmost: -1.2,
    maxCh24Almost: -7.0,
    minVmAlmost: 0.22,
    maxCh1hIgnition: -1.8,
    maxCh24Ignition: -12.0,
    minVmElite: 0.35,
    minObStrongAbs: 0.03,
    strongVelocity: 0.14,
    explosiveVelocity: 0.22,
    minPersistenceIgnition: 60,
    minPersistenceExpansion: 70,
  },
};

export const MOON_V2 = {
  bull: {
    minCh1hBuildup: 1.0,
    minCh24Buildup: 6.5,
    minVmBuildup: 0.15,
    minVelocity: 0.08,
    minCh1hAlmost: 1.6,
    minCh24Almost: 9.0,
    minVmAlmost: 0.28,
    minCh1hIgnition: 2.2,
    minCh24Ignition: 16.0,
    minVmElite: 0.45,
    minObStrong: 0.04,
    strongVelocity: 0.18,
    explosiveVelocity: 0.28,
    minPersistenceIgnition: 65,
    minPersistenceExpansion: 75,
  },
  bear: {
    maxCh1hBuildup: -1.0,
    maxCh24Buildup: -6.5,
    minVmBuildup: 0.15,
    minVelocity: 0.08,
    maxCh1hAlmost: -1.6,
    maxCh24Almost: -9.0,
    minVmAlmost: 0.28,
    maxCh1hIgnition: -2.2,
    maxCh24Ignition: -16.0,
    minVmElite: 0.45,
    minObStrongAbs: 0.04,
    strongVelocity: 0.18,
    explosiveVelocity: 0.28,
    minPersistenceIgnition: 65,
    minPersistenceExpansion: 75,
  },
};

// ======================================================
// KV Keys
// ======================================================
export function keyMainLatest(mode) { return `main:latest:${mode}`; }
export function keyMainPortfolio(mode) { return `main:portfolio:${mode}`; }
export function keyMainPositions(mode) { return `main:positions:${mode}`; }
export function keyMainState(mode) { return `main:state:${mode}`; }

export function keyMoonLatest(mode) { return `moon:latest:${mode}`; }
export function keyMoonPortfolio(mode) { return `moon:portfolio:${mode}`; }
export function keyMoonPositions(mode) { return `moon:positions:${mode}`; }
export function keyMoonState(mode) { return `moon:state:${mode}`; }

// ======================================================
// Externe data fetch helpers
// ======================================================
export async function fetchBTCGateFromUniverse() {
  try {
    const res = await fetch("https://api.btcgate.com/api/v1/btc/usdt");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return {
      price: n(data.price, 0),
      chg24: n(data.change24, 0),
      chg1h: n(data.change1h, 0),
      range24: n(data.range24, 0),
      state: data.state || "NEUTRAL",
    };
  } catch (e) {
    console.warn("fetchBTCGateFromUniverse failed:", e?.message || e);
    return null;
  }
}

export async function fetchCoinGeckoTopCached() {
  try {
    const cacheKey = "coingecko:top:250";
    const cached = await kv.get(cacheKey);
    if (cached && Date.now() - (cached.timestamp || 0) < 5 * 60 * 1000) {
      return cached.data;
    }

    const url =
      "https://api.coingecko.com/api/v3/coins/markets?" +
      new URLSearchParams({
        vs_currency: "usd",
        order: "market_cap_desc",
        per_page: "250",
        page: "1",
        sparkline: "false",
      });

    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const mapped = (data || []).map((c) => {
      const price = n(c.current_price, 0);
      const high24 = n(c.high_24h, 0);
      const low24 = n(c.low_24h, 0);

      const range24 =
        high24 > 0 && low24 > 0 && price > 0
          ? (Math.abs(high24 - low24) / price) * 100
          : 0;

      return {
        id: c.id,
        symbol: up(c.symbol),
        name: c.name,
        image: c.image,
        price,
        marketCap: n(c.market_cap, 0),
        volume: n(c.total_volume, 0),
        change24: n(c.price_change_percentage_24h, 0),
        change1h: 0, // deze endpoint geeft geen 1h
        vm: n(c.total_volume, 0) / Math.max(n(c.market_cap, 0), 1),
        range24,
      };
    });

    await kv.set(cacheKey, { data: mapped, timestamp: Date.now() }, { ex: 300 });
    return mapped;
  } catch (e) {
    console.error("fetchCoinGeckoTopCached failed:", e?.message || e);
    return [];
  }
}

export async function getBitgetSpotUsdtSymbols() {
  try {
    const cacheKey = "bitget:spot:symbols";
    const cached = await kv.get(cacheKey);
    if (cached && Date.now() - (cached.timestamp || 0) < 60 * 60 * 1000) {
      return new Set(cached.symbols || []);
    }

    const url = "https://api.bitget.com/api/v2/spot/public/symbols";
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();

    const symbols = (json.data || [])
      .filter((s) => up(s.quoteCoin) === "USDT")
      .map((s) => String(s.symbolName || ""))
      .filter((s) => s && s.endsWith("USDT"))
      .map((s) => s.replace("USDT", ""));

    const set = new Set(symbols.map(up));
    await kv.set(cacheKey, { symbols: Array.from(set), timestamp: Date.now() }, { ex: 3600 });
    return set;
  } catch (e) {
    console.error("getBitgetSpotUsdtSymbols failed:", e?.message || e);
    return new Set();
  }
}

// ======================================================
// Tier & depth
// ======================================================
export function getTierForMcap(mcap) {
  if (!mcap) return { tier: 0, name: "unknown" };
  if (mcap >= 1e9) return { tier: 3, name: "large" };
  if (mcap >= 300e6) return { tier: 2, name: "mid" };
  return { tier: 1, name: "small" };
}

export function depthFloorUsd(mcap, tier, depthHist = []) {
  if (tier?.tier >= 3) return 500_000;
  if (tier?.tier >= 2) return 200_000;

  const arr = Array.isArray(depthHist) ? depthHist.slice(-10).map((x) => n(x, 0)) : [];
  const histAvg = arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length);

  return Math.max(50_000, histAvg * 0.8);
}

// ======================================================
// Stop / TP / risk  (ADAPTIVE EXIT + DRAWDOWN)
// ======================================================
export function computeMoonRisk({
  mode,
  price,
  range24,
  confidence,
  depthOk,
  tier,
  regime = "NEUTRAL",
  persistenceScore = 50,

  // ✅ nieuw: direct drawdown meegeven
  drawdown = 0,

  // ✅ backward compat: als je nog performance doorgeeft
  performance = null,
}) {
  if (!price || price <= 0) return null;
  if (confidence < 30) return null;
  if (!depthOk && (tier?.tier || 0) < 2) return null;

  const volFactor = Math.min(1.2, 0.8 + (n(range24, 0) / 20));
  const confFactor = Math.min(1.2, 0.7 + (n(confidence, 0) / 70));
  const persFactor = Math.min(1.15, 0.8 + (n(persistenceScore, 50) / 80));

  let slPct = 2.5 * volFactor / confFactor / persFactor;
  let tpPct = 5.5 * confFactor * persFactor;

  // Tier adjustment
  if (tier?.tier === 3) {
    slPct *= 0.9;
    tpPct *= 0.85;
  } else if (tier?.tier === 1) {
    slPct *= 1.15;
    tpPct *= 1.1;
  }

  // Regime adjustment
  const reg = up(regime);
  if (reg === "HEADWIND") {
    slPct *= 1.1;
    tpPct *= 0.8;
  }
  if (reg === "EXPANSION") {
    slPct *= 0.9;
    tpPct *= 1.15;
  }

  // 🟢 Adaptive exit bij slechte confidence
  if (confidence < 55) tpPct -= 2.5;
  if (confidence < 45) tpPct -= 3.5;

  // 🔴 SL strakker bij drawdown (direct of via performance fallback)
  const dd = n(performance?.drawdown, n(drawdown, 0));
  if (dd > 40) slPct -= 0.6;
  if (dd > 55) slPct -= 0.4;

  // Harde minima
  slPct = Math.max(1.0, slPct);
  tpPct = Math.max(2.5, tpPct);

  // Bear gebruikt dezelfde percentages, maar richting omgekeerd
  const p = n(price, 0);
  const sl = mode === "bull" ? p * (1 - slPct / 100) : p * (1 + slPct / 100);
  const tp = mode === "bull" ? p * (1 + tpPct / 100) : p * (1 - tpPct / 100);

  return {
    sl,
    tp,
    tp3: tp,
    slPct: Number(slPct.toFixed(2)),
    tpPct: Number(tpPct.toFixed(2)),
    tp2: tp,
    tp1: tp,
  };
}

// ======================================================
// Helpers voor indicators
// ======================================================
export function computeVelocity(ch1h, ch24) {
  // simpele velocity proxy
  return (Math.abs(n(ch1h, 0)) * 0.6 + Math.abs(n(ch24, 0)) * 0.4) / 100;
}

export function computeCompression(priceHist) {
  if (!Array.isArray(priceHist) || priceHist.length < 20) {
    return { isCompressed: false, flatPct: 0 };
  }
  const recent = priceHist.slice(-20).map((x) => n(x, 0)).filter((x) => x > 0);
  if (recent.length < 10) return { isCompressed: false, flatPct: 0 };

  const maxV = Math.max(...recent);
  const minV = Math.min(...recent);
  if (minV <= 0) return { isCompressed: false, flatPct: 0 };

  const range = (maxV - minV) / minV;
  const flatPct = (1 - Math.min(1, range / 0.1)) * 100;

  return {
    isCompressed: flatPct > 70,
    flatPct: Number(flatPct.toFixed(1)),
  };
}

export function computeBreakoutPressure(priceHist) {
  if (!Array.isArray(priceHist) || priceHist.length < 20) {
    return { ready: false, pressure: 0, breakoutPct: 0 };
  }
  const recent = priceHist.slice(-20).map((x) => n(x, 0)).filter((x) => x > 0);
  if (recent.length < 10) return { ready: false, pressure: 0, breakoutPct: 0 };

  const last = recent[recent.length - 1];
  const highs = recent.slice(0, -1);
  const maxHigh = Math.max(...highs);

  const breakoutPct = maxHigh > 0 ? ((last - maxHigh) / maxHigh) * 100 : 0;
  const pressure = Math.min(100, Math.max(0, breakoutPct * 10 + 30));

  return {
    ready: breakoutPct > 0.5,
    pressure: Number(pressure.toFixed(1)),
    breakoutPct: Number(breakoutPct.toFixed(2)),
  };
}

export function computePersistenceScore({ priceHist, volHist, stageHist }) {
  if (!Array.isArray(priceHist) || priceHist.length < 10) return 50;

  const recentPrices = priceHist.slice(-10).map((x) => n(x, 0)).filter((x) => x > 0);
  if (recentPrices.length < 5) return 50;

  const trend = (recentPrices[recentPrices.length - 1] - recentPrices[0]) / recentPrices[0];
  let trendScore = 50 + trend * 200;
  trendScore = clamp(trendScore, 0, 100);

  let volScore = 50;
  if (Array.isArray(volHist) && volHist.length >= 5) {
    const recentVol = volHist.slice(-5).map((x) => n(x, 0));
    const avgVol = recentVol.reduce((a, b) => a + b, 0) / 5;
    const currVol = recentVol[recentVol.length - 1];
    const volRatio = avgVol > 0 ? currVol / avgVol : 1;
    volScore = clamp(50 + volRatio * 25, 0, 100);
  }

  let stageScore = 50;
  if (Array.isArray(stageHist) && stageHist.length) {
    const eliteCount = stageHist.filter((s) => up(s).includes("ELITE")).length;
    stageScore = clamp(50 + eliteCount * 8, 0, 100);
  }

  return Math.round((trendScore + volScore + stageScore) / 3);
}

export function computeMarketRegime({ btc, whaleFlow }) {
  const btcState = up(btc?.state || "NEUTRAL");
  const btcChg24 = n(btc?.chg24, 0);
  const btcRange24 = n(btc?.range24, 0);
  const whale = n(whaleFlow, 0);

  if (btcState === "BULL" && btcChg24 > 1.5 && btcRange24 > 3) return "EXPANSION";
  if (btcState === "BULL" && btcChg24 > 0.5 && btcRange24 > 2) return "TREND";
  if (btcState === "BEAR" && btcChg24 < -1.5 && btcRange24 > 3) return "HEADWIND";
  if (whale < 5) return "DRY";
  if (Math.abs(btcChg24) < 0.8 && btcRange24 < 2) return "CHOP";
  return "NEUTRAL";
}

export function adjustMoonConfigForRegime(cfg, regime) {
  if (!cfg) return cfg;
  const r = up(regime);
  const copy = { ...cfg };

  if (r === "HEADWIND") {
    if (copy.minCh1hBuildup != null) copy.minCh1hBuildup *= 1.3;
    if (copy.minCh24Buildup != null) copy.minCh24Buildup *= 1.2;
    if (copy.minVmBuildup != null) copy.minVmBuildup *= 1.1;
    if (copy.minVelocity != null) copy.minVelocity *= 1.2;
  }

  if (r === "EXPANSION") {
    if (copy.minCh1hBuildup != null) copy.minCh1hBuildup *= 0.8;
    if (copy.minCh24Buildup != null) copy.minCh24Buildup *= 0.8;
    if (copy.minVmBuildup != null) copy.minVmBuildup *= 0.9;
  }

  return copy;
}

// ======================================================
// Elite kwaliteit en move scores
// ======================================================
export function computeEliteQuality({
  moveScore,
  velocity,
  vm,
  obScore,
  compression,
  volAcc,
  persistenceScore,
  regime,
  breakoutReady,
}) {
  const comp = compression?.isCompressed ? 1 : 0;
  const vShort = n(volAcc?.short, 1);
  const vMed = n(volAcc?.medium, 1);

  let score =
    n(moveScore, 0) * 0.3 +
    n(velocity, 0) * 100 * 0.2 +
    n(vm, 0) * 100 * 0.15 +
    Math.abs(n(obScore, 0)) * 100 * 0.1;

  if (comp) score += 5;
  score += n(persistenceScore, 50) * 0.1;
  score += (vShort + vMed) * 0.5;
  if (breakoutReady) score += 8;
  if (up(regime) === "EXPANSION") score += 5;

  return clamp(score, 0, 100);
}

export function computeBullMoveScore(coin, obx) {
  const ch1h = n(coin?.change1h, 0);
  const ch24 = n(coin?.change24, 0);
  const vm = n(coin?.vm, 0);
  const obScore = n(obx?.score, 0);

  let score = 0;
  if (ch1h > 0) score += ch1h * 3;
  if (ch24 > 0) score += ch24 * 1.2;
  score += vm * 120;
  score += Math.max(0, obScore) * 50;

  return clamp(score, 0, 100);
}

export function computeBearMoveScore(coin, obx) {
  const ch1h = Math.abs(n(coin?.change1h, 0));
  const ch24 = Math.abs(n(coin?.change24, 0));
  const vm = n(coin?.vm, 0);
  const obScore = n(obx?.score, 0);

  let score = 0;
  if (ch1h > 0) score += ch1h * 3;
  if (ch24 > 0) score += ch24 * 1.2;
  score += vm * 120;
  score += Math.abs(Math.min(0, obScore)) * 50;

  return clamp(score, 0, 100);
}

// ======================================================
// Late / exhausted checks
// ======================================================
export function isBullExhausted(coin) {
  const ch1h = n(coin?.change1h, 0);
  const ch24 = n(coin?.change24, 0);
  const vm = n(coin?.vm, 0);
  if (ch24 > 55 && vm < 0.7) return true;
  if (ch1h > 12 && ch24 > 35) return true;
  return false;
}

export function isBearBounceTrap(coin) {
  const ch1h = n(coin?.change1h, 0);
  const ch24 = n(coin?.change24, 0);
  const vm = n(coin?.vm, 0);
  if (ch24 < -55 && vm < 0.7) return true;
  if (ch1h < -12 && ch24 < -35) return true;
  return false;
}

export function isLateBullEntry(coin) {
  const ch1h = n(coin?.change1h, 0);
  const ch24 = n(coin?.change24, 0);
  const vm = n(coin?.vm, 0);
  if (ch1h >= 15 && ch24 >= 38) return true;
  if (ch1h >= 11 && ch24 >= 48) return true;
  if (ch24 >= 65 && vm < 1.1) return true;
  return false;
}

export function isLateBearEntry(coin) {
  const ch1h = n(coin?.change1h, 0);
  const ch24 = n(coin?.change24, 0);
  const vm = n(coin?.vm, 0);
  if (ch1h <= -15 && ch24 <= -38) return true;
  if (ch1h <= -11 && ch24 <= -48) return true;
  if (ch24 <= -65 && vm < 1.1) return true;
  return false;
}

// ======================================================
// Probabilities & scores
// ======================================================
export function computeMoonProbabilities({ mode, moveScore, velocity, compression, persistenceScore }) {
  const baseMoon = mode === "bull" ? 50 : 30;
  const baseDump = mode === "bull" ? 20 : 40;

  let moon = baseMoon + n(moveScore, 0) * 0.25 + n(velocity, 0) * 50 + n(persistenceScore, 50) * 0.2;
  if (compression?.isCompressed) moon += 8;

  let dump = baseDump + (100 - n(moveScore, 0)) * 0.2;
  if (mode === "bear") dump += 10;

  moon = clamp(moon, 5, 95);
  dump = clamp(dump, 5, 95);

  return { moonProbability: Math.round(moon), dumpProbability: Math.round(dump) };
}

export function computeBtcAlignmentScore({ btc, mode, regime }) {
  const btcState = up(btc?.state || "NEUTRAL");
  const btcChg24 = n(btc?.chg24, 0);

  let score = 50;

  if (mode === "bull") {
    if (btcState === "BULL") score += 25;
    else if (btcState === "NEUTRAL") score += 5;
    else score -= 15;

    if (btcChg24 > 1) score += 10;
    if (btcChg24 < -1) score -= 15;
  } else {
    if (btcState === "BEAR") score += 25;
    else if (btcState === "NEUTRAL") score += 5;
    else score -= 15;

    if (btcChg24 < -1) score += 10;
    if (btcChg24 > 1) score -= 15;
  }

  const reg = up(regime);
  if (reg === "HEADWIND") score -= 10;
  if (reg === "EXPANSION") score += 10;

  return clamp(score, 0, 100);
}

export function computeQualityScore({ moveScore, entryQuality, persistenceScore, velocity, compression, breakout }) {
  let score =
    n(moveScore, 0) * 0.3 +
    n(entryQuality, 0) * 0.2 +
    n(persistenceScore, 50) * 0.2 +
    n(velocity, 0) * 50 * 0.15;

  if (compression?.isCompressed) score += 5;
  if (breakout?.ready) score += 8;

  return clamp(score, 0, 100);
}

export function computeLiquidityScore({ ob, depthOk, spreadPct, depthMinUsd1p }) {
  let score = 50;

  if (depthOk) score += 20;
  else score -= 15;

  const sp = n(spreadPct, 999);
  if (sp < 0.3) score += 15;
  else if (sp > 0.8) score -= 15;

  const d = n(depthMinUsd1p, 0);
  if (d > 500_000) score += 15;
  else if (d < 100_000) score -= 15;

  if (Math.abs(n(ob?.score, 0)) > 0.02) score += 5;

  return clamp(score, 0, 100);
}

export function computeTimingScore({ stage, breakout, volAcc, strongScans, eliteScans, lateEntry, exhausted, bounceTrap }) {
  let score = 50;

  if (stage === "ELITE_IGNITION") score += 15;
  if (stage === "ELITE_EXPANSION" || stage === "ELITE_CASCADE") score += 20;

  if (breakout?.ready) score += 12;

  const v1 = n(volAcc?.short, 1);
  const v2 = n(volAcc?.medium, 1);
  if (v1 > 1.2) score += 8;
  if (v2 > 1.1) score += 5;

  if (n(strongScans, 0) >= 2) score += 5;
  if (n(eliteScans, 0) >= 1) score += 5;

  if (lateEntry) score -= 20;
  if (exhausted) score -= 25;
  if (bounceTrap) score -= 20;

  return clamp(score, 0, 100);
}

export function computeMarketScore({ btc, mode, regime, whaleFlow }) {
  const btcState = up(btc?.state || "NEUTRAL");
  const btcChg24 = n(btc?.chg24, 0);

  let score = 50;

  if (mode === "bull") {
    if (btcState === "BULL") score += 20;
    else if (btcState === "NEUTRAL") score += 5;
    else score -= 15;

    if (btcChg24 > 1) score += 10;
    if (btcChg24 < -1) score -= 15;
  } else {
    if (btcState === "BEAR") score += 20;
    else if (btcState === "NEUTRAL") score += 5;
    else score -= 15;

    if (btcChg24 < -1) score += 10;
    if (btcChg24 > 1) score -= 15;
  }

  const reg = up(regime);
  if (reg === "HEADWIND") score -= 15;
  if (reg === "EXPANSION") score += 15;

  const wf = n(whaleFlow, 0);
  if (wf > 10) score += 8;
  if (wf < 3) score -= 8;

  return clamp(score, 0, 100);
}

export function computePerfectCandidateScore({ qualityScore, liquidityScore, timingScore, marketScore }) {
  return (n(qualityScore, 0) + n(liquidityScore, 0) + n(timingScore, 0) + n(marketScore, 0)) / 4;
}

// ======================================================
// Overige helpers
// ======================================================
export function calcPnlPct(entryPrice, priceNow, side = "long") {
  const e = n(entryPrice, 0);
  const p = n(priceNow, 0);
  if (!(e > 0 && p > 0)) return 0;

  const pnl = side === "long" ? ((p - e) / e) * 100 : ((e - p) / e) * 100;
  return Number(pnl.toFixed(2));
}

export function hitStopOrTp(priceNow, entryPrice, sl, tp, side = "long") {
  const p = n(priceNow, 0);
  const stop = n(sl, 0);
  const take = n(tp, 0);

  if (side === "long") {
    if (p <= stop) return "SL";
    if (p >= take) return "TP";
  } else {
    if (p >= stop) return "SL";
    if (p <= take) return "TP";
  }
  return null;
}

export function isBlockedMoonAsset(coin) {
  const sym = up(coin?.symbol);
  const blocked = ["USDT", "USDC", "BUSD", "DAI", "UST", "LUNA", "TERRA", "WRAPPED"];
  return blocked.some((b) => sym.includes(b));
}