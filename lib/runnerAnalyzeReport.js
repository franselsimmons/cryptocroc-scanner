// ================= RUNNER ANALYZE REPORT =================
// Doel:
// - Zelfde familie-outputstijl als main funnel.
// - 50 LONG + 50 SHORT families.
// - Runner is PNL-first.
// - Winrate blijft zichtbaar, maar ranking focust op totalPnlPct + totalR + avgR + PF.
// - Main-compatible aliases: best, winners, bestRunnerPnl, bestPnl, bestTotalR, bestBalance, bestWinrate.
// - Werkt op ENTRY rows, EXIT rows, closed ENTRY rows, shadow rows en compact public rows.

const SYSTEM_PROFILE = "RUNNER";

const FAMILY_COUNT_PER_SIDE = 50;
const DEFAULT_MIN_CLOSED = 10;

const HOT_MIN_CLOSED = 25;
const GOOD_MIN_CLOSED = 10;
const STABLE_MIN_CLOSED = 8;

const MAX_EXAMPLES_PER_FAMILY = 10;
const MAX_RANKED = 100;
const MAX_BEST = 30;

// ================= GENERIC HELPERS =================

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

function round(value, decimals = 3) {
  const n = safeNumber(value, 0);
  const p = 10 ** decimals;
  return Math.round(n * p) / p;
}

function pctString(value, decimals = 1) {
  return `${round(safeNumber(value, 0) * 100, decimals)}%`;
}

function normalizeText(value) {
  return String(value || "").toUpperCase().trim();
}

function normalizeSide(value) {
  const s = String(value || "").toLowerCase().trim();

  if (["bull", "long", "buy"].includes(s)) return "LONG";
  if (["bear", "short", "sell"].includes(s)) return "SHORT";

  const u = normalizeText(value);
  if (u.includes("LONG")) return "LONG";
  if (u.includes("SHORT")) return "SHORT";

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

function hashString(value) {
  const str = String(value || "");
  let hash = 2166136261;

  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return Math.abs(hash >>> 0);
}

function incrementCounter(map, key, inc = 1) {
  const k = String(key || "UNKNOWN").toUpperCase();
  map[k] = safeNumber(map[k], 0) + inc;
}

function avg(values) {
  const arr = values.map(Number).filter(Number.isFinite);
  if (!arr.length) return 0;
  return arr.reduce((sum, value) => sum + value, 0) / arr.length;
}

function sum(values) {
  return values
    .map(Number)
    .filter(Number.isFinite)
    .reduce((acc, value) => acc + value, 0);
}

// ================= ROW NORMALIZATION =================

function getAction(row) {
  const action = normalizeText(
    row?.action ||
      row?.analyzeLifecycle ||
      row?.analyzeAction ||
      row?.type ||
      row?.status ||
      row?.state
  );

  if (
    action === "ENTRY" ||
    action === "OPEN" ||
    action === "OPENED" ||
    action.includes("ENTRY") ||
    action.includes("OPEN")
  ) {
    return "ENTRY";
  }

  if (
    action === "EXIT" ||
    action === "CLOSE" ||
    action === "CLOSED" ||
    action === "TP" ||
    action === "SL" ||
    action === "BE_SL" ||
    action === "TRAIL_SL" ||
    action.includes("EXIT") ||
    action.includes("CLOSE")
  ) {
    return "EXIT";
  }

  if (row?.closed === true || row?.isClosed === true) return "ENTRY";
  if (hasOutcome(row)) return "EXIT";

  return action || "UNKNOWN";
}

function getSideFromFamilyId(value) {
  const id = normalizeText(value);
  if (id.startsWith("LONG_")) return "LONG";
  if (id.startsWith("SHORT_")) return "SHORT";
  return "";
}

function getRawFamilyId(row) {
  const snapshot = safeObject(row?.filterSnapshot);

  return (
    row?.familyId ||
    row?.runnerFamilyId ||
    row?.analyzeFamilyId ||
    row?.analysisFamilyId ||
    snapshot?.familyId ||
    snapshot?.runnerFamilyId ||
    snapshot?.analyzeFamilyId ||
    snapshot?.analysisFamilyId ||
    ""
  );
}

function getSide(row) {
  return (
    normalizeSide(row?.side || row?.direction || row?.tradeSide) ||
    getSideFromFamilyId(getRawFamilyId(row))
  );
}

function hasOutcome(row) {
  return (
    Number.isFinite(Number(row?.realizedR)) ||
    Number.isFinite(Number(row?.pnlR)) ||
    Number.isFinite(Number(row?.exitR)) ||
    Number.isFinite(Number(row?.resultR)) ||
    Number.isFinite(Number(row?.outcomeR)) ||
    Number.isFinite(Number(row?.rMultiple)) ||
    Number.isFinite(Number(row?.pnlPct)) ||
    row?.closed === true ||
    row?.isClosed === true
  );
}

function getRealizedR(row) {
  const candidates = [
    row?.realizedR,
    row?.pnlR,
    row?.exitR,
    row?.resultR,
    row?.outcomeR,
    row?.rMultiple,
    row?.r,
  ];

  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }

  return null;
}

function getPnlPct(row) {
  const candidates = [
    row?.pnlPct,
    row?.pnlPercent,
    row?.realizedPnlPct,
    row?.resultPnlPct,
    row?.profitPct,
  ];

  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }

  return null;
}

function getTimestamp(row) {
  return safeNumber(
    row?.closedAt ||
      row?.completedAt ||
      row?.exitedAt ||
      row?.exitAt ||
      row?.exitTs ||
      row?.openedAt ||
      row?.entryTs ||
      row?.createdAt ||
      row?.analyzeTs ||
      row?.ts ||
      row?.updatedAt,
    0
  );
}

