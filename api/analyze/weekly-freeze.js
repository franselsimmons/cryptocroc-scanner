// ================= FILE: api/analyze/weekly-freeze.js =================

import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import {
  getDurableRedis,
  getJson
} from '../../src/redis.js';
import { withRedisLock } from '../../src/lock.js';
import {
  sideToTradeSide
} from '../../src/utils.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;

const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';
const MIN_COMPLETED_ACTIVE_LEARNING = 20;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;

const DEFAULT_LOCK_TTL_SEC = 600;

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';

const PARENT_LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';

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

const CONFIRMATION_PROFILE_ORDER = [
  'A_STRONG_ALIGN',
  'B_FLOW_ALIGN',
  'C_VOLUME_ALIGN',
  'D_MIXED_OK',
  'E_WEAK_CONTRA'
];

function now() {
  return Date.now();
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
    ),

    freezeLock: namespacedLongKey(
      KEYS.long?.analyze?.freezeLock ||
        KEYS.analyze?.longFreezeLock ||
        KEYS.analyze?.freezeLock,
      'ANALYZE:WEEKLY_FREEZE_LOCK'
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

function freezeLockKey() {
  return LONG_KEYS.analyze.freezeLock;
}

function taxonomyFlags() {
  return {
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,

    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    fixedTaxonomyPreferred: true,

    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    learningGranularity: LEARNING_GRANULARITY,

    parentMicroFamilyCount: 15,
    selectableChildMicroFamilyCount: 75,

    setupTypes: SETUP_ORDER,
    regimeBuckets: REGIME_ORDER,
    confirmationProfiles: CONFIRMATION_PROFILE_ORDER,

    parentFamilyFormat: 'MICRO_LONG_{SETUP}_{REGIME}',
    selectableChildFamilyFormat: 'MICRO_LONG_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',

    exampleParentTrueMicroFamilyId: 'MICRO_LONG_BREAKOUT_TREND',
    exampleSelectableTrueMicroFamilyId: 'MICRO_LONG_BREAKOUT_TREND_A_STRONG_ALIGN',

    parentIdsAreMetadataOnly: true,
    parentIdsAreNotSelectable: true,
    selectableIdsAre75ChildOnly: true,
    selectionGranularity: 'EXACT_75_CHILD',
    discordSelectionGranularity: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID'
  };
}

function flags() {
  return {
    targetTradeSide: TARGET_TRADE_SIDE,
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

    weeklyFreezeDisabled: true,
    weeklyFreezeBuildDisabled: true,
    nextRotationBuildDisabled: true,

    nextRotationOnly: false,
    activeRotationPreserved: true,
    activeRotationWriteBlocked: true,
    nextRotationWriteBlocked: true,
    rotationValidFromWriteBlocked: true,

    autoActivationDisabled: true,
    autoRotationDisabled: true,
    activateNextRotationDisabled: true,
    activateFreezeCronDisabled: true,
    resetCronDisabled: true,
    manualSelectionRemainsLeading: true,
    manualSelectionOnly: true,
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    manualSelectionMustUseSelectable75ChildId: true,

    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,

    virtualLearningOnly: true,
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

    observationFirst: true,
    observationFirstAnalyze: true,
    netOutcomesOnly: true,
    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    globalMaxOpenPositionsBlockDisabled: true,
    maxOneOpenPositionPerSymbol: true,
    positionTimeStopMinDefault: DEFAULT_POSITION_TIME_STOP_MIN,

    scannerSide: TARGET_DASHBOARD_SIDE,
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsDebugMetadataOnly: true,
    legacy25BucketsDebugMetadataOnly: true,
    scannerBucketsAreNotSelectable: true,

    executionFingerprintRole: 'METADATA_ONLY',
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

    ...taxonomyFlags(),

    bucketsCoarseOnly: true,
    bucketGranularity: 'LOW_MID_HIGH',

    discordOnlyForManualSelection: true,
    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForExactTrueMicroMatch: true,
    discordSelectionRule: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY',
    parentMatchDoesNotTriggerDiscord: true,
    macroMatchDoesNotTriggerDiscord: true,

    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    weekResetDisabled: true,
    isoWeekLearningDisabled: true,

    minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,
    statusRules: {
      OBSERVING: 'completed == 0',
      EARLY_OUTCOMES: `completed > 0 && completed < ${MIN_COMPLETED_ACTIVE_LEARNING}`,
      ACTIVE_LEARNING: `completed >= ${MIN_COMPLETED_ACTIVE_LEARNING}`
    },

    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    redisKeysSeparatedFromShortRoot: true,
    shortRootTouched: false
  };
}

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET, POST');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET', 'POST'],
    ...flags()
  });
}

function parseJson(text) {
  const raw = String(text || '').trim();

  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('INVALID_JSON_BODY');
    error.statusCode = 400;
    throw error;
  }
}

async function readBody(req) {
  if (req.method === 'GET') return {};

  if (req.body) {
    if (typeof req.body === 'string') return parseJson(req.body);
    if (Buffer.isBuffer(req.body)) return parseJson(req.body.toString('utf8'));

    return req.body;
  }

  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return parseJson(Buffer.concat(chunks).toString('utf8'));
}

function firstValue(value, fallback = null) {
  if (Array.isArray(value)) return value[0] ?? fallback;
  if (value === undefined || value === null || value === '') return fallback;

  return value;
}

