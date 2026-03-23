import { kv } from "@vercel/kv";
import { readEvents } from "../lib/_analytics.js";
import { requireSecret, RUNTIME_CONFIG } from "../lib/_runtime.js";
import * as moonCore from "../lib/_moon_core.js";

export const config = RUNTIME_CONFIG;

// =============================
// KEYS
// =============================
const keyMainLatest =
  moonCore.keyMainLatest || ((mode) => `latest:${String(mode || "bull")}`);
const keyMoonLatest =
  moonCore.keyMoonLatest || ((mode) => `moon:latest:${String(mode || "bull")}`);
const keyMoonDiagList =
  moonCore.keyMoonDiagList || ((mode) => `moon:diag:${String(mode || "bull")}`);
const keyMoonPositions =
  moonCore.keyMoonPositions || ((mode) => `moon:positions:${String(mode || "bull")}`);

// =============================
// HELPERS
// =============================
const n = (x, d = 0) => (Number.isFinite(Number(x)) ? Number(x) : d);
const safeArr = (x) => (Array.isArray(x) ? x : []);
const avg = (arr) => {
  const v = safeArr(arr).map(Number).filter(Number.isFinite);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
};

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function fmtDate(ms) {
  const d = new Date(Number(ms || 0));
  return Number.isFinite(d.getTime())
    ? d.toLocaleString("nl-NL")
    : "n/a";
}

function scoreClass(s) {
  if (s >= 8) return "good";
  if (s >= 6) return "warn";
  return "bad";
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
// BOTTLENECKS
// =============================
function analyzeCoin(c) {
  const out = [];
  const adv = [];

  if (n(c.timingScore) < 60) {
    out.push("timing");
    adv.push("Wacht op breakout + volume confirmatie");
  }

  if (n(c.liquidityScore) < 60) {
    out.push("liquidity");
    adv.push("Focus op coins met betere depth/spread");
  }

  if (n(c.qualityScore) < 60) {
    out.push("quality");
    adv.push("Alleen high conviction setups");
  }

  if (n(c.marketScore) < 45) {
    out.push("market");
    adv.push("Trade met BTC trend mee");
  }

  return { out, adv };
}

// =============================
// TOP 5 ENGINE
// =============================
function buildTop5(list) {
  const map = {};

  for (const c of list) {
    const a = analyzeCoin(c);
    for (const adv of a.adv) {
      map[adv] = (map[adv] || 0) + 1;
    }
  }

  return Object.entries(map)
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
}

// =============================
// SECTION RENDER
// =============================
function renderSection(title, data) {
  const top5 = buildTop5(data);

  return `
  <div class="section">
    <h2>${esc(title)}</h2>

    <div class="top5">
      ${top5
        .map(
          (x, i) => `
        <div class="card">
          <b>#${i + 1}</b>
          <div>${esc(x.text)}</div>
          <small>${x.count}x genoemd</small>
        </div>`
        )
        .join("")}
    </div>
  </div>`;
}

// =============================
// HTML
// =============================
function html(payload) {
  return `
  <html>
  <head>
    <style>
      body { font-family: sans-serif; background:#0b0f18; color:white; padding:20px }
      .section { margin-bottom:30px }
      .top5 { display:grid; gap:10px }
      .card { background:#111827; padding:15px; border-radius:10px }
    </style>
  </head>
  <body>

  <h1>🚀 Dashboard</h1>

  ${renderSection("📈 MAIN Bull", payload.main.bull)}
  ${renderSection("📉 MAIN Bear", payload.main.bear)}
  ${renderSection("🌙 MOON Bull", payload.moon.bull)}
  ${renderSection("🌙 MOON Bear", payload.moon.bear)}
  ${renderSection("💰 TRADE", payload.trade)}

  </body>
  </html>
  `;
}

// =============================
// MAIN
// =============================
export default async function handler(req, res) {
  if (!requireSecret(req, res)) return;

  const [
    mainBullLatest,
    mainBearLatest,
    moonBullLatest,
    moonBearLatest,
    trades,
  ] = await Promise.all([
    kv.get(keyMainLatest("bull")),
    kv.get(keyMainLatest("bear")),
    kv.get(keyMoonLatest("bull")),
    kv.get(keyMoonLatest("bear")),
    readEvents("trade_closed", 2000).catch(() => []),
  ]);

  const payload = {
    main: {
      bull: flatten(mainBullLatest),
      bear: flatten(mainBearLatest),
    },
    moon: {
      bull: flatten(moonBullLatest),
      bear: flatten(moonBearLatest),
    },
    trade: safeArr(trades),
  };

  if (req.query.format === "json") {
    return res.json(payload);
  }

  res.setHeader("content-type", "text/html");
  res.end(html(payload));
}