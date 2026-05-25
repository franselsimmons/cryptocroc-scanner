import { getLatestScan } from "../lib/scanStore.js";
import * as analyzeStore from "../lib/analyze/runnerAnalyzeStore.js";
import * as familyEngine from "../lib/analyze/runnerFamilyEngine.js";

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

function normalizeRunnerSide(value) {
  const side = normalizeSide(value);

  if (side === "LONG") return "bull";
  if (side === "SHORT") return "bear";

  return String(value || "").toLowerCase().trim();
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
    name: error?.name || "Error",
  };

  if (debug && error?.stack) {
    payload.stack = error.stack;
  }

  return payload;
}

// ================= STATUS RESPONSE =================

function buildStatusResponse() {
  return {
    ok: true,

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
      familyEngine: "RUNNER_FAMILY_ENGINE",
      performance: "RUNNER_PERFORMANCE",
      executionStyle: STRATEGY_FAMILY,
    },

    routes: {
      analyze: "/api/analyze",
      analyzeStatus: "/api/analyze?status=true",
      reset: "/api/analyze?reset=true",
      performance: "/api/performance",
      tradeStats: "/api/trade-stats",
      tradeHistory: "/api/trade-history",
      publicLatest: "/api/public-latest",
    },

    compatibility: {
      keepsExistingStatusShapeViaQuery: true,
      dashboardSafe: true,
      runnerOnly: true,
    },

    startedAt: STARTED_AT,
    uptimeMs: Date.now() - STARTED_AT,
    timestamp: Date.now(),
    servedAt: Date.now(),
  };
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
      event?.exitedAt ??
      event?.exitAt ??
      event?.exitTs ??
      event?.updatedAt ??
      event?.openedAt ??
      event?.createdAt ??
      event?.entryTs ??
      event?.analyzeTs ??
      event?.timestamp ??
      event?.ts,
    fallback
  );
}

function getLifecycleAction(event) {
  const candidates = [
    event?.analyzeLifecycle,
    event?.analyzeAction,
    event?.lifecycleAction,
    event?.tradeAction,
    event?.action,
    event?.event,
    event?.status,
    event?.state,
    event?.type,
    event?.reason,
    event?.exitReason,
  ]
    .map(normalizeText)
    .filter(Boolean);

  for (const value of candidates) {
    if (
      value === "EXIT" ||
      value === "CLOSE" ||
      value === "CLOSED" ||
      value === "TP" ||
      value === "SL" ||
      value === "BE_SL" ||
      value === "TRAIL_SL" ||
      value === "STOP" ||
      value === "STOP_LOSS" ||
      value === "TAKE_PROFIT" ||
      value.includes("EXIT") ||
      value.includes("CLOSE") ||
      value.includes("TAKE_PROFIT") ||
      value.includes("STOP_LOSS")
    ) {
      return "EXIT";
    }
  }

  if (
    event?.closed === true ||
    event?.isClosed === true ||
    event?.exitPrice !== undefined ||
    event?.exit !== undefined ||
    event?.closedAt ||
    event?.exitedAt ||
    event?.exitAt ||
    event?.exitTs ||
    event?.realizedR !== undefined ||
    event?.pnlR !== undefined ||
    event?.exitR !== undefined ||
    event?.resultR !== undefined ||
    event?.outcomeR !== undefined ||
    event?.pnlPct !== undefined
  ) {
    return "EXIT";
  }

  for (const value of candidates) {
    if (
      value === "ENTRY" ||
      value === "OPEN" ||
      value === "OPENED" ||
      value === "ENTER" ||
      value === "FILLED" ||
      value === "PLACE_ORDER" ||
      value === "RUNNER_A_BREAKOUT" ||
      value === "RUNNER_B_CONTINUATION" ||
      value === "RUNNER_C_SQUEEZE" ||
      value.includes("ENTRY") ||
      value.includes("OPEN_POSITION") ||
      value.includes("RUNNER_A") ||
      value.includes("RUNNER_B") ||
      value.includes("RUNNER_C")
    ) {
      return "ENTRY";
    }
  }

  if (
    event?.entry !== undefined ||
    event?.entryPrice !== undefined ||
    event?.openPrice !== undefined ||
    event?.sl !== undefined ||
    event?.tp !== undefined ||
    event?.rr !== undefined ||
    event?.baseRR !== undefined ||
    event?.plannedRR !== undefined
  ) {
    return "ENTRY";
  }

  return "";
}

