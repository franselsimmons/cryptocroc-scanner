const FAMILY_COUNT_PER_SIDE = 50;

const QUALITY_BUCKETS = {
  1: {
    key: "Q1_WEAK",
    conf: "CONF_0_60",
    sniper: "SNIPER_0_45",
    rr: "RR_LT_1p10",
    score: "SCORE_0_58",
    pressure: "PRESSURE_LT_0p50",
  },
  2: {
    key: "Q2_LOW",
    conf: "CONF_60_70",
    sniper: "SNIPER_45_60",
    rr: "RR_1p10_1p35",
    score: "SCORE_58_68",
    pressure: "PRESSURE_0p50_0p90",
  },
  3: {
    key: "Q3_BASE",
    conf: "CONF_70_78",
    sniper: "SNIPER_60_72",
    rr: "RR_1p35_1p60",
    score: "SCORE_68_76",
    pressure: "PRESSURE_0p90_1p50",
  },
  4: {
    key: "Q4_STRONG",
    conf: "CONF_78_85",
    sniper: "SNIPER_72_84",
    rr: "RR_1p60_2p00",
    score: "SCORE_76_85",
    pressure: "PRESSURE_1p50_2p50",
  },
  5: {
    key: "Q5_ELITE",
    conf: "CONF_85_100",
    sniper: "SNIPER_84_100",
    rr: "RR_2p00_PLUS",
    score: "SCORE_85_100",
    pressure: "PRESSURE_2p50_PLUS",
  },
};

const MARKET_BUCKETS = {
  1: {
    key: "M1_DIRTY",
    ob: "OB_REL_AGAINST",
    spread: "SPREAD_GT_30BPS",
    depth: "DEPTH_LT_10K",
    btc: "BTC_REL_COUNTER",
    funding: "FUNDING_CROWDED",
    structure: "STRUCTURE_AGAINST",
  },
  2: {
    key: "M2_WEAK",
    ob: "OB_REL_AGAINST_OR_NEUTRAL",
    spread: "SPREAD_18_30BPS",
    depth: "DEPTH_10K_25K",
    btc: "BTC_REL_COUNTER_OR_NEUTRAL",
    funding: "FUNDING_EDGE_WEAK",
    structure: "STRUCTURE_MIXED",
  },
  3: {
    key: "M3_NORMAL",
    ob: "OB_REL_NEUTRAL",
    spread: "SPREAD_10_18BPS",
    depth: "DEPTH_25K_75K",
    btc: "BTC_REL_NEUTRAL",
    funding: "FUNDING_NEUTRAL",
    structure: "STRUCTURE_NEUTRAL",
  },
  4: {
    key: "M4_CLEAN",
    ob: "OB_REL_WITH_OR_NEUTRAL",
    spread: "SPREAD_6_10BPS",
    depth: "DEPTH_75K_150K",
    btc: "BTC_REL_WITH_OR_NEUTRAL",
    funding: "FUNDING_OK",
    structure: "STRUCTURE_WITH_OR_NEUTRAL",
  },
  5: {
    key: "M5_PREMIUM",
    ob: "OB_REL_WITH",
    spread: "SPREAD_LT_6BPS",
    depth: "DEPTH_GT_150K",
    btc: "BTC_REL_WITH",
    funding: "FUNDING_OPTIMAL",
    structure: "STRUCTURE_WITH",
  },
};

const TIMING_BUCKETS = {
  1: {
    key: "T1_EARLY_OR_NOISY",
    stage: "STAGE_ANY",
    flow: "FLOW_BUILDING_OR_WEAK",
    rsi: "RSI_ANY",
    tf: "TF_ANY",
    acceleration: "ACCEL_NOT_CONFIRMED",
    execution: "RUNNER_CONFIRMATION_NOT_REQUIRED",
  },
  2: {
    key: "T2_RUNNER_TIMED",
    stage: "STAGE_ENTRY_OR_ALMOST",
    flow: "FLOW_HOT_RUNNER",
    rsi: "RSI_RUNNER_EDGE",
    tf: "TF_ALIGNED",
    acceleration: "ACCEL_POSITIVE_OR_STABLE",
    execution: "RUNNER_CONFIRMATION_OK",
  },
};

const FAMILY_ID_RE = /^(?:RUNNER_)?(LONG|SHORT)_([1-9]|[1-4][0-9]|50)$/;

const DEFAULT_MIN_CLOSED = 10;
const RESULT_EPSILON = 0.000001;

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

function pct(value, decimals = 1) {
  return `${round(value, decimals)}%`;
}

function normalizeSide(value) {
  const s = String(value || "").toLowerCase().trim();

  if (["long", "bull", "buy"].includes(s)) return "LONG";
  if (["short", "bear", "sell"].includes(s)) return "SHORT";

  return "";
}

function normalizeText(value) {
  return String(value || "").toUpperCase().trim();
}

function getPathValue(object, path) {
  if (!object || typeof object !== "object") return undefined;

  return String(path)
    .split(".")
    .reduce((acc, part) => acc?.[part], object);
}

function valueFromEvent(event, key) {
  const sources = [
    event,
    safeObject(event?.filterSnapshot),
    safeObject(event?.filters),
    safeObject(event?.filterValues),
    safeObject(event?.analysisFilters),
    safeObject(event?.entryEvent),
    safeObject(event?.entryEvent?.filterSnapshot),
  ];

  for (const source of sources) {
    const value = getPathValue(source, key);

    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }

  return undefined;
}

function firstNumber(event, keys, fallback = 0) {
  for (const key of keys) {
    const value = valueFromEvent(event, key);
    const n = Number(value);

    if (Number.isFinite(n)) return n;
  }

  return fallback;
}

function firstNullableNumber(event, keys) {
  for (const key of keys) {
    const value = valueFromEvent(event, key);
    const n = Number(value);

    if (Number.isFinite(n)) return n;
  }

  return null;
}

function firstString(event, keys, fallback = "") {
  for (const key of keys) {
    const value = valueFromEvent(event, key);

    if (value !== undefined && value !== null && value !== "") {
      return String(value);
    }
  }

  return fallback;
}

function firstBoolean(event, keys, fallback = false) {
  for (const key of keys) {
    const value = valueFromEvent(event, key);

    if (typeof value === "boolean") return value;

    const s = String(value || "").toLowerCase().trim();

    if (s === "true" || s === "1" || s === "yes") return true;
    if (s === "false" || s === "0" || s === "no") return false;
  }

  return fallback;
}

