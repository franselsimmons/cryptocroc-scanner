// ================= FILE: api/admin/rotation.js =================

import {
  safeNumber,
  sideToTradeSide
} from '../../src/utils.js';
import { getWeekMicros } from '../../src/analyze/analyzeEngine.js';
import {
  activateSelectedMicroFamilies,
  getActiveRotation,
  getRotationDashboard
} from '../../src/analyze/rotationEngine.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;

const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';
const MIN_COMPLETED_ACTIVE_LEARNING = 20;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY';
const LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_V1';

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

const ALLOWED_ACTIONS = [
  'activateSelected',
  'activateSelectedMicroFamilies',
  'activateSelectedMacroFamilies'
];

const BLOCKED_AUTO_ACTIONS = new Set([
  'activateBestBalanced',
  'activateBestSideMicro',
  'activateBestSideMicroFamily',
  'activateBestShortMicroFamily',
  'activateBestLongMicroFamily',
  'activateBestBullMicroFamily',
  'activateBestLong',
  'activateLong',
  'activateBestShort',
  'activateShort',
  'activateNextRotation',
  'autoActivate',
  'autoBootstrap'
]);

const ALLOWED_MODES = new Set([
  'manual',
  'selected',
  'balanced',
  'winrate',
  'totalR',
  'avgR',
  'directSL',
  'observed'
]);

const DEFAULT_AVAILABLE_LIMIT = 120;
const MAX_AVAILABLE_LIMIT = 500;

const DEFAULT_ACTIVE_ROWS_LIMIT = 160;
const MAX_ACTIVE_ROWS_LIMIT = 500;

function now() {
  return Date.now();
}

function modeFlags() {
  return {
    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    virtualLearning: true,
    virtualLearningForced: true,
    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: true,
    virtualOutcomesIncluded: true,
    shadowOutcomesIncluded: true,
    realOutcomesExcluded: true,
    learningOutcomesOnly: true,
    outcomesSourceMode: 'VIRTUAL_AND_SHADOW_NET_OUTCOMES',
    outcomeSource: 'VIRTUAL',

    observationFirst: true,
    netOutcomesOnly: true,
    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,

    globalMaxOpenPositionsBlockDisabled: true,
    maxOneOpenPositionPerSymbol: true,

    positionTimeStopMinDefault: DEFAULT_POSITION_TIME_STOP_MIN,

    scannerSide: TARGET_DASHBOARD_SIDE,
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

    bucketsCoarseOnly: true,
    bucketGranularity: 'LOW_MID_HIGH',

    manualSelectionOnly: true,
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    macroActivationExpansionDisabled: true,
    autoRotationDisabled: true,
    autoRotationActivationDisabled: true,
    activateFreezeCronDisabled: true,
    resetCronDisabled: true,
    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForExactTrueMicroMatch: true,

    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    weekResetDisabled: true,
    isoWeekLearningDisabled: true,

    minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,
    statusRules: {
      OBSERVING: 'completed == 0',
      EARLY_OUTCOMES: `completed > 0 && completed < ${MIN_COMPLETED_ACTIVE_LEARNING}`,
      ACTIVE_LEARNING: `completed >= ${MIN_COMPLETED_ACTIVE_LEARNING}`
    },

    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    redisKeysSeparatedFromShortRoot: true,
    shortRootTouched: false
  };
}

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET, POST');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET', 'POST'],
    ...modeFlags()
  });
}

function parseJson(text) {
  const clean = String(text || '').trim();

  if (!clean) return {};

  try {
    return JSON.parse(clean);
  } catch {
    const error = new Error('INVALID_JSON_BODY');
    error.statusCode = 400;
    throw error;
  }
}

async function readBody(req) {
  if (req.body) {
    if (typeof req.body === 'string') return parseJson(req.body);
    if (Buffer.isBuffer(req.body)) return parseJson(req.body.toString('utf8'));

    return req.body;
  }

  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return parseJson(Buffer.concat(chunks).toString('utf8'));
}

function firstValue(value, fallback = null) {
  if (Array.isArray(value)) return value[0] ?? fallback;
  if (value === undefined || value === null || value === '') return fallback;

  return value;
}

function isTrue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;

  const raw = String(value).trim().toLowerCase();

  if (['true', '1', 'yes', 'y', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(raw)) return false;

  return fallback;
}

function toLimit(value, fallback = DEFAULT_AVAILABLE_LIMIT, max = MAX_AVAILABLE_LIMIT) {
  const n = Math.floor(Number(value));

  if (!Number.isFinite(n) || n < 1) return fallback;

  return Math.min(n, max);
}

