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

const QUALITY_BUCKETS = [
  {
    index: 1,
    key: "Q1_WEAK",
    labels: ["CONF_0_50", "SNIPER_0_50", "RR_LT_1p00", "SCORE_0_50"],
  },
  {
    index: 2,
    key: "Q2_LOW",
    labels: ["CONF_50_65", "SNIPER_50_65", "RR_1p00_1p20", "SCORE_50_65"],
  },
  {
    index: 3,
    key: "Q3_BASE",
    labels: ["CONF_65_75", "SNIPER_65_75", "RR_1p20_1p50", "SCORE_65_75"],
  },
  {
    index: 4,
    key: "Q4_STRONG",
    labels: ["CONF_75_85", "SNIPER_75_85", "RR_1p50_2p00", "SCORE_75_85"],
  },
  {
    index: 5,
    key: "Q5_ELITE",
    labels: ["CONF_85_100", "SNIPER_85_100", "RR_2p00_PLUS", "SCORE_85_100"],
  },
];

const MARKET_BUCKETS = [
  {
    index: 1,
    key: "M1_DIRTY",
    labels: ["OB_REL_AGAINST", "SPREAD_GT_25BPS", "DEPTH_LT_10K", "BTC_REL_COUNTER", "FUNDING_CROWDED"],
  },
  {
    index: 2,
    key: "M2_WEAK",
    labels: ["OB_REL_AGAINST_OR_NEUTRAL", "SPREAD_16_25BPS", "DEPTH_10K_50K", "BTC_REL_COUNTER", "FUNDING_EDGE_WEAK"],
  },
  {
    index: 3,
    key: "M3_NORMAL",
    labels: ["OB_REL_NEUTRAL", "SPREAD_8_16BPS", "DEPTH_50K_100K", "BTC_REL_NEUTRAL", "FUNDING_NEUTRAL"],
  },
  {
    index: 4,
    key: "M4_CLEAN",
    labels: ["OB_REL_WITH_OR_NEUTRAL", "SPREAD_5_12BPS", "DEPTH_100K_250K", "BTC_REL_WITH_OR_NEUTRAL", "FUNDING_OK"],
  },
  {
    index: 5,
    key: "M5_PREMIUM",
    labels: ["OB_REL_WITH", "SPREAD_LT_8BPS", "DEPTH_GT_250K", "BTC_REL_WITH", "FUNDING_OPTIMAL"],
  },
];

const TIMING_BUCKETS = [
  {
    index: 1,
    key: "T1_EARLY_OR_NOISY",
    labelsLong: ["STAGE_ANY", "FLOW_ANY", "RSI_ANY", "TF_ANY", "PULLBACK_NOT_REQUIRED"],
    labelsShort: ["STAGE_ANY", "FLOW_ANY", "RSI_ANY", "TF_ANY", "PULLBACK_NOT_REQUIRED"],
  },
  {
    index: 2,
    key: "T2_TIMED",
    labelsLong: ["STAGE_ENTRY_OR_ALMOST", "FLOW_TREND_OR_BUILDING", "RSI_LOWER_OR_MID", "TF_ALIGNED", "PULLBACK_OR_CONFIRMATION_OK"],
    labelsShort: ["STAGE_ENTRY_OR_ALMOST", "FLOW_TREND_OR_BUILDING", "RSI_UPPER_OR_MID", "TF_ALIGNED", "PULLBACK_OR_CONFIRMATION_OK"],
  },
];

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

