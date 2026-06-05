// ================= FILE: api/admin/micro-family/[id].js =================

import {
  getIsoWeekKey,
  getPreviousIsoWeekKey,
  sideToTradeSide,
  safeNumber
} from '../../../src/utils.js';
import { getWeekMicros } from '../../../src/analyze/analyzeEngine.js';
import { getActiveRotation } from '../../../src/analyze/rotationEngine.js';

const WINRATE_Z = 1.96;
const WINRATE_BAYES_ALPHA = 1;
const WINRATE_BAYES_BETA = 1;
const SAMPLE_RELIABILITY_CAP = 50;

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET']
  });
}

function firstQueryValue(value, fallback = null) {
  if (Array.isArray(value)) return value[0] ?? fallback;
  if (value === undefined || value === null || value === '') return fallback;

  return value;
}

function toSafeLimit(value, fallback = 100) {
  const n = Number(value);

  if (!Number.isFinite(n)) return fallback;
  if (n < 1) return fallback;

  return Math.min(Math.floor(n), 500);
}

function num(value, fallback = 0) {
  return safeNumber(value, fallback);
}

function round(value, decimals = 4) {
  return Number(num(value, 0).toFixed(decimals));
}

function clamp(value, min = 0, max = 1) {
  const n = num(value, min);

  if (n < min) return min;
  if (n > max) return max;

  return n;
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function inferTradeSide(input = {}) {
  const direct = sideToTradeSide(
    input.tradeSide ||
    input.side ||
    input.positionSide ||
    input.direction
  );

  if (direct !== 'UNKNOWN') return direct;

  const rawSide = String(input.side || '').toUpperCase();

  if (['BULL', 'LONG', 'BUY'].includes(rawSide)) return 'LONG';
  if (['BEAR', 'SHORT', 'SELL'].includes(rawSide)) return 'SHORT';

  const familyId = String(input.familyId || '').toUpperCase();
  const macroFamilyId = String(input.macroFamilyId || '').toUpperCase();
  const microFamilyId = String(input.microFamilyId || input.id || '').toUpperCase();

  if (familyId.startsWith('LONG_')) return 'LONG';
  if (familyId.startsWith('SHORT_')) return 'SHORT';

  if (macroFamilyId.includes('LONG')) return 'LONG';
  if (macroFamilyId.includes('SHORT')) return 'SHORT';

  if (microFamilyId.includes('MICRO_LONG_')) return 'LONG';
  if (microFamilyId.includes('MICRO_SHORT_')) return 'SHORT';

  return 'UNKNOWN';
}

function normalizeDashboardSide(input = {}) {
  const tradeSide = typeof input === 'object'
    ? inferTradeSide(input)
    : sideToTradeSide(input);

  if (tradeSide === 'LONG') return 'bull';
  if (tradeSide === 'SHORT') return 'bear';

  return 'unknown';
}

function getFamilyId(row = {}) {
  return (
    row.familyId ||
    row.family ||
    row.baseFamilyId ||
    null
  );
}

function getMacroFamilyId(row = {}) {
  return (
    row.macroFamilyId ||
    row.parentMicroFamilyId ||
    row.parentFamilyId ||
    row.macroId ||
    row.familyId ||
    null
  );
}

function getDefinitionParts(row = {}) {
  if (Array.isArray(row.definitionParts)) return row.definitionParts;
  if (Array.isArray(row.microDefinitionParts)) return row.microDefinitionParts;
  if (Array.isArray(row.definition)) return row.definition;

  return [];
}

function getMacroDefinitionParts(row = {}) {
  if (Array.isArray(row.macroDefinitionParts)) return row.macroDefinitionParts;

  return [];
}

function extractActiveIds(activeRotation) {
  if (!activeRotation) return [];

  const ids = [
    ...(Array.isArray(activeRotation.microFamilyIds) ? activeRotation.microFamilyIds : []),
    ...(Array.isArray(activeRotation.activeMicroFamilyIds) ? activeRotation.activeMicroFamilyIds : []),
    ...(Array.isArray(activeRotation.ids) ? activeRotation.ids : []),
    ...(Array.isArray(activeRotation.microFamilies)
      ? activeRotation.microFamilies.map((row) => row.microFamilyId)
      : [])
  ];

  return uniqueStrings(ids);
}

function extractActiveMacroIds(activeRotation) {
  if (!activeRotation) return [];

  const ids = [
    ...(Array.isArray(activeRotation.macroFamilyIds) ? activeRotation.macroFamilyIds : []),
    ...(Array.isArray(activeRotation.activeMacroFamilyIds) ? activeRotation.activeMacroFamilyIds : []),
    ...(Array.isArray(activeRotation.microFamilies)
      ? activeRotation.microFamilies.map((row) => getMacroFamilyId(row))
      : [])
  ];

  return uniqueStrings(ids);
}

function getCompletedSample(row = {}) {
  const realCompleted = num(row.realCompleted, 0);
  const shadowCompleted = num(row.shadowCompleted, 0);
  const explicitCompleted = realCompleted + shadowCompleted;

  const weightedCompleted = num(row.completed, 0);

  const outcomeCompleted =
    num(row.realWins, 0) +
    num(row.realLosses, 0) +
    num(row.realFlats, 0) +
    num(row.shadowWins, 0) +
    num(row.shadowLosses, 0) +
    num(row.shadowFlats, 0);

  const weightedOutcomes =
    num(row.wins, 0) +
    num(row.losses, 0) +
    num(row.flats, 0);

  return Math.max(
    explicitCompleted,
    weightedCompleted,
    outcomeCompleted,
    weightedOutcomes,
    0
  );
}

function getOutcomeCounts(row = {}) {
  const realWins = num(row.realWins, 0);
  const realLosses = num(row.realLosses, 0);
  const realFlats = num(row.realFlats, 0);

  const shadowWins = num(row.shadowWins, 0);
  const shadowLosses = num(row.shadowLosses, 0);
  const shadowFlats = num(row.shadowFlats, 0);

  const actualWins = realWins + shadowWins;
  const actualLosses = realLosses + shadowLosses;
  const actualFlats = realFlats + shadowFlats;
  const actualTotal = actualWins + actualLosses + actualFlats;

  if (actualTotal > 0) {
    return {
      wins: actualWins,
      losses: actualLosses,
      flats: actualFlats,
      total: actualTotal
    };
  }

  const weightedWins = num(row.wins, 0);
  const weightedLosses = num(row.losses, 0);
  const weightedFlats = num(row.flats, 0);
  const weightedTotal = weightedWins + weightedLosses + weightedFlats;

  if (weightedTotal > 0) {
    return {
      wins: weightedWins,
      losses: weightedLosses,
      flats: weightedFlats,
      total: weightedTotal
    };
  }

  const sample = getCompletedSample(row);
  const rawWinrate = clamp(row.winrate, 0, 1);

  if (sample <= 0) {
    return {
      wins: 0,
      losses: 0,
      flats: 0,
      total: 0
    };
  }

  return {
    wins: rawWinrate * sample,
    losses: (1 - rawWinrate) * sample,
    flats: 0,
    total: sample
  };
}

function wilsonLowerBound(successes, trials, z = WINRATE_Z) {
  const n = num(trials, 0);

  if (n <= 0) return 0;

  const p = clamp(successes / n, 0, 1);
  const z2 = z * z;

  const numerator =
    p +
    z2 / (2 * n) -
    z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);

  const denominator = 1 + z2 / n;

  return clamp(numerator / denominator, 0, 1);
}