function normalizeMode(value, fallback = 'manual') {
  const mode = String(value || fallback).trim();

  return ALLOWED_MODES.has(mode) ? mode : fallback;
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function num(value, fallback = 0) {
  const n = safeNumber(value, fallback);

  return Number.isFinite(n) ? n : fallback;
}

function round(value, decimals = 4) {
  return Number(num(value, 0).toFixed(decimals));
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function cleanSideText(value = '') {
  return upper(value)
    .replaceAll('SHORT_DISABLED_FALSE', '')
    .replaceAll('SHORTDISABLED_FALSE', '')
    .replaceAll('BLOCK_SHORT_FALSE', '')
    .replaceAll('SHORT_ENABLED_FALSE', '')
    .replaceAll('SHORT_ONLY_FALSE', '')
    .replaceAll('LONG_DISABLED_FALSE', '')
    .replaceAll('LONG_ENABLED_FALSE', '')
    .replaceAll('LONG_ONLY_FALSE', '')
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

function getDefinitionParts(row = {}) {
  if (Array.isArray(row.definitionParts)) return row.definitionParts;
  if (Array.isArray(row.microDefinitionParts)) return row.microDefinitionParts;

  return [];
}

function getMacroDefinitionParts(row = {}) {
  if (Array.isArray(row.macroDefinitionParts)) return row.macroDefinitionParts;
  if (Array.isArray(row.parentDefinitionParts)) return row.parentDefinitionParts;

  return [];
}

function isFixedLongTaxonomyMicroId(id = '') {
  const value = upper(id);
  const match = /^MICRO_LONG_([A-Z_]+)_(TREND|CHOP|SQUEEZE)$/.exec(value);

  if (!match) return false;

  const setup = match[1];
  const regime = match[2];

  return LONG_FIXED_SETUP_TYPES.has(setup) && LONG_FIXED_REGIME_BUCKETS.has(regime);
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

function firstValidLearningId(values = [], fallback = null) {
  for (const value of values) {
    const id = String(value || '').trim();

    if (validLearningId(id)) return id;
  }

  return fallback;
}

function getMicroFamilyId(row = {}, fallback = null) {
  return firstValidLearningId([
    row.trueMicroFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.microFamilyId,
    row.id,
    row.key,
    fallback
  ], null);
}

function getTrueMicroFamilyId(row = {}, fallback = null) {
  return firstValidLearningId([
    row.trueMicroFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.microFamilyId,
    row.id,
    row.key,
    fallback
  ], null);
}

function getCoarseMicroFamilyId(row = {}, fallback = null) {
  return firstValidLearningId([
    row.coarseMicroFamilyId,
    row.baseMicroFamilyId,
    row.legacyMicroFamilyId,
    row.trueMicroFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.microFamilyId,
    row.id,
    row.key,
    fallback
  ], null);
}

function getFamilyId(row = {}) {
  return firstValidLearningId([
    row.familyId,
    row.family,
    row.baseFamilyId
  ], null);
}

function getMacroFamilyId(row = {}) {
  return firstValidLearningId([
    row.parentMacroFamilyId,
    row.macroFamilyId,
    row.parentMicroFamilyId,
    row.parentFamilyId,
    row.macroId,
    row.familyId
  ], null);
}

function idLooksLikeLongFamily(id = '') {
  const value = cleanSideText(id);

  return (
    value.includes('MICRO_LONG_') ||
    value.startsWith('LONG_') ||
    value.includes('|LONG|') ||
    value.includes(':LONG') ||
    value.includes('=LONG') ||
    value.includes('_LONG_') ||
    value.endsWith('_LONG') ||
    value.includes('BULL') ||
    value.includes('BUY') ||
    value.includes('TRADESIDE=LONG') ||
    value.includes('TRADE_SIDE=LONG') ||
    value.includes('SIDE=LONG') ||
    value.includes('SIDE=BULL') ||
    value.includes('SIDE=BUY') ||
    value.includes('DIRECTION=LONG') ||
    value.includes('DIRECTION=BULL') ||
    value.includes('DIRECTION=BUY')
  );
}

function idLooksLikeShortFamily(id = '') {
  const value = cleanSideText(id);

  return (
    value.includes('MICRO_SHORT_') ||
    value.startsWith('SHORT_') ||
    value.includes('SHORT_') ||
    value.includes('_SHORT_') ||
    value.endsWith('_SHORT') ||
    value.includes('|SHORT|') ||
    value.includes(':SHORT') ||
    value.includes('=SHORT') ||
    value.includes('BEAR') ||
    value.includes('SELL') ||
    value.includes('TRADESIDE=SHORT') ||
    value.includes('TRADE_SIDE=SHORT') ||
    value.includes('SIDE=SHORT') ||
    value.includes('SIDE=BEAR') ||
    value.includes('SIDE=SELL') ||
    value.includes('DIRECTION=SHORT') ||
    value.includes('DIRECTION=BEAR') ||
    value.includes('DIRECTION=SELL')
  );
}

function definitionHaystack(row = {}) {
  return [
    row.definition,
    row.microDefinition,
    row.macroDefinition,
    row.parentDefinition,
    ...getArray(row.definitionParts),
    ...getArray(row.microDefinitionParts),
    ...getArray(row.macroDefinitionParts),
    ...getArray(row.parentDefinitionParts),
    ...getArray(row.executionFingerprintParts)
  ]
    .map((value) => cleanSideText(value))
    .filter(Boolean)
    .join(' | ');
}

function normalizeDirectSide(value) {
  const raw = cleanSideText(value);

  if (!raw) return 'UNKNOWN';

  const converted = sideToTradeSide(raw);

  if (converted === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (converted === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  if (['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'UPSIDE'].includes(raw)) {
    return TARGET_TRADE_SIDE;
  }

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE'].includes(raw)) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferTradeSide(input = {}) {
  if (typeof input === 'string') {
    if (idLooksLikeLongFamily(input)) return TARGET_TRADE_SIDE;
    if (idLooksLikeShortFamily(input)) return OPPOSITE_TRADE_SIDE;

    return 'UNKNOWN';
  }

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
    const side = normalizeDirectSide(source);

    if (side === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
    if (side === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
  }

  const familyId = cleanSideText(input.familyId || input.family || input.baseFamilyId);
  const macroFamilyId = cleanSideText(getMacroFamilyId(input));
  const microFamilyId = cleanSideText(getMicroFamilyId(input));

  if (familyId.startsWith('LONG_')) return TARGET_TRADE_SIDE;
  if (familyId.startsWith('SHORT_')) return OPPOSITE_TRADE_SIDE;

  if (idLooksLikeLongFamily(macroFamilyId)) return TARGET_TRADE_SIDE;
  if (idLooksLikeShortFamily(macroFamilyId)) return OPPOSITE_TRADE_SIDE;

  if (idLooksLikeLongFamily(microFamilyId)) return TARGET_TRADE_SIDE;
  if (idLooksLikeShortFamily(microFamilyId)) return OPPOSITE_TRADE_SIDE;

  const definition = definitionHaystack(input);

  if (idLooksLikeLongFamily(definition)) return TARGET_TRADE_SIDE;
  if (idLooksLikeShortFamily(definition)) return OPPOSITE_TRADE_SIDE;

  if (input.longOnly === true || input.shortDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  if (input.shortOnly === true || input.longDisabled === true) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function isLongFamilyId(id = '') {
  const value = String(id || '').trim();

  if (!validLearningId(value)) return false;
  if (idLooksLikeShortFamily(value) && !idLooksLikeLongFamily(value)) return false;

  return idLooksLikeLongFamily(value);
}

function isSelectableTrueMicroId(id = '') {
  const value = String(id || '').trim();
  const upperValue = upper(value);

  if (!validLearningId(value)) return false;
  if (!isLongFamilyId(value)) return false;
  if (idLooksLikeShortFamily(value) && !idLooksLikeLongFamily(value)) return false;

  if (isFixedLongTaxonomyMicroId(value)) return true;

  if (!upperValue.startsWith('MICRO_LONG_')) return false;

  if (
    upperValue.includes('_MF_V1_') ||
    upperValue.endsWith('_MF_V1') ||
    upperValue.includes('|SCHEMA=MF_V1') ||
    upperValue.includes('SCHEMA=MF_V1')
  ) {
    return false;
  }

  return true;
}

function isLongRow(row = {}) {
  const id = getTrueMicroFamilyId(row) || getMicroFamilyId(row);

  if (!validLearningId(id)) return false;
  if (!validLearningId(row.trueMicroFamilyId || id)) return false;
  if (!validLearningId(row.coarseMicroFamilyId || id)) return false;

  return inferTradeSide(row) !== OPPOSITE_TRADE_SIDE;
}

function rowSchema(row = {}) {
  return upper(row.microFamilySchema || row.schema || row.versionSchema || '');
}

function isMacroLikeRow(row = {}) {
  const id = cleanSideText(getMicroFamilyId(row));
  const schema = rowSchema(row);
  const version = upper(row.version);

  return (
    row.isLegacyMacro === true ||
    version.includes('MACRO') ||
    schema === 'MF_V1' ||
    /^LONG_\d+$/i.test(id)
  );
}

function isTrueMicroFamilyRow(row = {}) {
  const id = getTrueMicroFamilyId(row) || getMicroFamilyId(row);

  if (!validLearningId(id)) return false;
  if (!isLongRow(row)) return false;

  if (isFixedLongTaxonomyMicroId(id)) return true;
  if (row.fixedTaxonomyLearningId === true) return true;
  if (row.trueMicroFamilySchema === TRUE_MICRO_SCHEMA) return true;
  if (row.broadTrueMicroFamilySchema === TRUE_MICRO_SCHEMA) return true;

  if (row.trueMicro === true || row.isTrueMicro === true) return true;
  if (isMacroLikeRow(row)) return false;
  if (upper(row.version).includes('MICRO')) return true;
  if (rowSchema(row) === 'MF_V2') return true;
  if (rowSchema(row) === 'MF_V3') return true;
  if (cleanSideText(id).startsWith('MICRO_LONG_')) return true;
  if (cleanSideText(id).includes('MICRO_LONG_')) return true;

  return Boolean(getMacroFamilyId(row) || row.trueMicroFamilyId || row.microFamilyId);
}

function sourceEntries(value = {}) {
  if (Array.isArray(value)) {
    return value.map((row, index) => [
      getMicroFamilyId(row, String(index)),
      row
    ]);
  }

  if (!value || typeof value !== 'object') return [];

  return Object.entries(value);
}

function virtualKeyFromReal(realKey = '') {
  if (!realKey || !String(realKey).startsWith('real')) return null;

  return `virtual${String(realKey).slice(4)}`;
}

function shadowKeyFromReal(realKey = '') {
  if (!realKey || !String(realKey).startsWith('real')) return null;

  return `shadow${String(realKey).slice(4)}`;
}

function getLearningCount(row = {}, aggregateKey, realKey = null, shadowKey = null) {
  if (aggregateKey && hasValue(row[aggregateKey])) {
    return num(row[aggregateKey], 0);
  }

  const virtualKey = virtualKeyFromReal(realKey);
  const resolvedShadowKey = shadowKey || shadowKeyFromReal(realKey);

  return num(virtualKey ? row[virtualKey] : 0, 0) +
    num(resolvedShadowKey ? row[resolvedShadowKey] : 0, 0);
}

function outcomeCounts(row = {}) {
  const wins = getLearningCount(row, 'wins', 'realWins', 'shadowWins');
  const losses = getLearningCount(row, 'losses', 'realLosses', 'shadowLosses');
  const flats = getLearningCount(row, 'flats', 'realFlats', 'shadowFlats');

  const explicitCompleted = Math.max(
    num(row.completed, 0),
    num(row.outcomeSample, 0),
    num(row.virtualCompleted, 0) + num(row.shadowCompleted, 0),
    0
  );

  const countedTotal = wins + losses + flats;
  const total = Math.max(countedTotal, explicitCompleted, 0);
  const inferredFlats = Math.max(0, total - wins - losses);

  return {
    wins,
    losses,
    flats: Math.max(flats, inferredFlats),
    total
  };
}

function completedSample(row = {}) {
  return outcomeCounts(row).total;
}

function observationSample(row = {}) {
  return Math.max(
    num(row.seen, 0),
    num(row.observations, 0),
    completedSample(row),
    0
  );
}

function totalR(row = {}) {
  const completed = completedSample(row);

  if (completed <= 0) return 0;

  if (hasValue(row.netTotalR)) return num(row.netTotalR, 0);
  if (hasValue(row.totalNetR)) return num(row.totalNetR, 0);
  if (hasValue(row.totalR)) return num(row.totalR, 0);

  return num(row.virtualTotalR, 0) + num(row.shadowTotalR, 0);
}

function avgR(row = {}) {
  const completed = completedSample(row);

  if (completed <= 0) return 0;

  if (hasValue(row.avgNetR)) return num(row.avgNetR, 0);
  if (hasValue(row.netAvgR)) return num(row.netAvgR, 0);
  if (hasValue(row.avgR)) return num(row.avgR, 0);

  return totalR(row) / completed;
}

function totalCostR(row = {}) {
  const completed = completedSample(row);

  if (completed <= 0) return 0;

  if (hasValue(row.totalCostR)) return num(row.totalCostR, 0);

  const combined = num(row.virtualTotalCostR, 0) + num(row.shadowTotalCostR, 0);

  if (combined > 0) return combined;
  if (hasValue(row.avgCostR)) return num(row.avgCostR, 0) * completed;

  return 0;
}

function avgCostR(row = {}) {
  const completed = completedSample(row);

  if (completed <= 0) return 0;
  if (hasValue(row.avgCostR)) return num(row.avgCostR, 0);

  return totalCostR(row) / completed;
}

function learningStatus(row = {}) {
  const completed = completedSample(row);

  if (completed >= MIN_COMPLETED_ACTIVE_LEARNING) return 'ACTIVE_LEARNING';
  if (completed > 0) return 'EARLY_OUTCOMES';

  return 'OBSERVING';
}

function eligibilityTier(row = {}) {
  const completed = completedSample(row);
  const observed = observationSample(row);

  if (completed >= MIN_COMPLETED_ACTIVE_LEARNING) return 'HARD';
  if (completed > 0) return 'SOFT';
  if (observed > 0) return 'OBSERVATION';

  return 'RAW';
}

function learningQualityRank(row = {}) {
  const completed = completedSample(row);
  const observed = observationSample(row);

  if (completed >= MIN_COMPLETED_ACTIVE_LEARNING) return 3;
  if (completed > 0) return 2;
  if (observed > 0) return 1;

  return 0;
}

function normalizeRotationRow(row = {}, index = 0) {
  const microFamilyId = getTrueMicroFamilyId(row) || getMicroFamilyId(row);

  if (!validLearningId(microFamilyId)) return null;

  const rawSide = inferTradeSide({
    ...row,
    microFamilyId,
    trueMicroFamilyId: microFamilyId
  });

  if (rawSide === OPPOSITE_TRADE_SIDE) return null;

  const coarseMicroFamilyId = getCoarseMicroFamilyId(row, microFamilyId);
  const macroFamilyId = getMacroFamilyId(row);
  const counts = outcomeCounts(row);
  const completed = completedSample(row);
  const observed = observationSample(row);
  const tier = row.selectedTier || row.rotationEligibilityTier || eligibilityTier(row);
  const fixedTaxonomyLearningId = isFixedLongTaxonomyMicroId(microFamilyId);

  return {
    rank: index + 1,

    microFamilyId,
    trueMicroFamilyId: microFamilyId,
    analyzeMicroFamilyId: microFamilyId,
    learningMicroFamilyId: microFamilyId,
    coarseMicroFamilyId,

    familyId: getFamilyId(row),
    macroFamilyId,

    parentMacroFamilyId: row.parentMacroFamilyId || macroFamilyId || null,
    parentMicroFamilyId: row.parentMicroFamilyId || macroFamilyId || null,

    ...modeFlags(),

    fixedTaxonomyLearningId,
    trueMicroFamilySchema: fixedTaxonomyLearningId
      ? TRUE_MICRO_SCHEMA
      : row.trueMicroFamilySchema || row.schema || null,
    broadTrueMicroFamilySchema: fixedTaxonomyLearningId
      ? TRUE_MICRO_SCHEMA
      : row.broadTrueMicroFamilySchema || row.trueMicroFamilySchema || row.schema || null,

    inferredTradeSide: rawSide === 'UNKNOWN' ? TARGET_TRADE_SIDE : rawSide,
    inferredFromLongOnlyMode: rawSide === 'UNKNOWN',

    schema: row.schema || row.microFamilySchema || null,
    microFamilySchema: row.microFamilySchema || row.schema || null,
    version: row.version || null,

    isTrueMicro: isTrueMicroFamilyRow({
      ...row,
      microFamilyId,
      trueMicroFamilyId: microFamilyId
    }),
    isLegacyMacro: isMacroLikeRow({
      ...row,
      microFamilyId,
      trueMicroFamilyId: microFamilyId
    }),

    seen: num(row.seen, 0),
    observations: num(row.observations, 0),

    completed: round(completed, 4),
    virtualCompleted: round(row.virtualCompleted, 4),
    shadowCompleted: round(row.shadowCompleted, 4),
    realCompleted: 0,

    outcomeSample: round(completed, 4),
    observationSample: round(observed, 4),
    awaitingOutcomes: completed <= 0 && observed > 0,
    learningStatus: learningStatus(row),
    status: learningStatus(row),

    tooEarly: completed < MIN_COMPLETED_ACTIVE_LEARNING,
    tooEarlyReason: completed < MIN_COMPLETED_ACTIVE_LEARNING
      ? `COMPLETED_BELOW_${MIN_COMPLETED_ACTIVE_LEARNING}`
      : null,

    wins: round(counts.wins, 4),
    losses: round(counts.losses, 4),
    flats: round(counts.flats, 4),

    virtualWins: round(row.virtualWins, 4),
    virtualLosses: round(row.virtualLosses, 4),
    virtualFlats: round(row.virtualFlats, 4),

    shadowWins: round(row.shadowWins, 4),
    shadowLosses: round(row.shadowLosses, 4),
    shadowFlats: round(row.shadowFlats, 4),

    realWins: 0,
    realLosses: 0,
    realFlats: 0,

    winrate: round(row.winrate, 4),
    bayesianWinrate: round(row.bayesianWinrate, 4),
    wilsonLowerBound: round(row.wilsonLowerBound, 4),
    fairWinrate: round(row.fairWinrate ?? row.sampleAdjustedWinrate, 4),

    winrateSample: round(row.winrateSample ?? completed, 4),
    sampleAdjustedWinrate: round(row.sampleAdjustedWinrate, 4),
    sampleWilsonLowerBound: round(row.sampleWilsonLowerBound ?? row.wilsonLowerBound, 4),
    sampleReliability: round(row.sampleReliability, 4),

    avgR: round(avgR(row), 4),
    totalR: round(totalR(row), 4),

    virtualTotalR: round(row.virtualTotalR, 4),
    shadowTotalR: round(row.shadowTotalR, 4),
    realTotalR: 0,

    avgWinR: round(row.avgWinR, 4),
    avgLossR: round(row.avgLossR, 4),

    profitFactor: round(row.profitFactor, 4),

    directSLPct: round(row.directSLPct, 4),
    nearTpPct: round(row.nearTpPct, 4),
    reachedHalfRPct: round(row.reachedHalfRPct, 4),
    reachedOneRPct: round(row.reachedOneRPct, 4),

    beWouldExitPct: round(row.beWouldExitPct, 4),
    gaveBackAfterHalfRPct: round(row.gaveBackAfterHalfRPct, 4),
    gaveBackAfterOneRPct: round(row.gaveBackAfterOneRPct, 4),
    nearTpThenLossPct: round(row.nearTpThenLossPct, 4),

    totalCostR: round(totalCostR(row), 4),
    avgCostR: round(avgCostR(row), 4),

    balancedScore: round(row.balancedScore, 4),
    dashboardBalancedScore: round(row.dashboardBalancedScore ?? row.balancedScore, 4),

    selectedTier: tier,
    rotationEligibilityTier: tier,

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
    setupType: row.setupType || null,
    regimeBucket: row.regimeBucket || null,

    scannerReason: row.scannerReason || null,
    scannerReasonCoarse: row.scannerReasonCoarse || null,

    scannerMicroFamilyId: row.scannerMicroFamilyId || null,
    scannerFamilyId: row.scannerFamilyId || null,
    scannerDefinition: row.scannerDefinition || null,
    scannerDefinitionParts: Array.isArray(row.scannerDefinitionParts)
      ? row.scannerDefinitionParts
      : [],

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    executionMicroFamilyId: row.executionMicroFamilyId || null,
    executionFingerprintHash: row.executionFingerprintHash || null,
    executionFingerprintParts: Array.isArray(row.executionFingerprintParts)
      ? row.executionFingerprintParts
      : [],
    executionFingerprintSchema: row.executionFingerprintSchema || null,
    executionFingerprintRole: 'METADATA_ONLY',
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,

    definitionParts: getDefinitionParts(row),
    definition: row.definition || '',

    macroDefinitionParts: getMacroDefinitionParts(row),
    macroDefinition: row.macroDefinition || row.parentDefinition || '',

    sourceWeekKey: row.sourceWeekKey || PERSISTENT_LEARNING_KEY,
    sourceWeekPrimary: row.sourceWeekPrimary !== false,
    sourceWeekFallback: Boolean(row.sourceWeekFallback),

    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };
}

function compareRows(a = {}, b = {}) {
  return (
    learningQualityRank(b) - learningQualityRank(a) ||
    num(b.outcomeSample ?? completedSample(b), 0) - num(a.outcomeSample ?? completedSample(a), 0) ||
    num(b.dashboardBalancedScore, 0) - num(a.dashboardBalancedScore, 0) ||
    num(b.balancedScore, 0) - num(a.balancedScore, 0) ||
    num(b.fairWinrate, 0) - num(a.fairWinrate, 0) ||
    num(b.totalR, 0) - num(a.totalR, 0) ||
    num(b.avgR, 0) - num(a.avgR, 0) ||
    num(b.observationSample, 0) - num(a.observationSample, 0) ||
    String(a.microFamilyId || '').localeCompare(String(b.microFamilyId || ''))
  );
}

function dedupeRows(rows = []) {
  const seen = new Set();
  const output = [];

  for (const row of rows) {
    if (!row?.trueMicroFamilyId && !row?.microFamilyId) continue;
    if (seen.has(row.trueMicroFamilyId || row.microFamilyId)) continue;
    if (!isLongRow(row)) continue;
    if (!isTrueMicroFamilyRow(row)) continue;

    const key = row.trueMicroFamilyId || row.microFamilyId;

    seen.add(key);
    output.push(row);
  }

  return output;
}

async function loadAvailableRows({
  weekKey,
  includePrevious = true,
  limit = DEFAULT_AVAILABLE_LIMIT
} = {}) {
  const requestedWeekKey = String(weekKey || PERSISTENT_LEARNING_KEY).trim();
  const currentWeekKey = PERSISTENT_LEARNING_KEY;
  const previousWeekKey = PERSISTENT_LEARNING_KEY;

  const current = await getWeekMicros(PERSISTENT_LEARNING_KEY).catch(() => ({}));

  const previous = includePrevious && previousWeekKey !== currentWeekKey
    ? await getWeekMicros(previousWeekKey).catch(() => ({}))
    : {};

  const merged = {
    ...(previous || {}),
    ...(current || {})
  };

  const rows = sourceEntries(merged)
    .map(([key, row], index) => {
      const rowId = getTrueMicroFamilyId(row, getMicroFamilyId(row, key));
      const currentHasKey = Boolean(current?.[key] || current?.[rowId]);
      const previousHasKey = Boolean(previous?.[key] || previous?.[rowId]);

      return normalizeRotationRow({
        ...(row || {}),
        key,
        microFamilyId: rowId,
        trueMicroFamilyId: rowId,
        analyzeMicroFamilyId: rowId,
        learningMicroFamilyId: rowId,
        sourceWeekKey: row?.sourceWeekKey || PERSISTENT_LEARNING_KEY,
        sourceWeekPrimary: currentHasKey || !previousHasKey,
        sourceWeekFallback: Boolean(!currentHasKey && previousHasKey)
      }, index);
    })
    .filter(Boolean)
    .filter(isLongRow)
    .filter(isTrueMicroFamilyRow)
    .sort(compareRows);

  return {
    requestedWeekKey,
    currentWeekKey,
    previousWeekKey,
    queryWeekKeyIgnored: requestedWeekKey !== PERSISTENT_LEARNING_KEY
      ? requestedWeekKey
      : null,
    currentRows: sourceEntries(current).length,
    previousRows: sourceEntries(previous).length,
    mergedRows: rows.length,
    rows: dedupeRows(rows).slice(0, limit)
  };
}

function extractIdsFromRotation(rotation = {}) {
  const rows = Array.isArray(rotation?.microFamilies)
    ? rotation.microFamilies
    : [];

  return uniqueStrings([
    rotation?.microFamilyIds || [],
    rotation?.activeMicroFamilyIds || [],
    rotation?.trueMicroFamilyIds || [],
    rows.map((row) => getTrueMicroFamilyId(row, getMicroFamilyId(row)))
  ]).filter(isSelectableTrueMicroId);
}

function extractMacroIdsFromRotation(rotation = {}) {
  const rows = Array.isArray(rotation?.microFamilies)
    ? rotation.microFamilies
    : [];

  return uniqueStrings([
    rotation?.macroFamilyIds || [],
    rotation?.activeMacroFamilyIds || [],
    rows.map((row) => getMacroFamilyId(row))
  ]).filter(isLongFamilyId);
}

function manualActiveRowFromId(id, index = 0) {
  if (!id || !isSelectableTrueMicroId(id)) return null;

  return normalizeRotationRow({
    microFamilyId: id,
    trueMicroFamilyId: id,
    analyzeMicroFamilyId: id,
    learningMicroFamilyId: id,
    trueMicro: true,
    isTrueMicro: true,
    active: true,
    fixedTaxonomyLearningId: isFixedLongTaxonomyMicroId(id),
    trueMicroFamilySchema: isFixedLongTaxonomyMicroId(id)
      ? TRUE_MICRO_SCHEMA
      : null,
    selectedTier: 'RAW',
    rotationEligibilityTier: 'RAW',
    seen: 0,
    observations: 0,
    completed: 0,
    wins: 0,
    losses: 0,
    flats: 0,
    totalR: 0,
    avgR: 0,
    totalCostR: 0,
    avgCostR: 0
  }, index);
}

function compactActiveRotation(rotation = null) {
  if (!rotation || typeof rotation !== 'object') return null;

  const activeMicroFamilyIds = extractIdsFromRotation(rotation);
  const activeMacroFamilyIds = extractMacroIdsFromRotation(rotation);

  const rowList = Array.isArray(rotation.microFamilies)
    ? rotation.microFamilies
    : [];

  const rows = rowList
    .map((row, index) => normalizeRotationRow(row, index))
    .filter(Boolean)
    .filter(isLongRow)
    .filter(isTrueMicroFamilyRow);

  const existing = new Set(rows.map((row) => row.trueMicroFamilyId || row.microFamilyId).filter(Boolean));

  for (const id of activeMicroFamilyIds) {
    if (existing.has(id)) continue;

    const manualRow = manualActiveRowFromId(id, rows.length);
    if (!manualRow) continue;

    rows.push(manualRow);
    existing.add(id);
  }

  rows.sort(compareRows);

  return {
    rotationId: rotation.rotationId || null,
    source: rotation.source || null,
    mode: rotation.mode || null,
    sourceWeekKey: rotation.sourceWeekKey || PERSISTENT_LEARNING_KEY,
    activeWeekKey: rotation.activeWeekKey || PERSISTENT_LEARNING_KEY,
    generatedAt: rotation.generatedAt || null,
    activatedAt: rotation.activatedAt || null,

    ...modeFlags(),

    manualOnly: true,
    adminSelected: true,
    autoRotation: false,
    liveSelectable: activeMicroFamilyIds.length > 0,

    empty: activeMicroFamilyIds.length === 0,
    emptyReason: activeMicroFamilyIds.length === 0
      ? 'NO_MANUAL_LONG_TRUE_MICRO_SELECTION_ACTIVE'
      : null,

    microFamilyIds: activeMicroFamilyIds,
    activeMicroFamilyIds,
    trueMicroFamilyIds: activeMicroFamilyIds,

    macroFamilyIds: activeMacroFamilyIds,
    activeMacroFamilyIds,

    microFamilies: rows,

    count: activeMicroFamilyIds.length,
    activeCount: activeMicroFamilyIds.length,

    bestLong: rows[0] || null,
    bestShort: null,
    missingSides: activeMicroFamilyIds.length ? [] : [TARGET_TRADE_SIDE]
  };
}

function parseSelectedIds(body = {}) {
  const microFamilyIds = uniqueStrings([
    body.microFamilyIds,
    body.activeMicroFamilyIds,
    body.trueMicroFamilyIds,
    body.ids,
    body.id,
    body.microFamilyId,
    body.trueMicroFamilyId
  ]);

  const macroFamilyIds = uniqueStrings([
    body.macroFamilyIds,
    body.activeMacroFamilyIds,
    body.macroIds,
    body.macroFamilyId
  ]);

  const requestedIds = uniqueStrings([
    microFamilyIds,
    macroFamilyIds
  ]);

  const acceptedIds = microFamilyIds.filter(isSelectableTrueMicroId);

  const ignoredRequestedIds = requestedIds
    .filter((id) => !acceptedIds.includes(id))
    .map((id) => {
      const side = inferTradeSide(id);
      const isMacroRequest = macroFamilyIds.includes(id);

      return {
        id,
        reason: side === OPPOSITE_TRADE_SIDE
          ? 'SHORT_DISABLED_LONG_ONLY'
          : isMacroRequest
            ? 'MACRO_ID_REJECTED_EXACT_TRUE_MICRO_FAMILY_ID_REQUIRED'
            : isScannerFingerprintId(id)
              ? 'SCANNER_FINGERPRINT_METADATA_ONLY_NOT_SELECTABLE'
              : isExecutionFingerprintId(id)
                ? 'EXECUTION_FINGERPRINT_METADATA_ONLY_NOT_SELECTABLE'
                : 'UNKNOWN_OR_NON_LONG_TRUE_MICRO_ID_REJECTED'
      };
    });

  return {
    requestedIds,
    microFamilyIds: acceptedIds,
    macroFamilyIds: [],
    requestedMacroFamilyIds: macroFamilyIds,
    acceptedIds,
    ignoredRequestedIds
  };
}

function normalizeAction(body = {}) {
  const raw = String(body?.action || '').trim();

  if (raw) return raw;

  const ids = parseSelectedIds(body);

  if (ids.acceptedIds.length > 0) return 'activateSelectedMicroFamilies';

  return '';
}

function buildTierSummary(rows = []) {
  return rows.reduce((acc, row) => {
    const tier = row.rotationEligibilityTier || row.selectedTier || eligibilityTier(row);

    acc.total += 1;
    acc[tier] = (acc[tier] || 0) + 1;

    return acc;
  }, {
    total: 0,
    HARD: 0,
    SOFT: 0,
    OBSERVATION: 0,
    RAW: 0
  });
}

async function resolveSelectedIdsForActivation({
  selected,
  action
}) {
  const microFamilyIds = uniqueStrings(selected.microFamilyIds)
    .filter(isSelectableTrueMicroId);

  return {
    microFamilyIds,
    macroFamilyIds: [],
    requestedMacroFamilyIds: selected.requestedMacroFamilyIds || [],
    expandedFromMacro: [],
    unresolvedMacroFamilyIds: selected.requestedMacroFamilyIds || [],
    macroExpansionDisabled: action === 'activateSelectedMacroFamilies' ||
      (selected.requestedMacroFamilyIds || []).length > 0,
    matchMode: 'EXACT_TRUE_MICRO_FAMILY_ID'
  };
}

async function handleGet(req, res) {
  const startedAt = now();

  const requestedWeekKey = String(
    firstValue(req.query?.weekKey, PERSISTENT_LEARNING_KEY)
  ).trim();

  const availableLimit = toLimit(
    firstValue(req.query?.availableLimit, DEFAULT_AVAILABLE_LIMIT),
    DEFAULT_AVAILABLE_LIMIT,
    MAX_AVAILABLE_LIMIT
  );

  const activeRowsLimit = toLimit(
    firstValue(req.query?.activeRowsLimit, DEFAULT_ACTIVE_ROWS_LIMIT),
    DEFAULT_ACTIVE_ROWS_LIMIT,
    MAX_ACTIVE_ROWS_LIMIT
  );

  const includeAvailable = isTrue(
    firstValue(req.query?.includeAvailable, true),
    true
  );

  const includePrevious = isTrue(
    firstValue(req.query?.includePrevious, true),
    true
  );

  const [dashboard, activeRotation, availableResult] = await Promise.all([
    getRotationDashboard({
      tradeSide: TARGET_TRADE_SIDE,
      side: TARGET_DASHBOARD_SIDE,
      weekKey: PERSISTENT_LEARNING_KEY,
      namespace: LONG_NAMESPACE,
      keyPrefix: LONG_KEY_PREFIX
    }).catch(() => null),

    getActiveRotation({
      tradeSide: TARGET_TRADE_SIDE,
      side: TARGET_DASHBOARD_SIDE,
      weekKey: PERSISTENT_LEARNING_KEY,
      namespace: LONG_NAMESPACE,
      keyPrefix: LONG_KEY_PREFIX
    }).catch(() => null),

    includeAvailable
      ? loadAvailableRows({
        weekKey: requestedWeekKey,
        includePrevious,
        limit: availableLimit
      }).catch((error) => ({
        requestedWeekKey,
        currentWeekKey: PERSISTENT_LEARNING_KEY,
        previousWeekKey: PERSISTENT_LEARNING_KEY,
        queryWeekKeyIgnored: requestedWeekKey !== PERSISTENT_LEARNING_KEY
          ? requestedWeekKey
          : null,
        currentRows: 0,
        previousRows: 0,
        mergedRows: 0,
        rows: [],
        warning: error?.message || String(error)
      }))
      : Promise.resolve({
        requestedWeekKey,
        currentWeekKey: PERSISTENT_LEARNING_KEY,
        previousWeekKey: PERSISTENT_LEARNING_KEY,
        queryWeekKeyIgnored: requestedWeekKey !== PERSISTENT_LEARNING_KEY
          ? requestedWeekKey
          : null,
        currentRows: 0,
        previousRows: 0,
        mergedRows: 0,
        rows: []
      })
  ]);

  const active = compactActiveRotation(activeRotation);
  const availableRows = availableResult.rows || [];

  return res.status(200).json({
    ok: true,

    ...modeFlags(),

    currentWeekKey: PERSISTENT_LEARNING_KEY,
    previousWeekKey: PERSISTENT_LEARNING_KEY,
    requestedWeekKey,
    queryWeekKeyIgnored: availableResult.queryWeekKeyIgnored || null,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,

    activeRowsLimit,
    availableLimit,
    includeAvailable,
    includePrevious,

    activeRotation: active,
    active,

    activeRotationId: active?.rotationId || null,
    activeMicroFamilyIds: active?.activeMicroFamilyIds || [],
    activeMacroFamilyIds: active?.activeMacroFamilyIds || [],

    activeRows: (active?.microFamilies || []).slice(0, activeRowsLimit),
    activeCount: active?.activeMicroFamilyIds?.length || 0,

    dashboard: dashboard || null,
    nextRotation: dashboard?.next || dashboard?.nextRotation || null,
    nextRotationStoredOnly: true,
    nextRotationAutoActivationDisabled: true,

    availableMicroFamilies: availableRows,
    availableRows,
    availableCount: availableRows.length,

    availableTierSummary: buildTierSummary(availableRows),

    sourceRows: {
      currentWeekRows: availableResult.currentRows,
      previousWeekRows: availableResult.previousRows,
      mergedRows: availableResult.mergedRows,
      warning: availableResult.warning || null
    },

    allowedActions: ALLOWED_ACTIONS,
    blockedAutoActions: [...BLOCKED_AUTO_ACTIONS],

    buttons: {
      selectExact: true,
      copy: true,
      activateVisibleIdsForDiscord: true
    },

    perf: {
      durationMs: now() - startedAt,
      source: 'long_manual_selection_only_exact_true_micro_rotation_dashboard'
    },

    serverTs: Date.now()
  });
}

async function handlePost(req, res) {
  const startedAt = now();
  const body = await readBody(req);
  const action = normalizeAction(body);

  if (!action) {
    return res.status(400).json({
      ok: false,
      reason: 'ACTION_REQUIRED',
      allowedActions: ALLOWED_ACTIONS,
      blockedAutoActions: [...BLOCKED_AUTO_ACTIONS],
      ...modeFlags()
    });
  }

  if (BLOCKED_AUTO_ACTIONS.has(action)) {
    return res.status(400).json({
      ok: false,
      reason: 'AUTO_ROTATION_DISABLED_MANUAL_SELECTION_ONLY',
      action,
      allowedActions: ALLOWED_ACTIONS,
      blockedAutoActions: [...BLOCKED_AUTO_ACTIONS],
      ...modeFlags()
    });
  }

  if (!ALLOWED_ACTIONS.includes(action)) {
    return res.status(400).json({
      ok: false,
      reason: 'UNKNOWN_OR_DISABLED_ACTION',
      action,
      allowedActions: ALLOWED_ACTIONS,
      blockedAutoActions: [...BLOCKED_AUTO_ACTIONS],
      ...modeFlags()
    });
  }

  const selected = parseSelectedIds(body);

  if (selected.acceptedIds.length === 0) {
    return res.status(400).json({
      ok: false,
      reason: selected.ignoredRequestedIds.some((row) => row.reason === 'SHORT_DISABLED_LONG_ONLY')
        ? 'SHORT_DISABLED_LONG_ONLY'
        : 'LONG_TRUE_MICRO_FAMILY_IDS_REQUIRED',

      requestedIds: selected.requestedIds,
      ignoredRequestedIds: selected.ignoredRequestedIds,

      allowedActions: ALLOWED_ACTIONS,
      ...modeFlags()
    });
  }

  const requestedWeekKey = String(
    firstValue(body.weekKey, PERSISTENT_LEARNING_KEY)
  ).trim();

  const weekKey = PERSISTENT_LEARNING_KEY;

  const mode = normalizeMode(
    firstValue(body.mode, action === 'activateSelected' ? 'selected' : 'manual'),
    'manual'
  );

  const resolved = await resolveSelectedIdsForActivation({
    selected,
    action,
    weekKey
  });

  if (resolved.microFamilyIds.length === 0) {
    return res.status(400).json({
      ok: false,
      reason: 'NO_EXACT_LONG_TRUE_MICRO_FAMILIES_RESOLVED',

      requestedMicroFamilyIds: selected.microFamilyIds,
      requestedMacroFamilyIds: selected.requestedMacroFamilyIds,
      requestedIds: selected.requestedIds,
      ignoredRequestedIds: selected.ignoredRequestedIds,
      unresolvedMacroFamilyIds: resolved.unresolvedMacroFamilyIds,
      macroExpansionDisabled: true,

      ...modeFlags()
    });
  }

  const activation = await activateSelectedMicroFamilies({
    microFamilyIds: resolved.microFamilyIds,
    trueMicroFamilyIds: resolved.microFamilyIds,
    activeMicroFamilyIds: resolved.microFamilyIds,
    ids: resolved.microFamilyIds,

    macroFamilyIds: [],
    activeMacroFamilyIds: [],
    macroIds: [],

    weekKey,
    mode,

    tradeSide: TARGET_TRADE_SIDE,
    side: TARGET_DASHBOARD_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    namespace: LONG_NAMESPACE,
    keyPrefix: LONG_KEY_PREFIX,

    manualOnly: true,
    exactTrueMicroFamilyOnly: true,
    trueMicroOnly: true,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,
    autoRotationActivationDisabled: true
  });

  const active = compactActiveRotation(activation);

  return res.status(200).json({
    ok: true,
    action,

    ...modeFlags(),

    weekKey,
    requestedWeekKey,
    queryWeekKeyIgnored: requestedWeekKey !== PERSISTENT_LEARNING_KEY
      ? requestedWeekKey
      : null,
    mode,

    requestedMicroFamilyIds: selected.microFamilyIds,
    requestedMacroFamilyIds: selected.requestedMacroFamilyIds,
    requestedIds: selected.requestedIds,

    resolvedMicroFamilyIds: resolved.microFamilyIds,
    resolvedTrueMicroFamilyIds: resolved.microFamilyIds,
    resolvedMacroFamilyIds: [],
    expandedFromMacro: [],
    unresolvedMacroFamilyIds: resolved.unresolvedMacroFamilyIds,
    macroExpansionDisabled: true,

    acceptedIds: resolved.microFamilyIds,
    ignoredRequestedIds: [
      ...selected.ignoredRequestedIds,
      ...(Array.isArray(activation?.ignoredRequestedIds)
        ? activation.ignoredRequestedIds
        : [])
    ],

    activeRotation: active,
    active,

    activatedCount: active?.activeMicroFamilyIds?.length || 0,
    activatedMicroCount: active?.activeMicroFamilyIds?.length || 0,
    activatedMacroCount: 0,

    activeMicroFamilyIds: active?.activeMicroFamilyIds || [],
    activeMacroFamilyIds: active?.activeMacroFamilyIds || [],

    bestLong: active?.bestLong || null,
    bestShort: null,

    discordEntryAlertsEnabledForSelectedMicroFamiliesOnly:
      (active?.activeMicroFamilyIds || []).length > 0,

    noSelectionMeansNoDiscord:
      (active?.activeMicroFamilyIds || []).length === 0,

    rawActivation: activation,

    perf: {
      durationMs: now() - startedAt,
      source: 'activateSelectedLongTrueMicroFamilies_manual_only_exact_match'
    },

    serverTs: Date.now()
  });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Rotation-Mode', 'long-only-manual-selection-exact-true-micro-fixed-taxonomy-v3');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Long-Only', 'true');
  res.setHeader('X-Short-Disabled', 'true');
  res.setHeader('X-True-Micro-Only', 'true');
  res.setHeader('X-Exact-True-Micro-Only', 'true');
  res.setHeader('X-True-Micro-Family-Schema', TRUE_MICRO_SCHEMA);
  res.setHeader('X-Manual-Selection-Match-Mode', 'EXACT_TRUE_MICRO_FAMILY_ID');
  res.setHeader('X-Auto-Rotation-Disabled', 'true');
  res.setHeader('X-Virtual-Only', 'true');
  res.setHeader('X-Virtual-Learning-Forced', 'true');
  res.setHeader('X-Real-Orders-Disabled', 'true');
  res.setHeader('X-Bitget-Orders-Disabled', 'true');
  res.setHeader('X-Exchange-Calls-Disabled', 'true');
  res.setHeader('X-Persistent-Learning-Key', PERSISTENT_LEARNING_KEY);
  res.setHeader('X-Redis-Namespace', LONG_NAMESPACE);
  res.setHeader('X-Short-Root-Touched', 'false');

  try {
    if (req.method === 'GET') {
      return await handleGet(req, res);
    }

    if (req.method === 'POST') {
      return await handlePost(req, res);
    }

    return methodNotAllowed(res);
  } catch (error) {
    const status = error.statusCode || 500;

    return res.status(status).json({
      ok: false,

      ...modeFlags(),

      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}