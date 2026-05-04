// lib/tradeSystem.js
// ================= RUNNER TRADE SYSTEM =================
// Inline Vercel logs via console.log / console.warn / console.error.
// Geen aparte logger-module nodig.
//
// Focus:
// - Runner entries
// - Partial TP
// - Break-even
// - Trailing stop
// - Optional add
// - Compact Vercel telemetry logs
// - Closed-loop optimizer data: rejects, entries, exits, MFE/MAE, shadow outcomes

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
const STRATEGY_VERSION = "RUNNER_TS_V1_0_INLINE_VERCEL_LOGS";

// ================= VERCEL LOG CONFIG =================
const RUNNER_LOG_LEVEL = String(process.env.RUNNER_LOG_LEVEL || "info").toLowerCase();
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

const MIN_SCORE = 58;
const MIN_TF_STRENGTH = 1;
const MIN_CONFLUENCE = 64;
const MIN_SNIPER_SCORE = 58;

const MAX_SPREAD_PCT = 0.0024;
const SQUEEZE_MAX_SPREAD_PCT = 0.0032;

const MIN_DEPTH_USD_1P = 120000;
const SQUEEZE_MIN_DEPTH_USD_1P = 80000;

const RUNNER_A_MIN_CONFLUENCE = 74;
const RUNNER_A_MIN_SNIPER = 70;
const RUNNER_A_MIN_RR = 1.18;

const RUNNER_B_MIN_CONFLUENCE = 68;
const RUNNER_B_MIN_SNIPER = 62;
const RUNNER_B_MIN_RR = 1.10;

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
const TRAIL_MIN_CHANGE_PCT = 0.0005;

const MAX_ADDS = 1;
const ADD_MIN_R = 0.65;
const ADD_MIN_CONFLUENCE = 78;
const ADD_MIN_SNIPER = 74;

const SHADOW_MONITOR_MS = 4 * 60 * 60 * 1000;
const SHADOW_MAX_ACTIVE_PER_RUN = 18;
const SHADOW_MAX_ROWS = 3000;

const MAX_FEATURE_ROWS = 5000;
const MAX_CLOSED_ROWS = 1000;

const RUNTIME_STORE_KEY = `runnerTradeSystem:runtime:${STRATEGY_VERSION}`;
const RUNTIME_LOCK_KEY = `runnerTradeSystem:runtimeLock:${STRATEGY_VERSION}`;

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

function hydrateRuntimeState(payload) {
  if (!payload || payload.strategyVersion !== STRATEGY_VERSION) {
    return false;
  }

  replaceMapContents(memory, payload.memory);
  replaceMapContents(cooldownMap, payload.cooldownMap);
  replaceMapContents(symbolCooldownMap, payload.symbolCooldownMap);
  replaceMapContents(notifyState, payload.notifyState);

  Object.assign(stats, createRuntimeState().stats, payload.stats || {});
  trimStats();

  runtimeState.durableLoadedAt = Date.now();

  vercelLog("info", "RUNTIME_LOADED", {
    openPositions: memory.size,
    closedTrades: stats.closedTrades.length,
    featureRows: stats.featureRows.length,
    shadowRows: stats.shadowRows.length
  });

  return true;
}