function sampleReliability(sample, cap = SAMPLE_RELIABILITY_CAP) {
  const n = num(sample, 0);

  if (n <= 0) return 0;

  return clamp(Math.sqrt(Math.min(n, cap) / cap), 0, 1);
}

function getSampleAdjustedWinrate(row = {}) {
  const counts = getOutcomeCounts(row);
  const sample = counts.total;

  if (sample <= 0) {
    return {
      sample: 0,
      wins: 0,
      losses: 0,
      flats: 0,
      rawWinrate: 0,
      bayesianWinrate: 0,
      wilsonLowerBound: 0,
      reliability: 0,
      score: 0
    };
  }

  const successes = counts.wins + counts.flats * 0.5;
  const rawWinrate = clamp(successes / sample, 0, 1);

  const bayesianWinrate = clamp(
    (successes + WINRATE_BAYES_ALPHA) /
      (sample + WINRATE_BAYES_ALPHA + WINRATE_BAYES_BETA),
    0,
    1
  );

  const wilson = wilsonLowerBound(successes, sample);
  const reliability = sampleReliability(sample);

  const score = clamp(
    wilson * 0.8 +
      bayesianWinrate * 0.15 +
      rawWinrate * 0.05,
    0,
    1
  );

  return {
    sample,
    wins: counts.wins,
    losses: counts.losses,
    flats: counts.flats,
    rawWinrate,
    bayesianWinrate,
    wilsonLowerBound: wilson,
    reliability,
    score
  };
}

