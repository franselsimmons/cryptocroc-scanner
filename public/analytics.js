const API_URL = "/api/analyze";
const REFRESH_MS = 30000;
const DEFAULT_MIN_CLOSED = 10;

let state = {
  raw: null,
  report: null,
  activeTab: "ALL",
  auto: false,
  timer: null,
  loading: false,
};

const QUALITY_BUCKETS = [
  ["Q1_WEAK", 1, ["CONF_0_50", "SNIPER_0_50", "RR_LT_1p00", "SCORE_0_50"]],
  ["Q2_LOW", 2, ["CONF_50_65", "SNIPER_50_65", "RR_1p00_1p20", "SCORE_50_65"]],
  ["Q3_BASE", 3, ["CONF_65_75", "SNIPER_65_75", "RR_1p20_1p50", "SCORE_65_75"]],
  ["Q4_STRONG", 4, ["CONF_75_85", "SNIPER_75_85", "RR_1p50_2p00", "SCORE_75_85"]],
  ["Q5_ELITE", 5, ["CONF_85_100", "SNIPER_85_100", "RR_2p00_PLUS", "SCORE_85_100"]],
].map(([key, index, labels]) => ({ key, index, labels }));

const MARKET_BUCKETS = [
  ["M1_DIRTY", 1, ["OB_REL_AGAINST", "SPREAD_GT_25BPS", "DEPTH_LT_10K", "BTC_REL_COUNTER", "FUNDING_CROWDED"]],
  ["M2_WEAK", 2, ["OB_REL_AGAINST_OR_NEUTRAL", "SPREAD_16_25BPS", "DEPTH_10K_50K", "BTC_REL_COUNTER", "FUNDING_EDGE_WEAK"]],
  ["M3_NORMAL", 3, ["OB_REL_NEUTRAL", "SPREAD_8_16BPS", "DEPTH_50K_100K", "BTC_REL_NEUTRAL", "FUNDING_NEUTRAL"]],
  ["M4_CLEAN", 4, ["OB_REL_WITH_OR_NEUTRAL", "SPREAD_5_12BPS", "DEPTH_100K_250K", "BTC_REL_WITH_OR_NEUTRAL", "FUNDING_OK"]],
  ["M5_PREMIUM", 5, ["OB_REL_WITH", "SPREAD_LT_8BPS", "DEPTH_GT_250K", "BTC_REL_WITH", "FUNDING_OPTIMAL"]],
].map(([key, index, labels]) => ({ key, index, labels }));

const TIMING_BUCKETS = [
  {
    key: "T1_EARLY_OR_NOISY",
    index: 1,
    long: ["STAGE_ANY", "FLOW_ANY", "RSI_ANY", "TF_ANY", "PULLBACK_NOT_REQUIRED"],
    short: ["STAGE_ANY", "FLOW_ANY", "RSI_ANY", "TF_ANY", "PULLBACK_NOT_REQUIRED"],
  },
  {
    key: "T2_TIMED",
    index: 2,
    long: ["STAGE_ENTRY_OR_ALMOST", "FLOW_TREND_OR_BUILDING", "RSI_LOWER_OR_MID", "TF_ALIGNED", "PULLBACK_OR_CONFIRMATION_OK"],
    short: ["STAGE_ENTRY_OR_ALMOST", "FLOW_TREND_OR_BUILDING", "RSI_UPPER_OR_MID", "TF_ALIGNED", "PULLBACK_OR_CONFIRMATION_OK"],
  },
];

