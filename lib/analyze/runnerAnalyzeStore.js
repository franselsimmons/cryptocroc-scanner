// ================= RUNNER ANALYZE STORE =================
// Doel:
// - Aparte Runner analyze-store naast main.
// - Geen conflict met main Redis/file keys.
// - Redis gebruikt LIST + RPUSH batches + LTRIM.
// - ENTRY records blijven ENTRY records.
// - EXIT records worden op open ENTRY gematched via tradeId.
// - Runner closed rows zonder tradeId kunnen als synthetic closed ENTRY worden opgeslagen.
// - Same-batch ENTRY -> EXIT werkt.
// - Unmatched exits standaard genegeerd.
// - File + memory fallback blijven bestaan.

import { promises as fs } from "fs";
import path from "path";

// ================= CONFIG =================

const RUNNER_ANALYZE_REDIS_BASE_KEY =
  process.env.RUNNER_ANALYZE_REDIS_KEY ||
  "runner:analyze:store:v1";

const RUNNER_ANALYZE_REDIS_LIST_KEY =
  process.env.RUNNER_ANALYZE_REDIS_LIST_KEY ||
  `${RUNNER_ANALYZE_REDIS_BASE_KEY}:events`;

const RUNNER_ANALYZE_REDIS_META_KEY =
  process.env.RUNNER_ANALYZE_REDIS_META_KEY ||
  `${RUNNER_ANALYZE_REDIS_BASE_KEY}:meta`;

const RUNNER_ANALYZE_FILE_PATH =
  process.env.RUNNER_ANALYZE_FILE_PATH ||
  "/tmp/runner-analyze-events.json";

const MAX_STORED_EVENTS = readNumberEnv("RUNNER_ANALYZE_MAX_STORED_EVENTS", 50000);
const REDIS_RPUSH_BATCH_SIZE = readNumberEnv("RUNNER_ANALYZE_REDIS_RPUSH_BATCH_SIZE", 100);
const MEMORY_CACHE_TTL_MS = readNumberEnv("RUNNER_ANALYZE_MEMORY_CACHE_TTL_MS", 5000);

const STORE_UNMATCHED_EXITS =
  readBooleanEnv("RUNNER_ANALYZE_STORE_UNMATCHED_EXITS", false);

const SYSTEM_PROFILE = "RUNNER";

const globalStore = globalThis.__RUNNER_ANALYZE_STORE__ || {
  events: [],
  loadedAt: 0,
  lastPersistAt: 0,
};

globalThis.__RUNNER_ANALYZE_STORE__ = globalStore;

// ================= ENV HELPERS =================

function readNumberEnv(key, fallback) {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readBooleanEnv(key, fallback = false) {
  const raw = process.env[key];

  if (raw === undefined || raw === null || raw === "") return fallback;

  const v = String(raw).trim().toLowerCase();

  if (["true", "1", "yes", "y", "on"].includes(v)) return true;
  if (["false", "0", "no", "n", "off"].includes(v)) return false;

  return fallback;
}

// ================= REDIS CONFIG =================

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
    throw new Error("Redis env missing");
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });

  const json = await res.json().catch(() => null);

  if (!res.ok || json?.error) {
    throw new Error(json?.error || `Redis error ${res.status}`);
  }

  return json?.result;
}

// ================= GENERIC HELPERS =================

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function nullableNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeText(value) {
  return String(value || "").toUpperCase().trim();
}

function safeJsonParse(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "object") return value;

  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function cleanObject(object) {
  return Object.fromEntries(
    Object.entries(safeObject(object)).filter(([, value]) => {
      return value !== undefined && value !== null && value !== "";
    })
  );
}

function normalizeTimestamp(value, fallback = Date.now()) {
  if (value instanceof Date) return value.getTime();

  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;

  const parsed = Date.parse(String(value || ""));
  if (Number.isFinite(parsed)) return parsed;

  return fallback;
}

function incrementCounter(map, key) {
  const k = key || "UNKNOWN";
  map[k] = Number(map[k] || 0) + 1;
}

function trimToMax(events) {
  const rows = safeArray(events);
  if (rows.length <= MAX_STORED_EVENTS) return rows;
  return rows.slice(rows.length - MAX_STORED_EVENTS);
}

// ================= EVENT NORMALIZATION =================

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

function normalizeSide(value) {
  const s = String(value || "").toLowerCase().trim();

  if (["bull", "long", "buy"].includes(s)) return "LONG";
  if (["bear", "short", "sell"].includes(s)) return "SHORT";

  return "";
}

function getTradeId(event) {
  const direct =
    event?.tradeId ||
    event?.positionTradeId ||
    event?.positionId ||
    event?.orderId ||
    event?.clientOrderId ||
    event?.analyzeEventId ||
    event?.eventId ||
    event?.id;

  if (direct) return String(direct);

  const symbol = normalizeSymbol(event?.symbol);
  const side = normalizeSide(event?.side || event?.direction || event?.tradeSide);
  const entry = nullableNumber(event?.entry ?? event?.entryPrice ?? event?.openPrice);
  const createdAt = normalizeTimestamp(
    event?.createdAt ??
      event?.openedAt ??
      event?.entryTs ??
      event?.ts ??
      event?.timestamp,
    0
  );

  if (symbol && side && entry && createdAt > 0) {
    return `RUNNER_${symbol}_${side}_${createdAt}_${Number(entry).toPrecision(12)}`;
  }

  const closedAt = normalizeTimestamp(
    event?.closedAt ??
      event?.exitedAt ??
      event?.exitAt ??
      event?.exitTs,
    0
  );

  if (symbol && side && entry && closedAt > 0) {
    return `RUNNER_${symbol}_${side}_${closedAt}_${Number(entry).toPrecision(12)}`;
  }

  return "";
}

