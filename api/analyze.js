// ================= RUNNER ANALYZE ENDPOINT =================
// Doel:
// - Zelfde concept als main analyze.
// - 50 LONG families + 50 SHORT families.
// - Runner objective = PnL-first.
// - Gebruikt runner analyze-store als bron.
// - Robuust voor oude rows, synthetic rows, closed ENTRY rows en EXIT rows.

import {
  loadRunnerAnalyzeStore,
  loadRunnerAnalyzeEvents,
} from "../lib/runnerAnalyzeStore.js";

import {
  buildRunnerFamilyAnalysis,
  normalizeRunnerAnalyzeRows,
} from "../lib/runnerFamilyEngine.js";

const SYSTEM_PROFILE = "RUNNER";

const DEFAULT_MIN_CLOSED = 10;
const DEFAULT_BREAKEVEN_R_EPS = 0.05;
const DEFAULT_MAX_EXAMPLES = 8;

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

function readNumberParam(req, key, fallback) {
  const n = Number(getQueryParam(req, key, ""));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function compactStoreMeta(store, rawEvents, normalizedRows) {
  return {
    ok: true,
    count: safeArray(rawEvents).length,
    trades: normalizedRows.length,
    open: normalizedRows.filter(row => !row.closed).length,
    closed: normalizedRows.filter(row => row.closed && row.resultR !== null).length,
    unmatchedExits: safeNumber(store?.unmatchedExits, 0),
    maxStoredEvents: safeNumber(store?.maxStoredEvents, 0),
  };
}

function buildDataState(normalizedRows) {
  const closed = normalizedRows.filter(row => row.closed && row.resultR !== null).length;

  if (closed > 0) return "READY";
  if (normalizedRows.length > 0) return "COLLECTING";

  return "EMPTY";
}

export default async function handler(req, res) {
  const startedAt = Date.now();

  try {
    res.setHeader("Cache-Control", "no-store, max-age=0");

    const minClosed = readNumberParam(req, "minClosed", DEFAULT_MIN_CLOSED);
    const breakevenREps = readNumberParam(req, "breakevenREps", DEFAULT_BREAKEVEN_R_EPS);
    const maxExamplesPerFamily = readNumberParam(req, "maxExamplesPerFamily", DEFAULT_MAX_EXAMPLES);

    const [store, rawEvents] = await Promise.all([
      loadRunnerAnalyzeStore({ force: true }).catch(error => ({
        ok: false,
        error: error?.message || "load_runner_analyze_store_failed",
        events: [],
      })),
      loadRunnerAnalyzeEvents({ force: true }).catch(() => []),
    ]);

    const sourceRows = safeArray(store?.events).length
      ? safeArray(store.events)
      : safeArray(rawEvents);

    const normalizedRows = normalizeRunnerAnalyzeRows(sourceRows);

    const analysis = buildRunnerFamilyAnalysis(normalizedRows, {
      minClosed,
      breakevenREps,
      maxExamplesPerFamily,
    });

    const dataState = buildDataState(analysis.rows);

    return res.status(200).json({
      ok: true,
      profile: SYSTEM_PROFILE,

      endpoint: "/api/analyze",
      objective: "RUNNER_PNL_FIRST",
      strategy: "50_LONG_FAMILIES_PLUS_50_SHORT_FAMILIES",

      dataState,
      latencyMs: Date.now() - startedAt,
      servedAt: Date.now(),

      config: {
        minClosed,
        breakevenREps,
        maxExamplesPerFamily,
        familyCountPerSide: 50,
        totalFamilyCount: 100,
      },

      source: {
        mode: "RUNNER_ANALYZE_STORE",
        storeSource: store?.source || "runner_analyze_store",
        redisKey: store?.redisKey || "runner:analyze:store:v1:events",
        legacyRedisKey: store?.legacyRedisKey || "runner:analyze:store:v1",
        path: store?.path || "/tmp/runner-analyze-events.json",
        redisEnabled: Boolean(store?.redisEnabled),
        fileEnabled: store?.fileEnabled !== false,
        loadedAt: store?.loadedAt || 0,
        lastPersistAt: store?.lastPersistAt || 0,
        error: store?.error || null,
      },

      store: compactStoreMeta(store, sourceRows, analysis.rows),

      latest: {
        ok: true,
        count: 0,
        note: "Runner analyze gebruikt runner analyze-store. Latest scan wordt niet gemerged in deze endpoint.",
      },

      merged: {
        count: analysis.rows.length,
        source: "runner_analyze_store_only",
      },

      stats: analysis.stats,

      familyPerformanceMatrix: analysis.familyPerformanceMatrix,

      best: analysis.best,

      winnerCandidates: analysis.winnerCandidates,
      winnerCandidateSummary: analysis.winnerCandidateSummary,

      winnerFamilies: analysis.winnerFamilies,
      winnerFamilySummary: analysis.winnerFamilySummary,

      leaderboards: analysis.leaderboards,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      profile: SYSTEM_PROFILE,
      endpoint: "/api/analyze",
      objective: "RUNNER_PNL_FIRST",
      error: error?.message || "runner_analyze_failed",
      latencyMs: Date.now() - startedAt,
      servedAt: Date.now(),
    });
  }
}