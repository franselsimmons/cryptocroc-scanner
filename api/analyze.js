import {
  loadRunnerAnalyzeStore,
  clearRunnerAnalyzeEvents,
} from "../lib/analyze/runnerAnalyzeStore.js";

const SYSTEM_PROFILE = "RUNNER";
const ENDPOINT = "/api/analyze";

const DEFAULT_MIN_CLOSED = 10;
const MAX_EXAMPLES_PER_FAMILY = 8;
const BREAKEVEN_R_EPS = 0.05;

const STAGES = ["entry", "almost", "buildup", "radar"];

const QUALITY_BUCKETS = [
  {
    index: 1,
    label: "Q1_WEAK",
    conf: "CONF_0_50",
    sniper: "SNIPER_0_50",
    rr: "RR_LT_1p00",
    score: "SCORE_0_50",
  },
  {
    index: 2,
    label: "Q2_LOW",
    conf: "CONF_50_65",
    sniper: "SNIPER_50_65",
    rr: "RR_1p00_1p20",
    score: "SCORE_50_65",
  },
  {
    index: 3,
    label: "Q3_BASE",
    conf: "CONF_65_75",
    sniper: "SNIPER_65_75",
    rr: "RR_1p20_1p50",
    score: "SCORE_65_75",
  },
  {
    index: 4,
    label: "Q4_STRONG",
    conf: "CONF_75_85",
    sniper: "SNIPER_75_85",
    rr: "RR_1p50_2p00",
    score: "SCORE_75_85",
  },
  {
    index: 5,
    label: "Q5_ELITE",
    conf: "CONF_85_100",
    sniper: "SNIPER_85_100",
    rr: "RR_2p00_PLUS",
    score: "SCORE_85_100",
  },
];

const MARKET_BUCKETS = [
  {
    index: 1,
    label: "M1_DIRTY",
    labels: [
      "OB_REL_AGAINST",
      "SPREAD_GT_25BPS",
      "DEPTH_LT_10K",
      "BTC_REL_COUNTER",
      "FUNDING_CROWDED",
    ],
  },
  {
    index: 2,
    label: "M2_WEAK",
    labels: [
      "OB_REL_AGAINST_OR_NEUTRAL",
      "SPREAD_16_25BPS",
      "DEPTH_10K_50K",
      "BTC_REL_COUNTER",
      "FUNDING_EDGE_WEAK",
    ],
  },
  {
    index: 3,
    label: "M3_NORMAL",
    labels: [
      "OB_REL_NEUTRAL",
      "SPREAD_8_16BPS",
      "DEPTH_50K_100K",
      "BTC_REL_NEUTRAL",
      "FUNDING_NEUTRAL",
    ],
  },
  {
    index: 4,
    label: "M4_CLEAN",
    labels: [
      "OB_REL_WITH_OR_NEUTRAL",
      "SPREAD_5_12BPS",
      "DEPTH_100K_250K",
      "BTC_REL_WITH_OR_NEUTRAL",
      "FUNDING_OK",
    ],
  },
  {
    index: 5,
    label: "M5_PREMIUM",
    labels: [
      "OB_REL_WITH",
      "SPREAD_LT_8BPS",
      "DEPTH_GT_250K",
      "BTC_REL_WITH",
      "FUNDING_OPTIMAL",
    ],
  },
];

const TIMING_BUCKETS = [
  {
    index: 1,
    label: "T1_EARLY_OR_NOISY",
    labels: [
      "STAGE_ANY",
      "FLOW_ANY",
      "RSI_ANY",
      "TF_ANY",
      "PULLBACK_NOT_REQUIRED",
    ],
  },
  {
    index: 2,
    label: "T2_TIMED",
    labels: [
      "STAGE_ENTRY_OR_ALMOST",
      "FLOW_TREND_OR_BUILDING",
      "TF_ALIGNED",
      "PULLBACK_OR_CONFIRMATION_OK",
    ],
  },
];

const TRACKED_FIELDS = [
  "tradeId",
  "familyId",
  "side",
  "stage",
  "flow",
  "confluence",
  "sniperScore",
  "rr",
  "baseRR",
  "moveScore",
  "score",
  "rsi",
  "rsiZone",
  "obBias",
  "spreadPct",
  "spreadBps",
  "depthMinUsd1p",
  "btcState",
  "fundingRate",
  "funding",
  "tfScore",
  "tfStrength",
  "runnerPressure",
  "runnerAcceleration",
  "closed",
  "closedAt",
  "exitPrice",
  "exit",
  "pnlPct",
  "pnlR",
  "realizedR",
  "resultR",
  "outcomeR",
  "exitR",
  "exitReason",
  "setupClass",
  "entryType",
  "runnerEntryType",
];

