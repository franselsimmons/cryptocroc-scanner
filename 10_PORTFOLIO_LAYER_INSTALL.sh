#!/usr/bin/env bash
set -e

echo "== CryptoCroc 10/10 Portfolio Layer install =="

mkdir -p cryptocroc-terminal/output
mkdir -p public

# 1) portfolio.json (als hij nog niet bestaat)
if [ ! -f cryptocroc-terminal/output/portfolio.json ]; then
cat << 'EOP' > cryptocroc-terminal/output/portfolio.json
{
  "version": 1,
  "baseCurrency": "USD",
  "startingBalance": 1000,
  "currentBalance": 1000,
  "peakBalance": 1000,
  "maxDrawdownPct": -8,
  "maxTotalOpenRiskPct": 4,
  "maxOpenExplosie": 2,
  "maxOpenAccu": 3,
  "positions": []
}
EOP
echo "✅ portfolio.json gemaakt (start op 1000 USD)."
else
echo "ℹ️ portfolio.json bestond al (laten staan)."
fi

# 2) trades.jsonl (append log)
if [ ! -f cryptocroc-terminal/output/trades.jsonl ]; then
  touch cryptocroc-terminal/output/trades.jsonl
  echo "✅ trades.jsonl gemaakt."
else
  echo "ℹ️ trades.jsonl bestond al."
fi

# 3) server.mjs patchen: we vervangen hem volledig met versie incl. portfolio API
cat << 'EOS' > server.mjs
import http from "http";
import fs from "fs";
import path from "path";
import url from "url";
import { spawn } from "child_process";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const OUT_DIR = path.join(__dirname, "cryptocroc-terminal", "output");
const PUBLIC_DIR = path.join(__dirname, "public");
const SCAN_PATH = path.join(__dirname, "cryptocroc-terminal", "scanner", "scan.js");

const FILE_BULL = path.join(OUT_DIR,"bull.json");
const FILE_BEAR = path.join(OUT_DIR,"bear.json");
const FILE_PORTFOLIO = path.join(OUT_DIR,"portfolio.json");
const FILE_TRADES = path.join(OUT_DIR,"trades.jsonl");

function send(res, code, body, type="text/plain"){
  res.writeHead(code, {
    "content-type": type,
    "cache-control": "no-store"
  });
  res.end(body);
}
function readFileSafe(p){ try { return fs.readFileSync(p); } catch { return null; } }
function readJsonSafe(p, fallback){ try { return JSON.parse(fs.readFileSync(p,"utf8")); } catch { return fallback; } }
function writeJson(p, obj){ fs.writeFileSync(p, JSON.stringify(obj,null,2)); }

function readBody(req){
  return new Promise((resolve)=>{
    let data="";
    req.on("data",(c)=> data+=c);
    req.on("end",()=> resolve(data));
  });
}

let scanning = false;

function runScan(){
  if(scanning) return;
  scanning = true;

  console.log("🔁 run scan:", new Date().toISOString());
  const p = spawn(process.execPath, [SCAN_PATH], { stdio: "inherit" });

  p.on("close", (code)=>{
    scanning = false;
    console.log("✅ scan done code:", code);
  });
}

runScan();
setInterval(runScan, 10*60*1000);

function ensurePortfolio(){
  if(!fs.existsSync(FILE_PORTFOLIO)){
    writeJson(FILE_PORTFOLIO, {
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
    });
  }
  if(!fs.existsSync(FILE_TRADES)){
    fs.writeFileSync(FILE_TRADES, "");
  }
}

function appendTrade(obj){
  fs.appendFileSync(FILE_TRADES, JSON.stringify(obj) + "\n");
}

function calcDD(port){
  const peak = Number(port.peakBalance ?? port.currentBalance ?? 0);
  const cur  = Number(port.currentBalance ?? 0);
  if(peak<=0) return 0;
  return ((cur-peak)/peak)*100;
}

