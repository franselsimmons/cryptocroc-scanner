// lib/_moon_core_bull.js
import { RUNTIME_CONFIG } from "./_runtime.js";
export const config = RUNTIME_CONFIG;

/**
 * PURE BULL MOON CORE:
 * - geen fetch
 * - geen kv
 * - alleen thresholds + scoring + helpers
 * - strengere variant: minder ruis, hogere kwaliteit
 */

export const MOON_V2 = {
  minVol24h: 500_000,
  minVmRadar: 0.10,
  minVmBuildup: 0.22,
  minVmAlmost: 0.30,
  minVmElite: 0.38,

  minCh1hRadar: -0.4,
  minCh1hBuildup: 0.9,
  minCh1hAlmost: 1.6,
  minCh1hIgnition: 1.8,
  minCh1hExpansion: 3.8,

  minCh24Radar: 2.0,
  minCh24Buildup: 5.5,
  minCh24Almost: 10,
  minCh24Ignition: 10,
  minCh24Expansion: 20,

  minObBull: 0.032,
  minObStrong: 0.050,
  spreadMaxRadar: 1.20,
  spreadMaxElite: 0.90,

  maxExhaust24: 70,
  minVelocity: 0.12,
  strongVelocity: 0.15,
  explosiveVelocity: 0.25,

  maxMcapRadar: 500_000_000,
  maxMcapBuildup: 300_000_000,
  maxMcapAlmost: 220_000_000,
  maxMcapElite: 150_000_000,

  minPersistenceIgnition: 66,
  minPersistenceExpansion: 76,
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
    ready: pressure >= 68 && breakoutPct <= 4.2,
  };
}

