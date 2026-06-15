// ================= FILE: src/analyze/analyzeEngine.js =================
//
// LONG-only Analyze engine.
//
// Meetlat-fix:
// - avgCostR wordt gebaseerd op echte costR.
// - directSL wordt correct afgeleid en doorgegeven.
// - seen-spam wordt geblokkeerd via echte observation dedupe.
// - completed = alleen gesloten virtual/shadow outcomes.
// - scoring gebruikt netR na kosten.
// - wins/losses/flats worden bepaald op netR.
//
// Architectuur:
// - Learning blijft breed.
// - Selection wordt later adaptief.
// - Discord wordt later streng.
// - CurrentFit is zacht en blokkeert geen virtual/shadow learning.
//
// Core identity:
// - Child:  MICRO_LONG_{SETUP}_{REGIME}_{CONFIRMATION}
// - Parent: MICRO_LONG_{SETUP}_{REGIME}
// - Scanner buckets, symbol/coin/hash and execution fingerprints are metadata only.

import { createHash } from 'crypto';
import { CONFIG } from '../config.js';
import { KEYS } from '../keys.js';
import { getDurableRedis, getJson, setJson } from '../redis.js';
import {
  safeNumber,
  sideToTradeSide
} from '../utils.js';
import {
  classifyMicroFamily,
  classifyMacroFamily,
  isMicroFamilyV1Id,
  isMicroFamilyV2Id
} from './microFamilies.js';
import {
  createMicroStats,
  updateObservation,
  updateOutcome,
  refreshStats
} from './scoring.js';
import { applyCosts } from '../trade/costModel.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const TARGET_SCANNER_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';

const OBSERVATION_SOURCE = 'VIRTUAL';
const OUTCOME_SOURCE = 'VIRTUAL';

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = TRUE_MICRO_SCHEMA;

const LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_V1';

const EXECUTION_MICRO_SUFFIX = 'XR';
const EXECUTION_MICRO_HASH_LEN = 10;

const MIN_COMPLETED_ACTIVE_LEARNING = 20;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;

const MEASUREMENT_FIX_VERSION = 'LONG_MEASUREMENT_FIX_AVGCOST_DIRECTSL_SEEN_DEDUPE_V1';
const CLASSIFIER_VERSION = 'LONG_STRICT_EVIDENCE_DISTRIBUTION_V2';

const TRUE_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'n', 'off']);

const SETUP_ORDER = Object.freeze([
  'BREAKOUT',
  'RETEST',
  'SWEEP_REVERSAL',
  'CONTINUATION',
  'COMPRESSION'
]);

const REGIME_ORDER = Object.freeze([
  'TREND',
  'CHOP',
  'SQUEEZE'
]);

const CONFIRMATION_PROFILE_ORDER = Object.freeze([
  'A_STRONG_ALIGN',
  'B_FLOW_ALIGN',
  'C_VOLUME_ALIGN',
  'D_MIXED_OK',
  'E_WEAK_CONTRA'
]);

const LONG_FIXED_SETUP_TYPES = new Set(SETUP_ORDER);
const LONG_FIXED_REGIME_BUCKETS = new Set(REGIME_ORDER);
const LONG_CONFIRMATION_PROFILES = new Set(CONFIRMATION_PROFILE_ORDER);

const REAL_VOLUME_FIELDS = Object.freeze([
  'volBucket',
  'volumeBucket',
  'volumeScore',
  'relativeVolume',
  'volumeSpike',
  'volumeConfirmed',
  'quoteVolumeSpike'
]);

const NOT_VOLUME_FIELDS = Object.freeze([
  'volatilityTier',
  'atrPct',
  'rangePct',
  'realizedVolPct',
  'volume24h',
  'tickerVolume24h',
  'candleVolume24h'
]);

const LEGACY_SETUP_ALIASES = {
  BO: 'BREAKOUT',
  BREAK: 'BREAKOUT',
  BREAK_OUT: 'BREAKOUT',
  BREAKOUT_LONG: 'BREAKOUT',

  RETEST_LONG: 'RETEST',
  PULLBACK: 'RETEST',
  PULL_BACK: 'RETEST',
  PB: 'RETEST',

  SWEEP: 'SWEEP_REVERSAL',
  SWEEP_REVERSE: 'SWEEP_REVERSAL',
  SWEEP_REVERSAL_LONG: 'SWEEP_REVERSAL',
  REVERSAL: 'SWEEP_REVERSAL',
  LIQ_SWEEP: 'SWEEP_REVERSAL',
  LIQUIDITY_SWEEP: 'SWEEP_REVERSAL',

  CONT: 'CONTINUATION',
  CONTINUATION_LONG: 'CONTINUATION',
  MOMENTUM: 'CONTINUATION',
  TREND_CONTINUATION: 'CONTINUATION',

  COMPRESS: 'COMPRESSION',
  COMPRESSION_LONG: 'COMPRESSION',
  COIL: 'COMPRESSION',
  SQUEEZE_SETUP: 'COMPRESSION'
};

const LEGACY_REGIME_ALIASES = {
  TRENDING: 'TREND',
  BULL_TREND: 'TREND',
  UPTREND: 'TREND',
  IMPULSE: 'TREND',

  RANGE: 'CHOP',
  RANGING: 'CHOP',
  SIDEWAYS: 'CHOP',
  CHOPPY: 'CHOP',
  MEAN_REVERT: 'CHOP',

  VOL_SQUEEZE: 'SQUEEZE',
  SQUEEZE_REGIME: 'SQUEEZE',
  TIGHT_RANGE: 'SQUEEZE'
};

const LEGACY_CONFIRMATION_ALIASES = {
  A: 'A_STRONG_ALIGN',
  STRONG: 'A_STRONG_ALIGN',
  STRONG_ALIGN: 'A_STRONG_ALIGN',
  FULL_ALIGN: 'A_STRONG_ALIGN',
  ALL_ALIGN: 'A_STRONG_ALIGN',
  HIGH_CONFLUENCE: 'A_STRONG_ALIGN',

  B: 'B_FLOW_ALIGN',
  FLOW: 'B_FLOW_ALIGN',
  FLOW_ALIGN: 'B_FLOW_ALIGN',
  MOMENTUM_ALIGN: 'B_FLOW_ALIGN',

  C: 'C_VOLUME_ALIGN',
  VOLUME: 'C_VOLUME_ALIGN',
  VOLUME_ALIGN: 'C_VOLUME_ALIGN',
  VOL_ALIGN: 'C_VOLUME_ALIGN',
  OB_VOLUME_ALIGN: 'C_VOLUME_ALIGN',

  D: 'D_MIXED_OK',
  MIXED: 'D_MIXED_OK',
  MIXED_OK: 'D_MIXED_OK',
  NEUTRAL_OK: 'D_MIXED_OK',

  E: 'E_WEAK_CONTRA',
  WEAK: 'E_WEAK_CONTRA',
  WEAK_CONTRA: 'E_WEAK_CONTRA',
  CONTRA: 'E_WEAK_CONTRA'
};

function now() {
  return Date.now();
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;

  const raw = String(value).trim().toLowerCase();

  if (TRUE_VALUES.has(raw)) return true;
  if (FALSE_VALUES.has(raw)) return false;

  return fallback;
}

function longKey(key, fallback = null) {
  const raw = String(key || fallback || '').trim();

  if (!raw) return null;
  if (raw.startsWith(LONG_KEY_PREFIX)) return raw;

  return `${LONG_KEY_PREFIX}${raw}`;
}

function normalizeSource(source) {
  const raw = upper(source || OUTCOME_SOURCE);

  if (raw === 'SHADOW') return 'SHADOW';
  if (raw === 'VIRTUAL') return 'VIRTUAL';

  return OUTCOME_SOURCE;
}

function obsDedupeTtlSec() {
  return Math.max(
    60,
    Math.floor(safeNumber(CONFIG?.analyze?.obsDedupeTtlSec, 60 * 60 * 24))
  );
}

function outcomeDedupeTtlSec() {
  return Math.max(
    60,
    Math.floor(safeNumber(CONFIG?.analyze?.outcomeDedupeTtlSec, 60 * 60 * 24 * 14))
  );
}

function cleanSideText(value = '') {
  return upper(value)
    .replaceAll('SHORT_DISABLED_FALSE', '')
    .replaceAll('SHORTDISABLED_FALSE', '')
    .replaceAll('BLOCK_SHORT_FALSE', '')
    .replaceAll('SHORT_ENABLED_FALSE', '')
    .replaceAll('SHORT_ONLY_FALSE', '')
    .replaceAll('LONG_DISABLED_FALSE', '')
    .replaceAll('LONGDISABLED_FALSE', '')
    .replaceAll('LONG_ENABLED_FALSE', '')
    .replaceAll('LONG_ONLY_FALSE', '')
    .replaceAll('LONG_DISABLED_SHORT_ONLY', '')
    .replaceAll('LONGDISABLED_SHORT_ONLY', '')
    .replaceAll('LONG_DISABLED', '')
    .replaceAll('LONGDISABLED', '')
    .replaceAll('LONG_ONLY_MODE', 'LONG')
    .replaceAll('LONG_ONLY', 'LONG')
    .replaceAll('LONG-ONLY', 'LONG')
    .replaceAll('SHORT_ONLY_MODE', 'SHORT')
    .replaceAll('SHORT_ONLY', 'SHORT')
    .replaceAll('SHORT-ONLY', 'SHORT');
}

function sideTextToTradeSide(value) {
  const raw = cleanSideText(value);

  if (!raw) return 'UNKNOWN';

  const direct = sideToTradeSide(raw);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  if ([
    'LONG',
    'BULL',
    'BULLISH',
    'BUY',
    'BID',
    'UP',
    'UPSIDE',
    'GREEN'
  ].includes(raw)) {
    return TARGET_TRADE_SIDE;
  }

  if ([
    'SHORT',
    'BEAR',
    'BEARISH',
    'SELL',
    'ASK',
    'DOWN',
    'DOWNSIDE',
    'RED'
  ].includes(raw)) {
    return OPPOSITE_TRADE_SIDE;
  }

  const normalized = raw
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  const longPatterns = [
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
  ];

  const shortPatterns = [
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
  ];

  const hit = (patterns) => patterns.some((pattern) => (
    normalized === pattern ||
    normalized.startsWith(`${pattern}_`) ||
    normalized.endsWith(`_${pattern}`) ||
    normalized.includes(`_${pattern}_`)
  ));

  const longHit = hit(longPatterns);
  const shortHit = hit(shortPatterns);

  if (longHit && !shortHit) return TARGET_TRADE_SIDE;
  if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;

  if (longHit && shortHit) {
    if (normalized.includes('TRADE_SIDE_LONG') || normalized.includes('TRADESIDE_LONG')) return TARGET_TRADE_SIDE;
    if (normalized.includes('TRADE_SIDE_SHORT') || normalized.includes('TRADESIDE_SHORT')) return OPPOSITE_TRADE_SIDE;
    if (normalized.includes('MICRO_LONG')) return TARGET_TRADE_SIDE;
    if (normalized.includes('MICRO_SHORT')) return OPPOSITE_TRADE_SIDE;
  }

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
    value.includes(`_${EXECUTION_MICRO_SUFFIX}_`) ||
    value.includes(`__${EXECUTION_MICRO_SUFFIX}__`) ||
    value.includes('EXECUTION_FINGERPRINT') ||
    value.includes('EXECUTION_MICRO') ||
    value.includes('EXECUTIONMICRO') ||
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

  for (const candidateRegime of REGIME_ORDER) {
    const suffix = `_${candidateRegime}`;

    if (body.endsWith(suffix)) {
      regime = candidateRegime;
      setup = body.slice(0, -suffix.length);
      break;
    }
  }

  const parentId = setup && regime ? `MICRO_LONG_${setup}_${regime}` : null;
  const childId = parentId && confirmationProfile ? `${parentId}_${confirmationProfile}` : null;

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
    setup,
    regime,
    confirmationProfile,
    parentTrueMicroFamilyId: validParent ? parentId : null,
    trueMicroFamilyId: validChild ? childId : validParent ? parentId : null,
    childTrueMicroFamilyId: validChild ? childId : null,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY
  };
}

function isFixedTaxonomyChildMicroId(id = '') {
  return parseLongTaxonomyMicroId(id).isChild === true;
}

function isFixedTaxonomyParentMicroId(id = '') {
  return parseLongTaxonomyMicroId(id).isParent === true;
}

function normalizeSymbolToken(value = '') {
  return String(value || '')
    .toUpperCase()
    .replace(/USDT|USDC|USD|PERP|SWAP|FUTURES|SPOT/g, '')
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function symbolTokensFromRow(row = {}) {
  return [
    row.symbol,
    row.baseSymbol,
    row.contractSymbol
  ]
    .map(normalizeSymbolToken)
    .filter(Boolean)
    .filter((token) => token.length >= 2);
}

function removeSymbolTokensFromFamilyId(id = '', row = {}) {
  const raw = String(id || '').trim();

  if (!raw) return raw;

  const taxonomy = parseLongTaxonomyMicroId(raw);
  if (taxonomy.valid) return upper(raw);

  const tokens = symbolTokensFromRow(row);
  if (!tokens.length) return raw;

  let next = raw;

  for (const token of tokens) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    next = next
      .replace(new RegExp(`(^|[_|:=\\-])${escaped}([_|:=\\-]|$)`, 'gi'), '$1ASSET$2')
      .replace(new RegExp(`(^|[_|:=\\-])${escaped}USDT([_|:=\\-]|$)`, 'gi'), '$1ASSET$2')
      .replace(new RegExp(`(^|[_|:=\\-])${escaped}USDC([_|:=\\-]|$)`, 'gi'), '$1ASSET$2');
  }

  return next
    .replace(/_{2,}/g, '_')
    .replace(/\|{2,}/g, '|')
    .replace(/^[_|:=\-\s]+|[_|:=\-\s]+$/g, '') || raw;
}

function isMicroFamilyV3Id(id = '') {
  const value = upper(id);

  return value.startsWith('MICRO_LONG_') && value.includes('_MF_V3_');
}

function normalizeAnalyzeFamilyId(id = '', row = {}, {
  allowParent = true,
  requireChild = false
} = {}) {
  const raw = String(id || '').trim();

  if (!raw) return '';
  if (!validLearningId(raw)) return '';

  const parsed = parseLongTaxonomyMicroId(raw);

  if (parsed.isChild) return parsed.childTrueMicroFamilyId;
  if (parsed.isParent) return requireChild ? '' : allowParent ? parsed.parentTrueMicroFamilyId : '';

  if (isMicroFamilyV1Id(raw) || isMicroFamilyV2Id(raw) || isMicroFamilyV3Id(raw)) {
    return removeSymbolTokensFromFamilyId(raw, row);
  }

  return removeSymbolTokensFromFamilyId(raw, row);
}

function normalizeChildTrueMicroFamilyId(id = '', row = {}) {
  const normalized = normalizeAnalyzeFamilyId(id, row, {
    allowParent: false,
    requireChild: true
  });

  return isFixedTaxonomyChildMicroId(normalized) ? normalized : '';
}

function normalizeParentTrueMicroFamilyId(id = '', row = {}) {
  const normalized = normalizeAnalyzeFamilyId(id, row, {
    allowParent: true,
    requireChild: false
  });

  const parsed = parseLongTaxonomyMicroId(normalized);

  if (parsed.isChild || parsed.isParent) return parsed.parentTrueMicroFamilyId;

  const child = normalizeChildTrueMicroFamilyId(
    row.trueMicroFamilyId || row.microFamilyId || row.childTrueMicroFamilyId || '',
    row
  );

  return parseLongTaxonomyMicroId(child).parentTrueMicroFamilyId || '';
}

