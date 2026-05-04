import {
  getTradeStats,
  getStatsBy
} from "../lib/logger.js";

const SYSTEM_PROFILE = "RUNNER";

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store, max-age=0");

    return res.status(200).json({
      ok: true,
      profile: SYSTEM_PROFILE,

      overall: getTradeStats(),

      byGrade: getStatsBy("grade"),
      bySide: getStatsBy("side"),

      // Oude key blijft bewust staan voor dashboard-compatibility.
      bySniper: getStatsBy("sniper"),

      // Runner keys.
      byEntryType: getStatsBy("entryType"),
      byRunnerProfile: getStatsBy("runnerProfile"),
      byTradeFunnelProfile: getStatsBy("tradeFunnelProfile"),
      byScannerQuality: getStatsBy("scannerQuality"),

      byFlow: getStatsBy("flow"),
      byObBias: getStatsBy("obBias"),
      byRegime: getStatsBy("regime"),
      byBtcState: getStatsBy("btcState"),

      servedAt: Date.now()
    });
  } catch (err) {
    console.error("RUNNER TRADE STATS ERROR:", err);

    return res.status(500).json({
      ok: false,
      profile: SYSTEM_PROFILE,
      error: err?.message || "runner_trade_stats_failed"
    });
  }
}