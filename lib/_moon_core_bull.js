// lib/_moon_core_bull.js

import { RUNTIME_CONFIG } from "./_runtime.js";
export const config = RUNTIME_CONFIG;

/**
 * MOON CORE BULL
 * Doel:
 * - veel minder kleine scalp-achtige trades
 * - ALMOST en ELITE alleen bij echte kracht
 * - hogere focus op quality / persistence / OB / spread / breakout
 */
export const MOON_V2 = {
  minVol24h: 450_000,
  minVmRadar: 0.06,
  minVmBuildup: 0.11,
  minVmAlmost: 0.20,
  minVmElite: 0.30,

  minCh1hRadar: -0.6,
  minCh1hBuildup: 0.30,
  minCh1hAlmost: 0.90,
  minCh1hIgnition: 1.60,
  minCh1hExpansion: 3.20,

  minCh24Radar: 0.4,
  minCh24Buildup: 2.0,
  minCh24Almost: 4.8,
  minCh24Ignition: 7.0,
  minCh24Expansion: 11.5,

  minObBull: 0.022,
  minObStrong: 0.050,
  spreadMaxRadar: 1.80,
  spreadMaxElite: 0.95,

  maxExhaust24: 70,
  minVelocity: 0.08,
  strongVelocity: 0.14,
  explosiveVelocity: 0.22,

  maxMcapRadar: 900_000_000,
  maxMcapBuildup: 600_000_000,
  maxMcapAlmost: 350_000_000,
  maxMcapElite: 220_000_000,

  minPersistenceIgnition: 68,
  minPersistenceExpansion: 76,

  minQualityAlmost: 58,
  minQualityElite: 72,
  minLiquidityAlmost: 55,
  minLiquidityElite: 62,
  minTimingAlmost: 56,
  minTimingElite: 66,
  minPerfectAlmost: 60,
  minPerfectElite: 74,
};

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
function up(x) {
  return String(x || "").toUpperCase();
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
  if (mc <= 18_000_000) return 20;
  if (mc <= 40_000_000) return 16;
  if (mc <= 90_000_000) return 11;
  if (mc <= 180_000_000) return 6;
  if (mc <= 300_000_000) return 2;
  return 0;
}

export function computeCompression(priceHist = []) {
  const arr = Array.isArray(priceHist)
    ? priceHist.slice(-14).map((x) => n(x, 0)).filter((x) => x > 0)
    : [];

  if (arr.length < 6) return { flatPct: 999, isCompressed: false };

  const hi = Math.max(...arr);
  const lo = Math.min(...arr);
  const mid = (hi + lo) / 2;
  if (!(mid > 0)) return { flatPct: 999, isCompressed: false };

  const flatPct = ((hi - lo) / mid) * 100;
  return {
    flatPct: Number(flatPct.toFixed(2)),
    isCompressed: flatPct <= 4.2,
  };
}

export function computeBreakoutPressure(priceHist = []) {
  const arr = Array.isArray(priceHist)
    ? priceHist.slice(-18).map((x) => n(x, 0)).filter((x) => x > 0)
    : [];

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
    ready: pressure >= 62 && breakoutPct <= 4.8,
  };
}

export function computePersistenceScore({
  priceHist = [],
  volHist = [],
  stageHist = [],
  mode = "bull",
}) {
  const p = Array.isArray(priceHist) ? priceHist.slice(-10).map((x) => n(x, 0)) : [];
  const v = Array.isArray(volHist) ? volHist.slice(-10).map((x) => n(x, 0)) : [];
  const s = Array.isArray(stageHist) ? stageHist.slice(-6).map((x) => up(x)) : [];

  let score = 0;

  if (p.length >= 5) {
    let alignedMoves = 0;
    let strongMoves = 0;

    for (let i = 1; i < p.length; i++) {
      const prev = p[i - 1];
      const cur = p[i];
      if (!(prev > 0 && cur > 0)) continue;

      const diff = ((cur - prev) / prev) * 100;

      if (mode === "bull" && diff >= -0.9) alignedMoves++;
      if (mode === "bear" && diff <= 0.9) alignedMoves++;

      if (mode === "bull" && diff >= 0.25) strongMoves++;
      if (mode === "bear" && diff <= -0.25) strongMoves++;
    }

    score += (alignedMoves / Math.max(1, p.length - 1)) * 24;
    score += (strongMoves / Math.max(1, p.length - 1)) * 18;
  }

  if (v.length >= 5) {
    const first = v[0] || 0;
    const last = v[v.length - 1] || 0;

    if (first > 0) {
      const volTrend = last / first;
      if (volTrend >= 1.00) score += 8;
      if (volTrend >= 1.10) score += 10;
      if (volTrend >= 1.22) score += 12;
    }
  }

  if (s.length) {
    const almostCount = s.filter((x) => x === "ALMOST").length;
    const eliteCount = s.filter((x) => x.includes("ELITE")).length;
    const buildupCount = s.filter((x) => x === "BUILDUP").length;

    score += (almostCount / s.length) * 10;
    score += (eliteCount / s.length) * 18;
    score += (buildupCount / s.length) * 6;
  }

  return Math.round(clamp(score, 0, 100));
}

