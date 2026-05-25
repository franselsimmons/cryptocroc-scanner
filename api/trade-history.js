import {
  getTradeHistory,
  getSystemHistory,
  hydrateLoggerFromDB
} from "../lib/logger.js";

const SYSTEM_PROFILE = "RUNNER";

function safeLimit(value, fallback = 500) {
  const n = Number(value);

  if (!Number.isFinite(n)) return fallback;

  return Math.max(1, Math.min(Math.round(n), 2000));
}

function normalizeType(value) {
  const v = String(value || "trades").toLowerCase().trim();

  if (v === "system") return "system";
  if (v === "all") return "all";

  return "trades";
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  try {
    const limit = safeLimit(req?.query?.limit, 500);
    const type = normalizeType(req?.query?.type);

    // Belangrijk op Vercel cold starts:
    // eerst DB/KV hydraten, daarna pas history lezen.
    await hydrateLoggerFromDB();

    const trades = getTradeHistory();
    const systemEvents = getSystemHistory();

    let rows = trades;

    if (type === "system") {
      rows = systemEvents;
    }

    if (type === "all") {
      rows = [...trades, ...systemEvents].sort((a, b) => {
        return Number(a?.timestamp || 0) - Number(b?.timestamp || 0);
      });
    }

    return res.status(200).json({
      ok: true,
      profile: SYSTEM_PROFILE,
      system: SYSTEM_PROFILE,
      mode: "MOMENTUM_RUNNER",

      type,
      total: rows.length,
      tradeTotal: trades.length,
      systemTotal: systemEvents.length,
      limit,

      trades: rows
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
      system: SYSTEM_PROFILE,
      error: err?.message || "runner_trade_history_failed",
      servedAt: Date.now()
    });
  }
}