import { kv } from "@vercel/kv";

// ---------- Runtime config ----------
export const RUNTIME_CONFIG = {
  runtime: "nodejs",
};

// ======================================================
// MOON V2 CONFIG (voor moon-scan)
// ======================================================
export const MOON_V2 = {
  bull: {
    minVol24h: 350_000,
    minVmRadar: 0.08,
    minVmBuildup: 0.18,
    minVmAlmost: 0.24,
    minVmElite: 0.30,

    minCh1hRadar: -0.8,
    minCh1hBuildup: 0.6,
    minCh1hAlmost: 1.2,
    minCh1hIgnition: 1.35,
    minCh1hExpansion: 3.2,

    minCh24Radar: 1.5,
    minCh24Buildup: 4,
    minCh24Almost: 8,
    minCh24Ignition: 8,
    minCh24Expansion: 18,

    minObBull: 0.025,
    minObStrong: 0.040,
    spreadMaxRadar: 1.40,
    spreadMaxElite: 1.05,

    maxExhaust24: 85,
    minVelocity: 0.10,
    strongVelocity: 0.13,
    explosiveVelocity: 0.22,

    minPersistenceIgnition: 60,
    minPersistenceExpansion: 70,

    maxMcapRadar: 600_000_000,
    maxMcapBuildup: 350_000_000,
    maxMcapAlmost: 250_000_000,
    maxMcapElite: 180_000_000,
  },

  bear: {
    minVol24h: 350_000,
    minVmRadar: 0.08,
    minVmBuildup: 0.18,
    minVmAlmost: 0.24,
    minVmElite: 0.30,

    maxCh1hRadar: 0.8,
    maxCh1hBuildup: -0.6,
    maxCh1hAlmost: -1.2,
    maxCh1hIgnition: -1.35,
    maxCh1hCascade: -3.2,

    maxCh24Radar: -1.5,
    maxCh24Buildup: -4,
    maxCh24Almost: -8,
    maxCh24Ignition: -8,
    maxCh24Cascade: -18,

    minObBearAbs: 0.025,
    minObStrongAbs: 0.040,
    spreadMaxRadar: 1.60,
    spreadMaxElite: 1.20,

    maxBounce1h: 2.8,
    minVelocity: 0.10,
    strongVelocity: 0.13,
    explosiveVelocity: 0.22,

    minPersistenceIgnition: 60,
    minPersistenceExpansion: 70,

    maxMcapRadar: 600_000_000,
    maxMcapBuildup: 350_000_000,
    maxMcapAlmost: 250_000_000,
    maxMcapElite: 180_000_000,
  },
};

// ======================================================
// MAIN V2 CONFIG (voor main-scan)
// ======================================================
export const MAIN_V2 = {
  bull: {
    minVol24h: 500_000,
    minVmRadar: 0.06,
    minVmBuildup: 0.15,
    minVmAlmost: 0.20,
    minVmElite: 0.25,

    minCh1hRadar: -0.5,
    minCh1hBuildup: 0.4,
    minCh1hAlmost: 1.0,
    minCh1hIgnition: 1.2,
    minCh1hExpansion: 2.8,

    minCh24Radar: 1.0,
    minCh24Buildup: 3,
    minCh24Almost: 6,
    minCh24Ignition: 6,
    minCh24Expansion: 15,

    minObBull: 0.020,
    minObStrong: 0.035,
    spreadMaxRadar: 1.50,
    spreadMaxElite: 1.10,

    maxExhaust24: 80,
    minVelocity: 0.08,
    strongVelocity: 0.11,
    explosiveVelocity: 0.18,

    minPersistenceIgnition: 60,
    minPersistenceExpansion: 70,

    maxMcapRadar: 800_000_000,
    maxMcapBuildup: 500_000_000,
    maxMcapAlmost: 350_000_000,
    maxMcapElite: 250_000_000,
  },

  bear: {
    minVol24h: 500_000,
    minVmRadar: 0.06,
    minVmBuildup: 0.15,
    minVmAlmost: 0.20,
    minVmElite: 0.25,

    maxCh1hRadar: 0.5,
    maxCh1hBuildup: -0.4,
    maxCh1hAlmost: -1.0,
    maxCh1hIgnition: -1.2,
    maxCh1hCascade: -2.8,

    maxCh24Radar: -1.0,
    maxCh24Buildup: -3,
    maxCh24Almost: -6,
    maxCh24Ignition: -6,
    maxCh24Cascade: -15,

    minObBearAbs: 0.020,
    minObStrongAbs: 0.035,
    spreadMaxRadar: 1.70,
    spreadMaxElite: 1.30,

    maxBounce1h: 2.5,
    minVelocity: 0.08,
    strongVelocity: 0.11,
    explosiveVelocity: 0.18,

    minPersistenceIgnition: 60,
    minPersistenceExpansion: 70,

    maxMcapRadar: 800_000_000,
    maxMcapBuildup: 500_000_000,
    maxMcapAlmost: 350_000_000,
    maxMcapElite: 250_000_000,
  },
};