function $(id) {
  return document.getElementById(id);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
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

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function setHidden(el, hidden) {
  if (!el) return;
  el.hidden = Boolean(hidden);
  el.classList.toggle("hidden", Boolean(hidden));
}

function setStatus(message, isError = false) {
  setText("statusLine", message);

  const box = $("errorBox");
  if (!box) return;

  setHidden(box, !isError);
  if (isError) box.textContent = `Load error:\n${message}`;
}

function setBusy(isBusy) {
  state.loading = Boolean(isBusy);

  const refreshBtn = $("refreshBtn");
  const resetBtn = $("resetBtn");

  if (refreshBtn) {
    refreshBtn.disabled = state.loading;
    refreshBtn.textContent = state.loading ? "Loading..." : "Refresh";
  }

  if (resetBtn) resetBtn.disabled = state.loading;
}

function getMinClosedValue() {
  const input = $("minClosedInput");
  const n = safeNumber(input?.value, DEFAULT_MIN_CLOSED);
  return Math.max(0, Math.round(n));
}

function buildApiUrl(extra = {}) {
  const params = new URLSearchParams();

  params.set("minClosed", String(getMinClosedValue()));
  params.set("debug", "true");
  params.set("cacheBust", String(Date.now()));

  if (extra.reset) {
    params.set("reset", "true");
    params.set("action", "reset");
  }

  return `${API_URL}?${params.toString()}`;
}

function normalizeSide(value) {
  const side = text(value).toUpperCase();

  if (side === "BULL" || side === "LONG" || side === "BUY") return "LONG";
  if (side === "BEAR" || side === "SHORT" || side === "SELL") return "SHORT";

  return side || "UNKNOWN";
}

function normalizeFamilyId(row) {
  return text(row.id || row.familyId || row.name).toUpperCase().trim();
}

function getFamilyIndex(qualityIndex, marketIndex, timingIndex) {
  return ((qualityIndex - 1) * 10) + ((marketIndex - 1) * 2) + timingIndex;
}

function buildDefinition(side, quality, market, timing) {
  const timingLabels = side === "SHORT" ? timing.short : timing.long;

  return [
    quality.key,
    market.key,
    timing.key,
    ...quality.labels,
    timingLabels[0],
    timingLabels[1],
    timingLabels[2],
    market.labels[0],
    market.labels[1],
    market.labels[2],
    market.labels[3],
    market.labels[4],
    timingLabels[3],
    timingLabels[4],
  ].join(" | ");
}

function buildLabels(side, quality, market, timing) {
  return buildDefinition(side, quality, market, timing)
    .split("|")
    .map(v => v.trim())
    .filter(Boolean);
}

function makeEmptyFamily(side, quality, market, timing) {
  const index = getFamilyIndex(quality.index, market.index, timing.index);
  const id = `${side}_${index}`;

  return {
    id,
    familyId: id,
    index,
    side,
    quality: quality.key,
    market: market.key,
    timing: timing.key,
    qualityIndex: quality.index,
    marketIndex: market.index,
    timingIndex: timing.index,
    definition: buildDefinition(side, quality, market, timing),
    labels: buildLabels(side, quality, market, timing),
    observed: 0,
    trades: 0,
    closed: 0,
    open: 0,
    pending: 0,
    pendingOutcome: 0,
    wins: 0,
    losses: 0,
    breakeven: 0,
    winrate: "0%",
    winrateNum: 0,
    totalR: 0,
    avgR: 0,
    totalPnlPct: 0,
    avgPnlPct: 0,
    grossWinR: 0,
    grossLossR: 0,
    profitFactor: 0,
    pf: 0,
    status: "EMPTY",
    score: 0,
    examples: [],
  };
}

function buildCanonicalFamilies() {
  const rows = [];

  for (const side of ["LONG", "SHORT"]) {
    for (const quality of QUALITY_BUCKETS) {
      for (const market of MARKET_BUCKETS) {
        for (const timing of TIMING_BUCKETS) {
          rows.push(makeEmptyFamily(side, quality, market, timing));
        }
      }
    }
  }

  return rows;
}

function normalizeWinrate(row) {
  if (Number.isFinite(Number(row.winrateNum))) {
    return safeNumber(row.winrateNum, 0);
  }

  const wr = text(row.winrate);

  if (wr.includes("%")) {
    return safeNumber(wr.replace("%", ""), 0) / 100;
  }

  const wins = safeNumber(row.wins, 0);
  const losses = safeNumber(row.losses, 0);

  if (wins + losses <= 0) return 0;

  return wins / (wins + losses);
}

function runnerStatus(row) {
  const minClosed = Math.max(1, getMinClosedValue());
  const observed = safeNumber(row.observed, 0);
  const closed = safeNumber(row.closed, 0);
  const avgR = safeNumber(row.avgR, 0);
  const totalR = safeNumber(row.totalR, 0);
  const pnl = safeNumber(row.totalPnlPct, 0);
  const wr = normalizeWinrate(row);
  const pf = safeNumber(row.pf || row.profitFactor, 0);

  if (observed <= 0) return "EMPTY";
  if (closed < minClosed) return "COLLECTING";
  if (pnl <= 0 || totalR <= 0 || avgR <= 0) return "BAD";

  if (wr >= 0.55 && avgR >= 0.25 && pf >= 1.6) return "HOT";
  if (wr >= 0.42 && avgR >= 0.10 && pf >= 1.2) return "GOOD";
  if (wr >= 0.30 && avgR > 0 && totalR > 0) return "STABLE";

  return "BAD";
}

function normalizeFamily(raw) {
  const row = safeObject(raw);
  const id = normalizeFamilyId(row);
  const side = normalizeSide(row.side);

  const closed = safeNumber(row.closed, safeNumber(row.trades, 0));
  const open = safeNumber(row.open, 0);
  const pending = safeNumber(row.pending ?? row.pendingOutcome ?? row.unresolved, 0);
  const winrateNum = normalizeWinrate(row);
  const labels = safeArray(row.labels);

  const normalized = {
    ...row,
    id,
    familyId: id,
    side,

    quality: text(row.quality || row.qualityBucket, "").toUpperCase(),
    market: text(row.market || row.marketBucket, "").toUpperCase(),
    timing: text(row.timing || row.timingBucket, "").toUpperCase(),

    qualityIndex: safeNumber(row.qualityIndex, 0),
    marketIndex: safeNumber(row.marketIndex, 0),
    timingIndex: safeNumber(row.timingIndex, 0),

    definition: text(row.definition || labels.join(" | "), "-"),
    labels: labels.length ? labels : text(row.definition).split("|").map(v => v.trim()).filter(Boolean),

    observed: safeNumber(row.observed, safeNumber(row.trades, closed + open + pending)),
    trades: safeNumber(row.trades, closed + open + pending),
    closed,
    open,
    pending,
    pendingOutcome: pending,

    wins: safeNumber(row.wins, 0),
    losses: safeNumber(row.losses, 0),
    breakeven: safeNumber(row.breakeven ?? row.be, 0),

    winrateNum,
    winrate: row.winrate || fmtPct(winrateNum * 100, 1),

    totalR: safeNumber(row.totalR, 0),
    avgR: safeNumber(row.avgR, 0),
    totalPnlPct: safeNumber(row.totalPnlPct, 0),
    avgPnlPct: safeNumber(row.avgPnlPct, 0),

    grossWinR: safeNumber(row.grossWinR, 0),
    grossLossR: safeNumber(row.grossLossR, 0),
    profitFactor: safeNumber(row.profitFactor ?? row.profitFactorR ?? row.pf, 0),
    pf: safeNumber(row.pf ?? row.profitFactor ?? row.profitFactorR, 0),

    score: safeNumber(row.score, 0),
    examples: safeArray(row.examples),
  };

  normalized.status = runnerStatus(normalized);

  return normalized;
}

function familyKey(row) {
  return `${normalizeSide(row.side)}_${normalizeFamilyId(row)}`;
}

function collectApiFamilies(payload) {
  const rows = [];

  rows.push(...safeArray(payload.families));
  rows.push(...safeArray(payload.winnerCandidates));
  rows.push(...safeArray(payload.winnerFamilies));

  const best = safeObject(payload.best);
  rows.push(best.bestLongByPnl);
  rows.push(best.bestShortByPnl);
  rows.push(best.topPnlFamily);
  rows.push(best.topTotalRFamily);
  rows.push(best.topWinrateFamily);

  const lb = safeObject(payload.leaderboards);
  rows.push(...safeArray(lb.topPnlFamilies));
  rows.push(...safeArray(lb.topTotalRFamilies));
  rows.push(...safeArray(lb.topWinrateFamilies));

  const matrix = safeObject(payload.familyPerformanceMatrix);
  rows.push(...safeArray(matrix?.long?.families));
  rows.push(...safeArray(matrix?.long?.rows));
  rows.push(...safeArray(matrix?.short?.families));
  rows.push(...safeArray(matrix?.short?.rows));

  return rows.filter(Boolean);
}

function mergeFamily(base, incoming) {
  const row = normalizeFamily(incoming);

  return normalizeFamily({
    ...base,
    ...row,
    id: row.id || base.id,
    familyId: row.familyId || base.familyId,
    side: row.side || base.side,
    definition: row.definition && row.definition !== "-" ? row.definition : base.definition,
    labels: safeArray(row.labels).length ? row.labels : base.labels,
    quality: row.quality || base.quality,
    market: row.market || base.market,
    timing: row.timing || base.timing,
    qualityIndex: row.qualityIndex || base.qualityIndex,
    marketIndex: row.marketIndex || base.marketIndex,
    timingIndex: row.timingIndex || base.timingIndex,
  });
}

function buildFamilies(payload) {
  const map = new Map();

  for (const family of buildCanonicalFamilies()) {
    map.set(familyKey(family), family);
  }

  for (const rawFamily of collectApiFamilies(payload)) {
    const row = normalizeFamily(rawFamily);
    if (!row.id) continue;

    const key = familyKey(row);
    const base = map.get(key) || row;

    map.set(key, mergeFamily(base, row));
  }

  return Array.from(map.values()).map(normalizeFamily);
}

function pnlSort(a, b) {
  const rank = { HOT: 6, GOOD: 5, STABLE: 4, COLLECTING: 3, BAD: 2, EMPTY: 1 };

  const statusDiff = (rank[b.status] || 0) - (rank[a.status] || 0);
  if (statusDiff !== 0) return statusDiff;

  const pnl = safeNumber(b.totalPnlPct, 0) - safeNumber(a.totalPnlPct, 0);
  if (pnl !== 0) return pnl;

  const totalR = safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0);
  if (totalR !== 0) return totalR;

  const avgR = safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0);
  if (avgR !== 0) return avgR;

  const pf = safeNumber(b.pf || b.profitFactor, 0) - safeNumber(a.pf || a.profitFactor, 0);
  if (pf !== 0) return pf;

  const closed = safeNumber(b.closed, 0) - safeNumber(a.closed, 0);
  if (closed !== 0) return closed;

  return text(a.id).localeCompare(text(b.id));
}

