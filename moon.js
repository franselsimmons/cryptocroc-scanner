// /moon.js
const qs = new URLSearchParams(location.search);
let mode = (qs.get("mode") || "bull").toLowerCase();
if (mode !== "bull" && mode !== "bear") mode = "bull";

const API = (m) => `/api/moon-latest?mode=${encodeURIComponent(m)}`;

const elElite   = document.getElementById("stageElite");
const elAlmost  = document.getElementById("stageAlmost");
const elBuildup = document.getElementById("stageBuildup");
const elRadar   = document.getElementById("stageRadar");
const elStatus  = document.getElementById("statusLine");

const btnBull = document.getElementById("modeBull");
const btnBear = document.getElementById("modeBear");

document.getElementById("refreshBtn").onclick = () => load();
btnBull.onclick = () => setMode("bull");
btnBear.onclick = () => setMode("bear");

// Modal
const modal = document.getElementById("modal");
const mClose = document.getElementById("mClose");
const mTitle = document.getElementById("mTitle");
const mSub   = document.getElementById("mSub");
const mWhy   = document.getElementById("mWhy");
const mOB    = document.getElementById("mOB");
const mStats = document.getElementById("mStats");
const mNext  = document.getElementById("mNext");

mClose.onclick = closeModal;
modal.addEventListener("click", (e) => {
  if (e.target === modal) closeModal();
});

function setMode(m) {
  mode = m;
  qs.set("mode", mode);
  history.replaceState(null, "", `${location.pathname}?${qs.toString()}`);
  updateButtons();
  load();
}

function updateButtons() {
  btnBull.classList.toggle("active", mode === "bull");
  btnBear.classList.toggle("active", mode === "bear");
}

function coinRow(c) {
  const changeClass = (c.change24 || 0) >= 0 ? "" : "danger";
  const consPct = Math.round(((c.consistency?.ratio ?? 0) * 100));

  return `
    <div class="coinRow" data-sym="${esc(c.symbol)}">
      <div class="coinTop">
        <div>
          <div class="sym">${esc(c.symbol)}</div>
          <div class="tag">${esc(c.name || "")}</div>
        </div>
        <div class="pill ${changeClass}">
          ${fmtSign(c.change24)}%
        </div>
      </div>

      <div class="coinMeta">
        <div class="pill">Price: $${fmt(c.price)}</div>
        <div class="pill">Range24: ${fmt(c.range24)}%</div>
        <div class="pill">MC: ${short(c.marketCap)}</div>
        <div class="pill">Vol: ${short(c.volume)}</div>
        <div class="pill">VM: ${fmt(c.vm)}</div>
        <div class="pill">Conf: ${c.confidence ?? "-"}</div>
        <div class="pill">Cons: ${consPct}%</div>
      </div>
    </div>
  `;
}

function renderStage(list, el, stageName) {
  if (!Array.isArray(list) || list.length === 0) {
    el.innerHTML = `<div class="empty">Geen coins</div>`;
    return;
  }

  el.innerHTML = list.map(coinRow).join("");

  // click handlers -> modal
  [...el.querySelectorAll(".coinRow")].forEach((rowEl) => {
    const sym = rowEl.getAttribute("data-sym");
    const coin = list.find((x) => String(x.symbol) === String(sym));
    rowEl.onclick = () => openModal(coin, stageName);
  });
}

