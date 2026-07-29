// ================= FILE: scripts/freezeWeekly.js =================


import { CONFIG } from '../src/config.js';
import { KEYS } from '../src/keys.js';
import {
  getDurableRedis,
  getJson,
  setJson
} from '../src/redis.js';
import { freezeWeeklyRotation } from '../src/analyze/rotationEngine.js';


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
const WEEKEND_POLICY_VERSION =
  'LONG_WEEKEND_OBSERVE_DISCORD_BLOCK_V1';
const SESSION_POLICY_VERSION =
  'LONG_SESSION_OBSERVE_V1';
const WEEKEND_MODE = 'OBSERVE';
const SESSION_MODE = 'OBSERVE';

const UTC_DAY_NAMES = Object.freeze([
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY'
]);



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
const LONG_FIXED_CONFIRMATION_PROFILES = new Set([
    'A_STRONG_ALIGN',
    'B_FLOW_ALIGN',
    'C_VOLUME_ALIGN',
    'D_MIXED_OK',
    'E_WEAK_CONTRA'
]);


function now() {
    return Date.now();
}


function normalizeTimestampMs(value, fallback = now()) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return numeric < 10_000_000_000 ? Math.floor(numeric * 1000) : Math.floor(numeric);
}

function buildTemporalContext(timestamp = now()) {
  const contextTs = normalizeTimestampMs(timestamp, now());
  const date = new Date(contextTs);
  const hourUtc = date.getUTCHours();
  const dayIndex = date.getUTCDay();
  const dayOfWeekUtc = UTC_DAY_NAMES[dayIndex] || 'UNKNOWN';
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

function temporalPolicyForContext(context = buildTemporalContext()) {
  return {
    weekendPolicyVersion: WEEKEND_POLICY_VERSION,
    sessionPolicyVersion: SESSION_POLICY_VERSION,
    weekendMode: WEEKEND_MODE,
    sessionMode: SESSION_MODE,

    weekendLearningAllowed: true,
    weekendVirtualEntryAllowed: true,
    weekendDiscordEntryAllowed: !Boolean(context.isWeekend),
    weekendExitMonitoringAllowed: true,
    weekendOutcomeRecordingAllowed: true,

    sessionLearningAllowed: true,
    sessionVirtualEntryAllowed: true,
    sessionDiscordEntryAllowed: true,
    sessionPolicyObservedOnly: true
  };
}

function runtimeTemporalFlags(timestamp = now()) {
  const context = buildTemporalContext(timestamp);
  return {
    ...context,
    ...temporalPolicyForContext(context)
  };
}



function argv() {
    return process.argv.slice(2);
}


function getArgValue(name) {
    const prefix = `--${name}=`;
    const match = process.argv.find((arg) => arg.startsWith(prefix));


    if (!match) return null;


    return match.slice(prefix.length).trim() || null;
}


function hasFlag(name) {
    return process.argv.includes(`--${name}`);
}


function firstValue(...values) {
    for (const value of values) {
        if (value !== undefined && value !== null && value !== '') return value;
    }


    return null;
}


function namespacedLongKey(key, fallback = null) {
    const raw = String(key || fallback || '').trim();


    if (!raw) return null;
    if (raw.startsWith(LONG_KEY_PREFIX)) return raw;


    return `${LONG_KEY_PREFIX}${raw}`;
}
const LONG_KEYS = {
     analyze: {
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
         )
     }
};


function activeRotationKey() {
     return LONG_KEYS.analyze.activeRotation;
}


function nextRotationKey() {
     return LONG_KEYS.analyze.nextRotation;
}