function countStatuses(rows) {
  const out = { HOT: 0, GOOD: 0, STABLE: 0, BAD: 0, COLLECTING: 0, EMPTY: 0 };

  for (const row of safeArray(rows)) {
    const s = text(row.status, "EMPTY").toUpperCase();
    out[s] = safeNumber(out[s], 0) + 1;
  }

  return out;
}

function statusMeta(rows) {
  const c = countStatuses(rows);
  return `HOT ${c.HOT} | GOOD ${c.GOOD} | STABLE ${c.STABLE} | BAD ${c.BAD} | COLLECTING ${c.COLLECTING} | EMPTY ${c.EMPTY}`;
}

function normalizePayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Geen geldig JSON-object.");
  }

  if (!payload.ok) {
    throw payload;
  }

  const families = buildFamilies(payload).sort(pnlSort);
  const longFamilies = families.filter(row => row.side === "LONG").sort(pnlSort);
  const shortFamilies = families.filter(row => row.side === "SHORT").sort(pnlSort);
  const stats = safeObject(payload.stats);

  return {
    raw: payload,
    report: {
      dataState: payload.dataState || "UNKNOWN",
      latencyMs: safeNumber(payload.latencyMs, 0),
      generatedAt: payload.servedAt || Date.now(),
      summary: {
        actions: safeNumber(stats.actions, 0),
        trades: safeNumber(stats.trades, 0),
        open: safeNumber(stats.open, 0),
        closed: safeNumber(stats.closed, 0),
        pendingOutcome: safeNumber(stats.pendingOutcome, 0),
        wins: safeNumber(stats.wins, 0),
        losses: safeNumber(stats.losses, 0),
        breakeven: safeNumber(stats.breakeven, 0),
        winrate: stats.winrate || "0%",
        winrateNum: safeNumber(stats.winrateNum, 0),
        totalR: safeNumber(stats.totalR, 0),
        avgR: safeNumber(stats.avgR, 0),
        totalPnlPct: safeNumber(stats.totalPnlPct, 0),
        avgPnlPct: safeNumber(stats.avgPnlPct, 0),
      },
      sources: {
        store: payload.source || {},
        latest: payload.latest || {},
        storedEvents: safeNumber(payload?.store?.count, 0),
        latestEvents: safeNumber(payload?.latest?.count, 0),
        mergedEvents: safeNumber(payload?.merged?.count, 0),
      },
      families: {
        all: families,
        ranked: families,
        long: longFamilies,
        short: shortFamilies,
      },
    },
  };
}

