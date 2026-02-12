const API = { bull:"/api/bull", bear:"/api/bear", scan:"/api/scan" };
let SIDE = (location.hash === "#bear") ? "bear" : "bull";

const $ = (s)=>document.querySelector(s);
const elTables = $("#tables");
const elTs = $("#ts");
const elReg = $("#reg");
const elCounts = $("#counts");

$("#tabBull").onclick = ()=>setSide("bull");
$("#tabBear").onclick = ()=>setSide("bear");
$("#btnRefresh").onclick = ()=>load();
$("#btnScan").onclick = ()=>scanNow();

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
function clsPct(x){
  if(x==null || !Number.isFinite(x)) return "";
  return x>=0 ? "good" : "bad";
}
function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }

function progress(stage, scansInStage, totalScans){
  if(stage==="RADAR") return clamp((scansInStage/2)*100, 5, 100);
  if(stage==="BUILDUP") return clamp((scansInStage/3)*100, 5, 100);
  if(stage==="ALMOST") return clamp((totalScans/5)*100, 5, 100);
  if(stage==="ENTRY") return 100;
  return 10;
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
        <th>Coin</th>
        <th>Engine</th>
        <th>24h</th>
        <th>MCAP</th>
        <th>VOL</th>
        <th>VM</th>
        <th>OB</th>
        <th>Progress</th>
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

    tr.innerHTML = `
      <td><span class="badge">${r.symbol}</span> ${r.name}</td>
      <td><span class="badge">${r.engine || "—"}</span></td>
      <td class="${clsPct(r.ch24)}">${fmtPct(r.ch24)}</td>
      <td>${fmtMoney(r.mcap)}</td>
      <td>${fmtMoney(r.vol24h)}</td>
      <td>${r.vm!=null? r.vm.toFixed(3):"—"}</td>
      <td class="${obCls}">${obTxt}</td>
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
    ["Regime", r.regime || "—", "HIGH_VOL = wild, GRIND = rustig."],
    ["Engine", r.engine || "—", "EXPLOSIE = volume versnelling, ACCUMULATIE = prijs vlak."],
    ["Total scans", r.totalScans, "Hoe vaak we deze coin zagen (memory)."],
    ["Scans in stage", r.scansInStage, "Hoelang hij dit level volhoudt."],
    ["Consistency", r.consistency!=null ? Math.round(r.consistency*100)+"%" : "—", "Stabiliteit (laatste 6 scans)."],
    ["Vol acceleration", r.volAcceleration!=null ? Math.round(r.volAcceleration*100)+"%" : "—", "Volume versnelling (laatste 6 scans)."],
    ["Price flat", r.priceFlatPct!=null ? r.priceFlatPct.toFixed(2)+"%" : "—", "Prijsband (laatste 6 scans)."],
    ["VM", r.vm!=null ? r.vm.toFixed(3) : "—", "Volume / MarketCap."],
    ["Explain", r.explain || "—", "Waarom hij hier zit."],
  ];

  if(r.ob){
    lines.push(["OB score", r.ob.score!=null ? r.ob.score.toFixed(3) : "—", "Orderbook druk binnen ~2%." ]);
    lines.push(["Spread", r.ob.spreadPct!=null ? r.ob.spreadPct.toFixed(3)+"%" : "—", "Verschil beste bid/ask." ]);
  } else {
    lines.push(["Orderbook", "n/a", "Geen Bitget USDT spot pair of OB faalde." ]);
  }

  if(r.risk){
    lines.push(["Sizing", (r.risk.suggestedSizePct ?? "—") + "%", "Voorstel inzet (A/B/C bucket)."]);
    lines.push(["Expectancy", r.risk.expectancyProxy ?? "—", "Interne score om sizing te bepalen."]);
  }
  if(r.tradePlan){
    lines.push(["Hard stop", r.tradePlan.hardStop, "Altijd (bescherming)."]);
    lines.push(["BE", r.tradePlan.breakevenAt, "Risico eraf bij winst."]);
    lines.push(["TP", r.tradePlan.partialTP, "Pak winst op tijd."]);
    lines.push(["Edge exit", r.tradePlan.edgeExit, "Als edge draait: eruit."]);
  }

  return lines;
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
}

$("#mClose").onclick = ()=>$("#modal").classList.add("hidden");
$("#modal").onclick = (e)=>{ if(e.target.id==="modal") $("#modal").classList.add("hidden"); };

async function scanNow(){
  const secret = prompt("Plak je CRON_SECRET (zelfde als in Vercel env):");
  if(!secret) return;

  try{
    const r = await fetch(`${API.scan}?secret=${encodeURIComponent(secret)}`, { cache:"no-store" });
    const j = await r.json();
    alert(j.ok ? "✅ Scan OK" : ("❌ Scan fout: " + (j.error || "?")));
  }catch{
    alert("❌ Netwerkfout bij scan");
  }
  load();
}

async function load(){
  renderTabs();
  elTables.innerHTML = "";

  const url = SIDE==="bull" ? API.bull : API.bear;

  let data;
  try{
    const r = await fetch(url, { cache:"no-store" });
    data = await r.json();
  }catch{
    elTables.textContent = "Kan data niet laden. Eerst 1x scannen via 'Scan nu'.";
    return;
  }

  elTs.textContent = data?.ts ? `Last scan: ${data.ts}` : "Last scan: —";
  elReg.textContent = data?.regime?.regime ? `Regime: ${data.regime.regime}` : "Regime: —";

  const t = data?.tables || {};
  const total =
    (t.entry_entry?.length||0) + (t.entry_hold?.length||0) + (t.entry_sell?.length||0) +
    (t.almost?.length||0) + (t.buildup?.length||0) + (t.radar?.length||0);

  elCounts.textContent = `Coins in view: ${total}`;

  // ENTRY boven, RADAR onder
  elTables.appendChild(block("ENTRY • ENTRY", "Klaar (OB bevestigd)", t.entry_entry||[]));
  elTables.appendChild(block("ENTRY • HOLD", "Edge ok (vasthouden)", t.entry_hold||[]));
  elTables.appendChild(block("ENTRY • SELL", "Exit waarschuwing", t.entry_sell||[]));
  elTables.appendChild(block("ALMOST", "Bijna klaar (OB check)", t.almost||[]));
  elTables.appendChild(block("BUILDUP", "Bevestiging bouwen", t.buildup||[]));
  elTables.appendChild(block("RADAR", "Nieuw/early (RADAR lock)", t.radar||[]));
}

load();