// ================= FAMILY DEFINITIONS =================

function familyIndex(q, m, t) {
  return (q - 1) * 10 + (m - 1) * 2 + t;
}

function parseFamilyId(value) {
  const id = normalizeText(value);
  const match = FAMILY_ID_RE.exec(id);

  if (!match) return null;

  const side = match[1];
  const index = Number(match[2]);

  const qualityIndex = Math.ceil(index / 10);
  const rem = index - (qualityIndex - 1) * 10;
  const marketIndex = Math.ceil(rem / 2);
  const timingIndex = rem % 2 === 0 ? 2 : 1;

  return {
    side,
    index,
    qualityIndex,
    marketIndex,
    timingIndex,
    familyId: `${side}_${index}`,
    runnerFamilyId: `${side}_${index}`,
  };
}

function buildDefinition(side, q, m, t) {
  const qDef = QUALITY_BUCKETS[q];
  const mDef = MARKET_BUCKETS[m];
  const tDef = TIMING_BUCKETS[t];

  const sideRsi =
    t === 1
      ? "RSI_ANY"
      : side === "LONG"
        ? "RSI_LOWER_MID_OR_CONTINUATION"
        : "RSI_UPPER_MID_OR_CONTINUATION";

  return [
    qDef.key,
    mDef.key,
    tDef.key,
    qDef.conf,
    qDef.sniper,
    qDef.rr,
    qDef.score,
    qDef.pressure,
    tDef.stage,
    tDef.flow,
    sideRsi,
    mDef.ob,
    mDef.spread,
    mDef.depth,
    mDef.btc,
    mDef.funding,
    mDef.structure,
    tDef.tf,
    tDef.acceleration,
    tDef.execution,
  ].join(" | ");
}

function createFamily(side, q, m, t) {
  const index = familyIndex(q, m, t);

  return {
    id: `${side}_${index}`,
    runnerFamilyId: `${side}_${index}`,
    side,
    index,
    qualityIndex: q,
    marketIndex: m,
    timingIndex: t,

    definition: buildDefinition(side, q, m, t),
    qualityBucket: QUALITY_BUCKETS[q].key,
    marketBucket: MARKET_BUCKETS[m].key,
    timingBucket: TIMING_BUCKETS[t].key,

    observed: 0,
    trades: 0,
    open: 0,
    closed: 0,
    unresolved: 0,
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

    expectancyR: 0,
    profitFactorR: 0,

    grossProfitR: 0,
    grossLossAbsR: 0,

    bestR: 0,
    worstR: 0,

    runnerScore: 0,
    balanceScore: 0,
    runnerPnlScore: 0,

    status: "EMPTY",
    decision: "NO_DATA",
  };
}

