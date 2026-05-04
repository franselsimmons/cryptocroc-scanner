import { getTradeHistory } from "./logger.js";

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeString(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

export function getPerformance() {
  const trades = getTradeHistory();

  if (!trades.length) {
    return {
      profile: "RUNNER",
      winrate: 0,
      avgRR: 0,
      avgConfluence: 0,
      total: 0,
      wins: 0,
      losses: 0,
      flats: 0,
      totalPnlPct: 0,
      avgPnlPct: 0
    };
  }

  let wins = 0;
  let losses = 0;
  let flats = 0;
  let rrTotal = 0;
  let confluenceTotal = 0;
  let pnlTotal = 0;

  for (const t of trades) {
    const result = safeString(t.result).toUpperCase();

    if (result === "WIN") wins++;
    else if (result === "LOSS") losses++;
    else flats++;

    rrTotal += safeNumber(t.rr);
    confluenceTotal += safeNumber(t.confluence);
    pnlTotal += safeNumber(t.pnlPct);
  }

  const total = trades.length;

  return {
    profile: "RUNNER",
    winrate: Number(((wins / total) * 100).toFixed(2)),
    avgRR: Number((rrTotal / total).toFixed(2)),
    avgConfluence: Number((confluenceTotal / total).toFixed(2)),
    total,
    wins,
    losses,
    flats,
    totalPnlPct: Number(pnlTotal.toFixed(4)),
    avgPnlPct: Number((pnlTotal / total).toFixed(4))
  };
}