// /public/app.js (MAIN)
const el = (id) => document.getElementById(id);

const API = {
  latest: (mode) => `/api/latest?mode=${encodeURIComponent(mode)}`,
  ob: (mode, symbol) =>
    `/api/orderbook?side=${encodeURIComponent(mode)}&symbol=${encodeURIComponent(symbol)}`,
};

let MODE =
  new URLSearchParams(location.search).get("mode") ||
  localStorage.getItem("MODE") ||
  "bull";

function setMode(mode) {
  MODE = mode;
  localStorage.setItem("MODE", mode);

  el("modeBull")?.classList.toggle("active", mode === "bull");
  el("modeBear")?.classList.toggle("active", mode === "bear");

  loadLatest();
}

function fmtUSD(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return n.toFixed(0);
}
function fmtPct(n) {
  n = Number(n) || 0;
  const s = n >= 0 ? "+" : "";
  return s + n.toFixed(2) + "%";
}
function fmt(n, d = 2) {
  return (Number(n) || 0).toFixed(d);
}

function sizingText(c) {
  const s = c?.sizing || null;
  if (!s) return null; // MAIN hoeft dit niet altijd te tonen
  return `Advies ${s.pct}% (BTC ${s.zone})`;
}

// Confidence kleur (bar) op basis van score
function confColor(conf) {
  const v = Number(conf) || 0;
  if (v < 50) return "var(--bad)";
  if (v < 70) return "var(--warn)";
  if (v < 85) return "var(--mid)";
  return "var(--good)";
}

// Liquidity dot: combineer OB + depth in 1 status
function liquidityClass(c) {
  // we hebben in MAIN: c.ob.status + ob.valid + depthMinUsd1p
  const st = String(c?.ob?.status || "");
  const valid = !!c?.ob?.valid;
  const depth1p = Number(c?.ob?.depthMinUsd1p || 0);

  // als we niks hebben: grijs (geen class)
  if (!st || st === "none") return "";

  // depth threshold zit server-side in SETTINGS.entry.minDepthUsd1p (200k)
  // client: simpel: >=200k groen, 100-200 oranje, <100 rood
  if (!valid) return "liqWarn";

  if (depth1p >= 200000) return "liqGood";
  if (depth1p >= 100000) return "liqWarn";
  return "liqBad";
}

function coinRow(c) {
  const div = document.createElement("div");
  div.className = "coinRow";

  const conf = Number(c?.confidence || 0);
  const confPct = Math.max(0, Math.min(100, conf));
  const liqCls = liquidityClass(c);

  const adv = sizingText(c); // kan null zijn

  div.innerHTML = `
    <div class="coinTop">
      <div class="sym">${c.symbol}</div>
      <div class="confWrap">
        <span class="liqDot ${liqCls}" title="Liquidity (OB + Depth)"></span>
        <div class="confBar" title="Confidence">
          <div class="confFill" style="width:${confPct}%;background:${confColor(conf)}"></div>
        </div>
        <div class="confNum">${conf}/100</div>
      </div>
    </div>

    <div class="coinMeta">
      <span>chg24: ${fmtPct(c.change24)}</span>
      <span>range24: ${fmtPct(c.range24)}</span>
      <span>vol: $${fmtUSD(c.volume)}</span>
      <span>mc: $${fmtUSD(c.marketCap)}</span>
      <span>vm: ${fmt(c.vm, 2)}</span>
      <span>scans: ${Number(c.stageScans || 0)}</span>
      ${adv ? `<span>• ${adv}</span>` : ``}
    </div>
  `;

  div.addEventListener("click", () => openModal(c));
  return div;
}

function renderStage(targetId, arr) {
  const box = el(targetId);
  if (!box) return;

  box.innerHTML = "";
  if (!arr || arr.length === 0) {
    box.innerHTML = `<div class="empty">Geen coins.</div>`;
    return;
  }
  for (const c of arr) box.appendChild(coinRow(c));
}

function btcLine(btc) {
  if (!btc) return "BTC: —";
  return `BTC: ${btc.state} | chg24 ${fmtPct(btc.chg24)} | range24 ${fmtPct(btc.range24)}`;
}

function renderAll(data) {
  const ts = data?.ts ? new Date(data.ts) : null;
  const stamp = ts ? ts.toLocaleString() : "—";

  const statusLine = el("statusLine");
  if (statusLine) {
    statusLine.textContent =
      `${btcLine(data.btc)} • Laatste update: ${stamp} • ` +
      `ENTRY ${data?.counts?.entry ?? 0} • ALMOST ${data?.counts?.almost ?? 0} • ` +
      `BUILDUP ${data?.counts?.buildup ?? 0} • RADAR ${data?.counts?.radar ?? 0}`;
  }

  renderStage("stageEntry", data?.funnel?.entry || []);
  renderStage("stageAlmost", data?.funnel?.almost || []);
  renderStage("stageBuildup", data?.funnel?.buildup || []);
  renderStage("stageRadar", data?.funnel?.radar || []);
}

