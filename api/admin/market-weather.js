// ================= FILE: api/admin/market-weather.js =================
//
// Veilige admin route voor MarketWeather.
// Deze route mag nooit stil {} teruggeven.
// Als import/build faalt, krijg je de echte fout in JSON.
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

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = TRUE_MICRO_SCHEMA;
const LEARNING_GRANULARITY =
'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const MEASUREMENT_FIX_VERSION =
'LONG_MEASUREMENT_FIX_TRIGGER_BOUNDARY_EXIT_FILL_V2';
const ADMIN_ROUTE_VERSION = 'LONG_ADMIN_MARKET_WEATHER_SAFE_ROUTE_V1';
function sendJson(res, statusCode, data) {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.end(JSON.stringify(data, null, 2));
}
function bool(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const raw = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(raw)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(raw)) return false;
    return fallback;
}
function num(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}
function upper(value) {
    return String(value || '').trim().toUpperCase();
}
function firstFinite(...values) {
    for (const value of values) {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
    }
    return null;
}
function clamp(value, min = 0, max = 100) {
    const n = num(value, min);
    if (n < min) return min;
    if (n > max) return max;
    return n;
}
function normalizeRegime(value) {
    const raw = upper(value);
    if (raw.includes('TREND')) return 'TREND';
    if (raw.includes('SQUEEZE')) return 'SQUEEZE';
    if (raw.includes('COMPRESSION')) return 'SQUEEZE';
    if (raw.includes('CHOP')) return 'CHOP';
    if (raw.includes('RANGE')) return 'CHOP';
    if (raw.includes('SIDEWAYS')) return 'CHOP';
    return raw || 'UNKNOWN';
}
function normalizeTrendSide(value) {
    const raw = upper(value);
    if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE'].includes(raw))
return
'SHORT';
    if (['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'UPSIDE'].includes(raw))
return 'LONG';
    if (['NEUTRAL', 'MIXED', 'CHOP', 'SIDEWAYS', 'FLAT'].includes(raw)) return
'NEUTRAL';
    return raw || 'UNKNOWN';
}
function dashboardTrendSide(value) {
    const side = normalizeTrendSide(value);
    if (side === 'SHORT') return 'BEAR';
    if (side === 'LONG') return 'BULL';
    if (side === 'NEUTRAL') return 'MIXED';
    return 'UNKNOWN';
}
function pct(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (Math.abs(n) <= 1) return Number((n * 100).toFixed(2));
    return Number(n.toFixed(2));
}
function signedPct(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (Math.abs(n) <= 1) return Number((n * 100).toFixed(4));
    return Number(n.toFixed(4));
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
function makeFallbackWeather(reason = 'NO_MARKET_WEATHER') {
    return {
      ok: false,
      available: false,
      reason,
      currentRegime: 'UNKNOWN',
      regime: 'UNKNOWN',
      currentTrendSide: 'UNKNOWN',
      trendSide: 'UNKNOWN',
      marketTrendSide: 'UNKNOWN',
      confidence: 0,
      weatherConfidence: 0,
      currentMarketFitConfidence: 0,
      currentFit: 0,
      longCurrentFit: 0,
      bullCurrentFit: 0,
         bearishCurrentFit: 0,
         bearishPct: null,
         bullishPct: null,
         neutralPct: null,
         squeezePct: null,
         sampleSize: 0,
         universeSize: 0,
         universeCount: 0,
         count: 0,
         breadth: {},
         btc: {},
         symbols: [],
         rows: [],
         universe: []
    };
}
function marketBiasText(weather = {}, breadth = {}) {
    return [
         weather.currentTrendSide,
         weather.trendSide,
         weather.marketTrendSide,
         weather.marketSide,
         weather.side,
         weather.direction,
         weather.bias,
         weather.marketBias,
         weather.currentMarketBias,
         weather.regime,
         weather.currentRegime,
         weather.marketRegime,
         weather.breadthRegime,
         breadth.currentTrendSide,
         breadth.trendSide,
         breadth.marketTrendSide,
         breadth.marketSide,
         breadth.side,
         breadth.direction,
         breadth.bias,
         breadth.marketBias,
         breadth.currentMarketBias,
         breadth.regime
    ]
         .map((value) => cleanSideText(value))
         .filter(Boolean)
         .join(' | ');
}
function resolveLongCurrentFit({
 weather = {},
 breadth = {},
 currentTrendSide = 'UNKNOWN',
 bearishPct = null,
 bullishPct = null
} = {}) {
 const explicitLongFit = firstFinite(
      weather.longCurrentFit,
      weather.currentLongFit,
      weather.bullCurrentFit,
      weather.bullishCurrentFit,
      weather.longFit,
      weather.bullFit,
      weather.bullishFit,
      breadth.longCurrentFit,
      breadth.currentLongFit,
      breadth.bullCurrentFit,
      breadth.bullishCurrentFit
 );
 if (explicitLongFit !== null) return signedPct(explicitLongFit);
 const explicitShortFit = firstFinite(
      weather.shortCurrentFit,
      weather.currentShortFit,
      weather.bearCurrentFit,
      weather.bearishCurrentFit,
      weather.shortFit,
      weather.bearFit,
      weather.bearishFit,
      breadth.shortCurrentFit,
      breadth.currentShortFit,
      breadth.bearCurrentFit,
      breadth.bearishCurrentFit
 );
 if (explicitShortFit !== null) return signedPct(-explicitShortFit);
 const rawFit = firstFinite(
      weather.currentFit,
      weather.marketCurrentFit,
      weather.marketFit,
      weather.fitScore,
      breadth.currentFit,
      breadth.marketCurrentFit,
      breadth.marketFit,
      breadth.fitScore
 );
 const normalizedSide = normalizeTrendSide(currentTrendSide);
 if (rawFit !== null) {
      if (normalizedSide === 'LONG') return signedPct(Math.abs(rawFit));
         if (normalizedSide === 'SHORT') return signedPct(-Math.abs(rawFit));
         const text = marketBiasText(weather, breadth);
         const bullish = hasLongSignal(text);
         const bearish = hasShortSignal(text);
         if (bullish && !bearish) return signedPct(Math.abs(rawFit));
         if (bearish && !bullish) return signedPct(-Math.abs(rawFit));
         return signedPct(-rawFit);
    }
    if (bullishPct !== null || bearishPct !== null) {
         return Number((num(bullishPct, 0) - num(bearishPct, 0)).toFixed(4));
    }
    if (normalizedSide === 'LONG') return 1;
    if (normalizedSide === 'SHORT') return -1;
    return 0;
}
function normalizeWeatherForAdmin(weatherInput = {}) {
    const weather = weatherInput && typeof weatherInput === 'object'
         ? weatherInput
         : makeFallbackWeather('INVALID_WEATHER');
    const breadth = weather.breadth || {};
    const currentRegime = normalizeRegime(
         weather.currentRegime ||
         weather.regime ||
         weather.marketRegime ||
         weather.breadthRegime
    );
    const currentTrendSide = normalizeTrendSide(
         weather.currentTrendSide ||
         weather.trendSide ||
         weather.marketTrendSide ||
         weather.marketSide ||
         weather.side ||
         weather.direction
    );
    const confidence = clamp(
         weather.currentMarketFitConfidence ??
              weather.confidence ??
              weather.weatherConfidence ??
              weather.currentTrendConfidence,
         0,
         100
    );
    const sampleSize = num(
         weather.sampleSize ??
              weather.universeSize ??
              weather.universeCount ??
              weather.count,
     0
);
const createdAt = firstFinite(
     weather.generatedAt,
     weather.updatedAt,
     weather.savedAt,
     weather.loadedAt,
     weather.completedAt,
     weather.createdAt,
     weather.ts
);
const bearishPct = pct(firstFinite(
     weather.bearishPct,
     weather.shortPct,
     weather.upPct,
     weather.breadthBearishPct,
     breadth.bearishPct,
     breadth.shortPct,
     breadth.upPct,
     breadth.advancePct,
     breadth.advanceRatio
));
const bullishPct = pct(firstFinite(
     weather.bullishPct,
     weather.longPct,
     weather.downPct,
     weather.breadthBullishPct,
     breadth.bullishPct,
     breadth.longPct,
     breadth.downPct,
     breadth.declinePct,
     breadth.declineRatio
));
const neutralPct = pct(firstFinite(
     weather.neutralPct,
     weather.flatPct,
     breadth.neutralPct,
     breadth.flatPct,
     breadth.neutralRatio
));
const squeezePct = pct(firstFinite(
     weather.squeezePct,
     weather.compressionPct,
     breadth.squeezePct,
     breadth.compressionPct
));
const longCurrentFit = resolveLongCurrentFit({
  weather,
  breadth,
  currentTrendSide,
  bearishPct,
  bullishPct
});
const ok =
  weather.ok === true ||
  weather.available === true ||
  sampleSize > 0 ||
  currentRegime !== 'UNKNOWN' ||
  currentTrendSide !== 'UNKNOWN';
return {
  ...temporalPolicyPayload(createdAt || Date.now()),
  ...weather,
  ok,
  available: ok,
  adminRouteVersion: ADMIN_ROUTE_VERSION,
  temporalAdminScope: 'UTC_CONTEXT_AND_RUNTIME_POLICY_PROJECTION',
  temporalGenerationAuthoritative: false,
  temporalFamilyStatsAuthoritative: false,
  file: 'src/market/marketWeather.js',
  apiRoute: '/api/admin/market-weather',
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
  virtualLearning: true,
  virtualLearningForced: true,
  virtualOutcomesIncluded: true,
  shadowOutcomesIncluded: true,
  realOutcomesExcluded: true,
  realOrdersDisabled: true,
  bitgetOrdersDisabled: true,
  exchangeCallsDisabled: true,
  currentRegime,
  regime: currentRegime,
  currentTrendSide,
  trendSide: dashboardTrendSide(currentTrendSide),
  marketTrendSide: dashboardTrendSide(currentTrendSide),
  confidence,
  weatherConfidence: confidence,
   currentMarketFitConfidence: confidence,
   currentFit: longCurrentFit,
   longCurrentFit,
   bullCurrentFit: longCurrentFit,
   bullishCurrentFit: longCurrentFit,
   bearishCurrentFit: Number((-longCurrentFit).toFixed(4)),
   shortCurrentFit: Number((-longCurrentFit).toFixed(4)),
   currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
   currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
   bearishPct,
   bullishPct,
   neutralPct,
   squeezePct,
   sampleSize,
   universeSize: num(weather.universeSize ?? weather.universeCount ??
weather.count, sampleSize),
   universeCount: num(weather.universeCount ?? weather.universeSize ??
weather.count, sampleSize),
   count: num(weather.count ?? sampleSize, sampleSize),
   createdAt: createdAt || null,
   updatedAt: firstFinite(weather.updatedAt, weather.savedAt,
weather.generatedAt, createdAt) || null,
   generatedAt: firstFinite(weather.generatedAt, weather.updatedAt,
weather.savedAt, createdAt) || null,
   currentFitSoftOnly: true,
   currentFitBlocksLearning: false,
   currentFitBlocksVirtualLearning: false,
   currentFitBlocksShadowLearning: false,
   learningRemainsBroad: true,
   adaptiveLayerBuilt: false,
   adaptiveScoreBuilt: false,
   recentMomentumScoreBuilt: false,
   parentDiversificationBuilt: false,
   trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
   exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
   childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
   parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
   learningGranularity: LEARNING_GRANULARITY,
   parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
   redisNamespace: LONG_NAMESPACE,
   redisKeyPrefix: LONG_KEY_PREFIX,
   persistentLearningKey: PERSISTENT_LEARNING_KEY,
   redisKeysSeparatedFromShortRoot: true,
   shortRootTouched: false,
   riskTradeSide: TARGET_TRADE_SIDE,
   riskGeometryRule: 'LONG: sl < entry < tp',
   tpHitRule: 'LONG: price >= tp',
         slHitRule: 'LONG: price <= sl',
         grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
         currentRFormula: '(currentPrice - entry) / (entry - initialSl)',
         measurementFixVersion: MEASUREMENT_FIX_VERSION
    };
}
function buildResponse(weather, extra = {}) {
    const normalized = normalizeWeatherForAdmin(weather);
    const universe =
         Array.isArray(normalized.universe) ? normalized.universe :
         Array.isArray(normalized.rows) ? normalized.rows :
         [];
    return {
         ...temporalPolicyPayload(normalized.generatedAt || Date.now()),
         ok: normalized.ok,
         available: normalized.available,
         route: '/api/admin/market-weather',
         adminRouteVersion: ADMIN_ROUTE_VERSION,
         file: 'src/market/marketWeather.js',
         ...extra,
         currentRegime: normalized.currentRegime,
         currentTrendSide: normalized.currentTrendSide,
         regime: normalized.regime,
         trendSide: normalized.trendSide,
         marketTrendSide: normalized.marketTrendSide,
         confidence: normalized.confidence,
         weatherConfidence: normalized.weatherConfidence,
         currentMarketFitConfidence: normalized.currentMarketFitConfidence,
         currentFit: normalized.currentFit,
         longCurrentFit: normalized.longCurrentFit,
         bullCurrentFit: normalized.bullCurrentFit,
         bullishCurrentFit: normalized.bullishCurrentFit,
         bearishCurrentFit: normalized.bearishCurrentFit,
         shortCurrentFit: normalized.shortCurrentFit,
         currentFitPolarity: normalized.currentFitPolarity,
         currentFitDefinition: normalized.currentFitDefinition,
         bearishPct: normalized.bearishPct,
         bullishPct: normalized.bullishPct,
         neutralPct: normalized.neutralPct,
         squeezePct: normalized.squeezePct,
         sampleSize: normalized.sampleSize,
         universeSize: normalized.universeSize,
         universeCount: normalized.universeCount,
         count: normalized.count,
         createdAt: normalized.createdAt,
         updatedAt: normalized.updatedAt,
         generatedAt: normalized.generatedAt,
breadth: normalized.breadth || {},
btc: normalized.btc || {},
symbols: normalized.symbols || [],
marketUniverse: universe,
universe,
currentFitSoftOnly: true,
currentFitBlocksLearning: false,
currentFitBlocksVirtualLearning: false,
currentFitBlocksShadowLearning: false,
learningRemainsBroad: true,
adaptiveLayerBuilt: false,
adaptiveScoreBuilt: false,
recentMomentumScoreBuilt: false,
parentDiversificationBuilt: false,
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
virtualLearning: true,
virtualLearningForced: true,
virtualOutcomesIncluded: true,
shadowOutcomesIncluded: true,
realOutcomesExcluded: true,
realOrdersDisabled: true,
bitgetOrdersDisabled: true,
exchangeCallsDisabled: true,
riskTradeSide: TARGET_TRADE_SIDE,
riskGeometryRule: 'LONG: sl < entry < tp',
tpHitRule: 'LONG: price >= tp',
slHitRule: 'LONG: price <= sl',
grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
currentRFormula: '(currentPrice - entry) / (entry - initialSl)',
trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
learningGranularity: LEARNING_GRANULARITY,
parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
redisNamespace: LONG_NAMESPACE,
         redisKeyPrefix: LONG_KEY_PREFIX,
         persistentLearningKey: PERSISTENT_LEARNING_KEY,
         redisKeysSeparatedFromShortRoot: true,
         shortRootTouched: false,
         measurementFixVersion: MEASUREMENT_FIX_VERSION,
         marketWeather: normalized,
         weather: normalized,
         currentMarketWeather: normalized,
         latest: normalized,
         snapshot: normalized,
         raw: normalized
    };
}
function buildMarketWeatherOptions({
    redis,
    save,
    refresh = false
} = {}) {
    return {
         redis,
         save,
         refresh,
         allowStale: true,
         tradeSide: TARGET_TRADE_SIDE,
         side: TARGET_DASHBOARD_SIDE,
         scannerSide: TARGET_SCANNER_SIDE,
         namespace: LONG_NAMESPACE,
         keyPrefix: LONG_KEY_PREFIX,
         redisNamespace: LONG_NAMESPACE,
         redisKeyPrefix: LONG_KEY_PREFIX,
         weekKey: PERSISTENT_LEARNING_KEY,
         persistentLearningKey: PERSISTENT_LEARNING_KEY,
         trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
         childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
         parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
         learningGranularity: LEARNING_GRANULARITY,
         parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
         longOnly: true,
         shortDisabled: true,
         virtualLearning: true,
         virtualLearningForced: true,
         realOrdersDisabled: true,
         bitgetOrdersDisabled: true,
         exchangeCallsDisabled: true,
         realOutcomesExcluded: true
    };
}
export default async function handler(req, res) {
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
 const method = String(req?.method || 'GET').toUpperCase();
 if (method === 'OPTIONS') {
     res.setHeader('Allow', 'GET, POST, OPTIONS');
     return sendJson(res, 200, { ok: true });
 }
 if (!['GET', 'POST'].includes(method)) {
     return sendJson(res, 405, {
         ok: false,
         available: false,
         error: 'METHOD_NOT_ALLOWED',
         targetTradeSide: TARGET_TRADE_SIDE,
         dashboardSide: TARGET_DASHBOARD_SIDE,
         scannerSide: TARGET_SCANNER_SIDE,
         redisNamespace: LONG_NAMESPACE,
         persistentLearningKey: PERSISTENT_LEARNING_KEY,
         shortRootTouched: false
     });
 }
 try {
     const query = req?.query || {};
     const refresh = bool(query.refresh, false) || bool(query.force, false);
     const save = query.save === undefined ? true : bool(query.save, true);
     let marketModule;
     let redisModule;
     try {
         marketModule = await import('../../src/market/marketWeather.js');
     } catch (error) {
         return sendJson(res, 200,
buildResponse(makeFallbackWeather('IMPORT_MARKET_WEATHER_FAILED'), {
           importOk: false,
           importError: error?.message || String(error),
           importStack: process.env.NODE_ENV === 'production' ? undefined :
error?.stack
         }));
     }
     try {
         redisModule = await import('../../src/redis.js');
     } catch (error) {
         return sendJson(res, 200,
buildResponse(makeFallbackWeather('IMPORT_REDIS_FAILED'), {
           importOk: false,
           importError: error?.message || String(error),
           importStack: process.env.NODE_ENV === 'production' ? undefined :
error?.stack
       }));
   }
   const redis = redisModule.getDurableRedis
       ? redisModule.getDurableRedis()
       : undefined;
   let weather;
   let source;
   try {
       if (refresh && typeof marketModule.buildMarketWeather === 'function') {
           weather = await
marketModule.buildMarketWeather(buildMarketWeatherOptions({
              redis,
              save,
              refresh: true
           }));
           source = 'buildMarketWeather';
       } else if (typeof marketModule.getMarketWeather === 'function') {
           weather = await marketModule.getMarketWeather(buildMarketWeatherOptions({
              redis,
              save,
              refresh: false
           }));
           source = 'getMarketWeather';
       } else if (typeof marketModule.loadMarketWeather === 'function') {
           weather = await marketModule.loadMarketWeather(buildMarketWeatherOptions({
              redis,
              save,
              refresh: false
           }));
           source = 'loadMarketWeather';
       } else {
           weather = makeFallbackWeather('NO_MARKET_WEATHER_EXPORT_FOUND');
           source = 'fallback';
       }
   } catch (error) {
       return sendJson(res, 200,
buildResponse(makeFallbackWeather('MARKET_WEATHER_FUNCTION_FAILED'), {
           importOk: true,
           source: 'error',
           functionError: error?.message || String(error),
           functionStack: process.env.NODE_ENV === 'production' ? undefined :
error?.stack
       }));
   }
        return sendJson(res, 200, buildResponse(weather, {
          importOk: true,
          source,
          refreshed: refresh
        }));
    } catch (error) {
        return sendJson(res, 200,
buildResponse(makeFallbackWeather('ADMIN_ROUTE_FAILED'), {
          routeError: error?.message || String(error),
          routeStack: process.env.NODE_ENV === 'production' ? undefined : error?.stack
        }));
    }
}
