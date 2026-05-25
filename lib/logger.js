import {
  getAllLogs,
  insertClosedTrade,
  insertSystemLog,
  clearAllLogs
} from "./db.js";

const SYSTEM_PROFILE = "RUNNER";
const MAX_RECORDS = 20_000;

let historyCache = [];
let hydrated = false;
let hydratePromise = null;

// ================= HELPERS =================
function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function nullableNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeString(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function safeUpper(value, fallback = "") {
  return safeString(value, fallback).toUpperCase().trim();
}

function safeLower(value, fallback = "") {
  return safeString(value, fallback).toLowerCase().trim();
}

function nowTs() {
  return Date.now();
}

function makeId(prefix, symbol, side) {
  const rand = Math.random().toString(36).slice(2, 8);

  return [
    prefix,
    safeString(symbol, "UNKNOWN").toUpperCase(),
    safeString(side, "unknown").toLowerCase(),
    nowTs(),
    rand
  ].join("_");
}

function getTradeId(payload, fallbackPrefix = "RUNNER") {
  const id =
    payload?.tradeId ||
    payload?.positionTradeId ||
    payload?.positionId ||
    payload?.orderId ||
    payload?.clientOrderId ||
    payload?.id;

  if (id) return String(id);

  return makeId(fallbackPrefix, payload?.symbol, payload?.side);
}

function trimCache() {
  if (historyCache.length <= MAX_RECORDS) return historyCache;

  historyCache = historyCache.slice(-MAX_RECORDS);
  return historyCache;
}

function calculatePnlPctFromValues(entry, exit, side) {
  const e = safeNumber(entry);
  const x = safeNumber(exit);
  const s = safeLower(side);

  if (!e || !x) return 0;

  if (s === "bear" || s === "short") {
    return ((e - x) / e) * 100;
  }

  return ((x - e) / e) * 100;
}

function calculatePnlPct(trade) {
  if (Number.isFinite(Number(trade?.pnlPct))) {
    return Number(trade.pnlPct);
  }

  if (Number.isFinite(Number(trade?.pnlPercent))) {
    return Number(trade.pnlPercent);
  }

  return calculatePnlPctFromValues(
    trade?.entry ?? trade?.entryPrice ?? trade?.openPrice,
    trade?.exit ?? trade?.exitPrice ?? trade?.executionPrice ?? trade?.price,
    trade?.side
  );
}

function getRealizedR(payload) {
  return nullableNumber(
    payload?.exitR ??
      payload?.realizedR ??
      payload?.pnlR ??
      payload?.resultR ??
      payload?.outcomeR ??
      payload?.rMultiple
  );
}

function normalizeResult(trade, pnlPct, realizedR = null) {
  if (trade?.result) {
    const r = safeUpper(trade.result);
    if (["WIN", "LOSS", "FLAT", "BREAKEVEN", "BE"].includes(r)) {
      if (r === "BREAKEVEN" || r === "BE") return "FLAT";
      return r;
    }
  }

  const reason = safeUpper(trade?.reason || trade?.exitReason);

  if (["TP", "TAKE_PROFIT", "TRAIL_PROFIT"].includes(reason)) return "WIN";
  if (["SL", "STOP_LOSS"].includes(reason)) return "LOSS";
  if (["BE_SL", "BREAKEVEN", "BREAK_EVEN"].includes(reason)) return "FLAT";

  if (Number.isFinite(Number(realizedR))) {
    if (realizedR > 0) return "WIN";
    if (realizedR < 0) return "LOSS";
    return "FLAT";
  }

  if (pnlPct > 0) return "WIN";
  if (pnlPct < 0) return "LOSS";

  return "FLAT";
}

function normalizeSide(value) {
  const s = safeLower(value);

  if (["bear", "short", "sell"].includes(s)) return "bear";
  if (["bull", "long", "buy"].includes(s)) return "bull";

  return s || "unknown";
}

function normalizeAnalyzerSide(value) {
  const s = normalizeSide(value);

  if (s === "bear") return "SHORT";
  if (s === "bull") return "LONG";

  return safeUpper(value, "UNKNOWN");
}

function isLegacyTradeRow(row) {
  if (!row || typeof row !== "object") return false;
  if (row.logType) return false;

  return (
    row.symbol !== undefined &&
    row.side !== undefined &&
    row.entry !== undefined &&
    row.exit !== undefined
  );
}

function normalizeEntryType(value) {
  const v = safeUpper(value);

  return v || "RUNNER_UNCLASSIFIED";
}

function normalizeRunnerProfile(value) {
  const v = safeUpper(value);

  return v || SYSTEM_PROFILE;
}

function normalizeTradeFunnelProfile(value) {
  const v = safeUpper(value);

  return v || SYSTEM_PROFILE;
}

function normalizeScannerQuality(value) {
  const v = safeUpper(value);

  return v || "N/A";
}

function normalizeTimestamp(value, fallback = Date.now()) {
  if (value instanceof Date) return value.getTime();

  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;

  const parsed = Date.parse(String(value || ""));
  if (Number.isFinite(parsed)) return parsed;

  return fallback;
}

function compactObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => {
      return v !== undefined && v !== null && v !== "";
    })
  );
}

