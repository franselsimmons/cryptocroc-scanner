// ==================== app.js ====================
function syncTopbarHeight() {
  const tb = document.querySelector(".topbar");
  const h = tb ? Math.ceil(tb.getBoundingClientRect().height) : 78;
  document.documentElement.style.setProperty("--topbar-h", h + "px");
}
window.addEventListener("resize", syncTopbarHeight);
window.addEventListener("load", syncTopbarHeight);
syncTopbarHeight();

const el = (id) => document.getElementById(id);

const API = {
  latest: (mode) => `/api/latest?mode=${encodeURIComponent(mode)}`,
};

let MODE =
  new URLSearchParams(location.search).get("mode") ||
  localStorage.getItem("MODE") ||
  "bull";

const lastTsByMode = { bull: 0, bear: 0 };
let isLoading = false;

function setMode(mode) {
  MODE = mode === "bear" ? "bear" : "bull";
  localStorage.setItem("MODE", MODE);

  const url = new URL(location.href);
  url.searchParams.set("mode", MODE);
  history.replaceState({}, "", url.toString());

  el("modeBull")?.classList.toggle("active", MODE === "bull");
  el("modeBear")?.classList.toggle("active", MODE === "bear");

  loadLatest(true);
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
function safe(n, d = 2) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  return x.toFixed(d);
}
function pct(n, d = 2) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  const s = x >= 0 ? "+" : "";
  return s + x.toFixed(d) + "%";
}
function upperStage(v) {
  return String(v || "").toUpperCase();
}

function arr(x) {
  return Array.isArray(x) ? x : [];
}

// ===== AANGEPAST: scannedAt heeft voorrang =====
function getSnapshotTs(data) {
  return Number(data?.scannedAt || data?.ts || 0);
}

function normalizeMainFunnel(data) {
  const f = data?.funnel || {};

  const eliteExpansion = arr(f.elite_expansion);
  const eliteIgnition = arr(f.elite_ignition);
  const entry = arr(f.entry).length ? arr(f.entry) : eliteExpansion.concat(eliteIgnition);

  return {
    entry,
    elite_expansion: eliteExpansion,
    elite_ignition: eliteIgnition,
    almost: arr(f.almost),
    buildup: arr(f.buildup),
    radar: arr(f.radar),
    hold: arr(f.hold),
    sell: arr(f.sell),
  };
}

function normalizedCounts(data) {
  const f = normalizeMainFunnel(data);
  const counts = data?.counts || data?.meta?.counts || {};

  return {
    entry: Number(counts.entry ?? f.entry.length ?? 0),
    hold: Number(counts.hold ?? f.hold.length ?? 0),
    sell: Number(counts.sell ?? f.sell.length ?? 0),
    almost: Number(counts.almost ?? f.almost.length ?? 0),
    buildup: Number(counts.buildup ?? f.buildup.length ?? 0),
    radar: Number(counts.radar ?? f.radar.length ?? 0),
  };
}

function computeFallbackRisk(c, mode) {
  const price = Number(c?.price || 0);
  if (!(price > 0)) return null;

  const rangePct = Math.max(0, Number(c?.range24 || c?.change24 || 0));
  let atrPct = Math.max(1.2, Math.min(6.5, rangePct / 4 || 2.2));
  const atr = atrPct / 100;
  const isBull = String(mode || "bull").toLowerCase() === "bull";

  const sl = isBull ? price * (1 - 1.2 * atr) : price * (1 + 1.2 * atr);
  const tp = isBull ? price * (1 + 2.2 * atr) : price * (1 - 2.2 * atr);
  const rr = Math.abs((tp - price) / (price - sl || 1e-9));

  return { atrPct, sl, tp, rr, source: "fallback" };
}

function getRisk(c, mode) {
  const price = Number(c?.price || 0);
  const plan = c?.tradePlan || null;

  const hasBackendPlan =
    Number.isFinite(Number(plan?.sl)) &&
    Number.isFinite(Number(plan?.tp)) &&
    Number(plan?.sl) !== 0 &&
    Number(plan?.tp) !== 0;

  if (hasBackendPlan) {
    const sl = Number(plan.sl);
    const tp = Number(plan.tp);

    return {
      atrPct: null,
      sl,
      tp,
      rr: Number.isFinite(Number(plan?.rr))
        ? Number(plan.rr)
        : (price > 0 ? Math.abs((tp - price) / (price - sl || 1e-9)) : null),
      source: "backend",
    };
  }

  return computeFallbackRisk(c, mode);
}

function scoreValue(c) {
  if (Number.isFinite(Number(c?.entryQuality))) return Math.round(Number(c.entryQuality));
  if (Number.isFinite(Number(c?.confidence))) {
    const v = Number(c.confidence);
    return v <= 1 ? Math.round(v * 100) : Math.round(v);
  }
  return 0;
}

