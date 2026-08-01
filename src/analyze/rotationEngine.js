// ================= FILE: src/analyze/rotationEngine.js =================

import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { CONFIG } from '../config.js';
import { KEYS } from '../keys.js';
import { getDurableRedis, getJson, setJson } from '../redis.js';
import {
  getIsoWeekKey,
  getNextIsoWeekKey,
  getPreviousIsoWeekKey,
  randomId,
  safeNumber,
  sideToTradeSide
} from '../utils.js';
import {
  getWeekMicros,
  saveWeekMicros,
  getMicroOutcomeHistory
} from './analyzeEngine.js';
import {
  rankMicros,
  refreshStats,
  ensureTemporalStats,
  buildTemporalContext,
  resolveEntryTemporalContext,
  temporalPolicyFlags,
  temporalRuntimeConfig,
  temporalStatsEnabled,
  temporalPolicyMode,
  buildTemporalGateWindow,
  prepareTemporalOutcomePool,
  buildTemporalGateWindowFromPrepared,
  computeTemporalWindowStats,
  temporalGateMaturity,
  evaluateTemporalDiversity,
  evaluateTemporalConfounding,
  temporalOneSidedPValue,
  benjaminiHochberg,
  TEMPORAL_CONTEXT_VERSION,
  TEMPORAL_POLICY_VERSION,
  WEEKEND_POLICY_VERSION,
  SESSION_POLICY_VERSION,
  TEMPORAL_GENERATION_SCHEMA_VERSION,
  TEMPORAL_TAXONOMY_VERSION,
  TEMPORAL_COST_MODEL_VERSION,
  TEMPORAL_HOURLY_PROFILE_VERSION,
  TEMPORAL_MARKET_WEATHER_PROFILE_VERSION,
  BTC_DIRECTION_ROUTER_PROFILE_VERSION,
  BTC_DIRECTION_ROUTER_POLICY_VERSION,
  BTC_ROUTER_STATES,
  BTC_ROUTER_SELECTABLE_STATES,
  TEMPORAL_DAY_BUCKETS,
  TEMPORAL_DAY_TYPE_BUCKETS,
  TEMPORAL_PRIMARY_SESSION_BUCKETS,
  TEMPORAL_HOUR_BUCKETS,
  TEMPORAL_MARKET_WEATHER_KEYS,
  temporalHourKey,
  temporalDayHourKey,
  temporalMarketWeatherKey,
  temporalDayWeatherKey,
  temporalHourWeatherKey,
  temporalDayHourWeatherKey,
  temporalBtcRouterKey,
  temporalMarketWeatherBtcKey,
  temporalDayBtcKey,
  temporalHourBtcKey,
  temporalDayHourBtcKey,
  temporalDayWeatherBtcKey,
  temporalHourWeatherBtcKey,
  temporalDayHourWeatherBtcKey,
  resolveEntryMarketWeatherContext,
  resolveEntryBtcRouterContext
} from './scoring.js';
import {
  WEEK_COMPOSITION_VERSION,
  WEEK_COMPOSITION_OPTIMIZER_VERSION,
  buildWeekCompositionProposals,
  applyWeekCompositionOverrides,
  validateWeekComposition,
  evaluateWeekCompositionSlot
} from './weekCompositionEngine.js';
import { sendWeeklyRotationReport } from '../discord/discord.js';


const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const TARGET_SCANNER_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';


const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';

const LARGE_DOCUMENT_STORAGE_SCHEMA = 'LONG_GZIP_CHUNKED_JSON_V1';
const LARGE_DOCUMENT_STORAGE_THRESHOLD_BYTES = 6_000_000;
const LARGE_DOCUMENT_CHUNK_CHAR_LIMIT = 2_500_000;
const LARGE_DOCUMENT_MAX_CHUNKS = 64;



const MEASUREMENT_FIX_VERSION =
  'LONG_MEASUREMENT_FIX_TRIGGER_BOUNDARY_EXIT_FILL_V2';


const EXIT_FILL_MODEL_VERSION =
  'LONG_TRIGGER_BOUNDARY_FILL_PLUS_COST_MODEL_V1';


const EMPIRICAL_VETO_POLICY_VERSION =
  'LONG_EXACT_75_CHILD_NET_EDGE_VETO_V1';




const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = TRUE_MICRO_SCHEMA;


const FALLBACK_MACRO_SCHEMA = 'MF_V1';
const FALLBACK_MICRO_SCHEMA = 'MF_V2';
const FALLBACK_TRUE_MICRO_SCHEMA = 'MF_V3';


const LEARNING_GRANULARITY =
'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_V1';


const EXECUTION_MICRO_SUFFIX = 'XR';


const ROTATION_SIDES = [TARGET_TRADE_SIDE];


const DEFAULT_TOP_N_PER_SIDE = 1;
const MAX_TOP_N_PER_SIDE = 160;
const DEFAULT_MIN_WEIGHTED_COMPLETED = 20;
const DEFAULT_EMPIRICAL_VETO_MIN_COMPLETED = 35;
const DEFAULT_EMPIRICAL_VETO_MAX_AVG_R = 0;
const EMPIRICAL_VETO_SCORE = -1_000_000;


const DEFAULT_MIN_PRIMARY_ROWS_FOR_PREVIOUS_MERGE = 25;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;


const DEFAULT_RECENT_MOMENTUM_LOOKBACK = 12;
const DEFAULT_STALE_WINNER_DAYS = 10;


const SETUP_TYPES = Object.freeze([
  'BREAKOUT',
  'RETEST',
  'SWEEP_REVERSAL',
  'CONTINUATION',
  'COMPRESSION'
]);


const REGIME_BUCKETS = Object.freeze([
  'TREND',
  'CHOP',
  'SQUEEZE'
]);


const CONFIRMATION_PROFILES = Object.freeze([
  'A_STRONG_ALIGN',
    'B_FLOW_ALIGN',
    'C_VOLUME_ALIGN',
    'D_MIXED_OK',
    'E_WEAK_CONTRA'
]);


const SETUP_SET = new Set(SETUP_TYPES);
const REGIME_SET = new Set(REGIME_BUCKETS);
const CONFIRMATION_SET = new Set(CONFIRMATION_PROFILES);


const MANUAL_ACTIVE_SOURCES = new Set([
    'ADMIN_MANUAL_SELECTION_LONG_TRUE_MICRO_ONLY',
    'ADMIN_MANUAL_SELECTION_LONG_75_CHILD_ONLY',
    'ADMIN_ACTIVATE_SELECTED_LONG_TRUE_MICROS',
    'ADMIN_ACTIVATE_SELECTED_LONG_75_CHILD_TRUE_MICROS',
    'ADMIN_ACTIVATE_TOP_LONG_TRUE_MICROS',
    'ADMIN_ACTIVATE_TOP_BALANCED_LONG_TRUE_MICROS',
    'CLI_MANUAL_SELECTION_LONG_ONLY',
    'CLI_MANUAL_LONG_MICRO_FAMILY_DISCORD_SELECTION'
]);


function now() {
    return Date.now();
}


const TEMPORAL_GENERATION_STATUSES = Object.freeze([
    'BUILDING',
    'INTEGRITY_CHECK_RUNNING',
    'READY',
    'ACTIVE',
    'SUPERSEDED',
    'INVALID',
    'ACTIVATION_WINDOW_EXPIRED'
]);
const TEMPORAL_ACTIVE_DECISIONS = Object.freeze([
    'INHERIT_GLOBAL',
    'NO_VETO',
    'VETO_ACTIVE',
    'CONFOUNDED_NO_VETO'
]);
const TEMPORAL_CANDIDATE_STATUSES = Object.freeze([
    'VETO_CANDIDATE',
    'RECOVERY_CANDIDATE',
    'CONFOUNDED_CANDIDATE',
    'WEEKEND_APPROVAL_CANDIDATE'
]);
const TEMPORAL_MAX_WINDOW_OUTCOMES = 50;
const TEMPORAL_MAX_WINDOW_AGE_DAYS = 180;
const TEMPORAL_GENERATION_MAX_AGE_DAYS = 14;
const TEMPORAL_WEEKEND_APPROVAL_MAX_OUTCOME_AGE_DAYS = 45;
const TEMPORAL_CANDIDATE_MAX_FREEZE_EVALUATIONS = 4;
const TEMPORAL_NORMAL_MIN_COMPLETED = 35;
const TEMPORAL_NORMAL_MAX_AVG_R = -0.10;
const TEMPORAL_RECOVERY_MIN_AVG_R = 0.05;
const TEMPORAL_WEEKEND_MIN_COMPLETED = 50;
const TEMPORAL_WEEKEND_MIN_AVG_R = 0.10;
const TEMPORAL_FDR_MAX_Q = 0.05;
const TEMPORAL_VETO_CONFIRMATION_NEW_OUTCOMES = 5;
const TEMPORAL_RECOVERY_MIN_NEW_SINCE_VETO = 10;
const TEMPORAL_RECOVERY_CONFIRMATION_NEW_OUTCOMES = 5;
const TEMPORAL_WEEKEND_CONFIRMATION_NEW_OUTCOMES = 10;
const TEMPORAL_FLOAT_TOLERANCE = 1e-9;
const TEMPORAL_MS_PER_DAY = 86_400_000;
const TEMPORAL_ACTIVATION_RETRY_MS = TEMPORAL_MS_PER_DAY;

function temporalFamilyIds() {
    const ids = [];
    for (const setupType of SETUP_TYPES) {
        for (const regimeBucket of REGIME_BUCKETS) {
            for (const confirmationProfile of CONFIRMATION_PROFILES) {
                ids.push(`MICRO_LONG_${setupType}_${regimeBucket}_${confirmationProfile}`);
            }
        }
    }
    return ids;
}

function temporalCanonicalize(value) {
    if (Array.isArray(value)) return value.map(temporalCanonicalize);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.keys(value)
            .sort()
            .filter((key) => key !== 'checksum' && key !== 'checksumVerified')
            .map((key) => [key, temporalCanonicalize(value[key])])
    );
}

function temporalChecksum(value) {
    return createHash('sha256')
        .update(JSON.stringify(temporalCanonicalize(value)))
        .digest('hex');
}

function temporalDeepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const nested of Object.values(value)) temporalDeepFreeze(nested);
    return value;
}

function temporalNonFinitePaths(value, path = '$', output = []) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
        output.push(path);
        return output;
    }
    if (Array.isArray(value)) {
        value.forEach((item, index) => temporalNonFinitePaths(item, `${path}[${index}]`, output));
        return output;
    }
    if (value && typeof value === 'object') {
        for (const [key, nested] of Object.entries(value)) {
            temporalNonFinitePaths(nested, `${path}.${key}`, output);
        }
    }
    return output;
}

async function temporalMapLimit(values = [], concurrency = 8, worker) {
    const rows = Array.isArray(values) ? values : [];
    const output = new Array(rows.length);
    let cursor = 0;
    async function runWorker() {
        while (true) {
            const index = cursor;
            cursor += 1;
            if (index >= rows.length) return;
            output[index] = await worker(rows[index], index);
        }
    }
    await Promise.all(
        Array.from(
            { length: Math.min(Math.max(1, concurrency), Math.max(1, rows.length)) },
            () => runWorker()
        )
    );
    return output;
}

function normalizeTemporalCutoffTs(value = now()) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return now();
    return numeric < 10_000_000_000 ? Math.floor(numeric * 1000) : Math.floor(numeric);
}

function nextMondayUtc(timestamp) {
    const date = new Date(normalizeTemporalCutoffTs(timestamp));
    const day = date.getUTCDay();
    const daysUntilMonday = day === 1 &&
        date.getUTCHours() === 0 &&
        date.getUTCMinutes() === 0 &&
        date.getUTCSeconds() === 0 &&
        date.getUTCMilliseconds() === 0
        ? 0
        : (8 - day) % 7 || 7;
    return Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate() + daysUntilMonday,
        0, 0, 0, 0
    );
}

function temporalActivationWindow(generationCutoffTs) {
    const startsAt = nextMondayUtc(generationCutoffTs);
    return {
        startsAt,
        expiresAt: startsAt + TEMPORAL_ACTIVATION_RETRY_MS
    };
}

function temporalFamilyStatsRow(micros = {}, familyId) {
    const direct = micros?.[familyId];
    if (direct && typeof direct === 'object') return direct;
    return Object.values(micros || {}).find((row) => rowId(row) === familyId) || null;
}

function temporalLifetimeIntegrity(row = {}) {
    if (!row || typeof row !== 'object') {
        return { passed: true, skipped: true, reason: 'NO_LIFETIME_STATS' };
    }
    const stats = ensureTemporalStats({ ...row });
    const axes = {
        dayType: Object.values(stats.dayTypeStats || {}),
        dayOfWeek: Object.values(stats.dayOfWeekStats || {}),
        session: Object.values(stats.sessionStats || {}),
        hourOfDay: Object.values(stats.hourOfDayStats || {}),
        dayHour: Object.values(stats.dayHourStats || {})
            .flatMap((day) => Object.values(day || {})),
        marketWeather: Object.values(stats.marketWeatherStats || {}),
        dayWeather: Object.values(stats.dayWeatherStats || {})
            .flatMap((day) => Object.values(day || {})),
        hourWeather: Object.values(stats.hourWeatherStats || {})
            .flatMap((hour) => Object.values(hour || {})),
        dayHourWeather: Object.values(stats.dayHourWeatherStats || {})
            .flatMap((day) => Object.values(day || {}))
            .flatMap((hour) => Object.values(hour || {}))
    };
    const summarize = (buckets) => ({
        completed: buckets.reduce((sum, bucket) => sum + safeNumber(bucket?.completed, 0), 0),
        observations: buckets.reduce((sum, bucket) => sum + safeNumber(bucket?.observations, 0), 0),
        sumNetR: buckets.reduce((sum, bucket) => sum + safeNumber(bucket?.sumNetR, 0), 0)
    });
    const totals = Object.fromEntries(
        Object.entries(axes).map(([axis, buckets]) => [axis, summarize(buckets)])
    );
    const completedEqual = totals.dayType.completed === totals.dayOfWeek.completed &&
        totals.dayType.completed === totals.session.completed &&
        totals.dayType.completed === totals.hourOfDay.completed &&
        totals.dayType.completed === totals.dayHour.completed &&
        totals.dayType.completed === totals.marketWeather.completed &&
        totals.dayType.completed === totals.dayWeather.completed &&
        totals.dayType.completed === totals.hourWeather.completed &&
        totals.dayType.completed === totals.dayHourWeather.completed;
    const observationsEqual = totals.dayType.observations === totals.dayOfWeek.observations &&
        totals.dayType.observations === totals.session.observations &&
        totals.dayType.observations === totals.hourOfDay.observations &&
        totals.dayType.observations === totals.dayHour.observations &&
        totals.dayType.observations === totals.marketWeather.observations &&
        totals.dayType.observations === totals.dayWeather.observations &&
        totals.dayType.observations === totals.hourWeather.observations &&
        totals.dayType.observations === totals.dayHourWeather.observations;
    const rEqual = Math.abs(totals.dayType.sumNetR - totals.dayOfWeek.sumNetR) <= TEMPORAL_FLOAT_TOLERANCE &&
        Math.abs(totals.dayType.sumNetR - totals.session.sumNetR) <= TEMPORAL_FLOAT_TOLERANCE &&
        Math.abs(totals.dayType.sumNetR - totals.hourOfDay.sumNetR) <= TEMPORAL_FLOAT_TOLERANCE &&
        Math.abs(totals.dayType.sumNetR - totals.dayHour.sumNetR) <= TEMPORAL_FLOAT_TOLERANCE &&
        Math.abs(totals.dayType.sumNetR - totals.marketWeather.sumNetR) <= TEMPORAL_FLOAT_TOLERANCE &&
        Math.abs(totals.dayType.sumNetR - totals.dayWeather.sumNetR) <= TEMPORAL_FLOAT_TOLERANCE &&
        Math.abs(totals.dayType.sumNetR - totals.hourWeather.sumNetR) <= TEMPORAL_FLOAT_TOLERANCE &&
        Math.abs(totals.dayType.sumNetR - totals.dayHourWeather.sumNetR) <= TEMPORAL_FLOAT_TOLERANCE;
    const sequenceCompatible = safeNumber(stats.acceptedTemporalOutcomeSeq, 0) === totals.dayType.completed;
    return {
        passed: completedEqual && observationsEqual && rEqual && sequenceCompatible,
        skipped: false,
        totals,
        acceptedTemporalOutcomeSeq: safeNumber(stats.acceptedTemporalOutcomeSeq, 0),
        checks: { completedEqual, observationsEqual, rEqual, sequenceCompatible }
    };
}

function priorTemporalGeneration(activeDocument = {}, pendingRotation = {}) {
    const candidates = [
        pendingRotation?.temporalGeneration,
        activeDocument?.activeTemporalGeneration
    ].filter((generation) => generation && typeof generation === 'object');
    return candidates.sort(
        (left, right) => safeNumber(right.freezeSequence, 0) - safeNumber(left.freezeSequence, 0)
    )[0] || null;
}

function temporalCandidateExpired(candidate, freezeSequence) {
    if (!candidate) return true;
    return safeNumber(freezeSequence, 0) - safeNumber(candidate.firstFreezeSequence, 0) >=
        TEMPORAL_CANDIDATE_MAX_FREEZE_EVALUATIONS;
}

function temporalEvidenceSnapshot(test = {}) {
    return {
        gateWindowCompleted: safeNumber(test.stats?.completed, 0),
        gateWindowAcceptedTemporalOutcomeSeq: safeNumber(
            test.stats?.acceptedTemporalOutcomeSeq,
            0
        ),
        avgNetR: safeNumber(test.stats?.avgNetR, 0),
        lcb95: safeNumber(test.stats?.lcb95, 0),
        ucb95: safeNumber(test.stats?.ucb95, 0),
        pValue: safeNumber(test.pValue, 1),
        qValue: safeNumber(test.qValue, 1),
        maturity: temporalGateMaturity(test.stats?.completed),
        diversityPassed: Boolean(test.diversity?.passed),
        confoundingPassed: test.confounding ? Boolean(test.confounding.passed) : null
    };
}

function transitionTemporalVeto({
    prior = {},
    negativeEvidence = false,
    negativeEvidenceBeforeConfounding = false,
    recoveryEvidence = false,
    stats = {},
    freezeSequence,
    cutoffTs
}) {
    const sequence = safeNumber(stats.acceptedTemporalOutcomeSeq, 0);
    const priorDecision = String(prior.activeDecision || prior.decision || 'NO_VETO');
    const priorCandidate = prior.candidate && typeof prior.candidate === 'object'
        ? prior.candidate
        : null;
    const activeVeto = priorDecision === 'VETO_ACTIVE';

    if (activeVeto) {
        const activatedSeq = safeNumber(
            prior.vetoActivatedOutcomeSeq ?? prior.activatedOutcomeSeq,
            sequence
        );
        const recoveryMature = sequence - activatedSeq >= TEMPORAL_RECOVERY_MIN_NEW_SINCE_VETO;
        if (recoveryEvidence && recoveryMature) {
            const reusable = priorCandidate?.type === 'RECOVERY_CANDIDATE' &&
                !temporalCandidateExpired(priorCandidate, freezeSequence);
            if (reusable &&
                sequence - safeNumber(priorCandidate.firstEvidenceOutcomeSeq, sequence) >=
                    TEMPORAL_RECOVERY_CONFIRMATION_NEW_OUTCOMES) {
                return {
                    activeDecision: 'NO_VETO',
                    evaluationStatus: 'NO_VETO',
                    candidate: null,
                    recoveredAtCutoffTs: cutoffTs,
                    recoveredAtFreezeSequence: freezeSequence,
                    recoveredAtOutcomeSeq: sequence,
                    previousVetoActivatedOutcomeSeq: activatedSeq
                };
            }
            return {
                ...prior,
                activeDecision: 'VETO_ACTIVE',
                evaluationStatus: 'RECOVERY_CANDIDATE',
                candidate: reusable
                    ? { ...priorCandidate, lastFreezeSequence: freezeSequence, lastEvidenceOutcomeSeq: sequence }
                    : {
                        type: 'RECOVERY_CANDIDATE',
                        firstFreezeSequence: freezeSequence,
                        lastFreezeSequence: freezeSequence,
                        firstEvidenceOutcomeSeq: sequence,
                        lastEvidenceOutcomeSeq: sequence,
                        expiresAfterFreezeSequence:
                            freezeSequence + TEMPORAL_CANDIDATE_MAX_FREEZE_EVALUATIONS - 1
                    }
            };
        }
        return {
            ...prior,
            activeDecision: 'VETO_ACTIVE',
            evaluationStatus: 'VETO_ACTIVE',
            candidate: null
        };
    }

    if (negativeEvidence) {
        const reusable = priorCandidate?.type === 'VETO_CANDIDATE' &&
            !temporalCandidateExpired(priorCandidate, freezeSequence);
        if (reusable &&
            sequence - safeNumber(priorCandidate.firstEvidenceOutcomeSeq, sequence) >=
                TEMPORAL_VETO_CONFIRMATION_NEW_OUTCOMES) {
            return {
                activeDecision: 'VETO_ACTIVE',
                evaluationStatus: 'VETO_ACTIVE',
                candidate: null,
                vetoActivatedAtCutoffTs: cutoffTs,
                vetoActivatedAtFreezeSequence: freezeSequence,
                vetoActivatedOutcomeSeq: sequence
            };
        }
        return {
            activeDecision: 'NO_VETO',
            evaluationStatus: 'VETO_CANDIDATE',
            candidate: reusable
                ? { ...priorCandidate, lastFreezeSequence: freezeSequence, lastEvidenceOutcomeSeq: sequence }
                : {
                    type: 'VETO_CANDIDATE',
                    firstFreezeSequence: freezeSequence,
                    lastFreezeSequence: freezeSequence,
                    firstEvidenceOutcomeSeq: sequence,
                    lastEvidenceOutcomeSeq: sequence,
                    expiresAfterFreezeSequence:
                        freezeSequence + TEMPORAL_CANDIDATE_MAX_FREEZE_EVALUATIONS - 1
                }
        };
    }

    if (negativeEvidenceBeforeConfounding) {
        return {
            activeDecision: 'CONFOUNDED_NO_VETO',
            evaluationStatus: 'CONFOUNDED_CANDIDATE',
            candidate: {
                type: 'CONFOUNDED_CANDIDATE',
                firstFreezeSequence: freezeSequence,
                lastFreezeSequence: freezeSequence,
                firstEvidenceOutcomeSeq: sequence,
                lastEvidenceOutcomeSeq: sequence,
                expiresAfterFreezeSequence: freezeSequence
            }
        };
    }

    return {
        activeDecision: 'NO_VETO',
        evaluationStatus: 'NO_VETO',
        candidate: null
    };
}

function transitionWeekendApproval({
    prior = {},
    approvalEvidence = false,
    blockedByDayVeto = false,
    stats = {},
    newestOutcomeTs = null,
    freezeSequence,
    cutoffTs
}) {
    const sequence = safeNumber(stats.acceptedTemporalOutcomeSeq, 0);
    const currentApproved = prior.approvalStatus === 'WEEKEND_APPROVED';
    const latestAgeDays = newestOutcomeTs
        ? (cutoffTs - newestOutcomeTs) / TEMPORAL_MS_PER_DAY
        : null;
    const remainsValid = approvalEvidence &&
        !blockedByDayVeto &&
        stats.completed === TEMPORAL_WEEKEND_MIN_COMPLETED &&
        Number.isFinite(latestAgeDays) &&
        latestAgeDays <= TEMPORAL_WEEKEND_APPROVAL_MAX_OUTCOME_AGE_DAYS;
    if (currentApproved && remainsValid) {
        return {
            ...prior,
            approvalStatus: 'WEEKEND_APPROVED',
            evaluationStatus: 'WEEKEND_APPROVED',
            candidate: null,
            latestSpecificWeekendOutcomeTs: newestOutcomeTs,
            latestSpecificWeekendOutcomeAgeDays: latestAgeDays
        };
    }
    if (!remainsValid) {
        return {
            approvalStatus: 'NO_APPROVAL',
            evaluationStatus: 'NO_APPROVAL',
            candidate: null,
            latestSpecificWeekendOutcomeTs: newestOutcomeTs,
            latestSpecificWeekendOutcomeAgeDays: latestAgeDays
        };
    }
    const candidate = prior.candidate?.type === 'WEEKEND_APPROVAL_CANDIDATE' &&
        !temporalCandidateExpired(prior.candidate, freezeSequence)
        ? prior.candidate
        : null;
    if (candidate &&
        sequence - safeNumber(candidate.firstEvidenceOutcomeSeq, sequence) >=
            TEMPORAL_WEEKEND_CONFIRMATION_NEW_OUTCOMES) {
        return {
            approvalStatus: 'WEEKEND_APPROVED',
            evaluationStatus: 'WEEKEND_APPROVED',
            candidate: null,
            approvedAtCutoffTs: cutoffTs,
            approvedAtFreezeSequence: freezeSequence,
            approvedAtOutcomeSeq: sequence,
            latestSpecificWeekendOutcomeTs: newestOutcomeTs,
            latestSpecificWeekendOutcomeAgeDays: latestAgeDays
        };
    }
    return {
        approvalStatus: 'NO_APPROVAL',
        evaluationStatus: 'WEEKEND_APPROVAL_CANDIDATE',
        candidate: candidate
            ? { ...candidate, lastFreezeSequence: freezeSequence, lastEvidenceOutcomeSeq: sequence }
            : {
                type: 'WEEKEND_APPROVAL_CANDIDATE',
                firstFreezeSequence: freezeSequence,
                lastFreezeSequence: freezeSequence,
                firstEvidenceOutcomeSeq: sequence,
                lastEvidenceOutcomeSeq: sequence,
                expiresAfterFreezeSequence:
                    freezeSequence + TEMPORAL_CANDIDATE_MAX_FREEZE_EVALUATIONS - 1
            },
        latestSpecificWeekendOutcomeTs: newestOutcomeTs,
        latestSpecificWeekendOutcomeAgeDays: latestAgeDays
    };
}

function temporalTestRecord({
    familyId,
    bucketType,
    bucketValue,
    members,
    broadAxis = null,
    weekend = false
}) {
    const stats = computeTemporalWindowStats(members);
    return {
        id: `${familyId}|${bucketType}|${bucketValue}`,
        familyId,
        bucketType,
        bucketValue,
        members,
        stats,
        diversity: evaluateTemporalDiversity(members, { weekend }),
        confounding: broadAxis
            ? evaluateTemporalConfounding(members, { broadAxis })
            : null,
        pValueNegative: temporalOneSidedPValue(stats, 'NEGATIVE'),
        pValuePositive: temporalOneSidedPValue(stats, 'POSITIVE')
    };
}

function groupPreparedTemporalRows(preparedRows = [], keyFactory) {
    const groups = new Map();
    for (const row of Array.isArray(preparedRows) ? preparedRows : []) {
        const key = String(keyFactory(row) || '').trim().toUpperCase();
        if (!key) continue;
        const members = groups.get(key) || [];
        if (members.length < TEMPORAL_MAX_WINDOW_OUTCOMES) members.push(row);
        groups.set(key, members);
    }
    return groups;
}

function descriptiveTemporalRecord({ bucketType, bucketValue, members = [] } = {}) {
    return {
        bucketType,
        bucketValue,
        members,
        stats: computeTemporalWindowStats(members),
        diversity: evaluateTemporalDiversity(members, { hourly: true })
    };
}

