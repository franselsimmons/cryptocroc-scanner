// api/analyze.js

const STARTED_AT = Date.now();

const SYSTEM_PROFILE = "RUNNER";
const SYSTEM_MODE = "MOMENTUM_RUNNER";
const STRATEGY_FAMILY = "BREAKOUT_CONTINUATION_SQUEEZE";

const DEFAULT_MIN_CLOSED = 10;
const DEFAULT_INCLUDE_LATEST = false;
const MAX_DEBUG_EVENTS = 50;

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

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;

  const v = String(value).trim().toLowerCase();

  if (["true", "1", "yes", "y", "on"].includes(v)) return true;
  if (["false", "0", "no", "n", "off"].includes(v)) return false;

  return fallback;
}

function normalizeText(value) {
  return String(value || "").toUpperCase().trim();
}

function normalizeSide(value) {
  const s = String(value || "").toLowerCase().trim();

  if (["long", "bull", "buy"].includes(s)) return "LONG";
  if (["short", "bear", "sell"].includes(s)) return "SHORT";

  return "";
}

function normalizeTs(value, fallback = Date.now()) {
  if (value instanceof Date) return value.getTime();

  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;

  const parsed = Date.parse(String(value || ""));
  if (Number.isFinite(parsed)) return parsed;

  return fallback;
}

function serializeError(error, debug = false) {
  const payload = {
    message: error?.message || String(error || "unknown_error"),
    name: error?.name || "Error"
  };

  if (debug && error?.stack) {
    payload.stack = error.stack;
  }

  return payload;
}

// ================= DYNAMIC IMPORTS =================

async function importAnalyzeStore() {
  return import("../lib/analyze/analyzeStore.js");
}

async function importFamilyEngine() {
  return import("../lib/analyze/familyEngine.js");
}

async function importScanStoreSafe() {
  try {
    return await import("../lib/scanStore.js");
  } catch {
    return null;
  }
}

// ================= TRADE RECORD HELPERS =================

function getTradeId(event) {
  const id =
    event?.tradeId ||
    event?.positionTradeId ||
    event?.positionId ||
    event?.orderId ||
    event?.clientOrderId ||
    event?.analyzeEventKey ||
    event?.analyzeEventId ||
    event?.eventId ||
    event?.id;

  return id ? String(id) : "";
}

function getEventTs(event, fallback = Date.now()) {
  return normalizeTs(
    event?.analyzeUpdatedAt ??
      event?.closedAt ??
      event?.exitAt ??
      event?.exitTs ??
      event?.updatedAt ??
      event?.openedAt ??
      event?.createdAt ??
      event?.entryTs ??
      event?.analyzeTs ??
      event?.ts,
    fallback
  );
}

function isIgnoredAction(event) {
  const action = normalizeText(event?.action || event?.status || event?.reason);
  const kind = normalizeText(event?.analyzeKind || event?.type);

  if (kind === "TRADE_RECORD") return false;
  if (kind === "UNMATCHED_EXIT") return false;

  return (
    action === "WAIT" ||
    action === "HOLD" ||
    action === "RUNNING" ||
    action === "NO_TRADE" ||
    action === "SKIP"
  );
}

function isTradeLikeRecord(event) {
  if (!event || typeof event !== "object") return false;
  if (isIgnoredAction(event)) return false;

  const kind = normalizeText(event.analyzeKind || event.type);

  if (kind === "TRADE_RECORD") return true;
  if (kind === "UNMATCHED_EXIT") return true;

  const action = normalizeText(event.action || event.status || event.reason);

  if (action.includes("ENTRY")) return true;
  if (action.includes("EXIT")) return true;
  if (action.includes("TP")) return true;
  if (action.includes("SL")) return true;
  if (event.closed === true) return true;

  return Boolean(
    event.tradeId ||
      event.positionId ||
      event.entry !== undefined ||
      event.entryPrice !== undefined ||
      event.exitPrice !== undefined
  );
}

function compactLatestEvent(event) {
  const side = normalizeSide(event.side || event.direction || event.tradeSide);
  const tradeId = getTradeId(event);

  return {
    ...event,

    profile: SYSTEM_PROFILE,
    system: SYSTEM_PROFILE,

    tradeId: tradeId || undefined,
    side: side || event.side,

    analyzeSource: event.analyzeSource || "runner_latest_scan_debug",
    analyzeTs: getEventTs(event)
  };
}

