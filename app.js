// /public/app.js

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

  el("modeBull")?.classList.toggle("active", mode === "bull");
  el("modeBear")?.classList.toggle("active", mode === "bear");

  loadLatest();
}

// ===== formatters =====
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

// ===== SIZING (Advies) =====
// ✅ BELANGRIJK: geen "Advies —" meer tonen.
// Als er geen sizing is -> leeg (en dan laten we de pill ook weg).
function sizingText(c) {
  const s = c?.sizing || null;
  if (!s) return "";
  const pct = Number.isFinite(Number(s.pct)) ? Number(s.pct) : null;
  const zone = String(s.zone || "").trim();
  if (pct === null) return "";
  return `Advies ${pct}%${zone ? ` (BTC ${zone})` : ""}`;
}

// ===== TRADE pills =====
function tradePillFromCoin(c) {
  const t = c?.trade || null;
  if (!t) return "";

  if (t.status === "OPEN") {
    const pnl = Number.isFinite(Number(t.pnl)) ? Number(t.pnl) : null;
    const maxPnl = Number.isFinite(Number(t.maxPnl)) ? Number(t.maxPnl) : null;
    const pnlTxt = pnl === null ? "" : ` • pnl ${fmtPct(pnl * 100)}`;
    const maxTxt = maxPnl === null ? "" : ` • max ${fmtPct(maxPnl * 100)}`;
    return `<div class="pill pillHold">HOLD${pnlTxt}${maxTxt}</div>`;
  }

  if (t.status === "CLOSED") {
    const reason = t?.exit?.reason ? ` • ${t.exit.reason}` : "";
    return `<div class="pill pillSell">SELL${reason}</div>`;
  }

  return "";
}

// ✅ FIX: deze functie geeft al een complete pill terug.
// In sellRow moet je hem NIET nog een keer in een pill wrappen.
function tradePillFromSellRow(s) {
  const sym = s?.symbol || "—";
  const reason = s?.reason ? ` • ${s.reason}` : "";
  const pnl = Number.isFinite(Number(s?.pnlPct))
    ? ` • pnl ${fmtPct(Number(s.pnlPct) * 100)}`
    : "";
  return `<div class="pill pillSell">SELL ${sym}${reason}${pnl}</div>`;
}

