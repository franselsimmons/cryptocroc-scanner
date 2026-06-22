// ================= FILE: src/analyze/analyzeEngine.js =================
//
// LONG-only Analyze engine.
//
// Fixes:
// - Geen observationDedupeKeys/outcomeDedupeKeys meer in LONG:ANALYZE:WEEK:*:MICROS.
// - Micro rows worden compact allowlist-only opgeslagen.
// - Full micros write is fail-soft bij Upstash max request size.
// - Top micros + meta blijven altijd compact.
// - Learning identity blijft exact true 75-child micro-family.
// - Scanner/execution fingerprints blijven metadata only.
// - Oude bloat in bestaande micros wordt bij lezen/schrijven genormaliseerd.
// - recordOutcome/analyzeCandidatesBatch schrijven alleen compact rows terug.

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

const MEASUREMENT_FIX_VERSION = 'LONG_MEASUREMENT_FIX_AVGCOST_DIRECTSL_SEEN_DEDUPE_V2';
const CLASSIFIER_VERSION = 'LONG_STRICT_EVIDENCE_DISTRIBUTION_V3';
const STORAGE_COMPACTION_VERSION = 'LONG_ANALYZE_MICROS_COMPACT_NO_DEDUPE_ARRAYS_V3';

const MAX_REDIS_PAYLOAD_BYTES = 8_500_000;
const TOP_MICROS_LIMIT = 300;
const REDUCED_MICROS_LIMIT = 75;
const EMERGENCY_MICROS_LIMIT = 25;
const LAST_RESORT_MICROS_LIMIT = 10;

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

const LONG_DIRECT = new Set([
  'LONG',
  'BULL',
  'BULLISH',
  'BUY',
  'BID',
  'UP',
  'UPSIDE',
  'GREEN'
]);

