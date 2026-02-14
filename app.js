const el = (id) => document.getElementById(id);

const API = {
  latest: (mode) => `/api/latest?mode=${encodeURIComponent(mode)}`,
  scan:   (mode) => `/api/scan?mode=${encodeURIComponent(mode)}`,
  ob:     (mode, symbol) => `/api/orderbook?mode=${encodeURIComponent(mode)}&symbol=${encodeURIComponent(symbol)}`
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
  n = Number(n);
  if(!Number.isFinite(n)) return "-";
  if(n >= 1e9) return (n/1e9).toFixed(2)+"B";
  if(n >= 1e6) return (n/1e6).toFixed(2)+"M";
  if(n >= 1e3) return (n/1e3).toFixed(2)+"K";
  return String(Math.round(n));
}

function fmtPct(n){
  n = Number(n);
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
      <span>vm: ${Number(c.vm).toFixed(2)}</span>
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

  const entry = data?.funnel?.entry || [];
  const buildup = data?.funnel?.buildup || [];
  const radar = data?.funnel?.radar || [];

  el("statusLine").textContent =
    `Mode: ${MODE.toUpperCase()} • Laatste update: ${stamp} • Entry ${entry.length} • Buildup ${buildup.length} • Radar ${radar.length}`;

  el("funnelMeta").textContent =
    `KV opslag: aan • Cron: elke 10 min • Klik coin = Bitget OB + z-score`;

  renderStage("stageEntry", entry);
  renderStage("stageBuildup", buildup);
  renderStage("stageRadar", radar);
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
    el("statusLine").textContent = "Status: scan fout (CoinGecko limit / server error)";
  }
}

async function loadOrderbook(symbol){
  try{
    el("obTitle").textContent = `${symbol} (Bitget OB + z-score)`;
    el("obData").textContent = "Laden…";

    const r = await fetch(API.ob(MODE, symbol), { cache:"no-store" });
    const j = await r.json();

    if(!j?.ok){
      el("obData").textContent =
        `OB ERROR:\n${j?.error || "unknown"}\n\nTip: niet elke CoinGecko coin staat op Bitget USDT.`;
      return;
    }

    el("obData").textContent =
      `score: ${j.score.toFixed(4)}\n`+
      `zScore: ${j.zScore.toFixed(2)} (samples ${j.samples})\n`+
      `passed: ${j.passed}\n`+
      `bidUsd: ${Math.round(j.bidUsd)}\n`+
      `askUsd: ${Math.round(j.askUsd)}\n`+
      `note: ${j.note}\n`;

  }catch(e){
    el("obData").textContent = "OB ERROR: fetch mislukt";
  }
}

// buttons
el("modeBull").addEventListener("click", () => setMode("bull"));
el("modeBear").addEventListener("click", () => setMode("bear"));
el("scanNow").addEventListener("click", runScanNow);

// start
setMode(MODE);

// UI refresh elke 30s (cron doet echte scan)
setInterval(loadLatest, 30000);
