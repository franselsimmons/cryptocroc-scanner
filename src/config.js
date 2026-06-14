// ================= FILE: src/config.js =================

export const env = process.env;

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

const NO_GLOBAL_POSITION_LIMIT = 100_000;
const NO_GLOBAL_RISK_CAP = 1;

const DEFAULT_POSITION_TIME_STOP_MIN = 720;
const MIN_COMPLETED_ACTIVE_LEARNING = 20;

const TRUE_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'n', 'off']);

const SETUP_TYPES = Object.freeze([
  'BREAKOUT',
  'RETEST',
  'SWEEP_REVERSAL',
  'CONTINUATION',
  'COMPRESSION'
]);

const REGIME_BUCKETS = Object.freeze([
  'TREND',
  'CHOP',
  'SQUEEZE'
]);

const CONFIRMATION_PROFILES = Object.freeze([
  'A_STRONG_ALIGN',
  'B_FLOW_ALIGN',
  'C_VOLUME_ALIGN',
  'D_MIXED_OK',
  'E_WEAK_CONTRA'
]);

const bool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;

  const normalized = String(value).trim().toLowerCase();

  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;

  return fallback;
};

const num = (value, fallback) => {
  const n = Number(value);

  return Number.isFinite(n) ? n : fallback;
};

const int = (value, fallback) => {
  const n = Number(value);

  return Number.isInteger(n) ? n : fallback;
};

const str = (value, fallback = '') => {
  if (value === undefined || value === null) return fallback;

  const normalized = String(value).trim();

  return normalized || fallback;
};

const positiveInt = (value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  const n = int(value, fallback);

  return Math.max(min, Math.min(max, n));
};

const boundedNum = (value, fallback, min = -Infinity, max = Infinity) => {
  const n = num(value, fallback);

  return Math.max(min, Math.min(max, n));
};

const longOnlySides = () => [TARGET_TRADE_SIDE];

const rootSide = () => TARGET_TRADE_SIDE;

const rootMode = () => 'LONG_ONLY';

const completedStatusRules = Object.freeze({
  observing: 'completed = 0',
  earlyOutcomes: 'completed > 0 && completed < 20',
  activeLearning: 'completed >= 20'
});

const fixedTaxonomy = Object.freeze({
  trueMicroSchema: TRUE_MICRO_SCHEMA,
  parentTrueMicroSchema: PARENT_TRUE_MICRO_SCHEMA,
  childTrueMicroSchema: CHILD_TRUE_MICRO_SCHEMA,
  learningGranularity: LEARNING_GRANULARITY,
  parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

  setupTypes: SETUP_TYPES,
  regimeBuckets: REGIME_BUCKETS,
  confirmationProfiles: CONFIRMATION_PROFILES,

  parentFamilyCount: 15,
  childFamilyCount: 75,

  parentIdFormat: 'MICRO_LONG_{SETUP}_{REGIME}',
  childIdFormat: 'MICRO_LONG_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',

  selectableGranularity: 'EXACT_75_CHILD',
  parentGranularity: 'PARENT_15_CONTEXT_ONLY',

  exactTrueMicroOnly: true,
  exactTrueMicroFamilyRequired: true,
  exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
  parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
  childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,

  parentLearningEnabled: true,
  childLearningEnabled: true,
  selectionGranularity: 'EXACT_75_CHILD',
  fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED',

  parentSelectable: false,
  childSelectable: true,
  scannerFingerprintsSelectable: false,
  executionFingerprintsSelectable: false,
  macroFamilySelectable: false
});

const longIdentityFlags = Object.freeze({
  targetTradeSide: TARGET_TRADE_SIDE,
  targetScannerSide: TARGET_SCANNER_SIDE,
  dashboardSide: TARGET_DASHBOARD_SIDE,
  oppositeTradeSide: OPPOSITE_TRADE_SIDE,

  sideMode: 'LONG_ONLY',
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
  blockShort: true,
  blockLong: false,

  virtualLearning: true,
  virtualOnly: true,
  virtualTracked: true,
  shadowOnly: false,

  noRealOrders: true,
  realOrdersDisabled: true,
  bitgetOrdersDisabled: true,
  exchangeOrdersDisabled: true,
  exchangeCallsDisabled: true,
  noExchangeOrders: true,

  realTrade: false,
  realOrder: false,
  exchangeOrder: false,
  bitgetOrderPlaced: false,

  source: 'VIRTUAL',
  outcomeSource: 'VIRTUAL',

  redisNamespace: LONG_NAMESPACE,
  redisKeyPrefix: LONG_KEY_PREFIX,
  namespace: LONG_NAMESPACE,
  keyPrefix: LONG_KEY_PREFIX,
  persistentLearningKey: PERSISTENT_LEARNING_KEY,

  scannerFingerprintsMetadataOnly: true,
  scannerFingerprintsUsedAsLearningFamily: false,
  scannerBucketsMetadataOnly: true,
  legacy25BucketsMetadataOnly: true,

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
  discordOnlyForSelectedMicroFamilies: true,

  completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
  scoringRSource: 'netR',
  winsLossesFlatsSource: 'netR',
  winrateDefinition: 'netR > 0',
  avgRSource: 'netR',
  totalRSource: 'netR',
  avgCostRShown: true,

  exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
  trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
  parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
  childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
  learningGranularity: LEARNING_GRANULARITY,
  parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

  parentLearningEnabled: true,
  childLearningEnabled: true,
  selectionGranularity: 'EXACT_75_CHILD',
  fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED',

  shortRootTouched: false
});

