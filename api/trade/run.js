// ================= FILE: api/trade/run.js =================

import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import {
  getDurableRedis,
  getJson,
  setJson
} from '../../src/redis.js';
import { runTradeSystem } from '../../src/trade/tradeSystem.js';

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

const DEFAULT_LOCK_TTL_SEC = 70;
const DEFAULT_STALE_LOCK_AFTER_SEC = 45;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;
const MIN_COMPLETED_ACTIVE_LEARNING = 20;

const DEFAULT_MAX_CANDIDATES = 12;
const DEFAULT_HARD_MAX_CANDIDATES = 12;
const DEFAULT_DATA_CONCURRENCY = 2;
const DEFAULT_MONITOR_TIMEOUT_MS = 3500;
const DEFAULT_ANALYZE_TIMEOUT_MS = 4000;
const DEFAULT_MAX_RUNTIME_MS = 26000;
const DEFAULT_ENTRY_RESERVE_MS = 8000;
const DEFAULT_MIN_ENTRY_ATTEMPTS = 3;

const RUN_SCOPE = 'TRADE_FAST_STALE_SAFE_LOCK_MONITOR_FIRST';
const WRITE_SCOPE = 'TRADE_AND_ANALYZE_PARTIAL_ONLY';
const READ_SCOPE = 'READ_LONG_SCANNER_AND_MARKET_WEATHER';

const LONG_MARKET_UNIVERSE_KEY = `${LONG_KEY_PREFIX}MARKET:UNIVERSE:LATEST`;
const LONG_MARKET_WEATHER_KEY = `${LONG_KEY_PREFIX}MARKET:WEATHER:LATEST`;

const SNAPSHOT_ALREADY_PROCESSED = 'SNAPSHOT_ALREADY_PROCESSED';
const SNAPSHOT_ALREADY_PROCESSED_MONITOR_ONLY = 'SNAPSHOT_ALREADY_PROCESSED_MONITOR_ONLY';

function now() {
  return Date.now();
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampInt(value, fallback, min, max) {
  const n = Math.floor(safeNumber(value, fallback));
  return Math.max(min, Math.min(max, n));
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
  if (raw.startsWith('SHORT:')) return `${LONG_KEY_PREFIX}${raw.slice('SHORT:'.length)}`;

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
      'TRADE:RUN:META'
    ),

    lastProcessedSnapshot: namespacedLongKey(
      KEYS.long?.trade?.lastProcessedSnapshot ||
        KEYS.trade?.longLastProcessedSnapshot ||
        KEYS.trade?.lastProcessedSnapshot,
      'TRADE:LAST_PROCESSED_SNAPSHOT'
    )
  },

  market: {
    universeLatest: LONG_MARKET_UNIVERSE_KEY,
    weatherLatest: LONG_MARKET_WEATHER_KEY
  }
};

