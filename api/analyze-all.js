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
// SCORING ENGINE (LERAAR MODE)
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
    btc: "Versoepel BTC confirmatie / regime-check",
    breakout: "Verlaag breakout threshold",
    persistence: "Verlaag persistence met 5–10%",
    entry: "Verlaag entryQuality licht",
    liquidity: "Verlaag depth requirement of spread filter",
  };
  return map[key] || "Optimaliseer filter licht";
}

// ===============================
// MAIN FUNNEL ANALYSE
// ===============================
function analyzeMain(latest) {
  const coins = [
    ...(latest?.funnel?.radar || []),
    ...(latest?.funnel?.buildup || []),
    ...(latest?.funnel?.almost || []),
  ];

  const total = coins.length || 1;

  const fails = {
    btc: coins.filter(c => n(c.btcAlignmentScore) < 50).length,
    breakout: coins.filter(c => !c.breakout?.ready).length,
    persistence: coins.filter(c => n(c.persistenceScore) < 55).length,
    entry: coins.filter(c => n(c.entryQuality) < 60).length,
    liquidity: coins.filter(c => !c.thresholds?.depthOk).length,
  };

  return Object.entries(fails).map(([k, v]) => ({
    key: k,
    score: scoreFilter(v, total),
    fails: v,
    total,
    advice: adviceMap(k),
  }));
}

// ===============================
// MOON FUNNEL ANALYSE (FIX)
// ===============================
function analyzeMoon(latest) {
  const coins = [
    ...(latest?.funnel?.radar || []),
    ...(latest?.funnel?.buildup || []),
    ...(latest?.funnel?.almost || []),
  ];

  const total = coins.length || 1;

  const fails = {
    btc: coins.filter(c => n(c.btcAlignmentScore) < 50).length,
    breakout: coins.filter(c => !c.breakout?.ready).length,
    persistence: coins.filter(c => n(c.persistenceScore) < 55).length,
    entry: coins.filter(c => n(c.entryQuality) < 60).length,
    liquidity: coins.filter(c => !c.thresholds?.depthOk).length,
  };

  return Object.entries(fails).map(([k, v]) => ({
    key: k,
    score: scoreFilter(v, total),
    fails: v,
    total,
    advice: adviceMap(k),
  }));
}

// ===============================
// TRADE FUNNEL ANALYSE
// ===============================
function analyzeTrade(latest) {
  const trades = latest?.trades || [];
  const total = trades.length || 1;

  const fails = {
    entry: trades.filter(t => n(t.entryQuality) < 60).length,
    persistence: trades.filter(t => n(t.persistenceScore) < 55).length,
    btc: trades.filter(t => n(t.btcAlignmentScore) < 50).length,
  };

  return Object.entries(fails).map(([k, v]) => ({
    key: k,
    score: scoreFilter(v, total),
    fails: v,
    total,
    advice: adviceMap(k),
  }));
}

// ===============================
// MAIN HANDLER
// ===============================
export default async function handler(req, res) {
  try {
    const [mainBull, moonBull, trade] = await Promise.all([
      kv.get(keyMainLatest("bull")),
      kv.get(keyMoonLatest("bull")), // 🔥 FIX HIER
      kv.get(keyTradeLatest()),
    ]);

    const mainAnalysis = analyzeMain(mainBull || {});
    const moonAnalysis = analyzeMoon(moonBull || {}); // 🔥 NU WERKT MOON
    const tradeAnalysis = analyzeTrade(trade || {});

    return res.status(200).json({
      ok: true,
      summary: {
        mainCoins: mainBull?.counts?.radar || 0,
        moonCoins: moonBull?.counts?.radar || 0,
        trades: trade?.trades?.length || 0,
      },
      funnels: {
        main: mainAnalysis,
        moon: moonAnalysis,
        trade: tradeAnalysis,
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      ok: false,
      error: e.message,
    });
  }
}