// ================= FILE: api/admin/micro-family/[id].js =================

import {
  sideToTradeSide,
  safeNumber
} from '../../../src/utils.js';
import { getWeekMicros } from '../../../src/analyze/analyzeEngine.js';
import { getActiveRotation } from '../../../src/analyze/rotationEngine.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const TARGET_SCANNER_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY';
const LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';

const WINRATE_Z = 1.96;
const WINRATE_BAYES_ALPHA = 1;
const WINRATE_BAYES_BETA = 1;
const SAMPLE_RELIABILITY_CAP = 50;
const MIN_COMPLETED_ACTIVE_LEARNING = 20;

const LONG_FIXED_SETUP_TYPES = new Set([
  'BREAKOUT',
  'RETEST',
  'SWEEP_REVERSAL',
  'CONTINUATION',
  'COMPRESSION'
]);

const LONG_FIXED_REGIME_BUCKETS = new Set([
  'TREND',
  'CHOP',
  'SQUEEZE'
]);

const LONG_CONFIRMATION_PROFILES = new Set([
  'A_STRONG_ALIGN',
  'B_FLOW_ALIGN',
  'C_VOLUME_ALIGN',
  'D_MIXED_OK',
  'E_WEAK_CONTRA'
]);

const CONFIRMATION_PROFILE_ORDER = [
  'A_STRONG_ALIGN',
  'B_FLOW_ALIGN',
  'C_VOLUME_ALIGN',
  'D_MIXED_OK',
  'E_WEAK_CONTRA'
];

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

function flattenValues(values = []) {
  const stack = Array.isArray(values) ? [...values] : [values];
  const output = [];

  while (stack.length > 0) {
    const value = stack.shift();

    if (Array.isArray(value)) {
      stack.unshift(...value);
      continue;
    }

    output.push(value);
  }

  return output;
}

