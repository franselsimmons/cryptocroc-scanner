import { getLatestScan, setLatestScan } from "../lib/scanStore.js";

const SYSTEM_PROFILE = "RUNNER";
const STAGES = ["entry", "almost", "buildup", "radar"];

const MAX_PUBLIC_TRADES = 250;
const MAX_PUBLIC_ROWS = 250;

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

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

function emptyDashboardStats(now = Date.now()) {
  return {
    startedAt: now,
    lastResetAt: now,
    lastScanAt: 0,

    totalScans: 0,
    totalEntries: 0,
    totalRejected: 0,
    totalOtherTrades: 0,
    totalFunnelCoins: 0,
    totalCandidates: 0,

    lastEntries: 0,
    lastRejected: 0,
    lastOtherTrades: 0,
    lastFunnelCoins: 0,
    lastCandidates: 0,

    rejectReasonCounts: {},
    actionCounts: {},

    entryRows: [],
    rejectedRows: [],
    tradeRows: [],
  };
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

function normalizeCounterMap(map) {
  const out = {};

  for (const [key, value] of Object.entries(map || {})) {
    const n = Math.round(Number(value || 0));
    if (n > 0) out[String(key)] = n;
  }

  return out;
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

  return STAGES.reduce((sum, stage) => {
    return sum + safeArray(f?.[side]?.[stage]).length;
  }, 0);
}

function countFunnel(funnel) {
  return countSide(funnel, "bull") + countSide(funnel, "bear");
}

function getRunnerStageCounts(funnel) {
  return {
    bullEntry: countStage(funnel, "bull", "entry"),
    bullAlmost: countStage(funnel, "bull", "almost"),
    bullBuildup: countStage(funnel, "bull", "buildup"),
    bullRadar: countStage(funnel, "bull", "radar"),

    bearEntry: countStage(funnel, "bear", "entry"),
    bearAlmost: countStage(funnel, "bear", "almost"),
    bearBuildup: countStage(funnel, "bear", "buildup"),
    bearRadar: countStage(funnel, "bear", "radar"),
  };
}

function compactCoin(coin) {
  if (!coin || typeof coin !== "object") return coin;

  return {
    symbol: coin.symbol,
    side: coin.side,
    stage: coin.stage,
    flow: coin.flow || coin.scannerFlow,
    scannerFlow: coin.scannerFlow || coin.flow,

    price: coin.price,
    moveScore: coin.moveScore ?? coin.score,
    score: coin.score ?? coin.moveScore,

    change1h: coin.change1h,
    change24: coin.change24,
    vm: coin.vm,
    freshness: coin.freshness,

    tfScore: coin.tfScore,
    tfStrength: coin.tfStrength,

    runnerPressure: coin.runnerPressure,
    runnerAcceleration: coin.runnerAcceleration,

    updatedAt: coin.updatedAt,
    ts: coin.ts,
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

    currentR: row.currentR,
    mfeR: row.mfeR,
    maeR: row.maeR,

    exit: row.exit,
    exitPrice: row.exitPrice,
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

function compactTradeSystemResult(result) {
  if (!result || typeof result !== "object") return null;

  const actions = safeArray(result.actions).slice(-MAX_PUBLIC_TRADES).map(compactTradeRow);
  const openPositions = safeArray(result.openPositions).slice(-MAX_PUBLIC_ROWS).map(compactTradeRow);
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

    actions,
    openPositions,

    runnerStats: {
      profile: stats.profile || SYSTEM_PROFILE,
      strategyVersion: stats.strategyVersion,

      runs: safeNumber(stats.runs, 0),
      entries: safeNumber(stats.entries, 0),
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
      durableLoadedAt: stats.durableLoadedAt || 0,
      durableSavedAt: stats.durableSavedAt || 0,
      servedAt: stats.servedAt || Date.now(),
    },
  };
}

function normalizeDashboardStats(stats, fallbackPayload = null) {
  const now = Date.now();

  const trades = safeArray(fallbackPayload?.trades);
  const entries = trades.filter(t => String(t?.action || "").toUpperCase() === "ENTRY");
  const waits = trades.filter(t => String(t?.action || "").toUpperCase() === "WAIT");
  const otherTrades = trades.filter(t => {
    const a = String(t?.action || "").toUpperCase();
    return a !== "WAIT" && a !== "ENTRY";
  });

  const base = stats
    ? { ...stats }
    : {
        ...emptyDashboardStats(now),
        lastScanAt: safeNumber(fallbackPayload?.updatedAt, 0),
        lastEntries: entries.length,
        lastRejected: waits.length,
        lastOtherTrades: otherTrades.length,
        lastFunnelCoins: safeNumber(fallbackPayload?.funnelCount, 0),
        lastCandidates: safeNumber(fallbackPayload?.candidates, 0),
      };

  return {
    startedAt: safeNumber(base?.startedAt, now),
    lastResetAt: safeNumber(base?.lastResetAt, base?.startedAt || now),
    lastScanAt: safeNumber(base?.lastScanAt, fallbackPayload?.updatedAt || 0),

    totalScans: safeNumber(base?.totalScans, 0),
    totalEntries: safeNumber(base?.totalEntries, 0),
    totalRejected: safeNumber(base?.totalRejected, 0),
    totalOtherTrades: safeNumber(base?.totalOtherTrades, 0),
    totalFunnelCoins: safeNumber(base?.totalFunnelCoins, 0),
    totalCandidates: safeNumber(base?.totalCandidates, 0),

    lastEntries: safeNumber(base?.lastEntries, entries.length),
    lastRejected: safeNumber(base?.lastRejected, waits.length),
    lastOtherTrades: safeNumber(base?.lastOtherTrades, otherTrades.length),
    lastFunnelCoins: safeNumber(base?.lastFunnelCoins, fallbackPayload?.funnelCount || 0),
    lastCandidates: safeNumber(base?.lastCandidates, fallbackPayload?.candidates || 0),

    rejectReasonCounts: normalizeCounterMap(base?.rejectReasonCounts),
    actionCounts: normalizeCounterMap(base?.actionCounts),

    entryRows: safeArray(base?.entryRows).slice(-MAX_PUBLIC_ROWS).map(compactTradeRow),
    rejectedRows: safeArray(base?.rejectedRows).slice(-MAX_PUBLIC_ROWS).map(compactTradeRow),
    tradeRows: safeArray(base?.tradeRows).slice(-MAX_PUBLIC_ROWS).map(compactTradeRow),
  };
}

function hasStoredScanSinceReset(stats) {
  return (
    safeNumber(stats?.totalScans) > 0 &&
    safeNumber(stats?.lastScanAt) >= safeNumber(stats?.lastResetAt)
  );
}

function hasUsableLatest(payload) {
  if (!payload?.ok) return false;

  const funnel = normalizeFunnel(payload?.funnel);
  const funnelCount = countFunnel(funnel);
  const tradesCount = safeArray(payload?.trades).length;

  if (funnelCount > 0) return true;
  if (tradesCount > 0) return true;
  if (safeNumber(payload?.scannerUpdatedAt, 0) > 0) return true;
  if (safeNumber(payload?.updatedAt, 0) > 0) return true;

  return false;
}

function buildRunnerSummary(payload, funnel) {
  const stageCounts = getRunnerStageCounts(funnel);

  return {
    profile: payload?.scannerProfile || SYSTEM_PROFILE,
    regime: payload?.regime || "UNKNOWN",
    btcState: payload?.btc?.state || "UNKNOWN",

    funnelCount: countFunnel(funnel),
    bullCount: countSide(funnel, "bull"),
    bearCount: countSide(funnel, "bear"),

    candidates: safeNumber(payload?.candidates, 0),
    candidatesBull: safeNumber(payload?.candidatesBull, 0),
    candidatesBear: safeNumber(payload?.candidatesBear, 0),

    ...stageCounts,

    bitgetSymbols: safeNumber(payload?.bitgetSymbols, 0),
    bitgetUniverseReady: Boolean(payload?.bitgetUniverseReady),

    scannerUpdatedAt: payload?.scannerUpdatedAt || null,
    tradeFunnelUpdatedAt: payload?.tradeFunnelUpdatedAt || null,
    updatedAt: payload?.updatedAt || null,
  };
}

function safePayload(payload, source) {
  const funnel = compactFunnel(payload?.funnel);
  const trades = safeArray(payload?.trades).slice(-MAX_PUBLIC_TRADES).map(compactTradeRow);

  const normalizedPayload = {
    ok: payload?.ok !== false,
    source,
    scannerProfile: payload?.scannerProfile || SYSTEM_PROFILE,

    scanReady: Boolean(payload?.scanReady),
    message: payload?.message || null,

    funnel,
    funnelCount: countFunnel(funnel),
    bullCount: countSide(funnel, "bull"),
    bearCount: countSide(funnel, "bear"),

    trades,

    tradeFunnelProfile: payload?.tradeFunnelProfile || SYSTEM_PROFILE,
    tradeFunnelInputCount: safeNumber(payload?.tradeFunnelInputCount, 0),
    tradeFunnelRawCount: safeNumber(payload?.tradeFunnelRawCount, 0),
    tradeFunnelRejectCounts: normalizeCounterMap(payload?.tradeFunnelRejectCounts),
    tradeFunnelInputSymbols: safeArray(payload?.tradeFunnelInputSymbols).slice(-100),

    tradeSystemResult: compactTradeSystemResult(payload?.tradeSystemResult),

    btc: payload?.btc || {
      state: "UNKNOWN",
      chg24: 0,
      chg1h: 0,
      pressure: 0,
    },

    regime: payload?.regime || "UNKNOWN",
    market: payload?.market || null,
    analytics: payload?.analytics || {},
    advice: payload?.advice || {},

    candidates: safeNumber(payload?.candidates, 0),
    candidatesBull: safeNumber(payload?.candidatesBull, 0),
    candidatesBear: safeNumber(payload?.candidatesBear, 0),

    scannerUpdatedAt: payload?.scannerUpdatedAt || null,
    tradeFunnelUpdatedAt: payload?.tradeFunnelUpdatedAt || null,
    updatedAt: payload?.updatedAt || Date.now(),
  };

  const dashboardStats = normalizeDashboardStats(
    payload?.dashboardStats,
    normalizedPayload
  );

  return {
    ...normalizedPayload,
    dashboardStats,
    runnerSummary: buildRunnerSummary(normalizedPayload, funnel),
    hasStoredScanSinceReset: hasStoredScanSinceReset(dashboardStats),
    servedAt: Date.now(),
  };
}

async function resetStoredStats() {
  const latest = await getLatestScan();

  if (!latest?.ok) {
    return {
      ok: true,
      profile: SYSTEM_PROFILE,
      message: "Geen opgeslagen runner-scan om te resetten.",
    };
  }

  const now = Date.now();

  const updated = {
    ...latest,
    scannerProfile: latest?.scannerProfile || SYSTEM_PROFILE,
    dashboardStats: emptyDashboardStats(now),
    statsResetAt: now,
    servedAt: now,
  };

  await setLatestScan(updated);

  return safePayload(updated, "stats_reset");
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store, max-age=0");

    const action = String(
      getQueryParam(req, "action", "") ||
        getBodyValue(req, "action", "")
    )
      .trim()
      .toLowerCase();

    if (req.method === "POST" && action === "resetstats") {
      const resetResult = await resetStoredStats();
      return res.status(200).json(resetResult);
    }

    const latest = await getLatestScan();

    if (hasUsableLatest(latest)) {
      return res.status(200).json(
        safePayload(latest, "latest_runner")
      );
    }

    return res.status(200).json(
      safePayload(
        {
          ok: true,
          scanReady: false,
          scannerProfile: SYSTEM_PROFILE,
          message: "Runner fallback live mode",
          funnel: latest?.funnel || emptyFunnel(),
          trades: latest?.trades || [],
          btc: latest?.btc || {
            state: "UNKNOWN",
            chg24: 0,
            chg1h: 0,
            pressure: 0,
          },
          regime: latest?.regime || "UNKNOWN",
          market: latest?.market || null,
          dashboardStats: latest?.dashboardStats || emptyDashboardStats(Date.now()),
          updatedAt: Date.now(),
        },
        "fallback_runner_live"
      )
    );
  } catch (err) {
    console.error("PUBLIC-LATEST RUNNER ERROR:", err);

    return res.status(500).json({
      ok: false,
      profile: SYSTEM_PROFILE,
      error: err?.message || "public_latest_runner_failed",
      funnel: emptyFunnel(),
      trades: [],
      dashboardStats: emptyDashboardStats(Date.now()),
      servedAt: Date.now(),
    });
  }
}