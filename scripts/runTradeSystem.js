// ================= FILE: scripts/runTradeSystem.js =================



import { CONFIG } from '../src/config.js';
import { runTradeSystem } from '../src/trade/tradeSystem.js';



const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const TARGET_SCANNER_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';



const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';



const MIN_COMPLETED_ACTIVE_LEARNING = 20;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;



const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const LEARNING_GRANULARITY =
'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const SELECTION_GRANULARITY = 'EXACT_75_CHILD';


const EMPIRICAL_VETO_MIN_COMPLETED = 35;
const EMPIRICAL_VETO_MAX_AVG_R = 0;
const MEASUREMENT_FIX_VERSION =
  'LONG_MEASUREMENT_FIX_TRIGGER_BOUNDARY_EXIT_FILL_V2';
const EXIT_FILL_MODEL_VERSION =
  'LONG_TRIGGER_BOUNDARY_FILL_PLUS_COST_MODEL_V1';
const EMPIRICAL_VETO_POLICY_VERSION =
  'LONG_EXACT_75_CHILD_NET_EDGE_VETO_V1';
const OUTCOME_MEASUREMENT_GATE_MODE = 'STRICT_EXACT_VERSION';


const TEMPORAL_CONTEXT_VERSION =
  'LONG_TEMPORAL_CONTEXT_UTC_V1';
const TEMPORAL_POLICY_VERSION =
  'LONG_TEMPORAL_FAMILY_PROFILE_POLICY_V1';
const TEMPORAL_GENERATION_SCHEMA_VERSION =
  'LONG_TEMPORAL_ROOT_GENERATION_V1';
const WEEKEND_POLICY_VERSION =
  'LONG_WEEKEND_APPROVAL_EXACT_DAY_V1';
const SESSION_POLICY_VERSION =
  'LONG_DAY_SESSION_VETO_RECOVERY_FDR_V1';

const TEMPORAL_STATS_ENABLED_DEFAULT = true;
const TEMPORAL_POLICY_MODE_DEFAULT = 'OBSERVE';
const TEMPORAL_POLICY_MODES = Object.freeze([
  'OFF',
  'OBSERVE',
  'ENFORCE'
]);

const TEMPORAL_WINDOW_MAX_OUTCOMES = 50;
const TEMPORAL_WINDOW_MAX_AGE_DAYS = 180;
const TEMPORAL_GENERATION_MAX_AGE_DAYS = 14;
const TEMPORAL_WEEKEND_APPROVAL_MAX_AGE_DAYS = 45;
const TEMPORAL_EXPECTED_CHILD_FAMILY_COUNT = 75;

const UTC_DAY_NAMES = Object.freeze([
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY'
]);

const TEMPORAL_SESSION_BUCKETS = Object.freeze([
  'ASIA',
  'ASIA_EU_OVERLAP',
  'EUROPE',
  'EU_US_OVERLAP',
  'US',
  'OFF_HOURS'
]);

function now() {
  return Date.now();
}

function normalizeTimestampMs(value, fallback = now()) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return numeric < 10_000_000_000
    ? Math.floor(numeric * 1000)
    : Math.floor(numeric);
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on', 'enabled'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off', 'disabled'].includes(normalized)) return false;
  return fallback;
}

function normalizeTemporalPolicyMode(value) {
  const mode = String(value || TEMPORAL_POLICY_MODE_DEFAULT).trim().toUpperCase();
  return TEMPORAL_POLICY_MODES.includes(mode)
    ? mode
    : TEMPORAL_POLICY_MODE_DEFAULT;
}

function getTemporalRuntimeConfig() {
  const configuredStats =
    process.env.TEMPORAL_STATS_ENABLED ??
    CONFIG.long?.temporal?.statsEnabled ??
    CONFIG.temporal?.statsEnabled;
  const configuredMode =
    process.env.TEMPORAL_POLICY_MODE ??
    CONFIG.long?.temporal?.policyMode ??
    CONFIG.temporal?.policyMode;
  const temporalStatsEnabled = normalizeBoolean(
    configuredStats,
    TEMPORAL_STATS_ENABLED_DEFAULT
  );
  const normalizedMode = normalizeTemporalPolicyMode(configuredMode);
  const temporalPolicyMode = temporalStatsEnabled ? normalizedMode : 'OFF';

  return Object.freeze({
    temporalStatsEnabled,
    configuredTemporalPolicyMode: normalizedMode,
    temporalPolicyMode,
    temporalPolicyEffectivelyOff: !temporalStatsEnabled || temporalPolicyMode === 'OFF'
  });
}

function buildTemporalContext(timestamp = now()) {
  const contextTs = normalizeTimestampMs(timestamp, now());
  const date = new Date(contextTs);
  const hourUtc = date.getUTCHours();
  const dayIndex = date.getUTCDay();
  const dayOfWeekUtc = UTC_DAY_NAMES[dayIndex];
  const isWeekend = dayIndex === 0 || dayIndex === 6;
  const sessionTags = [];

  if (hourUtc >= 0 && hourUtc < 8) sessionTags.push('ASIA');
  if (hourUtc >= 7 && hourUtc < 16) sessionTags.push('EUROPE');
  if (hourUtc >= 13 && hourUtc < 22) sessionTags.push('US');

  let primarySessionBucket = 'OFF_HOURS';
  if (sessionTags.includes('EUROPE') && sessionTags.includes('US')) {
    primarySessionBucket = 'EU_US_OVERLAP';
  } else if (sessionTags.includes('ASIA') && sessionTags.includes('EUROPE')) {
    primarySessionBucket = 'ASIA_EU_OVERLAP';
  } else if (sessionTags.includes('ASIA')) {
    primarySessionBucket = 'ASIA';
  } else if (sessionTags.includes('EUROPE')) {
    primarySessionBucket = 'EUROPE';
  } else if (sessionTags.includes('US')) {
    primarySessionBucket = 'US';
  }

  const immutableSessionTags = Object.freeze([...sessionTags]);
  return Object.freeze({
    temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
    contextTs,
    hourUtc,
    dayOfWeekUtc,
    dayType: isWeekend ? 'WEEKEND' : 'WEEKDAY',
    isWeekend,
    sessionTags: immutableSessionTags,
    primarySessionBucket,
    sessionOverlap: immutableSessionTags.length > 1,
    offHours: immutableSessionTags.length === 0
  });
}

function resolveMarketEventClusterId(row = {}, entryTs = now()) {
  const explicit = [
    row.marketEventClusterId,
    row.entryTemporalContext?.marketEventClusterId,
    row.entryContext?.marketEventClusterId,
    row.scannerRunId,
    row.scanRunId,
    row.snapshotId,
    row.marketCycleId
  ].find((value) => String(value || '').trim());

  if (explicit) return String(explicit).trim();
  return `LONG_EVENT_${Math.floor(normalizeTimestampMs(entryTs, now()) / 3_600_000)}`;
}

function buildEntryTemporalFields(row = {}, fallbackTs = now()) {
  const source = [
    row.entryTemporalContext,
    row.entryContext,
    row.entryDecisionSnapshot?.entryContext,
    row
  ].find((value) => value && typeof value === 'object') || row;
  const entryTs = normalizeTimestampMs(
    source.entryTs ??
      row.entryTs ??
      row.openedAt ??
      row.openedAtMs ??
      row.createdAt ??
      row.ts ??
      fallbackTs,
    fallbackTs
  );
  const derived = buildTemporalContext(entryTs);
  const entrySessionTags = Array.isArray(source.entrySessionTags)
    ? Object.freeze([...new Set(source.entrySessionTags.map(String))])
    : derived.sessionTags;
  const entrySessionBucket = TEMPORAL_SESSION_BUCKETS.includes(source.entrySessionBucket)
    ? source.entrySessionBucket
    : derived.primarySessionBucket;

  return Object.freeze({
    temporalContextVersion:
      source.temporalContextVersion || TEMPORAL_CONTEXT_VERSION,
    entryTs,
    entryHourUtc: Number.isInteger(source.entryHourUtc)
      ? source.entryHourUtc
      : derived.hourUtc,
    entryDayOfWeekUtc:
      source.entryDayOfWeekUtc || derived.dayOfWeekUtc,
    entryDayType: source.entryDayType || derived.dayType,
    entryIsWeekend:
      typeof source.entryIsWeekend === 'boolean'
        ? source.entryIsWeekend
        : derived.isWeekend,
    entrySessionTags,
    entrySessionBucket,
    entrySessionOverlap:
      typeof source.entrySessionOverlap === 'boolean'
        ? source.entrySessionOverlap
        : entrySessionTags.length > 1,
    entryOffHours:
      typeof source.entryOffHours === 'boolean'
        ? source.entryOffHours
        : entrySessionTags.length === 0,
    marketEventClusterId: resolveMarketEventClusterId(
      { ...row, ...source },
      entryTs
    )
  });
}

function buildExitTemporalFields(row = {}, fallbackTs = now()) {
  const source = [
    row.exitTemporalContext,
    row.exitContext,
    row
  ].find((value) => value && typeof value === 'object') || row;
  const exitTs = normalizeTimestampMs(
    source.exitTs ??
      row.exitTs ??
      row.closedAt ??
      row.closedAtMs ??
      row.updatedAt ??
      row.ts ??
      fallbackTs,
    fallbackTs
  );
  const derived = buildTemporalContext(exitTs);
  const exitSessionTags = Array.isArray(source.exitSessionTags)
    ? Object.freeze([...new Set(source.exitSessionTags.map(String))])
    : derived.sessionTags;
  const exitSessionBucket = TEMPORAL_SESSION_BUCKETS.includes(source.exitSessionBucket)
    ? source.exitSessionBucket
    : derived.primarySessionBucket;

  return Object.freeze({
    temporalContextVersion:
      source.temporalContextVersion || TEMPORAL_CONTEXT_VERSION,
    exitTs,
    exitHourUtc: Number.isInteger(source.exitHourUtc)
      ? source.exitHourUtc
      : derived.hourUtc,
    exitDayOfWeekUtc:
      source.exitDayOfWeekUtc || derived.dayOfWeekUtc,
    exitDayType: source.exitDayType || derived.dayType,
    exitIsWeekend:
      typeof source.exitIsWeekend === 'boolean'
        ? source.exitIsWeekend
        : derived.isWeekend,
    exitSessionTags,
    exitSessionBucket,
    exitSessionOverlap:
      typeof source.exitSessionOverlap === 'boolean'
        ? source.exitSessionOverlap
        : exitSessionTags.length > 1,
    exitOffHours:
      typeof source.exitOffHours === 'boolean'
        ? source.exitOffHours
        : exitSessionTags.length === 0
  });
}

