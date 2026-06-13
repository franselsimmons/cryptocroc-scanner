// ================= FILE: src/trade/tradeSystem.js =================

import { CONFIG } from '../config.js';
import {
  KEYS,
  assertKeyAllowedForWriteScope
} from '../keys.js';
import {
  getDurableRedis,
  getVolatileRedis,
  getJson,
  setJson,
  getKeys
} from '../redis.js';
import {
  mapConcurrent,
  normalizeBaseSymbol,
  normalizeContractSymbol,
  randomId,
  safeNumber,
  sideToTradeSide
} from '../utils.js';
import {
  fetchCandles,
  fetchFunding,
  fetchOrderBook,
  analyzeOrderBook
} from '../market/bitgetClient.js';
import {
  analyzeCandidatesBatch
} from '../analyze/analyzeEngine.js';
import { getActiveRotation } from '../analyze/rotationEngine.js';
import {
  buildRiskAndLiveMetricsForBothSides
} from './riskEngine.js';
import {
  buildOpenPositionFromEntry,
  getOpenPositions,
  getOpenPosition,
  saveOpenPosition,
  monitorOpenPositions
} from './positionEngine.js';
import {
  riskFractionForEntry
} from './positionSizing.js';
import { sendEntryAlert } from '../discord/discord.js';

const DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT = 1000;
const SNAPSHOT_SEARCH_LIMIT = 80;

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const TARGET_SCANNER_SIDE = 'bull';

const OPPOSITE_TRADE_SIDE = 'SHORT';

const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';

const RUN_SCOPE = 'TRADE_ONLY';
const WRITE_SCOPE = 'TRADE_AND_ANALYZE_PARTIAL_ONLY';
const READ_SCOPE = 'READ_SCANNER_LATEST_ONLY';

/*
  LONG kwaliteitsvariant:
  - geen synthetic shadow-laag standaard
  - geen kunstmatig completed-volume
  - wel iets soepeler maar nog betrouwbaar:
    - 30 -> 25 candles
    - risk range 0.40%-2.50% -> 0.35%-3.00%
  - echte Analyze trueMicroFamilyId verplicht
  - scanner fingerprint metadata-only
  - echte LONG risk shape verplicht
  - één open positie per symbol
*/
const ENTRY_RELAXATION_PROFILE = 'LONG_ENTRY_QUALITY_TINY_LOOSER_V1';
const QUALITY_MEASUREMENT_PROFILE = 'LONG_DISCIPLINED_QUALITY_AUDIT_V1';

const DEFAULT_MIN_LIVE_CANDLES_15M = 25;
const DEFAULT_MIN_RISK_PCT = 0.0035;
const DEFAULT_MAX_RISK_PCT = 0.03;
const DEFAULT_FALLBACK_RISK_PCT = 0.005;

const DEFAULT_ALLOW_SYNTHETIC_RISK_FALLBACK = false;
const DEFAULT_ALLOW_SYNTHETIC_RISK_VIRTUAL_ENTRIES = false;

const FREEZE_MEASUREMENT_RECOMMENDED_DAYS = 14;
const MIN_COMPLETED_EARLY_SIGNAL = 20;
const MIN_COMPLETED_REASONABLE_SIGNAL = 50;
const MIN_COMPLETED_STRONG_SIGNAL = 100;

const KNOWN_TRADE_SIDES = new Set([
  TARGET_TRADE_SIDE,
  OPPOSITE_TRADE_SIDE
]);

const LONG_TOKENS = new Set([
  'LONG',
  'BULL',
  'BULLISH',
  'BUY',
  'BID',
  'UP',
  'UPSIDE',
  'GREEN'
]);

const SHORT_TOKENS = new Set([
  'SHORT',
  'BEAR',
  'BEARISH',
  'SELL',
  'ASK',
  'DOWN',
  'DOWNSIDE',
  'RED'
]);

const TRUE_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'n', 'off']);

function now() {
  return Date.now();
}

function namespacedLongKey(key) {
  const raw = String(key || '').trim();

  if (!raw) return `${LONG_KEY_PREFIX}UNKNOWN`;
  if (raw.startsWith(LONG_KEY_PREFIX)) return raw;

  return `${LONG_KEY_PREFIX}${raw}`;
}

function longScanSnapshotKey(snapshotId) {
  if (typeof KEYS.long?.scan?.snapshot === 'function') {
    return KEYS.long.scan.snapshot(snapshotId);
  }

  if (typeof KEYS.scan?.longSnapshot === 'function') {
    return KEYS.scan.longSnapshot(snapshotId);
  }

  return namespacedLongKey(KEYS.scan.snapshot(snapshotId));
}

function longScanSnapshotPattern() {
  if (typeof KEYS.long?.scan?.snapshot === 'function') {
    return KEYS.long.scan.snapshot('*');
  }

  if (typeof KEYS.scan?.longSnapshot === 'function') {
    return KEYS.scan.longSnapshot('*');
  }

  try {
    return namespacedLongKey(KEYS.scan.snapshot('*'));
  } catch {
    return `${LONG_KEY_PREFIX}SCAN:SNAPSHOT:*`;
  }
}

const LONG_KEYS = {
  scan: {
    latest: namespacedLongKey(
      KEYS.long?.scan?.latest ||
      KEYS.scan?.longLatest ||
      KEYS.scan?.latest
    ),
    snapshot: longScanSnapshotKey,
    snapshotPattern: longScanSnapshotPattern
  },

  trade: {
    runMeta: namespacedLongKey(
      KEYS.long?.trade?.runMeta ||
      KEYS.trade?.longRunMeta ||
      KEYS.trade?.runMeta
    ),
    lastProcessedSnapshot: namespacedLongKey(
      KEYS.long?.trade?.lastProcessedSnapshot ||
      KEYS.trade?.longLastProcessedSnapshot ||
      KEYS.trade?.lastProcessedSnapshot
    )
  }
};

function isolationFlags() {
  return {
    runScope: RUN_SCOPE,
    writeScope: WRITE_SCOPE,
    readScope: READ_SCOPE,

    namespace: LONG_NAMESPACE,
    redisNamespace: LONG_NAMESPACE,
    keyPrefix: LONG_KEY_PREFIX,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,

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
    noScannerHistoryWrite: true,

    writesScanner: false,
    writesScannerLatest: false,
    writesScannerSnapshot: false,
    writesScannerHistory: false,

    writesLiveCache: false,
    liveCacheReadOnly: true,

    writesTrade: true,
    writesTradeRunMeta: true,
    writesTradeLastProcessedSnapshot: true,
    writesTradePositions: true,

    writesAnalyze: true,
    writesAnalyzePartial: true,
    writesMicroFamilies: true,
    microFamiliesAppendOnly: true,
    microFamiliesAntiWipe: true,
    analyzePartialOnly: true,
    analyzeFullOverwriteDisabled: true,

    writesRotation: false,
    writesManualSelection: false,
    writesDiscordSelection: false,

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
    manualSelectionPreserved: true,

    realOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    noRealOrders: true,
    noExchangeOrders: true,

    ignoreGlobalMaxOpenPositions: true,
    noGlobalMaxOpenPositionsBlock: true,
    oneOpenPositionPerSymbol: true
  };
}

function sideFlags() {
  return {
    sideMode: 'LONG_ONLY',

    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_SCANNER_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    scannerSide: TARGET_TRADE_SIDE,
    actualScannerSide: TARGET_TRADE_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false
  };
}

function virtualFlags() {
  return {
    virtualOnly: true,
    virtualTracked: true,
    virtualLearning: true,
    source: 'VIRTUAL',
    outcomeSource: 'VIRTUAL',

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    realOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    noExchangeOrders: true,
    noRealOrders: true,

    learningOnly: false,
    microFamilyLearning: true,

    observationFirst: true,
    observationFirstLearning: true,
    everyAnalyzeRowCountsSeen: true,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintOnlyMetadata: false,
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    learningIdentitySource: 'ANALYZE_MICRO_FAMILY',
    exactTrueMicroFamilyRequired: true,
    symbolExcludedFromFamilyId: true,

    entryRelaxationProfile: ENTRY_RELAXATION_PROFILE,
    entrySlightlyLoosened: true,
    syntheticRiskDefaultEnabled: DEFAULT_ALLOW_SYNTHETIC_RISK_FALLBACK,

    qualityMeasurementProfile: QUALITY_MEASUREMENT_PROFILE,
    noSyntheticShadowLayer: true,
    disciplinedMeasurement: true,
    recommendedFreezeDays: FREEZE_MEASUREMENT_RECOMMENDED_DAYS,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    defaultRanking: 'dashboardBalancedScore',
    defaultRankingNeverBareWinrate: true,

    learningStatusRules: {
      observing: 'completed = 0',
      earlyOutcomes: 'completed > 0 && completed < 20',
      activeLearning: 'completed >= 20'
    },

    completedThresholds: {
      earlySignal: MIN_COMPLETED_EARLY_SIGNAL,
      reasonableSignal: MIN_COMPLETED_REASONABLE_SIGNAL,
      strongSignal: MIN_COMPLETED_STRONG_SIGNAL
    }
  };
}

function cfgNumber(value, fallback) {
  const n = safeNumber(value, fallback);
  return Number.isFinite(n) ? n : fallback;
}

function cfgBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;

  const raw = String(value).trim().toLowerCase();

  if (TRUE_VALUES.has(raw)) return true;
  if (FALSE_VALUES.has(raw)) return false;

  return fallback;
}

function positiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const n = Math.floor(cfgNumber(value, fallback));
  return Math.max(min, Math.min(max, n));
}

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;

  return Math.max(min, Math.min(max, n));
}

function ratio(part, total) {
  const p = safeNumber(part, 0);
  const t = safeNumber(total, 0);

  if (t <= 0) return 0;

  return p / t;
}

function pct(part, total) {
  return Number((ratio(part, total) * 100).toFixed(2));
}

function tradeConfig() {
  const configuredTradeMax = cfgNumber(CONFIG.trade?.maxCandidatesPerSnapshot, 0);
  const configuredAnalyzeMax = cfgNumber(
    CONFIG.trade?.analyzeMaxCandidatesPerSnapshot ??
    CONFIG.trade?.maxAnalyzeCandidatesPerSnapshot ??
    CONFIG.scanner?.maxCandidates ??
    CONFIG.scanner?.analyzeMaxCandidates,
    DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT
  );

  return {
    entryRelaxationProfile: ENTRY_RELAXATION_PROFILE,
    qualityMeasurementProfile: QUALITY_MEASUREMENT_PROFILE,

    maxCandidatesPerSnapshot: positiveInt(
      Math.max(
        configuredTradeMax,
        configuredAnalyzeMax,
        cfgNumber(CONFIG.scanner?.maxSymbols, 0),
        cfgNumber(CONFIG.scanner?.maxCandidates, 0),
        cfgNumber(CONFIG.scanner?.analyzeMaxCandidates, 0),
        DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT
      ),
      DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT,
      1,
      1000
    ),

    maxSnapshotAgeSec: cfgNumber(CONFIG.trade?.maxSnapshotAgeSec, 8 * 60),

    dataConcurrency: positiveInt(
      CONFIG.trade?.dataConcurrency,
      8,
      1,
      20
    ),

    maxSpreadPct: cfgNumber(CONFIG.trade?.maxSpreadPct, 0.0015),

    minLiveCandles15m: positiveInt(
      CONFIG.trade?.minLiveCandles15m ??
      CONFIG.trade?.minLiveCandles15M ??
      CONFIG.trade?.minCandles15m ??
      CONFIG.trade?.minCandles15M,
      DEFAULT_MIN_LIVE_CANDLES_15M,
      20,
      100
    ),

    candleTtlSec: positiveInt(
      CONFIG.trade?.candleTtlSec,
      90
    ),

    orderbookTtlSec: positiveInt(
      CONFIG.trade?.orderbookTtlSec,
      12
    ),

    fundingTtlSec: positiveInt(
      CONFIG.trade?.fundingTtlSec,
      120
    ),

    allowSyntheticRiskFallback: cfgBoolean(
      CONFIG.trade?.allowSyntheticRiskFallback,
      DEFAULT_ALLOW_SYNTHETIC_RISK_FALLBACK
    ),

    allowSyntheticRiskVirtualEntries: cfgBoolean(
      CONFIG.trade?.allowSyntheticRiskVirtualEntries,
      DEFAULT_ALLOW_SYNTHETIC_RISK_VIRTUAL_ENTRIES
    ),

    syntheticRiskRequiresScannerGatePassed: cfgBoolean(
      CONFIG.trade?.syntheticRiskRequiresScannerGatePassed,
      true
    ),

    syntheticRiskRequiresAnalyzeEligible: cfgBoolean(
      CONFIG.trade?.syntheticRiskRequiresAnalyzeEligible,
      true
    ),

    syntheticRiskRequiresSpreadGatePassed: cfgBoolean(
      CONFIG.trade?.syntheticRiskRequiresSpreadGatePassed,
      true
    ),

    minRiskPct: cfgNumber(CONFIG.trade?.minRiskPct, DEFAULT_MIN_RISK_PCT),
    maxRiskPct: cfgNumber(CONFIG.trade?.maxRiskPct, DEFAULT_MAX_RISK_PCT),
    fallbackRiskPct: cfgNumber(CONFIG.trade?.fallbackRiskPct, DEFAULT_FALLBACK_RISK_PCT),
    defaultRR: cfgNumber(CONFIG.trade?.defaultRR, 1.5),
    minRR: cfgNumber(CONFIG.trade?.minRR, 0.5),
    positionTimeStopMin: cfgNumber(CONFIG.trade?.positionTimeStopMin, 720)
  };
}

