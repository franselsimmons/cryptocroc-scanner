// /api/analyze-pro.js
// Vereist: KV keys "latest:bull" en "latest:bear" + trade_closed events
import { kv } from "@vercel/kv";
import { readEvents } from "../lib/_analytics.js";
import { requireSecret, RUNTIME_CONFIG } from "../lib/_runtime.js";
import { keyMoonDiagList, keyMoonDiagSnap } from "../lib/_moon_core.js";

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
function topN(map, k = 5) {
  const arr = Object.entries(map || {}).map(([key, count]) => ({ key, count: n(count, 0) }));
  arr.sort((a, b) => b.count - a.count);
  return arr.slice(0, k);
}
function addCounts(to, from) { const out = to || {}; const src = from || {}; for (const k of Object.keys(src)) out[k] = (out[k] || 0) + n(src[k], 0); return out; }

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
    ...safeStage(f.radar).map(c => ({ ...c, _stage: c?.stage || "RADAR" })),
    ...safeStage(f.buildup).map(c => ({ ...c, _stage: c?.stage || "BUILDUP" })),
    ...safeStage(f.almost).map(c => ({ ...c, _stage: c?.stage || "ALMOST" })),
    ...safeStage(f.entry).map(c => ({ ...c, _stage: c?.stage || "ENTRY" })),
    ...safeStage(f.elite_ignition).map(c => ({ ...c, _stage: c?.stage || "ELITE_IGNITION" })),
    ...safeStage(f.elite_expansion).map(c => ({ ...c, _stage: c?.stage || "ELITE_EXPANSION" })),
    ...safeStage(f.elite_cascade).map(c => ({ ...c, _stage: c?.stage || "ELITE_CASCADE" })),
    ...safeStage(f.hold).map(c => ({ ...c, _stage: c?.stage || "HOLD" })),
  ];
}

function analyzeMainBottlenecks(coins) {
  const fails = {};
  for (const c of coins) {
    const ex = c?.execution || {};
    const checklist = Array.isArray(ex.checklist) ? ex.checklist : [];
    for (const item of checklist) {
      if (item?.ok === false) inc(fails, String(item?.name || "unknown").toLowerCase().replace(/\s+/g, "_"));
    }
  }
  return topN(fails, 10);
}

function analyzeMainTrades(events, mode) {
  const filtered = safeArr(events).filter(e => {
    if (!mode) return true;
    return String(e?.mode || "").toLowerCase() === String(mode).toLowerCase();
  });
  const closes = filtered.filter(e => e.type === "trade_close");
  const exitReasons = {};
  let givebackSum = 0;
  for (const t of closes) {
    inc(exitReasons, t?.reason || "UNKNOWN");
    const max = n(t?.maxPnlPct, 0);
    const pnl = n(t?.pnlPct, 0);
    givebackSum += Math.max(0, max - pnl);
  }
  const avgGiveback = closes.length ? givebackSum / closes.length : 0;
  return { exitReasons: topN(exitReasons, 5), avgGiveback, totalTrades: closes.length };
}

// Moon data helpers (alleen voor adviezen)
async function readMoonDiags(mode, limit = 30) {
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
  const totals = { eliteWhy: {} };
  for (const d of diags) {
    const r = d?.reasons || {};
    totals.eliteWhy = addCounts(totals.eliteWhy, r.eliteWhy);
  }
  return { totals };
}

