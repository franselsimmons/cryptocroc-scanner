// ================= RUNNER FAMILY ENGINE =================
// Doel:
// - Zelfde family matrix als main: 50 LONG + 50 SHORT.
// - Runner objective = PnL-first.
// - FamilyId = SIDE_(Q/M/T index)
//   index = ((qualityIndex - 1) * 10) + ((marketIndex - 1) * 2) + timingIndex
// - Voorbeeld:
//   Q5 M1 T1 => 41
//   Q5 M4 T2 => 48
//   Q2 M3 T2 => 16

const FAMILY_COUNT_PER_SIDE = 50;
const BREAKEVEN_R_EPS_DEFAULT = 0.05;
const MAX_EXAMPLES_DEFAULT = 8;

const RUNNER_FLOWS = new Set([
  "SQUEEZE",
  "RUNNING",
  "BREAKOUT",
  "BUILDING",
  "TREND",
]);

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
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;

  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function pct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0%";
  return `${round(n * 100, 1)}%`;
}

function normalizeText(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeSide(value) {
  const s = String(value || "").trim().toLowerCase();

  if (["bull", "long", "buy"].includes(s)) return "LONG";
  if (["bear", "short", "sell"].includes(s)) return "SHORT";

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

function normalizeFlow(value) {
  return normalizeText(value || "UNKNOWN");
}

function normalizeTimestamp(value, fallback = Date.now()) {
  if (value instanceof Date) return value.getTime();

  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;

  const parsed = Date.parse(String(value || ""));
  if (Number.isFinite(parsed)) return parsed;

  return fallback;
}

function getFirstNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }

  return null;
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
  const side = normalizeSide(row?.side || row?.direction || row?.tradeSide);
  const entry = getFirstNumber(row?.entry, row?.entryPrice, row?.openPrice);
  const ts = normalizeTimestamp(
    row?.openedAt ||
      row?.entryTs ||
      row?.createdAt ||
      row?.analyzeTs ||
      row?.ts ||
      row?.timestamp,
    0
  );

  if (symbol && side && entry && ts > 0) {
    return `RUNNER_${symbol}_${side}_${ts}_${Number(entry).toPrecision(12)}`;
  }

  if (symbol && side && entry) {
    return `RUNNER_${symbol}_${side}_${Number(entry).toPrecision(12)}`;
  }

  return "";
}

function getResultR(row) {
  return getFirstNumber(
    row?.resultR,
    row?.realizedR,
    row?.exitR,
    row?.pnlR,
    row?.outcomeR,
    row?.rMultiple,
    row?.r
  );
}

function getPnlPct(row) {
  return getFirstNumber(
    row?.pnlPct,
    row?.pnlPercent,
    row?.realizedPnlPct,
    row?.resultPnlPct,
    row?.profitPct
  );
}

function hasClosedSignal(row) {
  if (row?.closed === true || row?.isClosed === true) return true;

  const action = normalizeText(row?.action || row?.analyzeLifecycle);
  if (action === "EXIT" || action === "CLOSED" || action === "CLOSE") return true;

  if (row?.closedAt || row?.exitedAt || row?.exitAt || row?.exitTs) return true;
  if (getResultR(row) !== null) return true;
  if (getPnlPct(row) !== null) return true;

  return false;
}

function getExitReason(row) {
  const reason = normalizeText(
    row?.exitReason ||
      row?.reason ||
      row?.status ||
      row?.state ||
      ""
  );

  if (!reason) return "UNKNOWN";
  return reason;
}

function isTrueExitReason(reason) {
  const r = normalizeText(reason);

  return (
    r === "TP" ||
    r === "SL" ||
    r === "BE_SL" ||
    r === "TRAIL_SL" ||
    r === "STOP" ||
    r === "STOP_LOSS" ||
    r === "TAKE_PROFIT" ||
    r === "HIT_SL" ||
    r === "HORIZON_DONE" ||
    r.includes("TP") ||
    r.includes("SL") ||
    r.includes("EXIT") ||
    r.includes("HORIZON")
  );
}

function rowCompletenessScore(row) {
  let score = 0;

  if (hasClosedSignal(row)) score += 50;
  if (getResultR(row) !== null) score += 30;
  if (getPnlPct(row) !== null) score += 10;
  if (isTrueExitReason(getExitReason(row))) score += 10;
  if (row?.syntheticAnalyzeEntry) score -= 5;

  score += Math.min(normalizeTimestamp(row?.updatedAt || row?.closedAt || row?.ts, 0) / 1e15, 1);

  return score;
}