function getDashboardBalancedScore(row = {}) {
  const winrateMeta = getSampleAdjustedWinrate(row);

  const totalR = Math.max(0, num(row.totalR, 0));
  const avgR = Math.max(0, num(row.avgR, 0));
  const profitFactor = Math.min(Math.max(0, num(row.profitFactor, 0)), 20);

  const directSLPct = clamp(row.directSLPct, 0, 1);
  const nearTpThenLossPct = clamp(row.nearTpThenLossPct, 0, 1);
  const gaveBackAfterOneRPct = clamp(row.gaveBackAfterOneRPct, 0, 1);
  const avgCostR = Math.max(0, num(row.avgCostR, 0));

  const winrateComponent = winrateMeta.score * 100;
  const reliabilityComponent = winrateMeta.reliability * 20;
  const totalRComponent = Math.log1p(totalR) * 12;
  const avgRComponent = Math.log1p(avgR) * 8;
  const pfComponent = Math.log1p(profitFactor) * 3;

  const riskPenalty =
    directSLPct * 60 +
    nearTpThenLossPct * 45 +
    gaveBackAfterOneRPct * 20 +
    avgCostR * 3;

  return (
    winrateComponent +
    reliabilityComponent +
    totalRComponent +
    avgRComponent +
    pfComponent -
    riskPenalty
  );
}

function compareNumberDesc(a, b) {
  return num(b, 0) - num(a, 0);
}

function compareNumberAsc(a, b) {
  return num(a, 0) - num(b, 0);
}

function compareIdAsc(a, b) {
  return String(a || '').localeCompare(String(b || ''));
}

function compareNormalizedWinrate(a, b) {
  return (
    compareNumberDesc(a.sampleAdjustedWinrate, b.sampleAdjustedWinrate) ||
    compareNumberDesc(a.sampleWilsonLowerBound, b.sampleWilsonLowerBound) ||
    compareNumberDesc(a.sampleBayesianWinrate, b.sampleBayesianWinrate) ||
    compareNumberDesc(a.sampleRawWinrate, b.sampleRawWinrate) ||
    compareNumberDesc(a.winrateSample, b.winrateSample) ||
    compareNumberDesc(a.totalR, b.totalR) ||
    compareNumberDesc(a.avgR, b.avgR) ||
    compareIdAsc(a.microFamilyId, b.microFamilyId)
  );
}

function compareNormalizedBalanced(a, b) {
  return (
    compareNumberDesc(a.dashboardBalancedScore, b.dashboardBalancedScore) ||
    compareNormalizedWinrate(a, b)
  );
}

function compareNormalizedTotalR(a, b) {
  return (
    compareNumberDesc(a.totalR, b.totalR) ||
    compareNormalizedWinrate(a, b)
  );
}

