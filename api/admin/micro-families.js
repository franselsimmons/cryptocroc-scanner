// ================= FILE: api/admin/micro-families.js =================
import {
 sideToTradeSide,
 safeNumber
} from '../../src/utils.js';
import {
 getDurableRedis,
 getVolatileRedis,
 getJson
} from '../../src/redis.js';
import { getWeekMicros } from '../../src/analyze/analyzeEngine.js';
import { getActiveRotation } from '../../src/analyze/rotationEngine.js';
const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const TARGET_SCANNER_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';
const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';


const TEMPORAL_CONTEXT_VERSION = 'LONG_TEMPORAL_CONTEXT_UTC_V2';
const TEMPORAL_STATS_VERSION = 'LONG_TEMPORAL_FAMILY_STATS_V1';
const TEMPORAL_POLICY_VERSION = 'LONG_TEMPORAL_NEGATIVE_VETO_WEEKLY_GENERATION_V1';
const TEMPORAL_AGGREGATION_VERSION = 'LONG_TEMPORAL_CANONICAL_OUTCOME_V1';
const TEMPORAL_GENERATION_VERSION = 'LONG_TEMPORAL_ROOT_GENERATION_V1';
const WEEKEND_POLICY_VERSION = 'LONG_WEEKEND_POSITIVE_OVERRIDE_V2';
const SESSION_POLICY_VERSION = 'LONG_SESSION_NEGATIVE_VETO_V2';
const WEEKEND_MODE = 'POSITIVE_OVERRIDE';
const SESSION_MODE = 'NEGATIVE_VETO';
const TEMPORAL_POLICY_MODES = Object.freeze(['OFF', 'OBSERVE', 'ENFORCE']);
const TEMPORAL_GENERATION_STATES = Object.freeze([
    'BUILDING',
    'INTEGRITY_CHECK_RUNNING',
    'READY',
    'ACTIVE',
    'SUPERSEDED',
    'INVALID',
    'EXPIRED',
    'ACTIVATION_WINDOW_EXPIRED'
]);
const TEMPORAL_ACTIVE_DECISIONS = Object.freeze([
    'INHERIT_GLOBAL',
    'NO_VETO',
    'VETO_ACTIVE',
    'CONFOUNDED_NO_VETO'
]);
const TEMPORAL_CANDIDATE_DECISIONS = Object.freeze([
    'VETO_CANDIDATE',
    'RECOVERY_CANDIDATE',
    'CONFOUNDED_CANDIDATE',
    'WEEKEND_APPROVAL_CANDIDATE'
]);
const DAY_NAMES_UTC = Object.freeze([
    'SUNDAY',
    'MONDAY',
    'TUESDAY',
    'WEDNESDAY',
    'THURSDAY',
    'FRIDAY',
    'SATURDAY'
]);
const DAY_TYPES = Object.freeze(['WEEKDAY', 'WEEKEND']);
const PRIMARY_SESSION_BUCKETS = Object.freeze([
    'ASIA',
    'ASIA_EU_OVERLAP',
    'EUROPE',
    'EU_US_OVERLAP',
    'US',
    'OFF_HOURS'
]);
const TEMPORAL_GATE_WINDOW_MAX_OUTCOMES = 50;
const TEMPORAL_GATE_WINDOW_MAX_AGE_DAYS = 180;
const TEMPORAL_VETO_MIN_COMPLETED = 35;
const TEMPORAL_WEEKEND_APPROVAL_MIN_COMPLETED = 50;
const TEMPORAL_GENERATION_MAX_AGE_DAYS = 14;
const TEMPORAL_WEEKEND_FRESHNESS_DAYS = 45;
const TEMPORAL_VETO_STALE_DAYS = 60;

function normalizeTimestampMs(value, fallback = Date.now()) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) {
        const fallbackNumber = Number(fallback);
        return Number.isFinite(fallbackNumber) && fallbackNumber > 0
            ? fallbackNumber
            : Date.now();
    }
    return n < 10_000_000_000 ? n * 1000 : n;
}

function firstTemporalValue(row = {}, keys = []) {
    for (const key of keys) {
        const value = row?.[key];
        if (value !== undefined && value !== null && value !== '') return value;
    }
    return null;
}

function normalizeTemporalPolicyMode(value, fallback = 'OBSERVE') {
    const normalized = String(value || '').trim().toUpperCase();
    if (TEMPORAL_POLICY_MODES.includes(normalized)) return normalized;
    const fallbackMode = String(fallback || '').trim().toUpperCase();
    return TEMPORAL_POLICY_MODES.includes(fallbackMode) ? fallbackMode : 'OBSERVE';
}

function normalizeBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
    return fallback;
}

function resolveTemporalStatsEnabled(row = {}) {
    return normalizeBoolean(
        firstTemporalValue(row, [
            'temporalStatsEnabled',
            'TEMPORAL_STATS_ENABLED',
            'longTemporalStatsEnabled'
        ]) ??
        process.env.LONG_TEMPORAL_STATS_ENABLED ??
        process.env.TEMPORAL_STATS_ENABLED,
        true
    );
}

function resolveTemporalPolicyMode(row = {}) {
    const requested = normalizeTemporalPolicyMode(
        firstTemporalValue(row, [
            'temporalPolicyMode',
            'policyMode',
            'TEMPORAL_POLICY_MODE',
            'longTemporalPolicyMode'
        ]) ??
        process.env.LONG_TEMPORAL_POLICY_MODE ??
        process.env.TEMPORAL_POLICY_MODE,
        'OBSERVE'
    );
    return resolveTemporalStatsEnabled(row) ? requested : 'OFF';
}

function buildTemporalContext(timestamp = Date.now()) {
    const contextTs = normalizeTimestampMs(timestamp, Date.now());
    const date = new Date(contextTs);
    const dayIndex = date.getUTCDay();
    const hourUtc = date.getUTCHours();
    const dayOfWeekUtc = DAY_NAMES_UTC[dayIndex] || 'UNKNOWN';
    const isWeekend = dayIndex === 0 || dayIndex === 6;
    const asiaActive = hourUtc >= 0 && hourUtc < 8;
    const europeActive = hourUtc >= 7 && hourUtc < 16;
    const usActive = hourUtc >= 13 && hourUtc < 22;
    const sessionTags = [];
    if (asiaActive) sessionTags.push('ASIA');
    if (europeActive) sessionTags.push('EUROPE');
    if (usActive) sessionTags.push('US');
    let primarySessionBucket = 'OFF_HOURS';
    if (europeActive && usActive) primarySessionBucket = 'EU_US_OVERLAP';
    else if (asiaActive && europeActive) primarySessionBucket = 'ASIA_EU_OVERLAP';
    else if (asiaActive) primarySessionBucket = 'ASIA';
    else if (europeActive) primarySessionBucket = 'EUROPE';
    else if (usActive) primarySessionBucket = 'US';
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
        offHours: sessionTags.length === 0
    };
}

function buildMarketEventClusterId(row = {}, entryTs = Date.now()) {
    const explicit = firstTemporalValue(row, [
        'marketEventClusterId',
        'scannerRunId',
        'marketSnapshotId',
        'snapshotId',
        'marketCycleId',
        'scanRunId'
    ]);
    if (explicit !== null) return String(explicit);
    const ts = normalizeTimestampMs(entryTs, Date.now());
    const hourStartTs = Math.floor(ts / 3_600_000) * 3_600_000;
    return `${TARGET_TRADE_SIDE}:UTC_HOUR:${hourStartTs}`;
}

function buildEntryTemporalContext(row = {}, fallbackTs = Date.now()) {
    const entryTs = normalizeTimestampMs(
        firstTemporalValue(row, [
            'entryTs',
            'openedAt',
            'openTs',
            'entryAt',
            'createdAt',
            'ts'
        ]),
        fallbackTs
    );
    const context = buildTemporalContext(entryTs);
    return {
        entryTs: context.contextTs,
        entryHourUtc: context.hourUtc,
        entryDayOfWeekUtc: context.dayOfWeekUtc,
        entryDayType: context.dayType,
        entryIsWeekend: context.isWeekend,
        entrySessionTags: context.sessionTags,
        entrySessionBucket: context.primarySessionBucket,
        entrySessionOverlap: context.sessionOverlap,
        entryOffHours: context.offHours,
        temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
        marketEventClusterId: buildMarketEventClusterId(row, entryTs)
    };
}

function buildExitTemporalContext(row = {}, fallbackTs = null) {
    const rawExitTs = firstTemporalValue(row, [
        'exitTs',
        'closedAt',
        'closeTs',
        'exitAt',
        'completedAt',
        'outcomeFinalizedTs',
        'updatedAt'
    ]);
    if (rawExitTs === null && fallbackTs === null) {
        return {
            exitTs: null,
            exitHourUtc: null,
            exitDayOfWeekUtc: null,
            exitDayType: null,
            exitIsWeekend: null,
            exitSessionTags: [],
            exitSessionBucket: null,
            exitSessionOverlap: false,
            exitOffHours: null
        };
    }
    const context = buildTemporalContext(
        normalizeTimestampMs(rawExitTs, fallbackTs ?? Date.now())
    );
    return {
        exitTs: context.contextTs,
        exitHourUtc: context.hourUtc,
        exitDayOfWeekUtc: context.dayOfWeekUtc,
        exitDayType: context.dayType,
        exitIsWeekend: context.isWeekend,
        exitSessionTags: context.sessionTags,
        exitSessionBucket: context.primarySessionBucket,
        exitSessionOverlap: context.sessionOverlap,
        exitOffHours: context.offHours
    };
}

function finiteNumber(value, fallback = null) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function firstFiniteTemporal(source = {}, keys = [], fallback = null) {
    for (const key of keys) {
        const value = finiteNumber(source?.[key], null);
        if (value !== null) return value;
    }
    return fallback;
}

function normalizeGateMaturity(completed) {
    const n = Math.max(0, Math.floor(finiteNumber(completed, 0)));
    if (n === 0) return 'OBSERVING';
    if (n < 20) return 'EARLY_OUTCOMES';
    if (n < 35) return 'ACTIVE_LEARNING';
    return 'MATURE';
}

function normalizeActiveTemporalDecision(value, fallback = 'INHERIT_GLOBAL') {
    const normalized = String(value || '').trim().toUpperCase();
    if (TEMPORAL_ACTIVE_DECISIONS.includes(normalized)) return normalized;
    if (normalized === 'EMPIRICAL_VETO' || normalized === 'BLOCKED') return 'VETO_ACTIVE';
    if (normalized === 'PASSED' || normalized === 'ALLOWED') return 'NO_VETO';
    return fallback;
}

function normalizeCandidateTemporalDecision(value) {
    const normalized = String(value || '').trim().toUpperCase();
    return TEMPORAL_CANDIDATE_DECISIONS.includes(normalized) ? normalized : null;
}

function emptyTemporalMetricBucket() {
    return {
        seen: 0,
        observations: 0,
        completed: 0,
        lifetimeCompleted: 0,
        wins: 0,
        losses: 0,
        flats: 0,
        sumNetR: 0,
        sumNetR2: 0,
        totalR: 0,
        avgNetR: 0,
        avgR: 0,
        grossWinR: 0,
        grossLossR: 0,
        profitFactor: 0,
        directSLCount: 0,
        directSLPct: 0,
        totalCostR: 0,
        avgCostR: 0,
        acceptedTemporalOutcomeSeq: 0,
        lastOutcomeTs: null,
        gateWindowCompleted: 0,
        gateMaturityStatus: 'OBSERVING',
        activeTemporalDecision: 'INHERIT_GLOBAL',
        candidateTemporalDecision: null,
        sampleDiversityStatus: 'NOT_EVALUATED',
        marketEventDiversityStatus: 'NOT_EVALUATED',
        confoundingStatus: 'NOT_EVALUATED',
        weekendApprovalStatus: 'NO_APPROVAL',
        vetoStalenessStatus: 'NOT_APPLICABLE',
        temporalStatsVersion: TEMPORAL_STATS_VERSION
    };
}

function normalizeTemporalMetricBucket(value = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
    const lifetime = source.lifetimeStats && typeof source.lifetimeStats === 'object'
        ? source.lifetimeStats
        : source;
    const gateWindow = source.gateWindowStats && typeof source.gateWindowStats === 'object'
        ? source.gateWindowStats
        : source.gateWindow && typeof source.gateWindow === 'object'
            ? source.gateWindow
            : source;
    const completed = Math.max(0, Math.floor(firstFiniteTemporal(lifetime, [
        'lifetimeCompleted',
        'completed'
    ], 0)));
    const observations = Math.max(0, Math.floor(firstFiniteTemporal(lifetime, [
        'observations',
        'seen'
    ], 0)));
    const sumNetR = firstFiniteTemporal(lifetime, ['sumNetR', 'totalR'], 0);
    const sumNetR2 = firstFiniteTemporal(lifetime, ['sumNetR2', 'totalR2'], 0);
    const gateWindowCompleted = Math.max(0, Math.min(
        TEMPORAL_GATE_WINDOW_MAX_OUTCOMES,
        Math.floor(firstFiniteTemporal(gateWindow, [
            'gateWindowCompleted',
            'completed',
            'sample'
        ], 0))
    ));
    const avgNetR = firstFiniteTemporal(gateWindow, ['avgNetR', 'avgR', 'meanNetR'],
        completed > 0 ? sumNetR / completed : 0);
    const output = {
        ...emptyTemporalMetricBucket(),
        seen: Math.max(0, Math.floor(firstFiniteTemporal(lifetime, ['seen', 'observations'], observations))),
        observations,
        completed,
        lifetimeCompleted: completed,
        wins: Math.max(0, Math.floor(firstFiniteTemporal(lifetime, ['wins'], 0))),
        losses: Math.max(0, Math.floor(firstFiniteTemporal(lifetime, ['losses'], 0))),
        flats: Math.max(0, Math.floor(firstFiniteTemporal(lifetime, ['flats'], 0))),
        sumNetR,
        sumNetR2,
        totalR: sumNetR,
        avgNetR,
        avgR: avgNetR,
        grossWinR: firstFiniteTemporal(lifetime, ['grossWinR', 'positiveR'], 0),
        grossLossR: firstFiniteTemporal(lifetime, ['grossLossR', 'negativeR'], 0),
        profitFactor: firstFiniteTemporal(gateWindow, ['profitFactor', 'pf'],
            firstFiniteTemporal(lifetime, ['profitFactor', 'pf'], 0)),
        directSLCount: Math.max(0, Math.floor(firstFiniteTemporal(lifetime, ['directSLCount'], 0))),
        directSLPct: firstFiniteTemporal(gateWindow, ['directSLPct'],
            firstFiniteTemporal(lifetime, ['directSLPct'], 0)),
        totalCostR: firstFiniteTemporal(lifetime, ['totalCostR', 'costR'], 0),
        avgCostR: firstFiniteTemporal(gateWindow, ['avgCostR'],
            firstFiniteTemporal(lifetime, ['avgCostR'], 0)),
        acceptedTemporalOutcomeSeq: Math.max(0, Math.floor(firstFiniteTemporal(source, [
            'acceptedTemporalOutcomeSeq',
            'outcomeSeq',
            'acceptedOutcomeSeq'
        ], 0))),
        lastOutcomeTs: firstFiniteTemporal(lifetime, ['lastOutcomeTs', 'newestOutcomeTs'], null),
        gateWindowCompleted,
        gateMaturityStatus: String(
            gateWindow.gateMaturityStatus ||
            source.gateMaturityStatus ||
            normalizeGateMaturity(gateWindowCompleted)
        ).toUpperCase(),
        activeTemporalDecision: normalizeActiveTemporalDecision(
            source.activeTemporalDecision ||
            source.temporalDecision ||
            source.gate
        ),
        candidateTemporalDecision: normalizeCandidateTemporalDecision(
            source.candidateTemporalDecision ||
            source.candidateDecision ||
            source.nextTemporalDecision
        ),
        sampleDiversityStatus: String(
            source.sampleDiversityStatus ||
            source.sampleDiversityDiagnostics?.status ||
            'NOT_EVALUATED'
        ).toUpperCase(),
        marketEventDiversityStatus: String(
            source.marketEventDiversityStatus ||
            source.marketEventDiversityDiagnostics?.status ||
            'NOT_EVALUATED'
        ).toUpperCase(),
        confoundingStatus: String(
            source.confoundingStatus ||
            source.confoundingDiagnostics?.status ||
            'NOT_EVALUATED'
        ).toUpperCase(),
        weekendApprovalStatus: String(
            source.weekendApprovalStatus ||
            source.weekendApproval?.status ||
            'NO_APPROVAL'
        ).toUpperCase(),
        vetoStalenessStatus: String(
            source.vetoStalenessStatus ||
            source.stalenessStatus ||
            'NOT_APPLICABLE'
        ).toUpperCase(),
        temporalStatsVersion: String(
            source.temporalStatsVersion ||
            TEMPORAL_STATS_VERSION
        )
    };
    const derived = {
        variance: firstFiniteTemporal(gateWindow, ['variance', 'sampleVariance'], null),
        stddev: firstFiniteTemporal(gateWindow, ['stddev', 'standardDeviation'], null),
        standardError: firstFiniteTemporal(gateWindow, ['standardError', 'se'], null),
        lcb95: firstFiniteTemporal(gateWindow, ['lcb95', 'lowerConfidenceBound'], null),
        ucb95: firstFiniteTemporal(gateWindow, ['ucb95', 'upperConfidenceBound'], null),
        rawPValue: firstFiniteTemporal(gateWindow, ['rawPValue', 'pValue'], null),
        adjustedQValue: firstFiniteTemporal(gateWindow, ['adjustedQValue', 'qValue'], null),
        gateWindowOldestOutcomeTs: firstFiniteTemporal(gateWindow, ['gateWindowOldestOutcomeTs', 'oldestOutcomeTs'], null),
        gateWindowNewestOutcomeTs: firstFiniteTemporal(gateWindow, ['gateWindowNewestOutcomeTs', 'newestOutcomeTs'], null),
        distinctEntryDates: firstFiniteTemporal(source, ['distinctEntryDates'], null),
        distinctIsoWeeks: firstFiniteTemporal(source, ['distinctIsoWeeks'], null),
        distinctSymbols: firstFiniteTemporal(source, ['distinctSymbols'], null),
        dominantDateShare: firstFiniteTemporal(source, ['dominantDateShare', 'maxDayShare'], null),
        dominantSymbolShare: firstFiniteTemporal(source, ['dominantSymbolShare', 'maxSymbolShare'], null),
        distinctMarketEventClusters: firstFiniteTemporal(source, ['distinctMarketEventClusters'], null),
        dominantMarketEventClusterShare: firstFiniteTemporal(source, ['dominantMarketEventClusterShare', 'maxEventClusterShare'], null),
        dominantMarketEventClusterId: firstTemporalValue(source, ['dominantMarketEventClusterId', 'dominantClusterId']),
        dominantLossShare: firstFiniteTemporal(source, ['dominantLossShare'], null),
        candidateEnteredOutcomeSeq: firstFiniteTemporal(source, ['candidateEnteredOutcomeSeq', 'candidateEnteredAtSeq'], null),
        vetoActivatedOutcomeSeq: firstFiniteTemporal(source, ['vetoActivatedOutcomeSeq', 'vetoActivatedAtSeq'], null),
        candidateEnteredFreezeSeq: firstFiniteTemporal(source, ['candidateEnteredFreezeSeq'], null),
        candidateAgeFreezes: firstFiniteTemporal(source, ['candidateAgeFreezes'], null),
        evaluationBatchId: firstTemporalValue(source, ['evaluationBatchId', 'batchId']),
        activeProfileId: firstTemporalValue(source, ['activeProfileId', 'profileId']),
        blockReasons: Array.isArray(source.blockReasons) ? source.blockReasons : []
    };
    return {
        ...output,
        ...derived,
        lifetimeStats: {
            observations: output.observations,
            completed: output.completed,
            wins: output.wins,
            losses: output.losses,
            flats: output.flats,
            sumNetR: output.sumNetR,
            sumNetR2: output.sumNetR2,
            grossWinR: output.grossWinR,
            grossLossR: output.grossLossR,
            totalCostR: output.totalCostR,
            directSLCount: output.directSLCount,
            acceptedTemporalOutcomeSeq: output.acceptedTemporalOutcomeSeq,
            lastOutcomeTs: output.lastOutcomeTs
        },
        gateWindowStats: {
            gateWindowCompleted: output.gateWindowCompleted,
            gateMaturityStatus: output.gateMaturityStatus,
            avgNetR: output.avgNetR,
            variance: derived.variance,
            stddev: derived.stddev,
            standardError: derived.standardError,
            lcb95: derived.lcb95,
            ucb95: derived.ucb95,
            rawPValue: derived.rawPValue,
            adjustedQValue: derived.adjustedQValue,
            oldestOutcomeTs: derived.gateWindowOldestOutcomeTs,
            newestOutcomeTs: derived.gateWindowNewestOutcomeTs
        }
    };
}

function normalizeTemporalGeneration(value = {}, fallbackStatus = 'MISSING') {
    const source = value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
    const generationId = firstTemporalValue(source, [
        'generationId',
        'activeTemporalGenerationId',
        'profileId',
        'id'
    ]);
    const statusRaw = String(
        source.status ||
        source.generationStatus ||
        fallbackStatus
    ).toUpperCase();
    const status = TEMPORAL_GENERATION_STATES.includes(statusRaw)
        ? statusRaw
        : statusRaw;
    const generationCutoffTs = firstFiniteTemporal(source, [
        'generationCutoffTs',
        'profileCutoffTs',
        'cutoffTs'
    ], null);
    const referenceTs = Date.now();
    const ageDays = generationCutoffTs === null
        ? null
        : Math.max(0, (referenceTs - generationCutoffTs) / 86_400_000);
    return {
        generationId: generationId === null ? null : String(generationId),
        status,
        side: String(source.side || TARGET_TRADE_SIDE).toUpperCase(),
        generationCutoffTs,
        ageDays,
        expired: ageDays !== null && ageDays > TEMPORAL_GENERATION_MAX_AGE_DAYS,
        temporalPolicyVersion: String(source.temporalPolicyVersion || TEMPORAL_POLICY_VERSION),
        temporalAggregationVersion: String(source.temporalAggregationVersion || TEMPORAL_AGGREGATION_VERSION),
        generationVersion: String(source.generationVersion || TEMPORAL_GENERATION_VERSION),
        measurementVersion: firstTemporalValue(source, ['measurementVersion', 'measurementFixVersion']),
        costModelVersion: firstTemporalValue(source, ['costModelVersion', 'exitFillModelVersion']),
        taxonomyVersion: firstTemporalValue(source, ['taxonomyVersion', 'trueMicroFamilySchema']),
        familyCount: firstFiniteTemporal(source, ['familyCount', 'projectionCount'], null),
        checksum: firstTemporalValue(source, ['checksum', 'checksumJson']),
        freezeSequence: firstFiniteTemporal(source, ['freezeSequence', 'freezeSeq'], null),
        sourceRotationId: firstTemporalValue(source, ['sourceRotationId', 'rotationId']),
        validFromTs: firstFiniteTemporal(source, ['validFromTs', 'activatedAtTs'], null),
        validUntilTs: firstFiniteTemporal(source, ['validUntilTs', 'validUntil'], null),
        integrityOk: normalizeBoolean(source.integrityOk, false),
        projectionAvailable: generationId !== null
    };
}

function normalizeTemporalStats(row = {}) {
    const temporalRoot = row.temporalStats && typeof row.temporalStats === 'object'
        ? row.temporalStats
        : row.temporalProfile && typeof row.temporalProfile === 'object'
            ? row.temporalProfile
            : {};
    const contextSource = temporalRoot.dayType || row.contextStats || row.dayTypeStats || {};
    const dayOfWeekSource = temporalRoot.dayOfWeek || row.dayOfWeekStats || {};
    const sessionSource = temporalRoot.session || row.sessionStats || row.primarySessionStats || {};
    const dayType = Object.fromEntries(DAY_TYPES.map((bucket) => [
        bucket,
        normalizeTemporalMetricBucket(contextSource[bucket])
    ]));
    const dayOfWeek = Object.fromEntries(DAY_NAMES_UTC.map((bucket) => [
        bucket,
        normalizeTemporalMetricBucket(dayOfWeekSource[bucket])
    ]));
    const session = Object.fromEntries(PRIMARY_SESSION_BUCKETS.map((bucket) => [
        bucket,
        normalizeTemporalMetricBucket(sessionSource[bucket])
    ]));
    const available = Boolean(
        row.temporalStats ||
        row.temporalProfile ||
        row.contextStats ||
        row.dayTypeStats ||
        row.dayOfWeekStats ||
        row.sessionStats ||
        row.primarySessionStats ||
        row.activeTemporalGeneration ||
        row.activeTemporalProfile ||
        row.activeTemporalGenerationId
    );
    const activeGenerationSource = row.activeTemporalGeneration ||
        row.activeTemporalProfile ||
        row.temporalGeneration ||
        row.temporal?.activeGeneration ||
        {
            activeTemporalGenerationId: row.activeTemporalGenerationId,
            generationCutoffTs: row.activeTemporalGenerationCutoffTs,
            generationStatus: row.activeTemporalGenerationStatus
        };
    const nextGenerationSource = row.nextTemporalGeneration ||
        row.nextTemporalProfile ||
        row.temporal?.nextGeneration ||
        {
            activeTemporalGenerationId: row.nextTemporalGenerationId,
            generationCutoffTs: row.nextTemporalGenerationCutoffTs,
            generationStatus: row.nextTemporalGenerationStatus
        };
    const temporalStats = {
        temporalStatsVersion: String(row.temporalStatsVersion || temporalRoot.temporalStatsVersion || TEMPORAL_STATS_VERSION),
        temporalAggregationVersion: String(row.temporalAggregationVersion || temporalRoot.temporalAggregationVersion || TEMPORAL_AGGREGATION_VERSION),
        dayType,
        dayOfWeek,
        session
    };
    return {
        temporalStatsAvailable: available,
        temporalStatsSource: available ? 'LONG_TEMPORAL_FAMILY_PROFILE' : 'NOT_YET_AVAILABLE',
        temporalStats,
        dayTypeStats: dayType,
        dayOfWeekStats: dayOfWeek,
        primarySessionStats: session,
        contextStats: dayType,
        sessionStats: session,
        activeTemporalGeneration: normalizeTemporalGeneration(
            activeGenerationSource,
            available ? 'UNKNOWN' : 'MISSING'
        ),
        nextTemporalGeneration: normalizeTemporalGeneration(
            nextGenerationSource,
            'MISSING'
        ),
        temporalGenerationManifest: row.temporalGenerationManifest || row.generationManifest || null,
        temporalIntegrityDiagnostics: row.temporalIntegrityDiagnostics || row.integrityDiagnostics || null,
        temporalAggregationDiagnostics: row.temporalAggregationDiagnostics || null,
        temporalRejectDiagnostics: row.temporalRejectDiagnostics || null,
        temporalPolicyMode: resolveTemporalPolicyMode(row),
        temporalStatsEnabled: resolveTemporalStatsEnabled(row)
    };
}

function temporalProjectionSource(row = {}) {
    return row.activeTemporalProjection ||
        row.temporalProjection ||
        row.activeTemporalProfile ||
        row.activeTemporalGeneration?.projection ||
        row.temporal?.activeProjection ||
        {};
}

function projectedDecision(row = {}, dimension, bucket, fallback = 'INHERIT_GLOBAL') {
    const projection = temporalProjectionSource(row);
    const dimensionMap = dimension === 'dayOfWeek'
        ? projection.dayOfWeekDecisions || projection.dayDecisions || row.dayOfWeekDecisions
        : projection.sessionDecisions || row.sessionDecisions;
    const raw = dimensionMap?.[bucket];
    const value = raw && typeof raw === 'object'
        ? raw.decision || raw.activeTemporalDecision || raw.status
        : raw;
    return normalizeActiveTemporalDecision(value, fallback);
}

function projectedWeekendApproval(row = {}, dayOfWeekUtc) {
    const projection = temporalProjectionSource(row);
    const approvals = projection.weekendOverrides ||
        projection.weekendApprovals ||
        row.weekendOverrides ||
        row.weekendApprovals ||
        {};
    const raw = approvals?.[dayOfWeekUtc];
    if (raw === true) return 'WEEKEND_APPROVED';
    if (raw === false || raw === null || raw === undefined) return 'NO_APPROVAL';
    if (typeof raw === 'object') {
        if (raw.discordAllowed === true || raw.approved === true) return 'WEEKEND_APPROVED';
        return String(raw.status || raw.decision || 'NO_APPROVAL').toUpperCase();
    }
    const normalized = String(raw).toUpperCase();
    return normalized === 'WEEKEND_APPROVED' ? normalized : 'NO_APPROVAL';
}

