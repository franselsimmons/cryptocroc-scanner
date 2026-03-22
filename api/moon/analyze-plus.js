// Vereist: Moon diag keys (keyMoonDiagList, keyMoonDiagSnap, keyMoonPositions, keyMoonPortfolio) en MOON config
import { kv } from "@vercel/kv";
import { requireSecret, RUNTIME_CONFIG } from "../../lib/_runtime.js";
import {
  MOON,
  keyMoonDiagList,
  keyMoonDiagSnap,
  keyMoonPositions,
  keyMoonPortfolio,
} from "../../lib/_moon_core.js";

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
function topN(map, k = 6) {
  const arr = Object.entries(map || {}).map(([key, count]) => ({ key, count: n(count, 0) }));
  arr.sort((a, b) => b.count - a.count);
  return arr.slice(0, k);
}
function addCounts(to, from) {
  const out = to || {};
  const src = from || {};
  for (const k of Object.keys(src)) out[k] = (out[k] || 0) + n(src[k], 0);
  return out;
}
function fmtDateMin(ts) {
  if (!ts) return "n/a";
  const d = new Date(ts);
  return d.toISOString().slice(0,16).replace('T',' ');
}

async function readDiags(mode, limit = 30) {
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

function summarizeDiags(diags) {
  const s = { scans: diags.length, lastTs: diags[0]?.ts || null, avg: { radar: 0, buildup: 0, almost: 0, elite: 0 }, totals: { radarOut: {}, buildupWhy: {}, almostWhy: {}, eliteWhy: {}, eliteExtraFail: {}, obReason: {} } };
  if (!diags.length) return s;
  let sr=0, sb=0, sa=0, se=0;
  for (const d of diags) {
    const c = d?.counts || {};
    sr += n(c.radar,0); sb += n(c.buildup,0); sa += n(c.almost,0); se += n(c.elite,0);
    const r = d?.reasons || {};
    s.totals.radarOut = addCounts(s.totals.radarOut, r.radarOut);
    s.totals.buildupWhy = addCounts(s.totals.buildupWhy, r.buildupWhy);
    s.totals.almostWhy = addCounts(s.totals.almostWhy, r.almostWhy);
    s.totals.eliteWhy = addCounts(s.totals.eliteWhy, r.eliteWhy);
    s.totals.eliteExtraFail = addCounts(s.totals.eliteExtraFail, r.eliteExtraFail);
    s.totals.obReason = addCounts(s.totals.obReason, r.obReason);
  }
  const k = diags.length || 1;
  s.avg = { radar: +(sr/k).toFixed(2), buildup: +(sb/k).toFixed(2), almost: +(sa/k).toFixed(2), elite: +(se/k).toFixed(2) };
  return s;
}

async function readPositions(mode) {
  try {
    const p = await kv.get(keyMoonPositions(mode));
    return { open: Array.isArray(p?.open) ? p.open : [], closed: Array.isArray(p?.closed) ? p.closed : [] };
  } catch { return { open: [], closed: [] }; }
}

async function readPortfolio(mode) {
  try { return await kv.get(keyMoonPortfolio(mode)); } catch { return null; }
}

function inferHitKind(pos, mode) {
  const kind = String(pos?.exitKind || pos?.closeKind || pos?.kind || "").toUpperCase();
  if (kind === "SL" || kind === "TP" || kind === "TP1" || kind === "TP2" || kind === "TP3") return kind;
  const entry = n(pos?.entryPrice,0), last = n(pos?.exitPrice ?? pos?.priceNow ?? pos?.lastPrice,0);
  const sl = n(pos?.sl,0), tp3 = n(pos?.tp3 ?? pos?.tp,0);
  if (!(entry>0 && last>0)) return "CLOSED";
  if (mode==="bull") { if(sl>0 && last<=sl) return "SL"; if(tp3>0 && last>=tp3) return "TP"; }
  else { if(sl>0 && last>=sl) return "SL"; if(tp3>0 && last<=tp3) return "TP"; }
  return "CLOSED";
}

function summarizeTrades(positions, mode) {
  const closed = positions.closed;
  const outMap = {};
  let tpTooFar=0, slTooTight=0, haveMetrics=0;
  for (const p of closed) {
    const k = inferHitKind(p, mode);
    outMap[k] = (outMap[k] || 0) + 1;
    const mfe = Number.isFinite(Number(p?.mfePct)) ? n(p.mfePct,0) : null;
    const mae = Number.isFinite(Number(p?.maePct)) ? n(p.maePct,0) : null;
    if (mfe===null || mae===null) continue;
    const entry = n(p?.entryPrice,0), sl = n(p?.sl,0), tp = n(p?.tp3 ?? p?.tp,0);
    if (!(entry>0 && sl>0 && tp>0)) continue;
    haveMetrics++;
    const slPct = mode==="bull" ? ((entry-sl)/entry)*100 : ((sl-entry)/entry)*100;
    const tpPct = mode==="bull" ? ((tp-entry)/entry)*100 : ((entry-tp)/entry)*100;
    if (k==="SL") {
      const maeR = Math.abs(mae)/Math.max(0.0001, slPct);
      if (maeR <= 1.15) slTooTight++;
    } else if (k !== "TP" && k !== "TP1" && k !== "TP2" && k !== "TP3") {
      const mfeRtp = Math.abs(mfe)/Math.max(0.0001, tpPct);
      if (mfeRtp >= 0.65 && mfeRtp <= 0.95) tpTooFar++;
    }
  }
  const wins = (outMap.TP||0)+(outMap.TP1||0)+(outMap.TP2||0)+(outMap.TP3||0);
  const losses = outMap.SL||0;
  const winrate = (wins+losses) ? ((wins/(wins+losses))*100).toFixed(1) : 0;
  const tuning = [];
  if (haveMetrics >= 5) {
    if (slTooTight >= Math.ceil(haveMetrics*0.35)) tuning.push("SL te strak → maak SL 25% wijder (in computeMoonRisk)");
    if (tpTooFar >= Math.ceil(haveMetrics*0.35)) tuning.push("TP te ver → maak TP’s dichterbij (tpMul omlaag in computeMoonRisk)");
  }
  return { counts: { open: positions.open.length, closed: closed.length }, outcomesTop: topN(outMap,8), winrate, tuning };
}

function filterSuggestions(sum) {
  const avgElite = n(sum?.avg?.elite,0);
  const desiredMin = 1, desiredMax = 5;
  const topEliteWhy = topN(sum?.totals?.eliteWhy,5);
  const topExtraFail = topN(sum?.totals?.eliteExtraFail,5);
  const out = { goal: `ELITE gemiddeld ${desiredMin}..${desiredMax} per scan`, now: `ELITE gemiddeld ${avgElite} per scan`, changes: {}, reason: [] };
  const elite = MOON.elite, roll = MOON.elite.roll;
  if (avgElite < desiredMin) {
    out.reason.push("Te weinig ELITE → versoepel 1 stapje bij grootste blokkade.");
    const mainBlock = String(topEliteWhy[0]?.key || "");
    const extraBlock = String(topExtraFail[0]?.key || "");
    if (mainBlock.toLowerCase().includes("confidence")) out.changes["MOON.elite.minConfidence"] = `${elite.minConfidence} -> ${Math.max(0, elite.minConfidence - 3)}`;
    else if (mainBlock.toLowerCase().includes("depth")) out.changes["MOON.elite.depthK"] = `${elite.depthK} -> ${(elite.depthK * 0.9).toFixed(6)}`;
    else if (extraBlock.toLowerCase().includes("vol") || extraBlock.toLowerCase().includes("dv")) out.changes["MOON.elite.roll.minDeltaVol15m"] = `${roll.minDeltaVol15m} -> ${(roll.minDeltaVol15m * 0.85).toFixed(4)}`;
    else out.changes["MOON.elite.spreadMaxPct"] = `${elite.spreadMaxPct} -> ${(elite.spreadMaxPct + 0.05).toFixed(2)}`;
  } else if (avgElite > desiredMax) {
    out.reason.push("Te veel ELITE → iets strenger zodat kwaliteit omhoog gaat.");
    out.changes["MOON.elite.minConfidence"] = `${elite.minConfidence} -> ${elite.minConfidence + 3}`;
  } else out.reason.push("ELITE zit in gezonde zone → niets aanpassen.");
  out.topBlocks = { eliteWhy: topEliteWhy, eliteExtraFail: topExtraFail, obReason: topN(sum?.totals?.obReason,5), radarOut: topN(sum?.totals?.radarOut,5) };
  return out;
}

function card(title, s, sug, trades, portfolio, mode) {
  const blocks = sug.topBlocks || {};
  const list = (arr) => (arr||[]).map(x => `<li><b>${x.key}</b> — ${x.count}</li>`).join("") || "<li>n/a</li>";
  const changes = Object.entries(sug.changes||{}).map(([k,v]) => `<li><code>${k}</code>: <b>${v}</b></li>`).join("") || "<li>n/a</li>";
  const outs = trades.outcomesTop.map(x => `<li><b>${x.key}</b> — ${x.count}</li>`).join("") || "<li>n/a</li>";
  const tune = trades.tuning.map(t => `<div class="tune"><b>⚠️ ${t}</b></div>`).join("") || "";
  const copyBlock = { funnel:"moon", mode, ts:Date.now(), avgPerScan:s.avg, topBlocks: blocks, trades:{ counts:trades.counts, outcomesTop:trades.outcomesTop }, filtersNow: { elite: MOON.elite, eliteRoll: MOON.elite.roll }, recommendedChanges: sug.changes };
  return `
    <div class="card">
      <h2>${title}</h2>
      <div class="muted">Laatste diag: ${fmtDateMin(s.lastTs)} • scans: ${s.scans}</div>
      <div class="grid-2">
        <div class="box"><h3>Gemiddeld per scan</h3><ul><li>RADAR: ${s.avg.radar}</li><li>BUILDUP: ${s.avg.buildup}</li><li>ALMOST: ${s.avg.almost}</li><li>ELITE: ${s.avg.elite}</li></ul></div>
        <div class="box"><h3>Filter-suggestie</h3><div class="muted">${sug.goal}<br/>${sug.now}</div><ul>${changes}</ul><div class="muted">${(sug.reason||[]).join(" • ")}</div></div>
      </div>
      <div class="grid-2">
        <div class="box"><h3>Top blokkades (ELITE)</h3><ul>${list(blocks.eliteWhy)}</ul></div>
        <div class="box"><h3>Top rolling fails</h3><ul>${list(blocks.eliteExtraFail)}</ul></div>
        <div class="box"><h3>Top OB reasons</h3><ul>${list(blocks.obReason)}</ul></div>
        <div class="box"><h3>Top RADAR out</h3><ul>${list(blocks.radarOut)}</ul></div>
      </div>
      <div class="grid-2">
        <div class="box"><h3>Trades (MOON)</h3><ul><li>Open: ${trades.counts.open}, Closed: ${trades.counts.closed}</li><li>Winrate: ${trades.winrate}%</li>${outs}</ul>${tune}</div>
        <div class="box"><h3>Portfolio</h3>${portfolio ? `<ul><li>posUsd: ${portfolio.posUsd}</li><li>openCount: ${portfolio.openCount}</li><li>closedCount: ${portfolio.closedCount}</li><li>realizedUsd: ${portfolio.realizedUsd}</li><li>avgRealizedPct: ${portfolio.avgRealizedPct}</li><li>updated: ${fmtDateMin(portfolio.updatedAt)}</li></ul>` : "<div class='muted'>n/a</div>"}</div>
      </div>
      <div class="box"><h3>📋 Copy/paste debug</h3><textarea style="width:100%;height:200px;background:#0a1b2b;color:#e6edf3;border:1px solid #15334e;border-radius:8px;padding:8px">${esc(JSON.stringify(copyBlock,null,2))}</textarea></div>
    </div>
  `;
}

function htmlPage({ long, short }) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MOON Analyze+</title>
<style>
  body{font-family:ui-sans-serif;background:#0b0f14;color:#e6edf3;margin:0;padding:20px}
  .wrap{max-width:1200px;margin:0 auto}
  .row{display:flex;gap:20px;flex-wrap:wrap}
  .card{flex:1;min-width:300px;background:#111826;border:1px solid #1f2a3a;border-radius:14px;padding:16px}
  .grid-2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .box{background:#0c1320;border:1px solid #1f2a3a;border-radius:12px;padding:10px}
  ul{margin:0;padding-left:18px}
  .muted{color:#9fb0c3}
  .tune{margin-top:8px;padding:6px;background:#1a2a3a;border-radius:8px}
  code{background:#0a1b2b;padding:2px 6px;border-radius:8px}
</style>
</head>
<body><div class="wrap"><h1>MOON Analyze+ (LONG vs SHORT) + Trades tuning</h1><div class="row">${long ? card("LONG (bull)", long.summary, long.suggestions, long.trades, long.portfolio, "bull") : ""}${short ? card("SHORT (bear)", short.summary, short.suggestions, short.trades, short.portfolio, "bear") : ""}</div><div class="muted">Tip: <code>?format=json</code> voor ruwe data.</div></div></body></html>`;
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const mode = String(req.query?.mode || "all").toLowerCase();
    const format = String(req.query?.format || "html").toLowerCase();
    const limit = Math.max(1, Math.min(200, parseInt(String(req.query?.limit || "30"), 10) || 30));

    const make = async (m) => {
      const diags = await readDiags(m, limit);
      const summary = summarizeDiags(diags);
      const positions = await readPositions(m);
      const portfolio = await readPortfolio(m);
      const trades = summarizeTrades(positions, m);
      const suggestions = filterSuggestions(summary);
      return { summary, suggestions, trades, portfolio };
    };

    const data = mode === "all" ? { long: await make("bull"), short: await make("bear") } : (mode === "bull" ? { long: await make("bull") } : { short: await make("bear") });

    if (format === "json") {
      res.status(200).json({ ok: true, mode, limit, data });
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.status(200).end(htmlPage(data));
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: String(err.message) });
  }
}