function sideClass(side) {
  return text(side, "").toLowerCase();
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

function buildApiUrl(extra = {}) {
  const params = new URLSearchParams();

  params.set("minClosed", String(getMinClosedValue()));
  params.set("debug", extra.debug === false ? "false" : "true");
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

function normalizeStatus(value) {
  const status = text(value, "EMPTY").toUpperCase();

  if (["HOT", "GOOD", "STABLE", "BAD", "COLLECTING", "EMPTY"].includes(status)) {
    return status;
  }

  return "EMPTY";
}

function getFamilyIndex(qualityIndex, marketIndex, timingIndex) {
  return ((qualityIndex - 1) * 10) + ((marketIndex - 1) * 2) + timingIndex;
}

function buildDefinition({ side, quality, market, timing }) {
  const timingLabels = side === "SHORT" ? timing.labelsShort : timing.labelsLong;

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

function buildLabels({ side, quality, market, timing }) {
  const timingLabels = side === "SHORT" ? timing.labelsShort : timing.labelsLong;

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
  ];
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
    qualityBucket: quality.key,
    qualityIndex: quality.index,
    market: market.key,
    marketBucket: market.key,
    marketIndex: market.index,
    timing: timing.key,
    timingBucket: timing.key,
    timingIndex: timing.index,
    definition: buildDefinition({ side, quality, market, timing }),
    labels: buildLabels({ side, quality, market, timing }),

    observed: 0,
    trades: 0,
    closed: 0,
    open: 0,
    pending: 0,
    pendingOutcome: 0,
    unresolved: 0,
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
    profitFactorR: 0,
    pf: 0,
    avgMfeR: 0,
    avgMaeR: 0,
    status: "EMPTY",
    score: 0,
    examples: [],
  };
}

function buildCanonicalFamilies() {
  const out = [];

  for (const side of ["LONG", "SHORT"]) {
    for (const quality of QUALITY_BUCKETS) {
      for (const market of MARKET_BUCKETS) {
        for (const timing of TIMING_BUCKETS) {
          out.push(makeEmptyFamily(side, quality, market, timing));
        }
      }
    }
  }

  return out;
}

function normalizeWinrateNumber(row) {
  if (Number.isFinite(Number(row.winrateNum))) {
    return safeNumber(row.winrateNum, 0);
  }

  const wr = text(row.winrate);

  if (wr.includes("%")) {
    return safeNumber(wr.replace("%", ""), 0) / 100;
  }

  const wins = safeNumber(row.wins, 0);
  const losses = safeNumber(row.losses, 0);
  const denom = wins + losses;

  if (denom <= 0) return 0;

  return wins / denom;
}

function getFamilyId(row) {
  return text(row.id || row.familyId || row.name).toUpperCase();
}

function normalizeFamily(raw) {
  const row = safeObject(raw);
  const id = getFamilyId(row);
  const side = normalizeSide(row.side);
  const labels = safeArray(row.labels);
  const definition = text(row.definition || labels.join(" | "), "-");

  const closed = safeNumber(row.closed, safeNumber(row.trades, 0));
  const open = safeNumber(row.open, 0);
  const pending = safeNumber(row.pending ?? row.pendingOutcome ?? row.unresolved, 0);
  const wins = safeNumber(row.wins, 0);
  const losses = safeNumber(row.losses, 0);
  const breakeven = safeNumber(row.breakeven ?? row.be, 0);
  const winrateNum = normalizeWinrateNumber(row);
  const profitFactor = safeNumber(row.profitFactor ?? row.profitFactorR ?? row.pf, 0);

  return {
    ...row,

    id,
    familyId: id,
    side,

    quality: text(row.quality || row.qualityBucket).toUpperCase(),
    qualityBucket: text(row.qualityBucket || row.quality).toUpperCase(),
    qualityIndex: safeNumber(row.qualityIndex, 0),

    market: text(row.market || row.marketBucket).toUpperCase(),
    marketBucket: text(row.marketBucket || row.market).toUpperCase(),
    marketIndex: safeNumber(row.marketIndex, 0),

    timing: text(row.timing || row.timingBucket).toUpperCase(),
    timingBucket: text(row.timingBucket || row.timing).toUpperCase(),
    timingIndex: safeNumber(row.timingIndex, 0),

    definition,
    labels: labels.length ? labels : definition.split("|").map(x => x.trim()).filter(Boolean),

    observed: safeNumber(row.observed, safeNumber(row.trades, closed + open + pending)),
    trades: safeNumber(row.trades, closed + open + pending),
    closed,
    open,
    pending,
    pendingOutcome: pending,
    unresolved: pending,

    wins,
    losses,
    breakeven,

    winrateNum,
    winrate: row.winrate || fmtPct(winrateNum * 100, 1),

    totalR: safeNumber(row.totalR, 0),
    avgR: safeNumber(row.avgR, 0),
    totalPnlPct: safeNumber(row.totalPnlPct, 0),
    avgPnlPct: safeNumber(row.avgPnlPct, 0),

    grossWinR: safeNumber(row.grossWinR, 0),
    grossLossR: safeNumber(row.grossLossR, 0),
    profitFactor,
    profitFactorR: profitFactor,
    pf: profitFactor,

    avgMfeR: safeNumber(row.avgMfeR, 0),
    avgMaeR: safeNumber(row.avgMaeR, 0),

    status: normalizeStatus(row.status),
    score: safeNumber(row.score, 0),
    examples: safeArray(row.examples),
  };
}

function familyKey(row) {
  return `${normalizeSide(row.side)}_${getFamilyId(row)}`;
}

function mergeFamily(base, incoming) {
  const normalized = normalizeFamily(incoming);

  return {
    ...base,
    ...normalized,

    id: normalized.id || base.id,
    familyId: normalized.familyId || base.familyId,
    side: normalized.side || base.side,

    quality: normalized.quality || base.quality,
    qualityBucket: normalized.qualityBucket || base.qualityBucket,
    qualityIndex: normalized.qualityIndex || base.qualityIndex,

    market: normalized.market || base.market,
    marketBucket: normalized.marketBucket || base.marketBucket,
    marketIndex: normalized.marketIndex || base.marketIndex,

    timing: normalized.timing || base.timing,
    timingBucket: normalized.timingBucket || base.timingBucket,
    timingIndex: normalized.timingIndex || base.timingIndex,

    definition: normalized.definition && normalized.definition !== "-"
      ? normalized.definition
      : base.definition,

    labels: safeArray(normalized.labels).length
      ? normalized.labels
      : base.labels,
  };
}

function collectApiFamilies(payload) {
  const out = [];

  out.push(...safeArray(payload?.families));
  out.push(...safeArray(payload?.winnerCandidates));
  out.push(...safeArray(payload?.winnerFamilies));

  const best = safeObject(payload?.best);
  out.push(best.bestLongByPnl);
  out.push(best.bestShortByPnl);
  out.push(best.topPnlFamily);
  out.push(best.topTotalRFamily);
  out.push(best.topWinrateFamily);

  const lb = safeObject(payload?.leaderboards);
  out.push(...safeArray(lb.topPnlFamilies));
  out.push(...safeArray(lb.topTotalRFamilies));
  out.push(...safeArray(lb.topWinrateFamilies));

  const matrix = safeObject(payload?.familyPerformanceMatrix);
  out.push(...safeArray(matrix?.long?.families));
  out.push(...safeArray(matrix?.long?.rows));
  out.push(...safeArray(matrix?.short?.families));
  out.push(...safeArray(matrix?.short?.rows));

  return out.filter(Boolean);
}

function buildFamilies(payload) {
  const canonical = buildCanonicalFamilies();
  const map = new Map();

  for (const family of canonical) {
    map.set(familyKey(family), family);
  }

  for (const rawFamily of collectApiFamilies(payload)) {
    const family = normalizeFamily(rawFamily);
    if (!family.id) continue;

    const key = familyKey(family);
    const base = map.get(key) || makeEmptyFromIncoming(family);

    map.set(key, mergeFamily(base, family));
  }

  return Array.from(map.values()).map(row => normalizeFamily(row));
}

function makeEmptyFromIncoming(row) {
  const side = normalizeSide(row.side);
  const id = getFamilyId(row);

  return {
    id,
    familyId: id,
    side,
    definition: row.definition || "-",
    labels: safeArray(row.labels),
    status: "EMPTY",
  };
}

function pnlSort(a, b) {
  const statusRank = {
    HOT: 6,
    GOOD: 5,
    STABLE: 4,
    COLLECTING: 3,
    BAD: 2,
    EMPTY: 1,
  };

  const statusDiff = (statusRank[b.status] || 0) - (statusRank[a.status] || 0);
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

  const side = text(a.side).localeCompare(text(b.side));
  if (side !== 0) return side;

  return safeNumber(a.index, 0) - safeNumber(b.index, 0);
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

function normalizePayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("API gaf geen geldig JSON-object terug.");
  }

  if (!payload.ok) {
    throw payload;
  }

  const allFamilies = buildFamilies(payload).sort(pnlSort);
  const longFamilies = allFamilies.filter(row => row.side === "LONG").sort(pnlSort);
  const shortFamilies = allFamilies.filter(row => row.side === "SHORT").sort(pnlSort);

  const stats = safeObject(payload.stats);

  const summary = {
    actions: safeNumber(stats.actions, 0),
    trades: safeNumber(stats.trades, 0),
    open: safeNumber(stats.open, 0),
    closed: safeNumber(stats.closed, 0),
    pendingOutcome: safeNumber(stats.pendingOutcome, 0),
    wins: safeNumber(stats.wins, 0),
    losses: safeNumber(stats.losses, 0),
    breakeven: safeNumber(stats.breakeven, 0),
    winrateNum: safeNumber(stats.winrateNum, 0),
    winrate: stats.winrate || "0%",
    totalR: safeNumber(stats.totalR, 0),
    avgR: safeNumber(stats.avgR, 0),
    totalPnlPct: safeNumber(stats.totalPnlPct, 0),
    avgPnlPct: safeNumber(stats.avgPnlPct, 0),
    longFamilies: longFamilies.length,
    shortFamilies: shortFamilies.length,
  };

  const sources = {
    storedEvents: safeNumber(payload?.store?.count, 0),
    latestEvents: safeNumber(payload?.latest?.count, 0),
    mergedEvents: safeNumber(payload?.merged?.count, 0),
    store: payload.source || {},
    latest: payload.latest || {},
  };

  return {
    raw: payload,
    report: {
      profile: payload.profile || "RUNNER",
      endpoint: payload.endpoint || "/api/analyze",
      objective: payload.objective || "RUNNER_PNL_FIRST",
      strategy: payload.strategy || "50_LONG_FAMILIES_PLUS_50_SHORT_FAMILIES",
      dataState: payload.dataState || "UNKNOWN",
      generatedAt: payload.servedAt || Date.now(),
      latencyMs: safeNumber(payload.latencyMs, 0),
      config: payload.config || {},
      diagnostics: {
        store: payload.store || {},
        latest: payload.latest || {},
        merged: payload.merged || {},
      },
      summary,
      sources,
      families: {
        all: allFamilies,
        long: longFamilies,
        short: shortFamilies,
        ranked: allFamilies,
        best: getPnlWinnerFamilies(allFamilies),
        worst: [...allFamilies].reverse(),
      },
      filterValues: buildFilterValues(),
    },
  };
}

