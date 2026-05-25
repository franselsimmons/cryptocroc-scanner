import { getPerformance } from "../lib/performance.js";

const SYSTEM_PROFILE = "RUNNER";

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  try {
    const performance = getPerformance();

    return res.status(200).json({
      ok: true,
      profile: SYSTEM_PROFILE,
      system: SYSTEM_PROFILE,
      mode: "MOMENTUM_RUNNER",

      performance,

      summary: {
        total: performance.total || 0,
        wins: performance.wins || 0,
        losses: performance.losses || 0,
        flats: performance.flats || 0,
        winrate: performance.winrate || 0,
        totalPnlPct: performance.totalPnlPct || 0,
        avgPnlPct: performance.avgPnlPct || 0,
        avgRR: performance.avgRR || 0,
        avgConfluence: performance.avgConfluence || 0
      },

      servedAt: Date.now()
    });
  } catch (err) {
    console.error("RUNNER PERFORMANCE ERROR:", err);

    return res.status(500).json({
      ok: false,
      profile: SYSTEM_PROFILE,
      system: SYSTEM_PROFILE,
      error: err?.message || "runner_performance_failed",
      servedAt: Date.now()
    });
  }
}