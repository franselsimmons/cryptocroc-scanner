// ================= FILE: api/admin/micro-families.js =================

import {
  sideToTradeSide,
  safeNumber
} from '../../src/utils.js';
import { getWeekMicros } from '../../src/analyze/analyzeEngine.js';
import { getActiveRotation } from '../../src/analyze/rotationEngine.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';

const SHOW_SCANNER_FINGERPRINT_LEGACY_FALLBACK = false;

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
const MIN_COMPLETED_ACTIVE_LEARNING = 20;

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 300;

const DEFAULT_SIDE_LIMIT = 25;
const MAX_SIDE_LIMIT = 120;

const DEFAULT_BEST_LIMIT = 25;
const MAX_BEST_LIMIT = 100;

const DEFAULT_RECENT_WEEK_LOOKBACK = 1;
const MAX_RECENT_WEEK_LOOKBACK = 1;

const ACTIVE_ROTATION_TIMEOUT_MS = 1_800;
const WEEK_MICROS_TIMEOUT_MS = 9_500;
const RECENT_WEEK_TIMEOUT_MS = 4_800;

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_KEYS = 20;

const cache = globalThis.__ADMIN_MICRO_FAMILIES_LONG_NET_CACHE__ ||= {
  weekMicros: new Map()
};

function now() {
  return Date.now();
}

function modePayload() {
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

    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,

    virtualLearningForced: true,
    virtualPositionsOnly: true,

    globalMaxOpenPositionsBlockDisabled: true,
    maxOneOpenPositionPerSymbol: true,

    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    weekResetDisabled: true,
    isoWeekLearningDisabled: true,

    observationFirst: true,
    virtualLearning: true,
    virtualOutcomesIncluded: true,
    shadowOutcomesIncluded: true,
    netOutcomesOnly: true,
    learningOutcomesOnly: true,
    outcomesSourceMode: 'VIRTUAL_AND_SHADOW_NET_OUTCOMES',
    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    manualSelectionOnly: true,
    autoRotationActivationDisabled: true,
    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForExactTrueMicroMatch: true,
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',

    scannerSide: TARGET_DASHBOARD_SIDE,
    scannerFingerprintLegacyFallbackEnabled: SHOW_SCANNER_FINGERPRINT_LEGACY_FALLBACK,
    scannerFingerprintsHidden: SHOW_SCANNER_FINGERPRINT_LEGACY_FALLBACK !== true,
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    fixedTaxonomyPreferred: true,
    learningGranularity: LEARNING_GRANULARITY,

    bucketsCoarseOnly: true,
    bucketGranularity: 'LOW_MID_HIGH',

    positionTimeStopMinDefault: 720,

    resetCronDisabled: true,
    activateFreezeCronDisabled: true,

    minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING
  };
}

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET'],
    ...modePayload()
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
    value === 'YES' ||
    value === 'on' ||
    value === 'ON'
  );
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

function normalizeMode(value) {
  const raw = String(value || 'balanced').trim();

  if (VALID_MODES.has(raw)) return raw;

  const lower = raw.toLowerCase();

  if (lower === 'totalr') return 'totalR';
  if (lower === 'avgr') return 'avgR';
  if (lower === 'directsl') return 'directSL';

  return VALID_MODES.has(lower) ? lower : 'balanced';
}

