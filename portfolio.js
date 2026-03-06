const el = (id) => document.getElementById(id);

const API = "/api/portfolio/latest";

el("refreshBtn").onclick = () => load();

function fmt(n){ return (Number(n)||0).toFixed(2); }
function pct(n){ n=Number(n)||0; const s=n>=0?"+":""; return s+fmt(n)+"%"; }

function pill(txt){ return `<span class="pill">${txt}</span>`; }

function pnlSpan(n){
  n = Number(n)||0;
  const cls = n>=0 ? "pnlPos" : "pnlNeg";
  return `<span class="${cls}">${pct(n)}</span>`;
}

function usd6(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "0.000000";
  return v.toFixed(6);
}

function rowOpen(t){
  return `
  <tr data-id="${t.id}" data-type="open">
    <td><b>${t.symbol}</b><div class="muted">${t.funnel} • ${String(t.mode||"").toUpperCase()}</div></td>
    <td>$${usd6(t.entryPrice)}</td>
    <td>$${usd6(t.lastPrice)}</td>
    <td>${pnlSpan(t.pnlPct)}</td>
    <td>${pill("OPEN")}</td>
  </tr>`;
}

function rowClosed(t){
  return `
  <tr data-id="${t.id}" data-type="closed">
    <td><b>${t.symbol}</b><div class="muted">${t.funnel} • ${String(t.mode||"").toUpperCase()}</div></td>
    <td>$${usd6(t.entryPrice)} → $${usd6(t.exitPrice)}</td>
    <td>${pnlSpan(t.pnlPct)}</td>
    <td class="muted">${t.exitReason || ""}</td>
  </tr>`;
}

function tableOpen(list){
  if(!list || !list.length) return `<div class="empty">Geen open trades.</div>`;
  return `
  <table class="table">
    <thead><tr>
      <th>Coin</th><th>Entry</th><th>Last</th><th>PnL</th><th>Status</th>
    </tr></thead>
    <tbody>${list.map(rowOpen).join("")}</tbody>
  </table>`;
}

function tableClosed(list){
  if(!list || !list.length) return `<div class="empty">Nog geen closed trades.</div>`;
  return `
  <table class="table">
    <thead><tr>
      <th>Coin</th><th>Entry → Exit</th><th>PnL</th><th>Reason</th>
    </tr></thead>
    <tbody>${list.map(rowClosed).join("")}</tbody>
  </table>`;
}

function details(t){
  const entry = t.entryMeta || {};
  const live = t.liveMeta || {};

  return `
  <div class="panelHint"><b>${t.symbol}</b> • ${t.funnel} • ${String(t.mode||"").toUpperCase()} • ${t.status}</div>
  <pre>
ENTRY
- price: $${usd6(t.entryPrice)}
- confidence: ${entry.confidence ?? "-"}
- vm: ${fmt(entry.vm || 0)}
- obScore: ${fmt(entry.obScore || 0)}
- spread: ${fmt(entry.spreadPct || 0)}%
- depth1%: $${Math.round(Number(entry.depthMinUsd1p || 0)).toLocaleString()}
- gate: ${entry.entryGate || "-"}

LIVE
- stage: ${live.stage || "-"}
- obStatus: ${live.obStatus || "-"}
- obReason: ${live.obReason || "-"}
  </pre>`;
}

let CACHE = null;

function bindClicks(){
  const rows = document.querySelectorAll("table.table tbody tr");
  for(const tr of rows){
    tr.onclick = () => {
      const id = tr.getAttribute("data-id");
      const type = tr.getAttribute("data-type");
      if(!CACHE) return;

      let t = null;
      if(type === "open") t = (CACHE.open || []).find(x => x.id === id);
      if(type === "closed") t = (CACHE.closed || []).find(x => x.id === id);
      if(!t) return;

      el("detailsBox").innerHTML = details(t);
    };
  }
}

async function load(){
  el("statusLine").textContent = "laden…";
  try{
    const r = await fetch(API, { cache:"no-store" });
    const j = await r.json();
    CACHE = j;

    const open = j.open || [];
    const closed = j.closed || [];

    el("statusLine").textContent =
      `Open trades: ${open.length} • Closed trades: ${closed.length} • Update: ${new Date(j.ts||Date.now()).toLocaleString()}`;

    el("openBox").innerHTML = tableOpen(open);
    el("closedBox").innerHTML = tableClosed(closed);

    bindClicks();
  }catch(e){
    el("statusLine").textContent = "fout bij laden (check Vercel logs)";
  }
}

load();
setInterval(load, 25000);