const STATUS_ORDER = {
  HOT: 0,
  GOOD: 1,
  STABLE: 2,
  COLLECTING: 3,
  BAD: 4,
  EMPTY: 5,
};

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

function nullableNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;

  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function pct(value, decimals = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0.0%";
  return `${(n * 100).toFixed(decimals)}%`;
}

function getRequestUrl(req) {
  const host = req?.headers?.host || "localhost";
  const proto = req?.headers?.["x-forwarded-proto"] || "https";
  return new URL(req?.url || "/", `${proto}://${host}`);
}

function getQueryParam(req, key, fallback = "") {
  try {
    return getRequestUrl(req).searchParams.get(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function getBodyValue(req, key, fallback = "") {
  const body = req?.body;

  if (!body || typeof body !== "object") return fallback;

  const value = body[key];

  if (value === undefined || value === null) return fallback;

  return value;
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;

  const v = String(value).trim().toLowerCase();

  if (["true", "1", "yes", "y", "on"].includes(v)) return true;
  if (["false", "0", "no", "n", "off"].includes(v)) return false;

  return fallback;
}

function normalizeAction(req) {
  return String(
    getQueryParam(req, "action", "") ||
      getBodyValue(req, "action", "") ||
      ""
  )
    .trim()
    .toLowerCase();
}

function normalizeSide(value) {
  const s = String(value || "").trim().toUpperCase();

  if (["LONG", "BULL", "BUY"].includes(s)) return "LONG";
  if (["SHORT", "BEAR", "SELL"].includes(s)) return "SHORT";

  return "";
}

function normalizeSymbol(value) {
  return String(value || "")
    .toUpperCase()
    .trim()
    .replace(/_UMCBL$/, "")
    .replace(/_DMCBL$/, "")
    .replace(/_CMCBL$/, "")
    .replace(/-UMCBL$/, "")
    .replace(/-DMCBL$/, "")
    .replace(/-CMCBL$/, "")
    .replace(/USDT$/, "")
    .replace(/USDC$/, "");
}

function normalizeText(value) {
  return String(value || "").toUpperCase().trim();
}

function getSnapshot(row) {
  return {
    ...safeObject(row?.filterSnapshot),
    ...safeObject(row?.filters),
    ...safeObject(row?.analysisFilters),
  };
}

function firstValue(row, keys, fallback = undefined) {
  const snapshot = getSnapshot(row);

  for (const key of keys) {
    const direct = row?.[key];

    if (direct !== undefined && direct !== null && direct !== "") {
      return direct;
    }

    const snap = snapshot?.[key];

    if (snap !== undefined && snap !== null && snap !== "") {
      return snap;
    }
  }

  return fallback;
}

function getTradeId(row) {
  return String(
    firstValue(row, [
      "tradeId",
      "positionTradeId",
      "positionId",
      "orderId",
      "clientOrderId",
      "analyzeEventId",
      "eventId",
      "id",
    ], "")
  );
}

function getAction(row) {
  return normalizeText(
    firstValue(row, [
      "analyzeLifecycle",
      "analyzeAction",
      "lifecycleAction",
      "tradeAction",
      "action",
      "event",
      "status",
      "state",
      "type",
    ], "ENTRY")
  );
}

function isEntryLike(row) {
  const action = getAction(row);

  if (!action) return true;

  if (
    action === "ENTRY" ||
    action === "OPEN" ||
    action === "OPENED" ||
    action === "FILLED" ||
    action.includes("ENTRY") ||
    action.includes("OPEN")
  ) {
    return true;
  }

  if (action === "EXIT" || action === "CLOSED" || action.includes("EXIT")) {
    return false;
  }

  return true;
}

function isClosedTrade(row) {
  if (row?.closed === true || row?.isClosed === true) return true;

  if (
    firstValue(row, [
      "closedAt",
      "exitedAt",
      "exitAt",
      "exitTs",
      "exitPrice",
      "exit",
      "realizedR",
      "pnlR",
      "exitR",
      "resultR",
      "outcomeR",
      "pnlPct",
    ], null) !== null
  ) {
    return true;
  }

  return false;
}

function getResultR(row) {
  return safeNumber(
    firstValue(row, [
      "realizedR",
      "pnlR",
      "exitR",
      "resultR",
      "outcomeR",
      "rMultiple",
      "r",
    ], 0),
    0
  );
}

function getPnlPct(row) {
  return safeNumber(
    firstValue(row, [
      "pnlPct",
      "pnlPercent",
      "realizedPnlPct",
      "resultPnlPct",
      "profitPct",
    ], 0),
    0
  );
}

function getScore(row) {
  return safeNumber(
    firstValue(row, [
      "score",
      "moveScore",
      "tradeScore",
      "sniperScore",
      "confluence",
    ], 0),
    0
  );
}

function getConfluence(row) {
  return safeNumber(firstValue(row, ["confluence"], getScore(row)), 0);
}

function getSniperScore(row) {
  return safeNumber(
    firstValue(row, ["sniperScore", "sniper", "runnerScore"], getScore(row)),
    0
  );
}

function getRR(row) {
  return safeNumber(
    firstValue(row, [
      "rr",
      "baseRR",
      "finalRR",
      "finalRr",
      "plannedRR",
      "effectiveRR",
      "targetR",
    ], 0),
    0
  );
}

function getSpreadBps(row) {
  const directBps = nullableNumber(firstValue(row, ["spreadBps"], null));

  if (directBps !== null) return directBps;

  let spreadPct = nullableNumber(firstValue(row, ["spreadPct"], null));

  if (spreadPct === null) return 0;

  if (spreadPct > 0.05) {
    spreadPct = spreadPct / 100;
  }

  return spreadPct * 10000;
}

function getDepth(row) {
  return safeNumber(
    firstValue(row, ["depthMinUsd1p", "depthUsd1p"], 0),
    0
  );
}

function getFunding(row) {
  return safeNumber(firstValue(row, ["fundingRate", "funding"], 0), 0);
}

function getObBias(row) {
  return normalizeText(firstValue(row, ["obBias"], "NEUTRAL")) || "NEUTRAL";
}

function getFlow(row) {
  return normalizeText(firstValue(row, ["flow", "scannerFlow", "detectedFlow"], "UNKNOWN"));
}

function getStage(row) {
  return String(firstValue(row, ["stage", "scannerStage"], "unknown"))
    .toLowerCase()
    .trim();
}

function getRsiZone(row) {
  return normalizeText(firstValue(row, ["rsiZone"], "UNKNOWN")) || "UNKNOWN";
}

function getTfStrength(row) {
  return Math.abs(
    safeNumber(firstValue(row, ["tfStrength", "tfScore"], 0), 0)
  );
}

function getBtcState(row) {
  return normalizeText(firstValue(row, ["btcState"], "NEUTRAL")) || "NEUTRAL";
}

function getFamilyIndex(qualityIndex, marketIndex, timingIndex) {
  return (qualityIndex - 1) * 10 + (marketIndex - 1) * 2 + timingIndex;
}

function decodeFamilyIndex(index) {
  const n = Math.max(1, Math.min(50, Math.round(Number(index || 1))));

  const qualityIndex = Math.floor((n - 1) / 10) + 1;
  const rem = (n - 1) % 10;
  const marketIndex = Math.floor(rem / 2) + 1;
  const timingIndex = (rem % 2) + 1;

  return {
    qualityIndex,
    marketIndex,
    timingIndex,
  };
}

function parseFamilyId(value) {
  const text = String(value || "").toUpperCase().trim();
  const match = text.match(/^(LONG|SHORT)_(\d{1,2})$/);

  if (!match) return null;

  const side = match[1];
  const index = Number(match[2]);

  if (!Number.isInteger(index) || index < 1 || index > 50) return null;

  return {
    side,
    index,
    ...decodeFamilyIndex(index),
  };
}

function deriveQualityIndex(row) {
  const conf = getConfluence(row);
  const sniper = getSniperScore(row);
  const score = getScore(row);
  const rr = getRR(row);

  const core = Math.min(
    Number.isFinite(conf) ? conf : 0,
    Number.isFinite(sniper) ? sniper : 0,
    Number.isFinite(score) ? score : 0
  );

  if (core >= 85 && rr >= 2.0) return 5;
  if (core >= 75 && rr >= 1.5) return 4;
  if (core >= 65 && rr >= 1.2) return 3;
  if (core >= 50 && rr >= 1.0) return 2;

  if (conf >= 85 && score >= 85 && rr >= 2.0) return 5;
  if (conf >= 75 && score >= 75 && rr >= 1.5) return 4;
  if (conf >= 65 && score >= 65 && rr >= 1.2) return 3;
  if (conf >= 50 && score >= 50 && rr >= 1.0) return 2;

  return 1;
}

function getObRelation(row, side) {
  const ob = getObBias(row);

  if (side === "LONG") {
    if (ob === "BULLISH" || ob === "LONG" || ob === "WITH") return "WITH";
    if (ob === "BEARISH" || ob === "SHORT" || ob === "AGAINST") return "AGAINST";
    return "NEUTRAL";
  }

  if (ob === "BEARISH" || ob === "SHORT" || ob === "WITH") return "WITH";
  if (ob === "BULLISH" || ob === "LONG" || ob === "AGAINST") return "AGAINST";

  return "NEUTRAL";
}

function deriveMarketIndex(row, side) {
  const spreadBps = getSpreadBps(row);
  const depth = getDepth(row);
  const relation = getObRelation(row, side);
  const funding = getFunding(row);
  const btcState = getBtcState(row);

  const fundingCrowded =
    (side === "LONG" && funding > 0.014) ||
    (side === "SHORT" && funding < -0.014);

  const btcCounter =
    (side === "LONG" && btcState === "STRONG_BEAR") ||
    (side === "SHORT" && btcState === "STRONG_BULL");

  if (
    relation === "WITH" &&
    spreadBps > 0 &&
    spreadBps < 8 &&
    depth >= 250000 &&
    Math.abs(funding) <= 0.01 &&
    !btcCounter
  ) {
    return 5;
  }

  if (
    relation !== "AGAINST" &&
    spreadBps > 0 &&
    spreadBps <= 12 &&
    depth >= 100000 &&
    depth < 250000 &&
    Math.abs(funding) <= 0.014 &&
    !btcCounter
  ) {
    return 4;
  }

  if (
    relation === "NEUTRAL" &&
    spreadBps > 0 &&
    spreadBps <= 16 &&
    depth >= 50000 &&
    depth < 100000 &&
    !fundingCrowded
  ) {
    return 3;
  }

  if (
    relation !== "WITH" &&
    spreadBps > 0 &&
    spreadBps <= 25 &&
    depth >= 10000 &&
    depth < 50000
  ) {
    return 2;
  }

  return 1;
}

function isRunnerFlow(flow) {
  return [
    "SQUEEZE",
    "RUNNING",
    "BREAKOUT",
    "BUILDING",
    "TREND",
  ].includes(normalizeText(flow));
}

function deriveTimingIndex(row, side) {
  const stage = getStage(row);
  const flow = getFlow(row);
  const rsiZone = getRsiZone(row);
  const tfStrength = getTfStrength(row);

  const stageOk = stage === "entry" || stage === "almost";
  const flowOk = isRunnerFlow(flow);
  const tfOk = tfStrength >= 1;

  const rsiOk =
    side === "LONG"
      ? ["LOWER_3", "LOWER_2", "LOWER_1", "MID", "UPPER_1"].includes(rsiZone)
      : ["UPPER_3", "UPPER_2", "UPPER_1", "MID", "LOWER_1"].includes(rsiZone);

  return stageOk && flowOk && tfOk && rsiOk ? 2 : 1;
}

function resolveFamilyId(row) {
  const side = normalizeSide(firstValue(row, ["side"], ""));
  if (!side) return null;

  const directFamily = firstValue(row, [
    "familyId",
    "runnerFamilyId",
    "analyzeFamilyId",
    "analysisFamilyId",
  ], "");

  const parsed = parseFamilyId(directFamily);

  if (parsed && parsed.side === side) {
    return parsed;
  }

  const qualityIndex = deriveQualityIndex(row);
  const marketIndex = deriveMarketIndex(row, side);
  const timingIndex = deriveTimingIndex(row, side);
  const index = getFamilyIndex(qualityIndex, marketIndex, timingIndex);

  return {
    side,
    index,
    qualityIndex,
    marketIndex,
    timingIndex,
  };
}

function getQualityBucket(index) {
  return QUALITY_BUCKETS.find(item => item.index === index) || QUALITY_BUCKETS[0];
}

function getMarketBucket(index) {
  return MARKET_BUCKETS.find(item => item.index === index) || MARKET_BUCKETS[0];
}

function getTimingBucket(index) {
  return TIMING_BUCKETS.find(item => item.index === index) || TIMING_BUCKETS[0];
}

function buildDefinitionLabels({ side, qualityIndex, marketIndex, timingIndex }) {
  const q = getQualityBucket(qualityIndex);
  const m = getMarketBucket(marketIndex);
  const t = getTimingBucket(timingIndex);

  const labels = [
    q.label,
    m.label,
    t.label,

    q.conf,
    q.sniper,
    q.rr,
    q.score,
  ];

  if (timingIndex === 2) {
    labels.push(
      "STAGE_ENTRY_OR_ALMOST",
      "FLOW_TREND_OR_BUILDING",
      side === "LONG" ? "RSI_LOWER_OR_MID" : "RSI_UPPER_OR_MID"
    );
  } else {
    labels.push(
      "STAGE_ANY",
      "FLOW_ANY",
      "RSI_ANY"
    );
  }

  labels.push(...m.labels);

  if (timingIndex === 2) {
    labels.push(
      "TF_ALIGNED",
      "PULLBACK_OR_CONFIRMATION_OK"
    );
  } else {
    labels.push(
      "TF_ANY",
      "PULLBACK_NOT_REQUIRED"
    );
  }

  return labels;
}

function createFamilySkeleton(side, index) {
  const decoded = decodeFamilyIndex(index);
  const familyId = `${side}_${index}`;
  const labels = buildDefinitionLabels({
    side,
    ...decoded,
  });

  return {
    familyId,
    side,
    index,

    qualityIndex: decoded.qualityIndex,
    marketIndex: decoded.marketIndex,
    timingIndex: decoded.timingIndex,

    quality: getQualityBucket(decoded.qualityIndex).label,
    market: getMarketBucket(decoded.marketIndex).label,
    timing: getTimingBucket(decoded.timingIndex).label,

    definition: labels.join(" | "),
    labels,

    observed: 0,
    trades: 0,
    closed: 0,
    open: 0,
    pending: 0,

    wins: 0,
    losses: 0,
    breakeven: 0,

    winrateNum: 0,
    winrate: "0.0%",

    totalR: 0,
    avgR: 0,

    grossWinR: 0,
    grossLossR: 0,
    profitFactor: 0,
    pf: 0,

    totalPnlPct: 0,
    avgPnlPct: 0,

    avgMfeR: 0,
    avgMaeR: 0,

    status: "EMPTY",
    examples: [],
  };
}

function createFamilyMap() {
  const map = new Map();

  for (const side of ["LONG", "SHORT"]) {
    for (let i = 1; i <= 50; i++) {
      const family = createFamilySkeleton(side, i);
      map.set(family.familyId, family);
    }
  }

  return map;
}

function addExample(family, row) {
  if (family.examples.length >= MAX_EXAMPLES_PER_FAMILY) return;

  family.examples.push({
    tradeId: getTradeId(row),
    symbol: normalizeSymbol(firstValue(row, ["symbol"], "")),
    side: normalizeSide(firstValue(row, ["side"], "")),
    closed: isClosedTrade(row),
    resultR: round(getResultR(row), 3),
    pnlPct: round(getPnlPct(row), 3),
    exitReason: firstValue(row, ["exitReason", "reason"], null),
    entryType: firstValue(row, ["entryType", "runnerEntryType"], null),
    setupClass: firstValue(row, ["setupClass"], null),
    ts: safeNumber(firstValue(row, ["ts", "analyzeTs", "createdAt"], 0), 0),
  });
}

function finalizeFamily(family, minClosed) {
  const completed = family.closed;

  family.trades = family.observed;
  family.pending = family.open;

  family.totalR = round(family.totalR, 3);
  family.totalPnlPct = round(family.totalPnlPct, 3);

  family.avgR = completed ? round(family.totalR / completed, 3) : 0;
  family.avgPnlPct = completed ? round(family.totalPnlPct / completed, 3) : 0;

  family.winrateNum = completed ? family.wins / completed : 0;
  family.winrate = completed ? pct(family.winrateNum, 1) : "0.0%";

  family.grossWinR = round(family.grossWinR, 3);
  family.grossLossR = round(family.grossLossR, 3);

  family.profitFactor = family.grossLossR > 0
    ? round(family.grossWinR / family.grossLossR, 3)
    : family.grossWinR > 0
      ? 999
      : 0;

  family.pf = family.profitFactor;

  family.avgMfeR = family.closed
    ? round(family.avgMfeR / family.closed, 3)
    : 0;

  family.avgMaeR = family.closed
    ? round(family.avgMaeR / family.closed, 3)
    : 0;

  family.status = classifyFamilyStatus(family, minClosed);

  return family;
}

function classifyFamilyStatus(family, minClosed) {
  if (family.observed <= 0) return "EMPTY";
  if (family.closed < minClosed) return "COLLECTING";

  const pnlPositive = family.totalPnlPct > 0 || family.totalR > 0;

  if (
    pnlPositive &&
    family.avgR >= 0.55 &&
    family.winrateNum >= 0.55 &&
    family.profitFactor >= 2.5
  ) {
    return "HOT";
  }

  if (
    pnlPositive &&
    family.avgR >= 0.30 &&
    family.winrateNum >= 0.50 &&
    family.profitFactor >= 1.5
  ) {
    return "GOOD";
  }

  if (
    pnlPositive &&
    family.avgR >= 0.18 &&
    family.winrateNum >= 0.45 &&
    family.profitFactor >= 1.2
  ) {
    return "STABLE";
  }

  return "BAD";
}

function summarizeStatuses(families) {
  const out = {
    total: families.length,
    HOT: 0,
    GOOD: 0,
    STABLE: 0,
    BAD: 0,
    COLLECTING: 0,
    EMPTY: 0,
  };

  for (const family of families) {
    out[family.status] = safeNumber(out[family.status], 0) + 1;
  }

  return {
    ...out,
    text:
      `HOT ${out.HOT} | GOOD ${out.GOOD} | STABLE ${out.STABLE} | ` +
      `BAD ${out.BAD} | COLLECTING ${out.COLLECTING} | EMPTY ${out.EMPTY}`,
  };
}

function getFamilySortScore(family) {
  const statusScore = 100 - (STATUS_ORDER[family.status] ?? 99) * 10;

  return (
    statusScore +
    family.totalPnlPct * 2.5 +
    family.totalR * 1.5 +
    family.avgPnlPct * 10 +
    family.avgR * 12 +
    family.profitFactor * 0.5 +
    family.closed * 0.03
  );
}

function sortFamiliesForDisplay(a, b) {
  const statusDiff = (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99);
  if (statusDiff !== 0) return statusDiff;

  const pnlDiff = safeNumber(b.totalPnlPct, 0) - safeNumber(a.totalPnlPct, 0);
  if (pnlDiff !== 0) return pnlDiff;

  const totalRDiff = safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0);
  if (totalRDiff !== 0) return totalRDiff;

  const avgRDiff = safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0);
  if (avgRDiff !== 0) return avgRDiff;

  return safeNumber(b.closed, 0) - safeNumber(a.closed, 0);
}

function sortByPnl(a, b) {
  const pnlDiff = safeNumber(b.totalPnlPct, 0) - safeNumber(a.totalPnlPct, 0);
  if (pnlDiff !== 0) return pnlDiff;

  const rDiff = safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0);
  if (rDiff !== 0) return rDiff;

  return safeNumber(b.avgPnlPct, 0) - safeNumber(a.avgPnlPct, 0);
}

