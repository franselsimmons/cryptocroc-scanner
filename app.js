const el = (id) => document.getElementById(id);

const API = {
  latest: (mode) => `/api/latest?mode=${encodeURIComponent(mode)}`,
  ob: (symbol, side, price) =>
    `/api/orderbook?symbol=${encodeURIComponent(symbol)}&side=${encodeURIComponent(side)}&price=${encodeURIComponent(price)}`
};

let MODE = localStorage.getItem("MODE") || "bull";
let LAST = null;

// ===== helpers =====
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
function fmtPrice(n){
  if(!Number.isFinite(n)) return "-";
  if(n >= 1) return n.toFixed(4);
  return n.toPrecision(6);
}
function fmtNum(n){
  if(!Number.isFinite(n)) return "-";
  return n.toFixed(4);
}

// ===== mode =====
function setMode(mode){
  MODE = mode;
  localStorage.setItem("MODE", mode);
  el("modeBull").classList.toggle("active", mode==="bull");
  el("modeBear").classList.toggle("active", mode==="bear");
  loadLatest();
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
      <span>prijs: $${fmtPrice(c.price)}</span>
      <span>vol: $${fmtUSD(c.volume)}</span>
      <span>mc: $${fmtUSD(c.marketCap)}</span>
      <span>vm: ${Number.isFinite(c.vm) ? c.vm.toFixed(2) : "-"}</span>
      <span>range24: ${Number.isFinite(c.range24) ? c.range24.toFixed(1) : "-"}%</span>
    </div>
  `;
  div.addEventListener("click", () => openModal(c));
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
  LAST = data;

  const ts = data?.ts ? new Date(data.ts) : null;
  const stamp = ts ? ts.toLocaleString() : "—";

  const radar   = data?.radar   || [];
  const buildup = data?.buildup || [];
  const almost  = data?.almost  || [];
  const entry   = data?.entry   || [];

  const btc = data?.btc || {};
  const btcLine = btc?.state ? `BTC: ${btc.state} (chg24 ${fmtPct(btc.change24)} • range24 ${btc.range24?.toFixed?.(2) ?? "-"}%)` : "BTC: —";

  el("statusLine").textContent =
    `${btcLine} • Mode: ${MODE.toUpperCase()} • Laatste update: ${stamp} • Entry ${entry.length} • Almost ${almost.length} • Buildup ${buildup.length} • Radar ${radar.length}`;

  el("funnelMeta").textContent =
    `Automatisch elke 10 min • KV opslag actief • OB samples elke minuut • Klik coin voor popup`;

  renderStage("stageEntry", entry);
  renderStage("stageAlmost", almost);
  renderStage("stageBuildup", buildup);
  renderStage("stageRadar", radar);
}

// ===== data load =====
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

// ===== MODAL =====
function showModal(){
  el("modal").classList.remove("hidden");
}
function hideModal(){
  el("modal").classList.add("hidden");
}

async function openModal(c){
  // top
  el("mTitle").textContent = `${c.symbol} — ${c.name || ""}`.trim();
  el("mSub").textContent = `Mode: ${MODE.toUpperCase()} • prijs $${fmtPrice(c.price)} • change24 ${fmtPct(c.change24)}`;

  // coin info
  el("mCoin").textContent =
    `symbol: ${c.symbol}\n`+
    `naam: ${c.name || "-"}\n`+
    `prijs: $${fmtPrice(c.price)}\n`+
    `24h: ${fmtPct(c.change24)}\n`+
    `volume: $${fmtUSD(c.volume)}\n`+
    `marketcap: $${fmtUSD(c.marketCap)}\n`+
    `vm ratio: ${Number.isFinite(c.vm) ? c.vm.toFixed(4) : "-"}\n`+
    `range24: ${Number.isFinite(c.range24) ? c.range24.toFixed(2) : "-"}%\n`;

  // OB + SL/TP placeholder
  el("mOB").textContent = "Laden… (orderbook + ATR(1h) + SL/TP)";

  showModal();

  try{
    const r = await fetch(API.ob(c.symbol, MODE, c.price), { cache:"no-store" });
    const j = await r.json();

    if(j?.error){
      el("mOB").textContent = `ERROR:\n${j.error}`;
      return;
    }

    // SL/TP blok
    const atrLine = Number.isFinite(j.atr1h) ? `$${fmtPrice(j.atr1h)}` : "-";
    const priceUsed = Number.isFinite(j.priceUsed) ? `$${fmtPrice(j.priceUsed)}` : "-";
    const sl = Number.isFinite(j.sl) ? `$${fmtPrice(j.sl)}` : "-";
    const tp1 = Number.isFinite(j.tp1) ? `$${fmtPrice(j.tp1)}` : "-";
    const tp2 = Number.isFinite(j.tp2) ? `$${fmtPrice(j.tp2)}` : "-";

    // OB blok
    const obStatus =
      j.status === "validating" ? "validating (samples verzamelen)" :
      (j.valid ? "VALID" : `NOT VALID (${j.reason || "?"})`);

    el("mOB").textContent =
      `OB status: ${obStatus}\n`+
      (j.stale ? `OB stale: true\n` : ``)+
      `score: ${j.score ?? "-"}\n`+
      `avgScore(3): ${j.avgScore ?? "-"}\n`+
      `spread: ${j.spreadPct ?? "-"}%\n`+
      `largestOrderRatio: ${j.lor ?? "-"}\n`+
      `bidUsd: ${j.bidUsd ? Math.round(j.bidUsd) : "-"}\n`+
      `askUsd: ${j.askUsd ? Math.round(j.askUsd) : "-"}\n\n`+
      `ATR(1h,14): ${atrLine}\n`+
      `price used: ${priceUsed}\n`+
      `SL (1.8x ATR): ${sl}\n`+
      `TP1 (2x ATR): ${tp1}\n`+
      `TP2 (3x ATR): ${tp2}\n`;

  }catch(e){
    el("mOB").textContent = "ERROR: fetch mislukt";
  }
}

// ===== buttons =====
el("modeBull").addEventListener("click", () => setMode("bull"));
el("modeBear").addEventListener("click", () => setMode("bear"));
el("mClose").addEventListener("click", hideModal);
el("modal").addEventListener("click", (ev) => {
  if(ev.target === el("modal")) hideModal(); // klik buiten popup sluit
});

// init
setMode(MODE);

// auto refresh UI
setInterval(loadLatest, 30000);
