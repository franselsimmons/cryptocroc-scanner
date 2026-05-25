const API_URL = "/api/analyze";
const REFRESH_MS = 30000;
const DEFAULT_MIN_CLOSED = 10;
const MAX_WINNER_CARDS = 8;
const MAX_TOP_PNL_CARDS = 10;

let state = {
  raw: null,
  report: null,
  activeTab: "ALL",
  auto: false,
  timer: null,
  loading: false,
};

function $(id) {
  return document.getElementById(id);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function safeNumber(value, fallback = 0) {
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

function sideClass(side) {
  return text(side, "").toLowerCase();
}

function setHidden(el, hidden) {
  if (!el) return;

  el.hidden = Boolean(hidden);
  el.classList.toggle("hidden", Boolean(hidden));
}

function setText(ids, value) {
  const list = Array.isArray(ids) ? ids : [ids];

  for (const id of list) {
    const el = $(id);
    if (el) el.textContent = value;
  }
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
    if (typeof error.error === "string") return error.error;
    if (error.reason) return error.reason;

    try {
      return JSON.stringify(error, null, 2);
    } catch {
      return "Niet-serialiseerbare error.";
    }
  }

  return String(error);
}

function setStatus(message, isError = false) {
  const status = $("statusLine");
  const box = $("errorBox");

  if (status) status.textContent = message || "";

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

  if (refreshBtn) {
    refreshBtn.disabled = state.loading;
    refreshBtn.textContent = state.loading ? "Loading..." : "Refresh";
  }

  if (resetBtn) {
    resetBtn.disabled = state.loading;
  }
}

function getMinClosedValue() {
  const input = $("minClosedInput");
  const value = safeNumber(input?.value, DEFAULT_MIN_CLOSED);

  return Math.max(0, Math.round(value));
}

function buildApiUrl(extra = {}) {
  const params = new URLSearchParams();

  params.set("minClosed", String(getMinClosedValue()));
  params.set("debug", extra.debug === false ? "false" : "true");
  params.set("cacheBust", String(Date.now()));

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
    : { ok: false, error: await response.text() };

  if (!response.ok) {
    throw payload;
  }

  return payload;
}

function extractLabel(labels, prefix) {
  return safeArray(labels).find(label => text(label).startsWith(prefix)) || "";
}

function normalizeSide(value) {
  const s = text(value).toUpperCase();

  if (s === "BULL" || s === "LONG" || s === "BUY") return "LONG";
  if (s === "BEAR" || s === "SHORT" || s === "SELL") return "SHORT";

  return s || "UNKNOWN";
}

function normalizeStatus(value, closed = 0, avgR = 0, totalR = 0, winrateNum = 0) {
  const raw = text(value).toUpperCase();

  if (["HOT", "GOOD", "STABLE", "BAD", "COLLECTING", "EMPTY"].includes(raw)) {
    return raw;
  }

  if (closed <= 0) return "EMPTY";
  if (closed < getMinClosedValue()) return "COLLECTING";
  if (avgR <= 0 || totalR <= 0) return "BAD";
  if (winrateNum >= 0.58 && avgR >= 0.25) return "HOT";
  if (winrateNum >= 0.52 && avgR >= 0.12) return "GOOD";
  if (avgR > 0 && totalR > 0) return "STABLE";

  return "BAD";
}

function familyIndexFromId(id) {
  const match = text(id).match(/_(\d+)$/);
  return match ? safeNumber(match[1], 0) : 0;
}

function normalizeFamily(row, fallbackIndex = 0) {
  const source = safeObject(row);
  const id = text(
    source.id ||
      source.familyId ||
      source.family ||
      source.name ||
      `FAMILY_${fallbackIndex + 1}`
  );

  const labels = safeArray(source.labels);
  const definition = text(
    source.definition ||
      source.description ||
      source.rule ||
      labels.join(" | ")
  );

  const side = normalizeSide(source.side || id.split("_")[0]);
  const closed = safeNumber(source.closed, 0);
  const wins = safeNumber(source.wins, 0);
  const losses = safeNumber(source.losses, 0);
  const breakeven = safeNumber(source.breakeven, 0);
  const trades = safeNumber(source.trades, safeNumber(source.observed, closed));
  const observed = safeNumber(source.observed, trades);
  const open = safeNumber(source.open, 0);
  const pending = safeNumber(source.pending ?? source.pendingOutcome ?? source.unresolved, Math.max(0, trades - closed));
  const totalR = safeNumber(source.totalR ?? source.pnlR, 0);
  const avgR = safeNumber(source.avgR, closed > 0 ? totalR / closed : 0);
  const totalPnlPct = safeNumber(source.totalPnlPct ?? source.pnlPct, 0);
  const avgPnlPct = safeNumber(source.avgPnlPct, closed > 0 ? totalPnlPct / closed : 0);
  const pf = safeNumber(source.pf ?? source.profitFactor ?? source.profitFactorR, 0);

  const winrateNum = source.winrateNum !== undefined
    ? safeNumber(source.winrateNum, 0)
    : closed > 0
      ? wins / closed
      : 0;

  const winrate = source.winrate || fmtPct(winrateNum * 100, 1);
  const status = normalizeStatus(source.status, closed, avgR, totalR, winrateNum);

  const quality = text(
    source.quality ||
      source.qualityBucket ||
      extractLabel(labels, "Q") ||
      definition.split("|")[0] ||
      ""
  ).trim();

  const market = text(
    source.market ||
      source.marketBucket ||
      extractLabel(labels, "M") ||
      ""
  ).trim();

  const timing = text(
    source.timing ||
      source.timingBucket ||
      extractLabel(labels, "T") ||
      ""
  ).trim();

  return {
    ...source,

    id,
    familyId: id,
    index: safeNumber(source.index, familyIndexFromId(id)),
    side,

    quality,
    market,
    timing,
    definition,
    labels,

    observed,
    trades,
    closed,
    open,
    pending,
    pendingOutcome: pending,

    wins,
    losses,
    breakeven,

    winrate,
    winrateNum,

    totalR,
    avgR,
    totalPnlPct,
    avgPnlPct,

    pf,
    profitFactor: pf,
    profitFactorR: pf,

    status,
    score: safeNumber(source.score, 0),

    examples: safeArray(source.examples),
  };
}

function dedupeFamilies(rows) {
  const map = new Map();

  for (const row of safeArray(rows)) {
    const normalized = normalizeFamily(row, map.size);
    const key = `${normalized.side}_${normalized.id}`;

    const prev = map.get(key);

    if (!prev) {
      map.set(key, normalized);
      continue;
    }

    const nextScore =
      safeNumber(normalized.observed, 0) +
      safeNumber(normalized.closed, 0) * 10 +
      Math.max(safeNumber(normalized.totalPnlPct, 0), 0);

    const prevScore =
      safeNumber(prev.observed, 0) +
      safeNumber(prev.closed, 0) * 10 +
      Math.max(safeNumber(prev.totalPnlPct, 0), 0);

    if (nextScore > prevScore) {
      map.set(key, normalized);
    }
  }

  return Array.from(map.values());
}

function collectFamiliesFromContainer(value, out = []) {
  if (!value) return out;

  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === "object") out.push(item);
    }

    return out;
  }

  if (typeof value !== "object") return out;

  if (value.familyId || value.id || value.definition || value.labels) {
    out.push(value);
    return out;
  }

  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      collectFamiliesFromContainer(child, out);
    }
  }

  return out;
}

