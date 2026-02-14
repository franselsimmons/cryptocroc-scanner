const el = (id) => document.getElementById(id);

const API = {
  latest: (mode) => `/api/latest?mode=${encodeURIComponent(mode)}`,
  ob: (symbol) => `/api/orderbook?symbol=${encodeURIComponent(symbol)}`
};

let MODE = localStorage.getItem("MODE") || "bull";
let LAST = null;

// reset link (je plakt zelf je secret erachter in de URL)
function updateResetLink() {
  // Voorbeeld: /api/reset?mode=all&secret=JOUW_RESET_SECRET
  el("resetLink").href = `/api/reset?mode=all&secret=PLAK_HIER_JE_SECRET`;
}

function setMode(mode) {
  MODE = mode;
  localStorage.setItem("MODE", mode);
  el("modeBull").classList.toggle("active", mode === "bull");
  el("modeBear").classList.toggle("active", mode === "bear");
  loadLatest();
}

function fmtUSD(n) {
  if (!Number.isFinite(n)) return "-";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return String(Math.round(n));
}

function fmtPct(n) {
  if (!Number.isFinite(n)) return "-";
  const s = n >= 0 ? "+" : "";
  return s + n.toFixed(2) + "%";
}

function tag(stage) {
  return `<span class="pill">${stage}</span>`;
}

function coinRow(c) {
  const div = document.createElement("div");
  div.className = "coinRow";
  div.innerHTML = `
    <div class="coinTop">
      <div class="sym">${c.symbol} ${tag(c.stage)}</div>
      <div class="tag">${fmtPct(c.change24)}</div>
    </div>
    <div class="coinMeta">
      <span>prijs: $${c.price}</span>
      <span>vol: $${fmtUSD(c.volume)}</span>
      <span>mc: $${fmtUSD(c.marketCap)}</span>
      <span>vm: ${Number(c.vm).toFixed(2)}</span>
      <span>range24: ${Number(c.range24).toFixed(1)}%</span>
      <span>ob: ${c.obScore==null ? "—" : Number(c.obScore).toFixed(3)}</span>
    </div>
  `;

  div.addEventListener("click", () => openModal(c));
  return div;
}

function renderStage(targetId, arr) {
  const box = el(targetId);
  box.innerHTML = "";
  if (!arr || arr.length === 0) {
    box.innerHTML = `<div class="empty">Geen coins.</div>`;
    return;
  }
  for (const c of arr) box.appendChild(coinRow(c));
}

function renderAll(data) {
  LAST = data || {};

  const ts = data?.ts ? new Date(data.ts) : null;
  const stamp = ts ? ts.toLocaleString() : "—";

  const btc = data?.btc || { state: "—", change24: 0, range24: 0 };
  const counts = data?.counts || {};

  el("statusLine").textContent =
    `Mode: ${MODE.toUpperCase()} • BTC: ${btc.state} (${fmtPct(btc.change24)} | range ${btc.range24.toFixed(1)}%) • ` +
    `Update: ${stamp} • Pool ${counts.pool ?? 0} • Entry ${counts.entry ?? 0} • Hold ${counts.hold ?? 0} • Sell ${counts.sell ?? 0} • Radar ${counts.radar ?? 0}`;

  renderStage("stageEntry", data?.entry || []);
  renderStage("stageHold", data?.hold || []);
  renderStage("stageSell", data?.sell || []);
  renderStage("stageRadar", data?.radar || []);
}

async function loadLatest() {
  try {
    el("statusLine").textContent = "Laden…";
    const r = await fetch(API.latest(MODE), { cache: "no-store" });
    const j = await r.json();
    renderAll(j || {});
  } catch {
    el("statusLine").textContent = "Fout bij laden (check Vercel logs)";
  }
}

// ============ MODAL + ORDERBOOK ============
function openModal(c) {
  el("modal").classList.add("open");
  el("mTitle").textContent = `${c.symbol}`;
  el("mSub").textContent = `Mode: ${MODE.toUpperCase()} • Stage: ${c.stage}`;

  el("mInfo").textContent =
    `Symbol: ${c.symbol}\n` +
    `Naam: ${c.name}\n` +
    `Prijs: $${c.price}\n` +
    `24h: ${fmtPct(c.change24)}\n` +
    `Range24: ${Number(c.range24).toFixed(1)}%\n` +
    `Volume: $${fmtUSD(c.volume)}\n` +
    `MarketCap: $${fmtUSD(c.marketCap)}\n` +
    `VM ratio: ${Number(c.vm).toFixed(4)}\n` +
    `OB score (server): ${c.obScore==null ? "—" : Number(c.obScore).toFixed(4)}\n`;

  el("mOb").textContent = "Laden…";
  loadOrderbook(c.symbol);
}

async function loadOrderbook(symbol) {
  try {
    const r = await fetch(API.ob(symbol), { cache: "no-store" });
    const j = await r.json();

    if (j?.error) {
      el("mOb").textContent =
        `OB ERROR:\n${j.error}\n\nTip: alleen coins met ${symbol}USDT spot op Bitget werken.`;
      return;
    }

    el("mOb").textContent =
      `mid: ${j.mid}\n` +
      `spread: ${Number(j.spreadPct).toFixed(3)}%\n` +
      `score: ${Number(j.score).toFixed(4)}\n` +
      `bidUsd: ${j.bidUsd}\n` +
      `askUsd: ${j.askUsd}\n` +
      `largestOrderRatio: ${Number(j.largestOrderRatio).toFixed(3)}\n`;
  } catch {
    el("mOb").textContent = "OB ERROR: fetch mislukt";
  }
}

el("mClose").addEventListener("click", () => el("modal").classList.remove("open"));
el("modal").addEventListener("click", (e) => {
  if (e.target === el("modal")) el("modal").classList.remove("open");
});

// buttons
el("modeBull").addEventListener("click", () => setMode("bull"));
el("modeBear").addEventListener("click", () => setMode("bear"));

// init
updateResetLink();
setMode(MODE);

// auto refresh (UI) elke 30s. Scan = alleen cron (10 min)
setInterval(loadLatest, 30_000);