function getActionFields(event) {
  return [
    event?.analyzeLifecycle,
    event?.analyzeAction,
    event?.lifecycleAction,
    event?.tradeAction,
    event?.action,
    event?.event,
    event?.status,
    event?.state,
    event?.type,
  ]
    .map(normalizeText)
    .filter(Boolean);
}

function getReasonFields(event) {
  return [
    event?.reason,
    event?.exitReason,
    event?.entryType,
    event?.runnerEntryType,
  ]
    .map(normalizeText)
    .filter(Boolean);
}

function hasExplicitEntryAction(event) {
  const fields = getActionFields(event);

  return fields.some(value => {
    return (
      value === "ENTRY" ||
      value === "OPEN" ||
      value === "OPENED" ||
      value === "ENTER" ||
      value === "FILLED" ||
      value === "PLACE_ORDER" ||
      value === "OPEN_LONG" ||
      value === "OPEN_SHORT" ||
      value === "LONG_ENTRY" ||
      value === "SHORT_ENTRY" ||
      value === "RUNNER_A_BREAKOUT" ||
      value === "RUNNER_B_CONTINUATION" ||
      value === "RUNNER_C_SQUEEZE" ||
      value.includes("ENTRY") ||
      value.includes("OPEN_POSITION") ||
      value.includes("RUNNER_A") ||
      value.includes("RUNNER_B") ||
      value.includes("RUNNER_C")
    );
  });
}

function hasExplicitExitAction(event) {
  const fields = getActionFields(event);

  return fields.some(value => {
    return (
      value === "EXIT" ||
      value === "CLOSE" ||
      value === "CLOSED" ||
      value === "TP" ||
      value === "SL" ||
      value === "BE_SL" ||
      value === "TRAIL_SL" ||
      value === "STOP" ||
      value === "STOP_LOSS" ||
      value === "TAKE_PROFIT" ||
      value.includes("EXIT") ||
      value.includes("CLOSE") ||
      value.includes("TAKE_PROFIT") ||
      value.includes("STOP_LOSS")
    );
  });
}

function hasExitReasonOnly(event) {
  const fields = getReasonFields(event);

  return fields.some(value => {
    return (
      value === "TP" ||
      value === "SL" ||
      value === "BE_SL" ||
      value === "TRAIL_SL" ||
      value === "STOP" ||
      value === "STOP_LOSS" ||
      value === "TAKE_PROFIT" ||
      value.includes("EXIT") ||
      value.includes("TAKE_PROFIT") ||
      value.includes("STOP_LOSS")
    );
  });
}

function hasExitFields(event) {
  return (
    event?.closed === true ||
    event?.isClosed === true ||
    event?.exitPrice !== undefined ||
    event?.exit !== undefined ||
    event?.executionPrice !== undefined ||
    event?.closedAt ||
    event?.exitedAt ||
    event?.exitAt ||
    event?.exitTs ||
    event?.realizedR !== undefined ||
    event?.pnlR !== undefined ||
    event?.exitR !== undefined ||
    event?.resultR !== undefined ||
    event?.outcomeR !== undefined ||
    event?.pnlPct !== undefined
  );
}

function hasEntryFields(event) {
  return (
    event?.entry !== undefined ||
    event?.entryPrice !== undefined ||
    event?.openPrice !== undefined ||
    event?.sl !== undefined ||
    event?.initialSl !== undefined ||
    event?.tp !== undefined ||
    event?.rr !== undefined ||
    event?.baseRR !== undefined ||
    event?.plannedRR !== undefined ||
    event?.familyId ||
    event?.runnerFamilyId ||
    event?.analyzeFamilyId ||
    event?.analysisFamilyId ||
    event?.filterSnapshot?.familyId ||
    event?.filterSnapshot?.runnerFamilyId ||
    event?.filterSnapshot?.analyzeFamilyId
  );
}

function getLifecycleAction(event) {
  // Cruciaal:
  // - Een gesloten ENTRY-record moet ENTRY blijven.
  // - Een echte EXIT-action blijft EXIT.
  // - exitReason=TP/SL op een ENTRY mag lifecycle niet naar EXIT trekken.

  if (hasExplicitEntryAction(event)) return "ENTRY";
  if (hasExplicitExitAction(event)) return "EXIT";

  if (hasEntryFields(event) && hasExitFields(event)) return "ENTRY";

  if (hasExitFields(event) || hasExitReasonOnly(event)) return "EXIT";
  if (hasEntryFields(event)) return "ENTRY";

  return "";
}

function getRealizedR(event) {
  return nullableNumber(
    event?.realizedR ??
      event?.pnlR ??
      event?.exitR ??
      event?.resultR ??
      event?.outcomeR ??
      event?.rMultiple ??
      event?.r
  );
}

function getPnlPct(event) {
  return nullableNumber(
    event?.pnlPct ??
      event?.pnlPercent ??
      event?.realizedPnlPct ??
      event?.resultPnlPct ??
      event?.profitPct
  );
}