async function fetchJson(url) {
  const res = await fetch(url, {
    method: "GET",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });

  const contentType = res.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await res.json()
    : { ok: false, error: await res.text() };

  if (!res.ok) throw payload;

  return payload;
}

function renderSummary() {
  const s = state.report?.summary || {};
  const longRows = safeArray(state.report?.families?.long);
  const shortRows = safeArray(state.report?.families?.short);

  setText("mActions", fmtNum(s.actions, 0));
  setText("mTrades", fmtNum(s.trades, 0));
  setText("mOpen", fmtNum(s.open, 0));
  setText("mClosed", fmtNum(s.closed, 0));
  setText("mPending", fmtNum(s.pendingOutcome, 0));
  setText("mWins", fmtNum(s.wins, 0));
  setText("mLosses", fmtNum(s.losses, 0));
  setText("mBreakeven", fmtNum(s.breakeven, 0));
  setText("mWinrate", s.winrate || "0%");
  setText("mTotalR", fmtNum(s.totalR, 3));
  setText("mAvgR", fmtNum(s.avgR, 3));
  setText("mTotalPnl", fmtPct(s.totalPnlPct, 3));

  setText("mLongFamilies", fmtNum(longRows.length || 50, 0));
  setText("mShortFamilies", fmtNum(shortRows.length || 50, 0));
  setText("mLongMeta", statusMeta(longRows));
  setText("mShortMeta", statusMeta(shortRows));
}

