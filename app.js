// ===== topbar hoogte automatisch naar CSS var zetten =====
function syncTopbarHeight() {
  const tb = document.querySelector(".topbar");
  const h = tb ? Math.ceil(tb.getBoundingClientRect().height) : 78;
  document.documentElement.style.setProperty("--topbar-h", h + "px");
}
window.addEventListener("resize", syncTopbarHeight);
window.addEventListener("load", syncTopbarHeight);
syncTopbarHeight();

// ===== helpers =====
const el = (id) => document.getElementById(id);

function bust() {
  return `t=${Date.now()}`;
}

const API = {
  latest: (mode) => `/api/latest?mode=${encodeURIComponent(mode)}&${bust()}`,
  ob: (mode, symbol) =>
    `/api/orderbook?side=${encodeURIComponent(mode)}&symbol=${encodeURIComponent(symbol)}&${bust()}`,
};

let MODE =
  new URLSearchParams(location.search).get("mode") ||
  localStorage.getItem("MODE") ||
  "bull";

function setMode(mode) {
  MODE = mode;
  localStorage.setItem("MODE", mode);

  const url = new URL(location.href);
  url.searchParams.set("mode", mode);
  history.replaceState({}, "", url.toString());

  const bullBtn = el("modeBull");
  const bearBtn = el("modeBear");
  if (bullBtn) bullBtn.classList.toggle("active", mode === "bull");
  if (bearBtn) bearBtn.classList.toggle("active", mode === "bear");

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
function fmt(n) {
  return (Number(n) || 0).toFixed(2);
}

function confColor(conf) {
  const c = Number(conf) || 0;
  if (c < 50) return "#EF4444";
  if (c < 70) return "#F59E0B";
  if (c < 85) return "#3B82F6";
  return "#22C55E";
}

function confBar(conf) {
  const pct = Math.max(0, Math.min(100, Number(conf) || 0));
  const col = confColor(pct);
  return `
    <div class="confWrap">
      <div class="confBar"><div class="confFill" style="width:${pct}%;background:${col}"></div></div>
      <div class="confTxt">${pct}/100</div>
    </div>
  `;
}

function sizingText(c) {
  const s = c?.sizing || null;
  if (!s) return "Advies —";
  return `Advies ${s.pct}% (BTC ${s.zone})`;
}

function coinRow(c) {
  const div = document.createElement("div");
  div.className = "coinRow";

  const adv = sizingText(c);
  const scans = Number.isFinite(Number(c.stageScans)) ? Number(c.stageScans) : 0;

  div.innerHTML = `
    <div class="coinTop">
      <div>
        <div class="sym">${c.symbol}</div>
        <div class="tag">${c.name || ""}</div>
      </div>

      ${confBar(c.confidence)}

      <div class="pill pillAdv">${adv}</div>
    </div>

    <div class="coinMeta">
      <span>chg24: ${fmtPct(c.change24)}</span>
      <span>range24: ${fmtPct(c.range24)}</span>
      <span>vol: $${fmtUSD(c.volume)}</span>
      <span>mc: $${fmtUSD(c.marketCap)}</span>
      <span>vm: ${fmt(c.vm)}</span>
      <span>scans: ${scans}</span>
    </div>
  `;
  div.addEventListener("click", () => openModalMain(c));
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
      `${btcLine(data.btc)} • Laatste update: ${stamp} • ENTRY ${data.counts.entry} • ALMOST ${data.counts.almost} • BUILDUP ${data.counts.buildup} • RADAR ${data.counts.radar}`;
  }

  renderStage("stageEntry", data?.funnel?.entry || []);
  renderStage("stageAlmost", data?.funnel?.almost || []);
  renderStage("stageBuildup", data?.funnel?.buildup || []);
  renderStage("stageRadar", data?.funnel?.radar || []);
}

async function loadLatest() {
  try {
    const statusLine = el("statusLine");
    if (statusLine) statusLine.textContent = "Status: laden…";

    const r = await fetch(API.latest(MODE), {
      cache: "no-store",
      headers: { "cache-control": "no-cache" },
    });

    const j = await r.json();
    renderAll(j || {});
  } catch (e) {
    const statusLine = el("statusLine");
    if (statusLine) statusLine.textContent = "Status: fout bij laden (check Vercel logs)";
  }
}

// ===== modal shared UI =====
function showModal(on) {
  const modal = el("modal");
  if (!modal) return;
  modal.classList.toggle("hidden", !on);
}

function setTab(name) {
  const tabs = ["Why", "Liq", "Risk", "Debug"];
  for (const t of tabs) {
    el("tab" + t)?.classList.toggle("active", t === name);
    el("box" + t)?.classList.toggle("hidden", t !== name);
  }
}

el("mClose")?.addEventListener("click", () => showModal(false));
el("modal")?.addEventListener("click", (e) => {
  if (e.target.id === "modal") showModal(false);
});

el("tabWhy")?.addEventListener("click", () => setTab("Why"));
el("tabLiq")?.addEventListener("click", () => setTab("Liq"));
el("tabRisk")?.addEventListener("click", () => setTab("Risk"));
el("tabDebug")?.addEventListener("click", () => setTab("Debug"));

function icon(ok, kind = "ok") {
  if (ok === true) return `<span class="iconOk">✓</span>`;
  if (kind === "warn") return `<span class="iconWarn">⚠</span>`;
  return `<span class="iconNo">✗</span>`;
}