function sortByTotalR(a, b) {
  const rDiff = safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0);
  if (rDiff !== 0) return rDiff;

  return safeNumber(b.totalPnlPct, 0) - safeNumber(a.totalPnlPct, 0);
}

function sortByWinrate(a, b) {
  const winDiff = safeNumber(b.winrateNum, 0) - safeNumber(a.winrateNum, 0);
  if (winDiff !== 0) return winDiff;

  return safeNumber(b.closed, 0) - safeNumber(a.closed, 0);
}

function buildTrackedFilters() {
  const fields = TRACKED_FIELDS.map(field => ({
    type: "FIELD",
    field,
    label: field,
  }));

  const quality = QUALITY_BUCKETS.map(item => ({
    type: "QUALITY",
    field: item.label,
    label: item.label,
  }));

  const market = MARKET_BUCKETS.map(item => ({
    type: "MARKET",
    field: item.label,
    label: item.label,
  }));

  const timing = TIMING_BUCKETS.map(item => ({
    type: "TIMING",
    field: item.label,
    label: item.label,
  }));

  return [...fields, ...quality, ...market, ...timing];
}

function compactFamily(family) {
  return {
    familyId: family.familyId,
    side: family.side,

    quality: family.quality,
    market: family.market,
    timing: family.timing,

    qualityIndex: family.qualityIndex,
    marketIndex: family.marketIndex,
    timingIndex: family.timingIndex,

    definition: family.definition,
    labels: family.labels,

    observed: family.observed,
    trades: family.trades,
    closed: family.closed,
    open: family.open,
    pending: family.pending,

    wins: family.wins,
    losses: family.losses,
    breakeven: family.breakeven,

    winrate: family.winrate,
    winrateNum: round(family.winrateNum, 4),

    totalR: family.totalR,
    avgR: family.avgR,

    totalPnlPct: family.totalPnlPct,
    avgPnlPct: family.avgPnlPct,

    grossWinR: family.grossWinR,
    grossLossR: family.grossLossR,
    profitFactor: family.profitFactor,
    pf: family.pf,

    avgMfeR: family.avgMfeR,
    avgMaeR: family.avgMaeR,

    status: family.status,
    score: round(getFamilySortScore(family), 3),

    examples: family.examples,
  };
}

