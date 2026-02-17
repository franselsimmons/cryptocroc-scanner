const el = (id) => document.getElementById(id);

const API = {
  latest: (mode) => `/api/latest?mode=${encodeURIComponent(mode)}`,
  ob: (mode, symbol) => `/api/orderbook?side=${encodeURIComponent(mode)}&symbol=${encodeURIComponent(symbol)}`
};

let MODE = new URLSearchParams(location.search).get("mode")
  || localStorage.getItem("MODE")
  || "bull";

function setMode(mode){
  MODE = mode;
  localStorage.setItem("MODE", mode);

  const bullBtn = el("modeBull");
  const bearBtn = el("modeBear");
  if (bullBtn) bullBtn.classList.toggle("active", mode==="bull");
  if (bearBtn) bearBtn.classList.toggle("active", mode==="bear");

  loadLatest();
}

function fmtUSD(n){
  n = Number(n)||0;
  if (n >= 1e9) return (n/1e9).toFixed(2)+"B";
  if (n >= 1e6) return (n/1e6).toFixed(2)+"M";
  if (n >= 1e3) return (n/1e3).toFixed(2)+"K";
  return n.toFixed(0);
}
function fmtPct(n){
  n = Number(n)||0;
  const s = n >= 0 ? "+" : "";
  return s + n.toFixed(2) + "%";
}
function fmt(n, d=2){ return (Number(n)||0).toFixed(d); }

