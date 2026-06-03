// ================= RUNNER FAMILY ENGINE =================
// Doel:
// - 50 LONG + 50 SHORT macro families blijven bestaan.
// - Macro family = Q/M/T matrix.
// - Micro family = macro family + exacte row-level filter buckets.
// - Discord/live hoort op microFamilyKey te filteren, niet alleen op familyId.

const FAMILY_COUNT_PER_SIDE = 50;
const BREAKEVEN_R_EPS_DEFAULT = 0.05;
const MAX_EXAMPLES_DEFAULT = 8;

const RUNNER_FLOWS = new Set([
  "SQUEEZE",
  "RUNNING",
  "BREAKOUT",
  "BUILDING",
  "TREND"
]);

// ================= GENERIC HELPERS =================

function hasValue(value) {
  return value !== undefined && value !== null && value !== "";
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
  if (!hasValue(value)) return fallback;
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

function sanitizeLabel(value) {
  return normalizeText(value)
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "UNKNOWN";
}

function labelFromText(prefix, value) {
  return `${prefix}_${sanitizeLabel(value || "UNKNOWN")}`;
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
    if (!hasValue(value)) continue;

    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }

  return null;
}

function avg(values) {
  const arr = safeArray(values).map(Number).filter(Number.isFinite);
  if (!arr.length) return 0;

  return arr.reduce((sum, n) => sum + n, 0) / arr.length;
}

function stableHash(value) {
  const text = String(value || "");
  let hash = 5381;

  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash) + text.charCodeAt(i);
    hash |= 0;
  }

  return Math.abs(hash).toString(36).toUpperCase();
}

// ================= TRADE ID / OUTCOME =================