function buildSparseWeatherTests(preparedRows = []) {
    const weatherGroups = groupPreparedTemporalRows(
        preparedRows,
        (row) => temporalMarketWeatherKey(row.entryMarketWeatherKey)
    );
    const dayWeatherGroups = groupPreparedTemporalRows(
        preparedRows,
        (row) => temporalDayWeatherKey(row.entryDayOfWeekUtc, row.entryMarketWeatherKey)
    );
    const hourWeatherGroups = groupPreparedTemporalRows(
        preparedRows,
        (row) => temporalHourWeatherKey(row.entryHourUtc, row.entryMarketWeatherKey)
    );
    const dayHourWeatherGroups = groupPreparedTemporalRows(
        preparedRows,
        (row) => temporalDayHourWeatherKey(
            row.entryDayOfWeekUtc,
            row.entryHourUtc,
            row.entryMarketWeatherKey
        )
    );
    const btcGroups = groupPreparedTemporalRows(
        preparedRows,
        (row) => temporalBtcRouterKey(row.entryBtcRouterState)
    );
    const marketWeatherBtcGroups = groupPreparedTemporalRows(
        preparedRows,
        (row) => temporalMarketWeatherBtcKey(
            row.entryMarketWeatherKey,
            row.entryBtcRouterState
        )
    );
    const dayBtcGroups = groupPreparedTemporalRows(
        preparedRows,
        (row) => temporalDayBtcKey(row.entryDayOfWeekUtc, row.entryBtcRouterState)
    );
    const hourBtcGroups = groupPreparedTemporalRows(
        preparedRows,
        (row) => temporalHourBtcKey(row.entryHourUtc, row.entryBtcRouterState)
    );
    const dayHourBtcGroups = groupPreparedTemporalRows(
        preparedRows,
        (row) => temporalDayHourBtcKey(
            row.entryDayOfWeekUtc,
            row.entryHourUtc,
            row.entryBtcRouterState
        )
    );
    const dayWeatherBtcGroups = groupPreparedTemporalRows(
        preparedRows,
        (row) => temporalDayWeatherBtcKey(
            row.entryDayOfWeekUtc,
            row.entryMarketWeatherKey,
            row.entryBtcRouterState
        )
    );
    const hourWeatherBtcGroups = groupPreparedTemporalRows(
        preparedRows,
        (row) => temporalHourWeatherBtcKey(
            row.entryHourUtc,
            row.entryMarketWeatherKey,
            row.entryBtcRouterState
        )
    );
    const dayHourWeatherBtcGroups = groupPreparedTemporalRows(
        preparedRows,
        (row) => temporalDayHourWeatherBtcKey(
            row.entryDayOfWeekUtc,
            row.entryHourUtc,
            row.entryMarketWeatherKey,
            row.entryBtcRouterState
        )
    );

    const weatherBtcObject = (groups, keyFactory) => Object.fromEntries(
        TEMPORAL_MARKET_WEATHER_KEYS.map((weatherKey) => [
            weatherKey,
            Object.fromEntries(
                BTC_ROUTER_STATES
                    .map((btcState) => {
                        const key = keyFactory(weatherKey, btcState);
                        const members = groups.get(key);
                        return members
                            ? [btcState, descriptiveTemporalRecord({
                                bucketType: 'marketWeatherBtc',
                                bucketValue: key,
                                members
                            })]
                            : null;
                    })
                    .filter(Boolean)
            )
        ])
    );

    return {
        marketWeatherTests: Object.fromEntries(
            [...weatherGroups.entries()].map(([key, members]) => [
                key,
                descriptiveTemporalRecord({
                    bucketType: 'marketWeather',
                    bucketValue: key,
                    members
                })
            ])
        ),
        dayWeatherTests: Object.fromEntries(
            TEMPORAL_DAY_BUCKETS.map((day) => [
                day,
                Object.fromEntries(
                    TEMPORAL_MARKET_WEATHER_KEYS
                        .map((weatherKey) => {
                            const key = temporalDayWeatherKey(day, weatherKey);
                            const members = dayWeatherGroups.get(key);
                            return members
                                ? [weatherKey, descriptiveTemporalRecord({
                                    bucketType: 'dayWeather',
                                    bucketValue: key,
                                    members
                                })]
                                : null;
                        })
                        .filter(Boolean)
                )
            ])
        ),
        hourWeatherTests: Object.fromEntries(
            TEMPORAL_HOUR_BUCKETS.map((hourBucket) => [
                hourBucket,
                Object.fromEntries(
                    TEMPORAL_MARKET_WEATHER_KEYS
                        .map((weatherKey) => {
                            const key = `${hourBucket}|${weatherKey}`;
                            const members = hourWeatherGroups.get(key);
                            return members
                                ? [weatherKey, descriptiveTemporalRecord({
                                    bucketType: 'hourWeather',
                                    bucketValue: key,
                                    members
                                })]
                                : null;
                        })
                        .filter(Boolean)
                )
            ])
        ),
        dayHourWeatherTests: Object.fromEntries(
            TEMPORAL_DAY_BUCKETS.map((day) => [
                day,
                Object.fromEntries(
                    TEMPORAL_HOUR_BUCKETS.map((hourBucket) => [
                        hourBucket,
                        Object.fromEntries(
                            TEMPORAL_MARKET_WEATHER_KEYS
                                .map((weatherKey) => {
                                    const key = `${day}:${hourBucket}|${weatherKey}`;
                                    const members = dayHourWeatherGroups.get(key);
                                    return members
                                        ? [weatherKey, descriptiveTemporalRecord({
                                            bucketType: 'dayHourWeather',
                                            bucketValue: key,
                                            members
                                        })]
                                        : null;
                                })
                                .filter(Boolean)
                        )
                    ])
                )
            ])
        ),
        btcRouterTests: Object.fromEntries(
            BTC_ROUTER_STATES
                .map((btcState) => {
                    const members = btcGroups.get(btcState);
                    return members
                        ? [btcState, descriptiveTemporalRecord({
                            bucketType: 'btcRouter',
                            bucketValue: btcState,
                            members
                        })]
                        : null;
                })
                .filter(Boolean)
        ),
        marketWeatherBtcTests: weatherBtcObject(
            marketWeatherBtcGroups,
            (weatherKey, btcState) => temporalMarketWeatherBtcKey(weatherKey, btcState)
        ),
        dayBtcTests: Object.fromEntries(
            TEMPORAL_DAY_BUCKETS.map((day) => [
                day,
                Object.fromEntries(
                    BTC_ROUTER_STATES
                        .map((btcState) => {
                            const key = temporalDayBtcKey(day, btcState);
                            const members = dayBtcGroups.get(key);
                            return members
                                ? [btcState, descriptiveTemporalRecord({
                                    bucketType: 'dayBtc',
                                    bucketValue: key,
                                    members
                                })]
                                : null;
                        })
                        .filter(Boolean)
                )
            ])
        ),
        hourBtcTests: Object.fromEntries(
            TEMPORAL_HOUR_BUCKETS.map((hourBucket) => [
                hourBucket,
                Object.fromEntries(
                    BTC_ROUTER_STATES
                        .map((btcState) => {
                            const key = `${hourBucket}|BTC:${btcState}`;
                            const members = hourBtcGroups.get(key);
                            return members
                                ? [btcState, descriptiveTemporalRecord({
                                    bucketType: 'hourBtc',
                                    bucketValue: key,
                                    members
                                })]
                                : null;
                        })
                        .filter(Boolean)
                )
            ])
        ),
        dayHourBtcTests: Object.fromEntries(
            TEMPORAL_DAY_BUCKETS.map((day) => [
                day,
                Object.fromEntries(
                    TEMPORAL_HOUR_BUCKETS.map((hourBucket) => [
                        hourBucket,
                        Object.fromEntries(
                            BTC_ROUTER_STATES
                                .map((btcState) => {
                                    const key = `${day}:${hourBucket}|BTC:${btcState}`;
                                    const members = dayHourBtcGroups.get(key);
                                    return members
                                        ? [btcState, descriptiveTemporalRecord({
                                            bucketType: 'dayHourBtc',
                                            bucketValue: key,
                                            members
                                        })]
                                        : null;
                                })
                                .filter(Boolean)
                        )
                    ])
                )
            ])
        ),
        dayWeatherBtcTests: Object.fromEntries(
            TEMPORAL_DAY_BUCKETS.map((day) => [
                day,
                Object.fromEntries(
                    TEMPORAL_MARKET_WEATHER_KEYS.map((weatherKey) => [
                        weatherKey,
                        Object.fromEntries(
                            BTC_ROUTER_STATES
                                .map((btcState) => {
                                    const key = temporalDayWeatherBtcKey(day, weatherKey, btcState);
                                    const members = dayWeatherBtcGroups.get(key);
                                    return members
                                        ? [btcState, descriptiveTemporalRecord({
                                            bucketType: 'dayWeatherBtc',
                                            bucketValue: key,
                                            members
                                        })]
                                        : null;
                                })
                                .filter(Boolean)
                        )
                    ])
                )
            ])
        ),
        hourWeatherBtcTests: Object.fromEntries(
            TEMPORAL_HOUR_BUCKETS.map((hourBucket) => [
                hourBucket,
                Object.fromEntries(
                    TEMPORAL_MARKET_WEATHER_KEYS.map((weatherKey) => [
                        weatherKey,
                        Object.fromEntries(
                            BTC_ROUTER_STATES
                                .map((btcState) => {
                                    const key = `${hourBucket}|${weatherKey}|BTC:${btcState}`;
                                    const members = hourWeatherBtcGroups.get(key);
                                    return members
                                        ? [btcState, descriptiveTemporalRecord({
                                            bucketType: 'hourWeatherBtc',
                                            bucketValue: key,
                                            members
                                        })]
                                        : null;
                                })
                                .filter(Boolean)
                        )
                    ])
                )
            ])
        ),
        dayHourWeatherBtcTests: Object.fromEntries(
            TEMPORAL_DAY_BUCKETS.map((day) => [
                day,
                Object.fromEntries(
                    TEMPORAL_HOUR_BUCKETS.map((hourBucket) => [
                        hourBucket,
                        Object.fromEntries(
                            TEMPORAL_MARKET_WEATHER_KEYS.map((weatherKey) => [
                                weatherKey,
                                Object.fromEntries(
                                    BTC_ROUTER_STATES
                                        .map((btcState) => {
                                            const key = `${day}:${hourBucket}|${weatherKey}|BTC:${btcState}`;
                                            const members = dayHourWeatherBtcGroups.get(key);
                                            return members
                                                ? [btcState, descriptiveTemporalRecord({
                                                    bucketType: 'dayHourWeatherBtc',
                                                    bucketValue: key,
                                                    members
                                                })]
                                                : null;
                                        })
                                        .filter(Boolean)
                                )
                            ])
                        )
                    ])
                )
            ])
        )
    };
}

function applyBhResults(records, direction) {
    const adjusted = benjaminiHochberg(records.map((record) => ({
        id: record.id,
        pValue: direction === 'NEGATIVE'
            ? record.pValueNegative
            : record.pValuePositive
    })));
    const byId = new Map(adjusted.map((row) => [row.id, row]));
    for (const record of records) {
        const result = byId.get(record.id) || { pValue: 1, qValue: 1 };
        record.pValue = result.pValue;
        record.qValue = result.qValue;
        record.bhRank = result.bhRank;
        record.bhBatchSize = result.bhBatchSize;
    }
}

function projectionPreviousBucket(priorProjection, type, bucket) {
    if (type === 'day') return priorProjection?.dayProfiles?.[bucket] || {};
    if (type === 'session') return priorProjection?.sessionProfiles?.[bucket] || {};
    if (type === 'weekend') return priorProjection?.weekendApprovals?.[bucket] || {};
    return {};
}

function temporalGenerationManifestBase({ cutoffTs, freezeSequence, familyCount }) {
    const activationWindow = temporalActivationWindow(cutoffTs);
    return {
        generationId: null,
        side: TARGET_TRADE_SIDE,
        dashboardSide: TARGET_DASHBOARD_SIDE,
        generationCutoffTs: cutoffTs,
        temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
        temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
        weekendPolicyVersion: WEEKEND_POLICY_VERSION,
        sessionPolicyVersion: SESSION_POLICY_VERSION,
        measurementVersion: MEASUREMENT_FIX_VERSION,
        costModelVersion: TEMPORAL_COST_MODEL_VERSION,
        taxonomyVersion: TEMPORAL_TAXONOMY_VERSION,
        generationSchemaVersion: TEMPORAL_GENERATION_SCHEMA_VERSION,
        temporalHourlyProfileVersion: TEMPORAL_HOURLY_PROFILE_VERSION,
        temporalMarketWeatherProfileVersion: TEMPORAL_MARKET_WEATHER_PROFILE_VERSION,
        temporalMarketWeatherKeys: TEMPORAL_MARKET_WEATHER_KEYS,
        btcDirectionRouterProfileVersion: BTC_DIRECTION_ROUTER_PROFILE_VERSION,
        btcDirectionRouterPolicyVersion: BTC_DIRECTION_ROUTER_POLICY_VERSION,
        btcRouterStates: BTC_ROUTER_STATES,
        btcRouterSelectableStates: BTC_ROUTER_SELECTABLE_STATES,
        weekCompositionVersion: WEEK_COMPOSITION_VERSION,
        weekCompositionOptimizerVersion: WEEK_COMPOSITION_OPTIMIZER_VERSION,
        familyCount,
        freezeSequence,
        activationScheduledAt: activationWindow.startsAt,
        activationWindowExpiresAt: activationWindow.expiresAt,
        createdAt: now()
    };
}

async function buildTemporalGeneration({
    micros = {},
    cutoffTs = now(),
    freezeSequence = 1,
    previousGeneration = null
} = {}) {
    const normalizedCutoffTs = normalizeTemporalCutoffTs(cutoffTs);
    const familyIds = temporalFamilyIds();
    const previousProjectionMap = new Map(
        (previousGeneration?.familyProjections || [])
            .map((projection) => [projection.familyId, projection])
    );
    const histories = await temporalMapLimit(familyIds, 8, async (familyId) => ({
        familyId,
        rows: await getMicroOutcomeHistory(familyId).catch(() => [])
    }));
    const duplicateCanonicalOwners = new Map();
    const duplicateCanonicalOutcomeIds = new Set();
    for (const history of histories) {
        for (const row of history.rows) {
            const canonicalId = String(row?.canonicalOutcomeId || row?.canonicalPositionId || '').trim();
            if (!canonicalId) continue;
            const owner = duplicateCanonicalOwners.get(canonicalId);
            if (owner && owner !== history.familyId) duplicateCanonicalOutcomeIds.add(canonicalId);
            else duplicateCanonicalOwners.set(canonicalId, history.familyId);
        }
    }

    const familyWork = histories.map(({ familyId, rows }) => {
        const preparedRows = prepareTemporalOutcomePool(rows, {
            familyId,
            cutoffTs: normalizedCutoffTs,
            maxAgeDays: TEMPORAL_MAX_WINDOW_AGE_DAYS
        });
        const dayTests = Object.fromEntries(TEMPORAL_DAY_BUCKETS.map((bucket) => {
            const members = buildTemporalGateWindowFromPrepared(preparedRows, {
                bucketType: 'dayOfWeek',
                bucketValue: bucket,
                maxOutcomes: TEMPORAL_MAX_WINDOW_OUTCOMES
            });
            return [bucket, temporalTestRecord({
                familyId,
                bucketType: 'dayOfWeek',
                bucketValue: bucket,
                members,
                broadAxis: 'DAY'
            })];
        }));
        const sessionTests = Object.fromEntries(TEMPORAL_PRIMARY_SESSION_BUCKETS.map((bucket) => {
            const members = buildTemporalGateWindowFromPrepared(preparedRows, {
                bucketType: 'session',
                bucketValue: bucket,
                maxOutcomes: TEMPORAL_MAX_WINDOW_OUTCOMES
            });
            return [bucket, temporalTestRecord({
                familyId,
                bucketType: 'session',
                bucketValue: bucket,
                members,
                broadAxis: 'SESSION'
            })];
        }));
        const dayTypeProfiles = Object.fromEntries(TEMPORAL_DAY_TYPE_BUCKETS.map((bucket) => {
            const members = buildTemporalGateWindowFromPrepared(preparedRows, {
                bucketType: 'dayType',
                bucketValue: bucket,
                maxOutcomes: TEMPORAL_MAX_WINDOW_OUTCOMES
            });
            return [bucket, {
                bucketType: 'dayType',
                bucketValue: bucket,
                gateWindow: computeTemporalWindowStats(members),
                maturity: temporalGateMaturity(members.length),
                descriptiveOnly: true,
                normalVetoTestDisabled: true
            }];
        }));
        const hourTests = Object.fromEntries(TEMPORAL_HOUR_BUCKETS.map((bucket) => {
            const members = buildTemporalGateWindowFromPrepared(preparedRows, {
                bucketType: 'hourOfDay',
                bucketValue: bucket,
                maxOutcomes: TEMPORAL_MAX_WINDOW_OUTCOMES
            });
            return [bucket, {
                bucketType: 'hourOfDay',
                bucketValue: bucket,
                members,
                stats: computeTemporalWindowStats(members),
                diversity: evaluateTemporalDiversity(members, { hourly: true })
            }];
        }));
        const dayHourTests = Object.fromEntries(TEMPORAL_DAY_BUCKETS.map((day) => [
            day,
            Object.fromEntries(TEMPORAL_HOUR_BUCKETS.map((hourBucket) => {
                const bucketValue = `${day}:${hourBucket}`;
                const members = buildTemporalGateWindowFromPrepared(preparedRows, {
                    bucketType: 'dayHour',
                    bucketValue,
                    maxOutcomes: TEMPORAL_MAX_WINDOW_OUTCOMES
                });
                return [hourBucket, {
                    bucketType: 'dayHour',
                    bucketValue,
                    dayOfWeekUtc: day,
                    hourBucket,
                    hourUtc: Number(hourBucket.slice(1)),
                    members,
                    stats: computeTemporalWindowStats(members),
                    diversity: evaluateTemporalDiversity(members, { hourly: true })
                }];
            }))
        ]));
        const weatherTests = buildSparseWeatherTests(preparedRows);
        return {
            familyId,
            rows,
            preparedRows,
            dayTests,
            sessionTests,
            hourTests,
            dayHourTests,
            ...weatherTests,
            dayTypeProfiles,
            previousProjection: previousProjectionMap.get(familyId) || null,
            lifetimeIntegrity: temporalLifetimeIntegrity(temporalFamilyStatsRow(micros, familyId))
        };
    });

    const negativeRecords = familyWork.flatMap((work) => [
        ...Object.values(work.dayTests),
        ...Object.values(work.sessionTests)
    ]);
    applyBhResults(negativeRecords, 'NEGATIVE');

    const recoveryRecords = negativeRecords.filter((record) => {
        const prior = record.bucketType === 'dayOfWeek'
            ? projectionPreviousBucket(
                previousProjectionMap.get(record.familyId),
                'day',
                record.bucketValue
            )
            : projectionPreviousBucket(
                previousProjectionMap.get(record.familyId),
                'session',
                record.bucketValue
            );
        return prior.activeDecision === 'VETO_ACTIVE';
    });
    applyBhResults(recoveryRecords, 'POSITIVE');

    const weekendRecords = familyWork.flatMap((work) => ['SATURDAY', 'SUNDAY'].map((bucket) => {
        const original = work.dayTests[bucket];
        return {
            ...original,
            id: `${work.familyId}|weekendApproval|${bucket}`,
            diversity: evaluateTemporalDiversity(original.members, { weekend: true })
        };
    }));
    applyBhResults(weekendRecords, 'POSITIVE');
    const weekendById = new Map(weekendRecords.map((record) => [record.id, record]));

    const projections = familyWork.map((work) => {
        const dayProfiles = {};
        for (const bucket of TEMPORAL_DAY_BUCKETS) {
            const test = work.dayTests[bucket];
            const prior = projectionPreviousBucket(work.previousProjection, 'day', bucket);
            const negativeBeforeConfounding = test.stats.completed >= TEMPORAL_NORMAL_MIN_COMPLETED &&
                test.stats.avgNetR <= TEMPORAL_NORMAL_MAX_AVG_R &&
                test.stats.ucb95 < 0 &&
                test.qValue <= TEMPORAL_FDR_MAX_Q &&
                test.diversity.passed;
            const negativeEvidence = negativeBeforeConfounding && test.confounding.passed;
            const recoveryRecord = recoveryRecords.find((record) => record.id === test.id);
            const recoveryEvidence = Boolean(recoveryRecord) &&
                recoveryRecord.stats.avgNetR >= TEMPORAL_RECOVERY_MIN_AVG_R &&
                recoveryRecord.stats.lcb95 > 0 &&
                recoveryRecord.qValue <= TEMPORAL_FDR_MAX_Q &&
                recoveryRecord.diversity.passed;
            const transition = transitionTemporalVeto({
                prior,
                negativeEvidence,
                negativeEvidenceBeforeConfounding: negativeBeforeConfounding,
                recoveryEvidence,
                stats: test.stats,
                freezeSequence,
                cutoffTs: normalizedCutoffTs
            });
            dayProfiles[bucket] = {
                bucketType: 'dayOfWeek',
                bucketValue: bucket,
                gateWindow: test.stats,
                maturity: temporalGateMaturity(test.stats.completed),
                diversity: test.diversity,
                confounding: test.confounding,
                negativeTest: temporalEvidenceSnapshot(test),
                recoveryTest: recoveryRecord ? temporalEvidenceSnapshot(recoveryRecord) : null,
                ...transition
            };
        }

        const sessionProfiles = {};
        for (const bucket of TEMPORAL_PRIMARY_SESSION_BUCKETS) {
            const test = work.sessionTests[bucket];
            const prior = projectionPreviousBucket(work.previousProjection, 'session', bucket);
            const negativeBeforeConfounding = test.stats.completed >= TEMPORAL_NORMAL_MIN_COMPLETED &&
                test.stats.avgNetR <= TEMPORAL_NORMAL_MAX_AVG_R &&
                test.stats.ucb95 < 0 &&
                test.qValue <= TEMPORAL_FDR_MAX_Q &&
                test.diversity.passed;
            const negativeEvidence = negativeBeforeConfounding && test.confounding.passed;
            const recoveryRecord = recoveryRecords.find((record) => record.id === test.id);
            const recoveryEvidence = Boolean(recoveryRecord) &&
                recoveryRecord.stats.avgNetR >= TEMPORAL_RECOVERY_MIN_AVG_R &&
                recoveryRecord.stats.lcb95 > 0 &&
                recoveryRecord.qValue <= TEMPORAL_FDR_MAX_Q &&
                recoveryRecord.diversity.passed;
            const transition = transitionTemporalVeto({
                prior,
                negativeEvidence,
                negativeEvidenceBeforeConfounding: negativeBeforeConfounding,
                recoveryEvidence,
                stats: test.stats,
                freezeSequence,
                cutoffTs: normalizedCutoffTs
            });
            sessionProfiles[bucket] = {
                bucketType: 'session',
                bucketValue: bucket,
                gateWindow: test.stats,
                maturity: temporalGateMaturity(test.stats.completed),
                diversity: test.diversity,
                confounding: test.confounding,
                negativeTest: temporalEvidenceSnapshot(test),
                recoveryTest: recoveryRecord ? temporalEvidenceSnapshot(recoveryRecord) : null,
                ...transition
            };
        }

        const weekendApprovals = {};
        for (const bucket of ['SATURDAY', 'SUNDAY']) {
            const test = weekendById.get(`${work.familyId}|weekendApproval|${bucket}`);
            const prior = projectionPreviousBucket(work.previousProjection, 'weekend', bucket);
            const dayVeto = dayProfiles[bucket]?.activeDecision === 'VETO_ACTIVE';
            const approvalEvidence = test.stats.completed === TEMPORAL_WEEKEND_MIN_COMPLETED &&
                test.stats.avgNetR >= TEMPORAL_WEEKEND_MIN_AVG_R &&
                test.stats.lcb95 > 0 &&
                test.qValue <= TEMPORAL_FDR_MAX_Q &&
                test.diversity.passed;
            const newestOutcomeTs = test.members.reduce(
                (max, row) => Math.max(max, safeNumber(row.outcomePersistedTs, 0)),
                0
            ) || null;
            weekendApprovals[bucket] = {
                bucketType: 'weekendApproval',
                bucketValue: bucket,
                gateWindow: test.stats,
                maturity: temporalGateMaturity(test.stats.completed),
                diversity: test.diversity,
                positiveTest: temporalEvidenceSnapshot(test),
                ...transitionWeekendApproval({
                    prior,
                    approvalEvidence,
                    blockedByDayVeto: dayVeto,
                    stats: test.stats,
                    newestOutcomeTs,
                    freezeSequence,
                    cutoffTs: normalizedCutoffTs
                })
            };
        }

        const hourProfiles = Object.fromEntries(
            TEMPORAL_HOUR_BUCKETS.map((bucket) => {
                const test = work.hourTests[bucket];
                return [bucket, {
                    bucketType: 'hourOfDay',
                    bucketValue: bucket,
                    hourUtc: Number(bucket.slice(1)),
                    gateWindow: test.stats,
                    maturity: temporalGateMaturity(test.stats.completed),
                    diversity: test.diversity,
                    descriptiveOnly: true,
                    optimizerEvidence: true
                }];
            })
        );
        const dayHourProfiles = Object.fromEntries(
            TEMPORAL_DAY_BUCKETS.map((day) => [
                day,
                Object.fromEntries(TEMPORAL_HOUR_BUCKETS.map((hourBucket) => {
                    const test = work.dayHourTests[day][hourBucket];
                    return [hourBucket, {
                        bucketType: 'dayHour',
                        bucketValue: `${day}:${hourBucket}`,
                        dayOfWeekUtc: day,
                        hourUtc: Number(hourBucket.slice(1)),
                        hourBucket,
                        gateWindow: test.stats,
                        maturity: temporalGateMaturity(test.stats.completed),
                        diversity: test.diversity,
                        descriptiveOnly: true,
                        optimizerEvidence: true
                    }];
                }))
            ])
        );
        const marketWeatherProfiles = Object.fromEntries(
            Object.entries(work.marketWeatherTests || {}).map(([weatherKey, test]) => [
                weatherKey,
                {
                    bucketType: 'marketWeather',
                    bucketValue: weatherKey,
                    marketWeatherKey: weatherKey,
                    gateWindow: test.stats,
                    maturity: temporalGateMaturity(test.stats.completed),
                    diversity: test.diversity,
                    descriptiveOnly: true,
                    optimizerEvidence: true
                }
            ])
        );
        const dayWeatherProfiles = Object.fromEntries(
            TEMPORAL_DAY_BUCKETS.map((day) => [
                day,
                Object.fromEntries(
                    Object.entries(work.dayWeatherTests?.[day] || {}).map(([weatherKey, test]) => [
                        weatherKey,
                        {
                            bucketType: 'dayWeather',
                            bucketValue: `${day}|${weatherKey}`,
                            dayOfWeekUtc: day,
                            marketWeatherKey: weatherKey,
                            gateWindow: test.stats,
                            maturity: temporalGateMaturity(test.stats.completed),
                            diversity: test.diversity,
                            descriptiveOnly: true,
                            optimizerEvidence: true
                        }
                    ])
                )
            ])
        );
        const hourWeatherProfiles = Object.fromEntries(
            TEMPORAL_HOUR_BUCKETS.map((hourBucket) => [
                hourBucket,
                Object.fromEntries(
                    Object.entries(work.hourWeatherTests?.[hourBucket] || {}).map(([weatherKey, test]) => [
                        weatherKey,
                        {
                            bucketType: 'hourWeather',
                            bucketValue: `${hourBucket}|${weatherKey}`,
                            hourUtc: Number(hourBucket.slice(1)),
                            hourBucket,
                            marketWeatherKey: weatherKey,
                            gateWindow: test.stats,
                            maturity: temporalGateMaturity(test.stats.completed),
                            diversity: test.diversity,
                            descriptiveOnly: true,
                            optimizerEvidence: true
                        }
                    ])
                )
            ])
        );
        const dayHourWeatherProfiles = Object.fromEntries(
            TEMPORAL_DAY_BUCKETS.map((day) => [
                day,
                Object.fromEntries(
                    TEMPORAL_HOUR_BUCKETS.map((hourBucket) => [
                        hourBucket,
                        Object.fromEntries(
                            Object.entries(work.dayHourWeatherTests?.[day]?.[hourBucket] || {})
                                .map(([weatherKey, test]) => [
                                    weatherKey,
                                    {
                                        bucketType: 'dayHourWeather',
                                        bucketValue: `${day}:${hourBucket}|${weatherKey}`,
                                        dayOfWeekUtc: day,
                                        hourUtc: Number(hourBucket.slice(1)),
                                        hourBucket,
                                        marketWeatherKey: weatherKey,
                                        gateWindow: test.stats,
                                        maturity: temporalGateMaturity(test.stats.completed),
                                        diversity: test.diversity,
                                        descriptiveOnly: true,
                                        optimizerEvidence: true
                                    }
                                ])
                        )
                    ])
                )
            ])
        );

        const btcRouterProfiles = Object.fromEntries(
            Object.entries(work.btcRouterTests || {}).map(([btcState, test]) => [
                btcState,
                {
                    bucketType: 'btcRouter',
                    bucketValue: btcState,
                    btcRouterState: btcState,
                    gateWindow: test.stats,
                    maturity: temporalGateMaturity(test.stats.completed),
                    diversity: test.diversity,
                    descriptiveOnly: true,
                    optimizerEvidence: true
                }
            ])
        );
        const marketWeatherBtcProfiles = Object.fromEntries(
            TEMPORAL_MARKET_WEATHER_KEYS.map((weatherKey) => [
                weatherKey,
                Object.fromEntries(
                    Object.entries(work.marketWeatherBtcTests?.[weatherKey] || {})
                        .map(([btcState, test]) => [btcState, {
                            bucketType: 'marketWeatherBtc',
                            bucketValue: `${weatherKey}|BTC:${btcState}`,
                            marketWeatherKey: weatherKey,
                            btcRouterState: btcState,
                            gateWindow: test.stats,
                            maturity: temporalGateMaturity(test.stats.completed),
                            diversity: test.diversity,
                            descriptiveOnly: true,
                            optimizerEvidence: true
                        }])
                )
            ])
        );
        const dayBtcProfiles = Object.fromEntries(
            TEMPORAL_DAY_BUCKETS.map((day) => [
                day,
                Object.fromEntries(
                    Object.entries(work.dayBtcTests?.[day] || {})
                        .map(([btcState, test]) => [btcState, {
                            bucketType: 'dayBtc',
                            bucketValue: `${day}|BTC:${btcState}`,
                            dayOfWeekUtc: day,
                            btcRouterState: btcState,
                            gateWindow: test.stats,
                            maturity: temporalGateMaturity(test.stats.completed),
                            diversity: test.diversity,
                            descriptiveOnly: true,
                            optimizerEvidence: true
                        }])
                )
            ])
        );
        const hourBtcProfiles = Object.fromEntries(
            TEMPORAL_HOUR_BUCKETS.map((hourBucket) => [
                hourBucket,
                Object.fromEntries(
                    Object.entries(work.hourBtcTests?.[hourBucket] || {})
                        .map(([btcState, test]) => [btcState, {
                            bucketType: 'hourBtc',
                            bucketValue: `${hourBucket}|BTC:${btcState}`,
                            hourUtc: Number(hourBucket.slice(1)),
                            hourBucket,
                            btcRouterState: btcState,
                            gateWindow: test.stats,
                            maturity: temporalGateMaturity(test.stats.completed),
                            diversity: test.diversity,
                            descriptiveOnly: true,
                            optimizerEvidence: true
                        }])
                )
            ])
        );
        const dayHourBtcProfiles = Object.fromEntries(
            TEMPORAL_DAY_BUCKETS.map((day) => [
                day,
                Object.fromEntries(
                    TEMPORAL_HOUR_BUCKETS.map((hourBucket) => [
                        hourBucket,
                        Object.fromEntries(
                            Object.entries(work.dayHourBtcTests?.[day]?.[hourBucket] || {})
                                .map(([btcState, test]) => [btcState, {
                                    bucketType: 'dayHourBtc',
                                    bucketValue: `${day}:${hourBucket}|BTC:${btcState}`,
                                    dayOfWeekUtc: day,
                                    hourUtc: Number(hourBucket.slice(1)),
                                    hourBucket,
                                    btcRouterState: btcState,
                                    gateWindow: test.stats,
                                    maturity: temporalGateMaturity(test.stats.completed),
                                    diversity: test.diversity,
                                    descriptiveOnly: true,
                                    optimizerEvidence: true
                                }])
                        )
                    ])
                )
            ])
        );
        const dayWeatherBtcProfiles = Object.fromEntries(
            TEMPORAL_DAY_BUCKETS.map((day) => [
                day,
                Object.fromEntries(
                    TEMPORAL_MARKET_WEATHER_KEYS.map((weatherKey) => [
                        weatherKey,
                        Object.fromEntries(
                            Object.entries(work.dayWeatherBtcTests?.[day]?.[weatherKey] || {})
                                .map(([btcState, test]) => [btcState, {
                                    bucketType: 'dayWeatherBtc',
                                    bucketValue: `${day}|${weatherKey}|BTC:${btcState}`,
                                    dayOfWeekUtc: day,
                                    marketWeatherKey: weatherKey,
                                    btcRouterState: btcState,
                                    gateWindow: test.stats,
                                    maturity: temporalGateMaturity(test.stats.completed),
                                    diversity: test.diversity,
                                    descriptiveOnly: true,
                                    optimizerEvidence: true
                                }])
                        )
                    ])
                )
            ])
        );
        const hourWeatherBtcProfiles = Object.fromEntries(
            TEMPORAL_HOUR_BUCKETS.map((hourBucket) => [
                hourBucket,
                Object.fromEntries(
                    TEMPORAL_MARKET_WEATHER_KEYS.map((weatherKey) => [
                        weatherKey,
                        Object.fromEntries(
                            Object.entries(work.hourWeatherBtcTests?.[hourBucket]?.[weatherKey] || {})
                                .map(([btcState, test]) => [btcState, {
                                    bucketType: 'hourWeatherBtc',
                                    bucketValue: `${hourBucket}|${weatherKey}|BTC:${btcState}`,
                                    hourUtc: Number(hourBucket.slice(1)),
                                    hourBucket,
                                    marketWeatherKey: weatherKey,
                                    btcRouterState: btcState,
                                    gateWindow: test.stats,
                                    maturity: temporalGateMaturity(test.stats.completed),
                                    diversity: test.diversity,
                                    descriptiveOnly: true,
                                    optimizerEvidence: true
                                }])
                        )
                    ])
                )
            ])
        );
        const dayHourWeatherBtcProfiles = Object.fromEntries(
            TEMPORAL_DAY_BUCKETS.map((day) => [
                day,
                Object.fromEntries(
                    TEMPORAL_HOUR_BUCKETS.map((hourBucket) => [
                        hourBucket,
                        Object.fromEntries(
                            TEMPORAL_MARKET_WEATHER_KEYS.map((weatherKey) => [
                                weatherKey,
                                Object.fromEntries(
                                    Object.entries(
                                        work.dayHourWeatherBtcTests?.[day]?.[hourBucket]?.[weatherKey] || {}
                                    ).map(([btcState, test]) => [btcState, {
                                        bucketType: 'dayHourWeatherBtc',
                                        bucketValue: `${day}:${hourBucket}|${weatherKey}|BTC:${btcState}`,
                                        dayOfWeekUtc: day,
                                        hourUtc: Number(hourBucket.slice(1)),
                                        hourBucket,
                                        marketWeatherKey: weatherKey,
                                        btcRouterState: btcState,
                                        gateWindow: test.stats,
                                        maturity: temporalGateMaturity(test.stats.completed),
                                        diversity: test.diversity,
                                        descriptiveOnly: true,
                                        optimizerEvidence: true
                                    }])
                                )
                            ])
                        )
                    ])
                )
            ])
        );

        const parsed = parseLongTaxonomyMicroId(work.familyId);
        return {
            familyId: work.familyId,
            trueMicroFamilyId: work.familyId,
            childTrueMicroFamilyId: work.familyId,
            parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
            setupType: parsed.setupType,
            regimeBucket: parsed.regimeBucket,
            confirmationProfile: parsed.confirmationProfile,
            side: TARGET_TRADE_SIDE,
            temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
            temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
            measurementVersion: MEASUREMENT_FIX_VERSION,
            costModelVersion: TEMPORAL_COST_MODEL_VERSION,
            taxonomyVersion: TEMPORAL_TAXONOMY_VERSION,
            temporalHourlyProfileVersion: TEMPORAL_HOURLY_PROFILE_VERSION,
            temporalMarketWeatherProfileVersion: TEMPORAL_MARKET_WEATHER_PROFILE_VERSION,
            btcDirectionRouterProfileVersion: BTC_DIRECTION_ROUTER_PROFILE_VERSION,
            btcDirectionRouterPolicyVersion: BTC_DIRECTION_ROUTER_POLICY_VERSION,
            marketWeatherKeys: TEMPORAL_MARKET_WEATHER_KEYS,
            btcRouterStates: BTC_ROUTER_STATES,
            dayTypeProfiles: work.dayTypeProfiles,
            dayProfiles,
            sessionProfiles,
            hourProfiles,
            dayHourProfiles,
            marketWeatherProfiles,
            dayWeatherProfiles,
            hourWeatherProfiles,
            dayHourWeatherProfiles,
            btcRouterProfiles,
            marketWeatherBtcProfiles,
            dayBtcProfiles,
            hourBtcProfiles,
            dayHourBtcProfiles,
            dayWeatherBtcProfiles,
            hourWeatherBtcProfiles,
            dayHourWeatherBtcProfiles,
            weekendApprovals,
            lifetimeIntegrity: work.lifetimeIntegrity,
            familyIdentityIncludesTemporalBucket: false,
            symbolExcludedFromFamilyId: true
        };
    });

    const manifest = temporalGenerationManifestBase({
        cutoffTs: normalizedCutoffTs,
        freezeSequence,
        familyCount: projections.length
    });
    const lifecycle = [
        { status: 'BUILDING', ts: manifest.createdAt },
        { status: 'INTEGRITY_CHECK_RUNNING', ts: now() }
    ];
    const generation = {
        ...manifest,
        status: 'INTEGRITY_CHECK_RUNNING',
        lifecycle,
        familyProjections: projections,
        fdrBatches: {
            negativeDaySession: {
                direction: 'NEGATIVE',
                testCount: negativeRecords.length,
                qValuesPersistedInProfiles: true,
                monotoneBackwardCorrectionApplied: true
            },
            positiveRecovery: {
                direction: 'POSITIVE',
                testCount: recoveryRecords.length,
                qValuesPersistedInProfiles: true,
                monotoneBackwardCorrectionApplied: true
            },
            positiveWeekendApproval: {
                direction: 'POSITIVE',
                testCount: weekendRecords.length,
                qValuesPersistedInProfiles: true,
                monotoneBackwardCorrectionApplied: true
            }
        },
        duplicateCanonicalOutcomeIds: [...duplicateCanonicalOutcomeIds].sort(),
        integrity: null,
        checksum: null
    };

    const preliminarySeed = `${TARGET_TRADE_SIDE}|${normalizedCutoffTs}|${freezeSequence}|${temporalChecksum({
        projections,
        manifest
    })}`;
    generation.generationId = `LONG_TEMPORAL_${normalizedCutoffTs}_${freezeSequence}_${
        createHash('sha256').update(preliminarySeed).digest('hex').slice(0, 12)
    }`;
    generation.weekCompositionProposals = buildWeekCompositionProposals({
        generation,
        micros
    });

    const uniqueFamilies = new Set(projections.map((projection) => projection.familyId));
    const nonFinitePaths = temporalNonFinitePaths(generation);
    const lifetimeFailures = projections
        .filter((projection) => projection.lifetimeIntegrity?.passed === false)
        .map((projection) => projection.familyId);
    const interactionFailures = projections.flatMap((projection) => [
        ...Object.values(projection.dayProfiles)
            .filter((profile) => profile.confounding?.integrity === false)
            .map((profile) => `${projection.familyId}|dayOfWeek|${profile.bucketValue}`),
        ...Object.values(projection.sessionProfiles)
            .filter((profile) => profile.confounding?.integrity === false)
            .map((profile) => `${projection.familyId}|session|${profile.bucketValue}`)
    ]);
    const compositionFailures = [];
    if (!Array.isArray(generation.weekCompositionProposals) ||
        generation.weekCompositionProposals.length !== 3) {
        compositionFailures.push('EXACTLY_THREE_WEEK_COMPOSITIONS_REQUIRED');
    } else {
        for (const composition of generation.weekCompositionProposals) {
            const validation = validateWeekComposition(composition, {
                generationId: generation.generationId,
                requireActive: false
            });
            if (!validation.valid) {
                compositionFailures.push(
                    `${composition?.mode || 'UNKNOWN'}:${validation.errors.join('|')}`
                );
            }
        }
    }
    const errors = [];
    if (projections.length !== 75 || uniqueFamilies.size !== 75) {
        errors.push('GENERATION_MUST_CONTAIN_EXACTLY_75_UNIQUE_CHILD_FAMILIES');
    }
    if (duplicateCanonicalOutcomeIds.size > 0) {
        errors.push('DUPLICATE_CANONICAL_OUTCOME_ACROSS_FAMILIES');
    }
    if (nonFinitePaths.length > 0) errors.push('NON_FINITE_VALUE_PRESENT');
    if (lifetimeFailures.length > 0) errors.push('TEMPORAL_LIFETIME_AXIS_SUM_MISMATCH');
    if (interactionFailures.length > 0) errors.push('INTERACTION_SUM_MISMATCH');
    if (compositionFailures.length > 0) errors.push('WEEK_COMPOSITION_INTEGRITY_FAILED');
    generation.integrity = {
        passed: errors.length === 0,
        checkedAt: now(),
        errors,
        familyCount: projections.length,
        uniqueFamilyCount: uniqueFamilies.size,
        weekCompositionCount: generation.weekCompositionProposals?.length || 0,
        duplicateCanonicalOutcomeIds: [...duplicateCanonicalOutcomeIds].sort(),
        nonFinitePaths,
        lifetimeFailures,
        interactionFailures,
        compositionFailures
    };
    generation.status = errors.length === 0 ? 'READY' : 'INVALID';
    generation.lifecycle.push({ status: generation.status, ts: now() });
    generation.checksum = temporalChecksum(generation);
    generation.integrity.checksumVerified = generation.checksum === temporalChecksum(generation);
    if (!generation.integrity.checksumVerified) {
        generation.status = 'INVALID';
        generation.integrity.passed = false;
        generation.integrity.errors.push('CHECKSUM_VERIFICATION_FAILED');
    }
    return generation;
}