export const depthK = 0.00025;

export const TIERS = [
  { name: "small", marketCapMax: 100_000_000, depthMinUsd: 1_000 },
  { name: "mid", marketCapMax: 500_000_000, depthMinUsd: 4_000 },
  { name: "upper-mid", marketCapMax: 2_000_000_000, depthMinUsd: 12_000 },
  { name: "large", marketCapMax: Infinity, depthMinUsd: 50_000 },
];

const BLOCKED_SYMBOLS = [
  "USDT", "BUSD", "DAI", "USDC", "TUSD", "PAX", "UST", "LUNC", "LUNA",
  "USTC", "LUNA2", "MIM", "FRAX", "WBTC", "WETH", "RENBTC",
  "3X", "BEAR", "BULL", "DOWN", "UP", "HEDGE",
];

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

export function isBlockedMoonAsset(coin) {
  if (!coin || !coin.symbol) return true;
  const sym = String(coin.symbol || "").toUpperCase();
  if (BLOCKED_SYMBOLS.some((b) => sym.includes(b))) return true;
  if (sym.endsWith("USD") || sym.endsWith("EUR")) return true;
  return false;
}

export function getTierForMcap(mcap) {
  for (const tier of TIERS) {
    if (n(mcap, 0) < tier.marketCapMax) return tier;
  }
  return TIERS[TIERS.length - 1];
}

export function depthFloorUsd(mcap, tier, depthHist = []) {
  const factor =
    tier === TIERS[0] ? 0.8 :
    tier === TIERS[1] ? 1.0 :
    tier === TIERS[2] ? 1.5 : 2.0;

  const base = Math.max(
    n(tier?.depthMinUsd, 0),
    Math.round(depthK * Math.sqrt(Math.max(n(mcap, 0), 0)) * factor)
  );

  if (Array.isArray(depthHist) && depthHist.length > 0) {
    const sorted = [...depthHist].map((x) => n(x, 0)).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 0;
    return Math.max(base, Math.round(median * 0.7));
  }

  return base;
}

// ======================================================
// CORE HELPERS
// ======================================================
export function computeVelocity(change1h, change24) {
  const a1 = Math.abs(n(change1h, 0));
  const a24 = Math.abs(n(change24, 0));
  if (a24 <= 0.0001) return 0;
  return a1 / a24;
}

export function marketCapMoveBonus(mcap) {
  const mc = n(mcap, 0);
  if (mc <= 15_000_000) return 22;
  if (mc <= 35_000_000) return 18;
  if (mc <= 80_000_000) return 12;
  if (mc <= 180_000_000) return 7;
  if (mc <= 350_000_000) return 3;
  return 0;
}