function openPosition({ symbol, side, engine, entryPrice, sizePct, stopPct, tp1Pct, beAtPct }){
  ensurePortfolio();
  const port = readJsonSafe(FILE_PORTFOLIO, null);
  if(!port) throw new Error("portfolio.json unreadable");

  const price = Number(entryPrice);
  if(!Number.isFinite(price) || price<=0) throw new Error("entryPrice ongeldig");

  const sPct = Number(sizePct);
  if(!Number.isFinite(sPct) || sPct<=0) throw new Error("sizePct ongeldig");

  const dd = calcDD(port);
  if(dd <= (port.maxDrawdownPct ?? -8)) throw new Error("DD kill switch actief: geen nieuwe trades");

  // exposure checks (hard)
  const positions = Array.isArray(port.positions) ? port.positions : [];
  const openExpl = positions.filter(p=>p.isOpen && p.engine==="EXPLOSIE").length;
  const openAcc  = positions.filter(p=>p.isOpen && p.engine==="ACCUMULATIE").length;

  if(engine==="EXPLOSIE" && openExpl >= (port.maxOpenExplosie ?? 2)) throw new Error("Max EXPLOSIE trades bereikt");
  if(engine==="ACCUMULATIE" && openAcc >= (port.maxOpenAccu ?? 3)) throw new Error("Max ACCUMULATIE trades bereikt");

  // risk model in % van account:
  // openRiskPct = sizePct * |stopPct| / 100
  const st = Number(stopPct);
  if(!Number.isFinite(st) || st>=0) throw new Error("stopPct moet negatief zijn (bv -6)");

  const openRiskPct = (sPct * Math.abs(st)) / 100;

  const totalOpenRiskPct =
    positions.filter(p=>p.isOpen).reduce((sum,p)=> sum + (Number(p.openRiskPct)||0), 0);

  const maxTotal = Number(port.maxTotalOpenRiskPct ?? 4);
  if(totalOpenRiskPct + openRiskPct > maxTotal){
    throw new Error(\`Max totaal open risico overschreden (\${(totalOpenRiskPct+openRiskPct).toFixed(2)}% > \${maxTotal}%)\`);
  }

  const id = "pos_" + Math.random().toString(16).slice(2) + "_" + Date.now();

  const pos = {
    id,
    tsOpen: new Date().toISOString(),
    symbol,
    side,
    engine,
    entryPrice: price,
    sizePct: sPct,
    stopPct: Number(stopPct),
    tp1Pct: Number(tp1Pct),
    beAtPct: Number(beAtPct),
    openRiskPct: Number(openRiskPct.toFixed(3)),
    isOpen: true,
    notes: ""
  };

  port.positions = positions.concat([pos]);

  // peak tracking
  port.peakBalance = Math.max(Number(port.peakBalance ?? port.currentBalance ?? 0), Number(port.currentBalance ?? 0));
  writeJson(FILE_PORTFOLIO, port);

  appendTrade({ type:"OPEN", ...pos });

  return port;
}

function closePosition({ id, exitPrice }){
  ensurePortfolio();
  const port = readJsonSafe(FILE_PORTFOLIO, null);
  if(!port) throw new Error("portfolio.json unreadable");

  const price = Number(exitPrice);
  if(!Number.isFinite(price) || price<=0) throw new Error("exitPrice ongeldig");

  const positions = Array.isArray(port.positions) ? port.positions : [];
  const idx = positions.findIndex(p=>p.id===id && p.isOpen);
  if(idx<0) throw new Error("Open positie niet gevonden");

  const p = positions[idx];
  const entry = Number(p.entryPrice);
  const dir = (p.side==="BULL") ? 1 : -1;

  const pnlPct = ((price-entry)/entry)*100*dir; // profit% on price move
  // account impact: sizePct * pnlPct / 100
  const impactPct = (Number(p.sizePct) * pnlPct) / 100;

  const cur = Number(port.currentBalance ?? 0);
  const newBal = cur * (1 + impactPct/100);

  positions[idx] = {
    ...p,
    tsClose: new Date().toISOString(),
    exitPrice: price,
    pnlPct: Number(pnlPct.toFixed(3)),
    accountImpactPct: Number(impactPct.toFixed(3)),
    isOpen: false
  };

  port.positions = positions;
  port.currentBalance = Number(newBal.toFixed(2));
  port.peakBalance = Math.max(Number(port.peakBalance ?? port.currentBalance ?? 0), port.currentBalance);

  writeJson(FILE_PORTFOLIO, port);

  appendTrade({ type:"CLOSE", id, symbol:p.symbol, side:p.side, engine:p.engine, entryPrice:entry, exitPrice:price, pnlPct:Number(pnlPct.toFixed(3)), accountImpactPct:Number(impactPct.toFixed(3)), ts:new Date().toISOString() });

  return port;
}

const server = http.createServer(async (req,res)=>{
  const u = new URL(req.url, `http://${req.headers.host}`);
  const pathname = u.pathname;

  if(pathname === "/api/bull"){
    const b = readFileSafe(FILE_BULL);
    return send(res, b?200:404, b?b:Buffer.from("{}"), "application/json");
  }
  if(pathname === "/api/bear"){
    const b = readFileSafe(FILE_BEAR);
    return send(res, b?200:404, b?b:Buffer.from("{}"), "application/json");
  }
  if(pathname === "/api/portfolio"){
    ensurePortfolio();
    const p = readFileSafe(FILE_PORTFOLIO);
    return send(res, 200, p||Buffer.from("{}"), "application/json");
  }
  if(pathname === "/api/trades"){
    ensurePortfolio();
    const t = readFileSafe(FILE_TRADES);
    return send(res, 200, t||Buffer.from(""), "text/plain");
  }

  // ACTION API
  if(pathname === "/api/action" && req.method === "POST"){
    ensurePortfolio();
    const raw = await readBody(req);
    let body = {};
    try{ body = JSON.parse(raw||"{}"); }catch{ return send(res,400,"Bad JSON"); }

    try{
      if(body.action==="OPEN"){
        const port = openPosition(body);
        return send(res, 200, Buffer.from(JSON.stringify({ ok:true, portfolio:port })), "application/json");
      }
      if(body.action==="CLOSE"){
        const port = closePosition(body);
        return send(res, 200, Buffer.from(JSON.stringify({ ok:true, portfolio:port })), "application/json");
      }
      if(body.action==="SET_BALANCE"){
        const port = readJsonSafe(FILE_PORTFOLIO, null);
        const b = Number(body.currentBalance);
        if(!Number.isFinite(b) || b<=0) throw new Error("balance ongeldig");
        port.currentBalance = Number(b.toFixed(2));
        port.peakBalance = Math.max(Number(port.peakBalance ?? b), port.currentBalance);
        writeJson(FILE_PORTFOLIO, port);
        return send(res, 200, Buffer.from(JSON.stringify({ ok:true, portfolio:port })), "application/json");
      }
      return send(res, 400, "Unknown action");
    }catch(e){
      return send(res, 400, Buffer.from(JSON.stringify({ ok:false, error: String(e.message||e) })), "application/json");
    }
  }

  // Static
  let filePath = (pathname==="/") ? "/index.html" : pathname;
  filePath = path.join(PUBLIC_DIR, filePath);

  const ext = path.extname(filePath).toLowerCase();
  const type =
    ext===".html" ? "text/html" :
    ext===".css"  ? "text/css" :
    ext===".js"   ? "text/javascript" :
    "application/octet-stream";

  const b = readFileSafe(filePath);
  if(!b) return send(res, 404, "Not found");
  return send(res, 200, b, type);
});

server.listen(PORT, ()=> console.log(\`✅ Server running: http://localhost:\${PORT}\`));
EOS

# 4) UI uitbreiden: index.html (portfolio bar)
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
        <div class="sub">ENTRY boven — RADAR onder • 2 engines • regime gestuurd • portfolio enforced</div>
      </div>
    </div>

    <div class="tabs">
      <button id="tabBull" class="tab">BULL</button>
      <button id="tabBear" class="tab">BEAR</button>
      <button id="btnRefresh" class="ghost">Refresh</button>
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

# 5) app.js vervangen met OPEN/CLOSE knoppen + ALLOW/SUPPRESS + sizing %
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

  elPort.textContent = \`bal: \${cur.toFixed(2)} | open: \${open} | risk: \${openRisk.toFixed(2)}% | DD: \${dd.toFixed(2)}%\`;
}

function block(title, hint, rows){
  const wrap = document.createElement("div");
  wrap.className="block";

  const head = document.createElement("div");
  head.className="blockHead";
  head.innerHTML = \`<div class="blockTitle">\${title}</div><div class="blockHint">\${hint}</div>\`;
  wrap.appendChild(head);

  const table = document.createElement("table");
  table.className="table";
  table.innerHTML = \`
    <thead>
      <tr>
        <th>Coin</th>
        <th>Engine</th>
        <th>24h</th>
        <th>MCAP</th>
        <th>VOL</th>
        <th>VM</th>
        <th>OB</th>
        <th>Size</th>
        <th>Gate</th>
        <th>Progress</th>
      </tr>
    </thead>
    <tbody></tbody>
  \`;
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

    tr.innerHTML = \`
      <td><span class="badge">\${r.symbol}</span> \${r.name}</td>
      <td><span class="badge">\${r.engine || "—"}</span></td>
      <td class="\${clsPct(r.ch24)}">\${fmtPct(r.ch24)}</td>
      <td>\${fmtMoney(r.mcap)}</td>
      <td>\${fmtMoney(r.vol24h)}</td>
      <td>\${r.vm!=null? r.vm.toFixed(3):"—"}</td>
      <td class="\${obCls}">\${obTxt}</td>
      <td><span class="badge">\${sizeTxt}</span></td>
      <td class="\${gateCls}">\${gate}</td>
      <td><span class="pb"><i style="width:\${p}%"></i></span></td>
    \`;
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
    ["Gate", r?.risk?.gate || "—", "ALLOW = mag trade openen. SUPPRESS = geblokkeerd door risico/exposure/DD."],
    ["Gate reden", r?.risk?.gateReason || "—", "Waarom hij wel/niet mag."],
    ["Suggested size", (r?.risk?.suggestedSizePct!=null? r.risk.suggestedSizePct+"%":"—"), "Hoeveel % van je trade-budget je gebruikt."],
    ["Stoploss", r?.tradePlan?.stopPct!=null? r.tradePlan.stopPct+"%":"—", "Hard stop in % vanaf entry prijs."],
    ["BE at", r?.tradePlan?.beAtPct!=null? r.tradePlan.beAtPct+"%":"—", "Bij deze winst gaat SL naar break-even."],
    ["TP1", r?.tradePlan?.tp1Pct!=null? r.tradePlan.tp1Pct+"%":"—", "Bij deze winst neem je 30% winst."],
    ["Total scans", r.totalScans, "Hoe vaak we ‘m al zagen (memory)."],
    ["Consistency", r.consistency!=null ? Math.round(r.consistency*100)+"%" : "—", "Stabiliteit in de laatste scans."],
    ["Vol acceleration", r.volAcceleration!=null ? Math.round(r.volAcceleration*100)+"%" : "—", "Volume versnelling."],
    ["Explain", r.explain || "—", "Waarom hij hier zit / wat hij mist."]
  ];

  if(r.ob){
    lines.push(["OB score", r.ob.score!=null ? r.ob.score.toFixed(3) : "—", "Orderbook druk (+ bids / - asks)."]);
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
    const stopPct = Number(r?.tradePlan?.stopPct);
    const tp1Pct  = Number(r?.tradePlan?.tp1Pct);
    const beAtPct = Number(r?.tradePlan?.beAtPct);
    const sizePct = Number(r?.risk?.suggestedSizePct);

    const payload = {
      action:"OPEN",
      symbol:r.symbol,
      side:r.side,
      engine:r.engine,
      entryPrice:r.price,
      sizePct,
      stopPct,
      tp1Pct,
      beAtPct
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

  const btnSetBal = document.createElement("button");
  btnSetBal.className="ghost";
  btnSetBal.textContent = "Set balance";
  btnSetBal.onclick = async ()=>{
    const b = prompt("Nieuwe currentBalance (USD):", String(PORTFOLIO?.currentBalance ?? 1000));
    const currentBalance = Number(b);
    if(!Number.isFinite(currentBalance) || currentBalance<=0){ alert("Ongeldig"); return; }
    const payload = { action:"SET_BALANCE", currentBalance };
    const resp = await fetch(API.action, { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(payload) });
    const j = await resp.json().catch(()=>({ ok:false, error:"bad json" }));
    if(!j.ok){ alert("Set balance mislukt: " + j.error); return; }
    await refreshPortfolio();
    alert("Balance opgeslagen ✅");
  };

  wrap.appendChild(btnOpen);
  wrap.appendChild(btnClose);
  wrap.appendChild(btnSetBal);

  const rr = document.createElement("div");
  rr.className="pill";
  const size = Number(r?.risk?.suggestedSizePct);
  const st = Number(r?.tradePlan?.stopPct);
  const or = openRiskPct(size, st);
  rr.textContent = (or!=null) ? \`Open risk: \${or.toFixed(2)}%\` : "Open risk: —";
  wrap.appendChild(rr);

  return wrap;
}

function openModal(r){
  $("#modal").classList.remove("hidden");
  $("#mTitle").textContent = \`\${r.symbol} • \${r.name} • \${r.finalStage}\`;

  const grid = document.createElement("div");
  grid.className="grid";

  for(const [k,v,desc] of explainLines(r)){
    const c = document.createElement("div");
    c.className="card";
    c.innerHTML = \`<div class="k">\${k}</div><div class="v">\${v}</div><div class="note">\${desc}</div>\`;
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
    elTables.textContent = "Kan data niet laden. Check of server draait.";
    return;
  }

  elTs.textContent = data?.ts ? \`Last scan: \${data.ts}\` : "Last scan: —";
  elReg.textContent = data?.regime?.regime ? \`Regime: \${data.regime.regime}\` : "Regime: —";

  const t = data?.tables || {};
  const total =
    (t.entry_entry?.length||0)+(t.entry_hold?.length||0)+(t.entry_sell?.length||0)+
    (t.almost?.length||0)+(t.buildup?.length||0)+(t.radar?.length||0);

  elCounts.textContent = \`Coins in view: \${total}\`;

  elTables.appendChild(block("ENTRY • ENTRY", "Actie (ALLOW/SUPPRESS + sizing%)", t.entry_entry||[]));
  elTables.appendChild(block("ENTRY • HOLD", "Sterk – vasthouden", t.entry_hold||[]));
  elTables.appendChild(block("ENTRY • SELL", "Niet doen / exit waarschuwing", t.entry_sell||[]));
  elTables.appendChild(block("ALMOST", "Bijna klaar (OB check actief)", t.almost||[]));
  elTables.appendChild(block("BUILDUP", "Bevestiging aan het bouwen", t.buildup||[]));
  elTables.appendChild(block("RADAR", "Nieuwe/early kandidaten", t.radar||[]));
}

load();
EOJ

echo "✅ Portfolio layer files geplaatst: server.mjs + public/index.html + public/app.js"
echo "➡️ Nu moet scan.js nog de gate+% plannen vullen (volgende stap)."
EOS

bash 10_PORTFOLIO_LAYER_INSTALL.sh
