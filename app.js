// app.js — UI leest ALLEEN /api/latest (scan is protected)
let MODE = "bull";

const $ = (sel) => document.querySelector(sel);

function fmtUsd(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(2) + "K";
  return "$" + n.toFixed(0);
}
function fmt(n, d = 2) { return (Number(n) || 0).toFixed(d); }
function sign(n) { n = Number(n) || 0; return (n >= 0 ? "+" : "") + fmt(n, 2); }

function renderCoins(list, containerId) {
  const el = $(containerId);
  if (!el) return;

  if (!Array.isArray(list) || list.length === 0) {
    el.innerHTML = `<div class="empty">Geen coins.</div>`;
    return;
  }

  el.innerHTML = list.map(c => `
    <div class="coin" data-symbol="${c.symbol}">
      <div class="row top">
        <div class="sym">${c.symbol}</div>
        <div class="chg">${sign(c.change24)}%</div>
      </div>
      <div class="row meta">
        <div>prijs: $${fmt(c.price, 8)}</div>
        <div>vol: ${fmtUsd(c.volume)}</div>
        <div>mc: ${fmtUsd(c.marketCap)}</div>
      </div>
      <div class="row meta2">
        <div>vm: ${fmt(c.vm, 2)}</div>
        <div>range24: ${fmt(c.range24, 1)}%</div>
        <div>scans: ${c.stageScans || 0}</div>
      </div>
    </div>
  `).join("");
}

async function load() {
  try {
    const r = await fetch(`/api/latest?mode=${MODE}`, { cache: "no-store" });
    const data = await r.json();

    const btcText =
      data?.btc
        ? `BTC: ${data.btc.state} (chg24 ${sign(data.btc.chg24)}% · range24 ${fmt(data.btc.range24, 2)}%)`
        : `BTC: —`;

    const ts = data?.ts ? new Date(data.ts).toLocaleString() : "—";
    const counts = data?.counts || { entry:0, almost:0, buildup:0, radar:0 };

    $("#topline").textContent =
      `${btcText} · Mode: ${MODE.toUpperCase()} · Laatste update: ${ts} · Entry ${counts.entry} · Almost ${counts.almost} · Buildup ${counts.buildup} · Radar ${counts.radar}`;

    renderCoins(data?.funnel?.entry  || [],  "#list-entry");
    renderCoins(data?.funnel?.almost || [],  "#list-almost");
    renderCoins(data?.funnel?.buildup|| [],  "#list-buildup");
    renderCoins(data?.funnel?.radar  || [],  "#list-radar");
  } catch (e) {
    $("#topline").textContent = `Fout bij laden: ${String(e)}`;
    renderCoins([], "#list-entry");
    renderCoins([], "#list-almost");
    renderCoins([], "#list-buildup");
    renderCoins([], "#list-radar");
  }
}

function setMode(m) {
  MODE = m;
  $("#btn-bull")?.classList.toggle("active", MODE === "bull");
  $("#btn-bear")?.classList.toggle("active", MODE === "bear");
  load();
}

window.addEventListener("load", () => {
  $("#btn-bull")?.addEventListener("click", () => setMode("bull"));
  $("#btn-bear")?.addEventListener("click", () => setMode("bear"));

  // start
  setMode("bull");

  // elke 15s refresh (je cron is 10 min, maar zo zie je direct als er nieuwe latest staat)
  setInterval(load, 15000);
});