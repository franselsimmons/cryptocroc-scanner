// ================= FILE: src/analyze/rotationEngine.js =================

import { CONFIG } from '../config.js';
import { KEYS } from '../keys.js';
import { getDurableRedis, getJson, setJson } from '../redis.js';
import {
  getIsoWeekKey,
  getNextIsoWeekKey,
  getPreviousIsoWeekKey,
  randomId,
  safeNumber,
  sideToTradeSide
} from '../utils.js';
import { getWeekMicros, saveWeekMicros } from './analyzeEngine.js';
import { rankMicros, refreshStats } from './scoring.js';
import { sendWeeklyRotationReport } from '../discord/discord.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;

const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';

const FIXED_TAXONOMY_SCHEMA = 'FIXED_TAXONOMY';
const FALLBACK_MACRO_SCHEMA = 'MF_V1';
const FALLBACK_MICRO_SCHEMA = 'MF_V2';
const FALLBACK_TRUE_MICRO_SCHEMA = 'MF_V3';

const EXECUTION_MICRO_SUFFIX = 'XR';

const ROTATION_SIDES = [TARGET_TRADE_SIDE];

const DEFAULT_TOP_N_PER_SIDE = 1;
const MAX_TOP_N_PER_SIDE = 160;
const DEFAULT_MIN_WEIGHTED_COMPLETED = 20;
const DEFAULT_MIN_PRIMARY_ROWS_FOR_PREVIOUS_MERGE = 25;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;

const FIXED_TAXONOMY_SETUP_TYPES = new Set([
  'BREAKOUT',
  'RETEST',
  'SWEEP_REVERSAL',
  'CONTINUATION',
  'COMPRESSION',
  'COMPRESSION_EXPANSION'
]);

const FIXED_TAXONOMY_REGIME_BUCKETS = new Set([
  'TREND',
  'CHOP',
  'SQUEEZE'
]);

const FIXED_TAXONOMY_CONFIRMATION_PROFILES = new Set([
  'A_STRONG_ALIGN',
  'B_FLOW_ALIGN',
  'C_VOLUME_ALIGN',
  'D_MIXED_OK',
  'E_WEAK_CONTRA'
]);

const MANUAL_ACTIVE_SOURCES = new Set([
  'ADMIN_MANUAL_SELECTION_LONG_TRUE_MICRO_ONLY',
  'ADMIN_ACTIVATE_SELECTED_LONG_TRUE_MICROS',
  'ADMIN_ACTIVATE_TOP_LONG_TRUE_MICROS',
  'ADMIN_ACTIVATE_TOP_BALANCED_LONG_TRUE_MICROS',
  'CLI_MANUAL_SELECTION_LONG_ONLY',
  'CLI_MANUAL_LONG_MICRO_FAMILY_DISCORD_SELECTION'
]);

function now() {
  return Date.now();
}

function namespacedLongKey(key, fallback) {
  const raw = String(key || fallback || '').trim();

  if (!raw) return `${LONG_KEY_PREFIX}MISSING_KEY`;
  if (raw.startsWith(LONG_KEY_PREFIX)) return raw;

  return `${LONG_KEY_PREFIX}${raw}`;
}

function activeRotationKey() {
  return namespacedLongKey(
    KEYS.long?.analyze?.activeRotation ||
      KEYS.analyze?.longActiveRotation ||
      KEYS.analyze?.activeRotation,
    'ANALYZE:ACTIVE_ROTATION'
  );
}

function nextRotationKey() {
  return namespacedLongKey(
    KEYS.long?.analyze?.nextRotation ||
      KEYS.analyze?.longNextRotation ||
      KEYS.analyze?.nextRotation,
    'ANALYZE:NEXT_ROTATION'
  );
}

function rotationValidFromKey() {
  return namespacedLongKey(
    KEYS.long?.analyze?.rotationValidFrom ||
      KEYS.analyze?.longRotationValidFrom ||
      KEYS.analyze?.rotationValidFrom,
    'ANALYZE:ROTATION_VALID_FROM'
  );
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

function normalizeSchema(value) {
  return String(value || '').trim().toUpperCase();
}

function schemaMeta() {
  const macroSchema = normalizeSchema(
    CONFIG.long?.analyze?.macroSchema ||
      CONFIG.analyze?.macroSchema ||
      CONFIG.analyze?.legacySchema ||
      FALLBACK_MACRO_SCHEMA
  );

  return {
    schema: FIXED_TAXONOMY_SCHEMA,
    macroSchema,
    microSchema: FIXED_TAXONOMY_SCHEMA,
    fallbackMicroSchema: normalizeSchema(
      CONFIG.long?.analyze?.microSchema ||
        CONFIG.analyze?.microSchema ||
        FALLBACK_MICRO_SCHEMA
    ),
    fallbackTrueMicroSchema: FALLBACK_TRUE_MICRO_SCHEMA,
    strategyVersion: CONFIG.strategyVersion
  };
}

function learningDataKey(weekKey = PERSISTENT_LEARNING_KEY) {
  return String(
    CONFIG.long?.analyze?.persistentLearningKey ||
      CONFIG.long?.rotation?.persistentLearningKey ||
      CONFIG.analyze?.longPersistentLearningKey ||
      weekKey ||
      PERSISTENT_LEARNING_KEY
  ).trim() || PERSISTENT_LEARNING_KEY;
}

function minWeightedCompleted() {
  return Math.max(
    0,
    safeNumber(
      CONFIG.long?.rotation?.minWeightedCompleted ??
        CONFIG.rotation?.minWeightedCompleted,
      DEFAULT_MIN_WEIGHTED_COMPLETED
    )
  );
}

function topNPerSide() {
  const preferred =
    CONFIG.long?.rotation?.topNLong ??
    CONFIG.rotation?.topNLong ??
    CONFIG.rotation?.topNPerSide ??
    DEFAULT_TOP_N_PER_SIDE;

  const n = Math.floor(Number(preferred));

  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TOP_N_PER_SIDE;

  return Math.max(1, Math.min(MAX_TOP_N_PER_SIDE, n));
}

function maxPerMacroFamily() {
  const enforce =
    CONFIG.long?.rotation?.enforceMaxPerMacroFamily ??
    CONFIG.rotation?.enforceMaxPerMacroFamily;

  if (enforce !== true) return 0;

  const n = Number(
    CONFIG.long?.rotation?.maxPerMacroFamily ??
      CONFIG.rotation?.maxPerMacroFamily ??
      0
  );

  return Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : 0;
}

function minPrimaryRowsForPreviousMerge() {
  const n = Number(
    CONFIG.long?.rotation?.minPrimaryRowsForPreviousMerge ??
      CONFIG.rotation?.minPrimaryRowsForPreviousMerge ??
      0
  );

  return Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : DEFAULT_MIN_PRIMARY_ROWS_FOR_PREVIOUS_MERGE;
}

function defaultRotationMode() {
  return CONFIG.long?.rotation?.mode || CONFIG.rotation?.mode || 'balanced';
}

function allowManualUnknownTrueMicroIds() {
  return CONFIG.long?.rotation?.allowManualUnknownTrueMicroIds !== false;
}

function allowSoftRotationFallback() {
  return CONFIG.long?.rotation?.allowSoftRotationFallback !== false;
}

function allowObservationRotationFallback() {
  return CONFIG.long?.rotation?.allowObservationRotationFallback !== false;
}

function allowRawRotationFallback() {
  return CONFIG.long?.rotation?.allowRawRotationFallback !== false;
}

function allowLegacyCompletedFallback() {
  return CONFIG.long?.analyze?.allowLegacyCompletedFallback === true ||
    CONFIG.analyze?.allowLegacyCompletedFallback === true;
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

    virtualOnly: true,
    virtualLearning: true,
    virtualTracked: true,
    shadowOnly: true,
    outcomeSource: 'VIRTUAL',

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    noRealOrders: true,
    realOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    noExchangeOrders: true,

    globalMaxOpenPositionsBlockDisabled: true,
    maxOneOpenPositionPerSymbol: true,
    oneOpenPositionPerSymbol: true,
    positionTimeStopMinDefault: DEFAULT_POSITION_TIME_STOP_MIN,

    observationFirst: true,
    observationAlwaysCounted: true,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    statusRules: {
      OBSERVING: 'completed == 0',
      EARLY_OUTCOMES: `completed > 0 && completed < ${DEFAULT_MIN_WEIGHTED_COMPLETED}`,
      ACTIVE_LEARNING: `completed >= ${DEFAULT_MIN_WEIGHTED_COMPLETED}`
    },

    defaultRanking: 'dashboardBalancedScore|balancedScore|fairWinrate',
    bareWinrateRankingDisabled: true,

    manualSelectionOnly: true,
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForManualSelection: true,
    discordOnlyForExactTrueMicroMatch: true,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    exactTrueMicroFamilyRequired: true,
    allowCoarseMicroAliasLiveEntries: false,
    allowCoarseMicroAliasForDiscord: false,

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

    autoRotation: false,
    autoRotationDisabled: true,
    activateNextDisabled: true,
    activateCronDisabled: true,
    freezeCronDisabled: true,
    resetCronDisabled: true,

    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    learningDataKey: PERSISTENT_LEARNING_KEY,

    rootSide: TARGET_TRADE_SIDE,
    rootIsolated: true,
    shortRootTouched: false
  };
}

