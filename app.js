const API_LATEST = (mode) => `/api/latest?mode=${mode}`;
const API_SCAN   = (mode) => `/api/scan?mode=${mode}`;
const API_OB     = (symbol, mode) => `/api/orderbook?symbol=${encodeURIComponent(symbol)}&mode=${mode}`;

let MODE = "bull";
let DATA = null;

const $ = (id) => document.getElementById(id);

function toast(msg, sub="", level="good", ms=4200){
  const el = $("toast");
  $("toastMsg").textContent = msg;
  $("toastSub").textContent = sub || "";
  $("toastMsg").className = `msg ${level}`;
  el.classList.add("show");
  clearTimeout(window.__t);
  window.__t = setTimeout(()=> el.classList.remove("show"), ms);
}
$("toastClose").onclick = () => $("toast").classList.remove("show");

function fmt(n){
  if(n==null || Number.isNaN(n)) return "—";
  if(Math.abs(n) >= 1e9) return (n/1e9).toFixed(2)+"B";
  if(Math.abs(n) >= 1e6) return (n/1e6).toFixed(2)+"M";
  if(Math.abs(n) >= 1e3) return (n/1e3).toFixed(2)+"K";
  return String(n);
}

function stageBlock(title, items){
  const wrap = document.createElement("div");
  wrap.className="stage";
  const hdr = document.createElement("div");
  hdr.className="sthdr";
  hdr.innerHTML = `<div class="name">${title}</div><div class="badge">${items.length}</div>`;
  wrap.appendChild(hdr);

  const rows = document.createElement("div");
  rows.className="rows";

  if(items.length===0){
    const empty = document.createElement("div");
    empty.className="row";
    empty.innerHTML = `<div><div class="sym">Geen coins.</div></div><div></div>`;
    rows.appendChild(empty);
  }else{
    for(const c of items){
      const r = document.createElement("div");
      r.className="row";
      const left = document.createElement("div");
      left.innerHTML = `
        <div class="sym">
          <span>${c.symbol}</span>
          <span class="tag">${c.engine}</span>
          <span class="tag">${c.stage}</span>
        </div>
        <div class="small">
          prijs: ${c.price?.toFixed?.(6) ?? c.price} • ch24: ${c.ch24?.toFixed?.(2)}% • vm: ${c.vm?.toFixed?.(2)} • vol: $${fmt(c.vol)} • score: ${c.timingScore} • scans: ${c.totalScans}
        </div>
      `;
      const right = document.createElement("button");
      right.className="iconbtn";
      right.textContent="↗";
      right.title="Orderbook";
      right.onclick = ()=> loadOrderbook(c);

      r.appendChild(left);
      r.appendChild(right);
      rows.appendChild(r);
    }
  }

  wrap.appendChild(rows);
  return wrap;
}

function render(){
  if(!DATA) return;
  $("pillMode").innerHTML = `MODE: <b>${MODE.toUpperCase()}</b>`;
  $("pillBands").textContent = `Bands: low ${DATA.bands?.low?.toFixed?.(2)}% | high ${DATA.bands?.high?.toFixed?.(2)}%`;
  $("pillItems").textContent = `Items: ${DATA.poolSize ?? "—"}`;
  $("pillLast").textContent = `Last: ${DATA.ts ? new Date(DATA.ts).toLocaleString() : "—"}`;
  $("funnelMeta").textContent = `Bitget-only | KV memory | OB zScore gate | hedge=${DATA.hedgeMode ? "on":"off"}`;

  const funnel = $("funnel");
  funnel.innerHTML = "";

  // ENTRY boven, RADAR onder (zoals jij wil)
  funnel.appendChild(stageBlock("ENTRY",  DATA.funnel.entry ?? []));
  funnel.appendChild(stageBlock("ALMOST", DATA.funnel.almost ?? []));
  funnel.appendChild(stageBlock("BUILDUP",DATA.funnel.buildup ?? []));
  funnel.appendChild(stageBlock("RADAR",  DATA.funnel.radar ?? []));

  const counts = [
    ["ENTRY", (DATA.funnel.entry||[]).length],
    ["ALMOST",(DATA.funnel.almost||[]).length],
    ["BUILDUP",(DATA.funnel.buildup||[]).length],
    ["RADAR",(DATA.funnel.radar||[]).length],
  ].map(x=>`${x[0]}:${x[1]}`).join(" • ");
  $("funnelMeta").textContent = counts;
}

async function fetchJSON(url){
  const r = await fetch(url, { cache:"no-store" });
  const txt = await r.text();
  let j=null;
  try{ j = JSON.parse(txt); }catch(e){}
  if(!r.ok) throw new Error(j?.error || txt || `HTTP ${r.status}`);
  return j;
}

async function loadLatest(){
  try{
    const j = await fetchJSON(API_LATEST(MODE));
    DATA = j;
    render();
  }catch(e){
    toast("Kan latest niet laden", String(e.message||e), "bad", 6500);
  }
}

async function doScan(){
  toast("Scan gestart…", "Coingecko → Bitget-only filter → funnel update", "warn", 5000);
  try{
    const j = await fetchJSON(API_SCAN(MODE));
    DATA = j;
    render();
    toast("Scan klaar ✅", `pool=${j.poolSize} • entry=${(j.funnel.entry||[]).length}`, "good", 4500);
  }catch(e){
    toast("Scan fout", String(e.message||e), "bad", 7000);
  }
}

async function loadOrderbook(c){
  // Alleen zinvol bij ALMOST/ENTRY
  if(!(c.stage==="ALMOST" || c.stage==="ENTRY")){
    toast("Orderbook alleen bij ALMOST/ENTRY", `${c.symbol} zit in ${c.stage}`, "warn", 5200);
    return;
  }
  $("obCoin").textContent = c.symbol;
  $("obStage").textContent = c.stage;
  $("obZ").textContent = "…";
  $("obScore").textContent = "…";
  $("obRaw").textContent = "";

  try{
    const j = await fetchJSON(API_OB(c.bitgetSymbol, MODE));
    $("obZ").textContent = (j.zScore==null) ? "—" : j.zScore.toFixed(2);
    $("obScore").textContent = (j.obScore==null) ? "—" : j.obScore.toFixed(4);
    $("obRaw").textContent = `spread=${j.spreadPct?.toFixed?.(3)}% • mid=${j.mid?.toFixed?.(8)} • depthPct=${j.depthPct}% • bidsUsd=${fmt(j.bidsUsd)} asksUsd=${fmt(j.asksUsd)}`;
    toast("Orderbook ok", `${c.symbol} z=${j.zScore?.toFixed?.(2)}`, "good", 3500);
  }catch(e){
    // Belangrijk: geen 'OB ERR' spam op de UI — we tonen een nette toast
    toast("Orderbook niet beschikbaar", String(e.message||e), "warn", 6500);
    $("obZ").textContent = "—";
    $("obScore").textContent = "—";
  }
}

$("btnScan").onclick = doScan;
$("btnRefresh").onclick = loadLatest;

$("switch").onclick = (ev)=>{
  const el = ev.target.closest(".opt");
  if(!el) return;
  const mode = el.dataset.mode;
  MODE = mode;
  for(const o of document.querySelectorAll(".opt")) o.classList.toggle("active", o.dataset.mode===MODE);
  loadLatest();
};

loadLatest();
