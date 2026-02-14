// /app.js
const el = (id) => document.getElementById(id);

const API = {
  latest: (mode) => `/api/latest?mode=${encodeURIComponent(mode)}`,
  ob: (symbol, side) => `/api/orderbook?symbol=${encodeURIComponent(symbol)}&side=${encodeURIComponent(side)}`
};

let MODE = new URLSearchParams(location.search).get("mode") || localStorage.getItem("MODE") || "bull";
let LAST = null;
let MODAL_COIN = null;

// ====== UI helpers ======
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
function fmtNum(n){ return (Number(n)||0).toFixed(2); }

function setMode(mode){
  MODE = mode;
  localStorage.setItem("MODE", mode);
  el("modeBull").classList.toggle("active", mode==="bull");
  el("modeBear").classList.toggle("active", mode==="bear");
  loadLatest();
}

// ====== render rows ======
function coinRow(c){
  const div = document.createElement("div");
  div.className = "coinRow";
  div.innerHTML = `
    <div class="coinTop">
      <div class="sym">${c.symbol}</div>
      <div class="tag">${fmtPct(c.change24)} • vm ${fmtNum(c.vm)} • S ${Math.round(c.strength||0)}</div>
    </div>
    <div class="coinMeta">
      <span>prijs: $${fmtNum(c.price)}</span>
      <span>vol: $${fmtUSD(c.volume)}</span>
      <span>mc: $${fmtUSD(c.marketCap)}</span>
      <span>range24: ${fmtPct(c.range24)}</span>
      <span>scans: ${c.stageScans||0}</span>
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

  const radar = data?.funnel?.radar || [];
  const buildup = data?.funnel?.buildup || [];
  const almost = data?.funnel?.almost || [];
  const entry = data?.funnel?.entry || [];

  const btc = data?.btc || {};
  const note = data?.note ? ` • ${data.note}` : "";

  el("statusLine").textContent =
    `Mode: ${MODE.toUpperCase()} • Laatste: ${stamp} • Radar ${radar.length} • Buildup ${buildup.length} • Almost ${almost.length} • Entry ${entry.length}${note}`;

  // reset link (met token)
  const token = (localStorage.getItem("CRON_SECRET") || "").trim();
  const resetUrl = token
    ? `/api/reset?mode=${encodeURIComponent(MODE)}&token=${encodeURIComponent(token)}`
    : `/api/reset?mode=${encodeURIComponent(MODE)}`;
  el("resetLink").href = resetUrl;

  el("funnelMeta").textContent =
    `BTC gate: ${btc.state||"—"} (chg24 ${fmtPct(btc.chg24||0)}, range24 ${fmtPct(btc.range24||0)}) • coinRangeCap ${fmtPct(btc.dynamicMaxRange24||0)} • Consistency window: 2h (min 6 samples)`;

  renderStage("stageEntry", entry);
  renderStage("stageAlmost", almost);
  renderStage("stageBuildup", buildup);
  renderStage("stageRadar", radar);
}

// ====== modal ======
function openModal(c){
  MODAL_COIN = c;
  el("modal").classList.remove("hidden");

  el("mTitle").textContent = `${c.symbol} • ${c.stage}`;
  el("mSub").textContent = `${MODE.toUpperCase()} • strength ${Math.round(c.strength||0)}/100 • scans ${c.stageScans||0}`;

  const why = []
    .concat(`Reasons:`)
    .concat((c.reasons||[]).map(x => `- ${x}`))
    .join("\n");

  const need = []
    .concat(`Next targets:`)
    .concat(`BUILDUP:`)
    .concat((c.needBuildup||[]).map(x => `- ${x}`))
    .concat(``)
    .concat(`ALMOST:`)
    .concat((c.needAlmost||[]).map(x => `- ${x}`))
    .join("\n");

  const consTxt = c.consistency == null
    ? `consistency: warming up (samples ${c.consistencySamples||0}/${6})`
    : `consistency: ${(c.consistency*100).toFixed(0)}% (samples ${c.consistencySamples||0})`;

  const stats = [
    `prijs: $${fmtNum(c.price)}`,
    `chg24: ${fmtPct(c.change24)}`,
    `range24: ${fmtPct(c.range24)}`,
    `volume: $${fmtUSD(c.volume)}`,
    `marketCap: $${fmtUSD(c.marketCap)}`,
    `vm: ${fmtNum(c.vm)}`,
    consTxt,
    `enteredAt: ${c.enteredAt ? new Date(c.enteredAt).toLocaleString() : "-"}`,
  ].join("\n");

  el("mWhy").textContent = why;
  el("mNeed").textContent = need;
  el("mStats").textContent = stats;

  const b = c.btc || {};
  el("mBTC").textContent = [
    `state: ${b.state||"-"}`,
    `chg24: ${fmtPct(b.chg24||0)}`,
    `range24: ${fmtPct(b.range24||0)}`,
    `coinRangeCap: ${fmtPct(b.dynamicMaxRange24||0)}`
  ].join("\n");

  el("mOB").textContent = "Klik op ‘Orderbook laden’";
  el("mRisk").textContent =
    `Plan (v1):\n- SL/TP komt in stap 2 (ATR 1h)\n- We tonen nu eerst strength + consistency + OB\n\nLater:\n- SL = 1.8×ATR(1h)\n- TP1/TP2 + risk ladder via edge-score`;

}

function closeModal(){
  el("modal").classList.add("hidden");
  MODAL_COIN = null;
}

// OB fetch in modal
async function loadModalOB(){
  if(!MODAL_COIN) return;
  el("mOB").textContent = "Laden…";

  try{
    const r = await fetch(API.ob(MODAL_COIN.symbol, MODE), { cache:"no-store" });
    const j = await r.json();

    if(j?.error){
      el("mOB").textContent = `OB ERROR:\n${j.error}`;
      return;
    }
    if(j?.status === "validating"){
      el("mOB").textContent = `validating...\n${j.tip||""}`;
      return;
    }

    el("mOB").textContent = [
      `valid: ${j.valid}`,
      `avgScore: ${j.avgScore ?? "-"}`,
      `score: ${j.score ?? "-"}`,
      `spreadPct: ${j.spreadPct ?? "-"}`,
      `lor: ${j.lor ?? "-"}`,
      `bidUsd: ${Math.round(j.bidUsd || 0)}`,
      `askUsd: ${Math.round(j.askUsd || 0)}`,
      `stale: ${j.stale}`
    ].join("\n");
  }catch(e){
    el("mOB").textContent = "OB ERROR: fetch mislukt";
  }
}

// ====== load latest ======
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

// buttons
el("modeBull").addEventListener("click", () => setMode("bull"));
el("modeBear").addEventListener("click", () => setMode("bear"));
el("mClose").addEventListener("click", closeModal);
el("modal").addEventListener("click", (e) => { if(e.target.id==="modal") closeModal(); });
el("mObBtn").addEventListener("click", loadModalOB);

// start
setMode(MODE);
// refresh UI elke 20s
setInterval(loadLatest, 20000);