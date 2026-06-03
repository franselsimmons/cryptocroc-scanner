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

import {
  getRunnerFamilyForRow,
  getRunnerMicroFamilyForRow
} from "./analyze/runnerFamilyEngine.js";

// ================= STRATEGY VERSION =================

const STRATEGY_VERSION = "RUNNER_TS_V2_1_EXACT_MICRO_FAMILY_KEY_GATE";

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

const RUNNER_LIVE_REQUIRES_DISCORD_FILTER = true;
const RUNNER_REQUIRES_REDIS_FOR_LIVE = true;

const RUNNER_MAX_DISCORD_ENTRIES_PER_RUN = Number(
  process.env.RUNNER_MAX_DISCORD_ENTRIES_PER_RUN || 2
);

const RUNNER_MAX_DISCORD_ENTRIES_PER_SIDE_PER_RUN = Number(
  process.env.RUNNER_MAX_DISCORD_ENTRIES_PER_SIDE_PER_RUN || 1
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

// ================= EXACT MICRO FAMILY FILTER =================
//
// Live Discord entries worden gefilterd op exacte microFamilyKey.
// Weekly handmatige overname:
// RUNNER_ALLOWED_MICRO_FAMILY_KEYS=<microFamilyKey>,<microFamilyKey>,...
//
// Backward alias:
// RUNNER_DISCORD_MICRO_FAMILY_KEYS

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

function normalizeMacroSide(side) {
  const s = normalizeSide(side);

  if (s === "bull") return "LONG";
  if (s === "bear") return "SHORT";

  return "";
}

function normalizeFlow(flow) {
  return String(flow || "NEUTRAL").toUpperCase();
}

function normalizeFamilyId(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeMicroFamilyKey(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function normalizeLabels(labels) {
  return (Array.isArray(labels) ? labels : [])
    .map(label => String(label || "").trim().toUpperCase())
    .filter(Boolean);
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

function microFamilyKeyMatchesTradeSide(microFamilyKey, side) {
  const key = normalizeMicroFamilyKey(microFamilyKey);
  const prefix = expectedFamilyPrefixForSide(side);

  if (!key || !prefix) return false;

  return key.startsWith(prefix);
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

// ================= EXACT MICRO FAMILY GATE =================

function parseMicroFamilyKeys(value) {
  return String(value || "")
    .split(",")
    .map(normalizeMicroFamilyKey)
    .filter(Boolean);
}

function getAllowedDiscordMicroFamilyKeys() {
  const envValue =
    process.env.RUNNER_ALLOWED_MICRO_FAMILY_KEYS ||
    process.env.RUNNER_DISCORD_MICRO_FAMILY_KEYS ||
    "";

  return new Set(parseMicroFamilyKeys(envValue));
}

function getAllowedDiscordFamilyIds() {
  const allowedMicroKeys = getAllowedDiscordMicroFamilyKeys();
  const out = new Set();

  for (const key of allowedMicroKeys) {
    const familyId = normalizeFamilyId(String(key).split("::")[0]);
    if (familyId) out.add(familyId);
  }

  return out;
}

function getMicroFamilyKeyFromMeta(meta = {}) {
  return normalizeMicroFamilyKey(
    meta.microFamilyKey ||
      meta.runnerMicroFamilyKey ||
      meta.analyzeMicroFamilyKey ||
      meta.analysisMicroFamilyKey ||
      meta.discordMicroFamilyKey ||
      meta?.family?.microFamilyKey ||
      meta?.discordDecision?.microFamilyKey ||
      meta?.discordDecision?.micro?.microFamilyKey ||
      meta?.discordDecision?.family?.microFamilyKey ||
      ""
  );
}

function getMicroFamilyIdFromMeta(meta = {}) {
  return normalizeFamilyId(
    meta.microFamilyId ||
      meta.runnerMicroFamilyId ||
      meta.analyzeMicroFamilyId ||
      meta.analysisMicroFamilyId ||
      meta.discordMicroFamilyId ||
      meta?.family?.microFamilyId ||
      meta?.discordDecision?.microFamilyId ||
      meta?.discordDecision?.micro?.microFamilyId ||
      meta?.discordDecision?.family?.microFamilyId ||
      ""
  );
}

function getFamilyLabelsFromMeta(meta = {}) {
  return normalizeLabels(
    meta.microLabels ||
      meta.labels ||
      meta?.family?.microLabels ||
      meta?.family?.labels ||
      meta?.discordDecision?.microLabels ||
      meta?.discordDecision?.family?.microLabels ||
      meta?.discordDecision?.family?.labels ||
      meta?.discordDecision?.micro?.microLabels ||
      meta?.discordDecision?.micro?.labels ||
      []
  );
}

function compactAllowedMicroFamilies() {
  const allowedKeys = getAllowedDiscordMicroFamilyKeys();

  return Array.from(allowedKeys).map(key => ({
    microFamilyKey: key,
    familyId: normalizeFamilyId(key.split("::")[0]),
    side: key.startsWith("LONG_")
      ? "bull"
      : key.startsWith("SHORT_")
        ? "bear"
        : "unknown"
  }));
}

function compactFamilyMeta(family) {
  if (!family?.familyId) return null;

  const familyId = normalizeFamilyId(family.familyId);
  const microFamilyKey = getMicroFamilyKeyFromMeta(family);
  const microFamilyId = getMicroFamilyIdFromMeta(family);
  const labels = getFamilyLabelsFromMeta(family);

  return {
    familyId,
    macroFamilyId: normalizeFamilyId(family.macroFamilyId || family.familyId),

    runnerFamilyId: familyId,
    analyzeFamilyId: familyId,
    analysisFamilyId: familyId,

    microFamilyId: microFamilyId || null,
    runnerMicroFamilyId: microFamilyId || null,
    analyzeMicroFamilyId: microFamilyId || null,
    analysisMicroFamilyId: microFamilyId || null,

    microFamilyKey: microFamilyKey || null,
    runnerMicroFamilyKey: microFamilyKey || null,
    analyzeMicroFamilyKey: microFamilyKey || null,
    analysisMicroFamilyKey: microFamilyKey || null,

    side: family.side,
    quality: family.quality,
    market: family.market,
    timing: family.timing,

    qualityIndex: family.qualityIndex,
    marketIndex: family.marketIndex,
    timingIndex: family.timingIndex,

    definition: family.definition,
    labels: normalizeLabels(family.labels),

    microDefinition: family.microDefinition || null,
    microLabels: labels,
    microBuckets: family.microBuckets || null
  };
}

function getRunnerMicroMetaForRow(row) {
  const family = getRunnerFamilyForRow(row);
  if (!family?.familyId) return null;

  const micro = getRunnerMicroFamilyForRow(row, family);
  if (!micro?.microFamilyKey) return null;

  return compactFamilyMeta(micro);
}

function applyFamilyMeta(target, family) {
  const familyId = normalizeFamilyId(family?.familyId);
  if (!target || !familyId) return target;

  const microFamilyKey = getMicroFamilyKeyFromMeta(family);
  const microFamilyId = getMicroFamilyIdFromMeta(family);
  const labels = getFamilyLabelsFromMeta(family);

  target.familyId = familyId;
  target.macroFamilyId = normalizeFamilyId(family.macroFamilyId || familyId);

  target.runnerFamilyId = familyId;
  target.analyzeFamilyId = familyId;
  target.analysisFamilyId = familyId;

  target.microFamilyId = microFamilyId || null;
  target.runnerMicroFamilyId = microFamilyId || null;
  target.analyzeMicroFamilyId = microFamilyId || null;
  target.analysisMicroFamilyId = microFamilyId || null;
  target.discordMicroFamilyId = microFamilyId || null;

  target.microFamilyKey = microFamilyKey || null;
  target.runnerMicroFamilyKey = microFamilyKey || null;
  target.analyzeMicroFamilyKey = microFamilyKey || null;
  target.analysisMicroFamilyKey = microFamilyKey || null;
  target.discordMicroFamilyKey = microFamilyKey || null;

  target.quality = family.quality;
  target.market = family.market;
  target.timing = family.timing;

  target.qualityIndex = family.qualityIndex;
  target.marketIndex = family.marketIndex;
  target.timingIndex = family.timingIndex;

  target.definition = family.definition;
  target.labels = normalizeLabels(family.labels);

  target.microDefinition = family.microDefinition || null;
  target.microLabels = labels;
  target.microBuckets = family.microBuckets || null;

  return target;
}

function isExactAllowedMicroFamilyForSide(meta, side, allowedKeys = getAllowedDiscordMicroFamilyKeys()) {
  const microFamilyKey = getMicroFamilyKeyFromMeta(meta);

  if (!microFamilyKey) return false;
  if (!allowedKeys.has(microFamilyKey)) return false;
  if (!microFamilyKeyMatchesTradeSide(microFamilyKey, side)) return false;

  const familyId = normalizeFamilyId(meta?.familyId || microFamilyKey.split("::")[0]);

  if (!familyIdMatchesTradeSide(familyId, side)) return false;

  return true;
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
    volatility: String(ctx?.volatility || c?.volatility || "UNKNOWN").toUpperCase(),

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
  const micro = getRunnerMicroFamilyForRow(row, family);
  const familyMeta = micro ? compactFamilyMeta(micro) : compactFamilyMeta(family);

  const familyId = normalizeFamilyId(familyMeta?.familyId);
  const microFamilyKey = getMicroFamilyKeyFromMeta(familyMeta);
  const microFamilyId = getMicroFamilyIdFromMeta(familyMeta);

  const allowedMicroKeys = getAllowedDiscordMicroFamilyKeys();
  const expectedPrefix = expectedFamilyPrefixForSide(row.side);

  const metrics = {
    side: row.side,
    macroSide: normalizeMacroSide(row.side),
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
    rsiPullbackAllowed: row.rsiPullbackAllowed,

    microFamilyKey,
    microFamilyId,
    microLabels: familyMeta?.microLabels || []
  };

  const baseDecision = {
    familyId: familyId || null,
    macroFamilyId: familyId || null,

    microFamilyId: microFamilyId || null,
    runnerMicroFamilyId: microFamilyId || null,
    analyzeMicroFamilyId: microFamilyId || null,
    analysisMicroFamilyId: microFamilyId || null,

    microFamilyKey: microFamilyKey || null,
    runnerMicroFamilyKey: microFamilyKey || null,
    analyzeMicroFamilyKey: microFamilyKey || null,
    analysisMicroFamilyKey: microFamilyKey || null,

    expectedPrefix: expectedPrefix || null,

    family: familyMeta,
    micro: familyMeta,

    allowedMicroFamilyKeys: Array.from(allowedMicroKeys),
    allowedFamilies: Array.from(getAllowedDiscordFamilyIds()),
    allowedMicroFamilies: compactAllowedMicroFamilies(),

    metrics
  };

  if (!row.side || !expectedPrefix) {
    return {
      ...baseDecision,
      allowed: false,
      reason: "DISCORD_BAD_TRADE_SIDE",
      expectedPrefix: null
    };
  }

  if (!familyId) {
    return {
      ...baseDecision,
      allowed: false,
      reason: "DISCORD_FAMILY_UNRESOLVED",
      familyId: null,
      family: null,
      micro: null
    };
  }

  if (!familyIdMatchesTradeSide(familyId, row.side)) {
    return {
      ...baseDecision,
      allowed: false,
      reason: "DISCORD_FAMILY_SIDE_MISMATCH"
    };
  }

  if (!microFamilyKey) {
    return {
      ...baseDecision,
      allowed: false,
      reason: "DISCORD_MICRO_FAMILY_UNRESOLVED"
    };
  }

  if (!microFamilyKeyMatchesTradeSide(microFamilyKey, row.side)) {
    return {
      ...baseDecision,
      allowed: false,
      reason: "DISCORD_MICRO_FAMILY_SIDE_MISMATCH"
    };
  }

  if (!allowedMicroKeys.size) {
    return {
      ...baseDecision,
      allowed: false,
      reason: "DISCORD_ALLOWED_MICRO_KEYS_EMPTY"
    };
  }

  if (!allowedMicroKeys.has(microFamilyKey)) {
    return {
      ...baseDecision,
      allowed: false,
      reason: "DISCORD_MICRO_FAMILY_KEY_NOT_ALLOWED"
    };
  }

  return {
    ...baseDecision,
    allowed: true,
    reason: "DISCORD_EXACT_MICRO_FAMILY_KEY_MATCH"
  };
}

function isDiscordDecisionFinalAllowed(discordDecision, side) {
  const familyId = normalizeFamilyId(discordDecision?.familyId);
  const microFamilyKey = getMicroFamilyKeyFromMeta(discordDecision);
  const allowedKeys = getAllowedDiscordMicroFamilyKeys();

  return (
    discordDecision?.allowed === true &&
    discordDecision?.reason === "DISCORD_EXACT_MICRO_FAMILY_KEY_MATCH" &&
    familyId &&
    microFamilyKey &&
    familyIdMatchesTradeSide(familyId, side) &&
    microFamilyKeyMatchesTradeSide(microFamilyKey, side) &&
    allowedKeys.has(microFamilyKey)
  );
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
  discordEntriesSentThisRun,
  discordEntriesBySideThisRun
}) {
  const side = normalizeSide(c?.side);

  if (!notify) return "NOTIFY_DISABLED_ANALYZE_ONLY";

  if (!isDiscordDecisionFinalAllowed(discordDecision, c?.side)) {
    return discordDecision?.reason || "DISCORD_FILTER_NOT_ALLOWED";
  }

  if (hasRecentEntryNotify(c.symbol, c.side, c.price)) {
    return "DUPLICATE_ENTRY_NOTIFY";
  }

  if (discordEntriesSentThisRun >= RUNNER_MAX_DISCORD_ENTRIES_PER_RUN) {
    return "DISCORD_RUN_ENTRY_CAP";
  }

  if (safeNumber(discordEntriesBySideThisRun?.[side], 0) >= RUNNER_MAX_DISCORD_ENTRIES_PER_SIDE_PER_RUN) {
    return "DISCORD_SIDE_ENTRY_CAP";
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
  const derivedMicro = getRunnerMicroMetaForRow({
    ...pos,
    symbol,
    side
  });

  const familyId = normalizeFamilyId(
    pos.discordFamilyId ||
      pos.familyId ||
      pos.runnerFamilyId ||
      pos.analyzeFamilyId ||
      pos.analysisFamilyId ||
      derivedMicro?.familyId
  );

  const microFamilyKey = normalizeMicroFamilyKey(
    pos.discordMicroFamilyKey ||
      pos.microFamilyKey ||
      pos.runnerMicroFamilyKey ||
      pos.analyzeMicroFamilyKey ||
      pos.analysisMicroFamilyKey ||
      derivedMicro?.microFamilyKey
  );

  const microFamilyId = normalizeFamilyId(
    pos.discordMicroFamilyId ||
      pos.microFamilyId ||
      pos.runnerMicroFamilyId ||
      pos.analyzeMicroFamilyId ||
      pos.analysisMicroFamilyId ||
      derivedMicro?.microFamilyId
  );

  const exactMicroAllowed = isExactAllowedMicroFamilyForSide(
    {
      ...pos,
      familyId,
      microFamilyKey,
      microFamilyId
    },
    side
  );

  const discordEntryAllowed = Boolean(
    pos.discordEntryAllowed ??
      pos.discordAllowed ??
      exactMicroAllowed
  ) && exactMicroAllowed;

  const discordEntryNotified = Boolean(
    pos.discordEntryNotified ??
      pos.discordNotified ??
      exactMicroAllowed
  ) && exactMicroAllowed;

  const tradeId =
    pos.tradeId ||
    pos.positionTradeId ||
    `RUNNER_${symbol}_${side}_${safeNumber(pos.createdAt, now)}_${Number(entry).toPrecision(12)}`;

  const normalized = {
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

    familyId: familyId || null,
    macroFamilyId: familyId || null,
    runnerFamilyId: pos.runnerFamilyId || familyId || null,
    analyzeFamilyId: pos.analyzeFamilyId || familyId || null,
    analysisFamilyId: pos.analysisFamilyId || familyId || null,
    discordFamilyId: pos.discordFamilyId || familyId || null,

    microFamilyId: microFamilyId || null,
    runnerMicroFamilyId: pos.runnerMicroFamilyId || microFamilyId || null,
    analyzeMicroFamilyId: pos.analyzeMicroFamilyId || microFamilyId || null,
    analysisMicroFamilyId: pos.analysisMicroFamilyId || microFamilyId || null,
    discordMicroFamilyId: pos.discordMicroFamilyId || microFamilyId || null,

    microFamilyKey: microFamilyKey || null,
    runnerMicroFamilyKey: pos.runnerMicroFamilyKey || microFamilyKey || null,
    analyzeMicroFamilyKey: pos.analyzeMicroFamilyKey || microFamilyKey || null,
    analysisMicroFamilyKey: pos.analysisMicroFamilyKey || microFamilyKey || null,
    discordMicroFamilyKey: pos.discordMicroFamilyKey || microFamilyKey || null,

    microLabels: normalizeLabels(
      Array.isArray(pos.microLabels) && pos.microLabels.length
        ? pos.microLabels
        : derivedMicro?.microLabels || pos.labels
    ),
    microDefinition: pos.microDefinition || derivedMicro?.microDefinition || null,
    microBuckets: pos.microBuckets || derivedMicro?.microBuckets || null,

    labels: normalizeLabels(
      Array.isArray(pos.labels) && pos.labels.length
        ? pos.labels
        : derivedMicro?.labels
    ),

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

  if (derivedMicro) {
    applyFamilyMeta(normalized, {
      ...derivedMicro,
      microFamilyKey,
      microFamilyId
    });
  }

  return normalized;
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
    const exactMicroAllowed = isExactAllowedMicroFamilyForSide(pos, pos?.side);

    const keep =
      exactMicroAllowed &&
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

    if (!isExactAllowedMicroFamilyForSide(pos, pos.side)) {
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
    macroFamilyId: row.macroFamilyId,
    runnerFamilyId: row.runnerFamilyId,
    analyzeFamilyId: row.analyzeFamilyId,
    analysisFamilyId: row.analysisFamilyId,
    discordFamilyId: row.discordFamilyId,

    microFamilyId: row.microFamilyId,
    runnerMicroFamilyId: row.runnerMicroFamilyId,
    analyzeMicroFamilyId: row.analyzeMicroFamilyId,
    analysisMicroFamilyId: row.analysisMicroFamilyId,
    discordMicroFamilyId: row.discordMicroFamilyId,

    microFamilyKey: row.microFamilyKey,
    runnerMicroFamilyKey: row.runnerMicroFamilyKey,
    analyzeMicroFamilyKey: row.analyzeMicroFamilyKey,
    analysisMicroFamilyKey: row.analysisMicroFamilyKey,
    discordMicroFamilyKey: row.discordMicroFamilyKey,

    labels: row.labels,
    microLabels: row.microLabels,
    microDefinition: row.microDefinition,
    microBuckets: row.microBuckets,

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
      "runnerTradeSystem:runtime:RUNNER_TS_V2_1_EXACT_MICRO_FAMILY_GATE",
      "runnerTradeSystem:runtime:RUNNER_TS_V2_0_HARD_DISCORD_FAMILY_GATE",
      "runnerTradeSystem:runtime:RUNNER_TS_V1_9_LIVE_DISCORD_FAMILY_GATE",
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