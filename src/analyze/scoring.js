// ================= FILE: src/analyze/scoring.js =================

import { CONFIG } from '../config.js';
import { clamp, safeNumber, sideToTradeSide } from '../utils.js';

const DEFAULT_WILSON_Z = 1.96;
const DEFAULT_PRIOR_TRADES = 24;
const DEFAULT_PRIOR_WINRATE = 0.5;
const DEFAULT_SAMPLE_CAP = 50;
const DEFAULT_AVG_R_CAP = 5;
const DEFAULT_AVG_R_SAMPLE_EXPONENT = 1.35;
const DEFAULT_OBSERVATION_DEDUPE_CACHE_LIMIT = 5000;

const MIN_COMPLETED_ACTIVE = 20;

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const TARGET_SCANNER_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = TRUE_MICRO_SCHEMA;
const LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_V1';

const MEASUREMENT_FIX_VERSION = 'LONG_MEASUREMENT_FIX_AVGCOST_DIRECTSL_SEEN_DEDUPE_V2';

const SOURCE_VIRTUAL = 'VIRTUAL';
const SOURCE_REAL = 'REAL';
const SOURCE_SHADOW = 'SHADOW';

const LONG_FIXED_SETUP_TYPES = new Set([
  'BREAKOUT',
  'RETEST',
  'SWEEP_REVERSAL',
  'CONTINUATION',
  'COMPRESSION'
]);

const LONG_FIXED_REGIME_ORDER = [
  'TREND',
  'CHOP',
  'SQUEEZE'
];

const LONG_FIXED_REGIME_BUCKETS = new Set(LONG_FIXED_REGIME_ORDER);

const CONFIRMATION_PROFILE_ORDER = Object.freeze([
  'A_STRONG_ALIGN',
  'B_FLOW_ALIGN',
  'C_VOLUME_ALIGN',
  'D_MIXED_OK',
  'E_WEAK_CONTRA'
]);

const LONG_CONFIRMATION_PROFILES = new Set(CONFIRMATION_PROFILE_ORDER);

function now() {
  return Date.now();
}

function round4(value) {
  return Number(safeNumber(value, 0).toFixed(4));
}

function upper(value, fallback = '') {
  const text = String(value ?? '').trim();

  return text ? text.toUpperCase() : fallback;
}

function rotationNumber(key, fallback) {
  return safeNumber(
    CONFIG.long?.rotation?.[key] ??
      CONFIG.rotation?.[key],
    fallback
  );
}

function analyzeNumber(key, fallback) {
  return safeNumber(
    CONFIG.long?.analyze?.[key] ??
      CONFIG.analyze?.[key],
    fallback
  );
}

function observationDedupeCacheLimit() {
  return Math.max(
    100,
    Math.floor(analyzeNumber('observationDedupeCacheLimit', DEFAULT_OBSERVATION_DEDUPE_CACHE_LIMIT))
  );
}

