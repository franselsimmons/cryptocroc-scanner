import { kv } from "@vercel/kv";
import { readEvents } from "../lib/_analytics.js";
import * as moonCore from "../lib/_moon_core.js";

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function scoreFromFailRate(fails, total) {
  if (!total) return 5;
  const failRate = fails / total;
  const score = Math.max(1, Math.min(10, Math.round((1 - failRate) * 10)));
  return score;
}

// ================= MAIN =================
function analyzeMain(coins, trades) {
  const total = coins.length || 1;

  let fails = {
    btc: 0,
    breakout: 0,
    persistence: 0,
    entry: 0,
  };

  for (const c of coins) {
    const ex = c?.execution || {};
    const checklist = ex.checklist || [];

    for (const item of checklist) {
      const name = String(item.name || "").toLowerCase();

      if (!item.ok) {
        if (name.includes("btc")) fails.btc++;
        if (name.includes("breakout")) fails.breakout++;
        if (name.includes("persist")) fails.persistence++;
        if (name.includes("entry")) fails.entry++;
      }
    }
  }

  const scores = {
    btcAlignment: scoreFromFailRate(fails.btc, total),
    breakout: scoreFromFailRate(fails.breakout, total),
    persistence: scoreFromFailRate(fails.persistence, total),
    entryQuality: scoreFromFailRate(fails.entry, total),
  };

  return scores;
}

// ================= MOON =================
function analyzeMoon(diags) {
  const total = diags.length || 1;

  let fails = {
    elite: 0,
    ob: 0,
    rolling: 0,
  };

  for (const d of diags) {
    const r = d?.reasons || {};

    fails.elite += Object.values(r.eliteWhy || {}).reduce((a, b) => a + b, 0);
    fails.ob += Object.values(r.obReason || {}).reduce((a, b) => a + b, 0);
    fails.rolling += Object.values(r.eliteExtraFail || {}).reduce((a, b) => a + b, 0);
  }

  const scores = {
    eliteFilter: scoreFromFailRate(fails.elite, total * 5),
    liquidity: scoreFromFailRate(fails.ob, total * 5),
    stability: scoreFromFailRate(fails.rolling, total * 5),
  };

  return scores;
}

// ================= TRADES =================
function analyzeTrades(trades) {
  const total = trades.length || 1;

  let giveback = 0;
  let losses = 0;

  for (const t of trades) {
    const max = n(t?.maxPnlPct);
    const pnl = n(t?.pnlPct);

    giveback += Math.max(0, max - pnl);
    if (pnl < 0) losses++;
  }

  return {
    givebackScore: Math.max(1, 10 - giveback / total),
    lossRateScore: Math.max(1, 10 - (losses / total) * 10),
  };
}

export default async function handler(req, res) {
  try {
    const [bull, bear, trades] = await Promise.all([
      kv.get(moonCore.keyMainLatest("bull")),
      kv.get(moonCore.keyMainLatest("bear")),
      readEvents("trade_closed", 4000),
    ]);

    const coinsBull = bull?.funnel?.entry || [];
    const coinsBear = bear?.funnel?.entry || [];

    const mainBull = analyzeMain(coinsBull, trades);
    const mainBear = analyzeMain(coinsBear, trades);

    const moonBull = analyzeMoon([]);
    const moonBear = analyzeMoon([]);

    const tradeStats = analyzeTrades(trades);

    res.json({
      main: { bull: mainBull, bear: mainBear },
      moon: { bull: moonBull, bear: moonBear },
      trades: tradeStats,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}