function compareNormalizedAvgR(a, b) {
  return (
    compareNumberDesc(a.avgR, b.avgR) ||
    compareNormalizedWinrate(a, b)
  );
}

function compareNormalizedDirectSL(a, b) {
  return (
    compareNumberAsc(a.directSLPct, b.directSLPct) ||
    compareNumberDesc(a.winrateSample, b.winrateSample) ||
    compareNormalizedWinrate(a, b)
  );
}

function normalizeMicroRow(
  id,
  row = {},
  {
    activeSet = new Set(),
    activeMacroSet = new Set()
  } = {}
) {
  const microFamilyId = row.microFamilyId || row.id || row.key || id;
  const familyId = getFamilyId(row);
  const macroFamilyId = getMacroFamilyId(row);

  const fairWinrate = num(
    row.fairWinrate ??
    row.bayesianWinrate ??
    row.wilsonLowerBound,
    0
  );

  const winrateMeta = getSampleAdjustedWinrate(row);
  const definitionParts = getDefinitionParts(row);
  const macroDefinitionParts = getMacroDefinitionParts(row);

  const active = microFamilyId
    ? activeSet.has(microFamilyId)
    : false;

  const macroActive = macroFamilyId
    ? activeMacroSet.has(macroFamilyId)
    : false;

  return {
    ...row,

    microFamilyId,
    familyId,
    macroFamilyId,

    side: normalizeDashboardSide(row),
    tradeSide: inferTradeSide(row),

    active,
    macroActive,

    seen: num(row.seen, 0),
    observations: num(row.observations, 0),

    completed: round(row.completed, 4),
    realCompleted: num(row.realCompleted, 0),
    shadowCompleted: num(row.shadowCompleted, 0),

    wins: round(row.wins, 4),
    losses: round(row.losses, 4),
    flats: round(row.flats, 4),

    realWins: num(row.realWins, 0),
    realLosses: num(row.realLosses, 0),
    realFlats: num(row.realFlats, 0),

    shadowWins: num(row.shadowWins, 0),
    shadowLosses: num(row.shadowLosses, 0),
    shadowFlats: num(row.shadowFlats, 0),

    winrate: round(row.winrate, 4),
    bayesianWinrate: round(row.bayesianWinrate, 4),
    wilsonLowerBound: round(row.wilsonLowerBound, 4),
    fairWinrate: round(fairWinrate, 4),

    winrateSample: round(row.winrateSample ?? winrateMeta.sample, 4),
    sampleAdjustedWinrate: round(row.sampleAdjustedWinrate ?? winrateMeta.score, 4),
    sampleRawWinrate: round(row.sampleRawWinrate ?? winrateMeta.rawWinrate, 4),
    sampleBayesianWinrate: round(row.sampleBayesianWinrate ?? winrateMeta.bayesianWinrate, 4),
    sampleWilsonLowerBound: round(row.sampleWilsonLowerBound ?? winrateMeta.wilsonLowerBound, 4),
    sampleReliability: round(row.sampleReliability ?? winrateMeta.reliability, 4),

    totalR: round(row.totalR, 4),
    realTotalR: round(row.realTotalR, 4),
    shadowTotalR: round(row.shadowTotalR, 4),

    realTotalPnlPct: round(row.realTotalPnlPct, 4),
    shadowTotalPnlPct: round(row.shadowTotalPnlPct, 4),

    grossWinR: round(row.grossWinR, 4),
    grossLossR: round(row.grossLossR, 4),

    realGrossWinR: round(row.realGrossWinR, 4),
    realGrossLossR: round(row.realGrossLossR, 4),
    shadowGrossWinR: round(row.shadowGrossWinR, 4),
    shadowGrossLossR: round(row.shadowGrossLossR, 4),

    avgR: round(row.avgR, 4),
    avgWinR: round(row.avgWinR, 4),
    avgLossR: round(row.avgLossR, 4),

    totalPnlPct: round(row.totalPnlPct, 4),
    avgPnlPct: round(row.avgPnlPct, 4),

    profitFactor: round(row.profitFactor, 4),

    directSLCount: round(row.directSLCount, 4),
    directSLPct: round(row.directSLPct, 4),

    nearTpCount: round(row.nearTpCount, 4),
    nearTpPct: round(row.nearTpPct, 4),

    reachedHalfRCount: round(row.reachedHalfRCount, 4),
    reachedOneRCount: round(row.reachedOneRCount, 4),
    reachedHalfRPct: round(row.reachedHalfRPct, 4),
    reachedOneRPct: round(row.reachedOneRPct, 4),

    beWouldExitCount: round(row.beWouldExitCount, 4),
    beWouldExitPct: round(row.beWouldExitPct, 4),

    gaveBackAfterHalfRCount: round(row.gaveBackAfterHalfRCount, 4),
    gaveBackAfterOneRCount: round(row.gaveBackAfterOneRCount, 4),
    gaveBackAfterHalfRPct: round(row.gaveBackAfterHalfRPct, 4),
    gaveBackAfterOneRPct: round(row.gaveBackAfterOneRPct, 4),

    nearTpThenLossCount: round(row.nearTpThenLossCount, 4),
    nearTpThenLossPct: round(row.nearTpThenLossPct, 4),

    totalCostR: round(row.totalCostR, 4),
    avgCostR: round(row.avgCostR, 4),
    realTotalCostR: round(row.realTotalCostR, 4),
    shadowTotalCostR: round(row.shadowTotalCostR, 4),

    sampleReliabilityOld: round(row.sampleReliability, 4),
    balancedScore: round(row.balancedScore, 4),
    dashboardBalancedScore: round(row.dashboardBalancedScore ?? getDashboardBalancedScore(row), 4),

    definition: row.definition || null,
    definitionParts,

    macroDefinition: row.macroDefinition || null,
    macroDefinitionParts,

    microDefinition: row.microDefinition || row.definition || null,
    microDefinitionParts: Array.isArray(row.microDefinitionParts)
      ? row.microDefinitionParts
      : definitionParts,

    counters: row.counters || {},
    examples: Array.isArray(row.examples) ? row.examples : [],
    recentOutcomes: Array.isArray(row.recentOutcomes) ? row.recentOutcomes : [],

    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };
}

