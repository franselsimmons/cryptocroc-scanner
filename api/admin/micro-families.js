// ================= FILE: api/admin/micro-families.js =================

import {
  getIsoWeekKey,
  getPreviousIsoWeekKey,
  sideToTradeSide,
  safeNumber
} from '../../src/utils.js';
import { getWeekMicros } from '../../src/analyze/analyzeEngine.js';
import { getActiveRotation } from '../../src/analyze/rotationEngine.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';

const VALID_MODES = new Set([
  'balanced',
  'winrate',
  'totalR',
  'avgR',
  'directSL',
  'observed'
]);

const WINRATE_Z = 1.96;
const WINRATE_BAYES_ALPHA = 1;
const WINRATE_BAYES_BETA = 1;
const SAMPLE_RELIABILITY_CAP = 50;
const TRADABLE_SAMPLE_MIN = 5;

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 300;

const DEFAULT_SIDE_LIMIT = 25;
const MAX_SIDE_LIMIT = 120;

const DEFAULT_BEST_LIMIT = 25;
const MAX_BEST_LIMIT = 100;

const DEFAULT_RECENT_WEEK_LOOKBACK = 8;
const MAX_RECENT_WEEK_LOOKBACK = 16;

const DEFAULT_MIN_PRIMARY_ROWS_FOR_PREVIOUS_WEEK_MERGE = 25;

const ACTIVE_ROTATION_TIMEOUT_MS = 1_800;
const WEEK_MICROS_TIMEOUT_MS = 9_500;
const FALLBACK_WEEK_TIMEOUT_MS = 6_500;
const RECENT_WEEK_TIMEOUT_MS = 4_500;

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_KEYS = 12;

const cache = globalThis.__ADMIN_MICRO_FAMILIES_LONG_FAST_CACHE__ ||= {
  weekMicros: new Map()
};

function now() {
  return Date.now();
}

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET'],

    targetTradeSide: TARGET_TRADE_SIDE,
    longOnly: true,
    shortDisabled: true
  });
}

function firstQueryValue(value, fallback = null) {
  if (Array.isArray(value)) return value[0] ?? fallback;
  if (value === undefined || value === null || value === '') return fallback;

  return value;
}

function isTrue(value) {
  return (
    value === true ||
    value === 'true' ||
    value === 'TRUE' ||
    value === 1 ||
    value === '1' ||
    value === 'yes' ||
    value === 'YES'
  );
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

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function getArray(value) {
  return Array.isArray(value) ? value : [];
}

function toSafeLimit(value, fallback = DEFAULT_LIMIT, max = MAX_LIMIT) {
  const n = Number(value);

  if (!Number.isFinite(n)) return fallback;
  if (n < 1) return fallback;

  return Math.min(Math.floor(n), max);
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .flatMap((value) => {
        if (Array.isArray(value)) return value;

        return String(value || '')
          .split(/[\s,;\n\r]+/g)
          .map((part) => part.trim());
      })
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function withTimeout(promise, timeoutMs, code = 'TIMEOUT') {
  let timer = null;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(code);
      error.code = code;
      reject(error);
    }, timeoutMs);
  });

  return Promise
    .race([promise, timeoutPromise])
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

function pruneCacheMap(map) {
  const entries = [...map.entries()];

  if (entries.length <= CACHE_MAX_KEYS) return;

  entries
    .sort((a, b) => num(a[1]?.ts, 0) - num(b[1]?.ts, 0))
    .slice(0, Math.max(0, entries.length - CACHE_MAX_KEYS))
    .forEach(([key]) => map.delete(key));
}

function normalizeRequestedTradeSide(value) {
  const raw = upper(value);

  if (['LONG', 'BULL', 'BUY'].includes(raw)) return TARGET_TRADE_SIDE;
  if (['SHORT', 'BEAR', 'SELL'].includes(raw)) return 'SHORT_DISABLED';

  const converted = sideToTradeSide(raw);

  if (converted === 'LONG') return TARGET_TRADE_SIDE;
  if (converted === 'SHORT') return 'SHORT_DISABLED';

  return raw || '';
}

function normalizeSideToken(value) {
  const raw = upper(value);

  if (!raw) return 'UNKNOWN';

  const converted = sideToTradeSide(raw);

  if (converted === 'LONG' || converted === 'SHORT') return converted;

  if (['LONG', 'BULL', 'BULLISH', 'BUY'].includes(raw)) return 'LONG';
  if (['SHORT', 'BEAR', 'BEARISH', 'SELL'].includes(raw)) return 'SHORT';

  return 'UNKNOWN';
}

function getDefinitionParts(row = {}) {
  if (Array.isArray(row.definitionParts)) return row.definitionParts;
  if (Array.isArray(row.microDefinitionParts)) return row.microDefinitionParts;
  if (Array.isArray(row.definition)) return row.definition;

  return [];
}

function getMacroDefinitionParts(row = {}) {
  if (Array.isArray(row.macroDefinitionParts)) return row.macroDefinitionParts;
  if (Array.isArray(row.parentDefinitionParts)) return row.parentDefinitionParts;

  return [];
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
    row.parentMacroFamilyId ||
    row.macroFamilyId ||
    row.parentMicroFamilyId ||
    row.parentFamilyId ||
    row.macroId ||
    row.familyId ||
    null
  );
}

function collectSideText(input = {}) {
  return [
    input.tradeSide,
    input.side,
    input.positionSide,
    input.direction,
    input.signalSide,
    input.scannerSide,
    input.entrySide,
    input.bias,
    input.marketBias,

    input.familyId,
    input.family,
    input.baseFamilyId,

    input.macroFamilyId,
    input.parentMacroFamilyId,
    input.parentMicroFamilyId,
    input.parentFamilyId,
    input.macroId,

    input.microFamilyId,
    input.trueMicroFamilyId,
    input.id,
    input.key,

    input.definition,
    input.microDefinition,
    input.macroDefinition,
    input.parentDefinition,

    ...getArray(input.definitionParts),
    ...getArray(input.microDefinitionParts),
    ...getArray(input.macroDefinitionParts),
    ...getArray(input.parentDefinitionParts)
  ]
    .map((value) => upper(value))
    .filter(Boolean)
    .join(' | ');
}

function hasShortSignal(text = '') {
  const raw = ` ${upper(text)} `;

  return (
    raw.includes('TRADESIDE=SHORT') ||
    raw.includes('TRADE_SIDE=SHORT') ||
    raw.includes('SIDE=SHORT') ||
    raw.includes('DIRECTION=SHORT') ||
    raw.includes('POSITION_SIDE=SHORT') ||
    raw.includes('POSITIONSIDE=SHORT') ||
    raw.includes('SIDE=BEAR') ||
    raw.includes('DIRECTION=BEAR') ||
    raw.includes('SIDE=SELL') ||
    raw.includes('DIRECTION=SELL') ||

    raw.includes('MICRO_SHORT_') ||
    raw.includes('SHORT_') ||
    raw.includes('_SHORT') ||
    raw.includes('|SHORT|') ||
    raw.includes(':SHORT') ||
    raw.includes('=SHORT') ||

    raw.includes(' BEAR ') ||
    raw.includes('_BEAR') ||
    raw.includes('BEAR_') ||
    raw.includes('|BEAR|') ||
    raw.includes(':BEAR') ||
    raw.includes('=BEAR') ||

    raw.includes(' SELL ') ||
    raw.includes('_SELL') ||
    raw.includes('SELL_') ||
    raw.includes('|SELL|') ||
    raw.includes(':SELL') ||
    raw.includes('=SELL')
  );
}

