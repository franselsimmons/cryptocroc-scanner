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
// SCORING (LERAAR SYSTEEM)
// ===============================
function scoreFilter(fails, total) {
  if (total === 0) return 10;

  const ratio = fails / total;

  if (ratio > 0.9) return 1;
  if (ratio > 0.75) return 2;
  if (ratio > 0.6) return 3;
  if (ratio > 0.5) return 4;
  if (ratio > 0.4) return 5;
  if (ratio > 0.3) return 6;
  if (ratio > 0.2) return 7;
  if (ratio > 0.1) return 8;

  return 9;
}

function adviceMap(key) {
  const map = {
    btc: "Versoepel BTC confirmatie (te streng → weinig trades)",
    breakout: "Verlaag breakout threshold (te weinig triggers)",
    persistence: "Verlaag persistence 5–10% (te streng)",
    entry: "Verlaag entryQuality licht",
    liquidity: "Verlaag depth/spread eisen",
  };
  return map[key] || "Optimaliseer filter";
}

// ===============================
// GENERIC FUNNEL ANALYZER
// ===============================
function analyzeFunnel(coins = []) {
  const total = coins.length || 1;

  const fails = {
    btc: coins.filter(c => n(c.btcAlignmentScore) < 50).length,
    breakout: coins.filter(c => !c.breakout?.ready).length,
    persistence: coins.filter(c => n(c.persistenceScore) < 55).length,
    entry: coins.filter(c => n(c.entryQuality) < 60).length,
    liquidity: coins.filter(c => !c.thresholds?.depthOk).length,
  };

  return Object.entries(fails).map(([key, value]) => ({
    filter: key,
    score: scoreFilter(value, total),
    fails: value,
    total,
    advice: adviceMap(key),
  }));
}

// ===============================
// MAIN HANDLER
// ===============================
export default async function handler(req, res) {
  try {
    // ===============================
    // DATA OPHALEN (BELANGRIJK FIX)
    // ===============================
    const [mainBull, moonBull, trade] = await Promise.all([
      kv.get(keyMainLatest("bull")),
      kv.get(keyMoonLatest("bull")), // ✅ FIX → Moon werkt nu
      kv.get(keyTradeLatest()),
    ]);

    // ===============================
    // COINS UIT FUNNELS HALEN
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

    const tradeCoins = trade?.trades || [];

    // ===============================
    // ANALYSE
    // ===============================
    const mainAnalysis = analyzeFunnel(mainCoins);
    const moonAnalysis = analyzeFunnel(moonCoins);
    const tradeAnalysis = analyzeFunnel(tradeCoins);

    // ===============================
    // RESPONSE
    // ===============================
    return res.status(200).json({
      ok: true,
      ts: Date.now(),

      summary: {
        mainCoins: mainCoins.length,
        moonCoins: moonCoins.length,
        trades: tradeCoins.length,
      },

      funnels: {
        main: mainAnalysis,
        moon: moonAnalysis,
        trade: tradeAnalysis,
      },
    });

  } catch (err) {
    console.error("SYSTEM ANALYZE ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
}