function escapeHtml(s){
  return String(s||"")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function confClass(conf){
  if (conf < 50) return "bad";
  if (conf < 70) return "mid";
  if (conf < 85) return "good";
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

function sizingText(c){
  const s = c?.sizing || null;
  if (!s) return "Advies —";
  return `Advies ${s.pct}% (BTC ${s.zone})`;
}

function coinRow(c){
  const div = document.createElement("div");
  div.className = "coinRow";

  const adv = sizingText(c);
  const conf = Number(c?.confidence||0);

  div.innerHTML = `
    <div class="coinTop">
      <div class="left">
        <div class="sym">${escapeHtml(c.symbol||"—")}</div>
        <div class="tag">${escapeHtml(c.stage||"")}</div>
      </div>
      <div class="right">
        ${confBar(conf)}
        <span class="pill">Conf ${conf}/100</span>
        <span class="pill pillAdv">${escapeHtml(adv)}</span>
      </div>
    </div>

    <div class="coinMeta">
      <span>chg24: ${fmtPct(c.change24)}</span>
      <span>range24: ${fmtPct(c.range24)}</span>
      <span>vol: $${fmtUSD(c.volume)}</span>
      <span>mc: $${fmtUSD(c.marketCap)}</span>
      <span>vm: ${fmt(c.vm,2)}</span>
      <span>scans: ${Number(c.stageScans||0)}</span>
    </div>
  `;
  div.addEventListener("click", () => openModal(c));
  return div;
}

function renderStage(targetId, arr){
  const box = el(targetId);
  if (!box) return;

  box.innerHTML = "";
  if(!arr || arr.length===0){
    box.innerHTML = `<div class="empty">Geen coins.</div>`;
    return;
  }
  for(const c of arr){
    box.appendChild(coinRow(c));
  }
}

function btcLine(btc){
  if(!btc) return "BTC: —";
  return `BTC: ${btc.state} | chg24 ${fmtPct(btc.chg24)} | range24 ${fmtPct(btc.range24)}`;
}

function renderAll(data){
  const ts = data?.ts ? new Date(data.ts) : null;
  const stamp = ts ? ts.toLocaleString() : "—";

  const statusLine = el("statusLine");
  if (statusLine) {
    statusLine.textContent =
      `${btcLine(data.btc)} • Laatste update: ${stamp} • ENTRY ${data.counts.entry} • ALMOST ${data.counts.almost} • BUILDUP ${data.counts.buildup} • RADAR ${data.counts.radar}`;
  }

  renderStage("stageEntry", data?.funnel?.entry || []);
  renderStage("stageAlmost", data?.funnel?.almost || []);
  renderStage("stageBuildup", data?.funnel?.buildup || []);
  renderStage("stageRadar", data?.funnel?.radar || []);
}

async function loadLatest(){
  try{
    const statusLine = el("statusLine");
    if (statusLine) statusLine.textContent = "Status: laden…";

    const r = await fetch(API.latest(MODE), { cache: "no-store" });
    const j = await r.json();
    renderAll(j || {});
  }catch(e){
    const statusLine = el("statusLine");
    if (statusLine) statusLine.textContent = "Status: fout bij laden (check Vercel logs)";
  }
}

/* ===== modal helpers ===== */
function showModal(on){
  const modal = el("modal");
  if (!modal) return;
  modal.classList.toggle("hidden", !on);
}

function li(icon, text){
  return `<li>${icon} ${escapeHtml(text)}</li>`;
}
function chip(kind, text){
  const cls = kind==="ok" ? "ok" : kind==="bad" ? "bad" : "wait";
  return `<span class="chip ${cls}">${escapeHtml(text)}</span>`;
}
function dot(kind){
  const cls = kind==="ok" ? "ok" : kind==="bad" ? "bad" : "wait";
  return `<span class="dot ${cls}"></span>`;
}

const mClose = el("mClose");
if (mClose) mClose.addEventListener("click", ()=>showModal(false));

const modalEl = el("modal");
if (modalEl) {
  modalEl.addEventListener("click",(e)=>{ if(e.target.id==="modal") showModal(false); });
}

async function openModal(c){
  showModal(true);

  const mTitle = el("mTitle");
  const mSub   = el("mSub");
  const mWhy   = el("mWhy");
  const mOB    = el("mOB");
  const mRisk  = el("mRisk");
  const mDebug = el("mDebug");

  const symbol = c?.symbol || "—";
  const stage  = c?.stage  || "—";
  const conf   = Number(c?.confidence||0);
  const consR  = Number(c?.consistency?.ratio||0);
  const consS  = Number(c?.consistency?.same||0);
  const consT  = Number(c?.consistency?.total||0);
  const adv    = sizingText(c);

  if (mTitle) mTitle.textContent = `${symbol} • ${MODE.toUpperCase()} • ${stage}`;

  if (mSub) {
    mSub.textContent =
      `Prijs $${fmt(c.price)} • Chg24 ${fmtPct(c.change24)} • Range24 ${fmtPct(c.range24)} • ` +
      `Conf ${conf}/100 • Cons ${(consR*100).toFixed(0)}% (${consS}/${consT}) • ${adv}`;
  }

  // ===== Waarom (menselijk) =====
  const desired = c?.why?.desired || "—";
  const entryGate = c?.why?.entryGate || c?.why?.obGate || "—";
  const volAcc = Number(c?.volAcc||0);

  const whyHtml = `
    <div class="kv">
      <div><b>Stage:</b> ${escapeHtml(stage)}</div>
      <div><b>Desired:</b> ${escapeHtml(desired)}</div>
      <div><b>VolAcc:</b> ${escapeHtml(fmt(volAcc,2))}</div>
    </div>
    <div style="height:10px"></div>
    <ul class="list">
      ${li(entryGate.toLowerCase().includes("passed") ? "✅" : entryGate.toLowerCase().includes("validat") ? "⏳" : "❌", `EntryGate: ${entryGate}`)}
      ${li(conf >= 70 ? "✅" : "❌", `Confidence: ${conf}/100 (min 70)`)}
      ${li(consR >= 0.75 ? "✅" : "❌", `Consistency: ${(consR*100).toFixed(0)}% (min 75%)`)}
    </ul>
  `;
  if (mWhy) mWhy.innerHTML = whyHtml;

  // ===== Risk & Actie =====
  const sl = Number(c?.sl||0);
  const tp = Number(c?.tp||0);
  const atrPct = Number(c?.atrPct||0);

  const action =
    stage === "ENTRY" ? chip("ok","Entry-ready") :
    stage === "ALMOST" ? chip("wait","Bijna") :
    stage === "BUILDUP" ? chip("wait","Opbouw") :
    chip("wait","Wachten");

  if (mRisk) {
    mRisk.innerHTML = `
      <div class="kv">
        <div><b>${escapeHtml(action)}</b></div>
        <div>ATR ~ ${(atrPct*100).toFixed(2)}%</div>
        <div><b>SL:</b> $${fmt(sl, 6)} • <b>TP:</b> $${fmt(tp, 6)}</div>
      </div>
    `;
  }

  // ===== Liquidity =====
  if (mOB) mOB.innerHTML = `<div class="kv"><div>${dot("wait")} OB: laden…</div></div>`;

  try{
    const r = await fetch(API.ob(MODE, symbol), { cache:"no-store" });
    const j = await r.json();

    let obKind = "wait";
    let obTxt = "OB validating";
    let stats = "—";

    if (j?.status === "validating") {
      obKind = "wait";
      obTxt = j?.tip || "Nog geen geldige OB.";
    } else if (j?.valid === true) {
      obKind = "ok";
      obTxt = "OB ok";
    } else if (j?.valid === false) {
      obKind = "bad";
      obTxt = j?.reason || "OB niet ok";
    }

    const spread = j?.ob?.spreadPct ?? j?.spreadPct ?? null;
    const lor    = j?.ob?.lor ?? j?.lor ?? null;
    const d1p    = j?.ob?.depthMinUsd1p ?? null;

    stats =
      `Spread ${spread==null?"—":fmt(spread,2)+"%"} • ` +
      `LOR ${lor==null?"—":fmt(lor,2)} • ` +
      `Depth1% $${d1p==null?"—":fmtUSD(d1p)}`;

    if (mOB) {
      mOB.innerHTML = `
        <div class="kv">
          <div>${dot(obKind)} <b>${escapeHtml(obTxt)}</b></div>
          <div>${escapeHtml(stats)}</div>
        </div>
      `;
    }

  }catch{
    if (mOB) mOB.innerHTML = `<div class="kv"><div>${dot("bad")} <b>OB fetch error</b></div></div>`;
  }

  // Debug alleen hier
  if (mDebug) {
    try { mDebug.textContent = JSON.stringify(c, null, 2); }
    catch { mDebug.textContent = String(c); }
  }
}

const bullBtn = el("modeBull");
if (bullBtn) bullBtn.addEventListener("click", () => setMode("bull"));

const bearBtn = el("modeBear");
if (bearBtn) bearBtn.addEventListener("click", () => setMode("bear"));

setMode(MODE);
setInterval(loadLatest, 20000);