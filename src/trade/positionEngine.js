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
const OPPOSITE_TRADE_SIDE = 'SHORT';

const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;

const POSITION_SOURCE = 'VIRTUAL';
const OUTCOME_SOURCE = 'VIRTUAL';

const COST_MODEL_VERSION = 'POSITION_ENGINE_LONG_NET_COST_V4';

const DEFAULT_POSITION_TIME_STOP_MIN = 720;

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

function namespacedLongKey(key, fallback) {
  const raw = String(key || fallback || '').trim();

  if (!raw) return `${LONG_KEY_PREFIX}MISSING_KEY`;
  if (raw.startsWith(LONG_KEY_PREFIX)) return raw;

  return `${LONG_KEY_PREFIX}${raw}`;
}

function resolveOpenPatternKey() {
  const configured =
    KEYS.long?.trade?.openPattern ||
    KEYS.trade?.longOpenPattern ||
    KEYS.trade?.openPattern;

  return namespacedLongKey(configured, 'TRADE:OPEN:*');
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
    open: resolveOpenKey
  }
};

function tradeConfig() {
  return {
    dataConcurrency: Math.max(
      1,
      Math.floor(safeNumber(CONFIG.trade?.dataConcurrency, 5))
    ),

    positionTimeStopMin: safeNumber(
      CONFIG.trade?.positionTimeStopMin,
      DEFAULT_POSITION_TIME_STOP_MIN
    )
  };
}

function manageConfig() {
  return {
    applyLive: CONFIG.manage?.applyLive === true,
    beArmR: safeNumber(CONFIG.manage?.beArmR, 0.70),
    beLockR: safeNumber(CONFIG.manage?.beLockR, 0.05),
    trailArmR: safeNumber(CONFIG.manage?.trailArmR, 1.00),
    trailLockR: safeNumber(CONFIG.manage?.trailLockR, 0.35)
  };
}

function schemaConfig() {
  const macroSchema = String(
    CONFIG.analyze?.macroSchema ||
    CONFIG.analyze?.legacySchema ||
    'MF_V1'
  ).toUpperCase();

  const microSchema = String(
    CONFIG.analyze?.microSchema ||
    'MF_V2'
  ).toUpperCase();

  const currentSchema = String(
    CONFIG.analyze?.schema ||
    microSchema
  ).toUpperCase();

  return {
    currentSchema,
    macroSchema,
    microSchema
  };
}

function round4(value) {
  return Number(safeNumber(value, 0).toFixed(4));
}

function round6(value) {
  return Number(safeNumber(value, 0).toFixed(6));
}

