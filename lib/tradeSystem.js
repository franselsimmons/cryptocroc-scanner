// lib/tradeSystem.js
// RUNNER TRADE SYSTEM
// Doel:
// - Momentum/continuation entries
// - Runner lifecycle: ENTRY -> PARTIAL_TP -> MOVE_BE -> TRAIL -> EXIT
// - Compatible met bestaande API/trade-funnel
// - Compatible met bestaande Discord notifier: sendEntry/sendExit
// - Vercel/Upstash runtime persistence

import { analyzeFlow } from "./flowEngine.js";
import { getSniperEntry } from "./sniperEntry.js";

import {
  fetchOrderBook,
  analyzeOrderBookAdvanced
} from "./orderbook.js";

import { calculateRisk } from "./riskManager.js";
import { logTrade, logSystemEvent } from "./logger.js";

import {
  getVolatility,
  getVolatilityRegime
} from "./volatility.js";

import { getMarketContext } from "./marketContext.js";

import {
  buildTimeframeContext,
  multiTFScore
} from "./timeframe.js";

import { getLiquidityZones } from "./liquidityEngine.js";
import { getLiquidationZones } from "./liquidationEngine.js";
import { calculateConfluence } from "./confluenceEngine.js";
import { fetchFunding } from "./funding.js";

import {
  getMTFRSI,
  getRSISignal
} from "./rsiEngine.js";

import {
  getRsiRunnerBias,
  isRsiContinuationAllowed,
  isRsiPullbackEntry,
  isRsiExhaustedAgainstSide
} from "./rsiFilter.js";

import {
  sendEntry,
  sendExit
} from "./discordNotifier.js";

import { updateOrderbookMemory } from "./orderbookMemory.js";

import {
  chooseStrategy,
  getStrategyRiskProfile
} from "./strategy.js";

import {
  getStructureState,
  isStructureAligned
} from "./structureEngine.js";

// ================= VERSION =================
const STRATEGY_VERSION = "RUNNER_TS_V1_0";

// ================= CACHE =================
const apiCache = new Map();

async function cachedFetch(key, fn, ttl = 30000) {
  const cached = apiCache.get(key);

  if (cached && Date.now() - cached.ts < ttl) {
    return cached.data;
  }

  const data = await fn();

  apiCache.set(key, {
    ts: Date.now(),
    data
  });

  return data;
}

// ================= CONSTANTS =================
const COOLDOWN_MS = 25 * 60 * 1000;
const SYMBOL_REENTRY_COOLDOWN_MS = 45 * 60 * 1000;

const DURABLE_LOCK_TTL_MS = 90 * 1000;
const DURABLE_LOCK_ATTEMPTS = 8;
const DURABLE_LOCK_RETRY_MS = 400;

const MAX_SPREAD_PCT = 0.0024;
const SQUEEZE_MAX_SPREAD_PCT = 0.0032;
const MIN_DEPTH_USD_1P = 120000;
const SQUEEZE_MIN_DEPTH_USD_1P = 80000;

const MIN_SCORE = 58;
const MIN_TF_STRENGTH = 1;
const MIN_CONFLUENCE = 64;
const MIN_SNIPER_SCORE = 60;

const RUNNER_A_MIN_CONFLUENCE = 74;
const RUNNER_A_MIN_SNIPER = 72;
const RUNNER_A_MIN_RR = 1.20;

const RUNNER_B_MIN_CONFLUENCE = 68;
const RUNNER_B_MIN_SNIPER = 64;
const RUNNER_B_MIN_RR = 1.12;

const RUNNER_C_MIN_CONFLUENCE = 78;
const RUNNER_C_MIN_SNIPER = 70;
const RUNNER_C_MIN_RR = 1.25;

const RUNNER_A_TARGET_R = 1.80;
const RUNNER_B_TARGET_R = 1.55;
const RUNNER_C_TARGET_R = 2.20;

const PARTIAL_TP_R = 0.85;
const PARTIAL_SIZE = 0.50;

const BREAK_EVEN_TRIGGER_R = 0.70;
const BREAK_EVEN_LOCK_R = 0.04;

const TRAIL_START_R = 1.15;
const TRAIL_DISTANCE_R = 0.55;

const MAX_ADDS = 1;
const ADD_MIN_R = 0.65;
const ADD_MIN_CONFLUENCE = 78;
const ADD_MIN_SNIPER = 74;

const MAX_FEATURE_ROWS = 2000;

const RUNTIME_STORE_KEY = `runnerTradeSystem:runtime:${STRATEGY_VERSION}`;
const RUNTIME_LOCK_KEY = `runnerTradeSystem:runtime-lock:${STRATEGY_VERSION}`;

const DEFAULT_OB = {
  mid: 0,
  spreadPct: 0.05,
  depthMinUsd1p: 0,
  bias: "NEUTRAL",
  spoof: false,
  marketQuality: "BAD",
  qualityScore: 0,
  fetchFailed: true
};

const RUNNER_FLOWS = new Set([
  "SQUEEZE",
  "RUNNING",
  "BREAKOUT",
  "BUILDING",
  "TREND"
]);

const HOT_RUNNER_FLOWS = new Set([
  "SQUEEZE",
  "RUNNING",
  "BREAKOUT"
]);

// ================= RUNTIME STATE =================
function createRuntimeState() {
  return {
    strategyVersion: STRATEGY_VERSION,

    memory: new Map(),
    cooldownMap: new Map(),
    symbolCooldownMap: new Map(),
    notifyState: new Map(),
    processingLocks: new Set(),

    stats: {
      startedAt: Date.now(),
      runs: 0,
      entries: 0,
      partials: 0,
      movesToBE: 0,
      trails: 0,
      exits: 0,
      wins: 0,
      losses: 0,
      waitReasons: {},
      entryTypes: {},
      closedTrades: [],
      featureRows: []
    },

    durableLoadedAt: 0,
    durableSavedAt: 0
  };
}

const globalKey = "__RUNNER_TRADE_SYSTEM_RUNTIME__";
const runtimeState = globalThis[globalKey] || createRuntimeState();

if (runtimeState.strategyVersion !== STRATEGY_VERSION) {
  const fresh = createRuntimeState();

  runtimeState.strategyVersion = fresh.strategyVersion;
  runtimeState.memory = fresh.memory;
  runtimeState.cooldownMap = fresh.cooldownMap;
  runtimeState.symbolCooldownMap = fresh.symbolCooldownMap;
  runtimeState.notifyState = fresh.notifyState;
  runtimeState.processingLocks = fresh.processingLocks;
  runtimeState.stats = fresh.stats;
  runtimeState.durableLoadedAt = 0;
  runtimeState.durableSavedAt = 0;
}

globalThis[globalKey] = runtimeState;

const memory = runtimeState.memory;
const cooldownMap = runtimeState.cooldownMap;
const symbolCooldownMap = runtimeState.symbolCooldownMap;
const notifyState = runtimeState.notifyState;
const processingLocks = runtimeState.processingLocks;
const stats = runtimeState.stats;

// ================= REDIS / KV =================
function getRedisUrl() {
  return (
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    ""
  );
}

function getRedisToken() {
  return (
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    ""
  );
}

function hasRedis() {
  return Boolean(getRedisUrl() && getRedisToken());
}