function buildFilterValues() {
  return {
    trackedFields: [
      "quality",
      "market",
      "timing",
      "confluence",
      "sniperScore",
      "rr",
      "score",
      "stage",
      "flow",
      "rsiZone",
      "obBias",
      "spread",
      "depth",
      "btcRel",
      "funding",
      "tfAlignment",
      "pullbackConfirmation",
    ],
    qualityBuckets: Object.fromEntries(QUALITY_BUCKETS.map(bucket => [bucket.key, bucket])),
    marketBuckets: Object.fromEntries(MARKET_BUCKETS.map(bucket => [bucket.key, bucket])),
    timingBuckets: Object.fromEntries(TIMING_BUCKETS.map(bucket => [bucket.key, bucket])),
  };
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

function renderSummary() {
  const summary = state.report?.summary || {};
  const longFamilies = safeArray(state.report?.families?.long);
  const shortFamilies = safeArray(state.report?.families?.short);

  setText(["mActions", "kpiActions"], fmtNum(summary.actions || 0, 0));
  setText(["mTrades", "kpiTrades"], fmtNum(summary.trades || summary.observed || 0, 0));
  setText(["mOpen", "kpiOpen"], fmtNum(summary.open || 0, 0));
  setText(["mClosed", "kpiClosed"], fmtNum(summary.closed || 0, 0));
  setText(["mPending", "kpiPending"], fmtNum(summary.pendingOutcome || summary.unresolved || 0, 0));
  setText(["mWins", "kpiWins"], fmtNum(summary.wins || 0, 0));
  setText(["mLosses", "kpiLosses"], fmtNum(summary.losses || 0, 0));
  setText(["mBreakeven", "kpiBreakeven"], fmtNum(summary.breakeven || 0, 0));
  setText(["mWinrate", "kpiWinrate"], summary.winrate || fmtPct(summary.winrateNum || 0));
  setText(["mTotalR", "kpiTotalR"], fmtNum(summary.totalR || 0, 3));
  setText(["mAvgR", "kpiAvgR"], fmtNum(summary.avgR || 0, 3));
  setText(["mTotalPnl", "kpiPnl"], fmtPct(summary.totalPnlPct || 0, 3));

  setText(["mLongFamilies", "kpiLongFamilies"], fmtNum(longFamilies.length || 50, 0));
  setText(["mShortFamilies", "kpiShortFamilies"], fmtNum(shortFamilies.length || 50, 0));

  setText(["mLongMeta", "longFamiliesMeta"], familyMetaText(longFamilies));
  setText(["mShortMeta", "shortFamiliesMeta"], familyMetaText(shortFamilies));
}

function renderSourceCards() {
  const raw = state.raw || {};
  const report = state.report || {};
  const sources = report.sources || {};
  const latest = sources.latest || {};
  const store = sources.store || {};

  setText(["sStoreCount", "sourceStored"], fmtNum(sources.storedEvents ?? raw?.store?.count ?? 0, 0));
  setText(["sLatestCount", "sourceLatest"], fmtNum(sources.latestEvents ?? raw?.latest?.count ?? 0, 0));
  setText(["sMergedCount", "sourceMerged"], fmtNum(sources.mergedEvents ?? raw?.merged?.count ?? 0, 0));
  setText(["sDataState", "sourceDataState"], report.dataState || raw.dataState || "UNKNOWN");

  setText(["sStorePath", "sourceStoredSub"], store.path ? `store: ${store.path}` : `store: ${raw?.source?.storeSource || "n/a"}`);
  setText(["sLatestTime", "sourceLatestSub"], latest.note || "latest scan OK");
  setText(["sGeneratedAt", "sourceMergedSub"], raw.servedAt ? new Date(raw.servedAt).toLocaleString() : "");
  setText(["sLatency", "sourceLatency"], `${fmtNum(raw.latencyMs ?? 0, 0)}ms`);
}

function getBaseFamilies() {
  const families = state.report?.families || {};

  if (state.activeTab === "LONG") return safeArray(families.long);
  if (state.activeTab === "SHORT") return safeArray(families.short);

  return safeArray(families.ranked || families.all);
}

function sortFamilies(rows) {
  return [...safeArray(rows)].sort(pnlSort);
}

function getSelectedFamilies() {
  const sideSelect = firstEl("sideSelect", "sideFilter");
  const statusSelect = firstEl("statusSelect", "statusFilter");
  const searchInput = $("searchInput");
  const hideEmptyInput = firstEl("hideEmptyInput", "hideEmpty");

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
        row.familyId,
        row.side,
        row.status,
        row.definition,
        row.quality,
        row.qualityBucket,
        row.market,
        row.marketBucket,
        row.timing,
        row.timingBucket,
        row.winrate,
        row.totalR,
        row.avgR,
        row.totalPnlPct,
        row.pendingOutcome,
        row.unresolved,
        ...safeArray(row.labels),
      ].join(" ").toUpperCase();

      return haystack.includes(query);
    });
  }

  return sortFamilies(rows);
}

