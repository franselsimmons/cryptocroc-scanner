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
function pct(n, d = 2) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  const s = x >= 0 ? "+" : "";
  return s + x.toFixed(d) + "%";
}

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

  return { atrPct, sl, tp, rr };
}

// Bepaal actie op basis van stage en BTC-cap
function actionForStage(c, data) {
  const stage = String(c?.stage || "").toUpperCase();
  const btcState = String(data?.btc?.state || "NEUTRAL").toUpperCase();
  const cap = !!data?.cap?.cap;

  if (cap && (stage === "ALMOST" || stage === "ENTRY")) {
    return { label: "WACHTEN", sub: `BTC is ${btcState} → max BUILDUP`, tone: "warn" };
  }

  if (stage === "ENTRY") return { label: "INSTAPPEN", sub: "Alle gates groen", tone: "ok" };
  if (stage === "ALMOST") return { label: "KLAARZETTEN", sub: "Mist nog 1–2 checks", tone: "warn" };
  if (stage === "BUILDUP") return { label: "WATCHLIST", sub: "Nog niet bevestigd, maar interessant", tone: "warn" };
  return { label: "SKIP/SCOUT", sub: "Te vroeg of te noisy", tone: "no" };
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

// sizing advies (indien aanwezig)
function sizingText(c) {
  const s = c?.sizing || null;
  if (!s) return "";
  const pct = Number.isFinite(Number(s.pct)) ? Number(s.pct) : null;
  const zone = String(s.zone || "").trim();
  if (pct === null) return "";
  return `Advies ${pct}%${zone ? ` (BTC ${zone})` : ""}`;
}

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

function coinRow(c) {
  const div = document.createElement("div");
  div.className = "coinRow";

  const adv = sizingText(c);
  // scans: gebruik c.stageScans als die bestaat, anders consistency.total
  const scans =
    Number.isFinite(Number(c.stageScans)) ? Number(c.stageScans) :
    Number.isFinite(Number(c?.consistency?.total)) ? Number(c.consistency.total) :
    0;
  const tPill = tradePillFromCoin(c);

  const rightPill = tPill
    ? tPill
    : adv
    ? `<div class="pill pillAdv">${adv}</div>`
    : "";

  // korte reden waarom nog niet in entry (alleen als die afwijkt)
  const reason =
    (c?.gates?.entry && c.gates.entry !== "passed" && c.gates.entry !== "n/a") ? `ENTRY: ${c.gates.entry}` :
    (c?.gates?.almost && c.gates.almost !== "passed" && c.gates.almost !== "n/a") ? `ALMOST: ${c.gates.almost}` :
    "";

  // fallback TP/SL voor in de rij
  const risk = (Number.isFinite(Number(c?.sl)) && Number.isFinite(Number(c?.tp)))
    ? { sl: c.sl, tp: c.tp }
    : computeFallbackRisk(c, MODE);
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

function btcLine(btc) {
  if (!btc) return "BTC: —";
  return `BTC: ${btc.state} | chg24 ${fmtPct(btc.chg24)} | range24 ${fmtPct(btc.range24)}`;
}

function leadersLine(leaders) {
  const arr = Array.isArray(leaders) ? leaders.slice(0, 6) : [];
  if (!arr.length) return "Leaders: —";
  return "Leaders: " + arr
    .map(x => `${x.symbol} ${fmtPct(x.change24)}`)
    .join(" • ");
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
  // bewaar voor actie-tab
  window.__LAST_DATA__ = data;

  const ts = data?.ts ? new Date(data.ts) : null;
  const stamp = ts ? ts.toLocaleString() : "—";

  const hold = pickHold(data);
  const sell = pickSellFromLog(data);

  // counts kunnen in data.meta.counts zitten, fallback naar data.counts
  const counts = data?.meta?.counts || data?.counts || {};

  const statusLine = el("statusLine");
  if (statusLine) {
    statusLine.textContent =
      `${btcLine(data.btc)} • ${leadersLine(data.leaders)} • Laatste update: ${stamp} • ` +
      `ENTRY ${counts.entry || 0} • HOLD ${hold.length} • SELL ${sell.length} • ` +
      `ALMOST ${counts.almost || 0} • BUILDUP ${counts.buildup || 0} • RADAR ${counts.radar || 0}`;
  }

  // Volgorde in UI: ENTRY -> HOLD -> SELL
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

    // Alleen renderen als snapshot ts écht veranderd is
    const ts = Number(j?.ts || 0);
    if (ts && ts === (lastTsByMode[MODE] || 0)) return;
    if (ts) lastTsByMode[MODE] = ts;

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

function safe(n, d = 2) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  return x.toFixed(d);
}

async function openModalMain(c) {
  showModal(true);
  setTab("Action"); // standaard actie-tab
  syncTopbarHeight();

  const t = c?.trade || null;
  const tradeState =
    t?.status === "OPEN" ? "HOLD" :
    t?.status === "CLOSED" ? "SELL" :
    c.stage;

  el("mTitle").textContent = `${c.symbol} • ${MODE.toUpperCase()} • ${tradeState}`;
  el("mSub").textContent =
    `Price $${safe(c.price, 6)} • Chg24 ${fmtPct(c.change24)} • Range24 ${fmtPct(c.range24)} • VM ${safe(c.vm, 2)} • Conf ${c.confidence}/100`;

  // ----- ACTIE TAB -----
  const act = actionForStage(c, window.__LAST_DATA__ || {});
  el("mActionTitle").textContent = act.label;
  el("mActionSub").textContent = act.sub;

  const risk = (Number.isFinite(Number(c?.sl)) && Number.isFinite(Number(c?.tp)))
    ? {
        atrPct: Number(c?.atrPct || 0) * 100, // c.atrPct is fractie -> percentage
        sl: Number(c.sl),
        tp: Number(c.tp)
      }
    : computeFallbackRisk(c, MODE);

  const entryPx = Number(c?.price || 0);

  if (risk) {
    // bereken rr als die niet direct beschikbaar is
    let rr = risk.rr;
    if (!rr && entryPx > 0 && risk.sl && risk.tp) {
      rr = Math.abs((risk.tp - entryPx) / (entryPx - risk.sl || 1e-9));
    }

    const slPct = entryPx ? ((risk.sl - entryPx) / entryPx) * 100 : null;
    const tpPct = entryPx ? ((risk.tp - entryPx) / entryPx) * 100 : null;

    setKV(el("mActionKv"), [
      ["Plan", act.label === "INSTAPPEN" ? "Market/limit entry" : "Alleen alert + klaarzetten"],
      ["Entry", `$${safe(entryPx, 6)}`],
      ["SL", `$${safe(risk.sl, 6)} (${pct(slPct, 2)})`],
      ["TP", `$${safe(risk.tp, 6)} (${pct(tpPct, 2)})`],
      ["ATR proxy", `${safe(risk.atrPct, 2)}%`],
      ["R:R", rr ? safe(rr, 2) : "—"],
    ]);
  } else {
    setKV(el("mActionKv"), [ ["Plan", "—"], ["Entry", "—"], ["SL", "—"], ["TP", "—"] ]);
  }

  // ----- WHY TAB -----
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

  // Consistency
  addCheck(
    whyList,
    consOk,
    "Consistency",
    `Ratio: ${(consRatio * 100).toFixed(0)}% (${consSame}/${consTotal}) • need ${consNeed} • minAgree ${consMinAgree}`,
    consOk ? "ok" : "warn"
  );

  // Confidence
  addCheck(
    whyList,
    Number(c.confidence || 0) >= 70,
    "Confidence",
    `Score: ${c.confidence}/100`,
    Number(c.confidence || 0) >= 70 ? "ok" : "warn"
  );

  // Entry gate (uit gates.entry)
  const eg = String(c?.gates?.entry || "");
  const egOk = /(passed|ok)/i.test(eg);
  addCheck(whyList, egOk, "Entry gate", eg || "—", egOk ? "ok" : "warn");

  // Volume acceleration (alleen als het veld bestaat)
  if (Number.isFinite(Number(c?.volAcc))) {
    addCheck(whyList, true, "Volume acceleration", `VolAcc: ${safe(c.volAcc, 2)}`);
  }

  // Anomaly (indien aanwezig)
  if (c?.anomalies?.length) {
    const msg = c.anomalies.map(a => `${a.type} x${a.factor}`).join(", ");
    addCheck(whyList, false, "Anomalies", msg, "warn");
  }

  // ----- LIQUIDITY TAB -----
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

        // thresholds uit c.thr
        const reqSpread = Number(c?.thr?.spreadMaxPct ?? 0.95);
        const reqDepth = Number(c?.thr?.depthMinUsd1p ?? 45000);
        const reqScore = Number(c?.thr?.obScoreMin ?? 0.05);

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

        // OB score check
        addCheck(
          liqList,
          Math.abs(Number(j.ob?.score || 0)) >= reqScore,
          "OB score",
          `score: ${safe(j.ob?.score, 5)} • min ${reqScore}`,
          "warn"
        );
      }
    }
  } catch {
    if (liqList) liqList.innerHTML = "";
    addCheck(liqList, false, "Orderbook", "OB ERROR: fetch mislukt", "warn");
  }

  // ----- DEBUG TAB -----
  el("mDebug").textContent = JSON.stringify(c, null, 2);
}

el("modeBull")?.addEventListener("click", () => setMode("bull"));
el("modeBear")?.addEventListener("click", () => setMode("bear"));

// init
setMode(MODE);

// Snapshot refresh: 1x per 30 minuten
setInterval(loadLatest, 30 * 60 * 1000);