function isAllowedMethod(method) {
  return method === 'GET' || method === 'POST';
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

function getPositionTimeStopMin() {
  return clampInt(
    CONFIG.long?.trade?.positionTimeStopMin ??
      CONFIG.trade?.positionTimeStopMin,
    DEFAULT_POSITION_TIME_STOP_MIN,
    1,
    7 * 24 * 60
  );
}

function getLockTtlSec() {
  return clampInt(
    CONFIG.long?.trade?.lockTtlSec ??
      CONFIG.trade?.lockTtlSec,
    DEFAULT_LOCK_TTL_SEC,
    20,
    90
  );
}

function getStaleLockAfterSec() {
  return clampInt(
    CONFIG.long?.trade?.staleLockAfterSec ??
      CONFIG.trade?.staleLockAfterSec,
    DEFAULT_STALE_LOCK_AFTER_SEC,
    15,
    75
  );
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

function shouldForceUnlock(req, body = {}) {
  return (
    isTrue(firstValue(req.query?.forceUnlock, false)) ||
    isTrue(firstValue(req.query?.force_unlock, false)) ||
    isTrue(firstValue(req.query?.unlock, false)) ||
    isTrue(body.forceUnlock) ||
    isTrue(body.force_unlock) ||
    isTrue(body.unlock)
  );
}

function shouldUnlockOnly(req, body = {}) {
  return (
    isTrue(firstValue(req.query?.unlockOnly, false)) ||
    isTrue(firstValue(req.query?.unlock_only, false)) ||
    isTrue(body.unlockOnly) ||
    isTrue(body.unlock_only)
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
    isTrue(firstValue(req.query?.forceUnlock, false)) ||
    isTrue(firstValue(req.query?.force_unlock, false)) ||
    isTrue(body.manual) ||
    isTrue(body.force) ||
    isTrue(body.forced) ||
    isTrue(body.forceProcessSnapshot) ||
    isTrue(body.force_process_snapshot) ||
    isTrue(body.forceUnlock) ||
    isTrue(body.force_unlock)
  );

  return manual
    ? 'ADMIN_MANUAL_LONG_TRADE_RUN_FAST_STALE_SAFE_LOCK'
    : 'CRON_OR_API_LONG_TRADE_RUN_FAST_STALE_SAFE_LOCK';
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

    trueMicroFamilySchema: 'FIXED_TAXONOMY',
    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,

    fixedTaxonomyPreferred: true,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    symbolExcludedFromFamilyId: true,

    selectableMicroFamilyCount: 75,
    parentMicroFamilyCount: 15,
    selectionGranularity: 'EXACT_75_CHILD',

    positionTimeStopMinDefault: DEFAULT_POSITION_TIME_STOP_MIN,
    positionTimeStopMin: getPositionTimeStopMin(),

    longRiskShape: 'sl < entry < tp',
    riskTradeSide: TARGET_TRADE_SIDE,
    riskGeometryRule: 'LONG: sl < entry < tp',
    tpRule: 'price >= tp',
    slRule: 'price <= sl',
    tpHitRule: 'LONG: price >= tp',
    slHitRule: 'LONG: price <= sl',
    grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
    currentRFormula: '(currentPrice - entry) / (entry - initialSl)',

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    learningRemainsBroad: true,

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

    runScope: RUN_SCOPE,
    writeScope: WRITE_SCOPE,
    readScope: READ_SCOPE,

    adminPageIsolation: true,
    doesNotOverwriteOtherAdminPages: true,

    scannerPreloadOptional: true,
    scannerPreloadDefaultDisabled: true,
    scannerPreloadBeforeTrade: false,
    scannerPreloadRequiredForMarketWeather: false,

    readsScannerLatest: true,
    scannerLatestReadOnlyInsideTradeSystem: true,
    preserveScannerLatest: true,
    preserveScannerSnapshot: true,
    preserveScannerHistory: true,

    scannerRunAllowed: false,
    scannerRunBeforeTrade: false,
    scannerRunDisabledInsideTradeSystem: true,
    noInternalScannerRunInsideTradeSystem: true,

    writesScanner: false,
    writesScannerLatest: false,
    writesScannerSnapshot: false,
    writesScannerHistory: false,

    writesMarketUniverse: false,
    writesMarketWeather: false,
    writesMarketWeatherInput: false,

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
    noActivateCron: true,
    noFreezeCron: true,
    activateCronDisabled: true,
    freezeCronDisabled: true,

    ignoreGlobalMaxOpenPositions: true,
    noGlobalMaxOpenPositionsBlock: true,
    globalMaxOpenPositionsBlockDisabled: true,
    maxOneOpenPositionPerSymbol: true,
    oneOpenPositionPerSymbol: true,

    lockMode: 'STALE_SAFE_SHORT_TTL_FORCE_CLEAR_ON_MANUAL_FORCE',
    lockCannotBlockForever: true,
    staleLockAutoBreakEnabled: true,
    forceProcessSnapshotClearsLock: true,
    lockReleasedInFinally: true,
    withRedisLockRemoved: true,

    snapshotAlreadyProcessedDoesNotBlockMonitor: true,
    sameSnapshotRunsMonitorOnly: true,
    newEntriesBlockedWhenSnapshotAlreadyProcessed: true,

    compactRunMetaForRedis: true,
    compactLastProcessedSnapshot: true,
    largeMarketWeatherRowsOmitted: true,

    realTradesOnly: false,
    virtualLearningOnly: true,
    shadowDataMode: 'VIRTUAL_LEARNING_OUTCOMES_COUNTED',
    compactedForVercelRuntime: true
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
    generatedAt: value.generatedAt || null,
    createdAt: value.createdAt || null,
    completedAt: value.completedAt || null,
    updatedAt: value.updatedAt || null,
    currentRegime: value.currentRegime || value.regime || null,
    regime: value.regime || value.currentRegime || null,
    currentTrendSide: value.currentTrendSide || value.trendSide || null,
    trendSide: value.trendSide || value.currentTrendSide || null,
    currentFlow: value.currentFlow || null,
    currentVolatilityState: value.currentVolatilityState || null,
    confidence: value.confidence ?? null,
    bullishPct: value.bullishPct ?? null,
    bearishPct: value.bearishPct ?? null,
    neutralPct: value.neutralPct ?? null,
    squeezePct: value.squeezePct ?? null,
    count: value.count ?? value.universeCount ?? null,
    universeCount: value.universeCount ?? value.count ?? null,
    btcState: value.btcState || null,
    btcChange1h: value.btcChange1h ?? null,
    btcChange24h: value.btcChange24h ?? null,
    btcRegime: value.btcRegime || null,
    rowsOmittedForRedis: true,
    symbolsOmittedForRedis: true,
    compactedForRedis: true
  };
}

function compactMarketContext(value = null) {
  if (!value || typeof value !== 'object') return null;

  return {
    ok: value.ok ?? null,
    createdAt: value.createdAt || null,
    ageSec: value.ageSec ?? null,
    stale: Boolean(value.stale),
    regime: value.regime || null,
    trendSide: value.trendSide || null,
    bullishPct: value.bullishPct ?? null,
    bearishPct: value.bearishPct ?? null,
    squeezePct: value.squeezePct ?? null,
    confidence: value.confidence ?? null,
    key: LONG_MARKET_WEATHER_KEY,
    universeKey: LONG_MARKET_UNIVERSE_KEY,
    source: compactMarketWeather(value.source),
    universe: null,
    compactedForRedis: true
  };
}

function uniqueStrings(values = []) {
  return [...new Set(
    values
      .flat()
      .filter(Boolean)
      .map((value) => String(value))
  )];
}

function compactRunPayload(payload = {}, extra = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};

  return {
    ok: p.ok !== false,
    skipped: Boolean(p.skipped || p.skippedNewEntries),
    skippedNewEntries: Boolean(p.skippedNewEntries),
    reason: p.reason || p.skipReason || null,
    skipReason: p.skipReason || p.reason || null,

    runId: p.runId || null,
    runPhase: p.runPhase || 'TRADE_MAIN',
    startedAt: p.startedAt || null,
    completedAt: p.completedAt || null,
    durationMs: p.durationMs || null,

    snapshotId: p.snapshotId || null,
    snapshotCreatedAt: p.snapshotCreatedAt || null,
    snapshotAgeSec: p.snapshotAgeSec ?? null,
    forceProcessSnapshot: Boolean(p.forceProcessSnapshot),

    selectedSnapshotSource: p.selectedSnapshotSource || null,
    selectedSnapshotReason: p.selectedSnapshotReason || null,

    snapshotMode: p.snapshotMode || extra.snapshotMode || null,
    monitorOnly: Boolean(p.monitorOnly || extra.monitorOnly),
    entriesBlockedBecauseSnapshotAlreadyProcessed: Boolean(
      p.entriesBlockedBecauseSnapshotAlreadyProcessed ||
        extra.entriesBlockedBecauseSnapshotAlreadyProcessed
    ),

    selectedTargetCandidateCount: safeNumber(p.selectedTargetCandidateCount, 0),
    selectedLongCandidateCount: safeNumber(p.selectedLongCandidateCount || p.selectedTargetCandidateCount, 0),
    selectedOppositeCandidateCount: safeNumber(p.selectedOppositeCandidateCount, 0),
    selectedShortCandidateCount: safeNumber(p.selectedShortCandidateCount, 0),

    candidates: safeNumber(p.candidates || p.candidatesCount, 0),
    allLongCandidatesBeforeCap: safeNumber(p.allLongCandidatesBeforeCap, 0),
    cappedCandidateCount: safeNumber(p.cappedCandidateCount, 0),
    longCandidateCount: safeNumber(p.longCandidateCount || p.selectedLongCandidateCount, 0),
    shortCandidateCount: safeNumber(p.shortCandidateCount, 0),
    processed: safeNumber(p.processed, 0),

    earlyActions: safeNumber(p.earlyActions, 0),
    liveRows: safeNumber(p.liveRows, 0),
    analyzeInputRows: safeNumber(p.analyzeInputRows, 0),
    actualLiveRows: safeNumber(p.actualLiveRows, 0),
    observationOnlyRows: safeNumber(p.observationOnlyRows, 0),
    learningOnlyRows: safeNumber(p.learningOnlyRows, 0),
    riskValidRows: safeNumber(p.riskValidRows, 0),

    analyzedRows: safeNumber(p.analyzedRows, 0),
    analyzedRowsRaw: safeNumber(p.analyzedRowsRaw, 0),
    analyzedActualRows: safeNumber(p.analyzedActualRows, 0),
    analyzedRiskValidRows: safeNumber(p.analyzedRiskValidRows, 0),
    analyzedExact75Rows: safeNumber(p.analyzedExact75Rows, 0),
    fallbackExact75Rows: safeNumber(p.fallbackExact75Rows, 0),

    entryRows: safeNumber(p.entryRows, 0),
    waitRows: safeNumber(p.waitRows, 0),
    virtualCreatedRows: safeNumber(p.virtualCreatedRows, 0),
    virtualSkippedRows: safeNumber(p.virtualSkippedRows, 0),
    virtualFailedRows: safeNumber(p.virtualFailedRows, 0),
    skippedByExistingSymbol: safeNumber(p.skippedByExistingSymbol, 0),

    shadowCreatedRows: safeNumber(p.shadowCreatedRows || p.virtualCreatedRows, 0),
    shadowSkippedRows: safeNumber(p.shadowSkippedRows || p.virtualSkippedRows, 0),
    shadowFailedRows: safeNumber(p.shadowFailedRows || p.virtualFailedRows, 0),

    virtualExitRows: safeNumber(p.virtualExitRows, 0),
    shadowExitRows: safeNumber(p.shadowExitRows, 0),
    realExitRows: 0,

    discordAlertEligibleRows: safeNumber(p.discordAlertEligibleRows, 0),
    discordAlertsQueued: safeNumber(p.discordAlertsQueued, 0),
    discordAlertsSent: safeNumber(p.discordAlertsSent, 0),
    discordAlertsSkippedNoSelectedMicro: safeNumber(p.discordAlertsSkippedNoSelectedMicro, 0),
    discordAlertsSkippedCurrentFit: safeNumber(p.discordAlertsSkippedCurrentFit, 0),
    selectedMicroMatchRows: safeNumber(p.selectedMicroMatchRows, 0),
    selectedAlertMicroMatches: safeNumber(p.selectedAlertMicroMatches, 0),

    openPositionCountBeforeEntries: safeNumber(p.openPositionCountBeforeEntries, 0),
    openPositionCountAfterEntries: safeNumber(p.openPositionCountAfterEntries, 0),

    activeRotationId: p.activeRotationId || null,
    selectedRotationId: p.selectedRotationId || p.activeRotationId || null,

    activeMicroFamilyIds: Array.isArray(p.activeMicroFamilyIds) ? p.activeMicroFamilyIds.slice(0, 75) : [],
    selectedMicroFamilyIds: Array.isArray(p.selectedMicroFamilyIds) ? p.selectedMicroFamilyIds.slice(0, 75) : [],
    activeTrueMicroFamilyIds: Array.isArray(p.activeTrueMicroFamilyIds) ? p.activeTrueMicroFamilyIds.slice(0, 75) : [],
    selectedTrueMicroFamilyIds: Array.isArray(p.selectedTrueMicroFamilyIds) ? p.selectedTrueMicroFamilyIds.slice(0, 75) : [],

    marketContext: compactMarketContext(p.marketContext),
    currentMarketWeather: compactMarketWeather(p.currentMarketWeather),

    qualityAudit: p.qualityAudit && typeof p.qualityAudit === 'object'
      ? {
          profile: p.qualityAudit.profile || null,
          primaryBottleneck: p.qualityAudit.primaryBottleneck || null,
          pipelineCounts: p.qualityAudit.pipelineCounts || null,
          conversionRatesPct: p.qualityAudit.conversionRatesPct || null,
          topWaitReasons: Array.isArray(p.qualityAudit.topWaitReasons)
            ? p.qualityAudit.topWaitReasons.slice(0, 12)
            : []
        }
      : null,

    runtimeWarnings: Array.isArray(p.runtimeWarnings) ? p.runtimeWarnings.slice(0, 30) : [],
    monitorOpenPositions: p.monitorOpenPositions !== false,
    monitorOpenPositionsFirst: p.monitorOpenPositionsFirst !== false,
    processScannerSnapshot: p.processScannerSnapshot !== false,

    monitorTimeoutMs: safeNumber(p.monitorTimeoutMs, DEFAULT_MONITOR_TIMEOUT_MS),
    monitorPriceFetchTimeoutMs: safeNumber(p.monitorPriceFetchTimeoutMs, 400),
    maxRuntimeMs: safeNumber(p.maxRuntimeMs, DEFAULT_MAX_RUNTIME_MS),

    scannerSnapshotStats: p.scannerSnapshotStats || null,

    actions: [],
    virtualActions: [],
    entryRowsList: [],
    waitRowsList: [],
    virtualCreatedRowsList: [],
    virtualExits: [],
    shadowExits: [],
    exits: [],
    realExits: [],

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    ...baseFlags(),
    ...extra,

    compactedForRedis: true,
    compactedAt: now()
  };
}