function getTradeId(row) {
  const direct =
    row?.tradeId ||
    row?.positionTradeId ||
    row?.positionId ||
    row?.orderId ||
    row?.clientOrderId ||
    row?.analyzeEventId ||
    row?.eventId ||
    row?.id;

  if (direct) return String(direct);

  const symbol = normalizeSymbol(row?.symbol);
  const side = getSide(row);
  const entry = safeNumber(row?.entry ?? row?.entryPrice ?? row?.openPrice, 0);
  const ts = getTimestamp(row);

  if (symbol && side && entry > 0 && ts > 0) {
    return `${SYSTEM_PROFILE}_${symbol}_${side}_${ts}_${entry.toPrecision(12)}`;
  }

  return "";
}

function buildRowDedupeKey(row) {
  const tradeId = getTradeId(row);
  const action = getAction(row);

  const r = getRealizedR(row);
  const pnl = getPnlPct(row);

  return [
    tradeId || normalizeSymbol(row?.symbol),
    getSide(row),
    action,
    getTimestamp(row),
    row?.entry ?? row?.entryPrice ?? "",
    row?.exit ?? row?.exitPrice ?? "",
    r ?? "",
    pnl ?? "",
  ].join("|");
}

function dedupeRows(rows) {
  const seen = new Set();
  const out = [];

  for (const row of safeArray(rows)) {
    if (!row || typeof row !== "object") continue;

    const key = buildRowDedupeKey(row);
    if (seen.has(key)) continue;

    seen.add(key);
    out.push(row);
  }

  return out;
}

// ================= DIMENSIONS =================

function bucketRange(value, buckets) {
  const n = safeNumber(value, 0);

  for (const bucket of buckets) {
    if (n >= bucket.min && n < bucket.max) return bucket.label;
  }

  return buckets[buckets.length - 1]?.label || "UNKNOWN";
}

function getBps(spreadPct) {
  const s = safeNumber(spreadPct, 0);
  return s * 10000;
}

function isObAgainst(row) {
  const side = getSide(row);
  const ob = normalizeText(row?.obBias);

  if (side === "LONG" && ob === "BEARISH") return true;
  if (side === "SHORT" && ob === "BULLISH") return true;

  return false;
}

function isObWith(row) {
  const side = getSide(row);
  const ob = normalizeText(row?.obBias);

  if (side === "LONG" && ob === "BULLISH") return true;
  if (side === "SHORT" && ob === "BEARISH") return true;

  return false;
}

function buildQualityBucket(row) {
  const confluence = safeNumber(row?.confluence, 0);
  const sniperScore = safeNumber(row?.sniperScore, 0);
  const score = safeNumber(row?.score ?? row?.moveScore, 0);
  const q = avg([confluence, sniperScore, score].filter(v => v > 0));

  if (q >= 85) return "Q5_ELITE";
  if (q >= 75) return "Q4_STRONG";
  if (q >= 65) return "Q3_BASE";
  if (q >= 50) return "Q2_LOW";

  return "Q1_WEAK";
}

function buildMarketBucket(row) {
  const spreadBps = getBps(row?.spreadPct);
  const depth = safeNumber(row?.depthMinUsd1p ?? row?.depthUsd1p, 0);
  const obAgainst = isObAgainst(row);
  const obWith = isObWith(row);
  const funding = Math.abs(safeNumber(row?.fundingRate ?? row?.funding, 0));

  let penalty = 0;

  if (obAgainst) penalty += 2;
  if (!obWith && normalizeText(row?.obBias) !== "NEUTRAL") penalty += 1;

  if (spreadBps > 25) penalty += 2;
  else if (spreadBps > 16) penalty += 1;

  if (depth > 0 && depth < 10000) penalty += 2;
  else if (depth > 0 && depth < 50000) penalty += 1;

  if (funding >= 0.014) penalty += 1;

  if (penalty <= 0) return "M4_CLEAN";
  if (penalty <= 1) return "M3_NORMAL";
  if (penalty <= 3) return "M2_WEAK";

  return "M1_DIRTY";
}

function buildTimingBucket(row) {
  const stage = normalizeText(row?.stage || row?.scannerStage);
  const rsiZone = normalizeText(row?.rsiZone);
  const flow = normalizeText(row?.flow || row?.scannerFlow);

  let score = 0;

  if (stage === "ENTRY") score += 2;
  if (stage === "ALMOST") score += 1;

  if (["RUNNING", "SQUEEZE", "BREAKOUT"].includes(flow)) score += 1;
  if (["MID", "LOWER_1", "UPPER_1"].includes(rsiZone)) score += 1;
  if (["LOWER_3", "UPPER_3"].includes(rsiZone)) score -= 1;

  if (score >= 4) return "T4_PRECISE";
  if (score >= 3) return "T3_EARLY";
  if (score >= 1) return "T2_TIMED";

  return "T1_LATE";
}

function buildConfluenceBucket(row) {
  return bucketRange(safeNumber(row?.confluence, 0), [
    { min: 0, max: 50, label: "CONF_LT_50" },
    { min: 50, max: 65, label: "CONF_50_65" },
    { min: 65, max: 75, label: "CONF_65_75" },
    { min: 75, max: 85, label: "CONF_75_85" },
    { min: 85, max: 101, label: "CONF_85_100" },
  ]);
}

function buildSniperBucket(row) {
  return bucketRange(safeNumber(row?.sniperScore, 0), [
    { min: 0, max: 50, label: "SNIPER_LT_50" },
    { min: 50, max: 65, label: "SNIPER_50_65" },
    { min: 65, max: 75, label: "SNIPER_65_75" },
    { min: 75, max: 85, label: "SNIPER_75_85" },
    { min: 85, max: 101, label: "SNIPER_85_100" },
  ]);
}

function buildRrBucket(row) {
  const rr = safeNumber(row?.plannedRR ?? row?.rr ?? row?.targetR, 0);

  if (rr >= 2) return "RR_2p00_PLUS";
  if (rr >= 1.5) return "RR_1p50_2p00";
  if (rr >= 1.2) return "RR_1p20_1p50";
  if (rr >= 1) return "RR_1p00_1p20";

  return "RR_LT_1p00";
}

