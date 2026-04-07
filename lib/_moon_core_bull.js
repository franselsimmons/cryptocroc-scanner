import { RUNTIME_CONFIG } from "./_runtime.js";
export const config = RUNTIME_CONFIG;

/**
 * PURE BULL MOON CORE - SUPER LOS
 * - veel meer intake
 * - elite sneller haalbaar
 * - neutrale BTC veel minder rem
 * - ideaal om eerst veel dataset op te bouwen
 */
export const MOON_V2 = {
  minVol24h: 120_000,
  minVmRadar: 0.025,
  minVmBuildup: 0.05,
  minVmAlmost: 0.08,
  minVmElite: 0.12,

  minCh1hRadar: -1.5,
  minCh1hBuildup: 0.10,
  minCh1hAlmost: 0.35,
  minCh1hIgnition: 0.55,
  minCh1hExpansion: 1.20,

  minCh24Radar: -4.0,
  minCh24Buildup: 0.8,
  minCh24Almost: 1.8,
  minCh24Ignition: 2.5,
  minCh24Expansion: 5.0,

  minObBull: 0.004,
  minObStrong: 0.010,
  spreadMaxRadar: 3.00,
  spreadMaxElite: 2.20,

  maxExhaust24: 140,
  minVelocity: 0.03,
  strongVelocity: 0.05,
  explosiveVelocity: 0.08,

  maxMcapRadar: 2_500_000_000,
  maxMcapBuildup: 1_600_000_000,
  maxMcapAlmost: 1_000_000_000,
  maxMcapElite: 700_000_000,

  minPersistenceIgnition: 24,
  minPersistenceExpansion: 32,
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
  if (mc <= 700_000_000) return 1;
  return 0;
}

export function computeCompression(priceHist = []) {
  const arr = Array.isArray(priceHist)
    ? priceHist.slice(-12).map((x) => n(x, 0)).filter((x) => x > 0)
    : [];

  if (arr.length < 4) return { flatPct: 999, isCompressed: false };

  const hi = Math.max(...arr);
  const lo = Math.min(...arr);
  const mid = (hi + lo) / 2;
  if (!(mid > 0)) return { flatPct: 999, isCompressed: false };

  const flatPct = ((hi - lo) / mid) * 100;
  return { flatPct: Number(flatPct.toFixed(2)), isCompressed: flatPct <= 7.5 };
}

export function computeBreakoutPressure(priceHist = []) {
  const arr = Array.isArray(priceHist)
    ? priceHist.slice(-15).map((x) => n(x, 0)).filter((x) => x > 0)
    : [];

  if (arr.length < 6) return { breakoutPct: 0, pressure: 0, ready: false };

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
    ready: pressure >= 48 && breakoutPct <= 9.0,
  };
}

export function computePersistenceScore({ priceHist = [], volHist = [], stageHist = [], mode = "bull" }) {
  const p = Array.isArray(priceHist) ? priceHist.slice(-8).map((x) => n(x, 0)) : [];
  const v = Array.isArray(volHist) ? volHist.slice(-8).map((x) => n(x, 0)) : [];
  const s = Array.isArray(stageHist) ? stageHist.slice(-5).map((x) => up(x)) : [];

  let score = 0;

  if (p.length >= 3) {
    let alignedMoves = 0;
    for (let i = 1; i < p.length; i++) {
      const prev = p[i - 1];
      const cur = p[i];
      if (!(prev > 0 && cur > 0)) continue;
      const diff = ((cur - prev) / prev) * 100;
      if (mode === "bull" && diff >= -2.2) alignedMoves++;
      if (mode === "bear" && diff <= 2.2) alignedMoves++;
    }
    score += (alignedMoves / Math.max(1, p.length - 1)) * 35;
  }

  if (v.length >= 3) {
    const first = v[0] || 0;
    const last = v[v.length - 1] || 0;
    if (first > 0) {
      const volTrend = last / first;
      if (volTrend >= 0.95) score += 8;
      if (volTrend >= 1.03) score += 8;
      if (volTrend >= 1.10) score += 8;
    }
  }

  if (s.length) {
    const eliteLike = s.filter((x) => x.includes("ELITE") || x === "ALMOST" || x === "BUILDUP").length;
    score += (eliteLike / s.length) * 25;
  }

  return Math.round(clamp(score, 0, 100));
}

