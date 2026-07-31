// ================= FILE: src/analyze/scoring.js =================


import { CONFIG } from '../config.js';
import { clamp, safeNumber, sideToTradeSide } from '../utils.js';


const DEFAULT_WILSON_Z = 1.96;
const DEFAULT_PRIOR_TRADES = 24;
const DEFAULT_PRIOR_WINRATE = 0.5;
const DEFAULT_SAMPLE_CAP = 50;
const DEFAULT_AVG_R_CAP = 5;
const DEFAULT_AVG_R_SAMPLE_EXPONENT = 1.35;
const DEFAULT_OBSERVATION_DEDUPE_CACHE_LIMIT = 5000;


const MIN_COMPLETED_ACTIVE = 20;


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
const LEARNING_GRANULARITY =
'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_V1';


const MEASUREMENT_FIX_VERSION =
'LONG_MEASUREMENT_FIX_TRIGGER_BOUNDARY_EXIT_FILL_V2';
const PREVIOUS_MEASUREMENT_FIX_VERSION =
'LONG_MEASUREMENT_FIX_AVGCOST_DIRECTSL_SEEN_DEDUPE_V1';
const EXIT_FILL_MODEL_VERSION = 'LONG_TRIGGER_BOUNDARY_FILL_PLUS_COST_MODEL_V1';
const OUTCOME_MEASUREMENT_GATE_MODE = 'STRICT_EXACT_VERSION';
const CURRENT_FIT_VERSION = 'LONG_CURRENTFIT_PERSISTENCE_SNAPSHOT_V2';


const SOURCE_VIRTUAL = 'VIRTUAL';
const SOURCE_REAL = 'REAL';
const SOURCE_SHADOW = 'SHADOW';


const LONG_FIXED_SETUP_TYPES = new Set([
     'BREAKOUT',
     'RETEST',
     'SWEEP_REVERSAL',
     'CONTINUATION',
     'COMPRESSION'
]);


const LONG_FIXED_REGIME_ORDER = [
     'TREND',
     'CHOP',
     'SQUEEZE'
];


const LONG_FIXED_REGIME_BUCKETS = new Set(LONG_FIXED_REGIME_ORDER);


const CONFIRMATION_PROFILE_ORDER = Object.freeze([
     'A_STRONG_ALIGN',
     'B_FLOW_ALIGN',
     'C_VOLUME_ALIGN',
     'D_MIXED_OK',
     'E_WEAK_CONTRA'
]);


const LONG_CONFIRMATION_PROFILES = new Set(CONFIRMATION_PROFILE_ORDER);


export const TEMPORAL_CONTEXT_VERSION = 'LONG_TEMPORAL_CONTEXT_UTC_V1';
export const TEMPORAL_POLICY_VERSION = 'LONG_TEMPORAL_FAMILY_PROFILE_V1';
export const WEEKEND_POLICY_VERSION = 'LONG_WEEKEND_PER_FAMILY_DAY_APPROVAL_V1';
export const SESSION_POLICY_VERSION = 'LONG_DAY_SESSION_VETO_RECOVERY_V1';
export const TEMPORAL_GENERATION_SCHEMA_VERSION = 'LONG_TEMPORAL_ROOT_GENERATION_V1';
export const TEMPORAL_TAXONOMY_VERSION = TRUE_MICRO_SCHEMA;
export const TEMPORAL_COST_MODEL_VERSION = EXIT_FILL_MODEL_VERSION;
export const TEMPORAL_HOURLY_PROFILE_VERSION =
    'LONG_TEMPORAL_DAY_HOUR_PROFILE_V2';
export const TEMPORAL_MARKET_WEATHER_PROFILE_VERSION =
    'LONG_TEMPORAL_DAY_HOUR_MARKET_WEATHER_PROFILE_V1';
export const BTC_DIRECTION_ROUTER_PROFILE_VERSION =
    'LONG_BTC_DIRECTION_ROUTER_PROFILE_V1';
export const BTC_DIRECTION_ROUTER_POLICY_VERSION =
    'LONG_BTC_DIRECTION_ROUTER_COUNTER_SIDE_PROOF_V1';

const DAY_OF_WEEK_UTC = Object.freeze([
    'SUNDAY',
    'MONDAY',
    'TUESDAY',
    'WEDNESDAY',
    'THURSDAY',
    'FRIDAY',
    'SATURDAY'
]);

export const TEMPORAL_DAY_BUCKETS = Object.freeze([
    'MONDAY',
    'TUESDAY',
    'WEDNESDAY',
    'THURSDAY',
    'FRIDAY',
    'SATURDAY',
    'SUNDAY'
]);

export const TEMPORAL_DAY_TYPE_BUCKETS = Object.freeze([
    'WEEKDAY',
    'WEEKEND'
]);

export const TEMPORAL_PRIMARY_SESSION_BUCKETS = Object.freeze([
    'ASIA',
    'ASIA_EU_OVERLAP',
    'EUROPE',
    'EU_US_OVERLAP',
    'US',
    'OFF_HOURS'
]);

export const TEMPORAL_HOUR_BUCKETS = Object.freeze(
    Array.from({ length: 24 }, (_, hour) => `H${String(hour).padStart(2, '0')}`)
);

export function temporalHourKey(hourUtc) {
    const hour = Math.max(0, Math.min(23, Math.floor(safeNumber(hourUtc, 0))));
    return `H${String(hour).padStart(2, '0')}`;
}

export function temporalDayHourKey(dayOfWeekUtc, hourUtc) {
    const day = String(dayOfWeekUtc || '').trim().toUpperCase();
    if (!TEMPORAL_DAY_BUCKET_SET.has(day)) return null;
    return `${day}:${temporalHourKey(hourUtc)}`;
}

export const TEMPORAL_MARKET_WEATHER_KEYS = Object.freeze([
    'TREND|LONG',
    'TREND|NEUTRAL',
    'TREND|SHORT',
    'CHOP|LONG',
    'CHOP|NEUTRAL',
    'CHOP|SHORT',
    'SQUEEZE|LONG',
    'SQUEEZE|NEUTRAL',
    'SQUEEZE|SHORT',
    'UNKNOWN'
]);

const TEMPORAL_MARKET_WEATHER_KEY_SET = new Set(TEMPORAL_MARKET_WEATHER_KEYS);

export const BTC_ROUTER_STATES = Object.freeze([
    'STRONG_BULLISH',
    'BULLISH',
    'NEUTRAL',
    'BEARISH',
    'STRONG_BEARISH',
    'UNKNOWN'
]);
export const BTC_ROUTER_SELECTABLE_STATES = Object.freeze(
    BTC_ROUTER_STATES.filter((state) => state !== 'UNKNOWN')
);
const BTC_ROUTER_STATE_SET = new Set(BTC_ROUTER_STATES);


export function normalizeTemporalWeatherRegime(value = '') {
    const raw = String(value || '').trim().toUpperCase();
    if (!raw) return 'UNKNOWN';
    if (raw.includes('SQUEEZE') || raw.includes('COMPRESSION') || raw.includes('COIL')) {
        return 'SQUEEZE';
    }
    if (raw.includes('CHOP') || raw.includes('RANGE') || raw.includes('SIDEWAYS') || raw.includes('MIXED')) {
        return 'CHOP';
    }
    if (raw.includes('TREND') || raw.includes('MOMENTUM') || raw.includes('FLOW') || raw.includes('IMPULSE')) {
        return 'TREND';
    }
    return 'UNKNOWN';
}

export function normalizeTemporalWeatherTrendSide(value = '') {
    const raw = String(value || '').trim().toUpperCase();
    if (!raw) return 'UNKNOWN';
    if (
        ['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'UPSIDE', 'GREEN', 'RISK_ON'].includes(raw) ||
        raw.includes('BULLISH') || raw.includes('FLOW_WITH_LONG')
    ) {
        return 'LONG';
    }
    if (
        ['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE', 'RED', 'RISK_OFF'].includes(raw) ||
        raw.includes('BEARISH') || raw.includes('FLOW_WITH_SHORT')
    ) {
        return 'SHORT';
    }
    if (
        ['NEUTRAL', 'MIXED', 'FLAT', 'SIDEWAYS', 'CHOP', 'UNKNOWN'].includes(raw) ||
        raw.includes('NEUTRAL') || raw.includes('MIXED')
    ) {
        return 'NEUTRAL';
    }
    return 'UNKNOWN';
}

function temporalWeatherObjectCandidates(row = {}) {
    const source = row && typeof row === 'object' && !Array.isArray(row) ? row : {};
    return [
        source.entryMarketWeather,
        source.currentMarketWeather,
        source.marketWeather,
        source.weather,
        source.marketWeatherSummary,
        source.entryMarketWeather?.current,
        source.entryMarketWeather?.summary,
        source.currentMarketWeather?.current,
        source.currentMarketWeather?.summary
    ].filter((value) => value && typeof value === 'object' && !Array.isArray(value));
}

function firstTemporalWeatherValue(candidates = [], fields = []) {
    for (const candidate of candidates) {
        for (const field of fields) {
            const value = candidate?.[field];
            if (value !== undefined && value !== null && value !== '') return value;
        }
    }
    return null;
}

export function temporalMarketWeatherKey(value = null, trendSideValue = null) {
    if (typeof value === 'string' && value.includes('|') && trendSideValue == null) {
        const [regimePart, sidePart] = value.split('|');
        const key = `${normalizeTemporalWeatherRegime(regimePart)}|${normalizeTemporalWeatherTrendSide(sidePart)}`;
        return TEMPORAL_MARKET_WEATHER_KEY_SET.has(key) ? key : 'UNKNOWN';
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const context = resolveEntryMarketWeatherContext(value);
        return context.marketWeatherKey;
    }
    const regime = normalizeTemporalWeatherRegime(value);
    const trendSide = normalizeTemporalWeatherTrendSide(trendSideValue);
    const key = `${regime}|${trendSide}`;
    return regime === 'UNKNOWN' || trendSide === 'UNKNOWN' || !TEMPORAL_MARKET_WEATHER_KEY_SET.has(key)
        ? 'UNKNOWN'
        : key;
}

export function resolveEntryMarketWeatherContext(row = {}) {
    const source = row && typeof row === 'object' && !Array.isArray(row) ? row : {};
    const explicitKey = String(
        source.entryMarketWeatherKey ||
        source.marketWeatherProfileKey ||
        source.currentMarketWeatherProfileKey ||
        ''
    ).trim().toUpperCase();
    if (TEMPORAL_MARKET_WEATHER_KEY_SET.has(explicitKey)) {
        const [regime, trendSide] = explicitKey === 'UNKNOWN'
            ? ['UNKNOWN', 'UNKNOWN']
            : explicitKey.split('|');
        return {
            marketWeatherKey: explicitKey,
            regime,
            trendSide,
            available: explicitKey !== 'UNKNOWN',
            source: 'EXPLICIT_ENTRY_MARKET_WEATHER_KEY'
        };
    }
    const candidates = temporalWeatherObjectCandidates(source);
    const regimeValue =
        source.entryMarketWeatherRegime ??
        source.entryCurrentRegime ??
        source.entryMarketRegime ??
        source.currentRegime ??
        source.currentMarketRegime ??
        firstTemporalWeatherValue(candidates, [
            'currentRegime', 'regime', 'marketRegime', 'regimeBucket',
            'breadthRegime', 'volatilityRegime'
        ]);
    const trendSideValue =
        source.entryMarketWeatherTrendSide ??
        source.entryCurrentTrendSide ??
        source.entryMarketTrendSide ??
        source.currentTrendSide ??
        source.currentMarketTrendSide ??
        firstTemporalWeatherValue(candidates, [
            'currentTrendSide', 'trendSide', 'marketSide', 'side', 'direction',
            'breadthSide', 'btcTrendSide'
        ]);
    const regime = normalizeTemporalWeatherRegime(regimeValue);
    const trendSide = normalizeTemporalWeatherTrendSide(trendSideValue);
    const key = regime !== 'UNKNOWN' && trendSide !== 'UNKNOWN'
        ? `${regime}|${trendSide}`
        : 'UNKNOWN';
    return {
        marketWeatherKey: TEMPORAL_MARKET_WEATHER_KEY_SET.has(key) ? key : 'UNKNOWN',
        regime,
        trendSide,
        available: key !== 'UNKNOWN',
        source: candidates.length > 0 || regimeValue || trendSideValue
            ? 'ENTRY_MARKET_WEATHER_SNAPSHOT'
            : 'MARKET_WEATHER_UNAVAILABLE'
    };
}


function btcContextObjectCandidates(row = {}) {
    const source = row && typeof row === 'object' && !Array.isArray(row) ? row : {};
    return [
        source.entryBtcRouterContext,
        source.entryBtcContext,
        source.btcRouterContext,
        source.btcContext,
        source.entryMarketWeather,
        source.currentMarketWeather,
        source.marketWeather,
        source.weather,
        source.entryMarketWeather?.btc,
        source.currentMarketWeather?.btc,
        source.marketWeather?.btc
    ].filter((value) => value && typeof value === 'object' && !Array.isArray(value));
}

function firstBtcContextValue(candidates = [], fields = []) {
    for (const candidate of candidates) {
        for (const field of fields) {
            const value = candidate?.[field];
            if (value !== undefined && value !== null && value !== '') return value;
        }
    }
    return null;
}

function finiteBtcValue(...values) {
    for (const value of values) {
        const number = Number(value);
        if (Number.isFinite(number)) return number;
    }
    return null;
}

function pctBtcValue(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Math.abs(number) <= 1 ? number * 100 : number;
}

export function normalizeBtcRouterState(value = '') {
    const raw = String(value || '').trim().toUpperCase();
    if (!raw) return 'UNKNOWN';
    if (BTC_ROUTER_STATE_SET.has(raw)) return raw;
    if (
        raw.includes('STRONG_BULL') || raw.includes('VERY_BULL') ||
        raw.includes('HARD_BULL') || raw.includes('POWER_BULL') ||
        raw.includes('BTC_RISK_ON_STRONG')
    ) return 'STRONG_BULLISH';
    if (
        raw.includes('STRONG_BEAR') || raw.includes('VERY_BEAR') ||
        raw.includes('HARD_BEAR') || raw.includes('POWER_BEAR') ||
        raw.includes('BTC_RISK_OFF_STRONG')
    ) return 'STRONG_BEARISH';
    if (
        ['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'UPSIDE', 'GREEN', 'RISK_ON'].includes(raw) ||
        raw.includes('BULLISH') || raw.includes('BTC_LONG') || raw.includes('FLOW_WITH_LONG')
    ) return 'BULLISH';
    if (
        ['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE', 'RED', 'RISK_OFF'].includes(raw) ||
        raw.includes('BEARISH') || raw.includes('BTC_SHORT') || raw.includes('FLOW_WITH_SHORT')
    ) return 'BEARISH';
    if (
        ['NEUTRAL', 'MIXED', 'FLAT', 'SIDEWAYS', 'CHOP', 'BALANCED'].includes(raw) ||
        raw.includes('NEUTRAL') || raw.includes('MIXED') || raw.includes('CHOP')
    ) return 'NEUTRAL';
    return 'UNKNOWN';
}

export function btcRouterDirection(state = 'UNKNOWN') {
    const normalized = normalizeBtcRouterState(state);
    if (normalized === 'STRONG_BULLISH' || normalized === 'BULLISH') return 'LONG';
    if (normalized === 'STRONG_BEARISH' || normalized === 'BEARISH') return 'SHORT';
    if (normalized === 'NEUTRAL') return 'NEUTRAL';
    return 'UNKNOWN';
}

export function resolveEntryBtcRouterContext(row = {}) {
    const source = row && typeof row === 'object' && !Array.isArray(row) ? row : {};
    const candidates = btcContextObjectCandidates(source);
    const explicitState = normalizeBtcRouterState(
        source.entryBtcRouterState ??
        source.entryBtcState ??
        source.btcRouterState ??
        source.btcState ??
        source.btcRelation ??
        firstBtcContextValue(candidates, [
            'entryBtcRouterState', 'btcRouterState', 'btcState', 'btcRelation',
            'state', 'directionState', 'trendState'
        ])
    );
    const sideRaw =
        source.entryBtcTrendSide ??
        source.entryBtcDirection ??
        source.btcTrendSide ??
        source.btcDirection ??
        source.btcSide ??
        firstBtcContextValue(candidates, [
            'entryBtcTrendSide', 'btcTrendSide', 'btcDirection', 'btcSide',
            'trendSide', 'direction', 'side'
        ]);
    const sideState = normalizeBtcRouterState(sideRaw);
    const confidence = Math.max(0, Math.min(100, finiteBtcValue(
        source.entryBtcConfidence,
        source.entryBtcDirectionConfidence,
        source.btcDirectionConfidence,
        source.btcConfidence,
        source.btcTrendConfidence,
        firstBtcContextValue(candidates, [
            'entryBtcConfidence', 'btcDirectionConfidence', 'btcConfidence',
            'trendConfidence', 'confidence'
        ]),
        0
    ) ?? 0));
    const trendStrength = Math.max(0, Math.min(100, Math.abs(finiteBtcValue(
        source.entryBtcTrendStrength,
        source.btcTrendStrength,
        source.btcStrength,
        source.btcMomentumStrength,
        source.btcScore,
        firstBtcContextValue(candidates, [
            'entryBtcTrendStrength', 'btcTrendStrength', 'btcStrength',
            'momentumStrength', 'trendStrength', 'strength', 'score'
        ]),
        0
    ) ?? 0)));
    const marketWeather = resolveEntryMarketWeatherContext(source);
    const bullishPct = pctBtcValue(finiteBtcValue(
        source.entryBullishPct,
        source.currentBullishPct,
        source.bullishPct,
        source.breadthBullishPct,
        firstBtcContextValue(candidates, ['bullishPct', 'breadthBullishPct', 'longPct'])
    ));
    const bearishPct = pctBtcValue(finiteBtcValue(
        source.entryBearishPct,
        source.currentBearishPct,
        source.bearishPct,
        source.breadthBearishPct,
        firstBtcContextValue(candidates, ['bearishPct', 'breadthBearishPct', 'shortPct'])
    ));
    let state = explicitState !== 'UNKNOWN' ? explicitState : sideState;
    const allowMarketWeatherFallback = source.allowMarketWeatherBtcFallback === true;
    if (allowMarketWeatherFallback && state === 'UNKNOWN' && marketWeather.trendSide === 'LONG') state = 'BULLISH';
    if (allowMarketWeatherFallback && state === 'UNKNOWN' && marketWeather.trendSide === 'SHORT') state = 'BEARISH';
    if (allowMarketWeatherFallback && state === 'UNKNOWN' && marketWeather.trendSide === 'NEUTRAL') state = 'NEUTRAL';
    const direction = btcRouterDirection(state);
    const alignedBreadthPct = direction === 'LONG'
        ? bullishPct
        : direction === 'SHORT'
          ? bearishPct
          : null;
    const breadthConfirmed = direction === 'NEUTRAL'
        ? true
        : Number.isFinite(alignedBreadthPct) && alignedBreadthPct >= 55;
    const strongEvidence = confidence >= 72 && trendStrength >= 60 &&
        (breadthConfirmed || !Number.isFinite(alignedBreadthPct));
    if (state === 'BULLISH' && strongEvidence) state = 'STRONG_BULLISH';
    if (state === 'BEARISH' && strongEvidence) state = 'STRONG_BEARISH';
    const normalizedState = BTC_ROUTER_STATE_SET.has(state) ? state : 'UNKNOWN';
    const normalizedDirection = btcRouterDirection(normalizedState);
    return {
        btcRouterState: normalizedState,
        direction: normalizedDirection,
        confidence,
        trendStrength,
        bullishPct,
        bearishPct,
        alignedBreadthPct,
        breadthConfirmed,
        available: normalizedState !== 'UNKNOWN',
        strong: normalizedState === 'STRONG_BULLISH' || normalizedState === 'STRONG_BEARISH',
        againstLong: normalizedDirection === 'SHORT',
        withLong: normalizedDirection === 'LONG',
        counterDirectionRequiresProof: normalizedDirection === 'SHORT',
        source: explicitState !== 'UNKNOWN'
            ? 'EXPLICIT_ENTRY_BTC_STATE'
            : sideState !== 'UNKNOWN'
              ? 'ENTRY_BTC_DIRECTION_FIELDS'
              : allowMarketWeatherFallback && marketWeather.available
                ? 'MARKET_WEATHER_BTC_FALLBACK'
                : 'BTC_CONTEXT_UNAVAILABLE',
        profileVersion: BTC_DIRECTION_ROUTER_PROFILE_VERSION,
        policyVersion: BTC_DIRECTION_ROUTER_POLICY_VERSION
    };
}

export function temporalBtcRouterKey(value = null) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return resolveEntryBtcRouterContext(value).btcRouterState;
    }
    return normalizeBtcRouterState(value);
}

export function temporalMarketWeatherBtcKey(marketWeatherKey, btcState) {
    return `${temporalMarketWeatherKey(marketWeatherKey)}|BTC:${temporalBtcRouterKey(btcState)}`;
}

export function temporalDayBtcKey(dayOfWeekUtc, btcState) {
    const day = String(dayOfWeekUtc || '').trim().toUpperCase();
    if (!TEMPORAL_DAY_BUCKET_SET.has(day)) return null;
    return `${day}|BTC:${temporalBtcRouterKey(btcState)}`;
}

export function temporalHourBtcKey(hourUtc, btcState) {
    return `${temporalHourKey(hourUtc)}|BTC:${temporalBtcRouterKey(btcState)}`;
}

export function temporalDayHourBtcKey(dayOfWeekUtc, hourUtc, btcState) {
    const dayHour = temporalDayHourKey(dayOfWeekUtc, hourUtc);
    return dayHour ? `${dayHour}|BTC:${temporalBtcRouterKey(btcState)}` : null;
}

export function temporalDayWeatherBtcKey(dayOfWeekUtc, marketWeatherKey, btcState) {
    const dayWeather = temporalDayWeatherKey(dayOfWeekUtc, marketWeatherKey);
    return dayWeather ? `${dayWeather}|BTC:${temporalBtcRouterKey(btcState)}` : null;
}

export function temporalHourWeatherBtcKey(hourUtc, marketWeatherKey, btcState) {
    return `${temporalHourWeatherKey(hourUtc, marketWeatherKey)}|BTC:${temporalBtcRouterKey(btcState)}`;
}

export function temporalDayHourWeatherBtcKey(dayOfWeekUtc, hourUtc, marketWeatherKey, btcState) {
    const dayHourWeather = temporalDayHourWeatherKey(dayOfWeekUtc, hourUtc, marketWeatherKey);
    return dayHourWeather ? `${dayHourWeather}|BTC:${temporalBtcRouterKey(btcState)}` : null;
}

export function temporalDayWeatherKey(dayOfWeekUtc, marketWeatherKey) {
    const day = String(dayOfWeekUtc || '').trim().toUpperCase();
    const weather = temporalMarketWeatherKey(marketWeatherKey);
    if (!TEMPORAL_DAY_BUCKET_SET.has(day)) return null;
    return `${day}|${weather}`;
}

export function temporalHourWeatherKey(hourUtc, marketWeatherKey) {
    return `${temporalHourKey(hourUtc)}|${temporalMarketWeatherKey(marketWeatherKey)}`;
}

export function temporalDayHourWeatherKey(dayOfWeekUtc, hourUtc, marketWeatherKey) {
    const dayHour = temporalDayHourKey(dayOfWeekUtc, hourUtc);
    if (!dayHour) return null;
    return `${dayHour}|${temporalMarketWeatherKey(marketWeatherKey)}`;
}

const PRIMARY_SESSION_BUCKET_SET = new Set(TEMPORAL_PRIMARY_SESSION_BUCKETS);
const TEMPORAL_DAY_BUCKET_SET = new Set(TEMPORAL_DAY_BUCKETS);
const TEMPORAL_SOURCE_SET = new Set([SOURCE_VIRTUAL, SOURCE_SHADOW]);
const TEMPORAL_POLICY_MODES = new Set(['OFF', 'OBSERVE', 'ENFORCE']);
const TEMPORAL_MAX_WINDOW_OUTCOMES = 50;
const TEMPORAL_MAX_WINDOW_AGE_DAYS = 180;
const TEMPORAL_MS_PER_DAY = 24 * 60 * 60 * 1000;
const TEMPORAL_FLOAT_TOLERANCE = 1e-9;

function temporalBoolean(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    if (value === 1 || value === '1') return true;
    if (value === 0 || value === '0') return false;
    const normalized = String(value ?? '').trim().toLowerCase();
    if (['true', 'yes', 'y', 'on', 'enabled'].includes(normalized)) return true;
    if (['false', 'no', 'n', 'off', 'disabled'].includes(normalized)) return false;
    return fallback;
}

export function temporalStatsEnabled() {
    return temporalBoolean(
        CONFIG.long?.temporal?.statsEnabled ??
        CONFIG.temporal?.statsEnabled ??
        process.env.TEMPORAL_STATS_ENABLED,
        true
    );
}

export function temporalPolicyMode() {
    if (!temporalStatsEnabled()) return 'OFF';
    const configured = String(
        CONFIG.long?.temporal?.policyMode ??
        CONFIG.temporal?.policyMode ??
        process.env.TEMPORAL_POLICY_MODE ??
        'OBSERVE'
    ).trim().toUpperCase();
    return TEMPORAL_POLICY_MODES.has(configured) ? configured : 'OBSERVE';
}

