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
  latest: (mode) => `/api/moon/public-latest?mode=${encodeURIComponent(mode)}`,
};

let MODE =
  new URLSearchParams(location.search).get("mode") ||
  localStorage.getItem("MOON_MODE") ||
  "bull";

const lastTsByMode = { bull: 0, bear: 0 };
let isLoading = false;

// ==================== mode ====================
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

// ==================== format helpers ====================
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

// ==================== risk ====================
function computeFallbackRisk(c, mode) {
  const price = Number(c?.price || 0);
  if (!(price > 0)) return null;

  const ch24 = Math.abs(Number(c?.change24 || 0));
  const proxyPct = Math.max(2.2, Math.min(8.0, ch24 / 3 || 2.8));
  const proxy = proxyPct / 100;

  const isBull = String(mode || "bull").toLowerCase() === "bull";

  const sl = isBull ? price * (1 - proxy) : price * (1 + proxy);
  const tp = isBull ? price * (1 + proxy * 2.2) : price * (1 - proxy * 2.2);
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

// ==================== action label ====================
function actionForStage(c, data) {
  const stage = String(c?.stage || "").toUpperCase();
  const btcState = String(data?.btc?.state || "NEUTRAL").toUpperCase();

  if (stage === "ELITE") {
    return {
      label: "FOCUS / MOGELIJKE ENTRY",
      sub: `Top Moon setup. BTC is ${btcState}.`,
      tone: "ok",
    };
  }
  if (stage === "ALMOST") {
    return {
      label: "KLAARZETTEN",
      sub: `Bijna klaar, mist nog 1–2 checks. BTC is ${btcState}.`,
      tone: "warn",
    };
  }
  if (stage === "BUILDUP") {
    return {
      label: "WATCHLIST",
      sub: "Opbouwfase. Nog niet instappen, wel volgen.",
      tone: "warn",
    };
  }
  return {
    label: "SKIP / VOLGEN",
    sub: "Te vroeg voor actie. Alleen watchlist.",
    tone: "no",
  };
}

// ==================== confidence ====================
function confColor(conf) {
  const c = Number(conf) || 0;
  if (c < 50) return "#EF4444";
  if (c < 70) return "#F59E0B";
  if (c < 85) return "#3B82F6";
  return "#22C55E";
}
function confBar(conf) {
  const pctVal = Math.max(0, Math.min(100, Number(conf) || 0));
  const col = confColor(pctVal);
  return `
    <div class="confWrap">
      <div class="confBar"><div class="confFill" style="width:${pctVal}%;background:${col}"></div></div>
      <div class="confTxt">${pctVal}/100</div>
    </div>
  `;
}
function scoreValue(c) {
  if (Number.isFinite(Number(c?.edgeScore))) return Math.round(Number(c.edgeScore));
  if (Number.isFinite(Number(c?.confidence))) {
    const v = Number(c.confidence);
    return v <= 1 ? Math.round(v * 100) : Math.round(v);
  }
  return 0;
}

// ==================== rows ====================
function coinRow(c) {
  const div = document.createElement("div");
  div.className = "coinRow";

  const conf = scoreValue(c);
  const risk = getRisk(c, MODE);
  const slTxt = risk ? `$${safe(risk.sl, 6)}` : "—";
  const tpTxt = risk ? `$${safe(risk.tp, 6)}` : "—";

  const stageReason =
    c?.stage === "ELITE" ? "Hoogste Moon-kwaliteit." :
    c?.stage === "ALMOST" ? "Bijna klaar voor upgrade." :
    c?.stage === "BUILDUP" ? "In opbouw, nog geen top-confirmatie." :
    "Vroeg signaal, vooral volgen.";

  div.innerHTML = `
    <div class="coinTop">
      <div>
        <div class="sym">${c.symbol || "—"}</div>
        <div class="tag">${c.name || ""}</div>
      </div>
      ${confBar(conf)}
    </div>

    <div class="coinMeta">
      <span>chg24: ${fmtPct(c.change24)}</span>
      <span>vol: $${fmtUSD(c.volume)}</span>
      <span>mc: $${fmtUSD(c.marketCap)}</span>
      <span>vm: ${fmt(c.vm)}</span>
      <span>price: $${safe(c.price, 6)}</span>
      <span>SL: ${slTxt}</span>
      <span>TP: ${tpTxt}</span>
    </div>

    <div class="tag" style="margin-top:6px;">${stageReason}</div>
  `;

  div.addEventListener("click", () => openModalMain(c));
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

// ==================== status line ====================
function btcLine(btc) {
  if (!btc) return "BTC: —";
  const state = btc.state || "—";
  const chg24 = Number.isFinite(Number(btc.chg24)) ? ` | chg24 ${fmtPct(btc.chg24)}` : "";
  const range24 = Number.isFinite(Number(btc.range24)) ? ` | range24 ${fmtPct(btc.range24)}` : "";
  return `BTC: ${state}${chg24}${range24}`;
}

function renderAll(data) {
  window.__LAST_DATA__ = data;

  const ts = data?.ts ? new Date(data.ts) : null;
  const stamp = ts ? ts.toLocaleString() : "—";
  const counts = data?.counts || {};

  const statusLine = el("statusLine");
  if (statusLine) {
    statusLine.textContent =
      `${btcLine(data.btc)} • Laatste update: ${stamp} • ` +
      `ELITE ${counts.elite || 0} • ALMOST ${counts.almost || 0} • ` +
      `BUILDUP ${counts.buildup || 0} • RADAR ${counts.radar || 0}` +
      ` • Whale flow ${Number(data?.whaleFlow || 0)}`;
  }

  renderStage("stageElite", data?.funnel?.elite || []);
  renderStage("stageAlmost", data?.funnel?.almost || []);
  renderStage("stageBuildup", data?.funnel?.buildup || []);
  renderStage("stageRadar", data?.funnel?.radar || []);
}

// ==================== load latest ====================
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

    if (!r.ok || j?.ok === false) {
      throw new Error(j?.error || `HTTP ${r.status}`);
    }

    const data = j?.data || j;
    const ts = Number(data?.ts || 0);

    if (!force && ts && ts === (lastTsByMode[MODE] || 0)) {
      return;
    }

    if (ts) lastTsByMode[MODE] = ts;
    renderAll(data || {});
  } catch (e) {
    const statusLine = el("statusLine");
    if (statusLine) {
      statusLine.textContent = `Status: fout bij laden • ${String(e?.message || e)}`;
    }

    renderStage("stageElite", []);
    renderStage("stageAlmost", []);
    renderStage("stageBuildup", []);
    renderStage("stageRadar", []);
  } finally {
    isLoading = false;
  }
}