async function loadLatest() {
  try {
    el("statusLine") && (el("statusLine").textContent = "Status: laden…");
    const r = await fetch(API.latest(MODE), { cache: "no-store" });
    const j = await r.json();
    renderAll(j || {});
  } catch {
    el("statusLine") &&
      (el("statusLine").textContent = "Status: fout bij laden (check Vercel logs)");
  }
}

/* =======================
   MODAL + TABS (Waarom/Risk)
======================= */

function showModal(on) {
  const modal = el("modal");
  if (!modal) return;
  modal.classList.toggle("hidden", !on);
}

function setTab(name) {
  document.querySelectorAll(".tabBtn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === name);
  });
  document.querySelectorAll(".tabPane").forEach((p) => {
    p.classList.toggle("hidden", p.dataset.pane !== name);
  });
}

el("mClose")?.addEventListener("click", () => showModal(false));
el("modal")?.addEventListener("click", (e) => {
  if (e.target && e.target.id === "modal") showModal(false);
});
document.querySelectorAll(".tabBtn").forEach((b) => {
  b.addEventListener("click", () => setTab(b.dataset.tab));
});

async function openModal(c) {
  showModal(true);
  setTab("why");

  el("mTitle") && (el("mTitle").textContent = `${c.symbol} • ${MODE.toUpperCase()} • ${c.stage}`);

  const cons = c?.consistency || {};
  const consPct = Math.round((Number(cons.ratio || 0)) * 100);

  const adv = sizingText(c);
  el("mSub") &&
    (el("mSub").textContent =
      `Price $${fmt(c.price)} • Chg24 ${fmtPct(c.change24)} • Conf ${c.confidence}/100 • ` +
      `Cons ${consPct}% (${cons.same || 0}/${cons.total || 0})` +
      (adv ? ` • ${adv}` : ""));

  // WHY (kort, controleerbaar)
  el("mWhy") &&
    (el("mWhy").textContent =
      `Stage: ${c.stage}\n` +
      `Desired: ${c?.why?.desired ?? "-"}\n` +
      `EntryGate: ${c?.why?.entryGate ?? "-"}\n` +
      `VolAcc: ${fmt(c.volAcc, 2)}\n`);

  // RISK (kort)
  el("mRisk") &&
    (el("mRisk").textContent =
      `ATR%: ${(Number(c.atrPct || 0) * 100).toFixed(2)}%\n` +
      `SL: $${fmt(c.sl, 6)}\n` +
      `TP: $${fmt(c.tp, 6)}\n`);

  // NEXT (simpel)
  el("mNext") &&
    (el("mNext").textContent =
      `Kijk vooral naar:\n- EntryGate (OB + Depth + Consistency + Confidence)\n- VolAcc en VM\n`);

  // OB details live
  if (el("mOB")) el("mOB").textContent = "Laden…";
  try {
    const r = await fetch(API.ob(MODE, c.symbol), { cache: "no-store" });
    const j = await r.json();

    if (!el("mOB")) return;

    if (j?.status === "validating") {
      el("mOB").textContent = `Status: validating\nTip: ${j.tip || "Wacht ±1 minuut."}\n`;
      return;
    }

    const ob = j?.ob || {};
    el("mOB").textContent =
      `valid: ${!!j.valid}\n` +
      `reason: ${j.reason || "-"}\n` +
      `score: ${Number(ob.score ?? 0).toFixed(4)}\n` +
      `spread: ${Number(ob.spreadPct ?? 0).toFixed(2)}%\n` +
      `lor: ${Number(ob.lor ?? 0).toFixed(2)}\n` +
      `depth1%: $${Math.round(Number(ob.depthMinUsd1p ?? 0))}\n` +
      `bidUsd: $${Math.round(Number(ob.bidUsd ?? 0))}\n` +
      `askUsd: $${Math.round(Number(ob.askUsd ?? 0))}\n` +
      `stale: ${!!j.stale}\n`;
  } catch {
    el("mOB") && (el("mOB").textContent = "OB ERROR: fetch mislukt");
  }
}

/* =======================
   INIT
======================= */

el("modeBull")?.addEventListener("click", () => setMode("bull"));
el("modeBear")?.addEventListener("click", () => setMode("bear"));

setMode(MODE);
setInterval(loadLatest, 20000);