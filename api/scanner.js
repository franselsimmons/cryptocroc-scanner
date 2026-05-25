import {
  fetchCoinGeckoTopCached,
  generateShallowOb,
  fetchFuturesTickers
} from "../lib/_main_shared.js";

import { detectRegime } from "../lib/regime.js";
import { calculateEdge } from "../lib/edge.js";
import { setLatestScan, getLatestScan } from "../lib/scanStore.js";

import {
  resetAnalytics,
  logAnalytics,
  getAnalytics
} from "../lib/analyticsEngine.js";

import { generateAdvice } from "../lib/analysisAdvisor.js";
import { classifyMarket } from "../lib/marketClassifier.js";

import {
  loadStageMemory,
  saveStageMemory,
  cleanMemory
} from "../lib/stageMemory.js";

import { initDefaultFilters } from "../lib/filterState.js";
import { buildTimeframeContext } from "../lib/timeframe.js";

const STAGES = ["entry", "almost", "buildup", "radar"];
const SIDES = ["bull", "bear"];

const SCANNER_PROFILE = "RUNNER";
const SCANNER_VERSION = "RUNNER_SCANNER_V2_EXTREME_LOOSE_ANALYSIS";

// ================= RUNNER SCANNER CONFIG =================
// Doel: maximaal analyse-universum bouwen.
// Live-selectie/filtering hoort in tradesystem/optimizer, niet hier.
function getRunnerScannerConfig(regime, market) {
  const trend = String(
    market?.trend ||
    market?.state ||
    market ||
    ""
  ).toUpperCase();

  const r = String(regime || "NORMAL").toUpperCase();

  const cfg = {
    profile: SCANNER_PROFILE,
    scannerVersion: SCANNER_VERSION,

    // Extreem laag: scanner moet niet bottlenecken.
    vmMin: 0.003,
    hardChange24: 0.05,
    hardChange1h: 0.02,

    // Mag licht negatief zijn zodat vroege flips/mean-reversion runners ook zichtbaar worden.
    minDirectionalPressure: -0.12,

    // Lage floors: tradesystem krijgt meer rows.
    minRunnerScore: 6,
    minEntryScore: 28,

    // Grote output-set.
    targetMinimum: 80,
    fallbackMax: 180,

    // Boost bewust hoog: scanner is discovery-layer.
    scoreBoost: 16,

    // Geen directional hard-block in scanner.
    allowNeutralDirection: true,

    // Exhaustion niet blokkeren in scanner; tradesystem/optimizer beslist later.
    maxCh1Chaos: 99,
    maxCh24Exhaustion: 999,
    exhaustionPenaltyEnabled: false
  };

  if (r === "LOW_VOL") {
    cfg.vmMin = 0.0015;
    cfg.hardChange24 = 0.025;
    cfg.hardChange1h = 0.01;
    cfg.minDirectionalPressure = -0.16;
    cfg.minRunnerScore = 4;
    cfg.minEntryScore = 24;
    cfg.targetMinimum = 100;
    cfg.fallbackMax = 220;
    cfg.scoreBoost = 20;
  }

  if (r === "HIGH_VOL") {
    cfg.vmMin = 0.004;
    cfg.hardChange24 = 0.08;
    cfg.hardChange1h = 0.025;
    cfg.minDirectionalPressure = -0.08;
    cfg.minRunnerScore = 8;
    cfg.minEntryScore = 30;
    cfg.targetMinimum = 90;
    cfg.fallbackMax = 200;
    cfg.scoreBoost = 18;
  }

  if (trend === "BULLISH" || trend === "BEARISH") {
    cfg.targetMinimum += 20;
    cfg.fallbackMax += 40;
    cfg.minRunnerScore = Math.max(2, cfg.minRunnerScore - 2);
    cfg.minEntryScore = Math.max(20, cfg.minEntryScore - 4);
  }

  if (trend === "TRENDING") {
    cfg.targetMinimum += 28;
    cfg.fallbackMax += 56;
    cfg.minRunnerScore = Math.max(2, cfg.minRunnerScore - 3);
    cfg.minEntryScore = Math.max(18, cfg.minEntryScore - 5);
  }

  if (trend === "CHOPPY") {
    // Niet meer strakker maken. Juist meer data verzamelen.
    cfg.targetMinimum += 10;
    cfg.fallbackMax += 30;
  }

  return cfg;
}

// ================= GENERIC HELPERS =================
function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(Number(value || 0), max));
}

function normalizeCounterMap(map) {
  const out = {};

  for (const [key, value] of Object.entries(map || {})) {
    const n = Math.round(Number(value || 0));
    if (n > 0) out[String(key)] = n;
  }

  return out;
}

