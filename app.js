const el = (id) => document.getElementById(id);

const API = {
  latest: (mode) => `/api/latest?mode=${encodeURIComponent(mode)}`,
  ob: (symbol, side) => `/api/orderbook?symbol=${encodeURIComponent(symbol)}&side=${encodeURIComponent(side)}`
};

let MODE = new URLSearchParams(location.search).get("mode") || localStorage.getItem("MODE") || "bull";
let MODAL_COIN = null;

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

// nette coin row: rustig, 2 regels, belangrijkst bovenaan
function coinRow(c){
  const div = document.createElement("div");
  div.className = "coinRow";

  const strength = Math.round(c.strength || 0);
  const cons = (c.consistency == null) ? null : Math.round(c.consistency * 100);

  div.innerHTML = `
    <div class="coinTop">
      <div class="coinLeft">
        <div class="sym">${c.symbol}</div>
        <div class="name">${c.name || ""}</div>
      </div>
      <div class="coinRight">
        <span class="pill accent">${fmtPct(c.change24)}</span>
        <span class="pill">${"vm " + fmtNum(c.vm)}</span>
        <span class="pill ${strength >= 70 ? "ok" : ""}">S ${strength}</span>
      </div>
    </div>

    <div class="coinMeta">
      <div class="metaItem"><span class="metaKey">prijs</span><span class="metaVal">$${fmtNum(c.price)}</span></div>
      <div class="metaItem"><span class="metaKey">vol</span><span class="metaVal">$${fmtUSD(c.volume)}</span></div>
      <div class="metaItem"><span class="metaKey">mc</span><span class="metaVal">$${fmtUSD(c.marketCap)}</span></div>
      <div class="metaItem"><span class="metaKey">range</span><span class="metaVal">${fmtPct(c.range24)}</span></div>
      <div class="metaItem"><span class="metaKey">scans</span><span class="metaVal">${c.stageScans||0}</span></div>
      <div class="metaItem"><span class="metaKey">cons</span><span class="metaVal">${cons==null ? "warm-up" : cons+"%"}</span></div>
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

function setCount(id, n){
  const e = el(id);
  if(e) e.textContent = String(n || 0);
}

function renderAll(data){
  const ts = data?.ts ? new Date(data.ts) : null;
  const stamp = ts ? ts.toLocaleString() : "—";

  const entry = data?.funnel?.entry || [];
  const almost = data?.funnel?.almost || [];
  const buildup = data?.funnel?.buildup || [];
  const radar = data?.funnel?.radar || [];

  setCount("cntEntry", entry.length);
  setCount("cntAlmost", almost.length);
  setCount("cntBuildup", buildup.length);
  setCount("cntRadar", radar.length);

  const btc = data?.btc || {};
  const note = data?.note ? ` • ${data.note}` : "";

  el("statusLine").textContent =
    `Mode: ${MODE.toUpperCase()} • Laatste: ${stamp} • Radar ${radar.length} • Buildup ${buildup.length} • Almost ${almost.length} • Entry ${entry.length}${note}`;

  // reset link (met token als je hem opslaat)
  const token = (localStorage.getItem("CRON_SECRET") || "").trim();
  el("resetLink").href = token
    ? `/api/reset?mode=${encodeURIComponent(MODE)}&token=${encodeURIComponent(token)}`
    : `/api/reset?mode=${encodeURIComponent(MODE)}`;

  // coinRangeCap: dit is een “cap in %”, dus tonen we als percentage getal
  const cap = (btc.dynamicMaxRange24 == null) ? "-" : btc.dynamicMaxRange24.toFixed(1) + "%";

  el("funnelMeta").textContent =
    `BTC gate: ${btc.state||"—"} (chg24 ${fmtPct(btc.chg24||0)}, range24 ${fmtPct(btc.range24||0)}) • coinRangeCap ${cap} • Consistency: 2h (min 6 samples)`;

  renderStage("stageEntry", entry);
  renderStage("stageAlmost", almost);
  renderStage("stageBuildup", buildup);
  renderStage("stageRadar", radar);
}

// modal
function openModal(c){
  MODAL_COIN = c;
  el("modal").classList.remove("hidden");

  const strength = Math.round(c.strength || 0);
  const consTxt = (c.consistency == null)
    ? `warm-up (${c.consistencySamples||0}/6)`
    : `${Math.round(c.consistency*100)}% (${c.consistencySamples||0} samples)`;

  el("mTitle").textContent = `${c.symbol} • ${c.stage}`;
  el("mSub").textContent = `${MODE.toUpperCase()} • strength ${strength}/100 • scans ${c.stageScans||0} • cons ${consTxt}`;

  el("mWhy").textContent =
    ["Reasons:"].concat((c.reasons||[]).map(x => `- ${x}`)).join("\n");

  el("mNeed").textContent =
    ["BUILDUP targets:"]
      .concat((c.needBuildup||[]).map(x => `- ${x}`))
      .concat(["", "ALMOST targets:"])
      .concat((c.needAlmost||[]).map(x => `- ${x}`))
      .join("\n");

  el("mStats").textContent = [
    `prijs: $${fmtNum(c.price)}`,
    `chg24: ${fmtPct(c.change24)}`,
    `range24: ${fmtPct(c.range24)}`,
    `vol: $${fmtUSD(c.volume)}`,
    `mc: $${fmtUSD(c.marketCap)}`,
    `vm: ${fmtNum(c.vm)}`,
    `enteredAt: ${c.enteredAt ? new Date(c.enteredAt).toLocaleString() : "-"}`,
  ].join("\n");

  const b = c.btc || {};
  const cap = (b.dynamicMaxRange24 == null) ? "-" : b.dynamicMaxRange24.toFixed(1) + "%";
  el("mBTC").textContent = [
    `state: ${b.state||"-"}`,
    `chg24: ${fmtPct(b.chg24||0)}`,
    `range24: ${fmtPct(b.range24||0)}`,
    `coinRangeCap: ${cap}`,
  ].join("\n");

  el("mRisk").textContent =
`Plan:
- RADAR → BUILDUP → ALMOST
- Entry komt later pas met Orderbook gate (valid + score)

Hoe jij dit gebruikt:
- strength + consistency hoog = betere kans
- check Orderbook voor bevestiging`;

  el("mOB").textContent = "Klik ‘Orderbook laden’.";
}

function closeModal(){
  el("modal").classList.add("hidden");
  MODAL_COIN = null;
}

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
      `stale: ${j.stale}`,
    ].join("\n");
  }catch{
    el("mOB").textContent = "OB ERROR: fetch mislukt";
  }
}

async function loadLatest(){
  try{
    el("statusLine").textContent = "Status: laden…";
    const r = await fetch(API.latest(MODE), { cache:"no-store" });
    const j = await r.json();
    renderAll(j || {});
  }catch{
    el("statusLine").textContent = "Status: fout bij laden (check Vercel logs)";
  }
}

// events
el("modeBull").addEventListener("click", () => setMode("bull"));
el("modeBear").addEventListener("click", () => setMode("bear"));
el("mClose").addEventListener("click", closeModal);
el("modal").addEventListener("click", (e) => { if(e.target.id==="modal") closeModal(); });
el("mObBtn").addEventListener("click", loadModalOB);

// start
setMode(MODE);
setInterval(loadLatest, 20000);