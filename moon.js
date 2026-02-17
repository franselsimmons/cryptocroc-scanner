// /public/moon.js (MOON)
const el = (id) => document.getElementById(id);

const qs = new URLSearchParams(location.search);

let MODE = (qs.get("mode") || "bull").toLowerCase();
if (MODE !== "bull" && MODE !== "bear") MODE = "bull";

const token = (qs.get("token") || "").trim();

function withToken(url) {
  if (!token) return url;
  const u = new URL(url, location.origin);
  u.searchParams.set("token", token);
  return u.pathname + "?" + u.searchParams.toString();
}

const API = {
  latest: (mode) => withToken(`/api/moon-latest?mode=${encodeURIComponent(mode)}`),
};

function fmt(n, d = 2) {
  return (Number(n) || 0).toFixed(d);
}
function fmtPct(n) {
  n = Number(n) || 0;
  const s = n >= 0 ? "+" : "";
  return s + n.toFixed(2) + "%";
}
function fmtSign(n, d = 2) {
  n = Number(n) || 0;
  return (n >= 0 ? "+" : "") + n.toFixed(d);
}
function short(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return n.toFixed(0);
}

// Confidence kleur
function confColor(conf) {
  const v = Number(conf) || 0;
  if (v < 50) return "var(--bad)";
  if (v < 70) return "var(--warn)";
  if (v < 85) return "var(--mid)";
  return "var(--good)";
}

// Liquidity dot voor Moon: combineer ob + depthOk
function liquidityClass(c) {
  const depthOk = !!c?.depthOk;
  const ob = c?.ob || null;
  const valid = !!ob?.valid;
  if (!ob) return "";
  if (!valid) return "liqWarn";
  if (valid && depthOk) return "liqGood";
  return "liqWarn";
}

function setMode(mode) {
  MODE = mode;
  qs.set("mode", MODE);
  if (token) qs.set("token", token);
  history.replaceState(null, "", `${location.pathname}?${qs.toString()}`);

  el("modeBull")?.classList.toggle("active", MODE === "bull");
  el("modeBear")?.classList.toggle("active", MODE === "bear");

  loadLatest();
}

function emptyBox(msg = "Geen coins") {
  return `<div class="empty">${msg}</div>`;
}

function coinCard(c, stageName) {
  const conf = Number(c?.confidence || 0);
  const confPct = Math.max(0, Math.min(100, conf));
  const liqCls = liquidityClass(c);

  return `
    <div class="coinRow" data-stage="${stageName}">
      <div class="coinTop">
        <div class="sym">${c?.symbol || "—"}</div>
        <div class="confWrap">
          <span class="liqDot ${liqCls}" title="Liquidity (OB + Depth)"></span>
          <div class="confBar" title="Confidence">
            <div class="confFill" style="width:${confPct}%;background:${confColor(conf)}"></div>
          </div>
          <div class="confNum">${conf}/100</div>
        </div>
      </div>

      <div class="coinMeta">
        <span>chg24: ${fmtPct(c?.change24)}</span>
        <span>range24: ${fmt(c?.range24)}%</span>
        <span>mc: ${short(c?.marketCap)}</span>
        <span>vol: ${short(c?.volume)}</span>
        <span>vm: ${fmt(c?.vm, 2)}</span>
        <span>cons: ${Math.round((Number(c?.consistency?.ratio || 0)) * 100)}%</span>
      </div>
    </div>
  `;
}

function renderStage(list, targetEl, stageName) {
  if (!targetEl) return;
  if (!Array.isArray(list) || list.length === 0) {
    targetEl.innerHTML = emptyBox();
    return;
  }

  targetEl.innerHTML = list.map((c) => coinCard(c, stageName)).join("");
  targetEl.querySelectorAll(".coinRow").forEach((rowEl, idx) => {
    rowEl.addEventListener("click", () => openModal(list[idx], stageName));
  });
}