function getRawFamilies(payload) {
  const rows = [];

  collectFamiliesFromContainer(payload?.families, rows);
  collectFamiliesFromContainer(payload?.familyRows, rows);
  collectFamiliesFromContainer(payload?.matrixRows, rows);
  collectFamiliesFromContainer(payload?.rankedFamilies, rows);
  collectFamiliesFromContainer(payload?.familyPerformanceMatrix?.families, rows);
  collectFamiliesFromContainer(payload?.familyPerformanceMatrix?.all, rows);
  collectFamiliesFromContainer(payload?.familyPerformanceMatrix?.long?.families, rows);
  collectFamiliesFromContainer(payload?.familyPerformanceMatrix?.short?.families, rows);

  if (!rows.length) {
    collectFamiliesFromContainer(payload?.leaderboards?.topPnlFamilies, rows);
    collectFamiliesFromContainer(payload?.leaderboards?.topTotalRFamilies, rows);
    collectFamiliesFromContainer(payload?.leaderboards?.topWinrateFamilies, rows);
    collectFamiliesFromContainer(payload?.winnerCandidates, rows);
    collectFamiliesFromContainer(payload?.winnerFamilies, rows);

    const best = safeObject(payload?.best);
    collectFamiliesFromContainer(best.bestLongByPnl, rows);
    collectFamiliesFromContainer(best.bestShortByPnl, rows);
    collectFamiliesFromContainer(best.topPnlFamily, rows);
    collectFamiliesFromContainer(best.topTotalRFamily, rows);
    collectFamiliesFromContainer(best.topWinrateFamily, rows);
  }

  return dedupeFamilies(rows);
}