function buildScoreBucket(row) {
  return bucketRange(safeNumber(row?.score ?? row?.moveScore, 0), [
    { min: 0, max: 50, label: "SCORE_LT_50" },
    { min: 50, max: 65, label: "SCORE_50_65" },
    { min: 65, max: 75, label: "SCORE_65_75" },
    { min: 75, max: 85, label: "SCORE_75_85" },
    { min: 85, max: 101, label: "SCORE_85_100" },
  ]);
}

function buildStageBucket(row) {
  const stage = normalizeText(row?.stage || row?.scannerStage);

  if (stage === "ENTRY" || stage === "ALMOST") return "STAGE_ENTRY_OR_ALMOST";
  if (stage === "BUILDUP") return "STAGE_BUILDUP";

  return "STAGE_RADAR_OR_UNKNOWN";
}

function buildFlowBucket(row) {
  const flow = normalizeText(row?.flow || row?.scannerFlow);

  if (["SQUEEZE"].includes(flow)) return "FLOW_SQUEEZE";
  if (["RUNNING", "BREAKOUT"].includes(flow)) return "FLOW_RUNNING_OR_BREAKOUT";
  if (["TREND", "BUILDING"].includes(flow)) return "FLOW_TREND_OR_BUILDING";

  return "FLOW_NEUTRAL_OR_UNKNOWN";
}

function buildRsiBucket(row) {
  const rsi = normalizeText(row?.rsiZone);

  if (["LOWER_1", "LOWER_2", "LOWER_3", "MID"].includes(rsi)) {
    return "RSI_LOWER_OR_MID";
  }

  if (["UPPER_1", "UPPER_2", "UPPER_3", "MID"].includes(rsi)) {
    return "RSI_UPPER_OR_MID";
  }

  return "RSI_UNKNOWN";
}

function buildObBucket(row) {
  if (isObWith(row)) return "OB_REL_WITH_OR_NEUTRAL";

  const ob = normalizeText(row?.obBias);
  if (ob === "NEUTRAL" || !ob) return "OB_REL_NEUTRAL";

  if (isObAgainst(row)) return "OB_REL_AGAINST";

  return "OB_REL_UNKNOWN";
}

function buildSpreadBucket(row) {
  const bps = getBps(row?.spreadPct);

  if (bps <= 0) return "SPREAD_UNKNOWN";
  if (bps <= 5) return "SPREAD_LT_5BPS";
  if (bps <= 12) return "SPREAD_5_12BPS";
  if (bps <= 16) return "SPREAD_12_16BPS";
  if (bps <= 25) return "SPREAD_16_25BPS";

  return "SPREAD_GT_25BPS";
}

function buildDepthBucket(row) {
  const depth = safeNumber(row?.depthMinUsd1p ?? row?.depthUsd1p, 0);

  if (depth <= 0) return "DEPTH_UNKNOWN";
  if (depth < 10000) return "DEPTH_LT_10K";
  if (depth < 50000) return "DEPTH_10K_50K";
  if (depth < 100000) return "DEPTH_50K_100K";
  if (depth < 250000) return "DEPTH_100K_250K";

  return "DEPTH_250K_PLUS";
}

function buildBtcBucket(row) {
  const btc = normalizeText(row?.btcState);

  if (!btc || btc === "NEUTRAL" || btc === "UNKNOWN") return "BTC_REL_NEUTRAL";

  const side = getSide(row);

  if (side === "LONG" && btc.includes("BULL")) return "BTC_REL_WITH_OR_NEUTRAL";
  if (side === "SHORT" && btc.includes("BEAR")) return "BTC_REL_WITH_OR_NEUTRAL";

  return "BTC_REL_COUNTER";
}

function buildFundingBucket(row) {
  const funding = safeNumber(row?.fundingRate ?? row?.funding, 0);
  const side = getSide(row);

  if (Math.abs(funding) >= 0.018) return "FUNDING_EXTREME";

  if (side === "LONG" && funding > 0.014) return "FUNDING_CROWDED";
  if (side === "SHORT" && funding < -0.014) return "FUNDING_CROWDED";

  if (Math.abs(funding) >= 0.008) return "FUNDING_EDGE_WEAK";

  return "FUNDING_OK";
}

function buildTfBucket(row) {
  const alignment = normalizeText(row?.tfAlignment);
  const tfScore = safeNumber(row?.tfScore, 0);
  const tfStrength = safeNumber(row?.tfStrength, Math.abs(tfScore));

  if (alignment.includes("AGAINST")) return "TF_AGAINST";
  if (tfStrength >= 2 || alignment.includes("ALIGNED")) return "TF_ALIGNED";

  return "TF_MIXED";
}

function buildConfirmationBucket(row) {
  if (
    row?.pullbackConfirmed === true ||
    row?.retestConfirmed === true ||
    row?.sweepConfirmed === true ||
    row?.rsiPullbackAllowed === true ||
    row?.rsiContinuationAllowed === true
  ) {
    return "PULLBACK_OR_CONFIRMATION_OK";
  }

  return "PULLBACK_UNKNOWN";
}

function buildDefinitionParts(row) {
  return [
    buildQualityBucket(row),
    buildMarketBucket(row),
    buildTimingBucket(row),
    buildConfluenceBucket(row),
    buildSniperBucket(row),
    buildRrBucket(row),
    buildScoreBucket(row),
    buildStageBucket(row),
    buildFlowBucket(row),
    buildRsiBucket(row),
    buildObBucket(row),
    buildSpreadBucket(row),
    buildDepthBucket(row),
    buildBtcBucket(row),
    buildFundingBucket(row),
    buildTfBucket(row),
    buildConfirmationBucket(row),
  ];
}

function buildDefinition(row) {
  return buildDefinitionParts(row).join(" | ");
}