function sizingConfig() {
  return {
    enabled: CONFIG.sizing?.enabled !== false,
    baseRiskPct: cfgNumber(CONFIG.sizing?.baseRiskPct, 0.0025)
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

function actionCounts(actions = []) {
  return actions.reduce((acc, row) => {
    const key = row?.action || row?.type || 'UNKNOWN';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function reasonCounts(actions = []) {
  return actions.reduce((acc, row) => {
    const key = row?.reason || row?.liveEntryBlockedReason || 'UNKNOWN_REASON';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function topReasonCounts(actions = [], limit = 10) {
  return Object.entries(reasonCounts(actions))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([reason, count]) => ({ reason, count }));
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function upper(value, fallback = '') {
  const text = String(value ?? '').trim();

  return text ? text.toUpperCase() : fallback;
}

function cleanSideText(value = '') {
  return upper(value, '')
    .replaceAll('SHORT_DISABLED', '')
    .replaceAll('SHORTDISABLED', '')
    .replaceAll('SHORT_DISABLED_TRUE', '')
    .replaceAll('SHORTDISABLED_TRUE', '')
    .replaceAll('BLOCK_SHORT', '')
    .replaceAll('SHORT_ENABLED_FALSE', '')
    .replaceAll('SHORT_ONLY_FALSE', '')
    .replaceAll('LONG_DISABLED_FALSE', '')
    .replaceAll('LONG_ONLY_MODE', 'LONG')
    .replaceAll('LONG_ONLY', 'LONG')
    .replaceAll('LONG-ONLY', 'LONG');
}

function isScannerFamilyId(id = '') {
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
  if (isScannerFamilyId(raw)) return '';

  return stripSymbolTokensFromFamilyId(raw, row);
}

function normalizeCandidate(candidate = {}) {
  const contractSymbol = normalizeContractSymbol(
    candidate.contractSymbol ||
    candidate.symbol
  );

  const symbol =
    normalizeBaseSymbol(candidate.symbol || contractSymbol) ||
    normalizeBaseSymbol(contractSymbol);

  return {
    ...candidate,
    symbol,
    baseSymbol: symbol,
    contractSymbol
  };
}

function scannerMicroFamilyIdFrom(row = {}) {
  return (
    row.scannerMicroFamilyId ||
    (isScannerFamilyId(row.microFamilyId) ? row.microFamilyId : null) ||
    (isScannerFamilyId(row.trueMicroFamilyId) ? row.trueMicroFamilyId : null) ||
    (isScannerFamilyId(row.id) ? row.id : null) ||
    (isScannerFamilyId(row.key) ? row.key : null) ||
    null
  );
}

function scannerFamilyIdFrom(row = {}) {
  return (
    row.scannerFamilyId ||
    (isScannerFamilyId(row.familyId) ? row.familyId : null) ||
    (isScannerFamilyId(row.baseFamilyId) ? row.baseFamilyId : null) ||
    null
  );
}

function scannerMetadataFrom(...rows) {
  const merged = Object.assign({}, ...rows.filter(Boolean));
  const scannerMicroFamilyId = rows.map(scannerMicroFamilyIdFrom).find(Boolean) || null;
  const scannerFamilyId = rows.map(scannerFamilyIdFrom).find(Boolean) || null;

  return {
    scannerMicroFamilyId,
    scannerFamilyId,
    scannerDefinition: merged.scannerDefinition || (
      scannerMicroFamilyId
        ? merged.definition || merged.microDefinition || null
        : null
    ),
    scannerDefinitionParts: Array.isArray(merged.scannerDefinitionParts)
      ? merged.scannerDefinitionParts
      : scannerMicroFamilyId && Array.isArray(merged.definitionParts)
        ? merged.definitionParts
        : [],

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintOnlyMetadata: false,
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    learningIdentitySource: 'ANALYZE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true
  };
}

function normalizeTradeSide(side) {
  const raw = cleanSideText(side);

  if (!raw) return 'UNKNOWN';

  const direct = sideToTradeSide(raw);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  if (LONG_TOKENS.has(raw)) return TARGET_TRADE_SIDE;
  if (SHORT_TOKENS.has(raw)) return OPPOSITE_TRADE_SIDE;

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

  if (longHit) return TARGET_TRADE_SIDE;
  if (shortHit) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function idLooksLikeTargetFamily(id = '') {
  const value = cleanSideText(id);

  if (!value) return false;

  return (
    value.includes('MICRO_LONG_') ||
    /^LONG_\d+$/u.test(value) ||
    value.startsWith('LONG_') ||
    value.includes('_LONG_') ||
    value.endsWith('_LONG') ||
    value.startsWith('BULL_') ||
    value.includes('_BULL_') ||
    value.endsWith('_BULL') ||
    value.startsWith('BUY_') ||
    value.includes('_BUY_') ||
    value.endsWith('_BUY') ||
    value.includes('TRADESIDE=LONG') ||
    value.includes('TRADE_SIDE=LONG') ||
    value.includes('POSITION_SIDE=LONG') ||
    value.includes('POSITIONSIDE=LONG') ||
    value.includes('SIDE=LONG') ||
    value.includes('SIDE=BULL') ||
    value.includes('DIRECTION=LONG') ||
    value.includes('DIRECTION=BULL') ||
    value.includes('SIDE=BUY') ||
    value.includes('DIRECTION=BUY')
  );
}

function idLooksLikeOppositeFamily(id = '') {
  const value = cleanSideText(id);

  if (!value) return false;

  return (
    value.includes('MICRO_SHORT_') ||
    /^SHORT_\d+$/u.test(value) ||
    value.startsWith('SHORT_') ||
    value.includes('_SHORT_') ||
    value.endsWith('_SHORT') ||
    value.startsWith('BEAR_') ||
    value.includes('_BEAR_') ||
    value.endsWith('_BEAR') ||
    value.startsWith('SELL_') ||
    value.includes('_SELL_') ||
    value.endsWith('_SELL') ||
    value.includes('TRADESIDE=SHORT') ||
    value.includes('TRADE_SIDE=SHORT') ||
    value.includes('POSITION_SIDE=SHORT') ||
    value.includes('POSITIONSIDE=SHORT') ||
    value.includes('SIDE=SHORT') ||
    value.includes('SIDE=BEAR') ||
    value.includes('DIRECTION=SHORT') ||
    value.includes('DIRECTION=BEAR') ||
    value.includes('SIDE=SELL') ||
    value.includes('DIRECTION=SELL')
  );
}

function inferSideFromIds(row = {}) {
  const haystack = [
    row.familyId,
    row.family,
    row.baseFamilyId,

    row.microFamilyId,
    row.trueMicroFamilyId,
    row.coarseMicroFamilyId,
    row.baseMicroFamilyId,
    row.legacyMicroFamilyId,
    row.liveMicroFamilyId,
    row.realMicroFamilyId,
    row.executionMicroFamilyId,

    row.scannerMicroFamilyId,
    row.scannerFamilyId,

    row.macroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId,
    row.parentFamilyId,
    row.macroId,

    row.id,
    row.key
  ]
    .map((value) => cleanSideText(value))
    .filter(Boolean)
    .join('|');

  if (!haystack) return 'UNKNOWN';

  const longHit = idLooksLikeTargetFamily(haystack);
  const shortHit = idLooksLikeOppositeFamily(haystack);

  if (longHit && !shortHit) return TARGET_TRADE_SIDE;
  if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;

  if (longHit && shortHit) {
    if (haystack.includes('TRADESIDE=LONG') || haystack.includes('TRADE_SIDE=LONG')) {
      return TARGET_TRADE_SIDE;
    }

    if (haystack.includes('TRADESIDE=SHORT') || haystack.includes('TRADE_SIDE=SHORT')) {
      return OPPOSITE_TRADE_SIDE;
    }

    if (haystack.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
    if (haystack.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferSideFromDefinitions(row = {}) {
  const haystack = [
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

  if (!haystack) return 'UNKNOWN';

  const longHit =
    haystack.includes('TRADESIDE=LONG') ||
    haystack.includes('TRADE_SIDE=LONG') ||
    haystack.includes('POSITION_SIDE=LONG') ||
    haystack.includes('POSITIONSIDE=LONG') ||
    haystack.includes('SIDE=LONG') ||
    haystack.includes('SIDE=BULL') ||
    haystack.includes('DIRECTION=LONG') ||
    haystack.includes('DIRECTION=BULL') ||
    haystack.includes('SIDE=BUY') ||
    haystack.includes('DIRECTION=BUY') ||
    idLooksLikeTargetFamily(haystack);

  const shortHit =
    haystack.includes('TRADESIDE=SHORT') ||
    haystack.includes('TRADE_SIDE=SHORT') ||
    haystack.includes('POSITION_SIDE=SHORT') ||
    haystack.includes('POSITIONSIDE=SHORT') ||
    haystack.includes('SIDE=SHORT') ||
    haystack.includes('SIDE=BEAR') ||
    haystack.includes('DIRECTION=SHORT') ||
    haystack.includes('DIRECTION=BEAR') ||
    haystack.includes('SIDE=SELL') ||
    haystack.includes('DIRECTION=SELL') ||
    idLooksLikeOppositeFamily(haystack);

  if (longHit && !shortHit) return TARGET_TRADE_SIDE;
  if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;

  if (longHit && shortHit) {
    if (haystack.includes('TRADESIDE=LONG') || haystack.includes('TRADE_SIDE=LONG')) {
      return TARGET_TRADE_SIDE;
    }

    if (haystack.includes('TRADESIDE=SHORT') || haystack.includes('TRADE_SIDE=SHORT')) {
      return OPPOSITE_TRADE_SIDE;
    }

    if (haystack.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
    if (haystack.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferRowTradeSide(row = {}) {
  if (typeof row !== 'object' || row === null) {
    return normalizeTradeSide(row);
  }

  const directSources = [
    row.tradeSide,
    row.positionSide,
    row.direction,
    row.scannerSide,
    row.actualScannerSide,
    row.analysisSide,
    row.signalSide,
    row.entrySide,
    row.side
  ];

  for (const value of directSources) {
    const direct = normalizeTradeSide(value);

    if (KNOWN_TRADE_SIDES.has(direct)) return direct;
  }

  const fromIds = inferSideFromIds(row);

  if (KNOWN_TRADE_SIDES.has(fromIds)) return fromIds;

  const fromDefinitions = inferSideFromDefinitions(row);

  if (KNOWN_TRADE_SIDES.has(fromDefinitions)) return fromDefinitions;

  if (row.longOnly === true || row.shortDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  if (row.shortOnly === true || row.longDisabled === true) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function isTargetRow(row = {}) {
  return inferRowTradeSide(row) === TARGET_TRADE_SIDE;
}

function isMirrorAnalysisRow(row = {}) {
  return Boolean(
    row.isMirrorMicroFamily ||
    row.observationMirror ||
    row.analysisMirror ||
    row.mirrorAnalysisOnly
  );
}

function isLiveScannerRow(row = {}) {
  return !isMirrorAnalysisRow(row);
}

function buildAnalysisVariant(candidate = {}, side, scannerSide) {
  const tradeSide = normalizeTradeSide(side);
  const actualScannerSide = normalizeTradeSide(scannerSide);

  if (tradeSide !== TARGET_TRADE_SIDE) return null;
  if (actualScannerSide !== TARGET_TRADE_SIDE) return null;

  const scannerMeta = scannerMetadataFrom(candidate);

  const cleanMicroFamilyId = cleanLearningFamilyId(
    candidate.trueMicroFamilyId ||
    candidate.microFamilyId,
    candidate
  );

  const cleanCoarseMicroFamilyId = cleanLearningFamilyId(
    candidate.coarseMicroFamilyId ||
    candidate.baseMicroFamilyId ||
    candidate.legacyMicroFamilyId,
    candidate
  );

  return {
    ...candidate,

    microFamilyId: cleanMicroFamilyId || undefined,
    trueMicroFamilyId: cleanMicroFamilyId || undefined,
    coarseMicroFamilyId: cleanCoarseMicroFamilyId || undefined,
    baseMicroFamilyId: cleanCoarseMicroFamilyId || undefined,
    legacyMicroFamilyId: cleanCoarseMicroFamilyId || undefined,

    ...scannerMeta,
    ...sideFlags(),
    ...isolationFlags(),

    isMirrorMicroFamily: false,
    observationMirror: false,
    analysisMirror: false,
    mirrorAnalysisOnly: false,

    analyzeOnly: Boolean(candidate.analyzeOnly),
    discoveryOnly: Boolean(candidate.discoveryOnly),
    tradeDiscoveryOnly: Boolean(candidate.tradeDiscoveryOnly)
  };
}

function waitAction(candidate, reason, extra = {}) {
  const tradeSide = inferRowTradeSide(candidate);

  return {
    action: 'WAIT',
    reason,
    symbol: candidate?.symbol || null,
    contractSymbol: candidate?.contractSymbol || null,
    side: tradeSide === TARGET_TRADE_SIDE ? TARGET_DASHBOARD_SIDE : candidate?.side || null,
    tradeSide,
    snapshotId: candidate?.snapshotId || null,
    scannerScore: candidate?.scannerScore ?? candidate?.moveScore ?? null,

    virtualTracked: false,
    liveEligible: false,
    discordAlertEligible: false,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    entryRelaxationProfile: ENTRY_RELAXATION_PROFILE,

    ...isolationFlags(),

    ...extra
  };
}

function buildVirtualExitAction(outcome = {}) {
  return {
    action: 'VIRTUAL_EXIT',
    reason: outcome.exitReason || outcome.reason || 'VIRTUAL_POSITION_CLOSED',

    source: 'VIRTUAL',
    outcomeSource: 'VIRTUAL',
    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: false,

    symbol: outcome.symbol || null,
    contractSymbol: outcome.contractSymbol || null,

    microFamilyId: outcome.microFamilyId || null,
    trueMicroFamilyId: outcome.trueMicroFamilyId || outcome.microFamilyId || null,
    coarseMicroFamilyId: outcome.coarseMicroFamilyId || null,
    macroFamilyId: outcome.macroFamilyId || outcome.parentMacroFamilyId || null,
    parentMacroFamilyId: outcome.parentMacroFamilyId || outcome.macroFamilyId || null,

    scannerMicroFamilyId: outcome.scannerMicroFamilyId || null,
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintOnlyMetadata: false,
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    learningIdentitySource: 'ANALYZE_MICRO_FAMILY',

    exitReason: outcome.exitReason || null,
    exitPrice: outcome.exitPrice ?? null,
    grossR: outcome.grossR ?? outcome.realizedGrossR ?? null,
    netR: outcome.netR ?? outcome.realizedR ?? outcome.r ?? null,
    realizedR: outcome.realizedR ?? outcome.netR ?? outcome.r ?? null,
    costR: outcome.costR ?? null,
    avgCostR: outcome.avgCostR ?? outcome.costR ?? null,

    currentPrice: outcome.currentPrice ?? outcome.lastPrice ?? outcome.exitPrice ?? null,
    lastPrice: outcome.lastPrice ?? outcome.currentPrice ?? outcome.exitPrice ?? null,
    entry: outcome.entry ?? null,
    sl: outcome.sl ?? null,
    tp: outcome.tp ?? null,
    ageSec: outcome.ageSec ?? null,
    currentR: outcome.currentR ?? null,
    mfeR: outcome.mfeR ?? null,
    maeR: outcome.maeR ?? null,
    reachedHalfR: Boolean(outcome.reachedHalfR),
    reachedOneR: Boolean(outcome.reachedOneR),
    nearTpSeen: Boolean(outcome.nearTpSeen),

    tpHitNow: Boolean(outcome.tpHitNow || outcome.exitReason === 'TP'),
    slHitNow: Boolean(outcome.slHitNow || outcome.exitReason === 'SL'),
    timeStopHitNow: Boolean(outcome.timeStopHitNow || outcome.exitReason === 'TIME_STOP'),

    discordExitAlertSent: Boolean(outcome.discordExitAlertSent),

    realTrade: false,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    entryRelaxationProfile: ENTRY_RELAXATION_PROFILE,

    ...sideFlags(),
    ...isolationFlags()
  };
}

function buildVirtualExitActions(exits = []) {
  return (Array.isArray(exits) ? exits : [])
    .filter(Boolean)
    .map(buildVirtualExitAction);
}

function buildRunActionCounts(actions = [], virtualExits = []) {
  return actionCounts([
    ...(Array.isArray(actions) ? actions : []),
    ...buildVirtualExitActions(virtualExits)
  ]);
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
  return cleanLearningFamilyId(
    row.trueMicroFamilyId ||
    row.microFamilyId ||
    row.analyzeMicroFamilyId ||
    '',
    row
  );
}

function rowCoarseMicroId(row = {}) {
  return cleanLearningFamilyId(
    row.coarseMicroFamilyId ||
    row.baseMicroFamilyId ||
    row.legacyMicroFamilyId ||
    row.trueMicroFamilyId ||
    row.microFamilyId ||
    '',
    row
  );
}

function parentMacroFamilyId(row = {}) {
  const raw = String(
    row.parentMacroFamilyId ||
    row.parentMicroFamilyId ||
    row.macroFamilyId ||
    row.familyMacroId ||
    ''
  ).trim();

  if (!raw || isScannerFamilyId(raw)) return '';

  return stripSymbolTokensFromFamilyId(raw, row);
}

function rowMicroAliasIds(row = {}, { includeCoarse = false } = {}) {
  const base = [
    row.trueMicroFamilyId,
    row.microFamilyId
  ];

  const coarse = includeCoarse
    ? [
      row.coarseMicroFamilyId,
      row.baseMicroFamilyId,
      row.legacyMicroFamilyId
    ]
    : [];

  return uniqueStrings([
    ...base,
    ...coarse
  ])
    .map((id) => cleanLearningFamilyId(id, row))
    .filter(Boolean)
    .filter(idLooksLikeTargetFamily);
}

function isTrueMicroFamilyRow(row = {}) {
  const { microSchema, macroSchema } = schemaConfig();

  const id = rowMicroId(row);
  const schema = rowSchema(row);
  const version = String(row.version || '').toUpperCase();

  if (!row || !id) return false;
  if (isScannerFamilyId(id)) return false;
  if (scannerMicroFamilyIdFrom(row) && !row.microFamilyId && !row.trueMicroFamilyId) return false;
  if (!isTargetRow(row) && !idLooksLikeTargetFamily(id)) return false;
  if (version.includes('MACRO')) return false;

  if (row.isTrueMicro === true || row.trueMicro === true) return true;
  if (schema === microSchema) return true;
  if (idHasSchema(id, microSchema)) return true;
  if (definitionHasSchema(row, microSchema)) return true;

  if (row.isLegacyMacro === true) return false;
  if (schema === macroSchema) return false;
  if (idHasSchema(id, macroSchema)) return false;
  if (definitionHasSchema(row, macroSchema)) return false;

  return Boolean(parentMacroFamilyId(row) || row.coarseMicroFamilyId || row.trueMicroFamilyId);
}

function isKnownTrueMicroFamilyId(id = '') {
  const { microSchema, macroSchema } = schemaConfig();

  if (!id) return false;
  if (isScannerFamilyId(id)) return false;
  if (!idLooksLikeTargetFamily(id)) return false;
  if (idHasSchema(id, macroSchema)) return false;

  return (
    idHasSchema(id, microSchema) ||
    String(id).toUpperCase().startsWith('MICRO_LONG_')
  );
}

function addRowAliasesToMaps({
  row,
  rowByMicroId,
  rowByAnyMicroId,
  includeCoarseAliases = false
}) {
  if (!row) return;

  const exactId = rowMicroId(row);

  if (exactId) {
    rowByMicroId.set(exactId, row);
    rowByAnyMicroId.set(exactId, row);
  }

  for (const aliasId of rowMicroAliasIds(row, { includeCoarse: includeCoarseAliases })) {
    if (!aliasId) continue;
    rowByAnyMicroId.set(aliasId, row);
  }
}

function buildSelectedAlertContext(activeRotation) {
  const rawRows = Array.isArray(activeRotation?.microFamilies)
    ? activeRotation.microFamilies
    : [];

  const rows = rawRows.filter((row) => (
    isTrueMicroFamilyRow(row) ||
    isKnownTrueMicroFamilyId(rowMicroId(row))
  ));

  const rowByMicroId = new Map();
  const rowByAnyMicroId = new Map();

  for (const row of rows) {
    addRowAliasesToMaps({
      row,
      rowByMicroId,
      rowByAnyMicroId,
      includeCoarseAliases: false
    });
  }

  const configuredIds = uniqueStrings([
    ...(Array.isArray(activeRotation?.microFamilyIds) ? activeRotation.microFamilyIds : []),
    ...(Array.isArray(activeRotation?.activeMicroFamilyIds) ? activeRotation.activeMicroFamilyIds : []),
    ...(Array.isArray(activeRotation?.trueMicroFamilyIds) ? activeRotation.trueMicroFamilyIds : []),
    ...(Array.isArray(activeRotation?.ids) ? activeRotation.ids : []),
    ...rows.map(rowMicroId)
  ]);

  const selectedMicroFamilyIds = configuredIds
    .map((id) => cleanLearningFamilyId(id, {}))
    .filter((id) => {
      if (!id) return false;
      if (isScannerFamilyId(id)) return false;
      if (!idLooksLikeTargetFamily(id)) return false;

      const row = rowByMicroId.get(id);

      if (row && isTrueMicroFamilyRow(row)) return true;

      return isKnownTrueMicroFamilyId(id);
    });

  const selectedMicroSet = new Set(selectedMicroFamilyIds);

  const selectedMicroAliasIds = [...selectedMicroFamilyIds];
  const selectedMicroAliasSet = new Set(selectedMicroAliasIds);

  const selectedMacroFamilyIds = uniqueStrings([
    ...(Array.isArray(activeRotation?.macroFamilyIds) ? activeRotation.macroFamilyIds : []),
    ...(Array.isArray(activeRotation?.activeMacroFamilyIds) ? activeRotation.activeMacroFamilyIds : []),
    ...(Array.isArray(activeRotation?.macroIds) ? activeRotation.macroIds : []),
    ...rows.map(parentMacroFamilyId)
  ])
    .map((id) => cleanLearningFamilyId(id, {}))
    .filter(Boolean)
    .filter(idLooksLikeTargetFamily);

  const macroToMicroFamilyIds = {
    ...(activeRotation?.macroToMicroFamilyIds || {})
  };

  const microToMacroFamilyId = {
    ...(activeRotation?.microToMacroFamilyId || {})
  };

  for (const row of rows) {
    const microId = rowMicroId(row);
    const macroId = parentMacroFamilyId(row);

    if (!microId || !macroId) continue;
    if (!idLooksLikeTargetFamily(microId) || !idLooksLikeTargetFamily(macroId)) continue;

    microToMacroFamilyId[microId] ||= macroId;

    if (!macroToMicroFamilyIds[macroId]) {
      macroToMicroFamilyIds[macroId] = [];
    }

    macroToMicroFamilyIds[macroId].push(microId);
  }

  for (const macroId of Object.keys(macroToMicroFamilyIds)) {
    macroToMicroFamilyIds[macroId] = uniqueStrings(
      macroToMicroFamilyIds[macroId]
    )
      .map((id) => cleanLearningFamilyId(id, {}))
      .filter(Boolean)
      .filter(idLooksLikeTargetFamily);
  }

  return {
    rotationId: activeRotation?.rotationId || null,
    selectedRotation: activeRotation || null,

    selectedMicroFamilyIds,
    selectedMicroSet,
    selectedMicroAliasIds,
    selectedMicroAliasSet,

    selectedMacroFamilyIds,

    rowByMicroId,
    rowByAnyMicroId,

    microToMacroFamilyId,
    macroToMicroFamilyIds,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    allowCoarseMicroAliasLiveEntries: false,
    allowCoarseMicroAliasForDiscord: false,

    empty: !selectedMicroFamilyIds.length,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    selectionPurpose: 'DISCORD_ALERT_ONLY',

    ...isolationFlags()
  };
}

function rowMatchesSelectedAlertMicro(alertContext, row = {}) {
  if (!alertContext || alertContext.empty) return false;
  if (!isTrueMicroFamilyRow(row)) return false;

  const exactTrueMicroId = rowMicroId(row);

  if (!exactTrueMicroId) return false;

  return alertContext.selectedMicroSet.has(exactTrueMicroId);
}

function getSelectedWeeklyStats(alertContext, microFamilyId, row = {}) {
  if (!alertContext) return null;

  const exactId = String(
    microFamilyId ||
    row.trueMicroFamilyId ||
    row.microFamilyId ||
    ''
  ).trim();

  if (!exactId) return null;

  return alertContext.rowByMicroId.get(exactId) || null;
}

function hasValidRiskShape(row = {}) {
  const entry = safeNumber(row.entry, 0);
  const sl = safeNumber(row.sl, 0);
  const tp = safeNumber(row.tp, 0);
  const rr = safeNumber(row.rr, 0);
  const tradeSide = inferRowTradeSide(row);

  if (row.learningOnly === true) return false;
  if (tradeSide !== TARGET_TRADE_SIDE) return false;

  if (entry <= 0 || sl <= 0 || tp <= 0 || rr <= 0) return false;

  return sl < entry && tp > entry;
}

function validateVirtualEntry(row = {}) {
  const cfg = tradeConfig();
  const tradeSide = inferRowTradeSide(row);
  const microFamilyId = rowMicroId(row);

  if (tradeSide !== TARGET_TRADE_SIDE) {
    return {
      ok: false,
      reason: 'SHORT_DISABLED_LONG_ONLY_SYSTEM',
      tradeSide
    };
  }

  if (isMirrorAnalysisRow(row)) {
    return {
      ok: false,
      reason: 'MIRROR_ANALYSIS_ONLY'
    };
  }

  if (!microFamilyId || isScannerFamilyId(microFamilyId)) {
    return {
      ok: false,
      reason: 'ANALYZE_TRUE_MICRO_FAMILY_REQUIRED'
    };
  }

  if (!isTrueMicroFamilyRow(row)) {
    return {
      ok: false,
      reason: 'ENTRY_REQUIRES_TRUE_ANALYZE_MICRO_FAMILY'
    };
  }

  if (row.syntheticRisk && !cfg.allowSyntheticRiskVirtualEntries) {
    return {
      ok: false,
      reason: 'SYNTHETIC_RISK_NOT_ALLOWED_FOR_VIRTUAL_TRACKING',
      syntheticRisk: true,
      syntheticRiskReason: row.syntheticRiskReason || null
    };
  }

  if (!hasValidRiskShape(row)) {
    return {
      ok: false,
      reason: row.liveEntryBlockedReason || 'LONG_RISK_INVALID'
    };
  }

  return {
    ok: true,
    reason: row.syntheticRisk
      ? 'LONG_VIRTUAL_RISK_VALID_SYNTHETIC_EXPLICITLY_ENABLED'
      : 'LONG_VIRTUAL_RISK_VALID'
  };
}

async function cachedVolatile(key, ttlSec, fn) {
  const redis = getVolatileRedis();

  const cached = await getJson(redis, key, null).catch(() => null);

  if (cached !== null && cached !== undefined) {
    return cached;
  }

  /*
    TradeSystem mag geen LIVE:* cache schrijven.
    Dit voorkomt dat de Trade pagina de Live/Scanner pagina-state overschrijft.
    De data wordt wel live opgehaald en gebruikt voor deze run.
  */
  return fn();
}

async function fetchLiveCandidateData(candidate) {
  const cfg = tradeConfig();

  const normalized = normalizeCandidate(candidate);
  const symbol = normalized.contractSymbol;

  if (!symbol) {
    return {
      symbol,
      ob: {
        fetchFailed: true,
        mid: 0,
        bias: 'NEUTRAL',
        spreadPct: CONFIG.cost?.fallbackSpreadPct || 0.0008,
        depthMinUsd1p: 0
      },
      funding: { rate: 0, fetchFailed: true },
      candles15m: [],
      candles1h: []
    };
  }

  const [rawOrderBook, funding, candles15m, candles1h] = await Promise.all([
    cachedVolatile(
      KEYS.live.cache(symbol, 'ob'),
      cfg.orderbookTtlSec,
      () => fetchOrderBook(symbol)
    ).catch(() => null),

    cachedVolatile(
      KEYS.live.cache(symbol, 'funding'),
      cfg.fundingTtlSec,
      () => fetchFunding(symbol)
    ).catch(() => ({ rate: 0, fetchFailed: true })),

    cachedVolatile(
      KEYS.live.cache(symbol, 'c15'),
      cfg.candleTtlSec,
      () => fetchCandles(symbol, '15m', 100)
    ).catch(() => []),

    cachedVolatile(
      KEYS.live.cache(symbol, 'c1h'),
      cfg.candleTtlSec,
      () => fetchCandles(symbol, '1h', 100)
    ).catch(() => [])
  ]);

  const ob = analyzeOrderBook(rawOrderBook);

  return {
    symbol,
    ob,
    funding,
    candles15m: Array.isArray(candles15m) ? candles15m : [],
    candles1h: Array.isArray(candles1h) ? candles1h : []
  };
}

async function fetchMidPrice(symbol) {
  const cfg = tradeConfig();
  const contractSymbol = normalizeContractSymbol(symbol);

  if (!contractSymbol) return 0;

  const rawOrderBook = await cachedVolatile(
    KEYS.live.cache(contractSymbol, 'ob'),
    cfg.orderbookTtlSec,
    () => fetchOrderBook(contractSymbol)
  ).catch(() => null);

  const ob = analyzeOrderBook(rawOrderBook);

  return safeNumber(ob?.mid, 0);
}

function hasFullSnapshotShape(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    Array.isArray(value.candidates)
  );
}

function snapshotPattern() {
  return LONG_KEYS.scan.snapshotPattern();
}

function snapshotCreatedAt(snapshot = {}) {
  return safeNumber(
    snapshot.createdAt ||
    snapshot.completedAt ||
    snapshot.ts ||
    snapshot.scannerTs,
    0
  );
}

function extractSnapshotId(latest) {
  if (!latest) return null;
  if (typeof latest === 'string') return latest;

  if (typeof latest === 'object') {
    return (
      latest.snapshotId ||
      latest.id ||
      latest.latestSnapshotId ||
      latest.scanId ||
      null
    );
  }

  return null;
}

function candidateTradeSide(candidate = {}) {
  return inferRowTradeSide(candidate);
}

function countTargetCandidates(snapshot = {}) {
  const rows = Array.isArray(snapshot.candidates)
    ? snapshot.candidates
    : [];

  return rows.filter((candidate) => candidateTradeSide(candidate) === TARGET_TRADE_SIDE).length;
}

function countOppositeCandidates(snapshot = {}) {
  const rows = Array.isArray(snapshot.candidates)
    ? snapshot.candidates
    : [];

  return rows.filter((candidate) => candidateTradeSide(candidate) === OPPOSITE_TRADE_SIDE).length;
}

async function safeGetSnapshotJson(redis, key, fallback = null) {
  return getJson(redis, key, fallback).catch(() => fallback);
}

async function loadRecentTargetSnapshots(redis) {
  const keys = await getKeys(
    redis,
    snapshotPattern(),
    SNAPSHOT_SEARCH_LIMIT
  ).catch(() => []);

  if (!keys.length) return [];

  const rows = await Promise.all(
    keys.map(async (key) => {
      const snapshot = await safeGetSnapshotJson(redis, key, null);

      if (!hasFullSnapshotShape(snapshot)) return null;

      return {
        key,
        snapshot,
        targetCount: countTargetCandidates(snapshot),
        oppositeCount: countOppositeCandidates(snapshot),
        createdAt: snapshotCreatedAt(snapshot)
      };
    })
  );

  return rows
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function normalizeSelectedSnapshot(snapshot = {}, meta = {}) {
  const rows = Array.isArray(snapshot.candidates)
    ? snapshot.candidates
    : [];

  const targetRows = rows
    .filter((candidate) => candidateTradeSide(candidate) === TARGET_TRADE_SIDE)
    .map((candidate) => ({
      ...candidate,
      ...scannerMetadataFrom(candidate),
      ...sideFlags(),
      ...isolationFlags()
    }));

  const blockedNonLongCandidates = rows
    .filter((candidate) => candidateTradeSide(candidate) !== TARGET_TRADE_SIDE)
    .slice(0, 100)
    .map((candidate) => waitAction(
      normalizeCandidate(candidate),
      'SHORT_DISABLED_LONG_ONLY_SYSTEM',
      {
        skippedBeforeAnalyze: true,
        skippedBeforeLiveFetch: true,
        detectedScannerSide: candidateTradeSide(candidate)
      }
    ));

  return {
    ...snapshot,

    selectedSnapshotSource: meta.source || null,
    selectedSnapshotReason: meta.reason || null,
    selectedTargetCandidateCount: targetRows.length,
    selectedLongCandidateCount: targetRows.length,
    selectedOppositeCandidateCount: countOppositeCandidates(snapshot),
    selectedShortCandidateCount: countOppositeCandidates(snapshot),

    blockedNonLongCandidates,
    blockedNonLongCandidatesCount: rows.length - targetRows.length,

    // Backward-compatible admin field name.
    blockedNonShortCandidates: blockedNonLongCandidates,
    blockedNonShortCandidatesCount: rows.length - targetRows.length,

    ...sideFlags(),
    ...isolationFlags(),

    candidates: targetRows,
    candidatesCount: targetRows.length,
    longCandidatesCount: targetRows.length,
    shortCandidatesCount: 0,

    scannerGateCandidatesCount: targetRows.filter((row) => row.scannerGatePassed).length,
    analyzeOnlyCandidatesCount: targetRows.filter((row) => (
      row.tradeDiscoveryOnly ||
      row.discoveryOnly ||
      row.analyzeOnly
    )).length,

    topSymbols: targetRows
      .slice(0, 20)
      .map((row) => row.symbol)
      .filter(Boolean),

    scannerGateSymbols: targetRows
      .filter((row) => row.scannerGatePassed)
      .slice(0, 20)
      .map((row) => row.symbol)
      .filter(Boolean)
  };
}

async function getLatestSnapshot() {
  const volatileRedis = getVolatileRedis();

  const latest = await safeGetSnapshotJson(
    volatileRedis,
    LONG_KEYS.scan.latest,
    null
  );

  const latestSnapshotId = extractSnapshotId(latest);

  const candidates = [];

  if (hasFullSnapshotShape(latest)) {
    candidates.push({
      source: 'LONG:SCAN:LATEST_FULL_SNAPSHOT',
      snapshot: latest,
      targetCount: countTargetCandidates(latest),
      oppositeCount: countOppositeCandidates(latest),
      createdAt: snapshotCreatedAt(latest)
    });
  }

  if (latestSnapshotId) {
    const byId = await safeGetSnapshotJson(
      volatileRedis,
      LONG_KEYS.scan.snapshot(latestSnapshotId),
      null
    );

    if (hasFullSnapshotShape(byId)) {
      candidates.push({
        source: 'LONG:SCAN:SNAPSHOT_BY_LATEST_ID',
        snapshot: byId,
        targetCount: countTargetCandidates(byId),
        oppositeCount: countOppositeCandidates(byId),
        createdAt: snapshotCreatedAt(byId)
      });
    }
  }

  const recent = await loadRecentTargetSnapshots(volatileRedis);

  for (const item of recent) {
    candidates.push({
      source: `LONG:SCAN:RECENT_SEARCH:${item.key}`,
      snapshot: item.snapshot,
      targetCount: item.targetCount,
      oppositeCount: item.oppositeCount,
      createdAt: item.createdAt
    });
  }

  const unique = new Map();

  for (const item of candidates) {
    const id = item.snapshot?.snapshotId || item.source;

    if (!id) continue;

    const previous = unique.get(id);

    if (!previous) {
      unique.set(id, item);
      continue;
    }

    if (
      item.targetCount > previous.targetCount ||
      (
        item.targetCount === previous.targetCount &&
        item.createdAt > previous.createdAt
      )
    ) {
      unique.set(id, item);
    }
  }

  const sorted = [...unique.values()]
    .filter((item) => hasFullSnapshotShape(item.snapshot))
    .sort((a, b) => b.createdAt - a.createdAt);

  const latestAvailable = sorted[0] || null;

  if (!latestAvailable) return null;

  return normalizeSelectedSnapshot(latestAvailable.snapshot, {
    source: latestAvailable.source,
    reason: latestAvailable.targetCount > 0
      ? 'LATEST_LONG_SCANNER_SNAPSHOT'
      : 'LATEST_LONG_SCANNER_SNAPSHOT_WITH_NO_LONG_CANDIDATES'
  });
}

function enrichMetricsWithScannerAndLiveGates({
  metrics,
  candidate,
  ob
}) {
  const cfg = tradeConfig();
  const normalized = normalizeCandidate(candidate);
  const scannerMeta = scannerMetadataFrom(candidate, metrics);

  const spreadPct = safeNumber(
    metrics?.spreadPct ??
    ob?.spreadPct,
    0
  );

  const cleanMicroFamilyId = cleanLearningFamilyId(
    metrics.trueMicroFamilyId ||
    metrics.microFamilyId,
    normalized
  );

  const cleanCoarseMicroFamilyId = cleanLearningFamilyId(
    metrics.coarseMicroFamilyId ||
    metrics.baseMicroFamilyId ||
    metrics.legacyMicroFamilyId,
    normalized
  );

  const learningIds = cleanMicroFamilyId
    ? {
      microFamilyId: cleanMicroFamilyId,
      trueMicroFamilyId: cleanMicroFamilyId,
      coarseMicroFamilyId: cleanCoarseMicroFamilyId || cleanMicroFamilyId,
      baseMicroFamilyId: cleanCoarseMicroFamilyId || cleanMicroFamilyId,
      legacyMicroFamilyId: cleanCoarseMicroFamilyId || cleanMicroFamilyId
    }
    : {};

  const enriched = {
    ...metrics,
    ...learningIds,
    ...scannerMeta,
    ...sideFlags(),
    ...isolationFlags(),

    entryRelaxationProfile: cfg.entryRelaxationProfile,
    qualityMeasurementProfile: cfg.qualityMeasurementProfile,
    minLiveCandles15m: cfg.minLiveCandles15m,

    snapshotId: normalized.snapshotId || metrics.snapshotId || null,

    symbol: normalized.symbol || metrics.symbol,
    baseSymbol: normalized.baseSymbol || metrics.baseSymbol,
    contractSymbol: normalized.contractSymbol || metrics.contractSymbol,

    price: safeNumber(normalized.price ?? metrics.price ?? ob?.mid, 0),

    scannerScore: safeNumber(
      normalized.scannerScore ??
      normalized.moveScore ??
      metrics.scannerScore,
      0
    ),

    moveScore: safeNumber(
      normalized.moveScore ??
      normalized.scannerScore ??
      metrics.moveScore,
      0
    ),

    scannerReason: normalized.scannerReason || metrics.scannerReason || null,
    scannerTs: normalized.scannerTs || metrics.scannerTs || null,

    scannerGatePassed: normalized.scannerGatePassed !== false,
    scannerGateReason: normalized.scannerGateReason || null,

    analyzeEligible: normalized.analyzeEligible !== false,
    tradeDiscoveryOnly: Boolean(normalized.tradeDiscoveryOnly),
    discoveryOnly: Boolean(normalized.discoveryOnly),
    analyzeOnly: Boolean(normalized.analyzeOnly),

    isMirrorMicroFamily: false,
    observationMirror: false,
    analysisMirror: false,
    mirrorAnalysisOnly: false,
    mirrorOfSide: null,

    passesMoveFilter: normalized.passesMoveFilter !== false,
    passesVolumeFilter: normalized.passesVolumeFilter !== false,
    hasDirectionalSide: normalized.hasDirectionalSide !== false,

    sideConfidence: normalized.sideConfidence || metrics.sideConfidence || null,

    fakeBreakout: Boolean(normalized.fakeBreakout || metrics.fakeBreakout),
    fakeBreakoutRisk: Boolean(normalized.fakeBreakoutRisk || metrics.fakeBreakoutRisk),
    fakeBreakoutReason: normalized.fakeBreakoutReason || metrics.fakeBreakoutReason || null,
    breakoutType: normalized.breakoutType || metrics.breakoutType || null,

    pullbackConfirmed: Boolean(normalized.pullbackConfirmed || metrics.pullbackConfirmed),
    retestConfirmed: Boolean(normalized.retestConfirmed || metrics.retestConfirmed),
    sweepConfirmed: Boolean(normalized.sweepConfirmed || metrics.sweepConfirmed),

    spreadPct,
    liveSpreadPct: spreadPct,
    maxSpreadPct: cfg.maxSpreadPct,
    liveSpreadGatePassed: spreadPct <= cfg.maxSpreadPct,

    learningOnly: Boolean(metrics.learningOnly),

    validLongRiskShape: hasValidRiskShape({
      ...metrics,
      ...learningIds,
      ...sideFlags()
    }),

    longGrossRFormula: '(exitPrice - entry) / (entry - initialSl)',
    longCurrentRFormula: '(currentPrice - entry) / (entry - initialSl)',

    positionTimeStopMin: cfg.positionTimeStopMin,

    liveDataTs: now()
  };

  return {
    ...enriched,
    liveRiskValid: hasValidRiskShape(enriched)
  };
}

function buildObservationOnlyMetrics({
  normalized,
  data = {},
  reason = 'LONG_RISK_INVALID'
}) {
  const ob = data.ob || {};
  const spreadPct = safeNumber(
    ob.spreadPct ??
    normalized.spreadPct ??
    CONFIG.cost?.fallbackSpreadPct,
    0.0008
  );

  const mid = safeNumber(
    ob.mid ??
    normalized.price ??
    normalized.markPrice ??
    normalized.currentPrice,
    0
  );

  return enrichMetricsWithScannerAndLiveGates({
    metrics: {
      symbol: normalized.symbol,
      baseSymbol: normalized.baseSymbol,
      contractSymbol: normalized.contractSymbol,

      ...scannerMetadataFrom(normalized),
      ...sideFlags(),

      price: mid,

      entry: 0,
      sl: 0,
      tp: 0,
      rr: 0,

      riskPct: 0,
      rewardPct: 0,

      confluence: safeNumber(normalized.scannerScore ?? normalized.moveScore, 0),
      sniperScore: safeNumber(normalized.scannerScore ?? normalized.moveScore, 0),

      spreadPct,
      depthMinUsd1p: safeNumber(ob.depthMinUsd1p, 0),
      fundingRate: safeNumber(data.funding?.rate, 0),

      rsiZone: normalized.rsiZone || null,
      rsiCoarse: normalized.rsiCoarse || null,
      flow: normalized.flow || null,
      flowCoarse: normalized.flowCoarse || null,
      obRelation: normalized.obRelation || null,
      btcRelation: normalized.btcRelation || null,
      btcState: normalized.btcState || null,
      regime: normalized.regime || null,
      regimeCoarse: normalized.regimeCoarse || null,

      observationOnly: true,
      analysisInputOnly: true,
      learningOnly: true,
      liveRiskValid: false,
      liveEntryBlockedReason: reason,
      entryRelaxationProfile: ENTRY_RELAXATION_PROFILE,
      qualityMeasurementProfile: QUALITY_MEASUREMENT_PROFILE
    },
    candidate: {
      ...normalized,
      liveEntryBlockedReason: reason
    },
    ob
  });
}

function buildSyntheticLongRiskMetrics({
  normalized,
  data = {},
  reason = 'RISK_ENGINE_EMPTY_SYNTHETIC_LONG_RISK'
}) {
  const cfg = tradeConfig();
  const ob = data.ob || {};

  const spreadPct = safeNumber(
    ob.spreadPct ??
    normalized.spreadPct ??
    CONFIG.cost?.fallbackSpreadPct,
    0.0008
  );

  const mid = safeNumber(
    ob.mid ??
    normalized.price ??
    normalized.markPrice ??
    normalized.currentPrice,
    0
  );

  const scannerGatePassed = normalized.scannerGatePassed !== false;
  const analyzeEligible = normalized.analyzeEligible !== false;
  const spreadGatePassed = spreadPct <= cfg.maxSpreadPct;

  if (cfg.syntheticRiskRequiresScannerGatePassed && !scannerGatePassed) {
    return buildObservationOnlyMetrics({
      normalized,
      data,
      reason: 'SYNTHETIC_LONG_RISK_BLOCKED_SCANNER_GATE_FAILED'
    });
  }

  if (cfg.syntheticRiskRequiresAnalyzeEligible && !analyzeEligible) {
    return buildObservationOnlyMetrics({
      normalized,
      data,
      reason: 'SYNTHETIC_LONG_RISK_BLOCKED_ANALYZE_NOT_ELIGIBLE'
    });
  }

  if (cfg.syntheticRiskRequiresSpreadGatePassed && !spreadGatePassed) {
    return buildObservationOnlyMetrics({
      normalized,
      data,
      reason: 'SYNTHETIC_LONG_RISK_BLOCKED_SPREAD_TOO_WIDE'
    });
  }

  if (mid <= 0) {
    return buildObservationOnlyMetrics({
      normalized,
      data,
      reason: 'SYNTHETIC_LONG_RISK_NO_MID_PRICE'
    });
  }

  const rr = Math.max(
    cfg.minRR,
    cfg.defaultRR,
    0.5
  );

  const riskPct = clampNumber(
    cfg.fallbackRiskPct,
    Math.max(0.0005, cfg.minRiskPct),
    Math.max(cfg.minRiskPct, cfg.maxRiskPct)
  );

  const entry = mid;
  const sl = Math.max(entry * (1 - riskPct), entry * 0.0001);
  const tp = entry * (1 + riskPct * rr);
  const rewardPct = Math.max(0, (tp - entry) / entry);

  return enrichMetricsWithScannerAndLiveGates({
    metrics: {
      symbol: normalized.symbol,
      baseSymbol: normalized.baseSymbol,
      contractSymbol: normalized.contractSymbol,

      ...scannerMetadataFrom(normalized),
      ...sideFlags(),

      price: mid,

      entry,
      sl,
      tp,
      rr,

      riskPct,
      rewardPct,

      confluence: safeNumber(normalized.scannerScore ?? normalized.moveScore, 0),
      sniperScore: safeNumber(normalized.scannerScore ?? normalized.moveScore, 0),

      spreadPct,
      depthMinUsd1p: safeNumber(ob.depthMinUsd1p, 0),
      fundingRate: safeNumber(data.funding?.rate, 0),

      rsiZone: normalized.rsiZone || null,
      rsiCoarse: normalized.rsiCoarse || null,
      flow: normalized.flow || null,
      flowCoarse: normalized.flowCoarse || null,
      obRelation: normalized.obRelation || null,
      btcRelation: normalized.btcRelation || null,
      btcState: normalized.btcState || null,
      regime: normalized.regime || null,
      regimeCoarse: normalized.regimeCoarse || null,

      syntheticRisk: true,
      syntheticRiskReason: reason,
      syntheticRiskEntryRelaxed: true,
      syntheticRiskVirtualEntryAllowed: cfg.allowSyntheticRiskVirtualEntries,
      syntheticRiskQuality: 'EXPLICITLY_ENABLED_CONFIG_ONLY',

      observationOnly: false,
      analysisInputOnly: false,

      learningOnly: false,
      liveRiskValid: true,
      liveEntryBlockedReason: null,

      entryRelaxationProfile: cfg.entryRelaxationProfile,
      qualityMeasurementProfile: cfg.qualityMeasurementProfile
    },
    candidate: {
      ...normalized,
      liveEntryBlockedReason: null
    },
    ob
  });
}

function buildActualRiskWaitIfNeeded({
  normalized,
  scannerSide,
  metricsRows
}) {
  if (scannerSide !== TARGET_TRADE_SIDE) {
    return waitAction(
      {
        ...normalized,
        side: scannerSide,
        tradeSide: scannerSide
      },
      'SHORT_DISABLED_LONG_ONLY_SYSTEM'
    );
  }

  const hasLongMetrics = metricsRows.some((row) => (
    inferRowTradeSide(row) === TARGET_TRADE_SIDE &&
    hasValidRiskShape(row)
  ));

  if (hasLongMetrics) return null;

  return waitAction(
    {
      ...normalized,
      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE
    },
    'LONG_RISK_INVALID_OBSERVATION_ONLY'
  );
}

async function processCandidate(candidate) {
  const cfg = tradeConfig();
  const normalized = normalizeCandidate(candidate);

  if (!normalized.symbol || !normalized.contractSymbol) {
    return {
      actions: [waitAction(normalized, 'INVALID_SYMBOL')],
      metrics: []
    };
  }

  const scannerSide = inferRowTradeSide(normalized);

  if (scannerSide !== TARGET_TRADE_SIDE) {
    return {
      actions: [
        waitAction(
          {
            ...normalized,
            tradeSide: scannerSide,
            side: normalized.side
          },
          'SHORT_DISABLED_LONG_ONLY_SYSTEM',
          {
            skippedBeforeAnalyze: true,
            skippedBeforeLiveFetch: true,
            detectedScannerSide: scannerSide
          }
        )
      ],
      metrics: []
    };
  }

  const data = await fetchLiveCandidateData(normalized)
    .catch((error) => ({ error }));

  if (data.error || data.ob?.fetchFailed) {
    const fallback = buildObservationOnlyMetrics({
      normalized,
      data,
      reason: 'LIVE_DATA_FAILED'
    });

    return {
      actions: [
        waitAction(normalized, 'LIVE_DATA_FAILED', {
          error: data.error?.message || null
        })
      ],
      metrics: [fallback]
    };
  }

  const hasEnough15mCandles = (
    Array.isArray(data.candles15m) &&
    data.candles15m.length >= cfg.minLiveCandles15m
  );

  if (!hasEnough15mCandles) {
    const fallback = buildObservationOnlyMetrics({
      normalized,
      data,
      reason: 'INSUFFICIENT_LIVE_CANDLES_15M'
    });

    return {
      actions: [
        waitAction(normalized, 'INSUFFICIENT_LIVE_CANDLES_15M', {
          candleCount: data.candles15m?.length || 0,
          requiredCandleCount: cfg.minLiveCandles15m
        })
      ],
      metrics: [fallback]
    };
  }

  const generatedMetrics = buildRiskAndLiveMetricsForBothSides({
    candidate: {
      ...normalized,
      side: TARGET_TRADE_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      positionSide: TARGET_TRADE_SIDE,
      direction: TARGET_TRADE_SIDE
    },
    ob: data.ob,
    funding: data.funding,
    candles15m: data.candles15m,
    candles1h: data.candles1h,
    btcState: normalized.btcState || candidate.btcState,
    regime: normalized.regime || candidate.regime
  });

  const rawMetrics = Array.isArray(generatedMetrics)
    ? generatedMetrics
    : [];

  const metrics = rawMetrics
    .map((row) => {
      const rowSide = inferRowTradeSide(row);

      if (rowSide !== TARGET_TRADE_SIDE) return null;

      const variant = buildAnalysisVariant(
        normalized,
        TARGET_TRADE_SIDE,
        scannerSide
      );

      if (!variant) return null;

      return enrichMetricsWithScannerAndLiveGates({
        metrics: row,
        candidate: variant,
        ob: data.ob
      });
    })
    .filter(Boolean);

  const hasValidLongRisk = metrics.some(hasValidRiskShape);

  const finalMetrics = hasValidLongRisk
    ? metrics
    : [
      cfg.allowSyntheticRiskFallback
        ? buildSyntheticLongRiskMetrics({
          normalized,
          data,
          reason: 'RISK_ENGINE_EMPTY_SYNTHETIC_LONG_RISK'
        })
        : buildObservationOnlyMetrics({
          normalized,
          data,
          reason: 'RISK_ENGINE_EMPTY_LONG_RISK_OBSERVATION_ONLY'
        })
    ];

  const riskWait = buildActualRiskWaitIfNeeded({
    normalized,
    scannerSide,
    metricsRows: finalMetrics
  });

  return {
    actions: riskWait ? [riskWait] : [],
    metrics: finalMetrics
  };
}

async function safeProcessCandidate(candidate) {
  try {
    return await processCandidate(candidate);
  } catch (error) {
    const normalized = normalizeCandidate(candidate);

    return {
      actions: [
        waitAction(normalized, 'CANDIDATE_PROCESS_ERROR', {
          error: error?.message || String(error)
        })
      ],
      metrics: [
        buildObservationOnlyMetrics({
          normalized,
          reason: 'CANDIDATE_PROCESS_ERROR'
        })
      ]
    };
  }
}

function buildVirtualEntryAction({
  row,
  alertContext,
  selectedWeeklyStats,
  riskFraction,
  virtualGate,
  discordAlertEligible
}) {
  const microFamilyId = rowMicroId(row);
  const coarseMicroFamilyId = rowCoarseMicroId(row) || microFamilyId;

  const selectedMacroFamilyId =
    parentMacroFamilyId(row) ||
    alertContext.microToMacroFamilyId[microFamilyId] ||
    null;

  return {
    ...row,

    microFamilyId,
    trueMicroFamilyId: microFamilyId,

    coarseMicroFamilyId,
    baseMicroFamilyId: row.baseMicroFamilyId && !isScannerFamilyId(row.baseMicroFamilyId)
      ? cleanLearningFamilyId(row.baseMicroFamilyId, row)
      : coarseMicroFamilyId,
    legacyMicroFamilyId: row.legacyMicroFamilyId && !isScannerFamilyId(row.legacyMicroFamilyId)
      ? cleanLearningFamilyId(row.legacyMicroFamilyId, row)
      : coarseMicroFamilyId,

    ...scannerMetadataFrom(row),
    ...sideFlags(),
    ...virtualFlags(),
    ...isolationFlags(),

    action: 'VIRTUAL_ENTRY',
    reason: row.syntheticRisk
      ? 'LONG_VIRTUAL_RISK_VALID_SYNTHETIC_EXPLICITLY_ENABLED'
      : 'LONG_VIRTUAL_RISK_VALID',

    shadowOnly: false,

    selectedRotationId: alertContext.rotationId,
    activeRotationId: alertContext.rotationId,

    selectedMicroFamilyAlert: Boolean(discordAlertEligible),
    discordAlertEligible: Boolean(discordAlertEligible),
    discordAlertReason: discordAlertEligible
      ? 'SELECTED_LONG_TRUE_MICRO_FAMILY_EXACT_MATCH'
      : alertContext.empty
        ? 'NO_MANUAL_MICRO_FAMILY_SELECTED'
        : 'MICRO_FAMILY_NOT_SELECTED_FOR_DISCORD_ALERT',

    selectedMacroFamilyId,
    activeMacroFamilyId: selectedMacroFamilyId,

    selectedWeeklyStats,
    weeklyStats: selectedWeeklyStats,

    riskFraction,
    virtualGate,

    btcRelation: row.btcRelation,

    liveEligible: Boolean(discordAlertEligible),

    outcomeIdentityLocked: true,
    outcomeIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    learningIdentitySource: 'ANALYZE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,

    validLongRiskShape: true,
    longGrossRFormula: '(exitPrice - entry) / (entry - initialSl)',
    longCurrentRFormula: '(currentPrice - entry) / (entry - initialSl)',
    positionTimeStopMin: tradeConfig().positionTimeStopMin,

    entryRelaxationProfile: ENTRY_RELAXATION_PROFILE,
    qualityMeasurementProfile: QUALITY_MEASUREMENT_PROFILE,

    entryCreatedAt: now()
  };
}

function maybeSendDiscordEntryAlert(entry = {}) {
  if (!entry.discordAlertEligible) {
    return {
      sent: false,
      skipped: true,
      queued: false,
      reason: entry.discordAlertReason || 'MICRO_FAMILY_NOT_SELECTED_FOR_DISCORD_ALERT'
    };
  }

  sendEntryAlert(entry).catch(() => null);

  return {
    sent: false,
    skipped: false,
    queued: true,
    fireAndForget: true,
    reason: 'DISCORD_ENTRY_ALERT_QUEUED_FIRE_AND_FORGET'
  };
}

function inferPrimaryBottleneck({
  candidates,
  processed,
  liveRows,
  riskValidRows,
  analyzedRows,
  analyzedRiskValidRows,
  virtualCreatedRows,
  virtualExitRows,
  openPositionCountAfterEntries,
  actionCountMap
}) {
  if (candidates <= 0) return 'NO_LONG_CANDIDATES';
  if (processed <= 0) return 'NO_CANDIDATES_PROCESSED';
  if (liveRows <= 0) return 'NO_LIVE_ROWS';

  if ((actionCountMap?.SNAPSHOT_ALREADY_PROCESSED || 0) > 0) {
    return 'SNAPSHOT_ALREADY_PROCESSED';
  }

  if ((actionCountMap?.SNAPSHOT_TOO_STALE || 0) > 0) {
    return 'SNAPSHOT_TOO_STALE';
  }

  if (riskValidRows <= 0) {
    return 'RISK_ENGINE_OR_LIVE_RISK_SHAPE';
  }

  if (analyzedRows <= 0) {
    return 'ANALYZE_RETURNED_NO_TARGET_ROWS';
  }

  if (analyzedRiskValidRows <= 0) {
    return 'ANALYZE_REMOVED_OR_DID_NOT_CONFIRM_RISK_ROWS';
  }

  if (virtualCreatedRows <= 0) {
    return 'VIRTUAL_ENTRY_GATE_OR_SYMBOL_LOCK';
  }

  if (virtualCreatedRows > 0 && virtualExitRows <= 0 && openPositionCountAfterEntries > 0) {
    return 'POSITIONS_OPEN_WAITING_FOR_OUTCOMES';
  }

  if (virtualCreatedRows > 0 && virtualExitRows > 0) {
    return 'HEALTHY_OUTCOME_PIPELINE';
  }

  return 'PIPELINE_ACTIVE_MONITOR_REQUIRED';
}

function buildQualityAudit({
  snapshot,
  candidates,
  processed,
  liveRows,
  analyzedRowsRaw,
  analyzedRows,
  actions,
  actionCountMap,
  virtualExits,
  counts,
  openPositionCountBeforeEntries,
  openPositionCountAfterEntries
}) {
  const candidateCount = candidates.length;
  const processedCount = processed.length;
  const liveRowsCount = liveRows.length;
  const analyzedRowsRawCount = analyzedRowsRaw.length;
  const analyzedRowsCount = analyzedRows.length;

  const virtualExitRows = virtualExits.length;

  const riskValidRows = counts.riskValidRows;
  const analyzedRiskValidRows = counts.analyzedRiskValidRows;
  const entryRows = counts.entryRows;
  const virtualCreatedRows = counts.virtualCreatedRows;
  const waitRows = counts.waitRows;

  const primaryBottleneck = inferPrimaryBottleneck({
    candidates: candidateCount,
    processed: processedCount,
    liveRows: liveRowsCount,
    riskValidRows,
    analyzedRows: analyzedRowsCount,
    analyzedRiskValidRows,
    virtualCreatedRows,
    virtualExitRows,
    openPositionCountAfterEntries,
    actionCountMap
  });

  const waitReasons = topReasonCounts(actions, 12);

  return {
    profile: QUALITY_MEASUREMENT_PROFILE,
    entryRelaxationProfile: ENTRY_RELAXATION_PROFILE,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    noSyntheticShadowLayer: true,
    syntheticRiskDefaultEnabled: DEFAULT_ALLOW_SYNTHETIC_RISK_FALLBACK,
    completedIsPureClosedVirtualOutcome: true,

    recommendedFreezeDays: FREEZE_MEASUREMENT_RECOMMENDED_DAYS,

    completedThresholds: {
      earlySignal: MIN_COMPLETED_EARLY_SIGNAL,
      reasonableSignal: MIN_COMPLETED_REASONABLE_SIGNAL,
      strongSignal: MIN_COMPLETED_STRONG_SIGNAL
    },

    snapshot: {
      snapshotId: snapshot?.snapshotId || null,
      selectedSnapshotSource: snapshot?.selectedSnapshotSource || null,
      selectedSnapshotReason: snapshot?.selectedSnapshotReason || null,
      selectedTargetCandidateCount: snapshot?.selectedTargetCandidateCount || 0,
      selectedLongCandidateCount: snapshot?.selectedLongCandidateCount || 0,
      selectedOppositeCandidateCount: snapshot?.selectedOppositeCandidateCount || 0,
      selectedShortCandidateCount: snapshot?.selectedShortCandidateCount || 0
    },

    pipelineCounts: {
      candidates: candidateCount,
      processed: processedCount,
      liveRows: liveRowsCount,
      riskValidRows,
      analyzedRowsRaw: analyzedRowsRawCount,
      analyzedRows: analyzedRowsCount,
      analyzedRiskValidRows,
      entryRows,
      virtualCreatedRows,
      virtualExitRows,
      waitRows,
      openPositionCountBeforeEntries,
      openPositionCountAfterEntries
    },

    conversionRatesPct: {
      processedPerCandidate: pct(processedCount, candidateCount),
      liveRowsPerCandidate: pct(liveRowsCount, candidateCount),
      riskValidPerLiveRow: pct(riskValidRows, liveRowsCount),
      analyzedPerLiveRow: pct(analyzedRowsCount, liveRowsCount),
      analyzedRiskValidPerAnalyzed: pct(analyzedRiskValidRows, analyzedRowsCount),
      virtualCreatedPerAnalyzedRiskValid: pct(virtualCreatedRows, analyzedRiskValidRows),
      virtualExitPerCreatedThisRun: pct(virtualExitRows, virtualCreatedRows)
    },

    primaryBottleneck,
    topWaitReasons: waitReasons,

    interpretation: {
      ifVirtualCreatedLow: 'Entry/gating/risk pipeline geeft te weinig nieuwe outcome-kansen.',
      ifVirtualCreatedHighAndExitLow: 'Posities lopen nog; completed komt later via TP/SL/TIME_STOP.',
      ifRiskValidLow: 'RiskEngine of live risk shape is waarschijnlijk de bottleneck.',
      ifAnalyzedRiskValidLow: 'Analyze/microfamily-filter bevestigt te weinig geldige risk rows.',
      ifSymbolAlreadyOpenHigh: 'Eén open positie per symbol blokkeert extra entries, bewust kwaliteitsfilter.',
      ifSnapshotAlreadyProcessedHigh: 'Trade-run verwerkt geen nieuwe entries totdat scanner een nieuwe snapshot levert.'
    },

    doNotChangeDuringFreeze: [
      'microFamilies',
      'riskEngine',
      'positionEngine',
      'scoring',
      'scanner thresholds',
      'time-stop',
      'synthetic shadow layer'
    ],

    measurementPrinciple: 'Eén zuivere completed-meting lang genoeg volhouden; niet kunstmatig completed-volume toevoegen.'
  };
}

async function scopedSetJson(redis, key, value, options = {}) {
  try {
    assertKeyAllowedForWriteScope(
      KEYS.scopes?.TRADE_RUN || 'TRADE_RUN',
      key
    );
  } catch (error) {
    if (!String(key || '').startsWith(LONG_KEY_PREFIX)) {
      throw error;
    }
  }

  return setJson(redis, key, value, options);
}

async function saveRunMeta(result) {
  const durableRedis = getDurableRedis();

  const completedAt = now();

  const virtualExits = Array.isArray(result.virtualExits)
    ? result.virtualExits
    : Array.isArray(result.shadowExits)
      ? result.shadowExits
      : [];

  const virtualExitActions = buildVirtualExitActions(virtualExits);

  const finalResult = {
    ok: true,
    ...result,

    entryRelaxationProfile: ENTRY_RELAXATION_PROFILE,
    qualityMeasurementProfile: QUALITY_MEASUREMENT_PROFILE,

    ...sideFlags(),
    ...virtualFlags(),
    ...isolationFlags(),

    longKeys: {
      scanLatest: LONG_KEYS.scan.latest,
      tradeRunMeta: LONG_KEYS.trade.runMeta,
      tradeLastProcessedSnapshot: LONG_KEYS.trade.lastProcessedSnapshot,
      scanSnapshotPattern: LONG_KEYS.scan.snapshotPattern()
    },

    virtualExits,
    shadowExits: Array.isArray(result.shadowExits) ? result.shadowExits : virtualExits,
    realExits: [],

    virtualExitRows: virtualExits.length,
    shadowExitRows: virtualExits.length,
    realExitRows: 0,

    virtualExitActions,

    skipReason: result.skipReason || result.reason || null,

    completedAt,
    durationMs: completedAt - safeNumber(result.startedAt, completedAt),
    actionCounts: result.actionCounts || buildRunActionCounts(result.actions || [], virtualExits),
    qualityAudit: result.qualityAudit || null
  };

  await scopedSetJson(
    durableRedis,
    LONG_KEYS.trade.runMeta,
    finalResult
  );

  return finalResult;
}

export async function runTradeSystem(options = {}) {
  const cfg = tradeConfig();
  const sizing = sizingConfig();

  const durableRedis = getDurableRedis();

  const runId = randomId('trade_run_long');
  const startedAt = now();

  const forceProcessSnapshot = Boolean(options.forceProcessSnapshot || options.force);
  const monitorOnly = Boolean(options.monitorOnly);

  const priceFetcher = async (symbol) => fetchMidPrice(symbol);

  const realExits = [];

  const virtualExits = await monitorOpenPositions({ priceFetcher });
  const shadowExits = virtualExits;

  if (monitorOnly) {
    const actions = [];

    return saveRunMeta({
      runId,
      startedAt,
      actions,
      realExits,
      virtualExits,
      shadowExits,
      entryRows: 0,
      waitRows: 0,
      virtualCreatedRows: 0,
      skippedNewEntries: true,
      reason: 'MONITOR_ONLY',
      actionCounts: buildRunActionCounts(actions, virtualExits),
      monitorOpenPositions: true,
      monitorOpenPositionsFirst: true,
      processScannerSnapshot: false,
      ...isolationFlags()
    });
  }

  const snapshot = await getLatestSnapshot();

  if (!snapshot?.snapshotId) {
    const actions = [];

    return saveRunMeta({
      runId,
      startedAt,
      actions,
      realExits,
      virtualExits,
      shadowExits,
      entryRows: 0,
      waitRows: 0,
      virtualCreatedRows: 0,
      skippedNewEntries: true,
      reason: 'NO_LONG_SCANNER_SNAPSHOT',
      actionCounts: buildRunActionCounts(actions, virtualExits),
      monitorOpenPositions: true,
      monitorOpenPositionsFirst: true,
      processScannerSnapshot: true,
      ...isolationFlags()
    });
  }

  const snapshotAgeSec = (now() - safeNumber(snapshot.createdAt, 0)) / 1000;

  if (snapshotAgeSec > cfg.maxSnapshotAgeSec) {
    const actions = Array.isArray(snapshot.blockedNonLongCandidates)
      ? snapshot.blockedNonLongCandidates
      : [];

    return saveRunMeta({
      runId,
      startedAt,
      snapshotId: snapshot.snapshotId,
      snapshotAgeSec: Math.round(snapshotAgeSec),
      selectedSnapshotSource: snapshot.selectedSnapshotSource || null,
      selectedSnapshotReason: snapshot.selectedSnapshotReason || null,
      selectedTargetCandidateCount: snapshot.selectedTargetCandidateCount || 0,
      selectedLongCandidateCount: snapshot.selectedLongCandidateCount || 0,
      selectedOppositeCandidateCount: snapshot.selectedOppositeCandidateCount || 0,
      selectedShortCandidateCount: snapshot.selectedShortCandidateCount || 0,
      blockedNonLongCandidatesCount: snapshot.blockedNonLongCandidatesCount || 0,
      blockedNonShortCandidatesCount: snapshot.blockedNonShortCandidatesCount || 0,
      actions,
      realExits,
      virtualExits,
      shadowExits,
      entryRows: 0,
      waitRows: actions.length,
      virtualCreatedRows: 0,
      skippedNewEntries: true,
      reason: 'SNAPSHOT_TOO_STALE',
      actionCounts: buildRunActionCounts(actions, virtualExits),
      monitorOpenPositions: true,
      monitorOpenPositionsFirst: true,
      processScannerSnapshot: false,
      ...isolationFlags()
    });
  }

  const lastProcessed = await getJson(
    durableRedis,
    LONG_KEYS.trade.lastProcessedSnapshot,
    null
  );

  const sameSnapshot = lastProcessed?.snapshotId === snapshot.snapshotId;

  if (sameSnapshot && !forceProcessSnapshot) {
    const actions = Array.isArray(snapshot.blockedNonLongCandidates)
      ? snapshot.blockedNonLongCandidates
      : [];

    return saveRunMeta({
      runId,
      startedAt,
      snapshotId: snapshot.snapshotId,
      selectedSnapshotSource: snapshot.selectedSnapshotSource || null,
      selectedSnapshotReason: snapshot.selectedSnapshotReason || null,
      selectedTargetCandidateCount: snapshot.selectedTargetCandidateCount || 0,
      selectedLongCandidateCount: snapshot.selectedLongCandidateCount || 0,
      selectedOppositeCandidateCount: snapshot.selectedOppositeCandidateCount || 0,
      selectedShortCandidateCount: snapshot.selectedShortCandidateCount || 0,
      blockedNonLongCandidatesCount: snapshot.blockedNonLongCandidatesCount || 0,
      blockedNonShortCandidatesCount: snapshot.blockedNonShortCandidatesCount || 0,
      actions,
      realExits,
      virtualExits,
      shadowExits,
      entryRows: 0,
      waitRows: actions.length,
      virtualCreatedRows: 0,
      skippedNewEntries: true,
      reason: 'SNAPSHOT_ALREADY_PROCESSED',
      actionCounts: buildRunActionCounts(actions, virtualExits),
      monitorOpenPositions: true,
      monitorOpenPositionsFirst: true,
      processScannerSnapshot: false,
      ...isolationFlags()
    });
  }

  const activeRotation = await getActiveRotation();
  const alertContext = buildSelectedAlertContext(activeRotation);

  const preAnalyzeBlockedActions = Array.isArray(snapshot.blockedNonLongCandidates)
    ? snapshot.blockedNonLongCandidates
    : [];

  const candidates = (Array.isArray(snapshot.candidates) ? snapshot.candidates : [])
    .filter((candidate) => candidateTradeSide(candidate) === TARGET_TRADE_SIDE)
    .slice(0, cfg.maxCandidatesPerSnapshot)
    .map((candidate) => ({
      ...candidate,
      ...scannerMetadataFrom(candidate),
      ...sideFlags(),
      ...isolationFlags(),

      btcState: snapshot.btcState,
      regime: snapshot.regime
    }));

  const longCandidateCount = candidates.length;
  const nonLongCandidateCount = snapshot.blockedNonLongCandidatesCount || 0;

  const processed = await mapConcurrent(
    candidates,
    cfg.dataConcurrency,
    safeProcessCandidate
  );

  const earlyActions = [
    ...preAnalyzeBlockedActions,
    ...processed
      .flatMap((row) => Array.isArray(row?.actions) ? row.actions : [])
      .filter(Boolean)
  ];

  const liveRows = processed
    .flatMap((row) => Array.isArray(row?.metrics) ? row.metrics : [])
    .filter(Boolean)
    .filter(isTargetRow)
    .map((row) => ({
      ...row,
      ...isolationFlags()
    }));

  const actualLiveRows = liveRows.filter(isLiveScannerRow).length;
  const mirrorRows = liveRows.filter(isMirrorAnalysisRow).length;
  const observationOnlyRows = liveRows.filter((row) => row.observationOnly || row.analysisInputOnly).length;
  const syntheticRiskRows = liveRows.filter((row) => row.syntheticRisk).length;
  const learningOnlyRows = liveRows.filter((row) => row.learningOnly).length;
  const riskValidRows = liveRows.filter(hasValidRiskShape).length;

  let analyzedRowsRaw = [];
  let analyzeError = null;

  try {
    analyzedRowsRaw = await analyzeCandidatesBatch(liveRows);
  } catch (error) {
    analyzeError = error?.message || String(error);
    analyzedRowsRaw = [];
  }

  const analyzedRows = analyzedRowsRaw
    .filter(Boolean)
    .filter(isTargetRow)
    .filter((row) => !isMirrorAnalysisRow(row))
    .map((row) => ({
      ...row,
      ...isolationFlags()
    }));

  const analyzedActualRows = analyzedRows.filter(isLiveScannerRow).length;
  const analyzedMirrorRows = analyzedRows.filter(isMirrorAnalysisRow).length;
  const analyzedRiskValidRows = analyzedRows.filter(hasValidRiskShape).length;
  const analyzedSyntheticRiskRows = analyzedRows.filter((row) => row.syntheticRisk).length;

  const openPositions = await getOpenPositions();
  const openPositionCountBeforeEntries = openPositions.length;

  const actions = [...earlyActions];

  let entryRows = 0;
  let waitRows = earlyActions.length;

  let virtualCreatedRows = 0;
  let virtualSkippedRows = 0;
  let virtualFailedRows = 0;

  let discordAlertEligibleRows = 0;
  let discordAlertsQueued = 0;
  let discordAlertsSkippedNoSelectedMicro = 0;

  let selectedMicroMatchRows = 0;
  let unselectedMicroEntryRows = 0;

  for (const row of analyzedRows) {
    const microFamilyId = rowMicroId(row);

    if (!isTargetRow(row)) {
      waitRows += 1;
      virtualSkippedRows += 1;

      actions.push({
        ...row,
        microFamilyId,
        trueMicroFamilyId: microFamilyId,
        action: 'WAIT',
        reason: 'SHORT_DISABLED_LONG_ONLY_SYSTEM',
        selectedRotationId: alertContext.rotationId,
        activeRotationId: alertContext.rotationId,
        virtualTracked: false,
        liveEligible: false,
        ...sideFlags(),
        ...isolationFlags()
      });

      continue;
    }

    const virtualGate = validateVirtualEntry(row);

    if (!virtualGate.ok) {
      waitRows += 1;
      virtualSkippedRows += 1;

      actions.push({
        ...row,
        microFamilyId,
        trueMicroFamilyId: microFamilyId,
        action: 'WAIT',
        reason: virtualGate.reason,
        selectedRotationId: alertContext.rotationId,
        activeRotationId: alertContext.rotationId,
        activeMacroFamilyId: parentMacroFamilyId(row) || null,
        virtualGate,
        virtualTracked: false,
        liveEligible: false,
        ...sideFlags(),
        ...isolationFlags()
      });

      continue;
    }

    const alreadyOpen = await getOpenPosition(row.symbol);

    if (alreadyOpen) {
      waitRows += 1;
      virtualSkippedRows += 1;

      actions.push({
        ...row,
        microFamilyId,
        trueMicroFamilyId: microFamilyId,
        action: 'WAIT',
        reason: 'SYMBOL_ALREADY_OPEN_VIRTUAL_POSITION',
        selectedRotationId: alertContext.rotationId,
        activeRotationId: alertContext.rotationId,
        virtualTracked: true,
        liveEligible: false,
        ...sideFlags(),
        ...isolationFlags()
      });

      continue;
    }

    const selectedWeeklyStats = getSelectedWeeklyStats(
      alertContext,
      microFamilyId,
      row
    );

    const sizingStats = selectedWeeklyStats || row;

    const riskFraction = sizing.enabled
      ? riskFractionForEntry({
        weeklyStats: sizingStats,
        side: TARGET_DASHBOARD_SIDE,
        tradeSide: TARGET_TRADE_SIDE
      })
      : sizing.baseRiskPct;

    const discordAlertEligible = rowMatchesSelectedAlertMicro(alertContext, row);

    if (discordAlertEligible) {
      discordAlertEligibleRows += 1;
      selectedMicroMatchRows += 1;
    } else {
      discordAlertsSkippedNoSelectedMicro += 1;
      unselectedMicroEntryRows += 1;
    }

    const entry = buildVirtualEntryAction({
      row,
      alertContext,
      selectedWeeklyStats,
      riskFraction,
      virtualGate,
      discordAlertEligible
    });

    try {
      const position = buildOpenPositionFromEntry(entry);

      await saveOpenPosition({
        ...position,
        ...isolationFlags()
      });

      openPositions.push(position);

      entryRows += 1;
      virtualCreatedRows += 1;

      const discordResult = maybeSendDiscordEntryAlert(entry);

      if (discordResult.queued) discordAlertsQueued += 1;

      actions.push({
        ...entry,
        discordAlertResult: discordResult,
        discordAlertQueued: Boolean(discordResult.queued),
        discordAlertSent: false,
        ...isolationFlags()
      });
    } catch (error) {
      waitRows += 1;
      virtualFailedRows += 1;

      actions.push({
        ...row,
        microFamilyId,
        trueMicroFamilyId: microFamilyId,
        action: 'WAIT',
        reason: 'VIRTUAL_POSITION_CREATE_FAILED',
        error: error?.message || String(error),
        selectedRotationId: alertContext.rotationId,
        activeRotationId: alertContext.rotationId,
        virtualTracked: false,
        liveEligible: false,
        ...sideFlags(),
        ...isolationFlags()
      });
    }
  }

  const counts = buildRunActionCounts(actions, virtualExits);

  const qualityAudit = buildQualityAudit({
    snapshot,
    candidates,
    processed,
    liveRows,
    analyzedRowsRaw,
    analyzedRows,
    actions,
    actionCountMap: counts,
    virtualExits,
    counts: {
      riskValidRows,
      analyzedRiskValidRows,
      entryRows,
      virtualCreatedRows,
      waitRows
    },
    openPositionCountBeforeEntries,
    openPositionCountAfterEntries: openPositions.length
  });

  await scopedSetJson(
    durableRedis,
    LONG_KEYS.trade.lastProcessedSnapshot,
    {
      snapshotId: snapshot.snapshotId,
      processedAt: now(),
      forceProcessSnapshot,

      selectedSnapshotSource: snapshot.selectedSnapshotSource || null,
      selectedSnapshotReason: snapshot.selectedSnapshotReason || null,
      selectedTargetCandidateCount: snapshot.selectedTargetCandidateCount || 0,
      selectedLongCandidateCount: snapshot.selectedLongCandidateCount || 0,
      selectedOppositeCandidateCount: snapshot.selectedOppositeCandidateCount || 0,
      selectedShortCandidateCount: snapshot.selectedShortCandidateCount || 0,
      blockedNonLongCandidatesCount: snapshot.blockedNonLongCandidatesCount || 0,
      blockedNonShortCandidatesCount: snapshot.blockedNonShortCandidatesCount || 0,

      entryRelaxationProfile: cfg.entryRelaxationProfile,
      qualityMeasurementProfile: cfg.qualityMeasurementProfile,
      minLiveCandles15m: cfg.minLiveCandles15m,
      allowSyntheticRiskFallback: cfg.allowSyntheticRiskFallback,
      allowSyntheticRiskVirtualEntries: cfg.allowSyntheticRiskVirtualEntries,
      syntheticRiskRequiresScannerGatePassed: cfg.syntheticRiskRequiresScannerGatePassed,
      syntheticRiskRequiresAnalyzeEligible: cfg.syntheticRiskRequiresAnalyzeEligible,
      syntheticRiskRequiresSpreadGatePassed: cfg.syntheticRiskRequiresSpreadGatePassed,
      minRiskPct: cfg.minRiskPct,
      maxRiskPct: cfg.maxRiskPct,
      fallbackRiskPct: cfg.fallbackRiskPct,

      ...sideFlags(),
      ...virtualFlags(),
      ...isolationFlags(),

      candidates: candidates.length,
      longCandidateCount,
      shortCandidateCount: 0,
      nonLongCandidateCount,

      processed: processed.length,
      earlyActions: earlyActions.length,

      liveRows: liveRows.length,
      analyzeInputRows: liveRows.length,
      actualLiveRows,
      mirrorRows,
      observationOnlyRows,
      syntheticRiskRows,
      learningOnlyRows,
      riskValidRows,

      analyzedRows: analyzedRows.length,
      analyzedRowsRaw: analyzedRowsRaw.length,
      analyzedActualRows,
      analyzedMirrorRows,
      analyzedRiskValidRows,
      analyzedSyntheticRiskRows,

      analyzeError,

      entryRows,
      waitRows,

      virtualCreatedRows,
      virtualSkippedRows,
      virtualFailedRows,

      shadowCreatedRows: virtualCreatedRows,
      shadowSkippedRows: virtualSkippedRows,
      shadowFailedRows: virtualFailedRows,
      shadowDisabled: false,

      virtualExits,
      shadowExits,
      realExits: [],

      virtualExitRows: virtualExits.length,
      shadowExitRows: shadowExits.length,
      realExitRows: 0,

      discordAlertEligibleRows,
      discordAlertsQueued,
      discordAlertsSent: 0,
      discordAlertsSkippedNoSelectedMicro,

      selectedMicroMatchRows,
      unselectedMicroEntryRows,

      openPositionCountBeforeEntries,
      openPositionCountAfterEntries: openPositions.length,

      actions: actions.length,
      actionCounts: counts,
      qualityAudit,

      selectedRotationId: alertContext.rotationId,
      activeRotationId: alertContext.rotationId,

      selectedMicroFamilies: alertContext.selectedMicroFamilyIds.length,
      selectedMacroFamilies: alertContext.selectedMacroFamilyIds.length,
      selectedMicroFamilyIds: alertContext.selectedMicroFamilyIds,
      selectedMicroAliasIds: alertContext.selectedMicroAliasIds,
      selectedMacroFamilyIds: alertContext.selectedMacroFamilyIds,

      activeMicroFamilies: alertContext.selectedMicroFamilyIds.length,
      activeMacroFamilies: alertContext.selectedMacroFamilyIds.length,
      activeMicroFamilyIds: alertContext.selectedMicroFamilyIds,
      activeMicroAliasIds: alertContext.selectedMicroAliasIds,
      activeMacroFamilyIds: alertContext.selectedMacroFamilyIds,

      trueMicroOnly: alertContext.trueMicroOnly,
      exactTrueMicroOnly: true,
      allowCoarseMicroAliasLiveEntries: false,
      allowCoarseMicroAliasForDiscord: false,

      selectionPurpose: 'DISCORD_ALERT_ONLY',

      monitorOpenPositions: true,
      monitorOpenPositionsFirst: true,
      processScannerSnapshot: true
    }
  );

  return saveRunMeta({
    runId,
    startedAt,

    snapshotId: snapshot.snapshotId,
    snapshotCreatedAt: snapshot.createdAt,
    snapshotAgeSec: Math.round(snapshotAgeSec),

    selectedSnapshotSource: snapshot.selectedSnapshotSource || null,
    selectedSnapshotReason: snapshot.selectedSnapshotReason || null,
    selectedTargetCandidateCount: snapshot.selectedTargetCandidateCount || 0,
    selectedLongCandidateCount: snapshot.selectedLongCandidateCount || 0,
    selectedOppositeCandidateCount: snapshot.selectedOppositeCandidateCount || 0,
    selectedShortCandidateCount: snapshot.selectedShortCandidateCount || 0,
    blockedNonLongCandidatesCount: snapshot.blockedNonLongCandidatesCount || 0,
    blockedNonShortCandidatesCount: snapshot.blockedNonShortCandidatesCount || 0,

    entryRelaxationProfile: cfg.entryRelaxationProfile,
    qualityMeasurementProfile: cfg.qualityMeasurementProfile,
    minLiveCandles15m: cfg.minLiveCandles15m,
    allowSyntheticRiskFallback: cfg.allowSyntheticRiskFallback,
    allowSyntheticRiskVirtualEntries: cfg.allowSyntheticRiskVirtualEntries,
    syntheticRiskRequiresScannerGatePassed: cfg.syntheticRiskRequiresScannerGatePassed,
    syntheticRiskRequiresAnalyzeEligible: cfg.syntheticRiskRequiresAnalyzeEligible,
    syntheticRiskRequiresSpreadGatePassed: cfg.syntheticRiskRequiresSpreadGatePassed,
    minRiskPct: cfg.minRiskPct,
    maxRiskPct: cfg.maxRiskPct,
    fallbackRiskPct: cfg.fallbackRiskPct,

    ...sideFlags(),
    ...virtualFlags(),
    ...isolationFlags(),

    candidates: candidates.length,
    longCandidateCount,
    shortCandidateCount: 0,
    nonLongCandidateCount,

    processed: processed.length,
    earlyActions: earlyActions.length,

    liveRows: liveRows.length,
    analyzeInputRows: liveRows.length,
    actualLiveRows,
    mirrorRows,
    observationOnlyRows,
    syntheticRiskRows,
    learningOnlyRows,
    riskValidRows,

    analyzedRows: analyzedRows.length,
    analyzedRowsRaw: analyzedRowsRaw.length,
    analyzedActualRows,
    analyzedMirrorRows,
    analyzedRiskValidRows,
    analyzedSyntheticRiskRows,

    analyzeError,

    entryRows,
    waitRows,

    virtualCreatedRows,
    virtualSkippedRows,
    virtualFailedRows,

    shadowCreatedRows: virtualCreatedRows,
    shadowSkippedRows: virtualSkippedRows,
    shadowFailedRows: virtualFailedRows,
    shadowDisabled: false,

    virtualExits,
    shadowExits,
    realExits: [],

    virtualExitRows: virtualExits.length,
    shadowExitRows: shadowExits.length,
    realExitRows: 0,

    discordAlertEligibleRows,
    discordAlertsQueued,
    discordAlertsSent: 0,
    discordAlertsSkippedNoSelectedMicro,

    selectedMicroMatchRows,
    unselectedMicroEntryRows,

    openPositionCountBeforeEntries,
    openPositionCountAfterEntries: openPositions.length,

    actions,
    actionCounts: counts,
    qualityAudit,

    selectedRotationId: alertContext.rotationId,
    activeRotationId: alertContext.rotationId,

    selectedMicroFamilies: alertContext.selectedMicroFamilyIds.length,
    selectedMacroFamilies: alertContext.selectedMacroFamilyIds.length,
    selectedMicroFamilyIds: alertContext.selectedMicroFamilyIds,
    selectedMicroAliasIds: alertContext.selectedMicroAliasIds,
    selectedMacroFamilyIds: alertContext.selectedMacroFamilyIds,

    activeMicroFamilies: alertContext.selectedMicroFamilyIds.length,
    activeMacroFamilies: alertContext.selectedMacroFamilyIds.length,
    activeMicroFamilyIds: alertContext.selectedMicroFamilyIds,
    activeMicroAliasIds: alertContext.selectedMicroAliasIds,
    activeMacroFamilyIds: alertContext.selectedMacroFamilyIds,

    trueMicroOnly: alertContext.trueMicroOnly,
    exactTrueMicroOnly: true,
    allowCoarseMicroAliasLiveEntries: false,
    allowCoarseMicroAliasForDiscord: false,

    selectionPurpose: 'DISCORD_ALERT_ONLY',

    scannerSnapshotStats: {
      candidatesCount: snapshot.candidatesCount || candidates.length,
      scannerGateCandidatesCount: snapshot.scannerGateCandidatesCount || null,
      analyzeOnlyCandidatesCount: snapshot.analyzeOnlyCandidatesCount || null,
      filteredUniverse: snapshot.filteredUniverse || null,
      rawCount: snapshot.rawCount || null,
      blockedNonLongCandidatesCount: snapshot.blockedNonLongCandidatesCount || 0,
      blockedNonShortCandidatesCount: snapshot.blockedNonShortCandidatesCount || 0
    },

    scannerLatestPreserved: true,
    scannerSnapshotPreserved: true,
    scannerHistoryPreserved: true,

    microFamiliesAppendOnly: true,
    analyzePartialOnly: true,
    analyzeFullOverwriteDisabled: true,

    rotationPreserved: true,
    manualSelectionPreserved: true,
    discordSelectionPreserved: true,

    monitorOpenPositions: true,
    monitorOpenPositionsFirst: true,
    processScannerSnapshot: true,

    skippedNewEntries: false
  });
}