// ==================== modal helpers ====================
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
      text: "Er is geen bruikbare orderboek-data voor deze coin.",
      why: "Deze coin heeft nu geen bruikbare OB snapshot.",
      tone: "warn",
      details: [],
    };
  }

  const spreadOk = hasSpread ? spread <= 0.95 : false;
  const depthOk = hasDepth ? depth >= 45000 : false;
  const scoreOk = hasScore ? Math.abs(score) >= 0.05 : false;

  if (spreadOk && depthOk && scoreOk) {
    return {
      ok: true,
      title: "Liquiditeit goed",
      text: "Orderboek ziet er gezond uit.",
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
    text: "Deze coin kan slippen of slecht vullen.",
    why: reasons.join(" • "),
    tone: "warn",
    details: [
      ["Spread", hasSpread ? `${safe(spread, 3)}%` : "—"],
      ["Depth 1%", hasDepth ? `$${Math.round(depth).toLocaleString()}` : "—"],
      ["OB score", hasScore ? safe(score, 5) : "—"],
    ],
  };
}

// ==================== modal ====================
function openModalMain(c) {
  showModal(true);
  setTab("Action");
  syncTopbarHeight();

  el("mTitle").textContent = `${c.symbol} • ${MODE.toUpperCase()} • ${String(c.stage || "—").toUpperCase()}`;
  el("mSub").textContent =
    `Price $${safe(c.price, 6)} • Chg24 ${fmtPct(c.change24)} • VM ${safe(c.vm, 2)} • Conf ${scoreValue(c)}/100`;

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

  addCheck(whyList, true, `Stage: ${String(c.stage || "—").toUpperCase()}`, `Mode: ${MODE.toUpperCase()}`);
  addCheck(
    whyList,
    scoreValue(c) >= 70,
    "Confidence",
    `Score: ${scoreValue(c)}/100`,
    scoreValue(c) >= 70 ? "ok" : "warn"
  );
  addCheck(
    whyList,
    Number(c?.vm || 0) >= 0.15,
    "Volume / MarketCap",
    `VM: ${safe(c.vm, 3)}`,
    Number(c?.vm || 0) >= 0.15 ? "ok" : "warn"
  );
  addCheck(
    whyList,
    Number(c?.change24 || 0) > 0,
    "Momentum 24h",
    `chg24: ${fmtPct(c.change24)}`,
    Number(c?.change24 || 0) > 0 ? "ok" : "warn"
  );

  if (String(c.stage).toUpperCase() !== "ELITE") {
    addCheck(
      whyList,
      false,
      "Waarom nog niet hoger",
      c.stage === "ALMOST"
        ? "Mist nog 1 stap voor ELITE."
        : c.stage === "BUILDUP"
        ? "Nog niet genoeg bevestiging voor ALMOST."
        : "Nog te vroeg voor BUILDUP / ALMOST / ELITE.",
      "warn"
    );
  } else {
    addCheck(whyList, true, "Waarom ELITE", "Top score binnen Moon funnel.", "ok");
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

// ==================== init ====================
el("modeBull")?.addEventListener("click", () => setMode("bull"));
el("modeBear")?.addEventListener("click", () => setMode("bear"));

setMode(MODE);
setTimeout(() => loadLatest(true), 1500);
setInterval(() => loadLatest(false), 60 * 1000);