function compactFilterSnapshot(event) {
  const src = {
    ...safeObject(event?.filterSnapshot),
    ...safeObject(event?.filters),
    ...safeObject(event?.filterValues),
    ...safeObject(event?.analysisFilters),
  };

  const fields = [
    "familyId",
    "runnerFamilyId",
    "analyzeFamilyId",
    "analysisFamilyId",

    "side",
    "index",
    "qualityIndex",
    "marketIndex",
    "timingIndex",

    "qualityBucket",
    "marketBucket",
    "timingBucket",

    "definition",
    "source",
    "frozenAt",

    "profile",
    "runnerProfile",
    "setupClass",
    "entryType",
    "runnerEntryType",
    "grade",

    "stage",
    "scannerStage",
    "stageSource",
    "flow",
    "scannerFlow",
    "flowStrength",
    "detectedFlow",

    "confluence",
    "sniperScore",
    "sniper",
    "score",
    "moveScore",

    "rr",
    "baseRR",
    "finalRR",
    "finalRr",
    "plannedRR",
    "effectiveRR",
    "targetR",

    "runnerPressure",
    "runnerAcceleration",

    "rsi",
    "rsiHTF",
    "rsiZone",
    "rsiContinuationScore",

    "tfScore",
    "tfStrength",
    "tfAlignment",

    "obBias",
    "spreadPct",
    "spreadBps",
    "depthMinUsd1p",
    "depthUsd1p",
    "marketQuality",
    "obQualityScore",

    "btcState",
    "regime",
    "fundingRate",
    "funding",

    "structure",
    "structureAligned",

    "pullbackConfirmed",
    "sweepConfirmed",
    "retestConfirmed",

    "partialTaken",
    "breakEvenMoved",
    "trailingActive",
    "adds",

    "mfeR",
    "maeR",
    "currentR",

    "strategyVersion",
  ];

  const out = {};

  for (const field of fields) {
    const value = src[field] ?? event?.[field];

    if (value !== undefined && value !== null && value !== "") {
      out[field] = value;
    }
  }

  return cleanObject(out);
}

function compactMarket(value) {
  const market = safeObject(value);

  return cleanObject({
    trend: market.trend,
    state: market.state,
    regime: market.regime,
    bias: market.bias,
    score: market.score,
  });
}

function compactBtc(value) {
  const btc = safeObject(value);

  return cleanObject({
    state: btc.state,
    chg24: btc.chg24,
    chg1h: btc.chg1h,
  });
}

function getFamilyId(event, snapshot) {
  const familyId =
    event?.familyId ||
    event?.runnerFamilyId ||
    event?.analyzeFamilyId ||
    event?.analysisFamilyId ||
    snapshot?.familyId ||
    snapshot?.runnerFamilyId ||
    snapshot?.analyzeFamilyId ||
    null;

  return familyId ? String(familyId).toUpperCase() : null;
}