function validateTemporalGeneration(generation, { nowTs = now(), requireActive = false } = {}) {
    const errors = [];
    if (!generation || typeof generation !== 'object') errors.push('GENERATION_MISSING');
    if (errors.length === 0 && generation.side !== TARGET_TRADE_SIDE) errors.push('GENERATION_SIDE_MISMATCH');
    if (errors.length === 0 && generation.temporalPolicyVersion !== TEMPORAL_POLICY_VERSION) {
        errors.push('TEMPORAL_POLICY_VERSION_MISMATCH');
    }
    if (errors.length === 0 && generation.measurementVersion !== MEASUREMENT_FIX_VERSION) {
        errors.push('MEASUREMENT_VERSION_MISMATCH');
    }
    if (errors.length === 0 && generation.costModelVersion !== TEMPORAL_COST_MODEL_VERSION) {
        errors.push('COST_MODEL_VERSION_MISMATCH');
    }
    if (errors.length === 0 && generation.taxonomyVersion !== TEMPORAL_TAXONOMY_VERSION) {
        errors.push('TAXONOMY_VERSION_MISMATCH');
    }
    if (errors.length === 0 && generation.temporalContextVersion !== TEMPORAL_CONTEXT_VERSION) {
        errors.push('TEMPORAL_CONTEXT_VERSION_MISMATCH');
    }
    if (errors.length === 0 &&
        generation.temporalHourlyProfileVersion !== TEMPORAL_HOURLY_PROFILE_VERSION) {
        errors.push('TEMPORAL_HOURLY_PROFILE_VERSION_MISMATCH');
    }
    if (errors.length === 0 &&
        generation.temporalMarketWeatherProfileVersion !== TEMPORAL_MARKET_WEATHER_PROFILE_VERSION) {
        errors.push('TEMPORAL_MARKET_WEATHER_PROFILE_VERSION_MISMATCH');
    }
    if (errors.length === 0 &&
        generation.btcDirectionRouterProfileVersion !== BTC_DIRECTION_ROUTER_PROFILE_VERSION) {
        errors.push('BTC_DIRECTION_ROUTER_PROFILE_VERSION_MISMATCH');
    }
    if (errors.length === 0 &&
        generation.btcDirectionRouterPolicyVersion !== BTC_DIRECTION_ROUTER_POLICY_VERSION) {
        errors.push('BTC_DIRECTION_ROUTER_POLICY_VERSION_MISMATCH');
    }
    if (errors.length === 0 && generation.weekCompositionVersion !== WEEK_COMPOSITION_VERSION) {
        errors.push('WEEK_COMPOSITION_VERSION_MISMATCH');
    }
    if (errors.length === 0 &&
        generation.weekCompositionOptimizerVersion !== WEEK_COMPOSITION_OPTIMIZER_VERSION) {
        errors.push('WEEK_COMPOSITION_OPTIMIZER_VERSION_MISMATCH');
    }
    if (errors.length === 0 && !['READY', 'ACTIVE'].includes(generation.status)) {
        errors.push('GENERATION_NOT_READY_OR_ACTIVE');
    }
    if (errors.length === 0 && requireActive && generation.status !== 'ACTIVE') {
        errors.push('GENERATION_NOT_ACTIVE');
    }
    const familyCount = Array.isArray(generation?.familyProjections)
        ? generation.familyProjections.length
        : 0;
    if (errors.length === 0 && familyCount !== 75) errors.push('GENERATION_FAMILY_COUNT_INVALID');
    const compositionCount = Array.isArray(generation?.weekCompositionProposals)
        ? generation.weekCompositionProposals.length
        : 0;
    if (errors.length === 0 && compositionCount !== 3) {
        errors.push('GENERATION_WEEK_COMPOSITION_COUNT_INVALID');
    }
    if (errors.length === 0 && generation.checksum !== temporalChecksum(generation)) {
        errors.push('GENERATION_CHECKSUM_INVALID');
    }
    const ageMs = generation?.generationCutoffTs
        ? normalizeTemporalCutoffTs(nowTs) - normalizeTemporalCutoffTs(generation.generationCutoffTs)
        : Number.POSITIVE_INFINITY;
    const expired = ageMs > TEMPORAL_GENERATION_MAX_AGE_DAYS * TEMPORAL_MS_PER_DAY;
    if (expired) errors.push('GENERATION_EXPIRED');
    return {
        valid: errors.length === 0,
        errors,
        expired,
        ageMs,
        ageDays: Number.isFinite(ageMs) ? ageMs / TEMPORAL_MS_PER_DAY : null
    };
}

async function compareAndSwapTemporalPointer(redis, key, expectedGenerationId, nextDocument) {
    const expected = String(expectedGenerationId || '');
    const currentDocument = await getRotationDocument(redis, key, null).catch(() => null);
    const currentId = String(currentDocument?.activeTemporalGenerationId || '');
    if (currentId !== expected) return false;
    const nextVersion = Math.max(0, safeNumber(currentDocument?.temporalPointerVersion, 0)) + 1;
    const documentToPersist = {
        ...nextDocument,
        temporalPointerVersion: nextVersion,
        temporalPointerPreviousGenerationId: currentId || null,
        temporalPointerWriteTs: now()
    };
    await setRotationDocument(redis, key, documentToPersist);
    const verified = await getRotationDocument(redis, key, null).catch(() => null);
    return Boolean(
        verified &&
        String(verified.activeTemporalGenerationId || '') ===
            String(documentToPersist.activeTemporalGenerationId || '') &&
        safeNumber(verified.temporalPointerVersion, -1) === nextVersion
    );
}

export async function getActiveTemporalGeneration({ nowTs = now() } = {}) {
    const redis = getDurableRedis();
    const pointerDocument = await getRotationDocument(redis, rotationValidFromKey(), null).catch(() => null);
    const generationId = String(pointerDocument?.activeTemporalGenerationId || '').trim();
    const generation = pointerDocument?.activeTemporalGeneration || null;
    if (!generationId || !generation || generation.generationId !== generationId) {
        return {
            generationId: generationId || null,
            generation: null,
            pointerDocument,
            validation: { valid: false, errors: ['ACTIVE_GENERATION_POINTER_MISSING_OR_INCONSISTENT'] }
        };
    }
    const validation = validateTemporalGeneration(generation, { nowTs, requireActive: true });
    return { generationId, generation, pointerDocument, validation };
}

export function evaluateTemporalEntryPolicySnapshot({
    row = {},
    generation = null,
    generationValidation = null,
    pointerDocument = null,
    wouldPublishWithoutTemporal = true,
    nowTs = now()
} = {}) {
    const runtime = temporalRuntimeConfig();
    const context = resolveEntryTemporalContext(row);
    const familyId = cleanLearningMicroId(
        row.trueMicroFamilyId || row.childTrueMicroFamilyId || row.microFamilyId
    );
    const mode = runtime.temporalPolicyMode;
    const weatherContext = resolveEntryMarketWeatherContext(row);
    const btcContext = resolveEntryBtcRouterContext({
        ...row,
        entryMarketWeatherKey: weatherContext.marketWeatherKey,
        entryMarketWeatherRegime: weatherContext.regime,
        entryMarketWeatherTrendSide: weatherContext.trendSide
    });
    const reasons = [];
    const activeWeekComposition = pointerDocument?.activeWeekComposition || null;
    const weekCompositionValidation = activeWeekComposition
        ? validateWeekComposition(activeWeekComposition, {
            generationId: generation?.generationId || null,
            requireActive: true
        })
        : { valid: true, errors: [], missing: true };
    const weekCompositionDecision = activeWeekComposition && weekCompositionValidation.valid
        ? evaluateWeekCompositionSlot(activeWeekComposition, {
            dayOfWeekUtc: context.dayOfWeekUtc,
            hourUtc: context.hourUtc,
            marketWeatherKey: weatherContext.marketWeatherKey,
            currentMarketWeather: row.entryMarketWeather || row.currentMarketWeather || null,
            currentRegime: weatherContext.regime,
            currentTrendSide: weatherContext.trendSide,
            btcRouterState: btcContext.btcRouterState,
            entryBtcRouterState: btcContext.btcRouterState,
            btcContext,
            row,
            familyId
        })
        : activeWeekComposition
          ? {
              compositionApplied: true,
              allowed: false,
              reasons: weekCompositionValidation.errors,
              slot: null
            }
          : { compositionApplied: false, allowed: true, reasons: [], slot: null };
    const weekCompositionWouldBlock = weekCompositionDecision.allowed === false;
    const wouldPublishWithoutTemporalAndComposition =
        Boolean(wouldPublishWithoutTemporal) && !weekCompositionWouldBlock;
    let temporalWouldBlock = false;
    let projection = null;
    let generationId = generation?.generationId || null;
    let validation = generationValidation || validateTemporalGeneration(generation, {
        nowTs,
        requireActive: true
    });

    if (!runtime.temporalStatsEnabled) {
        validation = { valid: true, errors: [], disabled: true };
    } else if (!validation.valid) {
        reasons.push(...(validation.errors || ['ACTIVE_TEMPORAL_GENERATION_INVALID']));
        temporalWouldBlock = true;
    } else {
        projection = generation.familyProjections?.find(
            (candidate) => candidate.familyId === familyId
        ) || null;
        if (!projection) {
            reasons.push('TEMPORAL_FAMILY_PROJECTION_MISSING');
            temporalWouldBlock = true;
        } else {
            const dayDecision = projection.dayProfiles?.[context.dayOfWeekUtc]?.activeDecision || 'NO_VETO';
            const sessionDecision = projection.sessionProfiles?.[context.primarySessionBucket]?.activeDecision || 'NO_VETO';
            if (dayDecision === 'VETO_ACTIVE') reasons.push(`DAY_VETO_ACTIVE:${context.dayOfWeekUtc}`);
            if (sessionDecision === 'VETO_ACTIVE') reasons.push(`SESSION_VETO_ACTIVE:${context.primarySessionBucket}`);
            if (context.isWeekend) {
                const approval = projection.weekendApprovals?.[context.dayOfWeekUtc]?.approvalStatus;
                if (approval !== 'WEEKEND_APPROVED') {
                    reasons.push(`WEEKEND_NOT_APPROVED:${context.dayOfWeekUtc}`);
                }
            }
            temporalWouldBlock = reasons.length > 0;
        }
    }

    const finalDiscordEntryAllowed = wouldPublishWithoutTemporalAndComposition && (
        mode !== 'ENFORCE' || temporalWouldBlock === false
    );
    return temporalDeepFreeze({
        snapshotVersion: 'LONG_TEMPORAL_ENTRY_DECISION_SNAPSHOT_V1',
        evaluatedAt: normalizeTemporalCutoffTs(nowTs),
        side: TARGET_TRADE_SIDE,
        familyId: familyId || null,
        entryTs: context.contextTs,
        entryHourUtc: context.hourUtc,
        entryDayOfWeekUtc: context.dayOfWeekUtc,
        entryDayType: context.dayType,
        entryIsWeekend: context.isWeekend,
        entrySessionTags: [...context.sessionTags],
        entrySessionBucket: context.primarySessionBucket,
        entrySessionOverlap: context.sessionOverlap,
        entryOffHours: context.offHours,
        entryMarketWeatherKey: weatherContext.marketWeatherKey,
        entryMarketWeatherRegime: weatherContext.regime,
        entryMarketWeatherTrendSide: weatherContext.trendSide,
        entryMarketWeatherAvailable: weatherContext.available,
        entryBtcRouterState: btcContext.btcRouterState,
        entryBtcDirection: btcContext.direction,
        entryBtcConfidence: btcContext.confidence,
        entryBtcTrendStrength: btcContext.trendStrength,
        entryBtcBullishPct: btcContext.bullishPct,
        entryBtcBearishPct: btcContext.bearishPct,
        entryBtcAlignedBreadthPct: btcContext.alignedBreadthPct,
        entryBtcBreadthConfirmed: btcContext.breadthConfirmed,
        entryBtcAgainstLong: btcContext.againstLong,
        entryBtcRouterSource: btcContext.source,
        btcDirectionRouterProfileVersion: BTC_DIRECTION_ROUTER_PROFILE_VERSION,
        btcDirectionRouterPolicyVersion: BTC_DIRECTION_ROUTER_POLICY_VERSION,
        temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
        temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
        temporalHourlyProfileVersion: TEMPORAL_HOURLY_PROFILE_VERSION,
        temporalMarketWeatherProfileVersion: TEMPORAL_MARKET_WEATHER_PROFILE_VERSION,
        weekCompositionVersion: WEEK_COMPOSITION_VERSION,
        weekCompositionOptimizerVersion: WEEK_COMPOSITION_OPTIMIZER_VERSION,
        temporalStatsEnabled: runtime.temporalStatsEnabled,
        temporalPolicyMode: mode,
        activeTemporalGenerationId: generationId,
        generationCutoffTs: generation?.generationCutoffTs || null,
        generationValidation: validation,
        familyProjectionFound: Boolean(projection),
        activeWeekCompositionId: activeWeekComposition?.compositionId || null,
        activeWeekCompositionMode: activeWeekComposition?.mode || null,
        weekCompositionApplied: weekCompositionDecision.compositionApplied === true,
        weekCompositionValidation,
        weekCompositionWouldBlock,
        weekCompositionBlockReasons: weekCompositionDecision.reasons || [],
        weekCompositionSlot: weekCompositionDecision.slot || null,
        btcDirectionRouterApplied: weekCompositionDecision.compositionApplied === true,
        btcDirectionRouterWouldBlock: (weekCompositionDecision.reasons || []).some(
            (reason) => String(reason || '').includes('BTC') || String(reason || '').includes('AGAINST_BTC')
        ),
        btcDirectionRouterBlockReasons: (weekCompositionDecision.reasons || []).filter(
            (reason) => String(reason || '').includes('BTC') || String(reason || '').includes('AGAINST_BTC')
        ),
        counterBtcExceptionUsed: weekCompositionDecision.counterBtcExceptionUsed === true,
        wouldPublishWithoutTemporal: Boolean(wouldPublishWithoutTemporal),
        wouldPublishWithoutTemporalAndComposition,
        temporalWouldBlock,
        temporalBlockReasons: reasons,
        finalDiscordEntryAllowed
    });
}

export async function evaluateTemporalEntryPolicy({
    row = {},
    wouldPublishWithoutTemporal = true,
    nowTs = now()
} = {}) {
    const active = await getActiveTemporalGeneration({ nowTs });
    return evaluateTemporalEntryPolicySnapshot({
        row,
        generation: active.generation,
        generationValidation: active.validation,
        pointerDocument: active.pointerDocument,
        wouldPublishWithoutTemporal,
        nowTs
    });
}

export async function getActiveWeekComposition({ nowTs = now() } = {}) {
    const active = await getActiveTemporalGeneration({ nowTs });
    const composition = active.pointerDocument?.activeWeekComposition || null;
    const validation = composition
        ? validateWeekComposition(composition, {
            generationId: active.generationId,
            requireActive: true
        })
        : { valid: false, errors: ['ACTIVE_WEEK_COMPOSITION_MISSING'] };
    return {
        compositionId: composition?.compositionId || null,
        composition,
        validation,
        generationId: active.generationId,
        generationValidation: active.validation,
        pointerDocument: active.pointerDocument
    };
}

export async function activateWeekComposition({
    compositionId,
    disabledDays = [],
    disabledHours = [],
    disabledWeatherKeys = [],
    disabledBtcStates = [],
    disabledWeatherBtcKeys = [],
    disabledDayHours = [],
    disabledSlots = [],
    disabledSlotWeatherKeys = [],
    disabledDayHourWeatherBtcKeys = [],
    activatedBy = 'ADMIN_WEEK_COMPOSITION',
    nowTs = now()
} = {}) {
    const redis = getDurableRedis();
    const active = await getActiveTemporalGeneration({ nowTs });
    if (!active.validation?.valid || !active.generation) {
        const error = new Error('ACTIVE_TEMPORAL_GENERATION_REQUIRED_FOR_WEEK_COMPOSITION');
        error.details = active.validation;
        throw error;
    }
    const requestedId = String(compositionId || '').trim();
    const proposal = (active.generation.weekCompositionProposals || [])
        .find((candidate) =>
            candidate.compositionId === requestedId ||
            candidate.mode === requestedId.toUpperCase()
        );
    if (!proposal) {
        const error = new Error('WEEK_COMPOSITION_PROPOSAL_NOT_FOUND');
        error.details = {
            requestedId,
            available: (active.generation.weekCompositionProposals || [])
                .map((candidate) => candidate.compositionId)
        };
        throw error;
    }
    const activated = applyWeekCompositionOverrides(proposal, {
        disabledDays,
        disabledHours,
        disabledWeatherKeys,
        disabledBtcStates,
        disabledWeatherBtcKeys,
        disabledDayHours,
        disabledSlots,
        disabledSlotWeatherKeys,
        disabledDayHourWeatherBtcKeys,
        activatedBy
    });
    const validation = validateWeekComposition(activated, {
        generationId: active.generationId,
        requireActive: true
    });
    if (!validation.valid) {
        const error = new Error('WEEK_COMPOSITION_ACTIVATION_VALIDATION_FAILED');
        error.details = validation;
        throw error;
    }
    const nextPointer = {
        ...(active.pointerDocument || {}),
        activeWeekCompositionId: activated.compositionId,
        activeWeekCompositionBaseId: activated.baseCompositionId,
        activeWeekCompositionMode: activated.mode,
        activeWeekComposition: activated,
        weekCompositionActivatedAt: normalizeTemporalCutoffTs(nowTs),
        weekCompositionActivatedBy: activatedBy,
        weekCompositionVersion: WEEK_COMPOSITION_VERSION,
        weekCompositionOptimizerVersion: WEEK_COMPOSITION_OPTIMIZER_VERSION
    };
    const swapped = await compareAndSwapTemporalPointer(
        redis,
        rotationValidFromKey(),
        active.generationId,
        nextPointer
    );
    if (!swapped) {
        throw new Error('WEEK_COMPOSITION_POINTER_CAS_CONFLICT');
    }
    let rotationActivation = null;
    let rotationActivationError = null;
    try {
        rotationActivation = await activateSelectedMicroFamilies({
            microFamilyIds: activated.summary.familyUnion,
            trueMicroFamilyIds: activated.summary.familyUnion,
            activeMicroFamilyIds: activated.summary.familyUnion,
            ids: activated.summary.familyUnion,
            weekKey: PERSISTENT_LEARNING_KEY,
            mode: `week-composition-${String(activated.mode || '').toLowerCase()}`,
            manualOnly: true,
            exactTrueMicroOnly: true
        });
    } catch (error) {
        rotationActivationError = error?.message || String(error);
    }
    return {
        ok: true,
        changed: true,
        generationId: active.generationId,
        activeWeekComposition: activated,
        activeWeekCompositionId: activated.compositionId,
        rotationActivation,
        rotationActivationError,
        failClosedIfRotationActivationFailed: true
    };
}