function payloadTooLarge(error) {
  const text = String(error?.message || error || '').toLowerCase();

  return (
    text.includes('max request size exceeded') ||
    text.includes('request size') ||
    text.includes('too large') ||
    text.includes('10485760')
  );
}

async function safeSetJson(redis, key, value) {
  try {
    await setJson(redis, key, value);
    return {
      ok: true,
      key
    };
  } catch (error) {
    return {
      ok: false,
      key,
      error: error?.message || String(error),
      payloadTooLarge: payloadTooLarge(error)
    };
  }
}

async function persistLongRunMeta(redis, payload = {}, result = {}, options = {}) {
  const compact = compactRunPayload(payload, {
    persistedAt: now(),
    persistedBy: 'api/trade/run.js',
    persistedNamespace: LONG_NAMESPACE,
    rawResultOk: result?.ok !== false,
    longKeys: {
      namespace: LONG_NAMESPACE,
      prefix: LONG_KEY_PREFIX,
      tradeRunMeta: LONG_KEYS.trade.runMeta,
      tradeLastProcessedSnapshot: LONG_KEYS.trade.lastProcessedSnapshot,
      scannerLatest: LONG_KEYS.scan.latest,
      marketUniverseLatest: LONG_MARKET_UNIVERSE_KEY,
      longMarketUniverseLatest: LONG_MARKET_UNIVERSE_KEY,
      marketWeatherLatest: LONG_MARKET_WEATHER_KEY,
      longMarketWeatherLatest: LONG_MARKET_WEATHER_KEY
    }
  });

  const runMetaResult = await safeSetJson(redis, LONG_KEYS.trade.runMeta, compact);

  const skipLastProcessedSnapshotWrite = Boolean(
    options.skipLastProcessedSnapshotWrite ||
      compact.monitorOnly ||
      compact.entriesBlockedBecauseSnapshotAlreadyProcessed ||
      compact.reason === SNAPSHOT_ALREADY_PROCESSED_MONITOR_ONLY ||
      compact.skipReason === SNAPSHOT_ALREADY_PROCESSED_MONITOR_ONLY
  );

  let lastProcessedResult = {
    ok: false,
    skipped: true,
    reason: skipLastProcessedSnapshotWrite
      ? 'MONITOR_ONLY_DOES_NOT_UPDATE_LAST_PROCESSED_SNAPSHOT'
      : 'NO_SNAPSHOT_ID'
  };

  if (compact.snapshotId && !skipLastProcessedSnapshotWrite) {
    lastProcessedResult = await safeSetJson(
      redis,
      LONG_KEYS.trade.lastProcessedSnapshot,
      {
        snapshotId: compact.snapshotId,
        runId: compact.runId || null,
        processedAt: now(),
        forceProcessSnapshot: Boolean(compact.forceProcessSnapshot),
        selectedSnapshotSource: compact.selectedSnapshotSource || null,
        selectedSnapshotReason: compact.selectedSnapshotReason || null,
        selectedTargetCandidateCount: compact.selectedTargetCandidateCount,
        selectedLongCandidateCount: compact.selectedLongCandidateCount,
        entryRows: compact.entryRows,
        waitRows: compact.waitRows,
        virtualCreatedRows: compact.virtualCreatedRows,
        virtualExitRows: compact.virtualExitRows,
        shadowExitRows: compact.shadowExitRows,
        openPositionCountBeforeEntries: compact.openPositionCountBeforeEntries,
        openPositionCountAfterEntries: compact.openPositionCountAfterEntries,
        reason: compact.reason,
        skipped: compact.skipped,
        ...baseFlags(),
        compactedForRedis: true,
        compactedAt: now()
      }
    );
  }

  return {
    persistedLongRunMeta: runMetaResult.ok,
    persistedLongLastProcessedSnapshot: Boolean(
      compact.snapshotId &&
        !skipLastProcessedSnapshotWrite &&
        lastProcessedResult.ok
    ),
    skippedLongLastProcessedSnapshotWrite: skipLastProcessedSnapshotWrite,
    tradeRunMeta: LONG_KEYS.trade.runMeta,
    tradeLastProcessedSnapshot: LONG_KEYS.trade.lastProcessedSnapshot,
    runMetaResult,
    lastProcessedResult
  };
}

