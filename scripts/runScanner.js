// ================= FILE: scripts/runScanner.js =================



import { runScanner } from '../src/market/scanner.js';



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
const TEMPORAL_POLICY_VERSION =
  'LONG_TEMPORAL_FAMILY_PROFILE_POLICY_V1';
const TEMPORAL_GENERATION_SCHEMA_VERSION =
  'LONG_TEMPORAL_ROOT_GENERATION_V1';
const WEEKEND_POLICY_VERSION =
  'LONG_WEEKEND_APPROVAL_EXACT_DAY_V1';
const SESSION_POLICY_VERSION =
  'LONG_DAY_SESSION_VETO_RECOVERY_FDR_V1';

const TEMPORAL_STATS_ENABLED_DEFAULT = true;
const TEMPORAL_POLICY_MODE_DEFAULT = 'OBSERVE';
const TEMPORAL_POLICY_MODES = Object.freeze([
  'OFF',
  'OBSERVE',
  'ENFORCE'
]);

const TEMPORAL_WINDOW_MAX_OUTCOMES = 50;
const TEMPORAL_WINDOW_MAX_AGE_DAYS = 180;
const TEMPORAL_GENERATION_MAX_AGE_DAYS = 14;
const TEMPORAL_WEEKEND_APPROVAL_MAX_AGE_DAYS = 45;
const TEMPORAL_EXPECTED_CHILD_FAMILY_COUNT = 75;

const UTC_DAY_NAMES = Object.freeze([
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY'
]);

const TEMPORAL_SESSION_BUCKETS = Object.freeze([
  'ASIA',
  'ASIA_EU_OVERLAP',
  'EUROPE',
  'EU_US_OVERLAP',
  'US',
  'OFF_HOURS'
]);

function now() {
  return Date.now();
}

function normalizeTimestampMs(value, fallback = now()) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return numeric < 10_000_000_000
    ? Math.floor(numeric * 1000)
    : Math.floor(numeric);
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on', 'enabled'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off', 'disabled'].includes(normalized)) return false;
  return fallback;
}

function normalizeTemporalPolicyMode(value) {
  const mode = String(value || TEMPORAL_POLICY_MODE_DEFAULT).trim().toUpperCase();
  return TEMPORAL_POLICY_MODES.includes(mode)
    ? mode
    : TEMPORAL_POLICY_MODE_DEFAULT;
}

function getTemporalRuntimeConfig() {
  const temporalStatsEnabled = normalizeBoolean(
    process.env.TEMPORAL_STATS_ENABLED,
    TEMPORAL_STATS_ENABLED_DEFAULT
  );
  const configuredMode = normalizeTemporalPolicyMode(
    process.env.TEMPORAL_POLICY_MODE
  );
  const temporalPolicyMode = temporalStatsEnabled ? configuredMode : 'OFF';

  return Object.freeze({
    temporalStatsEnabled,
    configuredTemporalPolicyMode: configuredMode,
    temporalPolicyMode,
    temporalPolicyEffectivelyOff: !temporalStatsEnabled || temporalPolicyMode === 'OFF'
  });
}

function buildTemporalContext(timestamp = now()) {
  const contextTs = normalizeTimestampMs(timestamp, now());
  const date = new Date(contextTs);
  const hourUtc = date.getUTCHours();
  const dayIndex = date.getUTCDay();
  const dayOfWeekUtc = UTC_DAY_NAMES[dayIndex];
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

  const immutableSessionTags = Object.freeze([...sessionTags]);
  return Object.freeze({
    temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
    contextTs,
    hourUtc,
    dayOfWeekUtc,
    dayType: isWeekend ? 'WEEKEND' : 'WEEKDAY',
    isWeekend,
    sessionTags: immutableSessionTags,
    primarySessionBucket,
    sessionOverlap: immutableSessionTags.length > 1,
    offHours: immutableSessionTags.length === 0
  });
}

function temporalPolicyForContext(context = buildTemporalContext()) {
  const runtime = getTemporalRuntimeConfig();
  return Object.freeze({
    ...runtime,
    temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
    temporalGenerationSchemaVersion: TEMPORAL_GENERATION_SCHEMA_VERSION,
    weekendPolicyVersion: WEEKEND_POLICY_VERSION,
    sessionPolicyVersion: SESSION_POLICY_VERSION,
    temporalWindowMaxOutcomes: TEMPORAL_WINDOW_MAX_OUTCOMES,
    temporalWindowMaxAgeDays: TEMPORAL_WINDOW_MAX_AGE_DAYS,
    temporalGenerationMaxAgeDays: TEMPORAL_GENERATION_MAX_AGE_DAYS,
    temporalWeekendApprovalMaxAgeDays: TEMPORAL_WEEKEND_APPROVAL_MAX_AGE_DAYS,
    temporalExpectedChildFamilyCount: TEMPORAL_EXPECTED_CHILD_FAMILY_COUNT,
    temporalDecisionRequiresActiveGeneration: true,
    temporalGenerationPointerAuthoritative: true,
    temporalPolicyAppliesTo: 'DISCORD_ENTRY_PUBLICATION_ONLY',
    exitPublicationTemporalBlocked: false,
    weekendLearningAllowed: true,
    weekendVirtualEntryAllowed: true,
    weekendExitMonitoringAllowed: true,
    weekendOutcomeRecordingAllowed: true,
    sessionLearningAllowed: true,
    sessionVirtualEntryAllowed: true,
    weekendDefaultWouldBlock: Boolean(context.isWeekend),
    weekendApprovalRequired: Boolean(context.isWeekend),
    temporalWouldBlock: null,
    finalDiscordEntryAllowedFormula:
      "wouldPublishWithoutTemporal && (temporalPolicyMode !== 'ENFORCE' || temporalWouldBlock === false)"
  });
}

