import { getTradeHistory } from "../lib/logger.js";

const SYSTEM_PROFILE = "RUNNER";

function safeLimit(value, fallback = 500) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(Math.round(n), 2000));
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store, max-age=0");

    const limit = safeLimit(req?.query?.limit, 500);
    const trades = getTradeHistory();

    return res.status(200).json({
      ok: true,
      profile: SYSTEM_PROFILE,
      total: trades.length,
      limit,
      trades: trades
        .slice()
        .reverse()
        .slice(0, limit),
      servedAt: Date.now()
    });
  } catch (err) {
    console.error("RUNNER TRADE HISTORY ERROR:", err);

    return res.status(500).json({
      ok: false,
      profile: SYSTEM_PROFILE,
      error: err?.message || "runner_trade_history_failed"
    });
  }
}