async function readRawRedis(redis, key) {
  try {
    if (typeof redis.get === 'function') return await redis.get(key);
  } catch {
    return null;
  }

  return null;
}

async function readLock(redis, key) {
  const json = await getJson(redis, key, null).catch(() => null);

  if (json && typeof json === 'object') return json;

  const raw = await readRawRedis(redis, key);

  if (!raw) return null;

  if (typeof raw === 'object') return raw;

  try {
    return JSON.parse(String(raw));
  } catch {
    return {
      raw: String(raw),
      createdAt: 0
    };
  }
}

async function getTtl(redis, key) {
  try {
    if (typeof redis.ttl === 'function') return await redis.ttl(key);
  } catch {
    return null;
  }

  return null;
}

async function delKey(redis, key) {
  try {
    if (typeof redis.del === 'function') return await redis.del(key);
  } catch {
    return 0;
  }

  return 0;
}

async function setNxEx(redis, key, value, ttlSec) {
  const serialized = JSON.stringify(value);

  try {
    const result = await redis.set(key, serialized, {
      nx: true,
      ex: ttlSec
    });

    return result === 'OK' || result === 'ok' || result === true || result === 1;
  } catch {
    try {
      const result = await redis.set(key, serialized, {
        NX: true,
        EX: ttlSec
      });

      return result === 'OK' || result === 'ok' || result === true || result === 1;
    } catch {
      return false;
    }
  }
}

function isStaleLock(lock = {}, staleAfterSec = DEFAULT_STALE_LOCK_AFTER_SEC) {
  const createdAt = safeNumber(lock.createdAt || lock.startedAt || lock.lockedAt, 0);

  if (createdAt <= 0) return true;

  return now() - createdAt > staleAfterSec * 1000;
}

async function acquireTradeLock({
  redis,
  lockKey,
  lockTtlSec,
  staleLockAfterSec,
  forceUnlock,
  forceProcessSnapshot,
  runId
}) {
  if (forceUnlock || forceProcessSnapshot) {
    await delKey(redis, lockKey);
  }

  const existing = await readLock(redis, lockKey);

  if (existing && isStaleLock(existing, staleLockAfterSec)) {
    await delKey(redis, lockKey);
  } else if (existing) {
    return {
      acquired: false,
      active: true,
      stale: false,
      existing,
      ttlSec: await getTtl(redis, lockKey)
    };
  }

  const token = `lock_${runId}_${Math.random().toString(16).slice(2)}`;
  const lockPayload = {
    token,
    runId,
    createdAt: now(),
    startedAt: now(),
    ttlSec: lockTtlSec,
    namespace: LONG_NAMESPACE,
    keyPrefix: LONG_KEY_PREFIX,
    reason: 'LONG_TRADE_RUN_ACTIVE'
  };

  const acquired = await setNxEx(redis, lockKey, lockPayload, lockTtlSec);

  if (!acquired) {
    return {
      acquired: false,
      active: true,
      stale: false,
      existing: await readLock(redis, lockKey),
      ttlSec: await getTtl(redis, lockKey)
    };
  }

  return {
    acquired: true,
    active: true,
    token,
    lockPayload,
    ttlSec: lockTtlSec
  };
}

async function releaseTradeLock({
  redis,
  lockKey,
  token
}) {
  const current = await readLock(redis, lockKey);

  if (!current) {
    return {
      released: false,
      reason: 'LOCK_ALREADY_GONE'
    };
  }

  if (current.token && token && current.token !== token) {
    return {
      released: false,
      reason: 'LOCK_TOKEN_MISMATCH'
    };
  }

  await delKey(redis, lockKey);

  return {
    released: true,
    reason: 'LOCK_RELEASED'
  };
}

