import * as runnerAnalyzeStore from "../lib/analyze/runnerAnalyzeStore.js";
import * as runnerFamilyEngine from "../lib/analyze/runnerFamilyEngine.js";

const STARTED_AT = Date.now();

const SYSTEM_PROFILE = "RUNNER";
const SYSTEM_MODE = "MOMENTUM_RUNNER";
const STRATEGY_FAMILY = "BREAKOUT_CONTINUATION_SQUEEZE";

const DEFAULT_MIN_CLOSED = 10;
const DEFAULT_INCLUDE_LATEST = false;
const MAX_DEBUG_EVENTS = 80;

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
    name: error?.name || "Error",
  };

  if (debug && error?.stack) {
    payload.stack = error.stack;
  }

  return payload;
}

// ================= TRADE EVENT HELPERS =================

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

function getTradeId(event) {
  const direct =
    event?.tradeId ||
    event?.positionTradeId ||
    event?.positionId ||
    event?.orderId ||
    event?.clientOrderId ||
    event?.analyzeEventKey ||
    event?.analyzeEventId ||
    event?.eventId ||
    event?.id;

  if (direct) return String(direct);

  const symbol = normalizeSymbol(event?.symbol);
  const side = normalizeSide(event?.side || event?.direction || event?.tradeSide);
  const entry = safeNumber(event?.entry ?? event?.entryPrice ?? event?.openPrice, 0);
  const ts = normalizeTs(
    event?.openedAt ??
      event?.entryTs ??
      event?.createdAt ??
      event?.closedAt ??
      event?.exitedAt ??
      event?.exitAt ??
      event?.exitTs ??
      event?.updatedAt ??
      event?.ts ??
      event?.timestamp,
    0
  );

  if (!symbol || !side || !entry || !ts) return "";

  return `RUNNER_${symbol}_${side}_${ts}_${Number(entry).toPrecision(12)}`;
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
      event?.ts ??
      event?.timestamp,
    fallback
  );
}

function isIgnoredAction(event) {
  const action = normalizeText(event?.action || event?.event || event?.status || event?.reason);
  const kind = normalizeText(event?.analyzeKind || event?.type);

  if (kind === "TRADE_RECORD") return false;
  if (kind === "TRADE") return false;
  if (kind === "UNMATCHED_EXIT") return false;

  return (
    action === "WAIT" ||
    action === "HOLD" ||
    action === "RUNNING" ||
    action === "NO_TRADE" ||
    action === "SKIP" ||
    action === "FILTERED"
  );
}

function isRunnerProfile(event) {
  const profile = normalizeText(
    event?.profile ||
      event?.runnerProfile ||
      event?.scannerProfile ||
      event?.tradeSystemProfile ||
      event?.filterSnapshot?.profile ||
      event?.filterSnapshot?.runnerProfile ||
      ""
  );

  if (!profile) return true;

  return profile === SYSTEM_PROFILE;
}

function isTradeLikeRecord(event) {
  if (!event || typeof event !== "object") return false;
  if (!isRunnerProfile(event)) return false;
  if (isIgnoredAction(event)) return false;

  const kind = normalizeText(event?.analyzeKind || event?.type);
  const action = normalizeText(event?.action || event?.event || event?.status || event?.reason);

  if (kind === "TRADE_RECORD" || kind === "TRADE") return true;
  if (kind === "UNMATCHED_EXIT") return true;

  if (action.includes("ENTRY")) return true;
  if (action.includes("RUNNER_A")) return true;
  if (action.includes("RUNNER_B")) return true;
  if (action.includes("RUNNER_C")) return true;
  if (action.includes("EXIT")) return true;
  if (action.includes("TP")) return true;
  if (action.includes("SL")) return true;
  if (action.includes("CLOSE")) return true;

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
    symbol: normalizeSymbol(event.symbol || event.instId || event.coin),
    side: side || event.side,

    analyzeSource: event.analyzeSource || "runner_latest_scan",
    analyzeTs: getEventTs(event),

    filterSnapshot: {
      ...safeObject(event.filterSnapshot),
      profile: SYSTEM_PROFILE,
      runnerProfile: event.runnerProfile || SYSTEM_PROFILE,
      familyId:
        event.familyId ||
        event.runnerFamilyId ||
        event.analyzeFamilyId ||
        event.filterSnapshot?.familyId ||
        event.filterSnapshot?.runnerFamilyId ||
        event.filterSnapshot?.analyzeFamilyId,
      runnerFamilyId:
        event.runnerFamilyId ||
        event.familyId ||
        event.analyzeFamilyId ||
        event.filterSnapshot?.runnerFamilyId ||
        event.filterSnapshot?.familyId ||
        event.filterSnapshot?.analyzeFamilyId,
    },
  };
}