const SHORT_DIRECT = new Set([
  'SHORT',
  'BEAR',
  'BEARISH',
  'SELL',
  'ASK',
  'DOWN',
  'DOWNSIDE',
  'RED'
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

const BLOAT_KEYS = new Set([
  'raw',
  'payload',
  'debug',
  'trace',
  'traces',
  'logs',
  'log',
  'request',
  'response',
  'stack',
  'html',

  'candles',
  'candles15m',
  'candles1h',
  'candles4h',
  'candles1d',
  'klines',
  'ohlcv',

  'orderBook',
  'rawOrderBook',
  'orderbook',
  'bids',
  'asks',
  'ticks',
  'prices',
  'history',
  'marketData',

  'scannerRows',
  'scannerCandidates',
  'candidates',
  'rows',
  'universe',
  'symbols',
  'marketUniverse',
  'marketWeatherRows',

  'observationDedupeKeys',
  'outcomeDedupeKeys',
  'seenDedupeKeys',
  'completedDedupeKeys',
  'dedupeKeys',
  'observationKeys',
  'outcomeKeys',
  'seenKeys',
  'completedKeys',
  'allObservationDedupeKeys',
  'allOutcomeDedupeKeys'
]);

const NUMERIC_MICRO_FIELDS = [
  'seen',
  'observations',
  'observationCount',
  'observationDuplicateSkippedCount',
  'completed',
  'outcomeSample',
  'wins',
  'losses',
  'flats',
  'winrate',
  'fairWinrate',
  'sampleAdjustedWinrate',
  'wilsonLowerBound',
  'totalR',
  'netTotalR',
  'avgR',
  'netAvgR',
  'avgWinR',
  'avgLossR',
  'grossR',
  'grossTotalR',
  'grossAvgR',
  'costR',
  'avgCostR',
  'totalCostR',
  'feeR',
  'slippageR',
  'marketImpactR',
  'spreadCostR',
  'directSLCount',
  'directSLRate',
  'tpCount',
  'slCount',
  'timeStopCount',
  'balancedScore',
  'dashboardBalancedScore',
  'score',
  'confidence',
  'sampleWeight',
  'spreadBps'
];

function now() {
  return Date.now();
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function number(value, fallback = 0) {
  const n = Number(value);

  return Number.isFinite(n) ? n : fallback;
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
  if (raw.startsWith('SHORT:')) return `${LONG_KEY_PREFIX}${raw.slice('SHORT:'.length)}`;

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
    Math.floor(number(CONFIG?.long?.analyze?.obsDedupeTtlSec ?? CONFIG?.analyze?.obsDedupeTtlSec, 60 * 60 * 24))
  );
}

function outcomeDedupeTtlSec() {
  return Math.max(
    60,
    Math.floor(number(CONFIG?.long?.analyze?.outcomeDedupeTtlSec ?? CONFIG?.analyze?.outcomeDedupeTtlSec, 60 * 60 * 24 * 14))
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
  if (LONG_DIRECT.has(raw)) return TARGET_TRADE_SIDE;
  if (SHORT_DIRECT.has(raw)) return OPPOSITE_TRADE_SIDE;

  const normalized = raw
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  const longHit =
    normalized === 'LONG' ||
    normalized === 'BULL' ||
    normalized === 'BULLISH' ||
    normalized === 'BUY' ||
    normalized.includes('MICRO_LONG') ||
    normalized.includes('FAMILY_LONG') ||
    normalized.includes('TRADE_SIDE_LONG') ||
    normalized.includes('TRADESIDE_LONG') ||
    normalized.includes('POSITION_SIDE_LONG') ||
    normalized.includes('POSITIONSIDE_LONG') ||
    normalized.includes('DIRECTION_LONG') ||
    normalized.includes('SIDE_LONG') ||
    normalized.includes('SIDE_BULL') ||
    normalized.includes('DIRECTION_BULL') ||
    normalized.includes('SIDE_BUY') ||
    normalized.includes('DIRECTION_BUY');

  const shortHit =
    normalized === 'SHORT' ||
    normalized === 'BEAR' ||
    normalized === 'BEARISH' ||
    normalized === 'SELL' ||
    normalized.includes('MICRO_SHORT') ||
    normalized.includes('FAMILY_SHORT') ||
    normalized.includes('TRADE_SIDE_SHORT') ||
    normalized.includes('TRADESIDE_SHORT') ||
    normalized.includes('POSITION_SIDE_SHORT') ||
    normalized.includes('POSITIONSIDE_SHORT') ||
    normalized.includes('DIRECTION_SHORT') ||
    normalized.includes('SIDE_SHORT') ||
    normalized.includes('SIDE_BEAR') ||
    normalized.includes('DIRECTION_BEAR') ||
    normalized.includes('SIDE_SELL') ||
    normalized.includes('DIRECTION_SELL');

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
  const parsed = parseLongTaxonomyMicroId(id);

  return Boolean(parsed.valid && parsed.isChild && parsed.selectable);
}

function isFixedTaxonomyParentMicroId(id = '') {
  const parsed = parseLongTaxonomyMicroId(id);

  return Boolean(parsed.valid && parsed.isParent && !parsed.selectable);
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

function firstNormalizedConfirmation(...values) {
  for (const value of values) {
    const confirmation = normalizeConfirmationProfile(value);

    if (confirmation) return confirmation;
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

  const volumeScore = number(row.volumeScore ?? classified.volumeScore, 0);
  const relativeVolume = number(row.relativeVolume ?? classified.relativeVolume, 0);
  const volumeSpike = number(row.volumeSpike ?? classified.volumeSpike, 0);
  const quoteVolumeSpike = number(row.quoteVolumeSpike ?? classified.quoteVolumeSpike, 0);

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

  return {
    evidence: Boolean(confirmed || bucketVolume || scoreVolume),
    confirmed,
    bucketVolume,
    scoreVolume,
    volumeScore,
    relativeVolume,
    volumeSpike,
    quoteVolumeSpike
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

  const flowScore = number(
    row.flowScore ??
      row.flowStrength ??
      row.momentumScore ??
      classified.flowScore ??
      classified.flowStrength ??
      classified.momentumScore,
    0
  );

  const positiveChange =
    number(row.change1h ?? classified.change1h, 0) > 0.15 ||
    number(row.change24h ?? classified.change24h, 0) > 0.5;

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
  ) || hasAnyText(text, ['SWEEP', 'LIQUIDITY', 'STOP_RUN', 'REVERSAL']);

  const retest = boolish(
    row.retestConfirmed,
    row.pullbackConfirmed,
    row.retestSetup,
    row.pullbackSetup,
    classified.retestConfirmed,
    classified.pullbackConfirmed,
    classified.retestSetup,
    classified.pullbackSetup
  ) || hasAnyText(text, ['RETEST', 'PULLBACK', 'PULL_BACK']);

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
  ) || hasAnyText(text, ['COMPRESSION_SETUP', 'SQUEEZE_SETUP', 'COIL', 'TIGHT_RANGE_SETUP']);

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
  ) || hasAnyText(text, ['CONTINUATION', 'TREND_CONT', 'MOMENTUM_CONT']);

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
      number(row.confluence ?? row.sniperScore ?? classified.confluence, 0) < 35 ||
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
      ['SQUEEZE', 'VOL_SQUEEZE', 'TIGHT_RANGE', 'COMPRESSION_REGIME']
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
      valueText(row.regime, row.regimeCoarse, classified.regime, classified.regimeCoarse, text),
      ['CHOP', 'RANGE', 'SIDEWAYS', 'RANGING', 'MEAN_REVERT']
    );

  if (explicitChop) return 'CHOP';

  const flow = bullishFlowEvidence(row, classified);
  const trendText = hasAnyText(
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
    ['TREND', 'TRENDING', 'IMPULSE', 'MOM_WITH', 'FLOW_WITH', 'BUILDING']
  );

  if (flow.evidence || trendText) return 'TREND';

  return 'CHOP';
}

function inferConfirmationProfile(row = {}, classified = {}) {
  const exact = exactChildIdentityFromSource(row, classified);
  if (exact?.confirmationProfile) return exact.confirmationProfile;

  const direct = firstNormalizedConfirmation(
    classified.confirmationProfile,
    row.confirmationProfile,
    classified.profile,
    row.profile
  );

  if (direct) return direct;

  const confluence = number(
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

  if (structure.any && flow.evidence && volume.evidence) return 'A_STRONG_ALIGN';
  if (flow.evidence) return 'B_FLOW_ALIGN';
  if (volume.evidence) return 'C_VOLUME_ALIGN';

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
    virtualTracked: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    exchangeOrdersDisabled: true,
    noRealOrders: true,
    noExchangeOrders: true,

    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    shortRootTouched: false,

    storageCompactionVersion: STORAGE_COMPACTION_VERSION,
    dedupeArraysStoredInMicros: false,
    observationDedupeKeysStoredInMicros: false,
    outcomeDedupeKeysStoredInMicros: false
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
    ...stripBulkyFields(row),

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
    ...stripBulkyFields(classified),

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
  const fromKeys =
    typeof KEYS.analyze?.weekMicros === 'function'
      ? KEYS.analyze.weekMicros(weekKey)
      : null;

  return longKey(fromKeys, `ANALYZE:WEEK:${weekKey}:MICROS`);
}

function getWeekMetaKey(weekKey) {
  const fromKeys =
    typeof KEYS.analyze?.weekMeta === 'function'
      ? KEYS.analyze.weekMeta(weekKey)
      : null;

  return longKey(fromKeys, `ANALYZE:WEEK:${weekKey}:META`);
}

function getObsLastKey(snapshotId, symbol, microFamilyId) {
  const fromKeys =
    typeof KEYS.analyze?.obsLast === 'function'
      ? KEYS.analyze.obsLast(snapshotId, symbol, microFamilyId)
      : null;

  return longKey(
    fromKeys,
    `ANALYZE:OBS:LAST:${snapshotId}:${symbol}:${microFamilyId}`
  );
}

function getOutcomeLastKey(weekKey, outcomeIdentity, microFamilyId) {
  const fromKeys =
    typeof KEYS.analyze?.outcomeLast === 'function'
      ? KEYS.analyze.outcomeLast(weekKey, outcomeIdentity, microFamilyId)
      : null;

  return longKey(
    fromKeys,
    `ANALYZE:OUTCOME:LAST:${weekKey}:${outcomeIdentity}:${microFamilyId}`
  );
}

function getWeekMicrosTopKey(weekKey) {
  return `${getWeekMicrosBaseKey(weekKey)}:TOP`;
}

async function claimDedupeKey(redis, key, ttlSec, { type = 'DEDUPE' } = {}) {
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
      // Try next Upstash client option shape.
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

function truncateString(value, maxLength = 320) {
  const text = String(value ?? '');

  if (text.length <= maxLength) return text;

  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function compactDefinitionParts(parts = [], maxItems = 32, maxStringLength = 240) {
  if (!Array.isArray(parts)) return [];

  return uniqueStrings(parts)
    .slice(0, maxItems)
    .map((part) => truncateString(part, maxStringLength))
    .filter(Boolean);
}

function compactExamples(examples = [], maxItems = 3, maxStringLength = 220) {
  if (!Array.isArray(examples) || maxItems <= 0) return [];

  return examples
    .slice(-maxItems)
    .map((example) => {
      if (!example || typeof example !== 'object') {
        return example ? truncateString(example, maxStringLength) : null;
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

        observationRecorded: Boolean(example.observationRecorded),
        observationDuplicate: Boolean(example.observationDuplicate),

        ts: number(example.ts || example.createdAt, null)
      });
    })
    .filter(Boolean);
}

function compactRecentOutcomes(outcomes = [], maxItems = 5) {
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

        symbol: outcome.symbol || outcome.baseSymbol || outcome.contractSymbol || null,
        contractSymbol: outcome.contractSymbol || null,

        side: TARGET_DASHBOARD_SIDE,
        tradeSide: TARGET_TRADE_SIDE,

        exitReason: outcome.exitReason || outcome.reason || null,

        exitR: number(outcome.exitR ?? outcome.netR, 0),
        netR: number(outcome.netR ?? outcome.exitR, 0),
        grossR: number(outcome.grossR, 0),

        costR: number(outcome.costR, 0),
        avgCostR: number(outcome.avgCostR ?? outcome.costR, 0),

        mfeR: number(outcome.mfeR, 0),
        maeR: number(outcome.maeR, 0),

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

        entryCurrentRegime: outcome.entryCurrentRegime || outcome.currentRegime || null,
        entryCurrentTrendSide: outcome.entryCurrentTrendSide || outcome.currentTrendSide || null,
        entryCurrentFit: outcome.entryCurrentFit ?? outcome.currentFit ?? null,
        entryCurrentFitConfidence: number(outcome.entryCurrentFitConfidence ?? outcome.currentMarketFitConfidence, null),

        costModelApplied: Boolean(outcome.costModelApplied),
        netCostModelApplied: Boolean(outcome.netCostModelApplied),
        costModel: outcome.costModel || null,

        ts: number(
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

function stripBulkyFields(input = {}, depth = 0) {
  if (!input || typeof input !== 'object') return input;
  if (depth > 1) return null;

  if (Array.isArray(input)) {
    return input
      .slice(0, 16)
      .map((item) => {
        if (!item || typeof item !== 'object') return item;
        return stripBulkyFields(item, depth + 1);
      })
      .filter((item) => item !== null && item !== undefined);
  }

  const clean = {};

  for (const [key, value] of Object.entries(input)) {
    if (BLOAT_KEYS.has(key)) continue;
    if (/dedupekeys/i.test(key)) continue;
    if (/raw|payload|debug|trace|candles|klines|orderbook|universe|candidates|scannerrows/i.test(key)) continue;

    if (Array.isArray(value)) {
      if (
        key === 'definitionParts' ||
        key === 'microDefinitionParts' ||
        key === 'parentDefinitionParts' ||
        key === 'macroDefinitionParts' ||
        key === 'broadTrueDefinitionParts' ||
        key === 'executionFingerprintParts' ||
        key === 'scannerDefinitionParts'
      ) {
        clean[key] = compactDefinitionParts(value, key === 'executionFingerprintParts' ? 20 : 32, 220);
        continue;
      }

      if (key === 'examples') {
        clean[key] = compactExamples(value, 3, 220);
        continue;
      }

      if (key === 'recentOutcomes') {
        clean[key] = compactRecentOutcomes(value, 5);
        continue;
      }

      clean[key] = value.slice(0, 8);
      continue;
    }

    if (value && typeof value === 'object') {
      if (depth >= 1) continue;
      clean[key] = stripBulkyFields(value, depth + 1);
      continue;
    }

    if (typeof value === 'string') {
      clean[key] = truncateString(value, 640);
      continue;
    }

    clean[key] = value;
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
    ? compactDefinitionParts(row.scannerDefinitionParts, 16, 180)
    : scannerMicroFamilyId && Array.isArray(row.definitionParts)
      ? compactDefinitionParts(row.definitionParts, 16, 180)
      : [];

  const scannerDefinition = firstDefined(
    row.scannerDefinition,
    scannerMicroFamilyId ? row.definition : null,
    scannerMicroFamilyId ? row.microDefinition : null
  );

  return {
    scannerMicroFamilyId: scannerMicroFamilyId || null,
    scannerFamilyId: scannerFamilyId || null,
    scannerDefinition: scannerDefinition ? truncateString(scannerDefinition, 480) : null,
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

  const executionParts = compactDefinitionParts(
    buildExecutionFingerprintParts(row, classified, taxonomy),
    20,
    180
  );

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

  const taxonomy = extractFixedTaxonomyMicroId(classifyInput, rawClassified);

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
  const definitionParts = compactDefinitionParts(
    buildFixedTaxonomyDefinitionParts(classifyInput, classified, taxonomy),
    32,
    220
  );

  const parentDefinitionParts = compactDefinitionParts(
    buildParentDefinitionParts(taxonomy),
    16,
    180
  );

  return withAnalyzeIdentityFlags({
    ...stripBulkyFields(row),

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
    executionFingerprintParts: compactDefinitionParts(classified.executionFingerprintParts, 20, 180),
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
    version: 'fixed-taxonomy-75-child-smart-evidence-v3',

    classifierVersion: CLASSIFIER_VERSION,
    classifierNoDefaultRetestSqueezeB: true,
    noDefaultRetestSqueezeB: true,

    assetClass: classified.assetClass || row.assetClass || 'CRYPTO',

    obRelation: classified.obRelation || row.obRelation || null,
    btcRelation: classified.btcRelation || row.btcRelation || null,
    btcState: classified.btcState || row.btcState || null,

    flow: classified.flow || row.flow || null,
    flowCoarse: classified.flowCoarse || row.flowCoarse || null,

    regime: classified.regime || row.regime || null,
    regimeCoarse: classified.regimeCoarse || row.regimeCoarse || null,

    scannerReason: classified.scannerReason || row.scannerReason || null,
    scannerReasonCoarse: classified.scannerReasonCoarse || row.scannerReasonCoarse || null,

    rsiZone: classified.rsiZone || row.rsiZone || null,
    rsiCoarse: classified.rsiCoarse || row.rsiCoarse || null,

    spreadBps: classified.spreadBps ?? row.spreadBps ?? null,

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
  const completed = number(row.completed || row.outcomeSample, 0);

  if (completed >= MIN_COMPLETED_ACTIVE_LEARNING) return 'ACTIVE_LEARNING';
  if (completed > 0) return 'EARLY_OUTCOMES';

  return 'OBSERVING';
}

function purgeBloatKeys(row = {}) {
  if (!row || typeof row !== 'object') return row;

  const next = { ...row };

  for (const key of BLOAT_KEYS) {
    delete next[key];
  }

  delete next.observationDedupeKeys;
  delete next.outcomeDedupeKeys;
  delete next.seenDedupeKeys;
  delete next.completedDedupeKeys;
  delete next.dedupeKeys;
  delete next.observationKeys;
  delete next.outcomeKeys;
  delete next.seenKeys;
  delete next.completedKeys;
  delete next.allObservationDedupeKeys;
  delete next.allOutcomeDedupeKeys;

  return next;
}

function compactMicroForStorage(row = {}) {
  if (!row || typeof row !== 'object') return null;

  const stripped = purgeBloatKeys(stripBulkyFields(row));
  const refreshed = refreshStats(withAnalyzeIdentityFlags(stripped));

  const trueMicroFamilyId = normalizeChildTrueMicroFamilyId(
    refreshed.trueMicroFamilyId || refreshed.microFamilyId,
    refreshed
  );

  if (!trueMicroFamilyId) return null;

  const taxonomy = parseLongTaxonomyMicroId(trueMicroFamilyId);
  const parentTrueMicroFamilyId = taxonomy.parentTrueMicroFamilyId;

  const definitionParts = compactDefinitionParts(
    refreshed.definitionParts ||
      refreshed.microDefinitionParts ||
      buildFixedTaxonomyDefinitionParts(refreshed, refreshed, {
        trueMicroFamilyId,
        parentTrueMicroFamilyId,
        setupType: taxonomy.setup,
        regimeBucket: taxonomy.regime,
        confirmationProfile: taxonomy.confirmationProfile
      }),
    32,
    220
  );

  const parentDefinitionParts = compactDefinitionParts(
    refreshed.parentDefinitionParts ||
      refreshed.macroDefinitionParts ||
      buildParentDefinitionParts({
        parentTrueMicroFamilyId,
        setupType: taxonomy.setup,
        regimeBucket: taxonomy.regime
      }),
    16,
    180
  );

  const compact = withAnalyzeIdentityFlags({
    microFamilyId: trueMicroFamilyId,
    trueMicroFamilyId,
    childTrueMicroFamilyId: trueMicroFamilyId,

    familyId: refreshed.familyId || 'LONG_FIXED_TAXONOMY',

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
    broadTrueDefinitionParts: compactDefinitionParts(refreshed.broadTrueDefinitionParts || definitionParts, 12, 180),
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
    targetScannerSide: TARGET_SCANNER_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    scannerMicroFamilyId: refreshed.scannerMicroFamilyId || null,
    scannerFamilyId: refreshed.scannerFamilyId || null,
    scannerDefinition: refreshed.scannerDefinition ? truncateString(refreshed.scannerDefinition, 320) : null,
    scannerDefinitionParts: compactDefinitionParts(refreshed.scannerDefinitionParts, 8, 160),
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    executionFingerprintHash: refreshed.executionFingerprintHash || null,
    executionFingerprintParts: compactDefinitionParts(refreshed.executionFingerprintParts, 8, 160),
    executionFingerprintSchema: refreshed.executionFingerprintSchema || null,
    executionMicroFamilyId: refreshed.executionMicroFamilyId || null,
    executionFingerprintRole: refreshed.executionFingerprintRole || 'METADATA_ONLY',
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,

    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    definitionParts,
    microDefinitionParts: definitionParts,
    definition: definitionParts.length
      ? definitionParts.join(' | ')
      : truncateString(refreshed.definition || '', 900),
    microDefinition: definitionParts.length
      ? definitionParts.join(' | ')
      : truncateString(refreshed.microDefinition || refreshed.definition || '', 900),

    parentDefinitionParts,
    macroDefinitionParts: parentDefinitionParts,
    parentDefinition: parentDefinitionParts.length
      ? parentDefinitionParts.join(' | ')
      : truncateString(refreshed.parentDefinition || '', 600),
    macroDefinition: parentDefinitionParts.length
      ? parentDefinitionParts.join(' | ')
      : truncateString(refreshed.macroDefinition || refreshed.parentDefinition || '', 600),

    schema: TRUE_MICRO_SCHEMA,
    microFamilySchema: TRUE_MICRO_SCHEMA,
    version: 'fixed-taxonomy-75-child-smart-evidence-v3',
    classifierVersion: CLASSIFIER_VERSION,
    classifierNoDefaultRetestSqueezeB: true,
    noDefaultRetestSqueezeB: true,

    assetClass: refreshed.assetClass || 'CRYPTO',

    obRelation: refreshed.obRelation || null,
    btcRelation: refreshed.btcRelation || null,
    btcState: refreshed.btcState || null,

    flow: refreshed.flow || null,
    flowCoarse: refreshed.flowCoarse || null,

    regime: refreshed.regime || null,
    regimeCoarse: refreshed.regimeCoarse || null,

    scannerReason: refreshed.scannerReason ? truncateString(refreshed.scannerReason, 240) : null,
    scannerReasonCoarse: refreshed.scannerReasonCoarse || null,

    rsiZone: refreshed.rsiZone || null,
    rsiCoarse: refreshed.rsiCoarse || null,

    examples: compactExamples(refreshed.examples, 3, 220),
    recentOutcomes: compactRecentOutcomes(refreshed.recentOutcomes, 5),

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

    storageCompactionVersion: STORAGE_COMPACTION_VERSION,
    dedupeArraysStoredInMicros: false,
    observationDedupeKeysStoredInMicros: false,
    outcomeDedupeKeysStoredInMicros: false
  });

  for (const field of NUMERIC_MICRO_FIELDS) {
    if (refreshed[field] !== undefined && refreshed[field] !== null && refreshed[field] !== '') {
      compact[field] = number(refreshed[field], 0);
    }
  }

  const finalRow = purgeBloatKeys(refreshStats(compact));
  const learningStatus = getLearningStatus(finalRow);

  return purgeBloatKeys(withAnalyzeIdentityFlags({
    ...finalRow,

    learningStatus,
    status: learningStatus,
    tooEarly: number(finalRow.completed, 0) < MIN_COMPLETED_ACTIVE_LEARNING,
    tooEarlyReason: number(finalRow.completed, 0) < MIN_COMPLETED_ACTIVE_LEARNING
      ? `completed ${number(finalRow.completed, 0)}/${MIN_COMPLETED_ACTIVE_LEARNING}`
      : null,

    dedupeArraysStoredInMicros: false,
    observationDedupeKeysStoredInMicros: false,
    outcomeDedupeKeysStoredInMicros: false
  }));
}

function normalizeMicros(micros = {}) {
  const entries = Object.entries(micros || {});

  if (!entries.length) return {};

  return Object.fromEntries(
    entries
      .map(([id, row]) => {
        const microFamilyId = normalizeChildTrueMicroFamilyId(
          row?.trueMicroFamilyId || row?.microFamilyId || row?.childTrueMicroFamilyId || id,
          row || {}
        );

        if (!microFamilyId || !row) return null;

        const compact = compactMicroForStorage({
          ...row,
          microFamilyId,
          trueMicroFamilyId: microFamilyId,
          childTrueMicroFamilyId: microFamilyId
        });

        if (!compact) return null;
        if (!isLongOnlyRow(compact)) return null;

        return [microFamilyId, compact];
      })
      .filter(Boolean)
  );
}

function compareTopMicros(a = {}, b = {}) {
  const ar = refreshStats(a);
  const br = refreshStats(b);

  return (
    number(br.dashboardBalancedScore ?? br.balancedScore, 0) -
    number(ar.dashboardBalancedScore ?? ar.balancedScore, 0) ||

    number(br.fairWinrate ?? br.sampleAdjustedWinrate ?? br.wilsonLowerBound, 0) -
    number(ar.fairWinrate ?? ar.sampleAdjustedWinrate ?? ar.wilsonLowerBound, 0) ||

    number(br.totalR ?? br.netTotalR, 0) -
    number(ar.totalR ?? ar.netTotalR, 0) ||

    number(br.avgR ?? br.netAvgR, 0) -
    number(ar.avgR ?? ar.netAvgR, 0) ||

    number(ar.avgCostR ?? ar.totalCostR, 0) -
    number(br.avgCostR ?? br.totalCostR, 0) ||

    number(br.completed, 0) -
    number(ar.completed, 0) ||

    number(br.seen ?? br.observations, 0) -
    number(ar.seen ?? ar.observations, 0) ||

    String(ar.microFamilyId || '').localeCompare(String(br.microFamilyId || ''))
  );
}

function selectTopMicrosObject(micros = {}, limit = TOP_MICROS_LIMIT) {
  const safeLimit = Math.max(1, Math.floor(number(limit, TOP_MICROS_LIMIT)));

  const rows = Object.values(normalizeMicros(micros))
    .filter(Boolean)
    .filter(isLongOnlyRow)
    .filter((row) => isFixedTaxonomyChildMicroId(row.trueMicroFamilyId || row.microFamilyId))
    .sort(compareTopMicros)
    .slice(0, safeLimit);

  return Object.fromEntries(
    rows
      .map((row) => [
        row.trueMicroFamilyId || row.microFamilyId,
        purgeBloatKeys(withAnalyzeIdentityFlags(row))
      ])
      .filter(([id]) => Boolean(id))
  );
}

function payloadBytes(payload) {
  try {
    return Buffer.byteLength(JSON.stringify(payload), 'utf8');
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function isPayloadTooLargeError(error) {
  const message = String(error?.message || error || '').toLowerCase();

  return (
    message.includes('max request size exceeded') ||
    message.includes('err max request size exceeded') ||
    message.includes('request size') ||
    message.includes('too large') ||
    message.includes('10485760') ||
    message.includes('payloadtoolarge')
  );
}

function buildWeekPayload(weekKey, rows, extra = {}) {
  const safeRows = normalizeMicros(rows || {});
  const ids = Object.keys(safeRows);

  return {
    weekKey,
    updatedAt: now(),
    rows: safeRows,
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

    storageCompactionVersion: STORAGE_COMPACTION_VERSION,
    dedupeArraysStoredInMicros: false,
    observationDedupeKeysStoredInMicros: false,
    outcomeDedupeKeysStoredInMicros: false,

    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,

    ...extra
  };
}

function buildWeekMetaPayload(weekKey, rows, extra = {}) {
  return {
    weekKey,
    updatedAt: now(),
    microFamilies: Object.keys(rows || {}).length,

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

    storageCompactionVersion: STORAGE_COMPACTION_VERSION,
    dedupeArraysStoredInMicros: false,
    observationDedupeKeysStoredInMicros: false,
    outcomeDedupeKeysStoredInMicros: false,

    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,

    ...extra
  };
}

async function writeJsonFailSoft(redis, key, payload) {
  try {
    await setJson(redis, key, payload);

    return {
      ok: true,
      key,
      bytes: payloadBytes(payload)
    };
  } catch (error) {
    return {
      ok: false,
      key,
      bytes: payloadBytes(payload),
      payloadTooLarge: isPayloadTooLargeError(error),
      error: error?.message || String(error)
    };
  }
}

async function writeRowsWithFallback(redis, key, weekKey, rows, {
  mode = 'FULL',
  limits = [TOP_MICROS_LIMIT, REDUCED_MICROS_LIMIT, EMERGENCY_MICROS_LIMIT, LAST_RESORT_MICROS_LIMIT]
} = {}) {
  const normalized = normalizeMicros(rows || {});
  const count = Object.keys(normalized).length;

  let candidateRows = normalized;
  let payload = buildWeekPayload(weekKey, candidateRows, {
    storageMode: mode,
    originalCount: count,
    fallbackLevel: 'FULL'
  });

  if (payloadBytes(payload) <= MAX_REDIS_PAYLOAD_BYTES) {
    const result = await writeJsonFailSoft(redis, key, payload);

    if (result.ok || !result.payloadTooLarge) return result;
  }

  for (const limit of limits) {
    candidateRows = selectTopMicrosObject(normalized, limit);
    payload = buildWeekPayload(weekKey, candidateRows, {
      storageMode: `${mode}_TOP_${limit}_COMPACT_ROWS`,
      originalCount: count,
      reducedBecausePayloadTooLarge: true,
      fallbackLimit: limit
    });

    const result = await writeJsonFailSoft(redis, key, payload);

    if (result.ok) {
      return {
        ...result,
        fallbackLimit: limit,
        originalCount: count,
        storedCount: Object.keys(candidateRows).length
      };
    }

    if (!result.payloadTooLarge) return result;
  }

  const emptyPayload = buildWeekPayload(weekKey, {}, {
    storageMode: `${mode}_EMPTY_LAST_RESORT_AFTER_PAYLOAD_LIMIT`,
    originalCount: count,
    reducedBecausePayloadTooLarge: true,
    lastResort: true
  });

  return writeJsonFailSoft(redis, key, emptyPayload);
}

async function writeTopMicros(redis, weekKey, rows) {
  const normalized = normalizeMicros(rows || {});
  const key = getWeekMicrosTopKey(weekKey);

  for (const limit of [TOP_MICROS_LIMIT, REDUCED_MICROS_LIMIT, EMERGENCY_MICROS_LIMIT, LAST_RESORT_MICROS_LIMIT]) {
    const topRows = selectTopMicrosObject(normalized, limit);
    const payload = {
      weekKey,
      updatedAt: now(),
      rows: topRows,
      count: Object.keys(topRows).length,
      storageMode: `TOP_MICROS_SNAPSHOT_${limit}`,
      targetTradeSide: TARGET_TRADE_SIDE,
      trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
      classifierVersion: CLASSIFIER_VERSION,
      measurementFixVersion: MEASUREMENT_FIX_VERSION,
      storageCompactionVersion: STORAGE_COMPACTION_VERSION,
      dedupeArraysStoredInMicros: false,
      redisNamespace: LONG_NAMESPACE,
      redisKeyPrefix: LONG_KEY_PREFIX
    };

    const result = await writeJsonFailSoft(redis, key, payload);

    if (result.ok || !result.payloadTooLarge) {
      return {
        ...result,
        storedCount: Object.keys(topRows).length,
        limit
      };
    }
  }

  return writeJsonFailSoft(redis, key, {
    weekKey,
    updatedAt: now(),
    rows: {},
    count: 0,
    storageMode: 'TOP_MICROS_EMPTY_LAST_RESORT',
    targetTradeSide: TARGET_TRADE_SIDE,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    storageCompactionVersion: STORAGE_COMPACTION_VERSION
  });
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

  const incoming = normalizeMicros(micros || {});
  const onlySet = Array.isArray(onlyIds) && onlyIds.length
    ? new Set(onlyIds.map((id) => normalizeChildTrueMicroFamilyId(id)).filter(Boolean))
    : null;

  const filteredIncoming = onlySet
    ? Object.fromEntries(
        Object.entries(incoming)
          .filter(([id]) => onlySet.has(id))
      )
    : incoming;

  const clean = normalizeMicros({
    ...(existing || {}),
    ...(filteredIncoming || {})
  });

  const ids = Object.keys(clean);

  if (!ids.length && !allowEmptyFullSave) {
    return existing || {};
  }

  const baseWrite = await writeRowsWithFallback(
    redis,
    getWeekMicrosBaseKey(weekKey),
    weekKey,
    clean,
    {
      mode: 'FULL_MICROS_COMPACT'
    }
  );

  const topWrite = await writeTopMicros(redis, weekKey, clean);

  const meta = buildWeekMetaPayload(weekKey, clean, {
    fullWriteOk: Boolean(baseWrite.ok),
    fullWriteError: baseWrite.ok ? null : truncateString(baseWrite.error, 500),
    fullWritePayloadTooLarge: Boolean(baseWrite.payloadTooLarge),
    fullWriteBytes: baseWrite.bytes ?? null,
    fullWriteStorageMode: baseWrite.fallbackLimit
      ? `TOP_${baseWrite.fallbackLimit}_FALLBACK`
      : 'FULL_OR_REDUCED',
    topWriteOk: Boolean(topWrite.ok),
    topWriteError: topWrite.ok ? null : truncateString(topWrite.error, 500),
    topMicros: topWrite.storedCount ?? 0
  });

  await writeJsonFailSoft(redis, getWeekMetaKey(weekKey), meta);

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
      definitionParts: compactDefinitionParts(classified.definitionParts || [], 32, 220)
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
  micro.broadTrueDefinitionParts = compactDefinitionParts(
    micro.broadTrueDefinitionParts || classified.broadTrueDefinitionParts || classified.definitionParts || [],
    12,
    180
  );
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
  micro.executionFingerprintParts = compactDefinitionParts(
    micro.executionFingerprintParts || classified.executionFingerprintParts || [],
    8,
    160
  );
  micro.executionFingerprintSchema ||= classified.executionFingerprintSchema || null;
  micro.executionMicroFamilyId ||= classified.executionMicroFamilyId || null;
  micro.executionFingerprintRole ||= classified.executionFingerprintRole || 'METADATA_ONLY';

  micro.scannerMicroFamilyId ||= classified.scannerMicroFamilyId || null;
  micro.scannerFamilyId ||= classified.scannerFamilyId || null;
  micro.scannerDefinition ||= classified.scannerDefinition ? truncateString(classified.scannerDefinition, 320) : null;
  micro.scannerDefinitionParts = compactDefinitionParts(
    micro.scannerDefinitionParts || classified.scannerDefinitionParts || [],
    8,
    160
  );

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
  micro.version = 'fixed-taxonomy-75-child-smart-evidence-v3';

  micro.parentDefinition ||= classified.parentDefinition || '';
  micro.parentDefinitionParts = compactDefinitionParts(
    micro.parentDefinitionParts || classified.parentDefinitionParts || [],
    16,
    180
  );

  micro.definitionParts = compactDefinitionParts(
    mergeDefinitionParts(
      micro.definitionParts || [],
      classified.definitionParts || []
    ),
    32,
    220
  );

  micro.definition = micro.definitionParts.length
    ? micro.definitionParts.join(' | ')
    : truncateString(classified.definition || '', 900);

  micro.assetClass ||= classified.assetClass || null;

  micro.obRelation ||= classified.obRelation || null;
  micro.btcRelation ||= classified.btcRelation || null;
  micro.btcState ||= classified.btcState || null;

  micro.flow ||= classified.flow || null;
  micro.flowCoarse ||= classified.flowCoarse || null;

  micro.regime ||= classified.regime || null;
  micro.regimeCoarse ||= classified.regimeCoarse || null;

  micro.scannerReason ||= classified.scannerReason ? truncateString(classified.scannerReason, 240) : null;
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

  Object.assign(micro, purgeBloatKeys(micro));

  micro.storageCompactionVersion = STORAGE_COMPACTION_VERSION;
  micro.dedupeArraysStoredInMicros = false;
  micro.observationDedupeKeysStoredInMicros = false;
  micro.outcomeDedupeKeysStoredInMicros = false;

  micro.learningStatus = getLearningStatus(micro);
  micro.status = micro.learningStatus;
  micro.tooEarly = number(micro.completed, 0) < MIN_COMPLETED_ACTIVE_LEARNING;
  micro.tooEarlyReason = micro.tooEarly
    ? `completed ${number(micro.completed, 0)}/${MIN_COMPLETED_ACTIVE_LEARNING}`
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

  const entry = number(row.entry || row.entryPrice, 0);

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
      metrics: withAnalyzeIdentityFlags(stripBulkyFields(metrics)),
      ...buildAnalyzeVariants(metrics)
    }))
    .filter((row) => row.primary)
    .filter((row) => normalizeChildTrueMicroFamilyId(row.primary.trueMicroFamilyId || row.primary.microFamilyId));

  if (variantRows.length === 0) {
    return [];
  }

  const micros = await getWeekMicros(weekKey);

  const analyzed = [];
  const actuallyTouchedIds = new Set();

  for (const batch of variantRows) {
    const classified = batch.primary;

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
      { type: 'OBSERVATION' }
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
      ...stripBulkyFields(batch.metrics),
      ...stripBulkyFields(classified),

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
    micros[microFamilyId] = compactMicroForStorage(micro) || purgeBloatKeys(micro);

    actuallyTouchedIds.add(microFamilyId);

    analyzed.push(withAnalyzeIdentityFlags({
      ...stripBulkyFields(batch.metrics),
      ...stripBulkyFields(classified),

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

  const definitionParts = compactDefinitionParts(
    mergeDefinitionParts(
      outcome.definitionParts || [],
      outcome.broadTrueDefinitionParts || [],
      [
        `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
        `LOCKED_MICRO=${microFamilyId}`,
        `LOCKED_TRUE_MICRO=${microFamilyId}`,
        `LOCKED_PARENT_TRUE_MICRO=${parentTrueMicroFamilyId}`,
        'OUTCOME_IDENTITY=POSITION_LOCKED'
      ]
    ),
    32,
    220
  );

  const parentDefinitionParts = compactDefinitionParts(
    mergeDefinitionParts(
      outcome.parentDefinitionParts || [],
      outcome.macroDefinitionParts || [],
      [
        `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
        `PARENT_TRUE_MICRO=${parentTrueMicroFamilyId}`,
        `SETUP=${parsed.setup}`,
        `REGIME_BUCKET=${parsed.regime}`
      ]
    ),
    16,
    180
  );

  return withAnalyzeIdentityFlags({
    ...stripBulkyFields(outcome),

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
    broadTrueDefinitionParts: definitionParts,
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
    scannerDefinition: outcome.scannerDefinition ? truncateString(outcome.scannerDefinition, 320) : null,
    scannerDefinitionParts: compactDefinitionParts(outcome.scannerDefinitionParts, 8, 160),
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
  const existingNetR = number(
    outcome.netR ??
      outcome.exitR ??
      outcome.realizedNetR ??
      outcome.realizedR ??
      outcome.r,
    null
  );

  const existingGrossR = number(
    outcome.grossR ??
      outcome.rawR ??
      outcome.realizedGrossR,
    null
  );

  const existingCostR = number(
    outcome.costR ??
      outcome.avgCostR ??
      outcome.totalCostR,
    null
  );

  const entry = number(outcome.entry, 0);
  const exit = number(outcome.exit ?? outcome.exitPrice, 0);
  const initialSl = number(outcome.initialSl || outcome.sl, 0);
  const tp = number(outcome.tp, 0);

  const validLongRiskShape =
    entry > 0 &&
    initialSl > 0 &&
    tp > 0 &&
    initialSl < entry &&
    entry < tp;

  const riskPct =
    number(outcome.riskPct, 0) ||
    calcRiskPct({
      entry,
      sl: initialSl
    });

  const grossMovePct = number(
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
      entrySpreadPct: number(outcome.entrySpreadPct ?? outcome.spreadPct, 0),
      exitSpreadPct: number(outcome.exitSpreadPct ?? outcome.spreadPct, 0)
    }) || {};

    const netR = number(cost.netR, existingNetR ?? 0);
    const grossR = number(cost.grossR, existingGrossR ?? 0);
    const costR = number(cost.costR, existingCostR ?? Math.max(0, grossR - netR));

    return withAnalyzeIdentityFlags({
      ...outcome,

      validLongRiskShape,

      grossMovePct,
      riskPct,

      grossR,
      rawR: grossR,
      realizedGrossR: grossR,
      grossPnlPct: number(cost.grossPnlPct, 0),

      netR,
      exitR: netR,
      realizedNetR: netR,
      realizedR: netR,
      r: netR,
      pnlPct: number(cost.netPnlPct, 0),
      netPnlPct: number(cost.netPnlPct, 0),

      costR,
      avgCostR: costR,
      costPct: number(cost.costPct, 0),
      feePct: number(cost.feePct, 0),
      slippagePct: number(cost.slippagePct, 0),

      win: netR > 0,
      loss: netR < 0,
      flat: netR === 0,
      isWin: netR > 0,

      costModelApplied: true,
      netCostModelApplied: true,
      costModel: outcome.costModel || 'APPLY_COSTS_NET_R_V1'
    });
  }

  const fallbackNetR = number(existingNetR, 0);
  const fallbackGrossR = number(existingGrossR, fallbackNetR);
  const fallbackCostR = number(
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
  const netR = number(outcome.netR ?? outcome.exitR, 0).toFixed(6);
  const exitPrice = number(outcome.exit ?? outcome.exitPrice, 0).toFixed(8);

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
      ...stripBulkyFields(outcome),
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
    ...stripBulkyFields(outcome),
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
    { type: 'OUTCOME' }
  );

  if (outcomeClaim.duplicate === true) {
    return withAnalyzeIdentityFlags({
      ...stripBulkyFields(row),
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
    ...stripBulkyFields(row),

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

    netR: number(row.netR ?? row.exitR, 0),
    exitR: number(row.exitR ?? row.netR, 0),
    realizedNetR: number(row.realizedNetR ?? row.netR ?? row.exitR, 0),
    realizedR: number(row.realizedR ?? row.netR ?? row.exitR, 0),
    r: number(row.r ?? row.netR ?? row.exitR, 0),

    costR: number(row.costR, 0),
    avgCostR: number(row.avgCostR ?? row.costR, 0),
    grossR: number(row.grossR, 0),
    rawR: number(row.rawR ?? row.grossR, 0),
    realizedGrossR: number(row.realizedGrossR ?? row.grossR, 0),

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
  micros[microFamilyId] = compactMicroForStorage(micro) || purgeBloatKeys(micro);

  await saveWeekMicros(
    weekKey,
    micros,
    {
      onlyIds: [microFamilyId]
    }
  );

  return withAnalyzeIdentityFlags({
    ...stripBulkyFields(row),
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

  const mfeR = number(position.mfeR, 0);
  const maeR = number(position.maeR, 0);

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
    broadTrueDefinitionParts: compactDefinitionParts(position.broadTrueDefinitionParts || [], 12, 180),
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
    executionFingerprintParts: compactDefinitionParts(position.executionFingerprintParts || [], 8, 160),
    executionFingerprintSchema: position.executionFingerprintSchema || null,
    executionMicroFamilyId: position.executionMicroFamilyId || null,
    executionFingerprintRole: 'METADATA_ONLY',

    scannerMicroFamilyId: position.scannerMicroFamilyId || null,
    scannerFamilyId: position.scannerFamilyId || null,
    scannerDefinition: position.scannerDefinition ? truncateString(position.scannerDefinition, 320) : null,
    scannerDefinitionParts: compactDefinitionParts(position.scannerDefinitionParts || [], 8, 160),
    scannerFingerprintRole: 'METADATA_ONLY',

    definitionParts: compactDefinitionParts(position.definitionParts || [], 32, 220),
    definition: position.definition ? truncateString(position.definition, 900) : null,

    parentDefinition: position.parentDefinition ? truncateString(position.parentDefinition, 600) : null,
    parentDefinitionParts: compactDefinitionParts(position.parentDefinitionParts || [], 16, 180),

    schema: TRUE_MICRO_SCHEMA,
    microFamilySchema: TRUE_MICRO_SCHEMA,
    version: 'fixed-taxonomy-75-child-smart-evidence-v3',

    assetClass: position.assetClass || null,

    rsiZone: position.rsiZone || null,
    rsiCoarse: position.rsiCoarse || null,

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

    scannerReason: position.scannerReason ? truncateString(position.scannerReason, 240) : null,
    scannerReasonCoarse: position.scannerReasonCoarse || null,

    spreadPct: position.spreadPct ?? null,
    exitSpreadPct: position.exitSpreadPct ?? null,
    spreadBps: position.spreadBps ?? null,

    fundingRate: position.fundingRate ?? null,

    entryQuality: position.entryQuality || null,
    retestConfirmed: Boolean(position.retestConfirmed),
    pullbackConfirmed: Boolean(position.pullbackConfirmed),
    sweepConfirmed: Boolean(position.sweepConfirmed),
    fakeBreakout: Boolean(position.fakeBreakout),
    fakeBreakoutRisk: Boolean(position.fakeBreakoutRisk),

    entryDistancePct: position.entryDistancePct ?? null,
    slDistancePct: position.slDistancePct ?? null,
    tpDistancePct: position.tpDistancePct ?? null,

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

  const entry = number(position.entry, 0);
  const initialSl = number(position.initialSl || position.sl, 0);
  const exit = number(exitPrice, 0);
  const tp = number(position.tp, 0);

  const validLongRiskShape =
    entry > 0 &&
    initialSl > 0 &&
    tp > 0 &&
    initialSl < entry &&
    entry < tp;

  const riskPct =
    number(position.riskPct, 0) ||
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
    entrySpreadPct: number(position.spreadPct, 0),
    exitSpreadPct: number(position.exitSpreadPct ?? position.spreadPct, 0)
  }) || {};

  const costR = number(cost.costR, 0);

  const netR = number(
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
    sl: number(position.sl, 0),
    initialSl,
    tp,
    rr: number(position.rr, 0),
    riskPct,

    validLongRiskShape,
    exitReason,

    grossMovePct,

    grossR,
    rawR: grossR,
    realizedGrossR: grossR,
    grossPnlPct: number(cost.grossPnlPct, grossMovePct),

    exitR: netR,
    pnlPct: number(cost.netPnlPct, 0),
    netR,
    realizedNetR: netR,
    realizedR: netR,
    r: netR,
    netPnlPct: number(cost.netPnlPct, 0),

    costR,
    avgCostR: costR,
    costPct: number(cost.costPct, 0),
    feePct: number(cost.feePct, 0),
    slippagePct: number(cost.slippagePct, 0),

    win: netR > 0,
    loss: netR < 0,
    flat: netR === 0,
    isWin: netR > 0,

    costModelApplied: true,
    netCostModelApplied: true,
    costModel: 'APPLY_COSTS_NET_R_V1',

    mfeR: number(position.mfeR, 0),
    maeR: number(position.maeR, 0),

    directToSL,
    directSL: directToSL,

    nearTpSeen: Boolean(position.nearTpSeen),
    reachedHalfR: Boolean(position.reachedHalfR),
    reachedOneR: Boolean(position.reachedOneR),

    beArmed: Boolean(position.beArmed),
    beWouldExit: Boolean(position.beWouldExit),
    beExitR: number(position.beExitR, 0),

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