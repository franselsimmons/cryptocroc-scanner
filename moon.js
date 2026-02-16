// /public/moon.js
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

// ---- BELANGRIJK: vang beide API-vormen af ----
function normalizeFunnel(j) {
  // Vorm A: funnel = { elite:[], almost:[], buildup:[] }
  if (j?.funnel && !Array.isArray(j.funnel) && typeof j.funnel === "object") {
    return {
      elite: Array.isArray(j.funnel.elite) ? j.funnel.elite : [],
      almost: Array.isArray(j.funnel.almost) ? j.funnel.almost : [],
      buildup: Array.isArray(j.funnel.buildup) ? j.funnel.buildup : [],
    };
  }

  // Vorm B: funnel = [ ... ]  (dan zetten we alles in BUILDUP zodat je tenminste iets ziet)
  if (Array.isArray(j?.funnel)) {
    return { elite: [], almost: [], buildup: j.funnel };
  }

  // Soms heet het "radar" of "list" (fallback)
  if (Array.isArray(j?.radar)) return { elite: [], almost: [], buildup: j.radar };
  if (Array.isArray(j?.list)) return { elite: [], almost: [], buildup: j.list };

  return { elite: [], almost: [], buildup: [] };
}

function row(c) {
  const depth = Math.min(c?.ob?.bidUsd || 0, c?.ob?.askUsd || 0);
  const floor = c?.floorUsd || 0;

  return `
  <div class="row">
    <div class="sym">${esc(c.symbol || "")}</div>
    <div class="muted">${esc(c.name || "")}</div>
    <div>Price: <b>$${fmtPrice(c.price)}</b></div>
    <div>Chg24: <b>${fmtSign(c.change24)}%</b> | Range24: ${fmt(c.range24)}%</div>
    <div>MC: ${short(c.marketCap)} | Vol: ${short(c.volume)} | VM: ${fmt3(c.vm)}</div>
    <div>Conf: <b>${esc(c.confidence ?? "")}</b> | Cons: ${Math.round((c.consistency?.ratio||0)*100)}%</div>
    <div>OB: ${esc(c.ob?.status || "none")} | score: ${fmt3(c.ob?.score)} | spread: ${fmt3(c.ob?.spreadPct)}% | LOR: ${fmt3(c.ob?.lor)}</div>
    <div>Depth(min): ${short(depth)} | Floor: ${short(floor)} | DepthOk: ${esc(c.depthOk)}</div>
    <div class="why">EliteGate: ${esc(c?.why?.elite || "")}</div>
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

    // Als je ooit 429/500 krijgt, wil je dat direct zien
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status} ${r.statusText} ${t}`);
    }

    const j = await r.json();

    // counts kan verschillen per API versie
    const counts = j?.counts || {};
    const funnel = normalizeFunnel(j);

    const eliteN = counts.elite ?? funnel.elite.length ?? 0;
    const almostN = counts.almost ?? funnel.almost.length ?? 0;
    const buildupN = counts.buildup ?? funnel.buildup.length ?? 0;
    const radarN = counts.radar ?? 0;

    const note = j?.note ? ` • ${j.note}` : "";
    const btc = j?.btc
      ? ` • BTC ${j.btc.state} (${fmtSign(j.btc.chg24)}% / ${fmt(j.btc.range24)}%)`
      : "";

    elStatus.textContent =
      `${mode.toUpperCase()} | Elite ${eliteN} | Almost ${almostN} | Buildup ${buildupN}` +
      (radarN ? ` | Radar ${radarN}` : "") +
      `${btc}${note}`;

    render(funnel.elite, elElite);
    render(funnel.almost, elAlmost);
    render(funnel.buildup, elBuildup);

  } catch (e) {
    elStatus.textContent = "Error bij laden (check Vercel logs)";
    elElite.innerHTML = `<pre>${esc(String(e))}</pre>`;
    elAlmost.innerHTML = "";
    elBuildup.innerHTML = "";
  }
}

// ---- helpers ----
function esc(s){
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function fmt(n) { return (Number(n)||0).toFixed(2); }
function fmt3(n) { return (Number(n)||0).toFixed(3); }
function fmtPrice(n){
  const x = Number(n)||0;
  if (x === 0) return "0";
  if (x < 0.01) return x.toFixed(8);
  return x.toFixed(4);
}
function fmtSign(n){ n=Number(n)||0; return (n>=0?"+":"")+n.toFixed(2); }
function short(n){
  n = Number(n)||0;
  if (n >= 1e9) return (n/1e9).toFixed(2)+"B";
  if (n >= 1e6) return (n/1e6).toFixed(2)+"M";
  if (n >= 1e3) return (n/1e3).toFixed(2)+"K";
  return n.toFixed(0);
}

load();