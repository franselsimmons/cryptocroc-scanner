// ================= FILE: src/analyze/microFamilies.js =================


import { CONFIG } from '../config.js';
import {
  getObRelation,
  sideToTradeSide,
  stableHash,
  safeNumber
} from '../utils.js';
import {
    TEMPORAL_CONTEXT_VERSION,
    TEMPORAL_POLICY_VERSION,
    WEEKEND_POLICY_VERSION,
    SESSION_POLICY_VERSION,
    buildTemporalContext,
    temporalPolicyFlags,
    entryTemporalFields
} from './scoring.js';


const FALLBACK_MACRO_SCHEMA = 'MF_V1';
const FALLBACK_MICRO_SCHEMA = 'MF_V2';


const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = TRUE_MICRO_SCHEMA;
const LEARNING_GRANULARITY =
'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_V1';


const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const TARGET_SCANNER_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';


const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';


const EXECUTION_MICRO_SUFFIX = 'XR';
const EXECUTION_MICRO_HASH_LEN = 10;


const MIN_COMPLETED_ACTIVE_LEARNING = 20;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;


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


const LONG_TOKENS = new Set([
  'LONG',
  'BULL',
  'BULLISH',
  'BUY',
  'BID',
  'UP',
  'UPSIDE',
  'GREEN'
]);


const SHORT_TOKENS = new Set([
  'SHORT',
  'BEAR',
  'BEARISH',
  'SELL',
  'ASK',
  'DOWN',
  'DOWNSIDE',
  'RED'
]);


const SETUP_ALIASES = {
  BO: 'BREAKOUT',
  BREAK: 'BREAKOUT',
  BREAK_OUT: 'BREAKOUT',
  BREAKOUT_LONG: 'BREAKOUT',
     MOMENTUM_BREAK: 'BREAKOUT',


     RETEST_LONG: 'RETEST',
     PULLBACK: 'RETEST',
     PULL_BACK: 'RETEST',
     PB: 'RETEST',
     RIP_BUY: 'RETEST',


     SWEEP: 'SWEEP_REVERSAL',
     LIQ_SWEEP: 'SWEEP_REVERSAL',
     LIQUIDITY_SWEEP: 'SWEEP_REVERSAL',
     STOP_RUN: 'SWEEP_REVERSAL',
     REVERSAL: 'SWEEP_REVERSAL',
     SWEEP_REVERSE: 'SWEEP_REVERSAL',


     CONT: 'CONTINUATION',
     CONTINUATION_LONG: 'CONTINUATION',
     MOMENTUM: 'CONTINUATION',
     TREND_CONTINUATION: 'CONTINUATION',


     COMPRESS: 'COMPRESSION',
     COMPRESSION_LONG: 'COMPRESSION',
     COIL: 'COMPRESSION',
     SQUEEZE_SETUP: 'COMPRESSION',
     TIGHT_RANGE: 'COMPRESSION'
};


const REGIME_ALIASES = {
     TRENDING: 'TREND',
     BULL_TREND: 'TREND',
     UPTREND: 'TREND',
     IMPULSE: 'TREND',
     MOMENTUM: 'TREND',


     RANGE: 'CHOP',
     RANGING: 'CHOP',
     SIDEWAYS: 'CHOP',
     CHOPPY: 'CHOP',
     MEAN_REVERT: 'CHOP',


     VOL_SQUEEZE: 'SQUEEZE',
     SQUEEZE_REGIME: 'SQUEEZE',
     COMPRESSION: 'SQUEEZE',
     LOW_VOL: 'SQUEEZE',
     TIGHT: 'SQUEEZE'
};
const CONFIRMATION_ALIASES = {
     A: 'A_STRONG_ALIGN',
     STRONG: 'A_STRONG_ALIGN',
     STRONG_ALIGN: 'A_STRONG_ALIGN',
     FULL_ALIGN: 'A_STRONG_ALIGN',
     ALL_ALIGN: 'A_STRONG_ALIGN',
     HIGH_CONFLUENCE: 'A_STRONG_ALIGN',


     B: 'B_FLOW_ALIGN',
     FLOW: 'B_FLOW_ALIGN',
     FLOW_ALIGN: 'B_FLOW_ALIGN',
     MOMENTUM_ALIGN: 'B_FLOW_ALIGN',
     BID_FLOW: 'B_FLOW_ALIGN',


     C: 'C_VOLUME_ALIGN',
     VOLUME: 'C_VOLUME_ALIGN',
     VOLUME_ALIGN: 'C_VOLUME_ALIGN',
     VOL_ALIGN: 'C_VOLUME_ALIGN',
     VOLUME_SPIKE: 'C_VOLUME_ALIGN',


     D: 'D_MIXED_OK',
     MIXED: 'D_MIXED_OK',
     MIXED_OK: 'D_MIXED_OK',
     NEUTRAL_OK: 'D_MIXED_OK',


     E: 'E_WEAK_CONTRA',
     WEAK: 'E_WEAK_CONTRA',
     WEAK_CONTRA: 'E_WEAK_CONTRA',
     CONTRA: 'E_WEAK_CONTRA'
};


function getMacroSchema() {
     return String(
       CONFIG?.analyze?.macroSchema ||
       CONFIG?.analyze?.legacySchema ||
       FALLBACK_MACRO_SCHEMA
     ).toUpperCase();
}


function getMicroSchema() {
     return String(
       CONFIG?.analyze?.microSchema ||
       FALLBACK_MICRO_SCHEMA
     ).toUpperCase();
}


function shouldBuildExecutionFingerprintMetadata() {
    return CONFIG?.analyze?.buildExecutionFingerprintMetadata !== false;
}


function toUpper(value, fallback = 'UNKNOWN') {
    const raw = String(value ?? '').trim();


    if (!raw) return fallback;


    return raw.toUpperCase();
}


function boolToken(value) {
    return Boolean(value) ? 'YES' : 'NO';
}


