const SYSTEM_PROFILE = "RUNNER";
const ENDPOINT = "/api/analyze";
const OBJECTIVE = "RUNNER_PNL_FIRST";
const STRATEGY = "50_LONG_FAMILIES_PLUS_50_SHORT_FAMILIES";

const DEFAULT_MIN_CLOSED = 10;
const DEFAULT_BREAKEVEN_R_EPS = 0.05;
const DEFAULT_MAX_EXAMPLES_PER_FAMILY = 8;

const FAMILY_COUNT_PER_SIDE = 50;
const TOTAL_FAMILY_COUNT = 100;

const MAX_LEADERBOARD_ROWS = 20;
const MAX_RETURNED_FAMILIES = 50;

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

function round(value, digits = 3) {
  const n = safeNumber(value, 0);
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function normalizeText(value) {
  return String(value || "").trim().toUpperCase();
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

function normalizeSide(value) {
  const s = String(value || "").toUpperCase().trim();

  if (s === "LONG" || s === "BULL" || s === "BUY") return "LONG";
  if (s === "SHORT" || s === "BEAR" || s === "SELL") return "SHORT";

  return "";
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

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;

  const v = String(value).trim().toLowerCase();

  if (["true", "1", "yes", "y", "on"].includes(v)) return true;
  if (["false", "0", "no", "n", "off"].includes(v)) return false;

  return fallback;
}

function getAction(req) {
  return String(getQueryParam(req, "action", ""))
    .trim()
    .toLowerCase();
}

function getConfig(req) {
  return {
    minClosed: Math.max(
      1,
      Math.round(safeNumber(getQueryParam(req, "minClosed", DEFAULT_MIN_CLOSED), DEFAULT_MIN_CLOSED))
    ),
    breakevenREps: Math.max(
      0,
      safeNumber(getQueryParam(req, "breakevenREps", DEFAULT_BREAKEVEN_R_EPS), DEFAULT_BREAKEVEN_R_EPS)
    ),
    maxExamplesPerFamily: Math.max(
      0,
      Math.round(
        safeNumber(
          getQueryParam(req, "maxExamplesPerFamily", DEFAULT_MAX_EXAMPLES_PER_FAMILY),
          DEFAULT_MAX_EXAMPLES_PER_FAMILY
        )
      )
    ),
    familyCountPerSide: FAMILY_COUNT_PER_SIDE,
    totalFamilyCount: TOTAL_FAMILY_COUNT,
  };
}

// ================= STORE LOADING =================

async function loadRunnerAnalyzeStore() {
  const mod = await import("../lib/analyze/runnerAnalyzeStore.js");

  const loader =
    mod.loadRunnerAnalyzeEvents ||
    mod.readRunnerAnalyzeEvents ||
    mod.getRunnerAnalyzeEvents ||
    mod.loadRunnerAnalyzeStore ||
    mod.readRunnerAnalyzeStore ||
    mod.getRunnerAnalyzeStore;

  if (typeof loader !== "function") {
    throw new Error("runner_analyze_store_loader_missing");
  }

  const loaded = await loader();

  if (Array.isArray(loaded)) {
    return {
      ok: true,
      events: loaded,
      source: {
        mode: "RUNNER_ANALYZE_STORE",
        storeSource: "runner_analyze_store",
        redisKey: "runner:analyze:store:v1:events",
        legacyRedisKey: "runner:analyze:store:v1",
        path: "/tmp/runner-analyze-events.json",
        redisEnabled: true,
        fileEnabled: true,
        loadedAt: Date.now(),
        lastPersistAt: 0,
      },
      raw: null,
    };
  }

  const obj = safeObject(loaded);

  return {
    ok: obj.ok !== false,
    events: safeArray(obj.events || obj.rows || obj.trades || obj.data),
    source: {
      mode: "RUNNER_ANALYZE_STORE",
      storeSource: obj.storeSource || "runner_analyze_store",
      redisKey: obj.redisKey || "runner:analyze:store:v1:events",
      legacyRedisKey: obj.legacyRedisKey || "runner:analyze:store:v1",
      path: obj.path || "/tmp/runner-analyze-events.json",
      redisEnabled: obj.redisEnabled !== false,
      fileEnabled: obj.fileEnabled !== false,
      loadedAt: obj.loadedAt || Date.now(),
      lastPersistAt: obj.lastPersistAt || obj.persistedAt || 0,
    },
    raw: obj,
  };
}

async function clearRunnerAnalyzeStore() {
  const mod = await import("../lib/analyze/runnerAnalyzeStore.js");

  const clearer =
    mod.clearRunnerAnalyzeEvents ||
    mod.resetRunnerAnalyzeEvents ||
    mod.clearRunnerAnalyzeStore ||
    mod.resetRunnerAnalyzeStore;

  if (typeof clearer !== "function") {
    return {
      ok: false,
      error: "runner_analyze_store_clearer_missing",
    };
  }

  return clearer();
}

// ================= TRADE NORMALIZATION =================

function hasExitEvidence(row) {
  if (!row || typeof row !== "object") return false;

  const action = normalizeText(row.action || row.analyzeLifecycle);
  if (action === "EXIT") return true;

  if (row.closed === true && action !== "ENTRY") return true;

  if (row.exit !== undefined && row.exit !== null) return true;
  if (row.exitPrice !== undefined && row.exitPrice !== null) return true;
  if (row.executionPrice !== undefined && row.executionPrice !== null) return true;
  if (row.closedAt !== undefined && row.closedAt !== null) return true;
  if (row.exitedAt !== undefined && row.exitedAt !== null) return true;

  if (row.realizedR !== undefined && row.realizedR !== null) return true;
  if (row.pnlR !== undefined && row.pnlR !== null) return true;
  if (row.exitR !== undefined && row.exitR !== null) return true;
  if (row.resultR !== undefined && row.resultR !== null) return true;
  if (row.outcomeR !== undefined && row.outcomeR !== null) return true;
  if (row.rMultiple !== undefined && row.rMultiple !== null) return true;

  return false;
}

function isEntryPlaceholder(row) {
  const action = normalizeText(row?.action || row?.analyzeLifecycle);
  const exitReason = normalizeText(row?.exitReason || row?.reason);
  const entryType = normalizeText(row?.entryType || row?.runnerEntryType);
  const resultR = safeNumber(
    row?.resultR ?? row?.realizedR ?? row?.pnlR ?? row?.exitR ?? row?.outcomeR ?? row?.rMultiple,
    0
  );

  if (action === "ENTRY") return true;

  if (
    Math.abs(resultR) <= 1e-12 &&
    entryType &&
    exitReason &&
    exitReason === entryType
  ) {
    return true;
  }

  if (
    Math.abs(resultR) <= 1e-12 &&
    exitReason.startsWith("RUNNER_") &&
    !row?.exit &&
    !row?.exitPrice &&
    !row?.executionPrice
  ) {
    return true;
  }

  return false;
}

function getTradeR(row) {
  return safeNumber(
    row?.resultR ??
      row?.realizedR ??
      row?.pnlR ??
      row?.exitR ??
      row?.outcomeR ??
      row?.rMultiple,
    0
  );
}

function getTradePnlPct(row) {
  return safeNumber(
    row?.pnlPct ??
      row?.pnlPercent ??
      row?.realizedPnlPct ??
      row?.resultPnlPct ??
      row?.profitPct,
    0
  );
}

function getTradeTimestamp(row) {
  return safeNumber(
    row?.closedAt ??
      row?.exitedAt ??
      row?.exitTs ??
      row?.ts ??
      row?.analyzeTs ??
      row?.storedAt ??
      row?.updatedAt,
    0
  );
}

function getTradeId(row) {
  const direct =
    row?.tradeId ||
    row?.positionTradeId ||
    row?.orderId ||
    row?.clientOrderId ||
    row?.id;

  if (direct) return String(direct);

  const symbol = normalizeSymbol(row?.symbol);
  const side = normalizeSide(row?.side);
  const entry = safeNumber(row?.entry ?? row?.entryPrice ?? row?.openPrice, 0);
  const ts = getTradeTimestamp(row);
  const r = getTradeR(row);

  return `RUNNER_${symbol}_${side}_${entry}_${ts}_${r}`;
}

function normalizeTrade(row) {
  if (!row || typeof row !== "object") return null;

  const symbol = normalizeSymbol(row.symbol);
  const side = normalizeSide(row.side);

  if (!symbol || !side) return null;
  if (isEntryPlaceholder(row)) return null;
  if (!hasExitEvidence(row)) return null;

  const resultR = getTradeR(row);
  const pnlPct = getTradePnlPct(row);
  const ts = getTradeTimestamp(row);

  return {
    raw: row,

    tradeId: getTradeId(row),
    symbol,
    side,

    closed: true,
    resultR: round(resultR, 4),
    pnlPct: round(pnlPct, 4),

    exitReason: row.exitReason || row.reason || null,
    entryType: row.entryType || row.runnerEntryType || null,
    setupClass: row.setupClass || null,

    confluence: safeNumber(row.confluence, 0),
    sniperScore: safeNumber(row.sniperScore, 0),
    score: safeNumber(row.score ?? row.moveScore, 0),
    moveScore: safeNumber(row.moveScore ?? row.score, 0),

    rr: safeNumber(row.finalRR ?? row.baseRR ?? row.plannedRR ?? row.rr ?? row.targetR, 0),
    targetR: safeNumber(row.targetR, 0),

    stage: normalizeText(row.stage || row.scannerStage),
    flow: normalizeText(row.flow || row.scannerFlow),
    scannerFlow: normalizeText(row.scannerFlow || row.flow),

    rsi: safeNumber(row.rsi, 50),
    rsiZone: normalizeText(row.rsiZone),

    obBias: normalizeText(row.obBias),
    spreadPct: safeNumber(row.spreadPct, 0),
    spreadBps: safeNumber(row.spreadBps, safeNumber(row.spreadPct, 0) * 10000),
    depthMinUsd1p: safeNumber(row.depthMinUsd1p, 0),

    funding: safeNumber(row.funding ?? row.fundingRate, 0),
    fundingRate: safeNumber(row.fundingRate ?? row.funding, 0),

    btcState: normalizeText(row.btcState || row?.filterSnapshot?.btcState),
    regime: normalizeText(row.regime || row?.filterSnapshot?.regime),

    tfScore: safeNumber(row.tfScore, 0),
    tfStrength: safeNumber(row.tfStrength, Math.abs(safeNumber(row.tfScore, 0))),
    tfAlignment: normalizeText(row.tfAlignment),

    currentR: safeNumber(row.currentR, 0),
    mfeR: safeNumber(row.mfeR, 0),
    maeR: safeNumber(row.maeR, 0),

    ts,
  };
}

function dedupeTrades(trades) {
  const map = new Map();

  for (const trade of trades) {
    if (!trade) continue;

    const key = [
      trade.tradeId,
      trade.symbol,
      trade.side,
      trade.resultR,
      trade.pnlPct,
      trade.exitReason,
      trade.ts,
    ].join("|");

    map.set(key, trade);
  }

  return Array.from(map.values()).sort((a, b) => {
    return safeNumber(a.ts, 0) - safeNumber(b.ts, 0);
  });
}

// ================= FAMILY DEFINITIONS =================

function getQualityIndex(trade) {
  const conf = safeNumber(trade.confluence, 0);
  const sniper = safeNumber(trade.sniperScore, 0);
  const rr = safeNumber(trade.rr || trade.targetR, 0);
  const score = safeNumber(trade.score || trade.moveScore, 0);

  if (conf >= 85 && sniper >= 85 && rr >= 2 && score >= 85) return 5;
  if (conf >= 75 && sniper >= 75 && rr >= 1.5 && score >= 75) return 4;
  if (conf >= 65 && sniper >= 65 && rr >= 1.2 && score >= 65) return 3;
  if (conf >= 50 && sniper >= 50 && rr >= 1 && score >= 50) return 2;

  return 1;
}

function getMarketIndex(trade) {
  const side = normalizeSide(trade.side);
  const ob = normalizeText(trade.obBias);
  const btc = normalizeText(trade.btcState);
  const spreadBps = safeNumber(trade.spreadBps, safeNumber(trade.spreadPct, 0) * 10000);
  const depth = safeNumber(trade.depthMinUsd1p, 0);
  const funding = safeNumber(trade.fundingRate ?? trade.funding, 0);

  const obAgainst =
    (side === "LONG" && ob === "BEARISH") ||
    (side === "SHORT" && ob === "BULLISH");

  const obWith =
    (side === "LONG" && ob === "BULLISH") ||
    (side === "SHORT" && ob === "BEARISH");

  const btcCounter =
    (side === "LONG" && btc === "BEARISH") ||
    (side === "SHORT" && btc === "BULLISH");

  const btcWith =
    (side === "LONG" && btc === "BULLISH") ||
    (side === "SHORT" && btc === "BEARISH");

  const fundingCrowded =
    (side === "LONG" && funding > 0.0005) ||
    (side === "SHORT" && funding < -0.0005);

  const fundingOk = Math.abs(funding) <= 0.0005;

  if (obAgainst || spreadBps > 25 || depth < 10000 || btcCounter || fundingCrowded) {
    return 1;
  }

  if (spreadBps > 16 || depth < 50000 || Math.abs(funding) > 0.00035) {
    return 2;
  }

  if (spreadBps > 8 || depth < 100000 || (!btcWith && btc !== "NEUTRAL")) {
    return 3;
  }

  if ((obWith || ob === "NEUTRAL") && spreadBps <= 12 && depth >= 100000 && fundingOk) {
    return 4;
  }

  return 3;
}

function getTimingIndex(trade) {
  const side = normalizeSide(trade.side);
  const rsi = safeNumber(trade.rsi, 50);
  const stage = normalizeText(trade.stage);
  const flow = normalizeText(trade.flow || trade.scannerFlow);
  const tfStrength = Math.abs(safeNumber(trade.tfStrength ?? trade.tfScore, 0));

  const stageOk =
    stage === "ENTRY" ||
    stage === "ALMOST" ||
    !stage;

  const flowOk =
    flow === "SQUEEZE" ||
    flow === "RUNNING" ||
    flow === "BREAKOUT" ||
    flow === "BUILDING" ||
    !flow;

  const rsiOk =
    side === "LONG"
      ? rsi >= 45 && rsi <= 72
      : rsi >= 28 && rsi <= 55;

  if (stageOk && flowOk && rsiOk && tfStrength >= 3) {
    return 2;
  }

  return 1;
}

function qualityLabel(index) {
  if (index === 5) return "Q5_ELITE";
  if (index === 4) return "Q4_STRONG";
  if (index === 3) return "Q3_BASE";
  if (index === 2) return "Q2_LOW";

  return "Q1_WEAK";
}

function marketLabel(index) {
  if (index === 4) return "M4_CLEAN";
  if (index === 3) return "M3_NORMAL";
  if (index === 2) return "M2_WEAK";

  return "M1_DIRTY";
}

function timingLabel(index) {
  if (index === 2) return "T2_TIMED";

  return "T1_EARLY_OR_NOISY";
}

function getQualityRuleLabels(index) {
  if (index === 5) {
    return ["CONF_85_100", "SNIPER_85_100", "RR_2p00_PLUS", "SCORE_85_100"];
  }

  if (index === 4) {
    return ["CONF_75_85", "SNIPER_75_85", "RR_1p50_2p00", "SCORE_75_85"];
  }

  if (index === 3) {
    return ["CONF_65_75", "SNIPER_65_75", "RR_1p20_1p50", "SCORE_65_75"];
  }

  if (index === 2) {
    return ["CONF_50_65", "SNIPER_50_65", "RR_1p00_1p20", "SCORE_50_65"];
  }

  return ["CONF_0_50", "SNIPER_0_50", "RR_LT_1p00", "SCORE_0_50"];
}

function getMarketRuleLabels(index) {
  if (index === 4) {
    return [
      "OB_REL_WITH_OR_NEUTRAL",
      "SPREAD_5_12BPS",
      "DEPTH_100K_250K",
      "BTC_REL_WITH_OR_NEUTRAL",
      "FUNDING_OK",
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

  if (index === 2) {
    return [
      "OB_REL_AGAINST_OR_NEUTRAL",
      "SPREAD_16_25BPS",
      "DEPTH_10K_50K",
      "BTC_REL_COUNTER",
      "FUNDING_EDGE_WEAK",
    ];
  }

  return [
    "OB_REL_AGAINST",
    "SPREAD_GT_25BPS",
    "DEPTH_LT_10K",
    "BTC_REL_COUNTER",
    "FUNDING_CROWDED",
  ];
}

function getTimingRuleLabels(index) {
  if (index === 2) {
    return [
      "STAGE_ENTRY_OR_ALMOST",
      "FLOW_TREND_OR_BUILDING",
      "RSI_LOWER_OR_MID",
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
  const familyNumber = (qualityIndex - 1) * 10 + (marketIndex - 1) * 2 + timingIndex;
  const familyId = `${side}_${familyNumber}`;

  const labels = [
    qualityLabel(qualityIndex),
    marketLabel(marketIndex),
    timingLabel(timingIndex),
    ...getQualityRuleLabels(qualityIndex),
    "STAGE_ENTRY_OR_ALMOST",
    "FLOW_TREND_OR_BUILDING",
    ...getMarketRuleLabels(marketIndex),
    ...getTimingRuleLabels(timingIndex),
  ];

  return {
    familyId,
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

function buildFamiliesForSide(side) {
  const families = [];

  for (let qualityIndex = 1; qualityIndex <= 5; qualityIndex += 1) {
    for (let marketIndex = 1; marketIndex <= 5; marketIndex += 1) {
      for (let timingIndex = 1; timingIndex <= 2; timingIndex += 1) {
        families.push(buildFamilyDefinition(side, qualityIndex, marketIndex, timingIndex));
      }
    }
  }

  return families;
}

function buildFamilyCatalog() {
  return {
    long: buildFamiliesForSide("LONG"),
    short: buildFamiliesForSide("SHORT"),
  };
}

function getFamilyForTrade(trade) {
  const side = normalizeSide(trade.side);
  if (!side) return null;

  const qualityIndex = getQualityIndex(trade);
  const marketIndex = getMarketIndex(trade);
  const timingIndex = getTimingIndex(trade);

  return buildFamilyDefinition(side, qualityIndex, marketIndex, timingIndex);
}

// ================= STATS =================

function summarizeTrades(trades, breakevenREps) {
  const closedTrades = safeArray(trades).filter(t => t?.closed === true);
  const wins = closedTrades.filter(t => safeNumber(t.resultR, 0) > breakevenREps).length;
  const losses = closedTrades.filter(t => safeNumber(t.resultR, 0) < -breakevenREps).length;
  const breakeven = closedTrades.length - wins - losses;

  const totalR = closedTrades.reduce((sum, t) => sum + safeNumber(t.resultR, 0), 0);
  const totalPnlPct = closedTrades.reduce((sum, t) => sum + safeNumber(t.pnlPct, 0), 0);

  const grossWinR = closedTrades.reduce((sum, t) => {
    const r = safeNumber(t.resultR, 0);
    return r > 0 ? sum + r : sum;
  }, 0);

  const grossLossRAbs = Math.abs(
    closedTrades.reduce((sum, t) => {
      const r = safeNumber(t.resultR, 0);
      return r < 0 ? sum + r : sum;
    }, 0)
  );

  const avgMfeR = closedTrades.length
    ? closedTrades.reduce((sum, t) => sum + safeNumber(t.mfeR, 0), 0) / closedTrades.length
    : 0;

  const avgMaeR = closedTrades.length
    ? closedTrades.reduce((sum, t) => sum + safeNumber(t.maeR, 0), 0) / closedTrades.length
    : 0;

  const winrateNum = closedTrades.length ? wins / closedTrades.length : 0;

  return {
    actions: safeArray(trades).length,
    trades: safeArray(trades).length,
    open: 0,
    closed: closedTrades.length,
    pendingOutcome: 0,

    wins,
    losses,
    breakeven,

    winrateNum,
    winrate: `${round(winrateNum * 100, 1)}%`,

    totalR: round(totalR, 3),
    avgR: closedTrades.length ? round(totalR / closedTrades.length, 3) : 0,

    totalPnlPct: round(totalPnlPct, 3),
    avgPnlPct: closedTrades.length ? round(totalPnlPct / closedTrades.length, 3) : 0,

    grossWinR: round(grossWinR, 3),
    grossLossR: round(grossLossRAbs, 3),
    profitFactor: grossLossRAbs > 0 ? round(grossWinR / grossLossRAbs, 3) : grossWinR > 0 ? 999 : 0,
    pf: grossLossRAbs > 0 ? round(grossWinR / grossLossRAbs, 3) : grossWinR > 0 ? 999 : 0,

    avgMfeR: round(avgMfeR, 3),
    avgMaeR: round(avgMaeR, 3),
  };
}

function classifyFamily(perf, config) {
  const closed = safeNumber(perf.closed, 0);
  const avgR = safeNumber(perf.avgR, 0);
  const totalR = safeNumber(perf.totalR, 0);
  const totalPnlPct = safeNumber(perf.totalPnlPct, 0);
  const pf = safeNumber(perf.pf ?? perf.profitFactor, 0);

  if (closed <= 0) return "EMPTY";
  if (closed < config.minClosed) return "COLLECTING";

  if (avgR >= 0.25 && totalR > 0 && totalPnlPct > 0 && pf >= 1.6) {
    return "HOT";
  }

  if (avgR >= 0.12 && totalR > 0 && totalPnlPct > 0 && pf >= 1.2) {
    return "GOOD";
  }

  if (avgR > 0 && totalR > 0 && totalPnlPct >= 0) {
    return "STABLE";
  }

  return "BAD";
}

function scoreFamily(perf) {
  const closed = safeNumber(perf.closed, 0);
  const avgR = safeNumber(perf.avgR, 0);
  const totalR = safeNumber(perf.totalR, 0);
  const totalPnlPct = safeNumber(perf.totalPnlPct, 0);
  const pf = safeNumber(perf.pf ?? perf.profitFactor, 0);
  const winrateNum = safeNumber(perf.winrateNum, 0);

  return round(
    totalPnlPct * 10 +
      totalR * 6 +
      avgR * 25 +
      Math.min(pf, 10) * 4 +
      winrateNum * 20 +
      Math.min(closed, 50) * 0.2,
    3
  );
}

function buildFamilyPerformance(family, trades, config) {
  const familyTrades = safeArray(trades).filter(trade => {
    const assigned = getFamilyForTrade(trade);
    return assigned?.familyId === family.familyId;
  });

  const stats = summarizeTrades(familyTrades, config.breakevenREps);
  const status = classifyFamily(stats, config);

  const examples = familyTrades
    .filter(t => t.closed)
    .slice(-config.maxExamplesPerFamily)
    .map(t => ({
      tradeId: t.tradeId,
      symbol: t.symbol,
      side: t.side,
      closed: t.closed,
      resultR: t.resultR,
      pnlPct: t.pnlPct,
      exitReason: t.exitReason,
      entryType: t.entryType,
      setupClass: t.setupClass,
      ts: t.ts,
    }));

  return {
    ...family,
    observed: familyTrades.length,
    trades: familyTrades.length,
    closed: stats.closed,
    open: stats.open,
    pending: stats.pendingOutcome,

    wins: stats.wins,
    losses: stats.losses,
    breakeven: stats.breakeven,

    winrate: stats.winrate,
    winrateNum: stats.winrateNum,

    totalR: stats.totalR,
    avgR: stats.avgR,
    totalPnlPct: stats.totalPnlPct,
    avgPnlPct: stats.avgPnlPct,

    grossWinR: stats.grossWinR,
    grossLossR: stats.grossLossR,
    profitFactor: stats.profitFactor,
    pf: stats.pf,

    avgMfeR: stats.avgMfeR,
    avgMaeR: stats.avgMaeR,

    status,
    score: scoreFamily({
      ...stats,
      status,
    }),

    examples,
  };
}

function summarizeFamilyStatuses(families) {
  const out = {
    count: safeArray(families).length,
    total: safeArray(families).length,
    HOT: 0,
    GOOD: 0,
    STABLE: 0,
    BAD: 0,
    COLLECTING: 0,
    EMPTY: 0,
  };

  for (const family of safeArray(families)) {
    const status = family.status || "EMPTY";
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

  const avgDiff = safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0);
  if (avgDiff !== 0) return avgDiff;

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

function filterClosedSample(families, config) {
  return safeArray(families).filter(f => safeNumber(f.closed, 0) >= config.minClosed);
}

function filterWinnerFamilies(families, config) {
  return filterClosedSample(families, config)
    .filter(f => ["HOT", "GOOD", "STABLE"].includes(f.status))
    .filter(f => safeNumber(f.avgR, 0) > 0)
    .filter(f => safeNumber(f.totalR, 0) > 0)
    .filter(f => safeNumber(f.totalPnlPct, 0) >= 0)
    .sort(sortByPnl)
    .slice(0, MAX_RETURNED_FAMILIES);
}

function buildLeaderboards(allFamilies, config) {
  const sample = filterClosedSample(allFamilies, config);

  return {
    topPnlFamilies: [...sample].sort(sortByPnl).slice(0, MAX_LEADERBOARD_ROWS),
    topTotalRFamilies: [...sample].sort(sortByTotalR).slice(0, MAX_LEADERBOARD_ROWS),
    topWinrateFamilies: [...sample].sort(sortByWinrate).slice(0, MAX_LEADERBOARD_ROWS),
  };
}

function buildBest(allFamilies, config) {
  const sample = filterClosedSample(allFamilies, config);

  const longSample = sample.filter(f => f.side === "LONG");
  const shortSample = sample.filter(f => f.side === "SHORT");

  const byPnl = [...sample].sort(sortByPnl);
  const byR = [...sample].sort(sortByTotalR);
  const byWinrate = [...sample].sort(sortByWinrate);

  return {
    bestLongByPnl: [...longSample].sort(sortByPnl)[0] || null,
    bestShortByPnl: [...shortSample].sort(sortByPnl)[0] || null,
    topPnlFamily: byPnl[0] || null,
    topTotalRFamily: byR[0] || null,
    topWinrateFamily: byWinrate[0] || null,
  };
}

function buildMatrix(trades, config) {
  const catalog = buildFamilyCatalog();

  const longFamilies = catalog.long.map(family => {
    return buildFamilyPerformance(family, trades, config);
  });

  const shortFamilies = catalog.short.map(family => {
    return buildFamilyPerformance(family, trades, config);
  });

  return {
    longFamilies,
    shortFamilies,
    allFamilies: [...longFamilies, ...shortFamilies],
    familyPerformanceMatrix: {
      long: {
        total: longFamilies.length,
        summary: summarizeFamilyStatuses(longFamilies),
      },
      short: {
        total: shortFamilies.length,
        summary: summarizeFamilyStatuses(shortFamilies),
      },
    },
  };
}

// ================= RESPONSE BUILD =================

function buildStoreMeta(loaded, rawEvents, trades) {
  const raw = safeObject(loaded.raw);

  const closed = safeArray(trades).filter(t => t.closed).length;

  return {
    ok: loaded.ok !== false,
    count: safeArray(rawEvents).length,
    trades: safeArray(trades).length,
    open: 0,
    closed,
    unmatchedExits: safeNumber(raw.unmatchedExits, 0),
    maxStoredEvents: safeNumber(raw.maxStoredEvents, 50000),
  };
}

function buildResponse({ loaded, rawEvents, trades, config, startedAt }) {
  const matrix = buildMatrix(trades, config);
  const allFamilies = matrix.allFamilies;

  const stats = summarizeTrades(trades, config.breakevenREps);

  const longSummary = summarizeFamilyStatuses(matrix.longFamilies);
  const shortSummary = summarizeFamilyStatuses(matrix.shortFamilies);

  const familiesWithData = allFamilies.filter(f => safeNumber(f.closed, 0) > 0).length;

  const best = buildBest(allFamilies, config);
  const winnerCandidates = filterClosedSample(allFamilies, config)
    .filter(f => safeNumber(f.totalR, 0) > 0 || safeNumber(f.totalPnlPct, 0) > 0)
    .sort(sortByPnl)
    .slice(0, MAX_RETURNED_FAMILIES);

  const winnerFamilies = filterWinnerFamilies(allFamilies, config);
  const leaderboards = buildLeaderboards(allFamilies, config);

  return {
    ok: true,
    profile: SYSTEM_PROFILE,
    endpoint: ENDPOINT,
    objective: OBJECTIVE,
    strategy: STRATEGY,

    dataState: trades.length ? "READY" : "EMPTY",
    latencyMs: Date.now() - startedAt,
    servedAt: Date.now(),

    config,

    source: loaded.source,

    store: buildStoreMeta(loaded, rawEvents, trades),

    latest: {
      ok: true,
      count: 0,
      note: "Runner analyze gebruikt de runner analyze-store. Latest scan wordt niet gemerged in deze endpoint.",
    },

    merged: {
      count: trades.length,
      source: "runner_analyze_store_only",
    },

    stats: {
      actions: stats.actions,
      trades: stats.trades,
      open: stats.open,
      closed: stats.closed,
      pendingOutcome: stats.pendingOutcome,

      wins: stats.wins,
      losses: stats.losses,
      breakeven: stats.breakeven,

      winrateNum: stats.winrateNum,
      winrate: stats.winrate,

      totalR: stats.totalR,
      avgR: stats.avgR,
      totalPnlPct: stats.totalPnlPct,
      avgPnlPct: stats.avgPnlPct,

      longFamilies: longSummary,
      shortFamilies: shortSummary,
      familiesWithData,
    },

    familyPerformanceMatrix: matrix.familyPerformanceMatrix,

    best,

    winnerCandidates,
    winnerCandidateSummary: {
      count: winnerCandidates.length,
      objective: "highest_total_pnl_pct_then_total_r",
      message: "Runner candidates gerankt op Total PnL% en daarna Total R.",
    },

    winnerFamilies,
    winnerFamilySummary: {
      count: winnerFamilies.length,
      rule: "HOT/GOOD/STABLE families met voldoende closed trades, positieve Avg R en positieve Total R.",
    },

    leaderboards,
  };
}

// ================= HANDLER =================

export default async function handler(req, res) {
  const startedAt = Date.now();

  try {
    res.setHeader("Cache-Control", "no-store, max-age=0");

    const action = getAction(req);

    if (req.method === "POST" && (action === "reset" || action === "clear")) {
      const result = await clearRunnerAnalyzeStore();

      return res.status(result?.ok === false ? 500 : 200).json({
        ok: result?.ok !== false,
        profile: SYSTEM_PROFILE,
        endpoint: ENDPOINT,
        action,
        result,
        servedAt: Date.now(),
      });
    }

    const config = getConfig(req);
    const loaded = await loadRunnerAnalyzeStore();

    const rawEvents = safeArray(loaded.events);

    const trades = dedupeTrades(
      rawEvents
        .map(normalizeTrade)
        .filter(Boolean)
    );

    const response = buildResponse({
      loaded,
      rawEvents,
      trades,
      config,
      startedAt,
    });

    return res.status(200).json(response);
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