function hasLongSignal(text = '') {
  const raw = ` ${upper(text)} `;

  return (
    raw.includes('TRADESIDE=LONG') ||
    raw.includes('TRADE_SIDE=LONG') ||
    raw.includes('SIDE=LONG') ||
    raw.includes('DIRECTION=LONG') ||
    raw.includes('POSITION_SIDE=LONG') ||
    raw.includes('POSITIONSIDE=LONG') ||
    raw.includes('SIDE=BULL') ||
    raw.includes('DIRECTION=BULL') ||
    raw.includes('SIDE=BUY') ||
    raw.includes('DIRECTION=BUY') ||

    raw.includes('MICRO_LONG_') ||
    raw.includes('LONG_') ||
    raw.includes('_LONG') ||
    raw.includes('|LONG|') ||
    raw.includes(':LONG') ||
    raw.includes('=LONG') ||

    raw.includes(' BULL ') ||
    raw.includes('_BULL') ||
    raw.includes('BULL_') ||
    raw.includes('|BULL|') ||
    raw.includes(':BULL') ||
    raw.includes('=BULL') ||

    raw.includes(' BUY ') ||
    raw.includes('_BUY') ||
    raw.includes('BUY_') ||
    raw.includes('|BUY|') ||
    raw.includes(':BUY') ||
    raw.includes('=BUY')
  );
}

function inferTradeSide(input = {}) {
  const directSources = [
    input.tradeSide,
    input.side,
    input.positionSide,
    input.direction,
    input.signalSide,
    input.scannerSide,
    input.entrySide,
    input.bias,
    input.marketBias
  ];

  for (const source of directSources) {
    const normalized = normalizeSideToken(source);

    if (normalized === 'LONG' || normalized === 'SHORT') return normalized;
  }

  const familyId = upper(input.familyId || input.family || input.baseFamilyId);
  const macroFamilyId = upper(
    input.parentMacroFamilyId ||
    input.macroFamilyId ||
    input.parentMicroFamilyId ||
    input.parentFamilyId ||
    input.macroId
  );
  const microFamilyId = upper(
    input.microFamilyId ||
    input.trueMicroFamilyId ||
    input.id ||
    input.key
  );

  if (familyId.startsWith('LONG_')) return 'LONG';
  if (familyId.startsWith('SHORT_')) return 'SHORT';

  if (macroFamilyId.includes('MICRO_LONG_') || macroFamilyId.startsWith('LONG_')) return 'LONG';
  if (macroFamilyId.includes('MICRO_SHORT_') || macroFamilyId.startsWith('SHORT_')) return 'SHORT';

  if (microFamilyId.includes('MICRO_LONG_')) return 'LONG';
  if (microFamilyId.includes('MICRO_SHORT_')) return 'SHORT';

  const text = collectSideText(input);
  const longSignal = hasLongSignal(text);
  const shortSignal = hasShortSignal(text);

  if (longSignal && !shortSignal) return 'LONG';
  if (shortSignal && !longSignal) return 'SHORT';

  if (microFamilyId.includes('LONG')) return 'LONG';
  if (microFamilyId.includes('SHORT')) return 'SHORT';

  if (macroFamilyId.includes('LONG')) return 'LONG';
  if (macroFamilyId.includes('SHORT')) return 'SHORT';

  return 'UNKNOWN';
}

function dashboardSideFromTradeSide(tradeSide) {
  if (tradeSide === 'LONG') return 'bull';
  if (tradeSide === 'SHORT') return 'bear';

  return 'unknown';
}

function isTargetRow(row = {}) {
  return inferTradeSide(row) !== 'SHORT';
}

function sourceEntriesFromMicros(micros = {}) {
  if (Array.isArray(micros)) {
    return micros.map((row, index) => [
      row?.microFamilyId || row?.trueMicroFamilyId || row?.id || row?.key || String(index),
      row
    ]);
  }

  if (!micros || typeof micros !== 'object') return [];

  return Object.entries(micros);
}

function hasMicros(micros = {}) {
  return sourceEntriesFromMicros(micros).length > 0;
}

function microsCount(micros = {}) {
  return sourceEntriesFromMicros(micros).length;
}

function parseIsoWeekKey(weekKey = '') {
  const match = String(weekKey || '').match(/^(\d{4})-W(\d{1,2})$/i);

  if (!match) return null;

  return {
    year: Number(match[1]),
    week: Number(match[2])
  };
}

function weeksInIsoYear(year) {
  const date = new Date(Date.UTC(year, 11, 28));
  const day = date.getUTCDay() || 7;

  date.setUTCDate(date.getUTCDate() + 4 - day);

  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));

  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}

function previousIsoWeekKeyFrom(weekKey = '') {
  const parsed = parseIsoWeekKey(weekKey);

  if (!parsed) return getPreviousIsoWeekKey();

  let { year, week } = parsed;

  week -= 1;

  if (week >= 1) {
    return `${year}-W${String(week).padStart(2, '0')}`;
  }

  year -= 1;
  week = weeksInIsoYear(year);

  return `${year}-W${String(week).padStart(2, '0')}`;
}

function recentIsoWeekKeys(startWeekKey, count = DEFAULT_RECENT_WEEK_LOOKBACK) {
  const keys = [];
  let cursor = String(startWeekKey || getIsoWeekKey()).trim();

  for (let index = 0; index < count; index += 1) {
    if (!cursor || keys.includes(cursor)) break;

    keys.push(cursor);
    cursor = previousIsoWeekKeyFrom(cursor);
  }

  return keys;
}

function mergeMicros(primaryMicros = {}, fallbackMicros = {}) {
  const merged = {};

  for (const [key, row] of sourceEntriesFromMicros(fallbackMicros)) {
    if (!key || !row) continue;

    const id = row?.microFamilyId || row?.trueMicroFamilyId || row?.id || row?.key || key;
    if (!id) continue;

    merged[id] = {
      ...row,
      microFamilyId: id,
      sourceWeekFallback: true
    };
  }

  for (const [key, row] of sourceEntriesFromMicros(primaryMicros)) {
    if (!key || !row) continue;

    const id = row?.microFamilyId || row?.trueMicroFamilyId || row?.id || row?.key || key;
    if (!id) continue;

    merged[id] = {
      ...row,
      microFamilyId: id,
      sourceWeekPrimary: true
    };
  }

  return merged;
}

