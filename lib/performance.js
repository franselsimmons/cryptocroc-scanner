import {
  getTradeHistory,
  getSystemHistory,
  getStatsBy
} from "./logger.js";

const SYSTEM_PROFILE = "RUNNER";

// ================= HELPERS =================
function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeString(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function safeUpper(value, fallback = "") {
  return safeString(value, fallback).toUpperCase().trim();
}

function round(value, decimals = 4) {
  const n = safeNumber(value, 0);
  const factor = 10 ** decimals;

  return Math.round(n * factor) / factor;
}

function pct(part, total, decimals = 2) {
  if (!total) return 0;

  return round((safeNumber(part) / safeNumber(total)) * 100, decimals);
}

function avg(values, decimals = 4) {
  const arr = Array.isArray(values)
    ? values.map(Number).filter(Number.isFinite)
    : [];

  if (!arr.length) return 0;

  const sum = arr.reduce((a, b) => a + b, 0);
  return round(sum / arr.length, decimals);
}

function sum(values, decimals = 4) {
  const arr = Array.isArray(values)
    ? values.map(Number).filter(Number.isFinite)
    : [];

  return round(arr.reduce((a, b) => a + b, 0), decimals);
}

function getResult(row) {
  const r = safeUpper(row?.result);

  if (r === "WIN") return "WIN";
  if (r === "LOSS") return "LOSS";
  if (r === "FLAT" || r === "BE" || r === "BREAKEVEN") return "FLAT";

  const pnlPct = safeNumber(row?.pnlPct, 0);
  const exitR = safeNumber(row?.exitR ?? row?.realizedR ?? row?.pnlR, 0);

  if (exitR > 0 || pnlPct > 0) return "WIN";
  if (exitR < 0 || pnlPct < 0) return "LOSS";

  return "FLAT";
}

function getExitR(row) {
  return safeNumber(
    row?.exitR ??
      row?.realizedR ??
      row?.pnlR ??
      row?.resultR ??
      row?.outcomeR ??
      row?.rMultiple,
    0
  );
}

function getClosedTrades() {
  return getTradeHistory().filter(row => {
    if (!row) return false;

    if (row.logType === "TRADE") return true;

    return (
      row.symbol !== undefined &&
      row.side !== undefined &&
      row.entry !== undefined &&
      row.exit !== undefined
    );
  });
}

function getEntryRows() {
  return getSystemHistory().filter(row => {
    return safeUpper(row?.action || row?.event) === "ENTRY";
  });
}

function getOpenLikeRows() {
  return getSystemHistory().filter(row => {
    const action = safeUpper(row?.action || row?.event);

    return (
      action === "ENTRY" ||
      action === "HOLD" ||
      action === "PARTIAL_TP" ||
      action === "MOVE_BE" ||
      action === "TRAIL" ||
      action === "ADD"
    );
  });
}

function getActionCounts(systemRows) {
  const out = {};

  for (const row of systemRows) {
    const key = safeUpper(row?.action || row?.event, "UNKNOWN");
    out[key] = safeNumber(out[key], 0) + 1;
  }

  return out;
}

function getReasonCounts(systemRows) {
  const out = {};

  for (const row of systemRows) {
    const key = safeUpper(row?.reason, "UNKNOWN");
    out[key] = safeNumber(out[key], 0) + 1;
  }

  return out;
}

function getTopRows(counter, limit = 12) {
  return Object.entries(counter || {})
    .map(([key, count]) => ({
      key,
      count: safeNumber(count)
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function buildSideBreakdown() {
  return getStatsBy("side").map(row => ({
    side: row.key,
    total: row.total,
    wins: row.wins,
    losses: row.losses,
    flats: row.flats,
    winrate: row.winrate,
    totalR: row.totalR,
    avgR: row.avgR,
    totalPnlPct: row.totalPnlPct,
    avgPnlPct: row.avgPnlPct,
    avgRR: row.avgRR,
    avgConfluence: row.avgConfluence
  }));
}

function buildEntryTypeBreakdown() {
  return getStatsBy("entryType").map(row => ({
    entryType: row.key,
    total: row.total,
    wins: row.wins,
    losses: row.losses,
    flats: row.flats,
    winrate: row.winrate,
    totalR: row.totalR,
    avgR: row.avgR,
    totalPnlPct: row.totalPnlPct,
    avgPnlPct: row.avgPnlPct,
    avgRR: row.avgRR,
    avgConfluence: row.avgConfluence
  }));
}

function buildFlowBreakdown() {
  return getStatsBy("flow").map(row => ({
    flow: row.key,
    total: row.total,
    wins: row.wins,
    losses: row.losses,
    flats: row.flats,
    winrate: row.winrate,
    totalR: row.totalR,
    avgR: row.avgR,
    totalPnlPct: row.totalPnlPct,
    avgPnlPct: row.avgPnlPct,
    avgRR: row.avgRR,
    avgConfluence: row.avgConfluence
  }));
}

function buildObBreakdown() {
  return getStatsBy("obBias").map(row => ({
    obBias: row.key,
    total: row.total,
    wins: row.wins,
    losses: row.losses,
    flats: row.flats,
    winrate: row.winrate,
    totalR: row.totalR,
    avgR: row.avgR,
    totalPnlPct: row.totalPnlPct,
    avgPnlPct: row.avgPnlPct
  }));
}

function buildRunnerQualitySummary(trades) {
  const closed = Array.isArray(trades) ? trades : [];

  const aLike = closed.filter(row => {
    const setup = safeUpper(row?.setupClass);
    const entryType = safeUpper(row?.entryType || row?.runnerEntryType);

    return (
      setup === "RUNNER_A" ||
      setup === "RUNNER_C" ||
      entryType.includes("RUNNER_A") ||
      entryType.includes("RUNNER_C")
    );
  });

  const bLike = closed.filter(row => {
    const setup = safeUpper(row?.setupClass);
    const entryType = safeUpper(row?.entryType || row?.runnerEntryType);

    return setup === "RUNNER_B" || entryType.includes("RUNNER_B");
  });

  const summarize = rows => {
    const total = rows.length;
    const wins = rows.filter(row => getResult(row) === "WIN").length;
    const losses = rows.filter(row => getResult(row) === "LOSS").length;
    const flats = rows.filter(row => getResult(row) === "FLAT").length;

    const totalR = sum(rows.map(getExitR), 4);
    const totalPnlPct = sum(rows.map(row => safeNumber(row?.pnlPct)), 4);

    return {
      total,
      wins,
      losses,
      flats,
      winrate: pct(wins, total),
      totalR,
      avgR: total ? round(totalR / total, 4) : 0,
      totalPnlPct,
      avgPnlPct: total ? round(totalPnlPct / total, 4) : 0,
      avgRR: avg(rows.map(row => safeNumber(row?.rr)), 2),
      avgConfluence: avg(rows.map(row => safeNumber(row?.confluence)), 2)
    };
  };

  return {
    runnerA: summarize(aLike),
    runnerB: summarize(bLike)
  };
}

// ================= MAIN PERFORMANCE =================
export function getPerformance() {
  const trades = getClosedTrades();
  const systemRows = getSystemHistory();
  const entryRows = getEntryRows();
  const openLikeRows = getOpenLikeRows();

  const actionCounts = getActionCounts(systemRows);
  const reasonCounts = getReasonCounts(systemRows);

  if (!trades.length) {
    return {
      profile: SYSTEM_PROFILE,

      winrate: 0,
      avgRR: 0,
      avgConfluence: 0,

      total: 0,
      wins: 0,
      losses: 0,
      flats: 0,

      totalR: 0,
      avgR: 0,

      totalPnlPct: 0,
      avgPnlPct: 0,

      entriesLogged: entryRows.length,
      systemRows: systemRows.length,
      openLikeRows: openLikeRows.length,

      actionCounts,
      rejectReasons: getTopRows(reasonCounts),

      bySide: [],
      byEntryType: [],
      byFlow: [],
      byObBias: [],

      runnerQuality: {
        runnerA: {
          total: 0,
          wins: 0,
          losses: 0,
          flats: 0,
          winrate: 0,
          totalR: 0,
          avgR: 0,
          totalPnlPct: 0,
          avgPnlPct: 0,
          avgRR: 0,
          avgConfluence: 0
        },
        runnerB: {
          total: 0,
          wins: 0,
          losses: 0,
          flats: 0,
          winrate: 0,
          totalR: 0,
          avgR: 0,
          totalPnlPct: 0,
          avgPnlPct: 0,
          avgRR: 0,
          avgConfluence: 0
        }
      },

      dataState: "NO_CLOSED_TRADES",
      servedAt: Date.now()
    };
  }

  let wins = 0;
  let losses = 0;
  let flats = 0;

  const rrValues = [];
  const confluenceValues = [];
  const pnlValues = [];
  const rValues = [];
  const mfeValues = [];
  const maeValues = [];
  const sniperValues = [];
  const pressureValues = [];
  const accelerationValues = [];

  for (const trade of trades) {
    const result = getResult(trade);

    if (result === "WIN") wins++;
    else if (result === "LOSS") losses++;
    else flats++;

    rrValues.push(safeNumber(trade?.rr));
    confluenceValues.push(safeNumber(trade?.confluence));
    pnlValues.push(safeNumber(trade?.pnlPct));
    rValues.push(getExitR(trade));

    mfeValues.push(safeNumber(trade?.mfeR));
    maeValues.push(safeNumber(trade?.maeR));
    sniperValues.push(safeNumber(trade?.sniperScore));
    pressureValues.push(safeNumber(trade?.runnerPressure));
    accelerationValues.push(safeNumber(trade?.runnerAcceleration));
  }

  const total = trades.length;
  const totalR = sum(rValues, 4);
  const totalPnlPct = sum(pnlValues, 4);

  const performance = {
    profile: SYSTEM_PROFILE,

    winrate: pct(wins, total),
    avgRR: avg(rrValues, 2),
    avgConfluence: avg(confluenceValues, 2),

    total,
    wins,
    losses,
    flats,

    totalR,
    avgR: total ? round(totalR / total, 4) : 0,

    totalPnlPct,
    avgPnlPct: total ? round(totalPnlPct / total, 4) : 0,

    avgMfeR: avg(mfeValues, 4),
    avgMaeR: avg(maeValues, 4),
    avgSniperScore: avg(sniperValues, 2),
    avgRunnerPressure: avg(pressureValues, 4),
    avgRunnerAcceleration: avg(accelerationValues, 4),

    entriesLogged: entryRows.length,
    systemRows: systemRows.length,
    openLikeRows: openLikeRows.length,

    actionCounts,
    rejectReasons: getTopRows(reasonCounts),

    bySide: buildSideBreakdown(),
    byEntryType: buildEntryTypeBreakdown(),
    byFlow: buildFlowBreakdown(),
    byObBias: buildObBreakdown(),

    runnerQuality: buildRunnerQualitySummary(trades),

    dataState: total >= 100
      ? "HIGH_SAMPLE"
      : total >= 40
        ? "MEDIUM_SAMPLE"
        : total >= 10
          ? "LOW_SAMPLE"
          : "VERY_LOW_SAMPLE",

    servedAt: Date.now()
  };

  return performance;
}

export default {
  getPerformance
};