// /app.js
let MODE = (new URLSearchParams(location.search).get("mode") || "bull").toLowerCase();
if (MODE !== "bull" && MODE !== "bear") MODE = "bull";

const $ = (id) => document.getElementById(id);

function money(n){
  n = Number(n)||0;
  if (n >= 1e9) return (n/1e9).toFixed(2)+"B";
  if (n >= 1e6) return (n/1e6).toFixed(2)+"M";
  if (n >= 1e3) return (n/1e3).toFixed(2)+"K";
  return n.toFixed(0);
}
function num(n){ return (Number(n)||0).toFixed(2); }
function pct(n){ n=Number(n)||0; return (n>=0?"+":"")+num(n)+"%"; }

function setMode(m){
  MODE = m;
  const url = new URL(location.href);
  url.searchParams.set("mode", MODE);
  history.replaceState({}, "", url.toString());
  updateButtons();
  load();
}

function updateButtons(){
  $("btnBull").classList.toggle("active", MODE==="bull");
  $("btnBear").classList.toggle("active", MODE==="bear");
}

function renderList(id, list){
  const el = $(id);
  if (!list || list.length === 0){
    el.innerHTML = `<div class="empty">Geen coins.</div>`;
    return;
  }

  el.innerHTML = list.map(c => {
    const badge = c.stageLabel || c.stage;
    const good = (badge==="ENTRY" || badge==="ALMOST");
    return `
      <div class="coinRow" data-sym="${c.symbol}">
        <div class="coinTop">
          <div class="sym">${c.symbol}</div>
          <div class="badge ${good?"good":""}">${badge} • S ${c.strength}</div>
        </div>
        <div class="coinMeta">
          <span>prijs: <b>$${num(c.price)}</b></span>
          <span>chg24: <b>${pct(c.change24)}</b></span>
          <span>range24: <b>${num(c.range24)}%</b></span>
          <span>vm: <b>${num(c.vm)}</b></span>
          <span>scans: <b>${c.stageScans}</b></span>
          <span>vol: <b>$${money(c.volume)}</b></span>
          <span>mc: <b>$${money(c.marketCap)}</b></span>
        </div>
      </div>
    `;
  }).join("");

  // click handlers
  [...el.querySelectorAll(".coinRow")].forEach(row => {
    row.addEventListener("click", () => {
      const sym = row.getAttribute("data-sym");
      const coin = list.find(x => x.symbol === sym);
      if (coin) openModal(coin);
    });
  });
}

function kvLine(k,v){
  return `<div><b>${k}</b> ${v}</div>`;
}