function rotationValidFromKey() {
     return LONG_KEYS.analyze.rotationValidFrom;
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


function asRows(value) {
    return Array.isArray(value) ? value : [];
}


function upper(value) {
    return String(value || '').trim().toUpperCase();
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
      text.includes(' LONG ') ||
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
         text.includes(' SHORT ') ||
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


function inferTradeSideFromText(value = '') {
    const text = cleanSideText(value);


    if (!text) return 'UNKNOWN';


    const longHit = hasLongSignal(text);
    const shortHit = hasShortSignal(text);


    if (longHit && !shortHit) return TARGET_TRADE_SIDE;
    if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;


    if (longHit && shortHit) {
        if (text.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
        if (text.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
        if (text.includes('TRADE_SIDE=LONG') || text.includes('TRADESIDE=LONG'))
return TARGET_TRADE_SIDE;
        if (text.includes('TRADE_SIDE=SHORT') || text.includes('TRADESIDE=SHORT'))
return OPPOSITE_TRADE_SIDE;
    }


    return 'UNKNOWN';
}


function normalizeTradeSide(value) {
    const raw = cleanSideText(value);


    if (['LONG', 'BULL', 'BULLISH', 'BUY', 'DOWN', 'DOWNSIDE'].includes(raw))
return TARGET_TRADE_SIDE;
    if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'UP', 'UPSIDE'].includes(raw)) return
OPPOSITE_TRADE_SIDE;


    return inferTradeSideFromText(raw);
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
    if (confirmation && !LONG_FIXED_CONFIRMATION_PROFILES.has(confirmation)) return
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


function isFixedLongParentMicroId(id = '') {
    return parseFixedLongTaxonomyId(id)?.isParent === true;
}


function isFixedLongChildMicroId(id = '') {
    return parseFixedLongTaxonomyId(id)?.isChild === true;
}


function parentTrueMicroFamilyIdFromChild(id = '') {
    const parsed = parseFixedLongTaxonomyId(id);


    return parsed?.isChild ? parsed.parentTrueMicroFamilyId : null;
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


function isSelectableLongChildMicroId(id = '') {
    const value = String(id || '').trim();


    if (!validLearningId(value)) return false;
    if (inferTradeSideFromText(value) === OPPOSITE_TRADE_SIDE) return false;


    return isFixedLongChildMicroId(value);
}


function isParentContextId(id = '') {
    const value = String(id || '').trim();


    if (!validLearningId(value)) return false;
    if (inferTradeSideFromText(value) === OPPOSITE_TRADE_SIDE) return false;


    return isFixedLongParentMicroId(value);
}


function modeFlags() {
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
shadowOnly: true,
virtualOutcomesIncluded: true,
shadowOutcomesIncluded: true,
realOutcomesExcluded: true,
learningOutcomesOnly: true,
outcomesSourceMode: 'VIRTUAL_AND_SHADOW_NET_OUTCOMES',
outcomeSource: 'VIRTUAL',


freezeOnly: true,
nextRotationOnly: true,
activeRotationPreserved: true,
manualSelectionPreserved: true,
activeOverwriteDisabled: true,


autoRotation: false,
autoRotationDisabled: true,
autoActivationDisabled: true,
autoRotationActivationDisabled: true,
activateNextRotationDisabled: true,
activateFreezeCronDisabled: true,
resetCronDisabled: true,


noRealOrders: true,
realOrdersDisabled: true,
exchangeOrdersDisabled: true,
bitgetOrdersDisabled: true,
exchangeCallsDisabled: true,


manualSelectionOnly: true,
manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
discordOnlyForSelectedMicroFamilies: true,
discordOnlyForManualSelection: true,
discordOnlyForExactTrueMicroMatch: true,


trueMicroOnly: true,
exactTrueMicroOnly: true,
exactTrueMicroFamilyRequired: true,
trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
learningGranularity: LEARNING_GRANULARITY,
parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
selectionGranularity: SELECTION_GRANULARITY,


parentLearningEnabled: true,
childLearningEnabled: true,
parentIsContextOnly: true,
parentMatchDoesNotTriggerDiscord: true,
macroMatchDoesNotTriggerDiscord: true,
macroActivationExpansionDisabled: true,


observationFirst: true,
observationFirstAnalyze: true,


scannerFingerprintRole: 'METADATA_ONLY',
scannerFingerprintsMetadataOnly: true,
scannerFingerprintsUsedAsLearningFamily: false,


executionFingerprintRole: 'METADATA_ONLY',
executionFingerprintsMetadataOnly: true,
executionFingerprintsUsedAsLearningFamily: false,


analyzeMicroFamiliesOnly: true,
learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
symbolExcludedFromFamilyId: true,


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
      EARLY_OUTCOMES: `completed > 0 && completed < ${MIN_COMPLETED_ACTIVE_LEARNING}`,
      ACTIVE_LEARNING: `completed >= ${MIN_COMPLETED_ACTIVE_LEARNING} && completed < ${EMPIRICAL_VETO_MIN_COMPLETED}`,
      PASSED: `completed >= ${EMPIRICAL_VETO_MIN_COMPLETED} && avgR > ${EMPIRICAL_VETO_MAX_AVG_R}`,
      EMPIRICAL_VETO: `completed >= ${EMPIRICAL_VETO_MIN_COMPLETED} && avgR <= ${EMPIRICAL_VETO_MAX_AVG_R}`
    },
    activationGateRules: {
      OBSERVING: `completed < ${EMPIRICAL_VETO_MIN_COMPLETED}`,
      PASSED: `completed >= ${EMPIRICAL_VETO_MIN_COMPLETED} && avgR > ${EMPIRICAL_VETO_MAX_AVG_R}`,
      EMPIRICAL_VETO: `completed >= ${EMPIRICAL_VETO_MIN_COMPLETED} && avgR <= ${EMPIRICAL_VETO_MAX_AVG_R}`
    },


    rankingPolicy: 'balancedScore|fairWinrate|totalR|avgR|avgCostR',
    defaultRanking:
'dashboardBalancedScore|balancedScore|fairWinrate|totalR|avgR|avgCostR',
    bareWinrateRankingDisabled: true,


    globalMaxOpenPositionsBlockDisabled: true,
    maxOneOpenPositionPerSymbol: true,
    positionTimeStopMinDefault: DEFAULT_POSITION_TIME_STOP_MIN,


    validLongRiskShape: 'entry > 0 && sl < entry && tp > entry',
    longRiskShape: 'sl < entry < tp',
    riskTradeSide: TARGET_TRADE_SIDE,
    riskGeometryRule: 'LONG: sl < entry < tp',
    tpRule: 'price >= tp',
    slRule: 'price <= sl',
    tpHitRule: 'LONG: price >= tp',
    slHitRule: 'LONG: price <= sl',
    longExitRules: {
         tp: 'price >= tp',
         sl: 'price <= sl',
         timeStop: 'TIME_STOP'
    },
    longGrossRFormula: '(exitPrice - entry) / (entry - initialSl)',
    longCurrentRFormula: '(currentPrice - entry) / (entry - initialSl)',
    grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
    currentRFormula: '(currentPrice - entry) / (entry - initialSl)',


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


         persistentLearningKey: PERSISTENT_LEARNING_KEY,
         weekResetDisabled: true,
         isoWeekLearningDisabled: true,


         redisNamespace: LONG_NAMESPACE,
         redisKeyPrefix: LONG_KEY_PREFIX,
         redisKeysSeparatedFromShortRoot: true,
         shortRootTouched: false,


         longKeys: {
             activeRotation: activeRotationKey(),
             nextRotation: nextRotationKey(),
             rotationValidFrom: rotationValidFromKey()
         }
    };
}


function microId(row = {}) {
    return (
         row?.trueMicroFamilyId ||
         row?.microFamilyId ||
         row?.learningMicroFamilyId ||
         row?.analyzeMicroFamilyId ||
         row?.liveMicroFamilyId ||
         row?.realMicroFamilyId ||
         row?.id ||
         row?.key ||
         null
    );
}


function parentId(row = {}) {
    const id = microId(row);


    return (
         row?.parentTrueMicroFamilyId ||
         row?.parentMicroFamilyId ||
         row?.parentMacroFamilyId ||
         row?.coarseMicroFamilyId ||
         row?.macroFamilyId ||
         row?.parentFamilyId ||
         row?.macroId ||
         parentTrueMicroFamilyIdFromChild(id) ||
         null
    );
}


function familyId(row = {}) {
    return (
         row?.familyId ||
         row?.family ||
         row?.baseFamilyId ||
         null
    );
}


function definitionHaystack(row = {}) {
    return [
         row.familyId,
         row.family,
         row.baseFamilyId,


         row.trueMicroFamilyId,
         row.microFamilyId,
         row.learningMicroFamilyId,
         row.analyzeMicroFamilyId,
         row.liveMicroFamilyId,
         row.realMicroFamilyId,
         row.executionMicroFamilyId,
         row.coarseMicroFamilyId,
         row.parentTrueMicroFamilyId,
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
         .map((value) => cleanSideText(value))
         .filter(Boolean)
         .join('|');
}


function inferRowTradeSide(row = {}) {
    if (typeof row === 'string') {
         return inferTradeSideFromText(row);
    }


    if (!row || typeof row !== 'object') {
         return 'UNKNOWN';
    }


    const direct = normalizeTradeSide(
         row.tradeSide ||
         row.side ||
         row.positionSide ||
         row.direction ||
         row.signalSide ||
         row.scannerSide ||
         row.actualScannerSide ||
         row.analysisSide ||
         row.entrySide ||
         row.bias ||
         row.marketBias
    );


    if (direct === TARGET_TRADE_SIDE || direct === OPPOSITE_TRADE_SIDE) {
         return direct;
    }


    const haystackSide = inferTradeSideFromText(definitionHaystack(row));


    if (haystackSide === TARGET_TRADE_SIDE || haystackSide === OPPOSITE_TRADE_SIDE)
{
         return haystackSide;
    }


    if (row.longOnly === true || row.shortDisabled === true) {
         return TARGET_TRADE_SIDE;
    }


    if (row.shortOnly === true || row.longDisabled === true) {
         return OPPOSITE_TRADE_SIDE;
    }


    return 'UNKNOWN';
}


function completedCount(row = {}) {
    const explicit = Number(row.completed);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;


    const outcomeSample = Number(row.outcomeSample);
    if (Number.isFinite(outcomeSample) && outcomeSample > 0) return outcomeSample;


    const virtualCompleted = Number(row.virtualCompleted || 0);
    const shadowCompleted = Number(row.shadowCompleted || 0);


    if (Number.isFinite(virtualCompleted + shadowCompleted) && virtualCompleted +
shadowCompleted > 0) {
        return virtualCompleted + shadowCompleted;
    }


    const wins = Number(row.wins || 0);
    const losses = Number(row.losses || 0);
    const flats = Number(row.flats || 0);


    return wins + losses + flats;
}


function avgROf(row = {}) {
    const value = Number(
         row.longAvgR ??
         row.avgLongR ??
         row.avgR ??
         row.avgNetR ??
         row.netAvgR ??
         0
    );


    return Number.isFinite(value) ? value : 0;
}


function learningStatusFromCompleted(completed, avgR = 0) {
    if (completed >= EMPIRICAL_VETO_MIN_COMPLETED) {
         return Number(avgR) > EMPIRICAL_VETO_MAX_AVG_R
           ? 'PASSED'
           : 'EMPIRICAL_VETO';
    }
    if (completed >= MIN_COMPLETED_ACTIVE_LEARNING) return 'ACTIVE_LEARNING';
    if (completed > 0) return 'EARLY_OUTCOMES';


    return 'OBSERVING';
}


function isLongChildRow(row = {}) {
    const id = upper(microId(row));


    if (!id) return false;
    if (!isSelectableLongChildMicroId(id)) return false;
    if (inferRowTradeSide(row) === OPPOSITE_TRADE_SIDE) return false;


    return true;
}


function forceLongRow(row = {}, index = 0) {
    const trueMicroFamilyId = upper(microId(row));
    const parentTrueMicroFamilyId = upper(parentId(row) ||
parentTrueMicroFamilyIdFromChild(trueMicroFamilyId));
  const completed = completedCount(row);
  const learningStatus = learningStatusFromCompleted(completed, avgROf(row));


  return {
    ...row,


    rank: Number.isFinite(Number(row.rank))
        ? Number(row.rank)
        : index + 1,


    ...modeFlags(),


    microFamilyId: trueMicroFamilyId,
    trueMicroFamilyId,
    analyzeMicroFamilyId: row.analyzeMicroFamilyId || trueMicroFamilyId,
    learningMicroFamilyId: row.learningMicroFamilyId || trueMicroFamilyId,


    parentTrueMicroFamilyId,
    parentMicroFamilyId: row.parentMicroFamilyId || parentTrueMicroFamilyId ||
null,
    parentMacroFamilyId: row.parentMacroFamilyId || parentTrueMicroFamilyId ||
null,
    macroFamilyId: row.macroFamilyId || parentTrueMicroFamilyId || null,
    coarseMicroFamilyId: row.coarseMicroFamilyId || parentTrueMicroFamilyId ||
null,


    familyId: familyId(row),


    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,


    completed,
    outcomeSample: completed,


    learningStatus,
    status: learningStatus,
    tooEarly: completed < MIN_COMPLETED_ACTIVE_LEARNING,
    tooEarlyReason: completed < MIN_COMPLETED_ACTIVE_LEARNING
        ? `completed ${completed}/${MIN_COMPLETED_ACTIVE_LEARNING}`
        : null,


    realCompleted: 0,
         realWins: 0,
         realLosses: 0,
         realFlats: 0,
         realTotalR: 0,


         avgR: Number(row.longAvgR ?? row.avgLongR ?? row.avgR ?? row.avgNetR ??
row.netAvgR ?? 0),
         totalR: Number(row.longTotalR ?? row.totalLongR ?? row.totalR ??
row.netTotalR ?? row.totalNetR ?? 0),
         avgCostR: Number(row.avgCostR ?? row.costR ?? row.totalCostR ?? 0),


         fairWinrate: Number(row.fairWinrate ?? row.sampleAdjustedWinrate ??
row.wilsonLowerBound ?? row.bayesianWinrate ?? 0),
         dashboardBalancedScore: Number(row.dashboardBalancedScore ?? row.balancedScore
?? row.learningQualityRank ?? 0),


         scannerFingerprintRole: 'METADATA_ONLY',
         scannerFingerprintsMetadataOnly: true,
         scannerFingerprintsUsedAsLearningFamily: false,


         executionFingerprintRole: 'METADATA_ONLY',
         executionFingerprintsMetadataOnly: true,
         executionFingerprintsUsedAsLearningFamily: false,


         bestShort: null,
         preservedOppositeRow: null
    };
}


function buildManualRow(id, index = 0) {
    const trueMicroFamilyId = upper(id);
    const parentTrueMicroFamilyId =
parentTrueMicroFamilyIdFromChild(trueMicroFamilyId);


    return forceLongRow({
         rank: index + 1,


         microFamilyId: trueMicroFamilyId,
         trueMicroFamilyId,
         analyzeMicroFamilyId: trueMicroFamilyId,
         learningMicroFamilyId: trueMicroFamilyId,


         parentTrueMicroFamilyId,
         parentMicroFamilyId: parentTrueMicroFamilyId,
         parentMacroFamilyId: parentTrueMicroFamilyId,
         macroFamilyId: parentTrueMicroFamilyId,
         coarseMicroFamilyId: parentTrueMicroFamilyId,
      familyId: null,


      source: 'CLI_WEEKLY_FREEZE_STORED_75_CHILD_ID_ONLY',


      seen: 0,
      observations: 0,
      completed: 0,
      outcomeSample: 0,
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


      definitionParts: [
           `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
           `TRUE_MICRO_SCHEMA=${TRUE_MICRO_SCHEMA}`,
           `PARENT_TRUE_MICRO_SCHEMA=${PARENT_TRUE_MICRO_SCHEMA}`,
           'STORED_ID_ONLY=true',
           'EXACT_75_CHILD=true'
      ],
      definition: [
           `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
           `TRUE_MICRO_SCHEMA=${TRUE_MICRO_SCHEMA}`,
           `PARENT_TRUE_MICRO_SCHEMA=${PARENT_TRUE_MICRO_SCHEMA}`,
           'STORED_ID_ONLY=true',
           'EXACT_75_CHILD=true'
      ].join(' | ')
    }, index);
}


function unwrapRotation(result = {}) {
    return (
      result?.nextRotation ||
      result?.rotation ||
      result?.result?.nextRotation ||
      result?.result?.rotation ||
      result?.result?.result?.nextRotation ||
      result?.result?.result?.rotation ||
         null
    );
}


function sanitizeRotation(rotation = {}) {
    if (!rotation || typeof rotation !== 'object') {
         return null;
    }


    const rawRows = asRows(rotation.microFamilies);
    const rowsById = new Map();


    for (const row of rawRows) {
         if (!isLongChildRow(row)) continue;


         const id = upper(microId(row));
         const normalized = forceLongRow(row, rowsById.size);


         rowsById.set(id, normalized);
    }


    const explicitChildIds = uniqueStrings([
         rotation.microFamilyIds || [],
         rotation.activeMicroFamilyIds || [],
         rotation.trueMicroFamilyIds || [],
         rotation.ids || [],
         rotation.selectedMicroFamilyId,
         rotation.selectedTrueMicroFamilyId
    ])
         .map(upper)
         .filter(isSelectableLongChildMicroId);


    for (const id of explicitChildIds) {
         if (rowsById.has(id)) continue;


         rowsById.set(id, buildManualRow(id, rowsById.size));
    }


    const microFamilies = [...rowsById.values()]
         .map((row, index) => forceLongRow({
           ...row,
           rank: index + 1
         }, index));


    const microFamilyIds = uniqueStrings([
         explicitChildIds,
         microFamilies.map(microId)
  ])
       .map(upper)
       .filter(isSelectableLongChildMicroId);


  const parentTrueMicroFamilyIds = uniqueStrings([
       rotation.parentTrueMicroFamilyIds || [],
       microFamilies.map(parentId),
       microFamilyIds.map(parentTrueMicroFamilyIdFromChild)
  ])
       .map(upper)
       .filter(isParentContextId);


  const bestLongRaw =
       rotation.bestLong ||
       microFamilies.find((row) => isLongChildRow(row)) ||
       null;


  const bestLong = bestLongRaw
       ? forceLongRow(bestLongRaw, 0)
       : null;


  const empty = microFamilyIds.length === 0 && microFamilies.length === 0;


  return {
       ...rotation,


       source: rotation.source ||
'CLI_WEEKLY_FREEZE_NEXT_ROTATION_LONG_75_CHILD_ONLY',
       mode: rotation.mode || getMode(),
       sideMode: 'long_only',


       ...modeFlags(),


       trueMicroOnly: true,
       exactTrueMicroOnly: true,
       exactTrueMicroFamilyOnly: true,


       bestLong,
       bestShort: null,
       preservedOppositeRow: null,


       microFamilyIds,
       activeMicroFamilyIds: microFamilyIds,
       trueMicroFamilyIds: microFamilyIds,


       parentTrueMicroFamilyIds,
       parentMicroFamilyIds: parentTrueMicroFamilyIds,
         parentMacroFamilyIds: parentTrueMicroFamilyIds,


         macroFamilyIds: [],
         activeMacroFamilyIds: [],


         microFamilies,


         count: microFamilyIds.length || microFamilies.length,
         activeCount: microFamilyIds.length || microFamilies.length,
         microCount: microFamilyIds.length,
         trueMicroCount: microFamilyIds.length,
         childCount: microFamilyIds.length,
         parentContextCount: parentTrueMicroFamilyIds.length,
         macroCount: 0,
         legacyMacroCount: 0,


         rawMicroFamiliesCount: rawRows.length,
         ignoredShortMicroFamilies: rawRows.filter((row) => inferRowTradeSide(row) ===
OPPOSITE_TRADE_SIDE).length,
         ignoredParentOnlyRows: rawRows.filter((row) =>
isFixedLongParentMicroId(microId(row))).length,
         ignoredScannerFingerprintRows: rawRows.filter((row) =>
isScannerFingerprintId(microId(row))).length,
         ignoredExecutionFingerprintRows: rawRows.filter((row) =>
isExecutionFingerprintId(microId(row))).length,


         empty,
         emptyReason: empty
           ? rotation.emptyReason ||
'NO_LONG_75_CHILD_TRUE_MICRO_FAMILIES_FOR_NEXT_ROTATION'
           : rotation.emptyReason || null,


         missingSides: empty ? [TARGET_TRADE_SIDE] : []
    };
}


function extractMicroFamilyIds(rotation = {}) {
    const sanitized = sanitizeRotation(rotation);


    if (!sanitized) return [];


    return uniqueStrings([
         sanitized.microFamilyIds || [],
         sanitized.activeMicroFamilyIds || [],
         sanitized.trueMicroFamilyIds || [],
         asRows(sanitized.microFamilies).map(microId),
         sanitized.bestLong ? microId(sanitized.bestLong) : null,
         sanitized.selectedRow ? microId(sanitized.selectedRow) : null
    ])
         .map(upper)
         .filter(isSelectableLongChildMicroId);
}


function extractParentTrueMicroFamilyIds(rotation = {}) {
    const sanitized = sanitizeRotation(rotation);


    if (!sanitized) return [];


    return uniqueStrings([
         sanitized.parentTrueMicroFamilyIds || [],
         asRows(sanitized.microFamilies).map(parentId),
         extractMicroFamilyIds(sanitized).map(parentTrueMicroFamilyIdFromChild),
         sanitized.bestLong ? parentId(sanitized.bestLong) : null,
         sanitized.selectedRow ? parentId(sanitized.selectedRow) : null
    ])
         .map(upper)
         .filter(isParentContextId);
}


function getResultWeekKey(result, fallback = null) {
    const rotation = sanitizeRotation(unwrapRotation(result) || {});


    return (
         result?.weekKey ||
         result?.sourceWeekKey ||
         rotation?.sourceWeekKey ||
         fallback ||
         PERSISTENT_LEARNING_KEY
    );
}


function getResultActiveWeekKey(result, fallback = null) {
    const rotation = sanitizeRotation(unwrapRotation(result) || {});


    return (
         result?.activeWeekKey ||
         rotation?.activeWeekKey ||
         fallback ||
         PERSISTENT_LEARNING_KEY
    );
}


function getResultRotationId(result = {}) {
    const rotation = sanitizeRotation(unwrapRotation(result) || {});
    return (
         result?.rotationId ||
         rotation?.rotationId ||
         null
    );
}


function getSelectedMicroCount(result = {}) {
    const rotation = sanitizeRotation(unwrapRotation(result) || {});
    const ids = extractMicroFamilyIds(rotation);


    return (
         result?.selectedMicroFamilies ||
         result?.selectedCount ||
         ids.length ||
         0
    );
}


function getSelectedParentContextCount(result = {}) {
    const rotation = sanitizeRotation(unwrapRotation(result) || {});
    const ids = extractParentTrueMicroFamilyIds(rotation);


    return ids.length || 0;
}


function getMode() {
    return String(
         getArgValue('mode') ||
         CONFIG.long?.rotation?.mode ||
         CONFIG.rotation?.longMode ||
         CONFIG.rotation?.mode ||
         'balanced'
    ).trim();
}


function getWeekKey() {
    return String(
         firstValue(
             getArgValue('weekKey'),
             getArgValue('week'),
             getArgValue('sourceWeekKey'),
             PERSISTENT_LEARNING_KEY
         )
    ).trim();
}
function getActiveWeekKey() {
    return String(
         firstValue(
              getArgValue('activeWeekKey'),
              getArgValue('nextWeekKey'),
              PERSISTENT_LEARNING_KEY
         )
    ).trim();
}


function buildRequestedOptions() {
    const weekKey = getWeekKey();
    const activeWeekKey = getActiveWeekKey();


    return {
         force: hasFlag('force'),


         weekKey,
         sourceWeekKey: weekKey,
         activeWeekKey,


         mode: getMode(),
         ...runtimeTemporalFlags(),


         disabledAutoFlagPresent: (
              hasFlag('activate') ||
              hasFlag('activateNext') ||
              hasFlag('activate-next') ||
              hasFlag('autoActivate') ||
              hasFlag('auto-activate')
         ),


         ...modeFlags()
    };
}


function buildFreezeOptions(requested = {}) {
    return {
         weekKey: requested.weekKey,
         sourceWeekKey: requested.sourceWeekKey,
         activeWeekKey: requested.activeWeekKey,
         mode: requested.mode,


         targetTradeSide: TARGET_TRADE_SIDE,
         dashboardSide: TARGET_DASHBOARD_SIDE,


         side: TARGET_DASHBOARD_SIDE,
tradeSide: TARGET_TRADE_SIDE,
positionSide: TARGET_TRADE_SIDE,
direction: TARGET_TRADE_SIDE,


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


keys: {
     activeRotation: activeRotationKey(),
     nextRotation: nextRotationKey(),
     rotationValidFrom: rotationValidFromKey()
},


freezeOnly: true,
nextRotationOnly: true,


activate: false,
activateNext: false,
activateNextRotation: false,
autoActivate: false,
doNotActivate: true,


preventActiveOverwrite: true,
preserveActiveRotation: true,
manualSelectionPreserved: true,
activeOverwriteDisabled: true,
autoActivationDisabled: true,


trueMicroOnly: true,
exactTrueMicroOnly: true,
exactTrueMicroFamilyOnly: true,
exactTrueMicroFamilyRequired: true,
trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
learningGranularity: LEARNING_GRANULARITY,
parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
selectionGranularity: SELECTION_GRANULARITY,


parentLearningEnabled: true,
childLearningEnabled: true,
parentIsContextOnly: true,
macroActivationExpansionDisabled: true,
parentMatchDoesNotTriggerDiscord: true,
macroMatchDoesNotTriggerDiscord: true,


virtualOnly: true,
virtualLearning: true,
virtualLearningForced: true,


noRealOrders: true,
realOrdersDisabled: true,
exchangeOrdersDisabled: true,
bitgetOrdersDisabled: true,
exchangeCallsDisabled: true,


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
currentFitBlocksVirtualLearning: false,
currentFitBlocksShadowLearning: false,


scannerFingerprintRole: 'METADATA_ONLY',
scannerFingerprintsMetadataOnly: true,
scannerFingerprintsUsedAsLearningFamily: false,


executionFingerprintRole: 'METADATA_ONLY',
executionFingerprintsMetadataOnly: true,
executionFingerprintsUsedAsLearningFamily: false,


analyzeMicroFamiliesOnly: true,
learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
         symbolExcludedFromFamilyId: true,


         rankingSource:
'dashboardBalancedScore|balancedScore|fairWinrate|totalR|avgR|avgCostR',
         rankingPolicy: 'balancedScore|fairWinrate|totalR|avgR|avgCostR',
         scoringRSource: 'netR',
         completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES'
    };
}


function stableStringify(value) {
    try {
         return JSON.stringify(value);
    } catch {
         return String(value);
    }
}


async function restoreActiveRotation(redis, activeBefore) {
    const key = activeRotationKey();
    const activeAfter = await getJson(redis, key, null).catch(() => null);


    const changed = stableStringify(activeBefore) !== stableStringify(activeAfter);


    if (activeBefore === null || activeBefore === undefined) {
         await redis.del(key).catch(() => null);


         return {
              activeRotationRestored: changed,
              activeRotationExistedBefore: false,
              activeRotationRemovedBecauseFreezeCreatedIt: activeAfter !== null &&
activeAfter !== undefined,
              key
         };
    }


    await setJson(redis, key, activeBefore).catch(() => null);


    return {
         activeRotationRestored: changed,
         activeRotationExistedBefore: true,
         activeRotationRemovedBecauseFreezeCreatedIt: false,
         key
    };
}


async function persistSanitizedNextRotation({
  redis,
  result,
  requested
}) {
  const rotationRaw =
       unwrapRotation(result) ||
       await getJson(redis, nextRotationKey(), null).catch(() => null);


  const nextRotation = sanitizeRotation({
       ...(rotationRaw || {}),
       sourceWeekKey: rotationRaw?.sourceWeekKey || requested.weekKey,
       activeWeekKey: rotationRaw?.activeWeekKey || requested.activeWeekKey,
       mode: rotationRaw?.mode || requested.mode
  });


  if (!nextRotation) {
       return {
            nextRotation: null,
            nextRotationPersisted: false
       };
  }


  await setJson(redis, nextRotationKey(), nextRotation);


  await setJson(redis, rotationValidFromKey(), {
       validFrom: requested.activeWeekKey,
       ts: now(),


       source: 'CLI_WEEKLY_FREEZE_NEXT_ONLY_ACTIVE_NOT_TOUCHED_LONG_75_CHILD_ONLY',


       sourceWeekKey: requested.weekKey,
       activeWeekKey: requested.activeWeekKey,
       mode: requested.mode,


       rotationId: nextRotation.rotationId || null,


       ...modeFlags(),


       selectedMicroFamilies: nextRotation.microFamilyIds.length,
       selectedTrueMicroFamilies: nextRotation.trueMicroFamilyIds.length,
       selectedParentContextFamilies: nextRotation.parentTrueMicroFamilyIds.length,
       selectedMacroFamilies: 0,


       bestLong: nextRotation.bestLong?.trueMicroFamilyId ||
nextRotation.bestLong?.microFamilyId || null,
       bestShort: null,
         missingSides: nextRotation.missingSides || []
    });


    return {
         nextRotation,
         nextRotationPersisted: true
    };
}


async function runFreeze(requested = {}) {
    const redis = getDurableRedis();
    const activeBefore = await getJson(redis, activeRotationKey(), null).catch(() =>
null);


    let rawResult = null;
    let activeProtection = null;


    try {
         rawResult = await freezeWeeklyRotation(
              buildFreezeOptions(requested)
         );
    } finally {
         activeProtection = await restoreActiveRotation(redis, activeBefore);
    }


    const {
         nextRotation,
         nextRotationPersisted
    } = await persistSanitizedNextRotation({
         redis,
         result: rawResult,
         requested
    });


    return {
         ...(rawResult && typeof rawResult === 'object' ? rawResult : {}),


         ok: rawResult?.ok !== false,
         type: rawResult?.type || 'WEEKLY_FREEZE_NEXT_ROTATION_ONLY_LONG_75_CHILD',


         ...modeFlags(),


         weekKey: requested.weekKey,
         sourceWeekKey: requested.sourceWeekKey,
         activeWeekKey: requested.activeWeekKey,
         mode: requested.mode,
         oldAutoFlagsIgnored: Boolean(requested.disabledAutoFlagPresent),


         rotationId: nextRotation?.rotationId || rawResult?.rotationId || null,


         selectedMicroFamilies: nextRotation?.microFamilyIds?.length || 0,
         selectedTrueMicroFamilies: nextRotation?.trueMicroFamilyIds?.length || 0,
         selectedParentContextFamilies: nextRotation?.parentTrueMicroFamilyIds?.length
|| 0,
         selectedMacroFamilies: 0,


         microFamilyIds: nextRotation?.microFamilyIds || [],
         activeMicroFamilyIds: nextRotation?.microFamilyIds || [],
         trueMicroFamilyIds: nextRotation?.microFamilyIds || [],


         parentTrueMicroFamilyIds: nextRotation?.parentTrueMicroFamilyIds || [],
         parentMicroFamilyIds: nextRotation?.parentTrueMicroFamilyIds || [],


         macroFamilyIds: [],
         activeMacroFamilyIds: [],


         empty: Boolean(nextRotation?.empty),
         emptyReason: nextRotation?.emptyReason || rawResult?.emptyReason ||
rawResult?.reason || null,


         nextRotation,
         rotation: nextRotation,
         nextRotationPersisted,


         activeProtection,


         longKeys: {
              activeRotation: activeRotationKey(),
              nextRotation: nextRotationKey(),
              rotationValidFrom: rotationValidFromKey()
         },


         result: rawResult
    };
}


function buildCliResponse({
    result,
    requested,
    startedAt
}) {
    const rotation = sanitizeRotation(
         result?.nextRotation ||
       unwrapRotation(result) ||
       {}
  );


  const microFamilyIds = extractMicroFamilyIds(rotation);
  const parentTrueMicroFamilyIds = extractParentTrueMicroFamilyIds(rotation);


  return {
       ok: result?.ok !== false,


       source: 'CLI_FREEZE_WEEKLY_NEXT_ROTATION_LONG_75_CHILD_ONLY',


       argv: argv(),
       requested,


       type: result?.type || 'WEEKLY_FREEZE_NEXT_ROTATION_ONLY_LONG_75_CHILD',


       ...modeFlags(),


       weekKey: getResultWeekKey(result, requested.weekKey || null),
       sourceWeekKey: getResultWeekKey(result, requested.sourceWeekKey || null),
       activeWeekKey: getResultActiveWeekKey(result, requested.activeWeekKey ||
null),


       mode: result?.mode || rotation?.mode || requested.mode,


       oldAutoFlagsIgnored: Boolean(requested.disabledAutoFlagPresent),


       rotationId: getResultRotationId(result),


       selectedMicroFamilies: getSelectedMicroCount(result),
       selectedTrueMicroFamilies: getSelectedMicroCount(result),
       selectedParentContextFamilies: getSelectedParentContextCount(result),
       selectedMacroFamilies: 0,


       microFamilyIds,
       activeMicroFamilyIds: microFamilyIds,
       trueMicroFamilyIds: microFamilyIds,


       parentTrueMicroFamilyIds,
       parentMicroFamilyIds: parentTrueMicroFamilyIds,


       macroFamilyIds: [],
       activeMacroFamilyIds: [],


       empty: Boolean(rotation?.empty || microFamilyIds.length === 0),
       emptyReason: rotation?.emptyReason || result?.emptyReason || result?.reason ||
null,


         eligibleCount: rotation?.eligibleCount ?? null,
         rankedCount: rotation?.rankedCount ?? null,
         allRankedCount: rotation?.allRankedCount ?? null,


         microCount: rotation?.microCount ?? microFamilyIds.length,
         trueMicroCount: rotation?.trueMicroCount ?? microFamilyIds.length,
         childCount: rotation?.childCount ?? microFamilyIds.length,
         parentContextCount: rotation?.parentContextCount ??
parentTrueMicroFamilyIds.length,
         macroCount: 0,
         legacyMacroCount: 0,


         trueMicroOnly: true,
         exactTrueMicroOnly: true,
         exactTrueMicroFamilyOnly: true,
         parentIsContextOnly: true,
         usedLegacyFallback: false,
         usedSoftFallback: Boolean(rotation?.usedSoftFallback),
         usedObservationFallback: Boolean(rotation?.usedObservationFallback),
         usedRawFallback: Boolean(rotation?.usedRawFallback),


         selectedTier: rotation?.selectedTier || null,
         missingSides: Array.isArray(rotation?.missingSides)
              ? rotation.missingSides.filter((side) => normalizeTradeSide(side) ===
TARGET_TRADE_SIDE)
              : microFamilyIds.length === 0
                ? [TARGET_TRADE_SIDE]
                : [],


         nextRotationPersisted: Boolean(result?.nextRotationPersisted),
         activeProtection: result?.activeProtection || null,


         longKeys: {
              activeRotation: activeRotationKey(),
              nextRotation: nextRotationKey(),
              rotationValidFrom: rotationValidFromKey()
         },


         durationMs: now() - startedAt,


         rotation,
         result
    };
}
function buildCliError({
    error,
    requested,
    startedAt
}) {
    return {
         ok: false,


         source: 'CLI_FREEZE_WEEKLY_NEXT_ROTATION_LONG_75_CHILD_ONLY',


         argv: argv(),
         requested,


         ...modeFlags(),


         weekKey: requested.weekKey || null,
         sourceWeekKey: requested.sourceWeekKey || null,
         activeWeekKey: requested.activeWeekKey || null,
         mode: requested.mode,


         error: error?.message || String(error),
         stack: error?.stack,


         durationMs: now() - startedAt
    };
}


async function main() {
    const startedAt = now();
    const requested = buildRequestedOptions();


    try {
         const result = await runFreeze(requested);


         const response = buildCliResponse({
           result,
           requested,
           startedAt
         });


         console.log(JSON.stringify(response, null, 2));


         process.exitCode = response.ok ? 0 : 1;
    } catch (error) {
         console.error(JSON.stringify(
           buildCliError({
               error,
              requested,
              startedAt
          }),
          null,
          2
        ));


        process.exitCode = 1;
    }
}


await main();