function normalizeAnalyzeEvent(event, fallbackTs = Date.now()) {
  if (!event || typeof event !== "object") return null;

  const action = getLifecycleAction(event);
  if (!action) return null;

  const symbol = normalizeSymbol(event.symbol);
  const side = normalizeSide(event.side || event.direction || event.tradeSide);

  if (!symbol || !side) return null;

  const tradeId = getTradeId(event);
  if (!tradeId) return null;

  const ts = normalizeTimestamp(
    event.analyzeTs ??
      event.ts ??
      event.timestamp ??
      event.updatedAt ??
      event.createdAt ??
      event.openedAt ??
      event.entryTs,
    fallbackTs
  );

  const entryTs = normalizeTimestamp(
    event.openedAt ??
      event.entryTs ??
      event.createdAt ??
      event.ts ??
      event.timestamp,
    ts
  );

  const isClosed = action === "EXIT"
    ? true
    : Boolean(event.closed || event.isClosed || hasExitFields(event));

  const closedAt = isClosed
    ? normalizeTimestamp(
        event.closedAt ??
          event.exitedAt ??
          event.exitAt ??
          event.exitTs ??
          event.updatedAt ??
          event.analyzeTs ??
          event.ts ??
          event.timestamp,
        ts
      )
    : null;

  const realizedR = getRealizedR(event);
  const pnlPct = getPnlPct(event);
  const snapshot = compactFilterSnapshot(event);
  const normalizedFamilyId = getFamilyId(event, snapshot);

  const exitPrice = isClosed
    ? nullableNumber(event.exitPrice ?? event.exit ?? event.executionPrice ?? event.price)
    : nullableNumber(event.exitPrice ?? event.exit);

  const entryPrice = nullableNumber(event.entryPrice ?? event.entry ?? event.openPrice);

  return cleanObject({
    profile: SYSTEM_PROFILE,
    runnerProfile: event.runnerProfile || SYSTEM_PROFILE,

    tradeId,
    symbol,
    side,

    action,
    analyzeLifecycle: action,
    analyzeSource: event.analyzeSource || "runner_trade_funnel",
    analyzeTs: ts,
    ts,

    familyId: normalizedFamilyId,
    runnerFamilyId: normalizedFamilyId,
    analyzeFamilyId: normalizedFamilyId,
    analysisFamilyId: normalizedFamilyId,

    openedAt: action === "ENTRY" ? entryTs : event.openedAt,
    entryTs: action === "ENTRY" ? entryTs : event.entryTs,

    entry: nullableNumber(event.entry ?? event.entryPrice ?? event.openPrice),
    entryPrice,
    openPrice: nullableNumber(event.openPrice ?? event.entryPrice ?? event.entry),

    sl: nullableNumber(event.sl ?? event.initialSl ?? event.stopLoss),
    initialSl: nullableNumber(event.initialSl ?? event.sl ?? event.stopLoss),
    tp: nullableNumber(event.tp ?? event.takeProfit),
    partialTp: nullableNumber(event.partialTp),
    breakevenAt: nullableNumber(event.breakevenAt),
    trailStart: nullableNumber(event.trailStart),
    trailPrice: nullableNumber(event.trailPrice),

    rr: nullableNumber(event.rr ?? event.baseRR ?? event.finalRR ?? event.finalRr ?? event.plannedRR),
    baseRR: nullableNumber(event.baseRR ?? event.rr),
    finalRR: nullableNumber(event.finalRR ?? event.finalRr),
    plannedRR: nullableNumber(event.plannedRR ?? event.rr),
    targetR: nullableNumber(event.targetR),

    closed: isClosed,
    closedAt,

    exitPrice,
    exit: isClosed
      ? nullableNumber(event.exit ?? event.exitPrice ?? event.executionPrice ?? event.price)
      : nullableNumber(event.exit),

    realizedR,
    pnlR: realizedR,
    exitR: realizedR,
    resultR: realizedR,
    outcomeR: realizedR,
    rMultiple: realizedR,
    pnlPct,

    exitReason: event.exitReason || event.reason || null,

    setupClass: event.setupClass,
    entryType: event.entryType || event.runnerEntryType,
    runnerEntryType: event.runnerEntryType || event.entryType,
    grade: event.grade,

    confluence: nullableNumber(event.confluence),
    sniperScore: nullableNumber(event.sniperScore),
    sniper: event.sniper,

    moveScore: nullableNumber(event.moveScore ?? event.score ?? event.tradeScore),
    score: nullableNumber(event.score ?? event.moveScore ?? event.tradeScore),

    stage: event.stage,
    scannerStage: event.scannerStage,
    stageSource: event.stageSource,

    flow: event.flow,
    scannerFlow: event.scannerFlow,
    flowStrength: event.flowStrength,
    detectedFlow: event.detectedFlow,

    runnerPressure: nullableNumber(event.runnerPressure),
    runnerAcceleration: nullableNumber(event.runnerAcceleration),

    rsi: nullableNumber(event.rsi),
    rsiHTF: nullableNumber(event.rsiHTF),
    rsiZone: event.rsiZone,
    rsiContinuationScore: nullableNumber(event.rsiContinuationScore),

    obBias: event.obBias,
    spreadPct: nullableNumber(event.spreadPct),
    spreadBps: nullableNumber(event.spreadBps),
    depthMinUsd1p: nullableNumber(event.depthMinUsd1p ?? event.depthUsd1p),
    marketQuality: event.marketQuality,
    obQualityScore: nullableNumber(event.obQualityScore),

    btcState: event.btcState ?? event.btc?.state,
    fundingRate: nullableNumber(event.fundingRate ?? event.funding),
    funding: event.funding,

    tfScore: nullableNumber(event.tfScore),
    tfStrength: nullableNumber(event.tfStrength),
    tfAlignment: event.tfAlignment,

    regime: event.regime,
    volatility: event.volatility,
    structure: event.structure,
    structureAligned: event.structureAligned,

    partialTaken: Boolean(event.partialTaken),
    breakEvenMoved: Boolean(event.breakEvenMoved),
    trailingActive: Boolean(event.trailingActive),
    adds: nullableNumber(event.adds),

    currentR: nullableNumber(event.currentR),
    mfeR: nullableNumber(event.mfeR),
    maeR: nullableNumber(event.maeR),

    market: compactMarket(event.market),
    btc: compactBtc(event.btc),

    strategyVersion: event.strategyVersion,
    syntheticAnalyzeEntry: Boolean(event.syntheticAnalyzeEntry),

    filterSnapshot: cleanObject({
      ...snapshot,
      familyId: normalizedFamilyId || snapshot.familyId,
      runnerFamilyId: normalizedFamilyId || snapshot.runnerFamilyId,
      analyzeFamilyId: normalizedFamilyId || snapshot.analyzeFamilyId,
      entryType: event.entryType || event.runnerEntryType || snapshot.entryType,
      runnerEntryType: event.runnerEntryType || event.entryType || snapshot.runnerEntryType,
      setupClass: event.setupClass || snapshot.setupClass,
      flow: event.flow || snapshot.flow,
      scannerFlow: event.scannerFlow || snapshot.scannerFlow,
    }),

    storedAt: event.storedAt,
    updatedAt: event.updatedAt,
  });
}

function isSameTradeEntry(a, b) {
  return (
    String(a?.tradeId || "") === String(b?.tradeId || "") &&
    getLifecycleAction(a) === "ENTRY" &&
    getLifecycleAction(b) === "ENTRY"
  );
}

function buildEventKey(event) {
  const tradeId = getTradeId(event);
  const action = getLifecycleAction(event);

  if (!tradeId || !action) return "";

  const ts =
    event.closedAt ||
    event.exitedAt ||
    event.exitAt ||
    event.exitTs ||
    event.openedAt ||
    event.entryTs ||
    event.analyzeTs ||
    event.ts ||
    "";

  const r =
    event.realizedR ??
    event.pnlR ??
    event.exitR ??
    event.resultR ??
    event.outcomeR ??
    "";

  return `${tradeId}:${action}:${ts}:${r}`;
}