function buildGlobalStats(rows) {
  const entryRows = rows.filter(row => isEntryLike(row));
  const closedRows = entryRows.filter(row => isClosedTrade(row));
  const openRows = entryRows.filter(row => !isClosedTrade(row));

  let wins = 0;
  let losses = 0;
  let breakeven = 0;

  let totalR = 0;
  let totalPnlPct = 0;

  for (const row of closedRows) {
    const r = getResultR(row);
    const pnl = getPnlPct(row);

    totalR += r;
    totalPnlPct += pnl;

    if (r > BREAKEVEN_R_EPS) {
      wins++;
      continue;
    }

    if (r < -BREAKEVEN_R_EPS) {
      losses++;
      continue;
    }

    breakeven++;
  }

  const closed = closedRows.length;

  return {
    actions: rows.length,
    trades: entryRows.length,
    open: openRows.length,
    closed,

    pendingOutcome: openRows.length,

    wins,
    losses,
    breakeven,

    winrateNum: closed ? wins / closed : 0,
    winrate: closed ? pct(wins / closed, 1) : "0.0%",

    totalR: round(totalR, 3),
    avgR: closed ? round(totalR / closed, 3) : 0,

    totalPnlPct: round(totalPnlPct, 3),
    avgPnlPct: closed ? round(totalPnlPct / closed, 3) : 0,
  };
}

