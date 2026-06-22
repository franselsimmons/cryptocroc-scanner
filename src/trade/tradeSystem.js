// ================= FILE: src/trade/tradeSystem.js =================

import { CONFIG } from '../config.js';
import { KEYS, assertKeyAllowedForWriteScope } from '../keys.js';
import {
  getDurableRedis,
  getVolatileRedis,
  getJson,
  setJson,
  getKeys
} from '../redis.js';
import {
  normalizeBaseSymbol,
  normalizeContractSymbol,
  randomId,
  safeNumber,
  sideToTradeSide
} from '../utils.js';
import { getActiveRotation } from '../analyze/rotationEngine.js';
import {
  buildOpenPositionFromEntry,
  getOpenPositions,
  saveOpenPosition,
  monitorOpenPositions
} from './positionEngine.js';
import { riskFractionForEntry } from './positionSizing.js';
import { sendEntryAlert } from '../discord/discord.js';

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

const RUN_SCOPE = 'TRADE_FAST_ENTRY_BUDGET_FIRST';
const WRITE_SCOPE = 'TRADE_AND_ANALYZE_PARTIAL_ONLY';
const READ_SCOPE = 'READ_LONG_SCANNER_AND_MARKET_WEATHER';

const LONG_MARKET_WEATHER_KEY = `${LONG_KEY_PREFIX}MARKET:WEATHER:LATEST`;
const LONG_MARKET_UNIVERSE_KEY = `${LONG_KEY_PREFIX}MARKET:UNIVERSE:LATEST`;

const LONG_DISCORD_SELECTED_MICROS_KEY = `${LONG_KEY_PREFIX}DISCORD:SELECTED_MICROS`;
const LONG_DISCORD_SELECTION_FALLBACK_KEYS = Object.freeze([
  `${LONG_KEY_PREFIX}DISCORD:SELECTED_MICROS`,
  `${LONG_KEY_PREFIX}DISCORD:SELECTION`,
  `${LONG_KEY_PREFIX}MANUAL:SELECTED_MICROS`,
  `${LONG_KEY_PREFIX}MANUAL_SELECTION`,
  `${LONG_KEY_PREFIX}ROTATION:ACTIVE`,
  `${LONG_KEY_PREFIX}ANALYZE:ROTATION:ACTIVE`
]);

const DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT = 12;
const DEFAULT_HARD_MAX_CANDIDATES_PER_SNAPSHOT = 12;
const DEFAULT_MONITOR_TIMEOUT_MS = 2500;
const DEFAULT_ROTATION_TIMEOUT_MS = 800;
const DEFAULT_DISCORD_SELECTION_CACHE_TIMEOUT_MS = 300;
const DEFAULT_OPEN_POSITION_LOAD_TIMEOUT_MS = 900;
const DEFAULT_SAVE_POSITION_TIMEOUT_MS = 1200;
const DEFAULT_MAX_RUNTIME_MS = 26000;
const DEFAULT_ENTRY_LOOP_RESERVE_MS = 1500;
const DEFAULT_MIN_ENTRY_LOOP_ATTEMPTS = 3;

const DEFAULT_POSITION_TIME_STOP_MIN = 720;
const DEFAULT_FALLBACK_RISK_PCT = 0.005;
const DEFAULT_RR = 1.5;
const MIN_COMPLETED_ACTIVE_LEARNING = 20;

const SETUP_TYPES = [
  'BREAKOUT',
  'RETEST',
  'SWEEP_REVERSAL',
  'CONTINUATION',
  'COMPRESSION'
];

const REGIME_BUCKETS = [
  'TREND',
  'CHOP',
  'SQUEEZE'
];

const CONFIRMATION_PROFILES = [
  'A_STRONG_ALIGN',
  'B_FLOW_ALIGN',
  'C_VOLUME_ALIGN',
  'D_MIXED_OK',
  'E_WEAK_CONTRA'
];

function now() {
  return Date.now();
}

function upper(value = '') {
  return String(value || '').trim().toUpperCase();
}

function cfgNumber(value, fallback) {
  const n = safeNumber(value, fallback);
  return Number.isFinite(n) ? n : fallback;
}

function clampInt(value, fallback, min, max) {
  const n = Math.floor(cfgNumber(value, fallback));
  return Math.max(min, Math.min(max, n));
}

function clampNumber(value, fallback, min, max) {
  const n = cfgNumber(value, fallback);
  return Math.max(min, Math.min(max, n));
}

function withTimeout(promise, timeoutMs, fallback) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);

    Promise.resolve(promise)
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        resolve(typeof fallback === 'function' ? fallback(error) : fallback);
      });
  });
}

function namespacedLongKey(key, fallback = '') {
  const raw = String(key || fallback || '').trim();

  if (!raw) return `${LONG_KEY_PREFIX}${fallback}`;
  if (raw.startsWith(LONG_KEY_PREFIX)) return raw;
  if (raw.startsWith('SHORT:')) return `${LONG_KEY_PREFIX}${raw.slice('SHORT:'.length)}`;

  return `${LONG_KEY_PREFIX}${raw}`;
}

function keyFromMaybeFunction(fn, arg, fallback) {
  try {
    if (typeof fn === 'function') return fn(arg);
  } catch {
    return fallback;
  }

  return fallback;
}

function longScanSnapshotKey(snapshotId) {
  return namespacedLongKey(
    keyFromMaybeFunction(KEYS.long?.scan?.snapshot, snapshotId, null) ||
      keyFromMaybeFunction(KEYS.scan?.longSnapshot, snapshotId, null) ||
      keyFromMaybeFunction(KEYS.scan?.snapshot, snapshotId, null),
    `SCAN:SNAPSHOT:${snapshotId}`
  );
}

function longScanSnapshotPattern() {
  return namespacedLongKey(
    keyFromMaybeFunction(KEYS.long?.scan?.snapshot, '*', null) ||
      keyFromMaybeFunction(KEYS.scan?.longSnapshot, '*', null) ||
      keyFromMaybeFunction(KEYS.scan?.snapshot, '*', null),
    'SCAN:SNAPSHOT:*'
  );
}

const LONG_KEYS = {
  scan: {
    latest: namespacedLongKey(
      KEYS.long?.scan?.latest ||
        KEYS.scan?.longLatest ||
        KEYS.scan?.latest,
      'SCAN:LATEST'
    ),
    snapshot: longScanSnapshotKey,
    snapshotPattern: longScanSnapshotPattern
  },

  trade: {
    runMeta: namespacedLongKey(
      KEYS.long?.trade?.runMeta ||
        KEYS.trade?.longRunMeta ||
        KEYS.trade?.runMeta,
      'TRADE:RUN:META'
    ),
    lastProcessedSnapshot: namespacedLongKey(
      KEYS.long?.trade?.lastProcessedSnapshot ||
        KEYS.trade?.longLastProcessedSnapshot ||
        KEYS.trade?.lastProcessedSnapshot,
      'TRADE:LAST_PROCESSED_SNAPSHOT'
    )
  }
};

function tradeConfig(options = {}) {
  return {
    maxCandidatesPerSnapshot: clampInt(
      options.maxCandidatesPerSnapshot ??
        options.maxCandidates ??
        CONFIG.long?.trade?.maxCandidatesPerSnapshot ??
        CONFIG.trade?.maxCandidatesPerSnapshot,
      DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT,
      1,
      DEFAULT_HARD_MAX_CANDIDATES_PER_SNAPSHOT
    ),

    hardMaxCandidatesPerSnapshot: DEFAULT_HARD_MAX_CANDIDATES_PER_SNAPSHOT,

    monitorTimeoutMs: clampInt(
      options.monitorTimeoutMs ??
        CONFIG.long?.trade?.monitorTimeoutMs ??
        CONFIG.trade?.monitorTimeoutMs,
      DEFAULT_MONITOR_TIMEOUT_MS,
      500,
      3500
    ),

    rotationTimeoutMs: clampInt(
      options.rotationTimeoutMs,
      DEFAULT_ROTATION_TIMEOUT_MS,
      250,
      1500
    ),

    discordSelectionCacheTimeoutMs: clampInt(
      options.discordSelectionCacheTimeoutMs ??
        CONFIG.long?.trade?.discordSelectionCacheTimeoutMs ??
        CONFIG.trade?.discordSelectionCacheTimeoutMs,
      DEFAULT_DISCORD_SELECTION_CACHE_TIMEOUT_MS,
      100,
      1000
    ),

    openPositionLoadTimeoutMs: clampInt(
      options.openPositionLoadTimeoutMs,
      DEFAULT_OPEN_POSITION_LOAD_TIMEOUT_MS,
      250,
      2000
    ),

    savePositionTimeoutMs: clampInt(
      options.savePositionTimeoutMs,
      DEFAULT_SAVE_POSITION_TIMEOUT_MS,
      300,
      2500
    ),

    maxRuntimeMs: clampInt(
      options.maxRuntimeMs ??
        CONFIG.long?.trade?.maxRuntimeMs ??
        CONFIG.trade?.maxRuntimeMs,
      DEFAULT_MAX_RUNTIME_MS,
      8000,
      26000
    ),

    entryLoopReserveMs: clampInt(
      options.entryLoopReserveMs ??
        options.entryReserveMs,
      DEFAULT_ENTRY_LOOP_RESERVE_MS,
      250,
      3000
    ),

    minEntryLoopAttempts: clampInt(
      options.minEntryLoopAttempts ??
        options.minEntryAttempts,
      DEFAULT_MIN_ENTRY_LOOP_ATTEMPTS,
      1,
      8
    ),

    fallbackRiskPct: clampNumber(
      CONFIG.long?.trade?.fallbackRiskPct ??
        CONFIG.trade?.fallbackRiskPct,
      DEFAULT_FALLBACK_RISK_PCT,
      0.001,
      0.03
    ),

    rr: clampNumber(
      CONFIG.long?.trade?.defaultRR ??
        CONFIG.trade?.defaultRR,
      DEFAULT_RR,
      0.5,
      5
    ),

    positionTimeStopMin: clampInt(
      CONFIG.long?.trade?.positionTimeStopMin ??
        CONFIG.trade?.positionTimeStopMin,
      DEFAULT_POSITION_TIME_STOP_MIN,
      1,
      7 * 24 * 60
    )
  };
}

