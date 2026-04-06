// api/analytics/summary.js
import { getDailySummary, getGlobalSummary, getRecentClosedTrades } from "../../lib/tradeAnalytics.js";

export default async function handler(req, res) {
  try {
    const day = String(req.query?.day || "");
    const mode = String(req.query?.mode || "global").toLowerCase();
    const limit = Math.max(1, Math.min(500, Number(req.query?.limit || 50)));

    if (mode === "daily") {
      const summary = await getDailySummary(day || undefined);
      return res.status(200).json({ ok: true, type: "daily", summary });
    }

    if (mode === "recent") {
      const trades = await getRecentClosedTrades(limit);
      return res.status(200).json({ ok: true, type: "recent", count: trades.length, trades });
    }

    const daysBack = Math.max(1, Math.min(90, Number(req.query?.daysBack || 14)));
    const summary = await getGlobalSummary(daysBack);
    return res.status(200).json({ ok: true, type: "global", summary });
  } catch (err) {
    console.error("analytics summary error:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message || String(err),
    });
  }
}