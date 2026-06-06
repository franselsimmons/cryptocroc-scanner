// ================= FILE: src/analyze/scoring.js =================

import { CONFIG } from '../config.js';
import { clamp, safeNumber, sideToTradeSide } from '../utils.js';

const DEFAULT_WILSON_Z = 1.96;
const DEFAULT_PRIOR_TRADES = 24;
const DEFAULT_PRIOR_WINRATE = 0.5;
const DEFAULT_SAMPLE_CAP = 50;
const DEFAULT_AVG_R_CAP = 5;
const DEFAULT_AVG_R_SAMPLE_EXPONENT = 1.35;

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const VALID_TRADE_SIDES = new Set([TARGET_TRADE_SIDE]);

function now() {
  return Date.now();
}

function round4(value) {
  return Number(safeNumber(value, 0).toFixed(4));
}

function rotationNumber(key, fallback) {
  return safeNumber(CONFIG.rotation?.[key], fallback);
}

function analyzeNumber(key, fallback) {
  return safeNumber(CONFIG.analyze?.[key], fallback);
}

function shadowWeight() {
  return clamp(analyzeNumber('shadowWeight', 0.35), 0, 1);
}

function priorTrades() {
  return Math.max(0, rotationNumber('priorTrades', DEFAULT_PRIOR_TRADES));
}

function priorWinrate() {
  return clamp(rotationNumber('priorWinrate', DEFAULT_PRIOR_WINRATE), 0, 1);
}

function wilsonZ() {
  return Math.max(0.1, rotationNumber('wilsonZ', DEFAULT_WILSON_Z));
}

function sampleCap() {
  return Math.max(1, rotationNumber('sampleReliabilityCap', DEFAULT_SAMPLE_CAP));
}

function avgRCap() {
  return Math.max(0.5, rotationNumber('avgRCap', DEFAULT_AVG_R_CAP));
}

function avgRSampleExponent() {
  return clamp(
    rotationNumber('avgRSampleExponent', DEFAULT_AVG_R_SAMPLE_EXPONENT),
    0.5,
    3
  );
}

function positive(value) {
  return Math.max(0, safeNumber(value, 0));
}

function inc(obj, key, amount = 1) {
  const k = String(key || 'UNKNOWN').toUpperCase();

  obj[k] = safeNumber(obj[k], 0) + amount;
}

function makeCounters() {
  return {
    rsiZone: {},
    flow: {},
    obRelation: {},
    btcState: {},
    regime: {},
    scannerReason: {}
  };
}

function normalizeTradeSide(value) {
  const raw = String(value || '').trim().toUpperCase();

  if (!raw) return 'UNKNOWN';

  const direct = sideToTradeSide(raw);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;

  if (['LONG', 'BULL', 'BUY'].includes(raw)) return TARGET_TRADE_SIDE;

  const normalized = raw.replace(/[^A-Z0-9]+/g, '_');

  const longHit =
    normalized === 'LONG' ||
    normalized === 'BULL' ||
    normalized === 'BUY' ||
    normalized === 'SIDE_LONG' ||
    normalized === 'TRADE_SIDE_LONG' ||
    normalized === 'TRADESIDE_LONG' ||
    normalized === 'DIRECTION_LONG' ||
    normalized === 'SIDE_BULL' ||
    normalized === 'TRADE_SIDE_BULL' ||
    normalized === 'DIRECTION_BULL' ||
    normalized === 'SIDE_BUY' ||
    normalized === 'DIRECTION_BUY' ||
    normalized.startsWith('LONG_') ||
    normalized.startsWith('BULL_') ||
    normalized.startsWith('BUY_') ||
    normalized.endsWith('_LONG') ||
    normalized.endsWith('_BULL') ||
    normalized.endsWith('_BUY') ||
    normalized.includes('_LONG_') ||
    normalized.includes('_BULL_') ||
    normalized.includes('_BUY_') ||
    normalized.includes('MICRO_LONG') ||
    normalized.includes('FAMILY_LONG') ||
    normalized.includes('TRADESIDE_LONG') ||
    normalized.includes('TRADE_SIDE_LONG') ||
    normalized.includes('SIDE_LONG');

  if (longHit) return TARGET_TRADE_SIDE;

  return 'UNKNOWN';
}

function inferTradeSide(row = {}) {
  if (typeof row === 'string') return normalizeTradeSide(row);

  const values = [
    row.tradeSide,
    row.side,
    row.positionSide,
    row.direction,
    row.signalSide,
    row.intentSide,
    row.entrySide,

    row.familyId,
    row.family,
    row.baseFamilyId,

    row.microFamilyId,
    row.trueMicroFamilyId,
    row.id,
    row.key,

    row.macroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId,
    row.parentFamilyId,
    row.macroId,

    row.definition,
    row.microDefinition,
    row.macroDefinition,
    row.parentDefinition,

    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts : []),
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : [])
  ];

  for (const value of values) {
    const side = normalizeTradeSide(value);

    if (VALID_TRADE_SIDES.has(side)) return side;
  }

  return 'UNKNOWN';
}