function emptyDashboardStats(now = Date.now()) {
  return {
    startedAt: now,
    lastResetAt: now,
    lastScanAt: 0,

    totalScans: 0,
    totalEntries: 0,
    totalRejected: 0,
    totalOtherTrades: 0,
    totalFunnelCoins: 0,
    totalCandidates: 0,

    lastEntries: 0,
    lastRejected: 0,
    lastOtherTrades: 0,
    lastFunnelCoins: 0,
    lastCandidates: 0,

    rejectReasonCounts: {},
    actionCounts: {},

    entryRows: [],
    rejectedRows: [],
    tradeRows: []
  };
}

function normalizeDashboardStats(stats, now = Date.now()) {
  const base = stats ? { ...stats } : emptyDashboardStats(now);

  return {
    startedAt: safeNumber(base?.startedAt, now),
    lastResetAt: safeNumber(base?.lastResetAt, safeNumber(base?.startedAt, now)),
    lastScanAt: safeNumber(base?.lastScanAt, 0),

    totalScans: safeNumber(base?.totalScans, 0),
    totalEntries: safeNumber(base?.totalEntries, 0),
    totalRejected: safeNumber(base?.totalRejected, 0),
    totalOtherTrades: safeNumber(base?.totalOtherTrades, 0),
    totalFunnelCoins: safeNumber(base?.totalFunnelCoins, 0),
    totalCandidates: safeNumber(base?.totalCandidates, 0),

    lastEntries: safeNumber(base?.lastEntries, 0),
    lastRejected: safeNumber(base?.lastRejected, 0),
    lastOtherTrades: safeNumber(base?.lastOtherTrades, 0),
    lastFunnelCoins: safeNumber(base?.lastFunnelCoins, 0),
    lastCandidates: safeNumber(base?.lastCandidates, 0),

    rejectReasonCounts: normalizeCounterMap(base?.rejectReasonCounts),
    actionCounts: normalizeCounterMap(base?.actionCounts),

    entryRows: safeArray(base?.entryRows),
    rejectedRows: safeArray(base?.rejectedRows),
    tradeRows: safeArray(base?.tradeRows)
  };
}

// ================= QUERY NORMALIZERS =================
function normalizeScanSide(side) {
  const s = String(side || "both").toLowerCase();

  if (s === "bull") return "bull";
  if (s === "bear") return "bear";

  return "both";
}

function normalizeNotify(value) {
  const v = String(value || "").toLowerCase();

  return v === "true" || v === "1" || v === "yes";
}

function normalizeStore(value, fallback = true) {
  if (value === undefined || value === null) return fallback;

  const v = String(value || "").toLowerCase();

  if (v === "false" || v === "0" || v === "no") return false;
  if (v === "true" || v === "1" || v === "yes") return true;

  return fallback;
}

function safeStage(stage) {
  return STAGES.includes(stage) ? stage : "radar";
}

// ================= RUNNER PRESSURE / FLOW =================
function getDirectionalPressure(c) {
  const ch24 = Number(c.change24 || 0);
  const ch1 = Number(c.change1h || 0);

  return (ch1 * 0.78) + (ch24 * 0.22);
}

function getDirectionalValues(c, side) {
  const dir = side === "bear" ? -1 : 1;

  const ch24 = Number(c.change24 || 0) * dir;
  const ch1 = Number(c.change1h || 0) * dir;
  const pressure = getDirectionalPressure(c) * dir;
  const vm = Number(c.vm || 0);

  const hourlyTrendBaseline = ch24 / 24;
  const acceleration = ch1 - hourlyTrendBaseline;

  return {
    dir,
    ch24,
    ch1,
    pressure,
    vm,
    acceleration,
    absCh24: Math.abs(Number(c.change24 || 0)),
    absCh1: Math.abs(Number(c.change1h || 0))
  };
}

function displayDirectionAllowed(c, side, adaptive = {}) {
  const v = getDirectionalValues(c, side);

  const minPressure = Number(adaptive.minDirectionalPressure ?? -0.12);
  const vmMin = Number(adaptive.vmMin || 0.003);
  const hardChange1h = Number(adaptive.hardChange1h || 0.02);
  const hardChange24 = Number(adaptive.hardChange24 || 0.05);

  if (v.pressure >= minPressure) return true;
  if (v.ch1 >= hardChange1h * 0.25) return true;
  if (v.ch24 >= hardChange24 * 0.25) return true;
  if (v.vm >= vmMin * 1.15 && v.absCh1 >= hardChange1h * 0.50) return true;
  if (v.vm >= vmMin * 1.50 && v.absCh24 >= hardChange24 * 0.50) return true;

  return Boolean(adaptive.allowNeutralDirection && v.vm >= vmMin);
}

