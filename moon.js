// /moon.js
const qs = new URLSearchParams(location.search);
let mode = (qs.get("mode") || "bull").toLowerCase();
if (mode !== "bull" && mode !== "bear") mode = "bull";

const API = (m) => `/api/moon-latest?mode=${encodeURIComponent(m)}`;

const elElite = document.getElementById("elite");
const elAlmost = document.getElementById("almost");
const elBuildup = document.getElementById("buildup");
const elStatus = document.getElementById("status");

document.getElementById("bullBtn").onclick = () => setMode("bull");
document.getElementById("bearBtn").onclick = () => setMode("bear");
document.getElementById("refreshBtn").onclick = () => load();

function setMode(m) {
  mode = m;
  qs.set("mode", mode);
  history.replaceState(null, "", `${location.pathname}?${qs.toString()}`);
  load();
}

function row(c) {
  const depth = Math.min(c?.ob?.bidUsd || 0, c?.ob?.askUsd || 0);
  const floor = c?.floorUsd || 0;

  return `
  <div class="row">
    <div class="sym">${c.symbol}</div>
    <div class="muted">${c.name || ""}</div>
    <div>Price: <b>$${fmt(c.price)}</b></div>
    <div>Chg24: <b>${fmtSign(c.change24)}%</b> | Range24: ${fmt(c.range24)}%</div>
    <div>MC: ${short(c.marketCap)} | Vol: ${short(c.volume)} | VM: ${fmt(c.vm)}</div>
    <div>Conf: <b>${c.confidence}</b> | Cons: ${Math.round((c.consistency?.ratio||0)*100)}%</div>
    <div>OB: ${c.ob?.status || "none"} | score: ${fmt(c.ob?.score)} | spread: ${fmt(c.ob?.spreadPct)}% | LOR: ${fmt(c.ob?.lor)}</div>
    <div>Depth(min): ${short(depth)} | Floor: ${short(floor)} | DepthOk: ${c.depthOk}</div>
    <div class="why">EliteGate: ${c?.why?.elite || ""}</div>
  </div>`;
}

function render(list, el) {
  if (!list || !list.length) {
    el.innerHTML = `<div class="empty">Geen coins</div>`;
    return;
  }
  el.innerHTML = list.map(row).join("");
}

async function load() {
  elStatus.textContent = "Loading...";
  try {
    const r = await fetch(API(mode), { cache: "no-store" });
    const j = await r.json();

    const counts = j?.counts || {};
    const note = j?.note ? ` • ${j.note}` : "";
    const btc = j?.btc ? ` • BTC ${j.btc.state} (${fmtSign(j.btc.chg24)}% / ${fmt(j.btc.range24)}%)` : "";

    elStatus.textContent =
      `${mode.toUpperCase()} | Elite ${counts.elite||0} | Almost ${counts.almost||0} | Buildup ${counts.buildup||0}${btc}${note}`;

    render(j?.funnel?.elite || [], elElite);
    render(j?.funnel?.almost || [], elAlmost);
    render(j?.funnel?.buildup || [], elBuildup);
  } catch (e) {
    elStatus.textContent = "Error bij laden (check Vercel logs)";
    elElite.innerHTML = `<pre>${String(e)}</pre>`;
  }
}

function fmt(n) { return (Number(n)||0).toFixed(2); }
function fmtSign(n){ n=Number(n)||0; return (n>=0?"+":"")+n.toFixed(2); }
function short(n){
  n = Number(n)||0;
  if (n >= 1e9) return (n/1e9).toFixed(2)+"B";
  if (n >= 1e6) return (n/1e6).toFixed(2)+"M";
  if (n >= 1e3) return (n/1e3).toFixed(2)+"K";
  return n.toFixed(0);
}

load();