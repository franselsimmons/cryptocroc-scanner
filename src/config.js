// ================= FILE: src/config.js =================

export const env = process.env;

const ROOT_TRADE_SIDE = 'LONG';
const ROOT_DASHBOARD_SIDE = 'bull';
const ROOT_SCANNER_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';

const NO_GLOBAL_POSITION_LIMIT = 100_000;
const NO_GLOBAL_RISK_CAP = 1;

const DEFAULT_POSITION_TIME_STOP_MIN = 720;
const MIN_COMPLETED_PER_ANALYZE_TYPE = 20;

const TRUE_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'n', 'off']);

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

/*
  LONG root guard.

  SHORT wordt nergens via env toegelaten. Oude Vercel/env waarden zoals:
  - PRIMARY_TRADE_SIDE=SHORT
  - ALLOWED_TRADE_SIDES=SHORT
  - SCANNER_ALLOWED_TRADE_SIDES=SHORT
  - TRADE_ALLOWED_TRADE_SIDES=SHORT
  - ANALYZE_ALLOWED_TRADE_SIDES=SHORT
  - ROTATION_ALLOWED_TRADE_SIDES=SHORT

  worden bewust genegeerd.
*/
const longOnlySides = () => [ROOT_TRADE_SIDE];

const rootSide = () => ROOT_TRADE_SIDE;

const rootMode = () => 'LONG_ONLY';