function getTradeId(row) {
  const direct =
    row?.tradeId ||
    row?.positionTradeId ||
    row?.sourceTradeId ||
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

  if (symbol && side && entry !== null && ts > 0) {
    return `RUNNER_${symbol}_${side}_${ts}_${Number(entry).toPrecision(12)}`;
  }

  if (symbol && side && entry !== null) {
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
  const action = normalizeText(row?.action || row?.analyzeLifecycle);

  if (action === "EXIT" || action === "CLOSED" || action === "CLOSE") return true;
  if (row?.closed === true || row?.isClosed === true) return true;
  if (row?.closedAt || row?.exitedAt || row?.exitAt || row?.exitTs) return true;

  if (action === "ENTRY") return false;

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

  return reason || "UNKNOWN";
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

  score += Math.min(
    normalizeTimestamp(row?.updatedAt || row?.closedAt || row?.ts, 0) / 1e15,
    1
  );

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
      normalizeTimestamp(row?.openedAt || row?.entryTs || row?.createdAt || row?.ts, 0)
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

function bucketIndex(value, thresholds) {
  const n = safeNumber(value, 0);

  if (n < thresholds[0]) return 1;
  if (n < thresholds[1]) return 2;
  if (n < thresholds[2]) return 3;
  if (n < thresholds[3]) return 4;

  return 5;
}

function confBucketLabel(row) {
  const n = safeNumber(row.confluence, 0);

  if (n < 50) return "CONF_0_50";
  if (n < 65) return "CONF_50_65";
  if (n < 75) return "CONF_65_75";
  if (n < 85) return "CONF_75_85";
  return "CONF_85_100";
}

function sniperBucketLabel(row) {
  const n = safeNumber(row.sniperScore ?? row.sniper, 0);

  if (n < 50) return "SNIPER_0_50";
  if (n < 65) return "SNIPER_50_65";
  if (n < 75) return "SNIPER_65_75";
  if (n < 85) return "SNIPER_75_85";
  return "SNIPER_85_100";
}

function rrBucketLabel(row) {
  const rr = safeNumber(row.plannedRR ?? row.rr ?? row.targetR, 0);

  if (rr < 1) return "RR_LT_1p00";
  if (rr < 1.2) return "RR_1p00_1p20";
  if (rr < 1.5) return "RR_1p20_1p50";
  if (rr < 2) return "RR_1p50_2p00";
  return "RR_2p00_PLUS";
}

function scoreBucketLabel(row) {
  const n = safeNumber(row.score ?? row.moveScore, 0);

  if (n < 50) return "SCORE_0_50";
  if (n < 65) return "SCORE_50_65";
  if (n < 75) return "SCORE_65_75";
  if (n < 85) return "SCORE_75_85";
  return "SCORE_85_100";
}

function qualityIndexFromRow(row) {
  const conf = safeNumber(row.confluence, 0);
  const sniper = safeNumber(row.sniperScore ?? row.sniper, 0);
  const rr = safeNumber(row.plannedRR ?? row.rr ?? row.targetR, 0);
  const score = safeNumber(row.score ?? row.moveScore, 0);

  const parts = [
    bucketIndex(conf, [50, 65, 75, 85]),
    bucketIndex(sniper, [50, 65, 75, 85]),
    rr < 1 ? 1 : rr < 1.2 ? 2 : rr < 1.5 ? 3 : rr < 2 ? 4 : 5,
    bucketIndex(score, [50, 65, 75, 85])
  ];

  return Math.max(1, Math.min(5, Math.floor(avg(parts))));
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

function obRelLabel(row) {
  return `OB_REL_${getDirectionalObState(row)}`;
}

function normalizeSpreadBps(row) {
  const spreadBps = getFirstNumber(row?.spreadBps);
  if (spreadBps !== null) return spreadBps;

  const spreadPct = getFirstNumber(row?.spreadPct);
  if (spreadPct === null) return 999;

  if (spreadPct <= 0.05) return spreadPct * 10000;

  return spreadPct * 100;
}

function spreadBucketLabel(row) {
  const bps = normalizeSpreadBps(row);

  if (bps > 25) return "SPREAD_GT_25BPS";
  if (bps > 16) return "SPREAD_16_25BPS";
  if (bps > 8) return "SPREAD_8_16BPS";
  if (bps > 5) return "SPREAD_5_8BPS";
  return "SPREAD_LT_5BPS";
}

function getDepth(row) {
  return safeNumber(row.depthMinUsd1p ?? row.depthUsd1p, 0);
}

function depthBucketLabel(row) {
  const depth = getDepth(row);

  if (depth <= 0) return "DEPTH_UNKNOWN";
  if (depth < 10000) return "DEPTH_LT_10K";
  if (depth < 50000) return "DEPTH_10K_50K";
  if (depth < 100000) return "DEPTH_50K_100K";
  if (depth < 250000) return "DEPTH_100K_250K";
  return "DEPTH_GT_250K";
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

function btcRelLabel(row) {
  return `BTC_REL_${getDirectionalBtcState(row)}`;
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

function fundingLabel(row) {
  return `FUNDING_${getFundingState(row)}`;
}

function marketIndexFromRow(row) {
  const ob = getDirectionalObState(row);
  const spreadBps = normalizeSpreadBps(row);
  const depth = getDepth(row);
  const btc = getDirectionalBtcState(row);
  const funding = getFundingState(row);

  const scores = [];

  if (ob === "AGAINST") scores.push(1);
  else if (ob === "NEUTRAL") scores.push(3);
  else if (ob === "WITH") scores.push(5);
  else scores.push(3);

  if (spreadBps > 25) scores.push(1);
  else if (spreadBps > 16) scores.push(2);
  else if (spreadBps > 8) scores.push(3);
  else if (spreadBps > 5) scores.push(4);
  else scores.push(5);

  if (depth > 0 && depth < 10000) scores.push(1);
  else if (depth < 50000) scores.push(2);
  else if (depth < 100000) scores.push(3);
  else if (depth < 250000) scores.push(4);
  else scores.push(5);

  if (btc === "COUNTER") scores.push(1);
  else if (btc === "NEUTRAL") scores.push(3);
  else if (btc === "WITH") scores.push(5);
  else scores.push(3);

  if (funding === "CROWDED") scores.push(1);
  else if (funding === "EDGE_WEAK") scores.push(2);
  else if (funding === "NEUTRAL") scores.push(3);
  else if (funding === "OK") scores.push(4);
  else if (funding === "OPTIMAL") scores.push(5);
  else scores.push(3);

  return Math.max(1, Math.min(5, Math.round(avg(scores))));
}

function stageGroupLabel(row) {
  const stage = normalizeText(row.stage || row.scannerStage);

  if (stage === "ENTRY" || stage === "ALMOST") return "STAGE_ENTRY_OR_ALMOST";
  if (stage === "BUILDUP" || stage === "BUILD") return "STAGE_BUILDUP";
  if (stage === "RADAR" || stage === "WATCH") return "STAGE_RADAR_OR_WATCH";

  return "STAGE_OTHER";
}

function stageExactLabel(row) {
  return labelFromText("STAGE_EXACT", row.stage || row.scannerStage || "UNKNOWN");
}

function flowGroupLabel(row) {
  const flow = normalizeFlow(row.flow || row.scannerFlow);

  if (RUNNER_FLOWS.has(flow)) return "FLOW_TREND_OR_BUILDING";
  return "FLOW_OTHER";
}

function flowExactLabel(row) {
  return labelFromText("FLOW_EXACT", row.flow || row.scannerFlow || "UNKNOWN");
}

function rsiSideGroupLabel(row) {
  const side = normalizeSide(row.side);
  const rsiZone = normalizeText(row.rsiZone);

  if (side === "LONG") {
    if (rsiZone === "MID" || rsiZone.includes("LOWER") || rsiZone === "UNKNOWN") {
      return "RSI_LOWER_OR_MID";
    }

    return "RSI_UPPER_COUNTER";
  }

  if (side === "SHORT") {
    if (rsiZone === "MID" || rsiZone.includes("UPPER") || rsiZone === "UNKNOWN") {
      return "RSI_UPPER_OR_MID";
    }

    return "RSI_LOWER_COUNTER";
  }

  return "RSI_UNKNOWN";
}

function rsiExactLabel(row) {
  return labelFromText("RSI_EXACT", row.rsiZone || "UNKNOWN");
}

function tfGroupLabel(row) {
  const tfAlignment = normalizeText(row.tfAlignment);
  const tfStrength = safeNumber(row.tfStrength, Math.abs(safeNumber(row.tfScore, 0)));

  if (tfAlignment === "ALIGNED" || tfAlignment === "WITH" || tfStrength >= 2) {
    return "TF_ALIGNED";
  }

  if (tfAlignment === "COUNTER" || tfAlignment === "AGAINST") {
    return "TF_COUNTER";
  }

  if (tfAlignment === "UNKNOWN") {
    return "TF_UNKNOWN";
  }

  return "TF_WEAK";
}

function tfExactLabel(row) {
  return labelFromText("TF_EXACT", row.tfAlignment || "UNKNOWN");
}

function tfStrengthLabel(row) {
  const n = Math.abs(safeNumber(row.tfStrength, Math.abs(safeNumber(row.tfScore, 0))));

  if (n < 1) return "TF_STRENGTH_LT_1";
  if (n < 2) return "TF_STRENGTH_1_2";
  if (n < 4) return "TF_STRENGTH_2_4";
  return "TF_STRENGTH_4_PLUS";
}

function confirmationOk(row) {
  return (
    row.pullbackConfirmed === true ||
    row.sweepConfirmed === true ||
    row.retestConfirmed === true ||
    row.structureAligned === true ||
    row.rsiPullbackAllowed === true ||
    row.rsiContinuationAllowed === true ||
    safeNumber(row.sniperScore ?? row.sniper, 0) >= 85 ||
    safeNumber(row.confluence, 0) >= 85
  );
}

function confirmationGroupLabel(row) {
  return confirmationOk(row)
    ? "PULLBACK_OR_CONFIRMATION_OK"
    : "PULLBACK_OR_CONFIRMATION_MISSING";
}

function confirmationFlagLabels(row) {
  return [
    row.pullbackConfirmed === true ? "PULLBACK_ON" : "PULLBACK_OFF",
    row.sweepConfirmed === true ? "SWEEP_ON" : "SWEEP_OFF",
    row.retestConfirmed === true ? "RETEST_ON" : "RETEST_OFF",
    row.structureAligned === true ? "STRUCTURE_ALIGNED" : "STRUCTURE_NOT_ALIGNED",
    row.rsiPullbackAllowed === true ? "RSI_PULLBACK_ALLOWED" : "RSI_PULLBACK_BLOCKED",
    row.rsiContinuationAllowed === true ? "RSI_CONTINUATION_ALLOWED" : "RSI_CONTINUATION_BLOCKED"
  ];
}

function regimeLabel(row) {
  return labelFromText("REGIME", row.regime || "UNKNOWN");
}

function volatilityLabel(row) {
  return labelFromText("VOLATILITY", row.volatility || "UNKNOWN");
}

function setupClassLabel(row) {
  return labelFromText("SETUP", row.setupClass || "UNKNOWN");
}

function entryTypeLabel(row) {
  return labelFromText("ENTRY_TYPE", row.entryType || row.runnerEntryType || "UNKNOWN");
}

function isTimedRow(row) {
  const stageOk = stageGroupLabel(row) === "STAGE_ENTRY_OR_ALMOST";
  const flowOk = flowGroupLabel(row) === "FLOW_TREND_OR_BUILDING";

  const rsiLabel = rsiSideGroupLabel(row);
  const rsiOk =
    rsiLabel === "RSI_LOWER_OR_MID" ||
    rsiLabel === "RSI_UPPER_OR_MID" ||
    rsiLabel === "RSI_UNKNOWN";

  const tfOk = tfGroupLabel(row) === "TF_ALIGNED" || tfGroupLabel(row) === "TF_UNKNOWN";

  return stageOk && flowOk && rsiOk && tfOk && confirmationOk(row);
}

function timingIndexFromRow(row) {
  return isTimedRow(row) ? 2 : 1;
}

// ================= MACRO FAMILY DEFINITIONS =================

function qualityLabel(index) {
  if (index === 1) return "Q1_WEAK";
  if (index === 2) return "Q2_LOW";
  if (index === 3) return "Q3_BASE";
  if (index === 4) return "Q4_STRONG";
  return "Q5_ELITE";
}

function marketLabel(index) {
  if (index === 1) return "M1_DIRTY";
  if (index === 2) return "M2_WEAK";
  if (index === 3) return "M3_NORMAL";
  if (index === 4) return "M4_CLEAN";
  return "M5_PREMIUM";
}

function timingLabel(index) {
  return index === 2 ? "T2_TIMED" : "T1_EARLY_OR_NOISY";
}

function buildFamilyDefinition(side, qualityIndex, marketIndex, timingIndex) {
  const familyNumber =
    (qualityIndex - 1) * 10 +
    (marketIndex - 1) * 2 +
    timingIndex;

  const labels = [
    qualityLabel(qualityIndex),
    marketLabel(marketIndex),
    timingLabel(timingIndex)
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
    labels
  };
}

export function buildRunnerFamilyDefinitions() {
  const long = [];
  const short = [];

  for (const side of ["LONG", "SHORT"]) {
    for (let q = 1; q <= 5; q += 1) {
      for (let m = 1; m <= 5; m += 1) {
        for (let t = 1; t <= 2; t += 1) {
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
    all: [...long, ...short]
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

// ================= MICRO FAMILY DEFINITIONS =================

export function buildRunnerMicroLabels(row, familyArg = null) {
  const family = familyArg || getRunnerFamilyForRow(row);
  if (!family?.familyId) return [];

  return [
    family.quality,
    family.market,
    family.timing,

    confBucketLabel(row),
    sniperBucketLabel(row),
    rrBucketLabel(row),
    scoreBucketLabel(row),

    stageGroupLabel(row),
    stageExactLabel(row),

    flowGroupLabel(row),
    flowExactLabel(row),

    rsiSideGroupLabel(row),
    rsiExactLabel(row),

    obRelLabel(row),
    spreadBucketLabel(row),
    depthBucketLabel(row),
    btcRelLabel(row),
    fundingLabel(row),

    tfGroupLabel(row),
    tfExactLabel(row),
    tfStrengthLabel(row),

    confirmationGroupLabel(row),
    ...confirmationFlagLabels(row),

    regimeLabel(row),
    volatilityLabel(row),

    setupClassLabel(row),
    entryTypeLabel(row)
  ].map(sanitizeLabel);
}

export function getRunnerMicroFamilyForRow(row, familyArg = null) {
  const family = familyArg || getRunnerFamilyForRow(row);
  if (!family?.familyId) return null;

  const microLabels = buildRunnerMicroLabels(row, family);
  const microDefinition = microLabels.join(" | ");
  const microFamilyKey = [family.familyId, ...microLabels].join("::");
  const microFamilyId = `${family.familyId}__MICRO_${stableHash(microFamilyKey)}`;

  return {
    ...family,

    microFamilyId,
    microFamilyKey,
    microDefinition,
    microLabels,

    familyDefinition: family.definition,
    familyLabels: family.labels
  };
}

// ================= ROW NORMALIZATION =================

export function normalizeRunnerAnalyzeRow(raw) {
  if (!raw || typeof raw !== "object") return null;

  const snapshot = {
    ...safeObject(raw.filterSnapshot),
    ...safeObject(raw.filters),
    ...safeObject(raw.analysisFilters)
  };

  const merged = {
    ...snapshot,
    ...raw
  };

  const symbol = normalizeSymbol(merged.symbol);
  const side = normalizeSide(merged.side || merged.direction || merged.tradeSide);

  if (!symbol || !side) return null;

  const resultR = getResultR(merged);
  const pnlPct = getPnlPct(merged);
  const closed = hasClosedSignal(merged);

  const family = getRunnerFamilyForRow({
    ...merged,
    symbol,
    side
  });

  if (!family?.familyId) return null;

  const micro = getRunnerMicroFamilyForRow(
    {
      ...merged,
      symbol,
      side
    },
    family
  );

  if (!micro?.microFamilyKey) return null;

  const entry = getFirstNumber(merged.entry, merged.entryPrice, merged.openPrice);
  const sl = getFirstNumber(merged.sl, merged.initialSl, merged.stopLoss);
  const tp = getFirstNumber(merged.tp, merged.takeProfit);

  return {
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

    microFamilyId: micro.microFamilyId,
    microFamilyKey: micro.microFamilyKey,
    runnerMicroFamilyKey: micro.microFamilyKey,
    analyzeMicroFamilyKey: micro.microFamilyKey,
    analysisMicroFamilyKey: micro.microFamilyKey,
    microDefinition: micro.microDefinition,
    microLabels: micro.microLabels,

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

    resultR: closed ? resultR : null,
    realizedR: closed ? resultR : null,
    exitR: closed ? resultR : null,
    pnlR: closed ? resultR : null,
    outcomeR: closed ? resultR : null,
    pnlPct: closed ? pnlPct : null,
    exitReason: closed ? getExitReason(merged) : "UNKNOWN",

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
    volatility: normalizeText(merged.volatility || "UNKNOWN"),

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
    )
  };
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

    examples: []
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

    familyId: row.familyId,
    microFamilyId: row.microFamilyId,
    microFamilyKey: row.microFamilyKey,

    closed: Boolean(row.closed),
    resultR: row.resultR,
    pnlPct: row.pnlPct,
    exitReason: row.exitReason,

    entryType: row.entryType || row.runnerEntryType,
    setupClass: row.setupClass,

    confluence: row.confluence,
    sniperScore: row.sniperScore,
    plannedRR: row.plannedRR,
    score: row.score,

    rsiZone: row.rsiZone,
    flow: row.flow,
    obBias: row.obBias,
    spreadBps: row.spreadBps,
    depthMinUsd1p: row.depthMinUsd1p,
    btcState: row.btcState,
    fundingRate: row.fundingRate,
    tfAlignment: row.tfAlignment,
    tfStrength: row.tfStrength,

    ts: row.ts
  };
}

function buildStatsFromRows(def, rows, options = {}) {
  const breakevenREps = safeNumber(options.breakevenREps, BREAKEVEN_R_EPS_DEFAULT);
  const maxExamples = safeNumber(options.maxExamplesPerFamily, MAX_EXAMPLES_DEFAULT);
  const minClosed = safeNumber(options.minClosed, 10);

  const closedRows = rows.filter(row => row.closed === true && row.resultR !== null);

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

    observed: rows.length,
    trades: rows.length,
    closed: closedRows.length,
    open: rows.filter(row => row.closed !== true).length,
    pending: rows.filter(row => row.closed !== true || row.resultR === null).length,

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
      .map(compactExample)
  };

  out.status = classifyFamilyStatus(out, { ...options, minClosed });
  out.score = calculateFamilyScore(out);

  return out;
}

function buildFamilyStats(def, rows, options = {}) {
  const familyRows = rows.filter(row => row.familyId === def.familyId);
  return buildStatsFromRows(def, familyRows, options);
}

function buildMicroFamilyStats(def, rows, options = {}) {
  const microRows = rows.filter(row => row.microFamilyKey === def.microFamilyKey);
  return buildStatsFromRows(def, microRows, options);
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
    EMPTY: 0
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

function buildMicroDefinitionsFromRows(rows) {
  const map = new Map();

  for (const row of rows) {
    if (!row.microFamilyKey) continue;
    if (map.has(row.microFamilyKey)) continue;

    map.set(row.microFamilyKey, {
      familyId: row.familyId,
      runnerFamilyId: row.familyId,
      analyzeFamilyId: row.familyId,
      analysisFamilyId: row.familyId,

      microFamilyId: row.microFamilyId,
      microFamilyKey: row.microFamilyKey,
      runnerMicroFamilyKey: row.microFamilyKey,
      analyzeMicroFamilyKey: row.microFamilyKey,
      analysisMicroFamilyKey: row.microFamilyKey,

      side: row.side,

      quality: row.quality,
      market: row.market,
      timing: row.timing,

      qualityIndex: row.qualityIndex,
      marketIndex: row.marketIndex,
      timingIndex: row.timingIndex,

      definition: row.definition,
      labels: row.labels,

      microDefinition: row.microDefinition,
      microLabels: row.microLabels
    });
  }

  return Array.from(map.values());
}

// ================= ANALYSIS =================

export function buildRunnerFamilyAnalysis(rawRows, options = {}) {
  const minClosed = safeNumber(options.minClosed, 10);
  const minMicroClosed = safeNumber(options.minMicroClosed, Math.max(5, Math.floor(minClosed / 2)));
  const breakevenREps = safeNumber(options.breakevenREps, BREAKEVEN_R_EPS_DEFAULT);
  const maxExamplesPerFamily = safeNumber(options.maxExamplesPerFamily, MAX_EXAMPLES_DEFAULT);

  const rows = normalizeRunnerAnalyzeRows(rawRows);
  const defs = buildRunnerFamilyDefinitions();

  const statsOptions = {
    minClosed,
    breakevenREps,
    maxExamplesPerFamily
  };

  const microStatsOptions = {
    minClosed: minMicroClosed,
    breakevenREps,
    maxExamplesPerFamily
  };

  const longFamilies = defs.long.map(def => buildFamilyStats(def, rows, statsOptions));
  const shortFamilies = defs.short.map(def => buildFamilyStats(def, rows, statsOptions));
  const allFamilies = [...longFamilies, ...shortFamilies];

  const microDefs = buildMicroDefinitionsFromRows(rows);

  const longMicroFamilies = microDefs
    .filter(def => def.side === "LONG")
    .map(def => buildMicroFamilyStats(def, rows, microStatsOptions));

  const shortMicroFamilies = microDefs
    .filter(def => def.side === "SHORT")
    .map(def => buildMicroFamilyStats(def, rows, microStatsOptions));

  const allMicroFamilies = [...longMicroFamilies, ...shortMicroFamilies];

  const closedRows = rows.filter(row => row.closed === true && row.resultR !== null);
  const wins = closedRows.filter(row => safeNumber(row.resultR, 0) > breakevenREps).length;
  const losses = closedRows.filter(row => safeNumber(row.resultR, 0) < -breakevenREps).length;
  const breakeven = closedRows.length - wins - losses;

  const totalR = closedRows.reduce((sum, row) => sum + safeNumber(row.resultR, 0), 0);
  const totalPnlPct = closedRows.reduce((sum, row) => sum + safeNumber(row.pnlPct, 0), 0);

  const completedForWinrate = wins + losses;
  const winrateNum = completedForWinrate ? wins / completedForWinrate : 0;

  const familiesWithData = allFamilies.filter(row => row.observed > 0);
  const rankedWithData = familiesWithData.slice().sort(sortByPnl);
  const winnerFamilies = allFamilies
    .filter(row => isWinnerFamily(row, { minClosed }))
    .sort(sortByPnl);

  const microWithData = allMicroFamilies.filter(row => row.observed > 0);
  const rankedMicroWithData = microWithData.slice().sort(sortByPnl);
  const winnerMicroFamilies = allMicroFamilies
    .filter(row => isWinnerFamily(row, { minClosed: minMicroClosed }))
    .sort(sortByPnl);

  const topPnlFamilies = rankedWithData.slice(0, 30);
  const topTotalRFamilies = familiesWithData.slice().sort(sortByTotalR).slice(0, 30);
  const topWinrateFamilies = familiesWithData
    .filter(row => row.closed >= Math.max(3, Math.floor(minClosed / 2)))
    .sort(sortByWinrate)
    .slice(0, 30);

  const topPnlMicroFamilies = rankedMicroWithData.slice(0, 50);
  const topTotalRMicroFamilies = microWithData.slice().sort(sortByTotalR).slice(0, 50);
  const topWinrateMicroFamilies = microWithData
    .filter(row => row.closed >= Math.max(3, Math.floor(minMicroClosed / 2)))
    .sort(sortByWinrate)
    .slice(0, 50);

  const bestLongByPnl = longFamilies.filter(row => row.observed > 0).sort(sortByPnl)[0] || null;
  const bestShortByPnl = shortFamilies.filter(row => row.observed > 0).sort(sortByPnl)[0] || null;

  const bestLongMicroByPnl = longMicroFamilies.filter(row => row.observed > 0).sort(sortByPnl)[0] || null;
  const bestShortMicroByPnl = shortMicroFamilies.filter(row => row.observed > 0).sort(sortByPnl)[0] || null;

  return {
    rows,

    stats: {
      actions: rows.length,
      trades: rows.length,
      open: rows.filter(row => row.closed !== true).length,
      closed: closedRows.length,
      pendingOutcome: rows.filter(row => row.closed !== true || row.resultR === null).length,

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

      longMicroFamilies: summarizeFamilies(longMicroFamilies),
      shortMicroFamilies: summarizeFamilies(shortMicroFamilies),
      microFamiliesWithData: microWithData.length
    },

    familyPerformanceMatrix: {
      long: {
        total: FAMILY_COUNT_PER_SIDE,
        summary: summarizeFamilies(longFamilies),
        families: longFamilies
      },
      short: {
        total: FAMILY_COUNT_PER_SIDE,
        summary: summarizeFamilies(shortFamilies),
        families: shortFamilies
      }
    },

    microFamilyPerformanceMatrix: {
      long: {
        total: longMicroFamilies.length,
        summary: summarizeFamilies(longMicroFamilies),
        families: longMicroFamilies
      },
      short: {
        total: shortMicroFamilies.length,
        summary: summarizeFamilies(shortMicroFamilies),
        families: shortMicroFamilies
      },
      all: {
        total: allMicroFamilies.length,
        summary: summarizeFamilies(allMicroFamilies),
        families: allMicroFamilies
      }
    },

    best: {
      bestLongByPnl,
      bestShortByPnl,
      topPnlFamily: rankedWithData[0] || null,
      topTotalRFamily: topTotalRFamilies[0] || null,
      topWinrateFamily: topWinrateFamilies[0] || null
    },

    microBest: {
      bestLongMicroByPnl,
      bestShortMicroByPnl,
      topPnlMicroFamily: rankedMicroWithData[0] || null,
      topTotalRMicroFamily: topTotalRMicroFamilies[0] || null,
      topWinrateMicroFamily: topWinrateMicroFamilies[0] || null
    },

    winnerCandidates: rankedWithData
      .filter(row => row.closed >= minClosed)
      .slice(0, 20),

    winnerCandidateSummary: {
      count: rankedWithData.filter(row => row.closed >= minClosed).length,
      objective: "highest_total_pnl_pct_then_total_r",
      message: "Macro families gerankt op Total PnL% en daarna Total R."
    },

    winnerFamilies: winnerFamilies.slice(0, 20),

    winnerFamilySummary: {
      count: winnerFamilies.length,
      rule: "HOT/GOOD/STABLE macro families met voldoende closed trades, positieve Avg R, Total R en Total PnL%."
    },

    microWinnerCandidates: rankedMicroWithData
      .filter(row => row.closed >= minMicroClosed)
      .slice(0, 30),

    microWinnerCandidateSummary: {
      count: rankedMicroWithData.filter(row => row.closed >= minMicroClosed).length,
      objective: "highest_total_pnl_pct_then_total_r",
      message: "Micro families gerankt op exacte filter-buckets. Gebruik microFamilyKey voor Discord live gate."
    },

    microWinnerFamilies: winnerMicroFamilies.slice(0, 30),

    microWinnerFamilySummary: {
      count: winnerMicroFamilies.length,
      minMicroClosed,
      rule: "HOT/GOOD/STABLE micro families met voldoende closed trades, positieve Avg R, Total R en Total PnL%."
    },

    leaderboards: {
      topPnlFamilies,
      topTotalRFamilies,
      topWinrateFamilies
    },

    microLeaderboards: {
      topPnlMicroFamilies,
      topTotalRMicroFamilies,
      topWinrateMicroFamilies
    }
  };
}

export default {
  buildRunnerFamilyDefinitions,
  getRunnerFamilyForRow,
  buildRunnerMicroLabels,
  getRunnerMicroFamilyForRow,
  normalizeRunnerAnalyzeRow,
  normalizeRunnerAnalyzeRows,
  buildRunnerFamilyAnalysis
};