function pushCache(row) {
  historyCache.push(row);
  trimCache();
  return row;
}

function persistTrade(row) {
  insertClosedTrade(row).catch(err => {
    console.error("RUNNER LOG TRADE PERSIST ERROR:", err?.message || err);
  });
}

function persistSystem(row) {
  insertSystemLog(row).catch(err => {
    console.error("RUNNER LOG SYSTEM PERSIST ERROR:", err?.message || err);
  });
}

// ================= HYDRATION =================
export async function hydrateLoggerFromDB(limit = MAX_RECORDS) {
  if (hydratePromise) return hydratePromise;

  hydratePromise = (async () => {
    try {
      const rows = await getAllLogs(limit);

      historyCache = Array.isArray(rows)
        ? rows.slice(-MAX_RECORDS)
        : [];

      hydrated = true;

      return {
        ok: true,
        profile: SYSTEM_PROFILE,
        total: historyCache.length,
        hydratedAt: Date.now()
      };
    } catch (err) {
      console.error("RUNNER LOGGER HYDRATE ERROR:", err?.message || err);

      return {
        ok: false,
        profile: SYSTEM_PROFILE,
        error: err?.message || "hydrate_failed",
        total: historyCache.length
      };
    } finally {
      hydratePromise = null;
    }
  })();

  return hydratePromise;
}

function lazyHydrate() {
  if (hydrated || hydratePromise) return;

  hydrateLoggerFromDB().catch(() => {});
}