function renderSourceCards() {
  const raw = state.raw || {};
  const src = state.report?.sources || {};

  setText("sStoreCount", fmtNum(src.storedEvents, 0));
  setText("sLatestCount", fmtNum(src.latestEvents, 0));
  setText("sMergedCount", fmtNum(src.mergedEvents, 0));
  setText("sDataState", state.report?.dataState || "UNKNOWN");

  setText("sStorePath", src.store?.path ? `store: ${src.store.path}` : `store: ${src.store?.storeSource || "n/a"}`);
  setText("sLatestTime", src.latest?.note || "latest scan OK");
  setText("sGeneratedAt", raw.servedAt ? new Date(raw.servedAt).toLocaleString() : "-");
  setText("sLatency", `${fmtNum(raw.latencyMs, 0)}ms`);
}

function getBaseFamilies() {
  const families = state.report?.families || {};

  if (state.activeTab === "LONG") return safeArray(families.long);
  if (state.activeTab === "SHORT") return safeArray(families.short);

  return safeArray(families.ranked);
}

function getSelectedFamilies() {
  const side = $("sideSelect")?.value || "ALL";
  const status = $("statusSelect")?.value || "ALL";
  const query = text($("searchInput")?.value).toUpperCase().trim();
  const hideEmpty = Boolean($("hideEmptyInput")?.checked);

  let rows = getBaseFamilies();

  if (side === "LONG") rows = rows.filter(row => row.side === "LONG");
  if (side === "SHORT") rows = rows.filter(row => row.side === "SHORT");

  if (status !== "ALL") rows = rows.filter(row => row.status === status);
  if (hideEmpty) rows = rows.filter(row => row.status !== "EMPTY" && safeNumber(row.observed, 0) > 0);

  if (query) {
    rows = rows.filter(row => {
      const haystack = [
        row.id,
        row.side,
        row.status,
        row.quality,
        row.market,
        row.timing,
        row.definition,
        ...safeArray(row.labels),
      ].join(" ").toUpperCase();

      return haystack.includes(query);
    });
  }

  return [...rows].sort(pnlSort);
}