function dedupeRows(rows) {
  const map = new Map();

  for (const row of safeArray(rows)) {
    const tradeId = getTradeId(row);

    const fallbackKey = [
      normalizeSymbol(row?.symbol),
      normalizeSide(row?.side),
      safeNumber(row?.entry ?? row?.entryPrice ?? row?.openPrice, 0).toPrecision(12),
      normalizeTimestamp(row?.openedAt || row?.entryTs || row?.createdAt || row?.ts, 0),
    ].join("|");

    const key = tradeId || fallbackKey;
    if (!key.trim()) continue;

    const prev = map.get(key);

    if (!prev) {
      map.set(key, row);
      continue;
    }

    if (rowCompletenessScore(row) >= rowCompletenessScore(prev)) {
      map.set(key, row);
    }
  }

  return Array.from(map.values());
}

// ================= BUCKETS =================

function qualityIndexFromRow(row) {
  const conf = safeNumber(row.confluence, 0);
  const sniper = safeNumber(row.sniperScore ?? row.sniper, 0);
  const rr = safeNumber(row.plannedRR ?? row.rr ?? row.targetR, 0);
  const score = safeNumber(row.score ?? row.moveScore, 0);

  const parts = [
    bucketIndex(conf, [50, 65, 75, 85]),
    bucketIndex(sniper, [50, 65, 75, 85]),
    rr < 1 ? 1 : rr < 1.2 ? 2 : rr < 1.5 ? 3 : rr < 2 ? 4 : 5,
    bucketIndex(score, [50, 65, 75, 85]),
  ];

  // Runner gebruikt een conservatieve quality-bucket:
  // één zwakke component hoort in lagere Q, net als main.
  return Math.max(1, Math.min(5, Math.floor(avg(parts))));
}

function bucketIndex(value, thresholds) {
  const n = safeNumber(value, 0);

  if (n < thresholds[0]) return 1;
  if (n < thresholds[1]) return 2;
  if (n < thresholds[2]) return 3;
  if (n < thresholds[3]) return 4;

  return 5;
}

function getDirectionalObState(row) {
  const side = normalizeSide(row.side);
  const ob = normalizeText(row.obBias);

  if (!ob || ob === "UNKNOWN") return "NEUTRAL";
  if (ob === "NEUTRAL") return "NEUTRAL";

  if (side === "LONG") {
    if (ob === "BULLISH") return "WITH";
    if (ob === "BEARISH") return "AGAINST";
  }

  if (side === "SHORT") {
    if (ob === "BEARISH") return "WITH";
    if (ob === "BULLISH") return "AGAINST";
  }

  return "NEUTRAL";
}

function normalizeSpreadBps(row) {
  const spreadBps = getFirstNumber(row?.spreadBps);
  if (spreadBps !== null) return spreadBps;

  const spreadPct = getFirstNumber(row?.spreadPct);
  if (spreadPct === null) return 999;

  // spreadPct meestal decimal: 0.001 = 10 bps.
  if (spreadPct <= 0.05) return spreadPct * 10000;

  // fallback als pct in procenten binnenkomt.
  return spreadPct * 100;
}

function getDepth(row) {
  return safeNumber(row.depthMinUsd1p ?? row.depthUsd1p, 0);
}

function getDirectionalBtcState(row) {
  const side = normalizeSide(row.side);
  const state = normalizeText(row.btcState || row.btc?.state);

  if (!state || state === "UNKNOWN" || state === "NEUTRAL") return "NEUTRAL";

  if (side === "LONG") {
    if (state.includes("BULL")) return "WITH";
    if (state.includes("BEAR")) return "COUNTER";
  }

  if (side === "SHORT") {
    if (state.includes("BEAR")) return "WITH";
    if (state.includes("BULL")) return "COUNTER";
  }

  return "NEUTRAL";
}

function getFundingState(row) {
  const side = normalizeSide(row.side);
  const funding = safeNumber(row.fundingRate ?? row.funding, 0);

  if (Math.abs(funding) <= 0.0004) return "NEUTRAL";

  if (side === "LONG") {
    if (funding < 0) return "OPTIMAL";
    if (funding <= 0.004) return "OK";
    if (funding <= 0.014) return "EDGE_WEAK";
    return "CROWDED";
  }

  if (side === "SHORT") {
    if (funding > 0) return "OPTIMAL";
    if (funding >= -0.004) return "OK";
    if (funding >= -0.014) return "EDGE_WEAK";
    return "CROWDED";
  }

  return "NEUTRAL";
}