function isTargetSideRow(row = {}) {
  return inferTradeSide(row) === TARGET_TRADE_SIDE;
}

function isShortRow(row = {}) {
  return isTargetSideRow(row);
}

function dashboardSideFromTradeSide(side, fallback = 'unknown') {
  const tradeSide = normalizeTradeSide(side);

  if (tradeSide === TARGET_TRADE_SIDE) return TARGET_DASHBOARD_SIDE;

  return String(fallback || 'unknown').toLowerCase();
}

function applyTargetSideFlags(stats = {}) {
  stats.targetTradeSide = TARGET_TRADE_SIDE;
  stats.longOnly = true;
  stats.shortDisabled = true;

  delete stats.shortOnly;
  delete stats.longDisabled;

  return stats;
}

function applySideIdentity(stats = {}, row = {}) {
  const tradeSide = inferTradeSide({
    ...stats,
    ...row
  });

  applyTargetSideFlags(stats);

  if (tradeSide !== TARGET_TRADE_SIDE) {
    stats.tradeSide = null;
    stats.side = 'unknown';
    return stats;
  }

  stats.tradeSide = TARGET_TRADE_SIDE;
  stats.side = TARGET_DASHBOARD_SIDE;

  return stats;
}

function hasSourceBuckets(stats = {}) {
  return (
    safeNumber(stats.realCompleted, 0) > 0 ||
    safeNumber(stats.shadowCompleted, 0) > 0 ||
    safeNumber(stats.realWins, 0) > 0 ||
    safeNumber(stats.realLosses, 0) > 0 ||
    safeNumber(stats.realFlats, 0) > 0 ||
    safeNumber(stats.shadowWins, 0) > 0 ||
    safeNumber(stats.shadowLosses, 0) > 0 ||
    safeNumber(stats.shadowFlats, 0) > 0
  );
}

function actualOutcomeCounts(stats = {}) {
  const realCompleted = safeNumber(stats.realCompleted, 0);
  const shadowCompleted = safeNumber(stats.shadowCompleted, 0);

  if (hasSourceBuckets(stats)) {
    const realWins = safeNumber(stats.realWins, 0);
    const realLosses = safeNumber(stats.realLosses, 0);
    const realFlats = safeNumber(stats.realFlats, 0);

    const shadowWins = safeNumber(stats.shadowWins, 0);
    const shadowLosses = safeNumber(stats.shadowLosses, 0);
    const shadowFlats = safeNumber(stats.shadowFlats, 0);

    const completed = realCompleted + shadowCompleted;
    const bucketCompleted =
      realWins +
      realLosses +
      realFlats +
      shadowWins +
      shadowLosses +
      shadowFlats;

    const inferredFlats = Math.max(0, completed - bucketCompleted);

    return {
      wins: realWins + shadowWins,
      losses: realLosses + shadowLosses,
      flats: realFlats + shadowFlats + inferredFlats,
      completed: Math.max(completed, bucketCompleted)
    };
  }

  const weightedWins = safeNumber(stats.wins, 0);
  const weightedLosses = safeNumber(stats.losses, 0);
  const weightedFlats = safeNumber(stats.flats, 0);
  const weightedCompleted = weightedWins + weightedLosses + weightedFlats;

  if (weightedCompleted > 0) {
    return {
      wins: weightedWins,
      losses: weightedLosses,
      flats: weightedFlats,
      completed: weightedCompleted
    };
  }

  const completedFallback = safeNumber(stats.completed, 0);
  const winrateFallback = clamp(safeNumber(stats.winrate, 0), 0, 1);

  if (completedFallback <= 0) {
    return {
      wins: 0,
      losses: 0,
      flats: 0,
      completed: 0
    };
  }

  return {
    wins: completedFallback * winrateFallback,
    losses: completedFallback * (1 - winrateFallback),
    flats: 0,
    completed: completedFallback
  };
}

function weightedCompletedCount(stats = {}) {
  const realCompleted = safeNumber(stats.realCompleted, 0);
  const shadowCompleted = safeNumber(stats.shadowCompleted, 0);
  const sourceCompleted = realCompleted + shadowCompleted * shadowWeight();

  if (sourceCompleted > 0) return sourceCompleted;

  return safeNumber(stats.completed, 0);
}

function weightedSourceCounts(stats = {}) {
  const w = shadowWeight();

  const wins =
    safeNumber(stats.realWins, 0) +
    safeNumber(stats.shadowWins, 0) * w;

  const losses =
    safeNumber(stats.realLosses, 0) +
    safeNumber(stats.shadowLosses, 0) * w;

  const flats =
    safeNumber(stats.realFlats, 0) +
    safeNumber(stats.shadowFlats, 0) * w;

  return {
    wins,
    losses,
    flats,
    completed: wins + losses + flats
  };
}