function temporalRuntimeProjection(row = {}, entry = buildEntryTemporalContext(row)) {
    const policyMode = resolveTemporalPolicyMode(row);
    const dayDecision = projectedDecision(row, 'dayOfWeek', entry.entryDayOfWeekUtc);
    const sessionDecision = projectedDecision(row, 'session', entry.entrySessionBucket);
    const weekendApprovalStatus = entry.entryIsWeekend
        ? projectedWeekendApproval(row, entry.entryDayOfWeekUtc)
        : 'NOT_APPLICABLE';
    const generation = normalizeTemporalStats(row).activeTemporalGeneration;
    const generationUnavailable = Boolean(
        policyMode === 'ENFORCE' &&
        (
            !generation.generationId ||
            generation.expired ||
            ['MISSING', 'INVALID', 'CORRUPT', 'VERSION_INCOMPATIBLE', 'EXPIRED'].includes(
                String(generation.status || '').toUpperCase()
            )
        )
    );
    const blockReasons = [];
    if (generationUnavailable) blockReasons.push('TEMPORAL_GENERATION_UNAVAILABLE');
    if (dayDecision === 'VETO_ACTIVE') blockReasons.push('DAY_VETO_ACTIVE');
    if (sessionDecision === 'VETO_ACTIVE') blockReasons.push('SESSION_VETO_ACTIVE');
    if (entry.entryIsWeekend && weekendApprovalStatus !== 'WEEKEND_APPROVED') {
        blockReasons.push('WEEKEND_DEFAULT_BLOCK');
    }
    const temporalWouldBlock = blockReasons.length > 0;
    return {
        evaluatedDayOfWeek: entry.entryDayOfWeekUtc,
        evaluatedSessionBucket: entry.entrySessionBucket,
        evaluatedIsWeekend: entry.entryIsWeekend,
        dayOfWeekDecision: dayDecision,
        sessionDecision,
        weekendApprovalStatus,
        temporalWouldBlock,
        temporalBlockReasons: blockReasons,
        temporalAllowed: policyMode !== 'ENFORCE' || temporalWouldBlock === false,
        weekendDiscordEntryAllowed: policyMode !== 'ENFORCE' ||
            !entry.entryIsWeekend ||
            weekendApprovalStatus === 'WEEKEND_APPROVED',
        sessionDiscordEntryAllowed: policyMode !== 'ENFORCE' ||
            sessionDecision !== 'VETO_ACTIVE',
        dayDiscordEntryAllowed: policyMode !== 'ENFORCE' ||
            dayDecision !== 'VETO_ACTIVE'
    };
}

function temporalPolicyPayload(timestamp = Date.now(), row = {}) {
    const context = buildTemporalContext(timestamp);
    const statsEnabled = resolveTemporalStatsEnabled(row);
    const requestedMode = normalizeTemporalPolicyMode(
        firstTemporalValue(row, ['temporalPolicyMode', 'policyMode']) ??
        process.env.LONG_TEMPORAL_POLICY_MODE ??
        process.env.TEMPORAL_POLICY_MODE,
        'OBSERVE'
    );
    const effectiveMode = statsEnabled ? requestedMode : 'OFF';
    return {
        temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
        temporalStatsVersion: TEMPORAL_STATS_VERSION,
        temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
        temporalAggregationVersion: TEMPORAL_AGGREGATION_VERSION,
        temporalGenerationVersion: TEMPORAL_GENERATION_VERSION,
        weekendPolicyVersion: WEEKEND_POLICY_VERSION,
        sessionPolicyVersion: SESSION_POLICY_VERSION,
        temporalStatsEnabled: statsEnabled,
        temporalPolicyMode: requestedMode,
        effectiveTemporalPolicyMode: effectiveMode,
        temporalPolicyModes: TEMPORAL_POLICY_MODES,
        ...context,
        temporalGateWindowMaxOutcomes: TEMPORAL_GATE_WINDOW_MAX_OUTCOMES,
        temporalGateWindowMaxAgeDays: TEMPORAL_GATE_WINDOW_MAX_AGE_DAYS,
        temporalVetoMinCompleted: TEMPORAL_VETO_MIN_COMPLETED,
        temporalWeekendApprovalMinCompleted: TEMPORAL_WEEKEND_APPROVAL_MIN_COMPLETED,
        temporalGenerationMaxAgeDays: TEMPORAL_GENERATION_MAX_AGE_DAYS,
        temporalWeekendFreshnessDays: TEMPORAL_WEEKEND_FRESHNESS_DAYS,
        temporalVetoStaleDays: TEMPORAL_VETO_STALE_DAYS,
        weekendLearningAllowed: true,
        weekendVirtualEntryAllowed: true,
        weekendDiscordEntryAllowed: effectiveMode !== 'ENFORCE' || !context.isWeekend,
        weekendExitMonitoringAllowed: true,
        weekendOutcomeRecordingAllowed: true,
        sessionLearningAllowed: true,
        sessionVirtualEntryAllowed: true,
        sessionDiscordEntryAllowed: true,
        temporalPolicyObservedOnly: effectiveMode === 'OBSERVE',
        temporalPolicyEnforced: effectiveMode === 'ENFORCE',
        temporalPolicyOff: effectiveMode === 'OFF',
        weekendBlocksNewDiscordEntriesOnly: true,
        existingPositionMonitoringNeverBlockedByWeekend: true,
        temporalContextExcludedFromFamilyId: true,
        sessionContextExcludedFromFamilyId: true,
        temporalContextUsesUtcOnly: true,
        temporalRuntimeFormula: "wouldPublishWithoutTemporal && (mode !== 'ENFORCE' || !temporalWouldBlock)",
        temporalVirtualLearningNeverBlocked: true,
        temporalExitPublicationNeverBlocked: true
    };
}

function temporalRowPayload(row = {}, fallbackTs = Date.now()) {
    const contextTs = normalizeTimestampMs(
        firstTemporalValue(row, [
            'contextTs',
            'entryTs',
            'openedAt',
            'createdAt',
            'ts',
            'updatedAt'
        ]),
        fallbackTs
    );
    const context = buildTemporalContext(contextTs);
    const entry = buildEntryTemporalContext(row, contextTs);
    const exit = buildExitTemporalContext(row, null);
    return {
        ...temporalPolicyPayload(contextTs, row),
        ...context,
        ...entry,
        ...exit,
        ...normalizeTemporalStats(row),
        ...temporalRuntimeProjection(row, entry)
    };
}

