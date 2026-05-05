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
  isRsiContinuationAllowed,
  isRsiPullbackEntry,
  isRsiExhaustedAgainstSide
} from "./rsiFilter.js";


import {
  sendEntry,
  sendExit
} from "./discordNotifier.js";

import { updateOrderbookMemory } from "./orderbookMemory.js";
import { chooseStrategy } from "./strategy.js";
import { getStructureState } from "./structureEngine.js";

// ================= STRATEGY VERSION =================
// Bewust gebumpt: optimizer setpoints uit real closed trades + pressure gate + bad cohort guard.
const STRATEGY_VERSION = "RUNNER_TS_V1_4_MASTER_AB_PNL_OPTIMIZER";

// ================= VERCEL LOG CONFIG =================
const RUNNER_LOG_LEVEL = String(process.env.RUNNER_LOG_LEVEL || "error").toLowerCase();
const RUNNER_DEBUG = String(process.env.RUNNER_DEBUG || "false").toLowerCase() === "true";

const LOG_LEVELS = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4
};

function shouldVercelLog(level = "info") {
  const active = LOG_LEVELS[RUNNER_LOG_LEVEL] ?? LOG_LEVELS.info;
  const wanted = LOG_LEVELS[level] ?? LOG_LEVELS.info;

  return wanted <= active;
}

function compactLogValue(value, depth = 0) {
  if (depth > 3) return "[depth_limit]";
  if (value === undefined) return undefined;
  if (value === null) return null;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return 0;
    return Number(value.toFixed(6));
  }

  if (typeof value === "string") {
    if (value.length <= 350) return value;
    return `${value.slice(0, 350)}…`;
  }

  if (typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    return value.slice(0, 20).map(v => compactLogValue(v, depth + 1));
  }

  if (typeof value === "object") {
    const out = {};

    for (const [key, val] of Object.entries(value)) {
      const compacted = compactLogValue(val, depth + 1);
      if (compacted !== undefined) out[key] = compacted;
    }

    return out;
  }

  return String(value);
}

function vercelLog(level, tag, payload = {}) {
  if (!shouldVercelLog(level)) return;

  const row = compactLogValue({
    app: "RUNNER",
    level,
    tag,
    strategyVersion: STRATEGY_VERSION,
    ts: Date.now(),
    iso: new Date().toISOString(),
    vercelRegion: process.env.VERCEL_REGION || null,
    vercelEnv: process.env.VERCEL_ENV || process.env.NODE_ENV || null,
    ...payload
  });

  const line = JSON.stringify(row);

  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
}

function vercelDebug(tag, payload = {}) {
  if (!RUNNER_DEBUG) return;
  vercelLog("debug", tag, payload);
}

function vercelError(tag, err, payload = {}) {
  vercelLog("error", tag, {
    ...payload,
    error: err?.message || String(err || "unknown_error"),
    stack: RUNNER_DEBUG ? err?.stack : undefined
  });
}

// ================= API CACHE =================
const apiCache = new Map();

async function cachedFetch(key, fn, ttl = 30000) {
  const cached = apiCache.get(key);

  if (cached && Date.now() - cached.ts < ttl) {
    return cached.data;
  }

  const data = await fn();

  apiCache.set(key, {
    data,
    ts: Date.now()
  });

  return data;
}

// ================= RUNNER CONSTANTS =================
const COOLDOWN_MS = 25 * 60 * 1000;
const SYMBOL_REENTRY_COOLDOWN_MS = 45 * 60 * 1000;

const DURABLE_LOCK_TTL_MS = 90 * 1000;
const DURABLE_LOCK_ATTEMPTS = 8;
const DURABLE_LOCK_RETRY_MS = 450;

const EXIT_NOTIFY_DEDUP_TTL_MS = 24 * 60 * 60 * 1000;

// Final live filter setpoints from real closed-trade optimizer.
// Applied from RUNNER_FINAL_FILTER_DECISION:
// - MIN_CONFLUENCE 64 -> 76
// - MIN_RUNNER_PRESSURE 0 -> 0.75
// - RUNNER_A_MIN_CONFLUENCE 74 -> 76
// - RUNNER_C_MIN_CONFLUENCE 78 -> 80
// - depth optimizer wilde 13531, maar bewust NIET verlaagd wegens liquidity quality.
const MIN_SCORE = 58;
const MIN_TF_STRENGTH = 1;
const MIN_CONFLUENCE = 76;

// Global sniper blijft 0.
// A/C setup gates beschermen sniper.
const MIN_SNIPER_SCORE = 0;

const MAX_SPREAD_PCT = 0.00165;
const SQUEEZE_MAX_SPREAD_PCT = 0.0032;

// Bewust behouden ondanks optimizer suggestie 13531.
// Reden: lager depth verhoogt low-liquidity noise.
const MIN_DEPTH_USD_1P = 15159;
const SQUEEZE_MIN_DEPTH_USD_1P = 15159;

const MIN_RUNNER_PRESSURE = 0.75;
const MIN_RUNNER_ACCELERATION = -0.65;

const RUNNER_A_MIN_CONFLUENCE = 76;
const RUNNER_A_MIN_SNIPER = 70;
const RUNNER_A_MIN_RR = 1.12;

const RUNNER_B_MIN_CONFLUENCE = 74;
const RUNNER_B_MIN_SNIPER = 58;
const RUNNER_B_MIN_RR = 1.05;

const RUNNER_C_MIN_CONFLUENCE = 80;
const RUNNER_C_MIN_SNIPER = 70;
const RUNNER_C_MIN_RR = 1.20;

const RUNNER_A_TARGET_R = 1.80;
const RUNNER_B_TARGET_R = 1.55;
const RUNNER_C_TARGET_R = 2.20;

const PARTIAL_TP_R = 0.85;
const PARTIAL_SIZE = 0.50;

const BREAK_EVEN_TRIGGER_R = 0.70;
const BREAK_EVEN_LOCK_R = 0.04;

const TRAIL_START_R = 1.15;
const TRAIL_DISTANCE_R = 0.55;
const TRAIL_MIN_CHANGE_PCT = 0.0005;

const MAX_ADDS = 1;
const ADD_MIN_R = 0.65;
const ADD_MIN_CONFLUENCE = 78;
const ADD_MIN_SNIPER = 74;

// Hard behavioral blocks from bad-cohort telemetry.
const BLOCK_ENTRY_TYPES = new Set([
  "RUNNER_B_CONTINUATION"
]);

// Watch cohort uit logs:
// RUNNER_A_BREAKOUT + MID + RUNNING + OB=NEUTRAL
// Sample nog klein, daarom geen volledige hard block.
// Wel strakker: alleen doorlaten met sterke pressure + sniper + confluence.
const WATCH_MID_RUNNING_NEUTRAL_MIN_CONFLUENCE = 99;
const WATCH_MID_RUNNING_NEUTRAL_MIN_SNIPER = 100;
const WATCH_MID_RUNNING_NEUTRAL_MIN_PRESSURE = 4.0;

const SHADOW_MONITOR_MS = 4 * 60 * 60 * 1000;
const SHADOW_MAX_ACTIVE_PER_RUN = 300;
const SHADOW_MAX_ROWS = 40000;

const MAX_FEATURE_ROWS = 80000;
const MAX_CLOSED_ROWS = 5000;

// ================= RUNNER FULL OPTIMIZER CONSTANTS =================
// Expliciet gemaakt zodat de master optimizer geen live filter overslaat.
const RUNNER_C_MIN_SCORE = 76;
const RUNNER_A_MIN_SCORE = 72;
const RUNNER_B_MIN_SCORE = 66;

const STRUCTURE_AGAINST_MIN_CONFLUENCE = 78;

const SPREAD_EXCEPTION_MIN_CONFLUENCE = 82;
const DEPTH_EXCEPTION_MIN_CONFLUENCE = 82;
const OB_AGAINST_MIN_CONFLUENCE = 80;

const FUNDING_EXTREME_ABS_MAX = 0.018;
const LONG_CROWDED_FUNDING_MAX = 0.014;
const SHORT_CROWDED_FUNDING_MIN = -0.014;
const FUNDING_MIN_CONFLUENCE = 84;

const BTC_STRONG_COUNTER_MIN_CONFLUENCE = 85;
const STRATEGY_SAFE_MIN_CONFLUENCE = 82;

const RSI_CONTINUATION_TEST_RR = 1.20;

const RUNNER_MASTER_MIN_SAMPLE = 12;
const RUNNER_MASTER_MIN_CLASS_SAMPLE = 6;
const RUNNER_MASTER_TARGET_SAMPLE = 100;
const RUNNER_MASTER_BEAM_WIDTH = 32;
const RUNNER_MASTER_BEAM_PASSES = 2;
const RUNNER_MASTER_MAX_ROWS = 8000;

// PnL-first objective.
const RUNNER_MASTER_OBJECTIVE = "MAX_TOTAL_PNL_AND_TOTAL_R";

// ================= PLANNED RR OUTCOME TABLE CONSTANTS =================
const PLANNED_RR_BUCKETS = Object.freeze([
  1.3,
  1.4,
  1.5,
  1.6,
  1.7,
  1.8,
  1.9,
  2.0,
  2.1,
  2.2,
  2.3,
  2.4,
  2.5
]);

const PLANNED_RR_BUCKET_STEP = 0.1;
const PLANNED_RR_MIN_SAMPLE = 3;

const RUNTIME_STORE_KEY = `runnerTradeSystem:runtime:${STRATEGY_VERSION}`;
const RUNTIME_LOCK_KEY = `runnerTradeSystem:runtimeLock:${STRATEGY_VERSION}`;

const LEGACY_RUNTIME_STORE_KEYS = [
  "runnerTradeSystem:runtime:RUNNER_TS_V1_2_HOT_ONLY_SHADOW_FIX"
];

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

// ================= LIVE FUNNEL POLICY =================
// Alleen scanner-hot runners mogen live entry worden.
// Alles buiten hot runner blijft shadow/learning-only.
const LIVE_ONLY_HOT_RUNNER = true;

const LIVE_SCANNER_HOT_FLOWS = new Set([
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
      adds: 0,
      exits: 0,

      wins: 0,
      losses: 0,

      waitReasons: {},
      entryTypes: {},
      actionCounts: {},

      closedTrades: [],
      featureRows: [],
      shadowRows: [],

      lastOptimizerReportAt: 0
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

  vercelLog("warn", "RUNTIME_RESET", {
    reason: "strategy_version_changed"
  });
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

function replaceMapContents(targetMap, entries) {
  targetMap.clear();

  if (!Array.isArray(entries)) return;

  for (const item of entries) {
    if (!Array.isArray(item) || item.length < 2) continue;
    targetMap.set(item[0], item[1]);
  }
}

function trimStats() {
  if (!Array.isArray(stats.closedTrades)) stats.closedTrades = [];
  if (!Array.isArray(stats.featureRows)) stats.featureRows = [];
  if (!Array.isArray(stats.shadowRows)) stats.shadowRows = [];

  stats.closedTrades = stats.closedTrades.slice(-MAX_CLOSED_ROWS);
  stats.featureRows = stats.featureRows.slice(-MAX_FEATURE_ROWS);
  stats.shadowRows = stats.shadowRows.slice(-SHADOW_MAX_ROWS);

  stats.waitReasons = stats.waitReasons || {};
  stats.entryTypes = stats.entryTypes || {};
  stats.actionCounts = stats.actionCounts || {};
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

function hydrateRuntimeState(payload, options = {}) {
  const allowVersionMismatch = options.allowVersionMismatch === true;

  if (!payload) return false;

  if (!allowVersionMismatch && payload.strategyVersion !== STRATEGY_VERSION) {
    return false;
  }

  replaceMapContents(memory, payload.memory);
  replaceMapContents(cooldownMap, payload.cooldownMap);
  replaceMapContents(symbolCooldownMap, payload.symbolCooldownMap);
  replaceMapContents(notifyState, payload.notifyState);

  Object.assign(stats, createRuntimeState().stats, payload.stats || {});

  // Force current code version after migration.
  runtimeState.strategyVersion = STRATEGY_VERSION;
  stats.strategyVersion = STRATEGY_VERSION;

  trimStats();

  runtimeState.durableLoadedAt = Date.now();

  vercelLog("info", "RUNTIME_LOADED", {
    migratedFromVersion: payload.strategyVersion || null,
    openPositions: memory.size,
    closedTrades: stats.closedTrades.length,
    featureRows: stats.featureRows.length,
    shadowRows: stats.shadowRows.length
  });

  return true;
}

function getRuntimePayloadWeight(payload) {
  if (!payload) return 0;

  const memoryWeight = Array.isArray(payload.memory) ? payload.memory.length * 100 : 0;
  const closedWeight = Array.isArray(payload.stats?.closedTrades) ? payload.stats.closedTrades.length : 0;
  const shadowWeight = Array.isArray(payload.stats?.shadowRows) ? payload.stats.shadowRows.length : 0;
  const featureWeight = Array.isArray(payload.stats?.featureRows) ? payload.stats.featureRows.length * 0.1 : 0;

  return memoryWeight + closedWeight + shadowWeight + featureWeight;
}

function parseRuntimePayload(result) {
  if (!result) return null;

  try {
    return typeof result === "string"
      ? JSON.parse(result)
      : result;
  } catch {
    return null;
  }
}

async function loadDurableRuntimeState() {
  if (!hasRedis()) {
    vercelDebug("RUNTIME_LOAD_SKIPPED", {
      reason: "redis_not_configured"
    });
    return false;
  }

  try {
    const forceLegacy = String(process.env.RUNNER_FORCE_LEGACY_RUNTIME_MIGRATION || "false").toLowerCase() === "true";

    const currentResult = await redisCommand(["GET", RUNTIME_STORE_KEY]);
    const currentPayload = parseRuntimePayload(currentResult);
    const currentWeight = getRuntimePayloadWeight(currentPayload);

    if (currentPayload && !forceLegacy && currentPayload.strategyVersion === STRATEGY_VERSION && currentWeight > 0) {
      return hydrateRuntimeState(currentPayload);
    }

    let bestLegacyPayload = null;
    let bestLegacyKey = null;
    let bestLegacyWeight = 0;

    for (const legacyKey of LEGACY_RUNTIME_STORE_KEYS) {
      const legacyResult = await redisCommand(["GET", legacyKey]);
      const legacyPayload = parseRuntimePayload(legacyResult);
      const legacyWeight = getRuntimePayloadWeight(legacyPayload);

      if (!legacyPayload || legacyWeight <= bestLegacyWeight) continue;

      bestLegacyPayload = legacyPayload;
      bestLegacyKey = legacyKey;
      bestLegacyWeight = legacyWeight;
    }

    const shouldUseLegacy =
      bestLegacyPayload &&
      (
        forceLegacy ||
        !currentPayload ||
        currentWeight === 0 ||
        bestLegacyWeight > currentWeight
      );

    if (shouldUseLegacy) {
      const migrated = hydrateRuntimeState(bestLegacyPayload, {
        allowVersionMismatch: true
      });

      if (migrated) {
        vercelLog("warn", "RUNTIME_MIGRATED_FROM_LEGACY_KEY", {
          fromKey: bestLegacyKey,
          toKey: RUNTIME_STORE_KEY,
          fromVersion: bestLegacyPayload?.strategyVersion || null,
          toVersion: STRATEGY_VERSION,
          currentWeight,
          legacyWeight: bestLegacyWeight,
          openPositions: memory.size,
          closedTrades: stats.closedTrades.length,
          shadowRows: stats.shadowRows.length
        });

        await saveDurableRuntimeState();
        return true;
      }
    }

    if (currentPayload && currentPayload.strategyVersion === STRATEGY_VERSION) {
      return hydrateRuntimeState(currentPayload);
    }

    vercelDebug("RUNTIME_LOAD_EMPTY");
    return false;
  } catch (err) {
    vercelError("RUNTIME_LOAD_FAILED", err);
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

    vercelDebug("RUNTIME_SAVED", {
      openPositions: memory.size,
      closedTrades: stats.closedTrades.length,
      shadowRows: stats.shadowRows.length
    });

    return true;
  } catch (err) {
    vercelError("RUNTIME_SAVE_FAILED", err);
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
    } catch (err) {
      vercelError("RUNTIME_LOCK_ATTEMPT_FAILED", err, {
        attempt
      });
    }

    await sleep(DURABLE_LOCK_RETRY_MS);
  }

  return false;
}

async function releaseRuntimeLock(owner) {
  if (!hasRedis()) return false;

  try {
    const currentOwner = await redisCommand(["GET", RUNTIME_LOCK_KEY]);

    if (currentOwner === owner) {
      await redisCommand(["DEL", RUNTIME_LOCK_KEY]);
      return true;
    }

    return false;
  } catch (err) {
    vercelError("RUNTIME_LOCK_RELEASE_FAILED", err);
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
  return Math.max(min, Math.min(max, safeNumber(value, 0)));
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
  return safeNumber(value, 0).toFixed(2);
}

function incrementCounter(map, key) {
  const k = String(key || "UNKNOWN").toUpperCase();
  map[k] = safeNumber(map[k], 0) + 1;
}

function stageRank(stage) {
  const s = String(stage || "").toLowerCase();

  if (s === "entry") return 3;
  if (s === "almost") return 2;
  if (s === "buildup") return 1;

  return 0;
}

function cleanExpiredGuards() {
  const now = Date.now();

  for (const [key, until] of cooldownMap.entries()) {
    if (now >= safeNumber(until, 0)) cooldownMap.delete(key);
  }

  for (const [key, until] of symbolCooldownMap.entries()) {
    if (now >= safeNumber(until, 0)) symbolCooldownMap.delete(key);
  }

  for (const [key, value] of notifyState.entries()) {
    if (!String(key).startsWith("EXIT_")) continue;
    if (now - safeNumber(value, 0) > EXIT_NOTIFY_DEDUP_TTL_MS) notifyState.delete(key);
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

function isObAgainstSide(ob, side) {
  const s = normalizeSide(side);

  return (
    (s === "bull" && ob?.bias === "BEARISH") ||
    (s === "bear" && ob?.bias === "BULLISH")
  );
}

function isStructureAligned(structure, side) {
  const trend = String(structure?.trend || structure?.runnerStructure || "UNKNOWN").toUpperCase();
  const s = normalizeSide(side);

  if (trend === "UNKNOWN" || trend === "RANGE" || trend === "NEUTRAL") return true;
  if (s === "bull") return trend !== "BEARISH";
  return trend !== "BULLISH";
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

function getRegimeForConfluence(regimeObj, scannerRegime) {
  const raw = String(regimeObj?.level || regimeObj || scannerRegime || "MEDIUM").toUpperCase();

  if (raw === "HIGH_VOL" || raw === "HIGH") return "HIGH";
  if (raw === "LOW_VOL" || raw === "LOW") return "LOW";

  return "MEDIUM";
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
    const priorityDiff = getActionPriority(b) - getActionPriority(a);
    if (priorityDiff !== 0) return priorityDiff;

    const confDiff = safeNumber(b.confluence, 0) - safeNumber(a.confluence, 0);
    if (confDiff !== 0) return confDiff;

    return safeNumber(b.score, 0) - safeNumber(a.score, 0);
  });
}

function chunkArray(arr, size) {
  const chunks = [];

  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }

  return chunks;
}

function getScannerFlow(c) {
  return normalizeFlow(c?.scannerFlow || c?.flow || c?.flowType || "NEUTRAL");
}

function isScannerHotRunnerCandidate(c) {
  const scannerFlow = getScannerFlow(c);
  const stage = String(c?.stage || "").toLowerCase();

  if (c?.fromOpenPosition) return true;
  if (stage !== "entry") return false;

  return LIVE_SCANNER_HOT_FLOWS.has(scannerFlow);
}

function getLiveFunnelBlockReason(c) {
  if (!LIVE_ONLY_HOT_RUNNER) return null;
  if (c?.fromOpenPosition) return null;

  if (!isScannerHotRunnerCandidate(c)) {
    return "SCANNER_FLOW_NOT_HOT_RUNNER";
  }

  return null;
}

// ================= CANDLES =================
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
    finalCandidates: 0,
    openPositionsInjected: 0,
    liveEligible: 0,
    shadowOnly: 0,
    removed: {
      MISSING: 0,
      BAD_SIDE: 0,
      UI_ONLY: 0,
      BAD_STAGE: 0,
      SCORE_TOO_LOW: 0
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
      scannerFlow: getScannerFlow(raw),
      moveScore: safeNumber(raw?.moveScore ?? raw?.score, 0)
    };

    normalized.liveEligible = isScannerHotRunnerCandidate(normalized);
    normalized.shadowOnly = !normalized.liveEligible;

    const key = `${symbol}_${side}`;
    const prev = map.get(key);

    if (!prev) {
      map.set(key, normalized);
      continue;
    }

    const liveDiff = Number(Boolean(normalized.liveEligible)) - Number(Boolean(prev.liveEligible));

    if (liveDiff > 0) {
      map.set(key, normalized);
      continue;
    }

    const stageDiff = stageRank(normalized.stage) - stageRank(prev.stage);

    if (stageDiff > 0) {
      map.set(key, normalized);
      continue;
    }

    if (
      stageDiff === 0 &&
      safeNumber(normalized.moveScore, 0) > safeNumber(prev.moveScore, 0)
    ) {
      map.set(key, normalized);
    }
  }

  return Array.from(map.values())
    .sort((a, b) => {
      if (a.liveEligible !== b.liveEligible) return a.liveEligible ? -1 : 1;
      return safeNumber(b.moveScore, 0) - safeNumber(a.moveScore, 0);
    });
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
      pushPrefilterReject(prefilter, "BAD_SIDE");
      continue;
    }

    if (Boolean(c?.uiOnly)) {
      pushPrefilterReject(prefilter, "UI_ONLY");
      continue;
    }

    const stage = String(c?.stage || "").toLowerCase();

    if (stage !== "entry" && stage !== "almost") {
      pushPrefilterReject(prefilter, "BAD_STAGE");
      continue;
    }

    const score = safeNumber(c?.moveScore ?? c?.score, 0);

    if (score < MIN_SCORE) {
      pushPrefilterReject(prefilter, "SCORE_TOO_LOW");
      continue;
    }

    const enriched = {
      ...c,
      scannerFlow: getScannerFlow(c),
      liveEligible: isScannerHotRunnerCandidate(c)
    };

    enriched.shadowOnly = !enriched.liveEligible;

    accepted.push(enriched);
  }

  const map = new Map();

  for (const c of dedupeCandidates(accepted)) {
    const key = `${normalizeBaseSymbol(c.symbol)}_${normalizeSide(c.side)}`;

    map.set(key, {
      ...c,
      analysisType: c.liveEligible ? "DEEP" : "SHADOW_ONLY",
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
      fromOpenPosition: true,
      scannerFlow: pos.flow || "OPEN_POSITION",
      liveEligible: true,
      shadowOnly: false
    });
  }

  const candidates = Array.from(map.values()).sort((a, b) => {
    if (a.fromOpenPosition !== b.fromOpenPosition) {
      return a.fromOpenPosition ? -1 : 1;
    }

    if (a.liveEligible !== b.liveEligible) {
      return a.liveEligible ? -1 : 1;
    }

    return safeNumber(b.moveScore, 0) - safeNumber(a.moveScore, 0);
  });

  prefilter.acceptedCount = accepted.length;
  prefilter.finalCandidates = candidates.length;
  prefilter.liveEligible = candidates.filter(c => c.liveEligible).length;
  prefilter.shadowOnly = candidates.filter(c => c.shadowOnly).length;

  return {
    candidates,
    prefilter
  };
}