function weightedSourceTotals(stats = {}) {
  const w = shadowWeight();

  return {
    totalR:
      safeNumber(stats.realTotalR, 0) +
      safeNumber(stats.shadowTotalR, 0) * w,

    totalPnlPct:
      safeNumber(stats.realTotalPnlPct, 0) +
      safeNumber(stats.shadowTotalPnlPct, 0) * w,

    totalCostR:
      safeNumber(stats.realTotalCostR, 0) +
      safeNumber(stats.shadowTotalCostR, 0) * w,

    grossWinR:
      safeNumber(stats.realGrossWinR, 0) +
      safeNumber(stats.shadowGrossWinR, 0) * w,

    grossLossR:
      safeNumber(stats.realGrossLossR, 0) +
      safeNumber(stats.shadowGrossLossR, 0) * w
  };
}

function aggregateRecentOutcomes(stats = {}) {
  const outcomes = Array.isArray(stats.recentOutcomes)
    ? stats.recentOutcomes.filter(isTargetSideRow)
    : [];

  return outcomes.reduce(
    (acc, row) => {
      const src = String(row.source || 'REAL').toUpperCase();
      const weight = src === 'SHADOW' ? shadowWeight() : 1;

      const exitR = safeNumber(row.exitR ?? row.netR, 0);
      const pnlPct = safeNumber(row.pnlPct ?? row.netPnlPct, 0);
      const costR = safeNumber(row.costR, 0);

      const win = exitR > 0;
      const loss = exitR < 0;
      const flat = !win && !loss;

      acc.completed += weight;
      acc.actualCompleted += 1;

      if (win) {
        acc.wins += weight;
        acc.actualWins += 1;
        acc.grossWinR += exitR * weight;
      }

      if (loss) {
        acc.losses += weight;
        acc.actualLosses += 1;
        acc.grossLossR += Math.abs(exitR) * weight;
      }

      if (flat) {
        acc.flats += weight;
        acc.actualFlats += 1;
      }

      acc.totalR += exitR * weight;
      acc.totalPnlPct += pnlPct * weight;
      acc.totalCostR += costR * weight;

      return acc;
    },
    {
      completed: 0,
      wins: 0,
      losses: 0,
      flats: 0,

      actualCompleted: 0,
      actualWins: 0,
      actualLosses: 0,
      actualFlats: 0,

      totalR: 0,
      totalPnlPct: 0,
      totalCostR: 0,
      grossWinR: 0,
      grossLossR: 0
    }
  );
}

function maxPositive(...values) {
  return Math.max(0, ...values.map((value) => positive(value)));
}

function preferLegacyNonZero(legacy, source, fallback = 0) {
  const legacyValue = safeNumber(legacy, 0);

  if (legacyValue !== 0) return legacyValue;

  const sourceValue = safeNumber(source, 0);

  if (sourceValue !== 0) return sourceValue;

  return safeNumber(fallback, 0);
}

function sampleReliability(completed) {
  const n = safeNumber(completed, 0);

  if (n <= 0) return 0;

  return clamp(Math.sqrt(Math.min(n, sampleCap()) / sampleCap()), 0, 1);
}

function sampleAdjustedAvgR(avgR, reliability) {
  const cappedAvgR = clamp(
    safeNumber(avgR, 0),
    -avgRCap(),
    avgRCap()
  );

  const samplePenalty = Math.pow(
    clamp(reliability, 0, 1),
    avgRSampleExponent()
  );

  return cappedAvgR * samplePenalty;
}

