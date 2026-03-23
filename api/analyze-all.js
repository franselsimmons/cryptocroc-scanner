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
// HTML RENDERER
// =============================
function renderHtml(payload) {
  const { main, moon, trade } = payload;
  const now = new Date().toLocaleString();

  // Helper om score in kleur te tonen
  const scoreColor = (score) => {
    if (score < 3) return '#c62828'; // rood
    if (score < 6) return '#f9a825'; // oranje
    if (score < 8) return '#2e7d32'; // groen
    return '#1b5e20';
  };

  // Helper om een problems-tabel te genereren
  const renderProblems = (problems) => {
    if (!problems.length) return '<p><em>Geen problemen gevonden</em></p>';
    return `
      <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%;">
        <thead>
          <tr style="background: #f0f0f0;">
            <th>Coin</th>
            <th>Score (0-10)</th>
            <th>Advies</th>
          </tr>
        </thead>
        <tbody>
          ${problems.map(p => `
            <tr>
              <td>${p.symbol}</td>
              <td style="color: ${scoreColor(p.score)}; font-weight: bold;">${p.score.toFixed(1)}</td>
              <td>${p.advice.join(', ')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  };

  const renderImprovements = (improvements) => {
    if (!improvements.length) return '<p><em>Geen verbeterpunten</em></p>';
    return `
      <ul style="list-style: none; padding-left: 0;">
        ${improvements.map(imp => `
          <li style="margin-bottom: 10px; border-left: 4px solid #ff9800; padding-left: 10px;">
            <strong>${imp.label}</strong><br>
            <small>prioriteit: ${imp.priority} (aantal: ${imp.count}, impact: ${imp.impact.toFixed(1)})</small>
          </li>
        `).join('')}
      </ul>
    `;
  };

  const renderSection = (title, data) => {
    if (!data) return '';
    return `
      <div style="margin-bottom: 30px;">
        <h2>${title}</h2>
        <h3>Problemen (zwakste setups)</h3>
        ${renderProblems(data.problems || [])}
        <h3>Top AI-verbeterpunten</h3>
        ${renderImprovements(data.topImprovements || [])}
      </div>
    `;
  };

  return `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Trading Analyse - Overzicht</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.5;
      margin: 0;
      padding: 20px;
      background: #fafafa;
      color: #333;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      background: white;
      padding: 20px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    h1, h2, h3 {
      margin-top: 0;
    }
    h1 {
      font-size: 1.8rem;
      margin-bottom: 0.5rem;
    }
    .timestamp {
      color: #666;
      font-size: 0.9rem;
      margin-bottom: 1.5rem;
      border-bottom: 1px solid #eee;
      padding-bottom: 0.5rem;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 20px;
    }
    th, td {
      border: 1px solid #ddd;
      padding: 8px;
      text-align: left;
    }
    th {
      background-color: #f2f2f2;
    }
    tr:nth-child(even) {
      background-color: #f9f9f9;
    }
    hr {
      margin: 30px 0;
      border: none;
      border-top: 1px solid #eee;
    }
    .footer {
      margin-top: 30px;
      text-align: center;
      font-size: 0.8rem;
      color: #888;
      border-top: 1px solid #eee;
      padding-top: 15px;
    }
  </style>
</head>
<body>
<div class="container">
  <h1>📊 Trading Analyse Dashboard</h1>
  <div class="timestamp">Laatste update: ${now}</div>

  ${renderSection('Main (Bull)', main?.bull)}
  ${renderSection('Main (Bear)', main?.bear)}
  ${renderSection('Moon (Bull)', moon?.bull)}
  ${renderSection('Moon (Bear)', moon?.bear)}
  ${renderSection('Trade Performance', trade)}

  <div class="footer">
    ⚡ AI-gestuurde analyse | Prioriteit = impact + (aantal × 2)
  </div>
</div>
</body>
</html>`;
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

    // Check of de client HTML verwacht (bijv. browser)
    const acceptHeader = req.headers.accept || '';
    if (acceptHeader.includes('text/html')) {
      const html = renderHtml(payload);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(html);
    } else {
      // Standaard JSON voor API-clients
      return res.status(200).json(payload);
    }
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: String(err?.message || err),
    });
  }
}