export function createRunnerAnalyzeFamilies() {
  const long = [];
  const short = [];

  for (const side of ["LONG", "SHORT"]) {
    for (let q = 1; q <= 5; q += 1) {
      for (let m = 1; m <= 5; m += 1) {
        for (let t = 1; t <= 2; t += 1) {
          const family = createFamily(side, q, m, t);

          if (side === "LONG") long.push(family);
          else short.push(family);
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

export function createAnalyzeFamilies() {
  return createRunnerAnalyzeFamilies();
}

// ================= QUALITY BUCKETING =================

function getConfluence(event) {
  return firstNumber(
    event,
    [
      "confluence",
      "confluenceScore",
      "setupConfluence",
      "scores.confluence",
      "quality.confluence",
    ],
    0
  );
}

function getSniper(event) {
  return firstNumber(
    event,
    [
      "sniperScore",
      "sniper",
      "scores.sniper",
      "quality.sniper",
    ],
    0
  );
}

function getRR(event) {
  return firstNumber(
    event,
    [
      "plannedRR",
      "rr",
      "finalRR",
      "baseRR",
      "targetR",
      "riskReward",
      "riskRewardRatio",
      "preTpRR",
      "geometryRR",
      "quality.rr",
    ],
    0
  );
}

function getMoveScore(event) {
  return firstNumber(
    event,
    [
      "moveScore",
      "score",
      "tradeScore",
      "candidateScore",
      "externalScore",
      "scores.move",
      "quality.score",
    ],
    0
  );
}

function getRunnerPressure(event) {
  return firstNumber(
    event,
    [
      "runnerPressure",
      "pressure",
      "directionalPressure",
      "quality.runnerPressure",
    ],
    0
  );
}

function bucketScore01To5(value) {
  const n = safeNumber(value, 0);

  if (n >= 85) return 5;
  if (n >= 78) return 4;
  if (n >= 70) return 3;
  if (n >= 60) return 2;

  return 1;
}

function bucketSniperTo5(value) {
  const n = safeNumber(value, 0);

  if (n >= 84) return 5;
  if (n >= 72) return 4;
  if (n >= 60) return 3;
  if (n >= 45) return 2;

  return 1;
}

function bucketRRTo5(value) {
  const n = safeNumber(value, 0);

  if (n >= 2) return 5;
  if (n >= 1.6) return 4;
  if (n >= 1.35) return 3;
  if (n >= 1.1) return 2;

  return 1;
}

function bucketPressureTo5(value) {
  const n = safeNumber(value, 0);

  if (n >= 2.5) return 5;
  if (n >= 1.5) return 4;
  if (n >= 0.9) return 3;
  if (n >= 0.5) return 2;

  return 1;
}

function setupClassBonus(event) {
  const setupClass = normalizeText(firstString(event, ["setupClass"], ""));
  const entryType = normalizeText(
    firstString(event, ["entryType", "runnerEntryType", "reason"], "")
  );

  if (setupClass === "RUNNER_C" || entryType.includes("RUNNER_C")) return 0.35;
  if (setupClass === "RUNNER_A" || entryType.includes("RUNNER_A")) return 0.25;
  if (setupClass === "RUNNER_B" || entryType.includes("RUNNER_B")) return -0.1;

  return 0;
}

function qualityIndex(event) {
  const confRaw = getConfluence(event);
  const sniperRaw = getSniper(event);
  const rrRaw = getRR(event);
  const scoreRaw = getMoveScore(event);
  const pressureRaw = getRunnerPressure(event);

  const conf = confRaw > 0 ? confRaw : scoreRaw > 0 ? scoreRaw : 60;
  const sniper = sniperRaw > 0 ? sniperRaw : conf;
  const rr = rrRaw > 0 ? rrRaw : 1.15;
  const score = scoreRaw > 0 ? scoreRaw : conf;
  const pressure = pressureRaw || 0;

  const confBucket = bucketScore01To5(conf);
  const sniperBucket = bucketSniperTo5(sniper);
  const rrBucket = bucketRRTo5(rr);
  const scoreBucket = bucketScore01To5(score);
  const pressureBucket = bucketPressureTo5(pressure);

  const weighted =
    confBucket * 1.25 +
    rrBucket * 1.45 +
    pressureBucket * 1.15 +
    scoreBucket * 1.0 +
    sniperBucket * 0.85;

  const avg = weighted / 5.7 + setupClassBonus(event);

  if (avg >= 4.5) return 5;
  if (avg >= 3.5) return 4;
  if (avg >= 2.55) return 3;
  if (avg >= 1.75) return 2;

  return 1;
}

// ================= MARKET BUCKETING =================

function getSpreadBps(event) {
  const rawBps = firstNumber(
    event,
    ["spreadBps", "spread.bps", "market.spreadBps"],
    NaN
  );

  if (Number.isFinite(rawBps)) return rawBps;

  const spreadPct = firstNumber(
    event,
    ["spreadPct", "spread", "market.spreadPct"],
    0
  );

  if (!spreadPct) return 14;

  const n = Math.abs(spreadPct);

  if (n <= 0.05) return n * 10000;
  if (n <= 10) return n * 100;

  return n;
}

function getDepthUsd1p(event) {
  return firstNumber(
    event,
    [
      "depthMinUsd1p",
      "depthUsd1p",
      "depth1p",
      "depthUsd",
      "market.depthMinUsd1p",
      "orderbook.depthMinUsd1p",
      "orderbook.depthUsd1p",
    ],
    50000
  );
}

function getFundingRate(event) {
  return firstNumber(event, ["fundingRate", "funding", "market.fundingRate"], 0);
}

function getObRelative(event, side) {
  const raw = normalizeText(
    firstString(
      event,
      [
        "obRel",
        "obRelative",
        "obBias",
        "orderbookBias",
        "orderbook.bias",
        "market.obBias",
      ],
      "NEUTRAL"
    )
  );

  if (raw.includes("WITH")) return "WITH";
  if (raw.includes("AGAINST")) return "AGAINST";
  if (raw.includes("NEUTRAL")) return "NEUTRAL";

  const bullish = ["BULL", "BULLISH", "BID", "BUY", "LONG"];
  const bearish = ["BEAR", "BEARISH", "ASK", "SELL", "SHORT"];

  const isBullish = bullish.some(x => raw.includes(x));
  const isBearish = bearish.some(x => raw.includes(x));

  if (side === "LONG") {
    if (isBullish) return "WITH";
    if (isBearish) return "AGAINST";
  }

  if (side === "SHORT") {
    if (isBearish) return "WITH";
    if (isBullish) return "AGAINST";
  }

  return "NEUTRAL";
}

function getBtcRelative(event, side) {
  const raw = normalizeText(
    firstString(
      event,
      ["btcRelative", "btcRel", "btcState", "btc.state", "market.btcState"],
      "NEUTRAL"
    )
  );

  if (raw.includes("WITH")) return "WITH";
  if (raw.includes("COUNTER")) return "COUNTER";
  if (raw.includes("NEUTRAL")) return "NEUTRAL";

  const btcBullish = raw.includes("BULL");
  const btcBearish = raw.includes("BEAR");

  if (side === "LONG") {
    if (btcBullish) return "WITH";
    if (btcBearish) return "COUNTER";
  }

  if (side === "SHORT") {
    if (btcBearish) return "WITH";
    if (btcBullish) return "COUNTER";
  }

  return "NEUTRAL";
}

function getFundingBucket(event, side) {
  const funding = getFundingRate(event);

  if (side === "LONG") {
    if (funding > 0.014) return "CROWDED";
    if (funding < -0.003) return "OPTIMAL";
    if (funding > 0.006) return "EDGE_WEAK";
    return "NEUTRAL";
  }

  if (side === "SHORT") {
    if (funding < -0.014) return "CROWDED";
    if (funding > 0.003) return "OPTIMAL";
    if (funding < -0.006) return "EDGE_WEAK";
    return "NEUTRAL";
  }

  return "NEUTRAL";
}

function getStructureRelative(event, side) {
  const raw = normalizeText(
    firstString(
      event,
      ["structure", "structureTrend", "runnerStructure", "marketStructure"],
      "NEUTRAL"
    )
  );

  if (
    firstBoolean(
      event,
      ["structureAligned", "isStructureAligned"],
      false
    )
  ) {
    return "WITH";
  }

  if (raw.includes("WITH")) return "WITH";
  if (raw.includes("AGAINST")) return "AGAINST";
  if (raw.includes("RANGE") || raw.includes("NEUTRAL") || raw.includes("UNKNOWN")) {
    return "NEUTRAL";
  }

  const bullish = raw.includes("BULL");
  const bearish = raw.includes("BEAR");

  if (side === "LONG") {
    if (bullish) return "WITH";
    if (bearish) return "AGAINST";
  }

  if (side === "SHORT") {
    if (bearish) return "WITH";
    if (bullish) return "AGAINST";
  }

  return "NEUTRAL";
}

function marketIndex(event, side) {
  const spreadBps = getSpreadBps(event);
  const depth = getDepthUsd1p(event);
  const obRel = getObRelative(event, side);
  const btcRel = getBtcRelative(event, side);
  const funding = getFundingBucket(event, side);
  const structure = getStructureRelative(event, side);

  let points = 0;

  if (spreadBps <= 6) points += 2;
  else if (spreadBps <= 10) points += 1;
  else if (spreadBps > 30) points -= 2;
  else if (spreadBps > 18) points -= 1;

  if (depth >= 150000) points += 2;
  else if (depth >= 75000) points += 1;
  else if (depth < 10000) points -= 2;
  else if (depth < 25000) points -= 1;

  if (obRel === "WITH") points += 1;
  if (obRel === "AGAINST") points -= 1;

  if (btcRel === "WITH") points += 1;
  if (btcRel === "COUNTER") points -= 1;

  if (funding === "OPTIMAL") points += 1;
  if (funding === "CROWDED") points -= 1;

  if (structure === "WITH") points += 1;
  if (structure === "AGAINST") points -= 1;

  if (points >= 5) return 5;
  if (points >= 2) return 4;
  if (points >= 0) return 3;
  if (points >= -2) return 2;

  return 1;
}

// ================= TIMING BUCKETING =================

function getStage(event) {
  const raw = String(
    firstString(
      event,
      ["stage", "scannerStage", "setupStage", "stageSource"],
      ""
    )
  ).toLowerCase();

  if (raw.includes("entry")) return "ENTRY";
  if (raw.includes("almost")) return "ALMOST";

  return "OTHER";
}

function getFlow(event) {
  const raw = normalizeText(
    firstString(
      event,
      ["flow", "detectedFlow", "scannerFlow", "flowState", "marketFlow"],
      "NEUTRAL"
    )
  );

  if (
    raw.includes("SQUEEZE") ||
    raw.includes("RUNNING") ||
    raw.includes("BREAKOUT")
  ) {
    return "HOT_RUNNER";
  }

  if (
    raw.includes("BUILDING") ||
    raw.includes("BUILDUP") ||
    raw.includes("TREND")
  ) {
    return "BUILDING";
  }

  return "NEUTRAL";
}

function isRsiTimed(event, side) {
  if (
    firstBoolean(
      event,
      ["rsiContinuationAllowed", "rsiPullbackAllowed", "rsiValid"],
      false
    )
  ) {
    return true;
  }

  if (
    firstBoolean(
      event,
      ["rsiBlocked", "rsiExhaustedAgainstSide"],
      false
    )
  ) {
    return false;
  }

  const zone = normalizeText(
    firstString(event, ["rsiZone", "rsi.zone", "rsiBucket"], "")
  );

  if (zone) {
    if (zone.includes("MID")) return true;

    if (side === "LONG") {
      if (zone.includes("UPPER_3")) return false;
      return (
        zone.includes("LOWER") ||
        zone.includes("OVERSOLD") ||
        zone.includes("UPPER_1")
      );
    }

    if (side === "SHORT") {
      if (zone.includes("LOWER_3")) return false;
      return (
        zone.includes("UPPER") ||
        zone.includes("OVERBOUGHT") ||
        zone.includes("LOWER_1")
      );
    }
  }

  const rsi = firstNumber(event, ["rsi", "rsi.value", "rsi1h", "rsiHTF"], NaN);

  if (!Number.isFinite(rsi)) return false;

  if (side === "LONG") return rsi <= 68;
  if (side === "SHORT") return rsi >= 32;

  return false;
}

function isTfAligned(event, side) {
  if (
    firstBoolean(
      event,
      ["tfAligned", "timeframeAligned", "mtfAligned"],
      false
    )
  ) {
    return true;
  }

  const tfStrength = firstNumber(
    event,
    ["tfStrength", "timeframeStrength", "mtfStrength"],
    0
  );

  if (tfStrength >= 1) return true;

  const tfScore = firstNumber(
    event,
    ["tfScore", "timeframeScore", "mtfScore"],
    0
  );

  if (side === "LONG") return tfScore > 0;
  if (side === "SHORT") return tfScore < 0;

  return false;
}

function isRunnerAccelerationOk(event) {
  const acceleration = firstNumber(
    event,
    ["runnerAcceleration", "acceleration", "directionalAcceleration"],
    0
  );

  const pressure = getRunnerPressure(event);

  if (pressure >= 2.5) return acceleration >= -0.65;
  if (pressure >= 1.15) return acceleration >= -0.35;

  return acceleration >= 0;
}

function isRunnerConfirmationOk(event) {
  if (
    firstBoolean(
      event,
      [
        "pullbackOk",
        "hasPullback",
        "confirmationOk",
        "entryConfirmationOk",
        "scannerHot",
      ],
      false
    )
  ) {
    return true;
  }

  const entryType = normalizeText(
    firstString(event, ["entryType", "runnerEntryType", "reason"], "")
  );

  if (entryType.includes("RUNNER_A") || entryType.includes("RUNNER_C")) {
    return true;
  }

  const flow = getFlow(event);
  const stage = getStage(event);

  return flow === "HOT_RUNNER" && stage === "ENTRY";
}

function timingIndex(event, side) {
  const stage = getStage(event);
  const flow = getFlow(event);

  let points = 0;

  if (stage === "ENTRY" || stage === "ALMOST") points += 1;
  if (flow === "HOT_RUNNER") points += 2;
  if (flow === "BUILDING") points += 1;
  if (isRsiTimed(event, side)) points += 1;
  if (isTfAligned(event, side)) points += 1;
  if (isRunnerAccelerationOk(event)) points += 1;
  if (isRunnerConfirmationOk(event)) points += 1;

  return points >= 5 ? 2 : 1;
}

// ================= EVENT / TRADE CLASSIFICATION =================

function isUnmatchedExit(event) {
  const kind = normalizeText(event?.analyzeKind || event?.type);
  return kind === "UNMATCHED_EXIT";
}

function isTradeRecord(event) {
  if (!event || typeof event !== "object") return false;
  if (isUnmatchedExit(event)) return false;

  const kind = normalizeText(event?.analyzeKind || event?.type);
  const profile = normalizeText(
    event?.profile ||
      event?.runnerProfile ||
      event?.filterSnapshot?.profile ||
      event?.filterSnapshot?.runnerProfile ||
      ""
  );

  if (profile && profile !== "RUNNER") return false;

  if (kind === "TRADE_RECORD" || kind === "TRADE") return true;

  if (event.tradeId || event.positionId || event.orderId) return true;

  return Boolean(
    event.entry !== undefined ||
      event.entryPrice !== undefined ||
      event.sl !== undefined ||
      event.initialSl !== undefined ||
      event.tp !== undefined ||
      event.rr !== undefined ||
      event.plannedRR !== undefined ||
      event.closed === true ||
      event.isClosed === true ||
      event.exitPrice !== undefined ||
      event.exit !== undefined ||
      event.closedAt ||
      event.exitAt ||
      event.exitedAt ||
      event.exitTs
  );
}

function getFrozenFamilyClassification(event) {
  const directFamilyId =
    event?.familyId ||
    event?.runnerFamilyId ||
    event?.analyzeFamilyId ||
    event?.analysisFamilyId ||
    event?.filterSnapshot?.familyId ||
    event?.filterSnapshot?.runnerFamilyId ||
    event?.filterSnapshot?.analyzeFamilyId;

  const parsed = parseFamilyId(directFamilyId);

  if (!parsed) return null;

  return {
    ...parsed,
    source: "FROZEN_FAMILY_ID",
  };
}

function classifyEvent(event) {
  if (!isTradeRecord(event)) return null;

  const frozen = getFrozenFamilyClassification(event);
  if (frozen) return frozen;

  const side = normalizeSide(
    event.side ??
      event.direction ??
      event.tradeSide ??
      event.filterSnapshot?.side
  );

  if (!side) return null;

  const q = qualityIndex(event);
  const m = marketIndex(event, side);
  const t = timingIndex(event, side);
  const index = familyIndex(q, m, t);

  return {
    side,
    index,
    qualityIndex: q,
    marketIndex: m,
    timingIndex: t,
    familyId: `${side}_${index}`,
    runnerFamilyId: `${side}_${index}`,
    source: "CLASSIFIED_FROM_RUNNER_SNAPSHOT",
  };
}

export function classifyRunnerAnalyzeEvent(event) {
  return classifyEvent(event);
}

export function classifyAnalyzeEvent(event) {
  return classifyEvent(event);
}

// ================= CLOSED / RESULT LOGIC =================

const R_RESULT_KEYS = [
  "realizedR",
  "pnlR",
  "closedR",
  "exitR",
  "resultR",
  "outcomeR",
  "netR",
  "rMultiple",
  "r",
];

const PNL_RESULT_KEYS = [
  "pnlPct",
  "pnlPercent",
  "realizedPnlPct",
  "closedPnlPct",
  "exitPnlPct",
  "resultPnlPct",
  "profitPct",
  "netPnlPct",
  "pnl",
];

function getStatusText(event) {
  return normalizeText(
    firstString(
      event,
      ["status", "action", "event", "reason", "exitReason", "result", "outcome"],
      ""
    )
  );
}

function getRawR(event) {
  return firstNullableNumber(event, R_RESULT_KEYS);
}

function getRawPnlPct(event) {
  return firstNullableNumber(event, PNL_RESULT_KEYS);
}

function hasNumericOutcome(event) {
  return getRawR(event) !== null || getRawPnlPct(event) !== null;
}

function hasExitSignal(event) {
  if (!isTradeRecord(event)) return false;

  if (event.closed === true) return true;
  if (event.isClosed === true) return true;

  if (event.exitPrice !== undefined && event.exitPrice !== null) return true;
  if (event.exit !== undefined && event.exit !== null) return true;
  if (event.closedAt || event.exitAt || event.exitedAt || event.exitTs) return true;

  const exitReason = firstString(event, ["exitReason", "closeReason"], "");
  if (exitReason) return true;

  const status = getStatusText(event);

  return (
    status.includes("CLOSED") ||
    status.includes("EXIT") ||
    status.includes("TP") ||
    status.includes("SL") ||
    status.includes("WIN") ||
    status.includes("LOSS") ||
    status.includes("STOP") ||
    status.includes("BREAK_EVEN") ||
    status.includes("BREAKEVEN")
  );
}

function isClosedEvent(event) {
  if (!isTradeRecord(event)) return false;
  return hasExitSignal(event) && hasNumericOutcome(event);
}

function isUnresolvedOutcomeEvent(event) {
  if (!isTradeRecord(event)) return false;
  if (isClosedEvent(event)) return false;

  return hasExitSignal(event) && !hasNumericOutcome(event);
}

function getR(event) {
  const direct = getRawR(event);

  if (direct !== null) return direct;

  const pnlPct = getRawPnlPct(event);

  if (pnlPct !== null && Math.abs(pnlPct) > RESULT_EPSILON) {
    return pnlPct / 2.25;
  }

  return 0;
}

function getOutcomePnlPct(event) {
  const value = getRawPnlPct(event);
  return value ?? 0;
}

function isWinEvent(event) {
  if (!isClosedEvent(event)) return false;

  const r = getR(event);
  const pnlPct = getOutcomePnlPct(event);

  if (r > RESULT_EPSILON || pnlPct > RESULT_EPSILON) return true;
  if (r < -RESULT_EPSILON || pnlPct < -RESULT_EPSILON) return false;

  return false;
}

function isLossEvent(event) {
  if (!isClosedEvent(event)) return false;

  const r = getR(event);
  const pnlPct = getOutcomePnlPct(event);

  if (r < -RESULT_EPSILON || pnlPct < -RESULT_EPSILON) return true;
  if (r > RESULT_EPSILON || pnlPct > RESULT_EPSILON) return false;

  return false;
}

function isBreakevenEvent(event) {
  if (!isClosedEvent(event)) return false;

  const r = getR(event);
  const pnlPct = getOutcomePnlPct(event);

  return Math.abs(r) <= RESULT_EPSILON && Math.abs(pnlPct) <= RESULT_EPSILON;
}

// ================= FAMILY SCORING =================

function getFamilyDecision(family, minClosed) {
  if (family.observed <= 0) return "NO_DATA";
  if (family.closed < minClosed) return "COLLECT_MORE";

  if (
    family.totalPnlPct > 15 &&
    family.avgPnlPct > 0.2 &&
    family.avgR >= 0.25 &&
    family.profitFactorR >= 1.35
  ) {
    return "ALLOW_PRIORITY";
  }

  if (
    family.totalPnlPct > 7.5 &&
    family.avgPnlPct > 0.1 &&
    family.avgR >= 0.15 &&
    family.profitFactorR >= 1.2
  ) {
    return "ALLOW";
  }

  if (
    family.totalPnlPct > 0 &&
    family.avgPnlPct > 0 &&
    family.avgR > 0 &&
    family.profitFactorR >= 1.1
  ) {
    return "ALLOW_SMALL_SIZE";
  }

  return "BLOCK_OR_REDUCE";
}

function scoreFamilyStatus(family, minClosed) {
  if (family.observed <= 0) return "EMPTY";
  if (family.closed < minClosed) return "COLLECTING";

  if (
    family.totalPnlPct > 15 &&
    family.avgPnlPct > 0.2 &&
    family.avgR >= 0.25 &&
    family.profitFactorR >= 1.35
  ) {
    return "HOT";
  }

  if (
    family.totalPnlPct > 7.5 &&
    family.avgPnlPct > 0.1 &&
    family.avgR >= 0.15 &&
    family.profitFactorR >= 1.2
  ) {
    return "GOOD";
  }

  if (
    family.totalPnlPct > 0 &&
    family.avgPnlPct > 0 &&
    family.avgR > 0 &&
    family.profitFactorR >= 1.1
  ) {
    return "STABLE";
  }

  return "BAD";
}

function finalizeFamily(family, minClosed) {
  family.winrateNum =
    family.closed > 0
      ? round((family.wins / family.closed) * 100, 3)
      : 0;

  family.winrate = pct(
    family.winrateNum,
    family.winrateNum % 1 === 0 ? 0 : 1
  );

  family.totalR = round(family.totalR, 3);
  family.avgR = family.closed > 0 ? round(family.totalR / family.closed, 3) : 0;

  family.totalPnlPct = round(family.totalPnlPct, 3);
  family.avgPnlPct =
    family.closed > 0 ? round(family.totalPnlPct / family.closed, 3) : 0;

  family.expectancyR = family.avgR;

  family.grossProfitR = round(family.grossProfitR, 3);
  family.grossLossAbsR = round(family.grossLossAbsR, 3);

  family.profitFactorR =
    family.grossLossAbsR > 0
      ? round(family.grossProfitR / family.grossLossAbsR, 3)
      : family.grossProfitR > 0
        ? 999
        : 0;

  family.bestR = round(family.bestR, 3);
  family.worstR = round(family.worstR, 3);

  // Runner = PnL-first. Winrate is alleen soft health.
  family.runnerPnlScore = round(
    family.totalPnlPct * 1.0 +
      family.avgPnlPct * 20 +
      family.totalR * 2.5 +
      family.avgR * 35 +
      Math.min(family.profitFactorR, 10) * 4 +
      Math.log10(Math.max(family.closed, 1)) * 5,
    3
  );

  family.balanceScore = round(
    family.avgR * 35 +
      family.avgPnlPct * 10 +
      family.winrateNum * 0.15 +
      Math.min(family.profitFactorR, 10) * 4 +
      Math.log10(Math.max(family.closed, 1)) * 5,
    3
  );

  family.runnerScore = round(
    family.runnerPnlScore * 0.8 + family.balanceScore * 0.2,
    3
  );

  family.status = scoreFamilyStatus(family, minClosed);
  family.decision = getFamilyDecision(family, minClosed);

  return family;
}

function sortRankedFamilies(families) {
  const statusRank = {
    HOT: 6,
    GOOD: 5,
    STABLE: 4,
    COLLECTING: 3,
    BAD: 2,
    EMPTY: 1,
  };

  return [...families].sort((a, b) => {
    const statusDiff = (statusRank[b.status] || 0) - (statusRank[a.status] || 0);
    if (statusDiff !== 0) return statusDiff;

    const runnerScoreDiff = safeNumber(b.runnerScore, 0) - safeNumber(a.runnerScore, 0);
    if (runnerScoreDiff !== 0) return runnerScoreDiff;

    const totalPnlDiff = safeNumber(b.totalPnlPct, 0) - safeNumber(a.totalPnlPct, 0);
    if (totalPnlDiff !== 0) return totalPnlDiff;

    const avgRDiff = safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0);
    if (avgRDiff !== 0) return avgRDiff;

    const pfDiff = safeNumber(b.profitFactorR, 0) - safeNumber(a.profitFactorR, 0);
    if (pfDiff !== 0) return pfDiff;

    const closedDiff = safeNumber(b.closed, 0) - safeNumber(a.closed, 0);
    if (closedDiff !== 0) return closedDiff;

    const observedDiff = safeNumber(b.observed, 0) - safeNumber(a.observed, 0);
    if (observedDiff !== 0) return observedDiff;

    const sideDiff = String(a.side || "").localeCompare(String(b.side || ""));
    if (sideDiff !== 0) return sideDiff;

    return safeNumber(a.index, 0) - safeNumber(b.index, 0);
  });
}

function getRunnerQualifiedFamilies(families, minClosed) {
  return safeArray(families).filter(family => {
    return (
      family.closed >= minClosed &&
      family.totalPnlPct > 0 &&
      family.avgPnlPct > 0 &&
      family.avgR > 0 &&
      family.profitFactorR >= 1.15
    );
  });
}

function sortRunnerPnlFamilies(families) {
  return [...safeArray(families)].sort((a, b) => {
    const totalPnlDiff = safeNumber(b.totalPnlPct, 0) - safeNumber(a.totalPnlPct, 0);
    if (totalPnlDiff !== 0) return totalPnlDiff;

    const runnerScoreDiff = safeNumber(b.runnerPnlScore, 0) - safeNumber(a.runnerPnlScore, 0);
    if (runnerScoreDiff !== 0) return runnerScoreDiff;

    const avgPnlDiff = safeNumber(b.avgPnlPct, 0) - safeNumber(a.avgPnlPct, 0);
    if (avgPnlDiff !== 0) return avgPnlDiff;

    const totalRDiff = safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0);
    if (totalRDiff !== 0) return totalRDiff;

    const avgRDiff = safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0);
    if (avgRDiff !== 0) return avgRDiff;

    const pfDiff = safeNumber(b.profitFactorR, 0) - safeNumber(a.profitFactorR, 0);
    if (pfDiff !== 0) return pfDiff;

    return safeNumber(b.closed, 0) - safeNumber(a.closed, 0);
  });
}

function sortBalanceFamilies(families) {
  return [...safeArray(families)].sort((a, b) => {
    const scoreDiff = safeNumber(b.balanceScore, 0) - safeNumber(a.balanceScore, 0);
    if (scoreDiff !== 0) return scoreDiff;

    const avgRDiff = safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0);
    if (avgRDiff !== 0) return avgRDiff;

    const winrateDiff = safeNumber(b.winrateNum, 0) - safeNumber(a.winrateNum, 0);
    if (winrateDiff !== 0) return winrateDiff;

    return safeNumber(b.closed, 0) - safeNumber(a.closed, 0);
  });
}

function getBestFamilies(families, limit = 10) {
  return sortRunnerPnlFamilies(
    families.filter(family =>
      ["HOT", "GOOD", "STABLE"].includes(family.status)
    )
  ).slice(0, limit);
}

function getBestBalanceFamilies(families, limit = 10, minClosed = 1) {
  return sortBalanceFamilies(
    safeArray(families).filter(family => family.closed >= minClosed)
  ).slice(0, limit);
}

function getBestRunnerPnlFamilies(families, limit = 10, minClosed = 1) {
  return sortRunnerPnlFamilies(
    safeArray(families).filter(family => family.closed >= minClosed)
  ).slice(0, limit);
}

function getWorstFamilies(families, limit = 10) {
  return [...safeArray(families)]
    .filter(family => family.closed > 0)
    .sort((a, b) => {
      const avgRDiff = safeNumber(a.avgR, 0) - safeNumber(b.avgR, 0);
      if (avgRDiff !== 0) return avgRDiff;

      const pnlDiff = safeNumber(a.totalPnlPct, 0) - safeNumber(b.totalPnlPct, 0);
      if (pnlDiff !== 0) return pnlDiff;

      return safeNumber(b.closed, 0) - safeNumber(a.closed, 0);
    })
    .slice(0, limit);
}

// ================= SUMMARY =================

function buildSummary(families, sourceEvents) {
  const tradeEvents = sourceEvents.filter(isTradeRecord);
  const closedEvents = tradeEvents.filter(isClosedEvent);
  const unresolvedEvents = tradeEvents.filter(isUnresolvedOutcomeEvent);
  const openEvents = tradeEvents.filter(event => !isClosedEvent(event));

  const wins = closedEvents.filter(isWinEvent).length;
  const losses = closedEvents.filter(isLossEvent).length;
  const breakeven = closedEvents.filter(isBreakevenEvent).length;

  const totalR = round(
    closedEvents.reduce((sum, event) => sum + getR(event), 0),
    3
  );

  const totalPnlPct = round(
    closedEvents.reduce((sum, event) => sum + getOutcomePnlPct(event), 0),
    3
  );

  const winrateNum =
    closedEvents.length > 0
      ? round((wins / closedEvents.length) * 100, 3)
      : 0;

  return {
    profile: "RUNNER",

    actions: sourceEvents.length,
    trades: tradeEvents.length,
    observed: tradeEvents.length,

    open: openEvents.length,
    closed: closedEvents.length,
    unresolved: unresolvedEvents.length,
    pendingOutcome: unresolvedEvents.length,

    wins,
    losses,
    breakeven,

    totalR,
    totalPnlPct,

    winrateNum,
    winrate: pct(winrateNum, winrateNum % 1 === 0 ? 0 : 1),

    avgR: closedEvents.length > 0 ? round(totalR / closedEvents.length, 3) : 0,
    avgPnlPct:
      closedEvents.length > 0 ? round(totalPnlPct / closedEvents.length, 3) : 0,

    longFamilies: FAMILY_COUNT_PER_SIDE,
    shortFamilies: FAMILY_COUNT_PER_SIDE,

    hotFamilies: families.filter(f => f.status === "HOT").length,
    goodFamilies: families.filter(f => f.status === "GOOD").length,
    stableFamilies: families.filter(f => f.status === "STABLE").length,
    badFamilies: families.filter(f => f.status === "BAD").length,
    collectingFamilies: families.filter(f => f.status === "COLLECTING").length,
    emptyFamilies: families.filter(f => f.status === "EMPTY").length,
  };
}

function buildSelection(finalizedAll, minClosed) {
  const qualified = getRunnerQualifiedFamilies(finalizedAll, minClosed);

  const longQualified = qualified.filter(family => family.side === "LONG");
  const shortQualified = qualified.filter(family => family.side === "SHORT");

  const runnerPnlQualified = sortRunnerPnlFamilies(qualified).slice(0, 10);
  const longRunnerPnlQualified = sortRunnerPnlFamilies(longQualified).slice(0, 10);
  const shortRunnerPnlQualified = sortRunnerPnlFamilies(shortQualified).slice(0, 10);

  const balanceQualified = sortBalanceFamilies(qualified).slice(0, 10);
  const longBalanceQualified = sortBalanceFamilies(longQualified).slice(0, 10);
  const shortBalanceQualified = sortBalanceFamilies(shortQualified).slice(0, 10);

  const rankedQualified = sortRankedFamilies(qualified).slice(0, 10);

  const primaryRunnerPnlFamily = runnerPnlQualified[0] || null;
  const primaryLongRunnerPnlFamily = longRunnerPnlQualified[0] || null;
  const primaryShortRunnerPnlFamily = shortRunnerPnlQualified[0] || null;

  const primaryBalancedFamily = balanceQualified[0] || null;
  const primaryLongBalancedFamily = longBalanceQualified[0] || null;
  const primaryShortBalancedFamily = shortBalanceQualified[0] || null;

  const blockedFamilyIds = finalizedAll
    .filter(family => family.closed >= minClosed && family.status === "BAD")
    .map(family => family.id);

  return {
    ready: qualified.length > 0,
    minClosed,
    objective: "RUNNER_TOTAL_PNL_FIRST",
    rule: "closed >= minClosed, totalPnlPct > 0, avgPnlPct > 0, avgR > 0, profitFactorR >= 1.15. Winrate is soft sanity-check.",

    primaryRunnerPnlFamily,
    primaryLongRunnerPnlFamily,
    primaryShortRunnerPnlFamily,

    primaryBalancedFamily,
    primaryLongBalancedFamily,
    primaryShortBalancedFamily,

    runnerPnlQualified,
    longRunnerPnlQualified,
    shortRunnerPnlQualified,

    balanceQualified,
    longBalanceQualified,
    shortBalanceQualified,

    rankedQualified,

    allowedFamilyIds: qualified.map(family => family.id),
    allowedRunnerFamilyIds: qualified.map(family => family.runnerFamilyId || family.id),

    blockedFamilyIds,
  };
}

// ================= REPORT BUILDER =================

export function buildRunnerAnalyzeReport(events = [], options = {}) {
  const minClosed = safeNumber(options.minClosed, DEFAULT_MIN_CLOSED);
  const sourceEvents = safeArray(events).filter(event => event && typeof event === "object");

  const families = createRunnerAnalyzeFamilies();
  const byId = new Map(families.all.map(family => [family.id, family]));

  const classificationStats = {
    sourceEvents: sourceEvents.length,
    tradeRecords: 0,
    skipped: 0,
    frozenFamily: 0,
    classifiedFromSnapshot: 0,
    missingFamily: 0,

    closedUsedForWinrate: 0,
    openTrackedOnly: 0,
    unresolvedNoOutcome: 0,
    exitSignalWithoutOutcome: 0,
  };

  for (const event of sourceEvents) {
    if (!isTradeRecord(event)) {
      classificationStats.skipped += 1;
      continue;
    }

    classificationStats.tradeRecords += 1;

    const classification = classifyEvent(event);

    if (!classification) {
      classificationStats.skipped += 1;
      classificationStats.missingFamily += 1;
      continue;
    }

    if (classification.source === "FROZEN_FAMILY_ID") {
      classificationStats.frozenFamily += 1;
    } else {
      classificationStats.classifiedFromSnapshot += 1;
    }

    const family = byId.get(classification.familyId);

    if (!family) {
      classificationStats.skipped += 1;
      classificationStats.missingFamily += 1;
      continue;
    }

    const closed = isClosedEvent(event);
    const unresolved = isUnresolvedOutcomeEvent(event);

    family.observed += 1;
    family.trades += 1;

    if (!closed) {
      family.open += 1;

      if (unresolved) {
        family.unresolved += 1;
        family.pendingOutcome += 1;
        classificationStats.unresolvedNoOutcome += 1;
        classificationStats.exitSignalWithoutOutcome += 1;
      } else {
        classificationStats.openTrackedOnly += 1;
      }

      continue;
    }

    const r = getR(event);
    const pnlPct = getOutcomePnlPct(event);

    family.closed += 1;
    family.totalR += r;
    family.totalPnlPct += pnlPct;

    if (family.closed === 1) {
      family.bestR = r;
      family.worstR = r;
    } else {
      family.bestR = Math.max(family.bestR, r);
      family.worstR = Math.min(family.worstR, r);
    }

    if (r > 0) {
      family.grossProfitR += r;
    }

    if (r < 0) {
      family.grossLossAbsR += Math.abs(r);
    }

    if (isWinEvent(event)) {
      family.wins += 1;
    } else if (isLossEvent(event)) {
      family.losses += 1;
    } else if (isBreakevenEvent(event)) {
      family.breakeven += 1;
    }

    classificationStats.closedUsedForWinrate += 1;
  }

  const finalizedLong = families.long.map(family => finalizeFamily(family, minClosed));
  const finalizedShort = families.short.map(family => finalizeFamily(family, minClosed));
  const finalizedAll = [...finalizedLong, ...finalizedShort];

  const ranked = sortRankedFamilies(finalizedAll);
  const best = getBestFamilies(finalizedAll, 10);
  const worst = getWorstFamilies(finalizedAll, 10);

  const bestBalance = getBestBalanceFamilies(finalizedAll, 10, 1);
  const bestRunnerPnl = getBestRunnerPnlFamilies(finalizedAll, 10, 1);

  const bestBalanceQualified = getBestBalanceFamilies(finalizedAll, 10, minClosed)
    .filter(family => ["HOT", "GOOD", "STABLE"].includes(family.status));

  const bestRunnerPnlQualified = getBestRunnerPnlFamilies(finalizedAll, 10, minClosed)
    .filter(family => ["HOT", "GOOD", "STABLE"].includes(family.status));

  const selection = buildSelection(finalizedAll, minClosed);

  return {
    ok: true,
    profile: "RUNNER",
    generatedAt: new Date().toISOString(),

    config: {
      profile: "RUNNER",
      minClosed,
      familyCountLong: FAMILY_COUNT_PER_SIDE,
      familyCountShort: FAMILY_COUNT_PER_SIDE,
      totalFamilyCount: FAMILY_COUNT_PER_SIDE * 2,
      winrateUsesOnlyClosedTrades: true,
      closedRequiresNumericOutcome: true,
      closedWithoutOutcomeBecomesPendingOutcome: true,
      familyUsesFrozenEntryFamilyId: true,
      objective: "RUNNER_TOTAL_PNL_FIRST",
      selectionRules: {
        minClosed,
        totalPnlPct: "> 0",
        avgPnlPct: "> 0",
        avgR: "> 0",
        profitFactorR: ">= 1.15",
        winrate: "soft_sanity_check_only",
      },
    },

    summary: buildSummary(finalizedAll, sourceEvents),

    diagnostics: classificationStats,

    selection,

    families: {
      all: ranked,
      long: finalizedLong,
      short: finalizedShort,
      ranked,
      best,
      bestBalance,
      bestRunnerPnl,
      bestBalanceQualified,
      bestRunnerPnlQualified,
      worst,
    },

    filterValues: {
      qualityBuckets: QUALITY_BUCKETS,
      marketBuckets: MARKET_BUCKETS,
      timingBuckets: TIMING_BUCKETS,
      trackedFields: [
        "tradeId",
        "familyId",
        "runnerFamilyId",
        "side",
        "setupClass",
        "entryType",
        "runnerEntryType",
        "grade",
        "stage",
        "scannerStage",
        "flow",
        "scannerFlow",
        "detectedFlow",
        "confluence",
        "sniperScore",
        "rr",
        "baseRR",
        "plannedRR",
        "targetR",
        "moveScore",
        "score",
        "runnerPressure",
        "runnerAcceleration",
        "rsi",
        "rsiZone",
        "rsiContinuationAllowed",
        "rsiPullbackAllowed",
        "obBias",
        "spreadPct",
        "spreadBps",
        "depthMinUsd1p",
        "btcState",
        "fundingRate",
        "tfScore",
        "tfStrength",
        "structure",
        "structureAligned",
        "partialTaken",
        "breakEvenMoved",
        "trailingActive",
        "adds",
        "mfeR",
        "maeR",
        "closed",
        "closedAt",
        "exitPrice",
        "pnlPct",
        "pnlR",
        "realizedR",
        "exitR",
        "resultR",
        "outcomeR",
        "exitReason",
      ],
    },
  };
}

// ================= COMPAT EXPORTS =================

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
  createRunnerAnalyzeFamilies,
  createAnalyzeFamilies,
  classifyRunnerAnalyzeEvent,
  classifyAnalyzeEvent,
  buildRunnerAnalyzeReport,
  buildAnalyzeReport,
  buildFamilyReport,
  buildReport,
  analyzeEvents,
  createAnalyzeReport,
};