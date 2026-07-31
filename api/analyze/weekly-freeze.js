// ================= FILE: api/analyze/weekly-freeze.js =================
import { createHash, randomUUID } from 'node:crypto';
import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import {
  getDurableRedis,
  getJson,
  setJson
} from '../../src/redis.js';
import { withRedisLock } from '../../src/lock.js';
import {
  sideToTradeSide
} from '../../src/utils.js';
import { getWeekMicros } from '../../src/analyze/analyzeEngine.js';
const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const TARGET_SCANNER_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';
const SHORT_NAMESPACE = 'SHORT';
const SHORT_KEY_PREFIX = `${SHORT_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'SHORT_LIVE';
const MEASUREMENT_FIX_VERSION =
  'SHORT_MEASUREMENT_FIX_TRIGGER_BOUNDARY_EXIT_FILL_V2';
const EXIT_FILL_MODEL_VERSION =
  'SHORT_TRIGGER_BOUNDARY_FILL_PLUS_COST_MODEL_V1';
const EMPIRICAL_VETO_POLICY_VERSION =
  'SHORT_EXACT_75_CHILD_NET_EDGE_VETO_V1';
const OUTCOME_MEASUREMENT_GATE_MODE = 'STRICT_EXACT_VERSION';
const EMPIRICAL_VETO_MIN_COMPLETED = 35;
const EMPIRICAL_VETO_MAX_AVG_R = 0;
const TEMPORAL_CONTEXT_VERSION =
  'SHORT_TEMPORAL_CONTEXT_UTC_V2';
const WEEKEND_POLICY_VERSION =
  'SHORT_WEEKEND_DEFAULT_BLOCK_POSITIVE_OVERRIDE_V1';
const SESSION_POLICY_VERSION =
  'SHORT_SESSION_NEGATIVE_VETO_WEEKLY_PROFILE_V1';
const WEEKEND_MODE = 'OBSERVE';
const SESSION_MODE = 'OBSERVE';
const TEMPORAL_STATS_VERSION = 'SHORT_TEMPORAL_FAMILY_STATS_V1';
const TEMPORAL_POLICY_VERSION = 'SHORT_TEMPORAL_NEGATIVE_VETO_WEEKLY_GENERATION_V1';
const TEMPORAL_AGGREGATION_VERSION = 'SHORT_TEMPORAL_CANONICAL_OUTCOME_V1';
const TEMPORAL_GENERATION_VERSION = 'SHORT_TEMPORAL_ROOT_GENERATION_V1';
const TEMPORAL_POLICY_MODES = Object.freeze(['OFF', 'OBSERVE', 'ENFORCE']);
const TEMPORAL_GATE_WINDOW_MAX_OUTCOMES = 50;
const TEMPORAL_GATE_WINDOW_MAX_AGE_DAYS = 180;
const TEMPORAL_VETO_MIN_COMPLETED = 35;
const TEMPORAL_WEEKEND_APPROVAL_MIN_COMPLETED = 50;
const TEMPORAL_VETO_MATERIAL_AVG_R = -0.10;
const TEMPORAL_RECOVERY_MATERIAL_AVG_R = 0.05;
const TEMPORAL_WEEKEND_MATERIAL_AVG_R = 0.10;
const TEMPORAL_FDR_Q_MAX = 0.05;
const TEMPORAL_VETO_CONFIRM_NEW_OUTCOMES = 5;
const TEMPORAL_RECOVERY_START_NEW_OUTCOMES = 10;
const TEMPORAL_RECOVERY_CONFIRM_NEW_OUTCOMES = 5;
const TEMPORAL_WEEKEND_CONFIRM_NEW_OUTCOMES = 10;
const TEMPORAL_CANDIDATE_MAX_FREEZES = 4;
const TEMPORAL_GENERATION_MAX_AGE_DAYS = 14;
const TEMPORAL_WEEKEND_FRESHNESS_DAYS = 45;
const TEMPORAL_VETO_STALE_DAYS = 60;
const TEMPORAL_ACTIVATION_WINDOW_MS = 24 * 60 * 60 * 1000;
const UTC_DAY_NAMES = Object.freeze([
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY'
]);
const SESSION_BUCKETS = Object.freeze([
  'ASIA',
  'EUROPE',
  'US',
  'ASIA_EU_OVERLAP',
  'EU_US_OVERLAP',
  'OFF_HOURS'
]);
const MIN_COMPLETED_ACTIVE_LEARNING = 20;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;
const DEFAULT_LOCK_TTL_SEC = 600;
const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const LEARNING_GRANULARITY =
'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const SHORT_FIXED_SETUP_TYPES = new Set([
  'BREAKOUT',
  'RETEST',
  'SWEEP_REVERSAL',
  'CONTINUATION',
  'COMPRESSION'
]);
const SHORT_FIXED_REGIME_BUCKETS = new Set([
      'TREND',
      'CHOP',
      'SQUEEZE'
]);
const SHORT_CONFIRMATION_PROFILES = new Set([
      'A_STRONG_ALIGN',
      'B_FLOW_ALIGN',
      'C_VOLUME_ALIGN',
      'D_MIXED_OK',
      'E_WEAK_CONTRA'
]);
const SETUP_ORDER = [
      'BREAKOUT',
      'RETEST',
      'SWEEP_REVERSAL',
      'CONTINUATION',
      'COMPRESSION'
];
const REGIME_ORDER = [
      'TREND',
      'CHOP',
      'SQUEEZE'
];
const CONFIRMATION_PROFILE_ORDER = [
      'A_STRONG_ALIGN',
      'B_FLOW_ALIGN',
      'C_VOLUME_ALIGN',
      'D_MIXED_OK',
      'E_WEAK_CONTRA'
];
function now() {
      return Date.now();
}

const REQUEST_QUERY_CACHE = Symbol('SHORT_REQUEST_QUERY_CACHE');
function requestQuery(req = {}) {
    if (req && typeof req === 'object' && req[REQUEST_QUERY_CACHE]) {
        return req[REQUEST_QUERY_CACHE];
    }
    let query = {};
    try {
        const rawUrl = String(req?.url || '/').trim() || '/';
        const parsedUrl = new URL(rawUrl, 'http://localhost');
        query = Object.fromEntries(parsedUrl.searchParams.entries());
    } catch {
        query = {};
    }
    try {
        if (req && typeof req === 'object') {
            Object.defineProperty(req, REQUEST_QUERY_CACHE, {
                value: query,
                enumerable: false,
                configurable: true
            });
        }
    } catch {
        // Some framework request objects are non-extensible. Parsing is still safe.
    }
    return query;
}
function normalizeTimestampMs(value, fallback = now()) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        const safeFallback = Number(fallback);
        return Number.isFinite(safeFallback) && safeFallback > 0
            ? Math.floor(safeFallback)
            : now();
    }
    return numeric < 10_000_000_000
        ? Math.floor(numeric * 1000)
        : Math.floor(numeric);
}
function isoWeekKeyUtc(timestamp) {
    const date = new Date(normalizeTimestampMs(timestamp));
    const target = new Date(Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate()
    ));
    const day = target.getUTCDay() || 7;
    target.setUTCDate(target.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((target - yearStart) / 86_400_000) + 1) / 7);
    return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
function buildTemporalContext(value = now()) {
    const contextTs = normalizeTimestampMs(value, now());
    const date = new Date(contextTs);
    const hourUtc = date.getUTCHours();
    const dayIndex = date.getUTCDay();
    const dayOfWeekUtc = UTC_DAY_NAMES[dayIndex] || 'UNKNOWN';
    const isWeekend = dayIndex === 0 || dayIndex === 6;
    const inAsia = hourUtc >= 0 && hourUtc < 8;
    const inEurope = hourUtc >= 7 && hourUtc < 16;
    const inUs = hourUtc >= 13 && hourUtc < 22;
    const sessionTags = [];
    if (inAsia) sessionTags.push('ASIA');
    if (inEurope) sessionTags.push('EUROPE');
    if (inUs) sessionTags.push('US');
    let primarySessionBucket = 'OFF_HOURS';
    if (inEurope && inUs) primarySessionBucket = 'EU_US_OVERLAP';
    else if (inAsia && inEurope) primarySessionBucket = 'ASIA_EU_OVERLAP';
    else if (inAsia) primarySessionBucket = 'ASIA';
    else if (inEurope) primarySessionBucket = 'EUROPE';
    else if (inUs) primarySessionBucket = 'US';
    return {
        temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
        contextTs,
        hourUtc,
        dayOfWeekUtc,
        dayType: isWeekend ? 'WEEKEND' : 'WEEKDAY',
        isWeekend,
        sessionTags,
        primarySessionBucket,
        sessionOverlap: sessionTags.length > 1,
        offHours: primarySessionBucket === 'OFF_HOURS',
        entryDateUtc: date.toISOString().slice(0, 10),
        isoWeekUtc: isoWeekKeyUtc(contextTs)
    };
}
function parseBooleanFlag(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    if (value === 1 || value === 0) return value === 1;
    const normalized = String(value ?? '').trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on', 'enabled'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'n', 'off', 'disabled'].includes(normalized)) return false;
    return Boolean(fallback);
}
function normalizeTemporalPolicyMode(value, fallback = 'OBSERVE') {
    const normalized = String(value || '').trim().toUpperCase();
    if (TEMPORAL_POLICY_MODES.includes(normalized)) return normalized;
    const fallbackMode = String(fallback || 'OBSERVE').trim().toUpperCase();
    return TEMPORAL_POLICY_MODES.includes(fallbackMode) ? fallbackMode : 'OBSERVE';
}
function temporalConfigSource() {
    const root = typeof CONFIG === 'object' && CONFIG ? CONFIG : {};
    return root.short?.temporal || root.temporal?.short || root.temporal || {};
}
function resolveTemporalControls() {
    const cfg = temporalConfigSource();
    const requestedMode = normalizeTemporalPolicyMode(
        cfg.policyMode ?? cfg.mode ??
        process.env.SHORT_TEMPORAL_POLICY_MODE ??
        process.env.TEMPORAL_POLICY_MODE,
        'OBSERVE'
    );
    const temporalStatsEnabled = parseBooleanFlag(
        cfg.statsEnabled ?? cfg.enabled ??
        process.env.SHORT_TEMPORAL_STATS_ENABLED ??
        process.env.TEMPORAL_STATS_ENABLED,
        true
    );
    return {
        temporalStatsEnabled,
        requestedTemporalPolicyMode: requestedMode,
        temporalPolicyMode: temporalStatsEnabled ? requestedMode : 'OFF',
        temporalConfigurationValid: temporalStatsEnabled || requestedMode === 'OFF'
    };
}
function resolveMarketEventClusterId(row = {}, timestamp = now()) {
    const source = row && typeof row === 'object' ? row : {};
    const explicit = source.marketEventClusterId || source.scannerRunId ||
        source.marketSnapshotId || source.snapshotId || source.marketCycleId ||
        source.scanId || null;
    if (explicit) {
        return `SHORT_EVENT_${String(explicit).trim().replace(/[^A-Za-z0-9:_-]/g, '_')}`;
    }
    const ts = normalizeTimestampMs(timestamp, now());
    const hourBucket = Math.floor(ts / 3_600_000) * 3_600_000;
    return `SHORT_EVENT_HOUR_${new Date(hourBucket).toISOString().slice(0, 13)}:00Z`;
}
function temporalPolicyFlags(value = now()) {
    const temporalContext = (
        value && typeof value === 'object' &&
        value.temporalContextVersion === TEMPORAL_CONTEXT_VERSION
    ) ? value : buildTemporalContext(value);
    const controls = resolveTemporalControls();
    return {
        ...temporalContext,
        temporalContext,
        ...controls,
        temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
        temporalStatsVersion: TEMPORAL_STATS_VERSION,
        temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
        temporalAggregationVersion: TEMPORAL_AGGREGATION_VERSION,
        temporalGenerationVersion: TEMPORAL_GENERATION_VERSION,
        temporalPolicyModes: TEMPORAL_POLICY_MODES,
        temporalGateWindowMaxOutcomes: TEMPORAL_GATE_WINDOW_MAX_OUTCOMES,
        temporalGateWindowMaxAgeDays: TEMPORAL_GATE_WINDOW_MAX_AGE_DAYS,
        temporalVetoMinCompleted: TEMPORAL_VETO_MIN_COMPLETED,
        temporalWeekendApprovalMinCompleted: TEMPORAL_WEEKEND_APPROVAL_MIN_COMPLETED,
        temporalGenerationMaxAgeDays: TEMPORAL_GENERATION_MAX_AGE_DAYS,
        temporalWeekendFreshnessDays: TEMPORAL_WEEKEND_FRESHNESS_DAYS,
        temporalVetoStaleDays: TEMPORAL_VETO_STALE_DAYS,
        weekendMode: controls.temporalPolicyMode,
        weekendPolicyVersion: WEEKEND_POLICY_VERSION,
        weekendLearningAllowed: controls.temporalStatsEnabled,
        weekendVirtualEntryAllowed: true,
        weekendDiscordEntryAllowed: !temporalContext.isWeekend,
        weekendExitMonitoringAllowed: true,
        weekendOutcomeRecordingAllowed: controls.temporalStatsEnabled,
        weekendPolicyObservedOnly: controls.temporalPolicyMode !== 'ENFORCE',
        sessionMode: controls.temporalPolicyMode,
        sessionPolicyVersion: SESSION_POLICY_VERSION,
        sessionLearningAllowed: controls.temporalStatsEnabled,
        sessionVirtualEntryAllowed: true,
        sessionDiscordEntryAllowed: true,
        sessionPolicyObservedOnly: controls.temporalPolicyMode !== 'ENFORCE',
        temporalContextExcludedFromFamilyId: true,
        sessionContextExcludedFromFamilyId: true,
        symbolExcludedFromTemporalFamilyId: true
    };
}
function entryTemporalFields(row = {}) {
    const source = row && typeof row === 'object' ? row : {};
    const entryTs = normalizeTimestampMs(
        source.entryTs ?? source.openedAt ?? source.openTs ??
        source.positionOpenedAt ?? source.createdAt ?? source.signalTs ??
        source.ts ?? now(),
        now()
    );
    const context = buildTemporalContext(entryTs);
    return {
        temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
        entryTs: context.contextTs,
        entryHourUtc: context.hourUtc,
        entryDayOfWeekUtc: context.dayOfWeekUtc,
        entryDayType: context.dayType,
        entryIsWeekend: context.isWeekend,
        entrySessionTags: context.sessionTags,
        entrySessionBucket: context.primarySessionBucket,
        entrySessionOverlap: context.sessionOverlap,
        entryOffHours: context.offHours,
        entryDateUtc: context.entryDateUtc,
        entryIsoWeekUtc: context.isoWeekUtc,
        marketEventClusterId: resolveMarketEventClusterId(source, entryTs)
    };
}
function exitTemporalFields(row = {}) {
    const source = row && typeof row === 'object' ? row : {};
    const rawExitTs = source.exitTs ?? source.closedAt ?? source.closeTs ??
        source.positionClosedAt ?? source.completedAt ?? source.updatedAt ?? null;
    if (rawExitTs === null || rawExitTs === undefined || rawExitTs === '') {
        return {
            exitTs: null,
            exitHourUtc: null,
            exitDayOfWeekUtc: null,
            exitDayType: null,
            exitIsWeekend: null,
            exitSessionTags: [],
            exitSessionBucket: null,
            exitSessionOverlap: false,
            exitOffHours: null,
            exitDateUtc: null,
            exitIsoWeekUtc: null
        };
    }
    const context = buildTemporalContext(rawExitTs);
    return {
        exitTs: context.contextTs,
        exitHourUtc: context.hourUtc,
        exitDayOfWeekUtc: context.dayOfWeekUtc,
        exitDayType: context.dayType,
        exitIsWeekend: context.isWeekend,
        exitSessionTags: context.sessionTags,
        exitSessionBucket: context.primarySessionBucket,
        exitSessionOverlap: context.sessionOverlap,
        exitOffHours: context.offHours,
        exitDateUtc: context.entryDateUtc,
        exitIsoWeekUtc: context.isoWeekUtc
    };
}
function emptyContextStats() {
    return {
         WEEKDAY: {},
         WEEKEND: {}
    };
}
function emptySessionStats() {
    return Object.fromEntries(
         SESSION_BUCKETS.map((bucket) => [bucket, {}])
    );
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
function namespacedShortKey(key, fallback = null) {
         let raw = String(callMaybeKey(key, fallback) || '').trim();
         if (!raw) return null;
         if (raw.startsWith(SHORT_KEY_PREFIX)) return raw;
         if (raw.startsWith('LONG:')) raw = raw.slice('LONG:'.length);
         return `${SHORT_KEY_PREFIX}${raw}`;
}
const SHORT_KEYS = {
         analyze: {
             activeRotation: namespacedShortKey(
                     KEYS.short?.analyze?.activeRotation ||
                       KEYS.analyze?.shortActiveRotation ||
                       KEYS.analyze?.activeRotation,
                     'ANALYZE:ACTIVE_ROTATION'
             ),
             nextRotation: namespacedShortKey(
                     KEYS.short?.analyze?.nextRotation ||
                       KEYS.analyze?.shortNextRotation ||
                       KEYS.analyze?.nextRotation,
                     'ANALYZE:NEXT_ROTATION'
             ),
             rotationValidFrom: namespacedShortKey(
                  KEYS.short?.analyze?.rotationValidFrom ||
                    KEYS.analyze?.shortRotationValidFrom ||
                    KEYS.analyze?.rotationValidFrom,
                  'ANALYZE:ROTATION_VALID_FROM'
             ),
             freezeLock: namespacedShortKey(
                  KEYS.short?.analyze?.freezeLock ||
                    KEYS.analyze?.shortFreezeLock ||
                    KEYS.analyze?.freezeLock,
                  'ANALYZE:WEEKLY_FREEZE_LOCK'
             ),
             activeTemporalGenerationId: namespacedShortKey(
                  KEYS.short?.analyze?.activeTemporalGenerationId ||
                    KEYS.analyze?.shortActiveTemporalGenerationId,
                  'ANALYZE:TEMPORAL:ACTIVE_GENERATION_ID'
             ),
             nextTemporalGenerationId: namespacedShortKey(
                  KEYS.short?.analyze?.nextTemporalGenerationId ||
                    KEYS.analyze?.shortNextTemporalGenerationId,
                  'ANALYZE:TEMPORAL:NEXT_GENERATION_ID'
             ),
             temporalGeneration: (generationId) => namespacedShortKey(
                  null,
                  `ANALYZE:TEMPORAL:GENERATION:${generationId}`
             )
      }
};
function activeRotationKey() {
     return SHORT_KEYS.analyze.activeRotation;
}
function nextRotationKey() {
     return SHORT_KEYS.analyze.nextRotation;
}
function rotationValidFromKey() {
     return SHORT_KEYS.analyze.rotationValidFrom;
}
function freezeLockKey() {
     return SHORT_KEYS.analyze.freezeLock;
}
function taxonomyFlags() {
     return {
          trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
          parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
          childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
          exactTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
         broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
         fixedTaxonomyPreferred: true,
         parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
         learningGranularity: LEARNING_GRANULARITY,
         parentMicroFamilyCount: 15,
         selectableChildMicroFamilyCount: 75,
         setupTypes: SETUP_ORDER,
         regimeBuckets: REGIME_ORDER,
         confirmationProfiles: CONFIRMATION_PROFILE_ORDER,
         parentFamilyFormat: 'MICRO_SHORT_{SETUP}_{REGIME}',
         selectableChildFamilyFormat:
'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',
         exampleParentTrueMicroFamilyId: 'MICRO_SHORT_BREAKOUT_TREND',
         exampleSelectableTrueMicroFamilyId:
'MICRO_SHORT_BREAKOUT_TREND_A_STRONG_ALIGN',
         parentIdsAreMetadataOnly: true,
         parentIdsAreNotSelectable: true,
         selectableIdsAre75ChildOnly: true,
         selectionGranularity: 'EXACT_75_CHILD',
            discordSelectionGranularity: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID'
    };
}
function flags() {
    return {
            ...temporalPolicyFlags(),
            targetTradeSide: TARGET_TRADE_SIDE,
            dashboardSide: TARGET_DASHBOARD_SIDE,
            scannerSide: TARGET_SCANNER_SIDE,
            oppositeTradeSide: OPPOSITE_TRADE_SIDE,
            side: TARGET_DASHBOARD_SIDE,
            tradeSide: TARGET_TRADE_SIDE,
         positionSide: TARGET_TRADE_SIDE,
         direction: TARGET_TRADE_SIDE,
         shortOnly: true,
         longDisabled: true,
         longOnly: false,
         shortDisabled: false,
         weeklyFreezeDisabled: false,
         weeklyFreezeBuildDisabled: false,
         nextRotationBuildDisabled: true,
         temporalGenerationBuildEnabled: true,
         temporalRotationSelectionUnchanged: true,
         nextRotationOnly: false,
         activeRotationPreserved: true,
         activeRotationWriteBlocked: true,
         nextRotationWriteBlocked: true,
         rotationValidFromWriteBlocked: true,
         autoActivationDisabled: true,
         autoRotationDisabled: true,
         activateNextRotationDisabled: true,
         activateFreezeCronDisabled: false,
         resetCronDisabled: true,
         manualSelectionRemainsLeading: true,
         manualSelectionOnly: true,
         manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
         manualSelectionMustUseSelectable75ChildId: true,
         noRealOrders: true,
         realOrdersDisabled: true,
         bitgetOrdersDisabled: true,
         exchangeCallsDisabled: true,
         virtualLearningOnly: true,
virtualLearningForced: true,
virtualOnly: true,
virtualTracked: true,
shadowOnly: false,
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
         measurementFixVersion: MEASUREMENT_FIX_VERSION,
         acceptedOutcomeMeasurementVersion: MEASUREMENT_FIX_VERSION,
         completedCurrentMeasurementOnly: true,
         strictOutcomeMeasurementGate: true,
         legacyOutcomeMeasurementsExcluded: true,
         exitFillModelVersion: EXIT_FILL_MODEL_VERSION,
         empiricalVetoEnabled: true,
         empiricalVetoPolicyVersion: EMPIRICAL_VETO_POLICY_VERSION,
         empiricalVetoMinCompleted: EMPIRICAL_VETO_MIN_COMPLETED,
         empiricalVetoMaxAvgR: EMPIRICAL_VETO_MAX_AVG_R,
globalMaxOpenPositionsBlockDisabled: true,
maxOneOpenPositionPerSymbol: true,
positionTimeStopMinDefault: DEFAULT_POSITION_TIME_STOP_MIN,
shortRiskShape: 'tp < entry < sl',
riskTradeSide: TARGET_TRADE_SIDE,
riskGeometryRule: 'SHORT: tp < entry < sl',
tpRule: 'price <= tp',
slRule: 'price >= sl',
tpHitRule: 'SHORT: price <= tp',
slHitRule: 'SHORT: price >= sl',
grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
currentRFormula: '(entry - currentPrice) / (initialSl - entry)',
currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
currentFitSoftOnly: true,
currentFitBlocksLearning: false,
currentFitBlocksVirtualLearning: false,
currentFitBlocksShadowLearning: false,
scannerFingerprintRole: 'METADATA_ONLY',
scannerFingerprintsMetadataOnly: true,
scannerFingerprintsUsedAsLearningFamily: false,
scannerBucketsDebugMetadataOnly: true,
         legacy25BucketsDebugMetadataOnly: true,
         scannerBucketsAreNotSelectable: true,
         executionFingerprintRole: 'METADATA_ONLY',
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
         ...taxonomyFlags(),
         bucketsCoarseOnly: true,
         bucketGranularity: 'LOW_MID_HIGH',
         discordOnlyForManualSelection: true,
         discordOnlyForSelectedMicroFamilies: true,
         discordOnlyForExactTrueMicroMatch: true,
         discordSelectionRule: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY',
         parentMatchDoesNotTriggerDiscord: true,
         macroMatchDoesNotTriggerDiscord: true,
         persistentLearningKey: PERSISTENT_LEARNING_KEY,
         weekResetDisabled: true,
              isoWeekLearningDisabled: true,
              minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,
              statusRules: {
                   OBSERVING: 'completed == 0',
                   EARLY_OUTCOMES: `completed > 0 && completed <
