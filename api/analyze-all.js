import { kv } from "@vercel/kv";
import { readEvents } from "../lib/_analytics.js";
import { requireSecret, RUNTIME_CONFIG } from "../lib/_runtime.js";
import * as moonCore from "../lib/_moon_core.js";

export const config = RUNTIME_CONFIG;

// =============================
// HELPERS
// =============================
function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function safeArr(x) {
  return Array.isArray(x) ? x : [];
}

function avg(arr) {
  const vals = safeArr(arr).map((x) => n(x, NaN)).filter(Number.isFinite);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}

// =============================
// 🔥 AI IMPROVEMENTS ENGINE
// =============================
function buildAIImprovements(problems) {
  const map = {};

  for (const p of safeArr(problems)) {
    const severity = 10 - n(p.score, 0); // hoe slechter score → hoger gewicht

    for (const adv of safeArr(p.advice)) {
      const key = adv.toLowerCase().trim();

      if (!map[key]) {
        map[key] = {
          label: adv,
          count: 0,
          impact: 0,
        };
      }

      map[key].count++;
      map[key].impact += severity;
    }
  }

  return Object.values(map)
    .map((x) => ({
      ...x,
      priority: x.impact + x.count * 2, // AI gewicht
    }))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 5);
}

// =============================
// BOTTLENECK ANALYSIS
// =============================
function analyzeCoin(coin) {
  const issues = [];
  const advice = [];

  if (n(coin?.timingScore) < 60) {
    issues.push("timing");
    advice.push("Wacht op breakout + volume confirmatie");
  }

  if (n(coin?.liquidityScore) < 60) {
    issues.push("liquidity");
    advice.push("Focus op coins met betere depth/spread");
  }

  if (n(coin?.qualityScore) < 60) {
    issues.push("quality");
    advice.push("Alleen high conviction setups");
  }

  if (n(coin?.marketScore) < 45) {
    issues.push("market");
    advice.push("Trade met BTC trend mee");
  }

  return {
    score: avg([
      n(coin?.timingScore),
      n(coin?.liquidityScore),
      n(coin?.qualityScore),
      n(coin?.marketScore),
    ]) / 10,
    advice: [...new Set(advice)],
  };
}

// =============================
// SUMMARIZE
// =============================
function summarize(coins) {
  const problems = [];

  for (const c of safeArr(coins)) {
    const r = analyzeCoin(c);

    if (!r.advice.length) continue;

    problems.push({
      symbol: c.symbol,
      score: r.score,
      advice: r.advice,
    });
  }

  problems.sort((a, b) => a.score - b.score);

  return {
    problems,
    topImprovements: buildAIImprovements(problems),
  };
}

// =============================
// FLATTEN
// =============================
function flatten(latest) {
  const f = latest?.funnel || {};
  return [
    ...safeArr(f.radar),
    ...safeArr(f.buildup),
    ...safeArr(f.almost),
    ...safeArr(f.entry),
    ...safeArr(f.elite_ignition),
    ...safeArr(f.elite_expansion),
    ...safeArr(f.elite_cascade),
    ...safeArr(f.hold),
  ];
}

// =============================
// MAIN
// =============================
export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const [
      mainBullLatest,
      mainBearLatest,
      moonBullLatest,
      moonBearLatest,
      tradeClosed,
    ] = await Promise.all([
      kv.get("latest:bull"),
      kv.get("latest:bear"),
      kv.get("moon:latest:bull"),
      kv.get("moon:latest:bear"),
      readEvents("trade_closed", 2000).catch(() => []),
    ]);

    // =============================
    // SPLIT FUNNELS
    // =============================
    const mainBull = summarize(flatten(mainBullLatest));
    const mainBear = summarize(flatten(mainBearLatest));

    const moonBull = summarize(flatten(moonBullLatest));
    const moonBear = summarize(flatten(moonBearLatest));

    // =============================
    // TRADE
    // =============================
    const tradeProblems = safeArr(tradeClosed).map((t) => ({
      score: 10 - Math.max(0, (t.maxPnlPct || 0) - (t.pnlPct || 0)),
      advice: [
        "Trailing TP strakker na TP1",
        "Laat zwakke setups sneller los",
      ],
    }));

    const trade = {
      problems: tradeProblems,
      topImprovements: buildAIImprovements(tradeProblems),
    };

    // =============================
    // RESPONSE
    // =============================
    const payload = {
      ok: true,
      main: {
        bull: mainBull,
        bear: mainBear,
      },
      moon: {
        bull: moonBull,
        bear: moonBear,
      },
      trade,
    };

    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: String(err?.message || err),
    });
  }
}