export function computeCompression(priceHist = []) {
  const arr = Array.isArray(priceHist)
    ? priceHist.slice(-12).map((x) => n(x, 0)).filter((x) => x > 0)
    : [];

  if (arr.length < 6) return { flatPct: 999, isCompressed: false };

  const hi = Math.max(...arr);
  const lo = Math.min(...arr);
  const mid = (hi + lo) / 2;

  if (!(mid > 0)) return { flatPct: 999, isCompressed: false };

  const flatPct = ((hi - lo) / mid) * 100;

  return {
    flatPct: Number(flatPct.toFixed(2)),
    isCompressed: flatPct <= 3.2,
  };
}

export function computeBreakoutPressure(priceHist = []) {
  const arr = Array.isArray(priceHist)
    ? priceHist.slice(-15).map((x) => n(x, 0)).filter((x) => x > 0)
    : [];

  if (arr.length < 8) {
    return { breakoutPct: 0, pressure: 0, ready: false };
  }

  const recent = arr.slice(-5);
  const base = arr.slice(0, -2);

  const hiRecent = Math.max(...recent);
  const hiBase = Math.max(...base);
  const loBase = Math.min(...base);
  const rangeBase = Math.max(0.0000001, hiBase - loBase);

  const breakoutPct = ((hiRecent - hiBase) / Math.max(hiBase, 0.0000001)) * 100;
  const pressure = ((arr[arr.length - 1] - loBase) / rangeBase) * 100;

  return {
    breakoutPct: Number(breakoutPct.toFixed(3)),
    pressure: Number(pressure.toFixed(2)),
    ready: pressure >= 62 && breakoutPct <= 5.2,
  };
}

export function computePersistenceScore({ priceHist = [], volHist = [], stageHist = [], mode }) {
  const p = Array.isArray(priceHist) ? priceHist.slice(-8).map((x) => n(x, 0)) : [];
  const v = Array.isArray(volHist) ? volHist.slice(-8).map((x) => n(x, 0)) : [];
  const s = Array.isArray(stageHist) ? stageHist.slice(-5).map((x) => String(x || "").toUpperCase()) : [];

  let score = 0;

  if (p.length >= 4) {
    let alignedMoves = 0;
    for (let i = 1; i < p.length; i++) {
      const prev = p[i - 1];
      const cur = p[i];
      if (!(prev > 0 && cur > 0)) continue;
      const diff = ((cur - prev) / prev) * 100;
      if (mode === "bull" && diff >= -0.8) alignedMoves++;
      if (mode === "bear" && diff <= 0.8) alignedMoves++;
    }
    score += (alignedMoves / Math.max(1, p.length - 1)) * 35;
  }

  if (v.length >= 4) {
    const first = v[0] || 0;
    const last = v[v.length - 1] || 0;
    if (first > 0) {
      const volTrend = last / first;
      if (volTrend >= 1.00) score += 10;
      if (volTrend >= 1.10) score += 10;
      if (volTrend >= 1.25) score += 10;
    }
  }

  if (s.length) {
    const eliteLike = s.filter((x) => x.includes("ELITE") || x === "ALMOST").length;
    score += (eliteLike / s.length) * 25;
  }

  return Math.round(clamp(score, 0, 100));
}

export function computeMarketRegime({ btc, whaleFlow, mode }) {
  const btcState = String(btc?.state || "NEUTRAL").toUpperCase();
  const chg24 = n(btc?.chg24, 0);
  const range24 = n(btc?.range24, 0);
  const flows = n(whaleFlow, 0);

  if (range24 >= 6.5 && Math.abs(chg24) >= 2.2) {
    if (mode === "bull" && btcState === "BULL") return "EXPANSION";
    if (mode === "bear" && btcState === "BEAR") return "EXPANSION";
  }

  if (range24 <= 2.0 && Math.abs(chg24) <= 0.6 && flows < 8) {
    return "DRY";
  }

  if (range24 <= 3.2 && Math.abs(chg24) <= 1.1) {
    return "CHOP";
  }

  if (mode === "bull" && btcState === "BEAR") return "HEADWIND";
  if (mode === "bear" && btcState === "BULL") return "HEADWIND";

  return "TREND";
}

