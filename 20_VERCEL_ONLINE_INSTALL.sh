#!/usr/bin/env bash
set -e

echo "== CryptoCroc -> Vercel Online install =="

mkdir -p api public

# -----------------------------
# 1) package.json (vercel serverless)
# -----------------------------
cat << 'EOP' > package.json
{
  "name": "cryptocroc-scanner",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vercel dev",
    "start": "node -e \"console.log('Use Vercel. Locally: npm run dev (vercel dev)')\""
  },
  "dependencies": {
    "@vercel/kv": "^2.0.0"
  }
}
EOP

# -----------------------------
# 2) .gitignore (geen rommel in GitHub)
# -----------------------------
cat << 'EOG' > .gitignore
node_modules
.vercel
cryptocroc-terminal/output
*.log
.DS_Store
EOG

# -----------------------------
# 3) vercel.json (cron + routes)
# -----------------------------
cat << 'EOV' > vercel.json
{
  "crons": [
    { "path": "/api/scan", "schedule": "*/10 * * * *" }
  ],
  "headers": [
    {
      "source": "/api/(.*)",
      "headers": [
        { "key": "Cache-Control", "value": "no-store" }
      ]
    }
  ]
}
EOV

# -----------------------------
# 4) tiny redirect pages (zodat /bull en /bear werken)
# -----------------------------
cat << 'EOR' > public/bull.html
<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=/#bull"></head><body></body></html>
EOR
cat << 'EOR' > public/bear.html
<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=/#bear"></head><body></body></html>
EOR

# -----------------------------
# 5) public/index.html (zelfde UI entry)
# (jij had deze al, maar we zetten hem hier “zeker goed” neer)
# -----------------------------
cat << 'EOH' > public/index.html
<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>CryptoCroc Scanner</title>
  <link rel="stylesheet" href="/styles.css"/>
</head>
<body>
  <header class="top">
    <div class="brand">
      <div class="logo">🐊</div>
      <div>
        <div class="title">CryptoCroc Scanner</div>
        <div class="sub">ENTRY boven — RADAR onder • regime + engines • portfolio enforced</div>
      </div>
    </div>

    <div class="tabs">
      <button id="tabBull" class="tab">BULL</button>
      <button id="tabBear" class="tab">BEAR</button>
      <button id="btnRefresh" class="ghost">Refresh</button>
      <a class="ghost" href="/bull.html">/bull</a>
      <a class="ghost" href="/bear.html">/bear</a>
    </div>

    <div class="status">
      <div id="ts" class="pill">loading…</div>
      <div id="reg" class="pill">regime…</div>
      <div id="counts" class="pill">…</div>
      <div id="port" class="pill">portfolio…</div>
    </div>
  </header>

  <main class="wrap">
    <section id="tables"></section>
  </main>

  <div id="modal" class="modal hidden">
    <div class="modalCard">
      <div class="modalHead">
        <div id="mTitle" class="mTitle"></div>
        <button id="mClose" class="x">✕</button>
      </div>
      <div id="mBody" class="mBody"></div>
    </div>
  </div>

  <script src="/app.js"></script>
</body>
</html>
EOH