function schemaConfig() {
  const macroSchema = String(
    CONFIG.long?.analyze?.macroSchema ??
      CONFIG.analyze?.macroSchema ??
      CONFIG.analyze?.legacySchema ??
      'MF_V1'
  ).toUpperCase();

  const configuredLegacyMicroSchema = String(
    CONFIG.long?.analyze?.legacyMicroSchema ??
      CONFIG.long?.analyze?.microSchema ??
      CONFIG.analyze?.legacyMicroSchema ??
      CONFIG.analyze?.microSchema ??
      'MF_V2'
  ).toUpperCase();

  return {
    currentSchema: TRUE_MICRO_SCHEMA,
    macroSchema,
    microSchema: TRUE_MICRO_SCHEMA,
    legacyMicroSchema: configuredLegacyMicroSchema,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY
  };
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

function finiteOrNull(value) {
  if (value === undefined || value === null || value === '') return null;

  const n = Number(value);

  return Number.isFinite(n) ? n : null;
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

function isExecutionFingerprintId(id = '') {
  const value = upper(id);

  return (
    value.includes('_XR_') ||
    value.includes('__XR__') ||
    value.includes('|XR|') ||
    value.includes('EXECUTION_FINGERPRINT') ||
    value.includes('EXECUTION_MICRO') ||
    value.includes('EXECUTIONMICRO') ||
    value.includes('REFINED_EXECUTION')
  );
}

function isScannerFamilyId(id = '') {
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

function validLearningId(id = '') {
  const value = String(id || '').trim();

  if (!value) return false;
  if (isScannerFamilyId(value)) return false;
  if (isExecutionFingerprintId(value)) return false;

  return true;
}

function parseLongTaxonomyMicroId(id = '') {
  const rawId = String(id || '').trim();
  const value = upper(rawId);

  if (!value.startsWith('MICRO_LONG_')) {
    return {
      valid: false,
      selectable: false,
      isParent: false,
      isChild: false,
      rawId
    };
  }

  if (isScannerFamilyId(value) || isExecutionFingerprintId(value)) {
    return {
      valid: false,
      selectable: false,
      isParent: false,
      isChild: false,
      rawId
    };
  }

  if (
    value.includes('_MF_V1_') ||
    value.includes('_MF_V2_') ||
    value.includes('_MF_V3_')
  ) {
    return {
      valid: false,
      selectable: false,
      isParent: false,
      isChild: false,
      rawId
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

  for (const candidateRegime of LONG_FIXED_REGIME_ORDER) {
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
    rawId,
    id: validChild ? childId : validParent ? parentId : value,
    setup,
    regime,
    setupType: setup,
    regimeBucket: regime,
    confirmationProfile,
    parentTrueMicroFamilyId: validParent ? parentId : null,
    trueMicroFamilyId: validChild ? childId : validParent ? parentId : null,
    childTrueMicroFamilyId: validChild ? childId : null,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY
  };
}

function isSelectableLongChildTrueMicroId(id = '') {
  return parseLongTaxonomyMicroId(id).isChild === true;
}

function isParentLongTrueMicroId(id = '') {
  return parseLongTaxonomyMicroId(id).isParent === true;
}

function cleanSideText(value = '') {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replaceAll('SHORT_DISABLED_TRUE', '')
    .replaceAll('SHORTDISABLED_TRUE', '')
    .replaceAll('BLOCK_SHORT_TRUE', '')
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

function normalizeTradeSide(value) {
  const raw = cleanSideText(value);

  if (!raw) return 'UNKNOWN';

  const direct = sideToTradeSide(raw);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  if (['LONG', 'BULL', 'BULLISH', 'BUY', 'BID', 'UP', 'UPSIDE', 'GREEN'].includes(raw)) {
    return TARGET_TRADE_SIDE;
  }

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'ASK', 'DOWN', 'DOWNSIDE', 'RED'].includes(raw)) {
    return OPPOSITE_TRADE_SIDE;
  }

  const longHit = hasLongSignal(raw);
  const shortHit = hasShortSignal(raw);

  if (longHit && !shortHit) return TARGET_TRADE_SIDE;
  if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;

  if (shortHit && longHit) {
    if (raw.includes('TRADE_SIDE=LONG') || raw.includes('TRADESIDE=LONG')) return TARGET_TRADE_SIDE;
    if (raw.includes('TRADE_SIDE=SHORT') || raw.includes('TRADESIDE=SHORT')) return OPPOSITE_TRADE_SIDE;
    if (raw.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
    if (raw.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function directSide(row = {}) {
  const values = [
    row.tradeSide,
    row.positionSide,
    row.direction,
    row.signalSide,
    row.intentSide,
    row.entrySide,
    row.scannerSide,
    row.actualScannerSide,
    row.analysisSide,
    row.side
  ];

  for (const value of values) {
    const side = normalizeTradeSide(value);

    if (side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE) {
      return side;
    }
  }

  return 'UNKNOWN';
}

function definitionValues(row = {}) {
  return [
    row.familyId,
    row.family,
    row.baseFamilyId,

    row.microFamilyId,
    row.trueMicroFamilyId,
    row.childTrueMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.learningMicroFamilyId,
    row.coarseMicroFamilyId,
    row.parentTrueMicroFamilyId,
    row.baseMicroFamilyId,
    row.legacyMicroFamilyId,
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
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : []),
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : [])
  ];
}

function definitionText(row = {}) {
  return definitionValues(row)
    .map((value) => cleanSideText(value))
    .filter(Boolean)
    .join('|');
}

function definitionSide(row = {}) {
  const values = definitionValues(row);

  let longHit = false;
  let shortHit = false;

  for (const value of values) {
    const side = normalizeTradeSide(value);

    if (side === TARGET_TRADE_SIDE) longHit = true;
    if (side === OPPOSITE_TRADE_SIDE) shortHit = true;
  }

  if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;
  if (longHit && !shortHit) return TARGET_TRADE_SIDE;

  if (shortHit && longHit) {
    const text = values
      .map((value) => cleanSideText(value))
      .filter(Boolean)
      .join('|');

    if (text.includes('TRADE_SIDE=LONG') || text.includes('TRADESIDE=LONG')) return TARGET_TRADE_SIDE;
    if (text.includes('TRADE_SIDE=SHORT') || text.includes('TRADESIDE=SHORT')) return OPPOSITE_TRADE_SIDE;
    if (text.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
    if (text.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferTradeSide(row = {}) {
  if (typeof row === 'string') return normalizeTradeSide(row);

  if (!row || typeof row !== 'object') return 'UNKNOWN';

  const direct = directSide(row);

  if (direct === TARGET_TRADE_SIDE || direct === OPPOSITE_TRADE_SIDE) {
    return direct;
  }

  const fromDefinition = definitionSide(row);

  if (fromDefinition === TARGET_TRADE_SIDE || fromDefinition === OPPOSITE_TRADE_SIDE) {
    return fromDefinition;
  }

  if (row.longOnly === true || row.shortDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  if (row.shortOnly === true || row.longDisabled === true) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function isLongRow(row = {}) {
  return inferTradeSide(row) === TARGET_TRADE_SIDE;
}

function rowSchema(row = {}) {
  return String(
    row.trueMicroFamilySchema ||
      row.childTrueMicroFamilySchema ||
      row.exactTrueMicroFamilySchema ||
      row.broadTrueMicroFamilySchema ||
      row.microFamilySchema ||
      row.schema ||
      row.versionSchema ||
      ''
  ).toUpperCase();
}

function rowMicroId(row = {}) {
  const value = String(
    row.trueMicroFamilyId ||
      row.childTrueMicroFamilyId ||
      row.microFamilyId ||
      row.analyzeMicroFamilyId ||
      row.learningMicroFamilyId ||
      row.id ||
      row.key ||
      ''
  ).trim();

  return validLearningId(value) ? value.toUpperCase() : '';
}

function rowParentTrueMicroId(row = {}) {
  const direct = String(
    row.parentTrueMicroFamilyId ||
      row.coarseMicroFamilyId ||
      row.baseMicroFamilyId ||
      row.legacyMicroFamilyId ||
      row.parentMacroFamilyId ||
      row.parentMicroFamilyId ||
      row.macroFamilyId ||
      ''
  ).trim();

  const parsedDirect = parseLongTaxonomyMicroId(direct);

  if (parsedDirect.valid) {
    return parsedDirect.parentTrueMicroFamilyId;
  }

  const parsedMicro = parseLongTaxonomyMicroId(rowMicroId(row));

  if (parsedMicro.valid) {
    return parsedMicro.parentTrueMicroFamilyId;
  }

  return '';
}

function idHasSchema(id, schema) {
  const value = upper(id);
  const target = upper(schema);

  if (!value || !target) return false;

  if (target === TRUE_MICRO_SCHEMA) {
    return (
      isSelectableLongChildTrueMicroId(value) ||
      value.includes(`_${TRUE_MICRO_SCHEMA}_`) ||
      value.endsWith(`_${TRUE_MICRO_SCHEMA}`) ||
      value.includes(`|SCHEMA=${TRUE_MICRO_SCHEMA}`) ||
      value.includes(`SCHEMA=${TRUE_MICRO_SCHEMA}`)
    );
  }

  if (target === PARENT_TRUE_MICRO_SCHEMA) {
    return (
      isParentLongTrueMicroId(value) ||
      value.includes(`_${PARENT_TRUE_MICRO_SCHEMA}_`) ||
      value.endsWith(`_${PARENT_TRUE_MICRO_SCHEMA}`) ||
      value.includes(`|SCHEMA=${PARENT_TRUE_MICRO_SCHEMA}`) ||
      value.includes(`SCHEMA=${PARENT_TRUE_MICRO_SCHEMA}`)
    );
  }

  return (
    value.includes(`_${target}_`) ||
    value.endsWith(`_${target}`) ||
    value.includes(`|SCHEMA=${target}`) ||
    value.includes(`SCHEMA=${target}`)
  );
}

function definitionHasSchema(row = {}, schema) {
  const target = upper(schema);

  if (!target) return false;

  const parts = [
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.broadTrueDefinitionParts) ? row.broadTrueDefinitionParts : []),
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : []),
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : [])
  ];

  const upperParts = parts.map((part) => String(part || '').toUpperCase());

  if (target === TRUE_MICRO_SCHEMA) {
    return (
      upperParts.some((part) => (
        part === `SCHEMA=${TRUE_MICRO_SCHEMA}` ||
        part === `TRUEMICROFAMILYSCHEMA=${TRUE_MICRO_SCHEMA}` ||
        part === `CHILDTRUEMICROFAMILYSCHEMA=${TRUE_MICRO_SCHEMA}` ||
        part === `BROADTRUEMICROFAMILYSCHEMA=${TRUE_MICRO_SCHEMA}` ||
        part.includes(`SCHEMA=${TRUE_MICRO_SCHEMA}`) ||
        part.includes('FIXED_TAXONOMY_75') ||
        part.includes('LEARNINGIDENTITY=ANALYZE_TRUE_MICRO_FAMILY_FIXED_TAXONOMY')
      )) ||
      definitionText(row).includes('FIXED_TAXONOMY_75')
    );
  }

  if (target === PARENT_TRUE_MICRO_SCHEMA) {
    return (
      upperParts.some((part) => (
        part === `SCHEMA=${PARENT_TRUE_MICRO_SCHEMA}` ||
        part === `PARENTTRUEMICROFAMILYSCHEMA=${PARENT_TRUE_MICRO_SCHEMA}` ||
        part.includes(`SCHEMA=${PARENT_TRUE_MICRO_SCHEMA}`) ||
        part.includes('FIXED_TAXONOMY_15')
      )) ||
      definitionText(row).includes('FIXED_TAXONOMY_15')
    );
  }

  if (upperParts.some((part) => part === `SCHEMA=${target}`)) {
    return true;
  }

  return definitionText(row).includes(`SCHEMA=${target}`);
}

function idLooksLikeSimpleMacroFamily(id = '') {
  const value = String(id || '').trim();

  return (
    /^LONG(?:_F)?_?\d+$/iu.test(value) ||
    /^LONG_F\d+$/iu.test(value)
  );
}

function idLooksLikeLongMicroFamily(id = '') {
  const value = upper(id);

  if (!value) return false;
  if (!validLearningId(value)) return false;

  return value.startsWith('MICRO_LONG_');
}

function isTrueAnalyzeMicroRow(row = {}) {
  const { macroSchema, legacyMicroSchema } = schemaConfig();

  const id = rowMicroId(row);
  const schema = rowSchema(row);
  const version = upper(row.version);

  if (!row || !id) return false;
  if (!validLearningId(id)) return false;
  if (!isLongRow(row) && !idLooksLikeLongMicroFamily(id)) return false;

  if (row.isLegacyMacro === true) return false;
  if (row.isParentTrueMicro === true) return false;
  if (isParentLongTrueMicroId(id)) return false;
  if (idLooksLikeSimpleMacroFamily(id)) return false;
  if (version.includes('MACRO') || version.includes('PARENT')) return false;

  if (schema === macroSchema) return false;
  if (schema === PARENT_TRUE_MICRO_SCHEMA) return false;
  if (idHasSchema(id, macroSchema)) return false;
  if (idHasSchema(id, PARENT_TRUE_MICRO_SCHEMA)) return false;
  if (definitionHasSchema(row, macroSchema)) return false;

  if (isSelectableLongChildTrueMicroId(id)) return true;

  if (
    row.fixedTaxonomyLearningId === true &&
    row.exactTrueMicroFamilyRequired === true &&
    idLooksLikeLongMicroFamily(id) &&
    !idHasSchema(id, legacyMicroSchema) &&
    !idHasSchema(id, macroSchema)
  ) {
    return isSelectableLongChildTrueMicroId(id);
  }

  return false;
}

function isRealAnalyzeMicroRow(row = {}) {
  return isTrueAnalyzeMicroRow(row);
}

function dashboardSideFromTradeSide(side, fallback = 'unknown') {
  const tradeSide = normalizeTradeSide(side);

  if (tradeSide === TARGET_TRADE_SIDE) return TARGET_DASHBOARD_SIDE;

  return String(fallback || 'unknown').toLowerCase();
}

function normalizeSource(source = SOURCE_VIRTUAL) {
  const src = String(source || SOURCE_VIRTUAL).trim().toUpperCase();

  if (src === SOURCE_REAL) return SOURCE_REAL;
  if (src === SOURCE_SHADOW) return SOURCE_SHADOW;
  if (src === SOURCE_VIRTUAL) return SOURCE_VIRTUAL;

  return SOURCE_VIRTUAL;
}

function sourceWeight(source) {
  return normalizeSource(source) === SOURCE_SHADOW
    ? shadowWeight()
    : 1;
}

function fixedTaxonomyMeta(row = {}) {
  const id = rowMicroId(row);
  const parsed = parseLongTaxonomyMicroId(id);

  if (!parsed.valid) {
    return {
      setupType: row.setupType || null,
      regimeBucket: row.regimeBucket || null,
      confirmationProfile: row.confirmationProfile || null,
      parentTrueMicroFamilyId: rowParentTrueMicroId(row) || null,
      childTrueMicroFamilyId: null,
      fixedTaxonomyLearningId: false,
      selectableChild: false
    };
  }

  return {
    setupType: parsed.setup,
    regimeBucket: parsed.regime,
    confirmationProfile: parsed.confirmationProfile || row.confirmationProfile || null,
    parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
    childTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
    fixedTaxonomyLearningId: parsed.isChild,
    fixedTaxonomyBaseId: parsed.parentTrueMicroFamilyId,
    selectableChild: parsed.isChild,
    isParentTrueMicro: parsed.isParent
  };
}

function applyLearningIdentityFlags(stats = {}, row = {}) {
  const id = rowMicroId({
    ...stats,
    ...row
  });

  const taxonomy = fixedTaxonomyMeta({
    ...stats,
    ...row
  });

  stats.redisNamespace = LONG_NAMESPACE;
  stats.redisKeyPrefix = LONG_KEY_PREFIX;
  stats.persistentLearningKey = PERSISTENT_LEARNING_KEY;

  stats.trueMicroOnly = true;
  stats.exactTrueMicroOnly = true;
  stats.exactTrueMicroFamilyRequired = true;
  stats.trueMicroFamilySchema = TRUE_MICRO_SCHEMA;
  stats.childTrueMicroFamilySchema = CHILD_TRUE_MICRO_SCHEMA;
  stats.exactTrueMicroFamilySchema = TRUE_MICRO_SCHEMA;
  stats.parentTrueMicroFamilySchema = PARENT_TRUE_MICRO_SCHEMA;
  stats.broadTrueMicroFamilySchema = TRUE_MICRO_SCHEMA;
  stats.microFamilySchema = TRUE_MICRO_SCHEMA;
  stats.schema = TRUE_MICRO_SCHEMA;
  stats.learningGranularity = LEARNING_GRANULARITY;
  stats.parentLearningGranularity = PARENT_LEARNING_GRANULARITY;
  stats.fixedTaxonomyPreferred = true;
  stats.fixedTaxonomyLearningId = taxonomy.fixedTaxonomyLearningId;
  stats.selectableChild = taxonomy.selectableChild;
  stats.fixedTaxonomyBaseId = taxonomy.fixedTaxonomyBaseId || stats.fixedTaxonomyBaseId || null;

  stats.setupType = taxonomy.setupType || stats.setupType || null;
  stats.regimeBucket = taxonomy.regimeBucket || stats.regimeBucket || null;
  stats.confirmationProfile = taxonomy.confirmationProfile || stats.confirmationProfile || null;

  if (id) {
    stats.microFamilyId = id;
    stats.trueMicroFamilyId = id;
    stats.childTrueMicroFamilyId = taxonomy.childTrueMicroFamilyId || id;
    stats.analyzeMicroFamilyId = id;
    stats.learningMicroFamilyId = id;

    stats.parentTrueMicroFamilyId =
      taxonomy.parentTrueMicroFamilyId ||
      rowParentTrueMicroId(stats) ||
      rowParentTrueMicroId(row) ||
      null;

    stats.coarseMicroFamilyId = stats.parentTrueMicroFamilyId;
    stats.baseMicroFamilyId = stats.parentTrueMicroFamilyId;
    stats.legacyMicroFamilyId = stats.parentTrueMicroFamilyId;

    stats.macroFamilyId = stats.parentTrueMicroFamilyId;
    stats.parentMacroFamilyId = stats.parentTrueMicroFamilyId;
    stats.parentMicroFamilyId = stats.parentTrueMicroFamilyId;
  }

  stats.parentSelectionAllowed = false;
  stats.selectionGranularity = 'EXACT_75_CHILD';
  stats.fallbackRankingGranularity = 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED';

  stats.scannerFingerprintRole = 'METADATA_ONLY';
  stats.scannerFingerprintsMetadataOnly = true;
  stats.scannerFingerprintsUsedAsLearningFamily = false;
  stats.scannerBucketsMetadataOnly = true;
  stats.legacy25BucketsMetadataOnly = true;

  stats.executionFingerprintRole = stats.executionFingerprintRole || 'METADATA_ONLY';
  stats.executionFingerprintsMetadataOnly = true;
  stats.executionFingerprintsUsedAsLearningFamily = false;

  stats.analyzeMicroFamiliesOnly = true;
  stats.learningIdentitySource = 'ANALYZE_TRUE_MICRO_FAMILY';
  stats.symbolExcludedFromFamilyId = true;
  stats.coinNameExcludedFromFamilyId = true;
  stats.hashesExcludedFromFamilyId = true;

  stats.completedDefinition = 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES';
  stats.completedOnlyClosedVirtualOrShadow = true;
  stats.scoringRSource = 'netR';
  stats.winsLossesFlatsSource = 'netR';
  stats.winrateDefinition = 'netR > 0';
  stats.avgRSource = 'netR';
  stats.totalRSource = 'netR';
  stats.avgCostRShown = true;
  stats.avgCostRSource = 'costR';

  stats.measurementFixVersion = MEASUREMENT_FIX_VERSION;
  stats.seenDefinition = 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY';
  stats.observationDedupeRequired = true;
  stats.observationAlwaysCounted = false;

  stats.defaultRanking = 'dashboardBalancedScore|balancedScore|fairWinrate|totalR|avgR|avgCostR';
  stats.bareWinrateRankingDisabled = true;
  stats.rawWinrateRankingDisabled = true;
  stats.rankingUsesBalancedScore = true;
  stats.rankingUsesFairWinrate = true;
  stats.rankingUsesTotalR = true;
  stats.rankingUsesAvgR = true;
  stats.rankingUsesAvgCostR = true;

  stats.currentFitSoftOnly = true;
  stats.currentFitBlocksLearning = false;
  stats.learningRemainsBroad = true;
  stats.selectionWillBeAdaptive = true;
  stats.discordWillBeStrict = true;

  stats.adaptiveLayerBuilt = false;
  stats.adaptiveScoreBuilt = false;
  stats.recentMomentumScoreBuilt = false;
  stats.currentFitScoreBuilt = false;
  stats.parentDiversificationBuilt = false;

  stats.realOrdersDisabled = true;
  stats.exchangeOrdersDisabled = true;
  stats.bitgetOrdersDisabled = true;
  stats.exchangeCallsDisabled = true;
  stats.noRealOrders = true;
  stats.noExchangeOrders = true;

  return stats;
}

function applySideIdentity(stats = {}, row = {}) {
  const tradeSide = inferTradeSide({
    ...stats,
    ...row
  });

  stats.longOnly = true;
  stats.shortDisabled = true;
  stats.shortOnly = false;
  stats.longDisabled = false;

  applyLearningIdentityFlags(stats, row);

  if (tradeSide !== TARGET_TRADE_SIDE) {
    stats.tradeSide = null;
    stats.side = 'unknown';
    return stats;
  }

  stats.tradeSide = TARGET_TRADE_SIDE;
  stats.side = TARGET_DASHBOARD_SIDE;
  stats.positionSide = TARGET_TRADE_SIDE;
  stats.direction = TARGET_TRADE_SIDE;
  stats.targetTradeSide = TARGET_TRADE_SIDE;
  stats.targetScannerSide = TARGET_SCANNER_SIDE;
  stats.dashboardSide = TARGET_DASHBOARD_SIDE;

  return stats;
}

function hasSourceBuckets(stats = {}) {
  return (
    safeNumber(stats.virtualCompleted, 0) > 0 ||
    safeNumber(stats.shadowCompleted, 0) > 0 ||
    safeNumber(stats.virtualWins, 0) > 0 ||
    safeNumber(stats.virtualLosses, 0) > 0 ||
    safeNumber(stats.virtualFlats, 0) > 0 ||
    safeNumber(stats.shadowWins, 0) > 0 ||
    safeNumber(stats.shadowLosses, 0) > 0 ||
    safeNumber(stats.shadowFlats, 0) > 0 ||
    safeNumber(stats.virtualTotalR, 0) !== 0 ||
    safeNumber(stats.shadowTotalR, 0) !== 0 ||
    safeNumber(stats.virtualTotalCostR, 0) !== 0 ||
    safeNumber(stats.shadowTotalCostR, 0) !== 0
  );
}

function closedCompletedCount(stats = {}) {
  return (
    safeNumber(stats.virtualCompleted, 0) +
    safeNumber(stats.shadowCompleted, 0)
  );
}

function actualOutcomeCounts(stats = {}) {
  if (hasSourceBuckets(stats)) {
    const virtualCompleted = safeNumber(stats.virtualCompleted, 0);
    const shadowCompleted = safeNumber(stats.shadowCompleted, 0);

    const virtualWins = safeNumber(stats.virtualWins, 0);
    const virtualLosses = safeNumber(stats.virtualLosses, 0);
    const virtualFlats = safeNumber(stats.virtualFlats, 0);

    const shadowWins = safeNumber(stats.shadowWins, 0);
    const shadowLosses = safeNumber(stats.shadowLosses, 0);
    const shadowFlats = safeNumber(stats.shadowFlats, 0);

    const completed = virtualCompleted + shadowCompleted;
    const bucketCompleted =
      virtualWins +
      virtualLosses +
      virtualFlats +
      shadowWins +
      shadowLosses +
      shadowFlats;

    const inferredFlats = Math.max(0, completed - bucketCompleted);

    return {
      wins: virtualWins + shadowWins,
      losses: virtualLosses + shadowLosses,
      flats: virtualFlats + shadowFlats + inferredFlats,
      completed: Math.max(completed, bucketCompleted)
    };
  }

  return {
    wins: safeNumber(stats.wins, 0),
    losses: safeNumber(stats.losses, 0),
    flats: safeNumber(stats.flats, 0),
    completed: safeNumber(stats.completed, 0)
  };
}

function weightedCompletedCount(stats = {}) {
  const virtualCompleted = safeNumber(stats.virtualCompleted, 0);
  const shadowCompleted = safeNumber(stats.shadowCompleted, 0);

  return virtualCompleted + shadowCompleted * shadowWeight();
}

function weightedSourceCounts(stats = {}) {
  const w = shadowWeight();

  return {
    wins:
      safeNumber(stats.virtualWins, 0) +
      safeNumber(stats.shadowWins, 0) * w,

    losses:
      safeNumber(stats.virtualLosses, 0) +
      safeNumber(stats.shadowLosses, 0) * w,

    flats:
      safeNumber(stats.virtualFlats, 0) +
      safeNumber(stats.shadowFlats, 0) * w,

    completed:
      safeNumber(stats.virtualCompleted, 0) +
      safeNumber(stats.shadowCompleted, 0) * w
  };
}

function weightedSourceTotals(stats = {}) {
  const w = shadowWeight();

  return {
    totalR:
      safeNumber(stats.virtualTotalR, 0) +
      safeNumber(stats.shadowTotalR, 0) * w,

    totalPnlPct:
      safeNumber(stats.virtualTotalPnlPct, 0) +
      safeNumber(stats.shadowTotalPnlPct, 0) * w,

    totalCostR:
      safeNumber(stats.virtualTotalCostR, 0) +
      safeNumber(stats.shadowTotalCostR, 0) * w,

    grossWinR:
      safeNumber(stats.virtualGrossWinR, 0) +
      safeNumber(stats.shadowGrossWinR, 0) * w,

    grossLossR:
      safeNumber(stats.virtualGrossLossR, 0) +
      safeNumber(stats.shadowGrossLossR, 0) * w
  };
}

function isSlExitReason(value = '') {
  const reason = upper(value);

  return [
    'SL',
    'HIT_SL',
    'STOP',
    'STOP_LOSS',
    'STOPLOSS',
    'STOPPED',
    'HIT_STOP',
    'HARD_SL',
    'DIRECT_SL'
  ].includes(reason) ||
    reason.includes('STOP_LOSS') ||
    reason.includes('STOPLOSS') ||
    reason.includes('HIT_SL') ||
    reason.includes('DIRECT_SL');
}

function isDirectSL(row = {}) {
  if (
    row.directToSL === true ||
    row.directSL === true ||
    row.directStopLoss === true ||
    row.isDirectSL === true
  ) {
    return true;
  }

  if (!isSlExitReason(row.exitReason || row.reason)) {
    return false;
  }

  if (
    row.nearTpSeen === true ||
    row.reachedHalfR === true ||
    row.reachedOneR === true
  ) {
    return false;
  }

  const mfeR = safeNumber(row.mfeR, 0);
  const maeR = safeNumber(row.maeR, 0);

  return mfeR < 0.25 || maeR <= -0.8;
}

function inferCostR(row = {}, exitR = 0) {
  const explicit = finiteOrNull(
    row.costR ??
      row.avgCostR ??
      row.estimatedCostR ??
      row.netCostR
  );

  if (explicit !== null && explicit >= 0) {
    return explicit;
  }

  const grossR = finiteOrNull(
    row.grossR ??
      row.rawR ??
      row.realizedGrossR
  );

  if (grossR !== null) {
    return Math.max(0, grossR - safeNumber(exitR, 0));
  }

  const costPct = finiteOrNull(row.costPct);
  const riskPct = finiteOrNull(row.riskPct);

  if (costPct !== null && riskPct !== null && riskPct > 0) {
    return Math.max(0, costPct / riskPct);
  }

  return 0;
}

function normalizeDedupeKey(value = '') {
  return String(value || '')
    .trim()
    .toUpperCase()
    .slice(0, 240);
}

function observationDedupeKey(row = {}) {
  const direct = normalizeDedupeKey(
    row.observationDedupeKey ||
      row.observationKey ||
      row.obsKey ||
      row.dedupeKey ||
      ''
  );

  if (direct) return direct;

  const microId = rowMicroId(row);
  const snapshotId = normalizeDedupeKey(row.snapshotId || row.scanId || row.batchId || '');
  const symbol = normalizeDedupeKey(row.symbol || row.baseSymbol || row.contractSymbol || '');
  const entry = safeNumber(row.entry || row.entryPrice, 0);

  if (!microId || !symbol) return '';

  if (snapshotId) {
    return normalizeDedupeKey(`${snapshotId}|${symbol}|${microId}|${entry || 'NO_ENTRY'}`);
  }

  return normalizeDedupeKey(`NO_SNAPSHOT|${symbol}|${microId}|${entry || 'NO_ENTRY'}`);
}

function observationAlreadySeen(stats = {}, key = '') {
  const normalized = normalizeDedupeKey(key);

  if (!normalized) return false;

  const keys = Array.isArray(stats.observationDedupeKeys)
    ? stats.observationDedupeKeys
    : [];

  return keys.includes(normalized);
}

function rememberObservationKey(stats = {}, key = '') {
  const normalized = normalizeDedupeKey(key);

  if (!normalized) return stats;

  const keys = Array.isArray(stats.observationDedupeKeys)
    ? stats.observationDedupeKeys
    : [];

  keys.push(normalized);

  stats.observationDedupeKeys = [...new Set(keys)].slice(-observationDedupeCacheLimit());
  stats.lastObservationDedupeKey = normalized;

  return stats;
}

function observationIsDuplicate(stats = {}, row = {}) {
  if (
    row.observationDuplicate === true ||
    row.observationAlreadyCounted === true ||
    row.observationCounted === false ||
    row.countObservation === false ||
    row.skipObservationCount === true ||
    row.observationSkipped === true
  ) {
    return true;
  }

  const key = observationDedupeKey(row);

  return Boolean(key && observationAlreadySeen(stats, key));
}

function outcomeIsDuplicate(row = {}) {
  return (
    row.outcomeDuplicate === true ||
    row.outcomeAlreadyRecorded === true ||
    row.outcomeCounted === false ||
    row.countOutcome === false ||
    row.skipOutcomeCount === true ||
    row.outcomeSkipped === true
  );
}

function aggregateRecentOutcomes(stats = {}) {
  const statsId = rowMicroId(stats);

  const outcomes = Array.isArray(stats.recentOutcomes)
    ? stats.recentOutcomes.filter(isLongRow)
    : [];

  return outcomes.reduce(
    (acc, row) => {
      const src = normalizeSource(row.source);

      if (src !== SOURCE_VIRTUAL && src !== SOURCE_SHADOW) {
        return acc;
      }

      const rowId = rowMicroId(row);

      if (statsId && rowId && rowId !== statsId) {
        return acc;
      }

      const weight = sourceWeight(src);

      const exitR = safeNumber(row.netR ?? row.exitR ?? row.realizedNetR ?? row.realizedR ?? row.r, 0);
      const pnlPct = safeNumber(row.netPnlPct ?? row.pnlPct, 0);
      const costR = inferCostR(row, exitR);

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

      if (isDirectSL(row)) acc.directSLCount += weight;
      if (row.nearTpSeen) acc.nearTpCount += weight;
      if (row.reachedHalfR) acc.reachedHalfRCount += weight;
      if (row.reachedOneR) acc.reachedOneRCount += weight;

      if (row.beWouldExit) acc.beWouldExitCount += weight;
      if (row.gaveBackAfterHalfR) acc.gaveBackAfterHalfRCount += weight;
      if (row.gaveBackAfterOneR) acc.gaveBackAfterOneRCount += weight;
      if (row.nearTpThenLoss) acc.nearTpThenLossCount += weight;

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
      grossLossR: 0,

      directSLCount: 0,
      nearTpCount: 0,
      reachedHalfRCount: 0,
      reachedOneRCount: 0,

      beWouldExitCount: 0,
      gaveBackAfterHalfRCount: 0,
      gaveBackAfterOneRCount: 0,
      nearTpThenLossCount: 0
    }
  );
}

function maxPositive(...values) {
  return Math.max(0, ...values.map((value) => positive(value)));
}

function chooseTotal({
  sourceValue,
  storedValue,
  recentValue,
  sourceCompleted,
  storedCompleted,
  recentCompleted,
  allowRecentFallback = true
}) {
  if (sourceCompleted > 0) return safeNumber(sourceValue, 0);
  if (storedCompleted > 0) return safeNumber(storedValue, 0);
  if (allowRecentFallback && recentCompleted > 0) return safeNumber(recentValue, 0);

  return safeNumber(storedValue ?? sourceValue ?? recentValue, 0);
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

function learningStatus(stats = {}) {
  const completed = safeNumber(stats.completed, 0);

  if (completed <= 0) return 'OBSERVING';
  if (completed < MIN_COMPLETED_ACTIVE) return 'EARLY_OUTCOMES';

  return 'ACTIVE_LEARNING';
}

export function createMicroStats({
  microFamilyId,
  familyId,
  side = TARGET_DASHBOARD_SIDE,
  tradeSide = TARGET_TRADE_SIDE,
  definitionParts = []
} = {}) {
  const ts = now();

  const parsed = parseLongTaxonomyMicroId(microFamilyId);
  const resolvedMicroFamilyId = parsed.isChild
    ? parsed.childTrueMicroFamilyId
    : String(microFamilyId || '').trim().toUpperCase();

  const parentTrueMicroFamilyId = parsed.parentTrueMicroFamilyId || null;

  const inferredTradeSide = inferTradeSide({
    microFamilyId: resolvedMicroFamilyId,
    familyId,
    side,
    tradeSide,
    definitionParts
  });

  const cleanTradeSide = inferredTradeSide === TARGET_TRADE_SIDE
    ? TARGET_TRADE_SIDE
    : normalizeTradeSide(tradeSide || side);

  const isLong = cleanTradeSide === TARGET_TRADE_SIDE;
  const isChild = parsed.isChild === true;

  return {
    microFamilyId: resolvedMicroFamilyId,
    trueMicroFamilyId: resolvedMicroFamilyId,
    childTrueMicroFamilyId: isChild ? resolvedMicroFamilyId : null,
    analyzeMicroFamilyId: resolvedMicroFamilyId,
    learningMicroFamilyId: resolvedMicroFamilyId,

    coarseMicroFamilyId: parentTrueMicroFamilyId,
    baseMicroFamilyId: parentTrueMicroFamilyId,
    legacyMicroFamilyId: parentTrueMicroFamilyId,

    parentTrueMicroFamilyId,
    parentMacroFamilyId: parentTrueMicroFamilyId,
    parentMicroFamilyId: parentTrueMicroFamilyId,
    macroFamilyId: parentTrueMicroFamilyId,

    familyId,

    side: isLong ? TARGET_DASHBOARD_SIDE : 'unknown',
    tradeSide: isLong ? TARGET_TRADE_SIDE : null,
    positionSide: isLong ? TARGET_TRADE_SIDE : null,
    direction: isLong ? TARGET_TRADE_SIDE : null,

    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_SCANNER_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    source: SOURCE_VIRTUAL,

    schema: TRUE_MICRO_SCHEMA,
    microFamilySchema: TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

    setupType: parsed.setupType || null,
    regimeBucket: parsed.regimeBucket || null,
    confirmationProfile: parsed.confirmationProfile || null,
    fixedTaxonomyLearningId: isChild,
    fixedTaxonomyBaseId: parentTrueMicroFamilyId,
    selectableChild: isChild,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    exactTrueMicroFamilyRequired: true,
    selectionGranularity: 'EXACT_75_CHILD',
    parentSelectionAllowed: false,

    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,

    definitionParts,
    definition: definitionParts.join(' | '),

    seen: 0,
    observations: 0,
    observationDuplicateSkippedCount: 0,
    observationDedupeKeys: [],
    observationAlwaysCounted: false,

    virtualCompleted: 0,
    realCompleted: 0,
    shadowCompleted: 0,
    completed: 0,
    winrateSample: 0,

    wins: 0,
    losses: 0,
    flats: 0,

    virtualWins: 0,
    virtualLosses: 0,
    virtualFlats: 0,

    realWins: 0,
    realLosses: 0,
    realFlats: 0,

    shadowWins: 0,
    shadowLosses: 0,
    shadowFlats: 0,

    totalR: 0,
    virtualTotalR: 0,
    realTotalR: 0,
    shadowTotalR: 0,

    totalPnlPct: 0,
    virtualTotalPnlPct: 0,
    realTotalPnlPct: 0,
    shadowTotalPnlPct: 0,

    totalCostR: 0,
    virtualTotalCostR: 0,
    realTotalCostR: 0,
    shadowTotalCostR: 0,

    grossWinR: 0,
    grossLossR: 0,

    virtualGrossWinR: 0,
    virtualGrossLossR: 0,
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

    costStatsInferredFromRecent: false,
    directSLStatsInferredFromRecent: false,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,

    executionFingerprintRole: 'METADATA_ONLY',
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    completedOnlyClosedVirtualOrShadow: true,
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,
    avgCostRSource: 'costR',

    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    seenDefinition: 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY',
    observationDedupeRequired: true,

    defaultRanking: 'dashboardBalancedScore|balancedScore|fairWinrate|totalR|avgR|avgCostR',
    bareWinrateRankingDisabled: true,
    rawWinrateRankingDisabled: true,
    rankingUsesBalancedScore: true,
    rankingUsesFairWinrate: true,
    rankingUsesTotalR: true,
    rankingUsesAvgR: true,
    rankingUsesAvgCostR: true,

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    learningRemainsBroad: true,
    selectionWillBeAdaptive: true,
    discordWillBeStrict: true,

    adaptiveLayerBuilt: false,
    adaptiveScoreBuilt: false,
    recentMomentumScoreBuilt: false,
    currentFitScoreBuilt: false,
    parentDiversificationBuilt: false,

    learningStatus: 'OBSERVING',
    status: 'OBSERVING',
    awaitingOutcomes: true,
    tooEarly: true,
    minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE,

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

  stats.examples = Array.isArray(stats.examples) ? stats.examples.filter(isLongRow) : [];
  stats.recentOutcomes = Array.isArray(stats.recentOutcomes)
    ? stats.recentOutcomes.filter(isLongRow)
    : [];

  stats.definitionParts = Array.isArray(stats.definitionParts)
    ? stats.definitionParts
    : [];

  stats.observationDedupeKeys = Array.isArray(stats.observationDedupeKeys)
    ? stats.observationDedupeKeys.map(normalizeDedupeKey).filter(Boolean).slice(-observationDedupeCacheLimit())
    : [];

  stats.definition ||= stats.definitionParts.join(' | ');

  stats.longOnly = true;
  stats.shortDisabled = true;
  stats.shortOnly = false;
  stats.longDisabled = false;
  stats.source ||= SOURCE_VIRTUAL;

  stats.minCompletedForActiveLearning = MIN_COMPLETED_ACTIVE;

  applySideIdentity(stats);

  const numericFields = [
    'seen',
    'observations',
    'observationDuplicateSkippedCount',
    'outcomeDuplicateSkippedCount',

    'virtualCompleted',
    'realCompleted',
    'shadowCompleted',
    'completed',
    'winrateSample',

    'wins',
    'losses',
    'flats',

    'virtualWins',
    'virtualLosses',
    'virtualFlats',

    'realWins',
    'realLosses',
    'realFlats',

    'shadowWins',
    'shadowLosses',
    'shadowFlats',

    'totalR',
    'virtualTotalR',
    'realTotalR',
    'shadowTotalR',

    'totalPnlPct',
    'virtualTotalPnlPct',
    'realTotalPnlPct',
    'shadowTotalPnlPct',

    'totalCostR',
    'virtualTotalCostR',
    'realTotalCostR',
    'shadowTotalCostR',

    'grossWinR',
    'grossLossR',

    'virtualGrossWinR',
    'virtualGrossLossR',
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

  stats.realCompleted = 0;
  stats.realWins = 0;
  stats.realLosses = 0;
  stats.realFlats = 0;
  stats.realTotalR = 0;
  stats.realTotalPnlPct = 0;
  stats.realTotalCostR = 0;
  stats.realGrossWinR = 0;
  stats.realGrossLossR = 0;

  stats.currentFitSoftOnly = true;
  stats.currentFitBlocksLearning = false;
  stats.learningRemainsBroad = true;
  stats.selectionWillBeAdaptive = true;
  stats.discordWillBeStrict = true;

  stats.adaptiveLayerBuilt = false;
  stats.adaptiveScoreBuilt = false;
  stats.recentMomentumScoreBuilt = false;
  stats.currentFitScoreBuilt = false;
  stats.parentDiversificationBuilt = false;

  stats.createdAt ||= now();
  stats.updatedAt ||= now();

  return stats;
}

export function updateObservation(stats, row = {}) {
  ensureStatsShape(stats);

  if (!isLongRow({ ...stats, ...row })) {
    return stats;
  }

  applySideIdentity(stats, row);

  const dedupeKey = observationDedupeKey({
    ...stats,
    ...row
  });

  if (observationIsDuplicate(stats, row)) {
    stats.observationDuplicateSkippedCount = safeNumber(stats.observationDuplicateSkippedCount, 0) + 1;
    stats.observationDuplicateLastSkippedAt = now();
    stats.lastObservationDedupeKey = dedupeKey || stats.lastObservationDedupeKey || null;
    stats.observationRecorded = false;
    stats.observationDuplicate = true;
    stats.observationAlwaysCounted = false;
    stats.updatedAt = now();

    stats.learningStatus = learningStatus(stats);
    stats.status = stats.learningStatus;
    stats.awaitingOutcomes = safeNumber(stats.completed, 0) <= 0 && safeNumber(stats.seen, 0) > 0;
    stats.tooEarly = safeNumber(stats.completed, 0) < MIN_COMPLETED_ACTIVE;

    return stats;
  }

  if (dedupeKey) {
    rememberObservationKey(stats, dedupeKey);
  }

  stats.seen = safeNumber(stats.seen, 0) + 1;
  stats.observations = safeNumber(stats.observations, 0) + 1;
  stats.observationRecorded = true;
  stats.observationDuplicate = false;
  stats.observationAlwaysCounted = false;

  inc(stats.counters.rsiZone, row.rsiZone);
  inc(stats.counters.flow, row.flow);
  inc(stats.counters.obRelation, row.obRelation);
  inc(stats.counters.btcState, row.btcState ?? row.btcRelation);
  inc(stats.counters.regime, row.regime);
  inc(stats.counters.scannerReason, row.scannerReason);

  if (stats.examples.length < 20) {
    const microId = rowMicroId(row) || stats.microFamilyId || null;
    const parsed = parseLongTaxonomyMicroId(microId);
    const parentId = parsed.parentTrueMicroFamilyId || rowParentTrueMicroId(row) || stats.parentTrueMicroFamilyId || null;

    stats.examples.push({
      symbol: row.symbol || null,
      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      source: row.source || SOURCE_VIRTUAL,

      microFamilyId: microId,
      trueMicroFamilyId: microId,
      childTrueMicroFamilyId: parsed.childTrueMicroFamilyId || microId,
      parentTrueMicroFamilyId: parentId,
      coarseMicroFamilyId: parentId,

      setupType: row.setupType || stats.setupType || parsed.setupType || null,
      regimeBucket: row.regimeBucket || stats.regimeBucket || parsed.regimeBucket || null,
      confirmationProfile: row.confirmationProfile || stats.confirmationProfile || parsed.confirmationProfile || null,

      scannerMicroFamilyId: row.scannerMicroFamilyId || null,
      scannerFingerprintRole: row.scannerFingerprintRole || 'METADATA_ONLY',

      rsiZone: row.rsiZone || null,
      flow: row.flow || null,
      obRelation: row.obRelation || null,
      btcState: row.btcState || null,
      btcRelation: row.btcRelation || null,
      regime: row.regime || null,
      scannerReason: row.scannerReason || null,

      observationDedupeKey: dedupeKey || null,
      observationRecorded: true,
      observationDuplicate: false,
      observationAlwaysCounted: false,

      isMirrorMicroFamily: false,
      observationMirror: false,
      mirrorOfSide: null,

      trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
      childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
      parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
      learningGranularity: LEARNING_GRANULARITY,

      ts: row.createdAt || row.ts || now()
    });
  }

  stats.learningStatus = learningStatus(stats);
  stats.status = stats.learningStatus;
  stats.awaitingOutcomes = safeNumber(stats.completed, 0) <= 0 && safeNumber(stats.seen, 0) > 0;
  stats.tooEarly = safeNumber(stats.completed, 0) < MIN_COMPLETED_ACTIVE;

  stats.updatedAt = now();

  return stats;
}

export function updateOutcome(stats, row = {}, source = SOURCE_VIRTUAL) {
  ensureStatsShape(stats);

  if (!isLongRow({ ...stats, ...row })) {
    return refreshStats(stats);
  }

  applySideIdentity(stats, row);

  if (outcomeIsDuplicate(row)) {
    stats.outcomeDuplicateSkippedCount = safeNumber(stats.outcomeDuplicateSkippedCount, 0) + 1;
    stats.outcomeDuplicateLastSkippedAt = now();
    stats.updatedAt = now();

    return refreshStats(stats);
  }

  const statsId = rowMicroId(stats);
  const rowId = rowMicroId(row);

  if (statsId && rowId && statsId !== rowId) {
    return refreshStats(stats);
  }

  const src = normalizeSource(source || row.source || SOURCE_VIRTUAL);

  if (src !== SOURCE_VIRTUAL && src !== SOURCE_SHADOW) {
    return refreshStats(stats);
  }

  const weight = sourceWeight(src);

  const exitR = safeNumber(
    row.netR ??
      row.exitR ??
      row.realizedNetR ??
      row.realizedR ??
      row.r,
    0
  );

  const pnlPct = safeNumber(row.netPnlPct ?? row.pnlPct, 0);
  const costR = inferCostR(row, exitR);

  const win = exitR > 0;
  const loss = exitR < 0;
  const flat = !win && !loss;

  if (src === SOURCE_SHADOW) {
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
    stats.virtualCompleted += 1;
    stats.virtualTotalR += exitR;
    stats.virtualTotalPnlPct += pnlPct;
    stats.virtualTotalCostR += costR;

    if (win) {
      stats.virtualWins += 1;
      stats.virtualGrossWinR += exitR;
    }

    if (loss) {
      stats.virtualLosses += 1;
      stats.virtualGrossLossR += Math.abs(exitR);
    }

    if (flat) stats.virtualFlats += 1;
  }

  stats.completed = closedCompletedCount(stats);

  stats.wins += win ? weight : 0;
  stats.losses += loss ? weight : 0;
  stats.flats += flat ? weight : 0;

  stats.totalR += exitR * weight;
  stats.totalPnlPct += pnlPct * weight;
  stats.totalCostR += costR * weight;

  if (win) stats.grossWinR += exitR * weight;
  if (loss) stats.grossLossR += Math.abs(exitR) * weight;

  const directSL = isDirectSL(row);

  if (directSL) stats.directSLCount += weight;
  if (row.nearTpSeen) stats.nearTpCount += weight;
  if (row.reachedHalfR) stats.reachedHalfRCount += weight;
  if (row.reachedOneR) stats.reachedOneRCount += weight;

  if (row.beWouldExit) stats.beWouldExitCount += weight;
  if (row.gaveBackAfterHalfR) stats.gaveBackAfterHalfRCount += weight;
  if (row.gaveBackAfterOneR) stats.gaveBackAfterOneRCount += weight;
  if (row.nearTpThenLoss) stats.nearTpThenLossCount += weight;

  const parsed = parseLongTaxonomyMicroId(rowId || statsId);
  const parentId = parsed.parentTrueMicroFamilyId || rowParentTrueMicroId(row) || stats.parentTrueMicroFamilyId || null;

  stats.recentOutcomes.push({
    source: src,
    symbol: row.symbol || null,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,

    microFamilyId: rowId || stats.microFamilyId || null,
    trueMicroFamilyId: rowId || stats.trueMicroFamilyId || stats.microFamilyId || null,
    childTrueMicroFamilyId: parsed.childTrueMicroFamilyId || rowId || stats.childTrueMicroFamilyId || null,
    parentTrueMicroFamilyId: parentId,
    coarseMicroFamilyId: parentId,

    setupType: row.setupType || stats.setupType || parsed.setupType || null,
    regimeBucket: row.regimeBucket || stats.regimeBucket || parsed.regimeBucket || null,
    confirmationProfile: row.confirmationProfile || stats.confirmationProfile || parsed.confirmationProfile || null,

    exitReason: row.exitReason || row.reason || null,

    exitR,
    netR: safeNumber(row.netR ?? exitR, exitR),
    grossR: safeNumber(row.grossR ?? row.rawR ?? row.realizedGrossR, 0),

    pnlPct,
    netPnlPct: safeNumber(row.netPnlPct ?? pnlPct, pnlPct),
    grossPnlPct: safeNumber(row.grossPnlPct, 0),

    costR,
    avgCostR: costR,
    costPct: safeNumber(row.costPct, 0),
    feePct: safeNumber(row.feePct, 0),
    slippagePct: safeNumber(row.slippagePct, 0),

    mfeR: safeNumber(row.mfeR, 0),
    maeR: safeNumber(row.maeR, 0),

    directToSL: directSL,
    directSL,
    nearTpSeen: Boolean(row.nearTpSeen),
    reachedHalfR: Boolean(row.reachedHalfR),
    reachedOneR: Boolean(row.reachedOneR),

    beArmed: Boolean(row.beArmed),
    beWouldExit: Boolean(row.beWouldExit),
    beExitR: safeNumber(row.beExitR, 0),

    gaveBackAfterHalfR: Boolean(row.gaveBackAfterHalfR),
    gaveBackAfterOneR: Boolean(row.gaveBackAfterOneR),
    nearTpThenLoss: Boolean(row.nearTpThenLoss),

    entryMarketWeather: row.entryMarketWeather || null,
    entryCurrentRegime: row.entryCurrentRegime || row.currentRegime || null,
    entryCurrentTrendSide: row.entryCurrentTrendSide || row.currentTrendSide || null,
    entryCurrentFit: row.entryCurrentFit ?? row.currentFit ?? null,
    entryCurrentFitConfidence: safeNumber(row.entryCurrentFitConfidence ?? row.currentMarketFitConfidence, null),
    entryWeatherFitMatchedFamily: row.entryWeatherFitMatchedFamily ?? null,

    isMirrorMicroFamily: false,
    outcomeMirror: false,
    mirrorOfSide: null,

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,

    ts: row.closedAt || row.completedAt || now()
  });

  stats.recentOutcomes = stats.recentOutcomes.slice(-50);
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

  const hasBuckets = hasSourceBuckets(stats);
  const sourceCounts = weightedSourceCounts(stats);
  const sourceTotals = weightedSourceTotals(stats);
  const recent = aggregateRecentOutcomes(stats);

  const actualCounts = actualOutcomeCounts(stats);

  const closedCompleted = hasBuckets
    ? closedCompletedCount(stats)
    : Math.max(
      safeNumber(stats.completed, 0),
      actualCounts.completed,
      recent.actualCompleted
    );

  const weightedCompletedForR = hasBuckets
    ? weightedCompletedCount(stats)
    : Math.max(
      safeNumber(stats.completed, 0),
      sourceCounts.completed,
      recent.completed
    );

  const weightedWins = hasBuckets
    ? sourceCounts.wins
    : Math.max(
      safeNumber(stats.wins, 0),
      recent.wins
    );

  const weightedLosses = hasBuckets
    ? sourceCounts.losses
    : Math.max(
      safeNumber(stats.losses, 0),
      recent.losses
    );

  const weightedFlats = hasBuckets
    ? sourceCounts.flats
    : Math.max(
      safeNumber(stats.flats, 0),
      recent.flats
    );

  const totalR = chooseTotal({
    sourceValue: sourceTotals.totalR,
    storedValue: stats.totalR,
    recentValue: recent.totalR,
    sourceCompleted: sourceCounts.completed,
    storedCompleted: safeNumber(stats.completed, 0),
    recentCompleted: recent.completed
  });

  const totalPnlPct = chooseTotal({
    sourceValue: sourceTotals.totalPnlPct,
    storedValue: stats.totalPnlPct,
    recentValue: recent.totalPnlPct,
    sourceCompleted: sourceCounts.completed,
    storedCompleted: safeNumber(stats.completed, 0),
    recentCompleted: recent.completed
  });

  let totalCostR = chooseTotal({
    sourceValue: sourceTotals.totalCostR,
    storedValue: stats.totalCostR,
    recentValue: recent.totalCostR,
    sourceCompleted: sourceCounts.completed,
    storedCompleted: safeNumber(stats.completed, 0),
    recentCompleted: recent.completed
  });

  let costStatsInferredFromRecent = false;

  if (
    weightedCompletedForR > 0 &&
    totalCostR <= 0 &&
    recent.completed > 0 &&
    recent.totalCostR > 0
  ) {
    const recentAvgCostR = recent.totalCostR / recent.completed;
    totalCostR = recentAvgCostR * weightedCompletedForR;
    costStatsInferredFromRecent = true;
  }

  const grossWinR = hasBuckets
    ? sourceTotals.grossWinR
    : maxPositive(
      stats.grossWinR,
      recent.grossWinR,
      totalR > 0 && weightedLosses <= 0 ? totalR : 0
    );

  const grossLossR = hasBuckets
    ? sourceTotals.grossLossR
    : maxPositive(
      stats.grossLossR,
      recent.grossLossR,
      totalR < 0 && weightedWins <= 0 ? Math.abs(totalR) : 0
    );

  const winrateSample = safeNumber(actualCounts.completed, 0);
  const winrateWins = safeNumber(actualCounts.wins, 0);

  const rawWinrate = winrateSample > 0
    ? winrateWins / winrateSample
    : 0;

  const bayes = bayesianWinrate(winrateWins, winrateSample);
  const wilson = wilsonLowerBound(winrateWins, winrateSample);

  const fair = winrateSample > 0
    ? wilson * 0.8 + bayes * 0.15 + rawWinrate * 0.05
    : 0;

  const reliability = sampleReliability(winrateSample);

  const avgR = weightedCompletedForR > 0
    ? totalR / weightedCompletedForR
    : 0;

  const avgPnlPct = weightedCompletedForR > 0
    ? totalPnlPct / weightedCompletedForR
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

  const directSLCount = safeNumber(stats.directSLCount, 0) > 0
    ? safeNumber(stats.directSLCount, 0)
    : recent.directSLCount;

  const directSLStatsInferredFromRecent =
    safeNumber(stats.directSLCount, 0) <= 0 && recent.directSLCount > 0;

  const nearTpCount = safeNumber(stats.nearTpCount, 0) > 0
    ? safeNumber(stats.nearTpCount, 0)
    : recent.nearTpCount;

  const reachedHalfRCount = safeNumber(stats.reachedHalfRCount, 0) > 0
    ? safeNumber(stats.reachedHalfRCount, 0)
    : recent.reachedHalfRCount;

  const reachedOneRCount = safeNumber(stats.reachedOneRCount, 0) > 0
    ? safeNumber(stats.reachedOneRCount, 0)
    : recent.reachedOneRCount;

  const beWouldExitCount = safeNumber(stats.beWouldExitCount, 0) > 0
    ? safeNumber(stats.beWouldExitCount, 0)
    : recent.beWouldExitCount;

  const gaveBackAfterHalfRCount = safeNumber(stats.gaveBackAfterHalfRCount, 0) > 0
    ? safeNumber(stats.gaveBackAfterHalfRCount, 0)
    : recent.gaveBackAfterHalfRCount;

  const gaveBackAfterOneRCount = safeNumber(stats.gaveBackAfterOneRCount, 0) > 0
    ? safeNumber(stats.gaveBackAfterOneRCount, 0)
    : recent.gaveBackAfterOneRCount;

  const nearTpThenLossCount = safeNumber(stats.nearTpThenLossCount, 0) > 0
    ? safeNumber(stats.nearTpThenLossCount, 0)
    : recent.nearTpThenLossCount;

  const directSLPct = weightedCompletedForR > 0
    ? directSLCount / weightedCompletedForR
    : 0;

  const nearTpPct = weightedCompletedForR > 0
    ? nearTpCount / weightedCompletedForR
    : 0;

  const reachedHalfRPct = weightedCompletedForR > 0
    ? reachedHalfRCount / weightedCompletedForR
    : 0;

  const reachedOneRPct = weightedCompletedForR > 0
    ? reachedOneRCount / weightedCompletedForR
    : 0;

  const beWouldExitPct = weightedCompletedForR > 0
    ? beWouldExitCount / weightedCompletedForR
    : 0;

  const gaveBackAfterHalfRPct = weightedCompletedForR > 0
    ? gaveBackAfterHalfRCount / weightedCompletedForR
    : 0;

  const gaveBackAfterOneRPct = weightedCompletedForR > 0
    ? gaveBackAfterOneRCount / weightedCompletedForR
    : 0;

  const nearTpThenLossPct = weightedCompletedForR > 0
    ? nearTpThenLossCount / weightedCompletedForR
    : 0;

  const avgCostR = weightedCompletedForR > 0
    ? totalCostR / weightedCompletedForR
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
    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    source: stats.source || SOURCE_VIRTUAL,

    completed: round4(closedCompleted),
    winrateSample: round4(winrateSample),

    wins: round4(weightedWins),
    losses: round4(weightedLosses),
    flats: round4(weightedFlats),

    totalR: round4(totalR),
    totalPnlPct: round4(totalPnlPct),
    totalCostR: round4(totalCostR),

    virtualTotalR: round4(stats.virtualTotalR),
    realTotalR: 0,
    shadowTotalR: round4(stats.shadowTotalR),

    virtualTotalPnlPct: round4(stats.virtualTotalPnlPct),
    realTotalPnlPct: 0,
    shadowTotalPnlPct: round4(stats.shadowTotalPnlPct),

    virtualTotalCostR: round4(stats.virtualTotalCostR),
    realTotalCostR: 0,
    shadowTotalCostR: round4(stats.shadowTotalCostR),

    virtualGrossWinR: round4(stats.virtualGrossWinR),
    virtualGrossLossR: round4(stats.virtualGrossLossR),
    realGrossWinR: 0,
    realGrossLossR: 0,
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

    directSLCount: round4(directSLCount),
    nearTpCount: round4(nearTpCount),
    reachedHalfRCount: round4(reachedHalfRCount),
    reachedOneRCount: round4(reachedOneRCount),

    beWouldExitCount: round4(beWouldExitCount),
    gaveBackAfterHalfRCount: round4(gaveBackAfterHalfRCount),
    gaveBackAfterOneRCount: round4(gaveBackAfterOneRCount),
    nearTpThenLossCount: round4(nearTpThenLossCount),

    directSLPct: round4(directSLPct),
    nearTpPct: round4(nearTpPct),
    reachedHalfRPct: round4(reachedHalfRPct),
    reachedOneRPct: round4(reachedOneRPct),

    beWouldExitPct: round4(beWouldExitPct),
    gaveBackAfterHalfRPct: round4(gaveBackAfterHalfRPct),
    gaveBackAfterOneRPct: round4(gaveBackAfterOneRPct),
    nearTpThenLossPct: round4(nearTpThenLossPct),

    avgCostR: round4(avgCostR),
    costStatsInferredFromRecent,
    directSLStatsInferredFromRecent,

    balancedScore: round4(balancedScore),
    dashboardBalancedScore: round4(balancedScore),

    realCompleted: 0,
    realWins: 0,
    realLosses: 0,
    realFlats: 0,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,

    executionFingerprintRole: stats.executionFingerprintRole || 'METADATA_ONLY',
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    exactTrueMicroFamilyRequired: true,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    microFamilySchema: TRUE_MICRO_SCHEMA,
    schema: TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    completedOnlyClosedVirtualOrShadow: true,
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,
    avgCostRSource: 'costR',

    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    seenDefinition: 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY',
    observationDedupeRequired: true,
    observationAlwaysCounted: false,

    defaultRanking: 'dashboardBalancedScore|balancedScore|fairWinrate|totalR|avgR|avgCostR',
    bareWinrateRankingDisabled: true,
    rawWinrateRankingDisabled: true,
    rankingUsesBalancedScore: true,
    rankingUsesFairWinrate: true,
    rankingUsesTotalR: true,
    rankingUsesAvgR: true,
    rankingUsesAvgCostR: true,

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    learningRemainsBroad: true,
    selectionWillBeAdaptive: true,
    discordWillBeStrict: true,

    adaptiveLayerBuilt: false,
    adaptiveScoreBuilt: false,
    recentMomentumScoreBuilt: false,
    currentFitScoreBuilt: false,
    parentDiversificationBuilt: false,

    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,

    tooEarly: closedCompleted < MIN_COMPLETED_ACTIVE,
    minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE,

    updatedAt: now()
  });

  applySideIdentity(stats);

  stats.learningStatus = learningStatus(stats);
  stats.status = stats.learningStatus;
  stats.awaitingOutcomes = safeNumber(stats.completed, 0) <= 0 && safeNumber(stats.seen, 0) > 0;

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

    dashboardBalancedScore: stats.balancedScore,

    tooEarly: safeNumber(stats.completed, 0) < MIN_COMPLETED_ACTIVE,
    minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE
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
    if (out[key] && typeof out[key] === 'object' && isRealAnalyzeMicroRow(out[key])) {
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
    safeNumber(b.sampleReliability, 0) - safeNumber(a.sampleReliability, 0) ||
    safeNumber(b.winrateSample, 0) - safeNumber(a.winrateSample, 0) ||
    safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
    safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
    safeNumber(a.avgCostR, 0) - safeNumber(b.avgCostR, 0) ||
    sortById(a, b)
  );
}

function compareAvgR(a, b) {
  return (
    safeNumber(b.avgRScore, 0) - safeNumber(a.avgRScore, 0) ||
    safeNumber(b.sampleAdjustedAvgR, 0) - safeNumber(a.sampleAdjustedAvgR, 0) ||
    safeNumber(b.fairWinrate, 0) - safeNumber(a.fairWinrate, 0) ||
    safeNumber(b.sampleReliability, 0) - safeNumber(a.sampleReliability, 0) ||
    safeNumber(b.winrateSample, 0) - safeNumber(a.winrateSample, 0) ||
    safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
    safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
    safeNumber(a.avgCostR, 0) - safeNumber(b.avgCostR, 0) ||
    sortById(a, b)
  );
}

function compareTotalR(a, b) {
  return (
    safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
    safeNumber(b.dashboardBalancedScore ?? b.balancedScore, 0) -
      safeNumber(a.dashboardBalancedScore ?? a.balancedScore, 0) ||
    safeNumber(b.fairWinrate, 0) - safeNumber(a.fairWinrate, 0) ||
    safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
    safeNumber(a.avgCostR, 0) - safeNumber(b.avgCostR, 0) ||
    safeNumber(b.sampleReliability, 0) - safeNumber(a.sampleReliability, 0) ||
    sortById(a, b)
  );
}

function compareBalanced(a, b) {
  return (
    safeNumber(b.dashboardBalancedScore ?? b.balancedScore, 0) -
      safeNumber(a.dashboardBalancedScore ?? a.balancedScore, 0) ||
    safeNumber(b.balancedScore, 0) - safeNumber(a.balancedScore, 0) ||
    safeNumber(b.fairWinrate, 0) - safeNumber(a.fairWinrate, 0) ||
    safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
    safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
    safeNumber(a.avgCostR, 0) - safeNumber(b.avgCostR, 0) ||
    compareWinrate(a, b)
  );
}

export function rankMicros(micros = {}, mode = 'balanced') {
  const safeMode = mode === 'winrate'
    ? 'balanced'
    : String(mode || 'balanced');

  const rows = Object.values(micros || {})
    .filter(Boolean)
    .filter(isRealAnalyzeMicroRow)
    .map((row) => refreshStats(row))
    .filter((row) => row.tradeSide === TARGET_TRADE_SIDE)
    .filter((row) => validLearningId(row.microFamilyId))
    .filter((row) => validLearningId(row.trueMicroFamilyId))
    .filter((row) => isSelectableLongChildTrueMicroId(row.trueMicroFamilyId || row.microFamilyId));

  const sorted = [...rows].sort((a, b) => {
    if (safeMode === 'totalR') {
      return compareTotalR(a, b);
    }

    if (safeMode === 'avgR') {
      return compareAvgR(a, b);
    }

    if (safeMode === 'directSL') {
      return (
        safeNumber(a.directSLPct, 0) - safeNumber(b.directSLPct, 0) ||
        safeNumber(b.dashboardBalancedScore ?? b.balancedScore, 0) -
          safeNumber(a.dashboardBalancedScore ?? a.balancedScore, 0) ||
        safeNumber(b.fairWinrate, 0) - safeNumber(a.fairWinrate, 0) ||
        safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
        safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
        safeNumber(a.avgCostR, 0) - safeNumber(b.avgCostR, 0) ||
        safeNumber(b.winrateSample, 0) - safeNumber(a.winrateSample, 0) ||
        sortById(a, b)
      );
    }

    if (safeMode === 'observed') {
      return (
        safeNumber(b.seen, 0) - safeNumber(a.seen, 0) ||
        safeNumber(b.observations, 0) - safeNumber(a.observations, 0) ||
        safeNumber(b.dashboardBalancedScore ?? b.balancedScore, 0) -
          safeNumber(a.dashboardBalancedScore ?? a.balancedScore, 0) ||
        safeNumber(b.fairWinrate, 0) - safeNumber(a.fairWinrate, 0) ||
        safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
        safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
        safeNumber(a.avgCostR, 0) - safeNumber(b.avgCostR, 0) ||
        sortById(a, b)
      );
    }

    return compareBalanced(a, b);
  });

  return sorted.map((row, index) => normalizeDashboardMicro(row, index + 1));
}

export {
  dashboardSideFromTradeSide
};