function sortFamiliesPnlFirst(rows) {
  return [...safeArray(rows)].sort((a, b) => {
    const pnl = safeNumber(b.totalPnlPct, 0) - safeNumber(a.totalPnlPct, 0);
    if (pnl !== 0) return pnl;

    const totalR = safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0);
    if (totalR !== 0) return totalR;

    const avgR = safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0);
    if (avgR !== 0) return avgR;

    const pf = safeNumber(b.pf ?? b.profitFactor, 0) - safeNumber(a.pf ?? a.profitFactor, 0);
    if (pf !== 0) return pf;

    const closed = safeNumber(b.closed, 0) - safeNumber(a.closed, 0);
    if (closed !== 0) return closed;

    const observed = safeNumber(b.observed, 0) - safeNumber(a.observed, 0);
    if (observed !== 0) return observed;

    const side = text(a.side).localeCompare(text(b.side));
    if (side !== 0) return side;

    return safeNumber(a.index, 0) - safeNumber(b.index, 0);
  });
}

function statusSummaryText(families) {
  const counts = {
    HOT: 0,
    GOOD: 0,
    STABLE: 0,
    BAD: 0,
    COLLECTING: 0,
    EMPTY: 0,
  };

  for (const family of safeArray(families)) {
    const status = text(family.status, "EMPTY").toUpperCase();

    if (counts[status] === undefined) counts[status] = 0;
    counts[status] += 1;
  }

  return `HOT ${counts.HOT} | GOOD ${counts.GOOD} | STABLE ${counts.STABLE} | BAD ${counts.BAD} | COLLECTING ${counts.COLLECTING} | EMPTY ${counts.EMPTY}`;
}

