// ================= FILE: api/analyze/activate-rotation.js =================

import { randomUUID } from 'node:crypto';

import { KEYS } from '../../src/keys.js';
import {
  getDurableRedis,
  getJson,
  setJson
} from '../../src/redis.js';
import { withRedisLock } from '../../src/lock.js';
import {
  sideToTradeSide
} from '../../src/utils.js';
import { getWeekMicros } from '../../src/analyze/analyzeEngine.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;

const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';
const MIN_COMPLETED_ACTIVE_LEARNING = 20;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;

const LOCK_TTL_SEC = 600;

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

    activateLock: namespacedLongKey(
      KEYS.long?.analyze?.activateLock ||
        KEYS.analyze?.longActivateLock ||
        KEYS.analyze?.activateLock,
      'ANALYZE:ROTATION_ACTIVATE_LOCK'
    )
  }
};

function activeRotationKey() {
  return LONG_KEYS.analyze.activeRotation;
}

function activateLockKey() {
  return LONG_KEYS.analyze.activateLock;
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

    manualSelectionOnly: true,
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    manualSelectionMustUseSelectable75ChildId: true,
    manualOnly: true,
    adminSelected: true,

    autoRotation: false,
    autoRotationDisabled: true,
    autoRotationActivationDisabled: true,
    autoBootstrapDisabled: true,
    activateNextRotationDisabled: true,
    activateFreezeCronDisabled: true,
    buildFreshRotationDisabled: true,
    resetCronDisabled: true,

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
            value.microFamilyId,
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

function parseIdList(value) {
  if (!value) return [];

  if (Array.isArray(value)) return uniqueStrings(value);

  if (typeof value === 'string') {
    return uniqueStrings(value.split(/[\s,;\n\r]+/g));
  }

  if (typeof value === 'object') {
    return uniqueStrings([
      value.trueMicroFamilyIds,
      value.activeMicroFamilyIds,
      value.microFamilyIds,
      value.ids,
      value.trueMicroFamilyId,
      value.childTrueMicroFamilyId,
      value.microFamilyId,
      value.id,
      value.key
    ]);
  }

  return [];
}

function extractMicroFamilyIds(req, body = {}) {
  const q = req.query || {};

  return uniqueStrings([
    parseIdList(body.trueMicroFamilyIds),
    parseIdList(body.activeMicroFamilyIds),
    parseIdList(body.microFamilyIds),
    parseIdList(body.ids),
    parseIdList(body.trueMicroFamilyId),
    parseIdList(body.childTrueMicroFamilyId),
    parseIdList(body.microFamilyId),
    parseIdList(body.id),

    parseIdList(q.trueMicroFamilyIds),
    parseIdList(q.activeMicroFamilyIds),
    parseIdList(q.microFamilyIds),
    parseIdList(q.ids),
    parseIdList(q.trueMicroFamilyId),
    parseIdList(q.childTrueMicroFamilyId),
    parseIdList(q.microFamilyId),
    parseIdList(q.id)
  ]);
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

function parseLongTaxonomyMicroId(id = '') {
  const value = upper(id);

  if (!value.startsWith('MICRO_LONG_')) {
    return {
      valid: false,
      selectable: false,
      isParent: false,
      isChild: false,
      rawId: String(id || '').trim(),
      parentTrueMicroFamilyId: null,
      childTrueMicroFamilyId: null
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
  const parsed = parseLongTaxonomyMicroId(id);

  return parsed.selectable === true;
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

  const values = [
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
  ];

  for (const value of values) {
    const side = inferTradeSideFromText(value);

    if (side !== 'UNKNOWN') return side;
  }

  if (row.longOnly === true || row.shortDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  if (row.shortOnly === true || row.longDisabled === true) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
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

function isTargetSideRow(row = {}) {
  const taxonomy = resolveTaxonomyIds(row);
  const id = taxonomy.trueMicroFamilyId;

  if (!id) return false;
  if (!validLearningId(id)) return false;
  if (!taxonomy.selectableTrueMicroFamilyId) return false;

  return inferRowTradeSide({
    ...row,
    trueMicroFamilyId: id,
    parentTrueMicroFamilyId: taxonomy.parentTrueMicroFamilyId,
    childTrueMicroFamilyId: taxonomy.childTrueMicroFamilyId
  }) !== OPPOSITE_TRADE_SIDE;
}

function isAllowedTargetId(id = '') {
  const value = String(id || '').trim();

  if (!value) return false;
  if (!validLearningId(value)) return false;
  if (!isSelectable75ChildId(value)) return false;

  return inferTradeSideFromText(value) !== OPPOSITE_TRADE_SIDE;
}

function filterTargetIds(ids = []) {
  return uniqueStrings(ids).filter(isAllowedTargetId);
}

function ignoredIds(requestedIds = [], acceptedIds = []) {
  const accepted = new Set(acceptedIds);

  return uniqueStrings(requestedIds)
    .filter((id) => !accepted.has(id))
    .map((id) => {
      const side = inferTradeSideFromText(id);

      return {
        id,
        reason: side === OPPOSITE_TRADE_SIDE
          ? 'SHORT_DISABLED_LONG_ONLY'
          : isScannerFingerprintId(id)
            ? 'SCANNER_FINGERPRINT_METADATA_ONLY_NOT_SELECTABLE'
            : isExecutionFingerprintId(id)
              ? 'EXECUTION_FINGERPRINT_METADATA_ONLY_NOT_SELECTABLE'
              : isParentLongTaxonomyMicroId(id)
                ? 'PARENT_15_METADATA_ONLY_SELECT_EXACT_75_CHILD'
                : !isSelectable75ChildId(id)
                  ? 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_REQUIRED'
                  : 'INVALID_OR_NON_LONG_TRUE_MICRO_FAMILY_ID'
      };
    });
}

function getRequestedWeekKey(req, body = {}) {
  return String(
    firstValue(
      body.weekKey,
      firstValue(req.query?.weekKey, PERSISTENT_LEARNING_KEY)
    ) || PERSISTENT_LEARNING_KEY
  ).trim();
}

function getWeekKey() {
  return PERSISTENT_LEARNING_KEY;
}

function getMode(req, body = {}) {
  return String(
    firstValue(
      body.mode,
      firstValue(req.query?.mode, 'manual')
    ) || 'manual'
  ).trim();
}

function sourceEntries(value = {}) {
  if (Array.isArray(value)) {
    return value.map((row, index) => [
      getMicroFamilyId(row, String(index)),
      row
    ]);
  }

  if (!value || typeof value !== 'object') return [];

  return Object.entries(value);
}

function completedOf(row = {}) {
  return Number(row.completed || row.outcomeSample || row.virtualCompleted || 0) || 0;
}

function statusFor(row = {}) {
  const completed = completedOf(row);

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

    source: row.source || 'MANUAL_SELECTION',
    selectedTier: row.selectedTier || row.rotationEligibilityTier || 'MANUAL',
    rotationEligibilityTier: row.rotationEligibilityTier || row.selectedTier || 'MANUAL',

    learningStatus: row.learningStatus || statusFor(row),
    status: row.status || row.learningStatus || statusFor(row),

    manualOnly: true,
    adminSelected: true,
    autoRotation: false,

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

    seen: 0,
    observations: 0,
    completed: 0,
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

    avgR: 0,
    totalR: 0,
    netTotalR: 0,
    virtualTotalR: 0,
    shadowTotalR: 0,
    realTotalR: 0,
    profitFactor: 0,

    totalCostR: 0,
    avgCostR: 0,

    selectedTier: 'MANUAL',
    rotationEligibilityTier: 'MANUAL',
    learningStatus: 'OBSERVING',
    status: 'OBSERVING',

    fixedTaxonomyLearningId: true,
    parentFixedTaxonomyLearningId: true,
    childFixedTaxonomyLearningId: true,
    selectableTrueMicroFamilyId: true,
    trueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,

    definitionParts: [
      `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
      'MANUAL_SELECTION=true',
      'EXACT_TRUE_MICRO_FAMILY_ID=true',
      'EXACT_75_CHILD=true'
    ],
    definition: `TRADE_SIDE=${TARGET_TRADE_SIDE} | MANUAL_SELECTION=true | EXACT_TRUE_MICRO_FAMILY_ID=true | EXACT_75_CHILD=true`
  }, index);
}

async function loadLearningRowsForIds(ids = []) {
  const accepted = new Set(filterTargetIds(ids));

  if (accepted.size <= 0) return [];

  const micros = await getWeekMicros(PERSISTENT_LEARNING_KEY).catch(() => ({}));
  const rows = [];

  for (const [key, row] of sourceEntries(micros)) {
    const taxonomy = resolveTaxonomyIds(row, key);
    const microFamilyId = taxonomy.trueMicroFamilyId;

    if (!microFamilyId || !accepted.has(microFamilyId)) continue;

    const candidate = {
      ...(row || {}),
      key,
      microFamilyId,
      trueMicroFamilyId: microFamilyId,
      childTrueMicroFamilyId: taxonomy.childTrueMicroFamilyId,
      parentTrueMicroFamilyId: taxonomy.parentTrueMicroFamilyId,
      coarseMicroFamilyId: taxonomy.parentTrueMicroFamilyId,
      macroFamilyId: taxonomy.parentTrueMicroFamilyId,
      parentMacroFamilyId: taxonomy.parentTrueMicroFamilyId,
      sourceWeekKey: PERSISTENT_LEARNING_KEY,
      sourceWeekPrimary: true
    };

    if (!isTargetSideRow(candidate)) continue;

    rows.push(candidate);
  }

  return rows;
}

function buildSelectionIndexes(rows = []) {
  const microFamilyIds = uniqueStrings(
    rows.map((row) => row.trueMicroFamilyId || row.microFamilyId || row.id)
  ).filter(isAllowedTargetId);

  const macroFamilyIds = uniqueStrings(
    rows.map((row) => row.parentTrueMicroFamilyId || getMacroFamilyId(row))
  )
    .filter(validLearningId)
    .filter((id) => inferTradeSideFromText(id) !== OPPOSITE_TRADE_SIDE)
    .filter(isParentLongTaxonomyMicroId);

  const microToMacroFamilyId = {};
  const macroToMicroFamilyIds = {};

  for (const row of rows) {
    const microId = String(row.trueMicroFamilyId || row.microFamilyId || row.id || '').trim();
    const macroId = String(row.parentTrueMicroFamilyId || getMacroFamilyId(row) || '').trim();

    if (!microId || !macroId) continue;
    if (!isAllowedTargetId(microId)) continue;
    if (!isParentLongTaxonomyMicroId(macroId)) continue;

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

    macroFamilyIds,
    activeMacroFamilyIds: macroFamilyIds,

    microToMacroFamilyId,
    macroToMicroFamilyIds
  };
}

async function normalizeManualActiveRotation({
  requestedMicroFamilyIds = [],
  acceptedMicroFamilyIds = [],
  weekKey,
  mode
} = {}) {
  const acceptedSet = new Set(acceptedMicroFamilyIds);
  const learningRows = await loadLearningRowsForIds(acceptedMicroFamilyIds);

  const rowsById = new Map();

  for (const [index, row] of learningRows.entries()) {
    const normalized = forceLongRow(row, index);

    if (!normalized.trueMicroFamilyId) continue;
    if (!acceptedSet.has(normalized.trueMicroFamilyId)) continue;
    if (!normalized.selectableTrueMicroFamilyId) continue;

    rowsById.set(normalized.trueMicroFamilyId, normalized);
  }

  for (const id of acceptedMicroFamilyIds) {
    if (rowsById.has(id)) continue;

    rowsById.set(id, buildManualRow(id, rowsById.size));
  }

  const microFamilies = [...rowsById.values()]
    .filter(isTargetSideRow)
    .filter((row) => isAllowedTargetId(row.trueMicroFamilyId))
    .map((row, index) => forceLongRow({
      ...row,
      rank: index + 1
    }, index));

  const indexes = buildSelectionIndexes(microFamilies);
  const empty = microFamilies.length === 0;

  return {
    rotationId: `ROT_MANUAL_LONG_75_${randomUUID()}`,

    source: 'ADMIN_MANUAL_SELECTION_LONG_ONLY_EXACT_75_CHILD',
    mode: mode || 'manual',
    sideMode: 'long_only',

    sourceWeekKey: weekKey,
    activeWeekKey: weekKey,

    generatedAt: now(),
    activatedAt: now(),

    ...flags(),

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    exact75ChildOnly: true,
    manualOnly: true,
    adminSelected: true,
    autoRotation: false,
    liveSelectable: !empty,

    empty,
    emptyReason: empty
      ? 'NO_VALID_LONG_75_CHILD_TRUE_MICRO_FAMILY_IDS_SELECTED'
      : null,

    requestedMicroFamilyIds: uniqueStrings(requestedMicroFamilyIds),
    ignoredRequestedIds: ignoredIds(requestedMicroFamilyIds, acceptedMicroFamilyIds),

    requestedParentMicroFamilyIds: uniqueStrings(requestedMicroFamilyIds)
      .filter(isParentLongTaxonomyMicroId),
    parentMicroFamilyIdsMetadataOnly: indexes.macroFamilyIds,

    ...indexes,

    microFamilies,

    selectedMicroFamilyId: microFamilies[0]?.trueMicroFamilyId || null,
    selectedTrueMicroFamilyId: microFamilies[0]?.trueMicroFamilyId || null,
    selectedChildTrueMicroFamilyId: microFamilies[0]?.childTrueMicroFamilyId || microFamilies[0]?.trueMicroFamilyId || null,
    selectedParentTrueMicroFamilyId: microFamilies[0]?.parentTrueMicroFamilyId || null,
    selectedMacroFamilyId: microFamilies[0]?.parentTrueMicroFamilyId || microFamilies[0]?.macroFamilyId || null,
    selectedRow: microFamilies[0] || null,

    bestLong: microFamilies[0] || null,
    bestShort: null,

    missingSides: empty ? [TARGET_TRADE_SIDE] : [],

    count: microFamilies.length,
    activeCount: microFamilies.length,
    microCount: microFamilies.length,
    trueMicroCount: microFamilies.length,
    childMicroCount: microFamilies.length,
    parentMicroCount: indexes.macroFamilyIds.length,
    macroCount: indexes.macroFamilyIds.length
  };
}

function storedRotationIds(active = {}) {
  return filterTargetIds([
    active.microFamilyIds,
    active.activeMicroFamilyIds,
    active.trueMicroFamilyIds,
    active.ids,
    ...(Array.isArray(active.microFamilies)
      ? active.microFamilies.map((row) => getMicroFamilyId(row))
      : [])
  ]);
}

async function readStoredActiveRotation(redis) {
  const active = await getJson(redis, activeRotationKey(), null).catch(() => null);

  if (!active) return null;

  const storedIds = storedRotationIds(active);

  const rowsById = new Map();

  if (Array.isArray(active.microFamilies)) {
    for (const row of active.microFamilies) {
      if (!isTargetSideRow(row)) continue;

      const normalized = forceLongRow(row, rowsById.size);

      if (!normalized.trueMicroFamilyId) continue;
      if (!normalized.selectableTrueMicroFamilyId) continue;

      rowsById.set(normalized.trueMicroFamilyId, normalized);
    }
  }

  for (const id of storedIds) {
    if (rowsById.has(id)) continue;

    rowsById.set(id, buildManualRow(id, rowsById.size));
  }

  const rows = [...rowsById.values()]
    .filter(isTargetSideRow)
    .filter((row) => isAllowedTargetId(row.trueMicroFamilyId))
    .map((row, index) => forceLongRow({
      ...row,
      rank: index + 1
    }, index));

  const indexes = buildSelectionIndexes(rows);

  return {
    ...active,
    ...flags(),

    microFamilies: rows,

    microFamilyIds: indexes.microFamilyIds,
    activeMicroFamilyIds: indexes.activeMicroFamilyIds,
    trueMicroFamilyIds: indexes.trueMicroFamilyIds,

    macroFamilyIds: indexes.macroFamilyIds,
    activeMacroFamilyIds: indexes.activeMacroFamilyIds,

    microToMacroFamilyId: indexes.microToMacroFamilyId,
    macroToMicroFamilyIds: indexes.macroToMicroFamilyIds,

    bestLong: rows[0] || null,
    bestShort: null,

    selectedMicroFamilyId: rows[0]?.trueMicroFamilyId || active.selectedMicroFamilyId || null,
    selectedTrueMicroFamilyId: rows[0]?.trueMicroFamilyId || active.selectedTrueMicroFamilyId || null,
    selectedChildTrueMicroFamilyId: rows[0]?.childTrueMicroFamilyId || rows[0]?.trueMicroFamilyId || null,
    selectedParentTrueMicroFamilyId: rows[0]?.parentTrueMicroFamilyId || null,
    selectedMacroFamilyId: rows[0]?.parentTrueMicroFamilyId || active.selectedMacroFamilyId || null,
    selectedRow: rows[0] || active.selectedRow || null,

    manualOnly: active.manualOnly !== false,
    adminSelected: active.adminSelected !== false,
    autoRotation: false,

    count: indexes.activeMicroFamilyIds.length,
    activeCount: indexes.activeMicroFamilyIds.length,
    microCount: indexes.activeMicroFamilyIds.length,
    trueMicroCount: indexes.activeMicroFamilyIds.length,
    childMicroCount: indexes.activeMicroFamilyIds.length,
    parentMicroCount: indexes.activeMacroFamilyIds.length,
    macroCount: indexes.activeMacroFamilyIds.length,

    empty: indexes.activeMicroFamilyIds.length === 0,
    emptyReason: indexes.activeMicroFamilyIds.length === 0
      ? 'NO_MANUAL_LONG_75_CHILD_TRUE_MICRO_FAMILY_SELECTION_ACTIVE'
      : null
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

async function activateManualSelection({
  redis,
  requestedMicroFamilyIds,
  acceptedMicroFamilyIds,
  weekKey,
  mode
}) {
  if (acceptedMicroFamilyIds.length <= 0) {
    return {
      ok: false,
      skipped: true,
      reason: requestedMicroFamilyIds.some((id) => inferTradeSideFromText(id) === OPPOSITE_TRADE_SIDE)
        ? 'SHORT_DISABLED_LONG_ONLY'
        : 'NO_VALID_LONG_75_CHILD_TRUE_MICRO_FAMILY_IDS',

      ...flags(),

      weekKey,
      mode,

      requestedMicroFamilyIds,
      acceptedMicroFamilyIds: [],
      acceptedTrueMicroFamilyIds: [],
      ignoredRequestedIds: ignoredIds(requestedMicroFamilyIds, [])
    };
  }

  const activeRotation = await normalizeManualActiveRotation({
    requestedMicroFamilyIds,
    acceptedMicroFamilyIds,
    weekKey,
    mode
  });

  await setJson(
    redis,
    activeRotationKey(),
    activeRotation
  );

  return {
    ok: true,
    skipped: false,
    type: 'MANUAL_LONG_75_CHILD_TRUE_MICRO_FAMILY_ROTATION_ACTIVATED',

    ...flags(),

    weekKey,
    activeWeekKey: weekKey,
    mode: mode || 'manual',

    rotationId: activeRotation.rotationId,

    activatedCount: activeRotation.microFamilies.length,
    activatedMicroCount: activeRotation.activeMicroFamilyIds.length,
    activatedTrueMicroCount: activeRotation.activeMicroFamilyIds.length,
    activatedChildMicroCount: activeRotation.activeMicroFamilyIds.length,
    activatedMacroCount: activeRotation.activeMacroFamilyIds.length,

    requestedMicroFamilyIds,
    acceptedMicroFamilyIds,
    acceptedTrueMicroFamilyIds: acceptedMicroFamilyIds,
    acceptedChildTrueMicroFamilyIds: acceptedMicroFamilyIds,
    ignoredRequestedIds: activeRotation.ignoredRequestedIds,

    activeMicroFamilyIds: activeRotation.activeMicroFamilyIds,
    activeTrueMicroFamilyIds: activeRotation.trueMicroFamilyIds,
    activeChildTrueMicroFamilyIds: activeRotation.trueMicroFamilyIds,
    activeMacroFamilyIds: activeRotation.activeMacroFamilyIds,
    activeParentTrueMicroFamilyIds: activeRotation.activeMacroFamilyIds,

    activeRotation,
    active: activeRotation,

    engineResult: null,
    engineSkipped: true,
    engineSkipReason: 'DIRECT_LONG_NAMESPACE_MANUAL_75_CHILD_SELECTION_WRITE_AVOIDS_SHORT_ROOT_COLLISION',

    warnings: [
      activeRotation.microFamilies.some((row) => row.source === 'MANUAL_SELECTION')
        ? 'MANUAL_ROWS_USED_FOR_IDS_NOT_FOUND_IN_LONG_LIVE_MICROS'
        : null
    ].filter(Boolean)
  };
}

async function handleGet(req, res) {
  const startedAt = now();
  const redis = getDurableRedis();
  const activeRotation = await readStoredActiveRotation(redis);

  return res.status(200).json({
    ok: true,
    skipped: true,
    reason: 'AUTO_ROTATION_ENDPOINT_DISABLED_MANUAL_SELECTION_ONLY',

    ...flags(),

    endpointMode: 'READ_ONLY_FOR_GET',
    cronSafe: true,

    currentWeekKey: PERSISTENT_LEARNING_KEY,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,

    activeRotation,
    active: activeRotation,

    activeRotationId: activeRotation?.rotationId || null,
    activeMicroFamilyIds: activeRotation?.activeMicroFamilyIds || [],
    activeTrueMicroFamilyIds: activeRotation?.trueMicroFamilyIds || activeRotation?.activeMicroFamilyIds || [],
    activeChildTrueMicroFamilyIds: activeRotation?.trueMicroFamilyIds || activeRotation?.activeMicroFamilyIds || [],
    activeMacroFamilyIds: activeRotation?.activeMacroFamilyIds || [],
    activeParentTrueMicroFamilyIds: activeRotation?.activeMacroFamilyIds || [],

    activatedCount: activeRotation?.activeMicroFamilyIds?.length || 0,

    longKeys: {
      namespace: LONG_NAMESPACE,
      prefix: LONG_KEY_PREFIX,
      activeRotation: activeRotationKey(),
      activateLock: activateLockKey()
    },

    durationMs: now() - startedAt,
    serverTs: Date.now()
  });
}

async function handlePost(req, res) {
  const startedAt = now();
  const body = await readBody(req);
  const redis = getDurableRedis();

  const requestedMicroFamilyIds = extractMicroFamilyIds(req, body);
  const acceptedMicroFamilyIds = filterTargetIds(requestedMicroFamilyIds);

  const requestedWeekKey = getRequestedWeekKey(req, body);
  const weekKey = getWeekKey();
  const mode = getMode(req, body);

  const hasManualIds = requestedMicroFamilyIds.length > 0;

  if (!hasManualIds) {
    const activeRotation = await readStoredActiveRotation(redis);

    return res.status(200).json({
      ok: true,
      skipped: true,
      reason: 'AUTO_ACTIVATION_DISABLED_MANUAL_LONG_75_CHILD_TRUE_MICRO_IDS_REQUIRED',

      ...flags(),

      blockedAutoActions: [
        'activateNextRotation',
        'buildRotationFromWeek',
        'autoBuildIfMissing',
        'weeklyFreezeActivation',
        'activateBestBalanced',
        'activateBestLongMicroFamily',
        'activateBestBullMicroFamily'
      ],

      currentWeekKey: PERSISTENT_LEARNING_KEY,
      weekKey,
      requestedWeekKey,
      queryWeekKeyIgnored: requestedWeekKey !== PERSISTENT_LEARNING_KEY
        ? requestedWeekKey
        : null,
      mode,

      activeRotation,
      active: activeRotation,

      activeRotationId: activeRotation?.rotationId || null,
      activeMicroFamilyIds: activeRotation?.activeMicroFamilyIds || [],
      activeTrueMicroFamilyIds: activeRotation?.trueMicroFamilyIds || activeRotation?.activeMicroFamilyIds || [],
      activeChildTrueMicroFamilyIds: activeRotation?.trueMicroFamilyIds || activeRotation?.activeMicroFamilyIds || [],
      activeMacroFamilyIds: activeRotation?.activeMacroFamilyIds || [],
      activeParentTrueMicroFamilyIds: activeRotation?.activeMacroFamilyIds || [],

      requestedMicroFamilyIds: [],
      acceptedMicroFamilyIds: [],
      acceptedTrueMicroFamilyIds: [],
      acceptedChildTrueMicroFamilyIds: [],
      ignoredRequestedIds: [],

      longKeys: {
        namespace: LONG_NAMESPACE,
        prefix: LONG_KEY_PREFIX,
        activeRotation: activeRotationKey(),
        activateLock: activateLockKey()
      },

      durationMs: now() - startedAt,
      serverTs: Date.now()
    });
  }

  const lockResult = await withRedisLock(
    redis,
    activateLockKey(),
    LOCK_TTL_SEC,
    async () => activateManualSelection({
      redis,
      requestedMicroFamilyIds,
      acceptedMicroFamilyIds,
      weekKey,
      mode
    })
  );

  const result = unwrapLockResult(lockResult);

  const ok = lockResult?.ok === false || result?.ok === false
    ? false
    : true;

  return res.status(ok ? 200 : 400).json({
    ok,
    skipped: Boolean(lockResult?.skipped || result?.skipped),

    source: 'ADMIN_MANUAL_ACTIVATE_LONG_75_CHILD_TRUE_MICRO_FAMILIES_ONLY',
    type: result?.type || null,

    ...flags(),

    weekKey,
    requestedWeekKey,
    queryWeekKeyIgnored: requestedWeekKey !== PERSISTENT_LEARNING_KEY
      ? requestedWeekKey
      : null,
    mode,

    rotationId: result?.rotationId || result?.activeRotation?.rotationId || null,

    activatedCount: result?.activatedCount || 0,
    activatedMicroCount: result?.activatedMicroCount || 0,
    activatedTrueMicroCount: result?.activatedTrueMicroCount || 0,
    activatedChildMicroCount: result?.activatedChildMicroCount || 0,
    activatedMacroCount: result?.activatedMacroCount || 0,

    requestedMicroFamilyIds,
    acceptedMicroFamilyIds,
    acceptedTrueMicroFamilyIds: acceptedMicroFamilyIds,
    acceptedChildTrueMicroFamilyIds: acceptedMicroFamilyIds,
    ignoredRequestedIds: ignoredIds(requestedMicroFamilyIds, acceptedMicroFamilyIds),

    activeMicroFamilyIds: result?.activeMicroFamilyIds || [],
    activeTrueMicroFamilyIds: result?.activeTrueMicroFamilyIds || result?.activeMicroFamilyIds || [],
    activeChildTrueMicroFamilyIds: result?.activeChildTrueMicroFamilyIds || result?.activeMicroFamilyIds || [],
    activeMacroFamilyIds: result?.activeMacroFamilyIds || [],
    activeParentTrueMicroFamilyIds: result?.activeParentTrueMicroFamilyIds || result?.activeMacroFamilyIds || [],

    reason: result?.reason || lockResult?.reason || null,
    warnings: result?.warnings || [],

    result,

    longKeys: {
      namespace: LONG_NAMESPACE,
      prefix: LONG_KEY_PREFIX,
      activeRotation: activeRotationKey(),
      activateLock: activateLockKey()
    },

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
  res.setHeader('X-Auto-Rotation-Disabled', 'true');
  res.setHeader('X-Manual-Selection-Only', 'true');
  res.setHeader('X-Manual-Selection-Match-Mode', 'EXACT_TRUE_MICRO_FAMILY_ID');
  res.setHeader('X-Exact-True-Micro-Only', 'true');
  res.setHeader('X-Exact-True-Micro-Family-Schema', CHILD_TRUE_MICRO_SCHEMA);
  res.setHeader('X-Learning-Granularity', LEARNING_GRANULARITY);
  res.setHeader('X-Discord-Selection-Rule', 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY');
  res.setHeader('X-Parent-Match-Does-Not-Trigger-Discord', 'true');
  res.setHeader('X-Macro-Match-Does-Not-Trigger-Discord', 'true');
  res.setHeader('X-Real-Orders-Disabled', 'true');
  res.setHeader('X-Bitget-Orders-Disabled', 'true');
  res.setHeader('X-Exchange-Calls-Disabled', 'true');
  res.setHeader('X-Virtual-Only', 'true');
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