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
  sendEntry,
  sendExit
} from "./discordNotifier.js";

import { updateOrderbookMemory } from "./orderbookMemory.js";
import { chooseStrategy } from "./strategy.js";
import { getStructureState } from "./structureEngine.js";
import { getRunnerFamilyForRow } from "./analyze/runnerFamilyEngine.js";

// ================= STRATEGY VERSION =================

const STRATEGY_VERSION = "RUNNER_TS_V1_9_LIVE_DISCORD_FAMILY_GATE";

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
const ADD_MIN_CONFLUENCE = 0;
const ADD_MIN_SNIPER = 0;

const SHADOW_MONITOR_MS = 4 * 60 * 60 * 1000;
const SHADOW_MAX_ACTIVE_PER_RUN = 300;
const SHADOW_MAX_ROWS = 40000;

const MAX_FEATURE_ROWS = 80000;
const MAX_CLOSED_ROWS = 5000;

const COOLDOWN_MS = Number(process.env.RUNNER_PAIR_COOLDOWN_MS || 3 * 60 * 1000);
const SYMBOL_REENTRY_COOLDOWN_MS = Number(process.env.RUNNER_SYMBOL_COOLDOWN_MS || 5 * 60 * 1000);

const EXIT_NOTIFY_DEDUP_TTL_MS = Number(
  process.env.RUNNER_EXIT_NOTIFY_DEDUP_TTL_MS || 6 * 60 * 60 * 1000
);

const DISCORD_ENTRY_DEDUP_TTL_MS = Number(
  process.env.RUNNER_DISCORD_ENTRY_DEDUP_TTL_MS || 6 * 60 * 60 * 1000
);

const RUNNER_LIVE_REQUIRES_DISCORD_FILTER =
  String(process.env.RUNNER_LIVE_REQUIRES_DISCORD_FILTER || "true").toLowerCase() !== "false";

const RUNNER_MAX_DISCORD_ENTRIES_PER_RUN = Number(
  process.env.RUNNER_MAX_DISCORD_ENTRIES_PER_RUN || 3
);

const RUNNER_MAX_DISCORD_OPEN_POSITIONS = Number(
  process.env.RUNNER_MAX_DISCORD_OPEN_POSITIONS || 12
);

const DURABLE_LOCK_ATTEMPTS = Number(process.env.RUNNER_DURABLE_LOCK_ATTEMPTS || 3);
const DURABLE_LOCK_TTL_MS = Number(process.env.RUNNER_DURABLE_LOCK_TTL_MS || 4 * 60 * 1000);
const DURABLE_LOCK_RETRY_MS = Number(process.env.RUNNER_DURABLE_LOCK_RETRY_MS || 250);

const RUNTIME_STORE_KEY = `runnerTradeSystem:runtime:${STRATEGY_VERSION}`;
const RUNTIME_META_KEY = `${RUNTIME_STORE_KEY}:meta`;
const RUNTIME_CHUNK_PREFIX = `${RUNTIME_STORE_KEY}:chunk:`;
const RUNTIME_LOCK_KEY = `runnerTradeSystem:runtimeLock:${STRATEGY_VERSION}`;

const RUNTIME_CHUNK_BYTES = Number(process.env.RUNNER_RUNTIME_CHUNK_BYTES || 700000);
const RUNTIME_MAX_JSON_BYTES = Number(process.env.RUNNER_RUNTIME_MAX_JSON_BYTES || 25000000);

const RUNTIME_DURABLE_MAX_CLOSED_ROWS = Number(process.env.RUNNER_RUNTIME_MAX_CLOSED_ROWS || 5000);
const RUNTIME_DURABLE_MAX_FEATURE_ROWS = Number(process.env.RUNNER_RUNTIME_MAX_FEATURE_ROWS || 5000);
const RUNTIME_DURABLE_MAX_SHADOW_ROWS = Number(process.env.RUNNER_RUNTIME_MAX_SHADOW_ROWS || 8000);

const RUNTIME_CHUNK_DELETE_BATCH_SIZE = 50;

const RUNNER_TRACE = String(process.env.RUNNER_TRACE || "false").toLowerCase() === "true";
const RUNNER_TRACE_WAITS =
  String(process.env.RUNNER_TRACE_WAITS || process.env.RUNNER_TRACE || "false").toLowerCase() === "true";

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
  "TREND",
  "NEUTRAL",
  "UNKNOWN",
  "PULLBACK",
  "RANGE",
  "CHOP",
  "ACCUMULATION",
  "DISTRIBUTION",
  "REVERSAL",
  "EXHAUSTION",
  "OPEN_POSITION"
]);

const HOT_RUNNER_FLOWS = new Set([
  "SQUEEZE",
  "RUNNING",
  "BREAKOUT"
]);

// ================= DISCORD MICRO FAMILY FILTER =================

const DISCORD_ALLOWED_FAMILY_IDS = new Set([
  "LONG_36",
  "LONG_26",
  "LONG_16",

  "SHORT_26",
  "SHORT_28",
  "SHORT_36",
  "SHORT_38",
  "SHORT_46"
]);

// ================= GENERIC HELPERS =================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeNumber(value, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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
  const s = String(side || "").trim().toLowerCase();

  if (["bear", "short", "sell"].includes(s)) return "bear";
  if (["bull", "long", "buy"].includes(s)) return "bull";

  return "";
}

function normalizeFlow(flow) {
  return String(flow || "NEUTRAL").toUpperCase();
}

function normalizeFamilyId(value) {
  return String(value || "").trim().toUpperCase();
}

function expectedFamilyPrefixForSide(side) {
  const s = normalizeSide(side);

  if (s === "bull") return "LONG_";
  if (s === "bear") return "SHORT_";

  return "";
}