function buildLockSkippedResponse({
  req,
  body = {},
  startedAt,
  lockKey,
  lockTtlSec,
  staleLockAfterSec,
  lockState = null
}) {
  const reason = 'TRADE_RUN_LOCK_ACTIVE';

  return {
    ok: true,
    tradeOk: true,
    skipped: true,
    skippedNewEntries: true,
    reason,
    skipReason: reason,
    message: 'Trade run overgeslagen: vorige LONG trade-run is nog actief.',

    ...baseFlags(),

    runSource: getRunSource(req, body),

    lock: {
      key: lockKey,
      ttlSec: lockTtlSec,
      staleLockAfterSec,
      active: true,
      reason,
      currentTtlSec: lockState?.ttlSec ?? null,
      existingRunId: lockState?.existing?.runId || null,
      existingCreatedAt: lockState?.existing?.createdAt || null
    },

    runId: null,
    snapshotId: null,

    entryRows: 0,
    waitRows: 0,
    virtualCreatedRows: 0,
    virtualExitRows: 0,
    shadowExitRows: 0,
    realExitRows: 0,

    actions: [],
    virtualActions: [],
    entryRowsList: [],
    waitRowsList: [],
    virtualCreatedRowsList: [],
    virtualExits: [],
    shadowExits: [],
    realExits: [],

    activeMicroFamilyIds: [],
    selectedMicroFamilyIds: [],
    activeTrueMicroFamilyIds: [],
    selectedTrueMicroFamilyIds: [],

    scannerPreload: {
      ok: true,
      skipped: true,
      reason: 'SCANNER_PRELOAD_DISABLED_FOR_FAST_TRADE_RUN',
      scannerPreloadBeforeTrade: false,
      scannerPreloadOptional: true,
      scannerPreloadDefaultDisabled: true
    },

    longKeys: {
      namespace: LONG_NAMESPACE,
      prefix: LONG_KEY_PREFIX,
      scannerLatest: LONG_KEYS.scan.latest,
      tradeLock: LONG_KEYS.trade.lock,
      tradeRunMeta: LONG_KEYS.trade.runMeta,
      tradeLastProcessedSnapshot: LONG_KEYS.trade.lastProcessedSnapshot,
      marketUniverseLatest: LONG_MARKET_UNIVERSE_KEY,
      longMarketUniverseLatest: LONG_MARKET_UNIVERSE_KEY,
      marketWeatherLatest: LONG_MARKET_WEATHER_KEY,
      longMarketWeatherLatest: LONG_MARKET_WEATHER_KEY
    },

    warnings: [
      'TRADE_RUN_SKIPPED_BECAUSE_LOCK_ACTIVE',
      'NO_ERROR_FOR_CRON',
      'USE_forceUnlock=true_OR_forceProcessSnapshot=true_TO_CLEAR_MANUALLY'
    ],

    durationMs: now() - startedAt,
    completedAt: now()
  };
}

function responsePayload(rawResult = {}) {
  if (!rawResult || typeof rawResult !== 'object') return {};
  if (rawResult.result?.result?.result) return rawResult.result.result.result;
  if (rawResult.result?.result) return rawResult.result.result;
  if (rawResult.result) return rawResult.result;

  return rawResult;
}

function resolveStatus(error) {
  if (Number.isFinite(error?.statusCode)) return error.statusCode;
  return 500;
}

function extractSnapshotMeta(value = {}) {
  const root = value && typeof value === 'object' ? value : {};
  const nested =
    root.snapshot ||
    root.latestSnapshot ||
    root.latest ||
    root.data ||
    root.result ||
    null;

  const source = nested && typeof nested === 'object'
    ? {
        ...root,
        ...nested
      }
    : root;

  const snapshotId =
    source.snapshotId ||
    source.id ||
    source.scanId ||
    source.runId ||
    source.snapshot?.snapshotId ||
    root.snapshotId ||
    root.id ||
    null;

  const createdAt =
    safeNumber(
      source.snapshotCreatedAt ||
        source.createdAt ||
        source.completedAt ||
        source.updatedAt ||
        root.snapshotCreatedAt ||
        root.createdAt,
      null
    );

  const candidates =
    Array.isArray(source.candidates)
      ? source.candidates.length
      : Array.isArray(source.rows)
        ? source.rows.length
        : safeNumber(
            source.candidatesCount ||
              source.candidateCount ||
              source.selectedTargetCandidateCount ||
              source.selectedLongCandidateCount ||
              root.candidatesCount ||
              root.candidateCount,
            0
          );

  return {
    snapshotId: snapshotId ? String(snapshotId) : null,
    snapshotCreatedAt: createdAt,
    candidateCount: candidates,
    selectedSnapshotSource: 'VOLATILE:LONG:SCAN:LATEST_FULL_SNAPSHOT',
    selectedSnapshotReason: 'LATEST_LONG_SCANNER_SNAPSHOT'
  };
}

async function readLatestScannerSnapshotMeta(redis) {
  const latest = await getJson(redis, LONG_KEYS.scan.latest, null).catch(() => null);

  if (!latest || typeof latest !== 'object') {
    return {
      available: false,
      snapshotId: null,
      snapshotCreatedAt: null,
      candidateCount: 0,
      selectedSnapshotSource: null,
      selectedSnapshotReason: 'LONG_SCANNER_LATEST_NOT_AVAILABLE'
    };
  }

  return {
    available: true,
    ...extractSnapshotMeta(latest)
  };
}

async function readLastProcessedSnapshotMeta(redis) {
  const latest = await getJson(redis, LONG_KEYS.trade.lastProcessedSnapshot, null).catch(() => null);

  if (!latest || typeof latest !== 'object') {
    return {
      available: false,
      snapshotId: null,
      processedAt: null
    };
  }

  return {
    available: true,
    snapshotId: latest.snapshotId ? String(latest.snapshotId) : null,
    processedAt: latest.processedAt || latest.updatedAt || null,
    runId: latest.runId || null
  };
}

async function resolveSnapshotMode({
  redis,
  forceProcessSnapshot,
  requestedMonitorOnly
}) {
  const latestSnapshot = await readLatestScannerSnapshotMeta(redis);
  const lastProcessedSnapshot = await readLastProcessedSnapshotMeta(redis);

  const sameSnapshotAlreadyProcessed = Boolean(
    !forceProcessSnapshot &&
      latestSnapshot.snapshotId &&
      lastProcessedSnapshot.snapshotId &&
      latestSnapshot.snapshotId === lastProcessedSnapshot.snapshotId
  );

  const monitorOnly = Boolean(requestedMonitorOnly || sameSnapshotAlreadyProcessed);
  const processScannerSnapshot = !monitorOnly;

  return {
    mode: sameSnapshotAlreadyProcessed
      ? SNAPSHOT_ALREADY_PROCESSED_MONITOR_ONLY
      : requestedMonitorOnly
        ? 'REQUESTED_MONITOR_ONLY'
        : 'PROCESS_SCANNER_SNAPSHOT',

    latestSnapshot,
    lastProcessedSnapshot,

    sameSnapshotAlreadyProcessed,
    entriesBlockedBecauseSnapshotAlreadyProcessed: sameSnapshotAlreadyProcessed,
    monitorOnly,
    requestedMonitorOnly,
    processScannerSnapshot,

    snapshotAlreadyProcessedDoesNotBlockMonitor: true,
    sameSnapshotRunsMonitorOnly: true,
    newEntriesBlockedWhenSnapshotAlreadyProcessed: true
  };
}