function cleanSideText(value = '') {
  return String(value || '')
    .trim()
    .toUpperCase()
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

function normalizedSignalText(value = '') {
  return cleanSideText(value)
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function hasSignalPattern(value = '', patterns = []) {
  const text = normalizedSignalText(value);

  if (!text) return false;

  return patterns.some((pattern) => (
    text === pattern ||
    text.startsWith(`${pattern}_`) ||
    text.endsWith(`_${pattern}`) ||
    text.includes(`_${pattern}_`)
  ));
}

function hasLongSignal(value = '') {
  return hasSignalPattern(value, [
    'LONG',
    'BULL',
    'BULLISH',
    'BUY',
    'SIDE_LONG',
    'TRADE_SIDE_LONG',
    'TRADESIDE_LONG',
    'POSITION_SIDE_LONG',
    'POSITIONSIDE_LONG',
    'DIRECTION_LONG',
    'SIDE_BULL',
    'TRADE_SIDE_BULL',
    'DIRECTION_BULL',
    'SIDE_BUY',
    'DIRECTION_BUY',
    'MICRO_LONG',
    'FAMILY_LONG'
  ]);
}

function hasShortSignal(value = '') {
  return hasSignalPattern(value, [
    'SHORT',
    'BEAR',
    'BEARISH',
    'SELL',
    'SIDE_SHORT',
    'TRADE_SIDE_SHORT',
    'TRADESIDE_SHORT',
    'POSITION_SIDE_SHORT',
    'POSITIONSIDE_SHORT',
    'DIRECTION_SHORT',
    'SIDE_BEAR',
    'TRADE_SIDE_BEAR',
    'DIRECTION_BEAR',
    'SIDE_SELL',
    'DIRECTION_SELL',
    'MICRO_SHORT',
    'FAMILY_SHORT'
  ]);
}

function isScannerFingerprintId(id = '') {
  const value = String(id || '').toUpperCase();

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
  const value = String(id || '').toUpperCase();

  return (
    value.includes(`_${EXECUTION_MICRO_SUFFIX}_`) ||
    value.includes('__XR__') ||
    value.includes('|XR|') ||
    value.includes('EXECUTION_FINGERPRINT') ||
    value.includes('EXECUTION_MICRO') ||
    value.includes('EXECUTIONMICRO') ||
    value.includes('REFINED_EXECUTION')
  );
}

function parseFixedTaxonomyMicroId(id = '') {
  const value = String(id || '').trim().toUpperCase();

  if (!value) return null;
  if (isScannerFingerprintId(value)) return null;
  if (isExecutionFingerprintId(value)) return null;

  if (
    value.includes('_MF_V1_') ||
    value.includes('_MF_V2_') ||
    value.includes('_MF_V3_')
  ) {
    return null;
  }

  const prefix = 'MICRO_LONG_';

  if (!value.startsWith(prefix)) return null;

  let rest = value.slice(prefix.length);
  let confirmationProfile = null;

  const profiles = [...FIXED_TAXONOMY_CONFIRMATION_PROFILES]
    .sort((a, b) => b.length - a.length);

  for (const profile of profiles) {
    const suffix = `_${profile}`;

    if (rest.endsWith(suffix)) {
      confirmationProfile = profile;
      rest = rest.slice(0, -suffix.length);
      break;
    }
  }

  for (const regime of FIXED_TAXONOMY_REGIME_BUCKETS) {
    const suffix = `_${regime}`;

    if (!rest.endsWith(suffix)) continue;

    const setupType = rest.slice(0, -suffix.length);

    if (!FIXED_TAXONOMY_SETUP_TYPES.has(setupType)) continue;

    return {
      id: value,
      setupType,
      regimeBucket: regime,
      confirmationProfile
    };
  }

  return null;
}

function isFixedTaxonomyMicroId(id = '') {
  return Boolean(parseFixedTaxonomyMicroId(id));
}

function cleanLearningMicroId(id = '') {
  const raw = String(id || '').trim();

  if (!raw) return '';
  if (isScannerFingerprintId(raw)) return '';
  if (isExecutionFingerprintId(raw)) return '';

  return raw.toUpperCase();
}

function rowId(row = {}) {
  return cleanLearningMicroId(
    row.trueMicroFamilyId ||
      row.microFamilyId ||
      row.analyzeMicroFamilyId ||
      row.learningMicroFamilyId ||
      row.broadTrueMicroFamilyId ||
      row.id ||
      row.key ||
      ''
  );
}

function rowIdUpper(row = {}) {
  return rowId(row).toUpperCase();
}

function idLooksLikeMicroFamily(id = '') {
  return String(id || '').toUpperCase().startsWith('MICRO_');
}

function idLooksLikeLongFamily(id = '') {
  return hasLongSignal(id);
}

function idLooksLikeShortFamily(id = '') {
  return hasShortSignal(id);
}

function idLooksLikeSimpleMacroFamily(id = '') {
  const value = String(id || '').trim().toUpperCase();

  return (
    /^LONG_F\d+$/u.test(value) ||
    /^LONG_\d+$/u.test(value)
  );
}

function hasSchemaInId(id, schema) {
  const s = normalizeSchema(schema);
  const value = String(id || '').toUpperCase();

  if (!s) return false;

  return (
    value.includes(`_${s}_`) ||
    value.endsWith(`_${s}`) ||
    value.includes(`|SCHEMA=${s}`) ||
    value.includes(`SCHEMA=${s}`)
  );
}

function definitionText(row = {}) {
  return [
    row.definition,
    row.microDefinition,
    row.macroDefinition,
    row.parentDefinition,
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts : []),
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : []),
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : [])
  ]
    .map((value) => cleanSideText(value))
    .filter(Boolean)
    .join('|');
}

function definitionHasSchema(row = {}, schema) {
  const s = normalizeSchema(schema);

  if (!s) return false;

  const parts = [
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts : []),
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : [])
  ];

  if (parts.some((part) => String(part).toUpperCase() === `SCHEMA=${s}`)) {
    return true;
  }

  return definitionText(row).includes(`SCHEMA=${s}`);
}

function rowSchema(row = {}) {
  return normalizeSchema(
    row.microFamilySchema ||
      row.trueMicroFamilySchema ||
      row.schema ||
      row.versionSchema ||
      ''
  );
}

function hasParentMacro(row = {}) {
  return Boolean(
    row.parentMacroFamilyId ||
      row.parentMicroFamilyId ||
      row.macroFamilyId
  );
}

function parentMacroFamilyId(row = {}) {
  const direct = String(
    row.parentMacroFamilyId ||
      row.parentMicroFamilyId ||
      row.macroFamilyId ||
      ''
  ).trim();

  if (direct && !isScannerFingerprintId(direct) && !isExecutionFingerprintId(direct)) {
    return direct;
  }

  const familyId = String(row.familyId || '').trim();

  if (familyId && !isScannerFingerprintId(familyId) && !isExecutionFingerprintId(familyId)) {
    if (/^LONG(?:_F)?_?\d+$/i.test(familyId)) return familyId;
    if (/^LONG_F\d+$/i.test(familyId)) return familyId;
  }

  const id = rowId(row);

  if (idLooksLikeSimpleMacroFamily(id)) return id;

  return '';
}