export function computeMarketRegime({ btc, whaleFlow, mode = "bull" }) {
  const btcState = up(btc?.state || "NEUTRAL");
  const chg24 = n(btc?.chg24, 0);
  const range24 = n(btc?.range24, 0);
  const flows = n(whaleFlow, 0);

  if (range24 >= 5.5 && Math.abs(chg24) >= 1.4) {
    if (mode === "bull" && btcState === "BULL") return "EXPANSION";
    if (mode === "bear" && btcState === "BEAR") return "EXPANSION";
  }
  if (range24 <= 1.2 && Math.abs(chg24) <= 0.4 && flows < 6) return "DRY";
  if (range24 <= 2.5 && Math.abs(chg24) <= 0.9) return "CHOP";
  if (mode === "bull" && btcState === "BEAR") return "HEADWIND";
  if (mode === "bear" && btcState === "BULL") return "HEADWIND";
  return "TREND";
}

export function adjustMoonConfigForRegime(baseCfg, regime) {
  const cfg = JSON.parse(JSON.stringify(baseCfg || {}));
  const r = up(regime);

  if (r === "DRY") {
    cfg.minVmBuildup = Math.max(0, n(cfg.minVmBuildup, 0) - 0.02);
    cfg.minVmAlmost = Math.max(0, n(cfg.minVmAlmost, 0) - 0.03);
    cfg.minCh24Almost = Math.max(-20, n(cfg.minCh24Almost, 0) - 0.8);
    cfg.strongVelocity = Math.max(0, n(cfg.strongVelocity, 0) - 0.015);
  }

  if (r === "EXPANSION") {
    cfg.minVmElite = Math.max(0, n(cfg.minVmElite, 0) - 0.02);
    cfg.minCh24Ignition = Math.max(-20, n(cfg.minCh24Ignition, 0) - 0.8);
  }

  if (r === "HEADWIND") {
    cfg.minVmElite = n(cfg.minVmElite, 0) + 0.02;
    cfg.minCh24Ignition = n(cfg.minCh24Ignition, 0) + 0.8;
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
  score += n(moveScore, 0) * 0.28;
  score += Math.min(n(velocity, 0) * 100, 40) * 0.12;
  score += Math.min(n(vm, 0) * 40, 16);
  score += n(persistenceScore, 0) * 0.28;

  if (n(obScore, 0) > 0.01) score += 4;
  if (n(obScore, 0) > 0.03) score += 4;
  if (compression?.isCompressed) score += 4;
  if (n(volAcc?.short, 1) > 1.02) score += 4;
  if (n(volAcc?.medium, 1) > 1.06) score += 6;

  if (up(regime) === "EXPANSION") score += 5;
  if (up(regime) === "HEADWIND") score -= 4;

  return Math.round(clamp(score, 0, 100));
}

export function isBullExhausted(coin) {
  const ch24 = n(coin?.change24, 0);
  const ch1h = n(coin?.change1h, 0);
  const vm = n(coin?.vm, 0);
  const velocity = computeVelocity(ch1h, ch24);

  if (ch24 >= 120 && ch1h < 0.2) return true;
  if (ch24 >= 90 && velocity < 0.03) return true;
  if (ch24 >= 75 && vm < 0.08) return true;

  return false;
}

export function isBearBounceTrap() {
  return false;
}

export function isLateBullEntry(coin) {
  const ch1h = n(coin?.change1h, 0);
  const ch24 = n(coin?.change24, 0);
  const vm = n(coin?.vm, 0);

  if (ch1h >= 28 && ch24 >= 90) return true;
  if (ch1h >= 20 && ch24 >= 110) return true;
  if (ch24 >= 130 && vm < 0.8) return true;

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

  if (vm >= 0.03) score += 6;
  if (vm >= 0.06) score += 10;
  if (vm >= 0.12) score += 16;
  if (vm >= 0.25) score += 22;
  if (vm >= 0.50) score += 28;
  if (vm >= 1.0) score += 34;

  if (ch1h >= 0.1) score += 4;
  if (ch1h >= 0.5) score += 8;
  if (ch1h >= 1.0) score += 12;
  if (ch1h >= 2.0) score += 18;
  if (ch1h >= 4.0) score += 24;

  if (ch24 >= 1) score += 4;
  if (ch24 >= 3) score += 8;
  if (ch24 >= 6) score += 12;
  if (ch24 >= 12) score += 18;
  if (ch24 >= 20) score += 24;
  if (ch24 >= 35) score += 28;

  if (ob >= 0.003) score += 3;
  if (ob >= 0.01) score += 5;
  if (ob >= 0.03) score += 8;

  if (spread <= 3.0) score += 2;
  if (spread <= 2.2) score += 4;
  if (spread <= 1.2) score += 5;

  if (depth >= 500) score += 2;
  if (depth >= 2_000) score += 4;
  if (depth >= 8_000) score += 6;
  if (depth >= 20_000) score += 7;

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
  const velScore = velocity >= 0.18 ? 100 : velocity >= 0.12 ? 82 : velocity >= 0.06 ? 60 : 20;
  const compScore = compression?.isCompressed ? 78 : 20;
  const vmScore = vm >= 0.8 ? 100 : vm >= 0.4 ? 82 : vm >= 0.2 ? 65 : vm >= 0.08 ? 40 : 15;
  const persist = clamp(n(persistenceScore, 0), 0, 100);

  const moonProbability =
    mode === "bull"
      ? Math.max(
          0,
          Math.min(
            1,
            (moveScore * 0.30) / 100 +
              (velScore * 0.16) / 100 +
              (vmScore * 0.14) / 100 +
              (compScore * 0.08) / 100 +
              (persist * 0.20) / 100 +
              (obScore > 0.02 ? 0.06 : 0)
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
  const r24 = clamp(n(range24, 0), 1, 65);
  const conf = clamp(n(confidence, 0), 0, 100);
  const persist = clamp(n(persistenceScore, 50), 0, 100);
  const reg = up(regime);

  let slPct = clamp(4.8 + r24 * 0.10, 4.5, 11.5);
  let tpPct = clamp(8.5 + r24 * 0.22, 9.5, 26);

  if (conf >= 60) tpPct += 1.0;
  if (conf >= 75) tpPct += 1.4;
  if (persist >= 60) tpPct += 1.2;
  if (persist >= 75) slPct -= 0.3;

  if (!depthOk) slPct += 0.7;

  if (tier?.name === "small") {
    tpPct += 1.2;
    slPct += 0.4;
  }
  if (tier?.name === "large") {
    tpPct -= 0.8;
    slPct -= 0.2;
  }

  if (reg === "EXPANSION") tpPct += 1.2;
  if (reg === "DRY") tpPct -= 1.0;
  if (reg === "HEADWIND") {
    tpPct -= 1.4;
    slPct += 0.4;
  }

  slPct = clamp(slPct, 4.2, 12.0);
  tpPct = clamp(tpPct, 9.0, 28.0);

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
    if (state === "BULL") score += 18;
    else if (state === "BEAR") score -= 12;

    if (chg24 > 1.2) score += 8;
    else if (chg24 > 0.2) score += 4;
    else if (chg24 < -1.5) score -= 8;
  }

  if (range24 > 5) score += 8;
  else if (range24 > 2) score += 4;
  else if (range24 < 1.0) score -= 4;

  const reg = up(regime);
  if (reg === "EXPANSION") score += 12;
  else if (reg === "HEADWIND") score -= 10;
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
  score += n(moveScore, 0) * 0.28;
  score += n(entryQuality, 0) * 0.26;
  score += n(persistenceScore, 0) * 0.18;
  if (n(velocity, 0) > 0.08) score += 8;
  if (compression?.isCompressed) score += 8;
  if (breakout?.ready) score += 12;

  const vm = n(coin?.vm, 0);
  if (vm > 0.20) score += 8;
  else if (vm > 0.08) score += 4;

  return clamp(Math.round(score), 0, 100);
}

export function computeLiquidityScore({ ob, depthOk, spreadPct, depthMinUsd1p }) {
  if (!ob) return 35;

  let score = 50;

  if (depthOk) score += 12;
  else score -= 6;

  const spread = n(spreadPct, 999);
  if (spread < 0.8) score += 18;
  else if (spread < 1.5) score += 12;
  else if (spread < 2.2) score += 6;
  else if (spread > 3.5) score -= 8;

  const depth = n(depthMinUsd1p, 0);
  if (depth > 20_000) score += 15;
  else if (depth > 8_000) score += 10;
  else if (depth > 2_000) score += 6;
  else if (depth > 500) score += 2;
  else score -= 8;

  const obScore = n(ob.score, 0);
  if (Math.abs(obScore) > 0.03) score += 6;
  if (Math.abs(obScore) > 0.07) score += 6;

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
  let score = 50;
  const st = up(stage);

  if (st === "ELITE_EXPANSION" || st === "ELITE_CASCADE") score += 22;
  else if (st === "ELITE_IGNITION") score += 16;
  else if (st === "ALMOST") score += 10;
  else if (st === "BUILDUP") score += 6;
  else score -= 4;

  if (breakout?.ready) score += 12;

  const vShort = n(volAcc?.short, 1);
  const vMed = n(volAcc?.medium, 1);

  if (vShort > 1.05) score += 8;
  else if (vShort > 1.00) score += 4;

  if (vMed > 1.10) score += 8;
  else if (vMed > 1.03) score += 4;

  if (strongScans >= 2) score += 8;
  else if (strongScans >= 1) score += 4;

  if (eliteScans >= 1) score += 6;
  if (lateEntry) score -= 10;
  if (exhausted) score -= 14;
  if (bounceTrap) score -= 12;

  return clamp(Math.round(score), 0, 100);
}

export function computeMarketScore({ btc, mode, regime, whaleFlow }) {
  let score = 50;
  const reg = up(regime);

  if (reg === "EXPANSION") score += 18;
  else if (reg === "TREND") score += 10;
  else if (reg === "CHOP") score -= 2;
  else if (reg === "DRY") score -= 10;
  else if (reg === "HEADWIND") score -= 14;

  const wf = n(whaleFlow, 0);
  if (wf > 18) score += 8;
  else if (wf > 8) score += 4;
  else if (wf < 4) score -= 4;

  const btcChg = n(btc?.chg24, 0);
  if (mode === "bull") {
    if (btcChg > 1.5) score += 8;
    else if (btcChg > 0.3) score += 4;
    else if (btcChg < -1.8) score -= 8;
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
    n(qualityScore, 0) * 0.40 +
    n(timingScore, 0) * 0.28 +
    n(liquidityScore, 0) * 0.20 +
    n(marketScore, 0) * 0.12;

  return clamp(Math.round(total), 0, 100);
}

// ====================== DESK GATE SUPER LOS ======================

const DESK_THRESHOLDS_MOON = {
  watchConfirmScans: 1,
  openConfirmScans: 1,

  watchMinHoldMs: 8 * 60 * 1000,
  openMinHoldMs: 5 * 60 * 1000,

  watchEnterEQ: 38,
  watchEnterPS: 28,
  watchEnterPressure: 38,
  watchEnterObScore: 0.001,

  watchStayEQ: 30,
  watchStayPS: 20,

  openEnterEQ: 42,
  openEnterPS: 30,
  openEnterPressure: 40,

  openStayEQ: 34,
  openStayPS: 22,
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
    hasTradePlan === true &&
    (isEliteStageForDesk ||
      (n(entryQuality, 0) >= T.openEnterEQ &&
        n(persistenceScore, 0) >= T.openEnterPS &&
        (brReady || brPressure >= T.openEnterPressure)));

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
    entryQuality >= 42 &&
    persistenceScore >= 30 &&
    (breakout?.ready || n(breakout?.pressure, 0) >= 40);

  const nearAPlus =
    tradePlan &&
    entryQuality >= 36 &&
    persistenceScore >= 24 &&
    (breakout?.ready || n(breakout?.pressure, 0) >= 34);

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

  const sorter = (a, b) =>
    (b.entryQuality || b.confidence || 0) - (a.entryQuality || a.confidence || 0);

  for (const key of ["elite_expansion", "elite_ignition", "almost", "buildup", "radar"]) {
    funnel[key].sort(sorter);
    if (key === "elite_expansion") funnel[key] = funnel[key].slice(0, 30);
    if (key === "elite_ignition") funnel[key] = funnel[key].slice(0, 30);
    if (key === "almost") funnel[key] = funnel[key].slice(0, 50);
    if (key === "buildup") funnel[key] = funnel[key].slice(0, 80);
    if (key === "radar") funnel[key] = funnel[key].slice(0, 140);
  }

  return funnel;
}

export function computeThesisDamage(coin, prevState, mode) {
  let damage = 0;
  const reasons = {};
  const obScore = n(coin?.ob?.score, 0);

  if (mode === "bull" && obScore < -0.06) {
    damage += 1;
    reasons.obContra = true;
  }
  if (mode === "bear" && obScore > 0.06) {
    damage += 1;
    reasons.obContra = true;
  }

  const v1 = n(coin?.volAcc?.short, 1);
  const v2 = n(coin?.volAcc?.medium, 1);
  if (v1 < 0.96 && v2 < 0.98) {
    damage += 1;
    reasons.volDead = true;
  }

  if (!coin?.breakout?.ready && n(coin?.breakout?.pressure, 0) < 30) {
    damage += 1;
    reasons.breakoutLost = true;
  }

  const ps = n(coin?.persistenceScore, 0);
  const prevPs = n(prevState?.persistenceScore, 0);
  if (ps < prevPs - 28) {
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

  const moveScore =
    mode === "bull"
      ? CORE.computeBullMoveScore(coin, obx)
      : CORE.computeBearMoveScore(coin, obx);

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

  const btcMomentumOk =
    mode === "bull"
      ? n(btc?.chg24, 0) >= -0.2 && n(btc?.range24, 0) >= 1.0
      : n(btc?.chg24, 0) <= 0.2 && n(btc?.range24, 0) >= 1.0;

  const neutralOverrideOk =
    up(btc?.state) === "NEUTRAL" &&
    n(obx.score, 0) >= 0.01 &&
    n(volAcc.short, 1) >= 1.00 &&
    n(volAcc.medium, 1) >= 1.00 &&
    entryQuality >= 34 &&
    persistenceScore >= 24;

  if (
    volAcc.short < 0.96 &&
    volAcc.medium < 0.98 &&
    moveScore < 40 &&
    !breakout.ready &&
    persistenceScore < 20
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

  if (mode === "bull") {
    if (
      n(coin.change1h, 0) >= n(cfg.minCh1hExpansion, 0) &&
      n(coin.change24, 0) >= n(cfg.minCh24Expansion, 0) &&
      n(coin.vm, 0) >= n(cfg.minVmElite, 0) &&
      n(obx.score, 0) >= n(cfg.minObStrong, 0) &&
      velocity >= n(cfg.explosiveVelocity, 0) &&
      entryQuality >= 44 &&
      persistenceScore >= n(cfg.minPersistenceExpansion, 32)
    ) {
      stage = "ELITE_EXPANSION";
      eliteType = "expansion";
    } else if (
      n(coin.change1h, 0) >= n(cfg.minCh1hIgnition, 0) &&
      n(coin.change24, 0) >= n(cfg.minCh24Ignition, 0) &&
      n(coin.vm, 0) >= n(cfg.minVmElite, 0) &&
      n(obx.score, 0) >= n(cfg.minObStrong, 0) &&
      velocity >= n(cfg.strongVelocity, 0) &&
      entryQuality >= 36 &&
      persistenceScore >= n(cfg.minPersistenceIgnition, 24)
    ) {
      stage = "ELITE_IGNITION";
      eliteType = "ignition";
    } else if (
      n(coin.change1h, 0) >= Math.max(0.12, n(cfg.minCh1hAlmost, 0) - 0.3) &&
      n(coin.change24, 0) >= Math.max(0.6, n(cfg.minCh24Almost, 0) - 1.2) &&
      n(coin.vm, 0) >= Math.max(0.05, n(cfg.minVmAlmost, 0) - 0.03) &&
      velocity >= Math.max(0.03, n(cfg.strongVelocity, 0) - 0.03)
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

  if (isMoonEliteStage(stage) && !breakout.ready && entryQuality < 48) {
    stage = "ALMOST";
    eliteType = null;
  }

  if (
    isMoonEliteStage(stage) &&
    !btcMomentumOk &&
    up(regime) !== "EXPANSION" &&
    !neutralOverrideOk
  ) {
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

  function hasEliteFollowThrough(prevState, currentStage) {
    const curr = up(currentStage);
    if (curr === "ELITE_EXPANSION" || curr === "ELITE_CASCADE") return true;

    const prevStage = up(prevState?.stage || "");
    if (
      curr === "ELITE_IGNITION" &&
      (prevStage === "ALMOST" || prevStage === "BUILDUP" || prevStage === "RADAR")
    ) {
      return true;
    }

    const hist = Array.isArray(prevState?.stageHist) ? prevState.stageHist : [];
    const tail = hist.slice(-2);
    const eliteLike = tail.filter((s) => {
      const x = up(s);
      return (
        x === "ELITE_IGNITION" ||
        x === "ELITE_EXPANSION" ||
        x === "ELITE_CASCADE" ||
        x === "ALMOST"
      );
    }).length;

    return eliteLike >= 0;
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