function detectRunnerFlow(c, side, adaptive = {}) {
  const v = getDirectionalValues(c, side);
  const boost = Number(adaptive.scoreBoost || 0);

  const ch1 = Math.max(0, v.ch1);
  const ch24 = Math.max(0, v.ch24);
  const vm = Number(v.vm || 0);
  const vmMin = Number(adaptive.vmMin || 0.003);

  if (ch1 > (boost > 0 ? 1.35 : 1.75) && vm > 0.055) return "SQUEEZE";
  if (ch1 > (boost > 0 ? 0.42 : 0.60) && ch24 > 0.55) return "RUNNING";
  if (ch1 > (boost > 0 ? 0.12 : 0.20) || ch24 > 0.35) return "BREAKOUT";
  if (ch1 > -0.06 || ch24 > 0.12 || vm >= vmMin * 1.40) return "BUILDING";

  if (
    adaptive.allowNeutralDirection &&
    vm >= vmMin &&
    (v.absCh1 > 0 || v.absCh24 > 0)
  ) {
    return "BUILDING";
  }

  return "NEUTRAL";
}

function calculateRunnerFreshness(c, side) {
  const v = getDirectionalValues(c, side);

  const ch24 = Math.max(0, v.ch24);
  const ch1 = Math.max(0, v.ch1);

  let freshness = 4;

  if (ch1 > 2.5) freshness += 22;
  else if (ch1 > 1.5) freshness += 18;
  else if (ch1 > 0.9) freshness += 14;
  else if (ch1 > 0.45) freshness += 10;
  else if (ch1 > 0.20) freshness += 7;
  else if (ch1 > 0.05) freshness += 4;

  if (ch24 > 0) {
    const ratio = ch1 / Math.max(ch24, 0.01);

    if (ratio > 0.55) freshness += 10;
    else if (ratio > 0.35) freshness += 7;
    else if (ratio > 0.18) freshness += 4;
    else if (ratio > 0.05) freshness += 2;
  }

  if (v.acceleration > 1.2) freshness += 8;
  else if (v.acceleration > 0.6) freshness += 5;
  else if (v.acceleration > 0.15) freshness += 3;
  else if (v.acceleration > -0.20) freshness += 1;

  // Penalties bewust zacht. Scanner moet niet snoeien.
  if (ch24 > 30 && ch1 < 0.15) freshness -= 4;
  if (v.ch1 < -0.40) freshness -= 6;

  return clamp(freshness, 0, 40);
}

function calculateExhaustionPenalty(c, side, adaptive = {}) {
  if (!adaptive.exhaustionPenaltyEnabled) return 0;

  const v = getDirectionalValues(c, side);

  const ch24 = Math.max(0, v.ch24);
  const ch1 = Math.max(0, v.ch1);

  let penalty = 0;

  if (ch24 > Number(adaptive.maxCh24Exhaustion || 999)) penalty += 4;
  if (ch24 > 40 && ch1 < 0.20) penalty += 5;
  if (ch1 > Number(adaptive.maxCh1Chaos || 99)) penalty += 4;
  if (v.acceleration < -1.25) penalty += 5;

  return penalty;
}

function calculateRunnerScore(c, regime, side, adaptive = {}) {
  const v = getDirectionalValues(c, side);

  const ch24 = Math.max(0, v.ch24);
  const ch1 = Math.max(0, v.ch1);
  const freshness = calculateRunnerFreshness(c, side);

  // Base score bewust > 0 zodat discovery niet stilvalt.
  let score = 18;

  if (ch1 > 4.0) score += 34;
  else if (ch1 > 2.2) score += 30;
  else if (ch1 > 1.2) score += 24;
  else if (ch1 > 0.65) score += 18;
  else if (ch1 > 0.35) score += 13;
  else if (ch1 > 0.15) score += 8;
  else if (ch1 > 0.03) score += 4;

  if (ch24 > 18) score += 18;
  else if (ch24 > 10) score += 16;
  else if (ch24 > 5) score += 12;
  else if (ch24 > 2.2) score += 8;
  else if (ch24 > 0.50) score += 5;
  else if (ch24 > 0.10) score += 2;

  if (v.vm > 0.45) score += 20;
  else if (v.vm > 0.25) score += 16;
  else if (v.vm > 0.12) score += 11;
  else if (v.vm > 0.06) score += 8;
  else if (v.vm > 0.02) score += 5;
  else if (v.vm > 0.005) score += 2;

  if (v.acceleration > 2.0) score += 14;
  else if (v.acceleration > 1.0) score += 11;
  else if (v.acceleration > 0.45) score += 7;
  else if (v.acceleration > 0.10) score += 4;
  else if (v.acceleration > -0.25) score += 1;

  score += freshness;

  const minPressure = Number(adaptive.minDirectionalPressure ?? -0.12);

  if (v.pressure < minPressure - 0.25) score -= 4;
  if (v.ch1 <= -0.35) score -= 8;
  if (v.ch24 < -3.0) score -= 4;

  score -= calculateExhaustionPenalty(c, side, adaptive);

  if (String(regime).toUpperCase() === "LOW_VOL") score += 2;
  if (String(regime).toUpperCase() === "HIGH_VOL") score += 4;

  score += Number(adaptive.scoreBoost || 0);

  return clamp(score, 0, 100);
}