export function createMicroStats({
  microFamilyId,
  familyId,
  side = TARGET_DASHBOARD_SIDE,
  tradeSide = TARGET_TRADE_SIDE,
  definitionParts = []
} = {}) {
  const ts = now();

  const inferredTradeSide = inferTradeSide({
    microFamilyId,
    familyId,
    side,
    tradeSide,
    definitionParts
  });

  const cleanTradeSide = inferredTradeSide === TARGET_TRADE_SIDE
    ? TARGET_TRADE_SIDE
    : normalizeTradeSide(tradeSide || side);

  const isTargetSide = cleanTradeSide === TARGET_TRADE_SIDE;

  return {
    microFamilyId,
    familyId,

    side: isTargetSide ? TARGET_DASHBOARD_SIDE : 'unknown',
    tradeSide: isTargetSide ? TARGET_TRADE_SIDE : null,

    targetTradeSide: TARGET_TRADE_SIDE,
    longOnly: true,
    shortDisabled: true,

    definitionParts,
    definition: definitionParts.join(' | '),

    seen: 0,
    observations: 0,

    realCompleted: 0,
    shadowCompleted: 0,
    completed: 0,
    winrateSample: 0,

    wins: 0,
    losses: 0,
    flats: 0,

    realWins: 0,
    realLosses: 0,
    realFlats: 0,

    shadowWins: 0,
    shadowLosses: 0,
    shadowFlats: 0,

    totalR: 0,
    realTotalR: 0,
    shadowTotalR: 0,

    totalPnlPct: 0,
    realTotalPnlPct: 0,
    shadowTotalPnlPct: 0,

    totalCostR: 0,
    realTotalCostR: 0,
    shadowTotalCostR: 0,

    grossWinR: 0,
    grossLossR: 0,

    realGrossWinR: 0,
    realGrossLossR: 0,
    shadowGrossWinR: 0,
    shadowGrossLossR: 0,

    avgR: 0,
    avgWinR: 0,
    avgLossR: 0,
    sampleAdjustedAvgR: 0,
    avgRScore: 0,

    avgPnlPct: 0,

    directSLCount: 0,
    nearTpCount: 0,
    reachedHalfRCount: 0,
    reachedOneRCount: 0,

    beWouldExitCount: 0,
    gaveBackAfterHalfRCount: 0,
    gaveBackAfterOneRCount: 0,
    nearTpThenLossCount: 0,

    avgCostR: 0,

    winrate: 0,
    bayesianWinrate: 0,
    wilsonLowerBound: 0,
    fairWinrate: 0,
    sampleAdjustedWinrate: 0,

    sampleRawWinrate: 0,
    sampleBayesianWinrate: 0,
    sampleWilsonLowerBound: 0,
    sampleReliabilityOld: 0,

    profitFactor: 0,
    sampleReliability: 0,
    balancedScore: 0,
    dashboardBalancedScore: 0,

    directSLPct: 0,
    nearTpPct: 0,
    reachedHalfRPct: 0,
    reachedOneRPct: 0,

    beWouldExitPct: 0,
    gaveBackAfterHalfRPct: 0,
    gaveBackAfterOneRPct: 0,
    nearTpThenLossPct: 0,

    counters: makeCounters(),

    examples: [],
    recentOutcomes: [],

    createdAt: ts,
    updatedAt: ts
  };
}

function ensureStatsShape(stats = {}) {
  stats.counters ||= makeCounters();
  stats.counters.rsiZone ||= {};
  stats.counters.flow ||= {};
  stats.counters.obRelation ||= {};
  stats.counters.btcState ||= {};
  stats.counters.regime ||= {};
  stats.counters.scannerReason ||= {};

  stats.examples = Array.isArray(stats.examples)
    ? stats.examples.filter(isTargetSideRow)
    : [];

  stats.recentOutcomes = Array.isArray(stats.recentOutcomes)
    ? stats.recentOutcomes.filter(isTargetSideRow)
    : [];

  stats.definitionParts = Array.isArray(stats.definitionParts)
    ? stats.definitionParts
    : [];

  stats.definition ||= stats.definitionParts.join(' | ');

  applyTargetSideFlags(stats);
  applySideIdentity(stats);

  const numericFields = [
    'seen',
    'observations',

    'realCompleted',
    'shadowCompleted',
    'completed',
    'winrateSample',

    'wins',
    'losses',
    'flats',

    'realWins',
    'realLosses',
    'realFlats',

    'shadowWins',
    'shadowLosses',
    'shadowFlats',

    'totalR',
    'realTotalR',
    'shadowTotalR',

    'totalPnlPct',
    'realTotalPnlPct',
    'shadowTotalPnlPct',

    'totalCostR',
    'realTotalCostR',
    'shadowTotalCostR',

    'grossWinR',
    'grossLossR',

    'realGrossWinR',
    'realGrossLossR',
    'shadowGrossWinR',
    'shadowGrossLossR',

    'avgR',
    'avgWinR',
    'avgLossR',
    'sampleAdjustedAvgR',
    'avgRScore',

    'avgPnlPct',
    'avgCostR',

    'directSLCount',
    'nearTpCount',
    'reachedHalfRCount',
    'reachedOneRCount',

    'beWouldExitCount',
    'gaveBackAfterHalfRCount',
    'gaveBackAfterOneRCount',
    'nearTpThenLossCount',

    'winrate',
    'bayesianWinrate',
    'wilsonLowerBound',
    'fairWinrate',
    'sampleAdjustedWinrate',

    'sampleRawWinrate',
    'sampleBayesianWinrate',
    'sampleWilsonLowerBound',
    'sampleReliabilityOld',

    'profitFactor',
    'sampleReliability',
    'balancedScore',
    'dashboardBalancedScore',

    'directSLPct',
    'nearTpPct',
    'reachedHalfRPct',
    'reachedOneRPct',

    'beWouldExitPct',
    'gaveBackAfterHalfRPct',
    'gaveBackAfterOneRPct',
    'nearTpThenLossPct'
  ];

  for (const field of numericFields) {
    stats[field] = safeNumber(stats[field], 0);
  }

  stats.createdAt ||= now();
  stats.updatedAt ||= now();

  return stats;
}

