// ===== topbar hoogte automatisch naar CSS var zetten =====
function syncTopbarHeight(){
  const tb = document.querySelector(".topbar");
  const h = tb ? Math.ceil(tb.getBoundingClientRect().height) : 78;
  document.documentElement.style.setProperty("--topbar-h", h + "px");
}
window.addEventListener("resize", syncTopbarHeight);
window.addEventListener("load", syncTopbarHeight);
syncTopbarHeight();

// ===== URL state =====
const qs = new URLSearchParams(location.search);
let mode = (qs.get("mode") || "bull").toLowerCase();
if (mode !== "bull" && mode !== "bear") mode = "bull";
const token = (qs.get("token") || "").trim();

function withToken(url) {
  if (!token) return url;
  const u = new URL(url, location.origin);
  u.searchParams.set("token", token);
  return u.pathname + "?" + u.searchParams.toString();
}

const API_LATEST = (m) => withToken(`/api/moon-latest?mode=${encodeURIComponent(m)}`);
const API_SCAN   = (m) => withToken(`/api/moon-scan?mode=${encodeURIComponent(m)}`);

const statusLine  = document.getElementById("statusLine");
const btnBull     = document.getElementById("modeBull");
const btnBear     = document.getElementById("modeBear");
const btnRefresh  = document.getElementById("btnRefresh");
const btnScan     = document.getElementById("btnScan");

const stageElite   = document.getElementById("stageElite");
const stageAlmost  = document.getElementById("stageAlmost");
const stageBuildup = document.getElementById("stageBuildup");
const stageRadar   = document.getElementById("stageRadar");

// ===== modal refs =====
const modal  = document.getElementById("modal");
const mClose = document.getElementById("mClose");
const mTitle = document.getElementById("mTitle");
const mSub   = document.getElementById("mSub");

const tabWhy   = document.getElementById("tabWhy");
const tabLiq   = document.getElementById("tabLiq");
const tabRisk  = document.getElementById("tabRisk");
const tabDebug = document.getElementById("tabDebug");

const boxWhy   = document.getElementById("boxWhy");
const boxLiq   = document.getElementById("boxLiq");
const boxRisk  = document.getElementById("boxRisk");
const boxDebug = document.getElementById("boxDebug");

const mWhyList = document.getElementById("mWhyList");
const mLiqList = document.getElementById("mLiqList");
const mRiskKv  = document.getElementById("mRiskKv");
const mDebug   = document.getElementById("mDebug");

// ===== events =====
btnBull.onclick = () => setMode("bull");
btnBear.onclick = () => setMode("bear");
btnRefresh.onclick = () => loadLatest();
btnScan.onclick = () => runScan();

mClose.onclick = closeModal;
modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

tabWhy.onclick   = () => setTab("Why");
tabLiq.onclick   = () => setTab("Liq");
tabRisk.onclick  = () => setTab("Risk");
tabDebug.onclick = () => setTab("Debug");

// ===== UI helpers =====
function setMode(m) {
  mode = m;
  qs.set("mode", mode);
  if (token) qs.set("token", token);
  history.replaceState(null, "", `${location.pathname}?${qs.toString()}`);
  setActiveButtons();
  loadLatest();
}

function setActiveButtons() {
  btnBull.classList.toggle("active", mode === "bull");
  btnBear.classList.toggle("active", mode === "bear");
}

function setTab(name){
  const map = { Why:[tabWhy,boxWhy], Liq:[tabLiq,boxLiq], Risk:[tabRisk,boxRisk], Debug:[tabDebug,boxDebug] };
  for(const k of Object.keys(map)){
    map[k][0].classList.toggle("active", k===name);
    map[k][1].classList.toggle("hidden", k!==name);
  }
}

function fmt(n, d = 2) { return (Number(n) || 0).toFixed(d); }
function fmtSign(n, d = 2) { n = Number(n) || 0; return (n >= 0 ? "+" : "") + n.toFixed(d); }
function safe(n, d=2){
  const x = Number(n);
  if(!Number.isFinite(x)) return "—";
  return x.toFixed(d);
}
function short(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return n.toFixed(0);
}
function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}
function emptyBox(msg = "Geen coins") {
  return `<div class="empty">${escapeHtml(msg)}</div>`;
}

