import { getLatestScan, setLatestScan } from "../lib/scanStore.js";
import { processTrades } from "../lib/tradeSystem.js";

const SYSTEM_PROFILE = "RUNNER";

const MAX_STORED_ENTRY_ROWS = 250;
const MAX_STORED_REJECT_ROWS = 500;
const MAX_STORED_TRADE_ROWS = 500;
const MAX_STORED_RESULT_ACTIONS = 150;
const MAX_STORED_OPEN_POSITIONS = 100;

const RUNNER_FLOWS = new Set([
  "SQUEEZE",
  "RUNNING",
  "BREAKOUT",
  "BUILDING"
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

function normalizeNotify(value) {
  const v = String(value || "").toLowerCase().trim();
  return v === "true" || v === "1" || v === "yes";
}

function normalizeStore(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;

  const v = String(value || "").toLowerCase().trim();

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

function getRunnerPressure(coin) {
  if (Number.isFinite(Number(coin?.runnerPressure))) {
    return Number(coin.runnerPressure);
  }

  const side = String(coin?.side || "").toLowerCase();
  const dir = side === "bear" ? -1 : 1;

  const ch24 = safeNumber(coin?.change24, 0) * dir;
  const ch1 = safeNumber(coin?.change1h, 0) * dir;

  return (ch1 * 0.78) + (ch24 * 0.22);
}

function getRunnerAcceleration(coin) {
  if (Number.isFinite(Number(coin?.runnerAcceleration))) {
    return Number(coin.runnerAcceleration);
  }

  const side = String(coin?.side || "").toLowerCase();
  const dir = side === "bear" ? -1 : 1;

  const ch24 = safeNumber(coin?.change24, 0) * dir;
  const ch1 = safeNumber(coin?.change1h, 0) * dir;
  const hourlyTrendBaseline = ch24 / 24;

  return ch1 - hourlyTrendBaseline;
}

function candidateQualityScore(c) {
  const score = safeNumber(c?.moveScore, 0);
  const vm = safeNumber(c?.vm, 0);
  const tfStrength = safeNumber(c?.tfStrength, Math.abs(safeNumber(c?.tfScore, 0)));
  const stage = String(c?.stage || "").toLowerCase();
  const flow = String(c?.flow || "NEUTRAL").toUpperCase();
  const freshness = safeNumber(c?.freshness, 0);
  const pressure = safeNumber(c?.runnerPressure, getRunnerPressure(c));
  const acceleration = safeNumber(c?.runnerAcceleration, getRunnerAcceleration(c));

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

  if (s === "bull" || s === "long" || s === "buy") return "bull";
  if (s === "bear" || s === "short" || s === "sell") return "bear";

  return "";
}

// ================= REQUEST PARAMS WITHOUT req.query =================
// Fix voor Vercel/Node DEP0169 warning:
// niet meer req.query lezen, want die getter triggert intern url.parse().

function getRequestUrl(req) {
  const rawUrl = String(req?.url || "/");
  const headers = safeObject(req?.headers);

  const proto = String(
    headers["x-forwarded-proto"] ||
      headers["x-forwarded-protocol"] ||
      "https"
  ).split(",")[0].trim();

  const host = String(
    headers["x-forwarded-host"] ||
      headers.host ||
      "localhost"
  ).split(",")[0].trim();

  return new URL(rawUrl, `${proto}://${host}`);
}

function getBodyParam(req, key) {
  const body = req?.body;

  if (!body) return undefined;

  if (typeof body === "object" && !Array.isArray(body)) {
    return body[key];
  }

  if (typeof body !== "string") return undefined;

  try {
    const parsed = JSON.parse(body);
    return parsed?.[key];
  } catch {
    return undefined;
  }
}

function getRequestParam(req, key, fallback = undefined) {
  try {
    const url = getRequestUrl(req);
    const fromUrl = url.searchParams.get(key);

    if (fromUrl !== null) return fromUrl;
  } catch {}

  const fromBody = getBodyParam(req, key);

  if (fromBody !== undefined) return fromBody;

  return fallback;
}

// ================= RUNNER TRADE-FUNNEL GATE =================

function passesTradeFunnelGate(coin) {
  const symbol = normalizeSymbol(coin?.symbol);
  const side = normalizeSide(coin?.side);
  const stage = String(coin?.stage || "").toLowerCase();
  const flow = String(coin?.flow || "NEUTRAL").toUpperCase();

  const score = safeNumber(coin?.moveScore, 0);
  const vm = safeNumber(coin?.vm, 0);
  const tfScore = safeNumber(coin?.tfScore, 0);
  const tfStrength = safeNumber(coin?.tfStrength, Math.abs(tfScore));
  const freshness = safeNumber(coin?.freshness, 0);
  const runnerPressure = getRunnerPressure(coin);
  const runnerAcceleration = getRunnerAcceleration(coin);

  if (!symbol) {
    return { ok: false, reason: "NO_SYMBOL" };
  }

  if (side !== "bull" && side !== "bear") {
    return { ok: false, reason: "BAD_SIDE" };
  }

  if (Boolean(coin?.uiOnly)) {
    return { ok: false, reason: "UI_ONLY" };
  }

  // Runner-tradesysteem krijgt alleen echte hot buckets.
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

// ================= CANDIDATE SELECTOR =================

function getTradeFunnelBuckets(latest) {
  return [
    ...safeArray(latest?.funnel?.bull?.entry),
    ...safeArray(latest?.funnel?.bear?.entry),
    ...safeArray(latest?.funnel?.bull?.almost),
    ...safeArray(latest?.funnel?.bear?.almost)
  ];
}

function getTradeFunnelCandidates(latest) {
  const buckets = getTradeFunnelBuckets(latest);

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
    const flow = String(coin.flow || "NEUTRAL").toUpperCase();

    const score = safeNumber(coin.moveScore, 0);
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
        vm,
        tfScore,
        tfStrength,
        runnerPressure,
        runnerAcceleration
      })
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

  console.log("RUNNER TRADE FUNNEL raw:", buckets.length);
  console.log("RUNNER TRADE FUNNEL accepted:", result.length);
  console.log("RUNNER TRADE FUNNEL rejected:", rejectCounts);
  console.log(
    "RUNNER TRADE FUNNEL symbols:",
    result.map(c => {
      return `${c.symbol}_${c.side}_${c.stage}_${c.flow}_${Math.round(c.moveScore)}`;
    }).join(", ")
  );

  return {
    candidates: result,
    rejectCounts,
    rawCount: buckets.length
  };
}

// ================= STORE COMPACTION =================

function trimDashboardRows(stats) {
  if (!stats) return stats;

  return {
    ...stats,
    entryRows: safeArray(stats.entryRows).slice(-MAX_STORED_ENTRY_ROWS),
    rejectedRows: safeArray(stats.rejectedRows).slice(-MAX_STORED_REJECT_ROWS),
    tradeRows: safeArray(stats.tradeRows).slice(-MAX_STORED_TRADE_ROWS)
  };
}

function compactFinalFilterDecision(decision) {
  if (!decision || typeof decision !== "object") return null;

  return {
    tag: decision.tag || "RUNNER_MASTER_BEST_AFSTELLING",
    decision: decision.decision || null,
    objective: decision.objective || null,
    sample: decision.sample || null,
    mapping: decision.mapping || null,
    coverage: decision.coverage || null,

    bestA: decision.bestA
      ? {
          target: decision.bestA.target,
          decision: decision.bestA.decision,
          sample: decision.bestA.sample,
          expectedPerformance: decision.bestA.expectedPerformance,
          deltaVsCurrent: decision.bestA.deltaVsCurrent,
          changedKeys: safeArray(decision.bestA.changedKeys).slice(0, 30),
          coverage: decision.bestA.coverage
        }
      : null,

    bestB: decision.bestB
      ? {
          target: decision.bestB.target,
          decision: decision.bestB.decision,
          sample: decision.bestB.sample,
          expectedPerformance: decision.bestB.expectedPerformance,
          deltaVsCurrent: decision.bestB.deltaVsCurrent,
          changedKeys: safeArray(decision.bestB.changedKeys).slice(0, 30),
          coverage: decision.bestB.coverage
        }
      : null,

    bestCombined: decision.bestCombined
      ? {
          target: decision.bestCombined.target,
          decision: decision.bestCombined.decision,
          sample: decision.bestCombined.sample,
          expectedPerformance: decision.bestCombined.expectedPerformance,
          deltaVsCurrent: decision.bestCombined.deltaVsCurrent,
          changedKeys: safeArray(decision.bestCombined.changedKeys).slice(0, 30),
          coverage: decision.bestCombined.coverage
        }
      : null,

    recommendedLiveAfstelling: decision.recommendedLiveAfstelling || null,
    patchLines: safeArray(decision.patchLines).slice(0, 80),
    ts: decision.ts || Date.now()
  };
}

function compactCohortLearning(cohortLearning) {
  if (!cohortLearning || typeof cohortLearning !== "object") return null;

  return {
    tag: cohortLearning.tag || "RUNNER_COHORT_LEARNING_REPORT",
    strategyVersion: cohortLearning.strategyVersion || null,
    ts: cohortLearning.ts || Date.now(),
    sample: cohortLearning.sample || null,
    summary: cohortLearning.summary || null,
    allowCandidates: safeArray(cohortLearning.allowCandidates).slice(0, 10),
    blockCandidates: safeArray(cohortLearning.blockCandidates).slice(0, 10),
    watchBlockCandidates: safeArray(cohortLearning.watchBlockCandidates).slice(0, 10),
    codePatch: {
      DISCORD_ALLOWED_COHORTS: safeArray(cohortLearning?.codePatch?.DISCORD_ALLOWED_COHORTS).slice(0, 20),
      DISCORD_BLOCKED_COHORTS: safeArray(cohortLearning?.codePatch?.DISCORD_BLOCKED_COHORTS).slice(0, 20),
      WATCH_BLOCK_COHORTS: safeArray(cohortLearning?.codePatch?.WATCH_BLOCK_COHORTS).slice(0, 20)
    }
  };
}

function compactRunnerStats(runnerStats) {
  if (!runnerStats || typeof runnerStats !== "object") return runnerStats;

  return {
    profile: runnerStats.profile || SYSTEM_PROFILE,
    strategyVersion: runnerStats.strategyVersion || null,

    runs: safeNumber(runnerStats.runs, 0),
    entries: safeNumber(runnerStats.entries, 0),
    partials: safeNumber(runnerStats.partials, 0),
    movesToBE: safeNumber(runnerStats.movesToBE, 0),
    trails: safeNumber(runnerStats.trails, 0),
    adds: safeNumber(runnerStats.adds, 0),
    exits: safeNumber(runnerStats.exits, 0),

    wins: safeNumber(runnerStats.wins, 0),
    losses: safeNumber(runnerStats.losses, 0),
    winrate: safeNumber(runnerStats.winrate, 0),

    totalR: safeNumber(runnerStats.totalR, 0),
    avgR: safeNumber(runnerStats.avgR, 0),
    totalPnlPct: safeNumber(runnerStats.totalPnlPct, 0),
    avgPnlPct: safeNumber(runnerStats.avgPnlPct, 0),

    openPositions: safeNumber(runnerStats.openPositions, 0),

    waitReasons: safeObject(runnerStats.waitReasons),
    entryTypes: safeObject(runnerStats.entryTypes),
    actionCounts: safeObject(runnerStats.actionCounts),

    closedTrades: safeArray(runnerStats.closedTrades).slice(-25),
    featureRows: safeArray(runnerStats.featureRows).slice(-40),
    shadowRows: safeArray(runnerStats.shadowRows).slice(-40),

    finalFilterDecision: compactFinalFilterDecision(runnerStats.finalFilterDecision),
    cohortLearning: compactCohortLearning(runnerStats.cohortLearning),

    durableEnabled: Boolean(runnerStats.durableEnabled),
    durableLoadedAt: safeNumber(runnerStats.durableLoadedAt, 0),
    durableSavedAt: safeNumber(runnerStats.durableSavedAt, 0),

    servedAt: runnerStats.servedAt || Date.now()
  };
}

function compactTradeSystemResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }

  return {
    ...result,
    actions: safeArray(result.actions).slice(-MAX_STORED_RESULT_ACTIONS),
    openPositions: safeArray(result.openPositions).slice(-MAX_STORED_OPEN_POSITIONS),
    runnerStats: compactRunnerStats(result.runnerStats)
  };
}