function normalizeRunnerPayload(payload) {
  const rawFamilies = getRawFamilies(payload);
  const allFamilies = sortFamiliesPnlFirst(rawFamilies);
  const longFamilies = sortFamiliesPnlFirst(allFamilies.filter(row => row.side === "LONG"));
  const shortFamilies = sortFamiliesPnlFirst(allFamilies.filter(row => row.side === "SHORT"));

  const stats = safeObject(payload.stats);
  const store = safeObject(payload.store);
  const latest = safeObject(payload.latest);
  const merged = safeObject(payload.merged);
  const source = safeObject(payload.source);

  const summary = {
    actions: safeNumber(stats.actions, safeNumber(store.count, 0)),
    trades: safeNumber(stats.trades, safeNumber(store.trades, 0)),
    open: safeNumber(stats.open, safeNumber(store.open, 0)),
    closed: safeNumber(stats.closed, safeNumber(store.closed, 0)),
    pendingOutcome: safeNumber(stats.pendingOutcome, 0),
    wins: safeNumber(stats.wins, 0),
    losses: safeNumber(stats.losses, 0),
    breakeven: safeNumber(stats.breakeven, 0),
    winrateNum: safeNumber(stats.winrateNum, 0),
    winrate: stats.winrate || fmtPct(safeNumber(stats.winrateNum, 0) * 100, 1),
    totalR: safeNumber(stats.totalR, 0),
    avgR: safeNumber(stats.avgR, 0),
    totalPnlPct: safeNumber(stats.totalPnlPct, 0),
    avgPnlPct: safeNumber(stats.avgPnlPct, 0),

    longFamilies: safeNumber(stats.longFamilies?.count ?? stats.longFamilies?.total, longFamilies.length || 50),
    shortFamilies: safeNumber(stats.shortFamilies?.count ?? stats.shortFamilies?.total, shortFamilies.length || 50),
    longFamiliesMeta: stats.longFamilies?.text || statusSummaryText(longFamilies),
    shortFamiliesMeta: stats.shortFamilies?.text || statusSummaryText(shortFamilies),
  };

  const apiWinnerCandidates = safeArray(payload.winnerCandidates).map(normalizeFamily);
  const apiWinnerFamilies = safeArray(payload.winnerFamilies).map(normalizeFamily);
  const apiTopPnlFamilies = safeArray(payload.leaderboards?.topPnlFamilies).map(normalizeFamily);
  const apiTopTotalRFamilies = safeArray(payload.leaderboards?.topTotalRFamilies).map(normalizeFamily);
  const apiTopWinrateFamilies = safeArray(payload.leaderboards?.topWinrateFamilies).map(normalizeFamily);

  const best = safeObject(payload.best);
  const bestRows = [
    best.bestLongByPnl,
    best.bestShortByPnl,
    best.topPnlFamily,
    best.topTotalRFamily,
    best.topWinrateFamily,
  ].filter(Boolean).map(normalizeFamily);

  const topPnlFamilies = sortFamiliesPnlFirst(
    apiTopPnlFamilies.length ? apiTopPnlFamilies : [...allFamilies, ...bestRows]
  );

  const winnerCandidates = sortFamiliesPnlFirst(
    apiWinnerCandidates.length
      ? apiWinnerCandidates
      : topPnlFamilies.filter(row => {
          return (
            safeNumber(row.closed, 0) >= getMinClosedValue() &&
            safeNumber(row.avgR, 0) > 0 &&
            safeNumber(row.totalR, 0) > 0 &&
            safeNumber(row.winrateNum, 0) >= 0.30
          );
        })
  );

  return {
    raw: payload,
    report: {
      endpoint: payload.endpoint || "/api/analyze",
      objective: payload.objective || "RUNNER_PNL_FIRST",
      strategy: payload.strategy || "50_LONG_FAMILIES_PLUS_50_SHORT_FAMILIES",
      dataState: payload.dataState || "INIT",
      latencyMs: safeNumber(payload.latencyMs, 0),
      servedAt: payload.servedAt || Date.now(),

      config: payload.config || {
        minClosed: getMinClosedValue(),
        familyCountPerSide: 50,
        totalFamilyCount: 100,
      },

      sources: {
        store,
        latest,
        merged,
        source,
        storedEvents: safeNumber(store.count, 0),
        latestEvents: safeNumber(latest.count, 0),
        mergedEvents: safeNumber(merged.count, allFamilies.length),
      },

      summary,

      families: {
        all: allFamilies,
        ranked: allFamilies,
        long: longFamilies,
        short: shortFamilies,
        best: apiWinnerFamilies,
        winnerCandidates,
        topPnlFamilies,
        topTotalRFamilies: sortFamiliesPnlFirst(apiTopTotalRFamilies),
        topWinrateFamilies: sortFamiliesPnlFirst(apiTopWinrateFamilies),
      },

      filterValues: buildFilterValues(allFamilies),
    },
  };
}