function buildAnalyzePayload({ store, minClosed, startedAt }) {
  const rawRows = safeArray(store?.events);
  const rows = rawRows.filter(Boolean);
  const familyMap = createFamilyMap();

  for (const row of rows) {
    if (!isEntryLike(row)) continue;

    const resolved = resolveFamilyId(row);

    if (!resolved) continue;

    const familyId = `${resolved.side}_${resolved.index}`;
    const family = familyMap.get(familyId);

    if (!family) continue;

    const closed = isClosedTrade(row);
    const r = getResultR(row);
    const pnl = getPnlPct(row);

    family.observed++;

    if (closed) {
      family.closed++;
      family.totalR += r;
      family.totalPnlPct += pnl;

      if (r > BREAKEVEN_R_EPS) {
        family.wins++;
        family.grossWinR += r;
      } else if (r < -BREAKEVEN_R_EPS) {
        family.losses++;
        family.grossLossR += Math.abs(r);
      } else {
        family.breakeven++;
      }

      family.avgMfeR += safeNumber(firstValue(row, ["mfeR"], 0), 0);
      family.avgMaeR += safeNumber(firstValue(row, ["maeR"], 0), 0);
    } else {
      family.open++;
    }

    addExample(family, row);
  }

  const finalized = Array.from(familyMap.values()).map(family => {
    return finalizeFamily(family, minClosed);
  });

  const allFamilies = finalized
    .map(compactFamily)
    .sort(sortFamiliesForDisplay);

  const longFamilies = allFamilies.filter(row => row.side === "LONG");
  const shortFamilies = allFamilies.filter(row => row.side === "SHORT");

  const nonEmptyFamilies = allFamilies.filter(row => row.observed > 0);

  const statusWinnerFamilies = allFamilies
    .filter(row => {
      return (
        ["HOT", "GOOD", "STABLE"].includes(row.status) &&
        row.closed >= minClosed &&
        row.avgR > 0
      );
    })
    .sort(sortByPnl);

  const pnlWinnerCandidates = allFamilies
    .filter(row => {
      return (
        row.closed >= minClosed &&
        row.observed > 0 &&
        (row.totalPnlPct > 0 || row.totalR > 0)
      );
    })
    .sort(sortByPnl);

  const topPnlFamilies = [...pnlWinnerCandidates].slice(0, 20);
  const topTotalRFamilies = [...pnlWinnerCandidates].sort(sortByTotalR).slice(0, 20);
  const topWinrateFamilies = [...pnlWinnerCandidates].sort(sortByWinrate).slice(0, 20);

  const bestLongByPnl = topPnlFamilies.find(row => row.side === "LONG") || null;
  const bestShortByPnl = topPnlFamilies.find(row => row.side === "SHORT") || null;

  const globalStats = buildGlobalStats(rows);

  const longSummary = summarizeStatuses(longFamilies);
  const shortSummary = summarizeStatuses(shortFamilies);

  const now = Date.now();

  return {
    ok: true,
    profile: SYSTEM_PROFILE,
    endpoint: ENDPOINT,
    objective: "RUNNER_PNL_FIRST",
    strategy: "50_LONG_FAMILIES_PLUS_50_SHORT_FAMILIES",

    dataState: rows.length > 0 ? "READY" : "INIT",
    latencyMs: now - startedAt,
    servedAt: now,

    config: {
      minClosed,
      breakevenREps: BREAKEVEN_R_EPS,
      maxExamplesPerFamily: MAX_EXAMPLES_PER_FAMILY,
      familyCountPerSide: 50,
      totalFamilyCount: 100,
    },

    source: {
      mode: "RUNNER_ANALYZE_STORE",
      storeSource: store?.source || "runner_analyze_store",
      redisKey: store?.redisKey || null,
      legacyRedisKey: store?.legacyRedisKey || null,
      path: store?.path || null,
      redisEnabled: Boolean(store?.redisEnabled),
      fileEnabled: Boolean(store?.fileEnabled),
      loadedAt: store?.loadedAt || 0,
      lastPersistAt: store?.lastPersistAt || 0,
    },

    store: {
      ok: store?.ok !== false,
      count: safeNumber(store?.count, rows.length),
      trades: safeNumber(store?.trades, rows.length),
      open: safeNumber(store?.open, globalStats.open),
      closed: safeNumber(store?.closed, globalStats.closed),
      unmatchedExits: safeNumber(store?.unmatchedExits, 0),
      maxStoredEvents: safeNumber(store?.maxStoredEvents, 0),
    },

    latest: {
      ok: true,
      count: 0,
      note: "Runner analyze gebruikt de runner analyze-store. Latest scan wordt niet gemerged in deze endpoint.",
    },

    merged: {
      count: rows.length,
      source: "runner_analyze_store_only",
    },

    stats: {
      ...globalStats,

      longFamilies: {
        count: longFamilies.length,
        ...longSummary,
      },

      shortFamilies: {
        count: shortFamilies.length,
        ...shortSummary,
      },

      familiesWithData: nonEmptyFamilies.length,
    },

    familyPerformanceMatrix: {
      long: {
        total: longFamilies.length,
        summary: longSummary,
      },
      short: {
        total: shortFamilies.length,
        summary: shortSummary,
      },
    },

    best: {
      bestLongByPnl,
      bestShortByPnl,
      topPnlFamily: topPnlFamilies[0] || null,
      topTotalRFamily: topTotalRFamilies[0] || null,
      topWinrateFamily: topWinrateFamilies[0] || null,
    },

    winnerCandidates: pnlWinnerCandidates.slice(0, 25),
    winnerCandidateSummary: {
      count: pnlWinnerCandidates.length,
      objective: "highest_total_pnl_pct_then_total_r",
      message: pnlWinnerCandidates.length
        ? "Runner candidates gerankt op Total PnL% en daarna Total R."
        : "Nog geen runner-family met voldoende closed sample en positieve PnL/R.",
    },

    winnerFamilies: statusWinnerFamilies.slice(0, 25),
    winnerFamilySummary: {
      count: statusWinnerFamilies.length,
      rule: "Alleen HOT/GOOD/STABLE families met voldoende closed trades en positieve Avg R.",
    },

    leaderboards: {
      topPnlFamilies,
      topTotalRFamilies,
      topWinrateFamilies,
    },

    families: allFamilies,
    allFamilies,
    longFamilies,
    shortFamilies,

    trackedFilters: buildTrackedFilters(),

    debug: {
      rowsLoaded: rows.length,
      entryRows: rows.filter(row => isEntryLike(row)).length,
      closedRows: rows.filter(row => isEntryLike(row) && isClosedTrade(row)).length,
      openRows: rows.filter(row => isEntryLike(row) && !isClosedTrade(row)).length,
      queryMinClosed: minClosed,
    },
  };
}