function getFamilyIndexFromId(familyId) {
  const match = String(familyId || "").match(/_(\d+)$/);
  const n = match ? Number(match[1]) : 0;

  if (!Number.isFinite(n) || n <= 0) return 0;

  return Math.min(FAMILY_COUNT_PER_SIDE, Math.max(1, Math.round(n)));
}

function getFamilyId(row) {
  const side = getSide(row);
  if (!side) return "";

  const rawFamilyId = normalizeText(getRawFamilyId(row));
  const rawSide = getSideFromFamilyId(rawFamilyId);
  const rawIndex = getFamilyIndexFromId(rawFamilyId);

  if (rawSide === side && rawIndex > 0) {
    return `${side}_${rawIndex}`;
  }

  const definition = buildDefinition(row);
  const index = (hashString(`${side}|${definition}`) % FAMILY_COUNT_PER_SIDE) + 1;

  return `${side}_${index}`;
}

function getDimensionIndexes(definitionParts) {
  const qualityPart = definitionParts.find(x => x.startsWith("Q")) || "Q0";
  const marketPart = definitionParts.find(x => x.startsWith("M")) || "M0";
  const timingPart = definitionParts.find(x => x.startsWith("T")) || "T0";

  const q = safeNumber(String(qualityPart).match(/^Q(\d+)/)?.[1], 0);
  const m = safeNumber(String(marketPart).match(/^M(\d+)/)?.[1], 0);
  const t = safeNumber(String(timingPart).match(/^T(\d+)/)?.[1], 0);

  return {
    qualityIndex: q,
    marketIndex: m,
    timingIndex: t,
    definitionIndex: q * 100 + m * 10 + t,
  };
}

function normalizeOutcomeRow(row) {
  if (!row || typeof row !== "object") return null;

  const side = getSide(row);
  const symbol = normalizeSymbol(row?.symbol);

  if (!side || !symbol) return null;

  const action = getAction(row);
  const realizedR = getRealizedR(row);
  const pnlPct = getPnlPct(row);

  const closed =
    row?.closed === true ||
    row?.isClosed === true ||
    action === "EXIT" ||
    Number.isFinite(Number(realizedR)) ||
    Number.isFinite(Number(pnlPct));

  const definitionParts = buildDefinitionParts(row);
  const indexes = getDimensionIndexes(definitionParts);
  const familyId = getFamilyId(row);

  const win =
    closed &&
    (
      Number(realizedR ?? 0) > 0 ||
      (!Number.isFinite(Number(realizedR)) && Number(pnlPct ?? 0) > 0)
    );

  const loss =
    closed &&
    (
      Number(realizedR ?? 0) < 0 ||
      (!Number.isFinite(Number(realizedR)) && Number(pnlPct ?? 0) < 0)
    );

  const breakeven =
    closed &&
    !win &&
    !loss;

  return {
    raw: row,

    profile: SYSTEM_PROFILE,

    tradeId: getTradeId(row),
    familyId,
    runnerFamilyId: familyId,
    analyzeFamilyId: familyId,
    analysisFamilyId: familyId,

    symbol,
    side,

    action,
    closed,
    open: action === "ENTRY" && !closed,
    pendingOutcome: !closed,

    win,
    loss,
    breakeven,

    realizedR: Number.isFinite(Number(realizedR)) ? Number(realizedR) : null,
    pnlPct: Number.isFinite(Number(pnlPct)) ? Number(pnlPct) : null,

    entry: safeNumber(row?.entry ?? row?.entryPrice ?? row?.openPrice, 0),
    exit: safeNumber(row?.exit ?? row?.exitPrice ?? row?.executionPrice, 0),

    confluence: safeNumber(row?.confluence, 0),
    sniperScore: safeNumber(row?.sniperScore, 0),
    score: safeNumber(row?.score ?? row?.moveScore, 0),
    moveScore: safeNumber(row?.moveScore ?? row?.score, 0),

    rr: safeNumber(row?.rr ?? row?.plannedRR ?? row?.targetR, 0),
    plannedRR: safeNumber(row?.plannedRR ?? row?.rr ?? row?.targetR, 0),
    targetR: safeNumber(row?.targetR ?? row?.plannedRR ?? row?.rr, 0),

    flow: normalizeText(row?.flow || row?.scannerFlow),
    scannerFlow: normalizeText(row?.scannerFlow || row?.flow),
    rsiZone: normalizeText(row?.rsiZone),
    obBias: normalizeText(row?.obBias || "NEUTRAL"),

    spreadPct: safeNumber(row?.spreadPct, 0),
    spreadBps: getBps(row?.spreadPct),
    depthMinUsd1p: safeNumber(row?.depthMinUsd1p ?? row?.depthUsd1p, 0),

    runnerPressure: safeNumber(row?.runnerPressure, 0),
    runnerAcceleration: safeNumber(row?.runnerAcceleration, 0),

    btcState: normalizeText(row?.btcState),
    fundingRate: safeNumber(row?.fundingRate ?? row?.funding, 0),
    tfScore: safeNumber(row?.tfScore, 0),
    tfStrength: safeNumber(row?.tfStrength, Math.abs(safeNumber(row?.tfScore, 0))),
    tfAlignment: normalizeText(row?.tfAlignment),

    setupClass: normalizeText(row?.setupClass),
    entryType: normalizeText(row?.entryType || row?.runnerEntryType),
    runnerEntryType: normalizeText(row?.runnerEntryType || row?.entryType),

    source: normalizeText(row?.source || row?.analyzeSource || "UNKNOWN"),

    qualityBucket: definitionParts[0],
    marketBucket: definitionParts[1],
    timingBucket: definitionParts[2],
    definitionParts,
    definition: definitionParts.join(" | "),

    ...indexes,

    ts: getTimestamp(row),
  };
}

// ================= FAMILY AGGREGATION =================

