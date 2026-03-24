// api/updatePerformance.js
import { kv } from "@vercel/kv";

import {
  RUNTIME_CONFIG,
  requireSecret,
  keyMainPositions,
  keyMoonPositions,
} from "../lib/_moon_core.js";

export const config = RUNTIME_CONFIG;

const KEEP_CLOSED_TRADES = 1500; // safety: avoid huge loops
const EXPIRE_SEC = 60 * 60 * 24 * 7;

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function computePerformance(closedTradesRaw) {
  const tradesArr = Array.isArray(closedTradesRaw) ? closedTradesRaw : [];
  const closed = tradesArr.slice(-KEEP_CLOSED_TRADES);

  if (!closed.length) {
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

  for (const t of closed) {
    const pnlPct = n(t?.pnlPct, 0);
    const rr = n(t?.rr, 0);

    if (pnlPct > 0) wins += 1;
    totalRR += rr;

    equity = equity * (1 + pnlPct / 100);
    peakEquity = Math.max(peakEquity, equity);

    const ddPct = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
    if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
  }

  const trades = closed.length;
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

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");

    const modes = ["bull", "bear"];

    // read positions in parallel (main+moon for each mode)
    const reads = [];
    for (const mode of modes) {
      reads.push(kv.get(keyMainPositions(mode)));
      reads.push(kv.get(keyMoonPositions(mode)));
    }
    const results = await Promise.all(reads);

    const out = {
      main: { bull: null, bear: null },
      moon: { bull: null, bear: null },
    };

    // write perf in parallel too
    const writes = [];

    for (let i = 0; i < modes.length; i++) {
      const mode = modes[i];

      const mainPositions = results[i * 2] || { open: [], closed: [] };
      const moonPositions = results[i * 2 + 1] || { open: [], closed: [] };

      const mainPerf = computePerformance(mainPositions.closed);
      const moonPerf = computePerformance(moonPositions.closed);

      out.main[mode] = mainPerf;
      out.moon[mode] = moonPerf;

      writes.push(kv.set(`main:performance:${mode}`, mainPerf, { ex: EXPIRE_SEC }));
      writes.push(kv.set(`moon:performance:${mode}`, moonPerf, { ex: EXPIRE_SEC }));
    }

    await Promise.all(writes);

    return res.status(200).json({
      ok: true,
      message: "Performance updated",
      keepClosedTrades: KEEP_CLOSED_TRADES,
      performance: out,
      updatedAt: Date.now(),
    });
  } catch (err) {
    console.error("Performance update error:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}