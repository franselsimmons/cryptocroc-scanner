#!/usr/bin/env bash
set -euo pipefail

echo "🎨 CryptoCroc – Frontend restore (style + funnel order + OB UI)"

mkdir -p public

# ---------------------------
# public/styles.css
# ---------------------------
cat << 'CSS' > public/styles.css
:root{
  --bg:#0b1220;
  --panel:#121c2f;
  --panel2:#0f1729;
  --border:rgba(255,255,255,.08);
  --text:rgba(255,255,255,.92);
  --muted:rgba(255,255,255,.65);
  --accent:#30d158;
  --warn:#ffd60a;
  --bad:#ff453a;
  --chip:#1b2a45;
}

*{box-sizing:border-box}
body{
  margin:0;
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;
  background: radial-gradient(1200px 600px at 20% 0%, rgba(48,209,88,.18), transparent 55%),
              radial-gradient(1000px 500px at 80% 0%, rgba(10,132,255,.16), transparent 55%),
              var(--bg);
  color:var(--text);
}

.wrap{max-width:1200px;margin:0 auto;padding:22px}
.header{
  display:flex;align-items:center;justify-content:space-between;gap:12px;
  margin-bottom:14px;
}
.brand{
  display:flex;align-items:center;gap:12px;
  font-weight:800;font-size:28px;letter-spacing:.2px
}
.brand .logo{font-size:26px;filter:drop-shadow(0 6px 18px rgba(48,209,88,.28));}
.topbar{
  display:flex;align-items:center;gap:10px;flex-wrap:wrap;
  padding:12px;border:1px solid var(--border);border-radius:14px;
  background:linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.01));
}
.btn{
  border:1px solid var(--border);
  background:rgba(255,255,255,.03);
  color:var(--text);
  padding:9px 12px;border-radius:12px;
  cursor:pointer;
  font-weight:700;
}
.btn:hover{border-color:rgba(255,255,255,.18)}
.btn.primary{
  background:rgba(48,209,88,.16);
  border-color:rgba(48,209,88,.35);
}
.btn.active{
  background:rgba(10,132,255,.18);
  border-color:rgba(10,132,255,.35);
}
.meta{
  margin-left:auto;display:flex;gap:10px;flex-wrap:wrap;align-items:center;
  color:var(--muted);font-size:13px
}
.chip{
  padding:6px 10px;border-radius:999px;
  background:var(--chip);
  border:1px solid var(--border);
}
.panel{
  margin-top:14px;
  border:1px solid var(--border);
  background:rgba(255,255,255,.02);
  border-radius:16px;
  overflow:hidden;
}
.panelHead{
  padding:12px 14px;
  display:flex;align-items:center;justify-content:space-between;gap:10px;
  background:linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.01));
  border-bottom:1px solid var(--border);
}
.panelHead h2{
  margin:0;font-size:15px;letter-spacing:.3px;
  display:flex;align-items:center;gap:10px
}
.count{color:var(--muted);font-weight:700}
.tableWrap{overflow:auto}
table{
  width:100%;
  border-collapse:separate;
  border-spacing:0;
  font-size:13px;
}
th,td{padding:10px 10px;border-bottom:1px solid var(--border);white-space:nowrap}
th{position:sticky;top:0;background:rgba(15,23,41,.96);z-index:2;text-align:left}
tr:hover td{background:rgba(255,255,255,.02)}
.sym{font-weight:900}
.small{color:var(--muted);font-size:12px}
.badge{
  padding:4px 8px;border-radius:999px;
  border:1px solid var(--border);
  background:rgba(255,255,255,.03);
  font-weight:800;font-size:12px;
}
.badge.good{border-color:rgba(48,209,88,.35);background:rgba(48,209,88,.14)}
.badge.warn{border-color:rgba(255,214,10,.35);background:rgba(255,214,10,.14)}
.badge.bad{border-color:rgba(255,69,58,.35);background:rgba(255,69,58,.12)}
.ob{
  display:flex;gap:10px;flex-wrap:wrap;
}
.ob .box{
  padding:8px 10px;border-radius:12px;
  border:1px solid var(--border);
  background:rgba(255,255,255,.02);
  min-width:160px;
}
.footerNote{
  margin-top:12px;color:var(--muted);font-size:12px
}
.err{
  margin-top:12px;
  padding:12px;border-radius:14px;
  border:1px solid rgba(255,69,58,.35);
  background:rgba(255,69,58,.10);
  color:rgba(255,255,255,.9);
  font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size:12px;
  white-space:pre-wrap;
}
CSS