function renderFamilies() {
  const tbody = $("familyBody");
  const empty = $("emptyState");
  if (!tbody) return;

  const rows = getSelectedFamilies();

  setText("familyCount", `${rows.length} rows`);
  setHidden(empty, rows.length > 0);

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="21" class="empty-row">Geen families voor deze filterselectie.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(row => {
    return `
      <tr class="${statusClass(row.status)}">
        <td><span class="family-id">${escapeHtml(row.id)}</span></td>
        <td><span class="side-pill ${text(row.side).toLowerCase()}">${escapeHtml(row.side)}</span></td>
        <td>${escapeHtml(row.quality || "-")}</td>
        <td>${escapeHtml(row.market || "-")}</td>
        <td>${escapeHtml(row.timing || "-")}</td>
        <td class="definition">${escapeHtml(row.definition)}</td>
        <td class="num">${fmtNum(row.observed, 0)}</td>
        <td class="num">${fmtNum(row.trades, 0)}</td>
        <td class="num">${fmtNum(row.closed, 0)}</td>
        <td class="num">${fmtNum(row.open, 0)}</td>
        <td class="num pending">${fmtNum(row.pendingOutcome, 0)}</td>
        <td class="num">${fmtNum(row.wins, 0)}</td>
        <td class="num">${fmtNum(row.losses, 0)}</td>
        <td class="num">${fmtNum(row.breakeven, 0)}</td>
        <td class="num">${escapeHtml(row.winrate)}</td>
        <td class="num ${signedClass(row.totalR)}">${fmtNum(row.totalR, 3)}</td>
        <td class="num ${signedClass(row.avgR)}">${fmtNum(row.avgR, 3)}</td>
        <td class="num ${signedClass(row.totalPnlPct)}">${fmtPct(row.totalPnlPct, 3)}</td>
        <td class="num ${signedClass(row.avgPnlPct)}">${fmtPct(row.avgPnlPct, 3)}</td>
        <td class="num">${fmtNum(row.pf || row.profitFactor, 3)}</td>
        <td><span class="status-pill ${statusClass(row.status)}">${escapeHtml(row.status)}</span></td>
      </tr>
    `;
  }).join("");
}

function getWinnerRows() {
  const minClosed = Math.max(1, getMinClosedValue());

  return safeArray(state.report?.families?.ranked)
    .filter(row => safeNumber(row.closed, 0) >= minClosed)
    .filter(row => ["HOT", "GOOD", "STABLE"].includes(row.status))
    .filter(row => safeNumber(row.totalPnlPct, 0) > 0)
    .sort((a, b) => {
      const pnl = safeNumber(b.totalPnlPct, 0) - safeNumber(a.totalPnlPct, 0);
      if (pnl !== 0) return pnl;

      const r = safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0);
      if (r !== 0) return r;

      return safeNumber(b.closed, 0) - safeNumber(a.closed, 0);
    })
    .slice(0, 8);
}

function getTopPnlRows() {
  return safeArray(state.report?.families?.ranked)
    .filter(row => row.status !== "EMPTY")
    .filter(row => safeNumber(row.observed, 0) > 0)
    .sort((a, b) => {
      const pnl = safeNumber(b.totalPnlPct, 0) - safeNumber(a.totalPnlPct, 0);
      if (pnl !== 0) return pnl;

      return safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0);
    })
    .slice(0, 8);
}

function renderCardGrid(id, rows, emptyText) {
  const grid = $(id);
  if (!grid) return;

  if (!rows.length) {
    grid.innerHTML = `<article class="winner-empty">${escapeHtml(emptyText)}</article>`;
    return;
  }

  grid.innerHTML = rows.map(row => `
    <article class="winner-card ${text(row.status).toLowerCase()}">
      <div class="winner-top">
        <span class="winner-id">${escapeHtml(row.id)}</span>
        <span class="status-pill ${statusClass(row.status)}">${escapeHtml(row.status)}</span>
      </div>

      <div class="winner-stats">
        <div class="winner-stat"><span>Closed</span><strong>${fmtNum(row.closed, 0)}</strong></div>
        <div class="winner-stat"><span>Winrate</span><strong>${escapeHtml(row.winrate)}</strong></div>
        <div class="winner-stat"><span>Total R</span><strong class="${signedClass(row.totalR)}">${fmtNum(row.totalR, 3)}</strong></div>
        <div class="winner-stat"><span>Avg R</span><strong class="${signedClass(row.avgR)}">${fmtNum(row.avgR, 3)}</strong></div>
        <div class="winner-stat"><span>PnL%</span><strong class="${signedClass(row.totalPnlPct)}">${fmtPct(row.totalPnlPct, 3)}</strong></div>
        <div class="winner-stat"><span>PF</span><strong>${fmtNum(row.pf || row.profitFactor, 3)}</strong></div>
      </div>

      <p class="winner-definition">${escapeHtml(row.definition)}</p>
    </article>
  `).join("");
}

function renderWinners() {
  const winners = getWinnerRows();
  const topPnl = getTopPnlRows();

  setText("winnerCount", `${winners.length} winners`);
  setText("topPnlCount", `${topPnl.length} families`);

  renderCardGrid("winnerGrid", winners, `Nog geen PnL-winner. Nodig: min ${getMinClosedValue()} closed, positieve PnL/AvgR/TotalR.`);
  renderCardGrid("topPnlGrid", topPnl, "Nog geen PnL families.");
}