function mergeMicrosByRecency(weekResults = []) {
  const merged = {};

  for (const result of [...weekResults].reverse()) {
    const weekKey = result?.weekKey || null;
    const isPrimary = weekKey === weekResults[0]?.weekKey;

    for (const [key, row] of sourceEntriesFromMicros(result?.micros || {})) {
      if (!key || !row) continue;

      const id = row?.microFamilyId || row?.trueMicroFamilyId || row?.id || row?.key || key;
      if (!id) continue;

      merged[id] = {
        ...row,
        microFamilyId: id,
        sourceWeekKey: weekKey,
        sourceWeekPrimary: Boolean(isPrimary),
        sourceWeekFallback: !isPrimary
      };
    }
  }

  return merged;
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

function getDashboardBalancedScore(row = {}, winrateMeta = null) {
  const meta = winrateMeta || getSampleAdjustedWinrate(row);

  const totalR = Math.max(0, num(row.totalR, 0));
  const avgR = Math.max(0, num(row.avgR, 0));
  const profitFactor = Math.min(Math.max(0, num(row.profitFactor, 0)), 20);

  const directSLPct = clamp(row.directSLPct, 0, 1);
  const nearTpThenLossPct = clamp(row.nearTpThenLossPct, 0, 1);
  const gaveBackAfterOneRPct = clamp(row.gaveBackAfterOneRPct, 0, 1);
  const avgCostR = Math.max(0, num(row.avgCostR, 0));

  const winrateComponent = meta.score * 100;
  const reliabilityComponent = meta.reliability * 20;
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

function buildRawMicroRow(row = {}, key = '', index = 0, forcedTradeSide = null) {
  const microFamilyId = row.microFamilyId || row.trueMicroFamilyId || row.id || row.key || key || null;
  const familyId = getFamilyId(row);

  const macroFamilyId = getMacroFamilyId({
    ...row,
    microFamilyId,
    familyId
  });

  const definitionParts = getDefinitionParts(row);
  const macroDefinitionParts = getMacroDefinitionParts(row);

  const inferredTradeSide = inferTradeSide({
    ...row,
    microFamilyId,
    familyId,
    macroFamilyId,
    definitionParts,
    macroDefinitionParts
  });

  const tradeSide = forcedTradeSide || inferredTradeSide;

  return {
    sourceIndex: index,

    microFamilyId,
    trueMicroFamilyId: microFamilyId,
    familyId,
    macroFamilyId,

    parentMacroFamilyId: row.parentMacroFamilyId || macroFamilyId || null,
    parentMicroFamilyId: row.parentMicroFamilyId || macroFamilyId || null,

    side: dashboardSideFromTradeSide(tradeSide),
    tradeSide,

    inferredTradeSide,
    inferredFromShortOnlyMode: false,
    inferredFromLongOnlyMode: Boolean(row.inferredFromLongOnlyMode),

    sourceWeekKey: row.sourceWeekKey || null,
    sourceWeekPrimary: Boolean(row.sourceWeekPrimary),
    sourceWeekFallback: Boolean(row.sourceWeekFallback),

    seen: num(row.seen ?? row.observations, 0),
    observations: num(row.observations ?? row.seen, 0),

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

    totalR: round(row.totalR, 4),
    realTotalR: round(row.realTotalR, 4),
    shadowTotalR: round(row.shadowTotalR, 4),

    avgR: round(row.avgR, 4),
    avgWinR: round(row.avgWinR, 4),
    avgLossR: round(row.avgLossR, 4),

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

    balancedScore: round(row.balancedScore, 4),

    definition: row.definition || row.microDefinition || null,
    definitionParts,

    macroDefinition: row.macroDefinition || row.parentDefinition || null,
    macroDefinitionParts,

    microDefinition: row.microDefinition || row.definition || null,
    microDefinitionParts: Array.isArray(row.microDefinitionParts)
      ? row.microDefinitionParts
      : definitionParts,

    assetClass: row.assetClass || null,
    rsiZone: row.rsiZone || null,
    rsiCoarse: row.rsiCoarse || null,
    flow: row.flow || null,
    flowCoarse: row.flowCoarse || null,
    obRelation: row.obRelation || null,
    btcState: row.btcState || null,
    btcRelation: row.btcRelation || null,
    regime: row.regime || null,
    regimeCoarse: row.regimeCoarse || null,
    scannerReason: row.scannerReason || null,
    scannerReasonCoarse: row.scannerReasonCoarse || null,

    selectedTier: row.selectedTier || row.rotationEligibilityTier || row.eligibilityTier || null,
    rotationEligibilityTier: row.rotationEligibilityTier || row.selectedTier || row.eligibilityTier || null,

    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };
}

function decorateMicroRow(row = {}) {
  const winrate = getSampleAdjustedWinrate(row);
  const dashboardBalancedScore = getDashboardBalancedScore(row, winrate);

  return {
    ...row,

    winrateSample: round(row.winrateSample ?? winrate.sample, 4),
    sampleAdjustedWinrate: round(row.sampleAdjustedWinrate ?? winrate.score, 4),
    sampleRawWinrate: round(row.sampleRawWinrate ?? winrate.rawWinrate, 4),
    sampleBayesianWinrate: round(row.sampleBayesianWinrate ?? winrate.bayesianWinrate, 4),
    sampleWilsonLowerBound: round(row.sampleWilsonLowerBound ?? winrate.wilsonLowerBound, 4),
    sampleReliability: round(row.sampleReliability ?? winrate.reliability, 4),

    fairWinrate: round(
      row.fairWinrate ??
      row.sampleAdjustedWinrate ??
      winrate.score ??
      row.bayesianWinrate ??
      row.wilsonLowerBound,
      4
    ),

    dashboardBalancedScore: round(row.dashboardBalancedScore ?? dashboardBalancedScore, 4)
  };
}

function buildRowsFromMicros(micros = {}) {
  return sourceEntriesFromMicros(micros)
    .map(([key, row], index) => {
      const baseRow = {
        ...(row || {}),
        key,
        microFamilyId: row?.microFamilyId || row?.trueMicroFamilyId || row?.id || row?.key || key
      };

      const inferredTradeSide = inferTradeSide(baseRow);

      if (inferredTradeSide === 'SHORT') return null;

      return decorateMicroRow(
        buildRawMicroRow({
          ...baseRow,
          tradeSide: TARGET_TRADE_SIDE,
          side: TARGET_DASHBOARD_SIDE,
          inferredFromLongOnlyMode: inferredTradeSide === 'UNKNOWN'
        }, key, index, TARGET_TRADE_SIDE)
      );
    })
    .filter((row) => row?.microFamilyId);
}

function rowKey(row = {}) {
  return String(
    row.microFamilyId ||
    row.trueMicroFamilyId ||
    row.id ||
    row.key ||
    ''
  ).trim();
}

function mergeRows(primaryRows = [], fallbackRows = []) {
  const byKey = new Map();

  for (const row of primaryRows) {
    const key = rowKey(row);
    if (!key) continue;

    byKey.set(key, row);
  }

  for (const fallback of fallbackRows) {
    const key = rowKey(fallback);
    if (!key) continue;

    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, fallback);
      continue;
    }

    if (
      existing.tradeSide === 'UNKNOWN' &&
      (fallback.tradeSide === 'LONG' || fallback.tradeSide === 'SHORT')
    ) {
      byKey.set(key, {
        ...existing,
        tradeSide: fallback.tradeSide,
        side: dashboardSideFromTradeSide(fallback.tradeSide),
        selectedTier: existing.selectedTier || fallback.selectedTier,
        rotationEligibilityTier: existing.rotationEligibilityTier || fallback.rotationEligibilityTier
      });
    }
  }

  return [...byKey.values()];
}

function manualRowFromId(id, index = 0, forcedTradeSide = null) {
  const text = upper(id);
  const tradeSide = forcedTradeSide ||
    (text.includes('LONG')
      ? 'LONG'
      : text.includes('SHORT')
        ? 'SHORT'
        : 'LONG');

  if (tradeSide === 'SHORT') return null;

  return decorateMicroRow(
    buildRawMicroRow({
      microFamilyId: id,
      trueMicroFamilyId: id,
      familyId: null,
      macroFamilyId: null,
      seen: 0,
      observations: 0,
      completed: 0,
      winrateSample: 0,
      winrate: 0,
      totalR: 0,
      avgR: 0,
      profitFactor: 0,
      directSLPct: 0,
      avgCostR: 0,
      selectedTier: 'ACTIVE_FALLBACK',
      rotationEligibilityTier: 'ACTIVE_FALLBACK'
    }, id, index, tradeSide)
  );
}

function extractActiveIds(activeRotation) {
  if (!activeRotation) return [];

  const ids = [
    ...(Array.isArray(activeRotation.microFamilyIds) ? activeRotation.microFamilyIds : []),
    ...(Array.isArray(activeRotation.activeMicroFamilyIds) ? activeRotation.activeMicroFamilyIds : []),
    ...(Array.isArray(activeRotation.trueMicroFamilyIds) ? activeRotation.trueMicroFamilyIds : []),
    ...(Array.isArray(activeRotation.ids) ? activeRotation.ids : []),
    ...(Array.isArray(activeRotation.microFamilies)
      ? activeRotation.microFamilies.map((row) => row.microFamilyId || row.trueMicroFamilyId || row.id || row.key)
      : [])
  ];

  return uniqueStrings(ids).filter((id) => !upper(id).includes('SHORT'));
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

  return uniqueStrings(ids).filter((id) => !upper(id).includes('SHORT'));
}