function fallbackStage(score, flow, freshness = 0, adaptive = {}) {
  const minEntry = Number(adaptive.minEntryScore || 28);
  const f = String(flow || "NEUTRAL").toUpperCase();

  if (
    ["SQUEEZE", "RUNNING", "BREAKOUT"].includes(f) &&
    score >= minEntry &&
    freshness >= 4
  ) {
    return "entry";
  }

  if (
    ["SQUEEZE", "RUNNING", "BREAKOUT", "BUILDING"].includes(f) &&
    score >= 18
  ) {
    return "almost";
  }

  if (
    ["RUNNING", "BREAKOUT", "BUILDING"].includes(f) &&
    score >= 8
  ) {
    return "buildup";
  }

  return "radar";
}

function mergeStage(prevStage, filterStage) {
  const order = ["radar", "buildup", "almost", "entry"];

  const prevIndex = order.indexOf(prevStage || "radar");
  const newIndex = order.indexOf(filterStage || "radar");

  if (newIndex >= prevIndex) return filterStage;

  return order[Math.max(0, prevIndex - 1)];
}

function classifyRunnerEntryType(coin) {
  const flow = String(coin.flow || "").toUpperCase();
  const acceleration = Number(coin.runnerAcceleration || 0);
  const freshness = Number(coin.freshness || 0);
  const score = Number(coin.moveScore || 0);

  if (flow === "SQUEEZE" && score >= 62) return "RUNNER_C_SQUEEZE";
  if (["RUNNING", "BREAKOUT"].includes(flow) && acceleration > -0.10) return "RUNNER_A_BREAKOUT";
  if (freshness >= 8 && acceleration > -0.35) return "RUNNER_B_CONTINUATION";

  return "RUNNER_RADAR";
}

function getRunnerFilterStage(coin, adaptive = {}) {
  const score = Number(coin.moveScore || 0);
  const freshness = Number(coin.freshness || 0);
  const pressure = Number(coin.runnerPressure || 0);
  const acceleration = Number(coin.runnerAcceleration || 0);
  const flow = String(coin.flow || "NEUTRAL").toUpperCase();

  const minRunnerScore = Number(adaptive.minRunnerScore || 6);
  const minEntryScore = Number(adaptive.minEntryScore || 28);
  const minPressure = Number(adaptive.minDirectionalPressure ?? -0.12);

  if (score < minRunnerScore) return null;
  if (pressure < minPressure - 0.35 && score < minEntryScore) return null;
  if (flow === "NEUTRAL" && score < 14) return null;

  if (
    score >= minEntryScore &&
    freshness >= 4 &&
    acceleration > -0.45 &&
    ["SQUEEZE", "RUNNING", "BREAKOUT", "BUILDING"].includes(flow)
  ) {
    return "entry";
  }

  if (
    score >= 18 &&
    ["SQUEEZE", "RUNNING", "BREAKOUT", "BUILDING"].includes(flow)
  ) {
    return "almost";
  }

  if (
    score >= 8 &&
    ["RUNNING", "BREAKOUT", "BUILDING", "NEUTRAL"].includes(flow)
  ) {
    return "buildup";
  }

  return "radar";
}

// ================= BITGET SYMBOL NORMALIZERS =================
function normalizeBitgetContractSymbol(symbolKey) {
  return String(symbolKey || "")
    .toUpperCase()
    .trim()
    .replace(/_UMCBL$/, "")
    .replace(/_DMCBL$/, "")
    .replace(/_CMCBL$/, "")
    .replace(/-UMCBL$/, "")
    .replace(/-DMCBL$/, "")
    .replace(/-CMCBL$/, "");
}

function normalizeBitgetKey(symbolKey) {
  return normalizeBitgetContractSymbol(symbolKey)
    .replace(/USDT$/, "")
    .replace(/USDC$/, "");
}

function normalizeBitgetProductType(productType, rawSymbol = "") {
  const p = String(productType || "").toUpperCase();
  const raw = String(rawSymbol || "").toUpperCase();

  if (
    p === "USDT-FUTURES" ||
    p === "COIN-FUTURES" ||
    p === "USDC-FUTURES"
  ) {
    return p;
  }

  if (raw.includes("_UMCBL") || raw.includes("-UMCBL") || raw.endsWith("USDT")) {
    return "USDT-FUTURES";
  }

  if (raw.includes("_DMCBL") || raw.includes("-DMCBL")) {
    return "COIN-FUTURES";
  }

  if (raw.includes("_CMCBL") || raw.includes("-CMCBL") || raw.endsWith("USDC")) {
    return "USDC-FUTURES";
  }

  return "USDT-FUTURES";
}