function compactRow(row) {
  if (!row) return null;

  return {
    microFamilyId: row.microFamilyId,
    familyId: row.familyId,
    macroFamilyId: row.macroFamilyId,

    side: row.side,
    tradeSide: row.tradeSide,

    active: Boolean(row.active),
    macroActive: Boolean(row.macroActive),

    seen: row.seen,
    completed: row.completed,
    realCompleted: row.realCompleted,
    shadowCompleted: row.shadowCompleted,

    winrateSample: row.winrateSample,
    winrate: row.winrate,
    fairWinrate: row.fairWinrate,
    sampleAdjustedWinrate: row.sampleAdjustedWinrate,
    sampleWilsonLowerBound: row.sampleWilsonLowerBound,
    sampleReliability: row.sampleReliability,

    avgR: row.avgR,
    totalR: row.totalR,
    profitFactor: row.profitFactor,

    directSLPct: row.directSLPct,
    avgCostR: row.avgCostR,

    balancedScore: row.balancedScore,
    dashboardBalancedScore: row.dashboardBalancedScore
  };
}

function buildDetailSummary(row) {
  return {
    microFamilyId: row.microFamilyId,
    familyId: row.familyId,
    macroFamilyId: row.macroFamilyId,

    side: row.side,
    tradeSide: row.tradeSide,

    active: row.active,
    macroActive: row.macroActive,

    seen: row.seen,
    completed: row.completed,
    realCompleted: row.realCompleted,
    shadowCompleted: row.shadowCompleted,

    winrateSample: row.winrateSample,
    fairWinrate: row.fairWinrate,
    winrate: row.winrate,
    sampleAdjustedWinrate: row.sampleAdjustedWinrate,
    sampleWilsonLowerBound: row.sampleWilsonLowerBound,
    sampleReliability: row.sampleReliability,

    avgR: row.avgR,
    totalR: row.totalR,
    profitFactor: row.profitFactor,

    directSLPct: row.directSLPct,
    nearTpPct: row.nearTpPct,

    reachedHalfRPct: row.reachedHalfRPct,
    reachedOneRPct: row.reachedOneRPct,

    beWouldExitPct: row.beWouldExitPct,
    gaveBackAfterHalfRPct: row.gaveBackAfterHalfRPct,
    gaveBackAfterOneRPct: row.gaveBackAfterOneRPct,
    nearTpThenLossPct: row.nearTpThenLossPct,

    avgCostR: row.avgCostR,
    balancedScore: row.balancedScore,
    dashboardBalancedScore: row.dashboardBalancedScore
  };
}