${MIN_COMPLETED_ACTIVE_LEARNING}`,
                   ACTIVE_LEARNING: `completed >= ${MIN_COMPLETED_ACTIVE_LEARNING}`
              },
              redisNamespace: SHORT_NAMESPACE,
              redisKeyPrefix: SHORT_KEY_PREFIX,
              redisKeysSeparatedFromLongRoot: true,
              longRootTouched: false
         };
}
function rowMeasurementFixVersion(row = {}) {
    return upper(
         row.measurementFixVersion ??
         row.outcomeMeasurementVersion ??
         row.positionMeasurementFixVersion ??
         row.measurementVersion ??
         row.exitMeasurementVersion ??
         ''
    );
}
function rawCompletedOf(row = {}) {
    return Number(
         row.completed ??
         row.outcomeSample ??
         row.virtualCompleted ??
         0
    ) || 0;
}
function currentMeasurementCompletedOf(row = {}) {
    if (rowMeasurementFixVersion(row) !== MEASUREMENT_FIX_VERSION) return 0;
    const completed = rawCompletedOf(row);
    const accepted = Number(row.measurementVersionAcceptedOutcomeCount ??
completed);
    if (!Number.isFinite(accepted)) return completed;
    return Math.max(0, Math.min(completed, accepted));
}
function avgROf(row = {}) {
    const value = Number(
         row.avgR ??
         row.netAvgR ??
         row.averageR ??
         0
    );
    return Number.isFinite(value) ? value : 0;
}
function activationGateFor(row = {}) {
    const completed = currentMeasurementCompletedOf(row);
    if (completed < EMPIRICAL_VETO_MIN_COMPLETED) return 'OBSERVING';
    return avgROf(row) > EMPIRICAL_VETO_MAX_AVG_R
         ? 'PASSED'
         : 'EMPIRICAL_VETO';
}
function learningStatusFor(row = {}) {
    const completed = currentMeasurementCompletedOf(row);
    if (completed === 0) return 'OBSERVING';
    if (completed < MIN_COMPLETED_ACTIVE_LEARNING) return 'EARLY_OUTCOMES';
    if (completed < EMPIRICAL_VETO_MIN_COMPLETED) return 'ACTIVE_LEARNING';
    return activationGateFor(row);
}
function methodNotAllowed(res) {
         res.setHeader('Allow', 'GET, POST');
         return res.status(405).json({
               ok: false,
               error: 'METHOD_NOT_ALLOWED',
               allowed: ['GET', 'POST'],
               ...flags()
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
function getParam(req, body, key, fallback = null) {
    const bodyValue = firstValue(body?.[key], null);
    const queryValue = firstValue(requestQuery(req)?.[key], null);
    if (bodyValue !== null && bodyValue !== '') return bodyValue;
    if (queryValue !== null && queryValue !== '') return queryValue;
    return fallback;
}
function getFreezeLockTtlSec() {
    const ttl = Number(
         CONFIG.short?.analyze?.freezeLockTtlSec ||
           CONFIG.analyze?.shortFreezeLockTtlSec ||
           CONFIG.analyze?.freezeLockTtlSec ||
           DEFAULT_LOCK_TTL_SEC
    );
    if (!Number.isFinite(ttl)) return DEFAULT_LOCK_TTL_SEC;
    if (ttl <= 0) return DEFAULT_LOCK_TTL_SEC;
    return Math.floor(ttl);
}
function getRotationMode(req, body = {}) {
    const raw = String(
         getParam(
           req,
           body,
           'mode',
           'manual'
         ) || 'manual'
    ).trim();
    if (!raw) return 'manual';
    if (inferTradeSideFromText(raw) === OPPOSITE_TRADE_SIDE) return 'manual';
    return raw;
}
function getRequestedWeekKey(req, body = {}) {
    return String(
      getParam(
        req,
        body,
        'weekKey',
        PERSISTENT_LEARNING_KEY
      ) || PERSISTENT_LEARNING_KEY
    ).trim();
}
function getWeekKey() {
    return PERSISTENT_LEARNING_KEY;
}
function getRequestedActiveWeekKey(req, body = {}) {
    const explicit =
      getParam(req, body, 'activeWeekKey', null) ||
      getParam(req, body, 'nextWeekKey', null);
    if (explicit) return String(explicit).trim();
    return PERSISTENT_LEARNING_KEY;
}
function getActiveWeekKey() {
    return PERSISTENT_LEARNING_KEY;
}
function upper(value) {
    return String(value || '').trim().toUpperCase();
}
function cleanSideText(value = '') {
    return upper(value)
      .replaceAll('LONG_DISABLED_FALSE', '')
      .replaceAll('LONGDISABLED_FALSE', '')
        .replaceAll('BLOCK_LONG_FALSE', '')
        .replaceAll('LONG_ENABLED_FALSE', '')
        .replaceAll('LONG_ONLY_FALSE', '')
        .replaceAll('SHORT_DISABLED_FALSE', '')
        .replaceAll('SHORTDISABLED_FALSE', '')
        .replaceAll('BLOCK_SHORT_FALSE', '')
        .replaceAll('SHORT_ENABLED_FALSE', '')
        .replaceAll('SHORT_ONLY_FALSE', '')
        .replaceAll('LONG_DISABLED_SHORT_ONLY', 'SHORT')
        .replaceAll('LONGDISABLED_SHORT_ONLY', 'SHORT')
        .replaceAll('BLOCK_LONG', 'SHORT')
        .replaceAll('LONG_DISABLED', 'SHORT')
          .replaceAll('LONGDISABLED', 'SHORT')
          .replaceAll('SHORT_DISABLED_LONG_ONLY', 'LONG')
          .replaceAll('SHORTDISABLED_LONG_ONLY', 'LONG')
          .replaceAll('BLOCK_SHORT', 'LONG')
          .replaceAll('SHORT_DISABLED', 'LONG')
          .replaceAll('SHORTDISABLED', 'LONG')
          .replaceAll('LONG_ONLY_MODE', 'LONG')
          .replaceAll('LONG_ONLY', 'LONG')
          .replaceAll('LONG-ONLY', 'LONG')
          .replaceAll('SHORT_ONLY_MODE', 'SHORT')
          .replaceAll('SHORT_ONLY', 'SHORT')
          .replaceAll('SHORT-ONLY', 'SHORT');
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
                   if (value && typeof value === 'object') {
                          return [
                               value.trueMicroFamilyId,
                               value.childTrueMicroFamilyId,
                               value.parentTrueMicroFamilyId,
                               value.microFamilyId,
                               value.coarseMicroFamilyId,
                               value.id,
                               value.key
                          ];
                   }
                       return String(value || '').split(/[\s,;\n\r]+/g);
            })
            .map((value) => String(value || '').trim())
            .filter(Boolean)
    )];
}
function firstFiniteNumber(values = []) {
    for (const value of flattenValues(values)) {
          if (value === undefined || value === null || value === '') continue;
          const n = Number(value);
          if (Number.isFinite(n)) return n;
    }
    return null;
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
function normalizeDirectSide(value) {
    const text = cleanSideText(value);
    if (!text) return 'UNKNOWN';
    const converted = sideToTradeSide(text);
    if (converted === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
    if (converted === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
    if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'UP', 'DOWNSIDE'].includes(text)) {
         return TARGET_TRADE_SIDE;
    }
    if (['LONG', 'BULL', 'BULLISH', 'BUY', 'DOWN', 'UPSIDE'].includes(text)) {
         return OPPOSITE_TRADE_SIDE;
    }
    return 'UNKNOWN';
}
function inferTradeSideFromText(value = '') {
    const text = cleanSideText(value);
    if (!text) return 'UNKNOWN';
    const direct = normalizeDirectSide(text);
    if (direct === TARGET_TRADE_SIDE || direct === OPPOSITE_TRADE_SIDE) {
           return direct;
    }
    const shortSignal = hasShortSignal(text);
    const longSignal = hasLongSignal(text);
    if (shortSignal && !longSignal) return TARGET_TRADE_SIDE;
    if (longSignal && !shortSignal) return OPPOSITE_TRADE_SIDE;
    if (shortSignal && longSignal) {
           if (text.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
           if (text.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
    }
    return 'UNKNOWN';
}
function inferRowTradeSide(row = {}) {
    if (typeof row === 'string') return inferTradeSideFromText(row);
const directSources = [
        row.tradeSide,
        row.positionSide,
        row.direction,
        row.signalSide,
        row.scannerSide,
        row.analysisSide,
        row.side,
        row.bias,
       row.marketBias
];
for (const source of directSources) {
       const side = normalizeDirectSide(source);
       if (side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE) {
            return side;
       }
}
const haystack = [
       row.familyId,
       row.family,
       row.baseFamilyId,
       row.parentTrueMicroFamilyId,
       row.childTrueMicroFamilyId,
       row.trueMicroFamilyId,
       row.microFamilyId,
       row.coarseMicroFamilyId,
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
           ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts :
[]),
        ...(Array.isArray(row.executionFingerprintParts) ?
row.executionFingerprintParts : [])
    ]
        .map((value) => String(value || '').trim())
        .filter(Boolean)
        .join('|');
    const textSide = inferTradeSideFromText(haystack);
    if (textSide !== 'UNKNOWN') return textSide;
    if (row.shortOnly === true || row.longDisabled === true) {
        return TARGET_TRADE_SIDE;
    }
    if (row.longOnly === true || row.shortDisabled === true) {
        return OPPOSITE_TRADE_SIDE;
    }
    return 'UNKNOWN';
}
function parseShortTaxonomyMicroId(id = '') {
    const value = upper(id);
    if (!value.startsWith('MICRO_SHORT_')) {
        return {
             valid: false,
             selectable: false,
             isParent: false,
             isChild: false,
             rawId: String(id || '').trim(),
             setup: null,
             regime: null,
             confirmationProfile: null,
             parentTrueMicroFamilyId: null,
             childTrueMicroFamilyId: null,
             trueMicroFamilyId: null,
             trueMicroFamilySchema: null,
             learningGranularity: null
        };
    }
    let body = value.slice('MICRO_SHORT_'.length);
    let confirmationProfile = null;
for (const profile of CONFIRMATION_PROFILE_ORDER) {
    const suffix = `_${profile}`;
    if (body.endsWith(suffix)) {
        confirmationProfile = profile;
        body = body.slice(0, -suffix.length);
        break;
    }
}
let setup = null;
let regime = null;
for (const candidateRegime of REGIME_ORDER) {
    const suffix = `_${candidateRegime}`;
    if (body.endsWith(suffix)) {
        regime = candidateRegime;
        setup = body.slice(0, -suffix.length);
        break;
    }
}
const validParent =
    Boolean(setup) &&
    Boolean(regime) &&
    SHORT_FIXED_SETUP_TYPES.has(setup) &&
    SHORT_FIXED_REGIME_BUCKETS.has(regime);
const validChild =
    validParent &&
    Boolean(confirmationProfile) &&
    SHORT_CONFIRMATION_PROFILES.has(confirmationProfile);
const parentTrueMicroFamilyId = validParent
    ? `MICRO_SHORT_${setup}_${regime}`
    : null;
const childTrueMicroFamilyId = validChild
    ? `${parentTrueMicroFamilyId}_${confirmationProfile}`
    : null;
return {
    valid: validParent || validChild,
    selectable: validChild,
    isParent: validParent && !validChild,
           isChild: validChild,
           rawId: String(id || '').trim(),
           setup,
           regime,
           confirmationProfile,
           parentTrueMicroFamilyId,
           childTrueMicroFamilyId,
           trueMicroFamilyId: childTrueMicroFamilyId || parentTrueMicroFamilyId,
           trueMicroFamilySchema: validChild ? CHILD_TRUE_MICRO_SCHEMA : validParent
?
PARENT_TRUE_MICRO_SCHEMA : null,
           learningGranularity: validChild ? LEARNING_GRANULARITY : validParent ?
PARENT_LEARNING_GRANULARITY : null
    };
}
function isParentShortTaxonomyMicroId(id = '') {
    const parsed = parseShortTaxonomyMicroId(id);
    return parsed.valid && parsed.isParent;
}
function isChildShortTaxonomyMicroId(id = '') {
    const parsed = parseShortTaxonomyMicroId(id);
    return parsed.valid && parsed.isChild;
}
function isSelectable75ChildId(id = '') {
    return parseShortTaxonomyMicroId(id).selectable === true;
}
function isScannerFingerprintId(id = '') {
    const value = upper(id);
    return (
         value.startsWith('MICRO_SHORT_SCANNER__') ||
         value.includes('MICRO_SHORT_SCANNER__') ||
         value.startsWith('SHORT_SCANNER_') ||
         value.includes('SHORT_SCANNER_') ||
         value.startsWith('MICRO_LONG_SCANNER__') ||
         value.includes('MICRO_LONG_SCANNER__') ||
         value.startsWith('LONG_SCANNER_') ||
         value.includes('LONG_SCANNER_') ||
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
function getMicroFamilyId(row = {}, fallback = null) {
    return (
         row.trueMicroFamilyId ||
         row.childTrueMicroFamilyId ||
         row.microFamilyId ||
         row.id ||
         row.key ||
         fallback ||
         null
    );
}
function getCoarseMicroFamilyId(row = {}, fallback = null) {
    return (
         row.parentTrueMicroFamilyId ||
         row.coarseMicroFamilyId ||
         row.baseMicroFamilyId ||
         row.legacyMicroFamilyId ||
         row.trueMicroFamilyId ||
         row.microFamilyId ||
         fallback ||
         null
    );
}
function getMacroFamilyId(row = {}) {
    return (
         row.parentTrueMicroFamilyId ||
         row.parentMacroFamilyId ||
         row.macroFamilyId ||
         row.parentMicroFamilyId ||
         row.parentFamilyId ||
         row.macroId ||
         row.familyId ||
         null
    );
}
function resolveTaxonomyIds(row = {}, fallback = null) {
    const candidate = getMicroFamilyId(row, fallback);
    const parsedCandidate = parseShortTaxonomyMicroId(candidate);
    const parentCandidate =
         row.parentTrueMicroFamilyId ||
         row.coarseMicroFamilyId ||
         row.parentMacroFamilyId ||
         row.macroFamilyId ||
         null;
    const parsedParent = parseShortTaxonomyMicroId(parentCandidate);
    const parentTrueMicroFamilyId =
         parsedCandidate.parentTrueMicroFamilyId ||
         parsedParent.parentTrueMicroFamilyId ||
         null;
    const childTrueMicroFamilyId =
         parsedCandidate.childTrueMicroFamilyId ||
         row.childTrueMicroFamilyId ||
         null;
    const trueMicroFamilyId =
         childTrueMicroFamilyId ||
         parsedCandidate.trueMicroFamilyId ||
         candidate ||
         null;
    return {
         parsedCandidate,
         parsedParent,
         parentTrueMicroFamilyId,
         childTrueMicroFamilyId,
         trueMicroFamilyId,
         selectableTrueMicroFamilyId: Boolean(childTrueMicroFamilyId &&
isSelectable75ChildId(childTrueMicroFamilyId)),
         fixedTaxonomyLearningId: Boolean(parsedCandidate.valid ||
parsedParent.valid)
    };
}
function isShortRow(row = {}) {
    const taxonomy = resolveTaxonomyIds(row);
    const id = taxonomy.trueMicroFamilyId;
    if (!id) return false;
    if (!validLearningId(id)) return false;
    if (!taxonomy.selectableTrueMicroFamilyId) return false;
    return inferRowTradeSide({
         ...row,
         trueMicroFamilyId: id,
         childTrueMicroFamilyId: taxonomy.childTrueMicroFamilyId,
         parentTrueMicroFamilyId: taxonomy.parentTrueMicroFamilyId
    }) !== OPPOSITE_TRADE_SIDE;
}
function isLongRow(row = {}) {
    return inferRowTradeSide(row) === OPPOSITE_TRADE_SIDE;
}
function isAllowedShortChildId(id = '') {
    const value = String(id || '').trim();
    if (!value) return false;
    if (!validLearningId(value)) return false;
    if (!isSelectable75ChildId(value)) return false;
    return inferTradeSideFromText(value) !== OPPOSITE_TRADE_SIDE;
}
function isAllowedParentId(id = '') {
    const value = String(id || '').trim();
    if (!value) return false;
    if (!validLearningId(value)) return false;
    if (!isParentShortTaxonomyMicroId(value)) return false;
    return inferTradeSideFromText(value) !== OPPOSITE_TRADE_SIDE;
}
function learningStatus(row = {}) {
    return learningStatusFor(row);
}
function currentFitLabel(score = 0, fallback = 'UNKNOWN') {
    if (!Number.isFinite(score)) return fallback || 'UNKNOWN';
    if (score >= 45) return 'FIT';
    if (score >= 20) return 'OK';
    if (score <= -20) return 'MISFIT';
    return 'NEUTRAL';
}
function marketBiasHaystack(row = {}) {
    return [
        row.currentMarketTrendSide,
        row.marketTrendSide,
        row.trendSide,
        row.dashboardSide,
        row.marketSide,
        row.marketBias,
        row.bias,
        row.direction,
        row.currentRegime,
        row.marketRegime,
        row.regime,
        row.currentFitReason,
        ...(Array.isArray(row.currentFitReasons) ? row.currentFitReasons : [])
    ]
        .map((value) => upper(value))
        .join(' | ');
}
function getShortCurrentFit(row = {}) {
    const explicitShort = firstFiniteNumber([
        row.shortCurrentFit,
        row.bearCurrentFit,
        row.currentFitShort,
        row.currentFitBear,
           row.shortFitScore,
      row.bearFitScore
]);
if (explicitShort !== null) {
      return {
            score: explicitShort,
            label: currentFitLabel(explicitShort, row.currentFit || 'UNKNOWN'),
            source: 'EXPLICIT_SHORT_OR_BEAR_CURRENT_FIT'
      };
}
const explicitLong = firstFiniteNumber([
      row.longCurrentFit,
      row.bullCurrentFit,
      row.bullishCurrentFit,
      row.currentFitLong,
      row.currentFitBull,
      row.longFitScore,
      row.bullFitScore
]);
if (explicitLong !== null) {
      const score = -Math.abs(explicitLong);
      return {
            score,
            label: currentFitLabel(score, row.currentFit || 'UNKNOWN'),
            source: 'INVERTED_LONG_OR_BULL_CURRENT_FIT'
      };
}
const rawFit = firstFiniteNumber([
      row.currentFitScore,
      row.fitScore,
      row.marketFitScore,
      row.marketFit,
      row.currentFitNumeric
]);
if (rawFit === null) {
    return {
            score: 0,
            label: row.currentFit || row.currentFitLabel || 'UNKNOWN',
            source: 'NO_NUMERIC_CURRENT_FIT'
    };
}
    const haystack = marketBiasHaystack(row);
    let score;
    if (
            haystack.includes('BEAR') ||
            haystack.includes('BEARISH') ||
            haystack.includes('SHORT') ||
            haystack.includes('SELL') ||
            haystack.includes('DOWNSIDE')
    ) {
            score = Math.abs(rawFit);
    } else if (
            haystack.includes('BULL') ||
            haystack.includes('BULLISH') ||
            haystack.includes('LONG') ||
            haystack.includes('BUY') ||
            haystack.includes('UPSIDE')
    ) {
            score = -Math.abs(rawFit);
    } else {
            score = -rawFit;
    }
    return {
            score,
            label: currentFitLabel(score, row.currentFit || row.currentFitLabel ||
'UNKNOWN'),
            source: 'SHORT_MIRRORED_GENERIC_CURRENT_FIT'
    };
}
function forceShortRow(row = {}, index = 0) {
    const taxonomy = resolveTaxonomyIds(row, row.microFamilyId || row.id ||
row.key);
    const rawInferredTradeSide = inferRowTradeSide(row);
    const currentFit = getShortCurrentFit(row);
    const trueMicroFamilyId = taxonomy.trueMicroFamilyId;
    const childTrueMicroFamilyId = taxonomy.childTrueMicroFamilyId;
    const parentTrueMicroFamilyId = taxonomy.parentTrueMicroFamilyId;
    return {
         ...row,
         rank: Number.isFinite(Number(row.rank))
           ? Number(row.rank)
           : index + 1,
    microFamilyId: trueMicroFamilyId,
    trueMicroFamilyId,
    analyzeMicroFamilyId: trueMicroFamilyId,
    learningMicroFamilyId: trueMicroFamilyId,
    childTrueMicroFamilyId,
    coarseMicroFamilyId: parentTrueMicroFamilyId,
    parentTrueMicroFamilyId,
    macroFamilyId: parentTrueMicroFamilyId,
    parentMacroFamilyId: parentTrueMicroFamilyId,
    parentMicroFamilyId: parentTrueMicroFamilyId,
    ...flags(),
    fixedTaxonomyLearningId: taxonomy.fixedTaxonomyLearningId,
    parentFixedTaxonomyLearningId: Boolean(parentTrueMicroFamilyId &&
isParentShortTaxonomyMicroId(parentTrueMicroFamilyId)),
    childFixedTaxonomyLearningId: Boolean(childTrueMicroFamilyId &&
isChildShortTaxonomyMicroId(childTrueMicroFamilyId)),
    selectableTrueMicroFamilyId: taxonomy.selectableTrueMicroFamilyId,
    trueMicroFamilySchema: taxonomy.selectableTrueMicroFamilyId
        ? CHILD_TRUE_MICRO_SCHEMA
        : row.trueMicroFamilySchema || null,
    parentTrueMicroFamilySchema: parentTrueMicroFamilyId ?
PARENT_TRUE_MICRO_SCHEMA : null,
    childTrueMicroFamilySchema: childTrueMicroFamilyId ? CHILD_TRUE_MICRO_SCHEMA :
null,
    rawInferredTradeSide,
    inferredTradeSide: rawInferredTradeSide === 'UNKNOWN'
        ? TARGET_TRADE_SIDE
        : rawInferredTradeSide,
    inferredFromShortOnlyMode: rawInferredTradeSide === 'UNKNOWN',
    currentFit: currentFit.label,
    currentFitLabel: currentFit.label,
    currentFitScore: currentFit.score,
    fitScore: currentFit.score,
    currentFitSource: currentFit.source,
    shortCurrentFit: currentFit.score,
    bearCurrentFit: currentFit.score,
    bullishCurrentFit: -Math.abs(currentFit.score),
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
         riskTradeSide: TARGET_TRADE_SIDE,
         riskGeometryRule: 'SHORT: tp < entry < sl',
         tpHitRule: 'SHORT: price <= tp',
         slHitRule: 'SHORT: price >= sl',
         grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
         currentRFormula: '(entry - currentPrice) / (initialSl - entry)',
         learningStatus: learningStatusFor(row),
         status: learningStatusFor(row),
         activationGate: activationGateFor(row),
         empiricalVeto: activationGateFor(row) === 'EMPIRICAL_VETO',
         manualActivationEligible: activationGateFor(row) === 'PASSED',
         measurementFixVersion: rowMeasurementFixVersion(row) ||
MEASUREMENT_FIX_VERSION,
         acceptedOutcomeMeasurementVersion: MEASUREMENT_FIX_VERSION,
         contextStats: row.contextStats || emptyContextStats(),
         sessionStats: row.sessionStats || emptySessionStats(),
         tooEarly: Number(row.completed || row.outcomeSample || 0) <
MIN_COMPLETED_ACTIVE_LEARNING,
         tooEarlyReason: Number(row.completed || row.outcomeSample || 0) <
MIN_COMPLETED_ACTIVE_LEARNING
           ? `COMPLETED_BELOW_${MIN_COMPLETED_ACTIVE_LEARNING}`
           : null,
         realCompleted: 0,
         realWins: 0,
         realLosses: 0,
            realFlats: 0,
            realTotalR: 0,
            avgCostR: Number(row.avgCostR || 0),
            scannerFingerprintRole: 'METADATA_ONLY',
            scannerFingerprintsMetadataOnly: true,
            scannerFingerprintsUsedAsLearningFamily: false,
            executionFingerprintRole: 'METADATA_ONLY',
            executionFingerprintsMetadataOnly: true,
            executionFingerprintsUsedAsLearningFamily: false,
            bestLong: null
    };
}
function buildManualRow(id, index = 0) {
    const parsed = parseShortTaxonomyMicroId(id);
    return forceShortRow({
            microFamilyId: parsed.childTrueMicroFamilyId || id,
            trueMicroFamilyId: parsed.childTrueMicroFamilyId || id,
            childTrueMicroFamilyId: parsed.childTrueMicroFamilyId || id,
            familyId: null,
            macroFamilyId: parsed.parentTrueMicroFamilyId,
         parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
         parentMacroFamilyId: parsed.parentTrueMicroFamilyId,
         parentMicroFamilyId: parsed.parentTrueMicroFamilyId,
         coarseMicroFamilyId: parsed.parentTrueMicroFamilyId,
         source: 'STORED_ID_ONLY',
         selectedTier: 'MANUAL',
         rotationEligibilityTier: 'MANUAL',
      seen: 0,
      observations: 0,
      completed: 0,
      virtualCompleted: 0,
      shadowCompleted: 0,
      realCompleted: 0,
      wins: 0,
      losses: 0,
      flats: 0,
      totalR: 0,
      avgR: 0,
      totalCostR: 0,
      avgCostR: 0,
      fixedTaxonomyLearningId: true,
      parentFixedTaxonomyLearningId: true,
      childFixedTaxonomyLearningId: true,
      selectableTrueMicroFamilyId: true,
      trueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
      parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
      childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
      definitionParts: [
             `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
             'STORED_ID_ONLY=true',
             'EXACT_TRUE_MICRO_FAMILY_ID=true',
             'EXACT_75_CHILD=true'
      ],
      definition: `TRADE_SIDE=${TARGET_TRADE_SIDE} | STORED_ID_ONLY=true |
EXACT_TRUE_MICRO_FAMILY_ID=true | EXACT_75_CHILD=true`
    }, index);
}
function shortIdsFromRows(rows = []) {
    return uniqueStrings(
           rows
             .filter(isShortRow)
             .map((row) => row.trueMicroFamilyId || row.microFamilyId)
             .filter(Boolean)
    ).filter(isAllowedShortChildId);
}
function shortParentIdsFromRows(rows = []) {
    return uniqueStrings(
          rows
            .filter(isShortRow)
            .map((row) => row.parentTrueMicroFamilyId || getMacroFamilyId(row))
            .filter(Boolean)
    ).filter(isAllowedParentId);
}
function filterShortChildIds(ids = []) {
    return uniqueStrings(ids).filter(isAllowedShortChildId);
}
function filterShortParentIds(ids = []) {
    return uniqueStrings(ids).filter(isAllowedParentId);
}
function extractRotationFromPayload(payload = {}) {
    if (!payload || typeof payload !== 'object') return null;
    return (
          payload.nextRotation ||
          payload.rotation ||
          payload.result?.nextRotation ||
          payload.result?.rotation ||
          null
    );
}
function explicitMicroIds(rotation = {}) {
    return filterShortChildIds([
          rotation.microFamilyIds,
          rotation.activeMicroFamilyIds,
          rotation.trueMicroFamilyIds,
          rotation.ids,
          rotation.selectedMicroFamilyId,
          rotation.selectedTrueMicroFamilyId,
          rotation.selectedChildTrueMicroFamilyId
    ]);
}
function explicitParentIds(rotation = {}) {
    return filterShortParentIds([
          rotation.parentTrueMicroFamilyIds,
          rotation.macroFamilyIds,
          rotation.activeMacroFamilyIds,
          rotation.macroIds,
          rotation.selectedParentTrueMicroFamilyId,
          rotation.selectedMacroFamilyId
    ]);
}
function buildIndexes(rows = []) {
    const microFamilyIds = shortIdsFromRows(rows);
    const macroFamilyIds = shortParentIdsFromRows(rows);
    const microToMacroFamilyId = {};
    const macroToMicroFamilyIds = {};
    for (const row of rows) {
          const microId = String(row.trueMicroFamilyId || row.microFamilyId ||
row.id ||
'').trim();
          const macroId = String(row.parentTrueMicroFamilyId ||
getMacroFamilyId(row) ||
'').trim();
          if (!microId || !macroId) continue;
          if (!isAllowedShortChildId(microId) || !isAllowedParentId(macroId))
continue;
          microToMacroFamilyId[microId] = macroId;
          if (!macroToMicroFamilyIds[macroId]) {
              macroToMicroFamilyIds[macroId] = [];
          }
          macroToMicroFamilyIds[macroId].push(microId);
    }
    for (const macroId of Object.keys(macroToMicroFamilyIds)) {
         macroToMicroFamilyIds[macroId] =
uniqueStrings(macroToMicroFamilyIds[macroId]);
    }
    return {
         microFamilyIds,
         activeMicroFamilyIds: microFamilyIds,
         trueMicroFamilyIds: microFamilyIds,
         childTrueMicroFamilyIds: microFamilyIds,
          macroFamilyIds,
          activeMacroFamilyIds: macroFamilyIds,
          parentTrueMicroFamilyIds: macroFamilyIds,
          microToMacroFamilyId,
          macroToMicroFamilyIds
    };
}
function normalizeShortRotation(rotation = {}, fallback = {}) {
    if (!rotation || typeof rotation !== 'object') {
          return null;
    }
    const rawRows = Array.isArray(rotation.microFamilies)
          ? rotation.microFamilies
          : [];
    const rowsById = new Map();
    for (const row of rawRows) {
          if (isLongRow(row)) continue;
          const normalized = forceShortRow(row, rowsById.size);
          if (!normalized.trueMicroFamilyId) continue;
          if (!normalized.selectableTrueMicroFamilyId) continue;
          if (!isAllowedShortChildId(normalized.trueMicroFamilyId)) continue;
       rowsById.set(normalized.trueMicroFamilyId, normalized);
  }
  const storedMicroIds = explicitMicroIds(rotation);
  for (const id of storedMicroIds) {
       if (rowsById.has(id)) continue;
       rowsById.set(id, buildManualRow(id, rowsById.size));
  }
  const microFamilies = [...rowsById.values()]
       .filter(isShortRow)
       .filter((row) => isAllowedShortChildId(row.trueMicroFamilyId))
       .filter((row) => activationGateFor(row) === 'PASSED')
       .map((row, index) => forceShortRow({
           ...row,
           rank: index + 1
  }, index));
const rowIndexes = buildIndexes(microFamilies);
const microFamilyIds = rowIndexes.microFamilyIds.length
  ? rowIndexes.microFamilyIds
  : storedMicroIds;
const macroFamilyIds = rowIndexes.macroFamilyIds.length
  ? rowIndexes.macroFamilyIds
  : explicitParentIds(rotation);
const empty = microFamilyIds.length === 0 && microFamilies.length === 0;
return {
  ...fallback,
  ...rotation,
    source: rotation.source || fallback.source ||
'STORED_SHORT_ROTATION_READ_ONLY',
    ...flags(),
    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    exact75ChildOnly: true,
    autoRotation: false,
    manualOnly: rotation.manualOnly !== false,
    adminSelected: Boolean(rotation.adminSelected || rotation.manualOnly),
    activeRotationWriteBlocked: true,
    nextRotationWriteBlocked: true,
    bestShort: microFamilies[0] || null,
    bestLong: null,
    missingSides: empty ? [TARGET_TRADE_SIDE] : [],
    empty,
    emptyReason: empty
      ? rotation.emptyReason || 'NO_SHORT_75_CHILD_TRUE_MICRO_FAMILIES_AVAILABLE'
      : null,
    microFamilies,
    microFamilyIds,
    activeMicroFamilyIds: microFamilyIds,
         trueMicroFamilyIds: microFamilyIds,
         childTrueMicroFamilyIds: microFamilyIds,
         macroFamilyIds,
         activeMacroFamilyIds: macroFamilyIds,
         parentTrueMicroFamilyIds: macroFamilyIds,
          microToMacroFamilyId: rowIndexes.microToMacroFamilyId,
          macroToMicroFamilyIds: rowIndexes.macroToMicroFamilyIds,
          selectedMicroFamilyId: microFamilies[0]?.trueMicroFamilyId ||
rotation.selectedMicroFamilyId || null,
          selectedTrueMicroFamilyId: microFamilies[0]?.trueMicroFamilyId ||
rotation.selectedTrueMicroFamilyId || null,
          selectedChildTrueMicroFamilyId: microFamilies[0]?.childTrueMicroFamilyId
||
microFamilies[0]?.trueMicroFamilyId || null,
          selectedParentTrueMicroFamilyId:
microFamilies[0]?.parentTrueMicroFamilyId ||
rotation.selectedParentTrueMicroFamilyId || null,
          selectedMacroFamilyId: microFamilies[0]?.parentTrueMicroFamilyId ||
rotation.selectedMacroFamilyId || null,
          selectedRow: microFamilies[0] || rotation.selectedRow || null,
          count: microFamilyIds.length || microFamilies.length,
          activeCount: microFamilyIds.length || microFamilies.length,
          childMicroCount: microFamilyIds.length || microFamilies.length,
          parentMicroCount: macroFamilyIds.length,
          rawMicroFamiliesCount: rawRows.length,
          ignoredLongMicroFamilies: rawRows.filter(isLongRow).length,
          ignoredNonSelectableParentRows: rawRows.filter((row) => {
            const id = getMicroFamilyId(row);
            return id && isParentShortTaxonomyMicroId(id);
          }).length,
          ignoredNon75ChildRows: rawRows.filter((row) => {
            const id = getMicroFamilyId(row);
            return id && !isSelectable75ChildId(id);
          }).length
     };
}
function sanitizePayload(payload = {}) {
     if (!payload || typeof payload !== 'object') return payload;
      const rotation = extractRotationFromPayload(payload);
      const sanitizedRotation = rotation
             ? normalizeShortRotation(rotation)
             : null;
      return {
             ...payload,
             ...flags(),
             rotation: sanitizedRotation || null,
             nextRotation: sanitizedRotation || null,
             activeRotation: undefined,
             active: undefined,
             bestShort: sanitizedRotation?.bestShort || null,
             bestLong: null,
             microFamilyIds: sanitizedRotation?.microFamilyIds || [],
             trueMicroFamilyIds: sanitizedRotation?.trueMicroFamilyIds || [],
             childTrueMicroFamilyIds: sanitizedRotation?.childTrueMicroFamilyIds ||
[],
             macroFamilyIds: sanitizedRotation?.macroFamilyIds || [],
             parentTrueMicroFamilyIds: sanitizedRotation?.parentTrueMicroFamilyIds ||
[],
             selectedMicroFamilies: sanitizedRotation?.microFamilyIds?.length || 0,
             selectedChildMicroFamilies:
sanitizedRotation?.childTrueMicroFamilyIds?.length
|| 0,
             selectedMacroFamilies: sanitizedRotation?.macroFamilyIds?.length || 0
      };
}
function unwrapLockResult(lockResult) {
      if (
             lockResult &&
             typeof lockResult === 'object' &&
           Object.prototype.hasOwnProperty.call(lockResult, 'result')
    ) {
           return lockResult.result;
    }
    return lockResult || null;
}
function payloadOk(lockResult, payload) {
    if (lockResult?.ok === false) return false;
    if (payload?.ok === false) return false;
    return true;
}
function responseReason(payload = {}) {
    return (
           payload.reason ||
           payload.emptyReason ||
           payload.rotation?.emptyReason ||
           payload.nextRotation?.emptyReason ||
           null
    );
}
function errorStatus(error) {
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
const TEMPORAL_DAY_ORDER = Object.freeze([
    'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'
]);
function allShortChildFamilyIds() {
    const ids = [];
    for (const setup of SETUP_ORDER) {
        for (const regime of REGIME_ORDER) {
            for (const profile of CONFIRMATION_PROFILE_ORDER) {
                ids.push(`MICRO_SHORT_${setup}_${regime}_${profile}`);
            }
        }
    }
    return ids;
}
function generationKey(generationId) {
    return SHORT_KEYS.analyze.temporalGeneration(generationId);
}
function activeTemporalGenerationIdKey() {
    return SHORT_KEYS.analyze.activeTemporalGenerationId;
}
function nextTemporalGenerationIdKey() {
    return SHORT_KEYS.analyze.nextTemporalGenerationId;
}
function stableCanonicalize(value) {
    if (Array.isArray(value)) return value.map(stableCanonicalize);
    if (!value || typeof value !== 'object') return value;
    return Object.keys(value).sort().reduce((result, key) => {
        result[key] = stableCanonicalize(value[key]);
        return result;
    }, {});
}
function generationChecksum(value) {
    return createHash('sha256')
        .update(JSON.stringify(stableCanonicalize(value)))
        .digest('hex');
}
function finiteOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}
function bucketSource(row, type, name) {
    const temporal = row.temporalProfile || row.temporalFamilyProfile ||
        row.temporalStats || row.temporal || {};
    const candidates = type === 'dayOfWeek'
        ? [temporal.dayOfWeek, temporal.dayOfWeekStats, row.dayOfWeekStats]
        : type === 'session'
            ? [temporal.session, temporal.sessionStats, row.sessionStats]
            : [temporal.dayType, temporal.contextStats, row.contextStats];
    for (const source of candidates) {
        if (source && typeof source === 'object' && source[name]) return source[name];
    }
    return {};
}
function logGamma(value) {
    const coefficients = [
        676.5203681218851,
        -1259.1392167224028,
        771.32342877765313,
        -176.61502916214059,
        12.507343278686905,
        -0.13857109526572012,
        9.9843695780195716e-6,
        1.5056327351493116e-7
    ];
    if (value < 0.5) {
        return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
    }
    let x = 0.99999999999980993;
    const z = value - 1;
    for (let index = 0; index < coefficients.length; index += 1) {
        x += coefficients[index] / (z + index + 1);
    }
    const t = z + coefficients.length - 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
function betaContinuedFraction(a, b, x) {
    const maxIterations = 200;
    const epsilon = 3e-14;
    const fpMin = 1e-300;
    let qab = a + b;
    let qap = a + 1;
    let qam = a - 1;
    let c = 1;
    let d = 1 - qab * x / qap;
    if (Math.abs(d) < fpMin) d = fpMin;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= maxIterations; m += 1) {
        const m2 = 2 * m;
        let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
        d = 1 + aa * d;
        if (Math.abs(d) < fpMin) d = fpMin;
        c = 1 + aa / c;
        if (Math.abs(c) < fpMin) c = fpMin;
        d = 1 / d;
        h *= d * c;
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
        d = 1 + aa * d;
        if (Math.abs(d) < fpMin) d = fpMin;
        c = 1 + aa / c;
        if (Math.abs(c) < fpMin) c = fpMin;
        d = 1 / d;
        const delta = d * c;
        h *= delta;
        if (Math.abs(delta - 1) < epsilon) break;
    }
    return h;
}
function regularizedIncompleteBeta(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const logTerm = logGamma(a + b) - logGamma(a) - logGamma(b) +
        a * Math.log(x) + b * Math.log(1 - x);
    const bt = Math.exp(logTerm);
    if (x < (a + 1) / (a + b + 2)) {
        return bt * betaContinuedFraction(a, b, x) / a;
    }
    return 1 - bt * betaContinuedFraction(b, a, 1 - x) / b;
}
function studentTCdf(t, degreesOfFreedom) {
    if (!Number.isFinite(t)) return t < 0 ? 0 : 1;
    if (!Number.isFinite(degreesOfFreedom) || degreesOfFreedom <= 0) return null;
    if (t === 0) return 0.5;
    const x = degreesOfFreedom / (degreesOfFreedom + t * t);
    const ibeta = regularizedIncompleteBeta(x, degreesOfFreedom / 2, 0.5);
    return t > 0 ? 1 - 0.5 * ibeta : 0.5 * ibeta;
}
function studentTQuantile(probability, degreesOfFreedom) {
    if (!(probability > 0 && probability < 1) || degreesOfFreedom <= 0) return null;
    let low = -50;
    let high = 50;
    for (let iteration = 0; iteration < 120; iteration += 1) {
        const middle = (low + high) / 2;
        const cdf = studentTCdf(middle, degreesOfFreedom);
        if (cdf < probability) low = middle;
        else high = middle;
    }
    return (low + high) / 2;
}
function resolveLastSundayFreezeCutoff(referenceTs = now()) {
    const reference = new Date(normalizeTimestampMs(referenceTs, now()));
    const midnight = Date.UTC(
        reference.getUTCFullYear(),
        reference.getUTCMonth(),
        reference.getUTCDate(),
        22, 0, 0, 0
    );
    const daysSinceSunday = reference.getUTCDay();
    let cutoff = midnight - daysSinceSunday * 86_400_000;
    if (cutoff > reference.getTime()) cutoff -= 7 * 86_400_000;
    return cutoff;
}
function normalizedBucket(row, type, name) {
    const source = bucketSource(row, type, name);
    const gate = source.gateWindowStats || source.gateWindow || source.recent || source;
    const n = Math.min(
        TEMPORAL_GATE_WINDOW_MAX_OUTCOMES,
        Math.max(0, Math.floor(Number(
            gate.gateWindowCompleted ?? gate.completed ?? source.gateWindowCompleted ?? 0
        ) || 0))
    );
    const sumNetR = finiteOrNull(gate.sumNetR ?? gate.gateWindowSumNetR ?? gate.totalR);
    const sumNetR2 = finiteOrNull(gate.sumNetR2 ?? gate.gateWindowSumNetR2);
    const avgNetR = finiteOrNull(gate.avgNetR ?? gate.gateWindowAvgNetR ?? gate.avgR) ??
        (n > 0 && sumNetR !== null ? sumNetR / n : 0);
    let variance = finiteOrNull(gate.variance ?? gate.sampleVariance);
    if (variance === null && n > 1 && sumNetR !== null && sumNetR2 !== null) {
        variance = Math.max(0, (sumNetR2 - n * avgNetR * avgNetR) / (n - 1));
    }
    const standardError = finiteOrNull(gate.standardError ?? gate.se ?? gate.gateWindowSE) ??
        (variance !== null && n > 0 ? Math.sqrt(Math.max(0, variance)) / Math.sqrt(n) : null);
    const degreesOfFreedom = n > 1 ? n - 1 : null;
    const criticalValue = degreesOfFreedom !== null
        ? studentTQuantile(0.95, degreesOfFreedom)
        : null;
    const computedLcb95 = standardError === 0
        ? avgNetR
        : standardError !== null && criticalValue !== null
            ? avgNetR - criticalValue * standardError
            : null;
    const computedUcb95 = standardError === 0
        ? avgNetR
        : standardError !== null && criticalValue !== null
            ? avgNetR + criticalValue * standardError
            : null;
    const lcb95 = finiteOrNull(
        gate.lcb95 ?? gate.gateWindowLCB95 ?? gate.confidenceBound?.lcb95
    ) ?? computedLcb95;
    const ucb95 = finiteOrNull(
        gate.ucb95 ?? gate.gateWindowUCB95 ?? gate.confidenceBound?.ucb95
    ) ?? computedUcb95;
    const tStatistic = standardError === 0
        ? avgNetR < 0 ? Number.NEGATIVE_INFINITY : avgNetR > 0 ? Number.POSITIVE_INFINITY : 0
        : standardError !== null && standardError > 0
            ? avgNetR / standardError
            : null;
    const computedNegativeP = degreesOfFreedom !== null && tStatistic !== null
        ? studentTCdf(tStatistic, degreesOfFreedom)
        : null;
    const computedPositiveP = degreesOfFreedom !== null && tStatistic !== null
        ? 1 - studentTCdf(tStatistic, degreesOfFreedom)
        : null;
    const negativeRawP = finiteOrNull(
        gate.negativeRawPValue ?? gate.rawPValueNegative ??
        gate.rawPValue ?? source.negativeRawPValue
    ) ?? computedNegativeP;
    const positiveRawP = finiteOrNull(
        gate.positiveRawPValue ?? gate.rawPValuePositive ??
        source.positiveRawPValue
    ) ?? computedPositiveP;
    const diversity = source.sampleDiversityDiagnostics || source.diversity || {};
    const eventDiversity = source.marketEventDiversityDiagnostics || source.marketEventDiversity || {};
    const weekendDiversity = source.weekendDiversityDiagnostics || source.weekendDiversity || {};
    const confounding = source.confoundingDiagnostics || source.confounding || {};
    const acceptedTemporalOutcomeSeq = Math.max(0, Math.floor(Number(
        source.acceptedTemporalOutcomeSeq ?? gate.acceptedTemporalOutcomeSeq ?? 0
    ) || 0));
    return {
        bucketType: type,
        bucketName: name,
        gateWindowCompleted: n,
        gateMaturityStatus: n === 0 ? 'OBSERVING' : n < 20 ? 'EARLY_OUTCOMES' : n < 35 ? 'ACTIVE_LEARNING' : 'MATURE',
        sumNetR,
        sumNetR2,
        avgNetR,
        variance,
        standardError,
        degreesOfFreedom,
        tStatistic,
        oneSidedCriticalValue95: criticalValue,
        lcb95,
        ucb95,
        negativeRawPValue: negativeRawP,
        positiveRawPValue: positiveRawP,
        acceptedTemporalOutcomeSeq,
        sampleDiversityPassed: Boolean(
            source.sampleDiversityPassed ?? diversity.guardPassed ??
            diversity.sampleDiversityStatus === 'SUFFICIENT'
        ),
        marketEventDiversityPassed: Boolean(
            source.marketEventDiversityPassed ?? eventDiversity.guardPassed ??
            eventDiversity.marketEventDiversityStatus === 'SUFFICIENT'
        ),
        weekendDiversityPassed: Boolean(
            source.weekendDiversityPassed ??
            weekendDiversity.guardPassed ??
            (weekendDiversity.weekendDiversityStatus === 'SUFFICIENT'
                ? true
                : (source.sampleDiversityPassed ?? diversity.guardPassed ?? false))
        ),
        confoundingGuardPassed: Boolean(
            source.confoundingGuardPassed ?? confounding.guardPassed
        ),
        newestOutcomeTs: finiteOrNull(
            source.newestOutcomeTs ?? gate.newestOutcomeTs ?? source.lastOutcomeTs
        ),
        sampleDiversityDiagnostics: diversity,
        marketEventDiversityDiagnostics: eventDiversity,
        weekendDiversityDiagnostics: weekendDiversity,
        confoundingDiagnostics: confounding
    };
}
function bhAdjusted(tests = []) {
    const ordered = tests
        .filter((test) => Number.isFinite(test.rawPValue) && test.rawPValue >= 0 && test.rawPValue <= 1)
        .sort((a, b) => a.rawPValue - b.rawPValue || a.testId.localeCompare(b.testId));
    const m = ordered.length;
    let running = 1;
    for (let index = m - 1; index >= 0; index -= 1) {
        const rank = index + 1;
        const adjusted = Math.min(1, ordered[index].rawPValue * m / rank);
        running = Math.min(running, adjusted);
        ordered[index].adjustedQValue = running;
    }
    return new Map(ordered.map((test) => [test.testId, test.adjustedQValue]));
}
function weekRows(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== 'object') return [];
    for (const key of ['micros', 'microFamilies', 'rows', 'items', 'data']) {
        if (Array.isArray(payload[key])) return payload[key];
    }
    return Object.values(payload).filter((value) => value && typeof value === 'object' && !Array.isArray(value));
}
function rowFamilyId(row = {}) {
    return String(
        row.childTrueMicroFamilyId || row.trueMicroFamilyId || row.microFamilyId || row.id || ''
    ).trim().toUpperCase();
}
function priorProjectionMap(generation) {
    const projections = generation?.projections && typeof generation.projections === 'object'
        ? generation.projections
        : {};
    return new Map(Object.entries(projections));
}
function candidateAge(previous = {}, freezeSequence) {
    const entered = Number(previous.candidateEnteredFreezeSeq);
    return Number.isFinite(entered) ? Math.max(0, freezeSequence - entered) : 0;
}
function evolveDecision({ bucket, previous = {}, qNegative, qPositive, freezeSequence, isWeekendDay = false }) {
    const previousActive = previous.activeDecision || 'INHERIT_GLOBAL';
    const previousCandidate = previous.candidateDecision || null;
    const seq = bucket.acceptedTemporalOutcomeSeq;
    const age = candidateAge(previous, freezeSequence);
    const normalDiversity = bucket.sampleDiversityPassed && bucket.marketEventDiversityPassed;
    const vetoEvidence = bucket.gateWindowCompleted >= TEMPORAL_VETO_MIN_COMPLETED &&
        bucket.avgNetR <= TEMPORAL_VETO_MATERIAL_AVG_R &&
        bucket.ucb95 !== null && bucket.ucb95 < 0 &&
        Number.isFinite(qNegative) && qNegative <= TEMPORAL_FDR_Q_MAX &&
        normalDiversity && bucket.confoundingGuardPassed;
    const recoveryEvidence = previousActive === 'VETO_ACTIVE' &&
        bucket.gateWindowCompleted >= TEMPORAL_VETO_MIN_COMPLETED &&
        bucket.avgNetR >= TEMPORAL_RECOVERY_MATERIAL_AVG_R &&
        bucket.lcb95 !== null && bucket.lcb95 > 0 &&
        Number.isFinite(qPositive) && qPositive <= TEMPORAL_FDR_Q_MAX &&
        normalDiversity;
    const weekendEvidence = isWeekendDay &&
        bucket.gateWindowCompleted >= TEMPORAL_WEEKEND_APPROVAL_MIN_COMPLETED &&
        bucket.avgNetR >= TEMPORAL_WEEKEND_MATERIAL_AVG_R &&
        bucket.lcb95 !== null && bucket.lcb95 > 0 &&
        Number.isFinite(qPositive) && qPositive <= TEMPORAL_FDR_Q_MAX &&
        bucket.weekendDiversityPassed && bucket.marketEventDiversityPassed;
    let activeDecision = previousActive;
    let candidateDecision = null;
    let candidateEnteredOutcomeSeq = null;
    let candidateEnteredFreezeSeq = null;
    let transitionReason = null;
    if (previousActive === 'VETO_ACTIVE') {
        const newSinceVeto = seq - Number(previous.vetoActivatedOutcomeSeq || seq);
        if (recoveryEvidence && newSinceVeto >= TEMPORAL_RECOVERY_START_NEW_OUTCOMES) {
            const sameCandidate = previousCandidate === 'RECOVERY_CANDIDATE' && age < TEMPORAL_CANDIDATE_MAX_FREEZES;
            const enteredSeq = sameCandidate ? Number(previous.candidateEnteredOutcomeSeq || seq) : seq;
            if (sameCandidate && seq - enteredSeq >= TEMPORAL_RECOVERY_CONFIRM_NEW_OUTCOMES) {
                activeDecision = 'NO_VETO';
                transitionReason = 'RECOVERED_FROM_VETO';
            } else {
                candidateDecision = 'RECOVERY_CANDIDATE';
                candidateEnteredOutcomeSeq = enteredSeq;
                candidateEnteredFreezeSeq = sameCandidate ? previous.candidateEnteredFreezeSeq : freezeSequence;
            }
        }
    } else if (vetoEvidence) {
        const sameCandidate = previousCandidate === 'VETO_CANDIDATE' && age < TEMPORAL_CANDIDATE_MAX_FREEZES;
        const enteredSeq = sameCandidate ? Number(previous.candidateEnteredOutcomeSeq || seq) : seq;
        if (sameCandidate && seq - enteredSeq >= TEMPORAL_VETO_CONFIRM_NEW_OUTCOMES) {
            activeDecision = 'VETO_ACTIVE';
            transitionReason = 'NEGATIVE_TEMPORAL_EDGE_CONFIRMED';
        } else {
            candidateDecision = 'VETO_CANDIDATE';
            candidateEnteredOutcomeSeq = enteredSeq;
            candidateEnteredFreezeSeq = sameCandidate ? previous.candidateEnteredFreezeSeq : freezeSequence;
            if (previousActive === 'INHERIT_GLOBAL') activeDecision = 'NO_VETO';
        }
    } else if (previousActive !== 'VETO_ACTIVE') {
        activeDecision = bucket.gateWindowCompleted >= TEMPORAL_VETO_MIN_COMPLETED ? 'NO_VETO' : 'INHERIT_GLOBAL';
    }
    let weekendApprovalStatus = previous.weekendApprovalStatus || 'NO_APPROVAL';
    let weekendCandidateEnteredOutcomeSeq = previous.weekendCandidateEnteredOutcomeSeq || null;
    let weekendCandidateEnteredFreezeSeq = previous.weekendCandidateEnteredFreezeSeq || null;
    if (isWeekendDay) {
        const stale = bucket.newestOutcomeTs !== null &&
            ((Number(previous.generationCutoffTs || now()) - bucket.newestOutcomeTs) / 86_400_000) > TEMPORAL_WEEKEND_FRESHNESS_DAYS;
        if (activeDecision === 'VETO_ACTIVE' || bucket.gateWindowCompleted < 50 || stale) {
            weekendApprovalStatus = 'NO_APPROVAL';
            weekendCandidateEnteredOutcomeSeq = null;
            weekendCandidateEnteredFreezeSeq = null;
        } else if (weekendEvidence) {
            const priorCandidate = previous.weekendCandidateDecision === 'WEEKEND_APPROVAL_CANDIDATE' &&
                Number.isFinite(Number(weekendCandidateEnteredFreezeSeq)) &&
                freezeSequence - Number(weekendCandidateEnteredFreezeSeq) < TEMPORAL_CANDIDATE_MAX_FREEZES;
            const enteredSeq = priorCandidate ? Number(weekendCandidateEnteredOutcomeSeq || seq) : seq;
            if (priorCandidate && seq - enteredSeq >= TEMPORAL_WEEKEND_CONFIRM_NEW_OUTCOMES) {
                weekendApprovalStatus = 'WEEKEND_APPROVED';
                weekendCandidateEnteredOutcomeSeq = null;
                weekendCandidateEnteredFreezeSeq = null;
            } else if (weekendApprovalStatus !== 'WEEKEND_APPROVED') {
                weekendApprovalStatus = 'NO_APPROVAL';
                weekendCandidateEnteredOutcomeSeq = enteredSeq;
                weekendCandidateEnteredFreezeSeq = priorCandidate ? weekendCandidateEnteredFreezeSeq : freezeSequence;
            }
        }
    }
    return {
        ...bucket,
        adjustedNegativeQValue: Number.isFinite(qNegative) ? qNegative : null,
        adjustedPositiveQValue: Number.isFinite(qPositive) ? qPositive : null,
        activeDecision,
        candidateDecision,
        candidateEnteredOutcomeSeq,
        candidateEnteredFreezeSeq,
        vetoActivatedOutcomeSeq: activeDecision === 'VETO_ACTIVE'
            ? Number(previous.vetoActivatedOutcomeSeq || seq)
            : null,
        transitionReason,
        weekendApprovalStatus,
        weekendCandidateDecision: isWeekendDay && weekendEvidence && weekendApprovalStatus !== 'WEEKEND_APPROVED'
            ? 'WEEKEND_APPROVAL_CANDIDATE'
            : null,
        weekendCandidateEnteredOutcomeSeq,
        weekendCandidateEnteredFreezeSeq
    };
}
async function readTemporalGeneration(redis, generationId) {
    if (!generationId) return null;
    return getJson(redis, generationKey(generationId), null).catch(() => null);
}
async function buildTemporalGeneration(redis, cutoffTs) {
    const controls = resolveTemporalControls();
    if (!controls.temporalStatsEnabled) {
        return { ok: true, skipped: true, reason: 'TEMPORAL_STATS_DISABLED' };
    }
    const weekPayload = await getWeekMicros(PERSISTENT_LEARNING_KEY).catch(() => ({}));
    const rows = weekRows(weekPayload).filter((row) => isShortRow(row));
    const rowMap = new Map(rows.map((row, index) => {
        const normalized = forceShortRow(row, index);
        return [rowFamilyId(normalized), normalized];
    }));
    const activeId = await getJson(redis, activeTemporalGenerationIdKey(), null).catch(() => null);
    const previousGeneration = await readTemporalGeneration(redis, typeof activeId === 'string' ? activeId : activeId?.generationId);
    const previousMap = priorProjectionMap(previousGeneration);
    const freezeSequence = Math.max(1, Number(previousGeneration?.manifest?.freezeSequence || 0) + 1);
    const familyIds = allShortChildFamilyIds();
    const bucketsByFamily = new Map();
    const negativeTests = [];
    const recoveryTests = [];
    const weekendTests = [];
    for (const familyId of familyIds) {
        const row = rowMap.get(familyId) || buildManualRow(familyId, 0);
        const dayType = {
            WEEKDAY: normalizedBucket(row, 'dayType', 'WEEKDAY'),
            WEEKEND: normalizedBucket(row, 'dayType', 'WEEKEND')
        };
        const dayOfWeek = Object.fromEntries(TEMPORAL_DAY_ORDER.map((name) => [name, normalizedBucket(row, 'dayOfWeek', name)]));
        const session = Object.fromEntries(SESSION_BUCKETS.map((name) => [name, normalizedBucket(row, 'session', name)]));
        bucketsByFamily.set(familyId, { row, dayType, dayOfWeek, session });
        for (const [type, map] of [['dayOfWeek', dayOfWeek], ['session', session]]) {
            for (const [name, bucket] of Object.entries(map)) {
                const testId = `${familyId}|${type}|${name}`;
                if (bucket.gateWindowCompleted >= 35 && bucket.sampleDiversityPassed && bucket.marketEventDiversityPassed && Number.isFinite(bucket.negativeRawPValue)) {
                    negativeTests.push({ testId, rawPValue: bucket.negativeRawPValue });
                }
                const prior = previousMap.get(familyId)?.[type]?.[name] || {};
                if (prior.activeDecision === 'VETO_ACTIVE' && bucket.gateWindowCompleted >= 35 && bucket.sampleDiversityPassed && bucket.marketEventDiversityPassed && Number.isFinite(bucket.positiveRawPValue)) {
                    recoveryTests.push({ testId, rawPValue: bucket.positiveRawPValue });
                }
            }
        }
        for (const name of ['SATURDAY', 'SUNDAY']) {
            const bucket = dayOfWeek[name];
            const testId = `${familyId}|weekend|${name}`;
            if (bucket.gateWindowCompleted >= 50 && bucket.weekendDiversityPassed && bucket.marketEventDiversityPassed && Number.isFinite(bucket.positiveRawPValue)) {
                weekendTests.push({ testId, rawPValue: bucket.positiveRawPValue });
            }
        }
    }
    const qNegative = bhAdjusted(negativeTests);
    const qRecovery = bhAdjusted(recoveryTests);
    const qWeekend = bhAdjusted(weekendTests);
    const projections = {};
    for (const familyId of familyIds) {
        const data = bucketsByFamily.get(familyId);
        const previous = previousMap.get(familyId) || {};
        const dayOfWeek = {};
        for (const name of TEMPORAL_DAY_ORDER) {
            const testId = `${familyId}|dayOfWeek|${name}`;
            const positiveQ = ['SATURDAY', 'SUNDAY'].includes(name)
                ? qWeekend.get(`${familyId}|weekend|${name}`)
                : qRecovery.get(testId);
            dayOfWeek[name] = evolveDecision({
                bucket: data.dayOfWeek[name],
                previous: previous.dayOfWeek?.[name] || {},
                qNegative: qNegative.get(testId),
                qPositive: positiveQ,
                freezeSequence,
                isWeekendDay: ['SATURDAY', 'SUNDAY'].includes(name)
            });
        }
        const session = {};
        for (const name of SESSION_BUCKETS) {
            const testId = `${familyId}|session|${name}`;
            session[name] = evolveDecision({
                bucket: data.session[name],
                previous: previous.session?.[name] || {},
                qNegative: qNegative.get(testId),
                qPositive: qRecovery.get(testId),
                freezeSequence
            });
        }
        projections[familyId] = {
            familyId,
            side: TARGET_TRADE_SIDE,
            taxonomyVersion: CHILD_TRUE_MICRO_SCHEMA,
            sourceGlobalGateAudit: activationGateFor(data.row),
            sourceFamilyStatsCutoffTs: cutoffTs,
            dayType: data.dayType,
            dayOfWeek,
            session,
            weekendOverrides: {
                SATURDAY: dayOfWeek.SATURDAY.weekendApprovalStatus,
                SUNDAY: dayOfWeek.SUNDAY.weekendApprovalStatus
            }
        };
    }
    const generationId = `SHORT_TEMPORAL_${isoWeekKeyUtc(cutoffTs)}_${freezeSequence}_${randomUUID()}`;
    const manifestBase = {
        generationId,
        side: TARGET_TRADE_SIDE,
        generationStatus: 'READY',
        lifecycle: ['BUILDING', 'INTEGRITY_CHECK_RUNNING', 'READY'],
        generationVersion: TEMPORAL_GENERATION_VERSION,
        temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
        temporalStatsVersion: TEMPORAL_STATS_VERSION,
        temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
        temporalAggregationVersion: TEMPORAL_AGGREGATION_VERSION,
        measurementVersion: MEASUREMENT_FIX_VERSION,
        costModelVersion: EXIT_FILL_MODEL_VERSION,
        taxonomyVersion: CHILD_TRUE_MICRO_SCHEMA,
        generationCutoffTs: cutoffTs,
        plannedActivationTs: cutoffTs + 2 * 60 * 60 * 1000,
        activationDeadlineTs: cutoffTs + 2 * 60 * 60 * 1000 + TEMPORAL_ACTIVATION_WINDOW_MS,
        freezeSequence,
        familyCount: familyIds.length,
        eligibleNegativeTests: negativeTests.length,
        eligibleRecoveryTests: recoveryTests.length,
        eligibleWeekendTests: weekendTests.length,
        createdAtTs: now()
    };
    const checksum = generationChecksum({ manifest: manifestBase, projections });
    const generation = {
        manifest: { ...manifestBase, checksum },
        projections,
        fdrBatches: {
            negativeVeto: { eligibleTests: negativeTests.length },
            positiveRecovery: { eligibleTests: recoveryTests.length },
            positiveWeekendApproval: { eligibleTests: weekendTests.length }
        }
    };
    if (familyIds.length !== 75 || Object.keys(projections).length !== 75) {
        generation.manifest.generationStatus = 'INVALID';
        throw Object.assign(new Error('TEMPORAL_GENERATION_FAMILY_COUNT_INVALID'), { statusCode: 500 });
    }
    await setJson(redis, generationKey(generationId), generation);
    await setJson(redis, nextTemporalGenerationIdKey(), {
        generationId,
        status: 'READY',
        generationCutoffTs: cutoffTs,
        activationDeadlineTs: generation.manifest.activationDeadlineTs,
        checksum
    });
    return { ok: true, skipped: false, generation };
}
async function readRotationState(redis) {
       const [activeRotationRaw, nextRotationRaw, validFrom] = await Promise.all([
               getJson(redis, activeRotationKey(), null).catch(() => null),
               getJson(redis, nextRotationKey(), null).catch(() => null),
               getJson(redis, rotationValidFromKey(), null).catch(() => null)
       ]);
       return {
               activeRotationRaw,
               nextRotationRaw,
               validFrom,
               activeRotation: activeRotationRaw
                 ? normalizeShortRotation(activeRotationRaw, {
                      source: activeRotationRaw.source ||
'ACTIVE_SHORT_75_CHILD_ROTATION_READ_ONLY'
                 })
                 : null,
               nextRotation: nextRotationRaw
                 ? normalizeShortRotation(nextRotationRaw, {
                      source: nextRotationRaw.source ||
'NEXT_SHORT_75_CHILD_ROTATION_READ_ONLY'
                 })
                 : null
       };
}
async function runFreeze({ req, body, redis }) {
    const requestedWeekKey = getRequestedWeekKey(req, body);
    const requestedActiveWeekKey = getRequestedActiveWeekKey(req, body);
    const weekKey = getWeekKey();
    const activeWeekKey = getActiveWeekKey();
    const mode = getRotationMode(req, body);
    const state = await readRotationState(redis);
    const requestedCutoff = Number(body?.cutoffTs ?? requestQuery(req)?.cutoffTs);
    const defaultCutoff = resolveLastSundayFreezeCutoff(now());
    const cutoffTs = Number.isFinite(requestedCutoff) && requestedCutoff > 0
        ? normalizeTimestampMs(requestedCutoff)
        : defaultCutoff;
    const temporalBuild = await buildTemporalGeneration(redis, cutoffTs);
    return {
        ok: temporalBuild.ok !== false,
        skipped: Boolean(temporalBuild.skipped),
        type: 'SHORT_TEMPORAL_WEEKLY_GENERATION_FREEZE',
        reason: temporalBuild.reason || null,
        ...flags(),
        weekKey,
        requestedWeekKey,
        activeWeekKey,
        requestedActiveWeekKey,
        mode,
        activeRotation: state.activeRotation,
        nextRotation: state.nextRotation,
        validFrom: state.validFrom,
        rotationWrites: false,
        temporalGenerationBuilt: Boolean(temporalBuild.generation),
        nextTemporalGenerationId: temporalBuild.generation?.manifest?.generationId || null,
        temporalGeneration: temporalBuild.generation ? {
            manifest: temporalBuild.generation.manifest,
            fdrBatches: temporalBuild.generation.fdrBatches
        } : null,
        shortKeys: {
            namespace: SHORT_NAMESPACE,
            prefix: SHORT_KEY_PREFIX,
            activeRotation: activeRotationKey(),
            nextRotation: nextRotationKey(),
            rotationValidFrom: rotationValidFromKey(),
            freezeLock: freezeLockKey(),
            activeTemporalGenerationId: activeTemporalGenerationIdKey(),
            nextTemporalGenerationId: nextTemporalGenerationIdKey()
        },
        writes: {
            activeRotation: false,
            nextRotation: false,
            rotationValidFrom: false,
            temporalGeneration: Boolean(temporalBuild.generation),
            nextTemporalGenerationPointer: Boolean(temporalBuild.generation)
        }
    };
}
async function handleGet(req, res) {
    const startedAt = now();
    const redis = getDurableRedis();
    const state = await readRotationState(redis);
    const activeTemporalPointer = await getJson(redis, activeTemporalGenerationIdKey(), null).catch(() => null);
    const nextTemporalPointer = await getJson(redis, nextTemporalGenerationIdKey(), null).catch(() => null);
    return res.status(200).json({
         ok: true,
         skipped: true,
         reason: 'GET_READ_ONLY_SHORT_WEEKLY_FREEZE_DOES_NOT_BUILD_OR_ACTIVATE',
         ...flags(),
              endpointMode: 'READ_ONLY_FOR_GET',
              cronDisabledExpected: true,
              currentWeekKey: PERSISTENT_LEARNING_KEY,
              nextWeekKey: PERSISTENT_LEARNING_KEY,
              persistentLearningKey: PERSISTENT_LEARNING_KEY,
         activeRotation: state.activeRotation,
         nextRotation: state.nextRotation,
         validFrom: state.validFrom,
         activeTemporalGenerationId: typeof activeTemporalPointer === 'string' ? activeTemporalPointer : activeTemporalPointer?.generationId || null,
         nextTemporalGenerationId: typeof nextTemporalPointer === 'string' ? nextTemporalPointer : nextTemporalPointer?.generationId || null,
         activeRotationId: state.activeRotation?.rotationId || null,
         nextRotationId: state.nextRotation?.rotationId || null,
         activeMicroFamilyIds: state.activeRotation?.microFamilyIds || [],
         activeTrueMicroFamilyIds: state.activeRotation?.trueMicroFamilyIds || [],
         activeChildTrueMicroFamilyIds: state.activeRotation?.childTrueMicroFamilyIds
|| [],
         nextMicroFamilyIds: state.nextRotation?.microFamilyIds || [],
         nextTrueMicroFamilyIds: state.nextRotation?.trueMicroFamilyIds || [],
         nextChildTrueMicroFamilyIds: state.nextRotation?.childTrueMicroFamilyIds ||
[],
         activeMacroFamilyIds: state.activeRotation?.macroFamilyIds || [],
         activeParentTrueMicroFamilyIds:
state.activeRotation?.parentTrueMicroFamilyIds
|| [],
         nextMacroFamilyIds: state.nextRotation?.macroFamilyIds || [],
         nextParentTrueMicroFamilyIds: state.nextRotation?.parentTrueMicroFamilyIds
||
[],
         writes: {
                activeRotation: false,
                nextRotation: false,
                rotationValidFrom: false
         },
           shortKeys: {
                     namespace: SHORT_NAMESPACE,
                     prefix: SHORT_KEY_PREFIX,
                     activeRotation: activeRotationKey(),
                     nextRotation: nextRotationKey(),
                     rotationValidFrom: rotationValidFromKey(),
                     freezeLock: freezeLockKey()
           },
           durationMs: now() - startedAt,
           serverTs: Date.now()
         });
}
async function handlePost(req, res) {
    const startedAt = now();
    const body = await readBody(req);
    const redis = getDurableRedis();
    const lockResult = await withRedisLock(
               redis,
               freezeLockKey(),
               getFreezeLockTtlSec(),
               async () => runFreeze({
                      req,
                      body,
                      redis
               })
    );
    const payload = unwrapLockResult(lockResult);
    const ok = payloadOk(lockResult, payload);
    return res.status(ok ? 200 : 500).json({
               ok,
               skipped: Boolean(payload?.skipped),
               source: 'API_SHORT_TEMPORAL_WEEKLY_GENERATION_FREEZE',
               type: payload?.type || 'SHORT_TEMPORAL_WEEKLY_GENERATION_FREEZE',
         reason: payload?.reason || null,
         ...flags(),
         weekKey: payload?.weekKey || getWeekKey(),
         requestedWeekKey: payload?.requestedWeekKey || getRequestedWeekKey(req,
body),
         queryWeekKeyIgnored: payload?.queryWeekKeyIgnored || null,
         activeWeekKey: payload?.activeWeekKey || getActiveWeekKey(),
         requestedActiveWeekKey: payload?.requestedActiveWeekKey ||
getRequestedActiveWeekKey(req, body),
         requestedActiveWeekKeyIgnored: payload?.requestedActiveWeekKeyIgnored ||
null,
         mode: payload?.mode || getRotationMode(req, body),
         rotationId: payload?.rotationId || null,
         selectedMicroFamilies: payload?.selectedMicroFamilies || 0,
         selectedChildMicroFamilies: payload?.selectedChildMicroFamilies || 0,
         selectedMacroFamilies: payload?.selectedMacroFamilies || 0,
  empty: Boolean(payload?.empty),
  emptyReason: payload?.emptyReason || responseReason(payload),
  microFamilyIds: payload?.microFamilyIds || [],
  trueMicroFamilyIds: payload?.trueMicroFamilyIds || [],
  childTrueMicroFamilyIds: payload?.childTrueMicroFamilyIds || [],
  macroFamilyIds: payload?.macroFamilyIds || [],
  parentTrueMicroFamilyIds: payload?.parentTrueMicroFamilyIds || [],
  activeRotation: payload?.activeRotation || null,
  nextRotation: payload?.nextRotation || null,
  validFrom: payload?.validFrom || null,
  nextRotationPersisted: false,
  temporalGenerationBuilt: Boolean(payload?.temporalGenerationBuilt),
  nextTemporalGenerationId: payload?.nextTemporalGenerationId || null,
  temporalGeneration: payload?.temporalGeneration || null,
    activeProtection: payload?.activeProtection || {
            activeRotationPreserved: true,
            activeRotationWriteAttempted: false,
            activeRotationRestored: false
    },
    writes: {
            activeRotation: false,
            nextRotation: false,
            rotationValidFrom: false
    },
    shortKeys: {
            namespace: SHORT_NAMESPACE,
            prefix: SHORT_KEY_PREFIX,
            activeRotation: activeRotationKey(),
            nextRotation: nextRotationKey(),
            rotationValidFrom: rotationValidFromKey(),
            freezeLock: freezeLockKey()
    },
    result: payload?.result || payload,
    lock: {
            ok: lockResult?.ok !== false,
            skipped: Boolean(lockResult?.skipped),
            reason: lockResult?.reason || null
    },
    durationMs: now() - startedAt,
    serverTs: Date.now()
});
}
export default async function handler(req, res) {
         res.setHeader('Cache-Control', 'no-store, max-age=0');
         res.setHeader('X-Rotation-Target-Side', TARGET_TRADE_SIDE);
         res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
         res.setHeader('X-Short-Only', 'true');
         res.setHeader('X-Long-Disabled', 'true');
    res.setHeader('X-Weekly-Freeze-Disabled', 'false');
    res.setHeader('X-Active-Rotation-Preserved', 'true');
    res.setHeader('X-Auto-Activation-Disabled', 'true');
    res.setHeader('X-Manual-Selection-Match-Mode', 'EXACT_TRUE_MICRO_FAMILY_ID');
    res.setHeader('X-Exact-True-Micro-Only', 'true');
    res.setHeader('X-Exact-True-Micro-Family-Schema', CHILD_TRUE_MICRO_SCHEMA);
    res.setHeader('X-Learning-Granularity', LEARNING_GRANULARITY);
    res.setHeader('X-Discord-Selection-Rule',
'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY');
    res.setHeader('X-Parent-Match-Does-Not-Trigger-Discord', 'true');
    res.setHeader('X-Macro-Match-Does-Not-Trigger-Discord', 'true');
    res.setHeader('X-No-Writes', 'false');
    res.setHeader('X-Manual-Rotation-Writes-Disabled', 'true');
    res.setHeader('X-Temporal-Generation-Write-Enabled', 'true');
    res.setHeader('X-Real-Orders-Disabled', 'true');
    res.setHeader('X-Bitget-Orders-Disabled', 'true');
    res.setHeader('X-Exchange-Calls-Disabled', 'true');
    res.setHeader('X-Virtual-Learning-Forced', 'true');
    res.setHeader('X-Persistent-Learning-Key', PERSISTENT_LEARNING_KEY);
    res.setHeader('X-Redis-Namespace', SHORT_NAMESPACE);
    res.setHeader('X-Long-Root-Touched', 'false');
    res.setHeader('X-Temporal-Context-Version', TEMPORAL_CONTEXT_VERSION);
    res.setHeader('X-Temporal-Stats-Version', TEMPORAL_STATS_VERSION);
    res.setHeader('X-Temporal-Policy-Version', TEMPORAL_POLICY_VERSION);
    res.setHeader('X-Temporal-Aggregation-Version', TEMPORAL_AGGREGATION_VERSION);
    res.setHeader('X-Temporal-Generation-Version', TEMPORAL_GENERATION_VERSION);
    res.setHeader('X-Temporal-Freeze-Enabled', 'true');
    try {
        if (req.method === 'GET') {
              return await handleGet(req, res);
        }
        if (req.method === 'POST') {
              return await handlePost(req, res);
        }
        return methodNotAllowed(res);
    } catch (error) {
        return res.status(errorStatus(error)).json({
              ok: false,
              ...flags(),
              error: error?.message || String(error),
              stack: process.env.NODE_ENV === 'production'
                  ? undefined
                    : error?.stack
            });
    }
}