function marketIndexFromRow(row) {
  const ob = getDirectionalObState(row);
  const spreadBps = normalizeSpreadBps(row);
  const depth = getDepth(row);
  const btc = getDirectionalBtcState(row);
  const funding = getFundingState(row);

  const scores = [];

  // OB
  if (ob === "AGAINST") scores.push(1);
  else if (ob === "NEUTRAL") scores.push(3);
  else if (ob === "WITH") scores.push(5);
  else scores.push(3);

  // Spread
  if (spreadBps > 25) scores.push(1);
  else if (spreadBps > 16) scores.push(2);
  else if (spreadBps > 8) scores.push(3);
  else if (spreadBps > 5) scores.push(4);
  else scores.push(5);

  // Depth
  if (depth > 0 && depth < 10000) scores.push(1);
  else if (depth < 50000) scores.push(2);
  else if (depth < 100000) scores.push(3);
  else if (depth < 250000) scores.push(4);
  else scores.push(5);

  // BTC
  if (btc === "COUNTER") scores.push(1);
  else if (btc === "NEUTRAL") scores.push(3);
  else if (btc === "WITH") scores.push(5);
  else scores.push(3);

  // Funding
  if (funding === "CROWDED") scores.push(1);
  else if (funding === "EDGE_WEAK") scores.push(2);
  else if (funding === "NEUTRAL") scores.push(3);
  else if (funding === "OK") scores.push(4);
  else if (funding === "OPTIMAL") scores.push(5);
  else scores.push(3);

  return Math.max(1, Math.min(5, Math.round(avg(scores))));
}

function isTimedRow(row) {
  const stage = normalizeText(row.stage || row.scannerStage);
  const flow = normalizeFlow(row.flow || row.scannerFlow);
  const rsiZone = normalizeText(row.rsiZone);
  const side = normalizeSide(row.side);
  const tfAlignment = normalizeText(row.tfAlignment);
  const tfStrength = safeNumber(row.tfStrength, Math.abs(safeNumber(row.tfScore, 0)));

  const stageOk = stage === "ENTRY" || stage === "ALMOST";
  const flowOk = RUNNER_FLOWS.has(flow);

  let rsiOk = true;

  if (side === "LONG") {
    rsiOk =
      rsiZone === "MID" ||
      rsiZone.includes("LOWER") ||
      rsiZone === "UNKNOWN";
  }

  if (side === "SHORT") {
    rsiOk =
      rsiZone === "MID" ||
      rsiZone.includes("UPPER") ||
      rsiZone === "UNKNOWN";
  }

  const tfOk =
    tfAlignment === "ALIGNED" ||
    tfAlignment === "WITH" ||
    tfStrength >= 2 ||
    tfAlignment === "UNKNOWN";

  const confirmationOk =
    row.pullbackConfirmed === true ||
    row.sweepConfirmed === true ||
    row.retestConfirmed === true ||
    row.structureAligned === true ||
    row.rsiPullbackAllowed === true ||
    row.rsiContinuationAllowed === true ||
    row.sniperScore >= 85 ||
    row.confluence >= 85;

  return stageOk && flowOk && rsiOk && tfOk && confirmationOk;
}

function timingIndexFromRow(row) {
  return isTimedRow(row) ? 2 : 1;
}

function avg(values) {
  const arr = safeArray(values).map(Number).filter(Number.isFinite);
  if (!arr.length) return 0;

  return arr.reduce((sum, n) => sum + n, 0) / arr.length;
}

// ================= FAMILY DEFINITIONS =================

function qualityLabel(index) {
  if (index === 1) return "Q1_WEAK";
  if (index === 2) return "Q2_LOW";
  if (index === 3) return "Q3_BASE";
  if (index === 4) return "Q4_STRONG";
  return "Q5_ELITE";
}

function qualityRangeLabels(index) {
  if (index === 1) {
    return ["CONF_0_50", "SNIPER_0_50", "RR_LT_1p00", "SCORE_0_50"];
  }

  if (index === 2) {
    return ["CONF_50_65", "SNIPER_50_65", "RR_1p00_1p20", "SCORE_50_65"];
  }

  if (index === 3) {
    return ["CONF_65_75", "SNIPER_65_75", "RR_1p20_1p50", "SCORE_65_75"];
  }

  if (index === 4) {
    return ["CONF_75_85", "SNIPER_75_85", "RR_1p50_2p00", "SCORE_75_85"];
  }

  return ["CONF_85_100", "SNIPER_85_100", "RR_2p00_PLUS", "SCORE_85_100"];
}