function buildTradableSymbolMap(futures) {
  const out = new Map();

  for (const [key, value] of futures instanceof Map ? futures.entries() : []) {
    const rawBitgetSymbol = String(
      value?.symbol ||
      value?.instId ||
      value?.tickerId ||
      key ||
      ""
    ).toUpperCase().trim();

    if (!rawBitgetSymbol) continue;

    const bitgetSymbol = normalizeBitgetContractSymbol(rawBitgetSymbol);
    const baseSymbol = normalizeBitgetKey(rawBitgetSymbol);
    const productType = normalizeBitgetProductType(value?.productType, rawBitgetSymbol);

    if (!bitgetSymbol || !baseSymbol) continue;

    const candidate = {
      baseSymbol,
      bitgetSymbol,
      productType,
      rawBitgetSymbol
    };

    const prev = out.get(baseSymbol);

    if (!prev) {
      out.set(baseSymbol, candidate);
      continue;
    }

    if (
      prev.productType !== "USDT-FUTURES" &&
      candidate.productType === "USDT-FUTURES"
    ) {
      out.set(baseSymbol, candidate);
    }
  }

  return out;
}

// ================= NORMALIZE COIN FROM COINGECKO =================
function normalize(raw) {
  const marketCap = Number(raw?.market_cap || 0);
  const totalVolume = Number(raw?.total_volume || 0);

  return {
    symbol: String(raw?.symbol || "").toUpperCase(),
    name: raw?.name || "",
    price: Number(raw?.current_price || 0),

    change24: Number(raw?.price_change_percentage_24h || 0),
    change1h: Number(raw?.price_change_percentage_1h_in_currency || 0),

    volume: totalVolume,
    marketCap,
    vm: marketCap > 0 ? totalVolume / marketCap : 0,

    ob: generateShallowOb()
  };
}

function buildCoinTimeframeMeta(coin) {
  try {
    const ctx = buildTimeframeContext(coin) || {};
    const score = Number.isFinite(Number(ctx?.score)) ? Number(ctx.score) : 0;

    return {
      tfContext: ctx,
      tfScore: score,
      tfStrength: Math.abs(score),
      tfAlignment: String(ctx?.alignment || "UNKNOWN")
    };
  } catch {
    return {
      tfContext: {},
      tfScore: 0,
      tfStrength: 0,
      tfAlignment: "UNKNOWN"
    };
  }
}

function enrichRunnerCoin(base, contractMeta, regime, side, adaptive) {
  const flow = detectRunnerFlow(base, side, adaptive);
  const score = calculateRunnerScore(base, regime, side, adaptive);
  const freshness = calculateRunnerFreshness(base, side);
  const edge = calculateEdge(base, regime) || 0;
  const directional = getDirectionalValues(base, side);

  const coin = {
    ...base,

    side,
    flow,
    scannerFlow: flow,
    freshness,

    // Belangrijk: moveScore blijft scanner-score voor funnel/tradesystem.
    moveScore: score,
    rawRunnerScore: score,

    edge,

    runnerProfile: SCANNER_PROFILE,
    scannerVersion: SCANNER_VERSION,

    runnerPressure: directional.pressure,
    runnerAcceleration: directional.acceleration,
    runnerAbsChange1h: directional.absCh1,
    runnerAbsChange24: directional.absCh24,
    runnerVm: directional.vm,

    symbolTradable: true,
    bitgetSymbol: contractMeta.bitgetSymbol,
    productType: contractMeta.productType,
    rawBitgetSymbol: contractMeta.rawBitgetSymbol
  };

  const tfMeta = buildCoinTimeframeMeta(coin);

  coin.tfContext = tfMeta.tfContext;
  coin.tfScore = tfMeta.tfScore;
  coin.tfStrength = tfMeta.tfStrength;
  coin.tfAlignment = tfMeta.tfAlignment;
  coin.entryType = classifyRunnerEntryType(coin);

  return coin;
}

// ================= FUNNEL HELPERS =================
function emptyFunnel() {
  return {
    bull: {
      entry: [],
      almost: [],
      buildup: [],
      radar: []
    },
    bear: {
      entry: [],
      almost: [],
      buildup: [],
      radar: []
    }
  };
}

function countSide(funnel, side) {
  if (!funnel?.[side]) return 0;

  let total = 0;

  for (const stage of STAGES) {
    total += Array.isArray(funnel[side][stage])
      ? funnel[side][stage].length
      : 0;
  }

  return total;
}

function countSideTradeSystemCandidates(funnel, side) {
  if (!funnel?.[side]) return 0;

  return (
    safeArray(funnel[side].entry).length +
    safeArray(funnel[side].almost).length
  );
}

function countFunnel(funnel) {
  return countSide(funnel, "bull") + countSide(funnel, "bear");
}

function countTradeSystemCandidates(funnel) {
  return (
    countSideTradeSystemCandidates(funnel, "bull") +
    countSideTradeSystemCandidates(funnel, "bear")
  );
}

function hasSymbolInSide(funnel, side, symbol) {
  for (const stage of STAGES) {
    const rows = funnel?.[side]?.[stage];

    if (Array.isArray(rows) && rows.some(c => c.symbol === symbol)) {
      return true;
    }
  }

  return false;
}

