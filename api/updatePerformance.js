// api/updatePerformance.js
import { kv } from "@vercel/kv";

import {
  RUNTIME_CONFIG,
  requireSecret,
  keyMainPositions,
  keyMoonPositions,
} from "../lib/_moon_core.js";

export const config = RUNTIME_CONFIG;

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const modes = ["bull", "bear"];

    for (const mode of modes) {
      const mainPositions = (await kv.get(keyMainPositions(mode))) || { open: [], closed: [] };
      const mainStats = computePerformance(mainPositions.closed);
      await kv.set(`main:performance:${mode}`, mainStats, { ex: 60 * 60 * 24 * 7 });

      const moonPositions = (await kv.get(keyMoonPositions(mode))) || { open: [], closed: [] };
      const moonStats = computePerformance(moonPositions.closed);
      await kv.set(`moon:performance:${mode}`, moonStats, { ex: 60 * 60 * 24 * 7 });
    }

    return res.status(200).json({ ok: true, message: "Performance updated" });
  } catch (err) {
    console.error("Performance update error:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function computePerformance(closedTrades) {
  const tradesArr = Array.isArray(closedTrades) ? closedTrades : [];

  if (!tradesArr.length) {
    return {
      trades: 0,
      wins: 0,
      losses: 0,
      winRate: 50,
      avgRR: 0,
      drawdown: 0,
      updatedAt: Date.now(),
    };
  }

  let wins = 0;
  let totalRR = 0;

  let equity = 1000;
  let peakEquity = equity;
  let maxDrawdownPct = 0;

  for (const t of tradesArr) {
    const pnlPct = n(t?.pnlPct, 0);
    const rr = n(t?.rr, 0);

    if (pnlPct > 0) wins += 1;
    totalRR += rr;

    equity = equity * (1 + pnlPct / 100);
    peakEquity = Math.max(peakEquity, equity);

    const ddPct = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
    maxDrawdownPct = Math.max(maxDrawdownPct, ddPct);
  }

  const trades = tradesArr.length;
  const winRate = trades ? (wins / trades) * 100 : 50;
  const avgRR = trades ? totalRR / trades : 0;

  return {
    trades,
    wins,
    losses: trades - wins,
    winRate: Number(winRate.toFixed(1)),
    avgRR: Number(avgRR.toFixed(2)),
    drawdown: Number(maxDrawdownPct.toFixed(1)),
    updatedAt: Date.now(),
  };
}