function eventKey(event, fallbackIndex = 0) {
  const tradeId = getTradeId(event);

  if (tradeId) return tradeId;

  const kind = normalizeText(event?.analyzeKind || event?.type || event?.action || event?.event);
  const symbol = normalizeSymbol(event?.symbol || event?.instId || event?.coin);
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

// ================= LATEST SCAN LOADER =================

async function loadLatestScan() {
  try {
    const mod = await import("../lib/scanStore.js");
    const getLatestScan =
      mod.getLatestScan ||
      mod.default?.getLatestScan ||
      mod.readLatestScan ||
      mod.default?.readLatestScan;

    if (typeof getLatestScan !== "function") {
      return {
        ok: false,
        error: "NO_GET_LATEST_SCAN_EXPORT_FOUND",
      };
    }

    return await getLatestScan();
  } catch (error) {
    return {
      ok: false,
      error: error?.message || "latest_scan_load_failed",
    };
  }
}

function collectLatestEvents(latest) {
  if (!latest?.ok) return [];

  const raw = [
    ...safeArray(latest.trades),
    ...safeArray(latest.closedTrades),
    ...safeArray(latest.runnerTrades),
    ...safeArray(latest.tradeHistory),
    ...safeArray(latest.tradeSystemResult?.trades),
    ...safeArray(latest.tradeSystemResult?.closedTrades),
    ...safeArray(latest.tradeSystemResult?.actions),
    ...safeArray(latest.tradeSystemAnalysis?.actions),
    ...safeArray(latest.actions),
    ...safeArray(latest.openPositions),
    ...safeArray(latest.tradeSystemResult?.openPositions),
    ...safeArray(latest.tradeSystemAnalysis?.openPositions),
  ];

  return dedupeEvents(raw.map(compactLatestEvent));
}

// ================= STORE LOADERS =================

async function loadStoredEvents() {
  const loadStore =
    runnerAnalyzeStore.loadRunnerAnalyzeStore ||
    runnerAnalyzeStore.loadAnalyzeStore ||
    runnerAnalyzeStore.default?.loadRunnerAnalyzeStore ||
    runnerAnalyzeStore.default?.loadAnalyzeStore;

  const loadEvents =
    runnerAnalyzeStore.loadRunnerAnalyzeEvents ||
    runnerAnalyzeStore.loadAnalyzeEvents ||
    runnerAnalyzeStore.readRunnerAnalyzeEvents ||
    runnerAnalyzeStore.readAnalyzeEvents ||
    runnerAnalyzeStore.getRunnerAnalyzeEvents ||
    runnerAnalyzeStore.getAnalyzeEvents ||
    runnerAnalyzeStore.default?.loadRunnerAnalyzeEvents ||
    runnerAnalyzeStore.default?.loadAnalyzeEvents ||
    runnerAnalyzeStore.default?.readRunnerAnalyzeEvents ||
    runnerAnalyzeStore.default?.readAnalyzeEvents ||
    runnerAnalyzeStore.default?.getRunnerAnalyzeEvents ||
    runnerAnalyzeStore.default?.getAnalyzeEvents;

  if (typeof loadStore === "function") {
    const store = await loadStore();
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
        primary: store?.primary || store?.source || null,
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
    const events = await loadEvents();

    return {
      store: {
        ok: true,
        profile: SYSTEM_PROFILE,
        source: "runner_events_loader",
        path: null,
        redisKey: null,
        count: safeArray(events).length,
        trades: safeArray(events).length,
        open: 0,
        closed: 0,
        unmatchedExits: 0,
        maxStoredEvents: null,
        primary: "events_loader",
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
      source: null,
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
    runnerAnalyzeStore.clearRunnerAnalyzeEvents ||
    runnerAnalyzeStore.clearAnalyzeEvents ||
    runnerAnalyzeStore.resetRunnerAnalyzeEvents ||
    runnerAnalyzeStore.resetAnalyzeEvents ||
    runnerAnalyzeStore.default?.clearRunnerAnalyzeEvents ||
    runnerAnalyzeStore.default?.clearAnalyzeEvents ||
    runnerAnalyzeStore.default?.resetRunnerAnalyzeEvents ||
    runnerAnalyzeStore.default?.resetAnalyzeEvents;

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
    runnerFamilyEngine.buildRunnerAnalyzeReport ||
    runnerFamilyEngine.buildAnalyzeReport ||
    runnerFamilyEngine.buildFamilyReport ||
    runnerFamilyEngine.buildReport ||
    runnerFamilyEngine.analyzeEvents ||
    runnerFamilyEngine.createAnalyzeReport ||
    runnerFamilyEngine.default?.buildRunnerAnalyzeReport ||
    runnerFamilyEngine.default?.buildAnalyzeReport ||
    runnerFamilyEngine.default?.buildFamilyReport ||
    runnerFamilyEngine.default?.buildReport ||
    runnerFamilyEngine.default?.analyzeEvents ||
    runnerFamilyEngine.default?.createAnalyzeReport;

  if (typeof buildFn !== "function") {
    throw new Error("NO_RUNNER_ANALYZE_REPORT_BUILDER_FOUND");
  }

  return buildFn(events, {
    profile: SYSTEM_PROFILE,
    familyCountLong: 50,
    familyCountShort: 50,
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
      profile: event.profile || event.runnerProfile || null,
      symbol: normalizeSymbol(event.symbol || event.instId || event.coin) || null,
      side: normalizeSide(event.side || event.direction || event.tradeSide) || null,
      familyId:
        event.familyId ||
        event.runnerFamilyId ||
        event.analyzeFamilyId ||
        event.filterSnapshot?.familyId ||
        event.filterSnapshot?.runnerFamilyId ||
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
    const kind = normalizeText(event?.analyzeKind || event?.type || event?.action || event?.event || "UNKNOWN");
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

  const includeLatest = normalizeBoolean(
    req?.query?.includeLatest,
    DEFAULT_INCLUDE_LATEST
  );

  const minClosed = Math.max(
    0,
    Math.round(safeNumber(req?.query?.minClosed, DEFAULT_MIN_CLOSED))
  );

  const sourceModeRaw = String(req?.query?.source || "stored").toLowerCase().trim();
  const sourceMode = ["stored", "latest", "merged"].includes(sourceModeRaw)
    ? sourceModeRaw
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

    const latest =
      includeLatest || sourceMode === "latest" || sourceMode === "merged"
        ? await loadLatestScan()
        : {
            ok: null,
            skipped: true,
            reason: "includeLatest=false",
          };

    const storedEvents = dedupeEvents(storedEventsRaw.map(compactLatestEvent));

    const latestEvents =
      latest?.ok &&
      (includeLatest || sourceMode === "latest" || sourceMode === "merged")
        ? collectLatestEvents(latest)
        : [];

    const { selectedEvents, selectedSource } = selectEvents({
      storedEvents,
      latestEvents,
      sourceMode,
    });

    const report = buildReport(selectedEvents, {
      minClosed,
      familyCountLong: 50,
      familyCountShort: 50,
    });

    const response = {
      ok: true,

      system: SYSTEM_PROFILE,
      profile: SYSTEM_PROFILE,
      scannerProfile: SYSTEM_PROFILE,
      tradeSystemProfile: SYSTEM_PROFILE,

      status: "ACTIVE",
      mode: SYSTEM_MODE,
      strategyFamily: STRATEGY_FAMILY,

      generatedAt: new Date().toISOString(),
      startedAt: STARTED_AT,
      uptimeMs: Date.now() - STARTED_AT,
      latencyMs: Date.now() - startedAt,

      modeInfo: {
        source: selectedSource,
        includeLatest,
        minClosed,
        note:
          selectedSource === "stored"
            ? "Runner analyse gebruikt alleen opgeslagen runner analyse-records. Latest scan wordt niet meegeteld tenzij source=latest/merged of includeLatest=true."
            : "Runner analyse gebruikt latest/debug data. Gebruik source=stored voor zuivere family-statistiek.",
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
        mergedEvents: dedupeEvents([...storedEvents, ...latestEvents]).length,

        storedKinds: countKinds(storedEvents),
        latestKinds: countKinds(latestEvents),
        selectedKinds: countKinds(selectedEvents),

        store,

        latest: {
          ok: latest?.ok ?? null,
          skipped: Boolean(latest?.skipped),
          reason: latest?.reason || null,
          updatedAt: latest?.updatedAt || null,
          storedAt: latest?.storedAt || null,
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