function familyIdMatchesTradeSide(familyId, side) {
  const id = normalizeFamilyId(familyId);
  const prefix = expectedFamilyPrefixForSide(side);

  if (!id || !prefix) return false;

  return id.startsWith(prefix);
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

function buildMemoryKey(symbol, side) {
  const s = normalizeBaseSymbol(symbol);
  const d = normalizeSide(side);
  if (!s || !d) return "";
  return `${s}_${d}`;
}

function getScannerFlow(c) {
  return normalizeFlow(c?.scannerFlow || c?.flow || c?.flowType || "NEUTRAL");
}

function isScannerHotRunnerCandidate(c) {
  return Boolean(c?.symbol);
}

function chunkArray(arr, size) {
  const chunks = [];

  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }

  return chunks;
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
  if (s === "bear") return trend !== "BULLISH";

  return false;
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
  if (a === "ANALYZE_ONLY") return 200;
  if (a === "WAIT") return 100;
  if (a === "OBSERVE") return 50;

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

// ================= TRACE =================

function runnerTrace(tag, payload = {}) {
  if (!RUNNER_TRACE) return;
  vercelLog("info", tag, payload);
}

function buildTraceSnapshot(c, ctx = {}, extra = {}) {
  const ob = ctx.ob || {};
  const sniper = ctx.sniper || {};
  const flow = ctx.flow || {};

  return {
    runId: ctx.runId || extra.runId || null,

    symbol: normalizeBaseSymbol(c?.symbol),
    side: normalizeSide(c?.side),
    stage: String(c?.stage || "unknown").toLowerCase(),

    price: safeNumber(c?.price, 0),
    score: safeNumber(c?.moveScore ?? c?.score, 0),

    flow: normalizeFlow(flow?.type || c?.flow || c?.scannerFlow),
    scannerFlow: getScannerFlow(c),

    confluence: safeNumber(ctx.confluence, 0),
    sniperScore: safeNumber(sniper?.score ?? sniper?.runnerScore, 0),

    rsi: ctx.rsi ?? null,
    rsiZone: ctx.rsiZone || null,

    obFetchFailed: Boolean(ob?.fetchFailed),
    spoof: Boolean(ob?.spoof),
    obBias: ob?.bias || "NEUTRAL",
    spreadPct: ob?.spreadPct ?? null,
    depthMinUsd1p: ob?.depthMinUsd1p ?? null,

    runnerPressure: safeNumber(c?.runnerPressure, 0),
    runnerAcceleration: safeNumber(c?.runnerAcceleration, 0),

    volatility: ctx.volatility || null,
    regime: ctx.regime || null,
    btcState: ctx.btcState || null,

    ts: Date.now(),

    ...extra
  };
}

function runnerWaitTrace(c, reason, ctx = {}, extra = {}) {
  if (!RUNNER_TRACE_WAITS) return;

  vercelLog("info", "RUNNER_WAIT", buildTraceSnapshot(c, ctx, {
    reason: String(reason || "UNKNOWN").toUpperCase(),
    ...extra
  }));
}

// ================= DISCORD FAMILY GATE =================

function getAllowedDiscordFamilyIds() {
  const envValue = String(process.env.RUNNER_DISCORD_FAMILIES || "").trim();

  if (!envValue) return DISCORD_ALLOWED_FAMILY_IDS;

  return new Set(
    envValue
      .split(",")
      .map(normalizeFamilyId)
      .filter(Boolean)
  );
}

function compactFamilyMeta(family) {
  if (!family?.familyId) return null;

  return {
    familyId: family.familyId,
    runnerFamilyId: family.familyId,
    analyzeFamilyId: family.familyId,
    analysisFamilyId: family.familyId,

    side: family.side,
    quality: family.quality,
    market: family.market,
    timing: family.timing,

    qualityIndex: family.qualityIndex,
    marketIndex: family.marketIndex,
    timingIndex: family.timingIndex,

    definition: family.definition,
    labels: Array.isArray(family.labels) ? family.labels : []
  };
}

function applyFamilyMeta(target, family) {
  if (!target || !family?.familyId) return target;

  target.familyId = family.familyId;
  target.runnerFamilyId = family.familyId;
  target.analyzeFamilyId = family.familyId;
  target.analysisFamilyId = family.familyId;

  target.quality = family.quality;
  target.market = family.market;
  target.timing = family.timing;

  target.qualityIndex = family.qualityIndex;
  target.marketIndex = family.marketIndex;
  target.timingIndex = family.timingIndex;

  target.definition = family.definition;
  target.labels = Array.isArray(family.labels) ? family.labels : [];

  return target;
}

function buildDiscordFamilyRow({
  c,
  ctx,
  ob,
  setup,
  finalRR,
  sniperScore,
  confluence,
  structureAligned = false,
  continuationAllowed = false,
  pullbackAllowed = false
}) {
  const spreadPct = normalizeSpread(ob?.spreadPct);
  const spreadBps = Number.isFinite(Number(ob?.spreadBps))
    ? Number(ob.spreadBps)
    : spreadPct * 10000;

  const fundingRate = safeNumber(
    ctx?.funding?.rate ??
      ctx?.fundingRate ??
      c?.fundingRate ??
      c?.funding,
    0
  );

  const score = safeNumber(c?.moveScore ?? c?.score, 0);
  const rr = safeNumber(finalRR, 0);

  return {
    ...c,

    symbol: normalizeBaseSymbol(c?.symbol),
    side: normalizeSide(c?.side),

    setupClass: setup?.setupClass || c?.setupClass || null,
    entryType: setup?.entryType || c?.entryType || c?.runnerEntryType || null,
    runnerEntryType: setup?.entryType || c?.runnerEntryType || c?.entryType || null,

    score,
    moveScore: score,

    confluence: safeNumber(confluence, 0),
    sniperScore: safeNumber(sniperScore, 0),
    sniper: safeNumber(sniperScore, 0),

    rr,
    plannedRR: rr,
    finalRR: rr,
    targetR: safeNumber(setup?.targetR ?? c?.targetR ?? rr, rr),

    stage: String(c?.stage || c?.scannerStage || "entry").toLowerCase(),
    scannerStage: String(c?.scannerStage || c?.stage || "entry").toLowerCase(),

    flow: normalizeFlow(ctx?.flow?.type || c?.flow || c?.scannerFlow),
    scannerFlow: normalizeFlow(c?.scannerFlow || ctx?.flow?.type || c?.flow),

    rsi: ctx?.rsi ?? c?.rsi ?? null,
    rsiZone: String(ctx?.rsiZone || c?.rsiZone || "UNKNOWN").toUpperCase(),

    obBias: String(ob?.bias || c?.obBias || "UNKNOWN").toUpperCase(),
    spreadPct,
    spreadBps,
    depthMinUsd1p: safeNumber(ob?.depthMinUsd1p ?? c?.depthMinUsd1p, 0),

    funding: fundingRate,
    fundingRate,

    btcState: String(ctx?.btcState || c?.btcState || "UNKNOWN").toUpperCase(),
    regime: String(ctx?.regime || c?.regime || "UNKNOWN").toUpperCase(),

    tfScore: safeNumber(c?.tfScore, 0),
    tfStrength: safeNumber(c?.tfStrength, Math.abs(safeNumber(c?.tfScore, 0))),
    tfAlignment: String(c?.tfAlignment || "UNKNOWN").toUpperCase(),

    structureAligned: Boolean(structureAligned),
    rsiContinuationAllowed: Boolean(continuationAllowed),
    rsiPullbackAllowed: Boolean(pullbackAllowed),

    pullbackConfirmed: Boolean(c?.pullbackConfirmed),
    sweepConfirmed: Boolean(c?.sweepConfirmed),
    retestConfirmed: Boolean(c?.retestConfirmed)
  };
}

function getDiscordEntryDecision(args) {
  const row = buildDiscordFamilyRow(args);
  const family = getRunnerFamilyForRow(row);
  const familyId = normalizeFamilyId(family?.familyId);
  const allowed = getAllowedDiscordFamilyIds();
  const expectedPrefix = expectedFamilyPrefixForSide(row.side);

  const metrics = {
    side: row.side,
    expectedPrefix,

    score: row.score,
    confluence: row.confluence,
    sniperScore: row.sniperScore,
    rr: row.plannedRR,

    flow: row.flow,
    scannerFlow: row.scannerFlow,
    stage: row.stage,

    rsiZone: row.rsiZone,
    obBias: row.obBias,

    spreadPct: row.spreadPct,
    spreadBps: row.spreadBps,
    depthMinUsd1p: row.depthMinUsd1p,

    btcState: row.btcState,
    fundingRate: row.fundingRate,

    tfStrength: row.tfStrength,
    tfAlignment: row.tfAlignment,

    structureAligned: row.structureAligned,
    rsiContinuationAllowed: row.rsiContinuationAllowed,
    rsiPullbackAllowed: row.rsiPullbackAllowed
  };

  if (!row.side || !expectedPrefix) {
    return {
      allowed: false,
      reason: "DISCORD_BAD_TRADE_SIDE",
      familyId: familyId || null,
      expectedPrefix: null,
      family: family ? compactFamilyMeta(family) : null,
      allowedFamilies: Array.from(allowed),
      metrics
    };
  }

  if (!familyId) {
    return {
      allowed: false,
      reason: "DISCORD_FAMILY_UNRESOLVED",
      familyId: null,
      expectedPrefix,
      family: null,
      allowedFamilies: Array.from(allowed),
      metrics
    };
  }

  if (!familyIdMatchesTradeSide(familyId, row.side)) {
    return {
      allowed: false,
      reason: "DISCORD_FAMILY_SIDE_MISMATCH",
      familyId,
      expectedPrefix,
      family: compactFamilyMeta(family),
      allowedFamilies: Array.from(allowed),
      metrics
    };
  }

  if (!allowed.has(familyId)) {
    return {
      allowed: false,
      reason: "DISCORD_FAMILY_NOT_ALLOWED",
      familyId,
      expectedPrefix,
      family: compactFamilyMeta(family),
      allowedFamilies: Array.from(allowed),
      metrics
    };
  }

  return {
    allowed: true,
    reason: "DISCORD_FAMILY_MATCH",
    familyId,
    expectedPrefix,
    family: compactFamilyMeta(family),
    allowedFamilies: Array.from(allowed),
    metrics
  };
}

function getEntryPairNotifyKey(symbol, side) {
  const s = normalizeBaseSymbol(symbol);
  const d = normalizeSide(side);
  if (!s || !d) return "";
  return `ENTRY_${s}_${d}`;
}

function getEntryExactNotifyKey(pos) {
  const symbol = normalizeBaseSymbol(pos?.symbol);
  const side = normalizeSide(pos?.side);
  const entry = safeNumber(pos?.entry, 0);

  if (!symbol || !side || !entry) return "";

  return `ENTRY_${symbol}_${side}_${Number(entry).toPrecision(12)}`;
}

function isFreshTimestamp(value, ttlMs) {
  const ts = safeNumber(value, 0);
  if (!ts) return false;
  return Date.now() - ts < ttlMs;
}

function hasRecentEntryNotify(symbol, side, entry = null) {
  const pairKey = getEntryPairNotifyKey(symbol, side);
  if (pairKey && isFreshTimestamp(notifyState.get(pairKey), DISCORD_ENTRY_DEDUP_TTL_MS)) {
    return true;
  }

  if (entry !== null) {
    const exactKey = getEntryExactNotifyKey({ symbol, side, entry });

    if (exactKey && isFreshTimestamp(notifyState.get(exactKey), DISCORD_ENTRY_DEDUP_TTL_MS)) {
      return true;
    }
  }

  const legacyKey = buildMemoryKey(symbol, side);
  const legacyValue = notifyState.get(legacyKey);

  if (legacyValue === true) return true;
  if (isFreshTimestamp(legacyValue, DISCORD_ENTRY_DEDUP_TTL_MS)) return true;

  return false;
}

function reserveEntryNotifyKeys(position) {
  const pairKey = getEntryPairNotifyKey(position?.symbol, position?.side);
  const exactKey = getEntryExactNotifyKey(position);

  if (pairKey) notifyState.set(pairKey, Date.now());
  if (exactKey) notifyState.set(exactKey, Date.now());

  return {
    pairKey,
    exactKey
  };
}

function releaseEntryNotifyKeys(keys = {}) {
  if (keys.pairKey) notifyState.delete(keys.pairKey);
  if (keys.exactKey) notifyState.delete(keys.exactKey);
}

function countDiscordManagedOpenPositions() {
  let count = 0;

  for (const pos of memory.values()) {
    if (pos?.discordEntryAllowed === true || pos?.discordEntryNotified === true) {
      count++;
    }
  }

  return count;
}

function getLiveEntryBlockReason({
  c,
  notify,
  discordDecision,
  discordEntriesSentThisRun
}) {
  if (!notify) return "NOTIFY_DISABLED_ANALYZE_ONLY";

  if (
    RUNNER_LIVE_REQUIRES_DISCORD_FILTER &&
    discordDecision?.allowed !== true
  ) {
    return discordDecision?.reason || "DISCORD_FILTER_NOT_ALLOWED";
  }

  if (hasRecentEntryNotify(c.symbol, c.side, c.price)) {
    return "DUPLICATE_ENTRY_NOTIFY";
  }

  if (discordEntriesSentThisRun >= RUNNER_MAX_DISCORD_ENTRIES_PER_RUN) {
    return "DISCORD_RUN_ENTRY_CAP";
  }

  if (countDiscordManagedOpenPositions() >= RUNNER_MAX_DISCORD_OPEN_POSITIONS) {
    return "DISCORD_OPEN_POSITION_CAP";
  }

  return null;
}

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

// ================= RUNTIME POSITION HYDRATION =================

function normalizeOpenPositionForMemory(pos) {
  if (!pos || typeof pos !== "object") return null;

  const symbol = normalizeBaseSymbol(pos.symbol);
  const side = normalizeSide(pos.side);

  if (!symbol || !side) return null;

  const entry = safeNumber(pos.entry, 0);
  const sl = safeNumber(pos.sl ?? pos.initialSl, 0);
  const tp = safeNumber(pos.tp, 0);

  if (!entry || !sl || !tp) return null;

  const now = Date.now();
  const allowedFamilies = getAllowedDiscordFamilyIds();

  const familyId = normalizeFamilyId(
    pos.discordFamilyId ||
      pos.familyId ||
      pos.runnerFamilyId ||
      pos.analyzeFamilyId ||
      pos.analysisFamilyId
  );

  const familyAllowed = Boolean(
    familyId &&
      allowedFamilies.has(familyId) &&
      familyIdMatchesTradeSide(familyId, side)
  );

  const discordEntryAllowed = Boolean(
    pos.discordEntryAllowed ??
      pos.discordAllowed ??
      familyAllowed
  ) && familyAllowed;

  const discordEntryNotified = Boolean(
    pos.discordEntryNotified ??
      pos.discordNotified ??
      familyAllowed
  ) && familyAllowed;

  const tradeId =
    pos.tradeId ||
    pos.positionTradeId ||
    `RUNNER_${symbol}_${side}_${safeNumber(pos.createdAt, now)}_${Number(entry).toPrecision(12)}`;

  return {
    ...pos,

    profile: "RUNNER",
    strategyVersion: pos.strategyVersion || STRATEGY_VERSION,

    tradeId,
    positionTradeId: pos.positionTradeId || tradeId,

    symbol,
    side,

    rawBitgetSymbol: pos.rawBitgetSymbol || normalizeBitgetSymbol(symbol),

    setupClass: pos.setupClass || "RUNNER_A",
    entryType: pos.entryType || pos.runnerEntryType || "RUNNER_A_BREAKOUT",
    runnerEntryType: pos.runnerEntryType || pos.entryType || "RUNNER_A_BREAKOUT",

    familyId: familyId || pos.familyId || null,
    runnerFamilyId: pos.runnerFamilyId || familyId || null,
    analyzeFamilyId: pos.analyzeFamilyId || familyId || null,
    analysisFamilyId: pos.analysisFamilyId || familyId || null,
    discordFamilyId: pos.discordFamilyId || familyId || null,

    entry,
    sl,
    initialSl: safeNumber(pos.initialSl ?? pos.sl, sl),
    tp,

    partialTp: safeNumber(pos.partialTp, 0),
    breakevenAt: safeNumber(pos.breakevenAt, 0),
    trailStart: safeNumber(pos.trailStart, 0),
    trailPrice: pos.trailPrice ?? null,

    rr: safeNumber(pos.rr ?? pos.plannedRR ?? pos.targetR, 0),
    targetR: safeNumber(pos.targetR ?? pos.rr ?? pos.plannedRR, 0),

    partialTaken: Boolean(pos.partialTaken),
    breakEvenMoved: Boolean(pos.breakEvenMoved),
    trailingActive: Boolean(pos.trailingActive),
    adds: safeNumber(pos.adds, 0),
    maxAdds: safeNumber(pos.maxAdds, MAX_ADDS),

    currentR: safeNumber(pos.currentR, 0),
    mfeR: safeNumber(pos.mfeR, 0),
    maeR: safeNumber(pos.maeR, 0),

    highestPrice: safeNumber(pos.highestPrice, entry),
    lowestPrice: safeNumber(pos.lowestPrice, entry),
    lastPrice: safeNumber(pos.lastPrice, entry),

    score: safeNumber(pos.score ?? pos.moveScore, 0),
    confluence: safeNumber(pos.confluence, 0),
    sniperScore: safeNumber(pos.sniperScore, 0),

    flow: pos.flow || pos.scannerFlow || "OPEN_POSITION",
    scannerFlow: pos.scannerFlow || pos.flow || "OPEN_POSITION",

    discordEntryAllowed,
    discordEntryNotified,
    discordEntryBlocked: Boolean(pos.discordEntryBlocked),
    discordBlockReason: pos.discordBlockReason || null,

    createdAt: safeNumber(pos.createdAt ?? pos.openedAt ?? pos.entryTs, now),
    updatedAt: safeNumber(pos.updatedAt, now)
  };
}

function normalizeOpenPositionMemoryKeys() {
  const next = new Map();

  for (const pos of memory.values()) {
    const normalized = normalizeOpenPositionForMemory(pos);
    if (!normalized) continue;

    const key = buildMemoryKey(normalized.symbol, normalized.side);
    if (!key) continue;

    next.set(key, normalized);
  }

  memory.clear();

  for (const [key, pos] of next.entries()) {
    memory.set(key, pos);
  }
}

function pruneNonDiscordManagedPositions() {
  let removed = 0;

  for (const [key, pos] of memory.entries()) {
    const familyId = normalizeFamilyId(
      pos?.discordFamilyId ||
        pos?.familyId ||
        pos?.runnerFamilyId ||
        pos?.analyzeFamilyId ||
        pos?.analysisFamilyId
    );

    const sideSafe = familyIdMatchesTradeSide(familyId, pos?.side);

    const keep =
      sideSafe &&
      (
        pos?.discordEntryAllowed === true ||
        pos?.discordEntryNotified === true
      );

    if (keep) continue;

    memory.delete(key);
    removed++;
  }

  return removed;
}

function seedOpenPositionsFromOptions(options = {}) {
  const rows = [
    ...(Array.isArray(options.previousOpenPositions) ? options.previousOpenPositions : []),
    ...(Array.isArray(options.openPositions) ? options.openPositions : [])
  ];

  if (!rows.length) return 0;

  let seeded = 0;

  for (const row of rows) {
    const pos = normalizeOpenPositionForMemory(row);
    if (!pos) continue;

    if (pos.discordEntryAllowed !== true && pos.discordEntryNotified !== true) {
      continue;
    }

    const familyId = normalizeFamilyId(
      pos.discordFamilyId ||
        pos.familyId ||
        pos.runnerFamilyId ||
        pos.analyzeFamilyId ||
        pos.analysisFamilyId
    );

    if (!familyIdMatchesTradeSide(familyId, pos.side)) {
      continue;
    }

    const key = buildMemoryKey(pos.symbol, pos.side);
    if (!key) continue;

    if (!memory.has(key)) {
      memory.set(key, pos);
      seeded++;
    }

    if (pos.discordEntryNotified) {
      reserveEntryNotifyKeys(pos);
    }
  }

  return seeded;
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
    const k = String(key);

    if (k.startsWith("EXIT_")) {
      if (now - safeNumber(value, 0) > EXIT_NOTIFY_DEDUP_TTL_MS) {
        notifyState.delete(key);
      }

      continue;
    }

    if (k.startsWith("ENTRY_")) {
      if (now - safeNumber(value, 0) > DISCORD_ENTRY_DEDUP_TTL_MS) {
        notifyState.delete(key);
      }

      continue;
    }

    if (value === true) {
      notifyState.delete(key);
      continue;
    }

    if (now - safeNumber(value, 0) > DISCORD_ENTRY_DEDUP_TTL_MS) {
      notifyState.delete(key);
    }
  }
}