function normalizeSetupType(value = '') {
  const raw = upper(value)
    .replace(/^LONG_/, '')
    .replace(/^MICRO_LONG_/, '')
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!raw) return null;
  if (LONG_FIXED_SETUP_TYPES.has(raw)) return raw;
  if (LEGACY_SETUP_ALIASES[raw]) return LEGACY_SETUP_ALIASES[raw];

  if (raw.includes('SWEEP') || raw.includes('REVERSAL') || raw.includes('LIQUIDITY')) return 'SWEEP_REVERSAL';
  if (raw.includes('RETEST') || raw.includes('PULLBACK') || raw.includes('PULL_BACK')) return 'RETEST';
  if (raw.includes('COMPRESSION') || raw.includes('SQUEEZE') || raw.includes('COIL')) return 'COMPRESSION';
  if (raw.includes('BREAKOUT') || raw.includes('BREAK_OUT')) return 'BREAKOUT';
  if (raw.includes('CONTINUATION') || raw.includes('MOMENTUM') || raw.includes('TREND_CONT')) return 'CONTINUATION';

  return null;
}

function normalizeRegimeBucket(value = '') {
  const raw = upper(value)
    .replace(/^LONG_/, '')
    .replace(/^MICRO_LONG_/, '')
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!raw) return null;
  if (LONG_FIXED_REGIME_BUCKETS.has(raw)) return raw;
  if (LEGACY_REGIME_ALIASES[raw]) return LEGACY_REGIME_ALIASES[raw];

  if (raw.includes('SQUEEZE') || raw.includes('TIGHT_RANGE') || raw.includes('VOL_SQUEEZE')) return 'SQUEEZE';
  if (raw.includes('CHOP') || raw.includes('RANGE') || raw.includes('SIDEWAYS')) return 'CHOP';
  if (raw.includes('TREND') || raw.includes('IMPULSE')) return 'TREND';

  return null;
}

function normalizeConfirmationProfile(value = '') {
  const raw = upper(value)
    .replace(/^CONFIRMATION_/, '')
    .replace(/^CONFIRM_/, '')
    .replace(/^PROFILE_/, '')
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!raw) return null;
  if (LONG_CONFIRMATION_PROFILES.has(raw)) return raw;
  if (LEGACY_CONFIRMATION_ALIASES[raw]) return LEGACY_CONFIRMATION_ALIASES[raw];

  for (const profile of CONFIRMATION_PROFILE_ORDER) {
    if (raw.endsWith(profile) || raw.includes(profile)) return profile;
  }

  if (raw.includes('STRONG') || raw.includes('FULL_ALIGN') || raw.includes('ALL_ALIGN')) return 'A_STRONG_ALIGN';
  if (raw.includes('FLOW') || raw.includes('MOMENTUM')) return 'B_FLOW_ALIGN';
  if (raw.includes('VOLUME') || raw.includes('VOL_') || raw.includes('OB_VOLUME')) return 'C_VOLUME_ALIGN';
  if (raw.includes('MIXED') || raw.includes('OK') || raw.includes('NEUTRAL')) return 'D_MIXED_OK';
  if (raw.includes('WEAK') || raw.includes('CONTRA')) return 'E_WEAK_CONTRA';

  return null;
}

function firstNormalizedSetup(...values) {
  for (const value of values) {
    const setup = normalizeSetupType(value);

    if (setup) return setup;
  }

  return null;
}

function firstNormalizedRegime(...values) {
  for (const value of values) {
    const regime = normalizeRegimeBucket(value);

    if (regime) return regime;
  }

  return null;
}

function exactChildIdentityFromSource(row = {}, classified = {}) {
  const candidates = [
    row.childTrueMicroFamilyId,
    row.trueMicroFamilyId,
    row.microFamilyId,
    row.analyzeMicroFamilyId,
    row.learningMicroFamilyId,
    row.fixedTaxonomyMicroFamilyId,
    classified.childTrueMicroFamilyId,
    classified.trueMicroFamilyId,
    classified.microFamilyId
  ];

  for (const candidate of candidates) {
    const parsed = parseLongTaxonomyMicroId(candidate);

    if (parsed.isChild) {
      return {
        ...parsed,
        setupType: parsed.setup,
        regimeBucket: parsed.regime,
        confirmationProfile: parsed.confirmationProfile,
        trueMicroFamilyId: parsed.childTrueMicroFamilyId,
        microFamilyId: parsed.childTrueMicroFamilyId,
        childTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
        parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
        coarseMicroFamilyId: parsed.parentTrueMicroFamilyId,
        fixedTaxonomyLearningId: true,
        source: 'EXPLICIT_EXACT_75_CHILD_ID'
      };
    }
  }

  return null;
}

function definitionText(row = {}, classified = {}) {
  return [
    row.definition,
    row.microDefinition,
    row.macroDefinition,
    row.parentDefinition,
    row.scannerReason,
    row.reason,
    row.signalReason,
    row.entryQuality,
    classified.definition,
    classified.microDefinition,
    classified.macroDefinition,
    classified.parentDefinition,
    classified.scannerReason,
    classified.reason,
    classified.signalReason,
    classified.entryQuality,
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : []),
    ...(Array.isArray(classified.definitionParts) ? classified.definitionParts : []),
    ...(Array.isArray(classified.microDefinitionParts) ? classified.microDefinitionParts : []),
    ...(Array.isArray(classified.executionFingerprintParts) ? classified.executionFingerprintParts : [])
  ]
    .map(upper)
    .filter(Boolean)
    .join('|');
}

function valueText(...values) {
  return values
    .map(upper)
    .filter(Boolean)
    .join('|');
}

function hasAnyText(text = '', needles = []) {
  const raw = upper(text);

  return needles.some((needle) => raw.includes(needle));
}

function boolish(...values) {
  return values.some((value) => bool(value, false));
}

function realVolumeEvidence(row = {}, classified = {}) {
  const text = valueText(
    row.volBucket,
    row.volumeBucket,
    classified.volBucket,
    classified.volumeBucket
  );

  const bucketVolume =
    hasAnyText(text, [
      'VOL_EXP',
      'VOLUME_EXP',
      'HIGH_VOLUME',
      'VOLUME_HIGH',
      'VOL_HIGH',
      'SPIKE',
      'SURGE',
      'EXPANSION',
      'CONFIRMED',
      'STRONG'
    ]) &&
    !hasAnyText(text, [
      'LOW',
      'NONE',
      'NO_VOLUME',
      'VOL_EXP_LOW'
    ]);

  const volumeScore = safeNumber(
    row.volumeScore ?? classified.volumeScore,
    0
  );

  const relativeVolume = safeNumber(
    row.relativeVolume ?? classified.relativeVolume,
    0
  );

  const volumeSpike = safeNumber(
    row.volumeSpike ?? classified.volumeSpike,
    0
  );

  const quoteVolumeSpike = safeNumber(
    row.quoteVolumeSpike ?? classified.quoteVolumeSpike,
    0
  );

  const confirmed = boolish(
    row.volumeConfirmed,
    row.volumeSpikeConfirmed,
    classified.volumeConfirmed,
    classified.volumeSpikeConfirmed
  );

  const scoreVolume =
    volumeScore >= 60 ||
    relativeVolume >= 1.25 ||
    volumeSpike >= 1.25 ||
    quoteVolumeSpike >= 1.25;

  const evidence = Boolean(
    confirmed ||
    bucketVolume ||
    scoreVolume
  );

  return {
    evidence,
    confirmed,
    bucketVolume,
    scoreVolume,
    volumeScore,
    relativeVolume,
    volumeSpike,
    quoteVolumeSpike,
    fieldsUsed: REAL_VOLUME_FIELDS,
    fieldsNotUsed: NOT_VOLUME_FIELDS
  };
}

function bullishFlowEvidence(row = {}, classified = {}) {
  const flowText = valueText(
    row.flow,
    row.flowCoarse,
    row.flowBucket,
    row.momentumBucket,
    row.obRelation,
    row.btcRelation,
    classified.flow,
    classified.flowCoarse,
    classified.flowBucket,
    classified.momentumBucket,
    classified.obRelation,
    classified.btcRelation
  );

  const flowScore = safeNumber(
    row.flowScore ??
      row.flowStrength ??
      row.momentumScore ??
      classified.flowScore ??
      classified.flowStrength ??
      classified.momentumScore,
    0
  );

  const positiveChange =
    safeNumber(row.change1h ?? classified.change1h, 0) > 0.15 ||
    safeNumber(row.change24h ?? classified.change24h, 0) > 0.5;

  const explicitBullish =
    hasAnyText(flowText, [
      'BULL',
      'BID',
      'WITH',
      'TREND',
      'IMPULSE',
      'BUILDING',
      'MOM_WITH',
      'FLOW_WITH',
      'OB_BID',
      'RSI_WITH',
      'FUNDING_WITH'
    ]) ||
    boolish(
      row.flowAlign,
      row.momentumAlign,
      row.bidFlowAlign,
      classified.flowAlign,
      classified.momentumAlign,
      classified.bidFlowAlign
    );

  const explicitBearish =
    hasAnyText(flowText, [
      'BEAR',
      'ASK',
      'AGAINST',
      'DOWN',
      'MOM_AGAINST',
      'FLOW_AGAINST',
      'OB_ASK',
      'RSI_AGAINST',
      'FUNDING_AGAINST'
    ]) ||
    boolish(
      row.flowAgainst,
      row.bearishFlow,
      row.askFlowAlign,
      classified.flowAgainst,
      classified.bearishFlow,
      classified.askFlowAlign
    );

  return {
    evidence: Boolean((explicitBullish || flowScore >= 55 || positiveChange) && !explicitBearish),
    explicitBullish,
    explicitBearish,
    flowScore,
    positiveChange
  };
}

function structureEvidence(row = {}, classified = {}) {
  const text = definitionText(row, classified);

  const sweep = boolish(
    row.sweepConfirmed,
    row.liquiditySweep,
    row.stopRun,
    row.reversalSetup,
    classified.sweepConfirmed,
    classified.liquiditySweep,
    classified.stopRun,
    classified.reversalSetup
  ) || hasAnyText(text, [
    'SWEEP',
    'LIQUIDITY',
    'STOP_RUN',
    'REVERSAL'
  ]);

  const retest = boolish(
    row.retestConfirmed,
    row.pullbackConfirmed,
    row.retestSetup,
    row.pullbackSetup,
    classified.retestConfirmed,
    classified.pullbackConfirmed,
    classified.retestSetup,
    classified.pullbackSetup
  ) || hasAnyText(text, [
    'RETEST',
    'PULLBACK',
    'PULL_BACK'
  ]);

  const compression = boolish(
    row.squeezeBreak,
    row.compressionBreak,
    row.volCompression,
    row.rangeCompression,
    row.compressionSetup,
    classified.squeezeBreak,
    classified.compressionBreak,
    classified.volCompression,
    classified.rangeCompression,
    classified.compressionSetup
  ) || hasAnyText(text, [
    'COMPRESSION_SETUP',
    'SQUEEZE_SETUP',
    'COIL',
    'TIGHT_RANGE_SETUP'
  ]);

  const breakout = boolish(
    row.breakoutConfirmed,
    row.breakoutSetup,
    row.newHighBreakout,
    classified.breakoutConfirmed,
    classified.breakoutSetup,
    classified.newHighBreakout
  ) || (
    hasAnyText(text, ['BREAKOUT', 'BREAK_OUT', 'VALID_BREAKOUT']) &&
    !boolish(row.fakeBreakout, row.fakeBreakoutRisk, classified.fakeBreakout, classified.fakeBreakoutRisk)
  );

  const continuation = boolish(
    row.continuationSetup,
    row.trendContinuation,
    classified.continuationSetup,
    classified.trendContinuation
  ) || hasAnyText(text, [
    'CONTINUATION',
    'TREND_CONT',
    'MOMENTUM_CONT'
  ]);

  return {
    sweep,
    retest,
    compression,
    breakout,
    continuation,
    any: Boolean(sweep || retest || compression || breakout || continuation)
  };
}

function contraEvidence(row = {}, classified = {}) {
  const text = definitionText(row, classified);

  const btcAgainst =
    upper(row.btcRelation || classified.btcRelation) === 'BTC_AGAINST' ||
    hasAnyText(text, ['BTC_AGAINST']);

  const obAgainst =
    upper(row.obRelation || classified.obRelation) === 'AGAINST' ||
    hasAnyText(text, ['OB_REL=AGAINST', 'OB_ASK', 'ASK_HEAVY']);

  const flow = bullishFlowEvidence(row, classified);

  const hardContra = Boolean(
    boolish(
      row.avoidLong,
      row.weakContra,
      row.contraSignal,
      row.bearishDivergence,
      row.fakeBreakout,
      row.fakeBreakoutRisk,
      row.flowAgainst,
      classified.avoidLong,
      classified.weakContra,
      classified.contraSignal,
      classified.bearishDivergence,
      classified.fakeBreakout,
      classified.fakeBreakoutRisk,
      classified.flowAgainst
    ) ||
    btcAgainst ||
    obAgainst ||
    flow.explicitBearish ||
    hasAnyText(text, [
      'AVOID_LONG',
      'BEARISH_CONTRA',
      'CONTRA',
      'FAKE_BREAKOUT',
      'FAKE_RISK',
      'FLOW_AGAINST'
    ])
  );

  const softContra = Boolean(
    !hardContra &&
    (
      safeNumber(row.confluence ?? row.sniperScore ?? classified.confluence, 0) < 35 ||
      hasAnyText(text, ['WEAK', 'LOW_CONFLUENCE'])
    )
  );

  return {
    hardContra,
    softContra,
    btcAgainst,
    obAgainst,
    flowAgainst: flow.explicitBearish
  };
}

function inferSetupType(row = {}, classified = {}) {
  const exact = exactChildIdentityFromSource(row, classified);
  if (exact?.setup) return exact.setup;

  const fromFields = firstNormalizedSetup(
    classified.setupType,
    classified.setup,
    classified.longSetup,
    classified.pattern,
    row.setupType,
    row.setup,
    row.longSetup,
    row.pattern
  );

  if (fromFields) return fromFields;

  const structure = structureEvidence(row, classified);

  if (structure.sweep) return 'SWEEP_REVERSAL';
  if (structure.breakout) return 'BREAKOUT';
  if (structure.retest) return 'RETEST';
  if (structure.compression) return 'COMPRESSION';
  if (structure.continuation) return 'CONTINUATION';

  const flow = bullishFlowEvidence(row, classified);
  const text = definitionText(row, classified);

  if (flow.evidence || hasAnyText(text, ['MOMENTUM', 'TREND'])) {
    return 'CONTINUATION';
  }

  return 'CONTINUATION';
}

