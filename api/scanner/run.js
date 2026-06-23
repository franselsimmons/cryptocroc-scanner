// ================= FILE: api/scanner/run.js =================

import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import {
  getVolatileRedis,
  setJson
} from '../../src/redis.js';
import { withRedisLock } from '../../src/lock.js';
import { runScanner } from '../../src/market/scanner.js';
import { sideToTradeSide } from '../../src/utils.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const TARGET_SCANNER_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;

const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_V1';

const DEFAULT_LOCK_TTL_SEC = 540;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;
const MIN_COMPLETED_ACTIVE_LEARNING = 20;

const MAX_PERSISTED_CANDIDATES = 250;
const MAX_RESPONSE_CANDIDATES = 40;

const SCANNER_RUN_BUILD_ID = 'LONG_SCANNER_RUN_DEBUG_STACK_VISIBLE_2026_06_23_V1';

const LONG_SETUP_TYPES = [
  'BREAKOUT',
  'RETEST',
  'SWEEP_REVERSAL',
  'CONTINUATION',
  'COMPRESSION'
];

const LONG_REGIME_BUCKETS = [
  'TREND',
  'CHOP',
  'SQUEEZE'
];

const LONG_CONFIRMATION_PROFILES = [
  'A_STRONG_ALIGN',
  'B_FLOW_ALIGN',
  'C_VOLUME_ALIGN',
  'D_MIXED_OK',
  'E_WEAK_CONTRA'
];

function now() {
  return Date.now();
}

function namespacedLongKey(key, fallback = null) {
  const raw = String(key || fallback || '').trim();

  if (!raw) return null;
  if (raw.startsWith(LONG_KEY_PREFIX)) return raw;

  return `${LONG_KEY_PREFIX}${raw}`;
}

function callMaybe(fn, arg, fallback) {
  try {
    if (typeof fn === 'function') return fn(arg);
  } catch {
    return fallback;
  }

  return fallback;
}

const LONG_KEYS = {
  scan: {
    lock: namespacedLongKey(
      KEYS.long?.scan?.lock ||
        KEYS.scan?.longLock ||
        KEYS.scan?.lock,
      'SCAN:LOCK'
    ),

    latest: namespacedLongKey(
      KEYS.long?.scan?.latest ||
        KEYS.scan?.longLatest ||
        KEYS.scan?.latest,
      'SCAN:LATEST'
    ),

    snapshotPattern: namespacedLongKey(
      callMaybe(KEYS.long?.scan?.snapshot, '*', null) ||
        callMaybe(KEYS.scan?.longSnapshot, '*', null) ||
        callMaybe(KEYS.scan?.snapshot, '*', null),
      'SCAN:SNAPSHOT:*'
    ),

    snapshot: (snapshotId) => namespacedLongKey(
      callMaybe(KEYS.long?.scan?.snapshot, snapshotId, null) ||
        callMaybe(KEYS.scan?.longSnapshot, snapshotId, null) ||
        callMaybe(KEYS.scan?.snapshot, snapshotId, null),
      `SCAN:SNAPSHOT:${snapshotId}`
    )
  }
};