function createEmptyFamily(side, index) {
  const familyId = `${side}_${index}`;

  return {
    id: familyId,
    familyId,
    runnerFamilyId: familyId,
    analyzeFamilyId: familyId,
    analysisFamilyId: familyId,

    profile: SYSTEM_PROFILE,
    side,
    sideLabel: side,

    index,
    familyIndex: index,

    quality: "EMPTY",
    status: "EMPTY",
    bucket: "EMPTY",
    label: "EMPTY",

    definition: `EMPTY_${familyId}`,
    familyDefinition: `EMPTY_${familyId}`,
    definitionParts: [`EMPTY_${familyId}`],

    qualityBucket: "EMPTY",
    marketBucket: "EMPTY",
    timingBucket: "EMPTY",

    qualityIndex: 0,
    marketIndex: 0,
    timingIndex: 0,
    definitionIndex: index,

    actions: 0,
    served: 0,
    trades: 0,
    observed: 0,

    closed: 0,
    open: 0,
    pendingOutcome: 0,

    wins: 0,
    losses: 0,
    breakeven: 0,

    winrateNum: 0,
    winratePct: 0,
    winrate: "0%",

    totalR: 0,
    avgR: 0,
    medianR: 0,

    totalPnlPct: 0,
    avgPnlPct: 0,

    grossWinR: 0,
    grossLossR: 0,
    profitFactorR: 0,
    pf: 0,

    avgMfeR: 0,
    avgMaeR: 0,

    avgConfluence: 0,
    avgSniperScore: 0,
    avgScore: 0,
    avgRR: 0,
    avgSpreadBps: 0,
    avgDepthMinUsd1p: 0,
    avgRunnerPressure: 0,
    avgRunnerAcceleration: 0,

    keepRatio: 0,

    pnlScore: 0,
    runnerPnlScore: 0,
    balanceScore: 0,
    winrateScore: 0,
    qualityScore: 0,

    ready: false,
    allowed: false,
    blocked: false,

    topSymbols: [],
    examples: [],
  };
}

function classifyFamily(stats, minClosed) {
  const closed = safeNumber(stats.closed, 0);
  const totalR = safeNumber(stats.totalR, 0);
  const avgR = safeNumber(stats.avgR, 0);
  const totalPnlPct = safeNumber(stats.totalPnlPct, 0);
  const pf = safeNumber(stats.profitFactorR, 0);
  const winrate = safeNumber(stats.winrateNum, 0);

  if (stats.trades <= 0 && stats.observed <= 0) return "EMPTY";

  if (closed < minClosed) return "COLLECTING";

  if (
    closed >= HOT_MIN_CLOSED &&
    totalR > 0 &&
    totalPnlPct > 0 &&
    avgR >= 0.35 &&
    pf >= 1.75 &&
    winrate >= 0.55
  ) {
    return "HOT";
  }

  if (
    closed >= GOOD_MIN_CLOSED &&
    totalR > 0 &&
    totalPnlPct > 0 &&
    avgR >= 0.25 &&
    pf >= 1.35
  ) {
    return "GOOD";
  }

  if (
    closed >= STABLE_MIN_CLOSED &&
    totalR >= 0 &&
    avgR >= 0.10 &&
    pf >= 1.05
  ) {
    return "STABLE";
  }

  if (
    closed >= minClosed &&
    (
      totalR < 0 ||
      avgR < 0 ||
      pf < 0.95
    )
  ) {
    return "BAD";
  }

  return "COLLECTING";
}

function qualitySortRank(quality) {
  const q = normalizeText(quality);

  if (q === "HOT") return 5;
  if (q === "GOOD") return 4;
  if (q === "STABLE") return 3;
  if (q === "COLLECTING") return 2;
  if (q === "BAD") return 1;

  return 0;
}