function buildRunOptions(req, body = {}, overrides = {}) {
  const forceProcessSnapshot = shouldForceProcessSnapshot(req, body);
  const requestedMonitorOnly = shouldMonitorOnly(req, body);
  const monitorOnly = Boolean(overrides.monitorOnly ?? requestedMonitorOnly);
  const processScannerSnapshot = Boolean(
    overrides.processScannerSnapshot ?? !monitorOnly
  );

  const maxCandidates = clampInt(
    firstValue(req.query?.maxCandidates, body.maxCandidates) ??
      CONFIG.long?.trade?.maxCandidatesPerSnapshot ??
      DEFAULT_MAX_CANDIDATES,
    DEFAULT_MAX_CANDIDATES,
    1,
    DEFAULT_HARD_MAX_CANDIDATES
  );

  return {
    force: forceProcessSnapshot,
    forceProcessSnapshot,
    monitorOnly,

    monitorOpenPositionsFirst: true,
    monitorOpenPositions: true,
    processOpenPositions: true,
    closeVirtualPositions: true,
    processScannerSnapshot,

    entriesBlockedBecauseSnapshotAlreadyProcessed: Boolean(
      overrides.entriesBlockedBecauseSnapshotAlreadyProcessed
    ),
    snapshotAlreadyProcessedDoesNotBlockMonitor: true,
    sameSnapshotRunsMonitorOnly: true,
    newEntriesBlockedWhenSnapshotAlreadyProcessed: true,
    snapshotMode: overrides.snapshotMode || null,

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
    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,

    fixedTaxonomyPreferred: true,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    parentLearningEnabled: true,
    childLearningEnabled: true,
    selectionGranularity: 'EXACT_75_CHILD',

    allowLearningWithoutActiveRotation: true,
    ignoreMaxOpenPositionsForLearning: true,
    ignoreGlobalMaxOpenPositions: true,
    ignoreRiskCapsForLearning: true,
    oneOpenPositionPerSymbol: true,
    maxOneOpenPositionPerSymbol: true,

    positionTimeStopMin: getPositionTimeStopMin(),

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
      tradeLastProcessedSnapshot: LONG_KEYS.trade.lastProcessedSnapshot,
      marketUniverseLatest: LONG_MARKET_UNIVERSE_KEY,
      longMarketUniverseLatest: LONG_MARKET_UNIVERSE_KEY,
      marketWeatherLatest: LONG_MARKET_WEATHER_KEY,
      longMarketWeatherLatest: LONG_MARKET_WEATHER_KEY
    },

    scannerPreloadBeforeTrade: false,
    marketWeatherPreloadBeforeTrade: false,
    scannerPreloadOptional: true,
    scannerPreloadDefaultDisabled: true,

    scannerRunAllowed: false,
    scannerRunBeforeTrade: false,
    scannerRunDisabledInsideTradeSystem: true,
    preventScannerRun: true,
    doNotRunScanner: true,
    noInternalScannerRun: true,

    scannerLatestReadOnly: true,
    readScannerLatestOnly: true,
    preserveScannerLatest: true,
    preserveScannerSnapshot: true,
    preserveScannerHistory: true,

    allowTradeWrite: true,
    allowAnalyzePartialWrite: true,
    allowScannerWrite: false,
    allowMarketWeatherWrite: false,
    allowMarketUniverseWrite: false,
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
    doesNotOverwriteOtherAdminPages: true,

    maxCandidates,
    maxCandidatesPerSnapshot: maxCandidates,
    hardMaxCandidatesPerSnapshot: DEFAULT_HARD_MAX_CANDIDATES,
    maxCandidatesHardCapForVercel: DEFAULT_HARD_MAX_CANDIDATES,

    dataConcurrency: DEFAULT_DATA_CONCURRENCY,
    monitorTimeoutMs: DEFAULT_MONITOR_TIMEOUT_MS,
    monitorPriceFetchTimeoutMs: 400,
    analyzeTimeoutMs: DEFAULT_ANALYZE_TIMEOUT_MS,
    maxRuntimeMs: DEFAULT_MAX_RUNTIME_MS,
    entryReserveMs: DEFAULT_ENTRY_RESERVE_MS,
    minEntryAttempts: DEFAULT_MIN_ENTRY_ATTEMPTS,

    monitorLivePriceFetchEnabled: false,
    monitorPriceSource: 'SCANNER_SNAPSHOT_HINTS_ONLY_NO_LIVE_FETCH',

    skipAnalyzeOnVercelFastPath: true,
    compactForVercelRuntime: true,
    compactRedisPayloads: true,
    compactRunMeta: true,
    compactLastProcessedSnapshot: true,
    persistCompactLastProcessedSnapshot: true,
    skipFullLastProcessedSnapshotPayload: true,

    omitLargeMarketWeatherRows: true,
    omitMarketContextRows: true,
    omitMarketUniverseRows: true,
    omitActionMarketContext: true,
    omitCurrentMarketWeatherRows: true
  };
}

function isSnapshotAlreadyProcessedPayload(payload = {}) {
  const reason = String(payload?.reason || payload?.skipReason || '').trim();

  return reason === SNAPSHOT_ALREADY_PROCESSED;
}