function buildIndexes(records) {
  const entryByTradeId = new Map();
  const openByTradeId = new Map();
  const eventKeySet = new Set();

  for (const record of safeArray(records)) {
    const tradeId = getTradeId(record);
    if (!tradeId) continue;

    const action = getLifecycleAction(record);
    const key = buildEventKey(record);

    if (key) eventKeySet.add(key);

    if (action !== "ENTRY") continue;

    entryByTradeId.set(tradeId, record);

    if (record.closed !== true) {
      openByTradeId.set(tradeId, record);
    }
  }

  return {
    entryByTradeId,
    openByTradeId,
    eventKeySet,
  };
}

function mergeExitIntoEntry(entry, exit) {
  const closedAt = normalizeTimestamp(
    exit.closedAt ??
      exit.exitedAt ??
      exit.exitAt ??
      exit.exitTs ??
      exit.analyzeTs ??
      exit.ts,
    Date.now()
  );

  const realizedR = getRealizedR(exit);
  const pnlPct = getPnlPct(exit);

  entry.action = "ENTRY";
  entry.analyzeLifecycle = "ENTRY";

  entry.closed = true;
  entry.closedAt = closedAt;

  entry.exitPrice = nullableNumber(
    exit.exitPrice ??
      exit.exit ??
      exit.executionPrice ??
      exit.price
  );

  entry.exit = nullableNumber(
    exit.exit ??
      exit.exitPrice ??
      exit.executionPrice ??
      exit.price
  );

  entry.realizedR = realizedR;
  entry.pnlR = realizedR;
  entry.exitR = realizedR;
  entry.resultR = realizedR;
  entry.outcomeR = realizedR;
  entry.rMultiple = realizedR;
  entry.pnlPct = pnlPct;

  entry.exitReason = exit.exitReason || exit.reason || entry.exitReason || null;

  entry.currentR = nullableNumber(exit.currentR ?? entry.currentR);
  entry.mfeR = nullableNumber(exit.mfeR ?? entry.mfeR);
  entry.maeR = nullableNumber(exit.maeR ?? entry.maeR);

  entry.partialTaken = Boolean(exit.partialTaken ?? entry.partialTaken);
  entry.breakEvenMoved = Boolean(exit.breakEvenMoved ?? entry.breakEvenMoved);
  entry.trailingActive = Boolean(exit.trailingActive ?? entry.trailingActive);
  entry.adds = nullableNumber(exit.adds ?? entry.adds);

  entry.lastExitTs = exit.analyzeTs || exit.ts || closedAt;
  entry.updatedAt = Date.now();

  return entry;
}

function convertExitToSyntheticClosedEntry(exit) {
  return {
    ...exit,
    action: "ENTRY",
    analyzeLifecycle: "ENTRY",
    closed: true,
    syntheticAnalyzeEntry: true,
    storedAt: exit.storedAt || Date.now(),
    updatedAt: Date.now(),
    filterSnapshot: cleanObject({
      ...safeObject(exit.filterSnapshot),
      syntheticAnalyzeEntry: true,
    }),
  };
}

// ================= LOAD SOURCES =================

async function loadFromRedis() {
  if (!hasRedis()) {
    return {
      ok: false,
      source: "redis",
      key: RUNNER_ANALYZE_REDIS_LIST_KEY,
      error: "redis_env_missing",
      events: [],
    };
  }

  try {
    const result = await redisCommand([
      "LRANGE",
      RUNNER_ANALYZE_REDIS_LIST_KEY,
      0,
      -1,
    ]);

    const rows = safeArray(result)
      .map(item => safeJsonParse(item, null))
      .filter(Boolean)
      .map(item => normalizeAnalyzeEvent(item, Date.now()))
      .filter(Boolean);

    if (rows.length > 0) {
      return {
        ok: true,
        source: "redis",
        key: RUNNER_ANALYZE_REDIS_LIST_KEY,
        error: null,
        events: rows,
      };
    }

    const legacy = await redisCommand([
      "GET",
      RUNNER_ANALYZE_REDIS_BASE_KEY,
    ]).catch(() => null);

    const parsed = safeJsonParse(legacy, null);
    const legacyRows = Array.isArray(parsed)
      ? parsed
      : safeArray(parsed?.events || parsed?.records || parsed?.data);

    const normalizedLegacy = legacyRows
      .map(item => normalizeAnalyzeEvent(item, Date.now()))
      .filter(Boolean);

    return {
      ok: true,
      source: "redis",
      key: RUNNER_ANALYZE_REDIS_LIST_KEY,
      legacyKey: RUNNER_ANALYZE_REDIS_BASE_KEY,
      error: null,
      events: normalizedLegacy,
    };
  } catch (e) {
    return {
      ok: false,
      source: "redis",
      key: RUNNER_ANALYZE_REDIS_LIST_KEY,
      error: e?.message || "redis_load_failed",
      events: [],
    };
  }
}