function eventKey(event, fallbackIndex = 0) {
  const tradeId = getTradeId(event);

  if (tradeId) return tradeId;

  const kind = normalizeText(event?.analyzeKind || event?.type);
  const symbol = String(event?.symbol || "").toUpperCase().trim();
  const side = normalizeSide(event?.side || event?.direction || event?.tradeSide);
  const ts = getEventTs(event, fallbackIndex);

  return [kind || "EVENT", symbol, side, ts, fallbackIndex].join("|");
}

function dedupeEvents(events) {
  const map = new Map();

  safeArray(events).forEach((event, index) => {
    if (!isTradeLikeRecord(event)) return;

    const key = eventKey(event, index);
    const previous = map.get(key);

    if (!previous) {
      map.set(key, {
        ...event,
        analyzeEventKey: event.analyzeEventKey || key
      });
      return;
    }

    const prevTs = getEventTs(previous, 0);
    const nextTs = getEventTs(event, 0);

    if (nextTs >= prevTs) {
      map.set(key, {
        ...previous,
        ...event,
        analyzeEventKey: previous.analyzeEventKey || event.analyzeEventKey || key
      });
    }
  });

  return Array.from(map.values()).sort((a, b) => getEventTs(a, 0) - getEventTs(b, 0));
}

function collectLatestEvents(latest) {
  if (!latest?.ok) return [];

  const raw = [
    ...safeArray(latest.trades),
    ...safeArray(latest.tradeSystemResult?.actions),
    ...safeArray(latest.tradeSystemResult?.runnerStats?.closedTrades),
    ...safeArray(latest.runnerStats?.closedTrades),
    ...safeArray(latest.actions),
    ...safeArray(latest.closedTrades)
  ];

  return dedupeEvents(raw.map(compactLatestEvent));
}

// ================= STORE LOADERS =================

async function loadStoredEvents(analyzeStore) {
  const loadStore =
    analyzeStore.loadAnalyzeStore ||
    analyzeStore.default?.loadAnalyzeStore;

  const loadEvents =
    analyzeStore.loadAnalyzeEvents ||
    analyzeStore.readAnalyzeEvents ||
    analyzeStore.getAnalyzeEvents ||
    analyzeStore.default?.loadAnalyzeEvents ||
    analyzeStore.default?.readAnalyzeEvents ||
    analyzeStore.default?.getAnalyzeEvents;

  if (typeof loadStore === "function") {
    const store = await loadStore();
    const events = safeArray(store?.events);

    return {
      store: {
        ok: Boolean(store?.ok),
        path: store?.path || null,
        count: safeNumber(store?.count, events.length),
        trades: safeNumber(store?.trades, events.length),
        unmatchedExits: safeNumber(store?.unmatchedExits, 0),
        maxStoredEvents: store?.maxStoredEvents || null,
        primary: store?.primary || store?.source || null,
        redisEnabled: Boolean(store?.redisEnabled),
        fileEnabled: store?.fileEnabled !== false,
        error: store?.error || null
      },
      events
    };
  }

  if (typeof loadEvents === "function") {
    const events = await loadEvents();

    return {
      store: {
        ok: true,
        path: null,
        count: safeArray(events).length,
        trades: safeArray(events).length,
        unmatchedExits: 0,
        maxStoredEvents: null,
        primary: "events_loader",
        redisEnabled: false,
        fileEnabled: false,
        error: null
      },
      events: safeArray(events)
    };
  }

  return {
    store: {
      ok: false,
      path: null,
      count: 0,
      trades: 0,
      unmatchedExits: 0,
      maxStoredEvents: null,
      primary: null,
      redisEnabled: false,
      fileEnabled: false,
      error: "NO_ANALYZE_STORE_LOADER_FOUND"
    },
    events: []
  };
}

async function clearStoredEvents(analyzeStore) {
  const clearFn =
    analyzeStore.clearAnalyzeEvents ||
    analyzeStore.resetAnalyzeEvents ||
    analyzeStore.default?.clearAnalyzeEvents ||
    analyzeStore.default?.resetAnalyzeEvents;

  if (typeof clearFn !== "function") {
    return {
      ok: false,
      error: "NO_CLEAR_ANALYZE_EVENTS_EXPORT_FOUND"
    };
  }

  return clearFn();
}

// ================= REPORT BUILDER =================