function addCheck(container, ok, title, sub = "", kind = "ok") {
  const div = document.createElement("div");
  div.className = "checkItem";
  div.innerHTML = `
    ${icon(ok, kind)}
    <div class="checkText">
      <div><b>${title}</b></div>
      ${sub ? `<div class="checkSmall">${sub}</div>` : ""}
    </div>
  `;
  container.appendChild(div);
}

function setKV(container, rows) {
  container.innerHTML = "";
  for (const [k, v] of rows) {
    const r = document.createElement("div");
    r.className = "kvRow";
    r.innerHTML = `<div class="kvKey">${k}</div><div class="kvVal">${v}</div>`;
    container.appendChild(r);
  }
}

function safe(n, d = 2) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  return x.toFixed(d);
}

async function openModalMain(c) {
  showModal(true);
  setTab("Why");
  syncTopbarHeight();

  el("mTitle").textContent = `${c.symbol} • ${MODE.toUpperCase()} • ${c.stage}`;
  el("mSub").textContent =
    `Price $${safe(c.price, 6)} • Chg24 ${fmtPct(c.change24)} • Range24 ${fmtPct(c.range24)} • VM ${safe(c.vm, 2)} • Conf ${c.confidence}/100`;

  const whyList = el("mWhyList");
  whyList.innerHTML = "";

  const scans = Number.isFinite(Number(c.stageScans)) ? Number(c.stageScans) : 0;

  const consRatio = Number(c?.consistency?.ratio || 0);
  const consOk = !!c?.consistency?.ok;
  const consSame = Number(c?.consistency?.same || 0);
  const consTotal = Number(c?.consistency?.total || 0);
  const consNeed = Number(c?.consistency?.need || 0);
  const consMinAgree = Number(c?.consistency?.minAgree || 0);

  addCheck(
    whyList,
    true,
    `Stage: ${c.stage}`,
    `scans: ${scans}`
  );

  addCheck(
    whyList,
    consOk,
    "Consistency",
    `Ratio: ${(consRatio * 100).toFixed(0)}% (${consSame}/${consTotal}) • need ${consNeed} • minAgree ${consMinAgree}`,
    consOk ? "ok" : "warn"
  );

  addCheck(
    whyList,
    Number(c.confidence || 0) >= 70,
    "Confidence",
    `Score: ${c.confidence}/100`,
    Number(c.confidence || 0) >= 70 ? "ok" : "warn"
  );

  addCheck(
    whyList,
    true,
    "Volume acceleration",
    `VolAcc: ${safe(c.volAcc, 2)}`
  );

  // ✅ Entry gate: groen als "OK"
  const eg = String(c?.why?.entryGate || "");
  const egOk = /ok/i.test(eg);

  addCheck(
    whyList,
    egOk,
    "Entry gate",
    eg || "—",
    egOk ? "ok" : "warn"
  );

  // LIQ
  const liqList = el("mLiqList");
  liqList.innerHTML = "";

  addCheck(liqList, true, "Orderbook", "Laden…", "warn");

  try {
    const r = await fetch(API.ob(MODE, c.symbol), {
      cache: "no-store",
      headers: { "cache-control": "no-cache" },
    });

    // als server 401/403 geeft: toon netjes
    if (!r.ok) {
      liqList.innerHTML = "";
      addCheck(liqList, false, "Orderbook error", `${r.status} ${r.statusText}`, "warn");
    } else {
      const j = await r.json();
      liqList.innerHTML = "";

      if (j.status === "validating") {
        addCheck(liqList, false, "Orderbook validating", j.tip || "Wacht even…", "warn");
      } else {
        const obOk = !!j.valid && !j.stale;
        addCheck(
          liqList,
          obOk,
          "OB status",
          `valid: ${j.valid} • stale: ${j.stale} • reason: ${j.reason || "-"}`,
          obOk ? "ok" : "warn"
        );

        // ✅ Adaptive thresholds uit scan.js
        const reqSpread = Number(c?.req?.spreadMaxPct ?? 0.55);
        const reqDepth = Number(c?.req?.depthMinUsd1p ?? 200000);

        addCheck(
          liqList,
          Number(j.ob?.spreadPct || 999) <= reqSpread,
          "Spread",
          `spread: ${safe(j.ob?.spreadPct, 2)}% • max ${reqSpread}%`,
          "warn"
        );

        addCheck(
          liqList,
          Number(j.ob?.lor || 1) <= 0.35,
          "Largest order ratio",
          `LOR: ${safe(j.ob?.lor, 2)} (max 0.35)`,
          "warn"
        );

        addCheck(
          liqList,
          Number(j.ob?.depthMinUsd1p || 0) >= reqDepth,
          "Depth 1%",
          `depth1%: $${Math.round(Number(j.ob?.depthMinUsd1p || 0)).toLocaleString()} • min $${Math.round(reqDepth).toLocaleString()}`,
          "warn"
        );
      }
    }
  } catch {
    liqList.innerHTML = "";
    addCheck(liqList, false, "Orderbook", "OB ERROR: fetch mislukt", "warn");
  }

  // RISK (laat staan; jij vult dit later)
  setKV(el("mRiskKv"), [
    ["ATR% (proxy)", `${safe(Number(c.atrPct || 0) * 100, 2)}%`],
    ["SL", `$${safe(c.sl, 6)}`],
    ["TP", `$${safe(c.tp, 6)}`],
    ["Sizing advies", sizingText(c)],
  ]);

  el("mDebug").textContent = JSON.stringify(c, null, 2);
}

// buttons
el("modeBull")?.addEventListener("click", () => setMode("bull"));
el("modeBear")?.addEventListener("click", () => setMode("bear"));

// init
setMode(MODE);
setInterval(loadLatest, 20000);