export function temporalRuntimeConfig() {
    const statsEnabled = temporalStatsEnabled();
    const policyMode = statsEnabled ? temporalPolicyMode() : 'OFF';
    return {
        temporalStatsEnabled: statsEnabled,
        temporalPolicyMode: policyMode,
        effectiveTemporalPolicyMode: policyMode,
        temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
        temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
        weekendPolicyVersion: WEEKEND_POLICY_VERSION,
        sessionPolicyVersion: SESSION_POLICY_VERSION,
        temporalGenerationSchemaVersion: TEMPORAL_GENERATION_SCHEMA_VERSION,
        temporalTaxonomyVersion: TEMPORAL_TAXONOMY_VERSION,
        temporalCostModelVersion: TEMPORAL_COST_MODEL_VERSION,
        temporalHourlyProfileVersion: TEMPORAL_HOURLY_PROFILE_VERSION,
        temporalMarketWeatherProfileVersion: TEMPORAL_MARKET_WEATHER_PROFILE_VERSION,
        btcDirectionRouterProfileVersion: BTC_DIRECTION_ROUTER_PROFILE_VERSION,
        btcDirectionRouterPolicyVersion: BTC_DIRECTION_ROUTER_POLICY_VERSION,
        temporalMarketWeatherKeys: TEMPORAL_MARKET_WEATHER_KEYS,
        btcRouterStates: BTC_ROUTER_STATES,
        temporalStatsCollecting: statsEnabled,
        temporalFreezeEnabled: statsEnabled,
        temporalActivationEnabled: statsEnabled,
        temporalDiscordFilteringEnabled: statsEnabled && policyMode === 'ENFORCE'
    };
}

function normalizeTimestampMs(value, fallback = now()) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
    return numeric < 10_000_000_000
        ? Math.floor(numeric * 1000)
        : Math.floor(numeric);
}

function temporalTimestamp(...values) {
    for (const value of values) {
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric > 0) {
            return normalizeTimestampMs(numeric);
        }
    }
    return now();
}

function uniqueTemporalStrings(values = []) {
    return [...new Set(
        (Array.isArray(values) ? values : [values])
          .flat(Infinity)
          .map((value) => String(value || '').trim().toUpperCase())
          .filter(Boolean)
    )];
}

export function buildTemporalContext(timestamp = now()) {
    const contextTs = temporalTimestamp(timestamp);
    const date = new Date(contextTs);
    const hourUtc = date.getUTCHours();
    const dayIndex = date.getUTCDay();
    const dayOfWeekUtc = DAY_OF_WEEK_UTC[dayIndex] || 'UNKNOWN';
    const isWeekend = dayIndex === 0 || dayIndex === 6;

    const asia = hourUtc >= 0 && hourUtc < 8;
    const europe = hourUtc >= 7 && hourUtc < 16;
    const us = hourUtc >= 13 && hourUtc < 22;

    const sessionTags = [];
    if (asia) sessionTags.push('ASIA');
    if (europe) sessionTags.push('EUROPE');
    if (us) sessionTags.push('US');

    let primarySessionBucket = 'OFF_HOURS';
    if (europe && us) primarySessionBucket = 'EU_US_OVERLAP';
    else if (asia && europe) primarySessionBucket = 'ASIA_EU_OVERLAP';
    else if (asia) primarySessionBucket = 'ASIA';
    else if (europe) primarySessionBucket = 'EUROPE';
    else if (us) primarySessionBucket = 'US';

    return {
        temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
        contextTs,
        hourUtc,
        hourBucket: temporalHourKey(hourUtc),
        dayOfWeekUtc,
        dayHourBucket: temporalDayHourKey(dayOfWeekUtc, hourUtc),
        dayType: isWeekend ? 'WEEKEND' : 'WEEKDAY',
        isWeekend,
        sessionTags,
        primarySessionBucket,
        sessionOverlap: sessionTags.length > 1,
        offHours: sessionTags.length === 0
    };
}

function normalizeTemporalContext(value = {}, fallbackTs = now()) {
    const source = value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
    const derived = buildTemporalContext(
        temporalTimestamp(source.contextTs, source.ts, fallbackTs)
    );
    const dayType = String(source.dayType || '').trim().toUpperCase();
    const explicitWeekend = source.isWeekend;
    const isWeekend = dayType === 'WEEKEND'
        ? true
        : dayType === 'WEEKDAY'
          ? false
          : typeof explicitWeekend === 'boolean'
            ? explicitWeekend
            : derived.isWeekend;
    const tags = uniqueTemporalStrings(source.sessionTags)
        .filter((tag) => ['ASIA', 'EUROPE', 'US'].includes(tag));
    const sessionTags = tags.length > 0 ? tags : derived.sessionTags;
    const requestedBucket = String(source.primarySessionBucket || '')
        .trim()
        .toUpperCase();
    const primarySessionBucket = PRIMARY_SESSION_BUCKET_SET.has(requestedBucket)
        ? requestedBucket
        : derived.primarySessionBucket;
    const requestedDay = String(source.dayOfWeekUtc || '')
        .trim()
        .toUpperCase();

    const hourUtc = Number.isInteger(Number(source.hourUtc))
        ? Math.max(0, Math.min(23, Number(source.hourUtc)))
        : derived.hourUtc;
    const dayOfWeekUtc = TEMPORAL_DAY_BUCKET_SET.has(requestedDay)
        ? requestedDay
        : derived.dayOfWeekUtc;

    return {
        temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
        temporalHourlyProfileVersion: TEMPORAL_HOURLY_PROFILE_VERSION,
        contextTs: derived.contextTs,
        hourUtc,
        hourBucket: temporalHourKey(hourUtc),
        dayOfWeekUtc,
        dayHourBucket: temporalDayHourKey(dayOfWeekUtc, hourUtc),
        dayType: isWeekend ? 'WEEKEND' : 'WEEKDAY',
        isWeekend,
        sessionTags,
        primarySessionBucket,
        sessionOverlap: typeof source.sessionOverlap === 'boolean'
          ? source.sessionOverlap
          : sessionTags.length > 1,
        offHours: typeof source.offHours === 'boolean'
          ? source.offHours
          : primarySessionBucket === 'OFF_HOURS'
    };
}

export function buildMarketEventClusterId(row = {}, contextInput = null) {
    const context = contextInput || resolveEntryTemporalContext(row);
    const explicit = String(
        row.marketEventClusterId ||
        row.scannerRunId ||
        row.marketCycleId ||
        row.snapshotId ||
        row.scanId ||
        row.batchId ||
        ''
    ).trim();
    if (explicit) return explicit;
    const utcHourWindow = Math.floor(normalizeTimestampMs(context.contextTs) / 3_600_000);
    return `${TARGET_TRADE_SIDE}:UTC60:${utcHourWindow}`;
}

export function resolveEntryTemporalContext(row = {}) {
    const nested = row.entryTemporalContext || row.temporalContext || {};
    return normalizeTemporalContext({
        ...nested,
        contextTs:
          row.entryTs ??
          row.openedAt ??
          row.entryAt ??
          row.createdAt ??
          row.observedAt ??
          row.contextTs ??
          row.ts,
        hourUtc: row.entryHourUtc ?? nested.hourUtc ?? row.hourUtc,
        dayOfWeekUtc: row.entryDayOfWeekUtc ?? nested.dayOfWeekUtc ?? row.dayOfWeekUtc,
        dayType: row.entryDayType ?? nested.dayType ?? row.dayType,
        isWeekend: row.entryIsWeekend ?? nested.isWeekend ?? row.isWeekend,
        sessionTags: row.entrySessionTags ?? nested.sessionTags ?? row.sessionTags,
        primarySessionBucket:
          row.entrySessionBucket ??
          nested.primarySessionBucket ??
          row.primarySessionBucket,
        sessionOverlap:
          row.entrySessionOverlap ??
          nested.sessionOverlap ??
          row.sessionOverlap,
        offHours: row.entryOffHours ?? nested.offHours ?? row.offHours
    }, temporalTimestamp(row.createdAt, row.observedAt, row.ts));
}

export function resolveExitTemporalContext(row = {}) {
    const nested = row.exitTemporalContext || {};
    return normalizeTemporalContext({
        ...nested,
        contextTs:
          row.exitTs ??
          row.closedAt ??
          row.completedAt ??
          row.exitAt ??
          row.updatedAt ??
          row.ts,
        hourUtc: row.exitHourUtc ?? nested.hourUtc,
        dayOfWeekUtc: row.exitDayOfWeekUtc ?? nested.dayOfWeekUtc,
        dayType: row.exitDayType ?? nested.dayType,
        isWeekend: row.exitIsWeekend ?? nested.isWeekend,
        sessionTags: row.exitSessionTags ?? nested.sessionTags,
        primarySessionBucket: row.exitSessionBucket ?? nested.primarySessionBucket,
        sessionOverlap: row.exitSessionOverlap ?? nested.sessionOverlap,
        offHours: row.exitOffHours ?? nested.offHours
    }, temporalTimestamp(row.closedAt, row.completedAt, row.updatedAt, row.ts));
}

export function temporalPolicyFlags(context = buildTemporalContext()) {
    const normalized = normalizeTemporalContext(context, context?.contextTs);
    const runtime = temporalRuntimeConfig();
    return {
        ...runtime,
        temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
        temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
        weekendPolicyVersion: WEEKEND_POLICY_VERSION,
        sessionPolicyVersion: SESSION_POLICY_VERSION,
        weekendLearningAllowed: true,
        weekendVirtualEntryAllowed: true,
        weekendDiscordEntryAllowed: runtime.temporalPolicyMode !== 'ENFORCE' || !normalized.isWeekend,
        weekendExitMonitoringAllowed: true,
        weekendOutcomeRecordingAllowed: true,
        sessionLearningAllowed: true,
        sessionVirtualEntryAllowed: true,
        sessionDiscordEntryAllowed: true,
        sessionPolicyObservedOnly: runtime.temporalPolicyMode !== 'ENFORCE',
        familyIdentityIncludesTemporalBucket: false
    };
}

export function entryTemporalFields(row = {}) {
    const context = resolveEntryTemporalContext(row);
    const weather = resolveEntryMarketWeatherContext(row);
    const marketEventClusterId = buildMarketEventClusterId(row, context);
    return {
        ...context,
        ...temporalPolicyFlags(context),
        temporalMarketWeatherProfileVersion: TEMPORAL_MARKET_WEATHER_PROFILE_VERSION,
        entryTs: context.contextTs,
        entryHourUtc: context.hourUtc,
        entryHourBucket: context.hourBucket,
        entryDayOfWeekUtc: context.dayOfWeekUtc,
        entryDayHourBucket: context.dayHourBucket,
        entryDayType: context.dayType,
        entryIsWeekend: context.isWeekend,
        entrySessionTags: [...context.sessionTags],
        entrySessionBucket: context.primarySessionBucket,
        entrySessionOverlap: context.sessionOverlap,
        entryOffHours: context.offHours,
        entryMarketWeatherKey: weather.marketWeatherKey,
        entryMarketWeatherRegime: weather.regime,
        entryMarketWeatherTrendSide: weather.trendSide,
        entryMarketWeatherAvailable: weather.available,
        entryMarketWeatherContext: weather,
        marketEventClusterId,
        entryTemporalContext: {
            ...context,
            marketEventClusterId
        }
    };
}

export function exitTemporalFields(row = {}) {
    const context = resolveExitTemporalContext(row);
    return {
        exitTs: context.contextTs,
        exitHourUtc: context.hourUtc,
        exitHourBucket: context.hourBucket,
        exitDayOfWeekUtc: context.dayOfWeekUtc,
        exitDayHourBucket: context.dayHourBucket,
        exitDayType: context.dayType,
        exitIsWeekend: context.isWeekend,
        exitSessionTags: [...context.sessionTags],
        exitSessionBucket: context.primarySessionBucket,
        exitSessionOverlap: context.sessionOverlap,
        exitOffHours: context.offHours,
        exitTemporalContext: context
    };
}

function createTemporalMetricBucket() {
    return {
        seen: 0,
        observations: 0,
        completed: 0,
        wins: 0,
        losses: 0,
        flats: 0,
        sumNetR: 0,
        sumNetR2: 0,
        sumNetPnlPct: 0,
        sumNetPnlPct2: 0,
        totalNetPnlPct: 0,
        avgNetPnlPct: 0,
        totalR: 0,
        avgNetR: 0,
        avgR: 0,
        variance: 0,
        sampleVariance: 0,
        standardError: 0,
        lcb95: 0,
        ucb95: 0,
        grossWinR: 0,
        grossLossR: 0,
        profitFactor: 0,
        winrate: 0,
        directSLCount: 0,
        directSLPct: 0,
        totalCostR: 0,
        avgCostR: 0,
        lastOutcomeTs: null,
        acceptedTemporalOutcomeSeq: 0
    };
}

export function createTemporalStatsShape() {
    return {
        ...temporalRuntimeConfig(),
        temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
        temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
        weekendPolicyVersion: WEEKEND_POLICY_VERSION,
        sessionPolicyVersion: SESSION_POLICY_VERSION,
        temporalTaxonomyVersion: TEMPORAL_TAXONOMY_VERSION,
        temporalCostModelVersion: TEMPORAL_COST_MODEL_VERSION,
        temporalHourlyProfileVersion: TEMPORAL_HOURLY_PROFILE_VERSION,
        temporalMarketWeatherProfileVersion: TEMPORAL_MARKET_WEATHER_PROFILE_VERSION,
        btcDirectionRouterProfileVersion: BTC_DIRECTION_ROUTER_PROFILE_VERSION,
        btcDirectionRouterPolicyVersion: BTC_DIRECTION_ROUTER_POLICY_VERSION,
        acceptedTemporalOutcomeSeq: 0,
        contextStats: Object.fromEntries(
            TEMPORAL_DAY_TYPE_BUCKETS.map((bucket) => [bucket, createTemporalMetricBucket()])
        ),
        dayTypeStats: Object.fromEntries(
            TEMPORAL_DAY_TYPE_BUCKETS.map((bucket) => [bucket, createTemporalMetricBucket()])
        ),
        dayOfWeekStats: Object.fromEntries(
            TEMPORAL_DAY_BUCKETS.map((bucket) => [bucket, createTemporalMetricBucket()])
        ),
        sessionStats: Object.fromEntries(
            TEMPORAL_PRIMARY_SESSION_BUCKETS.map((bucket) => [bucket, createTemporalMetricBucket()])
        ),
        hourOfDayStats: Object.fromEntries(
            TEMPORAL_HOUR_BUCKETS.map((bucket) => [bucket, createTemporalMetricBucket()])
        ),
        dayHourStats: Object.fromEntries(
            TEMPORAL_DAY_BUCKETS.map((day) => [
                day,
                Object.fromEntries(
                    TEMPORAL_HOUR_BUCKETS.map((bucket) => [bucket, createTemporalMetricBucket()])
                )
            ])
        ),
        marketWeatherStats: {},
        dayWeatherStats: Object.fromEntries(TEMPORAL_DAY_BUCKETS.map((day) => [day, {}])),
        hourWeatherStats: Object.fromEntries(TEMPORAL_HOUR_BUCKETS.map((hour) => [hour, {}])),
        dayHourWeatherStats: Object.fromEntries(
            TEMPORAL_DAY_BUCKETS.map((day) => [
                day,
                Object.fromEntries(TEMPORAL_HOUR_BUCKETS.map((hour) => [hour, {}]))
            ])
        ),
        btcRouterStats: {},
        dayBtcStats: Object.fromEntries(TEMPORAL_DAY_BUCKETS.map((day) => [day, {}])),
        hourBtcStats: Object.fromEntries(TEMPORAL_HOUR_BUCKETS.map((hour) => [hour, {}])),
        dayHourBtcStats: Object.fromEntries(
            TEMPORAL_DAY_BUCKETS.map((day) => [
                day,
                Object.fromEntries(TEMPORAL_HOUR_BUCKETS.map((hour) => [hour, {}]))
            ])
        ),
        marketWeatherBtcStats: {},
        dayWeatherBtcStats: Object.fromEntries(TEMPORAL_DAY_BUCKETS.map((day) => [day, {}])),
        hourWeatherBtcStats: Object.fromEntries(TEMPORAL_HOUR_BUCKETS.map((hour) => [hour, {}])),
        dayHourWeatherBtcStats: Object.fromEntries(
            TEMPORAL_DAY_BUCKETS.map((day) => [
                day,
                Object.fromEntries(TEMPORAL_HOUR_BUCKETS.map((hour) => [hour, {}]))
            ])
        ),
        weekendLearningAllowed: true,
        weekendVirtualEntryAllowed: true,
        weekendDiscordEntryAllowed: false,
        weekendExitMonitoringAllowed: true,
        weekendOutcomeRecordingAllowed: true,
        sessionLearningAllowed: true,
        sessionVirtualEntryAllowed: true,
        sessionDiscordEntryAllowed: true,
        familyIdentityIncludesTemporalBucket: false
    };
}

function normalizeTemporalMetricBucket(value = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
    const bucket = {
        ...createTemporalMetricBucket(),
        ...source
    };
    bucket.seen = Math.max(0, safeNumber(bucket.seen, 0));
    bucket.observations = Math.max(0, safeNumber(bucket.observations, bucket.seen));
    bucket.completed = Math.max(0, safeNumber(bucket.completed, 0));
    bucket.wins = Math.max(0, safeNumber(bucket.wins, 0));
    bucket.losses = Math.max(0, safeNumber(bucket.losses, 0));
    bucket.flats = Math.max(0, safeNumber(bucket.flats, 0));
    bucket.sumNetR = safeNumber(bucket.sumNetR ?? bucket.totalR, 0);
    bucket.sumNetR2 = Math.max(0, safeNumber(bucket.sumNetR2, 0));
    bucket.sumNetPnlPct = safeNumber(bucket.sumNetPnlPct ?? bucket.totalNetPnlPct, 0);
    bucket.sumNetPnlPct2 = Math.max(0, safeNumber(bucket.sumNetPnlPct2, 0));
    bucket.grossWinR = Math.max(0, safeNumber(bucket.grossWinR, 0));
    bucket.grossLossR = Math.max(0, safeNumber(bucket.grossLossR, 0));
    bucket.totalCostR = Math.max(0, safeNumber(bucket.totalCostR, 0));
    bucket.directSLCount = Math.max(0, safeNumber(bucket.directSLCount, 0));
    bucket.lastOutcomeTs = Number.isFinite(Number(bucket.lastOutcomeTs))
        ? normalizeTimestampMs(bucket.lastOutcomeTs)
        : null;
    bucket.acceptedTemporalOutcomeSeq = Math.max(
        0,
        Math.floor(safeNumber(bucket.acceptedTemporalOutcomeSeq, 0))
    );
    return refreshTemporalMetricBucket(bucket);
}

function normalizeSparseTemporalMetricMap(value = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return Object.fromEntries(
        Object.entries(source)
            .map(([key, bucket]) => [temporalMarketWeatherKey(key), bucket])
            .filter(([key]) => TEMPORAL_MARKET_WEATHER_KEY_SET.has(key))
            .map(([key, bucket]) => [key, normalizeTemporalMetricBucket(bucket)])
    );
}

function sparseTemporalMetricBucket(container = {}, key = 'UNKNOWN') {
    const normalizedKey = temporalMarketWeatherKey(key);
    if (!container[normalizedKey]) container[normalizedKey] = createTemporalMetricBucket();
    else container[normalizedKey] = normalizeTemporalMetricBucket(container[normalizedKey]);
    return container[normalizedKey];
}


function normalizeSparseBtcMetricMap(value = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return Object.fromEntries(
        Object.entries(source)
            .map(([key, bucket]) => [temporalBtcRouterKey(key), bucket])
            .filter(([key]) => BTC_ROUTER_STATE_SET.has(key))
            .map(([key, bucket]) => [key, normalizeTemporalMetricBucket(bucket)])
    );
}

function normalizeSparseWeatherBtcMetricMap(value = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return Object.fromEntries(
        Object.entries(source)
            .map(([weatherKey, btcMap]) => [
                temporalMarketWeatherKey(weatherKey),
                normalizeSparseBtcMetricMap(btcMap)
            ])
            .filter(([weatherKey]) => TEMPORAL_MARKET_WEATHER_KEY_SET.has(weatherKey))
    );
}

function sparseBtcMetricBucket(container = {}, key = 'UNKNOWN') {
    const normalizedKey = temporalBtcRouterKey(key);
    if (!container[normalizedKey]) container[normalizedKey] = createTemporalMetricBucket();
    else container[normalizedKey] = normalizeTemporalMetricBucket(container[normalizedKey]);
    return container[normalizedKey];
}

function sparseWeatherBtcMetricBucket(container = {}, weatherKey = 'UNKNOWN', btcState = 'UNKNOWN') {
    const normalizedWeather = temporalMarketWeatherKey(weatherKey);
    if (!container[normalizedWeather] || typeof container[normalizedWeather] !== 'object') {
        container[normalizedWeather] = {};
    }
    return sparseBtcMetricBucket(container[normalizedWeather], btcState);
}

function btcMetricBuckets(stats = {}) {
    return [
        ...Object.values(stats.btcRouterStats || {}),
        ...Object.values(stats.dayBtcStats || {}).flatMap((day) => Object.values(day || {})),
        ...Object.values(stats.hourBtcStats || {}).flatMap((hour) => Object.values(hour || {})),
        ...Object.values(stats.dayHourBtcStats || {}).flatMap((day) =>
            Object.values(day || {}).flatMap((hour) => Object.values(hour || {}))
        ),
        ...Object.values(stats.marketWeatherBtcStats || {}).flatMap((weather) => Object.values(weather || {})),
        ...Object.values(stats.dayWeatherBtcStats || {}).flatMap((day) =>
            Object.values(day || {}).flatMap((weather) => Object.values(weather || {}))
        ),
        ...Object.values(stats.hourWeatherBtcStats || {}).flatMap((hour) =>
            Object.values(hour || {}).flatMap((weather) => Object.values(weather || {}))
        ),
        ...Object.values(stats.dayHourWeatherBtcStats || {}).flatMap((day) =>
            Object.values(day || {}).flatMap((hour) =>
                Object.values(hour || {}).flatMap((weather) => Object.values(weather || {}))
            )
        )
    ];
}

