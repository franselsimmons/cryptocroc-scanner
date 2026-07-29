// ================= FILE: api/admin/discord-logs.js =================
import { KEYS } from '../../src/keys.js';
import { getDurableRedis, readJsonLogs } from '../../src/redis.js';
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
const TRUE_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'n', 'off']);
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
function methodNotAllowed(res) {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({
      ok: false,
      error: 'METHOD_NOT_ALLOWED',
      allowed: ['GET'],
      ...baseModePayload()
    });
}
function firstQueryValue(value, fallback = null) {
    if (Array.isArray(value)) return value[0] ?? fallback;
    if (value === undefined || value === null || value === '') return fallback;
    return value;
}
function firstDefined(...values) {
    return values.find((value) => value !== undefined && value !== null);
}
function bool(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    const raw = String(value).trim().toLowerCase();
    if (TRUE_VALUES.has(raw)) return true;
    if (FALSE_VALUES.has(raw)) return false;
    return fallback;
}
function maybeBool(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'boolean') return value;
    const raw = String(value).trim().toLowerCase();
    if (TRUE_VALUES.has(raw)) return true;
    if (FALSE_VALUES.has(raw)) return false;
    return null;
}
function upper(value) {
    return String(value || '').trim().toUpperCase();
}
function cleanText(value = '') {
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
    return cleanText(value)
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
function clampLimit(value, fallback = 100) {
    const limit = Number(value);
    if (!Number.isFinite(limit)) return fallback;
    if (limit < 1) return 1;
    if (limit > 500) return 500;
    return Math.floor(limit);
}
function safeArray(value) {
    return Array.isArray(value) ? value : [];
}
function safeObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
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
    let raw = String(callMaybeKey(key, fallback) || '').trim();
    if (!raw) return null;
    if (raw.startsWith(LONG_KEY_PREFIX)) return raw;
    if (raw.startsWith('SHORT:')) raw = raw.slice('SHORT:'.length);
    return `${LONG_KEY_PREFIX}${raw}`;
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
function normalizeSideToken(value) {
    const raw = cleanText(value);
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
function idLooksLong(id = '') {
    const value = String(id || '').trim();
    if (!validLearningId(value)) return false;
    if (parseLongTaxonomyMicroId(value).valid) return true;
    return hasLongSignal(value);
}
function idLooksShort(id = '') {
    const value = String(id || '').trim();
    if (!validLearningId(value)) return false;
    return hasShortSignal(value);
}
function isSelectableTrueMicroId(id = '') {
    const value = String(id || '').trim();
    if (!validLearningId(value)) return false;
    if (idLooksShort(value) && !idLooksLong(value)) return false;
    return isFixedLongChildMicroId(value);
}
function payloadResult(row = {}) {
    const payload = safeObject(row.payload);
    const result = safeObject(row.result || payload.result);
    return {
         payload,
         result
    };
}
function firstIdentityValue(row = {}, keys = []) {
    const { payload, result } = payloadResult(row);
    for (const key of keys) {
         const value = firstDefined(
              row[key],
              payload[key],
              result[key]
         );
         if (value !== undefined && value !== null && value !== '') {
              return value;
         }
    }
    return null;
}
function firstMetricValue(row = {}, keys = []) {
    const { payload, result } = payloadResult(row);
    for (const key of keys) {
        const value = firstDefined(
             row[key],
             payload[key],
             result[key]
        );
        if (value !== undefined && value !== null && value !== '') {
             return value;
        }
    }
    return null;
}
function firstFiniteMetric(row = {}, keys = []) {
    const { payload, result } = payloadResult(row);
    for (const key of keys) {
        const n = firstFiniteNumber([
             row[key],
             payload[key],
             result[key]
        ]);
        if (n !== null) return n;
    }
    return null;
}
function firstBooleanMetric(row = {}, keys = []) {
    const { payload, result } = payloadResult(row);
    for (const key of keys) {
        const value = maybeBool(firstDefined(
             row[key],
             payload[key],
             result[key]
        ));
        if (value !== null) return value;
    }
    return null;
}
function selectedIdentityValue(row = {}) {
    return firstIdentityValue(row, [
        'selectedTrueMicroFamilyId',
        'selectedMicroFamilyId',
        'manualSelectedTrueMicroFamilyId',
        'manualSelectedMicroFamilyId',
        'activeTrueMicroFamilyId',
        'activeMicroFamilyId'
    ]);
}
function trueMicroFamilyValue(row = {}) {
    return firstIdentityValue(row, [
      'trueMicroFamilyId',
      'learningMicroFamilyId',
      'analyzeMicroFamilyId',
      'microFamilyId',
      'id',
      'key'
    ]);
}
function parentMicroFamilyValue(row = {}) {
    return firstIdentityValue(row, [
      'parentTrueMicroFamilyId',
      'coarseMicroFamilyId',
      'baseMicroFamilyId',
      'legacyMicroFamilyId',
      'macroFamilyId',
      'parentMacroFamilyId',
      'parentMicroFamilyId',
      'familyId'
    ]);
}
function sideHaystack(row = {}) {
    const { payload, result } = payloadResult(row);
    return [
      row.rawInferredTradeSide,
      row.inferredTradeSide,
      row.side,
      row.tradeSide,
      row.positionSide,
      row.direction,
      row.signalSide,
      row.scannerSide,
      row.actualScannerSide,
      row.analysisSide,
      payload.side,
      payload.tradeSide,
      payload.positionSide,
      payload.direction,
      payload.signalSide,
      payload.scannerSide,
      payload.actualScannerSide,
      payload.analysisSide,
      result.side,
      result.tradeSide,
      result.positionSide,
      result.direction,
      row.familyId,
    row.macroFamilyId,
    row.parentMacroFamilyId,
    row.parentTrueMicroFamilyId,
    row.microFamilyId,
    row.trueMicroFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.coarseMicroFamilyId,
    payload.familyId,
    payload.macroFamilyId,
    payload.parentMacroFamilyId,
    payload.parentTrueMicroFamilyId,
    payload.microFamilyId,
    payload.trueMicroFamilyId,
    payload.learningMicroFamilyId,
    payload.analyzeMicroFamilyId,
    payload.coarseMicroFamilyId,
    result.familyId,
    result.macroFamilyId,
    result.parentMacroFamilyId,
    result.parentTrueMicroFamilyId,
    result.microFamilyId,
    result.trueMicroFamilyId,
    result.learningMicroFamilyId,
    result.analyzeMicroFamilyId,
    result.coarseMicroFamilyId,
    row.type,
    row.reason,
    row.message,
    payload.type,
    payload.reason,
    payload.message,
    result.type,
    result.reason,
    result.message,
    ...safeArray(row.definitionParts),
    ...safeArray(payload.definitionParts),
    ...safeArray(result.definitionParts),
    ...safeArray(row.microDefinitionParts),
    ...safeArray(payload.microDefinitionParts),
    ...safeArray(result.microDefinitionParts),
    ...safeArray(row.executionFingerprintParts),
    ...safeArray(payload.executionFingerprintParts),
    ...safeArray(result.executionFingerprintParts)
]
    .map((value) => cleanText(value))
    .filter(Boolean)
        .join(' | ');
}
function marketBiasHaystack(row = {}) {
    const { payload, result } = payloadResult(row);
    return [
        row.currentMarketBias,
        row.marketBias,
        row.bias,
        row.regime,
        row.regimeCoarse,
        row.btcState,
        row.btcRelation,
        row.scannerSide,
        row.actualScannerSide,
        row.analysisSide,
        payload.currentMarketBias,
        payload.marketBias,
        payload.bias,
        payload.regime,
        payload.regimeCoarse,
        payload.btcState,
        payload.btcRelation,
        payload.scannerSide,
        payload.actualScannerSide,
        payload.analysisSide,
        result.currentMarketBias,
        result.marketBias,
        result.bias,
        result.regime,
        result.regimeCoarse,
        result.btcState,
        result.btcRelation,
        result.scannerSide,
        result.actualScannerSide,
        result.analysisSide
    ]
        .map((value) => cleanText(value))
        .filter(Boolean)
        .join(' | ');
}
function getLongCurrentFit(row = {}) {
    const explicitLongFit = firstFiniteMetric(row, [
        'longCurrentFit',
        'currentLongFit',
        'bullCurrentFit',
        'bullishCurrentFit',
        'longFit',
      'bullFit',
      'bullishFit'
    ]);
    if (explicitLongFit !== null) return explicitLongFit;
    const explicitShortFit = firstFiniteMetric(row, [
      'shortCurrentFit',
      'currentShortFit',
      'bearCurrentFit',
      'bearishCurrentFit',
      'shortFit',
      'bearFit',
      'bearishFit'
    ]);
    if (explicitShortFit !== null) return -explicitShortFit;
    const rawFit = firstFiniteMetric(row, [
      'currentFit',
      'marketCurrentFit',
      'marketFit',
      'fitScore'
    ]);
    if (rawFit === null) return 0;
    const text = marketBiasHaystack(row);
    const bullish = hasLongSignal(text);
    const bearish = hasShortSignal(text);
    if (bullish && !bearish) return Math.abs(rawFit);
    if (bearish && !bullish) return -Math.abs(rawFit);
    return -rawFit;
}
function getLongRiskGeometry(row = {}) {
    const entry = firstFiniteMetric(row, [
      'entryPrice',
      'entry',
      'avgEntryPrice',
      'averageEntryPrice',
      'averageEntry',
      'openPrice'
    ]);
    const initialSl = firstFiniteMetric(row, [
      'initialSl',
      'initialSL',
      'initialStopLoss',
      'initialStopLossPrice',
      'stopLoss',
      'stopLossPrice',
      'sl',
      'slPrice'
    ]);
const tp = firstFiniteMetric(row, [
  'tp',
  'takeProfit',
  'takeProfitPrice',
  'targetPrice',
  'finalTp',
  'finalTakeProfit'
]);
const exitPrice = firstFiniteMetric(row, [
  'exitPrice',
  'closePrice',
  'closedPrice',
  'outcomePrice',
  'fillExitPrice',
  'exit'
]);
const currentPrice = firstFiniteMetric(row, [
  'currentPrice',
  'markPrice',
  'lastPrice',
  'price'
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
const explicitLongTpHit = firstBooleanMetric(row, [
  'longTpHit',
  'longTakeProfitHit'
]);
const explicitLongSlHit = firstBooleanMetric(row, [
  'longSlHit',
         'longStopLossHit'
    ]);
    const longTpHit =
         validGeometry &&
         (
              explicitLongTpHit === true ||
              (Number.isFinite(exitPrice) && exitPrice >= tp) ||
              (Number.isFinite(currentPrice) && currentPrice >= tp)
         );
    const longSlHit =
         validGeometry &&
         (
              explicitLongSlHit === true ||
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
function inferTradeSide(row = {}) {
    const rawInferredTradeSide = normalizeSideToken(row.rawInferredTradeSide);
    const inferredTradeSide = normalizeSideToken(row.inferredTradeSide);
    if (rawInferredTradeSide === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
    if (rawInferredTradeSide === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
    if (inferredTradeSide === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
    if (inferredTradeSide === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
    const { payload, result } = payloadResult(row);
    const directSources = [
         row.tradeSide,
         row.positionSide,
         row.direction,
      row.side,
      payload.tradeSide,
      payload.positionSide,
      payload.direction,
      payload.side,
      result.tradeSide,
      result.positionSide,
      result.direction,
      result.side
 ];
 for (const source of directSources) {
      const side = normalizeSideToken(source);
      if (side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE) return side;
 }
 const trueMicroFamilyId = cleanText(trueMicroFamilyValue(row));
 const parentTrueMicroFamilyId = cleanText(parentMicroFamilyValue(row));
 if (parseLongTaxonomyMicroId(trueMicroFamilyId).valid) return
TARGET_TRADE_SIDE;
 if (parseLongTaxonomyMicroId(parentTrueMicroFamilyId).valid) return
TARGET_TRADE_SIDE;
 if (trueMicroFamilyId.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
 if (parentTrueMicroFamilyId.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
 const text = sideHaystack(row);
 const shortSignal = hasShortSignal(text);
 const longSignal = hasLongSignal(text);
 if (longSignal && !shortSignal) return TARGET_TRADE_SIDE;
 if (shortSignal && !longSignal) return OPPOSITE_TRADE_SIDE;
 if (shortSignal && longSignal) {
      if (trueMicroFamilyId.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
      if (trueMicroFamilyId.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
 }
 if (row.longOnly === true || payload.longOnly === true || result.longOnly ===
true) {
      return TARGET_TRADE_SIDE;
 }
 if (row.shortDisabled === true || payload.shortDisabled === true ||
result.shortDisabled === true) {
      return TARGET_TRADE_SIDE;
 }
 if (row.shortOnly === true || payload.shortOnly === true || result.shortOnly ===
true) {
      return OPPOSITE_TRADE_SIDE;
 }
 if (row.longDisabled === true || payload.longDisabled === true ||
result.longDisabled === true) {
      return OPPOSITE_TRADE_SIDE;
 }
    return 'UNKNOWN';
}
function logHasInvalidLearningId(row = {}) {
    const trueMicroFamilyId = trueMicroFamilyValue(row);
    const parentTrueMicroFamilyId = parentMicroFamilyValue(row);
    return (
         isScannerFingerprintId(trueMicroFamilyId) ||
         isScannerFingerprintId(parentTrueMicroFamilyId) ||
         isExecutionFingerprintId(trueMicroFamilyId) ||
         isExecutionFingerprintId(parentTrueMicroFamilyId)
    );
}
function isLongLog(row = {}) {
    if (!row || typeof row !== 'object') return false;
    if (logHasInvalidLearningId(row)) return false;
    return inferTradeSide(row) === TARGET_TRADE_SIDE;
}
function isShortLog(row = {}) {
    if (!row || typeof row !== 'object') return false;
    return inferTradeSide(row) === OPPOSITE_TRADE_SIDE;
}
function normalizeType(row = {}) {
    const { payload, result } = payloadResult(row);
    return upper(
         row.type ||
         payload.type ||
         result.type ||
         row.level ||
         payload.level ||
         result.level ||
         'UNKNOWN'
    );
}
function normalizeReason(row = {}) {
    const { payload, result } = payloadResult(row);
    return (
         row.reason ||
         payload.reason ||
         result.reason ||
         row.error ||
         payload.error ||
         result.error ||
         null
    );
}
function normalizeResult(row = {}) {
    const { payload, result } = payloadResult(row);
    if (Object.keys(result).length > 0) {
         return result;
    }
    return null;
}
function normalizeSource(row = {}) {
    const { payload, result } = payloadResult(row);
    const raw = upper(
         row.source ||
         row.positionSource ||
         row.tradeSource ||
         row.outcomeSource ||
         payload.source ||
         payload.positionSource ||
         payload.tradeSource ||
         payload.outcomeSource ||
         result.source ||
         result.positionSource ||
         result.tradeSource ||
         result.outcomeSource ||
         ''
    );
    if (!raw) return null;
    if (raw === 'VIRTUAL' || raw === 'SHADOW') return raw;
    if (raw === 'PAPER') return 'VIRTUAL';
    if (
         raw === 'REAL' ||
         raw === 'LIVE' ||
         raw === 'BITGET' ||
         raw === 'EXCHANGE' ||
         raw.startsWith('REAL_') ||
         raw.startsWith('LIVE_') ||
         raw.startsWith('BITGET_') ||
         raw.startsWith('EXCHANGE_')
    ) {
         return 'REAL';
    }
    return raw;
}
function isRealLog(row = {}) {
    const { payload, result } = payloadResult(row);
    return (
         row.source === 'REAL' ||
         normalizeSource(row) === 'REAL' ||
         row.realOrder === true ||
         payload.realOrder === true ||
         result.realOrder === true ||
         row.realPosition === true ||
         payload.realPosition === true ||
         result.realPosition === true ||
         row.exchangeOrder === true ||
         payload.exchangeOrder === true ||
         result.exchangeOrder === true ||
         row.bitgetOrder === true ||
         payload.bitgetOrder === true ||
         result.bitgetOrder === true
    );
}
function firstObject(...values) {
    for (const value of values) {
        if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    }
    return {};
}

function normalizeEntryDecisionSnapshot(row = {}) {
    const { payload, result } = payloadResult(row);
    const source = firstObject(
        row.entryDecisionSnapshot,
        row.decisionSnapshot,
        payload.entryDecisionSnapshot,
        payload.decisionSnapshot,
        result.entryDecisionSnapshot,
        result.decisionSnapshot
    );
    const temporalBlockReasons = safeArray(
        source.temporalBlockReasons ||
        row.temporalBlockReasons ||
        payload.temporalBlockReasons ||
        result.temporalBlockReasons
    ).map((value) => cleanText(value)).filter(Boolean);
    const nonTemporalBlockReasons = safeArray(
        source.nonTemporalBlockReasons ||
        source.globalBlockReasons ||
        row.nonTemporalBlockReasons ||
        payload.nonTemporalBlockReasons ||
        result.nonTemporalBlockReasons
    ).map((value) => cleanText(value)).filter(Boolean);
    const wouldPublishWithoutTemporal = Boolean(firstDefined(
        source.wouldPublishWithoutTemporal,
        row.wouldPublishWithoutTemporal,
        payload.wouldPublishWithoutTemporal,
        result.wouldPublishWithoutTemporal,
        false
    ));
    const temporalWouldBlock = Boolean(firstDefined(
        source.temporalWouldBlock,
        row.temporalWouldBlock,
        payload.temporalWouldBlock,
        result.temporalWouldBlock,
        false
    ));
    const policyMode = normalizeTemporalPolicyMode(firstDefined(
        source.temporalPolicyMode,
        source.policyMode,
        row.temporalPolicyMode,
        payload.temporalPolicyMode,
        result.temporalPolicyMode,
        resolveTemporalPolicyMode(row)
    ));
    return {
        available: Object.keys(source).length > 0 ||
            row.wouldPublishWithoutTemporal !== undefined ||
            row.temporalWouldBlock !== undefined,
        positionId: firstDefined(source.positionId, row.positionId, payload.positionId, result.positionId, null),
        entryDecisionId: firstDefined(source.entryDecisionId, row.entryDecisionId, payload.entryDecisionId, result.entryDecisionId, null),
        capturedAtTs: firstFiniteNumber([
            source.capturedAtTs,
            source.entryTs,
            row.entryTs,
            row.openedAt,
            payload.entryTs,
            result.entryTs
        ]),
        temporalPolicyMode: policyMode,
        temporalPolicyVersion: firstDefined(
            source.temporalPolicyVersion,
            row.temporalPolicyVersion,
            payload.temporalPolicyVersion,
            result.temporalPolicyVersion,
            TEMPORAL_POLICY_VERSION
        ),
        activeTemporalGenerationId: firstDefined(
            source.activeTemporalGenerationId,
            row.activeTemporalGenerationId,
            payload.activeTemporalGenerationId,
            result.activeTemporalGenerationId,
            null
        ),
        exactSelected75ChildMatch: Boolean(firstDefined(
            source.exactSelected75ChildMatch,
            source.exactSelectedTrueMicroMatch,
            row.exactSelected75ChildMatch,
            row.exactSelectedTrueMicroMatch,
            false
        )),
        globalFamilyGate: upper(firstDefined(
            source.globalFamilyGate,
            source.globalGate,
            row.globalFamilyGate,
            row.activationGate,
            'UNKNOWN'
        )),
        currentFitEligible: Boolean(firstDefined(
            source.currentFitEligible,
            row.currentFitEligible,
            true
        )),
        cooldownBlocked: Boolean(firstDefined(
            source.cooldownBlocked,
            row.cooldownBlocked,
            false
        )),
        duplicateBlocked: Boolean(firstDefined(
            source.duplicateBlocked,
            row.duplicateBlocked,
            false
        )),
        dayOfWeekDecision: upper(firstDefined(
            source.dayOfWeekDecision,
            source.dayDecision,
            row.dayOfWeekDecision,
            'INHERIT_GLOBAL'
        )),
        sessionDecision: upper(firstDefined(
            source.sessionDecision,
            row.sessionDecision,
            'INHERIT_GLOBAL'
        )),
        weekendDecision: upper(firstDefined(
            source.weekendDecision,
            row.weekendDecision,
            'NOT_APPLICABLE'
        )),
        wouldPublishWithoutTemporal,
        temporalWouldBlock,
        temporalBlockReasons,
        nonTemporalBlockReasons,
        finalDiscordEntryAllowed: wouldPublishWithoutTemporal &&
            (policyMode !== 'ENFORCE' || temporalWouldBlock === false)
    };
}

function normalizePublicationAttempt(row = {}, publicationType = 'ENTRY') {
    const { payload, result } = payloadResult(row);
    const type = String(publicationType || 'ENTRY').toUpperCase();
    const field = type === 'EXIT' ? 'exitPublicationAttempt' : 'entryPublicationAttempt';
    const source = firstObject(
        row[field],
        row.publicationAttempt,
        payload[field],
        payload.publicationAttempt,
        result[field],
        result.publicationAttempt
    );
    const attemptedRaw = firstDefined(
        source.attempted,
        source.webhookAttempted,
        row.webhookAttempted,
        payload.webhookAttempted,
        result.webhookAttempted
    );
    const attempted = attemptedRaw === undefined ? null : Boolean(attemptedRaw);
    const succeededRaw = firstDefined(
        source.succeeded,
        source.successfullyPosted,
        source.webhookSucceeded,
        row.webhookSucceeded,
        payload.webhookSucceeded,
        result.webhookSucceeded
    );
    const succeeded = attempted === false || attempted === null
        ? null
        : succeededRaw === undefined
            ? null
            : Boolean(succeededRaw);
    return {
        publicationType: type,
        available: Object.keys(source).length > 0 || attempted !== null,
        attempted,
        succeeded,
        statusCode: firstFiniteNumber([
            source.statusCode,
            source.webhookResponseStatus,
            row.statusCode,
            payload.statusCode,
            result.statusCode
        ]),
        errorCode: firstDefined(source.errorCode, row.errorCode, payload.errorCode, result.errorCode, null),
        discordChannelAlias: firstDefined(
            source.discordChannelAlias,
            row.discordChannelAlias,
            payload.discordChannelAlias,
            result.discordChannelAlias,
            null
        ),
        messageReference: firstDefined(
            source.messageReference,
            source.webhookMessageId,
            row.messageReference,
            payload.messageReference,
            result.messageReference,
            null
        ),
        attemptedTs: firstFiniteNumber([
            source.attemptedTs,
            source.attemptedAtTs,
            row.attemptedTs,
            payload.attemptedTs,
            result.attemptedTs
        ]),
        completedTs: firstFiniteNumber([
            source.completedTs,
            source.completedAtTs,
            row.completedTs,
            payload.completedTs,
            result.completedTs
        ]),
        durationMs: firstFiniteNumber([
            source.durationMs,
            source.webhookResponseTime,
            row.durationMs,
            payload.durationMs,
            result.durationMs
        ]),
        secretsStored: false
    };
}

function normalizeLog(row = {}) {
    const { payload, result } = payloadResult(row);
    const resultObject = safeObject(normalizeResult(row));
    const rawInferredTradeSide = inferTradeSide(row);
    const type = normalizeType(row);
    const reason = normalizeReason(row);
    const source = normalizeSource(row);
    const symbol =
         row.symbol ||
         row.contractSymbol ||
         payload.symbol ||
         payload.contractSymbol ||
         resultObject.symbol ||
         resultObject.contractSymbol ||
         null;
    const rawTrueMicroFamilyId = trueMicroFamilyValue(row);
    const rawParentTrueMicroFamilyId = parentMicroFamilyValue(row);
    const trueParsed = parseLongTaxonomyMicroId(rawTrueMicroFamilyId);
    const parentParsed = parseLongTaxonomyMicroId(rawParentTrueMicroFamilyId);
    const trueMicroFamilyId =
         trueParsed.trueMicroFamilyId ||
         row.trueMicroFamilyId ||
         payload.trueMicroFamilyId ||
         resultObject.trueMicroFamilyId ||
         row.microFamilyId ||
         payload.microFamilyId ||
         resultObject.microFamilyId ||
         null;
    const parentTrueMicroFamilyId =
         trueParsed.parentTrueMicroFamilyId ||
         parentParsed.parentTrueMicroFamilyId ||
         row.parentTrueMicroFamilyId ||
         payload.parentTrueMicroFamilyId ||
         resultObject.parentTrueMicroFamilyId ||
         row.coarseMicroFamilyId ||
         payload.coarseMicroFamilyId ||
   resultObject.coarseMicroFamilyId ||
   null;
 const selectedTrueMicroFamilyId = selectedIdentityValue(row);
 const microFamilyId = trueMicroFamilyId;
 const familyId =
   row.familyId ||
   payload.familyId ||
   resultObject.familyId ||
   null;
 const macroFamilyId =
   parentTrueMicroFamilyId ||
   row.macroFamilyId ||
   row.parentMacroFamilyId ||
   payload.macroFamilyId ||
   payload.parentMacroFamilyId ||
   resultObject.macroFamilyId ||
   resultObject.parentMacroFamilyId ||
   null;
 const discordAlertEligible = Boolean(firstDefined(
   row.discordAlertEligible,
   payload.discordAlertEligible,
   resultObject.discordAlertEligible,
   false
 ));
 const selectedMicroFamilyAlert = Boolean(firstDefined(
   row.selectedMicroFamilyAlert,
   payload.selectedMicroFamilyAlert,
   resultObject.selectedMicroFamilyAlert,
   false
 ));
 const virtualOnlyFlag = Boolean(firstDefined(
   row.virtualOnly,
   payload.virtualOnly,
   resultObject.virtualOnly,
   row.virtualTracked,
   payload.virtualTracked,
   resultObject.virtualTracked,
   row.shadowOnly,
   payload.shadowOnly,
   resultObject.shadowOnly,
   false
 ));
 const virtualOnly = Boolean(source === 'VIRTUAL' || source === 'SHADOW' ||
virtualOnlyFlag);
 const skipped = Boolean(firstDefined(
   row.skipped,
   payload.skipped,
      resultObject.skipped,
      false
 ));
 const failed = Boolean(firstDefined(
      row.failed,
      payload.failed,
      resultObject.failed,
      resultObject.ok === false ? true : undefined,
      false
 ));
 const explicitSent = firstDefined(
      row.sent,
      payload.sent,
      resultObject.sent
 );
 const sent = explicitSent !== undefined
      ? Boolean(explicitSent)
      : Boolean(
           !skipped &&
           !failed &&
           (
               type.includes('SENT') ||
               resultObject.ok === true
           )
      );
 const entryAlert = (
      type.includes('ENTRY') ||
      String(reason || '').toUpperCase().includes('ENTRY')
 );
 const exitAlert = (
      type.includes('EXIT') ||
      String(reason || '').toUpperCase().includes('EXIT')
 );
 const entryDecisionSnapshot = normalizeEntryDecisionSnapshot(row);
 const entryPublicationAttempt = normalizePublicationAttempt(row, 'ENTRY');
 const exitPublicationAttempt = normalizePublicationAttempt(row, 'EXIT');
 const riskGeometry = getLongRiskGeometry(row);
 const longCurrentFit = getLongCurrentFit(row);
 const explicitLongGrossR = firstFiniteMetric(row, [
      'longGrossR',
      'grossLongR'
 ]);
 const explicitLongCurrentR = firstFiniteMetric(row, [
      'longCurrentR',
      'currentLongR'
 ]);
 const selectableTrueMicroFamily = isSelectableTrueMicroId(trueMicroFamilyId);
 const parentTrueMicroFamily = Boolean(parentTrueMicroFamilyId &&
isFixedLongParentMicroId(parentTrueMicroFamilyId));
 const selectedTrueMicroIsChild =
isSelectableTrueMicroId(selectedTrueMicroFamilyId);
 const exactSelectedTrueMicroMatch = Boolean(
      selectableTrueMicroFamily &&
      selectedMicroFamilyAlert === true &&
      (
          !selectedTrueMicroFamilyId ||
          String(selectedTrueMicroFamilyId).trim() ===
String(trueMicroFamilyId).trim()
      )
 );
 const explicitSelectedIdMismatch = Boolean(
      selectedTrueMicroFamilyId &&
      selectedTrueMicroIsChild &&
      trueMicroFamilyId &&
      String(selectedTrueMicroFamilyId).trim() !== String(trueMicroFamilyId).trim()
 );
 const parentOnlyMatch = Boolean(
      parentTrueMicroFamilyId &&
      selectedTrueMicroFamilyId &&
      isFixedLongParentMicroId(selectedTrueMicroFamilyId) &&
      String(selectedTrueMicroFamilyId).trim() ===
String(parentTrueMicroFamilyId).trim()
 );
 const alertAllowed = exactSelectedTrueMicroMatch;
 const blockedByManualSelection = discordAlertEligible === true && !alertAllowed;
 const blockedByParentOnlyMatch = discordAlertEligible === true &&
parentOnlyMatch;
 const policyViolation = sent === true && !alertAllowed;
 const realBlocked = isRealLog(row);
 const temporalAudit = temporalRowPayload(row);
 const weekendEntryBlocked = Boolean(
      entryAlert &&
      entryDecisionSnapshot.temporalWouldBlock &&
      entryDecisionSnapshot.temporalBlockReasons.some((reasonText) =>
          String(reasonText).toUpperCase().includes('WEEKEND')
      )
 );
 const weekendDiscordEntryAllowed = !weekendEntryBlocked;
 const sessionDiscordEntryAllowed = !entryDecisionSnapshot.temporalBlockReasons.some(
      (reasonText) => String(reasonText).toUpperCase().includes('SESSION')
 );
 const temporalPolicyViolation = Boolean(
      sent &&
      entryAlert &&
      entryDecisionSnapshot.temporalPolicyMode === 'ENFORCE' &&
      entryDecisionSnapshot.temporalWouldBlock
 );
 return {
      ...row,
      ...temporalRowPayload(row),
      type,
      payload,
      result,
      reason,
      source,
      symbol,
      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      positionSide: TARGET_TRADE_SIDE,
      direction: TARGET_TRADE_SIDE,
targetTradeSide: TARGET_TRADE_SIDE,
dashboardSide: TARGET_DASHBOARD_SIDE,
scannerSide: TARGET_SCANNER_SIDE,
oppositeTradeSide: OPPOSITE_TRADE_SIDE,
longOnly: true,
shortDisabled: true,
shortOnly: false,
longDisabled: false,
realOrdersDisabled: true,
bitgetOrdersDisabled: true,
exchangeCallsDisabled: true,
realOutcomesExcluded: true,
virtualLearning: true,
virtualLearningForced: true,
virtualOutcomesIncluded: true,
shadowOutcomesIncluded: true,
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
riskTradeSide: TARGET_TRADE_SIDE,
riskGeometryRule: riskGeometry.riskGeometryRule,
tpHitRule: riskGeometry.tpHitRule,
slHitRule: riskGeometry.slHitRule,
grossRFormula: riskGeometry.grossRFormula,
currentRFormula: riskGeometry.currentRFormula,
validLongGeometry: Boolean(riskGeometry.validGeometry),
longValidGeometry: Boolean(riskGeometry.validGeometry),
longTpHit: riskGeometry.longTpHit,
longSlHit: riskGeometry.longSlHit,
tpHit: riskGeometry.longTpHit,
slHit: riskGeometry.longSlHit,
longGrossR: riskGeometry.longGrossR ?? explicitLongGrossR,
longCurrentR: riskGeometry.longCurrentR ?? explicitLongCurrentR,
currentR: riskGeometry.longCurrentR ?? explicitLongCurrentR,
   entryPrice: riskGeometry.entry ?? firstMetricValue(row, ['entryPrice',
'entry']),
   initialSl: riskGeometry.initialSl ?? firstMetricValue(row, ['initialSl',
'initialSL', 'stopLoss', 'sl']),
   tp: riskGeometry.tp ?? firstMetricValue(row, ['tp', 'takeProfit',
'takeProfitPrice']),
   currentFit: longCurrentFit,
   longCurrentFit,
   bullCurrentFit: longCurrentFit,
   bearishCurrentFit: -longCurrentFit,
   currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
   currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
   rawInferredTradeSide,
   inferredTradeSide: rawInferredTradeSide,
   microFamilyId,
   trueMicroFamilyId,
   parentTrueMicroFamilyId,
   coarseMicroFamilyId: parentTrueMicroFamilyId || trueMicroFamilyId || null,
   familyId,
   macroFamilyId,
   taxonomySetup: trueParsed.setup || parentParsed.setup || null,
   taxonomyRegime: trueParsed.regime || parentParsed.regime || null,
   confirmationProfile: trueParsed.confirmationProfile || null,
   selectableTrueMicroFamily,
   parentTrueMicroFamily,
   discordSelectable: selectableTrueMicroFamily,
   selectedTrueMicroFamilyId: selectedTrueMicroFamilyId || null,
   selectedTrueMicroIsChild,
   selectedMicroFamilyAlert,
   exactSelectedTrueMicroMatch,
   explicitSelectedIdMismatch,
   parentOnlyMatch,
   virtualOnly,
   virtualTracked: virtualOnly,
   shadowOnly: source === 'SHADOW' || virtualOnly,
   realBlocked,
   discordAlertEligible,
   manualSelectionRequired: true,
   manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
   discordOnlyForSelectedMicroFamilies: true,
   discordOnlyForExactTrueMicroMatch: true,
   parentMatchDoesNotTriggerDiscord: true,
   macroMatchDoesNotTriggerDiscord: true,
   alertAllowed,
   blockedByManualSelection,
   blockedByParentOnlyMatch,
   policyViolation,
         entryDecisionSnapshot,
         entryPublicationAttempt,
         exitPublicationAttempt,
         wouldPublishWithoutTemporal: entryDecisionSnapshot.wouldPublishWithoutTemporal,
         temporalWouldBlock: entryDecisionSnapshot.temporalWouldBlock,
         temporalBlockReasons: entryDecisionSnapshot.temporalBlockReasons,
         finalDiscordEntryAllowed: entryDecisionSnapshot.finalDiscordEntryAllowed,
         weekendEntryBlocked,
         weekendDiscordEntryAllowed,
         sessionDiscordEntryAllowed,
         temporalPolicyViolation,
         entryAlert,
         exitAlert,
         sent,
         skipped,
         failed,
         ts:
           row.ts ||
           row.createdAt ||
           payload.ts ||
           payload.createdAt ||
           resultObject.ts ||
           resultObject.createdAt ||
           null
    };
}
function filterByType(logs = [], type = null) {
    if (!type) return logs;
    const wanted = String(type).toUpperCase();
    return logs.filter((log) => String(log.type || '').toUpperCase() === wanted);
}
function filterBySymbol(logs = [], symbol = null) {
    if (!symbol) return logs;
    const wanted = String(symbol).trim().toUpperCase();
    return logs.filter((log) => (
         String(log.symbol || '').trim().toUpperCase() === wanted ||
         String(log.contractSymbol || '').trim().toUpperCase() === wanted ||
         String(log.payload?.symbol || '').trim().toUpperCase() === wanted ||
         String(log.payload?.contractSymbol || '').trim().toUpperCase() === wanted ||
         String(log.result?.symbol || '').trim().toUpperCase() === wanted ||
         String(log.result?.contractSymbol || '').trim().toUpperCase() === wanted
    ));
}
function filterByMicroFamilyId(logs = [], microFamilyId = null) {
    if (!microFamilyId) return logs;
    const wanted = String(microFamilyId).trim();
    return logs.filter((log) => (
         String(log.trueMicroFamilyId || '').trim() === wanted ||
         String(log.microFamilyId || '').trim() === wanted ||
         String(log.parentTrueMicroFamilyId || '').trim() === wanted ||
         String(log.payload?.trueMicroFamilyId || '').trim() === wanted ||
         String(log.payload?.microFamilyId || '').trim() === wanted ||
         String(log.payload?.parentTrueMicroFamilyId || '').trim() === wanted ||
         String(log.result?.trueMicroFamilyId || '').trim() === wanted ||
      String(log.result?.microFamilyId || '').trim() === wanted ||
      String(log.result?.parentTrueMicroFamilyId || '').trim() === wanted
    ));
}
function filterSelectedOnly(logs = [], selectedOnly = false) {
    if (!selectedOnly) return logs;
    return logs.filter((log) => log.alertAllowed === true);
}
function buildSummary(logs = []) {
    return logs.reduce((acc, log) => {
      const type = String(log.type || 'UNKNOWN').toUpperCase();
      const reason = String(log.reason || 'NO_REASON').toUpperCase();
      acc.total += 1;
      acc.byType[type] = (acc.byType[type] || 0) + 1;
      acc.byReason[reason] = (acc.byReason[reason] || 0) + 1;
      if (log.sent) acc.sent += 1;
      if (log.failed) acc.failed += 1;
      if (log.skipped) acc.skipped += 1;
      if (log.entryAlert) acc.entryAlerts += 1;
      if (log.exitAlert) acc.exitAlerts += 1;
      if (log.virtualOnly || log.virtualTracked || log.source === 'VIRTUAL') {
          acc.virtual += 1;
      }
      if (log.shadowOnly || log.source === 'SHADOW') {
          acc.shadow += 1;
      }
      if (log.realBlocked || log.source === 'REAL') {
          acc.realBlocked += 1;
      }
      if (log.discordAlertEligible) acc.eligible += 1;
      if (log.selectedMicroFamilyAlert) acc.selected += 1;
      if (log.selectableTrueMicroFamily) acc.selectableChildFamilyLogs += 1;
      if (log.parentTrueMicroFamily && !log.selectableTrueMicroFamily)
acc.parentOnlyLogs += 1;
      if (log.alertAllowed) acc.alertAllowed += 1;
      if (log.blockedByManualSelection) acc.blockedByManualSelection += 1;
      if (log.blockedByParentOnlyMatch) acc.blockedByParentOnlyMatch += 1;
      if (log.explicitSelectedIdMismatch) acc.explicitSelectedIdMismatches += 1;
      if (log.policyViolation) acc.policyViolations += 1;
      if (log.temporalWouldBlock) acc.temporalWouldBlock += 1;
      if (log.temporalPolicyViolation) acc.temporalPolicyViolations += 1;
      if (log.entryPublicationAttempt?.attempted === true) acc.entryPublicationAttempts += 1;
      if (log.entryPublicationAttempt?.succeeded === true) acc.entryPublicationSucceeded += 1;
      if (log.entryPublicationAttempt?.succeeded === false) acc.entryPublicationFailed += 1;
      if (log.exitPublicationAttempt?.attempted === true) acc.exitPublicationAttempts += 1;
      if (log.exitPublicationAttempt?.succeeded === true) acc.exitPublicationSucceeded += 1;
      if (log.exitPublicationAttempt?.succeeded === false) acc.exitPublicationFailed += 1;
      if (log.rawInferredTradeSide === OPPOSITE_TRADE_SIDE || log.inferredTradeSide
=== OPPOSITE_TRADE_SIDE) {
          acc.shortFilteredLeaks += 1;
      }
      if (log.validLongGeometry) acc.validLongGeometry += 1;
      if (log.longTpHit) acc.longTpHits += 1;
      if (log.longSlHit) acc.longSlHits += 1;
      return acc;
    }, {
         total: 0,
         sent: 0,
         failed: 0,
         skipped: 0,
         entryAlerts: 0,
         exitAlerts: 0,
         virtual: 0,
         shadow: 0,
         realBlocked: 0,
         eligible: 0,
         selected: 0,
         selectableChildFamilyLogs: 0,
         parentOnlyLogs: 0,
         alertAllowed: 0,
         blockedByManualSelection: 0,
         blockedByParentOnlyMatch: 0,
         explicitSelectedIdMismatches: 0,
         policyViolations: 0,
         temporalWouldBlock: 0,
         temporalPolicyViolations: 0,
         entryPublicationAttempts: 0,
         entryPublicationSucceeded: 0,
         entryPublicationFailed: 0,
         exitPublicationAttempts: 0,
         exitPublicationSucceeded: 0,
         exitPublicationFailed: 0,
         shortFilteredLeaks: 0,
         validLongGeometry: 0,
         longTpHits: 0,
         longSlHits: 0,
         byType: {},
         byReason: {}
    });
}
function getLongDiscordLogKey() {
    return namespacedLongKey(
         KEYS.discord?.longLogList ||
           KEYS.discordLong?.logList ||
           KEYS.long?.discord?.logList ||
           KEYS.discord?.logList,
         'DISCORD:LOGS'
    );
}
function baseModePayload() {
    return {
         ...temporalPolicyPayload(Date.now()),
         targetTradeSide: TARGET_TRADE_SIDE,
         dashboardSide: TARGET_DASHBOARD_SIDE,
         scannerSide: TARGET_SCANNER_SIDE,
         oppositeTradeSide: OPPOSITE_TRADE_SIDE,
         longOnly: true,
         shortDisabled: true,
         shortOnly: false,
         longDisabled: false,
realOrdersDisabled: true,
bitgetOrdersDisabled: true,
exchangeCallsDisabled: true,
realOutcomesExcluded: true,
virtualLearning: true,
virtualLearningForced: true,
virtualPositionsOnly: true,
virtualOutcomesIncluded: true,
shadowPositionsVisible: true,
shadowOutcomesIncluded: true,
maxOneOpenPositionPerSymbol: true,
globalMaxOpenPositionsBlockDisabled: true,
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
         persistentLearningKey: PERSISTENT_LEARNING_KEY,
         weekResetDisabled: true,
         isoWeekLearningDisabled: true,
         redisNamespace: LONG_NAMESPACE,
         redisKeyPrefix: LONG_KEY_PREFIX,
         discordLogKeyNamespace: LONG_NAMESPACE,
         redisKeysSeparatedFromShortRoot: true,
         shortRootTouched: false
    };
}
function classifyLogs(logs = []) {
    return logs.reduce((acc, log) => {
         if (logHasInvalidLearningId(log)) {
             acc.metadataBlockedCount += 1;
             return acc;
         }
         if (isRealLog(log)) {
             acc.realBlockedCount += 1;
             return acc;
         }
         if (isLongLog(log)) {
             acc.longOnlyLogs.push(log);
             return acc;
         }
         if (isShortLog(log)) {
             acc.shortBlockedCount += 1;
             return acc;
         }
         acc.unknownBlockedCount += 1;
         return acc;
    }, {
         longOnlyLogs: [],
         shortBlockedCount: 0,
         metadataBlockedCount: 0,
         realBlockedCount: 0,
         unknownBlockedCount: 0
    });
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
 res.setHeader('X-Admin-Discord-Logs-Mode', 'long-only-75-child-exact-discord-logs-temporal-v2');
 res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
 res.setHeader('X-Long-Only', 'true');
 res.setHeader('X-Short-Disabled', 'true');
 res.setHeader('X-Manual-Selection-Required', 'true');
 res.setHeader('X-Manual-Selection-Match-Mode', 'EXACT_TRUE_MICRO_FAMILY_ID');
 res.setHeader('X-Discord-Selection-Rule',
'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY');
 res.setHeader('X-True-Micro-Family-Schema', TRUE_MICRO_SCHEMA);
 res.setHeader('X-Learning-Granularity', LEARNING_GRANULARITY);
 res.setHeader('X-Real-Orders-Disabled', 'true');
 res.setHeader('X-Bitget-Orders-Disabled', 'true');
 res.setHeader('X-Virtual-Learning-Forced', 'true');
 res.setHeader('X-Redis-Namespace', LONG_NAMESPACE);
 res.setHeader('X-Short-Root-Touched', 'false');
 try {
   if (req.method !== 'GET') {
        return methodNotAllowed(res);
   }
   const limit = clampLimit(firstQueryValue(req.query?.limit, 100), 100);
   const type = firstQueryValue(req.query?.type, null);
   const symbol = firstQueryValue(req.query?.symbol, null);
   const microFamilyId = firstQueryValue(req.query?.microFamilyId, null);
   const selectedOnly = bool(firstQueryValue(req.query?.selectedOnly, false),
false);
   const includeShortRequested = bool(firstQueryValue(req.query?.includeShort,
false), false);
   const hasPostFilters = Boolean(type || symbol || microFamilyId ||
selectedOnly);
   const fetchLimit = hasPostFilters
        ? Math.min(500, Math.max(limit, limit * 5))
        : limit;
   const redis = getDurableRedis();
   const discordLogKey = getLongDiscordLogKey();
   const rawLogs = await readJsonLogs(
        redis,
        discordLogKey,
        fetchLimit
   );
   const normalized = (Array.isArray(rawLogs) ? rawLogs : [])
        .map(normalizeLog);
  const {
       longOnlyLogs,
       shortBlockedCount,
       metadataBlockedCount,
       realBlockedCount,
       unknownBlockedCount
  } = classifyLogs(normalized);
  const filteredLogs = filterSelectedOnly(
       filterByMicroFamilyId(
            filterBySymbol(
                 filterByType(longOnlyLogs, type),
                 symbol
            ),
            microFamilyId
       ),
       selectedOnly
  );
  const logs = filteredLogs.slice(0, limit);
  return res.status(200).json({
       ok: true,
       ...baseModePayload(),
       limit,
       fetchLimit,
       type,
       symbol,
       microFamilyId,
       selectedOnly,
       includeShortRequested,
       includeShortIgnored: includeShortRequested,
       shortHardBlocked: true,
       discordLogKey,
       count: logs.length,
       totalMatched: filteredLogs.length,
       totalFetched: Array.isArray(rawLogs) ? rawLogs.length : 0,
       totalAfterLongFilter: longOnlyLogs.length,
       shortBlockedCount,
       metadataBlockedCount,
       realBlockedCount,
       unknownBlockedCount,
       summary: buildSummary(logs),
       logs,
       serverTs: Date.now()
  });
} catch (error) {
  return res.status(500).json({
       ok: false,
       ...baseModePayload(),
          error: error?.message || String(error),
          stack: process.env.NODE_ENV === 'production'
              ? undefined
              : error?.stack
        });
    }
}