const rootConfig = Object.freeze({
  ...longIdentityFlags,

  tradeSide: TARGET_TRADE_SIDE,
  scannerSide: TARGET_SCANNER_SIDE,
  dashboardSide: TARGET_DASHBOARD_SIDE,
  oppositeTradeSide: OPPOSITE_TRADE_SIDE,

  fixedTaxonomy,

  activeLearningMinCompleted: MIN_COMPLETED_ACTIVE_LEARNING,
  minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,
  learningStatusRules: completedStatusRules
});

const directionConfig = Object.freeze({
  mode: rootMode(),
  primaryTradeSide: rootSide(),
  allowedTradeSides: longOnlySides(),

  longEnabled: true,
  shortEnabled: false,

  blockShort: true,
  blockLong: false,

  scannerSide: TARGET_SCANNER_SIDE,
  dashboardSide: TARGET_DASHBOARD_SIDE,
  targetDashboardSide: TARGET_DASHBOARD_SIDE,

  ...longIdentityFlags
});

const appConfig = Object.freeze({
  name: str(env.APP_NAME, 'LONG Fixed Taxonomy Trading Admin'),
  baseUrl: str(env.APP_BASE_URL, env.VERCEL_URL ? `https://${env.VERCEL_URL}` : ''),
  adminPath: str(env.ADMIN_PATH, '/admin.html')
});

const redisConfig = Object.freeze({
  namespace: LONG_NAMESPACE,
  keyPrefix: LONG_KEY_PREFIX,
  redisNamespace: LONG_NAMESPACE,
  redisKeyPrefix: LONG_KEY_PREFIX,
  persistentLearningKey: PERSISTENT_LEARNING_KEY,
  maxRequestBytes: positiveInt(env.REDIS_MAX_REQUEST_BYTES, 9_500_000, 1_000_000, 50_000_000),
  shortRootTouched: false
});

const bitgetConfig = Object.freeze({
  baseUrl: str(env.BITGET_API_BASE_URL, 'https://api.bitget.com'),
  productType: str(env.BITGET_PRODUCT_TYPE, 'USDT-FUTURES'),
  timeoutMs: positiveInt(env.BITGET_TIMEOUT_MS, 8000, 1000, 30000),
  minRequestIntervalMs: positiveInt(env.BITGET_MIN_REQUEST_INTERVAL_MS, 80, 0, 10_000),
  retryDelayMs: positiveInt(env.BITGET_RETRY_DELAY_MS, 250, 0, 10_000),
  cacheEnabled: bool(env.BITGET_CACHE_ENABLED, true),

  marketDataOnly: true,
  ordersDisabled: true,
  noRealOrders: true,
  realOrdersDisabled: true,
  bitgetOrdersDisabled: true,
  exchangeOrdersDisabled: true,
  exchangeCallsDisabled: true,

  ...longIdentityFlags
});

