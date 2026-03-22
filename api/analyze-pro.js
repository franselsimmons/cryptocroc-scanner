import { kv } from "@vercel/kv";
import { readEvents } from "../lib/_analytics.js";
import * as moonCore from "../lib/_moon_core.js";

// ================= HELPERS =================
function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function scoreFromFailRate(fails, total) {
  if (!total) return 5;
  const failRate = fails / total;
  return Math.max(1, Math.min(10, Math.round((1 - failRate) * 10)));
}

function adviceBlock(name, score, issue, fix) {
  return {
    filter: name,
    score,
    issue,
    fix,
    target: "→ naar 9/10",
  };
}

// ================= MAIN =================
function analyzeMain(coins) {
  const total = coins.length || 1;

  let fails = {
    btc: 0,
    breakout: 0,
    persistence: 0,
    entry: 0,
  };

  for (const c of coins) {
    const checklist = c?.execution?.checklist || [];

    for (const item of checklist) {
      if (!item.ok) {
        const name = String(item.name || "").toLowerCase();

        if (name.includes("btc")) fails.btc++;
        if (name.includes("breakout")) fails.breakout++;
        if (name.includes("persist")) fails.persistence++;
        if (name.includes("entry")) fails.entry++;
      }
    }
  }

  const scores = {
    btc: scoreFromFailRate(fails.btc, total),
    breakout: scoreFromFailRate(fails.breakout, total),
    persistence: scoreFromFailRate(fails.persistence, total),
    entry: scoreFromFailRate(fails.entry, total),
  };

  return [
    adviceBlock(
      "BTC Alignment",
      scores.btc,
      scores.btc < 7 ? "Te veel coins falen door BTC richting mismatch" : "Goed",
      "Verlaag of versoepel BTC confirmatie threshold"
    ),
    adviceBlock(
      "Breakout",
      scores.breakout,
      scores.breakout < 7 ? "Breakouts worden te streng afgekeurd" : "Goed",
      "Verlaag breakout ready threshold of druk"
    ),
    adviceBlock(
      "Persistence",
      scores.persistence,
      scores.persistence < 7 ? "Moves houden niet lang genoeg stand" : "Goed",
      "Verlaag persistence score eis licht (5-10%)"
    ),
    adviceBlock(
      "Entry Quality",
      scores.entry,
      scores.entry < 7 ? "Entries te streng → weinig trades" : "Goed",
      "Versoepel entryQuality threshold"
    ),
  ];
}

// ================= MOON =================
function analyzeMoon(diags) {
  const total = diags.length || 1;

  let eliteFails = 0;
  let obFails = 0;
  let stabilityFails = 0;

  for (const d of diags) {
    const r = d?.reasons || {};

    eliteFails += Object.values(r.eliteWhy || {}).reduce((a, b) => a + b, 0);
    obFails += Object.values(r.obReason || {}).reduce((a, b) => a + b, 0);
    stabilityFails += Object.values(r.eliteExtraFail || {}).reduce((a, b) => a + b, 0);
  }

  const eliteScore = scoreFromFailRate(eliteFails, total * 5);
  const liqScore = scoreFromFailRate(obFails, total * 5);
  const stabScore = scoreFromFailRate(stabilityFails, total * 5);

  return [
    adviceBlock(
      "Elite Filter",
      eliteScore,
      eliteScore < 7 ? "Te weinig coins halen ELITE" : "Goed",
      "Versoepel elite thresholds (vm / velocity / ch1h)"
    ),
    adviceBlock(
      "Liquidity",
      liqScore,
      liqScore < 7 ? "Te veel coins vallen af op orderboek" : "Goed",
      "Verlaag depth eis of spread limiet"
    ),
    adviceBlock(
      "Stability",
      stabScore,
      stabScore < 7 ? "Coins vallen af door instabiliteit" : "Goed",
      "Verlaag rolling window strictheid"
    ),
  ];
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

  const givebackScore = Math.max(1, 10 - giveback / total);
  const lossScore = Math.max(1, 10 - (losses / total) * 10);

  return [
    adviceBlock(
      "Giveback",
      givebackScore,
      givebackScore < 7 ? "Je geeft winst terug" : "Goed",
      "Strakkere trailing TP na TP1"
    ),
    adviceBlock(
      "Loss Rate",
      lossScore,
      lossScore < 7 ? "Te veel verliezende trades" : "Goed",
      "Strengere entry of betere BTC filter"
    ),
  ];
}

// ================= HANDLER =================
export default async function handler(req, res) {
  try {
    const [bull, bear, trades] = await Promise.all([
      kv.get(moonCore.keyMainLatest("bull")),
      kv.get(moonCore.keyMainLatest("bear")),
      readEvents("trade_closed", 4000),
    ]);

    const coins = [
      ...(bull?.funnel?.entry || []),
      ...(bear?.funnel?.entry || []),
    ];

    const main = analyzeMain(coins);
    const moon = analyzeMoon([]); // kan later gevuld worden
    const trade = analyzeTrades(trades);

    res.json({ main, moon, trade });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}