function uniqueStrings(values = []) {
  return [...new Set(
    flattenValues(values)
      .flatMap((value) => {
        if (typeof value === 'string') {
          return value
            .split(/[\s,;\n\r]+/g)
            .map((part) => part.trim());
        }

        return [value];
      })
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function getArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanSideHaystack(text = '') {
  return upper(text)
    .replaceAll('SHORT_DISABLED_FALSE', '')
    .replaceAll('SHORTDISABLED_FALSE', '')
    .replaceAll('BLOCK_SHORT_FALSE', '')
    .replaceAll('SHORT_ENABLED_FALSE', '')
    .replaceAll('SHORT_ONLY_FALSE', '')
    .replaceAll('LONG_DISABLED_FALSE', '')
    .replaceAll('SHORT_DISABLED_LONG_ONLY', '')
    .replaceAll('SHORTDISABLED_LONG_ONLY', '')
    .replaceAll('BLOCK_SHORT', '')
    .replaceAll('SHORT_DISABLED', '')
    .replaceAll('SHORTDISABLED', '')
    .replaceAll('LONG_ONLY_MODE', 'LONG')
    .replaceAll('LONG_ONLY', 'LONG')
    .replaceAll('LONG-ONLY', 'LONG')
    .replaceAll('SHORT_ONLY_MODE', 'SHORT')
    .replaceAll('SHORT_ONLY', 'SHORT')
    .replaceAll('SHORT-ONLY', 'SHORT');
}

function normalizeSignalText(value = '') {
  return cleanSideHaystack(value)
    .replace(/[^A-Z0-9=:_|]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function hasSignalPattern(value = '', patterns = []) {
  const text = normalizeSignalText(value);

  if (!text) return false;

  return patterns.some((pattern) => (
    text === pattern ||
    text.startsWith(`${pattern}_`) ||
    text.endsWith(`_${pattern}`) ||
    text.includes(`_${pattern}_`) ||
    text.includes(`=${pattern}`) ||
    text.includes(`:${pattern}`) ||
    text.includes(`|${pattern}|`)
  ));
}

function hasLongSignal(text = '') {
  return hasSignalPattern(text, [
    'LONG',
    'BULL',
    'BULLISH',
    'BUY',
    'UP',
    'UPSIDE',
    'MICRO_LONG',
    'SIDE_LONG',
    'SIDE_BULL',
    'SIDE_BUY',
    'TRADE_SIDE_LONG',
    'TRADESIDE_LONG',
    'POSITION_SIDE_LONG',
    'POSITIONSIDE_LONG',
    'DIRECTION_LONG',
    'DIRECTION_BULL',
    'DIRECTION_BUY'
  ]);
}

function hasShortSignal(text = '') {
  return hasSignalPattern(text, [
    'SHORT',
    'BEAR',
    'BEARISH',
    'SELL',
    'DOWN',
    'DOWNSIDE',
    'MICRO_SHORT',
    'SIDE_SHORT',
    'SIDE_BEAR',
    'SIDE_SELL',
    'TRADE_SIDE_SHORT',
    'TRADESIDE_SHORT',
    'POSITION_SIDE_SHORT',
    'POSITIONSIDE_SHORT',
    'DIRECTION_SHORT',
    'DIRECTION_BEAR',
    'DIRECTION_SELL'
  ]);
}

function normalizeSideToken(value) {
  const raw = cleanSideHaystack(value);

  if (!raw) return 'UNKNOWN';

  const direct = sideToTradeSide(raw);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  if (['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'UPSIDE'].includes(raw)) {
    return TARGET_TRADE_SIDE;
  }

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE'].includes(raw)) {
    return OPPOSITE_TRADE_SIDE;
  }

  const longHit = hasLongSignal(raw);
  const shortHit = hasShortSignal(raw);

  if (longHit && !shortHit) return TARGET_TRADE_SIDE;
  if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;

  if (longHit && shortHit) {
    if (raw.includes('TRADE_SIDE=LONG') || raw.includes('TRADESIDE=LONG')) return TARGET_TRADE_SIDE;
    if (raw.includes('TRADE_SIDE=SHORT') || raw.includes('TRADESIDE=SHORT')) return OPPOSITE_TRADE_SIDE;
    if (raw.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
    if (raw.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
  }

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
    input.parentTrueMicroFamilyId,
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

function inferTradeSide(input = {}) {
  if (typeof input === 'string') {
    const direct = normalizeSideToken(input);

    if (direct === TARGET_TRADE_SIDE || direct === OPPOSITE_TRADE_SIDE) return direct;

    const text = collectSideText(input);
    const longHit = hasLongSignal(text);
    const shortHit = hasShortSignal(text);

    if (longHit && !shortHit) return TARGET_TRADE_SIDE;
    if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;
    if (text.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
    if (text.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;

    return 'UNKNOWN';
  }

  if (!input || typeof input !== 'object') return 'UNKNOWN';

  const directSources = [
    input.tradeSide,
    input.positionSide,
    input.direction,
    input.signalSide,
    input.scannerSide,
    input.actualScannerSide,
    input.analysisSide,
    input.entrySide,
    input.side,
    input.bias,
    input.marketBias
  ];

  for (const source of directSources) {
    const normalized = normalizeSideToken(source);

    if (normalized === TARGET_TRADE_SIDE || normalized === OPPOSITE_TRADE_SIDE) {
      return normalized;
    }
  }

  const text = collectSideText(input);
  const longHit = hasLongSignal(text);
  const shortHit = hasShortSignal(text);

  if (longHit && !shortHit) return TARGET_TRADE_SIDE;
  if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;

  const microText = cleanSideHaystack(
    input.trueMicroFamilyId ||
    input.microFamilyId ||
    input.parentTrueMicroFamilyId ||
    input.coarseMicroFamilyId ||
    input.baseMicroFamilyId ||
    input.legacyMicroFamilyId ||
    input.id ||
    input.key
  );

  if (microText.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
  if (microText.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;

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
    value.includes('LONG_SCANNER_') ||
    value.startsWith('MICRO_SHORT_SCANNER__') ||
    value.includes('MICRO_SHORT_SCANNER__') ||
    value.startsWith('SHORT_SCANNER_') ||
    value.includes('SHORT_SCANNER_') ||
    value.includes('__SCANNER__') ||
    value.includes('SCANNER_GATE_PASS') ||
    value.includes('SCANNER_GATE_FAIL')
  );
}

function isExecutionFingerprintId(id = '') {
  const value = upper(id);

  return (
    value.includes('_XR_') ||
    value.includes('__XR__') ||
    value.includes('EXECUTION_FINGERPRINT') ||
    value.includes('EXECUTION_MICRO') ||
    value.includes('REFINED_EXECUTION')
  );
}

function validLearningId(id = '') {
  const value = String(id || '').trim();

  if (!value) return false;
  if (isScannerFingerprintId(value)) return false;
  if (isExecutionFingerprintId(value)) return false;

  return true;
}

function parseLongTaxonomyMicroId(id = '') {
  const value = upper(id);

  if (!value.startsWith('MICRO_LONG_')) {
    return {
      valid: false,
      selectable: false,
      isParent: false,
      isChild: false,
      rawId: String(id || '').trim()
    };
  }

  let body = value.slice('MICRO_LONG_'.length);
  let confirmationProfile = null;

  for (const profile of CONFIRMATION_PROFILE_ORDER) {
    const suffix = `_${profile}`;

    if (body.endsWith(suffix)) {
      confirmationProfile = profile;
      body = body.slice(0, -suffix.length);
      break;
    }
  }

  let setup = null;
  let regime = null;

  for (const candidateRegime of LONG_FIXED_REGIME_BUCKETS) {
    const suffix = `_${candidateRegime}`;

    if (body.endsWith(suffix)) {
      regime = candidateRegime;
      setup = body.slice(0, -suffix.length);
      break;
    }
  }

  const parentId = setup && regime
    ? `MICRO_LONG_${setup}_${regime}`
    : null;

  const childId = parentId && confirmationProfile
    ? `${parentId}_${confirmationProfile}`
    : null;

  const validParent =
    Boolean(parentId) &&
    LONG_FIXED_SETUP_TYPES.has(setup) &&
    LONG_FIXED_REGIME_BUCKETS.has(regime);

  const validChild =
    validParent &&
    Boolean(confirmationProfile) &&
    LONG_CONFIRMATION_PROFILES.has(confirmationProfile);

  return {
    valid: validParent || validChild,
    selectable: validChild,
    isParent: validParent && !validChild,
    isChild: validChild,
    rawId: String(id || '').trim(),
    setup,
    regime,
    confirmationProfile,
    parentTrueMicroFamilyId: validParent ? parentId : null,
    trueMicroFamilyId: validChild ? childId : validParent ? parentId : null,
    childTrueMicroFamilyId: validChild ? childId : null,
    schema: TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY
  };
}

function isFixedLongParentMicroId(id = '') {
  const parsed = parseLongTaxonomyMicroId(id);

  return parsed.valid && parsed.isParent;
}

function isFixedLongChildMicroId(id = '') {
  const parsed = parseLongTaxonomyMicroId(id);

  return parsed.valid && parsed.isChild;
}

function idLooksLong(id = '') {
  const value = String(id || '').trim();

  if (!validLearningId(value)) return false;
  if (parseLongTaxonomyMicroId(value).valid) return true;

  return hasLongSignal(value);
}

function idLooksShort(id = '') {
  const value = String(id || '').trim();

  if (!validLearningId(value)) return false;

  return hasShortSignal(value);
}

function isSelectableTrueMicroId(id = '') {
  const value = String(id || '').trim();

  if (!validLearningId(value)) return false;
  if (idLooksShort(value) && !idLooksLong(value)) return false;

  return isFixedLongChildMicroId(value);
}

function isExplicitShort(input = {}) {
  if (!input) return false;

  if (typeof input === 'string') {
    const value = String(input || '').trim();

    if (!value) return false;
    if (isScannerFingerprintId(value)) return false;
    if (isExecutionFingerprintId(value)) return false;
    if (parseLongTaxonomyMicroId(value).valid) return false;

    return hasShortSignal(value) || upper(value).startsWith('MICRO_SHORT_');
  }

  if (input.shortOnly === true || input.longDisabled === true) return true;

  const side = inferTradeSide(input);

  return side === OPPOSITE_TRADE_SIDE;
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

function getFamilyId(row = {}) {
  return (
    row.familyId ||
    row.family ||
    row.baseFamilyId ||
    null
  );
}

function getMacroFamilyId(row = {}) {
  const taxonomy = normalizeTaxonomyIdentity(row);

  return (
    row.parentTrueMicroFamilyId ||
    row.parentMacroFamilyId ||
    row.macroFamilyId ||
    row.parentMicroFamilyId ||
    row.parentFamilyId ||
    row.macroId ||
    taxonomy.parentTrueMicroFamilyId ||
    row.familyId ||
    null
  );
}

function normalizeTaxonomyIdentity(row = {}, fallbackId = '') {
  const ids = uniqueStrings([
    row.trueMicroFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.microFamilyId,
    row.id,
    row.key,
    fallbackId,
    row.parentTrueMicroFamilyId,
    row.coarseMicroFamilyId,
    row.baseMicroFamilyId,
    row.legacyMicroFamilyId
  ]);

  const childId = ids.find(isFixedLongChildMicroId);
  const parentId = ids.find(isFixedLongParentMicroId);
  const anyLongId = ids.find((id) => parseLongTaxonomyMicroId(id).valid);

  const parsed = parseLongTaxonomyMicroId(childId || parentId || anyLongId || '');

  const trueMicroFamilyId = parsed.trueMicroFamilyId || childId || parentId || anyLongId || null;
  const parentTrueMicroFamilyId =
    parsed.parentTrueMicroFamilyId ||
    row.parentTrueMicroFamilyId ||
    row.coarseMicroFamilyId ||
    row.baseMicroFamilyId ||
    row.legacyMicroFamilyId ||
    null;

  return {
    ...parsed,
    trueMicroFamilyId,
    microFamilyId: trueMicroFamilyId,
    parentTrueMicroFamilyId,
    coarseMicroFamilyId: parentTrueMicroFamilyId || trueMicroFamilyId,
    baseMicroFamilyId: parentTrueMicroFamilyId || trueMicroFamilyId,
    legacyMicroFamilyId: parentTrueMicroFamilyId || trueMicroFamilyId,
    fixedTaxonomyParentId: Boolean(parentTrueMicroFamilyId && isFixedLongParentMicroId(parentTrueMicroFamilyId)),
    fixedTaxonomyChildId: Boolean(trueMicroFamilyId && isFixedLongChildMicroId(trueMicroFamilyId)),
    selectable: Boolean(trueMicroFamilyId && isSelectableTrueMicroId(trueMicroFamilyId)),
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY
  };
}

function isTargetSide(row = {}) {
  if (!row) return false;

  const id = rowId(row);

  if (id && !validLearningId(id)) return false;
  if (isScannerFingerprintId(row.trueMicroFamilyId)) return false;
  if (isScannerFingerprintId(row.microFamilyId)) return false;
  if (isScannerFingerprintId(row.coarseMicroFamilyId)) return false;
  if (isExecutionFingerprintId(row.trueMicroFamilyId)) return false;
  if (isExecutionFingerprintId(row.microFamilyId)) return false;

  if (isExplicitShort(row)) return false;

  const identity = normalizeTaxonomyIdentity(row, id);

  if (identity.trueMicroFamilyId && parseLongTaxonomyMicroId(identity.trueMicroFamilyId).valid) {
    return true;
  }

  return inferTradeSide(row) === TARGET_TRADE_SIDE;
}

function isLearningOutcomeSource(source = '') {
  const value = upper(source || 'VIRTUAL');

  return value === 'VIRTUAL' || value === 'SHADOW';
}

function outcomeNetR(row = {}) {
  return num(
    row.netR ??
    row.exitR ??
    row.realizedNetR ??
    row.realizedR ??
    row.r,
    0
  );
}

function aggregateRecentOutcomes(row = {}) {
  const outcomes = Array.isArray(row.recentOutcomes)
    ? row.recentOutcomes
    : [];

  return outcomes.reduce(
    (acc, outcome) => {
      const source = upper(outcome.source || outcome.outcomeSource || 'VIRTUAL');

      if (!isLearningOutcomeSource(source)) return acc;
      if (outcome && typeof outcome === 'object' && !isTargetSide({ ...row, ...outcome })) return acc;

      const netR = outcomeNetR(outcome);
      const costR = num(outcome.costR ?? outcome.avgCostR, 0);

      acc.completed += 1;
      acc.totalR += netR;
      acc.totalCostR += costR;

      if (netR > 0) {
        acc.wins += 1;
        acc.grossWinR += netR;
      } else if (netR < 0) {
        acc.losses += 1;
        acc.grossLossR += Math.abs(netR);
      } else {
        acc.flats += 1;
      }

      return acc;
    },
    {
      completed: 0,
      wins: 0,
      losses: 0,
      flats: 0,
      totalR: 0,
      totalCostR: 0,
      grossWinR: 0,
      grossLossR: 0
    }
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

function hasSourceBuckets(row = {}) {
  return (
    num(row.virtualCompleted, 0) > 0 ||
    num(row.shadowCompleted, 0) > 0 ||
    num(row.virtualWins, 0) > 0 ||
    num(row.virtualLosses, 0) > 0 ||
    num(row.virtualFlats, 0) > 0 ||
    num(row.shadowWins, 0) > 0 ||
    num(row.shadowLosses, 0) > 0 ||
    num(row.shadowFlats, 0) > 0
  );
}

function aggregateBucketsAreLearningSafe(row = {}) {
  const completedDefinition = upper(row.completedDefinition);
  const scoringRSource = upper(row.scoringRSource);
  const winrateDefinition = upper(row.winrateDefinition);

  return (
    completedDefinition === '' ||
    completedDefinition === 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES' ||
    scoringRSource === 'NETR' ||
    scoringRSource === 'NET_R' ||
    winrateDefinition.includes('NETR') ||
    winrateDefinition.includes('NETR > 0') ||
    winrateDefinition.includes('NET_R')
  );
}

function getLearningOutcomeCounts(row = {}) {
  const recent = aggregateRecentOutcomes(row);

  const virtualCompleted = getVirtualCompleted(row);
  const shadowCompleted = getShadowCompleted(row);

  if (hasSourceBuckets(row)) {
    const wins = num(row.virtualWins, 0) + num(row.shadowWins, 0);
    const losses = num(row.virtualLosses, 0) + num(row.shadowLosses, 0);
    const flats = num(row.virtualFlats, 0) + num(row.shadowFlats, 0);

    const completed = Math.max(
      virtualCompleted + shadowCompleted,
      wins + losses + flats,
      recent.completed
    );

    return {
      wins,
      losses,
      flats: Math.max(flats, completed - wins - losses),
      total: completed
    };
  }

  if (recent.completed > 0) {
    return {
      wins: recent.wins,
      losses: recent.losses,
      flats: recent.flats,
      total: recent.completed
    };
  }

  if (aggregateBucketsAreLearningSafe(row)) {
    const wins = num(row.wins, 0);
    const losses = num(row.losses, 0);
    const flats = num(row.flats, 0);
    const completed = Math.max(
      num(row.completed, 0),
      num(row.outcomeSample, 0),
      wins + losses + flats,
      0
    );

    return {
      wins,
      losses,
      flats: Math.max(flats, completed - wins - losses),
      total: completed
    };
  }

  return {
    wins: 0,
    losses: 0,
    flats: 0,
    total: 0
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

function getLearningTotalR(row = {}) {
  const completed = getCompletedSample(row);
  const recent = aggregateRecentOutcomes(row);

  if (completed <= 0) return 0;

  if (hasValue(row.netTotalR)) return num(row.netTotalR, 0);
  if (hasValue(row.totalNetR)) return num(row.totalNetR, 0);

  if (hasSourceBuckets(row)) {
    return num(row.virtualTotalR, 0) + num(row.shadowTotalR, 0);
  }

  if (recent.completed > 0) return recent.totalR;

  if (aggregateBucketsAreLearningSafe(row) && hasValue(row.totalR)) {
    return num(row.totalR, 0);
  }

  return num(row.virtualTotalR, 0) + num(row.shadowTotalR, 0);
}

function getLearningTotalCostR(row = {}) {
  const completed = getCompletedSample(row);
  const recent = aggregateRecentOutcomes(row);

  if (completed <= 0) return 0;

  if (hasSourceBuckets(row)) {
    return num(row.virtualTotalCostR, 0) + num(row.shadowTotalCostR, 0);
  }

  if (recent.completed > 0) return recent.totalCostR;

  if (hasValue(row.totalCostR) && aggregateBucketsAreLearningSafe(row)) {
    return num(row.totalCostR, 0);
  }

  return num(row.virtualTotalCostR, 0) + num(row.shadowTotalCostR, 0);
}

function getLearningAvgR(row = {}) {
  const completed = getCompletedSample(row);
  const totalR = getLearningTotalR(row);

  if (completed > 0) return totalR / completed;

  return 0;
}

function getLearningAvgCostR(row = {}) {
  const completed = getCompletedSample(row);
  const totalCostR = getLearningTotalCostR(row);

  if (completed > 0) return totalCostR / completed;

  return 0;
}

function getPositiveR(row = {}, aggregateKey, virtualKey = null, shadowKey = null) {
  if (hasValue(row[aggregateKey]) && aggregateBucketsAreLearningSafe(row)) {
    return Math.max(0, num(row[aggregateKey], 0));
  }

  return Math.max(
    0,
    num(virtualKey ? row[virtualKey] : 0, 0) +
      num(shadowKey ? row[shadowKey] : 0, 0)
  );
}

function getAbsLossR(row = {}, aggregateKey, virtualKey = null, shadowKey = null) {
  if (hasValue(row[aggregateKey]) && aggregateBucketsAreLearningSafe(row)) {
    return Math.abs(num(row[aggregateKey], 0));
  }

  return Math.abs(
    num(virtualKey ? row[virtualKey] : 0, 0) +
      num(shadowKey ? row[shadowKey] : 0, 0)
  );
}

function getLearningProfitFactor(row = {}) {
  if (hasValue(row.netProfitFactor)) return num(row.netProfitFactor, 0);
  if (hasValue(row.profitFactor) && aggregateBucketsAreLearningSafe(row)) return num(row.profitFactor, 0);

  const winR = Math.max(
    getPositiveR(row, 'netWinR', 'virtualNetWinR', 'shadowNetWinR'),
    getPositiveR(row, 'totalWinR', 'virtualTotalWinR', 'shadowTotalWinR'),
    getPositiveR(row, 'grossWinR', 'virtualGrossWinR', 'shadowGrossWinR'),
    0
  );

  const lossR = Math.max(
    getAbsLossR(row, 'netLossR', 'virtualNetLossR', 'shadowNetLossR'),
    getAbsLossR(row, 'totalLossR', 'virtualTotalLossR', 'shadowTotalLossR'),
    getAbsLossR(row, 'grossLossR', 'virtualGrossLossR', 'shadowGrossLossR'),
    0
  );

  if (winR <= 0 && lossR <= 0) return 0;
  if (lossR <= 0) return winR > 0 ? 999 : 0;

  return winR / lossR;
}

function getLearningCountMetric(row = {}, aggregateCountKey, virtualCountKey = null, shadowCountKey = null) {
  if (hasValue(row[aggregateCountKey]) && aggregateBucketsAreLearningSafe(row)) {
    return num(row[aggregateCountKey], 0);
  }

  return num(virtualCountKey ? row[virtualCountKey] : 0, 0) +
    num(shadowCountKey ? row[shadowCountKey] : 0, 0);
}

function getLearningPctMetric(row = {}, aggregatePctKey, aggregateCountKey, virtualCountKey = null, shadowCountKey = null) {
  if (hasValue(row[aggregatePctKey]) && aggregateBucketsAreLearningSafe(row)) {
    return clamp(row[aggregatePctKey], 0, 1);
  }

  const completed = getCompletedSample(row);
  const count = getLearningCountMetric(
    row,
    aggregateCountKey,
    virtualCountKey,
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

  const successes = counts.wins;
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
    'virtualDirectSLCount',
    'shadowDirectSLCount'
  );

  const nearTpThenLossPct = getLearningPctMetric(
    row,
    'nearTpThenLossPct',
    'nearTpThenLossCount',
    'virtualNearTpThenLossCount',
    'shadowNearTpThenLossCount'
  );

  const gaveBackAfterOneRPct = getLearningPctMetric(
    row,
    'gaveBackAfterOneRPct',
    'gaveBackAfterOneRCount',
    'virtualGaveBackAfterOneRCount',
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
    avgCostR * 8;

  return (
    winrateComponent +
    reliabilityComponent +
    totalRComponent +
    avgRComponent +
    pfComponent -
    riskPenalty
  );
}

function getLearningStatus(row = {}) {
  const completed = num(row.outcomeSample, getCompletedSample(row));

  if (completed <= 0) return 'OBSERVING';
  if (completed < MIN_COMPLETED_ACTIVE_LEARNING) return 'EARLY_OUTCOMES';

  return 'ACTIVE_LEARNING';
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
    activeParentSet = new Set()
  } = {}
) {
  const identity = normalizeTaxonomyIdentity(row, id);
  const rawMicroFamilyId = row.trueMicroFamilyId || row.microFamilyId || row.id || row.key || id;
  const trueMicroFamilyId = identity.trueMicroFamilyId || rawMicroFamilyId;
  const parentTrueMicroFamilyId = identity.parentTrueMicroFamilyId || row.parentTrueMicroFamilyId || null;
  const coarseMicroFamilyId = identity.coarseMicroFamilyId || parentTrueMicroFamilyId || trueMicroFamilyId;

  const familyId = getFamilyId(row);
  const macroFamilyId = getMacroFamilyId({
    ...row,
    parentTrueMicroFamilyId,
    coarseMicroFamilyId
  });

  const winrateMeta = getSampleAdjustedWinrate(row);
  const definitionParts = getDefinitionParts(row);
  const macroDefinitionParts = getMacroDefinitionParts(row);

  const active = Boolean(row.active) || (
    trueMicroFamilyId
      ? activeSet.has(trueMicroFamilyId)
      : false
  );

  const parentActive = Boolean(row.parentActive) || Boolean(row.macroActive) || (
    parentTrueMicroFamilyId
      ? activeParentSet.has(parentTrueMicroFamilyId)
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
    'virtualDirectSLCount',
    'shadowDirectSLCount'
  );

  const nearTpCount = getLearningCountMetric(
    row,
    'nearTpCount',
    'virtualNearTpCount',
    'shadowNearTpCount'
  );

  const reachedHalfRCount = getLearningCountMetric(
    row,
    'reachedHalfRCount',
    'virtualReachedHalfRCount',
    'shadowReachedHalfRCount'
  );

  const reachedOneRCount = getLearningCountMetric(
    row,
    'reachedOneRCount',
    'virtualReachedOneRCount',
    'shadowReachedOneRCount'
  );

  const beWouldExitCount = getLearningCountMetric(
    row,
    'beWouldExitCount',
    'virtualBeWouldExitCount',
    'shadowBeWouldExitCount'
  );

  const gaveBackAfterHalfRCount = getLearningCountMetric(
    row,
    'gaveBackAfterHalfRCount',
    'virtualGaveBackAfterHalfRCount',
    'shadowGaveBackAfterHalfRCount'
  );

  const gaveBackAfterOneRCount = getLearningCountMetric(
    row,
    'gaveBackAfterOneRCount',
    'virtualGaveBackAfterOneRCount',
    'shadowGaveBackAfterOneRCount'
  );

  const nearTpThenLossCount = getLearningCountMetric(
    row,
    'nearTpThenLossCount',
    'virtualNearTpThenLossCount',
    'shadowNearTpThenLossCount'
  );

  const totalR = getLearningTotalR(row);
  const totalCostR = getLearningTotalCostR(row);
  const avgR = getLearningAvgR(row);
  const avgCostR = getLearningAvgCostR(row);
  const balancedScore = getDashboardBalancedScore(row);

  const normalized = {
    ...row,

    sourceWeekKey: row.sourceWeekKey || PERSISTENT_LEARNING_KEY,
    sourceWeekPrimary: row.sourceWeekPrimary !== false,
    sourceWeekFallback: Boolean(row.sourceWeekFallback),

    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    weekResetDisabled: true,
    isoWeekLearningDisabled: true,
    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,

    microFamilyId: trueMicroFamilyId,
    trueMicroFamilyId,
    parentTrueMicroFamilyId,
    coarseMicroFamilyId,
    baseMicroFamilyId: identity.baseMicroFamilyId || coarseMicroFamilyId,
    legacyMicroFamilyId: identity.legacyMicroFamilyId || coarseMicroFamilyId,

    familyId,
    macroFamilyId,
    parentMacroFamilyId: row.parentMacroFamilyId || macroFamilyId || parentTrueMicroFamilyId || null,
    parentMicroFamilyId: row.parentMicroFamilyId || parentTrueMicroFamilyId || macroFamilyId || null,

    taxonomySetup: identity.setup || row.taxonomySetup || null,
    taxonomyRegime: identity.regime || row.taxonomyRegime || null,
    confirmationProfile: identity.confirmationProfile || row.confirmationProfile || null,

    isParentTrueMicroFamily: Boolean(identity.isParent),
    isChildTrueMicroFamily: Boolean(identity.isChild),
    selectableTrueMicroFamily: Boolean(identity.selectable),
    discordSelectable: Boolean(identity.selectable),
    selectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    discordOnlyForExactTrueMicroMatch: true,
    parentMatchDoesNotTriggerDiscord: true,
    macroMatchDoesNotTriggerDiscord: true,

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,

    scannerMicroFamilyId: row.scannerMicroFamilyId || null,
    scannerDefinition: row.scannerDefinition || null,
    scannerDefinitionParts: Array.isArray(row.scannerDefinitionParts)
      ? row.scannerDefinitionParts
      : [],
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    executionFingerprintHash: row.executionFingerprintHash || null,
    executionFingerprintParts: Array.isArray(row.executionFingerprintParts)
      ? row.executionFingerprintParts
      : [],
    executionFingerprintSchema: row.executionFingerprintSchema || null,
    executionMicroFamilyId: row.executionMicroFamilyId || null,
    executionFingerprintRole: 'METADATA_ONLY',
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,
    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    virtualLearning: true,
    virtualLearningForced: true,

    learningOutcomesOnly: true,
    virtualOutcomesIncluded: true,
    shadowOutcomesIncluded: true,
    realOutcomesExcluded: true,
    outcomesSourceMode: 'VIRTUAL_AND_SHADOW_NET_OUTCOMES',
    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    active,
    parentActive,
    macroActive: parentActive,

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

    virtualWins: round(row.virtualWins, 4),
    virtualLosses: round(row.virtualLosses, 4),
    virtualFlats: round(row.virtualFlats, 4),

    shadowWins: round(row.shadowWins, 4),
    shadowLosses: round(row.shadowLosses, 4),
    shadowFlats: round(row.shadowFlats, 4),

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

    totalR: round(totalR, 4),
    realTotalR: 0,
    virtualTotalR: round(row.virtualTotalR, 4),
    shadowTotalR: round(row.shadowTotalR, 4),

    totalPnlPct: round(row.totalPnlPct, 4),
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

    avgR: round(avgR, 4),
    avgWinR: round(row.avgWinR, 4),
    avgLossR: round(row.avgLossR, 4),

    avgPnlPct: round(row.avgPnlPct, 4),
    profitFactor: round(getLearningProfitFactor(row), 4),

    directSLCount: round(directSLCount, 4),
    directSLPct: round(
      getLearningPctMetric(
        row,
        'directSLPct',
        'directSLCount',
        'virtualDirectSLCount',
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
        'virtualNearTpCount',
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
        'virtualReachedHalfRCount',
        'shadowReachedHalfRCount'
      ),
      4
    ),
    reachedOneRPct: round(
      getLearningPctMetric(
        row,
        'reachedOneRPct',
        'reachedOneRCount',
        'virtualReachedOneRCount',
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
        'virtualBeWouldExitCount',
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
        'virtualGaveBackAfterHalfRCount',
        'shadowGaveBackAfterHalfRCount'
      ),
      4
    ),
    gaveBackAfterOneRPct: round(
      getLearningPctMetric(
        row,
        'gaveBackAfterOneRPct',
        'gaveBackAfterOneRCount',
        'virtualGaveBackAfterOneRCount',
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
        'virtualNearTpThenLossCount',
        'shadowNearTpThenLossCount'
      ),
      4
    ),

    totalCostR: round(totalCostR, 4),
    avgCostR: round(avgCostR, 4),
    realTotalCostR: 0,
    virtualTotalCostR: round(row.virtualTotalCostR, 4),
    shadowTotalCostR: round(row.shadowTotalCostR, 4),

    balancedScore: round(row.balancedScore, 4),
    dashboardBalancedScore: round(balancedScore, 4),

    definition: row.definition || null,
    definitionParts,

    macroDefinition: row.macroDefinition || row.parentDefinition || null,
    macroDefinitionParts,

    microDefinition: row.microDefinition || row.definition || null,
    microDefinitionParts: Array.isArray(row.microDefinitionParts)
      ? row.microDefinitionParts
      : definitionParts,

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

    regime: row.regime || identity.regime || null,
    regimeCoarse: row.regimeCoarse || identity.regime || null,

    scannerReason: row.scannerReason || null,
    scannerReasonCoarse: row.scannerReasonCoarse || null,

    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };

  const learningTier = getLearningTier(normalized);
  const learningStatus = getLearningStatus(normalized);

  return {
    ...normalized,
    learningTier,
    tier: learningTier,
    learningStatus,
    status: learningStatus,
    minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,
    tooEarly: num(normalized.completed, 0) < MIN_COMPLETED_ACTIVE_LEARNING
  };
}

function compactRow(row) {
  if (!row) return null;
  if (!isTargetSide(row)) return null;

  return {
    microFamilyId: row.microFamilyId,
    trueMicroFamilyId: row.trueMicroFamilyId || row.microFamilyId,
    parentTrueMicroFamilyId: row.parentTrueMicroFamilyId || row.coarseMicroFamilyId || null,
    coarseMicroFamilyId: row.coarseMicroFamilyId || row.parentTrueMicroFamilyId || row.trueMicroFamilyId || row.microFamilyId,
    familyId: row.familyId,
    macroFamilyId: row.macroFamilyId,

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    selectableTrueMicroFamily: Boolean(row.selectableTrueMicroFamily),
    discordSelectable: Boolean(row.discordSelectable),
    selectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',

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
    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',

    active: Boolean(row.active),
    parentActive: Boolean(row.parentActive),
    macroActive: Boolean(row.macroActive),

    tier: row.tier,
    learningTier: row.learningTier,
    learningStatus: row.learningStatus,
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
    isoWeekLearningDisabled: true,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    virtualLearningForced: true,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,

    learningOutcomesOnly: true,
    virtualOutcomesIncluded: true,
    shadowOutcomesIncluded: true,
    realOutcomesExcluded: true,
    outcomesSourceMode: 'VIRTUAL_AND_SHADOW_NET_OUTCOMES',
    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',

    microFamilyId: row.microFamilyId,
    trueMicroFamilyId: row.trueMicroFamilyId || row.microFamilyId,
    parentTrueMicroFamilyId: row.parentTrueMicroFamilyId || row.coarseMicroFamilyId || null,
    coarseMicroFamilyId: row.coarseMicroFamilyId || row.parentTrueMicroFamilyId || row.trueMicroFamilyId || row.microFamilyId,
    familyId: row.familyId,
    macroFamilyId: row.macroFamilyId,

    taxonomySetup: row.taxonomySetup || null,
    taxonomyRegime: row.taxonomyRegime || null,
    confirmationProfile: row.confirmationProfile || null,
    selectableTrueMicroFamily: Boolean(row.selectableTrueMicroFamily),
    discordSelectable: Boolean(row.discordSelectable),
    selectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    parentMatchDoesNotTriggerDiscord: true,
    macroMatchDoesNotTriggerDiscord: true,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    active: row.active,
    parentActive: row.parentActive,
    macroActive: row.macroActive,

    tier: row.tier,
    learningTier: row.learningTier,
    learningStatus: row.learningStatus,
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

function buildParentSummary(rows = [], parentTrueMicroFamilyId = null) {
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
  const parentActiveRows = longRows.filter((row) => row.parentActive || row.macroActive);

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
    isoWeekLearningDisabled: true,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,

    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    virtualLearningForced: true,

    learningOutcomesOnly: true,
    virtualOutcomesIncluded: true,
    shadowOutcomesIncluded: true,
    realOutcomesExcluded: true,
    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',

    parentTrueMicroFamilyId,
    macroFamilyId: parentTrueMicroFamilyId,

    selectableTrueMicroFamily: false,
    discordSelectable: false,
    parentMatchDoesNotTriggerDiscord: true,
    macroMatchDoesNotTriggerDiscord: true,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    microFamilies: longRows.length,
    activeMicroFamilies: activeRows.length,
    parentActiveMicroFamilies: parentActiveRows.length,
    macroActiveMicroFamilies: parentActiveRows.length,

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

function findRawRow(micros = {}, id) {
  if (!id) return null;

  const decodedId = safeDecode(id);
  const candidates = uniqueStrings([id, decodedId])
    .filter(validLearningId)
    .filter((candidateId) => !idLooksShort(candidateId));

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

function normalizeAllRows(micros = {}, activeSet, activeParentSet) {
  return Object.entries(micros || {})
    .map(([key, row]) => ({
      key,
      row,
      id: rowId(row, key)
    }))
    .filter(({ row, id }) => id && validLearningId(id) && isTargetSide({
      ...row,
      microFamilyId: id
    }))
    .map(({ key, row }) => (
      normalizeMicroRow(key, row, {
        activeSet,
        activeParentSet
      })
    ))
    .filter(isTargetSide);
}

function getParentRows(rows = [], id) {
  const decodedId = safeDecode(id);
  const ids = uniqueStrings([id, decodedId])
    .filter(validLearningId);

  return rows.filter((row) => (
    isTargetSide(row) &&
    (
      ids.includes(row.parentTrueMicroFamilyId) ||
      ids.includes(row.coarseMicroFamilyId) ||
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

function buildActiveLongRows(activeRotation, activeSet, activeParentSet) {
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
        activeParentSet
      }
    ))
    .filter(isTargetSide);
}

function findNormalizedRow(rows = [], id) {
  const decodedId = safeDecode(id);
  const ids = uniqueStrings([id, decodedId])
    .filter(validLearningId);

  return rows.find((row) => (
    ids.includes(row.microFamilyId) ||
    ids.includes(row.trueMicroFamilyId) ||
    ids.includes(row.id) ||
    ids.includes(row.key)
  )) || null;
}

function extractActiveIds(activeRotation) {
  if (!activeRotation) return [];

  const ids = [
    activeRotation.microFamilyIds,
    activeRotation.activeMicroFamilyIds,
    activeRotation.trueMicroFamilyIds,
    activeRotation.ids,
    Array.isArray(activeRotation.microFamilies)
      ? activeRotation.microFamilies
        .filter(isTargetSide)
        .map((row) => row.trueMicroFamilyId || row.microFamilyId || row.id || row.key)
      : []
  ];

  return uniqueStrings(ids)
    .filter(isSelectableTrueMicroId);
}

function extractActiveParentIds(activeRotation) {
  if (!activeRotation) return [];

  const rows = Array.isArray(activeRotation.microFamilies)
    ? activeRotation.microFamilies.filter(isTargetSide)
    : [];

  const ids = [
    activeRotation.parentTrueMicroFamilyIds,
    activeRotation.macroFamilyIds,
    activeRotation.activeMacroFamilyIds,
    activeRotation.parentMicroFamilyIds,
    rows.map((row) => {
      const identity = normalizeTaxonomyIdentity(row);

      return identity.parentTrueMicroFamilyId || getMacroFamilyId(row);
    })
  ];

  return uniqueStrings(ids)
    .filter(validLearningId)
    .filter((id) => isFixedLongParentMicroId(id) || idLooksLong(id));
}

function baseModePayload() {
  return {
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    weekResetDisabled: true,
    isoWeekLearningDisabled: true,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    virtualLearningForced: true,
    globalMaxOpenPositionsBlockDisabled: true,
    maxOneOpenPositionPerSymbol: true,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    executionFingerprintRole: 'METADATA_ONLY',
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    exactTrueMicroFamilyRequired: true,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    fixedTaxonomyPreferred: true,
    learningGranularity: LEARNING_GRANULARITY,

    parentMicroFamilyCount: 15,
    selectableChildMicroFamilyCount: 75,
    selectableFamilyRule: 'MICRO_LONG_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',
    parentFamilyRule: 'MICRO_LONG_{SETUP}_{REGIME}',
    discordSelectionRule: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY',
    parentMatchDoesNotTriggerDiscord: true,
    macroMatchDoesNotTriggerDiscord: true,

    learningOutcomesOnly: true,
    virtualOutcomesIncluded: true,
    shadowOutcomesIncluded: true,
    realOutcomesExcluded: true,
    outcomesSourceMode: 'VIRTUAL_AND_SHADOW_NET_OUTCOMES',
    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    redisKeysSeparatedFromShortRoot: true,
    shortRootTouched: false
  };
}

async function getActiveRotationSafe() {
  try {
    return await getActiveRotation({
      tradeSide: TARGET_TRADE_SIDE,
      side: TARGET_DASHBOARD_SIDE,
      weekKey: PERSISTENT_LEARNING_KEY,
      namespace: LONG_NAMESPACE,
      keyPrefix: LONG_KEY_PREFIX,
      trueMicroOnly: true,
      exactTrueMicroOnly: true
    });
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Micro-Family-Mode', 'long-only-75-child-true-micro-detail-v1');
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
  res.setHeader('X-True-Micro-Family-Schema', TRUE_MICRO_SCHEMA);
  res.setHeader('X-Learning-Granularity', LEARNING_GRANULARITY);
  res.setHeader('X-Discord-Selection-Rule', 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY');

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

    if (!validLearningId(id) || isExplicitShort(id)) {
      return res.status(404).json({
        ok: false,
        reason: !validLearningId(id)
          ? 'NON_LEARNING_ID_METADATA_ONLY'
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

    const requestedTaxonomy = parseLongTaxonomyMicroId(id);

    if (!requestedTaxonomy.valid && !idLooksLong(id)) {
      return res.status(404).json({
        ok: false,
        reason: 'NOT_A_LONG_TRUE_MICRO_FAMILY_ID',
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
    const activeParentIds = extractActiveParentIds(activeRotation);

    const activeSet = new Set(activeIds);
    const activeParentSet = new Set(activeParentIds);

    const allRows = normalizeAllRows(micros, activeSet, activeParentSet);
    const activeRows = buildActiveLongRows(activeRotation, activeSet, activeParentSet);
    const allKnownRows = sortRelatedRows([...allRows, ...activeRows]);

    const rawMatch = findRawRow(micros, id);
    const activeMatch = findNormalizedRow(activeRows, id);

    const commonResponse = {
      ...baseModePayload(),

      id,
      requestedTaxonomy,
      weekKey,
      currentWeekKey,
      previousWeekKey,
      requestedQueryWeekKey,
      ignoredQueryWeekKey: requestedQueryWeekKey !== PERSISTENT_LEARNING_KEY
        ? requestedQueryWeekKey
        : null
    };

    if (!rawMatch && activeMatch) {
      const parentTrueMicroFamilyId =
        activeMatch.parentTrueMicroFamilyId ||
        activeMatch.coarseMicroFamilyId ||
        null;

      const relatedMicroFamilies = parentTrueMicroFamilyId
        ? sortRelatedRows(
          allKnownRows.filter((candidate) => (
            candidate.microFamilyId !== activeMatch.microFamilyId &&
            candidate.parentTrueMicroFamilyId === parentTrueMicroFamilyId
          ))
        ).slice(0, relatedLimit)
        : [];

      const parentRows = parentTrueMicroFamilyId
        ? sortRelatedRows(
          allKnownRows.filter((candidate) => candidate.parentTrueMicroFamilyId === parentTrueMicroFamilyId)
        )
        : [activeMatch];

      return res.status(200).json({
        ok: true,
        type: 'MICRO_FAMILY_DETAIL_ACTIVE_ONLY',

        ...commonResponse,

        activeRotationId: activeRotation?.rotationId || null,
        active: activeMatch.active,
        parentActive: activeMatch.parentActive,
        macroActive: activeMatch.macroActive,

        summary: buildDetailSummary(activeMatch),
        parentSummary: buildParentSummary(parentRows, parentTrueMicroFamilyId),
        macroSummary: buildParentSummary(parentRows, parentTrueMicroFamilyId),

        row: activeMatch,

        parentTrueMicroFamilyId,
        macroFamilyId: parentTrueMicroFamilyId,
        relatedMicroFamilies,

        activeMicroFamilyIds: activeIds,
        activeParentMicroFamilyIds: activeParentIds,
        activeMacroFamilyIds: activeParentIds,

        availableCount: allRows.length,
        rawAvailableCount: Object.keys(micros || {}).length,

        serverTs: Date.now()
      });
    }

    if (!rawMatch) {
      const parentRows = sortRelatedRows([
        ...getParentRows(allRows, id),
        ...getParentRows(activeRows, id)
      ]).slice(0, relatedLimit);

      if (parentRows.length > 0) {
        const parentTrueMicroFamilyId = requestedTaxonomy.parentTrueMicroFamilyId || id;

        return res.status(200).json({
          ok: true,
          type: 'PARENT_TRUE_MICRO_FAMILY_DETAIL',

          ...commonResponse,

          activeRotationId: activeRotation?.rotationId || null,
          active: parentRows.some((row) => row.active),
          parentActive: parentRows.some((row) => row.parentActive),
          macroActive: parentRows.some((row) => row.macroActive),

          summary: buildParentSummary(parentRows, parentTrueMicroFamilyId),
          parentSummary: buildParentSummary(parentRows, parentTrueMicroFamilyId),
          macroSummary: buildParentSummary(parentRows, parentTrueMicroFamilyId),

          row: null,

          parentTrueMicroFamilyId,
          macroFamilyId: parentTrueMicroFamilyId,
          microFamilies: parentRows,
          relatedMicroFamilies: parentRows,

          selectableTrueMicroFamily: false,
          discordSelectable: false,
          parentMatchDoesNotTriggerDiscord: true,
          macroMatchDoesNotTriggerDiscord: true,

          activeMicroFamilyIds: activeIds,
          activeParentMicroFamilyIds: activeParentIds,
          activeMacroFamilyIds: activeParentIds,

          availableCount: allRows.length,
          rawAvailableCount: Object.keys(micros || {}).length,
          serverTs: Date.now()
        });
      }

      return res.status(404).json({
        ok: false,
        reason: requestedTaxonomy.isParent
          ? 'LONG_PARENT_TRUE_MICRO_FAMILY_HAS_NO_CHILD_ROWS_YET'
          : 'LONG_75_CHILD_TRUE_MICRO_FAMILY_NOT_FOUND',

        ...commonResponse,

        availableCount: allRows.length,
        rawAvailableCount: Object.keys(micros || {}).length,
        activeRotationId: activeRotation?.rotationId || null
      });
    }

    const row = normalizeMicroRow(rawMatch.key, rawMatch.row, {
      activeSet,
      activeParentSet
    });

    if (!isTargetSide(row)) {
      return res.status(404).json({
        ok: false,
        reason: 'SHORT_DISABLED_LONG_ONLY',
        ...commonResponse
      });
    }

    const parentTrueMicroFamilyId =
      row.parentTrueMicroFamilyId ||
      row.coarseMicroFamilyId ||
      null;

    const relatedMicroFamilies = parentTrueMicroFamilyId
      ? sortRelatedRows(
        allRows.filter((candidate) => (
          candidate.microFamilyId !== row.microFamilyId &&
          candidate.parentTrueMicroFamilyId === parentTrueMicroFamilyId
        ))
      ).slice(0, relatedLimit)
      : [];

    const parentRows = parentTrueMicroFamilyId
      ? sortRelatedRows(
        allRows.filter((candidate) => candidate.parentTrueMicroFamilyId === parentTrueMicroFamilyId)
      )
      : [row];

    return res.status(200).json({
      ok: true,
      type: row.selectableTrueMicroFamily
        ? 'MICRO_FAMILY_DETAIL_75_CHILD'
        : 'MICRO_FAMILY_DETAIL_PARENT_OR_LEGACY',

      ...commonResponse,

      activeRotationId: activeRotation?.rotationId || null,
      active: row.active,
      parentActive: row.parentActive,
      macroActive: row.macroActive,

      summary: buildDetailSummary(row),
      parentSummary: buildParentSummary(parentRows, parentTrueMicroFamilyId),
      macroSummary: buildParentSummary(parentRows, parentTrueMicroFamilyId),

      row,

      parentTrueMicroFamilyId,
      macroFamilyId: parentTrueMicroFamilyId,
      relatedMicroFamilies,

      activeMicroFamilyIds: activeIds,
      activeParentMicroFamilyIds: activeParentIds,
      activeMacroFamilyIds: activeParentIds,

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