function normalizeReportPayload(payload) {
  const report = payload.report || payload;
  const families = safeObject(report.families);

  const all = dedupeFamilies(
    safeArray(families.all || families.ranked || families.rows || report.familyRows)
  );

  const ranked = sortFamiliesPnlFirst(all);
  const long = sortFamiliesPnlFirst(safeArray(families.long).length ? families.long.map(normalizeFamily) : ranked.filter(row => row.side === "LONG"));
  const short = sortFamiliesPnlFirst(safeArray(families.short).length ? families.short.map(normalizeFamily) : ranked.filter(row => row.side === "SHORT"));

  return {
    raw: payload,
    report: {
      ...report,
      summary: report.summary || {},
      diagnostics: report.diagnostics || {},
      config: report.config || {},
      sources: payload.sources || report.sources || {},
      families: {
        all: ranked,
        ranked,
        long,
        short,
        best: safeArray(families.best).map(normalizeFamily),
        winnerCandidates: safeArray(families.winnerCandidates).map(normalizeFamily),
        topPnlFamilies: safeArray(families.topPnlFamilies).map(normalizeFamily),
        topTotalRFamilies: safeArray(families.topTotalRFamilies).map(normalizeFamily),
        topWinrateFamilies: safeArray(families.topWinrateFamilies).map(normalizeFamily),
      },
      filterValues: report.filterValues || buildFilterValues(ranked),
    },
  };
}

function normalizePayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("API gaf geen geldig JSON-object terug.");
  }

  if (!payload.ok) {
    throw payload;
  }

  if (payload.report) {
    return normalizeReportPayload(payload);
  }

  return normalizeRunnerPayload(payload);
}

function buildFilterValues(families) {
  const trackedFields = new Set();
  const qualityBuckets = new Map();
  const marketBuckets = new Map();
  const timingBuckets = new Map();

  for (const family of safeArray(families)) {
    for (const label of safeArray(family.labels)) {
      trackedFields.add(label);
    }

    if (family.quality) qualityBuckets.set(family.quality, { key: family.quality });
    if (family.market) marketBuckets.set(family.market, { key: family.market });
    if (family.timing) timingBuckets.set(family.timing, { key: family.timing });
  }

  return {
    trackedFields: Array.from(trackedFields).sort(),
    qualityBuckets: Object.fromEntries(qualityBuckets),
    marketBuckets: Object.fromEntries(marketBuckets),
    timingBuckets: Object.fromEntries(timingBuckets),
  };
}

function renderSummary() {
  const summary = safeObject(state.report?.summary);
  const longFamilies = safeArray(state.report?.families?.long);
  const shortFamilies = safeArray(state.report?.families?.short);

  setText("mActions", fmtNum(summary.actions, 0));
  setText("mTrades", fmtNum(summary.trades, 0));
  setText("mOpen", fmtNum(summary.open, 0));
  setText("mClosed", fmtNum(summary.closed, 0));
  setText("mPending", fmtNum(summary.pendingOutcome, 0));
  setText("mWins", fmtNum(summary.wins, 0));
  setText("mLosses", fmtNum(summary.losses, 0));
  setText("mBreakeven", fmtNum(summary.breakeven, 0));
  setText("mWinrate", summary.winrate || fmtPct(summary.winrateNum * 100, 1));
  setText("mTotalR", fmtNum(summary.totalR, 3));
  setText("mAvgR", fmtNum(summary.avgR, 3));
  setText("mTotalPnl", fmtPct(summary.totalPnlPct, 3));

  setText("mLongFamilies", fmtNum(summary.longFamilies || longFamilies.length || 50, 0));
  setText("mShortFamilies", fmtNum(summary.shortFamilies || shortFamilies.length || 50, 0));

  setText("mLongMeta", summary.longFamiliesMeta || statusSummaryText(longFamilies));
  setText("mShortMeta", summary.shortFamiliesMeta || statusSummaryText(shortFamilies));
}