function inferRegimeBucket(row = {}, classified = {}) {
  const exact = exactChildIdentityFromSource(row, classified);
  if (exact?.regime) return exact.regime;

  const directRegime = firstNormalizedRegime(
    classified.regimeBucket,
    row.regimeBucket,
    classified.marketRegime,
    row.marketRegime
  );

  if (directRegime) return directRegime;

  const text = definitionText(row, classified);

  const explicitSqueeze =
    boolish(
      row.squeezeRegime,
      row.squeezeActive,
      row.volCompression,
      row.rangeCompression,
      classified.squeezeRegime,
      classified.squeezeActive,
      classified.volCompression,
      classified.rangeCompression
    ) ||
    hasAnyText(
      valueText(
        row.regime,
        row.regimeCoarse,
        row.volBucket,
        row.volumeBucket,
        classified.regime,
        classified.regimeCoarse,
        classified.volBucket,
        classified.volumeBucket,
        text
      ),
      [
        'SQUEEZE',
        'VOL_SQUEEZE',
        'TIGHT_RANGE',
        'COMPRESSION_REGIME'
      ]
    );

  if (explicitSqueeze) return 'SQUEEZE';

  const explicitChop =
    boolish(
      row.chopRegime,
      row.rangeRegime,
      row.sidewaysRegime,
      classified.chopRegime,
      classified.rangeRegime,
      classified.sidewaysRegime
    ) ||
    hasAnyText(
      valueText(
        row.regime,
        row.regimeCoarse,
        classified.regime,
        classified.regimeCoarse,
        text
      ),
      [
        'CHOP',
        'RANGE',
        'SIDEWAYS',
        'RANGING',
        'MEAN_REVERT'
      ]
    );

  if (explicitChop) return 'CHOP';

  const flow = bullishFlowEvidence(row, classified);
  const trendText =
    hasAnyText(
      valueText(
        row.regime,
        row.regimeCoarse,
        row.flow,
        row.flowCoarse,
        row.momentumBucket,
        classified.regime,
        classified.regimeCoarse,
        classified.flow,
        classified.flowCoarse,
        classified.momentumBucket,
        text
      ),
      [
        'TREND',
        'TRENDING',
        'IMPULSE',
        'MOM_WITH',
        'FLOW_WITH',
        'BUILDING'
      ]
    );

  if (flow.evidence || trendText) return 'TREND';

  return 'CHOP';
}

function inferConfirmationProfile(row = {}, classified = {}) {
  const exact = exactChildIdentityFromSource(row, classified);
  if (exact?.confirmationProfile) return exact.confirmationProfile;

  const confluence = safeNumber(
    row.confluence ??
      row.sniperScore ??
      classified.confluence ??
      classified.sniperScore,
    0
  );

  const structure = structureEvidence(row, classified);
  const flow = bullishFlowEvidence(row, classified);
  const volume = realVolumeEvidence(row, classified);
  const contra = contraEvidence(row, classified);

  if (contra.hardContra) return 'E_WEAK_CONTRA';
  if (contra.softContra && confluence < 35) return 'E_WEAK_CONTRA';

  if (structure.any && flow.evidence && volume.evidence) {
    return 'A_STRONG_ALIGN';
  }

  if (flow.evidence) {
    return 'B_FLOW_ALIGN';
  }

  if (volume.evidence) {
    return 'C_VOLUME_ALIGN';
  }

  return 'D_MIXED_OK';
}

function taxonomyMetaFromParts({ setup, regime, confirmationProfile }) {
  const parentTrueMicroFamilyId = `MICRO_LONG_${setup}_${regime}`;
  const childTrueMicroFamilyId = `${parentTrueMicroFamilyId}_${confirmationProfile}`;
  const parsed = parseLongTaxonomyMicroId(childTrueMicroFamilyId);

  return {
    ...parsed,

    setupType: setup,
    regimeBucket: regime,
    confirmationProfile,

    trueMicroFamilyId: childTrueMicroFamilyId,
    microFamilyId: childTrueMicroFamilyId,
    childTrueMicroFamilyId,

    parentTrueMicroFamilyId,
    coarseMicroFamilyId: parentTrueMicroFamilyId,
    parentMicroFamilyId: parentTrueMicroFamilyId,
    macroFamilyId: parentTrueMicroFamilyId,
    parentMacroFamilyId: parentTrueMicroFamilyId,

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,

    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

    selectionGranularity: 'EXACT_75_CHILD',
    parentSelectionAllowed: false,
    discordSelectionRule: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY',

    fixedTaxonomyLearningId: true,
    exactTrueMicroFamilyRequired: true
  };
}

function extractFixedTaxonomyMicroId(source = {}, classified = {}) {
  const exact = exactChildIdentityFromSource(source, classified);

  if (exact) {
    return taxonomyMetaFromParts({
      setup: exact.setup,
      regime: exact.regime,
      confirmationProfile: exact.confirmationProfile
    });
  }

  const setup = inferSetupType(source, classified);
  const regime = inferRegimeBucket(source, classified);
  const confirmationProfile = inferConfirmationProfile(source, classified);

  if (
    LONG_FIXED_SETUP_TYPES.has(setup) &&
    LONG_FIXED_REGIME_BUCKETS.has(regime) &&
    LONG_CONFIRMATION_PROFILES.has(confirmationProfile)
  ) {
    return taxonomyMetaFromParts({
      setup,
      regime,
      confirmationProfile
    });
  }

  return null;
}

function analyzeIdentityFlags() {
  return {
    scannerFingerprintLegacy: false,
    legacyScannerFamilyFallback: false,
    scannerFingerprintOnlyMetadata: true,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,
    old25BucketsMetadataOnly: true,
    scannerBucketsUsedAsLearningFamily: false,

    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintRole: 'METADATA_ONLY',

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    exactTrueMicroFamilyRequired: true,
    exactTrueMicroOnly: true,
    trueMicroOnly: true,

    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,

    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

    fixedTaxonomyPreferred: true,
    fixedTaxonomyLearningId: true,
    fineMicroFamilyAsMetadataOnly: true,

    parentLearningEnabled: true,
    childLearningEnabled: true,
    selectionGranularity: 'EXACT_75_CHILD',
    fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED',

    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    discordOnlyForExactTrueMicroMatch: true,
    discordSelectionRule: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY',

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    observationDedupeRequired: true,
    observationAlwaysCounted: false,
    seenDefinition: 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY',
    outcomeDedupeRequired: true,
    completedOnlyClosedVirtualOrShadow: true,

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    learningRemainsBroad: true,
    selectionWillBeAdaptive: true,
    discordWillBeStrict: true,

    statusRules: {
      OBSERVING: 'completed == 0',
      EARLY_OUTCOMES: `completed > 0 && completed < ${MIN_COMPLETED_ACTIVE_LEARNING}`,
      ACTIVE_LEARNING: `completed >= ${MIN_COMPLETED_ACTIVE_LEARNING}`
    },

    defaultRanking: 'dashboardBalancedScore|balancedScore|fairWinrate|totalR|avgR|avgCostR',
    rankingUsesBalancedScore: true,
    rankingUsesFairWinrate: true,
    rankingUsesTotalR: true,
    rankingUsesAvgR: true,
    rankingUsesAvgCostR: true,
    bareWinrateRankingDisabled: true,

    positionTimeStopMinDefault: DEFAULT_POSITION_TIME_STOP_MIN,

    validLongRiskShape: 'entry > 0 && sl < entry && entry < tp',
    longGrossRFormula: '(exitPrice - entry) / (entry - initialSl)',
    longCurrentRFormula: '(currentPrice - entry) / (entry - initialSl)',
    longExitRules: {
      tp: 'price >= tp',
      sl: 'price <= sl',
      timeStop: 'TIME_STOP'
    },

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_SCANNER_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    virtualLearning: true,
    virtualOnly: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    exchangeOrdersDisabled: true,
    noRealOrders: true,
    noExchangeOrders: true,

    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    shortRootTouched: false
  };
}

function withAnalyzeIdentityFlags(row = {}) {
  return {
    ...analyzeIdentityFlags(),
    ...row
  };
}

function directSideProbeValues(row = {}, classified = {}) {
  return [
    row.tradeSide,
    row.positionSide,
    row.direction,
    row.signalSide,
    row.intentSide,
    row.entrySide,
    row.scannerSide,
    row.actualScannerSide,
    row.analysisSide,
    row.side,
    classified.tradeSide,
    classified.positionSide,
    classified.direction,
    classified.side
  ];
}

function idSideProbeValues(row = {}, classified = {}) {
  return [
    row.familyId,
    row.family,
    row.baseFamilyId,
    row.microFamilyId,
    row.trueMicroFamilyId,
    row.childTrueMicroFamilyId,
    row.coarseMicroFamilyId,
    row.baseMicroFamilyId,
    row.legacyMicroFamilyId,
    row.id,
    row.key,
    classified.familyId,
    classified.family,
    classified.baseFamilyId,
    classified.microFamilyId,
    classified.trueMicroFamilyId,
    classified.childTrueMicroFamilyId,
    classified.coarseMicroFamilyId,
    classified.baseMicroFamilyId,
    classified.legacyMicroFamilyId,
    row.macroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId,
    row.parentFamilyId,
    row.macroId,
    classified.macroFamilyId,
    classified.parentMacroFamilyId,
    classified.parentMicroFamilyId,
    classified.parentFamilyId,
    classified.macroId
  ];
}

function definitionSideProbeValues(row = {}, classified = {}) {
  return [
    row.definition,
    row.microDefinition,
    row.macroDefinition,
    row.parentDefinition,
    classified.definition,
    classified.microDefinition,
    classified.macroDefinition,
    classified.parentDefinition,
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts : []),
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : []),
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : []),
    ...(Array.isArray(classified.definitionParts) ? classified.definitionParts : []),
    ...(Array.isArray(classified.microDefinitionParts) ? classified.microDefinitionParts : []),
    ...(Array.isArray(classified.macroDefinitionParts) ? classified.macroDefinitionParts : []),
    ...(Array.isArray(classified.parentDefinitionParts) ? classified.parentDefinitionParts : []),
    ...(Array.isArray(classified.executionFingerprintParts) ? classified.executionFingerprintParts : [])
  ];
}

function firstResolvedSide(values = []) {
  for (const value of values) {
    const side = sideTextToTradeSide(value);

    if (side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE) {
      return side;
    }
  }

  return 'UNKNOWN';
}