function baseFlags() {
  return {
    scannerRunBuildId: SCANNER_RUN_BUILD_ID,

    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_SCANNER_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    scannerSide: TARGET_SCANNER_SIDE,
    actualScannerSide: TARGET_SCANNER_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    scannerOnly: true,
    scannerDecidesTrade: false,
    scannerDoesNotTrade: true,
    scannerDoesNotOpenPositions: true,
    scannerDoesNotSelectMicroFamilies: true,
    scannerDoesNotSendDiscord: true,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,
    scannerHashesMetadataOnly: true,
    coinNameMetadataOnly: true,

    noTradeExecution: true,
    noMicroFamilySelection: true,
    noDiscord: true,

    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,

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
    observationFirstAnalyze: true,
    netOutcomesOnly: true,
    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    globalMaxOpenPositionsBlockDisabled: true,
    maxOneOpenPositionPerSymbol: true,
    positionTimeStopMinDefault: DEFAULT_POSITION_TIME_STOP_MIN,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    scannerIsNotLearningIdentitySource: true,
    scannerIdentitySource: 'SCANNER_METADATA_ONLY',
    symbolExcludedFromFamilyId: true,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    exactTrueMicroFamilyRequired: true,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    selectableMicroFamilyCount: 75,
    parentMicroFamilyCount: 15,
    taxonomySetups: LONG_SETUP_TYPES,
    taxonomyRegimes: LONG_REGIME_BUCKETS,
    taxonomyConfirmationProfiles: LONG_CONFIRMATION_PROFILES,

    parentTrueMicroFamilyExample: 'MICRO_LONG_BREAKOUT_TREND',
    selectableTrueMicroFamilyExample: 'MICRO_LONG_BREAKOUT_TREND_A_STRONG_ALIGN',

    bucketsCoarseOnly: true,
    bucketGranularity: 'LOW_MID_HIGH',

    manualSelectionOnly: true,
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    manualSelectionRequires75ChildTrueMicroFamilyId: true,
    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForExactTrueMicroMatch: true,
    discordMatchSource: 'MANUAL_SELECTED_75_CHILD_TRUE_MICRO_FAMILY_ID',

    autoRotationActivationDisabled: true,
    activateFreezeCronDisabled: true,
    resetCronDisabled: true,

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

function getLockTtlSec() {
  const ttl = Number(
    CONFIG.long?.scanner?.lockTtlSec ||
      CONFIG.scanner?.longLockTtlSec ||
      CONFIG.scanner?.lockTtlSec ||
      DEFAULT_LOCK_TTL_SEC
  );

  if (!Number.isFinite(ttl)) return DEFAULT_LOCK_TTL_SEC;
  if (ttl <= 0) return DEFAULT_LOCK_TTL_SEC;

  return Math.floor(ttl);
}

function shouldForce(req, body = {}) {
  return (
    isTrue(firstValue(req.query?.force, false)) ||
    isTrue(firstValue(req.query?.forced, false)) ||
    isTrue(body.force) ||
    isTrue(body.forced)
  );
}

function sourceLabel(req, body = {}) {
  const manual = (
    isTrue(firstValue(req.query?.manual, false)) ||
    isTrue(firstValue(req.query?.force, false)) ||
    isTrue(firstValue(req.query?.forced, false)) ||
    isTrue(body.manual) ||
    isTrue(body.force) ||
    isTrue(body.forced)
  );

  return manual
    ? 'ADMIN_MANUAL_LONG_SCANNER_RUN'
    : 'CRON_OR_API_LONG_SCANNER_RUN';
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function cleanSideText(value = '') {
  return upper(value)
    .replaceAll('SHORT_DISABLED', '')
    .replaceAll('SHORTDISABLED', '')
    .replaceAll('BLOCK_SHORT', '')
    .replaceAll('SHORT_ENABLED_FALSE', '')
    .replaceAll('SHORT_ONLY_FALSE', '')
    .replaceAll('LONG_DISABLED_FALSE', '')
    .replaceAll('LONG_ENABLED_FALSE', '')
    .replaceAll('LONG_ONLY_FALSE', '')
    .replaceAll('LONG_ONLY_MODE', 'LONG')
    .replaceAll('LONG_ONLY', 'LONG')
    .replaceAll('LONG-ONLY', 'LONG');
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);

  if (!Number.isFinite(n)) return fallback;

  return n;
}

function countOf(value, fallback = 0) {
  if (Array.isArray(value)) return value.length;

  const n = Number(value);
  if (Number.isFinite(n)) return n;

  return fallback;
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

  return 'UNKNOWN';
}

function hasShortSignal(value = '') {
  const text = ` ${cleanSideText(value)} `;

  return (
    text.includes('MICRO_SHORT_') ||
    text.includes('TRADESIDE=SHORT') ||
    text.includes('TRADE_SIDE=SHORT') ||
    text.includes('POSITION_SIDE=SHORT') ||
    text.includes('POSITIONSIDE=SHORT') ||
    text.includes('SIDE=SHORT') ||
    text.includes('SIDE=BEAR') ||
    text.includes('SIDE=SELL') ||
    text.includes('DIRECTION=SHORT') ||
    text.includes('DIRECTION=BEAR') ||
    text.includes('DIRECTION=SELL') ||
    text.includes(' SHORT_') ||
    text.includes('_SHORT ') ||
    text.includes('_SHORT_') ||
    text.includes('|SHORT|') ||
    text.includes(':SHORT') ||
    text.includes('=SHORT') ||
    text.includes(' BEAR ') ||
    text.includes('_BEAR') ||
    text.includes('BEAR_') ||
    text.includes('|BEAR|') ||
    text.includes(':BEAR') ||
    text.includes('=BEAR') ||
    text.includes(' SELL ') ||
    text.includes('_SELL') ||
    text.includes('SELL_') ||
    text.includes('|SELL|') ||
    text.includes(':SELL') ||
    text.includes('=SELL')
  );
}

function hasLongSignal(value = '') {
  const text = ` ${cleanSideText(value)} `;

  return (
    text.includes('MICRO_LONG_') ||
    text.includes('TRADESIDE=LONG') ||
    text.includes('TRADE_SIDE=LONG') ||
    text.includes('POSITION_SIDE=LONG') ||
    text.includes('POSITIONSIDE=LONG') ||
    text.includes('SIDE=LONG') ||
    text.includes('SIDE=BULL') ||
    text.includes('SIDE=BUY') ||
    text.includes('DIRECTION=LONG') ||
    text.includes('DIRECTION=BULL') ||
    text.includes('DIRECTION=BUY') ||
    text.includes(' LONG_') ||
    text.includes('_LONG ') ||
    text.includes('_LONG_') ||
    text.includes('|LONG|') ||
    text.includes(':LONG') ||
    text.includes('=LONG') ||
    text.includes(' BULL ') ||
    text.includes('_BULL') ||
    text.includes('BULL_') ||
    text.includes('|BULL|') ||
    text.includes(':BULL') ||
    text.includes('=BULL') ||
    text.includes(' BUY ') ||
    text.includes('_BUY') ||
    text.includes('BUY_') ||
    text.includes('|BUY|') ||
    text.includes(':BUY') ||
    text.includes('=BUY')
  );
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

function moveMetricValues(row = {}) {
  return [
    row.change1m,
    row.change3m,
    row.change5m,
    row.change15m,
    row.change30m,
    row.change1h,
    row.change2h,
    row.change4h,
    row.change24h,

    row.priceChange1m,
    row.priceChange3m,
    row.priceChange5m,
    row.priceChange15m,
    row.priceChange30m,
    row.priceChange1h,
    row.priceChange2h,
    row.priceChange4h,
    row.priceChange24h,

    row.priceChange1mPct,
    row.priceChange3mPct,
    row.priceChange5mPct,
    row.priceChange15mPct,
    row.priceChange30mPct,
    row.priceChange1hPct,
    row.priceChange2hPct,
    row.priceChange4hPct,
    row.priceChange24hPct,

    row.percentChange,
    row.changePct,
    row.movePct,
    row.pctMove,
    row.scoreMovePct
  ]
    .map((value) => Number(value))
    .filter(Number.isFinite);
}

function hasBullishMove(row = {}) {
  const values = moveMetricValues(row);

  if (!values.length) return false;

  return values.some((value) => value > 0);
}

function hasOnlyBearishMove(row = {}) {
  const values = moveMetricValues(row);

  if (!values.length) return false;

  return values.every((value) => value < 0);
}

function rowSide(row = {}) {
  if (typeof row === 'string') return inferTradeSideFromText(row);

  if (!row || typeof row !== 'object') return 'UNKNOWN';

  const direct = normalizeTradeSide(
    row.tradeSide ||
    row.positionSide ||
    row.direction ||
    row.scannerSide ||
    row.actualScannerSide ||
    row.analysisSide ||
    row.signalSide ||
    row.entrySide ||
    row.side ||
    row.bias ||
    row.marketBias
  );

  if (direct !== 'UNKNOWN') return direct;

  const reasonSide = inferTradeSideFromText(
    row.scannerReason ||
    row.reason ||
    row.signalReason ||
    row.actionReason ||
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
    row.parentTrueMicroFamilyId,
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
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join('|');

  const textSide = inferTradeSideFromText(haystack);

  if (textSide !== 'UNKNOWN') return textSide;

  if (row.longOnly === true || row.shortDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  if (row.shortOnly === true || row.longDisabled === true) {
    return OPPOSITE_TRADE_SIDE;
  }

  if (hasBullishMove(row)) return TARGET_TRADE_SIDE;
  if (hasOnlyBearishMove(row)) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function isLongCandidate(row = {}) {
  return rowSide(row) === TARGET_TRADE_SIDE;
}

function isShortCandidate(row = {}) {
  return rowSide(row) === OPPOSITE_TRADE_SIDE;
}

function normalizeSymbol(value = '') {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/_?USDT$/i, '');
}

function normalizeContractSymbol(value = '') {
  const raw = String(value || '').trim().toUpperCase();

  if (!raw) return '';

  if (raw.endsWith('USDT')) return raw;

  return `${normalizeSymbol(raw)}USDT`;
}

function normalizeScannerMetadata(candidate = {}) {
  return {
    scannerMicroFamilyId:
      candidate.scannerMicroFamilyId ||
      candidate.scannerFamilyId ||
      candidate.scannerBucket ||
      candidate.bucket ||
      null,

    scannerFamilyId:
      candidate.scannerFamilyId ||
      candidate.scannerMicroFamilyId ||
      candidate.scannerBucket ||
      candidate.bucket ||
      null,

    scannerBucket: candidate.scannerBucket || candidate.bucket || null,
    scannerBucket25: candidate.scannerBucket25 || candidate.legacyBucket25 || null,
    scannerReason: candidate.scannerReason || candidate.reason || 'LONG_SCANNER_CANDIDATE',
    scannerReasonCoarse: candidate.scannerReasonCoarse || null,
    scannerDefinition: candidate.scannerDefinition || null,
    scannerDefinitionParts: Array.isArray(candidate.scannerDefinitionParts)
      ? candidate.scannerDefinitionParts
      : [],

    scannerFingerprintHash: candidate.scannerFingerprintHash || candidate.fingerprintHash || null,
    scannerFingerprintParts: Array.isArray(candidate.scannerFingerprintParts)
      ? candidate.scannerFingerprintParts
      : [],

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,

    analyzeTrueMicroFamilyId: null,
    trueMicroFamilyId: null,
    parentTrueMicroFamilyId: null,
    childTrueMicroFamilyId: null,
    microFamilyId: null,
    learningMicroFamilyId: null,

    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    scannerIsLearningIdentitySource: false,
    scannerDoesNotSelectMicroFamilies: true
  };
}

function normalizeLongCandidate(candidate = {}) {
  const symbol = normalizeSymbol(
    candidate.symbol ||
    candidate.baseSymbol ||
    candidate.contractSymbol ||
    candidate.instId ||
    candidate.instrumentId
  );

  const contractSymbol = normalizeContractSymbol(
    candidate.contractSymbol ||
    candidate.symbol ||
    candidate.instId ||
    candidate.instrumentId ||
    symbol
  );

  const createdAt = safeNumber(
    candidate.createdAt ||
      candidate.ts ||
      candidate.scannerTs ||
      Date.now(),
    Date.now()
  );

  return {
    ...candidate,

    symbol,
    baseSymbol: symbol,
    contractSymbol,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    scannerSide: TARGET_SCANNER_SIDE,
    actualScannerSide: TARGET_SCANNER_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    directionalSide: TARGET_DASHBOARD_SIDE,
    inferredDirectionalSide: TARGET_DASHBOARD_SIDE,
    marketSide: TARGET_DASHBOARD_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_SCANNER_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    scannerOnly: true,
    scannerDecidesTrade: false,
    scannerDoesNotTrade: true,
    scannerDoesNotOpenPositions: true,
    scannerDoesNotSelectMicroFamilies: true,
    scannerDoesNotSendDiscord: true,

    noTradeExecution: true,
    noMicroFamilySelection: true,
    noDiscord: true,

    ...normalizeScannerMetadata(candidate),

    scannerScore: safeNumber(candidate.scannerScore ?? candidate.moveScore, 0),
    moveScore: safeNumber(candidate.moveScore ?? candidate.scannerScore, 0),

    change1h: safeNumber(candidate.change1h ?? candidate.priceChange1hPct, 0),
    change24h: safeNumber(candidate.change24h ?? candidate.priceChange24hPct, 0),
    volume24h: safeNumber(candidate.volume24h ?? candidate.quoteVolume24h ?? candidate.quoteVolume, 0),

    btcState: candidate.btcState || null,
    regime: candidate.regime || null,

    fakeBreakout: Boolean(candidate.fakeBreakout),
    fakeBreakoutRisk: Boolean(candidate.fakeBreakoutRisk),

    createdAt,

    isMirrorMicroFamily: false,
    observationMirror: false,
    analysisMirror: false,
    mirrorAnalysisOnly: false
  };
}

function scannerGatePassed(row = {}) {
  if (row.scannerGatePassed === undefined || row.scannerGatePassed === null) {
    return false;
  }

  return Boolean(row.scannerGatePassed);
}

function isAnalyzeOnly(row = {}) {
  return Boolean(
    row.tradeDiscoveryOnly ||
    row.discoveryOnly ||
    row.analyzeOnly ||
    !scannerGatePassed(row)
  );
}

function unwrapPayload(result) {
  if (!result) return null;

  if (result.result?.result?.result?.candidates) return result.result.result.result;
  if (result.result?.result?.candidates) return result.result.result;
  if (result.result?.candidates) return result.result;
  if (result.candidates) return result;

  if (result.result?.result?.result) return result.result.result.result;
  if (result.result?.result) return result.result;
  if (result.result) return result.result;

  return result;
}

function normalizePayload(payload = {}) {
  if (!payload || typeof payload !== 'object') {
    return {
      ok: false,
      reason: 'EMPTY_SCANNER_PAYLOAD',
      ...baseFlags(),
      candidates: [],
      candidatesCount: 0,
      longCandidatesCount: 0,
      shortCandidatesCount: 0,
      rawCandidatesCount: 0,
      rawShortCandidatesIgnored: 0,
      rawUnknownSideCandidatesIgnored: 0
    };
  }

  const rawCandidates = Array.isArray(payload.candidates)
    ? payload.candidates
    : [];

  const candidates = rawCandidates
    .filter(isLongCandidate)
    .map(normalizeLongCandidate)
    .filter((candidate) => candidate.symbol && candidate.contractSymbol);

  const scannerGateCandidates = candidates.filter(scannerGatePassed);
  const analyzeOnlyCandidates = candidates.filter(isAnalyzeOnly);

  const rawShortCandidatesIgnored = rawCandidates.filter(isShortCandidate).length;
  const rawUnknownSideCandidatesIgnored = rawCandidates.filter((row) => rowSide(row) === 'UNKNOWN').length;

  const analyze = payload.analyze && typeof payload.analyze === 'object'
    ? {
      ...payload.analyze,
      ...baseFlags(),
      scannerOutputOnly: true,
      scannerDoesNotWriteLearning: true,
      analyzeMustAssignTrueMicroFamily: true
    }
    : payload.analyze || null;

  return {
    ...payload,
    ...baseFlags(),

    sideMode: 'LONG_ONLY',
    payloadRole: 'LONG_SCANNER_DISCOVERY_ONLY',

    candidates,
    candidatesCount: candidates.length,

    longCandidatesCount: candidates.length,
    shortCandidatesCount: 0,

    scannerGateCandidatesCount: scannerGateCandidates.length,
    analyzeOnlyCandidatesCount: analyzeOnlyCandidates.length,

    rawCandidatesCount: countOf(payload.rawCandidatesCount, rawCandidates.length),
    rawShortCandidatesIgnored,
    rawUnknownSideCandidatesIgnored,

    bullCandidates: candidates.length,
    bearCandidates: 0,

    topSymbols: candidates
      .slice(0, 20)
      .map((candidate) => candidate.symbol)
      .filter(Boolean),

    scannerGateSymbols: scannerGateCandidates
      .slice(0, 20)
      .map((candidate) => candidate.symbol)
      .filter(Boolean),

    analyzeOnlySymbols: analyzeOnlyCandidates
      .slice(0, 20)
      .map((candidate) => candidate.symbol)
      .filter(Boolean),

    analyze
  };
}

function compactAnalyze(analyze = null) {
  if (!analyze || typeof analyze !== 'object') return null;

  return {
    ok: analyze.ok ?? null,
    skipped: Boolean(analyze.skipped || false),
    reason: analyze.reason || analyze.skipReason || null,

    rows: countOf(analyze.rows, countOf(analyze.microRows, 0)),
    microRows: countOf(analyze.microRows, 0),
    families: countOf(analyze.families, countOf(analyze.microFamilies, 0)),
    exact75Rows: countOf(analyze.exact75Rows, countOf(analyze.trueMicroRows, 0)),

    scannerOutputOnly: true,
    scannerDoesNotWriteLearning: true,
    analyzeMustAssignTrueMicroFamily: true,

    omitted: {
      fullAnalyzeRows: true,
      fullMicroRows: true,
      fullFamilyObjects: true,
      verboseDebugFields: true,
      reason: 'COMPACT_ANALYZE_TO_PREVENT_SCANNER_500'
    },

    ...baseFlags()
  };
}

function compactCandidate(candidate = {}) {
  const row = normalizeLongCandidate(candidate);

  return {
    symbol: row.symbol,
    baseSymbol: row.baseSymbol,
    contractSymbol: row.contractSymbol,

    side: TARGET_TRADE_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    dashboardSide: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,
    actualScannerSide: TARGET_SCANNER_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    price: safeNumber(
      row.price ??
        row.lastPrice ??
        row.markPrice ??
        row.close ??
        row.currentPrice,
      0
    ),

    scannerScore: safeNumber(row.scannerScore ?? row.moveScore, 0),
    moveScore: safeNumber(row.moveScore ?? row.scannerScore, 0),

    change1h: safeNumber(row.change1h ?? row.priceChange1hPct, 0),
    change24h: safeNumber(row.change24h ?? row.priceChange24hPct, 0),
    volume24h: safeNumber(row.volume24h ?? row.quoteVolume24h ?? row.quoteVolume, 0),

    scannerGatePassed: scannerGatePassed(row),
    analyzeOnly: isAnalyzeOnly(row),

    regime: row.regime || null,
    btcState: row.btcState || null,

    reason: row.scannerReason || row.reason || 'LONG_SCANNER_CANDIDATE',
    role: 'SCANNER_METADATA_ONLY',

    scannerMicroFamilyId: row.scannerMicroFamilyId || null,
    scannerFamilyId: row.scannerFamilyId || null,
    scannerBucket: row.scannerBucket || null,
    scannerBucket25: row.scannerBucket25 || null,
    scannerReason: row.scannerReason || row.reason || 'LONG_SCANNER_CANDIDATE',

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,

    trueMicroFamilyId: null,
    parentTrueMicroFamilyId: null,
    childTrueMicroFamilyId: null,
    microFamilyId: null,
    learningMicroFamilyId: null,

    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    scannerIsLearningIdentitySource: false,
    scannerDoesNotSelectMicroFamilies: true,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    noTradeExecution: true,
    noDiscord: true,
    noMicroFamilySelection: true,

    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,

    createdAt: safeNumber(row.createdAt, now())
  };
}

function compactScannerPayload(payload = {}, candidateLimit = MAX_PERSISTED_CANDIDATES) {
  const rawCandidates = Array.isArray(payload.candidates)
    ? payload.candidates
    : [];

  const candidates = rawCandidates
    .filter(isLongCandidate)
    .slice(0, candidateLimit)
    .map(compactCandidate)
    .filter((row) => row.symbol && row.contractSymbol);

  const scannerGateCandidates = candidates.filter((row) => row.scannerGatePassed);
  const analyzeOnlyCandidates = candidates.filter((row) => row.analyzeOnly);

  const snapshotId =
    payload.snapshotId ||
    payload.id ||
    payload.scanId ||
    `scan_long_${now()}_${Math.random().toString(16).slice(2, 10)}`;

  const createdAt = safeNumber(
    payload.createdAt ||
      payload.generatedAt ||
      payload.startedAt ||
      payload.ts ||
      now(),
    now()
  );

  return {
    ok: payload.ok !== false,
    skipped: Boolean(payload.skipped || false),
    reason: payload.reason || payload.skipReason || null,

    version: 'LONG_SCANNER_COMPACT_PAYLOAD_V2',
    sideMode: 'LONG_ONLY',
    payloadRole: 'LONG_SCANNER_DISCOVERY_ONLY',

    snapshotId,
    createdAt,
    generatedAt: safeNumber(payload.generatedAt, createdAt),
    completedAt: safeNumber(payload.completedAt, now()),
    updatedAt: now(),

    ...baseFlags(),

    candidates,
    candidatesCount: candidates.length,

    longCandidatesCount: candidates.length,
    shortCandidatesCount: 0,

    scannerGateCandidatesCount: scannerGateCandidates.length,
    analyzeOnlyCandidatesCount: analyzeOnlyCandidates.length,

    rawCandidatesCount: countOf(payload.rawCandidatesCount, rawCandidates.length),
    rawShortCandidatesIgnored: countOf(payload.rawShortCandidatesIgnored, 0),
    rawUnknownSideCandidatesIgnored: countOf(payload.rawUnknownSideCandidatesIgnored, 0),

    filteredUniverse: countOf(
      payload.filteredUniverse,
      countOf(payload.filteredUniverseCount, 0)
    ),

    rawUniverse: countOf(
      payload.rawUniverse,
      countOf(payload.rawUniverseCount, countOf(payload.rawCount, 0))
    ),

    bullCandidates: candidates.length,
    bearCandidates: 0,

    topSymbols: candidates
      .slice(0, 20)
      .map((candidate) => candidate.symbol)
      .filter(Boolean),

    scannerGateSymbols: scannerGateCandidates
      .slice(0, 20)
      .map((candidate) => candidate.symbol)
      .filter(Boolean),

    analyzeOnlySymbols: analyzeOnlyCandidates
      .slice(0, 20)
      .map((candidate) => candidate.symbol)
      .filter(Boolean),

    analyze: compactAnalyze(payload.analyze),

    compactedForRedis: true,
    compactedAt: now(),

    omitted: {
      fullRawResult: true,
      fullAnalyzeRows: true,
      fullUniverseRows: true,
      rawBreadthObjects: true,
      verboseDebugFields: true,
      candidateLimit,
      originalCandidateCount: rawCandidates.length,
      reason: 'COMPACT_LONG_SCANNER_PAYLOAD_TO_PREVENT_500'
    }
  };
}

function compactScannerResponse(payload = {}) {
  return compactScannerPayload(payload, MAX_RESPONSE_CANDIDATES);
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

function buildScannerOptions(req, body = {}) {
  const force = shouldForce(req, body);

  return {
    force,
    forced: force,

    compact: true,
    compactForApi: true,
    compactForRedis: true,
    omitRawUniverseRows: true,
    omitFullAnalyzeRows: true,
    omitVerboseDebugFields: true,
    maxCandidatesForResponse: MAX_RESPONSE_CANDIDATES,
    maxCandidatesForPersistence: MAX_PERSISTED_CANDIDATES,

    targetTradeSide: TARGET_TRADE_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    side: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,
    actualScannerSide: TARGET_SCANNER_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,
    disableShort: true,

    shortOnly: false,
    longDisabled: false,

    scannerOnly: true,
    scannerDecidesTrade: false,
    scannerDoesNotTrade: true,
    scannerDoesNotOpenPositions: true,
    scannerDoesNotSelectMicroFamilies: true,
    scannerDoesNotSendDiscord: true,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,
    scannerHashesMetadataOnly: true,
    coinNameMetadataOnly: true,

    noTradeExecution: true,
    noDiscord: true,
    noMicroFamilySelection: true,

    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,

    virtualLearning: true,
    virtualLearningForced: true,
    virtualOnly: true,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    scannerIsNotLearningIdentitySource: true,
    symbolExcludedFromFamilyId: true,

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    namespace: LONG_NAMESPACE,
    keyPrefix: LONG_KEY_PREFIX,
    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,

    keys: {
      scanLock: LONG_KEYS.scan.lock,
      scanLatest: LONG_KEYS.scan.latest,
      scanSnapshotPattern: LONG_KEYS.scan.snapshotPattern
    }
  };
}

async function persistLongScannerPayload(redis, payload = {}) {
  const latestPayload = compactScannerPayload(payload, MAX_PERSISTED_CANDIDATES);
  const snapshotId = latestPayload.snapshotId;

  const persisted = {
    latest: false,
    snapshot: false,
    latestError: null,
    snapshotError: null
  };

  try {
    await setJson(redis, LONG_KEYS.scan.latest, latestPayload);
    persisted.latest = true;
  } catch (error) {
    persisted.latestError = error?.message || String(error);
  }

  if (snapshotId) {
    try {
      await setJson(redis, LONG_KEYS.scan.snapshot(snapshotId), latestPayload);
      persisted.snapshot = true;
    } catch (error) {
      persisted.snapshotError = error?.message || String(error);
    }
  }

  return {
    persistedLongLatest: persisted.latest,
    persistedLongSnapshot: persisted.snapshot,

    scanLatest: LONG_KEYS.scan.latest,
    snapshotKey: snapshotId ? LONG_KEYS.scan.snapshot(snapshotId) : null,

    errors: {
      latest: persisted.latestError,
      snapshot: persisted.snapshotError
    },

    compactedForRedis: true,
    fullPayloadNotPersisted: true
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Scanner-Run-Build-Id', SCANNER_RUN_BUILD_ID);
  res.setHeader('X-Scanner-Target-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Dashboard-Side', TARGET_DASHBOARD_SIDE);
  res.setHeader('X-Long-Only', 'true');
  res.setHeader('X-Short-Disabled', 'true');
  res.setHeader('X-Scanner-Only', 'true');
  res.setHeader('X-No-Trade-Execution', 'true');
  res.setHeader('X-No-Discord', 'true');
  res.setHeader('X-No-Micro-Family-Selection', 'true');
  res.setHeader('X-Scanner-Fingerprints-Metadata-Only', 'true');
  res.setHeader('X-Scanner-Fingerprints-Used-As-Learning-Family', 'false');
  res.setHeader('X-Learning-Identity-Source', 'ANALYZE_TRUE_MICRO_FAMILY');
  res.setHeader('X-True-Micro-Family-Schema', TRUE_MICRO_SCHEMA);
  res.setHeader('X-Parent-True-Micro-Family-Schema', PARENT_TRUE_MICRO_SCHEMA);
  res.setHeader('X-Learning-Granularity', LEARNING_GRANULARITY);
  res.setHeader('X-Real-Orders-Disabled', 'true');
  res.setHeader('X-Bitget-Orders-Disabled', 'true');
  res.setHeader('X-Exchange-Calls-Disabled', 'true');
  res.setHeader('X-Virtual-Learning-Forced', 'true');
  res.setHeader('X-Persistent-Learning-Key', PERSISTENT_LEARNING_KEY);
  res.setHeader('X-Redis-Namespace', LONG_NAMESPACE);
  res.setHeader('X-Short-Root-Touched', 'false');

  const startedAt = now();

  try {
    if (!isAllowedMethod(req.method)) {
      return methodNotAllowed(res);
    }

    const body = await readBody(req);
    const scannerOptions = buildScannerOptions(req, body);

    const redis = getVolatileRedis();
    const lockKey = LONG_KEYS.scan.lock;
    const lockTtlSec = getLockTtlSec();

    const rawResult = await withRedisLock(
      redis,
      lockKey,
      lockTtlSec,
      async () => runScanner(scannerOptions)
    );

    const payload = normalizePayload(unwrapPayload(rawResult));
    const responsePayload = compactScannerResponse(payload);

    const persistence = await persistLongScannerPayload(redis, payload);

    const ok = rawResult?.ok !== false && payload?.ok !== false;

    return res.status(200).json({
      ok,
      scannerRunBuildId: SCANNER_RUN_BUILD_ID,

      skipped: Boolean(rawResult?.skipped || payload?.skipped || false),
      reason: rawResult?.reason || payload?.reason || null,

      source: sourceLabel(req, body),

      ...baseFlags(),

      force: scannerOptions.force,

      persisted: payload?.persisted ?? rawResult?.persisted ?? null,
      longPersistence: persistence,

      snapshotId: responsePayload.snapshotId,
      createdAt: responsePayload.createdAt,
      generatedAt: responsePayload.generatedAt,
      completedAt: responsePayload.completedAt,
      updatedAt: responsePayload.updatedAt,

      candidatesCount: Number(responsePayload.candidatesCount || 0),
      longCandidatesCount: Number(responsePayload.longCandidatesCount || 0),
      shortCandidatesCount: 0,

      scannerGateCandidatesCount: Number(responsePayload.scannerGateCandidatesCount || 0),
      analyzeOnlyCandidatesCount: Number(responsePayload.analyzeOnlyCandidatesCount || 0),

      rawCandidatesCount: Number(responsePayload.rawCandidatesCount || 0),
      rawShortCandidatesIgnored: Number(responsePayload.rawShortCandidatesIgnored || 0),
      rawUnknownSideCandidatesIgnored: Number(responsePayload.rawUnknownSideCandidatesIgnored || 0),

      filteredUniverse: Number(responsePayload.filteredUniverse || 0),
      rawUniverse: Number(responsePayload.rawUniverse || 0),

      topSymbols: responsePayload.topSymbols || [],
      scannerGateSymbols: responsePayload.scannerGateSymbols || [],
      analyzeOnlySymbols: responsePayload.analyzeOnlySymbols || [],

      candidates: responsePayload.candidates || [],
      analyze: responsePayload.analyze || null,

      longKeys: {
        namespace: LONG_NAMESPACE,
        prefix: LONG_KEY_PREFIX,
        scanLock: LONG_KEYS.scan.lock,
        scanLatest: LONG_KEYS.scan.latest,
        scanSnapshotPattern: LONG_KEYS.scan.snapshotPattern,
        snapshotKey: responsePayload.snapshotId
          ? LONG_KEYS.scan.snapshot(responsePayload.snapshotId)
          : null
      },

      durationMs: now() - startedAt,

      resultSummary: {
        ok: rawResult?.ok !== false,
        skipped: Boolean(rawResult?.skipped || false),
        reason: rawResult?.reason || null,
        fullResultOmitted: true,
        compactedForResponse: true
      },

      debug: {
        stackVisible: false,
        source: 'api/scanner/run.js',
        buildId: SCANNER_RUN_BUILD_ID,
        normalResponse: true
      },

      omitted: {
        fullRawResult: true,
        fullAnalyzeRows: true,
        fullCandidatesArray: true,
        responseCandidateLimit: MAX_RESPONSE_CANDIDATES,
        persistedCandidateLimit: MAX_PERSISTED_CANDIDATES,
        reason: 'PREVENT_VERCEL_500_AND_REDIS_PAYLOAD_OVERFLOW'
      }
    });
  } catch (error) {
    const status = resolveStatus(error);

    if (status === 400 || status === 405 || status === 409) {
      return res.status(status).json({
        ok: false,
        scannerRunBuildId: SCANNER_RUN_BUILD_ID,
        ...baseFlags(),
        error: error?.message || String(error),
        name: error?.name || null,
        details: error?.details || null,
        stack: error?.stack || null,
        durationMs: now() - startedAt,
        debug: {
          stackVisible: true,
          source: 'api/scanner/run.js',
          buildId: SCANNER_RUN_BUILD_ID,
          reason: 'TEMP_DEBUG_CLIENT_OR_LOCK_ERROR'
        }
      });
    }

    return res.status(200).json({
      ok: false,
      recoveredHttpStatus: 500,
      scannerRunFailed: true,
      scannerRunBuildId: SCANNER_RUN_BUILD_ID,

      ...baseFlags(),

      error: error?.message || String(error),
      name: error?.name || null,
      details: error?.details || null,
      stack: error?.stack || null,

      durationMs: now() - startedAt,

      debug: {
        stackVisible: true,
        source: 'api/scanner/run.js',
        buildId: SCANNER_RUN_BUILD_ID,
        reason: 'TEMP_DEBUG_FIND_RES_MAP_SOURCE',
        instruction: 'Zoek in stack naar bestand en regel met res.map. Waarschijnlijk bitgetClient.js of utils.js.'
      },

      omitted: {
        stackHidden: false,
        reason: 'TEMP_DEBUG_STACK_VISIBLE_TO_FIND_RES_MAP_SOURCE'
      }
    });
  }
}