// ===== rows =====
function coinRow(c) {
  const div = document.createElement("div");
  div.className = "coinRow";

  const adv = sizingText(c); // kan leeg zijn
  const scans = Number.isFinite(Number(c.stageScans)) ? Number(c.stageScans) : 0;
  const tPill = tradePillFromCoin(c);

  // ✅ Als geen trade en geen sizing -> geen pill tonen (strakker)
  const rightPill = tPill
    ? tPill
    : adv
    ? `<div class="pill pillAdv">${adv}</div>`
    : "";

  div.innerHTML = `
    <div class="coinTop">
      <div>
        <div class="sym">${c.symbol}</div>
        <div class="tag">${c.name || ""}</div>
      </div>

      ${confBar(c.confidence)}

      ${rightPill}
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

function sellRow(s) {
  const div = document.createElement("div");
  div.className = "coinRow";

  const ts = Number(s?.ts || 0);
  const stamp = ts ? new Date(ts).toLocaleString() : "—";

  div.innerHTML = `
    <div class="coinTop">
      <div>
        <div class="sym">${s?.symbol || "—"}</div>
        <div class="tag">${stamp}</div>
      </div>
      ${tradePillFromSellRow(s)}
    </div>

    <div class="coinMeta">
      <span>side: ${String(s?.side || "—")}</span>
      <span>entry: $${Number(s?.entryPrice || 0).toFixed(6)}</span>
      <span>exit: $${Number(s?.exitPrice || 0).toFixed(6)}</span>
      <span>bars: ${Number(s?.barsOpen || 0)}</span>
    </div>
  `;

  return div;
}

function renderStage(targetId, arr, renderer = coinRow) {
  const box = el(targetId);
  if (!box) return;

  box.innerHTML = "";
  if (!arr || arr.length === 0) {
    box.innerHTML = `<div class="empty">Geen coins.</div>`;
    return;
  }
  for (const x of arr) box.appendChild(renderer(x));
}

function btcLine(btc) {
  if (!btc) return "BTC: —";
  return `BTC: ${btc.state} | chg24 ${fmtPct(btc.chg24)} | range24 ${fmtPct(btc.range24)}`;
}

function flattenFunnel(data) {
  const f = data?.funnel || {};
  return []
    .concat(f.entry || [])
    .concat(f.almost || [])
    .concat(f.buildup || [])
    .concat(f.radar || []);
}

function pickHold(data) {
  const all = flattenFunnel(data);
  const hold = all.filter((c) => c?.trade?.status === "OPEN");
  hold.sort((a, b) => (Number(b?.trade?.pnl) || 0) - (Number(a?.trade?.pnl) || 0));
  return hold;
}

function pickSellFromLog(data) {
  const arr = data?.trading?.recentSells || [];
  const sell = Array.isArray(arr) ? arr.slice(0, 50) : [];
  sell.sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0));
  return sell;
}

function renderAll(data) {
  const ts = data?.ts ? new Date(data.ts) : null;
  const stamp = ts ? ts.toLocaleString() : "—";

  const hold = pickHold(data);
  const sell = pickSellFromLog(data);

  const statusLine = el("statusLine");
  if (statusLine) {
    statusLine.textContent =
      `${btcLine(data.btc)} • Laatste update: ${stamp} • ` +
      `HOLD ${hold.length} • SELL ${sell.length} • ` +
      `ENTRY ${data?.counts?.entry || 0} • ALMOST ${data?.counts?.almost || 0} • ` +
      `BUILDUP ${data?.counts?.buildup || 0} • RADAR ${data?.counts?.radar || 0}`;
  }

  renderStage("stageHold", hold, coinRow);
  renderStage("stageSell", sell, sellRow);

  renderStage("stageEntry", data?.funnel?.entry || [], coinRow);
  renderStage("stageAlmost", data?.funnel?.almost || [], coinRow);
  renderStage("stageBuildup", data?.funnel?.buildup || [], coinRow);
  renderStage("stageRadar", data?.funnel?.radar || [], coinRow);
}

async function loadLatest() {
  try {
    const sl = el("statusLine");
    if (sl) sl.textContent = "Status: laden…";

    const r = await fetch(API.latest(MODE), {
      cache: "no-store",
      headers: { "cache-control": "no-cache" },
    });

    const j = await r.json();
    renderAll(j || {});
  } catch {
    const statusLine = el("statusLine");
    if (statusLine) statusLine.textContent = "Status: fout bij laden (check Vercel logs)";
  }
}

// ===== modal =====
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
  if (!container) return;
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

  const t = c?.trade || null;
  const tradeState =
    t?.status === "OPEN" ? "HOLD" :
    t?.status === "CLOSED" ? "SELL" :
    c.stage;

  el("mTitle").textContent = `${c.symbol} • ${MODE.toUpperCase()} • ${tradeState}`;
  el("mSub").textContent =
    `Price $${safe(c.price, 6)} • Chg24 ${fmtPct(c.change24)} • Range24 ${fmtPct(c.range24)} • VM ${safe(c.vm, 2)} • Conf ${c.confidence}/100`;

  const whyList = el("mWhyList");
  if (whyList) whyList.innerHTML = "";

  const scans = Number.isFinite(Number(c.stageScans)) ? Number(c.stageScans) : 0;

  const consRatio = Number(c?.consistency?.ratio || 0);
  const consOk = !!c?.consistency?.ok;
  const consSame = Number(c?.consistency?.same || 0);
  const consTotal = Number(c?.consistency?.total || 0);
  const consNeed = Number(c?.consistency?.need || 0);
  const consMinAgree = Number(c?.consistency?.minAgree || 0);

  addCheck(whyList, true, `Stage: ${c.stage}`, `scans: ${scans}`);

  if (t?.status === "OPEN") {
    const pnl = Number.isFinite(Number(t.pnl)) ? Number(t.pnl) : 0;
    const maxPnl = Number.isFinite(Number(t.maxPnl)) ? Number(t.maxPnl) : 0;
    addCheck(
      whyList,
      true,
      "Trade status: OPEN (HOLD)",
      `pnl ${fmtPct(pnl * 100)} • max ${fmtPct(maxPnl * 100)} • barsOpen ${Number(t.barsOpen || 0)}`,
      "ok"
    );
  } else if (t?.status === "CLOSED") {
    addCheck(
      whyList,
      true,
      "Trade status: CLOSED (SELL)",
      `reason: ${t?.exit?.reason || "—"}`,
      "warn"
    );
  }

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

  addCheck(whyList, true, "Volume acceleration", `VolAcc: ${safe(c.volAcc, 2)}`);

  const eg = String(c?.why?.entryGate || "");
  const egOk = /(passed|ok)/i.test(eg);
  addCheck(whyList, egOk, "Entry gate", eg || "—", egOk ? "ok" : "warn");

  // LIQ
  const liqList = el("mLiqList");
  if (liqList) liqList.innerHTML = "";
  addCheck(liqList, true, "Orderbook", "Laden…", "warn");

  try {
    const r = await fetch(API.ob(MODE, c.symbol), {
      cache: "no-store",
      headers: { "cache-control": "no-cache" },
    });

    if (!r.ok) {
      if (liqList) liqList.innerHTML = "";
      addCheck(liqList, false, "Orderbook error", `${r.status} ${r.statusText}`, "warn");
    } else {
      const j = await r.json();
      if (liqList) liqList.innerHTML = "";

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
    if (liqList) liqList.innerHTML = "";
    addCheck(liqList, false, "Orderbook", "OB ERROR: fetch mislukt", "warn");
  }

  setKV(el("mRiskKv"), [
    ["ATR% (proxy)", `${safe(Number(c.atrPct || 0) * 100, 2)}%`],
    ["SL", `$${safe(c.sl, 6)}`],
    ["TP", `$${safe(c.tp, 6)}`],
    ["Sizing advies", sizingText(c) || "—"],
  ]);

  el("mDebug").textContent = JSON.stringify(c, null, 2);
}

// buttons
el("modeBull")?.addEventListener("click", () => setMode("bull"));
el("modeBear")?.addEventListener("click", () => setMode("bear"));

// init
setMode(MODE);
setInterval(loadLatest, 20000);