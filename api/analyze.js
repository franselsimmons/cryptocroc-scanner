const STARTED_AT = Date.now();

const SYSTEM_PROFILE = "RUNNER";
const SYSTEM_MODE = "MOMENTUM_RUNNER";
const STRATEGY_FAMILY = "BREAKOUT_CONTINUATION_SQUEEZE";

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  return res.status(200).json({
    ok: true,

    system: SYSTEM_PROFILE,
    profile: SYSTEM_PROFILE,
    scannerProfile: SYSTEM_PROFILE,
    tradeSystemProfile: SYSTEM_PROFILE,

    status: "ACTIVE",
    mode: SYSTEM_MODE,
    strategyFamily: STRATEGY_FAMILY,

    modules: {
      scanner: "RUNNER_SCANNER",
      tradeFunnel: "RUNNER_TRADE_FUNNEL",
      tradeSystem: "RUNNER_TRADE_SYSTEM",
      analyzer: "RUNNER_ANALYZER",
      performance: "RUNNER_PERFORMANCE",
      executionStyle: STRATEGY_FAMILY
    },

    routes: {
      status: "/api/analyze",
      performance: "/api/performance",
      tradeStats: "/api/trade-stats",
      tradeHistory: "/api/trade-history",
      publicLatest: "/api/public-latest"
    },

    compatibility: {
      keepsExistingApiShape: true,
      dashboardSafe: true,
      runnerOnly: true
    },

    startedAt: STARTED_AT,
    uptimeMs: Date.now() - STARTED_AT,
    timestamp: Date.now(),
    servedAt: Date.now()
  });
}