function portfolioLine(p) {
  if (!p) return "";
  return ` • Portfolio: Open ${p.openCount ?? 0} | Closed ${p.closedCount ?? 0} | Realized $${fmt(
    p.realizedUsd ?? 0,
    2
  )} | Avg ${fmtSign(p.avgRealizedPct ?? 0, 2)}%`;
}

/* =======================
   MODAL + TABS
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

function pretty(obj) {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

function openModal(c, stageName) {
  showModal(true);
  setTab("why");

  el("mTitle") && (el("mTitle").textContent = `${c?.symbol || "—"} • ${stageName} • ${MODE.toUpperCase()}`);

  el("mSub") &&
    (el("mSub").textContent =
      `Price $${fmt(c?.price)} • Chg24 ${fmtPct(c?.change24)} • Range24 ${fmt(c?.range24)}% • ` +
      `VM ${fmt(c?.vm, 2)} • Conf ${Number(c?.confidence || 0)}`);

  el("mWhy") &&
    (el("mWhy").textContent =
      `Stage: ${stageName}\n` +
      `Why: ${pretty(c?.why || {})}\n` +
      `Consistency: ${Math.round((Number(c?.consistency?.ratio || 0)) * 100)}%\n` +
      `VolAcc: ${fmt(c?.volAcc, 2)}\n`);

  el("mOB") &&
    (el("mOB").textContent =
      `OB: ${pretty(c?.ob || null)}\n` +
      `DepthOk: ${String(!!c?.depthOk)}\n` +
      `FloorUsd: ${Math.round(Number(c?.floorUsd || 0))}\n`);

  el("mRisk") &&
    (el("mRisk").textContent =
      `Risk: ${pretty(c?.risk || null)}\n` +
      `Trade: ${pretty(c?.trade || null)}\n`);

  el("mNext") && (el("mNext").textContent = `Debug object (kort):\n${pretty({
    symbol: c?.symbol,
    confidence: c?.confidence,
    consistency: c?.consistency,
    rolling: c?.rolling || null,
  })}`);
}

/* =======================
   LOAD
======================= */

async function loadLatest() {
  el("modeBull")?.classList.toggle("active", MODE === "bull");
  el("modeBear")?.classList.toggle("active", MODE === "bear");

  const statusLine = el("statusLine");
  if (statusLine) statusLine.textContent = "Status: laden…";

  try {
    const r = await fetch(API.latest(MODE), { cache: "no-store" });
    const j = await r.json();

    const counts = j?.counts || {};
    const btc = j?.btc
      ? ` • BTC ${j.btc.state} (${fmtSign(j.btc.chg24)}% / ${fmt(j.btc.range24)}%)`
      : "";
    const note = j?.note ? ` • ${j.note}` : "";
    const pLine = portfolioLine(j?.portfolio);

    if (statusLine) {
      statusLine.textContent =
        `Mode: ${MODE.toUpperCase()} • ELITE ${counts.elite || 0} • ALMOST ${counts.almost || 0} • ` +
        `BUILDUP ${counts.buildup || 0} • RADAR ${counts.radar || 0}${btc}${pLine}${note}`;
    }

    const funnel = j?.funnel || {};
    renderStage(funnel.elite || [], el("stageElite"), "ELITE");
    renderStage(funnel.almost || [], el("stageAlmost"), "ALMOST");
    renderStage(funnel.buildup || [], el("stageBuildup"), "BUILDUP");
    renderStage(funnel.radar || [], el("stageRadar"), "RADAR");
  } catch (e) {
    if (statusLine) statusLine.textContent = "Status: error (check Vercel logs)";
    el("stageElite") && (el("stageElite").innerHTML = `<pre class="modalPre">${String(e)}</pre>`);
    el("stageAlmost") && (el("stageAlmost").innerHTML = "");
    el("stageBuildup") && (el("stageBuildup").innerHTML = "");
    el("stageRadar") && (el("stageRadar").innerHTML = "");
  }
}

/* =======================
   INIT
======================= */

el("modeBull")?.addEventListener("click", () => setMode("bull"));
el("modeBear")?.addEventListener("click", () => setMode("bear"));

setMode(MODE);
setInterval(loadLatest, 20000);