function namespacedLongKey(key, fallback) {
    const raw = String(key || fallback || '').trim();


    if (!raw) return `${LONG_KEY_PREFIX}MISSING_KEY`;
    if (raw.startsWith(LONG_KEY_PREFIX)) return raw;
    if (raw.startsWith('SHORT:') || raw.includes(`${LONG_KEY_PREFIX}SHORT:`)) {
        throw new Error('LONG_ROTATION_KEY_REJECTED_SHORT_NAMESPACE');
    }
    return `${LONG_KEY_PREFIX}${raw}`;
}


function activeRotationKey() {
    return namespacedLongKey(
         KEYS.long?.analyze?.activeRotation ||
           KEYS.analyze?.longActiveRotation ||
           KEYS.analyze?.activeRotation,
         'ANALYZE:ACTIVE_ROTATION'
    );
}


function nextRotationKey() {
    return namespacedLongKey(
         KEYS.long?.analyze?.nextRotation ||
             KEYS.analyze?.longNextRotation ||
             KEYS.analyze?.nextRotation,
         'ANALYZE:NEXT_ROTATION'
    );
}


function rotationValidFromKey() {
    return namespacedLongKey(
         KEYS.long?.analyze?.rotationValidFrom ||
             KEYS.analyze?.longRotationValidFrom ||
             KEYS.analyze?.rotationValidFrom,
         'ANALYZE:ROTATION_VALID_FROM'
    );
}



function isLargeDocumentManifest(value) {
    return Boolean(
        value &&
        typeof value === 'object' &&
        value.largeDocumentStorageSchema === LARGE_DOCUMENT_STORAGE_SCHEMA &&
        value.encoding === 'gzip-base64-chunks' &&
        Array.isArray(value.chunkKeys)
    );
}

function largeDocumentChunkKey(key, documentId, index) {
    return `${key}:PAYLOAD:${documentId}:CHUNK:${String(index).padStart(3, '0')}`;
}

async function deleteLargeDocumentChunks(redis, manifest) {
    if (!isLargeDocumentManifest(manifest)) return;
    for (const chunkKey of manifest.chunkKeys) {
        try {
            await redis.del(chunkKey);
        } catch {
            // Orphan cleanup is best effort. The authoritative manifest is already safe.
        }
    }
}

async function getRotationDocument(redis, key, fallback = null) {
    const stored = await getJson(redis, key, fallback);
    if (!isLargeDocumentManifest(stored)) return stored;
    if (stored.chunkKeys.length !== stored.chunkCount) {
        throw new Error('LARGE_DOCUMENT_CHUNK_MANIFEST_INVALID');
    }
    if (stored.chunkCount < 1 || stored.chunkCount > LARGE_DOCUMENT_MAX_CHUNKS) {
        throw new Error('LARGE_DOCUMENT_CHUNK_COUNT_INVALID');
    }
    const chunks = [];
    for (const chunkKey of stored.chunkKeys) {
        const chunk = await redis.get(chunkKey);
        if (typeof chunk !== 'string' || chunk.length === 0) {
            throw new Error(`LARGE_DOCUMENT_CHUNK_MISSING:${chunkKey}`);
        }
        chunks.push(chunk);
    }
    const compressed = Buffer.from(chunks.join(''), 'base64');
    if (Number.isFinite(Number(stored.compressedBytes)) &&
        compressed.length !== Number(stored.compressedBytes)) {
        throw new Error('LARGE_DOCUMENT_COMPRESSED_SIZE_MISMATCH');
    }
    const json = gunzipSync(compressed).toString('utf8');
    const checksum = createHash('sha256').update(json).digest('hex');
    if (stored.jsonSha256 && checksum !== stored.jsonSha256) {
        throw new Error('LARGE_DOCUMENT_CHECKSUM_MISMATCH');
    }
    return JSON.parse(json);
}

async function setRotationDocument(redis, key, value) {
    const json = JSON.stringify(value);
    const uncompressedBytes = Buffer.byteLength(json);
    const previous = await getJson(redis, key, null).catch(() => null);
    if (uncompressedBytes <= LARGE_DOCUMENT_STORAGE_THRESHOLD_BYTES) {
        await setJson(redis, key, value);
        await deleteLargeDocumentChunks(redis, previous);
        return {
            storageMode: 'JSON',
            uncompressedBytes,
            compressedBytes: null,
            chunkCount: 0
        };
    }
    const compressed = gzipSync(Buffer.from(json, 'utf8'), { level: 6 });
    const base64 = compressed.toString('base64');
    const chunks = [];
    for (let offset = 0; offset < base64.length; offset += LARGE_DOCUMENT_CHUNK_CHAR_LIMIT) {
        chunks.push(base64.slice(offset, offset + LARGE_DOCUMENT_CHUNK_CHAR_LIMIT));
    }
    if (chunks.length < 1 || chunks.length > LARGE_DOCUMENT_MAX_CHUNKS) {
        throw new Error('LARGE_DOCUMENT_CHUNK_COUNT_EXCEEDED');
    }
    const documentId = `${Date.now()}_${randomUUID()}`;
    const chunkKeys = chunks.map((_, index) => largeDocumentChunkKey(key, documentId, index));
    for (let index = 0; index < chunks.length; index += 1) {
        await redis.set(chunkKeys[index], chunks[index]);
    }
    const manifest = {
        largeDocumentStorageSchema: LARGE_DOCUMENT_STORAGE_SCHEMA,
        encoding: 'gzip-base64-chunks',
        documentId,
        chunkCount: chunks.length,
        chunkKeys,
        uncompressedBytes,
        compressedBytes: compressed.length,
        base64Chars: base64.length,
        jsonSha256: createHash('sha256').update(json).digest('hex'),
        writtenAt: Date.now()
    };
    await setJson(redis, key, manifest);
    await deleteLargeDocumentChunks(redis, previous);
    return {
        storageMode: manifest.encoding,
        uncompressedBytes,
        compressedBytes: compressed.length,
        chunkCount: chunks.length
    };
}

function compactTemporalGenerationSummary(generation) {
    if (!generation || typeof generation !== 'object') return null;
    return {
        generationId: generation.generationId || null,
        side: generation.side || TARGET_TRADE_SIDE,
        status: generation.status || null,
        generationCutoffTs: generation.generationCutoffTs || null,
        freezeSequence: generation.freezeSequence || null,
        createdAt: generation.createdAt || null,
        activatedAt: generation.activatedAt || null,
        checksum: generation.checksum || null,
        temporalContextVersion: generation.temporalContextVersion || null,
        temporalPolicyVersion: generation.temporalPolicyVersion || null,
        measurementVersion: generation.measurementVersion || null,
        costModelVersion: generation.costModelVersion || null,
        taxonomyVersion: generation.taxonomyVersion || null,
        familyCount: Array.isArray(generation.familyProjections)
            ? generation.familyProjections.length
            : safeNumber(generation.familyCount, 0),
        weekCompositionCount: Array.isArray(generation.weekCompositionProposals)
            ? generation.weekCompositionProposals.length
            : 0,
        integrity: generation.integrity || null,
        lifecycle: Array.isArray(generation.lifecycle)
            ? generation.lifecycle.slice(-8)
            : []
    };
}