# -----------------------------
# 6) public/styles.css (als je die al had: mag overschreven worden)
# -----------------------------
cat << 'EOC' > public/styles.css
:root{
  --bg:#0b1220; --card:#0f1a33; --card2:#0c152b;
  --text:#e7ecff; --muted:#a9b3d6; --line:rgba(255,255,255,.08);
  --good:#33d17a; --bad:#ff4d4d;
}
*{ box-sizing:border-box; }
html,body{ height:100%; }
body{
  margin:0;
  background:linear-gradient(180deg,#070b14,var(--bg));
  color:var(--text);
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;
}
.wrap{ max-width:1200px; margin:0 auto; padding:16px; }
.top{
  position:sticky; top:0;
  backdrop-filter: blur(10px);
  background:rgba(7,11,20,.75);
  border-bottom:1px solid var(--line);
  padding:14px 16px;
  display:flex; gap:12px; align-items:center; justify-content:space-between;
}
.brand{ display:flex; gap:10px; align-items:center; }
.logo{
  width:42px;height:42px;border-radius:12px;
  display:grid;place-items:center;
  background:linear-gradient(180deg,#1b2a55,#0c152b);
  border:1px solid var(--line);
}
.title{ font-weight:800; letter-spacing:.3px; }
.sub{ color:var(--muted); font-size:12px; margin-top:2px; }
.tabs{ display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.tab,.ghost{
  border:1px solid var(--line);
  background:rgba(255,255,255,.04);
  color:var(--text);
  padding:10px 12px;
  border-radius:12px;
  cursor:pointer;
  text-decoration:none;
}
.tab.active{
  background:linear-gradient(180deg,#1b2a55,#0c152b);
  border-color:rgba(120,160,255,.35);
}
.status{ display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end; }
.pill{
  padding:8px 10px; border-radius:999px;
  border:1px solid var(--line);
  background:rgba(255,255,255,.04);
  color:var(--muted); font-size:12px;
}
.block{
  margin-top:14px;
  background:linear-gradient(180deg,var(--card),var(--card2));
  border:1px solid var(--line);
  border-radius:18px; overflow:hidden;
}
.blockHead{
  padding:12px 14px;
  display:flex; align-items:center; justify-content:space-between;
  border-bottom:1px solid var(--line);
}
.blockTitle{ font-weight:800; }
.blockHint{ color:var(--muted); font-size:12px; }
.table{ width:100%; border-collapse:collapse; }
th,td{ padding:10px 12px; border-bottom:1px solid var(--line); font-size:13px; }
th{ color:var(--muted); font-weight:600; text-align:left; }
.row{ cursor:pointer; }
.row:hover{ background:rgba(255,255,255,.04); }
.badge{
  display:inline-flex; align-items:center; gap:6px;
  padding:4px 8px; border-radius:999px;
  border:1px solid var(--line);
  background:rgba(255,255,255,.04);
  color:var(--muted); font-size:12px;
}
.good{ color:var(--good); }
.bad{ color:var(--bad); }
.pb{
  width:110px;height:10px;border-radius:999px;
  background:rgba(255,255,255,.08);
  overflow:hidden; border:1px solid var(--line);
}
.pb > i{ display:block;height:100%; background:linear-gradient(90deg,#2b6cff,#33d17a); width:0%; }
.modal{
  position:fixed; inset:0;
  background:rgba(0,0,0,.55);
  display:grid; place-items:center;
  padding:16px;
}
.hidden{ display:none; }
.modalCard{
  width:min(900px,100%);
  background:linear-gradient(180deg,var(--card),var(--card2));
  border:1px solid var(--line);
  border-radius:18px; overflow:hidden;
}
.modalHead{
  display:flex; justify-content:space-between; align-items:center;
  padding:14px; border-bottom:1px solid var(--line);
}
.mTitle{ font-weight:900; }
.x{
  border:1px solid var(--line);
  background:rgba(255,255,255,.04);
  color:var(--text);
  border-radius:10px;
  padding:8px 10px;
  cursor:pointer;
}
.mBody{ padding:14px; }
.grid{
  display:grid;
  grid-template-columns:repeat(3, minmax(0,1fr));
  gap:10px;
}
.card{
  border:1px solid var(--line);
  background:rgba(255,255,255,.03);
  border-radius:14px;
  padding:10px;
}
.k{ color:var(--muted); font-size:12px; }
.v{ font-weight:800; margin-top:4px; }
.note{ margin-top:10px; color:var(--muted); font-size:12px; line-height:1.4; }
EOC

# -----------------------------
# 7) public/app.js (UI + portfolio + allow/suppress + open/close)
# (zelfde als jouw portfolio UI, maar nu 100% Vercel routes)
# -----------------------------
cat << 'EOJ' > public/app.js
const API = { bull:"/api/bull", bear:"/api/bear", portfolio:"/api/portfolio", action:"/api/action" };
let SIDE = (location.hash === "#bear") ? "bear" : "bull";

const $ = (s)=>document.querySelector(s);
const elTables = $("#tables");
const elTs = $("#ts");
const elReg = $("#reg");
const elCounts = $("#counts");
const elPort = $("#port");

let PORTFOLIO = null;

$("#tabBull").onclick = ()=>setSide("bull");
$("#tabBear").onclick = ()=>setSide("bear");
$("#btnRefresh").onclick = ()=>load();

function setSide(s){
  SIDE = s;
  location.hash = s==="bear" ? "#bear" : "#bull";
  renderTabs();
  load();
}
function renderTabs(){
  $("#tabBull").classList.toggle("active", SIDE==="bull");
  $("#tabBear").classList.toggle("active", SIDE==="bear");
}

function fmtMoney(x){
  if(x==null || !Number.isFinite(x)) return "—";
  const abs = Math.abs(x);
  if(abs >= 1e9) return (x/1e9).toFixed(2)+"B";
  if(abs >= 1e6) return (x/1e6).toFixed(2)+"M";
  if(abs >= 1e3) return (x/1e3).toFixed(2)+"K";
  return x.toFixed(2);
}
function fmtPct(x){
  if(x==null || !Number.isFinite(x)) return "—";
  return (x>=0?"+":"") + x.toFixed(2) + "%";
}
function clsPct(x){ return (x!=null && Number.isFinite(x)) ? (x>=0 ? "good" : "bad") : ""; }
function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }

function progress(stage, scansInStage, totalScans){
  if(stage==="RADAR") return clamp((scansInStage/2)*100, 5, 100);
  if(stage==="BUILDUP") return clamp((scansInStage/3)*100, 5, 100);
  if(stage==="ALMOST") return clamp((totalScans/5)*100, 5, 100);
  if(stage==="ENTRY") return 100;
  return 10;
}

function openRiskPct(sizePct, stopPct){
  if(!Number.isFinite(sizePct) || !Number.isFinite(stopPct)) return null;
  return (sizePct * Math.abs(stopPct)) / 100;
}

function findOpenPos(symbol){
  const p = PORTFOLIO;
  if(!p?.positions) return null;
  return p.positions.find(x=>x.isOpen && x.symbol===symbol) || null;
}

async function refreshPortfolio(){
  try{
    const r = await fetch(API.portfolio, { cache:"no-store" });
    PORTFOLIO = await r.json();
  }catch{
    PORTFOLIO = null;
  }

  if(!PORTFOLIO){
    elPort.textContent = "portfolio: —";
    return;
  }

  const cur = Number(PORTFOLIO.currentBalance ?? 0);
  const peak = Number(PORTFOLIO.peakBalance ?? cur);
  const dd = (peak>0) ? ((cur-peak)/peak)*100 : 0;
  const open = (PORTFOLIO.positions||[]).filter(x=>x.isOpen).length;
  const openRisk = (PORTFOLIO.positions||[]).filter(x=>x.isOpen).reduce((s,x)=> s + (Number(x.openRiskPct)||0), 0);

  elPort.textContent = `bal: ${cur.toFixed(2)} | open: ${open} | risk: ${openRisk.toFixed(2)}% | DD: ${dd.toFixed(2)}%`;
}

function block(title, hint, rows){
  const wrap = document.createElement("div");
  wrap.className="block";

  const head = document.createElement("div");
  head.className="blockHead";
  head.innerHTML = `<div class="blockTitle">${title}</div><div class="blockHint">${hint}</div>`;
  wrap.appendChild(head);

  const table = document.createElement("table");
  table.className="table";
  table.innerHTML = `
    <thead>
      <tr>
        <th>Coin</th><th>Engine</th><th>24h</th><th>MCAP</th><th>VOL</th><th>VM</th><th>OB</th>
        <th>Size</th><th>Gate</th><th>Progress</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tb = table.querySelector("tbody");

  for(const r of rows){
    const tr = document.createElement("tr");
    tr.className="row";
    tr.onclick = ()=>openModal(r);

    const obScore = r?.ob?.score;
    const obTxt = (obScore==null || !Number.isFinite(obScore)) ? "n/a" : obScore.toFixed(3);
    const obCls = (obScore==null || !Number.isFinite(obScore)) ? "" : (obScore>=0 ? "good":"bad");

    const p = progress(r.finalStage, r.scansInStage, r.totalScans);

    const size = r?.risk?.suggestedSizePct;
    const sizeTxt = (size!=null && Number.isFinite(size)) ? (size+"%") : "—";

    const gate = r?.risk?.gate || "—";
    const gateCls = (gate==="ALLOW") ? "good" : (gate==="SUPPRESS" ? "bad" : "");

    tr.innerHTML = `
      <td><span class="badge">${r.symbol}</span> ${r.name}</td>
      <td><span class="badge">${r.engine || "—"}</span></td>
      <td class="${clsPct(r.ch24)}">${fmtPct(r.ch24)}</td>
      <td>${fmtMoney(r.mcap)}</td>
      <td>${fmtMoney(r.vol24h)}</td>
      <td>${r.vm!=null? r.vm.toFixed(3):"—"}</td>
      <td class="${obCls}">${obTxt}</td>
      <td><span class="badge">${sizeTxt}</span></td>
      <td class="${gateCls}">${gate}</td>
      <td><span class="pb"><i style="width:${p}%"></i></span></td>
    `;
    tb.appendChild(tr);
  }

  wrap.appendChild(table);
  return wrap;
}

function explainLines(r){
  const lines = [
    ["Stage", r.finalStage, "Waar de coin nu zit in de trechter."],
    ["Regime", r.regime || "—", "HIGH_VOL = wild, GRIND = rustiger."],
    ["Engine", r.engine || "—", "EXPLOSIE = volume versnelling, ACCUMULATIE = strak/flat."],
    ["Gate", r?.risk?.gate || "—", "ALLOW = mag openen. SUPPRESS = geblokkeerd door regels."],
    ["Gate reden", r?.risk?.gateReason || "—", "Waarom hij wel/niet mag."],
    ["Suggested size", (r?.risk?.suggestedSizePct!=null? r.risk.suggestedSizePct+"%":"—"), "Hoeveel % van je trade-budget."],
    ["Stoploss", r?.tradePlan?.stopPct!=null? r.tradePlan.stopPct+"%":"—", "Hard stop in % vanaf entry."],
    ["BE at", r?.tradePlan?.beAtPct!=null? r.tradePlan.beAtPct+"%":"—", "Bij winst: SL naar BE."],
    ["TP1", r?.tradePlan?.tp1Pct!=null? r.tradePlan.tp1Pct+"%":"—", "Hier neem je 30% winst."],
    ["Total scans", r.totalScans, "Hoe vaak we ‘m zagen."],
    ["Consistency", r.consistency!=null ? Math.round(r.consistency*100)+"%" : "—", "Stabiliteit laatste scans."],
    ["Vol acceleration", r.volAcceleration!=null ? Math.round(r.volAcceleration*100)+"%" : "—", "Volume versnelling."],
    ["Explain", r.explain || "—", "Waarom hij hier zit / wat hij mist."]
  ];

  if(r.ob){
    lines.push(["OB score", r.ob.score!=null ? r.ob.score.toFixed(3) : "—", "Orderbook druk."]);
    lines.push(["Spread", r.ob.spreadPct!=null ? r.ob.spreadPct.toFixed(3)+"%" : "—", "Bid/ask verschil."]);
  } else {
    lines.push(["Orderbook", "n/a", "Geen USDT spot pair of OB call faalde."]);
  }

  return lines;
}

function actionButtons(r){
  const wrap = document.createElement("div");
  wrap.style.display="flex";
  wrap.style.gap="10px";
  wrap.style.marginTop="12px";
  wrap.style.flexWrap="wrap";

  const openPos = findOpenPos(r.symbol);

  const btnOpen = document.createElement("button");
  btnOpen.className="ghost";
  btnOpen.textContent = openPos ? "OPEN (al open)" : "OPEN trade";
  btnOpen.disabled = !!openPos || r?.risk?.gate !== "ALLOW";
  btnOpen.onclick = async ()=>{
    const payload = {
      action:"OPEN",
      symbol:r.symbol, side:r.side, engine:r.engine,
      entryPrice:r.price,
      sizePct:Number(r?.risk?.suggestedSizePct),
      stopPct:Number(r?.tradePlan?.stopPct),
      tp1Pct:Number(r?.tradePlan?.tp1Pct),
      beAtPct:Number(r?.tradePlan?.beAtPct)
    };

    const resp = await fetch(API.action, { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(payload) });
    const j = await resp.json().catch(()=>({ ok:false, error:"bad json" }));
    if(!j.ok){ alert("OPEN mislukt: " + j.error); return; }
    await refreshPortfolio();
    alert("OPEN gelukt ✅");
    load();
  };

  const btnClose = document.createElement("button");
  btnClose.className="ghost";
  btnClose.textContent = openPos ? "CLOSE trade" : "CLOSE (geen open)";
  btnClose.disabled = !openPos;
  btnClose.onclick = async ()=>{
    const exit = prompt("Exit prijs (nummer):", String(r.price));
    const exitPrice = Number(exit);
    if(!Number.isFinite(exitPrice) || exitPrice<=0){ alert("Ongeldige prijs"); return; }

    const payload = { action:"CLOSE", id: openPos.id, exitPrice };
    const resp = await fetch(API.action, { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(payload) });
    const j = await resp.json().catch(()=>({ ok:false, error:"bad json" }));
    if(!j.ok){ alert("CLOSE mislukt: " + j.error); return; }
    await refreshPortfolio();
    alert("CLOSE gelukt ✅");
    load();
  };

  const rr = document.createElement("div");
  rr.className="pill";
  const or = openRiskPct(Number(r?.risk?.suggestedSizePct), Number(r?.tradePlan?.stopPct));
  rr.textContent = (or!=null) ? `Open risk: ${or.toFixed(2)}%` : "Open risk: —";

  wrap.appendChild(btnOpen);
  wrap.appendChild(btnClose);
  wrap.appendChild(rr);
  return wrap;
}

function openModal(r){
  $("#modal").classList.remove("hidden");
  $("#mTitle").textContent = `${r.symbol} • ${r.name} • ${r.finalStage}`;

  const grid = document.createElement("div");
  grid.className="grid";

  for(const [k,v,desc] of explainLines(r)){
    const c = document.createElement("div");
    c.className="card";
    c.innerHTML = `<div class="k">${k}</div><div class="v">${v}</div><div class="note">${desc}</div>`;
    grid.appendChild(c);
  }

  const body = $("#mBody");
  body.innerHTML = "";
  body.appendChild(grid);
  body.appendChild(actionButtons(r));
}

$("#mClose").onclick = ()=>$("#modal").classList.add("hidden");
$("#modal").onclick = (e)=>{ if(e.target.id==="modal") $("#modal").classList.add("hidden"); };

async function load(){
  renderTabs();
  elTables.innerHTML = "";
  await refreshPortfolio();

  const url = SIDE==="bull" ? API.bull : API.bear;

  let data;
  try{
    const r = await fetch(url, { cache:"no-store" });
    data = await r.json();
  }catch{
    elTables.textContent = "Kan data niet laden. Check of /api/scan al gedraaid heeft.";
    return;
  }

  elTs.textContent = data?.ts ? `Last scan: ${data.ts}` : "Last scan: —";
  elReg.textContent = data?.regime?.regime ? `Regime: ${data.regime.regime}` : "Regime: —";

  const t = data?.tables || {};
  const total =
    (t.entry_entry?.length||0)+(t.entry_hold?.length||0)+(t.entry_sell?.length||0)+
    (t.almost?.length||0)+(t.buildup?.length||0)+(t.radar?.length||0);

  elCounts.textContent = `Coins in view: ${total}`;

  elTables.appendChild(block("ENTRY • ENTRY", "Actie (ALLOW/SUPPRESS + sizing%)", t.entry_entry||[]));
  elTables.appendChild(block("ENTRY • HOLD", "Sterk – vasthouden", t.entry_hold||[]));
  elTables.appendChild(block("ENTRY • SELL", "Niet doen / exit waarschuwing", t.entry_sell||[]));
  elTables.appendChild(block("ALMOST", "Bijna klaar (OB check actief)", t.almost||[]));
  elTables.appendChild(block("BUILDUP", "Bevestiging aan het bouwen", t.buildup||[]));
  elTables.appendChild(block("RADAR", "Nieuwe/early kandidaten", t.radar||[]));
}

load();
EOJ

# -----------------------------
# 8) api storage helpers + endpoints
# -----------------------------
cat << 'EOS' > api/_store.js
import { kv } from "@vercel/kv";

export const KEYS = {
  bull: "cryptocroc:bull",
  bear: "cryptocroc:bear",
  memory: "cryptocroc:memory",
  portfolio: "cryptocroc:portfolio",
  trades: "cryptocroc:trades"
};

export async function getJson(key, fallback=null){
  const v = await kv.get(key);
  return v ?? fallback;
}
export async function setJson(key, obj){
  await kv.set(key, obj);
}
export async function pushTrade(lineObj){
  // trades als array (simpel en betrouwbaar)
  const arr = (await kv.get(KEYS.trades)) ?? [];
  arr.push(lineObj);
  // cap op 2000 regels
  if(arr.length > 2000) arr.splice(0, arr.length-2000);
  await kv.set(KEYS.trades, arr);
}
export async function ensurePortfolio(){
  let p = await kv.get(KEYS.portfolio);
  if(!p){
    p = {
      version:1,
      baseCurrency:"USD",
      startingBalance:1000,
      currentBalance:1000,
      peakBalance:1000,
      maxDrawdownPct:-8,
      maxTotalOpenRiskPct:4,
      maxOpenExplosie:2,
      maxOpenAccu:3,
      positions:[]
    };
    await kv.set(KEYS.portfolio, p);
  }
  let t = await kv.get(KEYS.trades);
  if(!t) await kv.set(KEYS.trades, []);
  return p;
}
EOS

cat << 'EOS' > api/bull.js
import { getJson, KEYS } from "./_store.js";
export default async function handler(req,res){
  const data = await getJson(KEYS.bull, null);
  if(!data) return res.status(404).json({ error:"no data yet - run /api/scan once" });
  res.setHeader("Cache-Control","no-store");
  return res.status(200).json(data);
}
EOS

cat << 'EOS' > api/bear.js
import { getJson, KEYS } from "./_store.js";
export default async function handler(req,res){
  const data = await getJson(KEYS.bear, null);
  if(!data) return res.status(404).json({ error:"no data yet - run /api/scan once" });
  res.setHeader("Cache-Control","no-store");
  return res.status(200).json(data);
}
EOS

cat << 'EOS' > api/portfolio.js
import { ensurePortfolio, getJson, KEYS } from "./_store.js";
export default async function handler(req,res){
  await ensurePortfolio();
  const p = await getJson(KEYS.portfolio, {});
  res.setHeader("Cache-Control","no-store");
  return res.status(200).json(p);
}
EOS

cat << 'EOS' > api/trades.js
import { ensurePortfolio, getJson, KEYS } from "./_store.js";
export default async function handler(req,res){
  await ensurePortfolio();
  const t = await getJson(KEYS.trades, []);
  res.setHeader("Cache-Control","no-store");
  return res.status(200).json(t);
}
EOS

cat << 'EOS' > api/action.js
import { ensurePortfolio, getJson, setJson, pushTrade, KEYS } from "./_store.js";

function ddPct(port){
  const peak = Number(port?.peakBalance ?? port?.currentBalance ?? 0);
  const cur  = Number(port?.currentBalance ?? 0);
  if(peak<=0) return 0;
  return ((cur-peak)/peak)*100;
}

export default async function handler(req,res){
  res.setHeader("Cache-Control","no-store");
  if(req.method !== "POST") return res.status(405).json({ ok:false, error:"POST only" });

  const body = req.body || {};
  await ensurePortfolio();
  const port = await getJson(KEYS.portfolio, null);
  if(!port) return res.status(500).json({ ok:false, error:"portfolio missing" });

  try{
    if(body.action==="OPEN"){
      const price = Number(body.entryPrice);
      const sizePct = Number(body.sizePct);
      const stopPct = Number(body.stopPct);

      if(!Number.isFinite(price) || price<=0) throw new Error("entryPrice ongeldig");
      if(!Number.isFinite(sizePct) || sizePct<=0) throw new Error("sizePct ongeldig");
      if(!Number.isFinite(stopPct) || stopPct>=0) throw new Error("stopPct moet negatief zijn");

      const dd = ddPct(port);
      if(dd <= (port.maxDrawdownPct ?? -8)) throw new Error("DD kill switch actief");

      const positions = Array.isArray(port.positions) ? port.positions : [];
      const open = positions.filter(p=>p.isOpen);

      const openExpl = open.filter(p=>p.engine==="EXPLOSIE").length;
      const openAcc  = open.filter(p=>p.engine==="ACCUMULATIE").length;

      if(body.engine==="EXPLOSIE" && openExpl >= (port.maxOpenExplosie ?? 2)) throw new Error("Max EXPLOSIE trades bereikt");
      if(body.engine==="ACCUMULATIE" && openAcc >= (port.maxOpenAccu ?? 3)) throw new Error("Max ACCUMULATIE trades bereikt");

      const openRiskPct = (sizePct * Math.abs(stopPct)) / 100;
      const totalOpenRiskPct = open.reduce((s,p)=> s + (Number(p.openRiskPct)||0), 0);
      const maxTotal = Number(port.maxTotalOpenRiskPct ?? 4);

      if(totalOpenRiskPct + openRiskPct > maxTotal){
        throw new Error(`Max open risk overschreden (${(totalOpenRiskPct+openRiskPct).toFixed(2)}% > ${maxTotal}%)`);
      }

      const id = "pos_" + Math.random().toString(16).slice(2) + "_" + Date.now();
      const pos = {
        id,
        tsOpen: new Date().toISOString(),
        symbol: String(body.symbol||"").toUpperCase(),
        side: body.side,
        engine: body.engine,
        entryPrice: price,
        sizePct,
        stopPct,
        tp1Pct: Number(body.tp1Pct),
        beAtPct: Number(body.beAtPct),
        openRiskPct: Number(openRiskPct.toFixed(3)),
        isOpen: true
      };

      port.positions = positions.concat([pos]);
      port.peakBalance = Math.max(Number(port.peakBalance ?? port.currentBalance ?? 0), Number(port.currentBalance ?? 0));

      await setJson(KEYS.portfolio, port);
      await pushTrade({ type:"OPEN", ...pos });

      return res.status(200).json({ ok:true, portfolio:port });
    }

    if(body.action==="CLOSE"){
      const id = String(body.id||"");
      const exitPrice = Number(body.exitPrice);
      if(!id) throw new Error("id ontbreekt");
      if(!Number.isFinite(exitPrice) || exitPrice<=0) throw new Error("exitPrice ongeldig");

      const positions = Array.isArray(port.positions) ? port.positions : [];
      const idx = positions.findIndex(p=>p.id===id && p.isOpen);
      if(idx<0) throw new Error("Open positie niet gevonden");

      const p = positions[idx];
      const entry = Number(p.entryPrice);
      const dir = (p.side==="BULL") ? 1 : -1;

      const pnlPct = ((exitPrice-entry)/entry)*100*dir;
      const impactPct = (Number(p.sizePct) * pnlPct) / 100;

      const cur = Number(port.currentBalance ?? 0);
      const newBal = cur * (1 + impactPct/100);

      positions[idx] = { ...p,
        tsClose:new Date().toISOString(),
        exitPrice,
        pnlPct:Number(pnlPct.toFixed(3)),
        accountImpactPct:Number(impactPct.toFixed(3)),
        isOpen:false
      };

      port.positions = positions;
      port.currentBalance = Number(newBal.toFixed(2));
      port.peakBalance = Math.max(Number(port.peakBalance ?? port.currentBalance ?? 0), port.currentBalance);

      await setJson(KEYS.portfolio, port);
      await pushTrade({ type:"CLOSE", id, symbol:p.symbol, side:p.side, engine:p.engine, entryPrice:entry, exitPrice, pnlPct:Number(pnlPct.toFixed(3)), accountImpactPct:Number(impactPct.toFixed(3)), ts:new Date().toISOString() });

      return res.status(200).json({ ok:true, portfolio:port });
    }

    return res.status(400).json({ ok:false, error:"Unknown action" });
  }catch(e){
    return res.status(400).json({ ok:false, error:String(e.message||e) });
  }
}
EOS

# -----------------------------
# 9) api/scan.js
# BELANGRIJK: dit is de “cron runner”.
# We doen hier bewust “best effort”: bij CG 429 niet crashen maar oude output laten staan.
# -----------------------------
cat << 'EOS' > api/scan.js
import { getJson, setJson, ensurePortfolio, KEYS } from "./_store.js";

const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));
const n = (x)=> { const v = Number(x); return Number.isFinite(v) ? v : null; };
const nowIso = ()=> new Date().toISOString();

async function fetchJson(url, tries=4){
  let last;
  for(let i=0;i<tries;i++){
    try{
      const r = await fetch(url, { headers:{ "accept":"application/json" } });
      if(!r.ok){
        const t = await r.text().catch(()=> "");
        const e = new Error(`HTTP ${r.status} ${t.slice(0,180)}`);
        e.status = r.status;
        throw e;
      }
      return await r.json();
    }catch(e){
      last = e;
      await sleep(700 + i*700);
    }
  }
  throw last;
}

function rangePct(high, low){
  const h=n(high), l=n(low);
  if(h==null || l==null || l<=0) return null;
  return ((h-l)/l)*100;
}
function vmRatio(vol, mcap){
  const v=n(vol), m=n(mcap);
  if(v==null || m==null || m<=0) return null;
  return v/m;
}
function ctlProxy(price, high, low){
  const p=n(price), h=n(high), l=n(low);
  if(p==null || h==null || l==null) return null;
  const d = h-l;
  if(d<=0) return null;
  return (p-l)/d;
}

const CFG = {
  cg: { perPage:250, pages:2, delayBetweenPagesMs:900 },
  pool: { mcapMin:3_000_000, mcapMax:400_000_000, volMin:250_000, vmMin:0.10 },
  bullBands: { ch24Min:-8,  ch24Max:15 },
  bearBands: { ch24Min:-15, ch24Max:3.5 },
  stageMin: {
    RADAR:  { volMin:250_000,  vmMin:0.10 },
    BUILDUP:{ volMin:500_000,  vmMin:0.14 },
    ALMOST: { volMin:1_000_000,vmMin:0.16 },
    ENTRY:  { volMin:1_500_000,vmMin:0.28 }
  },
  funnel: { minScansToLeaveRadar:2, minBuildUpScans:3, minTotalScansForEntry:5, promoteOneStep:true, demoteOneStep:true },
  engines: {
    EXPLOSIE: { buildUpVolAccMin:0.20, entryVolAccMin:0.30, priceFlatMax:4.0 },
    ACCUMULATIE:{ priceFlatMax:3.0 }
  }
};

const STAGES = ["RADAR","BUILDUP","ALMOST","ENTRY"];
const stageIndex = (s)=> Math.max(0, STAGES.indexOf(s||"RADAR"));
function moveOneStep(cur, des){
  const ci=stageIndex(cur), di=stageIndex(des);
  if(di>ci) return STAGES[ci+1]||cur;
  if(di<ci) return STAGES[Math.max(0,ci-1)]||cur;
  return cur;
}
function inBand(x, band){ return (x!=null) && x>=band.ch24Min && x<=band.ch24Max; }
function decideSide(ch24){
  const bullOk = inBand(ch24, CFG.bullBands);
  const bearOk = inBand(ch24, CFG.bearBands);
  if(bullOk && !bearOk) return "BULL";
  if(!bullOk && bearOk) return "BEAR";
  if(bullOk && bearOk) return (ch24>=0) ? "BULL" : "BEAR";
  return null;
}
function passPool(c){
  return c.mcap>=CFG.pool.mcapMin && c.mcap<=CFG.pool.mcapMax && c.vol>=CFG.pool.volMin && c.vm>=CFG.pool.vmMin;
}
function passStageMin(c, stage){
  const t = CFG.stageMin[stage];
  return !!t && c.vol>=t.volMin && c.vm>=t.vmMin;
}

function initMem(symbol){
  return { symbol, stage:"RADAR", totalScans:0, scansInStage:0, lastSeen:null, hist:[], lastExplain:"" };
}
function normalizeMem(mem, symbol){
  if(!mem || typeof mem!=="object") mem={};
  if(!mem.symbol) mem.symbol=symbol;
  if(!mem.stage) mem.stage="RADAR";
  if(!Number.isFinite(mem.totalScans)) mem.totalScans=0;
  if(!Number.isFinite(mem.scansInStage)) mem.scansInStage=0;
  if(!Array.isArray(mem.hist)) mem.hist=[];
  if(typeof mem.lastExplain!=="string") mem.lastExplain="";
  return mem;
}
function pushHist(mem, row){
  mem.hist.push(row);
  if(mem.hist.length>12) mem.hist.shift();
}
function calcConsistency(mem){
  const last = mem.hist.slice(-6);
  if(last.length===0) return 0;
  return last.filter(x=>x.passSide===true).length / last.length;
}
function calcVolAcceleration(mem){
  const h = mem.hist.slice(-6);
  if(h.length<6) return 0;
  const a = h.slice(0,3).reduce((s,x)=>s+(x.vol||0),0)/3;
  const b = h.slice(3,6).reduce((s,x)=>s+(x.vol||0),0)/3;
  if(a<=0) return 0;
  return (b-a)/a;
}
function calcPriceFlat(mem){
  const h = mem.hist.slice(-6).map(x=>x.price).filter(v=>Number.isFinite(v));
  if(h.length<3) return null;
  const mn=Math.min(...h), mx=Math.max(...h);
  if(mn<=0) return null;
  return ((mx-mn)/mn)*100;
}

// 10/10: trade plan in %
function tradeManagementPlanPct(engine){
  if(engine==="EXPLOSIE"){
    return { stopPct:-6, beAtPct:+6, tp1Pct:+12,
      rules:[
        "Hard stop: -6% (nooit verlagen)",
        "Bij +6%: stop naar break-even",
        "Bij +12%: neem 30% winst"
      ]
    };
  }
  return { stopPct:-4, beAtPct:+4, tp1Pct:+6,
    rules:[
      "Hard stop: -4% (nooit verlagen)",
      "Bij +4%: stop naar break-even",
      "Bij +6%: neem 30% winst"
    ]
  };
}

// sizing (trade-budget = 100% per trade)
function sizingPlanPct(engine, exp){
  // A/B/C -> %
  // EXPLOSIE: A=100, B=80, C=50
  // ACCU:    A=100, B=90, C=60
  if(engine==="EXPLOSIE"){
    if(exp>=1.35) return { label:"A", suggestedSizePct:100 };
    if(exp>=1.05) return { label:"B", suggestedSizePct:80 };
    return { label:"C", suggestedSizePct:50 };
  }else{
    if(exp>=1.25) return { label:"A", suggestedSizePct:100 };
    if(exp>=1.00) return { label:"B", suggestedSizePct:90 };
    return { label:"C", suggestedSizePct:60 };
  }
}

// simpele expectancy proxy (consistent + volAcc)
function expectancyProxy(cons, volAcc){
  return (cons*1.4) + (Math.max(-0.2, Math.min(0.8, volAcc))*1.0);
}

// portfolio gate (ALLOW/SUPPRESS)
function ddPct(port){
  const peak = Number(port?.peakBalance ?? port?.currentBalance ?? 0);
  const cur  = Number(port?.currentBalance ?? 0);
  if(peak<=0) return 0;
  return ((cur-peak)/peak)*100;
}
function openCounts(port){
  const pos = Array.isArray(port?.positions) ? port.positions : [];
  const open = pos.filter(p=>p.isOpen);
  return {
    explosie: open.filter(p=>p.engine==="EXPLOSIE").length,
    accu: open.filter(p=>p.engine==="ACCUMULATIE").length,
    openRiskPct: open.reduce((s,p)=> s + (Number(p.openRiskPct)||0), 0)
  };
}

async function detectRegime(){
  const url="https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin&order=market_cap_desc&per_page=1&page=1&sparkline=false";
  const data = await fetchJson(url, 4);
  const btc = Array.isArray(data) ? data[0] : null;
  const r = rangePct(btc?.high_24h, btc?.low_24h) ?? 0;
  return { regime: (r>4.5) ? "HIGH_VOL" : "GRIND", btcRange24h:r, source:"btc_range_24h" };
}

export default async function handler(req,res){
  res.setHeader("Cache-Control","no-store");

  // 1) portfolio init
  const port = await ensurePortfolio();

  // 2) memory load
  const memAllRaw = await getJson(KEYS.memory, {});
  const memAll = (memAllRaw && typeof memAllRaw==="object") ? memAllRaw : {};

  const started = nowIso();

  // 3) regime
  let regimeInfo;
  try{
    regimeInfo = await detectRegime();
  }catch(e){
    // als BTC call faalt: niet crashen
    regimeInfo = { regime:"GRIND", btcRange24h:null, source:"fallback" };
  }

  // 4) fetch coins (best effort)
  const all=[];
  const seen=new Set();

  try{
    for(let page=1; page<=CFG.cg.pages; page++){
      const url=
        "https://api.coingecko.com/api/v3/coins/markets" +
        `?vs_currency=usd&order=volume_desc&per_page=${CFG.cg.perPage}&page=${page}` +
        "&sparkline=false&price_change_percentage=24h";

      const data = await fetchJson(url, 4);
      if(!Array.isArray(data) || data.length===0) break;

      for(const x of data){
        if(!x?.id || seen.has(x.id)) continue;
        seen.add(x.id);

        const sym=(x.symbol||"").toUpperCase();
        const c={
          id:x.id,
          symbol:sym,
          name:x.name||sym,
          price:n(x.current_price),
          mcap:n(x.market_cap),
          vol:n(x.total_volume),
          high:n(x.high_24h),
          low:n(x.low_24h),
          ch24:n(x.price_change_percentage_24h_in_currency ?? x.price_change_percentage_24h)
        };
        c.range = rangePct(c.high,c.low);
        c.vm = vmRatio(c.vol,c.mcap);
        c.ctl = ctlProxy(c.price,c.high,c.low);

        if(!sym || c.price==null || c.mcap==null || c.vol==null || c.vm==null || c.ch24==null) continue;
        if(!passPool(c)) continue;

        all.push(c);
      }

      await sleep(CFG.cg.delayBetweenPagesMs);
    }
  }catch(e){
    // CoinGecko 429? -> hou oude data aan
    const prevBull = await getJson(KEYS.bull, null);
    const prevBear = await getJson(KEYS.bear, null);
    return res.status(200).json({
      ok:false,
      ts:started,
      error:String(e.message||e),
      note:"CoinGecko rate-limit of error. Oude output blijft staan.",
      prevAvailable: { bull:!!prevBull, bear:!!prevBear }
    });
  }

  const bull={ entry_entry:[], entry_hold:[], entry_sell:[], almost:[], buildup:[], radar:[] };
  const bear={ entry_entry:[], entry_hold:[], entry_sell:[], almost:[], buildup:[], radar:[] };

  for(const c of all){
    const side = decideSide(c.ch24);
    if(!side) continue;

    const key = `${side}:${c.symbol}`;
    const mem = normalizeMem(memAll[key] || initMem(c.symbol), c.symbol);

    const passSide = passStageMin(c,"RADAR") && inBand(c.ch24, side==="BULL"?CFG.bullBands:CFG.bearBands);

    mem.totalScans += 1;
    mem.lastSeen = started;
    pushHist(mem, { ts:started, price:c.price, vol:c.vol, vm:c.vm, passSide });

    const cons=calcConsistency(mem);
    const volAcc=calcVolAcceleration(mem);
    const flat=calcPriceFlat(mem);

    const engine = (regimeInfo.regime==="HIGH_VOL")
      ? (volAcc>=0.20 ? "EXPLOSIE" : "ACCUMULATIE")
      : (flat!=null && flat<=3.5 ? "ACCUMULATIE" : "EXPLOSIE");

    // nieuwe coin -> RADAR direct zichtbaar
    if(mem.totalScans===1){
      mem.stage="RADAR";
      mem.scansInStage=1;
      mem.lastExplain="Nieuw gezien → RADAR lock.";

      const row={ id:c.id, symbol:c.symbol, name:c.name, price:c.price, mcap:c.mcap, vol24h:c.vol, vm:c.vm, ch24:c.ch24,
        side, regime:regimeInfo.regime, btcRange24h:regimeInfo.btcRange24h, engine,
        finalStage:"RADAR", scansInStage:1, totalScans:1,
        consistency:cons, volAcceleration:volAcc, priceFlatPct:flat,
        ob:null, risk:null, tradePlan:null, explain:mem.lastExplain
      };
      (side==="BULL"?bull.radar:bear.radar).push(row);
      memAll[key]=mem;
      continue;
    }

    if(!passSide){
      const curI=stageIndex(mem.stage);
      mem.stage = CFG.funnel.demoteOneStep ? STAGES[Math.max(0,curI-1)] : "RADAR";
      mem.scansInStage=1;
      mem.lastExplain="Faalt basis → 1 stap terug.";
      memAll[key]=mem;
      continue;
    }

    if(mem.stage==="RADAR" && mem.totalScans < CFG.funnel.minScansToLeaveRadar){
      mem.scansInStage += 1;
      mem.lastExplain=`RADAR lock: ${mem.totalScans}/${CFG.funnel.minScansToLeaveRadar}.`;
      const row={ id:c.id, symbol:c.symbol, name:c.name, price:c.price, mcap:c.mcap, vol24h:c.vol, vm:c.vm, ch24:c.ch24,
        side, regime:regimeInfo.regime, btcRange24h:regimeInfo.btcRange24h, engine,
        finalStage:"RADAR", scansInStage:mem.scansInStage, totalScans:mem.totalScans,
        consistency:cons, volAcceleration:volAcc, priceFlatPct:flat,
        ob:null, risk:null, tradePlan:null, explain:mem.lastExplain
      };
      (side==="BULL"?bull.radar:bear.radar).push(row);
      memAll[key]=mem;
      continue;
    }

    // stage ladder (zonder OB online; OB kan later weer erbij)
    let desired="RADAR";
    if(passStageMin(c,"BUILDUP") && cons>=0.82) desired="BUILDUP";
    if(desired==="BUILDUP" && passStageMin(c,"ALMOST")) desired="ALMOST";
    if(desired==="ALMOST" && passStageMin(c,"ENTRY") && mem.totalScans>=CFG.funnel.minTotalScansForEntry) desired="ENTRY";

    const nextStage = CFG.funnel.promoteOneStep ? moveOneStep(mem.stage, desired) : desired;
    if(nextStage===mem.stage) mem.scansInStage += 1;
    else { mem.stage=nextStage; mem.scansInStage=1; }

    const row={ id:c.id, symbol:c.symbol, name:c.name, price:c.price, mcap:c.mcap, vol24h:c.vol, vm:c.vm, ch24:c.ch24,
      side, regime:regimeInfo.regime, btcRange24h:regimeInfo.btcRange24h, engine,
      finalStage:mem.stage, scansInStage:mem.scansInStage, totalScans:mem.totalScans,
      consistency:cons, volAcceleration:volAcc, priceFlatPct:flat,
      ob:null, risk:null, tradePlan:null, explain:`OK: engine=${engine}, cons=${Math.round(cons*100)}%, volAcc=${Math.round(volAcc*100)}%`
    };

    // ENTRY = portfolio gate + % sizing + % plan
    if(row.finalStage==="ENTRY"){
      const exp = expectancyProxy(cons, volAcc);
      const sp  = sizingPlanPct(engine, exp);
      const plan= tradeManagementPlanPct(engine);

      let gate="ALLOW", gateReason="OK";
      const dd = ddPct(port);
      const counts = openCounts(port);
      const maxDD = Number(port.maxDrawdownPct ?? -8);
      if(dd <= maxDD){ gate="SUPPRESS"; gateReason=`DD kill switch (${dd.toFixed(2)}% <= ${maxDD}%)`; }

      const addOpenRisk = (Number(sp.suggestedSizePct) * Math.abs(Number(plan.stopPct))) / 100;
      const maxTotal = Number(port.maxTotalOpenRiskPct ?? 4);
      if(gate==="ALLOW" && (counts.openRiskPct + addOpenRisk) > maxTotal){
        gate="SUPPRESS"; gateReason=`Max open risk (${(counts.openRiskPct+addOpenRisk).toFixed(2)}% > ${maxTotal}%)`;
      }
      if(gate==="ALLOW" && engine==="EXPLOSIE" && counts.explosie >= Number(port.maxOpenExplosie ?? 2)){
        gate="SUPPRESS"; gateReason="Max EXPLOSIE trades bereikt";
      }
      if(gate==="ALLOW" && engine==="ACCUMULATIE" && counts.accu >= Number(port.maxOpenAccu ?? 3)){
        gate="SUPPRESS"; gateReason="Max ACCUMULATIE trades bereikt";
      }

      row.risk = { sizingLabel:sp.label, suggestedSizePct:sp.suggestedSizePct, gate, gateReason };
      row.tradePlan = plan;
    }

    memAll[key]=mem;

    const bucket = (side==="BULL") ? bull : bear;
    if(row.finalStage==="RADAR") bucket.radar.push(row);
    else if(row.finalStage==="BUILDUP") bucket.buildup.push(row);
    else if(row.finalStage==="ALMOST") bucket.almost.push(row);
    else if(row.finalStage==="ENTRY") bucket.entry_entry.push(row);
  }

  const meta={
    ts: started,
    pulled: { coinsAfterPool: all.length, cgPages: CFG.cg.pages, cgPerPage: CFG.cg.perPage },
    regime: regimeInfo,
    notes:{ online:"Vercel cron -> /api/scan" }
  };

  const bullOut = { side:"BULL", ...meta, tables: bull };
  const bearOut = { side:"BEAR", ...meta, tables: bear };

  await setJson(KEYS.bull, bullOut);
  await setJson(KEYS.bear, bearOut);
  await setJson(KEYS.memory, memAll);

  return res.status(200).json({ ok:true, ts:started, poolCoins:all.length, regime:regimeInfo.regime });
}
EOS

echo "✅ Vercel files geplaatst: api/*, public/*, vercel.json, package.json, .gitignore"
echo "➡️ Volgende stap: npm i (installeer deps) + push naar GitHub + Vercel KV aanzetten."