export function computeMarketRegime({ btc, whaleFlow, mode = "bull" }) {
  const btcState = up(btc?.state || "NEUTRAL");
  const chg24 = n(btc?.chg24, 0);
  const range24 = n(btc?.range24, 0);
  const flows = n(whaleFlow, 0);

  if (range24 >= 5.5 && Math.abs(chg24) >= 1.5) {
    if (mode === "bull" && btcState === "BULL") return "EXPANSION";
    if (mode === "bear" && btcState === "BEAR") return "EXPANSION";
  }

  if (range24 <= 1.4 && Math.abs(chg24) <= 0.45 && flows < 6) return "DRY";
  if (range24 <= 2.7 && Math.abs(chg24) <= 0.9) return "CHOP";
  if (mode === "bull" && btcState === "BEAR") return "HEADWIND";
  if (mode === "bear" && btcState === "BULL") return "HEADWIND";
  return "TREND";
}

export function adjustMoonConfigForRegime(baseCfg, regime) {
  const cfg = JSON.parse(JSON.stringify(baseCfg || {}));
  const r = up(regime);

  if (r === "DRY") {
    cfg.minVmAlmost += 0.02;
    cfg.minVmElite += 0.03;
    cfg.minCh1hAlmost += 0.15;
    cfg.minCh24Almost += 0.8;
    cfg.minQualityAlmost += 2;
    cfg.minPerfectAlmost += 2;
  }

  if (r === "EXPANSION") {
    cfg.minVmElite = Math.max(0, n(cfg.minVmElite, 0) - 0.02);
    cfg.minCh24Ignition = Math.max(0, n(cfg.minCh24Ignition, 0) - 0.8);
    cfg.minPerfectElite = Math.max(0, n(cfg.minPerfectElite, 0) - 2);
  }

  if (r === "HEADWIND") {
    cfg.minVmAlmost += 0.02;
    cfg.minVmElite += 0.03;
    cfg.minCh1hIgnition += 0.20;
    cfg.minCh24Ignition += 1.0;
    cfg.minQualityElite += 2;
    cfg.minPerfectElite += 2;
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

  score += n(moveScore, 0) * 0.24;
  score += Math.min(n(velocity, 0) * 100, 45) * 0.14;
  score += Math.min(n(vm, 0) * 42, 18);
  score += n(persistenceScore, 0) * 0.30;

  if (n(obScore, 0) >= 0.02) score += 4;
  if (n(obScore, 0) >= 0.04) score += 6;
  if (n(obScore, 0) >= 0.07) score += 6;

  if (compression?.isCompressed) score += 5;
  if (n(volAcc?.short, 1) > 1.05) score += 5;
  if (n(volAcc?.medium, 1) > 1.12) score += 8;

  if (up(regime) === "EXPANSION") score += 4;
  if (up(regime) === "HEADWIND") score -= 6;
  if (up(regime) === "DRY") score -= 5;

  return Math.round(clamp(score, 0, 100));
}

export function isBullExhausted(coin) {
  const ch24 = n(coin?.change24, 0);
  const ch1h = n(coin?.change1h, 0);
  const vm = n(coin?.vm, 0);
  const velocity = computeVelocity(ch1h, ch24);

  if (ch24 >= 55 && ch1h < 0.6) return true;
  if (ch24 >= 45 && velocity < 0.06) return true;
  if (ch24 >= 38 && vm < 0.12) return true;

  return false;
}

export function isBearBounceTrap() {
  return false;
}

export function isLateBullEntry(coin) {
  const ch1h = n(coin?.change1h, 0);
  const ch24 = n(coin?.change24, 0);
  const vm = n(coin?.vm, 0);

  if (ch1h >= 11 && ch24 >= 28) return true;
  if (ch1h >= 8 && ch24 >= 36) return true;
  if (ch24 >= 42 && vm < 0.22) return true;

  return false;
}

export function isLateBearEntry() {
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

  if (vm >= 0.06) score += 8;
  if (vm >= 0.10) score += 12;
  if (vm >= 0.18) score += 18;
  if (vm >= 0.30) score += 24;
  if (vm >= 0.55) score += 30;
  if (vm >= 1.00) score += 34;

  if (ch1h >= 0.3) score += 4;
  if (ch1h >= 0.8) score += 8;
  if (ch1h >= 1.4) score += 14;
  if (ch1h >= 2.4) score += 20;
  if (ch1h >= 4.0) score += 26;

  if (ch24 >= 2) score += 4;
  if (ch24 >= 5) score += 8;
  if (ch24 >= 8) score += 14;
  if (ch24 >= 14) score += 20;
  if (ch24 >= 22) score += 24;
  if (ch24 >= 35) score += 28;

  if (ob >= 0.01) score += 3;
  if (ob >= 0.02) score += 6;
  if (ob >= 0.05) score += 10;

  if (spread <= 1.4) score += 2;
  if (spread <= 0.9) score += 4;
  if (spread <= 0.5) score += 6;

  if (depth >= 2_000) score += 3;
  if (depth >= 8_000) score += 6;
  if (depth >= 20_000) score += 8;
  if (depth >= 40_000) score += 10;

  score += mcBonus;

  return Math.max(0, Math.min(100, Math.round(score)));
}

export function computeBearMoveScore(coin, obx) {
  return computeBullMoveScore(coin, obx);
}

export function computeMoonProbabilities({
  mode,
  coin,
  moveScore,
  velocity,
  compression,
  persistenceScore = 0,
}) {
  const vm = n(coin?.vm, 0);
  const obScore = n(coin?.ob?.score, 0);

  const velScore =
    velocity >= 0.30 ? 100 :
    velocity >= 0.22 ? 84 :
    velocity >= 0.14 ? 62 : 18;

  const compScore = compression?.isCompressed ? 82 : 18;

  const vmScore =
    vm >= 1.20 ? 100 :
    vm >= 0.70 ? 86 :
    vm >= 0.35 ? 66 :
    vm >= 0.18 ? 42 : 12;

  const persist = clamp(n(persistenceScore, 0), 0, 100);

  const moonProbability =
    mode === "bull"
      ? Math.max(
          0,
          Math.min(
            1,
            (moveScore * 0.26) / 100 +
              (velScore * 0.16) / 100 +
              (vmScore * 0.14) / 100 +
              (compScore * 0.08) / 100 +
              (persist * 0.24) / 100 +
              (obScore > 0.04 ? 0.08 : obScore > 0.02 ? 0.04 : 0)
          )
        )
      : 0;

  return {
    moonProbability: Number(moonProbability.toFixed(3)),
    dumpProbability: 0,
  };
}

export function computeMoonRisk({
  mode,
  price,
  range24,
  confidence,
  depthOk,
  tier,
  regime = "TREND",
  persistenceScore = 50,
}) {
  if (!price || price <= 0) return null;

  const p = n(price, 0);
  const r24 = clamp(n(range24, 0), 1, 55);
  const conf = clamp(n(confidence, 0), 0, 100);
  const persist = clamp(n(persistenceScore, 50), 0, 100);
  const reg = up(regime);

  let slPct = clamp(4.4 + r24 * 0.10, 4.2, 9.0);
  let tpPct = clamp(10.5 + r24 * 0.30, 11.0, 26.0);

  if (conf >= 70) tpPct += 1.0;
  if (conf >= 80) tpPct += 1.4;
  if (persist >= 70) tpPct += 1.2;
  if (persist >= 78) slPct -= 0.25;
  if (!depthOk) slPct += 0.7;

  if (tier?.name === "small") {
    tpPct += 1.0;
    slPct += 0.4;
  }

  if (tier?.name === "large") {
    tpPct -= 0.8;
    slPct -= 0.2;
  }

  if (reg === "EXPANSION") tpPct += 1.0;
  if (reg === "DRY") tpPct -= 1.2;
  if (reg === "HEADWIND") {
    tpPct -= 1.5;
    slPct += 0.35;
  }

  slPct = clamp(slPct, 4.0, 9.5);
  tpPct = clamp(tpPct, 10.5, 28.0);

  const sl = p * (1 - slPct / 100);
  const tp3 = p * (1 + tpPct / 100);

  return { sl, tp3, slPct, tpPct };
}

export function computeBtcAlignmentScore({ btc, mode, regime }) {
  if (!btc) return 50;

  const chg24 = n(btc.chg24, 0);
  const range24 = n(btc.range24, 0);
  const state = up(btc.state || "");
  let score = 50;

  if (mode === "bull") {
    if (state === "BULL") score += 20;
    else if (state === "BEAR") score -= 16;

    if (chg24 > 1.5) score += 10;
    else if (chg24 > 0.5) score += 5;
    else if (chg24 < -1.2) score -= 10;
  }

  if (range24 > 5) score += 8;
  else if (range24 > 2.2) score += 4;
  else if (range24 < 1.0) score -= 5;

  const reg = up(regime);
  if (reg === "EXPANSION") score += 12;
  else if (reg === "HEADWIND") score -= 12;
  else if (reg === "DRY") score -= 8;

  return clamp(Math.round(score), 0, 100);
}

export function computeQualityScore({
  coin,
  moveScore,
  entryQuality,
  persistenceScore,
  velocity,
  compression,
  breakout,
}) {
  let score = 0;

  score += n(moveScore, 0) * 0.24;
  score += n(entryQuality, 0) * 0.30;
  score += n(persistenceScore, 0) * 0.20;

  if (n(velocity, 0) > 0.12) score += 6;
  if (n(velocity, 0) > 0.18) score += 6;
  if (compression?.isCompressed) score += 7;
  if (breakout?.ready) score += 13;

  const vm = n(coin?.vm, 0);
  if (vm > 0.25) score += 6;
  if (vm > 0.50) score += 6;

  return clamp(Math.round(score), 0, 100);
}

export function computeLiquidityScore({ ob, depthOk, spreadPct, depthMinUsd1p }) {
  if (!ob) return 28;

  let score = 46;

  if (depthOk) score += 16;
  else score -= 10;

  const spread = n(spreadPct, 999);
  if (spread < 0.5) score += 18;
  else if (spread < 0.9) score += 12;
  else if (spread < 1.4) score += 6;
  else if (spread > 2.0) score -= 10;

  const depth = n(depthMinUsd1p, 0);
  if (depth > 30_000) score += 16;
  else if (depth > 15_000) score += 12;
  else if (depth > 6_000) score += 8;
  else if (depth > 2_000) score += 4;
  else if (depth < 1_000) score -= 10;

  const obScore = n(ob.score, 0);
  if (Math.abs(obScore) > 0.03) score += 5;
  if (Math.abs(obScore) > 0.06) score += 7;

  return clamp(Math.round(score), 0, 100);
}

export function computeTimingScore({
  mode,
  stage,
  breakout,
  volAcc,
  strongScans = 0,
  eliteScans = 0,
  lateEntry = false,
  exhausted = false,
  bounceTrap = false,
}) {
  let score = 46;
  const st = up(stage);

  if (st === "ELITE_EXPANSION" || st === "ELITE_CASCADE") score += 26;
  else if (st === "ELITE_IGNITION") score += 18;
  else if (st === "ALMOST") score += 9;
  else if (st === "BUILDUP") score += 3;
  else score -= 8;

  if (breakout?.ready) score += 15;
  else if (n(breakout?.pressure, 0) >= 52) score += 6;

  const vShort = n(volAcc?.short, 1);
  const vMed = n(volAcc?.medium, 1);

  if (vShort > 1.08) score += 8;
  else if (vShort > 1.03) score += 4;

  if (vMed > 1.15) score += 8;
  else if (vMed > 1.08) score += 4;

  if (strongScans >= 2) score += 6;
  if (eliteScans >= 1) score += 6;

  if (lateEntry) score -= 14;
  if (exhausted) score -= 18;
  if (bounceTrap) score -= 12;

  return clamp(Math.round(score), 0, 100);
}

export function computeMarketScore({ btc, mode, regime, whaleFlow }) {
  let score = 50;
  const reg = up(regime);

  if (reg === "EXPANSION") score += 18;
  else if (reg === "TREND") score += 10;
  else if (reg === "CHOP") score -= 4;
  else if (reg === "DRY") score -= 12;
  else if (reg === "HEADWIND") score -= 16;

  const wf = n(whaleFlow, 0);
  if (wf > 18) score += 8;
  else if (wf > 8) score += 4;
  else if (wf < 4) score -= 5;

  const btcChg = n(btc?.chg24, 0);
  if (mode === "bull") {
    if (btcChg > 1.6) score += 8;
    else if (btcChg > 0.4) score += 4;
    else if (btcChg < -1.4) score -= 8;
  }

  return clamp(Math.round(score), 0, 100);
}

export function computePerfectCandidateScore({
  qualityScore,
  liquidityScore,
  timingScore,
  marketScore,
}) {
  const total =
    n(qualityScore, 0) * 0.42 +
    n(timingScore, 0) * 0.28 +
    n(liquidityScore, 0) * 0.20 +
    n(marketScore, 0) * 0.10;

  return clamp(Math.round(total), 0, 100);
}

const DESK_THRESHOLDS_MOON = {
  watchConfirmScans: 2,
  openConfirmScans: 2,

  watchMinHoldMs: 10 * 60 * 1000,
  openMinHoldMs: 8 * 60 * 1000,

  watchEnterEQ: 60,
  watchEnterPS: 55,
  watchEnterPressure: 54,
  watchEnterObScore: 0.015,

  watchStayEQ: 52,
  watchStayPS: 46,

  openEnterEQ: 72,
  openEnterPS: 64,
  openEnterPressure: 60,

  openStayEQ: 62,
  openStayPS: 56,
};

function isMoonEliteStage(stage) {
  const s = up(stage);
  return s === "ELITE_IGNITION" || s === "ELITE_EXPANSION" || s === "ELITE_CASCADE";
}

export function decideDeskGateHysteresis({
  prevGate = "IGNORE",
  prevMeta = {},
  now,
  isEliteStageForDesk,
  hasTradePlan,
  entryQuality,
  persistenceScore,
  breakout,
  obScore,
  wantWatch,
  wantOpen,
  T = DESK_THRESHOLDS_MOON,
}) {
  const prev = up(prevGate);
  const prevSince = n(prevMeta.deskGateSince, 0);
  const prevHoldUntil = n(prevMeta.deskHoldUntil, 0);
  const prevOpenStreak = n(prevMeta.openStreak, 0);
  const prevWatchStreak = n(prevMeta.watchStreak, 0);
  const brReady = !!breakout?.ready;
  const brPressure = n(breakout?.pressure, 0);

  const wantWatchFinal =
    wantWatch === true &&
    hasTradePlan === true &&
    (isEliteStageForDesk ||
      (
        n(entryQuality, 0) >= T.watchEnterEQ &&
        n(persistenceScore, 0) >= T.watchEnterPS &&
        (brReady || brPressure >= T.watchEnterPressure) &&
        n(obScore, 0) >= T.watchEnterObScore
      ));

  const canStayWatch =
    hasTradePlan === true &&
    n(entryQuality, 0) >= T.watchStayEQ &&
    n(persistenceScore, 0) >= T.watchStayPS;

  const wantOpenFinal =
    wantOpen === true &&
    hasTradePlan === true &&
    (isEliteStageForDesk ||
      (
        n(entryQuality, 0) >= T.openEnterEQ &&
        n(persistenceScore, 0) >= T.openEnterPS &&
        (brReady || brPressure >= T.openEnterPressure)
      ));

  const canStayOpen =
    hasTradePlan === true &&
    n(entryQuality, 0) >= T.openStayEQ &&
    n(persistenceScore, 0) >= T.openStayPS;

  const holdActive = prevHoldUntil > now;

  let openStreak = wantOpenFinal ? prevOpenStreak + 1 : 0;
  let watchStreak = wantWatchFinal ? prevWatchStreak + 1 : 0;
  let gate = prev;

  if (prev === "OPEN") {
    if (holdActive) gate = "OPEN";
    else if (canStayOpen) gate = "OPEN";
    else gate = "WATCH";
  } else {
    if (wantOpenFinal && openStreak >= T.openConfirmScans) gate = "OPEN";
  }

  if (gate !== "OPEN") {
    if (prev === "WATCH") {
      if (holdActive) gate = "WATCH";
      else if (canStayWatch) gate = "WATCH";
      else gate = "IGNORE";
    } else {
      if (wantWatchFinal && watchStreak >= T.watchConfirmScans) gate = "WATCH";
    }
  }

  let deskGateSince = prevSince;
  let deskHoldUntil = prevHoldUntil;

  if (gate !== prev) {
    deskGateSince = now;
    if (gate === "WATCH") deskHoldUntil = now + T.watchMinHoldMs;
    else if (gate === "OPEN") deskHoldUntil = now + T.openMinHoldMs;
    else deskHoldUntil = 0;
  }

  return {
    gate,
    meta: { deskGateSince, deskHoldUntil, openStreak, watchStreak },
  };
}

export function computeDeskGate({
  mode,
  stage,
  entryQuality,
  persistenceScore,
  breakout,
  obScore,
  tradePlan,
  now,
  prevGate,
  prevMeta,
  isEliteStageForDesk,
}) {
  const aPlus =
    tradePlan &&
    entryQuality >= 72 &&
    persistenceScore >= 64 &&
    (breakout?.ready || n(breakout?.pressure, 0) >= 60) &&
    n(obScore, 0) >= 0.02;

  const nearAPlus =
    tradePlan &&
    entryQuality >= 60 &&
    persistenceScore >= 55 &&
    (breakout?.ready || n(breakout?.pressure, 0) >= 54) &&
    n(obScore, 0) >= 0.015;

  const hyst = decideDeskGateHysteresis({
    prevGate: prevGate || "IGNORE",
    prevMeta: prevMeta || {},
    now,
    isEliteStageForDesk,
    hasTradePlan: !!tradePlan,
    entryQuality,
    persistenceScore,
    breakout,
    obScore,
    wantWatch: nearAPlus,
    wantOpen: aPlus,
    T: DESK_THRESHOLDS_MOON,
  });

  return { engineGate: hyst.gate, uiGate: hyst.gate, deskMeta: hyst.meta };
}

export function splitFunnels(coins) {
  const funnel = {
    elite_expansion: [],
    elite_ignition: [],
    almost: [],
    buildup: [],
    radar: [],
    hold: [],
  };

  for (const c of coins) {
    const stage = up(c.stage);
    if (stage === "ELITE_EXPANSION" || stage === "ELITE_CASCADE") funnel.elite_expansion.push(c);
    else if (stage === "ELITE_IGNITION") funnel.elite_ignition.push(c);
    else if (stage === "ALMOST") funnel.almost.push(c);
    else if (stage === "BUILDUP") funnel.buildup.push(c);
    else funnel.radar.push(c);
  }

  const sorter = (a, b) =>
    (b.perfectCandidateScore || b.entryQuality || b.confidence || 0) -
    (a.perfectCandidateScore || a.entryQuality || a.confidence || 0);

  for (const key of ["elite_expansion", "elite_ignition", "almost", "buildup", "radar"]) {
    funnel[key].sort(sorter);
    if (key === "elite_expansion") funnel[key] = funnel[key].slice(0, 20);
    if (key === "elite_ignition") funnel[key] = funnel[key].slice(0, 20);
    if (key === "almost") funnel[key] = funnel[key].slice(0, 30);
    if (key === "buildup") funnel[key] = funnel[key].slice(0, 40);
    if (key === "radar") funnel[key] = funnel[key].slice(0, 70);
  }

  return funnel;
}

export function computeThesisDamage(coin, prevState, mode) {
  let damage = 0;
  const reasons = {};
  const obScore = n(coin?.ob?.score, 0);

  if (mode === "bull" && obScore < -0.05) {
    damage += 1;
    reasons.obContra = true;
  }
  if (mode === "bear" && obScore > 0.05) {
    damage += 1;
    reasons.obContra = true;
  }

  const v1 = n(coin?.volAcc?.short, 1);
  const v2 = n(coin?.volAcc?.medium, 1);
  if (v1 < 0.98 && v2 < 1.00) {
    damage += 1;
    reasons.volDead = true;
  }

  if (!coin?.breakout?.ready && n(coin?.breakout?.pressure, 0) < 36) {
    damage += 1;
    reasons.breakoutLost = true;
  }

  const ps = n(coin?.persistenceScore, 0);
  const prevPs = n(prevState?.persistenceScore, 0);
  if (ps < prevPs - 18) {
    damage += 1;
    reasons.persistDrop = true;
  }

  return { damage, reasons };
}

export function decideMoonStage({
  CORE,
  mode,
  coin,
  obx,
  priceHist,
  volHist,
  btc,
  prev,
  whaleFlow,
  regime,
}) {
  const baseCfg = CORE.getCfg();
  const cfg = CORE.adjustMoonConfigForRegime(baseCfg, regime);

  const velocity = CORE.computeVelocity(coin.change1h, coin.change24);
  const compression = CORE.computeCompression(priceHist);
  const breakout = CORE.computeBreakoutPressure(priceHist);

  const prevVolAcc = prev?.volAcc || { short: 1, medium: 1 };
  const volAcc = {
    short: n(prevVolAcc.short, 1),
    medium: n(prevVolAcc.medium, 1),
  };

  const persistenceScore = CORE.computePersistenceScore({
    priceHist,
    volHist,
    stageHist: prev?.stageHist || [],
    mode,
  });

  if (mode === "bull" && CORE.isBullExhausted(coin)) {
    return {
      stage: "RADAR",
      stageWhy: "bull_exhausted",
      moveScore: 0,
      velocity,
      compression,
      breakout,
      eliteType: null,
      persistenceScore,
      entryQuality: 0,
    };
  }

  if (mode === "bull" && CORE.isLateBullEntry(coin)) {
    return {
      stage: "ALMOST",
      stageWhy: "late_bull_entry",
      moveScore: 0,
      velocity,
      compression,
      breakout,
      eliteType: null,
      persistenceScore,
      entryQuality: 0,
    };
  }

  const moveScore = CORE.computeBullMoveScore(coin, obx);

  const entryQuality = CORE.computeEliteQuality({
    moveScore,
    velocity,
    vm: coin.vm,
    obScore: obx.score,
    compression,
    volAcc,
    persistenceScore,
    regime,
  });

  const qualityScore = CORE.computeQualityScore({
    coin,
    moveScore,
    entryQuality,
    persistenceScore,
    velocity,
    compression,
    breakout,
  });

  const liquidityScore = CORE.computeLiquidityScore({
    ob: obx,
    depthOk: true,
    spreadPct: obx.spreadPct,
    depthMinUsd1p: obx.depthMinUsd1p,
  });

  const timingScore = CORE.computeTimingScore({
    mode,
    stage: prev?.stage || "RADAR",
    breakout,
    volAcc,
    strongScans: prev?.strongScans || 0,
    eliteScans: prev?.eliteScans || 0,
    lateEntry: CORE.isLateBullEntry(coin),
    exhausted: CORE.isBullExhausted(coin),
    bounceTrap: false,
  });

  const marketScore = CORE.computeMarketScore({ btc, mode, regime, whaleFlow });

  const perfectCandidateScore = CORE.computePerfectCandidateScore({
    qualityScore,
    liquidityScore,
    timingScore,
    marketScore,
  });

  const btcMomentumOk =
    n(btc?.chg24, 0) >= 0.15 && n(btc?.range24, 0) >= 1.2;

  if (
    n(coin.volume, 0) < n(cfg.minVol24h, 0) ||
    n(obx.spreadPct, 999) > n(cfg.spreadMaxRadar, 999) ||
    n(coin.marketCap, 0) > n(cfg.maxMcapRadar, Number.MAX_SAFE_INTEGER)
  ) {
    return {
      stage: "RADAR",
      stageWhy: "fails_base_quality",
      moveScore,
      velocity,
      compression,
      breakout,
      eliteType: null,
      persistenceScore,
      entryQuality,
    };
  }

  if (
    volAcc.short < 1.00 &&
    volAcc.medium < 1.02 &&
    moveScore < 48 &&
    !breakout.ready &&
    persistenceScore < 36
  ) {
    return {
      stage: "RADAR",
      stageWhy: "volume_not_accelerating",
      moveScore,
      velocity,
      compression,
      breakout,
      eliteType: null,
      persistenceScore,
      entryQuality,
    };
  }

  let stage = "RADAR";
  let eliteType = null;

  if (
    n(coin.change1h, 0) >= n(cfg.minCh1hExpansion, 0) &&
    n(coin.change24, 0) >= n(cfg.minCh24Expansion, 0) &&
    n(coin.vm, 0) >= n(cfg.minVmElite, 0) &&
    n(obx.score, 0) >= n(cfg.minObStrong, 0) &&
    n(obx.spreadPct, 999) <= n(cfg.spreadMaxElite, 999) &&
    n(coin.marketCap, 0) <= n(cfg.maxMcapElite, Number.MAX_SAFE_INTEGER) &&
    velocity >= n(cfg.explosiveVelocity, 0) &&
    entryQuality >= 78 &&
    persistenceScore >= n(cfg.minPersistenceExpansion, 68) &&
    qualityScore >= n(cfg.minQualityElite, 72) &&
    liquidityScore >= n(cfg.minLiquidityElite, 62) &&
    timingScore >= n(cfg.minTimingElite, 66) &&
    perfectCandidateScore >= n(cfg.minPerfectElite, 74) &&
    breakout.ready
  ) {
    stage = "ELITE_EXPANSION";
    eliteType = "expansion";
  } else if (
    n(coin.change1h, 0) >= n(cfg.minCh1hIgnition, 0) &&
    n(coin.change24, 0) >= n(cfg.minCh24Ignition, 0) &&
    n(coin.vm, 0) >= n(cfg.minVmElite, 0) &&
    n(obx.score, 0) >= n(cfg.minObStrong, 0) &&
    n(obx.spreadPct, 999) <= Math.min(1.10, n(cfg.spreadMaxElite, 999) + 0.15) &&
    n(coin.marketCap, 0) <= n(cfg.maxMcapElite, Number.MAX_SAFE_INTEGER) &&
    velocity >= n(cfg.strongVelocity, 0) &&
    entryQuality >= 72 &&
    persistenceScore >= n(cfg.minPersistenceIgnition, 60) &&
    qualityScore >= n(cfg.minQualityElite, 72) - 4 &&
    liquidityScore >= n(cfg.minLiquidityElite, 62) - 4 &&
    timingScore >= n(cfg.minTimingElite, 66) - 4 &&
    perfectCandidateScore >= n(cfg.minPerfectElite, 74) - 4 &&
    (breakout.ready || n(breakout.pressure, 0) >= 56)
  ) {
    stage = "ELITE_IGNITION";
    eliteType = "ignition";
  } else if (
    n(coin.change1h, 0) >= n(cfg.minCh1hAlmost, 0) &&
    n(coin.change24, 0) >= n(cfg.minCh24Almost, 0) &&
    n(coin.vm, 0) >= n(cfg.minVmAlmost, 0) &&
    n(obx.score, 0) >= n(cfg.minObBull, 0) &&
    n(obx.spreadPct, 999) <= 1.30 &&
    n(coin.marketCap, 0) <= n(cfg.maxMcapAlmost, Number.MAX_SAFE_INTEGER) &&
    velocity >= n(cfg.strongVelocity, 0) &&
    entryQuality >= 60 &&
    persistenceScore >= 52 &&
    qualityScore >= n(cfg.minQualityAlmost, 58) &&
    liquidityScore >= n(cfg.minLiquidityAlmost, 55) &&
    timingScore >= n(cfg.minTimingAlmost, 56) &&
    perfectCandidateScore >= n(cfg.minPerfectAlmost, 60) &&
    (breakout.ready || n(breakout.pressure, 0) >= 50)
  ) {
    stage = "ALMOST";
  } else if (
    n(coin.change1h, 0) >= n(cfg.minCh1hBuildup, 0) &&
    n(coin.change24, 0) >= n(cfg.minCh24Buildup, 0) &&
    n(coin.vm, 0) >= n(cfg.minVmBuildup, 0) &&
    n(obx.spreadPct, 999) <= 1.55 &&
    n(coin.marketCap, 0) <= n(cfg.maxMcapBuildup, Number.MAX_SAFE_INTEGER) &&
    velocity >= n(cfg.minVelocity, 0) &&
    entryQuality >= 46 &&
    persistenceScore >= 42
  ) {
    stage = "BUILDUP";
  }

  if (isMoonEliteStage(stage) && (!btcMomentumOk || up(regime) === "HEADWIND")) {
    return {
      stage: "ALMOST",
      stageWhy: "btc_not_supportive",
      moveScore,
      velocity,
      compression,
      breakout,
      eliteType: null,
      persistenceScore,
      entryQuality,
    };
  }

  return {
    stage,
    stageWhy: "ok",
    moveScore,
    velocity,
    compression,
    breakout,
    eliteType,
    persistenceScore,
    entryQuality,
  };
}

export function buildMoonTradePlan({
  CORE,
  price,
  mode,
  confidence,
  range24,
  depthOk,
  tier,
  regime,
  persistenceScore,
}) {
  const risk = CORE.computeMoonRisk({
    mode,
    price,
    range24,
    confidence,
    depthOk,
    tier,
    regime,
    persistenceScore,
  });

  if (!risk) return null;

  return {
    entry: Number(price.toFixed(8)),
    sl: Number(risk.sl.toFixed(8)),
    tp: Number(risk.tp3.toFixed(8)),
    rr: Number((risk.tpPct / Math.max(risk.slPct, 0.0001)).toFixed(2)),
    tpPct: Number(risk.tpPct.toFixed(2)),
    slPct: Number(risk.slPct.toFixed(2)),
  };
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
  decideDeskGateHysteresis,
  computeDeskGate,
  splitFunnels,
  computeThesisDamage,
  decideMoonStage,
  buildMoonTradePlan,
};