// Advies generator
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

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    // MAIN
    const [bullLatest, bearLatest, tradeClosed] = await Promise.all([
      kv.get(keyMainLatest("bull")),
      kv.get(keyMainLatest("bear")),
      readEvents("trade_closed", 4000),
    ]);
    const mainBullCoins = flattenMainCoins(bullLatest);
    const mainBearCoins = flattenMainCoins(bearLatest);
    const mainBullBottleneck = analyzeMainBottlenecks(mainBullCoins);
    const mainBearBottleneck = analyzeMainBottlenecks(mainBearCoins);
    const mainBullTrades = analyzeMainTrades(tradeClosed, "bull");
    const mainBearTrades = analyzeMainTrades(tradeClosed, "bear");

    // MOON
    const [moonBullDiags, moonBearDiags] = await Promise.all([readMoonDiags("bull", 20), readMoonDiags("bear", 20)]);
    const moonBullSum = summarizeMoonDiags(moonBullDiags);
    const moonBearSum = summarizeMoonDiags(moonBearDiags);
    const moonBullEliteWhy = topN(moonBullSum.totals.eliteWhy, 3);
    const moonBearEliteWhy = topN(moonBearSum.totals.eliteWhy, 3);

    // Bouw adviezen
    const advice = [];

    if (mainBullBottleneck[0]?.key) {
      advice.push({ system: "Main bull", filter: mainBullBottleneck[0].key, issue: `Top falende filter (${mainBullBottleneck[0].count} coins)`, suggestion: `Versoepel "${mainBullBottleneck[0].key}"`, impact: "Meer ALMOST/ELITE" });
    }
    if (mainBearBottleneck[0]?.key) {
      advice.push({ system: "Main bear", filter: mainBearBottleneck[0].key, issue: `Top falende filter (${mainBearBottleneck[0].count} coins)`, suggestion: `Versoepel "${mainBearBottleneck[0].key}"`, impact: "Meer ALMOST/ELITE" });
    }
    if (mainBullTrades.avgGiveback > 1.5) {
      advice.push({ system: "Main bull", filter: "giveback", issue: `Avg giveback ${mainBullTrades.avgGiveback.toFixed(2)}%`, suggestion: "Trailing TP strakker na TP1", impact: "Meer winst vasthouden" });
    }
    if (mainBearTrades.avgGiveback > 1.5) {
      advice.push({ system: "Main bear", filter: "giveback", issue: `Avg giveback ${mainBearTrades.avgGiveback.toFixed(2)}%`, suggestion: "Trailing TP strakker na TP1", impact: "Meer winst vasthouden" });
    }
    if (moonBullEliteWhy[0]?.key) {
      advice.push({ system: "Moon bull", filter: moonBullEliteWhy[0].key, issue: `Grootste blokkade ELITE (${moonBullEliteWhy[0].count})`, suggestion: `Versoepel "${moonBullEliteWhy[0].key}" in MOON.elite`, impact: "Meer ELITE coins" });
    }
    if (moonBearEliteWhy[0]?.key) {
      advice.push({ system: "Moon bear", filter: moonBearEliteWhy[0].key, issue: `Grootste blokkade ELITE (${moonBearEliteWhy[0].count})`, suggestion: `Versoepel "${moonBearEliteWhy[0].key}" in MOON.elite`, impact: "Meer ELITE coins" });
    }

    const top5 = mergeTopAdvice([advice]);

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Pro Analyze - Top aanbevelingen</title>
<style>
  body{background:#0b0f14;color:#e6edf3;font-family:sans-serif;padding:20px}
  .card{background:#111826;border:1px solid #1f2a3a;border-radius:14px;padding:20px;max-width:800px;margin:0 auto}
  h1{margin:0 0 10px}
  .advice-item{margin-bottom:20px;border-bottom:1px solid #2a3a52;padding-bottom:15px}
  .muted{color:#9fb0c3}
  .impact{color:#6fcf97}
</style>
</head>
<body>
<div class="card">
  <h1>🔥 Top 5 beste aanpassingen nu</h1>
  ${top5.map(a => `
    <div class="advice-item">
      <b>${esc(a.system)} / ${esc(a.filter)}</b><br/>
      ${esc(a.issue)}<br/>
      <span class="muted">➜ ${esc(a.suggestion)}</span><br/>
      <span class="impact">💰 ${esc(a.impact)}</span>
    </div>
  `).join("") || "<div>Nog geen advies beschikbaar</div>"}
  <div class="muted" style="margin-top:20px">Data update: ${new Date().toLocaleString()}</div>
</div>
</body></html>`;

    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.status(200).end(html);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: String(err.message) });
  }
}