// ================= NORMALIZERS =================
function normalizeTrade(trade) {
  const now = nowTs();
  const tradeId = getTradeId(trade, "RUNNER_TRADE");
  const side = normalizeSide(trade?.side);
  const pnlPct = calculatePnlPct(trade);
  const realizedR = getRealizedR(trade);
  const result = normalizeResult(trade, pnlPct, realizedR);

  const entry =
    nullableNumber(trade?.entry ?? trade?.entryPrice ?? trade?.openPrice) ?? 0;

  const exit =
    nullableNumber(
      trade?.exit ??
        trade?.exitPrice ??
        trade?.executionPrice ??
        trade?.price
    ) ?? 0;

  const openedAt = normalizeTimestamp(
    trade?.openedAt ??
      trade?.entryTs ??
      trade?.createdAt ??
      trade?.ts,
    now
  );

  const closedAt = normalizeTimestamp(
    trade?.closedAt ??
      trade?.exitAt ??
      trade?.exitTs ??
      trade?.exitedAt ??
      trade?.timestamp,
    now
  );

  const entryType = normalizeEntryType(
    trade?.entryType ||
      trade?.runnerEntryType ||
      trade?.reason ||
      trade?.sniper
  );

  const row = {
    id: makeId("TRADE", trade?.symbol, side),
    tradeId,

    profile: SYSTEM_PROFILE,
    system: SYSTEM_PROFILE,
    scannerProfile: SYSTEM_PROFILE,

    logType: "TRADE",
    event: "EXIT",
    action: "EXIT",
    analyzeLifecycle: "EXIT",

    runnerProfile: normalizeRunnerProfile(trade?.runnerProfile),
    entryType,
    runnerEntryType: entryType,
    tradeFunnelProfile: normalizeTradeFunnelProfile(trade?.tradeFunnelProfile),
    scannerQuality: normalizeScannerQuality(trade?.scannerQuality),

    symbol: safeUpper(trade?.symbol, "UNKNOWN"),
    side,
    analyzerSide: normalizeAnalyzerSide(side),

    setupClass: safeUpper(trade?.setupClass || trade?.grade, "N/A"),
    grade: safeString(trade?.grade, "N/A"),
    gradePoints: safeNumber(trade?.gradePoints),
    recommendedRisk: safeString(trade?.recommendedRisk, "N/A"),

    entry,
    entryPrice: entry,
    openPrice: entry,

    exit,
    exitPrice: exit,
    executionPrice: exit,
    price: safeNumber(trade?.price, exit),

    sl: safeNumber(trade?.sl ?? trade?.stopLoss),
    initialSl: safeNumber(trade?.initialSl ?? trade?.sl ?? trade?.stopLoss),
    tp: safeNumber(trade?.tp ?? trade?.takeProfit),
    partialTp: safeNumber(trade?.partialTp),
    trailPrice: nullableNumber(trade?.trailPrice),

    result,
    closed: true,
    openedAt,
    entryTs: openedAt,
    closedAt,
    exitTs: closedAt,

    pnlPct: Number(pnlPct.toFixed(4)),
    pnlPercent: Number(pnlPct.toFixed(4)),
    realizedR,
    pnlR: realizedR,
    resultR: realizedR,
    outcomeR: realizedR,
    exitR: realizedR,
    rMultiple: realizedR,

    rr: safeNumber(trade?.rr ?? trade?.plannedRR ?? trade?.targetR),
    baseRR: safeNumber(trade?.baseRR ?? trade?.rr),
    plannedRR: safeNumber(trade?.plannedRR ?? trade?.rr),
    targetR: safeNumber(trade?.targetR),

    reason: safeString(trade?.reason || trade?.exitReason || result, result),
    exitReason: safeString(trade?.exitReason || trade?.reason || result, result),

    confluence: safeNumber(trade?.confluence),
    score: safeNumber(trade?.score ?? trade?.moveScore),
    moveScore: safeNumber(trade?.moveScore ?? trade?.score),

    flow: safeString(trade?.flow, "N/A"),
    scannerFlow: safeString(trade?.scannerFlow, "N/A"),
    flowStrength: safeString(trade?.flowStrength, "N/A"),

    sniper: safeString(trade?.sniper, "N/A"),
    sniperScore: safeNumber(trade?.sniperScore),

    runnerPressure: safeNumber(trade?.runnerPressure),
    runnerAcceleration: safeNumber(trade?.runnerAcceleration),
    freshness: safeNumber(trade?.freshness),

    rsi: nullableNumber(trade?.rsi),
    rsiZone: safeString(trade?.rsiZone, "N/A"),
    rsiContinuationScore: safeNumber(trade?.rsiContinuationScore),

    tfScore: safeNumber(trade?.tfScore),
    tfStrength: safeNumber(trade?.tfStrength),
    tfAlignment: safeString(trade?.tfAlignment, "N/A"),

    obBias: safeString(trade?.obBias, "N/A"),
    spreadPct: nullableNumber(trade?.spreadPct),
    spreadBps: nullableNumber(trade?.spreadBps),
    depthMinUsd1p: nullableNumber(trade?.depthMinUsd1p),

    funding: safeNumber(trade?.funding ?? trade?.fundingRate),
    fundingRate: safeNumber(trade?.fundingRate ?? trade?.funding),

    slSource: safeString(trade?.slSource, "N/A"),
    tpSource: safeString(trade?.tpSource, "N/A"),

    regime: safeString(trade?.regime, "N/A"),
    btcState: safeString(trade?.btcState, "N/A"),
    market: compactObject(trade?.market),
    btc: compactObject(trade?.btc),

    currentR: nullableNumber(trade?.currentR),
    mfeR: safeNumber(trade?.mfeR),
    maeR: safeNumber(trade?.maeR),

    partialTaken: Boolean(trade?.partialTaken),
    breakEvenMoved: Boolean(trade?.breakEvenMoved),
    trailingActive: Boolean(trade?.trailingActive),
    adds: safeNumber(trade?.adds),

    strategyVersion: safeString(trade?.strategyVersion, "UNKNOWN"),

    timestamp: closedAt,
    ts: closedAt,
    storedAt: now
  };

  return compactObject(row);
}

