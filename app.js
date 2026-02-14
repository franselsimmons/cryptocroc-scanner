const el = (id) => document.getElementById(id);

const API = {
  latest: (mode) => `/api/latest?mode=${encodeURIComponent(mode)}`,
  ob:     (symbol) => `/api/orderbook?symbol=${encodeURIComponent(symbol)}`
};

let MODE = localStorage.getItem("MODE") || "bull";
let LAST = null;

// Entry tabs
let ENTRY_TAB = "entry"; // entry | hold | sell

function setMode(mode) {
  MODE = mode;
  localStorage.setItem("MODE", mode);
  el("modeBull").classList.toggle("active", mode === "bull");
  el("modeBear").classList.toggle("active", mode === "bear");
  loadLatest();
}

function setTab(tab) {
  ENTRY_TAB = tab;
  el("tabEntry").classList.toggle("active", tab === "entry");
  el("tabHold").classList.toggle("active", tab === "hold");
  el("tabSell").classList.toggle("active", tab === "sell");
  renderAll(LAST || {});
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

function coinRow(c) {
  const div = document.createElement("div");
  div.className = "coinRow";
  div.innerHTML = `
    <div class="coinTop">
      <div class="sym">${c.symbol}</div>
      <div class="tag">${fmtPct(c.change24)}</div>
    </div>
    <div class="coinMeta">
      <span>prijs: $${c.price}</span>
      <span>vol: $${fmtUSD(c.volume)}</span>
      <span>mc: $${fmtUSD(c.marketCap)}</span>
      <span>vm: ${Number(c.vm || 0).toFixed(2)}</span>
      <span>ob: ${Number(c.obScore ?? 0).toFixed(3)}</span>
    </div>
  `;

  div.addEventListener("click", () => openCoinModal(c));
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
  LAST = data;

  const ts = data?.ts ? new Date(data.ts) : null;
  const stamp = ts ? ts.toLocaleString() : "—";

  // BTC gate info (komt uit API)
  const gate = data?.gate || {};
  const btc = gate?.btc24h;
  const gateText = (typeof btc === "number")
    ? `BTC 24h: ${fmtPct(btc)} • Active: ${(gate.activeMode || "-").toUpperCase()}`
    : `BTC gate: —`;

  const disabled = data?.disabled === true;

  const f = data?.funnel || {};
  const radar = f.radar || [];
  const buildup = f.buildup || [];
  const entry = f.entry || [];
  const hold = f.hold || [];
  const sell = f.sell || [];

  const entryShown =
    ENTRY_TAB === "entry" ? entry :
    ENTRY_TAB === "hold"  ? hold :
    sell;

  if (disabled) {
    el("statusLine").textContent = `Mode: ${MODE.toUpperCase()} • UIT (BTC gate) • ${gateText} • Laatste update: ${stamp}`;
    el("funnelMeta").textContent = `Automatisch • iedereen ziet dezelfde lijst • update elke 10 min`;
  } else {
    el("statusLine").textContent =
      `Mode: ${MODE.toUpperCase()} • ${gateText} • Laatste update: ${stamp} • Radar ${radar.length} • Buildup ${buildup.length} • Entry ${entry.length}`;

    el("funnelMeta").textContent =
      `100% automatisch • iedereen ziet dezelfde coins • filters + Bitget orderbook poort`;
  }

  renderStage("stageEntry", entryShown);
  renderStage("stageBuildup", buildup);
  renderStage("stageRadar", radar);
}

async function loadLatest() {
  try {
    el("statusLine").textContent = "Status: laden…";
    const r = await fetch(API.latest(MODE), { cache: "no-store" });
    const j = await r.json();
    renderAll(j || {});
  } catch (e) {
    el("statusLine").textContent = "Status: fout bij laden (check Vercel logs)";
  }
}

/* ================= POPUP / MODAL ================= */

function openModal() { el("modalBackdrop").classList.remove("hidden"); }
function closeModal() { el("modalBackdrop").classList.add("hidden"); }

function coinInfoText(c) {
  return [
    `Symbol: ${c.symbol}`,
    `Naam: ${c.name || "-"}`,
    `Prijs: $${c.price}`,
    `24h: ${fmtPct(c.change24)}`,
    `Volume: $${fmtUSD(c.volume)}`,
    `Marketcap: $${fmtUSD(c.marketCap)}`,
    `VM ratio: ${Number(c.vm || 0).toFixed(4)}`,
    `OB score (server): ${Number(c.obScore ?? 0).toFixed(4)}`
  ].join("\n");
}

async function openCoinModal(c) {
  el("mTitle").textContent = `${c.symbol}`;
  el("mSub").textContent = `Mode: ${MODE.toUpperCase()}`;
  el("mCoin").textContent = coinInfoText(c);
  el("mOb").textContent = "Orderbook laden…";
  openModal();

  try {
    const r = await fetch(API.ob(c.symbol), { cache: "no-store" });
    const j = await r.json();

    if (!j?.ok) {
      el("mOb").textContent =
        `OB ERROR:\n${j?.error || "Onbekend"}\n\nTip: alleen coins met ${c.symbol}USDT spot op Bitget werken.`;
      return;
    }

    el("mOb").textContent =
      `Mid: ${j.mid}\n` +
      `Bid USD (depth): ${Math.round(j.bidUsd)}\n` +
      `Ask USD (depth): ${Math.round(j.askUsd)}\n` +
      `Score: ${Number(j.score).toFixed(4)}\n`;
  } catch (e) {
    el("mOb").textContent = `OB ERROR: fetch mislukt\n${String(e?.message || e)}`;
  }
}

/* =============== buttons =============== */
el("modeBull").addEventListener("click", () => setMode("bull"));
el("modeBear").addEventListener("click", () => setMode("bear"));

el("tabEntry").addEventListener("click", () => setTab("entry"));
el("tabHold").addEventListener("click", () => setTab("hold"));
el("tabSell").addEventListener("click", () => setTab("sell"));

el("mClose").addEventListener("click", closeModal);
el("modalBackdrop").addEventListener("click", (e) => {
  if (e.target === el("modalBackdrop")) closeModal();
});

// initial
setMode(MODE);
setTab("entry");

// refresh UI elke 30s (maar scan blijft alleen cron)
setInterval(loadLatest, 30000);
