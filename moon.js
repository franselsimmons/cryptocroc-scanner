// /moon.js (public) — cleaner + overzichtelijker + portfolio + ENTRY/HOLD/SELL

const qs = new URLSearchParams(location.search);

// mode uit URL
let mode = (qs.get("mode") || "bull").toLowerCase();
if (mode !== "bull" && mode !== "bear") mode = "bull";

// token uit URL
const token = (qs.get("token") || "").trim();

// API helpers (token altijd mee)
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

const stageElite   = document.getElementById("stageElite");
const stageAlmost  = document.getElementById("stageAlmost");
const stageBuildup = document.getElementById("stageBuildup");
const stageRadar   = document.getElementById("stageRadar");

// modal refs
const modal  = document.getElementById("modal");
const mClose = document.getElementById("mClose");
const mTitle = document.getElementById("mTitle");
const mSub   = document.getElementById("mSub");
const mWhy   = document.getElementById("mWhy");
const mOB    = document.getElementById("mOB");
const mRisk  = document.getElementById("mRisk");
const mNext  = document.getElementById("mNext");

// ============= events =============
btnBull.onclick = () => setMode("bull");
btnBear.onclick = () => setMode("bear");
btnRefresh.onclick = () => loadLatest();
btnScan.onclick = () => runScan();

mClose.onclick = closeModal;
modal.addEventListener("click", (e) => {
  if (e.target === modal) closeModal();
});

// ============= helpers =============
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

function fmt(n, d = 2) { return (Number(n) || 0).toFixed(d); }
function fmtSign(n, d = 2) { n = Number(n) || 0; return (n >= 0 ? "+" : "") + n.toFixed(d); }

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

function pretty(obj) {
  try { return JSON.stringify(obj, null, 2); }
  catch { return String(obj); }
}

function emptyBox(msg = "Geen coins") {
  return `<div class="empty">${escapeHtml(msg)}</div>`;
}

function pill(txt, cls = "") {
  const c = cls ? ` pill ${cls}` : "pill";
  return `<span class="${c}">${escapeHtml(txt)}</span>`;
}

function tradeBadge(trade) {
  if (!trade) return "";
  const st = String(trade.status || "").toUpperCase();
  const cls =
    st === "ENTRY" ? "badgeEntry" :
    st === "HOLD"  ? "badgeHold"  :
    st === "SELL"  ? "badgeSell"  : "";
  return `<span class="badge ${cls}">${escapeHtml(st)}</span>`;
}

function formatRisk(risk) {
  if (!risk) return { sl: "SL —", tp: "TP —" };
  return {
    sl: `SL ${fmt(risk.slPct, 2)}%`,
    tp: `TP3 ${fmt(risk.tp3, 8)}`
  };
}

function portfolioLine(p) {
  if (!p) return "";
  return ` • Portfolio: Open ${p.openCount ?? 0} | Closed ${p.closedCount ?? 0} | Realized $${fmt(p.realizedUsd ?? 0, 2)} | Avg ${fmtSign(p.avgRealizedPct ?? 0, 2)}%`;
}

// ============= render =============
function coinRow(c, stageName) {
  const conf = Number(c?.confidence || 0);
  const consPct = Math.round((Number(c?.consistency?.ratio || 0)) * 100);

  const risk = c?.risk || null;
  const r = formatRisk(risk);

  const t = c?.trade || null;
  const pnlTxt = t ? `PnL ${fmtSign(t.pnlPct ?? 0, 2)}% ($${fmt(t.pnlUsd ?? 0, 2)})` : "PnL —";

  const roll = c?.rolling || null;
  const rollTxt = roll
    ? `ΔP15 ${fmtSign(roll.deltaPrice15m ?? 0, 2)}% • ΔV15 ${fmt(roll.deltaVol15m ?? 0, 3)} • OBslope ${fmt(roll.obSlope ?? 0, 2)}`
    : "";

  return `
  <div class="coinRow" data-sym="${escapeHtml(c.symbol || "")}" data-stage="${escapeHtml(stageName)}">
    <div class="coinTop">
      <div class="left">
        <div class="sym">${escapeHtml(c.symbol || "—")}</div>
        <div class="tag">${escapeHtml(c.name || "")}</div>
      </div>
      <div class="right">
        ${tradeBadge(t)}
      </div>
    </div>

    <div class="coinMeta">
      ${pill(`Price $${fmt(c.price)}`)}
      ${pill(`Chg24 ${fmtSign(c.change24)}%`)}
      ${pill(`Range24 ${fmt(c.range24)}%`)}
      ${pill(`MC ${short(c.marketCap)}`)}
      ${pill(`Vol ${short(c.volume)}`)}
      ${pill(`VM ${fmt(c.vm, 2)}`)}
      ${pill(`Conf ${conf}`)}
      ${pill(`Cons ${consPct}%`)}
      ${pill(r.sl)}
      ${pill(r.tp)}
      ${pill(pnlTxt, t ? "pillPnl" : "")}
    </div>

    ${rollTxt ? `<div class="coinSub">${escapeHtml(rollTxt)}</div>` : ""}
  </div>`;
}