const scannerConfig = Object.freeze({
  mode: rootMode(),

  allowedTradeSides: longOnlySides(),
  primaryTradeSide: rootSide(),
  targetTradeSide: rootSide(),
  targetScannerSide: TARGET_SCANNER_SIDE,
  dashboardSide: TARGET_DASHBOARD_SIDE,

  longEnabled: true,
  shortEnabled: false,

  discardShortCandidates: true,
  discardLongCandidates: false,
  bullishOnly: true,
  scannerSearchesBullishCoinsOnly: true,

  maxSymbols: positiveInt(env.SCANNER_MAX_SYMBOLS, 500, 1, 1000),
  maxCandidates: positiveInt(env.SCANNER_MAX_CANDIDATES, 500, 1, 1000),
  analyzeMaxCandidates: positiveInt(env.SCANNER_ANALYZE_MAX_CANDIDATES, 500, 1, 1000),
  analyzeMaxSymbols: positiveInt(env.SCANNER_ANALYZE_MAX_SYMBOLS, 500, 1, 1000),
  maxAnalyzeCandidates: positiveInt(env.SCANNER_MAX_ANALYZE_CANDIDATES, 500, 1, 1000),
  maxUniverseSymbols: positiveInt(env.SCANNER_MAX_UNIVERSE_SYMBOLS, 500, 1, 1000),

  dataConcurrency: positiveInt(env.SCANNER_DATA_CONCURRENCY, 12, 1, 30),

  minQuoteVolume24h: boundedNum(env.SCANNER_MIN_QUOTE_VOLUME_24H, 1_500_000, 0),
  softMinQuoteVolume24h: boundedNum(env.SCANNER_SOFT_MIN_QUOTE_VOLUME_24H, 10_000, 0),

  minAbsChange1h: boundedNum(env.SCANNER_MIN_ABS_CHANGE_1H, 0.08, 0),
  minAbsChange24h: boundedNum(env.SCANNER_MIN_ABS_CHANGE_24H, 0.25, 0),

  strictFilters: bool(env.SCANNER_STRICT_FILTERS, false),

  blockFakeBreakout: bool(env.SCANNER_BLOCK_FAKE_BREAKOUT, false),
  blockNoDirection: bool(env.SCANNER_BLOCK_NO_DIRECTION, false),
  blockSmallMove: bool(env.SCANNER_BLOCK_SMALL_MOVE, false),

  scannerOnly: true,
  scannerDecidesTrade: false,
  scannerDoesNotTrade: true,
  scannerDoesNotSelectMicroFamilies: true,
  scannerDoesNotSendDiscord: true,
  scannerDoesNotWriteLearningFamilies: true,

  noTradeExecution: true,
  noMicroFamilySelection: true,
  noDiscord: true,

  scannerFingerprintOnlyMetadata: true,
  scannerMicroFamilyPrefix: 'MICRO_LONG_SCANNER__',
  scannerFingerprintsAreDashboardFamilies: false,

  bucketGranularity: 'DEBUG_METADATA_ONLY',
  old25BucketsMetadataOnly: true,

  snapshotTtlSec: positiveInt(env.SCANNER_SNAPSHOT_TTL_SEC, 30 * 60, 60, 24 * 3600),
  candleLimit: positiveInt(env.SCANNER_CANDLE_LIMIT, 100, 30, 500),
  fakeBreakoutLookback: positiveInt(env.SCANNER_FAKE_BREAKOUT_LOOKBACK, 24, 5, 200),

  lockTtlSec: positiveInt(env.SCANNER_LOCK_TTL_SEC, 540, 30, 1800),

  ...longIdentityFlags
});