function actionForStage(c) {
  const stage = upperStage(c?.stage);

  if (stage === "ELITE_EXPANSION") {
    return { label: "ENTRY", sub: "Sterkste main-setup actief", tone: "ok" };
  }
  if (stage === "ELITE_IGNITION") {
    return { label: "ENTRY", sub: "Bijna of net in de move", tone: "ok" };
  }
  if (stage === "HOLD") {
    return { label: "HOLD", sub: "Positie blijft geldig", tone: "ok" };
  }
  if (stage === "SELL") {
    return { label: "SELL", sub: "Trade is gesloten / ongeldig", tone: "no" };
  }
  if (stage === "ALMOST") {
    return { label: "KLAARZETTEN", sub: "Mist nog 1–2 checks", tone: "warn" };
  }
  if (stage === "BUILDUP") {
    return { label: "WATCHLIST", sub: "Interessant, maar nog te vroeg", tone: "warn" };
  }
  return { label: "SKIP", sub: "Nog geen setup", tone: "no" };
}

function confColor(conf) {
  const c = Number(conf) || 0;
  if (c < 40) return "#EF4444";
  if (c < 60) return "#F59E0B";
  if (c < 80) return "#3B82F6";
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

function coinRow(c) {
  const div = document.createElement("div");
  div.className = "coinRow";

  const conf = scoreValue(c);
  const risk = getRisk(c, MODE);
  const slTxt = risk ? `$${safe(risk.sl, 6)}` : "—";
  const tpTxt = risk ? `$${safe(risk.tp, 6)}` : "—";

  div.innerHTML = `
    <div class="coinTop">
      <div>
        <div class="sym">${c.symbol || "—"}</div>
        <div class="tag">${c.name || ""}</div>
      </div>
      ${confBar(conf)}
    </div>

    <div class="coinMeta">
      <span>chg1h: ${fmtPct(c.change1h)}</span>
      <span>chg24: ${fmtPct(c.change24)}</span>
      <span>vol: $${fmtUSD(c.volume)}</span>
      <span>mc: $${fmtUSD(c.marketCap)}</span>
      <span>vm: ${fmt(c.vm)}</span>
      <span>price: $${safe(c.price, 6)}</span>
      <span>SL: ${slTxt}</span>
      <span>TP: ${tpTxt}</span>
    </div>

    <div class="tag" style="margin-top:6px;">${upperStage(c.stage || "RADAR")}</div>
  `;

  div.addEventListener("click", () => openModalMain(c));
  return div;
}

function sellRow(s) {
  const div = document.createElement("div");
  div.className = "coinRow";

  div.innerHTML = `
    <div class="coinTop">
      <div>
        <div class="sym">${s?.symbol || "—"}</div>
        <div class="tag">${s?.reason || s?.exitReason || "gesloten"}</div>
      </div>
    </div>

    <div class="coinMeta">
      <span>entry: $${safe(s?.entryPrice || s?.entry, 6)}</span>
      <span>exit: $${safe(s?.exitPrice || s?.exit, 6)}</span>
      <span>pnl: ${Number.isFinite(Number(s?.pnlPct)) ? fmtPct(Number(s.pnlPct)) : "—"}</span>
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
  const state = btc.state || "—";
  const chg24 = Number.isFinite(Number(btc.chg24)) ? ` | chg24 ${fmtPct(btc.chg24)}` : "";
  const range24 = Number.isFinite(Number(btc.range24)) ? ` | range24 ${fmtPct(btc.range24)}` : "";
  return `BTC: ${state}${chg24}${range24}`;
}

function renderAll(data) {
  window.__LAST_DATA__ = data;

  const ts = getSnapshotTs(data);
  const stamp = ts ? new Date(ts).toLocaleString() : "—";
  const funnel = normalizeMainFunnel(data);
  const counts = normalizedCounts(data);

  const statusLine = el("statusLine");
  if (statusLine) {
    statusLine.textContent =
      `${btcLine(data.btc)} • Laatste update: ${stamp} • ` +
      `ENTRY ${counts.entry} • HOLD ${counts.hold} • SELL ${counts.sell} • ` +
      `ALMOST ${counts.almost} • BUILDUP ${counts.buildup} • RADAR ${counts.radar}`;
  }

  renderStage("stageEntry", funnel.entry, coinRow);
  renderStage("stageHold", funnel.hold, coinRow);
  renderStage("stageSell", funnel.sell, sellRow);
  renderStage("stageAlmost", funnel.almost, coinRow);
  renderStage("stageBuildup", funnel.buildup, coinRow);
  renderStage("stageRadar", funnel.radar, coinRow);
}

async function loadLatest(force = false) {
  if (isLoading && !force) return;
  isLoading = true;

  try {
    const sl = el("statusLine");
    if (sl && force) sl.textContent = "Status: laden…";

    const r = await fetch(API.latest(MODE), {
      cache: "no-store",
      headers: {
        "cache-control": "no-cache, no-store, max-age=0",
        pragma: "no-cache",
      },
    });

    const text = await r.text();
    let j;

    try {
      j = JSON.parse(text);
    } catch {
      throw new Error(`Ongeldige JSON: ${text.slice(0, 180)}`);
    }

    if (!r.ok) {
      throw new Error(j?.error || `HTTP ${r.status}`);
    }

    const ts = getSnapshotTs(j);

    if (!force && ts && ts === (lastTsByMode[MODE] || 0)) {
      isLoading = false;
      return;
    }

    if (ts) lastTsByMode[MODE] = ts;

    renderAll(j || {});
  } catch (e) {
    const statusLine = el("statusLine");
    if (statusLine) {
      statusLine.textContent = `Status: fout bij laden • ${String(e?.message || e)}`;
    }

    renderStage("stageEntry", []);
    renderStage("stageHold", []);
    renderStage("stageSell", []);
    renderStage("stageAlmost", []);
    renderStage("stageBuildup", []);
    renderStage("stageRadar", []);
  } finally {
    isLoading = false;
  }
}

function showModal(on) {
  const modal = el("modal");
  if (!modal) return;
  modal.classList.toggle("hidden", !on);
}
function setTab(name) {
  const tabs = ["Action", "Why", "Liq", "Debug"];
  for (const t of tabs) {
    el("tab" + t)?.classList.toggle("active", t === name);
    el("box" + t)?.classList.toggle("hidden", t !== name);
  }
}

el("mClose")?.addEventListener("click", () => showModal(false));
el("modal")?.addEventListener("click", (e) => {
  if (e.target.id === "modal") showModal(false);
});

el("tabAction")?.addEventListener("click", () => setTab("Action"));
el("tabWhy")?.addEventListener("click", () => setTab("Why"));
el("tabLiq")?.addEventListener("click", () => setTab("Liq"));
el("tabDebug")?.addEventListener("click", () => setTab("Debug"));

function icon(ok, kind = "ok") {
  if (ok === true) return `<span class="iconOk">✓</span>`;
  if (kind === "warn") return `<span class="iconWarn">⚠</span>`;
  return `<span class="iconNo">✗</span>`;
}

function addCheck(container, ok, title, sub = "", kind = "ok") {
  if (!container) return;
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

function liquiditySummary(c) {
  const ob = c?.ob || {};
  const spread = Number(ob?.spreadPct);
  const depth = Number(ob?.depthMinUsd1p);
  const score = Number(ob?.score);

  const hasSpread = Number.isFinite(spread);
  const hasDepth = Number.isFinite(depth);
  const hasScore = Number.isFinite(score);

  if (!hasSpread && !hasDepth && !hasScore) {
    return {
      ok: false,
      title: "Liquiditeit onbekend",
      text: "Er is geen bruikbare orderboek-data.",
      why: "Deze coin heeft nu geen bruikbare OB snapshot.",
      tone: "warn",
      details: [],
    };
  }

  const spreadOk = hasSpread ? spread <= 1.2 : false;
  const depthOk = hasDepth ? depth >= 5000 : false;
  const scoreOk = hasScore ? Math.abs(score) >= 0.04 : false;

  if (spreadOk && depthOk && scoreOk) {
    return {
      ok: true,
      title: "Liquiditeit goed",
      text: "Orderboek ziet er bruikbaar uit.",
      why: "Spread, depth en OB score zijn sterk genoeg.",
      tone: "ok",
      details: [
        ["Spread", hasSpread ? `${safe(spread, 3)}%` : "—"],
        ["Depth 1%", hasDepth ? `$${Math.round(depth).toLocaleString()}` : "—"],
        ["OB score", hasScore ? safe(score, 5) : "—"],
      ],
    };
  }

  const reasons = [];
  if (!spreadOk) reasons.push("Spread is te hoog of ontbreekt");
  if (!depthOk) reasons.push("Depth is te laag of ontbreekt");
  if (!scoreOk) reasons.push("OB score is te zwak of ontbreekt");

  return {
    ok: false,
    title: "Voorzichtig met liquiditeit",
    text: "Deze coin kan slippen of een zwak orderboek hebben.",
    why: reasons.join(" • "),
    tone: "warn",
    details: [
      ["Spread", hasSpread ? `${safe(spread, 3)}%` : "—"],
      ["Depth 1%", hasDepth ? `$${Math.round(depth).toLocaleString()}` : "—"],
      ["OB score", hasScore ? safe(score, 5) : "—"],
    ],
  };
}

function openModalMain(c) {
  showModal(true);
  setTab("Action");
  syncTopbarHeight();

  const stage = upperStage(c.stage);

  el("mTitle").textContent = `${c.symbol} • ${MODE.toUpperCase()} • ${stage || "—"}`;
  el("mSub").textContent =
    `Price $${safe(c.price, 6)} • Chg1h ${fmtPct(c.change1h)} • Chg24 ${fmtPct(c.change24)} • VM ${safe(c.vm, 2)} • Score ${scoreValue(c)}/100`;

  const act = actionForStage(c);
  el("mActionTitle").textContent = act.label;
  el("mActionSub").textContent = act.sub;

  const risk = getRisk(c, MODE);
  const entryPx = Number(c?.price || 0);

  if (risk && entryPx > 0) {
    const isBear = String(MODE).toLowerCase() === "bear";

    let slPct = ((risk.sl - entryPx) / entryPx) * 100;
    let tpPct = ((risk.tp - entryPx) / entryPx) * 100;

    if (isBear) {
      slPct = -slPct;
      tpPct = -tpPct;
    }

    setKV(el("mActionKv"), [
      ["Plan", act.label],
      ["Stage", stage || "—"],
      ["Entry", `$${safe(entryPx, 6)}`],
      ["SL", `$${safe(risk.sl, 6)} (${pct(slPct, 2)})`],
      ["TP", `$${safe(risk.tp, 6)} (${pct(tpPct, 2)})`],
      ["R:R", risk.rr ? safe(risk.rr, 2) : "—"],
      ["Bron SL/TP", risk.source === "backend" ? "Systeem (exact)" : "Fallback"],
    ]);
  } else {
    setKV(el("mActionKv"), [
      ["Plan", "—"],
      ["Entry", "—"],
      ["SL", "—"],
      ["TP", "—"],
    ]);
  }

  const whyList = el("mWhyList");
  if (whyList) whyList.innerHTML = "";

  addCheck(whyList, true, `Stage: ${stage || "—"}`, `Mode: ${MODE.toUpperCase()}`);
  addCheck(
    whyList,
    scoreValue(c) >= 72,
    "Entry quality / confidence",
    `Score: ${scoreValue(c)}/100`,
    scoreValue(c) >= 72 ? "ok" : "warn"
  );
  addCheck(
    whyList,
    Number(c?.vm || 0) >= 0.20,
    "Volume / MarketCap",
    `VM: ${safe(c.vm, 3)}`,
    Number(c?.vm || 0) >= 0.20 ? "ok" : "warn"
  );

  if (c?.breakout && typeof c.breakout === "object") {
    addCheck(
      whyList,
      !!c.breakout.ready,
      "Breakout ready",
      `pressure: ${safe(c.breakout.pressure, 2)} • breakoutPct: ${safe(c.breakout.breakoutPct, 2)}%`,
      c.breakout.ready ? "ok" : "warn"
    );
  }

  if (stage === "ELITE_EXPANSION") {
    addCheck(whyList, true, "Waarom ENTRY", "Explosieve fase is actief.", "ok");
  } else if (stage === "ELITE_IGNITION") {
    addCheck(whyList, true, "Waarom ENTRY", "Sterke kans op directe move.", "ok");
  } else if (stage === "ALMOST") {
    addCheck(whyList, false, "Waarom nog niet entry", "Mist nog 1 laatste upgrade-check.", "warn");
  } else if (stage === "BUILDUP") {
    addCheck(whyList, false, "Waarom nog niet almost", "Momentum bouwt op, maar nog niet scherp genoeg.", "warn");
  } else {
    addCheck(whyList, false, "Waarom nog niet buildup", "Nog te vroeg of te veel ruis.", "warn");
  }

  const liqList = el("mLiqList");
  if (liqList) liqList.innerHTML = "";

  const liq = liquiditySummary(c);
  addCheck(liqList, liq.ok, liq.title, liq.text, liq.tone === "ok" ? "ok" : "warn");
  addCheck(liqList, liq.ok, "Waarom", liq.why || "—", liq.tone === "ok" ? "ok" : "warn");
  if (Array.isArray(liq.details)) {
    for (const [k, v] of liq.details) {
      addCheck(liqList, true, k, v, "ok");
    }
  }

  el("mDebug").textContent = JSON.stringify(c, null, 2);
}

el("modeBull")?.addEventListener("click", () => setMode("bull"));
el("modeBear")?.addEventListener("click", () => setMode("bear"));

setMode(MODE);
setTimeout(() => loadLatest(true), 1200);
setInterval(() => loadLatest(false), 60 * 1000);