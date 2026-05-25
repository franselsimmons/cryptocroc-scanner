import {
  getTradeStats,
  getStatsBy,
  getSystemStats
} from "../lib/logger.js";

const SYSTEM_PROFILE = "RUNNER";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  try {
    const overall = getTradeStats();
    const systemStats = getSystemStats();

    return res.status(200).json({
      ok: true,
      profile: SYSTEM_PROFILE,
      system: SYSTEM_PROFILE,
      mode: "MOMENTUM_RUNNER",

      overall,

      byGrade: getStatsBy("grade"),
      bySide: getStatsBy("side"),

      // Oude key blijft bewust staan voor dashboard-compatibility.
      bySniper: getStatsBy("sniper"),

      // Runner keys.
      byEntryType: getStatsBy("entryType"),
      byRunnerProfile: getStatsBy("runnerProfile"),
      byTradeFunnelProfile: getStatsBy("tradeFunnelProfile"),
      byScannerQuality: getStatsBy("scannerQuality"),
      bySetupClass: getStatsBy("setupClass"),

      byFlow: getStatsBy("flow"),
      byObBias: getStatsBy("obBias"),
      byRegime: getStatsBy("regime"),
      byBtcState: getStatsBy("btcState"),

      systemStats,

      summary: {
        trades: overall.total || 0,
        wins: overall.wins || 0,
        losses: overall.losses || 0,
        flats: overall.flats || 0,
        winrate: overall.winrate || 0,
        totalPnlPct: overall.totalPnlPct || 0,
        avgPnlPct: overall.avgPnlPct || 0,
        avgRR: overall.avgRR || 0,
        avgConfluence: overall.avgConfluence || 0,
        systemEvents: systemStats.total || 0
      },

      servedAt: Date.now()
    });
  } catch (err) {
    console.error("RUNNER TRADE STATS ERROR:", err);

    return res.status(500).json({
      ok: false,
      profile: SYSTEM_PROFILE,
      system: SYSTEM_PROFILE,
      error: err?.message || "runner_trade_stats_failed",
      servedAt: Date.now()
    });
  }
}