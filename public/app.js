const API = {
  bull: "/api/bull",
  bear: "/api/bear",
  scan: "/api/scan"
};

const $ = (s) => document.querySelector(s);

let VIEW = localStorage.getItem("crocView") || "bull";
const elTables = $("#tables");
const elTs = $("#ts");
const elMeta = $("#meta");
const elLoading = $("#loading");

$("#tabBull").onclick = () => setView("bull");
$("#tabBear").onclick = () => setView("bear");
$("#btnRefresh").onclick = () => load();
$("#btnScan").onclick = () => scanNow();

function setView(v){
  VIEW = v;
  localStorage.setItem("crocView", v);
  renderTabs();
  load();
}
function renderTabs(){
  $("#tabBull").classList.toggle("active", VIEW==="bull");
  $("#tabBear").classList.toggle("active", VIEW==="bear");
}

function fmtMoney(x){
  if (x==null || !Number.isFinite(x)) return "—";
  const abs = Math.abs(x);
  if (abs>=1e9) return (x/1e9).toFixed(2)+"B";
  if (abs>=1e6) return (x/1e6).toFixed(2)+"M";
  if (abs>=1e3) return (x/1e3).toFixed(2)+"K";
  return x.toFixed(2);
}
function fmtPct(x){
  if (x==null || !Number.isFinite(x)) return "—";
  return (x>=0?"+":"") + x.toFixed(2) + "%";
}
function clsPct(x){
  if (x==null || !Number.isFinite(x)) return "";
  return x>=0 ? "good" : "bad";
}
function progress(stage, scansInStage, totalScans){
  if(stage==="RADAR") return Math.min((scansInStage/2)*100, 100);
  if(stage==="BUILDUP") return Math.min((scansInStage/3)*100, 100);
  if(stage==="ALMOST") return Math.min((totalScans/5)*100, 100);
  if(stage==="ENTRY") return 100;
  return 10;
}

async function scanNow(){
  elLoading.classList.remove("hidden");
  try{
    const r = await fetch(API.scan, { cache:"no-store" });
    const j = await r.json();
    alert(j.ok ? "✅ Scan geslaagd" : "❌ Scan fout: " + (j.error || "?"));
  }catch{
    alert("❌ Netwerkfout bij scan");
  }
  elLoading.classList.add("hidden");
  load();
}

function block(title, hint, rows){
  const wrap = document.createElement("div");
  wrap.className = "block";

  const head = document.createElement("div");
  head.className = "blockHead";
  head.innerHTML = `<div class="blockTitle">${title}</div><div class="blockHint">${hint}</div>`;
  wrap.appendChild(head);

  const table = document.createElement("table");
  table.className = "table";
  table.innerHTML = `
    <thead>
      <tr>
        <th>Coin</th>
        <th>Stage</th>
        <th>Engine</th>
        <th>24h</th>
        <th>MCAP</th>
        <th>VOL</th>
        <th>VM</th>
        <th>OB</th>
        <th>Z</th>
        <th>Progress</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;

  const tb = table.querySelector("tbody");

  for(const r of rows){
    const tr = document.createElement("tr");
    tr.onclick = ()=>openModal(r);

    const ob = r?.ob?.score;
    const z  = r?.obZ;
    const obTxt = (ob!=null && Number.isFinite(ob)) ? ob.toFixed(3) : "—";
    const zTxt  = (z!=null && Number.isFinite(z)) ? z.toFixed(3) : "—";
    const obCls = (ob!=null && Number.isFinite(ob)) ? (ob>=0?"good":"bad") : "";
    const zCls  = (z!=null && Number.isFinite(z)) ? (z>=0?"good":"bad") : "";

    const p = progress(r.finalStage, r.scansInStage, r.totalScans);

    tr.innerHTML = `
      <td><span class="badge">${r.symbol}</span> ${r.name}</td>
      <td><span class="badge">${r.finalStage}</span></td>
      <td><span class="badge">${r.engine || "—"}</span></td>
      <td class="${clsPct(r.ch24)}">${fmtPct(r.ch24)}</td>
      <td>${fmtMoney(r.mcap)}</td>
      <td>${fmtMoney(r.vol24h)}</td>
      <td>${r.vm!=null ? r.vm.toFixed(3) : "—"}</td>
      <td class="${obCls}">${obTxt}</td>
      <td class="${zCls}">${zTxt}</td>
      <td><span class="pb"><i style="width:${p}%"></i></span></td>
    `;
    tb.appendChild(tr);
  }

  wrap.appendChild(table);
  return wrap;
}

async function openModal(r){
  $("#modal").classList.remove("hidden");
  $("#mTitle").textContent = `${r.symbol} • ${r.name} • ${r.finalStage}`;

  const lines = [
    ["Side", r.side, "BULL/BEAR via dynamische bands"],
    ["Regime", r.regime, "BTC range bepaalt HIGH_VOL/GRIND"],
    ["Timing", r.explain || "—", "Waarom deze stage"],
    ["Consistency", r.consistency!=null ? Math.round(r.consistency*100)+"%" : "—", "Laatste 6 scans passSide"],
    ["Vol accel", r.volAcceleration!=null ? Math.round(r.volAcceleration*100)+"%" : "—", "Laatste 3 vs vorige 3"],
    ["Price flat", r.priceFlatPct!=null ? r.priceFlatPct.toFixed(2)+"%" : "—", "Schommeling laatste 6"],
    ["OB score", r?.ob?.score!=null ? r.ob.score.toFixed(4) : "—", "Bid vs Ask druk (2% depth)"],
    ["OB z-score", r?.obZ!=null ? r.obZ.toFixed(4) : "—", "Z-score op laatste 50 OB metingen"],
    ["Spread", r?.ob?.spreadPct!=null ? r.ob.spreadPct.toFixed(3)+"%" : "—", "Best ask/bid spread"],
  ];

  const grid = document.createElement("div");
  grid.className = "grid";

  for(const [k,v,desc] of lines){
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<div class="k">${k}</div><div class="v">${v}</div><div class="note">${desc}</div>`;
    grid.appendChild(card);
  }

  const body = $("#mBody");
  body.innerHTML = "";
  body.appendChild(grid);
}