function sizingConfig() {
  return {
    enabled: CONFIG.long?.sizing?.enabled ?? CONFIG.sizing?.enabled ?? true,
    baseRiskPct: cfgNumber(
      CONFIG.long?.sizing?.baseRiskPct ??
        CONFIG.sizing?.baseRiskPct,
      0.0025
    )
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

    scannerSide: TARGET_SCANNER_SIDE,
    actualScannerSide: TARGET_SCANNER_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false
  };
}

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
    scannerLatestReadOnlyInsideTradeSystem: true,
    preserveScannerLatest: true,
    preserveScannerSnapshot: true,
    preserveScannerHistory: true,

    scannerRunAllowed: false,
    scannerRunBeforeTrade: false,
    scannerRunDisabledInsideTradeSystem: true,
    noInternalScannerRunInsideTradeSystem: true,
    noScannerRun: true,
    noScannerRefresh: true,

    writesScanner: false,
    writesScannerLatest: false,
    writesScannerSnapshot: false,
    writesScannerHistory: false,

    writesMarketUniverse: false,
    writesMarketWeather: false,
    writesMarketWeatherInput: false,

    writesTrade: true,
    writesTradeRunMeta: true,
    writesTradeLastProcessedSnapshot: true,
    writesTradePositions: true,

    writesAnalyze: false,
    writesAnalyzePartial: false,
    writesMicroFamilies: false,
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
    exchangeCallsDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    noRealOrders: true,
    noExchangeOrders: true,

    ignoreGlobalMaxOpenPositions: true,
    noGlobalMaxOpenPositionsBlock: true,
    globalMaxOpenPositionsBlockDisabled: true,
    oneOpenPositionPerSymbol: true,
    maxOneOpenPositionPerSymbol: true,

    shortRootTouched: false,

    discordSelectionCacheKey: LONG_DISCORD_SELECTED_MICROS_KEY,
    discordSelectionCacheReadOnlyInsideTradeSystem: true
  };
}