const tradeConfig = Object.freeze({
  mode: rootMode(),

  allowedTradeSides: longOnlySides(),
  primaryTradeSide: rootSide(),
  targetTradeSide: rootSide(),
  targetScannerSide: TARGET_SCANNER_SIDE,
  dashboardSide: TARGET_DASHBOARD_SIDE,

  longEnabled: true,
  shortEnabled: false,

  blockShortEntries: true,
  blockLongEntries: false,

  virtualOnly: true,
  virtualTracked: true,
  virtualLearning: true,

  noRealOrders: true,
  realOrdersDisabled: true,
  bitgetOrdersDisabled: true,
  exchangeOrdersDisabled: true,
  exchangeCallsDisabled: true,

  createRealOrders: false,
  placeExchangeOrders: false,
  allowExchangeOrders: false,

  positionSource: 'VIRTUAL',
  outcomeSource: 'VIRTUAL',

  lockTtlSec: positiveInt(env.TRADE_LOCK_TTL_SEC, 180, 30, 1800),

  maxCandidatesPerSnapshot: positiveInt(env.TRADE_MAX_CANDIDATES_PER_SNAPSHOT, 500, 1, 1000),
  analyzeMaxCandidatesPerSnapshot: positiveInt(env.TRADE_ANALYZE_MAX_CANDIDATES_PER_SNAPSHOT, 500, 1, 1000),
  maxAnalyzeCandidatesPerSnapshot: positiveInt(env.TRADE_MAX_ANALYZE_CANDIDATES_PER_SNAPSHOT, 500, 1, 1000),

  maxSnapshotAgeSec: positiveInt(env.TRADE_MAX_SNAPSHOT_AGE_SEC, 8 * 60, 30, 24 * 3600),

  dataConcurrency: positiveInt(env.TRADE_DATA_CONCURRENCY, 8, 1, 30),

  maxOpenPositions: NO_GLOBAL_POSITION_LIMIT,
  maxOpenSameSide: NO_GLOBAL_POSITION_LIMIT,
  enforceMaxOpenPositions: false,
  ignoreMaxOpenPositionsForLearning: true,
  globalMaxOpenPositionsBlockDisabled: true,
  noGlobalMaxOpenPositionsBlock: true,

  oneOpenPositionPerSymbol: true,
  maxOneOpenPositionPerSymbol: true,

  positionTimeStopMin: positiveInt(
    env.TRADE_POSITION_TIME_STOP_MIN,
    DEFAULT_POSITION_TIME_STOP_MIN,
    5,
    7 * 24 * 60
  ),

  minRR: boundedNum(env.TRADE_MIN_RR, 0.50, 0.1, 10),
  defaultRR: boundedNum(env.TRADE_DEFAULT_RR, 1.50, 0.1, 20),

  maxSpreadPct: boundedNum(env.TRADE_MAX_SPREAD_PCT, 0.0015, 0, 0.05),

  minRiskPct: boundedNum(env.TRADE_MIN_RISK_PCT, 0.004, 0.0001, 0.25),
  maxRiskPct: boundedNum(env.TRADE_MAX_RISK_PCT, 0.025, 0.0001, 0.50),
  fallbackRiskPct: boundedNum(env.TRADE_FALLBACK_RISK_PCT, 0.005, 0.0001, 0.25),

  atrRiskMult: boundedNum(env.TRADE_ATR_RISK_MULT, 1.2, 0.1, 20),
  spreadRiskMult: boundedNum(env.TRADE_SPREAD_RISK_MULT, 5, 0.1, 100),

  requireScannerGateForLiveEntries: bool(env.TRADE_REQUIRE_SCANNER_GATE_FOR_LIVE_ENTRIES, false),
  blockDiscoveryOnlyLiveEntries: bool(env.TRADE_BLOCK_DISCOVERY_ONLY_LIVE_ENTRIES, false),
  allowFakeBreakoutLiveEntries: bool(env.TRADE_ALLOW_FAKE_BREAKOUT_LIVE_ENTRIES, true),
  allowLowConfidenceLiveEntries: bool(env.TRADE_ALLOW_LOW_CONFIDENCE_LIVE_ENTRIES, true),
  minLiveScannerScore: boundedNum(env.TRADE_MIN_LIVE_SCANNER_SCORE, 0, 0, 100),

  minLiveCandles15m: positiveInt(env.TRADE_MIN_LIVE_CANDLES_15M, 25, 0, 500),
  candleLimit: positiveInt(env.TRADE_CANDLE_LIMIT, 100, 30, 500),

  allowLegacyMacroLiveEntries: false,

  allowCoarseMicroAliasLiveEntries: false,
  allowCoarseMicroAliasForDiscord: false,
  discordExactTrueMicroMatchOnly: true,
  discordOnlyForManualSelection: true,
  discordOnlyForSelectedMicroFamilies: true,
  discordOnlyForExactTrueMicroMatch: true,

  allowStandardizedLearningRiskFallback: bool(env.TRADE_ALLOW_STANDARDIZED_LEARNING_RISK_FALLBACK, true),
  allowStandardizedLearningRiskVirtualEntries: bool(env.TRADE_ALLOW_STANDARDIZED_LEARNING_RISK_VIRTUAL_ENTRIES, true),
  standardizedLearningRiskRequiresScannerGatePassed: bool(env.TRADE_STANDARDIZED_LEARNING_RISK_REQUIRES_SCANNER_GATE_PASSED, false),
  standardizedLearningRiskRequiresAnalyzeEligible: bool(env.TRADE_STANDARDIZED_LEARNING_RISK_REQUIRES_ANALYZE_ELIGIBLE, false),
  standardizedLearningRiskRequiresSpreadGatePassed: bool(env.TRADE_STANDARDIZED_LEARNING_RISK_REQUIRES_SPREAD_GATE_PASSED, false),

  allowSyntheticRiskFallback: false,
  allowSyntheticRiskVirtualEntries: false,

  validRiskShape: {
    entryGtZero: true,
    slBelowEntry: true,
    tpAboveEntry: true,
    rule: 'sl < entry < tp'
  },

  grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
  currentRFormula: '(currentPrice - entry) / (entry - initialSl)',
  closePriority: ['TP', 'SL', 'TIME_STOP'],
  closeRules: {
    tp: 'currentPrice >= tp',
    sl: 'currentPrice <= sl',
    timeStop: 'age >= CONFIG.trade.positionTimeStopMin'
  },

  deleteOpenPositionAfterClose: true,
  preserveOpeningMicroIdentityOnOutcome: true,
  neverReclassifyOnClose: true,

  candleTtlSec: positiveInt(env.TRADE_CANDLE_CACHE_TTL_SEC, 90, 5, 3600),
  orderbookTtlSec: positiveInt(env.TRADE_ORDERBOOK_CACHE_TTL_SEC, 12, 2, 300),
  fundingTtlSec: positiveInt(env.TRADE_FUNDING_CACHE_TTL_SEC, 120, 10, 3600),

  ...longIdentityFlags
});