export function adjustMoonConfigForRegime(baseCfg, regime) {
  const cfg = JSON.parse(JSON.stringify(baseCfg || {}));
  const r = String(regime || "").toUpperCase();

  if (r === "DRY") {
    cfg.minVmBuildup = Math.max(0, n(cfg.minVmBuildup, 0) - 0.03);
    cfg.minVmAlmost = Math.max(0, n(cfg.minVmAlmost, 0) - 0.04);

    if ("minCh24Almost" in cfg) cfg.minCh24Almost = Math.max(0, n(cfg.minCh24Almost, 0) - 1.0);
    if ("maxCh24Almost" in cfg) cfg.maxCh24Almost = Math.min(0, n(cfg.maxCh24Almost, 0) + 1.0);

    cfg.strongVelocity = Math.max(0, n(cfg.strongVelocity, 0) - 0.015);
  }

  if (r === "EXPANSION") {
    cfg.minVmElite = Math.max(0, n(cfg.minVmElite, 0) - 0.02);

    if ("minCh24Ignition" in cfg) cfg.minCh24Ignition = Math.max(0, n(cfg.minCh24Ignition, 0) - 1.0);
    if ("maxCh24Ignition" in cfg) cfg.maxCh24Ignition = Math.min(0, n(cfg.maxCh24Ignition, 0) + 1.0);
  }

  if (r === "HEADWIND") {
    cfg.minVmElite = n(cfg.minVmElite, 0) + 0.04;

    if ("minCh24Ignition" in cfg) cfg.minCh24Ignition = n(cfg.minCh24Ignition, 0) + 1.2;
    if ("maxCh24Ignition" in cfg) cfg.maxCh24Ignition = n(cfg.maxCh24Ignition, 0) - 1.2;
  }

  return cfg;
}

export function computeEliteQuality({
  moveScore,
  velocity,
  vm,
  obScore,
  compression,
  volAcc,
  persistenceScore,
  regime,
}) {
  let score = 0;

  score += n(moveScore, 0) * 0.34;
  score += Math.min(n(velocity, 0) * 100, 40) * 0.16;
  score += Math.min(n(vm, 0) * 40, 20);
  score += n(persistenceScore, 0) * 0.18;

  if (n(obScore, 0) > 0.05) score += 6;
  if (n(obScore, 0) > 0.08) score += 5;
  if (n(obScore, 0) < -0.05) score += 6;
  if (n(obScore, 0) < -0.08) score += 5;

  if (compression?.isCompressed) score += 4;

  if (n(volAcc?.short, 1) > 1.08) score += 5;
  if (n(volAcc?.medium, 1) > 1.18) score += 7;

  if (String(regime || "").toUpperCase() === "EXPANSION") score += 4;
  if (String(regime || "").toUpperCase() === "HEADWIND") score -= 6;

  return Math.round(clamp(score, 0, 100));
}

export function isBullExhausted(coin) {
  const ch24 = n(coin?.change24, 0);
  const ch1h = n(coin?.change1h, 0);
  const vm = n(coin?.vm, 0);
  const velocity = computeVelocity(ch1h, ch24);

  if (ch24 >= 70 && ch1h < 0.8) return true;
  if (ch24 >= 55 && velocity < 0.08) return true;
  if (ch24 >= 45 && vm < 0.20) return true;

  return false;
}

export function isBearBounceTrap(coin) {
  const ch24 = n(coin?.change24, 0);
  const ch1h = n(coin?.change1h, 0);
  const velocity = computeVelocity(ch1h, ch24);

  if (ch24 <= -12 && ch1h >= 1.6) return true;
  if (ch24 <= -20 && ch1h >= 1.0 && velocity < 0.08) return true;

  return false;
}