function virtualFlags() {
  return {
    virtualOnly: true,
    virtualTracked: true,
    virtualLearning: true,
    virtualLearningForced: true,
    source: 'VIRTUAL',
    outcomeSource: 'VIRTUAL',

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    realOrdersDisabled: true,
    exchangeCallsDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    noExchangeOrders: true,
    noRealOrders: true,

    learningOnly: true,
    microFamilyLearning: true,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintOnlyMetadata: true,
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,

    executionFingerprintRole: 'METADATA_ONLY',
    executionFingerprintOnlyMetadata: true,
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,

    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    exactTrueMicroFamilyRequired: true,
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

    parentLearningEnabled: true,
    childLearningEnabled: true,
    selectionGranularity: 'EXACT_75_CHILD',
    fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED',

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    learningRemainsBroad: true,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    completedOnlyClosedVirtualOrShadow: true,
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING
  };
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

  if (raw.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
  if (raw.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function inferRowTradeSide(row = {}) {
  if (!row || typeof row !== 'object') return normalizeTradeSide(row);

  const directSources = [
    row.tradeSide,
    row.positionSide,
    row.direction,
    row.scannerSide,
    row.actualScannerSide,
    row.analysisSide,
    row.signalSide,
    row.entrySide,
    row.side,
    row.bias,
    row.marketBias
  ];

  for (const value of directSources) {
    const side = normalizeTradeSide(value);
    if (side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE) return side;
  }

  const idText = [
    row.trueMicroFamilyId,
    row.microFamilyId,
    row.childTrueMicroFamilyId,
    row.parentTrueMicroFamilyId,
    row.coarseMicroFamilyId,
    row.scannerMicroFamilyId,
    row.scannerFamilyId,
    row.familyId,
    row.id,
    row.key,
    row.reason,
    row.scannerReason,
    row.definition
  ]
    .map((value) => upper(value))
    .filter(Boolean)
    .join('|');

  if (idText.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
  if (idText.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;

  if (row.longOnly === true || row.shortDisabled === true) return TARGET_TRADE_SIDE;
  if (row.shortOnly === true || row.longDisabled === true) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function normalizeSymbol(candidate = {}) {
  const contractSymbol = normalizeContractSymbol(
    candidate.contractSymbol ||
      candidate.symbol ||
      candidate.instId ||
      candidate.instrumentId
  );

  const symbol =
    normalizeBaseSymbol(candidate.symbol || candidate.baseSymbol || contractSymbol) ||
    normalizeBaseSymbol(contractSymbol);

  return {
    symbol,
    baseSymbol: symbol,
    contractSymbol
  };
}

function parseLongTaxonomyId(id = '') {
  const value = upper(id);

  const match = /^MICRO_LONG_([A-Z_]+)_(TREND|CHOP|SQUEEZE)(?:_(A_STRONG_ALIGN|B_FLOW_ALIGN|C_VOLUME_ALIGN|D_MIXED_OK|E_WEAK_CONTRA))?$/.exec(value);

  if (!match) {
    return {
      valid: false,
      selectable: false,
      parentTrueMicroFamilyId: null,
      childTrueMicroFamilyId: null,
      setupType: null,
      regimeBucket: null,
      confirmationProfile: null
    };
  }

  const setupType = match[1];
  const regimeBucket = match[2];
  const confirmationProfile = match[3] || null;

  if (!SETUP_TYPES.includes(setupType)) return { valid: false, selectable: false };
  if (!REGIME_BUCKETS.includes(regimeBucket)) return { valid: false, selectable: false };
  if (confirmationProfile && !CONFIRMATION_PROFILES.includes(confirmationProfile)) return { valid: false, selectable: false };

  const parentTrueMicroFamilyId = `MICRO_LONG_${setupType}_${regimeBucket}`;
  const childTrueMicroFamilyId = confirmationProfile
    ? `${parentTrueMicroFamilyId}_${confirmationProfile}`
    : null;

  return {
    valid: true,
    selectable: Boolean(childTrueMicroFamilyId),
    parentTrueMicroFamilyId,
    childTrueMicroFamilyId,
    trueMicroFamilyId: childTrueMicroFamilyId || parentTrueMicroFamilyId,
    setupType,
    regimeBucket,
    confirmationProfile
  };
}

function isSelectableTrueMicroId(id = '') {
  return parseLongTaxonomyId(id).selectable === true;
}

function parentFromChild(id = '') {
  return parseLongTaxonomyId(id).parentTrueMicroFamilyId || null;
}

function normalizeRegime(value = '') {
  const text = upper(value);

  if (text.includes('SQUEEZE') || text.includes('COMPRESS')) return 'SQUEEZE';
  if (text.includes('CHOP') || text.includes('RANGE') || text.includes('SIDEWAY')) return 'CHOP';
  if (text.includes('TREND') || text.includes('MOMENTUM') || text.includes('DIRECTION')) return 'TREND';

  return 'TREND';
}

function deriveSetupType(row = {}) {
  const text = [
    row.setupType,
    row.setup,
    row.scannerReason,
    row.reason,
    row.familyId,
    row.scannerFamilyId,
    row.definition
  ]
    .map((value) => upper(value))
    .join('|');

  if (text.includes('SWEEP')) return 'SWEEP_REVERSAL';
  if (text.includes('RETEST')) return 'RETEST';
  if (text.includes('CONTINUATION') || text.includes('CONTINUE')) return 'CONTINUATION';
  if (text.includes('COMPRESSION') || text.includes('SQUEEZE')) return 'COMPRESSION';
  if (text.includes('BREAKOUT')) return 'BREAKOUT';

  return 'RETEST';
}

function deriveConfirmationProfile(row = {}, marketContext = {}) {
  const direct = upper(row.confirmationProfile);

  if (CONFIRMATION_PROFILES.includes(direct)) return direct;

  const score = safeNumber(row.scannerScore ?? row.moveScore ?? row.score, 0);
  const volumeConfirmed = Boolean(row.volumeConfirmed || row.volumeSpike || row.quoteVolumeSpike);
  const flow = upper(row.flow || row.flowCoarse || row.currentFlow);
  const marketTrend = upper(marketContext.trendSide);

  if (marketTrend === OPPOSITE_TRADE_SIDE) return 'E_WEAK_CONTRA';
  if (score >= 80 && flow.includes('TREND')) return 'A_STRONG_ALIGN';
  if (flow.includes('TREND') || flow.includes('BUILD') || flow.includes('ALIGN')) return 'B_FLOW_ALIGN';
  if (volumeConfirmed) return 'C_VOLUME_ALIGN';
  if (score < 25) return 'E_WEAK_CONTRA';

  return 'D_MIXED_OK';
}

function deriveExact75Family(row = {}, marketContext = {}) {
  const direct = [
    row.childTrueMicroFamilyId,
    row.trueMicroFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.microFamilyId
  ]
    .map((id) => upper(id))
    .find(isSelectableTrueMicroId);

  if (direct) {
    const parsed = parseLongTaxonomyId(direct);

    return {
      trueMicroFamilyId: direct,
      childTrueMicroFamilyId: direct,
      parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
      setupType: parsed.setupType,
      regimeBucket: parsed.regimeBucket,
      confirmationProfile: parsed.confirmationProfile,
      source: 'EXISTING_EXACT_75_TRUE_MICRO'
    };
  }

  const setupType = deriveSetupType(row);
  const regimeBucket = normalizeRegime(
    row.regimeBucket ||
      row.regime ||
      row.currentRegime ||
      marketContext.regime ||
      'TREND'
  );
  const confirmationProfile = deriveConfirmationProfile(row, marketContext);

  const parentTrueMicroFamilyId = `MICRO_LONG_${setupType}_${regimeBucket}`;
  const trueMicroFamilyId = `${parentTrueMicroFamilyId}_${confirmationProfile}`;

  return {
    trueMicroFamilyId,
    childTrueMicroFamilyId: trueMicroFamilyId,
    parentTrueMicroFamilyId,
    setupType,
    regimeBucket,
    confirmationProfile,
    source: 'FALLBACK_EXACT_75_FROM_SCANNER_SETUP_REGIME_CONFIRMATION'
  };
}

function priceFromCandidate(row = {}) {
  return safeNumber(
    row.entry ??
      row.price ??
      row.markPrice ??
      row.currentPrice ??
      row.lastPrice ??
      row.close,
    0
  );
}

function buildRisk(row = {}, cfg = tradeConfig()) {
  const entry = priceFromCandidate(row);

  if (entry <= 0) {
    return {
      ok: false,
      reason: 'NO_PRICE_FOR_LONG_STANDARDIZED_RISK',
      entry: 0,
      sl: 0,
      tp: 0,
      rr: 0
    };
  }

  const riskPct = clampNumber(
    row.riskPct ?? cfg.fallbackRiskPct,
    cfg.fallbackRiskPct,
    0.001,
    0.03
  );

  const rr = clampNumber(row.rr ?? cfg.rr, cfg.rr, 0.5, 5);

  const sl = entry * (1 - riskPct);
  const tp = entry * (1 + riskPct * rr);

  return {
    ok: true,
    reason: 'LONG_VIRTUAL_LEARNING_STANDARDIZED_TP_SL',
    entry,
    sl,
    tp,
    rr,
    riskPct,
    rewardPct: (tp - entry) / entry,
    validLongRiskShape: true,
    longRiskShape: 'sl < entry < tp',
    longRiskFormula: 'sl < entry < tp',
    longTpExitRule: 'price >= tp',
    longSlExitRule: 'price <= sl',
    longTimeStopExitRule: 'TIME_STOP',
    longGrossRFormula: '(exitPrice - entry) / (entry - initialSl)',
    longCurrentRFormula: '(currentPrice - entry) / (entry - initialSl)',
    riskSource: 'LEARNING_STANDARDIZED_TP_SL',
    riskEngineRisk: false,
    standardizedLearningRisk: true
  };
}

function compactMarketWeather(value = null) {
  if (!value || typeof value !== 'object') return null;

  return {
    ok: value.ok ?? null,
    available: value.available ?? null,
    version: value.version || null,
    source: value.source || null,
    snapshotId: value.snapshotId || null,
    createdAt: value.createdAt || null,
    completedAt: value.completedAt || null,
    updatedAt: value.updatedAt || null,
    currentRegime: value.currentRegime || value.regime || null,
    regime: value.regime || value.currentRegime || null,
    currentTrendSide: value.currentTrendSide || value.trendSide || null,
    trendSide: value.trendSide || value.currentTrendSide || null,
    confidence: value.confidence ?? null,
    bullishPct: value.bullishPct ?? null,
    bearishPct: value.bearishPct ?? null,
    squeezePct: value.squeezePct ?? null,
    count: value.count ?? value.universeCount ?? null,
    universeCount: value.universeCount ?? value.count ?? null,
    btcState: value.btcState || null,
    rowsOmittedForRedis: true,
    symbolsOmittedForRedis: true,
    compactedForRedis: true
  };
}

function extractMarketContext(weather = null) {
  const source = weather && typeof weather === 'object' ? weather : {};
  const createdAt = safeNumber(source.createdAt ?? source.completedAt ?? source.updatedAt, 0);
  const trendSide = normalizeTradeSide(source.currentTrendSide || source.trendSide || source.side || source.marketSide);

  return {
    ok: Boolean(source && Object.keys(source).length),
    createdAt,
    ageSec: createdAt > 0 ? Math.round((now() - createdAt) / 1000) : null,
    stale: createdAt > 0 ? (now() - createdAt) / 1000 > 15 * 60 : true,
    regime: normalizeRegime(source.currentRegime || source.regime || 'TREND'),
    trendSide: trendSide === TARGET_TRADE_SIDE || trendSide === OPPOSITE_TRADE_SIDE ? trendSide : 'UNKNOWN',
    bullishPct: source.bullishPct ?? null,
    bearishPct: source.bearishPct ?? null,
    squeezePct: source.squeezePct ?? null,
    confidence: safeNumber(source.confidence, 50),
    key: LONG_MARKET_WEATHER_KEY,
    universeKey: LONG_MARKET_UNIVERSE_KEY,
    source: compactMarketWeather(source),
    universe: null,
    compactedForRedis: true
  };
}

async function loadMarketContext() {
  const redis = getVolatileRedis();

  const weather = await getJson(redis, LONG_MARKET_WEATHER_KEY, null).catch(() => null);

  return extractMarketContext(weather);
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

function hasSnapshotShape(value) {
  return Boolean(value && typeof value === 'object' && Array.isArray(value.candidates));
}

function extractSnapshotId(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;

  return value.snapshotId || value.id || value.latestSnapshotId || value.scanId || null;
}

function countTargetCandidates(snapshot = {}) {
  const rows = Array.isArray(snapshot.candidates) ? snapshot.candidates : [];
  return rows.filter((row) => inferRowTradeSide(row) === TARGET_TRADE_SIDE).length;
}

function countOppositeCandidates(snapshot = {}) {
  const rows = Array.isArray(snapshot.candidates) ? snapshot.candidates : [];
  return rows.filter((row) => inferRowTradeSide(row) === OPPOSITE_TRADE_SIDE).length;
}

async function safeGetJson(redis, key, fallback = null) {
  return getJson(redis, key, fallback).catch(() => fallback);
}

async function loadRecentSnapshots(redis) {
  const keys = await getKeys(redis, LONG_KEYS.scan.snapshotPattern(), 80).catch(() => []);

  const rows = await Promise.all(
    keys.map(async (key) => {
      const snapshot = await safeGetJson(redis, key, null);

      if (!hasSnapshotShape(snapshot)) return null;

      return {
        key,
        snapshot,
        createdAt: snapshotCreatedAt(snapshot),
        targetCount: countTargetCandidates(snapshot),
        oppositeCount: countOppositeCandidates(snapshot)
      };
    })
  );

  return rows
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function normalizeSelectedSnapshot(snapshot = {}, meta = {}) {
  const rows = Array.isArray(snapshot.candidates) ? snapshot.candidates : [];

  const candidates = rows
    .filter((row) => inferRowTradeSide(row) === TARGET_TRADE_SIDE)
    .map((row) => ({
      ...row,
      ...normalizeSymbol(row),
      ...sideFlags(),
      ...virtualFlags(),
      ...isolationFlags(),
      snapshotId: snapshot.snapshotId || row.snapshotId || null,
      scannerSide: TARGET_SCANNER_SIDE,
      actualScannerSide: TARGET_SCANNER_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      positionSide: TARGET_TRADE_SIDE,
      direction: TARGET_TRADE_SIDE
    }))
    .filter((row) => row.symbol && row.contractSymbol);

  return {
    ...snapshot,
    selectedSnapshotSource: meta.source || null,
    selectedSnapshotReason: meta.reason || null,
    selectedTargetCandidateCount: candidates.length,
    selectedLongCandidateCount: candidates.length,
    selectedOppositeCandidateCount: countOppositeCandidates(snapshot),
    selectedShortCandidateCount: countOppositeCandidates(snapshot),
    candidates,
    candidatesCount: candidates.length,
    longCandidatesCount: candidates.length,
    shortCandidatesCount: 0,
    ...sideFlags(),
    ...virtualFlags(),
    ...isolationFlags()
  };
}

async function getLatestSnapshot() {
  const redis = getVolatileRedis();

  const latest = await safeGetJson(redis, LONG_KEYS.scan.latest, null);
  const latestSnapshotId = extractSnapshotId(latest);

  const candidates = [];

  if (hasSnapshotShape(latest)) {
    candidates.push({
      source: 'VOLATILE:LONG:SCAN:LATEST_FULL_SNAPSHOT',
      snapshot: latest,
      createdAt: snapshotCreatedAt(latest),
      targetCount: countTargetCandidates(latest)
    });
  }

  if (latestSnapshotId) {
    const byId = await safeGetJson(redis, LONG_KEYS.scan.snapshot(latestSnapshotId), null);

    if (hasSnapshotShape(byId)) {
      candidates.push({
        source: 'VOLATILE:LONG:SCAN:SNAPSHOT_BY_LATEST_ID',
        snapshot: byId,
        createdAt: snapshotCreatedAt(byId),
        targetCount: countTargetCandidates(byId)
      });
    }
  }

  const recent = await loadRecentSnapshots(redis);
  for (const item of recent) {
    candidates.push({
      source: `VOLATILE:LONG:SCAN:RECENT_SEARCH:${item.key}`,
      snapshot: item.snapshot,
      createdAt: item.createdAt,
      targetCount: item.targetCount
    });
  }

  const unique = new Map();

  for (const item of candidates) {
    const id = item.snapshot?.snapshotId || item.source;
    if (!id) continue;

    const previous = unique.get(id);

    if (!previous || item.createdAt > previous.createdAt || item.targetCount > previous.targetCount) {
      unique.set(id, item);
    }
  }

  const selected = [...unique.values()]
    .filter((item) => hasSnapshotShape(item.snapshot))
    .sort((a, b) => b.createdAt - a.createdAt)[0];

  if (!selected) return null;

  return normalizeSelectedSnapshot(selected.snapshot, {
    source: selected.source,
    reason: selected.targetCount > 0
      ? 'LATEST_LONG_SCANNER_SNAPSHOT'
      : 'LATEST_LONG_SCANNER_SNAPSHOT_WITH_NO_LONG_CANDIDATES'
  });
}

function buildPriceHintMap(snapshot = {}) {
  const map = new Map();

  for (const row of Array.isArray(snapshot.candidates) ? snapshot.candidates : []) {
    const normalized = normalizeSymbol(row);
    const price = priceFromCandidate(row);

    if (normalized.symbol && price > 0) map.set(normalized.symbol, price);
    if (normalized.contractSymbol && price > 0) map.set(normalized.contractSymbol, price);
  }

  return map;
}

function buildOpenSymbolSet(openPositions = []) {
  const set = new Set();

  for (const position of Array.isArray(openPositions) ? openPositions : []) {
    const normalized = normalizeSymbol(position);

    if (normalized.symbol) set.add(normalized.symbol);
    if (normalized.contractSymbol) set.add(normalized.contractSymbol);
  }

  return set;
}

function rowSymbolKeys(row = {}) {
  const normalized = normalizeSymbol(row);

  return [
    normalized.symbol,
    normalized.contractSymbol,
    row.symbol,
    row.baseSymbol,
    row.contractSymbol
  ]
    .map((value) => String(value || '').trim().toUpperCase())
    .filter(Boolean);
}

function hasOpenSymbol(openSymbolSet, row = {}) {
  return rowSymbolKeys(row).some((key) => openSymbolSet.has(key));
}

function collectSelectedIds(source, out = []) {
  if (!source) return out;

  if (typeof source === 'string') {
    out.push(source);
    return out;
  }

  if (Array.isArray(source)) {
    for (const item of source) collectSelectedIds(item, out);
    return out;
  }

  if (typeof source !== 'object') return out;

  const directFields = [
    source.trueMicroFamilyId,
    source.childTrueMicroFamilyId,
    source.microFamilyId,
    source.learningMicroFamilyId,
    source.analyzeMicroFamilyId,
    source.fixedTaxonomyMicroFamilyId,
    source.id,
    source.key
  ];

  for (const value of directFields) {
    if (value) out.push(value);
  }

  const arrayFields = [
    source.selectedTrueMicroFamilyIds,
    source.activeTrueMicroFamilyIds,
    source.trueMicroFamilyIds,
    source.childTrueMicroFamilyIds,
    source.selectedMicroFamilyIds,
    source.activeMicroFamilyIds,
    source.microFamilyIds,
    source.selectedIds,
    source.ids,
    source.microFamilies,
    source.selectedMicroFamilies,
    source.activeMicroFamilies,
    source.rows,
    source.selectedRows,
    source.selection,
    source.selected
  ];

  for (const value of arrayFields) {
    if (Array.isArray(value)) collectSelectedIds(value, out);
  }

  return out;
}

function normalizeSelectedMicroIds(value = {}) {
  return [...new Set(
    collectSelectedIds(value)
      .map((id) => upper(id))
      .filter(isSelectableTrueMicroId)
  )];
}

function discordSelectionKeys() {
  return [...new Set([
    namespacedLongKey(
      KEYS.long?.discord?.selectedMicros ||
        KEYS.discord?.longSelectedMicros ||
        KEYS.discord?.selectedLongMicros,
      'DISCORD:SELECTED_MICROS'
    ),
    namespacedLongKey(
      KEYS.long?.manual?.selectedMicros ||
        KEYS.manual?.longSelectedMicros ||
        KEYS.manualSelection?.longSelectedMicros,
      'MANUAL:SELECTED_MICROS'
    ),
    namespacedLongKey(
      KEYS.long?.rotation?.active ||
        KEYS.rotation?.longActive ||
        KEYS.rotation?.active,
      'ROTATION:ACTIVE'
    ),
    ...LONG_DISCORD_SELECTION_FALLBACK_KEYS
  ].filter(Boolean))];
}

async function loadDiscordSelectionCacheFast(cfg, runtimeWarnings) {
  const redis = getDurableRedis();
  const keys = discordSelectionKeys();

  for (const key of keys) {
    const payload = await withTimeout(
      getJson(redis, key, null).catch(() => null),
      cfg.discordSelectionCacheTimeoutMs,
      null
    );

    const selectedTrueMicroFamilyIds = normalizeSelectedMicroIds(payload || {});

    if (selectedTrueMicroFamilyIds.length > 0) {
      return {
        ok: true,
        source: key,
        discordSelectionSource: key,
        discordSelectionCacheHit: true,
        discordSelectionCacheKey: key,
        rotationId: payload?.rotationId || payload?.selectedRotationId || payload?.activeRotationId || null,
        selectedRotationId: payload?.selectedRotationId || payload?.rotationId || payload?.activeRotationId || null,
        activeRotationId: payload?.activeRotationId || payload?.rotationId || payload?.selectedRotationId || null,
        selectedTrueMicroFamilyIds,
        activeTrueMicroFamilyIds: selectedTrueMicroFamilyIds,
        trueMicroFamilyIds: selectedTrueMicroFamilyIds,
        childTrueMicroFamilyIds: selectedTrueMicroFamilyIds,
        selectedMicroFamilyIds: selectedTrueMicroFamilyIds,
        activeMicroFamilyIds: selectedTrueMicroFamilyIds,
        microFamilyIds: selectedTrueMicroFamilyIds,
        manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
        discordSelectionRule: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY',
        selectionGranularity: 'EXACT_75_CHILD',
        trueMicroFamilySchema: TRUE_MICRO_SCHEMA
      };
    }
  }

  runtimeWarnings.push('DISCORD_SELECTION_CACHE_EMPTY_TRYING_ROTATION_FALLBACK');

  return null;
}

function buildSelectedAlertContext(activeRotation = null) {
  const selectedMicroFamilyIds = normalizeSelectedMicroIds(activeRotation || {});
  const selectedMicroSet = new Set(selectedMicroFamilyIds);

  return {
    rotationId:
      activeRotation?.rotationId ||
      activeRotation?.selectedRotationId ||
      activeRotation?.activeRotationId ||
      null,

    activeRotationId:
      activeRotation?.activeRotationId ||
      activeRotation?.rotationId ||
      activeRotation?.selectedRotationId ||
      null,

    selectedRotationId:
      activeRotation?.selectedRotationId ||
      activeRotation?.rotationId ||
      activeRotation?.activeRotationId ||
      null,

    discordSelectionSource: activeRotation?.discordSelectionSource || activeRotation?.source || null,
    discordSelectionCacheHit: Boolean(activeRotation?.discordSelectionCacheHit),
    discordSelectionCacheKey: activeRotation?.discordSelectionCacheKey || null,

    selectedMicroFamilyIds,
    selectedTrueMicroFamilyIds: selectedMicroFamilyIds,
    activeMicroFamilyIds: selectedMicroFamilyIds,
    activeTrueMicroFamilyIds: selectedMicroFamilyIds,

    selectedMicroSet,
    selectedParentTrueMicroFamilyIds: [...new Set(selectedMicroFamilyIds.map(parentFromChild).filter(Boolean))],
    empty: selectedMicroFamilyIds.length === 0,
    selectionPurpose: 'DISCORD_ALERT_ONLY',
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    discordSelectionRule: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY'
  };
}

function rowMatchesSelectedAlertMicro(alertContext, row = {}) {
  if (!alertContext || alertContext.empty) return false;
  return alertContext.selectedMicroSet.has(row.trueMicroFamilyId);
}

function currentFitGate(row = {}) {
  const fit = upper(row.currentFit || row.entryCurrentFit || 'MATCH');
  const confidence = safeNumber(row.currentFitConfidence ?? row.entryCurrentFitConfidence, 50);

  if (fit === 'MISFIT') {
    return {
      ok: false,
      reason: 'DISCORD_BLOCKED_CURRENT_FIT_MISFIT',
      currentFit: fit,
      currentFitConfidence: confidence
    };
  }

  return {
    ok: true,
    reason: 'DISCORD_CURRENT_FIT_OK_OR_SOFT',
    currentFit: fit,
    currentFitConfidence: confidence
  };
}

function attachCurrentFit(row = {}, marketContext = {}) {
  const trendSide = marketContext.trendSide;

  let currentFit = 'NEUTRAL';
  let score = 0;

  if (trendSide === TARGET_TRADE_SIDE) {
    currentFit = 'MATCH';
    score = 60;
  } else if (trendSide === OPPOSITE_TRADE_SIDE) {
    currentFit = 'MISFIT';
    score = -45;
  }

  return {
    ...row,
    currentMarketWeather: marketContext.source || null,
    currentMarketUniverse: null,
    currentMarketWeatherKey: LONG_MARKET_WEATHER_KEY,
    currentMarketUniverseKey: LONG_MARKET_UNIVERSE_KEY,
    currentMarketWeatherAgeSec: marketContext.ageSec ?? null,
    currentMarketWeatherStale: Boolean(marketContext.stale),
    currentRegime: marketContext.regime || 'UNKNOWN',
    currentTrendSide: marketContext.trendSide || 'UNKNOWN',
    currentBullishPct: marketContext.bullishPct ?? null,
    currentBearishPct: marketContext.bearishPct ?? null,
    currentSqueezePct: marketContext.squeezePct ?? null,
    currentFit,
    currentFitScore: score,
    currentFitConfidence: marketContext.confidence ?? 50,
    currentFitReason: 'LONG_FAST_FALLBACK_CURRENT_FIT',
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    entryCurrentFit: currentFit,
    entryCurrentFitConfidence: marketContext.confidence ?? 50,
    entryCurrentRegime: marketContext.regime || 'UNKNOWN',
    entryCurrentTrendSide: marketContext.trendSide || 'UNKNOWN',
    entryMarketWeather: marketContext.source || null
  };
}

function buildAnalyzedRow(candidate = {}, snapshot = {}, marketContext = {}, cfg = tradeConfig()) {
  const family = deriveExact75Family(candidate, marketContext);
  const risk = buildRisk(candidate, cfg);
  const normalized = normalizeSymbol(candidate);

  return {
    ...candidate,
    ...normalized,
    ...family,
    ...risk,
    ...sideFlags(),
    ...virtualFlags(),
    ...isolationFlags(),

    snapshotId: snapshot.snapshotId || candidate.snapshotId || null,
    scannerScore: safeNumber(candidate.scannerScore ?? candidate.moveScore ?? candidate.score, 0),
    moveScore: safeNumber(candidate.moveScore ?? candidate.scannerScore ?? candidate.score, 0),

    microFamilyId: family.trueMicroFamilyId,
    trueMicroFamilyId: family.trueMicroFamilyId,
    analyzeMicroFamilyId: family.trueMicroFamilyId,
    learningMicroFamilyId: family.trueMicroFamilyId,
    childTrueMicroFamilyId: family.trueMicroFamilyId,

    parentTrueMicroFamilyId: family.parentTrueMicroFamilyId,
    coarseMicroFamilyId: family.parentTrueMicroFamilyId,
    baseMicroFamilyId: family.parentTrueMicroFamilyId,
    legacyMicroFamilyId: family.parentTrueMicroFamilyId,
    parentMicroFamilyId: family.parentTrueMicroFamilyId,
    parentMacroFamilyId: family.parentTrueMicroFamilyId,
    macroFamilyId: family.parentTrueMicroFamilyId,
    familyId: family.trueMicroFamilyId,

    exact75ChildTrueMicro: true,
    fixedTaxonomyLearningId: true,
    fallbackExact75: family.source !== 'EXISTING_EXACT_75_TRUE_MICRO',
    fallbackExact75Source: family.source,

    observationOnly: false,
    analysisInputOnly: false,
    learningOnly: true,

    validLongRiskShape: risk.ok,
    liveRiskValid: risk.ok,

    analyzedBy: 'TRADE_FAST_FALLBACK_EXACT_75_NO_FULL_ANALYZE_WRITE',
    analyzeWriteSkipped: true,
    analyzeMicroStoreWriteSkipped: true,
    reason: risk.reason
  };
}

function validateVirtualEntry(row = {}) {
  if (inferRowTradeSide(row) !== TARGET_TRADE_SIDE) {
    return {
      ok: false,
      reason: 'SHORT_DISABLED_LONG_ONLY_SYSTEM'
    };
  }

  if (!isSelectableTrueMicroId(row.trueMicroFamilyId)) {
    return {
      ok: false,
      reason: 'ENTRY_REQUIRES_EXACT_75_CHILD_TRUE_MICRO_FAMILY'
    };
  }

  const entry = safeNumber(row.entry, 0);
  const sl = safeNumber(row.sl, 0);
  const tp = safeNumber(row.tp, 0);
  const rr = safeNumber(row.rr, 0);

  if (entry <= 0 || sl <= 0 || tp <= 0 || rr <= 0 || !(sl < entry && entry < tp)) {
    return {
      ok: false,
      reason: 'LONG_RISK_INVALID_SL_LT_ENTRY_LT_TP_REQUIRED'
    };
  }

  return {
    ok: true,
    reason: row.reason || 'LONG_VIRTUAL_LEARNING_STANDARDIZED_TP_SL'
  };
}

function waitAction(row = {}, reason, extra = {}) {
  return {
    ...row,
    action: 'WAIT',
    reason,
    virtualTracked: false,
    liveEligible: false,
    discordAlertEligible: false,
    ...sideFlags(),
    ...virtualFlags(),
    ...isolationFlags(),
    ...extra
  };
}

function buildVirtualEntryAction({
  row,
  alertContext,
  riskFraction,
  virtualGate,
  selectedExactMicroMatch,
  discordAlertEligible
}) {
  const gate = currentFitGate(row);
  const finalDiscordAlertEligible = Boolean(discordAlertEligible && gate.ok);

  return {
    ...row,
    ...sideFlags(),
    ...virtualFlags(),
    ...isolationFlags(),

    action: 'VIRTUAL_ENTRY',
    reason: virtualGate.reason || 'LONG_VIRTUAL_LEARNING_STANDARDIZED_TP_SL',

    selectedRotationId: alertContext.selectedRotationId || alertContext.rotationId,
    activeRotationId: alertContext.activeRotationId || alertContext.rotationId,

    discordSelectionSource: alertContext.discordSelectionSource || null,
    discordSelectionCacheHit: Boolean(alertContext.discordSelectionCacheHit),
    discordSelectionCacheKey: alertContext.discordSelectionCacheKey || null,

    selectedMicroFamilyAlert: Boolean(finalDiscordAlertEligible),
    selectedExactMicroMatch: Boolean(selectedExactMicroMatch),
    discordAlertEligible: Boolean(finalDiscordAlertEligible),
    discordCurrentFitGate: gate,
    discordAlertReason: finalDiscordAlertEligible
      ? 'SELECTED_LONG_TRUE_MICRO_FAMILY_EXACT_75_CHILD_MATCH_AND_CURRENT_FIT_OK'
      : !selectedExactMicroMatch
        ? alertContext.empty
          ? 'NO_MANUAL_75_CHILD_TRUE_MICRO_FAMILY_SELECTED'
          : 'TRUE_MICRO_FAMILY_NOT_SELECTED_FOR_DISCORD_ALERT'
        : gate.reason,

    selectedParentTrueMicroFamilyId: row.parentTrueMicroFamilyId,
    activeParentTrueMicroFamilyId: row.parentTrueMicroFamilyId,

    riskFraction,
    virtualGate,

    liveEligible: Boolean(finalDiscordAlertEligible),

    outcomeIdentityLocked: true,
    outcomeIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',

    positionTimeStopMin: tradeConfig().positionTimeStopMin,
    entryCreatedAt: now()
  };
}

function maybeSendDiscordEntryAlert(entry = {}) {
  if (!entry.discordAlertEligible) {
    return {
      sent: false,
      skipped: true,
      queued: false,
      reason: entry.discordAlertReason || 'TRUE_MICRO_FAMILY_NOT_SELECTED_OR_CURRENT_FIT_BLOCKED'
    };
  }

  Promise.resolve(sendEntryAlert(entry)).catch(() => null);

  return {
    sent: false,
    skipped: false,
    queued: true,
    fireAndForget: true,
    reason: 'DISCORD_ENTRY_ALERT_QUEUED_FIRE_AND_FORGET'
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
    const key = row?.reason || 'UNKNOWN_REASON';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function topReasonCounts(actions = [], limit = 12) {
  return Object.entries(reasonCounts(actions))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([reason, count]) => ({ reason, count }));
}

function pct(part, total) {
  const p = safeNumber(part, 0);
  const t = safeNumber(total, 0);

  if (t <= 0) return 0;

  return Number(((p / t) * 100).toFixed(2));
}

function runtimeExceeded(startedAt, cfg, reserveMs = 0) {
  return now() - startedAt >= cfg.maxRuntimeMs - reserveMs;
}

async function scopedSetJson(redis, key, value, options = {}) {
  try {
    assertKeyAllowedForWriteScope(KEYS.scopes?.TRADE_RUN || 'TRADE_RUN', key);
  } catch (error) {
    if (!String(key || '').startsWith(LONG_KEY_PREFIX)) throw error;
  }

  return setJson(redis, key, value, options);
}

function compactAction(row = {}) {
  return {
    action: row.action || null,
    reason: row.reason || null,
    symbol: row.symbol || row.baseSymbol || null,
    contractSymbol: row.contractSymbol || null,
    trueMicroFamilyId: row.trueMicroFamilyId || null,
    parentTrueMicroFamilyId: row.parentTrueMicroFamilyId || null,
    entry: row.entry ?? null,
    sl: row.sl ?? null,
    tp: row.tp ?? null,
    rr: row.rr ?? null,
    currentFit: row.currentFit || row.entryCurrentFit || null,
    discordAlertEligible: Boolean(row.discordAlertEligible)
  };
}

function buildQualityAudit({
  candidates,
  processed,
  analyzedRows,
  actions,
  virtualExits,
  counts,
  openPositionCountBeforeEntries,
  openPositionCountAfterEntries
}) {
  const candidateCount = candidates.length;
  const processedCount = processed.length;
  const analyzedRowsCount = analyzedRows.length;

  const primaryBottleneck =
    candidateCount <= 0
      ? 'NO_LONG_CANDIDATES'
      : counts.virtualCreatedRows <= 0
        ? 'VIRTUAL_ENTRY_GATE_OR_SYMBOL_ALREADY_OPEN'
        : virtualExits.length <= 0 && openPositionCountAfterEntries > 0
          ? 'POSITIONS_OPEN_WAITING_FOR_TP_SL_OR_TIME_STOP'
          : 'HEALTHY_LONG_FAST_FALLBACK_LEARNING_PIPELINE';

  return {
    profile: 'LONG_MICRO_FAMILY_TP_SL_LEARNING_V1',
    primaryBottleneck,
    pipelineCounts: {
      candidates: candidateCount,
      processed: processedCount,
      liveRows: processedCount,
      riskValidRows: counts.riskValidRows,
      analyzedRowsRaw: analyzedRowsCount,
      analyzedRows: analyzedRowsCount,
      analyzedRiskValidRows: counts.analyzedRiskValidRows,
      analyzedExact75Rows: counts.analyzedExact75Rows,
      fallbackExact75Rows: counts.fallbackExact75Rows,
      entryRows: counts.entryRows,
      virtualCreatedRows: counts.virtualCreatedRows,
      virtualExitRows: virtualExits.length,
      waitRows: counts.waitRows,
      skippedByExistingSymbol: counts.skippedByExistingSymbol,
      selectedAlertMicroMatches: counts.selectedAlertMicroMatches,
      discordCurrentFitBlockedRows: counts.discordCurrentFitBlockedRows,
      openPositionCountBeforeEntries,
      openPositionCountAfterEntries
    },
    conversionRatesPct: {
      processedPerCandidate: pct(processedCount, candidateCount),
      analyzedPerCandidate: pct(analyzedRowsCount, candidateCount),
      analyzedExact75PerAnalyzed: pct(counts.analyzedExact75Rows, analyzedRowsCount),
      virtualCreatedPerExact75: pct(counts.virtualCreatedRows, counts.analyzedExact75Rows),
      virtualExitPerCreatedThisRun: pct(virtualExits.length, counts.virtualCreatedRows)
    },
    topWaitReasons: topReasonCounts(actions, 12)
  };
}

function compactRunForRedis(result = {}) {
  const actions = Array.isArray(result.actions) ? result.actions : [];

  return {
    ok: result.ok !== false,
    skipped: Boolean(result.skipped || result.skippedNewEntries),
    skippedNewEntries: Boolean(result.skippedNewEntries),
    reason: result.reason || result.skipReason || null,
    skipReason: result.skipReason || result.reason || null,

    runId: result.runId || null,
    runPhase: 'TRADE_MAIN',
    startedAt: result.startedAt || null,
    completedAt: result.completedAt || null,
    durationMs: result.durationMs || null,

    snapshotId: result.snapshotId || null,
    snapshotCreatedAt: result.snapshotCreatedAt || null,
    snapshotAgeSec: result.snapshotAgeSec ?? null,
    forceProcessSnapshot: Boolean(result.forceProcessSnapshot),

    selectedSnapshotSource: result.selectedSnapshotSource || null,
    selectedSnapshotReason: result.selectedSnapshotReason || null,
    selectedTargetCandidateCount: safeNumber(result.selectedTargetCandidateCount, 0),
    selectedLongCandidateCount: safeNumber(result.selectedLongCandidateCount, 0),
    selectedOppositeCandidateCount: safeNumber(result.selectedOppositeCandidateCount, 0),
    selectedShortCandidateCount: safeNumber(result.selectedShortCandidateCount, 0),

    candidates: safeNumber(result.candidates, 0),
    allLongCandidatesBeforeCap: safeNumber(result.allLongCandidatesBeforeCap, 0),
    cappedCandidateCount: safeNumber(result.cappedCandidateCount, 0),
    longCandidateCount: safeNumber(result.longCandidateCount, 0),
    shortCandidateCount: 0,
    processed: safeNumber(result.processed, 0),

    liveRows: safeNumber(result.liveRows, 0),
    analyzeInputRows: safeNumber(result.analyzeInputRows, 0),
    actualLiveRows: safeNumber(result.actualLiveRows, 0),
    riskValidRows: safeNumber(result.riskValidRows, 0),

    analyzedRows: safeNumber(result.analyzedRows, 0),
    analyzedRowsRaw: safeNumber(result.analyzedRowsRaw, 0),
    analyzedActualRows: safeNumber(result.analyzedActualRows, 0),
    analyzedRiskValidRows: safeNumber(result.analyzedRiskValidRows, 0),
    analyzedExact75Rows: safeNumber(result.analyzedExact75Rows, 0),
    fallbackExact75Rows: safeNumber(result.fallbackExact75Rows, 0),

    entryRows: safeNumber(result.entryRows, 0),
    waitRows: safeNumber(result.waitRows, 0),
    virtualCreatedRows: safeNumber(result.virtualCreatedRows, 0),
    virtualSkippedRows: safeNumber(result.virtualSkippedRows, 0),
    virtualFailedRows: safeNumber(result.virtualFailedRows, 0),
    skippedByExistingSymbol: safeNumber(result.skippedByExistingSymbol, 0),

    shadowCreatedRows: safeNumber(result.shadowCreatedRows || result.virtualCreatedRows, 0),
    shadowSkippedRows: safeNumber(result.shadowSkippedRows || result.virtualSkippedRows, 0),
    shadowFailedRows: safeNumber(result.shadowFailedRows || result.virtualFailedRows, 0),

    virtualExitRows: safeNumber(result.virtualExitRows, 0),
    shadowExitRows: safeNumber(result.shadowExitRows, 0),
    realExitRows: 0,

    discordAlertEligibleRows: safeNumber(result.discordAlertEligibleRows, 0),
    discordAlertsQueued: safeNumber(result.discordAlertsQueued, 0),
    discordAlertsSent: 0,
    discordAlertsSkippedNoSelectedMicro: safeNumber(result.discordAlertsSkippedNoSelectedMicro, 0),
    discordAlertsSkippedCurrentFit: safeNumber(result.discordAlertsSkippedCurrentFit, 0),
    selectedMicroMatchRows: safeNumber(result.selectedMicroMatchRows, 0),
    selectedAlertMicroMatches: safeNumber(result.selectedAlertMicroMatches, 0),

    openPositionCountBeforeEntries: safeNumber(result.openPositionCountBeforeEntries, 0),
    openPositionCountAfterEntries: safeNumber(result.openPositionCountAfterEntries, 0),

    actionCounts: result.actionCounts || actionCounts(actions),
    rawActionCounts: result.rawActionCounts || actionCounts(actions),

    activeRotationId: result.activeRotationId || null,
    selectedRotationId: result.selectedRotationId || result.activeRotationId || null,

    activeMicroFamilyIds: Array.isArray(result.activeMicroFamilyIds) ? result.activeMicroFamilyIds : [],
    selectedMicroFamilyIds: Array.isArray(result.selectedMicroFamilyIds) ? result.selectedMicroFamilyIds : [],
    activeTrueMicroFamilyIds: Array.isArray(result.activeTrueMicroFamilyIds) ? result.activeTrueMicroFamilyIds : [],
    selectedTrueMicroFamilyIds: Array.isArray(result.selectedTrueMicroFamilyIds) ? result.selectedTrueMicroFamilyIds : [],

    activeMicroFamilies: safeNumber(result.activeMicroFamilies, 0),
    selectedMicroFamilies: safeNumber(result.selectedMicroFamilies, 0),

    discordSelectionSource: result.discordSelectionSource || null,
    discordSelectionCacheHit: Boolean(result.discordSelectionCacheHit),
    discordSelectionCacheKey: result.discordSelectionCacheKey || null,

    marketContext: result.marketContext || null,
    currentMarketWeather: result.currentMarketWeather || null,
    qualityAudit: result.qualityAudit || null,
    runtimeWarnings: Array.isArray(result.runtimeWarnings) ? result.runtimeWarnings : [],

    monitorOpenPositions: true,
    monitorOpenPositionsFirst: true,
    processScannerSnapshot: result.processScannerSnapshot !== false,

    monitorTimeoutMs: result.monitorTimeoutMs ?? null,
    maxRuntimeMs: result.maxRuntimeMs ?? null,

    scannerSnapshotStats: result.scannerSnapshotStats || null,

    entryRowsList: actions.filter((row) => row.action === 'VIRTUAL_ENTRY').slice(0, 25).map(compactAction),
    waitRowsList: actions.filter((row) => row.action === 'WAIT').slice(0, 25).map(compactAction),
    virtualCreatedRowsList: actions.filter((row) => row.action === 'VIRTUAL_ENTRY').slice(0, 25).map(compactAction),

    virtualExits: [],
    shadowExits: [],
    exits: [],
    realExits: [],
    actions: [],
    virtualActions: [],

    ...sideFlags(),
    ...virtualFlags(),
    ...isolationFlags(),

    compactedForRedis: true,
    compactedAt: now()
  };
}

async function saveRunMeta(result = {}) {
  const durableRedis = getDurableRedis();
  const completedAt = now();

  const finalResult = {
    ok: result.ok !== false,
    ...result,
    completedAt,
    durationMs: completedAt - safeNumber(result.startedAt, completedAt),
    ...sideFlags(),
    ...virtualFlags(),
    ...isolationFlags()
  };

  const compact = compactRunForRedis(finalResult);

  await scopedSetJson(durableRedis, LONG_KEYS.trade.runMeta, compact).catch(() => null);

  return finalResult;
}

async function loadOpenPositionsFast(cfg, runtimeWarnings) {
  const result = await withTimeout(
    getOpenPositions({
      tradeSide: TARGET_TRADE_SIDE,
      side: TARGET_DASHBOARD_SIDE,
      namespace: LONG_NAMESPACE,
      keyPrefix: LONG_KEY_PREFIX,
      virtualOnly: true
    }),
    cfg.openPositionLoadTimeoutMs,
    'OPEN_POSITION_LOAD_TIMEOUT'
  );

  if (result === 'OPEN_POSITION_LOAD_TIMEOUT') {
    runtimeWarnings.push('GET_OPEN_POSITIONS_TIMEOUT_USING_EMPTY_SET_FOR_ENTRY_BUDGET');
    return [];
  }

  if (!Array.isArray(result)) return [];

  return result;
}

async function loadRotationFast(cfg, runtimeWarnings) {
  const cachedSelection = await loadDiscordSelectionCacheFast(cfg, runtimeWarnings).catch(() => null);

  if (cachedSelection?.ok) {
    runtimeWarnings.push(`DISCORD_SELECTION_CACHE_HIT:${cachedSelection.discordSelectionCacheKey || cachedSelection.source}`);
    return cachedSelection;
  }

  const result = await withTimeout(
    getActiveRotation({
      weekKey: PERSISTENT_LEARNING_KEY,
      persistentLearningKey: PERSISTENT_LEARNING_KEY,
      targetTradeSide: TARGET_TRADE_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      side: TARGET_DASHBOARD_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      namespace: LONG_NAMESPACE,
      keyPrefix: LONG_KEY_PREFIX,
      redisNamespace: LONG_NAMESPACE,
      redisKeyPrefix: LONG_KEY_PREFIX,
      longOnly: true,
      shortDisabled: true,
      exactTrueMicroOnly: true,
      selectionGranularity: 'EXACT_75_CHILD',
      trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
      childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
      parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA
    }).catch(() => null),
    cfg.rotationTimeoutMs,
    'ROTATION_TIMEOUT'
  );

  if (result === 'ROTATION_TIMEOUT') {
    runtimeWarnings.push('ROTATION_LOAD_TIMEOUT_DISCORD_SELECTION_EMPTY');
    return null;
  }

  const selectedTrueMicroFamilyIds = normalizeSelectedMicroIds(result || {});

  if (selectedTrueMicroFamilyIds.length <= 0) {
    runtimeWarnings.push('ROTATION_LOAD_EMPTY_DISCORD_SELECTION');
    return null;
  }

  return {
    ...(result || {}),
    ok: true,
    source: 'getActiveRotation:fallback',
    discordSelectionSource: 'getActiveRotation:fallback',
    discordSelectionCacheHit: false,
    selectedTrueMicroFamilyIds,
    activeTrueMicroFamilyIds: selectedTrueMicroFamilyIds,
    selectedMicroFamilyIds: selectedTrueMicroFamilyIds,
    activeMicroFamilyIds: selectedTrueMicroFamilyIds,
    trueMicroFamilyIds: selectedTrueMicroFamilyIds,
    childTrueMicroFamilyIds: selectedTrueMicroFamilyIds,
    microFamilyIds: selectedTrueMicroFamilyIds
  };
}

async function monitorPositionsFast({
  cfg,
  snapshot,
  runtimeWarnings
}) {
  const priceHints = buildPriceHintMap(snapshot);

  const priceFetcher = async (symbol) => {
    const key = String(symbol || '').trim().toUpperCase();
    const base = normalizeBaseSymbol(key);
    const contract = normalizeContractSymbol(key);

    return safeNumber(
      priceHints.get(key) ??
        priceHints.get(base) ??
        priceHints.get(contract),
      0
    );
  };

  const result = await withTimeout(
    monitorOpenPositions({
      priceFetcher,
      tradeSide: TARGET_TRADE_SIDE,
      side: TARGET_DASHBOARD_SIDE,
      namespace: LONG_NAMESPACE,
      keyPrefix: LONG_KEY_PREFIX,
      weekKey: PERSISTENT_LEARNING_KEY,
      persistentLearningKey: PERSISTENT_LEARNING_KEY,
      virtualOnly: true,
      realOrdersDisabled: true,
      bitgetOrdersDisabled: true,
      exchangeCallsDisabled: true
    }),
    cfg.monitorTimeoutMs,
    'MONITOR_TIMEOUT'
  );

  if (result === 'MONITOR_TIMEOUT') {
    runtimeWarnings.push('MONITOR_OPEN_POSITIONS_TIMEOUT_CONTINUING_TO_ENTRY_LOOP');
    return [];
  }

  if (!Array.isArray(result)) return [];

  return result;
}

async function saveLastProcessedSnapshot({
  snapshot,
  result
}) {
  const durableRedis = getDurableRedis();

  if (!snapshot?.snapshotId) return;

  await scopedSetJson(
    durableRedis,
    LONG_KEYS.trade.lastProcessedSnapshot,
    {
      snapshotId: snapshot.snapshotId,
      runId: result.runId || null,
      processedAt: now(),
      forceProcessSnapshot: Boolean(result.forceProcessSnapshot),
      selectedSnapshotSource: snapshot.selectedSnapshotSource || null,
      selectedSnapshotReason: snapshot.selectedSnapshotReason || null,
      selectedTargetCandidateCount: snapshot.selectedTargetCandidateCount || 0,
      selectedLongCandidateCount: snapshot.selectedLongCandidateCount || 0,
      selectedOppositeCandidateCount: snapshot.selectedOppositeCandidateCount || 0,
      entryRows: result.entryRows || 0,
      waitRows: result.waitRows || 0,
      virtualCreatedRows: result.virtualCreatedRows || 0,
      virtualExitRows: result.virtualExitRows || 0,
      openPositionCountBeforeEntries: result.openPositionCountBeforeEntries || 0,
      openPositionCountAfterEntries: result.openPositionCountAfterEntries || 0,
      ...sideFlags(),
      ...virtualFlags(),
      ...isolationFlags(),
      compactedForRedis: true
    }
  ).catch(() => null);
}

export async function runTradeSystem(options = {}) {
  const cfg = tradeConfig(options);
  const sizing = sizingConfig();

  const durableRedis = getDurableRedis();

  const runId = randomId('trade_run_long');
  const startedAt = now();
  const runtimeWarnings = [
    'ANALYZE_ENGINE_WRITE_DISABLED_DUE_LONG_MICROS_PAYLOAD_TOO_LARGE',
    'USING_FALLBACK_EXACT_75_ROWS_FROM_SCANNER_METADATA'
  ];

  const forceProcessSnapshot = Boolean(options.forceProcessSnapshot || options.force);
  const monitorOnly = Boolean(options.monitorOnly);

  const marketContext = await loadMarketContext().catch(() => extractMarketContext(null));
  const snapshot = await getLatestSnapshot();

  const virtualExits = snapshot
    ? await monitorPositionsFast({ cfg, snapshot, runtimeWarnings }).catch((error) => {
        runtimeWarnings.push(`MONITOR_OPEN_POSITIONS_ERROR_CONTINUING_TO_ENTRY_LOOP:${error?.message || String(error)}`);
        return [];
      })
    : [];

  const shadowExits = virtualExits;
  const realExits = [];

  if (monitorOnly) {
    return saveRunMeta({
      runId,
      startedAt,
      forceProcessSnapshot,
      monitorOnly,
      actions: [],
      virtualExits,
      shadowExits,
      realExits,
      entryRows: 0,
      waitRows: 0,
      virtualCreatedRows: 0,
      virtualExitRows: virtualExits.length,
      shadowExitRows: shadowExits.length,
      realExitRows: 0,
      skippedNewEntries: true,
      reason: 'MONITOR_ONLY',
      actionCounts: actionCounts([]),
      marketContext,
      currentMarketWeather: marketContext.source,
      runtimeWarnings,
      monitorTimeoutMs: cfg.monitorTimeoutMs,
      maxRuntimeMs: cfg.maxRuntimeMs,
      monitorOpenPositions: true,
      monitorOpenPositionsFirst: true,
      processScannerSnapshot: false
    });
  }

  if (!snapshot?.snapshotId) {
    return saveRunMeta({
      runId,
      startedAt,
      forceProcessSnapshot,
      actions: [],
      virtualExits,
      shadowExits,
      realExits,
      entryRows: 0,
      waitRows: 0,
      virtualCreatedRows: 0,
      virtualExitRows: virtualExits.length,
      shadowExitRows: shadowExits.length,
      realExitRows: 0,
      skippedNewEntries: true,
      reason: 'NO_LONG_SCANNER_SNAPSHOT',
      actionCounts: actionCounts([]),
      marketContext,
      currentMarketWeather: marketContext.source,
      runtimeWarnings,
      monitorTimeoutMs: cfg.monitorTimeoutMs,
      maxRuntimeMs: cfg.maxRuntimeMs,
      monitorOpenPositions: true,
      monitorOpenPositionsFirst: true,
      processScannerSnapshot: true
    });
  }

  const snapshotAgeSec = Math.round((now() - snapshotCreatedAt(snapshot)) / 1000);

  const lastProcessed = await getJson(
    durableRedis,
    LONG_KEYS.trade.lastProcessedSnapshot,
    null
  ).catch(() => null);

  const sameSnapshot = lastProcessed?.snapshotId === snapshot.snapshotId;

  if (sameSnapshot && !forceProcessSnapshot) {
    return saveRunMeta({
      runId,
      startedAt,
      forceProcessSnapshot,
      snapshotId: snapshot.snapshotId,
      snapshotCreatedAt: snapshot.createdAt,
      snapshotAgeSec,
      selectedSnapshotSource: snapshot.selectedSnapshotSource || null,
      selectedSnapshotReason: snapshot.selectedSnapshotReason || null,
      selectedTargetCandidateCount: snapshot.selectedTargetCandidateCount || 0,
      selectedLongCandidateCount: snapshot.selectedLongCandidateCount || 0,
      selectedOppositeCandidateCount: snapshot.selectedOppositeCandidateCount || 0,
      selectedShortCandidateCount: snapshot.selectedShortCandidateCount || 0,
      actions: [],
      virtualExits,
      shadowExits,
      realExits,
      entryRows: 0,
      waitRows: 0,
      virtualCreatedRows: 0,
      virtualExitRows: virtualExits.length,
      shadowExitRows: shadowExits.length,
      realExitRows: 0,
      skippedNewEntries: true,
      reason: 'SNAPSHOT_ALREADY_PROCESSED',
      actionCounts: actionCounts([]),
      marketContext,
      currentMarketWeather: marketContext.source,
      runtimeWarnings,
      monitorTimeoutMs: cfg.monitorTimeoutMs,
      maxRuntimeMs: cfg.maxRuntimeMs,
      monitorOpenPositions: true,
      monitorOpenPositionsFirst: true,
      processScannerSnapshot: false
    });
  }

  const openPositionsBefore = await loadOpenPositionsFast(cfg, runtimeWarnings);
  const openSymbolSet = buildOpenSymbolSet(openPositionsBefore);
  const openPositionCountBeforeEntries = openPositionsBefore.length;

  const alertContext = buildSelectedAlertContext(
    await loadRotationFast(cfg, runtimeWarnings)
  );

  const allLongCandidates = Array.isArray(snapshot.candidates)
    ? snapshot.candidates.filter((row) => inferRowTradeSide(row) === TARGET_TRADE_SIDE)
    : [];

  const orderedCandidates = [
    ...allLongCandidates.filter((row) => !hasOpenSymbol(openSymbolSet, row)),
    ...allLongCandidates.filter((row) => hasOpenSymbol(openSymbolSet, row))
  ];

  const candidates = orderedCandidates
    .slice(0, cfg.maxCandidatesPerSnapshot)
    .map((row) => attachCurrentFit(row, marketContext));

  const cappedCandidateCount = Math.max(0, allLongCandidates.length - candidates.length);

  if (cappedCandidateCount > 0) {
    runtimeWarnings.push(`LONG_CANDIDATES_CAPPED_FOR_ENTRY_BUDGET:${cappedCandidateCount}`);
  }

  const analyzedRows = candidates
    .map((row) => buildAnalyzedRow(row, snapshot, marketContext, cfg))
    .filter((row) => row.validLongRiskShape && isSelectableTrueMicroId(row.trueMicroFamilyId));

  const actions = [];

  let entryRows = 0;
  let waitRows = 0;
  let virtualCreatedRows = 0;
  let virtualSkippedRows = 0;
  let virtualFailedRows = 0;
  let skippedByExistingSymbol = 0;

  let discordAlertEligibleRows = 0;
  let discordAlertsQueued = 0;
  let discordAlertsSkippedNoSelectedMicro = 0;
  let discordAlertsSkippedCurrentFit = 0;
  let selectedMicroMatchRows = 0;
  let selectedAlertMicroMatches = 0;

  let entryLoopAttempts = 0;

  for (const row of analyzedRows) {
    entryLoopAttempts += 1;

    const minimumAttemptsStillRequired = entryLoopAttempts <= cfg.minEntryLoopAttempts;

    if (!minimumAttemptsStillRequired && runtimeExceeded(startedAt, cfg, cfg.entryLoopReserveMs)) {
      runtimeWarnings.push(`MAX_RUNTIME_REACHED_ENTRY_LOOP_STOPPED_AFTER_MIN_ATTEMPTS:${entryLoopAttempts - 1}`);
      break;
    }

    const virtualGate = validateVirtualEntry(row);

    if (!virtualGate.ok) {
      waitRows += 1;
      virtualSkippedRows += 1;
      actions.push(waitAction(row, virtualGate.reason, { virtualGate }));
      continue;
    }

    if (hasOpenSymbol(openSymbolSet, row)) {
      waitRows += 1;
      virtualSkippedRows += 1;
      skippedByExistingSymbol += 1;
      actions.push(waitAction(row, 'SYMBOL_ALREADY_OPEN_VIRTUAL_POSITION', {
        oneOpenPositionPerSymbol: true,
        globalMaxOpenPositionsBlockDisabled: true,
        virtualTracked: true
      }));
      continue;
    }

    const selectedExactMicroMatch = rowMatchesSelectedAlertMicro(alertContext, row);
    const fitGate = currentFitGate(row);
    const discordAlertEligible = selectedExactMicroMatch && fitGate.ok;

    if (selectedExactMicroMatch) {
      selectedMicroMatchRows += 1;
      selectedAlertMicroMatches += 1;
    } else {
      discordAlertsSkippedNoSelectedMicro += 1;
    }

    if (selectedExactMicroMatch && !fitGate.ok) {
      discordAlertsSkippedCurrentFit += 1;
    }

    if (discordAlertEligible) {
      discordAlertEligibleRows += 1;
    }

    const riskFraction = sizing.enabled
      ? riskFractionForEntry({
          weeklyStats: row,
          side: TARGET_DASHBOARD_SIDE,
          tradeSide: TARGET_TRADE_SIDE
        })
      : sizing.baseRiskPct;

    const entry = buildVirtualEntryAction({
      row,
      alertContext,
      riskFraction,
      virtualGate,
      selectedExactMicroMatch,
      discordAlertEligible
    });

    const saveResult = await withTimeout(
      Promise.resolve()
        .then(() => buildOpenPositionFromEntry(entry))
        .then((position) => saveOpenPosition({
          ...position,
          ...isolationFlags()
        })),
      cfg.savePositionTimeoutMs,
      'SAVE_OPEN_POSITION_TIMEOUT'
    );

    if (saveResult === 'SAVE_OPEN_POSITION_TIMEOUT') {
      waitRows += 1;
      virtualFailedRows += 1;
      actions.push(waitAction(row, 'SAVE_OPEN_POSITION_TIMEOUT'));
      continue;
    }

    if (!saveResult || typeof saveResult !== 'object') {
      waitRows += 1;
      virtualFailedRows += 1;
      actions.push(waitAction(row, 'VIRTUAL_POSITION_CREATE_FAILED'));
      continue;
    }

    for (const key of rowSymbolKeys(row)) openSymbolSet.add(key);

    entryRows += 1;
    virtualCreatedRows += 1;

    const discordResult = maybeSendDiscordEntryAlert(entry);
    if (discordResult.queued) discordAlertsQueued += 1;

    actions.push({
      ...entry,
      discordAlertResult: discordResult,
      discordAlertQueued: Boolean(discordResult.queued),
      discordAlertSent: false
    });
  }

  runtimeWarnings.push(`ENTRY_LOOP_COMPLETED_ATTEMPTS:${entryLoopAttempts}`);

  const openPositionCountAfterEntries = openPositionCountBeforeEntries + virtualCreatedRows;

  const counts = {
    riskValidRows: analyzedRows.length,
    analyzedRiskValidRows: analyzedRows.length,
    analyzedExact75Rows: analyzedRows.length,
    fallbackExact75Rows: analyzedRows.filter((row) => row.fallbackExact75).length,
    entryRows,
    virtualCreatedRows,
    waitRows,
    skippedByExistingSymbol,
    selectedAlertMicroMatches,
    discordCurrentFitBlockedRows: discordAlertsSkippedCurrentFit
  };

  const qualityAudit = buildQualityAudit({
    candidates,
    processed: candidates,
    analyzedRows,
    actions,
    virtualExits,
    counts,
    openPositionCountBeforeEntries,
    openPositionCountAfterEntries
  });

  const result = {
    ok: true,
    runId,
    startedAt,
    forceProcessSnapshot,

    snapshotId: snapshot.snapshotId,
    snapshotCreatedAt: snapshot.createdAt,
    snapshotAgeSec,

    selectedSnapshotSource: snapshot.selectedSnapshotSource || null,
    selectedSnapshotReason: snapshot.selectedSnapshotReason || null,
    selectedTargetCandidateCount: snapshot.selectedTargetCandidateCount || 0,
    selectedLongCandidateCount: snapshot.selectedLongCandidateCount || 0,
    selectedOppositeCandidateCount: snapshot.selectedOppositeCandidateCount || 0,
    selectedShortCandidateCount: snapshot.selectedShortCandidateCount || 0,

    candidates: candidates.length,
    allLongCandidatesBeforeCap: allLongCandidates.length,
    cappedCandidateCount,
    longCandidateCount: candidates.length,
    shortCandidateCount: 0,
    nonLongCandidateCount: snapshot.selectedOppositeCandidateCount || 0,

    processed: candidates.length,
    earlyActions: 0,

    liveRows: candidates.length,
    analyzeInputRows: candidates.length,
    actualLiveRows: candidates.length,
    observationOnlyRows: 0,
    learningOnlyRows: candidates.length,
    riskValidRows: analyzedRows.length,

    analyzedRows: analyzedRows.length,
    analyzedRowsRaw: analyzedRows.length,
    analyzedActualRows: analyzedRows.length,
    analyzedRiskValidRows: analyzedRows.length,
    analyzedExact75Rows: analyzedRows.length,
    fallbackExact75Rows: counts.fallbackExact75Rows,

    analyzeSkipped: true,
    analyzeWriteSkipped: true,
    analyzeMicroStoreWriteSkipped: true,
    analyzeSkipReason: 'LONG_ANALYZE_MICROS_KEY_TOO_LARGE_USING_EXACT_75_FALLBACK',

    entryRows,
    waitRows,
    virtualCreatedRows,
    virtualSkippedRows,
    virtualFailedRows,
    skippedByExistingSymbol,

    shadowCreatedRows: virtualCreatedRows,
    shadowSkippedRows: virtualSkippedRows,
    shadowFailedRows: virtualFailedRows,

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
    discordAlertsSkippedCurrentFit,
    selectedMicroMatchRows,
    selectedAlertMicroMatches,

    openPositionCountBeforeEntries,
    openPositionCountAfterEntries,

    actions,
    virtualActions: actions,
    actionCounts: actionCounts(actions),
    rawActionCounts: actionCounts(actions),

    qualityAudit,
    runtimeWarnings,

    marketContext,
    currentMarketWeather: marketContext.source,
    currentMarketUniverse: null,

    activeRotationId: alertContext.activeRotationId || alertContext.rotationId,
    selectedRotationId: alertContext.selectedRotationId || alertContext.rotationId,

    activeMicroFamilyIds: alertContext.activeMicroFamilyIds,
    selectedMicroFamilyIds: alertContext.selectedMicroFamilyIds,
    activeTrueMicroFamilyIds: alertContext.activeTrueMicroFamilyIds,
    selectedTrueMicroFamilyIds: alertContext.selectedTrueMicroFamilyIds,
    activeMacroFamilyIds: alertContext.selectedParentTrueMicroFamilyIds,
    selectedMacroFamilyIds: alertContext.selectedParentTrueMicroFamilyIds,

    activeMicroFamilies: alertContext.selectedMicroFamilyIds.length,
    selectedMicroFamilies: alertContext.selectedMicroFamilyIds.length,
    activeMacroFamilies: alertContext.selectedParentTrueMicroFamilyIds.length,
    selectedMacroFamilies: alertContext.selectedParentTrueMicroFamilyIds.length,

    discordSelectionSource: alertContext.discordSelectionSource,
    discordSelectionCacheHit: alertContext.discordSelectionCacheHit,
    discordSelectionCacheKey: alertContext.discordSelectionCacheKey,

    scannerSnapshotStats: {
      candidatesCount: snapshot.candidatesCount || allLongCandidates.length,
      scannerGateCandidatesCount: snapshot.scannerGateCandidatesCount || null,
      analyzeOnlyCandidatesCount: snapshot.analyzeOnlyCandidatesCount || null,
      filteredUniverse: snapshot.filteredUniverse || null,
      rawCount: snapshot.rawCount || null
    },

    monitorTimeoutMs: cfg.monitorTimeoutMs,
    maxRuntimeMs: cfg.maxRuntimeMs,

    monitorOpenPositions: true,
    monitorOpenPositionsFirst: true,
    processScannerSnapshot: true,
    skippedNewEntries: false,

    ...sideFlags(),
    ...virtualFlags(),
    ...isolationFlags()
  };

  await saveLastProcessedSnapshot({ snapshot, result });

  return saveRunMeta(result);
}