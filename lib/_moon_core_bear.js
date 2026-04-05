// lib/_moon_core_bear.js
import { RUNTIME_CONFIG } from "./_runtime.js";
export const config = RUNTIME_CONFIG;

/**
 * PURE BEAR MOON CORE:
 * - geen fetch
 * - geen kv
 * - alleen thresholds + scoring + helpers
 */

export const MOON_V2 = {
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

  maxMcapRadar: 600_000_000,
  maxMcapBuildup: 350_000_000,
  maxMcapAlmost: 250_000_000,
  maxMcapElite: 180_000_000,

  minPersistenceIgnition: 60,
  minPersistenceExpansion: 70,
};

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

export function getCfg() {
  return MOON_V2;
}

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
  const arr = Array.isArray(priceHist) ? priceHist.slice(-12).map((x) => n(x, 0)).filter((x) => x > 0) : [];
  if (arr.length < 6) return { flatPct: 999, isCompressed: false };

  const hi = Math.max(...arr);
  const lo = Math.min(...arr);
  const mid = (hi + lo) / 2;
  if (!(mid > 0)) return { flatPct: 999, isCompressed: false };

  const flatPct = ((hi - lo) / mid) * 100;
  return { flatPct: Number(flatPct.toFixed(2)), isCompressed: flatPct <= 3.2 };
}

export function computeBreakoutPressure(priceHist = []) {
  const arr = Array.isArray(priceHist) ? priceHist.slice(-15).map((x) => n(x, 0)).filter((x) => x > 0) : [];
  if (arr.length < 8) return { breakoutPct: 0, pressure: 0, ready: false };

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

export function computePersistenceScore({ priceHist = [], volHist = [], stageHist = [], mode = "bear" }) {
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
      if (volTrend >= 1.0) score += 10;
      if (volTrend >= 1.1) score += 10;
      if (volTrend >= 1.25) score += 10;
    }
  }

  if (s.length) {
    const eliteLike = s.filter((x) => x.includes("ELITE") || x === "ALMOST").length;
    score += (eliteLike / s.length) * 25;
  }

  return Math.round(clamp(score, 0, 100));
}

export function computeMarketRegime({ btc, whaleFlow, mode = "bear" }) {
  const btcState = String(btc?.state || "NEUTRAL").toUpperCase();
  const chg24 = n(btc?.chg24, 0);
  const range24 = n(btc?.range24, 0);
  const flows = n(whaleFlow, 0);

  if (range24 >= 6.5 && Math.abs(chg24) >= 2.2) {
    if (mode === "bull" && btcState === "BULL") return "EXPANSION";
    if (mode === "bear" && btcState === "BEAR") return "EXPANSION";
  }

  if (range24 <= 2.0 && Math.abs(chg24) <= 0.6 && flows < 8) return "DRY";
  if (range24 <= 3.2 && Math.abs(chg24) <= 1.1) return "CHOP";

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
    cfg.strongVelocity = Math.max(0, n(cfg.strongVelocity, 0) - 0.015);
  }

  if (r === "EXPANSION") {
    cfg.minVmElite = Math.max(0, n(cfg.minVmElite, 0) - 0.02);
    cfg.maxCh24Ignition = Math.min(0, n(cfg.maxCh24Ignition, 0) + 1.0);
  }

  if (r === "HEADWIND") {
    cfg.minVmElite = n(cfg.minVmElite, 0) + 0.04;
    cfg.maxCh24Ignition = n(cfg.maxCh24Ignition, 0) - 1.2;
  }

  return cfg;
}