function normalizeSnapshotAlreadyProcessedMonitorPayload({
  monitorPayload = {},
  originalPayload = {},
  snapshotMode = {},
  fallbackMonitorUsed = false,
  startedAt
}) {
  const latestSnapshot = snapshotMode.latestSnapshot || {};
  const p = {
    ...originalPayload,
    ...monitorPayload
  };

  const snapshotId =
    p.snapshotId ||
    originalPayload.snapshotId ||
    latestSnapshot.snapshotId ||
    null;

  const snapshotCreatedAt =
    p.snapshotCreatedAt ||
    originalPayload.snapshotCreatedAt ||
    latestSnapshot.snapshotCreatedAt ||
    null;

  const selectedTargetCandidateCount = safeNumber(
    originalPayload.selectedTargetCandidateCount ||
      p.selectedTargetCandidateCount ||
      latestSnapshot.candidateCount,
    0
  );

  const warnings = uniqueStrings([
    originalPayload.runtimeWarnings || [],
    monitorPayload.runtimeWarnings || [],
    fallbackMonitorUsed
      ? ['TRADE_SYSTEM_RETURNED_SNAPSHOT_ALREADY_PROCESSED_FALLBACK_MONITOR_RAN']
      : ['SNAPSHOT_ALREADY_PROCESSED_ENTRIES_BLOCKED_MONITOR_STILL_RAN']
  ]).slice(0, 30);

  return {
    ...p,

    ok: p.ok !== false,
    skipped: true,
    skippedNewEntries: true,
    reason: SNAPSHOT_ALREADY_PROCESSED_MONITOR_ONLY,
    skipReason: SNAPSHOT_ALREADY_PROCESSED_MONITOR_ONLY,

    runPhase: fallbackMonitorUsed
      ? 'MONITOR_ONLY_AFTER_SNAPSHOT_ALREADY_PROCESSED'
      : p.runPhase || 'TRADE_MAIN_MONITOR_ONLY',

    snapshotId,
    snapshotCreatedAt,
    snapshotAgeSec: snapshotCreatedAt
      ? Math.max(0, Math.floor((now() - snapshotCreatedAt) / 1000))
      : p.snapshotAgeSec ?? originalPayload.snapshotAgeSec ?? null,

    selectedSnapshotSource:
      p.selectedSnapshotSource ||
      originalPayload.selectedSnapshotSource ||
      latestSnapshot.selectedSnapshotSource ||
      null,

    selectedSnapshotReason:
      p.selectedSnapshotReason ||
      originalPayload.selectedSnapshotReason ||
      latestSnapshot.selectedSnapshotReason ||
      null,

    selectedTargetCandidateCount,
    selectedLongCandidateCount: selectedTargetCandidateCount,
    selectedOppositeCandidateCount: 0,
    selectedShortCandidateCount: 0,

    candidates: 0,
    processed: 0,
    entryRows: 0,
    waitRows: 0,
    virtualCreatedRows: 0,
    virtualSkippedRows: 0,
    virtualFailedRows: 0,
    shadowCreatedRows: 0,
    shadowSkippedRows: 0,
    shadowFailedRows: 0,

    monitorOnly: true,
    processScannerSnapshot: false,
    entriesBlockedBecauseSnapshotAlreadyProcessed: true,

    snapshotAlreadyProcessedDoesNotBlockMonitor: true,
    sameSnapshotRunsMonitorOnly: true,
    newEntriesBlockedWhenSnapshotAlreadyProcessed: true,
    fallbackMonitorUsed,

    snapshotMode: {
      ...snapshotMode,
      mode: SNAPSHOT_ALREADY_PROCESSED_MONITOR_ONLY,
      monitorOnly: true,
      processScannerSnapshot: false,
      entriesBlockedBecauseSnapshotAlreadyProcessed: true
    },

    runtimeWarnings: warnings,

    startedAt: p.startedAt || originalPayload.startedAt || startedAt || now(),
    completedAt: p.completedAt || now(),
    durationMs: safeNumber(
      p.durationMs,
      (p.completedAt || now()) - (p.startedAt || originalPayload.startedAt || startedAt || now())
    )
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
  res.setHeader('X-Scanner-Write', 'false');
  res.setHeader('X-Scanner-Run-Allowed', 'false');
  res.setHeader('X-Scanner-Preload-Before-Trade', 'false');
  res.setHeader('X-MarketWeather-Preload-Before-Trade', 'false');
  res.setHeader('X-Learning-Identity-Source', 'ANALYZE_TRUE_MICRO_FAMILY');
  res.setHeader('X-Exact-True-Micro-Match', 'true');
  res.setHeader('X-True-Micro-Family-Schema', TRUE_MICRO_SCHEMA);
  res.setHeader('X-Run-Scope', RUN_SCOPE);
  res.setHeader('X-Write-Scope', WRITE_SCOPE);
  res.setHeader('X-Persistent-Learning-Key', PERSISTENT_LEARNING_KEY);
  res.setHeader('X-Redis-Namespace', LONG_NAMESPACE);
  res.setHeader('X-Short-Root-Touched', 'false');

  const startedAt = now();
  const runId = `api_long_trade_${startedAt}_${Math.random().toString(16).slice(2, 10)}`;

  let body = {};
  let lockState = null;

  const durableRedis = getDurableRedis();
  const lockKey = LONG_KEYS.trade.lock;
  const lockTtlSec = getLockTtlSec();
  const staleLockAfterSec = getStaleLockAfterSec();

  try {
    if (!isAllowedMethod(req.method)) {
      return methodNotAllowed(res);
    }

    body = await readBody(req);

    const forceProcessSnapshot = shouldForceProcessSnapshot(req, body);
    const forceUnlock = shouldForceUnlock(req, body) || forceProcessSnapshot;
    const unlockOnly = shouldUnlockOnly(req, body);

    if (unlockOnly) {
      const deleted = await delKey(durableRedis, lockKey);

      return res.status(200).json({
        ok: true,
        skipped: true,
        skippedNewEntries: true,
        reason: 'UNLOCK_ONLY',
        skipReason: 'UNLOCK_ONLY',
        deleted,
        lockKey,
        ...baseFlags(),
        durationMs: now() - startedAt,
        completedAt: now()
      });
    }

    lockState = await acquireTradeLock({
      redis: durableRedis,
      lockKey,
      lockTtlSec,
      staleLockAfterSec,
      forceUnlock,
      forceProcessSnapshot,
      runId
    });

    if (!lockState.acquired) {
      return res.status(200).json(buildLockSkippedResponse({
        req,
        body,
        startedAt,
        lockKey,
        lockTtlSec,
        staleLockAfterSec,
        lockState
      }));
    }

    const requestedMonitorOnly = shouldMonitorOnly(req, body);

    const snapshotMode = await resolveSnapshotMode({
      redis: durableRedis,
      forceProcessSnapshot,
      requestedMonitorOnly
    });

    let runOptions = buildRunOptions(req, body, {
      monitorOnly: snapshotMode.monitorOnly,
      processScannerSnapshot: snapshotMode.processScannerSnapshot,
      entriesBlockedBecauseSnapshotAlreadyProcessed:
        snapshotMode.entriesBlockedBecauseSnapshotAlreadyProcessed,
      snapshotMode
    });

    let rawResult = await runTradeSystem(runOptions);
    let payload = responsePayload(rawResult);
    let fallbackMonitorUsed = false;

    if (
      isSnapshotAlreadyProcessedPayload(payload) &&
      !forceProcessSnapshot
    ) {
      fallbackMonitorUsed = true;

      runOptions = {
        ...runOptions,
        force: false,
        forceProcessSnapshot: false,
        monitorOnly: true,
        processScannerSnapshot: false,
        entriesBlockedBecauseSnapshotAlreadyProcessed: true,
        snapshotMode: {
          ...snapshotMode,
          mode: SNAPSHOT_ALREADY_PROCESSED_MONITOR_ONLY,
          monitorOnly: true,
          processScannerSnapshot: false,
          entriesBlockedBecauseSnapshotAlreadyProcessed: true
        },
        runPhase: 'MONITOR_ONLY_AFTER_SNAPSHOT_ALREADY_PROCESSED'
      };

      const monitorRawResult = await runTradeSystem(runOptions);
      const monitorPayload = responsePayload(monitorRawResult);

      payload = normalizeSnapshotAlreadyProcessedMonitorPayload({
        monitorPayload,
        originalPayload: payload,
        snapshotMode,
        fallbackMonitorUsed,
        startedAt
      });

      rawResult = monitorRawResult;
    } else if (snapshotMode.sameSnapshotAlreadyProcessed) {
      payload = normalizeSnapshotAlreadyProcessedMonitorPayload({
        monitorPayload: payload,
        originalPayload: payload,
        snapshotMode,
        fallbackMonitorUsed: false,
        startedAt
      });
    } else {
      payload = {
        ...payload,
        snapshotMode,
        monitorOnly: runOptions.monitorOnly,
        processScannerSnapshot: runOptions.processScannerSnapshot,
        entriesBlockedBecauseSnapshotAlreadyProcessed:
          runOptions.entriesBlockedBecauseSnapshotAlreadyProcessed,
        snapshotAlreadyProcessedDoesNotBlockMonitor: true,
        sameSnapshotRunsMonitorOnly: true,
        newEntriesBlockedWhenSnapshotAlreadyProcessed: true
      };
    }

    const skipLastProcessedSnapshotWrite = Boolean(
      runOptions.monitorOnly ||
        payload.monitorOnly ||
        payload.entriesBlockedBecauseSnapshotAlreadyProcessed ||
        payload.reason === SNAPSHOT_ALREADY_PROCESSED_MONITOR_ONLY
    );

    const persistence = await persistLongRunMeta(
      durableRedis,
      payload,
      rawResult,
      {
        skipLastProcessedSnapshotWrite
      }
    );

    const compact = compactRunPayload(payload, {
      persistedAt: now(),
      persistedBy: 'api/trade/run.js',
      persistedNamespace: LONG_NAMESPACE,
      monitorOnly: Boolean(payload.monitorOnly || runOptions.monitorOnly),
      entriesBlockedBecauseSnapshotAlreadyProcessed: Boolean(
        payload.entriesBlockedBecauseSnapshotAlreadyProcessed ||
          runOptions.entriesBlockedBecauseSnapshotAlreadyProcessed
      ),
      snapshotMode
    });

    return res.status(200).json({
      ...compact,

      ok: rawResult?.ok !== false && payload?.ok !== false,
      tradeOk: rawResult?.ok !== false && payload?.ok !== false,

      runSource: getRunSource(req, body),

      force: runOptions.force,
      forceProcessSnapshot: runOptions.forceProcessSnapshot,
      forceUnlock,
      unlockOnly: false,
      monitorOnly: Boolean(payload.monitorOnly || runOptions.monitorOnly),

      snapshotMode,
      fallbackMonitorUsed,
      entriesBlockedBecauseSnapshotAlreadyProcessed: Boolean(
        payload.entriesBlockedBecauseSnapshotAlreadyProcessed ||
          runOptions.entriesBlockedBecauseSnapshotAlreadyProcessed
      ),
      snapshotAlreadyProcessedDoesNotBlockMonitor: true,
      sameSnapshotRunsMonitorOnly: true,
      newEntriesBlockedWhenSnapshotAlreadyProcessed: true,

      scannerPreload: {
        ok: true,
        skipped: true,
        reason: 'SCANNER_PRELOAD_DISABLED_FOR_FAST_TRADE_RUN',
        scannerPreloadBeforeTrade: false,
        scannerPreloadOptional: true,
        scannerPreloadDefaultDisabled: true
      },

      scannerPreloadOk: true,
      marketWeatherAvailableAfterRun: true,
      marketUniverseAvailableAfterRun: true,

      lock: {
        key: lockKey,
        ttlSec: lockTtlSec,
        staleLockAfterSec,
        acquired: true,
        releasedInFinally: true
      },

      monitorTimeoutMs: runOptions.monitorTimeoutMs,
      monitorPriceFetchTimeoutMs: runOptions.monitorPriceFetchTimeoutMs,
      analyzeTimeoutMs: runOptions.analyzeTimeoutMs,
      maxRuntimeMs: runOptions.maxRuntimeMs,
      maxCandidatesHardCapForVercel: runOptions.maxCandidatesHardCapForVercel,

      scannerLatestPreserved: true,
      scannerSnapshotPreserved: true,
      scannerHistoryPreserved: true,
      scannerRunBlockedInsideTradeRun: true,
      scannerRunDisabledInsideTradeSystem: true,

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
        tradeLastProcessedSnapshot: LONG_KEYS.trade.lastProcessedSnapshot,
        marketUniverseLatest: LONG_MARKET_UNIVERSE_KEY,
        longMarketUniverseLatest: LONG_MARKET_UNIVERSE_KEY,
        marketWeatherLatest: LONG_MARKET_WEATHER_KEY,
        longMarketWeatherLatest: LONG_MARKET_WEATHER_KEY
      },

      rawResultOk: rawResult?.ok !== false,
      durationMs: now() - startedAt,

      result: compact
    });
  } catch (error) {
    if (payloadTooLarge(error)) {
      const failurePayload = {
        ok: false,
        skipped: false,
        reason: 'TRADE_SYSTEM_PERSISTENCE_PAYLOAD_TOO_LARGE_LOCK_RELEASED',
        error: error?.message || String(error),
        runId,
        startedAt,
        completedAt: now(),
        durationMs: now() - startedAt,
        ...baseFlags()
      };

      await persistLongRunMeta(
        durableRedis,
        failurePayload,
        failurePayload,
        {
          skipLastProcessedSnapshotWrite: true
        }
      ).catch(() => null);

      return res.status(200).json({
        ...failurePayload,
        tradeOk: false,
        payloadTooLarge: true,
        lockReleasedInFinally: true,
        longKeys: {
          namespace: LONG_NAMESPACE,
          prefix: LONG_KEY_PREFIX,
          tradeLock: LONG_KEYS.trade.lock,
          tradeRunMeta: LONG_KEYS.trade.runMeta,
          tradeLastProcessedSnapshot: LONG_KEYS.trade.lastProcessedSnapshot
        }
      });
    }

    return res.status(resolveStatus(error)).json({
      ok: false,
      ...baseFlags(),
      error: error?.message || String(error),
      durationMs: now() - startedAt,
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  } finally {
    if (lockState?.acquired) {
      await releaseTradeLock({
        redis: durableRedis,
        lockKey,
        token: lockState.token
      }).catch(() => null);
    }
  }
}