function normalizeSystemEvent(event) {
  const now = nowTs();
  const action = safeUpper(event?.action || event?.event, "UNKNOWN");
  const tradeId = getTradeId(event, action === "ENTRY" ? "RUNNER_ENTRY" : "RUNNER_SYSTEM");

  const side = normalizeSide(event?.side);

  const entry =
    nullableNumber(event?.entry ?? event?.entryPrice ?? event?.openPrice) ?? 0;

  const openedAt = normalizeTimestamp(
    event?.openedAt ??
      event?.entryTs ??
      event?.createdAt ??
      event?.ts,
    now
  );

  const entryType = normalizeEntryType(
    event?.entryType ||
      event?.runnerEntryType ||
      event?.reason ||
      event?.sniper
  );

  const row = {
    id: makeId("SYSTEM", event?.symbol, side),
    tradeId,

    profile: SYSTEM_PROFILE,
    system: SYSTEM_PROFILE,
    scannerProfile: SYSTEM_PROFILE,

    logType: "SYSTEM",
    event: action,
    action,
    analyzeLifecycle: action === "ENTRY" ? "ENTRY" : action,

    runnerProfile: normalizeRunnerProfile(event?.runnerProfile),
    entryType,
    runnerEntryType: entryType,
    tradeFunnelProfile: normalizeTradeFunnelProfile(event?.tradeFunnelProfile),
    scannerQuality: normalizeScannerQuality(event?.scannerQuality),

    symbol: safeUpper(event?.symbol, "UNKNOWN"),
    side,
    analyzerSide: normalizeAnalyzerSide(side),

    setupClass: safeUpper(event?.setupClass || event?.grade, "N/A"),
    reason: safeString(event?.reason, "N/A"),
    exitReason: safeString(event?.exitReason, ""),

    stage: safeString(event?.stage || event?.scannerStage, "N/A"),
    scannerStage: safeString(event?.scannerStage || event?.stage, "N/A"),
    stageSource: safeString(event?.stageSource, "N/A"),

    grade: safeString(event?.grade, "N/A"),
    gradePoints: safeNumber(event?.gradePoints),
    recommendedRisk: safeString(event?.recommendedRisk, "N/A"),

    score: safeNumber(event?.score ?? event?.moveScore),
    moveScore: safeNumber(event?.moveScore ?? event?.score),
    confluence: safeNumber(event?.confluence),

    rr: safeNumber(event?.rr ?? event?.plannedRR ?? event?.targetR),
    baseRR: safeNumber(event?.baseRR ?? event?.rr),
    plannedRR: safeNumber(event?.plannedRR ?? event?.rr),
    targetR: safeNumber(event?.targetR),

    price: safeNumber(event?.price),
    entry,
    entryPrice: entry,
    openPrice: entry,

    sl: safeNumber(event?.sl ?? event?.stopLoss),
    initialSl: safeNumber(event?.initialSl ?? event?.sl ?? event?.stopLoss),
    tp: safeNumber(event?.tp ?? event?.takeProfit),
    partialTp: safeNumber(event?.partialTp),
    trailPrice: nullableNumber(event?.trailPrice),

    flow: safeString(event?.flow, "N/A"),
    scannerFlow: safeString(event?.scannerFlow, "N/A"),
    flowStrength: safeString(event?.flowStrength, "N/A"),

    sniper: safeString(event?.sniper, "N/A"),
    sniperScore: safeNumber(event?.sniperScore),

    runnerPressure: safeNumber(event?.runnerPressure),
    runnerAcceleration: safeNumber(event?.runnerAcceleration),
    freshness: safeNumber(event?.freshness),

    rsi: nullableNumber(event?.rsi),
    rsiZone: safeString(event?.rsiZone, "N/A"),
    rsiContinuationScore: safeNumber(event?.rsiContinuationScore),

    tfScore: safeNumber(event?.tfScore),
    tfStrength: safeNumber(event?.tfStrength),
    tfAlignment: safeString(event?.tfAlignment, "N/A"),

    obBias: safeString(event?.obBias, "N/A"),
    spreadPct: nullableNumber(event?.spreadPct),
    spreadBps: nullableNumber(event?.spreadBps),
    depthMinUsd1p: nullableNumber(event?.depthMinUsd1p),

    funding: safeNumber(event?.funding ?? event?.fundingRate),
    fundingRate: safeNumber(event?.fundingRate ?? event?.funding),

    slSource: safeString(event?.slSource, "N/A"),
    tpSource: safeString(event?.tpSource, "N/A"),

    regime: safeString(event?.regime, "N/A"),
    btcState: safeString(event?.btcState, "N/A"),
    market: compactObject(event?.market),
    btc: compactObject(event?.btc),

    currentR: nullableNumber(event?.currentR),
    mfeR: safeNumber(event?.mfeR),
    maeR: safeNumber(event?.maeR),

    partialTaken: Boolean(event?.partialTaken),
    breakEvenMoved: Boolean(event?.breakEvenMoved),
    trailingActive: Boolean(event?.trailingActive),
    adds: safeNumber(event?.adds),

    closed: action === "EXIT",
    openedAt: action === "ENTRY" ? openedAt : event?.openedAt,
    entryTs: action === "ENTRY" ? openedAt : event?.entryTs,

    strategyVersion: safeString(event?.strategyVersion, "UNKNOWN"),

    timestamp: now,
    ts: now,
    storedAt: now
  };

  return compactObject(row);
}