function compactPointerDocumentForDashboard(pointerDocument) {
    if (!pointerDocument || typeof pointerDocument !== 'object') return pointerDocument || null;
    const {
        activeTemporalGeneration,
        previousTemporalGeneration,
        activeWeekComposition,
        ...rest
    } = pointerDocument;
    return {
        ...rest,
        activeTemporalGenerationSummary: compactTemporalGenerationSummary(activeTemporalGeneration),
        previousTemporalGenerationSummary: compactTemporalGenerationSummary(previousTemporalGeneration),
        activeWeekCompositionSummary: activeWeekComposition
            ? {
                compositionId: activeWeekComposition.compositionId || null,
                baseCompositionId: activeWeekComposition.baseCompositionId || null,
                generationId: activeWeekComposition.generationId || null,
                mode: activeWeekComposition.mode || null,
                status: activeWeekComposition.status || null,
                checksum: activeWeekComposition.checksum || null,
                summary: activeWeekComposition.summary || null
            }
            : null
    };
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


function normalizeSchema(value) {
    return String(value || '').trim().toUpperCase();
}


function schemaMeta() {
    const macroSchema = normalizeSchema(
         CONFIG.long?.analyze?.macroSchema ||
              CONFIG.analyze?.macroSchema ||
              CONFIG.analyze?.legacySchema ||
              FALLBACK_MACRO_SCHEMA
    );


    return {
         schema: TRUE_MICRO_SCHEMA,
         trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
         childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
         parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
         macroSchema,
         microSchema: TRUE_MICRO_SCHEMA,
         parentMicroSchema: PARENT_TRUE_MICRO_SCHEMA,
         fallbackMicroSchema: normalizeSchema(
              CONFIG.long?.analyze?.microSchema ||
                CONFIG.analyze?.microSchema ||
                FALLBACK_MICRO_SCHEMA
         ),
         fallbackTrueMicroSchema: FALLBACK_TRUE_MICRO_SCHEMA,
         learningGranularity: LEARNING_GRANULARITY,
         parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
         strategyVersion: CONFIG.strategyVersion
    };
}


function learningDataKey(weekKey = PERSISTENT_LEARNING_KEY) {
    return String(
         CONFIG.long?.analyze?.persistentLearningKey ||
              CONFIG.long?.rotation?.persistentLearningKey ||
              CONFIG.analyze?.longPersistentLearningKey ||
              weekKey ||
              PERSISTENT_LEARNING_KEY
    ).trim() || PERSISTENT_LEARNING_KEY;
}


function minWeightedCompleted() {
    return Math.max(
         0,
         safeNumber(
              CONFIG.long?.rotation?.minWeightedCompleted ??
                  CONFIG.rotation?.minWeightedCompleted,
              DEFAULT_MIN_WEIGHTED_COMPLETED
         )
    );
}


function empiricalVetoMinCompleted() {
    return Math.max(
         minWeightedCompleted(),
         Math.floor(
              safeNumber(
                  CONFIG.long?.rotation?.empiricalVetoMinCompleted ??
                    CONFIG.rotation?.empiricalVetoMinCompleted,
                  DEFAULT_EMPIRICAL_VETO_MIN_COMPLETED
              )
         )
    );
}


function empiricalVetoMaxAvgR() {
    return safeNumber(
         CONFIG.long?.rotation?.empiricalVetoMaxAvgR ??
              CONFIG.rotation?.empiricalVetoMaxAvgR,
         DEFAULT_EMPIRICAL_VETO_MAX_AVG_R
    );
}


function topNPerSide() {
    const preferred =
         CONFIG.long?.rotation?.topNLong ??
         CONFIG.rotation?.topNLong ??
         CONFIG.rotation?.topNPerSide ??
         DEFAULT_TOP_N_PER_SIDE;


    const n = Math.floor(Number(preferred));


    if (!Number.isFinite(n) || n <= 0) return DEFAULT_TOP_N_PER_SIDE;


    return Math.max(1, Math.min(MAX_TOP_N_PER_SIDE, n));
}


function parentDiversificationEnabled() {
    return CONFIG.long?.rotation?.parentDiversificationEnabled !== false &&
         CONFIG.rotation?.parentDiversificationEnabled !== false;
}


function maxPerParentTrueMicroFamily() {
    const explicit =
         CONFIG.long?.rotation?.maxPerParentTrueMicroFamily ??
         CONFIG.long?.rotation?.maxPerMacroFamily ??
         CONFIG.rotation?.maxPerParentTrueMicroFamily ??
         CONFIG.rotation?.maxPerMacroFamily;


    const explicitNumber = Number(explicit);


    if (Number.isFinite(explicitNumber) && explicitNumber > 0) {
         return Math.floor(explicitNumber);
    }


    const legacyEnforce =
         CONFIG.long?.rotation?.enforceMaxPerParentTrueMicroFamily ??
         CONFIG.long?.rotation?.enforceMaxPerMacroFamily ??
         CONFIG.rotation?.enforceMaxPerMacroFamily;


    if (legacyEnforce === true) return 1;


    return parentDiversificationEnabled() ? 1 : 0;
}


function minPrimaryRowsForPreviousMerge() {
    const n = Number(
         CONFIG.long?.rotation?.minPrimaryRowsForPreviousMerge ??
           CONFIG.rotation?.minPrimaryRowsForPreviousMerge ??
           0
    );


    return Number.isFinite(n) && n > 0
         ? Math.floor(n)
         : DEFAULT_MIN_PRIMARY_ROWS_FOR_PREVIOUS_MERGE;
}


function defaultRotationMode() {
    return CONFIG.long?.rotation?.mode || CONFIG.rotation?.mode || 'adaptive';
}


function allowManualUnknownTrueMicroIds() {
    return CONFIG.long?.rotation?.allowManualUnknownTrueMicroIds !== false;
}


function allowSoftRotationFallback() {
    return CONFIG.long?.rotation?.allowSoftRotationFallback !== false;
}


function allowObservationRotationFallback() {
    return CONFIG.long?.rotation?.allowObservationRotationFallback !== false;
}


function allowRawRotationFallback() {
    return CONFIG.long?.rotation?.allowRawRotationFallback !== false;
}


function allowLegacyCompletedFallback() {
    return CONFIG.long?.analyze?.allowLegacyCompletedFallback === true ||
      CONFIG.analyze?.allowLegacyCompletedFallback === true;
}


function modeFlags() {
    return {
      targetTradeSide: TARGET_TRADE_SIDE,
      targetScannerSide: TARGET_SCANNER_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
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
      virtualTracked: true,
      shadowOnly: true,
      outcomeSource: 'VIRTUAL',


      realTrade: false,
      realOrder: false,
      exchangeOrder: false,
      bitgetOrderPlaced: false,


      noRealOrders: true,
      realOrdersDisabled: true,
      exchangeOrdersDisabled: true,
bitgetOrdersDisabled: true,
exchangeCallsDisabled: true,
noExchangeOrders: true,


globalMaxOpenPositionsBlockDisabled: true,
maxOneOpenPositionPerSymbol: true,
oneOpenPositionPerSymbol: true,
positionTimeStopMinDefault: DEFAULT_POSITION_TIME_STOP_MIN,


validLongRiskShape: 'entry > 0 && sl > 0 && sl < entry && tp > entry',
longRiskShape: 'sl < entry < tp',
riskTradeSide: TARGET_TRADE_SIDE,
riskGeometryRule: 'LONG: sl < entry < tp',
tpHitRule: 'LONG: price >= tp',
slHitRule: 'LONG: price <= sl',
longGrossRFormula: '(exitPrice - entry) / (entry - initialSl)',
longCurrentRFormula: '(currentPrice - entry) / (entry - initialSl)',
grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
currentRFormula: '(currentPrice - entry) / (entry - initialSl)',
longExitRules: {
     tp: 'price >= tp',
     sl: 'price <= sl',
     timeStop: 'TIME_STOP'
},


observationFirst: true,
observationAlwaysCounted: false,
observationDedupeRequired: true,
seenDefinition: 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY',


completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
completedOnlyClosedVirtualOrShadow: true,
scoringRSource: 'netR',
winsLossesFlatsSource: 'netR',
winrateDefinition: 'netR > 0',
avgRSource: 'netR',
totalRSource: 'netR',
avgCostRShown: true,
avgCostRSource: 'costR',


measurementFixVersion: MEASUREMENT_FIX_VERSION,
acceptedOutcomeMeasurementVersion: MEASUREMENT_FIX_VERSION,
completedCurrentMeasurementOnly: true,
strictOutcomeMeasurementGate: true,
legacyOutcomeMeasurementsExcluded: true,
exitFillModelVersion: EXIT_FILL_MODEL_VERSION,
exitFillPolicy: 'TP_SL_USE_TRIGGER_BOUNDARY_TIME_STOP_USES_OBSERVED_PRICE',
    empiricalVetoEnabled: true,
    empiricalVetoPolicyVersion: EMPIRICAL_VETO_POLICY_VERSION,
    empiricalVetoMinCompleted: empiricalVetoMinCompleted(),
    empiricalVetoMaxAvgR: empiricalVetoMaxAvgR(),
    empiricalVetoRule:
         'completed >= minCompleted && avgR <= maxAvgR',
    empiricalVetoBlocksAdaptiveSelection: true,
    empiricalVetoBlocksManualActivation: true,
    empiricalVetoRemovesActiveDiscordSelection: true,
    empiricalVetoCanRecover: true,


    ...temporalRuntimeConfig(),
    temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
    temporalGenerationSchemaVersion: TEMPORAL_GENERATION_SCHEMA_VERSION,
    temporalTaxonomyVersion: TEMPORAL_TAXONOMY_VERSION,
    temporalCostModelVersion: TEMPORAL_COST_MODEL_VERSION,
    temporalFamilyIdentityIncludesBucket: false,
    temporalWindowMaxOutcomes: TEMPORAL_MAX_WINDOW_OUTCOMES,
    temporalWindowMaxAgeDays: TEMPORAL_MAX_WINDOW_AGE_DAYS,

    statusRules: {
         OBSERVING: 'completed == 0',
         EARLY_OUTCOMES: `completed > 0 && completed <
${DEFAULT_MIN_WEIGHTED_COMPLETED}`,
         ACTIVE_LEARNING: `completed >= ${DEFAULT_MIN_WEIGHTED_COMPLETED}`
    },


    activationGateRules: {
         OBSERVING: `completed < ${empiricalVetoMinCompleted()}`,
         PASSED: `completed >= ${empiricalVetoMinCompleted()} && avgR >
${empiricalVetoMaxAvgR()}`,
         EMPIRICAL_VETO: `completed >= ${empiricalVetoMinCompleted()} && avgR <=
${empiricalVetoMaxAvgR()}`
    },


    defaultRanking:
'adaptiveScore|dashboardBalancedScore|balancedScore|fairWinrate|totalR|avgR|avgCostR',
    rankingUsesAdaptiveScore: true,
    rankingUsesBalancedScore: true,
    rankingUsesFairWinrate: true,
    rankingUsesTotalR: true,
    rankingUsesAvgR: true,
    rankingUsesAvgCostR: true,
    bareWinrateRankingDisabled: true,
    rawWinrateRankingDisabled: true,


    selectionUsesAdaptiveScore: true,
    parentDiversificationEnabled: parentDiversificationEnabled(),
    maxPerParentTrueMicroFamily: maxPerParentTrueMicroFamily(),


    recentMomentumScoreEnabled: true,
    currentFitScoreEnabled: true,
    adaptiveScoreEnabled: true,
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
currentFitBlocksVirtualLearning: false,
currentFitBlocksShadowLearning: false,
currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',


...temporalPolicyFlags(buildTemporalContext(now())),
temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
weekendPolicyVersion: WEEKEND_POLICY_VERSION,
sessionPolicyVersion: SESSION_POLICY_VERSION,
weekendMode: temporalPolicyMode(),
sessionMode: temporalPolicyMode(),
weekendBlocksNewDiscordEntriesOnly: true,
weekendDoesNotBlockLearning: true,
weekendDoesNotBlockExits: true,
sessionPolicyObservedOnly: temporalPolicyMode() !== 'ENFORCE',
sessionDoesNotOverrideFamilyGate: true,


learningRemainsBroad: true,
selectionIsAdaptive: true,
discordWillBeStrict: true,


manualSelectionOnly: true,
manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
discordOnlyForSelectedMicroFamilies: true,
discordOnlyForManualSelection: true,
discordOnlyForExactTrueMicroMatch: true,
discordSelectionRule: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY',


trueMicroOnly: true,
exactTrueMicroOnly: true,
exactTrueMicroFamilyRequired: true,
selectionGranularity: 'EXACT_75_CHILD',
allowCoarseMicroAliasLiveEntries: false,
allowCoarseMicroAliasForDiscord: false,
parentSelectionAllowed: false,


scannerSide: TARGET_SCANNER_SIDE,
scannerFingerprintRole: 'METADATA_ONLY',
scannerFingerprintsMetadataOnly: true,
scannerFingerprintsUsedAsLearningFamily: false,
scannerBucketsMetadataOnly: true,
legacy25BucketsMetadataOnly: true,


executionFingerprintRole: 'METADATA_ONLY',
executionFingerprintsMetadataOnly: true,
executionFingerprintsUsedAsLearningFamily: false,
         analyzeMicroFamiliesOnly: true,
         learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
         symbolExcludedFromFamilyId: true,
         coinNameExcludedFromFamilyId: true,
         hashesExcludedFromFamilyId: true,


         fixedTaxonomyPreferred: true,
         trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
         childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
         exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
         parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
         learningGranularity: LEARNING_GRANULARITY,
         parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
         childLearningEnabled: true,
         parentLearningEnabled: true,
         fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED',


         autoRotation: false,
         autoRotationDisabled: true,
         activateNextDisabled: true,
         activateCronDisabled: true,
         freezeCronDisabled: true,
         resetCronDisabled: true,


         redisNamespace: LONG_NAMESPACE,
         redisKeyPrefix: LONG_KEY_PREFIX,
         persistentLearningKey: PERSISTENT_LEARNING_KEY,
         learningDataKey: PERSISTENT_LEARNING_KEY,
         redisKeysSeparatedFromShortRoot: true,


         rootSide: TARGET_TRADE_SIDE,
         rootIsolated: true,
         shortRootTouched: false
    };
}


function cleanSideText(value = '') {
    return String(value || '')
         .trim()
         .toUpperCase()
         .replaceAll('SHORT_DISABLED_FALSE', '')
         .replaceAll('SHORTDISABLED_FALSE', '')
         .replaceAll('BLOCK_SHORT_FALSE', '')
         .replaceAll('SHORT_ENABLED_FALSE', '')
         .replaceAll('SHORT_ONLY_FALSE', '')
         .replaceAll('LONG_DISABLED_FALSE', '')
         .replaceAll('LONGDISABLED_FALSE', '')
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


function normalizedSignalText(value = '') {
    return cleanSideText(value)
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
}


function hasSignalPattern(value = '', patterns = []) {
    const text = normalizedSignalText(value);


    if (!text) return false;


    return patterns.some((pattern) => (
      text === pattern ||
      text.startsWith(`${pattern}_`) ||
      text.endsWith(`_${pattern}`) ||
      text.includes(`_${pattern}_`)
    ));
}


function hasLongSignal(value = '') {
    return hasSignalPattern(value, [
      'LONG',
      'BULL',
      'BULLISH',
      'BUY',
      'SIDE_LONG',
      'TRADE_SIDE_LONG',
      'TRADESIDE_LONG',
      'POSITION_SIDE_LONG',
      'POSITIONSIDE_LONG',
      'DIRECTION_LONG',
      'SIDE_BULL',
      'TRADE_SIDE_BULL',
      'DIRECTION_BULL',
      'SIDE_BUY',
      'DIRECTION_BUY',
      'MICRO_LONG',
      'FAMILY_LONG'
    ]);
}


function hasShortSignal(value = '') {
    return hasSignalPattern(value, [
      'SHORT',
      'BEAR',
      'BEARISH',
      'SELL',
      'SIDE_SHORT',
      'TRADE_SIDE_SHORT',
      'TRADESIDE_SHORT',
      'POSITION_SIDE_SHORT',
      'POSITIONSIDE_SHORT',
      'DIRECTION_SHORT',
      'SIDE_BEAR',
      'TRADE_SIDE_BEAR',
      'DIRECTION_BEAR',
      'SIDE_SELL',
      'DIRECTION_SELL',
      'MICRO_SHORT',
      'FAMILY_SHORT'
    ]);
}


function isScannerFingerprintId(id = '') {
    const value = String(id || '').toUpperCase();


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
    const value = String(id || '').toUpperCase();


    return (
         value.includes(`_${EXECUTION_MICRO_SUFFIX}_`) ||
         value.includes('__XR__') ||
         value.includes('|XR|') ||
         value.includes('EXECUTION_FINGERPRINT') ||
         value.includes('EXECUTION_MICRO') ||
         value.includes('EXECUTIONMICRO') ||
         value.includes('REFINED_EXECUTION')
    );
}


function parseLongTaxonomyMicroId(id = '') {
    const rawId = String(id || '').trim();
    const value = rawId.toUpperCase();


    if (!value.startsWith('MICRO_LONG_')) {
         return {
              valid: false,
              selectable: false,
              isParent: false,
              isChild: false,
              rawId
         };
    }


    if (isScannerFingerprintId(value) || isExecutionFingerprintId(value)) {
         return {
              valid: false,
              selectable: false,
              isParent: false,
              isChild: false,
              rawId
         };
    }


    let body = value.slice('MICRO_LONG_'.length);
    let confirmationProfile = null;
for (const profile of CONFIRMATION_PROFILES) {
    const suffix = `_${profile}`;


    if (body.endsWith(suffix)) {
        confirmationProfile = profile;
        body = body.slice(0, -suffix.length);
        break;
    }
}


let setupType = null;
let regimeBucket = null;


for (const candidateRegime of REGIME_BUCKETS) {
    const suffix = `_${candidateRegime}`;


    if (body.endsWith(suffix)) {
        regimeBucket = candidateRegime;
        setupType = body.slice(0, -suffix.length);
        break;
    }
}


const parentId = setupType && regimeBucket
    ? `MICRO_LONG_${setupType}_${regimeBucket}`
    : null;


const childId = parentId && confirmationProfile
    ? `${parentId}_${confirmationProfile}`
    : null;


const validParent =
    Boolean(parentId) &&
    SETUP_SET.has(setupType) &&
    REGIME_SET.has(regimeBucket);


const validChild =
    validParent &&
    Boolean(confirmationProfile) &&
    CONFIRMATION_SET.has(confirmationProfile);


return {
    valid: validParent || validChild,
    selectable: validChild,
    isParent: validParent && !validChild,
    isChild: validChild,
         rawId,
         id: validChild ? childId : validParent ? parentId : value,
         setupType,
         regimeBucket,
         confirmationProfile,
         parentTrueMicroFamilyId: validParent ? parentId : null,
         trueMicroFamilyId: validChild ? childId : validParent ? parentId : null,
         childTrueMicroFamilyId: validChild ? childId : null,
         trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
         parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
         childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
         learningGranularity: LEARNING_GRANULARITY,
         parentLearningGranularity: PARENT_LEARNING_GRANULARITY
    };
}


function isFixedTaxonomyChildId(id = '') {
    const parsed = parseLongTaxonomyMicroId(id);


    return parsed.isChild === true;
}


function isFixedTaxonomyParentId(id = '') {
    const parsed = parseLongTaxonomyMicroId(id);


    return parsed.isParent === true || parsed.isChild === true;
}


function cleanLearningMicroId(id = '') {
    const raw = String(id || '').trim();


    if (!raw) return '';
    if (isScannerFingerprintId(raw)) return '';
    if (isExecutionFingerprintId(raw)) return '';


    return raw.toUpperCase();
}


function rowId(row = {}) {
    return cleanLearningMicroId(
         row.trueMicroFamilyId ||
           row.childTrueMicroFamilyId ||
           row.microFamilyId ||
           row.analyzeMicroFamilyId ||
           row.learningMicroFamilyId ||
           row.broadTrueMicroFamilyId ||
           row.id ||
           row.key ||
           ''
    );
}


function rowIdUpper(row = {}) {
    return rowId(row).toUpperCase();
}


function parentTrueMicroFamilyIdFrom(row = {}) {
    const direct = cleanLearningMicroId(
         row.parentTrueMicroFamilyId ||
           row.coarseMicroFamilyId ||
           row.baseMicroFamilyId ||
           row.legacyMicroFamilyId ||
           row.parentMacroFamilyId ||
           row.parentMicroFamilyId ||
           row.macroFamilyId ||
           ''
    );


    const directParsed = parseLongTaxonomyMicroId(direct);


    if (directParsed.valid) {
         return directParsed.parentTrueMicroFamilyId;
    }


    const id = rowId(row);
    const parsed = parseLongTaxonomyMicroId(id);


    if (parsed.valid) {
         return parsed.parentTrueMicroFamilyId;
    }


    return '';
}


function idLooksLikeMicroFamily(id = '') {
    return String(id || '').toUpperCase().startsWith('MICRO_');
}


function idLooksLikeLongFamily(id = '') {
    return hasLongSignal(id);
}


function idLooksLikeShortFamily(id = '') {
    return hasShortSignal(id);
}


function idLooksLikeSimpleMacroFamily(id = '') {
    const value = String(id || '').trim().toUpperCase();


    return (
         /^LONG_F\d+$/u.test(value) ||
         /^LONG_\d+$/u.test(value)
    );
}


function hasSchemaInId(id, schema) {
    const s = normalizeSchema(schema);
    const value = String(id || '').toUpperCase();


    if (!s) return false;


    return (
         value.includes(`_${s}_`) ||
         value.endsWith(`_${s}`) ||
         value.includes(`|SCHEMA=${s}`) ||
         value.includes(`SCHEMA=${s}`)
    );
}


function definitionText(row = {}) {
    return [
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
         .map((value) => cleanSideText(value))
         .filter(Boolean)
         .join('|');
}


function definitionHasSchema(row = {}, schema) {
    const s = normalizeSchema(schema);
    if (!s) return false;


    const parts = [
         ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
         ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
         ...(Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts : []),
         ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : [])
    ];


    if (parts.some((part) => String(part).toUpperCase() === `SCHEMA=${s}`)) {
         return true;
    }


    return definitionText(row).includes(`SCHEMA=${s}`);
}


function rowSchema(row = {}) {
    return normalizeSchema(
         row.microFamilySchema ||
           row.trueMicroFamilySchema ||
           row.schema ||
           row.versionSchema ||
           ''
    );
}


function normalizeDirectSide(value) {
    const raw = cleanSideText(value);


    const direct = sideToTradeSide(raw);


    if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
    if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;


    if (['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'UPSIDE'].includes(raw)) {
         return TARGET_TRADE_SIDE;
    }


    if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE'].includes(raw)) {
         return OPPOSITE_TRADE_SIDE;
    }


    const longHit = hasLongSignal(raw);
    const shortHit = hasShortSignal(raw);


    if (longHit && !shortHit) return TARGET_TRADE_SIDE;
    if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;
    if (longHit && shortHit) {
        if (raw.includes('TRADE_SIDE=LONG') || raw.includes('TRADESIDE=LONG')) {
            return TARGET_TRADE_SIDE;
        }


        if (raw.includes('TRADE_SIDE=SHORT') || raw.includes('TRADESIDE=SHORT')) {
            return OPPOSITE_TRADE_SIDE;
        }


        if (raw.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
        if (raw.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
    }


    return 'UNKNOWN';
}


function definitionSide(row = {}) {
    const text = definitionText(row);
    const longHit = hasLongSignal(text);
    const shortHit = hasShortSignal(text);


    if (longHit && !shortHit) return TARGET_TRADE_SIDE;
    if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;


    if (longHit && shortHit) {
        if (text.includes('TRADE_SIDE=LONG') || text.includes('TRADESIDE=LONG')) {
            return TARGET_TRADE_SIDE;
        }


        if (text.includes('TRADE_SIDE=SHORT') || text.includes('TRADESIDE=SHORT')) {
            return OPPOSITE_TRADE_SIDE;
        }


        if (text.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
        if (text.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
    }


    return 'UNKNOWN';
}


function microSide(row = {}) {
    const direct = normalizeDirectSide(
        row.tradeSide ||
            row.positionSide ||
            row.direction ||
            row.signalSide ||
           row.scannerSide ||
           row.actualScannerSide ||
           row.analysisSide ||
           row.entrySide ||
           row.side
    );


    if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
    if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;


    const familyId = String(row.familyId || '').toUpperCase();
    const parentId = String(parentTrueMicroFamilyIdFrom(row) || '').toUpperCase();
    const microId = rowIdUpper(row);


    if (familyId.startsWith('SHORT_')) return OPPOSITE_TRADE_SIDE;
    if (idLooksLikeShortFamily(parentId) && !idLooksLikeLongFamily(parentId)) return
OPPOSITE_TRADE_SIDE;
    if (idLooksLikeShortFamily(microId) && !idLooksLikeLongFamily(microId)) return
OPPOSITE_TRADE_SIDE;


    if (familyId.startsWith('LONG_')) return TARGET_TRADE_SIDE;
    if (parentId.startsWith('MICRO_LONG_')) return TARGET_TRADE_SIDE;
    if (parentId.startsWith('LONG_')) return TARGET_TRADE_SIDE;
    if (idLooksLikeLongFamily(parentId)) return TARGET_TRADE_SIDE;
    if (idLooksLikeLongFamily(microId)) return TARGET_TRADE_SIDE;


    const fromDefinition = definitionSide(row);


    if (fromDefinition === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
    if (fromDefinition === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;


    if (row.longOnly === true || row.shortDisabled === true) {
         return TARGET_TRADE_SIDE;
    }


    if (row.shortOnly === true || row.longDisabled === true) {
         return OPPOSITE_TRADE_SIDE;
    }


    return 'UNKNOWN';
}


function normalizedSide(row = {}) {
    const side = microSide(row);


    if (side === TARGET_TRADE_SIDE) return TARGET_DASHBOARD_SIDE;
    return 'unknown';
}


function isLongRotationRow(row = {}) {
    return microSide(row) === TARGET_TRADE_SIDE;
}


export function isTrueMicroFamily(row = {}) {
    const id = rowIdUpper(row);


    if (!row || !id) return false;
    if (isScannerFingerprintId(id)) return false;
    if (isExecutionFingerprintId(id)) return false;
    if (!isLongRotationRow(row)) return false;


    return isFixedTaxonomyChildId(id);
}


export function isLegacyMacroFamily(row = {}) {
    const { macroSchema } = schemaMeta();


    const id = rowIdUpper(row);
    const schema = rowSchema(row);
    const version = String(row.version || '').toUpperCase();


    if (!row || !id) return false;
    if (isScannerFingerprintId(id)) return false;
    if (isExecutionFingerprintId(id)) return false;
    if (!isLongRotationRow(row)) return false;
    if (isTrueMicroFamily(row)) return false;


    if (isFixedTaxonomyParentId(id)) return true;
    if (row.parentTrueMicroFamilySchema === PARENT_TRUE_MICRO_SCHEMA) return true;
    if (schema === PARENT_TRUE_MICRO_SCHEMA) return true;


    if (row.isLegacyMacro === true) return true;
    if (version.includes('MACRO') || version.includes('PARENT')) return true;
    if (idLooksLikeSimpleMacroFamily(id)) return true;
    if (schema === macroSchema) return true;
    if (hasSchemaInId(id, macroSchema)) return true;
    if (definitionHasSchema(row, macroSchema)) return true;


    return false;
}


function isKnownTrueMicroId(id = '') {
    const value = cleanLearningMicroId(id);
    if (!value) return false;
    if (isScannerFingerprintId(value)) return false;
    if (isExecutionFingerprintId(value)) return false;
    if (!idLooksLikeLongFamily(value)) return false;
    if (idLooksLikeShortFamily(value) && !idLooksLikeLongFamily(value)) return
false;
    if (!idLooksLikeMicroFamily(value)) return false;


    return isFixedTaxonomyChildId(value);
}


function normalizeMeasurementFixVersion(value = '') {
    return String(value || '').trim().toUpperCase();
}


function rowMeasurementFixVersion(row = {}) {
    return normalizeMeasurementFixVersion(
         row.measurementFixVersion ??
           row.outcomeMeasurementVersion ??
           row.acceptedOutcomeMeasurementVersion ??
           row.positionMeasurementFixVersion ??
           row.measurementVersion ??
           row.exitMeasurementVersion ??
           ''
    );
}


function isCurrentMeasurementRow(row = {}) {
    return rowMeasurementFixVersion(row) === MEASUREMENT_FIX_VERSION;
}


function hasStoredOutcomeData(row = {}) {
    return (
         safeNumber(row.completed, 0) > 0 ||
         safeNumber(row.virtualCompleted, 0) > 0 ||
         safeNumber(row.shadowCompleted, 0) > 0 ||
         safeNumber(row.totalR ?? row.netTotalR ?? row.totalNetR, 0) !== 0 ||
         (Array.isArray(row.recentOutcomes) && row.recentOutcomes.length > 0)
    );
}


function isCurrentMeasurementOutcome(outcome = {}) {
    const source = String(
         outcome?.source || outcome?.outcomeSource || ''
    ).trim().toUpperCase();
    const hasR = Number.isFinite(Number(
         outcome?.netR ??
              outcome?.exitR ??
              outcome?.realizedNetR ??
              outcome?.realizedR ??
              outcome?.r
    ));


    return (
         hasR &&
         ['VIRTUAL', 'SHADOW'].includes(source) &&
         rowMeasurementFixVersion(outcome) === MEASUREMENT_FIX_VERSION
    );
}


function currentMeasurementRecentOutcomes(row = {}) {
    return (Array.isArray(row.recentOutcomes) ? row.recentOutcomes : [])
         .filter(isCurrentMeasurementOutcome);
}


function recentClosedVirtualOutcomeCount(row = {}) {
    return currentMeasurementRecentOutcomes(row).length;
}


function measurementAggregateIntegrity(row = {}) {
    const sourceCompleted =
         safeNumber(row.virtualCompleted, 0) +
         safeNumber(row.shadowCompleted, 0);


    const completed = Math.max(
         sourceCompleted,
         safeNumber(row.completed, 0),
         safeNumber(row.outcomeSample, 0),
         0
    );


    const acceptedOutcomeCount = Math.max(
         0,
         safeNumber(row.measurementVersionAcceptedOutcomeCount, 0)
    );


    const recentOutcomes = Array.isArray(row.recentOutcomes)
         ? row.recentOutcomes
         : [];


    const nonCurrentRecentOutcomeCount = recentOutcomes
         .filter((outcome) => !isCurrentMeasurementOutcome(outcome))
         .length;


    const currentVersion = isCurrentMeasurementRow(row);


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


function completedCount(row = {}) {
    const integrity = measurementAggregateIntegrity(row);


    if (hasStoredOutcomeData(row) && !integrity.valid) {
         return 0;
    }


    const virtualCompleted = safeNumber(row.virtualCompleted, 0);
    const shadowCompleted = safeNumber(row.shadowCompleted, 0);
    const closed = virtualCompleted + shadowCompleted;


    if (closed > 0) return closed;


    const recentClosed = recentClosedVirtualOutcomeCount(row);


    if (recentClosed > 0) return recentClosed;


    if (allowLegacyCompletedFallback() && integrity.valid) {
         return Math.max(0, safeNumber(row.completed, 0));
    }


    return 0;
}


function currentMeasurementTotalR(row = {}) {
    const completed = completedCount(row);


    if (completed <= 0) return 0;


    const explicit = finiteOrNull(
         row.totalR ??
           row.netTotalR ??
           row.totalNetR ??
           row.longNetTotalR ??
           row.netLongTotalR
    );


    if (explicit !== null) return explicit;


    return currentMeasurementRecentOutcomes(row)
         .reduce((sum, outcome) => sum + safeNumber(
           outcome.netR ??
               outcome.exitR ??
               outcome.realizedNetR ??
               outcome.realizedR ??
               outcome.r,
           0
         ), 0);
}


function currentMeasurementAvgR(row = {}) {
    const completed = completedCount(row);


    if (completed <= 0) return 0;


    const explicit = finiteOrNull(
         row.avgR ??
           row.avgNetR ??
           row.netAvgR
    );


    if (explicit !== null) return explicit;


    return currentMeasurementTotalR(row) / completed;
}


function empiricalActivationGate(row = {}) {
    const completed = completedCount(row);
    const minCompleted = empiricalVetoMinCompleted();
    const maxAvgR = empiricalVetoMaxAvgR();
    const avgR = currentMeasurementAvgR(row);
    const totalR = currentMeasurementTotalR(row);
    const measurementVersion = rowMeasurementFixVersion(row);


    if (completed < minCompleted) {
         return {
           status: 'OBSERVING',
              blocked: false,
              discordEligible: true,
              reason: `COMPLETED_BELOW_${minCompleted}`,
              completed,
              minCompleted,
              avgR,
              totalR,
              maxAvgR,
              measurementVersion: measurementVersion || MEASUREMENT_FIX_VERSION
         };
    }


    if (avgR <= maxAvgR) {
         return {
              status: 'EMPIRICAL_VETO',
              blocked: true,
              discordEligible: false,
              reason: 'CURRENT_MEASUREMENT_NET_EDGE_NOT_POSITIVE',
              completed,
              minCompleted,
              avgR,
              totalR,
              maxAvgR,
              measurementVersion: measurementVersion || MEASUREMENT_FIX_VERSION
         };
    }


    return {
         status: 'PASSED',
         blocked: false,
         discordEligible: true,
         reason: null,
         completed,
         minCompleted,
         avgR,
         totalR,
         maxAvgR,
         measurementVersion: measurementVersion || MEASUREMENT_FIX_VERSION
    };
}


function isEmpiricallyVetoed(row = {}) {
    return empiricalActivationGate(row).blocked === true;
}


function observationSample(row = {}) {
    return Math.max(
         safeNumber(row.observationSample, 0),
         safeNumber(row.seen, 0),
         safeNumber(row.observations, 0),
         completedCount(row),
         0
    );
}


function learningStatus(row = {}) {
    const completed = completedCount(row);


    if (completed >= DEFAULT_MIN_WEIGHTED_COMPLETED) return 'ACTIVE_LEARNING';
    if (completed > 0) return 'EARLY_OUTCOMES';


    return 'OBSERVING';
}


function isEligible(row = {}) {
    if (!isLongRotationRow(row)) return false;
    if (!isTrueMicroFamily(row)) return false;
    if (isEmpiricallyVetoed(row)) return false;


    return completedCount(row) >= minWeightedCompleted();
}


function isSoftEligible(row = {}) {
    if (!allowSoftRotationFallback()) return false;
    if (!isLongRotationRow(row)) return false;
    if (!isTrueMicroFamily(row)) return false;
    if (isEmpiricallyVetoed(row)) return false;


    const completed = completedCount(row);
    const adaptiveScore = adaptiveSelectionScore(row);
    const balancedScore = safeNumber(
         row.dashboardBalancedScore ?? row.balancedScore,
         0
    );


    if (completed <= 0) return false;
    if (Math.max(adaptiveScore, balancedScore) <= 0) return false;


    return (
         safeNumber(row.avgR, 0) > 0 ||
         safeNumber(row.totalR, 0) > 0 ||
         safeNumber(row.fairWinrate, 0) > 0 ||
         safeNumber(row.sampleAdjustedWinrate, 0) > 0 ||
         safeNumber(row.wilsonLowerBound, 0) > 0 ||
         safeNumber(row.sampleWilsonLowerBound, 0) > 0
    );
}


function isObservationEligible(row = {}) {
    if (!allowObservationRotationFallback()) return false;
    if (!isLongRotationRow(row)) return false;
    if (!isTrueMicroFamily(row)) return false;
    if (isEmpiricallyVetoed(row)) return false;


    return observationSample(row) > 0;
}


function isRawFallbackEligible(row = {}) {
    if (!allowRawRotationFallback()) return false;
    if (!isLongRotationRow(row)) return false;
    if (!isTrueMicroFamily(row)) return false;
    if (isEmpiricallyVetoed(row)) return false;


    return true;
}


function rotationEligibilityTier(row = {}) {
    if (isEligible(row)) return 'HARD';
    if (isSoftEligible(row)) return 'SOFT';
    if (isObservationEligible(row)) return 'OBSERVATION';
    if (isRawFallbackEligible(row)) return 'RAW';


    return 'NONE';
}


function finiteOrNull(value) {
    if (value === undefined || value === null || value === '') return null;


    const n = Number(value);


    return Number.isFinite(n) ? n : null;
}


function bounded(value, min = 0, max = 100) {
    const n = safeNumber(value, min);


    if (n < min) return min;
    if (n > max) return max;


    return n;
}
function recentMomentumLookback() {
    const n = Number(
         CONFIG.long?.rotation?.recentMomentumLookback ??
           CONFIG.rotation?.recentMomentumLookback ??
           DEFAULT_RECENT_MOMENTUM_LOOKBACK
    );


    return Number.isFinite(n) && n > 0
         ? Math.floor(n)
         : DEFAULT_RECENT_MOMENTUM_LOOKBACK;
}


function staleWinnerDays() {
    const n = Number(
         CONFIG.long?.rotation?.staleWinnerDays ??
           CONFIG.rotation?.staleWinnerDays ??
           DEFAULT_STALE_WINNER_DAYS
    );


    return Number.isFinite(n) && n > 0
         ? Math.floor(n)
         : DEFAULT_STALE_WINNER_DAYS;
}


function marketBiasText(row = {}) {
    return [
         row.currentFit,
         row.entryCurrentFit,
         row.currentMarketFit,
         row.currentRegime,
         row.entryCurrentRegime,
         row.currentTrendSide,
         row.entryCurrentTrendSide,
         row.currentMarketNote,
         row.currentFitReason,
         row.marketBias,
         row.bias,
         row.side,
         row.tradeSide,
         row.positionSide,
         row.direction
    ]
         .map((value) => String(value || '').toUpperCase())
         .filter(Boolean)
         .join('|');
}
function hasBullishBias(row = {}) {
    const text = marketBiasText(row);


    return (
         text.includes('BULL') ||
         text.includes('BULLISH') ||
         text.includes('LONG') ||
         text.includes('BUY') ||
         text.includes('UPSIDE') ||
         text.includes('UP')
    );
}


function hasBearishBias(row = {}) {
    const text = marketBiasText(row);


    return (
         text.includes('BEAR') ||
         text.includes('BEARISH') ||
         text.includes('SHORT') ||
         text.includes('SELL') ||
         text.includes('DOWNSIDE') ||
         text.includes('DOWN')
    );
}


function currentFitScore(row = {}) {
    const explicitLong = finiteOrNull(
         row.longCurrentFitScore ??
           row.bullCurrentFitScore ??
           row.bullishCurrentFitScore ??
           row.entryLongCurrentFitScore ??
           row.entryBullCurrentFitScore
    );


    if (explicitLong !== null) return bounded(explicitLong, -100, 100);


    const explicitShort = finiteOrNull(
         row.shortCurrentFitScore ??
           row.bearCurrentFitScore ??
           row.bearishCurrentFitScore ??
           row.entryShortCurrentFitScore ??
           row.entryBearCurrentFitScore
    );


    if (explicitShort !== null) return bounded(-Math.abs(explicitShort), -100, 100);
const generic = finiteOrNull(
     row.currentFitScore ??
          row.entryCurrentFitScore ??
          row.marketFitScore ??
          row.currentMarketFitScore
);


if (generic !== null) {
     if (hasBullishBias(row)) return bounded(Math.abs(generic), -100, 100);
     if (hasBearishBias(row)) return bounded(-Math.abs(generic), -100, 100);


     return bounded(-generic, -100, 100);
}


const fit = String(
     row.longCurrentFit ??
          row.bullCurrentFit ??
          row.bullishCurrentFit ??
          row.currentFit ??
          row.entryCurrentFit ??
          row.currentMarketFit ??
          ''
).toUpperCase();


const confidence = bounded(
     row.currentFitConfidence ??
          row.entryCurrentFitConfidence ??
          row.currentMarketFitConfidence ??
          50,
     0,
     100
);


if (!fit) {
     if (hasBullishBias(row)) return confidence / 2;
     if (hasBearishBias(row)) return -confidence / 2;


     return 0;
}


if (
     fit === 'MATCH' ||
     fit === 'FIT' ||
     fit === 'GOOD' ||
     fit === 'STRONG' ||
     fit === 'ALIGNED' ||
        fit.includes('MATCH') ||
        fit.includes('ALIGNED') ||
        fit.includes('BULL') ||
        fit.includes('LONG') ||
        fit.includes('BUY')
    ) {
        if (fit.includes('BEAR') || fit.includes('SHORT') || fit.includes('SELL')) {
            return -confidence / 2;
        }


        return confidence / 2;
    }


    if (
        fit === 'MISFIT' ||
        fit === 'BAD' ||
        fit === 'WEAK' ||
        fit === 'CONTRA' ||
        fit === 'AGAINST' ||
        fit.includes('MISFIT') ||
        fit.includes('CONTRA') ||
        fit.includes('AGAINST') ||
        fit.includes('BEAR') ||
        fit.includes('SHORT') ||
        fit.includes('SELL')
    ) {
        return -confidence / 2;
    }


    return 0;
}


function currentContraPenalty(row = {}) {
    const explicit = finiteOrNull(row.currentContraPenalty);


    if (explicit !== null) return Math.max(0, explicit);


    const text = marketBiasText(row);


    if (
        text.includes('CONTRA') ||
        text.includes('AGAINST') ||
        text.includes('MISFIT') ||
        text.includes('BEAR') ||
        text.includes('SHORT') ||
        text.includes('SELL')
    ) {
        return 12;
    }


    return 0;
}


function recentMomentumScore(row = {}) {
    if (isEmpiricallyVetoed(row)) return -35;


    const explicit = finiteOrNull(row.recentMomentumScore);


    if (explicit !== null) return bounded(explicit, -100, 100);


    const rows = currentMeasurementRecentOutcomes(row)
        .slice(-recentMomentumLookback());


    if (!rows.length) return 0;


    const total = rows.reduce((sum, outcome) => {
        return sum + safeNumber(
             outcome.netR ??
                 outcome.exitR ??
                 outcome.realizedNetR ??
                 outcome.realizedR ??
                 outcome.r,
             0
        );
    }, 0);


    const avg = total / rows.length;
    const hitRate = rows.filter((outcome) => {
        const netR = safeNumber(
             outcome.netR ??
                 outcome.exitR ??
                 outcome.realizedNetR ??
                 outcome.realizedR ??
                 outcome.r,
             0
        );


        return netR > 0;
    }).length / rows.length;


    return bounded(
        avg * 18 +
             (hitRate - 0.5) * 24,
        -35,
         35
    );
}


function staleWinnerPenalty(row = {}) {
    const explicit = finiteOrNull(row.staleWinnerPenalty);


    if (explicit !== null) return Math.max(0, explicit);


    const completed = completedCount(row);
    const observations = observationSample(row);
    const totalR = currentMeasurementTotalR(row);
    const updatedAt = safeNumber(row.updatedAt || row.lastOutcomeAt ||
row.lastSeenAt, 0);


    if (completed <= 0 || totalR <= 0) return 0;
    if (observations > completed) return 0;
    if (updatedAt <= 0) return 0;


    const ageMs = now() - updatedAt;
    const maxAgeMs = staleWinnerDays() * 24 * 60 * 60 * 1000;


    if (ageMs <= maxAgeMs) return 0;


    return Math.min(25, ((ageMs - maxAgeMs) / maxAgeMs) * 10);
}


function avgCostPenalty(row = {}) {
    const avgCostR = Math.max(0, safeNumber(row.avgCostR, 0));


    return Math.min(30, avgCostR * 8);
}


function parentDiversificationBonus(row = {}, countsByParent = {}) {
    if (!parentDiversificationEnabled()) return 0;


    const parentId = parentTrueMicroFamilyIdFrom(row);


    if (!parentId) return 0;


    const selected = safeNumber(countsByParent[parentId], 0);


    if (selected <= 0) return 8;


    return Math.max(-20, -selected * 12);
}
function adaptiveSelectionScore(row = {}, {
    countsByParent = null
} = {}) {
    if (isEmpiricallyVetoed(row)) return EMPIRICAL_VETO_SCORE;


    const explicit = finiteOrNull(row.adaptiveScore);


    if (explicit !== null) return explicit;


    const balanced = safeNumber(row.dashboardBalancedScore ?? row.balancedScore, 0);
    const fair = safeNumber(row.fairWinrate ?? row.sampleAdjustedWinrate, 0);
    const totalR = currentMeasurementTotalR(row);
    const avgR = currentMeasurementAvgR(row);
    const completed = completedCount(row);
    const observations = observationSample(row);


    const qualityBonus =
         completed >= minWeightedCompleted()
           ? 20
           : completed > 0
             ? 10
             : observations > 0
                  ? 2
                  : 0;


    const observationBonus =
         completed <= 0 && observations > 0
           ? Math.min(8, Math.log1p(observations) * 2)
           : 0;


    return (
         balanced +
         fair * 30 +
         Math.log1p(Math.max(0, totalR)) * 10 +
         Math.log1p(Math.max(0, avgR)) * 8 +
         recentMomentumScore(row) +
         currentFitScore(row) +
         qualityBonus +
         observationBonus +
         (countsByParent ? parentDiversificationBonus(row, countsByParent) : 0) -
         staleWinnerPenalty(row) -
         currentContraPenalty(row) -
         avgCostPenalty(row)
    );
}


function compareAdaptiveRows(a, b) {
    return (
         adaptiveSelectionScore(b) - adaptiveSelectionScore(a) ||
         safeNumber(b.dashboardBalancedScore ?? b.balancedScore, 0) -
           safeNumber(a.dashboardBalancedScore ?? a.balancedScore, 0) ||
         safeNumber(b.fairWinrate ?? b.sampleAdjustedWinrate, 0) -
           safeNumber(a.fairWinrate ?? a.sampleAdjustedWinrate, 0) ||
         safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
         safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
         safeNumber(a.avgCostR, 0) - safeNumber(b.avgCostR, 0) ||
         safeNumber(a.directSLPct, 0) - safeNumber(b.directSLPct, 0) ||
         String(rowId(a)).localeCompare(String(rowId(b)))
    );
}


function sortAdaptiveRows(rows = []) {
    return [...rows].sort(compareAdaptiveRows);
}


function isManualEligible(row = {}) {
    return isLongRotationRow(row) && isTrueMicroFamily(row);
}


function isManualActiveRotation(rotation = {}) {
    if (!rotation || typeof rotation !== 'object') return false;


    const source = String(rotation.source || '').trim().toUpperCase();
    const mode = String(rotation.mode || '').trim().toUpperCase();


    if (rotation.manualOnly === true) return true;
    if (rotation.adminSelected === true) return true;
    if (mode === 'MANUAL' || mode === 'SELECTED') return true;
    if (source.includes('MANUAL')) return true;
    if (source.includes('SELECTED')) return true;
    if (source.startsWith('ADMIN_')) return true;
    if (source.startsWith('CLI_MANUAL')) return true;
    if (MANUAL_ACTIVE_SOURCES.has(source)) return true;


    return false;
}


function taxonomyMetaForId(id = '') {
    const parsed = parseLongTaxonomyMicroId(id);


    if (!parsed.valid) {
         return {
           setupType: null,
           regimeBucket: null,
              confirmationProfile: null,
              parentTrueMicroFamilyId: null,
              childTrueMicroFamilyId: null,
              fixedTaxonomyLearningId: false,
              selectable: false
         };
    }


    return {
         setupType: parsed.setupType,
         regimeBucket: parsed.regimeBucket,
         confirmationProfile: parsed.confirmationProfile,
         parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
         childTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
         fixedTaxonomyLearningId: parsed.isChild,
         selectable: parsed.isChild
    };
}


function compactRotationRow(row = {}, rank = 0) {
    const refreshed = refreshStats(row);
    const side = normalizedSide(refreshed);
    const tradeSide = microSide(refreshed);
    const meta = schemaMeta();
    const completed = completedCount(refreshed);
    const status = learningStatus(refreshed);
    const gate = empiricalActivationGate(refreshed);
    const eligibility = rotationEligibilityTier(refreshed);


    const microFamilyId = rowId(refreshed);
    const taxonomy = taxonomyMetaForId(microFamilyId);
    const parentId = taxonomy.parentTrueMicroFamilyId ||
parentTrueMicroFamilyIdFrom(refreshed);


    const adaptiveScore = adaptiveSelectionScore(refreshed);
    const recentMomentum = recentMomentumScore(refreshed);
    const fitScore = currentFitScore(refreshed);
    const contraPenalty = currentContraPenalty(refreshed);
    const costPenalty = avgCostPenalty(refreshed);
    const stalePenalty = staleWinnerPenalty(refreshed);


    return {
         rank,


         microFamilyId,
         trueMicroFamilyId: microFamilyId,
         childTrueMicroFamilyId: microFamilyId,
analyzeMicroFamilyId: microFamilyId,
learningMicroFamilyId: microFamilyId,


familyId: refreshed.familyId || null,


coarseMicroFamilyId: parentId || null,
baseMicroFamilyId: parentId || null,
legacyMicroFamilyId: parentId || null,


macroFamilyId: parentId || null,
parentMacroFamilyId: parentId || null,
parentMicroFamilyId: parentId || null,
parentTrueMicroFamilyId: parentId || null,


side,
tradeSide,
positionSide: TARGET_TRADE_SIDE,
direction: TARGET_TRADE_SIDE,


targetTradeSide: TARGET_TRADE_SIDE,
targetScannerSide: TARGET_SCANNER_SIDE,
dashboardSide: TARGET_DASHBOARD_SIDE,


longOnly: true,
shortDisabled: true,
shortOnly: false,
longDisabled: false,


schema: TRUE_MICRO_SCHEMA,
microFamilySchema: TRUE_MICRO_SCHEMA,
trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
parentMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
version: refreshed.version || 'child-fixed-taxonomy-75',


isTrueMicro: isTrueMicroFamily(refreshed),
isChildTrueMicro: isTrueMicroFamily(refreshed),
isLegacyMacro: false,
isParentTrueMicro: false,
selectable: isKnownTrueMicroId(microFamilyId),
selectionGranularity: 'EXACT_75_CHILD',
parentSelectionAllowed: false,


setupType: refreshed.setupType || taxonomy.setupType,
regimeBucket: refreshed.regimeBucket || taxonomy.regimeBucket,
    confirmationProfile: refreshed.confirmationProfile ||
taxonomy.confirmationProfile,
    fixedTaxonomyLearningId: taxonomy.fixedTaxonomyLearningId ||
Boolean(refreshed.fixedTaxonomyLearningId),


    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,


    rotationEligibilityTier: eligibility,
    rotationEligible: eligibility !== 'NONE',
    hardEligible: eligibility === 'HARD',
    softEligible: eligibility === 'SOFT',
    observationEligible: eligibility === 'OBSERVATION',
    rawEligible: eligibility === 'RAW',


    measurementFixVersion:
      rowMeasurementFixVersion(refreshed) ||
      MEASUREMENT_FIX_VERSION,
    acceptedOutcomeMeasurementVersion:
      refreshed.acceptedOutcomeMeasurementVersion ||
      MEASUREMENT_FIX_VERSION,
    completedCurrentMeasurementOnly: true,
    strictOutcomeMeasurementGate: true,
    legacyOutcomeMeasurementsExcluded: true,
    exitFillModelVersion:
      refreshed.exitFillModelVersion ||
      EXIT_FILL_MODEL_VERSION,
    exitFillPolicy:
      refreshed.exitFillPolicy ||
      'TP_SL_USE_TRIGGER_BOUNDARY_TIME_STOP_USES_OBSERVED_PRICE',


    activationGateStatus: gate.status,
    activationGateReason: gate.reason,
    activationGatePassed: gate.status === 'PASSED',
    empiricalVeto: gate.blocked,
    empiricalVetoed: gate.blocked,
    empiricalVetoPolicyVersion: EMPIRICAL_VETO_POLICY_VERSION,
    empiricalVetoMinCompleted: gate.minCompleted,
    empiricalVetoMaxAvgR: gate.maxAvgR,
    empiricalVetoCompleted: gate.completed,
    empiricalVetoAvgR: gate.avgR,
    empiricalVetoTotalR: gate.totalR,
    empiricalVetoReason: gate.blocked ? gate.reason : null,
    empiricalVetoBlocksAdaptiveSelection: true,
    empiricalVetoBlocksManualActivation: true,
    empiricalVetoCanRecover: true,
    discordEligible: gate.discordEligible,
discordFamilyGateEligible: gate.discordEligible,
temporalRuntimeCheckRequired: true,
discordBlocked: gate.blocked,
discordBlockReason: gate.blocked
     ? 'EMPIRICAL_VETO_CURRENT_MEASUREMENT_NET_EDGE_NOT_POSITIVE'
     : null,


learningStatus: status,
status,
tooEarly: completed < DEFAULT_MIN_WEIGHTED_COMPLETED,
tooEarlyReason: completed < DEFAULT_MIN_WEIGHTED_COMPLETED
     ? `completed ${completed}/${DEFAULT_MIN_WEIGHTED_COMPLETED}`
     : null,


seen: safeNumber(refreshed.seen, 0),
observations: safeNumber(refreshed.observations ?? refreshed.seen, 0),
observationSample: observationSample(refreshed),
observationAlwaysCounted: false,
observationDedupeRequired: true,
seenDefinition: 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY',


completed,
outcomeSample: completed,


realCompleted: 0,
virtualCompleted: safeNumber(refreshed.virtualCompleted, 0),
shadowCompleted: safeNumber(refreshed.shadowCompleted, 0),


winrateSample: safeNumber(refreshed.winrateSample ?? completed, 0),
winrate: safeNumber(refreshed.winrate, 0),
bayesianWinrate: safeNumber(refreshed.bayesianWinrate, 0),
wilsonLowerBound: safeNumber(refreshed.wilsonLowerBound, 0),
sampleWilsonLowerBound: safeNumber(
     refreshed.sampleWilsonLowerBound ?? refreshed.wilsonLowerBound,
     0
),
fairWinrate: safeNumber(refreshed.fairWinrate, 0),
sampleAdjustedWinrate: safeNumber(refreshed.sampleAdjustedWinrate, 0),
sampleReliability: safeNumber(refreshed.sampleReliability, 0),


avgR: currentMeasurementAvgR(refreshed),
totalR: currentMeasurementTotalR(refreshed),
avgWinR: safeNumber(refreshed.avgWinR, 0),
avgLossR: safeNumber(refreshed.avgLossR, 0),


profitFactor: safeNumber(refreshed.profitFactor, 0),
directSLPct: safeNumber(refreshed.directSLPct, 0),
    nearTpPct: safeNumber(refreshed.nearTpPct, 0),
    reachedHalfRPct: safeNumber(refreshed.reachedHalfRPct, 0),
    reachedOneRPct: safeNumber(refreshed.reachedOneRPct, 0),


    beWouldExitPct: safeNumber(refreshed.beWouldExitPct, 0),
    gaveBackAfterHalfRPct: safeNumber(refreshed.gaveBackAfterHalfRPct, 0),
    gaveBackAfterOneRPct: safeNumber(refreshed.gaveBackAfterOneRPct, 0),
    nearTpThenLossPct: safeNumber(refreshed.nearTpThenLossPct, 0),


    totalCostR: safeNumber(refreshed.totalCostR, 0),
    avgCostR: safeNumber(refreshed.avgCostR, 0),


    balancedScore: safeNumber(refreshed.balancedScore, 0),
    dashboardBalancedScore: safeNumber(
         refreshed.dashboardBalancedScore ?? refreshed.balancedScore,
         0
    ),


    recentMomentumScore: recentMomentum,
    currentFitScore: fitScore,
    longCurrentFitScore: fitScore,
    bullCurrentFitScore: fitScore,
    shortCurrentFitScore: -Math.abs(fitScore),
    bearCurrentFitScore: -Math.abs(fitScore),
    currentContraPenalty: contraPenalty,
    avgCostPenalty: costPenalty,
    staleWinnerPenalty: stalePenalty,
    adaptiveScore,


    adaptiveScoreFormula:
         'balancedScore + fairWinrate + totalR + avgR + recentMomentumScore + longCurrentFitScore + parentDiversificationBonus - staleWinnerPenalty - currentContraPenalty - avgCostPenalty',


    adaptiveSelectionEnabled: true,
    parentDiversificationEnabled: parentDiversificationEnabled(),
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
    currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
    learningRemainsBroad: true,
    selectionIsAdaptive: true,
    discordWillBeStrict: true,


    currentFit: fitScore,
    longCurrentFit: fitScore,
    bullCurrentFit: fitScore,
    bearishCurrentFit: -Math.abs(fitScore),
    shortCurrentFit: -Math.abs(fitScore),
    currentFitConfidence: refreshed.currentFitConfidence ??
refreshed.entryCurrentFitConfidence ?? null,
    currentRegime: refreshed.currentRegime ?? refreshed.entryCurrentRegime ??
null,
    currentTrendSide: refreshed.currentTrendSide ??
refreshed.entryCurrentTrendSide ?? null,


    riskTradeSide: TARGET_TRADE_SIDE,
    riskGeometryRule: 'LONG: sl < entry < tp',
    tpHitRule: 'LONG: price >= tp',
    slHitRule: 'LONG: price <= sl',
    grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
    currentRFormula: '(currentPrice - entry) / (entry - initialSl)',


    assetClass: refreshed.assetClass || null,


    rsiZone: refreshed.rsiZone || null,
    rsiCoarse: refreshed.rsiCoarse || null,


    flow: refreshed.flow || null,
    flowCoarse: refreshed.flowCoarse || null,


    obRelation: refreshed.obRelation || null,


    btcState: refreshed.btcState || null,
    btcRelation: refreshed.btcRelation || null,


    regime: refreshed.regime || null,
    regimeCoarse: refreshed.regimeCoarse || null,


    scannerReason: refreshed.scannerReason || null,
    scannerReasonCoarse: refreshed.scannerReasonCoarse || null,


    scannerMicroFamilyId: refreshed.scannerMicroFamilyId || null,
    scannerFamilyId: refreshed.scannerFamilyId || null,
    scannerDefinition: refreshed.scannerDefinition || null,
    scannerDefinitionParts: Array.isArray(refreshed.scannerDefinitionParts)
        ? refreshed.scannerDefinitionParts
        : [],


    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
executionMicroFamilyId: refreshed.executionMicroFamilyId || null,
executionFingerprintRole: 'METADATA_ONLY',
executionFingerprintsMetadataOnly: true,
executionFingerprintsUsedAsLearningFamily: false,


learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
exactTrueMicroFamilyRequired: true,
symbolExcludedFromFamilyId: true,
coinNameExcludedFromFamilyId: true,
hashesExcludedFromFamilyId: true,


definitionParts: Array.isArray(refreshed.definitionParts)
  ? refreshed.definitionParts
  : [],


definition: refreshed.definition || '',


parentDefinitionParts: Array.isArray(refreshed.parentDefinitionParts)
  ? refreshed.parentDefinitionParts
  : [],


parentDefinition: refreshed.parentDefinition || '',


counters: refreshed.counters || {},


examples: Array.isArray(refreshed.examples)
  ? refreshed.examples.slice(0, 20)
  : [],


recentOutcomes: currentMeasurementRecentOutcomes(refreshed)
  .slice(-20),


completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
completedOnlyClosedVirtualOrShadow: true,
scoringRSource: 'netR',
winsLossesFlatsSource: 'netR',
winrateDefinition: 'netR > 0',
avgRSource: 'netR',
totalRSource: 'netR',
avgCostRShown: true,
avgCostRSource: 'costR',


temporalContextVersion:
  refreshed.temporalContextVersion || TEMPORAL_CONTEXT_VERSION,
weekendPolicyVersion:
  refreshed.weekendPolicyVersion || WEEKEND_POLICY_VERSION,
     sessionPolicyVersion:
          refreshed.sessionPolicyVersion || SESSION_POLICY_VERSION,
     weekendMode: temporalPolicyMode(),
     sessionMode: temporalPolicyMode(),
     contextStats: refreshed.contextStats || {
          WEEKDAY: {},
          WEEKEND: {}
     },
     sessionStats: refreshed.sessionStats || {
          ASIA: {},
          EUROPE: {},
          US: {},
          ASIA_EU_OVERLAP: {},
          EU_US_OVERLAP: {},
          OFF_HOURS: {}
     },
     lastObservationDayType: refreshed.lastObservationDayType || null,
     lastObservationSessionBucket:
          refreshed.lastObservationSessionBucket || null,
     lastOutcomeDayType: refreshed.lastOutcomeDayType || null,
     lastOutcomeSessionBucket:
          refreshed.lastOutcomeSessionBucket || null,
     weekendLearningAllowed: true,
     weekendVirtualEntryAllowed: true,
     weekendDiscordEntryAllowed: temporalPolicyMode() !== 'ENFORCE',
     weekendDefaultWouldBlockWhenWeekend: true,
     weekendExitMonitoringAllowed: true,
     weekendOutcomeRecordingAllowed: true,
     sessionLearningAllowed: true,
     sessionVirtualEntryAllowed: true,
     sessionDiscordEntryAllowed: true,
     sessionPolicyObservedOnly: true,
     temporalPolicyDoesNotOverrideActivationGate: true,


     trueMicroOnly: true,
     exactTrueMicroOnly: true,
     allowCoarseMicroAliasLiveEntries: false,
     allowCoarseMicroAliasForDiscord: false,


     redisNamespace: LONG_NAMESPACE,
     redisKeyPrefix: LONG_KEY_PREFIX,
     persistentLearningKey: PERSISTENT_LEARNING_KEY,
     redisKeysSeparatedFromShortRoot: true,
     shortRootTouched: false,


     fallbackTrueMicroSchema: meta.fallbackTrueMicroSchema
};
}


function canUseParentSlot({
    row,
    countsByParent
}) {
    const parentCap = maxPerParentTrueMicroFamily();


    if (parentCap <= 0) return true;


    const parentId = parentTrueMicroFamilyIdFrom(row);


    if (!parentId) return true;


    return safeNumber(countsByParent[parentId], 0) < parentCap;
}


function reserveParentSlot({
    row,
    countsByParent
}) {
    const parentId = parentTrueMicroFamilyIdFrom(row);


    if (!parentId) return;


    countsByParent[parentId] = safeNumber(countsByParent[parentId], 0) + 1;
}


function addSelectedRow({
    row,
    selected,
    selectedIds,
    countsBySide,
    countsByParent
}) {
    const id = rowId(row);
    const side = microSide(row);


    if (!id) return false;
    if (isScannerFingerprintId(id)) return false;
    if (isExecutionFingerprintId(id)) return false;
    if (!isKnownTrueMicroId(id)) return false;
    if (selectedIds.has(id)) return false;
    if (side !== TARGET_TRADE_SIDE) return false;
    if (!isTrueMicroFamily(row)) return false;
    if (isEmpiricallyVetoed(row)) return false;
    if (!canUseParentSlot({ row, countsByParent })) return false;
    selectedIds.add(id);
    countsBySide[TARGET_TRADE_SIDE] = safeNumber(countsBySide[TARGET_TRADE_SIDE], 0)
+ 1;
    reserveParentSlot({ row, countsByParent });


    selected.push({
         ...row,
         microFamilyId: id,
         trueMicroFamilyId: id,
         childTrueMicroFamilyId: id,
         analyzeMicroFamilyId: id,
         learningMicroFamilyId: id,
         parentTrueMicroFamilyId: parentTrueMicroFamilyIdFrom(row),
         adaptiveScore: adaptiveSelectionScore(row, { countsByParent }),
         activationGateStatus: empiricalActivationGate(row).status,
         empiricalVeto: false,
         empiricalVetoed: false,
         empiricalVetoPolicyVersion: EMPIRICAL_VETO_POLICY_VERSION,
         discordEligible: true,
         currentFitSoftOnly: true,
         currentFitBlocksLearning: false,
         currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
         currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT'
    });


    return true;
}


function buildSelectionState(existing = []) {
    const selected = [];
    const selectedIds = new Set();
    const countsBySide = {
         [TARGET_TRADE_SIDE]: 0
    };
    const countsByParent = {};


    for (const row of existing) {
         addSelectedRow({
           row,
           selected,
           selectedIds,
           countsBySide,
           countsByParent
         });
    }
    return {
         selected,
         selectedIds,
         countsBySide,
         countsByParent
    };
}


function appendRowsToSelection({
    state,
    rows = [],
    targetCount = topNPerSide()
}) {
    const sortedRows = sortAdaptiveRows(rows);


    for (const row of sortedRows) {
         if (state.countsBySide[TARGET_TRADE_SIDE] >= targetCount) break;


         addSelectedRow({
           row,
           selected: state.selected,
           selectedIds: state.selectedIds,
           countsBySide: state.countsBySide,
           countsByParent: state.countsByParent
         });
    }


    return state.selected;
}


function hasSelectedSide(rows = [], side) {
    return rows.some((row) => microSide(row) === side);
}


function missingSides(rows = []) {
    return ROTATION_SIDES.filter((side) => !hasSelectedSide(rows, side));
}


function selectRotationCandidates(rankedCandidates = []) {
    const trueLongCandidates = sortAdaptiveRows(
         rankedCandidates
           .filter(isLongRotationRow)
           .filter(isTrueMicroFamily)
    );


    const empiricalVetoed = sortAdaptiveRows(
         trueLongCandidates.filter(isEmpiricallyVetoed)
);


const hardEligible = sortAdaptiveRows(trueLongCandidates.filter(isEligible));


const softEligible = sortAdaptiveRows(
     trueLongCandidates
       .filter((row) => !isEligible(row))
       .filter(isSoftEligible)
);


const observationEligible = sortAdaptiveRows(
     trueLongCandidates
       .filter((row) => !isEligible(row))
       .filter((row) => !isSoftEligible(row))
       .filter(isObservationEligible)
);


const rawFallback = sortAdaptiveRows(
     trueLongCandidates
       .filter((row) => !isEligible(row))
       .filter((row) => !isSoftEligible(row))
       .filter((row) => !isObservationEligible(row))
       .filter(isRawFallbackEligible)
);


const targetCount = topNPerSide();
const state = buildSelectionState();


appendRowsToSelection({
     state,
     rows: hardEligible,
     targetCount
});


if (allowSoftRotationFallback()) {
     appendRowsToSelection({
       state,
       rows: softEligible,
       targetCount
     });
}


if (allowObservationRotationFallback()) {
     appendRowsToSelection({
       state,
       rows: observationEligible,
       targetCount
         });
    }


    if (allowRawRotationFallback()) {
         appendRowsToSelection({
           state,
           rows: rawFallback,
           targetCount
         });
    }


    return {
         selected: state.selected,
         eligible: hardEligible,
         softEligible,
         observationEligible,
         rawFallback,
         empiricalVetoed,


         usedSoftFallback: state.selected.some((row) => rotationEligibilityTier(row)
=== 'SOFT'),
         usedObservationFallback: state.selected.some((row) =>
rotationEligibilityTier(row) === 'OBSERVATION'),
         usedRawFallback: state.selected.some((row) => rotationEligibilityTier(row) ===
'RAW'),


         parentDiversificationEnabled: parentDiversificationEnabled(),
         countsByParent: state.countsByParent,
         missingSides: missingSides(state.selected)
    };
}


function filterRankedRows(rows = [], filter = 'trueMicro') {
    const longRows = rows.filter(isLongRotationRow);


    if (filter === 'all') return longRows;
    if (filter === 'parent15') return longRows.filter(isLegacyMacroFamily);
    if (filter === 'legacyMacro') return longRows.filter(isLegacyMacroFamily);


    return longRows.filter(isTrueMicroFamily);
}


function buildRankings(micros, { filter = 'trueMicro' } = {}) {
    const modes = [
         'adaptive',
         'balanced',
         'winrate',
         'totalR',
         'avgR',
         'directSL',
         'observed'
    ];


    return Object.fromEntries(
         modes.map((mode) => {
              const rankedMode = mode === 'adaptive' ? 'balanced' : mode;


              const rows = sortAdaptiveRows(
                  filterRankedRows(rankMicros(micros, rankedMode), filter)
              )
                  .slice(0, MAX_TOP_N_PER_SIDE)
                  .map((row, index) => compactRotationRow(row, index + 1))
                  .filter((row) => filter !== 'trueMicro' ||
isKnownTrueMicroId(row.microFamilyId));


              return [mode, rows];
         })
    );
}


function buildSelectionIndexes(microFamilies = []) {
    const longRows = microFamilies
         .filter(isLongRotationRow)
         .filter(isTrueMicroFamily);


    const microFamilyIds = uniqueStrings(
         longRows.map((row) => row.trueMicroFamilyId || row.childTrueMicroFamilyId ||
row.microFamilyId)
    )
         .map(cleanLearningMicroId)
         .filter(Boolean)
         .filter(isKnownTrueMicroId);


    const parentTrueMicroFamilyIds = uniqueStrings(
         longRows.map((row) => row.parentTrueMicroFamilyId ||
parentTrueMicroFamilyIdFrom(row))
    )
         .map(cleanLearningMicroId)
         .filter(Boolean)
         .filter((id) => parseLongTaxonomyMicroId(id).valid)
         .map((id) => parseLongTaxonomyMicroId(id).parentTrueMicroFamilyId)
         .filter(Boolean);


    const microToParentTrueMicroFamilyId = {};
    const parentTrueMicroFamilyToMicroFamilyIds = {};


    for (const row of longRows) {
        const microId = cleanLearningMicroId(row.trueMicroFamilyId ||
row.childTrueMicroFamilyId || row.microFamilyId || '');
        const parentId = cleanLearningMicroId(row.parentTrueMicroFamilyId ||
parentTrueMicroFamilyIdFrom(row));


        if (!microId || !parentId) continue;
        if (!isKnownTrueMicroId(microId)) continue;
        if (!parseLongTaxonomyMicroId(parentId).valid) continue;


        microToParentTrueMicroFamilyId[microId] =
parseLongTaxonomyMicroId(parentId).parentTrueMicroFamilyId;


        if
(!parentTrueMicroFamilyToMicroFamilyIds[microToParentTrueMicroFamilyId[microId]])
{


parentTrueMicroFamilyToMicroFamilyIds[microToParentTrueMicroFamilyId[microId]] =
[];
        }



parentTrueMicroFamilyToMicroFamilyIds[microToParentTrueMicroFamilyId[microId]].push(microId);
    }


    for (const parentId of Object.keys(parentTrueMicroFamilyToMicroFamilyIds)) {
        parentTrueMicroFamilyToMicroFamilyIds[parentId] = uniqueStrings(
             parentTrueMicroFamilyToMicroFamilyIds[parentId]
        ).filter(isKnownTrueMicroId);
    }


    return {
        microFamilyIds,
        activeMicroFamilyIds: microFamilyIds,
        trueMicroFamilyIds: microFamilyIds,
        childTrueMicroFamilyIds: microFamilyIds,


        parentTrueMicroFamilyIds,
        macroFamilyIds: parentTrueMicroFamilyIds,
        activeMacroFamilyIds: parentTrueMicroFamilyIds,
        activeParentTrueMicroFamilyIds: parentTrueMicroFamilyIds,


        microToMacroFamilyId: microToParentTrueMicroFamilyId,
        microToParentTrueMicroFamilyId,
        macroToMicroFamilyIds: parentTrueMicroFamilyToMicroFamilyIds,
         parentTrueMicroFamilyToMicroFamilyIds
    };
}


function countByPredicate(micros = {}, predicate) {
    return Object.values(micros || {}).filter(predicate).length;
}


function bestLongRow(rows = []) {
    return sortAdaptiveRows(rows).find((row) => microSide(row) ===
TARGET_TRADE_SIDE) || null;
}


function mergeMicros(primary = {}, fallback = {}) {
    return {
         ...(fallback || {}),
         ...(primary || {})
    };
}


async function getRotationMicros(weekKey = PERSISTENT_LEARNING_KEY) {
    const dataWeekKey = learningDataKey(weekKey);
    const primary = await getWeekMicros(dataWeekKey);
    const primaryRows = Object.keys(primary || {}).length;


    const previousWeekKey = getPreviousIsoWeekKey();
    const shouldMergePrevious =
         dataWeekKey !== PERSISTENT_LEARNING_KEY &&
         dataWeekKey !== previousWeekKey &&
         primaryRows < minPrimaryRowsForPreviousMerge();


    if (!shouldMergePrevious) {
         return {
              micros: primary || {},
              primaryWeekKey: dataWeekKey,
              dataWeekKey,
              learningDataKey: dataWeekKey,
              previousWeekKey,
              primaryRows,
              previousRows: 0,
              usedPreviousWeekMerge: false,
              usedPersistentLearningKey: dataWeekKey === PERSISTENT_LEARNING_KEY
         };
    }


    const previous = await getWeekMicros(previousWeekKey).catch(() => ({}));
    const previousRows = Object.keys(previous || {}).length;
    if (previousRows <= 0) {
         return {
              micros: primary || {},
              primaryWeekKey: dataWeekKey,
              dataWeekKey,
              learningDataKey: dataWeekKey,
              previousWeekKey,
              primaryRows,
              previousRows: 0,
              usedPreviousWeekMerge: false,
              usedPersistentLearningKey: dataWeekKey === PERSISTENT_LEARNING_KEY
         };
    }


    return {
         micros: mergeMicros(primary, previous),
         primaryWeekKey: dataWeekKey,
         dataWeekKey,
         learningDataKey: dataWeekKey,
         previousWeekKey,
         primaryRows,
         previousRows,
         usedPreviousWeekMerge: true,
         usedPersistentLearningKey: dataWeekKey === PERSISTENT_LEARNING_KEY
    };
}


function buildEmptyRotation({
    weekKey,
    activeWeekKey,
    mode,
    micros,
    ranked,
    eligible,
    softEligible = [],
    observationEligible = [],
    rawFallback = [],
    empiricalVetoed = [],
    usedPreviousWeekMerge = false,
    usedPersistentLearningKey = false,
    primaryRows = 0,
    previousRows = 0,
    emptyReason = 'NO_LONG_75_CHILD_TRUE_MICRO_FAMILIES_AVAILABLE_FOR_ROTATION'
}) {
    const indexes = buildSelectionIndexes([]);
    const meta = schemaMeta();
return {
  rotationId: randomId(`ROT_${weekKey}_${mode}_long_candidate_snapshot`),
  source: 'ANALYZE_WEEKLY_CANDIDATE_SNAPSHOT_LONG_75_CHILD_TRUE_MICRO_ONLY',
  mode,


  sourceWeekKey: weekKey,
  activeWeekKey,
  dataWeekKey: weekKey,
  learningDataKey: weekKey,


  generatedAt: now(),
  strategyVersion: CONFIG.strategyVersion,


  schema: meta.schema,
  macroSchema: meta.macroSchema,
  microSchema: meta.microSchema,
  trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
  childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
  parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,


  ...modeFlags(),


  trueMicroOnly: true,
  exactTrueMicroOnly: true,
  usedLegacyFallback: false,
  usedSoftFallback: false,
  usedObservationFallback: false,
  usedRawFallback: false,
  usedPreviousWeekMerge,
  usedPersistentLearningKey,


  manualOnly: false,
  adminSelected: false,
  autoRotation: false,
  nextRotationOnly: true,
  activeRotationPreserved: true,
  activationDisabled: true,
  manualSelectionRequired: true,
  liveSelectable: false,


  minWeightedCompleted: minWeightedCompleted(),
  topNPerSide: topNPerSide(),
  maxPerParentTrueMicroFamily: maxPerParentTrueMicroFamily(),
  parentDiversificationEnabled: parentDiversificationEnabled(),


  eligibleCount: eligible?.length || 0,
    softEligibleCount: softEligible?.length || 0,
    observationEligibleCount: observationEligible?.length || 0,
    rawFallbackCount: rawFallback?.length || 0,
    empiricalVetoCount: empiricalVetoed?.length || 0,
    empiricalVetoMicroFamilyIds: empiricalVetoed
      .map((row) => rowId(row))
      .filter(Boolean),
    rankedCount: ranked.length,
    microCount: Object.keys(micros || {}).length,
    trueMicroCount: countByPredicate(micros, (row) => isTrueMicroFamily(row) &&
isLongRotationRow(row)),
    parentTrueMicroCount: countByPredicate(micros, (row) =>
isLegacyMacroFamily(row) && isLongRotationRow(row)),


    primaryRows,
    previousRows,


    missingSides: [TARGET_TRADE_SIDE],


    empty: true,
    emptyReason,


    bestLong: null,
    bestShort: null,


    microFamilyIds: indexes.microFamilyIds,
    activeMicroFamilyIds: indexes.activeMicroFamilyIds,
    trueMicroFamilyIds: indexes.trueMicroFamilyIds,
    childTrueMicroFamilyIds: indexes.childTrueMicroFamilyIds,


    macroFamilyIds: indexes.macroFamilyIds,
    activeMacroFamilyIds: indexes.activeMacroFamilyIds,
    parentTrueMicroFamilyIds: indexes.parentTrueMicroFamilyIds,
    activeParentTrueMicroFamilyIds: indexes.activeParentTrueMicroFamilyIds,


    microToMacroFamilyId: indexes.microToMacroFamilyId,
    microToParentTrueMicroFamilyId: indexes.microToParentTrueMicroFamilyId,
    macroToMicroFamilyIds: indexes.macroToMicroFamilyIds,
    parentTrueMicroFamilyToMicroFamilyIds:
indexes.parentTrueMicroFamilyToMicroFamilyIds,


    microFamilies: [],


    rankings: buildRankings(micros, { filter: 'trueMicro' }),
    parentRankings: buildRankings(micros, { filter: 'parent15' }),
    macroRankings: buildRankings(micros, { filter: 'parent15' }),
    allRankings: buildRankings(micros, { filter: 'all' })
    };
}


export async function buildRotationFromWeek({
    weekKey = PERSISTENT_LEARNING_KEY,
    activeWeekKey = getNextIsoWeekKey(),
    mode = defaultRotationMode()
} = {}) {
    const {
         micros,
         dataWeekKey,
         learningDataKey: resolvedLearningDataKey,
         primaryRows,
         previousRows,
         usedPreviousWeekMerge,
         usedPersistentLearningKey
    } = await getRotationMicros(weekKey);


    const rankMode = mode === 'adaptive' ? 'balanced' : mode;


    const rankedAll = sortAdaptiveRows(
         rankMicros(micros, rankMode)
           .filter(isLongRotationRow)
    );


    const rankedTrueMicros = sortAdaptiveRows(
         rankedAll.filter(isTrueMicroFamily)
    );


    const rankedCandidates = rankedTrueMicros;


    const {
         selected,
         eligible,
         softEligible,
         observationEligible,
         rawFallback,
         empiricalVetoed,
         usedSoftFallback,
         usedObservationFallback,
         usedRawFallback,
         missingSides: selectedMissingSides,
         countsByParent
    } = selectRotationCandidates(rankedCandidates);


    if (selected.length === 0) {
         return buildEmptyRotation({
      weekKey: dataWeekKey,
      activeWeekKey,
      mode,
      micros,
      ranked: rankedCandidates,
      eligible,
      softEligible,
      observationEligible,
      rawFallback,
      empiricalVetoed,
      usedPreviousWeekMerge,
      usedPersistentLearningKey,
      primaryRows,
      previousRows,
      emptyReason: rankedTrueMicros.length === 0
          ? 'NO_LONG_75_CHILD_TRUE_MICRO_FAMILIES_FOUND'
          : 'NO_LONG_75_CHILD_TRUE_MICRO_FAMILIES_AVAILABLE_FOR_CANDIDATE_SNAPSHOT'
    });
}


const microFamilies = sortAdaptiveRows(selected)
    .filter(isLongRotationRow)
    .filter(isTrueMicroFamily)
    .map((row, index) => compactRotationRow(row, index + 1))
    .filter((row) => row.microFamilyId)
    .filter((row) => isKnownTrueMicroId(row.microFamilyId));


const indexes = buildSelectionIndexes(microFamilies);
const meta = schemaMeta();


return {
    rotationId: randomId(`ROT_${dataWeekKey}_${mode}_long_candidate_snapshot`),
    source: 'ANALYZE_WEEKLY_CANDIDATE_SNAPSHOT_LONG_75_CHILD_TRUE_MICRO_ONLY',
    mode,


    sourceWeekKey: dataWeekKey,
    activeWeekKey,
    dataWeekKey,
    learningDataKey: resolvedLearningDataKey,


    generatedAt: now(),
    strategyVersion: CONFIG.strategyVersion,


    schema: meta.schema,
    macroSchema: meta.macroSchema,
    microSchema: meta.microSchema,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,


    ...modeFlags(),


    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    usedLegacyFallback: false,
    usedSoftFallback,
    usedObservationFallback,
    usedRawFallback,
    usedPreviousWeekMerge,
    usedPersistentLearningKey,


    manualOnly: false,
    adminSelected: false,
    autoRotation: false,
    nextRotationOnly: true,
    activeRotationPreserved: true,
    activationDisabled: true,
    manualSelectionRequired: true,
    liveSelectable: false,


    minWeightedCompleted: minWeightedCompleted(),
    topNPerSide: topNPerSide(),
    maxPerParentTrueMicroFamily: maxPerParentTrueMicroFamily(),
    parentDiversificationEnabled: parentDiversificationEnabled(),
    parentSelectionCounts: countsByParent,


    eligibleCount: eligible.length,
    softEligibleCount: softEligible.length,
    observationEligibleCount: observationEligible.length,
    rawFallbackCount: rawFallback.length,
    empiricalVetoCount: empiricalVetoed.length,
    empiricalVetoMicroFamilyIds: empiricalVetoed
      .map((row) => rowId(row))
      .filter(Boolean),
    rankedCount: rankedCandidates.length,
    allRankedCount: rankedAll.length,
    microCount: Object.keys(micros || {}).length,
    trueMicroCount: countByPredicate(micros, (row) => isTrueMicroFamily(row) &&
isLongRotationRow(row)),
    parentTrueMicroCount: countByPredicate(micros, (row) =>
isLegacyMacroFamily(row) && isLongRotationRow(row)),


    primaryRows,
    previousRows,
         missingSides: selectedMissingSides,


         empty: false,
         emptyReason: null,


         bestLong: bestLongRow(microFamilies),
         bestShort: null,


         candidateMicroFamilyIds: indexes.microFamilyIds,
         candidateTrueMicroFamilyIds: indexes.trueMicroFamilyIds,
         candidateParentTrueMicroFamilyIds: indexes.parentTrueMicroFamilyIds,
         candidateMacroFamilyIds: indexes.macroFamilyIds,


         microFamilyIds: indexes.microFamilyIds,
         activeMicroFamilyIds: indexes.activeMicroFamilyIds,
         trueMicroFamilyIds: indexes.trueMicroFamilyIds,
         childTrueMicroFamilyIds: indexes.childTrueMicroFamilyIds,


         macroFamilyIds: indexes.macroFamilyIds,
         activeMacroFamilyIds: indexes.activeMacroFamilyIds,
         parentTrueMicroFamilyIds: indexes.parentTrueMicroFamilyIds,
         activeParentTrueMicroFamilyIds: indexes.activeParentTrueMicroFamilyIds,


         microToMacroFamilyId: indexes.microToMacroFamilyId,
         microToParentTrueMicroFamilyId: indexes.microToParentTrueMicroFamilyId,
         macroToMicroFamilyIds: indexes.macroToMicroFamilyIds,
         parentTrueMicroFamilyToMicroFamilyIds:
indexes.parentTrueMicroFamilyToMicroFamilyIds,


         microFamilies,


         rankings: buildRankings(micros, { filter: 'trueMicro' }),
         parentRankings: buildRankings(micros, { filter: 'parent15' }),
         macroRankings: buildRankings(micros, { filter: 'parent15' }),
         allRankings: buildRankings(micros, { filter: 'all' })
    };
}


export async function freezeWeeklyRotation({
    weekKey = PERSISTENT_LEARNING_KEY,
    activeWeekKey = getNextIsoWeekKey(),
    mode = defaultRotationMode(),
    cutoffTs = now(),
    freezeSequence = null
} = {}) {
    const redis = getDurableRedis();
    const dataWeekKey = learningDataKey(weekKey);
    const normalizedCutoffTs = normalizeTemporalCutoffTs(cutoffTs);
    const [micros, activeDocument, existingNext] = await Promise.all([
        getWeekMicros(dataWeekKey),
        getRotationDocument(redis, rotationValidFromKey(), null).catch(() => null),
        getRotationDocument(redis, nextRotationKey(), null).catch(() => null)
    ]);
    await saveWeekMicros(dataWeekKey, micros);
    const rotation = await buildRotationFromWeek({
        weekKey: dataWeekKey,
        activeWeekKey,
        mode
    });
    const previousGeneration = priorTemporalGeneration(activeDocument, existingNext);
    const resolvedFreezeSequence = Number.isFinite(Number(freezeSequence))
        ? Math.max(1, Math.floor(Number(freezeSequence)))
        : Math.max(1, safeNumber(previousGeneration?.freezeSequence, 0) + 1);
    const generation = temporalStatsEnabled()
        ? await buildTemporalGeneration({
            micros,
            cutoffTs: normalizedCutoffTs,
            freezeSequence: resolvedFreezeSequence,
            previousGeneration
        })
        : null;
    const nextRotation = {
        ...rotation,
        temporalGeneration: generation,
        temporalGenerationId: generation?.generationId || null,
        temporalGenerationStatus: generation?.status || 'DISABLED',
        temporalStatsEnabled: temporalStatsEnabled(),
        temporalPolicyMode: temporalPolicyMode()
    };
    const nextRotationStorage = await setRotationDocument(redis, nextRotationKey(), nextRotation);
    const activationWindow = generation
        ? temporalActivationWindow(generation.generationCutoffTs)
        : null;
    const validFromDocument = {
        ...(activeDocument && typeof activeDocument === 'object' ? activeDocument : {}),
        validFrom: `${activeWeekKey}_MONDAY_00_UTC`,
        ts: now(),
        sourceWeekKey: dataWeekKey,
        activeWeekKey,
        dataWeekKey,
        learningDataKey: dataWeekKey,
        rotationId: rotation.rotationId,
        pendingTemporalGenerationId: generation?.generationId || null,
        pendingTemporalGenerationStatus: generation?.status || 'DISABLED',
        pendingTemporalGenerationCutoffTs: generation?.generationCutoffTs || null,
        pendingTemporalFreezeSequence: generation?.freezeSequence || null,
        temporalActivationScheduledAt: activationWindow?.startsAt || null,
        temporalActivationWindowExpiresAt: activationWindow?.expiresAt || null,
        ...modeFlags(),
        trueMicroOnly: true,
        exactTrueMicroOnly: true,
        manualOnly: false,
        adminSelected: false,
        autoRotation: false,
        nextRotationOnly: true,
        activeRotationPreserved: true,
        liveSelectable: false,
        manualSelectionRequired: true,
        usedLegacyFallback: false,
        usedSoftFallback: rotation.usedSoftFallback,
        usedObservationFallback: rotation.usedObservationFallback,
        usedRawFallback: rotation.usedRawFallback,
        usedPreviousWeekMerge: rotation.usedPreviousWeekMerge,
        usedPersistentLearningKey: rotation.usedPersistentLearningKey,
        selectedMicroFamilies: 0,
        selectedTrueMicroFamilies: 0,
        selectedParentTrueMicroFamilies: 0,
        candidateMicroFamilies: rotation.microFamilyIds.length,
        candidateTrueMicroFamilies: rotation.trueMicroFamilyIds.length,
        candidateParentTrueMicroFamilies: rotation.parentTrueMicroFamilyIds.length,
        empiricalVetoCount: safeNumber(rotation.empiricalVetoCount, 0),
        empiricalVetoMicroFamilyIds: rotation.empiricalVetoMicroFamilyIds || [],
        empiricalVetoPolicyVersion: EMPIRICAL_VETO_POLICY_VERSION,
        parentDiversificationEnabled: rotation.parentDiversificationEnabled,
        parentSelectionCounts: rotation.parentSelectionCounts || {},
        missingSides: rotation.missingSides || [],
        bestLong: rotation.bestLong?.microFamilyId || null,
        bestShort: null
    };
    const validFromStorage = await setRotationDocument(redis, rotationValidFromKey(), validFromDocument);
    await sendWeeklyRotationReport(
        nextRotation,
        generation?.status === 'READY'
            ? 'NEXT_ROTATION_AND_TEMPORAL_GENERATION_READY'
            : generation?.status === 'INVALID'
              ? 'NEXT_ROTATION_READY_TEMPORAL_GENERATION_INVALID'
              : 'NEXT_ROTATION_CANDIDATES_READY_MANUAL_75_CHILD_SELECTION_REQUIRED'
    ).catch(() => null);
    return {
        ok: generation ? generation.status === 'READY' : true,
        type: 'NEXT_ROTATION_CANDIDATES_AND_TEMPORAL_GENERATION_BUILT',
        weekKey: dataWeekKey,
        activeWeekKey,
        mode,
        rotationId: rotation.rotationId,
        temporalGenerationId: generation?.generationId || null,
        temporalGenerationStatus: generation?.status || 'DISABLED',
        temporalGenerationIntegrity: generation?.integrity || null,
        nextRotationStorage,
        validFromStorage,
        ...modeFlags(),
        trueMicroOnly: true,
        exactTrueMicroOnly: true,
        manualOnly: false,
        adminSelected: false,
        autoRotation: false,
        nextRotationOnly: true,
        activeRotationPreserved: true,
        liveSelectable: false,
        manualSelectionRequired: true,
        selectedMicroFamilies: 0,
        selectedTrueMicroFamilies: 0,
        selectedParentTrueMicroFamilies: 0,
        candidateMicroFamilies: rotation.microFamilyIds.length,
        candidateTrueMicroFamilies: rotation.trueMicroFamilyIds.length,
        candidateParentTrueMicroFamilies: rotation.parentTrueMicroFamilyIds.length,
        empiricalVetoCount: safeNumber(rotation.empiricalVetoCount, 0),
        empiricalVetoMicroFamilyIds: rotation.empiricalVetoMicroFamilyIds || [],
        empiricalVetoPolicyVersion: EMPIRICAL_VETO_POLICY_VERSION,
        parentDiversificationEnabled: rotation.parentDiversificationEnabled,
        parentSelectionCounts: rotation.parentSelectionCounts || {},
        usedLegacyFallback: false,
        usedSoftFallback: rotation.usedSoftFallback,
        usedObservationFallback: rotation.usedObservationFallback,
        usedRawFallback: rotation.usedRawFallback,
        usedPreviousWeekMerge: rotation.usedPreviousWeekMerge,
        usedPersistentLearningKey: rotation.usedPersistentLearningKey,
        missingSides: rotation.missingSides || [],
        bestLong: rotation.bestLong,
        bestShort: null,
        rotation: nextRotation
    };
}

function rotationRowStatsFingerprint(row = {}) {
    return JSON.stringify({
         id: rowId(row),
         updatedAt: safeNumber(row.updatedAt, 0),
         measurementFixVersion: rowMeasurementFixVersion(row),
         acceptedOutcomeCount: safeNumber(
              row.measurementVersionAcceptedOutcomeCount,
              0
         ),
         completed: safeNumber(row.completed, 0),
         virtualCompleted: safeNumber(row.virtualCompleted, 0),
         shadowCompleted: safeNumber(row.shadowCompleted, 0),
         totalR: safeNumber(row.totalR ?? row.netTotalR, 0),
         avgR: safeNumber(row.avgR ?? row.avgNetR, 0),
         currentFitScore: safeNumber(
              row.currentFitScore ?? row.longCurrentFitScore,
              0
         )
    });
}


function hydrateActiveRotationWithLatestMicros(
    rotation = {},
    latestMicros = {}
) {
    if (!rotation || typeof rotation !== 'object') {
         return {
              rotation,
              changed: false,
              hydratedCount: 0
         };
    }


    const existingRows = Array.isArray(rotation.microFamilies)
         ? rotation.microFamilies
         : [];


    const existingById = Object.fromEntries(
         existingRows
              .map((row) => [rowId(row), row])
              .filter(([id]) => Boolean(id))
    );


    const latestById = Object.fromEntries(
         Object.values(latestMicros || {})
              .filter(Boolean)
              .map((row) => [rowId(row), row])
              .filter(([id]) => Boolean(id))
    );


    const requestedIds = uniqueStrings([
         rotation.activeMicroFamilyIds || [],
         rotation.trueMicroFamilyIds || [],
         rotation.childTrueMicroFamilyIds || [],
         rotation.microFamilyIds || [],
         existingRows.map((row) => rowId(row))
    ])
         .map(cleanLearningMicroId)
         .filter(isKnownTrueMicroId);


    const hydratedRows = [];
let changed = false;
let hydratedCount = 0;


for (const id of requestedIds) {
    const existing = existingById[id] || null;
    const latest = latestById[id] || null;


    let merged = existing;


    if (latest) {
        merged = {
             ...(existing || {}),
             ...latest,
             microFamilyId: id,
             trueMicroFamilyId: id,
             childTrueMicroFamilyId: id,
             analyzeMicroFamilyId: id,
             learningMicroFamilyId: id,
             parentTrueMicroFamilyId:
               parentTrueMicroFamilyIdFrom(latest) ||
               parentTrueMicroFamilyIdFrom(existing || {}),
             manualOnly: rotation.manualOnly === true,
             adminSelected: rotation.adminSelected === true,
             active: true
        };


        hydratedCount += 1;


        if (
             rotationRowStatsFingerprint(existing || {}) !==
             rotationRowStatsFingerprint(merged)
        ) {
             changed = true;
        }
    } else if (!merged) {
        merged = buildManualOnlyRow(id, hydratedRows.length + 1);
        changed = true;
    }


    if (merged) hydratedRows.push(merged);
}


return {
    rotation: {
        ...rotation,
        microFamilies: hydratedRows,
        latestLearningStatsHydrated: hydratedCount > 0,
              latestLearningStatsHydratedCount: hydratedCount,
              latestLearningStatsHydratedAt: now()
         },
         changed,
         hydratedCount
    };
}


function sanitizeActiveRotation(rotation = {}, {
    requireManual = false
} = {}) {
    if (!rotation || typeof rotation !== 'object') return null;


    if (requireManual && !isManualActiveRotation(rotation)) {
         return null;
    }


    const rows = Array.isArray(rotation.microFamilies)
         ? rotation.microFamilies
         : [];


    const compactRows = sortAdaptiveRows(
         rows
              .filter(isLongRotationRow)
              .filter(isTrueMicroFamily)
    )
         .map((row, index) => compactRotationRow(row, index + 1))
         .filter((row) => row.microFamilyId)
         .filter((row) => isKnownTrueMicroId(row.microFamilyId));


    const vetoedRows = compactRows.filter(
         (row) => row.empiricalVeto === true ||
              row.empiricalVetoed === true ||
              row.discordBlocked === true
    );


    const longRows = compactRows.filter(
         (row) => !(
              row.empiricalVeto === true ||
              row.empiricalVetoed === true ||
              row.discordBlocked === true
         )
    );


    const indexes = buildSelectionIndexes(longRows);
    const manual = isManualActiveRotation(rotation);
  const priorVetoedIds = uniqueStrings(
      rotation.empiricalVetoRemovedMicroFamilyIds || []
  )
      .map(cleanLearningMicroId)
      .filter(isKnownTrueMicroId);


  const currentVetoedIds = vetoedRows
      .map((row) => row.microFamilyId)
      .filter(Boolean);


  const allVetoedIds = uniqueStrings([
      priorVetoedIds,
      currentVetoedIds
  ]);


  return {
      ...rotation,


      ...modeFlags(),


      trueMicroOnly: true,
      exactTrueMicroOnly: true,
      usedLegacyFallback: false,


      manualOnly: manual,
      adminSelected: manual,
      autoRotation: false,
      liveSelectable: manual && longRows.length > 0,


      microFamilies: longRows,


      microFamilyIds: indexes.microFamilyIds,
      activeMicroFamilyIds: indexes.activeMicroFamilyIds,
      trueMicroFamilyIds: indexes.trueMicroFamilyIds,
      childTrueMicroFamilyIds: indexes.childTrueMicroFamilyIds,


      macroFamilyIds: indexes.macroFamilyIds,
      activeMacroFamilyIds: indexes.activeMacroFamilyIds,
      parentTrueMicroFamilyIds: indexes.parentTrueMicroFamilyIds,
      activeParentTrueMicroFamilyIds: indexes.activeParentTrueMicroFamilyIds,


      microToMacroFamilyId: indexes.microToMacroFamilyId,
      microToParentTrueMicroFamilyId: indexes.microToParentTrueMicroFamilyId,
      macroToMicroFamilyIds: indexes.macroToMicroFamilyIds,
      parentTrueMicroFamilyToMicroFamilyIds:
indexes.parentTrueMicroFamilyToMicroFamilyIds,
         bestLong: bestLongRow(longRows),
         bestShort: null,
         missingSides: missingSides(longRows),


         parentDiversificationEnabled: parentDiversificationEnabled(),


         empiricalVetoPolicyVersion: EMPIRICAL_VETO_POLICY_VERSION,
         empiricalVetoRemovedCount: allVetoedIds.length,
         empiricalVetoRemovedMicroFamilyIds: allVetoedIds,


         empty: longRows.length === 0,
         emptyReason: longRows.length === 0
           ? allVetoedIds.length > 0
                ? 'ACTIVE_ROTATION_REMOVED_BY_EMPIRICAL_VETO'
                : rotation.emptyReason ||
                  'ACTIVE_ROTATION_CONTAINED_NO_MANUAL_LONG_75_CHILD_TRUE_MICRO_FAMILIES'
           : null
    };
}


export async function activateNextRotation({
    nowTs = now(),
    force = false,
    expectedActiveGenerationId = null
} = {}) {
    const runtime = temporalRuntimeConfig();
    if (!runtime.temporalStatsEnabled) {
        return {
            ok: false,
            skipped: true,
            changed: false,
            reason: 'TEMPORAL_STATS_DISABLED',
            ...modeFlags()
        };
    }
    const redis = getDurableRedis();
    const [nextRotation, pointerDocument] = await Promise.all([
        getRotationDocument(redis, nextRotationKey(), null),
        getRotationDocument(redis, rotationValidFromKey(), null)
    ]);
    const generation = nextRotation?.temporalGeneration || null;
    const validation = validateTemporalGeneration(generation, {
        nowTs: generation?.generationCutoffTs || nowTs,
        requireActive: false
    });
    if (!generation || generation.status !== 'READY' || !validation.valid) {
        return {
            ok: false,
            skipped: true,
            changed: false,
            reason: 'TEMPORAL_GENERATION_NOT_READY',
            validation,
            generationId: generation?.generationId || null,
            ...modeFlags()
        };
    }
    const activationWindow = temporalActivationWindow(generation.generationCutoffTs);
    const normalizedNowTs = normalizeTemporalCutoffTs(nowTs);
    if (!force && normalizedNowTs < activationWindow.startsAt) {
        return {
            ok: false,
            skipped: true,
            changed: false,
            reason: 'TEMPORAL_ACTIVATION_WINDOW_NOT_OPEN',
            activationWindow,
            generationId: generation.generationId,
            ...modeFlags()
        };
    }
    if (!force && normalizedNowTs >= activationWindow.expiresAt) {
        const expiredGeneration = {
            ...generation,
            status: 'ACTIVATION_WINDOW_EXPIRED',
            lifecycle: [
                ...(generation.lifecycle || []),
                { status: 'ACTIVATION_WINDOW_EXPIRED', ts: normalizedNowTs }
            ]
        };
        expiredGeneration.checksum = temporalChecksum(expiredGeneration);
        await setRotationDocument(redis, nextRotationKey(), {
            ...nextRotation,
            temporalGeneration: expiredGeneration,
            temporalGenerationStatus: expiredGeneration.status
        });
        return {
            ok: false,
            skipped: true,
            changed: true,
            reason: 'TEMPORAL_ACTIVATION_WINDOW_EXPIRED',
            activationWindow,
            generationId: generation.generationId,
            ...modeFlags()
        };
    }
    const currentId = String(pointerDocument?.activeTemporalGenerationId || '');
    const expectedId = expectedActiveGenerationId === null
        ? currentId
        : String(expectedActiveGenerationId || '');
    if (currentId !== expectedId) {
        return {
            ok: false,
            skipped: true,
            changed: false,
            reason: 'TEMPORAL_ACTIVE_GENERATION_CAS_EXPECTATION_MISMATCH',
            expectedActiveGenerationId: expectedId || null,
            actualActiveGenerationId: currentId || null,
            ...modeFlags()
        };
    }
    const activeGeneration = {
        ...generation,
        status: 'ACTIVE',
        activatedAt: normalizedNowTs,
        lifecycle: [
            ...(generation.lifecycle || []),
            { status: 'ACTIVE', ts: normalizedNowTs }
        ]
    };
    activeGeneration.checksum = temporalChecksum(activeGeneration);
    const previousActive = pointerDocument?.activeTemporalGeneration;
    const supersededPrevious = previousActive && previousActive.generationId !== activeGeneration.generationId
        ? {
            ...previousActive,
            status: 'SUPERSEDED',
            supersededAt: normalizedNowTs,
            supersededByGenerationId: activeGeneration.generationId
        }
        : null;
    if (supersededPrevious) supersededPrevious.checksum = temporalChecksum(supersededPrevious);
    const nextPointerDocument = {
        ...(pointerDocument && typeof pointerDocument === 'object' ? pointerDocument : {}),
        activeTemporalGenerationId: activeGeneration.generationId,
        activeTemporalGeneration: activeGeneration,
        previousTemporalGeneration: supersededPrevious,
        pendingTemporalGenerationId: null,
        pendingTemporalGenerationStatus: null,
        pendingTemporalGenerationCutoffTs: null,
        pendingTemporalFreezeSequence: null,
        temporalGenerationActivatedAt: normalizedNowTs,
        temporalGenerationPointerUpdatedAt: normalizedNowTs,
        activeWeekCompositionId: null,
        activeWeekCompositionBaseId: null,
        activeWeekCompositionMode: null,
        activeWeekComposition: null,
        weekCompositionClearedAtGenerationActivation: normalizedNowTs
    };
    const swapped = await compareAndSwapTemporalPointer(
        redis,
        rotationValidFromKey(),
        expectedId,
        nextPointerDocument
    );
    if (!swapped) {
        return {
            ok: false,
            skipped: true,
            changed: false,
            reason: 'TEMPORAL_ACTIVE_GENERATION_CAS_CONFLICT',
            expectedActiveGenerationId: expectedId || null,
            generationId: activeGeneration.generationId,
            ...modeFlags()
        };
    }
    const persisted = await getRotationDocument(redis, rotationValidFromKey(), null);
    if (persisted?.activeTemporalGenerationId !== activeGeneration.generationId) {
        throw new Error('TEMPORAL_ACTIVE_GENERATION_POINTER_POST_WRITE_VERIFICATION_FAILED');
    }
    await setRotationDocument(redis, nextRotationKey(), {
        ...nextRotation,
        temporalGeneration: null,
        temporalGenerationStatus: 'ACTIVE',
        activatedTemporalGenerationId: activeGeneration.generationId,
        activatedAt: normalizedNowTs,
        temporalGenerationMovedToAuthoritativePointer: true
    });
    return {
        ok: true,
        skipped: false,
        changed: true,
        reason: 'TEMPORAL_GENERATION_ACTIVATED',
        generationId: activeGeneration.generationId,
        previousGenerationId: currentId || null,
        activationWindow,
        ...modeFlags()
    };
}

export async function getActiveRotation() {
    const redis = getDurableRedis();


    const raw = await getJson(
         redis,
         activeRotationKey(),
         null
    );


    if (!raw || typeof raw !== 'object') {
         return null;
    }
const rawActiveIds = uniqueStrings([
     raw.activeMicroFamilyIds || [],
     raw.trueMicroFamilyIds || [],
     raw.childTrueMicroFamilyIds || [],
     raw.microFamilyIds || []
])
     .map(cleanLearningMicroId)
     .filter(isKnownTrueMicroId);


const rawRows = Array.isArray(raw.microFamilies)
     ? raw.microFamilies
     : [];


if (
     raw.empty === true &&
     rawActiveIds.length === 0 &&
     rawRows.length === 0
) {
     return null;
}


const latestMicros = await getWeekMicros(
     PERSISTENT_LEARNING_KEY
).catch(() => ({}));


const hydration = hydrateActiveRotationWithLatestMicros(
     raw,
     latestMicros
);


const sanitized = sanitizeActiveRotation(hydration.rotation, {
     requireManual: true
});


if (!sanitized) {
     return null;
}


const rawIds = uniqueStrings([
     raw?.activeMicroFamilyIds || [],
     raw?.trueMicroFamilyIds || [],
     raw?.childTrueMicroFamilyIds || [],
     raw?.microFamilyIds || []
])
     .map(cleanLearningMicroId)
     .filter(Boolean)
     .sort();
    const sanitizedIds = uniqueStrings([
         sanitized?.activeMicroFamilyIds || [],
         sanitized?.trueMicroFamilyIds || [],
         sanitized?.childTrueMicroFamilyIds || [],
         sanitized?.microFamilyIds || []
    ])
         .map(cleanLearningMicroId)
         .filter(Boolean)
         .sort();


    const selectionChanged =
         rawIds.join('|') !== sanitizedIds.join('|');


    const shouldPersistSanitized =
         hydration.changed ||
         raw?.shortOnly === true ||
         raw?.longDisabled === true ||
         raw?.targetTradeSide === OPPOSITE_TRADE_SIDE ||
         raw?.dashboardSide === 'bear' ||
         raw?.manualOnly !== true ||
         raw?.liveSelectable !== true ||
         raw?.autoRotation === true ||
         raw?.trueMicroFamilySchema !== TRUE_MICRO_SCHEMA ||
         sanitized.empiricalVetoRemovedCount > 0 ||
         selectionChanged;


    if (shouldPersistSanitized) {
         await setJson(
           redis,
           activeRotationKey(),
           sanitized
         ).catch(() => null);
    }


    if (sanitized.empty || !sanitized.microFamilyIds?.length) {
         return null;
    }


    return sanitized;
}


export async function getActiveRotationSet() {
    const active = await getActiveRotation();


    const ids = uniqueStrings([
         active?.activeMicroFamilyIds || [],
         active?.trueMicroFamilyIds || [],
         active?.childTrueMicroFamilyIds || [],
         active?.microFamilyIds || []
    ])
         .map(cleanLearningMicroId)
         .filter(isKnownTrueMicroId)
         .filter(idLooksLikeLongFamily);


    return new Set(ids);
}


export async function getActiveMacroRotationSet() {
    const active = await getActiveRotation();


    const ids = uniqueStrings([
         active?.activeParentTrueMicroFamilyIds || [],
         active?.parentTrueMicroFamilyIds || [],
         active?.activeMacroFamilyIds || [],
         active?.macroFamilyIds || []
    ])
         .map(cleanLearningMicroId)
         .filter(Boolean)
         .map((id) => parseLongTaxonomyMicroId(id).parentTrueMicroFamilyId)
         .filter(Boolean)
         .filter((id) => !isScannerFingerprintId(id))
         .filter((id) => !isExecutionFingerprintId(id));


    return new Set(ids);
}


function manualSideFromId(id = '') {
    const value = String(id || '').toUpperCase();


    if (isScannerFingerprintId(value)) return 'UNKNOWN';
    if (isExecutionFingerprintId(value)) return 'UNKNOWN';
    if (idLooksLikeShortFamily(value) && !idLooksLikeLongFamily(value)) return
OPPOSITE_TRADE_SIDE;
    if (idLooksLikeLongFamily(value)) return TARGET_TRADE_SIDE;


    return 'UNKNOWN';
}


function buildManualOnlyRow(id, rank) {
    const cleanId = cleanLearningMicroId(id);
    const tradeSide = manualSideFromId(cleanId);
    const taxonomy = taxonomyMetaForId(cleanId);
if (tradeSide !== TARGET_TRADE_SIDE) return null;
if (!isKnownTrueMicroId(cleanId)) return null;


return {
  rank,


  microFamilyId: cleanId,
  trueMicroFamilyId: cleanId,
  childTrueMicroFamilyId: cleanId,
  analyzeMicroFamilyId: cleanId,
  learningMicroFamilyId: cleanId,


  familyId: null,


  macroFamilyId: taxonomy.parentTrueMicroFamilyId,
  parentMacroFamilyId: taxonomy.parentTrueMicroFamilyId,
  parentMicroFamilyId: taxonomy.parentTrueMicroFamilyId,
  parentTrueMicroFamilyId: taxonomy.parentTrueMicroFamilyId,


  coarseMicroFamilyId: taxonomy.parentTrueMicroFamilyId,
  baseMicroFamilyId: taxonomy.parentTrueMicroFamilyId,
  legacyMicroFamilyId: taxonomy.parentTrueMicroFamilyId,


  side: TARGET_DASHBOARD_SIDE,
  tradeSide: TARGET_TRADE_SIDE,
  positionSide: TARGET_TRADE_SIDE,
  direction: TARGET_TRADE_SIDE,


  targetTradeSide: TARGET_TRADE_SIDE,
  targetScannerSide: TARGET_SCANNER_SIDE,
  dashboardSide: TARGET_DASHBOARD_SIDE,


  longOnly: true,
  shortDisabled: true,
  shortOnly: false,
  longDisabled: false,


  schema: TRUE_MICRO_SCHEMA,
  microFamilySchema: TRUE_MICRO_SCHEMA,
  trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
  childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
  exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
  parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
  version: 'manual_child_fixed_taxonomy_75',


  setupType: taxonomy.setupType,
  regimeBucket: taxonomy.regimeBucket,
confirmationProfile: taxonomy.confirmationProfile,
fixedTaxonomyLearningId: taxonomy.fixedTaxonomyLearningId,


isTrueMicro: true,
isChildTrueMicro: true,
isLegacyMacro: false,
selectable: true,
manualOnly: true,
unverifiedManualId: true,
parentSelectionAllowed: false,


rotationEligibilityTier: 'MANUAL',
rotationEligible: true,
hardEligible: false,
softEligible: false,
observationEligible: false,
rawEligible: false,


measurementFixVersion: MEASUREMENT_FIX_VERSION,
acceptedOutcomeMeasurementVersion: MEASUREMENT_FIX_VERSION,
completedCurrentMeasurementOnly: true,
strictOutcomeMeasurementGate: true,
legacyOutcomeMeasurementsExcluded: true,
exitFillModelVersion: EXIT_FILL_MODEL_VERSION,
exitFillPolicy:
  'TP_SL_USE_TRIGGER_BOUNDARY_TIME_STOP_USES_OBSERVED_PRICE',


activationGateStatus: 'OBSERVING',
activationGateReason:
  `COMPLETED_BELOW_${empiricalVetoMinCompleted()}`,
activationGatePassed: false,
empiricalVeto: false,
empiricalVetoed: false,
empiricalVetoPolicyVersion: EMPIRICAL_VETO_POLICY_VERSION,
empiricalVetoMinCompleted: empiricalVetoMinCompleted(),
empiricalVetoMaxAvgR: empiricalVetoMaxAvgR(),
empiricalVetoCompleted: 0,
empiricalVetoAvgR: 0,
empiricalVetoTotalR: 0,
empiricalVetoReason: null,
discordEligible: true,
discordBlocked: false,
discordBlockReason: null,


learningStatus: 'OBSERVING',
status: 'OBSERVING',
tooEarly: true,
tooEarlyReason: `completed 0/${DEFAULT_MIN_WEIGHTED_COMPLETED}`,


seen: 0,
observations: 0,
observationSample: 0,
observationAlwaysCounted: false,
observationDedupeRequired: true,


completed: 0,
outcomeSample: 0,
realCompleted: 0,
virtualCompleted: 0,
shadowCompleted: 0,


winrateSample: 0,
winrate: 0,
bayesianWinrate: 0,
wilsonLowerBound: 0,
sampleWilsonLowerBound: 0,
fairWinrate: 0,
sampleAdjustedWinrate: 0,
sampleReliability: 0,


avgR: 0,
totalR: 0,
avgWinR: 0,
avgLossR: 0,


profitFactor: 0,
directSLPct: 0,
nearTpPct: 0,
reachedHalfRPct: 0,
reachedOneRPct: 0,


beWouldExitPct: 0,
gaveBackAfterHalfRPct: 0,
gaveBackAfterOneRPct: 0,
nearTpThenLossPct: 0,


totalCostR: 0,
avgCostR: 0,


balancedScore: 0,
dashboardBalancedScore: 0,


recentMomentumScore: 0,
currentFitScore: 0,
         longCurrentFitScore: 0,
         bullCurrentFitScore: 0,
         shortCurrentFitScore: 0,
         bearCurrentFitScore: 0,
         adaptiveScore: 0,
         currentFitSoftOnly: true,
         currentFitBlocksLearning: false,
         currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
         currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',


         riskTradeSide: TARGET_TRADE_SIDE,
         riskGeometryRule: 'LONG: sl < entry < tp',
         tpHitRule: 'LONG: price >= tp',
         slHitRule: 'LONG: price <= sl',
         grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
         currentRFormula: '(currentPrice - entry) / (entry - initialSl)',


         definitionParts: [
              `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
              `MANUAL_TRUE_MICRO=${cleanId}`,
              `PARENT_TRUE_MICRO=${taxonomy.parentTrueMicroFamilyId}`,
              `SCHEMA=${TRUE_MICRO_SCHEMA}`,
              'SOURCE=MANUAL_SELECTION'
         ],
         definition: [
              `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
              `MANUAL_TRUE_MICRO=${cleanId}`,
              `PARENT_TRUE_MICRO=${taxonomy.parentTrueMicroFamilyId}`,
              `SCHEMA=${TRUE_MICRO_SCHEMA}`,
              'SOURCE=MANUAL_SELECTION'
         ].join(' | '),


         parentDefinitionParts: [
              `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
              `PARENT_TRUE_MICRO=${taxonomy.parentTrueMicroFamilyId}`,
              `SCHEMA=${PARENT_TRUE_MICRO_SCHEMA}`
         ],
         parentDefinition: [
              `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
              `PARENT_TRUE_MICRO=${taxonomy.parentTrueMicroFamilyId}`,
              `SCHEMA=${PARENT_TRUE_MICRO_SCHEMA}`
         ].join(' | '),


         ...modeFlags()
    };
}
function resolveManualSelection({
  requestedIds = [],
  micros = {}
}) {
  const selectedRows = [];
  const ignoredIds = [];
  const expandedFromMacro = {};
  const seen = new Set();


  const microsByUpperId = Object.fromEntries(
       Object.values(micros || {})
         .filter(Boolean)
         .map((row) => [
              rowId(row).toUpperCase(),
              row
         ])
         .filter(([id]) => Boolean(id))
  );


  const addRow = (row) => {
       const id = rowId(row);


       if (!id || seen.has(id)) return;
       if (isScannerFingerprintId(id)) return;
       if (isExecutionFingerprintId(id)) return;
       if (!isLongRotationRow(row)) return;
       if (!isTrueMicroFamily(row)) return;
       if (!isKnownTrueMicroId(id)) return;
       if (isEmpiricallyVetoed(row)) return;


       seen.add(id);
       selectedRows.push({
         ...row,
         microFamilyId: id,
         trueMicroFamilyId: id,
         childTrueMicroFamilyId: id,
         analyzeMicroFamilyId: id,
         learningMicroFamilyId: id,
         parentTrueMicroFamilyId: parentTrueMicroFamilyIdFrom(row),
         adaptiveScore: adaptiveSelectionScore(row),
         currentFitSoftOnly: true,
         currentFitBlocksLearning: false,
         currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
         currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT'
       });
  };
for (const requestedId of requestedIds) {
  const id = cleanLearningMicroId(requestedId);
  const side = manualSideFromId(id);
  const parsed = parseLongTaxonomyMicroId(id);


  if (side !== TARGET_TRADE_SIDE) {
      ignoredIds.push({
         id: requestedId,
         normalizedId: id,
         side,
         reason: side === OPPOSITE_TRADE_SIDE
            ? 'SHORT_DISABLED_LONG_ONLY'
            : 'UNKNOWN_OR_NON_LONG_ID_REJECTED'
      });
      continue;
  }


  if (parsed.isParent) {
      ignoredIds.push({
         id: requestedId,
         normalizedId: id,
         side,
         reason: 'PARENT_15_METADATA_ONLY_NOT_SELECTABLE_SELECT_EXACT_75_CHILD'
      });
      continue;
  }


  if (!isKnownTrueMicroId(id)) {
      ignoredIds.push({
         id: requestedId,
         normalizedId: id,
         side,
         reason: isScannerFingerprintId(id)
            ? 'SCANNER_FINGERPRINT_METADATA_ONLY_NOT_SELECTABLE'
            : isExecutionFingerprintId(id)
               ? 'EXECUTION_FINGERPRINT_METADATA_ONLY_NOT_SELECTABLE'
               : 'ONLY_EXACT_LONG_75_CHILD_TRUE_MICRO_IDS_ALLOWED'
      });
      continue;
  }


  const directRow = micros[id];
  const upperRow = microsByUpperId[id.toUpperCase()];
  const row = directRow || upperRow;


  if (
      row &&
        isLongRotationRow(row) &&
        isTrueMicroFamily(row) &&
        isManualEligible(row)
    ) {
        const gate = empiricalActivationGate(row);


        if (gate.blocked) {
            ignoredIds.push({
              id: requestedId,
              normalizedId: id,
              side,
              reason: 'EMPIRICAL_VETO_CURRENT_MEASUREMENT_NET_EDGE_NOT_POSITIVE',
              activationGateStatus: gate.status,
              empiricalVetoPolicyVersion: EMPIRICAL_VETO_POLICY_VERSION,
              completed: gate.completed,
              minCompleted: gate.minCompleted,
              avgR: gate.avgR,
              totalR: gate.totalR,
              maxAvgR: gate.maxAvgR,
              measurementFixVersion: gate.measurementVersion
            });
            continue;
        }


        addRow(row);
        continue;
    }


    if (!row && allowManualUnknownTrueMicroIds()) {
        const manualRow = buildManualOnlyRow(id, selectedRows.length + 1);


        if (manualRow) {
            addRow(manualRow);
            continue;
        }
    }


    ignoredIds.push({
        id: requestedId,
        normalizedId: id,
        side,
        reason: row
            ? 'ROW_IS_NOT_EXACT_LONG_75_CHILD_TRUE_MICRO'
            : 'UNKNOWN_LONG_75_CHILD_TRUE_MICRO_ID'
    });
}
    return {
         selectedRows,
         ignoredIds,
         expandedFromMacro
    };
}


function requestedManualIdsFromOptions(options = {}) {
    return uniqueStrings([
         options.microFamilyIds || [],
         options.activeMicroFamilyIds || [],
         options.trueMicroFamilyIds || [],
         options.childTrueMicroFamilyIds || [],
         options.ids || [],
         options.id || []
    ]);
}


function buildPreservedActiveResponse({
    existingActive,
    requestedIds,
    ignoredIds,
    expandedFromMacro,
    weekKey,
    mode
}) {
    const empiricalVetoBlockedRows = (Array.isArray(ignoredIds) ? ignoredIds : [])
         .filter((row) =>
              row?.reason ===
              'EMPIRICAL_VETO_CURRENT_MEASUREMENT_NET_EDGE_NOT_POSITIVE'
         );


    const allRequestedBlockedByEmpiricalVeto =
         requestedIds.length > 0 &&
         empiricalVetoBlockedRows.length === requestedIds.length;


    const preserved = existingActive
         ? {
              ...existingActive,
              ok: false,
              skipped: true,
              changed: false,
              activePreserved: true,
              reason: allRequestedBlockedByEmpiricalVeto
                ? 'ALL_REQUESTED_IDS_BLOCKED_BY_EMPIRICAL_VETO_ACTIVE_ROTATION_PRESERVED'
                :
'NO_VALID_LONG_75_CHILD_TRUE_MICRO_IDS_SELECTED_ACTIVE_ROTATION_PRESERVED'
}
: {
     ok: false,
     skipped: true,
     changed: false,
     activePreserved: false,
     rotationId: null,
     source: 'ADMIN_MANUAL_SELECTION_LONG_75_CHILD_TRUE_MICRO_ONLY',
     mode,
     sourceWeekKey: weekKey,
     activeWeekKey: getIsoWeekKey(),
     dataWeekKey: weekKey,
     learningDataKey: weekKey,
     generatedAt: now(),
     activatedAt: null,
     ...modeFlags(),
     trueMicroOnly: true,
     exactTrueMicroOnly: true,
     manualOnly: true,
     adminSelected: true,
     autoRotation: false,
     liveSelectable: false,
     empty: true,
     emptyReason: allRequestedBlockedByEmpiricalVeto
       ? 'ALL_REQUESTED_IDS_BLOCKED_BY_EMPIRICAL_VETO'
       : 'NO_VALID_LONG_75_CHILD_TRUE_MICRO_IDS_SELECTED',
     reason: allRequestedBlockedByEmpiricalVeto
       ? 'ALL_REQUESTED_IDS_BLOCKED_BY_EMPIRICAL_VETO'
       : 'NO_VALID_LONG_75_CHILD_TRUE_MICRO_IDS_SELECTED',
     microFamilies: [],
     microFamilyIds: [],
     activeMicroFamilyIds: [],
     trueMicroFamilyIds: [],
     childTrueMicroFamilyIds: [],
     macroFamilyIds: [],
     activeMacroFamilyIds: [],
     parentTrueMicroFamilyIds: [],
     activeParentTrueMicroFamilyIds: [],
     microToMacroFamilyId: {},
     microToParentTrueMicroFamilyId: {},
     macroToMicroFamilyIds: {},
     parentTrueMicroFamilyToMicroFamilyIds: {},
     bestLong: null,
     bestShort: null,
     missingSides: [TARGET_TRADE_SIDE]
};
    return {
         ...preserved,
         requestedMicroFamilyIds: requestedIds,
         ignoredRequestedIds: ignoredIds,
         empiricalVetoBlockedCount: empiricalVetoBlockedRows.length,
         empiricalVetoBlockedMicroFamilyIds: empiricalVetoBlockedRows
           .map((row) => row.normalizedId || row.id)
           .filter(Boolean),
         empiricalVetoPolicyVersion: EMPIRICAL_VETO_POLICY_VERSION,
         expandedFromMacro
    };
}


export async function activateSelectedMicroFamilies(options = {}) {
    const {
         weekKey = PERSISTENT_LEARNING_KEY,
         activeWeekKey = getIsoWeekKey(),
         mode = 'manual'
    } = options || {};


    const redis = getDurableRedis();
    const dataWeekKey = learningDataKey(weekKey);


    const [
         rotationMicros,
         existingRawActive
    ] = await Promise.all([
         getRotationMicros(dataWeekKey),
         getJson(redis, activeRotationKey(), null).catch(() => null)
    ]);


    const {
         micros,
         usedPreviousWeekMerge,
         usedPersistentLearningKey,
         primaryRows,
         previousRows
    } = rotationMicros;


    const requestedIds = requestedManualIdsFromOptions(options);


    const {
         selectedRows,
         ignoredIds,
         expandedFromMacro
    } = resolveManualSelection({
         requestedIds,
  micros
});


const microFamilies = sortAdaptiveRows(selectedRows)
  .filter(isLongRotationRow)
  .filter(isTrueMicroFamily)
  .map((row, index) => {
       if (row.manualOnly) {
           return {
                ...row,
                rank: index + 1
           };
       }


       return compactRotationRow(row, index + 1);
  })
  .filter((row) => row.microFamilyId)
  .filter((row) => isKnownTrueMicroId(row.microFamilyId));


if (microFamilies.length === 0) {
  const sanitizedExistingActive = sanitizeActiveRotation(existingRawActive, {
       requireManual: true
  });


  const existingActive =
       sanitizedExistingActive &&
       !sanitizedExistingActive.empty &&
       sanitizedExistingActive.microFamilyIds?.length
           ? sanitizedExistingActive
           : null;


  if (
       sanitizedExistingActive &&
       sanitizedExistingActive.empiricalVetoRemovedCount > 0
  ) {
       await setJson(
           redis,
           activeRotationKey(),
           sanitizedExistingActive
       ).catch(() => null);
  }


  return buildPreservedActiveResponse({
       existingActive,
       requestedIds,
       ignoredIds,
       expandedFromMacro,
        weekKey: dataWeekKey,
        mode
      });
  }


  const indexes = buildSelectionIndexes(microFamilies);
  const meta = schemaMeta();


  const active = sanitizeActiveRotation({
      rotationId: randomId(`ROT_${dataWeekKey}_manual_long_75_child_only`),
      source: 'ADMIN_MANUAL_SELECTION_LONG_75_CHILD_TRUE_MICRO_ONLY',
      mode,


      sourceWeekKey: dataWeekKey,
      activeWeekKey,
      dataWeekKey,
      learningDataKey: dataWeekKey,


      generatedAt: now(),
      activatedAt: now(),
      strategyVersion: CONFIG.strategyVersion,


      schema: meta.schema,
      macroSchema: meta.macroSchema,
      microSchema: meta.microSchema,
      trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
      childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
      parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,


      ...modeFlags(),


      trueMicroOnly: true,
      exactTrueMicroOnly: true,
      manualOnly: true,
      adminSelected: true,
      autoRotation: false,
      liveSelectable: indexes.microFamilyIds.length > 0,


      usedLegacyFallback: false,
      usedSoftFallback: microFamilies.some((row) => row.rotationEligibilityTier ===
'SOFT'),
      usedObservationFallback: microFamilies.some((row) =>
row.rotationEligibilityTier === 'OBSERVATION'),
      usedRawFallback: microFamilies.some((row) => row.rotationEligibilityTier ===
'RAW'),
      usedPreviousWeekMerge,
      usedPersistentLearningKey,
    minWeightedCompleted: minWeightedCompleted(),
    topNPerSide: topNPerSide(),
    maxPerParentTrueMicroFamily: maxPerParentTrueMicroFamily(),
    parentDiversificationEnabled: parentDiversificationEnabled(),


    primaryRows,
    previousRows,


    empty: indexes.microFamilyIds.length === 0,
    emptyReason: indexes.microFamilyIds.length === 0
         ? 'NO_LONG_75_CHILD_TRUE_MICRO_IDS_SELECTED'
         : null,


    requestedMicroFamilyIds: requestedIds,
    requestedTrueMicroFamilyIds: requestedIds,
    ignoredRequestedIds: ignoredIds,
    expandedFromMacro,


    bestLong: bestLongRow(microFamilies),
    bestShort: null,
    missingSides: missingSides(microFamilies),


    microFamilyIds: indexes.microFamilyIds,
    activeMicroFamilyIds: indexes.activeMicroFamilyIds,
    trueMicroFamilyIds: indexes.trueMicroFamilyIds,
    childTrueMicroFamilyIds: indexes.childTrueMicroFamilyIds,


    macroFamilyIds: indexes.macroFamilyIds,
    activeMacroFamilyIds: indexes.activeMacroFamilyIds,
    parentTrueMicroFamilyIds: indexes.parentTrueMicroFamilyIds,
    activeParentTrueMicroFamilyIds: indexes.activeParentTrueMicroFamilyIds,


    microToMacroFamilyId: indexes.microToMacroFamilyId,
    microToParentTrueMicroFamilyId: indexes.microToParentTrueMicroFamilyId,
    macroToMicroFamilyIds: indexes.macroToMicroFamilyIds,
    parentTrueMicroFamilyToMicroFamilyIds:
indexes.parentTrueMicroFamilyToMicroFamilyIds,


    microFamilies
  }, {
    requireManual: true
  });


  const finalActive = {
    ...active,
    ok: true,
         skipped: false,
         changed: true,
         activePreserved: false
    };


    await setJson(
         redis,
         activeRotationKey(),
         finalActive
    );


    return finalActive;
}


function sanitizeDashboardRotation(rotation) {
    const sanitized = sanitizeActiveRotation(rotation, {
         requireManual: false
    });


    if (!sanitized) return null;


    const {
         temporalGeneration,
         ...rotationWithoutEmbeddedGeneration
    } = sanitized;


    return {
         ...rotationWithoutEmbeddedGeneration,
         temporalGenerationSummary: compactTemporalGenerationSummary(temporalGeneration),


         manualOnly: false,
         adminSelected: false,
         autoRotation: false,
         nextRotationOnly: true,
         activeRotationPreserved: true,
         liveSelectable: false,
         activationDisabled: true,
         manualSelectionRequired: true,


         candidateMicroFamilyIds: sanitized.microFamilyIds || [],
         candidateTrueMicroFamilyIds: sanitized.trueMicroFamilyIds || [],
         candidateParentTrueMicroFamilyIds: sanitized.parentTrueMicroFamilyIds || [],
         candidateMacroFamilyIds: sanitized.macroFamilyIds || []
    };
}


export async function getRotationDashboard() {
    const redis = getDurableRedis();


    const [activeRaw, nextRaw, validFrom] = await Promise.all([
         getActiveRotation(),
         getRotationDocument(redis, nextRotationKey(), null),
         getRotationDocument(redis, rotationValidFromKey(), null)
  ]);


  const active = sanitizeActiveRotation(activeRaw, {
    requireManual: true
  });


  const next = sanitizeDashboardRotation(nextRaw);


  const activeRows = Array.isArray(active?.microFamilies)
    ? active.microFamilies
    : [];


  const nextRows = Array.isArray(next?.microFamilies)
    ? next.microFamilies
    : [];


  return {
    active,
    next,
    validFrom: compactPointerDocumentForDashboard(validFrom),
    activeTemporalGenerationId: validFrom?.activeTemporalGenerationId || null,
    activeTemporalGeneration: compactTemporalGenerationSummary(validFrom?.activeTemporalGeneration),
    pendingTemporalGenerationId: validFrom?.pendingTemporalGenerationId || null,
    pendingTemporalGenerationStatus: validFrom?.pendingTemporalGenerationStatus || null,
    temporalGenerationValidation: validFrom?.activeTemporalGeneration
      ? validateTemporalGeneration(validFrom.activeTemporalGeneration, { requireActive: true })
      : { valid: false, errors: ['ACTIVE_GENERATION_MISSING'] },
    weekCompositionProposals:
      validFrom?.activeTemporalGeneration?.weekCompositionProposals || [],
    activeWeekCompositionId: validFrom?.activeWeekCompositionId || null,
    activeWeekComposition: validFrom?.activeWeekComposition || null,
    activeWeekCompositionValidation: validFrom?.activeWeekComposition
      ? validateWeekComposition(validFrom.activeWeekComposition, {
          generationId: validFrom?.activeTemporalGenerationId || null,
          requireActive: true
        })
      : { valid: false, errors: ['ACTIVE_WEEK_COMPOSITION_MISSING'] },
    weekCompositionVersion: WEEK_COMPOSITION_VERSION,
    weekCompositionOptimizerVersion: WEEK_COMPOSITION_OPTIMIZER_VERSION,
    temporalHourlyProfileVersion: TEMPORAL_HOURLY_PROFILE_VERSION,
    temporalMarketWeatherProfileVersion: TEMPORAL_MARKET_WEATHER_PROFILE_VERSION,
    temporalMarketWeatherKeys: TEMPORAL_MARKET_WEATHER_KEYS,
    btcDirectionRouterProfileVersion: BTC_DIRECTION_ROUTER_PROFILE_VERSION,
    btcDirectionRouterPolicyVersion: BTC_DIRECTION_ROUTER_POLICY_VERSION,
    btcRouterStates: BTC_ROUTER_STATES,
    btcRouterSelectableStates: BTC_ROUTER_SELECTABLE_STATES,

    activeRows,
    nextRows,


    activeCount: active?.microFamilyIds?.length || 0,
    nextCount: next?.microFamilyIds?.length || 0,


    activeTrueMicroCount: active?.trueMicroFamilyIds?.length || 0,
    nextTrueMicroCount: next?.trueMicroFamilyIds?.length || 0,


    activeParentTrueMicroCount: active?.parentTrueMicroFamilyIds?.length || 0,
    nextParentTrueMicroCount: next?.parentTrueMicroFamilyIds?.length || 0,


    activeMacroCount: active?.macroFamilyIds?.length || 0,
    nextMacroCount: next?.macroFamilyIds?.length || 0,


    activeMicroFamilyIds: active?.microFamilyIds || [],
    nextMicroFamilyIds: next?.microFamilyIds || [],


    activeTrueMicroFamilyIds: active?.trueMicroFamilyIds || [],
    nextTrueMicroFamilyIds: next?.trueMicroFamilyIds || [],


    activeParentTrueMicroFamilyIds: active?.parentTrueMicroFamilyIds ||
active?.activeParentTrueMicroFamilyIds || [],
    nextParentTrueMicroFamilyIds: next?.parentTrueMicroFamilyIds ||
next?.activeParentTrueMicroFamilyIds || [],
      activeMacroFamilyIds: active?.macroFamilyIds || active?.activeMacroFamilyIds
|| [],
      nextMacroFamilyIds: next?.macroFamilyIds || next?.activeMacroFamilyIds || [],


      activeMicroToMacroFamilyId: active?.microToMacroFamilyId || {},
      nextMicroToMacroFamilyId: next?.microToMacroFamilyId || {},


      activeMicroToParentTrueMicroFamilyId: active?.microToParentTrueMicroFamilyId
|| {},
      nextMicroToParentTrueMicroFamilyId: next?.microToParentTrueMicroFamilyId ||
{},


      activeMacroToMicroFamilyIds: active?.macroToMicroFamilyIds || {},
      nextMacroToMicroFamilyIds: next?.macroToMicroFamilyIds || {},


      activeParentTrueMicroFamilyToMicroFamilyIds:
active?.parentTrueMicroFamilyToMicroFamilyIds || {},
      nextParentTrueMicroFamilyToMicroFamilyIds:
next?.parentTrueMicroFamilyToMicroFamilyIds || {},


      bestLong: active?.bestLong || null,
      bestShort: null,
      nextBestLong: next?.bestLong || null,
      nextBestShort: null,


      missingSides: active?.missingSides || [TARGET_TRADE_SIDE],
      nextMissingSides: next?.missingSides || [TARGET_TRADE_SIDE],


      usedSoftFallback: Boolean(active?.usedSoftFallback),
      nextUsedSoftFallback: Boolean(next?.usedSoftFallback),


      usedObservationFallback: Boolean(active?.usedObservationFallback),
      nextUsedObservationFallback: Boolean(next?.usedObservationFallback),


      usedRawFallback: Boolean(active?.usedRawFallback),
      nextUsedRawFallback: Boolean(next?.usedRawFallback),


      activeEmpiricalVetoRemovedCount:
         safeNumber(active?.empiricalVetoRemovedCount, 0),
      activeEmpiricalVetoRemovedMicroFamilyIds:
         active?.empiricalVetoRemovedMicroFamilyIds || [],
      nextEmpiricalVetoCount:
         safeNumber(next?.empiricalVetoCount, 0),
      nextEmpiricalVetoMicroFamilyIds:
         next?.empiricalVetoMicroFamilyIds || [],


      usedPreviousWeekMerge: Boolean(active?.usedPreviousWeekMerge),
         nextUsedPreviousWeekMerge: Boolean(next?.usedPreviousWeekMerge),


         usedPersistentLearningKey: Boolean(active?.usedPersistentLearningKey),
         nextUsedPersistentLearningKey: Boolean(next?.usedPersistentLearningKey),


         parentDiversificationEnabled: parentDiversificationEnabled(),
         maxPerParentTrueMicroFamily: maxPerParentTrueMicroFamily(),


         dataWeekKey: active?.dataWeekKey || PERSISTENT_LEARNING_KEY,
         learningDataKey: active?.learningDataKey || PERSISTENT_LEARNING_KEY,


         manualOnly: true,
         autoRotationActivationDisabled: true,
         activeLiveSelectable: Boolean(active?.liveSelectable),


         ...modeFlags(),


         trueMicroOnly: true,
         exactTrueMicroOnly: true
    };
}