function bestBy(rows = [], comparator) {
  return [...rows].sort(comparator)[0] || null;
}

function buildMacroSummary(rows = [], macroFamilyId = null) {
  const completed = rows.reduce((sum, row) => sum + num(row.completed, 0), 0);
  const totalR = rows.reduce((sum, row) => sum + num(row.totalR, 0), 0);
  const totalCostR = rows.reduce((sum, row) => sum + num(row.totalCostR, 0), 0);
  const seen = rows.reduce((sum, row) => sum + num(row.seen, 0), 0);
  const winrateSample = rows.reduce((sum, row) => sum + num(row.winrateSample, 0), 0);

  const sides = uniqueStrings(rows.map((row) => row.tradeSide));
  const activeRows = rows.filter((row) => row.active);
  const macroActiveRows = rows.filter((row) => row.macroActive);

  const bestBalanced = bestBy(rows, compareNormalizedBalanced);
  const bestWinrate = bestBy(rows, compareNormalizedWinrate);
  const bestTotalR = bestBy(rows, compareNormalizedTotalR);
  const bestAvgR = bestBy(rows, compareNormalizedAvgR);
  const lowestDirectSL = bestBy(rows, compareNormalizedDirectSL);

  return {
    macroFamilyId,

    side: sides.length === 1
      ? normalizeDashboardSide({ tradeSide: sides[0] })
      : 'mixed',

    tradeSide: sides.length === 1 ? sides[0] : 'MIXED',

    microFamilies: rows.length,
    activeMicroFamilies: activeRows.length,
    macroActiveMicroFamilies: macroActiveRows.length,

    seen: round(seen, 4),
    completed: round(completed, 4),
    winrateSample: round(winrateSample, 4),

    totalR: round(totalR, 4),
    totalCostR: round(totalCostR, 4),
    avgR: completed > 0 ? round(totalR / completed, 4) : 0,
    avgCostR: completed > 0 ? round(totalCostR / completed, 4) : 0,

    bestBalanced: compactRow(bestBalanced),
    bestWinrate: compactRow(bestWinrate),
    bestTotalR: compactRow(bestTotalR),
    bestAvgR: compactRow(bestAvgR),
    lowestDirectSL: compactRow(lowestDirectSL)
  };
}

function findRawRow(micros = {}, id) {
  if (!id) return null;

  if (micros[id]) {
    return {
      key: id,
      row: micros[id]
    };
  }

  const found = Object.entries(micros || {}).find(([key, row]) => {
    const microFamilyId = row?.microFamilyId || row?.id || row?.key || key;

    return microFamilyId === id;
  });

  if (!found) return null;

  return {
    key: found[0],
    row: found[1]
  };
}

function normalizeAllRows(micros = {}, activeSet, activeMacroSet) {
  return Object.entries(micros || {}).map(([key, row]) => (
    normalizeMicroRow(key, row, {
      activeSet,
      activeMacroSet
    })
  ));
}

