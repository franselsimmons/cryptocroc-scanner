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

const modal  = document.getElementById("modal");
const mClose = document.getElementById("mClose");
const mTitle = document.getElementById("mTitle");
const mSub   = document.getElementById("mSub");
const mWhy   = document.getElementById("mWhy");
const mOB    = document.getElementById("mOB");
const mRisk  = document.getElementById("mRisk");
const mDebug = document.getElementById("mDebug");

// ===== events =====
btnBull.onclick = () => setMode("bull");
btnBear.onclick = () => setMode("bear");
btnRefresh.onclick = () => loadLatest();
btnScan.onclick = () => runScan();

mClose.onclick = closeModal;
modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

// ===== helpers =====
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

function fmt(n, d=2){ return (Number(n)||0).toFixed(d); }
function fmtSign(n, d=2){ n=Number(n)||0; return (n>=0?"+":"")+n.toFixed(d); }

function short(n){
  n = Number(n)||0;
  if (n >= 1e9) return (n/1e9).toFixed(2)+"B";
  if (n >= 1e6) return (n/1e6).toFixed(2)+"M";
  if (n >= 1e3) return (n/1e3).toFixed(2)+"K";
  return n.toFixed(0);
}

function escapeHtml(s){
  return String(s||"")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function confClass(conf){
  const c = Number(conf||0);
  if (c < 50) return "bad";
  if (c < 70) return "mid";
  if (c < 85) return "good";
  return "best";
}
function confBar(conf){
  const c = Math.max(0, Math.min(100, Number(conf||0)));
  const cls = confClass(c);
  return `
    <div class="confBar" title="Confidence">
      <div class="confFill ${cls}" style="width:${c}%"></div>
    </div>`;
}

function emptyBox(msg="Geen coins"){
  return `<div class="empty">${escapeHtml(msg)}</div>`;
}

function dot(kind){
  const cls = kind==="ok" ? "ok" : kind==="bad" ? "bad" : "wait";
  return `<span class="dot ${cls}"></span>`;
}

function renderCoinRow(c, stageName){
  const conf = Number(c?.confidence||0);
  const consPct = Math.round((Number(c?.consistency?.ratio||0))*100);

  return `
  <div class="coinRow">
    <div class="coinTop">
      <div class="left">
        <div class="sym">${escapeHtml(c.symbol||"—")}</div>
        <div class="tag">${escapeHtml(stageName)}</div>
      </div>
      <div class="right">
        ${confBar(conf)}
        <span class="pill">Conf ${conf}/100</span>
        <span class="pill">Cons ${consPct}%</span>
      </div>
    </div>

    <div class="coinMeta">
      <span>chg24: ${fmtSign(c.change24)}%</span>
      <span>range24: ${fmt(c.range24)}%</span>
      <span>vol: ${short(c.volume)}</span>
      <span>mc: ${short(c.marketCap)}</span>
      <span>vm: ${fmt(c.vm,2)}</span>
      <span>volAcc: ${fmt(c.volAcc,2)}</span>
    </div>
  </div>`;
}

function renderStage(list, el, stageName){
  if (!Array.isArray(list) || list.length===0){
    el.innerHTML = emptyBox();
    return;
  }
  el.innerHTML = list.map((c)=>renderCoinRow(c, stageName)).join("");
  el.querySelectorAll(".coinRow").forEach((rowEl, idx)=>{
    rowEl.onclick = ()=>openModal(list[idx], stageName);
  });
}

/* ===== modal ===== */
function li(icon, text){
  return `<li>${icon} ${escapeHtml(text)}</li>`;
}
function closeModal(){ modal.classList.add("hidden"); }
function openModal(c, stageName){
  const symbol = c?.symbol || "—";
  const conf   = Number(c?.confidence||0);
  const consR  = Number(c?.consistency?.ratio||0);

  mTitle.textContent = `${symbol} • ${stageName} • ${mode.toUpperCase()}`;

  mSub.textContent =
    `Prijs $${fmt(c.price)} • Chg24 ${fmtSign(c.change24)}% • Range24 ${fmt(c.range24)}% • ` +
    `VM ${fmt(c.vm,2)} • Conf ${conf}/100 • Cons ${(consR*100).toFixed(0)}%`;

  // WHY checklist (menselijk)
  const why = c?.why || {};
  const whyHtml = `
    <ul class="list">
      ${li(String(why.radar||"").includes("ok") ? "✅" : "❌", `Radar: ${why.radar || "—"}`)}
      ${li(String(why.buildup||"").includes("ok") ? "✅" : "❌", `Buildup: ${why.buildup || "—"}`)}
      ${li(String(why.almost||"").includes("ok") ? "✅" : "❌", `Almost: ${why.almost || "—"}`)}
      ${li(String(why.elite||"").includes("ok") ? "✅" : String(why.elite||"").toLowerCase().includes("validat") ? "⏳" : "❌", `Elite: ${why.elite || "—"}`)}
      ${why.eliteExtra ? li("ℹ️", `Extra: ${why.eliteExtra}`) : ""}
    </ul>
    <div class="kv">
      <div><b>VolAcc:</b> ${escapeHtml(fmt(c.volAcc,2))}</div>
      <div><b>Consistency:</b> ${escapeHtml(Math.round(consR*100)+"%")}</div>
    </div>
  `;
  mWhy.innerHTML = whyHtml;

  // Liquidity: 1 status + stats
  const ob = c?.ob || null;
  const depthOk = !!c?.depthOk;

  let kind = "wait";
  let text = "Nog geen OB";
  if (ob?.status === "validating") { kind = "wait"; text = "OB validating"; }
  if (ob?.status === "valid") { kind = "ok"; text = "OB ok"; }
  if (ob?.status === "none") { kind = "wait"; text = "Geen OB"; }

  // Depth komt uit Moon core (floorUsd + bidUsd/askUsd)
  const depthMin = Math.min(Number(ob?.bidUsd||0), Number(ob?.askUsd||0));
  const floorUsd = Number(c?.floorUsd||0);

  const stats =
    `Score ${ob?.score==null?"—":fmt(ob.score,3)} • ` +
    `Spread ${ob?.spreadPct==null?"—":fmt(ob.spreadPct,2)+"%"} • ` +
    `LOR ${ob?.lor==null?"—":fmt(ob.lor,2)} • ` +
    `Depth(min) $${short(depthMin)} / floor $${short(floorUsd)}`;

  mOB.innerHTML = `
    <div class="kv">
      <div>${dot(kind)} <b>${escapeHtml(text)}</b> • ${dot(depthOk?"ok":"bad")} <b>${depthOk?"Depth ok":"Depth low"}</b></div>
      <div>${escapeHtml(stats)}</div>
    </div>
  `;

  // Risk & actie
  const risk = c?.risk || null;
  const sl = risk ? `SL ${fmt(risk.slPct,2)}%` : "SL —";
  const tp = risk ? `TP3 ${fmt(risk.tp3,8)}` : "TP —";
  mRisk.innerHTML = `
    <div class="kv">
      <div><b>${escapeHtml(sl)}</b> • <b>${escapeHtml(tp)}</b></div>
      <div>${escapeHtml(risk?.note || "")}</div>
    </div>
  `;

  // Debug (optioneel)
  try { mDebug.textContent = JSON.stringify(c, null, 2); }
  catch { mDebug.textContent = String(c); }

  modal.classList.remove("hidden");
}

/* ===== main ===== */
async function loadLatest(){
  setActiveButtons();
  statusLine.textContent = "Status: laden…";

  try{
    const r = await fetch(API_LATEST(mode), { cache:"no-store" });
    const j = await r.json();

    const counts = j?.counts || {};
    const btc = j?.btc
      ? ` • BTC ${j.btc.state} (${fmtSign(j.btc.chg24)}% / ${fmt(j.btc.range24)}%)`
      : "";
    const note = j?.note ? ` • ${j.note}` : "";

    statusLine.textContent =
      `Mode: ${mode.toUpperCase()} • Elite ${counts.elite||0} | Almost ${counts.almost||0} | ` +
      `Buildup ${counts.buildup||0} | Radar ${counts.radar||0}${btc}${note}`;

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
  if (!token){
    alert("Geen token in de URL. Gebruik ?token=JOUW_TOKEN");
    return;
  }

  statusLine.textContent = `Status: scan starten (${mode.toUpperCase()})…`;

  try{
    const r = await fetch(API_SCAN(mode), { cache:"no-store" });
    const j = await r.json();
    if (!j?.ok) throw new Error(j?.error || "Scan failed");
    await loadLatest();
  }catch(e){
    statusLine.textContent = "Status: scan error (check Vercel logs)";
    stageElite.innerHTML = `<pre class="modalPre">${escapeHtml(String(e))}</pre>`;
  }
}

loadLatest();