function runtimeTemporalFlags(timestamp = now()) {
  const context = buildTemporalContext(timestamp);
  return Object.freeze({
    ...context,
    ...temporalPolicyForContext(context)
  });
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



function isTrue(value) {
    if (value === true || value === 1) return true;



    const raw = String(value ?? '').trim().toLowerCase();



    return ['true', '1', 'yes', 'y', 'on', 'force', 'forced'].includes(raw);
}



function baseFlags() {
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



scannerOnly: true,
scannerDecidesTrade: false,
scannerDoesNotTrade: true,
scannerDoesNotSelectMicroFamilies: true,
scannerDoesNotSendDiscord: true,



noTradeExecution: true,
noMicroFamilySelection: true,
noDiscord: true,



virtualLearning: true,
virtualLearningForced: true,
virtualOnly: true,
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



    fixedTaxonomyPreferred: true,
    childLearningEnabled: true,
    parentLearningEnabled: true,
    parentIsContextOnly: true,
    parentMatchDoesNotTriggerDiscord: true,
    macroMatchDoesNotTriggerDiscord: true,
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
      EARLY_OUTCOMES: `completed > 0 && completed <
${MIN_COMPLETED_ACTIVE_LEARNING}`,
      ACTIVE_LEARNING: `completed >= ${MIN_COMPLETED_ACTIVE_LEARNING} && completed
< ${EMPIRICAL_VETO_MIN_COMPLETED}`,
         PASSED: `completed >= ${EMPIRICAL_VETO_MIN_COMPLETED} && avgR >
${EMPIRICAL_VETO_MAX_AVG_R}`,
         EMPIRICAL_VETO: `completed >= ${EMPIRICAL_VETO_MIN_COMPLETED} && avgR <=
${EMPIRICAL_VETO_MAX_AVG_R}`
    },
    activationGateRules: {
         OBSERVING: `completed < ${EMPIRICAL_VETO_MIN_COMPLETED}`,
         PASSED: `completed >= ${EMPIRICAL_VETO_MIN_COMPLETED} && avgR >
${EMPIRICAL_VETO_MAX_AVG_R}`,
         EMPIRICAL_VETO: `completed >= ${EMPIRICAL_VETO_MIN_COMPLETED} && avgR <=
${EMPIRICAL_VETO_MAX_AVG_R}`
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



          manualSelectionOnly: true,
          manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
          discordOnlyForSelectedMicroFamilies: true,
          discordOnlyForManualSelection: true,
          discordOnlyForExactTrueMicroMatch: true,



          autoRotationActivationDisabled: true,
          resetCronDisabled: true,
          activateFreezeCronDisabled: true,



          persistentLearningKey: PERSISTENT_LEARNING_KEY,
          weekResetDisabled: true,
          isoWeekLearningDisabled: true,



          redisNamespace: LONG_NAMESPACE,
          redisKeyPrefix: LONG_KEY_PREFIX,
          redisKeysSeparatedFromShortRoot: true,
          shortRootTouched: false
    };
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



function normalizeTradeSide(value) {
    const raw = cleanSideText(value);



    if (['LONG', 'BULL', 'BULLISH', 'BUY', 'DOWN', 'DOWNSIDE'].includes(raw)) {
        return TARGET_TRADE_SIDE;
    }



    if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'UP', 'UPSIDE'].includes(raw)) {
        return OPPOSITE_TRADE_SIDE;
    }



    return 'UNKNOWN';
}



function hasLongSignal(value = '') {
    const text = cleanSideText(value);



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
         text.startsWith('LONG_') ||
         text.includes('_LONG_') ||
         text.endsWith('_LONG') ||
         text.startsWith('BULL_') ||
         text.includes('_BULL_') ||
         text.endsWith('_BULL') ||
         text.startsWith('BUY_') ||
         text.includes('_BUY_') ||
         text.endsWith('_BUY') ||
         text.includes('|LONG|') ||
         text.includes('|BULL|') ||
         text.includes('|BUY|') ||
         text.includes(':LONG') ||
         text.includes(':BULL') ||
         text.includes(':BUY') ||
         text.includes('=LONG') ||
         text.includes('=BULL') ||
         text.includes('=BUY') ||
         text.includes('DOWNSIDE')
    );
}