export function computePersistenceScore({ priceHist = [], volHist = [], stageHist = [], mode = "bull" }) {
  const p = Array.isArray(priceHist) ? priceHist.slice(-8).map((x) => n(x, 0)) : [];
  const v = Array.isArray(volHist) ? volHist.slice(-8).map((x) => n(x, 0)) : [];
  const s = Array.isArray(stageHist) ? stageHist.slice(-5).map((x) => up(x)) : [];
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

export function computeMarketRegime({ btc, whaleFlow, mode = "bull" }) {
  const btcState = up(btc?.state || "NEUTRAL");
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
  const r = up(regime);

  if (r === "DRY") {
    cfg.minVmBuildup = Math.max(0, n(cfg.minVmBuildup, 0) - 0.01);
    cfg.minVmAlmost = Math.max(0, n(cfg.minVmAlmost, 0) - 0.01);
    cfg.minCh24Almost = Math.max(0, n(cfg.minCh24Almost, 0) - 0.5);
    cfg.strongVelocity = Math.max(0, n(cfg.strongVelocity, 0) - 0.005);
  }

  if (r === "EXPANSION") {
    cfg.minVmElite = Math.max(0, n(cfg.minVmElite, 0) - 0.01);
    cfg.minCh24Ignition = Math.max(0, n(cfg.minCh24Ignition, 0) - 0.4);
  }

  if (r === "HEADWIND") {
    cfg.minVmElite = n(cfg.minVmElite, 0) + 0.04;
    cfg.minCh24Ignition = n(cfg.minCh24Ignition, 0) + 1.2;
  }

  return cfg;
}

export function computeEliteQuality({ moveScore, velocity, vm, obScore, compression, volAcc, persistenceScore, regime }) {
  let score = 0;
  score += n(moveScore, 0) * 0.30;
  score += Math.min(n(velocity, 0) * 100, 40) * 0.14;
  score += Math.min(n(vm, 0) * 40, 18);
  score += n(persistenceScore, 0) * 0.24;

  if (n(obScore, 0) > 0.05) score += 6;
  if (n(obScore, 0) > 0.08) score += 5;
  if (n(obScore, 0) < -0.05) score += 6;
  if (n(obScore, 0) < -0.08) score += 5;

  if (compression?.isCompressed) score += 3;
  if (n(volAcc?.short, 1) > 1.10) score += 4;
  if (n(volAcc?.medium, 1) > 1.22) score += 6;

  if (up(regime) === "EXPANSION") score += 4;
  if (up(regime) === "HEADWIND") score -= 6;

  return Math.round(clamp(score, 0, 100));
}

export function isBullExhausted(coin) {
  const ch24 = n(coin?.change24, 0);
  const ch1h = n(coin?.change1h, 0);
  const vm = n(coin?.vm, 0);
  const velocity = computeVelocity(ch1h, ch24);

  if (ch24 >= 55 && ch1h < 1.0) return true;
  if (ch24 >= 42 && velocity < 0.10) return true;
  if (ch24 >= 35 && vm < 0.25) return true;

  return false;
}

export function isBearBounceTrap() {
  return false;
}

export function isLateBullEntry(coin) {
  const ch1h = n(coin?.change1h, 0);
  const ch24 = n(coin?.change24, 0);
  const vm = n(coin?.vm, 0);

  if (ch1h >= 12 && ch24 >= 32) return true;
  if (ch1h >= 9 && ch24 >= 42) return true;
  if (ch24 >= 55 && vm < 1.2) return true;

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

  if (vm >= 0.1) score += 8;
  if (vm >= 0.2) score += 14;
  if (vm >= 0.4) score += 22;
  if (vm >= 0.8) score += 30;
  if (vm >= 1.5) score += 36;

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
  return computeBullMoveScore(coin, obx);
}

export function computeMoonProbabilities({ mode, coin, moveScore, velocity, compression, persistenceScore = 0 }) {
  const vm = n(coin?.vm, 0);
  const obScore = n(coin?.ob?.score, 0);
  const velScore = velocity >= 0.38 ? 100 : velocity >= 0.26 ? 82 : velocity >= 0.16 ? 60 : 20;
  const compScore = compression?.isCompressed ? 85 : 20;
  const vmScore = vm >= 1.5 ? 100 : vm >= 0.8 ? 82 : vm >= 0.4 ? 65 : vm >= 0.2 ? 40 : 15;
  const persist = clamp(n(persistenceScore, 0), 0, 100);

  const moonProbability = mode === "bull"
    ? Math.max(
        0,
        Math.min(
          1,
          (moveScore * 0.34) / 100 +
            (velScore * 0.18) / 100 +
            (vmScore * 0.14) / 100 +
            (compScore * 0.08) / 100 +
            (persist * 0.18) / 100 +
            (obScore > 0.05 ? 0.08 : 0)
        )
      )
    : 0;

  return { moonProbability: Number(moonProbability.toFixed(3)), dumpProbability: 0 };
}

export function computeMoonRisk({ mode, price, range24, confidence, depthOk, tier, regime = "TREND", persistenceScore = 50 }) {
  if (!price || price <= 0) return null;

  const p = n(price, 0);
  const r24 = clamp(n(range24, 0), 1, 45);
  const conf = clamp(n(confidence, 0), 0, 100);
  const persist = clamp(n(persistenceScore, 50), 0, 100);
  const reg = up(regime);

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
    else if (state === "BEAR") score -= 20;

    if (chg24 > 2) score += 10;
    else if (chg24 > 1) score += 5;
    else if (chg24 < -1) score -= 10;
  }

  if (range24 > 5) score += 10;
  else if (range24 > 3) score += 5;
  else if (range24 < 1.5) score -= 5;

  const reg = up(regime);
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
  const st = up(stage);

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
  const reg = up(regime);

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
  if (mode === "bull") {
    if (btcChg > 2) score += 10;
    else if (btcChg > 1) score += 5;
    else if (btcChg < -1) score -= 10;
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

// ====================== DESK GATE ======================

const DESK_THRESHOLDS_MOON = {
  watchConfirmScans: 2,
  openConfirmScans: 2,

  watchMinHoldMs: 25 * 60 * 1000,
  openMinHoldMs: 15 * 60 * 1000,

  watchEnterEQ: 72,
  watchEnterPS: 58,
  watchEnterPressure: 58,
  watchEnterObScore: 0.012,

  watchStayEQ: 64,
  watchStayPS: 52,

  openEnterEQ: 78,
  openEnterPS: 62,
  openEnterPressure: 60,

  openStayEQ: 68,
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
      (n(entryQuality, 0) >= T.watchEnterEQ &&
        n(persistenceScore, 0) >= T.watchEnterPS &&
        (brReady || brPressure >= T.watchEnterPressure) &&
        n(obScore, 0) >= T.watchEnterObScore));

  const canStayWatch =
    hasTradePlan === true &&
    n(entryQuality, 0) >= T.watchStayEQ &&
    n(persistenceScore, 0) >= T.watchStayPS;

  const wantOpenFinal =
    wantOpen === true &&
    isEliteStageForDesk &&
    hasTradePlan === true &&
    n(entryQuality, 0) >= T.openEnterEQ &&
    n(persistenceScore, 0) >= T.openEnterPS &&
    (brReady || brPressure >= T.openEnterPressure);

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

export function computeDeskGate({ mode, stage, entryQuality, persistenceScore, breakout, obScore, tradePlan, now, prevGate, prevMeta, isEliteStageForDesk }) {
  const aPlus =
    tradePlan &&
    entryQuality >= 78 &&
    persistenceScore >= 62 &&
    breakout?.ready &&
    obScore >= 0.035;

  const nearAPlus =
    tradePlan &&
    entryQuality >= 72 &&
    persistenceScore >= 56 &&
    (breakout?.ready || breakout?.pressure >= 58);

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

  const engineGate = hyst.gate;
  const uiGate = engineGate;
  return { engineGate, uiGate, deskMeta: hyst.meta };
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

  const sorter = (a, b) => (b.entryQuality || b.confidence || 0) - (a.entryQuality || a.confidence || 0);

  for (const key of ["elite_expansion", "elite_ignition", "almost", "buildup", "radar"]) {
    funnel[key].sort(sorter);
    if (key === "elite_expansion") funnel[key] = funnel[key].slice(0, 12);
    if (key === "elite_ignition") funnel[key] = funnel[key].slice(0, 12);
    if (key === "almost") funnel[key] = funnel[key].slice(0, 20);
    if (key === "buildup") funnel[key] = funnel[key].slice(0, 35);
    if (key === "radar") funnel[key] = funnel[key].slice(0, 80);
  }

  return funnel;
}

export function computeThesisDamage(coin, prevState, mode) {
  let damage = 0;
  const reasons = {};

  const obScore = n(coin?.ob?.score, 0);
  if (mode === "bull" && obScore < -0.02) {
    damage += 2;
    reasons.obContra = true;
  }
  if (mode === "bear" && obScore > 0.02) {
    damage += 2;
    reasons.obContra = true;
  }

  const v1 = n(coin?.volAcc?.short, 1);
  const v2 = n(coin?.volAcc?.medium, 1);
  if (v1 < 1.01 && v2 < 1.04) {
    damage += 1;
    reasons.volDead = true;
  }

  if (!coin?.breakout?.ready) {
    damage += 1;
    reasons.breakoutLost = true;
  }

  const ps = n(coin?.persistenceScore, 0);
  const prevPs = n(prevState?.persistenceScore, 0);
  if (ps < prevPs - 15) {
    damage += 2;
    reasons.persistDrop = true;
  }

  return { damage, reasons };
}

export function decideMoonStage({
  CORE, mode, coin, obx, priceHist, volHist, btc, prev, whaleFlow, regime
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

  if (mode === "bear" && CORE.isBearBounceTrap(coin)) {
    return {
      stage: "RADAR",
      stageWhy: "bear_bounce_trap",
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

  if (mode === "bear" && CORE.isLateBearEntry(coin)) {
    return {
      stage: "ALMOST",
      stageWhy: "late_bear_entry",
      moveScore: 0,
      velocity,
      compression,
      breakout,
      eliteType: null,
      persistenceScore,
      entryQuality: 0,
    };
  }

  const moveScore = mode === "bull" ? CORE.computeBullMoveScore(coin, obx) : CORE.computeBearMoveScore(coin, obx);

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

  const btcMomentumOk = mode === "bull"
    ? n(btc?.chg24, 0) >= 0.8 && n(btc?.range24, 0) >= 2.8
    : n(btc?.chg24, 0) <= -0.8 && n(btc?.range24, 0) >= 2.8;

  if (volAcc.short < 1.01 && volAcc.medium < 1.06 && moveScore < 72 && !breakout.ready && persistenceScore < 58) {
    return {
      stage: "ALMOST",
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

  if (mode === "bull") {
    if (
      n(coin.change1h, 0) >= n(cfg.minCh1hExpansion, 0) &&
      n(coin.change24, 0) >= n(cfg.minCh24Expansion, 0) &&
      n(coin.vm, 0) >= n(cfg.minVmElite, 0) &&
      n(obx.score, 0) >= n(cfg.minObStrong, 0) &&
      velocity >= n(cfg.explosiveVelocity, 0) &&
      entryQuality >= 80 &&
      persistenceScore >= n(cfg.minPersistenceExpansion, 76)
    ) {
      stage = "ELITE_EXPANSION";
      eliteType = "expansion";
    } else if (
      n(coin.change1h, 0) >= n(cfg.minCh1hIgnition, 0) &&
      n(coin.change24, 0) >= n(cfg.minCh24Ignition, 0) &&
      n(coin.vm, 0) >= n(cfg.minVmElite, 0) &&
      n(obx.score, 0) >= n(cfg.minObStrong, 0) &&
      velocity >= n(cfg.strongVelocity, 0) &&
      entryQuality >= 70 &&
      persistenceScore >= n(cfg.minPersistenceIgnition, 66)
    ) {
      stage = "ELITE_IGNITION";
      eliteType = "ignition";
    } else if (
      n(coin.change1h, 0) >= Math.max(1.2, n(cfg.minCh1hAlmost, 0) - 0.1) &&
      n(coin.change24, 0) >= Math.max(7.5, n(cfg.minCh24Almost, 0) - 0.8) &&
      n(coin.vm, 0) >= Math.max(0.26, n(cfg.minVmAlmost, 0) - 0.02) &&
      velocity >= Math.max(0.13, n(cfg.strongVelocity, 0) - 0.01)
    ) {
      stage = "ALMOST";
    } else if (
      n(coin.change1h, 0) >= n(cfg.minCh1hBuildup, 0) &&
      n(coin.change24, 0) >= n(cfg.minCh24Buildup, 0) &&
      n(coin.vm, 0) >= n(cfg.minVmBuildup, 0) &&
      velocity >= n(cfg.minVelocity, 0)
    ) {
      stage = "BUILDUP";
    }
  } else {
    stage = "RADAR";
  }

  if (isMoonEliteStage(stage) && !breakout.ready && entryQuality < 82) {
    stage = "ALMOST";
    eliteType = null;
  }

  if (isMoonEliteStage(stage) && !btcMomentumOk && up(regime) !== "EXPANSION") {
    return {
      stage: "ALMOST",
      stageWhy: "btc_not_expanding",
      moveScore,
      velocity,
      compression,
      breakout,
      eliteType: null,
      persistenceScore,
      entryQuality,
    };
  }

  function hasEliteFollowThrough(prev, currentStage) {
    const curr = up(currentStage);
    if (curr === "ELITE_EXPANSION" || curr === "ELITE_CASCADE") return true;

    const prevStage = up(prev?.stage || "");
    if (curr === "ELITE_IGNITION" && (prevStage === "ALMOST" || prevStage === "BUILDUP")) return true;

    const hist = Array.isArray(prev?.stageHist) ? prev.stageHist : [];
    const tail = hist.slice(-2);
    const eliteLike = tail.filter((s) => {
      const x = up(s);
      return x === "ELITE_IGNITION" || x === "ELITE_EXPANSION" || x === "ELITE_CASCADE";
    }).length;

    return eliteLike >= 1;
  }

  if (isMoonEliteStage(stage) && !hasEliteFollowThrough(prev, stage)) {
    return {
      stage: "ALMOST",
      stageWhy: "elite_needs_followthrough",
      moveScore,
      velocity,
      compression,
      breakout,
      eliteType: null,
      persistenceScore,
      entryQuality,
    };
  }

  return { stage, stageWhy: "ok", moveScore, velocity, compression, breakout, eliteType, persistenceScore, entryQuality };
}

export function buildMoonTradePlan({ CORE, price, mode, confidence, range24, depthOk, tier, regime, persistenceScore }) {
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