function renderSourceCards() {
  const sources = safeObject(state.report?.sources);
  const store = safeObject(sources.store);
  const latest = safeObject(sources.latest);
  const merged = safeObject(sources.merged);

  setText("sourceStored", fmtNum(sources.storedEvents ?? store.count ?? 0, 0));
  setText("sourceLatest", fmtNum(sources.latestEvents ?? latest.count ?? 0, 0));
  setText("sourceMerged", fmtNum(sources.mergedEvents ?? merged.count ?? 0, 0));
  setText("sourceLatency", `${fmtNum(state.report?.latencyMs ?? state.raw?.latencyMs ?? 0, 0)}ms`);

  setText("sourceStoredSub", store.path ? `store: ${store.path}` : `store: ${store.storeSource || "n/a"}`);
  setText("sourceLatestSub", latest.note || (latest.ok ? "latest scan OK" : "latest scan n/a"));
  setText("sourceMergedSub", merged.source ? `source: ${merged.source}` : `loaded: ${fmtNum(merged.count ?? 0, 0)}`);
  setText("sourceLatencySub", state.report?.servedAt ? new Date(state.report.servedAt).toLocaleString() : "-");
}

function getBaseFamilies() {
  const families = safeObject(state.report?.families);

  if (state.activeTab === "LONG") return safeArray(families.long);
  if (state.activeTab === "SHORT") return safeArray(families.short);

  return safeArray(families.ranked || families.all);
}

function getSelectedFamilies() {
  const sideSelect = $("sideSelect");
  const statusSelect = $("statusSelect");
  const searchInput = $("searchInput");
  const hideEmptyInput = $("hideEmptyInput");

  let rows = getBaseFamilies();

  const side = sideSelect?.value || state.activeTab || "ALL";
  const status = statusSelect?.value || "ALL";
  const query = text(searchInput?.value).toUpperCase().trim();
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
        row.familyId,
        row.side,
        row.status,
        row.quality,
        row.market,
        row.timing,
        row.definition,
        safeArray(row.labels).join(" "),
        row.winrate,
        row.totalR,
        row.avgR,
        row.totalPnlPct,
      ].join(" ").toUpperCase();

      return haystack.includes(query);
    });
  }

  return sortFamiliesPnlFirst(rows);
}