const analyzeConfig = Object.freeze({
  mode: rootMode(),

  allowedTradeSides: longOnlySides(),
  primaryTradeSide: rootSide(),
  targetTradeSide: rootSide(),
  targetScannerSide: TARGET_SCANNER_SIDE,
  dashboardSide: TARGET_DASHBOARD_SIDE,

  longEnabled: true,
  shortEnabled: false,

  discardShortObservations: true,
  discardLongObservations: false,

  schema: TRUE_MICRO_SCHEMA,
  legacySchema: 'LEGACY_DISABLED',
  macroSchema: PARENT_TRUE_MICRO_SCHEMA,
  parentSchema: PARENT_TRUE_MICRO_SCHEMA,
  microSchema: TRUE_MICRO_SCHEMA,
  trueMicroSchema: TRUE_MICRO_SCHEMA,
  childSchema: CHILD_TRUE_MICRO_SCHEMA,

  fixedTaxonomy,

  learningMicroIdMode: 'LONG_FIXED_TAXONOMY_75_CHILD_TRUE_MICRO',
  statsKeyMode: 'EXACT_75_CHILD_TRUE_MICRO_ONLY',

  useCoarseMicroFamilyIdForLearning: false,
  preferCoarseMicroIdsForLearning: false,
  coarseMicroFamilyIdIsAlias: false,

  trueMicroFamilyIdSource: 'ANALYZE_TRUE_MICRO_FAMILY',
  microFamilyIdSource: 'ANALYZE_TRUE_MICRO_FAMILY',
  childTrueMicroFamilyIdSource: 'ANALYZE_TRUE_MICRO_FAMILY',
  parentTrueMicroFamilyIdSource: 'ANALYZE_PARENT_CONTEXT_ONLY',

  scannerFingerprintOnlyMetadata: true,
  scannerMicroFamilyIdMetadataOnly: true,
  scannerDefinitionMetadataOnly: true,
  scannerDefinitionPartsMetadataOnly: true,
  excludeScannerFingerprintsFromStats: true,
  hideScannerFingerprintsFromDashboard: true,
  scannerFingerprintsAreDashboardFamilies: false,

  executionFingerprintOnlyMetadata: true,
  excludeExecutionFingerprintsFromStats: true,

  includeSymbolInMicroId: false,
  includeSymbolClassInMicroId: false,
  includeCoinNameInMicroId: false,
  includeHashesInMicroId: false,
  includeFineBucketsInMicroId: false,
  includeExecutionFingerprintInMicroId: false,

  refineExecutionMicroIds: false,
  refineExecutionMicroIdsEnvRequested: bool(env.ANALYZE_REFINE_EXECUTION_MICRO_IDS, false),
  mergeRefinedExecutionMicros: false,

  assignEveryRiskValidCandidate: true,
  exactlyOneTrueMicroFamilyPerRiskValidCandidate: true,
  riskValidCandidateRequiresChild75: true,

  countObservationWithoutTrade: true,
  countEveryLongAnalyzeRowAsSeen: true,
  countEveryShortAnalyzeRowAsSeen: false,
  showObservingFamilies: true,

  outcomeSource: 'VIRTUAL',
  netOutcomesOnly: true,
  storeNetOutcome: true,
  useNetRForScoring: true,

  completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
  scoringRSource: 'netR',
  winsLossesFlatsSource: 'netR',
  winrateDefinition: 'netR > 0',
  avgRSource: 'netR',
  totalRSource: 'netR',
  showAvgCostR: true,

  rankingMetrics: [
    'dashboardBalancedScore',
    'balancedScore',
    'fairWinrate',
    'totalR',
    'avgR',
    'avgCostR'
  ],
  noBareWinrateRanking: true,

  activeLearningMinCompleted: MIN_COMPLETED_ACTIVE_LEARNING,
  earlyOutcomesMaxCompleted: MIN_COMPLETED_ACTIVE_LEARNING - 1,
  minCompletedPerType: MIN_COMPLETED_ACTIVE_LEARNING,
  minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,
  targetCompletedPerTypeAfterDays: 30,

  learningStatusRules: completedStatusRules,

  shadowEnabled: bool(env.ANALYZE_SHADOW_ENABLED, true),
  shadowHorizonMin: positiveInt(env.ANALYZE_SHADOW_HORIZON_MIN, 6 * 60, 5, 7 * 24 * 60),
  shadowWeight: boundedNum(env.ANALYZE_SHADOW_WEIGHT, 0.35, 0, 1),

  obsDedupeTtlSec: positiveInt(env.ANALYZE_OBS_DEDUPE_TTL_SEC, 14 * 24 * 3600, 60, 90 * 24 * 3600),
  shadowDedupeTtlSec: positiveInt(env.ANALYZE_SHADOW_DEDUPE_TTL_SEC, 3 * 3600, 60, 14 * 24 * 3600),

  maxShadowMonitorsPerRun: positiveInt(env.ANALYZE_MAX_SHADOW_MONITORS_PER_RUN, 120, 1, 1000),

  freezeLockTtlSec: positiveInt(env.ANALYZE_FREEZE_LOCK_TTL_SEC, 600, 30, 3600),
  activateLockTtlSec: positiveInt(env.ANALYZE_ACTIVATE_LOCK_TTL_SEC, 600, 30, 3600),

  weekMicrosCompressionEnabled: bool(env.ANALYZE_WEEK_MICROS_COMPRESSION_ENABLED, true),
  weekMicrosCompressionLevel: positiveInt(env.ANALYZE_WEEK_MICROS_COMPRESSION_LEVEL, 6, 0, 9),
  maxMicroRowSetBytes: positiveInt(env.ANALYZE_MAX_MICRO_ROW_SET_BYTES, 250_000, 50_000, 5_000_000),

  weekMicrosTtlSec: positiveInt(env.ANALYZE_WEEK_MICROS_TTL_SEC, 21 * 24 * 3600, 24 * 3600, 365 * 24 * 3600),
  weekMetaTtlSec: positiveInt(env.ANALYZE_WEEK_META_TTL_SEC, 90 * 24 * 3600, 24 * 3600, 365 * 24 * 3600),

  storageConcurrency: positiveInt(env.ANALYZE_STORAGE_CONCURRENCY, 8, 1, 30),

  topMicrosSnapshotLimit: positiveInt(env.ANALYZE_TOP_MICROS_SNAPSHOT_LIMIT, 300, 1, 5000),
  maxFullReadMicroRows: positiveInt(env.ANALYZE_MAX_FULL_READ_MICRO_ROWS, 1_500, 100, 50_000),
  fullReadSoftTimeoutMs: positiveInt(env.ANALYZE_FULL_READ_SOFT_TIMEOUT_MS, 2_400, 250, 30_000),
  preferTopSnapshotOnLargeIndex: bool(env.ANALYZE_PREFER_TOP_SNAPSHOT_ON_LARGE_INDEX, true),

  maxExamplesPerMicro: positiveInt(env.ANALYZE_MAX_EXAMPLES_PER_MICRO, 8, 1, 100),
  maxRecentOutcomesPerMicro: positiveInt(env.ANALYZE_MAX_RECENT_OUTCOMES_PER_MICRO, 8, 1, 100),
  maxDefinitionPartsPerMicro: positiveInt(env.ANALYZE_MAX_DEFINITION_PARTS_PER_MICRO, 64, 8, 512),
  maxParentDefinitionPartsPerMicro: positiveInt(env.ANALYZE_MAX_PARENT_DEFINITION_PARTS_PER_MICRO, 48, 8, 512),
  maxCounterKeysPerMicro: positiveInt(env.ANALYZE_MAX_COUNTER_KEYS_PER_MICRO, 18, 1, 100),
  maxCounterValuesPerCounter: positiveInt(env.ANALYZE_MAX_COUNTER_VALUES_PER_COUNTER, 24, 1, 250),
  maxStoredStringLength: positiveInt(env.ANALYZE_MAX_STORED_STRING_LENGTH, 480, 64, 5000),

  ...longIdentityFlags
});

