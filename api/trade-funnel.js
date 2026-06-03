import { getLatestScan, setLatestScan } from "../lib/scanStore.js";
import { processTrades } from "../lib/tradeSystem.js";

import {
  appendRunnerAnalyzeEvents,
} from "../lib/analyze/runnerAnalyzeStore.js";

export const config = {
  api: {
    bodyParser: true,
    responseLimit: false,
  },
};

const SYSTEM_PROFILE = "RUNNER";

const MAX_STORED_ENTRY_ROWS = 250;
const MAX_STORED_REJECT_ROWS = 500;
const MAX_STORED_TRADE_ROWS = 500;

// Dashboard/history. Mag gecapt worden.
const MAX_STORED_ACTIONS = readNumberEnv("TRADE_FUNNEL_MAX_STORED_ACTIONS", 750);

// Live state. Niet op 100 cappen, anders vergeet runner posities en opent hij elke scan opnieuw.
const MAX_STORED_OPEN_POSITIONS = readNumberEnv(
  "TRADE_FUNNEL_MAX_STORED_OPEN_POSITIONS",
  2500
);

const MAX_SYMBOL_LOGS = 80;

const RUNNER_ANALYZE_PERSIST =
  String(process.env.RUNNER_ANALYZE_PERSIST || "true").toLowerCase() !== "false";

const RUNNER_FLOWS = new Set([
  "SQUEEZE",
  "RUNNING",
  "BREAKOUT",
  "BUILDING",
]);

// ================= ROUTE TRACE CONFIG =================

function readNumberEnv(key, fallback) {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envFlag(name, fallback = false) {
  const raw = process.env[name];

  if (raw === undefined || raw === null || raw === "") return fallback;

  const value = String(raw).trim().toLowerCase();

  if (["true", "1", "yes", "y", "on"].includes(value)) return true;
  if (["false", "0", "no", "n", "off"].includes(value)) return false;

  return fallback;
}

const TRADE_FUNNEL_ROUTE_LOG = envFlag("TRADE_FUNNEL_ROUTE_LOG", true);
const TRADE_FUNNEL_ROUTE_DEBUG =
  envFlag("TRADE_FUNNEL_ROUTE_DEBUG", false) ||
  envFlag("RUNNER_DEBUG", false);

const RUNNER_AUTO_RUN = envFlag("RUNNER_AUTO_RUN", true);

function compactRouteLogValue(value, depth = 0) {
  if (depth > 4) return "[depth_limit]";
  if (value === undefined) return undefined;
  if (value === null) return null;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return 0;
    return Number(value.toFixed(6));
  }

  if (typeof value === "string") {
    if (value.length <= 450) return value;
    return `${value.slice(0, 450)}…`;
  }

  if (typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    return value.slice(0, 30).map(v => compactRouteLogValue(v, depth + 1));
  }

  if (typeof value === "object") {
    const out = {};

    for (const [key, val] of Object.entries(value)) {
      const compacted = compactRouteLogValue(val, depth + 1);
      if (compacted !== undefined) out[key] = compacted;
    }

    return out;
  }

  return String(value);
}

function routeLog(tag, payload = {}) {
  if (!TRADE_FUNNEL_ROUTE_LOG) return;

  console.log(JSON.stringify(compactRouteLogValue({
    app: "TRADE_FUNNEL_ROUTE",
    profile: SYSTEM_PROFILE,
    level: "info",
    tag,
    ts: Date.now(),
    iso: new Date().toISOString(),
    vercelRegion: process.env.VERCEL_REGION || null,
    vercelEnv: process.env.VERCEL_ENV || process.env.NODE_ENV || null,
    ...payload,
  })));
}

function routeDebug(tag, payload = {}) {
  if (!TRADE_FUNNEL_ROUTE_DEBUG) return;
  routeLog(tag, payload);
}

function routeError(tag, error, payload = {}) {
  console.error(JSON.stringify(compactRouteLogValue({
    app: "TRADE_FUNNEL_ROUTE",
    profile: SYSTEM_PROFILE,
    level: "error",
    tag,
    ts: Date.now(),
    iso: new Date().toISOString(),
    vercelRegion: process.env.VERCEL_REGION || null,
    vercelEnv: process.env.VERCEL_ENV || process.env.NODE_ENV || null,
    error: error?.message || String(error || "unknown_error"),
    stack: TRADE_FUNNEL_ROUTE_DEBUG ? error?.stack : undefined,
    ...payload,
  })));
}

function setNoStoreHeaders(res, requestId = null) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");

  if (requestId) {
    res.setHeader("X-Request-Id", requestId);
  }
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