function weatherMetricBuckets(stats = {}) {
    return [
        ...Object.values(stats.marketWeatherStats || {}),
        ...Object.values(stats.dayWeatherStats || {}).flatMap((day) => Object.values(day || {})),
        ...Object.values(stats.hourWeatherStats || {}).flatMap((hour) => Object.values(hour || {})),
        ...Object.values(stats.dayHourWeatherStats || {}).flatMap((day) =>
            Object.values(day || {}).flatMap((hour) => Object.values(hour || {}))
        ),
        ...btcMetricBuckets(stats)
    ];
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
    const floor = 1e-300;
    const qab = a + b;
    const qap = a + 1;
    const qam = a - 1;
    let c = 1;
    let d = 1 - (qab * x) / qap;
    if (Math.abs(d) < floor) d = floor;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= maxIterations; m += 1) {
        const m2 = 2 * m;
        let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
        d = 1 + aa * d;
        if (Math.abs(d) < floor) d = floor;
        c = 1 + aa / c;
        if (Math.abs(c) < floor) c = floor;
        d = 1 / d;
        h *= d * c;
        aa = -((a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
        d = 1 + aa * d;
        if (Math.abs(d) < floor) d = floor;
        c = 1 + aa / c;
        if (Math.abs(c) < floor) c = floor;
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
    const logFront = logGamma(a + b) - logGamma(a) - logGamma(b) +
        a * Math.log(x) + b * Math.log(1 - x);
    const front = Math.exp(logFront);
    if (x < (a + 1) / (a + b + 2)) {
        return (front * betaContinuedFraction(a, b, x)) / a;
    }
    return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

export function studentTCdf(value, degreesOfFreedom) {
    const t = Number(value);
    const df = Number(degreesOfFreedom);
    if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return NaN;
    if (t === 0) return 0.5;
    const x = df / (df + t * t);
    const ibeta = regularizedIncompleteBeta(x, df / 2, 0.5);
    return t > 0 ? 1 - 0.5 * ibeta : 0.5 * ibeta;
}

export function studentTQuantile(probability, degreesOfFreedom) {
    const p = Number(probability);
    const df = Number(degreesOfFreedom);
    if (!(p > 0 && p < 1) || !(df > 0)) return NaN;
    if (p === 0.5) return 0;
    if (p < 0.5) return -studentTQuantile(1 - p, df);
    let low = 0;
    let high = 32;
    for (let index = 0; index < 90; index += 1) {
        const mid = (low + high) / 2;
        const cdf = studentTCdf(mid, df);
        if (cdf < p) low = mid;
        else high = mid;
    }
    return (low + high) / 2;
}

function refreshTemporalMetricBucket(bucket = {}) {
    const completed = Math.max(0, safeNumber(bucket.completed, 0));
    const sumNetR = safeNumber(bucket.sumNetR ?? bucket.totalR, 0);
    const sumNetR2 = Math.max(0, safeNumber(bucket.sumNetR2, 0));
    const mean = completed > 0 ? sumNetR / completed : 0;
    const sampleVariance = completed > 1
        ? Math.max(0, (sumNetR2 - (sumNetR * sumNetR) / completed) / (completed - 1))
        : 0;
    const standardError = completed > 1
        ? Math.sqrt(sampleVariance / completed)
        : 0;
    const critical = completed > 1 ? studentTQuantile(0.95, completed - 1) : 0;
    const sumNetPnlPct = safeNumber(bucket.sumNetPnlPct ?? bucket.totalNetPnlPct, 0);
    bucket.sumNetR = sumNetR;
    bucket.totalR = sumNetR;
    bucket.sumNetPnlPct = sumNetPnlPct;
    bucket.totalNetPnlPct = sumNetPnlPct;
    bucket.avgNetPnlPct = completed > 0 ? sumNetPnlPct / completed : 0;
    bucket.avgNetR = mean;
    bucket.avgR = mean;
    bucket.variance = completed > 0 ? Math.max(0, sumNetR2 / completed - mean * mean) : 0;
    bucket.sampleVariance = sampleVariance;
    bucket.standardError = standardError;
    bucket.lcb95 = completed > 1 ? mean - critical * standardError : mean;
    bucket.ucb95 = completed > 1 ? mean + critical * standardError : mean;
    bucket.avgCostR = completed > 0 ? safeNumber(bucket.totalCostR, 0) / completed : 0;
    bucket.directSLPct = completed > 0 ? safeNumber(bucket.directSLCount, 0) / completed : 0;
    bucket.winrate = completed > 0 ? safeNumber(bucket.wins, 0) / completed : 0;
    const grossLossR = Math.max(0, safeNumber(bucket.grossLossR, 0));
    const grossWinR = Math.max(0, safeNumber(bucket.grossWinR, 0));
    bucket.profitFactor = grossLossR > 0
        ? grossWinR / grossLossR
        : grossWinR > 0
          ? 999
          : 0;
    return bucket;
}

export function ensureTemporalStats(stats = {}) {
    const storedVersions = {
        temporalContextVersion: String(stats.temporalContextVersion || '').trim(),
        temporalPolicyVersion: String(stats.temporalPolicyVersion || '').trim(),
        taxonomyVersion: String(
            stats.temporalTaxonomyVersion || stats.taxonomyVersion || ''
        ).trim(),
        costModelVersion: String(
            stats.temporalCostModelVersion || stats.costModelVersion || ''
        ).trim()
    };
    const rawTemporalBuckets = [
        ...Object.values(stats.contextStats || stats.dayTypeStats || {}),
        ...Object.values(stats.dayOfWeekStats || {}),
        ...Object.values(stats.sessionStats || {}),
        ...Object.values(stats.hourOfDayStats || {}),
        ...Object.values(stats.dayHourStats || {}).flatMap((day) => Object.values(day || {})),
        ...weatherMetricBuckets(stats)
    ];
    const hadTemporalOutcomeData = rawTemporalBuckets.some((bucket) =>
        safeNumber(bucket?.completed, 0) > 0 ||
        Math.abs(safeNumber(bucket?.sumNetR ?? bucket?.totalR, 0)) > 0
    ) || safeNumber(stats.acceptedTemporalOutcomeSeq, 0) > 0;
    const temporalVersionsCompatible =
        storedVersions.temporalContextVersion === TEMPORAL_CONTEXT_VERSION &&
        storedVersions.temporalPolicyVersion === TEMPORAL_POLICY_VERSION &&
        storedVersions.taxonomyVersion === TEMPORAL_TAXONOMY_VERSION &&
        storedVersions.costModelVersion === TEMPORAL_COST_MODEL_VERSION;
    const resetIncompatibleTemporalOutcomes = hadTemporalOutcomeData &&
        !temporalVersionsCompatible;

    const contextSource = stats.contextStats && typeof stats.contextStats === 'object'
        ? stats.contextStats
        : stats.dayTypeStats && typeof stats.dayTypeStats === 'object'
          ? stats.dayTypeStats
          : {};
    const daySource = stats.dayOfWeekStats && typeof stats.dayOfWeekStats === 'object'
        ? stats.dayOfWeekStats
        : {};
    const sessionSource = stats.sessionStats && typeof stats.sessionStats === 'object'
        ? stats.sessionStats
        : {};
    const hourSource = stats.hourOfDayStats && typeof stats.hourOfDayStats === 'object'
        ? stats.hourOfDayStats
        : {};
    const dayHourSource = stats.dayHourStats && typeof stats.dayHourStats === 'object'
        ? stats.dayHourStats
        : {};
    const marketWeatherSource = stats.marketWeatherStats && typeof stats.marketWeatherStats === 'object'
        ? stats.marketWeatherStats
        : {};
    const dayWeatherSource = stats.dayWeatherStats && typeof stats.dayWeatherStats === 'object'
        ? stats.dayWeatherStats
        : {};
    const hourWeatherSource = stats.hourWeatherStats && typeof stats.hourWeatherStats === 'object'
        ? stats.hourWeatherStats
        : {};
    const dayHourWeatherSource = stats.dayHourWeatherStats && typeof stats.dayHourWeatherStats === 'object'
        ? stats.dayHourWeatherStats
        : {};
    const btcRouterSource = stats.btcRouterStats && typeof stats.btcRouterStats === 'object'
        ? stats.btcRouterStats : {};
    const dayBtcSource = stats.dayBtcStats && typeof stats.dayBtcStats === 'object'
        ? stats.dayBtcStats : {};
    const hourBtcSource = stats.hourBtcStats && typeof stats.hourBtcStats === 'object'
        ? stats.hourBtcStats : {};
    const dayHourBtcSource = stats.dayHourBtcStats && typeof stats.dayHourBtcStats === 'object'
        ? stats.dayHourBtcStats : {};
    const marketWeatherBtcSource = stats.marketWeatherBtcStats && typeof stats.marketWeatherBtcStats === 'object'
        ? stats.marketWeatherBtcStats : {};
    const dayWeatherBtcSource = stats.dayWeatherBtcStats && typeof stats.dayWeatherBtcStats === 'object'
        ? stats.dayWeatherBtcStats : {};
    const hourWeatherBtcSource = stats.hourWeatherBtcStats && typeof stats.hourWeatherBtcStats === 'object'
        ? stats.hourWeatherBtcStats : {};
    const dayHourWeatherBtcSource = stats.dayHourWeatherBtcStats && typeof stats.dayHourWeatherBtcStats === 'object'
        ? stats.dayHourWeatherBtcStats : {};
    const dayTypeStats = Object.fromEntries(
        TEMPORAL_DAY_TYPE_BUCKETS.map((bucket) => [
            bucket,
            normalizeTemporalMetricBucket(contextSource[bucket])
        ])
    );
    stats.contextStats = dayTypeStats;
    stats.dayTypeStats = dayTypeStats;
    stats.dayOfWeekStats = Object.fromEntries(
        TEMPORAL_DAY_BUCKETS.map((bucket) => [
            bucket,
            normalizeTemporalMetricBucket(daySource[bucket])
        ])
    );
    stats.sessionStats = Object.fromEntries(
        TEMPORAL_PRIMARY_SESSION_BUCKETS.map((bucket) => [
            bucket,
            normalizeTemporalMetricBucket(sessionSource[bucket])
        ])
    );
    stats.hourOfDayStats = Object.fromEntries(
        TEMPORAL_HOUR_BUCKETS.map((bucket) => [
            bucket,
            normalizeTemporalMetricBucket(hourSource[bucket])
        ])
    );
    stats.dayHourStats = Object.fromEntries(
        TEMPORAL_DAY_BUCKETS.map((day) => [
            day,
            Object.fromEntries(
                TEMPORAL_HOUR_BUCKETS.map((bucket) => [
                    bucket,
                    normalizeTemporalMetricBucket(dayHourSource?.[day]?.[bucket])
                ])
            )
        ])
    );
    stats.marketWeatherStats = normalizeSparseTemporalMetricMap(marketWeatherSource);
    stats.dayWeatherStats = Object.fromEntries(
        TEMPORAL_DAY_BUCKETS.map((day) => [
            day,
            normalizeSparseTemporalMetricMap(dayWeatherSource?.[day])
        ])
    );
    stats.hourWeatherStats = Object.fromEntries(
        TEMPORAL_HOUR_BUCKETS.map((hour) => [
            hour,
            normalizeSparseTemporalMetricMap(hourWeatherSource?.[hour])
        ])
    );
    stats.dayHourWeatherStats = Object.fromEntries(
        TEMPORAL_DAY_BUCKETS.map((day) => [
            day,
            Object.fromEntries(
                TEMPORAL_HOUR_BUCKETS.map((hour) => [
                    hour,
                    normalizeSparseTemporalMetricMap(dayHourWeatherSource?.[day]?.[hour])
                ])
            )
        ])
    );
    stats.btcRouterStats = normalizeSparseBtcMetricMap(btcRouterSource);
    stats.dayBtcStats = Object.fromEntries(
        TEMPORAL_DAY_BUCKETS.map((day) => [day, normalizeSparseBtcMetricMap(dayBtcSource?.[day])])
    );
    stats.hourBtcStats = Object.fromEntries(
        TEMPORAL_HOUR_BUCKETS.map((hour) => [hour, normalizeSparseBtcMetricMap(hourBtcSource?.[hour])])
    );
    stats.dayHourBtcStats = Object.fromEntries(
        TEMPORAL_DAY_BUCKETS.map((day) => [
            day,
            Object.fromEntries(TEMPORAL_HOUR_BUCKETS.map((hour) => [
                hour,
                normalizeSparseBtcMetricMap(dayHourBtcSource?.[day]?.[hour])
            ]))
        ])
    );
    stats.marketWeatherBtcStats = normalizeSparseWeatherBtcMetricMap(marketWeatherBtcSource);
    stats.dayWeatherBtcStats = Object.fromEntries(
        TEMPORAL_DAY_BUCKETS.map((day) => [
            day,
            normalizeSparseWeatherBtcMetricMap(dayWeatherBtcSource?.[day])
        ])
    );
    stats.hourWeatherBtcStats = Object.fromEntries(
        TEMPORAL_HOUR_BUCKETS.map((hour) => [
            hour,
            normalizeSparseWeatherBtcMetricMap(hourWeatherBtcSource?.[hour])
        ])
    );
    stats.dayHourWeatherBtcStats = Object.fromEntries(
        TEMPORAL_DAY_BUCKETS.map((day) => [
            day,
            Object.fromEntries(TEMPORAL_HOUR_BUCKETS.map((hour) => [
                hour,
                normalizeSparseWeatherBtcMetricMap(dayHourWeatherBtcSource?.[day]?.[hour])
            ]))
        ])
    );
    stats.acceptedTemporalOutcomeSeq = Math.max(
        0,
        Math.floor(safeNumber(stats.acceptedTemporalOutcomeSeq, 0))
    );
    if (resetIncompatibleTemporalOutcomes) {
        const buckets = [
            ...Object.values(stats.dayTypeStats),
            ...Object.values(stats.dayOfWeekStats),
            ...Object.values(stats.sessionStats),
            ...Object.values(stats.hourOfDayStats),
            ...Object.values(stats.dayHourStats).flatMap((day) => Object.values(day || {})),
            ...weatherMetricBuckets(stats)
        ];
        for (const bucket of buckets) {
            const seen = safeNumber(bucket.seen, 0);
            const observations = safeNumber(bucket.observations, seen);
            Object.assign(bucket, createTemporalMetricBucket(), { seen, observations });
        }
        stats.acceptedTemporalOutcomeSeq = 0;
        stats.temporalOutcomeMigrationRequired = true;
        stats.temporalOutcomeMigrationReason = 'INCOMPATIBLE_TEMPORAL_VERSION_RESET_REQUIRES_BACKFILL';
        stats.previousTemporalVersions = storedVersions;
        stats.temporalOutcomeMigrationAt = now();
    }
    Object.assign(stats, temporalRuntimeConfig(), {
        temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
        temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
        weekendPolicyVersion: WEEKEND_POLICY_VERSION,
        sessionPolicyVersion: SESSION_POLICY_VERSION,
        temporalTaxonomyVersion: TEMPORAL_TAXONOMY_VERSION,
        temporalCostModelVersion: TEMPORAL_COST_MODEL_VERSION,
        temporalHourlyProfileVersion: TEMPORAL_HOURLY_PROFILE_VERSION,
        temporalMarketWeatherProfileVersion: TEMPORAL_MARKET_WEATHER_PROFILE_VERSION,
        btcDirectionRouterProfileVersion: BTC_DIRECTION_ROUTER_PROFILE_VERSION,
        btcDirectionRouterPolicyVersion: BTC_DIRECTION_ROUTER_POLICY_VERSION,
        temporalMarketWeatherKeys: TEMPORAL_MARKET_WEATHER_KEYS,
        btcRouterStates: BTC_ROUTER_STATES,
        weekendLearningAllowed: true,
        weekendVirtualEntryAllowed: true,
        weekendDiscordEntryAllowed: false,
        weekendExitMonitoringAllowed: true,
        weekendOutcomeRecordingAllowed: true,
        sessionLearningAllowed: true,
        sessionVirtualEntryAllowed: true,
        sessionDiscordEntryAllowed: true,
        familyIdentityIncludesTemporalBucket: false
    });
    return stats;
}

function temporalBucketsForContext(stats, context, row = {}) {
    const hourBucket = temporalHourKey(context.hourUtc);
    const weather = resolveEntryMarketWeatherContext(row);
    const weatherKey = weather.marketWeatherKey;
    const btc = resolveEntryBtcRouterContext({
        ...row,
        entryMarketWeatherKey: weatherKey,
        entryMarketWeatherRegime: weather.regime,
        entryMarketWeatherTrendSide: weather.trendSide
    });
    const btcState = btc.btcRouterState;
    const weatherBuckets = [
        sparseTemporalMetricBucket(stats.marketWeatherStats, weatherKey),
        sparseTemporalMetricBucket(stats.dayWeatherStats?.[context.dayOfWeekUtc], weatherKey),
        sparseTemporalMetricBucket(stats.hourWeatherStats?.[hourBucket], weatherKey),
        sparseTemporalMetricBucket(
            stats.dayHourWeatherStats?.[context.dayOfWeekUtc]?.[hourBucket],
            weatherKey
        )
    ];
    const btcBuckets = [
        sparseBtcMetricBucket(stats.btcRouterStats, btcState),
        sparseBtcMetricBucket(stats.dayBtcStats?.[context.dayOfWeekUtc], btcState),
        sparseBtcMetricBucket(stats.hourBtcStats?.[hourBucket], btcState),
        sparseBtcMetricBucket(stats.dayHourBtcStats?.[context.dayOfWeekUtc]?.[hourBucket], btcState),
        sparseWeatherBtcMetricBucket(stats.marketWeatherBtcStats, weatherKey, btcState),
        sparseWeatherBtcMetricBucket(stats.dayWeatherBtcStats?.[context.dayOfWeekUtc], weatherKey, btcState),
        sparseWeatherBtcMetricBucket(stats.hourWeatherBtcStats?.[hourBucket], weatherKey, btcState),
        sparseWeatherBtcMetricBucket(
            stats.dayHourWeatherBtcStats?.[context.dayOfWeekUtc]?.[hourBucket],
            weatherKey,
            btcState
        )
    ];
    return [
        stats.dayTypeStats[context.dayType],
        stats.dayOfWeekStats[context.dayOfWeekUtc],
        stats.sessionStats[context.primarySessionBucket],
        stats.hourOfDayStats?.[hourBucket],
        stats.dayHourStats?.[context.dayOfWeekUtc]?.[hourBucket],
        ...weatherBuckets,
        ...btcBuckets
    ].filter(Boolean);
}

export function recordTemporalObservation(stats = {}, row = {}) {
    ensureTemporalStats(stats);
    const context = resolveEntryTemporalContext(row);
    if (!temporalStatsEnabled() || !statsRepresentsExactChild(stats)) return context;
    for (const bucket of temporalBucketsForContext(stats, context, row)) {
        bucket.seen = safeNumber(bucket.seen, 0) + 1;
        bucket.observations = safeNumber(bucket.observations, 0) + 1;
        refreshTemporalMetricBucket(bucket);
    }
    stats.lastTemporalContext = context;
    stats.lastObservationTemporalContext = context;
    stats.lastObservationDayType = context.dayType;
    stats.lastObservationDayOfWeekUtc = context.dayOfWeekUtc;
    stats.lastObservationHourUtc = context.hourUtc;
    stats.lastObservationHourBucket = context.hourBucket;
    const weather = resolveEntryMarketWeatherContext(row);
    stats.lastObservationDayHourBucket = context.dayHourBucket;
    stats.lastObservationMarketWeatherKey = weather.marketWeatherKey;
    stats.lastObservationMarketWeatherRegime = weather.regime;
    stats.lastObservationMarketWeatherTrendSide = weather.trendSide;
    const btc = resolveEntryBtcRouterContext(row);
    stats.lastObservationBtcRouterState = btc.btcRouterState;
    stats.lastObservationBtcDirection = btc.direction;
    stats.lastObservationBtcConfidence = btc.confidence;
    stats.lastObservationBtcTrendStrength = btc.trendStrength;
    stats.lastObservationBtcBreadthConfirmed = btc.breadthConfirmed;
    stats.lastObservationSessionBucket = context.primarySessionBucket;
    return context;
}

function statsRepresentsExactChild(stats = {}) {
    const id = String(
        stats.childTrueMicroFamilyId ||
        stats.trueMicroFamilyId ||
        stats.microFamilyId ||
        ''
    ).trim().toUpperCase();
    return /^MICRO_LONG_(BREAKOUT|RETEST|SWEEP_REVERSAL|CONTINUATION|COMPRESSION)_(TREND|CHOP|SQUEEZE)_(A_STRONG_ALIGN|B_FLOW_ALIGN|C_VOLUME_ALIGN|D_MIXED_OK|E_WEAK_CONTRA)$/.test(id);
}

export function recordTemporalOutcome(stats = {}, row = {}, metrics = {}) {
    ensureTemporalStats(stats);
    const context = resolveEntryTemporalContext(row);
    if (!temporalStatsEnabled() || !statsRepresentsExactChild(stats)) return context;
    const netR = Number(metrics.netR ?? row.netR ?? row.exitR);
    if (!Number.isFinite(netR)) return context;
    const grossR = safeNumber(metrics.grossR ?? row.grossR ?? row.rawR, netR);
    const costR = Math.max(0, safeNumber(metrics.costR ?? row.costR, Math.max(0, grossR - netR)));
    const directSL = Boolean(metrics.directSL ?? row.directSL ?? row.directToSL);
    const rawNetPnlPct = Number(
        metrics.netPnlPct ?? row.netPnlPct ?? row.pnlPct ?? row.realizedNetPnlPct
    );
    const netPnlPct = Number.isFinite(rawNetPnlPct) ? rawNetPnlPct : 0;
    const outcomeTs = temporalTimestamp(
        row.outcomePersistedTs,
        row.outcomeFinalizedTs,
        row.exitTs,
        row.closedAt,
        row.completedAt,
        now()
    );
    const nextSequence = Math.max(0, safeNumber(stats.acceptedTemporalOutcomeSeq, 0)) + 1;
    stats.acceptedTemporalOutcomeSeq = nextSequence;
    if (statsRepresentsExactChild(stats)) {
        row.acceptedTemporalOutcomeSeq = nextSequence;
    }
    for (const bucket of temporalBucketsForContext(stats, context, row)) {
        bucket.completed = safeNumber(bucket.completed, 0) + 1;
        bucket.wins = safeNumber(bucket.wins, 0) + (netR > 0 ? 1 : 0);
        bucket.losses = safeNumber(bucket.losses, 0) + (netR < 0 ? 1 : 0);
        bucket.flats = safeNumber(bucket.flats, 0) + (netR === 0 ? 1 : 0);
        bucket.sumNetR = safeNumber(bucket.sumNetR, 0) + netR;
        bucket.sumNetR2 = safeNumber(bucket.sumNetR2, 0) + netR * netR;
        bucket.sumNetPnlPct = safeNumber(bucket.sumNetPnlPct, 0) + netPnlPct;
        bucket.sumNetPnlPct2 = safeNumber(bucket.sumNetPnlPct2, 0) + netPnlPct * netPnlPct;
        bucket.grossWinR = safeNumber(bucket.grossWinR, 0) + (netR > 0 ? netR : 0);
        bucket.grossLossR = safeNumber(bucket.grossLossR, 0) + (netR < 0 ? Math.abs(netR) : 0);
        bucket.directSLCount = safeNumber(bucket.directSLCount, 0) + (directSL ? 1 : 0);
        bucket.totalCostR = safeNumber(bucket.totalCostR, 0) + costR;
        bucket.lastOutcomeTs = outcomeTs;
        bucket.acceptedTemporalOutcomeSeq = nextSequence;
        refreshTemporalMetricBucket(bucket);
    }
    stats.lastOutcomeTemporalContext = context;
    stats.lastOutcomeDayType = context.dayType;
    stats.lastOutcomeDayOfWeekUtc = context.dayOfWeekUtc;
    stats.lastOutcomeHourUtc = context.hourUtc;
    stats.lastOutcomeHourBucket = context.hourBucket;
    const weather = resolveEntryMarketWeatherContext(row);
    stats.lastOutcomeDayHourBucket = context.dayHourBucket;
    stats.lastOutcomeMarketWeatherKey = weather.marketWeatherKey;
    stats.lastOutcomeMarketWeatherRegime = weather.regime;
    stats.lastOutcomeMarketWeatherTrendSide = weather.trendSide;
    const btc = resolveEntryBtcRouterContext(row);
    stats.lastOutcomeBtcRouterState = btc.btcRouterState;
    stats.lastOutcomeBtcDirection = btc.direction;
    stats.lastOutcomeBtcConfidence = btc.confidence;
    stats.lastOutcomeBtcTrendStrength = btc.trendStrength;
    stats.lastOutcomeBtcBreadthConfirmed = btc.breadthConfirmed;
    stats.lastOutcomeSessionBucket = context.primarySessionBucket;
    stats.lastTemporalOutcomeTs = outcomeTs;
    return context;
}

export function resetTemporalOutcomeMetrics(stats = {}) {
    ensureTemporalStats(stats);
    const buckets = [
        ...Object.values(stats.dayTypeStats),
        ...Object.values(stats.dayOfWeekStats),
        ...Object.values(stats.sessionStats),
        ...Object.values(stats.hourOfDayStats),
        ...Object.values(stats.dayHourStats).flatMap((day) => Object.values(day || {})),
        ...weatherMetricBuckets(stats)
    ];
    for (const bucket of buckets) {
        const seen = safeNumber(bucket.seen, 0);
        const observations = safeNumber(bucket.observations, 0);
        Object.assign(bucket, createTemporalMetricBucket(), { seen, observations });
    }
    stats.acceptedTemporalOutcomeSeq = 0;
    return stats;
}

function exactLongChildFamilyId(value) {
    const id = String(value || '').trim().toUpperCase();
    return /^MICRO_LONG_(BREAKOUT|RETEST|SWEEP_REVERSAL|CONTINUATION|COMPRESSION)_(TREND|CHOP|SQUEEZE)_(A_STRONG_ALIGN|B_FLOW_ALIGN|C_VOLUME_ALIGN|D_MIXED_OK|E_WEAK_CONTRA)$/.test(id)
        ? id
        : null;
}

function temporalOutcomeCanonicalId(row = {}) {
    const value = String(
        row.canonicalOutcomeId ||
        row.canonicalPositionId ||
        row.outcomeId ||
        row.positionId ||
        ''
    ).trim();
    return value || null;
}

function rowVersion(row = {}, keys = []) {
    for (const key of keys) {
        const value = String(row[key] || '').trim();
        if (value) return value;
    }
    return '';
}

export function normalizeTemporalOutcome(row = {}, expectedFamilyId = null) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const familyId = exactLongChildFamilyId(
        row.trueMicroFamilyId || row.childTrueMicroFamilyId || row.microFamilyId
    );
    if (!familyId || (expectedFamilyId && familyId !== exactLongChildFamilyId(expectedFamilyId))) {
        return null;
    }
    const source = String(row.source || row.outcomeSource || '').trim().toUpperCase();
    if (!TEMPORAL_SOURCE_SET.has(source)) return null;
    const side = sideToTradeSide(
        row.tradeSide || row.positionSide || row.direction || row.side || TARGET_TRADE_SIDE
    );
    if (side !== TARGET_TRADE_SIDE) return null;
    const netR = Number(row.netR ?? row.exitR ?? row.netPnlR);
    if (!Number.isFinite(netR)) return null;
    const canonicalOutcomeId = temporalOutcomeCanonicalId(row);
    if (!canonicalOutcomeId) return null;
    const entryContext = resolveEntryTemporalContext(row);
    const exitContext = resolveExitTemporalContext(row);
    const entryTs = normalizeTimestampMs(row.entryTs ?? entryContext.contextTs, 0);
    const exitTs = normalizeTimestampMs(row.exitTs ?? row.closedAt ?? row.completedAt ?? exitContext.contextTs, 0);
    const outcomeFinalizedTs = normalizeTimestampMs(
        row.outcomeFinalizedTs ?? row.finalizedAt ?? row.closedAt ?? row.completedAt,
        0
    );
    const outcomePersistedTs = normalizeTimestampMs(
        row.outcomePersistedTs ?? row.persistedAt ?? row.recordedAt ?? row.updatedAt,
        0
    );
    if (!(entryTs > 0 && exitTs > 0 && outcomeFinalizedTs > 0 && outcomePersistedTs > 0)) {
        return null;
    }
    const measurementVersion = rowVersion(row, [
        'measurementFixVersion',
        'outcomeMeasurementVersion',
        'acceptedOutcomeMeasurementVersion'
    ]);
    const costModelVersion = rowVersion(row, [
        'costModelVersion',
        'exitFillModelVersion'
    ]);
    const taxonomyVersion = rowVersion(row, [
        'taxonomyVersion',
        'trueMicroFamilySchema',
        'childTrueMicroFamilySchema'
    ]);
    const temporalContextVersion = rowVersion(row, ['temporalContextVersion']);
    if (measurementVersion !== MEASUREMENT_FIX_VERSION) return null;
    if (costModelVersion !== TEMPORAL_COST_MODEL_VERSION) return null;
    if (taxonomyVersion !== TEMPORAL_TAXONOMY_VERSION) return null;
    if (temporalContextVersion !== TEMPORAL_CONTEXT_VERSION) return null;
    return {
        ...row,
        familyId,
        trueMicroFamilyId: familyId,
        source,
        canonicalOutcomeId,
        canonicalPositionId: String(row.canonicalPositionId || canonicalOutcomeId),
        netR,
        netPnlPct: safeNumber(
            row.netPnlPct ?? row.pnlPct ?? row.realizedNetPnlPct,
            0
        ),
        grossR: safeNumber(row.grossR ?? row.rawR, netR),
        costR: Math.max(0, safeNumber(row.costR, 0)),
        directSL: Boolean(row.directSL ?? row.directToSL),
        symbol: String(row.symbol || row.baseSymbol || row.contractSymbol || 'UNKNOWN').trim().toUpperCase(),
        entryTs,
        exitTs,
        outcomeFinalizedTs,
        outcomePersistedTs,
        entryHourUtc: entryContext.hourUtc,
        entryHourBucket: entryContext.hourBucket,
        entryDayOfWeekUtc: entryContext.dayOfWeekUtc,
        entryDayHourBucket: entryContext.dayHourBucket,
        entryDayType: entryContext.dayType,
        entrySessionBucket: entryContext.primarySessionBucket,
        entrySessionTags: [...entryContext.sessionTags],
        entryIsWeekend: entryContext.isWeekend,
        ...(() => {
            const weather = resolveEntryMarketWeatherContext(row);
            const btc = resolveEntryBtcRouterContext({
                ...row,
                entryMarketWeatherKey: weather.marketWeatherKey,
                entryMarketWeatherRegime: weather.regime,
                entryMarketWeatherTrendSide: weather.trendSide
            });
            return {
                entryMarketWeatherKey: weather.marketWeatherKey,
                entryMarketWeatherRegime: weather.regime,
                entryMarketWeatherTrendSide: weather.trendSide,
                entryMarketWeatherAvailable: weather.available,
                entryBtcRouterState: btc.btcRouterState,
                entryBtcDirection: btc.direction,
                entryBtcConfidence: btc.confidence,
                entryBtcTrendStrength: btc.trendStrength,
                entryBtcBullishPct: btc.bullishPct,
                entryBtcBearishPct: btc.bearishPct,
                entryBtcAlignedBreadthPct: btc.alignedBreadthPct,
                entryBtcBreadthConfirmed: btc.breadthConfirmed,
                entryBtcAgainstLong: btc.againstLong,
                btcDirectionRouterProfileVersion: BTC_DIRECTION_ROUTER_PROFILE_VERSION,
                btcDirectionRouterPolicyVersion: BTC_DIRECTION_ROUTER_POLICY_VERSION
            };
        })(),
        marketEventClusterId: buildMarketEventClusterId(row, entryContext),
        acceptedTemporalOutcomeSeq: Math.max(0, Math.floor(safeNumber(row.acceptedTemporalOutcomeSeq, 0))),
        measurementVersion,
        costModelVersion,
        taxonomyVersion,
        temporalContextVersion
    };
}

function temporalBucketMatches(row, bucketType, bucketValue) {
    if (bucketType === 'dayType') return row.entryDayType === bucketValue;
    if (bucketType === 'dayOfWeek') return row.entryDayOfWeekUtc === bucketValue;
    if (bucketType === 'session') return row.entrySessionBucket === bucketValue;
    if (bucketType === 'hourOfDay') {
        return temporalHourKey(row.entryHourUtc) === temporalHourKey(bucketValue);
    }
    if (bucketType === 'dayHour') {
        const expected = String(bucketValue || '').trim().toUpperCase();
        return temporalDayHourKey(row.entryDayOfWeekUtc, row.entryHourUtc) === expected;
    }
    if (bucketType === 'marketWeather') {
        return temporalMarketWeatherKey(row.entryMarketWeatherKey) === temporalMarketWeatherKey(bucketValue);
    }
    if (bucketType === 'dayWeather') {
        return temporalDayWeatherKey(row.entryDayOfWeekUtc, row.entryMarketWeatherKey) ===
            String(bucketValue || '').trim().toUpperCase();
    }
    if (bucketType === 'hourWeather') {
        return temporalHourWeatherKey(row.entryHourUtc, row.entryMarketWeatherKey) ===
            String(bucketValue || '').trim().toUpperCase();
    }
    if (bucketType === 'dayHourWeather') {
        return temporalDayHourWeatherKey(
            row.entryDayOfWeekUtc,
            row.entryHourUtc,
            row.entryMarketWeatherKey
        ) === String(bucketValue || '').trim().toUpperCase();
    }
    if (bucketType === 'btcRouter') {
        return temporalBtcRouterKey(row.entryBtcRouterState) === temporalBtcRouterKey(bucketValue);
    }
    if (bucketType === 'marketWeatherBtc') {
        return temporalMarketWeatherBtcKey(row.entryMarketWeatherKey, row.entryBtcRouterState) ===
            String(bucketValue || '').trim().toUpperCase();
    }
    if (bucketType === 'dayBtc') {
        return temporalDayBtcKey(row.entryDayOfWeekUtc, row.entryBtcRouterState) ===
            String(bucketValue || '').trim().toUpperCase();
    }
    if (bucketType === 'hourBtc') {
        return temporalHourBtcKey(row.entryHourUtc, row.entryBtcRouterState) ===
            String(bucketValue || '').trim().toUpperCase();
    }
    if (bucketType === 'dayHourBtc') {
        return temporalDayHourBtcKey(row.entryDayOfWeekUtc, row.entryHourUtc, row.entryBtcRouterState) ===
            String(bucketValue || '').trim().toUpperCase();
    }
    if (bucketType === 'dayWeatherBtc') {
        return temporalDayWeatherBtcKey(
            row.entryDayOfWeekUtc,
            row.entryMarketWeatherKey,
            row.entryBtcRouterState
        ) === String(bucketValue || '').trim().toUpperCase();
    }
    if (bucketType === 'hourWeatherBtc') {
        return temporalHourWeatherBtcKey(
            row.entryHourUtc,
            row.entryMarketWeatherKey,
            row.entryBtcRouterState
        ) === String(bucketValue || '').trim().toUpperCase();
    }
    if (bucketType === 'dayHourWeatherBtc') {
        return temporalDayHourWeatherBtcKey(
            row.entryDayOfWeekUtc,
            row.entryHourUtc,
            row.entryMarketWeatherKey,
            row.entryBtcRouterState
        ) === String(bucketValue || '').trim().toUpperCase();
    }
    return true;
}

export function prepareTemporalOutcomePool(outcomes = [], {
    familyId,
    cutoffTs = now(),
    maxAgeDays = TEMPORAL_MAX_WINDOW_AGE_DAYS
} = {}) {
    const normalizedCutoffTs = normalizeTimestampMs(cutoffTs);
    const minimumEntryTs = normalizedCutoffTs - Math.max(1, maxAgeDays) * TEMPORAL_MS_PER_DAY;
    const deduped = new Map();
    for (const raw of Array.isArray(outcomes) ? outcomes : []) {
        const row = normalizeTemporalOutcome(raw, familyId);
        if (!row) continue;
        if (row.entryTs < minimumEntryTs || row.entryTs > normalizedCutoffTs) continue;
        if (row.exitTs > normalizedCutoffTs) continue;
        if (row.outcomeFinalizedTs > normalizedCutoffTs) continue;
        if (row.outcomePersistedTs > normalizedCutoffTs) continue;
        const existing = deduped.get(row.canonicalOutcomeId);
        if (!existing || row.outcomePersistedTs < existing.outcomePersistedTs) {
            deduped.set(row.canonicalOutcomeId, row);
        }
    }
    return [...deduped.values()].sort((left, right) => {
        if (right.entryTs !== left.entryTs) return right.entryTs - left.entryTs;
        return left.canonicalOutcomeId.localeCompare(right.canonicalOutcomeId);
    });
}

export function buildTemporalGateWindowFromPrepared(preparedOutcomes = [], {
    bucketType,
    bucketValue,
    maxOutcomes = TEMPORAL_MAX_WINDOW_OUTCOMES
} = {}) {
    return (Array.isArray(preparedOutcomes) ? preparedOutcomes : [])
        .filter((row) => temporalBucketMatches(row, bucketType, bucketValue))
        .slice(0, Math.max(1, Math.min(TEMPORAL_MAX_WINDOW_OUTCOMES, maxOutcomes)));
}

export function buildTemporalGateWindow(outcomes = [], {
    familyId,
    bucketType,
    bucketValue,
    cutoffTs = now(),
    maxOutcomes = TEMPORAL_MAX_WINDOW_OUTCOMES,
    maxAgeDays = TEMPORAL_MAX_WINDOW_AGE_DAYS
} = {}) {
    const prepared = prepareTemporalOutcomePool(outcomes, {
        familyId,
        cutoffTs,
        maxAgeDays
    });
    return buildTemporalGateWindowFromPrepared(prepared, {
        bucketType,
        bucketValue,
        maxOutcomes
    });
}

export function computeTemporalWindowStats(members = []) {
    const rows = Array.isArray(members) ? members : [];
    const bucket = createTemporalMetricBucket();
    for (const row of rows) {
        const netR = Number(row.netR);
        if (!Number.isFinite(netR)) continue;
        bucket.completed += 1;
        bucket.wins += netR > 0 ? 1 : 0;
        bucket.losses += netR < 0 ? 1 : 0;
        bucket.flats += netR === 0 ? 1 : 0;
        bucket.sumNetR += netR;
        bucket.sumNetR2 += netR * netR;
        const netPnlPct = safeNumber(
            row.netPnlPct ?? row.pnlPct ?? row.realizedNetPnlPct,
            0
        );
        bucket.sumNetPnlPct += netPnlPct;
        bucket.sumNetPnlPct2 += netPnlPct * netPnlPct;
        bucket.grossWinR += netR > 0 ? netR : 0;
        bucket.grossLossR += netR < 0 ? Math.abs(netR) : 0;
        bucket.totalCostR += Math.max(0, safeNumber(row.costR, 0));
        bucket.directSLCount += row.directSL ? 1 : 0;
        bucket.lastOutcomeTs = Math.max(
            safeNumber(bucket.lastOutcomeTs, 0),
            safeNumber(row.outcomePersistedTs, 0)
        ) || null;
        bucket.acceptedTemporalOutcomeSeq = Math.max(
            bucket.acceptedTemporalOutcomeSeq,
            Math.max(0, Math.floor(safeNumber(row.acceptedTemporalOutcomeSeq, 0)))
        );
    }
    return refreshTemporalMetricBucket(bucket);
}

export function temporalGateMaturity(gateWindowCompleted) {
    const completed = Math.max(0, Math.floor(safeNumber(gateWindowCompleted, 0)));
    if (completed === 0) return 'OBSERVING';
    if (completed <= 19) return 'EARLY_OUTCOMES';
    if (completed <= 34) return 'ACTIVE_LEARNING';
    return 'MATURE';
}

function utcDateKey(timestamp) {
    return new Date(normalizeTimestampMs(timestamp)).toISOString().slice(0, 10);
}

function isoWeekKeyUtc(timestamp) {
    const date = new Date(normalizeTimestampMs(timestamp));
    const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const day = utc.getUTCDay() || 7;
    utc.setUTCDate(utc.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((utc - yearStart) / TEMPORAL_MS_PER_DAY) + 1) / 7);
    return `${utc.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function concentration(values = []) {
    const counts = new Map();
    for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
    const maxCount = counts.size > 0 ? Math.max(...counts.values()) : 0;
    return {
        unique: counts.size,
        maxCount,
        maxShare: values.length > 0 ? maxCount / values.length : 0,
        counts: Object.fromEntries(counts)
    };
}

export function evaluateTemporalDiversity(members = [], { weekend = false, hourly = false } = {}) {
    const rows = Array.isArray(members) ? members : [];
    const dateStats = concentration(rows.map((row) => utcDateKey(row.entryTs)));
    const weekStats = concentration(rows.map((row) => isoWeekKeyUtc(row.entryTs)));
    const symbolStats = concentration(rows.map((row) => row.symbol || 'UNKNOWN'));
    const clusterStats = concentration(rows.map((row) => row.marketEventClusterId || 'UNKNOWN'));
    const limits = weekend
        ? {
            completed: 50,
            minDates: 10,
            minWeeks: 8,
            maxDateShare: 0.20,
            minSymbols: 5,
            maxSymbolShare: 0.35,
            minClusters: 12,
            maxClusterShare: 0.20
        }
        : hourly
          ? {
              completed: 12,
              minDates: 6,
              minWeeks: 4,
              maxDateShare: 0.34,
              minSymbols: 3,
              maxSymbolShare: 0.50,
              minClusters: 6,
              maxClusterShare: 0.34
          }
          : {
              completed: 35,
              minDates: 10,
              minWeeks: 4,
              maxDateShare: 0.25,
              minSymbols: 4,
              maxSymbolShare: 0.40,
              minClusters: 10,
              maxClusterShare: 0.20
          };
    const checks = {
        completed: rows.length >= limits.completed,
        dates: dateStats.unique >= limits.minDates,
        weeks: weekStats.unique >= limits.minWeeks,
        dateConcentration: dateStats.maxShare <= limits.maxDateShare + TEMPORAL_FLOAT_TOLERANCE,
        symbols: symbolStats.unique >= limits.minSymbols,
        symbolConcentration: symbolStats.maxShare <= limits.maxSymbolShare + TEMPORAL_FLOAT_TOLERANCE,
        clusters: clusterStats.unique >= limits.minClusters,
        clusterConcentration: clusterStats.maxShare <= limits.maxClusterShare + TEMPORAL_FLOAT_TOLERANCE
    };
    return {
        passed: Object.values(checks).every(Boolean),
        weekend,
        hourly,
        checks,
        limits,
        distinctEntryDates: dateStats.unique,
        distinctIsoWeeks: weekStats.unique,
        maxEntryDateShare: dateStats.maxShare,
        distinctSymbols: symbolStats.unique,
        maxSymbolShare: symbolStats.maxShare,
        distinctMarketEventClusters: clusterStats.unique,
        maxMarketEventClusterShare: clusterStats.maxShare
    };
}

export function evaluateTemporalConfounding(members = [], { broadAxis } = {}) {
    const rows = Array.isArray(members) ? members : [];
    const axis = String(broadAxis || '').trim().toUpperCase();
    const keyFor = axis === 'DAY'
        ? (row) => row.entrySessionBucket
        : (row) => row.entryDayOfWeekUtc;
    const cells = new Map();
    for (const row of rows) {
        const key = keyFor(row);
        if (!key) continue;
        const cell = cells.get(key) || { key, completed: 0, sumNetR: 0 };
        cell.completed += 1;
        cell.sumNetR += safeNumber(row.netR, 0);
        cells.set(key, cell);
    }
    const cellRows = [...cells.values()].map((cell) => ({
        ...cell,
        meanNetR: cell.completed > 0 ? cell.sumNetR / cell.completed : 0,
        supported: cell.completed >= 5,
        negativeContribution: Math.max(0, -cell.sumNetR)
    }));
    const supported = cellRows.filter((cell) => cell.supported);
    const negativeSupported = supported.filter((cell) => cell.meanNetR < 0);
    const totalNegativeContribution = supported.reduce(
        (sum, cell) => sum + cell.negativeContribution,
        0
    );
    const maxNegativeContribution = supported.reduce(
        (max, cell) => Math.max(max, cell.negativeContribution),
        0
    );
    const dominantLossShare = totalNegativeContribution > 0
        ? maxNegativeContribution / totalNegativeContribution
        : 1;
    const interactionCompleted = cellRows.reduce((sum, cell) => sum + cell.completed, 0);
    const interactionSumNetR = cellRows.reduce((sum, cell) => sum + cell.sumNetR, 0);
    const marginalSumNetR = rows.reduce((sum, row) => sum + safeNumber(row.netR, 0), 0);
    const integrity = interactionCompleted === rows.length &&
        Math.abs(interactionSumNetR - marginalSumNetR) <= TEMPORAL_FLOAT_TOLERANCE;
    return {
        passed: integrity &&
            supported.length >= 2 &&
            negativeSupported.length >= 2 &&
            totalNegativeContribution > 0 &&
            dominantLossShare <= 0.70 + TEMPORAL_FLOAT_TOLERANCE,
        broadAxis: axis,
        supportedCellCount: supported.length,
        negativeSupportedCellCount: negativeSupported.length,
        totalNegativeContribution,
        maxNegativeContribution,
        dominantLossShare,
        interactionCompleted,
        interactionSumNetR,
        marginalCompleted: rows.length,
        marginalSumNetR,
        integrity,
        cells: Object.fromEntries(cellRows.map((cell) => [cell.key, cell]))
    };
}

export function temporalOneSidedPValue(stats = {}, direction = 'NEGATIVE') {
    const completed = Math.max(0, Math.floor(safeNumber(stats.completed, 0)));
    const mean = safeNumber(stats.avgNetR ?? stats.avgR, 0);
    const se = Math.max(0, safeNumber(stats.standardError, 0));
    const normalizedDirection = String(direction || '').trim().toUpperCase();
    if (completed < 2) return 1;
    if (se === 0) {
        if (normalizedDirection === 'NEGATIVE') return mean < 0 ? 0 : 1;
        return mean > 0 ? 0 : 1;
    }
    const t = mean / se;
    const cdf = studentTCdf(t, completed - 1);
    return normalizedDirection === 'NEGATIVE'
        ? Math.max(0, Math.min(1, cdf))
        : Math.max(0, Math.min(1, 1 - cdf));
}

export function benjaminiHochberg(tests = []) {
    const rows = (Array.isArray(tests) ? tests : [])
        .map((test, index) => ({
            ...test,
            __index: index,
            pValue: Math.max(0, Math.min(1, safeNumber(test.pValue, 1)))
        }))
        .sort((left, right) => left.pValue - right.pValue || left.__index - right.__index);
    const count = rows.length;
    let nextQ = 1;
    for (let index = count - 1; index >= 0; index -= 1) {
        const rank = index + 1;
        const rawQ = Math.min(1, (rows[index].pValue * count) / rank);
        nextQ = Math.min(nextQ, rawQ);
        rows[index].qValue = nextQ;
        rows[index].bhRank = rank;
        rows[index].bhBatchSize = count;
    }
    return rows
        .sort((left, right) => left.__index - right.__index)
        .map(({ __index, ...row }) => row);
}

function now() {
    return Date.now();
}


function round4(value) {
    return Number(safeNumber(value, 0).toFixed(4));
}


function upper(value, fallback = '') {
    const text = String(value ?? '').trim();


    return text ? text.toUpperCase() : fallback;
}


function rotationNumber(key, fallback) {
    return safeNumber(
         CONFIG.long?.rotation?.[key] ??
           CONFIG.rotation?.[key],
         fallback
    );
}


function analyzeNumber(key, fallback) {
    return safeNumber(
         CONFIG.long?.analyze?.[key] ??
           CONFIG.analyze?.[key],
         fallback
    );
}


function observationDedupeCacheLimit() {
    return Math.max(
         100,
         Math.floor(analyzeNumber('observationDedupeCacheLimit',
DEFAULT_OBSERVATION_DEDUPE_CACHE_LIMIT))
    );
}


function schemaConfig() {
    const macroSchema = String(
         CONFIG.long?.analyze?.macroSchema ??
           CONFIG.analyze?.macroSchema ??
           CONFIG.analyze?.legacySchema ??
           'MF_V1'
    ).toUpperCase();
    const configuredLegacyMicroSchema = String(
         CONFIG.long?.analyze?.legacyMicroSchema ??
           CONFIG.long?.analyze?.microSchema ??
           CONFIG.analyze?.legacyMicroSchema ??
           CONFIG.analyze?.microSchema ??
           'MF_V2'
    ).toUpperCase();


    return {
         currentSchema: TRUE_MICRO_SCHEMA,
         macroSchema,
         microSchema: TRUE_MICRO_SCHEMA,
         legacyMicroSchema: configuredLegacyMicroSchema,
         trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
         childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
         parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
         learningGranularity: LEARNING_GRANULARITY,
         parentLearningGranularity: PARENT_LEARNING_GRANULARITY
    };
}


function shadowWeight() {
    return clamp(analyzeNumber('shadowWeight', 0.35), 0, 1);
}


function priorTrades() {
    return Math.max(0, rotationNumber('priorTrades', DEFAULT_PRIOR_TRADES));
}


function priorWinrate() {
    return clamp(rotationNumber('priorWinrate', DEFAULT_PRIOR_WINRATE), 0, 1);
}


function wilsonZ() {
    return Math.max(0.1, rotationNumber('wilsonZ', DEFAULT_WILSON_Z));
}


function sampleCap() {
    return Math.max(1, rotationNumber('sampleReliabilityCap', DEFAULT_SAMPLE_CAP));
}


function avgRCap() {
    return Math.max(0.5, rotationNumber('avgRCap', DEFAULT_AVG_R_CAP));
}


function avgRSampleExponent() {
    return clamp(
         rotationNumber('avgRSampleExponent', DEFAULT_AVG_R_SAMPLE_EXPONENT),
         0.5,
         3
    );
}


function positive(value) {
    return Math.max(0, safeNumber(value, 0));
}


function finiteOrNull(value) {
    if (value === undefined || value === null || value === '') return null;


    const n = Number(value);


    return Number.isFinite(n) ? n : null;
}



function normalizeMeasurementFixVersion(value = '') {
    return upper(value);
}


function rowMeasurementFixVersion(row = {}) {
    return normalizeMeasurementFixVersion(
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


function outcomeResetNumericFields() {
    return [
         'virtualCompleted',
         'realCompleted',
         'shadowCompleted',
         'completed',
         'winrateSample',


         'wins',
'losses',
'flats',


'virtualWins',
'virtualLosses',
'virtualFlats',


'realWins',
'realLosses',
'realFlats',


'shadowWins',
'shadowLosses',
'shadowFlats',


'totalR',
'virtualTotalR',
'realTotalR',
'shadowTotalR',


'totalPnlPct',
'virtualTotalPnlPct',
'realTotalPnlPct',
'shadowTotalPnlPct',


'totalCostR',
'virtualTotalCostR',
'realTotalCostR',
'shadowTotalCostR',


'grossWinR',
'grossLossR',


'virtualGrossWinR',
'virtualGrossLossR',
'realGrossWinR',
'realGrossLossR',
'shadowGrossWinR',
'shadowGrossLossR',


'avgR',
'avgWinR',
'avgLossR',
'sampleAdjustedAvgR',
'avgRScore',
'avgPnlPct',
'avgCostR',
         'directSLCount',
         'nearTpCount',
         'reachedHalfRCount',
         'reachedOneRCount',


         'beWouldExitCount',
         'gaveBackAfterHalfRCount',
         'gaveBackAfterOneRCount',
         'nearTpThenLossCount',


         'winrate',
         'bayesianWinrate',
         'wilsonLowerBound',
         'fairWinrate',
         'sampleAdjustedWinrate',


         'sampleRawWinrate',
         'sampleBayesianWinrate',
         'sampleWilsonLowerBound',
         'sampleReliabilityOld',


         'profitFactor',
         'sampleReliability',
         'balancedScore',
         'dashboardBalancedScore',


         'directSLPct',
         'nearTpPct',
         'reachedHalfRPct',
         'reachedOneRPct',


         'beWouldExitPct',
         'gaveBackAfterHalfRPct',
         'gaveBackAfterOneRPct',
         'nearTpThenLossPct'
    ];
}


function hasStoredOutcomeMeasurementData(stats = {}) {
    if (
         Array.isArray(stats.recentOutcomes) &&
         stats.recentOutcomes.length > 0
    ) {
         return true;
    }
    return outcomeResetNumericFields().some(
         (field) => safeNumber(stats[field], 0) !== 0
    );
}


function storedCompletedForMeasurementIntegrity(stats = {}) {
    const sourceCompleted =
         safeNumber(stats.virtualCompleted, 0) +
         safeNumber(stats.shadowCompleted, 0);


    return Math.max(
         sourceCompleted,
         safeNumber(stats.completed, 0),
         0
    );
}


function currentMeasurementAggregateIntegrity(stats = {}) {
    const completed = storedCompletedForMeasurementIntegrity(stats);
    const acceptedOutcomeCount = Math.max(
         0,
         safeNumber(stats.measurementVersionAcceptedOutcomeCount, 0)
    );


    const recentOutcomes = Array.isArray(stats.recentOutcomes)
         ? stats.recentOutcomes
         : [];


    const nonCurrentRecentOutcomeCount = recentOutcomes
         .filter((outcome) => !isCurrentMeasurementOutcome(outcome))
         .length;


    const acceptedCountCoversCompleted =
         completed <= 0 || acceptedOutcomeCount >= completed;


    return {
         valid:
              acceptedCountCoversCompleted &&
              nonCurrentRecentOutcomeCount === 0,
         completed,
         acceptedOutcomeCount,
         acceptedCountCoversCompleted,
         recentOutcomeCount: recentOutcomes.length,
         nonCurrentRecentOutcomeCount
    };
}
function applyOutcomeMeasurementPolicyFlags(stats = {}) {
    stats.measurementFixVersion = MEASUREMENT_FIX_VERSION;
    stats.outcomeMeasurementVersion = MEASUREMENT_FIX_VERSION;
    stats.acceptedOutcomeMeasurementVersion = MEASUREMENT_FIX_VERSION;
    stats.previousSupportedMeasurementFixVersion = PREVIOUS_MEASUREMENT_FIX_VERSION;


    stats.outcomeMeasurementGateMode = OUTCOME_MEASUREMENT_GATE_MODE;
    stats.outcomeMeasurementVersionRequired = true;
    stats.strictOutcomeMeasurementGate = true;
    stats.legacyOutcomeMeasurementsExcluded = true;
    stats.completedCurrentMeasurementOnly = true;


    stats.exitFillModelVersion = EXIT_FILL_MODEL_VERSION;
    stats.exitFillPolicy =
'TP_SL_USE_TRIGGER_BOUNDARY_TIME_STOP_USES_OBSERVED_PRICE';
    stats.exitFillAssumption = 'TRIGGER_BOUNDARY_PLUS_COST_MODEL';


    return stats;
}


function migrateOutcomeMeasurementVersion(stats = {}) {
    const storedVersion = rowMeasurementFixVersion(stats);
    const alreadyCurrent = storedVersion === MEASUREMENT_FIX_VERSION;
    const integrity = currentMeasurementAggregateIntegrity(stats);


    if (alreadyCurrent && integrity.valid) {
        stats.recentOutcomes = Array.isArray(stats.recentOutcomes)
          ? stats.recentOutcomes
              .filter(isCurrentMeasurementOutcome)
              .slice(-50)
          : [];


        stats.currentMeasurementAggregateIntegrityValid = true;
        stats.currentMeasurementAggregateIntegrityCheckedAt =
          stats.currentMeasurementAggregateIntegrityCheckedAt || now();
        stats.currentMeasurementAggregateCompleted = integrity.completed;
        stats.currentMeasurementAcceptedOutcomeCount =
          integrity.acceptedOutcomeCount;
        stats.currentMeasurementNonCurrentRecentOutcomeCount = 0;


        return applyOutcomeMeasurementPolicyFlags(stats);
    }


    const migrationAt = now();
    const hadLegacyOutcomeData = hasStoredOutcomeMeasurementData(stats);


    const legacyCompleted = integrity.completed;
const legacyAcceptedOutcomeCount = integrity.acceptedOutcomeCount;
const legacyTotalR = safeNumber(stats.totalR, 0);
const legacyTotalCostR = safeNumber(stats.totalCostR, 0);
const legacyAvgR = legacyCompleted > 0
    ? legacyTotalR / legacyCompleted
    : 0;


const legacyRecentOutcomeCount = Array.isArray(stats.recentOutcomes)
    ? stats.recentOutcomes.length
    : 0;


for (const field of outcomeResetNumericFields()) {
    stats[field] = 0;
}


resetTemporalOutcomeMetrics(stats);


stats.measurementVersionAcceptedOutcomeCount = 0;
stats.lastAcceptedOutcomeMeasurementVersion = null;
stats.lastAcceptedOutcomeMeasurementAt = null;


stats.recentOutcomes = [];
stats.costStatsInferredFromRecent = false;
stats.directSLStatsInferredFromRecent = false;


stats.learningStatus = 'OBSERVING';
stats.status = 'OBSERVING';
stats.awaitingOutcomes = safeNumber(stats.seen, 0) > 0;
stats.tooEarly = true;


stats.previousMeasurementFixVersion = alreadyCurrent
    ? 'CURRENT_VERSION_WITH_UNVERIFIED_AGGREGATES'
    : storedVersion || 'UNVERSIONED';


stats.outcomeMeasurementMigrationApplied = true;
stats.outcomeMeasurementMigrationAt =
    stats.outcomeMeasurementMigrationAt ||
    migrationAt;


stats.outcomeMeasurementMigrationReason = alreadyCurrent
    ? 'CURRENT_VERSION_AGGREGATE_INTEGRITY_MISMATCH_LEGACY_DATA_EXCLUDED'
    : 'LEGACY_TRIGGER_OVERSHOOT_OUTCOMES_EXCLUDED_FROM_CLEAN_DATASET';


stats.currentMeasurementAggregateIntegrityValid = true;
stats.currentMeasurementAggregateIntegrityMismatchDetected = alreadyCurrent;
stats.currentMeasurementAggregateIntegrityCheckedAt = migrationAt;
stats.currentMeasurementAggregateCompleted = 0;
    stats.currentMeasurementAcceptedOutcomeCount = 0;
    stats.currentMeasurementNonCurrentRecentOutcomeCount = 0;


    stats.legacyOutcomeDataWasPresent = hadLegacyOutcomeData;
    stats.legacyExcludedCompleted = round4(legacyCompleted);
    stats.legacyExcludedTotalR = round4(legacyTotalR);
    stats.legacyExcludedAvgR = round4(legacyAvgR);
    stats.legacyExcludedTotalCostR = round4(legacyTotalCostR);
    stats.legacyExcludedRecentOutcomeCount = legacyRecentOutcomeCount;
    stats.legacyExcludedAcceptedOutcomeCount = round4(
         legacyAcceptedOutcomeCount
    );
    stats.legacyExcludedNonCurrentRecentOutcomeCount =
         integrity.nonCurrentRecentOutcomeCount;


    stats.lastOutcomeMeasurementResetAt = migrationAt;
    stats.updatedAt = migrationAt;


    return applyOutcomeMeasurementPolicyFlags(stats);
}


function normalizeCurrentFitLabel(value = '') {
    const raw = upper(value);


    if (
         raw === 'MATCH' ||
         raw === 'FIT'
    ) {
         return 'FIT';
    }


    if (
         raw === 'WEAK_MATCH' ||
         raw === 'WEAKMATCH' ||
         raw === 'OK'
    ) {
         return 'OK';
    }


    if (raw === 'NEUTRAL') return 'NEUTRAL';
    if (raw === 'MISFIT') return 'MISFIT';


    return 'UNKNOWN';
}


function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(
         object || {},
         key
    );
}


function hasUsableCurrentFitSnapshot(value = {}) {
    const label = normalizeCurrentFitLabel(
         value.currentFit ||
           value.currentFitLabel ||
           value.entryCurrentFit ||
           value.lastKnownCurrentFit
    );


    return (
         label !== 'UNKNOWN' ||
         value.currentMarketWeatherAvailable === true ||
         value.currentFitScoreBuilt === true
    );
}


function applyCurrentFitSnapshot(stats = {}, row = {}) {
    const hasExplicitLabel =
         hasOwn(row, 'currentFit') ||
         hasOwn(row, 'currentFitLabel') ||
         hasOwn(row, 'entryCurrentFit');


    const hasExplicitScore =
         hasOwn(row, 'currentFitScore') ||
         hasOwn(row, 'fitScore');


    const hasExplicitConfidence =
         hasOwn(row, 'currentFitConfidence') ||
         hasOwn(row, 'entryCurrentFitConfidence') ||
         hasOwn(row, 'currentMarketFitConfidence');


    const hasWeatherContext = Boolean(
         row.currentMarketWeather ||
         row.entryMarketWeather ||
         row.currentMarketWeatherAvailable === true ||
         row.currentRegime ||
         row.currentMarketRegime ||
         row.currentTrendSide ||
         row.currentMarketTrendSide
    );


    if (
         !hasExplicitLabel &&
     !hasExplicitScore &&
     !hasExplicitConfidence &&
     !hasWeatherContext
) {
     return stats;
}


const label = normalizeCurrentFitLabel(
     row.currentFit ||
       row.currentFitLabel ||
       row.entryCurrentFit
);


const score = finiteOrNull(
     row.currentFitScore ??
       row.fitScore
);


const confidence = finiteOrNull(
     row.currentFitConfidence ??
       row.entryCurrentFitConfidence ??
       row.currentMarketFitConfidence
);


const reasons = Array.isArray(row.currentFitReasons)
     ? row.currentFitReasons
         .map((value) => String(value || '').trim())
         .filter(Boolean)
         .slice(0, 20)
     : [];


const updatedAt = safeNumber(
     row.currentFitUpdatedAt ??
       row.liveDataTs ??
       row.updatedAt ??
       row.createdAt ??
       row.ts,
     now()
);


if (hasExplicitLabel) {
     stats.currentFit = label;
     stats.currentFitLabel = label;
} else {
     stats.currentFit ||= 'UNKNOWN';
     stats.currentFitLabel ||= stats.currentFit;
}
if (score !== null) {
    stats.currentFitScore = score;
    stats.fitScore = score;
}


if (confidence !== null) {
    stats.currentFitConfidence = confidence;
}


stats.currentFitReason =
    row.currentFitReason ||
    stats.currentFitReason ||
    null;


if (reasons.length > 0) {
    stats.currentFitReasons = reasons;
} else if (!Array.isArray(stats.currentFitReasons)) {
    stats.currentFitReasons = [];
}


stats.currentRegime =
    row.currentRegime ||
    row.currentMarketRegime ||
    stats.currentRegime ||
    'UNKNOWN';


stats.currentMarketRegime =
    row.currentMarketRegime ||
    row.currentRegime ||
    stats.currentMarketRegime ||
    'UNKNOWN';


stats.currentTrendSide =
    row.currentTrendSide ||
    row.currentMarketTrendSide ||
    stats.currentTrendSide ||
    'UNKNOWN';


stats.currentMarketTrendSide =
    row.currentMarketTrendSide ||
    row.currentTrendSide ||
    stats.currentMarketTrendSide ||
    'UNKNOWN';


stats.currentBearishPct = finiteOrNull(
    row.currentBearishPct ??
         row.bearishPct
  ) ?? stats.currentBearishPct ?? null;


  stats.currentBullishPct = finiteOrNull(
       row.currentBullishPct ??
         row.bullishPct
  ) ?? stats.currentBullishPct ?? null;


  stats.currentSqueezePct = finiteOrNull(
       row.currentSqueezePct ??
         row.squeezePct
  ) ?? stats.currentSqueezePct ?? null;


  stats.currentMarketWeatherAgeSec = finiteOrNull(
       row.currentMarketWeatherAgeSec
  ) ?? stats.currentMarketWeatherAgeSec ?? null;


  stats.currentMarketWeatherStale = Boolean(
       row.currentMarketWeatherStale
  );


  stats.currentMarketWeatherAvailable = Boolean(
       row.currentMarketWeatherAvailable === true ||
       row.currentMarketWeather ||
       row.entryMarketWeather
  );


  stats.currentFitVersion =
       row.currentFitVersion ||
       stats.currentFitVersion ||
       CURRENT_FIT_VERSION;


  stats.currentFitUpdatedAt = updatedAt;
  stats.currentFitScoreBuilt =
       label !== 'UNKNOWN' &&
       score !== null;


  if (label !== 'UNKNOWN') {
       stats.lastKnownCurrentFit = label;
       stats.lastKnownCurrentFitScore = score ?? safeNumber(stats.currentFitScore,
0);
       stats.lastKnownCurrentFitConfidence = confidence ??
safeNumber(stats.currentFitConfidence, 0);
       stats.lastKnownCurrentFitAt = updatedAt;
  }


  return stats;
}


function inc(obj, key, amount = 1) {
    const k = String(key || 'UNKNOWN').toUpperCase();


    obj[k] = safeNumber(obj[k], 0) + amount;
}


function makeCounters() {
    return {
         rsiZone: {},
         flow: {},
         obRelation: {},
         btcState: {},
         regime: {},
         scannerReason: {}
    };
}


function isExecutionFingerprintId(id = '') {
    const value = upper(id);


    return (
         value.includes('_XR_') ||
         value.includes('__XR__') ||
         value.includes('|XR|') ||
         value.includes('EXECUTION_FINGERPRINT') ||
         value.includes('EXECUTION_MICRO') ||
         value.includes('EXECUTIONMICRO') ||
         value.includes('REFINED_EXECUTION')
    );
}


function isScannerFamilyId(id = '') {
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


function validLearningId(id = '') {
    const value = String(id || '').trim();


    if (!value) return false;
    if (isScannerFamilyId(value)) return false;
    if (isExecutionFingerprintId(value)) return false;


    return true;
}


function parseLongTaxonomyMicroId(id = '') {
    const rawId = String(id || '').trim();
    const value = upper(rawId);


    if (!value.startsWith('MICRO_LONG_')) {
         return {
              valid: false,
              selectable: false,
              isParent: false,
              isChild: false,
              rawId
         };
    }


    if (isScannerFamilyId(value) || isExecutionFingerprintId(value)) {
         return {
              valid: false,
              selectable: false,
              isParent: false,
              isChild: false,
              rawId
         };
    }


    if (
         value.includes('_MF_V1_') ||
         value.includes('_MF_V2_') ||
         value.includes('_MF_V3_')
    ) {
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


for (const candidateRegime of LONG_FIXED_REGIME_ORDER) {
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
         rawId,
         id: validChild ? childId : validParent ? parentId : value,
         setup,
         regime,
         setupType: setup,
         regimeBucket: regime,
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


function isSelectableLongChildTrueMicroId(id = '') {
    return parseLongTaxonomyMicroId(id).isChild === true;
}


function isParentLongTrueMicroId(id = '') {
    return parseLongTaxonomyMicroId(id).isParent === true;
}


function cleanSideText(value = '') {
    return String(value || '')
         .trim()
         .toUpperCase()
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


function normalizeTradeSide(value) {
    const raw = cleanSideText(value);


    if (!raw) return 'UNKNOWN';


    const direct = sideToTradeSide(raw);


    if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
    if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;


    if (['LONG', 'BULL', 'BULLISH', 'BUY', 'BID', 'UP', 'UPSIDE',
'GREEN'].includes(raw)) {
         return TARGET_TRADE_SIDE;
    }


    if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'ASK', 'DOWN', 'DOWNSIDE',
'RED'].includes(raw)) {
         return OPPOSITE_TRADE_SIDE;
    }


    const longHit = hasLongSignal(raw);
    const shortHit = hasShortSignal(raw);


    if (longHit && !shortHit) return TARGET_TRADE_SIDE;
    if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;


    if (longHit && shortHit) {
         if (raw.includes('TRADE_SIDE=LONG') || raw.includes('TRADESIDE=LONG')) return
TARGET_TRADE_SIDE;
         if (raw.includes('TRADE_SIDE=SHORT') || raw.includes('TRADESIDE=SHORT'))
return OPPOSITE_TRADE_SIDE;
         if (raw.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
         if (raw.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
    }


    return 'UNKNOWN';
}


function directSide(row = {}) {
    const values = [
         row.tradeSide,
         row.positionSide,
         row.direction,
         row.signalSide,
         row.intentSide,
         row.entrySide,
         row.scannerSide,
         row.actualScannerSide,
         row.analysisSide,
         row.side
    ];


    for (const value of values) {
         const side = normalizeTradeSide(value);


         if (side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE) {
             return side;
         }
    }


    return 'UNKNOWN';
}


function definitionValues(row = {}) {
    return [
         row.familyId,
         row.family,
         row.baseFamilyId,


         row.microFamilyId,
         row.trueMicroFamilyId,
         row.childTrueMicroFamilyId,
         row.analyzeMicroFamilyId,
         row.learningMicroFamilyId,
         row.coarseMicroFamilyId,
         row.parentTrueMicroFamilyId,
         row.baseMicroFamilyId,
         row.legacyMicroFamilyId,
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
    ];
}


function definitionText(row = {}) {
    return definitionValues(row)
         .map((value) => cleanSideText(value))
        .filter(Boolean)
        .join('|');
}


function definitionSide(row = {}) {
    const values = definitionValues(row);


    let longHit = false;
    let shortHit = false;


    for (const value of values) {
        const side = normalizeTradeSide(value);


        if (side === TARGET_TRADE_SIDE) longHit = true;
        if (side === OPPOSITE_TRADE_SIDE) shortHit = true;
    }


    if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;
    if (longHit && !shortHit) return TARGET_TRADE_SIDE;


    if (longHit && shortHit) {
        const text = values
          .map((value) => cleanSideText(value))
          .filter(Boolean)
          .join('|');


        if (text.includes('TRADE_SIDE=LONG') || text.includes('TRADESIDE=LONG'))
return TARGET_TRADE_SIDE;
        if (text.includes('TRADE_SIDE=SHORT') || text.includes('TRADESIDE=SHORT'))
return OPPOSITE_TRADE_SIDE;
        if (text.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
        if (text.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
    }


    return 'UNKNOWN';
}


function inferTradeSide(row = {}) {
    if (typeof row === 'string') return normalizeTradeSide(row);


    if (!row || typeof row !== 'object') return 'UNKNOWN';


    const direct = directSide(row);


    if (direct === TARGET_TRADE_SIDE || direct === OPPOSITE_TRADE_SIDE) {
        return direct;
    }
    const fromDefinition = definitionSide(row);


    if (fromDefinition === TARGET_TRADE_SIDE || fromDefinition ===
OPPOSITE_TRADE_SIDE) {
        return fromDefinition;
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
    return inferTradeSide(row) === TARGET_TRADE_SIDE;
}


function rowSchema(row = {}) {
    return String(
        row.trueMicroFamilySchema ||
          row.childTrueMicroFamilySchema ||
          row.exactTrueMicroFamilySchema ||
          row.broadTrueMicroFamilySchema ||
          row.microFamilySchema ||
          row.schema ||
          row.versionSchema ||
          ''
    ).toUpperCase();
}


function rowMicroId(row = {}) {
    const value = String(
        row.trueMicroFamilyId ||
          row.childTrueMicroFamilyId ||
          row.microFamilyId ||
          row.analyzeMicroFamilyId ||
          row.learningMicroFamilyId ||
          row.id ||
          row.key ||
          ''
    ).trim();
    return validLearningId(value) ? value.toUpperCase() : '';
}


function rowParentTrueMicroId(row = {}) {
    const direct = String(
        row.parentTrueMicroFamilyId ||
             row.coarseMicroFamilyId ||
             row.baseMicroFamilyId ||
             row.legacyMicroFamilyId ||
             row.parentMacroFamilyId ||
             row.parentMicroFamilyId ||
             row.macroFamilyId ||
             ''
    ).trim();


    const parsedDirect = parseLongTaxonomyMicroId(direct);


    if (parsedDirect.valid) {
        return parsedDirect.parentTrueMicroFamilyId;
    }


    const parsedMicro = parseLongTaxonomyMicroId(rowMicroId(row));


    if (parsedMicro.valid) {
        return parsedMicro.parentTrueMicroFamilyId;
    }


    return '';
}


function idHasSchema(id, schema) {
    const value = upper(id);
    const target = upper(schema);


    if (!value || !target) return false;


    if (target === TRUE_MICRO_SCHEMA) {
        return (
             isSelectableLongChildTrueMicroId(value) ||
             value.includes(`_${TRUE_MICRO_SCHEMA}_`) ||
             value.endsWith(`_${TRUE_MICRO_SCHEMA}`) ||
             value.includes(`|SCHEMA=${TRUE_MICRO_SCHEMA}`) ||
             value.includes(`SCHEMA=${TRUE_MICRO_SCHEMA}`)
        );
    }
    if (target === PARENT_TRUE_MICRO_SCHEMA) {
         return (
              isParentLongTrueMicroId(value) ||
              value.includes(`_${PARENT_TRUE_MICRO_SCHEMA}_`) ||
              value.endsWith(`_${PARENT_TRUE_MICRO_SCHEMA}`) ||
              value.includes(`|SCHEMA=${PARENT_TRUE_MICRO_SCHEMA}`) ||
              value.includes(`SCHEMA=${PARENT_TRUE_MICRO_SCHEMA}`)
         );
    }


    return (
         value.includes(`_${target}_`) ||
         value.endsWith(`_${target}`) ||
         value.includes(`|SCHEMA=${target}`) ||
         value.includes(`SCHEMA=${target}`)
    );
}


function definitionHasSchema(row = {}, schema) {
    const target = upper(schema);


    if (!target) return false;


    const parts = [
         ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
         ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
         ...(Array.isArray(row.broadTrueDefinitionParts) ? row.broadTrueDefinitionParts
: []),
         ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts :
[]),
         ...(Array.isArray(row.executionFingerprintParts) ?
row.executionFingerprintParts : [])
    ];


    const upperParts = parts.map((part) => String(part || '').toUpperCase());


    if (target === TRUE_MICRO_SCHEMA) {
         return (
              upperParts.some((part) => (
                part === `SCHEMA=${TRUE_MICRO_SCHEMA}` ||
                part === `TRUEMICROFAMILYSCHEMA=${TRUE_MICRO_SCHEMA}` ||
                part === `CHILDTRUEMICROFAMILYSCHEMA=${TRUE_MICRO_SCHEMA}` ||
                part === `BROADTRUEMICROFAMILYSCHEMA=${TRUE_MICRO_SCHEMA}` ||
                part.includes(`SCHEMA=${TRUE_MICRO_SCHEMA}`) ||
                part.includes('FIXED_TAXONOMY_75') ||
                part.includes('LEARNINGIDENTITY=ANALYZE_TRUE_MICRO_FAMILY_FIXED_TAXONOMY')
              )) ||
              definitionText(row).includes('FIXED_TAXONOMY_75')
         );
    }


    if (target === PARENT_TRUE_MICRO_SCHEMA) {
         return (
              upperParts.some((part) => (
                part === `SCHEMA=${PARENT_TRUE_MICRO_SCHEMA}` ||
                part === `PARENTTRUEMICROFAMILYSCHEMA=${PARENT_TRUE_MICRO_SCHEMA}` ||
                part.includes(`SCHEMA=${PARENT_TRUE_MICRO_SCHEMA}`) ||
                part.includes('FIXED_TAXONOMY_15')
              )) ||
              definitionText(row).includes('FIXED_TAXONOMY_15')
         );
    }


    if (upperParts.some((part) => part === `SCHEMA=${target}`)) {
         return true;
    }


    return definitionText(row).includes(`SCHEMA=${target}`);
}


function idLooksLikeSimpleMacroFamily(id = '') {
    const value = String(id || '').trim();


    return (
         /^LONG(?:_F)?_?\d+$/iu.test(value) ||
         /^LONG_F\d+$/iu.test(value)
    );
}


function idLooksLikeLongMicroFamily(id = '') {
    const value = upper(id);


    if (!value) return false;
    if (!validLearningId(value)) return false;


    return value.startsWith('MICRO_LONG_');
}


function isTrueAnalyzeMicroRow(row = {}) {
    const { macroSchema, legacyMicroSchema } = schemaConfig();


    const id = rowMicroId(row);
    const schema = rowSchema(row);
    const version = upper(row.version);
    if (!row || !id) return false;
    if (!validLearningId(id)) return false;
    if (!isLongRow(row) && !idLooksLikeLongMicroFamily(id)) return false;


    if (row.isLegacyMacro === true) return false;
    if (row.isParentTrueMicro === true) return false;
    if (isParentLongTrueMicroId(id)) return false;
    if (idLooksLikeSimpleMacroFamily(id)) return false;
    if (version.includes('MACRO') || version.includes('PARENT')) return false;


    if (schema === macroSchema) return false;
    if (schema === PARENT_TRUE_MICRO_SCHEMA) return false;
    if (idHasSchema(id, macroSchema)) return false;
    if (idHasSchema(id, PARENT_TRUE_MICRO_SCHEMA)) return false;
    if (definitionHasSchema(row, macroSchema)) return false;


    if (isSelectableLongChildTrueMicroId(id)) return true;


    if (
        row.fixedTaxonomyLearningId === true &&
        row.exactTrueMicroFamilyRequired === true &&
        idLooksLikeLongMicroFamily(id) &&
        !idHasSchema(id, legacyMicroSchema) &&
        !idHasSchema(id, macroSchema)
    ) {
        return isSelectableLongChildTrueMicroId(id);
    }


    return false;
}


function isRealAnalyzeMicroRow(row = {}) {
    return isTrueAnalyzeMicroRow(row);
}


function dashboardSideFromTradeSide(side, fallback = 'unknown') {
    const tradeSide = normalizeTradeSide(side);


    if (tradeSide === TARGET_TRADE_SIDE) return TARGET_DASHBOARD_SIDE;


    return String(fallback || 'unknown').toLowerCase();
}


function normalizeSource(source = SOURCE_VIRTUAL) {
    const src = String(source || SOURCE_VIRTUAL).trim().toUpperCase();
    if (src === SOURCE_REAL) return SOURCE_REAL;
    if (src === SOURCE_SHADOW) return SOURCE_SHADOW;
    if (src === SOURCE_VIRTUAL) return SOURCE_VIRTUAL;


    return SOURCE_VIRTUAL;
}


function sourceWeight(source) {
    return normalizeSource(source) === SOURCE_SHADOW
         ? shadowWeight()
         : 1;
}


function fixedTaxonomyMeta(row = {}) {
    const id = rowMicroId(row);
    const parsed = parseLongTaxonomyMicroId(id);


    if (!parsed.valid) {
         return {
              setupType: row.setupType || null,
              regimeBucket: row.regimeBucket || null,
              confirmationProfile: row.confirmationProfile || null,
              parentTrueMicroFamilyId: rowParentTrueMicroId(row) || null,
              childTrueMicroFamilyId: null,
              fixedTaxonomyLearningId: false,
              selectableChild: false
         };
    }


    return {
         setupType: parsed.setup,
         regimeBucket: parsed.regime,
         confirmationProfile: parsed.confirmationProfile || row.confirmationProfile ||
null,
         parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
         childTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
         fixedTaxonomyLearningId: parsed.isChild,
         fixedTaxonomyBaseId: parsed.parentTrueMicroFamilyId,
         selectableChild: parsed.isChild,
         isParentTrueMicro: parsed.isParent
    };
}


function longRiskGeometry(row = {}) {
    const entry = safeNumber(row.entry ?? row.entryPrice, 0);
    const initialSl = safeNumber(row.initialSl ?? row.sl ?? row.stopLoss, 0);
    const tp = safeNumber(row.tp ?? row.takeProfit, 0);
  const exitPrice = safeNumber(row.exitPrice ?? row.exit ?? row.closePrice, 0);
  const currentPrice = safeNumber(row.currentPrice ?? row.markPrice ?? row.price,
0);


  const riskDistance =
      entry > 0 &&
      initialSl > 0 &&
      initialSl < entry
         ? entry - initialSl
         : 0;


  const validLongRiskShape =
      entry > 0 &&
      initialSl > 0 &&
      tp > 0 &&
      initialSl < entry &&
      entry < tp;


  const longGrossR =
      validLongRiskShape &&
      riskDistance > 0 &&
      exitPrice > 0
         ? (exitPrice - entry) / riskDistance
         : null;


  const longCurrentR =
      validLongRiskShape &&
      riskDistance > 0 &&
      currentPrice > 0
         ? (currentPrice - entry) / riskDistance
         : null;


  return {
      entry,
      initialSl,
      sl: initialSl,
      tp,
      exitPrice,
      currentPrice,
      riskDistance,
      validLongRiskShape,
      validLongGeometry: validLongRiskShape,
      longTpHit: validLongRiskShape && currentPrice > 0 ? currentPrice >= tp :
false,
      longSlHit: validLongRiskShape && currentPrice > 0 ? currentPrice <= initialSl
: false,
      longGrossR,
         longCurrentR
    };
}


function outcomeExitR(row = {}) {
    const explicitLong = finiteOrNull(
         row.longNetR ??
           row.netLongR ??
           row.longExitR ??
           row.realizedLongR
    );


    if (explicitLong !== null) return explicitLong;


    const explicitGeneric = finiteOrNull(
         row.netR ??
           row.exitR ??
           row.realizedNetR ??
           row.realizedR ??
           row.r
    );


    if (explicitGeneric !== null) return explicitGeneric;


    const geometry = longRiskGeometry(row);


    if (geometry.longGrossR !== null) return geometry.longGrossR;


    const explicitLongGross = finiteOrNull(row.longGrossR ?? row.grossLongR);


    if (explicitLongGross !== null) return explicitLongGross;


    const explicitGross = finiteOrNull(
         row.grossR ??
           row.rawR ??
           row.realizedGrossR
    );


    if (explicitGross !== null) return explicitGross;


    return 0;
}


function applyLearningIdentityFlags(stats = {}, row = {}) {
    const id = rowMicroId({
         ...stats,
         ...row
  });


  const taxonomy = fixedTaxonomyMeta({
    ...stats,
    ...row
  });


  stats.redisNamespace = LONG_NAMESPACE;
  stats.redisKeyPrefix = LONG_KEY_PREFIX;
  stats.persistentLearningKey = PERSISTENT_LEARNING_KEY;
  stats.redisKeysSeparatedFromShortRoot = true;
  stats.shortRootTouched = false;


  stats.trueMicroOnly = true;
  stats.exactTrueMicroOnly = true;
  stats.exactTrueMicroFamilyRequired = true;
  stats.trueMicroFamilySchema = TRUE_MICRO_SCHEMA;
  stats.childTrueMicroFamilySchema = CHILD_TRUE_MICRO_SCHEMA;
  stats.exactTrueMicroFamilySchema = TRUE_MICRO_SCHEMA;
  stats.parentTrueMicroFamilySchema = PARENT_TRUE_MICRO_SCHEMA;
  stats.broadTrueMicroFamilySchema = TRUE_MICRO_SCHEMA;
  stats.microFamilySchema = TRUE_MICRO_SCHEMA;
  stats.schema = TRUE_MICRO_SCHEMA;
  stats.learningGranularity = LEARNING_GRANULARITY;
  stats.parentLearningGranularity = PARENT_LEARNING_GRANULARITY;
  stats.fixedTaxonomyPreferred = true;
  stats.fixedTaxonomyLearningId = taxonomy.fixedTaxonomyLearningId;
  stats.selectableChild = taxonomy.selectableChild;
  stats.fixedTaxonomyBaseId = taxonomy.fixedTaxonomyBaseId ||
stats.fixedTaxonomyBaseId || null;


  stats.setupType = taxonomy.setupType || stats.setupType || null;
  stats.regimeBucket = taxonomy.regimeBucket || stats.regimeBucket || null;
  stats.confirmationProfile = taxonomy.confirmationProfile ||
stats.confirmationProfile || null;


  if (id) {
    stats.microFamilyId = id;
    stats.trueMicroFamilyId = id;
    stats.childTrueMicroFamilyId = taxonomy.childTrueMicroFamilyId || id;
    stats.analyzeMicroFamilyId = id;
    stats.learningMicroFamilyId = id;


    stats.parentTrueMicroFamilyId =
        taxonomy.parentTrueMicroFamilyId ||
        rowParentTrueMicroId(stats) ||
        rowParentTrueMicroId(row) ||
        null;


      stats.coarseMicroFamilyId = stats.parentTrueMicroFamilyId;
      stats.baseMicroFamilyId = stats.parentTrueMicroFamilyId;
      stats.legacyMicroFamilyId = stats.parentTrueMicroFamilyId;


      stats.macroFamilyId = stats.parentTrueMicroFamilyId;
      stats.parentMacroFamilyId = stats.parentTrueMicroFamilyId;
      stats.parentMicroFamilyId = stats.parentTrueMicroFamilyId;
  }


  stats.parentSelectionAllowed = false;
  stats.selectionGranularity = 'EXACT_75_CHILD';
  stats.fallbackRankingGranularity = 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED';


  stats.scannerFingerprintRole = 'METADATA_ONLY';
  stats.scannerFingerprintsMetadataOnly = true;
  stats.scannerFingerprintsUsedAsLearningFamily = false;
  stats.scannerBucketsMetadataOnly = true;
  stats.legacy25BucketsMetadataOnly = true;


  stats.executionFingerprintRole = stats.executionFingerprintRole ||
'METADATA_ONLY';
  stats.executionFingerprintsMetadataOnly = true;
  stats.executionFingerprintsUsedAsLearningFamily = false;


  stats.analyzeMicroFamiliesOnly = true;
  stats.learningIdentitySource = 'ANALYZE_TRUE_MICRO_FAMILY';
  stats.symbolExcludedFromFamilyId = true;
  stats.coinNameExcludedFromFamilyId = true;
  stats.hashesExcludedFromFamilyId = true;


  stats.completedDefinition = 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES';
  stats.completedOnlyClosedVirtualOrShadow = true;
  stats.completedMeasurementFilter = MEASUREMENT_FIX_VERSION;
  stats.completedCurrentMeasurementOnly = true;
  stats.scoringRSource = 'netR';
  stats.winsLossesFlatsSource = 'netR';
  stats.winrateDefinition = 'netR > 0';
  stats.avgRSource = 'netR';
  stats.totalRSource = 'netR';
  stats.avgCostRShown = true;
  stats.avgCostRSource = 'costR';


  applyOutcomeMeasurementPolicyFlags(stats);
  stats.seenDefinition = 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY';
  stats.observationDedupeRequired = true;
    stats.observationAlwaysCounted = false;


    stats.defaultRanking =
'dashboardBalancedScore|balancedScore|fairWinrate|totalR|avgR|avgCostR';
    stats.bareWinrateRankingDisabled = true;
    stats.rawWinrateRankingDisabled = true;
    stats.rankingUsesBalancedScore = true;
    stats.rankingUsesFairWinrate = true;
    stats.rankingUsesTotalR = true;
    stats.rankingUsesAvgR = true;
    stats.rankingUsesAvgCostR = true;


    stats.currentFitSoftOnly = true;
    stats.currentFitBlocksLearning = false;
    stats.currentFitPolarity = 'BULLISH_POSITIVE_BEARISH_NEGATIVE';
    stats.currentFitDefinition = 'LONG_MIRRORED_CURRENT_FIT';
    stats.learningRemainsBroad = true;
    stats.selectionWillBeAdaptive = true;
    stats.discordWillBeStrict = true;


    stats.adaptiveLayerBuilt = false;
    stats.adaptiveScoreBuilt = false;
    stats.recentMomentumScoreBuilt = false;
    stats.currentFitScoreBuilt = hasUsableCurrentFitSnapshot(stats);
    stats.parentDiversificationBuilt = false;


    stats.validLongRiskShape = 'entry > 0 && sl > 0 && sl < entry && tp > entry';
    stats.longRiskShape = 'sl < entry < tp';
    stats.riskTradeSide = TARGET_TRADE_SIDE;
    stats.riskGeometryRule = 'LONG: sl < entry < tp';
    stats.tpHitRule = 'LONG: price >= tp';
    stats.slHitRule = 'LONG: price <= sl';
    stats.grossRFormula = '(exitPrice - entry) / (entry - initialSl)';
    stats.currentRFormula = '(currentPrice - entry) / (entry - initialSl)';
    stats.longGrossRFormula = '(exitPrice - entry) / (entry - initialSl)';
    stats.longCurrentRFormula = '(currentPrice - entry) / (entry - initialSl)';


    stats.realOrdersDisabled = true;
    stats.exchangeOrdersDisabled = true;
    stats.bitgetOrdersDisabled = true;
    stats.exchangeCallsDisabled = true;
    stats.noRealOrders = true;
    stats.noExchangeOrders = true;


    return stats;
}
function applySideIdentity(stats = {}, row = {}) {
    const tradeSide = inferTradeSide({
         ...stats,
         ...row
    });


    stats.longOnly = true;
    stats.shortDisabled = true;
    stats.shortOnly = false;
    stats.longDisabled = false;


    applyLearningIdentityFlags(stats, row);


    if (tradeSide !== TARGET_TRADE_SIDE) {
         stats.tradeSide = null;
         stats.side = 'unknown';
         return stats;
    }


    stats.tradeSide = TARGET_TRADE_SIDE;
    stats.side = TARGET_DASHBOARD_SIDE;
    stats.positionSide = TARGET_TRADE_SIDE;
    stats.direction = TARGET_TRADE_SIDE;
    stats.targetTradeSide = TARGET_TRADE_SIDE;
    stats.targetScannerSide = TARGET_SCANNER_SIDE;
    stats.dashboardSide = TARGET_DASHBOARD_SIDE;


    return stats;
}


function hasSourceBuckets(stats = {}) {
    return (
         safeNumber(stats.virtualCompleted, 0) > 0 ||
         safeNumber(stats.shadowCompleted, 0) > 0 ||
         safeNumber(stats.virtualWins, 0) > 0 ||
         safeNumber(stats.virtualLosses, 0) > 0 ||
         safeNumber(stats.virtualFlats, 0) > 0 ||
         safeNumber(stats.shadowWins, 0) > 0 ||
         safeNumber(stats.shadowLosses, 0) > 0 ||
         safeNumber(stats.shadowFlats, 0) > 0 ||
         safeNumber(stats.virtualTotalR, 0) !== 0 ||
         safeNumber(stats.shadowTotalR, 0) !== 0 ||
         safeNumber(stats.virtualTotalCostR, 0) !== 0 ||
         safeNumber(stats.shadowTotalCostR, 0) !== 0
    );
}
function closedCompletedCount(stats = {}) {
    return (
         safeNumber(stats.virtualCompleted, 0) +
         safeNumber(stats.shadowCompleted, 0)
    );
}


function actualOutcomeCounts(stats = {}) {
    if (hasSourceBuckets(stats)) {
         const virtualCompleted = safeNumber(stats.virtualCompleted, 0);
         const shadowCompleted = safeNumber(stats.shadowCompleted, 0);


         const virtualWins = safeNumber(stats.virtualWins, 0);
         const virtualLosses = safeNumber(stats.virtualLosses, 0);
         const virtualFlats = safeNumber(stats.virtualFlats, 0);


         const shadowWins = safeNumber(stats.shadowWins, 0);
         const shadowLosses = safeNumber(stats.shadowLosses, 0);
         const shadowFlats = safeNumber(stats.shadowFlats, 0);


         const completed = virtualCompleted + shadowCompleted;
         const bucketCompleted =
              virtualWins +
              virtualLosses +
              virtualFlats +
              shadowWins +
              shadowLosses +
              shadowFlats;


         const inferredFlats = Math.max(0, completed - bucketCompleted);


         return {
              wins: virtualWins + shadowWins,
              losses: virtualLosses + shadowLosses,
              flats: virtualFlats + shadowFlats + inferredFlats,
              completed: Math.max(completed, bucketCompleted)
         };
    }


    return {
         wins: safeNumber(stats.wins, 0),
         losses: safeNumber(stats.losses, 0),
         flats: safeNumber(stats.flats, 0),
         completed: safeNumber(stats.completed, 0)
    };
}
function weightedCompletedCount(stats = {}) {
    const virtualCompleted = safeNumber(stats.virtualCompleted, 0);
    const shadowCompleted = safeNumber(stats.shadowCompleted, 0);


    return virtualCompleted + shadowCompleted * shadowWeight();
}


function weightedSourceCounts(stats = {}) {
    const w = shadowWeight();


    return {
         wins:
           safeNumber(stats.virtualWins, 0) +
           safeNumber(stats.shadowWins, 0) * w,


         losses:
           safeNumber(stats.virtualLosses, 0) +
           safeNumber(stats.shadowLosses, 0) * w,


         flats:
           safeNumber(stats.virtualFlats, 0) +
           safeNumber(stats.shadowFlats, 0) * w,


         completed:
           safeNumber(stats.virtualCompleted, 0) +
           safeNumber(stats.shadowCompleted, 0) * w
    };
}


function weightedSourceTotals(stats = {}) {
    const w = shadowWeight();


    return {
         totalR:
           safeNumber(stats.virtualTotalR, 0) +
           safeNumber(stats.shadowTotalR, 0) * w,


         totalPnlPct:
           safeNumber(stats.virtualTotalPnlPct, 0) +
           safeNumber(stats.shadowTotalPnlPct, 0) * w,


         totalCostR:
           safeNumber(stats.virtualTotalCostR, 0) +
           safeNumber(stats.shadowTotalCostR, 0) * w,


         grossWinR:
           safeNumber(stats.virtualGrossWinR, 0) +
           safeNumber(stats.shadowGrossWinR, 0) * w,


         grossLossR:
           safeNumber(stats.virtualGrossLossR, 0) +
           safeNumber(stats.shadowGrossLossR, 0) * w
    };
}


function isSlExitReason(value = '') {
    const reason = upper(value);


    return [
         'SL',
         'HIT_SL',
         'STOP',
         'STOP_LOSS',
         'STOPLOSS',
         'STOPPED',
         'HIT_STOP',
         'HARD_SL',
         'DIRECT_SL'
    ].includes(reason) ||
         reason.includes('STOP_LOSS') ||
         reason.includes('STOPLOSS') ||
         reason.includes('HIT_SL') ||
         reason.includes('DIRECT_SL');
}


function isDirectSL(row = {}) {
    if (
         row.directToSL === true ||
         row.directSL === true ||
         row.directStopLoss === true ||
         row.isDirectSL === true
    ) {
         return true;
    }


    if (!isSlExitReason(row.exitReason || row.reason)) {
         return false;
    }


    if (
         row.nearTpSeen === true ||
         row.reachedHalfR === true ||
         row.reachedOneR === true
    ) {
         return false;
    }


    const mfeR = safeNumber(row.mfeR, 0);
    const maeR = safeNumber(row.maeR, 0);


    return mfeR < 0.25 || maeR <= -0.8;
}


function inferCostR(row = {}, exitR = 0) {
    const explicit = finiteOrNull(
         row.costR ??
           row.avgCostR ??
           row.estimatedCostR ??
           row.netCostR
    );


    if (explicit !== null && explicit >= 0) {
         return explicit;
    }


    const geometry = longRiskGeometry(row);
    const longGrossR = finiteOrNull(
         row.longGrossR ??
           row.grossLongR ??
           geometry.longGrossR
    );


    if (longGrossR !== null) {
         return Math.max(0, longGrossR - safeNumber(exitR, 0));
    }


    const grossR = finiteOrNull(
         row.grossR ??
           row.rawR ??
           row.realizedGrossR
    );


    if (grossR !== null) {
         return Math.max(0, grossR - safeNumber(exitR, 0));
    }


    const costPct = finiteOrNull(row.costPct);
    const riskPct = finiteOrNull(row.riskPct);


    if (costPct !== null && riskPct !== null && riskPct > 0) {
         return Math.max(0, costPct / riskPct);
    }


    return 0;
}


function normalizeDedupeKey(value = '') {
    return String(value || '')
         .trim()
         .toUpperCase()
         .slice(0, 240);
}


function observationDedupeKey(row = {}) {
    const direct = normalizeDedupeKey(
         row.observationDedupeKey ||
           row.observationKey ||
           row.obsKey ||
           row.dedupeKey ||
           ''
    );


    if (direct) return direct;


    const microId = rowMicroId(row);
    const snapshotId = normalizeDedupeKey(row.snapshotId || row.scanId ||
row.batchId || '');
    const symbol = normalizeDedupeKey(row.symbol || row.baseSymbol ||
row.contractSymbol || '');
    const entry = safeNumber(row.entry || row.entryPrice, 0);


    if (!microId || !symbol) return '';


    if (snapshotId) {
         return normalizeDedupeKey(`${snapshotId}|${symbol}|${microId}|${entry ||
'NO_ENTRY'}`);
    }


    return normalizeDedupeKey(`NO_SNAPSHOT|${symbol}|${microId}|${entry ||
'NO_ENTRY'}`);
}


function observationAlreadySeen(stats = {}, key = '') {
    const normalized = normalizeDedupeKey(key);


    if (!normalized) return false;


    const keys = Array.isArray(stats.observationDedupeKeys)
        ? stats.observationDedupeKeys
        : [];


    return keys.includes(normalized);
}


function rememberObservationKey(stats = {}, key = '') {
    const normalized = normalizeDedupeKey(key);


    if (!normalized) return stats;


    const keys = Array.isArray(stats.observationDedupeKeys)
        ? stats.observationDedupeKeys
        : [];


    keys.push(normalized);


    stats.observationDedupeKeys = [...new Set(keys)].slice(-
observationDedupeCacheLimit());
    stats.lastObservationDedupeKey = normalized;


    return stats;
}


function observationIsDuplicate(stats = {}, row = {}) {
    if (
        row.observationDuplicate === true ||
        row.observationAlreadyCounted === true ||
        row.observationCounted === false ||
        row.countObservation === false ||
        row.skipObservationCount === true ||
        row.observationSkipped === true
    ) {
        return true;
    }


    const key = observationDedupeKey(row);


    return Boolean(key && observationAlreadySeen(stats, key));
}


function outcomeIsDuplicate(row = {}) {
    return (
        row.outcomeDuplicate === true ||
        row.outcomeAlreadyRecorded === true ||
        row.outcomeCounted === false ||
        row.countOutcome === false ||
         row.skipOutcomeCount === true ||
         row.outcomeSkipped === true
    );
}


function aggregateRecentOutcomes(stats = {}) {
    const statsId = rowMicroId(stats);


    const outcomes = Array.isArray(stats.recentOutcomes)
         ? stats.recentOutcomes
               .filter(isLongRow)
               .filter(isCurrentMeasurementOutcome)
         : [];


    return outcomes.reduce(
         (acc, row) => {
           const src = normalizeSource(row.source);


           if (src !== SOURCE_VIRTUAL && src !== SOURCE_SHADOW) {
               return acc;
           }


           const rowId = rowMicroId(row);


           if (statsId && rowId && rowId !== statsId) {
               return acc;
           }


           const weight = sourceWeight(src);


           const exitR = outcomeExitR(row);
           const pnlPct = safeNumber(row.netPnlPct ?? row.pnlPct, 0);
           const costR = inferCostR(row, exitR);


           const win = exitR > 0;
           const loss = exitR < 0;
           const flat = !win && !loss;


           acc.completed += weight;
           acc.actualCompleted += 1;


           if (win) {
               acc.wins += weight;
               acc.actualWins += 1;
               acc.grossWinR += exitR * weight;
           }
     if (loss) {
         acc.losses += weight;
         acc.actualLosses += 1;
         acc.grossLossR += Math.abs(exitR) * weight;
     }


     if (flat) {
         acc.flats += weight;
         acc.actualFlats += 1;
     }


     acc.totalR += exitR * weight;
     acc.totalPnlPct += pnlPct * weight;
     acc.totalCostR += costR * weight;


     if (isDirectSL(row)) acc.directSLCount += weight;
     if (row.nearTpSeen) acc.nearTpCount += weight;
     if (row.reachedHalfR) acc.reachedHalfRCount += weight;
     if (row.reachedOneR) acc.reachedOneRCount += weight;


     if (row.beWouldExit) acc.beWouldExitCount += weight;
     if (row.gaveBackAfterHalfR) acc.gaveBackAfterHalfRCount += weight;
     if (row.gaveBackAfterOneR) acc.gaveBackAfterOneRCount += weight;
     if (row.nearTpThenLoss) acc.nearTpThenLossCount += weight;


     return acc;
},
{
     completed: 0,
     wins: 0,
     losses: 0,
     flats: 0,


     actualCompleted: 0,
     actualWins: 0,
     actualLosses: 0,
     actualFlats: 0,


     totalR: 0,
     totalPnlPct: 0,
     totalCostR: 0,
     grossWinR: 0,
     grossLossR: 0,


     directSLCount: 0,
     nearTpCount: 0,
     reachedHalfRCount: 0,
             reachedOneRCount: 0,


             beWouldExitCount: 0,
             gaveBackAfterHalfRCount: 0,
             gaveBackAfterOneRCount: 0,
             nearTpThenLossCount: 0
         }
    );
}


function maxPositive(...values) {
    return Math.max(0, ...values.map((value) => positive(value)));
}


function chooseTotal({
    sourceValue,
    storedValue,
    recentValue,
    sourceCompleted,
    storedCompleted,
    recentCompleted,
    allowRecentFallback = true
}) {
    if (sourceCompleted > 0) return safeNumber(sourceValue, 0);
    if (storedCompleted > 0) return safeNumber(storedValue, 0);
    if (allowRecentFallback && recentCompleted > 0) return safeNumber(recentValue,
0);


    return safeNumber(storedValue ?? sourceValue ?? recentValue, 0);
}


function sampleReliability(completed) {
    const n = safeNumber(completed, 0);


    if (n <= 0) return 0;


    return clamp(Math.sqrt(Math.min(n, sampleCap()) / sampleCap()), 0, 1);
}


function sampleAdjustedAvgR(avgR, reliability) {
    const cappedAvgR = clamp(
         safeNumber(avgR, 0),
         -avgRCap(),
         avgRCap()
    );


    const samplePenalty = Math.pow(
         clamp(reliability, 0, 1),
         avgRSampleExponent()
    );


    return cappedAvgR * samplePenalty;
}


function learningStatus(stats = {}) {
    const completed = safeNumber(stats.completed, 0);


    if (completed <= 0) return 'OBSERVING';
    if (completed < MIN_COMPLETED_ACTIVE) return 'EARLY_OUTCOMES';


    return 'ACTIVE_LEARNING';
}


export function createMicroStats({
    microFamilyId,
    familyId,
    side = TARGET_DASHBOARD_SIDE,
    tradeSide = TARGET_TRADE_SIDE,
    definitionParts = []
} = {}) {
    const ts = now();


    const parsed = parseLongTaxonomyMicroId(microFamilyId);
    const resolvedMicroFamilyId = parsed.isChild
         ? parsed.childTrueMicroFamilyId
         : String(microFamilyId || '').trim().toUpperCase();


    const parentTrueMicroFamilyId = parsed.parentTrueMicroFamilyId || null;


    const inferredTradeSide = inferTradeSide({
         microFamilyId: resolvedMicroFamilyId,
         familyId,
         side,
         tradeSide,
         definitionParts
    });


    const cleanTradeSide = inferredTradeSide === TARGET_TRADE_SIDE
         ? TARGET_TRADE_SIDE
         : normalizeTradeSide(tradeSide || side);


    const isLong = cleanTradeSide === TARGET_TRADE_SIDE;
    const isChild = parsed.isChild === true;
return {
  microFamilyId: resolvedMicroFamilyId,
  trueMicroFamilyId: resolvedMicroFamilyId,
  childTrueMicroFamilyId: isChild ? resolvedMicroFamilyId : null,
  analyzeMicroFamilyId: resolvedMicroFamilyId,
  learningMicroFamilyId: resolvedMicroFamilyId,


  coarseMicroFamilyId: parentTrueMicroFamilyId,
  baseMicroFamilyId: parentTrueMicroFamilyId,
  legacyMicroFamilyId: parentTrueMicroFamilyId,


  parentTrueMicroFamilyId,
  parentMacroFamilyId: parentTrueMicroFamilyId,
  parentMicroFamilyId: parentTrueMicroFamilyId,
  macroFamilyId: parentTrueMicroFamilyId,


  familyId,


  side: isLong ? TARGET_DASHBOARD_SIDE : 'unknown',
  tradeSide: isLong ? TARGET_TRADE_SIDE : null,
  positionSide: isLong ? TARGET_TRADE_SIDE : null,
  direction: isLong ? TARGET_TRADE_SIDE : null,


  targetTradeSide: TARGET_TRADE_SIDE,
  targetScannerSide: TARGET_SCANNER_SIDE,
  dashboardSide: TARGET_DASHBOARD_SIDE,


  longOnly: true,
  shortDisabled: true,
  shortOnly: false,
  longDisabled: false,


  source: SOURCE_VIRTUAL,


  schema: TRUE_MICRO_SCHEMA,
  microFamilySchema: TRUE_MICRO_SCHEMA,
  trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
  childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
  exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
  parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
  broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
  learningGranularity: LEARNING_GRANULARITY,
  parentLearningGranularity: PARENT_LEARNING_GRANULARITY,


  setupType: parsed.setupType || null,
  regimeBucket: parsed.regimeBucket || null,
  confirmationProfile: parsed.confirmationProfile || null,
    fixedTaxonomyLearningId: isChild,
    fixedTaxonomyBaseId: parentTrueMicroFamilyId,
    selectableChild: isChild,


    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    exactTrueMicroFamilyRequired: true,
    selectionGranularity: 'EXACT_75_CHILD',
    parentSelectionAllowed: false,


    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisKeysSeparatedFromShortRoot: true,
    shortRootTouched: false,


    definitionParts,
    definition: definitionParts.join(' | '),


    seen: 0,
    observations: 0,
    observationDuplicateSkippedCount: 0,
    observationDedupeKeys: [],
    observationAlwaysCounted: false,
    ...createTemporalStatsShape(),
virtualCompleted: 0,
realCompleted: 0,
shadowCompleted: 0,
completed: 0,
winrateSample: 0,


wins: 0,
losses: 0,
flats: 0,


virtualWins: 0,
virtualLosses: 0,
virtualFlats: 0,


realWins: 0,
realLosses: 0,
realFlats: 0,


shadowWins: 0,
shadowLosses: 0,
shadowFlats: 0,


totalR: 0,
virtualTotalR: 0,
realTotalR: 0,
shadowTotalR: 0,


totalPnlPct: 0,
virtualTotalPnlPct: 0,
realTotalPnlPct: 0,
shadowTotalPnlPct: 0,


totalCostR: 0,
virtualTotalCostR: 0,
realTotalCostR: 0,
shadowTotalCostR: 0,


grossWinR: 0,
grossLossR: 0,


virtualGrossWinR: 0,
virtualGrossLossR: 0,
realGrossWinR: 0,
realGrossLossR: 0,
shadowGrossWinR: 0,
shadowGrossLossR: 0,
avgR: 0,
avgWinR: 0,
avgLossR: 0,
sampleAdjustedAvgR: 0,
avgRScore: 0,


avgPnlPct: 0,


directSLCount: 0,
nearTpCount: 0,
reachedHalfRCount: 0,
reachedOneRCount: 0,


beWouldExitCount: 0,
gaveBackAfterHalfRCount: 0,
gaveBackAfterOneRCount: 0,
nearTpThenLossCount: 0,


avgCostR: 0,


winrate: 0,
bayesianWinrate: 0,
wilsonLowerBound: 0,
fairWinrate: 0,
sampleAdjustedWinrate: 0,


sampleRawWinrate: 0,
sampleBayesianWinrate: 0,
sampleWilsonLowerBound: 0,
sampleReliabilityOld: 0,


profitFactor: 0,
sampleReliability: 0,
balancedScore: 0,
dashboardBalancedScore: 0,


directSLPct: 0,
nearTpPct: 0,
reachedHalfRPct: 0,
reachedOneRPct: 0,


beWouldExitPct: 0,
gaveBackAfterHalfRPct: 0,
gaveBackAfterOneRPct: 0,
nearTpThenLossPct: 0,
costStatsInferredFromRecent: false,
directSLStatsInferredFromRecent: false,


validLongRiskShape: 'entry > 0 && sl > 0 && sl < entry && tp > entry',
longRiskShape: 'sl < entry < tp',
riskTradeSide: TARGET_TRADE_SIDE,
riskGeometryRule: 'LONG: sl < entry < tp',
tpHitRule: 'LONG: price >= tp',
slHitRule: 'LONG: price <= sl',
grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
currentRFormula: '(currentPrice - entry) / (entry - initialSl)',
longGrossRFormula: '(exitPrice - entry) / (entry - initialSl)',
longCurrentRFormula: '(currentPrice - entry) / (entry - initialSl)',


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


completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
completedOnlyClosedVirtualOrShadow: true,
completedMeasurementFilter: MEASUREMENT_FIX_VERSION,
completedCurrentMeasurementOnly: true,
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
    exitFillAssumption: 'TRIGGER_BOUNDARY_PLUS_COST_MODEL',
    measurementVersionAcceptedOutcomeCount: 0,
    measurementVersionRejectedOutcomeCount: 0,
    seenDefinition: 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY',
    observationDedupeRequired: true,


    defaultRanking:
'dashboardBalancedScore|balancedScore|fairWinrate|totalR|avgR|avgCostR',
    bareWinrateRankingDisabled: true,
    rawWinrateRankingDisabled: true,
    rankingUsesBalancedScore: true,
    rankingUsesFairWinrate: true,
    rankingUsesTotalR: true,
    rankingUsesAvgR: true,
    rankingUsesAvgCostR: true,


    currentFit: 'UNKNOWN',
    currentFitLabel: 'UNKNOWN',
    currentFitScore: 0,
    fitScore: 0,
    currentFitConfidence: 0,
    currentFitReason: null,
    currentFitReasons: [],
    currentFitVersion: CURRENT_FIT_VERSION,
    currentFitUpdatedAt: null,
    lastKnownCurrentFit: 'UNKNOWN',
    lastKnownCurrentFitScore: 0,
    lastKnownCurrentFitConfidence: 0,
    lastKnownCurrentFitAt: null,
    currentRegime: 'UNKNOWN',
    currentMarketRegime: 'UNKNOWN',
    currentTrendSide: 'UNKNOWN',
    currentMarketTrendSide: 'UNKNOWN',
    currentBearishPct: null,
    currentBullishPct: null,
    currentSqueezePct: null,
    currentMarketWeatherAgeSec: null,
    currentMarketWeatherStale: false,
    currentMarketWeatherAvailable: false,


    currentFitSoftOnly: true,
         currentFitBlocksLearning: false,
         currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
         currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
         learningRemainsBroad: true,
         selectionWillBeAdaptive: true,
         discordWillBeStrict: true,


         adaptiveLayerBuilt: false,
         adaptiveScoreBuilt: false,
         recentMomentumScoreBuilt: false,
         currentFitScoreBuilt: false,
         parentDiversificationBuilt: false,


         learningStatus: 'OBSERVING',
         status: 'OBSERVING',
         awaitingOutcomes: true,
         tooEarly: true,
         minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE,


         counters: makeCounters(),


         examples: [],
         recentOutcomes: [],


         createdAt: ts,
         updatedAt: ts
    };
}


function ensureStatsShape(stats = {}) {
    migrateOutcomeMeasurementVersion(stats);
    ensureTemporalStats(stats);


    stats.counters ||= makeCounters();
    stats.counters.rsiZone ||= {};
    stats.counters.flow ||= {};
    stats.counters.obRelation ||= {};
    stats.counters.btcState ||= {};
    stats.counters.regime ||= {};
    stats.counters.scannerReason ||= {};


    stats.examples = Array.isArray(stats.examples) ?
stats.examples.filter(isLongRow) : [];
    stats.recentOutcomes = Array.isArray(stats.recentOutcomes)
         ? stats.recentOutcomes
             .filter(isLongRow)
             .filter(isCurrentMeasurementOutcome)
           .slice(-50)
       : [];


  stats.definitionParts = Array.isArray(stats.definitionParts)
       ? stats.definitionParts
       : [];


  stats.observationDedupeKeys = Array.isArray(stats.observationDedupeKeys)
       ? stats.observationDedupeKeys.map(normalizeDedupeKey).filter(Boolean).slice(-
observationDedupeCacheLimit())
       : [];


  stats.definition ||= stats.definitionParts.join(' | ');


  stats.longOnly = true;
  stats.shortDisabled = true;
  stats.shortOnly = false;
  stats.longDisabled = false;
  stats.source ||= SOURCE_VIRTUAL;


  stats.minCompletedForActiveLearning = MIN_COMPLETED_ACTIVE;


  stats.currentFit = normalizeCurrentFitLabel(
       stats.currentFit ||
         stats.currentFitLabel ||
         stats.entryCurrentFit
  );
  stats.currentFitLabel = stats.currentFit;
  stats.currentFitReasons = Array.isArray(stats.currentFitReasons)
       ? stats.currentFitReasons
       : [];
  stats.currentFitVersion ||= CURRENT_FIT_VERSION;
  stats.currentMarketRegime ||= stats.currentRegime || 'UNKNOWN';
  stats.currentRegime ||= stats.currentMarketRegime || 'UNKNOWN';
  stats.currentMarketTrendSide ||= stats.currentTrendSide || 'UNKNOWN';
  stats.currentTrendSide ||= stats.currentMarketTrendSide || 'UNKNOWN';
  stats.currentMarketWeatherAvailable =
Boolean(stats.currentMarketWeatherAvailable);
  stats.currentMarketWeatherStale = Boolean(stats.currentMarketWeatherStale);


  applySideIdentity(stats);


  const numericFields = [
       'seen',
       'observations',
       'observationDuplicateSkippedCount',
       'outcomeDuplicateSkippedCount',
'measurementVersionAcceptedOutcomeCount',
'measurementVersionRejectedOutcomeCount',


'virtualCompleted',
'realCompleted',
'shadowCompleted',
'completed',
'winrateSample',


'wins',
'losses',
'flats',


'virtualWins',
'virtualLosses',
'virtualFlats',


'realWins',
'realLosses',
'realFlats',


'shadowWins',
'shadowLosses',
'shadowFlats',


'totalR',
'virtualTotalR',
'realTotalR',
'shadowTotalR',


'totalPnlPct',
'virtualTotalPnlPct',
'realTotalPnlPct',
'shadowTotalPnlPct',


'totalCostR',
'virtualTotalCostR',
'realTotalCostR',
'shadowTotalCostR',


'grossWinR',
'grossLossR',


'virtualGrossWinR',
'virtualGrossLossR',
'realGrossWinR',
'realGrossLossR',
'shadowGrossWinR',
'shadowGrossLossR',


'avgR',
'avgWinR',
'avgLossR',
'sampleAdjustedAvgR',
'avgRScore',


'avgPnlPct',
'avgCostR',


'directSLCount',
'nearTpCount',
'reachedHalfRCount',
'reachedOneRCount',


'beWouldExitCount',
'gaveBackAfterHalfRCount',
'gaveBackAfterOneRCount',
'nearTpThenLossCount',


'winrate',
'bayesianWinrate',
'wilsonLowerBound',
'fairWinrate',
'sampleAdjustedWinrate',


'sampleRawWinrate',
'sampleBayesianWinrate',
'sampleWilsonLowerBound',
'sampleReliabilityOld',


'profitFactor',
'sampleReliability',
'balancedScore',
'dashboardBalancedScore',


'currentFitScore',
'fitScore',
'currentFitConfidence',
'lastKnownCurrentFitScore',
'lastKnownCurrentFitConfidence',


'directSLPct',
'nearTpPct',
'reachedHalfRPct',
         'reachedOneRPct',


         'beWouldExitPct',
         'gaveBackAfterHalfRPct',
         'gaveBackAfterOneRPct',
         'nearTpThenLossPct'
    ];


    for (const field of numericFields) {
         stats[field] = safeNumber(stats[field], 0);
    }


    stats.realCompleted = 0;
    stats.realWins = 0;
    stats.realLosses = 0;
    stats.realFlats = 0;
    stats.realTotalR = 0;
    stats.realTotalPnlPct = 0;
    stats.realTotalCostR = 0;
    stats.realGrossWinR = 0;
    stats.realGrossLossR = 0;


    stats.currentFitSoftOnly = true;
    stats.currentFitBlocksLearning = false;
    stats.currentFitPolarity = 'BULLISH_POSITIVE_BEARISH_NEGATIVE';
    stats.currentFitDefinition = 'LONG_MIRRORED_CURRENT_FIT';
    stats.learningRemainsBroad = true;
    stats.selectionWillBeAdaptive = true;
    stats.discordWillBeStrict = true;


    stats.adaptiveLayerBuilt = false;
    stats.adaptiveScoreBuilt = false;
    stats.recentMomentumScoreBuilt = false;
    stats.currentFitScoreBuilt = hasUsableCurrentFitSnapshot(stats);
    stats.parentDiversificationBuilt = false;


    applyOutcomeMeasurementPolicyFlags(stats);


    stats.createdAt ||= now();
    stats.updatedAt ||= now();


    return stats;
}


export function updateObservation(stats, row = {}) {
    ensureStatsShape(stats);
  if (!isLongRow({ ...stats, ...row })) {
      return stats;
  }


  applySideIdentity(stats, row);
  applyCurrentFitSnapshot(stats, row);


  const dedupeKey = observationDedupeKey({
      ...stats,
      ...row
  });


  if (observationIsDuplicate(stats, row)) {
      stats.observationDuplicateSkippedCount =
safeNumber(stats.observationDuplicateSkippedCount, 0) + 1;
      stats.observationDuplicateLastSkippedAt = now();
      stats.lastObservationDedupeKey = dedupeKey || stats.lastObservationDedupeKey
|| null;
      stats.observationRecorded = false;
      stats.observationDuplicate = true;
      stats.observationAlwaysCounted = false;
      stats.updatedAt = now();


      stats.learningStatus = learningStatus(stats);
      stats.status = stats.learningStatus;
      stats.awaitingOutcomes = safeNumber(stats.completed, 0) <= 0 &&
safeNumber(stats.seen, 0) > 0;
      stats.tooEarly = safeNumber(stats.completed, 0) < MIN_COMPLETED_ACTIVE;


      return stats;
  }


  if (dedupeKey) {
      rememberObservationKey(stats, dedupeKey);
  }


  stats.seen = safeNumber(stats.seen, 0) + 1;
  stats.observations = safeNumber(stats.observations, 0) + 1;
  stats.observationRecorded = true;
  stats.observationDuplicate = false;
  stats.observationAlwaysCounted = false;


  const observationTemporalContext = recordTemporalObservation(stats, row);


  inc(stats.counters.rsiZone, row.rsiZone);
  inc(stats.counters.flow, row.flow);
  inc(stats.counters.obRelation, row.obRelation);
  inc(stats.counters.btcState, row.btcState ?? row.btcRelation);
  inc(stats.counters.regime, row.regime);
  inc(stats.counters.scannerReason, row.scannerReason);


  if (stats.examples.length < 20) {
    const microId = rowMicroId(row) || stats.microFamilyId || null;
    const parsed = parseLongTaxonomyMicroId(microId);
    const parentId = parsed.parentTrueMicroFamilyId || rowParentTrueMicroId(row)
|| stats.parentTrueMicroFamilyId || null;


    stats.examples.push({
      symbol: row.symbol || null,
      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      source: row.source || SOURCE_VIRTUAL,


      microFamilyId: microId,
      trueMicroFamilyId: microId,
      childTrueMicroFamilyId: parsed.childTrueMicroFamilyId || microId,
      parentTrueMicroFamilyId: parentId,
      coarseMicroFamilyId: parentId,


      setupType: row.setupType || stats.setupType || parsed.setupType || null,
      regimeBucket: row.regimeBucket || stats.regimeBucket || parsed.regimeBucket
|| null,
      confirmationProfile: row.confirmationProfile || stats.confirmationProfile ||
parsed.confirmationProfile || null,


      scannerMicroFamilyId: row.scannerMicroFamilyId || null,
      scannerFingerprintRole: row.scannerFingerprintRole || 'METADATA_ONLY',


      rsiZone: row.rsiZone || null,
      flow: row.flow || null,
      obRelation: row.obRelation || null,
      btcState: row.btcState || null,
      btcRelation: row.btcRelation || null,
      regime: row.regime || null,
      scannerReason: row.scannerReason || null,


      observationDedupeKey: dedupeKey || null,
      observationRecorded: true,
      observationDuplicate: false,
      observationAlwaysCounted: false,


      isMirrorMicroFamily: false,
      observationMirror: false,
      mirrorOfSide: null,
        trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
        childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
        parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
        learningGranularity: LEARNING_GRANULARITY,


        longOnly: true,
        shortDisabled: true,
        shortOnly: false,
        longDisabled: false,


        riskGeometryRule: 'LONG: sl < entry < tp',
        tpHitRule: 'LONG: price >= tp',
        slHitRule: 'LONG: price <= sl',
        grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
        currentRFormula: '(currentPrice - entry) / (entry - initialSl)',
        currentFit: normalizeCurrentFitLabel(
             row.currentFit ||
             row.currentFitLabel ||
             row.entryCurrentFit
        ),
        currentFitScore: safeNumber(row.currentFitScore ?? row.fitScore, 0),
        currentFitConfidence: safeNumber(
             row.currentFitConfidence ??
             row.entryCurrentFitConfidence,
             0
        ),
        currentFitReason: row.currentFitReason || null,
        currentRegime: row.currentRegime || row.currentMarketRegime || null,
        currentTrendSide: row.currentTrendSide || row.currentMarketTrendSide ||
null,
        currentMarketWeatherAvailable: Boolean(
             row.currentMarketWeatherAvailable === true ||
             row.currentMarketWeather ||
             row.entryMarketWeather
        ),
        currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
        currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',


        ...entryTemporalFields({
             ...row,
             entryTemporalContext: observationTemporalContext
        }),


        ts: row.createdAt || row.ts || now()
      });
  }
    stats.learningStatus = learningStatus(stats);
    stats.status = stats.learningStatus;
    stats.awaitingOutcomes = safeNumber(stats.completed, 0) <= 0 &&
safeNumber(stats.seen, 0) > 0;
    stats.tooEarly = safeNumber(stats.completed, 0) < MIN_COMPLETED_ACTIVE;


    stats.updatedAt = now();


    return stats;
}


export function updateOutcome(stats, row = {}, source = SOURCE_VIRTUAL) {
    ensureStatsShape(stats);


    if (!isLongRow({ ...stats, ...row })) {
        return refreshStats(stats);
    }


    applySideIdentity(stats, row);
    applyCurrentFitSnapshot(stats, row);


    const incomingMeasurementVersion = rowMeasurementFixVersion(row);


    if (!isCurrentMeasurementOutcome(row)) {
        stats.measurementVersionRejectedOutcomeCount =
          safeNumber(stats.measurementVersionRejectedOutcomeCount, 0) + 1;


        stats.lastRejectedOutcomeMeasurementVersion =
          incomingMeasurementVersion ||
          'UNVERSIONED';


        stats.lastRejectedOutcomeMeasurementAt = now();
        stats.lastRejectedOutcomeMeasurementReason =
          'OUTCOME_MEASUREMENT_VERSION_NOT_CURRENT';


        stats.outcomeRecorded = false;
        stats.outcomeMeasurementRejected = true;
        stats.updatedAt = now();


        return refreshStats(stats);
    }


    if (outcomeIsDuplicate(row)) {
        stats.outcomeDuplicateSkippedCount =
safeNumber(stats.outcomeDuplicateSkippedCount, 0) + 1;
        stats.outcomeDuplicateLastSkippedAt = now();
    stats.updatedAt = now();


    return refreshStats(stats);
}


const statsId = rowMicroId(stats);
const rowId = rowMicroId(row);


if (statsId && rowId && statsId !== rowId) {
    return refreshStats(stats);
}


const src = normalizeSource(source || row.source || SOURCE_VIRTUAL);


if (src !== SOURCE_VIRTUAL && src !== SOURCE_SHADOW) {
    return refreshStats(stats);
}


stats.measurementVersionAcceptedOutcomeCount =
    safeNumber(stats.measurementVersionAcceptedOutcomeCount, 0) + 1;


stats.lastAcceptedOutcomeMeasurementVersion =
    incomingMeasurementVersion;


stats.lastAcceptedOutcomeMeasurementAt = now();
stats.outcomeMeasurementRejected = false;


const weight = sourceWeight(src);
const geometry = longRiskGeometry(row);


const exitR = outcomeExitR(row);
const pnlPct = safeNumber(row.netPnlPct ?? row.pnlPct, 0);
const costR = inferCostR(row, exitR);


const win = exitR > 0;
const loss = exitR < 0;
const flat = !win && !loss;


if (src === SOURCE_SHADOW) {
    stats.shadowCompleted += 1;
    stats.shadowTotalR += exitR;
    stats.shadowTotalPnlPct += pnlPct;
    stats.shadowTotalCostR += costR;


    if (win) {
      stats.shadowWins += 1;
      stats.shadowGrossWinR += exitR;
    }


    if (loss) {
        stats.shadowLosses += 1;
        stats.shadowGrossLossR += Math.abs(exitR);
    }


    if (flat) stats.shadowFlats += 1;
} else {
    stats.virtualCompleted += 1;
    stats.virtualTotalR += exitR;
    stats.virtualTotalPnlPct += pnlPct;
    stats.virtualTotalCostR += costR;


    if (win) {
        stats.virtualWins += 1;
        stats.virtualGrossWinR += exitR;
    }


    if (loss) {
        stats.virtualLosses += 1;
        stats.virtualGrossLossR += Math.abs(exitR);
    }


    if (flat) stats.virtualFlats += 1;
}


stats.completed = closedCompletedCount(stats);


stats.wins += win ? weight : 0;
stats.losses += loss ? weight : 0;
stats.flats += flat ? weight : 0;


stats.totalR += exitR * weight;
stats.totalPnlPct += pnlPct * weight;
stats.totalCostR += costR * weight;


if (win) stats.grossWinR += exitR * weight;
if (loss) stats.grossLossR += Math.abs(exitR) * weight;


const directSL = isDirectSL(row);


recordTemporalOutcome(stats, row, {
    netR: exitR,
    grossR: safeNumber(
        row.grossR ?? row.rawR ?? row.realizedGrossR ?? geometry.longGrossR,
        exitR
    ),
    costR,
    directSL
  });


  if (directSL) stats.directSLCount += weight;
  if (row.nearTpSeen) stats.nearTpCount += weight;
  if (row.reachedHalfR) stats.reachedHalfRCount += weight;
  if (row.reachedOneR) stats.reachedOneRCount += weight;


  if (row.beWouldExit) stats.beWouldExitCount += weight;
  if (row.gaveBackAfterHalfR) stats.gaveBackAfterHalfRCount += weight;
  if (row.gaveBackAfterOneR) stats.gaveBackAfterOneRCount += weight;
  if (row.nearTpThenLoss) stats.nearTpThenLossCount += weight;


  const parsed = parseLongTaxonomyMicroId(rowId || statsId);
  const parentId = parsed.parentTrueMicroFamilyId || rowParentTrueMicroId(row) ||
stats.parentTrueMicroFamilyId || null;


  stats.recentOutcomes.push({
    source: src,
    sourceType: src,
    canonicalPositionId: row.canonicalPositionId || null,
    canonicalOutcomeId: row.canonicalOutcomeId || row.canonicalPositionId || row.outcomeId || null,
    acceptedTemporalOutcomeSeq: Math.max(0, Math.floor(safeNumber(row.acceptedTemporalOutcomeSeq, 0))),
    outcomeFinalizedTs: safeNumber(row.outcomeFinalizedTs ?? row.closedAt ?? row.completedAt, 0),
    outcomePersistedTs: safeNumber(row.outcomePersistedTs ?? row.updatedAt, 0),
    marketEventClusterId: row.marketEventClusterId || buildMarketEventClusterId(row),
    temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
    taxonomyVersion: TEMPORAL_TAXONOMY_VERSION,
    costModelVersion: TEMPORAL_COST_MODEL_VERSION,
    symbol: row.symbol || null,


    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,


    microFamilyId: rowId || stats.microFamilyId || null,
    trueMicroFamilyId: rowId || stats.trueMicroFamilyId || stats.microFamilyId ||
null,
    childTrueMicroFamilyId: parsed.childTrueMicroFamilyId || rowId ||
stats.childTrueMicroFamilyId || null,
    parentTrueMicroFamilyId: parentId,
    coarseMicroFamilyId: parentId,


    setupType: row.setupType || stats.setupType || parsed.setupType || null,
    regimeBucket: row.regimeBucket || stats.regimeBucket || parsed.regimeBucket ||
null,
    confirmationProfile: row.confirmationProfile || stats.confirmationProfile ||
parsed.confirmationProfile || null,


    exitReason: row.exitReason || row.reason || null,


    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    outcomeMeasurementVersion: MEASUREMENT_FIX_VERSION,
    exitFillModelVersion: row.exitFillModelVersion || EXIT_FILL_MODEL_VERSION,
    exitFillSource: row.exitFillSource || null,
    exitFillAssumption: row.exitFillAssumption || null,
      triggerBoundaryFillApplied: Boolean(row.triggerBoundaryFillApplied),
      exitObservedPrice: safeNumber(row.exitObservedPrice, null),
      exitFillPrice: safeNumber(row.exitFillPrice ?? row.exitPrice, null),
      exitTriggerPrice: safeNumber(row.exitTriggerPrice, null),
      observedVsFillPct: safeNumber(row.observedVsFillPct, 0),
      observedBeyondTriggerPct: safeNumber(row.observedBeyondTriggerPct, 0),


      entry: geometry.entry || row.entry || row.entryPrice || null,
      exit: geometry.exitPrice || row.exit || row.exitPrice || null,
      exitPrice: geometry.exitPrice || row.exitPrice || row.exit || null,
      initialSl: geometry.initialSl || row.initialSl || row.sl || null,
      sl: geometry.sl || row.sl || null,
      tp: geometry.tp || row.tp || null,
      currentPrice: geometry.currentPrice || row.currentPrice || null,


      validLongRiskShape: geometry.validLongRiskShape,
      validLongGeometry: geometry.validLongGeometry,
      riskTradeSide: TARGET_TRADE_SIDE,
      riskGeometryRule: 'LONG: sl < entry < tp',
      tpHitRule: 'LONG: price >= tp',
      slHitRule: 'LONG: price <= sl',
      longTpHit: geometry.longTpHit,
      longSlHit: geometry.longSlHit,


      exitR,
      netR: safeNumber(row.netR ?? row.longNetR ?? exitR, exitR),
      longNetR: safeNumber(row.longNetR ?? row.netR ?? exitR, exitR),
      grossR: safeNumber(row.grossR ?? row.rawR ?? row.realizedGrossR ??
geometry.longGrossR, 0),
      longGrossR: safeNumber(row.longGrossR ?? geometry.longGrossR ?? row.grossR,
0),
      longCurrentR: safeNumber(row.longCurrentR ?? geometry.longCurrentR, 0),


      grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
      currentRFormula: '(currentPrice - entry) / (entry - initialSl)',
      longGrossRFormula: '(exitPrice - entry) / (entry - initialSl)',
      longCurrentRFormula: '(currentPrice - entry) / (entry - initialSl)',


      pnlPct,
      netPnlPct: safeNumber(row.netPnlPct ?? pnlPct, pnlPct),
      grossPnlPct: safeNumber(row.grossPnlPct, 0),


      costR,
      avgCostR: costR,
      costPct: safeNumber(row.costPct, 0),
      feePct: safeNumber(row.feePct, 0),
      slippagePct: safeNumber(row.slippagePct, 0),
    mfeR: safeNumber(row.mfeR, 0),
    maeR: safeNumber(row.maeR, 0),


    directToSL: directSL,
    directSL,
    nearTpSeen: Boolean(row.nearTpSeen),
    reachedHalfR: Boolean(row.reachedHalfR),
    reachedOneR: Boolean(row.reachedOneR),


    beArmed: Boolean(row.beArmed),
    beWouldExit: Boolean(row.beWouldExit),
    beExitR: safeNumber(row.beExitR, 0),


    gaveBackAfterHalfR: Boolean(row.gaveBackAfterHalfR),
    gaveBackAfterOneR: Boolean(row.gaveBackAfterOneR),
    nearTpThenLoss: Boolean(row.nearTpThenLoss),


    entryMarketWeather: row.entryMarketWeather || null,
    entryCurrentRegime: row.entryCurrentRegime || row.currentRegime || null,
    entryCurrentTrendSide: row.entryCurrentTrendSide || row.currentTrendSide ||
null,
    entryCurrentFit: row.entryCurrentFit ?? row.currentFit ?? null,
    entryCurrentFitConfidence: safeNumber(row.entryCurrentFitConfidence ??
row.currentMarketFitConfidence, null),
    entryWeatherFitMatchedFamily: row.entryWeatherFitMatchedFamily ?? null,


    currentFit: normalizeCurrentFitLabel(
         row.currentFit ||
         row.currentFitLabel ||
         row.entryCurrentFit
    ),
    currentFitScore: safeNumber(row.currentFitScore ?? row.fitScore, 0),
    currentFitConfidence: safeNumber(
         row.currentFitConfidence ??
         row.entryCurrentFitConfidence,
         0
    ),
    currentFitReason: row.currentFitReason || null,
    currentRegime: row.currentRegime || row.currentMarketRegime || null,
    currentTrendSide: row.currentTrendSide || row.currentMarketTrendSide || null,
    currentMarketWeatherAvailable: Boolean(
         row.currentMarketWeatherAvailable === true ||
         row.currentMarketWeather ||
         row.entryMarketWeather
    ),
      currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
      currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',


      ...entryTemporalFields(row),
      ...exitTemporalFields(row),


      isMirrorMicroFamily: false,
      outcomeMirror: false,
      mirrorOfSide: null,


      trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
      childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
      parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
      learningGranularity: LEARNING_GRANULARITY,


      longOnly: true,
      shortDisabled: true,
      shortOnly: false,
      longDisabled: false,


      ts: row.closedAt || row.completedAt || now()
    });


    stats.recentOutcomes = stats.recentOutcomes.slice(-50);
    stats.updatedAt = now();


    return refreshStats(stats);
}


export function wilsonLowerBound(wins, completed, z = wilsonZ()) {
    const n = safeNumber(completed, 0);
    const w = clamp(safeNumber(wins, 0), 0, n);


    if (n <= 0) return 0;


    const p = w / n;
    const z2 = z * z;
    const denominator = 1 + z2 / n;
    const centre = p + z2 / (2 * n);
    const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);


    return clamp((centre - margin) / denominator, 0, 1);
}


export function bayesianWinrate(wins, completed) {
    const n = safeNumber(completed, 0);
    const w = safeNumber(wins, 0);
    const priorN = priorTrades();
    const priorW = priorN * priorWinrate();


    const denominator = n + priorN;


    return denominator > 0
         ? clamp((w + priorW) / denominator, 0, 1)
         : 0;
}


function buildBalancedScore({
    fair,
    avgR,
    totalR,
    sampleRel,
    profitFactor,
    nearTpPct,
    reachedOneRPct,
    directSLPct,
    nearTpThenLossPct,
    gaveBackAfterOneRPct,
    avgCostR
}) {
    const pfNorm = clamp(profitFactor, 0, 10) / 10;


    const totalRComponent = Math.log1p(positive(totalR)) * 12;
    const avgRComponent = Math.log1p(positive(avgR)) * 8;


    return (
         fair * 100 +
         sampleRel * 25 +
         totalRComponent +
         avgRComponent +
         pfNorm * 8 +
         nearTpPct * 4 +
         reachedOneRPct * 4 -
         directSLPct * 35 -
         nearTpThenLossPct * 15 -
         gaveBackAfterOneRPct * 10 -
         Math.max(0, avgCostR) * 8
    );
}


function buildAvgRScore({
    sampleAdjustedAvgRValue,
    fair,
    totalR,
    sampleRel,
    profitFactor,
    nearTpPct,
    reachedOneRPct,
    directSLPct,
    nearTpThenLossPct,
    gaveBackAfterOneRPct,
    avgCostR
}) {
    const pfNorm = clamp(profitFactor, 0, 10) / 10;
    const totalRComponent = Math.log1p(positive(totalR)) * 8;


    return (
         sampleAdjustedAvgRValue * 100 +
         fair * 35 +
         sampleRel * 25 +
         totalRComponent +
         pfNorm * 8 +
         nearTpPct * 3 +
         reachedOneRPct * 3 -
         directSLPct * 35 -
         nearTpThenLossPct * 15 -
         gaveBackAfterOneRPct * 10 -
         Math.max(0, avgCostR) * 8
    );
}


export function refreshStats(stats) {
    ensureStatsShape(stats);


    const hasBuckets = hasSourceBuckets(stats);
    const sourceCounts = weightedSourceCounts(stats);
    const sourceTotals = weightedSourceTotals(stats);
    const recent = aggregateRecentOutcomes(stats);


    const actualCounts = actualOutcomeCounts(stats);


    const closedCompleted = hasBuckets
         ? closedCompletedCount(stats)
         : Math.max(
              safeNumber(stats.completed, 0),
              actualCounts.completed,
              recent.actualCompleted
         );


    const weightedCompletedForR = hasBuckets
  ? weightedCompletedCount(stats)
  : Math.max(
       safeNumber(stats.completed, 0),
       sourceCounts.completed,
       recent.completed
  );


const weightedWins = hasBuckets
  ? sourceCounts.wins
  : Math.max(
       safeNumber(stats.wins, 0),
       recent.wins
  );


const weightedLosses = hasBuckets
  ? sourceCounts.losses
  : Math.max(
       safeNumber(stats.losses, 0),
       recent.losses
  );


const weightedFlats = hasBuckets
  ? sourceCounts.flats
  : Math.max(
       safeNumber(stats.flats, 0),
       recent.flats
  );


const totalR = chooseTotal({
  sourceValue: sourceTotals.totalR,
  storedValue: stats.totalR,
  recentValue: recent.totalR,
  sourceCompleted: sourceCounts.completed,
  storedCompleted: safeNumber(stats.completed, 0),
  recentCompleted: recent.completed
});


const totalPnlPct = chooseTotal({
  sourceValue: sourceTotals.totalPnlPct,
  storedValue: stats.totalPnlPct,
  recentValue: recent.totalPnlPct,
  sourceCompleted: sourceCounts.completed,
  storedCompleted: safeNumber(stats.completed, 0),
  recentCompleted: recent.completed
});


let totalCostR = chooseTotal({
    sourceValue: sourceTotals.totalCostR,
    storedValue: stats.totalCostR,
    recentValue: recent.totalCostR,
    sourceCompleted: sourceCounts.completed,
    storedCompleted: safeNumber(stats.completed, 0),
    recentCompleted: recent.completed
});


let costStatsInferredFromRecent = false;


if (
    weightedCompletedForR > 0 &&
    totalCostR <= 0 &&
    recent.completed > 0 &&
    recent.totalCostR > 0
) {
    const recentAvgCostR = recent.totalCostR / recent.completed;
    totalCostR = recentAvgCostR * weightedCompletedForR;
    costStatsInferredFromRecent = true;
}


const grossWinR = hasBuckets
    ? sourceTotals.grossWinR
    : maxPositive(
         stats.grossWinR,
         recent.grossWinR,
         totalR > 0 && weightedLosses <= 0 ? totalR : 0
    );


const grossLossR = hasBuckets
    ? sourceTotals.grossLossR
    : maxPositive(
         stats.grossLossR,
         recent.grossLossR,
         totalR < 0 && weightedWins <= 0 ? Math.abs(totalR) : 0
    );


const winrateSample = safeNumber(actualCounts.completed, 0);
const winrateWins = safeNumber(actualCounts.wins, 0);


const rawWinrate = winrateSample > 0
    ? winrateWins / winrateSample
    : 0;


const bayes = bayesianWinrate(winrateWins, winrateSample);
const wilson = wilsonLowerBound(winrateWins, winrateSample);
const fair = winrateSample > 0
  ? wilson * 0.8 + bayes * 0.15 + rawWinrate * 0.05
  : 0;


const reliability = sampleReliability(winrateSample);


const avgR = weightedCompletedForR > 0
  ? totalR / weightedCompletedForR
  : 0;


const avgPnlPct = weightedCompletedForR > 0
  ? totalPnlPct / weightedCompletedForR
  : 0;


const avgWinR = weightedWins > 0
  ? grossWinR / weightedWins
  : 0;


const avgLossR = weightedLosses > 0
  ? -grossLossR / weightedLosses
  : 0;


const profitFactor =
  grossLossR > 0 ? grossWinR / grossLossR :
    grossWinR > 0 ? 99 :
         0;


const directSLCount = safeNumber(stats.directSLCount, 0) > 0
  ? safeNumber(stats.directSLCount, 0)
  : recent.directSLCount;


const directSLStatsInferredFromRecent =
  safeNumber(stats.directSLCount, 0) <= 0 && recent.directSLCount > 0;


const nearTpCount = safeNumber(stats.nearTpCount, 0) > 0
  ? safeNumber(stats.nearTpCount, 0)
  : recent.nearTpCount;


const reachedHalfRCount = safeNumber(stats.reachedHalfRCount, 0) > 0
  ? safeNumber(stats.reachedHalfRCount, 0)
  : recent.reachedHalfRCount;


const reachedOneRCount = safeNumber(stats.reachedOneRCount, 0) > 0
  ? safeNumber(stats.reachedOneRCount, 0)
  : recent.reachedOneRCount;


const beWouldExitCount = safeNumber(stats.beWouldExitCount, 0) > 0
  ? safeNumber(stats.beWouldExitCount, 0)
  : recent.beWouldExitCount;


const gaveBackAfterHalfRCount = safeNumber(stats.gaveBackAfterHalfRCount, 0) > 0
  ? safeNumber(stats.gaveBackAfterHalfRCount, 0)
  : recent.gaveBackAfterHalfRCount;


const gaveBackAfterOneRCount = safeNumber(stats.gaveBackAfterOneRCount, 0) > 0
  ? safeNumber(stats.gaveBackAfterOneRCount, 0)
  : recent.gaveBackAfterOneRCount;


const nearTpThenLossCount = safeNumber(stats.nearTpThenLossCount, 0) > 0
  ? safeNumber(stats.nearTpThenLossCount, 0)
  : recent.nearTpThenLossCount;


const directSLPct = weightedCompletedForR > 0
  ? directSLCount / weightedCompletedForR
  : 0;


const nearTpPct = weightedCompletedForR > 0
  ? nearTpCount / weightedCompletedForR
  : 0;


const reachedHalfRPct = weightedCompletedForR > 0
  ? reachedHalfRCount / weightedCompletedForR
  : 0;


const reachedOneRPct = weightedCompletedForR > 0
  ? reachedOneRCount / weightedCompletedForR
  : 0;


const beWouldExitPct = weightedCompletedForR > 0
  ? beWouldExitCount / weightedCompletedForR
  : 0;


const gaveBackAfterHalfRPct = weightedCompletedForR > 0
  ? gaveBackAfterHalfRCount / weightedCompletedForR
  : 0;


const gaveBackAfterOneRPct = weightedCompletedForR > 0
  ? gaveBackAfterOneRCount / weightedCompletedForR
  : 0;


const nearTpThenLossPct = weightedCompletedForR > 0
  ? nearTpThenLossCount / weightedCompletedForR
  : 0;
const avgCostR = weightedCompletedForR > 0
  ? totalCostR / weightedCompletedForR
  : 0;


const sampleAdjustedAvgRValue = sampleAdjustedAvgR(avgR, reliability);


const balancedScore = buildBalancedScore({
  fair,
  avgR,
  totalR,
  sampleRel: reliability,
  profitFactor,
  nearTpPct,
  reachedOneRPct,
  directSLPct,
  nearTpThenLossPct,
  gaveBackAfterOneRPct,
  avgCostR
});


const avgRScore = buildAvgRScore({
  sampleAdjustedAvgRValue,
  fair,
  totalR,
  sampleRel: reliability,
  profitFactor,
  nearTpPct,
  reachedOneRPct,
  directSLPct,
  nearTpThenLossPct,
  gaveBackAfterOneRPct,
  avgCostR
});


Object.assign(stats, {
  longOnly: true,
  shortDisabled: true,
  shortOnly: false,
  longDisabled: false,


  source: stats.source || SOURCE_VIRTUAL,


  completed: round4(closedCompleted),
  winrateSample: round4(winrateSample),


  wins: round4(weightedWins),
  losses: round4(weightedLosses),
flats: round4(weightedFlats),


totalR: round4(totalR),
totalPnlPct: round4(totalPnlPct),
totalCostR: round4(totalCostR),


virtualTotalR: round4(stats.virtualTotalR),
realTotalR: 0,
shadowTotalR: round4(stats.shadowTotalR),


virtualTotalPnlPct: round4(stats.virtualTotalPnlPct),
realTotalPnlPct: 0,
shadowTotalPnlPct: round4(stats.shadowTotalPnlPct),


virtualTotalCostR: round4(stats.virtualTotalCostR),
realTotalCostR: 0,
shadowTotalCostR: round4(stats.shadowTotalCostR),


virtualGrossWinR: round4(stats.virtualGrossWinR),
virtualGrossLossR: round4(stats.virtualGrossLossR),
realGrossWinR: 0,
realGrossLossR: 0,
shadowGrossWinR: round4(stats.shadowGrossWinR),
shadowGrossLossR: round4(stats.shadowGrossLossR),


grossWinR: round4(grossWinR),
grossLossR: round4(grossLossR),


winrate: round4(rawWinrate),
bayesianWinrate: round4(bayes),
wilsonLowerBound: round4(wilson),
fairWinrate: round4(fair),


sampleRawWinrate: round4(rawWinrate),
sampleBayesianWinrate: round4(bayes),
sampleWilsonLowerBound: round4(wilson),
sampleAdjustedWinrate: round4(fair),
sampleReliabilityOld: round4(reliability),


sampleReliability: round4(reliability),


avgR: round4(avgR),
avgPnlPct: round4(avgPnlPct),
avgWinR: round4(avgWinR),
avgLossR: round4(avgLossR),
sampleAdjustedAvgR: round4(sampleAdjustedAvgRValue),
avgRScore: round4(avgRScore),
profitFactor: round4(profitFactor),


directSLCount: round4(directSLCount),
nearTpCount: round4(nearTpCount),
reachedHalfRCount: round4(reachedHalfRCount),
reachedOneRCount: round4(reachedOneRCount),


beWouldExitCount: round4(beWouldExitCount),
gaveBackAfterHalfRCount: round4(gaveBackAfterHalfRCount),
gaveBackAfterOneRCount: round4(gaveBackAfterOneRCount),
nearTpThenLossCount: round4(nearTpThenLossCount),


directSLPct: round4(directSLPct),
nearTpPct: round4(nearTpPct),
reachedHalfRPct: round4(reachedHalfRPct),
reachedOneRPct: round4(reachedOneRPct),


beWouldExitPct: round4(beWouldExitPct),
gaveBackAfterHalfRPct: round4(gaveBackAfterHalfRPct),
gaveBackAfterOneRPct: round4(gaveBackAfterOneRPct),
nearTpThenLossPct: round4(nearTpThenLossPct),


avgCostR: round4(avgCostR),
costStatsInferredFromRecent,
directSLStatsInferredFromRecent,


balancedScore: round4(balancedScore),
dashboardBalancedScore: round4(balancedScore),


realCompleted: 0,
realWins: 0,
realLosses: 0,
realFlats: 0,


scannerFingerprintRole: 'METADATA_ONLY',
scannerFingerprintsMetadataOnly: true,
scannerFingerprintsUsedAsLearningFamily: false,
scannerBucketsMetadataOnly: true,
legacy25BucketsMetadataOnly: true,


executionFingerprintRole: stats.executionFingerprintRole || 'METADATA_ONLY',
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
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    microFamilySchema: TRUE_MICRO_SCHEMA,
    schema: TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,


    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    completedOnlyClosedVirtualOrShadow: true,
    completedMeasurementFilter: MEASUREMENT_FIX_VERSION,
    completedCurrentMeasurementOnly: true,
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
    exitFillAssumption: 'TRIGGER_BOUNDARY_PLUS_COST_MODEL',
    measurementVersionAcceptedOutcomeCount:
round4(stats.measurementVersionAcceptedOutcomeCount),
    measurementVersionRejectedOutcomeCount:
round4(stats.measurementVersionRejectedOutcomeCount),
    seenDefinition: 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY',
    observationDedupeRequired: true,
    observationAlwaysCounted: false,


    defaultRanking:
'dashboardBalancedScore|balancedScore|fairWinrate|totalR|avgR|avgCostR',
    bareWinrateRankingDisabled: true,
    rawWinrateRankingDisabled: true,
    rankingUsesBalancedScore: true,
    rankingUsesFairWinrate: true,
    rankingUsesTotalR: true,
    rankingUsesAvgR: true,
    rankingUsesAvgCostR: true,


    currentFit: normalizeCurrentFitLabel(
         stats.currentFit ||
         stats.currentFitLabel ||
         stats.lastKnownCurrentFit
    ),
    currentFitLabel: normalizeCurrentFitLabel(
         stats.currentFit ||
         stats.currentFitLabel ||
         stats.lastKnownCurrentFit
    ),
    currentFitScore: round4(stats.currentFitScore),
    fitScore: round4(stats.fitScore ?? stats.currentFitScore),
    currentFitConfidence: round4(stats.currentFitConfidence),
    currentFitVersion: stats.currentFitVersion || CURRENT_FIT_VERSION,
    currentFitReasons: Array.isArray(stats.currentFitReasons)
         ? stats.currentFitReasons.slice(0, 20)
         : [],
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
    currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
    learningRemainsBroad: true,
    selectionWillBeAdaptive: true,
    discordWillBeStrict: true,


    adaptiveLayerBuilt: false,
    adaptiveScoreBuilt: false,
    recentMomentumScoreBuilt: false,
    currentFitScoreBuilt: hasUsableCurrentFitSnapshot(stats),
    parentDiversificationBuilt: false,


    validLongRiskShape: 'entry > 0 && sl > 0 && sl < entry && tp > entry',
    longRiskShape: 'sl < entry < tp',
    riskTradeSide: TARGET_TRADE_SIDE,
    riskGeometryRule: 'LONG: sl < entry < tp',
         tpHitRule: 'LONG: price >= tp',
         slHitRule: 'LONG: price <= sl',
         grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
         currentRFormula: '(currentPrice - entry) / (entry - initialSl)',
         longGrossRFormula: '(exitPrice - entry) / (entry - initialSl)',
         longCurrentRFormula: '(currentPrice - entry) / (entry - initialSl)',


         redisNamespace: LONG_NAMESPACE,
         redisKeyPrefix: LONG_KEY_PREFIX,
         persistentLearningKey: PERSISTENT_LEARNING_KEY,
         redisKeysSeparatedFromShortRoot: true,
         shortRootTouched: false,


         tooEarly: closedCompleted < MIN_COMPLETED_ACTIVE,
         minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE,


         updatedAt: now()
    });


    applySideIdentity(stats);


    stats.learningStatus = learningStatus(stats);
    stats.status = stats.learningStatus;
    stats.awaitingOutcomes = safeNumber(stats.completed, 0) <= 0 &&
safeNumber(stats.seen, 0) > 0;


    return stats;
}


export function normalizeDashboardMicro(row = {}, rank = null) {
    const stats = refreshStats(row);


    const normalized = {
         ...stats,


         sampleRawWinrate: stats.winrate,
         sampleBayesianWinrate: stats.bayesianWinrate,
         sampleWilsonLowerBound: stats.wilsonLowerBound,
         sampleAdjustedWinrate: stats.fairWinrate,
         sampleReliabilityOld: stats.sampleReliability,


         dashboardBalancedScore: stats.balancedScore,


         tooEarly: safeNumber(stats.completed, 0) < MIN_COMPLETED_ACTIVE,
         minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE
    };
    applySideIdentity(normalized);


    if (rank !== null && rank !== undefined) {
         normalized.rank = rank;
    }


    return normalized;
}


export function normalizeDashboardSummary(summary = {}) {
    const out = { ...summary };


    for (const key of ['bestBalanced', 'bestTotalR', 'bestWinrate',
'lowestDirectSL']) {
         if (out[key] && typeof out[key] === 'object' &&
isRealAnalyzeMicroRow(out[key])) {
             out[key] = normalizeDashboardMicro(out[key]);
         } else {
             out[key] = null;
         }
    }


    return out;
}


function sortById(a, b) {
    return String(a.microFamilyId || '').localeCompare(String(b.microFamilyId ||
''));
}


function compareWinrate(a, b) {
    return (
         safeNumber(b.fairWinrate, 0) - safeNumber(a.fairWinrate, 0) ||
         safeNumber(b.wilsonLowerBound, 0) - safeNumber(a.wilsonLowerBound, 0) ||
         safeNumber(b.bayesianWinrate, 0) - safeNumber(a.bayesianWinrate, 0) ||
         safeNumber(b.sampleReliability, 0) - safeNumber(a.sampleReliability, 0) ||
         safeNumber(b.winrateSample, 0) - safeNumber(a.winrateSample, 0) ||
         safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
         safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
         safeNumber(a.avgCostR, 0) - safeNumber(b.avgCostR, 0) ||
         sortById(a, b)
    );
}


function compareAvgR(a, b) {
    return (
         safeNumber(b.avgRScore, 0) - safeNumber(a.avgRScore, 0) ||
         safeNumber(b.sampleAdjustedAvgR, 0) - safeNumber(a.sampleAdjustedAvgR, 0) ||
         safeNumber(b.fairWinrate, 0) - safeNumber(a.fairWinrate, 0) ||
         safeNumber(b.sampleReliability, 0) - safeNumber(a.sampleReliability, 0) ||
         safeNumber(b.winrateSample, 0) - safeNumber(a.winrateSample, 0) ||
         safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
         safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
         safeNumber(a.avgCostR, 0) - safeNumber(b.avgCostR, 0) ||
         sortById(a, b)
    );
}


function compareTotalR(a, b) {
    return (
         safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
         safeNumber(b.dashboardBalancedScore ?? b.balancedScore, 0) -
           safeNumber(a.dashboardBalancedScore ?? a.balancedScore, 0) ||
         safeNumber(b.fairWinrate, 0) - safeNumber(a.fairWinrate, 0) ||
         safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
         safeNumber(a.avgCostR, 0) - safeNumber(b.avgCostR, 0) ||
         safeNumber(b.sampleReliability, 0) - safeNumber(a.sampleReliability, 0) ||
         sortById(a, b)
    );
}


function compareBalanced(a, b) {
    return (
         safeNumber(b.dashboardBalancedScore ?? b.balancedScore, 0) -
           safeNumber(a.dashboardBalancedScore ?? a.balancedScore, 0) ||
         safeNumber(b.balancedScore, 0) - safeNumber(a.balancedScore, 0) ||
         safeNumber(b.fairWinrate, 0) - safeNumber(a.fairWinrate, 0) ||
         safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
         safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
         safeNumber(a.avgCostR, 0) - safeNumber(b.avgCostR, 0) ||
         compareWinrate(a, b)
    );
}


export function rankMicros(micros = {}, mode = 'balanced') {
    const safeMode = mode === 'winrate'
         ? 'balanced'
         : String(mode || 'balanced');


    const rows = Object.values(micros || {})
         .filter(Boolean)
         .filter(isRealAnalyzeMicroRow)
         .map((row) => refreshStats(row))
         .filter((row) => row.tradeSide === TARGET_TRADE_SIDE)
      .filter((row) => validLearningId(row.microFamilyId))
      .filter((row) => validLearningId(row.trueMicroFamilyId))
      .filter((row) => isSelectableLongChildTrueMicroId(row.trueMicroFamilyId ||
row.microFamilyId));


    const sorted = [...rows].sort((a, b) => {
      if (safeMode === 'totalR') {
          return compareTotalR(a, b);
      }


      if (safeMode === 'avgR') {
          return compareAvgR(a, b);
      }


      if (safeMode === 'directSL') {
          return (
               safeNumber(a.directSLPct, 0) - safeNumber(b.directSLPct, 0) ||
               safeNumber(b.dashboardBalancedScore ?? b.balancedScore, 0) -
                 safeNumber(a.dashboardBalancedScore ?? a.balancedScore, 0) ||
               safeNumber(b.fairWinrate, 0) - safeNumber(a.fairWinrate, 0) ||
               safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
               safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
               safeNumber(a.avgCostR, 0) - safeNumber(b.avgCostR, 0) ||
               safeNumber(b.winrateSample, 0) - safeNumber(a.winrateSample, 0) ||
               sortById(a, b)
          );
      }


      if (safeMode === 'observed') {
          return (
               safeNumber(b.seen, 0) - safeNumber(a.seen, 0) ||
               safeNumber(b.observations, 0) - safeNumber(a.observations, 0) ||
               safeNumber(b.dashboardBalancedScore ?? b.balancedScore, 0) -
                 safeNumber(a.dashboardBalancedScore ?? a.balancedScore, 0) ||
               safeNumber(b.fairWinrate, 0) - safeNumber(a.fairWinrate, 0) ||
               safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
               safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
               safeNumber(a.avgCostR, 0) - safeNumber(b.avgCostR, 0) ||
               sortById(a, b)
          );
      }


      return compareBalanced(a, b);
    });


    return sorted.map((row, index) => normalizeDashboardMicro(row, index + 1));
}
export {
     dashboardSideFromTradeSide
};