function sanitizePublicationResult(value) {
  if (!value || typeof value !== 'object') return null;

  const statusCode = Number(
    value.statusCode ??
      value.httpStatus ??
      value.responseStatus
  );
  const attemptedAt = firstFiniteNumber(
    value.attemptedAt,
    value.startedAt,
    value.createdAt
  );
  const completedAt = firstFiniteNumber(
    value.completedAt,
    value.finishedAt,
    value.publishedAt,
    value.sentAt
  );

  return Object.freeze({
    attempted: Boolean(
      value.attempted ??
        value.sent ??
        value.published ??
        value.success
    ),
    success:
      typeof value.success === 'boolean'
        ? value.success
        : typeof value.ok === 'boolean'
          ? value.ok
          : typeof value.published === 'boolean'
            ? value.published
            : null,
    status: value.status ? String(value.status) : null,
    statusCode: Number.isFinite(statusCode) ? statusCode : null,
    provider: value.provider ? String(value.provider) : null,
    messageId:
      value.messageId ??
      value.discordMessageId ??
      value.id ??
      null,
    errorCode:
      value.errorCode ??
      value.code ??
      null,
    attemptedAt: attemptedAt === null ? null : normalizeTimestampMs(attemptedAt, attemptedAt),
    completedAt: completedAt === null ? null : normalizeTimestampMs(completedAt, completedAt),
    sensitiveFieldsExcluded: true
  });
}

function temporalPolicyForContext(context = buildTemporalContext()) {
  const runtime = getTemporalRuntimeConfig();
  return Object.freeze({
    ...runtime,
    temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
    temporalGenerationSchemaVersion: TEMPORAL_GENERATION_SCHEMA_VERSION,
    weekendPolicyVersion: WEEKEND_POLICY_VERSION,
    sessionPolicyVersion: SESSION_POLICY_VERSION,
    temporalWindowMaxOutcomes: TEMPORAL_WINDOW_MAX_OUTCOMES,
    temporalWindowMaxAgeDays: TEMPORAL_WINDOW_MAX_AGE_DAYS,
    temporalGenerationMaxAgeDays: TEMPORAL_GENERATION_MAX_AGE_DAYS,
    temporalWeekendApprovalMaxAgeDays: TEMPORAL_WEEKEND_APPROVAL_MAX_AGE_DAYS,
    temporalExpectedChildFamilyCount: TEMPORAL_EXPECTED_CHILD_FAMILY_COUNT,
    temporalDecisionRequiresActiveGeneration: true,
    temporalGenerationPointerAuthoritative: true,
    temporalGenerationReadOncePerInvocation: true,
    temporalPolicyAppliesTo: 'DISCORD_ENTRY_PUBLICATION_ONLY',
    temporalExitPublicationAlwaysAllowed: true,
    exitPublicationTemporalBlocked: false,
    weekendLearningAllowed: true,
    weekendVirtualEntryAllowed: true,
    weekendExitMonitoringAllowed: true,
    weekendOutcomeRecordingAllowed: true,
    sessionLearningAllowed: true,
    sessionVirtualEntryAllowed: true,
    weekendDefaultWouldBlock: Boolean(context.isWeekend),
    weekendApprovalRequired: Boolean(context.isWeekend),
    temporalWouldBlock: null,
    finalDiscordEntryAllowedFormula:
      "wouldPublishWithoutTemporal && (temporalPolicyMode !== 'ENFORCE' || temporalWouldBlock === false)",
    enforceMissingRootGenerationBehavior:
      'BLOCK_ALL_NEW_LONG_DISCORD_ENTRIES_KEEP_LEARNING_AND_EXITS_ACTIVE',
    enforceMissingFamilyProjectionBehavior:
      'BLOCK_ONLY_THE_MISSING_EXACT_75_CHILD_FAMILY'
  });
}

function runtimeTemporalFlags(timestamp = now()) {
  const context = buildTemporalContext(timestamp);
  return Object.freeze({
    ...context,
    ...temporalPolicyForContext(context)
  });
}

function argv() {
         return process.argv.slice(2);
}



function hasFlag(flag) {
         const name = String(flag || '').replace(/^--/, '');



         return (
              process.argv.includes(name) ||
              process.argv.includes(`--${name}`)
         );
}



function getArgValue(name) {
    const normalizedName = String(name || '').replace(/^--/, '');
    const prefix = `--${normalizedName}=`;
    const match = process.argv.find((arg) => arg.startsWith(prefix));



    if (!match) return null;



    return match.slice(prefix.length).trim() || null;
}



function isTrue(value) {
    if (value === true || value === 1) return true;



    const raw = String(value ?? '').trim().toLowerCase();



    return ['true', '1', 'yes', 'y', 'on', 'force', 'forced'].includes(raw);
}



function firstValue(...values) {
    for (const value of values) {
         if (value !== undefined && value !== null && value !== '') return value;
    }



    return null;
}



function safeNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}



function firstFiniteNumber(...values) {
    for (const value of values) {
         const n = Number(value);



         if (Number.isFinite(n)) return n;
    }
    return null;
}



function round(value, decimals = 4) {
    const n = Number(value);



    if (!Number.isFinite(n)) return 0;



    return Number(n.toFixed(decimals));
}



function getPositionTimeStopMin() {
    const value = Number(
         CONFIG.long?.trade?.positionTimeStopMin ??
           CONFIG.trade?.positionTimeStopMin
    );



    if (!Number.isFinite(value) || value <= 0) return
DEFAULT_POSITION_TIME_STOP_MIN;



    return Math.floor(value);
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



source: 'VIRTUAL',
sourceMode: 'VIRTUAL',
outcomeSource: 'VIRTUAL',
virtualOnly: true,
virtualTracked: true,
virtualLearning: true,
virtualLearningForced: true,
shadowOnly: true,
virtualOutcomesIncluded: true,
shadowOutcomesIncluded: true,
realOutcomesExcluded: true,
learningOutcomesOnly: true,
outcomesSourceMode: 'VIRTUAL_AND_SHADOW_NET_OUTCOMES',



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
allowLearningWithoutActiveRotation: true,
ignoreMaxOpenPositionsForLearning: true,
ignoreGlobalMaxOpenPositions: true,
globalMaxOpenPositionsBlockDisabled: true,
ignoreRiskCapsForLearning: true,
oneOpenPositionPerSymbol: true,
maxOneOpenPositionPerSymbol: true,
manualSelectionOnly: true,
autoSelectionDisabled: true,
discordOnlyForSelectedMicroFamilies: true,
discordOnlyForManualSelection: true,
discordOnlyForExactTrueMicroMatch: true,
manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',



observationFirst: true,
observationFirstAnalyze: true,



scannerFingerprintRole: 'METADATA_ONLY',
scannerFingerprintsHiddenFromLearning: true,
scannerFingerprintsMetadataOnly: true,
scannerFingerprintsUsedAsLearningFamily: false,



executionFingerprintRole: 'METADATA_ONLY',
executionFingerprintsHiddenFromLearning: true,
executionFingerprintsMetadataOnly: true,
executionFingerprintsUsedAsLearningFamily: false,



analyzeMicroFamiliesOnly: true,
learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
exactTrueMicroFamilyRequired: true,
trueMicroOnly: true,
exactTrueMicroOnly: true,
fixedTaxonomyPreferred: true,
symbolExcludedFromFamilyId: true,



trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
learningGranularity: LEARNING_GRANULARITY,
parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
selectionGranularity: SELECTION_GRANULARITY,



childLearningEnabled: true,
parentLearningEnabled: true,
parentIsContextOnly: true,
parentMatchDoesNotTriggerDiscord: true,
macroMatchDoesNotTriggerDiscord: true,



completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
scoringRSource: 'netR',
winsLossesFlatsSource: 'netR',
winrateDefinition: 'netR > 0',
avgRSource: 'netR',
totalRSource: 'netR',
avgCostRShown: true,


measurementFixVersion: MEASUREMENT_FIX_VERSION,
acceptedOutcomeMeasurementVersion: MEASUREMENT_FIX_VERSION,
outcomeMeasurementGateMode: OUTCOME_MEASUREMENT_GATE_MODE,
completedCurrentMeasurementOnly: true,
strictOutcomeMeasurementGate: true,
legacyOutcomeMeasurementsExcluded: true,
exitFillModelVersion: EXIT_FILL_MODEL_VERSION,
exitFillPolicy: 'TP_SL_USE_TRIGGER_BOUNDARY_TIME_STOP_USES_OBSERVED_PRICE',
empiricalVetoEnabled: true,
empiricalVetoPolicyVersion: EMPIRICAL_VETO_POLICY_VERSION,
empiricalVetoMinCompleted: EMPIRICAL_VETO_MIN_COMPLETED,
empiricalVetoMaxAvgR: EMPIRICAL_VETO_MAX_AVG_R,
empiricalVetoRule: 'completed >= 35 && avgR <= 0',
empiricalVetoBlocksManualActivation: true,
empiricalVetoCanRecover: true,
...runtimeTemporalFlags(),


statusRules: {
         OBSERVING: 'completed == 0',
         EARLY_OUTCOMES: `completed > 0 && completed <
${MIN_COMPLETED_ACTIVE_LEARNING}`,
         ACTIVE_LEARNING: `completed >= ${MIN_COMPLETED_ACTIVE_LEARNING} && completed
< ${EMPIRICAL_VETO_MIN_COMPLETED}`,
         PASSED: `completed >= ${EMPIRICAL_VETO_MIN_COMPLETED} && avgR >
${EMPIRICAL_VETO_MAX_AVG_R}`,
         EMPIRICAL_VETO: `completed >= ${EMPIRICAL_VETO_MIN_COMPLETED} && avgR <=
${EMPIRICAL_VETO_MAX_AVG_R}`
    },
    activationGateRules: {
         OBSERVING: `completed < ${EMPIRICAL_VETO_MIN_COMPLETED}`,
         PASSED: `completed >= ${EMPIRICAL_VETO_MIN_COMPLETED} && avgR >
${EMPIRICAL_VETO_MAX_AVG_R}`,
         EMPIRICAL_VETO: `completed >= ${EMPIRICAL_VETO_MIN_COMPLETED} && avgR <=
${EMPIRICAL_VETO_MAX_AVG_R}`
    },
    defaultRanking:
'dashboardBalancedScore|balancedScore|fairWinrate|totalR|avgR|avgCostR',
    rankingPolicy: 'balancedScore|fairWinrate|totalR|avgR|avgCostR',
    bareWinrateRankingDisabled: true,



    bucketGranularity: 'LOW_MID_HIGH',
    bucketsCoarseOnly: true,
    scannerBucketsDebugOnly: true,
    legacy25BucketsDebugOnly: true,
    coinNameDebugOnly: true,
    hashesDebugOnly: true,



    positionTimeStopMin: getPositionTimeStopMin(),
    positionTimeStopMinDefault: DEFAULT_POSITION_TIME_STOP_MIN,



    validLongRiskShape: 'entry > 0 && sl < entry && tp > entry',
    longRiskShape: 'sl < entry < tp',
    riskTradeSide: TARGET_TRADE_SIDE,
    riskGeometryRule: 'LONG: sl < entry < tp',
    tpHitRule: 'LONG: price >= tp',
    slHitRule: 'LONG: price <= sl',
    longGrossRFormula: '(exitPrice - entry) / (entry - initialSl)',
    longCurrentRFormula: '(currentPrice - entry) / (entry - initialSl)',
    grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
    currentRFormula: '(currentPrice - entry) / (entry - initialSl)',
    longExitPriority: ['TP', 'SL', 'TIME_STOP'],



    currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
    currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,



    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    redisKeysSeparatedFromShortRoot: true,
    shortRootTouched: false,
    resetCronDisabled: true,
         activateFreezeCronDisabled: true,
         autoRotationActivationDisabled: true
    };
}