function hasShortSignal(value = '') {
    const text = cleanSideText(value);



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
         text.startsWith('SHORT_') ||
         text.includes('_SHORT_') ||
         text.endsWith('_SHORT') ||
         text.startsWith('BEAR_') ||
         text.includes('_BEAR_') ||
         text.endsWith('_BEAR') ||
         text.startsWith('SELL_') ||
         text.includes('_SELL_') ||
         text.endsWith('_SELL') ||
         text.includes('|SHORT|') ||
         text.includes('|BEAR|') ||
         text.includes('|SELL|') ||
         text.includes(':SHORT') ||
         text.includes(':BEAR') ||
         text.includes(':SELL') ||
         text.includes('=SHORT') ||
         text.includes('=BEAR') ||
         text.includes('=SELL') ||
         text.includes('UPSIDE')
    );
}



function inferTradeSideFromText(value) {
    const text = cleanSideText(value);



    if (!text) return 'UNKNOWN';



    const direct = normalizeTradeSide(text);



    if (direct === TARGET_TRADE_SIDE || direct === OPPOSITE_TRADE_SIDE) {
         return direct;
    }



    const longHit = hasLongSignal(text);
    const shortHit = hasShortSignal(text);
    if (longHit && !shortHit) return TARGET_TRADE_SIDE;
    if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;



    if (longHit && shortHit) {
         if (text.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
         if (text.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
         if (text.includes('TRADE_SIDE=LONG') || text.includes('TRADESIDE=LONG'))
return TARGET_TRADE_SIDE;
         if (text.includes('TRADE_SIDE=SHORT') ||
text.includes('TRADESIDE=SHORT'))
return OPPOSITE_TRADE_SIDE;



         return TARGET_TRADE_SIDE;
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
    if (confirmation && !LONG_FIXED_CONFIRMATION_PROFILES.has(confirmation))
return
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



function isFixedLongChildMicroId(id = '') {
    return parseFixedLongTaxonomyId(id)?.isChild === true;
}



function parentTrueMicroFamilyIdFromChild(id = '') {
    const parsed = parseFixedLongTaxonomyId(id);



    return parsed?.isChild ? parsed.parentTrueMicroFamilyId : null;
}



function getDefinitionHaystack(row = {}) {
    return [
         row.familyId,
         row.family,
         row.baseFamilyId,



         row.microFamilyId,
         row.trueMicroFamilyId,
         row.coarseMicroFamilyId,
         row.parentTrueMicroFamilyId,
         row.baseMicroFamilyId,
         row.legacyMicroFamilyId,
         row.learningMicroFamilyId,
         row.analyzeMicroFamilyId,
         row.liveMicroFamilyId,
         row.realMicroFamilyId,
           row.executionMicroFamilyId,
           row.scannerMicroFamilyId,
           row.scannerFamilyId,
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



           row.scannerReason,
           row.reason,
              row.signalReason,
              row.actionReason,
              row.rejectionReason,



              ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
              ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts :
[]),
              ...(Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts :
[]),
              ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts
:
[]),
              ...(Array.isArray(row.executionFingerprintParts) ?
row.executionFingerprintParts : [])
       ]
              .map((value) => cleanSideText(value))
              .filter(Boolean)
              .join('|');
}



function inferTradeSide(row = {}) {
       if (typeof row === 'string') {
              return inferTradeSideFromText(row);
}



if (!row || typeof row !== 'object') {
     return 'UNKNOWN';
}



const direct = normalizeTradeSide(
     row.tradeSide ||
     row.positionSide ||
     row.direction ||
     row.scannerSide ||
     row.actualScannerSide ||
     row.analysisSide ||
     row.signalSide ||
     row.entrySide ||
     row.side ||
     row.bias ||
     row.marketBias
);



if (direct === TARGET_TRADE_SIDE || direct === OPPOSITE_TRADE_SIDE) {
     return direct;
}



const reasonSide = inferTradeSideFromText(
     [
         row.scannerReason,
         row.reason,
         row.signalReason,
         row.actionReason,
         row.rejectionReason
     ]
         .map((value) => cleanSideText(value))
         .filter(Boolean)
         .join('|')
);



if (reasonSide === TARGET_TRADE_SIDE || reasonSide === OPPOSITE_TRADE_SIDE) {
     return reasonSide;
}
    const haystackSide = inferTradeSideFromText(getDefinitionHaystack(row));



    if (haystackSide === TARGET_TRADE_SIDE || haystackSide ===
OPPOSITE_TRADE_SIDE)
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



function isLongCandidate(row = {}) {
    return inferTradeSide(row) === TARGET_TRADE_SIDE;
}



function isShortCandidate(row = {}) {
    return inferTradeSide(row) === OPPOSITE_TRADE_SIDE;
}



function safeNumber(value, fallback = 0) {
    const n = Number(value);



    return Number.isFinite(n) ? n : fallback;
}



function firstFiniteNumber(...values) {
    for (const value of values) {
         const n = Number(value);
         if (Number.isFinite(n)) return n;
    }



    return null;
}



function normalizeBaseSymbol(value = '') {
    let symbol = String(value || '')
         .trim()
         .toUpperCase()
         .replace(/[^A-Z0-9]/g, '');



    const suffixes = [
         'USDTUMCBL',
         'USDCUMCBL',
         'USDTPERP',
         'USDCPERP',
         'USDT',
         'USDC',
         'BUSD',
         'PERP',
         'SWAP',
         'USD'
    ];



    for (const suffix of suffixes) {
         if (symbol.endsWith(suffix) && symbol.length > suffix.length) {
             symbol = symbol.slice(0, -suffix.length);
             break;
         }
    }



    return symbol;
}



function normalizeContractSymbol(value = '') {
    const raw = String(value || '').trim().toUpperCase();



    if (!raw) return '';
    if (raw.endsWith('USDT')) return raw;



    return `${normalizeBaseSymbol(raw)}USDT`;
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



function scannerMetadataFrom(candidate = {}) {
    const ids = [
         candidate.scannerMicroFamilyId,
         candidate.scannerFamilyId,
         candidate.microFamilyId,
         candidate.trueMicroFamilyId,
         candidate.familyId,
          candidate.baseFamilyId,
          candidate.id,
          candidate.key
     ].filter(Boolean);



     const scannerId = ids.find(isScannerFingerprintId) || null;



     return {
          scannerMicroFamilyId: candidate.scannerMicroFamilyId || scannerId,
          scannerFamilyId: candidate.scannerFamilyId || null,
          scannerDefinition: candidate.scannerDefinition || null,
          scannerDefinitionParts: Array.isArray(candidate.scannerDefinitionParts)
            ? candidate.scannerDefinitionParts
            : [],



          scannerBucket: candidate.scannerBucket || candidate.bucket || null,
          scannerBucketDebug: candidate.scannerBucketDebug || candidate.bucketDebug
||
null,
          legacy25Bucket: candidate.legacy25Bucket || candidate.oldBucket ||
candidate.bucket25 || null,



          scannerFingerprintRole: 'METADATA_ONLY',
          scannerFingerprintOnlyMetadata: Boolean(scannerId),
          scannerFingerprintsMetadataOnly: true,
          scannerFingerprintsUsedAsLearningFamily: false
     };
}



function executionMetadataFrom(candidate = {}) {
     const ids = [
          candidate.executionMicroFamilyId,
          candidate.executionFingerprintHash,
          candidate.microFamilyId,
          candidate.trueMicroFamilyId,
          candidate.analyzeMicroFamilyId,
          candidate.id,
          candidate.key
     ].filter(Boolean);



     const executionId = ids.find(isExecutionFingerprintId) || null;
    return {
         executionMicroFamilyId: candidate.executionMicroFamilyId || executionId,
         executionFingerprintHash: candidate.executionFingerprintHash || null,
         executionFingerprintParts:
Array.isArray(candidate.executionFingerprintParts)
              ? candidate.executionFingerprintParts
              : [],
         executionFingerprintSchema: candidate.executionFingerprintSchema || null,



         executionFingerprintRole: 'METADATA_ONLY',
         executionFingerprintOnlyMetadata: Boolean(executionId),
         executionFingerprintsMetadataOnly: true,
         executionFingerprintsUsedAsLearningFamily: false
    };
}
function normalizeAnalyzeIdentityLeak(candidate = {}) {
    const trueMicroCandidate = String(
         candidate.trueMicroFamilyId ||
                 candidate.learningMicroFamilyId ||
                 candidate.analyzeMicroFamilyId ||
                 candidate.microFamilyId ||
                 ''
    ).trim();



    if (isFixedLongChildMicroId(trueMicroCandidate)) {
         return {
                 leakedAnalyzeTrueMicroFamilyId: upper(trueMicroCandidate),
                 leakedAnalyzeParentTrueMicroFamilyId:
parentTrueMicroFamilyIdFromChild(trueMicroCandidate),
                 leakedAnalyzeIdentityWasPresentOnScannerCandidate: true,



                 microFamilyId: null,
                 trueMicroFamilyId: null,
                 analyzeMicroFamilyId: null,
                 learningMicroFamilyId: null,
                 parentTrueMicroFamilyId: null,
                 coarseMicroFamilyId: null,



                 scannerDoesNotAssignTrueMicroFamily: true,
                 scannerAnalyzeIdentityStripped: true
         };
    }



    return {
         leakedAnalyzeTrueMicroFamilyId: null,
         leakedAnalyzeParentTrueMicroFamilyId: null,
         leakedAnalyzeIdentityWasPresentOnScannerCandidate: false,



         microFamilyId: null,
         trueMicroFamilyId: null,
         analyzeMicroFamilyId: null,
         learningMicroFamilyId: null,
         parentTrueMicroFamilyId: null,
         coarseMicroFamilyId: null,



         scannerDoesNotAssignTrueMicroFamily: true,
         scannerAnalyzeIdentityStripped: false
    };
}



function marketBiasHaystack(row = {}) {
    return cleanSideText([
         row.marketBias,
         row.bias,
         row.trendSide,
         row.currentTrendSide,
         row.marketSide,
         row.breadthSide,
         row.currentMarketSide,
         row.regimeSide,
         row.reason,
         row.scannerReason,
         row.signalReason,
         row.currentFitLabel,
         row.currentMarketFitLabel
    ].filter(Boolean).join('|'));
}



function getLongCurrentFit(row = {}) {
    const explicitLong = firstFiniteNumber(
         row.longCurrentFit,
         row.longCurrentFitScore,
         row.bullCurrentFit,
     row.bullCurrentFitScore,
     row.bullishCurrentFit,
     row.bullishCurrentFitScore
);



if (explicitLong !== null) return explicitLong;



const explicitShort = firstFiniteNumber(
     row.shortCurrentFit,
     row.shortCurrentFitScore,
     row.bearCurrentFit,
     row.bearCurrentFitScore,
     row.bearishCurrentFit,
     row.bearishCurrentFitScore
);



if (explicitShort !== null) return -Math.abs(explicitShort);



const rawFit = firstFiniteNumber(
     row.currentFitScore,
     row.entryCurrentFitScore,
     row.currentMarketFitScore,
     row.fitScore,
     row.marketFitScore,
     row.currentFit,
     row.entryCurrentFit,
     row.currentMarketFit,
     row.fit,
     row.marketFit
);



if (rawFit === null) return 0;



const bias = marketBiasHaystack(row);



if (hasLongSignal(bias) && !hasShortSignal(bias)) return Math.abs(rawFit);
if (hasShortSignal(bias) && !hasLongSignal(bias)) return -Math.abs(rawFit);



return rawFit;
}



function getLongRiskGeometry(row = {}) {
     const entry = firstFiniteNumber(
          row.entry,
          row.entryPrice,
          row.avgEntryPrice,
          row.openPrice,
          row.price,
          row.currentPrice,
          row.markPrice
     );



     const initialSl = firstFiniteNumber(
          row.initialSl,
          row.initialStopLoss,
          row.stopLoss,
          row.sl,
          row.stop
     );



     const tp = firstFiniteNumber(
          row.tp,
          row.takeProfit,
          row.target,
          row.targetPrice,
          row.tp1
     );



     const exitPrice = firstFiniteNumber(
          row.exitPrice,
          row.closePrice,
          row.closedPrice,
          row.currentPrice,
      row.lastPrice,
      row.markPrice,
      row.price
);



const currentPrice = firstFiniteNumber(
      row.currentPrice,
      row.lastPrice,
     row.markPrice,
     row.price,
     exitPrice
);



const denominator = entry !== null && initialSl !== null
     ? entry - initialSl
     : null;



const validLongGeometry = (
     entry !== null &&
     initialSl !== null &&
     tp !== null &&
     entry > 0 &&
     denominator > 0 &&
     initialSl < entry &&
     entry < tp
);



const longGrossR = validLongGeometry && exitPrice !== null
     ? (exitPrice - entry) / denominator
     : null;



const longCurrentR = validLongGeometry && currentPrice !== null
     ? (currentPrice - entry) / denominator
     : null;



const priceForHit = exitPrice ?? currentPrice;



return {
     entry,
     entryPrice: entry,
     initialSl,
     sl: initialSl,
     tp,
     exitPrice,
     currentPrice,



     validLongGeometry,
           longValidGeometry: validLongGeometry,
            validLongRiskShape: validLongGeometry,



            longTpHit: validLongGeometry && priceForHit !== null ? priceForHit >= tp
:
false,
            longSlHit: validLongGeometry && priceForHit !== null ? priceForHit <=
initialSl : false,



            longGrossR,
            longCurrentR,



            riskTradeSide: TARGET_TRADE_SIDE,
            riskGeometryRule: 'LONG: sl < entry < tp',
            tpHitRule: 'LONG: price >= tp',
            slHitRule: 'LONG: price <= sl',
            grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
            currentRFormula: '(currentPrice - entry) / (entry - initialSl)'
    };
}



function normalizeLongCandidate(candidate = {}) {
    const symbol = normalizeBaseSymbol(
            candidate.symbol ||
            candidate.baseSymbol ||
            candidate.contractSymbol ||
            candidate.instId ||
            candidate.instrumentId
    );



    const contractSymbol = normalizeContractSymbol(
            candidate.contractSymbol ||
            candidate.symbol ||
            candidate.instId ||
            candidate.instrumentId ||
            symbol
    );



    const longCurrentFit = getLongCurrentFit(candidate);
    const riskGeometry = getLongRiskGeometry(candidate);
    const candidateTs = normalizeTimestampMs(
         candidate.contextTs ??
         candidate.createdAt ??
         candidate.ts ??
         candidate.scannerTs ??
         now(),
         now()
    );
    const temporalContext = buildTemporalContext(candidateTs);



    return {
            ...candidate,



            symbol,
            baseSymbol: symbol,
            contractSymbol,
    ...baseFlags(),
    ...temporalContext,
    ...temporalPolicyForContext(temporalContext),
    scannerTemporalContext: temporalContext,
    scannerTemporalContextVersion: TEMPORAL_CONTEXT_VERSION,
    scannerTemporalMetadataOnly: true,
    scannerTemporalContextAuthoritative: false,
    entryTemporalContextMustBeBuiltAtPositionOpen: true,
    scannerCannotApplyTemporalPublicationPolicy: true,
    ...scannerMetadataFrom(candidate),
    ...executionMetadataFrom(candidate),
    ...normalizeAnalyzeIdentityLeak(candidate),



    directionalSide: TARGET_DASHBOARD_SIDE,
    inferredDirectionalSide: TARGET_DASHBOARD_SIDE,
    marketSide: TARGET_DASHBOARD_SIDE,



    scannerScore: safeNumber(candidate.scannerScore ?? candidate.moveScore, 0),
    moveScore: safeNumber(candidate.moveScore ?? candidate.scannerScore, 0),



    change1h: safeNumber(candidate.change1h ?? candidate.priceChange1hPct, 0),
    change24h: safeNumber(candidate.change24h ?? candidate.priceChange24hPct, 0),
    volume24h: safeNumber(candidate.volume24h ?? candidate.quoteVolume24h ??
candidate.quoteVolume, 0),



    btcState: candidate.btcState || null,
    regime: candidate.regime || null,



    fakeBreakout: Boolean(candidate.fakeBreakout),
    fakeBreakoutRisk: Boolean(candidate.fakeBreakoutRisk),
    scannerReason: candidate.scannerReason || candidate.reason ||
'LONG_SCANNER_CANDIDATE',



    currentFit: longCurrentFit,
    currentFitScore: longCurrentFit,
    longCurrentFit,
    bullCurrentFit: longCurrentFit,
    bullishCurrentFit: longCurrentFit,
    shortCurrentFit: -Math.abs(longCurrentFit),
    bearishCurrentFit: -Math.abs(longCurrentFit),
    currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
    currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',



    ...riskGeometry,
    currentR: riskGeometry.longCurrentR,
    grossR: riskGeometry.longGrossR,
    tpHit: riskGeometry.longTpHit,
    slHit: riskGeometry.longSlHit,



    createdAt: candidateTs,



         isMirrorMicroFamily: false,
         observationMirror: false,
         analysisMirror: false,
         mirrorAnalysisOnly: false,



         source: candidate.source || 'SCANNER'
    };
}



function scannerGatePassed(candidate = {}) {
    return Boolean(candidate.scannerGatePassed);
}



function isAnalyzeOnly(candidate = {}) {
    return Boolean(
         candidate.tradeDiscoveryOnly ||
         candidate.discoveryOnly ||
         candidate.analyzeOnly ||
         !scannerGatePassed(candidate)
    );
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
                 .map((value) => String(value || '').trim())
              .filter(Boolean)
    )];
}



function topSymbols(candidates = [], limit = 20) {
    return uniqueStrings(
          candidates
              .slice(0, limit)
              .map((candidate) => candidate.symbol || candidate.baseSymbol ||
candidate.contractSymbol)
              .filter(Boolean)
    );
}
function enforceLongOnlyPayload(payload = {}) {
    if (!payload || typeof payload !== 'object') return payload;



    const rawCandidates = Array.isArray(payload.candidates)
         ? payload.candidates
         : [];



    const candidates = rawCandidates
         .filter(isLongCandidate)
         .map(normalizeLongCandidate)
         .filter((candidate) => candidate.symbol && candidate.contractSymbol);



    const scannerGateCandidates = candidates.filter(scannerGatePassed);
    const analyzeOnlyCandidates = candidates.filter(isAnalyzeOnly);



    const rawShortCandidatesIgnored =
rawCandidates.filter(isShortCandidate).length;
    const rawUnknownSideCandidatesIgnored = rawCandidates.filter((candidate) => (
         inferTradeSide(candidate) === 'UNKNOWN'
    )).length;



    const rawScannerFingerprintCandidatesMetadataOnly =
rawCandidates.filter((candidate) => (
         isScannerFingerprintId(candidate?.scannerMicroFamilyId) ||
         isScannerFingerprintId(candidate?.microFamilyId) ||
         isScannerFingerprintId(candidate?.trueMicroFamilyId) ||
         isScannerFingerprintId(candidate?.id) ||
         isScannerFingerprintId(candidate?.key)
    )).length;



    const rawExecutionFingerprintCandidatesMetadataOnly =
rawCandidates.filter((candidate) => (
         isExecutionFingerprintId(candidate?.executionMicroFamilyId) ||
         isExecutionFingerprintId(candidate?.executionFingerprintHash) ||
  isExecutionFingerprintId(candidate?.microFamilyId) ||
  isExecutionFingerprintId(candidate?.trueMicroFamilyId) ||
  isExecutionFingerprintId(candidate?.analyzeMicroFamilyId) ||
  isExecutionFingerprintId(candidate?.id) ||
  isExecutionFingerprintId(candidate?.key)
)).length;
const rawAnalyzeIdentityLeaksStripped = candidates.filter((candidate) => (
  candidate.leakedAnalyzeIdentityWasPresentOnScannerCandidate
)).length;



const analyze = payload.analyze && typeof payload.analyze === 'object'
  ? {
        ...payload.analyze,
        ...baseFlags()
  }
  : payload.analyze || null;



return {
  ...payload,



  ...baseFlags(),



  sideMode: 'LONG_ONLY',



  candidates,
  candidatesCount: candidates.length,



  longCandidatesCount: candidates.length,
  shortCandidatesCount: 0,



  scannerGateCandidatesCount: scannerGateCandidates.length,
  analyzeOnlyCandidatesCount: analyzeOnlyCandidates.length,



  rawCandidatesCount: rawCandidates.length,
  rawShortCandidatesIgnored,
  rawUnknownSideCandidatesIgnored,
  rawScannerFingerprintCandidatesMetadataOnly,
  rawExecutionFingerprintCandidatesMetadataOnly,
  rawAnalyzeIdentityLeaksStripped,



  bullCandidates: candidates.length,
  bearCandidates: 0,
    topSymbols: topSymbols(candidates),
    scannerGateSymbols: topSymbols(scannerGateCandidates),
    analyzeOnlySymbols: topSymbols(analyzeOnlyCandidates),
           scannerDoesNotAssignTrueMicroFamily: true,
           scannerOutputHasNoSelectableMicroFamilyIds: true,



           analyze
      };
}



function normalizeResult(rawResult = {}) {
      if (!rawResult || typeof rawResult !== 'object') {
           return rawResult;
      }



      if (Array.isArray(rawResult.candidates)) {
           return enforceLongOnlyPayload(rawResult);
      }



      if (rawResult.result && typeof rawResult.result === 'object') {
           return {
                 ...rawResult,
                 ...baseFlags(),
                 result: normalizeResult(rawResult.result)
           };
      }



      return {
           ...rawResult,
           ...baseFlags()
      };
}



function unwrapPayload(result) {
      if (!result) return null;



      if (Array.isArray(result.candidates)) return result;
      if (Array.isArray(result.result?.candidates)) return result.result;
      if (Array.isArray(result.result?.result?.candidates)) return
result.result.result;
    if (Array.isArray(result.result?.result?.result?.candidates)) return
result.result.result.result;



    if (result.result?.result?.result) return result.result.result.result;
    if (result.result?.result) return result.result.result;
    if (result.result) return result.result;



    return result;
}
function shouldForce() {
    return (
         hasFlag('force') ||
         hasFlag('forced') ||
         isTrue(getArgValue('force')) ||
         isTrue(getArgValue('forced'))
    );
}



function isManualRun() {
    return (
         hasFlag('manual') ||
         hasFlag('force') ||
         hasFlag('forced') ||
         isTrue(getArgValue('manual')) ||
         isTrue(getArgValue('force')) ||
         isTrue(getArgValue('forced'))
    );
}



function buildScannerOptions() {
    const force = shouldForce();



    return {
         force,
         forced: force,



         source: isManualRun()
           ? 'CLI_MANUAL_SCANNER_RUN_LONG_ONLY'
           : 'CLI_SCANNER_RUN_LONG_ONLY',
         targetTradeSide: TARGET_TRADE_SIDE,
         tradeSide: TARGET_TRADE_SIDE,
         positionSide: TARGET_TRADE_SIDE,
         direction: TARGET_TRADE_SIDE,



         side: TARGET_DASHBOARD_SIDE,
         dashboardSide: TARGET_DASHBOARD_SIDE,
         targetScannerSide: TARGET_SCANNER_SIDE,



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
...runtimeTemporalFlags(),



scannerOnly: true,
scannerDecidesTrade: false,
scannerDoesNotTrade: true,
scannerDoesNotSelectMicroFamilies: true,
scannerDoesNotSendDiscord: true,



noTradeExecution: true,
noMicroFamilySelection: true,
noDiscord: true,



virtualLearning: true,
virtualLearningForced: true,
virtualOnly: true,



noRealOrders: true,
realOrdersDisabled: true,
exchangeOrdersDisabled: true,
bitgetOrdersDisabled: true,
exchangeCallsDisabled: true,



observationFirst: true,



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
         exactTrueMicroFamilyRequired: true,
         trueMicroOnly: true,
         exactTrueMicroOnly: true,
         trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
         exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
         parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
         learningGranularity: LEARNING_GRANULARITY,
            parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
            selectionGranularity: SELECTION_GRANULARITY,



            scannerDoesNotAssignTrueMicroFamily: true,
            scannerOutputHasNoSelectableMicroFamilyIds: true,
            symbolExcludedFromFamilyId: true,



            bucketGranularity: 'LOW_MID_HIGH',
            bucketsCoarseOnly: true,
            scannerBucketsDebugOnly: true,
            legacy25BucketsDebugOnly: true,
            coinNameDebugOnly: true,
            hashesDebugOnly: true,



            maxOneOpenPositionPerSymbol: true,
            globalMaxOpenPositionsBlockDisabled: true
       };
}



function buildSuccessPayload({
       result,
       startedAt,
       scannerOptions
}) {
       const normalizedResult = normalizeResult(result);
       const payload = unwrapPayload(normalizedResult) || {};
       const candidates = Array.isArray(payload.candidates)
            ? payload.candidates
            : [];
    const scannerGateCandidates = candidates.filter(scannerGatePassed);
    const analyzeOnlyCandidates = candidates.filter(isAnalyzeOnly);



    return {
       ok: normalizedResult?.ok !== false && payload?.ok !== false,
       skipped: Boolean(normalizedResult?.skipped || payload?.skipped),
       reason: normalizedResult?.reason || payload?.reason || null,



       source: 'CLI_RUN_SCANNER_LONG_ONLY',
       runSource: scannerOptions.source,
    argv: argv(),
    options: scannerOptions,



    ...baseFlags(),



    force: scannerOptions.force,



    persisted: payload.persisted ?? normalizedResult?.persisted ?? null,
    snapshotId: payload.snapshotId || normalizedResult?.snapshotId || null,



    candidatesCount: Number(payload.candidatesCount || candidates.length || 0),
    longCandidatesCount: Number(payload.longCandidatesCount || candidates.length
|| 0),
    shortCandidatesCount: 0,



    scannerGateCandidatesCount: Number(
         payload.scannerGateCandidatesCount ||
         scannerGateCandidates.length ||
         0
    ),



    analyzeOnlyCandidatesCount: Number(
         payload.analyzeOnlyCandidatesCount ||
         analyzeOnlyCandidates.length ||
         0
    ),



    rawCandidatesCount: Number(payload.rawCandidatesCount || 0),
    rawShortCandidatesIgnored: Number(payload.rawShortCandidatesIgnored || 0),
    rawUnknownSideCandidatesIgnored:
Number(payload.rawUnknownSideCandidatesIgnored || 0),
    rawScannerFingerprintCandidatesMetadataOnly:
Number(payload.rawScannerFingerprintCandidatesMetadataOnly || 0),
    rawExecutionFingerprintCandidatesMetadataOnly:
Number(payload.rawExecutionFingerprintCandidatesMetadataOnly || 0),
    rawAnalyzeIdentityLeaksStripped:
Number(payload.rawAnalyzeIdentityLeaksStripped || 0),



         topSymbols: Array.isArray(payload.topSymbols)
                ? payload.topSymbols
                : topSymbols(candidates),



            scannerGateSymbols: Array.isArray(payload.scannerGateSymbols)
                ? payload.scannerGateSymbols
                : topSymbols(scannerGateCandidates),



            analyzeOnlySymbols: Array.isArray(payload.analyzeOnlySymbols)
                ? payload.analyzeOnlySymbols
                : topSymbols(analyzeOnlyCandidates),



            scannerDoesNotAssignTrueMicroFamily: true,
            scannerOutputHasNoSelectableMicroFamilyIds: true,



            analyze: payload.analyze || null,



            durationMs: now() - startedAt,



            result: normalizedResult
       };
}



function buildErrorPayload({
       error,
       startedAt,
       scannerOptions
}) {
       return {
            ok: false,



            source: 'CLI_RUN_SCANNER_LONG_ONLY',
            runSource: scannerOptions?.source || 'CLI_SCANNER_RUN_LONG_ONLY',



            argv: argv(),
            options: scannerOptions || null,



            ...baseFlags(),
            error: error?.message || String(error),
            stack: error?.stack,



            durationMs: now() - startedAt
    };
}
function exitCodeFromResult(result) {
    return result?.ok === false ? 1 : 0;
}



async function main() {
    const startedAt = now();
    const scannerOptions = buildScannerOptions();



    try {
         const result = await runScanner(scannerOptions);



         const response = buildSuccessPayload({
             result,
             startedAt,
             scannerOptions
         });



         console.log(JSON.stringify(response, null, 2));



         process.exitCode = exitCodeFromResult(response);
    } catch (error) {
         console.error(JSON.stringify(
             buildErrorPayload({
                   error,
                   startedAt,
                   scannerOptions
             }),
             null,
             2
         ));



         process.exitCode = 1;
    }
}



await main();
