const STARTED_AT = Date.now();
const SYSTEM_PROFILE = "RUNNER";

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  return res.status(200).json({
    ok: true,
    system: SYSTEM_PROFILE,
    scannerProfile: SYSTEM_PROFILE,
    status: "ACTIVE",
    mode: "MOMENTUM_RUNNER",
    modules: {
      scanner: "RUNNER_SCANNER",
      tradeFunnel: "RUNNER_TRADE_FUNNEL",
      executionStyle: "BREAKOUT_CONTINUATION_SQUEEZE"
    },
    startedAt: STARTED_AT,
    uptimeMs: Date.now() - STARTED_AT,
    timestamp: Date.now()
  });
}