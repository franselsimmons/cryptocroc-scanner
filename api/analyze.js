import { getLatestScan } from "../lib/scanStore.js";

const SYSTEM_PROFILE = "RUNNER";

const DEFAULT_MIN_CLOSED = 10;
const MAX_LATEST_EVENTS = 1000;

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

function normalizeText(value) {
  return String(value || "").toUpperCase().trim();
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

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;

  const v = String(value).trim().toLowerCase();

  if (["true", "1", "yes", "y", "on"].includes(v)) return true;
  if (["false", "0", "no", "n", "off"].includes(v)) return false;

  return fallback;
}

function round(value, decimals = 3) {
  const n = safeNumber(value, 0);
  const p = 10 ** decimals;
  return Math.round(n * p) / p;
}

// ================= DYNAMIC IMPORTS =================

async function importRunnerAnalyzeStore() {
  try {
    return await import("../lib/runnerAnalyzeStore.js");
  } catch {}

  try {
    return await import("../lib/analyzeStore.js");
  } catch {}

  return null;
}

async function importRunnerAnalyzeReport() {
  try {
    return await import("../lib/runnerAnalyzeReport.js");
  } catch {}

  try {
    return await import("../lib/runnerAnalyze.js");
  } catch {}

  try {
    return await import("../lib/analyzeFamilies.js");
  } catch {}

  try {
    return await import("../lib/familyAnalyze.js");
  } catch {}

  try {
    return await import("../lib/analyzeReport.js");
  } catch {}

  return null;
}

function getReportBuilder(mod) {
  return (
    mod?.buildRunnerAnalyzeReport ||
    mod?.buildAnalyzeReport ||
    mod?.buildFamilyReport ||
    mod?.buildReport ||
    mod?.analyzeEvents ||
    mod?.createAnalyzeReport ||
    null
  );
}

// ================= EVENT HELPERS =================

function hasNumericOutcome(row) {
  return (
    Number.isFinite(Number(row?.realizedR)) ||
    Number.isFinite(Number(row?.pnlR)) ||
    Number.isFinite(Number(row?.exitR)) ||
    Number.isFinite(Number(row?.resultR)) ||
    Number.isFinite(Number(row?.outcomeR)) ||
    Number.isFinite(Number(row?.rMultiple)) ||
    Number.isFinite(Number(row?.pnlPct))
  );
}

function isAnalyzeCandidate(row) {
  if (!row || typeof row !== "object") return false;

  const action = normalizeText(row.action || row.analyzeLifecycle || row.type || row.status);

  if (action === "ENTRY") return true;
  if (action === "EXIT") return true;

  if (row.closed === true && hasNumericOutcome(row)) return true;
  if (row.isClosed === true && hasNumericOutcome(row)) return true;

  return false;
}

function eventKey(row) {
  const tradeId =
    row?.tradeId ||
    row?.positionTradeId ||
    row?.positionId ||
    row?.orderId ||
    row?.clientOrderId ||
    "";

  const symbol = normalizeText(row?.symbol);
  const side = normalizeText(row?.side || row?.direction || row?.tradeSide);
  const action = normalizeText(row?.action || row?.analyzeLifecycle || row?.type || row?.status);

  const ts =
    row?.closedAt ||
    row?.exitedAt ||
    row?.exitAt ||
    row?.exitTs ||
    row?.openedAt ||
    row?.entryTs ||
    row?.analyzeTs ||
    row?.ts ||
    row?.createdAt ||
    row?.updatedAt ||
    "";

  const r =
    row?.realizedR ??
    row?.pnlR ??
    row?.exitR ??
    row?.resultR ??
    row?.outcomeR ??
    row?.rMultiple ??
    "";

  const entry = row?.entry ?? row?.entryPrice ?? "";
  const exit = row?.exit ?? row?.exitPrice ?? "";

  return [
    tradeId || `${symbol}_${side}`,
    action,
    ts,
    entry,
    exit,
    r,
  ].join("|");
}

function dedupeEvents(rows) {
  const seen = new Set();
  const out = [];

  for (const row of safeArray(rows)) {
    if (!row || typeof row !== "object") continue;

    const key = eventKey(row);
    if (seen.has(key)) continue;

    seen.add(key);
    out.push(row);
  }

  return out;
}

function collectLatestEvents(latest) {
  const result = safeObject(latest?.tradeSystemResult);
  const stats = safeObject(result?.runnerStats);

  return [
    ...safeArray(latest?.trades),
    ...safeArray(result?.actions),
    ...safeArray(stats?.closedTrades),
    ...safeArray(stats?.featureRows),
    ...safeArray(stats?.shadowRows),
  ]
    .filter(isAnalyzeCandidate)
    .slice(-MAX_LATEST_EVENTS);
}

async function loadStoredEvents() {
  const storeMod = await importRunnerAnalyzeStore();

  const loader =
    storeMod?.loadRunnerAnalyzeEvents ||
    storeMod?.readRunnerAnalyzeEvents ||
    storeMod?.getRunnerAnalyzeEvents ||
    storeMod?.loadAnalyzeEvents ||
    storeMod?.readAnalyzeEvents ||
    storeMod?.getAnalyzeEvents ||
    null;

  if (!loader) {
    return {
      ok: false,
      source: "runner_analyze_store",
      error: "runner_analyze_store_loader_missing",
      events: [],
    };
  }

  try {
    const events = await loader({ force: true });

    return {
      ok: true,
      source: "runner_analyze_store",
      error: null,
      events: safeArray(events).filter(isAnalyzeCandidate),
    };
  } catch (error) {
    return {
      ok: false,
      source: "runner_analyze_store",
      error: error?.message || "runner_analyze_store_load_failed",
      events: [],
    };
  }
}