export function updateObservation(stats, row = {}) {
  ensureStatsShape(stats);

  if (!isTargetSideRow({ ...stats, ...row })) {
    return stats;
  }

  applySideIdentity(stats, row);

  stats.seen = safeNumber(stats.seen, 0) + 1;
  stats.observations = safeNumber(stats.observations, 0) + 1;

  inc(stats.counters.rsiZone, row.rsiZone);
  inc(stats.counters.flow, row.flow);
  inc(stats.counters.obRelation, row.obRelation);
  inc(stats.counters.btcState, row.btcState ?? row.btcRelation);
  inc(stats.counters.regime, row.regime);
  inc(stats.counters.scannerReason, row.scannerReason);

  if (stats.examples.length < 20) {
    stats.examples.push({
      symbol: row.symbol || null,
      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,

      rsiZone: row.rsiZone || null,
      flow: row.flow || null,
      obRelation: row.obRelation || null,
      scannerReason: row.scannerReason || null,

      isMirrorMicroFamily: false,
      observationMirror: false,
      mirrorOfSide: null,

      ts: row.createdAt || row.ts || now()
    });
  }

  stats.updatedAt = now();

  return stats;
}

export function updateOutcome(stats, row = {}, source = 'REAL') {
  ensureStatsShape(stats);

  if (!isTargetSideRow({ ...stats, ...row })) {
    return refreshStats(stats);
  }

  applySideIdentity(stats, row);

  const src = String(source || row.source || 'REAL').toUpperCase();
  const isShadow = src === 'SHADOW';
  const weight = isShadow ? shadowWeight() : 1;

  const exitR = safeNumber(row.exitR ?? row.netR, 0);
  const pnlPct = safeNumber(row.pnlPct ?? row.netPnlPct, 0);
  const costR = safeNumber(row.costR, 0);

  const win = exitR > 0;
  const loss = exitR < 0;
  const flat = !win && !loss;

  if (isShadow) {
    stats.shadowCompleted += 1;
    stats.shadowTotalR += exitR;
    stats.shadowTotalPnlPct += pnlPct;
    stats.shadowTotalCostR += costR;

    if (win) {
      stats.shadowWins += 1;
      stats.shadowGrossWinR += exitR;
    }

    if (loss) {
      stats.shadowLosses += 1;
      stats.shadowGrossLossR += Math.abs(exitR);
    }

    if (flat) stats.shadowFlats += 1;
  } else {
    stats.realCompleted += 1;
    stats.realTotalR += exitR;
    stats.realTotalPnlPct += pnlPct;
    stats.realTotalCostR += costR;

    if (win) {
      stats.realWins += 1;
      stats.realGrossWinR += exitR;
    }

    if (loss) {
      stats.realLosses += 1;
      stats.realGrossLossR += Math.abs(exitR);
    }

    if (flat) stats.realFlats += 1;
  }

  stats.completed = weightedCompletedCount(stats);

  stats.wins += win ? weight : 0;
  stats.losses += loss ? weight : 0;
  stats.flats += flat ? weight : 0;

  stats.totalR += exitR * weight;
  stats.totalPnlPct += pnlPct * weight;
  stats.totalCostR += costR * weight;

  if (win) stats.grossWinR += exitR * weight;
  if (loss) stats.grossLossR += Math.abs(exitR) * weight;

  if (row.directToSL) stats.directSLCount += weight;
  if (row.nearTpSeen) stats.nearTpCount += weight;
  if (row.reachedHalfR) stats.reachedHalfRCount += weight;
  if (row.reachedOneR) stats.reachedOneRCount += weight;

  if (row.beWouldExit) stats.beWouldExitCount += weight;
  if (row.gaveBackAfterHalfR) stats.gaveBackAfterHalfRCount += weight;
  if (row.gaveBackAfterOneR) stats.gaveBackAfterOneRCount += weight;
  if (row.nearTpThenLoss) stats.nearTpThenLossCount += weight;

  stats.recentOutcomes.push({
    source: src,
    symbol: row.symbol || null,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,

    exitReason: row.exitReason || null,

    exitR,
    netR: safeNumber(row.netR ?? exitR, exitR),
    grossR: safeNumber(row.grossR, 0),

    pnlPct,
    netPnlPct: safeNumber(row.netPnlPct ?? pnlPct, pnlPct),
    grossPnlPct: safeNumber(row.grossPnlPct, 0),

    costR,
    costPct: safeNumber(row.costPct, 0),

    mfeR: safeNumber(row.mfeR, 0),
    maeR: safeNumber(row.maeR, 0),

    directToSL: Boolean(row.directToSL),
    nearTpSeen: Boolean(row.nearTpSeen),
    reachedHalfR: Boolean(row.reachedHalfR),
    reachedOneR: Boolean(row.reachedOneR),

    beArmed: Boolean(row.beArmed),
    beWouldExit: Boolean(row.beWouldExit),
    beExitR: safeNumber(row.beExitR, 0),

    gaveBackAfterHalfR: Boolean(row.gaveBackAfterHalfR),
    gaveBackAfterOneR: Boolean(row.gaveBackAfterOneR),
    nearTpThenLoss: Boolean(row.nearTpThenLoss),

    isMirrorMicroFamily: false,
    outcomeMirror: false,
    mirrorOfSide: null,

    ts: row.closedAt || row.completedAt || now()
  });

  stats.recentOutcomes = stats.recentOutcomes.slice(-30);
  stats.updatedAt = now();

  return refreshStats(stats);
}