function finalizeFamily(base, rows, allRowCount, minClosed) {
  if (!rows.length) return base;

  const closedRows = rows.filter(row => row.closed);
  const openRows = rows.filter(row => row.open);
  const pendingRows = rows.filter(row => row.pendingOutcome);

  const wins = closedRows.filter(row => row.win).length;
  const losses = closedRows.filter(row => row.loss).length;
  const breakeven = closedRows.filter(row => row.breakeven).length;

  const rValues = closedRows
    .map(row => row.realizedR)
    .filter(value => Number.isFinite(Number(value)));

  const pnlValues = closedRows
    .map(row => row.pnlPct)
    .filter(value => Number.isFinite(Number(value)));

  const grossWinR = rValues
    .filter(value => value > 0)
    .reduce((acc, value) => acc + value, 0);

  const grossLossR = Math.abs(
    rValues
      .filter(value => value < 0)
      .reduce((acc, value) => acc + value, 0)
  );

  const sortedR = [...rValues].sort((a, b) => a - b);
  const medianR = sortedR.length
    ? sortedR[Math.floor(sortedR.length / 2)]
    : 0;

  const definitionCounts = {};

  for (const row of rows) {
    incrementCounter(definitionCounts, row.definition);
  }

  const bestDefinition = Object.entries(definitionCounts)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || base.definition;

  const sampleRow =
    rows.find(row => row.definition === bestDefinition) ||
    rows[0];

  const symbolCounts = {};

  for (const row of rows) {
    incrementCounter(symbolCounts, row.symbol);
  }

  const closed = closedRows.length;
  const totalR = sum(rValues);
  const avgR = rValues.length ? totalR / rValues.length : 0;

  const totalPnlPct = sum(pnlValues);
  const avgPnlPct = pnlValues.length ? totalPnlPct / pnlValues.length : 0;

  const winrateNum = closed ? wins / closed : 0;

  const profitFactorR = grossLossR > 0
    ? grossWinR / grossLossR
    : grossWinR > 0
      ? 999
      : 0;

  const keepRatio = allRowCount > 0 ? rows.length / allRowCount : 0;

  const avgConfluence = avg(rows.map(row => row.confluence));
  const avgSniperScore = avg(rows.map(row => row.sniperScore));
  const avgScore = avg(rows.map(row => row.score));
  const avgRR = avg(rows.map(row => row.plannedRR || row.rr));
  const avgSpreadBps = avg(rows.map(row => row.spreadBps).filter(v => v > 0));
  const avgDepthMinUsd1p = avg(rows.map(row => row.depthMinUsd1p).filter(v => v > 0));
  const avgRunnerPressure = avg(rows.map(row => row.runnerPressure));
  const avgRunnerAcceleration = avg(rows.map(row => row.runnerAcceleration));

  const pnlScore =
    totalPnlPct * 1.35 +
    totalR * 1.20 +
    avgPnlPct * 18 +
    avgR * 90 +
    Math.min(profitFactorR, 8) * 12 +
    winrateNum * 20 +
    keepRatio * 15;

  const balanceScore =
    totalR * 1.0 +
    avgR * 100 +
    Math.min(profitFactorR, 8) * 20 +
    winrateNum * 40 +
    Math.min(closed, 100) * 0.30;

  const winrateScore =
    winrateNum * 100 +
    avgR * 30 +
    Math.min(profitFactorR, 8) * 5 +
    Math.min(closed, 100) * 0.15;

  const qualityScore =
    avgConfluence * 0.20 +
    avgSniperScore * 0.20 +
    avgScore * 0.20 +
    avgRunnerPressure * 3 +
    avgRunnerAcceleration * 3 +
    Math.min(avgDepthMinUsd1p / 10000, 20) -
    avgSpreadBps * 0.25;

  const tmp = {
    ...base,

    definition: bestDefinition,
    familyDefinition: bestDefinition,
    definitionParts: sampleRow.definitionParts,

    qualityBucket: sampleRow.qualityBucket,
    marketBucket: sampleRow.marketBucket,
    timingBucket: sampleRow.timingBucket,

    qualityIndex: sampleRow.qualityIndex,
    marketIndex: sampleRow.marketIndex,
    timingIndex: sampleRow.timingIndex,
    definitionIndex: sampleRow.definitionIndex,

    actions: rows.length,
    served: rows.length,
    trades: rows.length,
    observed: rows.length,

    closed,
    open: openRows.length,
    pendingOutcome: pendingRows.length,

    wins,
    losses,
    breakeven,

    winrateNum: round(winrateNum, 4),
    winratePct: round(winrateNum * 100, 2),
    winrate: pctString(winrateNum, 1),

    totalR: round(totalR, 3),
    avgR: round(avgR, 3),
    medianR: round(medianR, 3),

    totalPnlPct: round(totalPnlPct, 3),
    avgPnlPct: round(avgPnlPct, 3),

    grossWinR: round(grossWinR, 3),
    grossLossR: round(grossLossR, 3),
    profitFactorR: round(profitFactorR, 3),
    pf: round(profitFactorR, 3),

    avgMfeR: round(avg(rows.map(row => safeNumber(row.raw?.mfeR, 0))), 3),
    avgMaeR: round(avg(rows.map(row => safeNumber(row.raw?.maeR, 0))), 3),

    avgConfluence: round(avgConfluence, 2),
    avgSniperScore: round(avgSniperScore, 2),
    avgScore: round(avgScore, 2),
    avgRR: round(avgRR, 3),
    avgSpreadBps: round(avgSpreadBps, 3),
    avgDepthMinUsd1p: round(avgDepthMinUsd1p, 2),
    avgRunnerPressure: round(avgRunnerPressure, 3),
    avgRunnerAcceleration: round(avgRunnerAcceleration, 3),

    keepRatio: round(keepRatio, 4),

    pnlScore: round(pnlScore, 3),
    runnerPnlScore: round(pnlScore, 3),
    balanceScore: round(balanceScore, 3),
    winrateScore: round(winrateScore, 3),
    qualityScore: round(qualityScore, 3),

    topSymbols: Object.entries(symbolCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([symbol, count]) => ({ symbol, count })),

    examples: rows
      .slice(-MAX_EXAMPLES_PER_FAMILY)
      .map(row => ({
        symbol: row.symbol,
        side: row.side,
        action: row.action,
        closed: row.closed,
        realizedR: row.realizedR,
        pnlPct: row.pnlPct,
        confluence: row.confluence,
        sniperScore: row.sniperScore,
        score: row.score,
        flow: row.flow,
        scannerFlow: row.scannerFlow,
        rsiZone: row.rsiZone,
        obBias: row.obBias,
        spreadBps: round(row.spreadBps, 3),
        depthMinUsd1p: row.depthMinUsd1p,
        ts: row.ts,
      })),
  };

  const quality = classifyFamily(tmp, minClosed);
  const ready = closed >= minClosed;
  const allowed = ready && ["HOT", "GOOD", "STABLE"].includes(quality) && totalR > 0 && avgR > 0;
  const blocked = ready && quality === "BAD";

  return {
    ...tmp,

    quality,
    status: quality,
    bucket: quality,
    label: quality,

    ready,
    allowed,
    blocked,
  };
}

// ================= REPORT BUILDING =================

function buildFamilyMatrix(rows, minClosed) {
  const normalizedRows = dedupeRows(rows)
    .map(normalizeOutcomeRow)
    .filter(Boolean);

  const groups = new Map();

  for (const row of normalizedRows) {
    const familyId = row.familyId;

    if (!groups.has(familyId)) {
      groups.set(familyId, []);
    }

    groups.get(familyId).push(row);
  }

  const long = [];
  const short = [];

  for (let i = 1; i <= FAMILY_COUNT_PER_SIDE; i++) {
    const longBase = createEmptyFamily("LONG", i);
    const shortBase = createEmptyFamily("SHORT", i);

    long.push(
      finalizeFamily(
        longBase,
        safeArray(groups.get(longBase.familyId)),
        normalizedRows.length,
        minClosed
      )
    );

    short.push(
      finalizeFamily(
        shortBase,
        safeArray(groups.get(shortBase.familyId)),
        normalizedRows.length,
        minClosed
      )
    );
  }

  const all = [...long, ...short];

  return {
    normalizedRows,
    long,
    short,
    all,
  };
}

