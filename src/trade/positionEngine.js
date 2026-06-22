// ================= FILE: src/trade/positionEngine.js =================

import { KEYS } from '../keys.js';
import { CONFIG } from '../config.js';
import {
  getDurableRedis,
  getJson,
  setJson,
  getKeys
} from '../redis.js';
import {
  safeNumber,
  randomId,
  sideToTradeSide,
  normalizeBaseSymbol,
  mapConcurrent
} from '../utils.js';
import {
  buildOutcomeFromPosition,
  recordOutcome
} from '../analyze/analyzeEngine.js';
import { sendExitAlert } from '../discord/discord.js';
import { applyCosts } from './costModel.js';

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

const POSITION_SOURCE = 'VIRTUAL';
const OUTCOME_SOURCE = 'VIRTUAL';

const COST_MODEL_VERSION = 'POSITION_ENGINE_LONG_NET_COST_COMPACT_V9';
const MEASUREMENT_FIX_VERSION = 'LONG_COMPACT_INDEXED_POSITION_ENGINE_V1';

const DEFAULT_POSITION_TIME_STOP_MIN = 720;
const DEFAULT_OPEN_INDEX_LIMIT = 80;
const DEFAULT_MONITOR_LIMIT = 40;
const DEFAULT_MONITOR_PRICE_TIMEOUT_MS = 400;
const DEFAULT_MONITOR_MAX_RUNTIME_MS = 3000;
const MIN_COMPLETED_ACTIVE_LEARNING = 20;

const LONG_FIXED_SETUP_TYPES = new Set([
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

const LONG_FIXED_REGIME_BUCKETS = new Set(REGIME_ORDER);

const CONFIRMATION_PROFILE_ORDER = Object.freeze([
  'A_STRONG_ALIGN',
  'B_FLOW_ALIGN',
  'C_VOLUME_ALIGN',
  'D_MIXED_OK',
  'E_WEAK_CONTRA'
]);

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

function now() {
  return Date.now();
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function positiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const n = Math.floor(finiteNumber(value, fallback));
  return Math.max(min, Math.min(max, n));
}

function round4(value) {
  return Number(finiteNumber(value, 0).toFixed(4));
}

function round6(value) {
  return Number(finiteNumber(value, 0).toFixed(6));
}

function roundPrice(value) {
  const n = finiteNumber(value, 0);

  if (n >= 1000) return Number(n.toFixed(2));
  if (n >= 1) return Number(n.toFixed(6));

  return Number(n.toFixed(10));
}

function clonePlainObject(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value ?? null));
}

function withTimeout(promise, timeoutMs, fallback) {
  const ms = positiveInt(timeoutMs, 1000, 1, 30_000);

  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => {
      setTimeout(() => resolve(fallback), ms);
    })
  ]);
}

function namespacedLongKey(key, fallback) {
  const raw = String(key || fallback || '').trim();

  if (!raw) return `${LONG_KEY_PREFIX}MISSING_KEY`;
  if (raw.startsWith(LONG_KEY_PREFIX)) return raw;

  return `${LONG_KEY_PREFIX}${raw}`;
}

function storageSymbol(input) {
  const raw = typeof input === 'object'
    ? input?.symbol || input?.baseSymbol || input?.contractSymbol
    : input;

  const base = normalizeBaseSymbol(raw);

  return base || String(raw || '')
    .toUpperCase()
    .replace(/USDT|USDC|USD|PERP|SWAP|FUTURES|SPOT/g, '')
    .replace(/[^A-Z0-9]+/g, '')
    .trim();
}

function resolveOpenPatternKey() {
  const configured =
    KEYS.long?.trade?.openPattern ||
    KEYS.trade?.longOpenPattern ||
    KEYS.trade?.openPattern;

  return namespacedLongKey(configured, 'TRADE:OPEN:*');
}

function resolveOpenIndexKey() {
  const configured =
    KEYS.long?.trade?.openIndex ||
    KEYS.trade?.longOpenIndex ||
    'TRADE:OPEN:INDEX';

  return namespacedLongKey(configured, 'TRADE:OPEN:INDEX');
}

function resolveOpenKey(symbol) {
  const keySymbol = storageSymbol(symbol);

  if (!keySymbol) return null;

  if (typeof KEYS.long?.trade?.open === 'function') {
    return namespacedLongKey(
      KEYS.long.trade.open(keySymbol),
      `TRADE:OPEN:${keySymbol}`
    );
  }

  if (typeof KEYS.trade?.longOpen === 'function') {
    return namespacedLongKey(
      KEYS.trade.longOpen(keySymbol),
      `TRADE:OPEN:${keySymbol}`
    );
  }

  if (typeof KEYS.trade?.open === 'function') {
    return namespacedLongKey(
      KEYS.trade.open(keySymbol),
      `TRADE:OPEN:${keySymbol}`
    );
  }

  return namespacedLongKey(null, `TRADE:OPEN:${keySymbol}`);
}

const LONG_KEYS = {
  trade: {
    openPattern: resolveOpenPatternKey(),
    openIndex: resolveOpenIndexKey(),
    open: resolveOpenKey
  }
};

function tradeConfig() {
  return {
    dataConcurrency: positiveInt(
      CONFIG.long?.trade?.dataConcurrency ??
        CONFIG.trade?.dataConcurrency,
      4,
      1,
      12
    ),

    positionTimeStopMin: positiveInt(
      CONFIG.long?.trade?.positionTimeStopMin ??
        CONFIG.trade?.positionTimeStopMin,
      DEFAULT_POSITION_TIME_STOP_MIN,
      1,
      30 * 24 * 60
    ),

    openIndexLimit: positiveInt(
      CONFIG.long?.trade?.openIndexLimit ??
        CONFIG.trade?.openIndexLimit,
      DEFAULT_OPEN_INDEX_LIMIT,
      1,
      500
    ),

    monitorLimit: positiveInt(
      CONFIG.long?.trade?.monitorLimit ??
        CONFIG.trade?.monitorLimit,
      DEFAULT_MONITOR_LIMIT,
      1,
      200
    ),

    monitorPriceFetchTimeoutMs: positiveInt(
      CONFIG.long?.trade?.monitorPriceFetchTimeoutMs ??
        CONFIG.trade?.monitorPriceFetchTimeoutMs,
      DEFAULT_MONITOR_PRICE_TIMEOUT_MS,
      50,
      5000
    ),

    monitorMaxRuntimeMs: positiveInt(
      CONFIG.long?.trade?.monitorMaxRuntimeMs ??
        CONFIG.trade?.monitorMaxRuntimeMs,
      DEFAULT_MONITOR_MAX_RUNTIME_MS,
      500,
      20_000
    ),

    persistMonitorUpdates: Boolean(
      CONFIG.long?.trade?.persistMonitorUpdates ??
        CONFIG.trade?.persistMonitorUpdates ??
        false
    ),

    persistPriceFetchFailures: Boolean(
      CONFIG.long?.trade?.persistPriceFetchFailures ??
        CONFIG.trade?.persistPriceFetchFailures ??
        false
    )
  };
}