function buildRowsFromActiveRotation(activeRotation) {
  if (!activeRotation) return [];

  const rows = [];

  if (Array.isArray(activeRotation.microFamilies)) {
    rows.push(
      ...activeRotation.microFamilies
        .map((row, index) => {
          const inferredTradeSide = inferTradeSide(row);
          if (inferredTradeSide === 'SHORT') return null;

          return decorateMicroRow(
            buildRawMicroRow({
              ...row,
              tradeSide: TARGET_TRADE_SIDE,
              side: TARGET_DASHBOARD_SIDE,
              selectedTier: row.selectedTier || row.rotationEligibilityTier || activeRotation.selectedTier || 'ACTIVE',
              inferredFromLongOnlyMode: inferredTradeSide === 'UNKNOWN'
            }, row?.microFamilyId || row?.trueMicroFamilyId || row?.id || row?.key || `active_${index}`, index, TARGET_TRADE_SIDE)
          );
        })
        .filter(Boolean)
    );
  }

  if (activeRotation.bestLong) {
    rows.push(decorateMicroRow(
      buildRawMicroRow({
        ...activeRotation.bestLong,
        tradeSide: TARGET_TRADE_SIDE,
        side: TARGET_DASHBOARD_SIDE,
        selectedTier: activeRotation.bestLong.selectedTier || activeRotation.selectedTier || 'ACTIVE_BEST'
      }, activeRotation.bestLong.microFamilyId || activeRotation.bestLong.trueMicroFamilyId || 'bestLong', rows.length, TARGET_TRADE_SIDE)
    ));
  }

  if (activeRotation.selectedRow) {
    const inferredTradeSide = inferTradeSide(activeRotation.selectedRow);

    if (inferredTradeSide !== 'SHORT') {
      rows.push(decorateMicroRow(
        buildRawMicroRow({
          ...activeRotation.selectedRow,
          tradeSide: TARGET_TRADE_SIDE,
          side: TARGET_DASHBOARD_SIDE,
          selectedTier: activeRotation.selectedRow.selectedTier || activeRotation.selectedTier || 'ACTIVE_SELECTED',
          inferredFromLongOnlyMode: inferredTradeSide === 'UNKNOWN'
        }, activeRotation.selectedRow.microFamilyId || activeRotation.selectedRow.trueMicroFamilyId || 'selectedRow', rows.length, TARGET_TRADE_SIDE)
      ));
    }
  }

  const existing = new Set(rows.map(rowKey).filter(Boolean));

  for (const id of extractActiveIds(activeRotation)) {
    if (existing.has(id)) continue;
    if (upper(id).includes('SHORT')) continue;

    const manual = manualRowFromId(id, rows.length, TARGET_TRADE_SIDE);
    if (!manual) continue;

    rows.push(manual);
    existing.add(id);
  }

  return mergeRows([], rows);
}

function normalizeMicroRow(
  row = {},
  index = 0,
  {
    activeSet = new Set(),
    activeMacroSet = new Set(),
    compact = true
  } = {}
) {
  const microFamilyId = row.microFamilyId || row.trueMicroFamilyId || row.id || row.key || null;
  const familyId = getFamilyId(row);
  const macroFamilyId = getMacroFamilyId(row);
  const inferredTradeSide = inferTradeSide(row);
  const tradeSide = inferredTradeSide === 'SHORT' ? 'SHORT' : TARGET_TRADE_SIDE;

  const active = microFamilyId
    ? activeSet.has(microFamilyId)
    : false;

  const macroActive = macroFamilyId
    ? activeMacroSet.has(macroFamilyId)
    : false;

  const base = {
    rank: index + 1,

    microFamilyId,
    trueMicroFamilyId: microFamilyId,
    familyId,
    macroFamilyId,

    parentMacroFamilyId: row.parentMacroFamilyId || macroFamilyId || null,
    parentMicroFamilyId: row.parentMicroFamilyId || macroFamilyId || null,

    side: dashboardSideFromTradeSide(tradeSide),
    tradeSide,

    inferredTradeSide: row.inferredTradeSide || inferredTradeSide,
    inferredFromShortOnlyMode: false,
    inferredFromLongOnlyMode: Boolean(row.inferredFromLongOnlyMode || inferredTradeSide === 'UNKNOWN'),

    sourceWeekKey: row.sourceWeekKey || null,
    sourceWeekPrimary: Boolean(row.sourceWeekPrimary),
    sourceWeekFallback: Boolean(row.sourceWeekFallback),

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
    fairWinrate: round(row.fairWinrate, 4),

    winrateSample: round(row.winrateSample, 4),
    sampleAdjustedWinrate: round(row.sampleAdjustedWinrate, 4),
    sampleRawWinrate: round(row.sampleRawWinrate, 4),
    sampleBayesianWinrate: round(row.sampleBayesianWinrate, 4),
    sampleWilsonLowerBound: round(row.sampleWilsonLowerBound, 4),
    sampleReliability: round(row.sampleReliability, 4),

    totalR: round(row.totalR, 4),
    realTotalR: round(row.realTotalR, 4),
    shadowTotalR: round(row.shadowTotalR, 4),

    avgR: round(row.avgR, 4),
    avgWinR: round(row.avgWinR, 4),
    avgLossR: round(row.avgLossR, 4),

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

    balancedScore: round(row.balancedScore, 4),
    dashboardBalancedScore: round(row.dashboardBalancedScore, 4),

    definition: row.definition || null,
    definitionParts: getDefinitionParts(row),

    macroDefinition: row.macroDefinition || row.parentDefinition || null,
    macroDefinitionParts: getMacroDefinitionParts(row),

    microDefinition: row.microDefinition || row.definition || null,
    microDefinitionParts: Array.isArray(row.microDefinitionParts)
      ? row.microDefinitionParts
      : getDefinitionParts(row),

    assetClass: row.assetClass || null,
    rsiZone: row.rsiZone || null,
    rsiCoarse: row.rsiCoarse || null,
    flow: row.flow || null,
    flowCoarse: row.flowCoarse || null,
    obRelation: row.obRelation || null,
    btcState: row.btcState || null,
    btcRelation: row.btcRelation || null,
    regime: row.regime || null,
    regimeCoarse: row.regimeCoarse || null,
    scannerReason: row.scannerReason || null,
    scannerReasonCoarse: row.scannerReasonCoarse || null,

    selectedTier: row.selectedTier || row.rotationEligibilityTier || row.eligibilityTier || null,
    rotationEligibilityTier: row.rotationEligibilityTier || row.selectedTier || row.eligibilityTier || null,

    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };

  if (compact) return base;

  return {
    ...row,
    ...base,

    realTotalPnlPct: round(row.realTotalPnlPct, 4),
    shadowTotalPnlPct: round(row.shadowTotalPnlPct, 4),
    grossWinR: round(row.grossWinR, 4),
    grossLossR: round(row.grossLossR, 4),
    realGrossWinR: round(row.realGrossWinR, 4),
    realGrossLossR: round(row.realGrossLossR, 4),
    shadowGrossWinR: round(row.shadowGrossWinR, 4),
    shadowGrossLossR: round(row.shadowGrossLossR, 4),
    totalPnlPct: round(row.totalPnlPct, 4),
    avgPnlPct: round(row.avgPnlPct, 4),
    realTotalCostR: round(row.realTotalCostR, 4),
    shadowTotalCostR: round(row.shadowTotalCostR, 4),

    counters: row.counters || {},
    examples: Array.isArray(row.examples) ? row.examples.slice(-8) : [],
    recentOutcomes: Array.isArray(row.recentOutcomes) ? row.recentOutcomes.slice(-8) : []
  };
}

function compactBestRow(row) {
  if (!row) return null;

  const inferredTradeSide = inferTradeSide(row);
  const tradeSide = inferredTradeSide === 'SHORT' ? 'SHORT' : TARGET_TRADE_SIDE;

  if (tradeSide === 'SHORT') return null;

  return {
    microFamilyId: row.microFamilyId || row.trueMicroFamilyId || row.id || row.key || null,
    trueMicroFamilyId: row.microFamilyId || row.trueMicroFamilyId || row.id || row.key || null,
    familyId: getFamilyId(row),
    macroFamilyId: getMacroFamilyId(row),

    side: dashboardSideFromTradeSide(tradeSide),
    tradeSide,

    inferredTradeSide: row.inferredTradeSide || inferredTradeSide,
    inferredFromShortOnlyMode: false,
    inferredFromLongOnlyMode: Boolean(row.inferredFromLongOnlyMode || inferredTradeSide === 'UNKNOWN'),

    active: Boolean(row.active),
    macroActive: Boolean(row.macroActive),

    seen: num(row.seen, 0),
    observations: num(row.observations, 0),
    completed: round(row.completed, 4),
    realCompleted: num(row.realCompleted, 0),
    shadowCompleted: num(row.shadowCompleted, 0),

    winrateSample: round(row.winrateSample, 4),
    winrate: round(row.winrate, 4),
    fairWinrate: round(row.fairWinrate, 4),
    sampleAdjustedWinrate: round(row.sampleAdjustedWinrate, 4),
    sampleWilsonLowerBound: round(row.sampleWilsonLowerBound, 4),
    sampleReliability: round(row.sampleReliability, 4),

    avgR: round(row.avgR, 4),
    totalR: round(row.totalR, 4),
    profitFactor: round(row.profitFactor, 4),

    directSLPct: round(row.directSLPct, 4),
    avgCostR: round(row.avgCostR, 4),

    balancedScore: round(row.balancedScore, 4),
    dashboardBalancedScore: round(row.dashboardBalancedScore, 4),

    selectedTier: row.selectedTier || row.rotationEligibilityTier || row.eligibilityTier || null,
    rotationEligibilityTier: row.rotationEligibilityTier || row.selectedTier || row.eligibilityTier || null
  };
}

