const API_URL = "/api/analyze";
const REFRESH_MS = 30000;
const DEFAULT_MIN_CLOSED = 10;

let state = {
  report: null,
  raw: null,
  activeTab: "ALL",
  auto: false,
  timer: null,
  loading: false,
};

function $(id) {
  return document.getElementById(id);
}

function firstEl(...ids) {
  for (const id of ids) {
    const el = $(id);
    if (el) return el;
  }

  return null;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeNumber(value, fallback = 0) {
  if (typeof value === "string") {
    const cleaned = value.replace("%", "").replace(",", ".").trim();
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : fallback;
  }

  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function text(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function escapeHtml(value) {
  return text(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fmtNum(value, decimals = 3) {
  const n = safeNumber(value, 0);

  if (decimals === 0) return String(Math.round(n));
  if (Number.isInteger(n)) return String(n);

  return n.toFixed(decimals).replace(/\.?0+$/, "");
}

function fmtPct(value, decimals = 1) {
  const raw = text(value);

  if (raw.includes("%")) return raw;

  return `${fmtNum(value, decimals)}%`;
}

function signedClass(value) {
  const n = safeNumber(value, 0);

  if (n > 0) return "positive";
  if (n < 0) return "negative";

  return "";
}

function statusClass(status) {
  return `status-${text(status, "EMPTY").toLowerCase()}`;
}

function normalizeStatus(status) {
  return text(status, "EMPTY").toUpperCase();
}

function normalizeFamily(row) {
  const id = row.id || row.familyId || "-";

  return {
    ...row,
    id,
    familyId: id,
    side: text(row.side || "").toUpperCase(),
    quality: row.quality || row.qualityBucket || "",
    market: row.market || row.marketBucket || "",
    timing: row.timing || row.timingBucket || "",
    status: normalizeStatus(row.status),
    definition: row.definition || safeArray(row.labels).join(" | "),
    observed: safeNumber(row.observed, 0),
    trades: safeNumber(row.trades, row.observed || 0),
    closed: safeNumber(row.closed, 0),
    open: safeNumber(row.open, 0),
    pendingOutcome: safeNumber(row.pendingOutcome ?? row.pending, 0),
    wins: safeNumber(row.wins, 0),
    losses: safeNumber(row.losses, 0),
    winrate: row.winrate || fmtPct(safeNumber(row.winrateNum, 0) * 100, 1),
    winrateNum: safeNumber(row.winrateNum, 0),
    totalR: safeNumber(row.totalR, 0),
    avgR: safeNumber(row.avgR, 0),
    totalPnlPct: safeNumber(row.totalPnlPct, 0),
    avgPnlPct: safeNumber(row.avgPnlPct, 0),
    pf: safeNumber(row.pf ?? row.profitFactor ?? row.profitFactorR, 0),
  };
}

function errorToText(error) {
  if (!error) return "Onbekende error.";

  if (typeof error === "string") return error;

  if (error instanceof Error) {
    return error.message || String(error);
  }

  if (typeof error === "object") {
    if (error.error?.message) return error.error.message;
    if (error.message) return error.message;
    if (error.error && typeof error.error === "string") return error.error;
    if (error.reason) return error.reason;

    try {
      return JSON.stringify(error, null, 2);
    } catch {
      return "Niet-serialiseerbare error.";
    }
  }

  return String(error);
}

function setHidden(el, hidden) {
  if (!el) return;

  el.hidden = Boolean(hidden);
  el.classList.toggle("hidden", Boolean(hidden));
}

function setStatus(message, isError = false) {
  const status = firstEl("statusLine", "statusText");
  const box = $("errorBox");

  if (status) {
    status.textContent = message || "";
  }

  if (box) {
    setHidden(box, !isError);

    if (isError) {
      box.textContent = `Load error:\n${message}`;
    }
  }
}

function setBusy(isBusy) {
  state.loading = Boolean(isBusy);

  const refreshBtn = $("refreshBtn");
  const resetBtn = $("resetBtn");

  if (refreshBtn) refreshBtn.disabled = state.loading;
  if (resetBtn) resetBtn.disabled = state.loading;

  if (refreshBtn) {
    refreshBtn.textContent = state.loading ? "Loading..." : "Refresh";
  }
}

function setText(ids, value) {
  const list = Array.isArray(ids) ? ids : [ids];

  for (const id of list) {
    const el = $(id);
    if (el) el.textContent = value;
  }
}

function getMinClosedInput() {
  return firstEl("minClosedInput", "minClosed");
}

function getMinClosedValue() {
  const input = getMinClosedInput();
  const value = safeNumber(input?.value, DEFAULT_MIN_CLOSED);

  return Math.max(0, Math.round(value));
}

function getSourceMode() {
  const select = $("sourceSelect");
  return select?.value || "MERGED";
}

function buildApiUrl(extra = {}) {
  const params = new URLSearchParams();

  params.set("minClosed", String(getMinClosedValue()));
  params.set("includeLatest", getSourceMode() === "STORED" ? "false" : "true");
  params.set("debug", extra.debug === false ? "false" : "true");
  params.set("t", String(Date.now()));

  if (extra.reset) {
    params.set("reset", "true");
  }

  return `${API_URL}?${params.toString()}`;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    method: "GET",
    cache: "no-store",
    headers: {
      Accept: "application/json",
    },
  });

  const contentType = response.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");

  const payload = isJson
    ? await response.json()
    : {
        ok: false,
        error: await response.text(),
      };

  if (!response.ok || !payload?.ok) {
    throw payload;
  }

  return payload;
}

function normalizePayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("API gaf geen geldig JSON-object terug.");
  }

  if (!payload.ok) {
    throw payload;
  }

  const report = payload.report || {};
  const summary = report.summary || payload.stats || {};
  const familiesRaw = report.families || payload.families || {};
  const leaderboards = report.leaderboards || payload.leaderboards || {};

  const allFamilies = safeArray(
    familiesRaw.all ||
      familiesRaw.ranked ||
      familiesRaw.topPnl ||
      leaderboards.topPnlFamilies
  ).map(normalizeFamily);

  const longFamilies = safeArray(familiesRaw.long).length
    ? safeArray(familiesRaw.long).map(normalizeFamily)
    : allFamilies.filter(row => row.side === "LONG");

  const shortFamilies = safeArray(familiesRaw.short).length
    ? safeArray(familiesRaw.short).map(normalizeFamily)
    : allFamilies.filter(row => row.side === "SHORT");

  const rankedFamilies = safeArray(familiesRaw.ranked).length
    ? safeArray(familiesRaw.ranked).map(normalizeFamily)
    : allFamilies;

  const bestFamilies = safeArray(familiesRaw.best || payload.winnerCandidates).map(normalizeFamily);

  return {
    raw: payload,
    report: {
      ...report,
      summary,
      diagnostics: report.diagnostics || {},
      config: report.config || payload.config || {},
      filterValues: report.filterValues || {},
      familyPerformanceMatrix: report.familyPerformanceMatrix || payload.familyPerformanceMatrix || {},
      families: {
        all: allFamilies,
        long: longFamilies,
        short: shortFamilies,
        ranked: rankedFamilies,
        best: bestFamilies,
        worst: safeArray(familiesRaw.worst).map(normalizeFamily),
        topPnl: safeArray(familiesRaw.topPnl || leaderboards.topPnlFamilies).map(normalizeFamily),
        topTotalR: safeArray(familiesRaw.topTotalR || leaderboards.topTotalRFamilies).map(normalizeFamily),
        topWinrate: safeArray(familiesRaw.topWinrate || leaderboards.topWinrateFamilies).map(normalizeFamily),
      },
    },
  };
}

function countStatuses(families) {
  const counts = {
    HOT: 0,
    GOOD: 0,
    STABLE: 0,
    BAD: 0,
    COLLECTING: 0,
    EMPTY: 0,
  };

  for (const family of safeArray(families)) {
    const status = normalizeStatus(family.status);

    if (counts[status] === undefined) counts[status] = 0;
    counts[status] += 1;
  }

  return counts;
}

function familyMetaText(families) {
  const c = countStatuses(families);

  return `HOT ${c.HOT} | GOOD ${c.GOOD} | STABLE ${c.STABLE} | BAD ${c.BAD} | COLLECTING ${c.COLLECTING} | EMPTY ${c.EMPTY}`;
}

function renderSummary() {
  const summary = state.report?.summary || {};
  const longFamilies = safeArray(state.report?.families?.long);
  const shortFamilies = safeArray(state.report?.families?.short);

  setText("mActions", fmtNum(summary.actions || 0, 0));
  setText("mTrades", fmtNum(summary.trades || summary.observed || 0, 0));
  setText("mOpen", fmtNum(summary.open || 0, 0));
  setText("mClosed", fmtNum(summary.closed || 0, 0));
  setText("mPending", fmtNum(summary.pendingOutcome || summary.unresolved || 0, 0));
  setText("mWins", fmtNum(summary.wins || 0, 0));
  setText("mLosses", fmtNum(summary.losses || 0, 0));
  setText("mBreakeven", fmtNum(summary.breakeven || 0, 0));
  setText("mWinrate", summary.winrate || fmtPct(safeNumber(summary.winrateNum, 0) * 100));
  setText("mTotalR", fmtNum(summary.totalR || 0, 3));
  setText("mAvgR", fmtNum(summary.avgR || 0, 3));
  setText("mTotalPnl", fmtPct(summary.totalPnlPct || 0, 3));

  setText("mLongFamilies", fmtNum(summary.longFamilies?.count || longFamilies.length || 50, 0));
  setText("mShortFamilies", fmtNum(summary.shortFamilies?.count || shortFamilies.length || 50, 0));

  setText("mLongMeta", summary.longFamilies?.text || familyMetaText(longFamilies));
  setText("mShortMeta", summary.shortFamilies?.text || familyMetaText(shortFamilies));
}

function renderSourceCards() {
  const raw = state.raw || {};
  const sources = raw.sources || {};
  const store = sources.store || raw.store || {};
  const latest = sources.latest || raw.latest || {};

  setText("sourceStored", fmtNum(sources.storedEvents ?? store.count ?? 0, 0));
  setText("sourceLatest", fmtNum(sources.latestEvents ?? latest.count ?? 0, 0));
  setText("sourceMerged", fmtNum(sources.mergedEvents ?? raw.merged?.count ?? 0, 0));
  setText("sourceLatency", `${fmtNum(raw.latencyMs ?? 0, 0)}ms`);

  setText("sourceStoredSub", store.path ? `store: ${store.path}` : "store: n/a");
  setText("sourceLatestSub", latest.ok ? "latest scan OK" : `latest scan ${latest.error || latest.note || "n/a"}`);
  setText("sourceMergedSub", `loaded: ${fmtNum(sources.mergedEvents ?? raw.merged?.count ?? 0, 0)}`);
  setText("sourceLatencySub", raw.generatedAt || raw.servedAt ? new Date(raw.generatedAt || raw.servedAt).toLocaleString() : "-");
}

function getBaseFamilies() {
  const families = state.report?.families || {};

  if (state.activeTab === "LONG") return safeArray(families.long);
  if (state.activeTab === "SHORT") return safeArray(families.short);

  return safeArray(families.ranked || families.all);
}

function rankPnlFirst(a, b) {
  const pnl = safeNumber(b.totalPnlPct, 0) - safeNumber(a.totalPnlPct, 0);
  if (pnl !== 0) return pnl;

  const totalR = safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0);
  if (totalR !== 0) return totalR;

  const avgR = safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0);
  if (avgR !== 0) return avgR;

  const pf = safeNumber(b.pf, 0) - safeNumber(a.pf, 0);
  if (pf !== 0) return pf;

  return safeNumber(b.closed, 0) - safeNumber(a.closed, 0);
}