function marketLabel(index) {
  if (index === 1) return "M1_DIRTY";
  if (index === 2) return "M2_WEAK";
  if (index === 3) return "M3_NORMAL";
  if (index === 4) return "M4_CLEAN";
  return "M5_PREMIUM";
}

function marketRangeLabels(index) {
  if (index === 1) {
    return [
      "OB_REL_AGAINST",
      "SPREAD_GT_25BPS",
      "DEPTH_LT_10K",
      "BTC_REL_COUNTER",
      "FUNDING_CROWDED",
    ];
  }

  if (index === 2) {
    return [
      "OB_REL_AGAINST_OR_NEUTRAL",
      "SPREAD_16_25BPS",
      "DEPTH_10K_50K",
      "BTC_REL_COUNTER",
      "FUNDING_EDGE_WEAK",
    ];
  }

  if (index === 3) {
    return [
      "OB_REL_NEUTRAL",
      "SPREAD_8_16BPS",
      "DEPTH_50K_100K",
      "BTC_REL_NEUTRAL",
      "FUNDING_NEUTRAL",
    ];
  }

  if (index === 4) {
    return [
      "OB_REL_WITH_OR_NEUTRAL",
      "SPREAD_5_12BPS",
      "DEPTH_100K_250K",
      "BTC_REL_WITH_OR_NEUTRAL",
      "FUNDING_OK",
    ];
  }

  return [
    "OB_REL_WITH",
    "SPREAD_LT_8BPS",
    "DEPTH_GT_250K",
    "BTC_REL_WITH",
    "FUNDING_OPTIMAL",
  ];
}

function timingLabel(index) {
  return index === 2 ? "T2_TIMED" : "T1_EARLY_OR_NOISY";
}

function timingRangeLabels(index, side) {
  if (index === 2) {
    return [
      "STAGE_ENTRY_OR_ALMOST",
      "FLOW_TREND_OR_BUILDING",
      side === "SHORT" ? "RSI_UPPER_OR_MID" : "RSI_LOWER_OR_MID",
      "TF_ALIGNED",
      "PULLBACK_OR_CONFIRMATION_OK",
    ];
  }

  return [
    "STAGE_ANY",
    "FLOW_ANY",
    "RSI_ANY",
    "TF_ANY",
    "PULLBACK_NOT_REQUIRED",
  ];
}

function buildFamilyDefinition(side, qualityIndex, marketIndex, timingIndex) {
  const familyNumber =
    (qualityIndex - 1) * 10 +
    (marketIndex - 1) * 2 +
    timingIndex;

  const labels = [
    qualityLabel(qualityIndex),
    marketLabel(marketIndex),
    timingLabel(timingIndex),
    ...qualityRangeLabels(qualityIndex),
    ...timingRangeLabels(timingIndex, side),
    ...marketRangeLabels(marketIndex),
  ];

  return {
    familyId: `${side}_${familyNumber}`,
    side,
    quality: qualityLabel(qualityIndex),
    market: marketLabel(marketIndex),
    timing: timingLabel(timingIndex),
    qualityIndex,
    marketIndex,
    timingIndex,
    definition: labels.join(" | "),
    labels,
  };
}

export function buildRunnerFamilyDefinitions() {
  const long = [];
  const short = [];

  for (const side of ["LONG", "SHORT"]) {
    for (let q = 1; q <= 5; q++) {
      for (let m = 1; m <= 5; m++) {
        for (let t = 1; t <= 2; t++) {
          const def = buildFamilyDefinition(side, q, m, t);
          if (side === "LONG") long.push(def);
          else short.push(def);
        }
      }
    }
  }

  return {
    long,
    short,
    all: [...long, ...short],
  };
}

export function getRunnerFamilyForRow(row) {
  const side = normalizeSide(row?.side || row?.direction || row?.tradeSide);
  if (!side) return null;

  const qualityIndex = qualityIndexFromRow(row);
  const marketIndex = marketIndexFromRow(row);
  const timingIndex = timingIndexFromRow(row);

  return buildFamilyDefinition(side, qualityIndex, marketIndex, timingIndex);
}

// ================= ROW NORMALIZATION =================