function buildFallbackReport(events, minClosed) {
  return {
    ok: false,
    profile: SYSTEM_PROFILE,
    generatedAt: new Date().toISOString(),
    error: "runner_analyze_report_builder_missing",
    message:
      "Plaats buildRunnerAnalyzeReport in ../lib/runnerAnalyzeReport.js of update de importlijst in api/runner-analyze.js.",
    config: {
      profile: SYSTEM_PROFILE,
      minClosed,
      totalFamilyCount: 100,
    },
    summary: {
      profile: SYSTEM_PROFILE,
      actions: events.length,
      trades: events.length,
      observed: events.length,
      open: 0,
      closed: 0,
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
      longFamilies: 50,
      shortFamilies: 50,
      hotFamilies: 0,
      goodFamilies: 0,
      stableFamilies: 0,
      badFamilies: 0,
      collectingFamilies: 0,
      emptyFamilies: 100,
    },
    families: {
      all: [],
      long: [],
      short: [],
      ranked: [],
      best: [],
      bestBalance: [],
      bestRunnerPnl: [],
      worst: [],
    },
    selection: {
      ready: false,
      minClosed,
      allowedFamilyIds: [],
      allowedRunnerFamilyIds: [],
      blockedFamilyIds: [],
    },
  };
}

function enrichReport(report, meta) {
  const families = safeObject(report?.families);

  const longFamilies = safeArray(families.long);
  const shortFamilies = safeArray(families.short);
  const allFamilies = safeArray(families.all || families.ranked);

  return {
    ...report,
    ok: report?.ok !== false,
    profile: report?.profile || SYSTEM_PROFILE,

    source: "runner_analyze",
    dataSources: meta.dataSources,

    familyMatrix: {
      longCount: longFamilies.length || 50,
      shortCount: shortFamilies.length || 50,
      totalCount: allFamilies.length || longFamilies.length + shortFamilies.length || 100,
    },

    diagnostics: {
      ...safeObject(report?.diagnostics),
      endpointEvents: meta.endpointEvents,
      storedEvents: meta.storedEvents,
      latestEvents: meta.latestEvents,
      dedupedEvents: meta.dedupedEvents,
      minClosed: meta.minClosed,
    },

    summary: {
      ...safeObject(report?.summary),
      profile: SYSTEM_PROFILE,
      longFamilies: longFamilies.length || safeNumber(report?.summary?.longFamilies, 50),
      shortFamilies: shortFamilies.length || safeNumber(report?.summary?.shortFamilies, 50),
    },

    servedAt: Date.now(),
  };
}

// ================= HANDLER =================

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store, max-age=0");

    const minClosed = Math.max(
      1,
      Math.round(
        safeNumber(
          getQueryParam(req, "minClosed", DEFAULT_MIN_CLOSED),
          DEFAULT_MIN_CLOSED
        )
      )
    );

    const includeLatest = normalizeBoolean(
      getQueryParam(req, "includeLatest", "true"),
      true
    );

    const includeStore = normalizeBoolean(
      getQueryParam(req, "includeStore", "true"),
      true
    );

    const [latest, storedResult, reportMod] = await Promise.all([
      includeLatest ? getLatestScan().catch(() => null) : Promise.resolve(null),
      includeStore ? loadStoredEvents() : Promise.resolve({
        ok: true,
        source: "runner_analyze_store",
        error: null,
        events: [],
      }),
      importRunnerAnalyzeReport(),
    ]);

    const storedEvents = safeArray(storedResult?.events);
    const latestEvents = includeLatest ? collectLatestEvents(latest) : [];

    const events = dedupeEvents([
      ...storedEvents,
      ...latestEvents,
    ]);

    const buildReport = getReportBuilder(reportMod);

    const rawReport = buildReport
      ? buildReport(events, { minClosed })
      : buildFallbackReport(events, minClosed);

    const report = enrichReport(rawReport, {
      minClosed,
      endpointEvents: events.length,
      storedEvents: storedEvents.length,
      latestEvents: latestEvents.length,
      dedupedEvents: events.length,
      dataSources: {
        store: {
          ok: Boolean(storedResult?.ok),
          error: storedResult?.error || null,
          count: storedEvents.length,
        },
        latest: {
          ok: Boolean(latest?.ok),
          count: latestEvents.length,
          updatedAt: latest?.updatedAt || null,
          tradeFunnelUpdatedAt: latest?.tradeFunnelUpdatedAt || null,
        },
        reportBuilder: {
          ok: Boolean(buildReport),
        },
      },
    });

    return res.status(200).json(report);
  } catch (error) {
    console.error("RUNNER ANALYZE ERROR:", error);

    return res.status(500).json({
      ok: false,
      profile: SYSTEM_PROFILE,
      error: error?.message || "runner_analyze_failed",
      families: {
        all: [],
        long: [],
        short: [],
        ranked: [],
        best: [],
        bestBalance: [],
        bestRunnerPnl: [],
        worst: [],
      },
      summary: {
        profile: SYSTEM_PROFILE,
        longFamilies: 50,
        shortFamilies: 50,
      },
      servedAt: Date.now(),
    });
  }
}