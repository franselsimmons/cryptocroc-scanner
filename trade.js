// ==================== trade.js ====================
const el = (id) => document.getElementById(id);

const SOURCES = [
  { key: "main-bull", label: "Main Bull", systemType: "main", mode: "bull", url: "/api/latest?mode=bull" },
  { key: "main-bear", label: "Main Bear", systemType: "main", mode: "bear", url: "/api/latest?mode=bear" },
  { key: "moon-bull", label: "Moon Bull", systemType: "moon", mode: "bull", url: "/api/moon/public-latest?mode=bull" },
  { key: "moon-bear", label: "Moon Bear", systemType: "moon", mode: "bear", url: "/api/moon/public-latest?mode=bear" },
];

let LAST_ROWS = [];

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}
function safe(v, d = 2) {
  const x = Number(v);
  if (!Number.isFinite(x)) return "—";
  return x.toFixed(d);
}
function pct(v, d = 2) {
  const x = Number(v);
  if (!Number.isFinite(x)) return "—";
  const s = x >= 0 ? "+" : "";
  return s + x.toFixed(d) + "%";
}
function fmtUSD(v) {
  v = Number(v) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(2) + "K";
  return v.toFixed(0);
}
function up(x) {
  return String(x || "").toUpperCase();
}

// managedAt / ts / scannedAt fallback
function getTradeDeskTs(data) {
  return Number(data?.managedAt || data?.ts || data?.scannedAt || 0);
}

// --------------------
// Funnel normalizers
// --------------------
function arr(x) {
  return Array.isArray(x) ? x : [];
}

function normalizeScannerFunnel(funnel) {
  const f = funnel || {};

  // ✅ MAIN: entry is echt entryReady bucket
  const mainEntry = arr(f.entry);

  // optional newer key
  const tradeReady = arr(f.tradeReady);

  // MOON: elite buckets represent entry-like
  const eliteExpansion = arr(f.elite_expansion);
  const eliteIgnition = arr(f.elite_ignition);
  const moonEntryLike = eliteExpansion.concat(eliteIgnition);

  // choose best available "entry-like"
  const entryLike =
    mainEntry.length ? mainEntry :
    tradeReady.length ? tradeReady :
    moonEntryLike;

  return {
    entryLike,
    almost: arr(f.almost),
    buildup: arr(f.buildup),
    radar: arr(f.radar),
  };
}

function flattenForDesk(payload) {
  const f = normalizeScannerFunnel(payload?.funnel);

  return []
    .concat(f.entryLike)
    .concat(f.almost)
    .concat(f.buildup)
    .concat(f.radar);
}

// --------------------
// Scoring + tone
// --------------------
function scoreTone(score) {
  const s = Number(score) || 0;
  if (s >= 82) return "ok";
  if (s >= 68) return "warn";
  return "no";
}

function actionTone(action) {
  const a = up(action);
  if (a === "HOLD") return "ok";
  if (a === "WEAK_HOLD") return "soft";
  if (a === "ALLOW_ENTRY" || a === "PENDING_ENTRY" || a === "PARTIAL_EXIT") return "warn";
  if (a === "EXIT" || a === "CANCEL_ENTRY" || a === "NO_TRADE" || a === "IGNORE") return "no";
  return "warn";
}

function displayAction(action) {
  const a = up(action);
  if (!a) return "—";
  if (a === "ALLOW_ENTRY") return "OPEN";
  if (a === "PENDING_ENTRY") return "PENDING";
  if (a === "NO_TRADE") return "SKIP";
  if (a === "CANCEL_ENTRY") return "CANCEL";
  if (a === "PARTIAL_EXIT") return "TP1";
  if (a === "EXIT") return "EXIT";
  if (a === "WEAK_HOLD") return "WEAK HOLD";
  return a;
}

function getRowScore(coin) {
  const exScore = n(coin?.execution?.score, NaN);
  if (Number.isFinite(exScore)) return exScore;

  const pcs = n(coin?.perfectCandidateScore, NaN);
  if (Number.isFinite(pcs)) return pcs;

  const eq = n(coin?.entryQuality, NaN);
  if (Number.isFinite(eq)) return eq;

  const conf = n(coin?.confidence, NaN);
  if (Number.isFinite(conf)) return conf;

  return 0;
}

// --------------------
// Normalize rows
// --------------------
function normalizeRows(payload, source) {
  const all = flattenForDesk(payload);

  const openPositions = Array.isArray(payload?.positions?.openItems)
    ? payload.positions.openItems
    : [];

  const openSet = new Set(openPositions.map((p) => up(p?.symbol)));

  const unique = new Map();

  for (const coin of all) {
    if (!coin) continue;
    const symbol = up(coin.symbol);
    if (!symbol) continue;

    // trade desk = alleen als execution bestaat
    const ex = coin.execution || null;
    if (!ex) continue;

    const key = `${source.key}:${symbol}`;

    unique.set(key, {
      sourceKey: source.key,
      sourceLabel: source.label,
      systemType: source.systemType,
      mode: source.mode,
      btc: payload?.btc || null,
      regime: payload?.regime || "—",
      managedAt: payload?.managedAt || payload?.ts || payload?.scannedAt || 0,
      openPositions,
      isActuallyOpen: openSet.has(symbol),
      coin,
    });
  }

  return [...unique.values()];
}

