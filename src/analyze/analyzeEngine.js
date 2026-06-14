// ================= FILE: src/analyze/analyzeEngine.js =================

import { gzipSync, gunzipSync } from 'zlib';
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

const WEEK_MICROS_CODEC = 'ANALYZE_WEEK_MICROS_GZIP_V1';
const WEEK_MICRO_ROW_CODEC = 'ANALYZE_WEEK_MICRO_ROW_GZIP_V1';
const WEEK_MICROS_TOP_CODEC = 'ANALYZE_WEEK_MICROS_TOP_GZIP_V1';

const DEFAULT_MAX_REDIS_SET_BYTES = 9_500_000;
const DEFAULT_MAX_ROW_SET_BYTES = 250_000;

const DEFAULT_TOP_MICROS_SNAPSHOT_LIMIT = 300;
const DEFAULT_MAX_FULL_READ_MICRO_ROWS = 1_500;
const DEFAULT_FULL_READ_SOFT_TIMEOUT_MS = 2_400;

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const TARGET_SCANNER_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;

const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';

const OBSERVATION_SOURCE = 'VIRTUAL';
const OUTCOME_SOURCE = 'VIRTUAL';

const EXECUTION_MICRO_SUFFIX = 'XR';
const EXECUTION_MICRO_HASH_LEN = 10;

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_V1';

const FALLBACK_TRUE_MICRO_SCHEMA = 'MF_V3';
const TRUE_MICRO_HASH_LEN = 8;

const MIN_COMPLETED_ACTIVE_LEARNING = 20;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;

const TRUE_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'n', 'off']);

const LONG_SETUP_ORDER = [
  'BREAKOUT',
  'RETEST',
  'SWEEP_REVERSAL',
  'CONTINUATION',
  'COMPRESSION'
];

const LONG_REGIME_ORDER = [
  'TREND',
  'CHOP',
  'SQUEEZE'
];

const CONFIRMATION_PROFILE_ORDER = [
  'A_STRONG_ALIGN',
  'B_FLOW_ALIGN',
  'C_VOLUME_ALIGN',
  'D_MIXED_OK',
  'E_WEAK_CONTRA'
];

const LONG_FIXED_SETUP_TYPES = new Set(LONG_SETUP_ORDER);
const LONG_FIXED_REGIME_BUCKETS = new Set(LONG_REGIME_ORDER);
const LONG_CONFIRMATION_PROFILES = new Set(CONFIRMATION_PROFILE_ORDER);

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
  COMPRESSION: 'SQUEEZE',
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

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;

  const raw = String(value).trim().toLowerCase();

  if (TRUE_VALUES.has(raw)) return true;
  if (FALSE_VALUES.has(raw)) return false;

  return fallback;
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
    .replaceAll('SHORT_DISABLED', '')
    .replaceAll('SHORTDISABLED', '')
    .replaceAll('BLOCK_SHORT', '')
    .replaceAll('LONG_ONLY_MODE', 'LONG')
    .replaceAll('LONG_ONLY', 'LONG')
    .replaceAll('LONG-ONLY', 'LONG');
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
    if (normalized.includes('MICRO_LONG')) return TARGET_TRADE_SIDE;
    if (normalized.includes('MICRO_SHORT')) return OPPOSITE_TRADE_SIDE;
    if (normalized.includes('TRADE_SIDE_LONG') || normalized.includes('TRADESIDE_LONG')) return TARGET_TRADE_SIDE;
    if (normalized.includes('TRADE_SIDE_SHORT') || normalized.includes('TRADESIDE_SHORT')) return OPPOSITE_TRADE_SIDE;
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

  for (const candidateRegime of LONG_REGIME_ORDER) {
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

function isFixedTaxonomyMicroId(id = '') {
  return isFixedTaxonomyChildMicroId(id);
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

  if (raw.includes('SWEEP') || raw.includes('REVERSAL')) return 'SWEEP_REVERSAL';
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

  if (raw.includes('SQUEEZE') || raw.includes('COMPRESSION') || raw.includes('TIGHT')) return 'SQUEEZE';
  if (raw.includes('CHOP') || raw.includes('RANGE') || raw.includes('SIDEWAYS')) return 'CHOP';
  if (raw.includes('TREND') || raw.includes('IMPULSE') || raw.includes('MOMENTUM')) return 'TREND';

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
  if (raw.includes('VOLUME') || raw.includes('VOL_') || raw.includes('OB_')) return 'C_VOLUME_ALIGN';
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

function firstNormalizedConfirmation(...values) {
  for (const value of values) {
    const profile = normalizeConfirmationProfile(value);

    if (profile) return profile;
  }

  return null;
}

function inferSetupType(row = {}, classified = {}) {
  const fromFields = firstNormalizedSetup(
    classified.setupType,
    classified.setup,
    classified.longSetup,
    classified.pattern,
    row.setupType,
    row.setup,
    row.longSetup,
    row.pattern,
    row.scannerReason,
    row.reason,
    row.signalReason,
    row.entryQuality
  );

  if (fromFields) return fromFields;

  if (row.sweepConfirmed || row.liquiditySweep || row.stopRun || row.reversalSetup) return 'SWEEP_REVERSAL';
  if (row.retestConfirmed || row.pullbackConfirmed || row.retestSetup || row.pullbackSetup) return 'RETEST';
  if (row.squeezeBreak || row.compressionBreak || row.volCompression || row.rangeCompression) return 'COMPRESSION';
  if (row.breakoutConfirmed || row.breakoutSetup || row.newHighBreakout) return 'BREAKOUT';

  const text = [
    classified.definition,
    classified.microDefinition,
    row.definition,
    row.microDefinition,
    ...(Array.isArray(classified.definitionParts) ? classified.definitionParts : []),
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : [])
  ].map(upper).join('|');

  if (text.includes('SWEEP') || text.includes('REVERSAL')) return 'SWEEP_REVERSAL';
  if (text.includes('RETEST') || text.includes('PULLBACK')) return 'RETEST';
  if (text.includes('COMPRESSION') || text.includes('SQUEEZE') || text.includes('COIL')) return 'COMPRESSION';
  if (text.includes('BREAKOUT')) return 'BREAKOUT';

  return 'CONTINUATION';
}

function inferRegimeBucket(row = {}, classified = {}) {
  const fromFields = firstNormalizedRegime(
    classified.regimeBucket,
    classified.regimeCoarse,
    classified.regime,
    row.regimeBucket,
    row.regimeCoarse,
    row.regime,
    row.marketRegime,
    row.btcState,
    row.scannerReason,
    row.reason
  );

  if (fromFields) return fromFields;

  if (row.squeezeRegime || row.volCompression || row.rangeCompression || row.squeezeActive) return 'SQUEEZE';
  if (row.chopRegime || row.rangeRegime || row.sidewaysRegime) return 'CHOP';

  const text = [
    classified.definition,
    classified.microDefinition,
    row.definition,
    row.microDefinition,
    ...(Array.isArray(classified.definitionParts) ? classified.definitionParts : []),
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : [])
  ].map(upper).join('|');

  if (text.includes('SQUEEZE') || text.includes('COMPRESSION')) return 'SQUEEZE';
  if (text.includes('CHOP') || text.includes('RANGE') || text.includes('SIDEWAYS')) return 'CHOP';

  return 'TREND';
}

function boolish(...values) {
  return values.some((value) => value === true || value === 'true' || value === 1 || value === '1');
}

function positiveNumber(...values) {
  return values.some((value) => safeNumber(value, 0) > 0);
}

