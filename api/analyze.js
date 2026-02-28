/* EOF: /api/analyze.js */
import { readEvents } from "../lib/_analytics.js";
import { requireSecret, RUNTIME_CONFIG } from "../lib/_runtime.js";

export const config = RUNTIME_CONFIG;

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
function topN(map, k = 8) {
  const arr = Object.entries(map || {}).map(([key, count]) => ({ key, count: n(count, 0) }));
  arr.sort((a, b) => b.count - a.count);
  return arr.slice(0, k);
}
function inc(map, key) {
  const k = String(key || "Unknown");
  map[k] = (map[k] || 0) + 1;
}

function analyzeEvents(events, mode) {
  const ev = safeArr(events).filter(e => String(e?.mode || "") === String(mode || ""));

  const stageChanges = ev.filter(e => e.type === "stage_change");
  const tradeOpen = ev.filter(e => e.type === "trade_open");
  const tradeClose = ev.filter(e => e.type === "trade_close");

  const flow = {};
  const stuckReason = { RADAR: {}, BUILDUP: {}, ALMOST: {}, ENTRY: {} };

  for (const e of stageChanges) {
    const from = String(e.from || "").toUpperCase();
    const to = String(e.to || "").toUpperCase();
    if (!from || !to) continue;
    inc(flow, `${from}→${to}`);

    const reason = String(e.reason || "n/a");
    if (stuckReason[to]) inc(stuckReason[to], reason);
  }

  const openById = {};
  for (const o of tradeOpen) {
    const id = String(o.tradeId || "");
    if (!id) continue;
    openById[id] = o;
  }

  const trades = [];
  const exitReasons = {};
  let givebackSum = 0;
  let givebackN = 0;

  const earlyExit = [];
  const lateExit = [];

  for (const c of tradeClose) {
    const id = String(c.tradeId || "");
    const o = id ? openById[id] : null;

    const pnl = n(c.pnlPct, 0);
    const maxPnl = n(c.maxPnlPct, pnl);
    const giveback = n(c.givebackPct, Math.max(0, maxPnl - pnl));

    inc(exitReasons, String(c.reason || "UNKNOWN"));
    givebackSum += giveback;
    givebackN++;

    const item = {
      ts: n(c.ts, 0),
      tradeId: id,
      symbol: String(c.symbol || o?.symbol || "?"),
      mode,
      entryGate: String(o?.entryGate || "-"),
      confidence: n(o?.confidence, 0),
      vm: n(o?.vm, 0),
      pnlPct: pnl,
      maxPnlPct: maxPnl,
      givebackPct: giveback,
      reason: String(c.reason || ""),
      barsOpen: n(c.barsOpen, 0),
      entryPrice: n(c.entryPrice, 0),
      exitPrice: n(c.exitPrice, 0),
    };

    trades.push(item);

    if (giveback >= 2.0 && maxPnl >= 3.0) lateExit.push(item);
    if (item.reason === "TRAILING_TP" && item.maxPnlPct < 3.0) earlyExit.push(item);
  }

  trades.sort((a, b) => b.ts - a.ts);

  const avgGiveback = givebackN ? givebackSum / givebackN : 0;

  const suggestions = [];
  const topAlmost = topN(stuckReason.ALMOST, 3);
  const topEntry = topN(stuckReason.ENTRY, 3);

  const reasonStr = (x) => String(x || "").toLowerCase();
  if (topAlmost.some(x => reasonStr(x.key).includes("stale")) || topEntry.some(x => reasonStr(x.key).includes("stale"))) {
    suggestions.push({
      what: "OB is vaak te oud (stale) bij ALMOST/ENTRY",
      do: "OB sampler vaker laten lopen of OB_MAX_AGE_MS iets verhogen.",
      why: "Anders stopt de funnel vóór ENTRY.",
    });
  }

  if (avgGiveback >= 1.5) {
    suggestions.push({
      what: "Veel giveback (winst was hoger, maar je eindigt lager)",
      do: "Trailing strakker maken (TRAIL_AFTER_TP1/T2 kleiner) of TP1 iets lager zetten.",
      why: "Je pakt winst, maar je geeft terug vóór SELL.",
    });
  }

  if ((exitReasons["TIME_STOP_NO_MOMENTUM"] || 0) >= 5) {
    suggestions.push({
      what: "Veel TIME_STOP exits",
      do: "ENTRY strenger op momentum (of TIME_STOP_SCANS hoger).",
      why: "Je gaat erin, maar er komt geen beweging.",
    });
  }

  if ((exitReasons["HARD_STOP"] || 0) >= 5) {
    suggestions.push({
      what: "Veel HARD_STOP exits",
      do: "StopPctFromRange24 iets ruimer óf ENTRY alleen bij lagere range24.",
      why: "Stop is te gevoelig voor normale volatiliteit.",
    });
  }

  return {
    counts: {
      events: ev.length,
      stageChanges: stageChanges.length,
      tradeOpen: tradeOpen.length,
      tradeClose: tradeClose.length,
    },
    flowTop: topN(flow, 12),
    stuckTop: {
      RADAR: topN(stuckReason.RADAR, 8),
      BUILDUP: topN(stuckReason.BUILDUP, 8),
      ALMOST: topN(stuckReason.ALMOST, 8),
      ENTRY: topN(stuckReason.ENTRY, 8),
    },
    trades: {
      exitReasonsTop: topN(exitReasons, 10),
      avgGivebackPct: Number(avgGiveback.toFixed(3)),
      lateExitSamples: lateExit.slice(0, 10),
      earlyExitSamples: earlyExit.slice(0, 10),
      lastTrades: trades.slice(0, 20),
    },
    suggestions,
  };
}