const MARKET_WEATHER_KEY = 'MARKET:WEATHER:LATEST';
const LONG_MARKET_WEATHER_KEY = `${LONG_KEY_PREFIX}MARKET:WEATHER:LATEST`;
const MARKET_UNIVERSE_KEY = 'MARKET:UNIVERSE:LATEST';
const LONG_MARKET_UNIVERSE_KEY = `${LONG_KEY_PREFIX}MARKET:UNIVERSE:LATEST`;
const LONG_TRADE_RUN_META_KEY = `${LONG_KEY_PREFIX}TRADE:RUN_META`;
const MARKET_WEATHER_READ_KEYS = Object.freeze([
    LONG_MARKET_WEATHER_KEY,
    MARKET_WEATHER_KEY,
    LONG_MARKET_UNIVERSE_KEY,
    MARKET_UNIVERSE_KEY,
    LONG_TRADE_RUN_META_KEY
]);
const SHOW_SCANNER_FINGERPRINT_LEGACY_FALLBACK = false;
const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = TRUE_MICRO_SCHEMA;
const LEARNING_GRANULARITY =
'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const MEASUREMENT_FIX_VERSION =
'LONG_MEASUREMENT_FIX_TRIGGER_BOUNDARY_EXIT_FILL_V2';
const PREVIOUS_MEASUREMENT_FIX_VERSION =
'LONG_MEASUREMENT_FIX_AVGCOST_DIRECTSL_SEEN_DEDUPE_V1';
const EXIT_FILL_MODEL_VERSION = 'LONG_TRIGGER_BOUNDARY_FILL_PLUS_COST_MODEL_V1';
const OUTCOME_MEASUREMENT_GATE_MODE = 'STRICT_EXACT_VERSION';
const ADAPTIVE_UI_VERSION =
'LONG_ADAPTIVE_UI_MARKETWEATHER_CURRENTFIT_MEASUREMENT_GATE_EMPIRICAL_VETO_RANKING_TEMPORAL_V4';
const CURRENT_FIT_VERSION = 'LONG_CURRENTFIT_MARKETWEATHER_SOFT_V2';
const LONG_FIXED_SETUP_TYPES = new Set([
    'BREAKOUT',
    'RETEST',
    'SWEEP_REVERSAL',
    'CONTINUATION',
    'COMPRESSION'
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
const LONG_FIXED_REGIME_BUCKETS = new Set(REGIME_ORDER);
const CONFIRMATION_PROFILE_ORDER = [
 'A_STRONG_ALIGN',
 'B_FLOW_ALIGN',
 'C_VOLUME_ALIGN',
 'D_MIXED_OK',
 'E_WEAK_CONTRA'
];
const LONG_CONFIRMATION_PROFILES = new Set(CONFIRMATION_PROFILE_ORDER);
const VALID_MODES = new Set([
 'adaptive',
 'balanced',
 'winrate',
 'totalR',
 'avgR',
 'directSL',
 'observed',
 'cost',
 'currentFit'
]);
const WINRATE_Z = 1.96;
const WINRATE_BAYES_ALPHA = 1;
const WINRATE_BAYES_BETA = 1;
const SAMPLE_RELIABILITY_CAP = 50;
const MIN_COMPLETED_ACTIVE_LEARNING = 20;
const EMPIRICAL_VETO_MIN_COMPLETED = 35;
const EMPIRICAL_VETO_MAX_AVG_R = 0;
const EMPIRICAL_VETO_POLICY_VERSION =
 'LONG_EXACT_75_CHILD_NET_EDGE_VETO_V1';
const DEFAULT_LIMIT = 75;
const MAX_LIMIT = 300;
const DEFAULT_SIDE_LIMIT = 75;
const MAX_SIDE_LIMIT = 120;
const DEFAULT_BEST_LIMIT = 75;
const MAX_BEST_LIMIT = 100;
const ACTIVE_ROTATION_TIMEOUT_MS = 1_800;
const WEEK_MICROS_TIMEOUT_MS = 9_500;
const MARKET_WEATHER_TIMEOUT_MS = 4_500;
const MARKET_WEATHER_SINGLE_READ_TIMEOUT_MS = 2_500;
const MARKET_WEATHER_CACHE_TTL_MS = 15_000;
const MARKET_WEATHER_NEGATIVE_CACHE_TTL_MS = 3_000;
const CURRENT_FIT_MAX_WEATHER_AGE_SEC = 15 * 60;
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_KEYS = 20;
const cache = globalThis.__ADMIN_MICRO_FAMILIES_LONG_75_CACHE__ ||= {
    weekMicros: new Map(),
    marketWeather: null
};
function now() {
    return Date.now();
}
function methodNotAllowed(res) {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({
         ok: false,
         error: 'METHOD_NOT_ALLOWED',
         allowed: ['GET'],
         ...modePayload()
    });
}
function firstQueryValue(value, fallback = null) {
    if (Array.isArray(value)) return value[0] ?? fallback;
    if (value === undefined || value === null || value === '') return fallback;
    return value;
}
function isTrue(value) {
    return (
         value === true ||
         value === 'true' ||
         value === 'TRUE' ||
         value === 1 ||
         value === '1' ||
         value === 'yes' ||
         value === 'YES' ||
         value === 'on' ||
         value === 'ON'
    );
}
function hasValue(value) {
    return value !== undefined && value !== null && value !== '';
}
function num(value, fallback = 0) {
    const n = safeNumber(value, fallback);
    return Number.isFinite(n) ? n : fallback;
}
function round(value, decimals = 4) {
    return Number(num(value, 0).toFixed(decimals));
}
function clamp(value, min = 0, max = 1) {
    const n = num(value, min);
    if (n < min) return min;
    if (n > max) return max;
    return n;
}
function upper(value) {
    return String(value || '').trim().toUpperCase();
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
function isCurrentMeasurementOutcome(row = {}) {
    return rowMeasurementFixVersion(row) === MEASUREMENT_FIX_VERSION;
}
function measurementAggregateIntegrity(row = {}) {
    const sourceCompleted =
         num(row.virtualCompleted, 0) +
         num(row.shadowCompleted, 0);
    const completed = Math.max(
         sourceCompleted,
         num(row.completed, 0),
         num(row.outcomeSample, 0),
         0
    );
    const acceptedOutcomeCount = Math.max(
         0,
         num(row.measurementVersionAcceptedOutcomeCount, 0)
    );
    const recentOutcomes = Array.isArray(row.recentOutcomes)
         ? row.recentOutcomes
         : [];
    const nonCurrentRecentOutcomeCount = recentOutcomes
         .filter((outcome) => !isCurrentMeasurementOutcome(outcome))
         .length;
    const currentVersion =
         rowMeasurementFixVersion(row) === MEASUREMENT_FIX_VERSION;
    return {
         valid:
           currentVersion &&
           (completed <= 0 || acceptedOutcomeCount >= completed) &&
           nonCurrentRecentOutcomeCount === 0,
         currentVersion,
         completed,
         acceptedOutcomeCount,
         recentOutcomeCount: recentOutcomes.length,
         nonCurrentRecentOutcomeCount
    };
}
function legacyOutcomeResetFields() {
    return [
         'completed',
         'outcomeSample',
         'winrateSample',
         'virtualCompleted',
         'shadowCompleted',
         'realCompleted',
         'wins',
         'losses',
         'flats',
         'virtualWins',
         'virtualLosses',
         'virtualFlats',
         'shadowWins',
         'shadowLosses',
         'shadowFlats',
         'realWins',
         'realLosses',
         'realFlats',
         'totalR',
         'netTotalR',
         'longNetTotalR',
         'totalNetR',
         'virtualTotalR',
         'shadowTotalR',
         'realTotalR',
         'totalPnlPct',
         'virtualTotalPnlPct',
         'shadowTotalPnlPct',
         'realTotalPnlPct',
         'totalCostR',
         'virtualTotalCostR',
         'shadowTotalCostR',
         'realTotalCostR',
         'grossWinR',
         'grossLossR',
         'virtualGrossWinR',
         'virtualGrossLossR',
         'shadowGrossWinR',
         'shadowGrossLossR',
         'avgR',
         'avgNetR',
         'netAvgR',
         'avgWinR',
         'avgLossR',
         'profitFactor',
         'winrate',
         'bayesianWinrate',
         'wilsonLowerBound',
         'fairWinrate',
         'sampleAdjustedWinrate',
         'sampleRawWinrate',
         'sampleBayesianWinrate',
         'sampleWilsonLowerBound',
         'sampleReliability',
         'directSLCount',
         'directSLPct',
         'virtualDirectSLCount',
         'shadowDirectSLCount',
         'nearTpCount',
         'nearTpPct',
         'reachedHalfRCount',
         'reachedHalfRPct',
         'reachedOneRCount',
         'reachedOneRPct',
         'beWouldExitCount',
         'beWouldExitPct',
         'gaveBackAfterHalfRCount',
         'gaveBackAfterHalfRPct',
         'gaveBackAfterOneRCount',
         'gaveBackAfterOneRPct',
         'nearTpThenLossCount',
         'nearTpThenLossPct',
         'avgCostR',
         'costR',
         'netCostR',
         'estimatedCostR',
         'balancedScore',
         'dashboardBalancedScore',
         'adaptiveScore',
         'recentMomentumScore'
    ];
}
function sanitizeMeasurementRow(row = {}) {
 const source = row && typeof row === 'object'
      ? { ...row }
      : {};
 const storedVersion = rowMeasurementFixVersion(source);
 const integrity = measurementAggregateIntegrity(source);
 if (integrity.valid) {
      source.recentOutcomes = Array.isArray(source.recentOutcomes)
          ? source.recentOutcomes
              .filter(isCurrentMeasurementOutcome)
              .slice(-50)
          : [];
      source.measurementFixVersion = MEASUREMENT_FIX_VERSION;
      source.outcomeMeasurementVersion = MEASUREMENT_FIX_VERSION;
      source.acceptedOutcomeMeasurementVersion = MEASUREMENT_FIX_VERSION;
      source.outcomeMeasurementGateMode = OUTCOME_MEASUREMENT_GATE_MODE;
      source.outcomeMeasurementVersionRequired = true;
      source.strictOutcomeMeasurementGate = true;
      source.legacyOutcomeMeasurementsExcluded = true;
      source.completedCurrentMeasurementOnly = true;
      source.exitFillModelVersion =
          source.exitFillModelVersion || EXIT_FILL_MODEL_VERSION;
      source.currentMeasurementAggregateIntegrityValid = true;
      source.currentMeasurementAggregateIntegrityCheckedAt = now();
      source.currentMeasurementAggregateCompleted = integrity.completed;
      source.currentMeasurementAcceptedOutcomeCount =
          integrity.acceptedOutcomeCount;
      source.currentMeasurementNonCurrentRecentOutcomeCount = 0;
      return source;
 }
 const legacyCompleted = integrity.completed;
 const legacyTotalR = num(
      source.totalR ??
          source.netTotalR ??
          source.longNetTotalR,
      0
 );
 const legacyTotalCostR = num(source.totalCostR, 0);
 const legacyRecentOutcomeCount = integrity.recentOutcomeCount;
 for (const field of legacyOutcomeResetFields()) {
      source[field] = 0;
 }
 source.measurementVersionAcceptedOutcomeCount = 0;
 source.lastAcceptedOutcomeMeasurementVersion = null;
 source.lastAcceptedOutcomeMeasurementAt = null;
 source.recentOutcomes = [];
 source.previousMeasurementFixVersion =
  storedVersion === MEASUREMENT_FIX_VERSION
    ? 'CURRENT_VERSION_WITH_UNVERIFIED_AGGREGATES'
    : storedVersion || 'UNVERSIONED';
source.legacyExcludedCompleted =
  num(source.legacyExcludedCompleted, 0) || legacyCompleted;
source.legacyExcludedTotalR =
  num(source.legacyExcludedTotalR, 0) || legacyTotalR;
source.legacyExcludedTotalCostR =
  num(source.legacyExcludedTotalCostR, 0) || legacyTotalCostR;
source.legacyExcludedAcceptedOutcomeCount =
  num(source.legacyExcludedAcceptedOutcomeCount, 0) ||
  integrity.acceptedOutcomeCount;
source.legacyExcludedRecentOutcomeCount =
  num(source.legacyExcludedRecentOutcomeCount, 0) ||
  legacyRecentOutcomeCount;
source.legacyExcludedNonCurrentRecentOutcomeCount =
  num(source.legacyExcludedNonCurrentRecentOutcomeCount, 0) ||
  integrity.nonCurrentRecentOutcomeCount;
source.measurementFixVersion = MEASUREMENT_FIX_VERSION;
source.outcomeMeasurementVersion = MEASUREMENT_FIX_VERSION;
source.acceptedOutcomeMeasurementVersion = MEASUREMENT_FIX_VERSION;
source.previousSupportedMeasurementFixVersion =
  PREVIOUS_MEASUREMENT_FIX_VERSION;
source.outcomeMeasurementGateMode = OUTCOME_MEASUREMENT_GATE_MODE;
source.outcomeMeasurementVersionRequired = true;
source.strictOutcomeMeasurementGate = true;
source.legacyOutcomeMeasurementsExcluded = true;
source.completedCurrentMeasurementOnly = true;
source.exitFillModelVersion = EXIT_FILL_MODEL_VERSION;
source.exitFillPolicy =
  'TP_SL_USE_TRIGGER_BOUNDARY_TIME_STOP_USES_OBSERVED_PRICE';
source.outcomeMeasurementMigrationApplied = true;
source.outcomeMeasurementMigrationReason =
  storedVersion === MEASUREMENT_FIX_VERSION
    ? 'ADMIN_CURRENT_VERSION_AGGREGATE_INTEGRITY_MISMATCH_EXCLUDED'
    : 'ADMIN_DISPLAY_EXCLUDES_LEGACY_TRIGGER_OVERSHOOT_OUTCOMES';
source.currentMeasurementAggregateIntegrityValid = true;
source.currentMeasurementAggregateIntegrityMismatchDetected =
  storedVersion === MEASUREMENT_FIX_VERSION;
source.currentMeasurementAggregateIntegrityCheckedAt = now();
source.currentMeasurementAggregateCompleted = 0;
source.currentMeasurementAcceptedOutcomeCount = 0;
source.currentMeasurementNonCurrentRecentOutcomeCount = 0;
source.learningStatus = 'OBSERVING';
source.status = 'OBSERVING';
source.awaitingOutcomes =
  num(source.seen ?? source.observations, 0) > 0;
    source.tooEarly = true;
    return source;
}
function getArray(value) {
    return Array.isArray(value) ? value : [];
}
function toSafeLimit(value, fallback = DEFAULT_LIMIT, max = MAX_LIMIT) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    if (n < 1) return fallback;
    return Math.min(Math.floor(n), max);
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
function firstFiniteNumber(values = []) {
    for (const value of flattenValues(values)) {
        if (value === undefined || value === null || value === '') continue;
        const n = Number(value);
        if (Number.isFinite(n)) return n;
    }
    return null;
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
function withTimeout(promise, timeoutMs, code = 'TIMEOUT') {
    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
          const error = new Error(code);
          error.code = code;
          reject(error);
      }, timeoutMs);
    });
    return Promise
      .race([promise, timeoutPromise])
      .finally(() => {
          if (timer) clearTimeout(timer);
      });
}
function pruneCacheMap(map) {
    const entries = [...map.entries()];
    if (entries.length <= CACHE_MAX_KEYS) return;
    entries
      .sort((a, b) => num(a[1]?.ts, 0) - num(b[1]?.ts, 0))
      .slice(0, Math.max(0, entries.length - CACHE_MAX_KEYS))
      .forEach(([key]) => map.delete(key));
}
function modePayload() {
    return {
      ...temporalPolicyPayload(now()),
      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      scannerSide: TARGET_SCANNER_SIDE,
      oppositeTradeSide: OPPOSITE_TRADE_SIDE,
      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      positionSide: TARGET_TRADE_SIDE,
      direction: TARGET_TRADE_SIDE,
      longOnly: true,
      shortDisabled: true,
      shortOnly: false,
      longDisabled: false,
      realOrdersDisabled: true,
      bitgetOrdersDisabled: true,
      exchangeOrdersDisabled: true,
      exchangeCallsDisabled: true,
      noRealOrders: true,
      noExchangeOrders: true,
      virtualOnly: true,
      virtualLearning: true,
   virtualLearningForced: true,
   virtualTracked: true,
   virtualPositionsOnly: true,
   globalMaxOpenPositionsBlockDisabled: true,
   maxOneOpenPositionPerSymbol: true,
   oneOpenPositionPerSymbol: true,
   persistentLearningKey: PERSISTENT_LEARNING_KEY,
   weekResetDisabled: true,
   isoWeekLearningDisabled: true,
   observationFirst: true,
   virtualOutcomesIncluded: true,
   shadowOutcomesIncluded: true,
   realOutcomesExcluded: true,
   netOutcomesOnly: true,
   learningOutcomesOnly: true,
   outcomesSourceMode: 'VIRTUAL_AND_SHADOW_NET_OUTCOMES',
   completedDefinition:
'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES_CURRENT_MEASUREMENT_ONLY',
   completedOnlyClosedVirtualOrShadow: true,
   scoringRSource: 'netR',
   winsLossesFlatsSource: 'netR',
   winrateDefinition: 'netR > 0',
   avgRSource: 'netR',
   totalRSource: 'netR',
   avgCostRShown: true,
   avgCostRSource: 'costR',
   measurementFixVersion: MEASUREMENT_FIX_VERSION,
   outcomeMeasurementVersion: MEASUREMENT_FIX_VERSION,
   acceptedOutcomeMeasurementVersion: MEASUREMENT_FIX_VERSION,
   previousSupportedMeasurementFixVersion: PREVIOUS_MEASUREMENT_FIX_VERSION,
   outcomeMeasurementGateMode: OUTCOME_MEASUREMENT_GATE_MODE,
   outcomeMeasurementVersionRequired: true,
   strictOutcomeMeasurementGate: true,
   legacyOutcomeMeasurementsExcluded: true,
   completedCurrentMeasurementOnly: true,
   exitFillModelVersion: EXIT_FILL_MODEL_VERSION,
   exitFillPolicy: 'TP_SL_USE_TRIGGER_BOUNDARY_TIME_STOP_USES_OBSERVED_PRICE',
   empiricalVetoEnabled: true,
   empiricalVetoPolicyVersion: EMPIRICAL_VETO_POLICY_VERSION,
   empiricalVetoMinCompleted: EMPIRICAL_VETO_MIN_COMPLETED,
   empiricalVetoMaxAvgR: EMPIRICAL_VETO_MAX_AVG_R,
   empiricalVetoRule:
     'completed >= 35 && avgR <= 0',
   empiricalVetoBlocksAdaptiveSelection: true,
   empiricalVetoBlocksManualActivation: true,
   empiricalVetoRemovesActiveDiscordSelection: true,
   empiricalVetoCanRecover: true,
   discordRequiresPassedActivationGate: true,
   discordRequiresMinCompleted: EMPIRICAL_VETO_MIN_COMPLETED,
   discordRequiresPositiveAvgR: true,
   discordAllowsObservingFamilies: false,
   discordAllowsEarlyOutcomeFamilies: false,
   avgCostRFixEnabled: true,
   directSLFixEnabled: true,
   observationDedupeRequired: true,
   observationAlwaysCounted: false,
   seenDefinition: 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY',
   outcomeDedupeRequired: true,
   manualSelectionOnly: true,
   manualSelectionRequired: true,
   autoRotationActivationDisabled: true,
   discordOnlyForSelectedMicroFamilies: true,
   discordOnlyForExactTrueMicroMatch: true,
   manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
   discordSelectionRule: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY',
   parentMatchDoesNotTriggerDiscord: true,
   macroMatchDoesNotTriggerDiscord: true,
   scannerFingerprintLegacyFallbackEnabled:
SHOW_SCANNER_FINGERPRINT_LEGACY_FALLBACK,
   scannerFingerprintsHidden: SHOW_SCANNER_FINGERPRINT_LEGACY_FALLBACK !== true,
   scannerFingerprintRole: 'METADATA_ONLY',
   scannerFingerprintsMetadataOnly: true,
   scannerFingerprintsUsedAsLearningFamily: false,
   executionFingerprintRole: 'METADATA_ONLY',
   executionFingerprintsMetadataOnly: true,
   executionFingerprintsUsedAsLearningFamily: false,
   analyzeMicroFamiliesOnly: true,
   learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
   symbolExcludedFromFamilyId: true,
   trueMicroOnly: true,
   exactTrueMicroOnly: true,
   exactTrueMicroFamilyRequired: true,
   trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
   exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
   broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
   childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
   parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
   fixedTaxonomyPreferred: true,
   learningGranularity: LEARNING_GRANULARITY,
   parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
   parentMicroFamilyCount: 15,
   selectableChildMicroFamilyCount: 75,
   parentFamilyRule: 'MICRO_LONG_{SETUP}_{REGIME}',
   selectableFamilyRule: 'MICRO_LONG_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',
         bucketsCoarseOnly: true,
         bucketGranularity: 'SETUP_X_REGIME_X_CONFIRMATION',
         scannerBucketsDebugMetadataOnly: true,
         legacy25BucketsDebugMetadataOnly: true,
         coinNameExcludedFromLearningIdentity: true,
         hashesExcludedFromLearningIdentity: true,
         learningRemainsBroad: true,
         selectionWillBeAdaptive: true,
         discordWillBeStrict: true,
         currentFitVersion: CURRENT_FIT_VERSION,
         currentFitSoftOnly: true,
         currentFitBlocksLearning: false,
         currentFitBlocksVirtualLearning: false,
         currentFitBlocksShadowLearning: false,
         currentFitAffectsSelectionOnly: true,
         currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
         currentFitNullBreadthPreserved: true,
         missingBreadthIsNotZero: true,
         seenCompletedRatioZeroWhenNoCompleted: true,
         adaptiveLayerBuilt: false,
         marketWeatherEngineBuilt: true,
         recentMomentumScoreBuilt: false,
         currentFitScoreBuilt: true,
         parentDiversificationBuilt: false,
         adaptiveLayerBlockedUntilMeasurementClean: true,
         longRiskShape: 'sl < entry < tp',
         riskTradeSide: TARGET_TRADE_SIDE,
         riskGeometryRule: 'LONG: sl < entry < tp',
         tpRule: 'price >= tp',
         slRule: 'price <= sl',
         tpHitRule: 'LONG: price >= tp',
         slHitRule: 'LONG: price <= sl',
         grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
         currentRFormula: '(currentPrice - entry) / (entry - initialSl)',
         timeStopEnabled: true,
         positionTimeStopMinDefault: 720,
         resetCronDisabled: true,
         activateFreezeCronDisabled: true,
         minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,
         redisNamespace: LONG_NAMESPACE,
         redisKeyPrefix: LONG_KEY_PREFIX,
         redisKeysSeparatedFromShortRoot: true,
         shortRootTouched: false
    };
}
function normalizeMode(value) {
    const raw = String(value || 'balanced').trim();
    if (VALID_MODES.has(raw)) return raw;
    const lower = raw.toLowerCase();
    if (lower === 'totalr') return 'totalR';
    if (lower === 'avgr') return 'avgR';
    if (lower === 'directsl') return 'directSL';
    if (lower === 'currentfit') return 'currentFit';
    return VALID_MODES.has(lower) ? lower : 'balanced';
}
function normalizeRequestedTradeSide(value) {
    const raw = upper(value);
    if (!raw) return TARGET_TRADE_SIDE;
    if (['LONG', 'BULL', 'BULLISH', 'BUY'].includes(raw)) return
TARGET_TRADE_SIDE;
    if (['SHORT', 'BEAR', 'BEARISH', 'SELL'].includes(raw)) return 'SHORT_DISABLED';
    const converted = sideToTradeSide(raw);
    if (converted === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
    if (converted === OPPOSITE_TRADE_SIDE) return 'SHORT_DISABLED';
    return TARGET_TRADE_SIDE;
}
function cleanSideHaystack(text = '') {
    return upper(text)
      .replaceAll('SHORT_DISABLED_TRUE', '')
      .replaceAll('SHORTDISABLED_TRUE', '')
      .replaceAll('BLOCK_SHORT_TRUE', '')
      .replaceAll('SHORT_DISABLED_FALSE', '')
      .replaceAll('SHORTDISABLED_FALSE', '')
      .replaceAll('BLOCK_SHORT_FALSE', '')
      .replaceAll('SHORT_ENABLED_FALSE', '')
      .replaceAll('SHORT_ONLY_FALSE', '')
      .replaceAll('LONG_DISABLED_FALSE', '')
      .replaceAll('LONGDISABLED_FALSE', '')
      .replaceAll('LONG_ENABLED_FALSE', '')
      .replaceAll('LONG_ONLY_FALSE', '')
      .replaceAll('SHORT_DISABLED_LONG_ONLY', '')
      .replaceAll('SHORTDISABLED_LONG_ONLY', '')
      .replaceAll('BLOCK_SHORT', '')
      .replaceAll('SHORT_DISABLED', '')
      .replaceAll('SHORTDISABLED', '')
      .replaceAll('SHORT_ONLY_MODE', 'SHORT')
      .replaceAll('SHORT_ONLY', 'SHORT')
      .replaceAll('SHORT-ONLY', 'SHORT')
      .replaceAll('LONG_ONLY_MODE', 'LONG')
      .replaceAll('LONG_ONLY', 'LONG')
      .replaceAll('LONG-ONLY', 'LONG');
}
function normalizeSignalText(value = '') {
    return cleanSideHaystack(value)
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
function hasShortSignal(text = '') {
    return hasSignalPattern(text, [
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
function hasLongSignal(text = '') {
    return hasSignalPattern(text, [
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
function normalizeSideToken(value) {
    const raw = cleanSideHaystack(value);
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
    const shortHit = hasShortSignal(raw);
    const longHit = hasLongSignal(raw);
    if (longHit && !shortHit) return TARGET_TRADE_SIDE;
    if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;
    if (shortHit && longHit) {
        if (raw.includes('TRADE_SIDE=LONG') || raw.includes('TRADESIDE=LONG'))
return TARGET_TRADE_SIDE;
        if (raw.includes('TRADE_SIDE=SHORT') || raw.includes('TRADESIDE=SHORT')) return
OPPOSITE_TRADE_SIDE;
        if (raw.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
        if (raw.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
    }
    return 'UNKNOWN';
}
function parseLongTaxonomyMicroId(id = '') {
    const value = upper(id);
    if (!value.startsWith('MICRO_LONG_')) {
        return {
             valid: false,
             selectable: false,
             isParent: false,
             isChild: false,
             rawId: String(id || '').trim()
        };
}
let body = value.slice('MICRO_LONG_'.length);
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
const parentId = setup && regime
    ? `MICRO_LONG_${setup}_${regime}`
    : null;
const childId = parentId && confirmationProfile
    ? `${parentId}_${confirmationProfile}`
    : null;
const validParent =
    Boolean(parentId) &&
    LONG_FIXED_SETUP_TYPES.has(setup) &&
    LONG_FIXED_REGIME_BUCKETS.has(regime);
const validChild =
    validParent &&
    Boolean(confirmationProfile) &&
    LONG_CONFIRMATION_PROFILES.has(confirmationProfile);
return {
    valid: validParent || validChild,
    selectable: validChild,
    isParent: validParent && !validChild,
    isChild: validChild,
    rawId: String(id || '').trim(),
    setup,
    regime,
    confirmationProfile,
    parentTrueMicroFamilyId: validParent ? parentId : null,
    trueMicroFamilyId: validChild ? childId : validParent ? parentId : null,
    childTrueMicroFamilyId: validChild ? childId : null,
         trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
         childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
         parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
         learningGranularity: LEARNING_GRANULARITY,
         parentLearningGranularity: PARENT_LEARNING_GRANULARITY
    };
}
function isFixedLongParentMicroId(id = '') {
    const parsed = parseLongTaxonomyMicroId(id);
    return parsed.valid && parsed.isParent;
}
function isFixedLongChildMicroId(id = '') {
    const parsed = parseLongTaxonomyMicroId(id);
    return parsed.valid && parsed.isChild;
}
function isSelectableTrueMicroId(id = '') {
    return isFixedLongChildMicroId(id);
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
function allowScannerFingerprintRow(id = '') {
    return SHOW_SCANNER_FINGERPRINT_LEGACY_FALLBACK === true ||
!isScannerFingerprintId(id);
}
function validLearningId(id = '') {
    const value = String(id || '').trim();
    if (!value) return false;
    if (!allowScannerFingerprintRow(value)) return false;
    if (isExecutionFingerprintId(value)) return false;
    return true;
}
function firstSelectableLearningId(values = [], fallback = null) {
    for (const value of values) {
        const id = String(value || '').trim();
        if (validLearningId(id) && isSelectableTrueMicroId(id)) return upper(id);
    }
    return fallback;
}
function firstValidLearningId(values = [], fallback = null) {
    for (const value of values) {
        const id = String(value || '').trim();
        if (validLearningId(id)) return upper(id);
    }
    return fallback;
}
function getTrueMicroFamilyId(row = {}, fallback = null) {
    return firstSelectableLearningId([
        row.trueMicroFamilyId,
        row.learningMicroFamilyId,
        row.analyzeMicroFamilyId,
        row.childTrueMicroFamilyId,
        row.microFamilyId,
        row.id,
        row.key,
        fallback
    ], null);
}
function getCoarseMicroFamilyId(row = {}, fallback = null) {
    const childId = getTrueMicroFamilyId(row);
    const parsed = parseLongTaxonomyMicroId(childId);
    return firstValidLearningId([
        row.parentTrueMicroFamilyId,
        row.coarseMicroFamilyId,
        row.baseMicroFamilyId,
        row.legacyMicroFamilyId,
        parsed.parentTrueMicroFamilyId,
        fallback
    ], parsed.parentTrueMicroFamilyId || fallback);
}
function getMacroFamilyId(row = {}) {
    const childId = getTrueMicroFamilyId(row);
    const parsed = parseLongTaxonomyMicroId(childId);
    return firstValidLearningId([
      row.parentTrueMicroFamilyId,
      row.parentMacroFamilyId,
      row.macroFamilyId,
      row.parentMicroFamilyId,
      row.parentFamilyId,
      row.macroId,
      row.familyId,
      parsed.parentTrueMicroFamilyId
    ], parsed.parentTrueMicroFamilyId || null);
}
function getDefinitionParts(row = {}) {
    if (Array.isArray(row.definitionParts)) return row.definitionParts;
    if (Array.isArray(row.microDefinitionParts)) return row.microDefinitionParts;
    if (Array.isArray(row.definition)) return row.definition;
    return [];
}
function getMacroDefinitionParts(row = {}) {
    if (Array.isArray(row.macroDefinitionParts)) return row.macroDefinitionParts;
    if (Array.isArray(row.parentDefinitionParts)) return row.parentDefinitionParts;
    return [];
}
function collectSideText(input = {}) {
    if (typeof input === 'string') return cleanSideHaystack(input);
    return [
      input.tradeSide,
      input.side,
      input.positionSide,
      input.direction,
      input.signalSide,
      input.scannerSide,
      input.actualScannerSide,
      input.analysisSide,
      input.entrySide,
      input.bias,
      input.marketBias,
      input.familyId,
      input.family,
      input.baseFamilyId,
      input.macroFamilyId,
      input.parentMacroFamilyId,
      input.parentMicroFamilyId,
      input.parentFamilyId,
      input.macroId,
      input.microFamilyId,
        input.trueMicroFamilyId,
        input.learningMicroFamilyId,
        input.analyzeMicroFamilyId,
        input.childTrueMicroFamilyId,
        input.parentTrueMicroFamilyId,
        input.coarseMicroFamilyId,
        input.baseMicroFamilyId,
        input.legacyMicroFamilyId,
        input.id,
        input.key,
        input.definition,
        input.microDefinition,
        input.macroDefinition,
        input.parentDefinition,
        ...getArray(input.definitionParts),
        ...getArray(input.microDefinitionParts),
        ...getArray(input.macroDefinitionParts),
        ...getArray(input.parentDefinitionParts),
        ...getArray(input.executionFingerprintParts)
    ]
        .map((value) => cleanSideHaystack(value))
        .filter(Boolean)
        .join(' | ');
}
function inferTradeSide(input = {}) {
    if (typeof input === 'string') {
        const clean = cleanSideHaystack(input);
        const direct = normalizeSideToken(clean);
        if (direct === OPPOSITE_TRADE_SIDE || direct === TARGET_TRADE_SIDE) return
direct;
        const longSignal = hasLongSignal(clean);
        const shortSignal = hasShortSignal(clean);
        if (longSignal && !shortSignal) return TARGET_TRADE_SIDE;
        if (shortSignal && !longSignal) return OPPOSITE_TRADE_SIDE;
        if (parseLongTaxonomyMicroId(clean).valid) return TARGET_TRADE_SIDE;
        if (clean.includes('MICRO_SHORT_') || clean.includes('SHORT')) return
OPPOSITE_TRADE_SIDE;
        if (clean.includes('MICRO_LONG_') || clean.includes('LONG')) return
TARGET_TRADE_SIDE;
        return 'UNKNOWN';
    }
    const directSources = [
        input.tradeSide,
        input.side,
        input.positionSide,
        input.direction,
        input.signalSide,
         input.scannerSide,
         input.actualScannerSide,
         input.analysisSide,
         input.entrySide,
         input.bias,
         input.marketBias
    ];
    for (const source of directSources) {
         const normalized = normalizeSideToken(source);
         if (normalized === OPPOSITE_TRADE_SIDE || normalized === TARGET_TRADE_SIDE) {
             return normalized;
         }
    }
    const microFamilyId = cleanSideHaystack(
         input.trueMicroFamilyId ||
         input.learningMicroFamilyId ||
         input.analyzeMicroFamilyId ||
         input.childTrueMicroFamilyId ||
         input.microFamilyId ||
         input.parentTrueMicroFamilyId ||
         input.coarseMicroFamilyId ||
         input.baseMicroFamilyId ||
         input.legacyMicroFamilyId ||
         input.id ||
         input.key
    );
    if (parseLongTaxonomyMicroId(microFamilyId).valid) return TARGET_TRADE_SIDE;
    if (microFamilyId.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
    const text = collectSideText(input);
    const longSignal = hasLongSignal(text);
    const shortSignal = hasShortSignal(text);
    if (longSignal && !shortSignal) return TARGET_TRADE_SIDE;
    if (shortSignal && !longSignal) return OPPOSITE_TRADE_SIDE;
    if (longSignal && shortSignal) {
         if (microFamilyId.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
         if (microFamilyId.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
    }
    if (input.longOnly === true || input.shortDisabled === true) return
TARGET_TRADE_SIDE;
    if (input.shortOnly === true || input.longDisabled === true) return
OPPOSITE_TRADE_SIDE;
    return 'UNKNOWN';
}
function isLearningOutcomeSource(source = '') {
    const value = upper(source || 'VIRTUAL');
    return value === 'VIRTUAL' || value === 'SHADOW' || value === 'PAPER' || value
=== '';
}
function isLongRow(row = {}) {
    return inferTradeSide(row) !== OPPOSITE_TRADE_SIDE;
}
function isAnalyzeMicroRow(row = {}) {
    const id = getTrueMicroFamilyId(row);
    if (!id) return false;
    if (!validLearningId(id)) return false;
    if (!isSelectableTrueMicroId(id)) return false;
    if (row.legacyScannerFamilyFallback === true) return false;
    if (inferTradeSide({ ...row, trueMicroFamilyId: id }) === OPPOSITE_TRADE_SIDE)
return false;
    return true;
}
function sourceEntriesFromMicros(micros = {}) {
    if (Array.isArray(micros)) {
        return micros.map((row, index) => [
             getTrueMicroFamilyId(row, String(index)) || String(index),
             row
        ]);
    }
    if (!micros || typeof micros !== 'object') return [];
    return Object.entries(micros);
}
function microsCount(micros = {}) {
    return sourceEntriesFromMicros(micros)
        .filter(([key, row]) => {
             const id = getTrueMicroFamilyId(row, key);
             return Boolean(id && validLearningId(id) && isSelectableTrueMicroId(id));
        })
        .length;
}
function generateLongTaxonomyRows() {
    const rows = [];
    for (const setup of SETUP_ORDER) {
        for (const regime of REGIME_ORDER) {
             const parentTrueMicroFamilyId = `MICRO_LONG_${setup}_${regime}`;
             for (const confirmationProfile of CONFIRMATION_PROFILE_ORDER) {
               const trueMicroFamilyId =
`${parentTrueMicroFamilyId}_${confirmationProfile}`;
               rows.push({
                   trueMicroFamilyId,
                   microFamilyId: trueMicroFamilyId,
                   analyzeMicroFamilyId: trueMicroFamilyId,
                   learningMicroFamilyId: trueMicroFamilyId,
                   childTrueMicroFamilyId: trueMicroFamilyId,
                   coarseMicroFamilyId: parentTrueMicroFamilyId,
  parentTrueMicroFamilyId,
  macroFamilyId: parentTrueMicroFamilyId,
  parentMacroFamilyId: parentTrueMicroFamilyId,
  parentMicroFamilyId: parentTrueMicroFamilyId,
  familyId: parentTrueMicroFamilyId,
  taxonomySetup: setup,
  taxonomyRegime: regime,
  confirmationProfile,
  setupType: setup,
  regimeBucket: regime,
  trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
  exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
  childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
  parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
  learningGranularity: LEARNING_GRANULARITY,
  parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
  sourceWeekKey: PERSISTENT_LEARNING_KEY,
  sourceWeekPrimary: true,
  sourceWeekFallback: false,
  seen: 0,
  observations: 0,
  observationDuplicateSkippedCount: 0,
  completed: 0,
  outcomeSample: 0,
  observationSample: 0,
  virtualCompleted: 0,
  shadowCompleted: 0,
  realCompleted: 0,
  virtualWins: 0,
  virtualLosses: 0,
  virtualFlats: 0,
  shadowWins: 0,
  shadowLosses: 0,
  shadowFlats: 0,
  virtualTotalR: 0,
  shadowTotalR: 0,
  virtualTotalCostR: 0,
  shadowTotalCostR: 0,
  directSLCount: 0,
  directSLPct: 0,
  virtualDirectSLCount: 0,
  shadowDirectSLCount: 0,
  generatedEmptyTaxonomyRow: true,
  active: false,
  macroActive: false,
  ...modePayload()
});
            }
        }
    }
    return rows;
}
function hasVirtualShadowOutcomeFields(row = {}) {
    return [
        'virtualCompleted',
        'shadowCompleted',
        'virtualWins',
        'virtualLosses',
        'virtualFlats',
        'shadowWins',
        'shadowLosses',
        'shadowFlats',
        'virtualTotalR',
        'shadowTotalR',
        'virtualTotalCostR',
        'shadowTotalCostR'
    ].some((key) => hasValue(row[key]));
}
function getLongRiskGeometry(row = {}) {
    const entry = firstFiniteNumber([
        row.entryPrice,
        row.entry,
        row.avgEntryPrice,
        row.averageEntryPrice,
        row.averageEntry,
        row.openPrice
    ]);
    const initialSl = firstFiniteNumber([
        row.initialSl,
        row.initialSL,
        row.initialStopLoss,
        row.initialStopLossPrice,
        row.stopLoss,
        row.stopLossPrice,
        row.sl,
        row.slPrice
    ]);
    const tp = firstFiniteNumber([
        row.tp,
        row.takeProfit,
        row.takeProfitPrice,
        row.targetPrice,
        row.finalTp,
        row.finalTakeProfit
]);
const exitPrice = firstFiniteNumber([
  row.exitPrice,
  row.closePrice,
  row.closedPrice,
  row.outcomePrice,
  row.fillExitPrice,
  row.exit
]);
const currentPrice = firstFiniteNumber([
  row.currentPrice,
  row.markPrice,
  row.lastPrice,
  row.price
]);
const denominator =
  Number.isFinite(entry) && Number.isFinite(initialSl)
       ? entry - initialSl
       : 0;
const validGeometry =
  Number.isFinite(entry) &&
  Number.isFinite(initialSl) &&
  Number.isFinite(tp) &&
  denominator > 0 &&
  initialSl < entry &&
  entry < tp;
const longGrossR =
  validGeometry && Number.isFinite(exitPrice)
       ? (exitPrice - entry) / denominator
       : null;
const longCurrentR =
  validGeometry && Number.isFinite(currentPrice)
       ? (currentPrice - entry) / denominator
       : null;
const longTpHit =
  validGeometry &&
  (
       row.longTpHit === true ||
       row.tpHit === true ||
       (Number.isFinite(exitPrice) && exitPrice >= tp) ||
       (Number.isFinite(currentPrice) && currentPrice >= tp)
  );
const longSlHit =
  validGeometry &&
  (
       row.longSlHit === true ||
       row.slHit === true ||
              (Number.isFinite(exitPrice) && exitPrice <= initialSl) ||
              (Number.isFinite(currentPrice) && currentPrice <= initialSl)
         );
    return {
         entry,
         initialSl,
         tp,
         exitPrice,
         currentPrice,
         denominator,
         validGeometry,
         longTpHit: Boolean(longTpHit),
         longSlHit: Boolean(longSlHit),
         longGrossR,
         longCurrentR,
         riskGeometryRule: 'LONG: sl < entry < tp',
         tpHitRule: 'LONG: price >= tp',
         slHitRule: 'LONG: price <= sl',
         grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
         currentRFormula: '(currentPrice - entry) / (entry - initialSl)'
    };
}
function outcomeNetR(row = {}) {
    const explicitLongR = firstFiniteNumber([
         row.longNetR,
         row.netLongR,
         row.longExitR,
         row.longRealizedNetR,
         row.longRealizedR
    ]);
    if (explicitLongR !== null) return explicitLongR;
    const geometry = getLongRiskGeometry(row);
    const costR = num(row.costR ?? row.avgCostR, 0);
    if (geometry.validGeometry && geometry.longGrossR !== null) {
         return geometry.longGrossR - costR;
    }
    return num(
         row.netR ??
         row.exitR ??
         row.realizedNetR ??
         row.realizedR ??
         row.r,
         0
    );
}
function aggregateRecentOutcomes(row = {}) {
    const outcomes = Array.isArray(row.recentOutcomes)
         ? row.recentOutcomes.filter(isCurrentMeasurementOutcome)
         : [];
    return outcomes.reduce(
         (acc, outcome) => {
              if (!outcome || typeof outcome !== 'object') return acc;
              const source = upper(outcome.source || outcome.outcomeSource || 'VIRTUAL');
              if (!isLearningOutcomeSource(source)) return acc;
              if (!isLongRow({ ...row, ...outcome })) return acc;
              const netR = outcomeNetR(outcome);
              const costR = num(outcome.costR ?? outcome.avgCostR, 0);
              acc.completed += 1;
              acc.totalR += netR;
              acc.totalCostR += costR;
              if (netR > 0) {
                  acc.wins += 1;
                  acc.grossWinR += netR;
              } else if (netR < 0) {
                  acc.losses += 1;
                  acc.grossLossR += Math.abs(netR);
              } else {
                  acc.flats += 1;
              }
              return acc;
         },
         {
              completed: 0,
              wins: 0,
              losses: 0,
              flats: 0,
              totalR: 0,
              totalCostR: 0,
              grossWinR: 0,
              grossLossR: 0
         }
    );
}
function sourceMetricSum(row = {}, realKey = null, shadowKey = null) {
    const virtualKey = realKey && String(realKey).startsWith('real')
         ? `virtual${String(realKey).slice(4)}`
         : null;
    const resolvedShadowKey = shadowKey || (
         realKey && String(realKey).startsWith('real')
              ? `shadow${String(realKey).slice(4)}`
              : null
    );
    return (
         num(virtualKey ? row[virtualKey] : 0, 0) +
         num(resolvedShadowKey ? row[resolvedShadowKey] : 0, 0)
    );
}
function getLearningCount(row = {}, aggregateKey, realKey = null, shadowKey =
null) {
    const virtualShadow = sourceMetricSum(row, realKey, shadowKey);
    if (virtualShadow > 0) return virtualShadow;
    if (aggregateKey && hasValue(row[aggregateKey])) {
         return num(row[aggregateKey], 0);
    }
    return 0;
}
function getOutcomeCounts(row = {}) {
    const recent = aggregateRecentOutcomes(row);
    const wins = getLearningCount(row, 'wins', 'realWins', 'shadowWins');
    const losses = getLearningCount(row, 'losses', 'realLosses', 'shadowLosses');
    const flats = getLearningCount(row, 'flats', 'realFlats', 'shadowFlats');
    const virtualShadowCompleted =
         num(row.virtualCompleted, 0) +
         num(row.shadowCompleted, 0);
    const aggregateCompleted = Math.max(
         num(row.completed, 0),
         num(row.outcomeSample, 0),
         0
    );
    if (
         virtualShadowCompleted <= 0 &&
         aggregateCompleted <= 0 &&
         wins + losses + flats <= 0 &&
         recent.completed > 0
    ) {
         return {
              wins: recent.wins,
              losses: recent.losses,
              flats: recent.flats,
              total: recent.completed
         };
    }
    const countedTotal = wins + losses + flats;
    const total = Math.max(
         countedTotal,
         virtualShadowCompleted,
         aggregateCompleted,
         recent.completed,
         0
    );
    const inferredFlats = Math.max(0, total - wins - losses);
    return {
         wins,
         losses,
         flats: Math.max(flats, inferredFlats),
         total
    };
}
function getCompletedSample(row = {}) {
    return getOutcomeCounts(row).total;
}
function getObservationSample(row = {}) {
    return Math.max(
         num(row.seen, 0),
         num(row.observations, 0),
         0
    );
}
function getObservationDuplicateSkippedCount(row = {}) {
    return Math.max(
         num(row.observationDuplicateSkippedCount, 0),
         num(row.duplicateObservationsSkipped, 0),
         num(row.seenDuplicateSkippedCount, 0),
         0
    );
}
function getSeenCompletedRatio(row = {}) {
    const completed = getCompletedSample(row);
    const seen = getObservationSample(row);
    if (completed <= 0) return 0;
    return seen / completed;
}
function getTotalR(row = {}) {
    const completed = getCompletedSample(row);
    const recent = aggregateRecentOutcomes(row);
    if (completed <= 0) return 0;
    const virtualShadowTotalR =
         num(row.virtualTotalR, 0) +
         num(row.shadowTotalR, 0);
    if (virtualShadowTotalR !== 0 || hasVirtualShadowOutcomeFields(row)) {
         return virtualShadowTotalR;
    }
    if (recent.completed > 0) return recent.totalR;
    if (hasValue(row.longNetTotalR)) return num(row.longNetTotalR, 0);
    if (hasValue(row.netLongTotalR)) return num(row.netLongTotalR, 0);
    if (hasValue(row.netTotalR)) return num(row.netTotalR, 0);
    if (hasValue(row.totalNetR)) return num(row.totalNetR, 0);
    if (hasValue(row.totalR)) return num(row.totalR, 0);
    return 0;
}
function getAvgR(row = {}) {
    const completed = getCompletedSample(row);
    if (completed <= 0) return 0;
    if (hasValue(row.avgNetR) && !hasVirtualShadowOutcomeFields(row)) return
num(row.avgNetR, 0);
    if (hasValue(row.netAvgR) && !hasVirtualShadowOutcomeFields(row)) return
num(row.netAvgR, 0);
    if (hasValue(row.avgR) && !hasVirtualShadowOutcomeFields(row)) return
num(row.avgR, 0);
    return getTotalR(row) / completed;
}
function empiricalActivationGate(row = {}, meta = null) {
    const winrateMeta = meta || getSampleAdjustedWinrate(row);
    const completed = num(winrateMeta.outcomeSample, 0);
    const averageR = getAvgR(row);
    const totalR = getTotalR(row);
    if (completed < EMPIRICAL_VETO_MIN_COMPLETED) {
        return {
             status: 'OBSERVING',
             blocked: false,
             discordEligible: false,
             manualActivationAllowed: false,
             reason: `COMPLETED_BELOW_${EMPIRICAL_VETO_MIN_COMPLETED}`,
             completed,
             minCompleted: EMPIRICAL_VETO_MIN_COMPLETED,
             avgR: averageR,
             totalR,
             maxAvgR: EMPIRICAL_VETO_MAX_AVG_R
        };
    }
    if (averageR <= EMPIRICAL_VETO_MAX_AVG_R) {
        return {
             status: 'EMPIRICAL_VETO',
             blocked: true,
             discordEligible: false,
             manualActivationAllowed: false,
             reason: 'CURRENT_MEASUREMENT_NET_EDGE_NOT_POSITIVE',
             completed,
             minCompleted: EMPIRICAL_VETO_MIN_COMPLETED,
             avgR: averageR,
             totalR,
             maxAvgR: EMPIRICAL_VETO_MAX_AVG_R
        };
    }
    return {
         status: 'PASSED',
         blocked: false,
         discordEligible: true,
         manualActivationAllowed: true,
         reason: null,
         completed,
         minCompleted: EMPIRICAL_VETO_MIN_COMPLETED,
         avgR: averageR,
         totalR,
         maxAvgR: EMPIRICAL_VETO_MAX_AVG_R
    };
}
function isEmpiricallyVetoed(row = {}, meta = null) {
    return empiricalActivationGate(row, meta).blocked === true;
}
function discordEligibilityFor(row = {}, gate = null, fit = null) {
    const resolvedGate = gate || empiricalActivationGate(row);
    const currentFitAllowed =
         fit?.discordCurrentFitAllowed === true ||
         (
              fit === null &&
              row.discordCurrentFitAllowed === true
         );
    if (resolvedGate.status !== 'PASSED') {
         return {
              eligible: false,
              blocked: true,
              gatePassed: false,
              currentFitAllowed,
              reason: resolvedGate.status === 'EMPIRICAL_VETO'
                ? 'EMPIRICAL_VETO_CURRENT_MEASUREMENT_NET_EDGE_NOT_POSITIVE'
                : resolvedGate.reason || 'DISCORD_BLOCKED_ACTIVATION_GATE_NOT_PASSED'
         };
    }
    if (!currentFitAllowed) {
         return {
              eligible: false,
              blocked: true,
              gatePassed: true,
              currentFitAllowed: false,
              reason:
                fit?.discordCurrentFitGateReason ||
                row.discordCurrentFitGateReason ||
                'DISCORD_BLOCKED_CURRENT_FIT_NOT_ALLOWED'
         };
    }
    return {
         eligible: true,
         blocked: false,
         gatePassed: true,
         currentFitAllowed: true,
         reason: null
    };
}
function hasCostEvidence(row = {}) {
    if (!row || typeof row !== 'object') return false;
    if (hasValue(row.virtualTotalCostR) && num(row.virtualTotalCostR, 0) > 0) return
true;
    if (hasValue(row.shadowTotalCostR) && num(row.shadowTotalCostR, 0) > 0) return
true;
    if (hasValue(row.totalCostR) && num(row.totalCostR, 0) > 0) return true;
    if (hasValue(row.totalNetCostR) && num(row.totalNetCostR, 0) > 0) return true;
    if (hasValue(row.avgCostR) && num(row.avgCostR, 0) > 0) return true;
    if (hasValue(row.costR) && num(row.costR, 0) > 0) return true;
    if (hasValue(row.netCostR) && num(row.netCostR, 0) > 0) return true;
    if (hasValue(row.estimatedCostR) && num(row.estimatedCostR, 0) > 0) return true;
    if (Array.isArray(row.recentOutcomes)) {
         return row.recentOutcomes.some((outcome) => (
           outcome &&
           isCurrentMeasurementOutcome(outcome) &&
           isLearningOutcomeSource(outcome.source || outcome.outcomeSource ||
'VIRTUAL') &&
           (
               num(outcome.costR, 0) > 0 ||
               num(outcome.avgCostR, 0) > 0 ||
               num(outcome.totalCostR, 0) > 0 ||
               num(outcome.netCostR, 0) > 0 ||
               num(outcome.estimatedCostR, 0) > 0
           )
         ));
    }
    return false;
}
function getTotalCostR(row = {}) {
    const completed = getCompletedSample(row);
    const recent = aggregateRecentOutcomes(row);
    if (completed <= 0) return 0;
    const virtualShadowCost =
         Math.max(0, num(row.virtualTotalCostR, 0)) +
         Math.max(0, num(row.shadowTotalCostR, 0));
    if (virtualShadowCost > 0) {
         return virtualShadowCost;
    }
    if (recent.completed > 0 && recent.totalCostR > 0) return recent.totalCostR;
    if (hasValue(row.totalCostR) && num(row.totalCostR, 0) > 0) {
        return Math.max(0, num(row.totalCostR, 0));
    }
    if (hasValue(row.totalNetCostR) && num(row.totalNetCostR, 0) > 0) {
        return Math.max(0, num(row.totalNetCostR, 0));
    }
    if (hasValue(row.avgCostR) && num(row.avgCostR, 0) > 0) {
        return Math.max(0, num(row.avgCostR, 0)) * completed;
    }
    if (hasValue(row.costR) && num(row.costR, 0) > 0) {
        return Math.max(0, num(row.costR, 0)) * completed;
    }
    if (hasValue(row.netCostR) && num(row.netCostR, 0) > 0) {
        return Math.max(0, num(row.netCostR, 0)) * completed;
    }
    if (hasValue(row.estimatedCostR) && num(row.estimatedCostR, 0) > 0) {
        return Math.max(0, num(row.estimatedCostR, 0)) * completed;
    }
    if (Array.isArray(row.recentOutcomes) && row.recentOutcomes.length > 0) {
        const relevant = row.recentOutcomes
            .filter(Boolean)
            .filter(isCurrentMeasurementOutcome)
            .filter(isLongRow)
            .filter((outcome) => isLearningOutcomeSource(outcome.source ||
outcome.outcomeSource || 'VIRTUAL'));
        const costs = relevant
            .map((outcome) => Math.max(
                 0,
                 num(
                      outcome.costR ??
                          outcome.avgCostR ??
                          outcome.totalCostR ??
                          outcome.netCostR ??
                          outcome.estimatedCostR,
                      0
                 )
            ))
            .filter((costR) => costR > 0);
        if (costs.length > 0) {
            const avgRecentCostR = costs.reduce((sum, costR) => sum + costR, 0) /
costs.length;
            return avgRecentCostR * completed;
        }
    }
    return 0;
}
function getAvgCostR(row = {}) {
    const completed = getCompletedSample(row);
    if (completed <= 0) return 0;
    const totalCostR = getTotalCostR(row);
    if (totalCostR > 0) {
        return Math.max(0, totalCostR / completed);
    }
    if (hasValue(row.avgCostR) && num(row.avgCostR, 0) > 0) {
        return Math.max(0, num(row.avgCostR, 0));
    }
    if (hasValue(row.costR) && num(row.costR, 0) > 0) {
        return Math.max(0, num(row.costR, 0));
    }
    if (hasValue(row.netCostR) && num(row.netCostR, 0) > 0) {
        return Math.max(0, num(row.netCostR, 0));
    }
    if (hasValue(row.estimatedCostR) && num(row.estimatedCostR, 0) > 0) {
        return Math.max(0, num(row.estimatedCostR, 0));
    }
    return 0;
}
function costFixSource(row = {}) {
    return hasCostEvidence(row)
        ? 'costR_or_avgCostR_fallback/closedCompleted'
        : 'none';
}
function getPositiveR(row = {}, aggregateKey, realKey = null, shadowKey = null) {
    const virtualShadow = sourceMetricSum(row, realKey, shadowKey);
    if (virtualShadow !== 0) {
        return Math.max(0, virtualShadow);
    }
    if (aggregateKey && hasValue(row[aggregateKey])) {
        return Math.max(0, num(row[aggregateKey], 0));
    }
    return 0;
}
function getAbsLossR(row = {}, aggregateKey, realKey = null, shadowKey = null) {
    const virtualShadow = sourceMetricSum(row, realKey, shadowKey);
    if (virtualShadow !== 0) {
        return Math.abs(virtualShadow);
    }
    if (aggregateKey && hasValue(row[aggregateKey])) {
        return Math.abs(num(row[aggregateKey], 0));
    }
    return 0;
}
function getProfitFactor(row = {}) {
    if (hasValue(row.longNetProfitFactor) && !hasVirtualShadowOutcomeFields(row))
return num(row.longNetProfitFactor, 0);
    if (hasValue(row.netLongProfitFactor) && !hasVirtualShadowOutcomeFields(row))
return num(row.netLongProfitFactor, 0);
    if (hasValue(row.netProfitFactor) && !hasVirtualShadowOutcomeFields(row)) return
num(row.netProfitFactor, 0);
    if (hasValue(row.profitFactor) && !hasVirtualShadowOutcomeFields(row)) return
num(row.profitFactor, 0);
    const winR = Math.max(
         getPositiveR(row, 'netWinR', 'realNetWinR', 'shadowNetWinR'),
         getPositiveR(row, 'totalWinR', 'realTotalWinR', 'shadowTotalWinR'),
         getPositiveR(row, 'grossWinR', 'realGrossWinR', 'shadowGrossWinR'),
         0
    );
    const lossR = Math.max(
         getAbsLossR(row, 'netLossR', 'realNetLossR', 'shadowNetLossR'),
         getAbsLossR(row, 'totalLossR', 'realTotalLossR', 'shadowTotalLossR'),
         getAbsLossR(row, 'grossLossR', 'realGrossLossR', 'shadowGrossLossR'),
         0
    );
    if (winR <= 0 && lossR <= 0) return 0;
    if (lossR <= 0) return winR > 0 ? 99 : 0;
    return winR / lossR;
}
function getCountMetric(row = {}, realCountKey, aggregateCountKey) {
    const shadowCountKey = realCountKey && String(realCountKey).startsWith('real')
         ? `shadow${String(realCountKey).slice(4)}`
         : null;
    return getLearningCount(
         row,
         aggregateCountKey,
         realCountKey,
         shadowCountKey
    );
}
function getPctMetric(row = {}, realPctKey, realCountKey, aggregatePctKey,
aggregateCountKey = null) {
    if (hasValue(row[aggregatePctKey]) && !hasVirtualShadowOutcomeFields(row)) {
         return clamp(row[aggregatePctKey], 0, 1);
    }
    const completed = getCompletedSample(row);
    const fallbackCountKey = aggregateCountKey || String(aggregatePctKey ||
'').replace(/Pct$/i, 'Count');
    const count = getCountMetric(row, realCountKey, fallbackCountKey);
    if (completed <= 0 || count <= 0) return 0;
    return clamp(count / completed, 0, 1);
}
function getDirectSLCount(row = {}) {
    const sourceCount =
        num(row.virtualDirectSLCount, 0) +
        num(row.shadowDirectSLCount, 0);
    if (sourceCount > 0) return sourceCount;
    if (hasValue(row.directSLCount)) return num(row.directSLCount, 0);
    if (Array.isArray(row.recentOutcomes) && row.recentOutcomes.length > 0) {
        return row.recentOutcomes
          .filter(Boolean)
          .filter(isCurrentMeasurementOutcome)
          .filter(isLongRow)
          .filter((outcome) => isLearningOutcomeSource(outcome.source ||
outcome.outcomeSource || 'VIRTUAL'))
          .filter((outcome) => Boolean(outcome.directSL || outcome.directToSL ||
outcome.directStopLoss || outcome.isDirectSL))
          .length;
    }
    return 0;
}
function getDirectSLPct(row = {}) {
    const completed = getCompletedSample(row);
    if (completed <= 0) return 0;
    if (hasValue(row.directSLPct) && !hasVirtualShadowOutcomeFields(row)) {
        return clamp(row.directSLPct, 0, 1);
    }
    return clamp(getDirectSLCount(row) / completed, 0, 1);
}
function wilsonLowerBound(successes, trials, z = WINRATE_Z) {
    const n = num(trials, 0);
    if (n <= 0) return 0;
    const p = clamp(successes / n, 0, 1);
    const z2 = z * z;
    const numerator =
        p +
        z2 / (2 * n) -
        z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
    const denominator = 1 + z2 / n;
    return clamp(numerator / denominator, 0, 1);
}
function sampleReliability(sample, cap = SAMPLE_RELIABILITY_CAP) {
    const n = num(sample, 0);
    if (n <= 0) return 0;
    return clamp(Math.sqrt(Math.min(n, cap) / cap), 0, 1);
}
function getSampleAdjustedWinrate(row = {}) {
    const counts = getOutcomeCounts(row);
    const completedSample = counts.total;
    const observationSample = getObservationSample(row);
if (completedSample <= 0) {
     return {
          sample: 0,
          outcomeSample: 0,
          observationSample,
          wins: 0,
          losses: 0,
          flats: 0,
          rawWinrate: 0,
          bayesianWinrate: 0,
          wilsonLowerBound: 0,
          reliability: 0,
          observationReliability: sampleReliability(observationSample),
          score: 0,
          awaitingOutcomes: observationSample > 0
     };
}
// Alleen netR > 0 telt als winst. Een flat blijft een flat.
const successes = counts.wins;
const rawWinrate = clamp(successes / completedSample, 0, 1);
const bayesianWinrate = clamp(
     (successes + WINRATE_BAYES_ALPHA) /
          (completedSample + WINRATE_BAYES_ALPHA + WINRATE_BAYES_BETA),
     0,
     1
);
const wilson = wilsonLowerBound(successes, completedSample);
const reliability = sampleReliability(completedSample);
const score = clamp(
     wilson * 0.8 +
          bayesianWinrate * 0.15 +
          rawWinrate * 0.05,
     0,
     1
);
return {
     sample: completedSample,
     outcomeSample: completedSample,
     observationSample,
     wins: counts.wins,
     losses: counts.losses,
     flats: counts.flats,
     rawWinrate,
     bayesianWinrate,
     wilsonLowerBound: wilson,
     reliability,
     score,
         awaitingOutcomes: false
    };
}
function getObservationActivityScore(row = {}, meta = null) {
    const sample = meta?.observationSample ?? getObservationSample(row);
    if (sample <= 0) return 0;
    const seenComponent = Math.log1p(sample) * 8;
    const reliabilityComponent = sampleReliability(sample) * 18;
    const scannerReasonBonus = row.scannerReason || row.scannerReasonCoarse
         ? 2
         : 0;
    const definitionBonus = getDefinitionParts(row).length > 0
         ? 2
         : 0;
    return Math.max(
         1,
         Math.min(45, seenComponent + reliabilityComponent + scannerReasonBonus +
definitionBonus)
    );
}
function getPerformanceBalancedScore(row = {}, meta = null) {
    const winrateMeta = meta || getSampleAdjustedWinrate(row);
    const totalR = Math.max(0, getTotalR(row));
    const avgR = Math.max(0, getAvgR(row));
    const profitFactor = Math.min(Math.max(0, getProfitFactor(row)), 20);
    const directSLPct = getDirectSLPct(row);
    const nearTpThenLossPct = getPctMetric(row, 'realNearTpThenLossPct',
'realNearTpThenLossCount', 'nearTpThenLossPct', 'nearTpThenLossCount');
    const gaveBackAfterOneRPct = getPctMetric(row, 'realGaveBackAfterOneRPct',
'realGaveBackAfterOneRCount', 'gaveBackAfterOneRPct', 'gaveBackAfterOneRCount');
    const avgCostR = Math.max(0, getAvgCostR(row));
    const winrateComponent = winrateMeta.score * 100;
    const reliabilityComponent = winrateMeta.reliability * 20;
    const totalRComponent = Math.log1p(totalR) * 12;
    const avgRComponent = Math.log1p(avgR) * 8;
    const pfComponent = Math.log1p(profitFactor) * 3;
    const riskPenalty =
         directSLPct * 60 +
         nearTpThenLossPct * 45 +
         gaveBackAfterOneRPct * 20 +
         avgCostR * 3;
    return (
         winrateComponent +
         reliabilityComponent +
         totalRComponent +
         avgRComponent +
         pfComponent -
         riskPenalty
    );
}
function getDashboardBalancedScore(row = {}, meta = null) {
    const winrateMeta = meta || getSampleAdjustedWinrate(row);
    if (winrateMeta.outcomeSample <= 0 && winrateMeta.observationSample > 0) {
         return getObservationActivityScore(row, winrateMeta);
    }
    return getPerformanceBalancedScore(row, winrateMeta);
}
function learningStatusFor(row = {}, meta = null) {
    const winrateMeta = meta || getSampleAdjustedWinrate(row);
    if (winrateMeta.outcomeSample >= MIN_COMPLETED_ACTIVE_LEARNING) return
'ACTIVE_LEARNING';
    if (winrateMeta.outcomeSample > 0) return 'EARLY_OUTCOMES';
    return 'OBSERVING';
}
function tierFor(row = {}, meta = null) {
    const winrateMeta = meta || getSampleAdjustedWinrate(row);
    if (isEmpiricallyVetoed(row, winrateMeta)) return 'EMPIRICAL_VETO';
    if (winrateMeta.outcomeSample >= MIN_COMPLETED_ACTIVE_LEARNING) return 'HARD';
    if (winrateMeta.outcomeSample > 0) return 'SOFT';
    if (winrateMeta.observationSample > 0) return 'OBSERVATION';
    return 'RAW';
}
function scannerMetadata(row = {}) {
    return {
         scannerMicroFamilyId: row.scannerMicroFamilyId || null,
         scannerFamilyId: row.scannerFamilyId || null,
         scannerDefinition: row.scannerDefinition || null,
         scannerDefinitionParts: Array.isArray(row.scannerDefinitionParts)
           ? row.scannerDefinitionParts
           : [],
         scannerFingerprintRole: 'METADATA_ONLY',
         scannerFingerprintsMetadataOnly: true,
         scannerFingerprintsUsedAsLearningFamily: false,
         executionMicroFamilyId: row.executionMicroFamilyId || null,
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
function pct01To100(value, fallback = null) {
    if (
        value === undefined ||
        value === null ||
        value === ''
    ) {
        return fallback;
    }
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    if (Math.abs(n) <= 1) return n * 100;
    return n;
}
function normalizeMarketRegime(value = '') {
    const raw = upper(value);
    if (!raw) return 'UNKNOWN';
    if (
        raw.includes('SQUEEZE') ||
        raw.includes('COMPRESSION') ||
        raw.includes('VOLATILITY_CONTRACTION')
    ) {
        return 'SQUEEZE';
    }
    if (
        raw.includes('CHOP') ||
        raw.includes('RANGE') ||
        raw.includes('SIDEWAYS') ||
        raw.includes('NEUTRAL')
    ) {
        return 'CHOP';
    }
    if (
        raw.includes('TREND') ||
        raw.includes('IMPULSE') ||
        raw.includes('MOMENTUM') ||
        raw.includes('BREAKOUT')
    ) {
        return 'TREND';
    }
    return 'UNKNOWN';
}
function normalizeMarketTrendSide(value = '') {
    const raw = upper(value);
    if (!raw) return 'UNKNOWN';
    if (
        raw === 'BEAR' ||
        raw === 'BEARISH' ||
        raw === 'SHORT' ||
        raw === 'SELL' ||
        raw === 'DOWN' ||
        raw.includes('BEAR')
    ) {
        return 'bear';
    }
    if (
        raw === 'BULL' ||
        raw === 'BULLISH' ||
        raw === 'LONG' ||
        raw === 'BUY' ||
        raw === 'UP' ||
        raw.includes('BULL')
    ) {
        return 'bull';
    }
    if (
        raw === 'CHOP' ||
        raw === 'RANGE' ||
        raw === 'SIDEWAYS' ||
        raw === 'NEUTRAL' ||
        raw.includes('NEUTRAL')
    ) {
        return 'neutral';
    }
    return 'UNKNOWN';
}
function marketWeatherObjectCandidates(payload = null) {
    if (!payload || typeof payload !== 'object') return [];
    return [
        payload.marketWeather,
        payload.currentMarketWeather,
        payload.weather,
        payload.marketWeatherSummary,
        payload.current,
        payload.summary,
        payload.market,
        payload.overview,
        payload.data?.marketWeather,
        payload.data?.currentMarketWeather,
        payload.data?.weather,
        payload.data?.marketWeatherSummary,
        payload.data?.current,
        payload.data?.summary,
        payload.data?.market,
        payload.data?.overview,
         payload.data,
         payload
    ].filter((value) => (
         value &&
         typeof value === 'object' &&
         !Array.isArray(value)
    ));
}
function marketWeatherShapeScore(value = {}) {
    if (!value || typeof value !== 'object') return -1;
    const fields = [
         value.currentRegime,
         value.regime,
         value.marketRegime,
         value.regimeBucket,
         value.currentTrendSide,
         value.trendSide,
         value.dashboardSide,
         value.marketSide,
         value.bearishPct,
         value.bullishPct,
         value.squeezePct,
         value.breadth?.bearishPct,
         value.breadth?.bullishPct,
         value.breadth?.squeezePct,
         value.bearishCount,
         value.bullishCount,
         value.squeezeCount,
         value.universeCount,
         value.count
    ];
    return fields.reduce(
         (score, field) => score + (field !== undefined && field !== null && field !==
'' ? 1 : 0),
         0
    );
}
function unwrapMarketWeatherPayload(payload = null) {
    const candidates = marketWeatherObjectCandidates(payload);
    if (!candidates.length) return null;
    return [...candidates]
         .sort((a, b) => marketWeatherShapeScore(b) - marketWeatherShapeScore(a))[0];
}
function timestampMs(value) {
    if (value === undefined || value === null || value === '') return 0;
    if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value.trim())) {
         const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    if (n < 10_000_000_000) return Math.round(n * 1000);
    return Math.round(n);
}
function ratioCountToPct(count, total) {
    if (
        count === undefined ||
        count === null ||
        count === '' ||
        total === undefined ||
        total === null ||
        total === ''
    ) {
        return null;
    }
    const c = Number(count);
    const t = Number(total);
    if (!Number.isFinite(c) || !Number.isFinite(t) || t <= 0) return null;
    return clamp(c / t * 100, 0, 100);
}
function normalizeMarketWeather(payload = null, sourceKey = null, redisSource =
null) {
    const data = unwrapMarketWeatherPayload(payload);
    if (!data || typeof data !== 'object') {
        return {
           available: false,
           usable: false,
           ok: false,
           sourceKey,
           sourceKeys: sourceKey ? [sourceKey] : [],
           redisSource,
           redisSources: redisSource ? [redisSource] : [],
           reason: 'MARKET_WEATHER_EMPTY',
           currentRegime: 'UNKNOWN',
           currentTrendSide: 'UNKNOWN',
           bearishPct: null,
           bullishPct: null,
           squeezePct: null,
           confidence: 0,
           timestamp: 0,
           timestampKnown: false,
           ageSec: null,
           stale: false,
           qualityScore: 0
     };
}
const nestedCurrent = data.current && typeof data.current === 'object'
     ? data.current
     : {};
const nestedSummary = data.summary && typeof data.summary === 'object'
     ? data.summary
     : {};
const nestedBreadth = data.breadth && typeof data.breadth === 'object'
     ? data.breadth
     : {};
const currentRegime = normalizeMarketRegime(
     data.currentRegime ||
          data.regime ||
          data.marketRegime ||
          data.regimeBucket ||
          data.btcRegime ||
          data.state ||
          nestedCurrent.currentRegime ||
          nestedCurrent.regime ||
          nestedSummary.currentRegime ||
          nestedSummary.regime ||
          nestedBreadth.regime
);
const currentTrendSide = normalizeMarketTrendSide(
     data.currentTrendSide ||
          data.trendSide ||
          data.dashboardSide ||
          data.marketSide ||
          data.side ||
          data.bias ||
          data.direction ||
          nestedCurrent.currentTrendSide ||
          nestedCurrent.trendSide ||
          nestedCurrent.side ||
          nestedSummary.currentTrendSide ||
          nestedSummary.trendSide ||
          nestedSummary.side ||
          nestedBreadth.side
);
const universeCount = firstFiniteNumber([
     data.universeCount,
     data.totalCount,
     data.symbolCount,
     data.count,
     nestedSummary.universeCount,
     nestedSummary.totalCount,
     nestedBreadth.universeCount,
     nestedBreadth.totalCount
]);
const bearishPctDirect = pct01To100(
     data.bearishPct ??
       data.bearPct ??
       data.shortPct ??
       data.upPct ??
       data.bearishBreadth ??
       nestedCurrent.bearishPct ??
       nestedSummary.bearishPct ??
       nestedBreadth.bearishPct ??
       nestedBreadth.bearPct ??
       nestedBreadth.shortPct ??
       nestedBreadth.upPct,
     null
);
const bullishPctDirect = pct01To100(
     data.bullishPct ??
       data.bullPct ??
       data.longPct ??
       data.downPct ??
       data.bullishBreadth ??
       nestedCurrent.bullishPct ??
       nestedSummary.bullishPct ??
       nestedBreadth.bullishPct ??
       nestedBreadth.bullPct ??
       nestedBreadth.longPct ??
       nestedBreadth.downPct,
     null
);
const squeezePctDirect = pct01To100(
     data.squeezePct ??
       data.compressionPct ??
       data.squeezeBreadth ??
       nestedCurrent.squeezePct ??
       nestedSummary.squeezePct ??
       nestedBreadth.squeezePct ??
       nestedBreadth.compressionPct,
     null
);
const bearishPct = bearishPctDirect ?? ratioCountToPct(
     firstFiniteNumber([
       data.bearishCount,
       data.bearCount,
       data.shortCount,
       data.upCount,
       nestedSummary.bearishCount,
       nestedBreadth.bearishCount
     ]),
     universeCount
);
const bullishPct = bullishPctDirect ?? ratioCountToPct(
     firstFiniteNumber([
       data.bullishCount,
       data.bullCount,
       data.longCount,
       data.downCount,
       nestedSummary.bullishCount,
       nestedBreadth.bullishCount
     ]),
     universeCount
);
const squeezePct = squeezePctDirect ?? ratioCountToPct(
     firstFiniteNumber([
       data.squeezeCount,
       data.compressionCount,
       nestedSummary.squeezeCount,
       nestedBreadth.squeezeCount
     ]),
     universeCount
);
const confidenceRaw = pct01To100(
     data.confidence ??
       data.marketConfidence ??
       data.weatherConfidence ??
       data.currentTrendConfidence ??
       data.breadthConfidence ??
       data.score ??
       data.weatherScore ??
       nestedCurrent.confidence ??
       nestedSummary.confidence ??
       nestedBreadth.confidence,
     null
);
const confidence = confidenceRaw === null
     ? 0.6
     : clamp(confidenceRaw / 100, 0, 1);
const timestamp = Math.max(
     timestampMs(data.generatedAt),
     timestampMs(data.completedAt),
     timestampMs(data.updatedAt),
     timestampMs(data.createdAt),
     timestampMs(data.serverTs),
     timestampMs(data.ts),
     timestampMs(payload?.generatedAt),
     timestampMs(payload?.completedAt),
     timestampMs(payload?.updatedAt),
     timestampMs(payload?.createdAt),
     timestampMs(payload?.serverTs),
     timestampMs(payload?.ts)
);
const timestampKnown = timestamp > 0;
const ageSec = timestampKnown
     ? Math.max(0, Math.round((now() - timestamp) / 1000))
     : null;
const stale = timestampKnown
     ? ageSec > CURRENT_FIT_MAX_WEATHER_AGE_SEC
     : false;
const usable = (
     currentRegime !== 'UNKNOWN' ||
     currentTrendSide !== 'UNKNOWN' ||
     bearishPct !== null ||
     bullishPct !== null ||
     squeezePct !== null
);
const available = usable && !stale;
return {
     available,
     usable,
     ok: available,
     upstreamOk: payload?.ok !== false && data?.ok !== false,
     sourceKey,
     sourceKeys: sourceKey ? [sourceKey] : [],
     redisSource,
     redisSources: redisSource ? [redisSource] : [],
     reason: !usable
       ? 'MARKET_WEATHER_INCOMPLETE'
       : stale
         ? 'MARKET_WEATHER_STALE'
         : null,
     currentRegime,
     currentTrendSide,
     bearishPct: bearishPct === null ? null : round(bearishPct, 2),
     bullishPct: bullishPct === null ? null : round(bullishPct, 2),
     squeezePct: squeezePct === null ? null : round(squeezePct, 2),
     confidence: round(confidence, 4),
     universeCount: universeCount === null ? null : round(universeCount, 2),
     createdAt: data.createdAt || payload?.createdAt || null,
     updatedAt: data.updatedAt || payload?.updatedAt || null,
     generatedAt: data.generatedAt || payload?.generatedAt || null,
         timestamp,
         timestampKnown,
         ageSec,
         stale,
         rawRegime: data.regime || data.currentRegime || null,
         rawTrendSide: data.trendSide || data.currentTrendSide || data.dashboardSide ||
null,
         qualityScore: marketWeatherShapeScore(data)
    };
}
function marketWeatherSourcePriority(row = {}) {
    let score = 0;
    if (row.redisSource === 'volatile') score += 20;
    if (row.redisSource === 'durable') score += 10;
    if (row.sourceKey === LONG_MARKET_WEATHER_KEY) score += 8;
    if (row.sourceKey === MARKET_WEATHER_KEY) score += 5;
    if (row.sourceKey === LONG_MARKET_UNIVERSE_KEY) score += 3;
    if (row.sourceKey === MARKET_UNIVERSE_KEY) score += 2;
    if (row.sourceKey === LONG_TRADE_RUN_META_KEY) score += 1;
    return score;
}
function mergeMarketWeatherRows(rows = []) {
    const normalized = getArray(rows)
         .filter(Boolean)
         .sort((a, b) => (
             Number(b.available) - Number(a.available) ||
             Number(b.usable) - Number(a.usable) ||
             num(b.timestamp, 0) - num(a.timestamp, 0) ||
             num(b.qualityScore, 0) - num(a.qualityScore, 0) ||
             marketWeatherSourcePriority(b) - marketWeatherSourcePriority(a)
         ));
    if (!normalized.length) {
         return normalizeMarketWeather(null, null, null);
    }
    const usableRows = normalized.filter((row) => row.available);
    const mergeRows = usableRows.length > 0
         ? usableRows
         : normalized.filter((row) => row.usable);
    const base = mergeRows[0] || normalized[0];
    const firstKnown = (field, invalid = null) => {
         for (const row of mergeRows) {
             const value = row?.[field];
             if (value === undefined || value === null || value === '') continue;
             if (invalid !== null && value === invalid) continue;
             return value;
         }
         return base?.[field] ?? null;
};
const timestamp = Math.max(...mergeRows.map((row) => num(row.timestamp, 0)), 0);
const timestampKnown = timestamp > 0;
const ageSec = timestampKnown
     ? Math.max(0, Math.round((now() - timestamp) / 1000))
     : null;
const stale = timestampKnown
     ? ageSec > CURRENT_FIT_MAX_WEATHER_AGE_SEC
     : Boolean(base?.stale);
const currentRegime = firstKnown('currentRegime', 'UNKNOWN') || 'UNKNOWN';
const currentTrendSide = firstKnown('currentTrendSide', 'UNKNOWN') || 'UNKNOWN';
const bearishPct = firstKnown('bearishPct');
const bullishPct = firstKnown('bullishPct');
const squeezePct = firstKnown('squeezePct');
const usable = (
     currentRegime !== 'UNKNOWN' ||
     currentTrendSide !== 'UNKNOWN' ||
     bearishPct !== null ||
     bullishPct !== null ||
     squeezePct !== null
);
const available = usable && !stale;
return {
     ...base,
     available,
     usable,
     ok: available,
     reason: !usable
       ? 'MARKET_WEATHER_INCOMPLETE'
       : stale
         ? 'MARKET_WEATHER_STALE'
         : null,
     currentRegime,
     currentTrendSide,
     bearishPct,
     bullishPct,
     squeezePct,
     confidence: firstKnown('confidence') ?? 0.6,
     universeCount: firstKnown('universeCount'),
     timestamp,
     timestampKnown,
     ageSec,
     stale,
     sourceKey: base?.sourceKey || null,
     redisSource: base?.redisSource || null,
     sourceKeys: uniqueStrings(mergeRows.map((row) => row.sourceKey)),
     redisSources: uniqueStrings(mergeRows.map((row) => row.redisSource)),
         candidatesRead: normalized.length,
         usableCandidates: mergeRows.length
    };
}
async function readJsonFromAnyRedis(keys = []) {
    const durableRedis = getDurableRedis();
    const volatileRedis = getVolatileRedis();
    const clients = [
         {
              name: 'volatile',
              redis: volatileRedis
         },
         {
              name: 'durable',
              redis: durableRedis
         }
    ];
    const jobs = [];
    for (const key of uniqueStrings(keys)) {
         for (const client of clients) {
              if (!client.redis || !key) continue;
              jobs.push(
                   withTimeout(
                       getJson(client.redis, key, null),
                       MARKET_WEATHER_SINGLE_READ_TIMEOUT_MS,
                       `MARKET_WEATHER_SINGLE_READ_TIMEOUT:${client.name}:${key}`
                   )
                       .then((payload) => ({
                         key,
                         redis: client.name,
                         payload
                       }))
                       .catch((error) => ({
                         key,
                         redis: client.name,
                         payload: null,
                         error: error?.message || String(error)
                       }))
              );
         }
    }
    const results = await Promise.all(jobs);
    return results.filter((row) => (
         row.payload &&
         typeof row.payload === 'object'
    ));
}
async function getCurrentMarketWeatherSafe() {
 const cachedAge = cache.marketWeather
     ? now() - cache.marketWeather.ts
     : Number.POSITIVE_INFINITY;
 const cachedTtl = cache.marketWeather?.value?.available
     ? MARKET_WEATHER_CACHE_TTL_MS
     : MARKET_WEATHER_NEGATIVE_CACHE_TTL_MS;
 if (cache.marketWeather && cachedAge <= cachedTtl) {
     return cache.marketWeather.value;
 }
 try {
     const foundRows = await withTimeout(
          readJsonFromAnyRedis(MARKET_WEATHER_READ_KEYS),
          MARKET_WEATHER_TIMEOUT_MS,
          'MARKET_WEATHER_READ_TIMEOUT'
     );
     const normalizedRows = foundRows.map((found) => (
          normalizeMarketWeather(
              found.payload,
              found.key,
              found.redis
          )
     ));
     const value = mergeMarketWeatherRows(normalizedRows);
     cache.marketWeather = {
          ts: now(),
          value
     };
     return value;
 } catch (error) {
     const staleCached = cache.marketWeather?.value;
     const value = staleCached?.usable
          ? {
                  ...staleCached,
                  available: false,
                  ok: false,
                  stale: true,
                  reason: error?.message || String(error)
              }
          : {
                  available: false,
                  usable: false,
                  ok: false,
                  sourceKey: null,
                  sourceKeys: [],
                  redisSource: null,
                  redisSources: [],
                    reason: error?.message || String(error),
                    currentRegime: 'UNKNOWN',
                    currentTrendSide: 'UNKNOWN',
                    bearishPct: null,
                    bullishPct: null,
                    squeezePct: null,
                    confidence: 0,
                    timestamp: 0,
                    timestampKnown: false,
                    ageSec: null,
                    stale: false,
                    candidatesRead: 0,
                    usableCandidates: 0
               };
        cache.marketWeather = {
             ts: now(),
             value
        };
        return value;
    }
}
function currentFitForMicro(row = {}, marketWeather = null) {
    const id = getTrueMicroFamilyId(row);
    const parsed = parseLongTaxonomyMicroId(id);
    const unavailableReason = !parsed?.isChild
        ? 'INVALID_OR_NON_SELECTABLE_75_CHILD_ID'
        : marketWeather?.reason || 'MARKET_WEATHER_UNAVAILABLE';
    const unavailable = {
        currentFit: 'UNKNOWN',
        currentFitLabel: 'UNKNOWN',
        currentFitCanonical: 'UNKNOWN',
        currentFitScore: 0,
        fitScore: 0,
        currentFitConfidence: 0,
        currentFitReason: unavailableReason,
        currentFitReasons: [unavailableReason],
        currentFitVersion: CURRENT_FIT_VERSION,
        currentFitSoftOnly: true,
        currentFitBlocksLearning: false,
        currentFitBlocksVirtualLearning: false,
        currentFitBlocksShadowLearning: false,
        currentFitBlocksDiscord: true,
        discordCurrentFitAllowed: false,
        discordCurrentFitGateReason: 'DISCORD_BLOCKED_CURRENT_FIT_UNKNOWN',
        learningRemainsBroad: true,
        currentMarketRegime: marketWeather?.currentRegime || 'UNKNOWN',
        currentMarketTrendSide: marketWeather?.currentTrendSide || 'UNKNOWN',
      currentBearishPct: marketWeather?.bearishPct ?? null,
      currentBullishPct: marketWeather?.bullishPct ?? null,
      currentSqueezePct: marketWeather?.squeezePct ?? null,
      currentMarketWeatherAvailable: false,
      currentMarketWeatherStale: Boolean(marketWeather?.stale),
      currentMarketWeatherAgeSec: marketWeather?.ageSec ?? null,
      currentMarketWeatherSourceKey: marketWeather?.sourceKey || null,
      currentMarketWeatherRedisSource: marketWeather?.redisSource || null,
      currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE'
 };
 if (!parsed?.isChild || !marketWeather?.available) {
      return unavailable;
 }
 const reasons = [];
 let score = 0;
 const marketRegime = normalizeMarketRegime(marketWeather.currentRegime);
 const marketTrendSide =
normalizeMarketTrendSide(marketWeather.currentTrendSide);
 const bearishPct = pct01To100(marketWeather.bearishPct, null);
 const bullishPct = pct01To100(marketWeather.bullishPct, null);
 const squeezePct = pct01To100(marketWeather.squeezePct, null);
 if (marketTrendSide === 'bull') {
      score += 30;
      reasons.push('MARKET_TREND_LONG');
 } else if (marketTrendSide === 'neutral' || marketTrendSide === 'UNKNOWN') {
      score += 4;
      reasons.push('MARKET_TREND_NEUTRAL_OR_UNKNOWN');
 } else {
      score -= 45;
      reasons.push('MARKET_TREND_AGAINST_LONG');
 }
 if (marketRegime !== 'UNKNOWN') {
      if (marketRegime === parsed.regime) {
          score += 25;
          reasons.push('FAMILY_REGIME_MATCH');
      } else if (
          (parsed.regime === 'TREND' && marketRegime === 'SQUEEZE') ||
          (parsed.regime === 'SQUEEZE' && marketRegime === 'TREND')
      ) {
          score += 8;
          reasons.push('FAMILY_REGIME_ADJACENT');
      } else {
          score -= 15;
          reasons.push('FAMILY_REGIME_MISMATCH');
      }
 } else {
      reasons.push('MARKET_REGIME_UNKNOWN');
}
if (bullishPct !== null) {
    if (bullishPct >= 60) {
        score += 15;
        reasons.push('BULLISH_BREADTH_STRONG');
    } else if (bullishPct >= 50) {
        score += 8;
        reasons.push('BULLISH_BREADTH_OK');
    } else if (bullishPct < 40) {
        score -= 12;
        reasons.push('BULLISH_BREADTH_WEAK');
    }
}
if (bearishPct !== null && bearishPct >= 60) {
    score -= 20;
    reasons.push('BEARISH_BREADTH_STRONG');
}
if (
    parsed.regime === 'SQUEEZE' &&
    squeezePct !== null &&
    squeezePct >= 40
) {
    score += 10;
    reasons.push('SQUEEZE_BREADTH_SUPPORTS_SETUP');
}
if (parsed.confirmationProfile === 'A_STRONG_ALIGN') {
    score += 8;
    reasons.push('CONFIRMATION_STRONG_ALIGN');
} else if (parsed.confirmationProfile === 'B_FLOW_ALIGN') {
    score += 5;
    reasons.push('CONFIRMATION_FLOW_ALIGN');
} else if (parsed.confirmationProfile === 'C_VOLUME_ALIGN') {
    score += 3;
    reasons.push('CONFIRMATION_VOLUME_ALIGN');
} else if (parsed.confirmationProfile === 'E_WEAK_CONTRA') {
    score -= 18;
    reasons.push('WEAK_CONTRA_CONFIRMATION');
}
const normalizedScore = clamp(score, -100, 100);
let canonical = 'NEUTRAL';
if (normalizedScore >= 45) canonical = 'MATCH';
else if (normalizedScore >= 18) canonical = 'WEAK_MATCH';
else if (normalizedScore <= -25) canonical = 'MISFIT';
const label = canonical === 'MATCH'
    ? 'FIT'
    : canonical === 'WEAK_MATCH'
        ? 'OK'
              : canonical;
    const marketConfidencePct = clamp(
         num(marketWeather.confidence, 0.5) * 100,
         0,
         100
    );
    const confidencePct = clamp(
         marketConfidencePct + Math.min(20, Math.abs(normalizedScore) / 2),
         0,
         100
    );
    const discordCurrentFitAllowed = canonical === 'MATCH' || canonical ===
'WEAK_MATCH';
    return {
         currentFit: label,
         currentFitLabel: label,
         currentFitCanonical: canonical,
         currentFitScore: round(normalizedScore, 2),
         fitScore: round(normalizedScore, 2),
         currentFitConfidence: round(confidencePct / 100, 4),
         currentFitReason: reasons.join('|'),
         currentFitReasons: reasons,
         currentFitVersion: CURRENT_FIT_VERSION,
         currentFitSoftOnly: true,
         currentFitBlocksLearning: false,
         currentFitBlocksVirtualLearning: false,
         currentFitBlocksShadowLearning: false,
         currentFitBlocksDiscord: !discordCurrentFitAllowed,
         discordCurrentFitAllowed,
         discordCurrentFitGateReason: discordCurrentFitAllowed
              ? 'DISCORD_CURRENT_FIT_OK'
              : `DISCORD_BLOCKED_CURRENT_FIT_${canonical}`,
         learningRemainsBroad: true,
         currentMarketRegime: marketRegime,
         currentMarketTrendSide: marketTrendSide,
         currentBearishPct: bearishPct === null ? null : round(bearishPct, 2),
         currentBullishPct: bullishPct === null ? null : round(bullishPct, 2),
         currentSqueezePct: squeezePct === null ? null : round(squeezePct, 2),
         currentMarketWeatherAvailable: true,
         currentMarketWeatherStale: Boolean(marketWeather.stale),
         currentMarketWeatherAgeSec: marketWeather.ageSec ?? null,
         currentMarketWeatherSourceKey: marketWeather.sourceKey || null,
         currentMarketWeatherRedisSource: marketWeather.redisSource || null,
         currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE'
    };
}
function buildRawMicroRow(row = {}, key = '', index = 0) {
const measurementSafeRow =
  sanitizeMeasurementRow(row);
row = measurementSafeRow;
const trueMicroFamilyId = getTrueMicroFamilyId(row, key);
if (!trueMicroFamilyId) return null;
if (!validLearningId(trueMicroFamilyId)) return null;
if (!isSelectableTrueMicroId(trueMicroFamilyId)) return null;
const parsed = parseLongTaxonomyMicroId(trueMicroFamilyId);
if (!parsed.selectable) return null;
const parentTrueMicroFamilyId = parsed.parentTrueMicroFamilyId;
const coarseMicroFamilyId = parentTrueMicroFamilyId;
const familyId = parentTrueMicroFamilyId;
const macroFamilyId = parentTrueMicroFamilyId;
const definitionParts = getDefinitionParts(row);
const macroDefinitionParts = getMacroDefinitionParts(row);
const inferredTradeSide = inferTradeSide({
  ...row,
  microFamilyId: trueMicroFamilyId,
  trueMicroFamilyId,
  coarseMicroFamilyId,
  parentTrueMicroFamilyId,
  familyId,
  macroFamilyId,
  definitionParts,
  macroDefinitionParts
});
if (inferredTradeSide === OPPOSITE_TRADE_SIDE) return null;
const completed = getCompletedSample(row);
const totalR = getTotalR(row);
const totalCostR = getTotalCostR(row);
const counts = getOutcomeCounts(row);
const directSLCount = getDirectSLCount(row);
const riskGeometry = getLongRiskGeometry(row);
return {
  sourceIndex: index,
  microFamilyId: trueMicroFamilyId,
  trueMicroFamilyId,
  analyzeMicroFamilyId: trueMicroFamilyId,
  learningMicroFamilyId: trueMicroFamilyId,
  childTrueMicroFamilyId: trueMicroFamilyId,
  parentTrueMicroFamilyId,
  coarseMicroFamilyId,
  baseMicroFamilyId: parentTrueMicroFamilyId,
  legacyMicroFamilyId: parentTrueMicroFamilyId,
  familyId,
  macroFamilyId,
  parentMacroFamilyId: parentTrueMicroFamilyId,
parentMicroFamilyId: parentTrueMicroFamilyId,
taxonomySetup: parsed.setup,
taxonomyRegime: parsed.regime,
confirmationProfile: parsed.confirmationProfile,
setupType: parsed.setup,
regimeBucket: parsed.regime,
...scannerMetadata(row),
...modePayload(),
fixedTaxonomyLearningId: true,
trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
learningGranularity: LEARNING_GRANULARITY,
parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
selectableTrueMicroFamily: true,
parentTrueMicroFamily: false,
scannerFingerprintLegacy: false,
legacyScannerFamilyFallback: false,
scannerFingerprintOnlyMetadata: true,
scannerFingerprintsMetadataOnly: true,
scannerFingerprintsUsedAsLearningFamily: false,
executionFingerprintsUsedAsLearningFamily: false,
inferredTradeSide,
inferredFromLongOnlyMode: inferredTradeSide === 'UNKNOWN',
sourceWeekKey: row.sourceWeekKey || PERSISTENT_LEARNING_KEY,
sourceWeekPrimary: row.sourceWeekPrimary !== false,
sourceWeekFallback: Boolean(row.sourceWeekFallback),
active: Boolean(row.active),
macroActive: Boolean(row.macroActive),
seen: num(row.seen ?? row.observations, 0),
observations: num(row.observations ?? row.seen, 0),
observationDuplicateSkippedCount: getObservationDuplicateSkippedCount(row),
seenCompletedRatio: round(getSeenCompletedRatio(row), 4),
completed: round(completed, 4),
virtualCompleted: num(row.virtualCompleted, 0),
shadowCompleted: num(row.shadowCompleted, 0),
realCompleted: 0,
wins: round(counts.wins, 4),
losses: round(counts.losses, 4),
flats: round(counts.flats, 4),
virtualWins: num(row.virtualWins, 0),
virtualLosses: num(row.virtualLosses, 0),
virtualFlats: num(row.virtualFlats, 0),
shadowWins: num(row.shadowWins, 0),
shadowLosses: num(row.shadowLosses, 0),
shadowFlats: num(row.shadowFlats, 0),
      realWins: 0,
      realLosses: 0,
      realFlats: 0,
      winrate: round(row.winrate, 4),
      bayesianWinrate: round(row.bayesianWinrate, 4),
      wilsonLowerBound: round(row.wilsonLowerBound, 4),
      totalR: round(totalR, 4),
      virtualTotalR: round(row.virtualTotalR, 4),
      shadowTotalR: round(row.shadowTotalR, 4),
      realTotalR: 0,
      avgR: round(getAvgR(row), 4),
      avgWinR: round(row.avgWinR, 4),
      avgLossR: round(row.avgLossR, 4),
      profitFactor: round(getProfitFactor(row), 4),
      directSLCount: round(directSLCount, 4),
      directSLPct: round(getDirectSLPct(row), 4),
      nearTpCount: round(getCountMetric(row, 'realNearTpCount', 'nearTpCount'), 4),
      nearTpPct: round(getPctMetric(row, 'realNearTpPct', 'realNearTpCount',
'nearTpPct', 'nearTpCount'), 4),
      reachedHalfRCount: round(getCountMetric(row, 'realReachedHalfRCount',
'reachedHalfRCount'), 4),
      reachedOneRCount: round(getCountMetric(row, 'realReachedOneRCount',
'reachedOneRCount'), 4),
      reachedHalfRPct: round(getPctMetric(row, 'realReachedHalfRPct',
'realReachedHalfRCount', 'reachedHalfRPct', 'reachedHalfRCount'), 4),
      reachedOneRPct: round(getPctMetric(row, 'realReachedOneRPct',
'realReachedOneRCount', 'reachedOneRPct', 'reachedOneRCount'), 4),
      beWouldExitCount: round(getCountMetric(row, 'realBeWouldExitCount',
'beWouldExitCount'), 4),
      beWouldExitPct: round(getPctMetric(row, 'realBeWouldExitPct',
'realBeWouldExitCount', 'beWouldExitPct', 'beWouldExitCount'), 4),
      gaveBackAfterHalfRCount: round(getCountMetric(row,
'realGaveBackAfterHalfRCount', 'gaveBackAfterHalfRCount'), 4),
      gaveBackAfterOneRCount: round(getCountMetric(row,
'realGaveBackAfterOneRCount', 'gaveBackAfterOneRCount'), 4),
      gaveBackAfterHalfRPct: round(getPctMetric(row, 'realGaveBackAfterHalfRPct',
'realGaveBackAfterHalfRCount', 'gaveBackAfterHalfRPct',
'gaveBackAfterHalfRCount'), 4),
      gaveBackAfterOneRPct: round(getPctMetric(row, 'realGaveBackAfterOneRPct',
'realGaveBackAfterOneRCount', 'gaveBackAfterOneRPct', 'gaveBackAfterOneRCount'),
4),
      nearTpThenLossCount: round(getCountMetric(row, 'realNearTpThenLossCount',
'nearTpThenLossCount'), 4),
      nearTpThenLossPct: round(getPctMetric(row, 'realNearTpThenLossPct',
'realNearTpThenLossCount', 'nearTpThenLossPct', 'nearTpThenLossCount'), 4),
      totalCostR: round(totalCostR, 4),
      avgCostR: round(getAvgCostR(row), 4),
      avgCostRFixSource: costFixSource(row),
      directSLFixSource: directSLCount > 0 ? 'directSLCount/closedCompleted' :
'none',
      riskTradeSide: TARGET_TRADE_SIDE,
      validLongGeometry: Boolean(riskGeometry.validGeometry),
      longValidGeometry: Boolean(riskGeometry.validGeometry),
      riskGeometryRule: riskGeometry.riskGeometryRule,
      tpHitRule: riskGeometry.tpHitRule,
      slHitRule: riskGeometry.slHitRule,
      grossRFormula: riskGeometry.grossRFormula,
      currentRFormula: riskGeometry.currentRFormula,
      longTpHit: riskGeometry.longTpHit,
      longSlHit: riskGeometry.longSlHit,
      tpHit: riskGeometry.longTpHit,
      slHit: riskGeometry.longSlHit,
      longGrossR: round(riskGeometry.longGrossR ?? row.longGrossR ?? row.grossR,
4),
      longCurrentR: round(riskGeometry.longCurrentR ?? row.longCurrentR ??
row.currentR, 4),
      currentR: round(riskGeometry.longCurrentR ?? row.currentR, 4),
      balancedScore: round(row.balancedScore, 4),
      definition: row.definition || row.microDefinition || null,
      definitionParts,
      macroDefinition: row.macroDefinition || row.parentDefinition || null,
      macroDefinitionParts,
      microDefinition: row.microDefinition || row.definition || null,
      microDefinitionParts: Array.isArray(row.microDefinitionParts)
        ? row.microDefinitionParts
        : definitionParts,
      assetClass: row.assetClass || null,
      rsiZone: row.rsiZone || null,
      rsiCoarse: row.rsiCoarse || null,
      rsiSlope: row.rsiSlope ?? null,
      rsiVelocity: row.rsiVelocity ?? null,
      rsiDelta: row.rsiDelta ?? null,
      rsiMomentum: row.rsiMomentum ?? null,
      flow: row.flow || null,
      flowCoarse: row.flowCoarse || null,
      obRelation: row.obRelation || null,
      obBias: row.obBias ?? null,
      obImbalance: row.obImbalance ?? null,
      orderbookImbalance: row.orderbookImbalance ?? null,
      bookImbalance: row.bookImbalance ?? null,
      bidAskImbalance: row.bidAskImbalance ?? null,
      spoofScore: row.spoofScore ?? null,
      orderbookSpoofScore: row.orderbookSpoofScore ?? null,
      obSpoofScore: row.obSpoofScore ?? null,
         fakeLiquidityScore: row.fakeLiquidityScore ?? null,
         btcState: row.btcState || null,
         btcRelation: row.btcRelation || null,
         regime: row.regime || null,
         regimeCoarse: row.regimeCoarse || null,
         scannerReason: row.scannerReason || null,
         scannerReasonCoarse: row.scannerReasonCoarse || null,
         ...temporalRowPayload(row),
         generatedEmptyTaxonomyRow: Boolean(row.generatedEmptyTaxonomyRow),
         createdAt: row.createdAt || null,
         updatedAt: row.updatedAt || null
    };
}
function decorateMicroRow(row = {}, marketWeather = null) {
    if (!row?.trueMicroFamilyId) return null;
    if (!isAnalyzeMicroRow(row)) return null;
    const winrate = getSampleAdjustedWinrate(row);
    const dashboardBalancedScore = getDashboardBalancedScore(row, winrate);
    const learningStatus = learningStatusFor(row, winrate);
    const gate = empiricalActivationGate(row, winrate);
    const tier = tierFor(row, winrate);
    const tooEarly = winrate.outcomeSample < MIN_COMPLETED_ACTIVE_LEARNING;
    const fit = currentFitForMicro(row, marketWeather);
    const discord = discordEligibilityFor(row, gate, fit);
    const storedActive = Boolean(row.storedActive ?? row.active);
    const storedMacroActive = Boolean(row.storedMacroActive ?? row.macroActive);
    const adaptiveScore = gate.blocked
         ? -1_000_000
         : dashboardBalancedScore +
           fit.currentFitScore * 0.15 +
           winrate.reliability * 10 -
           getDirectSLPct(row) * 10 -
           getAvgCostR(row) * 2;
    return {
         ...row,
         ...modePayload(),
         ...fit,
         storedActive,
         storedMacroActive,
         active: storedActive && discord.eligible,
         macroActive: storedMacroActive && discord.eligible,
         selectionSuppressedByDiscordGate:
           storedActive && !discord.eligible,
         empiricalVetoRemovedFromActiveDisplay:
           gate.blocked && storedActive,
         discordEligible: discord.eligible,
         discordBlocked: discord.blocked,
         discordActivationGatePassed: discord.gatePassed,
   discordBlockReason: discord.reason,
   completed: round(winrate.outcomeSample, 4),
   wins: round(winrate.wins, 4),
   losses: round(winrate.losses, 4),
   flats: round(winrate.flats, 4),
   outcomeSample: round(winrate.outcomeSample, 4),
   observationSample: round(winrate.observationSample, 4),
   observationDuplicateSkippedCount: getObservationDuplicateSkippedCount(row),
   seenCompletedRatio: round(getSeenCompletedRatio(row), 4),
   winrateSample: round(winrate.sample, 4),
   sampleAdjustedWinrate: round(winrate.score, 4),
   sampleRawWinrate: round(winrate.rawWinrate, 4),
   sampleBayesianWinrate: round(winrate.bayesianWinrate, 4),
   sampleWilsonLowerBound: round(winrate.wilsonLowerBound, 4),
   sampleReliability: round(winrate.reliability, 4),
   observationReliability: round(
        winrate.observationReliability ??
            sampleReliability(winrate.observationSample),
        4
   ),
   winrate: round(winrate.rawWinrate, 4),
   bayesianWinrate: round(winrate.bayesianWinrate, 4),
   wilsonLowerBound: round(winrate.wilsonLowerBound, 4),
   fairWinrate: round(winrate.score, 4),
   totalR: round(getTotalR(row), 4),
   avgR: round(getAvgR(row), 4),
   profitFactor: round(getProfitFactor(row), 4),
   totalCostR: round(getTotalCostR(row), 4),
   avgCostR: round(getAvgCostR(row), 4),
   directSLCount: round(getDirectSLCount(row), 4),
   directSLPct: round(getDirectSLPct(row), 4),
   dashboardBalancedScore: round(row.dashboardBalancedScore ??
dashboardBalancedScore, 4),
   balancedScore: round(row.balancedScore ?? dashboardBalancedScore, 4),
   adaptiveScore: round(
        gate.blocked
            ? -1_000_000
            : row.adaptiveScore ?? adaptiveScore,
        4
   ),
   recentMomentumScore: round(
        gate.blocked
            ? -35
            : row.recentMomentumScore ?? 0,
        4
   ),
   activationGateStatus: gate.status,
         activationGateReason: gate.reason,
         activationGatePassed: gate.status === 'PASSED',
         empiricalVeto: gate.blocked,
         empiricalVetoed: gate.blocked,
         empiricalVetoPolicyVersion: EMPIRICAL_VETO_POLICY_VERSION,
         empiricalVetoMinCompleted: gate.minCompleted,
         empiricalVetoMaxAvgR: gate.maxAvgR,
         empiricalVetoCompleted: round(gate.completed, 4),
         empiricalVetoAvgR: round(gate.avgR, 4),
         empiricalVetoTotalR: round(gate.totalR, 4),
         empiricalVetoReason: gate.blocked ? gate.reason : null,
         empiricalVetoBlocksAdaptiveSelection: true,
         empiricalVetoBlocksManualActivation: true,
         empiricalVetoCanRecover: true,
         discordEmpiricalVetoAllowed: !gate.blocked,
         discordEmpiricalVetoGateReason: gate.blocked
           ? 'EMPIRICAL_VETO_CURRENT_MEASUREMENT_NET_EDGE_NOT_POSITIVE'
           : null,
         awaitingOutcomes: Boolean(winrate.awaitingOutcomes),
         learningStatus,
         status: learningStatus,
         tooEarly,
         tooEarlyReason: tooEarly
           ? `COMPLETED_BELOW_${MIN_COMPLETED_ACTIVE_LEARNING}`
           : null,
         tier,
         selectedTier: gate.blocked
           ? 'EMPIRICAL_VETO'
           : row.selectedTier || row.rotationEligibilityTier || tier,
         rotationEligibilityTier: gate.blocked
           ? 'EMPIRICAL_VETO'
           : row.rotationEligibilityTier || row.selectedTier || tier,
         minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,
         avgCostRFixSource: costFixSource(row),
         directSLFixSource: getDirectSLCount(row) > 0 ? 'directSLCount/closedCompleted'
: 'none'
    };
}
function buildRowsFromMicros(micros = {}, marketWeather = null) {
    return sourceEntriesFromMicros(micros)
         .map(([key, row], index) => {
           const measurementSafeRow =
                sanitizeMeasurementRow(row);
           const id = getTrueMicroFamilyId(
                measurementSafeRow,
                key
           );
             if (!id) return null;
             if (!validLearningId(id)) return null;
             if (!isSelectableTrueMicroId(id)) return null;
             const parsed = parseLongTaxonomyMicroId(id);
             const baseRow = {
                  ...measurementSafeRow,
                  key,
                  microFamilyId: id,
                  trueMicroFamilyId: id,
                  analyzeMicroFamilyId: id,
                  learningMicroFamilyId: id,
                  childTrueMicroFamilyId: id,
                  parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
                  coarseMicroFamilyId: parsed.parentTrueMicroFamilyId,
                  sourceWeekKey: PERSISTENT_LEARNING_KEY,
                  sourceWeekPrimary: true,
                  sourceWeekFallback: false,
                  ...modePayload()
             };
             const raw = buildRawMicroRow(baseRow, key, index);
             return raw ? decorateMicroRow(raw, marketWeather) : null;
        })
        .filter(Boolean)
        .filter(isAnalyzeMicroRow);
}
function rowKey(row = {}) {
    return String(
        row.trueMicroFamilyId ||
        row.learningMicroFamilyId ||
        row.analyzeMicroFamilyId ||
        row.microFamilyId ||
        row.id ||
        row.key ||
        ''
    ).trim();
}
function mergeRows(primaryRows = [], fallbackRows = []) {
    const byKey = new Map();
    for (const row of fallbackRows) {
        const key = rowKey(row);
        if (!key || !isAnalyzeMicroRow(row)) continue;
        byKey.set(key, row);
    }
    for (const row of primaryRows) {
        const key = rowKey(row);
        if (!key || !isAnalyzeMicroRow(row)) continue;
        const existing = byKey.get(key);
        byKey.set(key, existing
             ? {
                 ...existing,
                 ...row,
                 storedActive: Boolean(
                      existing.storedActive ||
                      row.storedActive ||
                      existing.active ||
                      row.active
                 ),
                 storedMacroActive: Boolean(
                      existing.storedMacroActive ||
                      row.storedMacroActive ||
                      existing.macroActive ||
                      row.macroActive
                 ),
                 active: Boolean(existing.active || row.active),
                 macroActive: Boolean(existing.macroActive || row.macroActive),
                 selectedTier: row.selectedTier || existing.selectedTier,
                 rotationEligibilityTier: row.rotationEligibilityTier ||
existing.rotationEligibilityTier,
                 tier: row.tier || existing.tier,
                 generatedEmptyTaxonomyRow: Boolean(existing.generatedEmptyTaxonomyRow &&
row.generatedEmptyTaxonomyRow)
             }
             : row
        );
    }
    return [...byKey.values()].filter(isAnalyzeMicroRow);
}
function manualRowFromId(id, index = 0, marketWeather = null) {
    if (!id || inferTradeSide(id) === OPPOSITE_TRADE_SIDE) return null;
    if (!validLearningId(id)) return null;
    if (!isSelectableTrueMicroId(id)) return null;
    const parsed = parseLongTaxonomyMicroId(id);
    const raw = buildRawMicroRow({
        microFamilyId: id,
        trueMicroFamilyId: id,
        analyzeMicroFamilyId: id,
        learningMicroFamilyId: id,
        childTrueMicroFamilyId: id,
        parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
        coarseMicroFamilyId: parsed.parentTrueMicroFamilyId,
        familyId: parsed.parentTrueMicroFamilyId,
        macroFamilyId: parsed.parentTrueMicroFamilyId,
        taxonomySetup: parsed.setup,
        taxonomyRegime: parsed.regime,
         confirmationProfile: parsed.confirmationProfile,
         ...modePayload(),
         active: true,
         macroActive: false,
         seen: 0,
         observations: 0,
         observationDuplicateSkippedCount: 0,
         completed: 0,
         virtualCompleted: 0,
         shadowCompleted: 0,
         winrateSample: 0,
         winrate: 0,
         totalR: 0,
         virtualTotalR: 0,
         shadowTotalR: 0,
         avgR: 0,
         profitFactor: 0,
         directSLPct: 0,
         directSLCount: 0,
         totalCostR: 0,
         avgCostR: 0,
         selectedTier: 'RAW',
         rotationEligibilityTier: 'RAW'
    }, id, index);
    return raw ? decorateMicroRow(raw, marketWeather) : null;
}
function extractActiveIds(activeRotation) {
    if (!activeRotation) return [];
    const ids = [
         activeRotation.microFamilyIds || [],
         activeRotation.activeMicroFamilyIds || [],
         activeRotation.trueMicroFamilyIds || [],
         activeRotation.ids || [],
         Array.isArray(activeRotation.microFamilies)
           ? activeRotation.microFamilies.map((row) => getTrueMicroFamilyId(row))
           : []
    ];
    return uniqueStrings(ids).filter((id) => (
         inferTradeSide(id) !== OPPOSITE_TRADE_SIDE &&
         validLearningId(id) &&
         isSelectableTrueMicroId(id)
    ));
}
function extractActiveMacroIds(activeRotation) {
    if (!activeRotation) return [];
    const ids = [
         activeRotation.macroFamilyIds || [],
         activeRotation.activeMacroFamilyIds || [],
         activeRotation.macroIds || [],
         Array.isArray(activeRotation.microFamilies)
              ? activeRotation.microFamilies.map((row) => getMacroFamilyId(row))
              : []
    ];
    return uniqueStrings(ids).filter((id) => (
         inferTradeSide(id) !== OPPOSITE_TRADE_SIDE &&
         validLearningId(id) &&
         isFixedLongParentMicroId(id)
    ));
}
function buildRowsFromActiveRotation(activeRotation, marketWeather = null) {
    if (!activeRotation) return [];
    const rows = [];
    if (Array.isArray(activeRotation.microFamilies)) {
         rows.push(
              ...activeRotation.microFamilies
                .map((row, index) => {
                     if (inferTradeSide(row) === OPPOSITE_TRADE_SIDE) return null;
                     const id = getTrueMicroFamilyId(row, `active_${index}`);
                     if (!id || !validLearningId(id) || !isSelectableTrueMicroId(id)) return
null;
                     const parsed = parseLongTaxonomyMicroId(id);
                     const raw = buildRawMicroRow({
                       ...row,
                       ...modePayload(),
                       microFamilyId: id,
                       trueMicroFamilyId: id,
                       analyzeMicroFamilyId: id,
                       learningMicroFamilyId: id,
                       childTrueMicroFamilyId: id,
                       parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
                       coarseMicroFamilyId: parsed.parentTrueMicroFamilyId,
                       active: true,
                       selectedTier: row.selectedTier || row.rotationEligibilityTier ||
activeRotation.selectedTier || 'RAW'
                     }, id, index);
                     return raw ? decorateMicroRow(raw, marketWeather) : null;
                })
                .filter(Boolean)
                .filter(isAnalyzeMicroRow)
         );
    }
    const existing = new Set(rows.map(rowKey).filter(Boolean));
    for (const id of extractActiveIds(activeRotation)) {
         if (existing.has(id)) continue;
         const manual = manualRowFromId(id, rows.length, marketWeather);
         if (!manual) continue;
         rows.push(manual);
         existing.add(id);
    }
    return mergeRows([], rows);
}
function normalizeMicroRow(
    row = {},
    index = 0,
    {
         activeSet = new Set(),
         activeMacroSet = new Set(),
         compact = true
    } = {}
) {
    const trueMicroFamilyId = getTrueMicroFamilyId(row);
    const parsed = parseLongTaxonomyMicroId(trueMicroFamilyId);
    const microFamilyId = trueMicroFamilyId;
    const parentTrueMicroFamilyId = parsed.parentTrueMicroFamilyId;
    const coarseMicroFamilyId = parentTrueMicroFamilyId;
    const familyId = parentTrueMicroFamilyId;
    const macroFamilyId = parentTrueMicroFamilyId;
    const storedActive = Boolean(row.storedActive ?? row.active) || (
         trueMicroFamilyId
           ? activeSet.has(trueMicroFamilyId)
           : false
    );
    const storedMacroActive = Boolean(row.storedMacroActive ?? row.macroActive) || (
         macroFamilyId
           ? activeMacroSet.has(macroFamilyId)
           : false
    );
    const winrate = getSampleAdjustedWinrate(row);
    const gate = empiricalActivationGate(row, winrate);
    const discord = discordEligibilityFor(row, gate, row);
    const tier = tierFor(row, winrate);
    const learningStatus = learningStatusFor(row, winrate);
    const tooEarly = winrate.outcomeSample < MIN_COMPLETED_ACTIVE_LEARNING;
    const riskGeometry = getLongRiskGeometry(row);
    const base = {
         ...temporalRowPayload(row),
         rank: index + 1,
         microFamilyId,
         trueMicroFamilyId,
         analyzeMicroFamilyId: trueMicroFamilyId,
         learningMicroFamilyId: trueMicroFamilyId,
childTrueMicroFamilyId: trueMicroFamilyId,
parentTrueMicroFamilyId,
coarseMicroFamilyId,
baseMicroFamilyId: parentTrueMicroFamilyId,
legacyMicroFamilyId: parentTrueMicroFamilyId,
familyId,
macroFamilyId,
parentMacroFamilyId: parentTrueMicroFamilyId,
parentMicroFamilyId: parentTrueMicroFamilyId,
taxonomySetup: parsed.setup,
taxonomyRegime: parsed.regime,
confirmationProfile: parsed.confirmationProfile,
setupType: parsed.setup,
regimeBucket: parsed.regime,
...scannerMetadata(row),
...modePayload(),
fixedTaxonomyLearningId: true,
selectableTrueMicroFamily: true,
parentTrueMicroFamily: false,
trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
learningGranularity: LEARNING_GRANULARITY,
parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
scannerFingerprintLegacy: false,
legacyScannerFamilyFallback: false,
scannerFingerprintOnlyMetadata: true,
scannerFingerprintsMetadataOnly: true,
scannerFingerprintsUsedAsLearningFamily: false,
executionFingerprintsUsedAsLearningFamily: false,
inferredTradeSide: row.inferredTradeSide || inferTradeSide(row),
inferredFromLongOnlyMode: Boolean(row.inferredFromLongOnlyMode),
sourceWeekKey: row.sourceWeekKey || PERSISTENT_LEARNING_KEY,
sourceWeekPrimary: row.sourceWeekPrimary !== false,
sourceWeekFallback: Boolean(row.sourceWeekFallback),
measurementFixVersion:
  MEASUREMENT_FIX_VERSION,
outcomeMeasurementVersion:
  MEASUREMENT_FIX_VERSION,
acceptedOutcomeMeasurementVersion:
  MEASUREMENT_FIX_VERSION,
previousMeasurementFixVersion:
  row.previousMeasurementFixVersion ||
  null,
outcomeMeasurementGateMode:
  OUTCOME_MEASUREMENT_GATE_MODE,
strictOutcomeMeasurementGate: true,
legacyOutcomeMeasurementsExcluded: true,
completedCurrentMeasurementOnly: true,
exitFillModelVersion:
  row.exitFillModelVersion ||
  EXIT_FILL_MODEL_VERSION,
legacyExcludedCompleted:
  num(row.legacyExcludedCompleted, 0),
legacyExcludedTotalR:
  num(row.legacyExcludedTotalR, 0),
storedActive,
storedMacroActive,
active: storedActive && discord.eligible,
macroActive: storedMacroActive && discord.eligible,
selectionSuppressedByDiscordGate:
  storedActive && !discord.eligible,
empiricalVetoRemovedFromActiveDisplay:
  gate.blocked && storedActive,
activationGateStatus: gate.status,
activationGateReason: gate.reason,
activationGatePassed: gate.status === 'PASSED',
empiricalVeto: gate.blocked,
empiricalVetoed: gate.blocked,
empiricalVetoPolicyVersion: EMPIRICAL_VETO_POLICY_VERSION,
empiricalVetoMinCompleted: gate.minCompleted,
empiricalVetoMaxAvgR: gate.maxAvgR,
empiricalVetoCompleted: round(gate.completed, 4),
empiricalVetoAvgR: round(gate.avgR, 4),
empiricalVetoTotalR: round(gate.totalR, 4),
empiricalVetoReason: gate.blocked ? gate.reason : null,
empiricalVetoBlocksAdaptiveSelection: true,
empiricalVetoBlocksManualActivation: true,
empiricalVetoCanRecover: true,
discordEmpiricalVetoAllowed: !gate.blocked,
discordEmpiricalVetoGateReason: gate.blocked
  ? 'EMPIRICAL_VETO_CURRENT_MEASUREMENT_NET_EDGE_NOT_POSITIVE'
  : null,
seen: num(row.seen, 0),
observations: num(row.observations, 0),
observationDuplicateSkippedCount: getObservationDuplicateSkippedCount(row),
seenCompletedRatio: round(getSeenCompletedRatio(row), 4),
completed: round(winrate.outcomeSample, 4),
virtualCompleted: num(row.virtualCompleted, 0),
shadowCompleted: num(row.shadowCompleted, 0),
realCompleted: 0,
outcomeSample: round(winrate.outcomeSample, 4),
observationSample: round(winrate.observationSample, 4),
awaitingOutcomes: Boolean(winrate.awaitingOutcomes),
learningStatus,
status: learningStatus,
tooEarly,
tooEarlyReason: tooEarly
     ? `COMPLETED_BELOW_${MIN_COMPLETED_ACTIVE_LEARNING}`
     : null,
minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,
tier,
selectedTier: gate.blocked
     ? 'EMPIRICAL_VETO'
     : row.selectedTier || row.rotationEligibilityTier || tier,
rotationEligibilityTier: gate.blocked
     ? 'EMPIRICAL_VETO'
     : row.rotationEligibilityTier || row.selectedTier || tier,
wins: round(winrate.wins, 4),
losses: round(winrate.losses, 4),
flats: round(winrate.flats, 4),
virtualWins: num(row.virtualWins, 0),
virtualLosses: num(row.virtualLosses, 0),
virtualFlats: num(row.virtualFlats, 0),
shadowWins: num(row.shadowWins, 0),
shadowLosses: num(row.shadowLosses, 0),
shadowFlats: num(row.shadowFlats, 0),
realWins: 0,
realLosses: 0,
realFlats: 0,
winrate: round(winrate.rawWinrate, 4),
bayesianWinrate: round(winrate.bayesianWinrate, 4),
wilsonLowerBound: round(winrate.wilsonLowerBound, 4),
fairWinrate: round(winrate.score, 4),
winrateSample: round(winrate.sample, 4),
sampleAdjustedWinrate: round(winrate.score, 4),
sampleRawWinrate: round(winrate.rawWinrate, 4),
sampleBayesianWinrate: round(winrate.bayesianWinrate, 4),
sampleWilsonLowerBound: round(winrate.wilsonLowerBound, 4),
sampleReliability: round(winrate.reliability, 4),
observationReliability: round(
     winrate.observationReliability ??
         sampleReliability(winrate.observationSample),
     4
),
totalR: round(getTotalR(row), 4),
virtualTotalR: round(row.virtualTotalR, 4),
shadowTotalR: round(row.shadowTotalR, 4),
realTotalR: 0,
avgR: round(getAvgR(row), 4),
      avgWinR: round(row.avgWinR, 4),
      avgLossR: round(row.avgLossR, 4),
      profitFactor: round(getProfitFactor(row), 4),
      directSLCount: round(getDirectSLCount(row), 4),
      directSLPct: round(getDirectSLPct(row), 4),
      totalCostR: round(getTotalCostR(row), 4),
      avgCostR: round(getAvgCostR(row), 4),
      avgCostRFixSource: costFixSource(row),
      riskTradeSide: TARGET_TRADE_SIDE,
      validLongGeometry: Boolean(riskGeometry.validGeometry),
      longValidGeometry: Boolean(riskGeometry.validGeometry),
      riskGeometryRule: riskGeometry.riskGeometryRule,
      tpHitRule: riskGeometry.tpHitRule,
      slHitRule: riskGeometry.slHitRule,
      grossRFormula: riskGeometry.grossRFormula,
      currentRFormula: riskGeometry.currentRFormula,
      longTpHit: riskGeometry.longTpHit,
      longSlHit: riskGeometry.longSlHit,
      tpHit: riskGeometry.longTpHit,
      slHit: riskGeometry.longSlHit,
      longGrossR: round(riskGeometry.longGrossR ?? row.longGrossR ?? row.grossR,
4),
      longCurrentR: round(riskGeometry.longCurrentR ?? row.longCurrentR ??
row.currentR, 4),
      currentR: round(riskGeometry.longCurrentR ?? row.currentR, 4),
      balancedScore: round(row.balancedScore, 4),
      dashboardBalancedScore: round(row.dashboardBalancedScore ??
getDashboardBalancedScore(row, winrate), 4),
      adaptiveScore: round(
           gate.blocked
               ? -1_000_000
               : row.adaptiveScore ??
                 row.dashboardBalancedScore ??
                 row.balancedScore ??
                 getDashboardBalancedScore(row, winrate),
           4
      ),
      recentMomentumScore: round(
           gate.blocked
               ? -35
               : row.recentMomentumScore ?? 0,
           4
      ),
      currentFit: row.currentFit || 'UNKNOWN',
      currentFitLabel: row.currentFitLabel || row.currentFit || 'UNKNOWN',
      currentFitCanonical: row.currentFitCanonical || row.currentFit || 'UNKNOWN',
      currentFitScore: round(row.currentFitScore ?? row.fitScore ?? 0, 4),
   fitScore: round(row.fitScore ?? row.currentFitScore ?? 0, 4),
   currentFitConfidence: round(row.currentFitConfidence ?? 0, 4),
   currentFitReason: row.currentFitReason || null,
   currentFitReasons: Array.isArray(row.currentFitReasons) ?
row.currentFitReasons : [],
   currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
   currentMarketRegime: row.currentMarketRegime || 'UNKNOWN',
   currentMarketTrendSide: row.currentMarketTrendSide || 'UNKNOWN',
   currentBearishPct: row.currentBearishPct ?? null,
   currentBullishPct: row.currentBullishPct ?? null,
   currentSqueezePct: row.currentSqueezePct ?? null,
   currentMarketWeatherAvailable: Boolean(row.currentMarketWeatherAvailable),
   currentMarketWeatherStale: Boolean(row.currentMarketWeatherStale),
   currentMarketWeatherAgeSec: row.currentMarketWeatherAgeSec ?? null,
   currentMarketWeatherSourceKey: row.currentMarketWeatherSourceKey || null,
   currentMarketWeatherRedisSource: row.currentMarketWeatherRedisSource || null,
   currentFitSoftOnly: true,
   currentFitBlocksLearning: false,
   currentFitBlocksVirtualLearning: false,
   currentFitBlocksShadowLearning: false,
   currentFitBlocksDiscord: Boolean(row.currentFitBlocksDiscord),
   discordCurrentFitAllowed: row.discordCurrentFitAllowed === true,
   discordCurrentFitGateReason: row.discordCurrentFitGateReason || null,
   discordEligible: discord.eligible,
   discordBlocked: discord.blocked,
   discordActivationGatePassed: discord.gatePassed,
   discordBlockReason: discord.reason,
   definition: row.definition || null,
   definitionParts: getDefinitionParts(row),
   macroDefinition: row.macroDefinition || row.parentDefinition || null,
   macroDefinitionParts: getMacroDefinitionParts(row),
   microDefinition: row.microDefinition || row.definition || null,
   microDefinitionParts: Array.isArray(row.microDefinitionParts)
     ? row.microDefinitionParts
     : getDefinitionParts(row),
   assetClass: row.assetClass || null,
   rsiZone: row.rsiZone || null,
   rsiCoarse: row.rsiCoarse || null,
   flow: row.flow || null,
   flowCoarse: row.flowCoarse || null,
   obRelation: row.obRelation || null,
   btcState: row.btcState || null,
   btcRelation: row.btcRelation || null,
   regime: row.regime || null,
   regimeCoarse: row.regimeCoarse || null,
   scannerReason: row.scannerReason || null,
   scannerReasonCoarse: row.scannerReasonCoarse || null,
         generatedEmptyTaxonomyRow: Boolean(row.generatedEmptyTaxonomyRow),
         createdAt: row.createdAt || null,
         updatedAt: row.updatedAt || null
    };
    if (compact) return base;
    return {
         ...row,
         ...temporalRowPayload(row),
         ...base,
         counters: row.counters || {},
         examples: Array.isArray(row.examples)
           ? row.examples.filter(isLongRow).slice(-8)
           : [],
         recentOutcomes: Array.isArray(row.recentOutcomes)
           ? row.recentOutcomes.filter(isLongRow).slice(-8)
           : []
    };
}
function compactBestRow(row) {
    if (!row) return null;
    if (!isAnalyzeMicroRow(row)) return null;
    const trueMicroFamilyId = getTrueMicroFamilyId(row);
    const parsed = parseLongTaxonomyMicroId(trueMicroFamilyId);
    const riskGeometry = getLongRiskGeometry(row);
    const gate = empiricalActivationGate(row);
    const discord = discordEligibilityFor(row, gate, row);
    const storedActive = Boolean(row.storedActive ?? row.active);
    const storedMacroActive = Boolean(row.storedMacroActive ?? row.macroActive);
    return {
         microFamilyId: trueMicroFamilyId,
         trueMicroFamilyId,
         analyzeMicroFamilyId: trueMicroFamilyId,
         learningMicroFamilyId: trueMicroFamilyId,
         childTrueMicroFamilyId: trueMicroFamilyId,
         parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
         coarseMicroFamilyId: parsed.parentTrueMicroFamilyId,
         familyId: parsed.parentTrueMicroFamilyId,
         macroFamilyId: parsed.parentTrueMicroFamilyId,
         taxonomySetup: parsed.setup,
         taxonomyRegime: parsed.regime,
         confirmationProfile: parsed.confirmationProfile,
         ...modePayload(),
         fixedTaxonomyLearningId: true,
         selectableTrueMicroFamily: true,
         trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
         exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
         childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
      parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
      learningGranularity: LEARNING_GRANULARITY,
      parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
      storedActive,
      storedMacroActive,
      active: storedActive && discord.eligible,
      macroActive: storedMacroActive && discord.eligible,
      selectionSuppressedByDiscordGate:
        storedActive && !discord.eligible,
      activationGateStatus: gate.status,
      activationGateReason: gate.reason,
      activationGatePassed: gate.status === 'PASSED',
      empiricalVeto: gate.blocked,
      empiricalVetoed: gate.blocked,
      empiricalVetoPolicyVersion: EMPIRICAL_VETO_POLICY_VERSION,
      empiricalVetoMinCompleted: gate.minCompleted,
      empiricalVetoMaxAvgR: gate.maxAvgR,
      empiricalVetoCompleted: round(gate.completed, 4),
      empiricalVetoAvgR: round(gate.avgR, 4),
      empiricalVetoTotalR: round(gate.totalR, 4),
      empiricalVetoReason: gate.blocked ? gate.reason : null,
      empiricalVetoBlocksAdaptiveSelection: true,
      empiricalVetoBlocksManualActivation: true,
      discordEmpiricalVetoAllowed: !gate.blocked,
      discordEmpiricalVetoGateReason: gate.blocked
        ? 'EMPIRICAL_VETO_CURRENT_MEASUREMENT_NET_EDGE_NOT_POSITIVE'
        : null,
      seen: num(row.seen, 0),
      observations: num(row.observations, 0),
      observationDuplicateSkippedCount: getObservationDuplicateSkippedCount(row),
      seenCompletedRatio: round(getSeenCompletedRatio(row), 4),
      completed: round(row.outcomeSample ?? getCompletedSample(row), 4),
      outcomeSample: round(row.outcomeSample ?? getCompletedSample(row), 4),
      observationSample: round(row.observationSample ?? getObservationSample(row),
4),
      awaitingOutcomes: Boolean(row.awaitingOutcomes),
      learningStatus: row.learningStatus || learningStatusFor(row),
      status: row.status || row.learningStatus || learningStatusFor(row),
      tooEarly: num(row.outcomeSample ?? getCompletedSample(row), 0) <
MIN_COMPLETED_ACTIVE_LEARNING,
      minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,
      tier: gate.blocked
        ? 'EMPIRICAL_VETO'
        : row.tier || tierFor(row),
      selectedTier: gate.blocked
        ? 'EMPIRICAL_VETO'
        : row.selectedTier || row.rotationEligibilityTier || row.tier ||
tierFor(row),
      rotationEligibilityTier: gate.blocked
           ? 'EMPIRICAL_VETO'
           : row.rotationEligibilityTier || row.selectedTier || row.tier ||
tierFor(row),
      winrateSample: round(row.winrateSample, 4),
      winrate: round(row.winrate, 4),
      fairWinrate: round(row.fairWinrate, 4),
      sampleAdjustedWinrate: round(row.sampleAdjustedWinrate, 4),
      sampleWilsonLowerBound: round(row.sampleWilsonLowerBound, 4),
      sampleReliability: round(row.sampleReliability, 4),
      avgR: round(getAvgR(row), 4),
      totalR: round(getTotalR(row), 4),
      profitFactor: round(getProfitFactor(row), 4),
      directSLCount: round(getDirectSLCount(row), 4),
      directSLPct: round(getDirectSLPct(row), 4),
      totalCostR: round(getTotalCostR(row), 4),
      avgCostR: round(getAvgCostR(row), 4),
      avgCostRFixSource: costFixSource(row),
      validLongGeometry: Boolean(riskGeometry.validGeometry),
      longTpHit: riskGeometry.longTpHit,
      longSlHit: riskGeometry.longSlHit,
      longGrossR: round(riskGeometry.longGrossR ?? row.longGrossR ?? row.grossR,
4),
      longCurrentR: round(riskGeometry.longCurrentR ?? row.longCurrentR ??
row.currentR, 4),
      currentR: round(riskGeometry.longCurrentR ?? row.currentR, 4),
      balancedScore: round(row.balancedScore, 4),
      dashboardBalancedScore: round(row.dashboardBalancedScore, 4),
      adaptiveScore: round(
           gate.blocked ? -1_000_000 : row.adaptiveScore,
           4
      ),
      currentFit: row.currentFit || 'UNKNOWN',
      currentFitCanonical: row.currentFitCanonical || row.currentFit || 'UNKNOWN',
      currentFitScore: round(row.currentFitScore ?? row.fitScore ?? 0, 4),
      fitScore: round(row.fitScore ?? row.currentFitScore ?? 0, 4),
      currentFitConfidence: round(row.currentFitConfidence ?? 0, 4),
      currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
      currentMarketRegime: row.currentMarketRegime || 'UNKNOWN',
      currentMarketTrendSide: row.currentMarketTrendSide || 'UNKNOWN',
      currentMarketWeatherAvailable: Boolean(row.currentMarketWeatherAvailable),
      currentMarketWeatherStale: Boolean(row.currentMarketWeatherStale),
      currentMarketWeatherAgeSec: row.currentMarketWeatherAgeSec ?? null,
      currentFitBlocksDiscord: Boolean(row.currentFitBlocksDiscord),
      discordCurrentFitAllowed: row.discordCurrentFitAllowed === true,
      discordEligible: discord.eligible,
         discordBlocked: discord.blocked,
         discordActivationGatePassed: discord.gatePassed,
         discordBlockReason: discord.reason
    };
}
function compactActiveRotation(activeRotation) {
    if (!activeRotation) return null;
    const activeMicroFamilyIds = extractActiveIds(activeRotation);
    const activeMacroFamilyIds = extractActiveMacroIds(activeRotation);
    return {
         rotationId: activeRotation.rotationId || null,
         source: activeRotation.source || null,
         mode: activeRotation.mode || null,
         sourceWeekKey: activeRotation.sourceWeekKey || null,
         activeWeekKey: activeRotation.activeWeekKey || null,
         generatedAt: activeRotation.generatedAt || null,
         activatedAt: activeRotation.activatedAt || null,
         ...modePayload(),
         trueMicroOnly: activeRotation.trueMicroOnly !== false,
         exactTrueMicroOnly: true,
         selectableChildOnly: true,
         manualOnly: true,
         adminSelected: Boolean(activeRotation.adminSelected ||
activeRotation.manualOnly),
         liveSelectable: Boolean(activeRotation.liveSelectable),
         usedLegacyFallback: false,
         usedSoftFallback: Boolean(activeRotation.usedSoftFallback),
         usedObservationFallback: Boolean(activeRotation.usedObservationFallback),
         usedRawFallback: Boolean(activeRotation.usedRawFallback),
         empiricalVetoPolicyVersion: EMPIRICAL_VETO_POLICY_VERSION,
         empiricalVetoRemovedCount:
           num(activeRotation.empiricalVetoRemovedCount, 0),
         empiricalVetoRemovedMicroFamilyIds:
           activeRotation.empiricalVetoRemovedMicroFamilyIds || [],
         selectedTier: activeRotation.selectedTier || null,
         missingSides: Array.isArray(activeRotation.missingSides)
           ? activeRotation.missingSides.filter((side) => upper(side) !==
OPPOSITE_TRADE_SIDE)
           : [],
         microFamilyIds: activeMicroFamilyIds,
         activeMicroFamilyIds,
         trueMicroFamilyIds: activeMicroFamilyIds,
         macroFamilyIds: activeMacroFamilyIds,
         activeMacroFamilyIds,
         bestLong: activeRotation.bestLong
           ? compactBestRow(activeRotation.bestLong)
           : null,
         bestShort: null
    };
}
function parseFilters(req) {
    const side = normalizeRequestedTradeSide(firstQueryValue(req.query?.side,
TARGET_TRADE_SIDE));
    const familyId = String(firstQueryValue(req.query?.familyId, '') || '').trim();
    const macroFamilyId = String(firstQueryValue(req.query?.macroFamilyId, '') ||
'').trim();
    const parentTrueMicroFamilyId =
String(firstQueryValue(req.query?.parentTrueMicroFamilyId, '') || '').trim();
    const setup = upper(firstQueryValue(req.query?.setup, ''));
    const regime = upper(firstQueryValue(req.query?.regime, ''));
    const confirmationProfile =
upper(firstQueryValue(req.query?.confirmationProfile, ''));
    const q = String(firstQueryValue(req.query?.q, '') || '').trim().toUpperCase();
    return {
         side,
         familyId,
         macroFamilyId,
         parentTrueMicroFamilyId,
         setup,
         regime,
         confirmationProfile,
         q,
         activeOnly: isTrue(firstQueryValue(req.query?.activeOnly, false)),
         macroActiveOnly: isTrue(firstQueryValue(req.query?.macroActiveOnly, false)),
         includeEmpty: firstQueryValue(req.query?.includeEmpty, null) === null
              ? true
              : isTrue(firstQueryValue(req.query?.includeEmpty, true)),
         minCompleted: num(firstQueryValue(req.query?.minCompleted, 0), 0),
         minSample: num(firstQueryValue(req.query?.minSample, 0), 0),
         minSeen: num(firstQueryValue(req.query?.minSeen, 0), 0),
         tier: String(firstQueryValue(req.query?.tier, '') || '').trim().toUpperCase(),
         status: String(firstQueryValue(req.query?.status, '') ||
'').trim().toUpperCase(),
         currentFit: String(firstQueryValue(req.query?.currentFit, '') ||
'').trim().toUpperCase()
    };
}
function hasNarrowFilters(filters = {}) {
    return Boolean(
         filters.side === 'SHORT_DISABLED' ||
         filters.familyId ||
         filters.macroFamilyId ||
         filters.parentTrueMicroFamilyId ||
         filters.setup ||
         filters.regime ||
         filters.confirmationProfile ||
         filters.q ||
         filters.activeOnly ||
         filters.macroActiveOnly ||
         filters.minCompleted > 0 ||
         filters.minSample > 0 ||
         filters.minSeen > 0 ||
         filters.tier ||
         filters.status ||
         filters.currentFit ||
         filters.includeEmpty === false
    );
}
function rowMatchesSearch(row = {}, q = '') {
    if (!q) return true;
    const haystack = [
         row.microFamilyId,
         row.trueMicroFamilyId,
         row.learningMicroFamilyId,
         row.analyzeMicroFamilyId,
         row.childTrueMicroFamilyId,
         row.parentTrueMicroFamilyId,
         row.coarseMicroFamilyId,
         row.id,
         row.key,
         row.familyId,
         row.family,
         row.macroFamilyId,
         row.parentMacroFamilyId,
         row.parentMicroFamilyId,
         row.parentFamilyId,
         row.definition,
         row.microDefinition,
         row.macroDefinition,
         row.parentDefinition,
         row.taxonomySetup,
         row.taxonomyRegime,
         row.confirmationProfile,
         row.setupType,
         row.regimeBucket,
         row.currentFit,
         row.currentMarketRegime,
         row.currentMarketTrendSide,
         ...getArray(row.definitionParts),
         ...getArray(row.microDefinitionParts),
         ...getArray(row.macroDefinitionParts),
        ...getArray(row.parentDefinitionParts),
        ...getArray(row.executionFingerprintParts)
    ]
        .map((value) => upper(value))
        .join(' | ');
    return haystack.includes(q);
}
function rowPassesFilters(row = {}, filters, activeSet, activeMacroSet) {
    if (!row?.trueMicroFamilyId) return false;
    if (!isAnalyzeMicroRow(row)) return false;
    const exactId = row.trueMicroFamilyId;
    const parentId = row.parentTrueMicroFamilyId || row.coarseMicroFamilyId ||
row.macroFamilyId;
    const parsed = parseLongTaxonomyMicroId(exactId);
    if (filters.side === 'SHORT_DISABLED') return false;
    if (filters.side && filters.side !== TARGET_TRADE_SIDE) return false;
    if (filters.familyId && String(row.familyId || '') !== filters.familyId) return
false;
    if (filters.macroFamilyId && String(parentId || '') !== filters.macroFamilyId)
return false;
    if (filters.parentTrueMicroFamilyId && String(parentId || '') !==
filters.parentTrueMicroFamilyId) return false;
    if (filters.setup && parsed.setup !== filters.setup) return false;
    if (filters.regime && parsed.regime !== filters.regime) return false;
    if (filters.confirmationProfile && parsed.confirmationProfile !==
filters.confirmationProfile) return false;
    if (filters.activeOnly && row.active !== true) return false;
    if (filters.macroActiveOnly && !activeMacroSet.has(parentId)) return false;
    if (filters.includeEmpty === false && num(row.observationSample ??
getObservationSample(row), 0) <= 0) return false;
    if (filters.minCompleted > 0 && num(row.outcomeSample ??
getCompletedSample(row), 0) < filters.minCompleted) return false;
    if (filters.minSample > 0 && num(row.winrateSample, 0) < filters.minSample)
return false;
    if (filters.minSeen > 0 && num(row.seen, 0) < filters.minSeen) return false;
    if (filters.tier && upper(row.tier || row.rotationEligibilityTier) !==
filters.tier) return false;
    if (filters.status && upper(row.status || row.learningStatus) !==
filters.status) return false;
    if (filters.currentFit && upper(row.currentFit) !== filters.currentFit) return
false;
    if (!rowMatchesSearch(row, filters.q)) return false;
    return true;
}
function compareNumberDesc(a, b) {
    return num(b, 0) - num(a, 0);
}
function compareNumberAsc(a, b) {
    return num(a, 0) - num(b, 0);
}
function compareIdAsc(a, b) {
    return String(a || '').localeCompare(String(b || ''));
}
function learningQualityRank(row = {}) {
    const completed = num(row.outcomeSample ?? getCompletedSample(row), 0);
    const observations = num(row.observationSample ?? getObservationSample(row), 0);
    if (isEmpiricallyVetoed(row)) return -1;
    if (completed >= MIN_COMPLETED_ACTIVE_LEARNING) return 3;
    if (completed > 0) return 2;
    if (observations > 0) return 1;
    return 0;
}
function compareRowsWinrate(a, b) {
    return (
         compareNumberDesc(a.sampleAdjustedWinrate ?? a.fairWinrate,
b.sampleAdjustedWinrate ?? b.fairWinrate) ||
         compareNumberDesc(a.sampleWilsonLowerBound ?? a.wilsonLowerBound,
b.sampleWilsonLowerBound ?? b.wilsonLowerBound) ||
         compareNumberDesc(a.sampleBayesianWinrate ?? a.bayesianWinrate,
b.sampleBayesianWinrate ?? b.bayesianWinrate) ||
         compareNumberDesc(a.sampleReliability, b.sampleReliability) ||
         compareNumberDesc(a.outcomeSample, b.outcomeSample) ||
         compareNumberDesc(getTotalR(a), getTotalR(b)) ||
         compareNumberDesc(getAvgR(a), getAvgR(b)) ||
         compareNumberAsc(getAvgCostR(a), getAvgCostR(b)) ||
         compareNumberDesc(a.observationSample, b.observationSample) ||
         compareNumberDesc(a.seen, b.seen) ||
         compareIdAsc(a.trueMicroFamilyId, b.trueMicroFamilyId)
    );
}
function compareRowsBestData(a, b) {
    return (
         compareNumberDesc(learningQualityRank(a), learningQualityRank(b)) ||
         compareNumberDesc(a.dashboardBalancedScore ?? a.balancedScore,
b.dashboardBalancedScore ?? b.balancedScore) ||
         compareNumberDesc(a.outcomeSample ?? getCompletedSample(a), b.outcomeSample ??
getCompletedSample(b)) ||
         compareNumberDesc(a.sampleAdjustedWinrate ?? a.fairWinrate,
b.sampleAdjustedWinrate ?? b.fairWinrate) ||
         compareNumberDesc(a.fairWinrate, b.fairWinrate) ||
         compareNumberDesc(a.sampleWilsonLowerBound ?? a.wilsonLowerBound,
b.sampleWilsonLowerBound ?? b.wilsonLowerBound) ||
         compareNumberDesc(a.sampleReliability, b.sampleReliability) ||
         compareNumberDesc(getTotalR(a), getTotalR(b)) ||
         compareNumberDesc(getAvgR(a), getAvgR(b)) ||
         compareNumberAsc(getAvgCostR(a), getAvgCostR(b)) ||
         compareNumberAsc(getDirectSLPct(a), getDirectSLPct(b)) ||
         compareNumberDesc(a.currentFitScore ?? a.fitScore, b.currentFitScore ??
b.fitScore) ||
         compareNumberDesc(a.observationSample ?? getObservationSample(a),
b.observationSample ?? getObservationSample(b)) ||
         compareNumberDesc(a.seen, b.seen) ||
         compareIdAsc(a.trueMicroFamilyId, b.trueMicroFamilyId)
    );
}
function compareRowsBalanced(a, b) {
    return compareRowsBestData(a, b);
}
function compareRowsAdaptive(a, b) {
    return (
         compareNumberDesc(
           learningQualityRank(a),
           learningQualityRank(b)
         ) ||
         compareNumberDesc(a.adaptiveScore, b.adaptiveScore) ||
         compareRowsBestData(a, b)
    );
}
function compareRowsCurrentFit(a, b) {
    return (
         compareNumberDesc(a.currentFitScore ?? a.fitScore, b.currentFitScore ??
b.fitScore) ||
         compareRowsBestData(a, b)
    );
}
function compareRowsTotalR(a, b) {
    return (
         compareNumberDesc(getTotalR(a), getTotalR(b)) ||
         compareNumberDesc(a.dashboardBalancedScore ?? a.balancedScore,
b.dashboardBalancedScore ?? b.balancedScore) ||
         compareNumberDesc(a.sampleAdjustedWinrate ?? a.fairWinrate,
b.sampleAdjustedWinrate ?? b.fairWinrate) ||
         compareNumberDesc(getAvgR(a), getAvgR(b)) ||
         compareNumberAsc(getAvgCostR(a), getAvgCostR(b)) ||
         compareNumberAsc(getDirectSLPct(a), getDirectSLPct(b)) ||
         compareIdAsc(a.trueMicroFamilyId, b.trueMicroFamilyId)
    );
}
function compareRowsAvgR(a, b) {
    return (
         compareNumberDesc(getAvgR(a), getAvgR(b)) ||
         compareNumberDesc(a.dashboardBalancedScore ?? a.balancedScore,
b.dashboardBalancedScore ?? b.balancedScore) ||
         compareNumberDesc(a.sampleAdjustedWinrate ?? a.fairWinrate,
b.sampleAdjustedWinrate ?? b.fairWinrate) ||
         compareNumberDesc(getTotalR(a), getTotalR(b)) ||
         compareNumberAsc(getAvgCostR(a), getAvgCostR(b)) ||
         compareNumberAsc(getDirectSLPct(a), getDirectSLPct(b)) ||
         compareIdAsc(a.trueMicroFamilyId, b.trueMicroFamilyId)
    );
}
function compareRowsDirectSL(a, b) {
    return (
         compareNumberAsc(getDirectSLPct(a), getDirectSLPct(b)) ||
         compareNumberDesc(a.dashboardBalancedScore ?? a.balancedScore,
b.dashboardBalancedScore ?? b.balancedScore) ||
         compareNumberDesc(a.outcomeSample, b.outcomeSample) ||
         compareNumberDesc(a.observationSample, b.observationSample) ||
         compareRowsWinrate(a, b)
    );
}
function compareRowsObserved(a, b) {
    return (
         compareNumberDesc(a.observationSample, b.observationSample) ||
         compareNumberDesc(a.seen, b.seen) ||
         compareNumberDesc(a.observations, b.observations) ||
         compareNumberDesc(a.dashboardBalancedScore ?? a.balancedScore,
b.dashboardBalancedScore ?? b.balancedScore) ||
         compareNumberDesc(a.outcomeSample, b.outcomeSample) ||
         compareIdAsc(a.trueMicroFamilyId, b.trueMicroFamilyId)
    );
}
function compareRowsCost(a, b) {
    return (
         compareNumberAsc(getAvgCostR(a), getAvgCostR(b)) ||
         compareRowsBestData(a, b)
    );
}
function compareRowsByMode(a, b, mode = 'balanced') {
    const vetoOrder =
         Number(isEmpiricallyVetoed(a)) -
         Number(isEmpiricallyVetoed(b));
    if (vetoOrder !== 0) return vetoOrder;
    if (mode === 'adaptive') return compareRowsAdaptive(a, b);
    if (mode === 'winrate') return compareRowsWinrate(a, b);
    if (mode === 'totalR') return compareRowsTotalR(a, b);
    if (mode === 'avgR') return compareRowsAvgR(a, b);
    if (mode === 'directSL') return compareRowsDirectSL(a, b);
    if (mode === 'observed') return compareRowsObserved(a, b);
    if (mode === 'cost') return compareRowsCost(a, b);
    if (mode === 'currentFit') return compareRowsCurrentFit(a, b);
    return compareRowsBalanced(a, b);
}
function sortRowsByMode(rows = [], mode = 'balanced') {
    return [...rows]
         .filter(isAnalyzeMicroRow)
         .sort((a, b) => compareRowsByMode(a, b, mode));
}
function sideCounts(rows = []) {
    return rows.reduce(
         (acc, row) => {
              const side = inferTradeSide(row);
              if (side === OPPOSITE_TRADE_SIDE) acc.short += 1;
              else acc.long += 1;
              if (side === 'UNKNOWN') acc.unknown += 1;
              return acc;
         },
         {
              long: 0,
              short: 0,
              unknown: 0
         }
    );
}
function tierCounts(rows = []) {
    return rows.reduce(
         (acc, row) => {
              const tier = upper(row.tier || row.rotationEligibilityTier || tierFor(row));
              if (tier === 'EMPIRICAL_VETO') acc.EMPIRICAL_VETO += 1;
              else if (tier === 'HARD') acc.HARD += 1;
              else if (tier === 'SOFT') acc.SOFT += 1;
              else if (tier === 'OBSERVATION') acc.OBSERVATION += 1;
              else acc.RAW += 1;
              return acc;
         },
         {
              HARD: 0,
              SOFT: 0,
              OBSERVATION: 0,
              RAW: 0,
              EMPIRICAL_VETO: 0
         }
    );
}
function statusCounts(rows = []) {
    return rows.reduce((acc, row) => {
         const status = String(row.status || row.learningStatus ||
learningStatusFor(row)).toUpperCase();
         acc[status] = (acc[status] || 0) + 1;
         return acc;
    }, {});
}
function currentFitCounts(rows = []) {
    return rows.reduce((acc, row) => {
         const key = upper(row.currentFit || 'UNKNOWN') || 'UNKNOWN';
         acc[key] = (acc[key] || 0) + 1;
         return acc;
    }, {
         FIT: 0,
         OK: 0,
         NEUTRAL: 0,
         MISFIT: 0,
         UNKNOWN: 0
    });
}
function bestBy(rows = [], comparator) {
    return [...rows].filter(isAnalyzeMicroRow).sort(comparator)[0] || null;
}
function buildSideSummary(rows = []) {
    const longRows = rows.filter(isAnalyzeMicroRow);
    return {
         rows: longRows.length,
         bestBalanced: compactBestRow(bestBy(longRows, compareRowsBalanced)),
         bestAdaptive: compactBestRow(bestBy(longRows, compareRowsAdaptive)),
         bestCurrentFit: compactBestRow(bestBy(longRows, compareRowsCurrentFit)),
         bestWinrate: compactBestRow(bestBy(longRows, compareRowsWinrate)),
         bestTotalR: compactBestRow(bestBy(longRows, compareRowsTotalR)),
         bestAvgR: compactBestRow(bestBy(longRows, compareRowsAvgR)),
         lowestDirectSL: compactBestRow(bestBy(longRows, compareRowsDirectSL))
    };
}
function buildParentSummaries(rows = []) {
    const groups = new Map();
    for (const row of rows.filter(isAnalyzeMicroRow)) {
         const parentId = row.parentTrueMicroFamilyId || row.coarseMicroFamilyId ||
row.macroFamilyId;
         if (!parentId) continue;
         if (!groups.has(parentId)) groups.set(parentId, []);
         groups.get(parentId).push(row);
    }
    return [...groups.entries()]
         .map(([parentTrueMicroFamilyId, childRows]) => {
           const parsed = parseLongTaxonomyMicroId(parentTrueMicroFamilyId);
           const completed = childRows.reduce((sum, row) => sum + num(row.outcomeSample
?? getCompletedSample(row), 0), 0);
           const observationSample = childRows.reduce((sum, row) => sum +
num(row.observationSample ?? getObservationSample(row), 0), 0);
           const totalR = childRows.reduce((sum, row) => sum + getTotalR(row), 0);
           const totalCostR = childRows.reduce((sum, row) => sum + getTotalCostR(row),
0);
           const directSLCount = childRows.reduce((sum, row) => sum +
getDirectSLCount(row), 0);
           const fitScoreSum = childRows.reduce((sum, row) => sum +
num(row.currentFitScore ?? row.fitScore, 0), 0);
           return {
                parentTrueMicroFamilyId,
                macroFamilyId: parentTrueMicroFamilyId,
                taxonomySetup: parsed.setup,
                taxonomyRegime: parsed.regime,
                childCount: childRows.length,
                selectableChildCount: childRows.filter((row) =>
isSelectableTrueMicroId(row.trueMicroFamilyId)).length,
                completed: round(completed, 4),
                observationSample: round(observationSample, 4),
                totalR: round(totalR, 4),
                avgR: completed > 0 ? round(totalR / completed, 4) : 0,
                totalCostR: round(totalCostR, 4),
                avgCostR: completed > 0 ? round(totalCostR / completed, 4) : 0,
                directSLCount: round(directSLCount, 4),
                directSLPct: completed > 0 ? round(directSLCount / completed, 4) : 0,
                avgCurrentFitScore: childRows.length > 0
                  ? round(fitScoreSum / childRows.length, 4)
                  : 0,
                currentFitCounts: currentFitCounts(childRows),
                bestBalanced: compactBestRow(bestBy(childRows, compareRowsBalanced)),
                bestAdaptive: compactBestRow(bestBy(childRows, compareRowsAdaptive)),
                bestCurrentFit: compactBestRow(bestBy(childRows, compareRowsCurrentFit)),
                bestWinrate: compactBestRow(bestBy(childRows, compareRowsWinrate)),
                bestTotalR: compactBestRow(bestBy(childRows, compareRowsTotalR)),
                bestAvgR: compactBestRow(bestBy(childRows, compareRowsAvgR))
           };
      })
      .sort((a, b) => (
           compareNumberDesc(a.completed, b.completed) ||
           compareNumberDesc(a.totalR, b.totalR) ||
           compareNumberDesc(a.avgCurrentFitScore, b.avgCurrentFitScore) ||
           compareIdAsc(a.parentTrueMicroFamilyId, b.parentTrueMicroFamilyId)
      ));
}
function buildSummary(rows = [], activeSet = new Set()) {
 const safeRows = rows.filter(isAnalyzeMicroRow);
 const completedRows = safeRows.filter((row) => num(row.outcomeSample, 0) > 0);
 const observationRows = safeRows.filter((row) => num(row.observationSample, 0) >
0);
 const activeLearningRows = safeRows.filter((row) => row.status ===
'ACTIVE_LEARNING');
 const earlyOutcomeRows = safeRows.filter((row) => row.status ===
'EARLY_OUTCOMES');
 const observingRows = safeRows.filter((row) => row.status === 'OBSERVING');
 const empiricalVetoRows = safeRows.filter(isEmpiricallyVetoed);
 const activeRows = safeRows.filter((row) =>
      activeSet.has(row.trueMicroFamilyId) &&
      discordEligibilityFor(row).eligible
 );
 let totalR = 0;
 let totalSeen = 0;
 let totalCompleted = 0;
 let totalObservationSample = 0;
 let totalWinrateSample = 0;
 let totalCostR = 0;
 let totalDirectSLCount = 0;
 let totalObservationDuplicateSkippedCount = 0;
 let totalCurrentFitScore = 0;
 for (const row of safeRows) {
      totalR += getTotalR(row);
      totalSeen += num(row.seen, 0);
      totalCompleted += num(row.outcomeSample, 0);
      totalObservationSample += num(row.observationSample, 0);
      totalWinrateSample += num(row.winrateSample, 0);
      totalCostR += getTotalCostR(row);
      totalDirectSLCount += getDirectSLCount(row);
      totalObservationDuplicateSkippedCount +=
getObservationDuplicateSkippedCount(row);
      totalCurrentFitScore += num(row.currentFitScore ?? row.fitScore, 0);
 }
 return {
      rows: safeRows.length,
      activeRows: activeRows.length,
      activeIds: activeRows.length,
      empiricalVetoRows: empiricalVetoRows.length,
      empiricalVetoMicroFamilyIds: empiricalVetoRows
        .map((row) => row.trueMicroFamilyId)
        .filter(Boolean),
      ...modePayload(),
      seen: round(totalSeen, 4),
      completed: round(totalCompleted, 4),
      observationSample: round(totalObservationSample, 4),
      observationDuplicateSkippedCount: round(totalObservationDuplicateSkippedCount,
4),
      winrateSample: round(totalWinrateSample, 4),
      seenCompletedRatio: totalCompleted > 0 ? round(totalSeen / totalCompleted, 4)
: round(totalSeen, 4),
      completedMicroFamilies: completedRows.length,
      observationMicroFamilies: observationRows.length,
      awaitingOutcomeMicroFamilies: safeRows.filter((row) =>
row.awaitingOutcomes).length,
      activeLearningMicroFamilies: activeLearningRows.length,
      earlyOutcomeMicroFamilies: earlyOutcomeRows.length,
      observingMicroFamilies: observingRows.length,
      hardMicroFamilies: tierCounts(safeRows).HARD,
      softMicroFamilies: tierCounts(safeRows).SOFT,
      observationOnlyMicroFamilies: tierCounts(safeRows).OBSERVATION,
      rawMicroFamilies: tierCounts(safeRows).RAW,
      empiricalVetoMicroFamilies: tierCounts(safeRows).EMPIRICAL_VETO,
      tierCounts: tierCounts(safeRows),
      statusCounts: statusCounts(safeRows),
      currentFitCounts: currentFitCounts(safeRows),
      totalR: round(totalR, 4),
      totalCostR: round(totalCostR, 4),
      avgR: totalCompleted > 0 ? round(totalR / totalCompleted, 4) : 0,
      avgCostR: totalCompleted > 0 ? round(totalCostR / totalCompleted, 4) : 0,
      directSLCount: round(totalDirectSLCount, 4),
      directSLPct: totalCompleted > 0 ? round(totalDirectSLCount / totalCompleted,
4) : 0,
      avgCurrentFitScore: safeRows.length > 0
        ? round(totalCurrentFitScore / safeRows.length, 4)
        : 0,
      bestAdaptive: compactBestRow(bestBy(safeRows, compareRowsAdaptive)),
      bestCurrentFit: compactBestRow(bestBy(safeRows, compareRowsCurrentFit)),
      bestBalanced: compactBestRow(bestBy(safeRows, compareRowsBalanced)),
      bestTotalR: compactBestRow(bestBy(safeRows, compareRowsTotalR)),
      bestAvgR: compactBestRow(bestBy(safeRows, compareRowsAvgR)),
      bestWinrate: compactBestRow(bestBy(safeRows, compareRowsWinrate)),
      bestObserved: compactBestRow(bestBy(safeRows, compareRowsObserved)),
      lowestDirectSL: compactBestRow(bestBy(safeRows, compareRowsDirectSL)),
      long: buildSideSummary(safeRows),
      short: {
        rows: 0,
        bestBalanced: null,
        bestWinrate: null,
        bestTotalR: null,
        bestAvgR: null,
        lowestDirectSL: null
         }
    };
}
async function getActiveRotationSafe() {
    try {
         return await withTimeout(
              getActiveRotation({
                tradeSide: TARGET_TRADE_SIDE,
                side: TARGET_DASHBOARD_SIDE,
                weekKey: PERSISTENT_LEARNING_KEY,
                namespace: LONG_NAMESPACE,
                keyPrefix: LONG_KEY_PREFIX
              }),
              ACTIVE_ROTATION_TIMEOUT_MS,
              'GET_ACTIVE_ROTATION_TIMEOUT'
         );
    } catch {
         return null;
    }
}
function getCachedWeekMicros(weekKey) {
    const cached = cache.weekMicros.get(weekKey);
    if (!cached) return null;
    if (now() - cached.ts > CACHE_TTL_MS) return null;
    return cached.micros || {};
}
async function getWeekMicrosCached(weekKey, timeoutMs) {
    const cached = getCachedWeekMicros(weekKey);
    if (cached) {
         return {
              weekKey,
              micros: cached,
              cacheHit: true,
              stale: false,
              warning: null
         };
    }
    try {
         const micros = await withTimeout(
              getWeekMicros(weekKey),
              timeoutMs,
              `GET_WEEK_MICROS_TIMEOUT_${weekKey}`
         );
         cache.weekMicros.set(weekKey, {
              ts: now(),
              micros: micros || {}
         });
        pruneCacheMap(cache.weekMicros);
        return {
             weekKey,
             micros: micros || {},
             cacheHit: false,
             stale: false,
             warning: null
        };
    } catch (error) {
        const stale = cache.weekMicros.get(weekKey);
        if (stale?.micros) {
             return {
                  weekKey,
                  micros: stale.micros,
                  cacheHit: true,
                  stale: true,
                  warning: error?.message || String(error)
             };
        }
        return {
             weekKey,
             micros: {},
             cacheHit: false,
             stale: false,
             warning: error?.message || String(error)
        };
    }
}
function normalizeRows(rows = [], activeSet, activeMacroSet, compact) {
    return rows
        .filter(isAnalyzeMicroRow)
        .map((row, index) => normalizeMicroRow(row, index, {
             activeSet,
             activeMacroSet,
             compact
        }));
}
function selectBestMicroFamilyRows({
    rows = [],
    mode = 'adaptive',
    limit = DEFAULT_BEST_LIMIT
} = {}) {
    const safeLimit = toSafeLimit(limit, DEFAULT_BEST_LIMIT, MAX_BEST_LIMIT);
    return sortRowsByMode(
        rows.filter(isAnalyzeMicroRow),
        mode
    )
         .slice(0, safeLimit)
         .map((row, index) => ({
           ...row,
           rank: index + 1
         }));
}
function selectResponseRows({
    rankedRows = [],
    limit = DEFAULT_LIMIT,
    filters = {}
} = {}) {
    if (filters.side === 'SHORT_DISABLED') return [];
    return rankedRows
         .filter(isAnalyzeMicroRow)
         .slice(0, limit);
}
function splitSideRows(rows = [], sideLimit = DEFAULT_SIDE_LIMIT) {
    const longRows = rows
         .filter(isAnalyzeMicroRow)
         .slice(0, sideLimit);
    return {
         longRows,
         shortRows: [],
         unknownRows: []
    };
}
function forcedLongFallbackRows(activeRotation, existingRows = [], marketWeather
= null) {
    const existing = new Set(existingRows.map(rowKey).filter(Boolean));
    const rows = [];
    for (const id of extractActiveIds(activeRotation)) {
         if (existing.has(id)) continue;
         if (inferTradeSide(id) === OPPOSITE_TRADE_SIDE) continue;
         if (!validLearningId(id)) continue;
         if (!isSelectableTrueMicroId(id)) continue;
         const manual = manualRowFromId(id, rows.length, marketWeather);
         if (!manual) continue;
         rows.push(manual);
         existing.add(id);
    }
    return rows;
}
export default async function handler(req, res) {
    const startedAt = now();
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('X-Temporal-Context-Version', TEMPORAL_CONTEXT_VERSION);
    res.setHeader('X-Temporal-Stats-Version', TEMPORAL_STATS_VERSION);
    res.setHeader('X-Temporal-Policy-Version', TEMPORAL_POLICY_VERSION);
    res.setHeader('X-Temporal-Aggregation-Version', TEMPORAL_AGGREGATION_VERSION);
    res.setHeader('X-Temporal-Generation-Version', TEMPORAL_GENERATION_VERSION);
    res.setHeader('X-Temporal-Stats-Enabled', String(resolveTemporalStatsEnabled()));
    res.setHeader('X-Temporal-Policy-Mode', resolveTemporalPolicyMode());
    res.setHeader('X-Weekend-Policy-Version', WEEKEND_POLICY_VERSION);
 res.setHeader('X-Session-Policy-Version', SESSION_POLICY_VERSION);
 res.setHeader('X-Weekend-Mode', WEEKEND_MODE);
 res.setHeader('X-Session-Mode', SESSION_MODE);
 res.setHeader('X-Admin-Micro-Families-Mode', 'long-only-75-child-current-measurement-currentfit-temporal-v7');
 res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
 res.setHeader('X-Long-Only', 'true');
 res.setHeader('X-Short-Disabled', 'true');
 res.setHeader('X-Real-Orders-Disabled', 'true');
 res.setHeader('X-Bitget-Orders-Disabled', 'true');
 res.setHeader('X-Exchange-Calls-Disabled', 'true');
 res.setHeader('X-Virtual-Learning-Forced', 'true');
 res.setHeader('X-Net-Outcomes-Only', 'true');
 res.setHeader('X-Virtual-Outcomes-Included', 'true');
 res.setHeader('X-Shadow-Outcomes-Included', 'true');
 res.setHeader('X-Manual-Selection-Only', 'true');
 res.setHeader('X-Manual-Selection-Match-Mode', 'EXACT_TRUE_MICRO_FAMILY_ID');
 res.setHeader('X-Discord-Selection-Rule',
'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY');
 res.setHeader('X-Scanner-Side', TARGET_SCANNER_SIDE);
 res.setHeader('X-Scanner-Fingerprint-Legacy-Fallback',
String(SHOW_SCANNER_FINGERPRINT_LEGACY_FALLBACK));
 res.setHeader('X-Scanner-Fingerprints-Metadata-Only', 'true');
 res.setHeader('X-Execution-Fingerprints-Metadata-Only', 'true');
 res.setHeader('X-Analyze-Micro-Families-Only', 'true');
 res.setHeader('X-Learning-Identity-Source', 'ANALYZE_TRUE_MICRO_FAMILY');
 res.setHeader('X-True-Micro-Family-Schema', TRUE_MICRO_SCHEMA);
 res.setHeader('X-Child-True-Micro-Family-Schema', CHILD_TRUE_MICRO_SCHEMA);
 res.setHeader('X-Parent-True-Micro-Family-Schema', PARENT_TRUE_MICRO_SCHEMA);
 res.setHeader('X-Learning-Granularity', LEARNING_GRANULARITY);
 res.setHeader('X-Parent-Learning-Granularity', PARENT_LEARNING_GRANULARITY);
 res.setHeader('X-Persistent-Learning-Key', PERSISTENT_LEARNING_KEY);
 res.setHeader('X-Week-Reset-Disabled', 'true');
 res.setHeader('X-Default-Sort',
'LEARNING_QUALITY_THEN_ADAPTIVE_SCORE_NOT_RAW_WINRATE');
 res.setHeader('X-Measurement-Fix-Version', MEASUREMENT_FIX_VERSION);
 res.setHeader('X-Outcome-Measurement-Gate-Mode', OUTCOME_MEASUREMENT_GATE_MODE);
 res.setHeader('X-Legacy-Outcome-Measurements-Excluded', 'true');
 res.setHeader('X-Completed-Current-Measurement-Only', 'true');
 res.setHeader('X-Exit-Fill-Model-Version', EXIT_FILL_MODEL_VERSION);
 res.setHeader('X-Empirical-Veto-Policy-Version', EMPIRICAL_VETO_POLICY_VERSION);
 res.setHeader('X-Empirical-Veto-Min-Completed',
String(EMPIRICAL_VETO_MIN_COMPLETED));
 res.setHeader('X-Empirical-Veto-Max-Avg-R', String(EMPIRICAL_VETO_MAX_AVG_R));
 res.setHeader('X-Empirical-Veto-Blocks-Adaptive-Selection', 'true');
 res.setHeader('X-Empirical-Veto-Blocks-Manual-Activation', 'true');
 res.setHeader('X-Discord-Requires-Passed-Activation-Gate', 'true');
 res.setHeader('X-Discord-Min-Completed', String(EMPIRICAL_VETO_MIN_COMPLETED));
 res.setHeader('X-Discord-Requires-Positive-Avg-R', 'true');
 res.setHeader('X-Completed-Definition',
'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES_CURRENT_MEASUREMENT_ONLY');
 res.setHeader('X-Scoring-R-Source', 'netR');
 res.setHeader('X-Wins-Losses-Flats-Source', 'netR');
 res.setHeader('X-Avg-Cost-R-Source', 'costR');
 res.setHeader('X-Seen-Definition', 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY');
 res.setHeader('X-Current-Fit-Version', CURRENT_FIT_VERSION);
 res.setHeader('X-Current-Fit-Blocks-Learning', 'false');
 res.setHeader('X-Current-Fit-Score-Built', 'true');
 res.setHeader('X-Current-Fit-Null-Breadth-Preserved', 'true');
 res.setHeader('X-Seen-Completed-Ratio-Zero-Without-Outcomes', 'true');
 res.setHeader('X-MarketWeather-Engine-Built', 'true');
 res.setHeader('X-Redis-Namespace', LONG_NAMESPACE);
 res.setHeader('X-Short-Root-Touched', 'false');
 if (req.method !== 'GET') {
     return methodNotAllowed(res);
 }
 try {
     const currentWeekKey = PERSISTENT_LEARNING_KEY;
     const previousWeekKey = PERSISTENT_LEARNING_KEY;
     const requestedQueryWeekKey = String(
          firstQueryValue(req.query?.weekKey, PERSISTENT_LEARNING_KEY) ||
PERSISTENT_LEARNING_KEY
     ).trim();
     const requestedWeekKey = PERSISTENT_LEARNING_KEY;
     const requestedMode = String(firstQueryValue(req.query?.mode, 'adaptive') ||
'adaptive');
     const mode = normalizeMode(requestedMode);
     const requestedLimitRaw = firstQueryValue(req.query?.limit, DEFAULT_LIMIT);
     const requestedLimitNumber = Number(requestedLimitRaw) || DEFAULT_LIMIT;
     const limit = toSafeLimit(requestedLimitRaw, DEFAULT_LIMIT, MAX_LIMIT);
     const sideLimit = toSafeLimit(
          firstQueryValue(
               req.query?.sideLimit,
               firstQueryValue(req.query?.sideEnsureLimit, DEFAULT_SIDE_LIMIT)
          ),
          DEFAULT_SIDE_LIMIT,
          MAX_SIDE_LIMIT
     );
     const bestLimit = toSafeLimit(
          firstQueryValue(req.query?.bestLimit, DEFAULT_BEST_LIMIT),
          DEFAULT_BEST_LIMIT,
          MAX_BEST_LIMIT
     );
     const includeActiveRotation =
isTrue(firstQueryValue(req.query?.includeActiveRotation, false));
   const details = isTrue(firstQueryValue(req.query?.details, false));
   const compactRaw = firstQueryValue(req.query?.compact, null);
   const compact = details
        ? false
        : compactRaw === null
             ? true
             : isTrue(compactRaw);
   const filters = parseFilters(req);
   const narrowFilters = hasNarrowFilters(filters);
   const [activeRotation, weekResult, marketWeather] = await Promise.all([
        getActiveRotationSafe(),
        getWeekMicrosCached(PERSISTENT_LEARNING_KEY, WEEK_MICROS_TIMEOUT_MS),
        getCurrentMarketWeatherSafe()
   ]);
   const activeMicroFamilyIds = extractActiveIds(activeRotation);
   const activeMacroFamilyIds = extractActiveMacroIds(activeRotation);
   const activeSet = new Set(activeMicroFamilyIds);
   const activeMacroSet = new Set(activeMacroFamilyIds);
   const taxonomyRows = filters.includeEmpty
        ? generateLongTaxonomyRows()
             .map((row, index) => decorateMicroRow(
                  buildRawMicroRow(row, row.trueMicroFamilyId, index),
                  marketWeather
             ))
             .filter(Boolean)
        : [];
   const weekRows = buildRowsFromMicros(weekResult.micros, marketWeather);
   const activeFallbackRows = buildRowsFromActiveRotation(activeRotation,
marketWeather);
   let mergedRows = mergeRows(
        mergeRows(weekRows, activeFallbackRows),
        taxonomyRows
   );
   if (mergedRows.length === 0 && activeFallbackRows.length > 0) {
        mergedRows = activeFallbackRows;
   }
   mergedRows = mergedRows.map((row) => {
        const id = getTrueMicroFamilyId(row);
        const parent = getCoarseMicroFamilyId(row);
        const storedActive = Boolean(
             row.storedActive ||
             row.active ||
             activeSet.has(id)
        );
        const storedMacroActive = Boolean(
             row.storedMacroActive ||
            row.macroActive ||
            activeMacroSet.has(parent)
       );
       const discord = discordEligibilityFor(row);
       return {
            ...row,
            storedActive,
            storedMacroActive,
            active: storedActive && discord.eligible,
            macroActive: storedMacroActive && discord.eligible,
            selectionSuppressedByDiscordGate:
              storedActive && !discord.eligible,
            discordEligible: discord.eligible,
            discordBlocked: discord.blocked,
            discordActivationGatePassed: discord.gatePassed,
            discordBlockReason: discord.reason
       };
   });
   const storedActiveMicroFamilyIds = [...activeMicroFamilyIds];
   const effectiveDiscordActiveMicroFamilyIds = mergedRows
       .filter((row) => row.active === true)
       .map((row) => row.trueMicroFamilyId)
       .filter(Boolean);
   const suppressedActiveMicroFamilyIds = mergedRows
       .filter((row) => row.selectionSuppressedByDiscordGate === true)
       .map((row) => row.trueMicroFamilyId)
       .filter(Boolean);
   let filteredRows = mergedRows.filter((row) => (
       rowPassesFilters(row, filters, activeSet, activeMacroSet)
   ));
   const usedForcedLongFallback =
       filters.side === TARGET_TRADE_SIDE &&
       filteredRows.length === 0 &&
       activeRotation;
   if (usedForcedLongFallback) {
       const fallbackLongRows = forcedLongFallbackRows(activeRotation,
mergedRows, marketWeather);
       if (fallbackLongRows.length > 0) {
            mergedRows = mergeRows(mergedRows, fallbackLongRows);
            filteredRows = fallbackLongRows.filter((row) => (
              rowPassesFilters(row, filters, activeSet, activeMacroSet)
            ));
       }
   }
   const best75RawRows = selectBestMicroFamilyRows({
       rows: mergedRows,
       mode,
        limit: bestLimit
   });
   const best75MicroFamilies = normalizeRows(
        best75RawRows,
        activeSet,
        activeMacroSet,
        compact
   );
   const rankedRows = sortRowsByMode(filteredRows, mode)
        .map((row, index) => ({
          ...row,
          rank: index + 1
        }));
   const responseRows = selectResponseRows({
        rankedRows,
        limit,
        filters
   });
   const displayRows = narrowFilters
        ? responseRows
        : best75RawRows;
   const splitBaseRows = narrowFilters
        ? rankedRows
        : best75RawRows;
   const split = splitSideRows(splitBaseRows, sideLimit);
   const normalizedRows = normalizeRows(displayRows, activeSet, activeMacroSet,
compact);
   const normalizedLongRows = normalizeRows(split.longRows, activeSet,
activeMacroSet, compact);
   const summary = buildSummary(rankedRows, activeSet);
   const parentSummaries = buildParentSummaries(mergedRows);
   const bestLong =
        best75RawRows[0] ||
        split.longRows[0] ||
        null;
   const rawScannerFingerprintRowsHidden =
sourceEntriesFromMicros(weekResult.micros)
        .filter(([key, row]) => {
          const id = String(
               row?.trueMicroFamilyId ||
               row?.learningMicroFamilyId ||
               row?.analyzeMicroFamilyId ||
               row?.microFamilyId ||
               key ||
               ''
          );
          return (
               isScannerFingerprintId(id) ||
               isScannerFingerprintId(row?.trueMicroFamilyId) ||
               isScannerFingerprintId(row?.coarseMicroFamilyId)
          );
     })
     .length;
   const rawExecutionFingerprintRowsHidden =
sourceEntriesFromMicros(weekResult.micros)
     .filter(([key, row]) => {
          const id = String(
               row?.trueMicroFamilyId ||
               row?.learningMicroFamilyId ||
               row?.analyzeMicroFamilyId ||
               row?.microFamilyId ||
               key ||
               ''
          );
          return (
               isExecutionFingerprintId(id) ||
               isExecutionFingerprintId(row?.trueMicroFamilyId) ||
               isExecutionFingerprintId(row?.coarseMicroFamilyId)
          );
     })
     .length;
   const parentRowsHidden = sourceEntriesFromMicros(weekResult.micros)
     .filter(([key, row]) => {
          const id = String(
               row?.trueMicroFamilyId ||
               row?.learningMicroFamilyId ||
               row?.analyzeMicroFamilyId ||
               row?.microFamilyId ||
               key ||
               ''
          );
          return isFixedLongParentMicroId(id);
     })
     .length;
   const nonSelectableRowsHidden = sourceEntriesFromMicros(weekResult.micros)
     .filter(([key, row]) => {
          const id = String(
               row?.trueMicroFamilyId ||
               row?.learningMicroFamilyId ||
               row?.analyzeMicroFamilyId ||
               row?.microFamilyId ||
               key ||
               ''
          );
             return Boolean(id && !isScannerFingerprintId(id) &&
!isExecutionFingerprintId(id) && !isSelectableTrueMicroId(id));
        })
        .length;
   const fitCounts = currentFitCounts(mergedRows);
   const currentFitUnknownRows = fitCounts.UNKNOWN || 0;
   const empiricalVetoRows = mergedRows.filter(
        (row) => row.empiricalVeto === true ||
             row.empiricalVetoed === true ||
             isEmpiricallyVetoed(row)
   );
   const empiricalVetoMicroFamilyIds = empiricalVetoRows
        .map((row) => getTrueMicroFamilyId(row))
        .filter(Boolean);
   const legacyMeasurementRowsSanitized =
        sourceEntriesFromMicros(weekResult.micros)
             .filter(([, row]) => (
                  rowMeasurementFixVersion(row) !==
                  MEASUREMENT_FIX_VERSION
             ))
             .length;
   const currentVersionAggregateIntegrityRowsSanitized =
        sourceEntriesFromMicros(weekResult.micros)
             .filter(([, row]) => (
                  rowMeasurementFixVersion(row) ===
                    MEASUREMENT_FIX_VERSION &&
                  !measurementAggregateIntegrity(row).valid
             ))
             .length;
   const warnings = uniqueStrings([
        requestedQueryWeekKey !== PERSISTENT_LEARNING_KEY
             ? `QUERY_WEEKKEY_IGNORED_USING_PERSISTENT:${requestedQueryWeekKey}`
             : null,
        weekResult.warning,
        marketWeather.available !== true
             ? `MARKET_WEATHER_UNAVAILABLE:${marketWeather.reason || 'UNKNOWN'}`
             : null,
        currentFitUnknownRows >= mergedRows.length
             ? 'CURRENTFIT_ALL_UNKNOWN_MARKET_WEATHER_NOT_USABLE'
             : null,
        legacyMeasurementRowsSanitized > 0
             ? `LEGACY_MEASUREMENT_ROWS_SANITIZED:${legacyMeasurementRowsSanitized}`
             : null,
        currentVersionAggregateIntegrityRowsSanitized > 0
             ?
`CURRENT_VERSION_AGGREGATE_INTEGRITY_ROWS_SANITIZED:${currentVersionAggregateIntegrityRowsSanitized}`
             : null,
     empiricalVetoRows.length > 0
       ? `EMPIRICAL_VETO_ROWS_BLOCKED:${empiricalVetoRows.length}`
       : null,
     suppressedActiveMicroFamilyIds.length > 0
       ?
`STORED_ACTIVE_IDS_SUPPRESSED_BY_STRICT_DISCORD_GATE:${suppressedActiveMicroFamilyIds.length}`
       : null,
     weekRows.length === 0 && activeFallbackRows.length > 0
       ? 'USED_ACTIVE_ROTATION_FALLBACK_ROWS'
       : null,
     usedForcedLongFallback
       ? 'USED_FORCED_LONG_ACTIVE_ROTATION_FALLBACK'
       : null,
     rawScannerFingerprintRowsHidden > 0
       ?
`SCANNER_FINGERPRINT_ROWS_HIDDEN_METADATA_ONLY:${rawScannerFingerprintRowsHidden}`
       : null,
     rawExecutionFingerprintRowsHidden > 0
       ?
`EXECUTION_FINGERPRINT_ROWS_HIDDEN_METADATA_ONLY:${rawExecutionFingerprintRowsHidden}`
       : null,
     parentRowsHidden > 0
       ?
`PARENT_15_ROWS_HIDDEN_FROM_SELECTABLE_LIST_METADATA_ONLY:${parentRowsHidden}`
       : null,
     nonSelectableRowsHidden > 0
       ? `NON_75_CHILD_ROWS_HIDDEN:${nonSelectableRowsHidden}`
       : null,
     rankedRows.length === 0
       ? 'NO_SELECTABLE_75_CHILD_TRUE_MICRO_ROWS_AFTER_FILTERS'
       : null,
     best75MicroFamilies.length === 0
       ? 'NO_BEST75_SELECTABLE_TRUE_MICRO_FAMILIES_AVAILABLE'
       : null
   ].filter(Boolean));
   return res.status(200).json({
     ok: true,
     fixed: true,
     ...modePayload(),
     availableTiers: ['HARD', 'SOFT', 'OBSERVATION', 'RAW', 'EMPIRICAL_VETO'],
     availableStatuses: ['ACTIVE_LEARNING', 'EARLY_OUTCOMES', 'OBSERVING'],
     availableActivationGateStatuses: ['PASSED', 'OBSERVING', 'EMPIRICAL_VETO'],
     availableCurrentFit: ['FIT', 'OK', 'NEUTRAL', 'MISFIT', 'UNKNOWN'],
     availableCurrentFitCanonical: ['MATCH', 'WEAK_MATCH', 'NEUTRAL', 'MISFIT',
'UNKNOWN'],
     measurementPolicy: {
       version: MEASUREMENT_FIX_VERSION,
          previousVersion: PREVIOUS_MEASUREMENT_FIX_VERSION,
          gateMode: OUTCOME_MEASUREMENT_GATE_MODE,
          strictExactVersionRequired: true,
          legacyOutcomeMeasurementsExcluded: true,
          completedCurrentMeasurementOnly: true,
          exitFillModelVersion: EXIT_FILL_MODEL_VERSION,
          exitFillPolicy: 'TP and SL use their trigger boundary; TIME_STOP uses observed market price; cost model is applied afterwards',
          avgCostR: 'avgCostR = totalCostR / closedVirtualShadowCompleted, fallback avgCostR/costR/current-version recentOutcomes.costR',
          totalCostR: 'virtualTotalCostR + shadowTotalCostR when > 0, fallback totalCostR, fallback avgCostR * completed, fallback costR * completed, fallback current-version recentOutcomes.costR * completed',
          directSL: 'directSLCount / closedVirtualShadowCompleted',
          seen: 'seen and observations come only from unique observation dedupe keys',
          completed: 'only closed VIRTUAL + SHADOW outcomes carrying the exact current measurementFixVersion',
          scoringRSource: 'netR',
          winsLossesFlatsSource: 'netR',
          winDefinition: 'netR > 0',
          flatDefinition: 'netR == 0 and does not count as a win',
          zeroOutcomeReliability: 0,
          rawWinrateRankingDisabled: true
     },
     empiricalVetoPolicy: {
          enabled: true,
          version: EMPIRICAL_VETO_POLICY_VERSION,
          appliesTo: 'EXACT_75_CHILD_LONG_TRUE_MICRO_FAMILIES_ONLY',
          measurementFixVersion: MEASUREMENT_FIX_VERSION,
          minCompleted: EMPIRICAL_VETO_MIN_COMPLETED,
          maxAvgR: EMPIRICAL_VETO_MAX_AVG_R,
          observingRule:
            `completed < ${EMPIRICAL_VETO_MIN_COMPLETED}`,
          observingDiscordEligible: false,
          passedRule:
            `completed >= ${EMPIRICAL_VETO_MIN_COMPLETED} && avgR >
${EMPIRICAL_VETO_MAX_AVG_R}`,
          vetoRule:
            `completed >= ${EMPIRICAL_VETO_MIN_COMPLETED} && avgR <=
${EMPIRICAL_VETO_MAX_AVG_R}`,
          blocksAdaptiveSelection: true,
          blocksManualActivation: true,
          removesActiveDiscordSelection: true,
          reversibleWhenAvgRRecovers: true,
          empiricalVetoCount: empiricalVetoRows.length,
          empiricalVetoMicroFamilyIds
     },
     currentFitPolicy: {
          version: CURRENT_FIT_VERSION,
          marketWeatherKeys: MARKET_WEATHER_READ_KEYS,
          marketWeatherAvailable: Boolean(marketWeather.available),
          sourceKey: marketWeather.sourceKey || null,
          redisSource: marketWeather.redisSource || null,
          sourceKeys: marketWeather.sourceKeys || [],
          redisSources: marketWeather.redisSources || [],
          candidatesRead: marketWeather.candidatesRead || 0,
          usableCandidates: marketWeather.usableCandidates || 0,
          timestamp: marketWeather.timestamp || null,
          timestampKnown: Boolean(marketWeather.timestampKnown),
          ageSec: marketWeather.ageSec ?? null,
          stale: Boolean(marketWeather.stale),
          maxAgeSec: CURRENT_FIT_MAX_WEATHER_AGE_SEC,
          currentRegime: marketWeather.currentRegime,
          currentTrendSide: marketWeather.currentTrendSide,
          bearishPct: marketWeather.bearishPct,
          bullishPct: marketWeather.bullishPct,
          squeezePct: marketWeather.squeezePct,
          confidence: marketWeather.confidence,
          reason: marketWeather.reason || null,
          softOnly: true,
          blocksLearning: false,
          blocksVirtualLearning: false,
          blocksShadowLearning: false,
          canBlockDiscordOnly: true,
          unknownBlocksDiscord: true,
          neutralBlocksDiscord: true,
          matchLabels: ['FIT', 'OK'],
          canonicalMatchLabels: ['MATCH', 'WEAK_MATCH'],
          polarity: 'bullish market = positive for LONG; bearish market = negative for LONG',
          nullBreadthPreserved: true,
          missingBreadthIsNotZero: true
     },
     riskOutcomePolicy: {
          side: TARGET_TRADE_SIDE,
          validGeometry: 'sl < entry < tp',
          tpHit: 'price >= tp',
          slHit: 'price <= sl',
          grossR: '(exitPrice - entry) / (entry - initialSl)',
          currentR: '(currentPrice - entry) / (entry - initialSl)',
          tpExitFill: 'exitPrice = tp trigger boundary',
          slExitFill: 'exitPrice = active sl trigger boundary',
          timeStopExitFill: 'exitPrice = observed market price',
          exitFillModelVersion: EXIT_FILL_MODEL_VERSION,
          realOrdersDisabled: true,
          virtualOutcomesIncluded: true,
          shadowOutcomesIncluded: true,
          realOutcomesExcluded: true
     },
     statusRules: {
          OBSERVING: 'completed == 0',
          EARLY_OUTCOMES: `completed > 0 && completed <
${MIN_COMPLETED_ACTIVE_LEARNING}`,
          ACTIVE_LEARNING: `completed >= ${MIN_COMPLETED_ACTIVE_LEARNING}`
     },
     activationGateRules: {
          OBSERVING:
            `completed < ${EMPIRICAL_VETO_MIN_COMPLETED}`,
          PASSED:
            `completed >= ${EMPIRICAL_VETO_MIN_COMPLETED} && avgR >
${EMPIRICAL_VETO_MAX_AVG_R}`,
          EMPIRICAL_VETO:
            `completed >= ${EMPIRICAL_VETO_MIN_COMPLETED} && avgR <=
${EMPIRICAL_VETO_MAX_AVG_R}`
     },
     taxonomy: {
          parentCount: 15,
          selectableChildCount: 75,
          setups: SETUP_ORDER,
          regimes: REGIME_ORDER,
          confirmationProfiles: CONFIRMATION_PROFILE_ORDER,
          parentFormat: 'MICRO_LONG_{SETUP}_{REGIME}',
          childFormat: 'MICRO_LONG_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',
          selectableIdsAreChildrenOnly: true,
          parentIdsAreMetadataOnly: true,
          trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
          childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
          parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA
     },
     rankingPolicy: {
          defaultMode: 'adaptive',
          activeMode: mode,
          defaultSort: 'learningQualityRank/adaptiveScore/dashboardBalancedScore/fairWinrate/totalR/avgR/avgCostR/currentFitScore',
          bestDataFirst: true,
          completedBeforeRawScore: true,
          rawWinrateIsNeverDefault: true,
          rawWinrateIsNeverAlone: true,
          scoreKeys: ['adaptiveScore', 'dashboardBalancedScore', 'balancedScore',
'fairWinrate', 'totalR', 'avgR', 'avgCostR', 'currentFitScore'],
          scannerFingerprintsExcludedFromRows:
SHOW_SCANNER_FINGERPRINT_LEGACY_FALLBACK !== true,
          scannerFingerprintLegacyFallback:
SHOW_SCANNER_FINGERPRINT_LEGACY_FALLBACK,
          scannerFingerprintsMetadataOnly: true,
          scannerFingerprintLegacyFallbackRows: 0,
          rawScannerFingerprintRowsHidden,
          rawExecutionFingerprintRowsHidden,
          parentRowsHidden,
          nonSelectableRowsHidden,
          executionFingerprintsMetadataOnly: true,
          analyzeMicroFamiliesOnly: true,
          trueMicroFamilyOnly: true,
          exactTrueMicroOnly: true,
          selectableChildOnly: true,
          trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
          childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
          parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
          learningGranularity: LEARNING_GRANULARITY,
          parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
          symbolExcludedFromFamilyId: true,
          persistentLearningKey: PERSISTENT_LEARNING_KEY,
          weekResetDisabled: true,
          scoringRSource: 'netR',
          winsLossesFlatsSource: 'netR',
          winrateDefinition: 'netR > 0',
          avgCostRSource: 'costR',
          empiricalVetoEnabled: true,
          empiricalVetoPolicyVersion: EMPIRICAL_VETO_POLICY_VERSION,
          empiricalVetoBlocksAdaptiveSelection: true,
          empiricalVetoRowsSortLast: true,
          adaptiveLearningQualityFirst: true,
          zeroOutcomeReliabilityIsZero: true,
          flatsCountAsWins: false,
          discordRequiresPassedActivationGate: true,
          missingBreadthIsNotZero: true,
          seenCompletedRatioZeroWhenNoCompleted: true
     },
     adaptiveLayerPolicy: {
          learningRemainsBroad: true,
          selectionWillBeAdaptive: true,
          discordWillBeStrict: true,
          currentFitSoftOnly: true,
          currentFitBlocksLearning: false,
          adaptiveLayerBuilt: false,
          marketWeatherEngineBuilt: true,
     recentMomentumScoreBuilt: false,
     currentFitScoreBuilt: true,
     parentDiversificationBuilt: false,
     empiricalVetoBuilt: true,
     empiricalVetoBlocksManualActivation: true,
     empiricalVetoRemovesActiveDiscordSelection: true,
     buildAdaptiveLayerAfterMeasurementClean: true
},
weekKey: PERSISTENT_LEARNING_KEY,
requestedWeekKey,
requestedQueryWeekKey,
ignoredQueryWeekKey: requestedQueryWeekKey !== PERSISTENT_LEARNING_KEY
     ? requestedQueryWeekKey
     : null,
sourceWeekKeyUsed: PERSISTENT_LEARNING_KEY,
source: 'persistentLearningKey',
currentWeekKey,
previousWeekKey,
primaryWeekKey: PERSISTENT_LEARNING_KEY,
primaryWeekRows: microsCount(weekResult.micros),
previousWeekRows: 0,
mergedPreviousWeek: false,
recentWeekLookback: 1,
recentWeekKeysScanned: [PERSISTENT_LEARNING_KEY],
recentWeekRows: [{
     weekKey: PERSISTENT_LEARNING_KEY,
     rows: microsCount(weekResult.micros),
     cacheHit: Boolean(weekResult.cacheHit),
     stale: Boolean(weekResult.stale)
}],
allRecentWeekKeysChecked: [PERSISTENT_LEARNING_KEY],
allRecentWeekRowsChecked: [{
     weekKey: PERSISTENT_LEARNING_KEY,
     rows: microsCount(weekResult.micros),
     cacheHit: Boolean(weekResult.cacheHit),
     stale: Boolean(weekResult.stale)
}],
mode,
requestedMode,
requestedLimit: requestedLimitNumber,
limit,
limitCapped: requestedLimitNumber > limit,
sideLimit,
sideEnsureLimit: sideLimit,
bestLimit,
best75Count: best75MicroFamilies.length,
best75MicroFamilies,
best25Count: best75MicroFamilies.slice(0, 25).length,
best25MicroFamilies: best75MicroFamilies.slice(0, 25),
topMicroFamilies: best75MicroFamilies,
bestMicroFamilies: best75MicroFamilies,
filters,
narrowFilters,
compact,
count: normalizedRows.length,
rowsRendered: normalizedRows.length,
filtered: rankedRows.length,
totalAvailable: mergedRows.length,
rawExtractedRows: mergedRows.length,
generatedSelectableTaxonomyRows: taxonomyRows.length,
selectableChildFamiliesTotal: 75,
parentFamiliesTotal: 15,
weekRows: weekRows.length,
activeFallbackRows: activeFallbackRows.length,
scannerFingerprintLegacyRows: 0,
rawScannerFingerprintRowsHidden,
rawExecutionFingerprintRowsHidden,
parentRowsHidden,
nonSelectableRowsHidden,
legacyMeasurementRowsSanitized,
currentVersionAggregateIntegrityRowsSanitized,
empiricalVetoCount: empiricalVetoRows.length,
empiricalVetoMicroFamilyIds,
rawSideCounts: sideCounts(mergedRows),
filteredSideCounts: sideCounts(rankedRows),
responseSideCounts: sideCounts(normalizedRows),
best75SideCounts: sideCounts(best75MicroFamilies),
tierCounts: tierCounts(rankedRows),
statusCounts: statusCounts(rankedRows),
currentFitCounts: fitCounts,
currentFitUnknownRows,
activeRotationId: activeRotation?.rotationId || null,
activeRotation: includeActiveRotation
  ? activeRotation
  : compactActiveRotation(activeRotation),
storedActiveMicroFamilyIds,
effectiveDiscordActiveMicroFamilyIds,
suppressedActiveMicroFamilyIds,
activeMicroFamilyIds: effectiveDiscordActiveMicroFamilyIds,
activeMacroFamilyIds,
bestLong: compactBestRow(bestLong),
bestShort: null,
parentSummaries,
longRows: normalizedLongRows,
          shortRows: [],
          unknownRows: [],
          summary,
          rows: normalizedRows,
          trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
          parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
          rankingPolicyText: 'learningQualityRank|adaptiveScore|balancedScore|fairWinrate|totalR|avgR|avgCostR|currentFitScore',
          rankingPolicyLong:
'learningQualityRank|adaptiveScore|balancedScore|fairWinrate|totalR|avgR|avgCostR',
          measurementFixVersion: MEASUREMENT_FIX_VERSION,
          adaptiveUiVersion: ADAPTIVE_UI_VERSION,
          currentFitVersion: CURRENT_FIT_VERSION,
          warnings,
          error: null,
          perf: {
               durationMs: now() - startedAt,
               weekMicrosCacheHit: Boolean(weekResult.cacheHit),
               weekMicrosCacheStale: Boolean(weekResult.stale),
               weekMicrosCacheSize: cache.weekMicros.size,
               path: 'longOnly75ChildCurrentMeasurementGateTriggerBoundaryFillCurrentFitStrictDiscordRankingTemporalV7',
               best75Source: 'persistentLearningMergedRowsBeforeFilters'
          },
          serverTs: Date.now()
        });
    } catch (error) {
        return res.status(500).json({
          ok: false,
          ...modePayload(),
          error: error?.message || String(error),
          stack: process.env.NODE_ENV === 'production'
               ? undefined
               : error?.stack
        });
    }
}