export const CONFIG = Object.freeze({
  strategyVersion: str(env.STRATEGY_VERSION, 'COARSE_MF_TS_LONG_ONLY_VIRTUAL_NET_V5'),

  root: {
    tradeSide: ROOT_TRADE_SIDE,
    scannerSide: ROOT_SCANNER_SIDE,
    dashboardSide: ROOT_DASHBOARD_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    namespace: LONG_NAMESPACE,
    redisNamespace: LONG_NAMESPACE,
    keyPrefix: LONG_KEY_PREFIX,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,

    longOnly: true,
    shortDisabled: true,
    longDisabled: false,
    blockShort: true,
    blockLong: false,

    shortOnly: false,

    virtualOnly: true,
    virtualLearning: true,

    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,

    source: 'VIRTUAL',
    outcomeSource: 'VIRTUAL'
  },

  direction: {
    mode: rootMode(),
    primaryTradeSide: rootSide(),
    allowedTradeSides: longOnlySides(),

    longEnabled: true,
    shortEnabled: false,

    blockShort: true,
    blockLong: false,

    scannerSide: ROOT_SCANNER_SIDE,
    dashboardSide: ROOT_DASHBOARD_SIDE,
    targetDashboardSide: ROOT_DASHBOARD_SIDE
  },

  app: {
    name: str(env.APP_NAME, 'LONG Micro-Family Trading Admin'),
    baseUrl: str(env.APP_BASE_URL, env.VERCEL_URL ? `https://${env.VERCEL_URL}` : ''),
    adminPath: str(env.ADMIN_PATH, '/admin.html')
  },

  redis: {
    namespace: LONG_NAMESPACE,
    keyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    maxRequestBytes: positiveInt(env.REDIS_MAX_REQUEST_BYTES, 9_500_000, 1_000_000, 50_000_000)
  },

  bitget: {
    baseUrl: str(env.BITGET_API_BASE_URL, 'https://api.bitget.com'),
    productType: str(env.BITGET_PRODUCT_TYPE, 'usdt-futures'),
    timeoutMs: positiveInt(env.BITGET_TIMEOUT_MS, 8000, 1000, 30000),

    /*
      Alleen market-data reads. Geen order placement.
    */
    ordersDisabled: true,
    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true
  },

  scanner: {
    mode: rootMode(),
    namespace: LONG_NAMESPACE,
    redisNamespace: LONG_NAMESPACE,
    keyPrefix: LONG_KEY_PREFIX,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,

    allowedTradeSides: longOnlySides(),
    primaryTradeSide: rootSide(),
    targetTradeSide: rootSide(),
    targetScannerSide: ROOT_SCANNER_SIDE,
    dashboardSide: ROOT_DASHBOARD_SIDE,

    longEnabled: true,
    shortEnabled: false,

    discardShortCandidates: true,
    discardLongCandidates: false,

    maxSymbols: positiveInt(env.SCANNER_MAX_SYMBOLS, 300, 1, 1000),
    maxCandidates: positiveInt(env.SCANNER_MAX_CANDIDATES, 300, 1, 1000),
    analyzeMaxCandidates: positiveInt(env.SCANNER_ANALYZE_MAX_CANDIDATES, 300, 1, 1000),

    dataConcurrency: positiveInt(env.SCANNER_DATA_CONCURRENCY, 12, 1, 30),

    minQuoteVolume24h: boundedNum(env.SCANNER_MIN_QUOTE_VOLUME_24H, 1_500_000, 0),
    softMinQuoteVolume24h: boundedNum(env.SCANNER_SOFT_MIN_QUOTE_VOLUME_24H, 10_000, 0),

    minAbsChange1h: boundedNum(env.SCANNER_MIN_ABS_CHANGE_1H, 0.12, 0),
    minAbsChange24h: boundedNum(env.SCANNER_MIN_ABS_CHANGE_24H, 0.35, 0),

    strictFilters: bool(env.SCANNER_STRICT_FILTERS, false),

    /*
      Learning-first:
      false = fake breakout blijft kandidaat/leerdata.
      Alleen true zetten als je bewust scanner-output harder wilt snijden.
    */
    blockFakeBreakout: bool(env.SCANNER_BLOCK_FAKE_BREAKOUT, false),
    blockNoDirection: bool(env.SCANNER_BLOCK_NO_DIRECTION, false),
    blockSmallMove: bool(env.SCANNER_BLOCK_SMALL_MOVE, false),

    /*
      Scanner fingerprint is metadata/label, nooit echte Analyze learning-family.
    */
    scannerFingerprintOnlyMetadata: true,
    scannerMicroFamilyPrefix: 'MICRO_LONG_SCANNER__',
    scannerFingerprintsAreDashboardFamilies: false,

    snapshotTtlSec: positiveInt(env.SCANNER_SNAPSHOT_TTL_SEC, 30 * 60, 60, 24 * 3600),
    candleLimit: positiveInt(env.SCANNER_CANDLE_LIMIT, 100, 30, 500),
    fakeBreakoutLookback: positiveInt(env.SCANNER_FAKE_BREAKOUT_LOOKBACK, 24, 5, 200),

    lockTtlSec: positiveInt(env.SCANNER_LOCK_TTL_SEC, 540, 30, 1800)
  },

  trade: {
    mode: rootMode(),
    namespace: LONG_NAMESPACE,
    redisNamespace: LONG_NAMESPACE,
    keyPrefix: LONG_KEY_PREFIX,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,

    allowedTradeSides: longOnlySides(),
    primaryTradeSide: rootSide(),
    targetTradeSide: rootSide(),
    targetScannerSide: ROOT_SCANNER_SIDE,
    dashboardSide: ROOT_DASHBOARD_SIDE,

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

    createRealOrders: false,
    placeExchangeOrders: false,
    allowExchangeOrders: false,

    positionSource: 'VIRTUAL',
    outcomeSource: 'VIRTUAL',

    lockTtlSec: positiveInt(env.TRADE_LOCK_TTL_SEC, 180, 30, 1800),

    maxCandidatesPerSnapshot: positiveInt(env.TRADE_MAX_CANDIDATES_PER_SNAPSHOT, 300, 1, 1000),
    analyzeMaxCandidatesPerSnapshot: positiveInt(env.TRADE_ANALYZE_MAX_CANDIDATES_PER_SNAPSHOT, 300, 1, 1000),
    maxAnalyzeCandidatesPerSnapshot: positiveInt(env.TRADE_MAX_ANALYZE_CANDIDATES_PER_SNAPSHOT, 300, 1, 1000),

    maxSnapshotAgeSec: positiveInt(env.TRADE_MAX_SNAPSHOT_AGE_SEC, 8 * 60, 30, 24 * 3600),

    dataConcurrency: positiveInt(env.TRADE_DATA_CONCURRENCY, 8, 1, 30),

    /*
      Geen globale max-open-positions blokkade.
      Enige harde limiter hoort te zijn: maximaal één open positie per symbol.
    */
    maxOpenPositions: NO_GLOBAL_POSITION_LIMIT,
    maxOpenSameSide: NO_GLOBAL_POSITION_LIMIT,
    enforceMaxOpenPositions: false,
    ignoreMaxOpenPositionsForLearning: true,
    oneOpenPositionPerSymbol: true,

    /*
      Default 720 minuten.
      TP/SL moeten los van deze time-stop sluiten.
    */
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

    /*
      Learning-first:
      TradeSystem mag Analyze voeden met observation-only rows.
      Virtuele positie wordt alleen gemaakt bij geldige LONG risk-shape:
      entry > 0, SL onder entry, TP boven entry.
    */
    requireScannerGateForLiveEntries: bool(env.TRADE_REQUIRE_SCANNER_GATE_FOR_LIVE_ENTRIES, false),
    blockDiscoveryOnlyLiveEntries: bool(env.TRADE_BLOCK_DISCOVERY_ONLY_LIVE_ENTRIES, false),
    allowFakeBreakoutLiveEntries: bool(env.TRADE_ALLOW_FAKE_BREAKOUT_LIVE_ENTRIES, true),
    allowLowConfidenceLiveEntries: bool(env.TRADE_ALLOW_LOW_CONFIDENCE_LIVE_ENTRIES, true),
    minLiveScannerScore: boundedNum(env.TRADE_MIN_LIVE_SCANNER_SCORE, 0, 0, 100),

    allowLegacyMacroLiveEntries: false,

    /*
      Discord moet alleen matchen op exacte handmatige true micro.
      Geen coarse/macro alias voor alerts.
    */
    allowCoarseMicroAliasLiveEntries: false,
    discordExactTrueMicroMatchOnly: true,
    discordOnlyForManualSelection: true,
    discordOnlyForSelectedMicroFamilies: true,

    /*
      Synthetic risk blijft uit.
    */
    allowSyntheticRiskFallback: false,
    allowSyntheticRiskVirtualEntries: false,

    /*
      LONG position/risk/outcome model.
    */
    validRiskShape: {
      entryGtZero: true,
      slBelowEntry: true,
      tpAboveEntry: true
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
    fundingTtlSec: positiveInt(env.TRADE_FUNDING_CACHE_TTL_SEC, 120, 10, 3600)
  },

  analyze: {
    mode: rootMode(),
    namespace: LONG_NAMESPACE,
    redisNamespace: LONG_NAMESPACE,
    keyPrefix: LONG_KEY_PREFIX,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,

    allowedTradeSides: longOnlySides(),
    primaryTradeSide: rootSide(),
    targetTradeSide: rootSide(),
    targetScannerSide: ROOT_SCANNER_SIDE,
    dashboardSide: ROOT_DASHBOARD_SIDE,

    longEnabled: true,
    shortEnabled: false,

    discardShortObservations: true,
    discardLongObservations: false,

    schema: str(env.ANALYZE_SCHEMA || env.MICRO_FAMILY_SCHEMA, 'MF_V2'),
    legacySchema: str(env.ANALYZE_LEGACY_SCHEMA, 'MF_V1'),
    macroSchema: str(env.ANALYZE_MACRO_SCHEMA, 'MF_V1'),
    microSchema: str(env.ANALYZE_MICRO_SCHEMA, 'MF_V2'),

    /*
      Eén echte Analyze micro-family identiteit.
      Scanner fingerprints blijven metadata.
      Geen symbol/fine execution-id in learning key.
    */
    learningMicroIdMode: 'COARSE_ANALYZE_TRUE_MICRO',
    statsKeyMode: 'ANALYZE_TRUE_MICRO_ONLY',

    useCoarseMicroFamilyIdForLearning: true,
    preferCoarseMicroIdsForLearning: true,
    coarseMicroFamilyIdIsAlias: true,

    trueMicroFamilyIdSource: 'ANALYZE_MICRO_FAMILY',
    microFamilyIdSource: 'ANALYZE_MICRO_FAMILY',

    scannerFingerprintOnlyMetadata: true,
    scannerMicroFamilyIdMetadataOnly: true,
    scannerDefinitionMetadataOnly: true,
    scannerDefinitionPartsMetadataOnly: true,
    excludeScannerFingerprintsFromStats: true,
    hideScannerFingerprintsFromDashboard: true,
    scannerFingerprintsAreDashboardFamilies: false,

    includeSymbolInMicroId: false,
    includeSymbolClassInMicroId: false,
    includeFineBucketsInMicroId: false,
    includeExecutionFingerprintInMicroId: false,

    /*
      Kritieke LONG fix:
      false = geen _XR_ micro id per coin/fine bucket.
      Daardoor clusteren dezelfde LONG setups over meerdere coins.
    */
    refineExecutionMicroIds: false,

    /*
      Alleen diagnostisch.
      Oude Vercel env ANALYZE_REFINE_EXECUTION_MICRO_IDS=true wordt bewust genegeerd.
    */
    refineExecutionMicroIdsEnvRequested: bool(env.ANALYZE_REFINE_EXECUTION_MICRO_IDS, false),

    mergeRefinedExecutionMicros: true,

    /*
      Elke Analyze-input telt seen +1 / observations +1.
      Outcomes worden netto opgeslagen.
    */
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

    activeLearningMinCompleted: MIN_COMPLETED_PER_ANALYZE_TYPE,
    earlyOutcomesMaxCompleted: MIN_COMPLETED_PER_ANALYZE_TYPE - 1,
    minCompletedPerType: MIN_COMPLETED_PER_ANALYZE_TYPE,
    minCompletedForActiveLearning: MIN_COMPLETED_PER_ANALYZE_TYPE,
    targetCompletedPerTypeAfterDays: 30,

    learningStatusRules: {
      observing: 'completed = 0',
      earlyOutcomes: 'completed > 0 && completed < 20',
      activeLearning: 'completed >= 20'
    },

    shadowEnabled: bool(env.ANALYZE_SHADOW_ENABLED, true),
    shadowHorizonMin: positiveInt(env.ANALYZE_SHADOW_HORIZON_MIN, 6 * 60, 5, 7 * 24 * 60),
    shadowWeight: boundedNum(env.ANALYZE_SHADOW_WEIGHT, 0.35, 0, 1),

    obsDedupeTtlSec: positiveInt(env.ANALYZE_OBS_DEDUPE_TTL_SEC, 14 * 24 * 3600, 60, 90 * 24 * 3600),

    /*
      Lager dan 48h.
      Dit zorgt dat dezelfde LONG micro sneller extra completed samples kan bouwen.
    */
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
    maxStoredStringLength: positiveInt(env.ANALYZE_MAX_STORED_STRING_LENGTH, 480, 64, 5000)
  },

  rotation: {
    /*
      Default ranking nooit kale winrate.
      Env ROTATION_MODE wordt bewust niet gebruikt als SHORT/activation control.
    */
    mode: 'balanced',
    defaultMode: 'balanced',
    defaultRankingMode: 'balanced',
    rankingPreference: [
      'dashboardBalancedScore',
      'balancedScore',
      'fairWinrate',
      'wilsonLowerBound',
      'bayesianWinrate',
      'totalR',
      'avgR'
    ],

    directionMode: rootMode(),
    namespace: LONG_NAMESPACE,
    redisNamespace: LONG_NAMESPACE,
    keyPrefix: LONG_KEY_PREFIX,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,

    allowedTradeSides: longOnlySides(),
    primaryTradeSide: rootSide(),
    targetTradeSide: rootSide(),
    dashboardSide: ROOT_DASHBOARD_SIDE,

    longEnabled: true,
    shortEnabled: false,

    blockShortActivation: true,
    blockLongActivation: false,

    /*
      Het systeem kiest nooit zelf actief.
      Weekly/freeze mag rapporteren/bouwen, maar activeRotation blijft handmatig.
    */
    manualOnly: true,
    autoRotation: false,
    autoActivationEnabled: false,
    activationDisabled: true,
    preserveManualSelection: true,
    neverOverwriteManualSelection: true,

    noResetCron: true,
    noActivateCron: true,
    noFreezeCron: true,

    exactTrueMicroFamilySelectionOnly: true,
    allowCoarseAliasForDiscord: false,
    allowMacroAliasForDiscord: false,

    topNPerSide: positiveInt(env.ROTATION_TOP_N_PER_SIDE, 1, 1, 50),
    topNLong: positiveInt(env.ROTATION_TOP_N_LONG, 1, 1, 50),
    topNShort: 0,

    /*
      UI/learning status:
      completed = 0 => OBSERVING
      completed 1..19 => EARLY_OUTCOMES
      completed >= 20 => ACTIVE_LEARNING
    */
    minWeightedCompleted: boundedNum(env.ROTATION_MIN_WEIGHTED_COMPLETED, MIN_COMPLETED_PER_ANALYZE_TYPE, 0, 100),
    activeLearningMinCompleted: MIN_COMPLETED_PER_ANALYZE_TYPE,
    minCompletedForActiveLearning: MIN_COMPLETED_PER_ANALYZE_TYPE,

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
    avgRSampleExponent: boundedNum(env.ROTATION_AVG_R_SAMPLE_EXPONENT, 1.35, 0.1, 5)
  },

  discord: {
    enabled: bool(env.DISCORD_ENABLED, true),
    webhookUrl: str(env.DISCORD_WEBHOOK_URL, ''),
    timeoutMs: positiveInt(env.DISCORD_TIMEOUT_MS, 2500, 250, 30000),
    logLimit: positiveInt(env.DISCORD_LOG_LIMIT, 250, 10, 5000),

    namespace: LONG_NAMESPACE,
    redisNamespace: LONG_NAMESPACE,
    keyPrefix: LONG_KEY_PREFIX,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,

    allowedTradeSides: longOnlySides(),
    primaryTradeSide: rootSide(),
    targetTradeSide: rootSide(),
    dashboardSide: ROOT_DASHBOARD_SIDE,

    longEnabled: true,
    shortEnabled: false,

    /*
      Entry/exit alerts uitsluitend voor exacte handmatige true micro match.
    */
    sendRotationReports: bool(env.DISCORD_SEND_ROTATION_REPORTS, false),
    sendResetReports: bool(env.DISCORD_SEND_RESET_REPORTS, true),

    selectedMicroOnly: true,
    exactTrueMicroFamilyMatchOnly: true,
    allowCoarseMicroAlias: false,
    allowMacroFamilyAlias: false,

    noAlertWithoutManualSelection: true,
    neverThrow: true
  },

  reset: {
    namespace: LONG_NAMESPACE,
    redisNamespace: LONG_NAMESPACE,
    keyPrefix: LONG_KEY_PREFIX,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,

    confirmText: str(env.LONG_RESET_CONFIRM_TEXT, 'LONG_FACTORY_RESET_CONFIRMED'),
    learningConfirmText: str(env.LONG_RESET_LEARNING_CONFIRM_TEXT, 'RESET_LEARNING_LONG'),
    rotationConfirmText: str(env.LONG_RESET_ROTATION_CONFIRM_TEXT, 'RESET_ROTATION_LONG'),

    shortRootTouched: false
  },

  sizing: {
    enabled: bool(env.SIZING_ENABLED, true),

    baseRiskPct: boundedNum(env.SIZING_BASE_RISK_PCT, 0.0025, 0.00001, 0.25),

    minMult: boundedNum(env.SIZING_MIN_MULT, 0.5, 0.01, 10),
    maxMult: boundedNum(env.SIZING_MAX_MULT, 1.25, 0.01, 10),

    /*
      Virtuele posities mogen niet door globale exposure caps worden geblokkeerd.
      checkRiskCaps blijft bruikbaar als aparte guard, maar default cap is effectief ruim.
    */
    maxTotalRiskPct: NO_GLOBAL_RISK_CAP,
    maxSameSideRiskPct: NO_GLOBAL_RISK_CAP,
    maxCounterBtcRiskPct: NO_GLOBAL_RISK_CAP
  },

  manage: {
    applyLive: false,

    beArmR: boundedNum(env.MANAGE_BE_ARM_R, 0.70, 0, 10),
    beLockR: boundedNum(env.MANAGE_BE_LOCK_R, 0.05, -5, 10),

    trailArmR: boundedNum(env.MANAGE_TRAIL_ARM_R, 1.00, 0, 20),
    trailLockR: boundedNum(env.MANAGE_TRAIL_LOCK_R, 0.35, -5, 20)
  },

  cost: {
    takerFeePct: boundedNum(env.COST_TAKER_FEE_PCT, 0.0006, 0, 0.05),
    makerFeePct: boundedNum(env.COST_MAKER_FEE_PCT, 0.0002, 0, 0.05),

    /*
      costModel.js gebruikt fees/slippage/spread/impact voor netto R.
    */
    slippagePct: boundedNum(env.COST_SLIPPAGE_PCT, 0.0002, 0, 0.05),
    marketSlippagePct: boundedNum(env.COST_MARKET_SLIPPAGE_PCT || env.COST_SLIPPAGE_PCT, 0.0002, 0, 0.05),

    marketImpactPct: boundedNum(env.COST_MARKET_IMPACT_PCT, 0.0003, 0, 0.05),
    impactPct: boundedNum(env.COST_IMPACT_PCT || env.COST_MARKET_IMPACT_PCT, 0.0003, 0, 0.05),

    fallbackSpreadPct: boundedNum(env.COST_FALLBACK_SPREAD_PCT, 0.0008, 0, 0.05)
  }
});