function sortFunnel(funnel) {
  for (const side of SIDES) {
    for (const stageKey of STAGES) {
      funnel[side][stageKey].sort((a, b) => {
        const stagePriority = Number(b.stage === "entry") - Number(a.stage === "entry");
        if (stagePriority !== 0) return stagePriority;

        const scoreDiff = Number(b.moveScore || 0) - Number(a.moveScore || 0);
        if (scoreDiff !== 0) return scoreDiff;

        return Number(b.freshness || 0) - Number(a.freshness || 0);
      });
    }
  }
}

// ================= DISCOVERY FALLBACK FILL =================
// Naam behouden zodat imports/calls stabiel blijven.
// Verschil: fallback is niet langer uiOnly, dus tradesystem krijgt hem ook.
function fillUiFallback({
  rawCoins,
  regime,
  funnel,
  side,
  tradableSymbolMap,
  max = 180,
  adaptive = {}
}) {
  const targetMinimum = adaptive.targetMinimum || 80;

  if (countSideTradeSystemCandidates(funnel, side) >= targetMinimum) return;

  const list = [];

  for (const raw of rawCoins) {
    const base = normalize(raw);

    if (!base.symbol || base.price <= 0) continue;

    const contractMeta = tradableSymbolMap.get(base.symbol);

    if (!contractMeta) continue;
    if (hasSymbolInSide(funnel, side, base.symbol)) continue;

    const vmFloor = Number(adaptive.vmMin || 0.003) * 0.35;

    if (base.vm < vmFloor) continue;
    if (!displayDirectionAllowed(base, side, adaptive)) continue;

    const coin = enrichRunnerCoin(base, contractMeta, regime, side, adaptive);

    if (!["SQUEEZE", "RUNNING", "BREAKOUT", "BUILDING", "NEUTRAL"].includes(coin.flow)) {
      continue;
    }

    if (coin.moveScore < Number(adaptive.minRunnerScore || 6)) {
      continue;
    }

    list.push({
      ...coin,
      stage: fallbackStage(coin.moveScore, coin.flow, coin.freshness, adaptive),
      stageSource: "runner_discovery_fallback",
      uiOnly: false,
      scannerQuality: "RUNNER_DISCOVERY_FALLBACK",
      scannerFlow: coin.flow
    });
  }

  list.sort((a, b) => {
    const scoreDiff = Number(b.moveScore || 0) - Number(a.moveScore || 0);
    if (scoreDiff !== 0) return scoreDiff;

    return Number(b.freshness || 0) - Number(a.freshness || 0);
  });

  let added = 0;

  for (const coin of list) {
    if (added >= max) break;
    if (countSideTradeSystemCandidates(funnel, side) >= targetMinimum) break;

    const stage = safeStage(coin.stage);

    funnel[side][stage].push({
      ...coin,
      stage,
      stageSource: "runner_discovery_fallback",
      uiOnly: false,
      scannerQuality: "RUNNER_DISCOVERY_FALLBACK",
      scannerFlow: coin.flow
    });

    added++;
  }
}

// ================= MERGE PARTIAL SIDE SCAN =================
async function mergeWithPreviousSideScan(currentPayload, scanSide) {
  if (scanSide === "both") return currentPayload;

  const previous = await getLatestScan();

  if (!previous?.ok) return currentPayload;

  const mergedFunnel = emptyFunnel();

  mergedFunnel[scanSide] =
    currentPayload.funnel?.[scanSide] ||
    mergedFunnel[scanSide];

  const otherSide = scanSide === "bull" ? "bear" : "bull";

  mergedFunnel[otherSide] =
    previous.funnel?.[otherSide] ||
    mergedFunnel[otherSide];

  const mergedAnalytics = {
    ...(previous.analytics || {}),
    [scanSide]: currentPayload.analytics?.[scanSide]
  };

  const mergedAdvice = {
    ...(previous.advice || {}),
    [scanSide]: currentPayload.advice?.[scanSide]
  };

  const candidatesBull =
    scanSide === "bull"
      ? currentPayload.candidatesBull
      : previous.candidatesBull || 0;

  const candidatesBear =
    scanSide === "bear"
      ? currentPayload.candidatesBear
      : previous.candidatesBear || 0;

  sortFunnel(mergedFunnel);

  return {
    ...previous,
    ...currentPayload,

    scannerProfile: SCANNER_PROFILE,
    scannerVersion: SCANNER_VERSION,

    funnel: mergedFunnel,
    funnelCount: countFunnel(mergedFunnel),
    bullCount: countSide(mergedFunnel, "bull"),
    bearCount: countSide(mergedFunnel, "bear"),

    tradeSystemCandidateCount: countTradeSystemCandidates(mergedFunnel),
    tradeSystemCandidateBull: countSideTradeSystemCandidates(mergedFunnel, "bull"),
    tradeSystemCandidateBear: countSideTradeSystemCandidates(mergedFunnel, "bear"),

    analytics: mergedAnalytics,
    advice: mergedAdvice,

    trades: safeArray(currentPayload.trades),

    dashboardStats:
      currentPayload.dashboardStats ||
      previous.dashboardStats ||
      emptyDashboardStats(Date.now()),

    tradeSystemAnalysis:
      currentPayload.tradeSystemAnalysis ||
      previous.tradeSystemAnalysis ||
      null,

    candidatesBull,
    candidatesBear,
    candidates: candidatesBull + candidatesBear,

    lastBullScan:
      scanSide === "bull"
        ? Date.now()
        : previous.lastBullScan || null,

    lastBearScan:
      scanSide === "bear"
        ? Date.now()
        : previous.lastBearScan || null,

    lastSideScan: scanSide,
    scanMode: "merged",
    updatedAt: Date.now()
  };
}