function renderFamilies() {
  const tbody = firstEl("familyBody", "familiesBody");
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
        <td colspan="21" class="empty-row">Geen families voor deze filters.</td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = rows.map(row => {
    const status = text(row.status, "EMPTY");
    const side = text(row.side);
    const totalRClass = signedClass(row.totalR);
    const avgRClass = signedClass(row.avgR);
    const pnlClass = signedClass(row.totalPnlPct);
    const avgPnlClass = signedClass(row.avgPnlPct);
    const pending = safeNumber(row.pendingOutcome ?? row.unresolved, 0);

    return `
      <tr class="${statusClass(status)}">
        <td>
          <span class="family-id">${escapeHtml(row.id)}</span>
        </td>
        <td>
          <span class="side-pill ${sideClass(side)}">${escapeHtml(side)}</span>
        </td>
        <td>${escapeHtml(row.quality || row.qualityBucket || "-")}</td>
        <td>${escapeHtml(row.market || row.marketBucket || "-")}</td>
        <td>${escapeHtml(row.timing || row.timingBucket || "-")}</td>
        <td class="definition">${escapeHtml(row.definition)}</td>
        <td class="num">${fmtNum(row.observed, 0)}</td>
        <td class="num">${fmtNum(row.trades, 0)}</td>
        <td class="num">${fmtNum(row.closed, 0)}</td>
        <td class="num">${fmtNum(row.open, 0)}</td>
        <td class="num pending">${fmtNum(pending, 0)}</td>
        <td class="num">${fmtNum(row.wins, 0)}</td>
        <td class="num">${fmtNum(row.losses, 0)}</td>
        <td class="num">${fmtNum(row.breakeven, 0)}</td>
        <td class="num">${escapeHtml(row.winrate || "0%")}</td>
        <td class="num ${totalRClass}">${fmtNum(row.totalR, 3)}</td>
        <td class="num ${avgRClass}">${fmtNum(row.avgR, 3)}</td>
        <td class="num ${pnlClass}">${fmtPct(row.totalPnlPct, 3)}</td>
        <td class="num ${avgPnlClass}">${fmtPct(row.avgPnlPct, 3)}</td>
        <td class="num">${fmtNum(row.pf || row.profitFactor || row.profitFactorR, 3)}</td>
        <td>
          <span class="status-pill ${statusClass(status)}">${escapeHtml(status)}</span>
        </td>
      </tr>
    `;
  }).join("");
}