function renderFamilies() {
  const tbody = $("familyBody");
  const count = $("familyCount");
  const emptyState = $("emptyState");

  if (!tbody) return;

  const rows = getSelectedFamilies();

  if (count) {
    count.textContent = `${rows.length} families`;
  }

  setHidden(emptyState, rows.length > 0);

  if (!rows.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="20" class="empty-row">Geen families voor deze filters.</td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = rows.map(row => {
    const status = text(row.status, "EMPTY");
    const side = text(row.side);
    const pending = safeNumber(row.pendingOutcome ?? row.pending, 0);
    const pf = safeNumber(row.pf ?? row.profitFactor, 0);

    return `
      <tr class="${statusClass(status)}">
        <td><span class="family-id">${escapeHtml(row.id)}</span></td>
        <td><span class="side-pill ${sideClass(side)}">${escapeHtml(side)}</span></td>
        <td>${escapeHtml(row.quality)}</td>
        <td>${escapeHtml(row.market)}</td>
        <td>${escapeHtml(row.timing)}</td>
        <td class="definition">${escapeHtml(row.definition)}</td>
        <td class="num">${fmtNum(row.observed, 0)}</td>
        <td class="num">${fmtNum(row.trades, 0)}</td>
        <td class="num">${fmtNum(row.closed, 0)}</td>
        <td class="num">${fmtNum(row.open, 0)}</td>
        <td class="num pending">${fmtNum(pending, 0)}</td>
        <td class="num">${fmtNum(row.wins, 0)}</td>
        <td class="num">${fmtNum(row.losses, 0)}</td>
        <td class="num">${escapeHtml(row.winrate || "0%")}</td>
        <td class="num ${signedClass(row.totalR)}">${fmtNum(row.totalR, 3)}</td>
        <td class="num ${signedClass(row.avgR)}">${fmtNum(row.avgR, 3)}</td>
        <td class="num ${signedClass(row.totalPnlPct)}">${fmtPct(row.totalPnlPct, 3)}</td>
        <td class="num ${signedClass(row.avgPnlPct)}">${fmtPct(row.avgPnlPct, 3)}</td>
        <td class="num">${fmtNum(pf, 3)}</td>
        <td><span class="status-pill ${statusClass(status)}">${escapeHtml(status)}</span></td>
      </tr>
    `;
  }).join("");
}

function getWinnerCandidates() {
  const families = safeObject(state.report?.families);
  const api = safeArray(families.winnerCandidates);

  if (api.length) {
    return sortFamiliesPnlFirst(api).slice(0, MAX_WINNER_CARDS);
  }

  const minClosed = Math.max(1, getMinClosedValue());

  return sortFamiliesPnlFirst(safeArray(families.ranked || families.all))
    .filter(row => safeNumber(row.closed, 0) >= minClosed)
    .filter(row => safeNumber(row.avgR, 0) > 0)
    .filter(row => safeNumber(row.totalR, 0) > 0)
    .filter(row => safeNumber(row.winrateNum, 0) >= 0.30)
    .slice(0, MAX_WINNER_CARDS);
}

function getTopPnlFamilies() {
  const families = safeObject(state.report?.families);
  const api = safeArray(families.topPnlFamilies);

  if (api.length) {
    return sortFamiliesPnlFirst(api).slice(0, MAX_TOP_PNL_CARDS);
  }

  return sortFamiliesPnlFirst(safeArray(families.ranked || families.all))
    .filter(row => safeNumber(row.observed, 0) > 0)
    .slice(0, MAX_TOP_PNL_CARDS);
}

function renderFamilyCards(targetId, countId, rows, emptyText) {
  const grid = $(targetId);
  const count = $(countId);

  if (!grid) return;

  if (count) {
    count.textContent = `${rows.length} families`;
  }

  if (!rows.length) {
    grid.innerHTML = `
      <article class="winner-empty">
        ${escapeHtml(emptyText)}
      </article>
    `;
    return;
  }

  grid.innerHTML = rows.map(row => {
    const status = text(row.status, "STABLE").toLowerCase();
    const pf = safeNumber(row.pf ?? row.profitFactor, 0);

    return `
      <article class="winner-card ${status}">
        <div class="winner-top">
          <span class="winner-id">${escapeHtml(row.id)}</span>
          <span class="status-pill ${statusClass(row.status)}">${escapeHtml(row.status)}</span>
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
            <strong>${fmtNum(pf, 3)}</strong>
          </div>
        </div>

        <p class="winner-definition">${escapeHtml(row.definition)}</p>
      </article>
    `;
  }).join("");
}

function renderWinners() {
  const winners = getWinnerCandidates();
  renderFamilyCards(
    "winnerGrid",
    "winnerCount",
    winners,
    `Nog geen betrouwbare runner winner-family. Nodig: minimaal ${getMinClosedValue()} closed trades met positieve Avg R en positieve Total R.`
  );
}

function renderTopPnl() {
  const rows = getTopPnlFamilies();
  renderFamilyCards(
    "topPnlGrid",
    "topPnlCount",
    rows,
    "Nog geen PnL families."
  );
}

function renderFilters() {
  const body = $("filtersBody");
  const count = $("filterCount");

  if (!body) return;

  const filterValues = safeObject(state.report?.filterValues);
  const trackedFields = safeArray(filterValues.trackedFields);

  const quality = Object.values(safeObject(filterValues.qualityBuckets));
  const market = Object.values(safeObject(filterValues.marketBuckets));
  const timing = Object.values(safeObject(filterValues.timingBuckets));

  const chips = [
    ...trackedFields.map(field => ({ group: "LABEL", label: field })),
    ...quality.map(bucket => ({ group: "QUALITY", label: bucket.key })),
    ...market.map(bucket => ({ group: "MARKET", label: bucket.key })),
    ...timing.map(bucket => ({ group: "TIMING", label: bucket.key })),
  ].filter(chip => chip.label);

  if (count) {
    count.textContent = `${chips.length} labels`;
  }

  if (!chips.length) {
    body.innerHTML = `<span class="filter-chip"><b>EMPTY</b> Geen labels geladen</span>`;
    return;
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
    endpoint: state.report?.endpoint || state.raw?.endpoint || API_URL,
    objective: state.report?.objective || state.raw?.objective || null,
    strategy: state.report?.strategy || state.raw?.strategy || null,
    dataState: state.report?.dataState || state.raw?.dataState || null,
    sources: state.report?.sources || null,
    summary: state.report?.summary || null,
    config: state.report?.config || null,
    familyCounts: {
      all: safeArray(state.report?.families?.all).length,
      long: safeArray(state.report?.families?.long).length,
      short: safeArray(state.report?.families?.short).length,
      winnerCandidates: safeArray(state.report?.families?.winnerCandidates).length,
      topPnlFamilies: safeArray(state.report?.families?.topPnlFamilies).length,
    },
  }, null, 2);
}