function isIgnoredAction(event) {
  const action = normalizeText(event?.action || event?.status || event?.reason);
  const kind = normalizeText(event?.analyzeKind || event?.type);

  if (kind === "TRADE_RECORD") return false;
  if (kind === "UNMATCHED_EXIT") return false;
  if (kind === "RUNNER_TRADE_RECORD") return false;
  if (kind === "RUNNER_UNMATCHED_EXIT") return false;

  return (
    action === "WAIT" ||
    action === "HOLD" ||
    action === "RUNNING" ||
    action === "NO_TRADE" ||
    action === "SKIP" ||
    action === "OBSERVE" ||
    action === "PARTIAL_TP" ||
    action === "MOVE_BE" ||
    action === "TRAIL" ||
    action === "ADD"
  );
}

function isTradeLikeRecord(event) {
  if (!event || typeof event !== "object") return false;
  if (isIgnoredAction(event)) return false;

  const kind = normalizeText(event.analyzeKind || event.type);

  if (kind === "TRADE_RECORD") return true;
  if (kind === "UNMATCHED_EXIT") return true;
  if (kind === "RUNNER_TRADE_RECORD") return true;
  if (kind === "RUNNER_UNMATCHED_EXIT") return true;

  const action = getLifecycleAction(event);

  if (action === "ENTRY") return true;
  if (action === "EXIT") return true;

  return Boolean(
    event.tradeId ||
      event.positionId ||
      event.entry !== undefined ||
      event.entryPrice !== undefined ||
      event.exitPrice !== undefined ||
      event.exit !== undefined
  );
}

function compactLatestEvent(event) {
  const side = normalizeSide(event.side || event.direction || event.tradeSide);
  const tradeId = getTradeId(event);
  const action = getLifecycleAction(event);

  return {
    ...event,

    profile: SYSTEM_PROFILE,
    runnerProfile: event.runnerProfile || SYSTEM_PROFILE,

    tradeId: tradeId || undefined,
    side: side || event.side,
    action: action || event.action,

    analyzeKind: event.analyzeKind || "RUNNER_LATEST_EVENT",
    analyzeLifecycle: action || event.analyzeLifecycle,
    analyzeSource: event.analyzeSource || "runner_latest_scan_debug",
    analyzeTs: getEventTs(event),
  };
}

function eventKey(event, fallbackIndex = 0) {
  const tradeId = getTradeId(event);
  const action = getLifecycleAction(event);

  if (tradeId && action) return `${tradeId}:${action}`;

  if (tradeId) return tradeId;

  const kind = normalizeText(event?.analyzeKind || event?.type);
  const symbol = String(event?.symbol || "").toUpperCase().trim();
  const side = normalizeSide(event?.side || event?.direction || event?.tradeSide);
  const ts = getEventTs(event, fallbackIndex);

  return [kind || "EVENT", symbol, side, action || "UNKNOWN", ts, fallbackIndex].join("|");
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
        analyzeEventKey: event.analyzeEventKey || key,
      });
      return;
    }

    const prevTs = getEventTs(previous, 0);
    const nextTs = getEventTs(event, 0);

    if (nextTs >= prevTs) {
      map.set(key, {
        ...previous,
        ...event,
        analyzeEventKey: previous.analyzeEventKey || event.analyzeEventKey || key,
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
  ];

  return dedupeEvents(raw.map(compactLatestEvent));
}

// ================= STORE LOADERS =================

async function loadStoredEvents() {
  const loadStore =
    analyzeStore.loadRunnerAnalyzeStore ||
    analyzeStore.loadAnalyzeStore ||
    analyzeStore.default?.loadRunnerAnalyzeStore ||
    analyzeStore.default?.loadAnalyzeStore;

  const loadEvents =
    analyzeStore.loadRunnerAnalyzeEvents ||
    analyzeStore.readRunnerAnalyzeEvents ||
    analyzeStore.getRunnerAnalyzeEvents ||
    analyzeStore.loadAnalyzeEvents ||
    analyzeStore.readAnalyzeEvents ||
    analyzeStore.getAnalyzeEvents ||
    analyzeStore.default?.loadRunnerAnalyzeEvents ||
    analyzeStore.default?.readRunnerAnalyzeEvents ||
    analyzeStore.default?.getRunnerAnalyzeEvents ||
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
        error: store?.error || null,
      },
      events,
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
        primary: "runner_events_loader",
        redisEnabled: false,
        fileEnabled: false,
        error: null,
      },
      events: safeArray(events),
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
      error: "NO_RUNNER_ANALYZE_STORE_LOADER_FOUND",
    },
    events: [],
  };
}

