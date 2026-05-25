import { getLatestScan } from "../lib/scanStore.js";
import * as analyzeStore from "../lib/analyze/runnerAnalyzeStore.js";
import * as familyEngine from "../lib/analyze/runnerFamilyEngine.js";

const DEFAULT_MIN_CLOSED = 10;
const DEFAULT_INCLUDE_LATEST = false;
const MAX_DEBUG_EVENTS = 50;

const SYSTEM_PROFILE = "RUNNER";

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

  if (["true", "1", "yes", "y"].includes(v)) return true;
  if (["false", "0", "no", "n"].includes(v)) return false;

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

// ================= TRADE RECORD HELPERS =================

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
  if (kind === "UNMATCHED_EXIT") return false;

  return (
    action === "WAIT" ||
    action === "HOLD" ||
    action === "RUNNING" ||
    action === "NO_TRADE" ||
    action === "SKIP" ||
    action === "COOLDOWN"
  );
}

function isTradeLikeRecord(event) {
  if (!event || typeof event !== "object") return false;
  if (isIgnoredAction(event)) return false;

  const kind = normalizeText(event.analyzeKind || event.type);

  if (kind === "TRADE_RECORD") return true;
  if (kind === "TRADE") return true;
  if (kind === "UNMATCHED_EXIT") return true;

  const action = normalizeText(event.action || event.status || event.reason || event.event);

  if (action.includes("ENTRY")) return true;
  if (action.includes("EXIT")) return true;
  if (action.includes("TP")) return true;
  if (action.includes("SL")) return true;
  if (action.includes("CLOSE")) return true;

  if (event.closed === true) return true;
  if (event.isClosed === true) return true;

  return Boolean(
    event.tradeId ||
      event.positionId ||
      event.orderId ||
      event.entry !== undefined ||
      event.entryPrice !== undefined ||
      event.openPrice !== undefined ||
      event.exit !== undefined ||
      event.exitPrice !== undefined ||
      event.realizedR !== undefined ||
      event.pnlR !== undefined ||
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
    analyzeSource: event.analyzeSource || "runner_latest_scan_debug",
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
    ...safeArray(latest.tradeSystemResult?.trades),
    ...safeArray(latest.tradeSystemResult?.actions),
    ...safeArray(latest.actions),
    ...safeArray(latest.runnerActions),
    ...safeArray(latest.openPositions),
    ...safeArray(latest.tradeSystemResult?.openPositions),
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
        profile: store?.profile || SYSTEM_PROFILE,
        path: store?.path || null,
        redisKey: store?.redisKey || null,
        count: safeNumber(store?.count, events.length),
        trades: safeNumber(store?.trades, events.length),
        open: safeNumber(store?.open, 0),
        closed: safeNumber(store?.closed, 0),
        unmatchedExits: safeNumber(store?.unmatchedExits, 0),
        maxStoredEvents: store?.maxStoredEvents || null,
        primary: store?.primary || store?.source || "runner_analyze_store",
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
        profile: SYSTEM_PROFILE,
        path: null,
        redisKey: null,
        count: safeArray(events).length,
        trades: safeArray(events).length,
        open: 0,
        closed: 0,
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
      profile: SYSTEM_PROFILE,
      path: null,
      redisKey: null,
      count: 0,
      trades: 0,
      open: 0,
      closed: 0,
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
      profile: SYSTEM_PROFILE,
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

function compactSourcePreview(events) {
  return safeArray(events)
    .slice(-MAX_DEBUG_EVENTS)
    .map(event => ({
      tradeId: getTradeId(event) || null,
      analyzeKind: event.analyzeKind || event.type || null,
      source: event.analyzeSource || null,
      profile: event.profile || event.runnerProfile || null,
      symbol: event.symbol || null,
      side: normalizeSide(event.side || event.direction || event.tradeSide) || null,
      familyId:
        event.runnerFamilyId ||
        event.familyId ||
        event.analyzeFamilyId ||
        event.filterSnapshot?.runnerFamilyId ||
        event.filterSnapshot?.familyId ||
        null,
      closed: Boolean(event.closed),
      realizedR: event.realizedR ?? event.pnlR ?? event.resultR ?? event.outcomeR ?? null,
      pnlPct: event.pnlPct ?? event.realizedPnlPct ?? null,
      exitReason: event.exitReason || event.reason || null,
      ts: getEventTs(event, null),
    }));
}

function countKinds(events) {
  const counts = {};

  for (const event of safeArray(events)) {
    const kind = normalizeText(event?.analyzeKind || event?.type || event?.action || "UNKNOWN");
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

  const debug = normalizeBoolean(req?.query?.debug, false);
  const reset = normalizeBoolean(req?.query?.reset, false);

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
    res.setHeader("Cache-Control", "no-store, max-age=0");

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

    const mergedEvents = dedupeEvents([...storedEvents, ...latestEvents]);

    const { selectedEvents, selectedSource } = selectEvents({
      storedEvents,
      latestEvents,
      sourceMode: normalizedSourceMode,
    });

    const report = buildReport(selectedEvents, {
      profile: SYSTEM_PROFILE,
      minClosed,
      familyCountLong: 50,
      familyCountShort: 50,
    });

    const response = {
      ok: true,
      profile: SYSTEM_PROFILE,
      generatedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,

      mode: {
        profile: SYSTEM_PROFILE,
        source: selectedSource,
        includeLatest,
        minClosed,
        note:
          selectedSource === "stored"
            ? "Runner analyse gebruikt alleen opgeslagen runner analyse-records. Latest scan wordt niet meegeteld tenzij source=latest/merged of includeLatest=true met source=latest/merged."
            : "Runner analyse gebruikt latest/debug data. Gebruik source=stored voor echte runner family-statistiek.",
      },

      sources: {
        selectedEvents: selectedEvents.length,
        storedEvents: storedEvents.length,
        latestEvents: latestEvents.length,
        mergedEvents: mergedEvents.length,
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