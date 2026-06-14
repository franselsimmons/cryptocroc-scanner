// ================= FILE: api/trade/run.js =================

import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import {
  getDurableRedis,
  setJson
} from '../../src/redis.js';
import { withRedisLock } from '../../src/lock.js';
import { runTradeSystem } from '../../src/trade/tradeSystem.js';
import { sideToTradeSide } from '../../src/utils.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const TARGET_SCANNER_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;

const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';
const DEFAULT_LOCK_TTL_SEC = 180;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;
const MIN_COMPLETED_ACTIVE_LEARNING = 20;

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_V1';

const RUN_SCOPE = 'TRADE_ONLY';
const WRITE_SCOPE = 'TRADE_AND_ANALYZE_PARTIAL_ONLY';
const READ_SCOPE = 'READ_LONG_SCANNER_LATEST_ONLY';

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

const LONG_FIXED_CONFIRMATION_PROFILES = new Set([
  'A_STRONG_ALIGN',
  'B_FLOW_ALIGN',
  'C_VOLUME_ALIGN',
  'D_MIXED_OK',
  'E_WEAK_CONTRA'
]);

function now() {
  return Date.now();
}

function callMaybeKey(value, fallback = null) {
  if (typeof value === 'function') {
    try {
      return value();
    } catch {
      return fallback;
    }
  }

  return value || fallback;
}

function namespacedLongKey(key, fallback = null) {
  const raw = String(callMaybeKey(key, fallback) || '').trim();

  if (!raw) return null;
  if (raw.startsWith(LONG_KEY_PREFIX)) return raw;

  return `${LONG_KEY_PREFIX}${raw}`;
}

const LONG_KEYS = {
  scan: {
    latest: namespacedLongKey(
      KEYS.long?.scan?.latest ||
        KEYS.scan?.longLatest ||
        KEYS.scan?.latest,
      'SCAN:LATEST'
    )
  },

  trade: {
    lock: namespacedLongKey(
      KEYS.long?.trade?.lock ||
        KEYS.trade?.longLock ||
        KEYS.trade?.lock,
      'TRADE:LOCK'
    ),

    runMeta: namespacedLongKey(
      KEYS.long?.trade?.runMeta ||
        KEYS.trade?.longRunMeta ||
        KEYS.trade?.runMeta,
      'TRADE:RUN_META'
    ),

    lastProcessedSnapshot: namespacedLongKey(
      KEYS.long?.trade?.lastProcessedSnapshot ||
        KEYS.trade?.longLastProcessedSnapshot ||
        KEYS.trade?.lastProcessedSnapshot,
      'TRADE:LAST_PROCESSED_SNAPSHOT'
    )
  }
};

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, decimals = 4) {
  return Number(safeNumber(value, 0).toFixed(decimals));
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function getPositionTimeStopMin() {
  const value = Number(
    CONFIG.long?.trade?.positionTimeStopMin ??
      CONFIG.trade?.positionTimeStopMin ??
      DEFAULT_POSITION_TIME_STOP_MIN
  );

  if (!Number.isFinite(value) || value <= 0) return DEFAULT_POSITION_TIME_STOP_MIN;

  return Math.floor(value);
}

function getLockTtlSec() {
  const ttl = Number(
    CONFIG.long?.trade?.lockTtlSec ??
      CONFIG.trade?.lockTtlSec ??
      DEFAULT_LOCK_TTL_SEC
  );

  if (!Number.isFinite(ttl) || ttl <= 0) return DEFAULT_LOCK_TTL_SEC;

  return Math.floor(ttl);
}

function isolationFlags() {
  return {
    runScope: RUN_SCOPE,
    writeScope: WRITE_SCOPE,
    readScope: READ_SCOPE,

    adminPageIsolation: true,
    doesNotOverwriteOtherAdminPages: true,

    readsScannerLatest: true,
    scannerLatestReadOnly: true,
    preserveScannerLatest: true,
    preserveScannerSnapshot: true,
    preserveScannerHistory: true,

    scannerRunAllowed: false,
    scannerRunDisabledInsideTradeRun: true,
    noScannerRun: true,
    noScannerRefresh: true,
    noScannerLatestWrite: true,
    noScannerSnapshotWrite: true,

    writesScanner: false,
    writesScannerLatest: false,
    writesScannerSnapshot: false,
    writesScannerHistory: false,

    writesTrade: true,
    writesTradeRunMeta: true,
    writesTradePositions: true,

    writesAnalyze: true,
    writesAnalyzePartial: true,
    writesMicroFamilies: true,
    microFamiliesAppendOnly: true,
    microFamiliesAntiWipe: true,
    analyzePartialOnly: true,
    analyzeFullOverwriteDisabled: true,

    writesRotation: false,
    writesDiscordSelection: false,
    writesManualSelection: false,

    preserveRotation: true,
    preserveManualSelection: true,
    preserveDiscordSelection: true,

    noResetCron: true,
    resetCronDisabled: true,
    noActivateCron: true,
    activateCronDisabled: true,
    noFreezeCron: true,
    freezeCronDisabled: true,
    autoRotationActivationDisabled: true,

    ignoreGlobalMaxOpenPositions: true,
    noGlobalMaxOpenPositionsBlock: true,
    globalMaxOpenPositionsBlockDisabled: true,
    maxOneOpenPositionPerSymbol: true,
    oneOpenPositionPerSymbol: true
  };
}

function baseFlags() {
  return {
    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    actualScannerSide: TARGET_SCANNER_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    virtualOnly: true,
    virtualLearning: true,
    virtualLearningForced: true,
    virtualTracked: true,
    source: 'VIRTUAL',
    outcomeSource: 'VIRTUAL',

    realOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    noExchangeOrders: true,
    noRealOrders: true,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    learningOnly: true,
    microFamilyLearning: true,

    observationFirst: true,
    observationFirstAnalyze: true,

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

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintOnlyMetadata: true,
    scannerFingerprintsHiddenFromLearning: true,
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,

    executionFingerprintRole: 'METADATA_ONLY',
    executionFingerprintOnlyMetadata: true,
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    exactTrueMicroFamilyRequired: true,
    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    fixedTaxonomyPreferred: true,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    symbolExcludedFromFamilyId: true,
    selectableMicroFamilyCount: 75,
    parentMicroFamilyCount: 15,
    selectionGranularity: 'EXACT_75_CHILD',

    positionTimeStopMinDefault: DEFAULT_POSITION_TIME_STOP_MIN,
    positionTimeStopMin: getPositionTimeStopMin(),

    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForManualSelection: true,
    discordOnlyForExactTrueMicroMatch: true,
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    manualSelectionRequires75ChildTrueMicroFamilyId: true,
    parentMacroMatchDoesNotTriggerDiscord: true,
    macroMatchDoesNotTriggerDiscord: true,

    autoRotationActivationDisabled: true,
    activateFreezeCronDisabled: true,
    resetCronDisabled: true,

    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    redisKeysSeparatedFromShortRoot: true,
    shortRootTouched: false,

    ...isolationFlags()
  };
}

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET, POST');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET', 'POST'],
    ...baseFlags()
  });
}

function isAllowedMethod(method) {
  return method === 'GET' || method === 'POST';
}

