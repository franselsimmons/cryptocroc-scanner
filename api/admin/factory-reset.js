// ================= FILE: api/admin/factory-reset.js =================
import { randomUUID } from 'node:crypto';
import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import {
 getDurableRedis,
 getVolatileRedis,
 delPattern,
 pushJsonLog
} from '../../src/redis.js';
import { getOpenPositions } from '../../src/trade/positionEngine.js';
import { sendResetReport } from '../../src/discord/discord.js';
import { sideToTradeSide } from '../../src/utils.js';
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

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY';
const LEARNING_GRANULARITY =
'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const LOCK_TTL_SEC = 300;
const DEFAULT_CONFIRM_TEXT = 'LONG_FACTORY_RESET_CONFIRMED';
const DEFAULT_ROTATION_CONFIRM_TEXT = 'LONG_RESET_ROTATION_CONFIRMED';
const LONG_FIXED_SETUP_TYPES = new Set([
    'BREAKOUT',
    'RETEST',
    'SWEEP_REVERSAL',
    'CONTINUATION',
    'COMPRESSION'
]);
const LONG_FIXED_REGIME_BUCKETS = new Set([
    'TREND',
    'CHOP',
    'SQUEEZE'
]);
const LONG_CONFIRMATION_PROFILES = new Set([
    'A_STRONG_ALIGN',
    'B_FLOW_ALIGN',
    'C_VOLUME_ALIGN',
    'D_MIXED_OK',
    'E_WEAK_CONTRA'
]);
const CONFIRMATION_PROFILE_ORDER = [
    'A_STRONG_ALIGN',
    'B_FLOW_ALIGN',
    'C_VOLUME_ALIGN',
    'D_MIXED_OK',
    'E_WEAK_CONTRA'
];
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
    let raw = String(callMaybeKey(key, fallback) || '').trim();
    if (!raw) return null;
    if (raw.startsWith(LONG_KEY_PREFIX)) return raw;
    if (raw.startsWith('SHORT:')) raw = raw.slice('SHORT:'.length);
    return `${LONG_KEY_PREFIX}${raw}`;
}
function namespacedLongPattern(pattern, fallback = null) {
    return namespacedLongKey(pattern, fallback);
}
const LONG_KEYS = {
    scan: {
         lock: namespacedLongKey(
              KEYS.long?.scan?.lock ||
                KEYS.scan?.longLock ||
                KEYS.scan?.lock,
              'SCAN:LOCK'
         ),
         snapshotPattern: namespacedLongPattern(
              KEYS.long?.scan?.snapshotPattern ||
                KEYS.scan?.longSnapshotPattern,
              'SCAN:SNAPSHOT:*'
         ),
         latest: namespacedLongKey(
              KEYS.long?.scan?.latest ||
                KEYS.scan?.longLatest ||
                KEYS.scan?.latest,
              'SCAN:LATEST'
         ),
         runMeta: namespacedLongKey(
              KEYS.long?.scan?.runMeta ||
                KEYS.scan?.longRunMeta ||
                KEYS.scan?.runMeta,
              'SCAN:RUN_META'
         )
    },
    trade: {
         lock: namespacedLongKey(
              KEYS.long?.trade?.lock ||
                KEYS.trade?.longLock ||
                KEYS.trade?.lock,
              'TRADE:LOCK'
         ),
         openPattern: namespacedLongPattern(
              KEYS.long?.trade?.openPattern ||
            KEYS.trade?.longOpenPattern,
          'TRADE:OPEN:*'
     ),
     lastProcessedSnapshot: namespacedLongKey(
          KEYS.long?.trade?.lastProcessedSnapshot ||
            KEYS.trade?.longLastProcessedSnapshot ||
            KEYS.trade?.lastProcessedSnapshot,
          'TRADE:LAST_PROCESSED_SNAPSHOT'
     ),
     runMeta: namespacedLongKey(
          KEYS.long?.trade?.runMeta ||
            KEYS.trade?.longRunMeta ||
            KEYS.trade?.runMeta,
          'TRADE:RUN_META'
     )
},
analyze: {
     freezeLock: namespacedLongKey(
          KEYS.long?.analyze?.freezeLock ||
            KEYS.analyze?.longFreezeLock ||
            KEYS.analyze?.freezeLock,
          'ANALYZE:WEEKLY_FREEZE_LOCK'
     ),
     activateLock: namespacedLongKey(
          KEYS.long?.analyze?.activateLock ||
            KEYS.analyze?.longActivateLock ||
            KEYS.analyze?.activateLock,
          'ANALYZE:ROTATION_ACTIVATE_LOCK'
     ),
     activeRotation: namespacedLongKey(
          KEYS.long?.analyze?.activeRotation ||
            KEYS.analyze?.longActiveRotation ||
            KEYS.analyze?.activeRotation,
          'ANALYZE:ACTIVE_ROTATION'
     ),
     nextRotation: namespacedLongKey(
          KEYS.long?.analyze?.nextRotation ||
            KEYS.analyze?.longNextRotation ||
            KEYS.analyze?.nextRotation,
          'ANALYZE:NEXT_ROTATION'
     ),
     rotationValidFrom: namespacedLongKey(
          KEYS.long?.analyze?.rotationValidFrom ||
            KEYS.analyze?.longRotationValidFrom ||
            KEYS.analyze?.rotationValidFrom,
          'ANALYZE:ROTATION_VALID_FROM'
     ),
     weekPattern: namespacedLongPattern(
          KEYS.long?.analyze?.weekPattern ||
            KEYS.analyze?.longWeekPattern,
          'ANALYZE:WEEK:*'
     ),
     microPattern: namespacedLongPattern(
          KEYS.long?.analyze?.microPattern ||
            KEYS.analyze?.longMicroPattern,
          'ANALYZE:MICRO:*'
     ),
     obsLastPattern: namespacedLongPattern(
          KEYS.long?.analyze?.obsLastPattern ||
            KEYS.analyze?.longObsLastPattern,
          'ANALYZE:OBS:LAST:*'
     ),
     shadowPattern: namespacedLongPattern(
          KEYS.long?.analyze?.shadowPattern ||
            KEYS.analyze?.longShadowPattern,
          'ANALYZE:SHADOW:*'
     ),
     outcomePattern: namespacedLongPattern(
          KEYS.long?.analyze?.outcomePattern ||
            KEYS.analyze?.longOutcomePattern,
          'ANALYZE:OUTCOME:*'
     ),
     temporalPattern: namespacedLongPattern(
          KEYS.long?.analyze?.temporalPattern ||
            KEYS.analyze?.longTemporalPattern,
          null
     ),
     contextStatsPattern: namespacedLongPattern(
          KEYS.long?.analyze?.contextStatsPattern ||
            KEYS.analyze?.longContextStatsPattern,
          null
     ),
     dayOfWeekStatsPattern: namespacedLongPattern(
          KEYS.long?.analyze?.dayOfWeekStatsPattern ||
            KEYS.analyze?.longDayOfWeekStatsPattern,
          null
     ),
     sessionStatsPattern: namespacedLongPattern(
          KEYS.long?.analyze?.sessionStatsPattern ||
            KEYS.analyze?.longSessionStatsPattern,
          null
     ),
     temporalGenerationPattern: namespacedLongPattern(
          KEYS.long?.analyze?.temporalGenerationPattern ||
            KEYS.analyze?.longTemporalGenerationPattern,
          null
     ),
     activeTemporalGeneration: namespacedLongKey(
          KEYS.long?.analyze?.activeTemporalGeneration ||
            KEYS.analyze?.longActiveTemporalGeneration,
          null
     ),
     nextTemporalGeneration: namespacedLongKey(
          KEYS.long?.analyze?.nextTemporalGeneration ||
            KEYS.analyze?.longNextTemporalGeneration,
          null
     ),
     temporalSequencePattern: namespacedLongPattern(
          KEYS.long?.analyze?.temporalSequencePattern ||
            KEYS.analyze?.longTemporalSequencePattern,
          null
     ),
     temporalDecisionPattern: namespacedLongPattern(
          KEYS.long?.analyze?.temporalDecisionPattern ||
            KEYS.analyze?.longTemporalDecisionPattern,
          null
     ),
     temporalBackfillPattern: namespacedLongPattern(
          KEYS.long?.analyze?.temporalBackfillPattern ||
            KEYS.analyze?.longTemporalBackfillPattern,
          null
     ),
     temporalAuditPattern: namespacedLongPattern(
          KEYS.long?.analyze?.temporalAuditPattern ||
            KEYS.analyze?.longTemporalAuditPattern,
          null
     )
},
reset: {
     logList: namespacedLongKey(
          KEYS.long?.reset?.logList ||
            KEYS.reset?.longLogList ||
            KEYS.reset?.logList,
          'RESET:LOGS'
     )
},
circuit: {
     pausedPattern: namespacedLongPattern(
          KEYS.long?.circuit?.pausedPattern ||
            KEYS.circuit?.longPausedPattern,
          'CIRCUIT:PAUSED:*'
     )
},
cache: {
     livePattern: namespacedLongPattern(
          KEYS.long?.cache?.livePattern ||
            KEYS.cache?.longLivePattern,
          'LIVE:CACHE:*'
     ),
         marketPattern: namespacedLongPattern(
              KEYS.long?.cache?.marketPattern ||
                KEYS.cache?.longMarketPattern,
              'MARKET:CACHE:*'
         ),
         bitgetPattern: namespacedLongPattern(
              KEYS.long?.cache?.bitgetPattern ||
                KEYS.cache?.longBitgetPattern,
              'BITGET:CACHE:*'
         )
    },
    discord: {
         logList: namespacedLongKey(
              KEYS.long?.discord?.logList ||
                KEYS.discord?.longLogList ||
                KEYS.discordLong?.logList ||
                KEYS.discord?.logList,
              'DISCORD:LOGS'
         )
    }
};
const LOCK_KEYS = {
    admin: namespacedLongKey('ADMIN:FACTORY_RESET:LOCK'),
    scanner: LONG_KEYS.scan.lock,
    trade: LONG_KEYS.trade.lock,
    freeze: LONG_KEYS.analyze.freezeLock,
    activate: LONG_KEYS.analyze.activateLock
};
function now() {
    return Date.now();
}
function methodNotAllowed(res) {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({
         ok: false,
         error: 'METHOD_NOT_ALLOWED',
         allowed: ['POST'],
         ...modePayload()
    });
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
virtualOnly: true,
virtualLearning: true,
virtualLearningForced: true,
virtualPositionsOnly: true,
virtualTracked: true,
shadowPositionsVisible: true,
shadowOutcomesIncluded: true,
realOrdersDisabled: true,
bitgetOrdersDisabled: true,
exchangeOrdersDisabled: true,
exchangeCallsDisabled: true,
realOutcomesExcluded: true,
noRealOrders: true,
noExchangeOrders: true,
maxOneOpenPositionPerSymbol: true,
globalMaxOpenPositionsBlockDisabled: true,
scannerSide: TARGET_SCANNER_SIDE,
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
broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
fixedTaxonomyPreferred: true,
learningGranularity: LEARNING_GRANULARITY,
parentMicroFamilyCount: 15,
selectableChildMicroFamilyCount: 75,
parentFamilyRule: 'MICRO_LONG_{SETUP}_{REGIME}',
selectableFamilyRule: 'MICRO_LONG_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',
manualSelectionRequired: true,
discordOnlyForSelectedMicroFamilies: true,
         discordOnlyForExactTrueMicroMatch: true,
         manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
         discordSelectionRule: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY',
         parentMatchDoesNotTriggerDiscord: true,
         macroMatchDoesNotTriggerDiscord: true,
         persistentLearningKey: PERSISTENT_LEARNING_KEY,
         weekResetDisabled: true,
         isoWeekLearningDisabled: true,
         completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
         scoringRSource: 'netR',
         winsLossesFlatsSource: 'netR',
         winrateDefinition: 'netR > 0',
         avgRSource: 'netR',
         totalRSource: 'netR',
         avgCostRShown: true,
         riskTradeSide: TARGET_TRADE_SIDE,
         riskGeometryRule: 'LONG: sl < entry < tp',
         tpHitRule: 'LONG: price >= tp',
         slHitRule: 'LONG: price <= sl',
         grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
         currentRFormula: '(currentPrice - entry) / (entry - initialSl)',
         currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
         currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
         autoRotationActivationDisabled: true,
         manualRotationPreservedByDefault: true,
         explicitRotationResetRequired: true,
         resetCronDisabled: true,
         activateFreezeCronDisabled: true,
         redisNamespace: LONG_NAMESPACE,
         redisKeyPrefix: LONG_KEY_PREFIX,
         redisKeysSeparatedFromShortRoot: true,
         shortRootTouched: false
    };
}
function parseJson(text) {
    if (!text) return {};
    try {
         return JSON.parse(text);
    } catch {
         const error = new Error('INVALID_JSON_BODY');
         error.statusCode = 400;
         throw error;
    }
}
async function readBody(req) {
    if (req.body) {
         if (typeof req.body === 'string') {
            return parseJson(req.body.trim());
        }
        if (Buffer.isBuffer(req.body)) {
            return parseJson(req.body.toString('utf8').trim());
        }
        return req.body;
    }
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    return parseJson(text);
}
function isTrue(value) {
    if (value === true || value === 1) return true;
    const raw = String(value || '').trim().toLowerCase();
    return ['true', '1', 'yes', 'y', 'on'].includes(raw);
}
function upper(value) {
    return String(value || '').trim().toUpperCase();
}
function cleanSideText(value = '') {
    return upper(value)
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
        .replaceAll('SHORT_ONLY_MODE', 'SHORT')
        .replaceAll('SHORT_ONLY', 'SHORT')
        .replaceAll('SHORT-ONLY', 'SHORT')
        .replaceAll('LONG_ONLY_MODE', 'LONG')
        .replaceAll('LONG_ONLY', 'LONG')
        .replaceAll('LONG-ONLY', 'LONG');
}
function normalizeSignalText(value = '') {
    return cleanSideText(value)
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
function normalizeSideToken(value) {
    const raw = cleanSideText(value);
    if (!raw) return 'UNKNOWN';
    const direct = sideToTradeSide(raw);
    if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
    if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
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
function validLearningId(id = '') {
    const value = String(id || '').trim();
    if (!value) return false;
    if (isScannerFingerprintId(value)) return false;
    if (isExecutionFingerprintId(value)) return false;
    return true;
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
    for (const candidateRegime of LONG_FIXED_REGIME_BUCKETS) {
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
         learningGranularity: LEARNING_GRANULARITY
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
function marketBiasHaystack(input = {}) {
    return [
        input.currentMarketBias,
        input.marketBias,
        input.bias,
        input.regime,
        input.regimeCoarse,
        input.btcState,
        input.btcRelation,
        input.scannerSide,
        input.actualScannerSide,
        input.analysisSide,
        input.side,
        input.tradeSide,
        input.positionSide,
        input.direction
    ]
        .map((value) => cleanSideText(value))
        .filter(Boolean)
        .join(' | ');
}
function getLongCurrentFit(input = {}) {
    const explicitLongFit = firstFiniteNumber([
      input.longCurrentFit,
      input.currentLongFit,
      input.bullCurrentFit,
      input.bullishCurrentFit,
      input.longFit,
      input.bullFit,
      input.bullishFit
    ]);
    if (explicitLongFit !== null) return explicitLongFit;
    const explicitShortFit = firstFiniteNumber([
      input.shortCurrentFit,
      input.currentShortFit,
      input.bearCurrentFit,
      input.bearishCurrentFit,
      input.shortFit,
      input.bearFit,
      input.bearishFit
    ]);
    if (explicitShortFit !== null) return -explicitShortFit;
    const rawFit = firstFiniteNumber([
      input.currentFit,
      input.marketCurrentFit,
      input.marketFit,
      input.fitScore
    ]);
    if (rawFit === null) return 0;
    const text = marketBiasHaystack(input);
    const bullish = hasLongSignal(text);
    const bearish = hasShortSignal(text);
    if (bullish && !bearish) return Math.abs(rawFit);
    if (bearish && !bullish) return -Math.abs(rawFit);
    return -rawFit;
}
function getLongRiskGeometry(input = {}) {
    const entry = firstFiniteNumber([
      input.entryPrice,
      input.entry,
      input.avgEntryPrice,
      input.averageEntryPrice,
      input.averageEntry,
      input.openPrice
    ]);
    const initialSl = firstFiniteNumber([
      input.initialSl,
      input.initialSL,
      input.initialStopLoss,
  input.initialStopLossPrice,
  input.stopLoss,
  input.stopLossPrice,
  input.sl,
  input.slPrice
]);
const tp = firstFiniteNumber([
  input.tp,
  input.takeProfit,
  input.takeProfitPrice,
  input.targetPrice,
  input.finalTp,
  input.finalTakeProfit
]);
const exitPrice = firstFiniteNumber([
  input.exitPrice,
  input.closePrice,
  input.closedPrice,
  input.outcomePrice,
  input.fillExitPrice,
  input.exit
]);
const currentPrice = firstFiniteNumber([
  input.currentPrice,
  input.markPrice,
  input.lastPrice,
  input.price
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
              input.longTpHit === true ||
              input.tpHit === true ||
              (Number.isFinite(exitPrice) && exitPrice >= tp) ||
              (Number.isFinite(currentPrice) && currentPrice >= tp)
         );
    const longSlHit =
         validGeometry &&
         (
              input.longSlHit === true ||
              input.slHit === true ||
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
function inferPositionTradeSide(position = {}) {
    const directSources = [
         position.tradeSide,
         position.positionSide,
         position.direction,
         position.side,
         position.signalSide,
         position.scannerSide,
         position.analysisSide
    ];
    for (const source of directSources) {
         const side = normalizeSideToken(source);
     if (side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE) return side;
 }
 const text = [
     position.tradeSide,
     position.positionSide,
     position.direction,
     position.side,
     position.signalSide,
     position.scannerSide,
     position.analysisSide,
     position.familyId,
     position.macroFamilyId,
     position.parentMacroFamilyId,
     position.parentTrueMicroFamilyId,
     position.parentMicroFamilyId,
     position.microFamilyId,
     position.trueMicroFamilyId,
     position.learningMicroFamilyId,
     position.analyzeMicroFamilyId,
     position.coarseMicroFamilyId,
     position.baseMicroFamilyId,
     position.legacyMicroFamilyId,
     position.tradeId,
     position.key,
     position.redisKey,
     position.positionKey
 ]
     .map((value) => cleanSideText(value))
     .filter(Boolean)
     .join(' | ');
 const shortSignal = hasShortSignal(text);
 const longSignal = hasLongSignal(text);
 if (longSignal && !shortSignal) return TARGET_TRADE_SIDE;
 if (shortSignal && !longSignal) return OPPOSITE_TRADE_SIDE;
 if (shortSignal && longSignal) {
     const microId = cleanSideText(
          position.trueMicroFamilyId ||
            position.microFamilyId ||
            position.parentTrueMicroFamilyId ||
            position.coarseMicroFamilyId ||
            ''
     );
     if (parseLongTaxonomyMicroId(microId).valid) return TARGET_TRADE_SIDE;
     if (microId.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
 }
 if (position.longOnly === true || position.shortDisabled === true) return
TARGET_TRADE_SIDE;
    if (position.shortOnly === true || position.longDisabled === true) return
OPPOSITE_TRADE_SIDE;
    return 'UNKNOWN';
}
function isLongNamespacedPosition(position = {}) {
    return [
         position.key,
         position.redisKey,
         position.positionKey
    ]
         .filter(Boolean)
         .some((key) => String(key).startsWith(LONG_KEY_PREFIX));
}
function isVirtualOrShadowPosition(position = {}) {
    const source = String(position.source || position.positionSource ||
'VIRTUAL').toUpperCase();
    if (
         position.realOrder === true ||
         position.realPosition === true ||
         position.exchangeOrder === true ||
         position.bitgetOrder === true ||
         source === 'REAL' ||
         source === 'LIVE' ||
         source === 'BITGET' ||
         source === 'EXCHANGE'
    ) {
         return false;
    }
    return source === 'VIRTUAL' || source === 'SHADOW' || source === 'PAPER' ||
source === '';
}
function isLongPosition(position = {}) {
    const side = inferPositionTradeSide(position);
    if (side === TARGET_TRADE_SIDE) return isVirtualOrShadowPosition(position);
    if (side === OPPOSITE_TRADE_SIDE) return false;
    return isLongNamespacedPosition(position) &&
isVirtualOrShadowPosition(position);
}
function isConfirmed(body = {}, requiredText) {
    return (
         body.confirm === requiredText ||
         body.confirmed === requiredText ||
         body.confirmation === requiredText
    );
}
function wantsRotationReset(body = {}) {
    return (
         isTrue(body.resetRotation) ||
         isTrue(body.resetManualSelection) ||
         isTrue(body.clearManualSelection) ||
         isTrue(body.wipeRotation)
    );
}
function isRotationResetConfirmed(body = {}, requiredText) {
    return (
         body.confirmRotation === requiredText ||
         body.rotationConfirm === requiredText ||
         body.rotationConfirmation === requiredText ||
         body.confirmResetRotation === requiredText
    );
}
async function delKey(redis, key) {
    if (!redis || !key) return 0;
    return redis.del(key).catch(() => 0);
}
async function delPatternSafe(redis, pattern, count = 10000) {
    if (!redis || !pattern) return 0;
    return delPattern(redis, pattern, count).catch(() => 0);
}
async function acquireLock(redis, key, token) {
    if (!redis || !key || !token) return false;
    const acquired = await redis.set(key, token, {
         nx: true,
         ex: LOCK_TTL_SEC
    });
    return Boolean(acquired);
}
async function releaseLock(redis, key, token) {
    try {
         if (!redis || !key || !token) return false;
         const current = await redis.get(key);
         if (current !== token) return false;
         await redis.del(key);
         return true;
    } catch {
         return false;
    }
}
async function acquireOneLock({
    redis,
    key,
    token,
    reason,
    acquired
}) {
    const ok = await acquireLock(redis, key, token);
    if (!ok) {
         return {
              ok: false,
              reason,
              acquired
         };
    }
    acquired.push({
         redis,
         key
    });
    return {
         ok: true,
         acquired
    };
}
async function acquireResetLocks({
    durable,
    volatile,
    token
}) {
    const acquired = [];
    const steps = [
         {
              redis: durable,
              key: LOCK_KEYS.admin,
              reason: 'LONG_FACTORY_RESET_ALREADY_RUNNING'
         },
         {
              redis: volatile,
              key: LOCK_KEYS.scanner,
              reason: 'LONG_SCANNER_RUN_ACTIVE'
         },
         {
              redis: durable,
              key: LOCK_KEYS.trade,
              reason: 'LONG_TRADE_RUN_ACTIVE'
         },
         {
              redis: durable,
              key: LOCK_KEYS.freeze,
              reason: 'LONG_WEEKLY_FREEZE_ACTIVE'
         },
         {
              redis: durable,
             key: LOCK_KEYS.activate,
             reason: 'LONG_ROTATION_ACTIVATE_ACTIVE'
         }
    ];
    for (const step of steps) {
         const result = await acquireOneLock({
             redis: step.redis,
             key: step.key,
             token,
             reason: step.reason,
             acquired
         });
         if (!result.ok) return result;
    }
    return {
         ok: true,
         acquired
    };
}
async function releaseResetLocks(acquired = [], token) {
    const released = [];
    for (const lock of [...acquired].reverse()) {
         const ok = await releaseLock(lock.redis, lock.key, token);
         released.push({
             key: lock.key,
             released: ok
         });
    }
    return released;
}
async function getLongOpenPositions() {
    const rawPositions = await getOpenPositions({
         tradeSide: TARGET_TRADE_SIDE,
         side: TARGET_DASHBOARD_SIDE,
         namespace: LONG_NAMESPACE,
         keyPrefix: LONG_KEY_PREFIX,
         virtualOnly: true
    });
    return (Array.isArray(rawPositions) ? rawPositions : [])
         .filter(isLongPosition);
}
function openPositionSymbols(openPositions = []) {
    return openPositions
         .map((position) => (
             position.symbol ||
             position.baseSymbol ||
             position.contractSymbol ||
           null
      ))
      .filter(Boolean);
}
function normalizeOpenPosition(position = {}) {
    const source = String(position.source || position.positionSource ||
'VIRTUAL').toUpperCase();
    const rawTrueMicroFamilyId =
      position.trueMicroFamilyId ||
      position.learningMicroFamilyId ||
      position.analyzeMicroFamilyId ||
      position.microFamilyId ||
      null;
    const parsedTrue = parseLongTaxonomyMicroId(rawTrueMicroFamilyId);
    const rawParentTrueMicroFamilyId =
      parsedTrue.parentTrueMicroFamilyId ||
      position.parentTrueMicroFamilyId ||
      position.coarseMicroFamilyId ||
      position.baseMicroFamilyId ||
      position.legacyMicroFamilyId ||
      position.parentMacroFamilyId ||
      position.macroFamilyId ||
      position.parentMicroFamilyId ||
      null;
    const parsedParent = parseLongTaxonomyMicroId(rawParentTrueMicroFamilyId);
    const trueMicroFamilyId =
      parsedTrue.trueMicroFamilyId ||
      rawTrueMicroFamilyId ||
      null;
    const parentTrueMicroFamilyId =
      parsedTrue.parentTrueMicroFamilyId ||
      parsedParent.parentTrueMicroFamilyId ||
      rawParentTrueMicroFamilyId ||
      null;
    const riskGeometry = getLongRiskGeometry(position);
    const longCurrentFit = getLongCurrentFit(position);
    return {
      ...temporalRowPayload(position),
      tradeId: position.tradeId || null,
      symbol: position.symbol || position.baseSymbol || null,
      baseSymbol: position.baseSymbol || position.symbol || null,
      contractSymbol: position.contractSymbol || null,
      microFamilyId: trueMicroFamilyId,
      trueMicroFamilyId,
      parentTrueMicroFamilyId,
      coarseMicroFamilyId: parentTrueMicroFamilyId || trueMicroFamilyId || null,
      familyId: position.familyId || null,
   macroFamilyId: parentTrueMicroFamilyId || position.parentMacroFamilyId ||
position.macroFamilyId || position.parentMicroFamilyId || null,
   taxonomySetup: parsedTrue.setup || parsedParent.setup || null,
   taxonomyRegime: parsedTrue.regime || parsedParent.regime || null,
   confirmationProfile: parsedTrue.confirmationProfile || null,
   selectableTrueMicroFamily: Boolean(trueMicroFamilyId &&
isFixedLongChildMicroId(trueMicroFamilyId)),
   parentTrueMicroFamily: Boolean(parentTrueMicroFamilyId &&
isFixedLongParentMicroId(parentTrueMicroFamilyId)),
   trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
   learningGranularity: LEARNING_GRANULARITY,
   side: TARGET_DASHBOARD_SIDE,
   tradeSide: TARGET_TRADE_SIDE,
   positionSide: TARGET_TRADE_SIDE,
   direction: TARGET_TRADE_SIDE,
   longOnly: true,
   shortDisabled: true,
   shortOnly: false,
   longDisabled: false,
   source: source === 'VIRTUAL' || source === 'SHADOW' || source === 'PAPER'
        ? source === 'SHADOW' ? 'SHADOW' : 'VIRTUAL'
        : source,
   outcomeSource: source === 'SHADOW' ? 'SHADOW' : 'VIRTUAL',
   virtualOnly: source !== 'SHADOW',
   virtualTracked: true,
   shadowOnly: source === 'SHADOW' || position.shadowOnly !== false,
   exchangeTouched: false,
   bitgetOrdersTouched: false,
   realOrdersTouched: false,
   entry: riskGeometry.entry ?? position.entry ?? position.entryPrice ?? null,
   entryPrice: riskGeometry.entry ?? position.entryPrice ?? position.entry ??
null,
   sl: riskGeometry.initialSl ?? position.sl ?? position.stopLoss ??
position.initialSl ?? null,
   tp: riskGeometry.tp ?? position.tp ?? position.takeProfit ?? null,
   initialSl: riskGeometry.initialSl ?? position.initialSl ?? position.sl ??
position.stopLoss ?? null,
   validLongRiskShape: Boolean(riskGeometry.validGeometry),
   validLongGeometry: Boolean(riskGeometry.validGeometry),
   riskGeometryRule: riskGeometry.riskGeometryRule,
   tpHitRule: riskGeometry.tpHitRule,
   slHitRule: riskGeometry.slHitRule,
   grossRFormula: riskGeometry.grossRFormula,
   currentRFormula: riskGeometry.currentRFormula,
   longTpHit: riskGeometry.longTpHit,
   longSlHit: riskGeometry.longSlHit,
   tpHit: riskGeometry.longTpHit,
         slHit: riskGeometry.longSlHit,
         longGrossR: riskGeometry.longGrossR ?? position.longGrossR ?? null,
         longCurrentR: riskGeometry.longCurrentR ?? position.longCurrentR ??
position.currentR ?? null,
         currentPrice: riskGeometry.currentPrice ?? position.currentPrice ??
position.lastPrice ?? null,
         lastPrice: position.lastPrice ?? position.currentPrice ?? null,
         ageSec: position.ageSec ?? null,
         currentR: riskGeometry.longCurrentR ?? position.longCurrentR ??
position.currentR ?? null,
         mfeR: position.longMfeR ?? position.mfeR ?? null,
         maeR: position.longMaeR ?? position.maeR ?? null,
         currentFit: longCurrentFit,
         longCurrentFit,
         bullCurrentFit: longCurrentFit,
         bearishCurrentFit: -longCurrentFit,
         currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
         currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
         reachedHalfR: Boolean(position.reachedHalfR),
         reachedOneR: Boolean(position.reachedOneR),
         nearTpSeen: Boolean(position.nearTpSeen),
         openedAt: position.openedAt || position.createdAt || null,
         updatedAt: position.updatedAt || null
    };
}
async function runDeleteSteps({
    durable,
    volatile,
    resetRotation = false
}) {
    const deleted = {};
    const preserved = {};
    deleted.scanSnapshots = await delPatternSafe(
         volatile,
         LONG_KEYS.scan.snapshotPattern,
         10000
    );
    deleted.scanLatest = await delKey(
         volatile,
         LONG_KEYS.scan.latest
    );
    deleted.scanRunMeta = await delKey(
         volatile,
         LONG_KEYS.scan.runMeta
    );
    deleted.tradeOpenVirtualPositions = await delPatternSafe(
         durable,
     LONG_KEYS.trade.openPattern,
     10000
);
deleted.tradeLastProcessed = await delKey(
     durable,
     LONG_KEYS.trade.lastProcessedSnapshot
);
deleted.tradeMeta = await delKey(
     durable,
     LONG_KEYS.trade.runMeta
);
deleted.tradeLocks = 0;
deleted.circuitPaused = await delPatternSafe(
     durable,
     LONG_KEYS.circuit.pausedPattern,
     10000
);
deleted.analyzeWeeks = await delPatternSafe(
     durable,
     LONG_KEYS.analyze.weekPattern,
     10000
);
deleted.analyzeMicros = await delPatternSafe(
     durable,
     LONG_KEYS.analyze.microPattern,
     10000
);
deleted.analyzeObsLast = await delPatternSafe(
     durable,
     LONG_KEYS.analyze.obsLastPattern,
     10000
);
deleted.analyzeShadow = await delPatternSafe(
     durable,
     LONG_KEYS.analyze.shadowPattern,
     10000
);
deleted.analyzeOutcomeDedupe = await delPatternSafe(
     durable,
     LONG_KEYS.analyze.outcomePattern,
     10000
);
deleted.analyzeTemporalContext = await delPatternSafe(
     durable,
     LONG_KEYS.analyze.temporalPattern,
     10000
);
deleted.analyzeContextStats = await delPatternSafe(
     durable,
     LONG_KEYS.analyze.contextStatsPattern,
     10000
);
deleted.analyzeSessionStats = await delPatternSafe(
     durable,
     LONG_KEYS.analyze.sessionStatsPattern,
     10000
);
deleted.analyzeDayOfWeekStats = await delPatternSafe(
     durable,
     LONG_KEYS.analyze.dayOfWeekStatsPattern,
     10000
);
deleted.temporalGenerations = await delPatternSafe(
     durable,
     LONG_KEYS.analyze.temporalGenerationPattern,
     10000
);
deleted.activeTemporalGeneration = await delKey(
     durable,
     LONG_KEYS.analyze.activeTemporalGeneration
);
deleted.nextTemporalGeneration = await delKey(
     durable,
     LONG_KEYS.analyze.nextTemporalGeneration
);
deleted.temporalSequences = await delPatternSafe(
     durable,
     LONG_KEYS.analyze.temporalSequencePattern,
     10000
);
deleted.temporalDecisionSnapshots = await delPatternSafe(
     durable,
     LONG_KEYS.analyze.temporalDecisionPattern,
     10000
);
deleted.temporalBackfillState = await delPatternSafe(
     durable,
     LONG_KEYS.analyze.temporalBackfillPattern,
     10000
);
deleted.temporalAuditState = await delPatternSafe(
     durable,
     LONG_KEYS.analyze.temporalAuditPattern,
     10000
);
preserved.unregisteredTemporalKeys = Object.entries({
     temporalPattern: LONG_KEYS.analyze.temporalPattern,
     contextStatsPattern: LONG_KEYS.analyze.contextStatsPattern,
     dayOfWeekStatsPattern: LONG_KEYS.analyze.dayOfWeekStatsPattern,
     sessionStatsPattern: LONG_KEYS.analyze.sessionStatsPattern,
     temporalGenerationPattern: LONG_KEYS.analyze.temporalGenerationPattern,
     activeTemporalGeneration: LONG_KEYS.analyze.activeTemporalGeneration,
     nextTemporalGeneration: LONG_KEYS.analyze.nextTemporalGeneration,
     temporalSequencePattern: LONG_KEYS.analyze.temporalSequencePattern,
     temporalDecisionPattern: LONG_KEYS.analyze.temporalDecisionPattern,
     temporalBackfillPattern: LONG_KEYS.analyze.temporalBackfillPattern,
     temporalAuditPattern: LONG_KEYS.analyze.temporalAuditPattern
}).filter(([, value]) => !value).map(([key]) => key);
if (resetRotation) {
     deleted.activeRotation = await delKey(
          durable,
          LONG_KEYS.analyze.activeRotation
     );
} else {
     deleted.activeRotation = 0;
     preserved.activeRotation = true;
     preserved.manualDiscordSelection = true;
}
deleted.nextRotation = await delKey(
     durable,
     LONG_KEYS.analyze.nextRotation
);
deleted.rotationValidFrom = await delKey(
     durable,
     LONG_KEYS.analyze.rotationValidFrom
);
deleted.liveCache = await delPatternSafe(
     volatile,
     LONG_KEYS.cache.livePattern,
     10000
);
deleted.marketCache = await delPatternSafe(
     volatile,
     LONG_KEYS.cache.marketPattern,
     10000
);
deleted.bitgetCache = await delPatternSafe(
     volatile,
     LONG_KEYS.cache.bitgetPattern,
     10000
);
return {
     deleted,
     preserved
};
}
function buildBlockedResponse({
    reason,
    extra = {}
} = {}) {
    return {
         ok: false,
         blocked: true,
         reason,
         ...modePayload(),
         ...extra
    };
}
export default async function handler(req, res) {
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
    res.setHeader('X-Admin-Factory-Reset-Mode', 'long-only-75-child-virtual-learning-temporal-v2');
    res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
    res.setHeader('X-Long-Only', 'true');
    res.setHeader('X-Short-Disabled', 'true');
    res.setHeader('X-Real-Orders-Disabled', 'true');
    res.setHeader('X-Bitget-Orders-Disabled', 'true');
    res.setHeader('X-Exchange-Calls-Disabled', 'true');
    res.setHeader('X-Virtual-Learning-Forced', 'true');
    res.setHeader('X-Virtual-Positions-Only', 'true');
    res.setHeader('X-Manual-Rotation-Preserved-By-Default', 'true');
    res.setHeader('X-Manual-Selection-Match-Mode', 'EXACT_TRUE_MICRO_FAMILY_ID');
    res.setHeader('X-Discord-Selection-Rule',
'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY');
    res.setHeader('X-True-Micro-Family-Schema', TRUE_MICRO_SCHEMA);
    res.setHeader('X-Learning-Granularity', LEARNING_GRANULARITY);
    res.setHeader('X-Persistent-Learning-Key', PERSISTENT_LEARNING_KEY);
    res.setHeader('X-Redis-Namespace', LONG_NAMESPACE);
    res.setHeader('X-Short-Root-Touched', 'false');
    const token = randomUUID();
    let acquiredLocks = [];
    try {
         if (req.method !== 'POST') {
             return methodNotAllowed(res);
         }
         const body = await readBody(req);
         const requiredConfirmText =
       CONFIG.long?.reset?.confirmText ||
       CONFIG.reset?.longConfirmText ||
       DEFAULT_CONFIRM_TEXT;
   const requiredRotationConfirmText =
       CONFIG.long?.reset?.rotationConfirmText ||
       CONFIG.reset?.longRotationConfirmText ||
       DEFAULT_ROTATION_CONFIRM_TEXT;
   const confirmed = isConfirmed(body, requiredConfirmText);
   const resetRotation = wantsRotationReset(body);
   const forceDeleteVirtualPositions =
       isTrue(body.force) ||
       isTrue(body.forceDeleteVirtualPositions) ||
       isTrue(body.forceClosePositions);
   if (!confirmed) {
       return res.status(400).json(
            buildBlockedResponse({
                 reason: 'LONG_CONFIRMATION_REQUIRED',
                 extra: {
                     required: requiredConfirmText
                 }
            })
       );
   }
   if (resetRotation && !isRotationResetConfirmed(body,
requiredRotationConfirmText)) {
       return res.status(400).json(
            buildBlockedResponse({
                 reason: 'LONG_ROTATION_RESET_CONFIRMATION_REQUIRED',
                 extra: {
                     required: requiredRotationConfirmText,
                     note: 'activeRotation bevat je handmatige LONG 75-child trueMicroFamilyId Discord-selectie en wordt standaard bewaard.'
                 }
            })
       );
   }
   const durable = getDurableRedis();
   const volatile = getVolatileRedis();
   const lockResult = await acquireResetLocks({
       durable,
       volatile,
       token
   });
   acquiredLocks = lockResult.acquired || [];
   if (!lockResult.ok) {
       const released = await releaseResetLocks(acquiredLocks, token);
       acquiredLocks = [];
    return res.status(409).json(
         buildBlockedResponse({
              reason: lockResult.reason,
              extra: {
                  released
              }
         })
    );
}
const openPositions = await getLongOpenPositions();
if (openPositions.length > 0 && !forceDeleteVirtualPositions) {
    return res.status(409).json(
         buildBlockedResponse({
              reason: 'LONG_OPEN_VIRTUAL_POSITIONS_EXIST',
              extra: {
                  count: openPositions.length,
                  symbols: openPositionSymbols(openPositions),
                  openPositions: openPositions.map(normalizeOpenPosition),
                  requiredForceFlag: 'forceDeleteVirtualPositions=true',
                  deprecatedAcceptedForceFlag: 'forceClosePositions=true',
                  exchangeTouched: false,
                  bitgetOrdersTouched: false,
                  realOrdersTouched: false
              }
         })
    );
}
const deleteResult = await runDeleteSteps({
    durable,
    volatile,
    resetRotation
});
const report = {
    ok: true,
    type: 'LONG_FACTORY_RESET',
    ...modePayload(),
    force: forceDeleteVirtualPositions,
    forceDeleteVirtualPositions,
    resetRotation,
    manualRotationPreserved: !resetRotation,
    manualDiscordSelectionPreserved: !resetRotation,
    pendingRotationStateCleared: true,
    exchangeTouched: false,
    bitgetOrdersTouched: false,
    realOrdersTouched: false,
    openPositionsCount: openPositions.length,
    openPositionSymbols: openPositionSymbols(openPositions),
       openPositions: openPositions.map(normalizeOpenPosition),
       deleted: deleteResult.deleted,
       preserved: {
            ...deleteResult.preserved,
            shortRoot: true,
            shortRedisKeys: true,
            resetLogs: true,
            discordLogs: true,
            discordLogKey: LONG_KEYS.discord.logList,
            environmentVariables: true,
            deploymentConfig: true,
            activeRotation: !resetRotation,
            manualDiscordSelection: !resetRotation
       },
       longKeys: {
            namespace: LONG_NAMESPACE,
            prefix: LONG_KEY_PREFIX,
            persistentLearningKey: PERSISTENT_LEARNING_KEY,
            scan: LONG_KEYS.scan,
            trade: LONG_KEYS.trade,
            analyze: LONG_KEYS.analyze,
            reset: LONG_KEYS.reset,
            discord: LONG_KEYS.discord
       },
       ...temporalPolicyPayload(now()),
       resetAt: now()
  };
  await pushJsonLog(
       durable,
       LONG_KEYS.reset.logList,
       report,
       100
  ).catch(() => null);
  await sendResetReport(report).catch(() => null);
  return res.status(200).json(report);
} catch (error) {
  const status = error.statusCode || 500;
  return res.status(status).json({
       ok: false,
       ...modePayload(),
       error: error?.message || String(error),
       stack: process.env.NODE_ENV === 'production'
            ? undefined
            : error?.stack
  });
} finally {
  if (acquiredLocks.length > 0) {
            await releaseResetLocks(acquiredLocks, token);
        }
    }
}