function normalizeToken(value, fallback = 'NA', maxLength = 56) {
    const text = String(value ?? '').trim();


    if (!text) return fallback;


    return text
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, maxLength) || fallback;
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
    const text = normalizedSignalText(value);


    if (!text) return false;
    if (LONG_TOKENS.has(text)) return true;


    return hasSignalPattern(text, [
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
    const text = normalizedSignalText(value);


    if (!text) return false;
    if (SHORT_TOKENS.has(text)) return true;


    return hasSignalPattern(text, [
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


function tradeSideFromText(value = '') {
    const raw = cleanSideText(value);


    if (!raw) return 'UNKNOWN';


    const direct = sideToTradeSide(raw);


    if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
    if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
    const longHit = hasLongSignal(raw);
    const shortHit = hasShortSignal(raw);


    if (longHit && !shortHit) return TARGET_TRADE_SIDE;
    if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;


    if (longHit && shortHit) {
        const text = normalizedSignalText(raw);


        if (text.includes('MICRO_LONG')) return TARGET_TRADE_SIDE;
        if (text.includes('MICRO_SHORT')) return OPPOSITE_TRADE_SIDE;
        if (text.includes('TRADE_SIDE_LONG') || text.includes('TRADESIDE_LONG'))
return TARGET_TRADE_SIDE;
        if (text.includes('TRADE_SIDE_SHORT') || text.includes('TRADESIDE_SHORT'))
return OPPOSITE_TRADE_SIDE;


        return 'MIXED';
    }


    return 'UNKNOWN';
}


function normalizeTradeSideValue(value) {
    const side = tradeSideFromText(value);


    if (side === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
    if (side === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;


    return TARGET_TRADE_SIDE;
}


function inferSideFromValues(values = []) {
    let hasLong = false;
    let hasShort = false;


    for (const value of values) {
        const side = tradeSideFromText(value);


        if (side === TARGET_TRADE_SIDE) hasLong = true;
        if (side === OPPOSITE_TRADE_SIDE) hasShort = true;
    }


    if (hasLong && !hasShort) return TARGET_TRADE_SIDE;
    if (hasShort && !hasLong) return OPPOSITE_TRADE_SIDE;
    if (hasLong && hasShort) return 'MIXED';
    return 'UNKNOWN';
}


function inferSideFromIds(metrics = {}) {
    return inferSideFromValues([
      metrics.familyId,
      metrics.microFamilyId,
      metrics.macroFamilyId,
      metrics.parentMacroFamilyId,
      metrics.parentMicroFamilyId,
      metrics.parentTrueMicroFamilyId,
      metrics.trueMicroFamilyId,
      metrics.childTrueMicroFamilyId,
      metrics.coarseMicroFamilyId,
      metrics.baseMicroFamilyId,
      metrics.legacyMicroFamilyId,
      metrics.id,
      metrics.key
    ]);
}


function inferSideFromScannerReason(metrics = {}) {
    return inferSideFromValues([
      metrics.scannerReason,
      metrics.reason,
      metrics.signalReason,
      metrics.actionReason
    ]);
}


function inferTradeSide(metrics = {}) {
    const directSide = inferSideFromValues([
      metrics.tradeSide,
      metrics.side,
      metrics.positionSide,
      metrics.direction,
      metrics.signalSide,
      metrics.scannerSide,
      metrics.actualScannerSide,
      metrics.analysisSide,
      metrics.expectedSide,
      metrics.predictedSide,
      metrics.intentSide,
      metrics.biasSide
    ]);


    if (directSide === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
    if (directSide === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;


    const idSide = inferSideFromIds(metrics);


    if (idSide === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
    if (idSide === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;


    const reasonSide = inferSideFromScannerReason(metrics);


    if (reasonSide === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
    if (reasonSide === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;


    if (metrics.longOnly === true || metrics.shortDisabled === true) {
        return TARGET_TRADE_SIDE;
    }


    if (metrics.shortOnly === true || metrics.longDisabled === true) {
        return OPPOSITE_TRADE_SIDE;
    }


    return TARGET_TRADE_SIDE;
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
        scannerSide: TARGET_SCANNER_SIDE,
        actualScannerSide: TARGET_SCANNER_SIDE,
        analysisSide: TARGET_TRADE_SIDE,


        longOnly: true,
        shortDisabled: true,
        shortOnly: false,
        longDisabled: false,


        virtualOnly: true,
        virtualLearning: true,
        virtualTracked: true,
        shadowOnly: true,
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


    observationFirst: true,
    observationAlwaysCounted: true,


    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,


    statusRules: {
         OBSERVING: 'completed == 0',
         EARLY_OUTCOMES: `completed > 0 && completed <
${MIN_COMPLETED_ACTIVE_LEARNING}`,
         ACTIVE_LEARNING: `completed >= ${MIN_COMPLETED_ACTIVE_LEARNING}`
    },


    defaultRanking:
'dashboardBalancedScore|balancedScore|fairWinrate|totalR|avgR|avgCostR',
    rankingUsesBalancedScore: true,
    rankingUsesFairWinrate: true,
    rankingUsesTotalR: true,
    rankingUsesAvgR: true,
    rankingUsesAvgCostR: true,
    bareWinrateRankingDisabled: true,


    globalMaxOpenPositionsBlockDisabled: true,
    maxOneOpenPositionPerSymbol: true,
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


currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
currentFitSoftOnly: true,
currentFitBlocksLearning: false,


...temporalPolicyFlags(buildTemporalContext(Date.now())),
    temporalPolicyVersion: TEMPORAL_POLICY_VERSION,


manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
discordOnlyForSelectedMicroFamilies: true,
discordOnlyForExactTrueMicroMatch: true,
discordSelectionRule: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY',


scannerFingerprintsMetadataOnly: true,
scannerFingerprintsUsedAsLearningFamily: false,
scannerFingerprintRole: 'METADATA_ONLY',
scannerBucketsMetadataOnly: true,
legacy25BucketsMetadataOnly: true,


executionFingerprintsMetadataOnly: true,
executionFingerprintsUsedAsLearningFamily: false,
executionFingerprintRole: 'METADATA_ONLY',


analyzeMicroFamiliesOnly: true,
learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
exactTrueMicroFamilyRequired: true,
symbolExcludedFromFamilyId: true,
coinNameExcludedFromFamilyId: true,
hashesExcludedFromFamilyId: true,


trueMicroOnly: true,
exactTrueMicroOnly: true,
trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
         fixedTaxonomyPreferred: true,
         fixedTaxonomyLearningId: true,


         parentLearningEnabled: true,
         childLearningEnabled: true,
         selectionGranularity: 'EXACT_75_CHILD',
         fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED',


         learningGranularity: LEARNING_GRANULARITY,
         parentLearningGranularity: PARENT_LEARNING_GRANULARITY,


         bucketGranularity: 'LOW_MID_HIGH',
         bucketsCoarseOnly: true,


         autoRotationDisabled: true,
         activateNextDisabled: true,
         freezeCronDisabled: true,
         activateCronDisabled: true,
         resetCronDisabled: true,


         redisNamespace: LONG_NAMESPACE,
         redisKeyPrefix: LONG_KEY_PREFIX,
         persistentLearningKey: PERSISTENT_LEARNING_KEY,
         redisKeysSeparatedFromShortRoot: true,
         shortRootTouched: false
    };
}


function assertLongOnly(metrics = {}) {
    const side = inferTradeSide(metrics);


    if (side === OPPOSITE_TRADE_SIDE) {
         const error = new Error('LONG_ONLY_MICRO_FAMILY_SYSTEM:SHORT_DISABLED');
         error.reason = 'SHORT_DISABLED_LONG_ONLY';
         error.tradeSide = OPPOSITE_TRADE_SIDE;
         throw error;
    }


    return {
         ...metrics,
         ...modeFlags()
    };
}


function normalizeSide() {
    return TARGET_DASHBOARD_SIDE;
}
function firstFinite(...values) {
    for (const value of values) {
        const n = safeNumber(value, NaN);


        if (Number.isFinite(n)) return n;
    }


    return NaN;
}


function firstValue(...values) {
    for (const value of values) {
        if (value !== undefined && value !== null && value !== '') return value;
    }


    return null;
}


function ratioToBps(value) {
    const n = safeNumber(value, NaN);


    if (!Number.isFinite(n)) return NaN;


    return Math.abs(n) * 10000;
}


function numericBps(value) {
    const bps = ratioToBps(value);


    if (!Number.isFinite(bps)) return null;


    return Number(bps.toFixed(3));
}


function threeTier(value, {
    prefix,
    low,
    high,
    scale = 1,
    fallback = 'NA',
    lowLabel = 'LOW',
    midLabel = 'MID',
    highLabel = 'HIGH'
} = {}) {
    const n = safeNumber(value, NaN);
    if (!Number.isFinite(n)) return `${prefix}_${fallback}`;


    const scaled = n * scale;


    if (scaled < low) return `${prefix}_${lowLabel}`;
    if (scaled >= high) return `${prefix}_${highLabel}`;


    return `${prefix}_${midLabel}`;
}


function signedThreeTier(value, {
    prefix,
    low = -0.25,
    high = 0.25,
    fallback = 'NA',
    lowLabel = 'NEG',
    midLabel = 'MID',
    highLabel = 'POS'
} = {}) {
    const n = safeNumber(value, NaN);


    if (!Number.isFinite(n)) return `${prefix}_${fallback}`;
    if (n < low) return `${prefix}_${lowLabel}`;
    if (n >= high) return `${prefix}_${highLabel}`;


    return `${prefix}_${midLabel}`;
}


function pctThreeTier(value, {
    prefix,
    lowBps,
    highBps,
    fallback = 'NA',
    lowLabel = 'NEAR',
    midLabel = 'MID',
    highLabel = 'FAR'
} = {}) {
    const bps = ratioToBps(value);


    if (!Number.isFinite(bps)) return `${prefix}_${fallback}`;
    if (bps < lowBps) return `${prefix}_${lowLabel}`;
    if (bps >= highBps) return `${prefix}_${highLabel}`;


    return `${prefix}_${midLabel}`;
}


function scoreTier(score, prefix) {
    return threeTier(score, {
      prefix,
      low: 35,
      high: 70
    });
}


function signedScoreTier(score, prefix) {
    return signedThreeTier(score, {
      prefix,
      low: -35,
      high: 35,
      lowLabel: 'NEG',
      midLabel: 'FLAT',
      highLabel: 'POS'
    });
}


function spreadTier(value) {
    const bps = ratioToBps(value);


    if (!Number.isFinite(bps)) return 'SPREAD_NA';
    if (bps < 4) return 'SPREAD_TIGHT';
    if (bps >= 15) return 'SPREAD_WIDE';


    return 'SPREAD_NORMAL';
}


function volatilityTier(value) {
    const bps = ratioToBps(value);


    if (!Number.isFinite(bps)) return 'VOL_NA';
    if (bps < 100) return 'VOL_LOW';
    if (bps >= 400) return 'VOL_HIGH';


    return 'VOL_MID';
}


function depthTier(value) {
    const usd = safeNumber(value, NaN);


    if (!Number.isFinite(usd)) return 'DEPTH_NA';
    if (usd < 50_000) return 'DEPTH_LOW';
    if (usd >= 300_000) return 'DEPTH_HIGH';


    return 'DEPTH_MID';
}
function rrTier(rr) {
    const r = safeNumber(rr, NaN);


    if (!Number.isFinite(r)) return 'RR_NA';
    if (r < 1.2) return 'RR_LOW';
    if (r >= 2.0) return 'RR_HIGH';


    return 'RR_MID';
}


function fundingTier(value) {
    const n = safeNumber(value, NaN);


    if (!Number.isFinite(n)) return 'FUNDING_NA';
    if (n < -0.0001) return 'FUNDING_NEG';
    if (n > 0.0001) return 'FUNDING_POS';


    return 'FUNDING_FLAT';
}


function costTier(costR) {
    const c = safeNumber(costR, NaN);


    if (!Number.isFinite(c)) return 'COST_R_NA';
    if (c < 0.15) return 'COST_R_LOW';
    if (c >= 0.35) return 'COST_R_HIGH';


    return 'COST_R_MID';
}


function coarseRsi(zone) {
    const z = toUpper(zone, 'MID');


    if (z.startsWith('LOWER') || z.includes('OVERSOLD')) return 'LOWER';
    if (z.startsWith('UPPER') || z.includes('OVERBOUGHT')) return 'UPPER';


    return 'MID';
}


function tier(score) {
    const s = safeNumber(score, NaN);


    if (!Number.isFinite(s)) return 'NA';
    if (s >= 70) return 'HIGH';
    if (s >= 35) return 'MID';
    return 'LOW';
}


function scoreBucket(score, prefix) {
    return scoreTier(score, prefix);
}


function signedScoreBucket(score, prefix) {
    return signedScoreTier(score, prefix);
}


function bucketDistancePct(value, prefix) {
    return pctThreeTier(value, {
      prefix,
      lowBps: 25,
      highBps: 150,
      lowLabel: 'NEAR',
      midLabel: 'MID',
      highLabel: 'FAR'
    });
}


function bucketVolatilityPct(value) {
    return volatilityTier(value);
}


function microDepthBucket(value) {
    return depthTier(value);
}


function rrMicroBucket(rr) {
    return rrTier(rr);
}


function entryQuality(metrics = {}) {
    if (metrics.retestConfirmed) return 'RETEST';
    if (metrics.pullbackConfirmed) return 'PULLBACK';
    if (metrics.sweepConfirmed) return 'SWEEP';


    return 'RAW';
}


function btcRelation(sideOrMetrics, btcStateInput = null) {
    const btcState = sideOrMetrics && typeof sideOrMetrics === 'object'
      ? sideOrMetrics.btcState
      : btcStateInput;
    const btc = toUpper(btcState, 'NEUTRAL');


    if (btc === 'NEUTRAL' || btc === 'UNKNOWN' || btc === 'NA') return
'BTC_NEUTRAL';


    if (['BULLISH', 'STRONG_BULL', 'BULL', 'UP'].includes(btc)) {
        return 'BTC_WITH';
    }


    return 'BTC_AGAINST';
}


function coarseBtcState(sideOrMetrics, btcStateInput = null) {
    return btcRelation(sideOrMetrics, btcStateInput);
}


function coarseRegime(regime) {
    const r = toUpper(regime, 'NORMAL_VOL');


    if (r.includes('HIGH') || r.includes('EXTREME')) return 'HIGH_VOL';
    if (r.includes('LOW')) return 'LOW_VOL';


    return 'NORMAL_VOL';
}


function coarseFlow(flow) {
    const f = toUpper(flow, 'NEUTRAL');


    if (['TREND', 'IMPULSE', 'PUMP', 'BUY_IMPULSE', 'BULL_FLOW'].includes(f)) return
'TREND';
    if (f === 'BUILDING') return 'BUILDING';


    return 'NEUTRAL';
}


function coarseScannerReason(reason) {
    const r = toUpper(reason, 'UNKNOWN');


    if (r.includes('SWEEP')) return 'SWEEP';
    if (r.includes('RETEST')) return 'RETEST';
    if (r.includes('PULLBACK')) return 'PULLBACK';
    if (r.includes('BREAKOUT')) return 'BREAKOUT';
    if (r.includes('VOLUME')) return 'VOLUME';
    if (r.includes('MOMENTUM')) return 'MOMENTUM';
    if (r.includes('COMPRESSION')) return 'COMPRESSION';
    if (r.includes('SQUEEZE')) return 'SQUEEZE';
    return 'UNKNOWN';
}


function normalizeObRelation(metrics = {}) {
    const explicit = toUpper(metrics.obRelation || '', '');


    if (explicit) return explicit;


    return toUpper(
         getObRelation(TARGET_TRADE_SIDE, metrics.obBias) ||
         'UNKNOWN'
    );
}


function assetClass(metrics = {}) {
    const explicit = toUpper(
         metrics.assetClass ||
         metrics.marketClass ||
         metrics.instrumentClass ||
         '',
         ''
    );


    if (explicit) return explicit;


    return 'CRYPTO';
}


function getCleanSymbol(metrics = {}) {
    const raw = toUpper(
         metrics.symbol ||
         metrics.baseSymbol ||
         metrics.contractSymbol ||
         '',
         ''
    );


    const cleaned = raw


.replace(/USDTUMCBL|USDCUMCBL|USDTPERP|USDCPERP|USDT|USDC|BUSD|PERP|SWAP|USD/gu,
'')
         .replace(/[^A-Z0-9]/gu, '');


    return cleaned || 'UNKNOWN';
}


function symbolClassBucket(metrics = {}) {
    const symbol = getCleanSymbol(metrics);


    const majors = new Set([
         'BTC',
         'ETH',
         'SOL',
         'XRP',
         'BNB',
         'DOGE',
         'ADA',
         'AVAX',
         'LINK',
         'DOT',
         'TON',
         'TRX',
         'LTC',
         'BCH'
    ]);


    const memes = new Set([
         'PEPE',
         'SHIB',
         'WIF',
         'BONK',
         'FLOKI',
         'DOGE'
    ]);


    if (majors.has(symbol)) return 'SYMBOL_MAJOR';
    if (memes.has(symbol)) return 'SYMBOL_MEME';


    return 'SYMBOL_ALT';
}


function getEntryDistancePct(metrics = {}) {
    return firstFinite(
         metrics.entryDistancePct,
         metrics.entryDistanceToMidPct,
         metrics.pullbackDistancePct,
         metrics.distanceToEntryPct,
         metrics.distancePct
    );
}


function getSlDistancePct(metrics = {}) {
    return firstFinite(
         metrics.slDistancePct,
         metrics.stopDistancePct,
         metrics.stopLossDistancePct,
         metrics.riskPct
    );
}


function getTpDistancePct(metrics = {}) {
    return firstFinite(
         metrics.tpDistancePct,
         metrics.takeProfitDistancePct,
         metrics.rewardPct
    );
}


function getLiquidationDistancePct(metrics = {}) {
    return firstFinite(
         metrics.liqDistancePct,
         metrics.liquidationDistancePct,
         metrics.distanceToLiquidationPct,
         metrics.nearestLiqDistancePct
    );
}


function getVolatilityPct(metrics = {}) {
    return firstFinite(
         metrics.atrPct,
         metrics.volatilityPct,
         metrics.rangePct,
         metrics.realizedVolPct
    );
}


function getSpoofScore(metrics = {}) {
    return firstFinite(
         metrics.spoofScore,
         metrics.orderbookSpoofScore,
         metrics.obSpoofScore,
         metrics.fakeLiquidityScore
    );
}


function getOrderbookImbalance(metrics = {}) {
    return firstFinite(
         metrics.orderbookImbalance,
         metrics.bookImbalance,
         metrics.obImbalance,
         metrics.bidAskImbalance
    );
}


function getRsiSlope(metrics = {}) {
    return firstFinite(
         metrics.rsiSlope,
         metrics.rsiVelocity,
         metrics.rsiDelta,
         metrics.rsiMomentum
    );
}


function getCostR(metrics = {}) {
    return firstFinite(
         metrics.costR,
         metrics.avgCostR,
         metrics.estimatedCostR
    );
}


function getConfluenceScore(metrics = {}) {
    return firstFinite(
         metrics.confluence,
         metrics.sniperScore,
         metrics.scannerScore,
         metrics.moveScore
    );
}


function getSpreadPct(metrics = {}) {
    const spreadPct = firstFinite(metrics.spreadPct);


    if (Number.isFinite(spreadPct)) return spreadPct;


    const spreadBps = firstFinite(metrics.spreadBps);


    if (Number.isFinite(spreadBps)) return spreadBps / 10000;


    return NaN;
}


function normalizeSetupType(value = '') {
    const raw = normalizeToken(value, '', 80);


    if (!raw) return null;
    if (SETUP_SET.has(raw)) return raw;
    if (SETUP_ALIASES[raw]) return SETUP_ALIASES[raw];
    if (raw.includes('SWEEP') || raw.includes('STOP_RUN') ||
raw.includes('REVERSAL')) return 'SWEEP_REVERSAL';
    if (raw.includes('RETEST') || raw.includes('PULLBACK') || raw.includes('RIP'))
return 'RETEST';
    if (raw.includes('COMPRESSION') || raw.includes('SQUEEZE') ||
raw.includes('COIL') || raw.includes('TIGHT')) return 'COMPRESSION';
    if (raw.includes('CONTINUATION') || raw.includes('TREND_CONT')) return
'CONTINUATION';
    if (raw.includes('BREAKOUT') || raw.includes('BREAK')) return 'BREAKOUT';


    return null;
}


function normalizeRegimeBucket(value = '') {
    const raw = normalizeToken(value, '', 80);


    if (!raw) return null;
    if (REGIME_SET.has(raw)) return raw;
    if (REGIME_ALIASES[raw]) return REGIME_ALIASES[raw];


    if (raw.includes('SQUEEZE') || raw.includes('COMPRESSION') ||
raw.includes('LOW_VOL') || raw.includes('TIGHT')) return 'SQUEEZE';
    if (raw.includes('CHOP') || raw.includes('RANGE') || raw.includes('SIDEWAYS'))
return 'CHOP';
    if (raw.includes('TREND') || raw.includes('IMPULSE') ||
raw.includes('MOMENTUM')) return 'TREND';


    return null;
}


function normalizeConfirmationProfile(value = '') {
    const raw = normalizeToken(value, '', 80);


    if (!raw) return null;
    if (CONFIRMATION_SET.has(raw)) return raw;
    if (CONFIRMATION_ALIASES[raw]) return CONFIRMATION_ALIASES[raw];


    for (const profile of CONFIRMATION_PROFILES) {
        if (raw.includes(profile)) return profile;
    }


    if (raw.includes('STRONG') || raw.includes('FULL_ALIGN') ||
raw.includes('ALL_ALIGN')) return 'A_STRONG_ALIGN';
    if (raw.includes('FLOW') || raw.includes('MOMENTUM')) return 'B_FLOW_ALIGN';
    if (raw.includes('VOLUME') || raw.includes('VOL') || raw.includes('LIQUIDITY'))
return 'C_VOLUME_ALIGN';
    if (raw.includes('MIXED') || raw.includes('NEUTRAL') || raw.includes('OK'))
return 'D_MIXED_OK';
    if (raw.includes('WEAK') || raw.includes('CONTRA') || raw.includes('AGAINST'))
return 'E_WEAK_CONTRA';


    return null;
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


    let setup = null;
    let regime = null;


    for (const candidateRegime of REGIME_BUCKETS) {
        const suffix = `_${candidateRegime}`;


        if (body.endsWith(suffix)) {
             regime = candidateRegime;
             setup = body.slice(0, -suffix.length);
             break;
        }
    }
    const parentId = setup && regime ? `MICRO_LONG_${setup}_${regime}` : null;
    const childId = parentId && confirmationProfile ?
`${parentId}_${confirmationProfile}` : null;


    const validParent =
         Boolean(parentId) &&
         SETUP_SET.has(setup) &&
         REGIME_SET.has(regime);


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
         setup,
         regime,
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


function isExecutionFingerprintId(id = '') {
    const value = String(id || '').toUpperCase();


    return (
         value.includes(`_${EXECUTION_MICRO_SUFFIX}_`) ||
         value.includes(`__${EXECUTION_MICRO_SUFFIX}__`) ||
         value.includes('EXECUTION_FINGERPRINT') ||
         value.includes('EXECUTION_MICRO') ||
         value.includes('REFINED_EXECUTION')
    );
}
function isScannerFamilyId(id = '') {
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


function validLearningId(id = '') {
    const value = String(id || '').trim();


    if (!value) return false;
    if (isScannerFamilyId(value)) return false;
    if (isExecutionFingerprintId(value)) return false;


    return true;
}


function isFixedTaxonomyParentMicroId(id = '') {
    const parsed = parseLongTaxonomyMicroId(id);


    return parsed.isParent === true;
}


function isFixedTaxonomyChildMicroId(id = '') {
    const parsed = parseLongTaxonomyMicroId(id);


    return parsed.isChild === true;
}


function isFixedTaxonomyMicroId(id = '') {
    return isFixedTaxonomyChildMicroId(id);
}


function normalizeChildTrueMicroFamilyId(id = '') {
    const value = String(id || '').trim().toUpperCase();
    if (!validLearningId(value)) return '';


    const parsed = parseLongTaxonomyMicroId(value);


    return parsed.isChild ? parsed.childTrueMicroFamilyId : '';
}


function normalizeParentTrueMicroFamilyId(id = '') {
    const value = String(id || '').trim().toUpperCase();


    if (!value) return '';


    const parsed = parseLongTaxonomyMicroId(value);


    if (parsed.isChild || parsed.isParent) return parsed.parentTrueMicroFamilyId;


    return '';
}


function isAnalyzeFamilyId(id = '') {
    const value = String(id || '').toUpperCase();


    if (!value) return false;
    if (!validLearningId(value)) return false;
    if (isFixedTaxonomyChildMicroId(value)) return true;
    if (isFixedTaxonomyParentMicroId(value)) return false;


    return (
         /^LONG_F\d{2}$/u.test(value) ||
         (
             value.startsWith('LONG_') &&
             !value.startsWith('LONG_SCANNER_')
         )
    );
}


function uniqueStrings(values = []) {
    return [...new Set(
         (Array.isArray(values) ? values : [values])
             .flatMap((value) => Array.isArray(value) ? value : [value])
             .map((value) => String(value || '').trim())
             .filter(Boolean)
    )];
}


function getScannerMetadata(metrics = {}) {
    const scannerMicroFamilyId = firstValue(
         metrics.scannerMicroFamilyId,
         isScannerFamilyId(metrics.trueMicroFamilyId) ? metrics.trueMicroFamilyId :
null,
         isScannerFamilyId(metrics.microFamilyId) ? metrics.microFamilyId : null,
         isScannerFamilyId(metrics.id) ? metrics.id : null,
         isScannerFamilyId(metrics.key) ? metrics.key : null
    );


    const scannerFamilyId = firstValue(
         metrics.scannerFamilyId,
         isScannerFamilyId(metrics.familyId) ? metrics.familyId : null,
         isScannerFamilyId(metrics.baseFamilyId) ? metrics.baseFamilyId : null
    );


    const scannerDefinitionParts = Array.isArray(metrics.scannerDefinitionParts)
         ? metrics.scannerDefinitionParts
         : Array.isArray(metrics.definitionParts) && scannerMicroFamilyId
           ? metrics.definitionParts
           : [];


    const scannerDefinition = firstValue(
         metrics.scannerDefinition,
         scannerMicroFamilyId ? metrics.definition : null,
         scannerMicroFamilyId ? metrics.microDefinition : null
    );


    return {
         scannerMicroFamilyId: scannerMicroFamilyId || null,
         scannerFamilyId: scannerFamilyId || null,
         scannerDefinition: scannerDefinition || null,
         scannerDefinitionParts,
         scannerFingerprintRole: 'METADATA_ONLY',
         scannerFingerprintsMetadataOnly: true,
         scannerFingerprintsUsedAsLearningFamily: false
    };
}


function resolveAnalyzeFamilyId(metrics = {}) {
    const candidate = firstValue(
         metrics.analyzeFamilyId,
         metrics.learningFamilyId,
         metrics.familyId
    );


    if (isAnalyzeFamilyId(candidate) && !isFixedTaxonomyChildMicroId(candidate)) {
         return String(candidate).toUpperCase();
    }
    return classifyFamily(metrics);
}


function classifySetupType(metrics = {}) {
    const explicit = normalizeSetupType(metrics.setupType || metrics.setup ||
metrics.longSetup || '');


    if (explicit) return explicit;


    const reason = toUpper(
         metrics.scannerReason ||
         metrics.reason ||
         metrics.signalReason ||
         metrics.actionReason ||
         '',
         ''
    );


    const flow = coarseFlow(metrics.flow);
    const volBucket = volatilityTier(getVolatilityPct(metrics));


    if (metrics.retestConfirmed || reason.includes('RETEST')) return 'RETEST';
    if (metrics.sweepConfirmed || reason.includes('SWEEP') ||
reason.includes('STOP_RUN')) return 'SWEEP_REVERSAL';
    if (metrics.pullbackConfirmed || reason.includes('PULLBACK')) return 'RETEST';


    if (
         reason.includes('COMPRESSION') ||
         reason.includes('SQUEEZE') ||
         (
              volBucket === 'VOL_LOW' &&
              flow !== 'TREND'
         )
    ) {
         return 'COMPRESSION';
    }


    if (
         flow === 'TREND' &&
         !metrics.fakeBreakout &&
         !metrics.fakeBreakoutRisk
    ) {
         return 'CONTINUATION';
    }


    if (reason.includes('BREAKOUT')) return 'BREAKOUT';
    return 'BREAKOUT';
}


function classifyRegimeBucket(metrics = {}) {
    const explicit = normalizeRegimeBucket(metrics.regimeBucket ||
metrics.regimeClass || '');


    if (explicit) return explicit;


    const vol = coarseRegime(metrics.regime);
    const flow = coarseFlow(metrics.flow);
    const volBucket = volatilityTier(getVolatilityPct(metrics));


    if (
         vol === 'LOW_VOL' ||
         volBucket === 'VOL_LOW' ||
         metrics.squeeze === true ||
         metrics.compression === true ||
         metrics.squeezeActive === true
    ) {
         return 'SQUEEZE';
    }


    if (
         flow === 'TREND' ||
         vol === 'HIGH_VOL'
    ) {
         return 'TREND';
    }


    return 'CHOP';
}


function detectStructureAligned(metrics = {}) {
    const reason = toUpper(
         metrics.scannerReason ||
         metrics.reason ||
         metrics.signalReason ||
         metrics.actionReason ||
         '',
         ''
    );


    return Boolean(
         metrics.retestConfirmed ||
         metrics.pullbackConfirmed ||
      metrics.sweepConfirmed ||
      metrics.breakoutConfirmed ||
      metrics.continuationConfirmed ||
      metrics.compressionConfirmed ||
      metrics.setupConfirmed ||
      metrics.structureAlign ||
      metrics.structureAligned
    ) || [
      'RETEST',
      'PULLBACK',
      'SWEEP',
      'STOP_RUN',
      'BREAKOUT',
      'CONTINUATION',
      'COMPRESSION',
      'SQUEEZE'
    ].some((token) => reason.includes(token));
}


function detectFlowAligned(metrics = {}) {
    const flow = coarseFlow(metrics.flow);
    const obRelation = normalizeObRelation(metrics);
    const btcRel = btcRelation(TARGET_TRADE_SIDE, metrics.btcState);
    const orderbookImbalance = getOrderbookImbalance(metrics);


    return Boolean(
      metrics.flowAlign ||
      metrics.flowAligned ||
      metrics.momentumAlign ||
      metrics.bidFlowAlign ||
      metrics.bullFlow ||
      metrics.buyFlow
    ) ||
      flow === 'TREND' ||
      flow === 'BUILDING' ||
      obRelation === 'WITH' ||
      btcRel === 'BTC_WITH' ||
      (Number.isFinite(orderbookImbalance) && orderbookImbalance > 0.25);
}


function detectVolumeAligned(metrics = {}) {
    const bucket = toUpper(
      metrics.volBucket ||
      metrics.volumeBucket ||
      metrics.volumeTier ||
      metrics.volumeRegime ||
      '',
         ''
    );


    if ([
         'HIGH',
         'STRONG',
         'EXPANSION',
         'VOLUME_HIGH',
         'VOL_HIGH',
         'HIGH_VOLUME',
         'VOLUME_EXPANSION'
    ].includes(bucket)) {
         return true;
    }


    if (
         metrics.volumeSpike === true ||
         metrics.volumeConfirmed === true ||
         metrics.volumeAlign === true ||
         metrics.volumeAligned === true ||
         metrics.volumeSpikeConfirmed === true ||
         metrics.quoteVolumeSpike === true ||
         metrics.obVolumeAlign === true
    ) {
         return true;
    }


    const relVol = firstFinite(
         metrics.relativeVolume,
         metrics.relVolume,
         metrics.volumeScore,
         metrics.volumeStrength
    );


    if (Number.isFinite(relVol) && relVol >= 1.4) {
         return true;
    }


    return false;
}


function detectHardContra(metrics = {}) {
    const obRelation = normalizeObRelation(metrics);
    const btcRel = btcRelation(TARGET_TRADE_SIDE, metrics.btcState);


    return Boolean(
         metrics.fakeBreakout ||
         metrics.fakeBreakoutRisk ||
         metrics.avoidLong ||
         metrics.doNotLong ||
         metrics.weakContra ||
         metrics.contraSignal ||
         metrics.bearishDivergence
    ) ||
         obRelation === 'AGAINST' ||
         btcRel === 'BTC_AGAINST' ||
         hasShortSignal(metrics.flow) ||
         hasShortSignal(metrics.flowDirection) ||
         hasShortSignal(metrics.orderFlow) ||
         hasShortSignal(metrics.marketFlow) ||
         hasShortSignal(metrics.obBias);
}


function classifyConfirmationProfile(metrics = {}) {
    const explicit = normalizeConfirmationProfile(
         metrics.confirmationProfile ||
         metrics.confirmProfile ||
         metrics.confirmation ||
         ''
    );


    if (explicit) return explicit;


    const existing = firstValue(
         metrics.trueMicroFamilyId,
         metrics.microFamilyId,
         metrics.childTrueMicroFamilyId
    );


    const parsedExisting = parseLongTaxonomyMicroId(existing);


    if (parsedExisting.isChild) return parsedExisting.confirmationProfile;


    const structureAligned = detectStructureAligned(metrics);
    const flowAligned = detectFlowAligned(metrics);
    const volumeAligned = detectVolumeAligned(metrics);
    const hardContraDetected = detectHardContra(metrics);
    const confluence = safeNumber(getConfluenceScore(metrics), 0);


    if (hardContraDetected) return 'E_WEAK_CONTRA';
    if (structureAligned && flowAligned && volumeAligned) return 'A_STRONG_ALIGN';
    if (flowAligned) return 'B_FLOW_ALIGN';
    if (volumeAligned) return 'C_VOLUME_ALIGN';
    if (confluence >= 35 || structureAligned) return 'D_MIXED_OK';
    return 'E_WEAK_CONTRA';
}


function buildTaxonomyFamilyId(metrics = {}) {
    const explicitChild = normalizeChildTrueMicroFamilyId(
         metrics.trueMicroFamilyId ||
         metrics.microFamilyId ||
         metrics.childTrueMicroFamilyId
    );


    if (explicitChild) {
         const parsed = parseLongTaxonomyMicroId(explicitChild);


         return {
              setup: parsed.setup,
              regime: parsed.regime,
              confirmationProfile: parsed.confirmationProfile,
              setupType: parsed.setup,
              regimeBucket: parsed.regime,
              parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
              childTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
              microFamilyId: parsed.childTrueMicroFamilyId,
              trueMicroFamilyId: parsed.childTrueMicroFamilyId,
              selectable: true
         };
    }


    const setup = classifySetupType(metrics);
    const regime = classifyRegimeBucket(metrics);
    const confirmationProfile = classifyConfirmationProfile(metrics);


    const parentTrueMicroFamilyId = `MICRO_${TARGET_TRADE_SIDE}_${setup}_${regime}`;
    const childTrueMicroFamilyId =
`${parentTrueMicroFamilyId}_${confirmationProfile}`;


    return {
         setup,
         regime,
         confirmationProfile,
         setupType: setup,
         regimeBucket: regime,
         parentTrueMicroFamilyId,
         childTrueMicroFamilyId,
         microFamilyId: childTrueMicroFamilyId,
         trueMicroFamilyId: childTrueMicroFamilyId,
         selectable: true
    };
}


function buildMacroDefinitionParts(metrics = {}, familyId, taxonomy = null) {
    const normalizedSide = normalizeSide(metrics);
    const obRelation = normalizeObRelation(metrics);
    const btcRel = btcRelation(metrics);
    const regime = coarseRegime(metrics.regime);
    const flow = coarseFlow(metrics.flow);
    const scannerReason = coarseScannerReason(metrics.scannerReason);


    return [
         `schema=${PARENT_TRUE_MICRO_SCHEMA}`,
         `legacySchema=${getMacroSchema()}`,
         `granularity=${PARENT_LEARNING_GRANULARITY}`,
         `side=${normalizedSide}`,
         `tradeSide=${TARGET_TRADE_SIDE}`,
         `family=${familyId}`,
         `parentTrueMicroFamilyId=${taxonomy?.parentTrueMicroFamilyId || 'UNKNOWN'}`,
         `setupType=${taxonomy?.setup || 'UNKNOWN'}`,
         `regimeBucket=${taxonomy?.regime || 'UNKNOWN'}`,
         `rsi=${coarseRsi(metrics.rsiZone)}`,
         `flow=${flow}`,
         `obRelation=${obRelation}`,
         `btcRelation=${btcRel}`,
         `regime=${regime}`,
         `confluenceTier=${tier(getConfluenceScore(metrics))}`,
         `rrTier=${rrTier(metrics.rr)}`,
         `spreadTier=${spreadTier(getSpreadPct(metrics))}`,
         `depthTier=${depthTier(metrics.depthMinUsd1p)}`,
         `fundingTier=${fundingTier(metrics.fundingRate)}`,
         `entryQuality=${entryQuality(metrics)}`,
         `fakeBreakout=${boolToken(metrics.fakeBreakout)}`,
         `scannerReason=${scannerReason}`,
         'currentFitPolarity=BULLISH_POSITIVE_BEARISH_NEGATIVE',
         'riskGeometryRule=LONG:sl<entry<tp'
    ];
}


function buildMicroDefinitionParts(metrics = {}, parent, taxonomy) {
    const spreadPct = getSpreadPct(metrics);
    const entryDistancePct = getEntryDistancePct(metrics);
    const slDistancePct = getSlDistancePct(metrics);
    const tpDistancePct = getTpDistancePct(metrics);
    const volatilityPct = getVolatilityPct(metrics);
    const spoofScore = getSpoofScore(metrics);
    const orderbookImbalance = getOrderbookImbalance(metrics);
const rsiSlope = getRsiSlope(metrics);
const costR = getCostR(metrics);


return [
  `schema=${TRUE_MICRO_SCHEMA}`,
  `parentSchema=${PARENT_TRUE_MICRO_SCHEMA}`,
  `legacySchema=${getMicroSchema()}`,
  `granularity=${LEARNING_GRANULARITY}`,
  `parentGranularity=${PARENT_LEARNING_GRANULARITY}`,
  `parentTrueMicroFamilyId=${taxonomy.parentTrueMicroFamilyId}`,
  `side=${TARGET_DASHBOARD_SIDE}`,
  `tradeSide=${TARGET_TRADE_SIDE}`,
  `family=${parent.familyId}`,
  `setupType=${taxonomy.setup}`,
  `regimeBucket=${taxonomy.regime}`,
  `confirmationProfile=${taxonomy.confirmationProfile}`,
  `learningFamily=${taxonomy.childTrueMicroFamilyId}`,
  `trueMicroFamilyId=${taxonomy.childTrueMicroFamilyId}`,
  `assetClass=${assetClass(metrics)}`,
  `symbolClass=${symbolClassBucket(metrics)}`,
  `rsi=${coarseRsi(metrics.rsiZone)}`,
  `rsiSlope=${signedScoreBucket(rsiSlope, 'RSI_SLOPE')}`,
  `flow=${coarseFlow(metrics.flow)}`,
  `obRelation=${normalizeObRelation(metrics)}`,
  `obImbalance=${signedThreeTier(orderbookImbalance, {
    prefix: 'OB_IMB',
    low: -0.25,
    high: 0.25,
    lowLabel: 'ASK_HEAVY',
    midLabel: 'BALANCED',
    highLabel: 'BID_HEAVY'
  })}`,
  `spoof=${scoreBucket(spoofScore, 'SPOOF')}`,
  `btcState=${btcRelation(TARGET_TRADE_SIDE, metrics.btcState)}`,
  `regime=${coarseRegime(metrics.regime)}`,
  `vol=${bucketVolatilityPct(volatilityPct)}`,
  `confluence=${scoreBucket(getConfluenceScore(metrics), 'CONF')}`,
  `rr=${rrMicroBucket(metrics.rr)}`,
  `spread=${spreadTier(spreadPct)}`,
  `depth=${microDepthBucket(metrics.depthMinUsd1p)}`,
  `funding=${fundingTier(metrics.fundingRate)}`,
  `entryQuality=${entryQuality(metrics)}`,
  `entryDistance=${bucketDistancePct(entryDistancePct, 'ENTRY_DIST')}`,
  `slDistance=${pctThreeTier(slDistancePct, {
    prefix: 'RISK',
    lowBps: 70,
    highBps: 200,
           lowLabel: 'TIGHT',
           midLabel: 'NORMAL',
           highLabel: 'WIDE'
         })}`,
         `tpDistance=${pctThreeTier(tpDistancePct, {
           prefix: 'REWARD',
           lowBps: 100,
           highBps: 350,
           lowLabel: 'SMALL',
           midLabel: 'NORMAL',
           highLabel: 'LARGE'
         })}`,
         `cost=${costTier(costR)}`,
         `fakeBreakout=${boolToken(metrics.fakeBreakout)}`,
         `fakeBreakoutRisk=${boolToken(metrics.fakeBreakoutRisk)}`,
         `scannerReason=${coarseScannerReason(metrics.scannerReason)}`,
         'currentFitPolarity=BULLISH_POSITIVE_BEARISH_NEGATIVE',
         'currentFitDefinition=LONG_MIRRORED_CURRENT_FIT',
         'riskGeometryRule=LONG:sl<entry<tp',
         'grossRFormula=(exitPrice-entry)/(entry-initialSl)',
         'currentRFormula=(currentPrice-entry)/(entry-initialSl)'
    ];
}


function buildExecutionFingerprintParts(metrics = {}, parent, taxonomy = {}) {
    const spreadPct = getSpreadPct(metrics);
    const entryDistancePct = getEntryDistancePct(metrics);
    const slDistancePct = getSlDistancePct(metrics);
    const tpDistancePct = getTpDistancePct(metrics);
    const liqDistancePct = getLiquidationDistancePct(metrics);
    const volatilityPct = getVolatilityPct(metrics);
    const spoofScore = getSpoofScore(metrics);
    const orderbookImbalance = getOrderbookImbalance(metrics);
    const rsiSlope = getRsiSlope(metrics);
    const costR = getCostR(metrics);
    const confluence = getConfluenceScore(metrics);


    const scannerReason = firstValue(
         metrics.scannerReasonCoarse,
         metrics.scannerReason,
         metrics.reason,
         metrics.signalReason
    );


    return [
         `xrSchema=${EXECUTION_MICRO_SUFFIX}`,
         `tradeSide=${TARGET_TRADE_SIDE}`,
    `trueMicro=${normalizeToken(taxonomy.childTrueMicroFamilyId ||
'NO_TRUE_MICRO')}`,
    `parentTrueMicro=${normalizeToken(taxonomy.parentTrueMicroFamilyId ||
'NO_PARENT_TRUE_MICRO')}`,
    `setupType=${normalizeToken(taxonomy.setup || 'NA')}`,
    `regimeBucket=${normalizeToken(taxonomy.regime || 'NA')}`,
    `confirmationProfile=${normalizeToken(taxonomy.confirmationProfile || 'NA')}`,
    `family=${normalizeToken(parent.familyId)}`,
    `macro=${normalizeToken(parent.microFamilyId)}`,
    `assetClass=${normalizeToken(assetClass(metrics))}`,
    `symbolClass=${symbolClassBucket(metrics)}`,
    `rsi=${normalizeToken(coarseRsi(metrics.rsiZone))}`,
    `rsiSlope=${signedScoreBucket(rsiSlope, 'RSI_SLOPE')}`,
    `flow=${normalizeToken(coarseFlow(metrics.flow))}`,
    `obRelation=${normalizeToken(normalizeObRelation(metrics))}`,
    `obImb=${signedThreeTier(orderbookImbalance, {
      prefix: 'OB_IMB',
      low: -0.25,
      high: 0.25,
      lowLabel: 'ASK_HEAVY',
      midLabel: 'BALANCED',
      highLabel: 'BID_HEAVY'
    })}`,
    `spoof=${scoreBucket(spoofScore, 'SPOOF')}`,
    `btc=${normalizeToken(btcRelation(TARGET_TRADE_SIDE, metrics.btcState))}`,
    `regime=${normalizeToken(coarseRegime(metrics.regime))}`,
    `scanner=${normalizeToken(coarseScannerReason(scannerReason))}`,
    `spread=${spreadTier(spreadPct)}`,
    `entryDist=${bucketDistancePct(entryDistancePct, 'ENTRY_DIST')}`,
    `risk=${pctThreeTier(slDistancePct, {
      prefix: 'RISK',
      lowBps: 70,
      highBps: 200,
      lowLabel: 'TIGHT',
      midLabel: 'NORMAL',
      highLabel: 'WIDE'
    })}`,
    `reward=${pctThreeTier(tpDistancePct, {
      prefix: 'REWARD',
      lowBps: 100,
      highBps: 350,
      lowLabel: 'SMALL',
      midLabel: 'NORMAL',
      highLabel: 'LARGE'
    })}`,
    `liqDist=${pctThreeTier(liqDistancePct, {
      prefix: 'LIQ_DIST',
           lowBps: 100,
           highBps: 500,
           lowLabel: 'NEAR',
           midLabel: 'MID',
           highLabel: 'FAR'
         })}`,
         `vol=${bucketVolatilityPct(volatilityPct)}`,
         `depth=${depthTier(metrics.depthMinUsd1p)}`,
         `funding=${fundingTier(metrics.fundingRate)}`,
         `rr=${rrTier(metrics.rr)}`,
         `cost=${costTier(costR)}`,
         `confluence=${scoreBucket(confluence, 'CONF')}`,
         `entryQuality=${normalizeToken(entryQuality(metrics))}`,
         `fakeBreakout=${boolToken(metrics.fakeBreakout)}`,
         `fakeBreakoutRisk=${boolToken(metrics.fakeBreakoutRisk)}`
    ];
}


function classifyFamily(metrics = {}) {
    const sideSafeMetrics = assertLongOnly(metrics);


    const seedParts = [
         TARGET_TRADE_SIDE,
         coarseFlow(sideSafeMetrics.flow),
         coarseRsi(sideSafeMetrics.rsiZone),
         normalizeObRelation(sideSafeMetrics),
         coarseBtcState(TARGET_TRADE_SIDE, sideSafeMetrics.btcState),
         coarseRegime(sideSafeMetrics.regime),
         rrTier(sideSafeMetrics.rr),
         scoreTier(getConfluenceScore(sideSafeMetrics), 'CONF')
    ];


    const bucket = (parseInt(stableHash(seedParts.join('|'), 6), 16) % 24) + 1;


    return `${TARGET_TRADE_SIDE}_F${String(bucket).padStart(2, '0')}`;
}


export function buildMicroFamilyV1(metrics = {}) {
    const sideSafeMetrics = assertLongOnly(metrics);
    const tradeSide = TARGET_TRADE_SIDE;


    const taxonomy = buildTaxonomyFamilyId(sideSafeMetrics);
    const familyId = resolveAnalyzeFamilyId(sideSafeMetrics);


    const normalizedSide = TARGET_DASHBOARD_SIDE;
    const obRelation = normalizeObRelation(sideSafeMetrics);
    const btcRel = btcRelation(tradeSide, metrics.btcState);
  const regime = coarseRegime(metrics.regime);
  const flow = coarseFlow(metrics.flow);
  const scannerReason = coarseScannerReason(metrics.scannerReason);
  const definitionParts = buildMacroDefinitionParts(sideSafeMetrics, familyId,
taxonomy);
  const schema = PARENT_TRUE_MICRO_SCHEMA;


  const microFamilyId = taxonomy.parentTrueMicroFamilyId;


  return {
    schema,
    version: 'parent-fixed-taxonomy-15',
    macroSchema: schema,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    learningGranularity: PARENT_LEARNING_GRANULARITY,


    familyId,
    microFamilyId,
    macroFamilyId: microFamilyId,
    parentMacroFamilyId: microFamilyId,
    parentMicroFamilyId: microFamilyId,
    parentTrueMicroFamilyId: microFamilyId,


    childTrueMicroFamilyId: null,
    trueMicroFamilyId: microFamilyId,
    coarseMicroFamilyId: microFamilyId,


    setupType: taxonomy.setup,
    regimeBucket: taxonomy.regime,
    confirmationProfile: null,


    definition: definitionParts.join(' | '),
    definitionParts,
    parentDefinition: definitionParts.join(' | '),
    parentDefinitionParts: definitionParts,


    side: normalizedSide,
    tradeSide,
    positionSide: tradeSide,
    direction: tradeSide,


    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_SCANNER_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,


    obRelation,
    btcRelation: btcRel,
         regime,
         flow,
         scannerReason,


         ...modeFlags(),


         isLegacyMacro: false,
         isParentTrueMicro: true,
         isTrueMicro: false,
         selectable: false,
         parentOnlyMetadata: true,
         macroOnlyMetadata: true,
         parentSelectionAllowed: false,


         spreadBps: Number((safeNumber(getSpreadPct(metrics), 0) * 10000).toFixed(3))
    };
}


export function buildMicroFamilyV2(metrics = {}) {
    const sideSafeMetrics = assertLongOnly(metrics);
    const tradeSide = TARGET_TRADE_SIDE;


    const scannerMetadata = getScannerMetadata(sideSafeMetrics);
    const taxonomy = buildTaxonomyFamilyId(sideSafeMetrics);
    const parent = buildMicroFamilyV1({
         ...sideSafeMetrics,
         setupType: taxonomy.setup,
         regimeBucket: taxonomy.regime
    });


    const analyzeMicroFamilyId = taxonomy.childTrueMicroFamilyId;
    const parentTrueMicroFamilyId = taxonomy.parentTrueMicroFamilyId;


    const baseDefinitionParts = buildMicroDefinitionParts(sideSafeMetrics, parent,
taxonomy);


    const executionFingerprintParts = shouldBuildExecutionFingerprintMetadata()
         ? buildExecutionFingerprintParts(sideSafeMetrics, parent, taxonomy)
         : [];


    const executionFingerprintHash = executionFingerprintParts.length
         ? stableHash(executionFingerprintParts.join('|'), EXECUTION_MICRO_HASH_LEN)
         : null;


    const liqDistancePct = getLiquidationDistancePct(sideSafeMetrics);


    const definitionParts = uniqueStrings([
  ...baseDefinitionParts,
  `liqDistanceMetadataOnly=${pctThreeTier(liqDistancePct, {
      prefix: 'LIQ_DIST',
      lowBps: 100,
      highBps: 500,
      lowLabel: 'NEAR',
      midLabel: 'MID',
      highLabel: 'FAR'
  })}`,
  `setupType=${taxonomy.setup}`,
  `regimeBucket=${taxonomy.regime}`,
  `confirmationProfile=${taxonomy.confirmationProfile}`,
  `analyzeMicroFamilyId=${analyzeMicroFamilyId}`,
  `trueMicroFamilyId=${analyzeMicroFamilyId}`,
  `childTrueMicroFamilyId=${analyzeMicroFamilyId}`,
  `parentTrueMicroFamilyId=${parentTrueMicroFamilyId}`,
  `coarseMicroFamilyId=${parentTrueMicroFamilyId}`,
  `learningGranularity=${LEARNING_GRANULARITY}`,
  `parentLearningGranularity=${PARENT_LEARNING_GRANULARITY}`,
  `trueMicroFamilySchema=${TRUE_MICRO_SCHEMA}`,
  `childTrueMicroFamilySchema=${CHILD_TRUE_MICRO_SCHEMA}`,
  `parentTrueMicroFamilySchema=${PARENT_TRUE_MICRO_SCHEMA}`,
  'learningIdentity=ANALYZE_TRUE_MICRO_FAMILY_FIXED_TAXONOMY_75_CHILD',
  'scannerFingerprintRole=METADATA_ONLY',
  'executionFingerprintRole=METADATA_ONLY',
  'currentFitPolarity=BULLISH_POSITIVE_BEARISH_NEGATIVE',
  'currentFitDefinition=LONG_MIRRORED_CURRENT_FIT',
  'riskGeometryRule=LONG:sl<entry<tp',
  'tpHitRule=LONG:price>=tp',
  'slHitRule=LONG:price<=sl'
]);


return {
  schema: TRUE_MICRO_SCHEMA,
  microFamilySchema: TRUE_MICRO_SCHEMA,
  legacyMicroFamilySchema: getMicroSchema(),
  trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
  childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
  broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
  parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
  version: 'child-fixed-taxonomy-75',


  familyId: parent.familyId,


  microFamilyId: analyzeMicroFamilyId,
  trueMicroFamilyId: analyzeMicroFamilyId,
  childTrueMicroFamilyId: analyzeMicroFamilyId,
    coarseMicroFamilyId: parentTrueMicroFamilyId,
    baseMicroFamilyId: parentTrueMicroFamilyId,
    legacyMicroFamilyId: parentTrueMicroFamilyId,


    parentTrueMicroFamilyId,
    parentMicroFamilyId: parentTrueMicroFamilyId,
    macroFamilyId: parentTrueMicroFamilyId,
    parentMacroFamilyId: parentTrueMicroFamilyId,


    analyzeMicroFamilyId,
    learningMicroFamilyId: analyzeMicroFamilyId,
    broadTrueMicroFamilyId: analyzeMicroFamilyId,
    fixedTaxonomyMicroFamilyId: analyzeMicroFamilyId,


    setupType: taxonomy.setup,
    regimeBucket: taxonomy.regime,
    confirmationProfile: taxonomy.confirmationProfile,


    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    learningHashInputParts: baseDefinitionParts,


    scannerMicroFamilyId: scannerMetadata.scannerMicroFamilyId,
    scannerFamilyId: scannerMetadata.scannerFamilyId,
    scannerDefinition: scannerMetadata.scannerDefinition,
    scannerDefinitionParts: scannerMetadata.scannerDefinitionParts,


    executionFingerprintHash,
    executionFingerprintParts,
    executionFingerprintSchema: executionFingerprintHash ? EXECUTION_MICRO_SUFFIX
: null,
    executionMicroFamilyId: executionFingerprintHash
      ?
`${analyzeMicroFamilyId}_${EXECUTION_MICRO_SUFFIX}_${executionFingerprintHash}`
      : null,
    executionFingerprintRole: 'METADATA_ONLY',


    parentDefinition: parent.definition,
    parentDefinitionParts: parent.definitionParts,
    macroFamilyDefinition: parent.definition,
    macroFamilyDefinitionParts: parent.definitionParts,


    definition: definitionParts.join(' | '),
    definitionParts,
    microDefinition: definitionParts.join(' | '),
    microDefinitionParts: definitionParts,
     side: TARGET_DASHBOARD_SIDE,
     tradeSide,
     positionSide: TARGET_TRADE_SIDE,
     direction: TARGET_TRADE_SIDE,


     targetTradeSide: TARGET_TRADE_SIDE,
     targetScannerSide: TARGET_SCANNER_SIDE,
     dashboardSide: TARGET_DASHBOARD_SIDE,


     assetClass: assetClass(sideSafeMetrics),


     obRelation: normalizeObRelation(sideSafeMetrics),
     btcRelation: btcRelation(TARGET_TRADE_SIDE, metrics.btcState),
     btcState: toUpper(metrics.btcState, 'NEUTRAL'),


     regime: coarseRegime(metrics.regime),
     regimeCoarse: coarseRegime(metrics.regime),


     flow: coarseFlow(metrics.flow),
     flowCoarse: coarseFlow(metrics.flow),


     scannerReason: coarseScannerReason(metrics.scannerReason),
     scannerReasonCoarse: coarseScannerReason(metrics.scannerReason),


     rsiZone: coarseRsi(metrics.rsiZone),
     rsiCoarse: coarseRsi(metrics.rsiZone),


     ...modeFlags(),


     isTrueMicro: true,
     trueMicro: true,
     isChildTrueMicro: true,
     selectable: true,
     selectionGranularity: 'EXACT_75_CHILD',
     isLegacyMacro: false,
     trueMicroOnly: true,
     exactTrueMicroOnly: true,
     fixedTaxonomyLearningId: true,
     parentSelectionAllowed: false,


     spreadBps: Number((safeNumber(getSpreadPct(metrics), 0) * 10000).toFixed(3)),
     entryDistanceBps: numericBps(getEntryDistancePct(metrics)),
     slDistanceBps: numericBps(getSlDistancePct(metrics)),
     tpDistanceBps: numericBps(getTpDistancePct(metrics)),
     liqDistanceBps: numericBps(getLiquidationDistancePct(metrics))
};
}


export function buildMicroFamily(metrics = {}, options = {}) {
    const sideSafeMetrics = assertLongOnly(metrics);
    const schema = toUpper(options.schema || options.version || getMicroSchema());


    if (
         schema === getMacroSchema() ||
         schema === PARENT_TRUE_MICRO_SCHEMA ||
         schema === 'V1' ||
         schema === 'MACRO' ||
         schema === 'PARENT'
    ) {
         return buildMicroFamilyV1(sideSafeMetrics);
    }


    return buildMicroFamilyV2(sideSafeMetrics);
}


export function buildMicroFamilyForSide(metrics = {}, side = TARGET_TRADE_SIDE,
options = {}) {
    const requestedSide = normalizeTradeSideValue(side);


    if (requestedSide !== TARGET_TRADE_SIDE) {
         throw new Error(`LONG_ONLY_MICRO_FAMILY_SYSTEM:${side}`);
    }


    return buildMicroFamily(
         {
              ...metrics,
              ...modeFlags()
         },
         options
    );
}


export function classifyMacroFamily(metrics = {}) {
    return buildMicroFamilyV1(metrics);
}


export function classifyMicroFamily(metrics = {}) {
    return buildMicroFamilyV2(metrics);
}


export function getMicroFamilyId(metrics = {}, options = {}) {
    return buildMicroFamily(metrics, options).microFamilyId;
}
export function getParentMacroFamilyId(metrics = {}) {
    return buildMicroFamilyV1(metrics).microFamilyId;
}


export function isMicroFamilyV1Id(id) {
    const value = String(id || '').toUpperCase();


    if (isScannerFamilyId(value)) return false;
    if (isFixedTaxonomyParentMicroId(value)) return true;
    if (isFixedTaxonomyChildMicroId(value)) return false;


    return (
         value.includes(`_${getMacroSchema()}_`) &&
         value.includes('MICRO_LONG_') &&
         !isExecutionFingerprintId(value)
    );
}


export function isMicroFamilyV2Id(id) {
    const value = String(id || '').toUpperCase();


    if (!validLearningId(value)) return false;
    if (isFixedTaxonomyChildMicroId(value)) return true;
    if (isFixedTaxonomyParentMicroId(value)) return false;


    return (
         value.includes(`_${getMicroSchema()}_`) &&
         value.includes('MICRO_LONG_') &&
         !isExecutionFingerprintId(value)
    );
}


export function isExecutionRefinedMicroFamilyId(id) {
    const value = String(id || '').toUpperCase();


    return (
         value.includes('MICRO_LONG_') &&
         !isScannerFamilyId(value) &&
         value.includes(`_${EXECUTION_MICRO_SUFFIX}_`)
    );
}


export function isScannerMicroFamilyId(id) {
    return isScannerFamilyId(id);
}
function temporalAttachmentMetadata(row = {}) {
  const hasCanonicalPosition = Boolean(String(row.canonicalPositionId || '').trim());
  const hasEntryTimestamp = Number.isFinite(Number(
    row.entryTs ?? row.openedAt ?? row.entryAt
  ));
  const entryContextExplicitlyImmutable = Boolean(
    row.entryContextImmutable === true ||
    row.entryTemporalContextImmutable === true ||
    row.entryTemporalContext?.immutable === true ||
    row.entryDecisionSnapshot?.entryTs
  );
  if ((hasCanonicalPosition && hasEntryTimestamp) || entryContextExplicitlyImmutable) {
    return {
      ...entryTemporalFields(row),
      entryContextImmutable: true,
      entryTemporalContextAuthoritative: true,
      scannerTemporalContextIsPreEntryMetadata: false
    };
  }
  const scannerTs = row.scannerContextTs ?? row.observedAt ?? row.snapshotTs ?? row.ts ?? Date.now();
  const context = buildTemporalContext(scannerTs);
  return {
    scannerTemporalContext: context,
    scannerContextTs: context.contextTs,
    scannerHourUtc: context.hourUtc,
    scannerDayOfWeekUtc: context.dayOfWeekUtc,
    scannerDayType: context.dayType,
    scannerIsWeekend: context.isWeekend,
    scannerSessionTags: [...context.sessionTags],
    scannerSessionBucket: context.primarySessionBucket,
    scannerSessionOverlap: context.sessionOverlap,
    scannerOffHours: context.offHours,
    scannerTemporalContextVersion: TEMPORAL_CONTEXT_VERSION,
    scannerTemporalContextIsPreEntryMetadata: true,
    entryTemporalContextAuthoritative: false,
    entryContextImmutable: false
  };
}

export function attachMicroFamilies(metrics = {}) {
  const sideSafeMetrics = assertLongOnly(metrics);
  const temporal = temporalAttachmentMetadata(sideSafeMetrics);

  const scannerMetadata = getScannerMetadata(sideSafeMetrics);
  const macro = buildMicroFamilyV1(sideSafeMetrics);
  const micro = buildMicroFamilyV2(sideSafeMetrics);


  return {
    ...metrics,
    ...temporal,


    side: micro.side,
    tradeSide: micro.tradeSide,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,


    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_SCANNER_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,
    actualScannerSide: TARGET_SCANNER_SIDE,
    analysisSide: TARGET_TRADE_SIDE,


    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,


    familyId: micro.familyId,


    macroFamilyId: micro.parentTrueMicroFamilyId,
    parentMacroFamilyId: micro.parentTrueMicroFamilyId,
    parentMicroFamilyId: micro.parentTrueMicroFamilyId,
    parentTrueMicroFamilyId: micro.parentTrueMicroFamilyId,


    microFamilyId: micro.microFamilyId,
    trueMicroFamilyId: micro.trueMicroFamilyId,
    childTrueMicroFamilyId: micro.childTrueMicroFamilyId,


    coarseMicroFamilyId: micro.coarseMicroFamilyId,
    baseMicroFamilyId: micro.baseMicroFamilyId,
    legacyMicroFamilyId: micro.legacyMicroFamilyId,


    analyzeMicroFamilyId: micro.analyzeMicroFamilyId,
    learningMicroFamilyId: micro.learningMicroFamilyId,
    broadTrueMicroFamilyId: micro.broadTrueMicroFamilyId,
    fixedTaxonomyMicroFamilyId: micro.fixedTaxonomyMicroFamilyId,


    setupType: micro.setupType,
    regimeBucket: micro.regimeBucket,
    confirmationProfile: micro.confirmationProfile,


    learningGranularity: micro.learningGranularity,
    parentLearningGranularity: micro.parentLearningGranularity,
    learningHashInputParts: micro.learningHashInputParts,


    scannerMicroFamilyId: scannerMetadata.scannerMicroFamilyId ||
micro.scannerMicroFamilyId,
    scannerFamilyId: scannerMetadata.scannerFamilyId || micro.scannerFamilyId,
    scannerDefinition: scannerMetadata.scannerDefinition ||
micro.scannerDefinition,
    scannerDefinitionParts: scannerMetadata.scannerDefinitionParts?.length
      ? scannerMetadata.scannerDefinitionParts
      : micro.scannerDefinitionParts,


    executionFingerprintHash: micro.executionFingerprintHash,
    executionFingerprintParts: micro.executionFingerprintParts,
    executionFingerprintSchema: micro.executionFingerprintSchema,
    executionMicroFamilyId: micro.executionMicroFamilyId,
    executionFingerprintRole: 'METADATA_ONLY',


    schema: micro.schema,
    microFamilySchema: micro.microFamilySchema,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,


    microFamilyDefinition: micro.definition,
    microFamilyDefinitionParts: micro.definitionParts,


    macroFamilyDefinition: macro.definition,
    macroFamilyDefinitionParts: macro.definitionParts,
    parentDefinition: macro.definition,
    parentDefinitionParts: macro.definitionParts,


    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,


    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,
    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    exactTrueMicroFamilyRequired: true,
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,


    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    fixedTaxonomyLearningId: true,


    selectable: true,
    selectionGranularity: 'EXACT_75_CHILD',
    parentSelectionAllowed: false,


    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,


    defaultRanking:
'dashboardBalancedScore|balancedScore|fairWinrate|totalR|avgR|avgCostR',
    bareWinrateRankingDisabled: true,


    bucketGranularity: 'LOW_MID_HIGH',
    bucketsCoarseOnly: true,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,


    riskTradeSide: TARGET_TRADE_SIDE,
    riskGeometryRule: 'LONG: sl < entry < tp',
    tpHitRule: 'LONG: price >= tp',
    slHitRule: 'LONG: price <= sl',
    grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
    currentRFormula: '(currentPrice - entry) / (entry - initialSl)',


    currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
    currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,


    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
         persistentLearningKey: PERSISTENT_LEARNING_KEY,
         redisKeysSeparatedFromShortRoot: true,
         shortRootTouched: false,


         virtualOnly: true,
         virtualLearning: true,
         virtualTracked: true,
         shadowOnly: true,


         realTrade: false,
         realOrder: false,
         exchangeOrder: false,
         bitgetOrderPlaced: false,
         noRealOrders: true,
         realOrdersDisabled: true,
         exchangeOrdersDisabled: true,
         bitgetOrdersDisabled: true,
         exchangeCallsDisabled: true,
         noExchangeOrders: true
    };
}


export function attachMicroFamiliesForBothSides(metrics = {}) {
    const long = attachMicroFamilies({
         ...metrics,
         ...modeFlags()
    });


    return {
         long,
         short: null
    };
}
