// ================= FILE: api/admin/micro-family/[id].js =================

import {
  sideToTradeSide,
  safeNumber
} from '../../../src/utils.js';
import { getWeekMicros } from '../../../src/analyze/analyzeEngine.js';
import { getActiveRotation } from '../../../src/analyze/rotationEngine.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

// Vaste leer-sleutel: dashboard detail leest dezelfde bak als analyzeEngine.js.
// Geen ISO-week reset meer. Alleen handmatige factory-reset wist ANALYZE:*.
// LONG-root gebruikt een aparte namespace zodat keys niet botsen met de oude SHORT-root.
const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';

const WINRATE_Z = 1.96;
const WINRATE_BAYES_ALPHA = 1;
const WINRATE_BAYES_BETA = 1;
const SAMPLE_RELIABILITY_CAP = 50;

const MIN_COMPLETED_ACTIVE_LEARNING = 20;

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET'],
    ...baseModePayload()
  });
}

function firstQueryValue(value, fallback = null) {
  if (Array.isArray(value)) return value[0] ?? fallback;
  if (value === undefined || value === null || value === '') return fallback;

  return value;
}

function safeDecode(value) {
  const text = String(value || '').trim();

  if (!text) return '';

  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function toSafeLimit(value, fallback = 100) {
  const n = Number(value);

  if (!Number.isFinite(n)) return fallback;
  if (n < 1) return fallback;

  return Math.min(Math.floor(n), 500);
}

function num(value, fallback = 0) {
  const n = safeNumber(value, fallback);

  return Number.isFinite(n) ? n : fallback;
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

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function normalizeSideToken(value) {
  const raw = upper(value);

  if (!raw) return 'UNKNOWN';

  const direct = sideToTradeSide(raw);

  if (direct === OPPOSITE_TRADE_SIDE || direct === TARGET_TRADE_SIDE) return direct;

  if (['LONG', 'BULL', 'BULLISH', 'BUY'].includes(raw)) return TARGET_TRADE_SIDE;
  if (['SHORT', 'BEAR', 'BEARISH', 'SELL'].includes(raw)) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function getArray(value) {
  return Array.isArray(value) ? value : [];
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

function cleanSideHaystack(text = '') {
  return upper(text)
    .replaceAll('SHORT_DISABLED_FALSE', '')
    .replaceAll('SHORT_DISABLED', '')
    .replaceAll('SHORTDISABLED', '')
    .replaceAll('BLOCK_SHORT', '')
    .replaceAll('SHORT_ENABLED_FALSE', '')
    .replaceAll('SHORT_ONLY_FALSE', '')
    .replaceAll('LONG_DISABLED_FALSE', '')
    .replaceAll('LONG_ENABLED_FALSE', '')
    .replaceAll('LONG_ONLY_FALSE', '')
    .replaceAll('LONG_ONLY_MODE', 'LONG')
    .replaceAll('LONG_ONLY', 'LONG')
    .replaceAll('LONG-ONLY', 'LONG');
}

function collectSideText(input = {}) {
  if (typeof input === 'string') return cleanSideHaystack(input);

  return [
    input.tradeSide,
    input.side,
    input.positionSide,
    input.direction,
    input.signalSide,
    input.scannerSide,
    input.actualScannerSide,
    input.analysisSide,
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
    input.coarseMicroFamilyId,
    input.baseMicroFamilyId,
    input.legacyMicroFamilyId,
    input.id,
    input.key,

    input.definition,
    input.microDefinition,
    input.macroDefinition,
    input.parentDefinition,

    ...getArray(input.definitionParts),
    ...getArray(input.microDefinitionParts),
    ...getArray(input.macroDefinitionParts),
    ...getArray(input.parentDefinitionParts),
    ...getArray(input.executionFingerprintParts)
  ]
    .map((value) => cleanSideHaystack(value))
    .filter(Boolean)
    .join(' | ');
}

function hasLongSignal(text = '') {
  const raw = ` ${cleanSideHaystack(text)} `;

  return (
    raw.includes('TRADE_SIDE=LONG') ||
    raw.includes('TRADESIDE=LONG') ||
    raw.includes('SIDE=LONG') ||
    raw.includes('DIRECTION=LONG') ||
    raw.includes('POSITION_SIDE=LONG') ||
    raw.includes('POSITIONSIDE=LONG') ||
    raw.includes('SIDE=BULL') ||
    raw.includes('DIRECTION=BULL') ||
    raw.includes('SIDE=BUY') ||
    raw.includes('DIRECTION=BUY') ||

    raw.includes('MICRO_LONG_') ||
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

function hasShortSignal(text = '') {
  const raw = ` ${cleanSideHaystack(text)} `;

  return (
    raw.includes('TRADE_SIDE=SHORT') ||
    raw.includes('TRADESIDE=SHORT') ||
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

function inferTradeSide(input = {}) {
  if (typeof input === 'string') {
    const clean = cleanSideHaystack(input);
    const direct = normalizeSideToken(clean);

    if (direct === OPPOSITE_TRADE_SIDE || direct === TARGET_TRADE_SIDE) return direct;

    const longSignal = hasLongSignal(clean);
    const shortSignal = hasShortSignal(clean);

    if (longSignal && !shortSignal) return TARGET_TRADE_SIDE;
    if (shortSignal && !longSignal) return OPPOSITE_TRADE_SIDE;

    if (clean.includes('MICRO_LONG_') || clean.includes('LONG')) return TARGET_TRADE_SIDE;
    if (clean.includes('MICRO_SHORT_') || clean.includes('SHORT')) return OPPOSITE_TRADE_SIDE;

    return 'UNKNOWN';
  }

  const directSources = [
    input.tradeSide,
    input.side,
    input.positionSide,
    input.direction,
    input.signalSide,
    input.scannerSide,
    input.actualScannerSide,
    input.analysisSide,
    input.entrySide,
    input.bias,
    input.marketBias
  ];

  for (const source of directSources) {
    const normalized = normalizeSideToken(source);

    if (normalized === OPPOSITE_TRADE_SIDE || normalized === TARGET_TRADE_SIDE) return normalized;
  }

  const familyId = cleanSideHaystack(input.familyId || input.family || input.baseFamilyId);
  const macroFamilyId = cleanSideHaystack(
    input.parentMacroFamilyId ||
    input.macroFamilyId ||
    input.parentMicroFamilyId ||
    input.parentFamilyId ||
    input.macroId
  );
  const microFamilyId = cleanSideHaystack(
    input.microFamilyId ||
    input.trueMicroFamilyId ||
    input.coarseMicroFamilyId ||
    input.baseMicroFamilyId ||
    input.legacyMicroFamilyId ||
    input.id ||
    input.key
  );

  if (familyId.startsWith('LONG_')) return TARGET_TRADE_SIDE;
  if (familyId.startsWith('SHORT_')) return OPPOSITE_TRADE_SIDE;

  if (macroFamilyId.includes('MICRO_LONG_') || macroFamilyId.startsWith('LONG_')) return TARGET_TRADE_SIDE;
  if (macroFamilyId.includes('MICRO_SHORT_') || macroFamilyId.startsWith('SHORT_')) return OPPOSITE_TRADE_SIDE;

  if (microFamilyId.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
  if (microFamilyId.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;

  const text = collectSideText(input);
  const longSignal = hasLongSignal(text);
  const shortSignal = hasShortSignal(text);

  if (longSignal && !shortSignal) return TARGET_TRADE_SIDE;
  if (shortSignal && !longSignal) return OPPOSITE_TRADE_SIDE;

  if (longSignal && shortSignal) {
    if (microFamilyId.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
    if (microFamilyId.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
    if (familyId.startsWith('LONG_')) return TARGET_TRADE_SIDE;
    if (familyId.startsWith('SHORT_')) return OPPOSITE_TRADE_SIDE;
  }

  if (microFamilyId.includes('LONG')) return TARGET_TRADE_SIDE;
  if (microFamilyId.includes('SHORT')) return OPPOSITE_TRADE_SIDE;

  if (macroFamilyId.includes('LONG')) return TARGET_TRADE_SIDE;
  if (macroFamilyId.includes('SHORT')) return OPPOSITE_TRADE_SIDE;

  if (input.longOnly === true || input.shortDisabled === true) return TARGET_TRADE_SIDE;
  if (input.shortOnly === true || input.longDisabled === true) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function isScannerFingerprintId(id = '') {
  const value = upper(id);

  return (
    value.startsWith('MICRO_LONG_SCANNER__') ||
    value.includes('MICRO_LONG_SCANNER__') ||
    value.startsWith('LONG_SCANNER_') ||
    value.startsWith('MICRO_SHORT_SCANNER__') ||
    value.includes('MICRO_SHORT_SCANNER__') ||
    value.startsWith('SHORT_SCANNER_') ||
    value.includes('__SCANNER__') ||
    value.includes('SCANNER_GATE_PASS') ||
    value.includes('SCANNER_GATE_FAIL')
  );
}

function isExplicitShort(input = {}) {
  if (!input) return false;

  const side = inferTradeSide(input);
  if (side === OPPOSITE_TRADE_SIDE) return true;

  if (typeof input === 'string') {
    const clean = cleanSideHaystack(input);

    return (
      clean.includes('MICRO_SHORT_') ||
      clean.startsWith('SHORT_') ||
      clean.includes('TRADE_SIDE=SHORT') ||
      clean.includes('TRADESIDE=SHORT') ||
      clean.includes('SIDE=SHORT') ||
      clean.includes('SIDE=BEAR') ||
      clean.includes('DIRECTION=SHORT') ||
      clean.includes('DIRECTION=BEAR') ||
      clean.includes('SIDE=SELL') ||
      clean.includes('DIRECTION=SELL')
    );
  }

  return input.shortOnly === true || input.longDisabled === true;
}

function isTargetSide(row = {}) {
  if (!row) return false;

  const id = String(
    row.microFamilyId ||
    row.trueMicroFamilyId ||
    row.coarseMicroFamilyId ||
    row.id ||
    row.key ||
    ''
  ).trim();

  if (id && isScannerFingerprintId(id)) return false;
  if (isScannerFingerprintId(row.trueMicroFamilyId)) return false;
  if (isScannerFingerprintId(row.coarseMicroFamilyId)) return false;

  return !isExplicitShort(row);
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

function extractActiveIds(activeRotation) {
  if (!activeRotation) return [];

  const ids = [
    ...(Array.isArray(activeRotation.microFamilyIds) ? activeRotation.microFamilyIds : []),
    ...(Array.isArray(activeRotation.activeMicroFamilyIds) ? activeRotation.activeMicroFamilyIds : []),
    ...(Array.isArray(activeRotation.trueMicroFamilyIds) ? activeRotation.trueMicroFamilyIds : []),
    ...(Array.isArray(activeRotation.ids) ? activeRotation.ids : []),
    ...(Array.isArray(activeRotation.microFamilies)
      ? activeRotation.microFamilies
        .filter(isTargetSide)
        .map((row) => row.microFamilyId || row.trueMicroFamilyId || row.id || row.key)
      : [])
  ];

  return uniqueStrings(ids)
    .filter((id) => !isExplicitShort(id))
    .filter((id) => !isScannerFingerprintId(id));
}

function extractActiveMacroIds(activeRotation) {
  if (!activeRotation) return [];

  const longRows = Array.isArray(activeRotation.microFamilies)
    ? activeRotation.microFamilies.filter(isTargetSide)
    : [];

  const ids = [
    ...(Array.isArray(activeRotation.macroFamilyIds) ? activeRotation.macroFamilyIds : []),
    ...(Array.isArray(activeRotation.activeMacroFamilyIds) ? activeRotation.activeMacroFamilyIds : []),
    ...longRows.map((row) => getMacroFamilyId(row))
  ];

  return uniqueStrings(ids)
    .filter((id) => !isExplicitShort(id))
    .filter((id) => !isScannerFingerprintId(id));
}

function virtualKeyFromReal(realKey = '') {
  if (!realKey || !String(realKey).startsWith('real')) return null;

  return `virtual${String(realKey).slice(4)}`;
}

function shadowKeyFromReal(realKey = '') {
  if (!realKey || !String(realKey).startsWith('real')) return null;

  return `shadow${String(realKey).slice(4)}`;
}

function getLearningOutcomeCounts(row = {}) {
  const aggregateWins = hasValue(row.wins)
    ? num(row.wins, 0)
    : num(row.virtualWins, 0) + num(row.shadowWins, 0);

  const aggregateLosses = hasValue(row.losses)
    ? num(row.losses, 0)
    : num(row.virtualLosses, 0) + num(row.shadowLosses, 0);

  const aggregateFlats = hasValue(row.flats)
    ? num(row.flats, 0)
    : num(row.virtualFlats, 0) + num(row.shadowFlats, 0);

  const explicitCompleted = Math.max(
    num(row.completed, 0),
    num(row.outcomeSample, 0),
    num(row.virtualCompleted, 0) + num(row.shadowCompleted, 0),
    0
  );

  const countedTotal = aggregateWins + aggregateLosses + aggregateFlats;
  const total = Math.max(countedTotal, explicitCompleted, 0);

  const inferredFlats = Math.max(0, total - aggregateWins - aggregateLosses);

  return {
    wins: aggregateWins,
    losses: aggregateLosses,
    flats: Math.max(aggregateFlats, inferredFlats),
    total
  };
}

function getCompletedSample(row = {}) {
  return getLearningOutcomeCounts(row).total;
}

function getObservationSample(row = {}) {
  return Math.max(
    num(row.seen, 0),
    num(row.observations, 0),
    getCompletedSample(row),
    0
  );
}

function getVirtualCompleted(row = {}) {
  return Math.max(
    num(row.virtualCompleted, 0),
    num(row.virtualWins, 0) + num(row.virtualLosses, 0) + num(row.virtualFlats, 0),
    0
  );
}

function getShadowCompleted(row = {}) {
  return Math.max(
    num(row.shadowCompleted, 0),
    num(row.shadowWins, 0) + num(row.shadowLosses, 0) + num(row.shadowFlats, 0),
    0
  );
}

function getLearningTotalR(row = {}) {
  const completed = getCompletedSample(row);

  if (completed <= 0) return 0;
  if (hasValue(row.netTotalR)) return num(row.netTotalR, 0);
  if (hasValue(row.totalNetR)) return num(row.totalNetR, 0);
  if (hasValue(row.totalR)) return num(row.totalR, 0);

  return num(row.virtualTotalR, 0) + num(row.shadowTotalR, 0);
}

function getLearningTotalCostR(row = {}) {
  const completed = getCompletedSample(row);

  if (completed <= 0) return 0;
  if (hasValue(row.totalCostR)) return num(row.totalCostR, 0);

  return num(row.virtualTotalCostR, 0) + num(row.shadowTotalCostR, 0);
}

function getLearningAvgR(row = {}) {
  const completed = getCompletedSample(row);
  const totalR = getLearningTotalR(row);

  if (hasValue(row.avgR) && completed > 0) return num(row.avgR, 0);
  if (completed > 0) return totalR / completed;

  return 0;
}

function getLearningAvgCostR(row = {}) {
  const completed = getCompletedSample(row);
  const totalCostR = getLearningTotalCostR(row);

  if (hasValue(row.avgCostR) && completed > 0) return num(row.avgCostR, 0);
  if (completed > 0) return totalCostR / completed;

  return 0;
}

function getPositiveR(row = {}, aggregateKey, realKey = null, shadowKey = null) {
  if (hasValue(row[aggregateKey])) return Math.max(0, num(row[aggregateKey], 0));

  const virtualKey = virtualKeyFromReal(realKey);

  return Math.max(
    0,
    num(virtualKey ? row[virtualKey] : 0, 0) +
      num(shadowKey ? row[shadowKey] : 0, 0)
  );
}

function getAbsLossR(row = {}, aggregateKey, realKey = null, shadowKey = null) {
  if (hasValue(row[aggregateKey])) return Math.abs(num(row[aggregateKey], 0));

  const virtualKey = virtualKeyFromReal(realKey);

  return Math.abs(
    num(virtualKey ? row[virtualKey] : 0, 0) +
      num(shadowKey ? row[shadowKey] : 0, 0)
  );
}

function getLearningProfitFactor(row = {}) {
  if (hasValue(row.netProfitFactor)) return num(row.netProfitFactor, 0);
  if (hasValue(row.profitFactor)) return num(row.profitFactor, 0);

  const netWinR = Math.max(
    getPositiveR(row, 'netWinR', 'realNetWinR', 'shadowNetWinR'),
    getPositiveR(row, 'totalWinR', 'realTotalWinR', 'shadowTotalWinR'),
    getPositiveR(row, 'grossWinR', 'realGrossWinR', 'shadowGrossWinR'),
    0
  );

  const netLossR = Math.max(
    getAbsLossR(row, 'netLossR', 'realNetLossR', 'shadowNetLossR'),
    getAbsLossR(row, 'totalLossR', 'realTotalLossR', 'shadowTotalLossR'),
    getAbsLossR(row, 'grossLossR', 'realGrossLossR', 'shadowGrossLossR'),
    0
  );

  if (netWinR <= 0 && netLossR <= 0) return 0;
  if (netLossR <= 0) return netWinR > 0 ? 999 : 0;

  return netWinR / netLossR;
}

function getLearningCountMetric(row = {}, aggregateCountKey, realCountKey = null, shadowCountKey = null) {
  if (hasValue(row[aggregateCountKey])) return num(row[aggregateCountKey], 0);

  const virtualCountKey = virtualKeyFromReal(realCountKey);

  return num(virtualCountKey ? row[virtualCountKey] : 0, 0) +
    num(shadowCountKey ? row[shadowCountKey] : 0, 0);
}

function getLearningPctMetric(row = {}, aggregatePctKey, aggregateCountKey, realCountKey = null, shadowCountKey = null) {
  if (hasValue(row[aggregatePctKey])) return clamp(row[aggregatePctKey], 0, 1);

  const completed = getCompletedSample(row);
  const count = getLearningCountMetric(
    row,
    aggregateCountKey,
    realCountKey,
    shadowCountKey
  );

  if (completed <= 0 || count <= 0) return 0;

  return clamp(count / completed, 0, 1);
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
  const counts = getLearningOutcomeCounts(row);
  const sample = counts.total;
  const observationSample = getObservationSample(row);

  if (sample <= 0) {
    return {
      sample: observationSample,
      outcomeSample: 0,
      observationSample,
      wins: 0,
      losses: 0,
      flats: 0,
      rawWinrate: 0,
      bayesianWinrate: 0,
      wilsonLowerBound: 0,
      reliability: sampleReliability(observationSample),
      score: 0,
      awaitingOutcomes: observationSample > 0
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
    outcomeSample: sample,
    observationSample,
    wins: counts.wins,
    losses: counts.losses,
    flats: counts.flats,
    rawWinrate,
    bayesianWinrate,
    wilsonLowerBound: wilson,
    reliability,
    score,
    awaitingOutcomes: false
  };
}

function getDashboardBalancedScore(row = {}) {
  const winrateMeta = getSampleAdjustedWinrate(row);

  if (winrateMeta.outcomeSample <= 0 && winrateMeta.observationSample > 0) {
    const seenComponent = Math.log1p(winrateMeta.observationSample) * 8;
    const reliabilityComponent = sampleReliability(winrateMeta.observationSample) * 18;
    const scannerBonus = row.scannerReason || row.scannerReasonCoarse ? 2 : 0;
    const definitionBonus = getDefinitionParts(row).length > 0 ? 2 : 0;

    return Math.max(
      1,
      Math.min(45, seenComponent + reliabilityComponent + scannerBonus + definitionBonus)
    );
  }

  const totalR = Math.max(0, getLearningTotalR(row));
  const avgR = Math.max(0, getLearningAvgR(row));
  const profitFactor = Math.min(Math.max(0, getLearningProfitFactor(row)), 20);

  const directSLPct = getLearningPctMetric(
    row,
    'directSLPct',
    'directSLCount',
    'realDirectSLCount',
    'shadowDirectSLCount'
  );

  const nearTpThenLossPct = getLearningPctMetric(
    row,
    'nearTpThenLossPct',
    'nearTpThenLossCount',
    'realNearTpThenLossCount',
    'shadowNearTpThenLossCount'
  );

  const gaveBackAfterOneRPct = getLearningPctMetric(
    row,
    'gaveBackAfterOneRPct',
    'gaveBackAfterOneRCount',
    'realGaveBackAfterOneRCount',
    'shadowGaveBackAfterOneRCount'
  );

  const avgCostR = Math.max(0, getLearningAvgCostR(row));

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

function getLearningTier(row = {}) {
  const outcomeSample = num(row.outcomeSample, getCompletedSample(row));
  const observationSample = num(row.observationSample, getObservationSample(row));
  const score = num(row.dashboardBalancedScore ?? getDashboardBalancedScore(row), 0);
  const avgR = num(row.avgR ?? getLearningAvgR(row), 0);
  const totalR = num(row.totalR ?? getLearningTotalR(row), 0);

  if (outcomeSample >= MIN_COMPLETED_ACTIVE_LEARNING && score > 0 && (avgR > 0 || totalR > 0)) return 'HARD';
  if (outcomeSample > 0 && score > 0) return 'SOFT';
  if (outcomeSample <= 0 && observationSample >= 0) return 'OBSERVATION';

  return 'RAW';
}

function getLearningStatus(row = {}) {
  const outcomeSample = num(row.outcomeSample, getCompletedSample(row));

  if (outcomeSample >= MIN_COMPLETED_ACTIVE_LEARNING) return 'ACTIVE_LEARNING';
  if (outcomeSample > 0) return 'EARLY_OUTCOMES';

  return 'OBSERVING';
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
    compareNumberDesc(a.outcomeSample, b.outcomeSample) ||
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
    compareNumberDesc(a.outcomeSample, b.outcomeSample) ||
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
  const microFamilyId = row.trueMicroFamilyId || row.microFamilyId || row.id || row.key || id;
  const trueMicroFamilyId = row.trueMicroFamilyId || row.microFamilyId || microFamilyId;
  const coarseMicroFamilyId =
    row.coarseMicroFamilyId ||
    row.baseMicroFamilyId ||
    row.legacyMicroFamilyId ||
    trueMicroFamilyId ||
    microFamilyId;

  const familyId = getFamilyId(row);
  const macroFamilyId = getMacroFamilyId(row);

  const winrateMeta = getSampleAdjustedWinrate(row);
  const definitionParts = getDefinitionParts(row);
  const macroDefinitionParts = getMacroDefinitionParts(row);

  const active = Boolean(row.active) || (
    trueMicroFamilyId
      ? activeSet.has(trueMicroFamilyId)
      : false
  );

  const macroActive = Boolean(row.macroActive) || (
    macroFamilyId
      ? activeMacroSet.has(macroFamilyId)
      : false
  );

  const fairWinrate = num(
    row.fairWinrate ??
    row.sampleAdjustedWinrate ??
    winrateMeta.score ??
    row.bayesianWinrate ??
    row.wilsonLowerBound,
    0
  );

  const completed = getCompletedSample(row);
  const virtualCompleted = getVirtualCompleted(row);
  const shadowCompleted = getShadowCompleted(row);

  const directSLCount = getLearningCountMetric(
    row,
    'directSLCount',
    'realDirectSLCount',
    'shadowDirectSLCount'
  );

  const nearTpCount = getLearningCountMetric(
    row,
    'nearTpCount',
    'realNearTpCount',
    'shadowNearTpCount'
  );

  const reachedHalfRCount = getLearningCountMetric(
    row,
    'reachedHalfRCount',
    'realReachedHalfRCount',
    'shadowReachedHalfRCount'
  );

  const reachedOneRCount = getLearningCountMetric(
    row,
    'reachedOneRCount',
    'realReachedOneRCount',
    'shadowReachedOneRCount'
  );

  const beWouldExitCount = getLearningCountMetric(
    row,
    'beWouldExitCount',
    'realBeWouldExitCount',
    'shadowBeWouldExitCount'
  );

  const gaveBackAfterHalfRCount = getLearningCountMetric(
    row,
    'gaveBackAfterHalfRCount',
    'realGaveBackAfterHalfRCount',
    'shadowGaveBackAfterHalfRCount'
  );

  const gaveBackAfterOneRCount = getLearningCountMetric(
    row,
    'gaveBackAfterOneRCount',
    'realGaveBackAfterOneRCount',
    'shadowGaveBackAfterOneRCount'
  );

  const nearTpThenLossCount = getLearningCountMetric(
    row,
    'nearTpThenLossCount',
    'realNearTpThenLossCount',
    'shadowNearTpThenLossCount'
  );

  const normalized = {
    ...row,

    sourceWeekKey: row.sourceWeekKey || PERSISTENT_LEARNING_KEY,
    sourceWeekPrimary: row.sourceWeekPrimary !== false,
    sourceWeekFallback: Boolean(row.sourceWeekFallback),

    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    weekResetDisabled: true,
    isoWeekLearningDisabled: true,

    microFamilyId: trueMicroFamilyId || microFamilyId,
    trueMicroFamilyId: trueMicroFamilyId || microFamilyId,
    coarseMicroFamilyId,

    familyId,
    macroFamilyId,

    parentMacroFamilyId: row.parentMacroFamilyId || macroFamilyId || null,
    parentMicroFamilyId: row.parentMicroFamilyId || macroFamilyId || null,

    scannerMicroFamilyId: row.scannerMicroFamilyId || null,
    scannerDefinition: row.scannerDefinition || null,
    scannerDefinitionParts: Array.isArray(row.scannerDefinitionParts)
      ? row.scannerDefinitionParts
      : [],
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintOnlyMetadata: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    learningIdentitySource: 'ANALYZE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    virtualLearningForced: true,

    learningOutcomesOnly: true,
    virtualOutcomesIncluded: true,
    shadowOutcomesIncluded: true,
    realOutcomesExcluded: true,
    outcomesSourceMode: 'VIRTUAL_AND_SHADOW_NET_OUTCOMES',
    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winrateDefinition: 'netR > 0',

    active,
    macroActive,

    seen: num(row.seen, 0),
    observations: num(row.observations, 0),

    completed: round(completed, 4),
    realCompleted: 0,
    virtualCompleted: round(virtualCompleted, 4),
    shadowCompleted: round(shadowCompleted, 4),

    outcomeSample: round(winrateMeta.outcomeSample, 4),
    observationSample: round(winrateMeta.observationSample, 4),
    awaitingOutcomes: Boolean(winrateMeta.awaitingOutcomes),

    wins: round(winrateMeta.wins, 4),
    losses: round(winrateMeta.losses, 4),
    flats: round(winrateMeta.flats, 4),

    realWins: 0,
    realLosses: 0,
    realFlats: 0,

    virtualWins: num(row.virtualWins, 0),
    virtualLosses: num(row.virtualLosses, 0),
    virtualFlats: num(row.virtualFlats, 0),

    shadowWins: num(row.shadowWins, 0),
    shadowLosses: num(row.shadowLosses, 0),
    shadowFlats: num(row.shadowFlats, 0),

    winrate: round(winrateMeta.rawWinrate, 4),
    bayesianWinrate: round(winrateMeta.bayesianWinrate, 4),
    wilsonLowerBound: round(winrateMeta.wilsonLowerBound, 4),
    fairWinrate: round(fairWinrate, 4),

    winrateSample: round(winrateMeta.sample, 4),
    sampleAdjustedWinrate: round(winrateMeta.score, 4),
    sampleRawWinrate: round(winrateMeta.rawWinrate, 4),
    sampleBayesianWinrate: round(winrateMeta.bayesianWinrate, 4),
    sampleWilsonLowerBound: round(winrateMeta.wilsonLowerBound, 4),
    sampleReliability: round(winrateMeta.reliability, 4),

    totalR: round(getLearningTotalR(row), 4),
    realTotalR: 0,
    virtualTotalR: round(row.virtualTotalR, 4),
    shadowTotalR: round(row.shadowTotalR, 4),

    realTotalPnlPct: 0,
    virtualTotalPnlPct: round(row.virtualTotalPnlPct, 4),
    shadowTotalPnlPct: round(row.shadowTotalPnlPct, 4),

    grossWinR: round(row.grossWinR, 4),
    grossLossR: round(row.grossLossR, 4),

    realGrossWinR: 0,
    realGrossLossR: 0,
    virtualGrossWinR: round(row.virtualGrossWinR, 4),
    virtualGrossLossR: round(row.virtualGrossLossR, 4),
    shadowGrossWinR: round(row.shadowGrossWinR, 4),
    shadowGrossLossR: round(row.shadowGrossLossR, 4),

    avgR: round(getLearningAvgR(row), 4),
    avgWinR: round(row.avgWinR, 4),
    avgLossR: round(row.avgLossR, 4),

    totalPnlPct: round(row.totalPnlPct, 4),
    avgPnlPct: round(row.avgPnlPct, 4),

    profitFactor: round(getLearningProfitFactor(row), 4),

    directSLCount: round(directSLCount, 4),
    directSLPct: round(
      getLearningPctMetric(
        row,
        'directSLPct',
        'directSLCount',
        'realDirectSLCount',
        'shadowDirectSLCount'
      ),
      4
    ),

    nearTpCount: round(nearTpCount, 4),
    nearTpPct: round(
      getLearningPctMetric(
        row,
        'nearTpPct',
        'nearTpCount',
        'realNearTpCount',
        'shadowNearTpCount'
      ),
      4
    ),

    reachedHalfRCount: round(reachedHalfRCount, 4),
    reachedOneRCount: round(reachedOneRCount, 4),
    reachedHalfRPct: round(
      getLearningPctMetric(
        row,
        'reachedHalfRPct',
        'reachedHalfRCount',
        'realReachedHalfRCount',
        'shadowReachedHalfRCount'
      ),
      4
    ),
    reachedOneRPct: round(
      getLearningPctMetric(
        row,
        'reachedOneRPct',
        'reachedOneRCount',
        'realReachedOneRCount',
        'shadowReachedOneRCount'
      ),
      4
    ),

    beWouldExitCount: round(beWouldExitCount, 4),
    beWouldExitPct: round(
      getLearningPctMetric(
        row,
        'beWouldExitPct',
        'beWouldExitCount',
        'realBeWouldExitCount',
        'shadowBeWouldExitCount'
      ),
      4
    ),

    gaveBackAfterHalfRCount: round(gaveBackAfterHalfRCount, 4),
    gaveBackAfterOneRCount: round(gaveBackAfterOneRCount, 4),
    gaveBackAfterHalfRPct: round(
      getLearningPctMetric(
        row,
        'gaveBackAfterHalfRPct',
        'gaveBackAfterHalfRCount',
        'realGaveBackAfterHalfRCount',
        'shadowGaveBackAfterHalfRCount'
      ),
      4
    ),
    gaveBackAfterOneRPct: round(
      getLearningPctMetric(
        row,
        'gaveBackAfterOneRPct',
        'gaveBackAfterOneRCount',
        'realGaveBackAfterOneRCount',
        'shadowGaveBackAfterOneRCount'
      ),
      4
    ),

    nearTpThenLossCount: round(nearTpThenLossCount, 4),
    nearTpThenLossPct: round(
      getLearningPctMetric(
        row,
        'nearTpThenLossPct',
        'nearTpThenLossCount',
        'realNearTpThenLossCount',
        'shadowNearTpThenLossCount'
      ),
      4
    ),

    totalCostR: round(getLearningTotalCostR(row), 4),
    avgCostR: round(getLearningAvgCostR(row), 4),
    realTotalCostR: 0,
    virtualTotalCostR: round(row.virtualTotalCostR, 4),
    shadowTotalCostR: round(row.shadowTotalCostR, 4),

    aggregateTotalR: round(row.totalR, 4),
    aggregateCompleted: round(row.completed, 4),
    aggregateWins: round(row.wins, 4),
    aggregateLosses: round(row.losses, 4),
    aggregateFlats: round(row.flats, 4),
    aggregateDirectSLPct: round(row.directSLPct, 4),
    aggregateNearTpPct: round(row.nearTpPct, 4),
    aggregateAvgCostR: round(row.avgCostR, 4),

    sampleReliabilityOld: round(row.sampleReliability, 4),
    balancedScore: round(row.balancedScore, 4),
    dashboardBalancedScore: round(getDashboardBalancedScore(row), 4),

    definition: row.definition || null,
    definitionParts,

    macroDefinition: row.macroDefinition || row.parentDefinition || null,
    macroDefinitionParts,

    microDefinition: row.microDefinition || row.definition || null,
    microDefinitionParts: Array.isArray(row.microDefinitionParts)
      ? row.microDefinitionParts
      : definitionParts,

    executionFingerprintHash: row.executionFingerprintHash || null,
    executionFingerprintParts: Array.isArray(row.executionFingerprintParts)
      ? row.executionFingerprintParts
      : [],
    executionFingerprintSchema: row.executionFingerprintSchema || null,
    executionMicroFamilyId: row.executionMicroFamilyId || null,
    executionFingerprintRole: row.executionFingerprintRole || 'METADATA_ONLY',

    counters: row.counters || {},

    examples: Array.isArray(row.examples)
      ? row.examples.filter((example) => !example || typeof example !== 'object' || isTargetSide(example))
      : [],

    recentOutcomes: Array.isArray(row.recentOutcomes)
      ? row.recentOutcomes.filter((outcome) => !outcome || typeof outcome !== 'object' || isTargetSide(outcome))
      : [],

    assetClass: row.assetClass || null,

    rsiZone: row.rsiZone || null,
    rsiCoarse: row.rsiCoarse || null,
    rsiSlope: row.rsiSlope ?? null,
    rsiVelocity: row.rsiVelocity ?? null,
    rsiDelta: row.rsiDelta ?? null,
    rsiMomentum: row.rsiMomentum ?? null,

    flow: row.flow || null,
    flowCoarse: row.flowCoarse || null,

    obRelation: row.obRelation || null,
    obBias: row.obBias ?? null,
    obImbalance: row.obImbalance ?? null,
    orderbookImbalance: row.orderbookImbalance ?? null,
    bookImbalance: row.bookImbalance ?? null,
    bidAskImbalance: row.bidAskImbalance ?? null,

    spoofScore: row.spoofScore ?? null,
    orderbookSpoofScore: row.orderbookSpoofScore ?? null,
    obSpoofScore: row.obSpoofScore ?? null,
    fakeLiquidityScore: row.fakeLiquidityScore ?? null,

    btcState: row.btcState || null,
    btcRelation: row.btcRelation || null,

    regime: row.regime || null,
    regimeCoarse: row.regimeCoarse || null,

    scannerReason: row.scannerReason || null,
    scannerReasonCoarse: row.scannerReasonCoarse || null,

    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };

  const learningTier = getLearningTier(normalized);

  return {
    ...normalized,
    learningTier,
    tier: learningTier,
    status: getLearningStatus({
      ...normalized,
      tier: learningTier
    })
  };
}

function compactRow(row) {
  if (!row) return null;
  if (!isTargetSide(row)) return null;

  return {
    microFamilyId: row.microFamilyId,
    trueMicroFamilyId: row.trueMicroFamilyId || row.microFamilyId,
    coarseMicroFamilyId: row.coarseMicroFamilyId || row.trueMicroFamilyId || row.microFamilyId,
    familyId: row.familyId,
    macroFamilyId: row.macroFamilyId,

    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    weekResetDisabled: true,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    virtualLearningForced: true,

    learningOutcomesOnly: true,
    virtualOutcomesIncluded: true,
    shadowOutcomesIncluded: true,
    realOutcomesExcluded: true,
    outcomesSourceMode: 'VIRTUAL_AND_SHADOW_NET_OUTCOMES',
    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winrateDefinition: 'netR > 0',

    active: Boolean(row.active),
    macroActive: Boolean(row.macroActive),

    tier: row.tier,
    learningTier: row.learningTier,
    status: row.status,

    seen: row.seen,
    observations: row.observations,

    completed: row.completed,
    realCompleted: 0,
    virtualCompleted: row.virtualCompleted,
    shadowCompleted: row.shadowCompleted,

    outcomeSample: row.outcomeSample,
    observationSample: row.observationSample,
    awaitingOutcomes: row.awaitingOutcomes,

    winrateSample: row.winrateSample,
    winrate: row.winrate,
    fairWinrate: row.fairWinrate,
    sampleAdjustedWinrate: row.sampleAdjustedWinrate,
    sampleWilsonLowerBound: row.sampleWilsonLowerBound,
    sampleReliability: row.sampleReliability,

    avgR: row.avgR,
    totalR: row.totalR,
    realTotalR: 0,
    virtualTotalR: row.virtualTotalR,
    shadowTotalR: row.shadowTotalR,
    profitFactor: row.profitFactor,

    directSLPct: row.directSLPct,
    avgCostR: row.avgCostR,

    balancedScore: row.balancedScore,
    dashboardBalancedScore: row.dashboardBalancedScore
  };
}

function buildDetailSummary(row) {
  return {
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    weekResetDisabled: true,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    virtualLearningForced: true,

    learningOutcomesOnly: true,
    virtualOutcomesIncluded: true,
    shadowOutcomesIncluded: true,
    realOutcomesExcluded: true,
    outcomesSourceMode: 'VIRTUAL_AND_SHADOW_NET_OUTCOMES',
    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winrateDefinition: 'netR > 0',

    microFamilyId: row.microFamilyId,
    trueMicroFamilyId: row.trueMicroFamilyId || row.microFamilyId,
    coarseMicroFamilyId: row.coarseMicroFamilyId || row.trueMicroFamilyId || row.microFamilyId,
    familyId: row.familyId,
    macroFamilyId: row.macroFamilyId,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    active: row.active,
    macroActive: row.macroActive,

    tier: row.tier,
    learningTier: row.learningTier,
    status: row.status,

    seen: row.seen,
    observations: row.observations,

    completed: row.completed,
    realCompleted: 0,
    virtualCompleted: row.virtualCompleted,
    shadowCompleted: row.shadowCompleted,

    outcomeSample: row.outcomeSample,
    observationSample: row.observationSample,
    awaitingOutcomes: row.awaitingOutcomes,

    winrateSample: row.winrateSample,
    fairWinrate: row.fairWinrate,
    winrate: row.winrate,
    sampleAdjustedWinrate: row.sampleAdjustedWinrate,
    sampleWilsonLowerBound: row.sampleWilsonLowerBound,
    sampleReliability: row.sampleReliability,

    avgR: row.avgR,
    totalR: row.totalR,
    realTotalR: 0,
    virtualTotalR: row.virtualTotalR,
    shadowTotalR: row.shadowTotalR,
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
  const longRows = rows.filter(isTargetSide);

  const completed = longRows.reduce((sum, row) => sum + num(row.outcomeSample, 0), 0);
  const totalR = longRows.reduce((sum, row) => sum + num(row.totalR, 0), 0);
  const totalCostR = longRows.reduce((sum, row) => sum + num(row.totalCostR, 0), 0);
  const seen = longRows.reduce((sum, row) => sum + num(row.seen, 0), 0);
  const observations = longRows.reduce((sum, row) => sum + num(row.observations, 0), 0);
  const observationSample = longRows.reduce((sum, row) => sum + num(row.observationSample, 0), 0);
  const winrateSample = longRows.reduce((sum, row) => sum + num(row.winrateSample, 0), 0);

  const virtualCompleted = longRows.reduce((sum, row) => sum + num(row.virtualCompleted, 0), 0);
  const shadowCompleted = longRows.reduce((sum, row) => sum + num(row.shadowCompleted, 0), 0);

  const activeRows = longRows.filter((row) => row.active);
  const macroActiveRows = longRows.filter((row) => row.macroActive);

  const bestBalanced = bestBy(longRows, compareNormalizedBalanced);
  const bestWinrate = bestBy(longRows, compareNormalizedWinrate);
  const bestTotalR = bestBy(longRows, compareNormalizedTotalR);
  const bestAvgR = bestBy(longRows, compareNormalizedAvgR);
  const lowestDirectSL = bestBy(longRows, compareNormalizedDirectSL);

  const tierCounts = longRows.reduce((acc, row) => {
    const tier = row.tier || row.learningTier || 'RAW';

    acc[tier] = (acc[tier] || 0) + 1;

    return acc;
  }, {});

  return {
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    weekResetDisabled: true,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    virtualLearningForced: true,

    learningOutcomesOnly: true,
    virtualOutcomesIncluded: true,
    shadowOutcomesIncluded: true,
    realOutcomesExcluded: true,
    outcomesSourceMode: 'VIRTUAL_AND_SHADOW_NET_OUTCOMES',
    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winrateDefinition: 'netR > 0',

    macroFamilyId,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    microFamilies: longRows.length,
    activeMicroFamilies: activeRows.length,
    macroActiveMicroFamilies: macroActiveRows.length,

    tierCounts,

    seen: round(seen, 4),
    observations: round(observations, 4),

    completed: round(completed, 4),
    realCompleted: 0,
    virtualCompleted: round(virtualCompleted, 4),
    shadowCompleted: round(shadowCompleted, 4),

    observationSample: round(observationSample, 4),
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

function rowId(row = {}, key = '') {
  return String(
    row.trueMicroFamilyId ||
    row.microFamilyId ||
    row.id ||
    row.key ||
    key ||
    ''
  ).trim();
}

function findRawRow(micros = {}, id) {
  if (!id) return null;

  const decodedId = safeDecode(id);
  const candidates = uniqueStrings([id, decodedId])
    .filter((candidateId) => !isScannerFingerprintId(candidateId))
    .filter((candidateId) => !isExplicitShort(candidateId));

  for (const candidateId of candidates) {
    if (
      micros[candidateId] &&
      isTargetSide({
        ...micros[candidateId],
        microFamilyId: micros[candidateId]?.microFamilyId || candidateId
      })
    ) {
      return {
        key: candidateId,
        row: micros[candidateId]
      };
    }
  }

  const found = Object.entries(micros || {}).find(([key, row]) => {
    const microFamilyId = rowId(row, key);

    return candidates.includes(microFamilyId) && isTargetSide({
      ...row,
      microFamilyId
    });
  });

  if (!found) return null;

  return {
    key: found[0],
    row: found[1]
  };
}

function normalizeAllRows(micros = {}, activeSet, activeMacroSet) {
  return Object.entries(micros || {})
    .map(([key, row]) => ({
      key,
      row,
      id: rowId(row, key)
    }))
    .filter(({ row, id }) => id && !isScannerFingerprintId(id) && isTargetSide({
      ...row,
      microFamilyId: id
    }))
    .map(({ key, row }) => (
      normalizeMicroRow(key, row, {
        activeSet,
        activeMacroSet
      })
    ))
    .filter(isTargetSide);
}

function getMacroRows(rows = [], id) {
  const decodedId = safeDecode(id);
  const ids = uniqueStrings([id, decodedId])
    .filter((candidateId) => !isScannerFingerprintId(candidateId));

  return rows.filter((row) => (
    isTargetSide(row) &&
    (
      ids.includes(row.macroFamilyId) ||
      ids.includes(row.parentMacroFamilyId) ||
      ids.includes(row.parentMicroFamilyId) ||
      ids.includes(row.familyId)
    )
  ));
}

function sortRelatedRows(rows = []) {
  return [...rows]
    .filter(isTargetSide)
    .sort(compareNormalizedBalanced);
}

function buildActiveLongRows(activeRotation, activeSet, activeMacroSet) {
  const rows = Array.isArray(activeRotation?.microFamilies)
    ? activeRotation.microFamilies
    : [];

  return rows
    .filter(isTargetSide)
    .map((row, index) => normalizeMicroRow(
      row.trueMicroFamilyId || row.microFamilyId || row.id || row.key || `active_${index}`,
      {
        ...row,
        active: true
      },
      {
        activeSet,
        activeMacroSet
      }
    ))
    .filter(isTargetSide);
}

function findNormalizedRow(rows = [], id) {
  const decodedId = safeDecode(id);
  const ids = uniqueStrings([id, decodedId])
    .filter((candidateId) => !isScannerFingerprintId(candidateId));

  return rows.find((row) => (
    ids.includes(row.microFamilyId) ||
    ids.includes(row.trueMicroFamilyId) ||
    ids.includes(row.id) ||
    ids.includes(row.key)
  )) || null;
}

function idLooksShort(id = '') {
  return isExplicitShort(id);
}

function baseModePayload() {
  return {
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    weekResetDisabled: true,
    isoWeekLearningDisabled: true,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    legacyUnknownRowsTreatedAsLong: true,

    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    virtualLearningForced: true,
    globalMaxOpenPositionsBlockDisabled: true,
    maxOneOpenPositionPerSymbol: true,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,

    learningOutcomesOnly: true,
    virtualOutcomesIncluded: true,
    shadowOutcomesIncluded: true,
    realOutcomesExcluded: true,
    outcomesSourceMode: 'VIRTUAL_AND_SHADOW_NET_OUTCOMES',
    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winrateDefinition: 'netR > 0'
  };
}

async function getActiveRotationSafe() {
  try {
    return await getActiveRotation();
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Micro-Family-Mode', 'long-only-persistent-learning-outcome-detail-v5');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Long-Only', 'true');
  res.setHeader('X-Short-Disabled', 'true');
  res.setHeader('X-Learning-Outcomes-Only', 'true');
  res.setHeader('X-Virtual-Outcomes-Included', 'true');
  res.setHeader('X-Shadow-Outcomes-Included', 'true');
  res.setHeader('X-Real-Outcomes-Excluded', 'true');
  res.setHeader('X-Real-Orders-Disabled', 'true');
  res.setHeader('X-Bitget-Orders-Disabled', 'true');
  res.setHeader('X-Persistent-Learning-Key', PERSISTENT_LEARNING_KEY);
  res.setHeader('X-Week-Reset-Disabled', 'true');

  if (req.method !== 'GET') {
    return methodNotAllowed(res);
  }

  try {
    const id = safeDecode(firstQueryValue(req.query?.id, null));
    const requestedQueryWeekKey = String(
      firstQueryValue(req.query?.weekKey, PERSISTENT_LEARNING_KEY) || PERSISTENT_LEARNING_KEY
    ).trim();

    const weekKey = PERSISTENT_LEARNING_KEY;
    const currentWeekKey = PERSISTENT_LEARNING_KEY;
    const previousWeekKey = PERSISTENT_LEARNING_KEY;

    const relatedLimit = toSafeLimit(firstQueryValue(req.query?.relatedLimit, 100), 100);

    if (!id) {
      return res.status(400).json({
        ok: false,
        error: 'MICRO_FAMILY_ID_REQUIRED',
        weekKey,
        currentWeekKey,
        previousWeekKey,
        requestedQueryWeekKey,
        ...baseModePayload()
      });
    }

    if (idLooksShort(id) || isScannerFingerprintId(id)) {
      return res.status(404).json({
        ok: false,
        reason: isScannerFingerprintId(id)
          ? 'SCANNER_FINGERPRINT_METADATA_ONLY_NOT_LEARNING_FAMILY'
          : 'SHORT_DISABLED_LONG_ONLY',
        id,
        weekKey,
        currentWeekKey,
        previousWeekKey,
        requestedQueryWeekKey,
        ignoredQueryWeekKey: requestedQueryWeekKey !== PERSISTENT_LEARNING_KEY
          ? requestedQueryWeekKey
          : null,
        ...baseModePayload()
      });
    }

    const [micros, activeRotation] = await Promise.all([
      getWeekMicros(weekKey),
      getActiveRotationSafe()
    ]);

    const activeIds = extractActiveIds(activeRotation);
    const activeMacroIds = extractActiveMacroIds(activeRotation);

    const activeSet = new Set(activeIds);
    const activeMacroSet = new Set(activeMacroIds);

    const allRows = normalizeAllRows(micros, activeSet, activeMacroSet);
    const activeRows = buildActiveLongRows(activeRotation, activeSet, activeMacroSet);

    const rawMatch = findRawRow(micros, id);
    const activeMatch = findNormalizedRow(activeRows, id);

    const commonResponse = {
      ...baseModePayload(),

      id,
      weekKey,
      currentWeekKey,
      previousWeekKey,
      requestedQueryWeekKey,
      ignoredQueryWeekKey: requestedQueryWeekKey !== PERSISTENT_LEARNING_KEY
        ? requestedQueryWeekKey
        : null
    };

    if (!rawMatch && activeMatch) {
      const macroFamilyId = activeMatch.macroFamilyId || activeMatch.familyId || null;

      const relatedMicroFamilies = macroFamilyId
        ? sortRelatedRows(
          [...allRows, ...activeRows].filter((candidate) => (
            candidate.microFamilyId !== activeMatch.microFamilyId &&
            candidate.macroFamilyId === macroFamilyId
          ))
        ).slice(0, relatedLimit)
        : [];

      const macroRows = macroFamilyId
        ? sortRelatedRows(
          [...allRows, ...activeRows].filter((candidate) => candidate.macroFamilyId === macroFamilyId)
        )
        : [activeMatch];

      return res.status(200).json({
        ok: true,

        type: 'MICRO_FAMILY_DETAIL_ACTIVE_ONLY',

        ...commonResponse,

        activeRotationId: activeRotation?.rotationId || null,
        active: activeMatch.active,
        macroActive: activeMatch.macroActive,

        summary: buildDetailSummary(activeMatch),
        macroSummary: buildMacroSummary(macroRows, macroFamilyId),

        row: activeMatch,

        macroFamilyId,
        relatedMicroFamilies,

        activeMicroFamilyIds: activeIds,
        activeMacroFamilyIds: activeMacroIds,

        availableCount: allRows.length,
        rawAvailableCount: Object.keys(micros || {}).length,

        serverTs: Date.now()
      });
    }

    if (!rawMatch) {
      const macroRows = sortRelatedRows([
        ...getMacroRows(allRows, id),
        ...getMacroRows(activeRows, id)
      ])
        .slice(0, relatedLimit);

      if (macroRows.length > 0) {
        return res.status(200).json({
          ok: true,

          type: 'MACRO_FAMILY_DETAIL',

          ...commonResponse,

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

          availableCount: allRows.length,
          rawAvailableCount: Object.keys(micros || {}).length,
          serverTs: Date.now()
        });
      }

      return res.status(404).json({
        ok: false,
        reason: 'LONG_MICRO_OR_MACRO_FAMILY_NOT_FOUND',

        ...commonResponse,

        availableCount: allRows.length,
        rawAvailableCount: Object.keys(micros || {}).length,
        activeRotationId: activeRotation?.rotationId || null
      });
    }

    const row = normalizeMicroRow(rawMatch.key, rawMatch.row, {
      activeSet,
      activeMacroSet
    });

    if (!isTargetSide(row)) {
      return res.status(404).json({
        ok: false,
        reason: 'SHORT_DISABLED_LONG_ONLY',

        ...commonResponse
      });
    }

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

      ...commonResponse,

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

      availableCount: allRows.length,
      rawAvailableCount: Object.keys(micros || {}).length,

      serverTs: Date.now()
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,

      ...baseModePayload(),

      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}