function renderStage(list, el, stageName) {
  if (!Array.isArray(list) || list.length === 0) {
    el.innerHTML = emptyBox();
    return;
  }
  el.innerHTML = list.map((c) => coinRow(c, stageName)).join("");
  el.querySelectorAll(".coinRow").forEach((rowEl, idx) => {
    rowEl.onclick = () => openModal(list[idx], stageName);
  });
}

// ============= modal =============
function openModal(c, stageName) {
  const depthMin = Math.min(Number(c?.ob?.bidUsd || 0), Number(c?.ob?.askUsd || 0));
  const floor = Number(c?.floorUsd || 0);

  const trade = c?.trade || null;

  mTitle.textContent = `${c.symbol || "—"} • ${stageName}`;
  mSub.textContent =
    `Price $${fmt(c.price)} • Chg24 ${fmtSign(c.change24)}% • Range24 ${fmt(c.range24)}% • VM ${fmt(c.vm, 2)} • Conf ${Number(c?.confidence||0)}`;

  mWhy.textContent = pretty({
    stage: stageName,
    why: c?.why || null,
    rolling: c?.rolling || null,
    depthOk: c?.depthOk ?? null,
    note: c?.note ?? null
  });

  mOB.textContent = pretty({
    ob: c?.ob || null,
    depthMinUsd: depthMin,
    floorUsd: floor
  });

  mRisk.textContent = pretty({
    trade: trade ? {
      status: trade.status,
      entryPrice: trade.entryPrice,
      sl: trade.sl,
      tp3: trade.tp3,
      pnlPct: trade.pnlPct,
      pnlUsd: trade.pnlUsd,
      exitReason: trade.exitReason || null
    } : null,
    risk: c?.risk || null,
    confidence: c?.confidence ?? null,
    consistency: c?.consistency || null,
    volAcc: c?.volAcc ?? null
  });

  mNext.textContent = pretty(c);
  modal.classList.remove("hidden");
}

function closeModal() {
  modal.classList.add("hidden");
}

// ============= main =============
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
    const pLine = portfolioLine(j?.portfolio);

    statusLine.textContent =
      `Mode: ${mode.toUpperCase()} • Elite ${counts.elite || 0} | Almost ${counts.almost || 0} | ` +
      `Buildup ${counts.buildup || 0} | Radar ${counts.radar || 0}${btc}${pLine}${note}`;

    const funnel = j?.funnel || {};
    renderStage(funnel.elite   || [], stageElite,   "ELITE");
    renderStage(funnel.almost  || [], stageAlmost,  "ALMOST");
    renderStage(funnel.buildup || [], stageBuildup, "BUILDUP");
    renderStage(funnel.radar   || [], stageRadar,   "RADAR");

  } catch (e) {
    statusLine.textContent = "Status: error (check Vercel logs)";
    stageElite.innerHTML = `<pre class="modalPre">${escapeHtml(String(e))}</pre>`;
    stageAlmost.innerHTML = "";
    stageBuildup.innerHTML = "";
    stageRadar.innerHTML = "";
  }
}

async function runScan() {
  // Scan is server job: zonder token en CRON_SECRET aan -> 401
  if (!token) {
    alert("Geen token in de URL. Gebruik ?token=JOUW_TOKEN");
    return;
  }

  statusLine.textContent = `Status: scan starten (${mode.toUpperCase()})…`;

  try {
    const r = await fetch(API_SCAN(mode), { cache: "no-store" });
    const j = await r.json();
    if (!j?.ok) throw new Error(j?.error || "Scan failed");
    await loadLatest();
  } catch (e) {
    statusLine.textContent = "Status: scan error (check Vercel logs)";
    stageElite.innerHTML = `<pre class="modalPre">${escapeHtml(String(e))}</pre>`;
  }
}

// ====== (optioneel) tiny CSS inject voor badges (geen HTML wijzig nodig) ======
(function injectCss() {
  const css = `
    .coinTop{display:flex;align-items:center;justify-content:space-between;gap:10px}
    .coinTop .left{display:flex;align-items:baseline;gap:10px}
    .badge{display:inline-flex;align-items:center;justify-content:center;
      padding:4px 8px;border-radius:999px;font-size:12px;letter-spacing:.5px;
      border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.06)}
    .badgeEntry{border-color:rgba(0,200,255,.25)}
    .badgeHold{border-color:rgba(0,255,150,.25)}
    .badgeSell{border-color:rgba(255,80,120,.25)}
    .coinSub{margin-top:8px;opacity:.8;font-size:12px}
    .pillPnl{border-color:rgba(255,255,255,.18)}
  `;
  const s = document.createElement("style");
  s.textContent = css;
  document.head.appendChild(s);
})();

// start
loadLatest();