const rotationConfig = Object.freeze({
  mode: 'balanced',
  defaultMode: 'balanced',
  defaultRankingMode: 'balanced',

  rankingPreference: [
    'dashboardBalancedScore',
    'balancedScore',
    'fairWinrate',
    'totalR',
    'avgR',
    'avgCostR'
  ],

  balancedScoreUses: [
    'fairWinrate',
    'totalR',
    'avgR',
    'avgCostR',
    'completed'
  ],

  noBareWinrateRanking: true,

  directionMode: rootMode(),

  allowedTradeSides: longOnlySides(),
  primaryTradeSide: rootSide(),
  targetTradeSide: rootSide(),
  dashboardSide: TARGET_DASHBOARD_SIDE,

  longEnabled: true,
  shortEnabled: false,

  blockShortActivation: true,
  blockLongActivation: false,

  manualOnly: true,
  autoRotation: false,
  autoActivationEnabled: false,
  autoActivationDisabled: true,
  manualActivationEnabled: true,
  activationDisabled: false,
  preserveManualSelection: true,
  neverOverwriteManualSelection: true,

  noResetCron: true,
  noActivateCron: true,
  noFreezeCron: true,

  exactTrueMicroFamilySelectionOnly: true,
  exact75ChildSelectionOnly: true,
  allowParentSelection: false,
  allowCoarseAliasForDiscord: false,
  allowMacroAliasForDiscord: false,
  allowScannerFingerprintSelection: false,
  allowExecutionFingerprintSelection: false,

  topNPerSide: positiveInt(env.ROTATION_TOP_N_PER_SIDE, 1, 1, 50),
  topNLong: positiveInt(env.ROTATION_TOP_N_LONG, 1, 1, 50),
  topNShort: 0,

  minWeightedCompleted: boundedNum(env.ROTATION_MIN_WEIGHTED_COMPLETED, MIN_COMPLETED_ACTIVE_LEARNING, 0, 100),
  activeLearningMinCompleted: MIN_COMPLETED_ACTIVE_LEARNING,
  minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,
  learningStatusRules: completedStatusRules,

  enforceMaxPerMacroFamily: bool(env.ROTATION_ENFORCE_MAX_PER_MACRO_FAMILY, true),
  maxPerMacroFamily: positiveInt(env.ROTATION_MAX_PER_MACRO_FAMILY, 1, 1, 50),

  minPrimaryRowsForPreviousMerge: positiveInt(env.ROTATION_MIN_PRIMARY_ROWS_FOR_PREVIOUS_MERGE, 25, 0, 10_000),

  allowLegacyMacroActivation: false,

  allowSoftRotationFallback: bool(env.ROTATION_ALLOW_SOFT_ROTATION_FALLBACK, true),
  allowObservationRotationFallback: bool(env.ROTATION_ALLOW_OBSERVATION_ROTATION_FALLBACK, true),
  allowRawRotationFallback: bool(env.ROTATION_ALLOW_RAW_ROTATION_FALLBACK, true),

  allowManualUnknownTrueMicroIds: bool(env.ROTATION_ALLOW_MANUAL_UNKNOWN_TRUE_MICRO_IDS, true),
  allowManualBelowMinCompleted: bool(env.ROTATION_ALLOW_MANUAL_BELOW_MIN_COMPLETED, true),

  priorTrades: boundedNum(env.ROTATION_PRIOR_TRADES, 24, 0, 1000),
  priorWinrate: boundedNum(env.ROTATION_PRIOR_WINRATE, 0.50, 0, 1),
  wilsonZ: boundedNum(env.ROTATION_WILSON_Z, 1.96, 0, 5),

  sampleReliabilityCap: boundedNum(env.ROTATION_SAMPLE_RELIABILITY_CAP, 50, 1, 10_000),
  avgRCap: boundedNum(env.ROTATION_AVG_R_CAP, 5, 0.1, 100),
  avgRSampleExponent: boundedNum(env.ROTATION_AVG_R_SAMPLE_EXPONENT, 1.35, 0.1, 5),

  fixedTaxonomy,

  ...longIdentityFlags
});

