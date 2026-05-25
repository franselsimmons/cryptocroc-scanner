import { getLatestScan, setLatestScan } from "../lib/scanStore.js";
import { processTrades } from "../lib/tradeSystem.js";

const SYSTEM_PROFILE = "RUNNER";

const MAX_STORED_ENTRY_ROWS = 250;
const MAX_STORED_REJECT_ROWS = 500;
const MAX_STORED_TRADE_ROWS = 500;
const MAX_STORED_ACTIONS = 250;
const MAX_STORED_OPEN_POSITIONS = 100;
const MAX_SYMBOL_LOGS = 80;

const RUNNER_FLOWS = new Set([
  "SQUEEZE",
  "RUNNING",
  "BREAKOUT",
  "BUILDING",
]);

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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

function flowRank(flow) {
  const f = String(flow || "").toUpperCase();

  if (f === "SQUEEZE") return 4;
  if (f === "RUNNING") return 3;
  if (f === "BREAKOUT") return 2;
  if (f === "BUILDING") return 1;

  return 0;
}

function normalizeCounterMap(map) {
  const out = {};

  for (const [key, value] of Object.entries(map || {})) {
    const n = Math.round(Number(value || 0));
    if (n > 0) out[String(key)] = n;
  }

  return out;
}

function getRunnerPressure(coin) {
  if (Number.isFinite(Number(coin?.runnerPressure))) {
    return Number(coin.runnerPressure);
  }

  const side = String(coin?.side || "").toLowerCase();
  const dir = side === "bear" ? -1 : 1;

  const ch24 = Number(coin?.change24 || 0) * dir;
  const ch1 = Number(coin?.change1h || 0) * dir;

  return (ch1 * 0.78) + (ch24 * 0.22);
}

function getRunnerAcceleration(coin) {
  if (Number.isFinite(Number(coin?.runnerAcceleration))) {
    return Number(coin.runnerAcceleration);
  }

  const side = String(coin?.side || "").toLowerCase();
  const dir = side === "bear" ? -1 : 1;

  const ch24 = Number(coin?.change24 || 0) * dir;
  const ch1 = Number(coin?.change1h || 0) * dir;
  const hourlyTrendBaseline = ch24 / 24;

  return ch1 - hourlyTrendBaseline;
}

function candidateQualityScore(c) {
  const score = safeNumber(c.moveScore, 0);
  const vm = safeNumber(c.vm, 0);
  const tfStrength = safeNumber(c.tfStrength, Math.abs(safeNumber(c.tfScore, 0)));
  const stage = String(c.stage || "").toLowerCase();
  const flow = String(c.flow || "NEUTRAL").toUpperCase();
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
  const symbol = String(coin.symbol || "").toUpperCase().trim();
  const side = String(coin.side || "").toLowerCase().trim();
  const stage = String(coin.stage || "").toLowerCase();
  const flow = String(coin.flow || coin.scannerFlow || "NEUTRAL").toUpperCase();

  const score = safeNumber(coin.moveScore ?? coin.score, 0);
  const vm = safeNumber(coin.vm, 0);
  const tfScore = safeNumber(coin.tfScore, 0);
  const tfStrength = safeNumber(coin.tfStrength, Math.abs(tfScore));
  const freshness = safeNumber(coin.freshness, 0);
  const runnerPressure = getRunnerPressure(coin);
  const runnerAcceleration = getRunnerAcceleration(coin);

  if (!symbol) return { ok: false, reason: "NO_SYMBOL" };

  if (side !== "bull" && side !== "bear") {
    return { ok: false, reason: "BAD_SIDE" };
  }

  if (Boolean(coin.uiOnly)) {
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

    const symbol = String(coin.symbol || "").toUpperCase().trim();
    const side = String(coin.side || "").toLowerCase().trim();
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
        .map(c => `${c.symbol}_${c.side}_${c.stage}_${c.flow}_${Math.round(c.moveScore)}`)
        .join(", ")
    );
  }

  return {
    candidates: result,
    rejectCounts,
    rawCount: buckets.length,
  };
}

function compactTradeRow(row) {
  if (!row || typeof row !== "object") return row;

  return {
    profile: row.profile || SYSTEM_PROFILE,
    strategyVersion: row.strategyVersion,

    symbol: row.symbol,
    side: row.side,

    action: row.action,
    reason: row.reason,
    setupClass: row.setupClass,
    entryType: row.entryType || row.runnerEntryType,
    runnerEntryType: row.runnerEntryType || row.entryType,
    grade: row.grade,

    entry: row.entry,
    sl: row.sl,
    initialSl: row.initialSl,
    tp: row.tp,
    partialTp: row.partialTp,
    breakevenAt: row.breakevenAt,
    trailStart: row.trailStart,

    rr: row.rr,
    plannedRR: row.plannedRR,
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

    currentR: row.currentR,
    mfeR: row.mfeR,
    maeR: row.maeR,

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
    ts: row.ts,
  };
}

function compactOpenPosition(pos) {
  return {
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

  const stats = result.runnerStats || {};

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

export async function runTradeFunnel(options = {}) {
  const notify = options.notify !== false;
  const store = options.store !== false;

  const latest = await getLatestScan();

  if (!latest?.ok) {
    throw new Error("no_latest_scan_available");
  }

  const selection = getTradeFunnelCandidates(latest);
  const candidates = selection.candidates;
  const now = Date.now();

  const rawResult = candidates.length
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

  const result = compactTradeSystemResult(rawResult);

  const trades = safeArray(result.actions);

  const updated = {
    ...latest,
    ok: true,
    scannerProfile: latest?.scannerProfile || SYSTEM_PROFILE,

    trades,
    tradeSystemResult: result,

    tradeFunnelProfile: SYSTEM_PROFILE,
    tradeFunnelInputCount: candidates.length,
    tradeFunnelRawCount: selection.rawCount,
    tradeFunnelRejectCounts: selection.rejectCounts,
    tradeFunnelInputSymbols: candidates
      .slice(0, MAX_SYMBOL_LOGS)
      .map(c => `${c.symbol}_${c.side}_${c.stage}_${c.flow}_${Math.round(c.moveScore || 0)}`),

    dashboardStats: trimDashboardRows(latest?.dashboardStats),

    tradeFunnelUpdatedAt: now,
    updatedAt: now,
  };

  if (store) {
    await setLatestScan(updated);
  }

  return updated;
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store, max-age=0");

    const notify = normalizeNotify(getQueryParam(req, "notify", ""));
    const store = normalizeStore(getQueryParam(req, "store", undefined), true);

    const data = await runTradeFunnel({
      notify,
      store,
    });

    return res.status(200).json(data);
  } catch (e) {
    console.error("RUNNER TRADE-FUNNEL ERROR:", e);

    return res.status(500).json({
      ok: false,
      profile: SYSTEM_PROFILE,
      error: e?.message || "trade_funnel_failed",
      servedAt: Date.now(),
    });
  }
}