async function clearStoredEvents() {
  const clearFn =
    analyzeStore.clearRunnerAnalyzeEvents ||
    analyzeStore.resetRunnerAnalyzeEvents ||
    analyzeStore.clearAnalyzeEvents ||
    analyzeStore.resetAnalyzeEvents ||
    analyzeStore.default?.clearRunnerAnalyzeEvents ||
    analyzeStore.default?.resetRunnerAnalyzeEvents ||
    analyzeStore.default?.clearAnalyzeEvents ||
    analyzeStore.default?.resetAnalyzeEvents;

  if (typeof clearFn !== "function") {
    return {
      ok: false,
      error: "NO_CLEAR_RUNNER_ANALYZE_EVENTS_EXPORT_FOUND",
    };
  }

  return clearFn();
}

// ================= REPORT BUILDER =================

function buildReport(events, options) {
  const buildFn =
    familyEngine.buildRunnerAnalyzeReport ||
    familyEngine.buildAnalyzeReport ||
    familyEngine.buildRunnerFamilyReport ||
    familyEngine.buildFamilyReport ||
    familyEngine.buildReport ||
    familyEngine.analyzeEvents ||
    familyEngine.createAnalyzeReport ||
    familyEngine.default?.buildRunnerAnalyzeReport ||
    familyEngine.default?.buildAnalyzeReport ||
    familyEngine.default?.buildRunnerFamilyReport ||
    familyEngine.default?.buildFamilyReport ||
    familyEngine.default?.buildReport ||
    familyEngine.default?.analyzeEvents ||
    familyEngine.default?.createAnalyzeReport;

  if (typeof buildFn !== "function") {
    throw new Error("NO_RUNNER_ANALYZE_REPORT_BUILDER_FOUND");
  }

  return buildFn(events, {
    profile: SYSTEM_PROFILE,
    mode: SYSTEM_MODE,
    strategyFamily: STRATEGY_FAMILY,
    ...options,
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

      setupClass: event.setupClass || null,
      entryType: event.entryType || event.runnerEntryType || null,
      runnerFlow: event.flow || event.scannerFlow || null,

      familyId:
        event.familyId ||
        event.runnerFamilyId ||
        event.analyzeFamilyId ||
        event.filterSnapshot?.familyId ||
        null,

      closed: Boolean(event.closed),
      realizedR: event.realizedR ?? event.pnlR ?? event.resultR ?? event.exitR ?? null,
      pnlPct: event.pnlPct ?? event.realizedPnlPct ?? null,
      exitReason: event.exitReason || event.reason || null,
      ts: getEventTs(event, null),
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

function countActions(events) {
  const counts = {};

  for (const event of safeArray(events)) {
    const action = getLifecycleAction(event) || "UNKNOWN";
    counts[action] = safeNumber(counts[action], 0) + 1;
  }

  return counts;
}

function selectEvents({ storedEvents, latestEvents, sourceMode }) {
  if (sourceMode === "latest") {
    return {
      selectedEvents: latestEvents,
      selectedSource: "latest",
    };
  }

  if (sourceMode === "merged") {
    return {
      selectedEvents: dedupeEvents([...storedEvents, ...latestEvents]),
      selectedSource: "merged",
    };
  }

  return {
    selectedEvents: storedEvents,
    selectedSource: "stored",
  };
}

// ================= HANDLER =================

export default async function handler(req, res) {
  const startedAt = Date.now();

  res.setHeader("Cache-Control", "no-store, max-age=0");

  const debug = normalizeBoolean(req?.query?.debug, false);
  const reset = normalizeBoolean(req?.query?.reset, false);
  const status = normalizeBoolean(req?.query?.status, false);

  const includeLatest = normalizeBoolean(
    req?.query?.includeLatest,
    DEFAULT_INCLUDE_LATEST
  );

  const minClosed = safeNumber(req?.query?.minClosed, DEFAULT_MIN_CLOSED);

  const sourceMode = String(req?.query?.source || "stored").toLowerCase().trim();
  const normalizedSourceMode = ["stored", "latest", "merged"].includes(sourceMode)
    ? sourceMode
    : "stored";

  try {
    if (status) {
      return res.status(200).json(buildStatusResponse());
    }

    if (reset) {
      const clearResult = await clearStoredEvents();

      return res.status(clearResult?.ok ? 200 : 500).json({
        ok: Boolean(clearResult?.ok),
        profile: SYSTEM_PROFILE,
        reset: true,
        clearResult,
        generatedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
      });
    }

    const { store, events: storedEventsRaw } = await loadStoredEvents();

    const shouldLoadLatest =
      includeLatest ||
      normalizedSourceMode === "latest" ||
      normalizedSourceMode === "merged";

    const latest = shouldLoadLatest
      ? await getLatestScan().catch(error => ({
          ok: false,
          error: error?.message || String(error),
        }))
      : {
          ok: null,
          skipped: true,
          reason: "includeLatest=false",
        };

    const storedEvents = dedupeEvents(storedEventsRaw);
    const latestEvents =
      latest?.ok && shouldLoadLatest
        ? collectLatestEvents(latest)
        : [];

    const { selectedEvents, selectedSource } = selectEvents({
      storedEvents,
      latestEvents,
      sourceMode: normalizedSourceMode,
    });

    const report = buildReport(selectedEvents, {
      minClosed,
      familyCountLong: 50,
      familyCountShort: 50,
      sideAliases: {
        LONG: ["LONG", "BULL", "BUY"],
        SHORT: ["SHORT", "BEAR", "SELL"],
      },
    });

    const response = {
      ok: true,
      profile: SYSTEM_PROFILE,
      system: SYSTEM_PROFILE,
      mode: SYSTEM_MODE,
      strategyFamily: STRATEGY_FAMILY,

      generatedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,

      analyzeRoute: "/api/analyze",
      statusRoute: "/api/analyze?status=true",

      modeInfo: {
        source: selectedSource,
        includeLatest,
        minClosed,
        note:
          selectedSource === "stored"
            ? "Runner analyse gebruikt alleen opgeslagen runner analyse-records. Latest scan wordt niet meegeteld tenzij source=latest/merged of includeLatest=true."
            : "Runner analyse gebruikt latest/debug data. Gebruik source=stored voor echte runner family-statistiek.",
      },

      mode: {
        source: selectedSource,
        includeLatest,
        minClosed,
        note:
          selectedSource === "stored"
            ? "Runner analyse gebruikt alleen opgeslagen runner analyse-records."
            : "Runner analyse gebruikt latest/debug data.",
      },

      sources: {
        selectedEvents: selectedEvents.length,
        storedEvents: storedEvents.length,
        latestEvents: latestEvents.length,

        storedKinds: countKinds(storedEvents),
        latestKinds: countKinds(latestEvents),
        selectedKinds: countKinds(selectedEvents),

        storedActions: countActions(storedEvents),
        latestActions: countActions(latestEvents),
        selectedActions: countActions(selectedEvents),

        store,

        latest: {
          ok: latest?.ok ?? null,
          skipped: Boolean(latest?.skipped),
          reason: latest?.reason || null,
          updatedAt: latest?.updatedAt || null,
          tradeFunnelUpdatedAt: latest?.tradeFunnelUpdatedAt || null,
          error: latest?.error || null,
        },
      },

      tradesLoaded: selectedEvents.length,
      report,
    };

    if (debug) {
      response.debug = {
        storedPreview: compactSourcePreview(storedEvents),
        latestPreview: compactSourcePreview(latestEvents),
        selectedPreview: compactSourcePreview(selectedEvents),
      };
    }

    return res.status(200).json(response);
  } catch (error) {
    console.error("RUNNER ANALYSE API ERROR:", error);

    return res.status(500).json({
      ok: false,
      profile: SYSTEM_PROFILE,
      system: SYSTEM_PROFILE,
      generatedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      error: serializeError(error, debug),
    });
  }
}