function manageConfig() {
  return {
    applyLive: CONFIG.long?.manage?.applyLive === true || CONFIG.manage?.applyLive === true,
    beArmR: finiteNumber(CONFIG.long?.manage?.beArmR ?? CONFIG.manage?.beArmR, 0.70),
    beLockR: finiteNumber(CONFIG.long?.manage?.beLockR ?? CONFIG.manage?.beLockR, 0.05),
    trailArmR: finiteNumber(CONFIG.long?.manage?.trailArmR ?? CONFIG.manage?.trailArmR, 1.00),
    trailLockR: finiteNumber(CONFIG.long?.manage?.trailLockR ?? CONFIG.manage?.trailLockR, 0.35)
  };
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
    rawId: String(id || '').trim(),
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

function isExactLongChildTrueMicroId(id = '') {
  const parsed = parseLongTaxonomyMicroId(id);
  return Boolean(parsed.valid && parsed.selectable && parsed.isChild);
}

function isParentLongTrueMicroId(id = '') {
  const parsed = parseLongTaxonomyMicroId(id);
  return Boolean(parsed.valid && parsed.isParent && !parsed.selectable);
}

function stripSymbolTokensFromLearningId(id = '', row = {}) {
  const raw = String(id || '').trim();

  if (!raw) return raw;

  if (isExactLongChildTrueMicroId(raw) || isParentLongTrueMicroId(raw)) {
    return raw.toUpperCase();
  }

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

function normalizeTradeSide(value) {
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
    normalized === 'BUY' ||
    normalized.includes('MICRO_LONG_') ||
    normalized.includes('TRADESIDE_LONG') ||
    normalized.includes('TRADE_SIDE_LONG') ||
    normalized.includes('POSITION_SIDE_LONG') ||
    normalized.includes('POSITIONSIDE_LONG') ||
    normalized.includes('SIDE_LONG') ||
    normalized.includes('SIDE_BULL') ||
    normalized.includes('DIRECTION_LONG') ||
    normalized.includes('DIRECTION_BULL') ||
    normalized.includes('SIDE_BUY') ||
    normalized.includes('DIRECTION_BUY') ||
    normalized.startsWith('LONG_') ||
    normalized.includes('_LONG_') ||
    normalized.endsWith('_LONG') ||
    normalized.startsWith('BULL_') ||
    normalized.includes('_BULL_') ||
    normalized.endsWith('_BULL') ||
    normalized.startsWith('BUY_') ||
    normalized.includes('_BUY_') ||
    normalized.endsWith('_BUY');

  const shortHit =
    normalized === 'SHORT' ||
    normalized === 'BEAR' ||
    normalized === 'SELL' ||
    normalized.includes('MICRO_SHORT_') ||
    normalized.includes('TRADESIDE_SHORT') ||
    normalized.includes('TRADE_SIDE_SHORT') ||
    normalized.includes('POSITION_SIDE_SHORT') ||
    normalized.includes('POSITIONSIDE_SHORT') ||
    normalized.includes('SIDE_SHORT') ||
    normalized.includes('SIDE_BEAR') ||
    normalized.includes('DIRECTION_SHORT') ||
    normalized.includes('DIRECTION_BEAR') ||
    normalized.includes('SIDE_SELL') ||
    normalized.includes('DIRECTION_SELL') ||
    normalized.startsWith('SHORT_') ||
    normalized.includes('_SHORT_') ||
    normalized.endsWith('_SHORT') ||
    normalized.startsWith('BEAR_') ||
    normalized.includes('_BEAR_') ||
    normalized.endsWith('_BEAR') ||
    normalized.startsWith('SELL_') ||
    normalized.includes('_SELL_') ||
    normalized.endsWith('_SELL');

  if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;
  if (longHit && !shortHit) return TARGET_TRADE_SIDE;

  if (longHit && shortHit) {
    if (normalized.includes('TRADE_SIDE_LONG') || normalized.includes('TRADESIDE_LONG')) {
      return TARGET_TRADE_SIDE;
    }

    if (normalized.includes('TRADE_SIDE_SHORT') || normalized.includes('TRADESIDE_SHORT')) {
      return OPPOSITE_TRADE_SIDE;
    }

    if (normalized.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
    if (normalized.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function normalizedTextParts(row = {}) {
  return [
    row.definition,
    row.microDefinition,
    row.macroDefinition,
    row.parentDefinition,
    ...(Array.isArray(row.definitionParts) ? row.definitionParts.slice(0, 30) : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts.slice(0, 30) : []),
    ...(Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts.slice(0, 30) : []),
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts.slice(0, 30) : []),
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts.slice(0, 20) : [])
  ]
    .map((value) => String(value || '').toUpperCase())
    .filter(Boolean);
}

function idText(row = {}) {
  return [
    row.familyId,
    row.family,
    row.baseFamilyId,
    row.childTrueMicroFamilyId,
    row.trueMicroFamilyId,
    row.microFamilyId,
    row.analyzeMicroFamilyId,
    row.learningMicroFamilyId,
    row.fixedTaxonomyMicroFamilyId,
    row.coarseMicroFamilyId,
    row.baseMicroFamilyId,
    row.legacyMicroFamilyId,
    row.scannerMicroFamilyId,
    row.scannerFamilyId,
    row.executionMicroFamilyId,
    row.parentTrueMicroFamilyId,
    row.macroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId,
    row.parentFamilyId,
    row.id,
    row.key
  ]
    .map((value) => String(value || '').toUpperCase())
    .filter(Boolean)
    .join('|');
}

function hasLongIdSignal(text = '') {
  const raw = String(text || '').toUpperCase();

  return (
    raw.includes('MICRO_LONG_') ||
    raw.includes('LONG_') ||
    raw.includes('_LONG_') ||
    raw.endsWith('_LONG') ||
    raw.includes('TRADESIDE=LONG') ||
    raw.includes('TRADE_SIDE=LONG') ||
    raw.includes('SIDE=LONG') ||
    raw.includes('SIDE=BULL') ||
    raw.includes('DIRECTION=LONG') ||
    raw.includes('DIRECTION=BULL') ||
    raw.includes('POSITION_SIDE=LONG') ||
    raw.includes('POSITIONSIDE=LONG')
  );
}

function hasShortIdSignal(text = '') {
  const raw = String(text || '').toUpperCase();

  return (
    raw.includes('MICRO_SHORT_') ||
    raw.includes('SHORT_') ||
    raw.includes('_SHORT_') ||
    raw.endsWith('_SHORT') ||
    raw.includes('TRADESIDE=SHORT') ||
    raw.includes('TRADE_SIDE=SHORT') ||
    raw.includes('SIDE=SHORT') ||
    raw.includes('SIDE=BEAR') ||
    raw.includes('DIRECTION=SHORT') ||
    raw.includes('DIRECTION=BEAR') ||
    raw.includes('POSITION_SIDE=SHORT') ||
    raw.includes('POSITIONSIDE=SHORT')
  );
}

function hasLongDefinitionSignal(parts = []) {
  const haystack = parts.join('|');

  return (
    haystack.includes('TRADESIDE=LONG') ||
    haystack.includes('TRADE_SIDE=LONG') ||
    haystack.includes('SIDE=LONG') ||
    haystack.includes('SIDE=BULL') ||
    haystack.includes('DIRECTION=LONG') ||
    haystack.includes('DIRECTION=BULL') ||
    haystack.includes('POSITION_SIDE=LONG') ||
    haystack.includes('POSITIONSIDE=LONG') ||
    haystack.includes('SIDE=BUY') ||
    haystack.includes('DIRECTION=BUY') ||
    haystack.includes('MICRO_LONG_')
  );
}

function hasShortDefinitionSignal(parts = []) {
  const haystack = parts.join('|');

  return (
    haystack.includes('TRADESIDE=SHORT') ||
    haystack.includes('TRADE_SIDE=SHORT') ||
    haystack.includes('SIDE=SHORT') ||
    haystack.includes('SIDE=BEAR') ||
    haystack.includes('DIRECTION=SHORT') ||
    haystack.includes('DIRECTION=BEAR') ||
    haystack.includes('POSITION_SIDE=SHORT') ||
    haystack.includes('POSITIONSIDE=SHORT') ||
    haystack.includes('SIDE=SELL') ||
    haystack.includes('DIRECTION=SELL') ||
    haystack.includes('MICRO_SHORT_')
  );
}

function inferTradeSideFromIds(row = {}) {
  const haystack = idText(row);

  if (!haystack) return 'UNKNOWN';

  if (hasLongIdSignal(haystack) && !hasShortIdSignal(haystack)) return TARGET_TRADE_SIDE;
  if (hasShortIdSignal(haystack) && !hasLongIdSignal(haystack)) return OPPOSITE_TRADE_SIDE;

  if (haystack.includes('TRADE_SIDE=LONG') || haystack.includes('TRADESIDE=LONG')) return TARGET_TRADE_SIDE;
  if (haystack.includes('TRADE_SIDE=SHORT') || haystack.includes('TRADESIDE=SHORT')) return OPPOSITE_TRADE_SIDE;
  if (haystack.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
  if (haystack.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function inferTradeSideFromDefinitions(row = {}) {
  const parts = normalizedTextParts(row);

  if (!parts.length) return 'UNKNOWN';

  if (hasLongDefinitionSignal(parts) && !hasShortDefinitionSignal(parts)) return TARGET_TRADE_SIDE;
  if (hasShortDefinitionSignal(parts) && !hasLongDefinitionSignal(parts)) return OPPOSITE_TRADE_SIDE;

  const haystack = parts.join('|');

  if (haystack.includes('TRADE_SIDE=LONG') || haystack.includes('TRADESIDE=LONG')) return TARGET_TRADE_SIDE;
  if (haystack.includes('TRADE_SIDE=SHORT') || haystack.includes('TRADESIDE=SHORT')) return OPPOSITE_TRADE_SIDE;
  if (haystack.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
  if (haystack.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function inferPositionTradeSide(row = {}) {
  if (typeof row === 'string') return normalizeTradeSide(row);

  if (!row || typeof row !== 'object') return 'UNKNOWN';

  const directSources = [
    row.tradeSide,
    row.positionSide,
    row.direction,
    row.signalSide,
    row.scannerSide,
    row.analysisSide,
    row.actualScannerSide,
    row.side
  ];

  for (const value of directSources) {
    const side = normalizeTradeSide(value);

    if (side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE) return side;
  }

  const fromIds = inferTradeSideFromIds(row);

  if (fromIds === TARGET_TRADE_SIDE || fromIds === OPPOSITE_TRADE_SIDE) return fromIds;

  const fromDefinitions = inferTradeSideFromDefinitions(row);

  if (fromDefinitions === TARGET_TRADE_SIDE || fromDefinitions === OPPOSITE_TRADE_SIDE) {
    return fromDefinitions;
  }

  if (row.longOnly === true || row.shortDisabled === true) return TARGET_TRADE_SIDE;
  if (row.shortOnly === true || row.longDisabled === true) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function isLongPosition(row = {}) {
  return inferPositionTradeSide(row) === TARGET_TRADE_SIDE;
}

function firstValidLearningId(row = {}, candidates = []) {
  for (const candidate of candidates) {
    const raw = String(candidate || '').trim();

    if (!raw) continue;
    if (isScannerFingerprintId(raw)) continue;
    if (isExecutionFingerprintId(raw)) continue;

    const clean = stripSymbolTokensFromLearningId(raw, row);

    if (!clean) continue;
    if (isScannerFingerprintId(clean)) continue;
    if (isExecutionFingerprintId(clean)) continue;

    return clean.toUpperCase();
  }

  return '';
}

function rowMicroId(row = {}) {
  return firstValidLearningId(row, [
    row.childTrueMicroFamilyId,
    row.trueMicroFamilyId,
    row.microFamilyId,
    row.analyzeMicroFamilyId,
    row.learningMicroFamilyId,
    row.fixedTaxonomyMicroFamilyId
  ]);
}

function rowParentMicroId(row = {}) {
  const direct = firstValidLearningId(row, [
    row.parentTrueMicroFamilyId,
    row.coarseMicroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId,
    row.macroFamilyId
  ]);

  if (isParentLongTrueMicroId(direct)) return direct;

  const child = rowMicroId(row);
  const parsed = parseLongTaxonomyMicroId(child);

  return parsed.parentTrueMicroFamilyId || '';
}

function scannerMicroId(row = {}) {
  const candidates = [
    row.scannerMicroFamilyId,
    isScannerFingerprintId(row.microFamilyId) ? row.microFamilyId : null,
    isScannerFingerprintId(row.trueMicroFamilyId) ? row.trueMicroFamilyId : null,
    isScannerFingerprintId(row.id) ? row.id : null,
    isScannerFingerprintId(row.key) ? row.key : null
  ];

  return candidates.find(Boolean) || null;
}

function executionMicroId(row = {}) {
  const candidates = [
    row.executionMicroFamilyId,
    isExecutionFingerprintId(row.microFamilyId) ? row.microFamilyId : null,
    isExecutionFingerprintId(row.trueMicroFamilyId) ? row.trueMicroFamilyId : null,
    isExecutionFingerprintId(row.analyzeMicroFamilyId) ? row.analyzeMicroFamilyId : null,
    isExecutionFingerprintId(row.id) ? row.id : null,
    isExecutionFingerprintId(row.key) ? row.key : null
  ];

  return candidates.find(Boolean) || null;
}

function isScannerFamilyRow(row = {}) {
  return Boolean(
    isScannerFingerprintId(row.microFamilyId) ||
    isScannerFingerprintId(row.trueMicroFamilyId) ||
    isScannerFingerprintId(row.childTrueMicroFamilyId) ||
    isScannerFingerprintId(row.coarseMicroFamilyId) ||
    isScannerFingerprintId(row.id) ||
    isScannerFingerprintId(row.key)
  );
}

function isTrueMicroFamilyRow(row = {}) {
  const id = rowMicroId(row);
  const parsed = parseLongTaxonomyMicroId(id);

  if (!row || !id) return false;
  if (!validLearningId(id)) return false;
  if (isScannerFamilyRow(row)) return false;
  if (!isLongPosition(row) && !hasLongIdSignal(id)) return false;

  return Boolean(parsed.selectable && parsed.isChild);
}

function fallbackFamilyId(row = {}) {
  const parentId = rowParentMicroId(row);

  if (parentId) return parentId;

  const direct = String(
    row.familyId ||
    row.family ||
    row.baseFamilyId ||
    ''
  ).trim();

  if (direct && !isScannerFingerprintId(direct) && !isExecutionFingerprintId(direct)) {
    return stripSymbolTokensFromLearningId(direct, row);
  }

  return rowMicroId(row) || 'MICRO_LONG_UNKNOWN_PARENT';
}

function normalizeMicroIdentity(row = {}) {
  const microFamilyId = rowMicroId(row);
  const parsed = parseLongTaxonomyMicroId(microFamilyId);

  if (!microFamilyId) throw new Error('ANALYZE_TRUE_MICRO_FAMILY_ID_REQUIRED');
  if (isScannerFingerprintId(microFamilyId)) throw new Error('SCANNER_FINGERPRINT_CANNOT_BE_LEARNING_FAMILY_ID');
  if (isExecutionFingerprintId(microFamilyId)) throw new Error('EXECUTION_FINGERPRINT_CANNOT_BE_LEARNING_FAMILY_ID');
  if (!parsed.selectable || !parsed.isChild) throw new Error('EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_REQUIRED');

  const parentId = parsed.parentTrueMicroFamilyId;
  const scannerId = scannerMicroId(row);
  const executionId = executionMicroId(row);

  return {
    microFamilyId,
    trueMicroFamilyId: microFamilyId,
    childTrueMicroFamilyId: microFamilyId,
    analyzeMicroFamilyId: microFamilyId,
    learningMicroFamilyId: microFamilyId,
    fixedTaxonomyMicroFamilyId: microFamilyId,

    parentTrueMicroFamilyId: parentId,
    coarseMicroFamilyId: parentId,
    baseMicroFamilyId: parentId,
    legacyMicroFamilyId: parentId,

    familyId: fallbackFamilyId({
      ...row,
      parentTrueMicroFamilyId: parentId
    }) || parentId,

    parentMacroFamilyId: parentId,
    parentMicroFamilyId: parentId,
    macroFamilyId: parentId,

    setupType: parsed.setup,
    regimeBucket: parsed.regime,
    confirmationProfile: parsed.confirmationProfile,

    scannerMicroFamilyId: scannerId,
    scannerFamilyId: row.scannerFamilyId || null,
    scannerDefinition: row.scannerDefinition || null,
    scannerDefinitionParts: Array.isArray(row.scannerDefinitionParts)
      ? row.scannerDefinitionParts.slice(0, 12)
      : [],

    executionMicroFamilyId: executionId,

    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    exactTrueMicroFamilyRequired: true,
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    fixedTaxonomyLearningId: true,
    fixedTaxonomyPreferred: true,

    schema: TRUE_MICRO_SCHEMA,
    microFamilySchema: TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

    parentLearningEnabled: true,
    childLearningEnabled: true,
    selectionGranularity: 'EXACT_75_CHILD',
    fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED',

    isTrueMicro: true,
    trueMicro: true,
    isLegacyMacro: false,
    trueMicroOnly: true,
    exactTrueMicroOnly: true
  };
}

function validLongRiskGeometry(row = {}) {
  const entryPrice = finiteNumber(row.entry, 0);
  const sl = finiteNumber(row.sl, 0);
  const tp = finiteNumber(row.tp, 0);

  return entryPrice > 0 && sl > 0 && tp > 0 && sl < entryPrice && entryPrice < tp;
}

function assertLongRiskGeometry(row = {}) {
  if (!validLongRiskGeometry(row)) {
    throw new Error('OPEN_POSITION_LONG_RISK_GEOMETRY_INVALID_SL_LT_ENTRY_LT_TP_REQUIRED');
  }
}

function assertLearningFamilyIdentity(row = {}) {
  const microFamilyId = rowMicroId(row);

  if (!microFamilyId) throw new Error('OPEN_POSITION_TRUE_MICRO_FAMILY_ID_MISSING');
  if (isScannerFingerprintId(microFamilyId) || isScannerFamilyRow(row)) {
    throw new Error('OPEN_POSITION_SCANNER_FINGERPRINT_METADATA_ONLY');
  }
  if (isExecutionFingerprintId(microFamilyId)) {
    throw new Error('OPEN_POSITION_EXECUTION_FINGERPRINT_METADATA_ONLY');
  }
  if (!isExactLongChildTrueMicroId(microFamilyId)) {
    throw new Error('OPEN_POSITION_REQUIRES_EXACT_75_CHILD_TRUE_MICRO_FAMILY');
  }
  if (!isTrueMicroFamilyRow(row)) {
    throw new Error('OPEN_POSITION_REQUIRES_ANALYZE_TRUE_MICRO_FAMILY');
  }
}

function assertBasePositionFields(row = {}) {
  if (inferPositionTradeSide(row) !== TARGET_TRADE_SIDE) {
    throw new Error('OPEN_POSITION_LONG_ONLY_SYSTEM_REJECTED_NON_LONG_ENTRY');
  }

  if (!row.entry || !row.sl || !row.tp) {
    throw new Error('OPEN_POSITION_RISK_GEOMETRY_MISSING');
  }

  assertLearningFamilyIdentity(row);
  assertLongRiskGeometry(row);
}

function assertPositionPersistable(position = {}) {
  assertBasePositionFields(position);

  if (position.status && String(position.status).toUpperCase() !== 'OPEN') {
    throw new Error('OPEN_POSITION_STATUS_MUST_BE_OPEN');
  }
}

function assertLongInput(row = {}, context = 'POSITION') {
  const side = inferPositionTradeSide(row);

  if (side !== TARGET_TRADE_SIDE) {
    throw new Error(`${context}_LONG_ONLY_REJECTED_${side}`);
  }
}

function identityFlags() {
  return {
    virtualLearning: true,
    virtualOnly: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    exchangeOrdersDisabled: true,
    noRealOrders: true,
    noExchangeOrders: true,

    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
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
    fixedTaxonomyPreferred: true,

    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    discordOnlyForExactTrueMicroMatch: true,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    directSLDefinition: 'SL_EXIT_WITHOUT_MEANINGFUL_MFE',
    directSLMfeThresholdR: 0.25,
    seenDefinition: 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY',
    completedOnlyClosedVirtualOrShadow: true,

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    learningRemainsBroad: true,
    selectionWillBeAdaptive: true,
    discordWillBeStrict: true,

    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,

    parentLearningEnabled: true,
    childLearningEnabled: true,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    selectionGranularity: 'EXACT_75_CHILD',
    fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED',

    minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,

    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    shortRootTouched: false
  };
}

function forceLongPositionFields(row = {}) {
  return {
    ...row,

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

    virtualOnly: true,
    virtualTracked: true,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    exchangeCallsDisabled: true,
    noRealOrders: true,
    noExchangeOrders: true,

    ...identityFlags()
  };
}

function buildVirtualFlags(row = {}) {
  return {
    source: POSITION_SOURCE,
    outcomeSource: OUTCOME_SOURCE,
    positionSource: POSITION_SOURCE,

    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: false,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    exchangeCallsDisabled: true,
    bitgetOrderPlaced: false,

    liveEligible: false,
    discordAlertEligible: Boolean(row.discordAlertEligible),
    selectedMicroFamilyAlert: Boolean(row.selectedMicroFamilyAlert),
    selectedForDiscord: Boolean(row.selectedForDiscord || row.discordAlertEligible || row.selectedMicroFamilyAlert),

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    learningRemainsBroad: true,
    selectionWillBeAdaptive: true,
    discordWillBeStrict: true
  };
}

function compactMarketWeather(value = null) {
  if (!value || typeof value !== 'object') return null;

  return {
    ok: value.ok !== false,
    available: value.available ?? value.ok ?? true,
    snapshotId: value.snapshotId || null,
    createdAt: finiteNumber(value.createdAt ?? value.generatedAt ?? value.updatedAt, 0),
    updatedAt: finiteNumber(value.updatedAt ?? value.completedAt ?? value.createdAt, 0),
    regime: value.regime || value.currentRegime || null,
    currentRegime: value.currentRegime || value.regime || null,
    trendSide: value.trendSide || value.currentTrendSide || null,
    currentTrendSide: value.currentTrendSide || value.trendSide || null,
    confidence: value.confidence ?? value.weatherConfidence ?? null,
    bullishPct: value.bullishPct ?? null,
    bearishPct: value.bearishPct ?? null,
    squeezePct: value.squeezePct ?? null,
    btcState: value.btcState || null,
    rowsOmittedForRedis: true,
    symbolsOmittedForRedis: true,
    compactedForRedis: true
  };
}

function compactStats(value = null) {
  if (!value || typeof value !== 'object') return null;

  return {
    microFamilyId: value.microFamilyId || value.trueMicroFamilyId || null,
    completed: finiteNumber(value.completed, 0),
    seen: finiteNumber(value.seen, 0),
    observations: finiteNumber(value.observations, 0),
    wins: finiteNumber(value.wins, 0),
    losses: finiteNumber(value.losses, 0),
    flats: finiteNumber(value.flats, 0),
    winrate: finiteNumber(value.winrate ?? value.fairWinrate, 0),
    fairWinrate: finiteNumber(value.fairWinrate ?? value.winrate, 0),
    totalR: round6(value.totalR),
    avgR: round6(value.avgR),
    avgCostR: round6(value.avgCostR ?? value.costR),
    balancedScore: round6(value.balancedScore),
    dashboardBalancedScore: round6(value.dashboardBalancedScore ?? value.balancedScore)
  };
}

function compactPositionForStorage(input = {}) {
  const normalized = forceLongPositionFields(input);
  const identity = normalizeMicroIdentity(normalized);
  const keySymbol = storageSymbol(normalized);
  const openedAt = finiteNumber(normalized.openedAt || normalized.createdAt, now());
  const updatedAt = finiteNumber(normalized.updatedAt, now());

  const entry = roundPrice(normalized.entry);
  const sl = roundPrice(normalized.sl);
  const tp = roundPrice(normalized.tp);
  const initialSl = roundPrice(normalized.initialSl || normalized.sl);

  const definition = [
    'TRADE_SIDE=LONG',
    `TRUE_MICRO=${identity.trueMicroFamilyId}`,
    `PARENT_TRUE_MICRO=${identity.parentTrueMicroFamilyId}`,
    `SETUP=${identity.setupType}`,
    `REGIME_BUCKET=${identity.regimeBucket}`,
    `CONFIRMATION_PROFILE=${identity.confirmationProfile}`,
    'OUTCOME_IDENTITY=POSITION_LOCKED',
    'CURRENT_FIT_SOFT_ONLY=true',
    'CURRENT_FIT_BLOCKS_LEARNING=false',
    'LEARNING_REMAINS_BROAD=true'
  ].join(' | ');

  return forceLongPositionFields({
    ...identity,
    ...buildVirtualFlags(normalized),

    tradeId: normalized.tradeId || randomId('trade_long'),

    symbol: normalized.symbol || keySymbol,
    baseSymbol: normalized.baseSymbol || keySymbol,
    contractSymbol: normalized.contractSymbol || null,

    status: 'OPEN',

    entry,
    sl,
    tp,
    initialSl,
    rr: round6(normalized.rr),
    riskPct: round6(normalized.riskPct),
    rewardPct: round6(normalized.rewardPct),
    riskFraction: round6(normalized.riskFraction),
    riskSource: normalized.riskSource || null,
    riskEngineRisk: Boolean(normalized.riskEngineRisk),
    standardizedLearningRisk: Boolean(normalized.standardizedLearningRisk),
    standardizedLearningRiskReason: normalized.standardizedLearningRiskReason || null,

    spreadPct: round6(normalized.spreadPct ?? normalized.liveSpreadPct ?? CONFIG.long?.cost?.fallbackSpreadPct ?? CONFIG.cost?.fallbackSpreadPct),
    liveSpreadPct: round6(normalized.liveSpreadPct ?? normalized.spreadPct ?? CONFIG.long?.cost?.fallbackSpreadPct ?? CONFIG.cost?.fallbackSpreadPct),

    currentPrice: roundPrice(normalized.currentPrice ?? normalized.lastPrice ?? normalized.entry),
    lastPrice: roundPrice(normalized.lastPrice ?? normalized.currentPrice ?? normalized.entry),
    currentR: round4(normalized.currentR),
    mfeR: round4(normalized.mfeR),
    maeR: round4(normalized.maeR),
    maxTpProgress: round4(normalized.maxTpProgress),

    ticksObserved: finiteNumber(normalized.ticksObserved, 0),
    favorableTicks: finiteNumber(normalized.favorableTicks, 0),
    adverseTicks: finiteNumber(normalized.adverseTicks, 0),
    priceFetchFailures: finiteNumber(normalized.priceFetchFailures, 0),
    lastPriceFetchFailedAt: normalized.lastPriceFetchFailedAt || null,

    reachedHalfR: Boolean(normalized.reachedHalfR),
    reachedOneR: Boolean(normalized.reachedOneR),
    nearTpSeen: Boolean(normalized.nearTpSeen),
    directToSL: Boolean(normalized.directToSL),
    directSL: Boolean(normalized.directSL),

    beArmed: Boolean(normalized.beArmed),
    beWouldExit: Boolean(normalized.beWouldExit),
    beExitR: round4(normalized.beExitR),
    beWouldExitAt: normalized.beWouldExitAt || null,

    gaveBackAfterHalfR: Boolean(normalized.gaveBackAfterHalfR),
    gaveBackAfterOneR: Boolean(normalized.gaveBackAfterOneR),
    nearTpThenLoss: Boolean(normalized.nearTpThenLoss),

    liveManaged: Boolean(normalized.liveManaged),
    beLiveApplied: Boolean(normalized.beLiveApplied),
    trailLiveApplied: Boolean(normalized.trailLiveApplied),
    slManagementSource: normalized.slManagementSource || null,
    slMovedAt: normalized.slMovedAt || null,

    selectedRotationId: normalized.selectedRotationId || normalized.activeRotationId || null,
    activeRotationId: normalized.activeRotationId || normalized.selectedRotationId || null,
    selectedMicroFamilyAlert: Boolean(normalized.selectedMicroFamilyAlert),
    discordAlertEligible: Boolean(normalized.discordAlertEligible),
    selectedForDiscord: Boolean(normalized.selectedForDiscord || normalized.discordAlertEligible || normalized.selectedMicroFamilyAlert),
    discordAlertReason: normalized.discordAlertReason || null,
    rotationMatchType: normalized.rotationMatchType || null,

    selectedWeeklyStats: compactStats(normalized.selectedWeeklyStats || normalized.weeklyStats),
    weeklyStats: compactStats(normalized.weeklyStats || normalized.selectedWeeklyStats),

    entryMarketWeather: compactMarketWeather(normalized.entryMarketWeather || normalized.currentMarketWeather),
    currentMarketWeather: compactMarketWeather(normalized.currentMarketWeather),
    currentMarketWeatherAgeSec: normalized.currentMarketWeatherAgeSec ?? null,
    currentMarketWeatherStale: Boolean(normalized.currentMarketWeatherStale),
    entryCurrentRegime: normalized.entryCurrentRegime || normalized.currentRegime || null,
    entryCurrentTrendSide: normalized.entryCurrentTrendSide || normalized.currentTrendSide || null,
    entryCurrentFit: normalized.entryCurrentFit ?? normalized.currentFit ?? null,
    entryCurrentFitConfidence: normalized.entryCurrentFitConfidence ?? normalized.currentFitConfidence ?? null,
    entryWeatherFitMatchedFamily: normalized.entryWeatherFitMatchedFamily ?? null,
    currentFit: normalized.currentFit || normalized.entryCurrentFit || null,
    currentFitScore: round4(normalized.currentFitScore),
    currentFitConfidence: normalized.currentFitConfidence ?? normalized.entryCurrentFitConfidence ?? null,
    currentFitReason: normalized.currentFitReason || null,

    scannerScore: round4(normalized.scannerScore ?? normalized.moveScore),
    moveScore: round4(normalized.moveScore ?? normalized.scannerScore),
    scannerReason: normalized.scannerReason || null,
    scannerGatePassed: normalized.scannerGatePassed !== false,
    scannerGateReason: normalized.scannerGateReason || null,
    analyzeEligible: normalized.analyzeEligible !== false,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintOnlyMetadata: Boolean(identity.scannerMicroFamilyId),
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,

    executionFingerprintRole: 'METADATA_ONLY',
    executionFingerprintOnlyMetadata: Boolean(identity.executionMicroFamilyId),
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,

    definition,
    definitionParts: definition.split(' | '),

    validLongRiskShape: true,
    longRiskFormula: 'sl < entry < tp',
    longGrossRFormula: '(exitPrice - entry) / (entry - initialSl)',
    longCurrentRFormula: '(currentPrice - entry) / (entry - initialSl)',
    longExitRules: {
      tp: 'price >= tp',
      sl: 'price <= sl',
      timeStop: 'TIME_STOP'
    },

    strategyVersion: normalized.strategyVersion || CONFIG.strategyVersion || null,

    openedAt,
    createdAt: finiteNumber(normalized.createdAt || openedAt, openedAt),
    updatedAt,

    compactedForRedis: true,
    compactedAt: now(),
    compactVersion: MEASUREMENT_FIX_VERSION
  });
}

function normalizeOpenIndex(raw = null) {
  const symbols = {};

  if (!raw) {
    return {
      version: 'LONG_OPEN_INDEX_V1',
      updatedAt: 0,
      symbols
    };
  }

  if (Array.isArray(raw)) {
    for (const row of raw) {
      const symbol = storageSymbol(row?.symbol || row);
      if (!symbol) continue;

      symbols[symbol] = {
        symbol,
        key: LONG_KEYS.trade.open(symbol),
        tradeId: row?.tradeId || null,
        openedAt: finiteNumber(row?.openedAt || row?.createdAt, 0),
        microFamilyId: row?.microFamilyId || row?.trueMicroFamilyId || null
      };
    }

    return {
      version: 'LONG_OPEN_INDEX_V1',
      updatedAt: now(),
      symbols
    };
  }

  if (typeof raw === 'object') {
    const source = raw.symbols && typeof raw.symbols === 'object'
      ? raw.symbols
      : raw.rows && typeof raw.rows === 'object'
        ? raw.rows
        : {};

    for (const [key, value] of Object.entries(source)) {
      const symbol = storageSymbol(value?.symbol || key);
      if (!symbol) continue;

      symbols[symbol] = {
        symbol,
        key: value?.key || LONG_KEYS.trade.open(symbol),
        tradeId: value?.tradeId || null,
        openedAt: finiteNumber(value?.openedAt || value?.createdAt, 0),
        microFamilyId: value?.microFamilyId || value?.trueMicroFamilyId || null
      };
    }

    return {
      version: raw.version || 'LONG_OPEN_INDEX_V1',
      updatedAt: finiteNumber(raw.updatedAt, 0),
      symbols
    };
  }

  return {
    version: 'LONG_OPEN_INDEX_V1',
    updatedAt: 0,
    symbols
  };
}

async function readOpenIndex(redis = getDurableRedis()) {
  const raw = await getJson(redis, LONG_KEYS.trade.openIndex, null).catch(() => null);
  return normalizeOpenIndex(raw);
}

async function writeOpenIndex(redis, index) {
  const clean = normalizeOpenIndex(index);

  await setJson(redis, LONG_KEYS.trade.openIndex, {
    version: 'LONG_OPEN_INDEX_V1',
    namespace: LONG_NAMESPACE,
    keyPrefix: LONG_KEY_PREFIX,
    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,
    virtualOnly: true,
    oneOpenPositionPerSymbol: true,
    updatedAt: now(),
    symbols: clean.symbols,
    count: Object.keys(clean.symbols).length,
    compactedForRedis: true
  });

  return clean;
}

async function addToOpenIndex(redis, position) {
  const symbol = storageSymbol(position);

  if (!symbol) return null;

  const index = await readOpenIndex(redis);

  index.symbols[symbol] = {
    symbol,
    key: LONG_KEYS.trade.open(symbol),
    tradeId: position.tradeId || null,
    openedAt: finiteNumber(position.openedAt || position.createdAt, now()),
    microFamilyId: rowMicroId(position),
    trueMicroFamilyId: rowMicroId(position),
    parentTrueMicroFamilyId: rowParentMicroId(position),
    updatedAt: now()
  };

  await writeOpenIndex(redis, index);

  return index.symbols[symbol];
}

async function removeFromOpenIndex(redis, symbolInput) {
  const symbol = storageSymbol(symbolInput);

  if (!symbol) return null;

  const index = await readOpenIndex(redis);

  delete index.symbols[symbol];

  await writeOpenIndex(redis, index);

  return symbol;
}

function isValidOpenPosition(row = {}) {
  if (!row) return false;
  if (String(row.status || 'OPEN').toUpperCase() !== 'OPEN') return false;
  if (!isLongPosition(row)) return false;
  if (isScannerFamilyRow(row)) return false;
  if (!isExactLongChildTrueMicroId(rowMicroId(row))) return false;
  if (!validLongRiskGeometry(row)) return false;

  return true;
}

function sortOpenPositions(rows = []) {
  return rows
    .filter(isValidOpenPosition)
    .sort((a, b) => (
      finiteNumber(a.openedAt || a.createdAt, 0) -
      finiteNumber(b.openedAt || b.createdAt, 0)
    ));
}

async function readPositionByIndexEntry(redis, entry) {
  const symbol = storageSymbol(entry?.symbol);
  const key = entry?.key || LONG_KEYS.trade.open(symbol);

  if (!key) return null;

  const row = await getJson(redis, key, null).catch(() => null);

  if (!isValidOpenPosition(row)) return null;

  return row;
}

async function fallbackScanOpenPositions(redis, limit = DEFAULT_OPEN_INDEX_LIMIT) {
  const keys = await getKeys(
    redis,
    LONG_KEYS.trade.openPattern,
    positiveInt(limit, DEFAULT_OPEN_INDEX_LIMIT, 1, 1000)
  ).catch(() => []);

  const openKeys = keys
    .filter(Boolean)
    .filter((key) => key !== LONG_KEYS.trade.openIndex)
    .filter((key) => !String(key).endsWith(':INDEX'));

  if (!openKeys.length) return [];

  const rows = await Promise.all(
    openKeys.map((key) => getJson(redis, key, null).catch(() => null))
  );

  return sortOpenPositions(rows);
}

async function persistCompactedOpenRows(redis, rows = []) {
  const valid = sortOpenPositions(rows);

  for (const row of valid.slice(0, DEFAULT_OPEN_INDEX_LIMIT)) {
    const symbol = storageSymbol(row);
    const key = LONG_KEYS.trade.open(symbol);

    if (!symbol || !key) continue;

    const compact = compactPositionForStorage(row);
    await setJson(redis, key, compact).catch(() => null);
  }

  return valid;
}

async function rebuildOpenIndexFromRows(redis, rows = [], { compactPersist = false } = {}) {
  const valid = compactPersist
    ? await persistCompactedOpenRows(redis, rows)
    : sortOpenPositions(rows);

  const symbols = {};

  for (const row of valid) {
    const symbol = storageSymbol(row);
    if (!symbol) continue;

    symbols[symbol] = {
      symbol,
      key: LONG_KEYS.trade.open(symbol),
      tradeId: row.tradeId || null,
      openedAt: finiteNumber(row.openedAt || row.createdAt, 0),
      microFamilyId: rowMicroId(row),
      trueMicroFamilyId: rowMicroId(row),
      parentTrueMicroFamilyId: rowParentMicroId(row),
      updatedAt: now()
    };
  }

  await writeOpenIndex(redis, {
    version: 'LONG_OPEN_INDEX_V1',
    updatedAt: now(),
    symbols
  });

  return valid;
}

export async function getOpenPositions(options = {}) {
  const redis = getDurableRedis();
  const cfg = tradeConfig();
  const limit = positiveInt(options.limit ?? cfg.openIndexLimit, cfg.openIndexLimit, 1, 1000);

  const index = await readOpenIndex(redis);
  const indexEntries = Object.values(index.symbols || {}).slice(0, limit);

  if (indexEntries.length > 0) {
    const rows = await Promise.all(
      indexEntries.map((entry) => readPositionByIndexEntry(redis, entry))
    );

    const valid = sortOpenPositions(rows);

    if (valid.length > 0 || options.fallbackScanWhenIndexEmpty === false) {
      if (valid.length !== indexEntries.length && options.pruneStaleIndex !== false) {
        await rebuildOpenIndexFromRows(redis, valid).catch(() => null);
      }

      return valid.slice(0, limit);
    }
  }

  const scanned = await fallbackScanOpenPositions(redis, limit);

  if (scanned.length > 0) {
    await rebuildOpenIndexFromRows(redis, scanned, { compactPersist: true }).catch(() => null);
  }

  return scanned.slice(0, limit);
}

export async function getOpenPosition(symbol) {
  const keySymbol = storageSymbol(symbol);

  if (!keySymbol) return null;

  const row = await getJson(
    getDurableRedis(),
    LONG_KEYS.trade.open(keySymbol),
    null
  ).catch(() => null);

  if (!isValidOpenPosition(row)) return null;

  return row;
}

export async function saveOpenPosition(position) {
  assertLongInput(position, 'SAVE_OPEN_POSITION');

  const redis = getDurableRedis();
  const keySymbol = storageSymbol(position);

  if (!keySymbol) throw new Error('OPEN_POSITION_SYMBOL_MISSING');

  const existing = await getOpenPosition(keySymbol);

  if (
    existing &&
    existing.tradeId &&
    position.tradeId &&
    existing.tradeId !== position.tradeId
  ) {
    throw new Error('SYMBOL_ALREADY_OPEN_VIRTUAL_POSITION');
  }

  const row = compactPositionForStorage({
    ...position,
    symbol: position.symbol || keySymbol,
    baseSymbol: position.baseSymbol || keySymbol,
    status: 'OPEN',
    updatedAt: now()
  });

  assertPositionPersistable(row);

  await setJson(
    redis,
    LONG_KEYS.trade.open(keySymbol),
    row
  );

  await addToOpenIndex(redis, row).catch(() => null);

  return row;
}

async function redisDel(redis, key) {
  if (!key) return 0;

  if (typeof redis?.del === 'function') {
    return redis.del(key);
  }

  if (typeof redis?.unlink === 'function') {
    return redis.unlink(key);
  }

  await setJson(redis, key, null).catch(() => null);
  return 1;
}

export async function deleteOpenPosition(symbol) {
  const keySymbol = storageSymbol(symbol);

  if (!keySymbol) return 0;

  const redis = getDurableRedis();
  const key = LONG_KEYS.trade.open(keySymbol);

  if (!key) return 0;

  const result = await redisDel(redis, key).catch(() => 0);

  await removeFromOpenIndex(redis, keySymbol).catch(() => null);

  return result;
}

function calcStopFromR({
  entry,
  initialSl,
  stopR
} = {}) {
  const e = finiteNumber(entry, 0);
  const sl = finiteNumber(initialSl, 0);
  const r = finiteNumber(stopR, 0);

  if (e <= 0 || sl <= 0 || sl >= e) return 0;

  const riskDist = e - sl;

  if (riskDist <= 0) return 0;

  return e + riskDist * r;
}

function shouldTightenStop({
  currentSl,
  nextSl
} = {}) {
  const current = finiteNumber(currentSl, 0);
  const next = finiteNumber(nextSl, 0);

  if (current <= 0 || next <= 0) return false;

  return next > current;
}

function applyLiveStopManagement(position) {
  const cfg = manageConfig();

  if (!cfg.applyLive) return position;
  if (!isLongPosition(position)) return position;

  const entry = finiteNumber(position.entry, 0);
  const initialSl = finiteNumber(position.initialSl || position.sl, 0);
  const currentSl = finiteNumber(position.sl, 0);
  const currentR = finiteNumber(position.currentR, 0);

  if (entry <= 0 || initialSl <= 0 || currentSl <= 0 || initialSl >= entry) return position;

  let nextStopR = null;
  let source = null;

  if (currentR >= cfg.beArmR) {
    nextStopR = cfg.beLockR;
    source = 'BE';
  }

  if (currentR >= cfg.trailArmR) {
    nextStopR = Math.max(
      finiteNumber(nextStopR, cfg.beLockR),
      cfg.trailLockR
    );
    source = 'TRAIL';
  }

  if (nextStopR === null) return position;

  const nextSl = calcStopFromR({
    entry,
    initialSl,
    stopR: nextStopR
  });

  if (!shouldTightenStop({
    currentSl,
    nextSl
  })) {
    return position;
  }

  position.sl = roundPrice(nextSl);
  position.slManagementSource = source;
  position.slMovedAt = now();
  position.liveManaged = true;

  if (source === 'BE') position.beLiveApplied = true;
  if (source === 'TRAIL') position.trailLiveApplied = true;

  return position;
}

export function updatePathMetrics(position, price) {
  const cfg = manageConfig();

  if (!isLongPosition(position)) {
    position.updatedAt = now();
    position.longOnly = true;
    position.shortDisabled = true;
    position.shortOnly = false;
    position.longDisabled = false;
    position.liveManagementSkippedReason = 'NON_LONG_POSITION_IGNORED';

    return position;
  }

  const current = finiteNumber(price, 0);
  const entry = finiteNumber(position.entry, 0);
  const initialSl = finiteNumber(position.initialSl || position.sl, 0);
  const tp = finiteNumber(position.tp, 0);

  if (entry <= 0 || initialSl <= 0 || tp <= 0 || current <= 0 || initialSl >= entry || tp <= entry) {
    return forceLongPositionFields({
      ...position,
      updatedAt: now()
    });
  }

  const riskDist = entry - initialSl;
  const rewardDist = tp - entry;

  const directionalMove = current - entry;
  const currentR = directionalMove / riskDist;
  const tpProgress = directionalMove / rewardDist;

  position.lastPrice = roundPrice(current);
  position.currentPrice = roundPrice(current);
  position.currentR = round4(currentR);

  position.mfeR = round4(Math.max(
    finiteNumber(position.mfeR, 0),
    position.currentR
  ));

  position.maeR = round4(Math.min(
    finiteNumber(position.maeR, 0),
    position.currentR
  ));

  position.maxTpProgress = round4(Math.max(
    finiteNumber(position.maxTpProgress, 0),
    tpProgress
  ));

  position.ticksObserved = finiteNumber(position.ticksObserved, 0) + 1;

  if (currentR > 0) position.favorableTicks = finiteNumber(position.favorableTicks, 0) + 1;
  if (currentR < 0) position.adverseTicks = finiteNumber(position.adverseTicks, 0) + 1;

  if (position.mfeR >= 0.5) position.reachedHalfR = true;
  if (position.mfeR >= 1.0) position.reachedOneR = true;
  if (tpProgress >= 0.8) position.nearTpSeen = true;

  if (position.mfeR >= cfg.beArmR) {
    position.beArmed = true;

    if (currentR <= cfg.beLockR && !position.beWouldExit) {
      position.beWouldExit = true;
      position.beExitR = cfg.beLockR;
      position.beWouldExitAt = now();
    }
  }

  if (position.reachedHalfR && currentR < 0) position.gaveBackAfterHalfR = true;
  if (position.reachedOneR && currentR < cfg.trailLockR) position.gaveBackAfterOneR = true;
  if (position.nearTpSeen && currentR < 0) position.nearTpThenLoss = true;

  applyLiveStopManagement(position);

  Object.assign(position, forceLongPositionFields(position));

  position.updatedAt = now();

  return position;
}

export function buildOpenPositionFromEntry(entry) {
  assertLongInput(entry, 'BUILD_OPEN_POSITION_FROM_ENTRY');

  const normalizedEntry = forceLongPositionFields(entry);
  const keySymbol = storageSymbol(normalizedEntry);
  const openedAt = now();
  const identity = normalizeMicroIdentity(normalizedEntry);

  const position = compactPositionForStorage({
    ...normalizedEntry,
    ...identity,
    ...buildVirtualFlags(normalizedEntry),

    tradeId: normalizedEntry.tradeId || randomId('trade_long'),

    symbol: normalizedEntry.symbol || keySymbol,
    baseSymbol: normalizedEntry.baseSymbol || keySymbol,
    contractSymbol: normalizedEntry.contractSymbol || null,

    status: 'OPEN',

    strategyVersion: normalizedEntry.strategyVersion || CONFIG.strategyVersion,

    openedAt,
    createdAt: openedAt,
    updatedAt: openedAt,

    initialSl: normalizedEntry.initialSl || normalizedEntry.sl,

    currentPrice: normalizedEntry.currentPrice ?? normalizedEntry.lastPrice ?? normalizedEntry.entry,
    lastPrice: normalizedEntry.lastPrice ?? normalizedEntry.currentPrice ?? normalizedEntry.entry,

    currentR: 0,
    mfeR: 0,
    maeR: 0,
    maxTpProgress: 0,

    ticksObserved: 0,
    favorableTicks: 0,
    adverseTicks: 0,

    priceFetchFailures: 0,
    lastPriceFetchFailedAt: null,

    reachedHalfR: false,
    reachedOneR: false,
    nearTpSeen: false,

    directToSL: false,
    directSL: false,

    beArmed: false,
    beWouldExit: false,
    beExitR: 0,

    gaveBackAfterHalfR: false,
    gaveBackAfterOneR: false,
    nearTpThenLoss: false,

    liveManaged: false,
    beLiveApplied: false,
    trailLiveApplied: false,
    slManagementSource: null,

    entryMarketWeather: normalizedEntry.entryMarketWeather || normalizedEntry.currentMarketWeather || null,
    entryCurrentRegime: normalizedEntry.entryCurrentRegime || normalizedEntry.currentRegime || null,
    entryCurrentTrendSide: normalizedEntry.entryCurrentTrendSide || normalizedEntry.currentTrendSide || null,
    entryCurrentFit: normalizedEntry.entryCurrentFit ?? normalizedEntry.currentFit ?? null,
    entryCurrentFitConfidence: normalizedEntry.entryCurrentFitConfidence ?? normalizedEntry.currentFitConfidence ?? null,
    entryWeatherFitMatchedFamily: normalizedEntry.entryWeatherFitMatchedFamily ?? null
  });

  assertPositionPersistable(position);

  return position;
}

function fallbackExitPrice(position = {}) {
  return roundPrice(
    position.currentPrice ??
      position.lastPrice ??
      position.markPrice ??
      position.price ??
      position.entry
  );
}

function detectExit({
  position,
  price,
  timestamp
} = {}) {
  const cfg = tradeConfig();

  if (!isLongPosition(position)) {
    return {
      shouldExit: false,
      reason: 'NON_LONG_POSITION_IGNORED',
      trigger: null,
      exitPrice: 0
    };
  }

  const current = finiteNumber(price, 0);
  const tp = finiteNumber(position.tp, 0);
  const sl = finiteNumber(position.sl, 0);
  const openedAt = finiteNumber(position.openedAt || position.createdAt, 0);

  if (current > 0 && tp > 0 && current >= tp) {
    return {
      shouldExit: true,
      reason: 'TP',
      trigger: 'price >= tp',
      exitPrice: roundPrice(current)
    };
  }

  if (current > 0 && sl > 0 && current <= sl) {
    return {
      shouldExit: true,
      reason: 'SL',
      trigger: 'price <= sl',
      exitPrice: roundPrice(current)
    };
  }

  const expired =
    openedAt > 0 &&
    timestamp - openedAt >= cfg.positionTimeStopMin * 60 * 1000;

  if (expired) {
    return {
      shouldExit: true,
      reason: 'TIME_STOP',
      trigger: 'TIME_STOP',
      exitPrice: current > 0 ? roundPrice(current) : fallbackExitPrice(position),
      priceUnavailableTimeStop: current <= 0
    };
  }

  return {
    shouldExit: false,
    reason: null,
    trigger: null,
    exitPrice: current > 0 ? roundPrice(current) : 0
  };
}

async function markPriceFetchFailed(position, { persist = false } = {}) {
  position.priceFetchFailures = finiteNumber(position.priceFetchFailures, 0) + 1;
  position.lastPriceFetchFailedAt = now();
  position.updatedAt = now();

  if (persist) {
    await saveOpenPosition(forceLongPositionFields(position)).catch(() => null);
  }

  return position;
}

function isDirectSLExit({
  position,
  exitReason
} = {}) {
  const reason = upper(exitReason);

  const stoppedOut =
    reason === 'SL' ||
    reason === 'HIT_SL' ||
    reason === 'STOP' ||
    reason === 'STOP_LOSS' ||
    reason === 'STOPLOSS' ||
    reason === 'HARD_SL' ||
    reason === 'DIRECT_SL';

  if (!stoppedOut) return false;

  if (
    Boolean(position.nearTpSeen) ||
    Boolean(position.reachedHalfR) ||
    Boolean(position.reachedOneR)
  ) {
    return false;
  }

  const mfeR = finiteNumber(position.mfeR, 0);
  const maeR = finiteNumber(position.maeR, 0);

  return Boolean(position.directToSL || position.directSL) ||
    mfeR < 0.25 ||
    maeR <= -0.8;
}

function calcGrossMovePctFromPosition({
  position,
  exitPrice
} = {}) {
  const entry = finiteNumber(position.entry, 0);
  const exit = finiteNumber(exitPrice, 0);

  if (entry <= 0 || exit <= 0) return 0;

  return (exit - entry) / entry;
}

function calcGrossRFromPosition({
  position,
  exitPrice
} = {}) {
  const entry = finiteNumber(position.entry, 0);
  const initialSl = finiteNumber(position.initialSl || position.sl, 0);
  const exit = finiteNumber(exitPrice, 0);

  if (entry <= 0 || initialSl <= 0 || exit <= 0) return 0;

  const riskDistance = entry - initialSl;

  if (riskDistance <= 0) return 0;

  return (exit - entry) / riskDistance;
}

function calcRiskPctFromPosition(position = {}) {
  const entry = finiteNumber(position.entry, 0);
  const initialSl = finiteNumber(position.initialSl || position.sl, 0);

  if (entry <= 0 || initialSl <= 0 || initialSl >= entry) return 0;

  return (entry - initialSl) / entry;
}

function calcRewardPctFromPosition(position = {}) {
  const entry = finiteNumber(position.entry, 0);
  const tp = finiteNumber(position.tp, 0);

  if (entry <= 0 || tp <= entry) return 0;

  return (tp - entry) / entry;
}

function calcNetCostOutcome({
  position,
  exitPrice
} = {}) {
  const riskPct = calcRiskPctFromPosition(position);
  const grossMovePct = calcGrossMovePctFromPosition({
    position,
    exitPrice
  });

  const grossR = calcGrossRFromPosition({
    position,
    exitPrice
  });

  const entrySpreadPct = finiteNumber(
    position.spreadPct ??
      position.liveSpreadPct ??
      position.orderbookSpreadPct ??
      CONFIG.long?.cost?.fallbackSpreadPct ??
      CONFIG.cost?.fallbackSpreadPct,
    0
  );

  const exitSpreadPct = finiteNumber(
    position.exitSpreadPct ??
      position.spreadPct ??
      position.liveSpreadPct ??
      position.orderbookSpreadPct ??
      CONFIG.long?.cost?.fallbackSpreadPct ??
      CONFIG.cost?.fallbackSpreadPct,
    0
  );

  const cost = applyCosts({
    side: TARGET_TRADE_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    source: OUTCOME_SOURCE,
    grossMovePct,
    riskPct,
    entrySpreadPct,
    exitSpreadPct
  }) || {};

  const appliedGrossR = Number.isFinite(Number(cost.grossR))
    ? finiteNumber(cost.grossR, grossR)
    : grossR;

  const costR = Math.max(
    0,
    finiteNumber(
      cost.costR ??
        position.costR ??
        position.estimatedCostR ??
        position.avgCostR,
      0
    )
  );

  const netR = appliedGrossR - costR;

  return {
    cost,

    riskPct,
    rewardPct: calcRewardPctFromPosition(position),
    grossMovePct,

    grossR: appliedGrossR,
    costR,
    netR,

    feeR: Math.max(0, finiteNumber(cost.feeR, 0)),
    slippageR: Math.max(0, finiteNumber(cost.slippageR, 0)),
    marketImpactR: Math.max(0, finiteNumber(cost.marketImpactR, 0)),
    spreadCostR: Math.max(0, finiteNumber(cost.spreadCostR, 0)),

    feePct: finiteNumber(cost.feePct, 0),
    slippagePct: finiteNumber(cost.slippagePct, 0),
    costPct: finiteNumber(cost.costPct, 0),
    grossPnlPct: finiteNumber(cost.grossPnlPct, grossMovePct * 100),
    netPnlPct: finiteNumber(cost.netPnlPct, (grossMovePct - finiteNumber(cost.costRatio, 0)) * 100)
  };
}

function compactRawOutcome(outcome = {}) {
  return {
    tradeId: outcome.tradeId || null,
    symbol: outcome.symbol || null,
    baseSymbol: outcome.baseSymbol || outcome.symbol || null,
    contractSymbol: outcome.contractSymbol || null,
    status: 'CLOSED',
    exitReason: outcome.exitReason || outcome.reason || null,
    exitTrigger: outcome.exitTrigger || null,
    exitPrice: finiteNumber(outcome.exitPrice, 0),
    entry: finiteNumber(outcome.entry, 0),
    sl: finiteNumber(outcome.sl, 0),
    tp: finiteNumber(outcome.tp, 0),
    initialSl: finiteNumber(outcome.initialSl, 0),
    currentR: round4(outcome.currentR),
    mfeR: round4(outcome.mfeR),
    maeR: round4(outcome.maeR),
    grossR: round6(outcome.grossR ?? outcome.realizedGrossR),
    netR: round6(outcome.netR ?? outcome.r ?? outcome.realizedR),
    r: round6(outcome.r ?? outcome.netR ?? outcome.realizedR),
    realizedR: round6(outcome.realizedR ?? outcome.netR ?? outcome.r),
    costR: round6(outcome.costR),
    avgCostR: round6(outcome.avgCostR ?? outcome.costR),
    closedAt: finiteNumber(outcome.closedAt || outcome.completedAt, now()),
    completedAt: finiteNumber(outcome.completedAt || outcome.closedAt, now())
  };
}

function applyNetCostModelToOutcome({
  outcome,
  position,
  exitPrice
} = {}) {
  if (!outcome || typeof outcome !== 'object') return outcome;

  if (!isLongPosition(position)) {
    return {
      ...compactRawOutcome(outcome),
      skipped: true,
      reason: 'NON_LONG_OUTCOME_COST_MODEL_REJECTED',
      source: OUTCOME_SOURCE,
      longOnly: true,
      shortDisabled: true,
      shortOnly: false,
      longDisabled: false,
      realTrade: false,
      realOrdersDisabled: true,
      bitgetOrdersDisabled: true
    };
  }

  const net = calcNetCostOutcome({
    position,
    exitPrice
  });

  return forceLongPositionFields({
    ...compactRawOutcome(outcome),

    source: OUTCOME_SOURCE,
    outcomeSource: OUTCOME_SOURCE,
    positionSource: position.source || POSITION_SOURCE,

    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: false,

    realTrade: false,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    riskPct: round6(net.riskPct),
    rewardPct: round6(net.rewardPct),
    grossMovePct: round6(net.grossMovePct),

    grossR: round6(net.grossR),
    rawR: round6(net.grossR),
    realizedGrossR: round6(net.grossR),

    costR: round6(net.costR),
    avgCostR: round6(net.costR),
    totalCostR: round6(net.costR),
    feeR: round6(net.feeR),
    slippageR: round6(net.slippageR),
    marketImpactR: round6(net.marketImpactR),
    spreadCostR: round6(net.spreadCostR),

    feePct: round6(net.feePct),
    slippagePct: round6(net.slippagePct),
    costPct: round6(net.costPct),
    grossPnlPct: round6(net.grossPnlPct),
    netPnlPct: round6(net.netPnlPct),
    pnlPct: round6(net.netPnlPct),

    netR: round6(net.netR),
    exitR: round6(net.netR),
    realizedNetR: round6(net.netR),
    realizedR: round6(net.netR),
    r: round6(net.netR),

    win: net.netR > 0,
    loss: net.netR < 0,
    flat: net.netR === 0,
    isWin: net.netR > 0,

    costModelApplied: true,
    netCostModelApplied: true,
    costModel: COST_MODEL_VERSION,
    costModelVersion: COST_MODEL_VERSION,

    measurementFixVersion: MEASUREMENT_FIX_VERSION,

    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true
  });
}

function fallbackOutcomeFromPosition({
  position,
  exitPrice,
  exitReason,
  timestamp
} = {}) {
  return {
    tradeId: position.tradeId || null,
    symbol: position.symbol || null,
    baseSymbol: position.baseSymbol || position.symbol || null,
    contractSymbol: position.contractSymbol || null,
    status: 'CLOSED',
    exitReason,
    reason: exitReason,
    exitPrice,
    entry: position.entry,
    sl: position.sl,
    tp: position.tp,
    initialSl: position.initialSl || position.sl,
    currentR: position.currentR || 0,
    mfeR: position.mfeR || 0,
    maeR: position.maeR || 0,
    closedAt: timestamp,
    completedAt: timestamp,
    source: OUTCOME_SOURCE,
    outcomeSource: OUTCOME_SOURCE
  };
}

function isDirectSLExit({
  position,
  exitReason
} = {}) {
  const reason = upper(exitReason);

  const stoppedOut =
    reason === 'SL' ||
    reason === 'HIT_SL' ||
    reason === 'STOP' ||
    reason === 'STOP_LOSS' ||
    reason === 'STOPLOSS' ||
    reason === 'HARD_SL' ||
    reason === 'DIRECT_SL';

  if (!stoppedOut) return false;

  if (
    Boolean(position.nearTpSeen) ||
    Boolean(position.reachedHalfR) ||
    Boolean(position.reachedOneR)
  ) {
    return false;
  }

  const mfeR = finiteNumber(position.mfeR, 0);
  const maeR = finiteNumber(position.maeR, 0);

  return Boolean(position.directToSL || position.directSL) ||
    mfeR < 0.25 ||
    maeR <= -0.8;
}

function enrichOutcomeIdentity(outcome = {}, position = {}) {
  const identity = normalizeMicroIdentity(position);

  const openedAt = finiteNumber(position.openedAt || position.createdAt, 0);
  const closedAt = finiteNumber(outcome.closedAt || outcome.completedAt, now());
  const ageSec = openedAt > 0 && closedAt > 0
    ? Math.max(0, Math.floor((closedAt - openedAt) / 1000))
    : 0;

  const exitReason = upper(outcome.exitReason || outcome.reason);
  const directSL = isDirectSLExit({
    position,
    exitReason
  });

  const outcomeIdentity = [
    TARGET_TRADE_SIDE,
    position.tradeId || outcome.tradeId || '',
    position.symbol || position.contractSymbol || outcome.symbol || '',
    openedAt || '',
    closedAt || '',
    exitReason || '',
    finiteNumber(outcome.exitPrice || outcome.exit, 0),
    identity.microFamilyId
  ].join('|');

  return forceLongPositionFields({
    ...compactRawOutcome(outcome),
    ...identity,

    source: OUTCOME_SOURCE,
    outcomeSource: OUTCOME_SOURCE,
    positionSource: position.source || POSITION_SOURCE,

    tradeId: position.tradeId || outcome.tradeId || null,
    outcomeId: outcome.outcomeId || `outcome_${randomId('long')}`,
    outcomeIdentity,
    outcomeIdentityHashSource: 'TRADE_ID_SYMBOL_OPEN_CLOSE_REASON_EXIT_TRUE_MICRO',

    activeRotationId: position.activeRotationId || null,
    selectedRotationId: position.selectedRotationId || position.activeRotationId || null,

    activeMacroFamilyId:
      position.activeMacroFamilyId ||
      identity.parentTrueMicroFamilyId ||
      null,

    selectedMacroFamilyId:
      position.selectedMacroFamilyId ||
      position.activeMacroFamilyId ||
      identity.parentTrueMicroFamilyId ||
      null,

    selectedMicroFamilyAlert: Boolean(position.selectedMicroFamilyAlert),
    discordAlertEligible: Boolean(position.discordAlertEligible),
    selectedForDiscord: Boolean(position.selectedForDiscord || position.discordAlertEligible || position.selectedMicroFamilyAlert),
    rotationMatchType: position.rotationMatchType || outcome.rotationMatchType || null,

    weeklyStats: compactStats(position.weeklyStats || position.selectedWeeklyStats),
    selectedWeeklyStats: compactStats(position.selectedWeeklyStats || position.weeklyStats),

    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: false,

    realTrade: false,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    scannerMicroFamilyId: position.scannerMicroFamilyId || identity.scannerMicroFamilyId || null,
    scannerFamilyId: position.scannerFamilyId || identity.scannerFamilyId || null,
    scannerDefinition: position.scannerDefinition || identity.scannerDefinition || null,
    scannerDefinitionParts: Array.isArray(position.scannerDefinitionParts)
      ? position.scannerDefinitionParts.slice(0, 12)
      : identity.scannerDefinitionParts || [],

    executionMicroFamilyId: position.executionMicroFamilyId || identity.executionMicroFamilyId || null,
    executionFingerprintRole: 'METADATA_ONLY',
    executionFingerprintOnlyMetadata: Boolean(position.executionMicroFamilyId || identity.executionMicroFamilyId),
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintOnlyMetadata: Boolean(position.scannerMicroFamilyId || identity.scannerMicroFamilyId),
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    outcomeIdentityLocked: true,
    outcomeIdentitySource: 'POSITION_TRUE_MICRO_IDENTITY',
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    exactTrueMicroFamilyRequired: true,
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    isTrueMicro: true,
    trueMicro: true,
    isLegacyMacro: false,
    trueMicroOnly: true,
    exactTrueMicroOnly: true,

    currentPrice: roundPrice(position.currentPrice ?? position.lastPrice ?? outcome.exitPrice),
    lastPrice: roundPrice(position.lastPrice ?? position.currentPrice ?? outcome.exitPrice),
    entry: roundPrice(position.entry ?? outcome.entry),
    sl: roundPrice(position.sl ?? outcome.sl),
    tp: roundPrice(position.tp ?? outcome.tp),
    initialSl: roundPrice(position.initialSl ?? outcome.initialSl ?? position.sl),

    ageSec,
    currentR: round4(position.currentR ?? outcome.currentR),
    mfeR: round4(position.mfeR ?? outcome.mfeR),
    maeR: round4(position.maeR ?? outcome.maeR),

    reachedHalfR: Boolean(position.reachedHalfR || outcome.reachedHalfR),
    reachedOneR: Boolean(position.reachedOneR || outcome.reachedOneR),
    nearTpSeen: Boolean(position.nearTpSeen || outcome.nearTpSeen),

    directToSL: directSL,
    directSL,

    tpExitTriggered: exitReason === 'TP',
    slExitTriggered: exitReason === 'SL',
    timeStopExitTriggered: exitReason === 'TIME_STOP',

    exitRuleMatched:
      exitReason === 'TP'
        ? 'price >= tp'
        : exitReason === 'SL'
          ? 'price <= sl'
          : exitReason === 'TIME_STOP'
            ? 'TIME_STOP'
            : null,

    validLongRiskShape: validLongRiskGeometry(position),
    longRiskFormula: 'sl < entry < tp',
    longGrossRFormula: '(exitPrice - entry) / (entry - initialSl)',

    entryMarketWeather: compactMarketWeather(position.entryMarketWeather || outcome.entryMarketWeather),
    entryCurrentRegime: position.entryCurrentRegime || position.currentRegime || outcome.entryCurrentRegime || outcome.currentRegime || null,
    entryCurrentTrendSide: position.entryCurrentTrendSide || position.currentTrendSide || outcome.entryCurrentTrendSide || outcome.currentTrendSide || null,
    entryCurrentFit: position.entryCurrentFit ?? position.currentFit ?? outcome.entryCurrentFit ?? outcome.currentFit ?? null,
    entryCurrentFitConfidence: position.entryCurrentFitConfidence ?? position.currentFitConfidence ?? outcome.entryCurrentFitConfidence ?? outcome.currentFitConfidence ?? null,
    entryWeatherFitMatchedFamily: position.entryWeatherFitMatchedFamily ?? outcome.entryWeatherFitMatchedFamily ?? null,

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    learningRemainsBroad: true,

    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    directSLDefinition: 'SL_EXIT_WITHOUT_MEANINGFUL_MFE',
    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true
  });
}

function maybeSendExitAlert(position, outcome) {
  if (!position.discordAlertEligible && !position.selectedMicroFamilyAlert && !position.selectedForDiscord) {
    return {
      sent: false,
      skipped: true,
      queued: false,
      reason: 'POSITION_NOT_SELECTED_FOR_DISCORD_EXIT_ALERT'
    };
  }

  if (!isExactLongChildTrueMicroId(outcome.trueMicroFamilyId)) {
    return {
      sent: false,
      skipped: true,
      queued: false,
      reason: 'EXIT_ALERT_REQUIRES_EXACT_75_CHILD_TRUE_MICRO_FAMILY'
    };
  }

  Promise.resolve(sendExitAlert(outcome)).catch(() => null);

  return {
    sent: false,
    skipped: false,
    queued: true,
    fireAndForget: true,
    reason: 'DISCORD_EXIT_ALERT_QUEUED_FIRE_AND_FORGET'
  };
}

async function fetchPriceSafely({
  priceFetcher,
  symbol,
  timeoutMs
}) {
  if (typeof priceFetcher !== 'function') return 0;

  const result = await withTimeout(
    Promise.resolve(priceFetcher(symbol)).catch(() => 0),
    timeoutMs,
    0
  );

  return finiteNumber(result, 0);
}

async function monitorOnePosition({
  position,
  priceFetcher,
  timestamp,
  options = {}
}) {
  const cfg = tradeConfig();

  if (!isLongPosition(position)) {
    return {
      type: 'IGNORED_NON_LONG',
      position,
      outcome: null
    };
  }

  if (isScannerFamilyRow(position)) {
    return {
      type: 'IGNORED_SCANNER_FINGERPRINT_POSITION',
      position,
      outcome: null
    };
  }

  if (!isExactLongChildTrueMicroId(rowMicroId(position))) {
    return {
      type: 'IGNORED_NON_EXACT_75_CHILD_POSITION',
      position,
      outcome: null
    };
  }

  const fetchSymbol = position.contractSymbol || position.symbol;
  const price = await fetchPriceSafely({
    priceFetcher,
    symbol: fetchSymbol,
    timeoutMs: options.monitorPriceFetchTimeoutMs ?? cfg.monitorPriceFetchTimeoutMs
  });

  if (price > 0) {
    position.priceFetchFailures = 0;
    position.lastPriceFetchFailedAt = null;
    updatePathMetrics(position, price);
  } else {
    await markPriceFetchFailed(position, {
      persist: Boolean(options.persistPriceFetchFailures ?? cfg.persistPriceFetchFailures)
    });
  }

  const exit = detectExit({
    position,
    price,
    timestamp
  });

  if (!exit.shouldExit) {
    if (price > 0 && Boolean(options.persistMonitorUpdates ?? cfg.persistMonitorUpdates)) {
      await saveOpenPosition(position).catch(() => null);
    }

    return {
      type: price > 0 ? 'UPDATED' : 'NO_PRICE',
      position,
      outcome: null
    };
  }

  const closedAt = timestamp;
  const exitPrice = roundPrice(exit.exitPrice || price || fallbackExitPrice(position));
  const directSL = isDirectSLExit({
    position,
    exitReason: exit.reason
  });

  const closedPosition = forceLongPositionFields({
    ...position,
    status: 'CLOSED',
    closedAt,
    completedAt: closedAt,
    exitPrice,
    exitReason: exit.reason,
    exitTrigger: exit.trigger,
    priceUnavailableTimeStop: Boolean(exit.priceUnavailableTimeStop),
    outcomeSource: OUTCOME_SOURCE,
    source: POSITION_SOURCE,
    directToSL: directSL,
    directSL
  });

  let baseOutcome;

  try {
    baseOutcome = buildOutcomeFromPosition({
      position: closedPosition,
      exitPrice,
      exitReason: exit.reason,
      source: OUTCOME_SOURCE
    });
  } catch {
    baseOutcome = fallbackOutcomeFromPosition({
      position: closedPosition,
      exitPrice,
      exitReason: exit.reason,
      timestamp: closedAt
    });
  }

  const netOutcome = applyNetCostModelToOutcome({
    outcome: {
      ...compactRawOutcome(baseOutcome),
      status: 'CLOSED',
      closedAt,
      completedAt: closedAt,
      exitPrice,
      exitReason: exit.reason,
      exitTrigger: exit.trigger,
      source: OUTCOME_SOURCE,
      outcomeSource: OUTCOME_SOURCE,
      directToSL: directSL,
      directSL
    },
    position: closedPosition,
    exitPrice
  });

  const outcome = enrichOutcomeIdentity(netOutcome, closedPosition);

  let recordOutcomeResult = {
    ok: true
  };

  try {
    await recordOutcome(clonePlainObject(outcome), {
      source: OUTCOME_SOURCE,
      weekKey: PERSISTENT_LEARNING_KEY,
      persistentLearningKey: PERSISTENT_LEARNING_KEY,
      targetTradeSide: TARGET_TRADE_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      side: TARGET_DASHBOARD_SIDE,
      namespace: LONG_NAMESPACE,
      keyPrefix: LONG_KEY_PREFIX,
      virtualOnly: true,
      realOrdersDisabled: true,
      bitgetOrdersDisabled: true,
      exchangeCallsDisabled: true
    });
  } catch (error) {
    recordOutcomeResult = {
      ok: false,
      error: error?.message || String(error),
      reason: String(error?.message || error || '').includes('max request size')
        ? 'RECORD_OUTCOME_PAYLOAD_TOO_LARGE_SKIPPED_DELETE_POSITION'
        : 'RECORD_OUTCOME_FAILED_SKIPPED_DELETE_POSITION'
    };
  }

  const discordResult = maybeSendExitAlert(
    closedPosition,
    clonePlainObject(outcome)
  );

  await deleteOpenPosition(closedPosition.symbol || closedPosition.contractSymbol);

  return {
    type: 'EXIT',
    position: closedPosition,
    outcome: {
      ...outcome,
      recordOutcomeResult,
      recordOutcomeOk: recordOutcomeResult.ok,
      discordExitAlertResult: discordResult,
      discordExitAlertQueued: Boolean(discordResult.queued),
      discordExitAlertSent: Boolean(discordResult.sent)
    }
  };
}

export async function monitorOpenPositions(options = {}) {
  const cfg = tradeConfig();
  const startedAt = now();
  const timestamp = now();

  const positions = await getOpenPositions({
    limit: options.limit ?? options.monitorLimit ?? cfg.monitorLimit
  }).catch(() => []);

  if (!positions.length) return [];

  const deadline = startedAt + positiveInt(
    options.maxRuntimeMs ?? options.monitorMaxRuntimeMs ?? cfg.monitorMaxRuntimeMs,
    cfg.monitorMaxRuntimeMs,
    500,
    20_000
  );

  const limited = positions.slice(0, positiveInt(
    options.limit ?? options.monitorLimit ?? cfg.monitorLimit,
    cfg.monitorLimit,
    1,
    200
  ));

  const results = await mapConcurrent(
    limited,
    positiveInt(options.dataConcurrency ?? cfg.dataConcurrency, cfg.dataConcurrency, 1, 12),
    async (position) => {
      if (now() >= deadline) {
        return {
          type: 'MONITOR_TIME_BUDGET_EXCEEDED',
          position,
          outcome: null
        };
      }

      return monitorOnePosition({
        position,
        priceFetcher: typeof options.priceFetcher === 'function'
          ? options.priceFetcher
          : null,
        timestamp,
        options
      }).catch((error) => ({
        type: 'MONITOR_POSITION_ERROR',
        position,
        outcome: null,
        error: error?.message || String(error)
      }));
    }
  );

  return results
    .filter((row) => row?.type === 'EXIT' && row.outcome)
    .map((row) => row.outcome);
}