function resolveMixedTextSide(values = [], row = {}) {
  let hasLong = false;
  let hasShort = false;

  for (const value of values) {
    const side = sideTextToTradeSide(value);

    if (side === TARGET_TRADE_SIDE) hasLong = true;
    if (side === OPPOSITE_TRADE_SIDE) hasShort = true;
  }

  if (hasLong && !hasShort) return TARGET_TRADE_SIDE;
  if (hasShort && !hasLong) return OPPOSITE_TRADE_SIDE;

  if (hasLong && hasShort) {
    const explicitIdSide = firstResolvedSide([
      row.childTrueMicroFamilyId,
      row.trueMicroFamilyId,
      row.microFamilyId,
      row.id,
      row.key
    ]);

    if (explicitIdSide !== 'UNKNOWN') return explicitIdSide;

    if (row.longOnly === true || row.shortDisabled === true) return TARGET_TRADE_SIDE;
    if (row.shortOnly === true || row.longDisabled === true) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferTradeSide(row = {}, classified = {}) {
  const direct = firstResolvedSide(directSideProbeValues(row, classified));

  if (direct === TARGET_TRADE_SIDE || direct === OPPOSITE_TRADE_SIDE) {
    return direct;
  }

  const idSide = resolveMixedTextSide(idSideProbeValues(row, classified), row);

  if (idSide === TARGET_TRADE_SIDE || idSide === OPPOSITE_TRADE_SIDE) {
    return idSide;
  }

  const definitionSide = resolveMixedTextSide(definitionSideProbeValues(row, classified), row);

  if (definitionSide === TARGET_TRADE_SIDE || definitionSide === OPPOSITE_TRADE_SIDE) {
    return definitionSide;
  }

  if (row.longOnly === true || row.shortDisabled === true) return TARGET_TRADE_SIDE;
  if (row.shortOnly === true || row.longDisabled === true) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function isLongOnlyRow(row = {}, classified = {}) {
  return inferTradeSide(row, classified) === TARGET_TRADE_SIDE;
}

function isTargetLongSide(side) {
  return sideTextToTradeSide(side) === TARGET_TRADE_SIDE;
}

function normalizeClassificationInput(row = {}, forcedSide = null) {
  const tradeSide = forcedSide || inferTradeSide(row);

  if (tradeSide !== TARGET_TRADE_SIDE) return null;

  return withAnalyzeIdentityFlags({
    ...row,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,
    actualScannerSide: TARGET_SCANNER_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    source: row.source || OBSERVATION_SOURCE,
    virtualOnly: row.virtualOnly !== false,
    virtualTracked: row.virtualTracked !== false,
    shadowOnly: row.shadowOnly !== false,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false
  });
}

function normalizeClassifiedSide(classified = {}) {
  return withAnalyzeIdentityFlags({
    ...classified,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,
    actualScannerSide: TARGET_SCANNER_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false
  });
}

function normalizeStatsSide() {
  return TARGET_DASHBOARD_SIDE;
}

function getWeekMicrosBaseKey(weekKey) {
  return longKey(KEYS.analyze.weekMicros(weekKey), `ANALYZE:WEEK_MICROS:${weekKey}`);
}

function getWeekMetaKey(weekKey) {
  return longKey(KEYS.analyze.weekMeta(weekKey), `ANALYZE:WEEK_META:${weekKey}`);
}

function getObsLastKey(snapshotId, symbol, microFamilyId) {
  return longKey(
    KEYS.analyze.obsLast(snapshotId, symbol, microFamilyId),
    `ANALYZE:OBS_LAST:${snapshotId}:${symbol}:${microFamilyId}`
  );
}

function getOutcomeLastKey(weekKey, outcomeIdentity, microFamilyId) {
  const fromKeys =
    typeof KEYS.analyze?.outcomeLast === 'function'
      ? KEYS.analyze.outcomeLast(weekKey, outcomeIdentity, microFamilyId)
      : null;

  return longKey(
    fromKeys,
    `ANALYZE:OUTCOME_LAST:${weekKey}:${outcomeIdentity}:${microFamilyId}`
  );
}

function getWeekMicrosTopKey(weekKey) {
  return `${getWeekMicrosBaseKey(weekKey)}:TOP`;
}

async function claimDedupeKey(redis, key, ttlSec, {
  type = 'DEDUPE'
} = {}) {
  if (!key) {
    return {
      claimed: true,
      duplicate: false,
      method: 'NO_KEY',
      key: null,
      type
    };
  }

  const value = String(now());

  const setAttempts = [
    { ex: ttlSec, nx: true },
    { ex: ttlSec, NX: true },
    { EX: ttlSec, NX: true }
  ];

  for (const options of setAttempts) {
    try {
      const result = await redis.set(key, value, options);

      if (result === null || result === false) {
        return {
          claimed: false,
          duplicate: true,
          method: 'SET_NX',
          key,
          type
        };
      }

      const raw = String(result).toUpperCase();

      if (result === true || result === 1 || raw === 'OK' || raw === 'QUEUED') {
        return {
          claimed: true,
          duplicate: false,
          method: 'SET_NX',
          key,
          type
        };
      }
    } catch {
      // Try next client option shape.
    }
  }

  try {
    const existing = await redis.get(key).catch(() => null);

    if (existing !== null && existing !== undefined) {
      return {
        claimed: false,
        duplicate: true,
        method: 'GET_THEN_SET',
        key,
        type
      };
    }

    await redis.set(key, value, { ex: ttlSec }).catch(() => null);

    return {
      claimed: true,
      duplicate: false,
      method: 'GET_THEN_SET',
      key,
      type
    };
  } catch {
    return {
      claimed: true,
      duplicate: false,
      method: 'DEDUPE_UNAVAILABLE_FAIL_OPEN',
      key,
      type
    };
  }
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function mergeDefinitionParts(...groups) {
  return uniqueStrings(
    groups.flatMap((group) => {
      if (!group) return [];
      if (Array.isArray(group)) return group;

      return [group];
    })
  );
}

function truncateString(value, maxLength = 480) {
  const text = String(value ?? '');

  if (text.length <= maxLength) return text;

  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function compactDefinitionParts(parts = [], maxItems = 64, maxStringLength = 480) {
  if (!Array.isArray(parts)) return [];

  return parts
    .slice(0, maxItems)
    .map((part) => truncateString(part, maxStringLength))
    .filter(Boolean);
}

function compactExamples(examples = [], maxItems = 8, maxStringLength = 480) {
  if (!Array.isArray(examples) || maxItems <= 0) return [];

  return examples
    .slice(-maxItems)
    .map((example) => {
      if (!example || typeof example !== 'object') {
        return example ?? null;
      }

      const childId = normalizeChildTrueMicroFamilyId(
        example.trueMicroFamilyId || example.microFamilyId || example.childTrueMicroFamilyId,
        example
      );

      const parentId = normalizeParentTrueMicroFamilyId(
        example.parentTrueMicroFamilyId || example.coarseMicroFamilyId || childId,
        example
      );

      const parsed = parseLongTaxonomyMicroId(childId);

      return withAnalyzeIdentityFlags({
        symbol: example.symbol || example.baseSymbol || example.contractSymbol || null,
        side: TARGET_DASHBOARD_SIDE,
        tradeSide: TARGET_TRADE_SIDE,
        source: example.source || OBSERVATION_SOURCE,

        microFamilyId: childId || null,
        trueMicroFamilyId: childId || null,
        childTrueMicroFamilyId: childId || null,
        coarseMicroFamilyId: parentId || null,
        parentTrueMicroFamilyId: parentId || null,

        setupType: parsed.setup || example.setupType || null,
        regimeBucket: parsed.regime || example.regimeBucket || null,
        confirmationProfile: parsed.confirmationProfile || example.confirmationProfile || null,

        rsiZone: example.rsiZone || null,
        flow: example.flow || null,
        obRelation: example.obRelation || null,
        btcRelation: example.btcRelation || null,
        regime: example.regime || null,
        scannerReason: example.scannerReason || null,

        observationDedupeKey: example.observationDedupeKey || null,
        observationRecorded: Boolean(example.observationRecorded),
        observationDuplicate: Boolean(example.observationDuplicate),

        ts: safeNumber(example.ts || example.createdAt, null)
      });
    })
    .filter(Boolean)
    .map((example) => {
      if (typeof example === 'string') return truncateString(example, maxStringLength);
      return example;
    });
}

function compactRecentOutcomes(outcomes = [], maxItems = 8) {
  if (!Array.isArray(outcomes) || maxItems <= 0) return [];

  return outcomes
    .slice(-maxItems)
    .map((outcome) => {
      if (!outcome || typeof outcome !== 'object') return null;
      if (inferTradeSide(outcome) !== TARGET_TRADE_SIDE) return null;

      const childId = normalizeChildTrueMicroFamilyId(
        outcome.trueMicroFamilyId || outcome.microFamilyId || outcome.childTrueMicroFamilyId,
        outcome
      );

      if (!childId) return null;

      const parentId = normalizeParentTrueMicroFamilyId(
        outcome.parentTrueMicroFamilyId || outcome.coarseMicroFamilyId || childId,
        outcome
      );

      const parsed = parseLongTaxonomyMicroId(childId);

      return withAnalyzeIdentityFlags({
        source: normalizeSource(outcome.source || OUTCOME_SOURCE),
        positionSource: outcome.positionSource || null,

        tradeId: outcome.tradeId || null,
        outcomeDedupeKey: outcome.outcomeDedupeKey || null,

        symbol: outcome.symbol || outcome.baseSymbol || outcome.contractSymbol || null,
        contractSymbol: outcome.contractSymbol || null,

        side: TARGET_DASHBOARD_SIDE,
        tradeSide: TARGET_TRADE_SIDE,

        exitReason: outcome.exitReason || outcome.reason || null,

        exitR: safeNumber(outcome.exitR ?? outcome.netR, 0),
        netR: safeNumber(outcome.netR ?? outcome.exitR, 0),
        grossR: safeNumber(outcome.grossR, 0),

        costR: safeNumber(outcome.costR, 0),
        avgCostR: safeNumber(outcome.avgCostR ?? outcome.costR, 0),

        mfeR: safeNumber(outcome.mfeR, 0),
        maeR: safeNumber(outcome.maeR, 0),

        directToSL: Boolean(outcome.directToSL || outcome.directSL),
        directSL: Boolean(outcome.directSL || outcome.directToSL),
        nearTpSeen: Boolean(outcome.nearTpSeen),
        reachedHalfR: Boolean(outcome.reachedHalfR),
        reachedOneR: Boolean(outcome.reachedOneR),

        microFamilyId: childId,
        trueMicroFamilyId: childId,
        childTrueMicroFamilyId: childId,
        coarseMicroFamilyId: parentId,
        parentTrueMicroFamilyId: parentId,

        setupType: parsed.setup || null,
        regimeBucket: parsed.regime || null,
        confirmationProfile: parsed.confirmationProfile || null,

        entryMarketWeather: outcome.entryMarketWeather || null,
        entryCurrentRegime: outcome.entryCurrentRegime || outcome.currentRegime || null,
        entryCurrentTrendSide: outcome.entryCurrentTrendSide || outcome.currentTrendSide || null,
        entryCurrentFit: outcome.entryCurrentFit ?? outcome.currentFit ?? null,
        entryCurrentFitConfidence: safeNumber(outcome.entryCurrentFitConfidence ?? outcome.currentMarketFitConfidence, null),

        costModelApplied: Boolean(outcome.costModelApplied),
        netCostModelApplied: Boolean(outcome.netCostModelApplied),
        costModel: outcome.costModel || null,

        ts: safeNumber(
          outcome.ts ||
            outcome.closedAt ||
            outcome.completedAt ||
            outcome.updatedAt,
          now()
        )
      });
    })
    .filter(Boolean);
}

function removeKnownBulkyFields(row = {}) {
  const clean = { ...row };

  const bulkyKeys = [
    'raw',
    'payload',
    'debug',
    'request',
    'response',
    'stack',
    'html',
    'candles',
    'candles15m',
    'candles1h',
    'candles4h',
    'candles1d',
    'orderBook',
    'rawOrderBook',
    'bids',
    'asks',
    'ticks',
    'prices',
    'history',
    'marketData'
  ];

  for (const key of bulkyKeys) {
    delete clean[key];
  }

  return clean;
}

function normalizeBucketText(value, fallback = 'NA') {
  const text = String(value ?? '').trim();

  if (!text) return fallback;

  return text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || fallback;
}

function normalizeBroadBucketText(value, fallback = 'NA') {
  const text = normalizeBucketText(value, fallback);

  if (!text || text === 'NA') return fallback;

  return text
    .replace(/VERY_/g, '')
    .replace(/EXTREME_/g, '')
    .replace(/STRONG_/g, '')
    .replace(/WEAK_/g, '')
    .replace(/MIDRANGE/g, 'MID')
    .replace(/NEUTRAL/g, 'MID')
    .replace(/BALANCED/g, 'MID')
    .replace(/SIDEWAYS/g, 'RANGE')
    .slice(0, 32) || fallback;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }

  return null;
}

function hashText(value, length = EXECUTION_MICRO_HASH_LEN) {
  return createHash('sha256')
    .update(String(value || ''))
    .digest('hex')
    .toUpperCase()
    .slice(0, length);
}

function getScannerMetadata(row = {}) {
  const scannerMicroFamilyId = firstDefined(
    row.scannerMicroFamilyId,
    isScannerFingerprintId(row.trueMicroFamilyId) ? row.trueMicroFamilyId : null,
    isScannerFingerprintId(row.microFamilyId) ? row.microFamilyId : null,
    isScannerFingerprintId(row.id) ? row.id : null,
    isScannerFingerprintId(row.key) ? row.key : null
  );

  const scannerFamilyId = firstDefined(
    row.scannerFamilyId,
    isScannerFingerprintId(row.familyId) ? row.familyId : null,
    isScannerFingerprintId(row.baseFamilyId) ? row.baseFamilyId : null
  );

  const scannerDefinitionParts = Array.isArray(row.scannerDefinitionParts)
    ? row.scannerDefinitionParts
    : scannerMicroFamilyId && Array.isArray(row.definitionParts)
      ? row.definitionParts
      : [];

  const scannerDefinition = firstDefined(
    row.scannerDefinition,
    scannerMicroFamilyId ? row.definition : null,
    scannerMicroFamilyId ? row.microDefinition : null
  );

  return {
    scannerMicroFamilyId: scannerMicroFamilyId || null,
    scannerFamilyId: scannerFamilyId || null,
    scannerDefinition: scannerDefinition || null,
    scannerDefinitionParts,
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false
  };
}

function buildFixedTaxonomyDefinitionParts(row = {}, classified = {}, taxonomy = {}) {
  const volume = realVolumeEvidence(row, classified);
  const flow = bullishFlowEvidence(row, classified);
  const contra = contraEvidence(row, classified);

  return mergeDefinitionParts([
    `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
    `TRUE_MICRO=${taxonomy.trueMicroFamilyId}`,
    `PARENT_TRUE_MICRO=${taxonomy.parentTrueMicroFamilyId}`,
    `SETUP=${taxonomy.setupType}`,
    `REGIME_BUCKET=${taxonomy.regimeBucket}`,
    `CONFIRMATION_PROFILE=${taxonomy.confirmationProfile}`,

    `RSI=${normalizeBroadBucketText(classified.rsiCoarse || row.rsiCoarse || classified.rsiZone || row.rsiZone || 'NA')}`,
    `FLOW=${normalizeBroadBucketText(classified.flowCoarse || row.flowCoarse || classified.flow || row.flow || 'NA')}`,
    `OB_REL=${normalizeBroadBucketText(classified.obRelation || row.obRelation || 'NA')}`,
    `BTC_STATE=${normalizeBroadBucketText(classified.btcState || row.btcState || 'NA')}`,
    `BTC_REL=${normalizeBroadBucketText(classified.btcRelation || row.btcRelation || 'NA')}`,
    `REGIME=${normalizeBroadBucketText(classified.regimeCoarse || row.regimeCoarse || classified.regime || row.regime || taxonomy.regimeBucket || 'NA')}`,

    `STRICT_CLASSIFIER=TRUE`,
    `STRUCTURE_EVIDENCE=${structureEvidence(row, classified).any ? 'YES' : 'NO'}`,
    `FLOW_EVIDENCE=${flow.evidence ? 'YES' : 'NO'}`,
    `REAL_VOLUME_EVIDENCE=${volume.evidence ? 'YES' : 'NO'}`,
    `CONTRA_EVIDENCE=${contra.hardContra ? 'HARD' : contra.softContra ? 'SOFT' : 'NO'}`,

    'VOLUME_FIELDS_ALLOWED=volBucket,volumeBucket,volumeScore,relativeVolume,volumeSpike,volumeConfirmed,quoteVolumeSpike',
    'VOLUME_FIELDS_EXCLUDED=volatilityTier,atrPct,rangePct,realizedVolPct,volume24h',

    'CURRENT_FIT_SOFT_ONLY=true',
    'CURRENT_FIT_BLOCKS_LEARNING=false',
    'LEARNING_REMAINS_BROAD=true',
    'MEASUREMENT_FIX=avgCostR_directSL_seenDedupe'
  ]);
}

function buildParentDefinitionParts(taxonomy = {}) {
  return mergeDefinitionParts([
    `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
    `PARENT_TRUE_MICRO=${taxonomy.parentTrueMicroFamilyId}`,
    `SETUP=${taxonomy.setupType}`,
    `REGIME_BUCKET=${taxonomy.regimeBucket}`
  ]);
}

function buildExecutionFingerprintParts(row = {}, classified = {}, taxonomy = {}) {
  return mergeDefinitionParts([
    `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
    `TRUE_MICRO=${taxonomy.trueMicroFamilyId || 'NO_TRUE_MICRO'}`,
    `PARENT_TRUE_MICRO=${taxonomy.parentTrueMicroFamilyId || 'NO_PARENT_TRUE_MICRO'}`,
    `SETUP=${taxonomy.setupType || 'NA'}`,
    `REGIME_BUCKET=${taxonomy.regimeBucket || 'NA'}`,
    `CONFIRMATION_PROFILE=${taxonomy.confirmationProfile || 'NA'}`,

    `RSI=${normalizeBucketText(classified.rsiZone || row.rsiZone || 'NA')}`,
    `FLOW=${normalizeBucketText(classified.flowCoarse || row.flowCoarse || classified.flow || row.flow || 'NA')}`,
    `OB_REL=${normalizeBucketText(classified.obRelation || row.obRelation || 'NA')}`,
    `BTC_STATE=${normalizeBucketText(classified.btcState || row.btcState || 'NA')}`,
    `BTC_REL=${normalizeBucketText(classified.btcRelation || row.btcRelation || 'NA')}`,
    `REGIME=${normalizeBucketText(classified.regimeCoarse || row.regimeCoarse || classified.regime || row.regime || 'NA')}`,
    `SCANNER=${normalizeBucketText(classified.scannerReasonCoarse || row.scannerReasonCoarse || classified.scannerReason || row.scannerReason || 'NA')}`,

    `SPREAD_BPS=${normalizeBucketText(row.spreadBps ?? row.spreadPct ?? 'NA')}`,
    `DEPTH=${normalizeBucketText(row.depthMinUsd1p ?? 'NA')}`,
    `RR=${normalizeBucketText(row.rr ?? row.riskReward ?? 'NA')}`,
    `CONFLUENCE=${normalizeBucketText(row.confluence ?? row.sniperScore ?? row.scannerScore ?? 'NA')}`,
    `ENTRY_QUALITY=${normalizeBucketText(row.entryQuality || 'NA')}`,

    `FAKE_BREAKOUT=${bool(row.fakeBreakout, false) ? 'YES' : 'NO'}`,
    `FAKE_RISK=${bool(row.fakeBreakoutRisk, false) ? 'YES' : 'NO'}`,

    'EXECUTION_FINGERPRINT_ROLE=METADATA_ONLY',
    'EXECUTION_FINGERPRINT_USED_AS_LEARNING_FAMILY=false'
  ]);
}

function attachExecutionFingerprintMetadata(classified = {}, row = {}, taxonomy = {}) {
  const enabled = bool(CONFIG?.analyze?.buildExecutionFingerprintMetadata, true) === true;

  if (!enabled) {
    return withAnalyzeIdentityFlags({
      ...classified,
      executionFingerprintHash: null,
      executionFingerprintParts: [],
      executionFingerprintSchema: null,
      executionMicroFamilyId: null,
      executionFingerprintRole: 'DISABLED'
    });
  }

  const analyzeMicroFamilyId = normalizeChildTrueMicroFamilyId(
    taxonomy.trueMicroFamilyId ||
      classified.trueMicroFamilyId ||
      classified.microFamilyId,
    row
  );

  if (!analyzeMicroFamilyId) return withAnalyzeIdentityFlags(classified);

  const executionParts = buildExecutionFingerprintParts(row, classified, taxonomy);
  const executionHash = hashText(executionParts.join('|'), EXECUTION_MICRO_HASH_LEN);
  const executionMicroFamilyId = `${analyzeMicroFamilyId}_${EXECUTION_MICRO_SUFFIX}_${executionHash}`;

  return withAnalyzeIdentityFlags({
    ...classified,

    microFamilyId: analyzeMicroFamilyId,
    trueMicroFamilyId: analyzeMicroFamilyId,
    childTrueMicroFamilyId: analyzeMicroFamilyId,

    coarseMicroFamilyId: taxonomy.parentTrueMicroFamilyId,
    parentTrueMicroFamilyId: taxonomy.parentTrueMicroFamilyId,

    executionFingerprintHash: executionHash,
    executionFingerprintParts: executionParts,
    executionFingerprintSchema: EXECUTION_MICRO_SUFFIX,
    executionMicroFamilyId,
    executionFingerprintRole: 'METADATA_ONLY'
  });
}

function safeClassifyMacro(row = {}) {
  try {
    return classifyMacroFamily(row) || {};
  } catch {
    return {};
  }
}

function safeClassifyMicro(row = {}) {
  try {
    return classifyMicroFamily(row) || {};
  } catch {
    return {};
  }
}

function enrichWithMicroFamily(row = {}, { forcedSide = null } = {}) {
  const classifyInput = normalizeClassificationInput(row, forcedSide);

  if (!classifyInput) return null;

  const scannerMetadata = getScannerMetadata(classifyInput);

  const macro = normalizeClassifiedSide(safeClassifyMacro(classifyInput));
  const rawClassified = normalizeClassifiedSide({
    ...macro,
    ...safeClassifyMicro(classifyInput)
  });

  const taxonomy = extractFixedTaxonomyMicroId(
    classifyInput,
    rawClassified
  );

  if (!taxonomy || !taxonomy.trueMicroFamilyId || !taxonomy.parentTrueMicroFamilyId) {
    return null;
  }

  const classified = attachExecutionFingerprintMetadata(
    rawClassified,
    classifyInput,
    taxonomy
  );

  const trueMicroFamilyId = normalizeChildTrueMicroFamilyId(
    taxonomy.trueMicroFamilyId,
    classifyInput
  );

  if (!trueMicroFamilyId) return null;

  const parentTrueMicroFamilyId = taxonomy.parentTrueMicroFamilyId;
  const definitionParts = buildFixedTaxonomyDefinitionParts(
    classifyInput,
    classified,
    taxonomy
  );
  const parentDefinitionParts = buildParentDefinitionParts(taxonomy);

  return withAnalyzeIdentityFlags({
    ...row,

    familyId: classified.familyId || row.familyId || 'LONG_FIXED_TAXONOMY',

    microFamilyId: trueMicroFamilyId,
    trueMicroFamilyId,
    childTrueMicroFamilyId: trueMicroFamilyId,

    coarseMicroFamilyId: parentTrueMicroFamilyId,
    baseMicroFamilyId: parentTrueMicroFamilyId,
    legacyMicroFamilyId: parentTrueMicroFamilyId,

    parentTrueMicroFamilyId,
    parentMicroFamilyId: parentTrueMicroFamilyId,
    macroFamilyId: parentTrueMicroFamilyId,
    parentMacroFamilyId: parentTrueMicroFamilyId,

    fineMicroFamilyId: classified.fineMicroFamilyId || classified.narrowMicroFamilyId || classified.mfV2MicroFamilyId || null,
    narrowMicroFamilyId: classified.narrowMicroFamilyId || classified.fineMicroFamilyId || classified.mfV2MicroFamilyId || null,
    mfV2MicroFamilyId: classified.mfV2MicroFamilyId || classified.fineMicroFamilyId || classified.narrowMicroFamilyId || null,

    broadTrueMicroFamilyId: trueMicroFamilyId,
    broadTrueDefinitionParts: definitionParts,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,

    setupType: taxonomy.setupType,
    regimeBucket: taxonomy.regimeBucket,
    confirmationProfile: taxonomy.confirmationProfile,

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

    fixedTaxonomyLearningId: true,
    fineMicroFamilyAsMetadataOnly: true,

    executionFingerprintHash: classified.executionFingerprintHash || null,
    executionFingerprintParts: classified.executionFingerprintParts || [],
    executionFingerprintSchema: classified.executionFingerprintSchema || null,
    executionMicroFamilyId: classified.executionMicroFamilyId || null,
    executionFingerprintRole: classified.executionFingerprintRole || 'METADATA_ONLY',

    scannerMicroFamilyId: scannerMetadata.scannerMicroFamilyId,
    scannerFamilyId: scannerMetadata.scannerFamilyId,
    scannerDefinition: scannerMetadata.scannerDefinition,
    scannerDefinitionParts: scannerMetadata.scannerDefinitionParts,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    definitionParts,
    microDefinitionParts: definitionParts,
    definition: definitionParts.join(' | '),
    microDefinition: definitionParts.join(' | '),

    parentDefinitionParts,
    macroDefinitionParts: parentDefinitionParts,
    parentDefinition: parentDefinitionParts.join(' | '),
    macroDefinition: parentDefinitionParts.join(' | '),

    schema: TRUE_MICRO_SCHEMA,
    microFamilySchema: TRUE_MICRO_SCHEMA,
    version: 'fixed-taxonomy-75-child-smart-evidence-v2',

    classifierVersion: CLASSIFIER_VERSION,
    classifierNoDefaultRetestSqueezeB: true,

    assetClass: classified.assetClass || row.assetClass || 'CRYPTO',

    obRelation: classified.obRelation || row.obRelation,
    btcRelation: classified.btcRelation || row.btcRelation,
    btcState: classified.btcState || row.btcState,

    flow: classified.flow || row.flow,
    flowCoarse: classified.flowCoarse || row.flowCoarse,

    regime: classified.regime || row.regime,
    regimeCoarse: classified.regimeCoarse || row.regimeCoarse,

    scannerReason: classified.scannerReason || row.scannerReason,
    scannerReasonCoarse: classified.scannerReasonCoarse || row.scannerReasonCoarse,

    rsiZone: classified.rsiZone || row.rsiZone,
    rsiCoarse: classified.rsiCoarse || row.rsiCoarse,

    spreadBps: classified.spreadBps ?? row.spreadBps,

    volumeEvidence: realVolumeEvidence(classifyInput, classified),
    flowEvidence: bullishFlowEvidence(classifyInput, classified),
    structureEvidence: structureEvidence(classifyInput, classified),
    contraEvidence: contraEvidence(classifyInput, classified),

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,
    actualScannerSide: TARGET_SCANNER_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    source: row.source || OBSERVATION_SOURCE,
    virtualOnly: row.virtualOnly !== false,
    virtualTracked: row.virtualTracked !== false,
    shadowOnly: row.shadowOnly !== false,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    isMirrorMicroFamily: false,
    observationMirror: false,
    analysisMirror: false,
    mirrorAnalysisOnly: false,
    mirrorOfSide: null,

    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true
  });
}

function getLearningStatus(row = {}) {
  const completed = safeNumber(row.completed || row.outcomeSample, 0);

  if (completed >= MIN_COMPLETED_ACTIVE_LEARNING) return 'ACTIVE_LEARNING';
  if (completed > 0) return 'EARLY_OUTCOMES';

  return 'OBSERVING';
}

function compactMicroForStorage(row = {}) {
  const refreshed = refreshStats(withAnalyzeIdentityFlags(removeKnownBulkyFields(row)));

  const trueMicroFamilyId = normalizeChildTrueMicroFamilyId(
    refreshed.trueMicroFamilyId || refreshed.microFamilyId,
    refreshed
  );

  if (!trueMicroFamilyId) return null;

  const taxonomy = parseLongTaxonomyMicroId(trueMicroFamilyId);
  const parentTrueMicroFamilyId = taxonomy.parentTrueMicroFamilyId;

  const definitionParts = compactDefinitionParts(refreshed.definitionParts, 64, 480);
  const parentDefinitionParts = compactDefinitionParts(refreshed.parentDefinitionParts, 48, 480);

  return withAnalyzeIdentityFlags({
    ...refreshed,

    microFamilyId: trueMicroFamilyId,
    trueMicroFamilyId,
    childTrueMicroFamilyId: trueMicroFamilyId,

    coarseMicroFamilyId: parentTrueMicroFamilyId,
    baseMicroFamilyId: parentTrueMicroFamilyId,
    legacyMicroFamilyId: parentTrueMicroFamilyId,

    parentTrueMicroFamilyId,
    parentMicroFamilyId: parentTrueMicroFamilyId,
    macroFamilyId: parentTrueMicroFamilyId,
    parentMacroFamilyId: parentTrueMicroFamilyId,

    fineMicroFamilyId: refreshed.fineMicroFamilyId || refreshed.narrowMicroFamilyId || refreshed.mfV2MicroFamilyId || null,
    narrowMicroFamilyId: refreshed.narrowMicroFamilyId || refreshed.fineMicroFamilyId || refreshed.mfV2MicroFamilyId || null,
    mfV2MicroFamilyId: refreshed.mfV2MicroFamilyId || refreshed.fineMicroFamilyId || refreshed.narrowMicroFamilyId || null,

    broadTrueMicroFamilyId: trueMicroFamilyId,
    broadTrueDefinitionParts: compactDefinitionParts(refreshed.broadTrueDefinitionParts, 24, 480),
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,

    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

    fineMicroFamilyAsMetadataOnly: true,
    fixedTaxonomyLearningId: true,

    setupType: taxonomy.setup,
    regimeBucket: taxonomy.regime,
    confirmationProfile: taxonomy.confirmationProfile,

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

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    executionFingerprintRole: refreshed.executionFingerprintRole || 'METADATA_ONLY',
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,

    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    definitionParts,
    definition: definitionParts.length
      ? definitionParts.join(' | ')
      : truncateString(refreshed.definition || '', 1600),

    parentDefinitionParts,
    parentDefinition: parentDefinitionParts.length
      ? parentDefinitionParts.join(' | ')
      : truncateString(refreshed.parentDefinition || '', 1200),

    examples: compactExamples(refreshed.examples, 8, 480),
    recentOutcomes: compactRecentOutcomes(refreshed.recentOutcomes, 8),

    learningStatus: getLearningStatus(refreshed),
    status: getLearningStatus(refreshed),
    tooEarly: safeNumber(refreshed.completed, 0) < MIN_COMPLETED_ACTIVE_LEARNING,
    tooEarlyReason: safeNumber(refreshed.completed, 0) < MIN_COMPLETED_ACTIVE_LEARNING
      ? `completed ${safeNumber(refreshed.completed, 0)}/${MIN_COMPLETED_ACTIVE_LEARNING}`
      : null
  });
}

function normalizeMicros(micros = {}) {
  return Object.fromEntries(
    Object.entries(micros || {})
      .map(([id, row]) => {
        const microFamilyId = normalizeChildTrueMicroFamilyId(
          row?.trueMicroFamilyId || row?.microFamilyId || id,
          row || {}
        );

        if (!microFamilyId || !row) return null;
        if (!isLongOnlyRow(row)) return null;

        const compact = compactMicroForStorage({
          ...row,
          microFamilyId,
          trueMicroFamilyId: microFamilyId
        });

        if (!compact) return null;

        return [
          microFamilyId,
          compact
        ];
      })
      .filter(Boolean)
  );
}

function compareTopMicros(a = {}, b = {}) {
  const ar = refreshStats(a);
  const br = refreshStats(b);

  return (
    safeNumber(br.dashboardBalancedScore ?? br.balancedScore, 0) -
    safeNumber(ar.dashboardBalancedScore ?? ar.balancedScore, 0) ||

    safeNumber(br.fairWinrate ?? br.sampleAdjustedWinrate ?? br.wilsonLowerBound, 0) -
    safeNumber(ar.fairWinrate ?? ar.sampleAdjustedWinrate ?? ar.wilsonLowerBound, 0) ||

    safeNumber(br.totalR ?? br.netTotalR, 0) -
    safeNumber(ar.totalR ?? ar.netTotalR, 0) ||

    safeNumber(br.avgR ?? br.netAvgR, 0) -
    safeNumber(ar.avgR ?? ar.netAvgR, 0) ||

    safeNumber(ar.avgCostR ?? ar.totalCostR, 0) -
    safeNumber(br.avgCostR ?? br.totalCostR, 0) ||

    safeNumber(br.completed, 0) -
    safeNumber(ar.completed, 0) ||

    safeNumber(br.seen ?? br.observations, 0) -
    safeNumber(ar.seen ?? ar.observations, 0) ||

    String(ar.microFamilyId || '').localeCompare(String(br.microFamilyId || ''))
  );
}

function selectTopMicrosObject(micros = {}, limit = 300) {
  const safeLimit = Math.max(1, Math.floor(safeNumber(limit, 300)));
  const normalized = normalizeMicros(micros);

  return Object.fromEntries(
    Object.values(normalized)
      .filter(Boolean)
      .filter(isLongOnlyRow)
      .filter((row) => isFixedTaxonomyChildMicroId(row.trueMicroFamilyId || row.microFamilyId))
      .sort(compareTopMicros)
      .slice(0, safeLimit)
      .map((row) => [
        row.trueMicroFamilyId || row.microFamilyId,
        withAnalyzeIdentityFlags(row)
      ])
      .filter(([id]) => Boolean(id))
  );
}

export async function getWeekMicros(weekKey = PERSISTENT_LEARNING_KEY) {
  const redis = getDurableRedis();

  const raw = await getJson(
    redis,
    getWeekMicrosBaseKey(weekKey),
    null
  ).catch(() => null);

  if (!raw) return {};

  const rows = raw.rows || raw.micros || raw;

  return normalizeMicros(rows || {});
}

export async function getWeekTopMicros(weekKey = PERSISTENT_LEARNING_KEY, {
  limit = 25
} = {}) {
  const redis = getDurableRedis();

  const top = await getJson(
    redis,
    getWeekMicrosTopKey(weekKey),
    null
  ).catch(() => null);

  if (top?.rows && Object.keys(top.rows).length > 0) {
    return selectTopMicrosObject(top.rows, limit);
  }

  return selectTopMicrosObject(
    await getWeekMicros(weekKey),
    limit
  );
}

export async function getWeekMicrosByIds(weekKey, ids = []) {
  const safeIds = uniqueStrings(ids)
    .map((id) => normalizeChildTrueMicroFamilyId(id))
    .filter(Boolean);

  if (!safeIds.length) return {};

  const micros = await getWeekMicros(weekKey);

  return Object.fromEntries(
    safeIds
      .filter((id) => micros[id])
      .map((id) => [id, micros[id]])
  );
}

export async function saveWeekMicros(
  weekKey,
  micros,
  {
    onlyIds = null,
    allowEmptyFullSave = false
  } = {}
) {
  if (!weekKey) {
    throw new Error('WEEK_KEY_MISSING');
  }

  const redis = getDurableRedis();

  const existing = onlyIds
    ? await getWeekMicros(weekKey).catch(() => ({}))
    : {};

  const clean = normalizeMicros({
    ...(existing || {}),
    ...(micros || {})
  });

  const ids = Object.keys(clean);

  if (!ids.length && !allowEmptyFullSave) {
    return existing || {};
  }

  const topRows = selectTopMicrosObject(clean, 300);

  const payload = {
    weekKey,
    updatedAt: now(),
    rows: clean,
    count: ids.length,

    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_SCANNER_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,

    analyzeMicroFamiliesOnly: true,
    trueMicroOnly: true,
    exactTrueMicroOnly: true,

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    avgCostRShown: true,
    observationDedupeRequired: true,
    seenDefinition: 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY',
    outcomeDedupeRequired: true,

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    learningRemainsBroad: true,

    classifierVersion: CLASSIFIER_VERSION,
    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    noDefaultRetestSqueezeB: true,

    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY
  };

  await setJson(redis, getWeekMicrosBaseKey(weekKey), payload);

  await setJson(redis, getWeekMicrosTopKey(weekKey), {
    weekKey,
    updatedAt: now(),
    rows: topRows,
    count: Object.keys(topRows).length,
    storageMode: 'TOP_MICROS_SNAPSHOT',
    targetTradeSide: TARGET_TRADE_SIDE,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    classifierVersion: CLASSIFIER_VERSION,
    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX
  });

  await setJson(redis, getWeekMetaKey(weekKey), {
    weekKey,
    updatedAt: now(),
    microFamilies: ids.length,

    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_SCANNER_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,

    analyzeMicroFamiliesOnly: true,
    trueMicroOnly: true,
    exactTrueMicroOnly: true,

    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    avgCostRShown: true,
    observationDedupeRequired: true,
    seenDefinition: 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY',
    outcomeDedupeRequired: true,

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    learningRemainsBroad: true,

    classifierVersion: CLASSIFIER_VERSION,
    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    noDefaultRetestSqueezeB: true,

    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY
  });

  return clean;
}

function getOrCreateMicro(micros, classified, side) {
  if (!classified) {
    throw new Error('CLASSIFIED_MICRO_REQUIRED');
  }

  const microFamilyId = normalizeChildTrueMicroFamilyId(
    classified.trueMicroFamilyId || classified.microFamilyId,
    classified
  );

  if (!microFamilyId) {
    throw new Error('EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_REQUIRED');
  }

  if (!validLearningId(microFamilyId)) {
    throw new Error('INVALID_LEARNING_ID');
  }

  const parsed = parseLongTaxonomyMicroId(microFamilyId);

  if (!parsed.isChild) {
    throw new Error('PARENT_OR_NON_CHILD_MICRO_FAMILY_CANNOT_BE_STATS_KEY');
  }

  const parentTrueMicroFamilyId = parsed.parentTrueMicroFamilyId;
  const familyId = classified.familyId || 'LONG_FIXED_TAXONOMY';
  const normalizedSide = normalizeStatsSide(side, classified);

  if (!micros[microFamilyId]) {
    micros[microFamilyId] = createMicroStats({
      microFamilyId,
      trueMicroFamilyId: microFamilyId,
      familyId,
      side: normalizedSide,
      tradeSide: TARGET_TRADE_SIDE,
      definitionParts: classified.definitionParts || []
    });
  }

  const micro = micros[microFamilyId];

  micro.microFamilyId = microFamilyId;
  micro.trueMicroFamilyId = microFamilyId;
  micro.childTrueMicroFamilyId = microFamilyId;
  micro.familyId ||= familyId;

  micro.coarseMicroFamilyId = parentTrueMicroFamilyId;
  micro.baseMicroFamilyId = parentTrueMicroFamilyId;
  micro.legacyMicroFamilyId = parentTrueMicroFamilyId;
  micro.parentTrueMicroFamilyId = parentTrueMicroFamilyId;
  micro.parentMicroFamilyId = parentTrueMicroFamilyId;
  micro.macroFamilyId = parentTrueMicroFamilyId;
  micro.parentMacroFamilyId = parentTrueMicroFamilyId;

  micro.fineMicroFamilyId ||= classified.fineMicroFamilyId || classified.narrowMicroFamilyId || classified.mfV2MicroFamilyId || null;
  micro.narrowMicroFamilyId ||= classified.narrowMicroFamilyId || classified.fineMicroFamilyId || classified.mfV2MicroFamilyId || null;
  micro.mfV2MicroFamilyId ||= classified.mfV2MicroFamilyId || classified.fineMicroFamilyId || classified.narrowMicroFamilyId || null;

  micro.broadTrueMicroFamilyId = microFamilyId;
  micro.broadTrueDefinitionParts ||= classified.broadTrueDefinitionParts || classified.definitionParts || [];
  micro.broadTrueMicroFamilySchema = TRUE_MICRO_SCHEMA;
  micro.trueMicroFamilySchema = TRUE_MICRO_SCHEMA;
  micro.childTrueMicroFamilySchema = CHILD_TRUE_MICRO_SCHEMA;
  micro.parentTrueMicroFamilySchema = PARENT_TRUE_MICRO_SCHEMA;

  micro.learningGranularity = LEARNING_GRANULARITY;
  micro.parentLearningGranularity = PARENT_LEARNING_GRANULARITY;

  micro.fixedTaxonomyLearningId = true;
  micro.fineMicroFamilyAsMetadataOnly = true;

  micro.setupType = parsed.setup;
  micro.regimeBucket = parsed.regime;
  micro.confirmationProfile = parsed.confirmationProfile;

  micro.executionFingerprintHash ||= classified.executionFingerprintHash || null;
  micro.executionFingerprintParts ||= classified.executionFingerprintParts || [];
  micro.executionFingerprintSchema ||= classified.executionFingerprintSchema || null;
  micro.executionMicroFamilyId ||= classified.executionMicroFamilyId || null;
  micro.executionFingerprintRole ||= classified.executionFingerprintRole || 'METADATA_ONLY';

  micro.scannerMicroFamilyId ||= classified.scannerMicroFamilyId || null;
  micro.scannerFamilyId ||= classified.scannerFamilyId || null;
  micro.scannerDefinition ||= classified.scannerDefinition || null;
  micro.scannerDefinitionParts ||= classified.scannerDefinitionParts || [];

  Object.assign(micro, analyzeIdentityFlags());

  micro.side = TARGET_DASHBOARD_SIDE;
  micro.tradeSide = TARGET_TRADE_SIDE;
  micro.positionSide = TARGET_TRADE_SIDE;
  micro.direction = TARGET_TRADE_SIDE;

  micro.targetTradeSide = TARGET_TRADE_SIDE;
  micro.dashboardSide = TARGET_DASHBOARD_SIDE;

  micro.longOnly = true;
  micro.shortDisabled = true;
  micro.shortOnly = false;
  micro.longDisabled = false;

  micro.schema = TRUE_MICRO_SCHEMA;
  micro.microFamilySchema = TRUE_MICRO_SCHEMA;
  micro.version = 'fixed-taxonomy-75-child-smart-evidence-v2';

  micro.parentDefinition ||= classified.parentDefinition || '';
  micro.parentDefinitionParts ||= classified.parentDefinitionParts || [];

  micro.definitionParts = mergeDefinitionParts(
    micro.definitionParts || [],
    classified.definitionParts || []
  );

  micro.definition = micro.definitionParts.length
    ? micro.definitionParts.join(' | ')
    : classified.definition || '';

  micro.assetClass ||= classified.assetClass || null;

  micro.obRelation ||= classified.obRelation || null;
  micro.btcRelation ||= classified.btcRelation || null;
  micro.btcState ||= classified.btcState || null;

  micro.flow ||= classified.flow || null;
  micro.flowCoarse ||= classified.flowCoarse || null;

  micro.regime ||= classified.regime || null;
  micro.regimeCoarse ||= classified.regimeCoarse || null;

  micro.scannerReason ||= classified.scannerReason || null;
  micro.scannerReasonCoarse ||= classified.scannerReasonCoarse || null;

  micro.rsiZone ||= classified.rsiZone || null;
  micro.rsiCoarse ||= classified.rsiCoarse || null;

  if (classified.spreadBps !== undefined && micro.spreadBps === undefined) {
    micro.spreadBps = classified.spreadBps;
  }

  micro.classifierVersion = CLASSIFIER_VERSION;
  micro.noDefaultRetestSqueezeB = true;
  micro.measurementFixVersion = MEASUREMENT_FIX_VERSION;
  micro.observationDedupeRequired = true;
  micro.seenDefinition = 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY';
  micro.outcomeDedupeRequired = true;

  micro.currentFitSoftOnly = true;
  micro.currentFitBlocksLearning = false;
  micro.learningRemainsBroad = true;
  micro.selectionWillBeAdaptive = true;
  micro.discordWillBeStrict = true;

  micro.learningStatus = getLearningStatus(micro);
  micro.status = micro.learningStatus;
  micro.tooEarly = safeNumber(micro.completed, 0) < MIN_COMPLETED_ACTIVE_LEARNING;
  micro.tooEarlyReason = micro.tooEarly
    ? `completed ${safeNumber(micro.completed, 0)}/${MIN_COMPLETED_ACTIVE_LEARNING}`
    : null;

  return micro;
}

function buildAnalyzeVariants(metrics = {}) {
  const primary = enrichWithMicroFamily(metrics);

  if (!primary) {
    return {
      primary: null,
      mirrors: []
    };
  }

  return {
    primary,
    mirrors: []
  };
}

function buildObservationDedupeIdentity(row = {}, microFamilyId = '') {
  const snapshotId = String(
    row.snapshotId ||
      row.scanSnapshotId ||
      row.scannerSnapshotId ||
      row.batchId ||
      row.runId ||
      row.createdBucket ||
      'NO_SNAPSHOT'
  ).trim();

  const symbol = String(
    row.symbol ||
      row.contractSymbol ||
      row.baseSymbol ||
      'UNKNOWN'
  ).trim().toUpperCase();

  const entry = safeNumber(row.entry || row.entryPrice, 0);

  return {
    snapshotId: snapshotId || 'NO_SNAPSHOT',
    symbol: symbol || 'UNKNOWN',
    microFamilyId,
    entry
  };
}

export async function analyzeCandidatesBatch(
  metricsRows = [],
  { weekKey = PERSISTENT_LEARNING_KEY } = {}
) {
  const rows = Array.isArray(metricsRows)
    ? metricsRows.filter(Boolean).filter((row) => isLongOnlyRow(row))
    : [];

  if (rows.length === 0) {
    return [];
  }

  const redis = getDurableRedis();

  const variantRows = rows
    .map((metrics) => ({
      metrics: withAnalyzeIdentityFlags(metrics),
      ...buildAnalyzeVariants(metrics)
    }))
    .filter((row) => row.primary)
    .filter((row) => normalizeChildTrueMicroFamilyId(row.primary.trueMicroFamilyId || row.primary.microFamilyId));

  if (variantRows.length === 0) {
    return [];
  }

  const allClassifiedRows = variantRows.flatMap((row) => [
    row.primary,
    ...row.mirrors
  ]).filter(Boolean);

  const touchedIds = uniqueStrings(
    allClassifiedRows.map((row) => normalizeChildTrueMicroFamilyId(row.trueMicroFamilyId || row.microFamilyId, row))
  ).filter(Boolean);

  if (touchedIds.length === 0) {
    return [];
  }

  const micros = await getWeekMicros(weekKey);

  const analyzed = [];
  const actuallyTouchedIds = new Set();

  for (const batch of variantRows) {
    const processRows = [
      {
        row: batch.primary,
        returnToCaller: true
      }
    ];

    for (const item of processRows) {
      const classified = item.row;

      if (!classified || !classified.microFamilyId) continue;

      const microFamilyId = normalizeChildTrueMicroFamilyId(
        classified.trueMicroFamilyId || classified.microFamilyId,
        {
          ...batch.metrics,
          ...classified
        }
      );

      if (!microFamilyId) continue;

      const parentTrueMicroFamilyId = normalizeParentTrueMicroFamilyId(
        classified.parentTrueMicroFamilyId || classified.coarseMicroFamilyId || microFamilyId,
        classified
      );

      const observationIdentity = buildObservationDedupeIdentity(batch.metrics, microFamilyId);

      const observationKey = getObsLastKey(
        observationIdentity.snapshotId,
        observationIdentity.symbol,
        observationIdentity.microFamilyId
      );

      const observationClaim = await claimDedupeKey(
        redis,
        observationKey,
        obsDedupeTtlSec(),
        {
          type: 'OBSERVATION'
        }
      );

      const observationDuplicate = observationClaim.duplicate === true;
      const observationRecorded = observationClaim.claimed === true && !observationDuplicate;

      const micro = getOrCreateMicro(
        micros,
        {
          ...classified,
          microFamilyId,
          trueMicroFamilyId: microFamilyId,
          childTrueMicroFamilyId: microFamilyId,
          coarseMicroFamilyId: parentTrueMicroFamilyId,
          parentTrueMicroFamilyId
        },
        TARGET_DASHBOARD_SIDE
      );

      updateObservation(micro, withAnalyzeIdentityFlags({
        ...batch.metrics,
        ...classified,

        microFamilyId,
        trueMicroFamilyId: microFamilyId,
        childTrueMicroFamilyId: microFamilyId,
        coarseMicroFamilyId: parentTrueMicroFamilyId,
        parentTrueMicroFamilyId,
        parentMicroFamilyId: parentTrueMicroFamilyId,
        macroFamilyId: parentTrueMicroFamilyId,
        parentMacroFamilyId: parentTrueMicroFamilyId,

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

        weekKey,
        strategyVersion: CONFIG.strategyVersion,

        source: OBSERVATION_SOURCE,
        analysisType: 'VIRTUAL_TRADE_SETUP_OBSERVATION',

        virtualOnly: true,
        virtualTracked: true,
        shadowOnly: true,

        realTrade: false,
        realOrder: false,
        exchangeOrder: false,
        bitgetOrderPlaced: false,

        observationRecorded,
        observationDuplicate,
        observationAlreadyCounted: observationDuplicate,
        observationCounted: observationRecorded,
        countObservation: observationRecorded,
        skipObservationCount: observationDuplicate,
        observationAlwaysCounted: false,
        observationDedupeKey: observationKey,
        observationDedupeMethod: observationClaim.method,
        observationDedupeType: observationClaim.type,
        observationSnapshotId: observationIdentity.snapshotId,
        observationEntry: observationIdentity.entry,

        createdAt: batch.metrics.createdAt || now()
      }));

      Object.assign(micro, analyzeIdentityFlags());

      actuallyTouchedIds.add(microFamilyId);

      if (item.returnToCaller) {
        analyzed.push(withAnalyzeIdentityFlags({
          ...batch.metrics,
          ...classified,

          microFamilyId,
          trueMicroFamilyId: microFamilyId,
          childTrueMicroFamilyId: microFamilyId,
          coarseMicroFamilyId: parentTrueMicroFamilyId,
          parentTrueMicroFamilyId,
          parentMicroFamilyId: parentTrueMicroFamilyId,
          macroFamilyId: parentTrueMicroFamilyId,
          parentMacroFamilyId: parentTrueMicroFamilyId,

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

          source: OBSERVATION_SOURCE,
          analysisType: 'VIRTUAL_TRADE_SETUP_OBSERVATION',

          observationRecorded,
          observationDuplicate,
          observationAlreadyCounted: observationDuplicate,
          observationCounted: observationRecorded,
          countObservation: observationRecorded,
          skipObservationCount: observationDuplicate,
          observationAlwaysCounted: false,
          observationDedupeKey: observationKey,
          observationDedupeMethod: observationClaim.method,

          mirrorMicroFamiliesCreated: 0,
          mirrorMicroFamilyIds: [],

          virtualOnly: true,
          virtualTracked: true,
          shadowOnly: true,

          realTrade: false,
          realOrder: false,
          exchangeOrder: false,
          bitgetOrderPlaced: false,

          weekKey,
          strategyVersion: CONFIG.strategyVersion
        }));
      }
    }
  }

  if (actuallyTouchedIds.size > 0) {
    await saveWeekMicros(
      weekKey,
      micros,
      {
        onlyIds: [...actuallyTouchedIds]
      }
    );
  }

  return analyzed;
}

function hasLockedOutcomeIdentity(outcome = {}) {
  return Boolean(
    normalizeChildTrueMicroFamilyId(outcome.trueMicroFamilyId || outcome.microFamilyId, outcome)
  );
}

function buildLockedOutcomeRow(outcome = {}) {
  const microFamilyId = normalizeChildTrueMicroFamilyId(
    outcome.trueMicroFamilyId ||
      outcome.microFamilyId ||
      outcome.childTrueMicroFamilyId ||
      '',
    outcome
  );

  if (!microFamilyId) return null;

  const parsed = parseLongTaxonomyMicroId(microFamilyId);
  const parentTrueMicroFamilyId = parsed.parentTrueMicroFamilyId;

  const familyId = String(
    outcome.familyId ||
      outcome.family ||
      'LONG_VIRTUAL_OUTCOME'
  ).trim();

  const definitionParts = mergeDefinitionParts(
    outcome.definitionParts || [],
    outcome.broadTrueDefinitionParts || [],
    [
      `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
      `LOCKED_MICRO=${microFamilyId}`,
      `LOCKED_TRUE_MICRO=${microFamilyId}`,
      `LOCKED_PARENT_TRUE_MICRO=${parentTrueMicroFamilyId}`,
      'OUTCOME_IDENTITY=POSITION_LOCKED'
    ]
  );

  const parentDefinitionParts = mergeDefinitionParts(
    outcome.parentDefinitionParts || [],
    outcome.macroDefinitionParts || [],
    [
      `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
      `PARENT_TRUE_MICRO=${parentTrueMicroFamilyId}`,
      `SETUP=${parsed.setup}`,
      `REGIME_BUCKET=${parsed.regime}`
    ]
  );

  return withAnalyzeIdentityFlags({
    ...outcome,

    familyId,

    microFamilyId,
    trueMicroFamilyId: microFamilyId,
    childTrueMicroFamilyId: microFamilyId,
    coarseMicroFamilyId: parentTrueMicroFamilyId,
    baseMicroFamilyId: parentTrueMicroFamilyId,
    legacyMicroFamilyId: parentTrueMicroFamilyId,

    parentTrueMicroFamilyId,
    parentMicroFamilyId: parentTrueMicroFamilyId,
    macroFamilyId: parentTrueMicroFamilyId,
    parentMacroFamilyId: parentTrueMicroFamilyId,

    broadTrueMicroFamilyId: microFamilyId,
    broadTrueDefinitionParts: outcome.broadTrueDefinitionParts || definitionParts,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    fineMicroFamilyAsMetadataOnly: true,
    fixedTaxonomyLearningId: true,

    setupType: parsed.setup,
    regimeBucket: parsed.regime,
    confirmationProfile: parsed.confirmationProfile,

    definitionParts,
    definition: definitionParts.join(' | '),

    parentDefinitionParts,
    parentDefinition: parentDefinitionParts.join(' | '),

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

    source: outcome.source || OUTCOME_SOURCE,
    outcomeSource: OUTCOME_SOURCE,
    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: true,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    scannerMicroFamilyId: outcome.scannerMicroFamilyId || null,
    scannerFamilyId: outcome.scannerFamilyId || null,
    scannerDefinition: outcome.scannerDefinition || null,
    scannerDefinitionParts: outcome.scannerDefinitionParts || [],
    scannerFingerprintRole: 'METADATA_ONLY',

    outcomeIdentityLocked: true,
    outcomeIdentitySource: 'POSITION_MICRO_IDENTITY',
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true
  });
}

function calcGrossMovePct({ side, entry, exit }) {
  if (entry <= 0 || exit <= 0) return 0;

  return isTargetLongSide(side)
    ? (exit - entry) / entry
    : (entry - exit) / entry;
}

function calcRiskPct({ entry, sl }) {
  if (entry <= 0 || sl <= 0) return 0;

  return Math.abs(entry - sl) / entry;
}

function ensureNetOutcome(outcome = {}) {
  const existingNetR = safeNumber(
    outcome.netR ??
      outcome.exitR ??
      outcome.realizedNetR ??
      outcome.realizedR ??
      outcome.r,
    null
  );

  const existingGrossR = safeNumber(
    outcome.grossR ??
      outcome.rawR ??
      outcome.realizedGrossR,
    null
  );

  const existingCostR = safeNumber(
    outcome.costR ??
      outcome.avgCostR ??
      outcome.totalCostR,
    null
  );

  const entry = safeNumber(outcome.entry, 0);
  const exit = safeNumber(outcome.exit ?? outcome.exitPrice, 0);
  const initialSl = safeNumber(outcome.initialSl || outcome.sl, 0);
  const tp = safeNumber(outcome.tp, 0);

  const validLongRiskShape =
    entry > 0 &&
    initialSl > 0 &&
    tp > 0 &&
    initialSl < entry &&
    entry < tp;

  const riskPct =
    safeNumber(outcome.riskPct, 0) ||
    calcRiskPct({
      entry,
      sl: initialSl
    });

  const grossMovePct = safeNumber(
    outcome.grossMovePct,
    entry > 0 && exit > 0
      ? calcGrossMovePct({
        side: TARGET_TRADE_SIDE,
        entry,
        exit
      })
      : null
  );

  if (
    Number.isFinite(grossMovePct) &&
    riskPct > 0
  ) {
    const cost = applyCosts({
      side: TARGET_TRADE_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      grossMovePct,
      riskPct,
      entrySpreadPct: safeNumber(outcome.entrySpreadPct ?? outcome.spreadPct, 0),
      exitSpreadPct: safeNumber(outcome.exitSpreadPct ?? outcome.spreadPct, 0)
    });

    const netR = safeNumber(cost.netR, existingNetR ?? 0);
    const grossR = safeNumber(cost.grossR, existingGrossR ?? 0);
    const costR = safeNumber(cost.costR, existingCostR ?? Math.max(0, grossR - netR));

    return withAnalyzeIdentityFlags({
      ...outcome,

      validLongRiskShape,

      grossMovePct,
      riskPct,

      grossR,
      rawR: grossR,
      realizedGrossR: grossR,
      grossPnlPct: safeNumber(cost.grossPnlPct, 0),

      netR,
      exitR: netR,
      realizedNetR: netR,
      realizedR: netR,
      r: netR,
      pnlPct: safeNumber(cost.netPnlPct, 0),
      netPnlPct: safeNumber(cost.netPnlPct, 0),

      costR,
      avgCostR: costR,
      costPct: safeNumber(cost.costPct, 0),
      feePct: safeNumber(cost.feePct, 0),
      slippagePct: safeNumber(cost.slippagePct, 0),

      win: netR > 0,
      loss: netR < 0,
      flat: netR === 0,
      isWin: netR > 0,

      costModelApplied: true,
      netCostModelApplied: true,
      costModel: outcome.costModel || 'APPLY_COSTS_NET_R_V1'
    });
  }

  const fallbackNetR = safeNumber(existingNetR, 0);
  const fallbackGrossR = safeNumber(existingGrossR, fallbackNetR);
  const fallbackCostR = safeNumber(
    existingCostR,
    Math.max(0, fallbackGrossR - fallbackNetR)
  );

  return withAnalyzeIdentityFlags({
    ...outcome,

    validLongRiskShape,

    netR: fallbackNetR,
    exitR: fallbackNetR,
    realizedNetR: fallbackNetR,
    realizedR: fallbackNetR,
    r: fallbackNetR,

    grossR: fallbackGrossR,
    rawR: fallbackGrossR,
    realizedGrossR: fallbackGrossR,

    costR: fallbackCostR,
    avgCostR: fallbackCostR,

    win: fallbackNetR > 0,
    loss: fallbackNetR < 0,
    flat: fallbackNetR === 0,
    isWin: fallbackNetR > 0,

    costModelApplied: Boolean(outcome.costModelApplied),
    netCostModelApplied: Boolean(outcome.netCostModelApplied),
    costModel: outcome.costModel || 'PRECOMPUTED_NET_R'
  });
}

function buildOutcomeDedupeIdentity(outcome = {}, microFamilyId = '') {
  const direct = String(
    outcome.outcomeId ||
      outcome.learningOutcomeId ||
      outcome.closeEventId ||
      outcome.tradeCloseId ||
      outcome.tradeId ||
      outcome.positionId ||
      ''
  ).trim();

  if (direct) {
    return hashText(`${TARGET_TRADE_SIDE}|${direct}|${microFamilyId}`, 24);
  }

  const symbol = String(outcome.symbol || outcome.contractSymbol || 'UNKNOWN').toUpperCase();
  const openedAt = String(outcome.openedAt || outcome.createdAt || 'NO_OPEN').trim();
  const closedAt = String(outcome.closedAt || outcome.completedAt || outcome.ts || 'NO_CLOSE').trim();
  const exitReason = String(outcome.exitReason || outcome.reason || 'NO_REASON').trim();
  const netR = safeNumber(outcome.netR ?? outcome.exitR, 0).toFixed(6);
  const exitPrice = safeNumber(outcome.exit ?? outcome.exitPrice, 0).toFixed(8);

  return hashText([
    TARGET_TRADE_SIDE,
    symbol,
    openedAt,
    closedAt,
    exitReason,
    netR,
    exitPrice,
    microFamilyId
  ].join('|'), 24);
}

export async function recordOutcome(
  outcome = {},
  {
    source = outcome.source || OUTCOME_SOURCE,
    weekKey = PERSISTENT_LEARNING_KEY
  } = {}
) {
  if (!isLongOnlyRow(outcome)) {
    return {
      ...outcome,
      source: normalizeSource(source),
      weekKey,
      skipped: true,
      reason: 'NON_LONG_OUTCOME_SKIPPED_LONG_ONLY',
      recordedAt: now(),
      mirrorOutcomeRecorded: false,
      mirrorMicroFamilyId: null
    };
  }

  const src = normalizeSource(source);

  const netOutcome = ensureNetOutcome(withAnalyzeIdentityFlags({
    ...outcome,
    source: src,
    weekKey,
    strategyVersion: CONFIG.strategyVersion,

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

    virtualOnly: outcome.virtualOnly !== false,
    virtualTracked: outcome.virtualTracked !== false,
    shadowOnly: outcome.shadowOnly !== false,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false
  }));

  const row = hasLockedOutcomeIdentity(netOutcome)
    ? buildLockedOutcomeRow(netOutcome)
    : enrichWithMicroFamily(netOutcome);

  if (!row) {
    return {
      ...netOutcome,
      source: src,
      weekKey,
      skipped: true,
      reason: 'LONG_ONLY_CLASSIFICATION_SKIPPED_OR_EXACT_75_CHILD_MISSING',
      recordedAt: now(),
      mirrorOutcomeRecorded: false,
      mirrorMicroFamilyId: null
    };
  }

  const microFamilyId = normalizeChildTrueMicroFamilyId(row.trueMicroFamilyId || row.microFamilyId, row);

  if (!microFamilyId) {
    return {
      ...row,
      source: src,
      weekKey,
      skipped: true,
      reason: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_REQUIRED_FOR_OUTCOME',
      recordedAt: now(),
      mirrorOutcomeRecorded: false,
      mirrorMicroFamilyId: null
    };
  }

  const parentTrueMicroFamilyId = normalizeParentTrueMicroFamilyId(
    row.parentTrueMicroFamilyId || row.coarseMicroFamilyId || microFamilyId,
    row
  );

  const redis = getDurableRedis();
  const outcomeIdentity = buildOutcomeDedupeIdentity(row, microFamilyId);
  const outcomeDedupeKey = getOutcomeLastKey(weekKey, outcomeIdentity, microFamilyId);

  const outcomeClaim = await claimDedupeKey(
    redis,
    outcomeDedupeKey,
    outcomeDedupeTtlSec(),
    {
      type: 'OUTCOME'
    }
  );

  const micros = await getWeekMicros(weekKey);

  const micro = getOrCreateMicro(
    micros,
    {
      ...row,
      microFamilyId,
      trueMicroFamilyId: microFamilyId,
      childTrueMicroFamilyId: microFamilyId,
      coarseMicroFamilyId: parentTrueMicroFamilyId,
      parentTrueMicroFamilyId
    },
    TARGET_DASHBOARD_SIDE
  );

  if (outcomeClaim.duplicate === true) {
    updateOutcome(micro, withAnalyzeIdentityFlags({
      ...row,

      microFamilyId,
      trueMicroFamilyId: microFamilyId,
      childTrueMicroFamilyId: microFamilyId,
      coarseMicroFamilyId: parentTrueMicroFamilyId,
      parentTrueMicroFamilyId,
      parentMicroFamilyId: parentTrueMicroFamilyId,
      macroFamilyId: parentTrueMicroFamilyId,
      parentMacroFamilyId: parentTrueMicroFamilyId,

      source: src,
      outcomeSource: OUTCOME_SOURCE,
      outcomeDuplicate: true,
      outcomeAlreadyRecorded: true,
      outcomeCounted: false,
      countOutcome: false,
      skipOutcomeCount: true,
      outcomeDedupeKey,
      outcomeDedupeMethod: outcomeClaim.method
    }), src);

    Object.assign(micro, analyzeIdentityFlags());

    await saveWeekMicros(
      weekKey,
      micros,
      {
        onlyIds: [microFamilyId]
      }
    );

    return withAnalyzeIdentityFlags({
      ...row,
      microFamilyId,
      trueMicroFamilyId: microFamilyId,
      childTrueMicroFamilyId: microFamilyId,
      coarseMicroFamilyId: parentTrueMicroFamilyId,
      parentTrueMicroFamilyId,
      parentMicroFamilyId: parentTrueMicroFamilyId,
      macroFamilyId: parentTrueMicroFamilyId,
      parentMacroFamilyId: parentTrueMicroFamilyId,
      source: src,
      outcomeSource: OUTCOME_SOURCE,
      weekKey,
      skipped: true,
      reason: 'DUPLICATE_OUTCOME_SKIPPED',
      outcomeDuplicate: true,
      outcomeAlreadyRecorded: true,
      outcomeCounted: false,
      countOutcome: false,
      skipOutcomeCount: true,
      outcomeDedupeKey,
      outcomeDedupeMethod: outcomeClaim.method,
      recordedAt: now(),
      mirrorOutcomeRecorded: false,
      mirrorMicroFamilyId: null
    });
  }

  updateOutcome(micro, withAnalyzeIdentityFlags({
    ...row,

    microFamilyId,
    trueMicroFamilyId: microFamilyId,
    childTrueMicroFamilyId: microFamilyId,
    coarseMicroFamilyId: parentTrueMicroFamilyId,
    parentTrueMicroFamilyId,
    parentMicroFamilyId: parentTrueMicroFamilyId,
    macroFamilyId: parentTrueMicroFamilyId,
    parentMacroFamilyId: parentTrueMicroFamilyId,

    source: src,
    outcomeSource: OUTCOME_SOURCE,

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

    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: true,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    netR: safeNumber(row.netR ?? row.exitR, 0),
    exitR: safeNumber(row.exitR ?? row.netR, 0),
    realizedNetR: safeNumber(row.realizedNetR ?? row.netR ?? row.exitR, 0),
    realizedR: safeNumber(row.realizedR ?? row.netR ?? row.exitR, 0),
    r: safeNumber(row.r ?? row.netR ?? row.exitR, 0),

    costR: safeNumber(row.costR, 0),
    avgCostR: safeNumber(row.avgCostR ?? row.costR, 0),
    grossR: safeNumber(row.grossR, 0),
    rawR: safeNumber(row.rawR ?? row.grossR, 0),
    realizedGrossR: safeNumber(row.realizedGrossR ?? row.grossR, 0),

    costModelApplied: Boolean(row.costModelApplied),
    netCostModelApplied: Boolean(row.netCostModelApplied),

    directToSL: Boolean(row.directToSL),
    directSL: Boolean(row.directSL || row.directToSL),

    outcomeDuplicate: false,
    outcomeAlreadyRecorded: false,
    outcomeCounted: true,
    countOutcome: true,
    skipOutcomeCount: false,
    outcomeDedupeKey,
    outcomeDedupeMethod: outcomeClaim.method,

    outcomeIdentityLocked: true,
    outcomeIdentitySource: row.outcomeIdentitySource || 'POSITION_MICRO_IDENTITY'
  }), src);

  Object.assign(micro, analyzeIdentityFlags());

  await saveWeekMicros(
    weekKey,
    micros,
    {
      onlyIds: [microFamilyId]
    }
  );

  return withAnalyzeIdentityFlags({
    ...row,
    microFamilyId,
    trueMicroFamilyId: microFamilyId,
    childTrueMicroFamilyId: microFamilyId,
    coarseMicroFamilyId: parentTrueMicroFamilyId,
    parentTrueMicroFamilyId,
    parentMicroFamilyId: parentTrueMicroFamilyId,
    macroFamilyId: parentTrueMicroFamilyId,
    parentMacroFamilyId: parentTrueMicroFamilyId,
    source: src,
    outcomeSource: OUTCOME_SOURCE,
    weekKey,
    recordedAt: now(),
    outcomeDuplicate: false,
    outcomeAlreadyRecorded: false,
    outcomeCounted: true,
    countOutcome: true,
    skipOutcomeCount: false,
    outcomeDedupeKey,
    outcomeDedupeMethod: outcomeClaim.method,
    mirrorOutcomeRecorded: false,
    mirrorMicroFamilyId: null
  });
}

export async function createShadowPosition() {
  return {
    ok: false,
    created: false,
    skipped: true,
    reason: 'SHADOW_POSITION_CREATION_MOVED_TO_POSITION_ENGINE_VIRTUAL_TRACKING'
  };
}

function calcLongGrossR({ entry, initialSl, exit }) {
  if (entry <= 0 || initialSl <= 0 || exit <= 0) return 0;

  const riskDistance = entry - initialSl;

  if (riskDistance <= 0) return 0;

  return (exit - entry) / riskDistance;
}

function inferDirectToSL({ position, exitReason }) {
  const reason = upper(exitReason);

  const mfeR = safeNumber(position.mfeR, 0);
  const maeR = safeNumber(position.maeR, 0);

  const stoppedOut = [
    'SL',
    'HIT_SL',
    'STOP',
    'STOP_LOSS',
    'STOPLOSS',
    'HARD_SL',
    'DIRECT_SL'
  ].includes(reason) ||
    reason.includes('STOP_LOSS') ||
    reason.includes('STOPLOSS') ||
    reason.includes('HIT_SL') ||
    reason.includes('DIRECT_SL');

  return Boolean(position.directToSL || position.directSL) ||
    (
      stoppedOut &&
      !Boolean(position.nearTpSeen || position.reachedHalfR || position.reachedOneR) &&
      (
        mfeR < 0.25 ||
        maeR <= -0.8
      )
    );
}

function copyMicroClassificationFields(position = {}) {
  const childFromPosition = normalizeChildTrueMicroFamilyId(
    position.trueMicroFamilyId ||
      position.microFamilyId ||
      position.childTrueMicroFamilyId,
    position
  );

  const taxonomy = childFromPosition
    ? parseLongTaxonomyMicroId(childFromPosition)
    : extractFixedTaxonomyMicroId(position, position);

  const microFamilyId = childFromPosition || taxonomy?.trueMicroFamilyId || '';
  const parsed = parseLongTaxonomyMicroId(microFamilyId);

  if (!parsed.isChild) {
    return withAnalyzeIdentityFlags({
      outcomeIdentityLocked: false,
      outcomeIdentitySource: 'POSITION_MICRO_IDENTITY_MISSING',
      learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
      symbolExcludedFromFamilyId: true
    });
  }

  const parentTrueMicroFamilyId = parsed.parentTrueMicroFamilyId;

  return withAnalyzeIdentityFlags({
    familyId: position.familyId || 'LONG_FIXED_TAXONOMY',

    microFamilyId,
    trueMicroFamilyId: microFamilyId,
    childTrueMicroFamilyId: microFamilyId,

    coarseMicroFamilyId: parentTrueMicroFamilyId,
    baseMicroFamilyId: parentTrueMicroFamilyId,
    legacyMicroFamilyId: parentTrueMicroFamilyId,

    parentTrueMicroFamilyId,
    parentMicroFamilyId: parentTrueMicroFamilyId,
    macroFamilyId: parentTrueMicroFamilyId,
    parentMacroFamilyId: parentTrueMicroFamilyId,

    broadTrueMicroFamilyId: microFamilyId,
    broadTrueDefinitionParts: position.broadTrueDefinitionParts || [],
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    fineMicroFamilyAsMetadataOnly: true,
    fixedTaxonomyLearningId: true,

    setupType: parsed.setup,
    regimeBucket: parsed.regime,
    confirmationProfile: parsed.confirmationProfile,

    executionFingerprintHash: position.executionFingerprintHash || null,
    executionFingerprintParts: position.executionFingerprintParts || [],
    executionFingerprintSchema: position.executionFingerprintSchema || null,
    executionMicroFamilyId: position.executionMicroFamilyId || null,
    executionFingerprintRole: 'METADATA_ONLY',

    scannerMicroFamilyId: position.scannerMicroFamilyId || null,
    scannerFamilyId: position.scannerFamilyId || null,
    scannerDefinition: position.scannerDefinition || null,
    scannerDefinitionParts: position.scannerDefinitionParts || [],
    scannerFingerprintRole: 'METADATA_ONLY',

    definitionParts: position.definitionParts || [],
    definition: position.definition || null,

    parentDefinition: position.parentDefinition || null,
    parentDefinitionParts: position.parentDefinitionParts || [],

    schema: TRUE_MICRO_SCHEMA,
    microFamilySchema: TRUE_MICRO_SCHEMA,
    version: 'fixed-taxonomy-75-child-smart-evidence-v2',

    assetClass: position.assetClass || null,

    rsiZone: position.rsiZone || null,
    rsiCoarse: position.rsiCoarse || null,
    rsiSlope: position.rsiSlope ?? null,
    rsiVelocity: position.rsiVelocity ?? null,
    rsiDelta: position.rsiDelta ?? null,
    rsiMomentum: position.rsiMomentum ?? null,

    obRelation: position.obRelation || null,
    obBias: position.obBias ?? null,
    obImbalance: position.obImbalance ?? null,
    orderbookImbalance: position.orderbookImbalance ?? null,
    bookImbalance: position.bookImbalance ?? null,
    bidAskImbalance: position.bidAskImbalance ?? null,

    spoofScore: position.spoofScore ?? null,
    orderbookSpoofScore: position.orderbookSpoofScore ?? null,
    obSpoofScore: position.obSpoofScore ?? null,
    fakeLiquidityScore: position.fakeLiquidityScore ?? null,

    btcState: position.btcState || null,
    btcRelation: position.btcRelation || null,

    flow: position.flow || null,
    flowCoarse: position.flowCoarse || null,

    regime: position.regime || null,
    regimeCoarse: position.regimeCoarse || null,

    confluence: position.confluence ?? null,
    sniperScore: position.sniperScore ?? null,

    scannerReason: position.scannerReason || null,
    scannerReasonCoarse: position.scannerReasonCoarse || null,

    spreadPct: position.spreadPct ?? null,
    exitSpreadPct: position.exitSpreadPct ?? null,
    spreadBps: position.spreadBps ?? null,

    depthMinUsd1p: position.depthMinUsd1p ?? null,
    fundingRate: position.fundingRate ?? null,

    entryQuality: position.entryQuality || null,
    retestConfirmed: Boolean(position.retestConfirmed),
    pullbackConfirmed: Boolean(position.pullbackConfirmed),
    sweepConfirmed: Boolean(position.sweepConfirmed),
    fakeBreakout: Boolean(position.fakeBreakout),
    fakeBreakoutRisk: Boolean(position.fakeBreakoutRisk),

    entryDistancePct: position.entryDistancePct ?? null,
    entryDistanceToMidPct: position.entryDistanceToMidPct ?? null,
    pullbackDistancePct: position.pullbackDistancePct ?? null,
    distanceToEntryPct: position.distanceToEntryPct ?? null,
    distancePct: position.distancePct ?? null,

    slDistancePct: position.slDistancePct ?? null,
    stopDistancePct: position.stopDistancePct ?? null,
    stopLossDistancePct: position.stopLossDistancePct ?? null,

    tpDistancePct: position.tpDistancePct ?? null,
    takeProfitDistancePct: position.takeProfitDistancePct ?? null,

    liqDistancePct: position.liqDistancePct ?? null,
    liquidationDistancePct: position.liquidationDistancePct ?? null,
    distanceToLiquidationPct: position.distanceToLiquidationPct ?? null,
    nearestLiqDistancePct: position.nearestLiqDistancePct ?? null,

    atrPct: position.atrPct ?? null,
    volatilityPct: position.volatilityPct ?? null,
    rangePct: position.rangePct ?? null,
    realizedVolPct: position.realizedVolPct ?? null,

    costR: position.costR ?? position.estimatedCostR ?? null,
    avgCostR: position.avgCostR ?? null,
    estimatedCostR: position.estimatedCostR ?? null,

    entryMarketWeather: position.entryMarketWeather || null,
    entryCurrentRegime: position.entryCurrentRegime || position.currentRegime || null,
    entryCurrentTrendSide: position.entryCurrentTrendSide || position.currentTrendSide || null,
    entryCurrentFit: position.entryCurrentFit ?? position.currentFit ?? null,
    entryCurrentFitConfidence: position.entryCurrentFitConfidence ?? position.currentMarketFitConfidence ?? null,
    entryWeatherFitMatchedFamily: position.entryWeatherFitMatchedFamily ?? null,

    classifierVersion: CLASSIFIER_VERSION,
    noDefaultRetestSqueezeB: true,
    measurementFixVersion: MEASUREMENT_FIX_VERSION,

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    learningRemainsBroad: true,

    outcomeIdentityLocked: true,
    outcomeIdentitySource: 'POSITION_MICRO_IDENTITY',
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true
  });
}

export function buildOutcomeFromPosition({
  position,
  exitPrice,
  exitReason,
  source = OUTCOME_SOURCE
}) {
  if (!position) {
    throw new Error('POSITION_REQUIRED_FOR_OUTCOME');
  }

  const entry = safeNumber(position.entry, 0);
  const initialSl = safeNumber(position.initialSl || position.sl, 0);
  const exit = safeNumber(exitPrice, 0);
  const tp = safeNumber(position.tp, 0);

  const validLongRiskShape =
    entry > 0 &&
    initialSl > 0 &&
    tp > 0 &&
    initialSl < entry &&
    entry < tp;

  const riskPct =
    safeNumber(position.riskPct, 0) ||
    calcRiskPct({
      entry,
      sl: initialSl
    });

  const grossMovePct = calcGrossMovePct({
    side: TARGET_TRADE_SIDE,
    entry,
    exit
  });

  const grossR = validLongRiskShape
    ? calcLongGrossR({
      entry,
      initialSl,
      exit
    })
    : 0;

  const cost = applyCosts({
    side: TARGET_TRADE_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    grossMovePct,
    riskPct,
    entrySpreadPct: safeNumber(position.spreadPct, 0),
    exitSpreadPct: safeNumber(position.exitSpreadPct ?? position.spreadPct, 0)
  });

  const costR = safeNumber(cost.costR, 0);

  const netR = safeNumber(
    cost.netR,
    grossR - costR
  );

  const closedAt = now();
  const src = normalizeSource(source);
  const classification = copyMicroClassificationFields(position);
  const directToSL = inferDirectToSL({
    position,
    exitReason
  });

  return withAnalyzeIdentityFlags({
    type: 'OUTCOME',
    source: src,
    outcomeSource: OUTCOME_SOURCE,
    positionSource: position.source || 'VIRTUAL',

    strategyVersion: CONFIG.strategyVersion,

    tradeId: position.tradeId,
    positionId: position.positionId || position.id || null,

    symbol: position.symbol,
    contractSymbol: position.contractSymbol,

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

    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: true,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    ...classification,

    entry,
    exit,
    exitPrice: exit,
    sl: safeNumber(position.sl, 0),
    initialSl,
    tp,
    rr: safeNumber(position.rr, 0),
    riskPct,

    validLongRiskShape,
    exitReason,

    grossMovePct,

    grossR,
    rawR: grossR,
    realizedGrossR: grossR,
    grossPnlPct: safeNumber(cost.grossPnlPct, grossMovePct),

    exitR: netR,
    pnlPct: safeNumber(cost.netPnlPct, 0),
    netR,
    realizedNetR: netR,
    realizedR: netR,
    r: netR,
    netPnlPct: safeNumber(cost.netPnlPct, 0),

    costR,
    avgCostR: costR,
    costPct: safeNumber(cost.costPct, 0),
    feePct: safeNumber(cost.feePct, 0),
    slippagePct: safeNumber(cost.slippagePct, 0),

    win: netR > 0,
    loss: netR < 0,
    flat: netR === 0,
    isWin: netR > 0,

    costModelApplied: true,
    netCostModelApplied: true,
    costModel: 'APPLY_COSTS_NET_R_V1',

    mfeR: safeNumber(position.mfeR, 0),
    maeR: safeNumber(position.maeR, 0),

    directToSL,
    directSL: directToSL,

    nearTpSeen: Boolean(position.nearTpSeen),
    reachedHalfR: Boolean(position.reachedHalfR),
    reachedOneR: Boolean(position.reachedOneR),

    beArmed: Boolean(position.beArmed),
    beWouldExit: Boolean(position.beWouldExit),
    beExitR: safeNumber(position.beExitR, 0),

    gaveBackAfterHalfR: Boolean(position.gaveBackAfterHalfR),
    gaveBackAfterOneR: Boolean(position.gaveBackAfterOneR),
    nearTpThenLoss: Boolean(position.nearTpThenLoss),

    entryMarketWeather: position.entryMarketWeather || null,
    entryCurrentRegime: position.entryCurrentRegime || position.currentRegime || null,
    entryCurrentTrendSide: position.entryCurrentTrendSide || position.currentTrendSide || null,
    entryCurrentFit: position.entryCurrentFit ?? position.currentFit ?? null,
    entryCurrentFitConfidence: position.entryCurrentFitConfidence ?? position.currentMarketFitConfidence ?? null,
    entryWeatherFitMatchedFamily: position.entryWeatherFitMatchedFamily ?? null,

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    learningRemainsBroad: true,

    openedAt: position.openedAt || position.createdAt || null,
    closedAt,
    completedAt: closedAt
  });
}

export async function getAnalyzeMicroRowsByIds(weekKey = PERSISTENT_LEARNING_KEY, ids = []) {
  return getWeekMicrosByIds(weekKey, ids);
}