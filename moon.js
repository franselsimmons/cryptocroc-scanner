// ==================== moon.js ====================
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
  latest: (mode, bust = "") =>
    `/api/moon/public-latest?mode=${encodeURIComponent(mode)}${bust ? `&_=${encodeURIComponent(bust)}` : ""}`,
};

let MODE =
  new URLSearchParams(location.search).get("mode") ||
  localStorage.getItem("MOON_MODE") ||
  "bull";

const lastTsByMode = { bull: 0, bear: 0 };
let isLoading = false;
let refreshTimer = null;

function setMode(mode) {
  MODE = mode === "bear" ? "bear" : "bull";
  localStorage.setItem("MOON_MODE", MODE);

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

function esc(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function uniqBySymbol(list) {
  const seen = new Set();
  const out = [];

  for (const item of arr(list)) {
    const key = String(item?.symbol || item?.id || "").toUpperCase();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

// scannedAt heeft voorrang
function getSnapshotTs(data) {
  return Number(data?.scannedAt || data?.ts || 0);
}

function getAgeMinutes(ts) {
  const x = Number(ts || 0);
  if (!(x > 0)) return null;
  return Math.max(0, Math.floor((Date.now() - x) / 60000));
}

function staleLabel(ts) {
  const mins = getAgeMinutes(ts);
  if (mins == null) return "snapshot-tijd onbekend";
  if (mins < 5) return `live • ${mins} min oud`;
  if (mins < 60) return `${mins} min oud`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}u ${m}m oud`;
}

/**
 * Funnel mapping:
 * backend kan verschillende keys uitsturen.
 * UI houdt het stabiel op:
 * - tradeReady
 * - almost
 * - buildup
 * - radar
 *
 * Fallbacks:
 * - gebruikt ook candidates.tradeReady / watch / scannerOnly
 * - ondersteunt legacy elite_* keys
 */
function normalizeMoonFunnel(data) {
  const funnel = data?.funnel || {};
  const candidates = data?.candidates || {};

  const tradeReady = uniqBySymbol([
    ...arr(funnel.trade_ready),
    ...arr(funnel.entry),
    ...arr(funnel.tradeReady),
    ...arr(funnel.elite_expansion),
    ...arr(funnel.elite_ignition),
    ...arr(funnel.elite_cascade),
    ...arr(candidates.tradeReady),
    ...arr(funnel.hold),
  ]);

  const almost = uniqBySymbol(
    arr(funnel.almost).length
      ? arr(funnel.almost)
      : arr(candidates.watch).filter((c) => upperStage(c?.stage) === "ALMOST")
  );

  const buildup = uniqBySymbol(
    arr(funnel.buildup).length
      ? arr(funnel.buildup)
      : arr(candidates.watch).filter((c) => upperStage(c?.stage) === "BUILDUP")
  );

  const radar = uniqBySymbol(
    arr(funnel.radar).length
      ? arr(funnel.radar)
      : arr(candidates.scannerOnly).filter((c) => upperStage(c?.stage) === "RADAR")
  );

  return {
    radar,
    buildup,
    almost,
    tradeReady,
  };
}

function stageReasonText(stage) {
  const s = upperStage(stage);

  if (s === "ENTRY") return "TRADE READY: entry-ready signaal (beste kwaliteit).";
  if (s === "TRADE_READY") return "TRADE READY: entry-ready signaal (beste kwaliteit).";

  if (s === "ELITE_EXPANSION" || s === "ELITE_IGNITION" || s === "ELITE_CASCADE") {
    return "TRADE READY (legacy): elite signaal, hoog momentum.";
  }

  if (s === "HOLD") return "TRADE READY (hold): coin blijft zichtbaar door lock/open positie.";
  if (s === "ALMOST") return "ALMOST: bijna klaar — mist nog 1–2 checks.";
  if (s === "BUILDUP") return "BUILDUP: opbouwfase — momentum en volume lopen op.";
  if (s === "RADAR") return "RADAR: vroege selectie — vooral volgen.";

  return "Vroeg signaal — volgen, nog veel ruis.";
}

function computeFallbackRisk(c, mode) {
  const price = Number(c?.price || 0);
  if (!(price > 0)) return null;

  const ch24 = Math.abs(Number(c?.change24 || 0));
  let proxyPct = Math.max(2.2, Math.min(12.0, ch24 / 2.2 || 3.2));
  const proxy = proxyPct / 100;

  const isBull = String(mode || "bull").toLowerCase() === "bull";
  const sl = isBull ? price * (1 - proxy) : price * (1 + proxy);
  const tp = isBull ? price * (1 + proxy * 2.4) : price * (1 - proxy * 2.4);
  const rr = Math.abs((tp - price) / (price - sl || 1e-9));

  return { atrPct: proxyPct, sl, tp, rr, source: "fallback" };
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
  if (Number.isFinite(Number(c?.moveScore))) return Math.round(Number(c.moveScore));
  if (Number.isFinite(Number(c?.entryQuality))) return Math.round(Number(c.entryQuality));
  if (Number.isFinite(Number(c?.confidence))) {
    const v = Number(c.confidence);
    return v <= 1 ? Math.round(v * 100) : Math.round(v);
  }
  return 0;
}

function actionForStage(c, data) {
  const stage = upperStage(c?.stage);
  const btcState = upperStage(data?.btc?.state || "NEUTRAL");

  if (stage === "ENTRY" || stage === "TRADE_READY") {
    return { label: "TRADE READY", sub: `Entry-ready signaal. BTC is ${btcState}.`, tone: "ok" };
  }
  if (stage === "ALMOST") {
    return { label: "KLAARZETTEN", sub: `Bijna klaar, mist nog 1–2 checks. BTC is ${btcState}.`, tone: "warn" };
  }
  if (stage === "BUILDUP") {
    return { label: "WATCHLIST", sub: "Opbouwfase. Nog niet blind instappen, wel strak volgen.", tone: "warn" };
  }
  if (stage === "RADAR") {
    return { label: "SKIP / VOLGEN", sub: "Te vroeg voor actie. Alleen watchlist.", tone: "no" };
  }
  if (stage.startsWith("ELITE_") || stage === "HOLD") {
    return { label: "TRADE READY", sub: `Elite/hold signaal. BTC is ${btcState}.`, tone: "ok" };
  }

  return { label: "SKIP / VOLGEN", sub: "Te vroeg voor actie. Alleen watchlist.", tone: "no" };
}

function confColor(conf) {
  const c = Number(conf) || 0;
  if (c < 40) return "#EF4444";
  if (c < 60) return "#F59E0B";
  if (c < 80) return "#3B82F6";
  return "#22C55E";
}

function confBar(conf) {
  const pctV = Math.max(0, Math.min(100, Number(conf) || 0));
  const col = confColor(pctV);
  return `
    <div class="confWrap">
      <div class="confBar"><div class="confFill" style="width:${pctV}%;background:${col}"></div></div>
      <div class="confTxt">${pctV}/100</div>
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
        <div class="sym">${esc(c.symbol || "—")}</div>
        <div class="tag">${esc(c.name || "")}</div>
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

    <div class="tag" style="margin-top:6px;">${esc(stageReasonText(c?.stage))}</div>
  `;

  div.addEventListener("click", () => openModalMain(c));
  return div;
}

function renderStage(targetId, items, renderer = coinRow) {
  const box = el(targetId);
  if (!box) return;

  box.innerHTML = "";
  const list = Array.isArray(items) ? items : [];

  if (list.length === 0) {
    box.innerHTML = `<div class="empty">Geen coins.</div>`;
    return;
  }

  for (const x of list) box.appendChild(renderer(x));
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
  const stamp = ts ? new Date(ts).toLocaleString("nl-NL") : "—";
  const ageText = staleLabel(ts);
  const ageMin = getAgeMinutes(ts);
  const funnel = normalizeMoonFunnel(data);
  const universeCount = Number(data?.debug?.universeCount || 0);

  const statusLine = el("statusLine");
  if (statusLine) {
    let staleNote = "";
    if (ageMin != null && ageMin >= 30) staleNote = ` • WAARSCHUWING: snapshot oud (${ageText})`;
    else staleNote = ` • ${ageText}`;

    statusLine.textContent =
      `${btcLine(data.btc)} • Laatste update: ${stamp}${staleNote} • ` +
      `Universe ${universeCount} • ` +
      `TRADE READY ${funnel.tradeReady.length} • ALMOST ${funnel.almost.length} • ` +
      `BUILDUP ${funnel.buildup.length} • RADAR ${funnel.radar.length}` +
      ` • Whale flow ${Number(data?.whaleFlow || 0)}`;
  }

  renderStage("stageTradeReady", funnel.tradeReady);
  renderStage("stageAlmost", funnel.almost);
  renderStage("stageBuildup", funnel.buildup);
  renderStage("stageRadar", funnel.radar);
}

async function loadLatest(force = false) {
  if (isLoading && !force) return;
  isLoading = true;

  try {
    const sl = el("statusLine");
    if (sl && force) sl.textContent = "Status: laden…";

    const bust = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const url = API.latest(MODE, bust);

    const r = await fetch(url, {
      cache: "no-store",
      headers: {
        "cache-control": "no-cache, no-store, max-age=0, must-revalidate",
        pragma: "no-cache",
        expires: "0",
      },
    });

    const text = await r.text();
    let j;

    try {
      j = JSON.parse(text);
    } catch {
      throw new Error(`Ongeldige JSON: ${text.slice(0, 180)}`);
    }

    if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);

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

    renderStage("stageTradeReady", []);
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
      <div><b>${esc(title)}</b></div>
      ${sub ? `<div class="checkSmall">${esc(sub)}</div>` : ""}
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
    r.innerHTML = `<div class="kvKey">${esc(k)}</div><div class="kvVal">${v}</div>`;
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
      text: "Er is geen bruikbare orderboek-data voor deze coin.",
      why: "Deze coin heeft nu geen bruikbare OB snapshot.",
      tone: "warn",
      details: [],
    };
  }

  const spreadOk = hasSpread ? spread <= 1.0 : false;
  const depthOk = hasDepth ? depth >= 5000 : false;
  const scoreOk = hasScore ? Math.abs(score) >= 0.04 : false;

  if (spreadOk && depthOk && scoreOk) {
    return {
      ok: true,
      title: "Liquiditeit goed",
      text: "Orderboek ziet er bruikbaar uit voor Moon.",
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
    text: "Deze coin kan slippen of zwak orderboek hebben.",
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

  const act = actionForStage(c, window.__LAST_DATA__ || {});
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
      ["Moon probability", Number.isFinite(Number(c?.moonProbability)) ? `${safe(Number(c.moonProbability) * 100, 1)}%` : "—"],
      ["Dump probability", Number.isFinite(Number(c?.dumpProbability)) ? `${safe(Number(c.dumpProbability) * 100, 1)}%` : "—"],
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
    scoreValue(c) >= 75,
    "Move score / confidence",
    `Score: ${scoreValue(c)}/100`,
    scoreValue(c) >= 75 ? "ok" : "warn"
  );
  addCheck(
    whyList,
    Number(c?.vm || 0) >= 0.3,
    "Volume / MarketCap",
    `VM: ${safe(c.vm, 3)}`,
    Number(c?.vm || 0) >= 0.3 ? "ok" : "warn"
  );
  addCheck(
    whyList,
    Math.abs(Number(c?.change1h || 0)) >= 1,
    "Momentum 1h",
    `chg1h: ${fmtPct(c.change1h)}`,
    Math.abs(Number(c?.change1h || 0)) >= 1 ? "ok" : "warn"
  );
  addCheck(
    whyList,
    Math.abs(Number(c?.change24 || 0)) >= 6,
    "Momentum 24h",
    `chg24: ${fmtPct(c.change24)}`,
    Math.abs(Number(c?.change24 || 0)) >= 6 ? "ok" : "warn"
  );

  if (c?.compression && typeof c.compression === "object") {
    addCheck(
      whyList,
      !!c.compression.isCompressed,
      "Compressie",
      `flatPct: ${safe(c.compression.flatPct, 2)}%`,
      c.compression.isCompressed ? "ok" : "warn"
    );
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

function scheduleRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => loadLatest(false), 60 * 1000);
}

el("modeBull")?.addEventListener("click", () => setMode("bull"));
el("modeBear")?.addEventListener("click", () => setMode("bear"));

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") loadLatest(true);
});

window.addEventListener("focus", () => {
  loadLatest(true);
});

setMode(MODE);
setTimeout(() => loadLatest(true), 1200);
scheduleRefresh();