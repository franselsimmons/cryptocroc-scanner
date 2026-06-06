// ================= FILE: src/config.js =================

export const env = process.env;

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

const csv = (value, fallback = []) => {
  if (value === undefined || value === null || value === '') return fallback;

  const values = String(value)
    .split(/[\s,|;]+/g)
    .map((part) => part.trim())
    .filter(Boolean);

  return values.length ? values : fallback;
};

const tradeSides = (value, fallback = ['LONG']) => {
  const allowed = new Set(['LONG', 'SHORT']);

  const values = csv(value, fallback)
    .map((side) => String(side || '').trim().toUpperCase())
    .filter((side) => allowed.has(side));

  return values.length ? [...new Set(values)] : fallback;
};

export const CONFIG = Object.freeze({
  strategyVersion: str(env.STRATEGY_VERSION, 'COARSE_MF_TS_LONG_ONLY_V2'),

  direction: {
    mode: str(env.DIRECTION_MODE, 'LONG_ONLY'),
    primaryTradeSide: str(env.PRIMARY_TRADE_SIDE, 'LONG').toUpperCase(),
    allowedTradeSides: tradeSides(env.ALLOWED_TRADE_SIDES, ['LONG']),

    shortEnabled: bool(env.SHORT_ENABLED, false),
    longEnabled: bool(env.LONG_ENABLED, true),

    blockLong: bool(env.BLOCK_LONG, false),
    blockShort: bool(env.BLOCK_SHORT, true)
  },

  app: {
    name: str(env.APP_NAME, 'Micro-Family Trading Admin'),
    baseUrl: str(env.APP_BASE_URL, env.VERCEL_URL ? `https://${env.VERCEL_URL}` : ''),
    adminPath: str(env.ADMIN_PATH, '/admin.html')
  },

  redis: {
    maxRequestBytes: int(env.REDIS_MAX_REQUEST_BYTES, 9_500_000)
  },

  bitget: {
    baseUrl: str(env.BITGET_API_BASE_URL, 'https://api.bitget.com'),
    productType: str(env.BITGET_PRODUCT_TYPE, 'usdt-futures'),
    timeoutMs: int(env.BITGET_TIMEOUT_MS, 8000)
  },

  scanner: {
    mode: str(env.SCANNER_MODE, 'LONG_ONLY'),
    allowedTradeSides: tradeSides(env.SCANNER_ALLOWED_TRADE_SIDES, ['LONG']),
    primaryTradeSide: str(env.SCANNER_PRIMARY_TRADE_SIDE, 'LONG').toUpperCase(),

    shortEnabled: bool(env.SCANNER_SHORT_ENABLED, false),
    longEnabled: bool(env.SCANNER_LONG_ENABLED, true),
    discardShortCandidates: bool(env.SCANNER_DISCARD_SHORT_CANDIDATES, true),

    maxSymbols: int(env.SCANNER_MAX_SYMBOLS, 300),

    maxCandidates: int(env.SCANNER_MAX_CANDIDATES, 300),
    analyzeMaxCandidates: int(env.SCANNER_ANALYZE_MAX_CANDIDATES, 300),

    dataConcurrency: int(env.SCANNER_DATA_CONCURRENCY, 12),

    minQuoteVolume24h: num(env.SCANNER_MIN_QUOTE_VOLUME_24H, 1_500_000),
    softMinQuoteVolume24h: num(env.SCANNER_SOFT_MIN_QUOTE_VOLUME_24H, 10_000),

    minAbsChange1h: num(env.SCANNER_MIN_ABS_CHANGE_1H, 0.12),
    minAbsChange24h: num(env.SCANNER_MIN_ABS_CHANGE_24H, 0.35),

    strictFilters: bool(env.SCANNER_STRICT_FILTERS, false),
    blockFakeBreakout: bool(env.SCANNER_BLOCK_FAKE_BREAKOUT, false),
    blockNoDirection: bool(env.SCANNER_BLOCK_NO_DIRECTION, false),
    blockSmallMove: bool(env.SCANNER_BLOCK_SMALL_MOVE, false),

    snapshotTtlSec: int(env.SCANNER_SNAPSHOT_TTL_SEC, 30 * 60),
    candleLimit: int(env.SCANNER_CANDLE_LIMIT, 100),
    fakeBreakoutLookback: int(env.SCANNER_FAKE_BREAKOUT_LOOKBACK, 24),

    lockTtlSec: int(env.SCANNER_LOCK_TTL_SEC, 540)
  },

  trade: {
    mode: str(env.TRADE_MODE, 'LONG_ONLY'),
    allowedTradeSides: tradeSides(env.TRADE_ALLOWED_TRADE_SIDES, ['LONG']),
    primaryTradeSide: str(env.TRADE_PRIMARY_TRADE_SIDE, 'LONG').toUpperCase(),

    shortEnabled: bool(env.TRADE_SHORT_ENABLED, false),
    longEnabled: bool(env.TRADE_LONG_ENABLED, true),
    blockLongEntries: bool(env.TRADE_BLOCK_LONG_ENTRIES, false),
    blockShortEntries: bool(env.TRADE_BLOCK_SHORT_ENTRIES, true),

    lockTtlSec: int(env.TRADE_LOCK_TTL_SEC, 180),

    maxCandidatesPerSnapshot: int(env.TRADE_MAX_CANDIDATES_PER_SNAPSHOT, 300),
    analyzeMaxCandidatesPerSnapshot: int(env.TRADE_ANALYZE_MAX_CANDIDATES_PER_SNAPSHOT, 300),
    maxAnalyzeCandidatesPerSnapshot: int(env.TRADE_MAX_ANALYZE_CANDIDATES_PER_SNAPSHOT, 300),

    maxSnapshotAgeSec: int(env.TRADE_MAX_SNAPSHOT_AGE_SEC, 8 * 60),

    dataConcurrency: int(env.TRADE_DATA_CONCURRENCY, 8),

    maxOpenPositions: int(env.TRADE_MAX_OPEN_POSITIONS, 30),
    maxOpenSameSide: int(env.TRADE_MAX_OPEN_SAME_SIDE, 30),

    positionTimeStopMin: int(env.TRADE_POSITION_TIME_STOP_MIN, 12 * 60),

    minRR: num(env.TRADE_MIN_RR, 0.50),
    defaultRR: num(env.TRADE_DEFAULT_RR, 1.50),

    maxSpreadPct: num(env.TRADE_MAX_SPREAD_PCT, 0.0015),

    minRiskPct: num(env.TRADE_MIN_RISK_PCT, 0.004),
    maxRiskPct: num(env.TRADE_MAX_RISK_PCT, 0.025),
    fallbackRiskPct: num(env.TRADE_FALLBACK_RISK_PCT, 0.005),

    atrRiskMult: num(env.TRADE_ATR_RISK_MULT, 1.2),
    spreadRiskMult: num(env.TRADE_SPREAD_RISK_MULT, 5),

    requireScannerGateForLiveEntries: bool(env.TRADE_REQUIRE_SCANNER_GATE_FOR_LIVE_ENTRIES, true),
    blockDiscoveryOnlyLiveEntries: bool(env.TRADE_BLOCK_DISCOVERY_ONLY_LIVE_ENTRIES, true),
    allowFakeBreakoutLiveEntries: bool(env.TRADE_ALLOW_FAKE_BREAKOUT_LIVE_ENTRIES, false),
    allowLowConfidenceLiveEntries: bool(env.TRADE_ALLOW_LOW_CONFIDENCE_LIVE_ENTRIES, false),
    minLiveScannerScore: num(env.TRADE_MIN_LIVE_SCANNER_SCORE, 0),

    allowLegacyMacroLiveEntries: bool(env.TRADE_ALLOW_LEGACY_MACRO_LIVE_ENTRIES, false),

    // Belangrijk voor coarse clustering:
    // true = live entry mag matchen op de coarse MF_V2 alias als refined XR-id niet actief is.
    allowCoarseMicroAliasLiveEntries: bool(env.TRADE_ALLOW_COARSE_MICRO_ALIAS_LIVE_ENTRIES, true),

    candleTtlSec: int(env.TRADE_CANDLE_CACHE_TTL_SEC, 90),
    orderbookTtlSec: int(env.TRADE_ORDERBOOK_CACHE_TTL_SEC, 12),
    fundingTtlSec: int(env.TRADE_FUNDING_CACHE_TTL_SEC, 120)
  },

  analyze: {
    mode: str(env.ANALYZE_MODE, 'LONG_ONLY'),
    allowedTradeSides: tradeSides(env.ANALYZE_ALLOWED_TRADE_SIDES, ['LONG']),
    primaryTradeSide: str(env.ANALYZE_PRIMARY_TRADE_SIDE, 'LONG').toUpperCase(),

    shortEnabled: bool(env.ANALYZE_SHORT_ENABLED, false),
    longEnabled: bool(env.ANALYZE_LONG_ENABLED, true),
    discardShortObservations: bool(env.ANALYZE_DISCARD_SHORT_OBSERVATIONS, true),

    schema: str(env.ANALYZE_SCHEMA || env.MICRO_FAMILY_SCHEMA, 'MF_V2'),
    legacySchema: str(env.ANALYZE_LEGACY_SCHEMA, 'MF_V1'),
    macroSchema: str(env.ANALYZE_MACRO_SCHEMA, 'MF_V1'),
    microSchema: str(env.ANALYZE_MICRO_SCHEMA, 'MF_V2'),

    /*
      BELANGRIJKE FIX:
      false = géén _XR_ micro IDs met symbolClass/fine buckets.
      Dit laat dezelfde LONG setup clusteren over meerdere coins.
      Daardoor stijgt sample van 1 naar echte aggregated samples.
    */
    refineExecutionMicroIds: false,

    /*
      Alleen diagnostisch.
      Als Vercel nog ANALYZE_REFINE_EXECUTION_MICRO_IDS=true heeft staan,
      negeren we die hierboven bewust.
    */
    refineExecutionMicroIdsEnvRequested: bool(env.ANALYZE_REFINE_EXECUTION_MICRO_IDS, false),

    /*
      Safe flags voor analyzer-code die coarse micro clustering ondersteunt.
      Als je analyzer deze velden nog niet leest, breken ze niets.
    */
    preferCoarseMicroIdsForLearning: true,
    includeSymbolClassInMicroId: false,
    includeFineBucketsInMicroId: false,
    mergeRefinedExecutionMicros: true,

    shadowEnabled: bool(env.ANALYZE_SHADOW_ENABLED, true),
    shadowHorizonMin: int(env.ANALYZE_SHADOW_HORIZON_MIN, 6 * 60),
    shadowWeight: num(env.ANALYZE_SHADOW_WEIGHT, 0.35),

    obsDedupeTtlSec: int(env.ANALYZE_OBS_DEDUPE_TTL_SEC, 14 * 24 * 3600),
    shadowDedupeTtlSec: int(env.ANALYZE_SHADOW_DEDUPE_TTL_SEC, 48 * 3600),

    maxShadowMonitorsPerRun: int(env.ANALYZE_MAX_SHADOW_MONITORS_PER_RUN, 80),

    freezeLockTtlSec: int(env.ANALYZE_FREEZE_LOCK_TTL_SEC, 600),
    activateLockTtlSec: int(env.ANALYZE_ACTIVATE_LOCK_TTL_SEC, 600),

    weekMicrosCompressionEnabled: bool(env.ANALYZE_WEEK_MICROS_COMPRESSION_ENABLED, true),
    weekMicrosCompressionLevel: int(env.ANALYZE_WEEK_MICROS_COMPRESSION_LEVEL, 6),
    maxMicroRowSetBytes: int(env.ANALYZE_MAX_MICRO_ROW_SET_BYTES, 250_000),

    weekMicrosTtlSec: int(env.ANALYZE_WEEK_MICROS_TTL_SEC, 21 * 24 * 3600),
    weekMetaTtlSec: int(env.ANALYZE_WEEK_META_TTL_SEC, 90 * 24 * 3600),

    storageConcurrency: int(env.ANALYZE_STORAGE_CONCURRENCY, 8),

    topMicrosSnapshotLimit: int(env.ANALYZE_TOP_MICROS_SNAPSHOT_LIMIT, 300),
    maxFullReadMicroRows: int(env.ANALYZE_MAX_FULL_READ_MICRO_ROWS, 1_500),
    fullReadSoftTimeoutMs: int(env.ANALYZE_FULL_READ_SOFT_TIMEOUT_MS, 2_400),
    preferTopSnapshotOnLargeIndex: bool(env.ANALYZE_PREFER_TOP_SNAPSHOT_ON_LARGE_INDEX, true),

    maxExamplesPerMicro: int(env.ANALYZE_MAX_EXAMPLES_PER_MICRO, 8),
    maxRecentOutcomesPerMicro: int(env.ANALYZE_MAX_RECENT_OUTCOMES_PER_MICRO, 8),
    maxDefinitionPartsPerMicro: int(env.ANALYZE_MAX_DEFINITION_PARTS_PER_MICRO, 64),
    maxParentDefinitionPartsPerMicro: int(env.ANALYZE_MAX_PARENT_DEFINITION_PARTS_PER_MICRO, 48),
    maxCounterKeysPerMicro: int(env.ANALYZE_MAX_COUNTER_KEYS_PER_MICRO, 18),
    maxCounterValuesPerCounter: int(env.ANALYZE_MAX_COUNTER_VALUES_PER_COUNTER, 24),
    maxStoredStringLength: int(env.ANALYZE_MAX_STORED_STRING_LENGTH, 480)
  },

  rotation: {
    mode: str(env.ROTATION_MODE, 'balanced'),
    directionMode: str(env.ROTATION_DIRECTION_MODE, 'LONG_ONLY'),
    allowedTradeSides: tradeSides(env.ROTATION_ALLOWED_TRADE_SIDES, ['LONG']),
    primaryTradeSide: str(env.ROTATION_PRIMARY_TRADE_SIDE, 'LONG').toUpperCase(),

    shortEnabled: bool(env.ROTATION_SHORT_ENABLED, false),
    longEnabled: bool(env.ROTATION_LONG_ENABLED, true),
    blockShortActivation: bool(env.ROTATION_BLOCK_SHORT_ACTIVATION, true),

    topNPerSide: int(env.ROTATION_TOP_N_PER_SIDE, 1),
    topNLong: int(env.ROTATION_TOP_N_LONG, 1),
    topNShort: int(env.ROTATION_TOP_N_SHORT, 0),

    minWeightedCompleted: num(env.ROTATION_MIN_WEIGHTED_COMPLETED, 0.35),

    enforceMaxPerMacroFamily: bool(env.ROTATION_ENFORCE_MAX_PER_MACRO_FAMILY, true),
    maxPerMacroFamily: int(env.ROTATION_MAX_PER_MACRO_FAMILY, 1),

    minPrimaryRowsForPreviousMerge: int(env.ROTATION_MIN_PRIMARY_ROWS_FOR_PREVIOUS_MERGE, 25),

    allowLegacyMacroActivation: bool(env.ROTATION_ALLOW_LEGACY_MACRO_ACTIVATION, false),

    allowSoftRotationFallback: bool(env.ROTATION_ALLOW_SOFT_ROTATION_FALLBACK, true),
    allowObservationRotationFallback: bool(env.ROTATION_ALLOW_OBSERVATION_ROTATION_FALLBACK, true),
    allowRawRotationFallback: bool(env.ROTATION_ALLOW_RAW_ROTATION_FALLBACK, true),

    allowManualUnknownTrueMicroIds: bool(env.ROTATION_ALLOW_MANUAL_UNKNOWN_TRUE_MICRO_IDS, true),
    allowManualBelowMinCompleted: bool(env.ROTATION_ALLOW_MANUAL_BELOW_MIN_COMPLETED, true),

    priorTrades: num(env.ROTATION_PRIOR_TRADES, 24),
    priorWinrate: num(env.ROTATION_PRIOR_WINRATE, 0.50),
    wilsonZ: num(env.ROTATION_WILSON_Z, 1.96),

    sampleReliabilityCap: num(env.ROTATION_SAMPLE_RELIABILITY_CAP, 50),
    avgRCap: num(env.ROTATION_AVG_R_CAP, 5),
    avgRSampleExponent: num(env.ROTATION_AVG_R_SAMPLE_EXPONENT, 1.35)
  },

  discord: {
    enabled: bool(env.DISCORD_ENABLED, true),
    webhookUrl: str(env.DISCORD_WEBHOOK_URL, ''),
    timeoutMs: int(env.DISCORD_TIMEOUT_MS, 2500),
    logLimit: int(env.DISCORD_LOG_LIMIT, 250),

    allowedTradeSides: tradeSides(env.DISCORD_ALLOWED_TRADE_SIDES, ['LONG']),
    shortEnabled: bool(env.DISCORD_SHORT_ENABLED, false),
    longEnabled: bool(env.DISCORD_LONG_ENABLED, true)
  },

  reset: {
    confirmText: str(env.RESET_CONFIRM_TEXT, 'FACTORY_RESET_CONFIRMED')
  },

  sizing: {
    enabled: bool(env.SIZING_ENABLED, true),

    baseRiskPct: num(env.SIZING_BASE_RISK_PCT, 0.0025),

    minMult: num(env.SIZING_MIN_MULT, 0.5),
    maxMult: num(env.SIZING_MAX_MULT, 1.25),

    maxTotalRiskPct: num(env.SIZING_MAX_TOTAL_RISK_PCT, 0.03),
    maxSameSideRiskPct: num(env.SIZING_MAX_SAME_SIDE_RISK_PCT, 0.03),

    maxCounterBtcRiskPct: num(env.SIZING_MAX_COUNTER_BTC_RISK_PCT, 0.0075)
  },

  manage: {
    applyLive: bool(env.MANAGE_APPLY_LIVE, false),

    beArmR: num(env.MANAGE_BE_ARM_R, 0.70),
    beLockR: num(env.MANAGE_BE_LOCK_R, 0.05),

    trailArmR: num(env.MANAGE_TRAIL_ARM_R, 1.00),
    trailLockR: num(env.MANAGE_TRAIL_LOCK_R, 0.35)
  },

  cost: {
    takerFeePct: num(env.COST_TAKER_FEE_PCT, 0.0006),
    makerFeePct: num(env.COST_MAKER_FEE_PCT, 0.0002),

    marketImpactPct: num(env.COST_MARKET_IMPACT_PCT, 0.0003),

    fallbackSpreadPct: num(env.COST_FALLBACK_SPREAD_PCT, 0.0008)
  }
});