const discordConfig = Object.freeze({
  enabled: bool(env.DISCORD_ENABLED, true),
  webhookUrl: str(env.DISCORD_WEBHOOK_URL, ''),
  timeoutMs: positiveInt(env.DISCORD_TIMEOUT_MS, 2500, 250, 30000),
  logLimit: positiveInt(env.DISCORD_LOG_LIMIT, 250, 10, 5000),

  allowedTradeSides: longOnlySides(),
  primaryTradeSide: rootSide(),
  targetTradeSide: rootSide(),
  dashboardSide: TARGET_DASHBOARD_SIDE,

  longEnabled: true,
  shortEnabled: false,

  sendRotationReports: bool(env.DISCORD_SEND_ROTATION_REPORTS, false),
  sendResetReports: bool(env.DISCORD_SEND_RESET_REPORTS, true),

  selectedMicroOnly: true,
  exactTrueMicroFamilyMatchOnly: true,
  exact75ChildTrueMicroMatchOnly: true,
  manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
  alertRule: 'CANDIDATE_TRUE_MICRO_FAMILY_ID_EQUALS_MANUALLY_SELECTED_75_CHILD_ID',

  allowCoarseMicroAlias: false,
  allowMacroFamilyAlias: false,
  allowParentFamilyAlias: false,
  allowScannerFingerprintAlias: false,
  allowExecutionFingerprintAlias: false,

  noAlertWithoutManualSelection: true,
  neverThrow: true,

  ...longIdentityFlags
});