async function redisCommand(command) {
  const url = getRedisUrl();
  const token = getRedisToken();

  if (!url || !token) {
    throw new Error("redis_env_missing");
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  const json = await res.json().catch(() => null);

  if (!res.ok || json?.error) {
    throw new Error(json?.error || `redis_error_${res.status}`);
  }

  return json?.result;
}

function replaceMap(target, entries) {
  target.clear();

  if (!Array.isArray(entries)) return;

  for (const item of entries) {
    if (!Array.isArray(item) || item.length < 2) continue;
    target.set(item[0], item[1]);
  }
}

function trimStats() {
  if (!Array.isArray(stats.closedTrades)) stats.closedTrades = [];
  if (!Array.isArray(stats.featureRows)) stats.featureRows = [];

  stats.closedTrades = stats.closedTrades.slice(-500);
  stats.featureRows = stats.featureRows.slice(-MAX_FEATURE_ROWS);

  stats.waitReasons = stats.waitReasons || {};
  stats.entryTypes = stats.entryTypes || {};
}

function serializeRuntimeState() {
  trimStats();

  return {
    strategyVersion: STRATEGY_VERSION,
    updatedAt: Date.now(),

    memory: Array.from(memory.entries()),
    cooldownMap: Array.from(cooldownMap.entries()),
    symbolCooldownMap: Array.from(symbolCooldownMap.entries()),
    notifyState: Array.from(notifyState.entries()),

    stats
  };
}

function hydrateRuntimeState(payload) {
  if (!payload || payload.strategyVersion !== STRATEGY_VERSION) {
    return false;
  }

  replaceMap(memory, payload.memory);
  replaceMap(cooldownMap, payload.cooldownMap);
  replaceMap(symbolCooldownMap, payload.symbolCooldownMap);
  replaceMap(notifyState, payload.notifyState);

  Object.assign(stats, createRuntimeState().stats, payload.stats || {});
  trimStats();

  runtimeState.durableLoadedAt = Date.now();

  return true;
}

async function loadDurableRuntimeState() {
  if (!hasRedis()) return false;

  try {
    const result = await redisCommand(["GET", RUNTIME_STORE_KEY]);
    if (!result) return false;

    const parsed = typeof result === "string"
      ? JSON.parse(result)
      : result;

    return hydrateRuntimeState(parsed);
  } catch (e) {
    console.error("RUNNER RUNTIME LOAD ERROR:", e?.message || e);
    return false;
  }
}

async function saveDurableRuntimeState() {
  if (!hasRedis()) return false;

  try {
    await redisCommand([
      "SET",
      RUNTIME_STORE_KEY,
      JSON.stringify(serializeRuntimeState())
    ]);

    runtimeState.durableSavedAt = Date.now();
    return true;
  } catch (e) {
    console.error("RUNNER RUNTIME SAVE ERROR:", e?.message || e);
    return false;
  }
}

async function acquireRuntimeLock(owner) {
  if (!hasRedis()) return false;

  for (let attempt = 0; attempt < DURABLE_LOCK_ATTEMPTS; attempt++) {
    try {
      const result = await redisCommand([
        "SET",
        RUNTIME_LOCK_KEY,
        owner,
        "NX",
        "PX",
        DURABLE_LOCK_TTL_MS
      ]);

      if (result === "OK") return true;
    } catch (e) {
      console.warn("RUNNER LOCK ERROR:", e?.message || e);
    }

    await sleep(DURABLE_LOCK_RETRY_MS);
  }

  return false;
}

async function releaseRuntimeLock(owner) {
  if (!hasRedis()) return false;

  try {
    const current = await redisCommand(["GET", RUNTIME_LOCK_KEY]);

    if (current === owner) {
      await redisCommand(["DEL", RUNTIME_LOCK_KEY]);
      return true;
    }

    return false;
  } catch (e) {
    console.warn("RUNNER LOCK RELEASE ERROR:", e?.message || e);
    return false;
  }
}

// ================= HELPERS =================
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

function normalizeBaseSymbol(raw) {
  return String(raw || "")
    .toUpperCase()
    .trim()
    .replace(/_UMCBL$/, "")
    .replace(/_DMCBL$/, "")
    .replace(/_CMCBL$/, "")
    .replace(/-UMCBL$/, "")
    .replace(/-DMCBL$/, "")
    .replace(/-CMCBL$/, "")
    .replace(/USDT$/, "")
    .replace(/USDC$/, "");
}

function normalizeBitgetSymbol(raw) {
  let clean = String(raw || "")
    .toUpperCase()
    .trim()
    .replace(/_UMCBL$/, "")
    .replace(/_DMCBL$/, "")
    .replace(/_CMCBL$/, "")
    .replace(/-UMCBL$/, "")
    .replace(/-DMCBL$/, "")
    .replace(/-CMCBL$/, "");

  if (!clean) return "";

  if (!clean.endsWith("USDT") && !clean.endsWith("USDC")) {
    clean = `${clean}USDT`;
  }

  return clean;
}

function normalizeSide(side) {
  return String(side || "").toLowerCase() === "bear" ? "bear" : "bull";
}

function normalizeFlow(flow) {
  return String(flow || "NEUTRAL").toUpperCase();
}

function normalizeSpread(spreadPct) {
  let s = safeNumber(spreadPct, 0.001);

  if (s < 0) return 0.001;
  if (s > 0.05) s = s / 100;

  return s;
}

function formatRR(value) {
  const n = safeNumber(value, 0);
  return n.toFixed(2);
}

function stageRank(stage) {
  const s = String(stage || "").toLowerCase();

  if (s === "entry") return 3;
  if (s === "almost") return 2;
  if (s === "buildup") return 1;

  return 0;
}

function incrementCounter(map, key) {
  const k = String(key || "UNKNOWN").toUpperCase();
  map[k] = safeNumber(map[k], 0) + 1;
}

function cleanExpiredGuards() {
  const now = Date.now();

  for (const [key, until] of cooldownMap.entries()) {
    if (now >= safeNumber(until, 0)) cooldownMap.delete(key);
  }

  for (const [key, until] of symbolCooldownMap.entries()) {
    if (now >= safeNumber(until, 0)) symbolCooldownMap.delete(key);
  }
}

function hasAnyOpenPositionForSymbol(symbol) {
  const base = normalizeBaseSymbol(symbol);

  for (const key of memory.keys()) {
    if (String(key).startsWith(`${base}_`)) return true;
  }

  return false;
}

function getOpenPositionSideForSymbol(symbol) {
  const base = normalizeBaseSymbol(symbol);

  for (const key of memory.keys()) {
    if (String(key).startsWith(`${base}_`)) {
      return String(key).split("_")[1] || "unknown";
    }
  }

  return null;
}

function getDirectionalPressure(c) {
  if (Number.isFinite(Number(c?.runnerPressure))) {
    return Number(c.runnerPressure);
  }

  const side = normalizeSide(c?.side);
  const dir = side === "bear" ? -1 : 1;

  const ch1 = safeNumber(c?.change1h, 0) * dir;
  const ch24 = safeNumber(c?.change24, 0) * dir;

  return (ch1 * 0.78) + (ch24 * 0.22);
}

function getRunnerAcceleration(c) {
  if (Number.isFinite(Number(c?.runnerAcceleration))) {
    return Number(c.runnerAcceleration);
  }

  const side = normalizeSide(c?.side);
  const dir = side === "bear" ? -1 : 1;

  const ch1 = safeNumber(c?.change1h, 0) * dir;
  const ch24 = safeNumber(c?.change24, 0) * dir;

  return ch1 - (ch24 / 24);
}

function getRsiZone(rsiSignal) {
  const rsi = safeNumber(rsiSignal?.rsi, 50);
  const zones = rsiSignal?.zones;

  if (!zones) return "MID";

  if (rsi >= zones.U3) return "UPPER_3";
  if (rsi >= zones.U2) return "UPPER_2";
  if (rsi >= zones.U1) return "UPPER_1";

  if (rsi <= zones.L3) return "LOWER_3";
  if (rsi <= zones.L2) return "LOWER_2";
  if (rsi <= zones.L1) return "LOWER_1";

  return "MID";
}

function getRegimeForConfluence(regime, scannerRegime) {
  const raw = String(regime?.level || regime || scannerRegime || "NORMAL").toUpperCase();

  if (raw === "HIGH_VOL" || raw === "HIGH") return "HIGH";
  if (raw === "LOW_VOL" || raw === "LOW") return "LOW";

  return "MEDIUM";
}

function isObWithSide(ob, side) {
  const s = normalizeSide(side);

  return (
    (s === "bull" && ob?.bias === "BULLISH") ||
    (s === "bear" && ob?.bias === "BEARISH")
  );
}

function isObAgainstSide(ob, side) {
  const s = normalizeSide(side);

  return (
    (s === "bull" && ob?.bias === "BEARISH") ||
    (s === "bear" && ob?.bias === "BULLISH")
  );
}

function getTimeframeMeta(c) {
  let ctx = {};
  let tfScore = 0;

  try {
    ctx = buildTimeframeContext(c) || {};
  } catch {
    ctx = {};
  }

  if (Number.isFinite(Number(ctx?.score))) {
    tfScore = Number(ctx.score);
  } else if (Number.isFinite(Number(c?.tfScore))) {
    tfScore = Number(c.tfScore);
  } else {
    tfScore = Number(multiTFScore(c) || 0);
  }

  return {
    ctx,
    tfScore,
    tfStrength: Math.abs(tfScore),
    tfAlignment: String(ctx?.alignment || c?.tfAlignment || "UNKNOWN")
  };
}

function getActionPriority(action) {
  const a = String(action?.action || "").toUpperCase();

  if (a === "EXIT") return 900;
  if (a === "ENTRY") return 800;
  if (a === "PARTIAL_TP") return 700;
  if (a === "MOVE_BE") return 650;
  if (a === "TRAIL") return 600;
  if (a === "ADD") return 550;
  if (a === "HOLD") return 300;
  if (a === "WAIT") return 100;

  return 0;
}

function sortActions(actions) {
  return [...actions].sort((a, b) => {
    const p = getActionPriority(b) - getActionPriority(a);
    if (p !== 0) return p;

    const c = safeNumber(b.confluence, 0) - safeNumber(a.confluence, 0);
    if (c !== 0) return c;

    return safeNumber(b.score, 0) - safeNumber(a.score, 0);
  });
}

function recordFeatureRow(row) {
  if (!row) return;

  stats.featureRows.push({
    ...row,
    strategyVersion: STRATEGY_VERSION,
    ts: Date.now()
  });

  if (stats.featureRows.length > MAX_FEATURE_ROWS) {
    stats.featureRows = stats.featureRows.slice(-MAX_FEATURE_ROWS);
  }
}

// ================= FETCH CANDLES =================
async function fetchCandles(symbol, timeframe = "15m", limit = 100) {
  const clean = normalizeBitgetSymbol(symbol);

  if (!clean) return [];

  const tfMap = {
    "5m": "5m",
    "15m": "15m",
    "1h": "1H",
    "4h": "4H"
  };

  const granularity = tfMap[timeframe] || "15m";

  const url =
    `https://api.bitget.com/api/v2/mix/market/candles?symbol=${encodeURIComponent(clean)}&productType=USDT-FUTURES&granularity=${granularity}&limit=${limit}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          accept: "application/json"
        }
      });

      if (!res.ok) {
        await sleep(150);
        continue;
      }

      const json = await res.json().catch(() => null);

      if (!Array.isArray(json?.data)) return [];

      return json.data
        .map(c => ({
          openTime: safeNumber(c[0]),
          open: safeNumber(c[1]),
          high: safeNumber(c[2]),
          low: safeNumber(c[3]),
          close: safeNumber(c[4]),
          volume: safeNumber(c[5])
        }))
        .filter(c =>
          c.openTime > 0 &&
          c.open > 0 &&
          c.high > 0 &&
          c.low > 0 &&
          c.close > 0
        )
        .sort((a, b) => a.openTime - b.openTime);
    } catch {
      await sleep(150);
    }
  }

  return [];
}

// ================= CANDIDATES =================
function createPrefilterStats(rawCount) {
  return {
    rawCount,
    acceptedCount: 0,
    openPositionsInjected: 0,
    removed: {
      MISSING: 0,
      UI_ONLY: 0,
      STAGE: 0,
      SCORE: 0,
      SIDE: 0
    }
  };
}

function pushPrefilterReject(prefilter, reason) {
  prefilter.removed[reason] = safeNumber(prefilter.removed[reason], 0) + 1;
}

function dedupeCandidates(list) {
  const map = new Map();

  for (const raw of Array.isArray(list) ? list : []) {
    const symbol = normalizeBaseSymbol(raw?.symbol);
    const side = normalizeSide(raw?.side);

    if (!symbol) continue;

    const stage = String(raw?.stage || "radar").toLowerCase();

    const normalized = {
      ...raw,
      symbol,
      side,
      stage,
      moveScore: safeNumber(raw?.moveScore ?? raw?.score, 0)
    };

    const key = `${symbol}_${side}`;
    const prev = map.get(key);

    if (!prev) {
      map.set(key, normalized);
      continue;
    }

    const stageDiff = stageRank(normalized.stage) - stageRank(prev.stage);

    if (stageDiff > 0) {
      map.set(key, normalized);
      continue;
    }

    if (stageDiff === 0 && safeNumber(normalized.moveScore, 0) > safeNumber(prev.moveScore, 0)) {
      map.set(key, normalized);
    }
  }

  return Array.from(map.values())
    .sort((a, b) => safeNumber(b.moveScore, 0) - safeNumber(a.moveScore, 0));
}

function buildTradeCandidates(input) {
  const raw = Array.isArray(input) ? input : [];

  const prefilter = createPrefilterStats(raw.length);
  const accepted = [];

  for (const c of raw) {
    if (!c?.symbol) {
      pushPrefilterReject(prefilter, "MISSING");
      continue;
    }

    const side = String(c?.side || "").toLowerCase();
    if (side !== "bull" && side !== "bear") {
      pushPrefilterReject(prefilter, "SIDE");
      continue;
    }

    if (Boolean(c?.uiOnly)) {
      pushPrefilterReject(prefilter, "UI_ONLY");
      continue;
    }

    const stage = String(c?.stage || "").toLowerCase();

    if (stage !== "entry" && stage !== "almost") {
      pushPrefilterReject(prefilter, "STAGE");
      continue;
    }

    const score = safeNumber(c?.moveScore ?? c?.score, 0);

    if (score < MIN_SCORE) {
      pushPrefilterReject(prefilter, "SCORE");
      continue;
    }

    accepted.push(c);
  }

  const map = new Map();

  for (const c of dedupeCandidates(accepted)) {
    const key = `${normalizeBaseSymbol(c.symbol)}_${normalizeSide(c.side)}`;

    map.set(key, {
      ...c,
      analysisType: "DEEP",
      fromOpenPosition: false
    });
  }

  for (const [key, pos] of memory.entries()) {
    if (map.has(key)) continue;

    prefilter.openPositionsInjected++;

    map.set(key, {
      symbol: pos.symbol,
      side: pos.side,
      stage: "entry",
      scannerStage: "open_position",
      stageSource: "memory",
      uiOnly: false,
      moveScore: safeNumber(pos.score, 100),
      price: pos.lastPrice || pos.entry,
      rawBitgetSymbol: pos.rawBitgetSymbol || pos.symbol,
      analysisType: "POSITION",
      fromOpenPosition: true
    });
  }

  const candidates = Array.from(map.values()).sort((a, b) => {
    if (a.fromOpenPosition !== b.fromOpenPosition) {
      return a.fromOpenPosition ? -1 : 1;
    }

    return safeNumber(b.moveScore, 0) - safeNumber(a.moveScore, 0);
  });

  prefilter.acceptedCount = accepted.length;

  console.log("RUNNER_TS_PREFILTER", JSON.stringify({
    ...prefilter,
    finalCandidates: candidates.length
  }));

  return {
    candidates,
    prefilter
  };
}

// ================= FLOW =================
function classifyRunnerFlow(c, analyzedFlow) {
  const existing = normalizeFlow(c?.flow);

  if (RUNNER_FLOWS.has(existing)) {
    return {
      type: existing,
      strength: HOT_RUNNER_FLOWS.has(existing) ? "HIGH" : "MID"
    };
  }

  const pressure = getDirectionalPressure(c);
  const acceleration = getRunnerAcceleration(c);
  const score = safeNumber(c?.moveScore, 0);
  const vm = safeNumber(c?.vm, 0);
  const ch1Abs = Math.abs(safeNumber(c?.change1h, 0));
  const ch24Abs = Math.abs(safeNumber(c?.change24, 0));

  if (
    pressure >= 1.15 &&
    acceleration >= 0.25 &&
    score >= 78 &&
    ch1Abs >= 0.8
  ) {
    return {
      type: "RUNNING",
      strength: "HIGH"
    };
  }

  if (
    pressure >= 0.45 &&
    acceleration >= 0 &&
    score >= 70 &&
    ch24Abs >= 2.5
  ) {
    return {
      type: "BREAKOUT",
      strength: "MID"
    };
  }

  if (
    pressure >= 0.25 &&
    acceleration >= -0.20 &&
    vm >= 0.06 &&
    score >= 68
  ) {
    return {
      type: "BUILDING",
      strength: "MID"
    };
  }

  if (analyzedFlow?.type === "TREND") {
    return {
      type: "TREND",
      strength: analyzedFlow?.strength || "MID"
    };
  }

  return {
    type: analyzedFlow?.type || "NEUTRAL",
    strength: analyzedFlow?.strength || "LOW"
  };
}

// ================= RR / RISK =================
function calculateRRFromPrices(entry, sl, tp, side) {
  const e = safeNumber(entry, 0);
  const s = safeNumber(sl, 0);
  const t = safeNumber(tp, 0);

  if (!e || !s || !t) return 0;

  const risk = Math.abs(e - s);
  if (!risk) return 0;

  const reward = normalizeSide(side) === "bear"
    ? e - t
    : t - e;

  if (reward <= 0) return 0;

  return reward / risk;
}

function priceAtR(entry, sl, side, rMultiple) {
  const e = safeNumber(entry, 0);
  const s = safeNumber(sl, 0);

  if (!e || !s) return 0;

  const risk = Math.abs(e - s);
  const r = safeNumber(rMultiple, 0);

  return normalizeSide(side) === "bear"
    ? e - risk * r
    : e + risk * r;
}

function buildRunnerTargets({ entry, sl, side, targetR }) {
  return {
    tp: priceAtR(entry, sl, side, targetR),
    partialTp: priceAtR(entry, sl, side, PARTIAL_TP_R),
    breakevenAt: priceAtR(entry, sl, side, BREAK_EVEN_TRIGGER_R),
    trailStart: priceAtR(entry, sl, side, TRAIL_START_R)
  };
}

function getTargetR(entryType) {
  const type = String(entryType || "").toUpperCase();

  if (type === "RUNNER_C_SQUEEZE") return RUNNER_C_TARGET_R;
  if (type === "RUNNER_A_BREAKOUT") return RUNNER_A_TARGET_R;
  if (type === "RUNNER_B_CONTINUATION") return RUNNER_B_TARGET_R;

  return RUNNER_B_TARGET_R;
}

function getDynamicRrFloor({ flow, volatility, entryType }) {
  const f = normalizeFlow(flow);
  const v = String(volatility || "MEDIUM").toUpperCase();
  const type = String(entryType || "").toUpperCase();

  let floor = RUNNER_B_MIN_RR;

  if (type === "RUNNER_A_BREAKOUT") floor = RUNNER_A_MIN_RR;
  if (type === "RUNNER_C_SQUEEZE") floor = RUNNER_C_MIN_RR;

  if (f === "SQUEEZE") floor = Math.max(floor, 1.22);
  if (f === "RUNNING") floor = Math.max(floor, 1.15);
  if (f === "BUILDING") floor = Math.max(floor, 1.20);

  if (v === "LOW") floor += 0.08;
  if (v === "HIGH") floor -= 0.04;

  return clamp(floor, 1.05, 1.45);
}

// ================= COMMON PAYLOAD =================
function buildCommonPayload(c, ctx = {}) {
  const ob = ctx.ob || {};
  const funding = ctx.funding || {};
  const sniper = ctx.sniper || {};
  const flow = ctx.flow || {};

  return {
    profile: "RUNNER",
    strategyVersion: STRATEGY_VERSION,

    symbol: normalizeBaseSymbol(c?.symbol),
    side: normalizeSide(c?.side),

    stage: String(c?.stage || "unknown").toLowerCase(),
    scannerStage: c?.scannerStage || c?.stage || "unknown",
    stageSource: c?.stageSource || "unknown",
    uiOnly: Boolean(c?.uiOnly),

    price: safeNumber(c?.price, 0),
    score: safeNumber(c?.moveScore ?? c?.score, 0),

    flow: flow?.type || c?.flow || "NEUTRAL",
    flowStrength: flow?.strength || "UNKNOWN",

    runnerPressure: safeNumber(c?.runnerPressure ?? getDirectionalPressure(c), 0),
    runnerAcceleration: safeNumber(c?.runnerAcceleration ?? getRunnerAcceleration(c), 0),

    confluence: safeNumber(ctx.confluence, 0),

    sniper: sniper?.type || "NONE",
    sniperScore: safeNumber(sniper?.score ?? sniper?.runnerScore, 0),
    entryType: sniper?.entryType || sniper?.runnerEntryType || null,

    funding: safeNumber(funding?.rate, 0),

    obBias: ob?.bias || "NEUTRAL",
    spreadPct: ob?.spreadPct ?? null,
    depthMinUsd1p: ob?.depthMinUsd1p ?? null,
    marketQuality: ob?.marketQuality || "UNKNOWN",
    obQualityScore: safeNumber(ob?.qualityScore, 0),

    tfScore: safeNumber(c?.tfScore, 0),
    tfStrength: safeNumber(c?.tfStrength, 0),
    tfAlignment: c?.tfAlignment || "UNKNOWN",

    rsi: ctx.rsi ?? null,
    rsiZone: ctx.rsiZone || null,
    rsiContinuationScore: safeNumber(ctx.rsiContinuationScore, 0),

    volatility: ctx.volatility || null,
    regime: ctx.regime || null,
    btcState: ctx.btcState || null,

    structure: ctx.structure || null,

    fromOpenPosition: Boolean(c?.fromOpenPosition),
    analysisType: c?.analysisType || "DEEP",

    ts: Date.now()
  };
}

function buildWait(c, reason, ctx = {}) {
  incrementCounter(stats.waitReasons, reason);

  const payload = {
    ...buildCommonPayload(c, ctx),
    action: "WAIT",
    reason,

    rr: formatRR(ctx.rr),
    requiredRR: ctx.requiredRR ?? null,

    entry: ctx.risk?.entry ?? c?.price ?? null,
    sl: ctx.risk?.sl ?? null,
    tp: ctx.risk?.tp ?? null,

    requiredConfluence: ctx.requiredConfluence ?? null,
    requiredSniper: ctx.requiredSniper ?? null
  };

  recordFeatureRow(payload);

  return payload;
}

async function logSystem(payload, shouldLog = true) {
  if (!shouldLog || !payload) return;

  await logSystemEvent(payload);
}

// ================= POSITION METRICS =================
function getInitialRisk(pos) {
  const entry = safeNumber(pos?.entry, 0);
  const sl = safeNumber(pos?.initialSl || pos?.sl, 0);

  if (!entry || !sl) return 0;

  return Math.abs(entry - sl);
}

function calculateR(pos, price) {
  const entry = safeNumber(pos?.entry, 0);
  const current = safeNumber(price, 0);
  const risk = getInitialRisk(pos);

  if (!entry || !current || !risk) return 0;

  const move = normalizeSide(pos?.side) === "bear"
    ? entry - current
    : current - entry;

  return move / risk;
}

function calculatePnlPct(pos, price) {
  const entry = safeNumber(pos?.entry, 0);
  const current = safeNumber(price, 0);

  if (!entry || !current) return 0;

  const pnl = normalizeSide(pos?.side) === "bear"
    ? ((entry - current) / entry) * 100
    : ((current - entry) / entry) * 100;

  return Number.isFinite(pnl) ? pnl : 0;
}

function updatePositionMetrics(pos, price) {
  const current = safeNumber(price, 0);
  if (!pos || !current) return pos;

  const currentR = calculateR(pos, current);
  const side = normalizeSide(pos.side);

  pos.lastPrice = current;
  pos.currentR = Number(currentR.toFixed(4));
  pos.ticksObserved = safeNumber(pos.ticksObserved, 0) + 1;

  if (!Number.isFinite(Number(pos.mfeR))) pos.mfeR = 0;
  if (!Number.isFinite(Number(pos.maeR))) pos.maeR = 0;

  if (currentR > pos.mfeR) {
    pos.mfeR = Number(currentR.toFixed(4));
    pos.mfePrice = current;
    pos.mfeAt = Date.now();
  }

  if (currentR < pos.maeR) {
    pos.maeR = Number(currentR.toFixed(4));
    pos.maePrice = current;
    pos.maeAt = Date.now();
  }

  if (side === "bull") {
    pos.highestPrice = Math.max(safeNumber(pos.highestPrice, pos.entry), current);
    pos.lowestPrice = Math.min(safeNumber(pos.lowestPrice, pos.entry), current);
  } else {
    pos.highestPrice = Math.max(safeNumber(pos.highestPrice, pos.entry), current);
    pos.lowestPrice = Math.min(safeNumber(pos.lowestPrice, pos.entry), current);
  }

  return pos;
}

function updateTrailingStop(pos) {
  if (!pos?.trailingActive) return pos;

  const risk = getInitialRisk(pos);
  if (!risk) return pos;

  const side = normalizeSide(pos.side);

  if (side === "bull") {
    const highest = safeNumber(pos.highestPrice, pos.entry);
    const trail = highest - risk * TRAIL_DISTANCE_R;

    if (trail > safeNumber(pos.sl, 0)) {
      pos.trailPrice = trail;
      pos.sl = trail;
      pos.lastTrailAt = Date.now();
    }
  } else {
    const lowest = safeNumber(pos.lowestPrice, pos.entry);
    const trail = lowest + risk * TRAIL_DISTANCE_R;

    if (!pos.sl || trail < safeNumber(pos.sl, Infinity)) {
      pos.trailPrice = trail;
      pos.sl = trail;
      pos.lastTrailAt = Date.now();
    }
  }

  return pos;
}

function buildPositionFromEntry({
  c,
  ctx,
  risk,
  targets,
  rr,
  targetR,
  entryType,
  setupClass
}) {
  const now = Date.now();

  return {
    profile: "RUNNER",
    strategyVersion: STRATEGY_VERSION,

    symbol: normalizeBaseSymbol(c.symbol),
    side: normalizeSide(c.side),
    rawBitgetSymbol: ctx.contractSymbol || normalizeBitgetSymbol(c.rawBitgetSymbol || c.symbol),

    setupClass,
    entryType,
    runnerEntryType: entryType,

    stage: c.stage,
    scannerStage: c.scannerStage || c.stage,
    stageSource: c.stageSource || "unknown",

    score: safeNumber(c.moveScore, 0),
    confluence: safeNumber(ctx.confluence, 0),
    sniperScore: safeNumber(ctx.sniper?.score ?? ctx.sniper?.runnerScore, 0),
    sniper: ctx.sniper?.type || "NONE",

    flow: ctx.flow?.type || c.flow || "NEUTRAL",
    runnerPressure: safeNumber(c.runnerPressure, 0),
    runnerAcceleration: safeNumber(c.runnerAcceleration, 0),

    entry: safeNumber(c.price, 0),
    sl: safeNumber(risk.sl, 0),
    initialSl: safeNumber(risk.sl, 0),
    tp: safeNumber(targets.tp, 0),

    partialTp: safeNumber(targets.partialTp, 0),
    breakevenAt: safeNumber(targets.breakevenAt, 0),
    trailStart: safeNumber(targets.trailStart, 0),

    rr,
    targetR,

    partialTaken: false,
    partialSize: PARTIAL_SIZE,

    breakEvenMoved: false,
    breakEvenTriggerR: BREAK_EVEN_TRIGGER_R,
    breakEvenLockR: BREAK_EVEN_LOCK_R,

    trailingActive: false,
    trailDistanceR: TRAIL_DISTANCE_R,

    adds: 0,
    maxAdds: MAX_ADDS,

    tfScore: safeNumber(c.tfScore, 0),
    tfStrength: safeNumber(c.tfStrength, 0),
    tfAlignment: c.tfAlignment || "UNKNOWN",

    rsi: ctx.rsi ?? null,
    rsiZone: ctx.rsiZone || null,
    rsiContinuationScore: safeNumber(ctx.rsiContinuationScore, 0),

    obBias: ctx.ob?.bias || "NEUTRAL",
    spreadPct: safeNumber(ctx.ob?.spreadPct, 0),
    depthMinUsd1p: safeNumber(ctx.ob?.depthMinUsd1p, 0),

    funding: safeNumber(ctx.funding?.rate, 0),
    volatility: ctx.volatility || "UNKNOWN",
    regime: ctx.regime || "UNKNOWN",
    btcState: ctx.btcState || "UNKNOWN",
    structure: ctx.structure || "UNKNOWN",

    highestPrice: safeNumber(c.price, 0),
    lowestPrice: safeNumber(c.price, 0),

    currentR: 0,
    mfeR: 0,
    maeR: 0,

    ticksObserved: 0,

    createdAt: now,
    updatedAt: now
  };
}

// ================= POSITION MANAGEMENT =================
function buildHoldPayload(c, pos, ctx, reason = "RUNNING") {
  return {
    ...buildCommonPayload(c, ctx),
    action: "HOLD",
    reason,

    setupClass: pos.setupClass,
    entryType: pos.entryType,

    entry: pos.entry,
    sl: pos.sl,
    initialSl: pos.initialSl,
    tp: pos.tp,
    partialTp: pos.partialTp,
    breakevenAt: pos.breakevenAt,
    trailStart: pos.trailStart,
    trailPrice: pos.trailPrice ?? null,

    rr: formatRR(pos.rr),
    targetR: pos.targetR,

    currentR: safeNumber(pos.currentR, 0),
    mfeR: safeNumber(pos.mfeR, 0),
    maeR: safeNumber(pos.maeR, 0),

    partialTaken: Boolean(pos.partialTaken),
    breakEvenMoved: Boolean(pos.breakEvenMoved),
    trailingActive: Boolean(pos.trailingActive),

    adds: safeNumber(pos.adds, 0)
  };
}

function buildPositionAction(action, reason, c, pos, ctx, extra = {}) {
  return {
    ...buildHoldPayload(c, pos, ctx, reason),
    action,
    reason,
    ...extra
  };
}

async function handleOpenPosition(c, pos, ctx, options = {}) {
  const shouldLog = options.log !== false;
  const notify = options.notify !== false;

  const side = normalizeSide(pos.side);
  const price = safeNumber(c.price, 0);
  const key = `${pos.symbol}_${pos.side}`;

  if (!price) {
    const payload = buildHoldPayload(c, pos, ctx, "PRICE_INVALID_OPEN_POSITION");
    await logSystem(payload, shouldLog);
    return payload;
  }

  updatePositionMetrics(pos, price);

  const hitTP = side === "bull"
    ? price >= safeNumber(pos.tp, 0)
    : price <= safeNumber(pos.tp, 0);

  const hitSL = side === "bull"
    ? price <= safeNumber(pos.sl, 0)
    : price >= safeNumber(pos.sl, 0);

  if (hitTP || hitSL) {
    const executionPrice = hitTP
      ? safeNumber(pos.tp, price)
      : safeNumber(pos.sl, price);

    const exitReason = hitTP
      ? "TP"
      : pos.trailingActive
        ? "TRAIL_SL"
        : pos.breakEvenMoved
          ? "BE_SL"
          : "SL";

    const exitR = calculateR(pos, executionPrice);
    const pnlPct = calculatePnlPct(pos, executionPrice);

    const payload = buildPositionAction(
      "EXIT",
      exitReason,
      c,
      pos,
      ctx,
      {
        exit: executionPrice,
        executionPrice,
        triggerPrice: price,
        exitR: Number(exitR.toFixed(3)),
        pnlPct: Number(pnlPct.toFixed(3)),
        holdMinutes: Number(((Date.now() - safeNumber(pos.createdAt, Date.now())) / 60000).toFixed(1))
      }
    );

    stats.exits++;

    if (exitR > 0) stats.wins++;
    if (exitR < 0) stats.losses++;

    stats.closedTrades.push({
      ...payload,
      createdAt: pos.createdAt,
      exitedAt: Date.now()
    });

    stats.closedTrades = stats.closedTrades.slice(-500);

    if (shouldLog) {
      await logTrade({
        ...payload,
        result: exitR > 0 ? "WIN" : exitR < 0 ? "LOSS" : "FLAT",
        price,
        funding: pos.funding,
        regime: pos.regime,
        btcState: pos.btcState
      });
    }

    if (notify) {
      await sendExit({
        symbol: pos.symbol,
        side: pos.side,
        reason: exitReason,
        entry: pos.entry,
        sl: pos.sl,
        tp: pos.tp,
        rr: pos.rr,
        grade: pos.setupClass === "RUNNER_A" || pos.setupClass === "RUNNER_C" ? "A" : "B"
      });
    }

    memory.delete(key);
    notifyState.delete(key);

    cooldownMap.set(key, Date.now() + COOLDOWN_MS);
    symbolCooldownMap.set(pos.symbol, Date.now() + SYMBOL_REENTRY_COOLDOWN_MS);

    recordFeatureRow(payload);

    return payload;
  }

  // PARTIAL TP
  if (!pos.partialTaken && safeNumber(pos.currentR, 0) >= PARTIAL_TP_R) {
    pos.partialTaken = true;
    pos.partialTakenAt = Date.now();
    pos.sizeOpen = 1 - PARTIAL_SIZE;

    stats.partials++;

    const payload = buildPositionAction(
      "PARTIAL_TP",
      "PARTIAL_TP_REACHED",
      c,
      pos,
      ctx,
      {
        price,
        partialSize: PARTIAL_SIZE,
        remainingSize: pos.sizeOpen,
        partialTp: pos.partialTp
      }
    );

    memory.set(key, pos);
    await logSystem(payload, shouldLog);
    recordFeatureRow(payload);

    return payload;
  }

  // MOVE TO BREAK EVEN
  if (!pos.breakEvenMoved && safeNumber(pos.currentR, 0) >= BREAK_EVEN_TRIGGER_R) {
    const risk = getInitialRisk(pos);

    if (risk > 0) {
      const newSl = side === "bull"
        ? pos.entry + risk * BREAK_EVEN_LOCK_R
        : pos.entry - risk * BREAK_EVEN_LOCK_R;

      pos.slBeforeBreakEven = pos.sl;
      pos.sl = newSl;
      pos.breakEvenMoved = true;
      pos.breakEvenMovedAt = Date.now();

      stats.movesToBE++;

      const payload = buildPositionAction(
        "MOVE_BE",
        "BREAKEVEN_LOCKED",
        c,
        pos,
        ctx,
        {
          price,
          newSl,
          oldSl: pos.slBeforeBreakEven
        }
      );

      memory.set(key, pos);
      await logSystem(payload, shouldLog);
      recordFeatureRow(payload);

      return payload;
    }
  }

  // TRAIL START / UPDATE
  if (safeNumber(pos.currentR, 0) >= TRAIL_START_R) {
    const wasActive = Boolean(pos.trailingActive);

    pos.trailingActive = true;
    updateTrailingStop(pos);

    stats.trails++;

    const payload = buildPositionAction(
      "TRAIL",
      wasActive ? "TRAIL_UPDATED" : "TRAIL_STARTED",
      c,
      pos,
      ctx,
      {
        price,
        trailPrice: pos.trailPrice ?? pos.sl
      }
    );

    memory.set(key, pos);
    await logSystem(payload, shouldLog);
    recordFeatureRow(payload);

    return payload;
  }

  // ADD LOGIC
  const canAdd =
    safeNumber(pos.adds, 0) < safeNumber(pos.maxAdds, 0) &&
    safeNumber(pos.currentR, 0) >= ADD_MIN_R &&
    safeNumber(ctx.confluence, 0) >= ADD_MIN_CONFLUENCE &&
    safeNumber(ctx.sniper?.score ?? ctx.sniper?.runnerScore, 0) >= ADD_MIN_SNIPER &&
    HOT_RUNNER_FLOWS.has(normalizeFlow(ctx.flow?.type));

  if (canAdd) {
    pos.adds = safeNumber(pos.adds, 0) + 1;
    pos.lastAdd = price;
    pos.lastAddAt = Date.now();

    const payload = buildPositionAction(
      "ADD",
      "RUNNER_CONTINUATION_ADD",
      c,
      pos,
      ctx,
      {
        price,
        addSize: 0.50,
        adds: pos.adds
      }
    );

    memory.set(key, pos);
    await logSystem(payload, shouldLog);
    recordFeatureRow(payload);

    return payload;
  }

  pos.updatedAt = Date.now();
  memory.set(key, pos);

  const hold = buildHoldPayload(c, pos, ctx, "RUNNING");
  await logSystem(hold, shouldLog);

  return hold;
}

// ================= DATA FETCH =================
function updateOrderbookMemorySafe(symbol, raw, analyzed) {
  try {
    updateOrderbookMemory(symbol, raw, analyzed);
  } catch (e) {
    console.warn(`RUNNER OB MEMORY UPDATE FAILED ${symbol}:`, e?.message || e);
  }
}

async function fetchCoinData(c) {
  const symbol = normalizeBaseSymbol(c.symbol);
  const contractSymbol = normalizeBitgetSymbol(c.rawBitgetSymbol || c.bitgetSymbol || symbol);

  let ob = { ...DEFAULT_OB };

  try {
    const raw = await cachedFetch(
      `ob_${contractSymbol}`,
      () => fetchOrderBook(contractSymbol),
      12000
    );

    if (raw) {
      const analyzed = analyzeOrderBookAdvanced(raw);

      ob = {
        ...DEFAULT_OB,
        ...(analyzed || {}),
        fetchFailed: false
      };

      updateOrderbookMemorySafe(symbol, raw, analyzed);
    }
  } catch {
    ob = { ...DEFAULT_OB };
  }

  let funding = { rate: 0 };

  try {
    funding = await cachedFetch(
      `fund_${contractSymbol}`,
      () => fetchFunding(contractSymbol),
      120000
    );
  } catch {
    funding = { rate: 0 };
  }

  const [candles15m, candles1h, candles4h] = await Promise.all([
    cachedFetch(`c15_${contractSymbol}`, () => fetchCandles(contractSymbol, "15m", 100), 20000),
    cachedFetch(`c1h_${contractSymbol}`, () => fetchCandles(contractSymbol, "1h", 100), 25000),
    cachedFetch(`c4h_${contractSymbol}`, () => fetchCandles(contractSymbol, "4h", 100), 45000)
  ]);

  const mtfRsi = getMTFRSI({
    m15: candles15m,
    h1: candles1h,
    h4: candles4h
  });

  const structure = getStructureState(candles15m);

  let liquidation = null;

  try {
    const liqPrice = safeNumber(c.price || ob.mid, 0);

    liquidation = await cachedFetch(
      `liq_${contractSymbol}_${Math.round(liqPrice)}`,
      () => getLiquidationZones(contractSymbol, liqPrice),
      30000
    );
  } catch {
    liquidation = null;
  }

  return {
    symbol,
    contractSymbol,
    ob,
    funding,
    candles15m,
    candles1h,
    candles4h,
    mtfRsi,
    structure,
    liquidation
  };
}

// ================= ENTRY CLASSIFICATION =================
function classifyRunnerSetup({
  c,
  flow,
  sniper,
  confluence,
  rr,
  rsiBias,
  strategyProfile
}) {
  const score = safeNumber(c.moveScore, 0);
  const sniperScore = safeNumber(sniper?.score ?? sniper?.runnerScore, 0);
  const entryType = String(sniper?.entryType || sniper?.runnerEntryType || "").toUpperCase();
  const f = normalizeFlow(flow?.type);

  if (
    entryType === "RUNNER_C_SQUEEZE" ||
    (
      f === "SQUEEZE" &&
      score >= 76 &&
      confluence >= RUNNER_C_MIN_CONFLUENCE &&
      sniperScore >= RUNNER_C_MIN_SNIPER &&
      rr >= RUNNER_C_MIN_RR &&
      safeNumber(rsiBias?.score, 0) >= 5
    )
  ) {
    return {
      ok: true,
      setupClass: "RUNNER_C",
      entryType: "RUNNER_C_SQUEEZE",
      targetR: RUNNER_C_TARGET_R,
      minConfluence: RUNNER_C_MIN_CONFLUENCE,
      minSniper: RUNNER_C_MIN_SNIPER,
      minRR: RUNNER_C_MIN_RR
    };
  }

  if (
    entryType === "RUNNER_A_BREAKOUT" ||
    (
      HOT_RUNNER_FLOWS.has(f) &&
      score >= 72 &&
      confluence >= RUNNER_A_MIN_CONFLUENCE &&
      sniperScore >= RUNNER_A_MIN_SNIPER &&
      rr >= RUNNER_A_MIN_RR
    )
  ) {
    return {
      ok: true,
      setupClass: "RUNNER_A",
      entryType: "RUNNER_A_BREAKOUT",
      targetR: RUNNER_A_TARGET_R,
      minConfluence: RUNNER_A_MIN_CONFLUENCE,
      minSniper: RUNNER_A_MIN_SNIPER,
      minRR: RUNNER_A_MIN_RR
    };
  }

  if (
    entryType === "RUNNER_B_CONTINUATION" ||
    (
      strategyProfile?.allowEntry &&
      RUNNER_FLOWS.has(f) &&
      score >= 66 &&
      confluence >= RUNNER_B_MIN_CONFLUENCE &&
      sniperScore >= RUNNER_B_MIN_SNIPER &&
      rr >= RUNNER_B_MIN_RR
    )
  ) {
    return {
      ok: true,
      setupClass: "RUNNER_B",
      entryType: "RUNNER_B_CONTINUATION",
      targetR: RUNNER_B_TARGET_R,
      minConfluence: RUNNER_B_MIN_CONFLUENCE,
      minSniper: RUNNER_B_MIN_SNIPER,
      minRR: RUNNER_B_MIN_RR
    };
  }

  return {
    ok: false,
    setupClass: "NONE",
    entryType: "RUNNER_NOT_READY",
    targetR: RUNNER_B_TARGET_R,
    minConfluence: RUNNER_B_MIN_CONFLUENCE,
    minSniper: RUNNER_B_MIN_SNIPER,
    minRR: RUNNER_B_MIN_RR
  };
}

// ================= FINALIZE =================
function buildStatsSnapshot() {
  const closed = stats.closedTrades || [];
  const wins = safeNumber(stats.wins, 0);
  const losses = safeNumber(stats.losses, 0);
  const completed = wins + losses;

  const totalR = closed.reduce((sum, row) => sum + safeNumber(row.exitR, 0), 0);
  const totalPnlPct = closed.reduce((sum, row) => sum + safeNumber(row.pnlPct, 0), 0);

  return {
    profile: "RUNNER",
    strategyVersion: STRATEGY_VERSION,

    runs: safeNumber(stats.runs, 0),
    entries: safeNumber(stats.entries, 0),
    partials: safeNumber(stats.partials, 0),
    movesToBE: safeNumber(stats.movesToBE, 0),
    trails: safeNumber(stats.trails, 0),
    exits: safeNumber(stats.exits, 0),
    wins,
    losses,

    winrate: completed ? Number(((wins / completed) * 100).toFixed(2)) : 0,

    totalR: Number(totalR.toFixed(3)),
    avgR: closed.length ? Number((totalR / closed.length).toFixed(3)) : 0,

    totalPnlPct: Number(totalPnlPct.toFixed(3)),
    avgPnlPct: closed.length ? Number((totalPnlPct / closed.length).toFixed(3)) : 0,

    openPositions: memory.size,

    waitReasons: stats.waitReasons || {},
    entryTypes: stats.entryTypes || {},

    closedTrades: closed.slice(-50),
    featureRows: (stats.featureRows || []).slice(-100),

    durableEnabled: hasRedis(),
    durableLoadedAt: runtimeState.durableLoadedAt,
    durableSavedAt: runtimeState.durableSavedAt,

    servedAt: Date.now()
  };
}

function finalizeResult(actions, candidates, btcState, runId) {
  const finalActions = actions.length
    ? sortActions(actions)
    : candidates.map(c => ({
        profile: "RUNNER",
        strategyVersion: STRATEGY_VERSION,
        symbol: normalizeBaseSymbol(c.symbol),
        side: normalizeSide(c.side),
        action: "WAIT",
        reason: "NO_VALID_RUNNER_SETUP",
        score: safeNumber(c.moveScore, 0),
        ts: Date.now()
      }));

  stats.runs++;

  return {
    profile: "RUNNER",
    ok: true,
    strategyVersion: STRATEGY_VERSION,
    runId,
    btcState,

    actions: finalActions,
    candidatesCount: candidates.length,

    openPositions: Array.from(memory.values()).map(pos => ({
      symbol: pos.symbol,
      side: pos.side,
      setupClass: pos.setupClass,
      entryType: pos.entryType,
      entry: pos.entry,
      sl: pos.sl,
      initialSl: pos.initialSl,
      tp: pos.tp,
      partialTp: pos.partialTp,
      trailPrice: pos.trailPrice ?? null,
      currentR: safeNumber(pos.currentR, 0),
      mfeR: safeNumber(pos.mfeR, 0),
      maeR: safeNumber(pos.maeR, 0),
      partialTaken: Boolean(pos.partialTaken),
      breakEvenMoved: Boolean(pos.breakEvenMoved),
      trailingActive: Boolean(pos.trailingActive),
      adds: safeNumber(pos.adds, 0)
    })),

    runnerStats: buildStatsSnapshot()
  };
}

// ================= CORE =================
export async function processTrades(input, options = {}) {
  const notify = options.notify !== false;
  const shouldLog = options.log !== false;

  const runId = `runner_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const lockOwner = `${runId}_${Math.random().toString(36).slice(2, 8)}`;

  const durableRequired = hasRedis();
  let lockAcquired = false;

  try {
    if (durableRequired) {
      lockAcquired = await acquireRuntimeLock(lockOwner);

      if (!lockAcquired) {
        throw new Error("RUNNER_TRADE_SYSTEM_LOCK_BUSY");
      }
    }

    await loadDurableRuntimeState();
    cleanExpiredGuards();

    let rawCandidates = [];
    let scanBtc = options.btc || null;
    let scanRegime = options.regime || null;

    if (Array.isArray(input)) {
      rawCandidates = input;
    } else {
      rawCandidates = [
        ...(input?.funnel?.bull?.entry || []),
        ...(input?.funnel?.bear?.entry || []),
        ...(input?.funnel?.bull?.almost || []),
        ...(input?.funnel?.bear?.almost || [])
      ];

      scanBtc = input?.btc || scanBtc;
      scanRegime = input?.regime || scanRegime;
    }

    const { candidates } = buildTradeCandidates(rawCandidates);
    const actions = [];

    let market = { trend: "NEUTRAL" };

    try {
      market = await getMarketContext();
    } catch {
      market = { trend: "NEUTRAL" };
    }

    const btcState = scanBtc?.state || market?.trend || "NEUTRAL";

    if (!candidates.length) {
      return finalizeResult([], [], btcState, runId);
    }

    const dataMap = new Map();

    const chunks = [];

    for (let i = 0; i < candidates.length; i += 4) {
      chunks.push(candidates.slice(i, i + 4));
    }

    for (const chunk of chunks) {
      const results = await Promise.allSettled(chunk.map(fetchCoinData));

      for (let i = 0; i < results.length; i++) {
        const c = chunk[i];
        const symbol = normalizeBaseSymbol(c.symbol);

        if (results[i].status === "fulfilled") {
          dataMap.set(symbol, results[i].value);
        } else {
          dataMap.set(symbol, {
            symbol,
            contractSymbol: normalizeBitgetSymbol(symbol),
            ob: { ...DEFAULT_OB },
            funding: { rate: 0 },
            candles15m: [],
            candles1h: [],
            candles4h: [],
            mtfRsi: null,
            structure: { trend: "UNKNOWN" },
            liquidation: null
          });
        }
      }
    }

    for (const raw of candidates) {
      const c = {
        ...raw,
        symbol: normalizeBaseSymbol(raw.symbol),
        side: normalizeSide(raw.side),
        moveScore: safeNumber(raw.moveScore ?? raw.score, 0)
      };

      const key = `${c.symbol}_${c.side}`;
      const lockKey = `LOCK_${c.symbol}`;

      const data = dataMap.get(c.symbol) || {
        contractSymbol: normalizeBitgetSymbol(c.symbol),
        ob: { ...DEFAULT_OB },
        funding: { rate: 0 },
        mtfRsi: null,
        structure: { trend: "UNKNOWN" },
        liquidation: null,
        candles15m: [],
        candles1h: []
      };

      const ob = data.ob || { ...DEFAULT_OB };
      const funding = data.funding || { rate: 0 };
      const contractSymbol = data.contractSymbol || normalizeBitgetSymbol(c.symbol);

      if (safeNumber(ob.mid, 0) > 0) {
        c.price = safeNumber(ob.mid, 0);
      } else {
        c.price = safeNumber(c.price || c.lastPrice, 0);
      }

      c.runnerPressure = getDirectionalPressure(c);
      c.runnerAcceleration = getRunnerAcceleration(c);

      const analyzedFlow = analyzeFlow(c);
      const flow = classifyRunnerFlow(c, analyzedFlow);

      c.flow = flow.type;

      const tfMeta = getTimeframeMeta(c);

      c.tfScore = tfMeta.tfScore;
      c.tfStrength = tfMeta.tfStrength;
      c.tfAlignment = tfMeta.tfAlignment;

      c.atrPct15m = safeNumber(tfMeta.ctx?.atrPct15m, c.atrPct15m || 0);
      c.atrPct1h = safeNumber(tfMeta.ctx?.atrPct1h, c.atrPct1h || 0);
      c.atrPct4h = safeNumber(tfMeta.ctx?.atrPct4h, c.atrPct4h || 0);
      c.atrPct24h = safeNumber(tfMeta.ctx?.atrPct24h, c.atrPct24h || 0);

      const volatility = getVolatility(c);
      const regimeObj = getVolatilityRegime(c);
      const regime = regimeObj?.level || scanRegime || "MEDIUM";

      const rsiSignal = data.mtfRsi
        ? getRSISignal(data.mtfRsi, c.side)
        : { valid: false };

      const rsiZone = getRsiZone(rsiSignal);
      const rsi = Number.isFinite(Number(rsiSignal?.rsi))
        ? Number(rsiSignal.rsi)
        : null;

      const structure = data.structure || { trend: "UNKNOWN" };

      const liquidity = getLiquidityZones(c, ob);

      const hasLiquidationData =
        Array.isArray(data.liquidation?.clusters) &&
        data.liquidation.clusters.length > 0;

      const rsiCtx = data.mtfRsi?.m15?.valid
        ? {
            valid: true,
            rsi: data.mtfRsi.m15.rsi,
            zones: data.mtfRsi.m15.zones
          }
        : null;

      const confluence = calculateConfluence(
        c,
        ob,
        liquidity,
        funding,
        getRegimeForConfluence(regimeObj, scanRegime),
        hasLiquidationData ? data.liquidation : null,
        rsiCtx
      );

      c.confluence = confluence;

      const sniper = getSniperEntry(c, ob, rsiSignal);
      const rsiBias = getRsiRunnerBias(rsiSignal, c.side);

      const ctx = {
        contractSymbol,
        ob,
        funding,
        flow,
        sniper,
        confluence,
        volatility,
        regime,
        btcState,
        rsi,
        rsiZone,
        rsiContinuationScore: safeNumber(rsiSignal?.continuationScore, 0),
        structure: structure?.runnerStructure || structure?.trend || "UNKNOWN"
      };

      const existing = memory.get(key);

      if (existing) {
        const payload = await handleOpenPosition(c, existing, ctx, {
          notify,
          log: shouldLog
        });

        actions.push(payload);
        continue;
      }

      // ================= NEW ENTRY FILTERS =================
      if (!safeNumber(c.price, 0)) {
        actions.push(buildWait(c, "PRICE_INVALID", ctx));
        continue;
      }

      if (ob.fetchFailed) {
        actions.push(buildWait(c, "ORDERBOOK_FETCH_FAILED", ctx));
        continue;
      }

      if (ob.spoof) {
        actions.push(buildWait(c, "SPOOF_DETECTED", ctx));
        continue;
      }

      if (!RUNNER_FLOWS.has(normalizeFlow(flow.type))) {
        actions.push(buildWait(c, "FLOW_NOT_RUNNER", ctx));
        continue;
      }

      if (flow.type === "EXHAUSTION" || analyzedFlow?.type === "EXHAUSTION") {
        actions.push(buildWait(c, "FLOW_EXHAUSTION", ctx));
        continue;
      }

      if (c.runnerPressure < 0.05) {
        actions.push(buildWait(c, "RUNNER_PRESSURE_TOO_LOW", ctx));
        continue;
      }

      if (c.runnerAcceleration < -0.65) {
        actions.push(buildWait(c, "RUNNER_DECELERATING", ctx));
        continue;
      }

      if (c.moveScore < MIN_SCORE) {
        actions.push(buildWait(c, "SCORE_TOO_LOW", ctx));
        continue;
      }

      if (c.tfStrength < MIN_TF_STRENGTH) {
        actions.push(buildWait(c, "TF_TOO_WEAK", ctx));
        continue;
      }

      if (!rsiSignal?.valid || rsi === null) {
        actions.push(buildWait(c, "RSI_DATA_INVALID", ctx));
        continue;
      }

      if (rsiSignal.blocked || rsiBias.blocked) {
        actions.push(buildWait(c, "RSI_BLOCKED", ctx));
        continue;
      }

      if (isRsiExhaustedAgainstSide(c.side === "bull", rsiZone, rsiSignal)) {
        actions.push(buildWait(c, "RSI_EXHAUSTED_AGAINST_SIDE", ctx));
        continue;
      }

      const continuationAllowed = isRsiContinuationAllowed({
        isBull: c.side === "bull",
        zone: rsiZone,
        rsiSignal,
        confluence,
        sniperScore: safeNumber(sniper?.score ?? sniper?.runnerScore, 0),
        runnerScore: safeNumber(sniper?.runnerScore ?? sniper?.score, 0),
        rr: 1.2,
        flow: flow.type
      });

      const pullbackAllowed = isRsiPullbackEntry({
        isBull: c.side === "bull",
        zone: rsiZone,
        rsiSignal,
        sniperScore: safeNumber(sniper?.score ?? sniper?.runnerScore, 0),
        runnerScore: safeNumber(sniper?.runnerScore ?? sniper?.score, 0)
      });

      if (!continuationAllowed && !pullbackAllowed) {
        actions.push(buildWait(c, "RSI_NO_RUNNER_EDGE", ctx));
        continue;
      }

      if (!isStructureAligned(structure, c.side) && confluence < 78) {
        actions.push(buildWait(c, "STRUCTURE_AGAINST", ctx));
        continue;
      }

      const spread = normalizeSpread(ob.spreadPct);
      const maxSpread = flow.type === "SQUEEZE"
        ? SQUEEZE_MAX_SPREAD_PCT
        : MAX_SPREAD_PCT;

      if (spread > maxSpread && confluence < 82) {
        actions.push(buildWait(c, "SPREAD_TOO_WIDE", ctx));
        continue;
      }

      const minDepth = flow.type === "SQUEEZE"
        ? SQUEEZE_MIN_DEPTH_USD_1P
        : MIN_DEPTH_USD_1P;

      if (safeNumber(ob.depthMinUsd1p, 0) < minDepth && confluence < 82) {
        actions.push(buildWait(c, "DEPTH_TOO_LOW", ctx));
        continue;
      }

      if (isObAgainstSide(ob, c.side) && confluence < 80) {
        actions.push(buildWait(c, "OB_AGAINST", ctx));
        continue;
      }

      const fundingRate = safeNumber(funding.rate, 0);

      if (Math.abs(fundingRate) > 0.018 && confluence < 84) {
        actions.push(buildWait(c, "FUNDING_EXTREME", ctx));
        continue;
      }

      if (c.side === "bull" && fundingRate > 0.014 && confluence < 84) {
        actions.push(buildWait(c, "LONG_CROWDED_FUNDING", ctx));
        continue;
      }

      if (c.side === "bear" && fundingRate < -0.014 && confluence < 84) {
        actions.push(buildWait(c, "SHORT_CROWDED_FUNDING", ctx));
        continue;
      }

      if (btcState === "STRONG_BULL" && c.side === "bear" && confluence < 85) {
        actions.push(buildWait(c, "BTC_STRONG_BULL_BLOCK_SHORT", ctx));
        continue;
      }

      if (btcState === "STRONG_BEAR" && c.side === "bull" && confluence < 85) {
        actions.push(buildWait(c, "BTC_STRONG_BEAR_BLOCK_LONG", ctx));
        continue;
      }

      if (hasAnyOpenPositionForSymbol(c.symbol)) {
        actions.push(buildWait(c, `SYMBOL_ALREADY_OPEN_${getOpenPositionSideForSymbol(c.symbol)}`, ctx));
        continue;
      }

      if (processingLocks.has(lockKey)) {
        actions.push(buildWait(c, "PROCESSING_LOCK_ACTIVE", ctx));
        continue;
      }

      if (Date.now() < safeNumber(cooldownMap.get(key), 0)) {
        actions.push(buildWait(c, "PAIR_COOLDOWN", ctx));
        continue;
      }

      if (Date.now() < safeNumber(symbolCooldownMap.get(c.symbol), 0)) {
        actions.push(buildWait(c, "SYMBOL_COOLDOWN", ctx));
        continue;
      }

      if (confluence < MIN_CONFLUENCE) {
        actions.push(buildWait(c, "CONFLUENCE_TOO_LOW", {
          ...ctx,
          requiredConfluence: MIN_CONFLUENCE
        }));
        continue;
      }

      const sniperScore = safeNumber(sniper?.score ?? sniper?.runnerScore, 0);

      if (sniperScore < MIN_SNIPER_SCORE) {
        actions.push(buildWait(c, "SNIPER_TOO_LOW", {
          ...ctx,
          requiredSniper: MIN_SNIPER_SCORE
        }));
        continue;
      }

      const strategy = chooseStrategy({
        ...c,
        confluence,
        rr: RUNNER_B_MIN_RR
      });

      const strategyProfile = getStrategyRiskProfile(strategy);

      if (!strategyProfile.allowEntry && confluence < 82) {
        actions.push(buildWait(c, "STRATEGY_NOT_READY", ctx));
        continue;
      }

      const riskBase = await calculateRisk(
        c,
        ob,
        liquidity,
        hasLiquidationData ? data.liquidation : null
      );

      const baseRR = safeNumber(riskBase?.rr, 0);

      const setup = classifyRunnerSetup({
        c,
        flow,
        sniper,
        confluence,
        rr: baseRR,
        rsiBias,
        strategyProfile
      });

      const requiredRR = getDynamicRrFloor({
        flow: flow.type,
        volatility,
        entryType: setup.entryType
      });

      if (baseRR < requiredRR) {
        actions.push(buildWait(c, "RR_TOO_LOW", {
          ...ctx,
          rr: baseRR,
          risk: riskBase,
          requiredRR
        }));
        continue;
      }

      if (!setup.ok) {
        actions.push(buildWait(c, "RUNNER_SETUP_NOT_READY", {
          ...ctx,
          rr: baseRR,
          risk: riskBase,
          requiredConfluence: setup.minConfluence,
          requiredSniper: setup.minSniper,
          requiredRR: setup.minRR
        }));
        continue;
      }

      const targetR = setup.targetR;
      const targets = buildRunnerTargets({
        entry: c.price,
        sl: riskBase.sl,
        side: c.side,
        targetR
      });

      const finalRR = calculateRRFromPrices(
        c.price,
        riskBase.sl,
        targets.tp,
        c.side
      );

      if (finalRR < setup.minRR) {
        actions.push(buildWait(c, "FINAL_RR_TOO_LOW", {
          ...ctx,
          rr: finalRR,
          risk: {
            ...riskBase,
            tp: targets.tp
          },
          requiredRR: setup.minRR
        }));
        continue;
      }

      const position = buildPositionFromEntry({
        c,
        ctx,
        risk: riskBase,
        targets,
        rr: finalRR,
        targetR,
        entryType: setup.entryType,
        setupClass: setup.setupClass
      });

      const entryPayload = {
        ...buildCommonPayload(c, {
          ...ctx,
          rr: finalRR,
          risk: {
            ...riskBase,
            tp: targets.tp
          }
        }),

        action: "ENTRY",
        reason: setup.entryType,

        setupClass: setup.setupClass,
        entryType: setup.entryType,
        runnerEntryType: setup.entryType,

        grade: setup.setupClass === "RUNNER_B" ? "B" : "A",

        entry: position.entry,
        sl: position.sl,
        initialSl: position.initialSl,
        tp: position.tp,
        partialTp: position.partialTp,
        breakevenAt: position.breakevenAt,
        trailStart: position.trailStart,

        rr: formatRR(finalRR),
        targetR,

        partialSize: PARTIAL_SIZE,
        maxAdds: MAX_ADDS
      };

      processingLocks.add(lockKey);

      try {
        memory.set(key, position);

        cooldownMap.set(key, Date.now() + COOLDOWN_MS);
        symbolCooldownMap.set(c.symbol, Date.now() + SYMBOL_REENTRY_COOLDOWN_MS);

        stats.entries++;
        incrementCounter(stats.entryTypes, setup.entryType);

        await logSystem(entryPayload, shouldLog);

        if (notify && !notifyState.get(key)) {
          await sendEntry({
            symbol: c.symbol,
            side: c.side,
            grade: setup.setupClass === "RUNNER_B" ? "B" : "A",

            entry: position.entry,
            sl: position.sl,
            tp: position.tp,
            rr: position.rr,

            setupClass: setup.setupClass,
            entryType: setup.entryType,

            confluence,
            sniperScore,
            runnerPressure: c.runnerPressure,
            runnerAcceleration: c.runnerAcceleration,
            rsiZone,
            obBias: ob.bias
          });

          notifyState.set(key, true);
        }

        recordFeatureRow(entryPayload);

        actions.push(entryPayload);
      } finally {
        processingLocks.delete(lockKey);
      }
    }

    return finalizeResult(actions, candidates, btcState, runId);
  } finally {
    if (!durableRequired || lockAcquired) {
      await saveDurableRuntimeState();
    }

    if (lockAcquired) {
      await releaseRuntimeLock(lockOwner);
    }
  }
}