function shouldForceProcessSnapshot() {
    return (
         hasFlag('force') ||
         hasFlag('forced') ||
         hasFlag('forceProcessSnapshot') ||
         hasFlag('force-process-snapshot') ||
         isTrue(getArgValue('force')) ||
         isTrue(getArgValue('forced')) ||
         isTrue(getArgValue('forceProcessSnapshot')) ||
         isTrue(getArgValue('force-process-snapshot'))
    );
}



function shouldMonitorOnly() {
    return (
         hasFlag('monitorOnly') ||
         hasFlag('monitor-only') ||
         isTrue(getArgValue('monitorOnly')) ||
         isTrue(getArgValue('monitor-only'))
    );
}



function shouldManualRun() {
    return (
         hasFlag('manual') ||
         shouldForceProcessSnapshot() ||
         isTrue(getArgValue('manual'))
    );
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



function uniqueStrings(values = []) {
    return [...new Set(
          flattenValues(values)
               .flatMap((value) => {
                      if (typeof value === 'string') {
                          return value
                            .split(/[\s,;\n\r]+/g)
                            .map((part) => part.trim());
                      }



                      return [value];
               })
               .map((value) => String(value || '').trim())
               .filter(Boolean)
    )];
}



function asArray(value) {
    if (Array.isArray(value)) return value;



    if (value && typeof value === 'object') {
          return Object.values(value);
    }



    return [];
}



function upper(value, fallback = '') {
    const text = String(value || '').trim();



    return text ? text.toUpperCase() : fallback;
}



function cleanSideText(value = '') {
    return upper(value)
        .replaceAll('SHORT_DISABLED_TRUE', 'LONG')
        .replaceAll('SHORTDISABLED_TRUE', 'LONG')
        .replaceAll('BLOCK_SHORT_TRUE', 'LONG')
        .replaceAll('SHORT_DISABLED_FALSE', '')
        .replaceAll('SHORTDISABLED_FALSE', '')
        .replaceAll('BLOCK_SHORT_FALSE', '')
        .replaceAll('SHORT_ENABLED_FALSE', '')
        .replaceAll('SHORT_ONLY_FALSE', '')
        .replaceAll('LONG_DISABLED_FALSE', '')
        .replaceAll('LONGDISABLED_FALSE', '')
        .replaceAll('BLOCK_LONG_FALSE', '')
        .replaceAll('LONG_ENABLED_FALSE', '')
        .replaceAll('LONG_ONLY_FALSE', '')
        .replaceAll('SHORT_DISABLED_LONG_ONLY', 'LONG')
        .replaceAll('SHORTDISABLED_LONG_ONLY', 'LONG')
        .replaceAll('BLOCK_SHORT', 'LONG')
        .replaceAll('SHORT_DISABLED', 'LONG')
        .replaceAll('SHORTDISABLED', 'LONG')
        .replaceAll('LONG_DISABLED_SHORT_ONLY', 'SHORT')
        .replaceAll('LONGDISABLED_SHORT_ONLY', 'SHORT')
        .replaceAll('BLOCK_LONG', 'SHORT')
        .replaceAll('LONG_DISABLED', 'SHORT')
        .replaceAll('LONGDISABLED', 'SHORT')
        .replaceAll('LONG_ONLY_MODE', 'LONG')
        .replaceAll('LONG_ONLY', 'LONG')
        .replaceAll('LONG-ONLY', 'LONG')
        .replaceAll('SHORT_ONLY_MODE', 'SHORT')
        .replaceAll('SHORT_ONLY', 'SHORT')
        .replaceAll('SHORT-ONLY', 'SHORT');
}



function normalizeTradeSide(side) {
    const raw = cleanSideText(side);



    if (['LONG', 'BULL', 'BULLISH', 'BUY', 'DOWN', 'DOWNSIDE'].includes(raw)) {
        return TARGET_TRADE_SIDE;
    }



    if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'UP', 'UPSIDE'].includes(raw)) {
        return OPPOSITE_TRADE_SIDE;
    }



    return 'UNKNOWN';
}



function hasLongSignal(value = '') {
    const text = cleanSideText(value);



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
         text.startsWith('LONG_') ||
         text.includes('_LONG_') ||
         text.endsWith('_LONG') ||
         text.startsWith('BULL_') ||
         text.includes('_BULL_') ||
         text.endsWith('_BULL') ||
         text.startsWith('BUY_') ||
         text.includes('_BUY_') ||
         text.endsWith('_BUY') ||
         text.includes('|LONG|') ||
         text.includes('|BULL|') ||
         text.includes('|BUY|') ||
         text.includes(':LONG') ||
         text.includes(':BULL') ||
         text.includes(':BUY') ||
         text.includes('=LONG') ||
         text.includes('=BULL') ||
         text.includes('=BUY') ||
         text.includes('DOWNSIDE')
    );
}



function hasShortSignal(value = '') {
    const text = cleanSideText(value);



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
         text.startsWith('SHORT_') ||
         text.includes('_SHORT_') ||
         text.endsWith('_SHORT') ||
         text.startsWith('BEAR_') ||
         text.includes('_BEAR_') ||
         text.endsWith('_BEAR') ||
         text.startsWith('SELL_') ||
         text.includes('_SELL_') ||
         text.endsWith('_SELL') ||
         text.includes('|SHORT|') ||
         text.includes('|BEAR|') ||
         text.includes('|SELL|') ||
         text.includes(':SHORT') ||
         text.includes(':BEAR') ||
         text.includes(':SELL') ||
         text.includes('=SHORT') ||
         text.includes('=BEAR') ||
         text.includes('=SELL') ||
         text.includes('UPSIDE')
    );
}



function inferSideFromText(value = '') {
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
           if (text.includes('TRADE_SIDE=LONG') || text.includes('TRADESIDE=LONG'))
return TARGET_TRADE_SIDE;
           if (text.includes('TRADE_SIDE=SHORT') ||
text.includes('TRADESIDE=SHORT'))
return OPPOSITE_TRADE_SIDE;



           return TARGET_TRADE_SIDE;
    }
    return 'UNKNOWN';
}



function getDefinitionHaystack(row = {}) {
    return [
        row.familyId,
        row.family,
        row.baseFamilyId,



        row.microFamilyId,
        row.trueMicroFamilyId,
        row.learningMicroFamilyId,
        row.analyzeMicroFamilyId,
        row.activeMicroFamilyId,
           row.coarseMicroFamilyId,
           row.parentTrueMicroFamilyId,
           row.baseMicroFamilyId,
           row.legacyMicroFamilyId,
           row.liveMicroFamilyId,
           row.realMicroFamilyId,
           row.executionMicroFamilyId,
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



           row.scannerReason,
           row.reason,
           row.waitReason,
           row.signalReason,
           row.actionReason,
           row.exitReason,
           row.rejectionReason,



           ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
           ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts :
[]),
              ...(Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts :
[]),
              ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts
:
[]),
              ...(Array.isArray(row.executionFingerprintParts) ?
row.executionFingerprintParts : [])
       ]
              .map((value) => cleanSideText(value))
         .filter(Boolean)
         .join('|');
}



function getSide(row = {}) {
    if (typeof row === 'string') {
         return inferSideFromText(row);
    }



    if (!row || typeof row !== 'object') {
         return 'UNKNOWN';
    }



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



    if (direct === TARGET_TRADE_SIDE || direct === OPPOSITE_TRADE_SIDE) {
         return direct;
    }



    const inferred = inferSideFromText(getDefinitionHaystack(row));



    if (inferred === TARGET_TRADE_SIDE || inferred === OPPOSITE_TRADE_SIDE) {
         return inferred;
    }



    if (row.longOnly === true || row.shortDisabled === true) {
         return TARGET_TRADE_SIDE;
    }
    if (row.shortOnly === true || row.longDisabled === true) {
         return OPPOSITE_TRADE_SIDE;
    }



    return 'UNKNOWN';
}



function isLongRow(row = {}) {
    return getSide(row) === TARGET_TRADE_SIDE;
}



