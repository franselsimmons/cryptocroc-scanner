import * as analyzeStore from "../lib/analyze/runnerAnalyzeStore.js";
import * as familyEngine from "../lib/analyze/runnerFamilyEngine.js";

const DEFAULT_MIN_CLOSED = 10;
const MAX_DEBUG_EVENTS = 50;
const SYSTEM_PROFILE = "RUNNER";
const SYSTEM_MODE = "MOMENTUM_RUNNER";
const STRATEGY_FAMILY = "BREAKOUT_CONTINUATION_SQUEEZE";

// ================= GENERIC HELPERS =================

function safeArray(value) {
  return Array.isArray(value) ? value : [];
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
    name: error?.name || "Error",
  };

  if (debug && error?.stack) {
    payload.stack = error.stack;
  }

  return payload;
}

// ================= EVENT HELPERS =================

function getTradeId(event) {
  const id =
    event?.tradeId ||
    event?.positionTradeId ||
    event?.positionId ||
    event?.orderId ||
    event?.clientOrderId ||
    event?.analyzeEventId ||
    event?.analyzeEventKey ||
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

function isIgnoredAction(event) {
  const action = normalizeText(event?.action || event?.status || event?.reason);
  const kind = normalizeText(event?.analyzeKind || event?.type);

  if (kind === "TRADE_RECORD") return false;
  if (kind === "TRADE") return false;
  if (kind === "UNMATCHED_EXIT") return false;

  return (
    action === "WAIT" ||
    action === "HOLD" ||
    action === "RUNNING" ||
    action === "NO_TRADE" ||
    action === "SKIP"
  );
}

function isRunnerProfile(event) {
  const profile = normalizeText(
    event?.profile ||
      event?.runnerProfile ||
      event?.filterSnapshot?.profile ||
      event?.filterSnapshot?.runnerProfile ||
      ""
  );

  return !profile || profile === SYSTEM_PROFILE;
}

function isTradeLikeRecord(event) {
  if (!event || typeof event !== "object") return false;
  if (!isRunnerProfile(event)) return false;
  if (isIgnoredAction(event)) return false;

  const kind = normalizeText(event.analyzeKind || event.type);
  const action = normalizeText(event.action || event.status || event.reason || event.event);

  if (kind === "TRADE_RECORD" || kind === "TRADE") return true;
  if (kind === "UNMATCHED_EXIT") return true;

  if (action.includes("ENTRY")) return true;
  if (action.includes("EXIT")) return true;
  if (action.includes("TP")) return true;
  if (action.includes("SL")) return true;
  if (action.includes("RUNNER_A")) return true;
  if (action.includes("RUNNER_B")) return true;
  if (action.includes("RUNNER_C")) return true;

  if (event.closed === true || event.isClosed === true) return true;

  return Boolean(
    event.tradeId ||
      event.positionId ||
      event.orderId ||
      event.entry !== undefined ||
      event.entryPrice !== undefined ||
      event.openPrice !== undefined ||
      event.exitPrice !== undefined ||
      event.exit !== undefined ||
      event.pnlR !== undefined ||
      event.realizedR !== undefined ||
      event.pnlPct !== undefined
  );
}

function compactLatestEvent(event) {
  const side = normalizeSide(event.side || event.direction || event.tradeSide);
  const tradeId = getTradeId(event);

  return {
    ...event,
    profile: SYSTEM_PROFILE,
    runnerProfile: event.runnerProfile || SYSTEM_PROFILE,
    tradeId: tradeId || undefined,
    side: side || event.side,
    analyzeSource: event.analyzeSource || "runner_latest_debug",
    analyzeTs: getEventTs(event),
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
    ...safeArray(latest.runnerTrades),
    ...safeArray(latest.tradeSystemResult?.actions),
    ...safeArray(latest.runnerTradeSystemResult?.actions),
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
    const store = await loadStore({ force: true });
    const events = safeArray(store?.events);

    return {
      store: {
        ok: Boolean(store?.ok),
        profile: store?.profile || SYSTEM_PROFILE,
        source: store?.source || "runner_analyze_store",
        path: store?.path || null,
        redisKey: store?.redisKey || null,
        count: safeNumber(store?.count, events.length),
        trades: safeNumber(store?.trades, events.length),
        open: safeNumber(store?.open, 0),
        closed: safeNumber(store?.closed, 0),
        unmatchedExits: safeNumber(store?.unmatchedExits, 0),
        maxStoredEvents: store?.maxStoredEvents || null,
        redisEnabled: Boolean(store?.redisEnabled),
        fileEnabled: store?.fileEnabled !== false,
        loadedAt: store?.loadedAt || null,
        lastPersistAt: store?.lastPersistAt || null,
        error: store?.error || null,
      },
      events,
    };
  }

  if (typeof loadEvents === "function") {
    const events = await loadEvents({ force: true });

    return {
      store: {
        ok: true,
        profile: SYSTEM_PROFILE,
        source: "events_loader",
        path: null,
        redisKey: null,
        count: safeArray(events).length,
        trades: safeArray(events).length,
        open: 0,
        closed: 0,
        unmatchedExits: 0,
        maxStoredEvents: null,
        redisEnabled: false,
        fileEnabled: false,
        loadedAt: null,
        lastPersistAt: null,
        error: null,
      },
      events: safeArray(events),
    };
  }

  return {
    store: {
      ok: false,
      profile: SYSTEM_PROFILE,
      source: null,
      path: null,
      redisKey: null,
      count: 0,
      trades: 0,
      open: 0,
      closed: 0,
      unmatchedExits: 0,
      maxStoredEvents: null,
      redisEnabled: false,
      fileEnabled: false,
      loadedAt: null,
      lastPersistAt: null,
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
    familyEngine.buildFamilyReport ||
    familyEngine.buildReport ||
    familyEngine.analyzeEvents ||
    familyEngine.createAnalyzeReport ||
    familyEngine.default?.buildRunnerAnalyzeReport ||
    familyEngine.default?.buildAnalyzeReport ||
    familyEngine.default?.buildFamilyReport ||
    familyEngine.default?.buildReport ||
    familyEngine.default?.analyzeEvents ||
    familyEngine.default?.createAnalyzeReport;

  if (typeof buildFn !== "function") {
    throw new Error("NO_RUNNER_ANALYZE_REPORT_BUILDER_FOUND");
  }

  return buildFn(events, options);
}

// ================= DEBUG =================

function compactSourcePreview(events) {
  return safeArray(events)
    .slice(-MAX_DEBUG_EVENTS)
    .map(event => ({
      tradeId: getTradeId(event) || null,
      profile: event.profile || event.runnerProfile || null,
      analyzeKind: event.analyzeKind || event.type || null,
      source: event.analyzeSource || null,
      symbol: event.symbol || null,
      side: normalizeSide(event.side || event.direction || event.tradeSide) || null,
      familyId:
        event.familyId ||
        event.runnerFamilyId ||
        event.analyzeFamilyId ||
        event.filterSnapshot?.familyId ||
        event.filterSnapshot?.runnerFamilyId ||
        null,
      closed: Boolean(event.closed),
      realizedR: event.realizedR ?? event.pnlR ?? event.resultR ?? null,
      pnlPct: event.pnlPct ?? event.realizedPnlPct ?? null,
      exitReason: event.exitReason || null,
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

  const minClosed = safeNumber(req?.query?.minClosed, DEFAULT_MIN_CLOSED);

  const sourceMode = String(req?.query?.source || "stored").toLowerCase().trim();
  const normalizedSourceMode = ["stored", "latest", "merged"].includes(sourceMode)
    ? sourceMode
    : "stored";

  try {
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

    const storedEvents = dedupeEvents(storedEventsRaw);

    // Runner latest is optioneel. Als je later een runner latest-store toevoegt,
    // kun je hier collectLatestEvents(latest) vullen. Nu is stored de waarheid.
    const latest = {
      ok: true,
      skipped: true,
      reason: "runner_latest_not_configured",
      updatedAt: null,
      tradeFunnelUpdatedAt: null,
      error: null,
    };

    const latestEvents = [];
    const { selectedEvents, selectedSource } = selectEvents({
      storedEvents,
      latestEvents,
      sourceMode: normalizedSourceMode,
    });

    const report = buildReport(selectedEvents, {
      minClosed,
      familyCountLong: 50,
      familyCountShort: 50,
      objective: "RUNNER_TOTAL_PNL_FIRST",
    });

    const response = {
      ok: true,
      profile: SYSTEM_PROFILE,
      system: SYSTEM_PROFILE,
      mode: SYSTEM_MODE,
      strategyFamily: STRATEGY_FAMILY,

      generatedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,

      modules: {
        scanner: "RUNNER_SCANNER",
        tradeFunnel: "RUNNER_TRADE_FUNNEL",
        tradeSystem: "RUNNER_TRADE_SYSTEM",
        analyzer: "RUNNER_ANALYZER",
        performance: "RUNNER_PERFORMANCE",
        executionStyle: STRATEGY_FAMILY,
      },

      modeInfo: {
        source: selectedSource,
        minClosed,
        objective: "Runner analyse kiest PnL-first families. Winrate is niet dominant.",
        note:
          selectedSource === "stored"
            ? "Runner analyse gebruikt opgeslagen runner analyse-records."
            : "Runner analyse gebruikt geselecteerde debug/latest/merged data.",
      },

      sources: {
        selectedEvents: selectedEvents.length,
        storedEvents: storedEvents.length,
        latestEvents: latestEvents.length,
        mergedEvents: selectedSource === "merged" ? selectedEvents.length : 0,
        storedKinds: countKinds(storedEvents),
        latestKinds: countKinds(latestEvents),
        selectedKinds: countKinds(selectedEvents),
        store,
        latest,
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
    console.error("RUNNER ANALYZE API ERROR:", error);

    return res.status(500).json({
      ok: false,
      profile: SYSTEM_PROFILE,
      generatedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      error: serializeError(error, debug),
    });
  }
}