export function normalizeRunnerAnalyzeRow(raw) {
  if (!raw || typeof raw !== "object") return null;

  const snapshot = {
    ...safeObject(raw.filterSnapshot),
    ...safeObject(raw.filters),
    ...safeObject(raw.analysisFilters),
  };

  const merged = {
    ...snapshot,
    ...raw,
  };

  const symbol = normalizeSymbol(merged.symbol);
  const side = normalizeSide(merged.side || merged.direction || merged.tradeSide);

  if (!symbol || !side) return null;

  const resultR = getResultR(merged);
  const pnlPct = getPnlPct(merged);
  const closed = hasClosedSignal(merged);

  const family =
    merged.familyId || merged.runnerFamilyId || merged.analyzeFamilyId
      ? {
          familyId: String(
            merged.familyId ||
              merged.runnerFamilyId ||
              merged.analyzeFamilyId
          ).toUpperCase(),
        }
      : getRunnerFamilyForRow(merged);

  if (!family?.familyId) return null;

  const entry = getFirstNumber(merged.entry, merged.entryPrice, merged.openPrice);
  const sl = getFirstNumber(merged.sl, merged.initialSl, merged.stopLoss);
  const tp = getFirstNumber(merged.tp, merged.takeProfit);

  const row = {
    ...merged,

    profile: "RUNNER",
    tradeId: getTradeId(merged),

    symbol,
    side,

    familyId: family.familyId,
    runnerFamilyId: family.familyId,
    analyzeFamilyId: family.familyId,
    analysisFamilyId: family.familyId,

    quality: family.quality,
    market: family.market,
    timing: family.timing,
    qualityIndex: family.qualityIndex,
    marketIndex: family.marketIndex,
    timingIndex: family.timingIndex,
    definition: family.definition,
    labels: family.labels,

    action: normalizeText(merged.action || merged.analyzeLifecycle || "ENTRY"),
    entryType: merged.entryType || merged.runnerEntryType || null,
    runnerEntryType: merged.runnerEntryType || merged.entryType || null,
    setupClass: merged.setupClass || null,

    entry,
    sl,
    initialSl: getFirstNumber(merged.initialSl, merged.sl, merged.stopLoss),
    tp,

    rr: getFirstNumber(merged.rr, merged.baseRR, merged.finalRR, merged.plannedRR),
    plannedRR: getFirstNumber(merged.plannedRR, merged.rr, merged.finalRR, merged.targetR),
    targetR: getFirstNumber(merged.targetR, merged.plannedRR, merged.rr),

    closed,
    closedAt: closed
      ? normalizeTimestamp(
          merged.closedAt ||
            merged.exitedAt ||
            merged.exitAt ||
            merged.exitTs ||
            merged.updatedAt ||
            merged.ts,
          Date.now()
        )
      : null,

    resultR,
    realizedR: resultR,
    exitR: resultR,
    pnlR: resultR,
    outcomeR: resultR,

    pnlPct,

    exitReason: getExitReason(merged),

    confluence: safeNumber(merged.confluence, 0),
    sniperScore: safeNumber(merged.sniperScore ?? merged.sniper, 0),
    score: safeNumber(merged.score ?? merged.moveScore ?? merged.tradeScore, 0),
    moveScore: safeNumber(merged.moveScore ?? merged.score ?? merged.tradeScore, 0),

    flow: normalizeFlow(merged.flow || merged.scannerFlow),
    scannerFlow: normalizeFlow(merged.scannerFlow || merged.flow),

    rsi: getFirstNumber(merged.rsi),
    rsiZone: normalizeText(merged.rsiZone || "UNKNOWN"),

    obBias: normalizeText(merged.obBias || "UNKNOWN"),
    spreadPct: getFirstNumber(merged.spreadPct),
    spreadBps: normalizeSpreadBps(merged),
    depthMinUsd1p: getDepth(merged),

    funding: getFirstNumber(merged.funding, merged.fundingRate),
    fundingRate: getFirstNumber(merged.fundingRate, merged.funding),

    btcState: normalizeText(merged.btcState || merged.btc?.state || "UNKNOWN"),
    regime: normalizeText(merged.regime || "UNKNOWN"),

    tfScore: safeNumber(merged.tfScore, 0),
    tfStrength: safeNumber(merged.tfStrength, Math.abs(safeNumber(merged.tfScore, 0))),
    tfAlignment: normalizeText(merged.tfAlignment || "UNKNOWN"),

    currentR: getFirstNumber(merged.currentR),
    mfeR: safeNumber(merged.mfeR, 0),
    maeR: safeNumber(merged.maeR, 0),

    ts: normalizeTimestamp(
      merged.analyzeTs ||
        merged.ts ||
        merged.timestamp ||
        merged.createdAt ||
        merged.openedAt ||
        merged.entryTs,
      Date.now()
    ),
  };

  return row;
}

