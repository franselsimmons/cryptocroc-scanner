import { kv } from "@vercel/kv";
import { readEvents } from "../lib/_analytics.js";
import { requireSecret, RUNTIME_CONFIG } from "../lib/_runtime.js";

export const config = RUNTIME_CONFIG;

// =============================
// NIEUWE THRESHOLD CONSTANTEN
// =============================
const CURRENT_THRESHOLDS = {
  market: 45,
  timing: 60,
  quality: 60,
};

const ADVISED_THRESHOLDS = {
  market: 55,
  timing: 65,
  quality: 68,
};

const THRESHOLD_LOCATIONS = {
  market: [
    "lib/_moon_core.js",
    "scanner / funnel bronbestand",
  ],
  timing: [
    "lib/_moon_core.js",
    "scanner / entry logic bestand",
  ],
  quality: [
    "lib/_moon_core.js",
    "scanner / filter logic bestand",
  ],
  exit: [
    "trade manager / execution bestand",
    "bestand waar trade_closed / exits gebeuren",
  ],
};

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

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function pct(v, digits = 0) {
  return `${n(v, 0).toFixed(digits)}%`;
}

function scoreColor(score) {
  if (score < 4) return "#dc2626";
  if (score < 6.5) return "#f59e0b";
  return "#16a34a";
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
// ANALYSE PER COIN -> BOTTLENECKS
// =============================
function analyzeCoin(coin) {
  const bottlenecks = [];

  const timingScore = n(coin?.timingScore, 0);
  const liquidityScore = n(coin?.liquidityScore, 0);
  const qualityScore = n(coin?.qualityScore, 0);
  const marketScore = n(coin?.marketScore, 0);

  if (timingScore < 60) {
    bottlenecks.push({
      key: "timing",
      label: "Timing verbeteren",
      advice: "Wacht op breakout + volume confirmatie",
      severity: (60 - timingScore) / 10,
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

  if (qualityScore < 60) {
    bottlenecks.push({
      key: "quality",
      label: "Kwaliteit verbeteren",
      advice: "Alleen high conviction setups",
      severity: (60 - qualityScore) / 10,
    });
  }

  if (marketScore < 45) {
    bottlenecks.push({
      key: "market",
      label: "Marktfilter verbeteren",
      advice: "Trade met BTC trend mee",
      severity: (45 - marketScore) / 10,
    });
  }

  return {
    score: avg([timingScore, liquidityScore, qualityScore, marketScore]) / 10,
    bottlenecks,
  };
}

// =============================
// VAN COINS -> IMPROVEMENT TABLE
// =============================
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

    // geen nep “100% exact”, maar een bruikbare schatting
    const expectedGainPct = Math.min(
      35,
      Math.round(item.impact * 1.6 + item.count * 1.2 + avgLoss * 0.9)
    );

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

  const topFix = rows[0] || null;

  return {
    funnelName,
    totalCoins: safeArr(coins).length,
    activeProblems: rows.reduce((a, b) => a + b.hits, 0),
    avgExpectedGainTop5: avg(rows.slice(0, 5).map((x) => x.expectedGainPct)),
    topFix,
    table: rows,
  };
}

// =============================
// TRADE ANALYSE
// =============================
function summarizeTrades(trades) {
  const tableMap = {};

  for (const t of safeArr(trades)) {
    const pnl = n(t?.pnlPct, 0);
    const maxPnl = n(t?.maxPnlPct, 0);
    const giveback = Math.max(0, maxPnl - pnl);

    function add(key, label, advice, severity) {
      if (!tableMap[key]) {
        tableMap[key] = {
          filter: label,
          advice,
          hits: 0,
          impact: 0,
          totalLoss: 0,
        };
      }
      tableMap[key].hits += 1;
      tableMap[key].impact += severity;
      tableMap[key].totalLoss += Math.max(0, severity);
    }

    if (giveback > 1.5) {
      add(
        "exit_timing",
        "Exit timing verbeteren",
        "Trailing TP strakker na TP1",
        giveback
      );
    }

    if (/timeout|weak|invalid|quality/i.test(String(t?.reason || ""))) {
      add(
        "weak_setup",
        "Zwake setups sneller stoppen",
        "Laat zwakke setups sneller los",
        2.5
      );
    }

    if (/spread|depth|slippage|liquid/i.test(String(t?.reason || ""))) {
      add(
        "trade_liquidity",
        "Liquiditeit in execution verbeteren",
        "Trade alleen coins met betere liquiditeit",
        2
      );
    }

    if (/btc|market|regime/i.test(String(t?.reason || ""))) {
      add(
        "trade_market",
        "Marktfilter bij entries verbeteren",
        "Trade alleen als BTC/regime meewerkt",
        1.8
      );
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
  };
}

// =============================
// GLOBALE SAMENVATTING
// =============================
function buildGlobalSummary(sections) {
  const rows = [];

  for (const section of safeArr(sections)) {
    for (const row of safeArr(section.table)) {
      rows.push({
        funnel: section.funnelName,
        ...row,
      });
    }
  }

  rows.sort((a, b) => b.expectedGainPct - a.expectedGainPct || b.priority - a.priority);

  return {
    bestOverall: rows[0] || null,
    topWins: rows.slice(0, 10),
  };
}

// =============================
// NIEUWE V4 FUNCTIES VOOR AI IMPROVEMENTS
// =============================
function buildAIImprovements(problems) {
  const map = {};

  for (const p of safeArr(problems)) {
    const severity = 10 - n(p.score, 0);

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
    .map((x) => {
      const label = String(x.label || "").toLowerCase();

      let type = null;

      if (label.includes("btc") || label.includes("trend") || label.includes("markt")) {
        type = "market";
      } else if (label.includes("breakout") || label.includes("timing") || label.includes("volume")) {
        type = "timing";
      } else if (label.includes("conviction") || label.includes("kwaliteit")) {
        type = "quality";
      } else if (
        label.includes("trailing") ||
        label.includes("zwakke setups") ||
        label.includes("stop") ||
        label.includes("exit")
      ) {
        type = "exit";
      }

      const current = type ? CURRENT_THRESHOLDS[type] ?? null : null;
      const advised = type ? ADVISED_THRESHOLDS[type] ?? null : null;
      const files = type ? safeArr(THRESHOLD_LOCATIONS[type]) : [];

      return {
        ...x,
        priority: x.impact + x.count * 2,
        type,
        current,
        advised,
        delta:
          current != null && advised != null
            ? advised - current
            : null,
        files,
      };
    })
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 5);
}

function renderImprovements(improvements) {
  if (!improvements.length) return '<p><em>Geen verbeterpunten</em></p>';

  return `
    <ul style="list-style: none; padding-left: 0;">
      ${improvements.map(imp => `
        <li style="margin-bottom: 14px; border-left: 4px solid #ff9800; padding-left: 12px;">
          <strong>${esc(imp.label)}</strong><br>
          <small>
            prioriteit: ${esc(String(imp.priority))} · aantal: ${esc(String(imp.count))} · impact: ${esc(String(imp.impact.toFixed(1)))}
          </small>
          ${
            imp.current != null || imp.advised != null
              ? `
                <div style="margin-top: 6px; font-size: 13px; color: #444;">
                  ${imp.current != null ? `<div><strong>Huidig:</strong> ${esc(String(imp.current))}</div>` : ""}
                  ${imp.advised != null ? `<div><strong>Advies:</strong> ${esc(String(imp.advised))}</div>` : ""}
                  ${imp.delta != null ? `<div><strong>Verschil:</strong> ${imp.delta > 0 ? "+" : ""}${esc(String(imp.delta))}</div>` : ""}
                </div>
              `
              : ""
          }
          ${
            imp.files?.length
              ? `
                <div style="margin-top: 6px; font-size: 13px; color: #666;">
                  <strong>Aanpassen in:</strong><br>
                  ${imp.files.map(f => `• ${esc(f)}`).join("<br>")}
                </div>
              `
              : ""
          }
        </li>
      `).join('')}
    </ul>
  `;
}

// =============================
// HTML
// =============================
function renderSummaryCards(sections) {
  return `
    <div class="summary-grid">
      ${sections.map((s) => `
        <div class="summary-card">
          <div class="summary-title">${esc(s.funnelName)}</div>
          <div class="summary-big">${esc(String(Math.round(s.avgExpectedGainTop5 || 0)))}%</div>
          <div class="summary-sub">gem. top 5 winstkans</div>
          <div class="summary-meta">
            <span>${esc(String(s.activeProblems))} probleem-hits</span>
            <span>${esc(String(s.totalCoins ?? s.totalTrades ?? 0))} items</span>
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

function renderTopWinsTable(rows) {
  if (!rows.length) return `<p><em>Geen verbeterkansen gevonden</em></p>`;

  return `
    <table class="table">
      <thead>
        <tr>
          <th>Funnel</th>
          <th>Filter</th>
          <th>Advies</th>
          <th>Treffers</th>
          <th>Impact</th>
          <th>Prioriteit</th>
          <th>Verwachte winst</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((r) => `
          <tr>
            <td>${esc(r.funnel)}</td>
            <td><strong>${esc(r.filter)}</strong></td>
            <td>${esc(r.advice)}</td>
            <td>${esc(String(r.hits))}</td>
            <td>${esc(String(r.impact.toFixed ? r.impact.toFixed(1) : r.impact))}</td>
            <td>${esc(String(r.priority.toFixed ? r.priority.toFixed(1) : r.priority))}</td>
            <td style="color:${scoreColor(r.expectedGainPct / 3)};font-weight:700;">+${esc(String(r.expectedGainPct))}%</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderFunnelTable(section) {
  if (!section) return "";

  return `
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>${esc(section.funnelName)}</h2>
          <div class="panel-sub">Waar zit de meeste winst als je deze funnel verbetert?</div>
        </div>
        <div class="panel-badge">${esc(String(section.table.length))} filters</div>
      </div>

      ${
        section.topFix
          ? `
          <div class="topfix">
            <div class="topfix-title">🚀 Fix eerst dit</div>
            <div class="topfix-main">${esc(section.topFix.filter)}</div>
            <div class="topfix-advice">${esc(section.topFix.advice)}</div>
            <div class="topfix-gain">→ verwacht +${esc(String(section.topFix.expectedGainPct))}% winst</div>
          </div>
        `
          : `<p><em>Geen topfix gevonden</em></p>`
      }

      ${renderTopWinsTable(
        safeArr(section.table).map((x) => ({ funnel: section.funnelName, ...x }))
      )}
    </section>
  `;
}

function renderHtml(payload) {
  const now = new Date().toLocaleString("nl-NL");

  const sections = [
    payload.main?.bull,
    payload.main?.bear,
    payload.moon?.bull,
    payload.moon?.bear,
    payload.trade,
  ].filter(Boolean);

  const global = payload.global || { bestOverall: null, topWins: [] };

  // Verzamel alle bottlenecks voor AI improvements
  const allProblems = [];
  for (const section of sections) {
    for (const coin of section?.rawCoins || []) {
      const result = analyzeCoin(coin);
      allProblems.push({ score: result.score, advice: result.bottlenecks.map(b => b.advice) });
    }
  }
  const improvements = buildAIImprovements(allProblems);

  return `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Trading Analyse Dashboard</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      background: #0b1020;
      color: #e5e7eb;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .container {
      max-width: 1380px;
      margin: 0 auto;
    }
    .hero {
      margin-bottom: 24px;
      padding: 24px;
      border-radius: 20px;
      background: linear-gradient(180deg, #11182c, #0d1324);
      border: 1px solid #1f2a44;
    }
    .hero h1 {
      margin: 0 0 8px;
      font-size: 32px;
    }
    .hero p {
      margin: 0;
      color: #94a3b8;
    }
    .timestamp {
      margin-top: 12px;
      font-size: 13px;
      color: #64748b;
    }
    .bigfix {
      margin-top: 18px;
      padding: 18px;
      border-radius: 16px;
      background: linear-gradient(180deg, #1a243d, #121a2d);
      border-left: 5px solid #22c55e;
      border: 1px solid #24324f;
    }
    .bigfix-label {
      font-size: 13px;
      color: #93c5fd;
      margin-bottom: 8px;
      text-transform: uppercase;
      letter-spacing: .08em;
    }
    .bigfix-main {
      font-size: 24px;
      font-weight: 800;
      margin-bottom: 6px;
    }
    .bigfix-sub {
      color: #cbd5e1;
      margin-bottom: 6px;
    }
    .bigfix-gain {
      color: #86efac;
      font-weight: 700;
    }

    .summary-grid {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 14px;
      margin-bottom: 24px;
    }
    .summary-card {
      background: #11182c;
      border: 1px solid #1f2a44;
      border-radius: 18px;
      padding: 18px;
    }
    .summary-title {
      font-size: 13px;
      color: #93c5fd;
      margin-bottom: 10px;
      text-transform: uppercase;
      letter-spacing: .06em;
    }
    .summary-big {
      font-size: 30px;
      font-weight: 800;
      color: #f8fafc;
    }
    .summary-sub {
      color: #94a3b8;
      font-size: 13px;
      margin-top: 4px;
    }
    .summary-meta {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 10px;
      font-size: 12px;
      color: #64748b;
    }

    .panel {
      background: #11182c;
      border: 1px solid #1f2a44;
      border-radius: 20px;
      padding: 20px;
      margin-bottom: 20px;
    }
    .panel-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
      margin-bottom: 16px;
    }
    .panel-head h2 {
      margin: 0 0 4px;
      font-size: 24px;
    }
    .panel-sub {
      color: #94a3b8;
      font-size: 14px;
    }
    .panel-badge {
      padding: 8px 12px;
      border-radius: 999px;
      background: #0b1325;
      border: 1px solid #263557;
      color: #93c5fd;
      font-size: 12px;
      white-space: nowrap;
    }

    .topfix {
      background: linear-gradient(180deg, #18233c, #10192c);
      border: 1px solid #263557;
      border-left: 5px solid #22c55e;
      border-radius: 16px;
      padding: 16px;
      margin-bottom: 18px;
    }
    .topfix-title {
      font-size: 12px;
      color: #93c5fd;
      text-transform: uppercase;
      letter-spacing: .08em;
      margin-bottom: 8px;
    }
    .topfix-main {
      font-size: 22px;
      font-weight: 800;
      margin-bottom: 6px;
    }
    .topfix-advice {
      color: #cbd5e1;
      margin-bottom: 6px;
    }
    .topfix-gain {
      color: #86efac;
      font-weight: 700;
    }

    .table {
      width: 100%;
      border-collapse: collapse;
      overflow: hidden;
      border-radius: 12px;
    }
    .table th, .table td {
      padding: 12px;
      border-bottom: 1px solid #1f2a44;
      text-align: left;
      vertical-align: top;
    }
    .table th {
      background: #0d1426;
      color: #93c5fd;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: .06em;
    }
    .table td {
      font-size: 14px;
      color: #e5e7eb;
    }

    .improvements-panel {
      background: #0f172a;
      border: 1px solid #2d3a5e;
      border-radius: 20px;
      padding: 20px;
      margin-bottom: 20px;
    }
    .improvements-title {
      font-size: 20px;
      font-weight: 700;
      margin-bottom: 12px;
      color: #fbbf24;
    }

    .footer {
      text-align: center;
      color: #64748b;
      font-size: 12px;
      margin-top: 28px;
    }

    @media (max-width: 1100px) {
      .summary-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
    @media (max-width: 760px) {
      body { padding: 14px; }
      .summary-grid { grid-template-columns: 1fr; }
      .panel-head { flex-direction: column; }
      .table { display: block; overflow-x: auto; }
      .hero h1 { font-size: 26px; }
      .bigfix-main { font-size: 20px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <section class="hero">
      <h1>📊 Trading Analyse Dashboard</h1>
      <p>Geen coin-lijsten, maar direct zicht op waar de grootste winst te halen is per funnel en per filter.</p>
      <div class="timestamp">Laatste update: ${esc(now)}</div>

      ${
        global.bestOverall
          ? `
          <div class="bigfix">
            <div class="bigfix-label">Grootste winstkans overall</div>
            <div class="bigfix-main">${esc(global.bestOverall.filter)}</div>
            <div class="bigfix-sub">${esc(global.bestOverall.advice)} · Funnel: ${esc(global.bestOverall.funnel)}</div>
            <div class="bigfix-gain">→ verwacht +${esc(String(global.bestOverall.expectedGainPct))}% winst</div>
          </div>
        `
          : ""
      }
    </section>

    ${renderSummaryCards(sections)}

    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>🏆 Top winstkansen over alle funnels</h2>
          <div class="panel-sub">Hier zitten de grootste verbeterkansen als je het systeem dunner en slimmer maakt.</div>
        </div>
        <div class="panel-badge">${esc(String(global.topWins.length))} kansen</div>
      </div>
      ${renderTopWinsTable(global.topWins)}
    </section>

    <!-- NIEUW: AI-verbeterpunten met threshold advies -->
    <div class="improvements-panel">
      <div class="improvements-title">🤖 AI‑gestuurde verbetersuggesties (met thresholds)</div>
      ${renderImprovements(improvements)}
    </div>

    ${renderFunnelTable(payload.main?.bull)}
    ${renderFunnelTable(payload.main?.bear)}
    ${renderFunnelTable(payload.moon?.bull)}
    ${renderFunnelTable(payload.moon?.bear)}
    ${renderFunnelTable(payload.trade)}

    <div class="footer">
      ⚡ AI-gestuurde funnel-analyse · focus op filters en verwachte winst, niet op losse coins
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

    // Extra data nodig voor raw coins in improvements (alleen de coins)
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

    // Stop raw coins in de secties voor later gebruik in renderHtml
    mainBull.rawCoins = allRawCoins.mainBull;
    mainBear.rawCoins = allRawCoins.mainBear;
    moonBull.rawCoins = allRawCoins.moonBull;
    moonBear.rawCoins = allRawCoins.moonBear;
    trade.rawCoins = [];

    const sections = [mainBull, mainBear, moonBull, moonBear, trade];
    const global = buildGlobalSummary(sections);

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
      global,
    };

    const acceptHeader = req.headers.accept || "";
    if (acceptHeader.includes("text/html")) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(renderHtml(payload));
    }

    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: String(err?.message || err),
    });
  }
}