// --------------------
// Row UI
// --------------------
function rowHtml(row) {
  const c = row.coin || {};
  const ex = c.execution || {};
  const meta = ex.meta || {};
  const plan = c.tradePlan || meta.tradePlan || {};

  const action = up(ex.action);
  const score = getRowScore(c);
  const tone = actionTone(action);

  const badgeText = row.isActuallyOpen ? "LIVE" : displayAction(action);
  const badgeTone = row.isActuallyOpen ? "ok" : tone;

  const side = ex.side || meta.side || "—";
  const stage = c.stage || meta.stage || "—";
  const reason = ex.reason || meta.reason || "—";
  const reasonCode = ex.reasonCode || meta.reasonCode || meta.exitReason || meta.reason || "—";

  const sizeUsd = ex.positionSizeUsd ?? meta.positionSizeUsd ?? "—";

  return `
    <div class="row" data-key="${row.sourceKey}:${c.symbol}">
      <div class="rowTop">
        <div>
          <div class="rowSym">${c.symbol} • ${side} • ${badgeText}</div>
          <div class="rowTag">
            ${row.sourceLabel}
            • stage ${stage}
            • regime ${row.regime || "—"}
          </div>
        </div>

        <div class="badges">
          <div class="badge ${badgeTone}">${badgeText}</div>
          <div class="badge ${scoreTone(score)}">score ${Math.round(score)}</div>
          <div class="badge">size $${sizeUsd}</div>
          ${meta.holdState ? `<div class="badge">${meta.holdState}</div>` : ""}
          ${meta.keepPinned ? `<div class="badge soft">PINNED</div>` : ""}
        </div>
      </div>

      <div class="rowMeta">
        <span>price $${safe(c.price, 6)}</span>
        <span>chg1h ${pct(c.change1h)}</span>
        <span>chg24 ${pct(c.change24)}</span>
        <span>range24 ${pct(c.range24)}</span>
        <span>vm ${safe(c.vm, 2)}</span>
        <span>mc $${fmtUSD(c.marketCap)}</span>
        <span>spread ${safe(c?.ob?.spreadPct, 3)}%</span>
        <span>depth $${Math.round(n(c?.ob?.depthMinUsd1p, 0)).toLocaleString()}</span>
        <span>EQ ${c.entryQuality ?? c.confidence ?? 0}</span>
        <span>PS ${c.persistenceScore ?? 0}</span>
        <span>SL $${safe(plan.sl, 6)}</span>
        <span>TP $${safe(plan.tp, 6)}</span>
        <span>cycles ${meta.cyclesInTrade ?? 0}</span>
        <span>weak ${meta.weakHoldCount ?? 0}</span>
      </div>

      <div class="rowReason">
        <strong>${row.isActuallyOpen ? "live_position" : reasonCode}</strong>
        •
        ${row.isActuallyOpen ? "Deze coin staat echt open in de positie-administratie" : reason}
      </div>
    </div>
  `;
}

function renderList(id, rows) {
  const box = el(id);
  if (!box) return;

  if (!rows.length) {
    box.innerHTML = `<div class="empty">Geen setups.</div>`;
    return;
  }

  box.innerHTML = rows.map(rowHtml).join("");
  box.querySelectorAll(".row").forEach((node) => {
    node.addEventListener("click", () => {
      const row = LAST_ROWS.find((x) => `${x.sourceKey}:${x.coin.symbol}` === node.dataset.key);
      if (row) openModal(row);
    });
  });
}

// --------------------
// Modal helpers
// --------------------
function setKV(container, rows) {
  if (!container) return;
  container.innerHTML = rows
    .map(([k, v]) => `<div class="kvRow"><div class="kvKey">${k}</div><div class="kvVal">${v}</div></div>`)
    .join("");
}

function renderChecks(container, checks) {
  if (!container) return;
  const list = Array.isArray(checks) ? checks : [];
  if (!list.length) {
    container.innerHTML = `<div class="empty">Geen checklist.</div>`;
    return;
  }

  container.innerHTML = list.map((c) => {
    return `
      <div class="checkItem">
        <div class="checkTitle">${c.ok ? "✓" : "✗"} ${c.name}</div>
        <div class="checkSub">waarde: ${c.value} • nodig: ${c.need}</div>
      </div>
    `;
  }).join("");
}