const resetConfig = Object.freeze({
  namespace: LONG_NAMESPACE,
  redisNamespace: LONG_NAMESPACE,
  keyPrefix: LONG_KEY_PREFIX,
  redisKeyPrefix: LONG_KEY_PREFIX,
  persistentLearningKey: PERSISTENT_LEARNING_KEY,

  confirmText: str(env.LONG_RESET_CONFIRM_TEXT, 'LONG_FACTORY_RESET_CONFIRMED'),
  learningConfirmText: str(env.LONG_RESET_LEARNING_CONFIRM_TEXT, 'RESET_LEARNING_LONG'),
  rotationConfirmText: str(env.LONG_RESET_ROTATION_CONFIRM_TEXT, 'RESET_ROTATION_LONG'),

  shortRootTouched: false,

  ...longIdentityFlags
});

const sizingConfig = Object.freeze({
  enabled: bool(env.SIZING_ENABLED, true),

  baseRiskPct: boundedNum(env.SIZING_BASE_RISK_PCT, 0.0025, 0.00001, 0.25),

  minMult: boundedNum(env.SIZING_MIN_MULT, 0.5, 0.01, 10),
  maxMult: boundedNum(env.SIZING_MAX_MULT, 1.25, 0.01, 10),

  maxTotalRiskPct: NO_GLOBAL_RISK_CAP,
  maxSameSideRiskPct: NO_GLOBAL_RISK_CAP,
  maxCounterBtcRiskPct: NO_GLOBAL_RISK_CAP,

  ...longIdentityFlags
});

const manageConfig = Object.freeze({
  applyLive: false,

  beArmR: boundedNum(env.MANAGE_BE_ARM_R, 0.70, 0, 10),
  beLockR: boundedNum(env.MANAGE_BE_LOCK_R, 0.05, -5, 10),

  trailArmR: boundedNum(env.MANAGE_TRAIL_ARM_R, 1.00, 0, 20),
  trailLockR: boundedNum(env.MANAGE_TRAIL_LOCK_R, 0.35, -5, 20),

  ...longIdentityFlags
});

const costConfig = Object.freeze({
  takerFeePct: boundedNum(env.COST_TAKER_FEE_PCT, 0.0006, 0, 0.05),
  makerFeePct: boundedNum(env.COST_MAKER_FEE_PCT, 0.0002, 0, 0.05),

  slippagePct: boundedNum(env.COST_SLIPPAGE_PCT, 0.0002, 0, 0.05),
  marketSlippagePct: boundedNum(env.COST_MARKET_SLIPPAGE_PCT || env.COST_SLIPPAGE_PCT, 0.0002, 0, 0.05),

  marketImpactPct: boundedNum(env.COST_MARKET_IMPACT_PCT, 0.0003, 0, 0.05),
  impactPct: boundedNum(env.COST_IMPACT_PCT || env.COST_MARKET_IMPACT_PCT, 0.0003, 0, 0.05),

  fallbackSpreadPct: boundedNum(env.COST_FALLBACK_SPREAD_PCT, 0.0008, 0, 0.05),
  maxSpreadPct: boundedNum(env.COST_MAX_SPREAD_PCT, 0.05, 0, 0.25),

  source: 'VIRTUAL',
  outcomeSource: 'VIRTUAL',
  scoringRSource: 'netR',

  ...longIdentityFlags
});

const longConfig = Object.freeze({
  root: rootConfig,
  direction: directionConfig,
  scanner: scannerConfig,
  trade: tradeConfig,
  analyze: analyzeConfig,
  rotation: rotationConfig,
  discord: discordConfig,
  reset: resetConfig,
  sizing: sizingConfig,
  manage: manageConfig,
  cost: costConfig,
  taxonomy: fixedTaxonomy
});

export const CONFIG = Object.freeze({
  strategyVersion: str(env.STRATEGY_VERSION, 'LONG_FIXED_TAXONOMY_75_VIRTUAL_NET_V1'),

  root: rootConfig,
  direction: directionConfig,
  app: appConfig,
  redis: redisConfig,
  bitget: bitgetConfig,
  scanner: scannerConfig,
  trade: tradeConfig,
  analyze: analyzeConfig,
  rotation: rotationConfig,
  discord: discordConfig,
  reset: resetConfig,
  sizing: sizingConfig,
  manage: manageConfig,
  cost: costConfig,
  taxonomy: fixedTaxonomy,
  long: longConfig
});