function normalizeRequestedTradeSide(value) {
  const raw = upper(value);

  if (!raw) return TARGET_TRADE_SIDE;
  if (['LONG', 'BULL', 'BULLISH', 'BUY'].includes(raw)) return TARGET_TRADE_SIDE;
  if (['SHORT', 'BEAR', 'BEARISH', 'SELL'].includes(raw)) return 'SHORT_DISABLED';

  const converted = sideToTradeSide(raw);

  if (converted === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (converted === OPPOSITE_TRADE_SIDE) return 'SHORT_DISABLED';

  return TARGET_TRADE_SIDE;
}

function normalizeSideToken(value) {
  const raw = upper(value);

  if (!raw) return 'UNKNOWN';

  const converted = sideToTradeSide(raw);

  if (converted === OPPOSITE_TRADE_SIDE || converted === TARGET_TRADE_SIDE) return converted;

  if (['LONG', 'BULL', 'BULLISH', 'BUY'].includes(raw)) return TARGET_TRADE_SIDE;
  if (['SHORT', 'BEAR', 'BEARISH', 'SELL'].includes(raw)) return OPPOSITE_TRADE_SIDE;

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

function allowScannerFingerprintRow(id = '') {
  return SHOW_SCANNER_FINGERPRINT_LEGACY_FALLBACK === true || !isScannerFingerprintId(id);
}

function validLearningId(id = '') {
  const value = String(id || '').trim();

  if (!value) return false;
  if (!allowScannerFingerprintRow(value)) return false;
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

function getFamilyId(row = {}) {
  return firstValidLearningId([
    row.familyId,
    row.family,
    row.baseFamilyId
  ], null);
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

function cleanSideHaystack(text = '') {
  return upper(text)
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
    input.learningMicroFamilyId,
    input.analyzeMicroFamilyId,
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

function hasShortSignal(text = '') {
  const raw = ` ${cleanSideHaystack(text)} `;

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
  const raw = ` ${cleanSideHaystack(text)} `;

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
  if (typeof input === 'string') {
    const clean = cleanSideHaystack(input);
    const direct = normalizeSideToken(clean);

    if (direct === OPPOSITE_TRADE_SIDE || direct === TARGET_TRADE_SIDE) return direct;

    const shortSignal = hasShortSignal(clean);
    const longSignal = hasLongSignal(clean);

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

    if (normalized === OPPOSITE_TRADE_SIDE || normalized === TARGET_TRADE_SIDE) {
      return normalized;
    }
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
    input.trueMicroFamilyId ||
    input.learningMicroFamilyId ||
    input.analyzeMicroFamilyId ||
    input.microFamilyId ||
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
  const shortSignal = hasShortSignal(text);
  const longSignal = hasLongSignal(text);

  if (longSignal && !shortSignal) return TARGET_TRADE_SIDE;
  if (shortSignal && !longSignal) return OPPOSITE_TRADE_SIDE;

  if (shortSignal && longSignal) {
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

function isLongRow(row = {}) {
  return inferTradeSide(row) !== OPPOSITE_TRADE_SIDE;
}

function isAnalyzeMicroRow(row = {}) {
  const id = getMicroFamilyId(row);

  if (!id) return false;
  if (!validLearningId(id)) return false;
  if (!validLearningId(row.trueMicroFamilyId || id)) return false;
  if (!validLearningId(row.coarseMicroFamilyId || id)) return false;
  if (row.legacyScannerFamilyFallback === true) return false;

  const side = inferTradeSide({
    ...row,
    microFamilyId: id,
    trueMicroFamilyId: row.trueMicroFamilyId || row.learningMicroFamilyId || row.analyzeMicroFamilyId || row.microFamilyId || id,
    coarseMicroFamilyId: row.coarseMicroFamilyId || id
  });

  if (side === OPPOSITE_TRADE_SIDE) return false;

  if (isFixedLongTaxonomyMicroId(id)) return true;
  if (upper(id).startsWith('MICRO_LONG_')) return true;
  if (row.isTrueMicro === true || row.trueMicro === true) return true;
  if (row.trueMicroFamilyId || row.learningMicroFamilyId || row.analyzeMicroFamilyId || row.microFamilyId) return true;

  return false;
}

function sourceEntriesFromMicros(micros = {}) {
  if (Array.isArray(micros)) {
    return micros.map((row, index) => [
      getMicroFamilyId(row, String(index)),
      row
    ]);
  }

  if (!micros || typeof micros !== 'object') return [];

  return Object.entries(micros);
}

function microsCount(micros = {}) {
  return sourceEntriesFromMicros(micros)
    .filter(([key, row]) => {
      const id = getMicroFamilyId(row, key);

      return Boolean(id && validLearningId(id));
    })
    .length;
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

  if (!parsed) return PERSISTENT_LEARNING_KEY;

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
  const cursor = String(startWeekKey || PERSISTENT_LEARNING_KEY).trim() || PERSISTENT_LEARNING_KEY;

  if (!parseIsoWeekKey(cursor)) {
    return [cursor];
  }

  const keys = [];
  let current = cursor;

  for (let index = 0; index < count; index += 1) {
    if (!current || keys.includes(current)) break;

    keys.push(current);
    current = previousIsoWeekKeyFrom(current);
  }

  return keys;
}

function virtualKeyFromReal(realKey = '') {
  if (!realKey || !realKey.startsWith('real')) return null;

  return `virtual${realKey.slice(4)}`;
}

function shadowKeyFromReal(realKey = '') {
  if (!realKey || !realKey.startsWith('real')) return null;

  return `shadow${realKey.slice(4)}`;
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

function getOutcomeCounts(row = {}) {
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

function getCompletedSample(row = {}) {
  return getOutcomeCounts(row).total;
}

function getObservationSample(row = {}) {
  return Math.max(
    num(row.seen, 0),
    num(row.observations, 0),
    getCompletedSample(row),
    0
  );
}

function getTotalR(row = {}) {
  const completed = getCompletedSample(row);

  if (completed <= 0) return 0;

  if (hasValue(row.netTotalR)) return num(row.netTotalR, 0);
  if (hasValue(row.totalNetR)) return num(row.totalNetR, 0);
  if (hasValue(row.totalR)) return num(row.totalR, 0);

  return num(row.virtualTotalR, 0) + num(row.shadowTotalR, 0);
}

function getAvgR(row = {}) {
  const completed = getCompletedSample(row);

  if (completed <= 0) return 0;

  if (hasValue(row.avgNetR)) return num(row.avgNetR, 0);
  if (hasValue(row.netAvgR)) return num(row.netAvgR, 0);
  if (hasValue(row.avgR)) return num(row.avgR, 0);

  return getTotalR(row) / completed;
}

function getTotalCostR(row = {}) {
  const completed = getCompletedSample(row);

  if (completed <= 0) return 0;

  if (hasValue(row.totalCostR)) return num(row.totalCostR, 0);

  const combined = num(row.virtualTotalCostR, 0) + num(row.shadowTotalCostR, 0);

  if (combined > 0) return combined;
  if (hasValue(row.avgCostR)) return num(row.avgCostR, 0) * completed;

  return 0;
}

function getAvgCostR(row = {}) {
  const completed = getCompletedSample(row);

  if (completed <= 0) return 0;

  if (hasValue(row.avgCostR)) return num(row.avgCostR, 0);

  return getTotalCostR(row) / completed;
}

function getPositiveR(row = {}, aggregateKey, realKey = null, shadowKey = null) {
  if (aggregateKey && hasValue(row[aggregateKey])) {
    return Math.max(0, num(row[aggregateKey], 0));
  }

  const virtualKey = virtualKeyFromReal(realKey);
  const resolvedShadowKey = shadowKey || shadowKeyFromReal(realKey);

  return Math.max(
    0,
    num(virtualKey ? row[virtualKey] : 0, 0) +
      num(resolvedShadowKey ? row[resolvedShadowKey] : 0, 0)
  );
}

function getAbsLossR(row = {}, aggregateKey, realKey = null, shadowKey = null) {
  if (aggregateKey && hasValue(row[aggregateKey])) {
    return Math.abs(num(row[aggregateKey], 0));
  }

  const virtualKey = virtualKeyFromReal(realKey);
  const resolvedShadowKey = shadowKey || shadowKeyFromReal(realKey);

  return Math.abs(
    num(virtualKey ? row[virtualKey] : 0, 0) +
      num(resolvedShadowKey ? row[resolvedShadowKey] : 0, 0)
  );
}

function getProfitFactor(row = {}) {
  if (hasValue(row.netProfitFactor)) return num(row.netProfitFactor, 0);
  if (hasValue(row.profitFactor)) return num(row.profitFactor, 0);

  const winR = Math.max(
    getPositiveR(row, 'netWinR', 'realNetWinR', 'shadowNetWinR'),
    getPositiveR(row, 'totalWinR', 'realTotalWinR', 'shadowTotalWinR'),
    getPositiveR(row, 'grossWinR', 'realGrossWinR', 'shadowGrossWinR'),
    0
  );

  const lossR = Math.max(
    getAbsLossR(row, 'netLossR', 'realNetLossR', 'shadowNetLossR'),
    getAbsLossR(row, 'totalLossR', 'realTotalLossR', 'shadowTotalLossR'),
    getAbsLossR(row, 'grossLossR', 'realGrossLossR', 'shadowGrossLossR'),
    0
  );

  if (winR <= 0 && lossR <= 0) return 0;
  if (lossR <= 0) return winR > 0 ? 99 : 0;

  return winR / lossR;
}

function getCountMetric(row = {}, realCountKey, aggregateCountKey) {
  const shadowCountKey = shadowKeyFromReal(realCountKey);

  return getLearningCount(
    row,
    aggregateCountKey,
    realCountKey,
    shadowCountKey
  );
}

function getPctMetric(row = {}, realPctKey, realCountKey, aggregatePctKey, aggregateCountKey = null) {
  if (hasValue(row[aggregatePctKey])) {
    return clamp(row[aggregatePctKey], 0, 1);
  }

  const completed = getCompletedSample(row);
  const fallbackCountKey = aggregateCountKey || String(aggregatePctKey || '').replace(/Pct$/i, 'Count');
  const count = getCountMetric(row, realCountKey, fallbackCountKey);

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
  const counts = getOutcomeCounts(row);
  const completedSample = counts.total;
  const observationSample = getObservationSample(row);

  if (completedSample <= 0) {
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
  const rawWinrate = clamp(successes / completedSample, 0, 1);

  const bayesianWinrate = clamp(
    (successes + WINRATE_BAYES_ALPHA) /
      (completedSample + WINRATE_BAYES_ALPHA + WINRATE_BAYES_BETA),
    0,
    1
  );

  const wilson = wilsonLowerBound(successes, completedSample);
  const reliability = sampleReliability(completedSample);

  const score = clamp(
    wilson * 0.8 +
      bayesianWinrate * 0.15 +
      rawWinrate * 0.05,
    0,
    1
  );

  return {
    sample: completedSample,
    outcomeSample: completedSample,
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

function getObservationActivityScore(row = {}, meta = null) {
  const sample = meta?.observationSample ?? getObservationSample(row);

  if (sample <= 0) return 0;

  const seenComponent = Math.log1p(sample) * 8;
  const reliabilityComponent = sampleReliability(sample) * 18;

  const scannerReasonBonus = row.scannerReason || row.scannerReasonCoarse
    ? 2
    : 0;

  const definitionBonus = getDefinitionParts(row).length > 0
    ? 2
    : 0;

  return Math.max(
    1,
    Math.min(45, seenComponent + reliabilityComponent + scannerReasonBonus + definitionBonus)
  );
}

function getPerformanceBalancedScore(row = {}, meta = null) {
  const winrateMeta = meta || getSampleAdjustedWinrate(row);

  const totalR = Math.max(0, getTotalR(row));
  const avgR = Math.max(0, getAvgR(row));
  const profitFactor = Math.min(Math.max(0, getProfitFactor(row)), 20);

  const directSLPct = getPctMetric(row, 'realDirectSLPct', 'realDirectSLCount', 'directSLPct', 'directSLCount');
  const nearTpThenLossPct = getPctMetric(row, 'realNearTpThenLossPct', 'realNearTpThenLossCount', 'nearTpThenLossPct', 'nearTpThenLossCount');
  const gaveBackAfterOneRPct = getPctMetric(row, 'realGaveBackAfterOneRPct', 'realGaveBackAfterOneRCount', 'gaveBackAfterOneRPct', 'gaveBackAfterOneRCount');
  const avgCostR = Math.max(0, getAvgCostR(row));

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

function getDashboardBalancedScore(row = {}, meta = null) {
  const winrateMeta = meta || getSampleAdjustedWinrate(row);

  if (winrateMeta.outcomeSample <= 0 && winrateMeta.observationSample > 0) {
    return getObservationActivityScore(row, winrateMeta);
  }

  return getPerformanceBalancedScore(row, winrateMeta);
}

function learningStatusFor(row = {}, meta = null) {
  const winrateMeta = meta || getSampleAdjustedWinrate(row);

  if (winrateMeta.outcomeSample >= MIN_COMPLETED_ACTIVE_LEARNING) return 'ACTIVE_LEARNING';
  if (winrateMeta.outcomeSample > 0) return 'EARLY_OUTCOMES';

  return 'OBSERVING';
}

function tierFor(row = {}, meta = null) {
  const existing = row.tier || row.selectedTier || row.rotationEligibilityTier || row.eligibilityTier;

  if (existing && ['HARD', 'SOFT', 'OBSERVATION', 'RAW'].includes(upper(existing))) {
    const winrateMeta = meta || getSampleAdjustedWinrate(row);

    if (winrateMeta.outcomeSample >= MIN_COMPLETED_ACTIVE_LEARNING) return 'HARD';
    if (winrateMeta.outcomeSample > 0) return 'SOFT';
    if (winrateMeta.observationSample > 0) return 'OBSERVATION';

    return 'RAW';
  }

  const winrateMeta = meta || getSampleAdjustedWinrate(row);

  if (winrateMeta.outcomeSample >= MIN_COMPLETED_ACTIVE_LEARNING) return 'HARD';
  if (winrateMeta.outcomeSample > 0) return 'SOFT';
  if (winrateMeta.observationSample > 0) return 'OBSERVATION';

  return 'RAW';
}

function scannerMetadata(row = {}) {
  return {
    scannerMicroFamilyId: row.scannerMicroFamilyId || null,
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
    executionFingerprintsUsedAsLearningFamily: false
  };
}

function buildRawMicroRow(row = {}, key = '', index = 0) {
  const microFamilyId = getMicroFamilyId(row, key);

  if (!microFamilyId) return null;
  if (!validLearningId(microFamilyId)) return null;

  const trueMicroFamilyId = getTrueMicroFamilyId(row, microFamilyId);
  const coarseMicroFamilyId = getCoarseMicroFamilyId(row, trueMicroFamilyId);

  if (!validLearningId(trueMicroFamilyId)) return null;
  if (!validLearningId(coarseMicroFamilyId)) return null;

  const familyId = getFamilyId(row);
  const macroFamilyId = getMacroFamilyId({
    ...row,
    microFamilyId,
    trueMicroFamilyId,
    coarseMicroFamilyId,
    familyId
  });

  const definitionParts = getDefinitionParts(row);
  const macroDefinitionParts = getMacroDefinitionParts(row);

  const inferredTradeSide = inferTradeSide({
    ...row,
    microFamilyId,
    trueMicroFamilyId,
    coarseMicroFamilyId,
    familyId,
    macroFamilyId,
    definitionParts,
    macroDefinitionParts
  });

  if (inferredTradeSide === OPPOSITE_TRADE_SIDE) return null;

  const completed = getCompletedSample(row);
  const totalR = getTotalR(row);
  const totalCostR = getTotalCostR(row);
  const counts = getOutcomeCounts(row);
  const fixedTaxonomyLearningId = isFixedLongTaxonomyMicroId(trueMicroFamilyId);

  return {
    sourceIndex: index,

    microFamilyId,
    trueMicroFamilyId,
    analyzeMicroFamilyId: trueMicroFamilyId,
    learningMicroFamilyId: trueMicroFamilyId,
    coarseMicroFamilyId,
    familyId,
    macroFamilyId,

    parentMacroFamilyId: row.parentMacroFamilyId || macroFamilyId || null,
    parentMicroFamilyId: row.parentMicroFamilyId || macroFamilyId || null,

    ...scannerMetadata(row),

    scannerFingerprintLegacy: false,
    legacyScannerFamilyFallback: false,
    scannerFingerprintOnlyMetadata: true,
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    executionFingerprintsUsedAsLearningFamily: false,

    ...modePayload(),

    fixedTaxonomyLearningId,
    trueMicroFamilySchema: fixedTaxonomyLearningId
      ? TRUE_MICRO_SCHEMA
      : row.trueMicroFamilySchema || row.schema || null,

    inferredTradeSide,
    inferredFromLongOnlyMode: inferredTradeSide === 'UNKNOWN',

    sourceWeekKey: row.sourceWeekKey || PERSISTENT_LEARNING_KEY,
    sourceWeekPrimary: row.sourceWeekPrimary !== false,
    sourceWeekFallback: Boolean(row.sourceWeekFallback),

    active: Boolean(row.active),
    macroActive: Boolean(row.macroActive),

    seen: num(row.seen ?? row.observations, 0),
    observations: num(row.observations ?? row.seen, 0),

    completed: round(completed, 4),

    virtualCompleted: num(row.virtualCompleted, 0),
    shadowCompleted: num(row.shadowCompleted, 0),
    realCompleted: 0,

    wins: round(counts.wins, 4),
    losses: round(counts.losses, 4),
    flats: round(counts.flats, 4),

    virtualWins: num(row.virtualWins, 0),
    virtualLosses: num(row.virtualLosses, 0),
    virtualFlats: num(row.virtualFlats, 0),

    shadowWins: num(row.shadowWins, 0),
    shadowLosses: num(row.shadowLosses, 0),
    shadowFlats: num(row.shadowFlats, 0),

    realWins: 0,
    realLosses: 0,
    realFlats: 0,

    winrate: round(row.winrate, 4),
    bayesianWinrate: round(row.bayesianWinrate, 4),
    wilsonLowerBound: round(row.wilsonLowerBound, 4),

    totalR: round(totalR, 4),

    virtualTotalR: round(row.virtualTotalR, 4),
    shadowTotalR: round(row.shadowTotalR, 4),
    realTotalR: 0,

    avgR: round(getAvgR(row), 4),
    avgWinR: round(row.avgWinR, 4),
    avgLossR: round(row.avgLossR, 4),

    profitFactor: round(getProfitFactor(row), 4),

    directSLCount: round(getCountMetric(row, 'realDirectSLCount', 'directSLCount'), 4),
    directSLPct: round(getPctMetric(row, 'realDirectSLPct', 'realDirectSLCount', 'directSLPct', 'directSLCount'), 4),

    nearTpCount: round(getCountMetric(row, 'realNearTpCount', 'nearTpCount'), 4),
    nearTpPct: round(getPctMetric(row, 'realNearTpPct', 'realNearTpCount', 'nearTpPct', 'nearTpCount'), 4),

    reachedHalfRCount: round(getCountMetric(row, 'realReachedHalfRCount', 'reachedHalfRCount'), 4),
    reachedOneRCount: round(getCountMetric(row, 'realReachedOneRCount', 'reachedOneRCount'), 4),
    reachedHalfRPct: round(getPctMetric(row, 'realReachedHalfRPct', 'realReachedHalfRCount', 'reachedHalfRPct', 'reachedHalfRCount'), 4),
    reachedOneRPct: round(getPctMetric(row, 'realReachedOneRPct', 'realReachedOneRCount', 'reachedOneRPct', 'reachedOneRCount'), 4),

    beWouldExitCount: round(getCountMetric(row, 'realBeWouldExitCount', 'beWouldExitCount'), 4),
    beWouldExitPct: round(getPctMetric(row, 'realBeWouldExitPct', 'realBeWouldExitCount', 'beWouldExitPct', 'beWouldExitCount'), 4),

    gaveBackAfterHalfRCount: round(getCountMetric(row, 'realGaveBackAfterHalfRCount', 'gaveBackAfterHalfRCount'), 4),
    gaveBackAfterOneRCount: round(getCountMetric(row, 'realGaveBackAfterOneRCount', 'gaveBackAfterOneRCount'), 4),
    gaveBackAfterHalfRPct: round(getPctMetric(row, 'realGaveBackAfterHalfRPct', 'realGaveBackAfterHalfRCount', 'gaveBackAfterHalfRPct', 'gaveBackAfterHalfRCount'), 4),
    gaveBackAfterOneRPct: round(getPctMetric(row, 'realGaveBackAfterOneRPct', 'realGaveBackAfterOneRCount', 'gaveBackAfterOneRPct', 'gaveBackAfterOneRCount'), 4),

    nearTpThenLossCount: round(getCountMetric(row, 'realNearTpThenLossCount', 'nearTpThenLossCount'), 4),
    nearTpThenLossPct: round(getPctMetric(row, 'realNearTpThenLossPct', 'realNearTpThenLossCount', 'nearTpThenLossPct', 'nearTpThenLossCount'), 4),

    totalCostR: round(totalCostR, 4),
    avgCostR: round(getAvgCostR(row), 4),

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
    setupType: row.setupType || null,
    regimeBucket: row.regimeBucket || null,

    scannerReason: row.scannerReason || null,
    scannerReasonCoarse: row.scannerReasonCoarse || null,

    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };
}

function decorateMicroRow(row = {}) {
  if (!row?.microFamilyId) return null;
  if (!isAnalyzeMicroRow(row)) return null;

  const winrate = getSampleAdjustedWinrate(row);
  const dashboardBalancedScore = getDashboardBalancedScore(row, winrate);
  const learningStatus = learningStatusFor(row, winrate);
  const tier = tierFor(row, winrate);
  const tooEarly = winrate.outcomeSample < MIN_COMPLETED_ACTIVE_LEARNING;

  return {
    ...row,

    ...modePayload(),

    scannerFingerprintLegacy: false,
    legacyScannerFamilyFallback: false,
    scannerFingerprintOnlyMetadata: true,
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsUsedAsLearningFamily: false,

    completed: round(winrate.outcomeSample, 4),
    wins: round(winrate.wins, 4),
    losses: round(winrate.losses, 4),
    flats: round(winrate.flats, 4),

    outcomeSample: round(winrate.outcomeSample, 4),
    observationSample: round(winrate.observationSample, 4),

    winrateSample: round(winrate.sample, 4),
    sampleAdjustedWinrate: round(row.sampleAdjustedWinrate ?? winrate.score, 4),
    sampleRawWinrate: round(row.sampleRawWinrate ?? winrate.rawWinrate, 4),
    sampleBayesianWinrate: round(row.sampleBayesianWinrate ?? winrate.bayesianWinrate, 4),
    sampleWilsonLowerBound: round(row.sampleWilsonLowerBound ?? winrate.wilsonLowerBound, 4),
    sampleReliability: round(row.sampleReliability ?? winrate.reliability, 4),

    winrate: round(winrate.rawWinrate, 4),
    bayesianWinrate: round(winrate.bayesianWinrate, 4),
    wilsonLowerBound: round(winrate.wilsonLowerBound, 4),

    fairWinrate: round(
      row.fairWinrate ??
      row.sampleAdjustedWinrate ??
      winrate.score ??
      row.bayesianWinrate ??
      row.wilsonLowerBound,
      4
    ),

    totalR: round(getTotalR(row), 4),
    avgR: round(getAvgR(row), 4),
    profitFactor: round(getProfitFactor(row), 4),

    totalCostR: round(getTotalCostR(row), 4),
    avgCostR: round(getAvgCostR(row), 4),

    dashboardBalancedScore: round(row.dashboardBalancedScore ?? dashboardBalancedScore, 4),
    balancedScore: round(row.balancedScore ?? dashboardBalancedScore, 4),

    awaitingOutcomes: Boolean(winrate.awaitingOutcomes),
    learningStatus,
    status: learningStatus,

    tooEarly,
    tooEarlyReason: tooEarly
      ? `COMPLETED_BELOW_${MIN_COMPLETED_ACTIVE_LEARNING}`
      : null,

    tier,
    selectedTier: row.selectedTier || row.rotationEligibilityTier || tier,
    rotationEligibilityTier: row.rotationEligibilityTier || row.selectedTier || tier
  };
}

function buildRowsFromMicros(micros = {}) {
  return sourceEntriesFromMicros(micros)
    .map(([key, row], index) => {
      const id = getMicroFamilyId(row, key);

      if (!id) return null;
      if (!validLearningId(id)) return null;

      const baseRow = {
        ...(row || {}),
        key,
        microFamilyId: id,
        trueMicroFamilyId: getTrueMicroFamilyId(row, id),
        analyzeMicroFamilyId: getTrueMicroFamilyId(row, id),
        learningMicroFamilyId: getTrueMicroFamilyId(row, id),
        coarseMicroFamilyId: getCoarseMicroFamilyId(row, id),
        sourceWeekKey: PERSISTENT_LEARNING_KEY,
        sourceWeekPrimary: true,
        sourceWeekFallback: false,
        ...modePayload()
      };

      const raw = buildRawMicroRow(baseRow, key, index);

      return raw ? decorateMicroRow(raw) : null;
    })
    .filter(Boolean)
    .filter(isAnalyzeMicroRow);
}

function rowKey(row = {}) {
  return String(
    row.trueMicroFamilyId ||
    row.learningMicroFamilyId ||
    row.analyzeMicroFamilyId ||
    row.microFamilyId ||
    row.id ||
    row.key ||
    ''
  ).trim();
}

function mergeRows(primaryRows = [], fallbackRows = []) {
  const byKey = new Map();

  for (const row of fallbackRows) {
    const key = rowKey(row);
    if (!key || !isAnalyzeMicroRow(row)) continue;

    byKey.set(key, row);
  }

  for (const row of primaryRows) {
    const key = rowKey(row);
    if (!key || !isAnalyzeMicroRow(row)) continue;

    const existing = byKey.get(key);

    byKey.set(key, existing
      ? {
        ...existing,
        ...row,
        active: Boolean(existing.active || row.active),
        macroActive: Boolean(existing.macroActive || row.macroActive),
        selectedTier: row.selectedTier || existing.selectedTier,
        rotationEligibilityTier: row.rotationEligibilityTier || existing.rotationEligibilityTier,
        tier: row.tier || existing.tier
      }
      : row
    );
  }

  return [...byKey.values()].filter(isAnalyzeMicroRow);
}

function manualRowFromId(id, index = 0) {
  if (!id || inferTradeSide(id) === OPPOSITE_TRADE_SIDE) return null;
  if (!validLearningId(id)) return null;

  const raw = buildRawMicroRow({
    microFamilyId: id,
    trueMicroFamilyId: id,
    analyzeMicroFamilyId: id,
    learningMicroFamilyId: id,
    coarseMicroFamilyId: id,
    familyId: null,
    macroFamilyId: null,

    ...modePayload(),

    fixedTaxonomyLearningId: isFixedLongTaxonomyMicroId(id),
    trueMicroFamilySchema: isFixedLongTaxonomyMicroId(id)
      ? TRUE_MICRO_SCHEMA
      : null,

    active: true,
    macroActive: false,

    seen: 0,
    observations: 0,
    completed: 0,
    virtualCompleted: 0,
    shadowCompleted: 0,
    winrateSample: 0,
    winrate: 0,
    totalR: 0,
    virtualTotalR: 0,
    shadowTotalR: 0,
    avgR: 0,
    profitFactor: 0,
    directSLPct: 0,
    avgCostR: 0,
    selectedTier: 'RAW',
    rotationEligibilityTier: 'RAW'
  }, id, index);

  return raw ? decorateMicroRow(raw) : null;
}

function extractActiveIds(activeRotation) {
  if (!activeRotation) return [];

  const ids = [
    activeRotation.microFamilyIds || [],
    activeRotation.activeMicroFamilyIds || [],
    activeRotation.trueMicroFamilyIds || [],
    activeRotation.ids || [],
    Array.isArray(activeRotation.microFamilies)
      ? activeRotation.microFamilies.map((row) => getTrueMicroFamilyId(row))
      : []
  ];

  return uniqueStrings(ids).filter((id) => (
    inferTradeSide(id) !== OPPOSITE_TRADE_SIDE &&
    validLearningId(id)
  ));
}

function extractActiveMacroIds(activeRotation) {
  if (!activeRotation) return [];

  const ids = [
    activeRotation.macroFamilyIds || [],
    activeRotation.activeMacroFamilyIds || [],
    activeRotation.macroIds || [],
    Array.isArray(activeRotation.microFamilies)
      ? activeRotation.microFamilies.map((row) => getMacroFamilyId(row))
      : []
  ];

  return uniqueStrings(ids).filter((id) => (
    inferTradeSide(id) !== OPPOSITE_TRADE_SIDE &&
    validLearningId(id)
  ));
}

function buildRowsFromActiveRotation(activeRotation) {
  if (!activeRotation) return [];

  const rows = [];

  if (Array.isArray(activeRotation.microFamilies)) {
    rows.push(
      ...activeRotation.microFamilies
        .map((row, index) => {
          if (inferTradeSide(row) === OPPOSITE_TRADE_SIDE) return null;

          const id = getTrueMicroFamilyId(row, `active_${index}`);
          if (!id || !validLearningId(id)) return null;

          const raw = buildRawMicroRow({
            ...row,
            ...modePayload(),
            microFamilyId: id,
            trueMicroFamilyId: id,
            analyzeMicroFamilyId: id,
            learningMicroFamilyId: id,
            coarseMicroFamilyId: getCoarseMicroFamilyId(row, id),
            active: true,
            selectedTier: row.selectedTier || row.rotationEligibilityTier || activeRotation.selectedTier || 'RAW'
          }, id, index);

          return raw ? decorateMicroRow(raw) : null;
        })
        .filter(Boolean)
        .filter(isAnalyzeMicroRow)
    );
  }

  const existing = new Set(rows.map(rowKey).filter(Boolean));

  for (const id of extractActiveIds(activeRotation)) {
    if (existing.has(id)) continue;

    const manual = manualRowFromId(id, rows.length);
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
  const microFamilyId = getMicroFamilyId(row);
  const trueMicroFamilyId = getTrueMicroFamilyId(row, microFamilyId);
  const coarseMicroFamilyId = getCoarseMicroFamilyId(row, trueMicroFamilyId);

  const familyId = getFamilyId(row);
  const macroFamilyId = getMacroFamilyId(row);

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

  const winrate = getSampleAdjustedWinrate(row);
  const tier = tierFor(row, winrate);
  const learningStatus = learningStatusFor(row, winrate);
  const tooEarly = winrate.outcomeSample < MIN_COMPLETED_ACTIVE_LEARNING;

  const fixedTaxonomyLearningId = isFixedLongTaxonomyMicroId(trueMicroFamilyId);

  const base = {
    rank: index + 1,

    microFamilyId,
    trueMicroFamilyId,
    analyzeMicroFamilyId: trueMicroFamilyId,
    learningMicroFamilyId: trueMicroFamilyId,
    coarseMicroFamilyId,
    familyId,
    macroFamilyId,

    parentMacroFamilyId: row.parentMacroFamilyId || macroFamilyId || null,
    parentMicroFamilyId: row.parentMicroFamilyId || macroFamilyId || null,

    ...scannerMetadata(row),

    scannerFingerprintLegacy: false,
    legacyScannerFamilyFallback: false,
    scannerFingerprintOnlyMetadata: true,
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsUsedAsLearningFamily: false,

    ...modePayload(),

    fixedTaxonomyLearningId,
    trueMicroFamilySchema: fixedTaxonomyLearningId
      ? TRUE_MICRO_SCHEMA
      : row.trueMicroFamilySchema || row.schema || null,

    inferredTradeSide: row.inferredTradeSide || inferTradeSide(row),
    inferredFromLongOnlyMode: Boolean(row.inferredFromLongOnlyMode),

    sourceWeekKey: row.sourceWeekKey || PERSISTENT_LEARNING_KEY,
    sourceWeekPrimary: row.sourceWeekPrimary !== false,
    sourceWeekFallback: Boolean(row.sourceWeekFallback),

    active,
    macroActive,

    seen: num(row.seen, 0),
    observations: num(row.observations, 0),

    completed: round(winrate.outcomeSample, 4),

    virtualCompleted: num(row.virtualCompleted, 0),
    shadowCompleted: num(row.shadowCompleted, 0),
    realCompleted: 0,

    outcomeSample: round(winrate.outcomeSample, 4),
    observationSample: round(winrate.observationSample, 4),

    awaitingOutcomes: Boolean(winrate.awaitingOutcomes),
    learningStatus,
    status: learningStatus,

    tooEarly,
    tooEarlyReason: tooEarly
      ? `COMPLETED_BELOW_${MIN_COMPLETED_ACTIVE_LEARNING}`
      : null,

    tier,
    selectedTier: row.selectedTier || row.rotationEligibilityTier || tier,
    rotationEligibilityTier: row.rotationEligibilityTier || row.selectedTier || tier,

    wins: round(winrate.wins, 4),
    losses: round(winrate.losses, 4),
    flats: round(winrate.flats, 4),

    virtualWins: num(row.virtualWins, 0),
    virtualLosses: num(row.virtualLosses, 0),
    virtualFlats: num(row.virtualFlats, 0),

    shadowWins: num(row.shadowWins, 0),
    shadowLosses: num(row.shadowLosses, 0),
    shadowFlats: num(row.shadowFlats, 0),

    realWins: 0,
    realLosses: 0,
    realFlats: 0,

    winrate: round(winrate.rawWinrate, 4),
    bayesianWinrate: round(winrate.bayesianWinrate, 4),
    wilsonLowerBound: round(winrate.wilsonLowerBound, 4),
    fairWinrate: round(row.fairWinrate ?? winrate.score, 4),

    winrateSample: round(winrate.sample, 4),
    sampleAdjustedWinrate: round(row.sampleAdjustedWinrate ?? winrate.score, 4),
    sampleRawWinrate: round(row.sampleRawWinrate ?? winrate.rawWinrate, 4),
    sampleBayesianWinrate: round(row.sampleBayesianWinrate ?? winrate.bayesianWinrate, 4),
    sampleWilsonLowerBound: round(row.sampleWilsonLowerBound ?? winrate.wilsonLowerBound, 4),
    sampleReliability: round(row.sampleReliability ?? winrate.reliability, 4),

    totalR: round(getTotalR(row), 4),
    virtualTotalR: round(row.virtualTotalR, 4),
    shadowTotalR: round(row.shadowTotalR, 4),
    realTotalR: 0,

    avgR: round(getAvgR(row), 4),
    avgWinR: round(row.avgWinR, 4),
    avgLossR: round(row.avgLossR, 4),

    profitFactor: round(getProfitFactor(row), 4),

    directSLCount: round(getCountMetric(row, 'realDirectSLCount', 'directSLCount'), 4),
    directSLPct: round(getPctMetric(row, 'realDirectSLPct', 'realDirectSLCount', 'directSLPct', 'directSLCount'), 4),

    nearTpCount: round(getCountMetric(row, 'realNearTpCount', 'nearTpCount'), 4),
    nearTpPct: round(getPctMetric(row, 'realNearTpPct', 'realNearTpCount', 'nearTpPct', 'nearTpCount'), 4),

    reachedHalfRCount: round(getCountMetric(row, 'realReachedHalfRCount', 'reachedHalfRCount'), 4),
    reachedOneRCount: round(getCountMetric(row, 'realReachedOneRCount', 'reachedOneRCount'), 4),
    reachedHalfRPct: round(getPctMetric(row, 'realReachedHalfRPct', 'realReachedHalfRCount', 'reachedHalfRPct', 'reachedHalfRCount'), 4),
    reachedOneRPct: round(getPctMetric(row, 'realReachedOneRPct', 'realReachedOneRCount', 'reachedOneRPct', 'reachedOneRCount'), 4),

    beWouldExitCount: round(getCountMetric(row, 'realBeWouldExitCount', 'beWouldExitCount'), 4),
    beWouldExitPct: round(getPctMetric(row, 'realBeWouldExitPct', 'realBeWouldExitCount', 'beWouldExitPct', 'beWouldExitCount'), 4),

    gaveBackAfterHalfRCount: round(getCountMetric(row, 'realGaveBackAfterHalfRCount', 'gaveBackAfterHalfRCount'), 4),
    gaveBackAfterOneRCount: round(getCountMetric(row, 'realGaveBackAfterOneRCount', 'gaveBackAfterOneRCount'), 4),
    gaveBackAfterHalfRPct: round(getPctMetric(row, 'realGaveBackAfterHalfRPct', 'realGaveBackAfterHalfRCount', 'gaveBackAfterHalfRPct', 'gaveBackAfterHalfRCount'), 4),
    gaveBackAfterOneRPct: round(getPctMetric(row, 'realGaveBackAfterOneRPct', 'realGaveBackAfterOneRCount', 'gaveBackAfterOneRPct', 'gaveBackAfterOneRCount'), 4),

    nearTpThenLossCount: round(getCountMetric(row, 'realNearTpThenLossCount', 'nearTpThenLossCount'), 4),
    nearTpThenLossPct: round(getPctMetric(row, 'realNearTpThenLossPct', 'realNearTpThenLossCount', 'nearTpThenLossPct', 'nearTpThenLossCount'), 4),

    totalCostR: round(getTotalCostR(row), 4),
    avgCostR: round(getAvgCostR(row), 4),

    balancedScore: round(row.balancedScore, 4),
    dashboardBalancedScore: round(row.dashboardBalancedScore ?? getDashboardBalancedScore(row, winrate), 4),

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
    setupType: row.setupType || null,
    regimeBucket: row.regimeBucket || null,
    scannerReason: row.scannerReason || null,
    scannerReasonCoarse: row.scannerReasonCoarse || null,

    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };

  if (compact) return base;

  return {
    ...row,
    ...base,

    counters: row.counters || {},
    examples: Array.isArray(row.examples)
      ? row.examples.filter(isLongRow).slice(-8)
      : [],

    recentOutcomes: Array.isArray(row.recentOutcomes)
      ? row.recentOutcomes.filter(isLongRow).slice(-8)
      : []
  };
}

function compactBestRow(row) {
  if (!row) return null;
  if (!isAnalyzeMicroRow(row)) return null;

  const microFamilyId = getMicroFamilyId(row);
  const trueMicroFamilyId = getTrueMicroFamilyId(row, microFamilyId);
  const fixedTaxonomyLearningId = isFixedLongTaxonomyMicroId(trueMicroFamilyId);

  return {
    microFamilyId,
    trueMicroFamilyId,
    analyzeMicroFamilyId: trueMicroFamilyId,
    learningMicroFamilyId: trueMicroFamilyId,
    coarseMicroFamilyId: getCoarseMicroFamilyId(row, trueMicroFamilyId),
    familyId: getFamilyId(row),
    macroFamilyId: getMacroFamilyId(row),

    ...modePayload(),

    fixedTaxonomyLearningId,
    trueMicroFamilySchema: fixedTaxonomyLearningId
      ? TRUE_MICRO_SCHEMA
      : row.trueMicroFamilySchema || row.schema || null,

    ...scannerMetadata(row),

    scannerFingerprintLegacy: false,
    legacyScannerFamilyFallback: false,
    scannerFingerprintOnlyMetadata: true,
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsUsedAsLearningFamily: false,

    active: Boolean(row.active),
    macroActive: Boolean(row.macroActive),

    seen: num(row.seen, 0),
    observations: num(row.observations, 0),

    completed: round(row.outcomeSample ?? getCompletedSample(row), 4),
    outcomeSample: round(row.outcomeSample ?? getCompletedSample(row), 4),
    observationSample: round(row.observationSample ?? getObservationSample(row), 4),

    awaitingOutcomes: Boolean(row.awaitingOutcomes),
    learningStatus: row.learningStatus || learningStatusFor(row),
    status: row.status || row.learningStatus || learningStatusFor(row),

    tooEarly: num(row.outcomeSample ?? getCompletedSample(row), 0) < MIN_COMPLETED_ACTIVE_LEARNING,
    minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,

    tier: row.tier || tierFor(row),
    selectedTier: row.selectedTier || row.rotationEligibilityTier || row.tier || tierFor(row),
    rotationEligibilityTier: row.rotationEligibilityTier || row.selectedTier || row.tier || tierFor(row),

    winrateSample: round(row.winrateSample, 4),
    winrate: round(row.winrate, 4),
    fairWinrate: round(row.fairWinrate, 4),
    sampleAdjustedWinrate: round(row.sampleAdjustedWinrate, 4),
    sampleWilsonLowerBound: round(row.sampleWilsonLowerBound, 4),
    sampleReliability: round(row.sampleReliability, 4),

    avgR: round(getAvgR(row), 4),
    totalR: round(getTotalR(row), 4),
    profitFactor: round(getProfitFactor(row), 4),

    directSLPct: round(row.directSLPct, 4),
    avgCostR: round(getAvgCostR(row), 4),

    balancedScore: round(row.balancedScore, 4),
    dashboardBalancedScore: round(row.dashboardBalancedScore, 4)
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

    ...modePayload(),

    trueMicroOnly: activeRotation.trueMicroOnly !== false,
    exactTrueMicroOnly: true,

    manualOnly: true,
    adminSelected: Boolean(activeRotation.adminSelected || activeRotation.manualOnly),
    liveSelectable: Boolean(activeRotation.liveSelectable),

    usedLegacyFallback: false,
    usedSoftFallback: Boolean(activeRotation.usedSoftFallback),
    usedObservationFallback: Boolean(activeRotation.usedObservationFallback),
    usedRawFallback: Boolean(activeRotation.usedRawFallback),

    selectedTier: activeRotation.selectedTier || null,
    missingSides: Array.isArray(activeRotation.missingSides)
      ? activeRotation.missingSides.filter((side) => upper(side) !== OPPOSITE_TRADE_SIDE)
      : [],

    microFamilyIds: activeMicroFamilyIds,
    activeMicroFamilyIds,
    trueMicroFamilyIds: activeMicroFamilyIds,

    macroFamilyIds: activeMacroFamilyIds,
    activeMacroFamilyIds,

    bestLong: activeRotation.bestLong
      ? compactBestRow(activeRotation.bestLong)
      : null,
    bestShort: null
  };
}

function parseFilters(req) {
  const side = normalizeRequestedTradeSide(firstQueryValue(req.query?.side, TARGET_TRADE_SIDE));
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
    minSeen: num(firstQueryValue(req.query?.minSeen, 0), 0),

    tier: String(firstQueryValue(req.query?.tier, '') || '').trim().toUpperCase(),
    status: String(firstQueryValue(req.query?.status, '') || '').trim().toUpperCase()
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
    filters.minSeen > 0 ||
    filters.tier ||
    filters.status
  );
}

function rowMatchesSearch(row = {}, q = '') {
  if (!q) return true;

  const haystack = [
    row.microFamilyId,
    row.trueMicroFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.coarseMicroFamilyId,
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
    row.setupType,
    row.regimeBucket,
    ...getArray(row.definitionParts),
    ...getArray(row.microDefinitionParts),
    ...getArray(row.macroDefinitionParts),
    ...getArray(row.parentDefinitionParts),
    ...getArray(row.executionFingerprintParts)
  ]
    .map((value) => upper(value))
    .join(' | ');

  return haystack.includes(q);
}

function rowPassesFilters(row = {}, filters, activeSet, activeMacroSet) {
  if (!row?.microFamilyId) return false;
  if (!isAnalyzeMicroRow(row)) return false;

  const exactId = row.trueMicroFamilyId || row.learningMicroFamilyId || row.analyzeMicroFamilyId || row.microFamilyId;

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

  if (filters.activeOnly && !activeSet.has(exactId)) {
    return false;
  }

  if (filters.macroActiveOnly && !activeMacroSet.has(getMacroFamilyId(row))) {
    return false;
  }

  if (filters.minCompleted > 0 && num(row.outcomeSample ?? getCompletedSample(row), 0) < filters.minCompleted) {
    return false;
  }

  if (filters.minSample > 0 && num(row.winrateSample, 0) < filters.minSample) {
    return false;
  }

  if (filters.minSeen > 0 && num(row.seen, 0) < filters.minSeen) {
    return false;
  }

  if (filters.tier && upper(row.tier || row.rotationEligibilityTier) !== filters.tier) {
    return false;
  }

  if (filters.status && upper(row.status || row.learningStatus) !== filters.status) {
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

function learningQualityRank(row = {}) {
  const completed = num(row.outcomeSample ?? getCompletedSample(row), 0);
  const observations = num(row.observationSample ?? getObservationSample(row), 0);

  if (completed >= MIN_COMPLETED_ACTIVE_LEARNING) return 3;
  if (completed > 0) return 2;
  if (observations > 0) return 1;

  return 0;
}

function compareRowsWinrate(a, b) {
  return (
    compareNumberDesc(a.sampleAdjustedWinrate ?? a.fairWinrate, b.sampleAdjustedWinrate ?? b.fairWinrate) ||
    compareNumberDesc(a.sampleWilsonLowerBound ?? a.wilsonLowerBound, b.sampleWilsonLowerBound ?? b.wilsonLowerBound) ||
    compareNumberDesc(a.sampleBayesianWinrate ?? a.bayesianWinrate, b.sampleBayesianWinrate ?? b.bayesianWinrate) ||
    compareNumberDesc(a.sampleReliability, b.sampleReliability) ||
    compareNumberDesc(a.outcomeSample, b.outcomeSample) ||
    compareNumberDesc(getTotalR(a), getTotalR(b)) ||
    compareNumberDesc(getAvgR(a), getAvgR(b)) ||
    compareNumberDesc(a.observationSample, b.observationSample) ||
    compareNumberDesc(a.seen, b.seen) ||
    compareIdAsc(a.microFamilyId, b.microFamilyId)
  );
}

function compareRowsBestData(a, b) {
  return (
    compareNumberDesc(learningQualityRank(a), learningQualityRank(b)) ||
    compareNumberDesc(a.outcomeSample ?? getCompletedSample(a), b.outcomeSample ?? getCompletedSample(b)) ||
    compareNumberDesc(a.sampleAdjustedWinrate ?? a.fairWinrate, b.sampleAdjustedWinrate ?? b.fairWinrate) ||
    compareNumberDesc(a.fairWinrate, b.fairWinrate) ||
    compareNumberDesc(a.sampleWilsonLowerBound ?? a.wilsonLowerBound, b.sampleWilsonLowerBound ?? b.wilsonLowerBound) ||
    compareNumberDesc(a.sampleReliability, b.sampleReliability) ||
    compareNumberDesc(getTotalR(a), getTotalR(b)) ||
    compareNumberDesc(getAvgR(a), getAvgR(b)) ||
    compareNumberAsc(a.directSLPct, b.directSLPct) ||
    compareNumberDesc(a.observationSample ?? getObservationSample(a), b.observationSample ?? getObservationSample(b)) ||
    compareNumberDesc(a.seen, b.seen) ||
    compareNumberDesc(a.dashboardBalancedScore ?? a.balancedScore, b.dashboardBalancedScore ?? b.balancedScore) ||
    compareNumberDesc(a.balancedScore, b.balancedScore) ||
    compareIdAsc(a.microFamilyId, b.microFamilyId)
  );
}

function compareRowsBalanced(a, b) {
  return compareRowsBestData(a, b);
}

function compareRowsTotalR(a, b) {
  return (
    compareNumberDesc(a.dashboardBalancedScore ?? a.balancedScore, b.dashboardBalancedScore ?? b.balancedScore) ||
    compareNumberDesc(a.sampleAdjustedWinrate ?? a.fairWinrate, b.sampleAdjustedWinrate ?? b.fairWinrate) ||
    compareNumberDesc(getTotalR(a), getTotalR(b)) ||
    compareNumberDesc(getAvgR(a), getAvgR(b)) ||
    compareIdAsc(a.microFamilyId, b.microFamilyId)
  );
}

function compareRowsAvgR(a, b) {
  return (
    compareNumberDesc(a.dashboardBalancedScore ?? a.balancedScore, b.dashboardBalancedScore ?? b.balancedScore) ||
    compareNumberDesc(a.sampleAdjustedWinrate ?? a.fairWinrate, b.sampleAdjustedWinrate ?? b.fairWinrate) ||
    compareNumberDesc(getAvgR(a), getAvgR(b)) ||
    compareNumberDesc(getTotalR(a), getTotalR(b)) ||
    compareIdAsc(a.microFamilyId, b.microFamilyId)
  );
}

function compareRowsDirectSL(a, b) {
  return (
    compareNumberAsc(a.directSLPct, b.directSLPct) ||
    compareNumberDesc(a.dashboardBalancedScore ?? a.balancedScore, b.dashboardBalancedScore ?? b.balancedScore) ||
    compareNumberDesc(a.outcomeSample, b.outcomeSample) ||
    compareNumberDesc(a.observationSample, b.observationSample) ||
    compareRowsWinrate(a, b)
  );
}

function compareRowsObserved(a, b) {
  return (
    compareNumberDesc(a.observationSample, b.observationSample) ||
    compareNumberDesc(a.seen, b.seen) ||
    compareNumberDesc(a.observations, b.observations) ||
    compareNumberDesc(a.dashboardBalancedScore ?? a.balancedScore, b.dashboardBalancedScore ?? b.balancedScore) ||
    compareNumberDesc(a.outcomeSample, b.outcomeSample) ||
    compareIdAsc(a.microFamilyId, b.microFamilyId)
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
  return [...rows]
    .filter(isAnalyzeMicroRow)
    .sort((a, b) => compareRowsByMode(a, b, mode));
}

function sideCounts(rows = []) {
  return rows.reduce(
    (acc, row) => {
      const side = inferTradeSide(row);

      if (side === OPPOSITE_TRADE_SIDE) acc.short += 1;
      else acc.long += 1;

      if (side === 'UNKNOWN') acc.unknown += 1;

      return acc;
    },
    {
      long: 0,
      short: 0,
      unknown: 0
    }
  );
}

function tierCounts(rows = []) {
  return rows.reduce(
    (acc, row) => {
      const tier = upper(row.tier || row.rotationEligibilityTier || tierFor(row));

      if (tier === 'HARD') acc.HARD += 1;
      else if (tier === 'SOFT') acc.SOFT += 1;
      else if (tier === 'OBSERVATION') acc.OBSERVATION += 1;
      else acc.RAW += 1;

      return acc;
    },
    {
      HARD: 0,
      SOFT: 0,
      OBSERVATION: 0,
      RAW: 0
    }
  );
}

function statusCounts(rows = []) {
  return rows.reduce((acc, row) => {
    const status = String(row.status || row.learningStatus || learningStatusFor(row)).toUpperCase();

    acc[status] = (acc[status] || 0) + 1;

    return acc;
  }, {});
}

function bestBy(rows = [], comparator) {
  return [...rows].filter(isAnalyzeMicroRow).sort(comparator)[0] || null;
}

function buildSideSummary(rows = []) {
  const longRows = rows.filter(isAnalyzeMicroRow);

  return {
    rows: longRows.length,
    bestBalanced: compactBestRow(bestBy(longRows, compareRowsBalanced)),
    bestWinrate: compactBestRow(bestBy(longRows, compareRowsWinrate)),
    bestTotalR: compactBestRow(bestBy(longRows, compareRowsTotalR)),
    bestAvgR: compactBestRow(bestBy(longRows, compareRowsAvgR)),
    lowestDirectSL: compactBestRow(bestBy(longRows, compareRowsDirectSL))
  };
}

function buildSummary(rows = [], activeSet = new Set()) {
  const safeRows = rows.filter(isAnalyzeMicroRow);

  const completedRows = safeRows.filter((row) => num(row.outcomeSample, 0) > 0);
  const observationRows = safeRows.filter((row) => num(row.observationSample, 0) > 0);
  const activeLearningRows = safeRows.filter((row) => row.status === 'ACTIVE_LEARNING');
  const earlyOutcomeRows = safeRows.filter((row) => row.status === 'EARLY_OUTCOMES');
  const observingRows = safeRows.filter((row) => row.status === 'OBSERVING');

  const activeRows = safeRows.filter((row) => (
    activeSet.has(row.trueMicroFamilyId || row.learningMicroFamilyId || row.analyzeMicroFamilyId || row.microFamilyId || row.id || row.key)
  ));

  let totalR = 0;
  let totalSeen = 0;
  let totalCompleted = 0;
  let totalObservationSample = 0;
  let totalWinrateSample = 0;
  let totalCostR = 0;

  for (const row of safeRows) {
    totalR += getTotalR(row);
    totalSeen += num(row.seen, 0);
    totalCompleted += num(row.outcomeSample, 0);
    totalObservationSample += num(row.observationSample, 0);
    totalWinrateSample += num(row.winrateSample, 0);
    totalCostR += getTotalCostR(row);
  }

  return {
    rows: safeRows.length,
    activeRows: activeRows.length,
    activeIds: activeSet.size,

    ...modePayload(),

    seen: round(totalSeen, 4),
    completed: round(totalCompleted, 4),
    observationSample: round(totalObservationSample, 4),
    winrateSample: round(totalWinrateSample, 4),

    completedMicroFamilies: completedRows.length,
    observationMicroFamilies: observationRows.length,
    awaitingOutcomeMicroFamilies: safeRows.filter((row) => row.awaitingOutcomes).length,

    activeLearningMicroFamilies: activeLearningRows.length,
    earlyOutcomeMicroFamilies: earlyOutcomeRows.length,
    observingMicroFamilies: observingRows.length,

    hardMicroFamilies: tierCounts(safeRows).HARD,
    softMicroFamilies: tierCounts(safeRows).SOFT,
    observationOnlyMicroFamilies: tierCounts(safeRows).OBSERVATION,
    rawMicroFamilies: tierCounts(safeRows).RAW,

    tierCounts: tierCounts(safeRows),
    statusCounts: statusCounts(safeRows),

    totalR: round(totalR, 4),
    totalCostR: round(totalCostR, 4),
    avgR: totalCompleted > 0 ? round(totalR / totalCompleted, 4) : 0,
    avgCostR: totalCompleted > 0 ? round(totalCostR / totalCompleted, 4) : 0,

    bestBalanced: compactBestRow(bestBy(safeRows, compareRowsBalanced)),
    bestTotalR: compactBestRow(bestBy(safeRows, compareRowsTotalR)),
    bestAvgR: compactBestRow(bestBy(safeRows, compareRowsAvgR)),
    bestWinrate: compactBestRow(bestBy(safeRows, compareRowsWinrate)),
    bestObserved: compactBestRow(bestBy(safeRows, compareRowsObserved)),
    lowestDirectSL: compactBestRow(bestBy(safeRows, compareRowsDirectSL)),

    long: buildSideSummary(safeRows),

    short: {
      rows: 0,
      bestBalanced: null,
      bestWinrate: null,
      bestTotalR: null,
      bestAvgR: null,
      lowestDirectSL: null
    }
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

function mergeMicrosByRecency(weekResults = []) {
  const merged = {};

  for (const result of [...weekResults].reverse()) {
    const weekKey = result?.weekKey || PERSISTENT_LEARNING_KEY;
    const isPrimary = weekKey === weekResults[0]?.weekKey;

    for (const [key, row] of sourceEntriesFromMicros(result?.micros || {})) {
      if (!key || !row) continue;

      const id = getMicroFamilyId(row, key);
      if (!id) continue;
      if (!validLearningId(id)) continue;

      const trueMicroFamilyId = getTrueMicroFamilyId(row, id);
      const coarseMicroFamilyId = getCoarseMicroFamilyId(row, trueMicroFamilyId);

      if (!validLearningId(trueMicroFamilyId)) continue;
      if (!validLearningId(coarseMicroFamilyId)) continue;

      if (inferTradeSide({
        ...row,
        microFamilyId: id,
        trueMicroFamilyId,
        coarseMicroFamilyId
      }) === OPPOSITE_TRADE_SIDE) {
        continue;
      }

      merged[trueMicroFamilyId] = {
        ...row,
        microFamilyId: id,
        trueMicroFamilyId,
        analyzeMicroFamilyId: trueMicroFamilyId,
        learningMicroFamilyId: trueMicroFamilyId,
        coarseMicroFamilyId,
        sourceWeekKey: weekKey,
        sourceWeekPrimary: Boolean(isPrimary),
        sourceWeekFallback: !isPrimary,
        ...modePayload()
      };
    }
  }

  return merged;
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
    weekKeys.map((weekKey, index) => getWeekMicrosCached(
      weekKey,
      index === 0
        ? WEEK_MICROS_TIMEOUT_MS
        : RECENT_WEEK_TIMEOUT_MS
    ))
  );

  const warnings = uniqueStrings(
    results
      .map((result) => result.warning)
      .filter(Boolean)
  );

  const selectedResults = results;
  const merged = mergeMicrosByRecency(selectedResults);

  const selectedCount = selectedResults.length;
  const primary = results[0] || null;
  const previous = results[1] || null;

  return {
    weekKey: requestedWeekKey,
    requestedWeekKey,
    sourceWeekKeyUsed: requestedWeekKey,

    source: 'persistentLearningKey',

    micros: merged,

    primaryWeekKey: requestedWeekKey,
    previousWeekKey: PERSISTENT_LEARNING_KEY,

    primaryRows: microsCount(primary?.micros || {}),
    previousRows: microsCount(previous?.micros || {}),

    mergedPreviousWeek: false,

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
        ? `PERSISTENT_LEARNING_ROWS_BELOW_TARGET:${microsCount(merged)}:${minRows}`
        : null
    ].filter(Boolean))
  };
}

function normalizeRows(rows = [], activeSet, activeMacroSet, compact) {
  return rows
    .filter(isAnalyzeMicroRow)
    .map((row, index) => normalizeMicroRow(row, index, {
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
    rows.filter(isAnalyzeMicroRow),
    mode
  )
    .slice(0, safeLimit)
    .map((row, index) => ({
      ...row,
      rank: index + 1
    }));
}

function selectResponseRows({
  rankedRows = [],
  limit = DEFAULT_LIMIT,
  filters = {}
} = {}) {
  if (filters.side === 'SHORT_DISABLED') return [];

  return rankedRows
    .filter(isAnalyzeMicroRow)
    .slice(0, limit);
}

function splitSideRows(rows = [], sideLimit = DEFAULT_SIDE_LIMIT) {
  const longRows = rows
    .filter(isAnalyzeMicroRow)
    .slice(0, sideLimit);

  return {
    longRows,
    shortRows: [],
    unknownRows: []
  };
}

function forcedLongFallbackRows(activeRotation, existingRows = []) {
  const existing = new Set(existingRows.map(rowKey).filter(Boolean));
  const rows = [];

  for (const id of extractActiveIds(activeRotation)) {
    if (existing.has(id)) continue;
    if (inferTradeSide(id) === OPPOSITE_TRADE_SIDE) continue;
    if (!validLearningId(id)) continue;

    const manual = manualRowFromId(id, rows.length);
    if (!manual) continue;

    rows.push(manual);
    existing.add(id);
  }

  return rows;
}

export default async function handler(req, res) {
  const startedAt = now();

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Micro-Families-Mode', 'long-only-persistent-learning-fixed-taxonomy-exact-true-micro-net-outcome-v13');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Long-Only', 'true');
  res.setHeader('X-Short-Disabled', 'true');
  res.setHeader('X-Real-Orders-Disabled', 'true');
  res.setHeader('X-Bitget-Orders-Disabled', 'true');
  res.setHeader('X-Exchange-Calls-Disabled', 'true');
  res.setHeader('X-Virtual-Learning-Forced', 'true');
  res.setHeader('X-Net-Outcomes-Only', 'true');
  res.setHeader('X-Virtual-Outcomes-Included', 'true');
  res.setHeader('X-Shadow-Outcomes-Included', 'true');
  res.setHeader('X-Manual-Selection-Only', 'true');
  res.setHeader('X-Manual-Selection-Match-Mode', 'EXACT_TRUE_MICRO_FAMILY_ID');
  res.setHeader('X-Scanner-Side', TARGET_DASHBOARD_SIDE);
  res.setHeader('X-Scanner-Fingerprint-Legacy-Fallback', String(SHOW_SCANNER_FINGERPRINT_LEGACY_FALLBACK));
  res.setHeader('X-Scanner-Fingerprints-Metadata-Only', 'true');
  res.setHeader('X-Execution-Fingerprints-Metadata-Only', 'true');
  res.setHeader('X-Analyze-Micro-Families-Only', 'true');
  res.setHeader('X-Learning-Identity-Source', 'ANALYZE_TRUE_MICRO_FAMILY');
  res.setHeader('X-True-Micro-Family-Schema', TRUE_MICRO_SCHEMA);
  res.setHeader('X-Persistent-Learning-Key', PERSISTENT_LEARNING_KEY);
  res.setHeader('X-Week-Reset-Disabled', 'true');
  res.setHeader('X-Default-Sort', 'BEST_DATA_FIRST');

  if (req.method !== 'GET') {
    return methodNotAllowed(res);
  }

  try {
    const currentWeekKey = PERSISTENT_LEARNING_KEY;
    const previousWeekKey = PERSISTENT_LEARNING_KEY;

    const requestedQueryWeekKey = String(
      firstQueryValue(req.query?.weekKey, PERSISTENT_LEARNING_KEY) || PERSISTENT_LEARNING_KEY
    ).trim();

    const requestedWeekKey = PERSISTENT_LEARNING_KEY;

    const requestedMode = String(firstQueryValue(req.query?.mode, 'balanced') || 'balanced');
    const mode = normalizeMode(requestedMode);

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

    const recentWeekLookback = 1;

    const minPrimaryRowsForMerge = toSafeLimit(
      firstQueryValue(
        req.query?.minPrimaryRowsForMerge,
        bestLimit
      ),
      bestLimit,
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
    const normalizedLongRows = normalizeRows(split.longRows, activeSet, activeMacroSet, compact);

    const summary = buildSummary(rankedRows, activeSet);

    const bestLong =
      best25RawRows[0] ||
      split.longRows[0] ||
      null;

    const rawScannerFingerprintRowsHidden = sourceEntriesFromMicros(weekResult.micros)
      .filter(([key, row]) => {
        const id = getMicroFamilyId(row, key);

        return (
          isScannerFingerprintId(id) ||
          isScannerFingerprintId(row?.trueMicroFamilyId) ||
          isScannerFingerprintId(row?.coarseMicroFamilyId)
        );
      })
      .length;

    const rawExecutionFingerprintRowsHidden = sourceEntriesFromMicros(weekResult.micros)
      .filter(([key, row]) => {
        const id = getMicroFamilyId(row, key);

        return (
          isExecutionFingerprintId(id) ||
          isExecutionFingerprintId(row?.trueMicroFamilyId) ||
          isExecutionFingerprintId(row?.coarseMicroFamilyId)
        );
      })
      .length;

    const warnings = uniqueStrings([
      requestedQueryWeekKey !== PERSISTENT_LEARNING_KEY
        ? `QUERY_WEEKKEY_IGNORED_USING_PERSISTENT:${requestedQueryWeekKey}`
        : null,
      ...(weekResult.warnings || []),
      weekRows.length === 0 && activeFallbackRows.length > 0
        ? 'USED_ACTIVE_ROTATION_FALLBACK_ROWS'
        : null,
      usedForcedLongFallback
        ? 'USED_FORCED_LONG_ACTIVE_ROTATION_FALLBACK'
        : null,
      rawScannerFingerprintRowsHidden > 0
        ? `SCANNER_FINGERPRINT_ROWS_HIDDEN_METADATA_ONLY:${rawScannerFingerprintRowsHidden}`
        : null,
      rawExecutionFingerprintRowsHidden > 0
        ? `EXECUTION_FINGERPRINT_ROWS_HIDDEN_METADATA_ONLY:${rawExecutionFingerprintRowsHidden}`
        : null,
      rankedRows.length === 0
        ? 'NO_ANALYZE_TRUE_MICRO_ROWS_AFTER_FILTERS'
        : null,
      best25MicroFamilies.length === 0
        ? 'NO_BEST25_ANALYZE_TRUE_MICRO_FAMILIES_AVAILABLE'
        : null
    ].filter(Boolean));

    return res.status(200).json({
      ok: true,
      fixed: true,

      ...modePayload(),

      availableTiers: ['HARD', 'SOFT', 'OBSERVATION', 'RAW'],
      availableStatuses: ['ACTIVE_LEARNING', 'EARLY_OUTCOMES', 'OBSERVING'],

      statusRules: {
        OBSERVING: 'completed == 0',
        EARLY_OUTCOMES: `completed > 0 && completed < ${MIN_COMPLETED_ACTIVE_LEARNING}`,
        ACTIVE_LEARNING: `completed >= ${MIN_COMPLETED_ACTIVE_LEARNING}`
      },

      rankingPolicy: {
        defaultMode: 'balanced',
        activeMode: mode,
        defaultSort: 'learningQualityRank/completed/fairWinrate/totalR/avgR/directSL/observations/dashboardBalancedScore',
        bestDataFirst: true,
        completedBeforeRawScore: true,
        rawWinrateIsNeverDefault: true,
        scoreKeys: ['dashboardBalancedScore', 'balancedScore', 'fairWinrate'],
        scannerFingerprintsExcludedFromRows: SHOW_SCANNER_FINGERPRINT_LEGACY_FALLBACK !== true,
        scannerFingerprintLegacyFallback: SHOW_SCANNER_FINGERPRINT_LEGACY_FALLBACK,
        scannerFingerprintsMetadataOnly: true,
        scannerFingerprintLegacyFallbackRows: 0,
        rawScannerFingerprintRowsHidden,
        rawExecutionFingerprintRowsHidden,
        executionFingerprintsMetadataOnly: true,
        analyzeMicroFamiliesOnly: true,
        trueMicroFamilyOnly: true,
        exactTrueMicroOnly: true,
        trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
        learningGranularity: LEARNING_GRANULARITY,
        symbolExcludedFromFamilyId: true,
        persistentLearningKey: PERSISTENT_LEARNING_KEY,
        weekResetDisabled: true,
        scoringRSource: 'netR',
        winsLossesFlatsSource: 'netR',
        winrateDefinition: 'netR > 0'
      },

      weekKey: PERSISTENT_LEARNING_KEY,
      requestedWeekKey: PERSISTENT_LEARNING_KEY,
      requestedQueryWeekKey,
      ignoredQueryWeekKey: requestedQueryWeekKey !== PERSISTENT_LEARNING_KEY
        ? requestedQueryWeekKey
        : null,
      sourceWeekKeyUsed: PERSISTENT_LEARNING_KEY,
      source: weekResult.source || 'persistentLearningKey',

      currentWeekKey,
      previousWeekKey,

      primaryWeekKey: PERSISTENT_LEARNING_KEY,
      primaryWeekRows: weekResult.primaryRows ?? null,
      previousWeekRows: 0,
      mergedPreviousWeek: false,
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
      bestMicroFamilies: best25MicroFamilies,

      filters,
      narrowFilters,
      compact,

      count: normalizedRows.length,
      filtered: rankedRows.length,
      totalAvailable: mergedRows.length,
      weekRows: weekRows.length,
      activeFallbackRows: activeFallbackRows.length,
      scannerFingerprintLegacyRows: 0,
      rawScannerFingerprintRowsHidden,
      rawExecutionFingerprintRowsHidden,

      rawSideCounts: sideCounts(mergedRows),
      filteredSideCounts: sideCounts(rankedRows),
      responseSideCounts: sideCounts(normalizedRows),
      best25SideCounts: sideCounts(best25MicroFamilies),

      tierCounts: tierCounts(rankedRows),
      statusCounts: statusCounts(rankedRows),

      activeRotationId: activeRotation?.rotationId || null,
      activeRotation: includeActiveRotation
        ? activeRotation
        : compactActiveRotation(activeRotation),

      activeMicroFamilyIds,
      activeMacroFamilyIds,

      bestLong: compactBestRow(bestLong),
      bestShort: null,

      longRows: normalizedLongRows,
      shortRows: [],
      unknownRows: [],

      summary,
      rows: normalizedRows,

      warnings,

      perf: {
        durationMs: now() - startedAt,
        weekMicrosCacheHit: Boolean(weekResult.cacheHit),
        weekMicrosCacheStale: Boolean(weekResult.stale),
        weekMicrosCacheSize: cache.weekMicros.size,
        path: 'longOnlyPersistentLearningNetOutcomeObservationFirstAnalyzeTrueMicroOnlyFixedTaxonomyScannerFingerprintMetadataOnlyBestDataFirst',
        best25Source: 'persistentLearningMergedRowsBeforeFilters'
      },

      serverTs: Date.now()
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,

      ...modePayload(),

      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}