function openModal(row) {
  const c = row.coin || {};
  const ex = c.execution || {};
  const meta = ex.meta || {};
  const plan = c.tradePlan || meta.tradePlan || {};

  const action = up(ex.action);
  const showAction = row.isActuallyOpen ? "LIVE" : displayAction(action);

  el("mTitle").textContent = `${c.symbol} • ${row.sourceLabel} • ${showAction}`;
  el("mSub").textContent =
    `price $${safe(c.price, 6)} • side ${ex.side || meta.side || "—"} • stage ${c.stage || meta.stage || "—"} • score ${Math.round(getRowScore(c))}`;

  setKV(el("mPlan"), [
    ["System", row.sourceLabel],
    ["Action", showAction],
    ["Side", ex.side || meta.side || "—"],
    ["Position size", `$${ex.positionSizeUsd ?? meta.positionSizeUsd ?? "—"}`],
    ["Entry", `$${safe(plan.entry, 6)}`],
    ["SL", `$${safe(plan.sl, 6)}`],
    ["TP", `$${safe(plan.tp, 6)}`],
    ["RR", safe(plan.rr, 2)],
    ["Reason", ex.reason || meta.reason || "—"],
    ["Reason code", ex.reasonCode || meta.reasonCode || meta.exitReason || "—"],
  ]);

  setKV(el("mState"), [
    ["Actually open", row.isActuallyOpen ? "ja" : "nee"],
    ["Pinned entry", meta.keepPinned ? "ja" : "nee"],
    ["Ticket active", meta.entryTicketActive ? "ja" : "nee"],
    ["Ticket expires", meta.entryTicketExpiresAt ? new Date(meta.entryTicketExpiresAt).toLocaleString() : "—"],
    ["Hold state", meta.holdState || "—"],
    ["Cycles in trade", meta.cyclesInTrade ?? 0],
    ["Weak hold count", meta.weakHoldCount ?? 0],
    ["Breakout ready", meta.breakoutReady ? "ja" : "nee"],
    ["Breakout pressure", safe(meta.breakoutPressure, 1)],
    ["Spread", `${safe(meta.spreadPct, 3)}%`],
    ["Depth 1%", `$${Math.round(n(meta.depthUsd, 0)).toLocaleString()}`],
    ["OB score", safe(meta.obScore, 5)],
  ]);

  renderChecks(el("mChecks"), ex.checklist || []);

  el("mReason").textContent =
    `${ex.reasonCode || meta.reasonCode || meta.exitReason || "—"} • ${ex.reason || meta.reason || "—"}`;

  el("mDebug").textContent = JSON.stringify(row, null, 2);
  el("modal").classList.remove("hidden");
}

// --------------------
// Load / filter
// --------------------
async function loadAll() {
  const status = el("statusLine");
  if (status) status.textContent = "Status: laden…";

  const settled = await Promise.allSettled(
    SOURCES.map(async (src) => {
      const r = await fetch(src.url, {
        cache: "no-store",
        headers: { "cache-control": "no-cache" },
      });
      const txt = await r.text();
      let json;
      try {
        json = JSON.parse(txt);
      } catch {
        throw new Error(`${src.label}: ongeldige JSON`);
      }
      if (!r.ok) throw new Error(`${src.label}: HTTP ${r.status}`);
      return { src, json };
    })
  );

  const rows = [];
  const failed = [];
  let latestTs = 0;

  for (const item of settled) {
    if (item.status === "fulfilled") {
      const { src, json } = item.value;
      rows.push(...normalizeRows(json, src));
      const ts = getTradeDeskTs(json);
      if (ts > latestTs) latestTs = ts;
    } else {
      failed.push(String(item.reason?.message || item.reason));
    }
  }

  LAST_ROWS = rows;

  // LIVE = alleen echte open posities
  const live = rows
    .filter((r) => r.isActuallyOpen === true)
    .sort((a, b) => getRowScore(b.coin) - getRowScore(a.coin));

  // WATCHLIST / ENTRY candidates: niet open, maar engine zegt ALLOW_ENTRY of PENDING_ENTRY
  const watch = rows
    .filter((r) => {
      if (r.isActuallyOpen === true) return false;
      const a = up(r.coin?.execution?.action);
      return a === "ALLOW_ENTRY" || a === "PENDING_ENTRY";
    })
    .sort((a, b) => getRowScore(b.coin) - getRowScore(a.coin));

  // CLOSED/REJECTED
  const closed = rows
    .filter((r) => {
      if (r.isActuallyOpen === true) return false;
      const a = up(r.coin?.execution?.action);
      return a === "EXIT" || a === "CANCEL_ENTRY" || a === "NO_TRADE" || a === "IGNORE";
    })
    .sort((a, b) => (b.managedAt || 0) - (a.managedAt || 0))
    .slice(0, 25);

  renderList("tradeReadyList", live);
  renderList("watchList", watch);
  renderList("closedList", closed);

  if (status) {
    const stamp = latestTs ? new Date(latestTs).toLocaleString() : "—";
    status.textContent =
      `LIVE ${live.length} • WATCH ${watch.length} • CLOSED ${closed.length} • Laatste update: ${stamp}` +
      (failed.length ? ` • fouten: ${failed.join(" | ")}` : "");
  }
}

el("refreshBtn")?.addEventListener("click", loadAll);
el("mClose")?.addEventListener("click", () => el("modal").classList.add("hidden"));
el("modal")?.addEventListener("click", (e) => {
  if (e.target.id === "modal") el("modal").classList.add("hidden");
});

loadAll();
setInterval(loadAll, 60 * 1000);