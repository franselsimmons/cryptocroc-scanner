import { kv } from "@vercel/kv";
import { readEvents } from "../lib/_analytics.js";
import { requireSecret, RUNTIME_CONFIG } from "../lib/_runtime.js";
import { THRESHOLDS } from "../lib/_thresholds.js";

export const config = RUNTIME_CONFIG;

const THRESHOLD_LOCATIONS = {
  market: ["lib/_thresholds.js", "api/main/scan.js", "api/moon/scan.js"],
  timing: ["lib/_thresholds.js", "api/main/scan.js", "api/moon/scan.js"],
  quality: ["lib/_thresholds.js", "api/main/scan.js", "api/moon/scan.js"],
  exit: ["lib/_thresholds.js", "api/analyze-all.js"],
};

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
function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function scoreColor(score) {
  if (score < 4) return "#dc2626";
  if (score < 6.5) return "#f59e0b";
  return "#16a34a";
}

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

function analyzeCoin(coin) {
  const bottlenecks = [];

  const timingScore = n(coin?.timingScore, 0);
  const liquidityScore = n(coin?.liquidityScore, 0);
  const qualityScore = n(coin?.qualityScore, 0);
  const marketScore = n(coin?.marketScore, 0);

  if (timingScore < THRESHOLDS.timing.current) {
    bottlenecks.push({
      key: "timing",
      label: "Timing verbeteren",
      advice: "Wacht op breakout + volume confirmatie",
      severity: (THRESHOLDS.timing.current - timingScore) / 10,
    });
  }

  if (liquidityScore < 60) {
    bottlenecks.push({
      key: "liquidity",
      label: "Liquiditeit verbeteren",
      advice: "Focus op coins met betere depth/spread",
      severity: (60 - liquidityScore) / 10,
    });
  }

  if (qualityScore < THRESHOLDS.quality.current) {
    bottlenecks.push({
      key: "quality",
      label: "Kwaliteit verbeteren",
      advice: "Alleen high conviction setups",
      severity: (THRESHOLDS.quality.current - qualityScore) / 10,
    });
  }

  if (marketScore < THRESHOLDS.market.current) {
    bottlenecks.push({
      key: "market",
      label: "Marktfilter verbeteren",
      advice: "Trade met BTC trend mee",
      severity: (THRESHOLDS.market.current - marketScore) / 10,
    });
  }

  return {
    score: avg([timingScore, liquidityScore, qualityScore, marketScore]) / 10,
    bottlenecks,
  };
}

function summarize(coins, funnelName) {
  const rows = [];
  const map = {};

  for (const coin of safeArr(coins)) {
    const result = analyzeCoin(coin);

    for (const b of result.bottlenecks) {
      if (!map[b.key]) {
        map[b.key] = {
          key: b.key,
          label: b.label,
          advice: b.advice,
          count: 0,
          impact: 0,
          totalScoreLoss: 0,
        };
      }
      map[b.key].count += 1;
      map[b.key].impact += b.severity;
      map[b.key].totalScoreLoss += Math.max(0, 10 - result.score);
    }
  }

  for (const item of Object.values(map)) {
    const avgLoss = item.count ? item.totalScoreLoss / item.count : 0;
    const improvementScore = item.impact * 1.8 + item.count * 1.4 + avgLoss * 0.8;
    const expectedGainPct = Math.min(35, Math.round(item.impact * 1.6 + item.count * 1.2 + avgLoss * 0.9));

    rows.push({
      filter: item.label,
      advice: item.advice,
      hits: item.count,
      impact: Number(item.impact.toFixed(1)),
      avgLoss: Number(avgLoss.toFixed(1)),
      priority: Number(improvementScore.toFixed(1)),
      expectedGainPct,
    });
  }

  rows.sort((a, b) => b.expectedGainPct - a.expectedGainPct || b.priority - a.priority);

  return {
    funnelName,
    totalCoins: safeArr(coins).length,
    activeProblems: rows.reduce((a, b) => a + b.hits, 0),
    avgExpectedGainTop5: avg(rows.slice(0, 5).map((x) => x.expectedGainPct)),
    topFix: rows[0] || null,
    table: rows,
    rawCoins: safeArr(coins),
  };
}

function summarizeTrades(trades) {
  const tableMap = {};

  for (const t of safeArr(trades)) {
    const pnl = n(t?.pnlPct, 0);
    const maxPnl = n(t?.maxPnlPct, 0);
    const giveback = Math.max(0, maxPnl - pnl);

    function add(key, label, advice, severity) {
      if (!tableMap[key]) {
        tableMap[key] = { filter: label, advice, hits: 0, impact: 0, totalLoss: 0 };
      }
      tableMap[key].hits += 1;
      tableMap[key].impact += severity;
      tableMap[key].totalLoss += Math.max(0, severity);
    }

    if (giveback > THRESHOLDS.exit.giveback) {
      add("exit_timing", "Exit timing verbeteren", "Trailing TP strakker na TP1", giveback);
    }

    if (/timeout|weak|invalid|quality/i.test(String(t?.reason || ""))) {
      add("weak_setup", "Zwake setups sneller stoppen", "Laat zwakke setups sneller los", 2.5);
    }

    if (/spread|depth|slippage|liquid/i.test(String(t?.reason || ""))) {
      add("trade_liquidity", "Liquiditeit in execution verbeteren", "Trade alleen coins met betere liquiditeit", 2);
    }

    if (/btc|market|regime/i.test(String(t?.reason || ""))) {
      add("trade_market", "Marktfilter bij entries verbeteren", "Trade alleen als BTC/regime meewerkt", 1.8);
    }
  }

  const rows = Object.values(tableMap).map((x) => {
    const avgLoss = x.hits ? x.totalLoss / x.hits : 0;
    const expectedGainPct = Math.min(35, Math.round(x.impact * 1.3 + x.hits * 1.4));
    const priority = x.impact * 1.7 + x.hits * 1.5 + avgLoss;
    return {
      filter: x.filter,
      advice: x.advice,
      hits: x.hits,
      impact: Number(x.impact.toFixed(1)),
      avgLoss: Number(avgLoss.toFixed(1)),
      priority: Number(priority.toFixed(1)),
      expectedGainPct,
    };
  });

  rows.sort((a, b) => b.expectedGainPct - a.expectedGainPct || b.priority - a.priority);

  return {
    funnelName: "Trade Performance",
    totalTrades: safeArr(trades).length,
    activeProblems: rows.reduce((a, b) => a + b.hits, 0),
    avgExpectedGainTop5: avg(rows.slice(0, 5).map((x) => x.expectedGainPct)),
    topFix: rows[0] || null,
    table: rows,
    rawCoins: [],
  };
}