// ================= BITGET FAILURE HANDLER =================
async function handleBitgetUniverseUnavailable(scanSide) {
  const previous = await getLatestScan();

  if (previous?.ok) {
    return {
      ...previous,
      ok: true,
      stale: true,
      staleReason: "bitget_universe_unavailable",

      bitgetSymbols: 0,
      bitgetUniverseReady: false,

      scannerProfile: SCANNER_PROFILE,
      scannerVersion: SCANNER_VERSION,
      scanRequestedSide: scanSide,

      servedAt: Date.now()
    };
  }

  throw new Error("bitget_universe_unavailable");
}

// ================= BTC RUNNER STATE =================
function buildBtcState(rawCoins) {
  const btcRaw =
    rawCoins.find(c => String(c?.symbol || "").toUpperCase() === "BTC") ||
    rawCoins[0];

  const btcChange24 = Number(btcRaw?.price_change_percentage_24h || 0);
  const btcChange1h = Number(btcRaw?.price_change_percentage_1h_in_currency || 0);

  const pressure = (btcChange1h * 0.78) + (btcChange24 * 0.22);

  let state = "NEUTRAL";

  if (btcChange24 > 2.5 && btcChange1h > 0.45) state = "RUNNER_BULL";
  else if (btcChange24 < -2.5 && btcChange1h < -0.45) state = "RUNNER_BEAR";
  else if (btcChange1h > 0.25 || pressure > 0.45) state = "BULLISH";
  else if (btcChange1h < -0.25 || pressure < -0.45) state = "BEARISH";

  return {
    state,
    chg24: btcChange24,
    chg1h: btcChange1h,
    pressure
  };
}

function shouldSkipBaseCoin(base, adaptive = {}) {
  if (!base.symbol || base.price <= 0) return true;

  const vm = Number(base.vm || 0);
  const absChange24 = Math.abs(Number(base.change24 || 0));
  const absChange1h = Math.abs(Number(base.change1h || 0));

  const vmFloor = Number(adaptive.vmMin || 0.003) * 0.35;
  const min24 = Number(adaptive.hardChange24 || 0.05) * 0.35;
  const min1h = Number(adaptive.hardChange1h || 0.02) * 0.35;

  // Alleen echt dode coins skippen.
  return (
    vm < vmFloor &&
    absChange24 < min24 &&
    absChange1h < min1h
  );
}