export function wilsonLowerBound(wins, completed, z = wilsonZ()) {
  const n = safeNumber(completed, 0);
  const w = clamp(safeNumber(wins, 0), 0, n);

  if (n <= 0) return 0;

  const p = w / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);

  return clamp((centre - margin) / denominator, 0, 1);
}

export function bayesianWinrate(wins, completed) {
  const n = safeNumber(completed, 0);
  const w = safeNumber(wins, 0);

  const priorN = priorTrades();
  const priorW = priorN * priorWinrate();

  const denominator = n + priorN;

  return denominator > 0
    ? clamp((w + priorW) / denominator, 0, 1)
    : 0;
}

function buildBalancedScore({
  fair,
  avgR,
  totalR,
  sampleRel,
  profitFactor,
  nearTpPct,
  reachedOneRPct,
  directSLPct,
  nearTpThenLossPct,
  gaveBackAfterOneRPct,
  avgCostR
}) {
  const pfNorm = clamp(profitFactor, 0, 10) / 10;

  const totalRComponent = Math.log1p(positive(totalR)) * 12;
  const avgRComponent = Math.log1p(positive(avgR)) * 8;

  return (
    fair * 100 +
    sampleRel * 25 +
    totalRComponent +
    avgRComponent +
    pfNorm * 8 +
    nearTpPct * 4 +
    reachedOneRPct * 4 -
    directSLPct * 35 -
    nearTpThenLossPct * 15 -
    gaveBackAfterOneRPct * 10 -
    Math.max(0, avgCostR) * 8
  );
}

function buildAvgRScore({
  sampleAdjustedAvgRValue,
  fair,
  totalR,
  sampleRel,
  profitFactor,
  nearTpPct,
  reachedOneRPct,
  directSLPct,
  nearTpThenLossPct,
  gaveBackAfterOneRPct,
  avgCostR
}) {
  const pfNorm = clamp(profitFactor, 0, 10) / 10;
  const totalRComponent = Math.log1p(positive(totalR)) * 8;

  return (
    sampleAdjustedAvgRValue * 100 +
    fair * 35 +
    sampleRel * 25 +
    totalRComponent +
    pfNorm * 8 +
    nearTpPct * 3 +
    reachedOneRPct * 3 -
    directSLPct * 35 -
    nearTpThenLossPct * 15 -
    gaveBackAfterOneRPct * 10 -
    Math.max(0, avgCostR) * 8
  );
}

