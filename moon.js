// /moon.js  (public)

const qs = new URLSearchParams(location.search);

// mode uit URL
let mode = (qs.get("mode") || "bull").toLowerCase();
if (mode !== "bull" && mode !== "bear") mode = "bull";

// token uit URL (belangrijk als CRON_SECRET aan staat)
const token = (qs.get("token") || "").trim();

// API helpers (token altijd mee als hij bestaat)
function withToken(url) {
  if (!token) return url;
  const u = new URL(url, location.origin);
  u.searchParams.set("token", token);
  return u.pathname + "?" + u.searchParams.toString();
}

const API_LATEST = (m) => withToken(`/api/moon-latest?mode=${encodeURIComponent(m)}`);
const API_SCAN   = (m) => withToken(`/api/moon-scan?mode=${encodeURIComponent(m)}`);

// UI refs
const statusLine  = document.getElementById("statusLine");
const btnBull     = document.getElementById("modeBull");
const btnBear     = document.getElementById("modeBear");
const btnRefresh  = document.getElementById("btnRefresh");
const btnScan     = document.getElementById("btnScan");

const stageElite  = document.getElementById("stageElite");
const stageAlmost = document.getElementById("stageAlmost");
const stageBuildup= document.getElementById("stageBuildup");
const stageRadar  = document.getElementById("stageRadar");

// modal refs
const modal   = document.getElementById("modal");
const mClose  = document.getElementById("mClose");
const mTitle  = document.getElementById("mTitle");
const mSub    = document.getElementById("mSub");
const mWhy    = document.getElementById("mWhy");
const mOB     = document.getElementById("mOB");
const mRisk   = document.getElementById("mRisk");
const mNext   = document.getElementById("mNext");

// events
btnBull.onclick = () => setMode("bull");
btnBear.onclick = () => setMode("bear");
btnRefresh.onclick = () => loadLatest();
btnScan.onclick = () => runScan();

mClose.onclick = closeModal;
modal.addEventListener("click", (e) => {
  if (e.target === modal) closeModal();
});

function setMode(m) {
  mode = m;
  qs.set("mode", mode);
  // token behouden in URL
  if (token) qs.set("token", token);
  history.replaceState(null, "", `${location.pathname}?${qs.toString()}`);
  setActiveButtons();
  loadLatest();
}

function setActiveButtons() {
  btnBull.classList.toggle("active", mode === "bull");
  btnBear.classList.toggle("active", mode === "bear");
}

function fmt(n) { return (Number(n) || 0).toFixed(2); }
function fmtSign(n){ n = Number(n)||0; return (n>=0?"+":"")+n.toFixed(2); }
function short(n){
  n = Number(n)||0;
  if (n >= 1e9) return (n/1e9).toFixed(2)+"B";
  if (n >= 1e6) return (n/1e6).toFixed(2)+"M";
  if (n >= 1e3) return (n/1e3).toFixed(2)+"K";
  return n.toFixed(0);
}

function emptyBox(msg = "Geen coins") {
  return `<div class="empty">${msg}</div>`;
}

function coinRow(c, stageName) {
  const conf = Number(c?.confidence || 0);
  const consPct = Math.round((Number(c?.consistency?.ratio || 0)) * 100);

  return `
  <div class="coinRow" data-sym="${escapeHtml(c.symbol||"")}" data-stage="${escapeHtml(stageName)}">
    <div class="coinTop">
      <div class="sym">${escapeHtml(c.symbol || "—")}</div>
      <div class="tag">${escapeHtml(c.name || "")}</div>
    </div>
    <div class="coinMeta">
      <span class="pill">Price $${fmt(c.price)}</span>
      <span class="pill">Chg24 ${fmtSign(c.change24)}%</span>
      <span class="pill">Range24 ${fmt(c.range24)}%</span>
      <span class="pill">MC ${short(c.marketCap)}</span>
      <span class="pill">Vol ${short(c.volume)}</span>
      <span class="pill">VM ${fmt(c.vm)}</span>
      <span class="pill">Conf ${conf}</span>
      <span class="pill">Cons ${consPct}%</span>
    </div>
  </div>`;
}