# ---------------------------
# public/app.js
# ---------------------------
cat << 'JS' > public/app.js
const qs = (s, el=document) => el.querySelector(s);
const qsa = (s, el=document) => [...el.querySelectorAll(s)];

const funnelOrder = [
  "SELL",
  "HOLD",
  "ENTRY",
  "ALMOST",
  "BUILDUP",
  "RADAR"
]; // ENTRY boven, RADAR onder (SELL/HOLD helemaal boven)

function fmt(n, d=2){
  if(n === null || n === undefined || Number.isNaN(n)) return "-";
  const x = Number(n);
  return x.toFixed(d);
}

function pct(n, d=2){
  if(n === null || n === undefined || Number.isNaN(n)) return "-";
  const x = Number(n);
  return (x>=0?"+":"") + x.toFixed(d) + "%";
}

function badgeStage(stage){
  const s = (stage||"").toUpperCase();
  if(["HOLD","ENTRY"].includes(s)) return `<span class="badge good">${s}</span>`;
  if(["ALMOST","BUILDUP"].includes(s)) return `<span class="badge warn">${s}</span>`;
  if(["SELL"].includes(s)) return `<span class="badge bad">${s}</span>`;
  return `<span class="badge">${s||"-"}</span>`;
}

// Orderbook UI: verwacht velden zoals ob (object) of orderbook (object).
// We tonen dit alleen bij ALMOST/ENTRY/HOLD/SELL.
function renderOB(coin){
  const stage = (coin.stage || coin.funnel || "").toUpperCase();
  const show = ["ALMOST","ENTRY","HOLD","SELL"].includes(stage);
  if(!show) return `<span class="small">OB: -</span>`;

  const ob = coin.ob || coin.orderbook || null;
  if(!ob) return `<span class="small">OB: (geen data)</span>`;

  const bid = ob.bidImb ?? ob.bid_imb ?? ob.bid ?? null;
  const ask = ob.askImb ?? ob.ask_imb ?? ob.ask ?? null;
  const imb = ob.imbalance ?? ob.imb ?? null;
  const spr = ob.spreadPct ?? ob.spread_pct ?? ob.spread ?? null;

  return `
    <div class="ob">
      <div class="box"><div class="small">Imbalance</div><div><b>${fmt(imb,3)}</b></div></div>
      <div class="box"><div class="small">Bid strength</div><div><b>${fmt(bid,3)}</b></div></div>
      <div class="box"><div class="small">Ask strength</div><div><b>${fmt(ask,3)}</b></div></div>
      <div class="box"><div class="small">Spread</div><div><b>${fmt(spr,3)}%</b></div></div>
    </div>
  `;
}

function rowHtml(c){
  return `
    <tr>
      <td class="sym">${c.symbol || c.sym || "-"}</td>
      <td>${badgeStage(c.stage || c.funnel)}</td>
      <td>${pct(c.ch1h ?? c.pct1h ?? c.p1h)}</td>
      <td>${pct(c.ch24 ?? c.pct24 ?? c.p24)}</td>
      <td>${fmt(c.vm ?? c.vmRatio ?? c.vm_ratio, 3)}</td>
      <td>${fmt(c.range ?? c.rangePct ?? c.range_pct, 2)}%</td>
      <td>${fmt(c.score ?? c.score100 ?? c.s, 1)}</td>
      <td>${renderOB(c)}</td>
    </tr>
  `;
}

function normalizeData(raw){
  // Ondersteun verschillende API outputs:
  // - { ok:true, data:{ RADAR:[], BUILDUP:[], ... } }
  // - { ok:true, funnel:{ ... } }
  // - { ok:true, coins:[...] } (met stage per coin)
  // - direct array
  if(Array.isArray(raw)) return { buckets: { ALL: raw } };

  const obj = raw?.data ?? raw ?? {};
  const buckets = obj.funnel ?? obj.buckets ?? obj.stages ?? obj;
  // Als buckets al stage arrays heeft:
  const hasStages = buckets && funnelOrder.some(k => Array.isArray(buckets[k]));
  if(hasStages) return { buckets };

  const coins = obj.coins ?? obj.items ?? obj.list ?? [];
  if(Array.isArray(coins)){
    // bucket per coin.stage
    const out = {};
    for(const c of coins){
      const st = (c.stage || c.funnel || "RADAR").toUpperCase();
      out[st] = out[st] || [];
      out[st].push(c);
    }
    return { buckets: out };
  }

  return { buckets: { RADAR: [] } };
}