function getMacroRows(rows = [], id) {
  return rows.filter((row) => (
    row.macroFamilyId === id ||
    row.familyId === id
  ));
}

function sortRelatedRows(rows = []) {
  return [...rows].sort(compareNormalizedBalanced);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    return methodNotAllowed(res);
  }

  try {
    const id = firstQueryValue(req.query?.id, null);
    const weekKey = firstQueryValue(req.query?.weekKey, getIsoWeekKey());
    const relatedLimit = toSafeLimit(firstQueryValue(req.query?.relatedLimit, 100), 100);

    const currentWeekKey = getIsoWeekKey();
    const previousWeekKey = getPreviousIsoWeekKey();

    if (!id) {
      return res.status(400).json({
        ok: false,
        error: 'MICRO_FAMILY_ID_REQUIRED'
      });
    }

    const [micros, activeRotation] = await Promise.all([
      getWeekMicros(weekKey),
      getActiveRotation()
    ]);

    const activeIds = extractActiveIds(activeRotation);
    const activeMacroIds = extractActiveMacroIds(activeRotation);

    const activeSet = new Set(activeIds);
    const activeMacroSet = new Set(activeMacroIds);

    const allRows = normalizeAllRows(micros, activeSet, activeMacroSet);
    const rawMatch = findRawRow(micros, id);

    if (!rawMatch) {
      const macroRows = sortRelatedRows(getMacroRows(allRows, id))
        .slice(0, relatedLimit);

      if (macroRows.length > 0) {
        return res.status(200).json({
          ok: true,

          type: 'MACRO_FAMILY_DETAIL',

          id,
          weekKey,
          currentWeekKey,
          previousWeekKey,

          activeRotationId: activeRotation?.rotationId || null,
          active: macroRows.some((row) => row.active),
          macroActive: macroRows.some((row) => row.macroActive),

          summary: buildMacroSummary(macroRows, id),
          row: null,

          macroFamilyId: id,
          microFamilies: macroRows,
          relatedMicroFamilies: macroRows,

          activeMicroFamilyIds: activeIds,
          activeMacroFamilyIds: activeMacroIds,

          availableCount: Object.keys(micros || {}).length,
          serverTs: Date.now()
        });
      }

      return res.status(404).json({
        ok: false,
        reason: 'MICRO_OR_MACRO_FAMILY_NOT_FOUND',
        id,
        weekKey,
        currentWeekKey,
        previousWeekKey,
        availableCount: Object.keys(micros || {}).length,
        activeRotationId: activeRotation?.rotationId || null
      });
    }

    const row = normalizeMicroRow(rawMatch.key, rawMatch.row, {
      activeSet,
      activeMacroSet
    });

    const macroFamilyId = row.macroFamilyId || row.familyId || null;

    const relatedMicroFamilies = macroFamilyId
      ? sortRelatedRows(
        allRows.filter((candidate) => (
          candidate.microFamilyId !== row.microFamilyId &&
          candidate.macroFamilyId === macroFamilyId
        ))
      ).slice(0, relatedLimit)
      : [];

    const macroRows = macroFamilyId
      ? sortRelatedRows(
        allRows.filter((candidate) => candidate.macroFamilyId === macroFamilyId)
      )
      : [row];

    return res.status(200).json({
      ok: true,

      type: 'MICRO_FAMILY_DETAIL',

      id,
      weekKey,
      currentWeekKey,
      previousWeekKey,

      activeRotationId: activeRotation?.rotationId || null,
      active: row.active,
      macroActive: row.macroActive,

      summary: buildDetailSummary(row),
      macroSummary: buildMacroSummary(macroRows, macroFamilyId),

      row,

      macroFamilyId,
      relatedMicroFamilies,

      activeMicroFamilyIds: activeIds,
      activeMacroFamilyIds: activeMacroIds,

      serverTs: Date.now()
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}