function getPnlWinnerFamilies(rows) {
  const minClosed = Math.max(1, getMinClosedValue());

  return safeArray(rows)
    .filter(row => safeNumber(row.closed, 0) >= minClosed)
    .filter(row => safeNumber(row.avgR, 0) > 0)
    .filter(row => safeNumber(row.totalR, 0) > 0)
    .filter(row => safeNumber(row.totalPnlPct, 0) > 0)
    .filter(row => safeNumber(row.winrateNum, 0) >= 0.35)
    .sort((a, b) => {
      const pnl = safeNumber(b.totalPnlPct, 0) - safeNumber(a.totalPnlPct, 0);
      if (pnl !== 0) return pnl;

      const totalR = safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0);
      if (totalR !== 0) return totalR;

      const avgR = safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0);
      if (avgR !== 0) return avgR;

      return safeNumber(b.closed, 0) - safeNumber(a.closed, 0);
    });
}

function getTopPnlFamilies() {
  return safeArray(state.report?.families?.ranked)
    .filter(row => row.status !== "EMPTY")
    .filter(row => safeNumber(row.observed, 0) > 0)
    .sort((a, b) => {
      const pnl = safeNumber(b.totalPnlPct, 0) - safeNumber(a.totalPnlPct, 0);
      if (pnl !== 0) return pnl;

      const totalR = safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0);
      if (totalR !== 0) return totalR;

      return safeNumber(b.closed, 0) - safeNumber(a.closed, 0);
    })
    .slice(0, 8);
}

