const el = (id) => document.getElementById(id);

const API = {
  latest: (mode) => `/api/latest?mode=${encodeURIComponent(mode)}`,
  scan:   (mode) => `/api/scan?mode=${encodeURIComponent(mode)}`,
  ob:     (symbol) => `/api/orderbook?symbol=${encodeURIComponent(symbol)}`
};

let MODE = localStorage.getItem("MODE") || "bull";

function setMode(mode){
  MODE = mode;
  localStorage.setItem("MODE", mode);
  el("modeBull").classList.toggle("active", mode==="bull");
  el("modeBear").classList.toggle("active", mode==="bear");
  loadLatest();
}

function fmtUSD(n){
  if(!Number.isFinite(n)) return "-";
  if(n >= 1e9) return (n/1e9).toFixed(2)+"B";
  if(n >= 1e6) return (n/1e6).toFixed(2)+"M";
  if(n >= 1e3) return (n/1e3).toFixed(2)+"K";
  return String(Math.round(n));
}
function fmtPct(n){
  if(!Number.isFinite(n)) return "-";
  const s = n >= 0 ? "+" : "";
  return s + n.toFixed(2) + "%";
}

function coinRow(c){
  const div = document.createElement("div");
  div.className = "coinRow";
  div.innerHTML = `
    <div class="coinTop">
      <div class="sym">${c.symbol}</div>
      <div class="tag">${fmtPct(c.change24)}</div>
    </div>
    <div class="coinMeta">
      <span>prijs: $${c.price}</span>
      <span>vol: $${fmtUSD(c.volume)}</span>
      <span>mc: $${fmtUSD(c.marketCap)}</span>
      <span>vm: ${Number(c.vm||0).toFixed(2)}</span>
    </div>
  `;
  div.addEventListener("click", () => loadOrderbook(c.symbol));
  return div;
}

function renderStage(targetId, arr){
  const box = el(targetId);
  box.innerHTML = "";
  if(!arr || arr.length===0){
    box.innerHTML = `<div class="empty">Geen coins.</div>`;
    return;
  }
  for(const c of arr){
    box.appendChild(coinRow(c));
  }
}

function renderAll(data){
  const ts = data?.ts ? new Date(data.ts) : null;
  const stamp = ts ? ts.toLocaleString() : "—";

  const f = data?.funnel || {};
  const entry = f.entry || [];
  const hold  = f.hold || [];
  const buildup = f.buildup || [];
  const radar = f.radar || [];
  const sell = f.sell || [];

  el("statusLine").textContent =
    `Mode: ${MODE.toUpperCase()} • Laatste update: ${stamp} • BitgetOnly: ${data?.bitgetOnly ? "JA" : "nee"}`;

  el("funnelMeta").textContent =
    `KV opslag actief • Cron vult automatisch • Klik coin voor orderbook`;

  renderStage("stageEntry", entry);
  renderStage("stageHold", hold);
  renderStage("stageBuildup", buildup);
  renderStage("stageRadar", radar);
  renderStage("stageSell", sell);
}

async function loadLatest(){
  try{
    el("statusLine").textContent = "Status: laden…";
    const r = await fetch(API.latest(MODE), { cache: "no-store" });
    const j = await r.json();
    renderAll(j || {});
  }catch(e){
    el("statusLine").textContent = "Status: fout bij laden (check Vercel logs)";
  }
}

async function runScanNow(){
  try{
    el("statusLine").textContent = "Status: scan bezig…";
    const r = await fetch(API.scan(MODE), { cache: "no-store" });
    const j = await r.json();
    renderAll(j || {});
  }catch(e){
    el("statusLine").textContent = "Status: scan fout (CoinGecko limit of server error)";
  }
}

async function loadOrderbook(symbol){
  try{
    el("obTitle").textContent = `${symbol} (Bitget OB)`;
    el("obData").textContent = "Laden…";

    const r = await fetch(API.ob(symbol), { cache:"no-store" });
    const j = await r.json();

    if(j?.error){
      el("obData").textContent = `OB ERROR:\n${j.error}`;
      return;
    }

    el("obData").textContent =
      `score: ${Number(j.score).toFixed(4)}\n`+
      `bidUsd: ${Math.round(j.bidUsd)}\n`+
      `askUsd: ${Math.round(j.askUsd)}\n`+
      `mid: ${j.mid}\n`;

  }catch(e){
    el("obData").textContent = "OB ERROR: fetch mislukt";
  }
}

el("modeBull").addEventListener("click", () => setMode("bull"));
el("modeBear").addEventListener("click", () => setMode("bear"));
el("scanNow").addEventListener("click", runScanNow);

setMode(MODE);
setInterval(loadLatest, 30000);