function safeNumber(value, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback;

  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function nullableNumber(value) {
  if (value === undefined || value === null || value === "") return null;

  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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

function getBodyValue(req, key, fallback = "") {
  const body = req?.body;

  if (!body || typeof body !== "object") return fallback;

  const value = body[key];

  if (value === undefined || value === null) return fallback;

  return value;
}

function normalizeAction(req) {
  return String(
    getQueryParam(req, "action", "") ||
      getBodyValue(req, "action", "") ||
      ""
  )
    .trim()
    .toLowerCase();
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;

  const v = String(value).trim().toLowerCase();

  if (["true", "1", "yes", "y", "on"].includes(v)) return true;
  if (["false", "0", "no", "n", "off"].includes(v)) return false;

  return fallback;
}

function normalizeNotify(value, fallback = true) {
  return normalizeBoolean(value, fallback);
}

function normalizeStore(value, fallback = true) {
  return normalizeBoolean(value, fallback);
}

function incrementCounter(map, key) {
  const k = String(key || "UNKNOWN").toUpperCase();
  map[k] = safeNumber(map[k], 0) + 1;
}

function normalizeCounterMap(map) {
  const out = {};

  for (const [key, value] of Object.entries(map || {})) {
    const n = Math.round(Number(value || 0));
    if (n > 0) out[String(key)] = n;
  }

  return out;
}

function stageRank(stage) {
  const s = String(stage || "").toLowerCase();

  if (s === "entry") return 3;
  if (s === "almost") return 2;
  if (s === "buildup") return 1;

  return 0;
}

function flowRank(flow) {
  const f = String(flow || "").toUpperCase();

  if (f === "SQUEEZE") return 4;
  if (f === "RUNNING") return 3;
  if (f === "BREAKOUT") return 2;
  if (f === "BUILDING") return 1;

  return 0;
}

function normalizeSide(value) {
  const s = String(value || "").toLowerCase().trim();

  if (s === "bull" || s === "long" || s === "buy") return "bull";
  if (s === "bear" || s === "short" || s === "sell") return "bear";

  return "";
}

function normalizeAnalyzeSide(value) {
  const side = normalizeSide(value);

  if (side === "bull") return "LONG";
  if (side === "bear") return "SHORT";

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

function normalizeText(value) {
  return String(value || "").toUpperCase().trim();
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }

  return undefined;
}

function getStableEntryPrice(row) {
  return nullableNumber(row?.entry ?? row?.entryPrice ?? row?.openPrice);
}

function buildAnalyzeStableTradeId(row) {
  const symbol = normalizeSymbol(row?.symbol);
  const side = normalizeAnalyzeSide(row?.side);
  const entry = getStableEntryPrice(row);

  if (!symbol || !side || entry === null) return "";

  return `RUNNER_${symbol}_${side}_${Number(entry).toPrecision(12)}`;
}

function buildDedupeKey(row) {
  const action = normalizeText(row?.action || row?.analyzeLifecycle || row?.status);
  const stableTradeId = buildAnalyzeStableTradeId(row);

  return [
    stableTradeId,
    normalizeSymbol(row?.symbol),
    normalizeSide(row?.side),
    action,
    row?.exit ?? row?.exitPrice ?? row?.executionPrice ?? "",
    row?.exitR ?? row?.realizedR ?? row?.pnlR ?? row?.resultR ?? "",
    row?.closedAt ?? row?.exitedAt ?? row?.exitTs ?? row?.ts ?? "",
  ].join("|");
}

function createRequestId(prefix = "trade_funnel") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function isSnapshotAction(action) {
  return [
    "read",
    "readonly",
    "read_only",
    "snapshot",
    "status",
    "state",
    "latest",
  ].includes(String(action || "").toLowerCase());
}

function shouldRunRequest(req) {
  const action = normalizeAction(req);
  const runValue = firstDefined(
    getQueryParam(req, "run", undefined),
    getBodyValue(req, "run", undefined)
  );

  if (isSnapshotAction(action)) return false;
  if (action === "run" || action === "execute") return true;

  return normalizeBoolean(runValue, RUNNER_AUTO_RUN);
}

function compactActionForLog(row) {
  return {
    symbol: normalizeSymbol(row?.symbol),
    side: normalizeSide(row?.side),
    action: normalizeText(row?.action),
    reason: row?.reason || null,

    familyId: row?.familyId || null,
    runnerFamilyId: row?.runnerFamilyId || row?.familyId || null,
    analyzeFamilyId: row?.analyzeFamilyId || row?.familyId || null,
    discordFamilyId: row?.discordFamilyId || null,

    setupClass: row?.setupClass || null,
    entryType: row?.entryType || row?.runnerEntryType || null,
    grade: row?.grade || null,

    rr: row?.rr ?? row?.plannedRR ?? null,
    entry: row?.entry ?? null,
    sl: row?.sl ?? null,
    tp: row?.tp ?? null,

    exit: row?.exit ?? row?.exitPrice ?? row?.executionPrice ?? null,
    exitR: row?.exitR ?? row?.realizedR ?? row?.pnlR ?? row?.resultR ?? null,
    pnlPct: row?.pnlPct ?? null,

    confluence: row?.confluence ?? null,
    sniperScore: row?.sniperScore ?? null,
    score: row?.score ?? row?.moveScore ?? null,

    flow: row?.flow || row?.scannerFlow || null,
    scannerFlow: row?.scannerFlow || row?.flow || null,
    rsiZone: row?.rsiZone || null,
    obBias: row?.obBias || null,
    spreadPct: row?.spreadPct ?? null,
    spreadBps: row?.spreadBps ?? null,
    depthMinUsd1p: row?.depthMinUsd1p ?? null,

    discordAllowed: row?.discordAllowed ?? null,
    discordNotified: row?.discordNotified ?? null,
    discordBlockReason: row?.discordBlockReason ?? null,
    discordNotifyFailed: row?.discordNotifyFailed ?? null,
  };
}

function summarizeActions(actions) {
  const rows = safeArray(actions);
  const counts = {};
  const reasons = {};
  const discord = {
    allowed: 0,
    blocked: 0,
    notified: 0,
    failed: 0,
  };

  for (const row of rows) {
    incrementCounter(counts, row?.action || "UNKNOWN");

    if (row?.reason) {
      incrementCounter(reasons, row.reason);
    }

    if (row?.discordAllowed === true) discord.allowed++;
    if (row?.discordAllowed === false) discord.blocked++;
    if (row?.discordNotified === true) discord.notified++;
    if (row?.discordNotifyFailed === true) discord.failed++;
  }

  return {
    total: rows.length,
    counts: normalizeCounterMap(counts),
    reasons: normalizeCounterMap(reasons),
    discord,
    top: rows.slice(0, 30).map(compactActionForLog),
  };
}

// ================= FUNNEL HELPERS =================

function emptySide() {
  return {
    entry: [],
    almost: [],
    buildup: [],
    radar: [],
  };
}

function emptyFunnel() {
  return {
    bull: emptySide(),
    bear: emptySide(),
  };
}

function normalizeFunnel(funnel) {
  return {
    bull: {
      entry: safeArray(funnel?.bull?.entry),
      almost: safeArray(funnel?.bull?.almost),
      buildup: safeArray(funnel?.bull?.buildup),
      radar: safeArray(funnel?.bull?.radar),
    },
    bear: {
      entry: safeArray(funnel?.bear?.entry),
      almost: safeArray(funnel?.bear?.almost),
      buildup: safeArray(funnel?.bear?.buildup),
      radar: safeArray(funnel?.bear?.radar),
    },
  };
}

function countStage(funnel, side, stage) {
  const f = normalizeFunnel(funnel);
  return safeArray(f?.[side]?.[stage]).length;
}

function countSide(funnel, side) {
  const f = normalizeFunnel(funnel);

  return ["entry", "almost", "buildup", "radar"].reduce((sum, stage) => {
    return sum + safeArray(f?.[side]?.[stage]).length;
  }, 0);
}

function countFunnel(funnel) {
  return countSide(funnel, "bull") + countSide(funnel, "bear");
}

function compactCoin(coin) {
  if (!coin || typeof coin !== "object") return coin;

  return {
    symbol: normalizeSymbol(coin.symbol),
    side: normalizeSide(coin.side) || coin.side,
    stage: String(coin.stage || "").toLowerCase(),
    flow: String(coin.flow || coin.scannerFlow || "NEUTRAL").toUpperCase(),
    scannerFlow: String(coin.scannerFlow || coin.flow || "NEUTRAL").toUpperCase(),

    price: safeNumber(coin.price, 0),
    moveScore: safeNumber(coin.moveScore ?? coin.score, 0),
    score: safeNumber(coin.score ?? coin.moveScore, 0),

    change1h: safeNumber(coin.change1h, 0),
    change24: safeNumber(coin.change24, 0),
    vm: safeNumber(coin.vm, 0),
    freshness: safeNumber(coin.freshness, 0),

    tfScore: safeNumber(coin.tfScore, 0),
    tfStrength: safeNumber(coin.tfStrength, Math.abs(safeNumber(coin.tfScore, 0))),

    runnerPressure: safeNumber(coin.runnerPressure, 0),
    runnerAcceleration: safeNumber(coin.runnerAcceleration, 0),

    updatedAt: coin.updatedAt || null,
    ts: coin.ts || null,
  };
}

function compactFunnel(funnel) {
  const f = normalizeFunnel(funnel);

  return {
    bull: {
      entry: safeArray(f.bull.entry).map(compactCoin),
      almost: safeArray(f.bull.almost).map(compactCoin),
      buildup: safeArray(f.bull.buildup).map(compactCoin),
      radar: safeArray(f.bull.radar).map(compactCoin),
    },
    bear: {
      entry: safeArray(f.bear.entry).map(compactCoin),
      almost: safeArray(f.bear.almost).map(compactCoin),
      buildup: safeArray(f.bear.buildup).map(compactCoin),
      radar: safeArray(f.bear.radar).map(compactCoin),
    },
  };
}

// ================= RUNNER GATE =================

function getRunnerPressure(coin) {
  if (Number.isFinite(Number(coin?.runnerPressure))) {
    return Number(coin.runnerPressure);
  }

  const side = normalizeSide(coin?.side);
  const dir = side === "bear" ? -1 : 1;

  const ch24 = Number(coin?.change24 || 0) * dir;
  const ch1 = Number(coin?.change1h || 0) * dir;

  return ch1 * 0.78 + ch24 * 0.22;
}

function getRunnerAcceleration(coin) {
  if (Number.isFinite(Number(coin?.runnerAcceleration))) {
    return Number(coin.runnerAcceleration);
  }

  const side = normalizeSide(coin?.side);
  const dir = side === "bear" ? -1 : 1;

  const ch24 = Number(coin?.change24 || 0) * dir;
  const ch1 = Number(coin?.change1h || 0) * dir;
  const hourlyTrendBaseline = ch24 / 24;

  return ch1 - hourlyTrendBaseline;
}

function candidateQualityScore(c) {
  const score = safeNumber(c.moveScore ?? c.score, 0);
  const vm = safeNumber(c.vm, 0);
  const tfStrength = safeNumber(c.tfStrength, Math.abs(safeNumber(c.tfScore, 0)));
  const stage = String(c.stage || "").toLowerCase();
  const flow = String(c.flow || c.scannerFlow || "NEUTRAL").toUpperCase();
  const freshness = safeNumber(c.freshness, 0);
  const pressure = safeNumber(c.runnerPressure, getRunnerPressure(c));
  const acceleration = safeNumber(c.runnerAcceleration, getRunnerAcceleration(c));

  return (
    score +
    stageRank(stage) * 9 +
    flowRank(flow) * 8 +
    Math.min(freshness * 0.45, 14) +
    Math.min(Math.max(pressure, 0) * 3, 12) +
    Math.min(Math.max(acceleration, 0) * 5, 12) +
    Math.min(tfStrength * 3, 9) +
    Math.min(vm * 42, 12)
  );
}

function passesTradeFunnelGate(coin) {
  const symbol = normalizeSymbol(coin?.symbol);
  const side = normalizeSide(coin?.side);
  const stage = String(coin?.stage || "").toLowerCase();
  const flow = String(coin?.flow || coin?.scannerFlow || "NEUTRAL").toUpperCase();

  const score = safeNumber(coin?.moveScore ?? coin?.score, 0);
  const vm = safeNumber(coin?.vm, 0);
  const tfScore = safeNumber(coin?.tfScore, 0);
  const tfStrength = safeNumber(coin?.tfStrength, Math.abs(tfScore));
  const freshness = safeNumber(coin?.freshness, 0);
  const runnerPressure = getRunnerPressure(coin);
  const runnerAcceleration = getRunnerAcceleration(coin);

  if (!symbol) return { ok: false, reason: "NO_SYMBOL" };

  if (side !== "bull" && side !== "bear") {
    return { ok: false, reason: "BAD_SIDE" };
  }

  if (Boolean(coin?.uiOnly)) {
    return { ok: false, reason: "UI_ONLY" };
  }

  if (stage !== "entry" && stage !== "almost") {
    return { ok: false, reason: "BAD_STAGE" };
  }

  if (!RUNNER_FLOWS.has(flow)) {
    return { ok: false, reason: "BAD_RUNNER_FLOW" };
  }

  if (flow === "BUILDING" && stage !== "entry") {
    return { ok: false, reason: "BUILDING_ONLY_ENTRY" };
  }

  if (stage === "entry" && score < 70) {
    return { ok: false, reason: "ENTRY_SCORE_TOO_LOW" };
  }

  if (stage === "almost" && score < 72) {
    return { ok: false, reason: "ALMOST_SCORE_TOO_LOW" };
  }

  if (flow === "SQUEEZE" && score < 74) {
    return { ok: false, reason: "SQUEEZE_SCORE_TOO_LOW" };
  }

  if (flow === "RUNNING" && score < 70) {
    return { ok: false, reason: "RUNNING_SCORE_TOO_LOW" };
  }

  if (flow === "BREAKOUT" && score < 68) {
    return { ok: false, reason: "BREAKOUT_SCORE_TOO_LOW" };
  }

  if (flow === "BUILDING" && score < 78) {
    return { ok: false, reason: "BUILDING_SCORE_TOO_LOW" };
  }

  if (vm < 0.025) {
    return { ok: false, reason: "VM_TOO_LOW" };
  }

  if (freshness < 6) {
    return { ok: false, reason: "FRESHNESS_TOO_LOW" };
  }

  if (runnerPressure < 0.10) {
    return { ok: false, reason: "RUNNER_PRESSURE_TOO_LOW" };
  }

  if (runnerAcceleration < -0.35) {
    return { ok: false, reason: "ACCELERATION_NEGATIVE" };
  }

  if (flow === "BUILDING" && tfStrength < 1.2) {
    return { ok: false, reason: "BUILDING_TF_TOO_WEAK" };
  }

  return { ok: true, reason: "OK" };
}

function getTradeFunnelCandidates(latest) {
  const buckets = [
    ...safeArray(latest?.funnel?.bull?.entry),
    ...safeArray(latest?.funnel?.bear?.entry),
    ...safeArray(latest?.funnel?.bull?.almost),
    ...safeArray(latest?.funnel?.bear?.almost),
  ];

  const accepted = new Map();
  const rejectCounts = {};

  for (const coin of buckets) {
    if (!coin) continue;

    const gate = passesTradeFunnelGate(coin);

    if (!gate.ok) {
      incrementCounter(rejectCounts, gate.reason);
      continue;
    }

    const symbol = normalizeSymbol(coin.symbol);
    const side = normalizeSide(coin.side);
    const stage = String(coin.stage || "radar").toLowerCase();
    const flow = String(coin.flow || coin.scannerFlow || "NEUTRAL").toUpperCase();

    const score = safeNumber(coin.moveScore ?? coin.score, 0);
    const vm = safeNumber(coin.vm, 0);
    const tfScore = safeNumber(coin.tfScore, 0);
    const tfStrength = safeNumber(coin.tfStrength, Math.abs(tfScore));
    const runnerPressure = getRunnerPressure(coin);
    const runnerAcceleration = getRunnerAcceleration(coin);

    const normalized = {
      ...coin,

      symbol,
      side,
      stage,
      scannerStage: stage,

      flow,
      scannerFlow: flow,

      moveScore: score,
      score,
      vm,
      tfScore,
      tfStrength,

      runnerProfile: SYSTEM_PROFILE,
      runnerPressure,
      runnerAcceleration,
      entryType: coin.entryType || "RUNNER_UNCLASSIFIED",

      tradeFunnelProfile: SYSTEM_PROFILE,
      tradeFunnelQuality: candidateQualityScore({
        ...coin,
        symbol,
        side,
        stage,
        flow,
        moveScore: score,
        score,
        vm,
        tfScore,
        tfStrength,
        runnerPressure,
        runnerAcceleration,
      }),
    };

    const key = `${symbol}_${side}`;
    const prev = accepted.get(key);

    if (!prev) {
      accepted.set(key, normalized);
      continue;
    }

    if (candidateQualityScore(normalized) > candidateQualityScore(prev)) {
      accepted.set(key, normalized);
    }
  }

  const result = Array.from(accepted.values()).sort((a, b) => {
    const qDiff = safeNumber(b.tradeFunnelQuality, 0) - safeNumber(a.tradeFunnelQuality, 0);
    if (qDiff !== 0) return qDiff;

    const stageDiff = stageRank(b.stage) - stageRank(a.stage);
    if (stageDiff !== 0) return stageDiff;

    const flowDiff = flowRank(b.flow) - flowRank(a.flow);
    if (flowDiff !== 0) return flowDiff;

    return safeNumber(b.moveScore, 0) - safeNumber(a.moveScore, 0);
  });

  routeDebug("TRADE_FUNNEL_SELECTION_DEBUG", {
    raw: buckets.length,
    accepted: result.length,
    rejected: normalizeCounterMap(rejectCounts),
    symbols: result
      .slice(0, MAX_SYMBOL_LOGS)
      .map(c => `${c.symbol}_${c.side}_${c.stage}_${c.flow}_${Math.round(c.moveScore || 0)}`),
  });

  return {
    candidates: result,
    rejectCounts,
    rawCount: buckets.length,
  };
}

// ================= COMPACT PAYLOAD =================

function compactTradeRow(row) {
  if (!row || typeof row !== "object") return row;

  return {
    profile: row.profile || SYSTEM_PROFILE,
    strategyVersion: row.strategyVersion,

    tradeId: row.tradeId,
    positionTradeId: row.positionTradeId,
    sourceTradeId: row.sourceTradeId,

    symbol: row.symbol,
    side: row.side,

    action: row.action,
    reason: row.reason,
    setupClass: row.setupClass,
    entryType: row.entryType || row.runnerEntryType,
    runnerEntryType: row.runnerEntryType || row.entryType,
    grade: row.grade,

    familyId: row.familyId,
    runnerFamilyId: row.runnerFamilyId || row.familyId,
    analyzeFamilyId: row.analyzeFamilyId || row.familyId,
    analysisFamilyId: row.analysisFamilyId || row.familyId,
    discordFamilyId: row.discordFamilyId,

    entry: row.entry,
    entryPrice: row.entryPrice,
    openPrice: row.openPrice,

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
    finalRR: row.finalRR,
    targetR: row.targetR,

    confluence: row.confluence,
    sniperScore: row.sniperScore,
    score: row.score,
    moveScore: row.moveScore,

    flow: row.flow,
    scannerFlow: row.scannerFlow,

    rsi: row.rsi,
    rsiZone: row.rsiZone,

    obBias: row.obBias,
    spreadPct: row.spreadPct,
    spreadBps: row.spreadBps,
    depthMinUsd1p: row.depthMinUsd1p,

    funding: row.funding,
    fundingRate: row.fundingRate,
    btcState: row.btcState,
    regime: row.regime,

    runnerPressure: row.runnerPressure,
    runnerAcceleration: row.runnerAcceleration,

    tfScore: row.tfScore,
    tfStrength: row.tfStrength,
    tfAlignment: row.tfAlignment,

    currentR: row.currentR,
    mfeR: row.mfeR,
    maeR: row.maeR,

    partialTaken: row.partialTaken,
    breakEvenMoved: row.breakEvenMoved,
    trailingActive: row.trailingActive,
    adds: row.adds,

    exit: row.exit,
    exitPrice: row.exitPrice,
    executionPrice: row.executionPrice,
    exitR: row.exitR,
    realizedR: row.realizedR,
    resultR: row.resultR,
    pnlR: row.pnlR,
    pnlPct: row.pnlPct,
    exitReason: row.exitReason,

    discordAllowed: row.discordAllowed,
    discordNotified: row.discordNotified,
    discordBlockReason: row.discordBlockReason,
    discordNotifyFailed: row.discordNotifyFailed,
    discordNotifyError: row.discordNotifyError,

    closed: row.closed,
    closedAt: row.closedAt,
    openedAt: row.openedAt,
    entryTs: row.entryTs,
    createdAt: row.createdAt,
    exitedAt: row.exitedAt,
    updatedAt: row.updatedAt,
    ts: row.ts,
  };
}

function isOpenPositionForState(pos) {
  if (!pos || typeof pos !== "object") return false;
  if (pos.closed === true || pos.isClosed === true) return false;

  const action = normalizeText(pos.action || pos.status || pos.state);
  if (["EXIT", "CLOSE", "CLOSED"].includes(action)) return false;

  if (pos.closedAt || pos.exitedAt || pos.exitAt || pos.exitTs) return false;

  const symbol = normalizeSymbol(pos.symbol);
  const side = normalizeSide(pos.side);

  return Boolean(symbol && side);
}

function getOpenPositionTs(pos) {
  return safeNumber(
    firstDefined(
      pos.updatedAt,
      pos.createdAt,
      pos.openedAt,
      pos.entryTs,
      pos.ts
    ),
    0
  );
}

function getOpenPositionKey(pos) {
  const direct =
    pos?.tradeId ||
    pos?.positionTradeId ||
    pos?.positionId ||
    pos?.orderId ||
    pos?.clientOrderId;

  if (direct) return `ID|${String(direct)}`;

  return [
    "FALLBACK",
    normalizeSymbol(pos?.symbol),
    normalizeSide(pos?.side),
    normalizeText(pos?.entryType || pos?.runnerEntryType || pos?.setupClass),
    nullableNumber(pos?.entry ?? pos?.entryPrice ?? pos?.openPrice) ?? "",
  ].join("|");
}

function openPositionCompletenessScore(pos) {
  let score = 0;

  if (pos?.tradeId) score += 20;
  if (pos?.positionTradeId) score += 15;
  if (pos?.positionId) score += 10;
  if (pos?.familyId || pos?.runnerFamilyId || pos?.analyzeFamilyId) score += 10;
  if (pos?.entry !== undefined || pos?.entryPrice !== undefined || pos?.openPrice !== undefined) score += 10;
  if (pos?.sl !== undefined || pos?.initialSl !== undefined) score += 5;
  if (pos?.tp !== undefined) score += 5;
  if (pos?.entryType || pos?.runnerEntryType) score += 5;
  if (pos?.discordEntryNotified === true) score += 3;

  score += Math.min(getOpenPositionTs(pos) / 1e15, 1);

  return score;
}

function dedupeOpenPositionsForState(positions) {
  const map = new Map();

  for (const pos of safeArray(positions)) {
    if (!isOpenPositionForState(pos)) continue;

    const key = getOpenPositionKey(pos);
    if (!key || key === "FALLBACK||||") continue;

    const prev = map.get(key);

    if (!prev) {
      map.set(key, pos);
      continue;
    }

    if (openPositionCompletenessScore(pos) >= openPositionCompletenessScore(prev)) {
      map.set(key, pos);
    }
  }

  return Array.from(map.values());
}

function compactOpenPosition(pos) {
  if (!pos || typeof pos !== "object") return pos;

  return {
    tradeId: pos.tradeId,
    positionTradeId: pos.positionTradeId,
    positionId: pos.positionId,
    orderId: pos.orderId,
    clientOrderId: pos.clientOrderId,

    symbol: pos.symbol,
    side: pos.side,

    setupClass: pos.setupClass,
    entryType: pos.entryType || pos.runnerEntryType,
    runnerEntryType: pos.runnerEntryType || pos.entryType,

    scannerFlow: pos.scannerFlow,
    flow: pos.flow,

    liveEligible: Boolean(pos.liveEligible),
    shadowOnly: Boolean(pos.shadowOnly),

    familyId: pos.familyId,
    runnerFamilyId: pos.runnerFamilyId || pos.familyId,
    analyzeFamilyId: pos.analyzeFamilyId || pos.familyId,
    analysisFamilyId: pos.analysisFamilyId || pos.familyId,
    discordFamilyId: pos.discordFamilyId,

    entry: pos.entry,
    entryPrice: pos.entryPrice,
    openPrice: pos.openPrice,

    sl: pos.sl,
    initialSl: pos.initialSl,
    tp: pos.tp,
    partialTp: pos.partialTp,
    breakevenAt: pos.breakevenAt,
    trailStart: pos.trailStart,
    trailPrice: pos.trailPrice ?? null,

    rr: pos.rr,
    baseRR: pos.baseRR,
    plannedRR: pos.plannedRR,
    finalRR: pos.finalRR,
    targetR: pos.targetR,

    confluence: pos.confluence,
    sniperScore: pos.sniperScore,
    score: pos.score,
    moveScore: pos.moveScore,

    flowStrength: pos.flowStrength,
    detectedFlow: pos.detectedFlow,

    rsi: pos.rsi,
    rsiHTF: pos.rsiHTF,
    rsiZone: pos.rsiZone,
    rsiContinuationScore: pos.rsiContinuationScore,

    obBias: pos.obBias,
    spreadPct: pos.spreadPct,
    spreadBps: pos.spreadBps,
    depthMinUsd1p: pos.depthMinUsd1p,
    depthUsd1p: pos.depthUsd1p,

    btcState: pos.btcState,
    regime: pos.regime,
    funding: pos.funding,
    fundingRate: pos.fundingRate,

    runnerPressure: pos.runnerPressure,
    runnerAcceleration: pos.runnerAcceleration,

    tfScore: pos.tfScore,
    tfStrength: pos.tfStrength,
    tfAlignment: pos.tfAlignment,

    currentR: safeNumber(pos.currentR, 0),
    mfeR: safeNumber(pos.mfeR, 0),
    maeR: safeNumber(pos.maeR, 0),

    partialTaken: Boolean(pos.partialTaken),
    breakEvenMoved: Boolean(pos.breakEvenMoved),
    trailingActive: Boolean(pos.trailingActive),
    adds: safeNumber(pos.adds, 0),

    closed: Boolean(pos.closed),
    closedAt: pos.closedAt || null,
    exitedAt: pos.exitedAt || null,

    discordEntryAllowed: pos.discordEntryAllowed,
    discordEntryNotified: pos.discordEntryNotified,
    discordEntryBlocked: pos.discordEntryBlocked,
    discordBlockReason: pos.discordBlockReason,

    createdAt: pos.createdAt,
    openedAt: pos.openedAt,
    entryTs: pos.entryTs,
    updatedAt: pos.updatedAt,
    ts: pos.ts,
  };
}

function compactOpenPositionsForState(positions) {
  const raw = safeArray(positions);

  const rows = dedupeOpenPositionsForState(raw)
    .sort((a, b) => getOpenPositionTs(a) - getOpenPositionTs(b));

  if (rows.length > MAX_STORED_OPEN_POSITIONS) {
    routeLog("OPEN_POSITIONS_STATE_CAP_HIT", {
      raw: raw.length,
      deduped: rows.length,
      cap: MAX_STORED_OPEN_POSITIONS,
      message: "Open position state cap hit. Increase TRADE_FUNNEL_MAX_STORED_OPEN_POSITIONS.",
    });
  }

  return rows
    .slice(-MAX_STORED_OPEN_POSITIONS)
    .map(compactOpenPosition);
}

function compactTradeSystemResult(result) {
  if (!result || typeof result !== "object") {
    return {
      profile: SYSTEM_PROFILE,
      ok: true,
      actions: [],
      openPositions: [],
      candidatesCount: 0,
      reason: "no_runner_candidates",
    };
  }

  const stats = safeObject(result.runnerStats);
  const openPositions = compactOpenPositionsForState(result.openPositions);

  return {
    profile: result.profile || SYSTEM_PROFILE,
    ok: result.ok !== false,
    strategyVersion: result.strategyVersion,
    runId: result.runId,
    btcState: result.btcState,

    candidatesCount: safeNumber(result.candidatesCount, 0),
    liveEligibleCandidates: safeNumber(result.liveEligibleCandidates, 0),
    shadowOnlyCandidates: safeNumber(result.shadowOnlyCandidates, 0),

    actions: safeArray(result.actions).slice(-MAX_STORED_ACTIONS).map(compactTradeRow),
    openPositions,

    actionSummary: summarizeActions(result.actions),

    runnerStats: {
      profile: stats.profile || SYSTEM_PROFILE,
      strategyVersion: stats.strategyVersion,

      runs: safeNumber(stats.runs, 0),
      entries: safeNumber(stats.entries, 0),
      partials: safeNumber(stats.partials, 0),
      movesToBE: safeNumber(stats.movesToBE, 0),
      trails: safeNumber(stats.trails, 0),
      adds: safeNumber(stats.adds, 0),
      exits: safeNumber(stats.exits, 0),

      wins: safeNumber(stats.wins, 0),
      losses: safeNumber(stats.losses, 0),
      winrate: safeNumber(stats.winrate, 0),

      totalR: safeNumber(stats.totalR, 0),
      avgR: safeNumber(stats.avgR, 0),
      totalPnlPct: safeNumber(stats.totalPnlPct, 0),
      avgPnlPct: safeNumber(stats.avgPnlPct, 0),

      openPositions: openPositions.length,

      waitReasons: normalizeCounterMap(stats.waitReasons),
      entryTypes: normalizeCounterMap(stats.entryTypes),
      actionCounts: normalizeCounterMap(stats.actionCounts),

      closedTrades: safeArray(stats.closedTrades).slice(-50).map(compactTradeRow),
      featureRows: safeArray(stats.featureRows).slice(-50).map(compactTradeRow),
      shadowRows: safeArray(stats.shadowRows).slice(-50).map(compactTradeRow),

      durableEnabled: Boolean(stats.durableEnabled),
      durableLoadedAt: safeNumber(stats.durableLoadedAt, 0),
      durableSavedAt: safeNumber(stats.durableSavedAt, 0),
      servedAt: stats.servedAt || Date.now(),
    },
  };
}

function trimDashboardRows(stats) {
  if (!stats) return stats;

  return {
    ...stats,
    entryRows: safeArray(stats.entryRows).slice(-MAX_STORED_ENTRY_ROWS).map(compactTradeRow),
    rejectedRows: safeArray(stats.rejectedRows).slice(-MAX_STORED_REJECT_ROWS).map(compactTradeRow),
    tradeRows: safeArray(stats.tradeRows).slice(-MAX_STORED_TRADE_ROWS).map(compactTradeRow),
  };
}

// ================= RUNNER ANALYZE PERSIST =================

function getRowAction(row) {
  return normalizeText(row?.action || row?.analyzeLifecycle || row?.status);
}

function isAnalyzePersistableRow(row) {
  const action = getRowAction(row);

  if (action === "ENTRY") return true;
  if (action === "EXIT") return true;

  return false;
}

function getAnalyzeLifecycle(row) {
  const action = getRowAction(row);

  if (action === "ENTRY") return "ENTRY";
  if (action === "EXIT") return "EXIT";

  return "";
}

function buildStableAnalyzeTradeId(row) {
  const stable = buildAnalyzeStableTradeId(row);
  if (stable) return stable;

  const direct =
    row?.positionTradeId ||
    row?.tradeId ||
    row?.positionId ||
    row?.orderId ||
    row?.clientOrderId;

  return direct ? String(direct) : "";
}

function getSourceTradeId(row) {
  const direct =
    row?.tradeId ||
    row?.positionTradeId ||
    row?.positionId ||
    row?.orderId ||
    row?.clientOrderId ||
    row?.id;

  return direct ? String(direct) : null;
}

function buildRunnerAnalyzeEvent(row, latest, now) {
  if (!row || typeof row !== "object") return null;
  if (!isAnalyzePersistableRow(row)) return null;

  const action = getAnalyzeLifecycle(row);
  if (!action) return null;

  const symbol = normalizeSymbol(row.symbol);
  const side = normalizeAnalyzeSide(row.side);
  const tradeId = buildStableAnalyzeTradeId(row);

  if (!symbol || !side || !tradeId) return null;

  const compact = compactTradeRow(row);
  const sourceTradeId = getSourceTradeId(row);

  const r = firstDefined(
    row.realizedR,
    row.pnlR,
    row.exitR,
    row.resultR,
    row.outcomeR,
    row.rMultiple
  );

  const pnlPct = firstDefined(
    row.pnlPct,
    row.pnlPercent,
    row.realizedPnlPct,
    row.resultPnlPct,
    row.profitPct
  );

  const entry = nullableNumber(row.entry ?? row.entryPrice ?? row.openPrice);
  const openedAt = safeNumber(
    firstDefined(row.openedAt, row.entryTs, row.createdAt, row.ts, now),
    now
  );

  const closedAt = action === "EXIT" || row.closed === true
    ? safeNumber(
        firstDefined(row.closedAt, row.exitedAt, row.exitAt, row.exitTs, row.ts, now),
        now
      )
    : null;

  const familyId =
    row.familyId ||
    row.runnerFamilyId ||
    row.analyzeFamilyId ||
    row.analysisFamilyId ||
    null;

  return {
    ...compact,

    profile: SYSTEM_PROFILE,
    runnerProfile: SYSTEM_PROFILE,
    strategyVersion: row.strategyVersion || latest?.strategyVersion,

    analyzeSource: "runner_trade_funnel",
    analyzeLifecycle: action,
    action,

    tradeId,
    positionTradeId: tradeId,
    sourceTradeId,

    symbol,
    side,

    openedAt,
    entryTs: openedAt,

    entry,
    entryPrice: nullableNumber(row.entryPrice ?? row.entry ?? row.openPrice),
    openPrice: nullableNumber(row.openPrice ?? row.entryPrice ?? row.entry),

    sl: nullableNumber(row.sl ?? row.initialSl),
    initialSl: nullableNumber(row.initialSl ?? row.sl),
    tp: nullableNumber(row.tp),
    partialTp: nullableNumber(row.partialTp),
    breakevenAt: nullableNumber(row.breakevenAt),
    trailStart: nullableNumber(row.trailStart),

    rr: nullableNumber(row.rr ?? row.baseRR ?? row.finalRR ?? row.plannedRR),
    baseRR: nullableNumber(row.baseRR ?? row.rr),
    plannedRR: nullableNumber(row.plannedRR ?? row.rr),
    finalRR: nullableNumber(row.finalRR ?? row.rr),
    targetR: nullableNumber(row.targetR),

    closed: action === "EXIT" || row.closed === true,
    closedAt,

    exit: nullableNumber(row.exit ?? row.exitPrice ?? row.executionPrice),
    exitPrice: nullableNumber(row.exitPrice ?? row.exit ?? row.executionPrice),
    executionPrice: nullableNumber(row.executionPrice ?? row.exit ?? row.exitPrice),

    realizedR: nullableNumber(r),
    pnlR: nullableNumber(r),
    exitR: nullableNumber(r),
    resultR: nullableNumber(r),
    outcomeR: nullableNumber(r),
    rMultiple: nullableNumber(r),

    pnlPct: nullableNumber(pnlPct),

    exitReason: row.exitReason || row.reason || null,

    familyId,
    runnerFamilyId: row.runnerFamilyId || familyId,
    analyzeFamilyId: row.analyzeFamilyId || familyId,
    analysisFamilyId: row.analysisFamilyId || familyId,
    discordFamilyId: row.discordFamilyId || null,

    filterSnapshot: {
      ...safeObject(row.filterSnapshot),

      profile: SYSTEM_PROFILE,
      runnerProfile: SYSTEM_PROFILE,

      familyId,
      runnerFamilyId: row.runnerFamilyId || familyId,
      analyzeFamilyId: row.analyzeFamilyId || familyId,
      analysisFamilyId: row.analysisFamilyId || familyId,
      discordFamilyId: row.discordFamilyId || null,

      side,
      setupClass: row.setupClass,
      entryType: row.entryType || row.runnerEntryType,
      runnerEntryType: row.runnerEntryType || row.entryType,

      stage: row.stage,
      scannerStage: row.scannerStage,
      flow: row.flow,
      scannerFlow: row.scannerFlow,

      confluence: row.confluence,
      sniperScore: row.sniperScore,
      score: row.score ?? row.moveScore,
      moveScore: row.moveScore ?? row.score,

      rr: row.rr,
      baseRR: row.baseRR,
      plannedRR: row.plannedRR,
      targetR: row.targetR,

      rsi: row.rsi,
      rsiZone: row.rsiZone,
      obBias: row.obBias,
      spreadPct: row.spreadPct,
      spreadBps: row.spreadBps,
      depthMinUsd1p: row.depthMinUsd1p,

      btcState: row.btcState || latest?.btc?.state,
      regime: row.regime || latest?.regime,
      funding: row.funding,
      fundingRate: row.fundingRate,

      tfScore: row.tfScore,
      tfStrength: row.tfStrength,
      tfAlignment: row.tfAlignment,

      runnerPressure: row.runnerPressure,
      runnerAcceleration: row.runnerAcceleration,

      partialTaken: row.partialTaken,
      breakEvenMoved: row.breakEvenMoved,
      trailingActive: row.trailingActive,
      adds: row.adds,
      mfeR: row.mfeR,
      maeR: row.maeR,
      currentR: row.currentR,

      discordAllowed: row.discordAllowed,
      discordNotified: row.discordNotified,
      discordBlockReason: row.discordBlockReason,

      strategyVersion: row.strategyVersion,
    },

    btc: latest?.btc || null,
    regime: row.regime || latest?.regime || null,
    market: latest?.market || null,

    tradeFunnelUpdatedAt: now,
    latestUpdatedAt: latest?.updatedAt || null,

    ts: safeNumber(row.ts, now),
    analyzeTs: now,
    storedAt: row.storedAt || now,
    updatedAt: now,
  };
}

function collectAnalyzeInputRows(rawResult) {
  const rows = [];

  // Bewust alleen deze run. Geen oude latest.trades.
  rows.push(...safeArray(rawResult?.actions));

  const map = new Map();

  for (const row of rows) {
    if (!row) continue;

    const action = getRowAction(row);
    if (action !== "ENTRY" && action !== "EXIT") continue;

    const key = buildDedupeKey(row);
    if (!key.trim()) continue;

    map.set(key, row);
  }

  return Array.from(map.values());
}

async function persistRunnerAnalyzeActions({ latest, rawResult, now, requestId }) {
  if (!RUNNER_ANALYZE_PERSIST) {
    routeLog("ANALYZE_PERSIST_SKIPPED", {
      requestId,
      reason: "RUNNER_ANALYZE_PERSIST_FALSE",
    });

    return {
      ok: true,
      skipped: true,
      reason: "RUNNER_ANALYZE_PERSIST_FALSE",
      received: 0,
      accepted: 0,
    };
  }

  const inputRows = collectAnalyzeInputRows(rawResult);

  const events = inputRows
    .map(row => buildRunnerAnalyzeEvent(row, latest, now))
    .filter(Boolean);

  routeLog("ANALYZE_PERSIST_PREPARED", {
    requestId,
    received: inputRows.length,
    events: events.length,
    entries: events.filter(e => e.action === "ENTRY").length,
    exits: events.filter(e => e.action === "EXIT").length,
    missingFamily: events.filter(e => !e.familyId).length,
    sample: events.slice(0, 12).map(e => ({
      symbol: e.symbol,
      side: e.side,
      action: e.action,
      tradeId: e.tradeId,
      sourceTradeId: e.sourceTradeId,
      familyId: e.familyId,
      entry: e.entry,
      exitR: e.exitR,
      pnlPct: e.pnlPct,
      closed: e.closed,
    })),
  });

  if (!events.length) {
    return {
      ok: true,
      skipped: true,
      reason: "NO_ENTRY_OR_EXIT_EVENTS",
      received: inputRows.length,
      accepted: 0,
    };
  }

  try {
    const result = await appendRunnerAnalyzeEvents(events, {
      source: "runner_trade_funnel",
      btc: latest?.btc,
      regime: latest?.regime,
      market: latest?.market,
      tradeFunnelUpdatedAt: now,
      latestUpdatedAt: latest?.updatedAt,
    });

    routeLog("ANALYZE_PERSIST_DONE", {
      requestId,
      ok: result?.ok !== false,
      accepted: safeNumber(result?.accepted ?? result?.added, 0),
      ignored: safeNumber(result?.ignored, 0),
      ignoredReasons: result?.ignoredReasons || {},
      entries: safeNumber(result?.entries, 0),
      matchedExits: safeNumber(result?.matchedExits, 0),
      unmatchedExits: safeNumber(result?.unmatchedExits, 0),
      count: safeNumber(result?.count, 0),
      open: safeNumber(result?.open, 0),
      closed: safeNumber(result?.closed, 0),
    });

    return {
      ok: result?.ok !== false,
      skipped: false,
      received: inputRows.length,
      attempted: events.length,
      accepted: safeNumber(result?.accepted ?? result?.added, 0),
      ignored: safeNumber(result?.ignored, 0),
      ignoredReasons: result?.ignoredReasons || {},
      entries: safeNumber(result?.entries, 0),
      closedEntryUpdates: safeNumber(result?.closedEntryUpdates, 0),
      syntheticClosedEntries: safeNumber(result?.syntheticClosedEntries, 0),
      matchedExits: safeNumber(result?.matchedExits, 0),
      unmatchedExits: safeNumber(result?.unmatchedExits, 0),
      count: safeNumber(result?.count, 0),
      open: safeNumber(result?.open, 0),
      closed: safeNumber(result?.closed, 0),
      redisKey: result?.redisKey || null,
      path: result?.path || null,
    };
  } catch (error) {
    routeError("ANALYZE_PERSIST_FAILED", error, {
      requestId,
      received: inputRows.length,
      attempted: events.length,
    });

    return {
      ok: false,
      skipped: false,
      received: inputRows.length,
      attempted: events.length,
      accepted: 0,
      error: error?.message || "runner_analyze_persist_failed",
    };
  }
}

// ================= PAYLOAD BUILD =================

function buildTradeFunnelPayload({
  latest,
  selection,
  result = null,
  mode = "read_only",
  busy = false,
  error = null,
  analyzePersist = null,
  now = Date.now(),
  requestId = null,
  trace = null,
}) {
  const funnel = compactFunnel(latest?.funnel || emptyFunnel());
  const sourceResult = result || latest?.tradeSystemResult;

  const compactResult =
    sourceResult?.actionSummary && sourceResult?.runnerStats
      ? sourceResult
      : compactTradeSystemResult(sourceResult);

  const trades = safeArray(
    result?.actions?.length ? result.actions : latest?.trades
  )
    .slice(-MAX_STORED_ACTIONS)
    .map(compactTradeRow);

  return {
    ok: true,
    profile: SYSTEM_PROFILE,
    scannerProfile: latest?.scannerProfile || SYSTEM_PROFILE,

    requestId,

    source: mode === "run" ? "trade_funnel_run" : "trade_funnel_snapshot",
    tradeFunnelMode: mode,
    tradeFunnelBusy: Boolean(busy),
    tradeFunnelError: error,

    scanReady: Boolean(latest?.scanReady),
    message: latest?.message || null,

    funnel,
    funnelCount: countFunnel(funnel),
    bullCount: countSide(funnel, "bull"),
    bearCount: countSide(funnel, "bear"),

    btc: latest?.btc || {
      state: "UNKNOWN",
      chg24: 0,
      chg1h: 0,
      pressure: 0,
    },

    regime: latest?.regime || "UNKNOWN",
    market: latest?.market || null,
    analytics: latest?.analytics || {},
    advice: latest?.advice || {},

    candidates: safeNumber(latest?.candidates, 0),
    candidatesBull: safeNumber(latest?.candidatesBull, 0),
    candidatesBear: safeNumber(latest?.candidatesBear, 0),

    trades,
    tradeSystemResult: compactResult,

    runnerAnalyzePersist:
      analyzePersist ||
      latest?.runnerAnalyzePersist ||
      null,

    tradeFunnelProfile: SYSTEM_PROFILE,
    tradeFunnelInputCount: safeArray(selection?.candidates).length,
    tradeFunnelRawCount: safeNumber(selection?.rawCount, 0),
    tradeFunnelRejectCounts: normalizeCounterMap(selection?.rejectCounts),
    tradeFunnelInputSymbols: safeArray(selection?.candidates)
      .slice(0, MAX_SYMBOL_LOGS)
      .map(c => `${c.symbol}_${c.side}_${c.stage}_${c.flow}_${Math.round(c.moveScore || 0)}`),

    tradeFunnelTrace: trace || {
      requestId,
      mode,
      autoRunDefault: RUNNER_AUTO_RUN,
      routeLogsEnabled: TRADE_FUNNEL_ROUTE_LOG,
      routeDebugEnabled: TRADE_FUNNEL_ROUTE_DEBUG,
    },

    dashboardStats: trimDashboardRows(latest?.dashboardStats),

    scannerUpdatedAt: latest?.scannerUpdatedAt || null,
    tradeFunnelUpdatedAt: mode === "run" ? now : latest?.tradeFunnelUpdatedAt || null,
    updatedAt: mode === "run" ? now : latest?.updatedAt || now,

    servedAt: now,
  };
}

function isLockBusyError(error) {
  return String(error?.message || error || "").includes("RUNNER_TRADE_SYSTEM_LOCK_BUSY");
}

// ================= CORE =================

export async function runTradeFunnel(options = {}) {
  const startedAt = Date.now();

  const notify = options.notify !== false;
  const store = options.store !== false;
  const mode = options.mode || "read_only";
  const requestId = options.requestId || createRequestId("trade_funnel_run");
  const now = Date.now();

  routeLog("RUN_TRADE_FUNNEL_START", {
    requestId,
    mode,
    notify,
    store,
    autoRunDefault: RUNNER_AUTO_RUN,
  });

  const latest = await getLatestScan();

  routeLog("LATEST_SCAN_LOADED", {
    requestId,
    ok: Boolean(latest?.ok),
    scanReady: Boolean(latest?.scanReady),
    updatedAt: latest?.updatedAt || null,
    scannerUpdatedAt: latest?.scannerUpdatedAt || null,
    funnelCount: countFunnel(latest?.funnel || emptyFunnel()),
    bullEntry: countStage(latest?.funnel, "bull", "entry"),
    bullAlmost: countStage(latest?.funnel, "bull", "almost"),
    bearEntry: countStage(latest?.funnel, "bear", "entry"),
    bearAlmost: countStage(latest?.funnel, "bear", "almost"),
    previousRunnerActions: safeArray(latest?.tradeSystemResult?.actions).length,
    previousOpenPositions: safeArray(latest?.tradeSystemResult?.openPositions).length,
  });

  if (!latest?.ok) {
    throw new Error("no_latest_scan_available");
  }

  const selection = getTradeFunnelCandidates(latest);

  routeLog("SELECTION_BUILT", {
    requestId,
    mode,
    rawCount: selection.rawCount,
    acceptedCount: selection.candidates.length,
    rejectCounts: normalizeCounterMap(selection.rejectCounts),
    symbols: selection.candidates
      .slice(0, MAX_SYMBOL_LOGS)
      .map(c => `${c.symbol}_${c.side}_${c.stage}_${c.flow}_${Math.round(c.moveScore || 0)}`),
  });

  if (mode !== "run") {
    const payload = buildTradeFunnelPayload({
      latest,
      selection,
      mode: "read_only",
      now,
      requestId,
      trace: {
        requestId,
        mode: "read_only",
        reason: "SNAPSHOT_ONLY",
        rawCount: selection.rawCount,
        acceptedCount: selection.candidates.length,
        rejectCounts: normalizeCounterMap(selection.rejectCounts),
        durationMs: Date.now() - startedAt,
      },
    });

    routeLog("RUN_TRADE_FUNNEL_DONE", {
      requestId,
      mode: "read_only",
      durationMs: Date.now() - startedAt,
      acceptedCount: selection.candidates.length,
    });

    return payload;
  }

  const candidates = selection.candidates;

  let rawResult = null;
  let runnerDurationMs = 0;

  try {
    if (!candidates.length) {
      routeLog("RUNNER_SKIPPED_NO_CANDIDATES", {
        requestId,
        rawCount: selection.rawCount,
        rejectCounts: normalizeCounterMap(selection.rejectCounts),
      });

      rawResult = {
        ok: true,
        actions: [],
        openPositions: safeArray(latest?.tradeSystemResult?.openPositions),
        candidatesCount: 0,
        profile: SYSTEM_PROFILE,
        reason: "no_runner_candidates",
      };
    } else {
      const runnerStartedAt = Date.now();

      routeLog("RUNNER_CALL_START", {
        requestId,
        candidates: candidates.length,
        notify,
        store,
        btcState: latest?.btc?.state || null,
        regime: latest?.regime || null,
        previousOpenPositions: safeArray(latest?.tradeSystemResult?.openPositions).length,
        symbols: candidates
          .slice(0, MAX_SYMBOL_LOGS)
          .map(c => `${c.symbol}_${c.side}_${c.stage}_${c.flow}_${Math.round(c.moveScore || 0)}`),
      });

      rawResult = await processTrades(candidates, {
        notify,
        log: true,
        profile: SYSTEM_PROFILE,
        runner: true,
        btc: latest.btc,
        regime: latest.regime,
        market: latest.market,
      });

      runnerDurationMs = Date.now() - runnerStartedAt;

      routeLog("RUNNER_CALL_DONE", {
        requestId,
        durationMs: runnerDurationMs,
        ok: rawResult?.ok !== false,
        runId: rawResult?.runId || null,
        candidatesCount: safeNumber(rawResult?.candidatesCount, 0),
        liveEligibleCandidates: safeNumber(rawResult?.liveEligibleCandidates, 0),
        openPositionsRaw: safeArray(rawResult?.openPositions).length,
        actionSummary: summarizeActions(rawResult?.actions),
        runnerWaitReasons: normalizeCounterMap(rawResult?.runnerStats?.waitReasons),
        runnerActionCounts: normalizeCounterMap(rawResult?.runnerStats?.actionCounts),
      });
    }
  } catch (error) {
    if (isLockBusyError(error)) {
      routeLog("RUNNER_LOCK_BUSY", {
        requestId,
        durationMs: Date.now() - startedAt,
      });

      return buildTradeFunnelPayload({
        latest,
        selection,
        mode: "read_only",
        busy: true,
        error: "RUNNER_TRADE_SYSTEM_LOCK_BUSY",
        now,
        requestId,
        trace: {
          requestId,
          mode: "read_only",
          reason: "RUNNER_TRADE_SYSTEM_LOCK_BUSY",
          rawCount: selection.rawCount,
          acceptedCount: selection.candidates.length,
          rejectCounts: normalizeCounterMap(selection.rejectCounts),
          durationMs: Date.now() - startedAt,
        },
      });
    }

    routeError("RUNNER_CALL_FAILED", error, {
      requestId,
      durationMs: Date.now() - startedAt,
      candidates: candidates.length,
      symbols: candidates
        .slice(0, MAX_SYMBOL_LOGS)
        .map(c => `${c.symbol}_${c.side}_${c.stage}_${c.flow}_${Math.round(c.moveScore || 0)}`),
    });

    throw error;
  }

  const analyzePersist = await persistRunnerAnalyzeActions({
    latest,
    rawResult,
    now,
    requestId,
  });

  const result = compactTradeSystemResult(rawResult);

  const updated = buildTradeFunnelPayload({
    latest,
    selection,
    result,
    mode: "run",
    analyzePersist,
    now,
    requestId,
    trace: {
      requestId,
      mode: "run",
      notify,
      store,
      rawCount: selection.rawCount,
      acceptedCount: selection.candidates.length,
      rejectCounts: normalizeCounterMap(selection.rejectCounts),
      runnerDurationMs,
      totalDurationMs: Date.now() - startedAt,
      runnerRunId: rawResult?.runId || null,
      actionSummary: summarizeActions(rawResult?.actions),
      openPositionsRaw: safeArray(rawResult?.openPositions).length,
      openPositionsStored: safeArray(result?.openPositions).length,
      analyzePersist,
    },
  });

  if (store) {
    routeLog("LATEST_SCAN_STORE_START", {
      requestId,
      mode,
      actionsStored: safeArray(result?.actions).length,
      openPositionsRaw: safeArray(rawResult?.openPositions).length,
      openPositionsStored: safeArray(result?.openPositions).length,
    });

    await setLatestScan(updated);

    routeLog("LATEST_SCAN_STORE_DONE", {
      requestId,
      mode,
      durationMs: Date.now() - startedAt,
    });
  } else {
    routeLog("LATEST_SCAN_STORE_SKIPPED", {
      requestId,
      reason: "STORE_FALSE",
    });
  }

  routeLog("RUN_TRADE_FUNNEL_DONE", {
    requestId,
    mode: "run",
    durationMs: Date.now() - startedAt,
    rawCount: selection.rawCount,
    acceptedCount: selection.candidates.length,
    actionSummary: summarizeActions(rawResult?.actions),
    openPositionsRaw: safeArray(rawResult?.openPositions).length,
    openPositionsStored: safeArray(result?.openPositions).length,
    analyzePersist,
  });

  return updated;
}

// ================= HANDLER =================

export default async function handler(req, res) {
  const startedAt = Date.now();
  const requestId = createRequestId("trade_funnel_request");

  setNoStoreHeaders(res, requestId);

  try {
    const action = normalizeAction(req);

    const notify = normalizeNotify(
      firstDefined(
        getQueryParam(req, "notify", undefined),
        getBodyValue(req, "notify", undefined)
      ),
      true
    );

    const store = normalizeStore(
      firstDefined(
        getQueryParam(req, "store", undefined),
        getBodyValue(req, "store", undefined)
      ),
      true
    );

    const shouldRun = shouldRunRequest(req);

    routeLog("REQUEST_START", {
      requestId,
      method: req?.method || null,
      url: req?.url || null,
      action: action || null,
      shouldRun,
      notify,
      store,
      autoRunDefault: RUNNER_AUTO_RUN,
      routeLogsEnabled: TRADE_FUNNEL_ROUTE_LOG,
      routeDebugEnabled: TRADE_FUNNEL_ROUTE_DEBUG,
    });

    const data = await runTradeFunnel({
      requestId,
      notify,
      store,
      mode: shouldRun ? "run" : "read_only",
    });

    routeLog("REQUEST_DONE", {
      requestId,
      status: 200,
      mode: data?.tradeFunnelMode || null,
      busy: Boolean(data?.tradeFunnelBusy),
      durationMs: Date.now() - startedAt,
      inputCount: safeNumber(data?.tradeFunnelInputCount, 0),
      rawCount: safeNumber(data?.tradeFunnelRawCount, 0),
      openPositionsStored: safeArray(data?.tradeSystemResult?.openPositions).length,
      actionSummary: data?.tradeSystemResult?.actionSummary || null,
    });

    return res.status(200).json(data);
  } catch (error) {
    routeError("REQUEST_FAILED", error, {
      requestId,
      method: req?.method || null,
      url: req?.url || null,
      durationMs: Date.now() - startedAt,
    });

    return res.status(500).json({
      ok: false,
      profile: SYSTEM_PROFILE,
      requestId,
      error: error?.message || "trade_funnel_failed",
      servedAt: Date.now(),
    });
  }
}