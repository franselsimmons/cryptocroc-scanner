const el = (id) => document.getElementById(id);

const SOURCES = [
  { key: "main-bull", label: "Main Bull", systemType: "main", mode: "bull", url: "/api/latest?mode=bull" },
  { key: "main-bear", label: "Main Bear", systemType: "main", mode: "bear", url: "/api/latest?mode=bear" },
  { key: "moon-bull", label: "Moon Bull", systemType: "moon", mode: "bull", url: "/api/moon/public-latest?mode=bull" },
  { key: "moon-bear", label: "Moon Bear", systemType: "moon", mode: "bear", url: "/api/moon/public-latest?mode=bear" },
];

let LAST_ROWS = [];

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
function fmtUSD(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return n.toFixed(0);
}
function flattenFunnel(funnel) {
  if (!funnel) return [];
  return []
    .concat(funnel.entry || [])
    .concat(funnel.hold || [])
    .concat(funnel.sell || [])
    .concat(funnel.elite_expansion || [])
    .concat(funnel.elite_ignition || [])
    .concat(funnel.almost || [])
    .concat(funnel.buildup || [])
    .concat(funnel.radar || []);
}

function scoreTone(score) {
  const s = Number(score) || 0;
  if (s >= 82) return "ok";
  if (s >= 68) return "warn";
  return "no";
}

function actionTone(action) {
  if (action === "OPEN") return "ok";
  if (action === "WATCH" || action === "HOLD") return "warn";
  return "no";
}

function normalizeRows(payload, source) {
  const all = flattenFunnel(payload?.funnel);
  const unique = new Map();

  for (const coin of all) {
    const key = `${source.key}:${coin.symbol}`;
    if (!coin?.execution) continue;

    unique.set(key, {
      sourceKey: source.key,
      sourceLabel: source.label,
      systemType: source.systemType,
      mode: source.mode,
      btc: payload?.btc || null,
      regime: payload?.regime || "—",
      coin,
    });
  }

  return [...unique.values()];
}

function rowHtml(row) {
  const c = row.coin;
  const ex = c.execution || {};
  const plan = c.tradePlan || {};
  const tone = actionTone(ex.action);

  return `
    <div class="row" data-key="${row.sourceKey}:${c.symbol}">
      <div class="rowTop">
        <div>
          <div class="rowSym">${c.symbol} • ${ex.side || "—"} • ${ex.action || "—"}</div>
          <div class="rowTag">
            ${row.sourceLabel} • stage ${c.stage || "—"} • regime ${row.regime || "—"} • ${c.coinProfile?.tradabilityBand || "—"}
          </div>
        </div>

        <div class="badges">
          <div class="badge ${tone}">${ex.action || "—"}</div>
          <div class="badge ${scoreTone(ex.score)}">score ${ex.score || 0}</div>
          <div class="badge">size $${ex.positionSizeUsd || "—"}</div>
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
        <span>depth $${Math.round(Number(c?.ob?.depthMinUsd1p || 0)).toLocaleString()}</span>
        <span>EQ ${c.entryQuality ?? c.confidence ?? 0}</span>
        <span>PS ${c.persistenceScore ?? 0}</span>
        <span>SL $${safe(plan.sl, 6)}</span>
        <span>TP $${safe(plan.tp, 6)}</span>
      </div>

      <div class="rowTag" style="margin-top:8px;">
        ${ex.reason || "—"}
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

function setKV(container, rows) {
  if (!container) return;
  container.innerHTML = rows.map(([k, v]) => {
    return `<div class="kvRow"><div class="kvKey">${k}</div><div class="kvVal">${v}</div></div>`;
  }).join("");
}

function renderChecks(container, checks) {
  if (!container) return;
  container.innerHTML = (checks || []).map((c) => {
    return `
      <div class="checkItem">
        <div class="checkTitle">${c.ok ? "✓" : "✗"} ${c.name}</div>
        <div class="checkSub">waarde: ${c.value} • nodig: ${c.need}</div>
      </div>
    `;
  }).join("");
}

function openModal(row) {
  const c = row.coin;
  const ex = c.execution || {};
  const plan = c.tradePlan || {};

  el("mTitle").textContent = `${c.symbol} • ${row.sourceLabel} • ${ex.action || "—"}`;
  el("mSub").textContent =
    `price $${safe(c.price, 6)} • side ${ex.side || "—"} • stage ${c.stage || "—"} • score ${ex.score || 0}`;

  setKV(el("mPlan"), [
    ["System", row.sourceLabel],
    ["Action", ex.action || "—"],
    ["Side", ex.side || "—"],
    ["Position size", `$${ex.positionSizeUsd || "—"}`],
    ["Entry", `$${safe(plan.entry, 6)}`],
    ["SL", `$${safe(plan.sl, 6)}`],
    ["TP", `$${safe(plan.tp, 6)}`],
    ["RR", safe(plan.rr, 2)],
    ["Reason", ex.reason || "—"],
  ]);

  renderChecks(el("mChecks"), ex.checklist || []);
  el("mReason").textContent = ex.reason || "—";
  el("mDebug").textContent = JSON.stringify(row, null, 2);
  el("modal").classList.remove("hidden");
}

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

  for (const item of settled) {
    if (item.status === "fulfilled") {
      rows.push(...normalizeRows(item.value.json, item.value.src));
    } else {
      failed.push(String(item.reason?.message || item.reason));
    }
  }

  LAST_ROWS = rows;

  // ===== AANGEPAST: toon HOLD ook als open trade =====
  const ready = rows
    .filter((r) => {
      const stage = String(r.coin?.stage || "").toUpperCase();
      return r.coin?.tradeDeskStatus === "OPEN" || stage === "HOLD";
    })
    .sort((a, b) => (b.coin?.execution?.score || 0) - (a.coin?.execution?.score || 0));

  const watch = rows
    .filter((r) => {
      const stage = String(r.coin?.stage || "").toUpperCase();
      return r.coin?.tradeDeskStatus === "WATCH" && stage !== "HOLD";
    })
    .sort((a, b) => (b.coin?.execution?.score || 0) - (a.coin?.execution?.score || 0));

  renderList("tradeReadyList", ready);
  renderList("watchList", watch);

  if (status) {
    status.textContent =
      `OPEN ${ready.length} • WATCH ${watch.length}` +
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