function sortByRunnerPnl(a, b) {
  const pnlDiff = safeNumber(b.totalPnlPct, 0) - safeNumber(a.totalPnlPct, 0);
  if (pnlDiff !== 0) return pnlDiff;

  const rDiff = safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0);
  if (rDiff !== 0) return rDiff;

  const scoreDiff = safeNumber(b.runnerPnlScore, 0) - safeNumber(a.runnerPnlScore, 0);
  if (scoreDiff !== 0) return scoreDiff;

  return safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0);
}

function sortByTotalR(a, b) {
  const rDiff = safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0);
  if (rDiff !== 0) return rDiff;

  return sortByRunnerPnl(a, b);
}

function sortByBalance(a, b) {
  const qDiff = qualitySortRank(b.quality) - qualitySortRank(a.quality);
  if (qDiff !== 0) return qDiff;

  const scoreDiff = safeNumber(b.balanceScore, 0) - safeNumber(a.balanceScore, 0);
  if (scoreDiff !== 0) return scoreDiff;

  return sortByRunnerPnl(a, b);
}

function sortByWinrate(a, b) {
  const wrDiff = safeNumber(b.winrateNum, 0) - safeNumber(a.winrateNum, 0);
  if (wrDiff !== 0) return wrDiff;

  const closedDiff = safeNumber(b.closed, 0) - safeNumber(a.closed, 0);
  if (closedDiff !== 0) return closedDiff;

  return sortByRunnerPnl(a, b);
}

function buildRankings(all, minClosed) {
  const ranked = [...all].sort((a, b) => {
    const qualityDiff = qualitySortRank(b.quality) - qualitySortRank(a.quality);
    if (qualityDiff !== 0) return qualityDiff;

    return sortByRunnerPnl(a, b);
  });

  const eligible = all.filter(family => {
    return (
      family.closed >= minClosed &&
      family.totalR > 0 &&
      family.avgR > 0 &&
      family.profitFactorR > 1
    );
  });

  const winners = eligible
    .filter(family => ["HOT", "GOOD", "STABLE"].includes(family.quality))
    .sort(sortByRunnerPnl);

  const bestRunnerPnl = [...eligible]
    .filter(family => family.totalPnlPct > 0 || family.totalR > 0)
    .sort(sortByRunnerPnl)
    .slice(0, MAX_BEST);

  const bestPnl = [...bestRunnerPnl];

  const bestTotalR = [...eligible]
    .sort(sortByTotalR)
    .slice(0, MAX_BEST);

  const bestBalance = [...eligible]
    .sort(sortByBalance)
    .slice(0, MAX_BEST);

  const bestWinrate = [...eligible]
    .sort(sortByWinrate)
    .slice(0, MAX_BEST);

  const bestAvgR = [...eligible]
    .sort((a, b) => {
      const avgDiff = safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0);
      if (avgDiff !== 0) return avgDiff;

      return sortByRunnerPnl(a, b);
    })
    .slice(0, MAX_BEST);

  const worst = all
    .filter(family => family.closed >= minClosed)
    .sort((a, b) => {
      const rDiff = safeNumber(a.totalR, 0) - safeNumber(b.totalR, 0);
      if (rDiff !== 0) return rDiff;

      return safeNumber(a.avgR, 0) - safeNumber(b.avgR, 0);
    })
    .slice(0, MAX_BEST);

  return {
    ranked: ranked.slice(0, MAX_RANKED),

    winners: winners.slice(0, MAX_BEST),

    // Main-compatible aliases.
    best: bestRunnerPnl,
    bestRunnerPnl,
    bestPnl,
    bestTotalR,
    bestBalance,
    bestWinrate,
    bestAvgR,

    worst,
  };
}

function summarizeFamilies(families) {
  const all = safeArray(families);

  return {
    hotFamilies: all.filter(f => f.quality === "HOT").length,
    goodFamilies: all.filter(f => f.quality === "GOOD").length,
    stableFamilies: all.filter(f => f.quality === "STABLE").length,
    badFamilies: all.filter(f => f.quality === "BAD").length,
    collectingFamilies: all.filter(f => f.quality === "COLLECTING").length,
    emptyFamilies: all.filter(f => f.quality === "EMPTY").length,
  };
}

function buildSideSummary(families) {
  const rows = safeArray(families);
  const closed = sum(rows.map(row => row.closed));
  const wins = sum(rows.map(row => row.wins));
  const losses = sum(rows.map(row => row.losses));
  const breakeven = sum(rows.map(row => row.breakeven));

  return {
    families: rows.length,
    trades: sum(rows.map(row => row.trades)),
    observed: sum(rows.map(row => row.observed)),
    closed,
    open: sum(rows.map(row => row.open)),
    pendingOutcome: sum(rows.map(row => row.pendingOutcome)),
    wins,
    losses,
    breakeven,
    winrateNum: closed ? round(wins / closed, 4) : 0,
    winrate: closed ? pctString(wins / closed, 1) : "0%",
    totalR: round(sum(rows.map(row => row.totalR)), 3),
    avgR: closed ? round(sum(rows.map(row => row.totalR)) / closed, 3) : 0,
    totalPnlPct: round(sum(rows.map(row => row.totalPnlPct)), 3),
    avgPnlPct: closed ? round(sum(rows.map(row => row.totalPnlPct)) / closed, 3) : 0,
    ...summarizeFamilies(rows),
  };
}