function renderApiLink() {
  const apiLink = $("apiLink");
  if (!apiLink) return;

  apiLink.href = buildApiUrl({ debug: true });
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

    const updated = state.report.servedAt
      ? new Date(state.report.servedAt).toLocaleString()
      : new Date().toLocaleString();

    const summary = safeObject(state.report.summary);
    const families = safeObject(state.report.families);

    setStatus(
      `Laatste update: ${updated} | data ${state.report.dataState || "READY"} | actions ${fmtNum(summary.actions, 0)} | closed ${fmtNum(summary.closed, 0)} | families ${safeArray(families.ranked || families.all).length} | loaded in ${fmtNum(state.report.latencyMs || 0, 0)}ms`,
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
    state.timer = setInterval(() => loadAnalytics(), REFRESH_MS);
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
  $("refreshBtn")?.addEventListener("click", () => loadAnalytics({ force: true }));
  $("resetBtn")?.addEventListener("click", resetAnalytics);
  $("autoBtn")?.addEventListener("click", toggleAuto);

  document.querySelectorAll("[data-side]").forEach(button => {
    button.addEventListener("click", () => {
      setTab(button.dataset.side || "ALL");
    });
  });

  $("sideSelect")?.addEventListener("change", event => {
    state.activeTab = event.target.value || "ALL";
    syncTabs();
    renderFamilies();
  });

  $("statusSelect")?.addEventListener("change", renderFamilies);
  $("searchInput")?.addEventListener("input", renderFamilies);
  $("hideEmptyInput")?.addEventListener("change", renderFamilies);

  $("minClosedInput")?.addEventListener("input", () => {
    renderWinners();
    renderTopPnl();
    renderFamilies();
    scheduleReload();
  });

  $("minClosedInput")?.addEventListener("change", () => {
    renderWinners();
    renderTopPnl();
    renderFamilies();
    scheduleReload();
  });
}

function ensureDefaults() {
  const minClosedInput = $("minClosedInput");

  if (minClosedInput && (minClosedInput.value === "" || minClosedInput.value === "0")) {
    minClosedInput.value = String(DEFAULT_MIN_CLOSED);
  }

  renderApiLink();
}

document.addEventListener("DOMContentLoaded", async () => {
  ensureDefaults();
  wireEvents();
  syncTabs();
  await loadAnalytics({ force: true });
});