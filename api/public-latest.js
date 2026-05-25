import { getLatestScan, setLatestScan } from "../lib/scanStore.js";

const SYSTEM_PROFILE = "RUNNER";
const STAGES = ["entry", "almost", "buildup", "radar"];

// ================= REQUEST QUERY HELPERS =================
// Belangrijk:
// - Geen req.query gebruiken.
// - Vercel triggert via req.query intern url.parse() => DEP0169 warning.
// - Deze helpers gebruiken WHATWG URL API.

function getRequestUrl(req) {
  const proto =
    req?.headers?.["x-forwarded-proto"] ||
    "https";

  const host =
    req?.headers?.["x-forwarded-host"] ||
    req?.headers?.host ||
    "localhost";

  return new URL(req?.url || "/", `${proto}://${host}`);
}

function getQueryParams(req) {
  return getRequestUrl(req).searchParams;
}

function queryString(params, key, fallback = "") {
  const value = params.get(key);
  return value === null || value === undefined || value === "" ? fallback : value;
}

// ================= GENERIC HELPERS =================

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeCounterMap(map) {
  const out = {};

  for (const [key, value] of Object.entries(map || {})) {
    const n = Math.round(Number(value || 0));
    if (n > 0) out[String(key)] = n;
  }

  return out;
}

function emptySide() {
  return {
    entry: [],
    almost: [],
    buildup: [],
    radar: []
  };
}

function emptyFunnel() {
  return {
    bull: emptySide(),
    bear: emptySide()
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
    tradeRows: []
  };
}

function normalizeFunnel(funnel) {
  return {
    bull: {
      entry: safeArray(funnel?.bull?.entry),
      almost: safeArray(funnel?.bull?.almost),
      buildup: safeArray(funnel?.bull?.buildup),
      radar: safeArray(funnel?.bull?.radar)
    },
    bear: {
      entry: safeArray(funnel?.bear?.entry),
      almost: safeArray(funnel?.bear?.almost),
      buildup: safeArray(funnel?.bear?.buildup),
      radar: safeArray(funnel?.bear?.radar)
    }
  };
}

function countSide(funnel, side) {
  const f = normalizeFunnel(funnel);

  return STAGES.reduce((acc, stage) => {
    return acc + safeArray(f?.[side]?.[stage]).length;
  }, 0);
}

function countStage(funnel, side, stage) {
  const f = normalizeFunnel(funnel);
  return safeArray(f?.[side]?.[stage]).length;
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
    bearRadar: countStage(funnel, "bear", "radar")
  };
}

function normalizeDashboardStats(stats, fallbackPayload = null) {
  const now = Date.now();

  const trades = safeArray(fallbackPayload?.trades);

  const entries = trades.filter(t => {
    return String(t?.action || "").toUpperCase() === "ENTRY";
  });

  const waits = trades.filter(t => {
    return String(t?.action || "").toUpperCase() === "WAIT";
  });

  const otherTrades = trades.filter(t => {
    const action = String(t?.action || "").toUpperCase();
    return action !== "WAIT" && action !== "ENTRY";
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
        lastCandidates: safeNumber(fallbackPayload?.candidates, 0)
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

    entryRows: safeArray(base?.entryRows),
    rejectedRows: safeArray(base?.rejectedRows),
    tradeRows: safeArray(base?.tradeRows)
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
    updatedAt: payload?.updatedAt || null
  };
}

function safePayload(payload, source) {
  const funnel = normalizeFunnel(payload?.funnel);
  const trades = safeArray(payload?.trades);

  const normalizedPayload = {
    ...(payload || {}),

    ok: payload?.ok !== false,
    source,
    scannerProfile: payload?.scannerProfile || SYSTEM_PROFILE,

    funnel,
    funnelCount: countFunnel(funnel),
    bullCount: countSide(funnel, "bull"),
    bearCount: countSide(funnel, "bear"),

    trades,

    btc: payload?.btc || {
      state: "UNKNOWN",
      chg24: 0,
      chg1h: 0,
      pressure: 0
    },

    regime: payload?.regime || "UNKNOWN",
    market: payload?.market || null,
    analytics: payload?.analytics || {},
    advice: payload?.advice || {},

    candidates: safeNumber(payload?.candidates, 0),
    candidatesBull: safeNumber(payload?.candidatesBull, 0),
    candidatesBear: safeNumber(payload?.candidatesBear, 0),

    updatedAt: payload?.updatedAt || Date.now()
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
    servedAt: Date.now()
  };
}

async function resetStoredStats() {
  const latest = await getLatestScan();

  if (!latest?.ok) {
    return {
      ok: true,
      profile: SYSTEM_PROFILE,
      message: "Geen opgeslagen runner-scan om te resetten."
    };
  }

  const now = Date.now();

  const updated = {
    ...latest,
    scannerProfile: latest?.scannerProfile || SYSTEM_PROFILE,
    dashboardStats: emptyDashboardStats(now),
    statsResetAt: now,
    servedAt: now
  };

  await setLatestScan(updated);

  return safePayload(updated, "stats_reset");
}

// ================= HANDLER =================

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store, max-age=0");

    const params = getQueryParams(req);

    const action = String(
      queryString(params, "action", "") ||
        req?.body?.action ||
        ""
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
            pressure: 0
          },

          regime: latest?.regime || "UNKNOWN",
          market: latest?.market || null,
          dashboardStats: latest?.dashboardStats || emptyDashboardStats(Date.now()),
          updatedAt: Date.now()
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
      servedAt: Date.now()
    });
  }
}