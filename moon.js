let mode = "bull";

const stageElite   = document.getElementById("stageElite");
const stageAlmost  = document.getElementById("stageAlmost");
const stageBuildup = document.getElementById("stageBuildup");
const stageRadar   = document.getElementById("stageRadar");
const statusLine   = document.getElementById("statusLine");

document.getElementById("modeBull").onclick = () => setMode("bull");
document.getElementById("modeBear").onclick = () => setMode("bear");
document.getElementById("refreshBtn").onclick = () => load();

function setMode(m){
  mode = m;
  load();
}

function createRow(c){
  const div = document.createElement("div");
  div.className = "coinRow";
  div.innerHTML = `
    <div class="coinTop">
      <div class="sym">${c.symbol}</div>
      <div class="tag">${c.name}</div>
    </div>
    <div class="coinMeta">
      <span class="pill">Price $${Number(c.price).toFixed(4)}</span>
      <span class="pill">24h ${Number(c.change24).toFixed(2)}%</span>
      <span class="pill">Range ${Number(c.range24).toFixed(2)}%</span>
      <span class="pill">VM ${Number(c.vm).toFixed(2)}</span>
    </div>
  `;

  div.onclick = () => openModal(c);
  return div;
}

function render(stage, el){
  el.innerHTML = "";
  if(!stage || !stage.length){
    el.innerHTML = `<div class="empty">Geen coins</div>`;
    return;
  }
  stage.forEach(c => el.appendChild(createRow(c)));
}

async function load(){
  statusLine.textContent = "Laden...";

  const res = await fetch(`/api/moon-latest?mode=${mode}`, { cache:"no-store" });
  const data = await res.json();

  const counts = data.counts || {};

  statusLine.textContent =
    `Mode: ${mode.toUpperCase()} • Elite ${counts.elite||0} • Almost ${counts.almost||0} • Buildup ${counts.buildup||0} • Radar ${counts.radar||0}`;

  const funnel = data.funnel || {};

  render(funnel.elite, stageElite);
  render(funnel.almost, stageAlmost);
  render(funnel.buildup, stageBuildup);
  render(funnel.radar, stageRadar);
}

/* MODAL */

const modal = document.getElementById("modal");
const mTitle = document.getElementById("mTitle");
const mSub   = document.getElementById("mSub");
const mWhy   = document.getElementById("mWhy");
const mData  = document.getElementById("mData");

document.getElementById("mClose").onclick = () => {
  modal.classList.add("hidden");
};

function openModal(c){
  mTitle.textContent = `${c.symbol} — ${c.name}`;
  mSub.textContent   = `Price $${c.price}`;

  mWhy.textContent =
`24h Change: ${c.change24}%
Range24: ${c.range24}%
Volume: ${c.volume}
MarketCap: ${c.marketCap}
VM: ${c.vm}`;

  mData.textContent = JSON.stringify(c, null, 2);

  modal.classList.remove("hidden");
}

load();