function buildReport(familyEngine, events, options) {
  const buildFn =
    familyEngine.buildAnalyzeReport ||
    familyEngine.buildFamilyReport ||
    familyEngine.buildReport ||
    familyEngine.analyzeEvents ||
    familyEngine.createAnalyzeReport ||
    familyEngine.default?.buildAnalyzeReport ||
    familyEngine.default?.buildFamilyReport ||
    familyEngine.default?.buildReport ||
    familyEngine.default?.analyzeEvents ||
    familyEngine.default?.createAnalyzeReport;

  if (typeof buildFn !== "function") {
    throw new Error("NO_ANALYZE_REPORT_BUILDER_FOUND");
  }

  return buildFn(events, {
    ...options,
    profile: SYSTEM_PROFILE,
    runnerMode: true
  });
}

function compactSourcePreview(events) {
  return safeArray(events)
    .slice(-MAX_DEBUG_EVENTS)
    .map(event => ({
      tradeId: getTradeId(event) || null,
      analyzeKind: event.analyzeKind || event.type || null,
      source: event.analyzeSource || null,
      symbol: event.symbol || null,
      side: normalizeSide(event.side || event.direction || event.tradeSide) || null,
      familyId: event.familyId || event.analyzeFamilyId || event.filterSnapshot?.familyId || null,
      closed: Boolean(event.closed),
      realizedR: event.realizedR ?? event.pnlR ?? event.resultR ?? event.outcomeR ?? event.exitR ?? null,
      pnlPct: event.pnlPct ?? event.realizedPnlPct ?? null,
      exitReason: event.exitReason || event.reason || null,
      setupClass: event.setupClass || null,
      entryType: event.entryType || event.runnerEntryType || null,
      flow: event.flow || event.scannerFlow || null,
      ts: getEventTs(event, null)
    }));
}

function countKinds(events) {
  const counts = {};

  for (const event of safeArray(events)) {
    const kind = normalizeText(event?.analyzeKind || event?.type || "UNKNOWN");
    counts[kind] = safeNumber(counts[kind], 0) + 1;
  }

  return counts;
}

function selectEvents({ storedEvents, latestEvents, sourceMode }) {
  if (sourceMode === "latest") {
    return {
      selectedEvents: latestEvents,
      selectedSource: "latest"
    };
  }

  if (sourceMode === "merged") {
    return {
      selectedEvents: dedupeEvents([...storedEvents, ...latestEvents]),
      selectedSource: "merged"
    };
  }

  return {
    selectedEvents: storedEvents,
    selectedSource: "stored"
  };
}

async function loadLatestScan({ includeLatest, sourceMode }) {
  if (!includeLatest && sourceMode !== "latest" && sourceMode !== "merged") {
    return {
      ok: null,
      skipped: true,
      reason: "includeLatest=false"
    };
  }

  const scanStore = await importScanStoreSafe();
  const getLatestScan = scanStore?.getLatestScan || scanStore?.default?.getLatestScan;

  if (typeof getLatestScan !== "function") {
    return {
      ok: false,
      skipped: false,
      reason: "NO_SCAN_STORE_GET_LATEST_SCAN",
      error: "NO_SCAN_STORE_GET_LATEST_SCAN"
    };
  }

  return getLatestScan().catch(error => ({
    ok: false,
    skipped: false,
    reason: "LATEST_SCAN_LOAD_FAILED",
    error: error?.message || String(error)
  }));
}

// ================= RESPONSE META =================

function buildStatusMeta() {
  return {
    system: SYSTEM_PROFILE,
    profile: SYSTEM_PROFILE,
    scannerProfile: SYSTEM_PROFILE,
    tradeSystemProfile: SYSTEM_PROFILE,

    status: "ACTIVE",
    mode: SYSTEM_MODE,
    strategyFamily: STRATEGY_FAMILY,

    modules: {
      scanner: "RUNNER_SCANNER",
      tradeFunnel: "RUNNER_TRADE_FUNNEL",
      tradeSystem: "RUNNER_TRADE_SYSTEM",
      analyzer: "RUNNER_ANALYZER",
      performance: "RUNNER_PERFORMANCE",
      executionStyle: STRATEGY_FAMILY
    },

    routes: {
      status: "/api/analyze",
      analyze: "/api/analyze",
      performance: "/api/performance",
      tradeStats: "/api/trade-stats",
      tradeHistory: "/api/trade-history",
      publicLatest: "/api/public-latest"
    },

    compatibility: {
      keepsExistingApiShape: true,
      dashboardSafe: true,
      runnerOnly: true,
      familyMatrix: "50_LONG_50_SHORT"
    },

    startedAt: STARTED_AT,
    uptimeMs: Date.now() - STARTED_AT
  };
}