async function load(side){
  const api = side === "bear" ? "/api/top10_bear" : "/api/top10";
  qs("#sideLabel").textContent = side.toUpperCase();

  qs("#error").style.display="none";
  qs("#error").textContent="";

  const t0 = Date.now();
  const res = await fetch(api, { cache:"no-store" });
  const json = await res.json().catch(()=> ({}));
  const ms = Date.now()-t0;

  if(!res.ok || json.ok === false){
    qs("#error").style.display="block";
    qs("#error").textContent = JSON.stringify(json, null, 2);
    qs("#meta").innerHTML = `<span class="chip">API: ${api}</span><span class="chip">status: ${res.status}</span><span class="chip">${ms}ms</span>`;
    qs("#content").innerHTML = "";
    return;
  }

  const { buckets } = normalizeData(json);
  const next = json.nextScanIn ?? json.next ?? json.next_scan_in ?? null;

  qs("#meta").innerHTML = `
    <span class="chip">API: ${api}</span>
    <span class="chip">laadtijd: ${ms}ms</span>
    ${next ? `<span class="chip">next: ${next}s</span>` : ``}
  `;

  const sections = [];
  for(const stage of funnelOrder){
    const arr = Array.isArray(buckets[stage]) ? buckets[stage] : [];
    sections.push(`
      <div class="panel">
        <div class="panelHead">
          <h2>${stage} <span class="count">(${arr.length})</span></h2>
          <div class="small">ENTRY boven / RADAR onder</div>
        </div>
        <div class="tableWrap">
          <table>
            <thead>
              <tr>
                <th>COIN</th>
                <th>STAGE</th>
                <th>1H</th>
                <th>24H</th>
                <th>VM</th>
                <th>RANGE</th>
                <th>SCORE</th>
                <th>ORDERBOOK</th>
              </tr>
            </thead>
            <tbody>
              ${arr.map(rowHtml).join("") || `<tr><td colspan="8" class="small">Geen coins in ${stage}</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    `);
  }

  qs("#content").innerHTML = sections.join("");
}

async function scanNow(){
  // Als je API een /api/scan endpoint heeft met secret, laten we het hier simpel:
  // we herladen alleen (jij hebt ook een knop “Scan nu”).
  const side = qs("#btnBear").classList.contains("active") ? "bear" : "bull";
  await load(side);
}

function setActive(side){
  const b1 = qs("#btnBull");
  const b2 = qs("#btnBear");
  b1.classList.toggle("active", side==="bull");
  b2.classList.toggle("active", side==="bear");
}

window.addEventListener("DOMContentLoaded", async () => {
  qs("#btnBull").addEventListener("click", async ()=>{ setActive("bull"); await load("bull"); });
  qs("#btnBear").addEventListener("click", async ()=>{ setActive("bear"); await load("bear"); });
  qs("#btnScan").addEventListener("click", scanNow);

  setActive("bull");
  await load("bull");
});
JS

# ---------------------------
# public/index.html
# ---------------------------
cat << 'HTML' > public/index.html
<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>CryptoCroc Scanner</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <div class="wrap">
    <div class="header">
      <div class="brand"><span class="logo">🐊</span> CryptoCroc Scanner</div>
      <div class="small">BULL/BEAR + funnel + orderbook</div>
    </div>

    <div class="topbar">
      <button id="btnBull" class="btn active">BULL</button>
      <button id="btnBear" class="btn">BEAR</button>
      <button id="btnScan" class="btn primary">Scan nu</button>

      <div class="meta" id="meta">
        <span class="chip">side: <b id="sideLabel">BULL</b></span>
      </div>
    </div>

    <div id="error" class="err" style="display:none"></div>

    <div id="content"></div>

    <div class="footerNote">
      Orderbook wordt alleen getoond bij ALMOST/ENTRY/HOLD/SELL. (Als je API OB levert.)
    </div>
  </div>

  <script src="/app.js"></script>
</body>
</html>
HTML

# ---------------------------
# Commit + push
# ---------------------------
git add public vercel.json package.json || true
git commit -m "feat: restore styled frontend + funnel order (entry top) + orderbook UI" || true
git push

echo "✅ Klaar. Vercel zal nu opnieuw deployen."