export function refreshStats(stats) {
  ensureStatsShape(stats);

  const sourceCounts = weightedSourceCounts(stats);
  const sourceTotals = weightedSourceTotals(stats);
  const recent = aggregateRecentOutcomes(stats);

  const weightedCompleted = Math.max(
    weightedCompletedCount(stats),
    safeNumber(stats.completed, 0),
    sourceCounts.completed,
    recent.completed
  );

  const weightedWins = Math.max(
    safeNumber(stats.wins, 0),
    sourceCounts.wins,
    recent.wins
  );

  const weightedLosses = Math.max(
    safeNumber(stats.losses, 0),
    sourceCounts.losses,
    recent.losses
  );

  const weightedFlats = Math.max(
    safeNumber(stats.flats, 0),
    sourceCounts.flats,
    recent.flats
  );

  const totalR = preferLegacyNonZero(
    stats.totalR,
    sourceTotals.totalR,
    recent.totalR
  );

  const totalPnlPct = preferLegacyNonZero(
    stats.totalPnlPct,
    sourceTotals.totalPnlPct,
    recent.totalPnlPct
  );

  const totalCostR = preferLegacyNonZero(
    stats.totalCostR,
    sourceTotals.totalCostR,
    recent.totalCostR
  );

  const grossWinR = maxPositive(
    stats.grossWinR,
    sourceTotals.grossWinR,
    recent.grossWinR,
    totalR > 0 && weightedLosses <= 0 ? totalR : 0
  );

  const grossLossR = maxPositive(
    stats.grossLossR,
    sourceTotals.grossLossR,
    recent.grossLossR,
    totalR < 0 && weightedWins <= 0 ? Math.abs(totalR) : 0
  );

  const actualCounts = actualOutcomeCounts(stats);
  const winrateSample = safeNumber(actualCounts.completed, 0);
  const winrateWins = safeNumber(actualCounts.wins, 0);
  const winrateFlats = safeNumber(actualCounts.flats, 0);
  const winrateSuccesses = winrateWins + winrateFlats * 0.5;

  const rawWinrate = winrateSample > 0
    ? winrateSuccesses / winrateSample
    : 0;

  const bayes = bayesianWinrate(winrateSuccesses, winrateSample);
  const wilson = wilsonLowerBound(winrateSuccesses, winrateSample);

  const fair = winrateSample > 0
    ? wilson * 0.8 + bayes * 0.15 + rawWinrate * 0.05
    : 0;

  const reliability = sampleReliability(winrateSample);

  const avgR = weightedCompleted > 0
    ? totalR / weightedCompleted
    : 0;

  const avgPnlPct = weightedCompleted > 0
    ? totalPnlPct / weightedCompleted
    : 0;

  const avgWinR = weightedWins > 0
    ? grossWinR / weightedWins
    : 0;

  const avgLossR = weightedLosses > 0
    ? -grossLossR / weightedLosses
    : 0;

  const profitFactor =
    grossLossR > 0 ? grossWinR / grossLossR :
    grossWinR > 0 ? 99 :
    0;

  const directSLPct = weightedCompleted > 0
    ? safeNumber(stats.directSLCount, 0) / weightedCompleted
    : 0;

  const nearTpPct = weightedCompleted > 0
    ? safeNumber(stats.nearTpCount, 0) / weightedCompleted
    : 0;

  const reachedHalfRPct = weightedCompleted > 0
    ? safeNumber(stats.reachedHalfRCount, 0) / weightedCompleted
    : 0;

  const reachedOneRPct = weightedCompleted > 0
    ? safeNumber(stats.reachedOneRCount, 0) / weightedCompleted
    : 0;

  const beWouldExitPct = weightedCompleted > 0
    ? safeNumber(stats.beWouldExitCount, 0) / weightedCompleted
    : 0;

  const gaveBackAfterHalfRPct = weightedCompleted > 0
    ? safeNumber(stats.gaveBackAfterHalfRCount, 0) / weightedCompleted
    : 0;

  const gaveBackAfterOneRPct = weightedCompleted > 0
    ? safeNumber(stats.gaveBackAfterOneRCount, 0) / weightedCompleted
    : 0;

  const nearTpThenLossPct = weightedCompleted > 0
    ? safeNumber(stats.nearTpThenLossCount, 0) / weightedCompleted
    : 0;

  const avgCostR = weightedCompleted > 0
    ? totalCostR / weightedCompleted
    : 0;

  const sampleAdjustedAvgRValue = sampleAdjustedAvgR(avgR, reliability);

  const balancedScore = buildBalancedScore({
    fair,
    avgR,
    totalR,
    sampleRel: reliability,
    profitFactor,
    nearTpPct,
    reachedOneRPct,
    directSLPct,
    nearTpThenLossPct,
    gaveBackAfterOneRPct,
    avgCostR
  });

  const avgRScore = buildAvgRScore({
    sampleAdjustedAvgRValue,
    fair,
    totalR,
    sampleRel: reliability,
    profitFactor,
    nearTpPct,
    reachedOneRPct,
    directSLPct,
    nearTpThenLossPct,
    gaveBackAfterOneRPct,
    avgCostR
  });

  Object.assign(stats, {
    targetTradeSide: TARGET_TRADE_SIDE,
    longOnly: true,
    shortDisabled: true,

    completed: round4(weightedCompleted),
    winrateSample: round4(winrateSample),

    wins: round4(weightedWins),
    losses: round4(weightedLosses),
    flats: round4(weightedFlats),

    totalR: round4(totalR),
    totalPnlPct: round4(totalPnlPct),
    totalCostR: round4(totalCostR),

    realTotalPnlPct: round4(stats.realTotalPnlPct),
    shadowTotalPnlPct: round4(stats.shadowTotalPnlPct),
    realTotalCostR: round4(stats.realTotalCostR),
    shadowTotalCostR: round4(stats.shadowTotalCostR),

    realGrossWinR: round4(stats.realGrossWinR),
    realGrossLossR: round4(stats.realGrossLossR),
    shadowGrossWinR: round4(stats.shadowGrossWinR),
    shadowGrossLossR: round4(stats.shadowGrossLossR),

    grossWinR: round4(grossWinR),
    grossLossR: round4(grossLossR),

    winrate: round4(rawWinrate),
    bayesianWinrate: round4(bayes),
    wilsonLowerBound: round4(wilson),
    fairWinrate: round4(fair),

    sampleRawWinrate: round4(rawWinrate),
    sampleBayesianWinrate: round4(bayes),
    sampleWilsonLowerBound: round4(wilson),
    sampleAdjustedWinrate: round4(fair),
    sampleReliabilityOld: round4(reliability),

    sampleReliability: round4(reliability),

    avgR: round4(avgR),
    avgPnlPct: round4(avgPnlPct),
    avgWinR: round4(avgWinR),
    avgLossR: round4(avgLossR),
    sampleAdjustedAvgR: round4(sampleAdjustedAvgRValue),
    avgRScore: round4(avgRScore),

    profitFactor: round4(profitFactor),

    directSLPct: round4(directSLPct),
    nearTpPct: round4(nearTpPct),
    reachedHalfRPct: round4(reachedHalfRPct),
    reachedOneRPct: round4(reachedOneRPct),

    beWouldExitPct: round4(beWouldExitPct),
    gaveBackAfterHalfRPct: round4(gaveBackAfterHalfRPct),
    gaveBackAfterOneRPct: round4(gaveBackAfterOneRPct),
    nearTpThenLossPct: round4(nearTpThenLossPct),

    avgCostR: round4(avgCostR),
    balancedScore: round4(balancedScore),
    dashboardBalancedScore: round4(balancedScore),

    updatedAt: now()
  });

  delete stats.shortOnly;
  delete stats.longDisabled;

  applySideIdentity(stats);

  return stats;
}