function sortFamilies(rows) {
  const statusRank = {
    HOT: 6,
    GOOD: 5,
    STABLE: 4,
    COLLECTING: 3,
    BAD: 2,
    EMPTY: 1,
  };

  return [...safeArray(rows)].sort((a, b) => {
    const s = (statusRank[b.status] || 0) - (statusRank[a.status] || 0);
    if (s !== 0) return s;

    return rankPnlFirst(a, b);
  });
}

function getSelectedFamilies() {
  const sideSelect = $("sideSelect");
  const statusSelect = $("statusSelect");
  const searchInput = $("searchInput");
  const hideEmptyInput = $("hideEmptyInput");

  let rows = getBaseFamilies();

  const side = sideSelect?.value || state.activeTab || "ALL";
  const status = statusSelect?.value || "ALL";
  const query = String(searchInput?.value || "").toUpperCase().trim();
  const hideEmpty = Boolean(hideEmptyInput?.checked);

  if (side === "LONG") rows = rows.filter(row => row.side === "LONG");
  if (side === "SHORT") rows = rows.filter(row => row.side === "SHORT");

  if (status !== "ALL") {
    rows = rows.filter(row => row.status === status);
  }

  if (hideEmpty) {
    rows = rows.filter(row => row.status !== "EMPTY" && safeNumber(row.observed, 0) > 0);
  }

  if (query) {
    rows = rows.filter(row => {
      const haystack = [
        row.id,
        row.side,
        row.status,
        row.definition,
        row.quality,
        row.market,
        row.timing,
        row.winrate,
        row.totalR,
        row.avgR,
        row.totalPnlPct,
        row.avgPnlPct,
        row.pf,
      ].join(" ").toUpperCase();

      return haystack.includes(query);
    });
  }

  return sortFamilies(rows);
}