export function normalizeRunnerAnalyzeRows(rows) {
  return dedupeRows(rows)
    .map(normalizeRunnerAnalyzeRow)
    .filter(Boolean);
}

// ================= STATS =================

function emptyFamilyStats(def) {
  return {
    ...def,

    observed: 0,
    trades: 0,
    closed: 0,
    open: 0,
    pending: 0,

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

    avgMfeR: 0,
    avgMaeR: 0,

    status: "EMPTY",
    score: 0,

    examples: [],
  };
}

function classifyFamilyStatus(stats, options = {}) {
  const minClosed = safeNumber(options.minClosed, 10);

  if (stats.observed <= 0) return "EMPTY";
  if (stats.closed < minClosed) return "COLLECTING";

  const totalR = safeNumber(stats.totalR, 0);
  const totalPnlPct = safeNumber(stats.totalPnlPct, 0);
  const avgR = safeNumber(stats.avgR, 0);
  const pf = safeNumber(stats.profitFactor, 0);
  const winrate = safeNumber(stats.winrateNum, 0);

  // Runner PnL-first.
  if (
    stats.closed >= minClosed * 3 &&
    totalR > 0 &&
    totalPnlPct > 0 &&
    avgR >= 0.18 &&
    pf >= 1.35 &&
    winrate >= 0.30
  ) {
    return "HOT";
  }

  if (
    stats.closed >= minClosed &&
    totalR > 0 &&
    totalPnlPct > 0 &&
    avgR >= 0.10 &&
    pf >= 1.15 &&
    winrate >= 0.25
  ) {
    return "GOOD";
  }

  if (
    stats.closed >= minClosed &&
    totalR > 0 &&
    avgR > 0 &&
    pf >= 1.0 &&
    winrate >= 0.20
  ) {
    return "STABLE";
  }

  return "BAD";
}

function calculateFamilyScore(stats) {
  const totalPnlPct = safeNumber(stats.totalPnlPct, 0);
  const totalR = safeNumber(stats.totalR, 0);
  const avgR = safeNumber(stats.avgR, 0);
  const pf = safeNumber(stats.profitFactor, 0);
  const winrate = safeNumber(stats.winrateNum, 0);
  const closed = safeNumber(stats.closed, 0);
  const avgMaeR = safeNumber(stats.avgMaeR, 0);

  return round(
    totalPnlPct * 4 +
      totalR * 3 +
      avgR * 25 +
      Math.min(pf, 10) * 4 +
      winrate * 15 +
      Math.log10(closed + 1) * 4 +
      avgMaeR,
    3
  );
}

function compactExample(row) {
  return {
    tradeId: row.tradeId,
    symbol: row.symbol,
    side: row.side,
    closed: Boolean(row.closed),
    resultR: row.resultR,
    pnlPct: row.pnlPct,
    exitReason: row.exitReason,
    entryType: row.entryType || row.runnerEntryType,
    setupClass: row.setupClass,
    ts: row.ts,
  };
}