function compactActiveRotation(activeRotation) {
  if (!activeRotation) return null;

  const activeMicroFamilyIds = extractActiveIds(activeRotation);
  const activeMacroFamilyIds = extractActiveMacroIds(activeRotation);

  return {
    rotationId: activeRotation.rotationId || null,
    source: activeRotation.source || null,
    mode: activeRotation.mode || null,
    sourceWeekKey: activeRotation.sourceWeekKey || null,
    activeWeekKey: activeRotation.activeWeekKey || null,
    generatedAt: activeRotation.generatedAt || null,
    activatedAt: activeRotation.activatedAt || null,

    trueMicroOnly: activeRotation.trueMicroOnly !== false,
    usedLegacyFallback: Boolean(activeRotation.usedLegacyFallback),
    usedSoftFallback: Boolean(activeRotation.usedSoftFallback),
    usedObservationFallback: Boolean(activeRotation.usedObservationFallback),

    selectedTier: activeRotation.selectedTier || null,
    missingSides: Array.isArray(activeRotation.missingSides)
      ? activeRotation.missingSides
      : [],

    microFamilyIds: activeMicroFamilyIds,
    activeMicroFamilyIds,
    trueMicroFamilyIds: activeMicroFamilyIds,

    macroFamilyIds: activeMacroFamilyIds,
    activeMacroFamilyIds,

    bestShort: null,

    bestLong: activeRotation.bestLong
      ? compactBestRow(activeRotation.bestLong)
      : null
  };
}

function parseFilters(req) {
  const side = normalizeRequestedTradeSide(firstQueryValue(req.query?.side, ''));
  const familyId = String(firstQueryValue(req.query?.familyId, '') || '').trim();
  const macroFamilyId = String(firstQueryValue(req.query?.macroFamilyId, '') || '').trim();
  const q = String(firstQueryValue(req.query?.q, '') || '').trim().toUpperCase();

  return {
    side,
    familyId,
    macroFamilyId,
    q,

    activeOnly: isTrue(firstQueryValue(req.query?.activeOnly, false)),
    macroActiveOnly: isTrue(firstQueryValue(req.query?.macroActiveOnly, false)),

    minCompleted: num(firstQueryValue(req.query?.minCompleted, 0), 0),
    minSample: num(firstQueryValue(req.query?.minSample, 0), 0),
    minSeen: num(firstQueryValue(req.query?.minSeen, 0), 0)
  };
}

function hasNarrowFilters(filters = {}) {
  return Boolean(
    filters.side === 'SHORT_DISABLED' ||
    filters.familyId ||
    filters.macroFamilyId ||
    filters.q ||
    filters.activeOnly ||
    filters.macroActiveOnly ||
    filters.minCompleted > 0 ||
    filters.minSample > 0 ||
    filters.minSeen > 0
  );
}

function rowMatchesSearch(row = {}, q = '') {
  if (!q) return true;

  const haystack = [
    row.microFamilyId,
    row.trueMicroFamilyId,
    row.id,
    row.key,
    row.familyId,
    row.family,
    row.macroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId,
    row.parentFamilyId,
    row.definition,
    row.microDefinition,
    row.macroDefinition,
    row.parentDefinition,
    ...getArray(row.definitionParts),
    ...getArray(row.microDefinitionParts),
    ...getArray(row.macroDefinitionParts),
    ...getArray(row.parentDefinitionParts)
  ]
    .map((value) => upper(value))
    .join(' | ');

  return haystack.includes(q);
}