// ================= CORE =================
export async function buildScanPayload(options = {}) {
  const scanSide = normalizeScanSide(options.side);
  const notify = options.notify !== false;
  const store = options.store !== false;

  initDefaultFilters(true);
  resetAnalytics();

  const previousLatest = await getLatestScan().catch(() => null);

  const rawCoins = await fetchCoinGeckoTopCached();

  if (!Array.isArray(rawCoins)) {
    throw new Error("coingecko_scan_failed");
  }

  const normalizedCoins = rawCoins
    .map(normalize)
    .filter(c => c.symbol && c.price > 0);

  let futures = new Map();

  try {
    futures = await fetchFuturesTickers();
  } catch (e) {
    console.error("BITGET FILTER ERROR:", e.message);
  }

  const tradableSymbolMap = buildTradableSymbolMap(futures);
  const validSymbols = new Set(tradableSymbolMap.keys());
  const bitgetUniverseReady = tradableSymbolMap.size > 0;

  if (!bitgetUniverseReady) {
    return await handleBitgetUniverseUnavailable(scanSide);
  }

  const btc = buildBtcState(rawCoins);
  const regime = detectRegime(rawCoins) || "NORMAL";

  // Belangrijk: classifyMarket moet genormaliseerde coins krijgen.
  const market = classifyMarket(normalizedCoins);
  const adaptive = getRunnerScannerConfig(regime, market);

  const funnel = emptyFunnel();

  let candidatesBull = 0;
  let candidatesBear = 0;

  let memory = await loadStageMemory();

  const activeSymbols = [];
  const sidesToScan = scanSide === "both" ? SIDES : [scanSide];

  for (const base of normalizedCoins) {
    if (shouldSkipBaseCoin(base, adaptive)) continue;

    const contractMeta = tradableSymbolMap.get(base.symbol);

    if (!contractMeta) continue;

    activeSymbols.push(base.symbol);

    for (const direction of sidesToScan) {
      if (!displayDirectionAllowed(base, direction, adaptive)) continue;

      const coin = enrichRunnerCoin(base, contractMeta, regime, direction, adaptive);
      const realFilterStage = getRunnerFilterStage(coin, adaptive);

      if (!realFilterStage) continue;

      const key = `${base.symbol}_${direction}`;
      const prev = memory[key] || { stage: "radar" };
      const newStage = safeStage(mergeStage(prev.stage, realFilterStage));

      coin.stage = newStage;
      coin.stageSource = "runner_filter_loose";
      coin.uiOnly = false;
      coin.scannerQuality = "RUNNER_FILTER_LOOSE";
      coin.scannerFlow = coin.flow;
      coin.entryType = classifyRunnerEntryType(coin);

      funnel[direction][newStage].push(coin);

      logAnalytics(coin);

      if (newStage === "entry") {
        if (direction === "bull") candidatesBull++;
        if (direction === "bear") candidatesBear++;
      }

      memory[key] = {
        stage: newStage,
        prevStage: prev.stage || "radar",
        entryType: coin.entryType,
        score: coin.moveScore,
        flow: coin.flow,
        scannerFlow: coin.scannerFlow,
        updatedAt: Date.now()
      };
    }
  }

  if (scanSide === "both" || scanSide === "bull") {
    fillUiFallback({
      rawCoins,
      regime,
      funnel,
      side: "bull",
      tradableSymbolMap,
      max: adaptive.fallbackMax,
      adaptive
    });
  }

  if (scanSide === "both" || scanSide === "bear") {
    fillUiFallback({
      rawCoins,
      regime,
      funnel,
      side: "bear",
      tradableSymbolMap,
      max: adaptive.fallbackMax,
      adaptive
    });
  }

  memory = cleanMemory(memory, activeSymbols);

  if (store) {
    await saveStageMemory(memory);
  }

  sortFunnel(funnel);

  const analytics = getAnalytics();
  const advice = generateAdvice(analytics);
  const now = Date.now();

  const tradeSystemCandidateBull = countSideTradeSystemCandidates(funnel, "bull");
  const tradeSystemCandidateBear = countSideTradeSystemCandidates(funnel, "bear");
  const tradeSystemCandidateCount = tradeSystemCandidateBull + tradeSystemCandidateBear;

  const currentPayload = {
    ok: true,

    scannerProfile: SCANNER_PROFILE,
    scannerVersion: SCANNER_VERSION,

    scanSide,
    scanMode: scanSide,

    notify,
    store,

    btc,
    regime,
    market,
    adaptive,

    funnel,

    funnelCount: countFunnel(funnel),
    bullCount: countSide(funnel, "bull"),
    bearCount: countSide(funnel, "bear"),

    // Entry-only legacy count.
    candidates: candidatesBull + candidatesBear,
    candidatesBull,
    candidatesBear,

    // Nieuwe nuttige count: dit is wat tradesystem kan analyseren als hij entry+almost pakt.
    tradeSystemCandidateCount,
    tradeSystemCandidateBull,
    tradeSystemCandidateBear,

    trades: safeArray(previousLatest?.trades),

    dashboardStats: normalizeDashboardStats(previousLatest?.dashboardStats, now),
    tradeSystemAnalysis: previousLatest?.tradeSystemAnalysis || null,

    analytics,
    advice,

    total: rawCoins.length,
    normalizedTotal: normalizedCoins.length,

    bitgetSymbols: validSymbols.size,
    bitgetUniverseReady: true,

    scannerUpdatedAt: now,
    tradeFunnelUpdatedAt: previousLatest?.tradeFunnelUpdatedAt || null,
    updatedAt: now,

    lastBullScan:
      scanSide === "bull" || scanSide === "both"
        ? now
        : previousLatest?.lastBullScan || null,

    lastBearScan:
      scanSide === "bear" || scanSide === "both"
        ? now
        : previousLatest?.lastBearScan || null
  };

  const finalPayload = await mergeWithPreviousSideScan(currentPayload, scanSide);

  if (store) {
    await setLatestScan(finalPayload);
  }

  return finalPayload;
}

// ================= VERCEL HANDLER =================
export default async function handler(req, res) {
  try {
    const side = normalizeScanSide(req?.query?.side);
    const notify = normalizeNotify(req?.query?.notify);

    // Scanner endpoint moet standaard opslaan.
    // Anders krijgt trade-funnel weer: no_latest_scan_available.
    const store = normalizeStore(req?.query?.store, true);

    const data = await buildScanPayload({
      side,
      notify,
      store
    });

    return res.status(200).json(data);
  } catch (e) {
    console.error("RUNNER SCAN ERROR:", e);

    return res.status(500).json({
      ok: false,
      error: e?.message || "runner_scan_error",
      scannerProfile: SCANNER_PROFILE,
      scannerVersion: SCANNER_VERSION
    });
  }
}