function buildGlobalSummary(sections) {
  const rows = [];
  for (const section of safeArr(sections)) {
    for (const row of safeArr(section.table)) {
      rows.push({ funnel: section.funnelName, ...row });
    }
  }
  rows.sort((a, b) => b.expectedGainPct - a.expectedGainPct || b.priority - a.priority);
  return { bestOverall: rows[0] || null, topWins: rows.slice(0, 10) };
}

function renderTopWinsTable(rows) {
  if (!rows.length) return `<p><em>Geen verbeterkansen gevonden</em></p>`;
  return `
    <table class="table">
      <thead>
        <tr>
          <th>Funnel</th><th>Filter</th><th>Advies</th>
          <th>Treffers</th><th>Impact</th><th>Prioriteit</th><th>Verwachte winst</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td>${esc(r.funnel)}</td>
            <td><strong>${esc(r.filter)}</strong></td>
            <td>${esc(r.advice)}</td>
            <td>${esc(String(r.hits))}</td>
            <td>${esc(String(r.impact?.toFixed ? r.impact.toFixed(1) : r.impact))}</td>
            <td>${esc(String(r.priority?.toFixed ? r.priority.toFixed(1) : r.priority))}</td>
            <td style="color:${scoreColor(r.expectedGainPct/3)};font-weight:700;">+${esc(String(r.expectedGainPct))}%</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderHtml(payload) {
  const now = new Date().toLocaleString("nl-NL");
  const sections = [payload.main?.bull, payload.main?.bear, payload.moon?.bull, payload.moon?.bear, payload.trade].filter(Boolean);
  const global = payload.global || { bestOverall: null, topWins: [] };

  return `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Trading Analyse Dashboard</title>
  <style>
    body{margin:0;padding:24px;background:#0b1020;color:#e5e7eb;font-family:Inter,system-ui}
    .container{max-width:1380px;margin:0 auto}
    .hero{padding:24px;border-radius:20px;background:linear-gradient(180deg,#11182c,#0d1324);border:1px solid #1f2a44;margin-bottom:16px}
    .timestamp{margin-top:8px;color:#64748b;font-size:13px}
    .panel{background:#11182c;border:1px solid #1f2a44;border-radius:20px;padding:20px;margin-bottom:16px}
    .table{width:100%;border-collapse:collapse;border-radius:12px;overflow:hidden}
    .table th,.table td{padding:12px;border-bottom:1px solid #1f2a44;text-align:left;vertical-align:top}
    .table th{background:#0d1426;color:#93c5fd;font-size:12px;text-transform:uppercase;letter-spacing:.06em}
  </style>
</head>
<body>
  <div class="container">
    <section class="hero">
      <h1>📊 Trading Analyse Dashboard</h1>
      <div class="timestamp">Laatste update: ${esc(now)} · auto-sync thresholds: <strong>aan</strong></div>
    </section>

    <section class="panel">
      <h2>🏆 Top winstkansen over alle funnels</h2>
      ${renderTopWinsTable(global.topWins)}
    </section>
  </div>
</body>
</html>`;
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    // no-cache zodat hij nooit "blijft hangen"
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");

    const [mainBullLatest, mainBearLatest, moonBullLatest, moonBearLatest, tradeClosed] =
      await Promise.all([
        kv.get("latest:bull"),
        kv.get("latest:bear"),
        kv.get("moon:latest:bull"),
        kv.get("moon:latest:bear"),
        readEvents("trade_closed", 2000).catch(() => []),
      ]);

    const allRawCoins = {
      mainBull: flatten(mainBullLatest),
      mainBear: flatten(mainBearLatest),
      moonBull: flatten(moonBullLatest),
      moonBear: flatten(moonBearLatest),
    };

    const mainBull = summarize(allRawCoins.mainBull, "Main Bull");
    const mainBear = summarize(allRawCoins.mainBear, "Main Bear");
    const moonBull = summarize(allRawCoins.moonBull, "Moon Bull");
    const moonBear = summarize(allRawCoins.moonBear, "Moon Bear");
    const trade = summarizeTrades(tradeClosed);

    const sections = [mainBull, mainBear, moonBull, moonBear, trade];
    const global = buildGlobalSummary(sections);

    const payload = {
      ok: true,
      thresholds: THRESHOLDS, // altijd meegeven: je ziet live wat active is
      main: { bull: mainBull, bear: mainBear },
      moon: { bull: moonBull, bear: moonBear },
      trade,
      global,
      updatedAt: Date.now(),
    };

    const accept = req.headers.accept || "";
    if (accept.includes("text/html")) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(renderHtml(payload));
    }
    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}