function rowPassesFilters(row = {}, filters, activeSet, activeMacroSet) {
  const tradeSide = inferTradeSide(row);

  if (tradeSide === 'SHORT') return false;
  if (filters.side === 'SHORT_DISABLED') return false;
  if (filters.side && filters.side !== TARGET_TRADE_SIDE) return false;

  if (filters.familyId && String(row.familyId || '') !== filters.familyId) {
    return false;
  }

  if (
    filters.macroFamilyId &&
    String(getMacroFamilyId(row) || '') !== filters.macroFamilyId
  ) {
    return false;
  }

  if (filters.activeOnly && !activeSet.has(row.microFamilyId)) {
    return false;
  }

  if (filters.macroActiveOnly && !activeMacroSet.has(getMacroFamilyId(row))) {
    return false;
  }

  if (filters.minCompleted > 0 && num(row.completed, 0) < filters.minCompleted) {
    return false;
  }

  if (filters.minSample > 0 && num(row.winrateSample, 0) < filters.minSample) {
    return false;
  }

  if (filters.minSeen > 0 && num(row.seen, 0) < filters.minSeen) {
    return false;
  }

  if (!rowMatchesSearch(row, filters.q)) {
    return false;
  }

  return true;
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

function compareRowsWinrate(a, b) {
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

function compareRowsBalanced(a, b) {
  return (
    compareNumberDesc(a.dashboardBalancedScore, b.dashboardBalancedScore) ||
    compareRowsWinrate(a, b)
  );
}

function compareRowsTotalR(a, b) {
  return (
    compareNumberDesc(a.totalR, b.totalR) ||
    compareRowsWinrate(a, b)
  );
}

function compareRowsAvgR(a, b) {
  return (
    compareNumberDesc(a.avgR, b.avgR) ||
    compareRowsWinrate(a, b)
  );
}

function compareRowsDirectSL(a, b) {
  return (
    compareNumberAsc(a.directSLPct, b.directSLPct) ||
    compareNumberDesc(a.winrateSample, b.winrateSample) ||
    compareRowsWinrate(a, b)
  );
}

function compareRowsObserved(a, b) {
  return (
    compareNumberDesc(a.winrateSample, b.winrateSample) ||
    compareNumberDesc(a.completed, b.completed) ||
    compareNumberDesc(a.seen, b.seen) ||
    compareNumberDesc(a.observations, b.observations) ||
    compareRowsWinrate(a, b)
  );
}

function compareRowsByMode(a, b, mode = 'balanced') {
  if (mode === 'winrate') return compareRowsWinrate(a, b);
  if (mode === 'totalR') return compareRowsTotalR(a, b);
  if (mode === 'avgR') return compareRowsAvgR(a, b);
  if (mode === 'directSL') return compareRowsDirectSL(a, b);
  if (mode === 'observed') return compareRowsObserved(a, b);

  return compareRowsBalanced(a, b);
}

function sortRowsByMode(rows = [], mode = 'balanced') {
  return [...rows].sort((a, b) => compareRowsByMode(a, b, mode));
}

function sideCounts(rows = []) {
  return rows.reduce(
    (acc, row) => {
      const side = inferTradeSide(row);

      if (side === 'SHORT') acc.short += 1;
      else if (side === 'LONG') acc.long += 1;
      else {
        acc.unknown += 1;
        acc.long += 1;
      }

      return acc;
    },
    {
      long: 0,
      short: 0,
      unknown: 0
    }
  );
}

function bestBy(rows = [], comparator) {
  return [...rows].sort(comparator)[0] || null;
}

function buildSideSummary(rows = [], side) {
  const sideRows = side === TARGET_TRADE_SIDE
    ? rows.filter((row) => inferTradeSide(row) !== 'SHORT')
    : [];

  return {
    rows: sideRows.length,
    bestBalanced: compactBestRow(bestBy(sideRows, compareRowsBalanced)),
    bestWinrate: compactBestRow(bestBy(sideRows, compareRowsWinrate)),
    bestTotalR: compactBestRow(bestBy(sideRows, compareRowsTotalR)),
    bestAvgR: compactBestRow(bestBy(sideRows, compareRowsAvgR)),
    lowestDirectSL: compactBestRow(bestBy(sideRows, compareRowsDirectSL))
  };
}

function buildSummary(rows = [], activeSet = new Set()) {
  const completedRows = rows.filter((row) => num(row.completed, 0) > 0);
  const tradableRows = rows.filter((row) => num(row.winrateSample, 0) >= TRADABLE_SAMPLE_MIN);
  const activeRows = rows.filter((row) => activeSet.has(row.microFamilyId || row.trueMicroFamilyId || row.id || row.key));

  let totalR = 0;
  let totalSeen = 0;
  let totalCompleted = 0;
  let totalWinrateSample = 0;
  let totalCostR = 0;

  for (const row of rows) {
    totalR += num(row.totalR, 0);
    totalSeen += num(row.seen, 0);
    totalCompleted += num(row.completed, 0);
    totalWinrateSample += num(row.winrateSample, 0);
    totalCostR += num(row.totalCostR, 0);
  }

  return {
    rows: rows.length,
    activeRows: activeRows.length,
    activeIds: activeSet.size,

    seen: round(totalSeen, 4),
    completed: round(totalCompleted, 4),
    winrateSample: round(totalWinrateSample, 4),

    completedMicroFamilies: completedRows.length,
    tradableMicroFamilies: tradableRows.length,

    totalR: round(totalR, 4),
    totalCostR: round(totalCostR, 4),
    avgR: totalCompleted > 0 ? round(totalR / totalCompleted, 4) : 0,
    avgCostR: totalCompleted > 0 ? round(totalCostR / totalCompleted, 4) : 0,

    bestBalanced: compactBestRow(bestBy(rows, compareRowsBalanced)),
    bestTotalR: compactBestRow(bestBy(rows, compareRowsTotalR)),
    bestAvgR: compactBestRow(bestBy(rows, compareRowsAvgR)),
    bestWinrate: compactBestRow(bestBy(rows, compareRowsWinrate)),
    lowestDirectSL: compactBestRow(bestBy(rows, compareRowsDirectSL)),

    short: buildSideSummary(rows, 'SHORT'),
    long: buildSideSummary(rows, TARGET_TRADE_SIDE)
  };
}

async function getActiveRotationSafe() {
  try {
    return await withTimeout(
      getActiveRotation(),
      ACTIVE_ROTATION_TIMEOUT_MS,
      'GET_ACTIVE_ROTATION_TIMEOUT'
    );
  } catch {
    return null;
  }
}

function getCachedWeekMicros(weekKey) {
  const cached = cache.weekMicros.get(weekKey);

  if (!cached) return null;
  if (now() - cached.ts > CACHE_TTL_MS) return null;

  return cached.micros || {};
}

async function getWeekMicrosCached(weekKey, timeoutMs) {
  const cached = getCachedWeekMicros(weekKey);

  if (cached) {
    return {
      weekKey,
      micros: cached,
      cacheHit: true,
      stale: false,
      warning: null
    };
  }

  try {
    const micros = await withTimeout(
      getWeekMicros(weekKey),
      timeoutMs,
      `GET_WEEK_MICROS_TIMEOUT_${weekKey}`
    );

    cache.weekMicros.set(weekKey, {
      ts: now(),
      micros: micros || {}
    });

    pruneCacheMap(cache.weekMicros);

    return {
      weekKey,
      micros: micros || {},
      cacheHit: false,
      stale: false,
      warning: null
    };
  } catch (error) {
    const stale = cache.weekMicros.get(weekKey);

    if (stale?.micros) {
      return {
        weekKey,
        micros: stale.micros,
        cacheHit: true,
        stale: true,
        warning: error?.message || String(error)
      };
    }

    return {
      weekKey,
      micros: {},
      cacheHit: false,
      stale: false,
      warning: error?.message || String(error)
    };
  }
}

async function getWeekMicrosWithFallback(
  requestedWeekKey,
  previousWeekKey,
  {
    minPrimaryRowsForMerge = DEFAULT_MIN_PRIMARY_ROWS_FOR_PREVIOUS_WEEK_MERGE
  } = {}
) {
  const primary = await getWeekMicrosCached(requestedWeekKey, WEEK_MICROS_TIMEOUT_MS);
  const primaryCount = microsCount(primary.micros);
  const warnings = primary.warning ? [primary.warning] : [];

  if (hasMicros(primary.micros) && requestedWeekKey === previousWeekKey) {
    return {
      ...primary,
      source: 'requestedWeek',
      primaryWeekKey: requestedWeekKey,
      previousWeekKey,
      primaryRows: primaryCount,
      previousRows: 0,
      mergedPreviousWeek: false,
      warnings
    };
  }

  if (hasMicros(primary.micros) && primaryCount >= minPrimaryRowsForMerge) {
    return {
      ...primary,
      source: 'requestedWeek',
      primaryWeekKey: requestedWeekKey,
      previousWeekKey,
      primaryRows: primaryCount,
      previousRows: 0,
      mergedPreviousWeek: false,
      warnings
    };
  }

  if (requestedWeekKey !== previousWeekKey) {
    const fallback = await getWeekMicrosCached(previousWeekKey, FALLBACK_WEEK_TIMEOUT_MS);
    const fallbackCount = microsCount(fallback.micros);

    if (hasMicros(primary.micros) && hasMicros(fallback.micros)) {
      return {
        weekKey: requestedWeekKey,
        primaryWeekKey: requestedWeekKey,
        previousWeekKey,
        micros: mergeMicros(primary.micros, fallback.micros),
        cacheHit: Boolean(primary.cacheHit && fallback.cacheHit),
        stale: Boolean(primary.stale || fallback.stale),
        source: 'requestedWeekMergedWithPreviousWeek',
        primaryRows: primaryCount,
        previousRows: fallbackCount,
        mergedPreviousWeek: true,
        warning: null,
        warnings: uniqueStrings([
          ...warnings,
          ...(fallback.warning ? [fallback.warning] : []),
          `PRIMARY_WEEK_LOW_ROWS:${requestedWeekKey}:${primaryCount}`,
          `MERGED_PREVIOUS_WEEK:${previousWeekKey}:${fallbackCount}`
        ])
      };
    }

    if (!hasMicros(primary.micros) && hasMicros(fallback.micros)) {
      return {
        ...fallback,
        source: 'previousWeekFallback',
        primaryWeekKey: requestedWeekKey,
        previousWeekKey,
        primaryRows: primaryCount,
        previousRows: fallbackCount,
        mergedPreviousWeek: false,
        warnings: uniqueStrings([
          ...warnings,
          `REQUESTED_WEEK_EMPTY:${requestedWeekKey}`,
          ...(fallback.warning ? [fallback.warning] : [])
        ])
      };
    }

    if (fallback.warning) warnings.push(fallback.warning);
  }

  if (hasMicros(primary.micros)) {
    return {
      ...primary,
      source: 'requestedWeekLowRowsNoPreviousFallback',
      primaryWeekKey: requestedWeekKey,
      previousWeekKey,
      primaryRows: primaryCount,
      previousRows: 0,
      mergedPreviousWeek: false,
      warnings: uniqueStrings([
        ...warnings,
        `PRIMARY_WEEK_LOW_ROWS:${requestedWeekKey}:${primaryCount}`,
        `NO_PREVIOUS_WEEK_ROWS_AVAILABLE:${previousWeekKey}`
      ])
    };
  }

  return {
    ...primary,
    source: 'empty',
    primaryWeekKey: requestedWeekKey,
    previousWeekKey,
    primaryRows: primaryCount,
    previousRows: 0,
    mergedPreviousWeek: false,
    warnings: uniqueStrings([
      ...warnings,
      `NO_MICROS_FOUND_FOR_REQUESTED_OR_PREVIOUS_WEEK:${requestedWeekKey}`
    ])
  };
}

async function getRecentWeekMicrosMerged({
  requestedWeekKey,
  minRows = DEFAULT_BEST_LIMIT,
  lookback = DEFAULT_RECENT_WEEK_LOOKBACK
} = {}) {
  const safeLookback = toSafeLimit(
    lookback,
    DEFAULT_RECENT_WEEK_LOOKBACK,
    MAX_RECENT_WEEK_LOOKBACK
  );

  const weekKeys = recentIsoWeekKeys(requestedWeekKey, safeLookback);

  const results = await Promise.all(
    weekKeys.map((weekKey) => getWeekMicrosCached(
      weekKey,
      weekKey === requestedWeekKey
        ? WEEK_MICROS_TIMEOUT_MS
        : RECENT_WEEK_TIMEOUT_MS
    ))
  );

  const warnings = uniqueStrings(
    results
      .map((result) => result.warning)
      .filter(Boolean)
  );

  let selectedResults = results;
  let merged = mergeMicrosByRecency(selectedResults);

  for (let count = 1; count <= results.length; count += 1) {
    const partial = results.slice(0, count);
    const partialMerged = mergeMicrosByRecency(partial);

    if (microsCount(partialMerged) >= minRows) {
      selectedResults = partial;
      merged = partialMerged;
      break;
    }
  }

  const selectedCount = selectedResults.length;
  const primary = results[0] || null;
  const previous = results[1] || null;

  return {
    weekKey: requestedWeekKey,
    requestedWeekKey,
    sourceWeekKeyUsed: requestedWeekKey,

    source: selectedCount <= 1
      ? 'requestedWeek'
      : microsCount(merged) >= minRows
        ? 'recentWeeksMerged'
        : 'recentWeeksMergedInsufficientRows',

    micros: merged,

    primaryWeekKey: requestedWeekKey,
    previousWeekKey: weekKeys[1] || getPreviousIsoWeekKey(),

    primaryRows: microsCount(primary?.micros || {}),
    previousRows: microsCount(previous?.micros || {}),

    mergedPreviousWeek: selectedCount > 1,

    recentWeekLookback: safeLookback,
    recentWeekKeysScanned: selectedResults.map((row) => row.weekKey),
    recentWeekRows: selectedResults.map((row) => ({
      weekKey: row.weekKey,
      rows: microsCount(row.micros),
      cacheHit: Boolean(row.cacheHit),
      stale: Boolean(row.stale)
    })),

    allRecentWeekKeysChecked: results.map((row) => row.weekKey),
    allRecentWeekRowsChecked: results.map((row) => ({
      weekKey: row.weekKey,
      rows: microsCount(row.micros),
      cacheHit: Boolean(row.cacheHit),
      stale: Boolean(row.stale)
    })),

    cacheHit: selectedResults.length > 0 && selectedResults.every((row) => row.cacheHit),
    stale: selectedResults.some((row) => row.stale),
    warning: null,

    warnings: uniqueStrings([
      ...warnings,
      selectedCount > 1
        ? `MERGED_RECENT_WEEKS:${selectedCount}`
        : null,
      microsCount(merged) < minRows
        ? `RECENT_WEEK_ROWS_BELOW_TARGET:${microsCount(merged)}:${minRows}`
        : null
    ].filter(Boolean))
  };
}

function normalizeRows(rows = [], activeSet, activeMacroSet, compact) {
  return rows.map((row, index) => normalizeMicroRow(row, index, {
    activeSet,
    activeMacroSet,
    compact
  }));
}

function selectBestMicroFamilyRows({
  rows = [],
  mode = 'balanced',
  limit = DEFAULT_BEST_LIMIT
} = {}) {
  const safeLimit = toSafeLimit(limit, DEFAULT_BEST_LIMIT, MAX_BEST_LIMIT);

  return sortRowsByMode(
    rows.filter((row) => inferTradeSide(row) !== 'SHORT'),
    mode
  )
    .slice(0, safeLimit)
    .map((row, index) => ({
      ...row,
      rank: index + 1
    }));
}

function selectBestMicroFamilies({
  rows = [],
  mode = 'balanced',
  activeSet = new Set(),
  activeMacroSet = new Set(),
  limit = DEFAULT_BEST_LIMIT,
  compact = true
} = {}) {
  const rankedRows = selectBestMicroFamilyRows({
    rows,
    mode,
    limit
  });

  return normalizeRows(rankedRows, activeSet, activeMacroSet, compact);
}

function selectResponseRows({
  rankedRows = [],
  limit = DEFAULT_LIMIT,
  filters = {}
} = {}) {
  if (filters.side === 'SHORT_DISABLED') return [];

  return rankedRows
    .filter((row) => inferTradeSide(row) !== 'SHORT')
    .slice(0, limit);
}

function splitSideRows(rows = [], sideLimit = DEFAULT_SIDE_LIMIT) {
  const longRows = rows
    .filter((row) => inferTradeSide(row) !== 'SHORT')
    .slice(0, sideLimit);

  return {
    shortRows: [],
    longRows,
    unknownRows: []
  };
}

function forcedLongFallbackRows(activeRotation, existingRows = []) {
  const existing = new Set(existingRows.map(rowKey).filter(Boolean));
  const rows = [];

  if (activeRotation?.bestLong) {
    const id =
      activeRotation.bestLong.microFamilyId ||
      activeRotation.bestLong.trueMicroFamilyId ||
      activeRotation.bestLong.id ||
      'ACTIVE_BEST_LONG';

    if (!existing.has(id)) {
      rows.push(decorateMicroRow(
        buildRawMicroRow({
          ...activeRotation.bestLong,
          tradeSide: TARGET_TRADE_SIDE,
          side: TARGET_DASHBOARD_SIDE,
          selectedTier: activeRotation.bestLong.selectedTier || activeRotation.selectedTier || 'ACTIVE_LONG_FALLBACK'
        }, id, rows.length, TARGET_TRADE_SIDE)
      ));
      existing.add(id);
    }
  }

  for (const id of extractActiveIds(activeRotation)) {
    if (existing.has(id)) continue;
    if (upper(id).includes('SHORT')) continue;

    const manual = manualRowFromId(id, rows.length, TARGET_TRADE_SIDE);
    if (!manual) continue;

    rows.push(manual);
    existing.add(id);
  }

  return rows;
}

export default async function handler(req, res) {
  const startedAt = now();

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Micro-Families-Mode', 'long-fast-safe-best25-recent-weeks-merge');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Short-Disabled', 'true');

  if (req.method !== 'GET') {
    return methodNotAllowed(res);
  }

  try {
    const currentWeekKey = getIsoWeekKey();
    const previousWeekKey = getPreviousIsoWeekKey();

    const requestedWeekKey = String(
      firstQueryValue(req.query?.weekKey, currentWeekKey) || currentWeekKey
    ).trim();

    const requestedMode = String(firstQueryValue(req.query?.mode, 'balanced') || 'balanced');
    const mode = VALID_MODES.has(requestedMode) ? requestedMode : 'balanced';

    const requestedLimitRaw = firstQueryValue(req.query?.limit, DEFAULT_LIMIT);
    const requestedLimitNumber = Number(requestedLimitRaw) || DEFAULT_LIMIT;
    const limit = toSafeLimit(requestedLimitRaw, DEFAULT_LIMIT, MAX_LIMIT);

    const sideLimit = toSafeLimit(
      firstQueryValue(
        req.query?.sideLimit,
        firstQueryValue(req.query?.sideEnsureLimit, DEFAULT_SIDE_LIMIT)
      ),
      DEFAULT_SIDE_LIMIT,
      MAX_SIDE_LIMIT
    );

    const bestLimit = toSafeLimit(
      firstQueryValue(req.query?.bestLimit, DEFAULT_BEST_LIMIT),
      DEFAULT_BEST_LIMIT,
      MAX_BEST_LIMIT
    );

    const recentWeekLookback = toSafeLimit(
      firstQueryValue(req.query?.recentWeekLookback, DEFAULT_RECENT_WEEK_LOOKBACK),
      DEFAULT_RECENT_WEEK_LOOKBACK,
      MAX_RECENT_WEEK_LOOKBACK
    );

    const minPrimaryRowsForMerge = toSafeLimit(
      firstQueryValue(
        req.query?.minPrimaryRowsForMerge,
        Math.max(DEFAULT_MIN_PRIMARY_ROWS_FOR_PREVIOUS_WEEK_MERGE, bestLimit)
      ),
      Math.max(DEFAULT_MIN_PRIMARY_ROWS_FOR_PREVIOUS_WEEK_MERGE, bestLimit),
      MAX_SIDE_LIMIT
    );

    const includeActiveRotation = isTrue(firstQueryValue(req.query?.includeActiveRotation, false));
    const details = isTrue(firstQueryValue(req.query?.details, false));
    const compactRaw = firstQueryValue(req.query?.compact, null);

    const compact = details
      ? false
      : compactRaw === null
        ? true
        : isTrue(compactRaw);

    const filters = parseFilters(req);
    const narrowFilters = hasNarrowFilters(filters);

    const [activeRotation, weekResult] = await Promise.all([
      getActiveRotationSafe(),
      getRecentWeekMicrosMerged({
        requestedWeekKey,
        minRows: Math.max(bestLimit, minPrimaryRowsForMerge),
        lookback: recentWeekLookback
      })
    ]);

    const activeMicroFamilyIds = extractActiveIds(activeRotation);
    const activeMacroFamilyIds = extractActiveMacroIds(activeRotation);

    const activeSet = new Set(activeMicroFamilyIds);
    const activeMacroSet = new Set(activeMacroFamilyIds);

    const weekRows = buildRowsFromMicros(weekResult.micros);
    const activeFallbackRows = buildRowsFromActiveRotation(activeRotation);

    let mergedRows = mergeRows(weekRows, activeFallbackRows);

    if (mergedRows.length === 0 && activeFallbackRows.length > 0) {
      mergedRows = activeFallbackRows;
    }

    let filteredRows = mergedRows.filter((row) => (
      rowPassesFilters(row, filters, activeSet, activeMacroSet)
    ));

    const usedForcedLongFallback =
      filters.side === TARGET_TRADE_SIDE &&
      filteredRows.length === 0 &&
      activeRotation;

    if (usedForcedLongFallback) {
      const fallbackLongRows = forcedLongFallbackRows(activeRotation, mergedRows);

      if (fallbackLongRows.length > 0) {
        mergedRows = mergeRows(mergedRows, fallbackLongRows);
        filteredRows = fallbackLongRows.filter((row) => (
          rowPassesFilters(row, filters, activeSet, activeMacroSet)
        ));
      }
    }

    const best25RawRows = selectBestMicroFamilyRows({
      rows: mergedRows,
      mode,
      limit: bestLimit
    });

    const best25MicroFamilies = normalizeRows(
      best25RawRows,
      activeSet,
      activeMacroSet,
      compact
    );

    const rankedRows = sortRowsByMode(filteredRows, mode)
      .map((row, index) => ({
        ...row,
        rank: index + 1
      }));

    const responseRows = selectResponseRows({
      rankedRows,
      limit,
      filters
    });

    const displayRows = narrowFilters
      ? responseRows
      : best25RawRows;

    const splitBaseRows = narrowFilters
      ? rankedRows
      : best25RawRows;

    const split = splitSideRows(splitBaseRows, sideLimit);

    const normalizedRows = normalizeRows(displayRows, activeSet, activeMacroSet, compact);
    const normalizedShortRows = [];
    const normalizedLongRows = normalizeRows(split.longRows, activeSet, activeMacroSet, compact);
    const normalizedUnknownRows = [];

    const summary = buildSummary(rankedRows, activeSet);

    const bestLong =
      best25RawRows[0] ||
      split.longRows[0] ||
      null;

    const bestShort = null;

    const warnings = uniqueStrings([
      ...(weekResult.warnings || []),
      weekRows.length === 0 && activeFallbackRows.length > 0
        ? 'USED_ACTIVE_ROTATION_FALLBACK_ROWS'
        : null,
      usedForcedLongFallback
        ? 'USED_FORCED_LONG_ACTIVE_ROTATION_FALLBACK'
        : null,
      rankedRows.length === 0
        ? 'NO_ROWS_AFTER_FILTERS'
        : null,
      best25MicroFamilies.length === 0
        ? 'NO_BEST25_MICRO_FAMILIES_AVAILABLE'
        : null
    ].filter(Boolean));

    return res.status(200).json({
      ok: true,
      fixed: true,
      longFastSafe: true,
      alwaysBest25: true,

      targetTradeSide: TARGET_TRADE_SIDE,
      targetDashboardSide: TARGET_DASHBOARD_SIDE,
      longOnly: true,
      shortDisabled: true,

      weekKey: weekResult.weekKey || requestedWeekKey,
      requestedWeekKey,
      sourceWeekKeyUsed: weekResult.sourceWeekKeyUsed || weekResult.weekKey || requestedWeekKey,
      source: weekResult.source || 'unknown',

      currentWeekKey,
      previousWeekKey,

      primaryWeekKey: weekResult.primaryWeekKey || requestedWeekKey,
      primaryWeekRows: weekResult.primaryRows ?? null,
      previousWeekRows: weekResult.previousRows ?? null,
      mergedPreviousWeek: Boolean(weekResult.mergedPreviousWeek),
      minPrimaryRowsForMerge,

      recentWeekLookback,
      recentWeekKeysScanned: weekResult.recentWeekKeysScanned || [],
      recentWeekRows: weekResult.recentWeekRows || [],
      allRecentWeekKeysChecked: weekResult.allRecentWeekKeysChecked || [],
      allRecentWeekRowsChecked: weekResult.allRecentWeekRowsChecked || [],

      mode,
      requestedMode,

      requestedLimit: requestedLimitNumber,
      limit,
      limitCapped: requestedLimitNumber > limit,
      sideLimit,
      sideEnsureLimit: sideLimit,

      bestLimit,
      best25Count: best25MicroFamilies.length,
      best25MicroFamilies,
      topMicroFamilies: best25MicroFamilies,

      filters,
      narrowFilters,
      compact,

      count: normalizedRows.length,
      filtered: rankedRows.length,
      totalAvailable: mergedRows.length,
      weekRows: weekRows.length,
      activeFallbackRows: activeFallbackRows.length,

      rawSideCounts: sideCounts(mergedRows),
      filteredSideCounts: sideCounts(rankedRows),
      responseSideCounts: sideCounts(normalizedRows),
      best25SideCounts: sideCounts(best25MicroFamilies),

      activeRotationId: activeRotation?.rotationId || null,
      activeRotation: includeActiveRotation
        ? activeRotation
        : compactActiveRotation(activeRotation),

      activeMicroFamilyIds,
      activeMacroFamilyIds,

      bestShort: compactBestRow(bestShort),
      bestLong: compactBestRow(bestLong),

      shortRows: normalizedShortRows,
      longRows: normalizedLongRows,
      unknownRows: normalizedUnknownRows,

      summary,
      rows: normalizedRows,

      warnings,

      perf: {
        durationMs: now() - startedAt,
        weekMicrosCacheHit: Boolean(weekResult.cacheHit),
        weekMicrosCacheStale: Boolean(weekResult.stale),
        weekMicrosCacheSize: cache.weekMicros.size,
        path: 'longFastSafeBest25WithRecentWeeksMergeAndActiveRotationFallback',
        best25Source: 'mergedRowsBeforeFilters'
      },

      serverTs: Date.now()
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,

      targetTradeSide: TARGET_TRADE_SIDE,
      targetDashboardSide: TARGET_DASHBOARD_SIDE,
      longOnly: true,
      shortDisabled: true,

      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}