// ================= HANDLER =================

export default async function handler(req, res) {
  const startedAt = Date.now();

  res.setHeader("Cache-Control", "no-store, max-age=0");

  const debug = normalizeBoolean(req?.query?.debug, false);
  const reset = normalizeBoolean(req?.query?.reset, false);

  const includeLatest = normalizeBoolean(
    req?.query?.includeLatest,
    DEFAULT_INCLUDE_LATEST
  );

  const minClosed = Math.max(
    0,
    Math.round(safeNumber(req?.query?.minClosed, DEFAULT_MIN_CLOSED))
  );

  const sourceMode = String(req?.query?.source || "stored").toLowerCase().trim();
  const normalizedSourceMode = ["stored", "latest", "merged"].includes(sourceMode)
    ? sourceMode
    : "stored";

  try {
    const [analyzeStore, familyEngine] = await Promise.all([
      importAnalyzeStore(),
      importFamilyEngine()
    ]);

    if (reset) {
      const clearResult = await clearStoredEvents(analyzeStore);

      return res.status(clearResult?.ok ? 200 : 500).json({
        ok: Boolean(clearResult?.ok),
        reset: true,
        profile: SYSTEM_PROFILE,
        system: SYSTEM_PROFILE,
        clearResult,
        generatedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        servedAt: Date.now()
      });
    }

    const { store, events: storedEventsRaw } = await loadStoredEvents(analyzeStore);

    const latest = await loadLatestScan({
      includeLatest,
      sourceMode: normalizedSourceMode
    });

    const storedEvents = dedupeEvents(storedEventsRaw);

    const latestEvents =
      latest?.ok &&
      (includeLatest || normalizedSourceMode === "latest" || normalizedSourceMode === "merged")
        ? collectLatestEvents(latest)
        : [];

    const { selectedEvents, selectedSource } = selectEvents({
      storedEvents,
      latestEvents,
      sourceMode: normalizedSourceMode
    });

    const report = buildReport(familyEngine, selectedEvents, {
      minClosed,
      familyCountLong: 50,
      familyCountShort: 50,
      profile: SYSTEM_PROFILE,
      runnerMode: true
    });

    const response = {
      ok: true,

      ...buildStatusMeta(),

      generatedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,

      modeInfo: {
        source: selectedSource,
        includeLatest,
        minClosed,
        note:
          selectedSource === "stored"
            ? "Runner analyse gebruikt alleen opgeslagen analyse-records. Latest scan wordt niet meegeteld tenzij source=latest/merged of includeLatest=true."
            : "Runner analyse gebruikt latest/debug data. Gebruik source=stored voor echte family-statistiek."
      },

      // Backward compatible met bestaande analytics.js.
      mode: selectedSource,

      sources: {
        selectedEvents: selectedEvents.length,
        storedEvents: storedEvents.length,
        latestEvents: latestEvents.length,
        mergedEvents: selectedSource === "merged" ? selectedEvents.length : 0,

        storedKinds: countKinds(storedEvents),
        latestKinds: countKinds(latestEvents),
        selectedKinds: countKinds(selectedEvents),

        store,

        latest: {
          ok: latest?.ok ?? null,
          skipped: Boolean(latest?.skipped),
          reason: latest?.reason || null,
          updatedAt: latest?.updatedAt || null,
          tradeFunnelUpdatedAt: latest?.tradeFunnelUpdatedAt || null,
          error: latest?.error || null
        }
      },

      tradesLoaded: selectedEvents.length,
      report,

      timestamp: Date.now(),
      servedAt: Date.now()
    };

    if (debug) {
      response.debug = {
        storedPreview: compactSourcePreview(storedEvents),
        latestPreview: compactSourcePreview(latestEvents),
        selectedPreview: compactSourcePreview(selectedEvents)
      };
    }

    return res.status(200).json(response);
  } catch (error) {
    console.error("RUNNER ANALYZE API ERROR:", error);

    return res.status(500).json({
      ok: false,
      ...buildStatusMeta(),
      generatedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      error: serializeError(error, debug),
      servedAt: Date.now()
    });
  }
}