function roundPrice(value) {
  const n = safeNumber(value, 0);

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

function storageSymbol(input) {
  const raw = typeof input === 'object'
    ? input?.symbol || input?.baseSymbol || input?.contractSymbol
    : input;

  const base = normalizeBaseSymbol(raw);

  return base || String(raw || '').toUpperCase().trim();
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

function stripSymbolTokensFromLearningId(id = '', row = {}) {
  const raw = String(id || '').trim();

  if (!raw) return raw;

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
    .replaceAll('SHORT_DISABLED', '')
    .replaceAll('SHORTDISABLED', '')
    .replaceAll('BLOCK_SHORT', '')
    .replaceAll('SHORT_ENABLED_FALSE', '')
    .replaceAll('SHORT_ONLY_FALSE', '')
    .replaceAll('LONG_DISABLED_FALSE', '')
    .replaceAll('LONG_ONLY_MODE', 'LONG')
    .replaceAll('LONG_ONLY', 'LONG')
    .replaceAll('LONG-ONLY', 'LONG');
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

  if (longHit) return TARGET_TRADE_SIDE;
  if (shortHit) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function normalizedTextParts(row = {}) {
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
    .map((value) => String(value || '').toUpperCase())
    .filter(Boolean);
}

function idText(row = {}) {
  return [
    row.familyId,
    row.family,
    row.baseFamilyId,

    row.trueMicroFamilyId,
    row.microFamilyId,
    row.coarseMicroFamilyId,
    row.baseMicroFamilyId,
    row.legacyMicroFamilyId,

    row.scannerMicroFamilyId,
    row.scannerFamilyId,

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
    haystack.includes('DIRECTION=BUY')
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
    haystack.includes('DIRECTION=SELL')
  );
}

function inferTradeSideFromIds(row = {}) {
  const haystack = idText(row);

  if (!haystack) return 'UNKNOWN';

  if (hasLongIdSignal(haystack) && !hasShortIdSignal(haystack)) return TARGET_TRADE_SIDE;
  if (hasShortIdSignal(haystack) && !hasLongIdSignal(haystack)) return OPPOSITE_TRADE_SIDE;

  if (longIdHasPriority(haystack)) return TARGET_TRADE_SIDE;
  if (shortIdHasPriority(haystack)) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function longIdHasPriority(text = '') {
  const raw = String(text || '').toUpperCase();

  return (
    raw.includes('TRADE_SIDE=LONG') ||
    raw.includes('TRADESIDE=LONG') ||
    raw.includes('MICRO_LONG_') ||
    raw.includes('|LONG_') ||
    raw.startsWith('LONG_')
  );
}

function shortIdHasPriority(text = '') {
  const raw = String(text || '').toUpperCase();

  return (
    raw.includes('TRADE_SIDE=SHORT') ||
    raw.includes('TRADESIDE=SHORT') ||
    raw.includes('MICRO_SHORT_') ||
    raw.includes('|SHORT_') ||
    raw.startsWith('SHORT_')
  );
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

  if (row.longOnly === true && row.shortDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  if (row.shortOnly === true || row.longDisabled === true) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function isLongPosition(row = {}) {
  return inferPositionTradeSide(row) === TARGET_TRADE_SIDE;
}

function isScannerFamilyId(id = '') {
  const value = String(id || '').toUpperCase();

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

function isScannerFamilyRow(row = {}) {
  return Boolean(
    isScannerFamilyId(row.microFamilyId) ||
    isScannerFamilyId(row.trueMicroFamilyId) ||
    isScannerFamilyId(row.coarseMicroFamilyId) ||
    isScannerFamilyId(row.id) ||
    isScannerFamilyId(row.key)
  );
}

function idHasSchema(id, schema) {
  const value = String(id || '').toUpperCase();
  const target = String(schema || '').toUpperCase();

  if (!value || !target) return false;

  return (
    value.includes(`_${target}_`) ||
    value.endsWith(`_${target}`) ||
    value.includes(`|SCHEMA=${target}`) ||
    value.includes(`SCHEMA=${target}`)
  );
}

function definitionHasSchema(row = {}, schema) {
  const target = String(schema || '').toUpperCase();

  if (!target) return false;

  const parts = [
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : [])
  ];

  if (parts.some((part) => String(part).toUpperCase() === `SCHEMA=${target}`)) {
    return true;
  }

  return String(row.definition || row.microDefinition || '').toUpperCase().includes(`SCHEMA=${target}`);
}

function rowSchema(row = {}) {
  return String(
    row.microFamilySchema ||
    row.schema ||
    row.versionSchema ||
    ''
  ).toUpperCase();
}

function rowMicroId(row = {}) {
  const raw = String(
    row.trueMicroFamilyId ||
    row.microFamilyId ||
    row.analyzeMicroFamilyId ||
    ''
  ).trim();

  if (!raw || isScannerFamilyId(raw)) return '';

  return stripSymbolTokensFromLearningId(raw, row);
}

function rowCoarseMicroId(row = {}) {
  const raw = String(
    row.coarseMicroFamilyId ||
    row.baseMicroFamilyId ||
    row.legacyMicroFamilyId ||
    row.trueMicroFamilyId ||
    row.microFamilyId ||
    row.analyzeMicroFamilyId ||
    ''
  ).trim();

  if (!raw || isScannerFamilyId(raw)) return '';

  return stripSymbolTokensFromLearningId(raw, row);
}

function scannerMicroId(row = {}) {
  const candidates = [
    row.scannerMicroFamilyId,
    isScannerFamilyId(row.microFamilyId) ? row.microFamilyId : null,
    isScannerFamilyId(row.trueMicroFamilyId) ? row.trueMicroFamilyId : null,
    isScannerFamilyId(row.id) ? row.id : null,
    isScannerFamilyId(row.key) ? row.key : null
  ];

  return candidates.find(Boolean) || null;
}

function parentMacroFamilyId(row = {}) {
  return String(
    row.parentMacroFamilyId ||
    row.parentMicroFamilyId ||
    row.macroFamilyId ||
    row.familyMacroId ||
    ''
  ).trim();
}

function fallbackFamilyId(row = {}) {
  return String(
    row.familyId ||
    row.family ||
    row.baseFamilyId ||
    parentMacroFamilyId(row) ||
    rowMicroId(row) ||
    ''
  ).trim();
}

function isTrueMicroFamilyRow(row = {}) {
  const { microSchema, macroSchema } = schemaConfig();

  const id = rowMicroId(row);
  const schema = rowSchema(row);
  const version = String(row.version || '').toUpperCase();

  if (!row || !id) return false;
  if (isScannerFamilyRow(row)) return false;
  if (!isLongPosition(row) && !hasLongIdSignal(id)) return false;

  if (row.isLegacyMacro === true) return false;
  if (version.includes('MACRO')) return false;

  if (row.isTrueMicro === true || row.trueMicro === true) return true;

  if (schema === microSchema) return true;
  if (idHasSchema(id, microSchema)) return true;
  if (definitionHasSchema(row, microSchema)) return true;

  if (schema === macroSchema) return false;
  if (idHasSchema(id, macroSchema)) return false;
  if (definitionHasSchema(row, macroSchema)) return false;

  return Boolean(parentMacroFamilyId(row) || row.coarseMicroFamilyId || row.trueMicroFamilyId);
}

function normalizeMicroIdentity(row = {}) {
  const { currentSchema, microSchema } = schemaConfig();

  const microFamilyId = rowMicroId(row);
  const coarseMicroFamilyId = rowCoarseMicroId(row);
  const macroId = parentMacroFamilyId(row);

  if (!microFamilyId) {
    throw new Error('ANALYZE_TRUE_MICRO_FAMILY_ID_REQUIRED');
  }

  if (isScannerFamilyId(microFamilyId)) {
    throw new Error('SCANNER_FINGERPRINT_CANNOT_BE_LEARNING_FAMILY_ID');
  }

  const trueMicro = true;

  return {
    microFamilyId,
    trueMicroFamilyId: microFamilyId,

    coarseMicroFamilyId: coarseMicroFamilyId || microFamilyId,
    baseMicroFamilyId: row.baseMicroFamilyId && !isScannerFamilyId(row.baseMicroFamilyId)
      ? stripSymbolTokensFromLearningId(row.baseMicroFamilyId, row)
      : coarseMicroFamilyId || microFamilyId,
    legacyMicroFamilyId: row.legacyMicroFamilyId && !isScannerFamilyId(row.legacyMicroFamilyId)
      ? stripSymbolTokensFromLearningId(row.legacyMicroFamilyId, row)
      : coarseMicroFamilyId || microFamilyId,

    familyId: fallbackFamilyId(row) || microFamilyId || null,

    scannerMicroFamilyId: scannerMicroId(row),
    scannerFamilyId: row.scannerFamilyId || null,
    scannerDefinition: row.scannerDefinition || null,
    scannerDefinitionParts: Array.isArray(row.scannerDefinitionParts)
      ? row.scannerDefinitionParts
      : [],

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintOnlyMetadata: true,
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    learningIdentitySource: 'ANALYZE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,

    parentMacroFamilyId: macroId || null,
    parentMicroFamilyId: row.parentMicroFamilyId || macroId || null,
    macroFamilyId: macroId || null,

    microFamilySchema: row.microFamilySchema || row.schema || microSchema,
    schema: row.schema || row.microFamilySchema || microSchema,
    analyzeSchema: row.analyzeSchema || currentSchema,

    isTrueMicro: trueMicro,
    isLegacyMacro: false,

    trueMicroOnly: true
  };
}

function assertLongRiskGeometry(row = {}) {
  const entryPrice = safeNumber(row.entry, 0);
  const sl = safeNumber(row.sl, 0);
  const tp = safeNumber(row.tp, 0);

  if (!(entryPrice > 0 && sl < entryPrice && tp > entryPrice)) {
    throw new Error('OPEN_POSITION_LONG_RISK_GEOMETRY_INVALID');
  }
}

function assertLearningFamilyIdentity(row = {}) {
  const microFamilyId = rowMicroId(row);

  if (!microFamilyId) {
    throw new Error('OPEN_POSITION_TRUE_MICRO_FAMILY_ID_MISSING');
  }

  if (isScannerFamilyId(microFamilyId) || isScannerFamilyRow(row)) {
    throw new Error('OPEN_POSITION_SCANNER_FINGERPRINT_METADATA_ONLY');
  }

  if (!row.familyId) {
    throw new Error('OPEN_POSITION_FAMILY_ID_MISSING');
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

function calcStopFromR({
  entry,
  initialSl,
  stopR
} = {}) {
  const e = safeNumber(entry, 0);
  const sl = safeNumber(initialSl, 0);
  const r = safeNumber(stopR, 0);

  if (e <= 0 || sl <= 0) return 0;

  const riskDist = Math.abs(e - sl);

  if (riskDist <= 0) return 0;

  return e + riskDist * r;
}

function shouldTightenStop({
  currentSl,
  nextSl
} = {}) {
  const current = safeNumber(currentSl, 0);
  const next = safeNumber(nextSl, 0);

  if (current <= 0 || next <= 0) return false;

  return next > current;
}

function applyLiveStopManagement(position) {
  const cfg = manageConfig();

  if (!cfg.applyLive) return position;
  if (!isLongPosition(position)) return position;

  const entry = safeNumber(position.entry, 0);
  const initialSl = safeNumber(position.initialSl || position.sl, 0);
  const currentSl = safeNumber(position.sl, 0);
  const currentR = safeNumber(position.currentR, 0);

  if (entry <= 0 || initialSl <= 0 || currentSl <= 0) return position;

  let nextStopR = null;
  let source = null;

  if (currentR >= cfg.beArmR) {
    nextStopR = cfg.beLockR;
    source = 'BE';
  }

  if (currentR >= cfg.trailArmR) {
    nextStopR = Math.max(
      safeNumber(nextStopR, cfg.beLockR),
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

  if (source === 'BE') {
    position.beLiveApplied = true;
  }

  if (source === 'TRAIL') {
    position.trailLiveApplied = true;
  }

  return position;
}

function detectExit({
  position,
  price,
  timestamp
} = {}) {
  const cfg = tradeConfig();

  const current = safeNumber(price, 0);
  const tp = safeNumber(position.tp, 0);
  const sl = safeNumber(position.sl, 0);
  const openedAt = safeNumber(position.openedAt || position.createdAt, 0);

  if (current <= 0 || tp <= 0 || sl <= 0) {
    return {
      shouldExit: false,
      reason: null
    };
  }

  if (!isLongPosition(position)) {
    return {
      shouldExit: false,
      reason: 'NON_LONG_POSITION_IGNORED'
    };
  }

  if (current >= tp) {
    return {
      shouldExit: true,
      reason: 'TP'
    };
  }

  if (current <= sl) {
    const source = String(position.slManagementSource || '').toUpperCase();

    if (source === 'TRAIL') {
      return {
        shouldExit: true,
        reason: 'TRAIL_SL'
      };
    }

    if (source === 'BE') {
      return {
        shouldExit: true,
        reason: 'BE_SL'
      };
    }

    return {
      shouldExit: true,
      reason: 'SL'
    };
  }

  const expired =
    openedAt > 0 &&
    timestamp - openedAt >= cfg.positionTimeStopMin * 60 * 1000;

  if (expired) {
    return {
      shouldExit: true,
      reason: 'TIME_STOP'
    };
  }

  return {
    shouldExit: false,
    reason: null
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
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    noRealOrders: true,
    noExchangeOrders: true
  };
}

function buildVirtualFlags(row = {}) {
  return {
    source: POSITION_SOURCE,
    outcomeSource: OUTCOME_SOURCE,

    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: false,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrderPlaced: false,

    liveEligible: false,
    discordAlertEligible: Boolean(row.discordAlertEligible),
    selectedMicroFamilyAlert: Boolean(row.selectedMicroFamilyAlert)
  };
}

function calcGrossMovePctFromPosition({
  position,
  exitPrice
} = {}) {
  const entry = safeNumber(position.entry, 0);
  const exit = safeNumber(exitPrice, 0);

  if (entry <= 0 || exit <= 0) return 0;

  return (exit - entry) / entry;
}

function calcGrossRFromPosition({
  position,
  exitPrice
} = {}) {
  const entry = safeNumber(position.entry, 0);
  const initialSl = safeNumber(position.initialSl || position.sl, 0);
  const exit = safeNumber(exitPrice, 0);

  if (entry <= 0 || initialSl <= 0 || exit <= 0) return 0;

  const riskDistance = entry - initialSl;

  if (riskDistance <= 0) return 0;

  return (exit - entry) / riskDistance;
}

function calcRiskPctFromPosition(position = {}) {
  const entry = safeNumber(position.entry, 0);
  const initialSl = safeNumber(position.initialSl || position.sl, 0);

  if (entry <= 0 || initialSl <= 0) return 0;

  return Math.abs(entry - initialSl) / entry;
}

function positiveCostR(value) {
  const n = safeNumber(value, NaN);

  if (!Number.isFinite(n)) return null;

  return Math.max(0, n);
}

function ratioToR(value, riskPct) {
  const ratio = safeNumber(value, NaN);
  const risk = safeNumber(riskPct, 0);

  if (!Number.isFinite(ratio) || risk <= 0) return null;

  return Math.max(0, ratio / risk);
}

function firstPositiveCostR(values = []) {
  for (const value of values) {
    const n = positiveCostR(value);

    if (n !== null) return n;
  }

  return 0;
}

function firstRatioCostR(values = [], riskPct = 0) {
  for (const value of values) {
    const n = ratioToR(value, riskPct);

    if (n !== null) return n;
  }

  return 0;
}

function calcRoundTripCostBreakdownR({
  position,
  exitPrice
} = {}) {
  const riskPct = calcRiskPctFromPosition(position);

  if (riskPct <= 0) {
    return {
      costR: 0,
      feeR: 0,
      slippageR: 0,
      marketImpactR: 0,
      spreadCostR: 0
    };
  }

  const grossMovePct = calcGrossMovePctFromPosition({
    position,
    exitPrice
  });

  const grossR = calcGrossRFromPosition({
    position,
    exitPrice
  });

  const entrySpreadPct = safeNumber(
    position.spreadPct ??
    position.liveSpreadPct ??
    position.orderbookSpreadPct ??
    CONFIG.cost?.fallbackSpreadPct,
    0
  );

  const exitSpreadPct = safeNumber(
    position.exitSpreadPct ??
    position.spreadPct ??
    position.liveSpreadPct ??
    position.orderbookSpreadPct ??
    CONFIG.cost?.fallbackSpreadPct,
    0
  );

  const cost = applyCosts({
    side: TARGET_TRADE_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    source: OUTCOME_SOURCE,
    outcomeSource: OUTCOME_SOURCE,

    entry: safeNumber(position.entry, 0),
    entryPrice: safeNumber(position.entry, 0),
    exitPrice: safeNumber(exitPrice, 0),
    price: safeNumber(exitPrice, 0),

    grossMovePct,
    grossR,
    rawR: grossR,
    realizedGrossR: grossR,

    riskPct,

    spreadPct: entrySpreadPct,
    entrySpreadPct,
    exitSpreadPct,

    virtualOnly: true,
    virtualTracked: true,
    realTrade: false
  }) || {};

  const feeR = firstPositiveCostR([
    cost.feeR,
    cost.feesR,
    cost.totalFeeR
  ]) || firstRatioCostR([
    cost.feeRatio,
    cost.feesRatio,
    cost.totalFeeRatio,
    cost.feePct,
    cost.feesPct
  ], riskPct);

  const slippageR = firstPositiveCostR([
    cost.slippageR,
    cost.totalSlippageR
  ]) || firstRatioCostR([
    cost.slippageRatio,
    cost.totalSlippageRatio,
    cost.slippagePct
  ], riskPct);

  const marketImpactR = firstPositiveCostR([
    cost.marketImpactR,
    cost.impactR
  ]) || firstRatioCostR([
    cost.marketImpactRatio,
    cost.impactRatio,
    cost.marketImpactPct
  ], riskPct);

  const spreadCostR = firstPositiveCostR([
    cost.spreadCostR,
    cost.spreadR
  ]) || firstRatioCostR([
    cost.spreadCostRatio,
    cost.spreadRatio,
    cost.spreadPct
  ], riskPct);

  const explicitCostR = firstPositiveCostR([
    cost.costR,
    cost.totalCostR,
    cost.roundTripCostR
  ]);

  const ratioCostR = firstRatioCostR([
    cost.costRatio,
    cost.totalCostRatio,
    cost.costPct,
    cost.totalCostPct
  ], riskPct);

  const summedCostR = feeR + slippageR + marketImpactR + spreadCostR;

  const costR = explicitCostR || ratioCostR || summedCostR;

  return {
    costR: round6(costR),
    feeR: round6(feeR),
    slippageR: round6(slippageR),
    marketImpactR: round6(marketImpactR),
    spreadCostR: round6(spreadCostR)
  };
}

function applyNetCostModelToOutcome({
  outcome,
  position,
  exitPrice
} = {}) {
  if (!outcome || typeof outcome !== 'object') return outcome;

  if (!isLongPosition(position) || !isLongPosition(outcome)) {
    return {
      ...outcome,
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

  const grossR = calcGrossRFromPosition({
    position,
    exitPrice
  });

  const cost = calcRoundTripCostBreakdownR({
    position,
    exitPrice
  });

  const netR = grossR - cost.costR;

  return forceLongPositionFields({
    ...outcome,

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

    grossR: round6(grossR),
    rawR: round6(grossR),
    realizedGrossR: round6(grossR),

    costR: cost.costR,
    avgCostR: cost.costR,
    totalCostR: cost.costR,
    feeR: cost.feeR,
    slippageR: cost.slippageR,
    marketImpactR: cost.marketImpactR,
    spreadCostR: cost.spreadCostR,

    netR: round6(netR),
    exitR: round6(netR),
    realizedNetR: round6(netR),
    realizedR: round6(netR),
    r: round6(netR),

    win: netR > 0,
    loss: netR < 0,
    flat: netR === 0,
    isWin: netR > 0,

    costModelApplied: true,
    netCostModelApplied: true,
    costModel: COST_MODEL_VERSION,
    costModelVersion: COST_MODEL_VERSION,

    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR'
  });
}

export async function getOpenPositions() {
  const redis = getDurableRedis();
  const keys = await getKeys(redis, LONG_KEYS.trade.openPattern, 1000);

  if (!keys.length) return [];

  const rows = await Promise.all(
    keys.map((key) => getJson(redis, key, null))
  );

  return rows
    .filter(Boolean)
    .filter(isLongPosition)
    .filter((row) => !isScannerFamilyRow(row))
    .sort((a, b) => (
      safeNumber(a.openedAt || a.createdAt, 0) -
      safeNumber(b.openedAt || b.createdAt, 0)
    ));
}

export async function getOpenPosition(symbol) {
  const keySymbol = storageSymbol(symbol);

  if (!keySymbol) return null;

  const row = await getJson(
    getDurableRedis(),
    LONG_KEYS.trade.open(keySymbol),
    null
  );

  if (!row) return null;
  if (!isLongPosition(row)) return null;
  if (isScannerFamilyRow(row)) return null;

  return row;
}

export async function saveOpenPosition(position) {
  assertLongInput(position, 'SAVE_OPEN_POSITION');

  const keySymbol = storageSymbol(position);

  if (!keySymbol) {
    throw new Error('OPEN_POSITION_SYMBOL_MISSING');
  }

  const existing = await getOpenPosition(keySymbol);

  if (
    existing &&
    existing.tradeId &&
    position.tradeId &&
    existing.tradeId !== position.tradeId
  ) {
    throw new Error('OPEN_POSITION_SYMBOL_ALREADY_OPEN_LONG_ONLY');
  }

  const normalized = forceLongPositionFields(position);
  const identity = normalizeMicroIdentity(normalized);

  const row = forceLongPositionFields({
    ...normalized,
    ...identity,
    ...buildVirtualFlags(normalized),

    symbol: normalized.symbol || keySymbol,
    baseSymbol: normalized.baseSymbol || keySymbol,
    contractSymbol: normalized.contractSymbol || null,

    status: normalized.status || 'OPEN',

    strategyVersion: normalized.strategyVersion || CONFIG.strategyVersion,

    updatedAt: now()
  });

  assertPositionPersistable(row);

  await setJson(
    getDurableRedis(),
    LONG_KEYS.trade.open(keySymbol),
    row
  );

  return row;
}

export async function deleteOpenPosition(symbol) {
  const keySymbol = storageSymbol(symbol);

  if (!keySymbol) return 0;

  const key = LONG_KEYS.trade.open(keySymbol);

  if (!key) return 0;

  return getDurableRedis().del(key);
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

  const current = safeNumber(price, 0);
  const entry = safeNumber(position.entry, 0);
  const initialSl = safeNumber(position.initialSl || position.sl, 0);
  const tp = safeNumber(position.tp, 0);

  if (entry <= 0 || initialSl <= 0 || tp <= 0 || current <= 0) {
    return forceLongPositionFields({
      ...position,
      updatedAt: now()
    });
  }

  const riskDist = entry - initialSl;
  const rewardDist = tp - entry;

  if (riskDist <= 0 || rewardDist <= 0) {
    return forceLongPositionFields({
      ...position,
      updatedAt: now()
    });
  }

  const directionalMove = current - entry;
  const currentR = directionalMove / riskDist;
  const tpProgress = directionalMove / rewardDist;

  position.lastPrice = current;
  position.currentPrice = current;
  position.currentR = round4(currentR);

  position.mfeR = round4(Math.max(
    safeNumber(position.mfeR, 0),
    position.currentR
  ));

  position.maeR = round4(Math.min(
    safeNumber(position.maeR, 0),
    position.currentR
  ));

  position.maxTpProgress = round4(Math.max(
    safeNumber(position.maxTpProgress, 0),
    tpProgress
  ));

  position.ticksObserved = safeNumber(position.ticksObserved, 0) + 1;

  if (currentR > 0) {
    position.favorableTicks = safeNumber(position.favorableTicks, 0) + 1;
  }

  if (currentR < 0) {
    position.adverseTicks = safeNumber(position.adverseTicks, 0) + 1;
  }

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

  if (position.reachedHalfR && currentR < 0) {
    position.gaveBackAfterHalfR = true;
  }

  if (position.reachedOneR && currentR < cfg.trailLockR) {
    position.gaveBackAfterOneR = true;
  }

  if (position.nearTpSeen && currentR < 0) {
    position.nearTpThenLoss = true;
  }

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

  const position = forceLongPositionFields({
    ...normalizedEntry,
    ...identity,
    ...buildVirtualFlags(normalizedEntry),

    tradeId: normalizedEntry.tradeId || randomId('trade'),

    symbol: normalizedEntry.symbol || keySymbol,
    baseSymbol: normalizedEntry.baseSymbol || keySymbol,
    contractSymbol: normalizedEntry.contractSymbol || null,

    status: 'OPEN',

    strategyVersion: normalizedEntry.strategyVersion || CONFIG.strategyVersion,

    openedAt,
    createdAt: openedAt,
    updatedAt: openedAt,

    initialSl: normalizedEntry.initialSl || normalizedEntry.sl,

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

    beArmed: false,
    beWouldExit: false,
    beExitR: 0,

    gaveBackAfterHalfR: false,
    gaveBackAfterOneR: false,
    nearTpThenLoss: false,

    liveManaged: false,
    beLiveApplied: false,
    trailLiveApplied: false,
    slManagementSource: null
  });

  assertPositionPersistable(position);

  return position;
}

async function markPriceFetchFailed(position) {
  position.priceFetchFailures = safeNumber(position.priceFetchFailures, 0) + 1;
  position.lastPriceFetchFailedAt = now();
  position.updatedAt = now();

  await saveOpenPosition(forceLongPositionFields(position));

  return position;
}

function enrichOutcomeIdentity(outcome = {}, position = {}) {
  const identity = normalizeMicroIdentity(position);

  const openedAt = safeNumber(position.openedAt || position.createdAt, 0);
  const closedAt = safeNumber(outcome.closedAt || outcome.completedAt, now());
  const ageSec = openedAt > 0 && closedAt > 0
    ? Math.max(0, Math.floor((closedAt - openedAt) / 1000))
    : 0;

  return forceLongPositionFields({
    ...outcome,

    ...identity,

    source: OUTCOME_SOURCE,
    outcomeSource: OUTCOME_SOURCE,
    positionSource: position.source || POSITION_SOURCE,

    tradeId: position.tradeId || outcome.tradeId || null,

    activeRotationId: position.activeRotationId || null,
    selectedRotationId: position.selectedRotationId || position.activeRotationId || null,

    activeMacroFamilyId:
      position.activeMacroFamilyId ||
      identity.parentMacroFamilyId ||
      null,

    selectedMacroFamilyId:
      position.selectedMacroFamilyId ||
      position.activeMacroFamilyId ||
      identity.parentMacroFamilyId ||
      null,

    selectedMicroFamilyAlert: Boolean(position.selectedMicroFamilyAlert),
    discordAlertEligible: Boolean(position.discordAlertEligible),

    weeklyStats: position.weeklyStats || null,

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
      ? position.scannerDefinitionParts
      : identity.scannerDefinitionParts || [],

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintOnlyMetadata: true,
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    outcomeIdentityLocked: true,
    outcomeIdentitySource: 'POSITION_MICRO_IDENTITY',
    learningIdentitySource: 'ANALYZE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,

    isTrueMicro: true,
    isLegacyMacro: false,
    trueMicroOnly: true,

    currentPrice: safeNumber(position.currentPrice ?? position.lastPrice ?? outcome.exitPrice, 0),
    lastPrice: safeNumber(position.lastPrice ?? position.currentPrice ?? outcome.exitPrice, 0),
    entry: safeNumber(position.entry ?? outcome.entry, 0),
    sl: safeNumber(position.sl ?? outcome.sl, 0),
    tp: safeNumber(position.tp ?? outcome.tp, 0),
    initialSl: safeNumber(position.initialSl ?? outcome.initialSl ?? position.sl, 0),

    ageSec,
    currentR: safeNumber(position.currentR ?? outcome.currentR, 0),
    mfeR: safeNumber(position.mfeR ?? outcome.mfeR, 0),
    maeR: safeNumber(position.maeR ?? outcome.maeR, 0),

    reachedHalfR: Boolean(position.reachedHalfR || outcome.reachedHalfR),
    reachedOneR: Boolean(position.reachedOneR || outcome.reachedOneR),
    nearTpSeen: Boolean(position.nearTpSeen || outcome.nearTpSeen),

    tpExitTriggered: String(outcome.exitReason || '').toUpperCase() === 'TP',
    slExitTriggered: ['SL', 'BE_SL', 'TRAIL_SL'].includes(String(outcome.exitReason || '').toUpperCase()),
    timeStopExitTriggered: String(outcome.exitReason || '').toUpperCase() === 'TIME_STOP',

    validLongRiskShape: (
      safeNumber(position.entry, 0) > 0 &&
      safeNumber(position.initialSl || position.sl, 0) < safeNumber(position.entry, 0) &&
      safeNumber(position.tp, 0) > safeNumber(position.entry, 0)
    )
  });
}

async function maybeSendExitAlert(position, outcome) {
  if (!position.discordAlertEligible && !position.selectedMicroFamilyAlert) {
    return {
      sent: false,
      skipped: true,
      reason: 'POSITION_NOT_SELECTED_FOR_DISCORD_EXIT_ALERT'
    };
  }

  try {
    await sendExitAlert(outcome);

    return {
      sent: true,
      skipped: false,
      reason: 'DISCORD_EXIT_ALERT_SENT'
    };
  } catch (error) {
    return {
      sent: false,
      skipped: false,
      failed: true,
      reason: 'DISCORD_EXIT_ALERT_FAILED',
      error: error?.message || String(error)
    };
  }
}

async function monitorOnePosition({
  position,
  priceFetcher,
  timestamp
}) {
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

  const fetchSymbol = position.contractSymbol || position.symbol;
  const price = await priceFetcher(fetchSymbol).catch(() => 0);

  if (!price) {
    await markPriceFetchFailed(position);

    return {
      type: 'NO_PRICE',
      position,
      outcome: null
    };
  }

  position.priceFetchFailures = 0;
  position.lastPriceFetchFailedAt = null;

  updatePathMetrics(position, price);

  const exit = detectExit({
    position,
    price,
    timestamp
  });

  if (!exit.shouldExit) {
    await saveOpenPosition(position);

    return {
      type: 'UPDATED',
      position,
      outcome: null
    };
  }

  const closedAt = timestamp;
  const exitPrice = roundPrice(price);

  const closedPosition = forceLongPositionFields({
    ...position,
    status: 'CLOSED',
    closedAt,
    exitPrice,
    exitReason: exit.reason,
    outcomeSource: OUTCOME_SOURCE,
    source: POSITION_SOURCE
  });

  const baseOutcome = buildOutcomeFromPosition({
    position: closedPosition,
    exitPrice,
    exitReason: exit.reason,
    source: OUTCOME_SOURCE
  });

  const netOutcome = applyNetCostModelToOutcome({
    outcome: {
      ...baseOutcome,
      status: 'CLOSED',
      closedAt,
      exitPrice,
      exitReason: exit.reason,
      source: OUTCOME_SOURCE,
      outcomeSource: OUTCOME_SOURCE
    },
    position: closedPosition,
    exitPrice
  });

  const outcome = enrichOutcomeIdentity(netOutcome, closedPosition);

  const analyzeOutcome = clonePlainObject(outcome);
  const discordOutcome = clonePlainObject(outcome);

  await recordOutcome(analyzeOutcome, {
    source: OUTCOME_SOURCE
  });

  const discordResult = await maybeSendExitAlert(closedPosition, discordOutcome);

  await deleteOpenPosition(closedPosition.symbol || closedPosition.contractSymbol);

  return {
    type: 'EXIT',
    position: closedPosition,
    outcome: {
      ...discordOutcome,
      discordExitAlertResult: discordResult,
      discordExitAlertSent: Boolean(discordResult.sent)
    }
  };
}

export async function monitorOpenPositions({ priceFetcher }) {
  if (typeof priceFetcher !== 'function') {
    throw new Error('PRICE_FETCHER_REQUIRED');
  }

  const positions = await getOpenPositions();

  if (!positions.length) return [];

  const cfg = tradeConfig();
  const timestamp = now();

  const results = await mapConcurrent(
    positions,
    cfg.dataConcurrency,
    async (position) => monitorOnePosition({
      position,
      priceFetcher,
      timestamp
    })
  );

  return results
    .filter((row) => row?.type === 'EXIT' && row.outcome)
    .map((row) => row.outcome);
}