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