// ================= LOGGERS =================
export function logTrade(trade) {
  const row = normalizeTrade(trade || {});

  pushCache(row);
  persistTrade(row);

  return row;
}

export function logSystemEvent(event) {
  const row = normalizeSystemEvent(event || {});

  pushCache(row);
  persistSystem(row);

  return row;
}

// ================= READERS =================
export function getAllHistory() {
  lazyHydrate();

  return Array.isArray(historyCache)
    ? historyCache
    : [];
}

export function getTradeHistory() {
  const db = getAllHistory();

  return db.filter(row => {
    return row?.logType === "TRADE" || isLegacyTradeRow(row);
  });
}

export function getSystemHistory() {
  const db = getAllHistory();

  return db.filter(row => row?.logType === "SYSTEM");
}

export function getEntryHistory() {
  const db = getAllHistory();

  return db.filter(row => {
    const action = safeUpper(row?.action || row?.event);
    return action === "ENTRY";
  });
}

export function getExitHistory() {
  return getTradeHistory();
}

// ================= TRADE STATS =================
export function getTradeStats() {
  const trades = getTradeHistory();

  const total = trades.length;
  const wins = trades.filter(t => safeUpper(t.result) === "WIN").length;
  const losses = trades.filter(t => safeUpper(t.result) === "LOSS").length;
  const flats = trades.filter(t => safeUpper(t.result) === "FLAT").length;

  const winrate = total > 0
    ? (wins / total) * 100
    : 0;

  const totalPnlPct = trades.reduce((sum, t) => {
    return sum + safeNumber(t.pnlPct);
  }, 0);

  const totalR = trades.reduce((sum, t) => {
    return sum + safeNumber(t.exitR ?? t.realizedR ?? t.pnlR);
  }, 0);

  const avgPnlPct = total > 0
    ? totalPnlPct / total
    : 0;

  const avgR = total > 0
    ? totalR / total
    : 0;

  const avgRR = total > 0
    ? trades.reduce((sum, t) => sum + safeNumber(t.rr), 0) / total
    : 0;

  const avgConfluence = total > 0
    ? trades.reduce((sum, t) => sum + safeNumber(t.confluence), 0) / total
    : 0;

  return {
    profile: SYSTEM_PROFILE,
    total,
    wins,
    losses,
    flats,

    winrate: Number(winrate.toFixed(2)),

    totalR: Number(totalR.toFixed(4)),
    avgR: Number(avgR.toFixed(4)),

    totalPnlPct: Number(totalPnlPct.toFixed(4)),
    avgPnlPct: Number(avgPnlPct.toFixed(4)),

    avgRR: Number(avgRR.toFixed(2)),
    avgConfluence: Number(avgConfluence.toFixed(2)),

    hydrated,
    cacheSize: historyCache.length,
    servedAt: Date.now()
  };
}

