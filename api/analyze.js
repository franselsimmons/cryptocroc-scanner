// ================= api/analyze.js =================
// RUNNER / TRADESYSTEM ANALYZER
// Leest de actuele RUNNER durable runtime direct uit Redis.
// Ondersteunt:
// - huidige chunked runtime: runnerTradeSystem:runtime:<STRATEGY_VERSION>:meta/chunk
// - legacy split runtime
// - legacy single runtime
//
// Analyze doet geen harde live-entry gates.
// Analyze groepeert, rekent outcomes af en rankt PnL-first.

import { getLatestScan } from "../lib/scanStore.js";

const SYSTEM_PROFILE = "RUNNER";
const ENDPOINT = "/api/analyze";

const STRATEGY_VERSION =
  process.env.RUNNER_STRATEGY_VERSION ||
  process.env.TRADE_SYSTEM_STRATEGY_VERSION ||
  process.env.STRATEGY_VERSION ||
  "RUNNER_TS_V2_1_EXACT_MICRO_FAMILY_KEY_GATE";

const OBJECTIVE = "PNL_FIRST_FROZEN_FAMILY_ANALYZE";
const STRATEGY = "50_LONG_FAMILIES_PLUS_50_SHORT_FAMILIES_MICRO_KEY_DISCOVERY";

// Huidige runnerTradeSystem durable chunked runtime.
const RUNNER_RUNTIME_STORE_KEY = `runnerTradeSystem:runtime:${STRATEGY_VERSION}`;
const RUNNER_RUNTIME_META_KEY = `${RUNNER_RUNTIME_STORE_KEY}:meta`;
const RUNNER_RUNTIME_CHUNK_PREFIX = `${RUNNER_RUNTIME_STORE_KEY}:chunk:`;

// Oude/split runtime fallback.
const RUNTIME_STORE_KEY = `${STRATEGY_VERSION}:runtime:legacy`;
const RUNTIME_CORE_KEY = `${STRATEGY_VERSION}:runtime:core`;
const RUNTIME_RECENT_KEY = `${STRATEGY_VERSION}:runtime:recent_entries`;

const RUNTIME_CLOSED_META_KEY = `${STRATEGY_VERSION}:runtime:closed_trades:meta`;
const RUNTIME_CLOSED_CHUNK_PREFIX = `${STRATEGY_VERSION}:runtime:closed_trades:chunk:`;

const RUNTIME_FEATURE_META_KEY = `${STRATEGY_VERSION}:runtime:feature_store:meta`;
const RUNTIME_FEATURE_CHUNK_PREFIX = `${STRATEGY_VERSION}:runtime:feature_store:chunk:`;

const RUNTIME_SHADOW_META_KEY = `${STRATEGY_VERSION}:runtime:shadow_outcomes:meta`;
const RUNTIME_SHADOW_CHUNK_PREFIX = `${STRATEGY_VERSION}:runtime:shadow_outcomes:chunk:`;

const MAX_EXAMPLES_PER_FAMILY = 10;
const MAX_EXAMPLES_PER_MICRO_FAMILY = 8;

const DEFAULT_MIN_CLOSED = 10;
const DEFAULT_MIN_WINRATE = 0.35;
const DEFAULT_BREAKEVEN_R_EPS = 0.05;

const QUALITY_BUCKETS = [
  { index: 1, key: "Q1_WEAK", conf: "CONF_0_50", sniper: "SNIPER_0_50", rr: "RR_LT_1p00", score: "SCORE_0_50" },
  { index: 2, key: "Q2_LOW", conf: "CONF_50_65", sniper: "SNIPER_50_65", rr: "RR_1p00_1p20", score: "SCORE_50_65" },
  { index: 3, key: "Q3_BASE", conf: "CONF_65_75", sniper: "SNIPER_65_75", rr: "RR_1p20_1p50", score: "SCORE_65_75" },
  { index: 4, key: "Q4_STRONG", conf: "CONF_75_85", sniper: "SNIPER_75_85", rr: "RR_1p50_2p00", score: "SCORE_75_85" },
  { index: 5, key: "Q5_ELITE", conf: "CONF_85_100", sniper: "SNIPER_85_100", rr: "RR_2p00_PLUS", score: "SCORE_85_100" },
];

const MARKET_BUCKETS = [
  { index: 1, key: "M1_DIRTY", ob: "OB_REL_AGAINST", spread: "SPREAD_GT_25BPS", depth: "DEPTH_LT_10K", btc: "BTC_REL_COUNTER", funding: "FUNDING_CROWDED" },
  { index: 2, key: "M2_WEAK", ob: "OB_REL_AGAINST_OR_NEUTRAL", spread: "SPREAD_16_25BPS", depth: "DEPTH_10K_50K", btc: "BTC_REL_COUNTER", funding: "FUNDING_EDGE_WEAK" },
  { index: 3, key: "M3_NORMAL", ob: "OB_REL_NEUTRAL", spread: "SPREAD_8_16BPS", depth: "DEPTH_50K_100K", btc: "BTC_REL_NEUTRAL", funding: "FUNDING_NEUTRAL" },
  { index: 4, key: "M4_CLEAN", ob: "OB_REL_WITH_OR_NEUTRAL", spread: "SPREAD_5_12BPS", depth: "DEPTH_100K_250K", btc: "BTC_REL_WITH_OR_NEUTRAL", funding: "FUNDING_OK" },
  { index: 5, key: "M5_PREMIUM", ob: "OB_REL_WITH", spread: "SPREAD_LT_8BPS", depth: "DEPTH_GT_250K", btc: "BTC_REL_WITH", funding: "FUNDING_OPTIMAL" },
];

const TIMING_BUCKETS = [
  { index: 1, key: "T1_EARLY_OR_NOISY" },
  { index: 2, key: "T2_TIMED" },
];

