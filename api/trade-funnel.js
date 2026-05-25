import { getLatestScan, setLatestScan } from "../lib/scanStore.js";
import { processTrades } from "../lib/tradeSystem.js";

import {
  appendRunnerAnalyzeEvents,
} from "../lib/analyze/runnerAnalyzeStore.js";

const SYSTEM_PROFILE = "RUNNER";

const MAX_STORED_ENTRY_ROWS = 250;
const MAX_STORED_REJECT_ROWS = 500;
const MAX_STORED_TRADE_ROWS = 500;
const MAX_STORED_ACTIONS = 250;
const MAX_STORED_OPEN_POSITIONS = 100;
const MAX_SYMBOL_LOGS = 80;

const RUNNER_ANALYZE_PERSIST =
  String(process.env.RUNNER_ANALYZE_PERSIST || "true").toLowerCase() !== "false";

const RUNNER_FLOWS = new Set([
  "SQUEEZE",
  "RUNNING",
  "BREAKOUT",
  "BUILDING",
]);

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
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function nullableNumber(value) {
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

function normalizeNotify(value) {
  return normalizeBoolean(value, false);
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

function buildDedupeKey(row) {
  return [
    normalizeSymbol(row?.symbol),
    normalizeSide(row?.side),
    normalizeText(row?.action),
    row?.tradeId || row?.positionTradeId || "",
    row?.entry ?? "",
    row?.exit ?? row?.exitPrice ?? row?.executionPrice ?? "",
    row?.exitR ?? row?.realizedR ?? row?.pnlR ?? "",
    row?.closedAt ?? row?.exitedAt ?? row?.ts ?? "",
  ].join("|");
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

  if (String(process.env.RUNNER_DEBUG || "false").toLowerCase() === "true") {
    console.log("RUNNER TRADE FUNNEL raw:", buckets.length);
    console.log("RUNNER TRADE FUNNEL accepted:", result.length);
    console.log("RUNNER TRADE FUNNEL rejected:", rejectCounts);
    console.log(
      "RUNNER TRADE FUNNEL symbols:",
      result
        .slice(0, MAX_SYMBOL_LOGS)
        .map(c => `${c.symbol}_${c.side}_${c.stage}_${c.flow}_${Math.round(c.moveScore || 0)}`)
        .join(", ")
    );
  }

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

    symbol: row.symbol,
    side: row.side,

    action: row.action,
    reason: row.reason,
    setupClass: row.setupClass,
    entryType: row.entryType || row.runnerEntryType,
    runnerEntryType: row.runnerEntryType || row.entryType,
    grade: row.grade,

    entry: row.entry,
    entryPrice: row.entryPrice,
    openPrice: row.openPrice,

    sl: row.sl,
    initialSl: row.initialSl,
    tp: row.tp,
    partialTp: row.partialTp,
    breakevenAt: row.breakevenAt,
    trailStart: row.trailStart,

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
    pnlR: row.pnlR,
    pnlPct: row.pnlPct,
    exitReason: row.exitReason,

    closed: row.closed,
    closedAt: row.closedAt,
    openedAt: row.openedAt,
    entryTs: row.entryTs,
    createdAt: row.createdAt,
    exitedAt: row.exitedAt,
    ts: row.ts,
  };
}

function compactOpenPosition(pos) {
  if (!pos || typeof pos !== "object") return pos;

  return {
    tradeId: pos.tradeId,
    positionTradeId: pos.positionTradeId,

    symbol: pos.symbol,
    side: pos.side,
    setupClass: pos.setupClass,
    entryType: pos.entryType || pos.runnerEntryType,
    runnerEntryType: pos.runnerEntryType || pos.entryType,
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
    adds: safeNumber(pos.adds, 0),

    createdAt: pos.createdAt,
    updatedAt: pos.updatedAt,
  };
}

function compactTradeSystemResult(result) {
  if (!result || typeof result !== "object") {
    return {
      profile: SYSTEM_PROFILE,
      ok: true,
      actions: [],
      candidatesCount: 0,
      reason: "no_runner_candidates",
    };
  }

  const stats = safeObject(result.runnerStats);

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
    openPositions: safeArray(result.openPositions)
      .slice(-MAX_STORED_OPEN_POSITIONS)
      .map(compactOpenPosition),

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

      openPositions: safeNumber(stats.openPositions, 0),

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

  if (row?.closed === true) return true;

  if (
    row?.exit !== undefined ||
    row?.exitPrice !== undefined ||
    row?.executionPrice !== undefined ||
    row?.exitR !== undefined ||
    row?.realizedR !== undefined ||
    row?.pnlR !== undefined ||
    row?.pnlPct !== undefined
  ) {
    return true;
  }

  return false;
}

function getAnalyzeLifecycle(row) {
  const action = getRowAction(row);

  if (action === "ENTRY") return "ENTRY";
  if (action === "EXIT") return "EXIT";

  if (
    row?.closed === true ||
    row?.exit !== undefined ||
    row?.exitPrice !== undefined ||
    row?.executionPrice !== undefined ||
    row?.exitR !== undefined ||
    row?.realizedR !== undefined ||
    row?.pnlR !== undefined ||
    row?.pnlPct !== undefined
  ) {
    return "EXIT";
  }

  return "";
}

function buildStableAnalyzeTradeId(row) {
  const direct =
    row?.tradeId ||
    row?.positionTradeId ||
    row?.positionId ||
    row?.orderId ||
    row?.clientOrderId;

  if (direct) return String(direct);

  const symbol = normalizeSymbol(row?.symbol);
  const side = normalizeAnalyzeSide(row?.side);
  const entry = nullableNumber(row?.entry ?? row?.entryPrice ?? row?.openPrice);

  if (!symbol || !side || !entry) return "";

  return `RUNNER_${symbol}_${side}_${Number(entry).toPrecision(12)}`;
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

    familyId: row.familyId || null,
    runnerFamilyId: row.runnerFamilyId || row.familyId || null,
    analyzeFamilyId: row.analyzeFamilyId || row.familyId || null,
    analysisFamilyId: row.analysisFamilyId || row.familyId || null,

    filterSnapshot: {
      ...safeObject(row.filterSnapshot),

      profile: SYSTEM_PROFILE,
      runnerProfile: SYSTEM_PROFILE,

      familyId: row.familyId || row.runnerFamilyId || row.analyzeFamilyId || null,
      runnerFamilyId: row.runnerFamilyId || row.familyId || null,
      analyzeFamilyId: row.analyzeFamilyId || row.familyId || null,

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

function collectAnalyzeInputRows(latest, rawResult) {
  const rows = [];

  rows.push(...safeArray(latest?.trades));
  rows.push(...safeArray(latest?.tradeSystemResult?.actions));
  rows.push(...safeArray(latest?.tradeSystemResult?.runnerStats?.closedTrades));

  rows.push(...safeArray(rawResult?.actions));
  rows.push(...safeArray(rawResult?.runnerStats?.closedTrades));

  const map = new Map();

  for (const row of rows) {
    if (!row) continue;
    map.set(buildDedupeKey(row), row);
  }

  return Array.from(map.values());
}

async function persistRunnerAnalyzeActions({ latest, rawResult, now }) {
  if (!RUNNER_ANALYZE_PERSIST) {
    return {
      ok: true,
      skipped: true,
      reason: "RUNNER_ANALYZE_PERSIST_FALSE",
      received: 0,
      accepted: 0,
    };
  }

  const inputRows = collectAnalyzeInputRows(latest, rawResult);

  const events = inputRows
    .map(row => buildRunnerAnalyzeEvent(row, latest, now))
    .filter(Boolean);

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
}) {
  const funnel = compactFunnel(latest?.funnel || emptyFunnel());
  const compactResult = compactTradeSystemResult(result || latest?.tradeSystemResult);

  const trades = safeArray(
    result?.actions?.length ? result.actions : latest?.trades
  )
    .slice(-MAX_STORED_ACTIONS)
    .map(compactTradeRow);

  return {
    ok: true,
    profile: SYSTEM_PROFILE,
    scannerProfile: latest?.scannerProfile || SYSTEM_PROFILE,

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
  const notify = options.notify !== false;
  const store = options.store !== false;
  const mode = options.mode || "read_only";
  const now = Date.now();

  const latest = await getLatestScan();

  if (!latest?.ok) {
    throw new Error("no_latest_scan_available");
  }

  const selection = getTradeFunnelCandidates(latest);

  if (mode !== "run") {
    return buildTradeFunnelPayload({
      latest,
      selection,
      mode: "read_only",
      now,
    });
  }

  const candidates = selection.candidates;

  let rawResult = null;

  try {
    rawResult = candidates.length
      ? await processTrades(candidates, {
          notify,
          log: true,
          profile: SYSTEM_PROFILE,
          runner: true,
          btc: latest.btc,
          regime: latest.regime,
          market: latest.market,
        })
      : {
          ok: true,
          actions: [],
          candidatesCount: 0,
          profile: SYSTEM_PROFILE,
          reason: "no_runner_candidates",
        };
  } catch (error) {
    if (isLockBusyError(error)) {
      return buildTradeFunnelPayload({
        latest,
        selection,
        mode: "read_only",
        busy: true,
        error: "RUNNER_TRADE_SYSTEM_LOCK_BUSY",
        now,
      });
    }

    throw error;
  }

  const analyzePersist = await persistRunnerAnalyzeActions({
    latest,
    rawResult,
    now,
  });

  const result = compactTradeSystemResult(rawResult);

  const updated = buildTradeFunnelPayload({
    latest,
    selection,
    result,
    mode: "run",
    analyzePersist,
    now,
  });

  if (store) {
    await setLatestScan(updated);
  }

  return updated;
}

// ================= HANDLER =================

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store, max-age=0");

    const action = normalizeAction(req);
    const notify = normalizeNotify(getQueryParam(req, "notify", ""));
    const store = normalizeStore(getQueryParam(req, "store", undefined), true);

    const shouldRun =
      action === "run" ||
      action === "execute" ||
      normalizeBoolean(getQueryParam(req, "run", ""), false);

    const data = await runTradeFunnel({
      notify,
      store,
      mode: shouldRun ? "run" : "read_only",
    });

    return res.status(200).json(data);
  } catch (error) {
    console.error("RUNNER TRADE-FUNNEL ERROR:", error);

    return res.status(500).json({
      ok: false,
      profile: SYSTEM_PROFILE,
      error: error?.message || "trade_funnel_failed",
      servedAt: Date.now(),
    });
  }
}