async function loadFromFile() {
  try {
    const raw = await fs.readFile(RUNNER_ANALYZE_FILE_PATH, "utf8");
    const parsed = safeJsonParse(raw, []);

    const rows = Array.isArray(parsed)
      ? parsed
      : safeArray(parsed?.events || parsed?.records || parsed?.data);

    const normalized = rows
      .map(item => normalizeAnalyzeEvent(item, Date.now()))
      .filter(Boolean);

    return {
      ok: true,
      source: "file",
      path: RUNNER_ANALYZE_FILE_PATH,
      error: null,
      events: normalized,
    };
  } catch (e) {
    return {
      ok: false,
      source: "file",
      path: RUNNER_ANALYZE_FILE_PATH,
      error: e?.message || "file_load_failed",
      events: [],
    };
  }
}

// ================= READERS =================

export async function loadRunnerAnalyzeEvents(options = {}) {
  const force = Boolean(options.force);
  const now = Date.now();

  if (
    !force &&
    globalStore.events.length > 0 &&
    now - Number(globalStore.loadedAt || 0) < MEMORY_CACHE_TTL_MS
  ) {
    return globalStore.events;
  }

  const redis = await loadFromRedis();

  if (redis.ok && redis.events.length > 0) {
    globalStore.events = trimToMax(redis.events);
    globalStore.loadedAt = now;
    return globalStore.events;
  }

  const file = await loadFromFile();

  if (file.ok && file.events.length > 0) {
    globalStore.events = trimToMax(file.events);
    globalStore.loadedAt = now;
    return globalStore.events;
  }

  globalStore.loadedAt = now;
  return globalStore.events || [];
}

export async function readRunnerAnalyzeEvents(options = {}) {
  return await loadRunnerAnalyzeEvents(options);
}

export async function getRunnerAnalyzeEvents(options = {}) {
  return await loadRunnerAnalyzeEvents(options);
}

export async function loadRunnerAnalyzeStore(options = {}) {
  const events = await loadRunnerAnalyzeEvents(options);

  const open = events.filter(row => {
    return getLifecycleAction(row) === "ENTRY" && row.closed !== true;
  }).length;

  const closed = events.filter(row => {
    return getLifecycleAction(row) === "ENTRY" && row.closed === true;
  }).length;

  return {
    ok: true,
    profile: SYSTEM_PROFILE,
    source: "runner_analyze_store",
    redisKey: RUNNER_ANALYZE_REDIS_LIST_KEY,
    legacyRedisKey: RUNNER_ANALYZE_REDIS_BASE_KEY,
    path: RUNNER_ANALYZE_FILE_PATH,
    count: events.length,
    trades: events.length,
    open,
    closed,
    unmatchedExits: events.filter(row => row.orphanExit === true).length,
    maxStoredEvents: MAX_STORED_EVENTS,
    redisEnabled: hasRedis(),
    fileEnabled: true,
    loadedAt: globalStore.loadedAt,
    lastPersistAt: globalStore.lastPersistAt,
    events,
  };
}

// Main-compatible aliases.
export async function loadAnalyzeEvents(options = {}) {
  return await loadRunnerAnalyzeEvents(options);
}

export async function readAnalyzeEvents(options = {}) {
  return await loadRunnerAnalyzeEvents(options);
}

export async function getAnalyzeEvents(options = {}) {
  return await loadRunnerAnalyzeEvents(options);
}

export async function loadAnalyzeStore(options = {}) {
  return await loadRunnerAnalyzeStore(options);
}

// ================= PERSIST =================

async function persistToRedis(events) {
  if (!hasRedis()) {
    return {
      ok: false,
      source: "redis",
      key: RUNNER_ANALYZE_REDIS_LIST_KEY,
      error: "redis_env_missing",
    };
  }

  try {
    const rows = trimToMax(events).map(event => JSON.stringify(event));

    await redisCommand([
      "DEL",
      RUNNER_ANALYZE_REDIS_LIST_KEY,
    ]);

    for (let i = 0; i < rows.length; i += REDIS_RPUSH_BATCH_SIZE) {
      const batch = rows.slice(i, i + REDIS_RPUSH_BATCH_SIZE);
      if (!batch.length) continue;

      await redisCommand([
        "RPUSH",
        RUNNER_ANALYZE_REDIS_LIST_KEY,
        ...batch,
      ]);
    }

    await redisCommand([
      "LTRIM",
      RUNNER_ANALYZE_REDIS_LIST_KEY,
      -MAX_STORED_EVENTS,
      -1,
    ]);

    await redisCommand([
      "SET",
      RUNNER_ANALYZE_REDIS_META_KEY,
      JSON.stringify({
        profile: SYSTEM_PROFILE,
        key: RUNNER_ANALYZE_REDIS_LIST_KEY,
        count: rows.length,
        maxStoredEvents: MAX_STORED_EVENTS,
        persistedAt: Date.now(),
        mode: "redis_list",
      }),
    ]);

    return {
      ok: true,
      source: "redis",
      key: RUNNER_ANALYZE_REDIS_LIST_KEY,
      error: null,
      count: rows.length,
      mode: "redis_list",
    };
  } catch (e) {
    return {
      ok: false,
      source: "redis",
      key: RUNNER_ANALYZE_REDIS_LIST_KEY,
      error: e?.message || "redis_persist_failed",
    };
  }
}