function getParam(req, body, key, fallback = null) {
  const bodyValue = firstValue(body?.[key], null);
  const queryValue = firstValue(req.query?.[key], null);

  if (bodyValue !== null && bodyValue !== '') return bodyValue;
  if (queryValue !== null && queryValue !== '') return queryValue;

  return fallback;
}

function getFreezeLockTtlSec() {
  const ttl = Number(
    CONFIG.long?.analyze?.freezeLockTtlSec ||
      CONFIG.analyze?.freezeLockTtlSec ||
      DEFAULT_LOCK_TTL_SEC
  );

  if (!Number.isFinite(ttl)) return DEFAULT_LOCK_TTL_SEC;
  if (ttl <= 0) return DEFAULT_LOCK_TTL_SEC;

  return Math.floor(ttl);
}

function getRotationMode(req, body = {}) {
  const raw = String(
    getParam(
      req,
      body,
      'mode',
      'manual'
    ) || 'manual'
  ).trim();

  if (!raw) return 'manual';
  if (inferTradeSideFromText(raw) === OPPOSITE_TRADE_SIDE) return 'manual';

  return raw;
}

function getRequestedWeekKey(req, body = {}) {
  return String(
    getParam(
      req,
      body,
      'weekKey',
      PERSISTENT_LEARNING_KEY
    ) || PERSISTENT_LEARNING_KEY
  ).trim();
}

function getWeekKey() {
  return PERSISTENT_LEARNING_KEY;
}

function getRequestedActiveWeekKey(req, body = {}) {
  const explicit =
    getParam(req, body, 'activeWeekKey', null) ||
    getParam(req, body, 'nextWeekKey', null);

  if (explicit) return String(explicit).trim();

  return PERSISTENT_LEARNING_KEY;
}