// ================= STATS BY FIELD =================
export function getStatsBy(field) {
  const trades = getTradeHistory();
  const groups = {};

  for (const trade of trades) {
    const key = safeString(trade?.[field], "UNKNOWN") || "UNKNOWN";

    if (!groups[key]) {
      groups[key] = {
        key,
        total: 0,
        wins: 0,
        losses: 0,
        flats: 0,
        totalPnlPct: 0,
        totalR: 0,
        totalRR: 0,
        totalConfluence: 0
      };
    }

    groups[key].total++;

    const result = safeUpper(trade.result);

    if (result === "WIN") groups[key].wins++;
    if (result === "LOSS") groups[key].losses++;
    if (result === "FLAT") groups[key].flats++;

    groups[key].totalPnlPct += safeNumber(trade.pnlPct);
    groups[key].totalR += safeNumber(trade.exitR ?? trade.realizedR ?? trade.pnlR);
    groups[key].totalRR += safeNumber(trade.rr);
    groups[key].totalConfluence += safeNumber(trade.confluence);
  }

  return Object.values(groups)
    .map(g => ({
      ...g,
      winrate: g.total > 0
        ? Number(((g.wins / g.total) * 100).toFixed(2))
        : 0,

      avgPnlPct: g.total > 0
        ? Number((g.totalPnlPct / g.total).toFixed(4))
        : 0,

      avgR: g.total > 0
        ? Number((g.totalR / g.total).toFixed(4))
        : 0,

      avgRR: g.total > 0
        ? Number((g.totalRR / g.total).toFixed(2))
        : 0,

      avgConfluence: g.total > 0
        ? Number((g.totalConfluence / g.total).toFixed(2))
        : 0,

      totalPnlPct: Number(g.totalPnlPct.toFixed(4)),
      totalR: Number(g.totalR.toFixed(4))
    }))
    .sort((a, b) => {
      const totalDiff = b.total - a.total;
      if (totalDiff !== 0) return totalDiff;

      return b.totalR - a.totalR;
    });
}

// ================= SYSTEM STATS =================
export function getSystemStats() {
  const rows = getSystemHistory();
  const total = rows.length;

  const byActionMap = {};
  const byReasonMap = {};
  const byEntryTypeMap = {};
  const bySideMap = {};
  const byFlowMap = {};

  for (const row of rows) {
    const actionKey = safeString(row.action || row.event, "UNKNOWN");
    const reasonKey = safeString(row.reason, "N/A");
    const entryTypeKey = safeString(row.entryType, "UNKNOWN");
    const sideKey = safeString(row.side, "unknown");
    const flowKey = safeString(row.flow, "N/A");

    byActionMap[actionKey] = (byActionMap[actionKey] || 0) + 1;
    byReasonMap[reasonKey] = (byReasonMap[reasonKey] || 0) + 1;
    byEntryTypeMap[entryTypeKey] = (byEntryTypeMap[entryTypeKey] || 0) + 1;
    bySideMap[sideKey] = (bySideMap[sideKey] || 0) + 1;
    byFlowMap[flowKey] = (byFlowMap[flowKey] || 0) + 1;
  }

  const toRows = map => {
    return Object.entries(map)
      .map(([key, count]) => ({
        key,
        count,
        pct: total > 0 ? Number(((count / total) * 100).toFixed(2)) : 0
      }))
      .sort((a, b) => b.count - a.count);
  };

  return {
    profile: SYSTEM_PROFILE,
    total,

    byAction: toRows(byActionMap),
    byReason: toRows(byReasonMap),
    byEntryType: toRows(byEntryTypeMap),
    bySide: toRows(bySideMap),
    byFlow: toRows(byFlowMap),

    hydrated,
    cacheSize: historyCache.length,
    servedAt: Date.now()
  };
}

// ================= CLEAR =================
export function clearTradeLog() {
  historyCache = [];
  hydrated = true;

  clearAllLogs().catch(err => {
    console.error("RUNNER CLEAR LOG ERROR:", err?.message || err);
  });

  return {
    ok: true,
    profile: SYSTEM_PROFILE,
    clearedAt: nowTs()
  };
}

export default {
  logTrade,
  logSystemEvent,

  hydrateLoggerFromDB,

  getAllHistory,
  getTradeHistory,
  getSystemHistory,
  getEntryHistory,
  getExitHistory,

  getTradeStats,
  getStatsBy,
  getSystemStats,

  clearTradeLog
};