async function persistToFile(events) {
  try {
    await fs.mkdir(path.dirname(RUNNER_ANALYZE_FILE_PATH), {
      recursive: true,
    });

    await fs.writeFile(
      RUNNER_ANALYZE_FILE_PATH,
      JSON.stringify(trimToMax(events)),
      "utf8"
    );

    return {
      ok: true,
      source: "file",
      path: RUNNER_ANALYZE_FILE_PATH,
      error: null,
    };
  } catch (e) {
    return {
      ok: false,
      source: "file",
      path: RUNNER_ANALYZE_FILE_PATH,
      error: e?.message || "file_persist_failed",
    };
  }
}

async function persistEvents(events) {
  const trimmed = trimToMax(events);

  globalStore.events = trimmed;
  globalStore.lastPersistAt = Date.now();

  const [redis, file] = await Promise.all([
    persistToRedis(trimmed),
    persistToFile(trimmed),
  ]);

  return {
    redis,
    file,
    memory: {
      ok: true,
      source: "memory",
      error: null,
      count: trimmed.length,
    },
  };
}

// ================= APPEND =================

export async function appendRunnerAnalyzeEvents(events, context = {}) {
  const received = safeArray(events);
  const now = Date.now();

  const existing = await loadRunnerAnalyzeEvents({
    force: true,
  });

  const records = safeArray(existing)
    .map(item => normalizeAnalyzeEvent(item, now))
    .filter(Boolean);

  const indexes = buildIndexes(records);

  const ignoredReasons = {};
  let addedEntries = 0;
  let matchedExits = 0;
  let unmatchedExits = 0;
  let newUnmatchedExits = 0;
  let syntheticClosedEntries = 0;
  let ignored = 0;

  for (const rawEvent of received) {
    const event = normalizeAnalyzeEvent(
      {
        ...rawEvent,

        profile: SYSTEM_PROFILE,
        runnerProfile: rawEvent?.runnerProfile || SYSTEM_PROFILE,

        analyzeSource:
          rawEvent?.analyzeSource ||
          context?.source ||
          "runner_trade_funnel",

        btc: rawEvent?.btc ?? context?.btc,
        regime: rawEvent?.regime ?? context?.regime,
        market: rawEvent?.market ?? context?.market,

        tradeFunnelUpdatedAt:
          rawEvent?.tradeFunnelUpdatedAt ??
          context?.tradeFunnelUpdatedAt,

        latestUpdatedAt:
          rawEvent?.latestUpdatedAt ??
          context?.latestUpdatedAt,
      },
      now
    );

    if (!event) {
      ignored++;
      incrementCounter(ignoredReasons, "NORMALIZE_FAILED");
      continue;
    }

    const action = getLifecycleAction(event);
    const tradeId = getTradeId(event);

    if (!tradeId || !action) {
      ignored++;
      incrementCounter(ignoredReasons, "BAD_EVENT");
      continue;
    }

    const eventKey = buildEventKey(event);

    if (eventKey && indexes.eventKeySet.has(eventKey)) {
      ignored++;
      incrementCounter(ignoredReasons, "DUPLICATE_EVENT");
      continue;
    }

    if (action === "ENTRY") {
      const existingEntry = indexes.entryByTradeId.get(tradeId);

      if (existingEntry && isSameTradeEntry(existingEntry, event)) {
        ignored++;
        incrementCounter(ignoredReasons, "DUPLICATE_ENTRY");
        continue;
      }

      const storedEntry = {
        ...event,
        action: "ENTRY",
        analyzeLifecycle: "ENTRY",

        closed: Boolean(event.closed),
        closedAt: event.closed ? event.closedAt : null,

        exitPrice: event.closed ? event.exitPrice : null,
        exit: event.closed ? event.exit : null,

        realizedR: event.closed ? event.realizedR : null,
        pnlR: event.closed ? event.pnlR : null,
        exitR: event.closed ? event.exitR : null,
        resultR: event.closed ? event.resultR : null,
        outcomeR: event.closed ? event.outcomeR : null,
        rMultiple: event.closed ? event.rMultiple : null,
        pnlPct: event.closed ? event.pnlPct : null,

        storedAt: now,
        updatedAt: now,
      };

      records.push(storedEntry);

      indexes.entryByTradeId.set(tradeId, storedEntry);

      if (storedEntry.closed !== true) {
        indexes.openByTradeId.set(tradeId, storedEntry);
      }

      if (eventKey) indexes.eventKeySet.add(eventKey);

      addedEntries++;
      continue;
    }

    if (action === "EXIT") {
      const openEntry = indexes.openByTradeId.get(tradeId);

      if (openEntry) {
        mergeExitIntoEntry(openEntry, event);
        indexes.openByTradeId.delete(tradeId);

        if (eventKey) indexes.eventKeySet.add(eventKey);

        matchedExits++;
        continue;
      }

      unmatchedExits++;

      // Runner fix:
      // Veel runner history komt als closed row zonder eerdere stored ENTRY.
      // Als er entry/sl/tp/outcome in zit, bewaren we hem als closed ENTRY.
      if (hasEntryFields(event) && hasExitFields(event)) {
        const syntheticEntry = convertExitToSyntheticClosedEntry(event);

        records.push(syntheticEntry);

        indexes.entryByTradeId.set(tradeId, syntheticEntry);

        if (eventKey) indexes.eventKeySet.add(eventKey);

        syntheticClosedEntries++;
        continue;
      }

      if (!STORE_UNMATCHED_EXITS) {
        ignored++;
        incrementCounter(ignoredReasons, "UNMATCHED_EXIT");
        continue;
      }

      const orphanExit = {
        ...event,
        action: "EXIT",
        analyzeLifecycle: "EXIT",
        orphanExit: true,
        storedAt: now,
        updatedAt: now,
      };

      records.push(orphanExit);

      if (eventKey) indexes.eventKeySet.add(eventKey);

      newUnmatchedExits++;
      continue;
    }

    ignored++;
    incrementCounter(ignoredReasons, "UNKNOWN_ACTION");
  }

  const finalRecords = trimToMax(records);
  const persist = await persistEvents(finalRecords);

  const added = addedEntries + matchedExits + newUnmatchedExits + syntheticClosedEntries;

  const closed = finalRecords.filter(row => {
    return getLifecycleAction(row) === "ENTRY" && row.closed === true;
  }).length;

  const open = finalRecords.filter(row => {
    return getLifecycleAction(row) === "ENTRY" && row.closed !== true;
  }).length;

  return {
    ok: true,
    profile: SYSTEM_PROFILE,
    path: RUNNER_ANALYZE_FILE_PATH,
    redisKey: RUNNER_ANALYZE_REDIS_LIST_KEY,

    added,
    accepted: added,
    ignored,
    ignoredReasons,

    entries: addedEntries,
    syntheticClosedEntries,

    exits: matchedExits + newUnmatchedExits,
    matchedExits,
    unmatchedExits,
    newUnmatchedExits,

    count: finalRecords.length,
    totalRecords: finalRecords.length,
    open,
    closed,

    maxStoredEvents: MAX_STORED_EVENTS,
    persist,
  };
}