function getWinnerFamilies() {
  return getPnlWinnerFamilies(state.report?.families?.ranked).slice(0, 8);
}

function renderWinnerGrid(targetId, rows, emptyMessage) {
  const grid = $(targetId);
  if (!grid) return;

  if (!rows.length) {
    grid.innerHTML = `
      <div class="winner-empty">
        ${escapeHtml(emptyMessage)}
      </div>
    `;
    return;
  }

  grid.innerHTML = rows.map(row => {
    const status = text(row.status, "STABLE").toLowerCase();

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
            <span>Total R</span>
            <strong class="${signedClass(row.totalR)}">${fmtNum(row.totalR, 3)}</strong>
          </div>
          <div class="winner-stat">
            <span>Avg R</span>
            <strong class="${signedClass(row.avgR)}">${fmtNum(row.avgR, 3)}</strong>
          </div>
          <div class="winner-stat">
            <span>PnL%</span>
            <strong class="${signedClass(row.totalPnlPct)}">${fmtPct(row.totalPnlPct, 3)}</strong>
          </div>
          <div class="winner-stat">
            <span>PF</span>
            <strong>${fmtNum(row.pf || row.profitFactorR || row.profitFactor, 3)}</strong>
          </div>
        </div>

        <p class="winner-definition">${escapeHtml(row.definition)}</p>
      </article>
    `;
  }).join("");
}

function renderWinners() {
  const winners = getWinnerFamilies();
  const topPnl = getTopPnlFamilies();

  const winnerCount = $("winnerCount");
  const topPnlCount = $("topPnlCount");

  if (winnerCount) {
    winnerCount.textContent = `${winners.length} winners`;
  }

  if (topPnlCount) {
    topPnlCount.textContent = `${topPnl.length} families`;
  }

  renderWinnerGrid(
    "winnerGrid",
    winners,
    `Nog geen PnL-winner. Nodig: minimaal ${getMinClosedValue()} closed trades, positieve Avg R, positieve Total R en winrate >= 35%.`
  );

  renderWinnerGrid(
    "topPnlGrid",
    topPnl,
    "Nog geen PnL families met outcome-data."
  );
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
    endpoint: state.raw?.endpoint || null,
    objective: state.raw?.objective || null,
    strategy: state.raw?.strategy || null,
    source: state.raw?.source || null,
    store: state.raw?.store || null,
    latest: state.raw?.latest || null,
    merged: state.raw?.merged || null,
    stats: state.raw?.stats || null,
    config: state.raw?.config || null,
  }, null, 2);
}

function renderApiMeta() {
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
  renderFamilies();
  renderFilters();
  renderApiMeta();
  renderDebug();
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

    const updated = normalized.raw?.servedAt
      ? new Date(normalized.raw.servedAt).toLocaleString()
      : new Date().toLocaleString();

    const stats = state.report.summary || {};

    setStatus(
      `Laatste update: ${updated} | actions ${fmtNum(stats.actions, 0)} | closed ${fmtNum(stats.closed, 0)} | PnL ${fmtPct(stats.totalPnlPct, 3)}`,
      false
    );

    render();
  } catch (error) {
    const message = errorToText(error);

    setStatus(message, true);
    console.error("RUNNER ANALYZE LOAD ERROR:", error);
  } finally {
    setBusy(false);
  }
}

async function resetAnalytics() {
  const ok = window.confirm("Runner analyse-store resetten? Dit wist de opgeslagen runner family-history.");

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
    console.error("RUNNER ANALYZE RESET ERROR:", error);
  } finally {
    setBusy(false);
  }
}

function syncTabs() {
  document.querySelectorAll("[data-side], [data-tab]").forEach(button => {
    const value = button.dataset.side || button.dataset.tab || "ALL";
    button.classList.toggle("active", value === state.activeTab);
  });
}

function setTab(tab) {
  state.activeTab = tab || "ALL";

  const sideSelect = firstEl("sideSelect", "sideFilter");

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

  document.querySelectorAll("[data-side], [data-tab]").forEach(button => {
    button.addEventListener("click", () => {
      setTab(button.dataset.side || button.dataset.tab || "ALL");
    });
  });

  const sideSelect = firstEl("sideSelect", "sideFilter");
  const statusSelect = firstEl("statusSelect", "statusFilter");
  const minClosedInput = getMinClosedInput();
  const searchInput = $("searchInput");
  const hideEmptyInput = firstEl("hideEmptyInput", "hideEmpty");

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

  const params = new URLSearchParams(window.location.search);
  const urlMinClosed = params.get("minClosed");

  if (urlMinClosed && minClosedInput) {
    minClosedInput.value = String(Math.max(0, Math.round(safeNumber(urlMinClosed, DEFAULT_MIN_CLOSED))));
  }

  const apiLink = $("apiLink");
  if (apiLink) {
    apiLink.href = buildApiUrl({ debug: true });
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  ensureRuntimeDefaults();
  wireEvents();
  syncTabs();
  await loadAnalytics();
});