function htmlPage(mode, data) {
  const list = (arr) => (arr || []).map(x => `<li><b>${esc(x.key)}</b> — ${n(x.count,0)}</li>`).join("") || "<li>n/a</li>";
  const rowTrade = (t) => `
    <tr>
      <td><b>${esc(t.symbol)}</b></td>
      <td>${esc(t.reason)}</td>
      <td>${n(t.pnlPct,0).toFixed(2)}%</td>
      <td>${n(t.maxPnlPct,0).toFixed(2)}%</td>
      <td>${n(t.givebackPct,0).toFixed(2)}%</td>
      <td>${esc(t.entryGate || "-")}</td>
      <td>${n(t.confidence,0)}</td>
      <td>${n(t.vm,0).toFixed(2)}</td>
      <td>${n(t.barsOpen,0)}</td>
    </tr>
  `;

  const sug = (data.suggestions || []).map(s => `
    <div class="box">
      <div><b>Wat:</b> ${esc(s.what)}</div>
      <div><b>Doe:</b> ${esc(s.do)}</div>
      <div class="muted"><b>Waarom:</b> ${esc(s.why)}</div>
    </div>
  `).join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Analyze (${mode})</title>
  <style>
    body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto;margin:0;background:#0b0f14;color:#e6edf3}
    .wrap{max-width:1200px;margin:0 auto;padding:18px}
    h1{margin:0 0 10px 0;font-size:20px}
    .muted{color:#9fb0c3;font-size:13px}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:12px}
    .box{background:#0c1320;border:1px solid #1f2a3a;border-radius:12px;padding:10px}
    ul{margin:0;padding-left:18px}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th,td{padding:8px;border-bottom:1px solid #1f2a3a;text-align:left}
    .pill{display:inline-flex;align-items:center;background:#0a1b2b;border:1px solid #15334e;padding:6px 10px;border-radius:999px;font-size:13px;color:#e6edf3}
    .row{display:flex;gap:8px;flex-wrap:wrap}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Analyze (${esc(mode)})</h1>
    <div class="row">
      <span class="pill">events: ${n(data.counts.events,0)}</span>
      <span class="pill">stage_changes: ${n(data.counts.stageChanges,0)}</span>
      <span class="pill">trade_open: ${n(data.counts.tradeOpen,0)}</span>
      <span class="pill">trade_close: ${n(data.counts.tradeClose,0)}</span>
      <span class="pill">avg giveback: ${n(data.trades.avgGivebackPct,0).toFixed(2)}%</span>
    </div>

    <div class="grid">
      <div class="box">
        <h3>Funnel flow (events)</h3>
        <ul>${list(data.flowTop)}</ul>
      </div>
      <div class="box">
        <h3>Trade exit reasons</h3>
        <ul>${list(data.trades.exitReasonsTop)}</ul>
      </div>
      <div class="box">
        <h3>Top redenen — ALMOST</h3>
        <ul>${list(data.stuckTop.ALMOST)}</ul>
      </div>
      <div class="box">
        <h3>Top redenen — ENTRY</h3>
        <ul>${list(data.stuckTop.ENTRY)}</ul>
      </div>
    </div>

    <div class="box" style="margin-top:12px">
      <h3>Timing: te laat (giveback)</h3>
      <div class="muted">Giveback hoog = winst was hoger, maar je eindigt lager.</div>
      <div style="overflow:auto;margin-top:8px">
        <table>
          <thead>
            <tr>
              <th>Coin</th><th>Reason</th><th>PnL</th><th>Max</th><th>Giveback</th><th>Gate</th><th>Conf</th><th>VM</th><th>Bars</th>
            </tr>
          </thead>
          <tbody>
            ${(data.trades.lateExitSamples || []).map(rowTrade).join("") || `<tr><td colspan="9" class="muted">n/a</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>

    <div class="box" style="margin-top:12px">
      <h3>Timing: mogelijk te vroeg</h3>
      <div class="muted">Veel TRAILING_TP bij lage maxPnL = te vroeg/te strak.</div>
      <div style="overflow:auto;margin-top:8px">
        <table>
          <thead>
            <tr>
              <th>Coin</th><th>Reason</th><th>PnL</th><th>Max</th><th>Giveback</th><th>Gate</th><th>Conf</th><th>VM</th><th>Bars</th>
            </tr>
          </thead>
          <tbody>
            ${(data.trades.earlyExitSamples || []).map(rowTrade).join("") || `<tr><td colspan="9" class="muted">n/a</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>

    <div class="box" style="margin-top:12px">
      <h3>Concrete suggesties</h3>
      ${sug || `<div class="muted">Nog te weinig data. Laat cron een tijdje lopen.</div>`}
    </div>

    <div class="muted" style="margin-top:10px">
      Tip: <code>?format=json</code> voor ruwe analyse.
    </div>
  </div>
</body>
</html>`;
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const mode = String(req.query?.mode || "bull").toLowerCase();
    const format = String(req.query?.format || "html").toLowerCase();
    const limit = Math.max(200, Math.min(5000, Number(req.query?.limit || 2000)));

    const events = await readEvents("main", limit);
    const data = analyzeEvents(events, mode);

    if (format === "json") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      return res.end(JSON.stringify({ ok: true, ts: Date.now(), mode, limit, ...data }));
    }

    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.end(htmlPage(mode, data));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}