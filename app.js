const el = (id) => document.getElementById(id);

const API = {
  latest: (mode) => `/api/latest?mode=${encodeURIComponent(mode)}`,
  ob: (mode, symbol) => `/api/orderbook?side=${encodeURIComponent(mode)}&symbol=${encodeURIComponent(symbol)}`
};

let MODE = new URLSearchParams(location.search).get("mode") || localStorage.getItem("MODE") || "bull";

function setMode(mode){
  MODE = mode;
  localStorage.setItem("MODE", mode);
  el("modeBull").classList.toggle("active", mode==="bull");
  el("modeBear").classList.toggle("active", mode==="bear");
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
function fmt(n){ return (Number(n)||0).toFixed(2); }

function coinRow(c){
  const div = document.createElement("div");
  div.className = "coinRow";
  div.innerHTML = `
    <div class="coinTop">
      <div class="sym">${c.symbol}</div>
      <div class="pill">Conf ${c.confidence}/100</div>
    </div>
    <div class="coinMeta">
      <span>chg24: ${fmtPct(c.change24)}</span>
      <span>range24: ${fmtPct(c.range24)}</span>
      <span>vol: $${fmtUSD(c.volume)}</span>
      <span>mc: $${fmtUSD(c.marketCap)}</span>
      <span>vm: ${fmt(c.vm)}</span>
      <span>scans: ${c.stageScans}</span>
    </div>
  `;
  div.addEventListener("click", () => openModal(c));
  return div;
}

function renderStage(targetId, arr){
  const box = el(targetId);
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

  el("statusLine").textContent =
    `${btcLine(data.btc)} • Laatste update: ${stamp} • ENTRY ${data.counts.entry} • ALMOST ${data.counts.almost} • BUILDUP ${data.counts.buildup} • RADAR ${data.counts.radar}`;

  renderStage("stageEntry", data?.funnel?.entry || []);
  renderStage("stageAlmost", data?.funnel?.almost || []);
  renderStage("stageBuildup", data?.funnel?.buildup || []);
  renderStage("stageRadar", data?.funnel?.radar || []);
}

async function loadLatest(){
  try{
    el("statusLine").textContent = "Status: laden…";
    const r = await fetch(API.latest(MODE), { cache: "no-store" });
    const j = await r.json();
    renderAll(j || {});
  }catch(e){
    el("statusLine").textContent = "Status: fout bij laden (check Vercel logs)";
  }
}

// ===== modal =====
function showModal(on){
  el("modal").classList.toggle("hidden", !on);
}
el("mClose").addEventListener("click", ()=>showModal(false));
el("modal").addEventListener("click",(e)=>{ if(e.target.id==="modal") showModal(false); });

async function openModal(c){
  showModal(true);

  el("mTitle").textContent = `${c.symbol} • ${MODE.toUpperCase()} • ${c.stage}`;
  el("mSub").textContent =
    `prijs $${fmt(c.price)} • confidence ${c.confidence}/100 • scans ${c.stageScans} • consistency ${(c.consistency?.ratio*100||0).toFixed(0)}% (${c.consistency?.same||0}/${c.consistency?.total||0})`;

  el("mWhy").textContent =
    `Stage: ${c.stage}\n`+
    `Desired: ${c.why?.desired}\n`+
    `OB gate: ${c.why?.obGate}\n`+
    `VolAcc: ${fmt(c.volAcc)}\n`;

  el("mNext").textContent =
    (c.why?.missing && c.why.missing.length)
      ? c.why.missing.map(x=>`- ${x}`).join("\n")
      : "Niks — hij voldoet al aan de volgende eisen.";

  el("mRisk").textContent =
    `ATR% (proxy): ${(c.atrPct*100).toFixed(2)}%\n`+
    `SL: $${fmt(c.sl)}\n`+
    `TP: $${fmt(c.tp)}\n`;

  // OB live ophalen (details)
  el("mOB").textContent = "Laden…";
  try{
    const r = await fetch(API.ob(MODE, c.symbol), { cache:"no-store" });
    const j = await r.json();

    if(j.status === "validating"){
      el("mOB").textContent =
        `Status: validating\n`+
        `Tip: ${j.tip}\n`;
      return;
    }

    el("mOB").textContent =
      `valid: ${j.valid}\n`+
      `reason: ${j.reason}\n`+
      `avgScore: ${j.avgScore ?? "-"}\n`+
      `score: ${j.ob?.score ?? "-"}\n`+
      `spreadPct: ${j.ob?.spreadPct?.toFixed?.(2) ?? j.ob?.spreadPct ?? "-"}%\n`+
      `lor: ${j.ob?.lor?.toFixed?.(2) ?? j.ob?.lor ?? "-"}\n`+
      `bidUsd: ${Math.round(j.ob?.bidUsd ?? 0)}\n`+
      `askUsd: ${Math.round(j.ob?.askUsd ?? 0)}\n`+
      `stale: ${j.stale}\n`;
  }catch{
    el("mOB").textContent = "OB ERROR: fetch mislukt";
  }
}

// reset knop → opent link (jij plakt token)
el("resetBtn").addEventListener("click", ()=>{
  alert(
    "Reset is beschermd.\n\nGebruik:\n/api/reset?mode=all&token=JOUW_CRON_SECRET\n\nTip: maak er een bookmark van."
  );
});

// buttons
el("modeBull").addEventListener("click", () => setMode("bull"));
el("modeBear").addEventListener("click", () => setMode("bear"));

// init
setMode(MODE);

// refresh UI elke 20s (cron doet scan)
setInterval(loadLatest, 20000);