function buildTradeFunnelInputSymbols(candidates) {
  return safeArray(candidates).map(c => {
    return `${c.symbol}_${c.side}_${c.stage}_${c.flow}_${Math.round(c.moveScore || 0)}`;
  });
}

// ================= CORE =================

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

  const result = candidates.length
    ? await processTrades(candidates, {
        notify,
        log: true,
        profile: SYSTEM_PROFILE,
        runner: true,
        btc: latest.btc,
        regime: latest.regime,
        market: latest.market
      })
    : {
        ok: true,
        actions: [],
        candidatesCount: 0,
        profile: SYSTEM_PROFILE,
        reason: "no_runner_candidates"
      };

  const trades = Array.isArray(result)
    ? result
    : Array.isArray(result?.actions)
      ? result.actions
      : [];

  const updated = {
    ...latest,
    ok: true,
    scannerProfile: latest?.scannerProfile || SYSTEM_PROFILE,

    trades: trades.slice(-MAX_STORED_TRADE_ROWS),
    tradeSystemResult: compactTradeSystemResult(result),

    tradeFunnelProfile: SYSTEM_PROFILE,
    tradeFunnelInputCount: candidates.length,
    tradeFunnelRawCount: selection.rawCount,
    tradeFunnelRejectCounts: selection.rejectCounts,
    tradeFunnelInputSymbols: buildTradeFunnelInputSymbols(candidates),

    dashboardStats: trimDashboardRows(latest?.dashboardStats),

    tradeFunnelUpdatedAt: now,
    updatedAt: now
  };

  if (store) {
    await setLatestScan(updated);
  }

  return updated;
}

// ================= HANDLER =================

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store, max-age=0");

    const notify = normalizeNotify(getRequestParam(req, "notify", ""));
    const store = normalizeStore(getRequestParam(req, "store", undefined), true);

    const data = await runTradeFunnel({
      notify,
      store
    });

    return res.status(200).json(data);
  } catch (e) {
    console.error("RUNNER TRADE-FUNNEL ERROR:", e);

    return res.status(500).json({
      ok: false,
      profile: SYSTEM_PROFILE,
      error: e?.message || "runner_trade_funnel_failed",
      servedAt: Date.now()
    });
  }
}