function renderFamilies() {
  const tbody = $("familyBody");
  const count = $("familyCount");
  const emptyState = $("emptyState");

  if (!tbody) return;

  const rows = getSelectedFamilies();

  if (count) {
    count.textContent = `${rows.length} rows`;
  }

  setHidden(emptyState, rows.length > 0);

  if (!rows.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="20" class="empty-row">Geen families voor deze filterselectie.</td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = rows.map(row => {
    const status = normalizeStatus(row.status);
    const side = text(row.side);
    const sideClass = side.toLowerCase();

    return `
      <tr class="${statusClass(status)}">
        <td><span class="family-id">${escapeHtml(row.id)}</span></td>
        <td><span class="side-pill ${sideClass}">${escapeHtml(side)}</span></td>
        <td>${escapeHtml(row.quality)}</td>
        <td>${escapeHtml(row.market)}</td>
        <td>${escapeHtml(row.timing)}</td>
        <td class="definition">${escapeHtml(row.definition)}</td>
        <td class="num">${fmtNum(row.observed, 0)}</td>
        <td class="num">${fmtNum(row.trades, 0)}</td>
        <td class="num">${fmtNum(row.closed, 0)}</td>
        <td class="num">${fmtNum(row.open, 0)}</td>
        <td class="num pending">${fmtNum(row.pendingOutcome, 0)}</td>
        <td class="num">${fmtNum(row.wins, 0)}</td>
        <td class="num">${fmtNum(row.losses, 0)}</td>
        <td class="num">${escapeHtml(row.winrate || "0%")}</td>
        <td class="num ${signedClass(row.totalR)}">${fmtNum(row.totalR, 3)}</td>
        <td class="num ${signedClass(row.avgR)}">${fmtNum(row.avgR, 3)}</td>
        <td class="num ${signedClass(row.totalPnlPct)}">${fmtPct(row.totalPnlPct, 3)}</td>
        <td class="num ${signedClass(row.avgPnlPct)}">${fmtPct(row.avgPnlPct, 3)}</td>
        <td class="num">${fmtNum(row.pf, 3)}</td>
        <td><span class="status-pill ${statusClass(status)}">${escapeHtml(status)}</span></td>
      </tr>
    `;
  }).join("");
}

function getWinnerFamilies() {
  const minClosed = Math.max(1, getMinClosedValue());
  const apiBest = safeArray(state.report?.families?.best);

  const source = apiBest.length
    ? apiBest
    : safeArray(state.report?.families?.ranked || state.report?.families?.all);

  return source
    .map(normalizeFamily)
    .filter(row => safeNumber(row.closed, 0) >= minClosed)
    .filter(row => safeNumber(row.avgR, 0) > 0)
    .filter(row => safeNumber(row.totalR, 0) > 0)
    .filter(row => safeNumber(row.totalPnlPct, 0) > 0)
    .sort(rankPnlFirst)
    .slice(0, 8);
}

function renderFamilyCards(targetId, rows, emptyText) {
  const grid = $(targetId);

  if (!grid) return;

  if (!rows.length) {
    grid.innerHTML = `<article class="winner-empty">${escapeHtml(emptyText)}</article>`;
    return;
  }

  grid.innerHTML = rows.map(raw => {
    const row = normalizeFamily(raw);
    const status = normalizeStatus(row.status);

    return `
      <article class="winner-card ${status.toLowerCase()}">
        <div class="winner-top">
          <span class="winner-id">${escapeHtml(row.id)}</span>
          <span class="status-pill ${statusClass(status)}">${escapeHtml(status)}</span>
        </div>

        <div class="winner-stats">
          <div class="winner-stat">
            <span>Closed</span>
            <strong>${fmtNum(row.closed, 0)}</strong>
          </div>
          <div class="winner-stat">
            <span>Winrate</span>
            <strong>${escapeHtml(row.winrate || "0%")}</strong>
          </div>
          <div class="winner-stat">
            <span>Total PnL%</span>
            <strong class="${signedClass(row.totalPnlPct)}">${fmtPct(row.totalPnlPct, 3)}</strong>
          </div>
          <div class="winner-stat">
            <span>Total R</span>
            <strong class="${signedClass(row.totalR)}">${fmtNum(row.totalR, 3)}</strong>
          </div>
          <div class="winner-stat">
            <span>Avg R</span>
            <strong class="${signedClass(row.avgR)}">${fmtNum(row.avgR, 3)}</strong>
          </div>
          <div class="winner-stat">
            <span>PF</span>
            <strong>${fmtNum(row.pf, 3)}</strong>
          </div>
        </div>

        <p class="winner-definition">${escapeHtml(row.definition)}</p>
      </article>
    `;
  }).join("");
}

function renderWinners() {
  const winners = getWinnerFamilies();
  const count = $("winnerCount");

  if (count) {
    count.textContent = `${winners.length} winners`;
  }

  renderFamilyCards(
    "winnerGrid",
    winners,
    `Nog geen betrouwbare runner winner-family. Nodig: minimaal ${getMinClosedValue()} closed trades met positieve PnL/R.`
  );
}

function renderTopPnl() {
  const families = safeArray(state.report?.families?.topPnl).length
    ? safeArray(state.report?.families?.topPnl).map(normalizeFamily)
    : safeArray(state.report?.families?.all)
        .map(normalizeFamily)
        .filter(row => row.closed > 0)
        .sort(rankPnlFirst)
        .slice(0, 8);

  const count = $("topPnlCount");

  if (count) {
    count.textContent = `${families.length} families`;
  }

  renderFamilyCards("topPnlGrid", families.slice(0, 8), "Nog geen PnL families.");
}

function renderFilters() {
  const body = $("filtersBody");
  const count = $("filterCount");

  if (!body) return;

  const filterValues = state.report?.filterValues || {};
  const trackedFields = safeArray(filterValues.trackedFields);

  const quality = Object.values(filterValues.qualityBuckets || {});
  const market = Object.values(filterValues.marketBuckets || {});
  const timing = Object.values(filterValues.timingBuckets || {});

  const chips = [
    ...trackedFields.map(field => ({ group: "FIELD", label: field })),
    ...quality.map(bucket => ({ group: "QUALITY", label: bucket.key })),
    ...market.map(bucket => ({ group: "MARKET", label: bucket.key })),
    ...timing.map(bucket => ({ group: "TIMING", label: bucket.key })),
  ].filter(chip => chip.label);

  if (count) {
    count.textContent = `${chips.length} labels`;
  }

  body.innerHTML = chips.map(chip => `
    <span class="filter-chip">
      <b>${escapeHtml(chip.group)}</b>
      ${escapeHtml(chip.label)}
    </span>
  `).join("");
}

function renderDebug() {
  const debugJson = $("debugJson");
  if (!debugJson) return;

  debugJson.textContent = JSON.stringify({
    dataState: state.raw?.dataState || null,
    sources: state.raw?.sources || null,
    summary: state.report?.summary || null,
    diagnostics: state.report?.diagnostics || null,
    config: state.report?.config || null,
  }, null, 2);
}

function renderApiLink() {
  const apiLink = $("apiLink");

  if (apiLink) {
    apiLink.href = buildApiUrl({ debug: true });
  }
}

function render() {
  if (!state.report) return;

  renderSummary();
  renderSourceCards();
  renderWinners();
  renderTopPnl();
  renderFamilies();
  renderFilters();
  renderDebug();
  renderApiLink();
}

async function loadAnalytics({ force = false } = {}) {
  if (state.loading && !force) return;

  setBusy(true);
  setStatus("Laden...", false);

  try {
    const payload = await fetchJson(buildApiUrl({ debug: true }));
    const normalized = normalizePayload(payload);

    state.raw = normalized.raw;
    state.report = normalized.report;

    const updated = normalized.raw?.generatedAt || normalized.raw?.servedAt
      ? new Date(normalized.raw.generatedAt || normalized.raw.servedAt).toLocaleString()
      : new Date().toLocaleString();

    setStatus(
      `Laatste update: ${updated} | data ${normalized.raw?.dataState || "UNKNOWN"} | loaded in ${fmtNum(normalized.raw?.latencyMs || 0, 0)}ms`,
      false
    );

    render();
  } catch (error) {
    const message = errorToText(error);

    setStatus(message, true);
    console.error("RUNNER ANALYTICS LOAD ERROR:", error);
  } finally {
    setBusy(false);
  }
}

async function resetAnalytics() {
  const ok = window.confirm("Runner analyse-store resetten? Dit wist de opgeslagen family-history.");

  if (!ok) return;
  if (state.loading) return;

  setBusy(true);
  setStatus("Reset bezig...", false);

  try {
    const payload = await fetchJson(buildApiUrl({ reset: true, debug: true }));

    if (!payload.ok) {
      throw payload;
    }

    state.raw = null;
    state.report = null;

    setBusy(false);
    await loadAnalytics({ force: true });
  } catch (error) {
    const message = errorToText(error);

    setStatus(message, true);
    console.error("RUNNER ANALYTICS RESET ERROR:", error);
  } finally {
    setBusy(false);
  }
}

function syncTabs() {
  document.querySelectorAll("[data-side]").forEach(button => {
    const value = button.dataset.side || "ALL";
    button.classList.toggle("active", value === state.activeTab);
  });
}

function setTab(tab) {
  state.activeTab = tab || "ALL";

  const sideSelect = $("sideSelect");

  if (sideSelect) {
    sideSelect.value = state.activeTab;
  }

  syncTabs();
  renderFamilies();
}

function toggleAuto() {
  state.auto = !state.auto;

  const button = $("autoBtn");
  if (button) button.textContent = `Auto: ${state.auto ? "ON" : "OFF"}`;

  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }

  if (state.auto) {
    state.timer = setInterval(loadAnalytics, REFRESH_MS);
  }
}

