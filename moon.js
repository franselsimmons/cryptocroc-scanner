const qs = new URLSearchParams(location.search);
let mode = (qs.get("mode") || "bull").toLowerCase();
if (mode !== "bull" && mode !== "bear") mode = "bull";

const stageElite   = document.getElementById("stageElite");
const stageAlmost  = document.getElementById("stageAlmost");
const stageBuildup = document.getElementById("stageBuildup");
const stageRadar   = document.getElementById("stageRadar");
const statusLine   = document.getElementById("statusLine");
const debugEl      = document.getElementById("debug");

const btnBull = document.getElementById("modeBull");
const btnBear = document.getElementById("modeBear");

document.getElementById("refreshBtn").onclick = () => load();
btnBull.onclick = () => setMode("bull");
btnBear.onclick = () => setMode("bear");

function setMode(m){
  mode = m;
  qs.set("mode", mode);
  history.replaceState(null, "", `${location.pathname}?${qs.toString()}`);
  paintButtons();
  load();
}

function paintButtons(){
  btnBull.classList.toggle("active", mode === "bull");
  btnBear.classList.toggle("active", mode === "bear");
}

function createRow(c){
  const div = document.createElement("div");
  div.className = "coinRow";
  div.innerHTML = `
    <div class="coinTop">
      <div class="sym">${c.symbol}</div>
      <div class="tag">${c.name || ""}</div>
    </div>
    <div class="coinMeta">
      <span class="pill">Price $${fmt(c.price, 6)}</span>
      <span class="pill">24h ${fmt(c.change24)}%</span>
      <span class="pill">Range ${fmt(c.range24)}%</span>
      <span class="pill">VM ${fmt(c.vm)}</span>
    </div>
  `;
  div.onclick = () => openModal(c);
  return div;
}

function render(list, el){
  el.innerHTML = "";
  if(!Array.isArray(list) || list.length === 0){
    el.innerHTML = `<div class="empty">Geen coins</div>`;
    return;
  }
  list.forEach(c => el.appendChild(createRow(c)));
}

async function load(){
  statusLine.textContent = "Laden...";
  try {
    const url = `/api/moon-latest?mode=${encodeURIComponent(mode)}`;
    const res = await fetch(url, { cache: "no-store" });

    const data = await res.json();
    debugEl.textContent = JSON.stringify(data, null, 2);

    const counts = data.counts || {};
    const btc = data.btc ? ` • BTC ${data.btc.state} (${fmtSign(data.btc.chg24)}% / ${fmt(data.btc.range24)}%)` : "";
    const note = data.note ? ` • ${data.note}` : "";

    statusLine.textContent =
      `Mode: ${mode.toUpperCase()} • Elite ${counts.elite||0} • Almost ${counts.almost||0} • Buildup ${counts.buildup||0} • Radar ${counts.radar||0}${btc}${note}`;

    const funnel = data.funnel || {};
    render(funnel.elite, stageElite);
    render(funnel.almost, stageAlmost);
    render(funnel.buildup, stageBuildup);
    render(funnel.radar, stageRadar);

  } catch (e) {
    statusLine.textContent = `Fout bij laden: ${String(e)}`;
    debugEl.textContent = String(e);
  }
}

/* MODAL */
const modal = document.getElementById("modal");
const mTitle = document.getElementById("mTitle");
const mSub   = document.getElementById("mSub");
const mWhy   = document.getElementById("mWhy");
const mData  = document.getElementById("mData");
document.getElementById("mClose").onclick = () => modal.classList.add("hidden");

function openModal(c){
  mTitle.textContent = `${c.symbol} — ${c.name || ""}`;
  mSub.textContent = `Price $${fmt(c.price, 6)} • 24h ${fmtSign(c.change24)}% • Range ${fmt(c.range24)}%`;

  mWhy.textContent =
`volume: ${c.volume}
marketCap: ${c.marketCap}
vm: ${c.vm}
confidence: ${c.confidence ?? "-"}
consistency: ${Math.round(((c.consistency?.ratio)||0)*100)}%
eliteGate: ${c?.why?.elite || ""}`;

  mData.textContent = JSON.stringify(c, null, 2);
  modal.classList.remove("hidden");
}

/* helpers */
function fmt(n, dec=2){ n = Number(n)||0; return n.toFixed(dec); }
function fmtSign(n){ n = Number(n)||0; return (n>=0?"+":"")+n.toFixed(2); }

paintButtons();
load();