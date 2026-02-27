// portfolio.js
const el = (id) => document.getElementById(id);

const API = "/api/portfolio/latest";

el("refreshBtn").onclick = () => load();

function fmt(n) { return (Number(n) || 0).toFixed(2); }
function pct(n) {
  n = Number(n) || 0;
  const s = n >= 0 ? "+" : "";
  return s + fmt(n) + "%";
}
function pill(txt) { return `<span class="pill">${txt}</span>`; }

function pnlSpan(n) {
  n = Number(n) || 0;
  const cls = n >= 0 ? "pnlPos" : "pnlNeg";
  return `<span class="${cls}">${pct(n)}</span>`;
}

function usd6(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "0.000000";
  return v.toFixed(6);
}

function safeStr(x) { return String(x ?? ""); }

function rowOpen(t) {
  return `
  <tr data-id="${t.id || ""}" data-type="open">
    <td>
      <b>${safeStr(t.symbol)}</b>
      <div class="muted">${safeStr(t.funnel)} • ${safeStr(t.mode).toUpperCase()}</div>
    </td>
    <td>$${usd6(t.entryPrice)}</td>
    <td>$${usd6(t.lastPrice)}</td>
    <td class="muted">$${usd6(t.peakPrice)} / $${usd6(t.troughPrice)}</td>
    <td>${pill("OPEN")}</td>
  </tr>`;
}

function rowClosed(t) {
  return `
  <tr data-id="${t.id || ""}" data-type="closed">
    <td>
      <b>${safeStr(t.symbol)}</b>
      <div class="muted">${safeStr(t.funnel)} • ${safeStr(t.mode).toUpperCase()}</div>
    </td>
    <td>$${usd6(t.entryPrice)} → $${usd6(t.exitPrice)}</td>
    <td>${pnlSpan(t.pnlPct)}</td>
    <td class="muted">${safeStr(t.exitReason || "")}</td>
  </tr>`;
}

function tableOpen(list) {
  if (!list || !list.length) return `<div class="empty">Geen open trades.</div>`;
  return `
  <table class="table">
    <thead><tr>
      <th>Coin</th><th>Entry</th><th>Last</th><th>Peak/Trough</th><th>Status</th>
    </tr></thead>
    <tbody>${list.map(rowOpen).join("")}</tbody>
  </table>`;
}

function tableClosed(list) {
  if (!list || !list.length) return `<div class="empty">Nog geen closed trades.</div>`;
  return `
  <table class="table">
    <thead><tr>
      <th>Coin</th><th>Entry → Exit</th><th>PnL</th><th>Reason</th>
    </tr></thead>
    <tbody>${list.map(rowClosed).join("")}</tbody>
  </table>`;
}

function details(t) {
  const entry = t.entryMeta || {};
  const exit = t.exitMeta || {};

  return `
  <div class="panelHint"><b>${safeStr(t.symbol)}</b> • ${safeStr(t.funnel)} • ${safeStr(t.mode).toUpperCase()} • ${safeStr(t.status)}</div>

  <pre>
ENTRY
- price: $${usd6(t.entryPrice)}
- confidence: ${entry.confidence ?? "-"}
- consistency: ${Math.round((entry.consistencyRatio || 0) * 100)}%
- obScore: ${Number(entry.obScore || 0).toFixed(3)}
- spread: ${fmt(entry.spreadPct || 0)}%
- depth1%: $${Math.round(Number(entry.depthMinUsd1p || 0)).toLocaleString()}
- vm: ${fmt(entry.vm || 0)}
- volAcc: ${fmt(entry.volAcc || 0)}
- gate: ${safeStr(entry.entryGate || "-")}

${String(t.status).toUpperCase() === "CLOSED"
    ? `EXIT
- price: $${usd6(t.exitPrice)}
- reason: ${safeStr(t.exitReason || "-")}
- pnl: ${pct(t.pnlPct || 0)}
- netPnl: ${pct(t.netPnlPct || 0)}
- slippage: ${pct(t.slippagePct || 0)}
`
    : `LIVE
- last: $${usd6(t.lastPrice)}
- peak: $${usd6(t.peakPrice)}
- trough: $${usd6(t.troughPrice)}
`}</pre>`;
}

let CACHE = null;

function bindClicks() {
  const rows = document.querySelectorAll("table.table tbody tr");
  for (const tr of rows) {
    tr.onclick = () => {
      const id = tr.getAttribute("data-id");
      const type = tr.getAttribute("data-type");
      if (!CACHE) return;

      let t = null;
      if (type === "open") t = (CACHE.open || []).find((x) => String(x.id) === String(id));
      if (type === "closed") t = (CACHE.closed || []).find((x) => String(x.id) === String(id));
      if (!t) return;

      el("detailsBox").innerHTML = details(t);
    };
  }
}

async function load() {
  el("statusLine").textContent = "laden…";
  try {
    const r = await fetch(API, { cache: "no-store" });
    const j = await r.json();
    CACHE = j;

    const open = j.open || [];
    const closed = j.closed || [];

    el("statusLine").textContent =
      `Open trades: ${open.length} • Closed trades: ${closed.length} • Update: ${new Date(j.ts || Date.now()).toLocaleString()}`;

    el("openBox").innerHTML = tableOpen(open);
    el("closedBox").innerHTML = tableClosed(closed);

    bindClicks();
  } catch (e) {
    el("statusLine").textContent = "fout bij laden (check Vercel logs)";
  }
}

load();
setInterval(load, 25000);