function buildFamilyStats(def, rows, options = {}) {
  const breakevenREps = safeNumber(options.breakevenREps, BREAKEVEN_R_EPS_DEFAULT);
  const maxExamples = safeNumber(options.maxExamplesPerFamily, MAX_EXAMPLES_DEFAULT);

  const familyRows = rows.filter(row => row.familyId === def.familyId);
  const closedRows = familyRows.filter(row => row.closed && row.resultR !== null);

  const wins = closedRows.filter(row => safeNumber(row.resultR, 0) > breakevenREps).length;
  const losses = closedRows.filter(row => safeNumber(row.resultR, 0) < -breakevenREps).length;
  const breakeven = closedRows.length - wins - losses;

  const rValues = closedRows.map(row => safeNumber(row.resultR, 0));
  const pnlValues = closedRows.map(row => safeNumber(row.pnlPct, 0));

  const grossWinR = rValues.filter(r => r > 0).reduce((sum, r) => sum + r, 0);
  const grossLossRAbs = Math.abs(rValues.filter(r => r < 0).reduce((sum, r) => sum + r, 0));

  const totalR = rValues.reduce((sum, r) => sum + r, 0);
  const totalPnlPct = pnlValues.reduce((sum, p) => sum + p, 0);

  const completedForWinrate = wins + losses;
  const winrateNum = completedForWinrate ? wins / completedForWinrate : 0;

  const out = {
    ...emptyFamilyStats(def),

    observed: familyRows.length,
    trades: familyRows.length,
    closed: closedRows.length,
    open: familyRows.filter(row => !row.closed).length,
    pending: familyRows.filter(row => !row.closed || row.resultR === null).length,

    wins,
    losses,
    breakeven,

    winrate: pct(winrateNum),
    winrateNum: round(winrateNum, 4),

    totalR: round(totalR, 3),
    avgR: closedRows.length ? round(totalR / closedRows.length, 3) : 0,

    totalPnlPct: round(totalPnlPct, 3),
    avgPnlPct: closedRows.length ? round(totalPnlPct / closedRows.length, 3) : 0,

    grossWinR: round(grossWinR, 3),
    grossLossR: round(grossLossRAbs, 3),
    profitFactor: grossLossRAbs > 0
      ? round(grossWinR / grossLossRAbs, 3)
      : grossWinR > 0
        ? 999
        : 0,
    pf: grossLossRAbs > 0
      ? round(grossWinR / grossLossRAbs, 3)
      : grossWinR > 0
        ? 999
        : 0,

    avgMfeR: closedRows.length ? round(avg(closedRows.map(row => row.mfeR)), 3) : 0,
    avgMaeR: closedRows.length ? round(avg(closedRows.map(row => row.maeR)), 3) : 0,

    examples: closedRows
      .slice(-maxExamples)
      .map(compactExample),
  };

  out.status = classifyFamilyStatus(out, options);
  out.score = calculateFamilyScore(out);

  return out;
}

function summarizeFamilies(families) {
  const rows = safeArray(families);

  const out = {
    count: rows.length,
    total: rows.length,
    HOT: 0,
    GOOD: 0,
    STABLE: 0,
    BAD: 0,
    COLLECTING: 0,
    EMPTY: 0,
  };

  for (const row of rows) {
    const status = row.status || "EMPTY";
    out[status] = safeNumber(out[status], 0) + 1;
  }

  out.text = `HOT ${out.HOT} | GOOD ${out.GOOD} | STABLE ${out.STABLE} | BAD ${out.BAD} | COLLECTING ${out.COLLECTING} | EMPTY ${out.EMPTY}`;

  return out;
}

function sortByPnl(a, b) {
  const pnlDiff = safeNumber(b.totalPnlPct, 0) - safeNumber(a.totalPnlPct, 0);
  if (pnlDiff !== 0) return pnlDiff;

  const rDiff = safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0);
  if (rDiff !== 0) return rDiff;

  const avgRDiff = safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0);
  if (avgRDiff !== 0) return avgRDiff;

  const pfDiff = safeNumber(b.profitFactor, 0) - safeNumber(a.profitFactor, 0);
  if (pfDiff !== 0) return pfDiff;

  return safeNumber(b.closed, 0) - safeNumber(a.closed, 0);
}

function sortByTotalR(a, b) {
  const rDiff = safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0);
  if (rDiff !== 0) return rDiff;

  return sortByPnl(a, b);
}

function sortByWinrate(a, b) {
  const wrDiff = safeNumber(b.winrateNum, 0) - safeNumber(a.winrateNum, 0);
  if (wrDiff !== 0) return wrDiff;

  return sortByPnl(a, b);
}

function isWinnerFamily(row, options = {}) {
  const minClosed = safeNumber(options.minClosed, 10);

  return (
    row.closed >= minClosed &&
    ["HOT", "GOOD", "STABLE"].includes(row.status) &&
    safeNumber(row.totalR, 0) > 0 &&
    safeNumber(row.avgR, 0) > 0 &&
    safeNumber(row.totalPnlPct, 0) > 0
  );
}