function hasAnyOpenPositionForSymbol(symbol) {
  const base = normalizeBaseSymbol(symbol);

  for (const pos of memory.values()) {
    if (normalizeBaseSymbol(pos?.symbol) === base) return true;
  }

  return false;
}

function getOpenPositionSideForSymbol(symbol) {
  const base = normalizeBaseSymbol(symbol);

  for (const pos of memory.values()) {
    if (normalizeBaseSymbol(pos?.symbol) === base) {
      return normalizeSide(pos?.side) || "unknown";
    }
  }

  return null;
}

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

function byteLength(value) {
  return Buffer.byteLength(String(value || ""), "utf8");
}

async function redisCommand(command) {
  const url = getRedisUrl();
  const token = getRedisToken();

  if (!url || !token) {
    throw new Error("redis_env_missing");
  }

  const body = JSON.stringify(command);
  const requestBytes = byteLength(body);

  if (requestBytes > 9000000) {
    throw new Error(`redis_command_too_large:${requestBytes}`);
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body
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

function compactRuntimeRow(row) {
  if (!row || typeof row !== "object") return row;

  return {
    source: row.source,
    profile: row.profile,
    strategyVersion: row.strategyVersion,

    id: row.id,
    tradeId: row.tradeId,
    positionTradeId: row.positionTradeId,

    symbol: row.symbol,
    side: row.side,

    action: row.action,
    status: row.status,
    reason: row.reason,
    exitReason: row.exitReason,

    setupClass: row.setupClass,
    entryType: row.entryType,
    runnerEntryType: row.runnerEntryType,
    grade: row.grade,

    familyId: row.familyId,
    runnerFamilyId: row.runnerFamilyId,
    analyzeFamilyId: row.analyzeFamilyId,
    analysisFamilyId: row.analysisFamilyId,
    discordFamilyId: row.discordFamilyId,

    discordEntryAllowed: row.discordEntryAllowed,
    discordEntryNotified: row.discordEntryNotified,
    discordEntryBlocked: row.discordEntryBlocked,
    discordBlockReason: row.discordBlockReason,

    discordAllowed: row.discordAllowed,
    discordNotified: row.discordNotified,
    discordNotifyFailed: row.discordNotifyFailed,

    scannerFlow: row.scannerFlow,
    flow: row.flow,
    flowStrength: row.flowStrength,
    detectedFlow: row.detectedFlow,

    stage: row.stage,
    scannerStage: row.scannerStage,
    stageSource: row.stageSource,

    liveEligible: row.liveEligible,
    shadowOnly: row.shadowOnly,
    fromOpenPosition: row.fromOpenPosition,

    score: row.score,
    moveScore: row.moveScore,
    confluence: row.confluence,
    sniperScore: row.sniperScore,
    sniper: row.sniper,

    runnerPressure: row.runnerPressure,
    runnerAcceleration: row.runnerAcceleration,

    rsi: row.rsi,
    rsiZone: row.rsiZone,
    rsiValid: row.rsiValid,
    rsiBlocked: row.rsiBlocked,
    rsiContinuationAllowed: row.rsiContinuationAllowed,
    rsiPullbackAllowed: row.rsiPullbackAllowed,
    rsiExhaustedAgainstSide: row.rsiExhaustedAgainstSide,

    obBias: row.obBias,
    obAgainst: row.obAgainst,
    spreadPct: row.spreadPct,
    depthMinUsd1p: row.depthMinUsd1p,
    obFetchFailed: row.obFetchFailed,
    spoof: row.spoof,

    tfScore: row.tfScore,
    tfStrength: row.tfStrength,
    tfAlignment: row.tfAlignment,

    funding: row.funding,
    fundingRate: row.fundingRate,
    volatility: row.volatility,
    regime: row.regime,
    btcState: row.btcState,
    structure: row.structure,
    structureAligned: row.structureAligned,

    entry: row.entry,
    sl: row.sl,
    initialSl: row.initialSl,
    tp: row.tp,
    partialTp: row.partialTp,
    breakevenAt: row.breakevenAt,
    trailStart: row.trailStart,
    trailPrice: row.trailPrice,

    rr: row.rr,
    baseRR: row.baseRR,
    plannedRR: row.plannedRR,
    targetR: row.targetR,

    exit: row.exit,
    exitPrice: row.exitPrice,
    executionPrice: row.executionPrice,
    exitR: row.exitR,
    realizedR: row.realizedR,
    resultR: row.resultR,
    pnlR: row.pnlR,
    pnlPct: row.pnlPct,

    currentR: row.currentR,
    mfeR: row.mfeR,
    maeR: row.maeR,

    partialTaken: row.partialTaken,
    breakEvenMoved: row.breakEvenMoved,
    trailingActive: row.trailingActive,
    adds: row.adds,

    hitTP: row.hitTP,
    hitSL: row.hitSL,
    win: row.win,
    loss: row.loss,
    flat: row.flat,

    createdAt: row.createdAt,
    openedAt: row.openedAt,
    entryTs: row.entryTs,
    exitedAt: row.exitedAt,
    completedAt: row.completedAt,
    closedAt: row.closedAt,
    monitorUntil: row.monitorUntil,
    lastCheckedAt: row.lastCheckedAt,
    ts: row.ts
  };
}

function compactRuntimeStatsForSave() {
  trimStats();

  return {
    ...stats,

    closedTrades: (stats.closedTrades || [])
      .slice(-RUNTIME_DURABLE_MAX_CLOSED_ROWS)
      .map(compactRuntimeRow),

    featureRows: (stats.featureRows || [])
      .slice(-RUNTIME_DURABLE_MAX_FEATURE_ROWS)
      .map(compactRuntimeRow),

    shadowRows: (stats.shadowRows || [])
      .slice(-RUNTIME_DURABLE_MAX_SHADOW_ROWS)
      .map(compactRuntimeRow)
  };
}

function serializeRuntimeState() {
  return {
    strategyVersion: STRATEGY_VERSION,
    updatedAt: Date.now(),

    memory: Array.from(memory.entries()),
    cooldownMap: Array.from(cooldownMap.entries()),
    symbolCooldownMap: Array.from(symbolCooldownMap.entries()),
    notifyState: Array.from(notifyState.entries()),

    stats: compactRuntimeStatsForSave()
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

  runtimeState.strategyVersion = STRATEGY_VERSION;
  stats.strategyVersion = STRATEGY_VERSION;

  trimStats();

  runtimeState.durableLoadedAt = Date.now();

  normalizeOpenPositionMemoryKeys();

  const pruned = pruneNonDiscordManagedPositions();

  vercelLog("info", "RUNTIME_LOADED", {
    migratedFromVersion: payload.strategyVersion || null,
    openPositions: memory.size,
    prunedNonDiscordPositions: pruned,
    closedTrades: stats.closedTrades.length,
    featureRows: stats.featureRows.length,
    shadowRows: stats.shadowRows.length
  });

  return true;
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

function getRuntimePayloadWeight(payload) {
  if (!payload) return 0;

  const memoryWeight = Array.isArray(payload.memory) ? payload.memory.length * 100 : 0;
  const closedWeight = Array.isArray(payload.stats?.closedTrades) ? payload.stats.closedTrades.length : 0;
  const shadowWeight = Array.isArray(payload.stats?.shadowRows) ? payload.stats.shadowRows.length : 0;
  const featureWeight = Array.isArray(payload.stats?.featureRows) ? payload.stats.featureRows.length * 0.1 : 0;

  return memoryWeight + closedWeight + shadowWeight + featureWeight;
}

function splitStringByBytes(value, maxBytes) {
  const text = String(value || "");
  const chunks = [];

  let current = "";
  let currentBytes = 0;

  for (const char of text) {
    const charBytes = byteLength(char);

    if (current.length > 0 && currentBytes + charBytes > maxBytes) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }

    current += char;
    currentBytes += charBytes;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

async function loadChunkedRuntimePayload() {
  const metaRaw = await redisCommand(["GET", RUNTIME_META_KEY]).catch(() => null);
  const meta = parseRuntimePayload(metaRaw);

  if (!meta || !Number.isFinite(Number(meta.chunkCount))) {
    return null;
  }

  const chunkCount = Number(meta.chunkCount);
  const chunks = [];

  for (let i = 0; i < chunkCount; i += 1) {
    const chunk = await redisCommand([
      "GET",
      `${RUNTIME_CHUNK_PREFIX}${i}`
    ]);

    if (typeof chunk !== "string") {
      throw new Error(`runtime_chunk_missing:${i}`);
    }

    chunks.push(chunk);
  }

  return parseRuntimePayload(chunks.join(""));
}

async function deleteOldRuntimeChunks(previousChunkCount, nextChunkCount = 0) {
  const previous = Math.max(Number(previousChunkCount || 0), 0);
  const next = Math.max(Number(nextChunkCount || 0), 0);

  if (previous <= next) return;

  const keys = [];

  for (let i = next; i < previous; i += 1) {
    keys.push(`${RUNTIME_CHUNK_PREFIX}${i}`);
  }

  for (let i = 0; i < keys.length; i += RUNTIME_CHUNK_DELETE_BATCH_SIZE) {
    const batch = keys.slice(i, i + RUNTIME_CHUNK_DELETE_BATCH_SIZE);
    if (!batch.length) continue;

    await redisCommand(["DEL", ...batch]).catch(() => null);
  }
}

async function saveChunkedRuntimePayload(payload) {
  const previousMetaRaw = await redisCommand(["GET", RUNTIME_META_KEY]).catch(() => null);
  const previousMeta = parseRuntimePayload(previousMetaRaw) || {};
  const previousChunkCount = Number(previousMeta.chunkCount || 0);

  const json = JSON.stringify(payload);
  const jsonBytes = byteLength(json);

  if (jsonBytes > RUNTIME_MAX_JSON_BYTES) {
    throw new Error(`runtime_payload_too_large_after_compact:${jsonBytes}>${RUNTIME_MAX_JSON_BYTES}`);
  }

  const chunks = splitStringByBytes(json, RUNTIME_CHUNK_BYTES);

  for (let i = 0; i < chunks.length; i += 1) {
    await redisCommand([
      "SET",
      `${RUNTIME_CHUNK_PREFIX}${i}`,
      chunks[i]
    ]);
  }

  const meta = {
    ok: true,
    mode: "chunked_json",
    strategyVersion: STRATEGY_VERSION,
    storeKey: RUNTIME_STORE_KEY,
    metaKey: RUNTIME_META_KEY,
    chunkPrefix: RUNTIME_CHUNK_PREFIX,
    chunkCount: chunks.length,
    chunkBytes: RUNTIME_CHUNK_BYTES,
    jsonBytes,
    savedAt: Date.now(),

    durableRows: {
      closedTrades: payload.stats?.closedTrades?.length || 0,
      featureRows: payload.stats?.featureRows?.length || 0,
      shadowRows: payload.stats?.shadowRows?.length || 0,
      memory: payload.memory?.length || 0
    }
  };

  await redisCommand([
    "SET",
    RUNTIME_META_KEY,
    JSON.stringify(meta)
  ]);

  await deleteOldRuntimeChunks(previousChunkCount, chunks.length);

  return meta;
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
    const chunkedPayload = await loadChunkedRuntimePayload();

    if (
      chunkedPayload &&
      !forceLegacy &&
      chunkedPayload.strategyVersion === STRATEGY_VERSION &&
      getRuntimePayloadWeight(chunkedPayload) > 0
    ) {
      return hydrateRuntimeState(chunkedPayload);
    }

    const legacyKeys = [
      RUNTIME_STORE_KEY,
      "runnerTradeSystem:runtime:RUNNER_TS_V1_8_MICRO_FAMILY_DISCORD_ONLY",
      "runnerTradeSystem:runtime:RUNNER_TS_V1_2_HOT_ONLY_SHADOW_FIX"
    ];

    let bestLegacyPayload = null;
    let bestLegacyKey = null;
    let bestLegacyWeight = 0;

    for (const legacyKey of legacyKeys) {
      const legacyResult = await redisCommand(["GET", legacyKey]).catch(() => null);
      const legacyPayload = parseRuntimePayload(legacyResult);
      const legacyWeight = getRuntimePayloadWeight(legacyPayload);

      if (!legacyPayload || legacyWeight <= bestLegacyWeight) continue;

      bestLegacyPayload = legacyPayload;
      bestLegacyKey = legacyKey;
      bestLegacyWeight = legacyWeight;
    }

    const chunkedWeight = getRuntimePayloadWeight(chunkedPayload);

    const shouldUseLegacy =
      bestLegacyPayload &&
      (
        forceLegacy ||
        !chunkedPayload ||
        chunkedWeight === 0 ||
        bestLegacyWeight > chunkedWeight
      );

    if (shouldUseLegacy) {
      const migrated = hydrateRuntimeState(bestLegacyPayload, {
        allowVersionMismatch: true
      });

      if (migrated) {
        vercelLog("warn", "RUNTIME_MIGRATED_TO_CHUNKED_STORE", {
          fromKey: bestLegacyKey,
          toMetaKey: RUNTIME_META_KEY,
          fromVersion: bestLegacyPayload?.strategyVersion || null,
          toVersion: STRATEGY_VERSION,
          legacyWeight: bestLegacyWeight,
          chunkedWeight,
          openPositions: memory.size,
          closedTrades: stats.closedTrades.length,
          shadowRows: stats.shadowRows.length
        });

        await saveDurableRuntimeState();
        return true;
      }
    }

    if (chunkedPayload && chunkedPayload.strategyVersion === STRATEGY_VERSION) {
      return hydrateRuntimeState(chunkedPayload);
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
    normalizeOpenPositionMemoryKeys();
    pruneNonDiscordManagedPositions();

    const payload = serializeRuntimeState();
    const meta = await saveChunkedRuntimePayload(payload);

    runtimeState.durableSavedAt = Date.now();

    vercelDebug("RUNTIME_SAVED_CHUNKED", {
      openPositions: memory.size,
      closedTrades: payload.stats.closedTrades.length,
      featureRows: payload.stats.featureRows.length,
      shadowRows: payload.stats.shadowRows.length,
      chunkCount: meta.chunkCount,
      jsonBytes: meta.jsonBytes
    });

    return true;
  } catch (err) {
    vercelError("RUNTIME_SAVE_FAILED", err, {
      openPositions: memory.size,
      closedTrades: Array.isArray(stats.closedTrades) ? stats.closedTrades.length : 0,
      featureRows: Array.isArray(stats.featureRows) ? stats.featureRows.length : 0,
      shadowRows: Array.isArray(stats.shadowRows) ? stats.shadowRows.length : 0
    });

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

// ================= CANDLES / DATA FETCH =================

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
      SYMBOL_ALREADY_OPEN: 0
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

    if (!symbol || !side) continue;

    const stage = String(raw?.stage || "radar").toLowerCase();

    const normalized = {
      ...raw,
      symbol,
      side,
      stage,
      scannerFlow: getScannerFlow(raw),
      moveScore: safeNumber(raw?.moveScore ?? raw?.score, 0),
      liveEligible: isScannerHotRunnerCandidate(raw),
      shadowOnly: false
    };

    const key = buildMemoryKey(symbol, side);
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
    .sort((a, b) => {
      const stageDiff = stageRank(b.stage) - stageRank(a.stage);
      if (stageDiff !== 0) return stageDiff;

      return safeNumber(b.moveScore, 0) - safeNumber(a.moveScore, 0);
    });
}

function buildTradeCandidates(input) {
  const raw = Array.isArray(input) ? input : [];
  const prefilter = createPrefilterStats(raw.length);
  const accepted = [];

  for (const row of raw) {
    const symbol = normalizeBaseSymbol(row?.symbol);
    const side = normalizeSide(row?.side);

    if (!symbol) {
      pushPrefilterReject(prefilter, "MISSING");
      continue;
    }

    if (!side) {
      pushPrefilterReject(prefilter, "BAD_SIDE");
      continue;
    }

    if (Boolean(row?.uiOnly)) {
      pushPrefilterReject(prefilter, "UI_ONLY");
      continue;
    }

    accepted.push({
      ...row,
      symbol,
      side,
      stage: String(row?.stage || "unknown").toLowerCase(),
      scannerFlow: getScannerFlow(row),
      liveEligible: true,
      shadowOnly: false,
      moveScore: safeNumber(row?.moveScore ?? row?.score, 0)
    });
  }

  const map = new Map();

  for (const c of dedupeCandidates(accepted)) {
    if (hasAnyOpenPositionForSymbol(c.symbol)) {
      pushPrefilterReject(prefilter, "SYMBOL_ALREADY_OPEN");
      continue;
    }

    const key = buildMemoryKey(c.symbol, c.side);
    if (!key) continue;

    map.set(key, {
      ...c,
      analysisType: "DEEP",
      fromOpenPosition: false,
      liveEligible: true,
      shadowOnly: false
    });
  }

  for (const pos of memory.values()) {
    const normalized = normalizeOpenPositionForMemory(pos);
    if (!normalized) continue;

    const key = buildMemoryKey(normalized.symbol, normalized.side);
    if (!key || map.has(key)) continue;

    prefilter.openPositionsInjected++;

    map.set(key, {
      ...normalized,

      stage: "entry",
      scannerStage: "open_position",
      stageSource: "memory",

      uiOnly: false,
      moveScore: safeNumber(normalized.score, 100),
      price: safeNumber(normalized.lastPrice || normalized.entry, 0),

      rawBitgetSymbol: normalized.rawBitgetSymbol || normalized.symbol,

      analysisType: "POSITION",
      fromOpenPosition: true,

      scannerFlow: normalized.flow || normalized.scannerFlow || "OPEN_POSITION",

      liveEligible: true,
      shadowOnly: false
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
  prefilter.liveEligible = candidates.length;
  prefilter.shadowOnly = 0;

  return {
    candidates,
    prefilter
  };
}
// ================= RUNNER FLOW / RISK =================

function classifyRunnerFlow(c, analyzedFlow) {
  const existing = normalizeFlow(c?.flow || c?.scannerFlow);

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

function buildRunnerTargetsFromRisk(c, risk, targetR) {
  return buildRunnerTargets({
    entry: c.price,
    sl: risk.sl,
    side: c.side,
    targetR
  });
}

function inferRunnerCandidateSetup({ c, flow }) {
  const f = normalizeFlow(flow?.type || c?.flow);

  if (f === "SQUEEZE") {
    return {
      setupClass: "RUNNER_C",
      entryType: "RUNNER_C_SQUEEZE",
      targetR: RUNNER_C_TARGET_R
    };
  }

  if (HOT_RUNNER_FLOWS.has(f)) {
    return {
      setupClass: "RUNNER_A",
      entryType: "RUNNER_A_BREAKOUT",
      targetR: RUNNER_A_TARGET_R
    };
  }

  return {
    setupClass: "RUNNER_B",
    entryType: "RUNNER_B_CONTINUATION",
    targetR: RUNNER_B_TARGET_R
  };
}

function classifyRunnerSetup({
  c,
  flow,
  sniper,
  confluence,
  rr
}) {
  const inferred = inferRunnerCandidateSetup({
    c,
    flow
  });

  return {
    ok: true,
    ...inferred,
    score: safeNumber(c?.moveScore ?? c?.score, 0),
    sniperScore: safeNumber(sniper?.score ?? sniper?.runnerScore, 0),
    confluence: safeNumber(confluence, 0),
    rr: safeNumber(rr, 0),
    minConfluence: 0,
    minSniper: 0,
    minRR: 0.01
  };
}

// ================= PAYLOADS / FEATURE ROWS =================

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
    moveScore: safeNumber(c?.moveScore ?? c?.score, 0),

    flow: flow?.type || c?.flow || "NEUTRAL",
    flowStrength: flow?.strength || "UNKNOWN",

    runnerPressure: safeNumber(c?.runnerPressure ?? getDirectionalPressure(c), 0),
    runnerAcceleration: safeNumber(c?.runnerAcceleration ?? getRunnerAcceleration(c), 0),

    confluence: safeNumber(ctx.confluence, 0),

    sniper: sniper?.type || "NONE",
    sniperScore: safeNumber(sniper?.score ?? sniper?.runnerScore, 0),
    entryType: sniper?.entryType || sniper?.runnerEntryType || null,

    funding: safeNumber(funding?.rate, 0),
    fundingRate: safeNumber(funding?.rate, 0),

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

  return {
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
}

function recordScanObservation(payload) {
  if (!payload?.symbol || !payload?.side) return;

  recordFeatureRow(payload);
  createShadowFromPayload(payload, "SCAN_SHADOW");
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

    hasRiskGeometry:
      entry > 0 &&
      sl > 0 &&
      tp > 0 &&
      Math.abs(entry - sl) > 0,

    rsiValid: ctx.rsiValid ?? null,
    rsiBlocked: ctx.rsiBlocked ?? null,
    rsiContinuationAllowed: ctx.rsiContinuationAllowed ?? null,
    rsiPullbackAllowed: ctx.rsiPullbackAllowed ?? null,
    rsiExhaustedAgainstSide: ctx.rsiExhaustedAgainstSide ?? null,

    structureAligned: ctx.structureAligned ?? null,

    obFetchFailed: Boolean(ctx.ob?.fetchFailed),
    spoof: Boolean(ctx.ob?.spoof),
    obAgainst: isObAgainstSide(ctx.ob, c?.side),

    scannerHot: isScannerHotRunnerCandidate(c),

    ts: Date.now()
  };

  try {
    recordFeatureRow(payload);
    createShadowFromPayload(payload, "SHADOW");
  } catch (err) {
    vercelError("WAIT_FEATURE_OR_SHADOW_FAILED", err, {
      symbol: payload.symbol,
      side: payload.side,
      reason: payload.reason
    });
  }

  runnerWaitTrace(c, reason, ctx, {
    action: "WAIT",
    entry: payload.entry,
    sl: payload.sl,
    tp: payload.tp,
    rr: payload.rr,
    setupClass: payload.setupClass,
    entryType: payload.entryType
  });

  return payload;
}

function buildAnalyzeOnly(c, reason, ctx = {}, extra = {}) {
  const risk = extra.risk || {};
  const targets = extra.targets || {};
  const setup = extra.setup || {};
  const discordDecision = extra.discordDecision || null;

  const entry = safeNumber(c?.price ?? risk.entry, 0);
  const sl = safeNumber(risk.sl, 0);
  const tp = safeNumber(targets.tp ?? risk.tp, 0);
  const finalRR = safeNumber(extra.finalRR ?? ctx.rr, 0);

  const payload = {
    ...buildCommonPayload(c, {
      ...ctx,
      rr: finalRR,
      risk: {
        ...risk,
        tp
      }
    }),

    source: "ANALYZE_ONLY",
    action: "ANALYZE_ONLY",
    reason: String(reason || "DISCORD_FILTER_NOT_ALLOWED").toUpperCase(),

    setupClass: setup.setupClass || "NONE",
    entryType: setup.entryType || null,
    runnerEntryType: setup.entryType || null,

    grade: setup.setupClass === "RUNNER_B" ? "B" : "A",

    entry: entry || null,
    sl: sl || null,
    initialSl: sl || null,
    tp: tp || null,

    partialTp: safeNumber(targets.partialTp, 0) || null,
    breakevenAt: safeNumber(targets.breakevenAt, 0) || null,
    trailStart: safeNumber(targets.trailStart, 0) || null,

    rr: finalRR ? formatRR(finalRR) : "0.00",
    plannedRR: finalRR,
    targetR: safeNumber(setup.targetR, 0),

    familyId: discordDecision?.familyId || null,
    runnerFamilyId: discordDecision?.familyId || null,
    analyzeFamilyId: discordDecision?.familyId || null,
    analysisFamilyId: discordDecision?.familyId || null,
    discordFamilyId: discordDecision?.familyId || null,

    discordAllowed: Boolean(discordDecision?.allowed),
    discordNotified: false,
    discordBlockReason: discordDecision?.reason || reason,
    discordDecision,

    liveEntryBlocked: true,
    liveEntryBlockReason: String(reason || "DISCORD_FILTER_NOT_ALLOWED").toUpperCase(),

    ts: Date.now()
  };

  if (discordDecision?.family) {
    applyFamilyMeta(payload, discordDecision.family);
  }

  recordFeatureRow(payload);
  createShadowFromPayload(payload, "ANALYZE_ONLY_SHADOW");

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
  const common = buildCommonPayload(c, ctx);

  return {
    ...common,

    tradeId: pos.tradeId,
    positionTradeId: pos.positionTradeId || pos.tradeId,

    familyId: pos.familyId || null,
    runnerFamilyId: pos.runnerFamilyId || pos.familyId || null,
    analyzeFamilyId: pos.analyzeFamilyId || pos.familyId || null,
    analysisFamilyId: pos.analysisFamilyId || pos.familyId || null,
    discordFamilyId: pos.discordFamilyId || pos.familyId || null,

    action,
    reason,

    setupClass: pos.setupClass,
    entryType: pos.entryType,
    runnerEntryType: pos.runnerEntryType || pos.entryType,

    symbol: pos.symbol,
    side: pos.side,

    score: safeNumber(pos.score ?? common.score, 0),
    moveScore: safeNumber(pos.score ?? common.moveScore ?? common.score, 0),

    confluence: safeNumber(pos.confluence ?? common.confluence, 0),
    sniperScore: safeNumber(pos.sniperScore ?? common.sniperScore, 0),

    flow: pos.flow || common.flow,
    scannerFlow: pos.scannerFlow || common.scannerFlow,

    rsi: pos.rsi ?? common.rsi,
    rsiZone: pos.rsiZone || common.rsiZone,

    obBias: pos.obBias || common.obBias,
    spreadPct: pos.spreadPct ?? common.spreadPct,
    depthMinUsd1p: pos.depthMinUsd1p ?? common.depthMinUsd1p,

    funding: pos.funding ?? common.funding,
    fundingRate: pos.funding ?? common.funding,

    btcState: pos.btcState || common.btcState,
    regime: pos.regime || common.regime,

    tfScore: safeNumber(pos.tfScore ?? common.tfScore, 0),
    tfStrength: safeNumber(pos.tfStrength ?? common.tfStrength, 0),
    tfAlignment: pos.tfAlignment || common.tfAlignment,

    entry: pos.entry,
    sl: pos.sl,
    initialSl: pos.initialSl,
    tp: pos.tp,
    partialTp: pos.partialTp,
    breakevenAt: pos.breakevenAt,
    trailStart: pos.trailStart,
    trailPrice: pos.trailPrice ?? null,

    rr: formatRR(pos.rr),
    plannedRR: safeNumber(pos.rr, 0),
    targetR: pos.targetR,

    currentR: safeNumber(pos.currentR, 0),
    mfeR: safeNumber(pos.mfeR, 0),
    maeR: safeNumber(pos.maeR, 0),

    partialTaken: Boolean(pos.partialTaken),
    breakEvenMoved: Boolean(pos.breakEvenMoved),
    trailingActive: Boolean(pos.trailingActive),

    adds: safeNumber(pos.adds, 0),

    discordAllowed: Boolean(pos.discordEntryAllowed),
    discordNotified: Boolean(pos.discordEntryNotified),
    discordEntryAllowed: Boolean(pos.discordEntryAllowed),
    discordEntryNotified: Boolean(pos.discordEntryNotified),
    discordEntryBlocked: Boolean(pos.discordEntryBlocked),
    discordBlockReason: pos.discordBlockReason || null,

    ...extra
  };
}

function buildPositionFromEntry({
  c,
  ctx,
  risk,
  targets,
  rr,
  targetR,
  entryType,
  setupClass,
  discordDecision = null
}) {
  const now = Date.now();
  const symbol = normalizeBaseSymbol(c.symbol);
  const side = normalizeSide(c.side);
  const entry = safeNumber(c.price, 0);

  const tradeId =
    c.tradeId ||
    c.positionTradeId ||
    `RUNNER_${symbol}_${side}_${now}_${Number(entry).toPrecision(12)}`;

  const position = {
    profile: "RUNNER",
    strategyVersion: STRATEGY_VERSION,

    tradeId,
    positionTradeId: tradeId,

    symbol,
    side,
    rawBitgetSymbol: ctx.contractSymbol || normalizeBitgetSymbol(c.rawBitgetSymbol || c.symbol),

    setupClass,
    entryType,
    runnerEntryType: entryType,

    familyId: discordDecision?.familyId || null,
    runnerFamilyId: discordDecision?.familyId || null,
    analyzeFamilyId: discordDecision?.familyId || null,
    analysisFamilyId: discordDecision?.familyId || null,
    discordFamilyId: discordDecision?.familyId || null,

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

    entry,
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

    highestPrice: entry,
    lowestPrice: entry,

    currentR: 0,
    mfeR: 0,
    maeR: 0,

    ticksObserved: 0,

    discordEntryAllowed: true,
    discordEntryNotified: true,
    discordEntryBlocked: false,
    discordBlockReason: null,
    discordDecision,

    createdAt: now,
    updatedAt: now
  };

  if (discordDecision?.family) {
    applyFamilyMeta(position, discordDecision.family);
  }

  return position;
}

// ================= POSITION MANAGEMENT =================

async function handleOpenPosition(c, pos, ctx, options = {}) {
  const shouldLog = options.log !== false;
  const notify = options.notify !== false;

  const side = normalizeSide(pos.side);
  const price = safeNumber(c.price, 0);
  const key = buildMemoryKey(pos.symbol, pos.side);

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
        realizedR: Number(exitR.toFixed(3)),
        resultR: Number(exitR.toFixed(3)),
        pnlR: Number(exitR.toFixed(3)),
        pnlPct: Number(pnlPct.toFixed(3)),
        holdMinutes: Number(((Date.now() - safeNumber(pos.createdAt, Date.now())) / 60000).toFixed(1)),
        exitedAt: Date.now()
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

    if (notify && !pos.discordEntryNotified) {
      runnerTrace("DISCORD_EXIT_SKIPPED", buildTraceSnapshot(c, ctx, {
        reason: "ENTRY_WAS_NOT_DISCORD_NOTIFIED",
        symbol: pos.symbol,
        side: pos.side,
        exitReason,
        exitR: Number(exitR.toFixed(3)),
        pnlPct: Number(pnlPct.toFixed(3))
      }));
    }

    if (notify && pos.discordEntryNotified && !notifyState.get(exitNotifyKey)) {
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

  for (const row of active) {
    const symbol = normalizeBitgetSymbol(row?.rawBitgetSymbol || row?.symbol);
    const price = safeNumber(priceMap.get(symbol), 0);

    if (!price) continue;

    updateShadowWithPrice(row, price);
  }

  trimStats();
}

// ================= ANALYZE / REPORTS =================

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
  const exitR = Number(row?.exitR ?? row?.realizedR ?? row?.resultR ?? row?.pnlR);
  const pnlPct = Number(row?.pnlPct);

  const normalized = {
    source: String(row?.source || "REAL").toUpperCase(),

    symbol: normalizeBaseSymbol(row?.symbol),
    side: normalizeSide(row?.side),

    action: String(row?.action || "UNKNOWN").toUpperCase(),
    status: String(row?.status || "CLOSED").toUpperCase(),

    reason: String(row?.reason || row?.entryReason || "UNKNOWN").toUpperCase(),
    exitReason: String(row?.exitReason || row?.status || row?.reason || "UNKNOWN").toUpperCase(),

    setupClass: String(row?.setupClass || "UNKNOWN").toUpperCase(),
    entryType: String(row?.entryType || row?.runnerEntryType || row?.reason || "UNKNOWN").toUpperCase(),

    scannerFlow: String(row?.scannerFlow || "UNKNOWN").toUpperCase(),
    liveEligible: Boolean(row?.liveEligible),
    shadowOnly: Boolean(row?.shadowOnly),

    familyId: normalizeFamilyId(row?.familyId || row?.runnerFamilyId || row?.analyzeFamilyId || row?.discordFamilyId),

    score: safeNumber(row?.score ?? row?.moveScore, 0),
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

  const totalR = optSum(rValues);
  const avgR = optAvg(rValues);
  const totalPnlPct = optSum(pnlValues);
  const avgPnlPct = optAvg(pnlValues);

  const winrateNum = completed ? wins / completed : 0;

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

    profitFactorR: optRound(optProfitFactor(completedRows), 3)
  };
}

function buildLearningCohortDimensions(row) {
  return {
    entryType: String(row?.entryType || "UNKNOWN").toUpperCase(),
    setupClass: String(row?.setupClass || "UNKNOWN").toUpperCase(),
    side: normalizeSide(row?.side),
    rsiZone: String(row?.rsiZone || "UNKNOWN").toUpperCase(),
    flow: normalizeFlow(row?.flow),
    obBias: String(row?.obBias || "UNKNOWN").toUpperCase(),
    familyId: normalizeFamilyId(row?.familyId || "UNKNOWN")
  };
}

function buildLearningCohortKey(dim) {
  return [
    `FAMILY=${dim.familyId}`,
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
    familyId: dim.familyId,
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

    familyId: normalized.familyId,
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

function buildCohortLearningReport() {
  const rows = (stats.closedTrades || [])
    .map(optNormalizeOutcomeRow)
    .filter(row => Number.isFinite(Number(row.exitR)))
    .filter(row => row.entry > 0)
    .filter(row => row.sl > 0)
    .filter(row => row.tp > 0)
    .slice(-600);

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
    .map(group => ({
      cohortKey: group.cohortKey,
      rule: group.rule,
      ...optGetStats(group.rows),
      examples: group.rows.slice(-8).map(row => ({
        symbol: row.symbol,
        side: row.side,
        familyId: row.familyId,
        exitR: row.exitR,
        pnlPct: row.pnlPct,
        mfeR: row.mfeR,
        maeR: row.maeR,
        confluence: row.confluence,
        sniperScore: row.sniperScore,
        rr: row.plannedRR,
        spreadPct: row.spreadPct,
        depthMinUsd1p: row.depthMinUsd1p
      }))
    }))
    .filter(row => row.sample >= 3)
    .sort((a, b) => safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0));

  return {
    tag: "RUNNER_COHORT_LEARNING_REPORT",
    strategyVersion: STRATEGY_VERSION,
    ts: Date.now(),

    sample: {
      closedRows: rows.length,
      cohorts: cohorts.length,
      confidence:
        rows.length >= 150
          ? "HIGH"
          : rows.length >= 60
            ? "MEDIUM"
            : "LOW"
    },

    bestCohorts: cohorts.slice(0, 20),
    worstCohorts: cohorts
      .slice()
      .sort((a, b) => safeNumber(a.totalR, 0) - safeNumber(b.totalR, 0))
      .slice(0, 20)
  };
}

function buildOptimizerReport() {
  const closed = Array.isArray(stats.closedTrades) ? stats.closedTrades : [];
  const shadows = Array.isArray(stats.shadowRows) ? stats.shadowRows : [];
  const completedShadows = shadows.filter(r => r.status !== "OPEN");

  const wins = safeNumber(stats.wins, 0);
  const losses = safeNumber(stats.losses, 0);
  const completed = wins + losses;

  const totalR = closed.reduce((sum, row) => sum + safeNumber(row.exitR ?? row.realizedR, 0), 0);
  const totalPnlPct = closed.reduce((sum, row) => sum + safeNumber(row.pnlPct, 0), 0);

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
      winrate: completed ? `${((wins / completed) * 100).toFixed(1)}%` : "0.0%",
      totalR: Number(totalR.toFixed(3)),
      avgR: closed.length ? Number((totalR / closed.length).toFixed(3)) : 0,
      totalPnlPct: Number(totalPnlPct.toFixed(3)),
      avgPnlPct: closed.length ? Number((totalPnlPct / closed.length).toFixed(3)) : 0
    },

    actionCounts: stats.actionCounts || {},
    waitReasons: stats.waitReasons || {},
    entryTypes: stats.entryTypes || {}
  };
}

function buildFinalRunnerFilterDecision() {
  const allowedFamilies = Array.from(getAllowedDiscordFamilyIds());

  return {
    tag: "RUNNER_MASTER_BEST_AFSTELLING",
    profile: "RUNNER",
    strategyVersion: STRATEGY_VERSION,
    ts: Date.now(),

    decision: "LIVE_DISCORD_ONLY_FAMILY_GATE_ACTIVE",

    rules: {
      allCoinsGoToAnalyze: true,
      liveEntryRequiresDiscordFamilyMatch: RUNNER_LIVE_REQUIRES_DISCORD_FILTER,
      liveEntryRequiresFamilySideMatch: true,
      bullRequiresFamilyPrefix: "LONG_",
      bearRequiresFamilyPrefix: "SHORT_",
      blockedFamilyCreatesLivePosition: false,
      blockedFamilySendsDiscord: false,
      openPositionsAreDiscordManagedOnly: true,
      duplicateEntryDedupTtlMs: DISCORD_ENTRY_DEDUP_TTL_MS,
      maxDiscordEntriesPerRun: RUNNER_MAX_DISCORD_ENTRIES_PER_RUN,
      maxDiscordOpenPositions: RUNNER_MAX_DISCORD_OPEN_POSITIONS
    },

    allowedFamilies,

    runtime: {
      openPositions: memory.size,
      discordManagedOpenPositions: countDiscordManagedOpenPositions()
    }
  };
}

function buildStatsSnapshot() {
  const closed = Array.isArray(stats.closedTrades) ? stats.closedTrades : [];
  const wins = safeNumber(stats.wins, 0);
  const losses = safeNumber(stats.losses, 0);
  const completed = wins + losses;

  const totalR = closed.reduce((sum, row) => {
    return sum + safeNumber(row.exitR ?? row.realizedR ?? row.resultR ?? row.pnlR, 0);
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
    discordManagedOpenPositions: countDiscordManagedOpenPositions(),

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
  const actionCountsThisRun = {};

  for (const action of finalActions) {
    incrementCounter(actionCountsThisRun, action.action);

    if (String(action.action || "").toUpperCase() !== "WAIT") continue;
    incrementCounter(waitReasonsThisRun, action.reason);
  }

  vercelLog("info", "RUN_DONE", {
    runId,
    durationMs: Date.now() - startedAt,
    candidates: candidates.length,
    actions: finalActions.length,
    actionCounts: actionCountsThisRun,
    openPositions: memory.size,
    discordManagedOpenPositions: countDiscordManagedOpenPositions(),
    topWaitReasons: Object.entries(waitReasonsThisRun)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([reason, count]) => ({ reason, count }))
  });

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
      tradeId: pos.tradeId,
      positionTradeId: pos.positionTradeId || pos.tradeId,

      symbol: pos.symbol,
      side: pos.side,

      setupClass: pos.setupClass,
      entryType: pos.entryType,
      runnerEntryType: pos.runnerEntryType,

      scannerFlow: pos.scannerFlow,
      liveEligible: Boolean(pos.liveEligible),
      shadowOnly: Boolean(pos.shadowOnly),

      familyId: pos.familyId || null,
      runnerFamilyId: pos.runnerFamilyId || pos.familyId || null,
      analyzeFamilyId: pos.analyzeFamilyId || pos.familyId || null,
      analysisFamilyId: pos.analysisFamilyId || pos.familyId || null,
      discordFamilyId: pos.discordFamilyId || null,

      discordEntryAllowed: Boolean(pos.discordEntryAllowed),
      discordEntryNotified: Boolean(pos.discordEntryNotified),
      discordEntryBlocked: Boolean(pos.discordEntryBlocked),
      discordBlockReason: pos.discordBlockReason || null,

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
  let discordEntriesSentThisRun = 0;

  try {
    vercelLog("info", "RUN_START", {
      runId,
      inputType: Array.isArray(input) ? "array" : "payload",
      notify,
      shouldLog,
      durableRequired,
      liveRequiresDiscordFilter: RUNNER_LIVE_REQUIRES_DISCORD_FILTER,
      liveRequiresFamilySideMatch: true,
      openPositionsBeforeLoad: memory.size
    });

    if (durableRequired) {
      lockAcquired = await acquireRuntimeLock(lockOwner);

      if (!lockAcquired) {
        throw new Error("RUNNER_TRADE_SYSTEM_LOCK_BUSY");
      }
    }

    await loadDurableRuntimeState();

    normalizeOpenPositionMemoryKeys();

    const prunedNonDiscordPositions = pruneNonDiscordManagedPositions();
    const seededOpenPositions = seedOpenPositionsFromOptions(options);

    if (prunedNonDiscordPositions > 0 || seededOpenPositions > 0) {
      vercelLog("warn", "OPEN_POSITION_MEMORY_RECONCILED", {
        runId,
        prunedNonDiscordPositions,
        seededOpenPositions,
        memorySize: memory.size
      });
    }

    await updateShadowOutcomes();

    normalizeOpenPositionMemoryKeys();
    pruneNonDiscordManagedPositions();
    cleanExpiredGuards();

    let rawCandidates = [];
    let scanBtc = options.btc || null;
    let scanRegime = options.regime || null;

    if (Array.isArray(input)) {
      rawCandidates = input;
    } else {
      const collectSide = side => {
        const f = input?.funnel?.[side] || {};

        return [
          ...(f.entry || []),
          ...(f.almost || []),
          ...(f.buildup || []),
          ...(f.build || []),
          ...(f.radar || []),
          ...(f.watch || []),
          ...(f.scanner || []),
          ...(f.hot || []),
          ...(f.candidates || []),
          ...(f.all || [])
        ];
      };

      rawCandidates = [
        ...collectSide("bull"),
        ...collectSide("bear")
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

      if (!c.symbol || !c.side) continue;

      const key = buildMemoryKey(c.symbol, c.side);
      const lockKey = `LOCK_${c.symbol}`;

      const data = dataMap.get(c.symbol) || {
        contractSymbol: normalizeBitgetSymbol(c.symbol),
        ob: { ...DEFAULT_OB },
        funding: { rate: 0 },
        mtfRsi: null,
        structure: { trend: "UNKNOWN" },
        liquidation: null,
        candles15m: [],
        candles1h: [],
        candles4h: []
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

      const rawRsiSignal = data.mtfRsi
        ? getRSISignal(data.mtfRsi, c.side)
        : { valid: false };

      const rsiSignal = {
        ...rawRsiSignal,
        valid: true,
        blocked: false,
        rsi: Number.isFinite(Number(rawRsiSignal?.rsi))
          ? Number(rawRsiSignal.rsi)
          : 50
      };

      const rsiZone = getRsiZone(rsiSignal);
      const rsi = Number.isFinite(Number(rsiSignal?.rsi))
        ? Number(rsiSignal.rsi)
        : 50;

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
        runId,
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

      runnerTrace("RUNNER_CANDIDATE_ANALYZED", buildTraceSnapshot(c, ctx, {
        hasLiquidationData,
        structureAligned: isStructureAligned(structure, c.side),
        sniperType: sniper?.type || "NONE"
      }));

      const existing = memory.get(key);

      if (existing) {
        const payload = await handleOpenPosition(c, existing, ctx, {
          notify,
          log: shouldLog
        });

        actions.push(payload);
        continue;
      }

      const structureAligned = isStructureAligned(structure, c.side);
      const rsiExhaustedAgainstSideFlag = false;
      const continuationAllowed = true;
      const pullbackAllowed = true;

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
            rr: baseRR || 0.01
          });

          setup = classifyRunnerSetup({
            c,
            flow,
            sniper,
            confluence,
            rr: baseRR,
            strategy
          });

          targets = buildRunnerTargetsFromRisk(
            c,
            riskBase,
            setup.targetR
          );

          finalRR = calculateRRFromPrices(
            c.price,
            riskBase.sl,
            targets.tp,
            c.side
          );
        } catch (err) {
          riskBase = null;
          baseRR = 0;
          finalRR = 0;

          vercelError("RISK_PRECALC_FAILED", err, {
            runId,
            symbol: c.symbol,
            side: c.side,
            price: c.price,
            obFetchFailed: ob.fetchFailed,
            hasLiquidationData
          });
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
        continuationAllowed,
        pullbackAllowed,
        rsiExhaustedAgainstSide: rsiExhaustedAgainstSideFlag,
        structureAligned,
        hasLiquidationData,
        runId
      }));

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

      if (hasAnyOpenPositionForSymbol(c.symbol)) {
        actions.push(buildAnalyzeOnly(
          c,
          `SYMBOL_ALREADY_OPEN_${getOpenPositionSideForSymbol(c.symbol)}`,
          ctx,
          {
            risk: riskBase || {},
            targets: targets || {},
            setup: setup || {},
            finalRR
          }
        ));
        continue;
      }

      if (processingLocks.has(lockKey)) {
        actions.push(buildWait(c, "PROCESSING_LOCK_ACTIVE", ctx));
        continue;
      }

      if (Date.now() < safeNumber(cooldownMap.get(key), 0)) {
        actions.push(buildAnalyzeOnly(
          c,
          "PAIR_COOLDOWN",
          ctx,
          {
            risk: riskBase || {},
            targets: targets || {},
            setup: setup || {},
            finalRR
          }
        ));
        continue;
      }

      if (Date.now() < safeNumber(symbolCooldownMap.get(c.symbol), 0)) {
        actions.push(buildAnalyzeOnly(
          c,
          "SYMBOL_COOLDOWN",
          ctx,
          {
            risk: riskBase || {},
            targets: targets || {},
            setup: setup || {},
            finalRR
          }
        ));
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

      targets = buildRunnerTargetsFromRisk(c, riskBase, setup.targetR);

      finalRR = calculateRRFromPrices(
        c.price,
        riskBase.sl,
        targets.tp,
        c.side
      );

      if (finalRR < 0.01) {
        actions.push(buildWait(c, "FINAL_RR_INVALID", {
          ...ctx,
          rr: finalRR,
          risk: {
            ...riskBase,
            tp: targets.tp
          },
          requiredRR: 0.01
        }));
        continue;
      }

      const discordDecision = getDiscordEntryDecision({
        c,
        ctx,
        ob,
        setup,
        finalRR,
        sniperScore,
        confluence,
        structureAligned,
        continuationAllowed,
        pullbackAllowed
      });

      const liveEntryBlockReason = getLiveEntryBlockReason({
        c,
        notify,
        discordDecision,
        discordEntriesSentThisRun
      });

      if (liveEntryBlockReason) {
        actions.push(buildAnalyzeOnly(
          c,
          liveEntryBlockReason,
          ctx,
          {
            risk: riskBase,
            targets,
            setup,
            finalRR,
            discordDecision
          }
        ));

        vercelLog("info", "LIVE_ENTRY_BLOCKED_ANALYZE_ONLY", buildTraceSnapshot(c, ctx, {
          reason: liveEntryBlockReason,
          finalRR,
          setupClass: setup.setupClass,
          entryType: setup.entryType,
          discordDecision
        }));

        continue;
      }

      processingLocks.add(lockKey);

      const reservedNotifyKeys = {
        pairKey: "",
        exactKey: ""
      };

      try {
        const provisionalPosition = {
          symbol: c.symbol,
          side: c.side,
          entry: c.price
        };

        Object.assign(reservedNotifyKeys, reserveEntryNotifyKeys(provisionalPosition));

        await sendEntry({
          symbol: c.symbol,
          side: c.side,
          grade: setup.setupClass === "RUNNER_B" ? "B" : "A",

          entry: c.price,
          sl: riskBase.sl,
          tp: targets.tp,
          rr: finalRR,

          setupClass: setup.setupClass,
          entryType: setup.entryType,

          confluence,
          sniperScore,
          runnerPressure: c.runnerPressure,
          runnerAcceleration: c.runnerAcceleration,
          rsiZone,
          obBias: ob.bias,

          discordFilterName: discordDecision.familyId || null,
          discordReason: discordDecision.reason
        });

        const position = buildPositionFromEntry({
          c,
          ctx,
          risk: riskBase,
          targets,
          rr: finalRR,
          targetR: setup.targetR,
          entryType: setup.entryType,
          setupClass: setup.setupClass,
          discordDecision
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
          plannedRR: finalRR,
          targetR: setup.targetR,

          partialSize: PARTIAL_SIZE,
          maxAdds: MAX_ADDS,

          tradeId: position.tradeId,
          positionTradeId: position.tradeId,

          familyId: discordDecision.familyId || null,
          runnerFamilyId: discordDecision.familyId || null,
          analyzeFamilyId: discordDecision.familyId || null,
          analysisFamilyId: discordDecision.familyId || null,
          discordFamilyId: discordDecision.familyId || null,

          discordAllowed: true,
          discordNotified: true,
          discordEntryAllowed: true,
          discordEntryNotified: true,
          discordBlockReason: discordDecision.reason,
          discordDecision
        };

        if (discordDecision.family) {
          applyFamilyMeta(entryPayload, discordDecision.family);
        }

        memory.set(key, position);

        cooldownMap.set(key, Date.now() + COOLDOWN_MS);
        symbolCooldownMap.set(c.symbol, Date.now() + SYMBOL_REENTRY_COOLDOWN_MS);

        stats.entries++;
        discordEntriesSentThisRun++;

        incrementCounter(stats.entryTypes, setup.entryType);
        incrementCounter(stats.actionCounts, "ENTRY");

        await logSystem(entryPayload, shouldLog);

        recordFeatureRow(entryPayload);

        vercelLog("info", "DISCORD_ENTRY_SENT", buildTraceSnapshot(c, ctx, {
          finalRR,
          setupClass: setup.setupClass,
          entryType: setup.entryType,
          discordDecision
        }));

        vercelLog("info", "ENTRY", {
          runId,
          symbol: c.symbol,
          side: c.side,
          setupClass: setup.setupClass,
          entryType: setup.entryType,
          discordFamilyId: discordDecision.familyId || null,
          entry: position.entry,
          sl: position.sl,
          tp: position.tp,
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
      } catch (err) {
        releaseEntryNotifyKeys(reservedNotifyKeys);

        vercelError("DISCORD_ENTRY_SEND_FAILED", err, {
          runId,
          symbol: c.symbol,
          side: c.side,
          finalRR,
          setupClass: setup.setupClass,
          entryType: setup.entryType,
          discordDecision
        });

        actions.push(buildAnalyzeOnly(
          c,
          "DISCORD_ENTRY_SEND_FAILED",
          ctx,
          {
            risk: riskBase,
            targets,
            setup,
            finalRR,
            discordDecision
          }
        ));
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
  return buildFinalRunnerFilterDecision();
}

export function forceRunnerOptimizerLog() {
  const report = buildFinalRunnerFilterDecision();

  stats.lastOptimizerReportAt = Date.now();

  console.log("RUNNER_MASTER_BEST_AFSTELLING", JSON.stringify(report));

  return report;
}

export function getRunnerCohortLearningReport() {
  return buildCohortLearningReport();
}