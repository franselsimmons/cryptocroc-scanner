// ================= FILE: scripts/activateRotation.js =================


import { activateSelectedMicroFamilies } from '../src/analyze/rotationEngine.js';
import { getWeekMicros } from '../src/analyze/analyzeEngine.js';


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


function upper(value) {
    return String(value || '').trim().toUpperCase();
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


function parseIdList(value) {
    if (!value) return [];


    if (Array.isArray(value)) {
        return uniqueStrings(value.flatMap(parseIdList));
    }


    if (value && typeof value === 'object') {
        return parseIdList([
          value.trueMicroFamilyIds,
          value.activeMicroFamilyIds,
          value.microFamilyIds,
          value.ids,
          value.trueMicroFamilyId,
          value.microFamilyId,
          value.id,
          value.key
        ]);
    }


    return uniqueStrings(String(value));
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


function inferTradeSideFromId(id = '') {
    const text = cleanSideText(id);


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
    if (inferTradeSideFromId(value) === OPPOSITE_TRADE_SIDE) return false;


    return isFixedLongChildMicroId(value);
}


function isParentContextId(id = '') {
    const value = String(id || '').trim();


    if (!validLearningId(value)) return false;
    if (inferTradeSideFromId(value) === OPPOSITE_TRADE_SIDE) return false;


    return isFixedLongParentMicroId(value);
}


function normalizeManualMicroFamilyIds(ids = []) {
const requestedIds = uniqueStrings(ids);
const acceptedMicroFamilyIds = [];
const parentContextIds = [];
const ignoredIds = [];


for (const rawId of requestedIds) {
  const id = upper(rawId);
  const side = inferTradeSideFromId(id);


  if (isScannerFingerprintId(id)) {
      ignoredIds.push({
        id,
        side,
        reason: 'SCANNER_FINGERPRINT_METADATA_ONLY_NOT_SELECTABLE'
      });
      continue;
  }


  if (isExecutionFingerprintId(id)) {
      ignoredIds.push({
        id,
        side,
        reason: 'EXECUTION_FINGERPRINT_METADATA_ONLY_NOT_SELECTABLE'
      });
      continue;
  }


  if (side === OPPOSITE_TRADE_SIDE) {
      ignoredIds.push({
        id,
        side,
        reason: 'SHORT_DISABLED_LONG_ONLY'
      });
      continue;
  }


  if (isSelectableLongChildMicroId(id)) {
      acceptedMicroFamilyIds.push(id);
      parentContextIds.push(parentTrueMicroFamilyIdFromChild(id));
      continue;
  }


  if (isParentContextId(id)) {
      ignoredIds.push({
        id,
        side: TARGET_TRADE_SIDE,
        reason: 'PARENT_15_CONTEXT_ONLY_NOT_SELECTABLE_FOR_DISCORD'
             });
             continue;
         }


         ignoredIds.push({
             id,
             side,
             reason: 'INVALID_OR_NON_75_CHILD_TRUE_MICRO_FAMILY_ID'
         });
    }


    return {
         requestedMicroFamilyIds: requestedIds.map(upper),
         acceptedMicroFamilyIds:
uniqueStrings(acceptedMicroFamilyIds).filter(isSelectableLongChildMicroId),
         parentTrueMicroFamilyIds:
uniqueStrings(parentContextIds).filter(isParentContextId),


         ignoredIds,


         ignoredShortIds: ignoredIds
             .filter((row) => row.reason === 'SHORT_DISABLED_LONG_ONLY')
             .map((row) => row.id),


         ignoredParentOnlyIds: ignoredIds
             .filter((row) => row.reason ===
'PARENT_15_CONTEXT_ONLY_NOT_SELECTABLE_FOR_DISCORD')
             .map((row) => row.id),


         ignoredUnknownIds: ignoredIds
             .filter((row) => row.reason ===
'INVALID_OR_NON_75_CHILD_TRUE_MICRO_FAMILY_ID')
             .map((row) => row.id),


         ignoredScannerFingerprintIds: ignoredIds
             .filter((row) => row.reason ===
'SCANNER_FINGERPRINT_METADATA_ONLY_NOT_SELECTABLE')
             .map((row) => row.id),


         ignoredExecutionFingerprintIds: ignoredIds
             .filter((row) => row.reason ===
'EXECUTION_FINGERPRINT_METADATA_ONLY_NOT_SELECTABLE')
             .map((row) => row.id)
    };
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


function getRequestedActiveWeekKey(weekKey) {
    return String(
      firstValue(
          getArgValue('activeWeekKey'),
          getArgValue('nextWeekKey'),
          weekKey,
          PERSISTENT_LEARNING_KEY
      )
    ).trim();
}


function getMode() {
    return String(
      firstValue(
          getArgValue('mode'),
          'selected'
      )
    ).trim();
}


function getRequestedMicroFamilyIds() {
    return uniqueStrings([
      parseIdList(getArgValue('microFamilyIds')),
      parseIdList(getArgValue('activeMicroFamilyIds')),
      parseIdList(getArgValue('trueMicroFamilyIds')),
      parseIdList(getArgValue('ids')),
      parseIdList(getArgValue('id'))
    ]);
}


function hasDisabledAutoFlag() {
    return (
      hasFlag('build') ||
      hasFlag('activateBest') ||
      hasFlag('activate-best') ||
      hasFlag('buildFresh') ||
      hasFlag('build-fresh') ||
         hasFlag('autoBuildIfMissing') ||
         hasFlag('auto-build-if-missing') ||
         hasFlag('activateNext') ||
         hasFlag('activate-next') ||
         hasFlag('activateNextRotation') ||
         hasFlag('activate-next-rotation') ||
         hasFlag('autoActivate') ||
         hasFlag('auto-activate')
    );
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


         noRealOrders: true,
         realOrdersDisabled: true,
         exchangeOrdersDisabled: true,
         bitgetOrdersDisabled: true,
exchangeCallsDisabled: true,


manualSelectionOnly: true,
manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
exactTrueMicroFamilyRequired: true,
trueMicroOnly: true,
exactTrueMicroOnly: true,


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


discordOnlyForSelectedMicroFamilies: true,
discordOnlyForManualSelection: true,
discordOnlyForExactTrueMicroMatch: true,


autoRotation: false,
autoRotationDisabled: true,
autoRotationActivationDisabled: true,
activateNextDisabled: true,
buildFreshDisabled: true,
activateFreezeCronDisabled: true,
resetCronDisabled: true,


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
         shortRootTouched: false
    };
}


function buildRequestedOptions() {
    const weekKey = getWeekKey();
    const activeWeekKey = getRequestedActiveWeekKey(weekKey);
    const requestedMicroFamilyIds = getRequestedMicroFamilyIds();
    const normalized = normalizeManualMicroFamilyIds(requestedMicroFamilyIds);
    const mode = getMode();


    return {
         argv: argv(),


         weekKey,
         sourceWeekKey: weekKey,
         activeWeekKey,
         mode,
         ...runtimeTemporalFlags(),


         ...modeFlags(),


         manualOnly: true,
         adminSelected: true,
         discordOnly: true,


         requestedMicroFamilyIds: normalized.requestedMicroFamilyIds,


         microFamilyIds: normalized.acceptedMicroFamilyIds,
         activeMicroFamilyIds: normalized.acceptedMicroFamilyIds,
         trueMicroFamilyIds: normalized.acceptedMicroFamilyIds,
         acceptedMicroFamilyIds: normalized.acceptedMicroFamilyIds,


         parentTrueMicroFamilyIds: normalized.parentTrueMicroFamilyIds,


         ignoredIds: normalized.ignoredIds,
         ignoredShortIds: normalized.ignoredShortIds,
         ignoredParentOnlyIds: normalized.ignoredParentOnlyIds,
         ignoredUnknownIds: normalized.ignoredUnknownIds,
         ignoredScannerFingerprintIds: normalized.ignoredScannerFingerprintIds,
         ignoredExecutionFingerprintIds: normalized.ignoredExecutionFingerprintIds,


         disabledAutoFlagPresent: hasDisabledAutoFlag()
    };
}


function asRows(value) {
    return Array.isArray(value) ? value : [];
}


function sourceEntries(value = {}) {
    if (Array.isArray(value)) {
         return value.map((row, index) => [
           row?.trueMicroFamilyId ||
           row?.microFamilyId ||
           row?.id ||
           row?.key ||
           String(index),
           row
         ]);
    }


    if (value && typeof value === 'object') return Object.entries(value);
    return [];
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


function rawCompletedCount(row = {}) {
    const explicit = Number(
         row.completed ??
         row.outcomeSample ??
         row.virtualCompleted ??
         0
    );


    if (Number.isFinite(explicit) && explicit >= 0) return explicit;
    return completedCount(row);
}


function currentMeasurementCompletedCount(row = {}) {
    if (rowMeasurementFixVersion(row) !== MEASUREMENT_FIX_VERSION) return 0;


    const completed = rawCompletedCount(row);
    const accepted = Number(
         row.measurementVersionAcceptedOutcomeCount ??
         row.acceptedOutcomeCount ??
         completed
    );


    if (!Number.isFinite(accepted)) return completed;
    return Math.max(0, Math.min(completed, accepted));
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


function activationGateFor(row = {}) {
    const completed = currentMeasurementCompletedCount(row);
    if (completed < EMPIRICAL_VETO_MIN_COMPLETED) return 'OBSERVING';


    return avgROf(row) > EMPIRICAL_VETO_MAX_AVG_R
         ? 'PASSED'
         : 'EMPIRICAL_VETO';
}


function learningStatusFor(row = {}) {
    const completed = currentMeasurementCompletedCount(row);
    if (completed === 0) return 'OBSERVING';
    if (completed < MIN_COMPLETED_ACTIVE_LEARNING) return 'EARLY_OUTCOMES';
    if (completed < EMPIRICAL_VETO_MIN_COMPLETED) return 'ACTIVE_LEARNING';
    return activationGateFor(row);
}


async function loadLearningRowsForIds(ids = []) {
    const accepted = new Set(
         uniqueStrings(ids)
           .map(upper)
           .filter(isSelectableLongChildMicroId)
    );


    if (accepted.size <= 0) return [];


    const micros = await getWeekMicros(PERSISTENT_LEARNING_KEY).catch(() => ({}));
    const rows = [];


    for (const [key, rawRow] of sourceEntries(micros)) {
         const row = rawRow && typeof rawRow === 'object' ? rawRow : {};
         const id = upper(microId({ ...row, key }));


         if (!id || !accepted.has(id)) continue;
         if (!isSelectableLongChildMicroId(id)) continue;
         if (inferTradeSideFromId(id) === OPPOSITE_TRADE_SIDE) continue;


         rows.push({
           ...row,
           key,
           microFamilyId: id,
           trueMicroFamilyId: id,
           childTrueMicroFamilyId: id,
           parentTrueMicroFamilyId:
             upper(parentId(row) || parentTrueMicroFamilyIdFromChild(id)),
           sourceWeekKey: PERSISTENT_LEARNING_KEY,
           sourceWeekPrimary: true
         });
    }


    return rows;
}


async function filterPassedActivationIds(ids = []) {
    const requestedIds = uniqueStrings(ids)
         .map(upper)
         .filter(isSelectableLongChildMicroId);
    const rows = await loadLearningRowsForIds(requestedIds);
    const rowById = new Map(rows.map((row) => [upper(microId(row)), row]));
    const passedIds = [];
    const blocked = [];


    for (const id of requestedIds) {
         const row = rowById.get(id);
         const gate = row ? activationGateFor(row) : 'OBSERVING';


         if (row && gate === 'PASSED') {
           passedIds.push(id);
           continue;
         }


         blocked.push({
           id,
           reason: row ? gate : 'LEARNING_ROW_NOT_FOUND',
           measurementFixVersion: rowMeasurementFixVersion(row || {}),
           completed: currentMeasurementCompletedCount(row || {}),
           avgR: avgROf(row || {})
         });
    }


    return {
         requestedIds,
         passedIds,
         blocked,
         rows
    };
}


function unwrapActiveRotation(result = {}) {
    if (!result || typeof result !== 'object') return null;


    return (
         result.activeRotation ||
         result.active ||
         result.rotation ||
         result.result?.activeRotation ||
         result.result?.active ||
         result.result?.rotation ||
         result.result?.result?.activeRotation ||
         result.result?.result?.active ||
         result.result?.result?.rotation ||
         null
    );
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


function extractMicroFamilyIds(rotation = {}) {
    const rows = asRows(rotation?.microFamilies);


    return uniqueStrings([
         rotation?.microFamilyIds || [],
         rotation?.activeMicroFamilyIds || [],
         rotation?.trueMicroFamilyIds || [],
         rotation?.ids || [],
         rows.map(microId),
         rotation?.bestLong ? microId(rotation.bestLong) : null,
         rotation?.selectedRow ? microId(rotation.selectedRow) : null
    ])
         .map(upper)
         .filter(isSelectableLongChildMicroId);
}


function extractParentTrueMicroFamilyIds(rotation = {}) {
    const rows = asRows(rotation?.microFamilies);


    return uniqueStrings([
         rotation?.parentTrueMicroFamilyIds || [],
         rows.map(parentId),
         extractMicroFamilyIds(rotation).map(parentTrueMicroFamilyIdFromChild),
         rotation?.bestLong ? parentId(rotation.bestLong) : null,
         rotation?.selectedRow ? parentId(rotation.selectedRow) : null
    ])
         .map(upper)
         .filter(isParentContextId);
}


function buildManualRow(id, index = 0) {
    const parentTrueMicroFamilyId = parentTrueMicroFamilyIdFromChild(id);


    return {
         rank: index + 1,


         microFamilyId: id,
         trueMicroFamilyId: id,
         analyzeMicroFamilyId: id,
         learningMicroFamilyId: id,


         parentTrueMicroFamilyId,
         parentMicroFamilyId: parentTrueMicroFamilyId,
         parentMacroFamilyId: parentTrueMicroFamilyId,
         macroFamilyId: parentTrueMicroFamilyId,
coarseMicroFamilyId: parentTrueMicroFamilyId,


familyId: null,


...modeFlags(),


source: 'CLI_MANUAL_SELECTION_LONG_75_CHILD',
selectedTier: 'MANUAL',
rotationEligibilityTier: 'MANUAL',


manualOnly: true,
adminSelected: true,


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
virtualWins: 0,
virtualLosses: 0,
virtualFlats: 0,
shadowWins: 0,
shadowLosses: 0,
shadowFlats: 0,
realWins: 0,
realLosses: 0,
realFlats: 0,


winrate: 0,
fairWinrate: 0,
wilsonLowerBound: 0,
bayesianWinrate: 0,


avgR: 0,
totalR: 0,
netAvgR: 0,
netTotalR: 0,
realTotalR: 0,
virtualTotalR: 0,
shadowTotalR: 0,
profitFactor: 0,
         totalCostR: 0,
         avgCostR: 0,


         learningStatus: 'OBSERVING',
         status: 'OBSERVING',
         tooEarly: true,
         tooEarlyReason: `completed 0/${MIN_COMPLETED_ACTIVE_LEARNING}`,


         dashboardBalancedScore: 0,
         balancedScore: 0,


         discordAlertEligible: activationGateFor(row) === 'PASSED',
         selectedMicroFamilyAlert: activationGateFor(row) === 'PASSED',


         definitionParts: [
              `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
              `TRUE_MICRO_SCHEMA=${TRUE_MICRO_SCHEMA}`,
              `PARENT_TRUE_MICRO_SCHEMA=${PARENT_TRUE_MICRO_SCHEMA}`,
              'CLI_MANUAL_SELECTION=true',
              'EXACT_75_CHILD=true'
         ],
         definition: [
              `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
              `TRUE_MICRO_SCHEMA=${TRUE_MICRO_SCHEMA}`,
              `PARENT_TRUE_MICRO_SCHEMA=${PARENT_TRUE_MICRO_SCHEMA}`,
              'CLI_MANUAL_SELECTION=true',
              'EXACT_75_CHILD=true'
         ].join(' | ')
    };
}


function forceLongRow(row = {}, index = 0) {
    const rowMicroId = upper(microId(row));
    const rowParentId = upper(parentId(row) ||
parentTrueMicroFamilyIdFromChild(rowMicroId));
    const completed = completedCount(row);
    const learningStatus = learningStatusFromCompleted(completed, avgROf(row));


    return {
         ...row,


         rank: Number.isFinite(Number(row.rank))
              ? Number(row.rank)
              : index + 1,


         microFamilyId: rowMicroId,
         trueMicroFamilyId: rowMicroId,
         analyzeMicroFamilyId: row.analyzeMicroFamilyId || rowMicroId,
         learningMicroFamilyId: row.learningMicroFamilyId || rowMicroId,


         parentTrueMicroFamilyId: rowParentId,
         parentMicroFamilyId: row.parentMicroFamilyId || rowParentId || null,
         parentMacroFamilyId: row.parentMacroFamilyId || rowParentId || null,
         macroFamilyId: row.macroFamilyId || rowParentId || null,
         coarseMicroFamilyId: row.coarseMicroFamilyId || rowParentId || null,


         ...modeFlags(),


         source: row.source || 'CLI_MANUAL_SELECTION_LONG_75_CHILD',
         selectedTier: row.selectedTier || row.rotationEligibilityTier || 'MANUAL',
         rotationEligibilityTier: row.rotationEligibilityTier || row.selectedTier ||
'MANUAL',


         manualOnly: true,
         adminSelected: true,


         completed,
         outcomeSample: completed,


         learningStatus,
         status: learningStatus,
         activationGateStatus: activationGateFor(row),
         activationGatePassed: activationGateFor(row) === 'PASSED',
         empiricalVeto: activationGateFor(row) === 'EMPIRICAL_VETO',
         measurementFixVersion: rowMeasurementFixVersion(row),
         acceptedOutcomeMeasurementVersion: MEASUREMENT_FIX_VERSION,
         completedCurrentMeasurementOnly: true,
         tooEarly: completed < MIN_COMPLETED_ACTIVE_LEARNING,
         tooEarlyReason: completed < MIN_COMPLETED_ACTIVE_LEARNING
           ? `completed ${completed}/${MIN_COMPLETED_ACTIVE_LEARNING}`
           : null,


         avgR: Number(row.longAvgR ?? row.avgLongR ?? row.avgR ?? row.avgNetR ??
row.netAvgR ?? 0),
         totalR: Number(row.longTotalR ?? row.totalLongR ?? row.totalR ??
row.netTotalR ?? row.totalNetR ?? 0),
         avgCostR: Number(row.avgCostR ?? row.costR ?? row.totalCostR ?? 0),


         dashboardBalancedScore: Number(row.dashboardBalancedScore ?? row.balancedScore
?? row.learningQualityRank ?? 0),
         fairWinrate: Number(row.fairWinrate ?? row.sampleAdjustedWinrate ??
row.wilsonLowerBound ?? row.bayesianWinrate ?? 0),


         discordAlertEligible: true,
         selectedMicroFamilyAlert: true,


         bestShort: null
    };
}
function forceLongRotation(rotation = {}, requested = {}) {
  const baseRotation = unwrapActiveRotation(rotation) || rotation || {};
  const requestedIds = requested.microFamilyIds ||
requested.acceptedMicroFamilyIds || [];


  const rowsById = new Map();


  for (const [index, row] of asRows(baseRotation.microFamilies).entries()) {
       const id = upper(microId(row));


       if (!id || !isSelectableLongChildMicroId(id)) continue;


       rowsById.set(id, forceLongRow(row, index));
  }


  for (const [index, id] of requestedIds.entries()) {
       const childId = upper(id);


       if (!childId || !isSelectableLongChildMicroId(childId)) continue;
       if (rowsById.has(childId)) continue;


       rowsById.set(childId, buildManualRow(childId, rowsById.size || index));
  }


  const rows = [...rowsById.values()]
       .map((row, index) => forceLongRow({
         ...row,
         rank: index + 1
       }, index));


  const microFamilyIds = uniqueStrings([
       requestedIds,
       rows.map(microId)
  ])
       .map(upper)
       .filter(isSelectableLongChildMicroId);


  const parentTrueMicroFamilyIds = uniqueStrings([
       requested.parentTrueMicroFamilyIds || [],
       rows.map(parentId),
       microFamilyIds.map(parentTrueMicroFamilyIdFromChild)
  ])
       .map(upper)
       .filter(isParentContextId);


  const empty = microFamilyIds.length === 0;
  return {
    ...baseRotation,


    rotationId: baseRotation.rotationId || null,
    source: baseRotation.source || 'CLI_MANUAL_SELECTION_LONG_75_CHILD',
    mode: requested.mode || baseRotation.mode || 'selected',
    sideMode: 'long_only',


    sourceWeekKey: baseRotation.sourceWeekKey || requested.sourceWeekKey ||
requested.weekKey || PERSISTENT_LEARNING_KEY,
    activeWeekKey: baseRotation.activeWeekKey || requested.activeWeekKey ||
requested.weekKey || PERSISTENT_LEARNING_KEY,


    generatedAt: baseRotation.generatedAt || now(),
    activatedAt: baseRotation.activatedAt || now(),


    ...modeFlags(),


    trueMicroOnly: true,
    exactTrueMicroFamilyOnly: true,
    exactTrueMicroOnly: true,
    manualOnly: true,
    adminSelected: true,
    discordOnly: true,
    autoRotation: false,


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


    microFamilies: rows,


    bestLong: rows[0] || null,
    selectedRow: rows[0] || null,
    selectedMicroFamilyId: rows[0]?.microFamilyId || null,
    selectedTrueMicroFamilyId: rows[0]?.trueMicroFamilyId || null,
         selectedParentTrueMicroFamilyId: rows[0]?.parentTrueMicroFamilyId || null,
         selectedMacroFamilyId: null,


         activeCount: microFamilyIds.length,
         count: microFamilyIds.length,
         microCount: microFamilyIds.length,
         trueMicroCount: microFamilyIds.length,
         childCount: microFamilyIds.length,
         parentContextCount: parentTrueMicroFamilyIds.length,
         macroCount: 0,


         empty,
         emptyReason: empty
           ? baseRotation.emptyReason ||
'NO_MANUAL_LONG_75_CHILD_TRUE_MICRO_FAMILY_IDS_ACTIVE'
           : null,


         missingSides: empty ? [TARGET_TRADE_SIDE] : []
    };
}


async function activateManualSelection(requested = {}) {
    const gateCheck = await filterPassedActivationIds(requested.microFamilyIds || []);
    requested = {
         ...requested,
         requestedBeforeGateMicroFamilyIds: gateCheck.requestedIds,
         microFamilyIds: gateCheck.passedIds,
         activeMicroFamilyIds: gateCheck.passedIds,
         trueMicroFamilyIds: gateCheck.passedIds,
         acceptedMicroFamilyIds: gateCheck.passedIds,
         gateBlockedMicroFamilies: gateCheck.blocked
    };


    if (requested.microFamilyIds.length <= 0) {
         return {
           ok: requested.requestedMicroFamilyIds.length === 0,
           skipped: true,
           changed: false,
           type: 'CLI_MANUAL_LONG_75_CHILD_SELECTION_REQUIRED',


           reason: requested.requestedMicroFamilyIds.length > 0
             ? 'NO_PASSED_LONG_75_CHILD_TRUE_MICRO_FAMILY_IDS'
             : 'NO_MICRO_FAMILY_IDS_PROVIDED',


           ...modeFlags(),


           manualOnly: true,
           adminSelected: true,
           discordOnly: true,


           oldAutoFlagsIgnored: Boolean(requested.disabledAutoFlagPresent),


           weekKey: requested.weekKey,
           sourceWeekKey: requested.sourceWeekKey,
           activeWeekKey: requested.activeWeekKey,
           mode: requested.mode,


           requestedMicroFamilyIds: requested.requestedMicroFamilyIds,
         acceptedMicroFamilyIds: [],
         acceptedTrueMicroFamilyIds: [],


         parentTrueMicroFamilyIds: [],


         ignoredIds: requested.ignoredIds,
         ignoredShortIds: requested.ignoredShortIds,
         ignoredParentOnlyIds: requested.ignoredParentOnlyIds,
         ignoredUnknownIds: requested.ignoredUnknownIds,
         ignoredScannerFingerprintIds: requested.ignoredScannerFingerprintIds,
         ignoredExecutionFingerprintIds: requested.ignoredExecutionFingerprintIds,
         gateBlockedMicroFamilies: requested.gateBlockedMicroFamilies || []
    };
}


const engineResult = await activateSelectedMicroFamilies({
    microFamilyIds: requested.microFamilyIds,
    activeMicroFamilyIds: requested.microFamilyIds,
    trueMicroFamilyIds: requested.microFamilyIds,


    parentTrueMicroFamilyIds: requested.parentTrueMicroFamilyIds,


    macroFamilyIds: [],
    activeMacroFamilyIds: [],


    weekKey: requested.weekKey,
    sourceWeekKey: requested.sourceWeekKey,
    activeWeekKey: requested.activeWeekKey,
    mode: requested.mode || 'selected',


    source: 'CLI_MANUAL_SELECTION_LONG_75_CHILD',


    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,


    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,


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
...runtimeTemporalFlags(),
measurementFixVersion: MEASUREMENT_FIX_VERSION,
acceptedOutcomeMeasurementVersion: MEASUREMENT_FIX_VERSION,
strictOutcomeMeasurementGate: true,
activationGateRequired: 'PASSED',
empiricalVetoBlocksManualActivation: true,


manualOnly: true,
adminSelected: true,
discordOnly: true,
discordOnlyForSelectedMicroFamilies: true,
discordOnlyForExactTrueMicroMatch: true,
manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',


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


parentIsContextOnly: true,
macroActivationExpansionDisabled: true,
parentMatchDoesNotTriggerDiscord: true,
macroMatchDoesNotTriggerDiscord: true,


autoRotation: false,
autoRotationDisabled: true,
activateNextDisabled: true,
buildFreshDisabled: true,
activateFreezeCronDisabled: true,


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
  symbolExcludedFromFamilyId: true
});


const activeRotation = forceLongRotation(engineResult, requested);


return {
  ok: true,
  skipped: false,
  changed: true,
  type: 'CLI_MANUAL_LONG_75_CHILD_DISCORD_SELECTION_ACTIVATED',


  source: 'CLI_MANUAL_SELECTION_LONG_75_CHILD',


  weekKey: requested.weekKey,
  sourceWeekKey: requested.sourceWeekKey,
  activeWeekKey: activeRotation.activeWeekKey || requested.activeWeekKey,
  mode: requested.mode || 'selected',


  ...modeFlags(),


  manualOnly: true,
  adminSelected: true,
  discordOnly: true,


  oldAutoFlagsIgnored: Boolean(requested.disabledAutoFlagPresent),
         rotationId: activeRotation.rotationId || null,


         activatedCount: activeRotation.microFamilies?.length || 0,
         activatedMicroFamilies: activeRotation.activeMicroFamilyIds?.length || 0,
         activatedTrueMicroFamilies: activeRotation.trueMicroFamilyIds?.length || 0,
         activatedParentContextFamilies:
activeRotation.parentTrueMicroFamilyIds?.length || 0,
         activatedMacroFamilies: 0,


         requestedMicroFamilyIds: requested.requestedMicroFamilyIds,
         acceptedMicroFamilyIds: requested.microFamilyIds,
         acceptedTrueMicroFamilyIds: requested.microFamilyIds,


         parentTrueMicroFamilyIds: activeRotation.parentTrueMicroFamilyIds || [],


         ignoredIds: requested.ignoredIds,
         ignoredShortIds: requested.ignoredShortIds,
         ignoredParentOnlyIds: requested.ignoredParentOnlyIds,
         ignoredUnknownIds: requested.ignoredUnknownIds,
         ignoredScannerFingerprintIds: requested.ignoredScannerFingerprintIds,
         ignoredExecutionFingerprintIds: requested.ignoredExecutionFingerprintIds,
         gateBlockedMicroFamilies: requested.gateBlockedMicroFamilies || [],
         activationGateRequired: 'PASSED',


         microFamilyIds: activeRotation.microFamilyIds || [],
         activeMicroFamilyIds: activeRotation.activeMicroFamilyIds || [],
         trueMicroFamilyIds: activeRotation.trueMicroFamilyIds || [],


         macroFamilyIds: [],
         activeMacroFamilyIds: [],


         activeRotation,
         result: engineResult,


         reason: activeRotation.emptyReason || null
    };
}


async function runActivation(requested = {}) {
    return activateManualSelection(requested);
}


function getResultWeekKey(result, fallback = null) {
    const activeRotation = unwrapActiveRotation(result);


    return (
         result?.weekKey ||
         result?.activeWeekKey ||
         result?.sourceWeekKey ||
         activeRotation?.activeWeekKey ||
         activeRotation?.sourceWeekKey ||
         fallback ||
         PERSISTENT_LEARNING_KEY
    );
}


function getSourceWeekKey(result, fallback = null) {
    const activeRotation = unwrapActiveRotation(result);


    return (
         result?.sourceWeekKey ||
         activeRotation?.sourceWeekKey ||
         fallback ||
         PERSISTENT_LEARNING_KEY
    );
}


function getResultActiveWeekKey(result, fallback = null) {
    const activeRotation = unwrapActiveRotation(result);


    return (
         result?.activeWeekKey ||
         activeRotation?.activeWeekKey ||
         fallback ||
         PERSISTENT_LEARNING_KEY
    );
}


function getResultRotationId(result = {}) {
    const activeRotation = unwrapActiveRotation(result);


    return (
         result?.rotationId ||
         activeRotation?.rotationId ||
         null
    );
}


function buildCliResponse({
    result,
    requested,
    startedAt
}) {
    const activeRotation = unwrapActiveRotation(result);
    const normalizedActiveRotation = activeRotation
         ? forceLongRotation(activeRotation, requested)
    : null;


  const microFamilyIds = extractMicroFamilyIds(normalizedActiveRotation || {});
  const parentTrueMicroFamilyIds =
extractParentTrueMicroFamilyIds(normalizedActiveRotation || {});


  return {
    ok: result?.ok !== false,
    skipped: Boolean(result?.skipped),
    changed: Boolean(result?.changed),


    source: 'CLI_MANUAL_LONG_75_CHILD_DISCORD_SELECTION',


    argv: argv(),
    requested,


    type: result?.type || null,


    weekKey: getResultWeekKey(result, requested.weekKey || null),
    sourceWeekKey: getSourceWeekKey(
         result,
         requested.sourceWeekKey || requested.weekKey || null
    ),
    activeWeekKey: getResultActiveWeekKey(
         result,
         requested.activeWeekKey || null
    ),


    mode: requested.mode || result?.mode || 'selected',


    ...modeFlags(),


    manualOnly: true,
    adminSelected: true,
    discordOnly: true,


    oldAutoFlagsIgnored: Boolean(requested.disabledAutoFlagPresent),


    rotationId: getResultRotationId(result),


    activatedMicroFamilies:
         result?.activatedMicroFamilies ||
         result?.activatedTrueMicroFamilies ||
         result?.activatedCount ||
         microFamilyIds.length ||
         0,
      activatedParentContextFamilies:
        result?.activatedParentContextFamilies ||
        parentTrueMicroFamilyIds.length ||
        0,


      activatedMacroFamilies: 0,


      requestedMicroFamilyIds: requested.requestedMicroFamilyIds,
      acceptedMicroFamilyIds: requested.microFamilyIds,
      acceptedTrueMicroFamilyIds: requested.microFamilyIds,


      ignoredIds: requested.ignoredIds,
      ignoredShortIds: requested.ignoredShortIds,
      ignoredParentOnlyIds: requested.ignoredParentOnlyIds,
      ignoredUnknownIds: requested.ignoredUnknownIds,
      ignoredScannerFingerprintIds: requested.ignoredScannerFingerprintIds,
      ignoredExecutionFingerprintIds: requested.ignoredExecutionFingerprintIds,


      microFamilyIds,
      activeMicroFamilyIds: microFamilyIds,
      trueMicroFamilyIds: microFamilyIds,


      parentTrueMicroFamilyIds,
      parentMicroFamilyIds: parentTrueMicroFamilyIds,


      macroFamilyIds: [],
      activeMacroFamilyIds: [],


      empty: Boolean(normalizedActiveRotation?.empty || microFamilyIds.length ===
0),
      emptyReason: normalizedActiveRotation?.emptyReason || result?.reason || null,
      reason: result?.reason || null,


      trueMicroOnly: true,
      exactTrueMicroOnly: true,
      exactTrueMicroFamilyOnly: true,
      parentIsContextOnly: true,
      macroActivationExpansionDisabled: true,


      usedLegacyFallback: false,
      usedSoftFallback: Boolean(normalizedActiveRotation?.usedSoftFallback),
      usedObservationFallback:
Boolean(normalizedActiveRotation?.usedObservationFallback),
      usedRawFallback: Boolean(normalizedActiveRotation?.usedRawFallback),


      selectedTier: normalizedActiveRotation?.selectedTier || result?.selectedTier
|| null,
         missingSides: Array.isArray(normalizedActiveRotation?.missingSides)
           ? normalizedActiveRotation.missingSides
           : microFamilyIds.length === 0
             ? [TARGET_TRADE_SIDE]
             : [],


         durationMs: now() - startedAt,


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


         source: 'CLI_MANUAL_LONG_75_CHILD_DISCORD_SELECTION',


         argv: argv(),
         requested,


         ...modeFlags(),


         manualOnly: true,
         adminSelected: true,
         discordOnly: true,


         oldAutoFlagsIgnored: Boolean(requested?.disabledAutoFlagPresent),


         error: error?.message || String(error),
         stack: error?.stack,


         durationMs: now() - startedAt
    };
}


async function main() {
    const startedAt = now();
    const requested = buildRequestedOptions();


    try {
         const result = await runActivation(requested);
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