function renderFilters() {
  const body = $("filtersBody");
  if (!body) return;

  const chips = [
    "quality", "market", "timing", "confluence", "sniperScore", "rr", "score", "stage", "flow",
    "rsiZone", "obBias", "spread", "depth", "btcRel", "funding", "tfAlignment", "pullbackConfirmation",
    ...QUALITY_BUCKETS.map(x => x.key),
    ...MARKET_BUCKETS.map(x => x.key),
    ...TIMING_BUCKETS.map(x => x.key),
  ];

  setText("filterCount", `${chips.length} labels`);

  body.innerHTML = chips.map(chip => `
    <span class="filter-chip"><b>LABEL</b>${escapeHtml(chip)}</span>
  `).join("");
}

function renderDebug() {
  const el = $("debugJson");
  if (!el) return;

  el.textContent = JSON.stringify({
    endpoint: state.raw?.endpoint,
    objective: state.raw?.objective,
    strategy: state.raw?.strategy,
    dataState: state.raw?.dataState,
    source: state.raw?.source,
    store: state.raw?.store,
    latest: state.raw?.latest,
    merged: state.raw?.merged,
    stats: state.raw?.stats,
  }, null, 2);
}

function renderApiLink() {
  const link = $("apiLink");
  if (link) link.href = buildApiUrl();
}

function render() {
  renderSummary();
  renderSourceCards();
  renderWinners();
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
    const payload = await fetchJson(buildApiUrl());
    const normalized = normalizePayload(payload);

    state.raw = normalized.raw;
    state.report = normalized.report;

    const s = state.report.summary;
    const updated = new Date(state.report.generatedAt).toLocaleString();

    setStatus(
      `Laatste update: ${updated} | actions ${fmtNum(s.actions, 0)} | closed ${fmtNum(s.closed, 0)} | pnl ${fmtPct(s.totalPnlPct, 3)}`,
      false
    );

    render();
  } catch (error) {
    console.error("RUNNER ANALYZE LOAD ERROR:", error);
    setStatus(error?.message || error?.error || JSON.stringify(error), true);
  } finally {
    setBusy(false);
  }
}

async function resetAnalytics() {
  const ok = window.confirm("Runner analyse-store resetten?");
  if (!ok) return;

  setBusy(true);
  setStatus("Reset bezig...", false);

  try {
    await fetchJson(buildApiUrl({ reset: true }));
    await loadAnalytics({ force: true });
  } catch (error) {
    console.error("RUNNER ANALYZE RESET ERROR:", error);
    setStatus(error?.message || error?.error || JSON.stringify(error), true);
  } finally {
    setBusy(false);
  }
}

function syncTabs() {
  document.querySelectorAll("[data-side]").forEach(btn => {
    const side = btn.dataset.side || "ALL";
    btn.classList.toggle("active", side === state.activeTab);
  });
}

function setTab(side) {
  state.activeTab = side || "ALL";

  const select = $("sideSelect");
  if (select) select.value = state.activeTab;

  syncTabs();
  renderFamilies();
}

function toggleAuto() {
  state.auto = !state.auto;

  const btn = $("autoBtn");
  if (btn) btn.textContent = `Auto: ${state.auto ? "ON" : "OFF"}`;

  if (state.timer) clearInterval(state.timer);
  state.timer = null;

  if (state.auto) {
    state.timer = setInterval(loadAnalytics, REFRESH_MS);
  }
}

let reloadTimer = null;

function scheduleReload() {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => loadAnalytics(), 350);
}

function wireEvents() {
  $("refreshBtn")?.addEventListener("click", () => loadAnalytics());
  $("resetBtn")?.addEventListener("click", resetAnalytics);
  $("autoBtn")?.addEventListener("click", toggleAuto);

  document.querySelectorAll("[data-side]").forEach(btn => {
    btn.addEventListener("click", () => setTab(btn.dataset.side || "ALL"));
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
    renderFamilies();
    renderWinners();
    scheduleReload();
  });
}

function initParams() {
  const params = new URLSearchParams(window.location.search);
  const minClosed = params.get("minClosed");
  const input = $("minClosedInput");

  if (input && minClosed) {
    input.value = String(Math.max(0, Math.round(safeNumber(minClosed, DEFAULT_MIN_CLOSED))));
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  initParams();
  wireEvents();
  syncTabs();
  renderApiLink();
  await loadAnalytics();
});