function buildSummary({ all, long, short, normalizedRows, minClosed }) {
  const closedRows = normalizedRows.filter(row => row.closed);
  const openRows = normalizedRows.filter(row => row.open);
  const pendingRows = normalizedRows.filter(row => row.pendingOutcome);

  const wins = closedRows.filter(row => row.win).length;
  const losses = closedRows.filter(row => row.loss).length;
  const breakeven = closedRows.filter(row => row.breakeven).length;

  const totalR = sum(
    closedRows
      .map(row => row.realizedR)
      .filter(value => Number.isFinite(Number(value)))
  );

  const totalPnlPct = sum(
    closedRows
      .map(row => row.pnlPct)
      .filter(value => Number.isFinite(Number(value)))
  );

  const closed = closedRows.length;

  return {
    profile: SYSTEM_PROFILE,

    actions: normalizedRows.length,
    trades: normalizedRows.length,
    observed: normalizedRows.length,

    open: openRows.length,
    closed,
    pendingOutcome: pendingRows.length,

    wins,
    losses,
    breakeven,

    winrateNum: closed ? round(wins / closed, 4) : 0,
    winrate: closed ? pctString(wins / closed, 1) : "0%",

    totalR: round(totalR, 3),
    avgR: closed ? round(totalR / closed, 3) : 0,

    totalPnlPct: round(totalPnlPct, 3),
    avgPnlPct: closed ? round(totalPnlPct / closed, 3) : 0,

    longFamilies: long.length,
    shortFamilies: short.length,
    totalFamilies: all.length,

    minClosed,

    ...summarizeFamilies(all),

    long: buildSideSummary(long),
    short: buildSideSummary(short),
  };
}

function buildSelection(rankings, all, minClosed) {
  const allowed = rankings.bestRunnerPnl
    .filter(family => family.closed >= minClosed)
    .filter(family => family.totalR > 0)
    .filter(family => family.avgR > 0)
    .slice(0, MAX_BEST);

  const blocked = all
    .filter(family => family.closed >= minClosed)
    .filter(family => family.quality === "BAD" || family.totalR < 0 || family.avgR < 0)
    .sort((a, b) => safeNumber(a.totalR, 0) - safeNumber(b.totalR, 0))
    .slice(0, MAX_BEST);

  return {
    ready: allowed.length > 0,
    objective: "RUNNER_PNL_FIRST",

    minClosed,

    allowedFamilyIds: allowed.map(family => family.familyId),
    allowedRunnerFamilyIds: allowed.map(family => family.runnerFamilyId),

    blockedFamilyIds: blocked.map(family => family.familyId),
    blockedRunnerFamilyIds: blocked.map(family => family.runnerFamilyId),

    bestPnlFamilyId: allowed[0]?.familyId || null,
    bestPnlRunnerFamilyId: allowed[0]?.runnerFamilyId || null,

    allowedFamilies: allowed,
    blockedFamilies: blocked,
  };
}

// ================= PUBLIC API =================

export function buildRunnerAnalyzeReport(events = [], options = {}) {
  const minClosed = Math.max(
    1,
    Math.round(safeNumber(options.minClosed, DEFAULT_MIN_CLOSED))
  );

  const matrix = buildFamilyMatrix(events, minClosed);
  const rankings = buildRankings(matrix.all, minClosed);
  const summary = buildSummary({
    all: matrix.all,
    long: matrix.long,
    short: matrix.short,
    normalizedRows: matrix.normalizedRows,
    minClosed,
  });

  const selection = buildSelection(rankings, matrix.all, minClosed);

  return {
    ok: true,
    profile: SYSTEM_PROFILE,
    tag: "RUNNER_ANALYZE_REPORT",
    generatedAt: new Date().toISOString(),
    servedAt: Date.now(),

    objective: {
      mode: "RUNNER_PNL_FIRST",
      primary: "totalPnlPct",
      secondary: "totalR",
      tertiary: "avgR",
      support: ["profitFactorR", "winrate", "closed"],
    },

    config: {
      profile: SYSTEM_PROFILE,
      minClosed,
      longFamilyCount: FAMILY_COUNT_PER_SIDE,
      shortFamilyCount: FAMILY_COUNT_PER_SIDE,
      totalFamilyCount: FAMILY_COUNT_PER_SIDE * 2,
    },

    summary,

    families: {
      all: matrix.all,
      long: matrix.long,
      short: matrix.short,

      ranked: rankings.ranked,

      winners: rankings.winners,

      // Main-compatible aliases.
      best: rankings.best,
      bestRunnerPnl: rankings.bestRunnerPnl,
      bestPnl: rankings.bestPnl,
      bestTotalR: rankings.bestTotalR,
      bestBalance: rankings.bestBalance,
      bestWinrate: rankings.bestWinrate,
      bestAvgR: rankings.bestAvgR,

      worst: rankings.worst,
    },

    selection,

    diagnostics: {
      inputEvents: safeArray(events).length,
      normalizedEvents: matrix.normalizedRows.length,
      dedupeApplied: safeArray(events).length - matrix.normalizedRows.length,
      longRows: matrix.normalizedRows.filter(row => row.side === "LONG").length,
      shortRows: matrix.normalizedRows.filter(row => row.side === "SHORT").length,
      closedRows: matrix.normalizedRows.filter(row => row.closed).length,
      openRows: matrix.normalizedRows.filter(row => row.open).length,
      pendingRows: matrix.normalizedRows.filter(row => row.pendingOutcome).length,
    },
  };
}

// Aliases voor je dynamic imports.
export function buildAnalyzeReport(events = [], options = {}) {
  return buildRunnerAnalyzeReport(events, options);
}

export function buildFamilyReport(events = [], options = {}) {
  return buildRunnerAnalyzeReport(events, options);
}

export function buildReport(events = [], options = {}) {
  return buildRunnerAnalyzeReport(events, options);
}

export function analyzeEvents(events = [], options = {}) {
  return buildRunnerAnalyzeReport(events, options);
}

export function createAnalyzeReport(events = [], options = {}) {
  return buildRunnerAnalyzeReport(events, options);
}

export default {
  buildRunnerAnalyzeReport,
  buildAnalyzeReport,
  buildFamilyReport,
  buildReport,
  analyzeEvents,
  createAnalyzeReport,
};