function openModal(c, stage) {
  if (!c) return;

  mTitle.textContent = `${c.symbol} — ${stage}`;
  mSub.textContent = [
    `prijs $${fmt(c.price)}`,
    `chg24 ${fmtSign(c.change24)}%`,
    `range24 ${fmt(c.range24)}%`,
    `vm ${fmt(c.vm)}`
  ].join(" | ");

  const whyElite  = c?.why?.elite  ? `elite: ${c.why.elite}` : "";
  const whyAlmost = c?.why?.almost ? `almost: ${c.why.almost}` : "";
  const whyLine = [whyElite, whyAlmost].filter(Boolean).join("\n");
  mWhy.textContent = whyLine || "—";

  // OB / Depth block (kan soms leeg zijn)
  const ob = c?.ob || {};
  const depthMin = Math.min(ob?.bidUsd || 0, ob?.askUsd || 0);
  const floor = c?.floorUsd || 0;

  mOB.textContent =
`ob.status: ${ob.status || "none"}
ob.score: ${numOrDash(ob.score)}
ob.spreadPct: ${numOrDash(ob.spreadPct)}
ob.lor: ${numOrDash(ob.lor)}
obSlope: ${numOrDash(c.obSlope)}
depth(min): ${short(depthMin)}
floorUsd: ${short(floor)}
depthOk: ${String(c.depthOk ?? false)}`;

  const cons = c?.consistency || {};
  mStats.textContent =
`stage: ${c.stage || "-"}
stageScans: ${c.stageScans ?? "-"}
confidence: ${c.confidence ?? "-"}
consistency: ${Math.round((cons.ratio || 0) * 100)}% (${cons.same || 0}/${cons.total || 0})
volAcc: ${numOrDash(c.volAcc)}`;

  // Wat moet beter (simpel/duidelijk)
  const tips = [];
  if ((c.volAcc ?? 999) < 1.05) tips.push("VolAcc omhoog (meer echte activiteit / volume)");
  if ((cons.ratio ?? 0) < 0.6) tips.push("Consistency omhoog (meerdere scans zelfde richting)");
  if ((c.confidence ?? 0) < 60) tips.push("Confidence omhoog (VM/OB/btc bevestiging)");
  if ((c.depthOk ?? false) === false) tips.push("Depth moet hoger (orderbook diepte/kwaliteit)");
  if (!tips.length) tips.push("Ziet er goed uit — wachten op bevestiging / volgende scan");

  mNext.textContent = tips.map(t => `- ${t}`).join("\n");

  modal.classList.remove("hidden");
}

function closeModal() {
  modal.classList.add("hidden");
}

async function load() {
  elStatus.textContent = "Status: laden…";

  try {
    const r = await fetch(API(mode), { cache: "no-store" });
    const j = await r.json();

    const btc = j?.btc
      ? `BTC ${j.btc.state} (${fmtSign(j.btc.chg24)}% / ${fmt(j.btc.range24)}%)`
      : "BTC —";

    const counts = j?.counts || {};
    const cRadar   = counts.radar   ?? (j?.funnel?.radar?.length   || 0);
    const cBuildup = counts.buildup ?? (j?.funnel?.buildup?.length || 0);
    const cAlmost  = counts.almost  ?? (j?.funnel?.almost?.length  || 0);
    const cElite   = counts.elite   ?? (j?.funnel?.elite?.length   || 0);

    elStatus.textContent =
      `Mode: ${mode.toUpperCase()} • Elite ${cElite} | Almost ${cAlmost} | Buildup ${cBuildup} | Radar ${cRadar} • ${btc}`;

    const f = j?.funnel || {};

    // Let op: jouw API moet funnel.radar/buildup/almost/elite leveren
    renderStage(f.elite   || [], elElite,   "ELITE");
    renderStage(f.almost  || [], elAlmost,  "ALMOST");
    renderStage(f.buildup || [], elBuildup, "BUILDUP");
    renderStage(f.radar   || [], elRadar,   "RADAR");

  } catch (e) {
    elStatus.textContent = "Status: fout (check Vercel logs)";
    elElite.innerHTML = `<pre class="empty">${esc(String(e))}</pre>`;
  }
}

// Helpers
function fmt(n) { return (Number(n) || 0).toFixed(2); }
function fmtSign(n){ n = Number(n) || 0; return (n >= 0 ? "+" : "") + n.toFixed(2); }
function short(n){
  n = Number(n) || 0;
  if (n >= 1e9) return (n/1e9).toFixed(2)+"B";
  if (n >= 1e6) return (n/1e6).toFixed(2)+"M";
  if (n >= 1e3) return (n/1e3).toFixed(2)+"K";
  return n.toFixed(0);
}
function numOrDash(n){
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "-";
  return Number(n).toFixed(4);
}
function esc(s){
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

updateButtons();
load();