function parseJson(text) {
  const raw = String(text || '').trim();

  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('INVALID_JSON_BODY');
    error.statusCode = 400;
    throw error;
  }
}

async function readBody(req) {
  if (req.method === 'GET') return {};

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

function isTrue(value) {
  if (value === true || value === 1) return true;

  const raw = String(value ?? '').trim().toLowerCase();

  return ['true', '1', 'yes', 'y', 'on', 'force', 'forced'].includes(raw);
}

function shouldForceProcessSnapshot(req, body = {}) {
  return (
    isTrue(firstValue(req.query?.force, false)) ||
    isTrue(firstValue(req.query?.forced, false)) ||
    isTrue(firstValue(req.query?.forceProcessSnapshot, false)) ||
    isTrue(firstValue(req.query?.force_process_snapshot, false)) ||
    isTrue(body.force) ||
    isTrue(body.forced) ||
    isTrue(body.forceProcessSnapshot) ||
    isTrue(body.force_process_snapshot)
  );
}

function shouldMonitorOnly(req, body = {}) {
  return (
    isTrue(firstValue(req.query?.monitorOnly, false)) ||
    isTrue(firstValue(req.query?.monitor_only, false)) ||
    isTrue(body.monitorOnly) ||
    isTrue(body.monitor_only)
  );
}

function getRunSource(req, body = {}) {
  const manual = (
    isTrue(firstValue(req.query?.manual, false)) ||
    isTrue(firstValue(req.query?.force, false)) ||
    isTrue(firstValue(req.query?.forced, false)) ||
    isTrue(firstValue(req.query?.forceProcessSnapshot, false)) ||
    isTrue(firstValue(req.query?.force_process_snapshot, false)) ||
    isTrue(body.manual) ||
    isTrue(body.force) ||
    isTrue(body.forced) ||
    isTrue(body.forceProcessSnapshot) ||
    isTrue(body.force_process_snapshot)
  );

  return manual
    ? 'ADMIN_MANUAL_LONG_TRADE_RUN'
    : 'CRON_OR_API_LONG_TRADE_RUN';
}

function cleanSideText(value = '') {
  return upper(value)
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
  return cleanSideText(value)
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

function hasLongSignal(value = '') {
  return hasSignalPattern(value, [
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

function hasShortSignal(value = '') {
  return hasSignalPattern(value, [
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

function parseLongFixedTaxonomyId(id = '') {
  const value = upper(id);
  const match = /^MICRO_LONG_([A-Z_]+)_(TREND|CHOP|SQUEEZE)(?:_(A_STRONG_ALIGN|B_FLOW_ALIGN|C_VOLUME_ALIGN|D_MIXED_OK|E_WEAK_CONTRA))?$/.exec(value);

  if (!match) return null;

  const setup = match[1];
  const regime = match[2];
  const confirmation = match[3] || null;

  if (!LONG_FIXED_SETUP_TYPES.has(setup)) return null;
  if (!LONG_FIXED_REGIME_BUCKETS.has(regime)) return null;
  if (confirmation && !LONG_FIXED_CONFIRMATION_PROFILES.has(confirmation)) return null;

  const parentTrueMicroFamilyId = `MICRO_LONG_${setup}_${regime}`;
  const childTrueMicroFamilyId = confirmation
    ? `${parentTrueMicroFamilyId}_${confirmation}`
    : null;

  return {
    setup,
    regime,
    confirmation,
    parentTrueMicroFamilyId,
    childTrueMicroFamilyId,
    isParent: !confirmation,
    isChild: Boolean(confirmation)
  };
}

function isFixedLongTaxonomyParentId(id = '') {
  return parseLongFixedTaxonomyId(id)?.isParent === true;
}

function isFixedLongTaxonomyChildId(id = '') {
  return parseLongFixedTaxonomyId(id)?.isChild === true;
}

function isFixedLongTaxonomyMicroId(id = '') {
  return isFixedLongTaxonomyChildId(id);
}

function parentFromChildTrueMicroFamilyId(id = '') {
  const parsed = parseLongFixedTaxonomyId(id);

  if (!parsed?.isChild) return null;

  return parsed.parentTrueMicroFamilyId;
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

function idLooksLikeLongFamily(id = '') {
  const value = String(id || '').trim();

  if (!validLearningId(value)) return false;

  return hasLongSignal(value);
}

function idLooksLikeShortFamily(id = '') {
  const value = String(id || '').trim();

  if (!validLearningId(value)) return false;

  return hasShortSignal(value);
}

function isSelectableTrueMicroId(id = '') {
  const value = String(id || '').trim();

  if (!validLearningId(value)) return false;
  if (!isFixedLongTaxonomyChildId(value)) return false;
  if (idLooksLikeShortFamily(value) && !idLooksLikeLongFamily(value)) return false;

  return true;
}

function isSelectableParentTrueMicroId(id = '') {
  const value = String(id || '').trim();

  if (!validLearningId(value)) return false;
  if (!isFixedLongTaxonomyParentId(value)) return false;
  if (idLooksLikeShortFamily(value) && !idLooksLikeLongFamily(value)) return false;

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

function stripSymbolTokensFromFamilyId(id = '', row = {}) {
  const raw = String(id || '').trim();

  if (!raw) return raw;

  if (isFixedLongTaxonomyParentId(raw) || isFixedLongTaxonomyChildId(raw)) {
    return upper(raw);
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

function cleanLearningFamilyId(id = '', row = {}) {
  const raw = String(id || '').trim();

  if (!raw) return '';
  if (isScannerFingerprintId(raw)) return '';
  if (isExecutionFingerprintId(raw)) return '';

  const clean = stripSymbolTokensFromFamilyId(raw, row);

  if (!clean) return '';
  if (isScannerFingerprintId(clean)) return '';
  if (isExecutionFingerprintId(clean)) return '';

  return clean;
}

function scannerMicroFamilyIdFrom(row = {}) {
  return (
    row.scannerMicroFamilyId ||
    (isScannerFingerprintId(row.microFamilyId) ? row.microFamilyId : null) ||
    (isScannerFingerprintId(row.trueMicroFamilyId) ? row.trueMicroFamilyId : null) ||
    (isScannerFingerprintId(row.id) ? row.id : null) ||
    (isScannerFingerprintId(row.key) ? row.key : null) ||
    null
  );
}

function scannerFamilyIdFrom(row = {}) {
  return (
    row.scannerFamilyId ||
    (isScannerFingerprintId(row.familyId) ? row.familyId : null) ||
    (isScannerFingerprintId(row.baseFamilyId) ? row.baseFamilyId : null) ||
    null
  );
}

function executionMicroFamilyIdFrom(row = {}) {
  return (
    row.executionMicroFamilyId ||
    (isExecutionFingerprintId(row.microFamilyId) ? row.microFamilyId : null) ||
    (isExecutionFingerprintId(row.trueMicroFamilyId) ? row.trueMicroFamilyId : null) ||
    (isExecutionFingerprintId(row.analyzeMicroFamilyId) ? row.analyzeMicroFamilyId : null) ||
    (isExecutionFingerprintId(row.id) ? row.id : null) ||
    (isExecutionFingerprintId(row.key) ? row.key : null) ||
    null
  );
}

function scannerMetadataFrom(row = {}) {
  const scannerMicroFamilyId = scannerMicroFamilyIdFrom(row);
  const scannerFamilyId = scannerFamilyIdFrom(row);
  const executionMicroFamilyId = executionMicroFamilyIdFrom(row);

  return {
    scannerMicroFamilyId: scannerMicroFamilyId || null,
    scannerFamilyId: scannerFamilyId || null,
    scannerDefinition: row.scannerDefinition || (
      scannerMicroFamilyId
        ? row.definition || row.microDefinition || null
        : null
    ),
    scannerDefinitionParts: Array.isArray(row.scannerDefinitionParts)
      ? row.scannerDefinitionParts
      : scannerMicroFamilyId && Array.isArray(row.definitionParts)
        ? row.definitionParts
        : [],

    scannerBucket: row.scannerBucket || row.bucket || null,
    scannerBucket25: row.scannerBucket25 || row.legacyBucket25 || null,
    scannerFingerprintHash: row.scannerFingerprintHash || row.fingerprintHash || null,
    scannerFingerprintParts: Array.isArray(row.scannerFingerprintParts)
      ? row.scannerFingerprintParts
      : [],

    executionMicroFamilyId,
    executionFingerprintRole: 'METADATA_ONLY',
    executionFingerprintOnlyMetadata: Boolean(executionMicroFamilyId),
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintOnlyMetadata: true,
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,

    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true
  };
}

function firstCleanId(values = [], row = {}) {
  for (const value of values) {
    const id = cleanLearningFamilyId(value, row);

    if (id && validLearningId(id)) return id;
  }

  return '';
}

function normalizeLearningIdentity(row = {}) {
  const childCandidate = firstCleanId([
    row.trueMicroFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.microFamilyId,
    row.childTrueMicroFamilyId
  ], row);

  const childTrueMicroFamilyId = isSelectableTrueMicroId(childCandidate)
    ? upper(childCandidate)
    : null;

  const parentCandidate = firstCleanId([
    row.parentTrueMicroFamilyId,
    row.parentMicroFamilyId,
    row.parentMacroFamilyId,
    row.coarseMicroFamilyId,
    row.baseMicroFamilyId,
    row.legacyMicroFamilyId,
    parentFromChildTrueMicroFamilyId(childTrueMicroFamilyId)
  ], row);

  const parentTrueMicroFamilyId = isSelectableParentTrueMicroId(parentCandidate)
    ? upper(parentCandidate)
    : parentFromChildTrueMicroFamilyId(childTrueMicroFamilyId);

  return {
    microFamilyId: childTrueMicroFamilyId,
    trueMicroFamilyId: childTrueMicroFamilyId,
    analyzeMicroFamilyId: childTrueMicroFamilyId,
    learningMicroFamilyId: childTrueMicroFamilyId,

    childTrueMicroFamilyId,
    parentTrueMicroFamilyId,

    coarseMicroFamilyId: parentTrueMicroFamilyId,
    baseMicroFamilyId: parentTrueMicroFamilyId,
    legacyMicroFamilyId: parentTrueMicroFamilyId,

    parentMicroFamilyId: parentTrueMicroFamilyId,
    parentMacroFamilyId: parentTrueMicroFamilyId,
    macroFamilyId: parentTrueMicroFamilyId,

    fixedTaxonomyLearningId: Boolean(childTrueMicroFamilyId),
    fixedTaxonomyParentId: Boolean(parentTrueMicroFamilyId),
    trueMicroFamilySchema: childTrueMicroFamilyId ? TRUE_MICRO_SCHEMA : null,
    parentTrueMicroFamilySchema: parentTrueMicroFamilyId ? PARENT_TRUE_MICRO_SCHEMA : null,
    broadTrueMicroFamilySchema: childTrueMicroFamilyId ? TRUE_MICRO_SCHEMA : null,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY
  };
}

function normalizeTradeSide(value) {
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

function inferTradeSideFromText(value) {
  const text = cleanSideText(value);

  if (!text) return 'UNKNOWN';

  const direct = normalizeTradeSide(text);

  if (direct === TARGET_TRADE_SIDE || direct === OPPOSITE_TRADE_SIDE) {
    return direct;
  }

  const longHit = hasLongSignal(text);
  const shortHit = hasShortSignal(text);

  if (longHit && !shortHit) return TARGET_TRADE_SIDE;
  if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;

  if (longHit && shortHit) {
    if (text.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
    if (text.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
    if (text.includes('TRADE_SIDE=LONG') || text.includes('TRADESIDE=LONG')) return TARGET_TRADE_SIDE;
    if (text.includes('TRADE_SIDE=SHORT') || text.includes('TRADESIDE=SHORT')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferActionTradeSide(row = {}) {
  if (typeof row === 'string') return inferTradeSideFromText(row);

  if (!row || typeof row !== 'object') return 'UNKNOWN';

  const directSources = [
    row.tradeSide,
    row.positionSide,
    row.direction,
    row.signalSide,
    row.scannerSide,
    row.actualScannerSide,
    row.analysisSide,
    row.entrySide,
    row.side,
    row.bias,
    row.marketBias
  ];

  for (const value of directSources) {
    const direct = normalizeTradeSide(value);

    if (direct !== 'UNKNOWN') return direct;
  }

  const reasonSide = inferTradeSideFromText(
    row.scannerReason ||
      row.reason ||
      row.signalReason ||
      row.actionReason ||
      row.exitReason ||
      row.rejectionReason ||
      ''
  );

  if (reasonSide !== 'UNKNOWN') return reasonSide;

  const haystack = [
    row.familyId,
    row.family,
    row.baseFamilyId,

    row.microFamilyId,
    row.trueMicroFamilyId,
    row.liveMicroFamilyId,
    row.realMicroFamilyId,
    row.executionMicroFamilyId,
    row.coarseMicroFamilyId,
    row.baseMicroFamilyId,
    row.legacyMicroFamilyId,
    row.parentTrueMicroFamilyId,
    row.scannerMicroFamilyId,
    row.scannerFamilyId,
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
  ]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('|');

  const side = inferTradeSideFromText(haystack);

  if (side !== 'UNKNOWN') return side;

  if (row.longOnly === true || row.shortDisabled === true) return TARGET_TRADE_SIDE;
  if (row.shortOnly === true || row.longDisabled === true) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function isLongAction(row = {}) {
  return inferActionTradeSide(row) !== OPPOSITE_TRADE_SIDE;
}

function isShortAction(row = {}) {
  return inferActionTradeSide(row) === OPPOSITE_TRADE_SIDE;
}

function forceLongVirtualRow(row = {}) {
  const inferredTradeSide = inferActionTradeSide(row);
  const identity = normalizeLearningIdentity(row);
  const scannerMetadata = scannerMetadataFrom(row);

  const hasLearningMicroId = Boolean(identity.trueMicroFamilyId);

  return {
    ...row,

    ...identity,
    ...scannerMetadata,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    scannerSide: TARGET_SCANNER_SIDE,
    actualScannerSide: TARGET_SCANNER_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    source: row.source || 'VIRTUAL',
    outcomeSource: row.outcomeSource || row.source || 'VIRTUAL',
    virtualOnly: true,
    virtualTracked: true,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,
    realOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    noExchangeOrders: true,
    noRealOrders: true,

    microFamilyLearning: true,
    hasAnalyzeMicroFamilyId: hasLearningMicroId,
    scannerFingerprintCanOpenPosition: false,
    scannerFingerprintCanBeLearningFamily: false,
    scannerFingerprintCanTriggerDiscord: false,
    executionFingerprintCanBeLearningFamily: false,

    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    exactTrueMicroFamilyRequired: true,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    fixedTaxonomyPreferred: true,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    symbolExcludedFromFamilyId: true,

    selectedMicroFamilyAlert: Boolean(
      row.selectedMicroFamilyAlert &&
        hasLearningMicroId
    ),

    discordAlertEligible: Boolean(
      row.discordAlertEligible &&
        row.selectedMicroFamilyAlert &&
        hasLearningMicroId
    ),

    inferredTradeSide: inferredTradeSide === 'UNKNOWN'
      ? TARGET_TRADE_SIDE
      : inferredTradeSide,

    inferredFromLongOnlyMode: inferredTradeSide === 'UNKNOWN',

    ...isolationFlags()
  };
}

function countActionsByType(actions = []) {
  return actions.reduce((acc, row) => {
    const key = row?.action || row?.type || 'UNKNOWN';

    acc[key] = (acc[key] || 0) + 1;

    return acc;
  }, {});
}

function mergeActionCounts(...counts) {
  return counts.reduce((acc, row) => {
    for (const [key, value] of Object.entries(row || {})) {
      acc[key] = safeNumber(acc[key], 0) + safeNumber(value, 0);
    }

    return acc;
  }, {});
}

function unwrapLockResult(lockResult) {
  if (!lockResult) return null;

  if (lockResult.result?.result?.result) return lockResult.result.result.result;
  if (lockResult.result?.result) return lockResult.result.result;
  if (lockResult.result) return lockResult.result;

  return lockResult;
}

function responseOk(lockResult) {
  const payload = unwrapLockResult(lockResult);

  return (
    lockResult?.ok !== false &&
    payload?.ok !== false
  );
}

function responseSkipped(lockResult) {
  const payload = unwrapLockResult(lockResult);

  return Boolean(
    lockResult?.skipped ||
    payload?.skippedNewEntries ||
    payload?.skipped ||
    false
  );
}

function responseReason(lockResult) {
  const payload = unwrapLockResult(lockResult);

  return (
    lockResult?.reason ||
    payload?.reason ||
    payload?.skipReason ||
    null
  );
}

function responseRunId(lockResult) {
  const payload = unwrapLockResult(lockResult);

  return payload?.runId || null;
}

function responseSnapshotId(lockResult) {
  const payload = unwrapLockResult(lockResult);

  return payload?.snapshotId || null;
}

function sanitizeArray(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .filter(isLongAction)
    .map(forceLongVirtualRow);
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

function sanitizeParentIds(ids = []) {
  return [...new Set(
    flattenValues(Array.isArray(ids) ? ids : [ids])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .filter(validLearningId)
      .map((id) => cleanLearningFamilyId(id, {}))
      .filter(Boolean)
      .filter(isSelectableParentTrueMicroId)
  )];
}

function sanitizeTrueMicroIds(ids = []) {
  return [...new Set(
    flattenValues(Array.isArray(ids) ? ids : [ids])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .filter(validLearningId)
      .map((id) => cleanLearningFamilyId(id, {}))
      .filter(Boolean)
      .filter(isSelectableTrueMicroId)
  )];
}

function selectRawExitRows(payload = {}) {
  if (Array.isArray(payload.virtualExits)) return payload.virtualExits;
  if (Array.isArray(payload.shadowExits)) return payload.shadowExits;
  if (Array.isArray(payload.exits)) return payload.exits;
  if (Array.isArray(payload.closedPositions)) return payload.closedPositions;
  if (Array.isArray(payload.outcomes)) return payload.outcomes;

  return [];
}

function selectRawEntryRows(payload = {}, actions = []) {
  if (Array.isArray(payload.entryRows)) return payload.entryRows;
  if (Array.isArray(payload.entries)) return payload.entries;
  if (Array.isArray(payload.virtualCreatedRows)) return payload.virtualCreatedRows;
  if (Array.isArray(payload.shadowCreatedRows)) return payload.shadowCreatedRows;

  return actions.filter((row) => row?.action === 'VIRTUAL_ENTRY' || row?.action === 'ENTRY');
}

function selectRawWaitRows(payload = {}, actions = []) {
  if (Array.isArray(payload.waitRows)) return payload.waitRows;
  if (Array.isArray(payload.waits)) return payload.waits;

  return actions.filter((row) => row?.action === 'WAIT');
}

function normalizeExitMath(row = {}) {
  const entry = safeNumber(row.entry ?? row.entryPrice, 0);
  const initialSl = safeNumber(row.initialSl ?? row.initialStopLoss ?? row.sl ?? row.stopLoss, 0);
  const exitPrice = safeNumber(row.exitPrice ?? row.currentPrice ?? row.lastPrice ?? row.price, 0);

  const riskDistance = entry > 0 && initialSl > 0 && initialSl < entry
    ? entry - initialSl
    : 0;

  const grossR = riskDistance > 0
    ? (exitPrice - entry) / riskDistance
    : safeNumber(row.grossR, 0);

  const netR = safeNumber(
    row.netR ??
      row.r ??
      row.realizedNetR ??
      row.realizedR ??
      grossR,
    grossR
  );

  return {
    entry: round(entry, 10),
    initialSl: round(initialSl, 10),
    exitPrice: round(exitPrice, 10),
    grossR: round(grossR, 4),
    netR: round(netR, 4),
    r: round(netR, 4),
    realizedR: round(row.realizedR ?? netR, 4),
    costR: round(row.costR ?? row.totalCostR, 4),
    avgCostR: round(row.avgCostR ?? row.costR ?? row.totalCostR, 4)
  };
}

function buildExitAction(exit = {}) {
  return forceLongVirtualRow({
    ...exit,
    ...normalizeExitMath(exit),
    action: 'VIRTUAL_EXIT',
    reason: exit.exitReason || exit.reason || 'VIRTUAL_POSITION_CLOSED',
    source: 'VIRTUAL',
    outcomeSource: 'VIRTUAL'
  });
}

function sanitizeExitRows(rows = []) {
  return sanitizeArray(rows).map((row) => ({
    ...row,
    ...normalizeExitMath(row),
    action: 'VIRTUAL_EXIT',
    source: 'VIRTUAL',
    outcomeSource: 'VIRTUAL',
    virtualOnly: true,
    virtualTracked: true,
    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,
    realOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    noRealOrders: true,
    ...isolationFlags()
  }));
}

function buildMergedActionCounts(actions = [], virtualExits = [], payloadActionCounts = {}) {
  const exitActions = virtualExits.map(buildExitAction);

  return mergeActionCounts(
    payloadActionCounts || {},
    countActionsByType([
      ...actions,
      ...exitActions
    ])
  );
}

function sanitizeRunPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;

  const rawActions = Array.isArray(payload.actions) ? payload.actions : [];
  const rawExitRows = selectRawExitRows(payload);

  const actions = sanitizeArray(rawActions);
  const virtualExits = sanitizeExitRows(rawExitRows);
  const shadowExits = virtualExits;

  const entryRowsList = sanitizeArray(selectRawEntryRows(payload, actions));
  const waitRowsList = sanitizeArray(selectRawWaitRows(payload, actions));

  const ignoredShortActions = rawActions.filter(isShortAction).length;
  const ignoredUnknownSideActions = rawActions.filter((row) => inferActionTradeSide(row) === 'UNKNOWN').length;

  const ignoredShortExitRows = rawExitRows.filter(isShortAction).length;
  const ignoredUnknownSideExitRows = rawExitRows.filter((row) => inferActionTradeSide(row) === 'UNKNOWN').length;

  const scannerFingerprintActions = rawActions.filter((row) => (
    isScannerFingerprintId(row?.microFamilyId) ||
    isScannerFingerprintId(row?.trueMicroFamilyId) ||
    isScannerFingerprintId(row?.id) ||
    isScannerFingerprintId(row?.key)
  )).length;

  const scannerFingerprintExitRows = rawExitRows.filter((row) => (
    isScannerFingerprintId(row?.microFamilyId) ||
    isScannerFingerprintId(row?.trueMicroFamilyId) ||
    isScannerFingerprintId(row?.id) ||
    isScannerFingerprintId(row?.key)
  )).length;

  const executionFingerprintActions = rawActions.filter((row) => (
    isExecutionFingerprintId(row?.microFamilyId) ||
    isExecutionFingerprintId(row?.trueMicroFamilyId) ||
    isExecutionFingerprintId(row?.analyzeMicroFamilyId) ||
    isExecutionFingerprintId(row?.id) ||
    isExecutionFingerprintId(row?.key)
  )).length;

  const executionFingerprintExitRows = rawExitRows.filter((row) => (
    isExecutionFingerprintId(row?.microFamilyId) ||
    isExecutionFingerprintId(row?.trueMicroFamilyId) ||
    isExecutionFingerprintId(row?.analyzeMicroFamilyId) ||
    isExecutionFingerprintId(row?.id) ||
    isExecutionFingerprintId(row?.key)
  )).length;

  const activeMicroFamilyIds = sanitizeTrueMicroIds(
    payload.activeMicroFamilyIds ||
      payload.selectedMicroFamilyIds ||
      payload.trueMicroFamilyIds ||
      payload.microFamilyIds ||
      []
  );

  const selectedMicroFamilyIds = sanitizeTrueMicroIds(
    payload.selectedMicroFamilyIds ||
      payload.activeMicroFamilyIds ||
      payload.trueMicroFamilyIds ||
      payload.microFamilyIds ||
      []
  );

  const activeMacroFamilyIds = sanitizeParentIds(
    payload.activeMacroFamilyIds ||
      payload.selectedMacroFamilyIds ||
      payload.macroFamilyIds ||
      []
  );

  const selectedMacroFamilyIds = sanitizeParentIds(
    payload.selectedMacroFamilyIds ||
      payload.activeMacroFamilyIds ||
      payload.macroFamilyIds ||
      []
  );

  const actionCounts = buildMergedActionCounts(
    actions,
    virtualExits,
    payload.actionCounts
  );

  const entryRows = safeNumber(
    Array.isArray(payload.entryRows)
      ? entryRowsList.length
      : payload.entryRows ??
        entryRowsList.length,
    entryRowsList.length
  );

  const waitRows = safeNumber(
    Array.isArray(payload.waitRows)
      ? waitRowsList.length
      : payload.waitRows ??
        waitRowsList.length,
    waitRowsList.length
  );

  const virtualCreatedRows = safeNumber(
    Array.isArray(payload.virtualCreatedRows)
      ? sanitizeArray(payload.virtualCreatedRows).length
      : payload.virtualCreatedRows ??
        payload.shadowCreatedRows ??
        entryRows,
    entryRows
  );

  return {
    ...payload,

    ...baseFlags(),

    ok: payload.ok !== false,
    runId: payload.runId || null,

    actions,
    virtualActions: actions,

    entryRows,
    waitRows,
    virtualCreatedRows,

    entryRowsList,
    waitRowsList,
    virtualCreatedRowsList: entryRowsList,

    actionCounts,

    actionsCount: actions.length,
    virtualActionsCount: actions.length,

    virtualSkippedRows: safeNumber(payload.virtualSkippedRows ?? payload.shadowSkippedRows, 0),
    virtualFailedRows: safeNumber(payload.virtualFailedRows ?? payload.shadowFailedRows, 0),

    shadowCreatedRows: safeNumber(payload.shadowCreatedRows ?? virtualCreatedRows, virtualCreatedRows),
    shadowSkippedRows: safeNumber(payload.shadowSkippedRows ?? payload.virtualSkippedRows, 0),
    shadowFailedRows: safeNumber(payload.shadowFailedRows ?? payload.virtualFailedRows, 0),

    realExits: [],
    realExitsCount: 0,
    realExitRows: 0,

    shadowExits,
    shadowExitsCount: shadowExits.length,
    shadowExitRows: shadowExits.length,

    virtualExits,
    virtualExitsCount: virtualExits.length,
    virtualExitRows: virtualExits.length,

    exits: virtualExits,
    exitsCount: virtualExits.length,

    rawActionsCount: rawActions.length,
    rawExitRowsCount: rawExitRows.length,

    ignoredShortActions,
    ignoredUnknownSideActions,
    ignoredShortExitRows,
    ignoredUnknownSideExitRows,

    shortActionsBlockedOrIgnored: ignoredShortActions,
    shortExitsBlockedOrIgnored: ignoredShortExitRows,

    scannerFingerprintActions,
    scannerFingerprintExitRows,
    scannerFingerprintsUsedAsLearningFamily: 0,

    executionFingerprintActions,
    executionFingerprintExitRows,
    executionFingerprintsUsedAsLearningFamily: 0,

    activeMicroFamilyIds,
    activeMacroFamilyIds,

    selectedMicroFamilyIds,
    selectedMacroFamilyIds,

    trueMicroFamilyIds: activeMicroFamilyIds,
    activeTrueMicroFamilyIds: activeMicroFamilyIds,
    selectedTrueMicroFamilyIds: selectedMicroFamilyIds,

    activeMicroFamilies: activeMicroFamilyIds.length,
    activeMacroFamilies: activeMacroFamilyIds.length,

    selectedOppositeCandidateCount: 0,

    skippedNewEntries: Boolean(payload.skippedNewEntries),
    skipReason: payload.skipReason || payload.reason || null,
    reason: payload.reason || payload.skipReason || null,

    realTradesOnly: false,
    virtualLearningOnly: true,
    shadowDataMode: 'VIRTUAL_LEARNING_OUTCOMES_COUNTED',

    scannerSnapshotPreserved: true,
    scannerLatestPreserved: true,
    microFamiliesAppendOnly: true,
    analyzePartialOnly: true,

    longExitRules: {
      validRiskShape: 'entry > 0 && sl < entry && tp > entry',
      tp: 'currentPrice >= tp',
      sl: 'currentPrice <= sl',
      timeStop: `age >= ${getPositionTimeStopMin()} minutes`,
      grossR: '(exitPrice - entry) / (entry - initialSl)',
      currentR: '(currentPrice - entry) / (entry - initialSl)',
      outcomeSource: 'VIRTUAL'
    },

    ...isolationFlags()
  };
}

function sanitizeLockResult(lockResult) {
  if (!lockResult || typeof lockResult !== 'object') {
    return lockResult;
  }

  const payload = sanitizeRunPayload(unwrapLockResult(lockResult));

  return {
    ok: lockResult.ok !== false && payload?.ok !== false,
    skipped: Boolean(lockResult.skipped || payload?.skipped || payload?.skippedNewEntries),
    reason: lockResult.reason || payload?.reason || payload?.skipReason || null,

    ...baseFlags(),

    result: payload
  };
}

function responseActionCounts(lockResult) {
  const payload = sanitizeRunPayload(unwrapLockResult(lockResult));

  return {
    ...baseFlags(),
    ...(payload?.actionCounts || {})
  };
}

function responseCounts(lockResult) {
  const payload = sanitizeRunPayload(unwrapLockResult(lockResult)) || {};

  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const virtualExits = Array.isArray(payload.virtualExits) ? payload.virtualExits : [];

  return {
    ...baseFlags(),

    candidates: safeNumber(payload.candidates || payload.candidatesCount, 0),
    longCandidateCount: safeNumber(
      payload.longCandidateCount ||
        payload.targetCandidateCount ||
        payload.longCandidatesCount,
      0
    ),
    nonLongCandidateCount: safeNumber(
      payload.nonLongCandidateCount ||
        payload.nonTargetCandidateCount,
      0
    ),

    processed: safeNumber(payload.processed, 0),
    earlyActions: safeNumber(payload.earlyActions, 0),

    liveRows: safeNumber(payload.liveRows, 0),
    analyzeInputRows: safeNumber(payload.analyzeInputRows, 0),
    actualLiveRows: safeNumber(payload.actualLiveRows, 0),

    observationOnlyRows: safeNumber(payload.observationOnlyRows, 0),
    learningOnlyRows: safeNumber(payload.learningOnlyRows, 0),

    riskValidRows: safeNumber(payload.riskValidRows || payload.analyzedRiskValidRows, 0),
    riskInvalidRows: safeNumber(payload.riskInvalidRows, 0),

    analyzedRowsRaw: safeNumber(payload.analyzedRowsRaw, 0),
    analyzedRows: safeNumber(payload.analyzedRows, 0),
    analyzedActualRows: safeNumber(payload.analyzedActualRows, 0),
    analyzedRiskValidRows: safeNumber(payload.analyzedRiskValidRows, 0),

    entryRows: safeNumber(payload.entryRows, 0),
    waitRows: safeNumber(payload.waitRows, 0),

    virtualCreatedRows: safeNumber(payload.virtualCreatedRows, 0),
    virtualOpenedRows: safeNumber(payload.virtualCreatedRows, 0),
    virtualSkippedRows: safeNumber(payload.virtualSkippedRows, 0),
    virtualFailedRows: safeNumber(payload.virtualFailedRows, 0),

    shadowCreatedRows: safeNumber(payload.shadowCreatedRows, 0),
    shadowSkippedRows: safeNumber(payload.shadowSkippedRows, 0),
    shadowFailedRows: safeNumber(payload.shadowFailedRows, 0),

    actions: actions.length || safeNumber(payload.actionsCount, 0),
    longActions: actions.length,

    entries: safeNumber(
      payload.entryRows ||
        actions.filter((row) => row?.action === 'VIRTUAL_ENTRY' || row?.action === 'ENTRY').length,
      0
    ),

    waits: safeNumber(
      payload.waitRows ||
        actions.filter((row) => row?.action === 'WAIT').length,
      0
    ),

    observations: actions.filter((row) => (
      row?.action === 'OBSERVATION' ||
      row?.observationWritten ||
      row?.analysisInputOnly ||
      row?.observationOnly
    )).length,

    realExits: 0,
    realExitRows: 0,

    shadowExits: virtualExits.length,
    shadowExitRows: virtualExits.length,

    virtualExits: virtualExits.length,
    virtualExitRows: virtualExits.length,

    activeMicroFamilies: safeNumber(payload.activeMicroFamilies, 0),
    activeMacroFamilies: safeNumber(payload.activeMacroFamilies, 0),

    selectedTargetCandidateCount: safeNumber(payload.selectedTargetCandidateCount, 0),
    selectedOppositeCandidateCount: 0,

    discordEligibleEntries: safeNumber(
      payload.discordAlertEligibleRows ||
        payload.discordEligibleEntries,
      0
    ),

    discordSkippedNotSelected: safeNumber(
      payload.discordAlertsSkippedNoSelectedMicro ||
        payload.discordSkippedNotSelected,
      0
    ),

    ignoredShortActions: safeNumber(payload.ignoredShortActions, 0),
    ignoredUnknownSideActions: safeNumber(payload.ignoredUnknownSideActions, 0),
    ignoredShortExitRows: safeNumber(payload.ignoredShortExitRows, 0),
    ignoredUnknownSideExitRows: safeNumber(payload.ignoredUnknownSideExitRows, 0),

    shortActionsBlockedOrIgnored: safeNumber(payload.shortActionsBlockedOrIgnored, 0),
    shortExitsBlockedOrIgnored: safeNumber(payload.shortExitsBlockedOrIgnored, 0),

    scannerFingerprintActions: safeNumber(payload.scannerFingerprintActions, 0),
    scannerFingerprintExitRows: safeNumber(payload.scannerFingerprintExitRows, 0),
    scannerFingerprintsUsedAsLearningFamily: 0,

    executionFingerprintActions: safeNumber(payload.executionFingerprintActions, 0),
    executionFingerprintExitRows: safeNumber(payload.executionFingerprintExitRows, 0),
    executionFingerprintsUsedAsLearningFamily: 0,

    scannerSnapshotPreserved: true,
    microFamiliesAppendOnly: true
  };
}

function resolveStatus(error) {
  if (Number.isFinite(error?.statusCode)) return error.statusCode;

  if (
    error?.reason === 'LOCK_NOT_ACQUIRED' ||
    error?.message === 'LOCK_NOT_ACQUIRED' ||
    String(error?.message || '').includes('LOCK')
  ) {
    return 409;
  }

  return 500;
}

function buildRunOptions(req, body = {}) {
  const forceProcessSnapshot = shouldForceProcessSnapshot(req, body);
  const monitorOnly = shouldMonitorOnly(req, body);

  return {
    force: forceProcessSnapshot,
    forceProcessSnapshot,
    monitorOnly,

    monitorOpenPositionsFirst: true,
    monitorOpenPositions: true,
    processOpenPositions: true,
    closeVirtualPositions: true,
    processScannerSnapshot: !monitorOnly,

    targetTradeSide: TARGET_TRADE_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    side: TARGET_DASHBOARD_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    scannerSide: TARGET_SCANNER_SIDE,
    actualScannerSide: TARGET_SCANNER_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    dashboardSide: TARGET_DASHBOARD_SIDE,

    longOnly: true,
    shortDisabled: true,
    disableShort: true,

    shortOnly: false,
    longDisabled: false,

    virtualOnly: true,
    virtualLearning: true,
    virtualLearningForced: true,
    virtualTracked: true,
    source: 'VIRTUAL',
    outcomeSource: 'VIRTUAL',

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,
    realOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    noExchangeOrders: true,
    noRealOrders: true,

    learningOnly: true,
    microFamilyLearning: true,

    observationFirst: true,
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintOnlyMetadata: true,
    scannerFingerprintsHiddenFromLearning: true,
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,

    executionFingerprintRole: 'METADATA_ONLY',
    executionFingerprintOnlyMetadata: true,
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    exactTrueMicroFamilyRequired: true,
    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    fixedTaxonomyPreferred: true,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    symbolExcludedFromFamilyId: true,
    selectionGranularity: 'EXACT_75_CHILD',

    allowLearningWithoutActiveRotation: true,
    ignoreMaxOpenPositionsForLearning: true,
    ignoreGlobalMaxOpenPositions: true,
    ignoreRiskCapsForLearning: true,
    oneOpenPositionPerSymbol: true,
    maxOneOpenPositionPerSymbol: true,

    positionTimeStopMin: getPositionTimeStopMin(),

    longRiskShape: {
      entryPositive: true,
      slBelowEntry: true,
      tpAboveEntry: true,
      expression: 'sl < entry < tp'
    },

    longExitRules: {
      validRiskShape: 'entry > 0 && sl < entry && tp > entry',
      tp: 'currentPrice >= tp',
      sl: 'currentPrice <= sl',
      timeStop: `age >= ${getPositionTimeStopMin()} minutes`,
      tpSlIndependentFromTimeStop: true,
      grossR: '(exitPrice - entry) / (entry - initialSl)',
      currentR: '(currentPrice - entry) / (entry - initialSl)',
      outcomeSource: 'VIRTUAL'
    },

    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForManualSelection: true,
    discordOnlyForExactTrueMicroMatch: true,
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    manualSelectionRequires75ChildTrueMicroFamilyId: true,
    macroMatchDoesNotTriggerDiscord: true,
    parentMacroMatchDoesNotTriggerDiscord: true,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    runScope: RUN_SCOPE,
    writeScope: WRITE_SCOPE,
    readScope: READ_SCOPE,

    namespace: LONG_NAMESPACE,
    keyPrefix: LONG_KEY_PREFIX,
    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    weekKey: PERSISTENT_LEARNING_KEY,

    keys: {
      scannerLatest: LONG_KEYS.scan.latest,
      tradeLock: LONG_KEYS.trade.lock,
      tradeRunMeta: LONG_KEYS.trade.runMeta,
      tradeLastProcessedSnapshot: LONG_KEYS.trade.lastProcessedSnapshot
    },

    scannerRunAllowed: false,
    scannerRunDisabledInsideTradeRun: true,
    preventScannerRun: true,
    doNotRunScanner: true,
    noScannerRun: true,
    noScannerRefresh: true,

    scannerLatestReadOnly: true,
    readScannerLatestOnly: true,
    preserveScannerLatest: true,
    preserveScannerSnapshot: true,
    preserveScannerHistory: true,

    writeScannerLatest: false,
    writeScannerSnapshot: false,
    writeScannerHistory: false,

    allowTradeWrite: true,
    allowAnalyzePartialWrite: true,
    allowScannerWrite: false,
    allowRotationWrite: false,
    allowDiscordSelectionWrite: false,

    analyzePartialOnly: true,
    microFamiliesAppendOnly: true,
    analyzeFullOverwriteDisabled: true,
    microFamiliesAntiWipe: true,

    preserveRotation: true,
    preserveManualSelection: true,
    preserveDiscordSelection: true,

    adminPageIsolation: true,
    doesNotOverwriteOtherAdminPages: true
  };
}

async function persistLongRunMeta(redis, payload = {}, result = {}) {
  if (!payload || typeof payload !== 'object') {
    return {
      persistedLongRunMeta: false,
      persistedLongLastProcessedSnapshot: false,
      reason: 'NO_PAYLOAD'
    };
  }

  const runMeta = {
    ...payload,

    ...baseFlags(),

    persistedAt: now(),
    persistedBy: 'api/trade/run.js',
    persistedNamespace: LONG_NAMESPACE,

    longKeys: {
      namespace: LONG_NAMESPACE,
      prefix: LONG_KEY_PREFIX,
      tradeRunMeta: LONG_KEYS.trade.runMeta,
      tradeLastProcessedSnapshot: LONG_KEYS.trade.lastProcessedSnapshot,
      scannerLatest: LONG_KEYS.scan.latest
    },

    rawResultOk: result?.ok !== false
  };

  await setJson(redis, LONG_KEYS.trade.runMeta, runMeta).catch(() => null);

  if (payload.snapshotId) {
    await setJson(
      redis,
      LONG_KEYS.trade.lastProcessedSnapshot,
      {
        snapshotId: payload.snapshotId,
        runId: payload.runId || null,
        processedAt: now(),
        ...baseFlags()
      }
    ).catch(() => null);
  }

  return {
    persistedLongRunMeta: true,
    persistedLongLastProcessedSnapshot: Boolean(payload.snapshotId),
    tradeRunMeta: LONG_KEYS.trade.runMeta,
    tradeLastProcessedSnapshot: LONG_KEYS.trade.lastProcessedSnapshot
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Trade-Target-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Dashboard-Side', TARGET_DASHBOARD_SIDE);
  res.setHeader('X-Long-Only', 'true');
  res.setHeader('X-Short-Disabled', 'true');
  res.setHeader('X-Virtual-Only', 'true');
  res.setHeader('X-Virtual-Learning-Forced', 'true');
  res.setHeader('X-Exchange-Orders-Disabled', 'true');
  res.setHeader('X-Bitget-Orders-Disabled', 'true');
  res.setHeader('X-No-Real-Orders', 'true');
  res.setHeader('X-Scanner-Fingerprint-Role', 'METADATA_ONLY');
  res.setHeader('X-Execution-Fingerprint-Role', 'METADATA_ONLY');
  res.setHeader('X-Learning-Identity-Source', 'ANALYZE_TRUE_MICRO_FAMILY');
  res.setHeader('X-Exact-True-Micro-Match', 'true');
  res.setHeader('X-True-Micro-Family-Schema', TRUE_MICRO_SCHEMA);
  res.setHeader('X-Parent-True-Micro-Family-Schema', PARENT_TRUE_MICRO_SCHEMA);
  res.setHeader('X-Learning-Granularity', LEARNING_GRANULARITY);
  res.setHeader('X-Parent-Learning-Granularity', PARENT_LEARNING_GRANULARITY);
  res.setHeader('X-Manual-Selection-Match-Mode', 'EXACT_TRUE_MICRO_FAMILY_ID');
  res.setHeader('X-Run-Scope', RUN_SCOPE);
  res.setHeader('X-Write-Scope', WRITE_SCOPE);
  res.setHeader('X-Scanner-Write', 'false');
  res.setHeader('X-Scanner-Run-Allowed', 'false');
  res.setHeader('X-Preserve-Scanner-Latest', 'true');
  res.setHeader('X-MicroFamilies-Append-Only', 'true');
  res.setHeader('X-Admin-Page-Isolation', 'true');
  res.setHeader('X-Persistent-Learning-Key', PERSISTENT_LEARNING_KEY);
  res.setHeader('X-Redis-Namespace', LONG_NAMESPACE);
  res.setHeader('X-Short-Root-Touched', 'false');

  const startedAt = now();

  try {
    if (!isAllowedMethod(req.method)) {
      return methodNotAllowed(res);
    }

    const body = await readBody(req);
    const runOptions = buildRunOptions(req, body);

    const redis = getDurableRedis();
    const lockKey = LONG_KEYS.trade.lock;
    const lockTtlSec = getLockTtlSec();

    const rawResult = await withRedisLock(
      redis,
      lockKey,
      lockTtlSec,
      async () => runTradeSystem(runOptions)
    );

    const payload = sanitizeRunPayload(unwrapLockResult(rawResult));
    const result = sanitizeLockResult(rawResult);

    const persistence = await persistLongRunMeta(redis, payload, result);

    const actionCounts = responseActionCounts(rawResult);
    const counts = responseCounts(rawResult);

    return res.status(200).json({
      ok: responseOk(rawResult),
      skipped: responseSkipped(rawResult),
      reason: responseReason(rawResult),
      skipReason: payload?.skipReason || responseReason(rawResult),

      ...baseFlags(),

      runSource: getRunSource(req, body),

      force: runOptions.force,
      forceProcessSnapshot: runOptions.forceProcessSnapshot,
      monitorOnly: runOptions.monitorOnly,
      monitorOpenPositionsFirst: runOptions.monitorOpenPositionsFirst,
      monitorOpenPositions: runOptions.monitorOpenPositions,
      processScannerSnapshot: runOptions.processScannerSnapshot,

      runId: responseRunId(rawResult),
      snapshotId: responseSnapshotId(rawResult),

      entryRows: safeNumber(payload?.entryRows, 0),
      waitRows: safeNumber(payload?.waitRows, 0),
      virtualCreatedRows: safeNumber(payload?.virtualCreatedRows, 0),

      entryRowsList: Array.isArray(payload?.entryRowsList)
        ? payload.entryRowsList
        : [],

      waitRowsList: Array.isArray(payload?.waitRowsList)
        ? payload.waitRowsList
        : [],

      virtualCreatedRowsList: Array.isArray(payload?.virtualCreatedRowsList)
        ? payload.virtualCreatedRowsList
        : [],

      virtualExitRows: safeNumber(payload?.virtualExitRows, 0),
      shadowExitRows: safeNumber(payload?.shadowExitRows, 0),

      virtualExits: Array.isArray(payload?.virtualExits)
        ? payload.virtualExits
        : [],

      shadowExits: Array.isArray(payload?.shadowExits)
        ? payload.shadowExits
        : [],

      realExits: [],

      actionCounts,
      counts,

      activeRotationId: payload?.activeRotationId || null,
      selectedRotationId: payload?.selectedRotationId || payload?.activeRotationId || null,

      activeMicroFamilies: safeNumber(payload?.activeMicroFamilies, 0),
      activeMacroFamilies: safeNumber(payload?.activeMacroFamilies, 0),

      activeMicroFamilyIds: Array.isArray(payload?.activeMicroFamilyIds)
        ? payload.activeMicroFamilyIds
        : [],

      activeMacroFamilyIds: Array.isArray(payload?.activeMacroFamilyIds)
        ? payload.activeMacroFamilyIds
        : [],

      selectedMicroFamilyIds: Array.isArray(payload?.selectedMicroFamilyIds)
        ? payload.selectedMicroFamilyIds
        : [],

      selectedMacroFamilyIds: Array.isArray(payload?.selectedMacroFamilyIds)
        ? payload.selectedMacroFamilyIds
        : [],

      selectedSnapshotSource: payload?.selectedSnapshotSource || null,
      selectedSnapshotReason: payload?.selectedSnapshotReason || null,
      selectedTargetCandidateCount: safeNumber(payload?.selectedTargetCandidateCount, 0),
      selectedOppositeCandidateCount: 0,

      scannerLatestPreserved: true,
      scannerSnapshotPreserved: true,
      scannerHistoryPreserved: true,
      scannerRunBlockedInsideTradeRun: true,

      microFamiliesAppendOnly: true,
      analyzePartialOnly: true,
      analyzeFullOverwriteDisabled: true,

      rotationPreserved: true,
      manualSelectionPreserved: true,
      discordSelectionPreserved: true,

      longPersistence: persistence,

      longKeys: {
        namespace: LONG_NAMESPACE,
        prefix: LONG_KEY_PREFIX,
        scanLatest: LONG_KEYS.scan.latest,
        tradeLock: LONG_KEYS.trade.lock,
        tradeRunMeta: LONG_KEYS.trade.runMeta,
        tradeLastProcessedSnapshot: LONG_KEYS.trade.lastProcessedSnapshot
      },

      warnings: [
        payload?.ignoredShortActions > 0
          ? `SHORT_ACTIONS_IGNORED:${payload.ignoredShortActions}`
          : null,
        payload?.ignoredShortExitRows > 0
          ? `SHORT_EXIT_ROWS_IGNORED:${payload.ignoredShortExitRows}`
          : null,
        payload?.ignoredUnknownSideActions > 0
          ? `UNKNOWN_SIDE_ACTIONS_FORCED_LONG:${payload.ignoredUnknownSideActions}`
          : null,
        payload?.ignoredUnknownSideExitRows > 0
          ? `UNKNOWN_SIDE_EXIT_ROWS_FORCED_LONG:${payload.ignoredUnknownSideExitRows}`
          : null,
        payload?.scannerFingerprintActions > 0
          ? `SCANNER_FINGERPRINT_ACTIONS_METADATA_ONLY:${payload.scannerFingerprintActions}`
          : null,
        payload?.scannerFingerprintExitRows > 0
          ? `SCANNER_FINGERPRINT_EXITS_METADATA_ONLY:${payload.scannerFingerprintExitRows}`
          : null,
        payload?.executionFingerprintActions > 0
          ? `EXECUTION_FINGERPRINT_ACTIONS_METADATA_ONLY:${payload.executionFingerprintActions}`
          : null,
        payload?.executionFingerprintExitRows > 0
          ? `EXECUTION_FINGERPRINT_EXITS_METADATA_ONLY:${payload.executionFingerprintExitRows}`
          : null,
        (payload?.activeMicroFamilyIds || []).some((id) => !isSelectableTrueMicroId(id))
          ? 'NON_75_CHILD_ACTIVE_MICRO_IDS_REMOVED'
          : null
      ].filter(Boolean),

      durationMs: now() - startedAt,

      run: payload,
      result
    });
  } catch (error) {
    return res.status(resolveStatus(error)).json({
      ok: false,

      ...baseFlags(),

      error: error?.message || String(error),
      durationMs: now() - startedAt,
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}