export function computeBullMoveScore(coin, obx) {
  const vm = n(coin?.vm, 0);
  const ch1h = n(coin?.change1h, 0);
  const ch24 = n(coin?.change24, 0);
  const ob = n(obx?.score, 0);
  const spread = n(obx?.spreadPct, 999);
  const depth = n(obx?.depthMinUsd1p, 0);
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

export function computeBearMoveScore(coin, obx) {
  const vm = n(coin?.vm, 0);
  const ch1h = n(coin?.change1h, 0);
  const ch24 = n(coin?.change24, 0);
  const ob = n(obx?.score, 0);
  const spread = n(obx?.spreadPct, 999);
  const depth = n(obx?.depthMinUsd1p, 0);
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

export function computeMoonProbabilities({ mode, coin, moveScore, velocity, compression, persistenceScore = 0 }) {
  const vm = n(coin?.vm, 0);
  const obScore = n(coin?.ob?.score, 0);

  const velScore =
    velocity >= 0.38 ? 100 :
    velocity >= 0.26 ? 82 :
    velocity >= 0.16 ? 60 : 20;

  const compScore = compression?.isCompressed ? 85 : 20;

  const vmScore =
    vm >= 1.50 ? 100 :
    vm >= 0.80 ? 82 :
    vm >= 0.40 ? 65 :
    vm >= 0.20 ? 40 : 15;

  const persist = clamp(n(persistenceScore, 0), 0, 100);

  const moonProbability =
    mode === "bull"
      ? Math.max(0, Math.min(1,
          moveScore * 0.34 / 100 +
          velScore * 0.18 / 100 +
          vmScore * 0.14 / 100 +
          compScore * 0.08 / 100 +
          persist * 0.18 / 100 +
          (obScore > 0.05 ? 0.08 : 0)
        ))
      : 0;

  const dumpProbability =
    mode === "bear"
      ? Math.max(0, Math.min(1,
          moveScore * 0.34 / 100 +
          velScore * 0.18 / 100 +
          vmScore * 0.14 / 100 +
          compScore * 0.08 / 100 +
          persist * 0.18 / 100 +
          (obScore < -0.05 ? 0.08 : 0)
        ))
      : 0;

  return {
    moonProbability: Number(moonProbability.toFixed(3)),
    dumpProbability: Number(dumpProbability.toFixed(3)),
  };
}

// ======================================================
// RISK / TRADEPLAN V6
// ======================================================
export function computeMoonRisk({ mode, price, range24, confidence, depthOk, tier, regime = "TREND", persistenceScore = 50 }) {
  if (!price || price <= 0) return null;

  const p = n(price, 0);
  const r24 = clamp(n(range24, 0), 1, 45);
  const conf = clamp(n(confidence, 0), 0, 100);
  const persist = clamp(n(persistenceScore, 50), 0, 100);
  const reg = String(regime || "").toUpperCase();

  let slPct = clamp(3.8 + r24 * 0.11, 4.2, 8.5);
  let tpPct = clamp(10.5 + r24 * 0.38, 12, 28);

  if (conf >= 75) tpPct += 2.0;
  if (conf >= 85) tpPct += 1.5;
  if (persist >= 70) tpPct += 1.5;
  if (persist >= 80) slPct -= 0.4;

  if (!depthOk) slPct += 0.6;

  if (tier?.name === "small") {
    tpPct += 1.4;
    slPct += 0.5;
  }
  if (tier?.name === "large") {
    tpPct -= 1.2;
    slPct -= 0.4;
  }

  if (reg === "EXPANSION") tpPct += 1.8;
  if (reg === "DRY") tpPct -= 1.2;
  if (reg === "HEADWIND") {
    tpPct -= 1.6;
    slPct += 0.4;
  }

  slPct = clamp(slPct, 4.0, 8.8);
  tpPct = clamp(tpPct, 11.0, 30.0);

  const sl = mode === "bull" ? p * (1 - slPct / 100) : p * (1 + slPct / 100);
  const tp3 = mode === "bull" ? p * (1 + tpPct / 100) : p * (1 - tpPct / 100);

  return { sl, tp3, slPct, tpPct };
}

export function calcPnlPct({ mode, entryPrice, priceNow }) {
  if (!entryPrice || entryPrice <= 0) return 0;
  if (mode === "bull") return ((priceNow - entryPrice) / entryPrice) * 100;
  return ((entryPrice - priceNow) / entryPrice) * 100;
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

// ======================================================
// DATA
// ======================================================
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
      const marketCap = n(c.market_cap, 0);
      const volume = n(c.total_volume, 0);
      const high24 = n(c.high_24h, 0);
      const low24 = n(c.low_24h, 0);

      const range24 =
        high24 > 0 && low24 > 0
          ? ((high24 - low24) / ((high24 + low24) / 2)) * 100
          : 0;

      return {
        id: c.id,
        symbol: String(c.symbol || "").toUpperCase(),
        name: c.name || "",
        image: c.image || "",
        price: n(c.current_price, 0),
        marketCap,
        volume,
        change24: n(c.price_change_percentage_24h, 0),
        change1h: n(c.price_change_percentage_1h_in_currency, 0),
        vm: marketCap > 0 ? volume / marketCap : 0,
        range24,
      };
    });
  } catch (e) {
    console.error("fetchCoinGeckoTopCached error", e);
    return [];
  }
}