// ================= BASIC HELPERS =================

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeNumber(value, fallback = 0) {
  if (typeof value === "string") {
    const cleaned = value.replace("%", "").replace(",", ".").trim();
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : fallback;
  }

  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function readNumber(row, keys, fallback = null) {
  for (const key of keys) {
    if (row?.[key] === undefined || row?.[key] === null || row?.[key] === "") continue;

    const n = safeNumber(row[key], Number.NaN);
    if (Number.isFinite(n)) return n;
  }

  return fallback;
}

function round(value, decimals = 3) {
  const n = safeNumber(value, 0);
  const p = 10 ** decimals;
  return Math.round(n * p) / p;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function parseJsonLoose(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return fallback;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;

  const v = String(value).trim().toLowerCase();

  if (["1", "true", "yes", "y", "on"].includes(v)) return true;
  if (["0", "false", "no", "n", "off"].includes(v)) return false;

  return fallback;
}

function pctText(value) {
  return `${round(safeNumber(value, 0) * 100, 1)}%`;
}

function getRequestUrl(req) {
  const host = req?.headers?.host || "localhost";
  const proto = req?.headers?.["x-forwarded-proto"] || "https";

  return new URL(req?.url || "/", `${proto}://${host}`);
}

function getQueryParam(req, key, fallback = "") {
  try {
    return getRequestUrl(req).searchParams.get(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function normalizeSide(value) {
  const s = String(value || "").trim().toUpperCase();

  if (["LONG", "BULL", "BUY"].includes(s)) return "LONG";
  if (["SHORT", "BEAR", "SELL"].includes(s)) return "SHORT";

  return "";
}

function normalizeSymbol(value) {
  return String(value || "")
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

function normalizeAction(value, fallback = "OBSERVE") {
  const a = String(value || "").trim().toUpperCase();
  return a || fallback;
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
  return safeArray(labels)
    .map(label => String(label || "").trim().toUpperCase())
    .filter(Boolean);
}

function normalizeSpread(spreadPct) {
  let spread = safeNumber(spreadPct, 0);

  if (!Number.isFinite(spread) || spread < 0) return 0;
  if (spread > 0.05) spread = spread / 100;

  return spread;
}

function getMicroFamilyKeyFromRow(row = {}) {
  return normalizeMicroFamilyKey(
    row.microFamilyKey ||
      row.runnerMicroFamilyKey ||
      row.analyzeMicroFamilyKey ||
      row.analysisMicroFamilyKey ||
      row.discordMicroFamilyKey ||
      row?.family?.microFamilyKey ||
      row?.discordDecision?.microFamilyKey ||
      row?.discordDecision?.micro?.microFamilyKey ||
      row?.discordDecision?.family?.microFamilyKey ||
      ""
  );
}

function getMicroFamilyIdFromRow(row = {}) {
  return normalizeFamilyId(
    row.microFamilyId ||
      row.runnerMicroFamilyId ||
      row.analyzeMicroFamilyId ||
      row.analysisMicroFamilyId ||
      row.discordMicroFamilyId ||
      row?.family?.microFamilyId ||
      row?.discordDecision?.microFamilyId ||
      row?.discordDecision?.micro?.microFamilyId ||
      row?.discordDecision?.family?.microFamilyId ||
      ""
  );
}

function getFamilyLabelsFromRow(row = {}) {
  return normalizeLabels(
    row.microLabels ||
      row.labels ||
      row?.family?.microLabels ||
      row?.family?.labels ||
      row?.discordDecision?.microLabels ||
      row?.discordDecision?.family?.microLabels ||
      row?.discordDecision?.family?.labels ||
      row?.discordDecision?.micro?.microLabels ||
      row?.discordDecision?.micro?.labels ||
      []
  );
}

function getMacroFamilyIdFromRow(row = {}) {
  const explicit =
    row.familyId ||
    row.runnerFamilyId ||
    row.analyzeFamilyId ||
    row.analysisFamilyId ||
    row.discordFamilyId ||
    row.macroFamilyId ||
    row.frozenFamilyId ||
    row.filterFamily ||
    "";

  const normalized = normalizeExplicitFamilyId(explicit);
  if (normalized) return normalized;

  const microFamilyKey = getMicroFamilyKeyFromRow(row);
  const microMacro = normalizeExplicitFamilyId(microFamilyKey.split("::")[0]);

  return microMacro || null;
}

// ================= REDIS =================

function getRedisUrl() {
  return (
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.REDIS_REST_API_URL ||
    ""
  ).replace(/\/+$/, "");
}

function getRedisToken() {
  return (
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.REDIS_REST_API_TOKEN ||
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

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(command),
  });

  const text = await response.text();
  const json = parseJsonLoose(text, null);

  if (!response.ok || json?.error) {
    throw new Error(json?.error || text?.slice(0, 500) || `redis_error_${response.status}`);
  }

  return json?.result ?? null;
}

async function redisGetJson(key) {
  const raw = await redisCommand(["GET", key]);
  return parseJsonLoose(raw, raw);
}

async function readJsonArrayChunks(metaKey, chunkPrefix) {
  const meta = await redisGetJson(metaKey).catch(() => null);

  if (!meta || typeof meta !== "object") return [];

  if (meta.strategyVersion && meta.strategyVersion !== STRATEGY_VERSION) {
    return [];
  }

  const chunkCount = Math.max(
    0,
    Math.round(safeNumber(meta.chunks ?? meta.chunkCount, 0))
  );

  if (!chunkCount) return [];

  const reads = [];

  for (let i = 0; i < chunkCount; i++) {
    reads.push(redisGetJson(`${chunkPrefix}${i}`).catch(() => []));
  }

  const chunks = await Promise.all(reads);

  return chunks
    .flatMap(chunk => {
      if (Array.isArray(chunk)) return chunk;

      const parsed = parseJsonLoose(chunk, []);
      if (Array.isArray(parsed)) return parsed;

      return [];
    })
    .filter(row => row && typeof row === "object");
}

async function readRunnerChunkedRuntimePayload() {
  const meta = await redisGetJson(RUNNER_RUNTIME_META_KEY).catch(() => null);

  if (!meta || typeof meta !== "object") return null;

  const chunkCount = Math.max(0, Math.round(safeNumber(meta.chunkCount, 0)));
  if (!chunkCount) return null;

  const chunks = [];

  for (let i = 0; i < chunkCount; i += 1) {
    const chunk = await redisCommand(["GET", `${RUNNER_RUNTIME_CHUNK_PREFIX}${i}`]).catch(() => null);

    if (typeof chunk !== "string") {
      throw new Error(`runner_runtime_chunk_missing:${i}`);
    }

    chunks.push(chunk);
  }

  const payload = parseJsonLoose(chunks.join(""), null);

  if (!payload || typeof payload !== "object") return null;

  return {
    ...payload,
    __meta: meta,
  };
}

function memoryPairsToRows(memoryPairs) {
  return safeArray(memoryPairs)
    .map(pair => {
      if (!Array.isArray(pair)) return null;

      const key = pair[0];
      const pos = pair[1];

      if (!pos || typeof pos !== "object") return null;

      return {
        ...pos,
        memoryKey: key,
        source: "MEMORY_OPEN",
        action: "HOLD",
        closed: false,
      };
    })
    .filter(Boolean);
}

function getPayloadWeight(payload) {
  if (!payload || typeof payload !== "object") return 0;

  return (
    safeArray(payload.memory).length * 10 +
    safeArray(payload.stats?.closedTrades).length * 8 +
    safeArray(payload.stats?.featureRows).length +
    safeArray(payload.stats?.shadowRows).length
  );
}

function runtimePayloadToRuntime(payload) {
  const stats = safeObject(payload?.stats);

  return {
    ok: true,
    mode: "RUNNER_TRADE_SYSTEM_CHUNKED_RUNTIME",
    redisEnabled: true,
    strategyVersion: payload?.strategyVersion || STRATEGY_VERSION,
    core: payload,
    recentEntries: [],
    closedTrades: safeArray(stats.closedTrades),
    featureStore: safeArray(stats.featureRows),
    shadowOutcomes: safeArray(stats.shadowRows),
    memoryOpen: memoryPairsToRows(payload?.memory),
    loadedAt: Date.now(),
    keys: {
      runnerStore: RUNNER_RUNTIME_STORE_KEY,
      runnerMeta: RUNNER_RUNTIME_META_KEY,
      runnerChunkPrefix: RUNNER_RUNTIME_CHUNK_PREFIX,
    },
    meta: payload?.__meta || null,
  };
}

async function loadLegacySplitRuntime() {
  const core = await redisGetJson(RUNTIME_CORE_KEY).catch(() => null);

  if (core?.strategyVersion === STRATEGY_VERSION) {
    const [
      recentEntries,
      closedTrades,
      featureStore,
      shadowOutcomes,
    ] = await Promise.all([
      redisGetJson(RUNTIME_RECENT_KEY).then(v => Array.isArray(v) ? v : []).catch(() => []),
      readJsonArrayChunks(RUNTIME_CLOSED_META_KEY, RUNTIME_CLOSED_CHUNK_PREFIX),
      readJsonArrayChunks(RUNTIME_FEATURE_META_KEY, RUNTIME_FEATURE_CHUNK_PREFIX),
      readJsonArrayChunks(RUNTIME_SHADOW_META_KEY, RUNTIME_SHADOW_CHUNK_PREFIX),
    ]);

    return {
      ok: true,
      mode: "TRADE_SYSTEM_DURABLE_SPLIT",
      redisEnabled: true,
      strategyVersion: STRATEGY_VERSION,
      core,
      recentEntries,
      closedTrades,
      featureStore,
      shadowOutcomes,
      memoryOpen: memoryPairsToRows(core?.memory),
      loadedAt: Date.now(),
      keys: {
        core: RUNTIME_CORE_KEY,
        recent: RUNTIME_RECENT_KEY,
        closedMeta: RUNTIME_CLOSED_META_KEY,
        featureMeta: RUNTIME_FEATURE_META_KEY,
        shadowMeta: RUNTIME_SHADOW_META_KEY,
      },
    };
  }

  return null;
}

async function loadLegacySingleRuntime() {
  const legacy = await redisGetJson(RUNTIME_STORE_KEY).catch(() => null);

  if (legacy?.strategyVersion !== STRATEGY_VERSION) return null;

  const audit = safeObject(legacy.audit);

  return {
    ok: true,
    mode: "TRADE_SYSTEM_DURABLE_LEGACY",
    redisEnabled: true,
    strategyVersion: STRATEGY_VERSION,
    core: legacy,
    recentEntries: safeArray(audit.recentEntries),
    closedTrades: safeArray(audit.closedTrades),
    featureStore: safeArray(audit.featureStore),
    shadowOutcomes: safeArray(audit.shadowOutcomes),
    memoryOpen: memoryPairsToRows(legacy.memory),
    loadedAt: Date.now(),
    keys: {
      legacy: RUNTIME_STORE_KEY,
    },
  };
}

async function loadDurableTradeSystemRuntime() {
  const redisEnabled = hasRedis();

  if (!redisEnabled) {
    return {
      ok: false,
      redisEnabled,
      error: "redis_env_missing",
      core: null,
      recentEntries: [],
      closedTrades: [],
      featureStore: [],
      shadowOutcomes: [],
      memoryOpen: [],
      loadedAt: Date.now(),
    };
  }

  try {
    const runnerPayload = await readRunnerChunkedRuntimePayload().catch(() => null);

    if (runnerPayload && getPayloadWeight(runnerPayload) > 0) {
      return runtimePayloadToRuntime(runnerPayload);
    }

    const split = await loadLegacySplitRuntime();
    if (split) return split;

    const single = await loadLegacySingleRuntime();
    if (single) return single;

    return {
      ok: true,
      mode: "TRADE_SYSTEM_DURABLE_EMPTY_OR_VERSION_MISMATCH",
      redisEnabled,
      strategyVersion: STRATEGY_VERSION,
      core: null,
      recentEntries: [],
      closedTrades: [],
      featureStore: [],
      shadowOutcomes: [],
      memoryOpen: [],
      loadedAt: Date.now(),
      keys: {
        runnerStore: RUNNER_RUNTIME_STORE_KEY,
        runnerMeta: RUNNER_RUNTIME_META_KEY,
        runnerChunkPrefix: RUNNER_RUNTIME_CHUNK_PREFIX,
        core: RUNTIME_CORE_KEY,
        legacy: RUNTIME_STORE_KEY,
      },
      warning: "runtime_empty_or_version_mismatch",
    };
  } catch (error) {
    return {
      ok: false,
      mode: "TRADE_SYSTEM_DURABLE_ERROR",
      redisEnabled,
      strategyVersion: STRATEGY_VERSION,
      error: error?.message || String(error),
      core: null,
      recentEntries: [],
      closedTrades: [],
      featureStore: [],
      shadowOutcomes: [],
      memoryOpen: [],
      loadedAt: Date.now(),
    };
  }
}

// ================= LATEST SCAN =================

async function loadLatestTradeSystemRows({ includeLatest }) {
  if (!includeLatest) {
    return {
      ok: true,
      count: 0,
      rows: [],
      note: "includeLatest=false",
    };
  }

  try {
    const latest = await getLatestScan();

    if (!latest?.ok) {
      return {
        ok: false,
        count: 0,
        rows: [],
        note: "latest_scan_not_ok",
      };
    }

    const tradeSystemResult = safeObject(latest.tradeSystemResult);
    const analysis = safeObject(tradeSystemResult.analysis);

    const rows = [
      ...safeArray(tradeSystemResult.actions).map(row => ({
        ...row,
        source: "LATEST_ACTION",
      })),
      ...safeArray(tradeSystemResult.openPositions).map(row => ({
        ...row,
        source: "LATEST_OPEN_POSITION",
        action: row?.action || "HOLD",
        closed: false,
      })),
      ...safeArray(analysis.openPositions).map(row => ({
        ...row,
        source: "LATEST_ANALYSIS_OPEN_POSITION",
        action: row?.action || "HOLD",
        closed: false,
      })),
    ];

    return {
      ok: true,
      count: rows.length,
      rows,
      updatedAt: latest.updatedAt || latest.tradeFunnelUpdatedAt || latest.scannerUpdatedAt || 0,
      note: "latest scan OK",
    };
  } catch (error) {
    return {
      ok: false,
      count: 0,
      rows: [],
      note: error?.message || String(error),
    };
  }
}

// ================= ROW NORMALIZATION =================

function getRowKey(row) {
  const symbol = normalizeSymbol(row?.symbol);
  const side = normalizeSide(row?.side);
  const action = normalizeAction(row?.action, "OBSERVE");
  const microFamilyKey = getMicroFamilyKeyFromRow(row);

  return [
    row?.tradeId || row?.positionTradeId || row?.id || "",
    row?.runId || "",
    row?.source || "",
    symbol,
    side,
    action,
    row?.entryReason || row?.reason || row?.entryType || "",
    microFamilyKey,
    row?.entry ?? "",
    row?.exit ?? row?.exitPrice ?? "",
    row?.exitR ?? row?.resultR ?? row?.realizedR ?? row?.pnlR ?? "",
    row?.pnlPct ?? "",
    row?.createdAt || row?.closedAt || row?.exitedAt || row?.completedAt || row?.ts || "",
  ].join("|");
}

function uniqueRows(rows) {
  const seen = new Set();
  const out = [];

  for (const row of safeArray(rows)) {
    if (!row || typeof row !== "object") continue;

    const key = getRowKey(row);
    if (seen.has(key)) continue;

    seen.add(key);
    out.push(row);
  }

  return out;
}

function isCompletedShadow(row) {
  const status = String(row?.status || "").toUpperCase();

  if (!status || status === "OPEN") return false;

  return (
    Number.isFinite(Number(row?.exitR)) ||
    Number.isFinite(Number(row?.pnlPct)) ||
    Boolean(row?.win) ||
    Boolean(row?.loss)
  );
}

function isClosedAction(row) {
  const action = normalizeAction(row?.action, "");
  const status = String(row?.status || "").toUpperCase();

  if (row?.closed === true || row?.isClosed === true) return true;
  if (["EXIT", "TP", "SL"].includes(action)) return true;
  if (["HIT_TP", "HIT_SL", "HORIZON_DONE", "DONE", "CLOSED"].includes(status)) return true;
  if (row?.exitReason && String(row.exitReason).toUpperCase() !== "RUNNING") return true;
  if (row?.closedAt || row?.exitedAt || row?.completedAt) return true;

  return false;
}

function isOpenAction(row) {
  if (isClosedAction(row)) return false;

  const action = normalizeAction(row?.action, "");
  const status = String(row?.status || "").toUpperCase();

  if (status === "OPEN") return true;
  if (row?.closed === false) return true;
  if (["ENTRY", "HOLD", "PARTIAL_TP", "MOVE_BE", "TRAIL", "ADD"].includes(action)) return true;
  if (row?.source === "MEMORY_OPEN") return true;

  return false;
}

function getResultR(row) {
  return readNumber(row, [
    "exitR",
    "resultR",
    "realizedR",
    "pnlR",
    "outcomeR",
    "rMultiple",
    "r",
  ], 0);
}

function getPnlPct(row) {
  return readNumber(row, [
    "pnlPct",
    "totalPnlPct",
    "profitPct",
    "pnlPercent",
    "triggerPnlPct",
  ], 0);
}

function getPlannedRR(row) {
  return readNumber(row, [
    "plannedRR",
    "finalRR",
    "finalRr",
    "effectiveRR",
    "rr",
    "baseRR",
    "targetR",
    "riskReward",
    "rMultiple",
  ], 0);
}

function normalizeAnalysisRow(rawRow, sourceType, config) {
  const row = safeObject(rawRow);
  const side = normalizeSide(row.side);
  const symbol = normalizeSymbol(row.symbol);

  if (!symbol || !side) return null;

  const action = normalizeAction(row.action, "OBSERVE");
  const source = String(row.source || sourceType || "UNKNOWN").toUpperCase();

  const shadowCompleted =
    (source.includes("SHADOW") || sourceType === "SHADOW_OUTCOME") &&
    isCompletedShadow(row);

  const realClosed = sourceType === "REAL_CLOSED";
  const latestClosed = sourceType === "LATEST" && isClosedAction(row) && !source.includes("SHADOW");

  const closedRaw = realClosed || shadowCompleted || latestClosed || isClosedAction(row);
  const openRaw = isOpenAction(row);

  const useForStats =
    realClosed ||
    latestClosed ||
    (config.includeShadow && shadowCompleted);

  const isTradeLike =
    realClosed ||
    latestClosed ||
    sourceType === "RECENT_ENTRY" ||
    sourceType === "MEMORY_OPEN" ||
    ["ENTRY", "HOLD", "EXIT", "TP", "SL", "PARTIAL_TP", "MOVE_BE", "TRAIL", "ADD"].includes(action);

  const observationOnly =
    !isTradeLike ||
    sourceType === "FEATURE_STORE" ||
    source.includes("SCAN") ||
    source.includes("ANALYZE_ONLY");

  const resultR = getResultR(row);
  const pnlPct = getPnlPct(row);
  const microFamilyKey = getMicroFamilyKeyFromRow(row);
  const microFamilyId = getMicroFamilyIdFromRow(row);
  const macroFamilyId = getMacroFamilyIdFromRow(row);

  return {
    ...row,

    source,
    sourceType,

    symbol,
    side,
    action,

    closedRaw,
    openRaw,
    useForStats,

    closed: Boolean(useForStats && closedRaw),
    open: Boolean(!useForStats && openRaw) || Boolean(openRaw && !closedRaw),

    shadowCompleted,
    realClosed,
    latestClosed,
    observationOnly,
    isTradeLike,

    tradeId:
      row.tradeId ||
      row.positionTradeId ||
      row.id ||
      `${STRATEGY_VERSION}_${symbol}_${side}_${row.createdAt || row.ts || row.closedAt || row.exitedAt || ""}`,

    resultR: safeNumber(resultR, 0),
    pnlPct: safeNumber(pnlPct, 0),
    plannedRR: getPlannedRR(row),

    mfeR: safeNumber(row.mfeR, 0),
    maeR: safeNumber(row.maeR, 0),

    familyId: macroFamilyId || row.familyId || null,
    macroFamilyId: macroFamilyId || row.macroFamilyId || null,
    microFamilyId: microFamilyId || null,
    microFamilyKey: microFamilyKey || null,
    microLabels: getFamilyLabelsFromRow(row),

    ts: safeNumber(row.ts || row.createdAt || row.closedAt || row.exitedAt || row.completedAt, 0),
  };
}

// ================= FAMILY BUCKETING =================

function bucketScoreToIndex(value) {
  const n = safeNumber(value, 0);

  if (n >= 85) return 5;
  if (n >= 75) return 4;
  if (n >= 65) return 3;
  if (n >= 50) return 2;

  return 1;
}

function bucketRrToIndex(value) {
  const n = safeNumber(value, 0);

  if (n >= 2) return 5;
  if (n >= 1.5) return 4;
  if (n >= 1.2) return 3;
  if (n >= 1) return 2;

  return 1;
}

function setupFallbackQualityIndex(row) {
  const setup = String(row?.setupClass || row?.oldSetupClass || "").toUpperCase();

  if (["RUNNER_C", "GOD", "A_PLUS"].includes(setup)) return 5;
  if (["RUNNER_A", "A", "A_SHORT_EXCEPTION"].includes(setup)) return 4;
  if (["RUNNER_B", "B", "B_TREND_PROBE"].includes(setup)) return 3;

  return 1;
}

function getQualityIndex(row) {
  const parts = [];

  const confluence = readNumber(row, ["confluence", "effectiveConfluence", "rawConfluence"], null);
  const sniper = readNumber(row, ["sniperScore", "rawSniperScore", "sniper"], null);
  const score = readNumber(row, ["score", "moveScore"], null);
  const rr = getPlannedRR(row);

  if (confluence !== null) parts.push(bucketScoreToIndex(confluence));
  if (sniper !== null) parts.push(bucketScoreToIndex(sniper));
  if (score !== null) parts.push(bucketScoreToIndex(score));
  if (rr !== null && Number.isFinite(Number(rr))) parts.push(bucketRrToIndex(rr));

  if (!parts.length) return setupFallbackQualityIndex(row);

  const avg = parts.reduce((sum, n) => sum + n, 0) / parts.length;

  return clamp(Math.round(avg), 1, 5);
}

function getObIndex(row, side) {
  const ob = String(row?.obBias || row?.orderbookBias || row?.obSideRelation || "").toUpperCase();

  if (!ob || ob === "UNKNOWN" || ob === "NEUTRAL") return 3;

  if (ob === "WITH") return 5;
  if (ob === "AGAINST") return 1;

  const withSide =
    (side === "LONG" && ob === "BULLISH") ||
    (side === "SHORT" && ob === "BEARISH");

  return withSide ? 5 : 1;
}

function getSpreadIndex(row) {
  const spread = readNumber(row, ["spreadPct"], null);
  const spreadBps = readNumber(row, ["spreadBps"], null);

  const bps = spreadBps !== null
    ? spreadBps
    : spread !== null
      ? normalizeSpread(spread) * 10000
      : null;

  if (bps === null) return null;

  if (bps < 8) return 5;
  if (bps <= 12) return 4;
  if (bps <= 16) return 3;
  if (bps <= 25) return 2;

  return 1;
}

function getDepthIndex(row) {
  const depth = readNumber(row, ["depthMinUsd1p", "depthUsd", "depth"], null);

  if (depth === null || depth <= 0) return null;

  if (depth >= 250000) return 5;
  if (depth >= 100000) return 4;
  if (depth >= 50000) return 3;
  if (depth >= 10000) return 2;

  return 1;
}

function getBtcIndex(row, side) {
  const rel = String(row?.btcRel || row?.btcRelation || "").toUpperCase();

  if (["WITH", "ALIGNED"].includes(rel)) return 5;
  if (["COUNTER", "AGAINST"].includes(rel)) return 1;
  if (["NEUTRAL", "FLAT"].includes(rel)) return 3;

  const state = String(row?.btcState || row?.btc || "").toUpperCase();

  if (!state || state === "UNKNOWN" || state === "NEUTRAL") return 3;

  const withSide =
    (side === "LONG" && state.includes("BULL")) ||
    (side === "SHORT" && state.includes("BEAR"));

  return withSide ? 5 : 1;
}

function getFundingIndex(row, side) {
  const funding = readNumber(row, ["funding", "fundingRate"], null);
  if (funding === null) return null;

  const directional = side === "SHORT" ? -funding : funding;

  if (directional <= -0.00035) return 5;
  if (directional <= -0.0001) return 4;
  if (Math.abs(directional) <= 0.00015) return 3;
  if (directional <= 0.0004) return 2;

  return 1;
}

function getMarketIndex(row, side) {
  const parts = [
    getObIndex(row, side),
    getSpreadIndex(row),
    getDepthIndex(row),
    getBtcIndex(row, side),
    getFundingIndex(row, side),
  ].filter(n => Number.isFinite(Number(n)));

  if (!parts.length) return 3;

  const avg = parts.reduce((sum, n) => sum + n, 0) / parts.length;

  return clamp(Math.round(avg), 1, 5);
}

function rsiTimingOk(row, side) {
  const zone = String(row?.rsiZone || "").toUpperCase();
  const rsi = readNumber(row, ["rsi"], null);

  if (side === "LONG") {
    if (zone === "MID" || zone.startsWith("LOWER")) return true;
    if (rsi !== null && rsi <= 65) return true;
    return false;
  }

  if (zone === "MID" || zone.startsWith("UPPER")) return true;
  if (rsi !== null && rsi >= 35) return true;

  return false;
}

function flowTimingOk(row) {
  const flow = String(row?.flow || row?.scannerFlow || "").toUpperCase();

  return ["TREND", "BUILDING", "BUILDUP", "BREAKOUT", "RUNNING", "SQUEEZE", "PULLBACK"].includes(flow);
}

function stageTimingOk(row) {
  const stage = String(row?.stage || row?.scannerStage || "").toLowerCase();
  const action = normalizeAction(row?.action, "");

  if (["entry", "almost", "open_position"].includes(stage)) return true;
  if (["ENTRY", "HOLD", "EXIT", "PARTIAL_TP", "MOVE_BE", "TRAIL", "ADD"].includes(action)) return true;

  return false;
}

function tfTimingOk(row, side) {
  if (row?.tfAligned === true) return true;
  if (row?.tfAligned === false) return false;

  const alignment = String(row?.tfAlignment || "").toUpperCase();
  if (alignment.includes("ALIGNED")) return true;

  const tfStrength = readNumber(row, ["tfStrength"], null);
  if (tfStrength !== null && tfStrength >= 1) return true;

  const tfScore = readNumber(row, ["tfScore"], null);
  if (tfScore === null) return false;

  if (side === "LONG" && tfScore > 0) return true;
  if (side === "SHORT" && tfScore < 0) return true;

  return false;
}

function structureTimingOk(row) {
  return Boolean(
    row?.structureAligned ||
      row?.pullbackConfirmed ||
      row?.sweepConfirmed ||
      row?.retestConfirmed ||
      row?.fakeBreakout ||
      row?.fakeBreakoutConfirmed ||
      row?.confirmationOk ||
      row?.nearTpSeen ||
      row?.reachedHalfR
  );
}

function getTimingIndex(row, side) {
  const score =
    Number(stageTimingOk(row)) +
    Number(flowTimingOk(row)) +
    Number(rsiTimingOk(row, side)) +
    Number(tfTimingOk(row, side)) +
    Number(structureTimingOk(row));

  return score >= 3 ? 2 : 1;
}

function familyIndex({ qualityIndex, marketIndex, timingIndex }) {
  return ((qualityIndex - 1) * 10) + ((marketIndex - 1) * 2) + timingIndex;
}

function normalizeExplicitFamilyId(value) {
  const raw = String(value || "").trim().toUpperCase();
  const match = raw.match(/^(LONG|SHORT)_(\d{1,2})$/);

  if (!match) return null;

  const index = Number(match[2]);
  if (index < 1 || index > 50) return null;

  return `${match[1]}_${index}`;
}

function getFamilyId(row) {
  const explicit = normalizeExplicitFamilyId(
    row.runnerFamilyId ||
      row.familyId ||
      row.macroFamilyId ||
      row.frozenFamilyId ||
      row.filterFamily ||
      getMicroFamilyKeyFromRow(row).split("::")[0]
  );

  if (explicit) return explicit;

  const side = normalizeSide(row.side);
  if (!side) return null;

  const qualityIndex = getQualityIndex(row);
  const marketIndex = getMarketIndex(row, side);
  const timingIndex = getTimingIndex(row, side);
  const index = familyIndex({ qualityIndex, marketIndex, timingIndex });

  return `${side}_${index}`;
}

function buildTimingLabels(side, timingIndex) {
  if (timingIndex === 1) {
    return ["STAGE_ANY", "FLOW_ANY", "RSI_ANY", "TF_ANY", "PULLBACK_NOT_REQUIRED"];
  }

  return [
    "STAGE_ENTRY_OR_ALMOST",
    "FLOW_TREND_OR_BUILDING",
    side === "SHORT" ? "RSI_UPPER_OR_MID" : "RSI_LOWER_OR_MID",
    "TF_ALIGNED",
    "PULLBACK_OR_CONFIRMATION_OK",
  ];
}

function buildDefinition({ side, qualityIndex, marketIndex, timingIndex }) {
  const q = QUALITY_BUCKETS[qualityIndex - 1];
  const m = MARKET_BUCKETS[marketIndex - 1];
  const t = TIMING_BUCKETS[timingIndex - 1];
  const timing = buildTimingLabels(side, timingIndex);

  return [
    q.key,
    m.key,
    t.key,
    q.conf,
    q.sniper,
    q.rr,
    q.score,
    timing[0],
    timing[1],
    timing[2],
    m.ob,
    m.spread,
    m.depth,
    m.btc,
    m.funding,
    timing[3],
    timing[4],
  ];
}

function buildFamily(side, qualityIndex, marketIndex, timingIndex) {
  const index = familyIndex({ qualityIndex, marketIndex, timingIndex });
  const id = `${side}_${index}`;
  const labels = buildDefinition({ side, qualityIndex, marketIndex, timingIndex });

  return {
    id,
    familyId: id,
    macroFamilyId: id,
    index,
    side,

    quality: QUALITY_BUCKETS[qualityIndex - 1].key,
    qualityBucket: QUALITY_BUCKETS[qualityIndex - 1].key,
    qualityIndex,

    market: MARKET_BUCKETS[marketIndex - 1].key,
    marketBucket: MARKET_BUCKETS[marketIndex - 1].key,
    marketIndex,

    timing: TIMING_BUCKETS[timingIndex - 1].key,
    timingBucket: TIMING_BUCKETS[timingIndex - 1].key,
    timingIndex,

    definition: labels.join(" | "),
    labels,

    observed: 0,
    observations: 0,

    trades: 0,
    closed: 0,
    realClosed: 0,
    shadowClosed: 0,
    open: 0,
    pending: 0,
    pendingOutcome: 0,

    wins: 0,
    losses: 0,
    breakeven: 0,

    winrateNum: 0,
    winrate: "0%",

    totalR: 0,
    avgR: 0,

    totalPnlPct: 0,
    avgPnlPct: 0,

    grossWinR: 0,
    grossLossR: 0,

    profitFactor: 0,
    profitFactorR: 0,
    pf: 0,

    avgMfeR: 0,
    avgMaeR: 0,

    microFamilyKeys: {},
    microFamilyCount: 0,

    status: "EMPTY",
    score: 0,

    examples: [],
  };
}

function buildFamilySet() {
  const long = [];
  const short = [];

  for (const side of ["LONG", "SHORT"]) {
    for (const q of QUALITY_BUCKETS) {
      for (const m of MARKET_BUCKETS) {
        for (const t of TIMING_BUCKETS) {
          const family = buildFamily(side, q.index, m.index, t.index);

          if (side === "LONG") long.push(family);
          else short.push(family);
        }
      }
    }
  }

  const all = [...long, ...short];
  const byId = new Map(all.map(row => [row.id, row]));

  return {
    all,
    long,
    short,
    byId,
  };
}

// ================= REPORT STATS =================

function compactExample(row) {
  return {
    source: row.source,
    sourceType: row.sourceType,
    tradeId: row.tradeId,
    symbol: row.symbol,
    side: row.side,
    action: row.action,

    familyId: row.familyId || null,
    microFamilyId: row.microFamilyId || null,
    microFamilyKey: row.microFamilyKey || null,
    microLabels: safeArray(row.microLabels).slice(0, 12),

    closed: row.closed,
    open: row.open,
    resultR: row.resultR,
    pnlPct: row.pnlPct,
    plannedRR: row.plannedRR,

    setupClass: row.setupClass || null,
    entryType: row.entryType || row.runnerEntryType || null,
    entryReason: row.entryReason || row.reason || row.entryType || null,
    exitReason: row.exitReason || row.reason || null,

    rsiZone: row.rsiZone || null,
    obBias: row.obBias || null,
    flow: row.flow || null,
    confluence: row.confluence ?? null,
    sniperScore: row.sniperScore ?? null,
    ts: row.ts || null,
  };
}

function addOutcomeStats(target, row, config) {
  if (row.closed) {
    target.closed += 1;
    target.totalR += row.resultR;
    target.totalPnlPct += row.pnlPct;
    target.avgMfeR += row.mfeR;
    target.avgMaeR += row.maeR;

    if (row.resultR > config.breakevenREps) {
      target.wins += 1;
      target.grossWinR += row.resultR;
    } else if (row.resultR < -config.breakevenREps) {
      target.losses += 1;
      target.grossLossR += Math.abs(row.resultR);
    } else {
      target.breakeven += 1;
    }
  }
}

function finalizeStats(target, config) {
  target.pendingOutcome = Math.max(0, target.pendingOutcome);
  target.pending = target.pendingOutcome;

  target.totalR = round(target.totalR, 3);
  target.avgR = target.closed > 0 ? round(target.totalR / target.closed, 3) : 0;

  target.totalPnlPct = round(target.totalPnlPct, 3);
  target.avgPnlPct = target.closed > 0 ? round(target.totalPnlPct / target.closed, 3) : 0;

  target.grossWinR = round(target.grossWinR, 3);
  target.grossLossR = round(target.grossLossR, 3);

  target.winrateNum = target.closed > 0 ? target.wins / target.closed : 0;
  target.winrate = pctText(target.winrateNum);

  target.profitFactor =
    target.grossLossR > 0
      ? round(target.grossWinR / target.grossLossR, 3)
      : target.grossWinR > 0
        ? round(target.grossWinR, 3)
        : 0;

  target.profitFactorR = target.profitFactor;
  target.pf = target.profitFactor;

  target.avgMfeR = target.closed > 0 ? round(target.avgMfeR / target.closed, 3) : 0;
  target.avgMaeR = target.closed > 0 ? round(target.avgMaeR / target.closed, 3) : 0;

  target.status = classifyStatus(target, config);

  target.score = round(
    target.totalPnlPct * 5 +
      target.totalR * 3 +
      target.avgR * 50 +
      target.winrateNum * 25 +
      Math.log10(Math.max(target.closed, 1)) * 8 +
      target.pf * 6,
    3
  );

  return target;
}

function classifyStatus(row, config) {
  if (row.observed <= 0) return "EMPTY";
  if (row.closed < config.minClosed) return "COLLECTING";

  if (row.totalR <= 0 || row.avgR <= 0 || row.totalPnlPct <= 0) return "BAD";

  if (
    row.closed >= Math.max(config.minClosed * 4, 40) &&
    row.totalPnlPct >= 25 &&
    row.avgR >= 0.25 &&
    row.winrateNum >= 0.48 &&
    row.pf >= 1.8
  ) {
    return "HOT";
  }

  if (
    row.winrateNum >= config.minWinrate &&
    row.avgR >= 0.1 &&
    row.pf >= 1.15
  ) {
    return "GOOD";
  }

  if (row.winrateNum >= 0.25 && row.avgR > 0 && row.totalR > 0) {
    return "STABLE";
  }

  return "BAD";
}

function rankPnlFirst(a, b) {
  const pnl = safeNumber(b.totalPnlPct, 0) - safeNumber(a.totalPnlPct, 0);
  if (pnl !== 0) return pnl;

  const totalR = safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0);
  if (totalR !== 0) return totalR;

  const avgR = safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0);
  if (avgR !== 0) return avgR;

  const pf = safeNumber(b.pf, 0) - safeNumber(a.pf, 0);
  if (pf !== 0) return pf;

  const closed = safeNumber(b.closed, 0) - safeNumber(a.closed, 0);
  if (closed !== 0) return closed;

  return String(a.id || a.microFamilyKey || "").localeCompare(String(b.id || b.microFamilyKey || ""));
}

function rankFamilyTable(a, b) {
  const statusRank = {
    HOT: 6,
    GOOD: 5,
    STABLE: 4,
    COLLECTING: 3,
    BAD: 2,
    EMPTY: 1,
  };

  const status = (statusRank[b.status] || 0) - (statusRank[a.status] || 0);
  if (status !== 0) return status;

  return rankPnlFirst(a, b);
}

function summarizeStatuses(rows) {
  const out = {
    count: safeArray(rows).length,
    total: safeArray(rows).length,
    HOT: 0,
    GOOD: 0,
    STABLE: 0,
    BAD: 0,
    COLLECTING: 0,
    EMPTY: 0,
  };

  for (const row of safeArray(rows)) {
    const status = String(row.status || "EMPTY").toUpperCase();

    if (out[status] === undefined) out[status] = 0;
    out[status] += 1;
  }

  out.text = `HOT ${out.HOT} | GOOD ${out.GOOD} | STABLE ${out.STABLE} | BAD ${out.BAD} | COLLECTING ${out.COLLECTING} | EMPTY ${out.EMPTY}`;

  return out;
}

function sourceIsPendingOutcome(row) {
  if (row?.sourceType === "FEATURE_STORE") return true;

  const status = String(row?.status || "").toUpperCase();
  if (status === "OPEN") return true;

  return false;
}

function addRowToFamily(family, row, config) {
  family.observed += 1;

  if (row.observationOnly) {
    family.observations += 1;
  }

  if (row.isTradeLike) {
    family.trades += 1;
  }

  if (row.open) {
    family.open += 1;
  }

  if (row.shadowCompleted) {
    family.shadowClosed += 1;
  }

  if (row.realClosed || row.latestClosed) {
    family.realClosed += 1;
  }

  addOutcomeStats(family, row, config);

  const pending =
    !row.closed &&
    !row.open &&
    (
      row.observationOnly ||
      sourceIsPendingOutcome(row)
    );

  if (pending) {
    family.pendingOutcome += 1;
  }

  if (row.microFamilyKey) {
    family.microFamilyKeys[row.microFamilyKey] = safeNumber(family.microFamilyKeys[row.microFamilyKey], 0) + 1;
  }

  if (family.examples.length < config.maxExamplesPerFamily) {
    family.examples.push(compactExample(row));
  }
}

function finalizeFamily(family, config) {
  family.microFamilyCount = Object.keys(family.microFamilyKeys || {}).length;
  family.topMicroFamilyKeys = Object.entries(family.microFamilyKeys || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([microFamilyKey, count]) => ({ microFamilyKey, count }));

  return finalizeStats(family, config);
}

function createMicroFamily(key, row) {
  const macroFamilyId = getFamilyId(row);
  const side = normalizeSide(row.side);

  return {
    id: key,
    microFamilyKey: key,
    microFamilyId: row.microFamilyId || null,
    familyId: macroFamilyId,
    macroFamilyId,
    side,

    definition: safeArray(row.microLabels).length
      ? safeArray(row.microLabels).join(" | ")
      : key,

    labels: safeArray(row.microLabels),

    observed: 0,
    observations: 0,
    trades: 0,
    closed: 0,
    realClosed: 0,
    shadowClosed: 0,
    open: 0,
    pending: 0,
    pendingOutcome: 0,

    wins: 0,
    losses: 0,
    breakeven: 0,

    winrateNum: 0,
    winrate: "0%",

    totalR: 0,
    avgR: 0,
    totalPnlPct: 0,
    avgPnlPct: 0,

    grossWinR: 0,
    grossLossR: 0,

    profitFactor: 0,
    profitFactorR: 0,
    pf: 0,

    avgMfeR: 0,
    avgMaeR: 0,

    status: "EMPTY",
    score: 0,

    examples: [],
  };
}

function addRowToMicroFamily(micro, row, config) {
  micro.observed += 1;

  if (row.observationOnly) micro.observations += 1;
  if (row.isTradeLike) micro.trades += 1;
  if (row.open) micro.open += 1;
  if (row.shadowCompleted) micro.shadowClosed += 1;
  if (row.realClosed || row.latestClosed) micro.realClosed += 1;

  addOutcomeStats(micro, row, config);

  const pending =
    !row.closed &&
    !row.open &&
    (
      row.observationOnly ||
      sourceIsPendingOutcome(row)
    );

  if (pending) micro.pendingOutcome += 1;

  if (micro.examples.length < config.maxExamplesPerMicroFamily) {
    micro.examples.push(compactExample(row));
  }
}

function buildMicroFamilyReport(rows, config) {
  const groups = new Map();

  for (const row of safeArray(rows)) {
    const key = getMicroFamilyKeyFromRow(row);
    if (!key) continue;

    if (!groups.has(key)) {
      groups.set(key, createMicroFamily(key, row));
    }

    addRowToMicroFamily(groups.get(key), row, config);
  }

  const all = Array.from(groups.values())
    .map(row => finalizeStats(row, config))
    .sort(rankFamilyTable);

  const long = all.filter(row => row.side === "LONG");
  const short = all.filter(row => row.side === "SHORT");

  const topPnl = all
    .filter(row => row.closed > 0)
    .sort(rankPnlFirst)
    .slice(0, 30);

  const best = all
    .filter(row => row.closed >= config.minClosed)
    .filter(row => row.avgR > 0)
    .filter(row => row.totalR > 0)
    .filter(row => row.totalPnlPct > 0)
    .filter(row => row.winrateNum >= config.minWinrate)
    .sort(rankPnlFirst)
    .slice(0, 20);

  return {
    all,
    long,
    short,
    ranked: all,
    best,
    topPnl,
    summary: {
      total: all.length,
      withClosed: all.filter(row => row.closed > 0).length,
      long: summarizeStatuses(long),
      short: summarizeStatuses(short),
    },
  };
}

// ================= REPORT BUILDING =================

function buildFilterValues() {
  return {
    trackedFields: [
      "side",
      "familyId",
      "microFamilyKey",
      "microFamilyId",
      "quality",
      "market",
      "timing",
      "setupClass",
      "entryType",
      "entryReason",
      "confluence",
      "sniperScore",
      "plannedRR",
      "score",
      "stage",
      "flow",
      "rsiZone",
      "obBias",
      "spreadPct",
      "depthMinUsd1p",
      "btcState",
      "funding",
      "tfScore",
      "tfStrength",
      "mfeR",
      "maeR",
      "source",
      "sourceType",
    ],
    qualityBuckets: Object.fromEntries(QUALITY_BUCKETS.map(row => [row.key, row])),
    marketBuckets: Object.fromEntries(MARKET_BUCKETS.map(row => [row.key, row])),
    timingBuckets: Object.fromEntries(TIMING_BUCKETS.map(row => [row.key, row])),
  };
}

function buildReport(rows, config) {
  const familySet = buildFamilySet();

  const normalized = safeArray(rows)
    .map(row => {
      const familyId = getFamilyId(row);
      if (!familyId) return null;

      return {
        ...row,
        familyId,
        macroFamilyId: familyId,
      };
    })
    .filter(Boolean);

  for (const row of normalized) {
    const family = familySet.byId.get(row.familyId);
    if (!family) continue;

    addRowToFamily(family, row, config);
  }

  const all = familySet.all.map(row => finalizeFamily(row, config));
  const long = familySet.long;
  const short = familySet.short;

  const closed = all.reduce((sum, row) => sum + row.closed, 0);
  const realClosed = all.reduce((sum, row) => sum + row.realClosed, 0);
  const shadowClosed = all.reduce((sum, row) => sum + row.shadowClosed, 0);
  const open = all.reduce((sum, row) => sum + row.open, 0);
  const pendingOutcome = all.reduce((sum, row) => sum + row.pendingOutcome, 0);

  const wins = all.reduce((sum, row) => sum + row.wins, 0);
  const losses = all.reduce((sum, row) => sum + row.losses, 0);
  const breakeven = all.reduce((sum, row) => sum + row.breakeven, 0);

  const totalR = round(all.reduce((sum, row) => sum + row.totalR, 0), 3);
  const totalPnlPct = round(all.reduce((sum, row) => sum + row.totalPnlPct, 0), 3);

  const trades = all.reduce((sum, row) => sum + row.trades, 0);
  const observations = all.reduce((sum, row) => sum + row.observations, 0);

  const longSummary = summarizeStatuses(long);
  const shortSummary = summarizeStatuses(short);

  const ranked = [...all].sort(rankFamilyTable);

  const topPnlFamilies = all
    .filter(row => row.closed > 0)
    .sort(rankPnlFirst)
    .slice(0, 25);

  const topTotalRFamilies = all
    .filter(row => row.closed > 0)
    .sort((a, b) => {
      const diff = safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0);
      if (diff !== 0) return diff;

      return rankPnlFirst(a, b);
    })
    .slice(0, 25);

  const topWinrateFamilies = all
    .filter(row => row.closed >= config.minClosed)
    .sort((a, b) => {
      const diff = safeNumber(b.winrateNum, 0) - safeNumber(a.winrateNum, 0);
      if (diff !== 0) return diff;

      return rankPnlFirst(a, b);
    })
    .slice(0, 25);

  const winnerCandidates = all
    .filter(row => row.closed >= config.minClosed)
    .filter(row => row.avgR > 0)
    .filter(row => row.totalR > 0)
    .filter(row => row.totalPnlPct > 0)
    .filter(row => row.winrateNum >= config.minWinrate)
    .sort(rankPnlFirst)
    .slice(0, 12);

  const winnerFamilies = winnerCandidates
    .filter(row => ["HOT", "GOOD", "STABLE"].includes(row.status))
    .slice(0, 8);

  const microFamilies = buildMicroFamilyReport(normalized, config);

  const summary = {
    actions: normalized.length,
    observations,
    trades,

    open,
    closed,
    realClosed,
    shadowClosed: config.includeShadow ? shadowClosed : 0,
    shadowClosedAvailable: shadowClosed,

    pendingOutcome,

    wins,
    losses,
    breakeven,

    winrateNum: closed > 0 ? wins / closed : 0,
    winrate: closed > 0 ? pctText(wins / closed) : "0%",

    totalR,
    avgR: closed > 0 ? round(totalR / closed, 3) : 0,

    totalPnlPct,
    avgPnlPct: closed > 0 ? round(totalPnlPct / closed, 3) : 0,

    longFamilies: longSummary,
    shortFamilies: shortSummary,

    familiesWithData: all.filter(row => row.observed > 0).length,
    microFamiliesWithData: microFamilies.all.length,
    microFamiliesWithClosed: microFamilies.summary.withClosed,
  };

  return {
    summary,

    diagnostics: {
      inputRows: rows.length,
      normalizedRows: normalized.length,
      rowsWithoutFamily: Math.max(0, rows.length - normalized.length),
      includeShadowInStats: config.includeShadow,
      sourceCounts: normalized.reduce((acc, row) => {
        acc[row.sourceType] = safeNumber(acc[row.sourceType], 0) + 1;
        return acc;
      }, {}),
      rowsWithMicroFamilyKey: normalized.filter(row => row.microFamilyKey).length,
    },

    config,

    families: {
      all,
      long,
      short,
      ranked,

      best: winnerCandidates,

      worst: [...all]
        .filter(row => row.closed > 0)
        .sort((a, b) => safeNumber(a.totalPnlPct, 0) - safeNumber(b.totalPnlPct, 0))
        .slice(0, 25),

      topPnl: topPnlFamilies,
      topTotalR: topTotalRFamilies,
      topWinrate: topWinrateFamilies,
    },

    microFamilies,

    filterValues: buildFilterValues(),

    familyPerformanceMatrix: {
      long: {
        total: long.length,
        summary: longSummary,
      },
      short: {
        total: short.length,
        summary: shortSummary,
      },
      micro: microFamilies.summary,
    },

    best: {
      bestLongByPnl: long.filter(row => row.closed > 0).sort(rankPnlFirst)[0] || null,
      bestShortByPnl: short.filter(row => row.closed > 0).sort(rankPnlFirst)[0] || null,
      topPnlFamily: topPnlFamilies[0] || null,
      topTotalRFamily: topTotalRFamilies[0] || null,
      topWinrateFamily: topWinrateFamilies[0] || null,
      topMicroFamilyByPnl: microFamilies.topPnl[0] || null,
    },

    winnerCandidates,
    winnerCandidateSummary: {
      count: winnerCandidates.length,
      objective: "highest_total_pnl_pct_then_total_r_avg_r_pf_sample",
      message: "Families gerankt op Total PnL%, daarna Total R, Avg R, Profit Factor en sample-size.",
    },

    winnerFamilies,
    winnerFamilySummary: {
      count: winnerFamilies.length,
      rule: "HOT/GOOD/STABLE families met voldoende closed trades, positieve Avg R, positieve Total R en minimale winrate.",
    },

    leaderboards: {
      topPnlFamilies,
      topTotalRFamilies,
      topWinrateFamilies,
      topMicroFamiliesByPnl: microFamilies.topPnl,
      bestMicroFamilies: microFamilies.best,
    },
  };
}

function normalizeSourceRows(runtime, latest, config) {
  const rows = [];

  rows.push(
    ...safeArray(runtime.closedTrades).map(row => normalizeAnalysisRow(row, "REAL_CLOSED", config)),
    ...safeArray(runtime.recentEntries).map(row => normalizeAnalysisRow(row, "RECENT_ENTRY", config)),
    ...safeArray(runtime.memoryOpen).map(row => normalizeAnalysisRow(row, "MEMORY_OPEN", config)),
    ...safeArray(runtime.featureStore).map(row => normalizeAnalysisRow(row, "FEATURE_STORE", config)),
    ...safeArray(runtime.shadowOutcomes).map(row => normalizeAnalysisRow(row, "SHADOW_OUTCOME", config)),
    ...safeArray(latest.rows).map(row => normalizeAnalysisRow(row, "LATEST", config))
  );

  return uniqueRows(rows.filter(Boolean));
}

// ================= HANDLER =================

export default async function handler(req, res) {
  const startedAt = Date.now();

  try {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Content-Type", "application/json; charset=utf-8");

    const includeLatest = normalizeBoolean(getQueryParam(req, "includeLatest", "true"), true);
    const includeShadow = normalizeBoolean(getQueryParam(req, "includeShadow", "false"), false);
    const resetRequested = normalizeBoolean(getQueryParam(req, "reset", ""), false);

    const config = {
      strategyVersion: STRATEGY_VERSION,
      minClosed: Math.max(
        0,
        Math.round(safeNumber(getQueryParam(req, "minClosed", DEFAULT_MIN_CLOSED), DEFAULT_MIN_CLOSED))
      ),
      minWinrate: safeNumber(getQueryParam(req, "minWinrate", DEFAULT_MIN_WINRATE), DEFAULT_MIN_WINRATE),
      breakevenREps: safeNumber(
        getQueryParam(req, "breakevenREps", DEFAULT_BREAKEVEN_R_EPS),
        DEFAULT_BREAKEVEN_R_EPS
      ),
      includeShadow,
      maxExamplesPerFamily: MAX_EXAMPLES_PER_FAMILY,
      maxExamplesPerMicroFamily: MAX_EXAMPLES_PER_MICRO_FAMILY,
      familyCountPerSide: 50,
      totalFamilyCount: 100,
    };

    const [runtime, latest] = await Promise.all([
      loadDurableTradeSystemRuntime(),
      loadLatestTradeSystemRows({ includeLatest }),
    ]);

    const rows = normalizeSourceRows(runtime, latest, config);
    const report = buildReport(rows, config);

    const latencyMs = Date.now() - startedAt;
    const dataState = rows.length > 0 ? "READY" : "EMPTY";

    const durableCount =
      safeArray(runtime.closedTrades).length +
      safeArray(runtime.recentEntries).length +
      safeArray(runtime.memoryOpen).length +
      safeArray(runtime.featureStore).length +
      safeArray(runtime.shadowOutcomes).length;

    return res.status(200).json({
      ok: true,

      profile: SYSTEM_PROFILE,
      scannerProfile: SYSTEM_PROFILE,
      endpoint: ENDPOINT,

      strategyVersion: STRATEGY_VERSION,
      objective: OBJECTIVE,
      strategy: STRATEGY,

      dataState,
      latencyMs,
      generatedAt: Date.now(),
      servedAt: Date.now(),

      reset: {
        requested: resetRequested,
        ignored: resetRequested,
        reason: resetRequested
          ? "analyze leest runnerTradeSystem durable runtime; reset wist geen trading-runtime"
          : null,
      },

      sources: {
        mode: "RUNNER_TRADE_SYSTEM_DURABLE_RUNTIME_PLUS_LATEST",
        storedEvents: durableCount,
        latestEvents: safeArray(latest.rows).length,
        mergedEvents: rows.length,

        runtime: {
          ok: runtime.ok,
          mode: runtime.mode,
          redisEnabled: runtime.redisEnabled,
          strategyVersion: runtime.strategyVersion || STRATEGY_VERSION,
          error: runtime.error || null,
          warning: runtime.warning || null,
          loadedAt: runtime.loadedAt,
          keys: runtime.keys || {
            runnerStore: RUNNER_RUNTIME_STORE_KEY,
            runnerMeta: RUNNER_RUNTIME_META_KEY,
            runnerChunkPrefix: RUNNER_RUNTIME_CHUNK_PREFIX,
            core: RUNTIME_CORE_KEY,
            recent: RUNTIME_RECENT_KEY,
            closedMeta: RUNTIME_CLOSED_META_KEY,
            featureMeta: RUNTIME_FEATURE_META_KEY,
            shadowMeta: RUNTIME_SHADOW_META_KEY,
          },
          counts: {
            memoryOpen: safeArray(runtime.memoryOpen).length,
            recentEntries: safeArray(runtime.recentEntries).length,
            closedTrades: safeArray(runtime.closedTrades).length,
            featureStore: safeArray(runtime.featureStore).length,
            shadowOutcomes: safeArray(runtime.shadowOutcomes).length,
          },
          meta: runtime.meta || null,
        },

        latest: {
          ok: latest.ok,
          count: safeArray(latest.rows).length,
          updatedAt: latest.updatedAt || 0,
          note: latest.note || null,
        },
      },

      report,

      source: {
        mode: runtime.mode || "RUNNER_TRADE_SYSTEM_DURABLE_RUNTIME",
        storeSource: "runner_trade_system_durable_runtime",
        redisEnabled: runtime.redisEnabled,
        strategyVersion: runtime.strategyVersion || STRATEGY_VERSION,
        path: hasRedis() ? `redis:${RUNNER_RUNTIME_META_KEY}` : "redis:disabled",
        loadedAt: runtime.loadedAt,
        keys: runtime.keys || null,
      },

      store: {
        ok: runtime.ok,
        count: durableCount,
        beforeCount: durableCount,
        trades: report.summary.trades,
        open: report.summary.open,
        closed: report.summary.closed,
        realClosed: report.summary.realClosed,
        shadowClosedAvailable: report.summary.shadowClosedAvailable,
        featureRows: safeArray(runtime.featureStore).length,
      },

      latest: {
        ok: latest.ok,
        count: safeArray(latest.rows).length,
        note: latest.note || null,
      },

      merged: {
        count: rows.length,
        source: includeLatest
          ? "runner_trade_system_durable_runtime_plus_latest"
          : "runner_trade_system_durable_runtime_only",
      },

      stats: report.summary,
      familyPerformanceMatrix: report.familyPerformanceMatrix,
      best: report.best,

      winnerCandidates: report.winnerCandidates,
      winnerCandidateSummary: report.winnerCandidateSummary,

      winnerFamilies: report.winnerFamilies,
      winnerFamilySummary: report.winnerFamilySummary,

      leaderboards: report.leaderboards,
      families: report.families,
      microFamilies: report.microFamilies,

      diagnostics: report.diagnostics,
    });
  } catch (error) {
    console.error("ANALYZE API ERROR:", error);

    return res.status(500).json({
      ok: false,
      profile: SYSTEM_PROFILE,
      endpoint: ENDPOINT,
      strategyVersion: STRATEGY_VERSION,
      error: error?.message || "analyze_failed",
      stack: process.env.NODE_ENV === "production" ? undefined : error?.stack,
      latencyMs: Date.now() - startedAt,
      servedAt: Date.now(),
    });
  }
}