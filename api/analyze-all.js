import { kv } from "@vercel/kv";
import {
  keyMainLatest,
  keyMoonLatest,
  keyTradeLatest,
} from "../../lib/keys.js";

// ===============================
// Helpers
// ===============================
function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

// ===============================
// SCORE ENGINE (LERAAR)
// ===============================
function scoreFilter(fails, total) {
  if (!total) return 10;

  const r = fails / total;

  if (r > 0.9) return 1;
  if (r > 0.75) return 2;
  if (r > 0.6) return 3;
  if (r > 0.5) return 4;
  if (r > 0.4) return 5;
  if (r > 0.3) return 6;
  if (r > 0.2) return 7;
  if (r > 0.1) return 8;

  return 9;
}

function advice(key) {
  const map = {
    btc: "Versoepel BTC alignment (te streng)",
    breakout: "Verlaag breakout threshold",
    persistence: "Verlaag persistence 5-10%",
    entry: "Verlaag entryQuality licht",
    liquidity: "Verlaag depth/spread eisen",
  };
  return map[key] || "Optimaliseer filter";
}

// ===============================
// FUNNEL ANALYSE
// ===============================
function analyze(coins = []) {
  const total = coins.length || 1;

  const fails = {
    btc: coins.filter(c => n(c.btcAlignmentScore) < 50).length,
    breakout: coins.filter(c => !c.breakout?.ready).length,
    persistence: coins.filter(c => n(c.persistenceScore) < 55).length,
    entry: coins.filter(c => n(c.entryQuality) < 60).length,
    liquidity: coins.filter(c => !c.thresholds?.depthOk).length,
  };

  return Object.entries(fails).map(([k, v]) => ({
    filter: k,
    score: scoreFilter(v, total),
    fails: v,
    total,
    advice: advice(k),
  }));
}

// ===============================
// HANDLER
// ===============================
export default async function handler(req, res) {
  try {
    // 🔥 DATA (HIER ZAT JE BUG)
    const [mainBull, moonBull, trade] = await Promise.all([
      kv.get(keyMainLatest("bull")),
      kv.get(keyMoonLatest("bull")), // ✅ FIX → MOON WERKT
      kv.get(keyTradeLatest()),
    ]);

    // ===============================
    // COINS
    // ===============================
    const mainCoins = [
      ...(mainBull?.funnel?.radar || []),
      ...(mainBull?.funnel?.buildup || []),
      ...(mainBull?.funnel?.almost || []),
    ];

    const moonCoins = [
      ...(moonBull?.funnel?.radar || []),
      ...(moonBull?.funnel?.buildup || []),
      ...(moonBull?.funnel?.almost || []),
    ];

    const trades = trade?.trades || [];

    // ===============================
    // ANALYSE
    // ===============================
    const mainAnalysis = analyze(mainCoins);
    const moonAnalysis = analyze(moonCoins);
    const tradeAnalysis = analyze(trades);

    // ===============================
    // RESPONSE
    // ===============================
    return res.status(200).json({
      ok: true,
      ts: Date.now(),

      summary: {
        main: mainCoins.length,
        moon: moonCoins.length,
        trades: trades.length,
      },

      funnels: {
        main: mainAnalysis,
        moon: moonAnalysis,
        trade: tradeAnalysis,
      },
    });

  } catch (err) {
    console.error("ANALYZE-ALL ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
}