export function computeEliteQuality({ moveScore, velocity, vm, obScore, compression, volAcc, persistenceScore, regime }) {
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

export function isBearBounceTrap(coin) {
  const ch24 = n(coin?.change24, 0);
  const ch1h = n(coin?.change1h, 0);
  const velocity = computeVelocity(ch1h, ch24);

  if (ch24 <= -12 && ch1h >= 1.6) return true;
  if (ch24 <= -20 && ch1h >= 1.0 && velocity < 0.08) return true;
  return false;
}
export function isBullExhausted() {
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
export function isLateBullEntry() {
  return false;
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

  if (vm >= 0.1) score += 8;
  if (vm >= 0.2) score += 14;
  if (vm >= 0.4) score += 22;
  if (vm >= 0.8) score += 30;
  if (vm >= 1.5) score += 36;

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

export function computeBullMoveScore(coin, obx) {
  return computeBearMoveScore(coin, obx);
}

export function computeMoonProbabilities({ mode, coin, moveScore, velocity, compression, persistenceScore = 0 }) {
  const vm = n(coin?.vm, 0);
  const obScore = n(coin?.ob?.score, 0);

  const velScore = velocity >= 0.38 ? 100 : velocity >= 0.26 ? 82 : velocity >= 0.16 ? 60 : 20;
  const compScore = compression?.isCompressed ? 85 : 20;
  const vmScore = vm >= 1.5 ? 100 : vm >= 0.8 ? 82 : vm >= 0.4 ? 65 : vm >= 0.2 ? 40 : 15;
  const persist = clamp(n(persistenceScore, 0), 0, 100);

  const dumpProbability =
    mode === "bear"
      ? Math.max(
          0,
          Math.min(
            1,
            (moveScore * 0.34) / 100 +
              (velScore * 0.18) / 100 +
              (vmScore * 0.14) / 100 +
              (compScore * 0.08) / 100 +
              (persist * 0.18) / 100 +
              (obScore < -0.05 ? 0.08 : 0)
          )
        )
      : 0;

  return { moonProbability: 0, dumpProbability: Number(dumpProbability.toFixed(3)) };
}

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

  // NOTE: bear direction (short): SL boven, TP onder
  const sl = p * (1 + slPct / 100);
  const tp3 = p * (1 - tpPct / 100);

  return { sl, tp3, slPct, tpPct };
}

export function computeBtcAlignmentScore({ btc, mode, regime }) {
  if (!btc) return 50;

  const chg24 = n(btc.chg24, 0);
  const range24 = n(btc.range24, 0);
  const state = String(btc.state || "").toUpperCase();

  let score = 50;

  if (mode === "bear") {
    if (state === "BEAR") score += 20;
    else if (state === "BULL") score -= 20;
    if (chg24 < -2) score += 10;
    else if (chg24 < -1) score += 5;
    else if (chg24 > 1) score -= 10;
  }

  if (range24 > 5) score += 10;
  else if (range24 > 3) score += 5;
  else if (range24 < 1.5) score -= 5;

  const reg = String(regime || "").toUpperCase();
  if (reg === "EXPANSION") score += 15;
  else if (reg === "HEADWIND") score -= 15;
  else if (reg === "DRY") score -= 10;

  return clamp(Math.round(score), 0, 100);
}

export function computeQualityScore({ coin, moveScore, entryQuality, persistenceScore, velocity, compression, breakout }) {
  let score = 0;

  score += n(moveScore, 0) * 0.3;
  score += n(entryQuality, 0) * 0.25;
  score += n(persistenceScore, 0) * 0.15;

  if (n(velocity, 0) > 0.2) score += 10;
  if (compression?.isCompressed) score += 8;
  if (breakout?.ready) score += 12;

  const vm = n(coin?.vm, 0);
  if (vm > 0.5) score += 10;
  else if (vm > 0.3) score += 5;

  return clamp(Math.round(score), 0, 100);
}

export function computeLiquidityScore({ ob, depthOk, spreadPct, depthMinUsd1p }) {
  if (!ob) return 30;

  let score = 50;

  if (depthOk) score += 15;
  else score -= 10;

  const spread = n(spreadPct, 999);
  if (spread < 0.5) score += 20;
  else if (spread < 1.0) score += 10;
  else if (spread > 2.0) score -= 10;

  const depth = n(depthMinUsd1p, 0);
  if (depth > 20000) score += 15;
  else if (depth > 8000) score += 10;
  else if (depth > 2000) score += 5;
  else if (depth < 500) score -= 10;

  const obScore = n(ob.score, 0);
  if (Math.abs(obScore) > 0.08) score += 10;
  else if (Math.abs(obScore) > 0.04) score += 5;

  return clamp(Math.round(score), 0, 100);
}

export function computeTimingScore({ mode, stage, breakout, volAcc, strongScans = 0, eliteScans = 0, lateEntry = false, exhausted = false, bounceTrap = false }) {
  let score = 50;

  const st = String(stage || "").toUpperCase();
  if (st === "ELITE_EXPANSION" || st === "ELITE_CASCADE") score += 25;
  else if (st === "ELITE_IGNITION") score += 18;
  else if (st === "ALMOST") score += 10;
  else if (st === "BUILDUP") score += 5;
  else score -= 10;

  if (breakout?.ready) score += 15;

  const vShort = n(volAcc?.short, 1);
  const vMed = n(volAcc?.medium, 1);
  if (vShort > 1.15) score += 10;
  else if (vShort > 1.05) score += 5;
  if (vMed > 1.25) score += 10;
  else if (vMed > 1.1) score += 5;

  if (strongScans >= 3) score += 10;
  else if (strongScans >= 2) score += 5;
  if (eliteScans >= 2) score += 8;

  if (lateEntry) score -= 15;
  if (exhausted) score -= 20;
  if (bounceTrap) score -= 15;

  return clamp(Math.round(score), 0, 100);
}

export function computeMarketScore({ btc, mode, regime, whaleFlow }) {
  let score = 50;

  const reg = String(regime || "").toUpperCase();
  if (reg === "EXPANSION") score += 20;
  else if (reg === "TREND") score += 10;
  else if (reg === "CHOP") score -= 5;
  else if (reg === "DRY") score -= 15;
  else if (reg === "HEADWIND") score -= 20;

  const wf = n(whaleFlow, 0);
  if (wf > 20) score += 10;
  else if (wf > 10) score += 5;
  else if (wf < 5) score -= 5;

  const btcChg = n(btc?.chg24, 0);
  if (mode === "bear") {
    if (btcChg < -2) score += 10;
    else if (btcChg < -1) score += 5;
    else if (btcChg > 1) score -= 10;
  }

  return clamp(Math.round(score), 0, 100);
}

export function computePerfectCandidateScore({ qualityScore, liquidityScore, timingScore, marketScore }) {
  const total =
    n(qualityScore, 0) * 0.4 +
    n(timingScore, 0) * 0.3 +
    n(liquidityScore, 0) * 0.2 +
    n(marketScore, 0) * 0.1;

  return clamp(Math.round(total), 0, 100);
}

export default {
  config,
  MOON_V2,
  getCfg,
  computeVelocity,
  computeCompression,
  computeBreakoutPressure,
  computePersistenceScore,
  computeMarketRegime,
  adjustMoonConfigForRegime,
  computeEliteQuality,
  computeBullMoveScore,
  computeBearMoveScore,
  isBullExhausted,
  isBearBounceTrap,
  isLateBullEntry,
  isLateBearEntry,
  computeMoonProbabilities,
  computeMoonRisk,
  computeBtcAlignmentScore,
  computeQualityScore,
  computeLiquidityScore,
  computeTimingScore,
  computeMarketScore,
  computePerfectCandidateScore,
};