function confColor(conf){
  const c = Number(conf)||0;
  if (c < 50) return "#EF4444";
  if (c < 70) return "#F59E0B";
  if (c < 85) return "#3B82F6";
  return "#22C55E";
}
function confBar(conf){
  const pct = Math.max(0, Math.min(100, Number(conf)||0));
  const col = confColor(pct);
  return `
    <div class="confWrap">
      <div class="confBar"><div class="confFill" style="width:${pct}%;background:${col}"></div></div>
      <div class="confTxt">${pct}/100</div>
    </div>
  `;
}

// ===== checks =====
function icon(ok, kind="ok"){
  if(ok===true) return `<span class="iconOk">✓</span>`;
  if(kind==="warn") return `<span class="iconWarn">⚠</span>`;
  return `<span class="iconNo">✗</span>`;
}
function addCheck(container, ok, title, sub="", kind="ok"){
  const div = document.createElement("div");
  div.className = "checkItem";
  div.innerHTML = `
    ${icon(ok, kind)}
    <div class="checkText">
      <div><b>${title}</b></div>
      ${sub ? `<div class="checkSmall">${sub}</div>` : ""}
    </div>
  `;
  container.appendChild(div);
}
function setKV(container, rows){
  container.innerHTML = "";
  for(const [k,v] of rows){
    const r = document.createElement("div");
    r.className = "kvRow";
    r.innerHTML = `<div class="kvKey">${k}</div><div class="kvVal">${v}</div>`;
    container.appendChild(r);
  }
}

// ===== render list =====
function coinCard(c, stageName){
  const conf = Number(c?.confidence || 0);
  const consPct = Math.round((Number(c?.consistency?.ratio || 0)) * 100);

  return `
  <div class="coinRow" data-stage="${escapeHtml(stageName)}">
    <div class="coinTop">
      <div>
        <div class="sym">${escapeHtml(c.symbol || "—")}</div>
        <div class="tag">${escapeHtml(c.name || "")}</div>
      </div>

      ${confBar(conf)}

      <div class="pill">${escapeHtml(stageName)}</div>
      <div class="pill">Cons ${consPct}%</div>
    </div>

    <div class="coinMeta">
      <span>Price $${fmt(c.price, 6)}</span>
      <span>Chg24 ${fmtSign(c.change24)}%</span>
      <span>Range24 ${fmt(c.range24)}%</span>
      <span>MC ${short(c.marketCap)}</span>
      <span>Vol ${short(c.volume)}</span>
      <span>VM ${fmt(c.vm, 2)}</span>
    </div>
  </div>`;
}

function renderStage(list, elStage, stageName){
  if (!Array.isArray(list) || list.length === 0){
    elStage.innerHTML = emptyBox();
    return;
  }
  elStage.innerHTML = list.map((c) => coinCard(c, stageName)).join("");
  elStage.querySelectorAll(".coinRow").forEach((rowEl, idx) => {
    rowEl.onclick = () => openModalMoon(list[idx], stageName);
  });
}