async function handleReset(req, res) {
  const confirm = normalizeBoolean(
    getQueryParam(req, "confirm", "") || getBodyValue(req, "confirm", ""),
    false
  );

  if (!confirm) {
    return res.status(400).json({
      ok: false,
      profile: SYSTEM_PROFILE,
      error: "reset_requires_confirm_true",
      example: `${ENDPOINT}?action=reset&confirm=true`,
      servedAt: Date.now(),
    });
  }

  const result = await clearRunnerAnalyzeEvents();

  return res.status(200).json({
    ok: true,
    profile: SYSTEM_PROFILE,
    endpoint: ENDPOINT,
    action: "reset",
    result,
    servedAt: Date.now(),
  });
}

export default async function handler(req, res) {
  const startedAt = Date.now();

  try {
    res.setHeader("Cache-Control", "no-store, max-age=0");

    const action = normalizeAction(req);

    if (action === "reset" || action === "clear") {
      return await handleReset(req, res);
    }

    const minClosed = Math.max(
      1,
      Math.round(
        safeNumber(
          getQueryParam(req, "minClosed", "") ||
            getBodyValue(req, "minClosed", "") ||
            DEFAULT_MIN_CLOSED,
          DEFAULT_MIN_CLOSED
        )
      )
    );

    const force = normalizeBoolean(
      getQueryParam(req, "force", "") ||
        getQueryParam(req, "cacheBust", "") ||
        getBodyValue(req, "force", ""),
      false
    );

    const store = await loadRunnerAnalyzeStore({
      force,
    });

    const payload = buildAnalyzePayload({
      store,
      minClosed,
      startedAt,
    });

    if (action === "status") {
      return res.status(200).json({
        ok: true,
        profile: SYSTEM_PROFILE,
        endpoint: ENDPOINT,
        dataState: payload.dataState,
        latencyMs: payload.latencyMs,
        source: payload.source,
        store: payload.store,
        stats: payload.stats,
        best: payload.best,
        winnerCandidateSummary: payload.winnerCandidateSummary,
        winnerFamilySummary: payload.winnerFamilySummary,
        servedAt: Date.now(),
      });
    }

    return res.status(200).json(payload);
  } catch (error) {
    console.error("RUNNER ANALYZE ERROR:", error);

    return res.status(500).json({
      ok: false,
      profile: SYSTEM_PROFILE,
      endpoint: ENDPOINT,
      error: error?.message || "runner_analyze_failed",
      latencyMs: Date.now() - startedAt,
      servedAt: Date.now(),
    });
  }
}