function openModal(c){
  $("modal").classList.remove("hidden");

  $("mTitle").textContent = `${c.symbol} • ${c.stageLabel || c.stage} • Strength ${c.strength}`;
  $("mSub").textContent = `Prijs $${num(c.price)} • chg24 ${pct(c.change24)} • range24 ${num(c.range24)}% • scans ${c.stageScans}`;

  // summary
  $("mSummary").innerHTML = [
    kvLine("VM:", num(c.vm)),
    kvLine("Volume:", "$"+money(c.volume)),
    kvLine("Marketcap:", "$"+money(c.marketCap)),
    kvLine("Stage:", (c.stageLabel || c.stage)),
    kvLine("Stage scans:", c.stageScans),
  ].join("");

  // risk
  const r = c.risk || {};
  $("mRisk").innerHTML = [
    kvLine("SL:", "$"+num(r.sl)),
    kvLine("TP1:", "$"+num(r.tp1)),
    kvLine("TP2:", "$"+num(r.tp2)),
  ].join("");

  // why
  const w = c.why || {};
  $("mWhy").innerHTML = [
    kvLine("BTC gate:", `${w?.btcGate?.got} (needed ${w?.btcGate?.wanted})`),
    kvLine("Radar:", w?.radar?.pass ? "PASS" : "FAIL"),
    kvLine("Buildup:", w?.buildup?.pass ? "PASS" : "FAIL"),
    kvLine("Almost:", w?.almost?.pass ? "PASS" : "FAIL"),
    kvLine("Consistency:", w?.consistency?.pass ? "PASS" : "FAIL"),
    kvLine("Orderbook:", w?.orderbook?.pass ? "PASS" : "FAIL"),
  ].join("");

  // need (wat mist)
  const need = [];
  if (!w?.buildup?.pass) need.push("Mist BUILDUP eisen (chg/vm/vol).");
  if (w?.buildup?.pass && !w?.almost?.pass) need.push("Mist ALMOST eisen (vm/vol/price-flat).");
  if (w?.almost?.pass && !w?.consistency?.pass) need.push(`Consistency te laag of te weinig samples (${w?.consistency?.same}/${w?.consistency?.total}).`);
  if (w?.almost?.pass && w?.consistency?.pass && !w?.orderbook?.pass) need.push("Orderbook nog niet valid/score/spread/stale.");
  if (w?.eliteReady) need.push("Niks. Klaar voor ENTRY.");

  $("mNeed").innerHTML = need.length ? need.map(x => `<div>• ${x}</div>`).join("") : `<div>• —</div>`;

  // cons
  const cs = w?.consistency || {};
  $("mCons").innerHTML = [
    kvLine("Window:", cs.window || "—"),
    kvLine("Dir:", cs.dir || "—"),
    kvLine("Samples:", `${cs.total ?? 0} (min ${cs.minSamples ?? "-"})`),
    kvLine("Same:", `${cs.same ?? 0}`),
    kvLine("Ratio:", `${Math.round((cs.ratio||0)*100)}% (need ${Math.round((cs.ratioNeed||0)*100)}%)`),
  ].join("");

  // OB
  const ob = w?.orderbook?.got || {};
  $("mOb").innerHTML = [
    kvLine("Status:", ob.status || "—"),
    kvLine("Valid:", String(ob.valid ?? "—")),
    kvLine("AvgScore:", String(ob.avgScore ?? "—")),
    kvLine("Spread:", ob.spreadPct != null ? num(ob.spreadPct)+"%" : "—"),
    kvLine("Stale:", String(ob.stale ?? "—")),
    kvLine("Reason:", ob.reason || "—"),
  ].join("");
}

function closeModal(){
  $("modal").classList.add("hidden");
}

$("mClose").addEventListener("click", closeModal);
$("modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });

$("btnBull").addEventListener("click", () => setMode("bull"));
$("btnBear").addEventListener("click", () => setMode("bear"));

$("btnReset").addEventListener("click", async () => {
  // reset is protected: je moet token meegeven (CRON_SECRET)
  const token = prompt("Reset token (CRON_SECRET):");
  if (!token) return;
  const url = `/api/reset?mode=${encodeURIComponent(MODE)}&token=${encodeURIComponent(token)}`;
  const r = await fetch(url, { cache:"no-store" });
  const j = await r.json();
  alert(JSON.stringify(j, null, 2));
});

async function load(){
  const res = await fetch(`/api/latest?mode=${encodeURIComponent(MODE)}`, { cache:"no-store" });
  const data = await res.json();

  const ts = data.ts ? new Date(data.ts).toLocaleString() : "—";
  const c = data.counts || { entry:0, almost:0, buildup:0, radar:0 };
  const btc = data.btc || {};
  const meta = data.meta || {};

  $("sub").textContent =
    `Mode: ${MODE.toUpperCase()} • Laatste: ${ts} • Radar ${c.radar} • Buildup ${c.buildup} • Almost ${c.almost} • Entry ${c.entry}`;

  $("hint").textContent =
    `BTC gate: ${btc.state || "—"} (chg24 ${num(btc.chg24)}%, range24 ${num(btc.range24)}%) • ` +
    `coinRangeCap ${num(meta.coinRangeCap)}% • Consistency window: 2h (min ${meta.consistencyMinSamples || 6})`;

  const f = data.funnel || {};
  renderList("list-entry", f.entry);
  renderList("list-almost", f.almost);
  renderList("list-buildup", f.buildup);
  renderList("list-radar", f.radar);
}

updateButtons();
load();
setInterval(load, 10000);