async function loadDurableRuntimeState() {
  if (!hasRedis()) {
    vercelDebug("RUNTIME_LOAD_SKIPPED", {
      reason: "redis_not_configured"
    });
    return false;
  }

  try {
    const result = await redisCommand(["GET", RUNTIME_STORE_KEY]);

    if (!result) {
      vercelDebug("RUNTIME_LOAD_EMPTY");
      return false;
    }

    const parsed = typeof result === "string"
      ? JSON.parse(result)
      : result;

    return hydrateRuntimeState(parsed);
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

    if (
      stageDiff === 0 &&
      safeNumber(normalized.moveScore, 0) > safeNumber(prev.moveScore, 0)
    ) {
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
  prefilter.finalCandidates = candidates.length;

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

function createShadowFromWait(payload) {
  if (!payload || payload.action !== "WAIT") return;
  if (!payload.entry || !payload.sl || !payload.tp) return;
  if (payload.fromOpenPosition) return;

  const entry = safeNumber(payload.entry, 0);
  const sl = safeNumber(payload.sl, 0);
  const tp = safeNumber(payload.tp, 0);

  if (!entry || !sl || !tp) return;

  stats.shadowRows.push({
    ...payload,
    id: `shadow_${payload.symbol}_${payload.side}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    source: "SHADOW",
    status: "OPEN",
    createdAt: Date.now(),
    monitorUntil: Date.now() + SHADOW_MONITOR_MS,
    ticks: 0,
    exit: null,
    exitR: null,
    pnlPct: null,
    hitTP: false,
    hitSL: false,
    win: false,
    loss: false,
    flat: false,
    mfeR: 0,
    maeR: 0
  });

  if (stats.shadowRows.length > SHADOW_MAX_ROWS) {
    stats.shadowRows = stats.shadowRows.slice(-SHADOW_MAX_ROWS);
  }
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
  createShadowFromWait(payload);

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
    const payload = buildPositionAction(
      "HOLD",
      "PRICE_INVALID_OPEN_POSITION",
      c,
      pos,
      ctx
    );

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
        grade: pos.setupClass === "RUNNER_B" ? "B" : "A"
      });
    }

    memory.delete(key);
    notifyState.delete(key);

    cooldownMap.set(key, Date.now() + COOLDOWN_MS);
    symbolCooldownMap.set(pos.symbol, Date.now() + SYMBOL_REENTRY_COOLDOWN_MS);

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
  row.exitR = Number.isFinite(Number(r)) ? Number(Number(r).toFixed(3)) : null;
  row.pnlPct = Number(safeNumber(pnlPct, 0).toFixed(3));
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
    return completeShadow(row, "HIT_TP", current, r, pnlPct);
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

async function fetchShadowPrice(row) {
  const symbol = normalizeBitgetSymbol(row?.symbol);
  if (!symbol) return 0;

  try {
    const raw = await cachedFetch(
      `shadow_ob_${symbol}`,
      () => fetchOrderBook(symbol),
      12000
    );

    const analyzed = raw ? analyzeOrderBookAdvanced(raw) : null;

    return safeNumber(analyzed?.mid, 0);
  } catch {
    return 0;
  }
}

async function updateShadowOutcomes() {
  if (!Array.isArray(stats.shadowRows) || !stats.shadowRows.length) return;

  const active = stats.shadowRows
    .filter(row => row?.status === "OPEN")
    .slice(-SHADOW_MAX_ROWS)
    .slice(0, SHADOW_MAX_ACTIVE_PER_RUN);

  let updated = 0;
  let completed = 0;

  for (const row of active) {
    const price = await fetchShadowPrice(row);
    if (!price) continue;

    const before = row.status;

    updateShadowWithPrice(row, price);
    updated++;

    if (before === "OPEN" && row.status !== "OPEN") {
      completed++;
    }
  }

  if (updated > 0 || completed > 0) {
    vercelLog("info", "SHADOW_UPDATE", {
      updated,
      completed,
      openShadowRows: stats.shadowRows.filter(r => r.status === "OPEN").length,
      totalShadowRows: stats.shadowRows.length
    });
  }
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
    score >= 76 &&
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
    score >= 72 &&
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
    score >= 66 &&
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

// ================= OPTIMIZER REPORT =================
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

function maybeLogOptimizerReport(force = false) {
  const now = Date.now();

  if (!force && now - safeNumber(stats.lastOptimizerReportAt, 0) < 5 * 60 * 1000) {
    return null;
  }

  const report = buildOptimizerReport();
  stats.lastOptimizerReportAt = now;

  console.log("RUNNER_OPTIMIZER_REPORT", JSON.stringify(report));

  return report;
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
    actions: finalActions.length,
    actionCounts: actionCountsThisRun,
    openPositions: memory.size,
    topWaitReasons: Object.entries(waitReasonsThisRun)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([reason, count]) => ({ reason, count }))
  });

  maybeLogOptimizerReport(false);

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

      if (rsiSignal.blocked) {
        actions.push(buildWait(c, "RSI_BLOCKED", ctx));
        continue;
      }

      if (isRsiExhaustedAgainstSide(c.side === "bull", rsiZone)) {
        actions.push(buildWait(c, "RSI_EXHAUSTED_AGAINST_SIDE", ctx));
        continue;
      }

      const continuationAllowed = isRsiContinuationAllowed({
        isBull: c.side === "bull",
        zone: rsiZone,
        rsiSignal,
        confluence,
        sniperScore,
        rr: 1.2,
        flow: flow.type
      });

      const pullbackAllowed = isRsiPullbackEntry({
        isBull: c.side === "bull",
        zone: rsiZone,
        rsiSignal,
        sniperScore
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

      if (String(strategy).toUpperCase() === "SAFE" && confluence < 82) {
        actions.push(buildWait(c, "STRATEGY_SAFE_NOT_RUNNER_READY", ctx));
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
        strategy
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

      const targets = buildRunnerTargetsFromRisk(c, riskBase, setup.targetR);

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

// ================= DEBUG EXPORT =================
export function getRunnerTradeSystemStats() {
  return buildStatsSnapshot();
}

export function getRunnerOptimizerReport() {
  return buildOptimizerReport();
}