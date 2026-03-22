// /api/analyze-all.js
// Vereist: KV keys "latest:bull"/"latest:bear" + trade_closed events + Moon diag keys
import { kv } from "@vercel/kv";
import { readEvents } from "../lib/_analytics.js";
import { requireSecret, RUNTIME_CONFIG } from "../lib/_runtime.js";
import { keyMoonDiagList, keyMoonDiagSnap, keyMoonPositions } from "../lib/_moon_core.js";

// Helper voor main latest key
function keyMainLatest(mode) {
  return `latest:${String(mode || "bull").toLowerCase()}`;
}

export const config = RUNTIME_CONFIG;

// ===================== HELPERS =====================
function n(x, d = 0) { const v = Number(x); return Number.isFinite(v) ? v : d; }
function safeArr(x) { return Array.isArray(x) ? x : []; }
function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function inc(map, key) { const k = String(key || "unknown"); map[k] = (map[k] || 0) + 1; }
function topN(map, k = 12) {
  const arr = Object.entries(map || {}).map(([key, count]) => ({ key, count: n(count, 0) }));
  arr.sort((a, b) => b.count - a.count);
  return arr.slice(0, k);
}
function fmtDate(ms) {
  const d = new Date(Number(ms || 0));
  if (!Number.isFinite(d.getTime())) return "n/a";
  return d.toLocaleString("nl-NL", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}
function addCounts(to, from) {
  const out = to || {};
  const src = from || {};
  for (const k of Object.keys(src)) out[k] = (out[k] || 0) + n(src[k], 0);
  return out;
}

// ===================== ROBUSTE FLATTEN =====================
function safeStage(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x;
  if (typeof x === "object") return Object.values(x);
  return [];
}

function flattenMainCoins(latest) {
  const f = latest?.funnel || {};

  return [
    ...safeStage(f.radar).map(c => ({ ...c, _system: "main", _stage: c?.stage || "RADAR" })),
    ...safeStage(f.buildup).map(c => ({ ...c, _system: "main", _stage: c?.stage || "BUILDUP" })),
    ...safeStage(f.almost).map(c => ({ ...c, _system: "main", _stage: c?.stage || "ALMOST" })),
    ...safeStage(f.entry).map(c => ({ ...c, _system: "main", _stage: c?.stage || "ENTRY" })),
    ...safeStage(f.elite_ignition).map(c => ({ ...c, _system: "main", _stage: c?.stage || "ELITE_IGNITION" })),
    ...safeStage(f.elite_expansion).map(c => ({ ...c, _system: "main", _stage: c?.stage || "ELITE_EXPANSION" })),
    ...safeStage(f.elite_cascade).map(c => ({ ...c, _system: "main", _stage: c?.stage || "ELITE_CASCADE" })),
    ...safeStage(f.hold).map(c => ({ ...c, _system: "main", _stage: c?.stage || "HOLD" })),
  ];
}

function summarizeMainSnapshot(latest) {
  const coins = flattenMainCoins(latest || {});
  const stageCounts = { RADAR: 0, BUILDUP: 0, ALMOST: 0, ENTRY: 0, ELITE_IGNITION: 0, ELITE_EXPANSION: 0, ELITE_CASCADE: 0, HOLD: 0 };
  for (const c of coins) {
    const realStage = String(c?.stage || c?._stage || "RADAR").toUpperCase();
    if (stageCounts[realStage] !== undefined) stageCounts[realStage]++;
    else if (stageCounts[c?._stage] !== undefined) stageCounts[c._stage]++;
  }
  return { ts: latest?.ts || latest?.scannedAt || null, btc: latest?.btc || null, regime: latest?.regime || null, stageCounts };
}

function analyzeMainBottlenecks(coins) {
  const checklistFails = {};
  const tradeDeskStatusCounts = {};
  for (const c of coins) {
    const ex = c?.execution || {};
    const checklist = Array.isArray(ex.checklist) ? ex.checklist : [];
    inc(tradeDeskStatusCounts, c?.tradeDeskStatus || "UNKNOWN");
    for (const item of checklist) {
      let name = String(item?.name || "unknown").toLowerCase().replace(/\s+/g, "_");
      if (item?.ok === false) inc(checklistFails, name);
    }
  }
  return { topChecklistFails: topN(checklistFails, 8), tradeDeskStatusCounts: topN(tradeDeskStatusCounts, 8) };
}

function analyzeMainTrades(events, mode) {
  // events are already trade_closed stream
  const closes = safeArr(events).filter(e => {
    const modeOk = !mode || String(e?.mode || "").toLowerCase() === String(mode).toLowerCase();
    return modeOk;
  });

  const exitReasons = {};
  let givebackSum = 0;

  for (const t of closes) {
    inc(exitReasons, t?.reason || "UNKNOWN");
    const max = n(t?.maxPnlPct, 0);
    const pnl = n(t?.pnlPct, 0);
    givebackSum += Math.max(0, max - pnl);
  }

  const avgGiveback = closes.length ? givebackSum / closes.length : 0;
  return { exitReasons: topN(exitReasons, 8), avgGiveback, totalTrades: closes.length };
}

// ===================== MOON DATA FUNCTIONS =====================
async function readMoonDiags(mode, limit = 20) {
  try {
    const key = keyMoonDiagList(mode);
    if (typeof kv.lrange === "function") {
      const raw = await kv.lrange(key, 0, Math.max(0, limit - 1));
      return (raw || []).map(x => { try { return typeof x === "string" ? JSON.parse(x) : x; } catch { return null; } }).filter(Boolean);
    }
    const snap = await kv.get(keyMoonDiagSnap(mode));
    return snap ? [snap] : [];
  } catch { return []; }
}

function summarizeMoonDiags(diags) {
  const s = { scans: diags.length, lastTs: diags[0]?.ts || null, avg: { radar: 0, buildup: 0, almost: 0, elite: 0 }, totals: { eliteWhy: {}, eliteExtraFail: {} } };
  if (!diags.length) return s;
  let sr=0, sb=0, sa=0, se=0;
  for (const d of diags) {
    const c = d?.counts || {};
    sr += n(c.radar,0); sb += n(c.buildup,0); sa += n(c.almost,0); se += n(c.elite,0);
    const r = d?.reasons || {};
    s.totals.eliteWhy = addCounts(s.totals.eliteWhy, r.eliteWhy);
    s.totals.eliteExtraFail = addCounts(s.totals.eliteExtraFail, r.eliteExtraFail);
  }
  const k = diags.length || 1;
  s.avg = { radar: +(sr/k).toFixed(2), buildup: +(sb/k).toFixed(2), almost: +(sa/k).toFixed(2), elite: +(se/k).toFixed(2) };
  return s;
}

async function readMoonPositions(mode) {
  try {
    const p = await kv.get(keyMoonPositions(mode));
    return { open: Array.isArray(p?.open) ? p.open : [], closed: Array.isArray(p?.closed) ? p.closed : [] };
  } catch { return { open: [], closed: [] }; }
}

function summarizeMoonTrades(positions) {
  const closed = positions.closed;
  const outMap = {};
  let wins = 0, losses = 0;
  for (const p of closed) {
    const kind = String(p?.exitKind || p?.closeKind || p?.kind || "").toUpperCase();
    if (kind === "SL") { losses++; outMap["SL"] = (outMap["SL"] || 0) + 1; }
    else if (kind === "TP" || kind === "TP1" || kind === "TP2" || kind === "TP3") { wins++; outMap[kind] = (outMap[kind] || 0) + 1; }
    else outMap["CLOSED"] = (outMap["CLOSED"] || 0) + 1;
  }
  const winrate = (wins+losses) ? ((wins/(wins+losses))*100).toFixed(1) : 0;
  return { counts: { open: positions.open.length, closed: closed.length }, outcomesTop: topN(outMap, 8), winrate };
}

// ===================== ADVICE =====================
function generateFilterAdvice(bottlenecks, tradeStats, systemName) {
  const advice = [];
  const topFail = bottlenecks?.topChecklistFails?.[0]?.key || "";
  if (topFail) {
    let suggestion = `Versoepel "${topFail}" licht voor ${systemName}`;
    let impact = "Meer coins komen door de funnel";
    if (/spread/i.test(topFail)) suggestion = `Maak spread-filter iets ruimer of beperk alleen in lagere liquidity bands voor ${systemName}`;
    else if (/depth/i.test(topFail)) suggestion = `Verlaag depth-eis licht of maak depth dynamischer per market cap voor ${systemName}`;
    else if (/persistence/i.test(topFail)) suggestion = `Verlaag persistence-drempel 2-4 punten voor stabiele WATCH-coins in ${systemName}`;
    else if (/entry_quality/i.test(topFail)) suggestion = `Verlaag entryQuality-drempel 2-3 punten voor ${systemName}`;
    else if (/btc_alignment/i.test(topFail)) suggestion = `Maak BTC alignment iets minder streng buiten crash/panic voor ${systemName}`;
    else if (/breakout/i.test(topFail)) suggestion = `Laat hoge breakout pressure eerder meetellen zonder full ready voor ${systemName}`;
    advice.push({ filter: topFail, issue: `Faalpercentage hoog (${bottlenecks.topChecklistFails[0].count} coins)`, suggestion, impact });
  }
  if (tradeStats.avgGiveback > 1.5) advice.push({ filter: "giveback", issue: `Gem. giveback ${tradeStats.avgGiveback.toFixed(2)}%`, suggestion: "Trailing TP strakker maken na eerste winstfase", impact: "Meer winst vasthouden per trade" });
  const exit = tradeStats.exitReasons?.[0]?.key;
  if (exit === "HARD_STOP" || exit === "SL") advice.push({ filter: "stop loss", issue: "Veel stop-loss exits", suggestion: "Maak entry iets strenger of SL iets ruimer", impact: "Minder onnodige verliestrades" });
  return advice.slice(0, 3);
}

function mergeTopAdvice(sections) {
  const all = sections.flat().filter(Boolean);
  const scored = all.map(a => {
    let score = 0;
    if (/Meer winst/i.test(a.impact)) score += 3;
    if (/Minder verlies/i.test(a.impact)) score += 3;
    if (/Meer ELITE/i.test(a.impact)) score += 2;
    if (/Meer entries/i.test(a.impact)) score += 2;
    if (/giveback/i.test(a.filter)) score += 2;
    if (/stop/i.test(a.filter)) score += 2;
    return { ...a, _score: score };
  });
  scored.sort((a, b) => b._score - a._score);
  return scored.slice(0, 5);
}

// ===================== HTML RENDERING =====================
function renderSystemCard(title, data) {
  const listItems = (arr) => arr.map(x => `<li><b>${esc(x.key)}</b> — ${x.count}</li>`).join("") || "<li>n/a</li>";
  const adviceItems = data.advice.map(a => `<div class="advice-item"><b>${esc(a.filter)}</b><br/>${esc(a.issue)}<br/><span class="muted">➜ ${esc(a.suggestion)}</span><br/><span class="impact">💰 ${esc(a.impact)}</span></div>`).join("") || "<div class='muted'>Geen advies</div>";
  return `
    <div class="card">
      <h2>${title}</h2>
      <div class="stats">
        <span class="stat">RADAR: ${data.stageCounts.RADAR || 0}</span>
        <span class="stat">BUILDUP: ${data.stageCounts.BUILDUP || 0}</span>
        <span class="stat">ALMOST: ${data.stageCounts.ALMOST || 0}</span>
        <span class="stat">ENTRY: ${data.stageCounts.ENTRY || 0}</span>
        <span class="stat">ELITE: ${(data.stageCounts.ELITE_IGNITION||0)+(data.stageCounts.ELITE_EXPANSION||0)+(data.stageCounts.ELITE_CASCADE||0)}</span>
      </div>
      <div class="grid-2">
        <div class="box"><h3>Top faalfilters</h3><ul>${listItems(data.bottlenecks.topChecklistFails)}</ul></div>
        <div class="box"><h3>Trade stats</h3><ul><li>Trades: ${data.tradeStats.totalTrades}</li><li>Avg giveback: ${data.tradeStats.avgGiveback.toFixed(2)}%</li><li>Exit: ${listItems(data.tradeStats.exitReasons)}</li></ul></div>
      </div>
      <div class="box"><h3>TradeDesk status</h3><ul>${listItems(data.bottlenecks.tradeDeskStatusCounts)}</ul></div>
      <div class="advice"><h3>📈 Verbeteradvies</h3>${adviceItems}</div>
    </div>
  `;
}

function renderMoonCard(title, data) {
  const listItems = (arr) => arr.map(x => `<li><b>${esc(x.key)}</b> — ${x.count}</li>`).join("") || "<li>n/a</li>";
  const adviceItems = data.advice.map(a => `<div class="advice-item"><b>${esc(a.filter)}</b><br/>${esc(a.issue)}<br/><span class="muted">➜ ${esc(a.suggestion)}</span><br/><span class="impact">💰 ${esc(a.impact)}</span></div>`).join("") || "<div class='muted'>Geen advies</div>";
  return `
    <div class="card">
      <h2>${title}</h2>
      <div class="stats">
        <span class="stat">RADAR: ${data.avg.radar}</span>
        <span class="stat">BUILDUP: ${data.avg.buildup}</span>
        <span class="stat">ALMOST: ${data.avg.almost}</span>
        <span class="stat">ELITE: ${data.avg.elite}</span>
      </div>
      <div class="grid-2">
        <div class="box"><h3>Top blokkades (ELITE)</h3><ul>${listItems(data.topBlocks.eliteWhy)}</ul></div>
        <div class="box"><h3>Trade outcomes</h3><ul><li>Winrate: ${data.tradeStats.winrate}%</li><li>Open: ${data.tradeStats.counts.open}, Closed: ${data.tradeStats.counts.closed}</li>${listItems(data.tradeStats.outcomesTop)}</ul></div>
      </div>
      <div class="advice"><h3>📈 Verbeteradvies</h3>${adviceItems}</div>
    </div>
  `;
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    // MAIN data
    const [bullLatest, bearLatest, tradeClosed] = await Promise.all([
      kv.get(keyMainLatest("bull")),
      kv.get(keyMainLatest("bear")),
      readEvents("trade_closed", 4000),
    ]);
    const mainBullCoins = flattenMainCoins(bullLatest);
    const mainBearCoins = flattenMainCoins(bearLatest);
    const mainBullSnapshot = summarizeMainSnapshot(bullLatest);
    const mainBearSnapshot = summarizeMainSnapshot(bearLatest);
    const mainBullBottlenecks = analyzeMainBottlenecks(mainBullCoins);
    const mainBearBottlenecks = analyzeMainBottlenecks(mainBearCoins);
    const mainBullTradeStats = analyzeMainTrades(tradeClosed, "bull");
    const mainBearTradeStats = analyzeMainTrades(tradeClosed, "bear");
    const mainBullAdvice = generateFilterAdvice(mainBullBottlenecks, mainBullTradeStats, "Main bull");
    const mainBearAdvice = generateFilterAdvice(mainBearBottlenecks, mainBearTradeStats, "Main bear");

    // MOON data
    const [moonBullDiags, moonBearDiags, moonBullPos, moonBearPos] = await Promise.all([
      readMoonDiags("bull", 20),
      readMoonDiags("bear", 20),
      readMoonPositions("bull"),
      readMoonPositions("bear"),
    ]);
    const moonBullSummary = summarizeMoonDiags(moonBullDiags);
    const moonBearSummary = summarizeMoonDiags(moonBearDiags);
    const moonBullTrades = summarizeMoonTrades(moonBullPos);
    const moonBearTrades = summarizeMoonTrades(moonBearPos);

    const moonBullTop = topN(moonBullSummary.totals.eliteWhy, 1)[0];
    const moonBearTop = topN(moonBearSummary.totals.eliteWhy, 1)[0];

    const moonBullAdvice = moonBullTop ? [{
      filter: moonBullTop.key,
      issue: `Top blokkade ELITE (${moonBullTop.count})`,
      suggestion: `Versoepel "${moonBullTop.key}" in MOON.elite`,
      impact: "Meer ELITE",
    }] : [];

    const moonBearAdvice = moonBearTop ? [{
      filter: moonBearTop.key,
      issue: `Top blokkade ELITE (${moonBearTop.count})`,
      suggestion: `Versoepel "${moonBearTop.key}" in MOON.elite`,
      impact: "Meer ELITE",
    }] : [];

    const top5Advice = mergeTopAdvice([mainBullAdvice, mainBearAdvice, moonBullAdvice, moonBearAdvice]);

    const latestTs = Math.max(n(mainBullSnapshot.ts,0), n(mainBearSnapshot.ts,0), n(moonBullSummary.lastTs,0), n(moonBearSummary.lastTs,0));

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Analyze ALL</title>
<style>
  body{font-family:ui-sans-serif;background:#0b0f14;color:#e6edf3;margin:0;padding:20px}
  .wrap{max-width:1400px;margin:0 auto}
  h1{margin:0 0 10px}
  .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:20px}
  .card{background:#111826;border:1px solid #1f2a3a;border-radius:14px;padding:16px;margin-bottom:20px}
  .stats{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:16px}
  .stat{background:#0c1320;padding:4px 12px;border-radius:20px;border:1px solid #2a3a52}
  .grid-2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
  .box{background:#0c1320;border:1px solid #1f2a3a;border-radius:12px;padding:12px}
  ul{margin:0;padding-left:20px}
  .advice{background:#0a1b2b;border:1px solid #2a4a6a;border-radius:12px;padding:12px;margin-top:12px}
  .advice-item{margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #2a3a52}
  .impact{color:#6fcf97}
  .muted{color:#9fb0c3}
  @media (max-width:800px){.grid{grid-template-columns:1fr}}
</style>
</head>
<body><div class="wrap">
  <h1>🔥 Volledige systeem analyse</h1>
  <div class="card"><h2>Top 5 beste aanpassingen nu</h2>${top5Advice.map(a => `<div class="advice-item"><b>${esc(a.filter)}</b><br/>${esc(a.issue)}<br/><span class="muted">➜ ${esc(a.suggestion)}</span><br/><span class="impact">💰 ${esc(a.impact)}</span></div>`).join("") || "<div class='muted'>Nog geen advies</div>"}</div>
  <div class="grid">
    ${renderSystemCard("MAIN BULL", { stageCounts: mainBullSnapshot.stageCounts, bottlenecks: mainBullBottlenecks, tradeStats: mainBullTradeStats, advice: mainBullAdvice })}
    ${renderSystemCard("MAIN BEAR", { stageCounts: mainBearSnapshot.stageCounts, bottlenecks: mainBearBottlenecks, tradeStats: mainBearTradeStats, advice: mainBearAdvice })}
    ${renderMoonCard("MOON BULL", { avg: moonBullSummary.avg, topBlocks: { eliteWhy: topN(moonBullSummary.totals.eliteWhy,5) }, tradeStats: moonBullTrades, advice: moonBullAdvice })}
    ${renderMoonCard("MOON BEAR", { avg: moonBearSummary.avg, topBlocks: { eliteWhy: topN(moonBearSummary.totals.eliteWhy,5) }, tradeStats: moonBearTrades, advice: moonBearAdvice })}
  </div>
  <div class="muted" style="margin-top:20px;text-align:center">Data laatste update: ${fmtDate(latestTs)}</div>
</div></body></html>`;

    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.status(200).end(html);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: String(err.message) });
  }
}