function renderStage(list, el, stageName) {
  if (!Array.isArray(list) || list.length === 0) {
    el.innerHTML = emptyBox();
    return;
  }
  el.innerHTML = list.map((c) => coinRow(c, stageName)).join("");

  // click handlers (modal)
  el.querySelectorAll(".coinRow").forEach((rowEl, idx) => {
    rowEl.onclick = () => openModal(list[idx], stageName);
  });
}

function openModal(c, stageName) {
  const depthMin = Math.min(Number(c?.ob?.bidUsd || 0), Number(c?.ob?.askUsd || 0));
  const floor = Number(c?.floorUsd || 0);

  mTitle.textContent = `${c.symbol || "—"} • ${stageName}`;
  mSub.textContent =
    `Price $${fmt(c.price)} • Chg24 ${fmtSign(c.change24)}% • Range24 ${fmt(c.range24)}% • VM ${fmt(c.vm)}`;

  // waarom (je API zet vaak iets zoals c.why.elite / c.why.almost etc)
  mWhy.textContent = pretty({
    stage: stageName,
    why: c?.why || null,
    depthOk: c?.depthOk ?? null,
    note: c?.note ?? null
  });

  // OB / depth
  mOB.textContent = pretty({
    ob: c?.ob || null,
    depthMinUsd: depthMin,
    floorUsd: floor
  });

  // confidence/consistency
  mRisk.textContent = pretty({
    confidence: c?.confidence ?? null,
    consistency: c?.consistency || null,
    volAcc: c?.volAcc ?? null,
    priceFlat: c?.priceFlat ?? null
  });

  // debug
  mNext.textContent = pretty(c);

  modal.classList.remove("hidden");
}

function closeModal() {
  modal.classList.add("hidden");
}

function pretty(obj) {
  try { return JSON.stringify(obj, null, 2); }
  catch { return String(obj); }
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

async function loadLatest() {
  setActiveButtons();
  statusLine.textContent = "Status: laden…";

  try {
    const r = await fetch(API_LATEST(mode), { cache: "no-store" });
    const j = await r.json();

    const counts = j?.counts || {};
    const btc = j?.btc
      ? ` • BTC ${j.btc.state} (${fmtSign(j.btc.chg24)}% / ${fmt(j.btc.range24)}%)`
      : "";

    const note = j?.note ? ` • ${j.note}` : "";

    // let op: API kan counts.radar hebben
    statusLine.textContent =
      `Mode: ${mode.toUpperCase()} • Elite ${counts.elite||0} | Almost ${counts.almost||0} | ` +
      `Buildup ${counts.buildup||0} | Radar ${counts.radar||0}${btc}${note}`;

    // let op: API kan funnel.radar hebben
    const funnel = j?.funnel || {};
    renderStage(funnel.elite  || [], stageElite,  "ELITE");
    renderStage(funnel.almost || [], stageAlmost, "ALMOST");
    renderStage(funnel.buildup|| [], stageBuildup,"BUILDUP");
    renderStage(funnel.radar  || [], stageRadar,  "RADAR");

  } catch (e) {
    statusLine.textContent = "Status: error (check Vercel logs)";
    stageElite.innerHTML = `<pre class="modalPre">${escapeHtml(String(e))}</pre>`;
    stageAlmost.innerHTML = "";
    stageBuildup.innerHTML = "";
    stageRadar.innerHTML = "";
  }
}

async function runScan() {
  // Scan is een “server job”: als token ontbreekt en CRON_SECRET staat aan → 401/empty.
  if (!token) {
    alert("Geen token in de URL. Gebruik ?token=JOUW_TOKEN");
    return;
  }

  statusLine.textContent = `Status: scan starten (${mode.toUpperCase()})…`;

  try {
    const r = await fetch(API_SCAN(mode), { cache: "no-store" });
    const j = await r.json();
    if (!j?.ok) throw new Error(j?.error || "Scan failed");
    // na scan meteen latest laden
    await loadLatest();
  } catch (e) {
    statusLine.textContent = "Status: scan error (check Vercel logs)";
    stageElite.innerHTML = `<pre class="modalPre">${escapeHtml(String(e))}</pre>`;
  }
}

// start
loadLatest();