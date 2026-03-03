/* /public/app.js
   ✅ Retail-friendly UI
   - Altijd TP/SL tonen (fallback als backend ze niet meestuurt)
   - Liquidity tab: simpele “GO / WACHT / NIET DOEN” uitleg + reden waarom info ontbreekt
   - Action tab: duidelijk wat klant moet doen + plan met Entry/SL/TP/RR
*/

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
  ob: (mode, symbol) =>
    `/api/orderbook?side=${encodeURIComponent(mode)}&symbol=${encodeURIComponent(symbol)}`,
};

let MODE =
  new URLSearchParams(location.search).get("mode") ||
  localStorage.getItem("MODE") ||
  "bull";

// per mode onthouden welke snapshot we al hebben gerenderd
const lastTsByMode = { bull: 0, bear: 0 };

function setMode(mode) {
  MODE = mode;
  localStorage.setItem("MODE", mode);

  const url = new URL(location.href);
  url.searchParams.set("mode", mode);
  history.replaceState({}, "", url.toString());

  el("modeBull")?.classList.toggle("active", mode === "bull");
  el("modeBear")?.classList.toggle("active", mode === "bear");

  loadLatest(); // mode switch => meteen snapshot ophalen
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

// ==================== Risk (altijd SL/TP) ====================
// Altijd TP/SL kunnen tonen (fallback)
function computeFallbackRisk(c, mode) {
  const price = Number(c?.price || 0);
  if (!(price > 0)) return null;

  const rangePct = Math.max(0, Number(c?.range24 || 0));
  // ATR-proxy: range24/4, begrensd tussen 1.2% en 6.5%
  let atrPct = Math.max(1.2, Math.min(6.5, rangePct / 4)); // percentage
  const atr = atrPct / 100; // fractie
  const isBull = String(mode || "bull").toLowerCase() === "bull";

  const sl = isBull ? price * (1 - 1.2 * atr) : price * (1 + 1.2 * atr);
  const tp = isBull ? price * (1 + 2.2 * atr) : price * (1 - 2.2 * atr);

  const rr = Math.abs((tp - price) / (price - sl || 1e-9));
  return { atrPct, sl, tp, rr, source: "fallback" };
}

// pak risico uit backend als aanwezig, anders fallback
function getRisk(c, mode) {
  const price = Number(c?.price || 0);
  const hasBackend =
    Number.isFinite(Number(c?.sl)) &&
    Number.isFinite(Number(c?.tp)) &&
    Number(c?.sl) !== 0 &&
    Number(c?.tp) !== 0;

  if (hasBackend) {
    const sl = Number(c.sl);
    const tp = Number(c.tp);

    // atrPct kan bij jou fractie zijn (c.atrPct), daarom defensief:
    let atrPct = null;
    if (Number.isFinite(Number(c?.atrPct))) {
      // als atrPct < 1 aannemen fractie, anders al percentage
      const v = Number(c.atrPct);
      atrPct = v < 1 ? v * 100 : v;
    }

    const rr = price > 0 ? Math.abs((tp - price) / (price - sl || 1e-9)) : null;

    return {
      atrPct: atrPct ?? null,
      sl,
      tp,
      rr: rr ?? null,
      source: "backend",
    };
  }

  return computeFallbackRisk(c, mode);
}

// ==================== Action label ====================
function actionForStage(c, data) {
  const stage = String(c?.stage || "").toUpperCase();
  const btcState = String(data?.btc?.state || "NEUTRAL").toUpperCase();
  const cap = !!data?.cap?.cap;

  if (cap && (stage === "ALMOST" || stage === "ENTRY")) {
    return { label: "WACHTEN", sub: `BTC is ${btcState} → systeem laat nu geen ENTRY toe`, tone: "warn" };
  }

  if (stage === "ENTRY") return { label: "INSTAPPEN", sub: "Alle checks zijn groen", tone: "ok" };
  if (stage === "ALMOST") return { label: "KLAARZETTEN", sub: "Bijna klaar, mist nog 1–2 checks", tone: "warn" };
  if (stage === "BUILDUP") return { label: "WATCHLIST", sub: "Interessant, maar nog niet bevestigd", tone: "warn" };
  return { label: "SKIP", sub: "Te vroeg / te noisy", tone: "no" };
}

// ==================== Confidence UI ====================
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

// sizing advies (indien aanwezig)
function sizingText(c) {
  const s = c?.sizing || null;
  if (!s) return "";
  const pctVal = Number.isFinite(Number(s.pct)) ? Number(s.pct) : null;
  const zone = String(s.zone || "").trim();
  if (pctVal === null) return "";
  return `Advies ${pctVal}%${zone ? ` (BTC ${zone})` : ""}`;
}

// ==================== Pills ====================
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

function tradePillFromSellRow(s) {
  const sym = s?.symbol || "—";
  const reason = s?.reason ? ` • ${s.reason}` : "";
  const pnl = Number.isFinite(Number(s?.pnlPct))
    ? ` • pnl ${fmtPct(Number(s.pnlPct) * 100)}`
    : "";
  return `<div class="pill pillSell">SELL ${sym}${reason}${pnl}</div>`;
}

// ==================== Coin row ====================
function coinRow(c) {
  const div = document.createElement("div");
  div.className = "coinRow";

  const adv = sizingText(c);
  const scans =
    Number.isFinite(Number(c.stageScans)) ? Number(c.stageScans) :
    Number.isFinite(Number(c?.consistency?.total)) ? Number(c.consistency.total) :
    0;

  const tPill = tradePillFromCoin(c);
  const rightPill = tPill ? tPill : (adv ? `<div class="pill pillAdv">${adv}</div>` : "");

  // korte reden waarom nog niet entry
  const reason =
    (c?.gates?.entry && c.gates.entry !== "passed" && c.gates.entry !== "n/a") ? `Waarom geen ENTRY: ${c.gates.entry}` :
    (c?.gates?.almost && c.gates.almost !== "passed" && c.gates.almost !== "n/a") ? `Waarom geen ALMOST: ${c.gates.almost}` :
    "";

  const risk = getRisk(c, MODE);
  const slTxt = risk ? `$${safe(risk.sl, 6)}` : "—";
  const tpTxt = risk ? `$${safe(risk.tp, 6)}` : "—";

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
      <span>SL: ${slTxt}</span>
      <span>TP: ${tpTxt}</span>
    </div>

    ${reason ? `<div class="tag" style="margin-top:6px;">${reason}</div>` : ""}
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

// ==================== top status line ====================
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
  // bewaar voor modal action-tab
  window.__LAST_DATA__ = data;

  const ts = data?.ts ? new Date(data.ts) : null;
  const stamp = ts ? ts.toLocaleString() : "—";

  const hold = pickHold(data);
  const sell = pickSellFromLog(data);

  const counts = data?.meta?.counts || data?.counts || {};

  const statusLine = el("statusLine");
  if (statusLine) {
    statusLine.textContent =
      `${btcLine(data.btc)} • Laatste update: ${stamp} • ` +
      `ENTRY ${counts.entry || 0} • HOLD ${hold.length} • SELL ${sell.length} • ` +
      `ALMOST ${counts.almost || 0} • BUILDUP ${counts.buildup || 0} • RADAR ${counts.radar || 0}`;
  }

  renderStage("stageEntry", data?.funnel?.entry || [], coinRow);
  renderStage("stageHold", hold, coinRow);
  renderStage("stageSell", sell, sellRow);

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

    const ts = Number(j?.ts || 0);
    if (ts && ts === (lastTsByMode[MODE] || 0)) return;
    if (ts) lastTsByMode[MODE] = ts;

    renderAll(j || {});
  } catch {
    const statusLine = el("statusLine");
    if (statusLine) statusLine.textContent = "Status: fout bij laden (check Vercel logs)";
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

// ==================== Retail-friendly liquidity summary ====================
// Belangrijk: altijd vertellen WAAROM info ontbreekt (missing_snapshot / stale / validating / fetch error)
function explainNoOb(j) {
  const reason = String(j?.reason || "").trim();

  if (j?.status === "validating") {
    return "We verzamelen nog orderboek-data. Probeer het zo nog eens.";
  }
  if (reason === "missing_snapshot") {
    return "Deze coin heeft nu geen betrouwbare orderboek-snapshot (exchange mapping / te weinig liquiditeit / rate limits).";
  }
  if (j?.stale) {
    return "Orderboek-data is te oud (stale). We willen alleen verse data gebruiken.";
  }
  if (reason) {
    return `Orderboek is niet bruikbaar: ${reason}.`;
  }
  return "Orderboek-data ontbreekt of kon niet worden opgehaald.";
}

function liquiditySummary(j, c) {
  // thresholds uit c.thr (server berekend)
  const reqSpread = Number(c?.thr?.spreadMaxPct ?? 0.95);
  const reqDepth = Number(c?.thr?.depthMinUsd1p ?? 45000);
  const reqScore = Number(c?.thr?.obScoreMin ?? 0.05);

  // validating/geen object
  if (!j || j.status === "validating") {
    return {
      ok: false,
      title: "Liquiditeit wordt gecontroleerd",
      text: "Nog geen orderboek data beschikbaar. Even wachten.",
      why: explainNoOb(j),
      tone: "warn",
      details: [],
    };
  }

  // hard fail: geen bruikbare snapshot
  if (!j.valid || j.stale || String(j.reason || "") === "missing_snapshot") {
    return {
      ok: false,
      title: "Niet instappen (geen betrouwbare liquiditeit)",
      text: "We kunnen deze coin nu niet veilig traden omdat het orderboek ontbreekt of te oud is.",
      why: explainNoOb(j),
      tone: "no",
      details: [
        ["Max spread", `${safe(reqSpread, 3)}%`],
        ["Min depth 1%", `$${Math.round(reqDepth).toLocaleString()}`],
        ["Min OB score", `${safe(reqScore, 5)}`],
      ],
    };
  }

  // metric checks
  const spread = Number(j.ob?.spreadPct);
  const depth = Number(j.ob?.depthMinUsd1p);
  const score = Number(j.ob?.score);

  const spreadOk = Number.isFinite(spread) ? spread <= reqSpread : false;
  const depthOk = Number.isFinite(depth) ? depth >= reqDepth : false;
  const scoreOk = Number.isFinite(score) ? Math.abs(score) >= reqScore : false;

  // score/spreaddata kan soms ontbreken -> uitleggen
  const missingParts = [];
  if (!Number.isFinite(spread)) missingParts.push("spread");
  if (!Number.isFinite(depth)) missingParts.push("depth");
  if (!Number.isFinite(score)) missingParts.push("score");

  if (missingParts.length) {
    return {
      ok: false,
      title: "Wachten (onvolledige orderboek-info)",
      text: "We missen belangrijke liquiditeitsdata. Instappen is nu niet veilig.",
      why: `Ontbreekt: ${missingParts.join(", ")}.`,
      tone: "warn",
      details: [
        ["Spread", "—"],
        ["Depth 1%", "—"],
        ["OB score", "—"],
      ],
    };
  }

  if (!spreadOk || !depthOk || !scoreOk) {
    // simpele klant-uitleg wat het betekent
    const reasons = [];
    if (!spreadOk) reasons.push("Spread is te hoog → je koopt/verkopt slechter");
    if (!depthOk) reasons.push("Depth is te laag → prijs kan snel wegspringen");
    if (!scoreOk) reasons.push("OB druk is te zwak → signaal niet sterk genoeg");

    return {
      ok: false,
      title: "Voorzichtig (liquiditeit te zwak)",
      text: "Deze coin kan slecht vullen of slippen. Wacht liever op betere liquiditeit.",
      why: reasons.join(" • "),
      tone: "warn",
      details: [
        ["Spread", `${safe(spread, 2)}% (max ${safe(reqSpread, 3)}%)`],
        ["Depth 1%", `$${Math.round(depth).toLocaleString()} (min $${Math.round(reqDepth).toLocaleString()})`],
        ["OB score", `${safe(score, 5)} (min ${safe(reqScore, 5)})`],
      ],
    };
  }

  return {
    ok: true,
    title: "Liquiditeit goed (instappen kan)",
    text: "Orderboek is gezond. Kans op goede fills is hoog.",
    why: "Alles binnen de limieten.",
    tone: "ok",
    details: [
      ["Spread", `${safe(spread, 2)}% (max ${safe(reqSpread, 3)}%)`],
      ["Depth 1%", `$${Math.round(depth).toLocaleString()} (min $${Math.round(reqDepth).toLocaleString()})`],
      ["OB score", `${safe(score, 5)} (min ${safe(reqScore, 5)})`],
    ],
  };
}

// ==================== modal main ====================
async function openModalMain(c) {
  showModal(true);
  setTab("Action");
  syncTopbarHeight();

  const t = c?.trade || null;
  const tradeState =
    t?.status === "OPEN" ? "HOLD" :
    t?.status === "CLOSED" ? "SELL" :
    c.stage;

  el("mTitle").textContent = `${c.symbol} • ${MODE.toUpperCase()} • ${tradeState}`;
  el("mSub").textContent =
    `Price $${safe(c.price, 6)} • Chg24 ${fmtPct(c.change24)} • Range24 ${fmtPct(c.range24)} • VM ${safe(c.vm, 2)} • Conf ${c.confidence}/100`;

  // -------- ACTION TAB --------
  const act = actionForStage(c, window.__LAST_DATA__ || {});
  el("mActionTitle").textContent = act.label;
  el("mActionSub").textContent = act.sub;

  const risk = getRisk(c, MODE);
  const entryPx = Number(c?.price || 0);

  if (risk && entryPx > 0) {
    const slPct = ((risk.sl - entryPx) / entryPx) * 100;
    const tpPct = ((risk.tp - entryPx) / entryPx) * 100;

    setKV(el("mActionKv"), [
      ["Plan", act.label === "INSTAPPEN" ? "Instappen volgens plan" : "Nog niet instappen, wel klaarzetten"],
      ["Entry", `$${safe(entryPx, 6)}`],
      ["SL", `$${safe(risk.sl, 6)} (${pct(slPct, 2)})`],
      ["TP", `$${safe(risk.tp, 6)} (${pct(tpPct, 2)})`],
      ["R:R", risk.rr ? safe(risk.rr, 2) : "—"],
      ["Bron SL/TP", risk.source === "backend" ? "Systeem (exact)" : "Fallback (range24 proxy)"],
      ["ATR proxy", risk.atrPct != null ? `${safe(risk.atrPct, 2)}%` : "—"],
    ]);
  } else {
    setKV(el("mActionKv"), [
      ["Plan", "—"],
      ["Entry", "—"],
      ["SL", "—"],
      ["TP", "—"],
    ]);
  }

  // -------- WHY TAB --------
  const whyList = el("mWhyList");
  if (whyList) whyList.innerHTML = "";

  const scans =
    Number.isFinite(Number(c.stageScans)) ? Number(c.stageScans) :
    Number.isFinite(Number(c?.consistency?.total)) ? Number(c.consistency.total) :
    0;

  const consRatio = Number(c?.consistency?.ratio || 0);
  const consOk = !!c?.consistency?.ok;
  const consSame = Number(c?.consistency?.same || 0);
  const consTotal = Number(c?.consistency?.total || 0);
  const consNeed = Number(c?.consistency?.need || 0);
  const consMinAgree = Number(c?.consistency?.minAgree || 0);

  addCheck(whyList, true, `Stage: ${c.stage}`, `scans: ${scans}`);
  addCheck(
    whyList,
    consOk,
    "Consistency",
    `Stabiel: ${(consRatio * 100).toFixed(0)}% (${consSame}/${consTotal}) • nodig ${consNeed} • minAgree ${consMinAgree}`,
    consOk ? "ok" : "warn"
  );

  addCheck(
    whyList,
    Number(c.confidence || 0) >= 70,
    "Confidence",
    `Score: ${c.confidence}/100`,
    Number(c.confidence || 0) >= 70 ? "ok" : "warn"
  );

  // duidelijke gate reden
  const eg = String(c?.gates?.entry || "");
  const ag = String(c?.gates?.almost || "");
  if (String(c.stage).toUpperCase() !== "ENTRY") {
    const reason =
      (eg && eg !== "passed" && eg !== "n/a") ? `Waarom geen ENTRY: ${eg}` :
      (ag && ag !== "passed" && ag !== "n/a") ? `Waarom geen ALMOST: ${ag}` :
      "Nog niet genoeg bevestiging.";
    addCheck(whyList, false, "Waarom nog niet instappen", reason, "warn");
  } else {
    addCheck(whyList, true, "Waarom instappen", "Alle gates zijn groen.", "ok");
  }

  // -------- LIQ TAB (simpel + reden) --------
  const liqList = el("mLiqList");
  if (liqList) liqList.innerHTML = "";
  addCheck(liqList, true, "Liquiditeit", "Laden…", "warn");

  try {
    const r = await fetch(API.ob(MODE, c.symbol), {
      cache: "no-store",
      headers: { "cache-control": "no-cache" },
    });

    if (!r.ok) {
      if (liqList) liqList.innerHTML = "";
      addCheck(liqList, false, "Liquiditeit niet beschikbaar", "Kon orderboek niet ophalen (server/exchange).", "warn");
      addCheck(liqList, false, "Waarom zie ik geen cijfers?", `${r.status} ${r.statusText}`, "warn");
    } else {
      const j = await r.json();
      if (liqList) liqList.innerHTML = "";

      const sum = liquiditySummary(j, c);

      // 1) hoofdregel: wat moet klant doen
      addCheck(
        liqList,
        sum.ok,
        sum.title,
        sum.text,
        sum.tone === "ok" ? "ok" : "warn"
      );

      // 2) waarom (altijd tonen)
      addCheck(
        liqList,
        sum.ok,
        "Waarom",
        sum.why || "—",
        sum.tone === "ok" ? "ok" : "warn"
      );

      // 3) detail (klein, maar duidelijk)
      if (Array.isArray(sum.details) && sum.details.length) {
        for (const [k, v] of sum.details) {
          addCheck(liqList, true, k, v, "ok");
        }
      }
    }
  } catch (e) {
    if (liqList) liqList.innerHTML = "";
    addCheck(liqList, false, "Liquiditeit niet beschikbaar", "Orderboek ophalen mislukt.", "warn");
    addCheck(liqList, false, "Waarom zie ik geen cijfers?", String(e?.message || e), "warn");
  }

  // -------- DEBUG TAB --------
  el("mDebug").textContent = JSON.stringify(c, null, 2);
}

// ==================== init ====================
el("modeBull")?.addEventListener("click", () => setMode("bull"));
el("modeBear")?.addEventListener("click", () => setMode("bear"));

setMode(MODE);

// Snapshot refresh: 1x per 30 minuten
setInterval(loadLatest, 30 * 60 * 1000);