function inferConfirmationProfile(row = {}, classified = {}) {
  const explicit = firstNormalizedConfirmation(
    classified.confirmationProfile,
    classified.confirmation,
    classified.confirmProfile,
    row.confirmationProfile,
    row.confirmation,
    row.confirmProfile,
    row.trueMicroFamilyId,
    row.microFamilyId,
    classified.trueMicroFamilyId,
    classified.microFamilyId
  );

  if (explicit) return explicit;

  const confluence = safeNumber(
    row.confluence ??
      row.sniperScore ??
      row.scannerScore ??
      row.moveScore ??
      classified.confluence,
    0
  );

  const flowValue = safeNumber(
    row.flowScore ??
      row.flowStrength ??
      row.momentumScore ??
      classified.flowScore ??
      0,
    0
  );

  const volumeValue = safeNumber(
    row.volumeScore ??
      row.relativeVolume ??
      row.volumeSpike ??
      row.quoteVolumeSpike ??
      classified.volumeScore ??
      0,
    0
  );

  const hasStrongAlign = boolish(
    row.strongAlign,
    row.allAlign,
    row.fullAlign,
    row.structureAlign && row.flowAlign && row.volumeAlign,
    classified.strongAlign
  );

  const hasFlowAlign = boolish(
    row.flowAlign,
    row.momentumAlign,
    row.bidFlowAlign,
    classified.flowAlign
  ) || flowValue >= 55;

  const hasVolumeAlign = boolish(
    row.volumeAlign,
    row.volumeSpikeConfirmed,
    row.obVolumeAlign,
    classified.volumeAlign
  ) || volumeValue >= 1.4;

  const hasContra = boolish(
    row.weakContra,
    row.contraSignal,
    row.bearishDivergence,
    row.fakeBreakoutRisk,
    classified.weakContra
  );

  if (hasStrongAlign || confluence >= 75) return 'A_STRONG_ALIGN';
  if (hasFlowAlign || confluence >= 62) return 'B_FLOW_ALIGN';
  if (hasVolumeAlign || positiveNumber(row.volumeSpike, row.relativeVolume)) return 'C_VOLUME_ALIGN';
  if (!hasContra || confluence >= 35) return 'D_MIXED_OK';

  return 'E_WEAK_CONTRA';
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
  const candidates = [
    source.trueMicroFamilyId,
    source.microFamilyId,
    source.childTrueMicroFamilyId,
    source.analyzeMicroFamilyId,
    source.learningMicroFamilyId,
    source.broadTrueMicroFamilyId,
    source.fixedTaxonomyMicroFamilyId,
    classified.trueMicroFamilyId,
    classified.microFamilyId,
    classified.childTrueMicroFamilyId
  ];

  for (const candidate of candidates) {
    const parsed = parseLongTaxonomyMicroId(candidate);

    if (parsed.isChild) {
      return {
        ...parsed,
        setupType: parsed.setup,
        regimeBucket: parsed.regime,
        confirmationProfile: parsed.confirmationProfile,
        microFamilyId: parsed.childTrueMicroFamilyId,
        trueMicroFamilyId: parsed.childTrueMicroFamilyId,
        childTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
        coarseMicroFamilyId: parsed.parentTrueMicroFamilyId,
        parentMicroFamilyId: parsed.parentTrueMicroFamilyId,
        macroFamilyId: parsed.parentTrueMicroFamilyId,
        parentMacroFamilyId: parsed.parentTrueMicroFamilyId,
        fixedTaxonomyLearningId: true
      };
    }
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

  if (isMicroFamilyV3Id(raw) || isMicroFamilyV2Id(raw) || isMicroFamilyV1Id(raw)) {
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

  const child = normalizeChildTrueMicroFamilyId(row.trueMicroFamilyId || row.microFamilyId || '', row);
  const childParsed = parseLongTaxonomyMicroId(child);

  return childParsed.parentTrueMicroFamilyId || '';
}

function isMicroFamilyV3Id(id = '') {
  const value = upper(id);

  return (
    value.startsWith('MICRO_LONG_') &&
    value.includes(`_${FALLBACK_TRUE_MICRO_SCHEMA}_`)
  );
}

function isAnalyzeMicroFamilyId(id = '') {
  const value = upper(id);

  if (!value) return false;
  if (!validLearningId(value)) return false;
  if (isFixedTaxonomyChildMicroId(value)) return true;
  if (isFixedTaxonomyParentMicroId(value)) return false;

  return (
    value.startsWith('MICRO_LONG_') &&
    (
      isMicroFamilyV3Id(value) ||
      isMicroFamilyV2Id(value) ||
      isMicroFamilyV1Id(value) ||
      value.includes('_MF_V3_') ||
      value.includes('_MF_V2_') ||
      value.includes('_MF_V1_')
    )
  );
}

function analyzeIdentityFlags() {
  return {
    scannerFingerprintLegacy: false,
    legacyScannerFamilyFallback: false,
    scannerFingerprintOnlyMetadata: true,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

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
    childTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,

    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchemaName: PARENT_TRUE_MICRO_SCHEMA,

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

    bucketGranularity: 'LOW_MID_HIGH',
    bucketsCoarseOnly: true,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,

    positionTimeStopMinDefault: DEFAULT_POSITION_TIME_STOP_MIN,

    validLongRiskShape: 'entry > 0 && sl < entry && tp > entry',
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

    virtualLearning: true,
    virtualOnly: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,

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
      row.microFamilyId,
      row.trueMicroFamilyId,
      row.id,
      row.key
    ]);

    if (explicitIdSide !== 'UNKNOWN') return explicitIdSide;

    if (row.longOnly === true || row.shortDisabled === true) {
      return TARGET_TRADE_SIDE;
    }

    return OPPOSITE_TRADE_SIDE;
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

  if (row.longOnly === true || row.shortDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  if (row.shortOnly === true || row.longDisabled === true) {
    return OPPOSITE_TRADE_SIDE;
  }

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

function shouldUseBroadTrueMicroFamilies() {
  return CONFIG?.analyze?.broadTrueMicroFamilies !== false;
}

function getAnalyzeSchemaMeta() {
  return {
    schema: CONFIG?.analyze?.schema,
    macroSchema: PARENT_TRUE_MICRO_SCHEMA,
    microSchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    fallbackMicroSchema: CONFIG?.analyze?.microSchema || 'MF_V2',
    fallbackTrueMicroSchema: FALLBACK_TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    strategyVersion: CONFIG.strategyVersion
  };
}

function getWeekStorageConfig() {
  return {
    compressionEnabled: CONFIG?.analyze?.weekMicrosCompressionEnabled !== false,

    compressionLevel: Math.max(
      1,
      Math.min(9, Math.floor(safeNumber(CONFIG?.analyze?.weekMicrosCompressionLevel, 6)))
    ),

    maxRedisSetBytes: Math.max(
      500_000,
      Math.floor(safeNumber(CONFIG?.redis?.maxRequestBytes, DEFAULT_MAX_REDIS_SET_BYTES))
    ),

    maxRowSetBytes: Math.max(
      50_000,
      Math.floor(safeNumber(CONFIG?.analyze?.maxMicroRowSetBytes, DEFAULT_MAX_ROW_SET_BYTES))
    ),

    weekMicrosTtlSec: Math.max(
      60 * 60,
      Math.floor(safeNumber(CONFIG?.analyze?.weekMicrosTtlSec, 60 * 60 * 24 * 21))
    ),

    weekMetaTtlSec: Math.max(
      60 * 60,
      Math.floor(safeNumber(CONFIG?.analyze?.weekMetaTtlSec, 60 * 60 * 24 * 90))
    ),

    storageConcurrency: Math.max(
      1,
      Math.min(20, Math.floor(safeNumber(CONFIG?.analyze?.storageConcurrency, 8)))
    ),

    topMicrosSnapshotLimit: Math.max(
      25,
      Math.min(
        1_000,
        Math.floor(safeNumber(CONFIG?.analyze?.topMicrosSnapshotLimit, DEFAULT_TOP_MICROS_SNAPSHOT_LIMIT))
      )
    ),

    maxFullReadMicroRows: Math.max(
      25,
      Math.floor(safeNumber(CONFIG?.analyze?.maxFullReadMicroRows, DEFAULT_MAX_FULL_READ_MICRO_ROWS))
    ),

    fullReadSoftTimeoutMs: Math.max(
      250,
      Math.floor(safeNumber(CONFIG?.analyze?.fullReadSoftTimeoutMs, DEFAULT_FULL_READ_SOFT_TIMEOUT_MS))
    ),

    preferTopSnapshotOnLargeIndex: CONFIG?.analyze?.preferTopSnapshotOnLargeIndex !== false,

    maxExamplesPerMicro: Math.max(
      0,
      Math.floor(safeNumber(CONFIG?.analyze?.maxExamplesPerMicro, 8))
    ),

    maxRecentOutcomesPerMicro: Math.max(
      0,
      Math.floor(safeNumber(CONFIG?.analyze?.maxRecentOutcomesPerMicro, 8))
    ),

    maxDefinitionPartsPerMicro: Math.max(
      4,
      Math.floor(safeNumber(CONFIG?.analyze?.maxDefinitionPartsPerMicro, 64))
    ),

    maxParentDefinitionPartsPerMicro: Math.max(
      4,
      Math.floor(safeNumber(CONFIG?.analyze?.maxParentDefinitionPartsPerMicro, 48))
    ),

    maxCounterKeysPerMicro: Math.max(
      4,
      Math.floor(safeNumber(CONFIG?.analyze?.maxCounterKeysPerMicro, 18))
    ),

    maxCounterValuesPerCounter: Math.max(
      4,
      Math.floor(safeNumber(CONFIG?.analyze?.maxCounterValuesPerCounter, 24))
    ),

    maxStringLength: Math.max(
      80,
      Math.floor(safeNumber(CONFIG?.analyze?.maxStoredStringLength, 480))
    )
  };
}

function getWeekMicrosBaseKey(weekKey) {
  return longKey(KEYS.analyze.weekMicros(weekKey));
}

function getWeekMetaKey(weekKey) {
  return longKey(KEYS.analyze.weekMeta(weekKey));
}

function getObsLastKey(snapshotId, symbol, microFamilyId) {
  return longKey(KEYS.analyze.obsLast(snapshotId, symbol, microFamilyId));
}

function getWeekMicrosIndexKey(weekKey) {
  return `${getWeekMicrosBaseKey(weekKey)}:INDEX`;
}

function getWeekMicrosTopKey(weekKey) {
  return `${getWeekMicrosBaseKey(weekKey)}:TOP`;
}

function getWeekMicroRowKey(weekKey, microFamilyId) {
  return `${getWeekMicrosBaseKey(weekKey)}:ROW:${microFamilyId}`;
}

async function mapLimit(items = [], concurrency = 8, worker) {
  const rows = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Math.floor(Number(concurrency) || 1));
  const results = new Array(rows.length);

  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < rows.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(rows[index], index);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(limit, rows.length) },
      () => runWorker()
    )
  );

  return results;
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function normalizeStatsSide() {
  return TARGET_DASHBOARD_SIDE;
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

function compactCounterValues(counter = {}, maxValues = 24) {
  if (!counter || typeof counter !== 'object') return {};

  return Object.fromEntries(
    Object.entries(counter)
      .sort((a, b) => safeNumber(b[1], 0) - safeNumber(a[1], 0))
      .slice(0, maxValues)
      .map(([key, value]) => [
        truncateString(key, 160),
        safeNumber(value, 0)
      ])
  );
}

function compactCounters(counters = {}, maxKeys = 18, maxValues = 24) {
  if (!counters || typeof counters !== 'object') return {};

  return Object.fromEntries(
    Object.entries(counters)
      .slice(0, maxKeys)
      .map(([key, value]) => [
        truncateString(key, 160),
        compactCounterValues(value, maxValues)
      ])
  );
}

function compactExample(example, maxStringLength = 480) {
  if (typeof example === 'string') {
    return truncateString(example, maxStringLength);
  }

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

  return {
    symbol: example.symbol || example.baseSymbol || example.contractSymbol || null,
    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    source: example.source || OBSERVATION_SOURCE,

    rsiZone: example.rsiZone || null,
    rsiCoarse: example.rsiCoarse || null,

    flow: example.flow || null,
    flowCoarse: example.flowCoarse || null,

    obRelation: example.obRelation || null,

    btcRelation: example.btcRelation || null,
    btcState: example.btcState || null,

    regime: example.regime || null,
    regimeCoarse: example.regimeCoarse || null,

    scannerReason: example.scannerReason || null,
    scannerReasonCoarse: example.scannerReasonCoarse || null,

    scannerMicroFamilyId: example.scannerMicroFamilyId || null,
    scannerFamilyId: example.scannerFamilyId || null,

    microFamilyId: childId || null,
    trueMicroFamilyId: childId || null,
    childTrueMicroFamilyId: childId || null,
    coarseMicroFamilyId: parentId || null,
    parentTrueMicroFamilyId: parentId || null,
    parentMicroFamilyId: parentId || null,
    macroFamilyId: parentId || null,
    parentMacroFamilyId: parentId || null,

    setupType: parsed.setup || example.setupType || null,
    regimeBucket: parsed.regime || example.regimeBucket || null,
    confirmationProfile: parsed.confirmationProfile || example.confirmationProfile || null,

    observationOnly: Boolean(example.observationOnly),
    analysisInputOnly: Boolean(example.analysisInputOnly),
    learningOnly: Boolean(example.learningOnly),

    isMirrorMicroFamily: false,
    observationMirror: false,
    analysisMirror: false,

    ...analyzeIdentityFlags(),

    ts: safeNumber(example.ts || example.createdAt, null)
  };
}

function compactExamples(examples = [], maxItems = 8, maxStringLength = 480) {
  if (!Array.isArray(examples) || maxItems <= 0) return [];

  return examples
    .slice(-maxItems)
    .map((example) => compactExample(example, maxStringLength))
    .filter((example) => example !== null && example !== undefined);
}

function compactOutcome(outcome = {}) {
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
  const src = normalizeSource(outcome.source || OUTCOME_SOURCE);

  return {
    source: src,
    positionSource: outcome.positionSource || null,

    tradeId: outcome.tradeId || null,

    symbol: outcome.symbol || outcome.baseSymbol || outcome.contractSymbol || null,
    contractSymbol: outcome.contractSymbol || null,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,

    exitReason: outcome.exitReason || outcome.reason || null,

    exitR: safeNumber(outcome.exitR ?? outcome.netR, 0),
    netR: safeNumber(outcome.netR ?? outcome.exitR, 0),
    grossR: safeNumber(outcome.grossR, 0),

    pnlPct: safeNumber(outcome.pnlPct ?? outcome.netPnlPct, 0),
    netPnlPct: safeNumber(outcome.netPnlPct ?? outcome.pnlPct, 0),
    grossPnlPct: safeNumber(outcome.grossPnlPct, 0),

    costR: safeNumber(outcome.costR, 0),
    costPct: safeNumber(outcome.costPct, 0),
    feePct: safeNumber(outcome.feePct, 0),
    slippagePct: safeNumber(outcome.slippagePct, 0),

    mfeR: safeNumber(outcome.mfeR, 0),
    maeR: safeNumber(outcome.maeR, 0),

    directToSL: Boolean(outcome.directToSL),
    nearTpSeen: Boolean(outcome.nearTpSeen),
    reachedHalfR: Boolean(outcome.reachedHalfR),
    reachedOneR: Boolean(outcome.reachedOneR),

    beArmed: Boolean(outcome.beArmed),
    beWouldExit: Boolean(outcome.beWouldExit),
    beExitR: safeNumber(outcome.beExitR, 0),

    gaveBackAfterHalfR: Boolean(outcome.gaveBackAfterHalfR),
    gaveBackAfterOneR: Boolean(outcome.gaveBackAfterOneR),
    nearTpThenLoss: Boolean(outcome.nearTpThenLoss),

    microFamilyId: childId,
    trueMicroFamilyId: childId,
    childTrueMicroFamilyId: childId,
    coarseMicroFamilyId: parentId,
    parentTrueMicroFamilyId: parentId,
    parentMicroFamilyId: parentId,
    macroFamilyId: parentId,
    parentMacroFamilyId: parentId,

    setupType: parsed.setup || null,
    regimeBucket: parsed.regime || null,
    confirmationProfile: parsed.confirmationProfile || null,

    virtualOnly: outcome.virtualOnly !== false,
    virtualTracked: outcome.virtualTracked !== false,
    shadowOnly: outcome.shadowOnly !== false,

    costModelApplied: Boolean(outcome.costModelApplied),
    netCostModelApplied: Boolean(outcome.netCostModelApplied),
    costModel: outcome.costModel || null,

    isMirrorMicroFamily: false,

    ...analyzeIdentityFlags(),

    ts: safeNumber(
      outcome.ts ||
      outcome.closedAt ||
      outcome.completedAt ||
      outcome.updatedAt,
      now()
    )
  };
}

function compactRecentOutcomes(outcomes = [], maxItems = 8) {
  if (!Array.isArray(outcomes) || maxItems <= 0) return [];

  return outcomes
    .slice(-maxItems)
    .map(compactOutcome)
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
    .slice(0, 48) || fallback;
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

function boolBucket(value, label) {
  return `${label}=${value ? 'YES' : 'NO'}`;
}

function coarseNumberTier(value, {
  label,
  low,
  high,
  fallback = 'NA',
  lowLabel = 'LO',
  midLabel = 'MID',
  highLabel = 'HI'
} = {}) {
  const n = safeNumber(value, null);

  if (!Number.isFinite(n)) return `${label}=${fallback}`;
  if (n < low) return `${label}=${lowLabel}`;
  if (n >= high) return `${label}=${highLabel}`;

  return `${label}=${midLabel}`;
}

function coarsePctTier(value, {
  label,
  low,
  high,
  fallback = 'NA',
  lowLabel = 'LO',
  midLabel = 'MID',
  highLabel = 'HI'
} = {}) {
  const n = safeNumber(value, null);

  if (!Number.isFinite(n)) return `${label}=${fallback}`;

  const pct = Math.abs(n) <= 1 ? n * 100 : n;

  if (pct < low) return `${label}=${lowLabel}`;
  if (pct >= high) return `${label}=${highLabel}`;

  return `${label}=${midLabel}`;
}

function hashText(value, length = EXECUTION_MICRO_HASH_LEN) {
  return createHash('sha256')
    .update(String(value || ''))
    .digest('hex')
    .toUpperCase()
    .slice(0, length);
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
  const rsi = normalizeBroadBucketText(
    classified.rsiCoarse ||
    row.rsiCoarse ||
    classified.rsiZone ||
    row.rsiZone ||
    'NA'
  );

  const flow = normalizeBroadBucketText(
    classified.flowCoarse ||
    row.flowCoarse ||
    classified.flow ||
    row.flow ||
    'NA'
  );

  const obRelation = normalizeBroadBucketText(
    classified.obRelation ||
    row.obRelation ||
    'NA'
  );

  const btcState = normalizeBroadBucketText(
    classified.btcState ||
    row.btcState ||
    'NA'
  );

  const regime = normalizeBroadBucketText(
    classified.regimeCoarse ||
    row.regimeCoarse ||
    classified.regime ||
    row.regime ||
    taxonomy.regimeBucket ||
    'NA'
  );

  return mergeDefinitionParts([
    `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
    `TRUE_MICRO=${taxonomy.trueMicroFamilyId}`,
    `PARENT_TRUE_MICRO=${taxonomy.parentTrueMicroFamilyId}`,
    `SETUP=${taxonomy.setupType}`,
    `REGIME_BUCKET=${taxonomy.regimeBucket}`,
    `CONFIRMATION_PROFILE=${taxonomy.confirmationProfile}`,
    `RSI=${rsi}`,
    `FLOW=${flow}`,
    `OB_REL=${obRelation}`,
    `BTC_STATE=${btcState}`,
    `REGIME=${regime}`
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
  const scannerReason = firstDefined(
    classified.scannerReasonCoarse,
    row.scannerReasonCoarse,
    classified.scannerReason,
    row.scannerReason
  );

  const spreadBps = firstDefined(
    classified.spreadBps,
    row.spreadBps,
    row.spreadPct !== undefined ? safeNumber(row.spreadPct, 0) * 10_000 : null
  );

  const orderbookImbalance = firstDefined(
    row.orderbookImbalance,
    row.bookImbalance,
    row.bidAskImbalance,
    row.obImbalance,
    row.obBias
  );

  const spoofScore = firstDefined(
    row.spoofScore,
    row.orderbookSpoofScore,
    row.obSpoofScore,
    row.fakeLiquidityScore
  );

  const liqDistancePct = firstDefined(
    row.liqDistancePct,
    row.liquidationDistancePct,
    row.distanceToLiquidationPct,
    row.nearestLiqDistancePct
  );

  const entryDistancePct = firstDefined(
    row.entryDistancePct,
    row.entryDistanceToMidPct,
    row.pullbackDistancePct,
    row.distanceToEntryPct,
    row.distancePct
  );

  const slDistancePct = firstDefined(
    row.slDistancePct,
    row.stopDistancePct,
    row.stopLossDistancePct,
    row.riskPct
  );

  const tpDistancePct = firstDefined(
    row.tpDistancePct,
    row.takeProfitDistancePct,
    row.rewardPct
  );

  const volatilityPct = firstDefined(
    row.atrPct,
    row.volatilityPct,
    row.rangePct,
    row.realizedVolPct
  );

  const confluence = firstDefined(
    row.confluence,
    row.sniperScore,
    row.scannerScore,
    row.moveScore
  );

  const rr = firstDefined(
    row.rr,
    row.riskReward,
    row.rewardRisk
  );

  return mergeDefinitionParts([
    `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
    `TRUE_MICRO=${taxonomy.trueMicroFamilyId || 'NO_TRUE_MICRO'}`,
    `PARENT_TRUE_MICRO=${taxonomy.parentTrueMicroFamilyId || 'NO_PARENT_TRUE_MICRO'}`,
    `SETUP=${taxonomy.setupType || 'NA'}`,
    `REGIME_BUCKET=${taxonomy.regimeBucket || 'NA'}`,
    `CONFIRMATION_PROFILE=${taxonomy.confirmationProfile || 'NA'}`,

    `RSI=${normalizeBucketText(classified.rsiZone || row.rsiZone || 'NA')}`,
    `RSI_COARSE=${normalizeBucketText(classified.rsiCoarse || row.rsiCoarse || 'NA')}`,

    `FLOW=${normalizeBucketText(classified.flowCoarse || row.flowCoarse || classified.flow || row.flow || 'NA')}`,

    `OB_REL=${normalizeBucketText(classified.obRelation || row.obRelation || 'NA')}`,
    coarseNumberTier(orderbookImbalance, {
      label: 'OB_IMB',
      low: -0.25,
      high: 0.25,
      lowLabel: 'ASK_HEAVY',
      midLabel: 'BALANCED',
      highLabel: 'BID_HEAVY'
    }),
    coarseNumberTier(spoofScore, {
      label: 'SPOOF',
      low: 30,
      high: 70
    }),

    `BTC_STATE=${normalizeBucketText(classified.btcState || row.btcState || 'NA')}`,
    `BTC_REL=${normalizeBucketText(classified.btcRelation || row.btcRelation || 'NA')}`,

    `REGIME=${normalizeBucketText(classified.regimeCoarse || row.regimeCoarse || classified.regime || row.regime || 'NA')}`,

    `SCANNER=${normalizeBucketText(scannerReason || 'NA')}`,

    coarseNumberTier(spreadBps, {
      label: 'SPREAD',
      low: 4,
      high: 15,
      lowLabel: 'TIGHT',
      midLabel: 'NORMAL',
      highLabel: 'WIDE'
    }),
    coarseNumberTier(row.depthMinUsd1p, {
      label: 'DEPTH',
      low: 50_000,
      high: 300_000
    }),

    coarsePctTier(row.fundingRate, {
      label: 'FUNDING',
      low: -0.01,
      high: 0.01,
      lowLabel: 'NEG',
      midLabel: 'FLAT',
      highLabel: 'POS'
    }),

    coarsePctTier(entryDistancePct, {
      label: 'ENTRY_DIST',
      low: 0.25,
      high: 1.5,
      lowLabel: 'NEAR',
      midLabel: 'MID',
      highLabel: 'FAR'
    }),
    coarsePctTier(slDistancePct, {
      label: 'RISK',
      low: 0.7,
      high: 2.0,
      lowLabel: 'TIGHT',
      midLabel: 'NORMAL',
      highLabel: 'WIDE'
    }),
    coarsePctTier(tpDistancePct, {
      label: 'REWARD',
      low: 1.0,
      high: 3.5,
      lowLabel: 'SMALL',
      midLabel: 'NORMAL',
      highLabel: 'LARGE'
    }),
    coarsePctTier(liqDistancePct, {
      label: 'LIQ_DIST',
      low: 1.0,
      high: 5.0,
      lowLabel: 'NEAR',
      midLabel: 'MID',
      highLabel: 'FAR'
    }),
    coarsePctTier(volatilityPct, {
      label: 'VOL',
      low: 1.0,
      high: 4.0
    }),

    coarseNumberTier(rr, {
      label: 'RR',
      low: 1.2,
      high: 2.0
    }),

    coarseNumberTier(confluence, {
      label: 'CONFLUENCE',
      low: 35,
      high: 70
    }),

    `ENTRY_QUALITY=${normalizeBucketText(row.entryQuality || 'NA')}`,

    boolBucket(Boolean(row.fakeBreakout), 'FAKE_BO'),
    boolBucket(Boolean(row.fakeBreakoutRisk), 'FAKE_RISK')
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
  const rawClassified = normalizeClassifiedSide(safeClassifyMicro(classifyInput));

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
    version: 'fixed-taxonomy-75-child',

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

function compactMicroForStorage(row = {}, aggressive = false) {
  const cfg = getWeekStorageConfig();
  const refreshed = refreshStats(withAnalyzeIdentityFlags(removeKnownBulkyFields(row)));

  const trueMicroFamilyId = normalizeChildTrueMicroFamilyId(
    refreshed.trueMicroFamilyId || refreshed.microFamilyId,
    refreshed
  );

  if (!trueMicroFamilyId) return null;

  const taxonomy = parseLongTaxonomyMicroId(trueMicroFamilyId);
  const parentTrueMicroFamilyId = taxonomy.parentTrueMicroFamilyId;

  const maxStringLength = aggressive
    ? Math.max(80, Math.floor(cfg.maxStringLength / 2))
    : cfg.maxStringLength;

  const definitionParts = compactDefinitionParts(
    refreshed.definitionParts,
    aggressive ? 32 : cfg.maxDefinitionPartsPerMicro,
    maxStringLength
  );

  const parentDefinitionParts = compactDefinitionParts(
    refreshed.parentDefinitionParts,
    aggressive ? 24 : cfg.maxParentDefinitionPartsPerMicro,
    maxStringLength
  );

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
    broadTrueDefinitionParts: compactDefinitionParts(refreshed.broadTrueDefinitionParts, 16, maxStringLength),
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
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

    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    definitionParts,
    definition: definitionParts.length
      ? definitionParts.join(' | ')
      : truncateString(refreshed.definition || '', maxStringLength * 4),

    parentDefinitionParts,
    parentDefinition: parentDefinitionParts.length
      ? parentDefinitionParts.join(' | ')
      : truncateString(refreshed.parentDefinition || '', maxStringLength * 4),

    counters: aggressive
      ? {}
      : compactCounters(
        refreshed.counters,
        cfg.maxCounterKeysPerMicro,
        cfg.maxCounterValuesPerCounter
      ),

    examples: compactExamples(
      refreshed.examples,
      aggressive ? Math.min(3, cfg.maxExamplesPerMicro) : cfg.maxExamplesPerMicro,
      maxStringLength
    ),

    recentOutcomes: compactRecentOutcomes(
      refreshed.recentOutcomes,
      aggressive ? Math.min(3, cfg.maxRecentOutcomesPerMicro) : cfg.maxRecentOutcomesPerMicro
    )
  });
}

function getMinimalMicroForStorage(row = {}) {
  const refreshed = refreshStats(withAnalyzeIdentityFlags(removeKnownBulkyFields(row)));

  const trueMicroFamilyId = normalizeChildTrueMicroFamilyId(
    refreshed.trueMicroFamilyId || refreshed.microFamilyId,
    refreshed
  );

  if (!trueMicroFamilyId) return null;

  const taxonomy = parseLongTaxonomyMicroId(trueMicroFamilyId);
  const parentTrueMicroFamilyId = taxonomy.parentTrueMicroFamilyId;

  return withAnalyzeIdentityFlags({
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
    broadTrueDefinitionParts: compactDefinitionParts(refreshed.broadTrueDefinitionParts, 12, 120),
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,

    setupType: taxonomy.setup,
    regimeBucket: taxonomy.regime,
    confirmationProfile: taxonomy.confirmationProfile,

    executionFingerprintHash: refreshed.executionFingerprintHash || null,
    executionFingerprintParts: refreshed.executionFingerprintParts || [],
    executionFingerprintSchema: refreshed.executionFingerprintSchema || null,
    executionMicroFamilyId: refreshed.executionMicroFamilyId || null,
    executionFingerprintRole: refreshed.executionFingerprintRole || 'METADATA_ONLY',

    scannerMicroFamilyId: refreshed.scannerMicroFamilyId || null,
    scannerFamilyId: refreshed.scannerFamilyId || null,
    scannerDefinition: refreshed.scannerDefinition || null,
    scannerDefinitionParts: compactDefinitionParts(refreshed.scannerDefinitionParts, 12, 180),

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    familyId: refreshed.familyId || 'LONG_FIXED_TAXONOMY',

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

    schema: TRUE_MICRO_SCHEMA,
    microFamilySchema: TRUE_MICRO_SCHEMA,
    version: 'fixed-taxonomy-75-child',

    definitionParts: compactDefinitionParts(refreshed.definitionParts, 24, 180),
    definition: truncateString(refreshed.definition || '', 800),

    parentDefinitionParts: compactDefinitionParts(refreshed.parentDefinitionParts, 18, 180),
    parentDefinition: truncateString(refreshed.parentDefinition || '', 800),

    assetClass: refreshed.assetClass,

    obRelation: refreshed.obRelation,
    btcRelation: refreshed.btcRelation,
    btcState: refreshed.btcState,

    flow: refreshed.flow,
    flowCoarse: refreshed.flowCoarse,

    regime: refreshed.regime,
    regimeCoarse: refreshed.regimeCoarse,

    scannerReason: refreshed.scannerReason,
    scannerReasonCoarse: refreshed.scannerReasonCoarse,

    rsiZone: refreshed.rsiZone,
    rsiCoarse: refreshed.rsiCoarse,
    spreadBps: refreshed.spreadBps,

    seen: safeNumber(refreshed.seen, 0),
    observations: safeNumber(refreshed.observations, 0),

    completed: safeNumber(refreshed.completed, 0),
    realCompleted: 0,
    virtualCompleted: safeNumber(refreshed.virtualCompleted, 0),
    shadowCompleted: safeNumber(refreshed.shadowCompleted, 0),

    wins: safeNumber(refreshed.wins, 0),
    losses: safeNumber(refreshed.losses, 0),
    flats: safeNumber(refreshed.flats, 0),

    realWins: 0,
    realLosses: 0,
    realFlats: 0,

    virtualWins: safeNumber(refreshed.virtualWins, 0),
    virtualLosses: safeNumber(refreshed.virtualLosses, 0),
    virtualFlats: safeNumber(refreshed.virtualFlats, 0),

    shadowWins: safeNumber(refreshed.shadowWins, 0),
    shadowLosses: safeNumber(refreshed.shadowLosses, 0),
    shadowFlats: safeNumber(refreshed.shadowFlats, 0),

    winrate: safeNumber(refreshed.winrate, 0),
    bayesianWinrate: safeNumber(refreshed.bayesianWinrate, 0),
    wilsonLowerBound: safeNumber(refreshed.wilsonLowerBound, 0),
    fairWinrate: safeNumber(refreshed.fairWinrate, 0),

    totalR: safeNumber(refreshed.totalR, 0),
    realTotalR: 0,
    virtualTotalR: safeNumber(refreshed.virtualTotalR, 0),
    shadowTotalR: safeNumber(refreshed.shadowTotalR, 0),

    avgR: safeNumber(refreshed.avgR, 0),
    avgWinR: safeNumber(refreshed.avgWinR, 0),
    avgLossR: safeNumber(refreshed.avgLossR, 0),

    profitFactor: safeNumber(refreshed.profitFactor, 0),

    directSLCount: safeNumber(refreshed.directSLCount, 0),
    directSLPct: safeNumber(refreshed.directSLPct, 0),

    nearTpCount: safeNumber(refreshed.nearTpCount, 0),
    nearTpPct: safeNumber(refreshed.nearTpPct, 0),

    reachedHalfRCount: safeNumber(refreshed.reachedHalfRCount, 0),
    reachedOneRCount: safeNumber(refreshed.reachedOneRCount, 0),
    reachedHalfRPct: safeNumber(refreshed.reachedHalfRPct, 0),
    reachedOneRPct: safeNumber(refreshed.reachedOneRPct, 0),

    beWouldExitCount: safeNumber(refreshed.beWouldExitCount, 0),
    beWouldExitPct: safeNumber(refreshed.beWouldExitPct, 0),

    gaveBackAfterHalfRCount: safeNumber(refreshed.gaveBackAfterHalfRCount, 0),
    gaveBackAfterOneRCount: safeNumber(refreshed.gaveBackAfterOneRCount, 0),
    gaveBackAfterHalfRPct: safeNumber(refreshed.gaveBackAfterHalfRPct, 0),
    gaveBackAfterOneRPct: safeNumber(refreshed.gaveBackAfterOneRPct, 0),

    nearTpThenLossCount: safeNumber(refreshed.nearTpThenLossCount, 0),
    nearTpThenLossPct: safeNumber(refreshed.nearTpThenLossPct, 0),

    totalCostR: safeNumber(refreshed.totalCostR, 0),
    avgCostR: safeNumber(refreshed.avgCostR, 0),

    sampleReliability: safeNumber(refreshed.sampleReliability, 0),
    balancedScore: safeNumber(refreshed.balancedScore, 0),
    dashboardBalancedScore: safeNumber(refreshed.dashboardBalancedScore ?? refreshed.balancedScore, 0),

    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

    examples: compactExamples(refreshed.examples, 2, 120),
    recentOutcomes: compactRecentOutcomes(refreshed.recentOutcomes, 2),

    createdAt: refreshed.createdAt || null,
    updatedAt: refreshed.updatedAt || now()
  });
}

function getLearningStatus(row = {}) {
  const completed = safeNumber(row.completed || row.outcomeSample, 0);

  if (completed >= MIN_COMPLETED_ACTIVE_LEARNING) return 'ACTIVE_LEARNING';
  if (completed > 0) return 'EARLY_OUTCOMES';

  return 'OBSERVING';
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
  micro.childTrueMicroFamilySchema = TRUE_MICRO_SCHEMA;
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
  micro.version = 'fixed-taxonomy-75-child';

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

  micro.learningStatus = getLearningStatus(micro);
  micro.status = micro.learningStatus;
  micro.tooEarly = safeNumber(micro.completed, 0) < MIN_COMPLETED_ACTIVE_LEARNING;
  micro.tooEarlyReason = micro.tooEarly
    ? `completed ${safeNumber(micro.completed, 0)}/${MIN_COMPLETED_ACTIVE_LEARNING}`
    : null;

  return micro;
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

function maybeParseJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function decodeCompressedBase64(data) {
  const buffer = Buffer.from(data, 'base64');
  const json = gunzipSync(buffer).toString('utf8');

  return JSON.parse(json);
}

function decodeStoragePayload(payload) {
  const parsed = maybeParseJson(payload);

  if (!parsed) return {};

  if (
    typeof parsed === 'object' &&
    [WEEK_MICROS_CODEC, WEEK_MICRO_ROW_CODEC, WEEK_MICROS_TOP_CODEC].includes(parsed.codec) &&
    typeof parsed.data === 'string'
  ) {
    return decodeCompressedBase64(parsed.data);
  }

  if (
    typeof parsed === 'object' &&
    parsed.__compressed === true &&
    parsed.codec === 'gzip-base64' &&
    typeof parsed.data === 'string'
  ) {
    return decodeCompressedBase64(parsed.data);
  }

  if (typeof parsed === 'object') {
    return parsed;
  }

  throw new Error('STORAGE_PAYLOAD_UNREADABLE');
}

function encodeStoragePayload(value = {}, {
  codec,
  maxBytes,
  count,
  extraMeta = {}
} = {}) {
  const cfg = getWeekStorageConfig();
  const schemaMeta = getAnalyzeSchemaMeta();

  const json = JSON.stringify(value || {});
  const rawBytes = Buffer.byteLength(json, 'utf8');

  if (!cfg.compressionEnabled) {
    if (rawBytes > maxBytes) {
      const error = new Error('STORAGE_RAW_PAYLOAD_TOO_LARGE');
      error.details = {
        rawBytes,
        maxBytes,
        count
      };
      throw error;
    }

    return {
      payload: json,
      meta: {
        compressed: false,
        codec: 'json',
        rawBytes,
        payloadBytes: rawBytes,
        count,
        ...extraMeta
      }
    };
  }

  const compressed = gzipSync(Buffer.from(json, 'utf8'), {
    level: cfg.compressionLevel
  });

  const wrapper = {
    codec,
    compressed: true,

    rawBytes,
    compressedBytes: compressed.length,

    count,

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
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

    fallbackTrueMicroFamilySchema: FALLBACK_TRUE_MICRO_SCHEMA,
    fineMicroFamilyAsMetadataOnly: true,

    selectionGranularity: 'EXACT_75_CHILD',

    schema: schemaMeta.schema,
    macroSchema: schemaMeta.macroSchema,
    microSchema: schemaMeta.microSchema,
    fallbackMicroSchema: schemaMeta.fallbackMicroSchema,
    strategyVersion: schemaMeta.strategyVersion,

    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,

    encodedAt: now(),
    data: compressed.toString('base64'),

    ...extraMeta
  };

  const payload = JSON.stringify(wrapper);
  const payloadBytes = Buffer.byteLength(payload, 'utf8');

  if (payloadBytes > maxBytes) {
    const error = new Error('STORAGE_COMPRESSED_PAYLOAD_TOO_LARGE');
    error.details = {
      rawBytes,
      compressedBytes: compressed.length,
      payloadBytes,
      maxBytes,
      count,
      codec
    };
    throw error;
  }

  return {
    payload,
    meta: {
      compressed: true,
      codec,
      rawBytes,
      compressedBytes: compressed.length,
      payloadBytes,
      count,
      ...extraMeta
    }
  };
}

function encodeMicroRowPayload(row = {}) {
  const cfg = getWeekStorageConfig();

  try {
    const compact = compactMicroForStorage(row);

    if (!compact) throw new Error('COMPACT_ROW_EMPTY');

    return encodeStoragePayload(compact, {
      codec: WEEK_MICRO_ROW_CODEC,
      maxBytes: cfg.maxRowSetBytes,
      count: 1,
      extraMeta: {
        microFamilyId: compact.microFamilyId || null,
        trueMicroFamilyId: compact.trueMicroFamilyId || null,
        parentTrueMicroFamilyId: compact.parentTrueMicroFamilyId || null,
        rowMode: 'compact'
      }
    });
  } catch (firstError) {
    const aggressive = compactMicroForStorage(row, true);

    try {
      if (!aggressive) throw new Error('AGGRESSIVE_ROW_EMPTY');

      return encodeStoragePayload(aggressive, {
        codec: WEEK_MICRO_ROW_CODEC,
        maxBytes: cfg.maxRowSetBytes,
        count: 1,
        extraMeta: {
          microFamilyId: aggressive.microFamilyId || null,
          trueMicroFamilyId: aggressive.trueMicroFamilyId || null,
          parentTrueMicroFamilyId: aggressive.parentTrueMicroFamilyId || null,
          rowMode: 'aggressive'
        }
      });
    } catch {
      const minimal = getMinimalMicroForStorage(row);

      if (!minimal) throw firstError;

      return encodeStoragePayload(minimal, {
        codec: WEEK_MICRO_ROW_CODEC,
        maxBytes: cfg.maxRowSetBytes,
        count: 1,
        extraMeta: {
          microFamilyId: minimal.microFamilyId || null,
          trueMicroFamilyId: minimal.trueMicroFamilyId || null,
          parentTrueMicroFamilyId: minimal.parentTrueMicroFamilyId || null,
          rowMode: 'minimal',
          previousError: firstError?.message || null
        }
      });
    }
  }
}

function encodeLegacyWeekMicrosPayload(micros = {}) {
  const cfg = getWeekStorageConfig();

  return encodeStoragePayload(micros, {
    codec: WEEK_MICROS_CODEC,
    maxBytes: cfg.maxRedisSetBytes,
    count: Object.keys(micros || {}).length,
    extraMeta: {
      storageMode: 'legacy-single-key'
    }
  });
}

async function redisSetRawWithTtl(redis, key, value, ttlSec) {
  const ttl = Math.max(1, Math.floor(safeNumber(ttlSec, 1)));

  try {
    return await redis.set(key, value, { ex: ttl });
  } catch (errorA) {
    try {
      return await redis.set(key, value, { EX: ttl });
    } catch (errorB) {
      try {
        return await redis.set(key, value, 'EX', ttl);
      } catch {
        throw errorA || errorB;
      }
    }
  }
}

async function withSoftTimeout(promise, timeoutMs, fallbackValue = null) {
  let timer = null;

  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallbackValue), timeoutMs);
  });

  return Promise
    .race([
      promise.catch(() => fallbackValue),
      timeout
    ])
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

async function getRawRedisValue(redis, key, fallback = null) {
  const direct = await redis.get(key).catch(() => undefined);

  if (direct !== undefined && direct !== null) return direct;

  return getJson(redis, key, fallback);
}

async function getWeekMicrosIndex(redis, weekKey) {
  return getJson(
    redis,
    getWeekMicrosIndexKey(weekKey),
    null
  ).catch(() => null);
}

function rowToObjectEntries(rows) {
  if (!rows) return {};

  if (Array.isArray(rows)) {
    return Object.fromEntries(
      rows
        .filter(Boolean)
        .map((row) => {
          const id = normalizeChildTrueMicroFamilyId(
            row?.trueMicroFamilyId || row?.microFamilyId || row?.id || row?.key,
            row
          );

          return [id, row];
        })
        .filter(([id]) => Boolean(id))
    );
  }

  if (typeof rows === 'object') return rows;

  return {};
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

function selectTopMicrosObject(micros = {}, limit = DEFAULT_TOP_MICROS_SNAPSHOT_LIMIT) {
  const safeLimit = Math.max(1, Math.floor(safeNumber(limit, DEFAULT_TOP_MICROS_SNAPSHOT_LIMIT)));

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

async function readWeekMicrosTopSnapshot(redis, weekKey) {
  const raw = await getRawRedisValue(
    redis,
    getWeekMicrosTopKey(weekKey),
    null
  ).catch(() => null);

  if (!raw) return null;

  const decoded = decodeStoragePayload(raw);
  const rows = decoded?.rows || decoded?.micros || decoded;

  return normalizeMicros(rowToObjectEntries(rows));
}

async function saveWeekMicrosTopSnapshot(redis, weekKey, micros = {}, {
  mergeExisting = true
} = {}) {
  const cfg = getWeekStorageConfig();
  const schemaMeta = getAnalyzeSchemaMeta();

  const incoming = normalizeMicros(micros);
  const incomingIds = Object.keys(incoming);

  if (!mergeExisting && incomingIds.length === 0) {
    const existing = await readWeekMicrosTopSnapshot(redis, weekKey).catch(() => ({}));
    const existingIds = Object.keys(existing || {});

    if (existingIds.length > 0) {
      return {
        ids: existingIds,
        count: existingIds.length,
        payloadBytes: 0,
        rawBytes: 0,
        compressedBytes: 0,
        skippedEmptyTopSnapshotSave: true
      };
    }

    return {
      ids: [],
      count: 0,
      payloadBytes: 0,
      rawBytes: 0,
      compressedBytes: 0,
      skippedEmptyTopSnapshotSave: true
    };
  }

  const currentTop = mergeExisting
    ? await readWeekMicrosTopSnapshot(redis, weekKey).catch(() => ({}))
    : {};

  const merged = {
    ...(currentTop || {}),
    ...incoming
  };

  const topMicros = selectTopMicrosObject(
    merged,
    cfg.topMicrosSnapshotLimit
  );

  const ids = Object.keys(topMicros);

  if (ids.length === 0) {
    return {
      ids: [],
      count: 0,
      payloadBytes: 0,
      rawBytes: 0,
      compressedBytes: 0,
      skippedEmptyTopSnapshotSave: true
    };
  }

  const encoded = encodeStoragePayload(
    {
      weekKey,
      ids,
      count: ids.length,
      rows: topMicros,

      targetTradeSide: TARGET_TRADE_SIDE,
      targetScannerSide: TARGET_SCANNER_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,

      longOnly: true,
      shortDisabled: true,
      shortOnly: false,
      longDisabled: false,

      storageMode: 'TOP_MICROS_SNAPSHOT',
      codec: WEEK_MICROS_TOP_CODEC,

      scannerFingerprintsMetadataOnly: true,
      scannerFingerprintsUsedAsLearningFamily: false,
      executionFingerprintsMetadataOnly: true,
      executionFingerprintsUsedAsLearningFamily: false,

      analyzeMicroFamiliesOnly: true,
      trueMicroOnly: true,
      exactTrueMicroOnly: true,

      trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
      exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
      parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
      learningGranularity: LEARNING_GRANULARITY,
      parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
      fallbackTrueMicroFamilySchema: FALLBACK_TRUE_MICRO_SCHEMA,

      fineMicroFamilyAsMetadataOnly: true,

      executionMicroRefined: false,
      executionMicroSuffix: EXECUTION_MICRO_SUFFIX,
      executionFingerprintRole: 'METADATA_ONLY',

      schema: schemaMeta.schema,
      macroSchema: schemaMeta.macroSchema,
      microSchema: schemaMeta.microSchema,
      fallbackMicroSchema: schemaMeta.fallbackMicroSchema,
      strategyVersion: schemaMeta.strategyVersion,

      redisNamespace: LONG_NAMESPACE,
      redisKeyPrefix: LONG_KEY_PREFIX,
      persistentLearningKey: PERSISTENT_LEARNING_KEY,

      updatedAt: now()
    },
    {
      codec: WEEK_MICROS_TOP_CODEC,
      maxBytes: cfg.maxRedisSetBytes,
      count: ids.length,
      extraMeta: {
        storageMode: 'top-micros-snapshot'
      }
    }
  );

  await redisSetRawWithTtl(
    redis,
    getWeekMicrosTopKey(weekKey),
    encoded.payload,
    cfg.weekMicrosTtlSec
  );

  return {
    ids,
    count: ids.length,
    payloadBytes: encoded.meta.payloadBytes,
    rawBytes: encoded.meta.rawBytes,
    compressedBytes: encoded.meta.compressedBytes || 0
  };
}

async function readWeekMicroRowsByIds(redis, weekKey, ids = []) {
  const cfg = getWeekStorageConfig();
  const safeIds = uniqueStrings(ids).map((id) => normalizeChildTrueMicroFamilyId(id)).filter(Boolean);

  if (!safeIds.length) return {};

  const entries = await mapLimit(
    safeIds,
    cfg.storageConcurrency,
    async (id) => {
      const raw = await getRawRedisValue(
        redis,
        getWeekMicroRowKey(weekKey, id),
        null
      ).catch(() => null);

      if (!raw) return null;

      const row = decodeStoragePayload(raw);

      if (!row || !isLongOnlyRow(row)) return null;

      const microFamilyId = normalizeChildTrueMicroFamilyId(row.trueMicroFamilyId || row.microFamilyId || id, row);

      if (!microFamilyId) return null;

      return [
        microFamilyId,
        withAnalyzeIdentityFlags({
          ...row,
          microFamilyId,
          trueMicroFamilyId: microFamilyId,
          childTrueMicroFamilyId: microFamilyId
        })
      ];
    }
  );

  return Object.fromEntries(entries.filter(Boolean));
}

async function readWeekMicrosSharded(redis, weekKey) {
  const cfg = getWeekStorageConfig();
  const index = await getWeekMicrosIndex(redis, weekKey);

  if (!index || !Array.isArray(index.ids)) {
    return null;
  }

  const ids = uniqueStrings(index.ids)
    .map((id) => normalizeChildTrueMicroFamilyId(id))
    .filter(Boolean);

  if (!ids.length) return null;

  if (
    cfg.preferTopSnapshotOnLargeIndex &&
    ids.length > cfg.maxFullReadMicroRows
  ) {
    const top = await readWeekMicrosTopSnapshot(redis, weekKey).catch(() => null);

    if (top && Object.keys(top).length > 0) return top;

    return readWeekMicroRowsByIds(
      redis,
      weekKey,
      ids.slice(0, cfg.maxFullReadMicroRows)
    );
  }

  return readWeekMicroRowsByIds(redis, weekKey, ids);
}

export async function getWeekMicrosByIds(weekKey, ids = []) {
  const redis = getDurableRedis();
  const safeIds = uniqueStrings(ids)
    .map((id) => normalizeChildTrueMicroFamilyId(id))
    .filter(Boolean);

  if (!safeIds.length) return {};

  const index = await getWeekMicrosIndex(redis, weekKey);

  if (index && Array.isArray(index.ids) && index.ids.length > 0) {
    const indexedIds = new Set(
      (index.ids || [])
        .map((id) => normalizeChildTrueMicroFamilyId(id))
        .filter(Boolean)
    );

    const existingIds = safeIds.filter((id) => indexedIds.has(id));

    return normalizeMicros(
      await readWeekMicroRowsByIds(redis, weekKey, existingIds)
    );
  }

  const top = await readWeekMicrosTopSnapshot(redis, weekKey).catch(() => null);

  if (top && Object.keys(top).length > 0) {
    const normalizedTop = normalizeMicros(top);

    return Object.fromEntries(
      safeIds
        .filter((id) => normalizedTop[id])
        .map((id) => [id, normalizedTop[id]])
    );
  }

  const raw = await getRawRedisValue(
    redis,
    getWeekMicrosBaseKey(weekKey),
    null
  );

  if (!raw) return {};

  const decoded = decodeStoragePayload(raw);
  const normalized = normalizeMicros(decoded || {});

  return Object.fromEntries(
    safeIds
      .filter((id) => normalized[id])
      .map((id) => [id, normalized[id]])
  );
}

async function saveWeekMicrosSharded(redis, weekKey, micros, {
  onlyIds = null
} = {}) {
  const cfg = getWeekStorageConfig();

  const cleanIds = Object.keys(micros || {})
    .map((id) => normalizeChildTrueMicroFamilyId(id, micros[id] || {}))
    .filter(Boolean)
    .filter((id) => micros[id] && isLongOnlyRow(micros[id]))
    .sort();

  const requestedWriteIds = onlyIds
    ? uniqueStrings(onlyIds)
      .map((id) => normalizeChildTrueMicroFamilyId(id))
      .filter(Boolean)
    : null;

  const writeIds = requestedWriteIds
    ? requestedWriteIds
      .filter((id) => micros[id])
      .filter((id) => isLongOnlyRow(micros[id]))
    : cleanIds;

  const fullSave = !onlyIds;

  const existingIndex = await getWeekMicrosIndex(redis, weekKey);
  const existingIds = Array.isArray(existingIndex?.ids)
    ? existingIndex.ids.map((id) => normalizeChildTrueMicroFamilyId(id)).filter(Boolean)
    : [];

  if (fullSave && cleanIds.length === 0) {
    return {
      ids: existingIds,
      writtenIds: [],
      rowMeta: [],
      totalPayloadBytes: 0,
      totalRawBytes: 0,
      maxRowBytes: 0,
      fullSave: true,
      skippedEmptyFullSave: true
    };
  }

  if (!fullSave && writeIds.length === 0) {
    const ids = uniqueStrings([...existingIds, ...cleanIds]).sort();

    return {
      ids,
      writtenIds: [],
      rowMeta: [],
      totalPayloadBytes: 0,
      totalRawBytes: 0,
      maxRowBytes: 0,
      fullSave: false,
      skippedEmptyPartialSave: true
    };
  }

  const rowMeta = await mapLimit(
    writeIds,
    cfg.storageConcurrency,
    async (id) => {
      const rowId = normalizeChildTrueMicroFamilyId(
        micros[id]?.trueMicroFamilyId || micros[id]?.microFamilyId || id,
        micros[id] || {}
      );

      if (!rowId) {
        throw new Error('REFUSE_TO_SAVE_NON_CHILD_TRUE_MICRO_FAMILY_ROW');
      }

      const parentId = normalizeParentTrueMicroFamilyId(
        micros[id]?.parentTrueMicroFamilyId || micros[id]?.coarseMicroFamilyId || rowId,
        micros[id] || {}
      );

      const row = withAnalyzeIdentityFlags({
        ...micros[id],
        microFamilyId: rowId,
        trueMicroFamilyId: rowId,
        childTrueMicroFamilyId: rowId,
        coarseMicroFamilyId: parentId,
        parentTrueMicroFamilyId: parentId,
        parentMicroFamilyId: parentId,
        macroFamilyId: parentId,
        parentMacroFamilyId: parentId,
        side: TARGET_DASHBOARD_SIDE,
        tradeSide: TARGET_TRADE_SIDE,
        positionSide: TARGET_TRADE_SIDE,
        direction: TARGET_TRADE_SIDE,
        targetTradeSide: TARGET_TRADE_SIDE,
        dashboardSide: TARGET_DASHBOARD_SIDE,
        longOnly: true,
        shortDisabled: true,
        shortOnly: false,
        longDisabled: false
      });

      const encoded = encodeMicroRowPayload(row);

      await redisSetRawWithTtl(
        redis,
        getWeekMicroRowKey(weekKey, rowId),
        encoded.payload,
        cfg.weekMicrosTtlSec
      );

      return {
        id: rowId,
        bytes: encoded.meta.payloadBytes,
        rawBytes: encoded.meta.rawBytes,
        compressedBytes: encoded.meta.compressedBytes || 0,
        rowMode: encoded.meta.rowMode || 'json'
      };
    }
  );

  const ids = fullSave
    ? cleanIds
    : uniqueStrings([...existingIds, ...cleanIds, ...writeIds]).sort();

  const totalPayloadBytes = rowMeta.reduce(
    (sum, row) => sum + safeNumber(row.bytes, 0),
    0
  );

  const totalRawBytes = rowMeta.reduce(
    (sum, row) => sum + safeNumber(row.rawBytes, 0),
    0
  );

  const maxRowBytes = rowMeta.reduce(
    (max, row) => Math.max(max, safeNumber(row.bytes, 0)),
    0
  );

  const schemaMeta = getAnalyzeSchemaMeta();

  if (ids.length > 0) {
    await setJson(
      redis,
      getWeekMicrosIndexKey(weekKey),
      {
        weekKey,
        ids,
        count: ids.length,

        storageMode: 'SHARDED_COMPRESSED_ROWS',
        codec: WEEK_MICRO_ROW_CODEC,

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
        parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
        learningGranularity: LEARNING_GRANULARITY,
        parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
        fallbackTrueMicroFamilySchema: FALLBACK_TRUE_MICRO_SCHEMA,

        fineMicroFamilyAsMetadataOnly: true,

        executionMicroRefined: false,
        executionMicroSuffix: EXECUTION_MICRO_SUFFIX,
        executionFingerprintRole: 'METADATA_ONLY',

        lastWriteMode: fullSave ? 'FULL' : 'PARTIAL',
        lastWrittenCount: writeIds.length,

        totalPayloadBytes,
        totalRawBytes,
        maxRowBytes,

        updatedAt: now(),

        schema: schemaMeta.schema,
        macroSchema: schemaMeta.macroSchema,
        microSchema: schemaMeta.microSchema,
        fallbackMicroSchema: schemaMeta.fallbackMicroSchema,
        strategyVersion: schemaMeta.strategyVersion,

        redisNamespace: LONG_NAMESPACE,
        redisKeyPrefix: LONG_KEY_PREFIX,
        persistentLearningKey: PERSISTENT_LEARNING_KEY
      },
      {
        ex: cfg.weekMicrosTtlSec
      }
    );
  }

  const topInput = Object.fromEntries(
    writeIds
      .filter((id) => micros[id])
      .map((id) => [id, withAnalyzeIdentityFlags(micros[id])])
  );

  if (writeIds.length > 0) {
    await saveWeekMicrosTopSnapshot(
      redis,
      weekKey,
      fullSave ? micros : topInput,
      {
        mergeExisting: !fullSave
      }
    ).catch(() => null);
  }

  if (ids.length > 0) {
    await redis.del(getWeekMicrosBaseKey(weekKey)).catch(() => null);
  }

  return {
    ids,
    writtenIds: writeIds,
    rowMeta,
    totalPayloadBytes,
    totalRawBytes,
    maxRowBytes,
    fullSave
  };
}

export async function getWeekMicros(weekKey = PERSISTENT_LEARNING_KEY) {
  const redis = getDurableRedis();
  const cfg = getWeekStorageConfig();

  const sharded = await withSoftTimeout(
    readWeekMicrosSharded(redis, weekKey),
    cfg.fullReadSoftTimeoutMs,
    null
  );

  if (sharded !== null && Object.keys(sharded || {}).length > 0) {
    return normalizeMicros(sharded || {});
  }

  const top = await readWeekMicrosTopSnapshot(redis, weekKey).catch(() => null);

  if (top && Object.keys(top).length > 0) {
    return normalizeMicros(top);
  }

  const raw = await withSoftTimeout(
    getRawRedisValue(
      redis,
      getWeekMicrosBaseKey(weekKey),
      null
    ),
    cfg.fullReadSoftTimeoutMs,
    null
  );

  if (!raw) return {};

  const decoded = decodeStoragePayload(raw);
  const normalized = normalizeMicros(decoded || {});

  if (Object.keys(normalized).length > 0) {
    await saveWeekMicrosTopSnapshot(
      redis,
      weekKey,
      normalized,
      {
        mergeExisting: false
      }
    ).catch(() => null);
  }

  return normalized;
}

export async function getWeekTopMicros(weekKey = PERSISTENT_LEARNING_KEY, {
  limit = 25
} = {}) {
  const redis = getDurableRedis();
  const top = await readWeekMicrosTopSnapshot(redis, weekKey).catch(() => null);

  if (top && Object.keys(top).length > 0) {
    return selectTopMicrosObject(top, limit);
  }

  return selectTopMicrosObject(
    await getWeekMicros(weekKey),
    limit
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
  const cfg = getWeekStorageConfig();
  const clean = normalizeMicros(micros);
  const cleanIds = Object.keys(clean);
  const schemaMeta = getAnalyzeSchemaMeta();

  if (!onlyIds && cleanIds.length === 0 && !allowEmptyFullSave) {
    const existing = await getWeekMicros(weekKey).catch(() => ({}));
    const existingClean = normalizeMicros(existing || {});
    const existingIds = Object.keys(existingClean);

    if (existingIds.length > 0) {
      return existingClean;
    }

    return {};
  }

  if (onlyIds && cleanIds.length === 0) {
    const existing = await getWeekMicros(weekKey).catch(() => ({}));
    return normalizeMicros(existing || {});
  }

  let storage;
  let topStorage = null;

  try {
    storage = await saveWeekMicrosSharded(
      redis,
      weekKey,
      clean,
      {
        onlyIds
      }
    );

    topStorage = await readWeekMicrosTopSnapshot(redis, weekKey)
      .then((rows) => ({
        count: Object.keys(rows || {}).length
      }))
      .catch(() => null);
  } catch (error) {
    if (onlyIds) {
      throw error;
    }

    if (cleanIds.length === 0 && !allowEmptyFullSave) {
      const existing = await getWeekMicros(weekKey).catch(() => ({}));
      const existingClean = normalizeMicros(existing || {});

      if (Object.keys(existingClean).length > 0) {
        return existingClean;
      }

      return {};
    }

    const legacy = encodeLegacyWeekMicrosPayload(clean);

    await redisSetRawWithTtl(
      redis,
      getWeekMicrosBaseKey(weekKey),
      legacy.payload,
      cfg.weekMicrosTtlSec
    );

    topStorage = await saveWeekMicrosTopSnapshot(
      redis,
      weekKey,
      clean,
      {
        mergeExisting: false
      }
    ).catch(() => null);

    storage = {
      ids: Object.keys(clean),
      writtenIds: Object.keys(clean),
      fallbackToLegacy: true,
      fallbackReason: error?.message || String(error),
      totalPayloadBytes: legacy.meta.payloadBytes,
      totalRawBytes: legacy.meta.rawBytes,
      maxRowBytes: 0,
      fullSave: true
    };
  }

  await setJson(
    redis,
    getWeekMetaKey(weekKey),
    {
      weekKey,
      updatedAt: now(),
      microFamilies: storage.ids.length,

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
      parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
      learningGranularity: LEARNING_GRANULARITY,
      parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
      fallbackTrueMicroFamilySchema: FALLBACK_TRUE_MICRO_SCHEMA,
      fineMicroFamilyAsMetadataOnly: true,

      executionMicroRefined: false,
      executionMicroSuffix: EXECUTION_MICRO_SUFFIX,
      executionFingerprintRole: 'METADATA_ONLY',

      schema: schemaMeta.schema,
      macroSchema: schemaMeta.macroSchema,
      microSchema: schemaMeta.microSchema,
      fallbackMicroSchema: schemaMeta.fallbackMicroSchema,
      strategyVersion: schemaMeta.strategyVersion,

      redisNamespace: LONG_NAMESPACE,
      redisKeyPrefix: LONG_KEY_PREFIX,
      persistentLearningKey: PERSISTENT_LEARNING_KEY,

      storage: {
        storageMode: storage.fallbackToLegacy
          ? 'LEGACY_COMPRESSED_SINGLE_KEY_FALLBACK'
          : 'SHARDED_COMPRESSED_ROWS',

        codec: storage.fallbackToLegacy
          ? WEEK_MICROS_CODEC
          : WEEK_MICRO_ROW_CODEC,

        count: storage.ids.length,
        writtenCount: storage.writtenIds?.length || 0,
        fullSave: Boolean(storage.fullSave),

        totalPayloadBytes: storage.totalPayloadBytes,
        totalRawBytes: storage.totalRawBytes,
        maxRowBytes: storage.maxRowBytes,

        fallbackToLegacy: Boolean(storage.fallbackToLegacy),
        fallbackReason: storage.fallbackReason || null,

        skippedEmptyFullSave: Boolean(storage.skippedEmptyFullSave),
        skippedEmptyPartialSave: Boolean(storage.skippedEmptyPartialSave),

        topSnapshot: {
          enabled: true,
          codec: WEEK_MICROS_TOP_CODEC,
          limit: cfg.topMicrosSnapshotLimit,
          count: topStorage?.count ?? topStorage?.ids?.length ?? null
        },

        ttlSec: cfg.weekMicrosTtlSec
      }
    },
    {
      ex: cfg.weekMetaTtlSec
    }
  );

  return clean;
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

      const observationKey = getObsLastKey(
        batch.metrics.snapshotId || 'NO_SNAPSHOT',
        batch.metrics.symbol || batch.metrics.contractSymbol || 'UNKNOWN',
        microFamilyId
      );

      await redis.set(observationKey, String(now()), {
        ex: obsDedupeTtlSec()
      }).catch(() => null);

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

        observationRecorded: true,
        observationDuplicate: false,
        observationAlwaysCounted: true,
        observationDedupeKey: observationKey,

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

          observationRecorded: true,
          observationDuplicate: false,
          observationAlwaysCounted: true,

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
    childTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
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

  const validLongRiskShape = entry > 0 && initialSl > 0 && tp > 0 && initialSl < entry && entry < tp;

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

    return withAnalyzeIdentityFlags({
      ...outcome,

      validLongRiskShape,

      grossMovePct,
      riskPct,

      grossR: safeNumber(cost.grossR, existingGrossR ?? 0),
      rawR: safeNumber(cost.grossR, existingGrossR ?? 0),
      realizedGrossR: safeNumber(cost.grossR, existingGrossR ?? 0),
      grossPnlPct: safeNumber(cost.grossPnlPct, 0),

      netR: safeNumber(cost.netR, existingNetR ?? 0),
      exitR: safeNumber(cost.netR, existingNetR ?? 0),
      realizedNetR: safeNumber(cost.netR, existingNetR ?? 0),
      realizedR: safeNumber(cost.netR, existingNetR ?? 0),
      r: safeNumber(cost.netR, existingNetR ?? 0),
      pnlPct: safeNumber(cost.netPnlPct, 0),
      netPnlPct: safeNumber(cost.netPnlPct, 0),

      costR: safeNumber(cost.costR, existingCostR ?? 0),
      avgCostR: safeNumber(cost.costR, existingCostR ?? 0),
      costPct: safeNumber(cost.costPct, 0),
      feePct: safeNumber(cost.feePct, 0),
      slippagePct: safeNumber(cost.slippagePct, 0),

      win: safeNumber(cost.netR, existingNetR ?? 0) > 0,
      loss: safeNumber(cost.netR, existingNetR ?? 0) < 0,
      flat: safeNumber(cost.netR, existingNetR ?? 0) === 0,
      isWin: safeNumber(cost.netR, existingNetR ?? 0) > 0,

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

  const touchedIds = uniqueStrings([
    microFamilyId
  ]);

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
    realizedR: safeNumber(row.realizedR ?? row.netR ?? row.exitR, 0),
    r: safeNumber(row.r ?? row.netR ?? row.exitR, 0),

    costR: safeNumber(row.costR, 0),
    avgCostR: safeNumber(row.avgCostR ?? row.costR, 0),
    grossR: safeNumber(row.grossR, 0),

    costModelApplied: Boolean(row.costModelApplied),
    netCostModelApplied: Boolean(row.netCostModelApplied),

    outcomeIdentityLocked: true,
    outcomeIdentitySource: row.outcomeIdentitySource || 'POSITION_MICRO_IDENTITY'
  }), src);

  Object.assign(micro, analyzeIdentityFlags());

  await saveWeekMicros(
    weekKey,
    micros,
    {
      onlyIds: touchedIds
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
    'STOPLOSS'
  ].includes(reason);

  return Boolean(position.directToSL) ||
    (
      stoppedOut &&
      mfeR < 0.25 &&
      maeR <= -0.8
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
    childTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
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
    version: 'fixed-taxonomy-75-child',

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

  const validLongRiskShape = entry > 0 && initialSl > 0 && tp > 0 && initialSl < entry && entry < tp;

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

  const netR = safeNumber(
    cost.netR,
    grossR - safeNumber(cost.costR, 0)
  );

  const closedAt = now();
  const src = normalizeSource(source);
  const classification = copyMicroClassificationFields(position);

  return withAnalyzeIdentityFlags({
    type: 'OUTCOME',
    source: src,
    outcomeSource: OUTCOME_SOURCE,
    positionSource: position.source || 'VIRTUAL',

    strategyVersion: CONFIG.strategyVersion,

    tradeId: position.tradeId,

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

    costR: safeNumber(cost.costR, 0),
    avgCostR: safeNumber(cost.costR, 0),
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

    directToSL: inferDirectToSL({
      position,
      exitReason
    }),

    nearTpSeen: Boolean(position.nearTpSeen),
    reachedHalfR: Boolean(position.reachedHalfR),
    reachedOneR: Boolean(position.reachedOneR),

    beArmed: Boolean(position.beArmed),
    beWouldExit: Boolean(position.beWouldExit),
    beExitR: safeNumber(position.beExitR, 0),

    gaveBackAfterHalfR: Boolean(position.gaveBackAfterHalfR),
    gaveBackAfterOneR: Boolean(position.gaveBackAfterOneR),
    nearTpThenLoss: Boolean(position.nearTpThenLoss),

    openedAt: position.openedAt || position.createdAt || null,
    closedAt,
    completedAt: closedAt
  });
}

export async function getAnalyzeMicroRowsByIds(weekKey = PERSISTENT_LEARNING_KEY, ids = []) {
  return getWeekMicrosByIds(weekKey, ids);
}