function getActiveWeekKey() {
  return PERSISTENT_LEARNING_KEY;
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function cleanSideText(value = '') {
  return upper(value)
    .replaceAll('SHORT_DISABLED', '')
    .replaceAll('SHORTDISABLED', '')
    .replaceAll('BLOCK_SHORT', '')
    .replaceAll('SHORT_ENABLED_FALSE', '')
    .replaceAll('SHORT_ONLY_FALSE', '')
    .replaceAll('LONG_DISABLED_FALSE', '')
    .replaceAll('LONG_ENABLED_FALSE', '')
    .replaceAll('LONG_ONLY_FALSE', '')
    .replaceAll('LONG_ONLY_MODE', 'LONG')
    .replaceAll('LONG_ONLY', 'LONG')
    .replaceAll('LONG-ONLY', 'LONG');
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .flatMap((value) => {
        if (value && typeof value === 'object') {
          return [
            value.trueMicroFamilyId,
            value.childTrueMicroFamilyId,
            value.parentTrueMicroFamilyId,
            value.microFamilyId,
            value.coarseMicroFamilyId,
            value.id,
            value.key
          ];
        }

        return String(value || '').split(/[\s,;\n\r]+/g);
      })
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
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

function normalizeDirectSide(value) {
  const text = cleanSideText(value);

  if (!text) return 'UNKNOWN';

  const converted = sideToTradeSide(text);

  if (converted === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (converted === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  if (['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'UPSIDE'].includes(text)) {
    return TARGET_TRADE_SIDE;
  }

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE'].includes(text)) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferTradeSideFromText(value = '') {
  const text = cleanSideText(value);

  if (!text) return 'UNKNOWN';

  const direct = normalizeDirectSide(text);

  if (direct === TARGET_TRADE_SIDE || direct === OPPOSITE_TRADE_SIDE) {
    return direct;
  }

  const longSignal = hasLongSignal(text);
  const shortSignal = hasShortSignal(text);

  if (longSignal && !shortSignal) return TARGET_TRADE_SIDE;
  if (shortSignal && !longSignal) return OPPOSITE_TRADE_SIDE;

  if (longSignal && shortSignal) {
    if (text.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
    if (text.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferRowTradeSide(row = {}) {
  if (typeof row === 'string') return inferTradeSideFromText(row);

  const directSources = [
    row.tradeSide,
    row.positionSide,
    row.direction,
    row.signalSide,
    row.scannerSide,
    row.analysisSide,
    row.side,
    row.bias,
    row.marketBias
  ];

  for (const source of directSources) {
    const side = normalizeDirectSide(source);

    if (side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE) {
      return side;
    }
  }

  const haystack = [
    row.familyId,
    row.family,
    row.baseFamilyId,

    row.parentTrueMicroFamilyId,
    row.childTrueMicroFamilyId,
    row.trueMicroFamilyId,
    row.microFamilyId,
    row.coarseMicroFamilyId,
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
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : []),
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : [])
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join('|');

  const textSide = inferTradeSideFromText(haystack);

  if (textSide !== 'UNKNOWN') return textSide;

  if (row.longOnly === true || row.shortDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  if (row.shortOnly === true || row.longDisabled === true) {
    return OPPOSITE_TRADE_SIDE;
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
      rawId: String(id || '').trim(),
      setup: null,
      regime: null,
      confirmationProfile: null,
      parentTrueMicroFamilyId: null,
      childTrueMicroFamilyId: null,
      trueMicroFamilyId: null,
      trueMicroFamilySchema: null,
      learningGranularity: null
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

  const validParent =
    Boolean(setup) &&
    Boolean(regime) &&
    LONG_FIXED_SETUP_TYPES.has(setup) &&
    LONG_FIXED_REGIME_BUCKETS.has(regime);

  const validChild =
    validParent &&
    Boolean(confirmationProfile) &&
    LONG_CONFIRMATION_PROFILES.has(confirmationProfile);

  const parentTrueMicroFamilyId = validParent
    ? `MICRO_LONG_${setup}_${regime}`
    : null;

  const childTrueMicroFamilyId = validChild
    ? `${parentTrueMicroFamilyId}_${confirmationProfile}`
    : null;

  return {
    valid: validParent || validChild,
    selectable: validChild,
    isParent: validParent && !validChild,
    isChild: validChild,
    rawId: String(id || '').trim(),
    setup,
    regime,
    confirmationProfile,
    parentTrueMicroFamilyId,
    childTrueMicroFamilyId,
    trueMicroFamilyId: childTrueMicroFamilyId || parentTrueMicroFamilyId,
    trueMicroFamilySchema: validChild ? CHILD_TRUE_MICRO_SCHEMA : validParent ? PARENT_TRUE_MICRO_SCHEMA : null,
    learningGranularity: validChild ? LEARNING_GRANULARITY : validParent ? PARENT_LEARNING_GRANULARITY : null
  };
}

function isParentLongTaxonomyMicroId(id = '') {
  const parsed = parseLongTaxonomyMicroId(id);

  return parsed.valid && parsed.isParent;
}

function isChildLongTaxonomyMicroId(id = '') {
  const parsed = parseLongTaxonomyMicroId(id);

  return parsed.valid && parsed.isChild;
}

function isSelectable75ChildId(id = '') {
  return parseLongTaxonomyMicroId(id).selectable === true;
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

function getMicroFamilyId(row = {}, fallback = null) {
  return (
    row.trueMicroFamilyId ||
    row.childTrueMicroFamilyId ||
    row.microFamilyId ||
    row.id ||
    row.key ||
    fallback ||
    null
  );
}

function getCoarseMicroFamilyId(row = {}, fallback = null) {
  return (
    row.parentTrueMicroFamilyId ||
    row.coarseMicroFamilyId ||
    row.baseMicroFamilyId ||
    row.legacyMicroFamilyId ||
    row.trueMicroFamilyId ||
    row.microFamilyId ||
    fallback ||
    null
  );
}

function getMacroFamilyId(row = {}) {
  return (
    row.parentTrueMicroFamilyId ||
    row.parentMacroFamilyId ||
    row.macroFamilyId ||
    row.parentMicroFamilyId ||
    row.parentFamilyId ||
    row.macroId ||
    row.familyId ||
    null
  );
}

function resolveTaxonomyIds(row = {}, fallback = null) {
  const candidate = getMicroFamilyId(row, fallback);
  const parsedCandidate = parseLongTaxonomyMicroId(candidate);

  const parentCandidate =
    row.parentTrueMicroFamilyId ||
    row.coarseMicroFamilyId ||
    row.parentMacroFamilyId ||
    row.macroFamilyId ||
    null;

  const parsedParent = parseLongTaxonomyMicroId(parentCandidate);

  const parentTrueMicroFamilyId =
    parsedCandidate.parentTrueMicroFamilyId ||
    parsedParent.parentTrueMicroFamilyId ||
    null;

  const childTrueMicroFamilyId =
    parsedCandidate.childTrueMicroFamilyId ||
    row.childTrueMicroFamilyId ||
    null;

  const trueMicroFamilyId =
    childTrueMicroFamilyId ||
    parsedCandidate.trueMicroFamilyId ||
    candidate ||
    null;

  return {
    parsedCandidate,
    parsedParent,
    parentTrueMicroFamilyId,
    childTrueMicroFamilyId,
    trueMicroFamilyId,
    selectableTrueMicroFamilyId: Boolean(childTrueMicroFamilyId && isSelectable75ChildId(childTrueMicroFamilyId)),
    fixedTaxonomyLearningId: Boolean(parsedCandidate.valid || parsedParent.valid)
  };
}

function isLongRow(row = {}) {
  const taxonomy = resolveTaxonomyIds(row);
  const id = taxonomy.trueMicroFamilyId;

  if (!id) return false;
  if (!validLearningId(id)) return false;
  if (!taxonomy.selectableTrueMicroFamilyId) return false;

  return inferRowTradeSide({
    ...row,
    trueMicroFamilyId: id,
    childTrueMicroFamilyId: taxonomy.childTrueMicroFamilyId,
    parentTrueMicroFamilyId: taxonomy.parentTrueMicroFamilyId
  }) !== OPPOSITE_TRADE_SIDE;
}

function isShortRow(row = {}) {
  return inferRowTradeSide(row) === OPPOSITE_TRADE_SIDE;
}

function isAllowedLongChildId(id = '') {
  const value = String(id || '').trim();

  if (!value) return false;
  if (!validLearningId(value)) return false;
  if (!isSelectable75ChildId(value)) return false;

  return inferTradeSideFromText(value) !== OPPOSITE_TRADE_SIDE;
}

function isAllowedParentId(id = '') {
  const value = String(id || '').trim();

  if (!value) return false;
  if (!validLearningId(value)) return false;
  if (!isParentLongTaxonomyMicroId(value)) return false;

  return inferTradeSideFromText(value) !== OPPOSITE_TRADE_SIDE;
}

function learningStatus(row = {}) {
  const completed = Number(row.completed || row.outcomeSample || 0);

  if (completed >= MIN_COMPLETED_ACTIVE_LEARNING) return 'ACTIVE_LEARNING';
  if (completed > 0) return 'EARLY_OUTCOMES';

  return 'OBSERVING';
}

function forceLongRow(row = {}, index = 0) {
  const taxonomy = resolveTaxonomyIds(row, row.microFamilyId || row.id || row.key);
  const rawInferredTradeSide = inferRowTradeSide(row);

  const trueMicroFamilyId = taxonomy.trueMicroFamilyId;
  const childTrueMicroFamilyId = taxonomy.childTrueMicroFamilyId;
  const parentTrueMicroFamilyId = taxonomy.parentTrueMicroFamilyId;

  return {
    ...row,

    rank: Number.isFinite(Number(row.rank))
      ? Number(row.rank)
      : index + 1,

    microFamilyId: trueMicroFamilyId,
    trueMicroFamilyId,
    analyzeMicroFamilyId: trueMicroFamilyId,
    learningMicroFamilyId: trueMicroFamilyId,
    childTrueMicroFamilyId,

    coarseMicroFamilyId: parentTrueMicroFamilyId,
    parentTrueMicroFamilyId,

    macroFamilyId: parentTrueMicroFamilyId,
    parentMacroFamilyId: parentTrueMicroFamilyId,
    parentMicroFamilyId: parentTrueMicroFamilyId,

    ...flags(),

    fixedTaxonomyLearningId: taxonomy.fixedTaxonomyLearningId,
    parentFixedTaxonomyLearningId: Boolean(parentTrueMicroFamilyId && isParentLongTaxonomyMicroId(parentTrueMicroFamilyId)),
    childFixedTaxonomyLearningId: Boolean(childTrueMicroFamilyId && isChildLongTaxonomyMicroId(childTrueMicroFamilyId)),
    selectableTrueMicroFamilyId: taxonomy.selectableTrueMicroFamilyId,

    trueMicroFamilySchema: taxonomy.selectableTrueMicroFamilyId
      ? CHILD_TRUE_MICRO_SCHEMA
      : row.trueMicroFamilySchema || null,
    parentTrueMicroFamilySchema: parentTrueMicroFamilyId ? PARENT_TRUE_MICRO_SCHEMA : null,
    childTrueMicroFamilySchema: childTrueMicroFamilyId ? CHILD_TRUE_MICRO_SCHEMA : null,

    rawInferredTradeSide,
    inferredTradeSide: rawInferredTradeSide === 'UNKNOWN'
      ? TARGET_TRADE_SIDE
      : rawInferredTradeSide,
    inferredFromLongOnlyMode: rawInferredTradeSide === 'UNKNOWN',

    learningStatus: row.learningStatus || learningStatus(row),
    status: row.status || row.learningStatus || learningStatus(row),
    tooEarly: Number(row.completed || row.outcomeSample || 0) < MIN_COMPLETED_ACTIVE_LEARNING,
    tooEarlyReason: Number(row.completed || row.outcomeSample || 0) < MIN_COMPLETED_ACTIVE_LEARNING
      ? `COMPLETED_BELOW_${MIN_COMPLETED_ACTIVE_LEARNING}`
      : null,

    realCompleted: 0,
    realWins: 0,
    realLosses: 0,
    realFlats: 0,
    realTotalR: 0,

    avgCostR: Number(row.avgCostR || 0),

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    executionFingerprintRole: 'METADATA_ONLY',
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,

    bestShort: null
  };
}

function buildManualRow(id, index = 0) {
  const parsed = parseLongTaxonomyMicroId(id);

  return forceLongRow({
    microFamilyId: parsed.childTrueMicroFamilyId || id,
    trueMicroFamilyId: parsed.childTrueMicroFamilyId || id,
    childTrueMicroFamilyId: parsed.childTrueMicroFamilyId || id,

    familyId: null,
    macroFamilyId: parsed.parentTrueMicroFamilyId,
    parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
    parentMacroFamilyId: parsed.parentTrueMicroFamilyId,
    parentMicroFamilyId: parsed.parentTrueMicroFamilyId,
    coarseMicroFamilyId: parsed.parentTrueMicroFamilyId,

    source: 'STORED_ID_ONLY',

    selectedTier: 'MANUAL',
    rotationEligibilityTier: 'MANUAL',

    seen: 0,
    observations: 0,
    completed: 0,
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

    fixedTaxonomyLearningId: true,
    parentFixedTaxonomyLearningId: true,
    childFixedTaxonomyLearningId: true,
    selectableTrueMicroFamilyId: true,
    trueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,

    definitionParts: [
      `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
      'STORED_ID_ONLY=true',
      'EXACT_TRUE_MICRO_FAMILY_ID=true',
      'EXACT_75_CHILD=true'
    ],
    definition: `TRADE_SIDE=${TARGET_TRADE_SIDE} | STORED_ID_ONLY=true | EXACT_TRUE_MICRO_FAMILY_ID=true | EXACT_75_CHILD=true`
  }, index);
}

function longIdsFromRows(rows = []) {
  return uniqueStrings(
    rows
      .filter(isLongRow)
      .map((row) => row.trueMicroFamilyId || row.microFamilyId)
      .filter(Boolean)
  ).filter(isAllowedLongChildId);
}

function longParentIdsFromRows(rows = []) {
  return uniqueStrings(
    rows
      .filter(isLongRow)
      .map((row) => row.parentTrueMicroFamilyId || getMacroFamilyId(row))
      .filter(Boolean)
  ).filter(isAllowedParentId);
}

function filterLongChildIds(ids = []) {
  return uniqueStrings(ids).filter(isAllowedLongChildId);
}

function filterLongParentIds(ids = []) {
  return uniqueStrings(ids).filter(isAllowedParentId);
}

function extractRotationFromPayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return null;

  return (
    payload.nextRotation ||
    payload.rotation ||
    payload.result?.nextRotation ||
    payload.result?.rotation ||
    null
  );
}

function explicitMicroIds(rotation = {}) {
  return filterLongChildIds([
    rotation.microFamilyIds,
    rotation.activeMicroFamilyIds,
    rotation.trueMicroFamilyIds,
    rotation.ids,
    rotation.selectedMicroFamilyId,
    rotation.selectedTrueMicroFamilyId,
    rotation.selectedChildTrueMicroFamilyId
  ]);
}

function explicitParentIds(rotation = {}) {
  return filterLongParentIds([
    rotation.parentTrueMicroFamilyIds,
    rotation.macroFamilyIds,
    rotation.activeMacroFamilyIds,
    rotation.macroIds,
    rotation.selectedParentTrueMicroFamilyId,
    rotation.selectedMacroFamilyId
  ]);
}

function buildIndexes(rows = []) {
  const microFamilyIds = longIdsFromRows(rows);
  const macroFamilyIds = longParentIdsFromRows(rows);

  const microToMacroFamilyId = {};
  const macroToMicroFamilyIds = {};

  for (const row of rows) {
    const microId = String(row.trueMicroFamilyId || row.microFamilyId || row.id || '').trim();
    const macroId = String(row.parentTrueMicroFamilyId || getMacroFamilyId(row) || '').trim();

    if (!microId || !macroId) continue;
    if (!isAllowedLongChildId(microId) || !isAllowedParentId(macroId)) continue;

    microToMacroFamilyId[microId] = macroId;

    if (!macroToMicroFamilyIds[macroId]) {
      macroToMicroFamilyIds[macroId] = [];
    }

    macroToMicroFamilyIds[macroId].push(microId);
  }

  for (const macroId of Object.keys(macroToMicroFamilyIds)) {
    macroToMicroFamilyIds[macroId] = uniqueStrings(macroToMicroFamilyIds[macroId]);
  }

  return {
    microFamilyIds,
    activeMicroFamilyIds: microFamilyIds,
    trueMicroFamilyIds: microFamilyIds,
    childTrueMicroFamilyIds: microFamilyIds,

    macroFamilyIds,
    activeMacroFamilyIds: macroFamilyIds,
    parentTrueMicroFamilyIds: macroFamilyIds,

    microToMacroFamilyId,
    macroToMicroFamilyIds
  };
}

function normalizeLongRotation(rotation = {}, fallback = {}) {
  if (!rotation || typeof rotation !== 'object') {
    return null;
  }

  const rawRows = Array.isArray(rotation.microFamilies)
    ? rotation.microFamilies
    : [];

  const rowsById = new Map();

  for (const row of rawRows) {
    if (isShortRow(row)) continue;

    const normalized = forceLongRow(row, rowsById.size);

    if (!normalized.trueMicroFamilyId) continue;
    if (!normalized.selectableTrueMicroFamilyId) continue;
    if (!isAllowedLongChildId(normalized.trueMicroFamilyId)) continue;

    rowsById.set(normalized.trueMicroFamilyId, normalized);
  }

  const storedMicroIds = explicitMicroIds(rotation);

  for (const id of storedMicroIds) {
    if (rowsById.has(id)) continue;

    rowsById.set(id, buildManualRow(id, rowsById.size));
  }

  const microFamilies = [...rowsById.values()]
    .filter(isLongRow)
    .filter((row) => isAllowedLongChildId(row.trueMicroFamilyId))
    .map((row, index) => forceLongRow({
      ...row,
      rank: index + 1
    }, index));

  const rowIndexes = buildIndexes(microFamilies);

  const microFamilyIds = rowIndexes.microFamilyIds.length
    ? rowIndexes.microFamilyIds
    : storedMicroIds;

  const macroFamilyIds = rowIndexes.macroFamilyIds.length
    ? rowIndexes.macroFamilyIds
    : explicitParentIds(rotation);

  const empty = microFamilyIds.length === 0 && microFamilies.length === 0;

  return {
    ...fallback,
    ...rotation,

    source: rotation.source || fallback.source || 'STORED_LONG_ROTATION_READ_ONLY',

    ...flags(),

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    exact75ChildOnly: true,
    autoRotation: false,
    manualOnly: rotation.manualOnly !== false,
    adminSelected: Boolean(rotation.adminSelected || rotation.manualOnly),

    activeRotationWriteBlocked: true,
    nextRotationWriteBlocked: true,

    bestLong: microFamilies[0] || null,
    bestShort: null,

    missingSides: empty ? [TARGET_TRADE_SIDE] : [],

    empty,
    emptyReason: empty
      ? rotation.emptyReason || 'NO_LONG_75_CHILD_TRUE_MICRO_FAMILIES_AVAILABLE'
      : null,

    microFamilies,

    microFamilyIds,
    activeMicroFamilyIds: microFamilyIds,
    trueMicroFamilyIds: microFamilyIds,
    childTrueMicroFamilyIds: microFamilyIds,

    macroFamilyIds,
    activeMacroFamilyIds: macroFamilyIds,
    parentTrueMicroFamilyIds: macroFamilyIds,

    microToMacroFamilyId: rowIndexes.microToMacroFamilyId,
    macroToMicroFamilyIds: rowIndexes.macroToMicroFamilyIds,

    selectedMicroFamilyId: microFamilies[0]?.trueMicroFamilyId || rotation.selectedMicroFamilyId || null,
    selectedTrueMicroFamilyId: microFamilies[0]?.trueMicroFamilyId || rotation.selectedTrueMicroFamilyId || null,
    selectedChildTrueMicroFamilyId: microFamilies[0]?.childTrueMicroFamilyId || microFamilies[0]?.trueMicroFamilyId || null,
    selectedParentTrueMicroFamilyId: microFamilies[0]?.parentTrueMicroFamilyId || rotation.selectedParentTrueMicroFamilyId || null,
    selectedMacroFamilyId: microFamilies[0]?.parentTrueMicroFamilyId || rotation.selectedMacroFamilyId || null,
    selectedRow: microFamilies[0] || rotation.selectedRow || null,

    count: microFamilyIds.length || microFamilies.length,
    activeCount: microFamilyIds.length || microFamilies.length,
    childMicroCount: microFamilyIds.length || microFamilies.length,
    parentMicroCount: macroFamilyIds.length,

    rawMicroFamiliesCount: rawRows.length,
    ignoredShortMicroFamilies: rawRows.filter(isShortRow).length,
    ignoredNonSelectableParentRows: rawRows.filter((row) => {
      const id = getMicroFamilyId(row);

      return id && isParentLongTaxonomyMicroId(id);
    }).length,
    ignoredNon75ChildRows: rawRows.filter((row) => {
      const id = getMicroFamilyId(row);

      return id && !isSelectable75ChildId(id);
    }).length
  };
}

function sanitizePayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return payload;

  const rotation = extractRotationFromPayload(payload);
  const sanitizedRotation = rotation
    ? normalizeLongRotation(rotation)
    : null;

  return {
    ...payload,

    ...flags(),

    rotation: sanitizedRotation || null,
    nextRotation: sanitizedRotation || null,

    activeRotation: undefined,
    active: undefined,

    bestLong: sanitizedRotation?.bestLong || null,
    bestShort: null,

    microFamilyIds: sanitizedRotation?.microFamilyIds || [],
    trueMicroFamilyIds: sanitizedRotation?.trueMicroFamilyIds || [],
    childTrueMicroFamilyIds: sanitizedRotation?.childTrueMicroFamilyIds || [],
    macroFamilyIds: sanitizedRotation?.macroFamilyIds || [],
    parentTrueMicroFamilyIds: sanitizedRotation?.parentTrueMicroFamilyIds || [],

    selectedMicroFamilies: sanitizedRotation?.microFamilyIds?.length || 0,
    selectedChildMicroFamilies: sanitizedRotation?.childTrueMicroFamilyIds?.length || 0,
    selectedMacroFamilies: sanitizedRotation?.macroFamilyIds?.length || 0
  };
}

function unwrapLockResult(lockResult) {
  if (
    lockResult &&
    typeof lockResult === 'object' &&
    Object.prototype.hasOwnProperty.call(lockResult, 'result')
  ) {
    return lockResult.result;
  }

  return lockResult || null;
}

function payloadOk(lockResult, payload) {
  if (lockResult?.ok === false) return false;
  if (payload?.ok === false) return false;

  return true;
}

function responseReason(payload = {}) {
  return (
    payload.reason ||
    payload.emptyReason ||
    payload.rotation?.emptyReason ||
    payload.nextRotation?.emptyReason ||
    null
  );
}

function errorStatus(error) {
  if (Number.isFinite(error?.statusCode)) return error.statusCode;

  if (
    error?.reason === 'LOCK_NOT_ACQUIRED' ||
    error?.message === 'LOCK_NOT_ACQUIRED' ||
    String(error?.message || '').includes('LOCK')
  ) {
    return 409;
  }

  return 500;
}

async function readRotationState(redis) {
  const [activeRotationRaw, nextRotationRaw, validFrom] = await Promise.all([
    getJson(redis, activeRotationKey(), null).catch(() => null),
    getJson(redis, nextRotationKey(), null).catch(() => null),
    getJson(redis, rotationValidFromKey(), null).catch(() => null)
  ]);

  return {
    activeRotationRaw,
    nextRotationRaw,
    validFrom,

    activeRotation: activeRotationRaw
      ? normalizeLongRotation(activeRotationRaw, {
        source: activeRotationRaw.source || 'ACTIVE_LONG_75_CHILD_ROTATION_READ_ONLY'
      })
      : null,

    nextRotation: nextRotationRaw
      ? normalizeLongRotation(nextRotationRaw, {
        source: nextRotationRaw.source || 'NEXT_LONG_75_CHILD_ROTATION_READ_ONLY'
      })
      : null
  };
}

async function runFreeze({
  req,
  body,
  redis
}) {
  const requestedWeekKey = getRequestedWeekKey(req, body);
  const requestedActiveWeekKey = getRequestedActiveWeekKey(req, body);

  const weekKey = getWeekKey();
  const activeWeekKey = getActiveWeekKey();
  const mode = getRotationMode(req, body);

  const state = await readRotationState(redis);

  const payload = sanitizePayload({
    ok: true,
    skipped: true,
    reason: 'LONG_WEEKLY_FREEZE_DISABLED_MANUAL_SELECTION_ONLY_NO_WRITES',

    ...flags(),

    weekKey,
    requestedWeekKey,
    queryWeekKeyIgnored: requestedWeekKey !== PERSISTENT_LEARNING_KEY
      ? requestedWeekKey
      : null,

    activeWeekKey,
    requestedActiveWeekKey,
    requestedActiveWeekKeyIgnored: requestedActiveWeekKey !== PERSISTENT_LEARNING_KEY
      ? requestedActiveWeekKey
      : null,

    mode,

    activeRotation: state.activeRotation,
    nextRotation: state.nextRotation,
    validFrom: state.validFrom,

    writes: {
      activeRotation: false,
      nextRotation: false,
      rotationValidFrom: false
    }
  });

  return {
    ok: true,
    skipped: true,
    type: 'LONG_WEEKLY_FREEZE_DISABLED_MANUAL_SELECTION_ONLY',

    ...flags(),

    weekKey,
    requestedWeekKey,
    queryWeekKeyIgnored: requestedWeekKey !== PERSISTENT_LEARNING_KEY
      ? requestedWeekKey
      : null,

    activeWeekKey,
    requestedActiveWeekKey,
    requestedActiveWeekKeyIgnored: requestedActiveWeekKey !== PERSISTENT_LEARNING_KEY
      ? requestedActiveWeekKey
      : null,

    mode,

    rotationId: state.nextRotation?.rotationId || null,

    selectedMicroFamilies: state.nextRotation?.microFamilyIds?.length || 0,
    selectedChildMicroFamilies: state.nextRotation?.childTrueMicroFamilyIds?.length || 0,
    selectedMacroFamilies: state.nextRotation?.macroFamilyIds?.length || 0,

    empty: Boolean(state.nextRotation?.empty),
    emptyReason: state.nextRotation?.emptyReason || responseReason(payload),

    microFamilyIds: state.nextRotation?.microFamilyIds || [],
    trueMicroFamilyIds: state.nextRotation?.trueMicroFamilyIds || [],
    childTrueMicroFamilyIds: state.nextRotation?.childTrueMicroFamilyIds || [],
    macroFamilyIds: state.nextRotation?.macroFamilyIds || [],
    parentTrueMicroFamilyIds: state.nextRotation?.parentTrueMicroFamilyIds || [],

    activeRotation: state.activeRotation,
    nextRotation: state.nextRotation,
    validFrom: state.validFrom,

    nextRotationPersisted: false,

    activeProtection: {
      activeRotationPreserved: true,
      activeRotationWriteAttempted: false,
      activeRotationRestored: false
    },

    writes: {
      activeRotation: false,
      nextRotation: false,
      rotationValidFrom: false
    },

    longKeys: {
      namespace: LONG_NAMESPACE,
      prefix: LONG_KEY_PREFIX,
      activeRotation: activeRotationKey(),
      nextRotation: nextRotationKey(),
      rotationValidFrom: rotationValidFromKey(),
      freezeLock: freezeLockKey()
    },

    result: payload
  };
}

async function handleGet(req, res) {
  const startedAt = now();
  const redis = getDurableRedis();

  const state = await readRotationState(redis);

  return res.status(200).json({
    ok: true,
    skipped: true,
    reason: 'GET_READ_ONLY_LONG_WEEKLY_FREEZE_DOES_NOT_BUILD_OR_ACTIVATE',

    ...flags(),

    endpointMode: 'READ_ONLY_FOR_GET',
    cronDisabledExpected: true,

    currentWeekKey: PERSISTENT_LEARNING_KEY,
    nextWeekKey: PERSISTENT_LEARNING_KEY,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,

    activeRotation: state.activeRotation,
    nextRotation: state.nextRotation,
    validFrom: state.validFrom,

    activeRotationId: state.activeRotation?.rotationId || null,
    nextRotationId: state.nextRotation?.rotationId || null,

    activeMicroFamilyIds: state.activeRotation?.microFamilyIds || [],
    activeTrueMicroFamilyIds: state.activeRotation?.trueMicroFamilyIds || [],
    activeChildTrueMicroFamilyIds: state.activeRotation?.childTrueMicroFamilyIds || [],

    nextMicroFamilyIds: state.nextRotation?.microFamilyIds || [],
    nextTrueMicroFamilyIds: state.nextRotation?.trueMicroFamilyIds || [],
    nextChildTrueMicroFamilyIds: state.nextRotation?.childTrueMicroFamilyIds || [],

    activeMacroFamilyIds: state.activeRotation?.macroFamilyIds || [],
    activeParentTrueMicroFamilyIds: state.activeRotation?.parentTrueMicroFamilyIds || [],

    nextMacroFamilyIds: state.nextRotation?.macroFamilyIds || [],
    nextParentTrueMicroFamilyIds: state.nextRotation?.parentTrueMicroFamilyIds || [],

    writes: {
      activeRotation: false,
      nextRotation: false,
      rotationValidFrom: false
    },

    longKeys: {
      namespace: LONG_NAMESPACE,
      prefix: LONG_KEY_PREFIX,
      activeRotation: activeRotationKey(),
      nextRotation: nextRotationKey(),
      rotationValidFrom: rotationValidFromKey(),
      freezeLock: freezeLockKey()
    },

    durationMs: now() - startedAt,
    serverTs: Date.now()
  });
}

async function handlePost(req, res) {
  const startedAt = now();
  const body = await readBody(req);
  const redis = getDurableRedis();

  const lockResult = await withRedisLock(
    redis,
    freezeLockKey(),
    getFreezeLockTtlSec(),
    async () => runFreeze({
      req,
      body,
      redis
    })
  );

  const payload = unwrapLockResult(lockResult);
  const ok = payloadOk(lockResult, payload);

  return res.status(ok ? 200 : 500).json({
    ok,
    skipped: true,

    source: 'API_LONG_WEEKLY_FREEZE_DISABLED_NO_WRITES',
    type: payload?.type || 'LONG_WEEKLY_FREEZE_DISABLED_MANUAL_SELECTION_ONLY',

    reason: payload?.reason || 'LONG_WEEKLY_FREEZE_DISABLED_MANUAL_SELECTION_ONLY_NO_WRITES',

    ...flags(),

    weekKey: payload?.weekKey || getWeekKey(),
    requestedWeekKey: payload?.requestedWeekKey || getRequestedWeekKey(req, body),
    queryWeekKeyIgnored: payload?.queryWeekKeyIgnored || null,

    activeWeekKey: payload?.activeWeekKey || getActiveWeekKey(),
    requestedActiveWeekKey: payload?.requestedActiveWeekKey || getRequestedActiveWeekKey(req, body),
    requestedActiveWeekKeyIgnored: payload?.requestedActiveWeekKeyIgnored || null,

    mode: payload?.mode || getRotationMode(req, body),

    rotationId: payload?.rotationId || null,

    selectedMicroFamilies: payload?.selectedMicroFamilies || 0,
    selectedChildMicroFamilies: payload?.selectedChildMicroFamilies || 0,
    selectedMacroFamilies: payload?.selectedMacroFamilies || 0,

    empty: Boolean(payload?.empty),
    emptyReason: payload?.emptyReason || responseReason(payload),

    microFamilyIds: payload?.microFamilyIds || [],
    trueMicroFamilyIds: payload?.trueMicroFamilyIds || [],
    childTrueMicroFamilyIds: payload?.childTrueMicroFamilyIds || [],
    macroFamilyIds: payload?.macroFamilyIds || [],
    parentTrueMicroFamilyIds: payload?.parentTrueMicroFamilyIds || [],

    activeRotation: payload?.activeRotation || null,
    nextRotation: payload?.nextRotation || null,
    validFrom: payload?.validFrom || null,

    nextRotationPersisted: false,

    activeProtection: payload?.activeProtection || {
      activeRotationPreserved: true,
      activeRotationWriteAttempted: false,
      activeRotationRestored: false
    },

    writes: {
      activeRotation: false,
      nextRotation: false,
      rotationValidFrom: false
    },

    longKeys: {
      namespace: LONG_NAMESPACE,
      prefix: LONG_KEY_PREFIX,
      activeRotation: activeRotationKey(),
      nextRotation: nextRotationKey(),
      rotationValidFrom: rotationValidFromKey(),
      freezeLock: freezeLockKey()
    },

    result: payload?.result || payload,

    lock: {
      ok: lockResult?.ok !== false,
      skipped: Boolean(lockResult?.skipped),
      reason: lockResult?.reason || null
    },

    durationMs: now() - startedAt,
    serverTs: Date.now()
  });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Rotation-Target-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Long-Only', 'true');
  res.setHeader('X-Short-Disabled', 'true');
  res.setHeader('X-Weekly-Freeze-Disabled', 'true');
  res.setHeader('X-Active-Rotation-Preserved', 'true');
  res.setHeader('X-Auto-Activation-Disabled', 'true');
  res.setHeader('X-Manual-Selection-Match-Mode', 'EXACT_TRUE_MICRO_FAMILY_ID');
  res.setHeader('X-Exact-True-Micro-Only', 'true');
  res.setHeader('X-Exact-True-Micro-Family-Schema', CHILD_TRUE_MICRO_SCHEMA);
  res.setHeader('X-Learning-Granularity', LEARNING_GRANULARITY);
  res.setHeader('X-Discord-Selection-Rule', 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY');
  res.setHeader('X-Parent-Match-Does-Not-Trigger-Discord', 'true');
  res.setHeader('X-Macro-Match-Does-Not-Trigger-Discord', 'true');
  res.setHeader('X-No-Writes', 'true');
  res.setHeader('X-Real-Orders-Disabled', 'true');
  res.setHeader('X-Bitget-Orders-Disabled', 'true');
  res.setHeader('X-Exchange-Calls-Disabled', 'true');
  res.setHeader('X-Virtual-Learning-Forced', 'true');
  res.setHeader('X-Persistent-Learning-Key', PERSISTENT_LEARNING_KEY);
  res.setHeader('X-Redis-Namespace', LONG_NAMESPACE);
  res.setHeader('X-Short-Root-Touched', 'false');

  try {
    if (req.method === 'GET') {
      return await handleGet(req, res);
    }

    if (req.method === 'POST') {
      return await handlePost(req, res);
    }

    return methodNotAllowed(res);
  } catch (error) {
    return res.status(errorStatus(error)).json({
      ok: false,

      ...flags(),

      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}