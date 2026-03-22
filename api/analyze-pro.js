import { kv } from "@vercel/kv";
import { readEvents } from "../lib/_analytics.js";
import { requireSecret, RUNTIME_CONFIG } from "../lib/_runtime.js";

export const config = RUNTIME_CONFIG;

/* ================= HELPERS ================= */

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}
function safeArr(x) {
  return Array.isArray(x) ? x : [];
}
function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
function inc(map, key) {
  const k = String(key || "unknown");
  map[k] = (map[k] || 0) + 1;
}
function topN(map, k = 5) {
  return Object.entries(map || {})
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, k);
}

/* ================= DATA ================= */

function flattenCoins(latest) {
  const f = latest?.funnel || {};
  return [
    ...safeArr(f.radar).map(c => ({ ...c, _stage: "RADAR" })),
    ...safeArr(f.buildup).map(c => ({ ...c, _stage: "BUILDUP" })),
    ...safeArr(f.almost).map(c => ({ ...c, _stage: "ALMOST" })),
    ...safeArr(f.elite_ignition).map(c => ({ ...c, _stage: "ELITE_IGNITION" })),
    ...safeArr(f.elite_expansion).map(c => ({ ...c, _stage: "ELITE_EXPANSION" })),
  ];
}

/* ================= BOTTLENECKS ================= */

function analyzeBottlenecks(coins) {
  const fails = {};
  const checklistFails = {};

  for (const c of coins) {
    const ex = c.execution || {};
    const checklist = ex.checklist || {};

    for (const [k, v] of Object.entries(checklist)) {
      if (v === false) inc(checklistFails, k);
    }

    if (ex.reason) inc(fails, ex.reason);
  }

  return {
    topChecklistFails: topN(checklistFails, 5),
    topExecutionFails: topN(fails, 5),
  };
}

/* ================= TRADES ================= */

function analyzeTrades(events) {
  const closes = events.filter(e => e.type === "trade_close");

  const exitReasons = {};
  let givebackSum = 0;

  for (const t of closes) {
    inc(exitReasons, t.reason);

    const max = n(t.maxPnlPct, 0);
    const pnl = n(t.pnlPct, 0);
    givebackSum += Math.max(0, max - pnl);
  }

  const avgGiveback = closes.length
    ? givebackSum / closes.length
    : 0;

  return {
    exitReasons: topN(exitReasons, 5),
    avgGiveback,
  };
}

/* ================= OPTIMIZER ================= */

function generateTopFixes({ bottlenecks, trades }) {
  const fixes = [];

  const topFail = bottlenecks.topChecklistFails[0]?.key;

  if (topFail) {
    fixes.push({
      title: "Grootste filter bottleneck",
      action: `Versoepel "${topFail}"`,
      impact: "Meer ELITE coins → hogere winrate"
    });
  }

  if (trades.avgGiveback > 1.5) {
    fixes.push({
      title: "Te veel giveback",
      action: "Trailing TP strakker maken na TP1",
      impact: "Meer winst per trade"
    });
  }

  const exit = trades.exitReasons[0]?.key;
  if (exit === "HARD_STOP") {
    fixes.push({
      title: "Te veel stops",
      action: "Stop iets ruimer of entry strenger",
      impact: "Minder verliezen"
    });
  }

  return fixes.slice(0, 5);
}

/* ================= TABLE ================= */

function coinRow(c) {
  const ex = c.execution || {};
  const chk = ex.checklist || {};

  return `
    <tr>
      <td><b>${esc(c.symbol)}</b></td>
      <td>${esc(c._stage)}</td>
      <td>${n(c.perfectCandidateScore)}</td>
      <td>${n(c.entryQuality)}</td>
      <td>${n(c.persistenceScore)}</td>
      <td>${esc(c.tradeDeskStatus || "-")}</td>
      <td>
        ${Object.entries(chk)
          .map(([k, v]) => `<div>${k}: ${v ? "✅" : "❌"}</div>`)
          .join("")}
      </td>
    </tr>
  `;
}

function stageTable(name, coins) {
  return `
    <h2>${name} (${coins.length})</h2>
    <table>
      <tr>
        <th>Coin</th>
        <th>Stage</th>
        <th>Perfect</th>
        <th>Entry</th>
        <th>Persistence</th>
        <th>Status</th>
        <th>Checklist</th>
      </tr>
      ${coins.map(coinRow).join("")}
    </table>
  `;
}

/* ================= PAGE ================= */

function page({ coins, bottlenecks, trades, fixes }) {
  const byStage = {
    RADAR: coins.filter(c => c._stage === "RADAR"),
    BUILDUP: coins.filter(c => c._stage === "BUILDUP"),
    ALMOST: coins.filter(c => c._stage === "ALMOST"),
    ELITE_IGNITION: coins.filter(c => c._stage === "ELITE_IGNITION"),
    ELITE_EXPANSION: coins.filter(c => c._stage === "ELITE_EXPANSION"),
  };

  return `
  <html>
  <body style="background:#0b0f14;color:white;font-family:sans-serif;padding:20px">

    <h1>🔥 ANALYZE PRO</h1>

    <h2>Top 5 verbeteringen</h2>
    <ul>
      ${fixes.map(f => `
        <li>
          <b>${f.title}</b><br/>
          ${f.action}<br/>
          <span style="color:#9fb0c3">${f.impact}</span>
        </li>
      `).join("")}
    </ul>

    <h2>Bottlenecks</h2>
    <pre>${JSON.stringify(bottlenecks, null, 2)}</pre>

    <h2>Trades</h2>
    <pre>${JSON.stringify(trades, null, 2)}</pre>

    ${stageTable("RADAR", byStage.RADAR)}
    ${stageTable("BUILDUP", byStage.BUILDUP)}
    ${stageTable("ALMOST", byStage.ALMOST)}
    ${stageTable("ELITE_IGNITION", byStage.ELITE_IGNITION)}
    ${stageTable("ELITE_EXPANSION", byStage.ELITE_EXPANSION)}

  </body>
  </html>
  `;
}

/* ================= HANDLER ================= */

export default async function handler(req, res) {
  if (!requireSecret(req, res)) return;

  const [bull, events] = await Promise.all([
    kv.get("latest:bull"),
    readEvents("main", 5000),
  ]);

  const coins = flattenCoins(bull);
  const bottlenecks = analyzeBottlenecks(coins);
  const trades = analyzeTrades(events);
  const fixes = generateTopFixes({ bottlenecks, trades });

  res.setHeader("content-type", "text/html");
  res.end(page({ coins, bottlenecks, trades, fixes }));
}