$("#mClose").onclick = () => $("#modal").classList.add("hidden");
$("#modal").onclick = (e) => { if(e.target.id==="modal") $("#modal").classList.add("hidden"); };

async function load(){
  renderTabs();
  elTables.innerHTML = "";
  elLoading.classList.remove("hidden");

  try{
    const url = (VIEW==="bear") ? API.bear : API.bull;
    const r = await fetch(url, { cache:"no-store" });
    const data = await r.json();
    if(!data?.tables) throw new Error("no data");

    elTs.textContent = data.ts ? `⏳ last scan: ${data.ts.slice(0,16)}` : "⏳ last scan: —";
    const b = data.bands || {};
    elMeta.textContent = (b.lowBand!=null && b.highBand!=null)
      ? `📌 bands: ${b.lowBand.toFixed(2)}% / ${b.highBand.toFixed(2)}% • OB calls: (zie scan logs)`
      : `📌 bands: —`;

    const t = data.tables;

    // ENTRY boven, RADAR onder (zoals jij wil)
    elTables.appendChild(block("ENTRY • ENTRY", "Klaar om te openen (OB z-score confirmed)", t.entry_entry || []));
    elTables.appendChild(block("ENTRY • HOLD", "OB + spread zegt: vasthouden", t.entry_hold || []));
    elTables.appendChild(block("ENTRY • SELL", "OB + spread zegt: exit signaal", t.entry_sell || []));
    elTables.appendChild(block("ALMOST", "PRO Orderbook actief vanaf hier", t.almost || []));
    elTables.appendChild(block("BUILDUP", "Consistentie + engine voorwaarden", t.buildup || []));
    elTables.appendChild(block("RADAR", "Nieuwe kandidaten + lock", t.radar || []));

  }catch(e){
    elTs.textContent = "⏳ last scan: —";
    elMeta.textContent = "📌 bands: —";
    elTables.innerHTML = `
      <div class="block">
        <div class="blockHead">
          <div class="blockTitle">❌ Nog geen data</div>
          <div class="blockHint">Druk op “Scan nu”</div>
        </div>
        <div style="padding:18px; color:var(--muted);">
          Tip: zet eerst je Upstash env vars in Vercel, daarna scan.
        </div>
      </div>
    `;
  }finally{
    elLoading.classList.add("hidden");
  }
}

load();