function isShortRow(row = {}) {
    return getSide(row) === OPPOSITE_TRADE_SIDE;
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



function parseFixedLongTaxonomyId(id = '') {
    const value = upper(id);
    const match = /^MICRO_LONG_([A-Z_]+)_(TREND|CHOP|SQUEEZE)
(?:_(A_STRONG_ALIGN|B_FLOW_ALIGN|C_VOLUME_ALIGN|D_MIXED_OK|E_WEAK_CONTRA))?
$/.exec(value);



    if (!match) return null;



    const setup = match[1];
    const regime = match[2];
    const confirmation = match[3] || null;



    if (!LONG_FIXED_SETUP_TYPES.has(setup)) return null;
    if (!LONG_FIXED_REGIME_BUCKETS.has(regime)) return null;
    if (confirmation && !LONG_FIXED_CONFIRMATION_PROFILES.has(confirmation))
return
null;



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



function isExactLongChildTrueMicroId(id = '') {
    return parseFixedLongTaxonomyId(id)?.isChild === true;
}



function isParentLongMicroId(id = '') {
    return parseFixedLongTaxonomyId(id)?.isParent === true;
}



function parentTrueMicroFamilyIdFromChild(id = '') {
    const parsed = parseFixedLongTaxonomyId(id);



    return parsed?.isChild ? parsed.parentTrueMicroFamilyId : null;
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



    if (parseFixedLongTaxonomyId(raw)) {
        return upper(raw);
    }



    const tokens = symbolTokensFromRow(row);
    if (!tokens.length) return raw;



    let next = raw;



    for (const token of tokens) {
        const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');



        next = next
          .replace(new RegExp(`(^|[_|:=\\-])${escaped}([_|:=\\-]|$)`, 'gi'),
'$1ASSET$2')
          .replace(new RegExp(`(^|[_|:=\\-])${escaped}USDT([_|:=\\-]|$)`, 'gi'),
'$1ASSET$2')
          .replace(new RegExp(`(^|[_|:=\\-])${escaped}USDC([_|:=\\-]|$)`, 'gi'),
'$1ASSET$2');
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
    return upper(clean);
}



function firstCleanLearningId(row = {}, fields = []) {
    for (const field of fields) {
          const id = cleanLearningFamilyId(row?.[field], row);



          if (id) return id;
    }



    return null;
}



function getTrueMicroFamilyId(row = {}) {
    const explicit = firstCleanLearningId(row, [
          'trueMicroFamilyId',
          'learningMicroFamilyId',
          'analyzeMicroFamilyId',
          'microFamilyId',
          'activeMicroFamilyId',
          'id',
          'key'
    ]);



    if (isExactLongChildTrueMicroId(explicit)) return explicit;



    return null;
}



function getParentTrueMicroFamilyId(row = {}) {
    const direct = firstCleanLearningId(row, [
           'parentTrueMicroFamilyId',
           'coarseMicroFamilyId',
           'parentMicroFamilyId',
           'parentMacroFamilyId',
           'macroFamilyId'
    ]);
    if (isParentLongMicroId(direct)) return direct;



    const childParent =
parentTrueMicroFamilyIdFromChild(getTrueMicroFamilyId(row));
    if (childParent) return childParent;



    return null;
}



function getCoarseMicroFamilyId(row = {}) {
    return (
         getParentTrueMicroFamilyId(row) ||
         getTrueMicroFamilyId(row) ||
         firstCleanLearningId(row, [
                'coarseMicroFamilyId',
                'baseMicroFamilyId',
                'legacyMicroFamilyId'
         ])
    );
}



function getMicroFamilyId(row = {}) {
    return getTrueMicroFamilyId(row);
}



function getMacroFamilyId(row = {}) {
    return (
         getParentTrueMicroFamilyId(row) ||
         cleanLearningFamilyId(
                row?.parentMacroFamilyId ||
                   row?.activeMacroFamilyId ||
                   row?.macroFamilyId ||
                   row?.parentMicroFamilyId ||
                   row?.parentFamilyId ||
                   row?.familyMacroId ||
                   row?.macroId ||
                   row?.familyId ||
                   '',
                row
         ) ||
         null
    );
}



function getFamilyId(row = {}) {
    return row?.familyId || row?.family || row?.baseFamilyId || null;
}



function getSymbol(row = {}) {
    return (
         row?.symbol ||
         row?.baseSymbol ||
         row?.contractSymbol ||
         row?.instId ||
         row?.instrumentId ||
         null
    );
}



function scannerMetadataFrom(row = {}) {
    const scannerMicroFamilyId = [
         row.scannerMicroFamilyId,
         row.microFamilyId,
         row.trueMicroFamilyId,
         row.id,
         row.key
    ].find(isScannerFingerprintId) || row.scannerMicroFamilyId || null;



    const scannerFamilyId = [
         row.scannerFamilyId,
         row.familyId,
         row.baseFamilyId
    ].find(isScannerFingerprintId) || row.scannerFamilyId || null;



    return {
         scannerMicroFamilyId,
         scannerFamilyId,
         scannerDefinition: row.scannerDefinition || null,
         scannerDefinitionParts: Array.isArray(row.scannerDefinitionParts)
           ? row.scannerDefinitionParts
           : [],



         scannerBucket: row.scannerBucket || row.bucket || null,
         scannerBucketDebug: row.scannerBucketDebug || row.bucketDebug || null,
         legacy25Bucket: row.legacy25Bucket || row.oldBucket || row.bucket25 ||
null,



         scannerFingerprintRole: 'METADATA_ONLY',
         scannerFingerprintsMetadataOnly: true,
         scannerFingerprintsUsedAsLearningFamily: false
    };
}



function executionMetadataFrom(row = {}) {
    const executionMicroFamilyId = [
         row.executionMicroFamilyId,
         row.executionFingerprintHash,
         row.microFamilyId,
         row.trueMicroFamilyId,
         row.analyzeMicroFamilyId,
         row.id,
         row.key
    ].find(isExecutionFingerprintId) || row.executionMicroFamilyId || null;



    return {
         executionMicroFamilyId,
         executionFingerprintHash: row.executionFingerprintHash || null,
         executionFingerprintParts: Array.isArray(row.executionFingerprintParts)
           ? row.executionFingerprintParts
           : [],
         executionFingerprintSchema: row.executionFingerprintSchema || null,



         executionFingerprintRole: 'METADATA_ONLY',
         executionFingerprintsMetadataOnly: true,
         executionFingerprintsUsedAsLearningFamily: false
    };
}



function marketBiasHaystack(row = {}) {
    return cleanSideText([
         row.marketBias,
         row.bias,
         row.trendSide,
         row.currentTrendSide,
         row.marketSide,
         row.breadthSide,
         row.currentMarketSide,
         row.regimeSide,
         row.reason,
         row.waitReason,
         row.scannerReason,
         row.signalReason,
         row.actionReason,
         row.exitReason,
         row.currentFitLabel,
         row.currentMarketFitLabel
    ].filter(Boolean).join('|'));
}



function getLongCurrentFit(row = {}) {
    const explicitLong = firstFiniteNumber(
         row.longCurrentFit,
         row.longCurrentFitScore,
         row.bullCurrentFit,
         row.bullCurrentFitScore,
         row.bullishCurrentFit,
         row.bullishCurrentFitScore
    );



    if (explicitLong !== null) return explicitLong;



    const explicitShort = firstFiniteNumber(
         row.shortCurrentFit,
         row.shortCurrentFitScore,
         row.bearCurrentFit,
         row.bearCurrentFitScore,
         row.bearishCurrentFit,
         row.bearishCurrentFitScore
    );



    if (explicitShort !== null) return -Math.abs(explicitShort);



    const rawFit = firstFiniteNumber(
         row.currentFitScore,
         row.entryCurrentFitScore,
         row.currentMarketFitScore,
         row.fitScore,
            row.marketFitScore,
            row.currentFit,
            row.entryCurrentFit,
            row.currentMarketFit,
            row.fit,
            row.marketFit
    );



    if (rawFit === null) return 0;



    const bias = marketBiasHaystack(row);



    if (hasLongSignal(bias) && !hasShortSignal(bias)) return Math.abs(rawFit);
    if (hasShortSignal(bias) && !hasLongSignal(bias)) return -Math.abs(rawFit);



    return rawFit;
}



function forceLongRow(row = {}) {
    const trueMicroFamilyId = getTrueMicroFamilyId(row);
    const parentTrueMicroFamilyId = getParentTrueMicroFamilyId(row);
    const coarseMicroFamilyId = getCoarseMicroFamilyId(row);
    const longCurrentFit = getLongCurrentFit(row);
    const rowTs = firstFiniteNumber(
         row.contextTs,
         row.entryTs,
         row.openedAt,
         row.createdAt,
         row.ts,
         now()
    ) || now();
    const entryTemporalContext = buildEntryTemporalFields(row, rowTs);
    const temporalContext = buildTemporalContext(entryTemporalContext.entryTs);
    const canonicalPositionId =
      row.canonicalPositionId ||
      row.position?.canonicalPositionId ||
      row.entryDecisionSnapshot?.canonicalPositionId ||
      null;

    return {
         ...row,



         ...baseFlags(),
         ...temporalContext,
         ...temporalPolicyForContext(temporalContext),
         ...entryTemporalContext,
         entryTemporalContext,
         entryTemporalContextImmutable: true,
         canonicalPositionId,
         canonicalPositionIdRequiredAtCreation: true,
         canonicalPositionIdMustNeverBeReconstructed: true,
         entryDecisionSnapshot: row.entryDecisionSnapshot || null,
         entryPublicationResult: sanitizePublicationResult(row.entryPublicationResult),
         ...scannerMetadataFrom(row),
        ...executionMetadataFrom(row),



        microFamilyId: trueMicroFamilyId,
        trueMicroFamilyId,
        analyzeMicroFamilyId: trueMicroFamilyId,
        learningMicroFamilyId: trueMicroFamilyId,



        parentTrueMicroFamilyId,
        coarseMicroFamilyId: coarseMicroFamilyId || parentTrueMicroFamilyId ||
trueMicroFamilyId,
        macroFamilyId: parentTrueMicroFamilyId || getMacroFamilyId(row),
        parentMacroFamilyId: parentTrueMicroFamilyId || row.parentMacroFamilyId ||
null,
        parentMicroFamilyId: parentTrueMicroFamilyId || row.parentMicroFamilyId ||
null,



        trueMicroFamilySchema: trueMicroFamilyId ? TRUE_MICRO_SCHEMA : null,
        exactTrueMicroFamilySchema: trueMicroFamilyId ? TRUE_MICRO_SCHEMA : null,
        parentTrueMicroFamilySchema: parentTrueMicroFamilyId ?
PARENT_TRUE_MICRO_SCHEMA : null,



        inferredTradeSide: TARGET_TRADE_SIDE,



        currentFit: longCurrentFit,
        currentFitScore: longCurrentFit,
        longCurrentFit,
        bullCurrentFit: longCurrentFit,
        bullishCurrentFit: longCurrentFit,
        shortCurrentFit: -Math.abs(longCurrentFit),
        bearishCurrentFit: -Math.abs(longCurrentFit),
        currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
        currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',



        source: row.source || 'VIRTUAL',
           sourceMode: 'VIRTUAL',
           outcomeSource: row.outcomeSource || row.source || 'VIRTUAL',
           virtualOnly: true,
           virtualTracked: true,
           shadowOnly: row.shadowOnly !== false,
         realTrade: false,
         realOrder: false,
         exchangeOrder: false,
         bitgetOrderPlaced: false
    };
}



function onlyLongRows(rows = []) {
    return asArray(rows)
         .filter(isLongRow)
         .map(forceLongRow);
}



function actionType(row = {}) {
    return upper(row?.action || row?.type || 'UNKNOWN', 'UNKNOWN');
}



function isEntryAction(row = {}) {
    const type = actionType(row);



    return (
         type === 'ENTRY' ||
         type === 'VIRTUAL_ENTRY' ||
         type === 'SHADOW_ENTRY' ||
         type === 'OPEN' ||
         type === 'VIRTUAL_OPEN'
    );
}



function isWaitAction(row = {}) {
    return actionType(row) === 'WAIT';
}



function waitReason(row = {}) {
    return upper(row?.reason || row?.waitReason || 'UNKNOWN', 'UNKNOWN');
}



function exitReason(row = {}) {
    return upper(row?.exitReason || row?.reason || row?.type || 'UNKNOWN',
'UNKNOWN');
}
function getLongRiskGeometry(row = {}) {
    const entry = firstFiniteNumber(
         row.entry,
         row.entryPrice,
         row.avgEntryPrice,
         row.openPrice
    );



    const initialSl = firstFiniteNumber(
         row.initialSl,
         row.initialStopLoss,
         row.sl,
         row.stopLoss,
         row.stop
    );



    const tp = firstFiniteNumber(
         row.tp,
         row.takeProfit,
         row.target,
         row.targetPrice,
         row.tp1
    );



    const exitPrice = firstFiniteNumber(
         row.exitPrice,
         row.closePrice,
         row.closedPrice,
         row.currentPrice,
         row.lastPrice,
         row.markPrice,
         row.price
    );



    const currentPrice = firstFiniteNumber(
         row.currentPrice,
         row.lastPrice,
         row.markPrice,
         row.price,
         exitPrice
    );
  const denominator = entry !== null && initialSl !== null
         ? entry - initialSl
         : null;
  const validLongGeometry = (
         entry !== null &&
         initialSl !== null &&
         tp !== null &&
         entry > 0 &&
         denominator > 0 &&
         initialSl < entry &&
         entry < tp
  );



  const longGrossR = validLongGeometry && exitPrice !== null
         ? (exitPrice - entry) / denominator
         : null;



  const longCurrentR = validLongGeometry && currentPrice !== null
         ? (currentPrice - entry) / denominator
         : null;



  const priceForHit = exitPrice ?? currentPrice;



  return {
         entry,
         entryPrice: entry,
         sl: initialSl,
         initialSl,
         tp,
         exitPrice,
         currentPrice,



         validLongRiskShape: validLongGeometry,
         validLongGeometry,
         longValidGeometry: validLongGeometry,
         longRiskShapeValid: validLongGeometry,



         longTpHit: validLongGeometry && priceForHit !== null ? priceForHit >= tp :
false,
         longSlHit: validLongGeometry && priceForHit !== null ? priceForHit <=
initialSl : false,



         longGrossR,
         longCurrentR,



         riskTradeSide: TARGET_TRADE_SIDE,
         riskGeometryRule: 'LONG: sl < entry < tp',
         tpHitRule: 'LONG: price >= tp',
         slHitRule: 'LONG: price <= sl',
         grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
           currentRFormula: '(currentPrice - entry) / (entry - initialSl)'
    };
}



function netR(row = {}) {
    const value = Number(
           row.longNetR ??
             row.netLongR ??
             row.netR ??
             row.r ??
             row.finalNetR ??
             row.outcomeNetR ??
             row.resultNetR ??
             row.rNet ??
             0
    );



    return Number.isFinite(value) ? value : 0;
}



function grossR(row = {}) {
    const geometry = getLongRiskGeometry(row);



    if (geometry.validLongGeometry && geometry.longGrossR !== null) {
           return geometry.longGrossR;
    }



    const value = Number(
           row.longGrossR ??
              row.grossR ??
              row.finalGrossR ??
              row.outcomeGrossR ??
              row.resultGrossR ??
              row.rGross ??
              row.netR ??
              row.r ??
              0
    );



    return Number.isFinite(value) ? value : 0;
}



function costR(row = {}) {
    const explicit = Number(
         row.costR ??
              row.totalCostR ??
              row.feeCostR ??
              row.executionCostR
    );



    if (Number.isFinite(explicit)) return explicit;



    return Math.max(0, grossR(row) - netR(row));
}



function countBy(rows = [], selector) {
    return rows.reduce((acc, row) => {
         const key = selector(row);



         if (!key) return acc;



         acc[key] = (acc[key] || 0) + 1;



         return acc;
    }, {});
}
function sum(rows = [], selector) {
    return rows.reduce((total, row) => {
         const value = Number(selector(row));



         return total + (Number.isFinite(value) ? value : 0);
    }, 0);
}



function avg(rows = [], selector) {
    if (!rows.length) return 0;



    return sum(rows, selector) / rows.length;
}



function unwrapRunResult(result = {}) {
    if (!result || typeof result !== 'object') return {};



    if (result.result?.result?.result) return result.result.result.result;
    if (result.result?.result) return result.result.result;
    if (result.result) return result.result;



    return result;
}



function extractActions(payload = {}) {
    return asArray(
         payload.actions ||
             payload.tradeActions ||
             payload.result?.actions ||
             []
    );
}



function extractVirtualExits(payload = {}) {
    return asArray([
         ...asArray(payload.virtualExits),
         ...asArray(payload.shadowExits),
         ...asArray(payload.exits),
         ...asArray(payload.closedPositions),
          ...asArray(payload.outcomes),
          ...asArray(payload.learningShadowExits),
          ...asArray(payload.result?.virtualExits),
          ...asArray(payload.result?.shadowExits),
          ...asArray(payload.result?.exits),
          ...asArray(payload.result?.closedPositions)
    ]);
}



function extractOpenPositions(payload = {}) {
    return asArray(
          payload.openPositions ||
            payload.positions ||
            payload.virtualPositions ||
            payload.result?.openPositions ||
            []
    );
}



function getActionCounts(actions = []) {
    return countBy(onlyLongRows(actions), actionType);
}



function summarizeEntries(actions = []) {
    const entries = onlyLongRows(actions).filter(isEntryAction);



    return {
          count: entries.length,



          symbols: uniqueStrings(entries.map(getSymbol)),
          microFamilyIds: uniqueStrings(entries.map(getMicroFamilyId)),
          trueMicroFamilyIds: uniqueStrings(entries.map(getTrueMicroFamilyId)),
          parentTrueMicroFamilyIds:
uniqueStrings(entries.map(getParentTrueMicroFamilyId)),
          coarseMicroFamilyIds: uniqueStrings(entries.map(getCoarseMicroFamilyId)),
          macroFamilyIds: uniqueStrings(entries.map(getMacroFamilyId)),
          familyIds: uniqueStrings(entries.map(getFamilyId)),



          exact75ChildIds:
uniqueStrings(entries.map(getTrueMicroFamilyId)).filter(isExactLongChildTrueMicroId),
          parent15Ids:
uniqueStrings(entries.map(getParentTrueMicroFamilyId)).filter(isParentLongMicroId),



         byMicroFamily: countBy(entries, getMicroFamilyId),
         byTrueMicroFamily: countBy(entries, getTrueMicroFamilyId),
         byParentTrueMicroFamily: countBy(entries, getParentTrueMicroFamilyId),
         byCoarseMicroFamily: countBy(entries, getCoarseMicroFamilyId),
         byMacroFamily: countBy(entries, getMacroFamilyId),
         byFamily: countBy(entries, getFamilyId)
    };
}



function summarizeWaits(actions = []) {
    const waits = onlyLongRows(actions).filter(isWaitAction);



    return {
         count: waits.length,



         byReason: countBy(waits, waitReason),
         byMicroFamily: countBy(waits, getMicroFamilyId),
         byTrueMicroFamily: countBy(waits, getTrueMicroFamilyId),
         byParentTrueMicroFamily: countBy(waits, getParentTrueMicroFamilyId),
         byCoarseMicroFamily: countBy(waits, getCoarseMicroFamilyId),
         byMacroFamily: countBy(waits, getMacroFamilyId),



         observationOnly: waits.filter((row) =>
Boolean(row.observationOnly)).length,
         riskInvalid: waits.filter((row) => Boolean(row.riskInvalid ||
row.invalidRisk)).length,
         missingExact75Child: waits.filter((row) =>
!getTrueMicroFamilyId(row)).length,
         symbolAlreadyOpen: waits.filter((row) =>
waitReason(row).includes('SYMBOL_ALREADY_OPEN')).length,
         nonSelectedSilent: waits.filter((row) => Boolean(row.nonSelectedSilent ||
row.discordAlertEligible === false)).length
    };
}



function normalizeExitRow(row = {}) {
    const normalized = forceLongRow(row);
    const geometry = getLongRiskGeometry(row);
    const nR = netR(row);
    const gR = grossR(row);
    const cR = costR(row);
    const exitTemporalContext = buildExitTemporalFields(row);
    return {
         ...normalized,



         action: 'VIRTUAL_EXIT',
         source: 'VIRTUAL',
         outcomeSource: 'VIRTUAL',



         ...geometry,
         ...exitTemporalContext,
         exitTemporalContext,
         exitPublicationResult: sanitizePublicationResult(row.exitPublicationResult),
         temporalPolicyBlockedExitPublication: false,

         grossR: round(gR, 4),
         longGrossR: round(gR, 4),
         costR: round(cR, 4),
         totalCostR: round(cR, 4),
         avgCostR: round(row.avgCostR ?? cR, 4),
         netR: round(nR, 4),
         longNetR: round(nR, 4),
         r: round(nR, 4),
         realizedR: round(row.realizedR ?? nR, 4),



         win: nR > 0,
         loss: nR < 0,
         flat: nR === 0,



         completedCountsAs: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOME',
         scoringRSource: 'netR',
         winrateDefinition: 'netR > 0',



         realTrade: false,
         realOrder: false,
         exchangeOrder: false,
         bitgetOrderPlaced: false,
         realOrdersDisabled: true,
         bitgetOrdersDisabled: true,
         exchangeCallsDisabled: true
    };
}
function summarizeVirtualExits(payload = {}) {
    const rawExits = extractVirtualExits(payload);
    const exits = onlyLongRows(rawExits).map(normalizeExitRow);



    return {
         total: exits.length,



         virtual: exits.filter((row) => row.virtualOnly !== false).length,
         selectedForDiscord: exits.filter((row) =>
Boolean(row.discordAlertEligible ||
row.selectedForDiscord)).length,



         wins: exits.filter((row) => netR(row) > 0).length,
         losses: exits.filter((row) => netR(row) < 0).length,
         flats: exits.filter((row) => netR(row) === 0).length,



         totalGrossR: round(sum(exits, grossR), 4),
         totalCostR: round(sum(exits, costR), 4),
         totalNetR: round(sum(exits, netR), 4),



         avgGrossR: round(avg(exits, grossR), 4),
         avgCostR: round(avg(exits, costR), 4),
         avgNetR: round(avg(exits, netR), 4),



         byReason: countBy(exits, exitReason),
         byMicroFamily: countBy(exits, getMicroFamilyId),
         byTrueMicroFamily: countBy(exits, getTrueMicroFamilyId),
         byParentTrueMicroFamily: countBy(exits, getParentTrueMicroFamilyId),
         byCoarseMicroFamily: countBy(exits, getCoarseMicroFamilyId),
         byMacroFamily: countBy(exits, getMacroFamilyId),



         exact75ChildIds:
uniqueStrings(exits.map(getTrueMicroFamilyId)).filter(isExactLongChildTrueMicroId),
         parent15Ids:
uniqueStrings(exits.map(getParentTrueMicroFamilyId)).filter(isParentLongMicroId),



         tradeIds: uniqueStrings(exits.map((row) => row?.tradeId ||
row?.positionId ||
row?.id)),
         rows: exits
    };
}



function getPositionEntry(row = {}) {
    return safeNumber(row.entry ?? row.entryPrice ?? row.openPrice, 0);
}



function getPositionSl(row = {}) {
    return safeNumber(row.initialSl ?? row.sl ?? row.stopLoss, 0);
}



function getPositionTp(row = {}) {
    return safeNumber(row.tp ?? row.takeProfit, 0);
}



function getPositionCurrentPrice(row = {}) {
    return safeNumber(
         row.currentPrice ??
             row.lastPrice ??
             row.markPrice ??
             row.price,
         0
    );
}



function getPositionAgeSec(row = {}) {
    const explicit = Number(row.ageSec);



    if (Number.isFinite(explicit) && explicit >= 0) return explicit;



    const openedAt = Number(row.openedAt || row.createdAt || row.ts);



    if (!Number.isFinite(openedAt) || openedAt <= 0) return 0;



    return Math.max(0, Math.floor((now() - openedAt) / 1000));
}



function validLongRiskShape(row = {}) {
      const entry = getPositionEntry(row);
      const sl = getPositionSl(row);
      const tp = getPositionTp(row);



      return entry > 0 && sl > 0 && tp > 0 && sl < entry && tp > entry;
}



function calcLongCurrentR(row = {}) {
      const entry = getPositionEntry(row);
      const initialSl = getPositionSl(row);
      const currentPrice = getPositionCurrentPrice(row);
      const distance = entry - initialSl;



      if (!(entry > 0 && distance > 0 && currentPrice > 0)) return null;



      return (currentPrice - entry) / distance;
}



function buildExitFlags(row = {}) {
      const entry = getPositionEntry(row);
      const sl = getPositionSl(row);
      const tp = getPositionTp(row);
      const currentPrice = getPositionCurrentPrice(row);
      const ageSec = getPositionAgeSec(row);
      const timeStopSec = getPositionTimeStopMin() * 60;
      const riskValid = validLongRiskShape(row);
    const tpHitNow = riskValid && currentPrice >= tp;
    const slHitNow = riskValid && currentPrice <= sl;
    const timeStopHitNow = ageSec >= timeStopSec;



    let exitReasonNow = null;



    if (tpHitNow) {
        exitReasonNow = 'TP';
    } else if (slHitNow) {
        exitReasonNow = 'SL';
  } else if (timeStopHitNow) {
      exitReasonNow = 'TIME_STOP';
  }



  return {
      entry,
      sl,
      initialSl: sl,
      tp,
      currentPrice,
      lastPrice: safeNumber(row.lastPrice ?? currentPrice, currentPrice),
      ageSec,



      longRiskShapeValid: riskValid,
      validLongRiskShape: riskValid,
      validLongGeometry: riskValid,
      longValidGeometry: riskValid,



      currentR: row.currentR !== undefined &&
Number.isFinite(Number(row.currentR))
        ? Number(row.currentR)
        : calcLongCurrentR(row),



      longCurrentR: row.longCurrentR !== undefined &&
Number.isFinite(Number(row.longCurrentR))
        ? Number(row.longCurrentR)
        : calcLongCurrentR(row),



      mfeR: Number.isFinite(Number(row.mfeR)) ? Number(row.mfeR) : null,
      maeR: Number.isFinite(Number(row.maeR)) ? Number(row.maeR) : null,



      reachedHalfR: Boolean(row.reachedHalfR),
      reachedOneR: Boolean(row.reachedOneR),
      nearTpSeen: Boolean(row.nearTpSeen),



      tpHitNow,
      slHitNow,
            longTpHit: tpHitNow,
            longSlHit: slHitNow,
            timeStopHitNow,
           tpExitArmed: tpHitNow,
           slExitArmed: slHitNow,
           timeStopExitArmed: timeStopHitNow,



           exitReadyNow: Boolean(exitReasonNow),
           exitReasonNow,



           realOrdersDisabled: true,
           bitgetOrdersDisabled: true,
           exchangeCallsDisabled: true,



           riskTradeSide: TARGET_TRADE_SIDE,
           riskGeometryRule: 'LONG: sl < entry < tp',
           tpHitRule: 'LONG: price >= tp',
           slHitRule: 'LONG: price <= sl',



           formulas: {
               grossR: '(exitPrice - entry) / (entry - initialSl)',
               currentR: '(currentPrice - entry) / (entry - initialSl)'
           }
    };
}



function summarizeOpenPositions(payload = {}) {
    const positions = onlyLongRows(extractOpenPositions(payload));
    const debugRows = positions.map((row) => ({
           ...forceLongRow(row),
           ...buildExitFlags(row)
    }));



    return {
           count: positions.length,



           symbols: uniqueStrings(positions.map(getSymbol)),
           microFamilyIds: uniqueStrings(positions.map(getMicroFamilyId)),
           trueMicroFamilyIds: uniqueStrings(positions.map(getTrueMicroFamilyId)),
           parentTrueMicroFamilyIds:
uniqueStrings(positions.map(getParentTrueMicroFamilyId)),
         coarseMicroFamilyIds:
uniqueStrings(positions.map(getCoarseMicroFamilyId)),
         macroFamilyIds: uniqueStrings(positions.map(getMacroFamilyId)),



         exact75ChildIds:
uniqueStrings(positions.map(getTrueMicroFamilyId)).filter(isExactLongChildTrueMicroId),
         parent15Ids:
uniqueStrings(positions.map(getParentTrueMicroFamilyId)).filter(isParentLongMicroId),



         byMicroFamily: countBy(positions, getMicroFamilyId),
         byTrueMicroFamily: countBy(positions, getTrueMicroFamilyId),
         byParentTrueMicroFamily: countBy(positions, getParentTrueMicroFamilyId),
         byCoarseMicroFamily: countBy(positions, getCoarseMicroFamilyId),
         byMacroFamily: countBy(positions, getMacroFamilyId),



         selectedForDiscord: positions.filter((row) =>
Boolean(row.discordAlertEligible
|| row.selectedForDiscord)).length,
         virtualOnly: positions.filter((row) => row.virtualOnly !== false).length,



         invalidLongRiskShape: debugRows.filter((row) =>
!row.longRiskShapeValid).length,
         missingExact75Child: debugRows.filter((row) =>
!getTrueMicroFamilyId(row)).length,
         tpReady: debugRows.filter((row) => row.tpHitNow).length,
         slReady: debugRows.filter((row) => row.slHitNow).length,
         timeStopReady: debugRows.filter((row) => row.timeStopHitNow).length,
         exitReady: debugRows.filter((row) => row.exitReadyNow).length,



         debugRows
    };
}



function summarizeIgnoredSides(payload = {}, actions = []) {
    const allActions = asArray(actions);
    const allExits = extractVirtualExits(payload);
    const allPositions = extractOpenPositions(payload);



    return {
         shortActionsIgnored: allActions.filter(isShortRow).length,
           unknownSideActionsIgnored: allActions.filter((row) => getSide(row) ===
'UNKNOWN').length,



           shortExitsIgnored: allExits.filter(isShortRow).length,
           unknownSideExitsIgnored: allExits.filter((row) => getSide(row) ===
'UNKNOWN').length,



           shortPositionsIgnored: allPositions.filter(isShortRow).length,
           unknownSidePositionsIgnored: allPositions.filter((row) => getSide(row)
===
'UNKNOWN').length
      };
}



function summarizeFingerprintMetadata(payload = {}, actions = []) {
      const allActions = asArray(actions);
      const allExits = extractVirtualExits(payload);
      const allPositions = extractOpenPositions(payload);



      const hasScanner = (row = {}) => (
           isScannerFingerprintId(row.scannerMicroFamilyId) ||
           isScannerFingerprintId(row.scannerFamilyId) ||
           isScannerFingerprintId(row.microFamilyId) ||
           isScannerFingerprintId(row.trueMicroFamilyId) ||
           isScannerFingerprintId(row.id) ||
           isScannerFingerprintId(row.key)
      );



      const hasExecution = (row = {}) => (
           isExecutionFingerprintId(row.executionMicroFamilyId) ||
           isExecutionFingerprintId(row.executionFingerprintHash) ||
           isExecutionFingerprintId(row.microFamilyId) ||
           isExecutionFingerprintId(row.trueMicroFamilyId) ||
           isExecutionFingerprintId(row.analyzeMicroFamilyId) ||
           isExecutionFingerprintId(row.id) ||
           isExecutionFingerprintId(row.key)
      );



      return {
           scannerFingerprintActions: allActions.filter(hasScanner).length,
           scannerFingerprintExits: allExits.filter(hasScanner).length,
         scannerFingerprintPositions: allPositions.filter(hasScanner).length,
         scannerFingerprintsUsedAsLearningFamily: 0,



         executionFingerprintActions: allActions.filter(hasExecution).length,
         executionFingerprintExits: allExits.filter(hasExecution).length,
         executionFingerprintPositions: allPositions.filter(hasExecution).length,
         executionFingerprintsUsedAsLearningFamily: 0
    };
}



function buildRequestedOptions() {
    const forceProcessSnapshot = shouldForceProcessSnapshot();
    const monitorOnly = shouldMonitorOnly();



    return {
         force: forceProcessSnapshot,
         forceProcessSnapshot,
         monitorOnly,



         snapshotId: firstValue(
           getArgValue('snapshotId'),
           getArgValue('snapshot')
         ) || undefined,



         runSource: shouldManualRun()
           ? 'CLI_MANUAL_TRADE_RUN_LONG_ONLY'
           : 'CLI_TRADE_RUN_LONG_ONLY',



         ...baseFlags()
    };
}



function buildRunOptions(requested = {}) {
    return {
         force: Boolean(requested.force),
         forceProcessSnapshot: Boolean(requested.forceProcessSnapshot),
         monitorOnly: Boolean(requested.monitorOnly),



         monitorOpenPositionsFirst: true,
         monitorOpenPositions: true,
         processOpenPositions: true,
         closeVirtualPositions: true,
         processScannerSnapshot: !requested.monitorOnly,



         snapshotId: requested.snapshotId,



         targetTradeSide: TARGET_TRADE_SIDE,
         tradeSide: TARGET_TRADE_SIDE,
         positionSide: TARGET_TRADE_SIDE,
         direction: TARGET_TRADE_SIDE,



         side: TARGET_DASHBOARD_SIDE,
         dashboardSide: TARGET_DASHBOARD_SIDE,
         scannerSide: TARGET_SCANNER_SIDE,
         actualScannerSide: TARGET_SCANNER_SIDE,
         analysisSide: TARGET_TRADE_SIDE,



         longOnly: true,
         shortDisabled: true,
         disableShort: true,
         shortOnly: false,
         longDisabled: false,



         namespace: LONG_NAMESPACE,
         keyPrefix: LONG_KEY_PREFIX,
         redisNamespace: LONG_NAMESPACE,
         redisKeyPrefix: LONG_KEY_PREFIX,
         persistentLearningKey: PERSISTENT_LEARNING_KEY,
         weekKey: PERSISTENT_LEARNING_KEY,
         ...runtimeTemporalFlags(),



source: 'VIRTUAL',
sourceMode: 'VIRTUAL',
outcomeSource: 'VIRTUAL',
virtualOnly: true,
virtualTracked: true,
virtualLearning: true,
virtualLearningForced: true,
shadowOnly: true,
realOrdersDisabled: true,
exchangeOrdersDisabled: true,
bitgetOrdersDisabled: true,
exchangeCallsDisabled: true,
noExchangeOrders: true,
noRealOrders: true,



learningOnly: true,
microFamilyLearning: true,
allowLearningWithoutActiveRotation: true,
ignoreMaxOpenPositionsForLearning: true,
ignoreGlobalMaxOpenPositions: true,
globalMaxOpenPositionsBlockDisabled: true,
ignoreRiskCapsForLearning: true,
oneOpenPositionPerSymbol: true,
maxOneOpenPositionPerSymbol: true,



manualSelectionOnly: true,
autoSelectionDisabled: true,
discordOnlyForSelectedMicroFamilies: true,
discordOnlyForManualSelection: true,
discordOnlyForExactTrueMicroMatch: true,
manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',



exactTrueMicroFamilyRequired: true,
trueMicroOnly: true,
exactTrueMicroOnly: true,
trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
learningGranularity: LEARNING_GRANULARITY,
parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
selectionGranularity: SELECTION_GRANULARITY,



analyzeMicroFamiliesOnly: true,
learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
symbolExcludedFromFamilyId: true,



observationFirst: true,
observationFirstAnalyze: true,
scannerFingerprintRole: 'METADATA_ONLY',
scannerFingerprintsHiddenFromLearning: true,
scannerFingerprintsMetadataOnly: true,
scannerFingerprintsUsedAsLearningFamily: false,



executionFingerprintRole: 'METADATA_ONLY',
executionFingerprintsHiddenFromLearning: true,
executionFingerprintsMetadataOnly: true,
executionFingerprintsUsedAsLearningFamily: false,



completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
scoringRSource: 'netR',
winsLossesFlatsSource: 'netR',
winrateDefinition: 'netR > 0',
avgRSource: 'netR',
totalRSource: 'netR',
avgCostRShown: true,



currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
currentFitSoftOnly: true,
currentFitBlocksLearning: false,
currentFitBlocksVirtualLearning: false,
currentFitBlocksShadowLearning: false,



bucketGranularity: 'LOW_MID_HIGH',
bucketsCoarseOnly: true,
scannerBucketsDebugOnly: true,
legacy25BucketsDebugOnly: true,
coinNameDebugOnly: true,
hashesDebugOnly: true,



positionTimeStopMin: getPositionTimeStopMin(),



longRiskShape: {
     entryGtZero: true,
     slBelowEntry: true,
     tpAboveEntry: true,
     expression: 'sl < entry < tp'
},
riskTradeSide: TARGET_TRADE_SIDE,
           riskGeometryRule: 'LONG: sl < entry < tp',
           tpHitRule: 'LONG: price >= tp',
           slHitRule: 'LONG: price <= sl',
           grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
           currentRFormula: '(currentPrice - entry) / (entry - initialSl)',



           longExitRules: {
               tp: 'currentPrice >= tp',
               sl: 'currentPrice <= sl',
               timeStop: 'ageSec >= CONFIG.trade.positionTimeStopMin * 60',
               priority: ['TP', 'SL', 'TIME_STOP'],
               grossR: '(exitPrice - entry) / (entry - initialSl)',
               currentR: '(currentPrice - entry) / (entry - initialSl)',
               outcomeSource: 'VIRTUAL'
           }
    };
}



function sanitizePayload(payload = {}) {
    if (!payload || typeof payload !== 'object') return payload;



    const rawActions = extractActions(payload);
    const rawExits = extractVirtualExits(payload);
    const rawPositions = extractOpenPositions(payload);



    const actions = onlyLongRows(rawActions);
    const exits = onlyLongRows(rawExits).map(normalizeExitRow);
    const openPositions = onlyLongRows(rawPositions).map((row) => ({
           ...forceLongRow(row),
           ...buildExitFlags(row)
    }));



    const entryRowsList = actions.filter(isEntryAction);
    const waitRowsList = actions.filter(isWaitAction);



    const actionCounts = countBy([
           ...actions,
           ...exits
    ], actionType);



    const activeMicroFamilyIds = uniqueStrings([
         payload.activeMicroFamilyIds,
         payload.trueMicroFamilyIds,
         payload.selectedMicroFamilyIds
    ]).filter(isExactLongChildTrueMicroId);



    const activeMacroFamilyIds = uniqueStrings([
    payload.activeMacroFamilyIds,
    payload.parentTrueMicroFamilyIds,
    payload.selectedMacroFamilyIds
  ]).filter(isParentLongMicroId);



  return {
    ...payload,



    ...baseFlags(),



    actions,
    actionCounts,
    actionsCount: actions.length,



    virtualActions: actions,
    virtualActionsCount: actions.length,



    entryRows: Array.isArray(payload.entryRows)
      ? entryRowsList.length
      : safeNumber(payload.entryRows ?? payload.entries ?? entryRowsList.length,
entryRowsList.length),



    waitRows: Array.isArray(payload.waitRows)
      ? waitRowsList.length
      : safeNumber(payload.waitRows ?? payload.waits ?? waitRowsList.length,
waitRowsList.length),



    virtualCreatedRows: Array.isArray(payload.virtualCreatedRows)
      ? onlyLongRows(payload.virtualCreatedRows).length
      : safeNumber(
             payload.virtualCreatedRows ??
               payload.shadowCreatedRows ??
               payload.entries ??
               entryRowsList.length,
             entryRowsList.length
      ),



    entryRowsList,
    waitRowsList,
    virtualCreatedRowsList: entryRowsList,



    virtualExits: exits,
    exits,
    realExits: [],
    shadowExits: exits,
    virtualExitsCount: exits.length,
    virtualExitRows: exits.length,
           exitsCount: exits.length,
           realExitsCount: 0,
           realExitRows: 0,
           shadowExitsCount: exits.length,
           shadowExitRows: exits.length,



           openPositions,
           positions: openPositions,
           virtualPositions: openPositions,
           openPositionsCount: openPositions.length,



           activeMicroFamilyIds,
           activeTrueMicroFamilyIds: activeMicroFamilyIds,
           selectedMicroFamilyIds: activeMicroFamilyIds,



           activeMacroFamilyIds,
           activeParentTrueMicroFamilyIds: activeMacroFamilyIds,
           selectedMacroFamilyIds: activeMacroFamilyIds,



           shortActionsBlockedOrIgnored: rawActions.filter(isShortRow).length,
           unknownSideActionsIgnored: rawActions.filter((row) => getSide(row) ===
'UNKNOWN').length,
            shortExitsBlockedOrIgnored: rawExits.filter(isShortRow).length,
            unknownSideExitsIgnored: rawExits.filter((row) => getSide(row) ===
'UNKNOWN').length,



            shortPositionsBlockedOrIgnored: rawPositions.filter(isShortRow).length,
            unknownSidePositionsIgnored: rawPositions.filter((row) => getSide(row)
===
'UNKNOWN').length,



            realTradesOnly: false,
            virtualLearningOnly: true,
            shadowDataMode: 'VIRTUAL_LEARNING_OUTCOMES_COUNTED',



            scannerFingerprintsUsedAsLearningFamily: 0,
            executionFingerprintsUsedAsLearningFamily: 0
       };
}



function buildCliResponse({
       result,
       requested,
       runOptions,
       startedAt
}) {
       const rawPayload = unwrapRunResult(result);
    const payload = sanitizePayload(rawPayload);



    const actions = extractActions(payload);
    const actionCounts = getActionCounts(actions);
    const entries = summarizeEntries(actions);
    const waits = summarizeWaits(actions);
    const exits = summarizeVirtualExits(payload);
    const positions = summarizeOpenPositions(payload);
    const ignoredSides = summarizeIgnoredSides(rawPayload,
extractActions(rawPayload));
    const fingerprintMetadata = summarizeFingerprintMetadata(rawPayload,
extractActions(rawPayload));



    return {
       ok: payload?.ok !== false,
skipped: Boolean(payload?.skipped || payload?.skippedNewEntries),
reason: payload?.reason || null,
skipReason: payload?.skipReason || payload?.reason || null,



source: 'CLI_RUN_TRADE_SYSTEM_LONG_ONLY',
runSource: requested.runSource,



argv: argv(),
requested,
runOptions,



...baseFlags(),



force: Boolean(requested.force),
forceProcessSnapshot: Boolean(requested.forceProcessSnapshot),
monitorOnly: Boolean(requested.monitorOnly),
monitorOpenPositionsFirst: true,
monitorOpenPositions: true,
processScannerSnapshot: !requested.monitorOnly,



runId: payload?.runId || null,

temporalRuntime: runtimeTemporalFlags(),
activeTemporalGenerationId:
  payload?.activeTemporalGenerationId ||
  payload?.temporalGenerationId ||
  payload?.temporalGeneration?.generationId ||
  null,
temporalGeneration: payload?.temporalGeneration || payload?.activeTemporalGeneration || null,
temporalWouldBlockEntries:
  payload?.temporalWouldBlockEntries ?? payload?.temporalWouldBlock ?? null,
wouldPublishWithoutTemporal: payload?.wouldPublishWithoutTemporal ?? null,
finalDiscordEntryAllowed: payload?.finalDiscordEntryAllowed ?? null,
entryPublicationTemporalPolicyOnly: true,
exitPublicationTemporalBlocked: false,

snapshotId: payload?.snapshotId || null,
snapshotCreatedAt: payload?.snapshotCreatedAt || null,
snapshotAgeSec: payload?.snapshotAgeSec ?? null,



skippedNewEntries: Boolean(payload?.skippedNewEntries),



candidates: payload?.candidates ?? payload?.candidatesCount ?? null,
longCandidateCount:
  payload?.longCandidateCount ??
  payload?.targetCandidateCount ??
    payload?.longCandidatesCount ??
    null,



  nonLongCandidateCount:
    payload?.nonLongCandidateCount ??
    payload?.nonTargetCandidateCount ??
          payload?.selectedOppositeCandidateCount ??
          null,



        selectedTargetCandidateCount: payload?.selectedTargetCandidateCount ?? null,
        selectedOppositeCandidateCount: 0,



        processed: payload?.processed ?? null,
        earlyActions: payload?.earlyActions ?? null,



        observationsWritten: payload?.observationsWritten ?? payload?.analyzedRows
??
null,
        analyzedRows: payload?.analyzedRows ?? null,
        analyzedRiskValidRows: payload?.analyzedRiskValidRows ?? null,



        liveRows: payload?.liveRows ?? null,
        actualLiveRows: payload?.actualLiveRows ?? null,
        analyzeInputRows: payload?.analyzeInputRows ?? null,
        observationOnlyRows: payload?.observationOnlyRows ?? null,
        learningOnlyRows: payload?.learningOnlyRows ?? null,
        riskValidRows: payload?.riskValidRows ?? payload?.analyzedRiskValidRows ??
null,
        riskInvalidRows: payload?.riskInvalidRows ?? null,



        entryRows: safeNumber(payload?.entryRows, entries.count),
        waitRows: safeNumber(payload?.waitRows, waits.count),
        virtualCreatedRows: safeNumber(payload?.virtualCreatedRows, entries.count),



        entryRowsList: Array.isArray(payload?.entryRowsList) ? payload.entryRowsList
:
[],
        waitRowsList: Array.isArray(payload?.waitRowsList) ? payload.waitRowsList :
[],
        virtualCreatedRowsList: Array.isArray(payload?.virtualCreatedRowsList) ?
payload.virtualCreatedRowsList : [],



        virtualPositionsOpened:
          payload?.virtualPositionsOpened ??
          payload?.virtualOpenedRows ??
          payload?.shadowCreatedRows ??
        entries.count,



      virtualPositionsSkipped:
        payload?.virtualPositionsSkipped ??
        payload?.virtualSkippedRows ??
        payload?.shadowSkippedRows ??
        null,



      virtualPositionsFailed:
        payload?.virtualPositionsFailed ??
        payload?.virtualFailedRows ??
        payload?.shadowFailedRows ??
        null,



      virtualExits: Array.isArray(payload?.virtualExits) ? payload.virtualExits :
[],
      shadowExits: Array.isArray(payload?.shadowExits) ? payload.shadowExits : [],
      realExits: [],



      virtualExitRows: safeNumber(payload?.virtualExitRows, exits.total),
      shadowExitRows: safeNumber(payload?.shadowExitRows, exits.total),
      realExitRows: 0,



      activeRotationId: payload?.activeRotationId || null,
      activeMicroFamilies: payload?.activeMicroFamilies ??
payload?.activeMicroFamilyIds?.length ?? null,
      activeMacroFamilies: payload?.activeMacroFamilies ??
payload?.activeMacroFamilyIds?.length ?? null,
      activeMicroFamilyIds: Array.isArray(payload?.activeMicroFamilyIds)
        ? payload.activeMicroFamilyIds.filter(isExactLongChildTrueMicroId)
        : [],



      activeTrueMicroFamilyIds: Array.isArray(payload?.activeTrueMicroFamilyIds)
        ? payload.activeTrueMicroFamilyIds.filter(isExactLongChildTrueMicroId)
        : [],



      activeMacroFamilyIds: Array.isArray(payload?.activeMacroFamilyIds)
        ? payload.activeMacroFamilyIds.filter(isParentLongMicroId)
        : [],
         trueMicroOnly: true,
         exactTrueMicroOnly: true,
         manualSelectionOnly: true,
         autoSelectionDisabled: true,



         discordEligibleEntries: payload?.discordEligibleEntries ?? null,
         discordSkippedNotSelected: payload?.discordSkippedNotSelected ?? null,



         actions: actions.length,
         actionCounts,
entries,
waits,
exits,
positions,



closeDebug: {
     positionTimeStopMin: getPositionTimeStopMin(),
     rules: {
             tp: 'currentPrice >= tp',
             sl: 'currentPrice <= sl',
             timeStop: 'ageSec >= CONFIG.trade.positionTimeStopMin * 60',
             priority: ['TP', 'SL', 'TIME_STOP']
     },
     validLongRiskShape: 'entry > 0 && sl < entry && tp > entry',
     riskGeometryRule: 'LONG: sl < entry < tp',
     tpHitRule: 'LONG: price >= tp',
     slHitRule: 'LONG: price <= sl',
     grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
     currentRFormula: '(currentPrice - entry) / (entry - initialSl)',
     openPositionDebugRows: positions.debugRows
},



learningIdentityDebug: {
     requiredTrueMicroSchema: TRUE_MICRO_SCHEMA,
     requiredParentSchema: PARENT_TRUE_MICRO_SCHEMA,
     selectionGranularity: SELECTION_GRANULARITY,
     entriesMissingExact75Child: entries.count - entries.exact75ChildIds.length,
     exitsMissingExact75Child: exits.total - exits.exact75ChildIds.length,
     openPositionsMissingExact75Child: positions.missingExact75Child,
     parentOnlyDoesNotTriggerDiscord: true,
     scannerAndExecutionFingerprintsMetadataOnly: true
},
currentFitDebug: {
        currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
        currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
        currentFitSoftOnly: true,
        currentFitBlocksLearning: false,
        currentFitBlocksVirtualLearning: false,
        currentFitBlocksShadowLearning: false
},



ignoredSides,
fingerprintMetadata,



scannerSnapshotStats: payload?.scannerSnapshotStats || null,
            durationMs: now() - startedAt,



            result: payload
       };
}



function buildCliError({
       error,
       requested,
       runOptions,
       startedAt
}) {
       return {
            ok: false,



            source: 'CLI_RUN_TRADE_SYSTEM_LONG_ONLY',



            argv: argv(),
            requested,
            runOptions,



            ...baseFlags(),



            force: Boolean(requested.force),
            forceProcessSnapshot: Boolean(requested.forceProcessSnapshot),
            monitorOnly: Boolean(requested.monitorOnly),
            monitorOpenPositionsFirst: true,
            monitorOpenPositions: true,



            error: error?.message || String(error),
            stack: error?.stack,



            durationMs: now() - startedAt
    };
}



async function main() {
    const startedAt = now();
    const requested = buildRequestedOptions();
    const runOptions = buildRunOptions(requested);



    try {
            const result = await runTradeSystem(runOptions);



            const response = buildCliResponse({
                 result,
             requested,
             runOptions,
             startedAt
         });



         console.log(JSON.stringify(response, null, 2));



         process.exitCode = response.ok ? 0 : 1;
    } catch (error) {
         console.error(JSON.stringify(
             buildCliError({
                    error,
                    requested,
                    runOptions,
                    startedAt
             }),
             null,
             2
        ));



        process.exitCode = 1;
    }
}



await main();
