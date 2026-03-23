import { kv } from "@vercel/kv";
import { readEvents } from "../lib/_analytics.js";
import { requireSecret, RUNTIME_CONFIG } from "../lib/_runtime.js";
import * as moonCore from "../lib/_moon_core.js";

export const config = RUNTIME_CONFIG;

// =============================
// SAFE KEY FALLBACKS
// =============================
const keyMainLatest =
  moonCore.keyMainLatest || ((mode) => `latest:${String(mode || "bull").toLowerCase()}`);
const keyMoonLatest =
  moonCore.keyMoonLatest || ((mode) => `moon:latest:${String(mode || "bull").toLowerCase()}`);
const keyMoonDiagList =
  moonCore.keyMoonDiagList || ((mode) => `moon:diag:${String(mode || "bull").toLowerCase()}`);
const keyMoonPositions =
  moonCore.keyMoonPositions || ((mode) => `moon:positions:${String(mode || "bull").toLowerCase()}`);

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

function safeObj(x) {
  return x && typeof x === "object" ? x : {};
}

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fmtDate(ms) {
  const d = new Date(Number(ms || 0));
  if (!Number.isFinite(d.getTime())) return "n/a";
  return d.toLocaleString("nl-NL", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function inc(map, key, add = 1) {
  const k = String(key || "unknown");
  map[k] = (map[k] || 0) + add;
}

function avg(arr) {
  const vals = safeArr(arr).map((x) => n(x, NaN)).filter(Number.isFinite);
  if (!vals.length) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function scoreClass(score10) {
  if (score10 >= 8) return "good";
  if (score10 >= 6) return "warn";
  return "bad";
}

function scoreLabel(score10) {
  if (score10 >= 8) return "perfect";
  if (score10 >= 6) return "bijna goed";
  return "probleem";
}

function toScore10(pct100) {
  const s = Math.max(0, Math.min(10, n(pct100, 0) / 10));
  return Math.round(s * 10) / 10;
}

function safeStage(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x;
  if (typeof x === "object") return Object.values(x);
  return [];
}

function flattenMainCoins(latest) {
  const f = latest?.funnel || {};
  return [
    ...safeStage(f.radar).map((c) => ({ ...c, _stage: c?.stage || "RADAR" })),
    ...safeStage(f.buildup).map((c) => ({ ...c, _stage: c?.stage || "BUILDUP" })),
    ...safeStage(f.almost).map((c) => ({ ...c, _stage: c?.stage || "ALMOST" })),
    ...safeStage(f.entry).map((c) => ({ ...c, _stage: c?.stage || "ENTRY" })),
    ...safeStage(f.elite_ignition).map((c) => ({ ...c, _stage: c?.stage || "ELITE_IGNITION" })),
    ...safeStage(f.elite_expansion).map((c) => ({ ...c, _stage: c?.stage || "ELITE_EXPANSION" })),
    ...safeStage(f.elite_cascade).map((c) => ({ ...c, _stage: c?.stage || "ELITE_CASCADE" })),
    ...safeStage(f.hold).map((c) => ({ ...c, _stage: c?.stage || "HOLD" })),
  ];
}

function flattenMoonCoins(latest) {
  const f = latest?.funnel || {};
  return [
    ...safeStage(f.radar).map((c) => ({ ...c, _stage: c?.stage || "RADAR" })),
    ...safeStage(f.buildup).map((c) => ({ ...c, _stage: c?.stage || "BUILDUP" })),
    ...safeStage(f.almost).map((c) => ({ ...c, _stage: c?.stage || "ALMOST" })),
    ...safeStage(f.entry).map((c) => ({ ...c, _stage: c?.stage || "ENTRY" })),
    ...safeStage(f.elite_ignition).map((c) => ({ ...c, _stage: c?.stage || "ELITE_IGNITION" })),
    ...safeStage(f.elite_expansion).map((c) => ({ ...c, _stage: c?.stage || "ELITE_EXPANSION" })),
    ...safeStage(f.elite_cascade).map((c) => ({ ...c, _stage: c?.stage || "ELITE_CASCADE" })),
    ...safeStage(f.hold).map((c) => ({ ...c, _stage: c?.stage || "HOLD" })),
  ];
}

// =============================
// BOTTLENECK ANALYSIS
// =============================
function analyzeCoinBottlenecks(coin) {
  const out = [];
  const advice = [];

  const timingScore = n(coin?.timingScore, 0);
  const liquidityScore = n(coin?.liquidityScore, 0);
  const qualityScore = n(coin?.qualityScore, 0);
  const marketScore = n(coin?.marketScore, 0);
  const eq = n(coin?.entryQuality, 0);
  const ps = n(coin?.persistenceScore, 0);
  const obScore = n(coin?.ob?.score, 0);
  const spreadPct = n(coin?.ob?.spreadPct, 999);
  const depth = n(coin?.ob?.depthMinUsd1p, 0);
  const breakoutReady = !!coin?.breakout?.ready;
  const breakoutPressure = n(coin?.breakout?.pressure, 0);
  const status = String(coin?.tradeDeskStatus || "UNKNOWN").toUpperCase();
  const exReason = String(coin?.execution?.reason || "").toLowerCase();

  if (timingScore < 60 || (!breakoutReady && breakoutPressure < 55)) {
    out.push("timing faalt");
    advice.push("Wacht op breakout + volume confirmatie");
  }

  if (liquidityScore < 60 || spreadPct > 1.2 || depth < 2500) {
    out.push("liquidity bottleneck");
    advice.push("Focus op coins met sterkere depth en lagere spread");
  }

  if (qualityScore < 60 || eq < 60 || ps < 55) {
    out.push("kwaliteit te laag");
    advice.push("Alleen high conviction setups doorlaten");
  }

  if (marketScore < 45) {
    out.push("markt tegen");
    advice.push("Trade meer met BTC trend en regime mee");
  }

  if (status === "WATCH") {
    out.push("blijft hangen in watch");
    advice.push("Verlaag entry-frictie pas als kwaliteit en timing stabiel zijn");
  }

  if (status === "IGNORE") {
    out.push("komt niet door trade desk");
    advice.push("Check strengste execution filters en drempels");
  }

  if (exReason.includes("breakout")) {
    out.push("breakout niet sterk genoeg");
    advice.push("Verlaag breakout eis licht of wacht op sterkere pressure");
  }

  if (exReason.includes("liquidity") || exReason.includes("depth") || exReason.includes("spread")) {
    out.push("execution blokkeert op liquiditeit");
    advice.push("Verlaag spread/depth filter licht of trade alleen diepere coins");
  }

  if (Math.abs(obScore) < 0.008) {
    out.push("orderbook overtuigt niet");
    advice.push("Wacht op sterker orderbook voordeel");
  }

  return {
    bottlenecks: Array.from(new Set(out)),
    advice: Array.from(new Set(advice)),
  };
}

function summarizeProblemCoins(coins, sectionName) {
  const list = [];
  const counters = {
    timing: 0,
    liquidity: 0,
    quality: 0,
    market: 0,
    watch: 0,
    ignored: 0,
  };

  for (const coin of safeArr(coins)) {
    const b = analyzeCoinBottlenecks(coin);
    const scoreRaw = avg([
      n(coin?.timingScore, 0),
      n(coin?.liquidityScore, 0),
      n(coin?.qualityScore, 0),
      n(coin?.marketScore, 0),
    ]);

    const score = toScore10(scoreRaw);

    if (!b.bottlenecks.length) continue;

    for (const x of b.bottlenecks) {
      const t = x.toLowerCase();
      if (t.includes("timing")) counters.timing++;
      if (t.includes("liquidity")) counters.liquidity++;
      if (t.includes("kwaliteit")) counters.quality++;
      if (t.includes("markt")) counters.market++;
      if (t.includes("watch")) counters.watch++;
      if (t.includes("trade desk")) counters.ignored++;
    }

    list.push({
      id: `${sectionName}:${coin?.symbol || "unknown"}`,
      symbol: coin?.symbol || "UNKNOWN",
      stage: coin?.stage || coin?._stage || "-",
      score,
      scoreRaw,
      bottlenecks: b.bottlenecks,
      advice: b.advice,
      tradeDeskStatus: coin?.tradeDeskStatus || "-",
      entryQuality: n(coin?.entryQuality, 0),
      persistenceScore: n(coin?.persistenceScore, 0),
      timingScore: n(coin?.timingScore, 0),
      liquidityScore: n(coin?.liquidityScore, 0),
      qualityScore: n(coin?.qualityScore, 0),
      marketScore: n(coin?.marketScore, 0),
    });
  }

  list.sort((a, b) => a.score - b.score || a.symbol.localeCompare(b.symbol));

  return { problems: list.slice(0, 24), counters };
}

function analyzeTrades(events) {
  const closes = safeArr(events);
  const out = {
    totalTrades: closes.length,
    avgGiveback: 0,
    reasons: {},
    problems: [],
    counters: {
      timing: 0,
      liquidity: 0,
      quality: 0,
      market: 0,
    },
  };

  if (!closes.length) return out;

  let givebackSum = 0;

  for (const t of closes) {
    const reason = String(t?.reason || "UNKNOWN");
    inc(out.reasons, reason);

    const max = n(t?.maxPnlPct, 0);
    const pnl = n(t?.pnlPct, 0);
    const giveback = Math.max(0, max - pnl);
    givebackSum += giveback;

    const bottlenecks = [];
    const advice = [];

    if (giveback > 1.5) {
      bottlenecks.push("timing exit te laat");
      advice.push("Trailing TP strakker na TP1");
      out.counters.timing++;
    }

    if (/slippage|spread|depth|liquid/i.test(reason)) {
      bottlenecks.push("liquidity exit probleem");
      advice.push("Trade alleen coins met betere liquiditeit");
      out.counters.liquidity++;
    }

    if (/timeout|weak|quality|invalid/i.test(reason)) {
      bottlenecks.push("kwaliteit setup zwak");
      advice.push("Laat zwakke setups sneller los");
      out.counters.quality++;
    }

    if (/btc|market|regime/i.test(reason)) {
      bottlenecks.push("markt tegen trade");
      advice.push("Filter harder op BTC/regime");
      out.counters.market++;
    }

    if (bottlenecks.length) {
      out.problems.push({
        id: `trade:${t?.id || Math.random().toString(36).slice(2)}`,
        symbol: t?.symbol || "UNKNOWN",
        stage: t?.stage || "TRADE",
        score: toScore10(Math.max(0, 100 - giveback * 20)),
        bottlenecks: Array.from(new Set(bottlenecks)),
        advice: Array.from(new Set(advice)),
      });
    }
  }

  out.avgGiveback = closes.length ? givebackSum / closes.length : 0;
  out.problems.sort((a, b) => a.score - b.score);
  out.problems = out.problems.slice(0, 20);

  return out;
}

function buildAutoInsights(payload) {
  const totalProblems =
    safeArr(payload?.main?.problems).length +
    safeArr(payload?.moon?.bull?.problems).length +
    safeArr(payload?.moon?.bear?.problems).length +
    safeArr(payload?.trade?.problems).length;

  const totalBottlenecks = {
    timing:
      n(payload?.main?.counters?.timing, 0) +
      n(payload?.moon?.bull?.counters?.timing, 0) +
      n(payload?.moon?.bear?.counters?.timing, 0) +
      n(payload?.trade?.counters?.timing, 0),
    liquidity:
      n(payload?.main?.counters?.liquidity, 0) +
      n(payload?.moon?.bull?.counters?.liquidity, 0) +
      n(payload?.moon?.bear?.counters?.liquidity, 0) +
      n(payload?.trade?.counters?.liquidity, 0),
    quality:
      n(payload?.main?.counters?.quality, 0) +
      n(payload?.moon?.bull?.counters?.quality, 0) +
      n(payload?.moon?.bear?.counters?.quality, 0) +
      n(payload?.trade?.counters?.quality, 0),
    market:
      n(payload?.main?.counters?.market, 0) +
      n(payload?.moon?.bull?.counters?.market, 0) +
      n(payload?.moon?.bear?.counters?.market, 0) +
      n(payload?.trade?.counters?.market, 0),
  };

  const denom = Math.max(
    1,
    totalBottlenecks.timing +
      totalBottlenecks.liquidity +
      totalBottlenecks.quality +
      totalBottlenecks.market
  );

  const pct = (x) => Math.round((n(x, 0) / denom) * 100);

  return [
    {
      label: `${pct(totalBottlenecks.timing)}% faalt op timing`,
      advice: "Wacht vaker op breakout + volume confirmatie",
      severity: scoreClass(toScore10(100 - pct(totalBottlenecks.timing))),
    },
    {
      label: `${pct(totalBottlenecks.liquidity)}% liquidity grootste bottleneck`,
      advice: "Focus op sterkere depth en lagere spread",
      severity: scoreClass(toScore10(100 - pct(totalBottlenecks.liquidity))),
    },
    {
      label: `${pct(totalBottlenecks.quality)}% kwaliteit onder drempel`,
      advice: "Laat alleen high conviction setups door",
      severity: scoreClass(toScore10(100 - pct(totalBottlenecks.quality))),
    },
    {
      label: `${pct(totalBottlenecks.market)}% markt werkt tegen`,
      advice: "Trade strakker met BTC trend/regime mee",
      severity: scoreClass(toScore10(100 - pct(totalBottlenecks.market))),
    },
    {
      label: `${totalProblems} probleemkaarten gedetecteerd`,
      advice: "Los de grootste bottleneck eerst per funnel op",
      severity: totalProblems > 20 ? "bad" : totalProblems > 8 ? "warn" : "good",
    },
  ];
}

// =============================
// DATA READERS
// =============================
async function readMoonDiags(mode) {
  try {
    if (typeof kv.lrange !== "function") return [];
    const raw = await kv.lrange(keyMoonDiagList(mode), 0, 24);
    return (raw || [])
      .map((x) => {
        try {
          return typeof x === "string" ? JSON.parse(x) : x;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function readMoonPositions(mode) {
  try {
    const p = await kv.get(keyMoonPositions(mode));
    return { open: p?.open || [], closed: p?.closed || [] };
  } catch {
    return { open: [], closed: [] };
  }
}

// =============================
// HTML RENDERERS
// =============================
function renderMetricCard(title, value, sub, score10) {
  const cls = scoreClass(score10);
  return `
    <div class="metric ${cls}">
      <div class="metric-title">${esc(title)}</div>
      <div class="metric-value">${esc(value)}</div>
      <div class="metric-sub">${esc(sub || "")}</div>
    </div>
  `;
}

function renderInsightCard(x) {
  return `
    <div class="insight ${esc(x.severity || "warn")}">
      <div class="insight-label">${esc(x.label)}</div>
      <div class="insight-advice">${esc(x.advice)}</div>
    </div>
  `;
}

function renderProblemCard(c) {
  const cls = scoreClass(c.score);
  return `
    <div class="problem ${cls}">
      <div class="problem-head">
        <div>
          <div class="problem-symbol">${esc(c.symbol)}</div>
          <div class="problem-stage">${esc(c.stage)}</div>
        </div>
        <div class="score-pill ${cls}">
          ${esc(c.score.toFixed(1))}/10
        </div>
      </div>

      <div class="mini-grid">
        <div><span>Timing</span><b>${esc(String(n(c.timingScore, 0)))}</b></div>
        <div><span>Liquidity</span><b>${esc(String(n(c.liquidityScore, 0)))}</b></div>
        <div><span>Quality</span><b>${esc(String(n(c.qualityScore, 0)))}</b></div>
        <div><span>Market</span><b>${esc(String(n(c.marketScore, 0)))}</b></div>
      </div>

      <div class="label">Bottlenecks</div>
      <ul class="danger-list">
        ${safeArr(c.bottlenecks).map((x) => `<li>${esc(x)}</li>`).join("") || "<li>n/a</li>"}
      </ul>

      <div class="label">Advies</div>
      <ul class="good-list">
        ${safeArr(c.advice).map((x) => `<li>${esc(x)}</li>`).join("") || "<li>n/a</li>"}
      </ul>
    </div>
  `;
}

function renderSection(title, subtitle, problems) {
  const items = safeArr(problems);
  return `
    <section class="section">
      <div class="section-head">
        <div>
          <h2>${esc(title)}</h2>
          <div class="section-sub">${esc(subtitle || "")}</div>
        </div>
        <div class="section-count">${items.length} problemen</div>
      </div>

      ${
        items.length
          ? `<div class="problems-grid">${items.map(renderProblemCard).join("")}</div>`
          : `<div class="empty">Geen problemen gevonden 🚀</div>`
      }
    </section>
  `;
}

function htmlPage(payload) {
  const insights = safeArr(payload?.insights);

  const healthCards = [
    renderMetricCard(
      "Main health",
      `${n(payload?.summary?.mainAvg, 0).toFixed(1)}/10`,
      scoreLabel(n(payload?.summary?.mainAvg, 0)),
      n(payload?.summary?.mainAvg, 0)
    ),
    renderMetricCard(
      "Moon bull health",
      `${n(payload?.summary?.moonBullAvg, 0).toFixed(1)}/10`,
      scoreLabel(n(payload?.summary?.moonBullAvg, 0)),
      n(payload?.summary?.moonBullAvg, 0)
    ),
    renderMetricCard(
      "Moon bear health",
      `${n(payload?.summary?.moonBearAvg, 0).toFixed(1)}/10`,
      scoreLabel(n(payload?.summary?.moonBearAvg, 0)),
      n(payload?.summary?.moonBearAvg, 0)
    ),
    renderMetricCard(
      "Trade health",
      `${n(payload?.summary?.tradeAvg, 0).toFixed(1)}/10`,
      `avg giveback ${n(payload?.trade?.avgGiveback, 0).toFixed(2)}%`,
      n(payload?.summary?.tradeAvg, 0)
    ),
  ].join("");

  return `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Analyze All Dashboard</title>
  <style>
    :root{
      --bg:#070b11;
      --panel:#111826;
      --panel2:#0c1320;
      --line:#1f2a3a;
      --text:#e6edf3;
      --muted:#9fb0c3;
      --green:#22c55e;
      --yellow:#facc15;
      --red:#ef4444;
      --shadow:0 10px 30px rgba(0,0,0,.25);
      --radius:16px;
    }
    *{box-sizing:border-box}
    body{
      margin:0;
      padding:24px;
      background:linear-gradient(180deg,#070b11 0%,#0a111b 100%);
      color:var(--text);
      font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    }
    .wrap{max-width:1440px;margin:0 auto}
    .topbar{
      display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap;
      margin-bottom:22px;
    }
    .title h1{margin:0;font-size:32px;line-height:1.1}
    .title p{margin:6px 0 0;color:var(--muted)}
    .meta{
      display:grid;gap:8px;
      background:rgba(17,24,38,.8);
      border:1px solid var(--line);
      border-radius:14px;padding:12px 14px;
      min-width:280px;
      box-shadow:var(--shadow);
    }
    .meta b{color:#fff}
    .metrics{
      display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-bottom:18px;
    }
    .metric{
      border:1px solid var(--line);
      background:linear-gradient(180deg,var(--panel) 0%,#0f1724 100%);
      border-radius:var(--radius);
      padding:16px;
      box-shadow:var(--shadow);
    }
    .metric.good{outline:1px solid rgba(34,197,94,.25)}
    .metric.warn{outline:1px solid rgba(250,204,21,.22)}
    .metric.bad{outline:1px solid rgba(239,68,68,.22)}
    .metric-title{color:var(--muted);font-size:13px;margin-bottom:10px}
    .metric-value{font-size:30px;font-weight:800}
    .metric-sub{margin-top:8px;color:var(--muted);text-transform:capitalize}
    .insights{
      display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-bottom:24px;
    }
    .insight{
      background:linear-gradient(180deg,var(--panel) 0%,#101722 100%);
      border:1px solid var(--line);
      border-left-width:5px;
      border-radius:14px;
      padding:16px;
      box-shadow:var(--shadow);
    }
    .insight.good{border-left-color:var(--green)}
    .insight.warn{border-left-color:var(--yellow)}
    .insight.bad{border-left-color:var(--red)}
    .insight-label{font-weight:700;margin-bottom:6px}
    .insight-advice{color:var(--muted)}
    .section{
      background:rgba(17,24,38,.72);
      border:1px solid var(--line);
      border-radius:20px;
      padding:18px;
      margin-bottom:20px;
      box-shadow:var(--shadow);
    }
    .section-head{
      display:flex;justify-content:space-between;align-items:flex-start;gap:12px;
      margin-bottom:16px;flex-wrap:wrap;
    }
    .section h2{margin:0;font-size:22px}
    .section-sub{color:var(--muted);margin-top:5px}
    .section-count{
      padding:8px 12px;border-radius:999px;background:#0b1320;border:1px solid var(--line);
      color:var(--muted);font-size:13px;
    }
    .problems-grid{
      display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;
    }
    .problem{
      background:linear-gradient(180deg,var(--panel2) 0%,#0a111a 100%);
      border:1px solid var(--line);
      border-radius:16px;
      padding:15px;
    }
    .problem.good{outline:1px solid rgba(34,197,94,.22)}
    .problem.warn{outline:1px solid rgba(250,204,21,.22)}
    .problem.bad{outline:1px solid rgba(239,68,68,.22)}
    .problem-head{
      display:flex;justify-content:space-between;gap:10px;align-items:flex-start;margin-bottom:12px;
    }
    .problem-symbol{font-size:18px;font-weight:800}
    .problem-stage{font-size:12px;color:var(--muted);margin-top:3px}
    .score-pill{
      min-width:68px;text-align:center;padding:8px 10px;border-radius:12px;font-weight:800;color:#081018;
    }
    .score-pill.good{background:var(--green)}
    .score-pill.warn{background:var(--yellow)}
    .score-pill.bad{background:var(--red);color:#fff}
    .mini-grid{
      display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-bottom:12px;
    }
    .mini-grid div{
      display:flex;justify-content:space-between;gap:8px;
      background:#0a1220;border:1px solid #1b2636;border-radius:10px;padding:8px 10px;
    }
    .mini-grid span{color:var(--muted);font-size:12px}
    .mini-grid b{font-size:13px}
    .label{
      color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.08em;
      margin:10px 0 6px;
    }
    ul{margin:0;padding-left:18px}
    li{margin:4px 0}
    .danger-list li{color:#fca5a5}
    .good-list li{color:#86efac}
    .empty{
      border:1px dashed #284055;
      border-radius:14px;
      padding:18px;
      color:#86efac;
      background:#091118;
    }
    .footer{
      margin-top:22px;color:var(--muted);font-size:13px;text-align:center;
    }
    @media (max-width: 1100px){
      .metrics,.problems-grid,.insights{grid-template-columns:repeat(2,minmax(0,1fr))}
    }
    @media (max-width: 720px){
      body{padding:14px}
      .metrics,.problems-grid,.insights{grid-template-columns:1fr}
      .title h1{font-size:26px}
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="topbar">
      <div class="title">
        <h1>🚀 CryptoCroc Advanced Analyze Dashboard</h1>
        <p>Alles op 1 pagina: main funnel, moon funnel en trade funnel — met bottlenecks, scores en adviezen.</p>
      </div>
      <div class="meta">
        <div><b>Generated:</b> ${esc(fmtDate(payload?.ts))}</div>
        <div><b>Main bull latest:</b> ${esc(fmtDate(payload?.latest?.mainBullTs))}</div>
        <div><b>Main bear latest:</b> ${esc(fmtDate(payload?.latest?.mainBearTs))}</div>
        <div><b>Moon bull latest:</b> ${esc(fmtDate(payload?.latest?.moonBullTs))}</div>
        <div><b>Moon bear latest:</b> ${esc(fmtDate(payload?.latest?.moonBearTs))}</div>
      </div>
    </div>

    <div class="metrics">${healthCards}</div>

    <section class="section">
      <div class="section-head">
        <div>
          <h2>🔥 Auto Insights</h2>
          <div class="section-sub">Automatische diagnose van waar het systeem het vaakst vastloopt.</div>
        </div>
      </div>
      <div class="insights">
        ${insights.map(renderInsightCard).join("")}
      </div>
    </section>

    ${renderSection("📊 MAIN Funnel", "Top bottlenecks uit latest main bull + bear snapshots", payload?.main?.problems)}
    ${renderSection("🌙 MOON Bull Funnel", "Top bottlenecks uit latest moon bull snapshot", payload?.moon?.bull?.problems)}
    ${renderSection("🌙 MOON Bear Funnel", "Top bottlenecks uit latest moon bear snapshot", payload?.moon?.bear?.problems)}
    ${renderSection("💰 TRADE Funnel", "Top bottlenecks uit trade_closed events", payload?.trade?.problems)}

    <div class="footer">
      Dashboard draait volledig via <b>/api/analyze-all</b>. Gebruik <b>?format=json</b> voor JSON output.
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
      moonBullDiags,
      moonBearDiags,
      moonBullPos,
      moonBearPos,
    ] = await Promise.all([
      kv.get(keyMainLatest("bull")),
      kv.get(keyMainLatest("bear")),
      kv.get(keyMoonLatest("bull")),
      kv.get(keyMoonLatest("bear")),
      readEvents("trade_closed", 4000).catch(() => []),
      readMoonDiags("bull"),
      readMoonDiags("bear"),
      readMoonPositions("bull"),
      readMoonPositions("bear"),
    ]);

    const mainCoins = [
      ...flattenMainCoins(mainBullLatest),
      ...flattenMainCoins(mainBearLatest),
    ];

    const moonBullCoins = flattenMoonCoins(moonBullLatest);
    const moonBearCoins = flattenMoonCoins(moonBearLatest);

    const main = summarizeProblemCoins(mainCoins, "main");
    const moonBull = summarizeProblemCoins(moonBullCoins, "moon-bull");
    const moonBear = summarizeProblemCoins(moonBearCoins, "moon-bear");
    const trade = analyzeTrades(tradeClosed);

    const payload = {
      ok: true,
      ts: Date.now(),
      latest: {
        mainBullTs: mainBullLatest?.ts || mainBullLatest?.scannedAt || null,
        mainBearTs: mainBearLatest?.ts || mainBearLatest?.scannedAt || null,
        moonBullTs: moonBullLatest?.ts || moonBullLatest?.scannedAt || null,
        moonBearTs: moonBearLatest?.ts || moonBearLatest?.scannedAt || null,
      },
      main,
      moon: {
        bull: {
          ...moonBull,
          diagCount: safeArr(moonBullDiags).length,
          positions: {
            open: safeArr(moonBullPos?.open).length,
            closed: safeArr(moonBullPos?.closed).length,
          },
        },
        bear: {
          ...moonBear,
          diagCount: safeArr(moonBearDiags).length,
          positions: {
            open: safeArr(moonBearPos?.open).length,
            closed: safeArr(moonBearPos?.closed).length,
          },
        },
      },
      trade,
      summary: {
        mainAvg: avg(safeArr(main.problems).map((x) => x.score)),
        moonBullAvg: avg(safeArr(moonBull.problems).map((x) => x.score)),
        moonBearAvg: avg(safeArr(moonBear.problems).map((x) => x.score)),
        tradeAvg: avg(safeArr(trade.problems).map((x) => x.score)),
      },
    };

    payload.insights = buildAutoInsights(payload);

    if (String(req.query?.format || "").toLowerCase() === "json") {
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      return res.status(200).json(payload);
    }

    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.status(200).end(htmlPage(payload));
  } catch (err) {
    console.error("analyze-all error:", err);
    return res.status(500).json({
      ok: false,
      error: String(err?.message || err),
    });
  }
}