export function normalizeDashboardMicro(row = {}, rank = null) {
  const stats = refreshStats(row);

  const normalized = {
    ...stats,

    sampleRawWinrate: stats.winrate,
    sampleBayesianWinrate: stats.bayesianWinrate,
    sampleWilsonLowerBound: stats.wilsonLowerBound,
    sampleAdjustedWinrate: stats.fairWinrate,
    sampleReliabilityOld: stats.sampleReliability,

    dashboardBalancedScore: stats.balancedScore
  };

  applySideIdentity(normalized);

  if (rank !== null && rank !== undefined) {
    normalized.rank = rank;
  }

  return normalized;
}

export function normalizeDashboardSummary(summary = {}) {
  const out = { ...summary };

  for (const key of ['bestBalanced', 'bestTotalR', 'bestWinrate', 'lowestDirectSL']) {
    if (out[key] && typeof out[key] === 'object' && isTargetSideRow(out[key])) {
      out[key] = normalizeDashboardMicro(out[key]);
    } else {
      out[key] = null;
    }
  }

  return out;
}

function sortById(a, b) {
  return String(a.microFamilyId || '').localeCompare(String(b.microFamilyId || ''));
}

function compareWinrate(a, b) {
  return (
    safeNumber(b.fairWinrate, 0) - safeNumber(a.fairWinrate, 0) ||
    safeNumber(b.wilsonLowerBound, 0) - safeNumber(a.wilsonLowerBound, 0) ||
    safeNumber(b.bayesianWinrate, 0) - safeNumber(a.bayesianWinrate, 0) ||
    safeNumber(b.winrateSample, 0) - safeNumber(a.winrateSample, 0) ||
    safeNumber(b.winrate, 0) - safeNumber(a.winrate, 0) ||
    safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
    safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
    sortById(a, b)
  );
}

function compareAvgR(a, b) {
  return (
    safeNumber(b.avgRScore, 0) - safeNumber(a.avgRScore, 0) ||
    safeNumber(b.sampleAdjustedAvgR, 0) - safeNumber(a.sampleAdjustedAvgR, 0) ||
    safeNumber(b.winrateSample, 0) - safeNumber(a.winrateSample, 0) ||
    safeNumber(b.fairWinrate, 0) - safeNumber(a.fairWinrate, 0) ||
    safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
    safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
    sortById(a, b)
  );
}

function compareBalanced(a, b) {
  return (
    safeNumber(b.balancedScore, 0) - safeNumber(a.balancedScore, 0) ||
    compareWinrate(a, b)
  );
}

export function rankMicros(micros = {}, mode = 'balanced') {
  const rows = Object.values(micros || {})
    .filter(Boolean)
    .filter(isTargetSideRow)
    .map((row) => refreshStats(row))
    .filter((row) => row.tradeSide === TARGET_TRADE_SIDE);

  const sorted = [...rows].sort((a, b) => {
    if (mode === 'winrate') {
      return compareWinrate(a, b);
    }

    if (mode === 'totalR') {
      return (
        safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
        compareWinrate(a, b)
      );
    }

    if (mode === 'avgR') {
      return compareAvgR(a, b);
    }

    if (mode === 'directSL') {
      return (
        safeNumber(a.directSLPct, 0) - safeNumber(b.directSLPct, 0) ||
        safeNumber(b.winrateSample, 0) - safeNumber(a.winrateSample, 0) ||
        compareBalanced(a, b)
      );
    }

    if (mode === 'observed') {
      return (
        safeNumber(b.seen, 0) - safeNumber(a.seen, 0) ||
        safeNumber(b.winrateSample, 0) - safeNumber(a.winrateSample, 0) ||
        compareBalanced(a, b)
      );
    }

    return compareBalanced(a, b);
  });

  return sorted.map((row, index) => normalizeDashboardMicro(row, index + 1));
}