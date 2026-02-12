const API = "/api/top10";
let SIDE = "BULL";
let DATA = null;

const el = (id)=>document.getElementById(id);
const banner = el("banner");
const funnel = el("funnel");
const ob = el("orderbook");
const statusEl = el("status");
const metaEl = el("meta");

function showBanner(msg){
  banner.textContent = msg;
  banner.classList.remove("hidden");
  // FIX: balk gaat vanzelf weg
  clearTimeout(showBanner._t);
  showBanner._t = setTimeout(()=> banner.classList.add("hidden"), 3500);
}

function setStatus(t){ statusEl.textContent = t; }

function fmt(n){ return (Number(n)||0).toLocaleString("nl-NL",{maximumFractionDigits:2}); }

function stageOrder(){
  return ["ENTRY","ALMOST","BUILDUP","RADAR"];
}

function badgeClass(stage){
  if(stage==="ENTRY") return "good";
  if(stage==="ALMOST") return "warn";
  return "";
}

function render(){
  funnel.innerHTML = "";
  if(!DATA){ funnel.innerHTML = `<div class="muted">Klik op “Scan nu”.</div>`; return; }

  const list = SIDE==="BULL" ? (DATA.bull||[]) : (DATA.bear||[]);
  metaEl.textContent = `Bands: low ${fmt(DATA.bands?.lowBand)}% | high ${fmt(DATA.bands?.highBand)}% | items: ${list.length}`;

  const byStage = {};
  for(const s of stageOrder()) byStage[s]=[];
  for(const c of list){
    (byStage[c.stage] ||= []).push(c);
  }

  for(const s of stageOrder()){
    const arr = byStage[s] || [];
    const wrap = document.createElement("div");
    wrap.className = "stage";
    wrap.innerHTML = `
      <div class="stageHead">
        <div>${s}</div>
        <div class="badge ${badgeClass(s)}">${arr.length}</div>
      </div>
      <div class="stageBody" id="stage-${s}"></div>
    `;
    funnel.appendChild(wrap);

    const body = wrap.querySelector(`#stage-${s}`);
    if(!arr.length){
      body.innerHTML = `<div class="muted">Geen coins.</div>`;
      continue;
    }

    for(const c of arr){
      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML = `
        <div class="left">
          <div class="sym">${c.symbol} <span class="badge">${c.engine || "-"}</span></div>
          <div class="meta">
            prijs: $${fmt(c.price)} • ch24: ${fmt(c.ch24)}% • vm: ${fmt(c.vm)} • vol: $${fmt(c.vol)}
            • score: ${c.timingScore} • scans: ${c.totalScans}
          </div>
          ${c.gate && c.gate.allowed===false ? `<div class="meta" style="color:#ffd9df">Gate: ${c.gate.reason}</div>` : ""}
        </div>
        <div class="badge ${badgeClass(c.stage)}">
          ${c.ob?.zScore != null ? `z ${fmt(c.ob.zScore)}` : (c.ob?.error ? "OB err" : "—")}
        </div>
      `;
      row.onclick = ()=> showDetails(c);
      body.appendChild(row);
    }
  }
}

async function showDetails(c){
  ob.innerHTML = `
    <div class="muted"><b>${c.symbol}</b> (${c.side}) — klik “Scan nu” voor refresh</div>
    <div class="kv">
      <div class="box">Stage<br><b>${c.stage}</b></div>
      <div class="box">TimingScore<br><b>${c.timingScore}</b></div>
      <div class="box">VM / Vol<br><b>${fmt(c.vm)}</b> / <b>$${fmt(c.vol)}</b></div>
      <div class="box">Flat / VolAcc<br><b>${c.flatness!=null ? fmt(c.flatness*100)+"%" : "-"}</b> / <b>${fmt(c.volAcc*100)}%</b></div>
    </div>
    <div style="margin-top:10px" class="muted">Orderbook wordt automatisch opgehaald bij ALMOST/ENTRY tijdens scan.</div>
  `;
}

async function scan(){
  try{
    setStatus("scanning…");
    banner.classList.add("hidden");

    const r = await fetch(API, { cache:"no-store" });
    const j = await r.json();

    if(!j.ok){
      showBanner(`API fout: ${j.error || "unknown"}`);
      DATA = null;
    }else{
      DATA = j;
    }

    render();
    setStatus("ready");

  }catch(e){
    showBanner(`API fout: ${e.message}`);
    setStatus("error");
  }
}

el("btnBull").onclick = ()=>{
  SIDE="BULL";
  el("btnBull").classList.add("active");
  el("btnBear").classList.remove("active");
  render();
};
el("btnBear").onclick = ()=>{
  SIDE="BEAR";
  el("btnBear").classList.add("active");
  el("btnBull").classList.remove("active");
  render();
};
el("btnScan").onclick = scan;

// start
render();