export function buildRunnerFamilyAnalysis(rawRows, options = {}) {
  const minClosed = safeNumber(options.minClosed, 10);
  const breakevenREps = safeNumber(options.breakevenREps, BREAKEVEN_R_EPS_DEFAULT);
  const maxExamplesPerFamily = safeNumber(options.maxExamplesPerFamily, MAX_EXAMPLES_DEFAULT);

  const rows = normalizeRunnerAnalyzeRows(rawRows);

  const defs = buildRunnerFamilyDefinitions();

  const longFamilies = defs.long.map(def =>
    buildFamilyStats(def, rows, {
      minClosed,
      breakevenREps,
      maxExamplesPerFamily,
    })
  );

  const shortFamilies = defs.short.map(def =>
    buildFamilyStats(def, rows, {
      minClosed,
      breakevenREps,
      maxExamplesPerFamily,
    })
  );

  const allFamilies = [...longFamilies, ...shortFamilies];

  const closedRows = rows.filter(row => row.closed && row.resultR !== null);
  const wins = closedRows.filter(row => safeNumber(row.resultR, 0) > breakevenREps).length;
  const losses = closedRows.filter(row => safeNumber(row.resultR, 0) < -breakevenREps).length;
  const breakeven = closedRows.length - wins - losses;

  const totalR = closedRows.reduce((sum, row) => sum + safeNumber(row.resultR, 0), 0);
  const totalPnlPct = closedRows.reduce((sum, row) => sum + safeNumber(row.pnlPct, 0), 0);

  const completedForWinrate = wins + losses;
  const winrateNum = completedForWinrate ? wins / completedForWinrate : 0;

  const familiesWithData = allFamilies.filter(row => row.observed > 0);
  const rankedWithData = familiesWithData.slice().sort(sortByPnl);
  const winnerFamilies = allFamilies.filter(row => isWinnerFamily(row, { minClosed })).sort(sortByPnl);

  const topPnlFamilies = rankedWithData.slice(0, 30);
  const topTotalRFamilies = familiesWithData.slice().sort(sortByTotalR).slice(0, 30);
  const topWinrateFamilies = familiesWithData
    .filter(row => row.closed >= Math.max(3, Math.floor(minClosed / 2)))
    .sort(sortByWinrate)
    .slice(0, 30);

  const bestLongByPnl = longFamilies.filter(row => row.observed > 0).sort(sortByPnl)[0] || null;
  const bestShortByPnl = shortFamilies.filter(row => row.observed > 0).sort(sortByPnl)[0] || null;

  return {
    rows,
    stats: {
      actions: rows.length,
      trades: rows.length,
      open: rows.filter(row => !row.closed).length,
      closed: closedRows.length,
      pendingOutcome: rows.filter(row => !row.closed || row.resultR === null).length,

      wins,
      losses,
      breakeven,

      winrateNum: round(winrateNum, 4),
      winrate: pct(winrateNum),

      totalR: round(totalR, 3),
      avgR: closedRows.length ? round(totalR / closedRows.length, 3) : 0,

      totalPnlPct: round(totalPnlPct, 3),
      avgPnlPct: closedRows.length ? round(totalPnlPct / closedRows.length, 3) : 0,

      longFamilies: summarizeFamilies(longFamilies),
      shortFamilies: summarizeFamilies(shortFamilies),
      familiesWithData: familiesWithData.length,
    },

    familyPerformanceMatrix: {
      long: {
        total: FAMILY_COUNT_PER_SIDE,
        summary: summarizeFamilies(longFamilies),
        families: longFamilies,
      },
      short: {
        total: FAMILY_COUNT_PER_SIDE,
        summary: summarizeFamilies(shortFamilies),
        families: shortFamilies,
      },
    },

    best: {
      bestLongByPnl,
      bestShortByPnl,
      topPnlFamily: rankedWithData[0] || null,
      topTotalRFamily: topTotalRFamilies[0] || null,
      topWinrateFamily: topWinrateFamilies[0] || null,
    },

    winnerCandidates: rankedWithData
      .filter(row => row.closed >= minClosed)
      .slice(0, 20),

    winnerCandidateSummary: {
      count: rankedWithData.filter(row => row.closed >= minClosed).length,
      objective: "highest_total_pnl_pct_then_total_r",
      message: "Runner candidates gerankt op Total PnL% en daarna Total R. Winrate is sanity filter, niet primaire objective.",
    },

    winnerFamilies: winnerFamilies.slice(0, 20),

    winnerFamilySummary: {
      count: winnerFamilies.length,
      rule: "HOT/GOOD/STABLE families met voldoende closed trades, positieve Avg R, positieve Total R en positieve Total PnL%.",
    },

    leaderboards: {
      topPnlFamilies,
      topTotalRFamilies,
      topWinrateFamilies,
    },
  };
}

export default {
  buildRunnerFamilyDefinitions,
  getRunnerFamilyForRow,
  normalizeRunnerAnalyzeRow,
  normalizeRunnerAnalyzeRows,
  buildRunnerFamilyAnalysis,
};