// Main-compatible alias.
export async function appendAnalyzeEvents(events, context = {}) {
  return await appendRunnerAnalyzeEvents(events, context);
}

// ================= CLEAR =================

export async function clearRunnerAnalyzeEvents() {
  globalStore.events = [];
  globalStore.loadedAt = 0;
  globalStore.lastPersistAt = 0;

  const result = {
    ok: true,
    profile: SYSTEM_PROFILE,
    redis: null,
    file: null,
    memory: {
      ok: true,
      source: "memory",
    },
  };

  if (hasRedis()) {
    try {
      await redisCommand([
        "DEL",
        RUNNER_ANALYZE_REDIS_LIST_KEY,
      ]);

      await redisCommand([
        "DEL",
        RUNNER_ANALYZE_REDIS_META_KEY,
      ]);

      await redisCommand([
        "DEL",
        RUNNER_ANALYZE_REDIS_BASE_KEY,
      ]).catch(() => null);

      result.redis = {
        ok: true,
        source: "redis",
        key: RUNNER_ANALYZE_REDIS_LIST_KEY,
      };
    } catch (e) {
      result.redis = {
        ok: false,
        source: "redis",
        key: RUNNER_ANALYZE_REDIS_LIST_KEY,
        error: e?.message || "redis_clear_failed",
      };
    }
  }

  try {
    await fs.unlink(RUNNER_ANALYZE_FILE_PATH);

    result.file = {
      ok: true,
      source: "file",
      path: RUNNER_ANALYZE_FILE_PATH,
    };
  } catch (e) {
    result.file = {
      ok: false,
      source: "file",
      path: RUNNER_ANALYZE_FILE_PATH,
      error: e?.message || "file_clear_failed",
    };
  }

  return result;
}

// Main-compatible alias.
export async function clearAnalyzeEvents() {
  return await clearRunnerAnalyzeEvents();
}

export async function resetRunnerAnalyzeEvents() {
  return await clearRunnerAnalyzeEvents();
}

export async function resetAnalyzeEvents() {
  return await clearRunnerAnalyzeEvents();
}

// ================= STATUS =================

export async function getRunnerAnalyzeStoreStatus() {
  const events = await loadRunnerAnalyzeEvents();

  const open = events.filter(row => {
    return getLifecycleAction(row) === "ENTRY" && row.closed !== true;
  }).length;

  const closed = events.filter(row => {
    return getLifecycleAction(row) === "ENTRY" && row.closed === true;
  }).length;

  return {
    ok: true,
    profile: SYSTEM_PROFILE,
    redisKey: RUNNER_ANALYZE_REDIS_LIST_KEY,
    legacyRedisKey: RUNNER_ANALYZE_REDIS_BASE_KEY,
    path: RUNNER_ANALYZE_FILE_PATH,
    count: events.length,
    open,
    closed,
    maxStoredEvents: MAX_STORED_EVENTS,
    loadedAt: globalStore.loadedAt,
    lastPersistAt: globalStore.lastPersistAt,
  };
}

// Main-compatible alias.
export async function getAnalyzeStoreStatus() {
  return await getRunnerAnalyzeStoreStatus();
}

export default {
  appendRunnerAnalyzeEvents,
  loadRunnerAnalyzeEvents,
  readRunnerAnalyzeEvents,
  getRunnerAnalyzeEvents,
  loadRunnerAnalyzeStore,
  clearRunnerAnalyzeEvents,
  resetRunnerAnalyzeEvents,
  getRunnerAnalyzeStoreStatus,

  // Main-compatible names.
  appendAnalyzeEvents,
  loadAnalyzeEvents,
  readAnalyzeEvents,
  getAnalyzeEvents,
  loadAnalyzeStore,
  clearAnalyzeEvents,
  resetAnalyzeEvents,
  getAnalyzeStoreStatus,
};