// ================= RUNNER FLOW =================
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

// ================= RISK / RR =================
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

function getDynamicRrFloor({ flow, volatility, entryType }) {
  const f = normalizeFlow(flow);
  const v = String(volatility || "MEDIUM").toUpperCase();
  const type = String(entryType || "").toUpperCase();

  let floor = RUNNER_B_MIN_RR;

  if (type === "RUNNER_A_BREAKOUT") floor = RUNNER_A_MIN_RR;
  if (type === "RUNNER_C_SQUEEZE") floor = RUNNER_C_MIN_RR;

  if (f === "SQUEEZE") floor = Math.max(floor, 1.20);
  if (f === "RUNNING") floor = Math.max(floor, 1.12);
  if (f === "BUILDING") floor = Math.max(floor, 1.18);

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
    scannerFlow: c?.scannerFlow || getScannerFlow(c),
    liveEligible: Boolean(c?.liveEligible),
    shadowOnly: Boolean(c?.shadowOnly),
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

function hasRiskGeometryPayload(payload) {
  const entry = safeNumber(payload?.entry, 0);
  const sl = safeNumber(payload?.sl, 0);
  const tp = safeNumber(payload?.tp, 0);

  return (
    entry > 0 &&
    sl > 0 &&
    tp > 0 &&
    Math.abs(entry - sl) > 0
  );
}

function getShadowDedupeKey(payload) {
  return [
    normalizeBaseSymbol(payload?.symbol),
    normalizeSide(payload?.side),
    String(payload?.source || "UNKNOWN").toUpperCase(),
    String(payload?.scannerFlow || "UNKNOWN").toUpperCase(),
    String(payload?.flow || "UNKNOWN").toUpperCase(),
    String(payload?.rsiZone || "UNKNOWN").toUpperCase(),
    String(payload?.entryType || payload?.runnerEntryType || "UNKNOWN").toUpperCase(),
    safeNumber(payload?.entry, 0).toFixed(10),
    safeNumber(payload?.sl, 0).toFixed(10),
    safeNumber(payload?.tp, 0).toFixed(10)
  ].join("|");
}

function hasOpenShadowDuplicate(payload) {
  const key = getShadowDedupeKey(payload);
  const since = Date.now() - 30 * 60 * 1000;

  return (stats.shadowRows || []).some(row => {
    return (
      row.shadowDedupeKey === key &&
      row.status === "OPEN" &&
      safeNumber(row.createdAt, 0) >= since
    );
  });
}

function createShadowFromPayload(payload, source = "SHADOW") {
  if (!payload) return;
  if (payload.fromOpenPosition) return;
  if (!hasRiskGeometryPayload(payload)) return;

  const enriched = {
    ...payload,
    source,
    shadowDedupeKey: getShadowDedupeKey({
      ...payload,
      source
    })
  };

  if (hasOpenShadowDuplicate(enriched)) return;

  const entry = safeNumber(enriched.entry, 0);

  stats.shadowRows.push({
    ...enriched,

    id: `${source.toLowerCase()}_${enriched.symbol}_${enriched.side}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,

    status: "OPEN",
    monitorType: "RUNNER_HORIZON_MFE_MAE",

    createdAt: Date.now(),
    monitorUntil: Date.now() + SHADOW_MONITOR_MS,
    lastCheckedAt: 0,

    ticks: 0,

    exit: null,
    exitR: null,
    pnlPct: null,

    horizonExitR: null,
    horizonPnlPct: null,

    hitTP: false,
    hitSL: false,

    win: false,
    loss: false,
    flat: false,

    mfeR: 0,
    maeR: 0,

    maxPrice: entry,
    minPrice: entry,

    maxPnlPct: 0,
    minPnlPct: 0
  });

  if (stats.shadowRows.length > SHADOW_MAX_ROWS) {
    stats.shadowRows = stats.shadowRows.slice(-SHADOW_MAX_ROWS);
  }
}

function inferRunnerCandidateSetup({ c, flow }) {
  const f = normalizeFlow(flow?.type || c?.flow);

  if (f === "SQUEEZE") {
    return {
      setupClass: "RUNNER_C",
      entryType: "RUNNER_C_SQUEEZE",
      targetR: RUNNER_C_TARGET_R,
      minConfluence: RUNNER_C_MIN_CONFLUENCE,
      minSniper: RUNNER_C_MIN_SNIPER,
      minRR: RUNNER_C_MIN_RR
    };
  }

  if (HOT_RUNNER_FLOWS.has(f)) {
    return {
      setupClass: "RUNNER_A",
      entryType: "RUNNER_A_BREAKOUT",
      targetR: RUNNER_A_TARGET_R,
      minConfluence: RUNNER_A_MIN_CONFLUENCE,
      minSniper: RUNNER_A_MIN_SNIPER,
      minRR: RUNNER_A_MIN_RR
    };
  }

  return {
    setupClass: "RUNNER_B",
    entryType: "RUNNER_B_CONTINUATION",
    targetR: RUNNER_B_TARGET_R,
    minConfluence: RUNNER_B_MIN_CONFLUENCE,
    minSniper: RUNNER_B_MIN_SNIPER,
    minRR: RUNNER_B_MIN_RR
  };
}

function buildRunnerScanObservation({
  c,
  ctx,
  risk,
  targets,
  baseRR,
  finalRR,
  setup,
  strategy,
  rsiSignal,
  rsiZone,
  continuationAllowed,
  pullbackAllowed,
  rsiExhaustedAgainstSide,
  structureAligned,
  hasLiquidationData,
  runId
}) {
  const candidateSetup = setup?.setupClass && setup.setupClass !== "NONE"
    ? setup
    : inferRunnerCandidateSetup({
        c,
        flow: ctx.flow
      });

  const entry = safeNumber(c?.price, 0);
  const sl = safeNumber(risk?.sl, 0);
  const tp = safeNumber(targets?.tp, 0);

  const payload = {
    ...buildCommonPayload(c, ctx),

    id: `scan_${runId}_${normalizeBaseSymbol(c.symbol)}_${normalizeSide(c.side)}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,

    source: "SCAN",
    action: "OBSERVE",
    reason: "SCAN_OBSERVED",

    setupClass: candidateSetup.setupClass,
    entryType: candidateSetup.entryType,
    runnerEntryType: candidateSetup.entryType,

    strategy: String(strategy || "UNKNOWN").toUpperCase(),

    entry,
    sl,
    initialSl: sl,
    tp,
    partialTp: safeNumber(targets?.partialTp, 0),
    breakevenAt: safeNumber(targets?.breakevenAt, 0),
    trailStart: safeNumber(targets?.trailStart, 0),

    rr: formatRR(finalRR || baseRR),
    baseRR: safeNumber(baseRR, 0),
    plannedRR: safeNumber(finalRR || baseRR, 0),
    targetR: safeNumber(candidateSetup.targetR, 0),

    minConfluence: candidateSetup.minConfluence,
    minSniper: candidateSetup.minSniper,
    minRR: candidateSetup.minRR,

    hasRiskGeometry:
      entry > 0 &&
      sl > 0 &&
      tp > 0 &&
      Math.abs(entry - sl) > 0,

    rsiValid: Boolean(rsiSignal?.valid),
    rsiBlocked: Boolean(rsiSignal?.blocked),
    rsiContinuationAllowed: Boolean(continuationAllowed),
    rsiPullbackAllowed: Boolean(pullbackAllowed),
    rsiExhaustedAgainstSide: Boolean(rsiExhaustedAgainstSide),

    structureAligned: Boolean(structureAligned),

    obFetchFailed: Boolean(ctx.ob?.fetchFailed),
    spoof: Boolean(ctx.ob?.spoof),
    obAgainst: isObAgainstSide(ctx.ob, c.side),

    hasLiquidationData: Boolean(hasLiquidationData),

    change1h: safeNumber(c.change1h, 0),
    change24: safeNumber(c.change24, 0),

    detectedFlow: ctx.flow?.type || c.flow || "UNKNOWN",
    scannerHot: isScannerHotRunnerCandidate(c),

    runId,

    ts: Date.now()
  };

  return payload;
}

function recordScanObservation(payload) {
  if (!payload?.symbol || !payload?.side) return;

  recordFeatureRow(payload);
  createShadowFromPayload(payload, "SCAN_SHADOW");
}

function createShadowFromWait(payload) {
  if (!payload || payload.action !== "WAIT") return;

  createShadowFromPayload(payload, "SHADOW");
}

async function logSystem(payload, shouldLog = true) {
  if (!shouldLog || !payload) return false;

  try {
    await logSystemEvent(payload);
    return true;
  } catch (err) {
    vercelError("SYSTEM_LOG_FAILED", err, {
      symbol: payload?.symbol || null,
      side: payload?.side || null,
      action: payload?.action || null,
      reason: payload?.reason || null,
      setupClass: payload?.setupClass || null,
      entryType: payload?.entryType || payload?.runnerEntryType || null
    });

    return false;
  }
}

function buildWait(c, reason, ctx = {}) {
  incrementCounter(stats.waitReasons, reason);

  const risk = ctx.risk || {};
  const setup = ctx.setup || {};

  const entry = safeNumber(risk.entry ?? c?.price, 0);
  const sl = safeNumber(risk.sl, 0);
  const tp = safeNumber(risk.tp, 0);

  const rrValue = Number.isFinite(Number(ctx.rr))
    ? safeNumber(ctx.rr, 0)
    : Number.isFinite(Number(ctx.requiredRR))
      ? safeNumber(ctx.requiredRR, 0)
      : 0;

  const payload = {
    ...buildCommonPayload(c, ctx),

    source: "WAIT",
    action: "WAIT",
    reason: String(reason || "UNKNOWN").toUpperCase(),

    setupClass: setup.setupClass || ctx.setupClass || "NONE",
    entryType: setup.entryType || ctx.entryType || ctx.runnerEntryType || null,
    runnerEntryType: setup.entryType || ctx.runnerEntryType || ctx.entryType || null,

    entry: entry || null,
    sl: sl || null,
    initialSl: sl || null,
    tp: tp || null,

    rr: rrValue ? formatRR(rrValue) : "0.00",
    plannedRR: rrValue,
    baseRR: safeNumber(ctx.baseRR ?? ctx.rr, 0),
    targetR: safeNumber(setup.targetR ?? ctx.targetR, 0),

    requiredConfluence: ctx.requiredConfluence ?? null,
    requiredSniper: ctx.requiredSniper ?? null,
    requiredRR: ctx.requiredRR ?? null,

    minConfluence: setup.minConfluence ?? ctx.requiredConfluence ?? null,
    minSniper: setup.minSniper ?? ctx.requiredSniper ?? null,
    minRR: setup.minRR ?? ctx.requiredRR ?? null,

    hasRiskGeometry:
      entry > 0 &&
      sl > 0 &&
      tp > 0 &&
      Math.abs(entry - sl) > 0,

    ts: Date.now()
  };

  recordFeatureRow(payload);
  createShadowFromWait(payload);

  return payload;
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

  pos.highestPrice = Math.max(safeNumber(pos.highestPrice, pos.entry), current);
  pos.lowestPrice = Math.min(safeNumber(pos.lowestPrice, pos.entry), current);

  return pos;
}

function updateTrailingStop(pos) {
  if (!pos?.trailingActive) {
    return {
      changed: false,
      pos
    };
  }

  const risk = getInitialRisk(pos);
  if (!risk) {
    return {
      changed: false,
      pos
    };
  }

  const side = normalizeSide(pos.side);
  const oldSl = safeNumber(pos.sl, 0);
  let nextSl = oldSl;

  if (side === "bull") {
    const highest = safeNumber(pos.highestPrice, pos.entry);
    nextSl = highest - risk * TRAIL_DISTANCE_R;

    if (nextSl <= oldSl) {
      return {
        changed: false,
        pos
      };
    }
  } else {
    const lowest = safeNumber(pos.lowestPrice, pos.entry);
    nextSl = lowest + risk * TRAIL_DISTANCE_R;

    if (oldSl && nextSl >= oldSl) {
      return {
        changed: false,
        pos
      };
    }
  }

  const changePct = oldSl > 0
    ? Math.abs(nextSl - oldSl) / oldSl
    : 1;

  if (changePct < TRAIL_MIN_CHANGE_PCT) {
    return {
      changed: false,
      pos
    };
  }

  pos.trailPrice = nextSl;
  pos.sl = nextSl;
  pos.lastTrailAt = Date.now();

  return {
    changed: true,
    oldSl,
    newSl: nextSl,
    pos
  };
}

function buildPositionAction(action, reason, c, pos, ctx, extra = {}) {
  return {
    ...buildCommonPayload(c, ctx),

    action,
    reason,

    setupClass: pos.setupClass,
    entryType: pos.entryType,
    runnerEntryType: pos.entryType,

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

    adds: safeNumber(pos.adds, 0),

    ...extra
  };
}

function buildRunnerTargetsFromRisk(c, risk, targetR) {
  return buildRunnerTargets({
    entry: c.price,
    sl: risk.sl,
    side: c.side,
    targetR
  });
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
    scannerFlow: c.scannerFlow || getScannerFlow(c),
    liveEligible: Boolean(c.liveEligible),
    shadowOnly: Boolean(c.shadowOnly),

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
    sizeOpen: 1,

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
async function handleOpenPosition(c, pos, ctx, options = {}) {
  const shouldLog = options.log !== false;
  const notify = options.notify !== false;

  const side = normalizeSide(pos.side);
  const price = safeNumber(c.price, 0);
  const key = `${pos.symbol}_${pos.side}`;

  if (!price) {
    return buildPositionAction(
      "HOLD",
      "PRICE_INVALID_OPEN_POSITION",
      c,
      pos,
      ctx
    );
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
    incrementCounter(stats.actionCounts, "EXIT");

    if (exitR > 0) stats.wins++;
    if (exitR < 0) stats.losses++;

    const closedRow = {
      ...payload,
      createdAt: pos.createdAt,
      exitedAt: Date.now()
    };

    stats.closedTrades.push(closedRow);
    stats.closedTrades = stats.closedTrades.slice(-MAX_CLOSED_ROWS);

    recordFeatureRow(payload);
    vercelLog("info", "COHORT_OUTCOME", buildCohortOutcomeLog(closedRow));

    // Eerst state opruimen, daarna pas externe logging/notificatie.
    // Hierdoor krijg je geen herhaalde Discord SL exits als logTrade/sendExit faalt.
    memory.delete(key);
    notifyState.delete(key);

    cooldownMap.set(key, Date.now() + COOLDOWN_MS);
    symbolCooldownMap.set(pos.symbol, Date.now() + SYMBOL_REENTRY_COOLDOWN_MS);

    if (shouldLog) {
      try {
        await logTrade({
          ...payload,
          result: exitR > 0 ? "WIN" : exitR < 0 ? "LOSS" : "FLAT",
          price,
          funding: pos.funding,
          regime: pos.regime,
          btcState: pos.btcState
        });
      } catch (err) {
        vercelError("TRADE_LOG_FAILED", err, {
          symbol: pos.symbol,
          side: pos.side,
          reason: exitReason
        });
      }
    }

    const exitNotifyKey = `EXIT_${key}_${exitReason}_${Number(executionPrice).toFixed(10)}`;

    if (notify && !notifyState.get(exitNotifyKey)) {
      try {
        await sendExit({
          symbol: pos.symbol,
          side: pos.side,
          reason: exitReason,
          entry: pos.entry,
          sl: pos.sl,
          tp: pos.tp,
          rr: pos.rr,
          exit: executionPrice,
          exitR: Number(exitR.toFixed(3)),
          pnlPct: Number(pnlPct.toFixed(3)),
          grade: pos.setupClass === "RUNNER_B" ? "B" : "A"
        });

        notifyState.set(exitNotifyKey, Date.now());
      } catch (err) {
        vercelError("EXIT_NOTIFY_FAILED", err, {
          symbol: pos.symbol,
          side: pos.side,
          reason: exitReason
        });
      }
    }

    vercelLog("info", "EXIT", {
      symbol: pos.symbol,
      side: pos.side,
      reason: exitReason,
      setupClass: pos.setupClass,
      entryType: pos.entryType,
      entry: pos.entry,
      exit: executionPrice,
      triggerPrice: price,
      exitR,
      pnlPct,
      mfeR: pos.mfeR,
      maeR: pos.maeR,
      partialTaken: pos.partialTaken,
      breakEvenMoved: pos.breakEvenMoved,
      trailingActive: pos.trailingActive,
      adds: pos.adds
    });

    return payload;
  }

  if (!pos.partialTaken && safeNumber(pos.currentR, 0) >= PARTIAL_TP_R) {
    pos.partialTaken = true;
    pos.partialTakenAt = Date.now();
    pos.sizeOpen = 1 - PARTIAL_SIZE;

    stats.partials++;
    incrementCounter(stats.actionCounts, "PARTIAL_TP");

    const payload = buildPositionAction(
      "PARTIAL_TP",
      "PARTIAL_TP_REACHED",
      c,
      pos,
      ctx,
      {
        price,
        partialSize: PARTIAL_SIZE,
        remainingSize: pos.sizeOpen
      }
    );

    memory.set(key, pos);
    recordFeatureRow(payload);

    if (shouldLog) {
      await logSystem(payload, true);
    }

    vercelLog("info", "PARTIAL_TP", {
      symbol: pos.symbol,
      side: pos.side,
      setupClass: pos.setupClass,
      currentR: pos.currentR,
      mfeR: pos.mfeR,
      price,
      partialSize: PARTIAL_SIZE,
      remainingSize: pos.sizeOpen
    });

    return payload;
  }

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
      incrementCounter(stats.actionCounts, "MOVE_BE");

      const payload = buildPositionAction(
        "MOVE_BE",
        "BREAKEVEN_LOCKED",
        c,
        pos,
        ctx,
        {
          price,
          oldSl: pos.slBeforeBreakEven,
          newSl
        }
      );

      memory.set(key, pos);
      recordFeatureRow(payload);

      if (shouldLog) {
        await logSystem(payload, true);
      }

      vercelLog("info", "MOVE_BE", {
        symbol: pos.symbol,
        side: pos.side,
        setupClass: pos.setupClass,
        currentR: pos.currentR,
        oldSl: pos.slBeforeBreakEven,
        newSl
      });

      return payload;
    }
  }

  if (safeNumber(pos.currentR, 0) >= TRAIL_START_R) {
    const wasActive = Boolean(pos.trailingActive);
    pos.trailingActive = true;

    const trailUpdate = updateTrailingStop(pos);

    if (trailUpdate.changed || !wasActive) {
      stats.trails++;
      incrementCounter(stats.actionCounts, "TRAIL");

      const payload = buildPositionAction(
        "TRAIL",
        wasActive ? "TRAIL_UPDATED" : "TRAIL_STARTED",
        c,
        pos,
        ctx,
        {
          price,
          oldSl: trailUpdate.oldSl ?? null,
          newSl: trailUpdate.newSl ?? pos.sl,
          trailPrice: pos.trailPrice ?? pos.sl
        }
      );

      memory.set(key, pos);
      recordFeatureRow(payload);

      if (shouldLog) {
        await logSystem(payload, true);
      }

      vercelLog("info", "TRAIL", {
        symbol: pos.symbol,
        side: pos.side,
        setupClass: pos.setupClass,
        currentR: pos.currentR,
        oldSl: trailUpdate.oldSl ?? null,
        newSl: trailUpdate.newSl ?? pos.sl
      });

      return payload;
    }
  }

  const sniperScore = safeNumber(ctx.sniper?.score ?? ctx.sniper?.runnerScore, 0);

  const canAdd =
    safeNumber(pos.adds, 0) < safeNumber(pos.maxAdds, 0) &&
    safeNumber(pos.currentR, 0) >= ADD_MIN_R &&
    safeNumber(ctx.confluence, 0) >= ADD_MIN_CONFLUENCE &&
    sniperScore >= ADD_MIN_SNIPER &&
    HOT_RUNNER_FLOWS.has(normalizeFlow(ctx.flow?.type));

  if (canAdd) {
    pos.adds = safeNumber(pos.adds, 0) + 1;
    pos.lastAdd = price;
    pos.lastAddAt = Date.now();

    stats.adds++;
    incrementCounter(stats.actionCounts, "ADD");

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
    recordFeatureRow(payload);

    if (shouldLog) {
      await logSystem(payload, true);
    }

    vercelLog("info", "ADD", {
      symbol: pos.symbol,
      side: pos.side,
      setupClass: pos.setupClass,
      currentR: pos.currentR,
      confluence: ctx.confluence,
      sniperScore,
      adds: pos.adds
    });

    return payload;
  }

  pos.updatedAt = Date.now();
  memory.set(key, pos);

  return buildPositionAction(
    "HOLD",
    "RUNNING",
    c,
    pos,
    ctx
  );
}

// ================= FETCH COIN DATA =================
function updateOrderbookMemorySafe(symbol, raw, analyzed) {
  try {
    updateOrderbookMemory(symbol, raw, analyzed);
  } catch (err) {
    vercelError("ORDERBOOK_MEMORY_UPDATE_FAILED", err, {
      symbol
    });
  }
}

async function fetchCoinData(c, runId) {
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
  } catch (err) {
    vercelDebug("ORDERBOOK_FETCH_FAILED", {
      runId,
      symbol,
      error: err?.message || String(err)
    });

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

// ================= SHADOW OUTCOMES =================
function calculateShadowR(row, price) {
  const entry = safeNumber(row?.entry, 0);
  const sl = safeNumber(row?.sl, 0);
  const current = safeNumber(price, 0);

  if (!entry || !sl || !current) return null;

  const risk = Math.abs(entry - sl);
  if (!risk) return null;

  const move = normalizeSide(row.side) === "bear"
    ? entry - current
    : current - entry;

  return move / risk;
}

function calculateShadowPnlPct(row, price) {
  const entry = safeNumber(row?.entry, 0);
  const current = safeNumber(price, 0);

  if (!entry || !current) return 0;

  const pnl = normalizeSide(row.side) === "bear"
    ? ((entry - current) / entry) * 100
    : ((current - entry) / entry) * 100;

  return Number.isFinite(pnl) ? pnl : 0;
}

function completeShadow(row, status, price, r, pnlPct) {
  row.status = status;
  row.exit = safeNumber(price, 0);

  row.exitR = Number.isFinite(Number(r))
    ? Number(Number(r).toFixed(3))
    : null;

  row.pnlPct = Number(safeNumber(pnlPct, 0).toFixed(3));

  row.horizonExitR = row.exitR;
  row.horizonPnlPct = row.pnlPct;

  row.completedAt = Date.now();

  row.win = Number(row.exitR || 0) > 0;
  row.loss = Number(row.exitR || 0) < 0;
  row.flat = !row.win && !row.loss;

  return row;
}

function updateShadowWithPrice(row, price) {
  if (!row || row.status !== "OPEN") return row;

  const current = safeNumber(price, 0);
  if (!current) return row;

  const r = calculateShadowR(row, current);
  const pnlPct = calculateShadowPnlPct(row, current);

  row.ticks = safeNumber(row.ticks, 0) + 1;
  row.lastCheckedAt = Date.now();

  row.maxPrice = Math.max(safeNumber(row.maxPrice, current), current);
  row.minPrice = Math.min(safeNumber(row.minPrice, current), current);

  row.maxPnlPct = Math.max(safeNumber(row.maxPnlPct, 0), pnlPct);
  row.minPnlPct = Math.min(safeNumber(row.minPnlPct, 0), pnlPct);

  if (Number.isFinite(Number(r))) {
    row.mfeR = Math.max(safeNumber(row.mfeR, 0), r);
    row.maeR = Math.min(safeNumber(row.maeR, 0), r);
  }

  const side = normalizeSide(row.side);

  const hitTP = side === "bull"
    ? current >= safeNumber(row.tp, 0)
    : current <= safeNumber(row.tp, 0);

  const hitSL = side === "bull"
    ? current <= safeNumber(row.sl, 0)
    : current >= safeNumber(row.sl, 0);

  if (hitTP) {
    row.hitTP = true;

    // Niet sluiten op TP. Runner optimizer heeft MFE nodig voor hogere targetR tests.
  }

  if (hitSL) {
    row.hitSL = true;
    return completeShadow(row, "HIT_SL", current, r, pnlPct);
  }

  if (Date.now() >= safeNumber(row.monitorUntil, 0)) {
    return completeShadow(row, "HORIZON_DONE", current, r, pnlPct);
  }

  return row;
}

async function fetchShadowPriceMap(rows) {
  const symbols = Array.from(
    new Set(
      rows
        .map(row => normalizeBitgetSymbol(row?.rawBitgetSymbol || row?.symbol))
        .filter(Boolean)
    )
  );

  const map = new Map();

  for (const chunk of chunkArray(symbols, 8)) {
    await Promise.all(chunk.map(async symbol => {
      try {
        const raw = await cachedFetch(
          `runner_shadow_ob_${symbol}`,
          () => fetchOrderBook(symbol),
          8000
        );

        const analyzed = raw ? analyzeOrderBookAdvanced(raw) : null;
        const price = safeNumber(analyzed?.mid, 0);

        if (price > 0) {
          map.set(symbol, price);
        }
      } catch {}
    }));
  }

  return map;
}

async function updateShadowOutcomes() {
  if (!Array.isArray(stats.shadowRows) || !stats.shadowRows.length) return;

  const active = stats.shadowRows
    .filter(row => row?.status === "OPEN")
    .slice(-SHADOW_MAX_ROWS)
    .slice(0, SHADOW_MAX_ACTIVE_PER_RUN);

  if (!active.length) return;

  const priceMap = await fetchShadowPriceMap(active);

  let updated = 0;
  let completed = 0;

  for (const row of active) {
    const symbol = normalizeBitgetSymbol(row?.rawBitgetSymbol || row?.symbol);
    const price = safeNumber(priceMap.get(symbol), 0);

    if (!price) continue;

    const before = row.status;

    updateShadowWithPrice(row, price);

    updated++;

    if (before === "OPEN" && row.status !== "OPEN") {
      completed++;
    }
  }

  trimStats();
}

// ================= SETUP CLASSIFICATION =================
function classifyRunnerSetup({
  c,
  flow,
  sniper,
  confluence,
  rr,
  strategy
}) {
  const score = safeNumber(c.moveScore, 0);
  const sniperScore = safeNumber(sniper?.score ?? sniper?.runnerScore, 0);
  const f = normalizeFlow(flow?.type);

  if (
    f === "SQUEEZE" &&
    score >= RUNNER_C_MIN_SCORE &&
    confluence >= RUNNER_C_MIN_CONFLUENCE &&
    sniperScore >= RUNNER_C_MIN_SNIPER &&
    rr >= RUNNER_C_MIN_RR
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
    HOT_RUNNER_FLOWS.has(f) &&
    score >= RUNNER_A_MIN_SCORE &&
    confluence >= RUNNER_A_MIN_CONFLUENCE &&
    sniperScore >= RUNNER_A_MIN_SNIPER &&
    rr >= RUNNER_A_MIN_RR
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
    ["AGGRESSIVE", "TREND"].includes(String(strategy || "").toUpperCase()) &&
    RUNNER_FLOWS.has(f) &&
    score >= RUNNER_B_MIN_SCORE &&
    confluence >= RUNNER_B_MIN_CONFLUENCE &&
    sniperScore >= RUNNER_B_MIN_SNIPER &&
    rr >= RUNNER_B_MIN_RR
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

function getBadLiveCohortReason({ setup, flowType, rsiZone, obBias }) {
  const entryType = String(setup?.entryType || "").toUpperCase();
  const flow = normalizeFlow(flowType);
  const rsi = String(rsiZone || "UNKNOWN").toUpperCase();
  const ob = String(obBias || "UNKNOWN").toUpperCase();

  if (BLOCK_ENTRY_TYPES.has(entryType)) {
    return "ENTRY_TYPE_BLOCKED_RUNNER_B";
  }

  if (flow === "NEUTRAL") {
    return "BAD_COHORT_FLOW_NEUTRAL";
  }

  if (
    entryType === "RUNNER_C_SQUEEZE" &&
    ["LOWER_1", "LOWER_2", "LOWER_3"].includes(rsi)
  ) {
    return "BAD_COHORT_SQUEEZE_LOWER_RSI";
  }

  // Oude block bleef staan.
  if (
    entryType === "RUNNER_A_BREAKOUT" &&
    rsi === "MID" &&
    flow === "BREAKOUT" &&
    ob === "BULLISH"
  ) {
    return "BAD_COHORT_MID_BREAKOUT_OB_BULLISH";
  }

  // Nieuwe bad cohort uit logs:
  // TYPE=RUNNER_A_BREAKOUT|RSI=MID|FLOW=BREAKOUT|OB=BEARISH
  // sample 3, wins 0, losses 3, totalR -3.
  if (
    entryType === "RUNNER_A_BREAKOUT" &&
    rsi === "MID" &&
    flow === "BREAKOUT" &&
    ob === "BEARISH"
  ) {
    return "BAD_COHORT_MID_BREAKOUT_OB_BEARISH";
  }

  return null;
}

function getWatchLiveCohortReason({
  setup,
  flowType,
  rsiZone,
  obBias,
  confluence,
  sniperScore,
  runnerPressure
}) {
  const entryType = String(setup?.entryType || "").toUpperCase();
  const flow = normalizeFlow(flowType);
  const rsi = String(rsiZone || "UNKNOWN").toUpperCase();
  const ob = String(obBias || "UNKNOWN").toUpperCase();

  const isWatched =
    entryType === "RUNNER_A_BREAKOUT" &&
    rsi === "MID" &&
    flow === "RUNNING" &&
    ob === "NEUTRAL";

  if (!isWatched) return null;

  if (safeNumber(confluence, 0) < WATCH_MID_RUNNING_NEUTRAL_MIN_CONFLUENCE) {
    return "WATCH_COHORT_MID_RUNNING_OB_NEUTRAL_CONFLUENCE";
  }

  if (safeNumber(sniperScore, 0) < WATCH_MID_RUNNING_NEUTRAL_MIN_SNIPER) {
    return "WATCH_COHORT_MID_RUNNING_OB_NEUTRAL_SNIPER";
  }

  if (safeNumber(runnerPressure, 0) < WATCH_MID_RUNNING_NEUTRAL_MIN_PRESSURE) {
    return "WATCH_COHORT_MID_RUNNING_OB_NEUTRAL_PRESSURE";
  }

  return null;
}

// ================= OPTIMIZER BASIC REPORT =================
function pct(value) {
  return `${(safeNumber(value, 0) * 100).toFixed(1)}%`;
}

function avg(values) {
  const arr = values.map(Number).filter(Number.isFinite);
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function buildOptimizerReport() {
  const closed = Array.isArray(stats.closedTrades) ? stats.closedTrades : [];
  const shadows = Array.isArray(stats.shadowRows) ? stats.shadowRows : [];
  const completedShadows = shadows.filter(r => r.status !== "OPEN");

  const wins = safeNumber(stats.wins, 0);
  const losses = safeNumber(stats.losses, 0);
  const completed = wins + losses;

  const totalR = closed.reduce((sum, row) => sum + safeNumber(row.exitR, 0), 0);
  const totalPnlPct = closed.reduce((sum, row) => sum + safeNumber(row.pnlPct, 0), 0);

  const waitReasons = Object.entries(stats.waitReasons || {})
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  const entryTypes = Object.entries(stats.entryTypes || {})
    .map(([entryType, count]) => ({ entryType, count }))
    .sort((a, b) => b.count - a.count);

  const shadowWins = completedShadows.filter(r => r.win).length;
  const shadowLosses = completedShadows.filter(r => r.loss).length;
  const shadowCompleted = shadowWins + shadowLosses;

  return {
    tag: "RUNNER_OPTIMIZER_REPORT",
    profile: "RUNNER",
    strategyVersion: STRATEGY_VERSION,
    ts: Date.now(),

    sample: {
      runs: safeNumber(stats.runs, 0),
      entries: safeNumber(stats.entries, 0),
      exits: safeNumber(stats.exits, 0),
      closedTrades: closed.length,
      shadowRows: shadows.length,
      completedShadowRows: completedShadows.length,
      openPositions: memory.size,
      confidence:
        closed.length >= 50
          ? "HIGH"
          : closed.length >= 20
            ? "MEDIUM"
            : "LOW"
    },

    performance: {
      wins,
      losses,
      winrate: completed ? pct(wins / completed) : "0.0%",
      totalR: Number(totalR.toFixed(3)),
      avgR: closed.length ? Number((totalR / closed.length).toFixed(3)) : 0,
      totalPnlPct: Number(totalPnlPct.toFixed(3)),
      avgPnlPct: closed.length ? Number((totalPnlPct / closed.length).toFixed(3)) : 0,
      avgMfeR: Number(avg(closed.map(r => r.mfeR)).toFixed(3)),
      avgMaeR: Number(avg(closed.map(r => r.maeR)).toFixed(3))
    },

    lifecycle: {
      partials: safeNumber(stats.partials, 0),
      movesToBE: safeNumber(stats.movesToBE, 0),
      trails: safeNumber(stats.trails, 0),
      adds: safeNumber(stats.adds, 0),
      actionCounts: stats.actionCounts || {}
    },

    shadow: {
      wins: shadowWins,
      losses: shadowLosses,
      winrate: shadowCompleted ? pct(shadowWins / shadowCompleted) : "0.0%",
      wouldHaveWonTopReasons: completedShadows
        .filter(r => r.win)
        .slice(-20)
        .map(r => `${r.symbol}_${r.side}_${r.reason}_R=${r.exitR}`),
      wouldHaveLostTopReasons: completedShadows
        .filter(r => r.loss)
        .slice(-20)
        .map(r => `${r.symbol}_${r.side}_${r.reason}_R=${r.exitR}`)
    },

    rejectPressure: waitReasons,
    entryTypes,

    suggestedFocus:
      waitReasons[0]?.reason === "RSI_NO_RUNNER_EDGE"
        ? "RSI timing is main bottleneck"
        : waitReasons[0]?.reason === "RR_TOO_LOW"
          ? "Risk geometry blocks many runner setups"
          : waitReasons[0]?.reason === "FLOW_NOT_RUNNER"
            ? "Scanner is still sending too many non-runner candidates"
            : "Collect more runner outcome data"
  };
}

// ================= FINAL FILTER SETPOINT OPTIMIZER =================
const OPT_MIN_SAMPLE = 12;
const OPT_MEDIUM_SAMPLE = 35;
const OPT_HIGH_SAMPLE = 80;
const OPT_MAX_ROWS = 600;

function optRound(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;

  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function optPct(value) {
  return `${optRound(safeNumber(value, 0) * 100, 1)}%`;
}

function optAvg(values) {
  const arr = values.map(Number).filter(Number.isFinite);
  if (!arr.length) return 0;

  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function optSum(values) {
  return values
    .map(Number)
    .filter(Number.isFinite)
    .reduce((a, b) => a + b, 0);
}

function optQuantile(values, q) {
  const arr = values
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (!arr.length) return null;

  const pos = (arr.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;

  if (arr[base + 1] !== undefined) {
    return arr[base] + rest * (arr[base + 1] - arr[base]);
  }

  return arr[base];
}

function optUnique(values, decimals = 4) {
  return Array.from(
    new Set(
      values
        .map(Number)
        .filter(Number.isFinite)
        .map(v => optRound(v, decimals))
    )
  ).sort((a, b) => a - b);
}

function optCompactCandidates(values, max = 4) {
  const arr = values.filter(v => Number.isFinite(Number(v)));

  if (arr.length <= max) return arr;

  const picked = new Set();

  picked.add(arr[0]);
  picked.add(arr[Math.floor((arr.length - 1) * 0.33)]);
  picked.add(arr[Math.floor((arr.length - 1) * 0.66)]);
  picked.add(arr[arr.length - 1]);

  return Array.from(picked)
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
    .slice(0, max);
}

function optProfitFactor(rows) {
  const rValues = rows
    .map(row => Number(row.exitR))
    .filter(Number.isFinite);

  const grossWin = rValues
    .filter(r => r > 0)
    .reduce((sum, r) => sum + r, 0);

  const grossLoss = Math.abs(
    rValues
      .filter(r => r < 0)
      .reduce((sum, r) => sum + r, 0)
  );

  if (!grossLoss) {
    return grossWin > 0 ? 999 : 0;
  }

  return grossWin / grossLoss;
}

function optNormalizeOutcomeRow(row) {
  const exitR = Number(row?.exitR);
  const pnlPct = Number(row?.pnlPct);

  const normalized = {
    source: String(row?.source || "REAL").toUpperCase(),

    symbol: normalizeBaseSymbol(row?.symbol),
    side: normalizeSide(row?.side),

    action: String(row?.action || "UNKNOWN").toUpperCase(),
    status: String(row?.status || "CLOSED").toUpperCase(),

    reason: String(row?.reason || row?.entryReason || "UNKNOWN").toUpperCase(),
    exitReason: String(row?.exitReason || row?.status || "UNKNOWN").toUpperCase(),

    setupClass: String(row?.setupClass || "UNKNOWN").toUpperCase(),
    entryType: String(row?.entryType || row?.runnerEntryType || row?.reason || "UNKNOWN").toUpperCase(),

    scannerFlow: String(row?.scannerFlow || "UNKNOWN").toUpperCase(),
    liveEligible: Boolean(row?.liveEligible),
    shadowOnly: Boolean(row?.shadowOnly),

    score: safeNumber(row?.score, 0),
    confluence: safeNumber(row?.confluence, 0),
    sniperScore: safeNumber(row?.sniperScore, 0),

    rr: safeNumber(row?.rr || row?.plannedRR || row?.targetR, 0),
    plannedRR: safeNumber(row?.plannedRR || row?.rr || row?.targetR, 0),
    targetR: safeNumber(row?.targetR || row?.plannedRR || row?.rr, 0),

    entry: safeNumber(row?.entry, 0),
    sl: safeNumber(row?.sl || row?.initialSl, 0),
    tp: safeNumber(row?.tp, 0),
    exit: safeNumber(row?.exit, 0),

    exitR: Number.isFinite(exitR) ? exitR : null,
    pnlPct: Number.isFinite(pnlPct) ? pnlPct : null,

    mfeR: safeNumber(row?.mfeR, 0),
    maeR: safeNumber(row?.maeR, 0),

    rsiZone: String(row?.rsiZone || "UNKNOWN").toUpperCase(),
    obBias: String(row?.obBias || "UNKNOWN").toUpperCase(),
    flow: normalizeFlow(row?.flow),

    spreadPct: normalizeSpread(row?.spreadPct),
    depthMinUsd1p: safeNumber(row?.depthMinUsd1p, 0),

    runnerPressure: safeNumber(row?.runnerPressure, 0),
    runnerAcceleration: safeNumber(row?.runnerAcceleration, 0),

    partialTaken: Boolean(row?.partialTaken),
    breakEvenMoved: Boolean(row?.breakEvenMoved),
    trailingActive: Boolean(row?.trailingActive),
    adds: safeNumber(row?.adds, 0),

    rsiValid: row?.rsiValid !== false,
    rsiBlocked: Boolean(row?.rsiBlocked),
    rsiContinuationAllowed: Boolean(row?.rsiContinuationAllowed),
    rsiPullbackAllowed: Boolean(row?.rsiPullbackAllowed),
    rsiExhaustedAgainstSide: Boolean(row?.rsiExhaustedAgainstSide),

    structureAligned: row?.structureAligned !== false,

    obFetchFailed: Boolean(row?.obFetchFailed),
    spoof: Boolean(row?.spoof),
    obAgainst: Boolean(row?.obAgainst),

    strategy: String(row?.strategy || "UNKNOWN").toUpperCase(),

    baseRR: safeNumber(row?.baseRR || row?.rr || row?.plannedRR, 0),

    partialTp: safeNumber(row?.partialTp, 0),
    breakevenAt: safeNumber(row?.breakevenAt, 0),
    trailStart: safeNumber(row?.trailStart, 0),

    scannerHot: Boolean(row?.scannerHot),
    detectedFlow: normalizeFlow(row?.detectedFlow || row?.flow),

    hasRiskGeometry:
      safeNumber(row?.entry, 0) > 0 &&
      safeNumber(row?.sl || row?.initialSl, 0) > 0 &&
      safeNumber(row?.tp, 0) > 0,

    ts: safeNumber(row?.ts || row?.createdAt || Date.now(), Date.now())
  };

  normalized.win = Number.isFinite(Number(normalized.exitR))
    ? normalized.exitR > 0
    : Boolean(row?.win);

  normalized.loss = Number.isFinite(Number(normalized.exitR))
    ? normalized.exitR < 0
    : Boolean(row?.loss);

  normalized.flat = !normalized.win && !normalized.loss;

  return normalized;
}

function optGetStats(rows) {
  const arr = Array.isArray(rows) ? rows : [];

  const completedRows = arr.filter(row => Number.isFinite(Number(row.exitR)));
  const wins = completedRows.filter(row => Number(row.exitR) > 0).length;
  const losses = completedRows.filter(row => Number(row.exitR) < 0).length;
  const completed = wins + losses;

  const rValues = completedRows.map(row => Number(row.exitR));
  const pnlValues = completedRows
    .map(row => Number(row.pnlPct))
    .filter(Number.isFinite);

  const directSL = completedRows.filter(row => {
    const reason = String(row.exitReason || row.status || "").toUpperCase();

    return (
      reason.includes("SL") &&
      safeNumber(row.mfeR, 0) < 0.25
    );
  }).length;

  const nearTpThenLoss = completedRows.filter(row => {
    const rr = safeNumber(row.plannedRR || row.rr, 0);

    return (
      Number(row.exitR) < 0 &&
      rr > 0 &&
      safeNumber(row.mfeR, 0) >= rr * 0.80
    );
  }).length;

  const totalR = optSum(rValues);
  const avgR = optAvg(rValues);
  const totalPnlPct = optSum(pnlValues);
  const avgPnlPct = optAvg(pnlValues);

  const winrateNum = completed ? wins / completed : 0;
  const directSLPctNum = completedRows.length ? directSL / completedRows.length : 0;

  return {
    sample: arr.length,
    completed,
    wins,
    losses,

    winrateNum: optRound(winrateNum, 4),
    winrate: optPct(winrateNum),

    totalR: optRound(totalR, 3),
    avgR: optRound(avgR, 3),

    totalPnlPct: optRound(totalPnlPct, 3),
    avgPnlPct: optRound(avgPnlPct, 3),

    avgMfeR: optRound(optAvg(completedRows.map(row => row.mfeR)), 3),
    avgMaeR: optRound(optAvg(completedRows.map(row => row.maeR)), 3),

    profitFactorR: optRound(optProfitFactor(completedRows), 3),

    directSL,
    directSLPctNum: optRound(directSLPctNum, 4),
    directSLPct: optPct(directSLPctNum),

    nearTpThenLoss,
    nearTpThenLossPct: optPct(completedRows.length ? nearTpThenLoss / completedRows.length : 0)
  };
}

// ================= PLANNED RR OUTCOME TABLE =================
function bucketPlannedRR(rr) {
  const value = Number(rr);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Number((Math.round(value / PLANNED_RR_BUCKET_STEP) * PLANNED_RR_BUCKET_STEP).toFixed(1));
}

function buildPlannedRrOutcomeTable() {
  const closed = Array.isArray(stats.closedTrades) ? stats.closedTrades : [];

  const usable = closed.filter(trade => {
    const plannedRR = Number(trade?.plannedRR || trade?.rr || 0);
    const exitR = Number(trade?.exitR);
    return (
      Number.isFinite(plannedRR) &&
      plannedRR > 0 &&
      Number.isFinite(exitR)
    );
  });

  const rows = PLANNED_RR_BUCKETS.map(bucket => {
    const bucketRows = usable.filter(trade => {
      const plannedRR = Number(trade?.plannedRR || trade?.rr || 0);
      return bucketPlannedRR(plannedRR) === bucket;
    });

    const tpRows = bucketRows.filter(trade => String(trade.exitReason || "").toUpperCase() === "TP");
    const slRows = bucketRows.filter(trade => String(trade.exitReason || "").toUpperCase() === "SL");
    const beSlRows = bucketRows.filter(trade => String(trade.exitReason || "").toUpperCase() === "BE_SL");

    const winRows = bucketRows.filter(trade => Number(trade.exitR || 0) > 0);
    const lossRows = bucketRows.filter(trade => Number(trade.exitR || 0) < 0);
    const flatRows = bucketRows.filter(trade => Number(trade.exitR || 0) === 0);

    const total = bucketRows.length;

    // Helper om percentages te formatteren
    const fmtPct = (num, total) => total ? `${((num / total) * 100).toFixed(1)}%` : "0.0%";

    return {
      plannedRrBucket: bucket,
      sample: total,
      enoughSample: total >= PLANNED_RR_MIN_SAMPLE,

      wins: winRows.length,
      losses: lossRows.length,
      flats: flatRows.length,

      winRate: fmtPct(winRows.length, total),
      lossRate: fmtPct(lossRows.length, total),

      tpCount: tpRows.length,
      slCount: slRows.length,
      beSlCount: beSlRows.length,

      tpRate: fmtPct(tpRows.length, total),
      slRate: fmtPct(slRows.length, total),
      beSlRate: fmtPct(beSlRows.length, total),

      avgExitR: Number(optAvg(bucketRows.map(t => Number(t.exitR || 0))).toFixed(3)),
      totalR: Number(optSum(bucketRows.map(t => Number(t.exitR || 0))).toFixed(3)),
      avgPnlPct: Number(optAvg(bucketRows.map(t => Number(t.pnlPct || 0))).toFixed(3)),

      avgMfeR: Number(optAvg(bucketRows.map(t => Number(t.mfeR || 0))).toFixed(3)),
      avgMaeR: Number(optAvg(bucketRows.map(t => Number(t.maeR || 0))).toFixed(3)),

      avgActualPlannedRR: Number(
        optAvg(bucketRows.map(t => Number(t.plannedRR || t.rr || 0))).toFixed(3)
      ),

      examplesWin: winRows.slice(-8).map(t =>
        `${t.symbol}_${t.side}_${t.setupClass}_plannedRR=${Number(t.plannedRR || 0).toFixed(2)}_exit=${t.exitReason}_exitR=${t.exitR}`
      ),

      examplesSL: slRows.slice(-8).map(t =>
        `${t.symbol}_${t.side}_${t.setupClass}_plannedRR=${Number(t.plannedRR || 0).toFixed(2)}_exit=${t.exitReason}_exitR=${t.exitR}`
      )
    };
  });

  const validRows = rows.filter(row => row.sample >= PLANNED_RR_MIN_SAMPLE);

  const parsePct = (pctStr) => parseFloat(pctStr);

  const bestWinBucket = [...validRows].sort((a, b) => {
    const winDiff = parsePct(b.winRate) - parsePct(a.winRate);
    if (winDiff !== 0) return winDiff;
    return Number(b.avgExitR || 0) - Number(a.avgExitR || 0);
  })[0] || null;

  const worstSlBucket = [...validRows].sort((a, b) => {
    const slDiff = parsePct(b.slRate) - parsePct(a.slRate);
    if (slDiff !== 0) return slDiff;
    return Number(a.avgExitR || 0) - Number(b.avgExitR || 0);
  })[0] || null;

  const bestExpectancyBucket = [...validRows].sort((a, b) => {
    const avgRDiff = Number(b.avgExitR || 0) - Number(a.avgExitR || 0);
    if (avgRDiff !== 0) return avgRDiff;
    return parsePct(b.winRate) - parsePct(a.winRate);
  })[0] || null;

  return {
    tag: "TS_PLANNED_RR_OUTCOME_TABLE",
    strategyVersion: STRATEGY_VERSION,
    ts: Date.now(),

    sample: {
      closedTrades: closed.length,
      usableTrades: usable.length,
      minBucketSample: PLANNED_RR_MIN_SAMPLE,
      confidence:
        usable.length >= 60
          ? "HIGH"
          : usable.length >= 20
            ? "MEDIUM"
            : "LOW"
    },

    interpretation: {
      plannedRrBucket: "plannedRR afgerond naar dichtstbijzijnde 0.1",
      win: "exitR > 0",
      loss: "exitR < 0",
      tp: "exitReason === TP",
      sl: "exitReason === SL",
      beSl: "exitReason === BE_SL"
    },

    bestWinBucket,
    worstSlBucket,
    bestExpectancyBucket,

    table: rows
  };
}

// ================= COHORT LEARNING LOGS =================
const COHORT_MIN_SOFT_SAMPLE = 5;
const COHORT_MIN_BLOCK_SAMPLE = 8;
const COHORT_MIN_ALLOW_SAMPLE = 10;

function buildLearningCohortDimensions(row) {
  return {
    entryType: String(row?.entryType || "UNKNOWN").toUpperCase(),
    setupClass: String(row?.setupClass || "UNKNOWN").toUpperCase(),
    side: normalizeSide(row?.side),
    rsiZone: String(row?.rsiZone || "UNKNOWN").toUpperCase(),
    flow: normalizeFlow(row?.flow),
    obBias: String(row?.obBias || "UNKNOWN").toUpperCase()
  };
}

function buildLearningCohortKey(dim) {
  return [
    `TYPE=${dim.entryType}`,
    `CLASS=${dim.setupClass}`,
    `SIDE=${dim.side}`,
    `RSI=${dim.rsiZone}`,
    `FLOW=${dim.flow}`,
    `OB=${dim.obBias}`
  ].join("|");
}

function buildCohortRule(dim) {
  return {
    entryType: dim.entryType,
    setupClass: dim.setupClass,
    side: dim.side,
    rsiZone: dim.rsiZone,
    flow: dim.flow,
    obBias: dim.obBias
  };
}

function buildCohortOutcomeLog(row) {
  const normalized = optNormalizeOutcomeRow(row);
  const dim = buildLearningCohortDimensions(normalized);

  return {
    tag: "RUNNER_COHORT_OUTCOME",
    cohortKey: buildLearningCohortKey(dim),
    rule: buildCohortRule(dim),

    symbol: normalized.symbol,
    side: normalized.side,

    exitR: normalized.exitR,
    pnlPct: normalized.pnlPct,
    mfeR: normalized.mfeR,
    maeR: normalized.maeR,

    score: normalized.score,
    confluence: normalized.confluence,
    sniperScore: normalized.sniperScore,
    rr: normalized.plannedRR,

    spreadPct: normalized.spreadPct,
    depthMinUsd1p: normalized.depthMinUsd1p,
    runnerPressure: normalized.runnerPressure,
    runnerAcceleration: normalized.runnerAcceleration,

    scannerFlow: normalized.scannerFlow,
    liveEligible: normalized.liveEligible,
    shadowOnly: normalized.shadowOnly,

    win: normalized.win,
    loss: normalized.loss,
    flat: normalized.flat
  };
}

function classifyCohortDecision(cohort) {
  const sample = safeNumber(cohort.sample, 0);
  const avgR = safeNumber(cohort.avgR, 0);
  const totalR = safeNumber(cohort.totalR, 0);
  const profitFactor = safeNumber(cohort.profitFactorR, 0);
  const winrate = safeNumber(cohort.winrateNum, 0);
  const directSLPct = safeNumber(cohort.directSLPctNum, 0);
  const avgMaeR = safeNumber(cohort.avgMaeR, 0);

  const hardBlock =
    sample >= COHORT_MIN_BLOCK_SAMPLE &&
    totalR < 0 &&
    (
      avgR <= -0.15 ||
      profitFactor < 0.85 ||
      winrate <= 0.38 ||
      directSLPct >= 0.35 ||
      avgMaeR <= -1.10
    );

  if (hardBlock) {
    return {
      action: "BLOCK",
      reason: "negative_expectancy_cohort"
    };
  }

  const softBlock =
    sample >= COHORT_MIN_SOFT_SAMPLE &&
    totalR < 0 &&
    avgR < 0 &&
    profitFactor < 1;

  if (softBlock) {
    return {
      action: "WATCH_BLOCK",
      reason: "weak_expectancy_watchlist"
    };
  }

  const allow =
    sample >= COHORT_MIN_ALLOW_SAMPLE &&
    totalR > 0 &&
    avgR >= 0.25 &&
    profitFactor >= 1.35 &&
    winrate >= 0.55;

  if (allow) {
    return {
      action: "ALLOW",
      reason: "positive_expectancy_cohort"
    };
  }

  const eliteAllow =
    sample >= COHORT_MIN_SOFT_SAMPLE &&
    totalR > 0 &&
    avgR >= 0.60 &&
    profitFactor >= 2 &&
    winrate >= 0.65;

  if (eliteAllow) {
    return {
      action: "ELITE_ALLOW",
      reason: "small_sample_elite_cohort"
    };
  }

  return {
    action: "OBSERVE",
    reason: "not_enough_edge"
  };
}

function buildCohortLearningReport() {
  const rows = (stats.closedTrades || [])
    .map(optNormalizeOutcomeRow)
    .filter(row => Number.isFinite(Number(row.exitR)))
    .filter(row => row.entry > 0)
    .filter(row => row.sl > 0)
    .filter(row => row.tp > 0)
    .slice(-OPT_MAX_ROWS);

  const groups = new Map();

  for (const row of rows) {
    const dim = buildLearningCohortDimensions(row);
    const cohortKey = buildLearningCohortKey(dim);

    if (!groups.has(cohortKey)) {
      groups.set(cohortKey, {
        cohortKey,
        rule: buildCohortRule(dim),
        rows: []
      });
    }

    groups.get(cohortKey).rows.push(row);
  }

  const cohorts = Array.from(groups.values())
    .map(group => {
      const s = optGetStats(group.rows);
      const decision = classifyCohortDecision(s);

      return {
        cohortKey: group.cohortKey,
        rule: group.rule,

        ...s,

        action: decision.action,
        reason: decision.reason,

        examples: group.rows.slice(-8).map(row => ({
          symbol: row.symbol,
          side: row.side,
          exitR: row.exitR,
          pnlPct: row.pnlPct,
          mfeR: row.mfeR,
          maeR: row.maeR,
          confluence: row.confluence,
          sniperScore: row.sniperScore,
          rr: row.plannedRR,
          spreadPct: row.spreadPct,
          depthMinUsd1p: row.depthMinUsd1p,
          runnerPressure: row.runnerPressure,
          runnerAcceleration: row.runnerAcceleration,
          scannerFlow: row.scannerFlow,
          liveEligible: row.liveEligible,
          shadowOnly: row.shadowOnly
        }))
      };
    })
    .filter(row => row.sample >= COHORT_MIN_SOFT_SAMPLE)
    .sort((a, b) => safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0));

  const allowCandidates = cohorts
    .filter(row => row.action === "ALLOW" || row.action === "ELITE_ALLOW")
    .sort((a, b) => safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0))
    .slice(0, 20);

  const blockCandidates = cohorts
    .filter(row => row.action === "BLOCK")
    .sort((a, b) => safeNumber(a.totalR, 0) - safeNumber(b.totalR, 0))
    .slice(0, 20);

  const watchBlockCandidates = cohorts
    .filter(row => row.action === "WATCH_BLOCK")
    .sort((a, b) => safeNumber(a.totalR, 0) - safeNumber(b.totalR, 0))
    .slice(0, 20);

  return {
    tag: "RUNNER_COHORT_LEARNING_REPORT",
    strategyVersion: STRATEGY_VERSION,
    ts: Date.now(),

    sample: {
      closedRows: rows.length,
      cohorts: cohorts.length,
      minSoftSample: COHORT_MIN_SOFT_SAMPLE,
      minBlockSample: COHORT_MIN_BLOCK_SAMPLE,
      minAllowSample: COHORT_MIN_ALLOW_SAMPLE,
      confidence:
        rows.length >= 150
          ? "HIGH"
          : rows.length >= 60
            ? "MEDIUM"
            : "LOW"
    },

    summary: {
      allowCount: allowCandidates.length,
      blockCount: blockCandidates.length,
      watchBlockCount: watchBlockCandidates.length
    },

    allowCandidates,
    blockCandidates,
    watchBlockCandidates,

    codePatch: {
      DISCORD_ALLOWED_COHORTS: allowCandidates.map(row => row.rule),
      DISCORD_BLOCKED_COHORTS: blockCandidates.map(row => row.rule),
      WATCH_BLOCK_COHORTS: watchBlockCandidates.map(row => row.rule)
    }
  };
}

function optScorePreset(presetStats, keepRatio) {
  const totalR = safeNumber(presetStats.totalR, 0);
  const avgR = safeNumber(presetStats.avgR, 0);
  const avgPnlPct = safeNumber(presetStats.avgPnlPct, 0);
  const profitFactor = clamp(safeNumber(presetStats.profitFactorR, 0), 0, 5);
  const winrate = safeNumber(presetStats.winrateNum, 0);
  const directSL = safeNumber(presetStats.directSLPctNum, 0);
  const nearTpThenLossPct =
    safeNumber(presetStats.nearTpThenLoss, 0) / Math.max(1, safeNumber(presetStats.completed, 0));

  const sampleConfidence = clamp(
    safeNumber(presetStats.completed, 0) / OPT_HIGH_SAMPLE,
    0.20,
    1
  );

  const raw =
    totalR * 1.15 +
    avgR * 75 +
    avgPnlPct * 14 +
    profitFactor * 10 +
    winrate * 30 +
    keepRatio * 3 -
    directSL * 55 -
    nearTpThenLossPct * 20;

  return optRound(raw * sampleConfidence, 3);
}

function optCurrentFilterSet() {
  return {
    MIN_SCORE,
    MIN_TF_STRENGTH,
    MIN_CONFLUENCE,
    MIN_SNIPER_SCORE,

    RUNNER_A_MIN_CONFLUENCE,
    RUNNER_A_MIN_SNIPER,
    RUNNER_A_MIN_RR,

    RUNNER_B_MIN_CONFLUENCE,
    RUNNER_B_MIN_SNIPER,
    RUNNER_B_MIN_RR,

    RUNNER_C_MIN_CONFLUENCE,
    RUNNER_C_MIN_SNIPER,
    RUNNER_C_MIN_RR,

    MAX_SPREAD_PCT,
    SQUEEZE_MAX_SPREAD_PCT,
    MIN_DEPTH_USD_1P,
    SQUEEZE_MIN_DEPTH_USD_1P,

    MIN_RUNNER_PRESSURE,
    MIN_RUNNER_ACCELERATION,

    ALLOW_MID_RSI: true,
    ALLOW_ENTRY_TYPES: [],
    BLOCK_ENTRY_TYPES: Array.from(BLOCK_ENTRY_TYPES)
  };
}

function optPresetKey(preset) {
  return [
    `CONF=${preset.MIN_CONFLUENCE}`,
    `SNIPER=${preset.MIN_SNIPER_SCORE}`,
    `RR=${preset.RUNNER_MIN_RR}`,
    `SPREAD=${preset.MAX_SPREAD_PCT}`,
    `DEPTH=${preset.MIN_DEPTH_USD_1P}`,
    `PRESSURE=${preset.MIN_RUNNER_PRESSURE}`,
    `ACCEL=${preset.MIN_RUNNER_ACCELERATION}`,
    `MID=${preset.ALLOW_MID_RSI}`,
    `ALLOW=${(preset.ALLOW_ENTRY_TYPES || []).join(",")}`,
    `BLOCK=${(preset.BLOCK_ENTRY_TYPES || []).join(",")}`
  ].join("|");
}

function optBuildEntryTypeModes(rows) {
  const types = Array.from(
    new Set(
      rows
        .map(row => String(row.entryType || "").toUpperCase())
        .filter(type => type && type !== "UNKNOWN")
    )
  ).slice(0, 5);

  const hardBlock = Array.from(BLOCK_ENTRY_TYPES);

  return [
    {
      ALLOW_ENTRY_TYPES: [],
      BLOCK_ENTRY_TYPES: hardBlock
    },
    ...types.map(type => ({
      ALLOW_ENTRY_TYPES: [type],
      BLOCK_ENTRY_TYPES: hardBlock
    })),
    ...types.map(type => ({
      ALLOW_ENTRY_TYPES: [],
      BLOCK_ENTRY_TYPES: Array.from(new Set([...hardBlock, type]))
    }))
  ];
}

function optBuildPresetGrid(rows) {
  const current = optCurrentFilterSet();

  const confluenceValues = optCompactCandidates(optUnique([
    current.MIN_CONFLUENCE,
    optQuantile(rows.map(r => r.confluence), 0.40),
    optQuantile(rows.map(r => r.confluence), 0.55),
    optQuantile(rows.map(r => r.confluence), 0.70),
    64,
    68,
    72,
    76,
    80,
    84
  ], 0), 4);

  const sniperValues = optCompactCandidates(optUnique([
    current.MIN_SNIPER_SCORE,
    optQuantile(rows.map(r => r.sniperScore), 0.40),
    optQuantile(rows.map(r => r.sniperScore), 0.55),
    optQuantile(rows.map(r => r.sniperScore), 0.70),
    0,
    58,
    62,
    66,
    70,
    74,
    78,
    82
  ], 0), 4);

  const rrValues = optCompactCandidates(optUnique([
    current.RUNNER_B_MIN_RR,
    current.RUNNER_A_MIN_RR,
    current.RUNNER_C_MIN_RR,
    optQuantile(rows.map(r => r.plannedRR), 0.35),
    optQuantile(rows.map(r => r.plannedRR), 0.50),
    optQuantile(rows.map(r => r.plannedRR), 0.70),
    1.05,
    1.10,
    1.12,
    1.18,
    1.20,
    1.25,
    1.35,
    1.50,
    1.70
  ], 2), 4);

  const spreadValues = optCompactCandidates(optUnique([
    current.MAX_SPREAD_PCT,
    current.SQUEEZE_MAX_SPREAD_PCT,
    optQuantile(rows.map(r => r.spreadPct).filter(v => v > 0), 0.35),
    optQuantile(rows.map(r => r.spreadPct).filter(v => v > 0), 0.55),
    0.0016,
    0.0020,
    0.0024,
    0.0032
  ], 6), 3);

  const depthValues = optCompactCandidates(optUnique([
    current.MIN_DEPTH_USD_1P,
    current.SQUEEZE_MIN_DEPTH_USD_1P,
    optQuantile(rows.map(r => r.depthMinUsd1p).filter(v => v > 0), 0.25),
    optQuantile(rows.map(r => r.depthMinUsd1p).filter(v => v > 0), 0.45),
    15159,
    30000,
    50000,
    80000,
    120000,
    160000,
    200000,
    300000
  ], 0), 3);

  const pressureValues = optCompactCandidates(optUnique([
    current.MIN_RUNNER_PRESSURE,
    optQuantile(rows.map(r => r.runnerPressure), 0.30),
    optQuantile(rows.map(r => r.runnerPressure), 0.50),
    optQuantile(rows.map(r => r.runnerPressure), 0.70),
    0,
    0.05,
    0.15,
    0.30,
    0.50,
    0.75
  ], 3), 3);

  const accelerationValues = optCompactCandidates(optUnique([
    current.MIN_RUNNER_ACCELERATION,
    optQuantile(rows.map(r => r.runnerAcceleration), 0.30),
    optQuantile(rows.map(r => r.runnerAcceleration), 0.50),
    optQuantile(rows.map(r => r.runnerAcceleration), 0.70),
    -0.65,
    -0.25,
    0,
    0.15,
    0.35
  ], 3), 3);

  const entryTypeModes = optBuildEntryTypeModes(rows);
  const map = new Map();

  function addPreset(presetName, values) {
    const preset = {
      ...current,
      presetName,
      ...values
    };

    map.set(optPresetKey(preset), preset);
  }

  addPreset("CURRENT_RUNNER_FILTERS", {
    RUNNER_MIN_RR: current.RUNNER_B_MIN_RR,
    BLOCK_ENTRY_TYPES: Array.from(BLOCK_ENTRY_TYPES)
  });

  for (const MIN_CONFLUENCE_VALUE of confluenceValues) {
    for (const MIN_SNIPER_SCORE_VALUE of sniperValues) {
      for (const RUNNER_MIN_RR of rrValues) {
        for (const MAX_SPREAD_PCT_VALUE of spreadValues) {
          for (const MIN_DEPTH_USD_1P_VALUE of depthValues) {
            for (const MIN_RUNNER_PRESSURE_VALUE of pressureValues) {
              for (const MIN_RUNNER_ACCELERATION_VALUE of accelerationValues) {
                for (const ALLOW_MID_RSI of [true, false]) {
                  for (const typeMode of entryTypeModes) {
                    addPreset("GRID_SEARCH", {
                      MIN_CONFLUENCE: MIN_CONFLUENCE_VALUE,
                      MIN_SNIPER_SCORE: MIN_SNIPER_SCORE_VALUE,
                      RUNNER_MIN_RR,
                      MAX_SPREAD_PCT: MAX_SPREAD_PCT_VALUE,
                      MIN_DEPTH_USD_1P: MIN_DEPTH_USD_1P_VALUE,
                      MIN_RUNNER_PRESSURE: MIN_RUNNER_PRESSURE_VALUE,
                      MIN_RUNNER_ACCELERATION: MIN_RUNNER_ACCELERATION_VALUE,
                      ALLOW_MID_RSI,
                      ...typeMode
                    });
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  return Array.from(map.values());
}

function optLiveHardBlockReason(row) {
  const setup = {
    entryType: row.entryType
  };

  return getBadLiveCohortReason({
    setup,
    flowType: row.flow,
    rsiZone: row.rsiZone,
    obBias: row.obBias
  });
}

function optLiveWatchBlockReason(row) {
  return getWatchLiveCohortReason({
    setup: {
      entryType: row.entryType
    },
    flowType: row.flow,
    rsiZone: row.rsiZone,
    obBias: row.obBias,
    confluence: row.confluence,
    sniperScore: row.sniperScore,
    runnerPressure: row.runnerPressure
  });
}

function optRowPassesPreset(row, preset) {
  if (!row) return false;

  if (optLiveHardBlockReason(row)) return false;
  if (optLiveWatchBlockReason(row)) return false;

  if (safeNumber(row.score, 0) < safeNumber(preset.MIN_SCORE, 0)) return false;
  if (safeNumber(row.confluence, 0) < safeNumber(preset.MIN_CONFLUENCE, 0)) return false;
  if (safeNumber(row.sniperScore, 0) < safeNumber(preset.MIN_SNIPER_SCORE, 0)) return false;
  if (safeNumber(row.plannedRR, 0) < safeNumber(preset.RUNNER_MIN_RR, 0)) return false;

  if (safeNumber(row.depthMinUsd1p, 0) > 0) {
    if (safeNumber(row.depthMinUsd1p, 0) < safeNumber(preset.MIN_DEPTH_USD_1P, 0)) return false;
  }

  if (safeNumber(row.spreadPct, 0) > 0) {
    if (normalizeSpread(row.spreadPct) > normalizeSpread(preset.MAX_SPREAD_PCT)) return false;
  }

  if (safeNumber(row.runnerPressure, 0) < safeNumber(preset.MIN_RUNNER_PRESSURE, 0)) return false;
  if (safeNumber(row.runnerAcceleration, 0) < safeNumber(preset.MIN_RUNNER_ACCELERATION, 0)) return false;

  if (preset.ALLOW_MID_RSI === false && row.rsiZone === "MID") return false;

  if (
    Array.isArray(preset.BLOCK_ENTRY_TYPES) &&
    preset.BLOCK_ENTRY_TYPES.includes(row.entryType)
  ) {
    return false;
  }

  if (
    Array.isArray(preset.ALLOW_ENTRY_TYPES) &&
    preset.ALLOW_ENTRY_TYPES.length &&
    !preset.ALLOW_ENTRY_TYPES.includes(row.entryType)
  ) {
    return false;
  }

  return true;
}

function optEvaluatePreset(rows, preset) {
  const kept = rows.filter(row => optRowPassesPreset(row, preset));
  const presetStats = optGetStats(kept);
  const keepRatio = rows.length ? kept.length / rows.length : 0;

  return {
    presetName: preset.presetName,
    presetKey: optPresetKey(preset),

    filters: {
      MIN_SCORE: preset.MIN_SCORE,
      MIN_CONFLUENCE: preset.MIN_CONFLUENCE,
      MIN_SNIPER_SCORE: preset.MIN_SNIPER_SCORE,
      RUNNER_MIN_RR: preset.RUNNER_MIN_RR,

      MAX_SPREAD_PCT: preset.MAX_SPREAD_PCT,
      MIN_DEPTH_USD_1P: preset.MIN_DEPTH_USD_1P,

      MIN_RUNNER_PRESSURE: preset.MIN_RUNNER_PRESSURE,
      MIN_RUNNER_ACCELERATION: preset.MIN_RUNNER_ACCELERATION,

      ALLOW_MID_RSI: preset.ALLOW_MID_RSI,
      ALLOW_ENTRY_TYPES: preset.ALLOW_ENTRY_TYPES,
      BLOCK_ENTRY_TYPES: preset.BLOCK_ENTRY_TYPES
    },

    kept: kept.length,
    rejected: rows.length - kept.length,
    keepRatio: optRound(keepRatio, 3),

    ...presetStats,

    decisionScore: optScorePreset(presetStats, keepRatio),

    examples: kept.slice(-10).map(row => ({
      source: row.source,
      symbol: row.symbol,
      side: row.side,
      setupClass: row.setupClass,
      entryType: row.entryType,
      rsiZone: row.rsiZone,
      flow: row.flow,
      scannerFlow: row.scannerFlow,
      liveEligible: row.liveEligible,
      shadowOnly: row.shadowOnly,
      confluence: row.confluence,
      sniperScore: row.sniperScore,
      rr: row.plannedRR,
      spreadPct: row.spreadPct,
      depthMinUsd1p: row.depthMinUsd1p,
      runnerPressure: row.runnerPressure,
      runnerAcceleration: row.runnerAcceleration,
      exitR: row.exitR,
      pnlPct: row.pnlPct,
      mfeR: row.mfeR,
      maeR: row.maeR
    }))
  };
}

function optBuildCohortKey(row) {
  return [
    `TYPE=${row.entryType}`,
    `CLASS=${row.setupClass}`,
    `SIDE=${row.side}`,
    `RSI=${row.rsiZone}`,
    `FLOW=${row.flow}`,
    `OB=${row.obBias}`
  ].join("|");
}

function optBuildCohorts(rows) {
  const map = new Map();

  for (const row of rows) {
    const key = optBuildCohortKey(row);

    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }

  return Array.from(map.entries())
    .map(([cohortKey, cohortRows]) => {
      const cohortStats = optGetStats(cohortRows);

      return {
        cohortKey,
        ...cohortStats,
        liveHardBlocked: Boolean(optLiveHardBlockReason(cohortRows[0])),
        liveHardBlockReason: optLiveHardBlockReason(cohortRows[0]),
        score: optScorePreset(
          cohortStats,
          cohortRows.length / Math.max(1, rows.length)
        ),
        examples: cohortRows.slice(-8).map(row => ({
          symbol: row.symbol,
          side: row.side,
          exitR: row.exitR,
          pnlPct: row.pnlPct,
          mfeR: row.mfeR,
          maeR: row.maeR
        }))
      };
    })
    .filter(row => row.sample >= 3)
    .sort((a, b) => b.score - a.score);
}

function optBuildChanges(currentFilters, bestFilters) {
  return Object.entries(bestFilters || {}).map(([parameter, suggestedValue]) => {
    const currentValue = currentFilters?.[parameter];

    const currentNum = Number(currentValue);
    const suggestedNum = Number(suggestedValue);

    let direction = "KEEP";

    if (Number.isFinite(currentNum) && Number.isFinite(suggestedNum)) {
      if (suggestedNum > currentNum) direction = "RAISE";
      if (suggestedNum < currentNum) direction = "LOWER";
    } else if (JSON.stringify(currentValue) !== JSON.stringify(suggestedValue)) {
      direction = "CHANGE";
    }

    return {
      parameter,
      currentValue,
      suggestedValue,
      direction
    };
  });
}

function buildFilterSetpointsFromBest(best) {
  const f = best?.filters || {};

  const runnerMinRr = safeNumber(f.RUNNER_MIN_RR, RUNNER_B_MIN_RR);
  const confluence = safeNumber(f.MIN_CONFLUENCE, MIN_CONFLUENCE);
  const sniper = safeNumber(f.MIN_SNIPER_SCORE, MIN_SNIPER_SCORE);

  // Optimizer mag depth voorstellen, maar live setpoint mag niet onder huidige liquidity floor.
  const depth = Math.max(
    safeNumber(f.MIN_DEPTH_USD_1P, MIN_DEPTH_USD_1P),
    MIN_DEPTH_USD_1P
  );

  const blockEntryTypes = Array.from(
    new Set([
      ...Array.from(BLOCK_ENTRY_TYPES),
      ...(Array.isArray(f.BLOCK_ENTRY_TYPES) ? f.BLOCK_ENTRY_TYPES : [])
    ])
  );

  return {
    confidence: best?.completed >= OPT_HIGH_SAMPLE
      ? "HIGH"
      : best?.completed >= OPT_MEDIUM_SAMPLE
        ? "MEDIUM"
        : "LOW",

    applyMode:
      best?.completed >= OPT_HIGH_SAMPLE
        ? "HARD_APPLY_ALLOWED"
        : best?.completed >= OPT_MEDIUM_SAMPLE
          ? "SOFT_APPLY_ONLY"
          : "DO_NOT_APPLY_YET",

    targetObjective: "MAX_TOTAL_PNL_AND_TOTAL_R",

    constants: {
      MIN_CONFLUENCE: confluence,
      MIN_SNIPER_SCORE: sniper,

      RUNNER_A_MIN_CONFLUENCE: Math.max(confluence, RUNNER_A_MIN_CONFLUENCE),
      RUNNER_A_MIN_SNIPER: Math.max(sniper, RUNNER_A_MIN_SNIPER),
      RUNNER_A_MIN_RR: Math.max(runnerMinRr, 1.12),

      RUNNER_B_MIN_CONFLUENCE: Math.max(confluence - 2, RUNNER_B_MIN_CONFLUENCE),
      RUNNER_B_MIN_SNIPER: Math.max(sniper - 4, RUNNER_B_MIN_SNIPER),
      RUNNER_B_MIN_RR: runnerMinRr,

      RUNNER_C_MIN_CONFLUENCE: Math.max(confluence + 4, RUNNER_C_MIN_CONFLUENCE),
      RUNNER_C_MIN_SNIPER: Math.max(sniper, RUNNER_C_MIN_SNIPER),
      RUNNER_C_MIN_RR: Math.max(runnerMinRr, 1.20),

      MAX_SPREAD_PCT: f.MAX_SPREAD_PCT,
      SQUEEZE_MAX_SPREAD_PCT,

      MIN_DEPTH_USD_1P: depth,
      SQUEEZE_MIN_DEPTH_USD_1P: depth,

      MIN_RUNNER_PRESSURE: f.MIN_RUNNER_PRESSURE,
      MIN_RUNNER_ACCELERATION: f.MIN_RUNNER_ACCELERATION
    },

    behavioralFilters: {
      ALLOW_MID_RSI: f.ALLOW_MID_RSI,
      ALLOW_ENTRY_TYPES: f.ALLOW_ENTRY_TYPES || [],
      BLOCK_ENTRY_TYPES: blockEntryTypes,
      LIVE_BAD_COHORT_BLOCKS: [
        "BAD_COHORT_FLOW_NEUTRAL",
        "BAD_COHORT_SQUEEZE_LOWER_RSI",
        "BAD_COHORT_MID_BREAKOUT_OB_BULLISH",
        "BAD_COHORT_MID_BREAKOUT_OB_BEARISH"
      ]
    },

    expected: {
      completedSample: best?.completed || 0,
      winrate: best?.winrate,
      totalR: best?.totalR,
      avgR: best?.avgR,
      totalPnlPct: best?.totalPnlPct,
      avgPnlPct: best?.avgPnlPct,
      profitFactorR: best?.profitFactorR,
      directSLPct: best?.directSLPct,
      keepRatio: best?.keepRatio,
      decisionScore: best?.decisionScore
    },

    codePatch: [
      `const MIN_CONFLUENCE = ${confluence};`,
      `const MIN_SNIPER_SCORE = ${sniper};`,
      `const RUNNER_A_MIN_CONFLUENCE = ${Math.max(confluence, RUNNER_A_MIN_CONFLUENCE)};`,
      `const RUNNER_A_MIN_SNIPER = ${Math.max(sniper, RUNNER_A_MIN_SNIPER)};`,
      `const RUNNER_A_MIN_RR = ${Math.max(runnerMinRr, 1.12).toFixed(2)};`,
      `const RUNNER_B_MIN_CONFLUENCE = ${Math.max(confluence - 2, RUNNER_B_MIN_CONFLUENCE)};`,
      `const RUNNER_B_MIN_SNIPER = ${Math.max(sniper - 4, RUNNER_B_MIN_SNIPER)};`,
      `const RUNNER_B_MIN_RR = ${runnerMinRr.toFixed(2)};`,
      `const RUNNER_C_MIN_CONFLUENCE = ${Math.max(confluence + 4, RUNNER_C_MIN_CONFLUENCE)};`,
      `const RUNNER_C_MIN_SNIPER = ${Math.max(sniper, RUNNER_C_MIN_SNIPER)};`,
      `const RUNNER_C_MIN_RR = ${Math.max(runnerMinRr, 1.20).toFixed(2)};`,
      `const MAX_SPREAD_PCT = ${f.MAX_SPREAD_PCT};`,
      `const MIN_DEPTH_USD_1P = ${depth};`,
      `const SQUEEZE_MIN_DEPTH_USD_1P = ${depth};`,
      `const MIN_RUNNER_PRESSURE = ${f.MIN_RUNNER_PRESSURE};`,
      `const MIN_RUNNER_ACCELERATION = ${f.MIN_RUNNER_ACCELERATION};`,
      `const BLOCK_ENTRY_TYPES = new Set(${JSON.stringify(blockEntryTypes)});`
    ]
  };
}

function buildFinalRunnerFilterDecision() {
  const realRows = (stats.closedTrades || [])
    .map(optNormalizeOutcomeRow)
    .filter(row => Number.isFinite(Number(row.exitR)));

  const completedShadowRows = (stats.shadowRows || [])
    .filter(row => row?.status && row.status !== "OPEN")
    .map(optNormalizeOutcomeRow)
    .filter(row => Number.isFinite(Number(row.exitR)));

  const dataUsed = realRows.length >= 20
    ? "REAL_CLOSED_TRADES_ONLY"
    : "REAL_CLOSED_TRADES_PLUS_COMPLETED_SHADOWS";

  const optimizerRowsRaw = dataUsed === "REAL_CLOSED_TRADES_ONLY"
    ? realRows
    : [...realRows, ...completedShadowRows];

  const optimizerRows = optimizerRowsRaw
    .filter(row => row.entry > 0)
    .filter(row => row.sl > 0)
    .filter(row => row.tp > 0)
    .filter(row => row.score > 0)
    .slice(-OPT_MAX_ROWS);

  const current = {
    ...optCurrentFilterSet(),
    RUNNER_MIN_RR: RUNNER_B_MIN_RR
  };

  if (optimizerRows.length < OPT_MIN_SAMPLE) {
    return {
      tag: "RUNNER_FINAL_FILTER_DECISION",
      strategyVersion: STRATEGY_VERSION,
      ts: Date.now(),
      decision: "NO_FINAL_DECISION_SAMPLE_TOO_SMALL",
      dataUsed,
      sample: {
        optimizerRows: optimizerRows.length,
        realRows: realRows.length,
        completedShadowRows: completedShadowRows.length,
        minRequired: OPT_MIN_SAMPLE,
        confidence: "LOW"
      },
      currentFilters: current,
      setpoints: {
        applyMode: "DO_NOT_APPLY_YET",
        reason: "sample_too_small"
      }
    };
  }

  const presets = optBuildPresetGrid(optimizerRows);

  const evaluated = presets
    .map(preset => optEvaluatePreset(optimizerRows, preset))
    .filter(row => row.completed >= OPT_MIN_SAMPLE)
    .sort((a, b) => b.decisionScore - a.decisionScore);

  const best = evaluated[0] || null;
  const currentEval = optEvaluatePreset(optimizerRows, current);

  const cohorts = optBuildCohorts(optimizerRows);
  const bestCohorts = cohorts
    .filter(row => !row.liveHardBlocked)
    .filter(row => row.avgR > 0)
    .filter(row => row.totalR > 0)
    .slice(0, 12);

  const badCohorts = cohorts
    .filter(row => row.liveHardBlocked || row.avgR < 0 || row.directSLPctNum >= 0.45)
    .sort((a, b) => a.score - b.score)
    .slice(0, 12);

  if (!best) {
    return {
      tag: "RUNNER_FINAL_FILTER_DECISION",
      strategyVersion: STRATEGY_VERSION,
      ts: Date.now(),
      decision: "NO_VALID_PRESET_FOUND",
      dataUsed,
      sample: {
        optimizerRows: optimizerRows.length,
        realRows: realRows.length,
        completedShadowRows: completedShadowRows.length,
        presetsTested: presets.length,
        confidence: "LOW"
      },
      currentFilters: current,
      bestCohorts,
      badCohorts
    };
  }

  const deltaVsCurrent = {
    totalRDelta: optRound(best.totalR - currentEval.totalR, 3),
    avgRDelta: optRound(best.avgR - currentEval.avgR, 3),
    totalPnlPctDelta: optRound(best.totalPnlPct - currentEval.totalPnlPct, 3),
    avgPnlPctDelta: optRound(best.avgPnlPct - currentEval.avgPnlPct, 3),
    winrateDeltaPct: optRound((best.winrateNum - currentEval.winrateNum) * 100, 1),
    profitFactorDelta: optRound(best.profitFactorR - currentEval.profitFactorR, 3),
    decisionScoreDelta: optRound(best.decisionScore - currentEval.decisionScore, 3)
  };

  const setpoints = buildFilterSetpointsFromBest(best);

  return {
    tag: "RUNNER_FINAL_FILTER_DECISION",
    strategyVersion: STRATEGY_VERSION,
    ts: Date.now(),

    decision: "BEST_FILTERS_FOR_MAX_PNL",
    dataUsed,
    shouldApplyAutomatically: false,

    method: {
      objective: "maximize totalR + avgR + totalPnlPct + avgPnlPct + profitFactor, penalize directSL and nearTP-then-loss",
      presetsTested: presets.length,
      presetsValid: evaluated.length,
      note: "logs advise constants only; live constants are not changed automatically"
    },

    sample: {
      optimizerRows: optimizerRows.length,
      realRows: realRows.length,
      completedShadowRows: completedShadowRows.length,
      confidence:
        optimizerRows.length >= OPT_HIGH_SAMPLE
          ? "HIGH"
          : optimizerRows.length >= OPT_MEDIUM_SAMPLE
            ? "MEDIUM"
            : "LOW"
    },

    currentFilters: current,
    currentPerformance: currentEval,

    bestPreset: best,
    setpoints,
    changesVsCurrent: optBuildChanges(current, best.filters),

    deltaVsCurrent,

    bestCohorts,
    badCohorts,

    rankedPresets: evaluated.slice(0, 10)
  };
}

function buildCurrentRunnerMasterPreset() {
  return {
    MIN_SCORE,
    MIN_TF_STRENGTH,
    MIN_CONFLUENCE,
    MIN_SNIPER_SCORE,

    MAX_SPREAD_PCT,
    SQUEEZE_MAX_SPREAD_PCT,
    MIN_DEPTH_USD_1P,
    SQUEEZE_MIN_DEPTH_USD_1P,

    MIN_RUNNER_PRESSURE,
    MIN_RUNNER_ACCELERATION,

    RUNNER_C_MIN_SCORE,
    RUNNER_C_MIN_CONFLUENCE,
    RUNNER_C_MIN_SNIPER,
    RUNNER_C_MIN_RR,
    RUNNER_C_TARGET_R,

    RUNNER_A_MIN_SCORE,
    RUNNER_A_MIN_CONFLUENCE,
    RUNNER_A_MIN_SNIPER,
    RUNNER_A_MIN_RR,
    RUNNER_A_TARGET_R,

    RUNNER_B_MIN_SCORE,
    RUNNER_B_MIN_CONFLUENCE,
    RUNNER_B_MIN_SNIPER,
    RUNNER_B_MIN_RR,
    RUNNER_B_TARGET_R,

    PARTIAL_TP_R,
    PARTIAL_SIZE,

    BREAK_EVEN_TRIGGER_R,
    BREAK_EVEN_LOCK_R,

    TRAIL_START_R,
    TRAIL_DISTANCE_R,
    TRAIL_MIN_CHANGE_PCT,

    MAX_ADDS,
    ADD_MIN_R,
    ADD_MIN_CONFLUENCE,
    ADD_MIN_SNIPER,

    STRUCTURE_AGAINST_MIN_CONFLUENCE,

    SPREAD_EXCEPTION_MIN_CONFLUENCE,
    DEPTH_EXCEPTION_MIN_CONFLUENCE,
    OB_AGAINST_MIN_CONFLUENCE,

    FUNDING_EXTREME_ABS_MAX,
    LONG_CROWDED_FUNDING_MAX,
    SHORT_CROWDED_FUNDING_MIN,
    FUNDING_MIN_CONFLUENCE,

    BTC_STRONG_COUNTER_MIN_CONFLUENCE,
    STRATEGY_SAFE_MIN_CONFLUENCE,

    RSI_CONTINUATION_TEST_RR,

    LIVE_ONLY_HOT_RUNNER,
    LIVE_SCANNER_HOT_FLOWS: Array.from(LIVE_SCANNER_HOT_FLOWS),

    BLOCK_ENTRY_TYPES: Array.from(BLOCK_ENTRY_TYPES),

    WATCH_MID_RUNNING_NEUTRAL_MIN_CONFLUENCE,
    WATCH_MID_RUNNING_NEUTRAL_MIN_SNIPER,
    WATCH_MID_RUNNING_NEUTRAL_MIN_PRESSURE
  };
}

function runnerMasterFilterKeys() {
  return Object.keys(buildCurrentRunnerMasterPreset());
}

function isRunnerASetupClass(setupClass) {
  return ["RUNNER_A", "RUNNER_C"].includes(String(setupClass || "").toUpperCase());
}

function isRunnerBSetupClass(setupClass) {
  return String(setupClass || "").toUpperCase() === "RUNNER_B";
}

function isRunnerAOnlyKey(key) {
  return (
    key.startsWith("RUNNER_A_") ||
    key.startsWith("RUNNER_C_")
  );
}

function isRunnerBOnlyKey(key) {
  return key.startsWith("RUNNER_B_");
}

function getRunnerOptimizationKeys(target) {
  const keys = runnerMasterFilterKeys();

  if (target === "A") {
    return keys.filter(key => !isRunnerBOnlyKey(key));
  }

  if (target === "B") {
    return keys.filter(key => !isRunnerAOnlyKey(key));
  }

  return keys;
}

function stableRunnerPresetKey(preset) {
  return JSON.stringify(
    Object.keys(preset)
      .sort()
      .reduce((out, key) => {
        out[key] = preset[key];
        return out;
      }, {})
  );
}

function uniqueRunnerValues(values) {
  const map = new Map();

  for (const value of values) {
    map.set(JSON.stringify(value), value);
  }

  return Array.from(map.values());
}

function runnerCandidateValues(key, currentValue, target) {
  if (typeof currentValue === "boolean") {
    return [currentValue, !currentValue];
  }

  if (Array.isArray(currentValue)) {
    if (key === "BLOCK_ENTRY_TYPES") {
      if (target === "B") {
        return [
          [],
          ["RUNNER_A_BREAKOUT"],
          ["RUNNER_C_SQUEEZE"]
        ];
      }

      return [
        currentValue,
        [],
        ["RUNNER_B_CONTINUATION"],
        ["RUNNER_A_BREAKOUT"],
        ["RUNNER_C_SQUEEZE"]
      ];
    }

    return [currentValue];
  }

  const v = Number(currentValue);

  if (!Number.isFinite(v)) return [currentValue];

  if (key.includes("SPREAD")) {
    return uniqueRunnerValues([
      Number((v * 0.75).toFixed(6)),
      Number((v * 0.90).toFixed(6)),
      Number(v.toFixed(6)),
      Number((v * 1.10).toFixed(6)),
      Number((v * 1.25).toFixed(6))
    ]).filter(n => n > 0);
  }

  if (key.includes("DEPTH")) {
    return uniqueRunnerValues([
      Math.max(10_000, Math.round(v * 0.70)),
      Math.max(10_000, Math.round(v * 0.85)),
      Math.round(v),
      Math.round(v * 1.15),
      Math.round(v * 1.35)
    ]);
  }

  if (key.includes("RR") || key.includes("TARGET_R")) {
    return uniqueRunnerValues([
      Number((v - 0.20).toFixed(2)),
      Number((v - 0.10).toFixed(2)),
      Number(v.toFixed(2)),
      Number((v + 0.10).toFixed(2)),
      Number((v + 0.20).toFixed(2)),
      Number((v + 0.35).toFixed(2))
    ]).filter(n => n >= 0.5);
  }

  if (
    key.includes("CONFLUENCE") ||
    key.includes("SNIPER") ||
    key.includes("SCORE")
  ) {
    return uniqueRunnerValues([
      Math.max(0, Math.round(v - 8)),
      Math.max(0, Math.round(v - 4)),
      Math.round(v),
      Math.round(v + 4),
      Math.round(v + 8)
    ]);
  }

  if (key.includes("PRESSURE") || key.includes("ACCELERATION")) {
    return uniqueRunnerValues([
      Number((v - 0.30).toFixed(3)),
      Number((v - 0.15).toFixed(3)),
      Number(v.toFixed(3)),
      Number((v + 0.15).toFixed(3)),
      Number((v + 0.30).toFixed(3))
    ]);
  }

  if (key.includes("FUNDING")) {
    return uniqueRunnerValues([
      Number((v * 0.75).toFixed(4)),
      Number(v.toFixed(4)),
      Number((v * 1.25).toFixed(4))
    ]);
  }

  return uniqueRunnerValues([
    Number((v * 0.85).toFixed(4)),
    Number(v.toFixed(4)),
    Number((v * 1.15).toFixed(4))
  ]);
}

function classifyRunnerSetupFromPreset(row, preset) {
  const flow = normalizeFlow(row.flow || row.detectedFlow);
  const score = safeNumber(row.score, 0);
  const confluence = safeNumber(row.confluence, 0);
  const sniperScore = safeNumber(row.sniperScore, 0);
  const rr = safeNumber(row.baseRR || row.plannedRR, 0);
  const strategy = String(row.strategy || "UNKNOWN").toUpperCase();

  if (
    flow === "SQUEEZE" &&
    score >= safeNumber(preset.RUNNER_C_MIN_SCORE, 0) &&
    confluence >= safeNumber(preset.RUNNER_C_MIN_CONFLUENCE, 0) &&
    sniperScore >= safeNumber(preset.RUNNER_C_MIN_SNIPER, 0) &&
    rr >= safeNumber(preset.RUNNER_C_MIN_RR, 0)
  ) {
    return {
      ok: true,
      setupClass: "RUNNER_C",
      entryType: "RUNNER_C_SQUEEZE",
      targetR: safeNumber(preset.RUNNER_C_TARGET_R, RUNNER_C_TARGET_R),
      minRR: safeNumber(preset.RUNNER_C_MIN_RR, RUNNER_C_MIN_RR)
    };
  }

  if (
    HOT_RUNNER_FLOWS.has(flow) &&
    score >= safeNumber(preset.RUNNER_A_MIN_SCORE, 0) &&
    confluence >= safeNumber(preset.RUNNER_A_MIN_CONFLUENCE, 0) &&
    sniperScore >= safeNumber(preset.RUNNER_A_MIN_SNIPER, 0) &&
    rr >= safeNumber(preset.RUNNER_A_MIN_RR, 0)
  ) {
    return {
      ok: true,
      setupClass: "RUNNER_A",
      entryType: "RUNNER_A_BREAKOUT",
      targetR: safeNumber(preset.RUNNER_A_TARGET_R, RUNNER_A_TARGET_R),
      minRR: safeNumber(preset.RUNNER_A_MIN_RR, RUNNER_A_MIN_RR)
    };
  }

  if (
    ["AGGRESSIVE", "TREND", "UNKNOWN"].includes(strategy) &&
    RUNNER_FLOWS.has(flow) &&
    score >= safeNumber(preset.RUNNER_B_MIN_SCORE, 0) &&
    confluence >= safeNumber(preset.RUNNER_B_MIN_CONFLUENCE, 0) &&
    sniperScore >= safeNumber(preset.RUNNER_B_MIN_SNIPER, 0) &&
    rr >= safeNumber(preset.RUNNER_B_MIN_RR, 0)
  ) {
    return {
      ok: true,
      setupClass: "RUNNER_B",
      entryType: "RUNNER_B_CONTINUATION",
      targetR: safeNumber(preset.RUNNER_B_TARGET_R, RUNNER_B_TARGET_R),
      minRR: safeNumber(preset.RUNNER_B_MIN_RR, RUNNER_B_MIN_RR)
    };
  }

  return {
    ok: false,
    setupClass: "NONE",
    entryType: "RUNNER_NOT_READY",
    targetR: safeNumber(preset.RUNNER_B_TARGET_R, RUNNER_B_TARGET_R),
    minRR: safeNumber(preset.RUNNER_B_MIN_RR, RUNNER_B_MIN_RR)
  };
}

function simulateRunnerOutcome(row, setup, preset) {
  const targetR = safeNumber(setup.targetR, 0);
  const mfeR = safeNumber(row.mfeR, 0);
  const maeR = safeNumber(row.maeR, 0);
  const horizonR = Number.isFinite(Number(row.horizonExitR))
    ? safeNumber(row.horizonExitR, 0)
    : Number.isFinite(Number(row.exitR))
      ? safeNumber(row.exitR, 0)
      : 0;

  let exitR = horizonR;
  let exitReason = "HORIZON";

  if (maeR <= -1 && mfeR < safeNumber(preset.PARTIAL_TP_R, PARTIAL_TP_R)) {
    exitR = -1;
    exitReason = "SIM_SL";
  } else if (targetR > 0 && mfeR >= targetR) {
    exitR = targetR;
    exitReason = "SIM_TARGET_R";
  } else if (mfeR >= safeNumber(preset.TRAIL_START_R, TRAIL_START_R)) {
    const trailedR = Math.max(
      horizonR,
      safeNumber(preset.TRAIL_START_R, TRAIL_START_R) - safeNumber(preset.TRAIL_DISTANCE_R, TRAIL_DISTANCE_R)
    );

    exitR = trailedR;
    exitReason = "SIM_TRAIL";
  } else if (mfeR >= safeNumber(preset.BREAK_EVEN_TRIGGER_R, BREAK_EVEN_TRIGGER_R) && horizonR < 0) {
    exitR = safeNumber(preset.BREAK_EVEN_LOCK_R, BREAK_EVEN_LOCK_R);
    exitReason = "SIM_BE";
  }

  const entry = safeNumber(row.entry, 0);
  const sl = safeNumber(row.sl, 0);
  const riskPct = entry > 0 && sl > 0
    ? (Math.abs(entry - sl) / entry) * 100
    : 0;

  const pnlPct = riskPct > 0
    ? exitR * riskPct
    : safeNumber(row.pnlPct, 0);

  return {
    exitR: Number(exitR.toFixed(3)),
    pnlPct: Number(pnlPct.toFixed(3)),
    exitReason
  };
}

function runnerRowPassesPreset(row, preset, target = "COMBINED") {
  const reject = reason => ({
    passes: false,
    reason,
    setupClass: "NONE",
    entryType: "NONE",
    simulated: null
  });

  if (!row?.hasRiskGeometry) return reject("NO_RISK_GEOMETRY");
  if (row.obFetchFailed) return reject("ORDERBOOK_FETCH_FAILED");
  if (row.spoof) return reject("SPOOF_DETECTED");

  const flow = normalizeFlow(row.flow || row.detectedFlow);
  const confluence = safeNumber(row.confluence, 0);
  const sniperScore = safeNumber(row.sniperScore, 0);
  const spread = normalizeSpread(row.spreadPct);
  const depth = safeNumber(row.depthMinUsd1p, 0);
  const funding = safeNumber(row.funding, 0);
  const btcState = String(row.btcState || "UNKNOWN").toUpperCase();

  if (preset.LIVE_ONLY_HOT_RUNNER && !Boolean(row.liveEligible) && !Boolean(row.scannerHot)) {
    return reject("SCANNER_FLOW_NOT_HOT_RUNNER");
  }

  if (!RUNNER_FLOWS.has(flow)) return reject("FLOW_NOT_RUNNER");
  if (flow === "EXHAUSTION") return reject("FLOW_EXHAUSTION");

  if (safeNumber(row.runnerPressure, 0) < safeNumber(preset.MIN_RUNNER_PRESSURE, 0)) {
    return reject("RUNNER_PRESSURE_TOO_LOW");
  }

  if (safeNumber(row.runnerAcceleration, 0) < safeNumber(preset.MIN_RUNNER_ACCELERATION, 0)) {
    return reject("RUNNER_DECELERATING");
  }

  if (safeNumber(row.score, 0) < safeNumber(preset.MIN_SCORE, 0)) {
    return reject("SCORE_TOO_LOW");
  }

  if (safeNumber(row.tfStrength, 0) < safeNumber(preset.MIN_TF_STRENGTH, 0)) {
    return reject("TF_TOO_WEAK");
  }

  if (!row.rsiValid) return reject("RSI_DATA_INVALID");
  if (row.rsiBlocked) return reject("RSI_BLOCKED");
  if (row.rsiExhaustedAgainstSide) return reject("RSI_EXHAUSTED_AGAINST_SIDE");

  if (!row.rsiContinuationAllowed && !row.rsiPullbackAllowed) {
    return reject("RSI_NO_RUNNER_EDGE");
  }

  if (!row.structureAligned && confluence < safeNumber(preset.STRUCTURE_AGAINST_MIN_CONFLUENCE, 78)) {
    return reject("STRUCTURE_AGAINST");
  }

  const maxSpread = flow === "SQUEEZE"
    ? safeNumber(preset.SQUEEZE_MAX_SPREAD_PCT, SQUEEZE_MAX_SPREAD_PCT)
    : safeNumber(preset.MAX_SPREAD_PCT, MAX_SPREAD_PCT);

  if (spread > maxSpread && confluence < safeNumber(preset.SPREAD_EXCEPTION_MIN_CONFLUENCE, 82)) {
    return reject("SPREAD_TOO_WIDE");
  }

  const minDepth = flow === "SQUEEZE"
    ? safeNumber(preset.SQUEEZE_MIN_DEPTH_USD_1P, SQUEEZE_MIN_DEPTH_USD_1P)
    : safeNumber(preset.MIN_DEPTH_USD_1P, MIN_DEPTH_USD_1P);

  if (depth > 0 && depth < minDepth && confluence < safeNumber(preset.DEPTH_EXCEPTION_MIN_CONFLUENCE, 82)) {
    return reject("DEPTH_TOO_LOW");
  }

  if (row.obAgainst && confluence < safeNumber(preset.OB_AGAINST_MIN_CONFLUENCE, 80)) {
    return reject("OB_AGAINST");
  }

  if (Math.abs(funding) > safeNumber(preset.FUNDING_EXTREME_ABS_MAX, 0.018) && confluence < safeNumber(preset.FUNDING_MIN_CONFLUENCE, 84)) {
    return reject("FUNDING_EXTREME");
  }

  if (row.side === "bull" && funding > safeNumber(preset.LONG_CROWDED_FUNDING_MAX, 0.014) && confluence < safeNumber(preset.FUNDING_MIN_CONFLUENCE, 84)) {
    return reject("LONG_CROWDED_FUNDING");
  }

  if (row.side === "bear" && funding < safeNumber(preset.SHORT_CROWDED_FUNDING_MIN, -0.014) && confluence < safeNumber(preset.FUNDING_MIN_CONFLUENCE, 84)) {
    return reject("SHORT_CROWDED_FUNDING");
  }

  if (btcState === "STRONG_BULL" && row.side === "bear" && confluence < safeNumber(preset.BTC_STRONG_COUNTER_MIN_CONFLUENCE, 85)) {
    return reject("BTC_STRONG_BULL_BLOCK_SHORT");
  }

  if (btcState === "STRONG_BEAR" && row.side === "bull" && confluence < safeNumber(preset.BTC_STRONG_COUNTER_MIN_CONFLUENCE, 85)) {
    return reject("BTC_STRONG_BEAR_BLOCK_LONG");
  }

  if (confluence < safeNumber(preset.MIN_CONFLUENCE, 0)) {
    return reject("CONFLUENCE_TOO_LOW");
  }

  if (sniperScore < safeNumber(preset.MIN_SNIPER_SCORE, 0)) {
    return reject("SNIPER_TOO_LOW");
  }

  if (String(row.strategy || "").toUpperCase() === "SAFE" && confluence < safeNumber(preset.STRATEGY_SAFE_MIN_CONFLUENCE, 82)) {
    return reject("STRATEGY_SAFE_NOT_RUNNER_READY");
  }

  const setup = classifyRunnerSetupFromPreset(row, preset);

  if (!setup.ok) {
    return reject("RUNNER_SETUP_NOT_READY");
  }

  if (target === "A" && !isRunnerASetupClass(setup.setupClass)) {
    return reject("NOT_A_RUNNER");
  }

  if (target === "B" && !isRunnerBSetupClass(setup.setupClass)) {
    return reject("NOT_B_RUNNER");
  }

  if (
    Array.isArray(preset.BLOCK_ENTRY_TYPES) &&
    preset.BLOCK_ENTRY_TYPES.includes(setup.entryType)
  ) {
    return reject("ENTRY_TYPE_BLOCKED");
  }

  const watchReason = getWatchLiveCohortReason({
    setup,
    flowType: flow,
    rsiZone: row.rsiZone,
    obBias: row.obBias,
    confluence,
    sniperScore,
    runnerPressure: row.runnerPressure
  });

  if (watchReason) {
    return reject(watchReason);
  }

  const badReason = getBadLiveCohortReason({
    setup,
    flowType: flow,
    rsiZone: row.rsiZone,
    obBias: row.obBias
  });

  if (badReason && target !== "B") {
    return reject(badReason);
  }

  const simulated = simulateRunnerOutcome(row, setup, preset);

  return {
    passes: true,
    reason: setup.entryType,
    setupClass: setup.setupClass,
    entryType: setup.entryType,
    simulated
  };
}

function getRunnerMasterStats(rows) {
  const arr = Array.isArray(rows) ? rows : [];

  const wins = arr.filter(row => safeNumber(row.exitR, 0) > 0).length;
  const losses = arr.filter(row => safeNumber(row.exitR, 0) < 0).length;
  const completed = wins + losses;

  const totalR = optSum(arr.map(row => row.exitR));
  const totalPnlPct = optSum(arr.map(row => row.pnlPct));

  const grossWin = optSum(arr.map(row => row.exitR).filter(r => r > 0));
  const grossLoss = Math.abs(optSum(arr.map(row => row.exitR).filter(r => r < 0)));

  const directSL = arr.filter(row => {
    return (
      String(row.exitReason || "").includes("SL") &&
      safeNumber(row.mfeR, 0) < 0.25
    );
  }).length;

  const winrateNum = completed ? wins / completed : 0;
  const profitFactorR = grossLoss ? grossWin / grossLoss : grossWin > 0 ? 999 : 0;

  return {
    sample: arr.length,
    completed,
    wins,
    losses,

    winrateNum: optRound(winrateNum, 4),
    winrate: optPct(winrateNum),

    totalR: optRound(totalR, 3),
    avgR: arr.length ? optRound(totalR / arr.length, 3) : 0,

    totalPnlPct: optRound(totalPnlPct, 3),
    avgPnlPct: arr.length ? optRound(totalPnlPct / arr.length, 3) : 0,

    profitFactorR: optRound(profitFactorR, 3),

    avgMfeR: optRound(optAvg(arr.map(row => row.mfeR)), 3),
    avgMaeR: optRound(optAvg(arr.map(row => row.maeR)), 3),

    directSL,
    directSLPctNum: arr.length ? optRound(directSL / arr.length, 4) : 0,
    directSLPct: arr.length ? optPct(directSL / arr.length) : "0.0%"
  };
}

function scoreRunnerMasterStats(statsRow, keepRatio) {
  const totalPnlPct = safeNumber(statsRow.totalPnlPct, 0);
  const totalR = safeNumber(statsRow.totalR, 0);
  const avgR = safeNumber(statsRow.avgR, 0);
  const avgPnlPct = safeNumber(statsRow.avgPnlPct, 0);
  const profitFactor = clamp(safeNumber(statsRow.profitFactorR, 0), 0, 5);
  const winrate = safeNumber(statsRow.winrateNum, 0);
  const directSL = safeNumber(statsRow.directSLPctNum, 0);

  const sampleConfidence = clamp(
    safeNumber(statsRow.completed, 0) / RUNNER_MASTER_TARGET_SAMPLE,
    0.15,
    1
  );

  const raw =
    totalPnlPct * 3.0 +
    totalR * 2.2 +
    avgR * 55 +
    avgPnlPct * 20 +
    profitFactor * 12 +
    winrate * 12 +
    keepRatio * 3 -
    directSL * 65;

  return optRound(raw * sampleConfidence, 4);
}

function evaluateRunnerMasterPreset(rows, preset, target = "COMBINED") {
  const kept = [];

  for (const row of rows) {
    const result = runnerRowPassesPreset(row, preset, target);

    if (!result.passes) continue;

    kept.push({
      ...row,
      setupClass: result.setupClass,
      entryType: result.entryType,
      exitR: result.simulated.exitR,
      pnlPct: result.simulated.pnlPct,
      exitReason: result.simulated.exitReason
    });
  }

  const statsRow = getRunnerMasterStats(kept);
  const keepRatio = rows.length ? kept.length / rows.length : 0;

  const setupClassCounts = kept.reduce((acc, row) => {
    const key = String(row.setupClass || "UNKNOWN").toUpperCase();
    acc[key] = safeNumber(acc[key], 0) + 1;
    return acc;
  }, {});

  return {
    target,
    preset,
    kept: kept.length,
    rejected: rows.length - kept.length,
    keepRatio: optRound(keepRatio, 4),

    setupClassCounts,

    ...statsRow,

    decisionScore: scoreRunnerMasterStats(statsRow, keepRatio),

    examples: kept.slice(-12).map(row => ({
      source: row.source,
      symbol: row.symbol,
      side: row.side,
      setupClass: row.setupClass,
      entryType: row.entryType,
      scannerFlow: row.scannerFlow,
      flow: row.flow,
      rsiZone: row.rsiZone,
      obBias: row.obBias,
      confluence: row.confluence,
      sniperScore: row.sniperScore,
      baseRR: row.baseRR,
      targetR: row.targetR,
      exitR: row.exitR,
      pnlPct: row.pnlPct,
      mfeR: row.mfeR,
      maeR: row.maeR
    }))
  };
}

function buildRunnerMasterRows() {
  const realRows = (stats.closedTrades || [])
    .map(optNormalizeOutcomeRow)
    .filter(row => Number.isFinite(Number(row.exitR)))
    .filter(row => row.hasRiskGeometry);

  const scanShadowRows = (stats.shadowRows || [])
    .filter(row => String(row.source || "").toUpperCase() === "SCAN_SHADOW")
    .filter(row => row.status && row.status !== "OPEN")
    .map(optNormalizeOutcomeRow)
    .filter(row => Number.isFinite(Number(row.exitR)))
    .filter(row => row.hasRiskGeometry);

  const otherShadowRows = (stats.shadowRows || [])
    .filter(row => String(row.source || "").toUpperCase() !== "SCAN_SHADOW")
    .filter(row => row.status && row.status !== "OPEN")
    .map(optNormalizeOutcomeRow)
    .filter(row => Number.isFinite(Number(row.exitR)))
    .filter(row => row.hasRiskGeometry);

  const rows = scanShadowRows.length >= RUNNER_MASTER_MIN_SAMPLE
    ? [...scanShadowRows, ...realRows]
    : [...scanShadowRows, ...realRows, ...otherShadowRows];

  return rows.slice(-RUNNER_MASTER_MAX_ROWS);
}

function runnerMinCompletedForTarget(target) {
  return target === "COMBINED"
    ? RUNNER_MASTER_MIN_SAMPLE
    : RUNNER_MASTER_MIN_CLASS_SAMPLE;
}

function optimizeRunnerMasterTarget(rows, target) {
  const currentPreset = buildCurrentRunnerMasterPreset();
  const currentEval = evaluateRunnerMasterPreset(rows, currentPreset, target);
  const minCompleted = runnerMinCompletedForTarget(target);

  if (rows.length < minCompleted) {
    return {
      target,
      decision: "SAMPLE_TOO_SMALL_KEEP_CURRENT",
      sample: {
        usableRows: rows.length,
        minRequired: minCompleted,
        confidence: "LOW"
      },
      current: currentEval,
      best: currentEval,
      changedKeys: [],
      coverageOk: true,
      missingFilters: []
    };
  }

  const optimizationKeys = getRunnerOptimizationKeys(target);
  let beam = [currentPreset];

  for (let pass = 0; pass < RUNNER_MASTER_BEAM_PASSES; pass++) {
    const candidateMap = new Map();

    for (const preset of beam) {
      candidateMap.set(stableRunnerPresetKey(preset), preset);

      for (const key of optimizationKeys) {
        const values = runnerCandidateValues(key, preset[key], target);

        for (const value of values) {
          const next = {
            ...preset,
            [key]: value
          };

          candidateMap.set(stableRunnerPresetKey(next), next);
        }
      }
    }

    const evaluated = Array.from(candidateMap.values())
      .map(preset => evaluateRunnerMasterPreset(rows, preset, target))
      .filter(result => safeNumber(result.completed, 0) >= minCompleted)
      .sort((a, b) => safeNumber(b.decisionScore, 0) - safeNumber(a.decisionScore, 0));

    if (!evaluated.length) {
      beam = [currentPreset];
      break;
    }

    beam = evaluated
      .slice(0, RUNNER_MASTER_BEAM_WIDTH)
      .map(result => result.preset);
  }

  const finalEvaluated = beam
    .map(preset => evaluateRunnerMasterPreset(rows, preset, target))
    .filter(result => safeNumber(result.completed, 0) >= minCompleted)
    .sort((a, b) => safeNumber(b.decisionScore, 0) - safeNumber(a.decisionScore, 0));

  const best = finalEvaluated[0] || currentEval;

  const changedKeys = runnerMasterFilterKeys()
    .filter(key => JSON.stringify(best.preset[key]) !== JSON.stringify(currentPreset[key]))
    .map(key => ({
      parameter: key,
      currentValue: currentPreset[key],
      suggestedValue: best.preset[key]
    }));

  const missingFilters = runnerMasterFilterKeys()
    .filter(key => !Object.prototype.hasOwnProperty.call(best.preset, key));

  return {
    target,
    decision: missingFilters.length
      ? "BEST_PRESET_FOUND_BUT_FILTER_COVERAGE_INCOMPLETE"
      : `BEST_RUNNER_${target}_PNL_AFSTELLING`,

    sample: {
      usableRows: rows.length,
      completed: best.completed,
      minRequired: minCompleted,
      confidence:
        best.completed >= 100
          ? "HIGH"
          : best.completed >= 40
            ? "MEDIUM"
            : "LOW"
    },

    current: currentEval,
    best,

    deltaVsCurrent: {
      totalPnlPctDelta: optRound(best.totalPnlPct - currentEval.totalPnlPct, 3),
      totalRDelta: optRound(best.totalR - currentEval.totalR, 3),
      avgRDelta: optRound(best.avgR - currentEval.avgR, 3),
      avgPnlPctDelta: optRound(best.avgPnlPct - currentEval.avgPnlPct, 3),
      winrateDeltaPct: optRound((best.winrateNum - currentEval.winrateNum) * 100, 2),
      profitFactorDelta: optRound(best.profitFactorR - currentEval.profitFactorR, 3),
      decisionScoreDelta: optRound(best.decisionScore - currentEval.decisionScore, 3)
    },

    changedKeys,

    coverageOk: missingFilters.length === 0,
    missingFilters
  };
}

function mergeRunnerRecommendedLiveAfstelling({ combined, bestA, bestB }) {
  const current = buildCurrentRunnerMasterPreset();

  const combinedPreset = combined?.best?.preset || current;
  const aPreset = bestA?.best?.preset || current;
  const bPreset = bestB?.best?.preset || current;

  const merged = {
    ...current,
    ...combinedPreset
  };

  for (const key of runnerMasterFilterKeys()) {
    if (isRunnerAOnlyKey(key)) {
      merged[key] = aPreset[key];
      continue;
    }

    if (isRunnerBOnlyKey(key)) {
      merged[key] = bPreset[key];
      continue;
    }
  }

  // Liquidity floor niet automatisch onder huidige live floor zetten.
  merged.MIN_DEPTH_USD_1P = Math.max(
    safeNumber(merged.MIN_DEPTH_USD_1P, MIN_DEPTH_USD_1P),
    MIN_DEPTH_USD_1P
  );

  merged.SQUEEZE_MIN_DEPTH_USD_1P = Math.max(
    safeNumber(merged.SQUEEZE_MIN_DEPTH_USD_1P, SQUEEZE_MIN_DEPTH_USD_1P),
    SQUEEZE_MIN_DEPTH_USD_1P
  );

  return merged;
}

function runnerPatchValue(value) {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (value instanceof Set) return `new Set(${JSON.stringify(Array.from(value))})`;
  return String(value);
}

function buildRunnerPatchLinesFromPreset(preset) {
  return runnerMasterFilterKeys().map(key => {
    if (key === "LIVE_SCANNER_HOT_FLOWS") {
      return `const LIVE_SCANNER_HOT_FLOWS = new Set(${JSON.stringify(preset[key])});`;
    }

    if (key === "BLOCK_ENTRY_TYPES") {
      return `const BLOCK_ENTRY_TYPES = new Set(${JSON.stringify(preset[key])});`;
    }

    return `const ${key} = ${runnerPatchValue(preset[key])};`;
  });
}

function compactRunnerOptimizationResult(result) {
  return {
    target: result.target,
    decision: result.decision,
    sample: result.sample,

    expectedPerformance: {
      completed: result.best?.completed || 0,
      wins: result.best?.wins || 0,
      losses: result.best?.losses || 0,
      winrate: result.best?.winrate || "0.0%",

      totalPnlPct: result.best?.totalPnlPct || 0,
      avgPnlPct: result.best?.avgPnlPct || 0,

      totalR: result.best?.totalR || 0,
      avgR: result.best?.avgR || 0,

      profitFactorR: result.best?.profitFactorR || 0,
      directSLPct: result.best?.directSLPct || "0.0%",
      keepRatio: result.best?.keepRatio || 0,
      decisionScore: result.best?.decisionScore || 0,

      setupClassCounts: result.best?.setupClassCounts || {}
    },

    deltaVsCurrent: result.deltaVsCurrent || null,
    changedKeys: result.changedKeys || [],

    coverage: {
      coverageOk: Boolean(result.coverageOk),
      missingFilters: result.missingFilters || []
    },

    afstelling: result.best?.preset || buildCurrentRunnerMasterPreset()
  };
}

function buildRunnerMasterBestAfstellingLog({ btcState, runId }) {
  const rows = buildRunnerMasterRows();

  const bestCombined = optimizeRunnerMasterTarget(rows, "COMBINED");
  const bestA = optimizeRunnerMasterTarget(rows, "A");
  const bestB = optimizeRunnerMasterTarget(rows, "B");

  const recommendedLiveAfstelling = mergeRunnerRecommendedLiveAfstelling({
    combined: bestCombined,
    bestA,
    bestB
  });

  const missingFilters = Array.from(new Set([
    ...(bestCombined.missingFilters || []),
    ...(bestA.missingFilters || []),
    ...(bestB.missingFilters || [])
  ]));

  return {
    tag: "RUNNER_MASTER_BEST_AFSTELLING",
    profile: "RUNNER",
    strategyVersion: STRATEGY_VERSION,
    runId,
    btcState,
    ts: Date.now(),

    objective: RUNNER_MASTER_OBJECTIVE,

    decision: missingFilters.length
      ? "FILTER_COVERAGE_INCOMPLETE"
      : "BEST_RUNNER_A_AND_B_PNL_AFSTELLING_READY",

    sample: {
      usableRows: rows.length,
      scanShadowRows: rows.filter(row => String(row.source || "").toUpperCase() === "SCAN_SHADOW").length,
      realRows: rows.filter(row => String(row.source || "").toUpperCase() === "REAL").length,
      confidence:
        rows.length >= 200
          ? "HIGH"
          : rows.length >= 80
            ? "MEDIUM"
            : "LOW"
    },

    mapping: {
      runnerA: ["RUNNER_A", "RUNNER_C"],
      runnerB: ["RUNNER_B"],
      note: "RUNNER_C wordt als A behandeld omdat live grade RUNNER_B ? B : A gebruikt."
    },

    bestA: compactRunnerOptimizationResult(bestA),
    bestB: compactRunnerOptimizationResult(bestB),
    bestCombined: compactRunnerOptimizationResult(bestCombined),

    recommendedLiveAfstelling,

    patchLines: buildRunnerPatchLinesFromPreset(recommendedLiveAfstelling),

    coverage: {
      testedFilterCount: runnerMasterFilterKeys().length,
      coverageOk: missingFilters.length === 0,
      missingFilters
    }
  };
}

// ================= RESULT STATS =================
function buildStatsSnapshot() {
  const closed = Array.isArray(stats.closedTrades) ? stats.closedTrades : [];
  const wins = safeNumber(stats.wins, 0);
  const losses = safeNumber(stats.losses, 0);
  const completed = wins + losses;

  const totalR = closed.reduce((sum, row) => {
    return sum + safeNumber(row.exitR, 0);
  }, 0);

  const totalPnlPct = closed.reduce((sum, row) => {
    return sum + safeNumber(row.pnlPct, 0);
  }, 0);

  return {
    profile: "RUNNER",
    strategyVersion: STRATEGY_VERSION,

    runs: safeNumber(stats.runs, 0),
    entries: safeNumber(stats.entries, 0),
    partials: safeNumber(stats.partials, 0),
    movesToBE: safeNumber(stats.movesToBE, 0),
    trails: safeNumber(stats.trails, 0),
    adds: safeNumber(stats.adds, 0),
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
    actionCounts: stats.actionCounts || {},

    closedTrades: closed.slice(-50),
    featureRows: (stats.featureRows || []).slice(-100),
    shadowRows: (stats.shadowRows || []).slice(-100),

    finalFilterDecision: buildFinalRunnerFilterDecision(),
    cohortLearning: buildCohortLearningReport(),

    durableEnabled: hasRedis(),
    durableLoadedAt: runtimeState.durableLoadedAt,
    durableSavedAt: runtimeState.durableSavedAt,

    servedAt: Date.now()
  };
}

function finalizeResult(actions, candidates, btcState, runId, startedAt) {
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
        scannerFlow: c.scannerFlow || getScannerFlow(c),
        liveEligible: Boolean(c.liveEligible),
        shadowOnly: Boolean(c.shadowOnly),
        ts: Date.now()
      }));

  stats.runs++;

  const waitReasonsThisRun = {};

  for (const action of finalActions) {
    if (String(action.action || "").toUpperCase() !== "WAIT") continue;
    incrementCounter(waitReasonsThisRun, action.reason);
  }

  const actionCountsThisRun = {};

  for (const action of finalActions) {
    incrementCounter(actionCountsThisRun, action.action);
  }

  vercelLog("info", "RUN_DONE", {
    runId,
    durationMs: Date.now() - startedAt,
    candidates: candidates.length,
    liveEligible: candidates.filter(c => c.liveEligible).length,
    shadowOnly: candidates.filter(c => c.shadowOnly).length,
    actions: finalActions.length,
    actionCounts: actionCountsThisRun,
    openPositions: memory.size,
    topWaitReasons: Object.entries(waitReasonsThisRun)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([reason, count]) => ({ reason, count }))
  });

  if (Date.now() - safeNumber(stats.lastOptimizerReportAt, 0) >= 5 * 60 * 1000) {
    const masterLog = buildRunnerMasterBestAfstellingLog({
      btcState,
      runId
    });

    stats.lastOptimizerReportAt = Date.now();

    console.log("RUNNER_MASTER_BEST_AFSTELLING", JSON.stringify(masterLog));
  }

  return {
    profile: "RUNNER",
    ok: true,
    strategyVersion: STRATEGY_VERSION,
    runId,
    btcState,

    actions: finalActions,
    candidatesCount: candidates.length,
    liveEligibleCandidates: candidates.filter(c => c.liveEligible).length,
    shadowOnlyCandidates: candidates.filter(c => c.shadowOnly).length,

    openPositions: Array.from(memory.values()).map(pos => ({
      symbol: pos.symbol,
      side: pos.side,
      setupClass: pos.setupClass,
      entryType: pos.entryType,
      scannerFlow: pos.scannerFlow,
      liveEligible: Boolean(pos.liveEligible),
      shadowOnly: Boolean(pos.shadowOnly),
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
  const startedAt = Date.now();

  const notify = options.notify !== false;
  const shouldLog = options.log !== false;

  const runId = `runner_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const lockOwner = `${runId}_${Math.random().toString(36).slice(2, 8)}`;

  const durableRequired = hasRedis();
  let lockAcquired = false;

  try {
    vercelLog("info", "RUN_START", {
      runId,
      inputType: Array.isArray(input) ? "array" : "payload",
      notify,
      shouldLog,
      durableRequired,
      hotOnlyLive: LIVE_ONLY_HOT_RUNNER,
      liveScannerHotFlows: Array.from(LIVE_SCANNER_HOT_FLOWS),
      openPositionsBeforeLoad: memory.size
    });

    if (durableRequired) {
      lockAcquired = await acquireRuntimeLock(lockOwner);

      if (!lockAcquired) {
        throw new Error("RUNNER_TRADE_SYSTEM_LOCK_BUSY");
      }
    }

    await loadDurableRuntimeState();
    await updateShadowOutcomes();

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

    const { candidates, prefilter } = buildTradeCandidates(rawCandidates);

    vercelLog("info", "PREFILTER", {
      runId,
      ...prefilter
    });

    const actions = [];

    let market = { trend: "NEUTRAL" };

    try {
      market = await getMarketContext();
    } catch (err) {
      vercelError("MARKET_CONTEXT_FAILED", err, { runId });
      market = { trend: "NEUTRAL" };
    }

    const btcState = scanBtc?.state || market?.trend || "NEUTRAL";

    if (!candidates.length) {
      return finalizeResult([], [], btcState, runId, startedAt);
    }

    const dataMap = new Map();

    let fetchOk = 0;
    let fetchFailed = 0;

    for (const chunk of chunkArray(candidates, 4)) {
      const results = await Promise.allSettled(
        chunk.map(c => fetchCoinData(c, runId))
      );

      for (let i = 0; i < results.length; i++) {
        const c = chunk[i];
        const symbol = normalizeBaseSymbol(c.symbol);

        if (results[i].status === "fulfilled") {
          dataMap.set(symbol, results[i].value);
          fetchOk++;
          continue;
        }

        fetchFailed++;

        vercelError("COIN_DATA_FETCH_FAILED", results[i].reason, {
          runId,
          symbol
        });

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

    vercelLog("info", "DATA_FETCH_SUMMARY", {
      runId,
      fetchOk,
      fetchFailed,
      candidates: candidates.length
    });

    for (const raw of candidates) {
      const c = {
        ...raw,
        symbol: normalizeBaseSymbol(raw.symbol),
        side: normalizeSide(raw.side),
        scannerFlow: raw.scannerFlow || getScannerFlow(raw),
        liveEligible: Boolean(raw.liveEligible),
        shadowOnly: Boolean(raw.shadowOnly),
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
      const sniperScore = safeNumber(sniper?.score ?? sniper?.runnerScore, 0);

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

      // ================= RUNNER SCAN OBSERVATION BEFORE LIVE FILTERS =================
      const structureAligned = isStructureAligned(structure, c.side);
      const rsiExhaustedAgainstSideFlag = isRsiExhaustedAgainstSide(c.side === "bull", rsiZone);

      const continuationAllowed = isRsiContinuationAllowed({
        isBull: c.side === "bull",
        zone: rsiZone,
        rsiSignal,
        confluence,
        sniperScore,
        rr: RSI_CONTINUATION_TEST_RR,
        flow: flow.type
      });

      const pullbackAllowed = isRsiPullbackEntry({
        isBull: c.side === "bull",
        zone: rsiZone,
        rsiSignal,
        sniperScore
      });

      let riskBase = null;
      let baseRR = 0;
      let strategy = "UNKNOWN";
      let setup = null;
      let targets = null;
      let finalRR = 0;

      if (safeNumber(c.price, 0) > 0 && !ob.fetchFailed) {
        try {
          riskBase = await calculateRisk(
            c,
            ob,
            liquidity,
            hasLiquidationData ? data.liquidation : null
          );

          baseRR = safeNumber(riskBase?.rr, 0);

          strategy = chooseStrategy({
            ...c,
            confluence,
            rr: baseRR || RUNNER_B_MIN_RR
          });

          setup = classifyRunnerSetup({
            c,
            flow,
            sniper,
            confluence,
            rr: baseRR,
            strategy
          });

          const candidateSetup = setup?.setupClass && setup.setupClass !== "NONE"
            ? setup
            : inferRunnerCandidateSetup({
                c,
                flow
              });

          targets = buildRunnerTargetsFromRisk(
            c,
            riskBase,
            candidateSetup.targetR
          );

          finalRR = calculateRRFromPrices(
            c.price,
            riskBase.sl,
            targets.tp,
            c.side
          );
        } catch {
          riskBase = null;
          baseRR = 0;
          finalRR = 0;
        }
      }

      recordScanObservation(buildRunnerScanObservation({
        c,
        ctx,
        risk: riskBase,
        targets,
        baseRR,
        finalRR,
        setup,
        strategy,
        rsiSignal,
        rsiZone,
        continuationAllowed,
        pullbackAllowed,
        rsiExhaustedAgainstSide: rsiExhaustedAgainstSideFlag,
        structureAligned,
        hasLiquidationData,
        runId
      }));

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

      if (c.runnerPressure < MIN_RUNNER_PRESSURE) {
        actions.push(buildWait(c, "RUNNER_PRESSURE_TOO_LOW", ctx));
        continue;
      }

      if (c.runnerAcceleration < MIN_RUNNER_ACCELERATION) {
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

      if (rsiSignal.blocked) {
        actions.push(buildWait(c, "RSI_BLOCKED", ctx));
        continue;
      }

      if (rsiExhaustedAgainstSideFlag) {
        actions.push(buildWait(c, "RSI_EXHAUSTED_AGAINST_SIDE", ctx));
        continue;
      }

      if (!continuationAllowed && !pullbackAllowed) {
        actions.push(buildWait(c, "RSI_NO_RUNNER_EDGE", ctx));
        continue;
      }

      if (!isStructureAligned(structure, c.side) && confluence < STRUCTURE_AGAINST_MIN_CONFLUENCE) {
        actions.push(buildWait(c, "STRUCTURE_AGAINST", ctx));
        continue;
      }

      const spread = normalizeSpread(ob.spreadPct);

      const maxSpread = flow.type === "SQUEEZE"
        ? SQUEEZE_MAX_SPREAD_PCT
        : MAX_SPREAD_PCT;

      if (spread > maxSpread && confluence < SPREAD_EXCEPTION_MIN_CONFLUENCE) {
        actions.push(buildWait(c, "SPREAD_TOO_WIDE", ctx));
        continue;
      }

      const minDepth = flow.type === "SQUEEZE"
        ? SQUEEZE_MIN_DEPTH_USD_1P
        : MIN_DEPTH_USD_1P;

      if (safeNumber(ob.depthMinUsd1p, 0) < minDepth && confluence < DEPTH_EXCEPTION_MIN_CONFLUENCE) {
        actions.push(buildWait(c, "DEPTH_TOO_LOW", ctx));
        continue;
      }

      if (isObAgainstSide(ob, c.side) && confluence < OB_AGAINST_MIN_CONFLUENCE) {
        actions.push(buildWait(c, "OB_AGAINST", ctx));
        continue;
      }

      const fundingRate = safeNumber(funding.rate, 0);

      if (Math.abs(fundingRate) > FUNDING_EXTREME_ABS_MAX && confluence < FUNDING_MIN_CONFLUENCE) {
        actions.push(buildWait(c, "FUNDING_EXTREME", ctx));
        continue;
      }

      if (c.side === "bull" && fundingRate > LONG_CROWDED_FUNDING_MAX && confluence < FUNDING_MIN_CONFLUENCE) {
        actions.push(buildWait(c, "LONG_CROWDED_FUNDING", ctx));
        continue;
      }

      if (c.side === "bear" && fundingRate < SHORT_CROWDED_FUNDING_MIN && confluence < FUNDING_MIN_CONFLUENCE) {
        actions.push(buildWait(c, "SHORT_CROWDED_FUNDING", ctx));
        continue;
      }

      if (btcState === "STRONG_BULL" && c.side === "bear" && confluence < BTC_STRONG_COUNTER_MIN_CONFLUENCE) {
        actions.push(buildWait(c, "BTC_STRONG_BULL_BLOCK_SHORT", ctx));
        continue;
      }

      if (btcState === "STRONG_BEAR" && c.side === "bull" && confluence < BTC_STRONG_COUNTER_MIN_CONFLUENCE) {
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

      if (sniperScore < MIN_SNIPER_SCORE) {
        actions.push(buildWait(c, "SNIPER_TOO_LOW", {
          ...ctx,
          requiredSniper: MIN_SNIPER_SCORE
        }));
        continue;
      }

      if (String(strategy).toUpperCase() === "SAFE" && confluence < STRATEGY_SAFE_MIN_CONFLUENCE) {
        actions.push(buildWait(c, "STRATEGY_SAFE_NOT_RUNNER_READY", ctx));
        continue;
      }

      if (!riskBase || !safeNumber(riskBase.sl, 0)) {
        actions.push(buildWait(c, "RISK_INVALID", ctx));
        continue;
      }

      if (!setup) {
        setup = classifyRunnerSetup({
          c,
          flow,
          sniper,
          confluence,
          rr: baseRR,
          strategy
        });
      }

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

      const badCohortReason = getBadLiveCohortReason({
        setup,
        flowType: flow.type,
        rsiZone,
        obBias: ob.bias
      });

      if (badCohortReason) {
        actions.push(buildWait(c, badCohortReason, {
          ...ctx,
          rr: baseRR,
          risk: riskBase,
          requiredRR
        }));
        continue;
      }

      targets = buildRunnerTargetsFromRisk(c, riskBase, setup.targetR);

      finalRR = calculateRRFromPrices(
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

      const watchCohortReason = getWatchLiveCohortReason({
        setup,
        flowType: flow.type,
        rsiZone,
        obBias: ob.bias,
        confluence,
        sniperScore,
        runnerPressure: c.runnerPressure
      });

      if (watchCohortReason) {
        actions.push(buildWait(c, watchCohortReason, {
          ...ctx,
          rr: finalRR,
          risk: {
            ...riskBase,
            tp: targets.tp
          },
          requiredConfluence: WATCH_MID_RUNNING_NEUTRAL_MIN_CONFLUENCE,
          requiredSniper: WATCH_MID_RUNNING_NEUTRAL_MIN_SNIPER,
          requiredRR: setup.minRR
        }));

        vercelLog("info", "WATCH_COHORT_BLOCK", {
          runId,
          symbol: c.symbol,
          side: c.side,
          setupClass: setup.setupClass,
          entryType: setup.entryType,
          scannerFlow: c.scannerFlow,
          detectedFlow: flow.type,
          rsiZone,
          obBias: ob.bias,
          reason: watchCohortReason,
          confluence,
          sniperScore,
          runnerPressure: c.runnerPressure,
          runnerAcceleration: c.runnerAcceleration,
          rr: finalRR
        });

        continue;
      }

      const liveFunnelBlockReason = getLiveFunnelBlockReason(c);

      if (liveFunnelBlockReason) {
        const shadowPayload = buildWait(c, liveFunnelBlockReason, {
          ...ctx,
          rr: finalRR,
          risk: {
            ...riskBase,
            tp: targets.tp
          },
          requiredConfluence: setup.minConfluence,
          requiredSniper: setup.minSniper,
          requiredRR: setup.minRR
        });

        vercelLog("info", "SHADOW_ONLY_CANDIDATE", {
          runId,
          symbol: c.symbol,
          side: c.side,
          stage: c.stage,
          scannerFlow: c.scannerFlow,
          detectedFlow: flow.type,
          reason: liveFunnelBlockReason,
          score: c.moveScore,
          confluence,
          sniperScore,
          rsiZone,
          obBias: ob.bias,
          entry: c.price,
          sl: riskBase.sl,
          tp: targets.tp,
          rr: finalRR
        });

        actions.push(shadowPayload);
        continue;
      }

      const position = buildPositionFromEntry({
        c,
        ctx,
        risk: riskBase,
        targets,
        rr: finalRR,
        targetR: setup.targetR,
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
        targetR: setup.targetR,

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
        incrementCounter(stats.actionCounts, "ENTRY");

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

        vercelLog("info", "ENTRY", {
          runId,
          symbol: c.symbol,
          side: c.side,
          setupClass: setup.setupClass,
          entryType: setup.entryType,
          scannerFlow: c.scannerFlow,
          liveEligible: c.liveEligible,
          shadowOnly: c.shadowOnly,
          entry: position.entry,
          sl: position.sl,
          tp: position.tp,
          partialTp: position.partialTp,
          rr: finalRR,
          targetR: setup.targetR,
          score: c.moveScore,
          confluence,
          sniperScore,
          flow: flow.type,
          rsiZone,
          obBias: ob.bias,
          runnerPressure: c.runnerPressure,
          runnerAcceleration: c.runnerAcceleration
        });

        actions.push(entryPayload);
      } finally {
        processingLocks.delete(lockKey);
      }
    }

    return finalizeResult(actions, candidates, btcState, runId, startedAt);
  } catch (err) {
    vercelError("RUN_FAILED", err, {
      runId,
      durationMs: Date.now() - startedAt,
      openPositions: memory.size
    });

    throw err;
  } finally {
    if (!durableRequired || lockAcquired) {
      await saveDurableRuntimeState();
    }

    if (lockAcquired) {
      await releaseRuntimeLock(lockOwner);
    }
  }
}

// ================= DEBUG EXPORTS =================
export function getRunnerTradeSystemStats() {
  return buildStatsSnapshot();
}

export function getRunnerOptimizerReport() {
  return buildOptimizerReport();
}

export function getRunnerFinalFilterDecision() {
  return buildRunnerMasterBestAfstellingLog({
    btcState: "MANUAL",
    runId: "manual_export"
  });
}

export function forceRunnerOptimizerLog() {
  const masterLog = buildRunnerMasterBestAfstellingLog({
    btcState: "MANUAL",
    runId: "force_log"
  });

  stats.lastOptimizerReportAt = Date.now();

  console.log("RUNNER_MASTER_BEST_AFSTELLING", JSON.stringify(masterLog));

  return masterLog;
}

export function getRunnerCohortLearningReport() {
  return buildCohortLearningReport();
}