function normalizeDirectSide(value) {
  const raw = cleanSideText(value);

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
    if (raw.includes('TRADE_SIDE=LONG') || raw.includes('TRADESIDE=LONG')) {
      return TARGET_TRADE_SIDE;
    }

    if (raw.includes('TRADE_SIDE=SHORT') || raw.includes('TRADESIDE=SHORT')) {
      return OPPOSITE_TRADE_SIDE;
    }

    if (raw.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
    if (raw.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function definitionSide(row = {}) {
  const text = definitionText(row);
  const longHit = hasLongSignal(text);
  const shortHit = hasShortSignal(text);

  if (longHit && !shortHit) return TARGET_TRADE_SIDE;
  if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;

  if (shortHit && longHit) {
    if (text.includes('TRADE_SIDE=LONG') || text.includes('TRADESIDE=LONG')) {
      return TARGET_TRADE_SIDE;
    }

    if (text.includes('TRADE_SIDE=SHORT') || text.includes('TRADESIDE=SHORT')) {
      return OPPOSITE_TRADE_SIDE;
    }

    if (text.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
    if (text.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function microSide(row = {}) {
  const direct = normalizeDirectSide(
    row.tradeSide ||
      row.positionSide ||
      row.direction ||
      row.signalSide ||
      row.scannerSide ||
      row.actualScannerSide ||
      row.analysisSide ||
      row.entrySide ||
      row.side
  );

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  const familyId = String(row.familyId || '').toUpperCase();
  const macroId = String(parentMacroFamilyId(row) || '').toUpperCase();
  const microId = rowIdUpper(row);

  if (familyId.startsWith('SHORT_')) return OPPOSITE_TRADE_SIDE;
  if (idLooksLikeShortFamily(macroId) && !idLooksLikeLongFamily(macroId)) return OPPOSITE_TRADE_SIDE;
  if (idLooksLikeShortFamily(microId) && !idLooksLikeLongFamily(microId)) return OPPOSITE_TRADE_SIDE;

  if (familyId.startsWith('LONG_')) return TARGET_TRADE_SIDE;
  if (macroId.startsWith('LONG_')) return TARGET_TRADE_SIDE;
  if (idLooksLikeLongFamily(macroId)) return TARGET_TRADE_SIDE;
  if (idLooksLikeLongFamily(microId)) return TARGET_TRADE_SIDE;

  const fromDefinition = definitionSide(row);

  if (fromDefinition === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (fromDefinition === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  if (row.longOnly === true || row.shortDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  if (row.shortOnly === true || row.longDisabled === true) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function normalizedSide(row = {}) {
  const side = microSide(row);

  if (side === TARGET_TRADE_SIDE) return TARGET_DASHBOARD_SIDE;

  return 'unknown';
}

function isLongRotationRow(row = {}) {
  return microSide(row) === TARGET_TRADE_SIDE;
}

export function isTrueMicroFamily(row = {}) {
  const {
    macroSchema,
    fallbackMicroSchema,
    fallbackTrueMicroSchema
  } = schemaMeta();

  const id = rowIdUpper(row);
  const schema = rowSchema(row);
  const version = String(row.version || '').toUpperCase();

  if (!row || !id) return false;
  if (isScannerFingerprintId(id)) return false;
  if (isExecutionFingerprintId(id)) return false;
  if (!isLongRotationRow(row)) return false;

  if (row.isLegacyMacro === true) return false;
  if (idLooksLikeSimpleMacroFamily(id)) return false;
  if (version.includes('MACRO')) return false;
  if (schema === macroSchema) return false;
  if (hasSchemaInId(id, macroSchema)) return false;
  if (definitionHasSchema(row, macroSchema)) return false;

  if (isFixedTaxonomyMicroId(id)) return true;

  if (schema === FIXED_TAXONOMY_SCHEMA) return isFixedTaxonomyMicroId(id);

  if (row.trueMicro === true || row.isTrueMicro === true) return true;
  if (version.includes('MICRO')) return true;

  if (schema === fallbackMicroSchema || schema === fallbackTrueMicroSchema) return true;
  if (hasSchemaInId(id, fallbackMicroSchema)) return true;
  if (hasSchemaInId(id, fallbackTrueMicroSchema)) return true;
  if (definitionHasSchema(row, fallbackMicroSchema)) return true;
  if (definitionHasSchema(row, fallbackTrueMicroSchema)) return true;

  if (hasParentMacro(row) && idLooksLikeMicroFamily(id) && id.startsWith('MICRO_LONG_')) {
    return true;
  }

  return false;
}

export function isLegacyMacroFamily(row = {}) {
  const { macroSchema } = schemaMeta();

  const id = rowIdUpper(row);
  const schema = rowSchema(row);
  const version = String(row.version || '').toUpperCase();

  if (!row || !id) return false;
  if (isScannerFingerprintId(id)) return false;
  if (isExecutionFingerprintId(id)) return false;
  if (!isLongRotationRow(row)) return false;
  if (isTrueMicroFamily(row)) return false;

  if (row.isLegacyMacro === true) return true;
  if (version.includes('MACRO')) return true;
  if (idLooksLikeSimpleMacroFamily(id)) return true;
  if (schema === macroSchema) return true;
  if (hasSchemaInId(id, macroSchema)) return true;
  if (definitionHasSchema(row, macroSchema)) return true;

  return !row.parentMacroFamilyId && !row.parentMicroFamilyId;
}

function isKnownTrueMicroId(id = '') {
  const {
    macroSchema,
    fallbackMicroSchema,
    fallbackTrueMicroSchema
  } = schemaMeta();

  const value = cleanLearningMicroId(id);

  if (!value) return false;
  if (isScannerFingerprintId(value)) return false;
  if (isExecutionFingerprintId(value)) return false;
  if (!idLooksLikeLongFamily(value)) return false;
  if (idLooksLikeShortFamily(value) && !idLooksLikeLongFamily(value)) return false;
  if (!idLooksLikeMicroFamily(value)) return false;
  if (hasSchemaInId(value, macroSchema)) return false;
  if (value.includes('_MF_V1_')) return false;

  if (isFixedTaxonomyMicroId(value)) return true;

  return (
    hasSchemaInId(value, fallbackMicroSchema) ||
    hasSchemaInId(value, fallbackTrueMicroSchema)
  );
}

function recentClosedVirtualOutcomeCount(row = {}) {
  const recent = Array.isArray(row.recentOutcomes)
    ? row.recentOutcomes
    : [];

  return recent.filter((outcome) => {
    const source = String(outcome?.source || outcome?.outcomeSource || '').toUpperCase();
    const hasR = Number.isFinite(Number(
      outcome?.netR ??
        outcome?.exitR ??
        outcome?.realizedNetR ??
        outcome?.realizedR ??
        outcome?.r
    ));

    return hasR && ['VIRTUAL', 'SHADOW'].includes(source);
  }).length;
}

function completedCount(row = {}) {
  const virtualCompleted = safeNumber(row.virtualCompleted, 0);
  const shadowCompleted = safeNumber(row.shadowCompleted, 0);
  const closed = virtualCompleted + shadowCompleted;

  if (closed > 0) return closed;

  const recentClosed = recentClosedVirtualOutcomeCount(row);

  if (recentClosed > 0) return recentClosed;

  if (allowLegacyCompletedFallback()) {
    return Math.max(0, safeNumber(row.completed, 0));
  }

  return 0;
}

function observationSample(row = {}) {
  return Math.max(
    safeNumber(row.observationSample, 0),
    safeNumber(row.seen, 0),
    safeNumber(row.observations, 0),
    completedCount(row),
    0
  );
}

function learningStatus(row = {}) {
  const completed = completedCount(row);

  if (completed >= DEFAULT_MIN_WEIGHTED_COMPLETED) return 'ACTIVE_LEARNING';
  if (completed > 0) return 'EARLY_OUTCOMES';

  return 'OBSERVING';
}

function isEligible(row = {}) {
  if (!isLongRotationRow(row)) return false;
  if (!isTrueMicroFamily(row)) return false;

  return completedCount(row) >= minWeightedCompleted();
}

function isSoftEligible(row = {}) {
  if (!allowSoftRotationFallback()) return false;
  if (!isLongRotationRow(row)) return false;
  if (!isTrueMicroFamily(row)) return false;

  const completed = completedCount(row);
  const balancedScore = safeNumber(
    row.dashboardBalancedScore ?? row.balancedScore,
    0
  );

  if (completed <= 0) return false;
  if (balancedScore <= 0) return false;

  return (
    safeNumber(row.avgR, 0) > 0 ||
    safeNumber(row.totalR, 0) > 0 ||
    safeNumber(row.fairWinrate, 0) > 0 ||
    safeNumber(row.sampleAdjustedWinrate, 0) > 0 ||
    safeNumber(row.wilsonLowerBound, 0) > 0 ||
    safeNumber(row.sampleWilsonLowerBound, 0) > 0
  );
}

function isObservationEligible(row = {}) {
  if (!allowObservationRotationFallback()) return false;
  if (!isLongRotationRow(row)) return false;
  if (!isTrueMicroFamily(row)) return false;

  return observationSample(row) > 0;
}

function isRawFallbackEligible(row = {}) {
  if (!allowRawRotationFallback()) return false;
  if (!isLongRotationRow(row)) return false;
  if (!isTrueMicroFamily(row)) return false;

  return true;
}

function rotationEligibilityTier(row = {}) {
  if (isEligible(row)) return 'HARD';
  if (isSoftEligible(row)) return 'SOFT';
  if (isObservationEligible(row)) return 'OBSERVATION';
  if (isRawFallbackEligible(row)) return 'RAW';

  return 'NONE';
}

function isManualEligible(row = {}) {
  return isLongRotationRow(row) && isTrueMicroFamily(row);
}

function isManualActiveRotation(rotation = {}) {
  if (!rotation || typeof rotation !== 'object') return false;

  const source = String(rotation.source || '').trim().toUpperCase();
  const mode = String(rotation.mode || '').trim().toUpperCase();

  if (rotation.manualOnly === true) return true;
  if (rotation.adminSelected === true) return true;
  if (mode === 'MANUAL' || mode === 'SELECTED') return true;
  if (source.includes('MANUAL')) return true;
  if (source.includes('SELECTED')) return true;
  if (source.startsWith('ADMIN_')) return true;
  if (source.startsWith('CLI_MANUAL')) return true;
  if (MANUAL_ACTIVE_SOURCES.has(source)) return true;

  return false;
}

function taxonomyMetaForId(id = '') {
  const parsed = parseFixedTaxonomyMicroId(id);

  if (!parsed) {
    return {
      setupType: null,
      regimeBucket: null,
      confirmationProfile: null,
      fixedTaxonomyLearningId: false
    };
  }

  return {
    setupType: parsed.setupType,
    regimeBucket: parsed.regimeBucket,
    confirmationProfile: parsed.confirmationProfile,
    fixedTaxonomyLearningId: true
  };
}

function compactRotationRow(row = {}, rank = 0) {
  const refreshed = refreshStats(row);
  const side = normalizedSide(refreshed);
  const tradeSide = microSide(refreshed);
  const macroId = parentMacroFamilyId(refreshed);
  const eligibilityTier = rotationEligibilityTier(refreshed);
  const meta = schemaMeta();
  const completed = completedCount(refreshed);
  const status = learningStatus(refreshed);

  const microFamilyId = rowId(refreshed);
  const taxonomy = taxonomyMetaForId(microFamilyId);

  return {
    rank,

    microFamilyId,
    trueMicroFamilyId: microFamilyId,
    analyzeMicroFamilyId: microFamilyId,
    learningMicroFamilyId: microFamilyId,

    familyId: refreshed.familyId || null,

    coarseMicroFamilyId:
      cleanLearningMicroId(refreshed.coarseMicroFamilyId) ||
      cleanLearningMicroId(refreshed.baseMicroFamilyId) ||
      cleanLearningMicroId(refreshed.legacyMicroFamilyId) ||
      microFamilyId,

    baseMicroFamilyId:
      cleanLearningMicroId(refreshed.baseMicroFamilyId) ||
      cleanLearningMicroId(refreshed.coarseMicroFamilyId) ||
      microFamilyId,

    legacyMicroFamilyId:
      cleanLearningMicroId(refreshed.legacyMicroFamilyId) ||
      cleanLearningMicroId(refreshed.coarseMicroFamilyId) ||
      microFamilyId,

    macroFamilyId: macroId || refreshed.macroFamilyId || null,
    parentMacroFamilyId: macroId || null,
    parentMicroFamilyId: refreshed.parentMicroFamilyId || macroId || null,

    side,
    tradeSide,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    schema: taxonomy.fixedTaxonomyLearningId
      ? FIXED_TAXONOMY_SCHEMA
      : refreshed.schema || refreshed.microFamilySchema || meta.fallbackTrueMicroSchema,

    microFamilySchema: taxonomy.fixedTaxonomyLearningId
      ? FIXED_TAXONOMY_SCHEMA
      : refreshed.microFamilySchema || refreshed.schema || meta.fallbackTrueMicroSchema,

    trueMicroFamilySchema: taxonomy.fixedTaxonomyLearningId
      ? FIXED_TAXONOMY_SCHEMA
      : refreshed.trueMicroFamilySchema || meta.fallbackTrueMicroSchema,

    version: refreshed.version || 'micro',

    isTrueMicro: isTrueMicroFamily(refreshed),
    isLegacyMacro: isLegacyMacroFamily(refreshed),

    setupType: refreshed.setupType || taxonomy.setupType,
    regimeBucket: refreshed.regimeBucket || taxonomy.regimeBucket,
    confirmationProfile: refreshed.confirmationProfile || taxonomy.confirmationProfile,
    fixedTaxonomyLearningId: taxonomy.fixedTaxonomyLearningId || Boolean(refreshed.fixedTaxonomyLearningId),

    rotationEligibilityTier: eligibilityTier,
    rotationEligible: eligibilityTier !== 'NONE',
    hardEligible: eligibilityTier === 'HARD',
    softEligible: eligibilityTier === 'SOFT',
    observationEligible: eligibilityTier === 'OBSERVATION',
    rawEligible: eligibilityTier === 'RAW',

    learningStatus: status,
    status,
    tooEarly: completed < DEFAULT_MIN_WEIGHTED_COMPLETED,
    tooEarlyReason: completed < DEFAULT_MIN_WEIGHTED_COMPLETED
      ? `completed ${completed}/${DEFAULT_MIN_WEIGHTED_COMPLETED}`
      : null,

    seen: safeNumber(refreshed.seen, 0),
    observations: safeNumber(refreshed.observations ?? refreshed.seen, 0),
    observationSample: observationSample(refreshed),

    completed,
    outcomeSample: completed,

    realCompleted: 0,
    virtualCompleted: safeNumber(refreshed.virtualCompleted, 0),
    shadowCompleted: safeNumber(refreshed.shadowCompleted, 0),

    winrateSample: safeNumber(refreshed.winrateSample ?? completed, 0),
    winrate: safeNumber(refreshed.winrate, 0),
    bayesianWinrate: safeNumber(refreshed.bayesianWinrate, 0),
    wilsonLowerBound: safeNumber(refreshed.wilsonLowerBound, 0),
    sampleWilsonLowerBound: safeNumber(
      refreshed.sampleWilsonLowerBound ?? refreshed.wilsonLowerBound,
      0
    ),
    fairWinrate: safeNumber(refreshed.fairWinrate, 0),
    sampleAdjustedWinrate: safeNumber(refreshed.sampleAdjustedWinrate, 0),
    sampleReliability: safeNumber(refreshed.sampleReliability, 0),

    avgR: safeNumber(refreshed.avgR ?? refreshed.avgNetR ?? refreshed.netAvgR, 0),
    totalR: safeNumber(refreshed.totalR ?? refreshed.netTotalR ?? refreshed.totalNetR, 0),
    avgWinR: safeNumber(refreshed.avgWinR, 0),
    avgLossR: safeNumber(refreshed.avgLossR, 0),

    profitFactor: safeNumber(refreshed.profitFactor, 0),
    directSLPct: safeNumber(refreshed.directSLPct, 0),
    nearTpPct: safeNumber(refreshed.nearTpPct, 0),
    reachedHalfRPct: safeNumber(refreshed.reachedHalfRPct, 0),
    reachedOneRPct: safeNumber(refreshed.reachedOneRPct, 0),

    beWouldExitPct: safeNumber(refreshed.beWouldExitPct, 0),
    gaveBackAfterHalfRPct: safeNumber(refreshed.gaveBackAfterHalfRPct, 0),
    gaveBackAfterOneRPct: safeNumber(refreshed.gaveBackAfterOneRPct, 0),
    nearTpThenLossPct: safeNumber(refreshed.nearTpThenLossPct, 0),

    totalCostR: safeNumber(refreshed.totalCostR, 0),
    avgCostR: safeNumber(refreshed.avgCostR, 0),

    balancedScore: safeNumber(refreshed.balancedScore, 0),
    dashboardBalancedScore: safeNumber(
      refreshed.dashboardBalancedScore ?? refreshed.balancedScore,
      0
    ),

    assetClass: refreshed.assetClass || null,

    rsiZone: refreshed.rsiZone || null,
    rsiCoarse: refreshed.rsiCoarse || null,

    flow: refreshed.flow || null,
    flowCoarse: refreshed.flowCoarse || null,

    obRelation: refreshed.obRelation || null,

    btcState: refreshed.btcState || null,
    btcRelation: refreshed.btcRelation || null,

    regime: refreshed.regime || null,
    regimeCoarse: refreshed.regimeCoarse || null,

    scannerReason: refreshed.scannerReason || null,
    scannerReasonCoarse: refreshed.scannerReasonCoarse || null,

    scannerMicroFamilyId: refreshed.scannerMicroFamilyId || null,
    scannerFamilyId: refreshed.scannerFamilyId || null,
    scannerDefinition: refreshed.scannerDefinition || null,
    scannerDefinitionParts: Array.isArray(refreshed.scannerDefinitionParts)
      ? refreshed.scannerDefinitionParts
      : [],

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    executionMicroFamilyId: refreshed.executionMicroFamilyId || null,
    executionFingerprintRole: 'METADATA_ONLY',
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,

    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    exactTrueMicroFamilyRequired: true,
    symbolExcludedFromFamilyId: true,

    definitionParts: Array.isArray(refreshed.definitionParts)
      ? refreshed.definitionParts
      : [],

    definition: refreshed.definition || '',

    parentDefinitionParts: Array.isArray(refreshed.parentDefinitionParts)
      ? refreshed.parentDefinitionParts
      : [],

    parentDefinition: refreshed.parentDefinition || '',

    counters: refreshed.counters || {},

    examples: Array.isArray(refreshed.examples)
      ? refreshed.examples.slice(0, 20)
      : [],

    recentOutcomes: Array.isArray(refreshed.recentOutcomes)
      ? refreshed.recentOutcomes.slice(0, 20)
      : [],

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    allowCoarseMicroAliasLiveEntries: false,
    allowCoarseMicroAliasForDiscord: false
  };
}

function canUseMacroSlot({
  row,
  countsByMacro
}) {
  const macroCap = maxPerMacroFamily();

  if (macroCap <= 0) return true;

  const macroId = parentMacroFamilyId(row);

  if (!macroId) return true;

  return safeNumber(countsByMacro[macroId], 0) < macroCap;
}

function reserveMacroSlot({
  row,
  countsByMacro
}) {
  const macroId = parentMacroFamilyId(row);

  if (!macroId) return;

  countsByMacro[macroId] = safeNumber(countsByMacro[macroId], 0) + 1;
}

function addSelectedRow({
  row,
  selected,
  selectedIds,
  countsBySide,
  countsByMacro
}) {
  const id = rowId(row);
  const side = microSide(row);

  if (!id) return false;
  if (isScannerFingerprintId(id)) return false;
  if (isExecutionFingerprintId(id)) return false;
  if (!isKnownTrueMicroId(id)) return false;
  if (selectedIds.has(id)) return false;
  if (side !== TARGET_TRADE_SIDE) return false;
  if (!isTrueMicroFamily(row)) return false;
  if (!canUseMacroSlot({ row, countsByMacro })) return false;

  selectedIds.add(id);
  countsBySide[TARGET_TRADE_SIDE] = safeNumber(countsBySide[TARGET_TRADE_SIDE], 0) + 1;
  reserveMacroSlot({ row, countsByMacro });

  selected.push({
    ...row,
    microFamilyId: id,
    trueMicroFamilyId: id,
    analyzeMicroFamilyId: id,
    learningMicroFamilyId: id
  });

  return true;
}

function buildSelectionState(existing = []) {
  const selected = [];
  const selectedIds = new Set();
  const countsBySide = {
    [TARGET_TRADE_SIDE]: 0
  };
  const countsByMacro = {};

  for (const row of existing) {
    addSelectedRow({
      row,
      selected,
      selectedIds,
      countsBySide,
      countsByMacro
    });
  }

  return {
    selected,
    selectedIds,
    countsBySide,
    countsByMacro
  };
}

function appendRowsToSelection({
  state,
  rows = [],
  targetCount = topNPerSide()
}) {
  for (const row of rows) {
    if (state.countsBySide[TARGET_TRADE_SIDE] >= targetCount) break;

    addSelectedRow({
      row,
      selected: state.selected,
      selectedIds: state.selectedIds,
      countsBySide: state.countsBySide,
      countsByMacro: state.countsByMacro
    });
  }

  return state.selected;
}

function hasSelectedSide(rows = [], side) {
  return rows.some((row) => microSide(row) === side);
}

function missingSides(rows = []) {
  return ROTATION_SIDES.filter((side) => !hasSelectedSide(rows, side));
}

function selectRotationCandidates(rankedCandidates = []) {
  const trueLongCandidates = rankedCandidates
    .filter(isLongRotationRow)
    .filter(isTrueMicroFamily);

  const hardEligible = trueLongCandidates.filter(isEligible);

  const softEligible = trueLongCandidates
    .filter((row) => !isEligible(row))
    .filter(isSoftEligible);

  const observationEligible = trueLongCandidates
    .filter((row) => !isEligible(row))
    .filter((row) => !isSoftEligible(row))
    .filter(isObservationEligible);

  const rawFallback = trueLongCandidates
    .filter((row) => !isEligible(row))
    .filter((row) => !isSoftEligible(row))
    .filter((row) => !isObservationEligible(row))
    .filter(isRawFallbackEligible);

  const targetCount = topNPerSide();
  const state = buildSelectionState();

  appendRowsToSelection({
    state,
    rows: hardEligible,
    targetCount
  });

  if (allowSoftRotationFallback()) {
    appendRowsToSelection({
      state,
      rows: softEligible,
      targetCount
    });
  }

  if (allowObservationRotationFallback()) {
    appendRowsToSelection({
      state,
      rows: observationEligible,
      targetCount
    });
  }

  if (allowRawRotationFallback()) {
    appendRowsToSelection({
      state,
      rows: rawFallback,
      targetCount
    });
  }

  return {
    selected: state.selected,
    eligible: hardEligible,
    softEligible,
    observationEligible,
    rawFallback,

    usedSoftFallback: state.selected.some((row) => rotationEligibilityTier(row) === 'SOFT'),
    usedObservationFallback: state.selected.some((row) => rotationEligibilityTier(row) === 'OBSERVATION'),
    usedRawFallback: state.selected.some((row) => rotationEligibilityTier(row) === 'RAW'),

    missingSides: missingSides(state.selected)
  };
}

function filterRankedRows(rows = [], filter = 'trueMicro') {
  const longRows = rows.filter(isLongRotationRow);

  if (filter === 'all') return longRows;
  if (filter === 'legacyMacro') return longRows.filter(isLegacyMacroFamily);

  return longRows.filter(isTrueMicroFamily);
}

function buildRankings(micros, { filter = 'trueMicro' } = {}) {
  const modes = [
    'balanced',
    'winrate',
    'totalR',
    'avgR',
    'directSL',
    'observed'
  ];

  return Object.fromEntries(
    modes.map((mode) => {
      const rows = filterRankedRows(rankMicros(micros, mode), filter)
        .slice(0, MAX_TOP_N_PER_SIDE)
        .map((row, index) => compactRotationRow(row, index + 1));

      return [mode, rows];
    })
  );
}

function buildSelectionIndexes(microFamilies = []) {
  const longRows = microFamilies
    .filter(isLongRotationRow)
    .filter(isTrueMicroFamily);

  const microFamilyIds = uniqueStrings(
    longRows.map((row) => row.trueMicroFamilyId || row.microFamilyId)
  )
    .map(cleanLearningMicroId)
    .filter(Boolean)
    .filter(isKnownTrueMicroId);

  const macroFamilyIds = uniqueStrings(
    longRows.map((row) => (
      row.parentMacroFamilyId ||
      row.parentMicroFamilyId ||
      row.macroFamilyId
    ))
  )
    .map(cleanLearningMicroId)
    .filter(Boolean)
    .filter(idLooksLikeLongFamily)
    .filter((id) => !isScannerFingerprintId(id))
    .filter((id) => !isExecutionFingerprintId(id));

  const microToMacroFamilyId = {};
  const macroToMicroFamilyIds = {};

  for (const row of longRows) {
    const microId = cleanLearningMicroId(row.trueMicroFamilyId || row.microFamilyId || '');
    const macroId = cleanLearningMicroId(
      row.parentMacroFamilyId ||
        row.parentMicroFamilyId ||
        row.macroFamilyId ||
        ''
    );

    if (!microId || !macroId) continue;
    if (!isKnownTrueMicroId(microId)) continue;

    microToMacroFamilyId[microId] = macroId;

    if (!macroToMicroFamilyIds[macroId]) {
      macroToMicroFamilyIds[macroId] = [];
    }

    macroToMicroFamilyIds[macroId].push(microId);
  }

  for (const macroId of Object.keys(macroToMicroFamilyIds)) {
    macroToMicroFamilyIds[macroId] = uniqueStrings(
      macroToMicroFamilyIds[macroId]
    ).filter(isKnownTrueMicroId);
  }

  return {
    microFamilyIds,
    activeMicroFamilyIds: microFamilyIds,
    trueMicroFamilyIds: microFamilyIds,

    macroFamilyIds,
    activeMacroFamilyIds: macroFamilyIds,

    microToMacroFamilyId,
    macroToMicroFamilyIds
  };
}

function countByPredicate(micros = {}, predicate) {
  return Object.values(micros || {}).filter(predicate).length;
}

function bestLongRow(rows = []) {
  return rows.find((row) => microSide(row) === TARGET_TRADE_SIDE) || null;
}

function mergeMicros(primary = {}, fallback = {}) {
  return {
    ...(fallback || {}),
    ...(primary || {})
  };
}

async function getRotationMicros(weekKey = PERSISTENT_LEARNING_KEY) {
  const dataWeekKey = learningDataKey(weekKey);
  const primary = await getWeekMicros(dataWeekKey);
  const primaryRows = Object.keys(primary || {}).length;

  const previousWeekKey = getPreviousIsoWeekKey();
  const shouldMergePrevious =
    dataWeekKey !== PERSISTENT_LEARNING_KEY &&
    dataWeekKey !== previousWeekKey &&
    primaryRows < minPrimaryRowsForPreviousMerge();

  if (!shouldMergePrevious) {
    return {
      micros: primary || {},
      primaryWeekKey: dataWeekKey,
      dataWeekKey,
      learningDataKey: dataWeekKey,
      previousWeekKey,
      primaryRows,
      previousRows: 0,
      usedPreviousWeekMerge: false,
      usedPersistentLearningKey: dataWeekKey === PERSISTENT_LEARNING_KEY
    };
  }

  const previous = await getWeekMicros(previousWeekKey).catch(() => ({}));
  const previousRows = Object.keys(previous || {}).length;

  if (previousRows <= 0) {
    return {
      micros: primary || {},
      primaryWeekKey: dataWeekKey,
      dataWeekKey,
      learningDataKey: dataWeekKey,
      previousWeekKey,
      primaryRows,
      previousRows: 0,
      usedPreviousWeekMerge: false,
      usedPersistentLearningKey: dataWeekKey === PERSISTENT_LEARNING_KEY
    };
  }

  return {
    micros: mergeMicros(primary, previous),
    primaryWeekKey: dataWeekKey,
    dataWeekKey,
    learningDataKey: dataWeekKey,
    previousWeekKey,
    primaryRows,
    previousRows,
    usedPreviousWeekMerge: true,
    usedPersistentLearningKey: dataWeekKey === PERSISTENT_LEARNING_KEY
  };
}

function buildEmptyRotation({
  weekKey,
  activeWeekKey,
  mode,
  micros,
  ranked,
  eligible,
  softEligible = [],
  observationEligible = [],
  rawFallback = [],
  usedPreviousWeekMerge = false,
  usedPersistentLearningKey = false,
  primaryRows = 0,
  previousRows = 0,
  emptyReason = 'NO_LONG_TRUE_MICRO_FAMILIES_AVAILABLE_FOR_ROTATION'
}) {
  const indexes = buildSelectionIndexes([]);
  const meta = schemaMeta();

  return {
    rotationId: randomId(`ROT_${weekKey}_${mode}_long_candidate_snapshot`),
    source: 'ANALYZE_WEEKLY_CANDIDATE_SNAPSHOT_LONG_TRUE_MICRO_ONLY',
    mode,

    sourceWeekKey: weekKey,
    activeWeekKey,
    dataWeekKey: weekKey,
    learningDataKey: weekKey,

    generatedAt: now(),
    strategyVersion: CONFIG.strategyVersion,

    schema: meta.schema,
    macroSchema: meta.macroSchema,
    microSchema: meta.microSchema,

    ...modeFlags(),

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    usedLegacyFallback: false,
    usedSoftFallback: false,
    usedObservationFallback: false,
    usedRawFallback: false,
    usedPreviousWeekMerge,
    usedPersistentLearningKey,

    manualOnly: false,
    adminSelected: false,
    autoRotation: false,
    nextRotationOnly: true,
    activeRotationPreserved: true,
    activationDisabled: true,
    manualSelectionRequired: true,
    liveSelectable: false,

    minWeightedCompleted: minWeightedCompleted(),
    topNPerSide: topNPerSide(),
    maxPerMacroFamily: maxPerMacroFamily(),

    eligibleCount: eligible?.length || 0,
    softEligibleCount: softEligible?.length || 0,
    observationEligibleCount: observationEligible?.length || 0,
    rawFallbackCount: rawFallback?.length || 0,
    rankedCount: ranked.length,
    microCount: Object.keys(micros || {}).length,
    trueMicroCount: countByPredicate(micros, (row) => isTrueMicroFamily(row) && isLongRotationRow(row)),
    legacyMacroCount: countByPredicate(micros, (row) => isLegacyMacroFamily(row) && isLongRotationRow(row)),

    primaryRows,
    previousRows,

    missingSides: [TARGET_TRADE_SIDE],

    empty: true,
    emptyReason,

    bestLong: null,
    bestShort: null,

    microFamilyIds: indexes.microFamilyIds,
    activeMicroFamilyIds: indexes.activeMicroFamilyIds,
    trueMicroFamilyIds: indexes.trueMicroFamilyIds,

    macroFamilyIds: indexes.macroFamilyIds,
    activeMacroFamilyIds: indexes.activeMacroFamilyIds,

    microToMacroFamilyId: indexes.microToMacroFamilyId,
    macroToMicroFamilyIds: indexes.macroToMicroFamilyIds,

    microFamilies: [],

    rankings: buildRankings(micros, { filter: 'trueMicro' }),
    macroRankings: buildRankings(micros, { filter: 'legacyMacro' }),
    allRankings: buildRankings(micros, { filter: 'all' })
  };
}

export async function buildRotationFromWeek({
  weekKey = PERSISTENT_LEARNING_KEY,
  activeWeekKey = getNextIsoWeekKey(),
  mode = defaultRotationMode()
} = {}) {
  const {
    micros,
    dataWeekKey,
    learningDataKey: resolvedLearningDataKey,
    primaryRows,
    previousRows,
    usedPreviousWeekMerge,
    usedPersistentLearningKey
  } = await getRotationMicros(weekKey);

  const rankedAll = rankMicros(micros, mode)
    .filter(isLongRotationRow);

  const rankedTrueMicros = rankedAll
    .filter(isTrueMicroFamily);

  const rankedCandidates = rankedTrueMicros;

  const {
    selected,
    eligible,
    softEligible,
    observationEligible,
    rawFallback,
    usedSoftFallback,
    usedObservationFallback,
    usedRawFallback,
    missingSides: selectedMissingSides
  } = selectRotationCandidates(rankedCandidates);

  if (selected.length === 0) {
    return buildEmptyRotation({
      weekKey: dataWeekKey,
      activeWeekKey,
      mode,
      micros,
      ranked: rankedCandidates,
      eligible,
      softEligible,
      observationEligible,
      rawFallback,
      usedPreviousWeekMerge,
      usedPersistentLearningKey,
      primaryRows,
      previousRows,
      emptyReason: rankedTrueMicros.length === 0
        ? 'NO_LONG_TRUE_MICRO_FAMILIES_FOUND'
        : 'NO_LONG_TRUE_MICRO_FAMILIES_AVAILABLE_FOR_CANDIDATE_SNAPSHOT'
    });
  }

  const microFamilies = selected
    .filter(isLongRotationRow)
    .filter(isTrueMicroFamily)
    .map((row, index) => compactRotationRow(row, index + 1))
    .filter((row) => row.microFamilyId)
    .filter((row) => isKnownTrueMicroId(row.microFamilyId));

  const indexes = buildSelectionIndexes(microFamilies);
  const meta = schemaMeta();

  return {
    rotationId: randomId(`ROT_${dataWeekKey}_${mode}_long_candidate_snapshot`),
    source: 'ANALYZE_WEEKLY_CANDIDATE_SNAPSHOT_LONG_TRUE_MICRO_ONLY',
    mode,

    sourceWeekKey: dataWeekKey,
    activeWeekKey,
    dataWeekKey,
    learningDataKey: resolvedLearningDataKey,

    generatedAt: now(),
    strategyVersion: CONFIG.strategyVersion,

    schema: meta.schema,
    macroSchema: meta.macroSchema,
    microSchema: meta.microSchema,

    ...modeFlags(),

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    usedLegacyFallback: false,
    usedSoftFallback,
    usedObservationFallback,
    usedRawFallback,
    usedPreviousWeekMerge,
    usedPersistentLearningKey,

    manualOnly: false,
    adminSelected: false,
    autoRotation: false,
    nextRotationOnly: true,
    activeRotationPreserved: true,
    activationDisabled: true,
    manualSelectionRequired: true,
    liveSelectable: false,

    minWeightedCompleted: minWeightedCompleted(),
    topNPerSide: topNPerSide(),
    maxPerMacroFamily: maxPerMacroFamily(),

    eligibleCount: eligible.length,
    softEligibleCount: softEligible.length,
    observationEligibleCount: observationEligible.length,
    rawFallbackCount: rawFallback.length,
    rankedCount: rankedCandidates.length,
    allRankedCount: rankedAll.length,
    microCount: Object.keys(micros || {}).length,
    trueMicroCount: countByPredicate(micros, (row) => isTrueMicroFamily(row) && isLongRotationRow(row)),
    legacyMacroCount: countByPredicate(micros, (row) => isLegacyMacroFamily(row) && isLongRotationRow(row)),

    primaryRows,
    previousRows,

    missingSides: selectedMissingSides,

    empty: false,
    emptyReason: null,

    bestLong: bestLongRow(microFamilies),
    bestShort: null,

    candidateMicroFamilyIds: indexes.microFamilyIds,
    candidateMacroFamilyIds: indexes.macroFamilyIds,

    microFamilyIds: indexes.microFamilyIds,
    activeMicroFamilyIds: indexes.activeMicroFamilyIds,
    trueMicroFamilyIds: indexes.trueMicroFamilyIds,

    macroFamilyIds: indexes.macroFamilyIds,
    activeMacroFamilyIds: indexes.activeMacroFamilyIds,

    microToMacroFamilyId: indexes.microToMacroFamilyId,
    macroToMicroFamilyIds: indexes.macroToMicroFamilyIds,

    microFamilies,

    rankings: buildRankings(micros, { filter: 'trueMicro' }),
    macroRankings: buildRankings(micros, { filter: 'legacyMacro' }),
    allRankings: buildRankings(micros, { filter: 'all' })
  };
}

export async function freezeWeeklyRotation({
  weekKey = PERSISTENT_LEARNING_KEY,
  activeWeekKey = getNextIsoWeekKey(),
  mode = defaultRotationMode()
} = {}) {
  const redis = getDurableRedis();
  const dataWeekKey = learningDataKey(weekKey);

  const micros = await getWeekMicros(dataWeekKey);

  await saveWeekMicros(dataWeekKey, micros);

  const rotation = await buildRotationFromWeek({
    weekKey: dataWeekKey,
    activeWeekKey,
    mode
  });

  await setJson(
    redis,
    nextRotationKey(),
    rotation
  );

  await setJson(
    redis,
    rotationValidFromKey(),
    {
      validFrom: `${activeWeekKey}_MONDAY_00_UTC`,
      ts: now(),
      sourceWeekKey: dataWeekKey,
      activeWeekKey,
      dataWeekKey,
      learningDataKey: dataWeekKey,
      rotationId: rotation.rotationId,

      ...modeFlags(),

      trueMicroOnly: true,
      exactTrueMicroOnly: true,

      manualOnly: false,
      adminSelected: false,
      autoRotation: false,
      nextRotationOnly: true,
      activeRotationPreserved: true,
      liveSelectable: false,
      activationDisabled: true,
      manualSelectionRequired: true,

      usedLegacyFallback: false,
      usedSoftFallback: rotation.usedSoftFallback,
      usedObservationFallback: rotation.usedObservationFallback,
      usedRawFallback: rotation.usedRawFallback,
      usedPreviousWeekMerge: rotation.usedPreviousWeekMerge,
      usedPersistentLearningKey: rotation.usedPersistentLearningKey,

      selectedMicroFamilies: 0,
      selectedMacroFamilies: 0,
      candidateMicroFamilies: rotation.microFamilyIds.length,
      candidateMacroFamilies: rotation.macroFamilyIds.length,

      missingSides: rotation.missingSides || [],
      bestLong: rotation.bestLong?.microFamilyId || null,
      bestShort: null
    }
  );

  await sendWeeklyRotationReport(
    rotation,
    'NEXT_ROTATION_CANDIDATES_READY_MANUAL_SELECTION_REQUIRED'
  ).catch(() => null);

  return {
    ok: true,
    type: 'NEXT_ROTATION_CANDIDATES_READY_MANUAL_SELECTION_REQUIRED',
    weekKey: dataWeekKey,
    activeWeekKey,
    mode,
    rotationId: rotation.rotationId,

    ...modeFlags(),

    trueMicroOnly: true,
    exactTrueMicroOnly: true,

    manualOnly: false,
    adminSelected: false,
    autoRotation: false,
    nextRotationOnly: true,
    activeRotationPreserved: true,
    liveSelectable: false,
    activationDisabled: true,
    manualSelectionRequired: true,

    selectedMicroFamilies: 0,
    selectedMacroFamilies: 0,
    candidateMicroFamilies: rotation.microFamilyIds.length,
    candidateMacroFamilies: rotation.macroFamilyIds.length,

    usedLegacyFallback: false,
    usedSoftFallback: rotation.usedSoftFallback,
    usedObservationFallback: rotation.usedObservationFallback,
    usedRawFallback: rotation.usedRawFallback,
    usedPreviousWeekMerge: rotation.usedPreviousWeekMerge,
    usedPersistentLearningKey: rotation.usedPersistentLearningKey,

    missingSides: rotation.missingSides || [],
    bestLong: rotation.bestLong,
    bestShort: null,

    rotation
  };
}

function sanitizeActiveRotation(rotation = {}, {
  requireManual = false
} = {}) {
  if (!rotation || typeof rotation !== 'object') return null;

  if (requireManual && !isManualActiveRotation(rotation)) {
    return null;
  }

  const rows = Array.isArray(rotation.microFamilies)
    ? rotation.microFamilies
    : [];

  const longRows = rows
    .filter(isLongRotationRow)
    .filter(isTrueMicroFamily)
    .map((row, index) => compactRotationRow(row, index + 1))
    .filter((row) => row.microFamilyId)
    .filter((row) => isKnownTrueMicroId(row.microFamilyId));

  const indexes = buildSelectionIndexes(longRows);
  const manual = isManualActiveRotation(rotation);

  return {
    ...rotation,

    ...modeFlags(),

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    usedLegacyFallback: false,

    manualOnly: manual,
    adminSelected: manual,
    autoRotation: false,
    liveSelectable: manual && longRows.length > 0,

    microFamilies: longRows,

    microFamilyIds: indexes.microFamilyIds,
    activeMicroFamilyIds: indexes.activeMicroFamilyIds,
    trueMicroFamilyIds: indexes.trueMicroFamilyIds,

    macroFamilyIds: indexes.macroFamilyIds,
    activeMacroFamilyIds: indexes.activeMacroFamilyIds,

    microToMacroFamilyId: indexes.microToMacroFamilyId,
    macroToMicroFamilyIds: indexes.macroToMicroFamilyIds,

    bestLong: bestLongRow(longRows),
    bestShort: null,
    missingSides: missingSides(longRows),

    empty: longRows.length === 0,
    emptyReason: longRows.length === 0
      ? 'ACTIVE_ROTATION_CONTAINED_NO_MANUAL_LONG_TRUE_MICRO_FAMILIES'
      : null
  };
}

export async function activateNextRotation() {
  return {
    ok: false,
    skipped: true,
    changed: false,
    reason: 'AUTO_ROTATION_ACTIVATION_DISABLED_MANUAL_ONLY',
    ...modeFlags(),
    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    manualOnly: true,
    activationDisabled: true
  };
}

export async function getActiveRotation() {
  const redis = getDurableRedis();

  const raw = await getJson(
    redis,
    activeRotationKey(),
    null
  );

  const sanitized = sanitizeActiveRotation(raw, {
    requireManual: true
  });

  if (!sanitized || sanitized.empty || !sanitized.microFamilyIds?.length) {
    return null;
  }

  if (
    raw?.shortOnly === true ||
    raw?.longDisabled === true ||
    raw?.targetTradeSide === OPPOSITE_TRADE_SIDE ||
    raw?.dashboardSide === 'bear' ||
    raw?.manualOnly !== true ||
    raw?.liveSelectable !== true ||
    raw?.autoRotation === true
  ) {
    await setJson(
      redis,
      activeRotationKey(),
      sanitized
    ).catch(() => null);
  }

  return sanitized;
}

export async function getActiveRotationSet() {
  const active = await getActiveRotation();

  const ids = uniqueStrings([
    active?.activeMicroFamilyIds || [],
    active?.trueMicroFamilyIds || [],
    active?.microFamilyIds || []
  ])
    .map(cleanLearningMicroId)
    .filter(isKnownTrueMicroId)
    .filter(idLooksLikeLongFamily);

  return new Set(ids);
}

export async function getActiveMacroRotationSet() {
  const active = await getActiveRotation();

  const ids = uniqueStrings([
    active?.activeMacroFamilyIds || [],
    active?.macroFamilyIds || []
  ])
    .map(cleanLearningMicroId)
    .filter(Boolean)
    .filter(idLooksLikeLongFamily)
    .filter((id) => !isScannerFingerprintId(id))
    .filter((id) => !isExecutionFingerprintId(id));

  return new Set(ids);
}

function manualSideFromId(id = '') {
  const value = String(id || '').toUpperCase();

  if (isScannerFingerprintId(value)) return 'UNKNOWN';
  if (isExecutionFingerprintId(value)) return 'UNKNOWN';
  if (idLooksLikeShortFamily(value) && !idLooksLikeLongFamily(value)) return OPPOSITE_TRADE_SIDE;
  if (idLooksLikeLongFamily(value)) return TARGET_TRADE_SIDE;

  return 'UNKNOWN';
}

function buildManualOnlyRow(id, rank) {
  const cleanId = cleanLearningMicroId(id);
  const tradeSide = manualSideFromId(cleanId);
  const taxonomy = taxonomyMetaForId(cleanId);

  if (tradeSide !== TARGET_TRADE_SIDE) return null;
  if (!isKnownTrueMicroId(cleanId)) return null;

  return {
    rank,

    microFamilyId: cleanId,
    trueMicroFamilyId: cleanId,
    analyzeMicroFamilyId: cleanId,
    learningMicroFamilyId: cleanId,

    familyId: null,

    macroFamilyId: null,
    parentMacroFamilyId: null,
    parentMicroFamilyId: null,

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

    schema: taxonomy.fixedTaxonomyLearningId ? FIXED_TAXONOMY_SCHEMA : schemaMeta().fallbackTrueMicroSchema,
    microFamilySchema: taxonomy.fixedTaxonomyLearningId ? FIXED_TAXONOMY_SCHEMA : schemaMeta().fallbackTrueMicroSchema,
    trueMicroFamilySchema: taxonomy.fixedTaxonomyLearningId ? FIXED_TAXONOMY_SCHEMA : schemaMeta().fallbackTrueMicroSchema,
    version: 'manual_true_micro',

    setupType: taxonomy.setupType,
    regimeBucket: taxonomy.regimeBucket,
    confirmationProfile: taxonomy.confirmationProfile,
    fixedTaxonomyLearningId: taxonomy.fixedTaxonomyLearningId,

    isTrueMicro: true,
    isLegacyMacro: false,
    manualOnly: true,
    unverifiedManualId: true,

    rotationEligibilityTier: 'MANUAL',
    rotationEligible: true,
    hardEligible: false,
    softEligible: false,
    observationEligible: false,
    rawEligible: false,

    learningStatus: 'OBSERVING',
    status: 'OBSERVING',
    tooEarly: true,
    tooEarlyReason: `completed 0/${DEFAULT_MIN_WEIGHTED_COMPLETED}`,

    seen: 0,
    observations: 0,
    observationSample: 0,

    completed: 0,
    outcomeSample: 0,
    realCompleted: 0,
    virtualCompleted: 0,
    shadowCompleted: 0,

    winrateSample: 0,
    winrate: 0,
    bayesianWinrate: 0,
    wilsonLowerBound: 0,
    sampleWilsonLowerBound: 0,
    fairWinrate: 0,
    sampleAdjustedWinrate: 0,
    sampleReliability: 0,

    avgR: 0,
    totalR: 0,
    avgWinR: 0,
    avgLossR: 0,

    profitFactor: 0,
    directSLPct: 0,
    nearTpPct: 0,
    reachedHalfRPct: 0,
    reachedOneRPct: 0,

    beWouldExitPct: 0,
    gaveBackAfterHalfRPct: 0,
    gaveBackAfterOneRPct: 0,
    nearTpThenLossPct: 0,

    totalCostR: 0,
    avgCostR: 0,

    balancedScore: 0,
    dashboardBalancedScore: 0,

    definitionParts: [
      `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
      `MANUAL_TRUE_MICRO=${cleanId}`,
      'SOURCE=MANUAL_SELECTION'
    ],
    definition: `TRADE_SIDE=${TARGET_TRADE_SIDE} | MANUAL_TRUE_MICRO=${cleanId} | SOURCE=MANUAL_SELECTION`,

    parentDefinitionParts: [],
    parentDefinition: '',

    ...modeFlags()
  };
}

function resolveManualSelection({
  requestedIds = [],
  micros = {}
}) {
  const selectedRows = [];
  const ignoredIds = [];
  const expandedFromMacro = {};
  const seen = new Set();

  const microsByUpperId = Object.fromEntries(
    Object.values(micros || {})
      .filter(Boolean)
      .map((row) => [
        rowId(row).toUpperCase(),
        row
      ])
      .filter(([id]) => Boolean(id))
  );

  const addRow = (row) => {
    const id = rowId(row);

    if (!id || seen.has(id)) return;
    if (isScannerFingerprintId(id)) return;
    if (isExecutionFingerprintId(id)) return;
    if (!isLongRotationRow(row)) return;
    if (!isTrueMicroFamily(row)) return;
    if (!isKnownTrueMicroId(id)) return;

    seen.add(id);
    selectedRows.push({
      ...row,
      microFamilyId: id,
      trueMicroFamilyId: id,
      analyzeMicroFamilyId: id,
      learningMicroFamilyId: id
    });
  };

  for (const requestedId of requestedIds) {
    const id = cleanLearningMicroId(requestedId);
    const side = manualSideFromId(id);

    if (side !== TARGET_TRADE_SIDE) {
      ignoredIds.push({
        id: requestedId,
        normalizedId: id,
        side,
        reason: side === OPPOSITE_TRADE_SIDE
          ? 'SHORT_DISABLED_LONG_ONLY'
          : 'UNKNOWN_OR_NON_LONG_ID_REJECTED'
      });
      continue;
    }

    if (!isKnownTrueMicroId(id)) {
      ignoredIds.push({
        id: requestedId,
        normalizedId: id,
        side,
        reason: isScannerFingerprintId(id)
          ? 'SCANNER_FINGERPRINT_METADATA_ONLY_NOT_SELECTABLE'
          : isExecutionFingerprintId(id)
            ? 'EXECUTION_FINGERPRINT_METADATA_ONLY_NOT_SELECTABLE'
            : 'ONLY_EXACT_LONG_TRUE_MICRO_IDS_ALLOWED'
      });
      continue;
    }

    const directRow = micros[id];
    const upperRow = microsByUpperId[id.toUpperCase()];
    const row = directRow || upperRow;

    if (
      row &&
      isLongRotationRow(row) &&
      isTrueMicroFamily(row) &&
      isManualEligible(row)
    ) {
      addRow(row);
      continue;
    }

    if (!row && allowManualUnknownTrueMicroIds()) {
      const manualRow = buildManualOnlyRow(id, selectedRows.length + 1);

      if (manualRow) {
        addRow(manualRow);
        continue;
      }
    }

    ignoredIds.push({
      id: requestedId,
      normalizedId: id,
      side,
      reason: row
        ? 'ROW_IS_NOT_LONG_TRUE_MICRO'
        : 'UNKNOWN_LONG_TRUE_MICRO_ID'
    });
  }

  return {
    selectedRows,
    ignoredIds,
    expandedFromMacro
  };
}

function requestedManualIdsFromOptions(options = {}) {
  return uniqueStrings([
    options.microFamilyIds || [],
    options.activeMicroFamilyIds || [],
    options.trueMicroFamilyIds || [],
    options.ids || [],
    options.id || []
  ]);
}

function buildPreservedActiveResponse({
  existingActive,
  requestedIds,
  ignoredIds,
  expandedFromMacro,
  weekKey,
  mode
}) {
  const preserved = existingActive
    ? {
      ...existingActive,
      ok: false,
      skipped: true,
      changed: false,
      activePreserved: true,
      reason: 'NO_VALID_LONG_TRUE_MICRO_IDS_SELECTED_ACTIVE_ROTATION_PRESERVED'
    }
    : {
      ok: false,
      skipped: true,
      changed: false,
      activePreserved: false,
      rotationId: null,
      source: 'ADMIN_MANUAL_SELECTION_LONG_TRUE_MICRO_ONLY',
      mode,
      sourceWeekKey: weekKey,
      activeWeekKey: getIsoWeekKey(),
      dataWeekKey: weekKey,
      learningDataKey: weekKey,
      generatedAt: now(),
      activatedAt: null,
      ...modeFlags(),
      trueMicroOnly: true,
      exactTrueMicroOnly: true,
      manualOnly: true,
      adminSelected: true,
      autoRotation: false,
      liveSelectable: false,
      empty: true,
      emptyReason: 'NO_VALID_LONG_TRUE_MICRO_IDS_SELECTED',
      reason: 'NO_VALID_LONG_TRUE_MICRO_IDS_SELECTED',
      microFamilies: [],
      microFamilyIds: [],
      activeMicroFamilyIds: [],
      trueMicroFamilyIds: [],
      macroFamilyIds: [],
      activeMacroFamilyIds: [],
      microToMacroFamilyId: {},
      macroToMicroFamilyIds: {},
      bestLong: null,
      bestShort: null,
      missingSides: [TARGET_TRADE_SIDE]
    };

  return {
    ...preserved,
    requestedMicroFamilyIds: requestedIds,
    ignoredRequestedIds: ignoredIds,
    expandedFromMacro
  };
}

export async function activateSelectedMicroFamilies(options = {}) {
  const {
    weekKey = PERSISTENT_LEARNING_KEY,
    activeWeekKey = getIsoWeekKey(),
    mode = 'manual'
  } = options || {};

  const redis = getDurableRedis();
  const dataWeekKey = learningDataKey(weekKey);

  const [
    rotationMicros,
    existingRawActive
  ] = await Promise.all([
    getRotationMicros(dataWeekKey),
    getJson(redis, activeRotationKey(), null).catch(() => null)
  ]);

  const {
    micros,
    usedPreviousWeekMerge,
    usedPersistentLearningKey,
    primaryRows,
    previousRows
  } = rotationMicros;

  const requestedIds = requestedManualIdsFromOptions(options);

  const {
    selectedRows,
    ignoredIds,
    expandedFromMacro
  } = resolveManualSelection({
    requestedIds,
    micros
  });

  const microFamilies = selectedRows
    .filter(isLongRotationRow)
    .filter(isTrueMicroFamily)
    .map((row, index) => {
      if (row.manualOnly) {
        return {
          ...row,
          rank: index + 1
        };
      }

      return compactRotationRow(row, index + 1);
    })
    .filter((row) => row.microFamilyId)
    .filter((row) => isKnownTrueMicroId(row.microFamilyId));

  if (microFamilies.length === 0) {
    const existingActive = sanitizeActiveRotation(existingRawActive, {
      requireManual: true
    });

    return buildPreservedActiveResponse({
      existingActive,
      requestedIds,
      ignoredIds,
      expandedFromMacro,
      weekKey: dataWeekKey,
      mode
    });
  }

  const indexes = buildSelectionIndexes(microFamilies);
  const meta = schemaMeta();

  const active = sanitizeActiveRotation({
    rotationId: randomId(`ROT_${dataWeekKey}_manual_long_only`),
    source: 'ADMIN_MANUAL_SELECTION_LONG_TRUE_MICRO_ONLY',
    mode,

    sourceWeekKey: dataWeekKey,
    activeWeekKey,
    dataWeekKey,
    learningDataKey: dataWeekKey,

    generatedAt: now(),
    activatedAt: now(),
    strategyVersion: CONFIG.strategyVersion,

    schema: meta.schema,
    macroSchema: meta.macroSchema,
    microSchema: meta.microSchema,

    ...modeFlags(),

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    manualOnly: true,
    adminSelected: true,
    autoRotation: false,
    liveSelectable: indexes.microFamilyIds.length > 0,

    usedLegacyFallback: false,
    usedSoftFallback: microFamilies.some((row) => row.rotationEligibilityTier === 'SOFT'),
    usedObservationFallback: microFamilies.some((row) => row.rotationEligibilityTier === 'OBSERVATION'),
    usedRawFallback: microFamilies.some((row) => row.rotationEligibilityTier === 'RAW'),
    usedPreviousWeekMerge,
    usedPersistentLearningKey,

    minWeightedCompleted: minWeightedCompleted(),
    topNPerSide: topNPerSide(),
    maxPerMacroFamily: maxPerMacroFamily(),

    primaryRows,
    previousRows,

    empty: indexes.microFamilyIds.length === 0,
    emptyReason: indexes.microFamilyIds.length === 0
      ? 'NO_LONG_TRUE_MICRO_IDS_SELECTED'
      : null,

    requestedMicroFamilyIds: requestedIds,
    ignoredRequestedIds: ignoredIds,
    expandedFromMacro,

    bestLong: bestLongRow(microFamilies),
    bestShort: null,
    missingSides: missingSides(microFamilies),

    microFamilyIds: indexes.microFamilyIds,
    activeMicroFamilyIds: indexes.activeMicroFamilyIds,
    trueMicroFamilyIds: indexes.trueMicroFamilyIds,

    macroFamilyIds: indexes.macroFamilyIds,
    activeMacroFamilyIds: indexes.activeMacroFamilyIds,

    microToMacroFamilyId: indexes.microToMacroFamilyId,
    macroToMicroFamilyIds: indexes.macroToMicroFamilyIds,

    microFamilies
  }, {
    requireManual: true
  });

  const finalActive = {
    ...active,
    ok: true,
    skipped: false,
    changed: true,
    activePreserved: false
  };

  await setJson(
    redis,
    activeRotationKey(),
    finalActive
  );

  return finalActive;
}

function sanitizeDashboardRotation(rotation) {
  const sanitized = sanitizeActiveRotation(rotation, {
    requireManual: false
  });

  if (!sanitized) return null;

  return {
    ...sanitized,

    manualOnly: false,
    adminSelected: false,
    autoRotation: false,
    nextRotationOnly: true,
    activeRotationPreserved: true,
    liveSelectable: false,
    activationDisabled: true,
    manualSelectionRequired: true,

    candidateMicroFamilyIds: sanitized.microFamilyIds || [],
    candidateMacroFamilyIds: sanitized.macroFamilyIds || []
  };
}

export async function getRotationDashboard() {
  const redis = getDurableRedis();

  const [activeRaw, nextRaw, validFrom] = await Promise.all([
    getActiveRotation(),
    getJson(redis, nextRotationKey(), null),
    getJson(redis, rotationValidFromKey(), null)
  ]);

  const active = sanitizeActiveRotation(activeRaw, {
    requireManual: true
  });

  const next = sanitizeDashboardRotation(nextRaw);

  const activeRows = Array.isArray(active?.microFamilies)
    ? active.microFamilies
    : [];

  const nextRows = Array.isArray(next?.microFamilies)
    ? next.microFamilies
    : [];

  return {
    active,
    next,
    validFrom,

    activeRows,
    nextRows,

    activeCount: active?.microFamilyIds?.length || 0,
    nextCount: next?.microFamilyIds?.length || 0,

    activeMacroCount: active?.macroFamilyIds?.length || 0,
    nextMacroCount: next?.macroFamilyIds?.length || 0,

    activeMicroFamilyIds: active?.microFamilyIds || [],
    nextMicroFamilyIds: next?.microFamilyIds || [],

    activeMacroFamilyIds: active?.macroFamilyIds || active?.activeMacroFamilyIds || [],
    nextMacroFamilyIds: next?.macroFamilyIds || next?.activeMacroFamilyIds || [],

    activeMicroToMacroFamilyId: active?.microToMacroFamilyId || {},
    nextMicroToMacroFamilyId: next?.microToMacroFamilyId || {},

    activeMacroToMicroFamilyIds: active?.macroToMicroFamilyIds || {},
    nextMacroToMicroFamilyIds: next?.macroToMicroFamilyIds || {},

    bestLong: active?.bestLong || null,
    bestShort: null,
    nextBestLong: next?.bestLong || null,
    nextBestShort: null,

    missingSides: active?.missingSides || [TARGET_TRADE_SIDE],
    nextMissingSides: next?.missingSides || [TARGET_TRADE_SIDE],

    usedSoftFallback: Boolean(active?.usedSoftFallback),
    nextUsedSoftFallback: Boolean(next?.usedSoftFallback),

    usedObservationFallback: Boolean(active?.usedObservationFallback),
    nextUsedObservationFallback: Boolean(next?.usedObservationFallback),

    usedRawFallback: Boolean(active?.usedRawFallback),
    nextUsedRawFallback: Boolean(next?.usedRawFallback),

    usedPreviousWeekMerge: Boolean(active?.usedPreviousWeekMerge),
    nextUsedPreviousWeekMerge: Boolean(next?.usedPreviousWeekMerge),

    usedPersistentLearningKey: Boolean(active?.usedPersistentLearningKey),
    nextUsedPersistentLearningKey: Boolean(next?.usedPersistentLearningKey),

    dataWeekKey: active?.dataWeekKey || PERSISTENT_LEARNING_KEY,
    learningDataKey: active?.learningDataKey || PERSISTENT_LEARNING_KEY,

    manualOnly: true,
    autoRotationActivationDisabled: true,
    activeLiveSelectable: Boolean(active?.liveSelectable),

    ...modeFlags(),

    trueMicroOnly: true,
    exactTrueMicroOnly: true
  };
}