// ===== modal =====
function openModalMoon(c, stageName){
  setTab("Why");
  syncTopbarHeight();

  mTitle.textContent = `${c.symbol || "—"} • ${stageName} • ${mode.toUpperCase()}`;
  mSub.textContent =
    `Price $${safe(c.price, 6)} • Chg24 ${fmtSign(c.change24)}% • Range24 ${fmt(c.range24)}% • VM ${fmt(c.vm,2)} • Conf ${Number(c?.confidence||0)}/100`;

  // WHY: Moon heeft c.why met per stage regels
  mWhyList.innerHTML = "";

  addCheck(mWhyList, true, `Stage: ${stageName}`, `Mode: ${mode.toUpperCase()}`);

  const consRatio = Number(c?.consistency?.ratio || 0);
  addCheck(
    mWhyList,
    consRatio >= 0.70,
    "Consistency",
    `Ratio: ${(consRatio*100).toFixed(0)}%`,
    consRatio >= 0.70 ? "ok" : "warn"
  );

  addCheck(
    mWhyList,
    Number(c?.confidence||0) >= 50,
    "Confidence",
    `Score: ${Number(c?.confidence||0)}/100`,
    Number(c?.confidence||0) >= 65 ? "ok" : "warn"
  );

  const w = c?.why || {};
  // Menselijk: “wat faalt”
  addCheck(mWhyList, true, "Radar", w.radar || "—");
  addCheck(mWhyList, (String(w.buildup||"").toLowerCase().includes("ok")), "Buildup", w.buildup || "—", "warn");
  addCheck(mWhyList, (String(w.almost||"").toLowerCase().includes("ok")), "Almost", w.almost || "—", "warn");
  addCheck(mWhyList, (String(w.elite||"").toLowerCase().includes("ok")), "Elite", w.elite || "—", "warn");
  if (w.eliteExtra) addCheck(mWhyList, (String(w.eliteExtra||"").toLowerCase().includes("ok")), "Elite extra", w.eliteExtra, "warn");

  // LIQ
  mLiqList.innerHTML = "";
  const ob = c?.ob || null;
  const depthOk = !!c?.depthOk;

  addCheck(
    mLiqList,
    !!(ob && ob.status && ob.status !== "none"),
    "Orderbook",
    ob ? `status: ${ob.status} • score: ${safe(ob.score,3)} • spread: ${safe(ob.spreadPct,2)}%` : "geen data",
    "warn"
  );

  addCheck(
    mLiqList,
    depthOk,
    "Depth floor",
    `depthOk: ${depthOk} • floorUsd: ${Math.round(Number(c?.floorUsd||0)).toLocaleString()}`,
    depthOk ? "ok" : "warn"
  );

  // RISK (Moon heeft risk object)
  const risk = c?.risk || null;
  setKV(mRiskKv, [
    ["SL%", risk ? `${safe(risk.slPct,2)}%` : "—"],
    ["SL", risk ? `${safe(risk.sl, 8)}` : "—"],
    ["TP3", risk ? `${safe(risk.tp3, 8)}` : "—"],
    ["Note", risk ? (risk.note || "—") : "—"],
  ]);

  // DEBUG
  mDebug.textContent = JSON.stringify(c, null, 2);

  modal.classList.remove("hidden");
}

function closeModal(){
  modal.classList.add("hidden");
}

// ===== main =====
async function loadLatest(){
  setActiveButtons();
  statusLine.textContent = "Status: laden…";

  try{
    const r = await fetch(API_LATEST(mode), { cache: "no-store" });
    const j = await r.json();

    const counts = j?.counts || {};
    const btc = j?.btc
      ? ` • BTC ${j.btc.state} (${fmtSign(j.btc.chg24)}% / ${fmt(j.btc.range24)}%)`
      : "";

    const note = j?.note ? ` • ${j.note}` : "";
    const p = j?.portfolio ? ` • Portfolio: Open ${j.portfolio.openCount||0} | Closed ${j.portfolio.closedCount||0}` : "";

    statusLine.textContent =
      `Mode: ${mode.toUpperCase()} • Elite ${counts.elite || 0} | Almost ${counts.almost || 0} | ` +
      `Buildup ${counts.buildup || 0} | Radar ${counts.radar || 0}${btc}${p}${note}`;

    const funnel = j?.funnel || {};
    renderStage(funnel.elite || [], stageElite, "ELITE");
    renderStage(funnel.almost || [], stageAlmost, "ALMOST");
    renderStage(funnel.buildup || [], stageBuildup, "BUILDUP");
    renderStage(funnel.radar || [], stageRadar, "RADAR");

  }catch(e){
    statusLine.textContent = "Status: error (check Vercel logs)";
    stageElite.innerHTML = `<pre class="modalPre">${escapeHtml(String(e))}</pre>`;
    stageAlmost.innerHTML = "";
    stageBuildup.innerHTML = "";
    stageRadar.innerHTML = "";
  }
}

async function runScan(){
  if(!token){
    alert("Geen token in de URL. Gebruik ?token=JOUW_TOKEN");
    return;
  }
  statusLine.textContent = `Status: scan starten (${mode.toUpperCase()})…`;
  try{
    const r = await fetch(API_SCAN(mode), { cache:"no-store" });
    const j = await r.json();
    if(!j?.ok) throw new Error(j?.error || "Scan failed");
    await loadLatest();
  }catch(e){
    statusLine.textContent = "Status: scan error (check Vercel logs)";
    stageElite.innerHTML = `<pre class="modalPre">${escapeHtml(String(e))}</pre>`;
  }
}

// start
loadLatest();