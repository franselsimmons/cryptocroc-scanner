import { getLatestScan, setLatestScan } from "../lib/scanStore.js";
import { processTrades } from "../lib/tradeSystem.js";

const SYSTEM_PROFILE = "RUNNER";

const MAX_STORED_ENTRY_ROWS = 250;
const MAX_STORED_REJECT_ROWS = 500;
const MAX_STORED_TRADE_ROWS = 500;

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

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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
  map[key] = (map[key] || 0) + 1;
}

function stageRank(stage) {
  if (stage === "entry") return 3;
  if (stage === "almost") return 2;
  if (stage === "buildup") return 1;
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

// ================= RUNNER TRADE-FUNNEL GATE =================
function passesTradeFunnelGate(coin) {
  const symbol = String(coin.symbol || "").toUpperCase().trim();
  const side = String(coin.side || "").toLowerCase().trim();
  const stage = String(coin.stage || "").toLowerCase();
  const flow = String(coin.flow || "NEUTRAL").toUpperCase();

  const score = safeNumber(coin.moveScore, 0);
  const vm = safeNumber(coin.vm, 0);
  const tfScore = safeNumber(coin.tfScore, 0);
  const tfStrength = safeNumber(coin.tfStrength, Math.abs(tfScore));
  const freshness = safeNumber(coin.freshness, 0);
  const runnerPressure = getRunnerPressure(coin);
  const runnerAcceleration = getRunnerAcceleration(coin);

  if (!symbol) {
    return { ok: false, reason: "NO_SYMBOL" };
  }

  if (side !== "bull" && side !== "bear") {
    return { ok: false, reason: "BAD_SIDE" };
  }

  if (Boolean(coin.uiOnly)) {
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
function getTradeFunnelCandidates(latest) {
  const buckets = [
    ...safeArray(latest?.funnel?.bull?.entry),
    ...safeArray(latest?.funnel?.bear?.entry),
    ...safeArray(latest?.funnel?.bull?.almost),
    ...safeArray(latest?.funnel?.bear?.almost)
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

function trimDashboardRows(stats) {
  if (!stats) return stats;

  return {
    ...stats,
    entryRows: safeArray(stats.entryRows).slice(-MAX_STORED_ENTRY_ROWS),
    rejectedRows: safeArray(stats.rejectedRows).slice(-MAX_STORED_REJECT_ROWS),
    tradeRows: safeArray(stats.tradeRows).slice(-MAX_STORED_TRADE_ROWS)
  };
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

    trades,
    tradeSystemResult: result,

    tradeFunnelProfile: SYSTEM_PROFILE,
    tradeFunnelInputCount: candidates.length,
    tradeFunnelRawCount: selection.rawCount,
    tradeFunnelRejectCounts: selection.rejectCounts,
    tradeFunnelInputSymbols: candidates.map(c => {
      return `${c.symbol}_${c.side}_${c.stage}_${c.flow}_${Math.round(c.moveScore || 0)}`;
    }),

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

    const notify = normalizeNotify(req?.query?.notify);
    const store = normalizeStore(req?.query?.store, true);

    const data = await runTradeFunnel({ notify, store });

    return res.status(200).json(data);
  } catch (e) {
    console.error("RUNNER TRADE-FUNNEL ERROR:", e);

    return res.status(500).json({
      ok: false,
      profile: SYSTEM_PROFILE,
      error: e.message
    });
  }
}