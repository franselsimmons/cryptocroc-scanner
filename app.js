let SIDE = "bull";
let SNAP = null;
let SELECTED = null;

const toast = document.getElementById("toast");

function showToast(msg){
  toast.textContent = msg;
  toast.classList.remove("hidden");
}
function hideToast(){
  toast.textContent = "";
  toast.classList.add("hidden");
}

function fmt(n){
  if (n === null || n === undefined) return "—";
  if (typeof n !== "number") return String(n);
  if (Math.abs(n) >= 1e9) return (n/1e9).toFixed(2)+"B";
  if (Math.abs(n) >= 1e6) return (n/1e6).toFixed(2)+"M";
  if (Math.abs(n) >= 1e3) return (n/1e3).toFixed(2)+"K";
  return n.toFixed(4);
}

function setOn(btnOn, btnOff){
  btnOn.classList.add("on");
  btnOff.classList.remove("on");
}

function renderList(id, arr){
  const box = document.getElementById(id);
  box.innerHTML = "";
  if (!arr || arr.length === 0){
    box.innerHTML = `<div class="panelHint">Geen coins.</div>`;
    return;
  }
  for (const c of arr){
    const tagClass =
      c.obStatus === "HOLD" ? "good" :
      c.obStatus === "SELL" ? "bad" :
      c.stage === "ENTRY" ? "good" :
      c.stage === "ALMOST" ? "warn" :
      "";

    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `
      <div class="left">
        <div class="sym">${c.symbol}</div>
        <div class="meta">
          prijs: $${fmt(c.price)} · ch24: ${fmt(c.ch24)}% · vm: ${fmt(c.vm)} · vol: $${fmt(c.vol)}
          · score: ${c.timingScore} · scans: ${c.totalScans}
          ${c.obErr ? " · obErr: "+c.obErr : ""}
        </div>
      </div>
      <div class="tag ${tagClass}">
        ${c.obStatus || c.stage}
      </div>
    `;
    el.onclick = () => selectCoin(c.symbol);
    box.appendChild(el);
  }
}

async function selectCoin(symbol){
  SELECTED = symbol;
  const res = await fetch(`/api/orderbook?side=${encodeURIComponent(SIDE)}&symbol=${encodeURIComponent(symbol)}`);
  const j = await res.json();

  document.getElementById("obTitle").textContent = `${symbol} (${SIDE.toUpperCase()})`;
  document.getElementById("obStage").textContent = j.stage || "—";
  document.getElementById("obTiming").textContent = (j.timingScore ?? "—");
  document.getElementById("obScore").textContent = (j.obScore ?? "—");
  document.getElementById("obZ").textContent = (j.zScore ?? "—");
  document.getElementById("obSpread").textContent = (j.spreadPct ?? "—");
  document.getElementById("obStatus").textContent = (j.obStatus ?? "—");
  document.getElementById("obHint").textContent = j.note || "";
  document.getElementById("obRaw").textContent = JSON.stringify(j.raw || {}, null, 2);
}

function renderAll(snap){
  SNAP = snap;

  document.getElementById("meta").textContent =
    `items: ${snap.itemsTotal} · last: ${new Date(snap.ts).toLocaleString()}`;

  document.getElementById("bands").textContent =
    `Bands: low ${snap.lowBand.toFixed(2)}% | high ${snap.highBand.toFixed(2)}%`;

  document.getElementById("count").textContent = snap.itemsTotal;

  document.getElementById("c_entry").textContent = snap.entry.length;
  document.getElementById("c_hold").textContent = snap.hold.length;
  document.getElementById("c_sell").textContent = snap.sell.length;
  document.getElementById("c_almost").textContent = snap.almost.length;
  document.getElementById("c_buildup").textContent = snap.buildup.length;
  document.getElementById("c_radar").textContent = snap.radar.length;

  renderList("entry", snap.entry);
  renderList("hold", snap.hold);
  renderList("sell", snap.sell);
  renderList("almost", snap.almost);
  renderList("buildup", snap.buildup);
  renderList("radar", snap.radar);

  // ✅ Dit fixt jouw “balk blijft hangen”:
  // Als de API ok is, verbergen we de toast altijd.
  hideToast();
}

async function loadLatest(){
  const r = await fetch(`/api/latest?side=${encodeURIComponent(SIDE)}`);
  const j = await r.json();
  if (!j.ok){
    showToast(j.error || "Geen data. Druk op Scan nu.");
    return;
  }
  renderAll(j.snapshot);
  if (SELECTED){
    // refresh selected box
    selectCoin(SELECTED).catch(()=>{});
  }
}

async function scanNow(){
  showToast("Scan bezig…");
  const r = await fetch(`/api/scan?side=${encodeURIComponent(SIDE)}`);
  const j = await r.json();
  if (!j.ok){
    showToast(j.error || "Scan fout");
    return;
  }
  renderAll(j.snapshot);
}

document.getElementById("btnBull").onclick = async () => {
  SIDE = "bull";
  setOn(document.getElementById("btnBull"), document.getElementById("btnBear"));
  SELECTED = null;
  await loadLatest();
};
document.getElementById("btnBear").onclick = async () => {
  SIDE = "bear";
  setOn(document.getElementById("btnBear"), document.getElementById("btnBull"));
  SELECTED = null;
  await loadLatest();
};
document.getElementById("btnScan").onclick = scanNow;
document.getElementById("btnRefresh").onclick = loadLatest;

// start
loadLatest().catch(()=>showToast("Geen data. Druk op Scan nu."));