let reloadDebounce = null;

function scheduleReload() {
  if (reloadDebounce) {
    clearTimeout(reloadDebounce);
  }

  reloadDebounce = setTimeout(() => {
    loadAnalytics();
  }, 350);
}

function wireEvents() {
  $("refreshBtn")?.addEventListener("click", () => loadAnalytics());
  $("resetBtn")?.addEventListener("click", resetAnalytics);
  $("autoBtn")?.addEventListener("click", toggleAuto);

  document.querySelectorAll("[data-side]").forEach(button => {
    button.addEventListener("click", () => {
      setTab(button.dataset.side || "ALL");
    });
  });

  const sourceSelect = $("sourceSelect");
  const sideSelect = $("sideSelect");
  const statusSelect = $("statusSelect");
  const minClosedInput = getMinClosedInput();
  const searchInput = $("searchInput");
  const hideEmptyInput = $("hideEmptyInput");

  sourceSelect?.addEventListener("change", () => loadAnalytics());

  sideSelect?.addEventListener("change", () => {
    state.activeTab = sideSelect.value || "ALL";
    syncTabs();
    renderFamilies();
  });

  statusSelect?.addEventListener("change", renderFamilies);
  searchInput?.addEventListener("input", renderFamilies);
  hideEmptyInput?.addEventListener("change", renderFamilies);

  minClosedInput?.addEventListener("input", () => {
    renderFamilies();
    renderWinners();
    scheduleReload();
  });

  minClosedInput?.addEventListener("change", () => {
    renderFamilies();
    renderWinners();
    scheduleReload();
  });
}

function ensureRuntimeDefaults() {
  const minClosedInput = getMinClosedInput();

  if (minClosedInput && (minClosedInput.value === "" || minClosedInput.value === "0")) {
    minClosedInput.value = String(DEFAULT_MIN_CLOSED);
  }

  renderApiLink();
}

document.addEventListener("DOMContentLoaded", async () => {
  ensureRuntimeDefaults();
  wireEvents();
  syncTabs();
  await loadAnalytics();
});