async function fetchBtcFromBinance() {
  try {
    const r = await fetch("https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT");
    if (!r.ok) throw new Error(`Binance BTC fetch failed ${r.status}`);

    const t = await r.json();
    const price = n(t.lastPrice, 0);
    const chg24 = n(t.priceChangePercent, 0);
    const high = n(t.highPrice, 0);
    const low = n(t.lowPrice, 0);
    const range24 = high > 0 && low > 0 ? ((high - low) / ((high + low) / 2)) * 100 : 0;
    const state = chg24 >= 1 ? "BULL" : chg24 <= -1 ? "BEAR" : "NEUTRAL";

    return { price, chg24, chg1h: 0, range24, state };
  } catch (e) {
    console.error("fetchBtcFromBinance error", e);
    return null;
  }
}

export async function fetchBTCGateCached() {
  try {
    const binance = await fetchBtcFromBinance();
    if (binance && binance.price > 0) return binance;

    const r = await fetch("https://api.gateio.ws/api/v4/spot/tickers?currency_pair=BTC_USDT");
    if (!r.ok) throw new Error("Gate io BTC fetch failed");

    const data = await r.json();
    const ticker = Array.isArray(data) ? data[0] : null;
    if (!ticker) throw new Error("No BTC ticker");

    const price = n(ticker.last, 0);
    const chg24 = n(ticker.change_percentage, 0);
    const high = n(ticker.high_24h, 0);
    const low = n(ticker.low_24h, 0);
    const range24 = high > 0 && low > 0 ? ((high - low) / ((high + low) / 2)) * 100 : 0;
    const state = chg24 >= 1 ? "BULL" : chg24 <= -1 ? "BEAR" : "NEUTRAL";

    return { price, chg24, chg1h: 0, range24, state };
  } catch (e) {
    console.error("fetchBTCGateCached error", e);
    return { price: 0, chg24: 0, chg1h: 0, range24: 0, state: "NEUTRAL" };
  }
}

export const fetchBTCGateFromUniverse = fetchBTCGateCached;

// ======================================================
// KEYS
// ======================================================
export function keyMoonLatest(mode) { return `moon:latest:${mode}`; }
export function keyMoonPortfolio(mode) { return `moon:portfolio:${mode}`; }
export function keyMoonPositions(mode) { return `moon:positions:${mode}`; }
export function keyMoonState(mode) { return `moon:state:${mode}`; }

export function keyMainLatest(mode) { return `main:latest:${mode}`; }
export function keyMainPortfolio(mode) { return `main:portfolio:${mode}`; }
export function keyMainPositions(mode) { return `main:positions:${mode}`; }
export function keyMainState(mode) { return `main:state:${mode}`; }

// ======================================================
// AUTH
// ======================================================
export function requireSecret(req, res) {
  const token = req.query?.token || req.headers?.authorization?.replace("Bearer ", "");
  if (token === process.env.CRON_SECRET) return true;

  res.statusCode = 401;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
  return false;
}