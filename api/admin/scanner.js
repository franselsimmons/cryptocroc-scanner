// ================= FILE: api/admin/scanner.js =================

import { KEYS } from '../../src/keys.js';
import {
  getVolatileRedis,
  getJson,
  getKeys
} from '../../src/redis.js';
import { sideToTradeSide, safeNumber } from '../../src/utils.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const TARGET_SCANNER_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;

const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';

const ADMIN_SCANNER_BUILD_ID = 'LONG_ADMIN_SCANNER_SAFE_ARRAY_2026_06_23_V1';

const SNAPSHOT_SEARCH_LIMIT = 80;
const STALE_8M_SEC = 8 * 60;
const STALE_30M_SEC = 30 * 60;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;
const MIN_COMPLETED_ACTIVE_LEARNING = 20;

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

function asArray(value) {
  if (Array.isArray(value)) return value;

  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.result)) return value.result;
  if (Array.isArray(value?.rows)) return value.rows;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.list)) return value.list;
  if (Array.isArray(value?.candidates)) return value.candidates;
  if (Array.isArray(value?.tickers)) return value.tickers;
  if (Array.isArray(value?.symbols)) return value.symbols;
  if (Array.isArray(value?.universe)) return value.universe;

  if (Array.isArray(value?.payload?.candidates)) return value.payload.candidates;
  if (Array.isArray(value?.payload?.rows)) return value.payload.rows;
  if (Array.isArray(value?.snapshot?.candidates)) return value.snapshot.candidates;
  if (Array.isArray(value?.latest?.candidates)) return value.latest.candidates;

  if (Array.isArray(value?.data?.data)) return value.data.data;
  if (Array.isArray(value?.data?.result)) return value.data.result;
  if (Array.isArray(value?.data?.rows)) return value.data.rows;
  if (Array.isArray(value?.data?.items)) return value.data.items;
  if (Array.isArray(value?.data?.list)) return value.data.list;
  if (Array.isArray(value?.data?.candidates)) return value.data.candidates;
  if (Array.isArray(value?.data?.tickers)) return value.data.tickers;
  if (Array.isArray(value?.data?.symbols)) return value.data.symbols;
  if (Array.isArray(value?.data?.universe)) return value.data.universe;

  if (Array.isArray(value?.result?.data)) return value.result.data;
  if (Array.isArray(value?.result?.rows)) return value.result.rows;
  if (Array.isArray(value?.result?.items)) return value.result.items;
  if (Array.isArray(value?.result?.list)) return value.result.list;
  if (Array.isArray(value?.result?.candidates)) return value.result.candidates;
  if (Array.isArray(value?.result?.tickers)) return value.result.tickers;
  if (Array.isArray(value?.result?.symbols)) return value.result.symbols;
  if (Array.isArray(value?.result?.universe)) return value.result.universe;

  return [];
}

function shapeOf(value) {
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length
    };
  }

  if (value && typeof value === 'object') {
    return {
      type: 'object',
      keys: Object.keys(value).slice(0, 30),
      snapshotId: value.snapshotId || value.id || value.scanId || null,
      hasCandidatesArray: Array.isArray(value.candidates),
      hasRowsArray: Array.isArray(value.rows),
      hasResult: Boolean(value.result),
      hasData: Boolean(value.data)
    };
  }

  return {
    type: typeof value
  };
}

function namespacedLongKey(key, fallback = null) {
  const raw = String(key || fallback || '').trim();

  if (!raw) return null;
  if (raw.startsWith(LONG_KEY_PREFIX)) return raw;

  return `${LONG_KEY_PREFIX}${raw}`;
}

function callMaybe(fn, arg, fallback) {
  try {
    if (typeof fn === 'function') return fn(arg);
  } catch {
    return fallback;
  }

  return fallback;
}

const LONG_KEYS = {
  scan: {
    latest: namespacedLongKey(
      KEYS.long?.scan?.latest ||
        KEYS.scan?.longLatest ||
        KEYS.scan?.latest,
      'SCAN:LATEST'
    ),

    snapshotPattern: namespacedLongKey(
      callMaybe(KEYS.long?.scan?.snapshot, '*', null) ||
        callMaybe(KEYS.scan?.longSnapshot, '*', null) ||
        callMaybe(KEYS.scan?.snapshot, '*', null),
      'SCAN:SNAPSHOT:*'
    ),

    snapshot: (snapshotId) => namespacedLongKey(
      callMaybe(KEYS.long?.scan?.snapshot, snapshotId, null) ||
        callMaybe(KEYS.scan?.longSnapshot, snapshotId, null) ||
        callMaybe(KEYS.scan?.snapshot, snapshotId, null),
      `SCAN:SNAPSHOT:${snapshotId}`
    )
  }
};

function now() {
  return Date.now();
}

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET'],
    ...modeFlags()
  });
}

function taxonomyMeta() {
  return {
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,

    parentMicroFamilyCount: 15,
    selectableChildMicroFamilyCount: 75,

    setups: SETUP_ORDER,
    regimes: REGIME_ORDER,
    confirmationProfiles: CONFIRMATION_PROFILE_ORDER,

    validSetupTypes: [...LONG_FIXED_SETUP_TYPES],
    validRegimeBuckets: [...LONG_FIXED_REGIME_BUCKETS],
    validConfirmationProfiles: [...LONG_CONFIRMATION_PROFILES],

    parentFormat: 'MICRO_LONG_{SETUP}_{REGIME}',
    selectableChildFormat: 'MICRO_LONG_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',

    exampleParent: 'MICRO_LONG_BREAKOUT_TREND',
    exampleSelectableChild: 'MICRO_LONG_BREAKOUT_TREND_A_STRONG_ALIGN',

    selectableIdsAreChildrenOnly: true,
    parentIdsAreMetadataOnly: true,
    scannerCreatesNoLearningFamily: true,
    analyzeCreatesTrueMicroFamily: true
  };
}

function modeFlags() {
  return {
    adminScannerBuildId: ADMIN_SCANNER_BUILD_ID,

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

    scannerOnly: true,
    scannerDoesNotTrade: true,
    scannerDoesNotSelectMicroFamilies: true,
    scannerDoesNotSendDiscord: true,
    scannerDoesNotWriteLearningFamilies: true,

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
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    fixedTaxonomyPreferred: true,
    learningGranularity: LEARNING_GRANULARITY,

    parentMicroFamilyCount: 15,
    selectableChildMicroFamilyCount: 75,
    parentFamilyRule: 'MICRO_LONG_{SETUP}_{REGIME}',
    selectableFamilyRule: 'MICRO_LONG_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',
    selectableIdsAreChildrenOnly: true,
    parentIdsAreMetadataOnly: true,

    virtualLearning: true,
    virtualLearningForced: true,
    virtualOnly: true,
    virtualTracked: true,
    virtualOutcomesIncluded: true,
    shadowOutcomesIncluded: true,
    realOutcomesExcluded: true,
    learningOutcomesOnly: true,
    outcomesSourceMode: 'VIRTUAL_AND_SHADOW_NET_OUTCOMES',
    outcomeSource: 'VIRTUAL',

    observationFirst: true,
    netOutcomesOnly: true,
    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,

    globalMaxOpenPositionsBlockDisabled: true,
    maxOneOpenPositionPerSymbol: true,
    positionTimeStopMinDefault: DEFAULT_POSITION_TIME_STOP_MIN,
    longRiskShape: 'sl < entry < tp',
    tpRule: 'price >= tp',
    slRule: 'price <= sl',
    timeStopEnabled: true,

    manualSelectionOnly: true,
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    manualSelectionMustUseSelectable75ChildId: true,
    autoRotationActivationDisabled: true,
    activateFreezeCronDisabled: true,
    resetCronDisabled: true,
    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForExactTrueMicroMatch: true,
    discordSelectionRule: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY',
    parentMatchDoesNotTriggerDiscord: true,
    macroMatchDoesNotTriggerDiscord: true,

    bucketsCoarseOnly: true,
    bucketGranularity: 'LOW_MID_HIGH',

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

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function cleanSideText(value = '') {
  return upper(value)
    .replaceAll('SHORT_DISABLED_FALSE', '')
    .replaceAll('SHORTDISABLED_FALSE', '')
    .replaceAll('BLOCK_SHORT_FALSE', '')
    .replaceAll('SHORT_ENABLED_FALSE', '')
    .replaceAll('SHORT_ONLY_FALSE', '')
    .replaceAll('LONG_DISABLED_FALSE', '')
    .replaceAll('LONG_ENABLED_FALSE', '')
    .replaceAll('LONG_ONLY_FALSE', '')
    .replaceAll('SHORT_DISABLED_LONG_ONLY', '')
    .replaceAll('SHORTDISABLED_LONG_ONLY', '')
    .replaceAll('BLOCK_SHORT', '')
    .replaceAll('SHORT_DISABLED', '')
    .replaceAll('SHORTDISABLED', '')
    .replaceAll('LONG_ONLY_MODE', 'LONG')
    .replaceAll('LONG_ONLY', 'LONG')
    .replaceAll('LONG-ONLY', 'LONG')
    .replaceAll('SHORT_ONLY_MODE', 'SHORT')
    .replaceAll('SHORT_ONLY', 'SHORT')
    .replaceAll('SHORT-ONLY', 'SHORT');
}

function num(value, fallback = 0) {
  const n = safeNumber(value, fallback);

  return Number.isFinite(n) ? n : fallback;
}

function round(value, decimals = 4) {
  return Number(num(value, 0).toFixed(decimals));
}

function getArray(value) {
  return asArray(value);
}

function uniqueStrings(values = []) {
  return [...new Set(
    asArray(values)
      .flatMap((value) => asArray(value).length ? asArray(value) : [value])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function snapshotPattern() {
  return LONG_KEYS.scan.snapshotPattern;
}

function snapshotKey(snapshotId) {
  return LONG_KEYS.scan.snapshot(snapshotId);
}

function extractSnapshotId(latest) {
  if (!latest) return null;
  if (typeof latest === 'string') return latest;

  if (typeof latest === 'object') {
    return (
      latest.snapshotId ||
      latest.id ||
      latest.latestSnapshotId ||
      latest.scanId ||
      null
    );
  }

  return null;
}

function hasFullSnapshotShape(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    asArray(value.candidates).length >= 0 &&
    (
      Array.isArray(value.candidates) ||
      value.snapshotId ||
      value.id ||
      value.scanId ||
      value.createdAt ||
      value.completedAt
    )
  );
}

function snapshotCreatedAt(snapshot = {}) {
  return num(
    snapshot.createdAt ||
    snapshot.completedAt ||
    snapshot.ts ||
    snapshot.scannerTs,
    0
  );
}

function snapshotAgeSec(snapshot = {}) {
  const createdAt = snapshotCreatedAt(snapshot);

  if (createdAt <= 0) return null;

  return Math.max(0, Math.floor((now() - createdAt) / 1000));
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

function getDefinitionHaystack(row = {}) {
  return [
    row.definition,
    row.microDefinition,
    row.macroDefinition,
    row.parentDefinition,
    ...getArray(row.definitionParts),
    ...getArray(row.microDefinitionParts),
    ...getArray(row.macroDefinitionParts),
    ...getArray(row.parentDefinitionParts),
    ...getArray(row.executionFingerprintParts)
  ]
    .map((value) => cleanSideText(value))
    .filter(Boolean)
    .join(' | ');
}

function hasLongToken(text = '') {
  const value = ` ${cleanSideText(text)} `;

  return (
    value.includes('MICRO_LONG_') ||
    value.includes('TRADESIDE=LONG') ||
    value.includes('TRADE_SIDE=LONG') ||
    value.includes('POSITION_SIDE=LONG') ||
    value.includes('POSITIONSIDE=LONG') ||
    value.includes('SIDE=LONG') ||
    value.includes('SIDE=BULL') ||
    value.includes('SIDE=BUY') ||
    value.includes('DIRECTION=LONG') ||
    value.includes('DIRECTION=BULL') ||
    value.includes('DIRECTION=BUY') ||
    value.includes(' LONG_') ||
    value.includes('_LONG ') ||
    value.includes('_LONG_') ||
    value.includes('|LONG|') ||
    value.includes(':LONG') ||
    value.includes('=LONG') ||
    value.includes(' BULL ') ||
    value.includes('_BULL') ||
    value.includes('BULL_') ||
    value.includes('|BULL|') ||
    value.includes(':BULL') ||
    value.includes('=BULL') ||
    value.includes(' BUY ') ||
    value.includes('_BUY') ||
    value.includes('BUY_') ||
    value.includes('|BUY|') ||
    value.includes(':BUY') ||
    value.includes('=BUY') ||
    value.includes('UPSIDE')
  );
}

function hasShortToken(text = '') {
  const value = ` ${cleanSideText(text)} `;

  return (
    value.includes('MICRO_SHORT_') ||
    value.includes('TRADESIDE=SHORT') ||
    value.includes('TRADE_SIDE=SHORT') ||
    value.includes('POSITION_SIDE=SHORT') ||
    value.includes('POSITIONSIDE=SHORT') ||
    value.includes('SIDE=SHORT') ||
    value.includes('SIDE=BEAR') ||
    value.includes('SIDE=SELL') ||
    value.includes('DIRECTION=SHORT') ||
    value.includes('DIRECTION=BEAR') ||
    value.includes('DIRECTION=SELL') ||
    value.includes(' SHORT_') ||
    value.includes('_SHORT ') ||
    value.includes('_SHORT_') ||
    value.includes('|SHORT|') ||
    value.includes(':SHORT') ||
    value.includes('=SHORT') ||
    value.includes(' BEAR ') ||
    value.includes('_BEAR') ||
    value.includes('BEAR_') ||
    value.includes('|BEAR|') ||
    value.includes(':BEAR') ||
    value.includes('=BEAR') ||
    value.includes(' SELL ') ||
    value.includes('_SELL') ||
    value.includes('SELL_') ||
    value.includes('|SELL|') ||
    value.includes(':SELL') ||
    value.includes('=SELL') ||
    value.includes('DOWNSIDE')
  );
}

function normalizeDirectSide(value) {
  const raw = cleanSideText(value);

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

  return 'UNKNOWN';
}

function directionalMoveScore(row = {}) {
  const values = [
    row.change1m,
    row.change5m,
    row.change15m,
    row.change30m,
    row.change1h,
    row.change4h,
    row.change24h,
    row.priceChange1mPct,
    row.priceChange5mPct,
    row.priceChange15mPct,
    row.priceChange30mPct,
    row.priceChange1hPct,
    row.priceChange4hPct,
    row.priceChange24hPct,
    row.priceChangePercent,
    row.priceChangePct,
    row.movePct,
    row.move,
    row.percentChange
  ]
    .map((value) => num(value, 0))
    .filter((value) => Number.isFinite(value) && value !== 0);

  if (!values.length) return 0;

  return values.reduce((sum, value) => sum + Math.sign(value), 0);
}

function hasBullishMove(row = {}) {
  return directionalMoveScore(row) > 0;
}

function hasBearishMove(row = {}) {
  return directionalMoveScore(row) < 0;
}

function inferTradeSide(row = {}) {
  if (typeof row === 'string') {
    if (parseLongTaxonomyMicroId(row).valid) return TARGET_TRADE_SIDE;
    if (hasLongToken(row)) return TARGET_TRADE_SIDE;
    if (hasShortToken(row)) return OPPOSITE_TRADE_SIDE;

    return 'UNKNOWN';
  }

  if (!row || typeof row !== 'object') return 'UNKNOWN';

  const directSources = [
    row.tradeSide,
    row.positionSide,
    row.direction,
    row.signalSide,
    row.scannerSide,
    row.actualScannerSide,
    row.analysisSide,
    row.entrySide,
    row.side,
    row.bias,
    row.marketBias
  ];

  for (const source of directSources) {
    const side = normalizeDirectSide(source);

    if (side === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
    if (side === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
  }

  const familyText = [
    row.familyId,
    row.family,
    row.baseFamilyId,
    row.macroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId,
    row.parentFamilyId,
    row.macroId,
    row.microFamilyId,
    row.trueMicroFamilyId,
    row.parentTrueMicroFamilyId,
    row.childTrueMicroFamilyId,
    row.coarseMicroFamilyId,
    row.id,
    row.key
  ]
    .map((value) => cleanSideText(value))
    .filter(Boolean)
    .join(' | ');

  if (parseLongTaxonomyMicroId(row.trueMicroFamilyId || row.microFamilyId).valid) return TARGET_TRADE_SIDE;
  if (hasLongToken(familyText)) return TARGET_TRADE_SIDE;
  if (hasShortToken(familyText)) return OPPOSITE_TRADE_SIDE;

  const reasonText = [
    row.scannerReason,
    row.reason,
    row.signalReason,
    row.actionReason,
    row.rejectionReason
  ]
    .map((value) => cleanSideText(value))
    .filter(Boolean)
    .join(' | ');

  const reasonLong = hasLongToken(reasonText);
  const reasonShort = hasShortToken(reasonText);

  if (reasonLong && !reasonShort) return TARGET_TRADE_SIDE;
  if (reasonShort && !reasonLong) return OPPOSITE_TRADE_SIDE;

  const definition = getDefinitionHaystack(row);
  const definitionLong = hasLongToken(definition);
  const definitionShort = hasShortToken(definition);

  if (definitionLong && !definitionShort) return TARGET_TRADE_SIDE;
  if (definitionShort && !definitionLong) return OPPOSITE_TRADE_SIDE;

  if (row.longOnly === true || row.shortDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  if (row.shortOnly === true || row.longDisabled === true) {
    return OPPOSITE_TRADE_SIDE;
  }

  if (hasBullishMove(row)) return TARGET_TRADE_SIDE;
  if (hasBearishMove(row)) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function isLongCandidate(candidate = {}) {
  return inferTradeSide(candidate) === TARGET_TRADE_SIDE;
}

function isShortCandidate(candidate = {}) {
  return inferTradeSide(candidate) === OPPOSITE_TRADE_SIDE;
}

function normalizeContractSymbol(candidate = {}) {
  return (
    candidate.contractSymbol ||
    candidate.symbol ||
    candidate.instId ||
    candidate.instrumentId ||
    null
  );
}

function normalizeSymbol(candidate = {}) {
  const symbol = (
    candidate.symbol ||
    candidate.baseSymbol ||
    candidate.contractSymbol ||
    candidate.instId ||
    candidate.instrumentId ||
    ''
  );

  return String(symbol || '').trim();
}

function normalizeLongCandidate(candidate = {}) {
  const symbol = normalizeSymbol(candidate);
  const contractSymbol = normalizeContractSymbol(candidate);
  const createdAt = num(candidate.createdAt || candidate.ts || now(), now());

  const trueMicroFamilyId =
    candidate.trueMicroFamilyId ||
    candidate.microFamilyId ||
    candidate.analyzeMicroFamilyId ||
    candidate.learningMicroFamilyId ||
    null;

  const parsedTrueMicro = parseLongTaxonomyMicroId(trueMicroFamilyId);
  const scannerMicroFamilyId =
    candidate.scannerMicroFamilyId ||
    candidate.scannerFamilyId ||
    candidate.scannerFingerprintId ||
    null;

  return {
    ...candidate,

    symbol,
    contractSymbol,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    scannerOnly: true,
    scannerDoesNotTrade: true,
    scannerDoesNotSelectMicroFamilies: true,
    scannerDoesNotSendDiscord: true,
    scannerDoesNotWriteLearningFamilies: true,

    scannerMicroFamilyId,
    scannerFamilyId: candidate.scannerFamilyId || scannerMicroFamilyId,
    scannerFingerprintId: candidate.scannerFingerprintId || scannerMicroFamilyId,
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    scannerBucketsDebugMetadataOnly: true,
    legacy25BucketsDebugMetadataOnly: true,

    trueMicroFamilyId: parsedTrueMicro.selectable ? parsedTrueMicro.trueMicroFamilyId : trueMicroFamilyId,
    microFamilyId: parsedTrueMicro.selectable ? parsedTrueMicro.trueMicroFamilyId : trueMicroFamilyId,
    parentTrueMicroFamilyId: parsedTrueMicro.parentTrueMicroFamilyId || candidate.parentTrueMicroFamilyId || null,
    childTrueMicroFamilyId: parsedTrueMicro.childTrueMicroFamilyId || null,

    trueMicroFamilySchema: parsedTrueMicro.selectable
      ? TRUE_MICRO_SCHEMA
      : candidate.trueMicroFamilySchema || null,
    learningGranularity: parsedTrueMicro.selectable
      ? LEARNING_GRANULARITY
      : candidate.learningGranularity || null,

    analyzeMustAssignTrueMicroFamily: true,
    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    selectable75ChildCandidate: Boolean(parsedTrueMicro.selectable),

    scannerScore: num(candidate.scannerScore ?? candidate.moveScore, 0),
    change1h: num(candidate.change1h ?? candidate.priceChange1hPct, 0),
    change24h: num(candidate.change24h ?? candidate.priceChange24hPct, 0),
    volume24h: num(candidate.volume24h ?? candidate.quoteVolume24h ?? candidate.quoteVolume, 0),

    btcState: candidate.btcState || null,
    regime: candidate.regime || null,
    fakeBreakout: Boolean(candidate.fakeBreakout),
    fakeBreakoutRisk: Boolean(candidate.fakeBreakoutRisk),

    scannerReason: candidate.scannerReason || candidate.reason || null,

    createdAt
  };
}

function splitCandidatesBySide(candidates = []) {
  const rows = asArray(candidates);

  const longCandidates = [];
  const shortCandidates = [];
  const unknownSideCandidates = [];

  for (const candidate of rows) {
    const tradeSide = inferTradeSide(candidate);

    if (tradeSide === TARGET_TRADE_SIDE) {
      longCandidates.push(candidate);
      continue;
    }

    if (tradeSide === OPPOSITE_TRADE_SIDE) {
      shortCandidates.push(candidate);
      continue;
    }

    unknownSideCandidates.push(candidate);
  }

  return {
    longCandidates,
    shortCandidates,
    unknownSideCandidates
  };
}

function averageScannerScore(candidates = []) {
  const rows = asArray(candidates);

  if (!rows.length) return 0;

  const total = rows.reduce((sum, candidate) => {
    return sum + num(candidate?.scannerScore ?? candidate?.moveScore, 0);
  }, 0);

  return round(total / rows.length, 2);
}

function topSymbols(candidates = [], limit = 20) {
  return asArray(candidates)
    .slice(0, limit)
    .map((candidate) => candidate.symbol || candidate.contractSymbol)
    .filter(Boolean);
}

function buildCandidateStats(rawCandidates = [], candidates = []) {
  const safeRawCandidates = asArray(rawCandidates);
  const safeCandidates = asArray(candidates);

  const {
    longCandidates,
    shortCandidates,
    unknownSideCandidates
  } = splitCandidatesBySide(safeRawCandidates);

  const scannerGateCandidates = safeCandidates.filter((candidate) => candidate.scannerGatePassed);
  const analyzeOnlyCandidates = safeCandidates.filter((candidate) => (
    candidate.tradeDiscoveryOnly ||
    candidate.discoveryOnly ||
    candidate.analyzeOnly
  ));

  const cleanCandidates = safeCandidates.filter((candidate) => !candidate.fakeBreakout);
  const fakeBreakouts = safeCandidates.filter((candidate) => candidate.fakeBreakout);
  const fakeRiskCandidates = safeCandidates.filter((candidate) => candidate.fakeBreakoutRisk);

  return {
    candidates: safeCandidates.length,
    cleanCandidates: cleanCandidates.length,
    fakeBreakouts: fakeBreakouts.length,
    fakeRiskCandidates: fakeRiskCandidates.length,

    scannerGateCandidates: scannerGateCandidates.length,
    analyzeOnlyCandidates: analyzeOnlyCandidates.length,

    longCandidates: safeCandidates.length,
    shortCandidates: 0,
    unknownSideCandidates: 0,

    bullCandidates: safeCandidates.length,
    bearCandidates: 0,

    rawCandidates: safeRawCandidates.length,
    rawLongCandidates: longCandidates.length,
    rawShortCandidatesIgnored: shortCandidates.length,
    rawUnknownSideCandidatesIgnored: unknownSideCandidates.length,

    avgScannerScore: averageScannerScore(safeCandidates)
  };
}

function normalizeLatest(latest, snapshot = null, meta = {}) {
  const snapshotId = extractSnapshotId(latest) || snapshot?.snapshotId || meta.snapshotId || null;

  const candidates = asArray(snapshot?.candidates);

  const scannerGateCandidates = candidates.filter((candidate) => candidate.scannerGatePassed);
  const analyzeOnlyCandidates = candidates.filter((candidate) => (
    candidate.tradeDiscoveryOnly ||
    candidate.discoveryOnly ||
    candidate.analyzeOnly
  ));

  const base = latest && typeof latest === 'object'
    ? latest
    : { snapshotId };

  const createdAt = snapshotCreatedAt(snapshot || base);
  const ageSec = createdAt > 0
    ? Math.max(0, Math.floor((now() - createdAt) / 1000))
    : null;

  const hasSnapshot = Boolean(snapshot);

  const fallbackCount = num(
    base.longCandidatesCount ??
    base.selectedTargetCandidateCount ??
    base.scannerGateCandidatesCount ??
    base.candidatesCount ??
    base.count,
    0
  );

  return {
    ...base,

    ...modeFlags(),

    taxonomy: taxonomyMeta(),

    snapshotId,

    selectedSnapshotSource: meta.snapshotSource || null,
    selectedSnapshotReason: meta.snapshotReason || null,

    createdAt: createdAt || base.createdAt || null,
    snapshotAgeSec: ageSec,

    candidatesCount: hasSnapshot ? candidates.length : fallbackCount,
    longCandidatesCount: hasSnapshot ? candidates.length : fallbackCount,
    shortCandidatesCount: 0,

    scannerGateCandidatesCount: hasSnapshot
      ? scannerGateCandidates.length
      : num(base.scannerGateCandidatesCount, 0),

    analyzeOnlyCandidatesCount: hasSnapshot
      ? analyzeOnlyCandidates.length
      : num(base.analyzeOnlyCandidatesCount, 0),

    topSymbols: hasSnapshot
      ? topSymbols(candidates)
      : asArray(base.topSymbols).slice(0, 20),

    scannerGateSymbols: topSymbols(scannerGateCandidates),

    isStale8m: ageSec === null ? null : ageSec > STALE_8M_SEC,
    isStale30m: ageSec === null ? null : ageSec > STALE_30M_SEC
  };
}

function normalizeSnapshot(snapshot, fallbackId = null, meta = {}) {
  if (!snapshot || typeof snapshot !== 'object') {
    return null;
  }

  const rawCandidates = asArray(snapshot.candidates);

  const {
    longCandidates,
    shortCandidates,
    unknownSideCandidates
  } = splitCandidatesBySide(rawCandidates);

  const candidates = longCandidates.map(normalizeLongCandidate);
  const ageSec = snapshotAgeSec(snapshot);

  const scannerGateCandidates = candidates.filter((candidate) => candidate.scannerGatePassed);
  const analyzeOnlyCandidates = candidates.filter((candidate) => (
    candidate.tradeDiscoveryOnly ||
    candidate.discoveryOnly ||
    candidate.analyzeOnly
  ));

  return {
    ...snapshot,

    ...modeFlags(),

    taxonomy: taxonomyMeta(),

    snapshotId: snapshot.snapshotId || fallbackId || null,

    selectedSnapshotSource: meta.snapshotSource || null,
    selectedSnapshotReason: meta.snapshotReason || null,

    rawCandidatesCount: rawCandidates.length,
    rawLongCandidatesCount: longCandidates.length,
    rawShortCandidatesIgnored: shortCandidates.length,
    rawUnknownSideCandidatesIgnored: unknownSideCandidates.length,

    candidates,
    candidatesCount: candidates.length,
    longCandidatesCount: candidates.length,
    shortCandidatesCount: 0,

    scannerGateCandidatesCount: scannerGateCandidates.length,
    analyzeOnlyCandidatesCount: analyzeOnlyCandidates.length,

    topSymbols: topSymbols(candidates),
    scannerGateSymbols: topSymbols(scannerGateCandidates),

    stats: buildCandidateStats(rawCandidates, candidates),

    snapshotAgeSec: ageSec,
    isStale8m: ageSec === null ? null : ageSec > STALE_8M_SEC,
    isStale30m: ageSec === null ? null : ageSec > STALE_30M_SEC
  };
}

function targetCandidateCount(snapshot = {}) {
  return asArray(snapshot.candidates).filter(isLongCandidate).length;
}

function oppositeCandidateCount(snapshot = {}) {
  return asArray(snapshot.candidates).filter(isShortCandidate).length;
}

async function safeGetSnapshotJson(redis, key, fallback = null) {
  return getJson(redis, key, fallback).catch(() => fallback);
}

async function loadRecentSnapshotCandidates(redis) {
  const keysRaw = await getKeys(
    redis,
    snapshotPattern(),
    SNAPSHOT_SEARCH_LIMIT
  ).catch(() => []);

  const keys = asArray(keysRaw);

  if (!keys.length) return [];

  const rows = await Promise.all(
    keys.map(async (key) => {
      const snapshot = await safeGetSnapshotJson(redis, key, null);

      if (!hasFullSnapshotShape(snapshot)) return null;

      return {
        source: `LONG_SCAN:RECENT_SEARCH:${key}`,
        snapshot,
        snapshotId: snapshot.snapshotId || key,
        targetCount: targetCandidateCount(snapshot),
        oppositeCount: oppositeCandidateCount(snapshot),
        createdAt: snapshotCreatedAt(snapshot)
      };
    })
  );

  return asArray(rows)
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function dedupeSnapshotCandidates(candidates = []) {
  const unique = new Map();

  for (const item of asArray(candidates)) {
    if (!item?.snapshot || !hasFullSnapshotShape(item.snapshot)) continue;

    const id = item.snapshot?.snapshotId || item.snapshotId || item.snapshotSource;

    if (!id) continue;

    const previous = unique.get(id);

    if (!previous) {
      unique.set(id, item);
      continue;
    }

    if (
      item.createdAt > previous.createdAt ||
      (
        item.createdAt === previous.createdAt &&
        item.targetCount > previous.targetCount
      )
    ) {
      unique.set(id, item);
    }
  }

  return [...unique.values()]
    .filter((item) => hasFullSnapshotShape(item.snapshot))
    .sort((a, b) => b.createdAt - a.createdAt);
}

async function loadSnapshot(redis, latest) {
  const snapshotId = extractSnapshotId(latest);
  const candidates = [];

  if (hasFullSnapshotShape(latest)) {
    candidates.push({
      snapshot: latest,
      snapshotSource: 'LONG_SCAN:LATEST_FULL_SNAPSHOT',
      snapshotReason: 'LATEST_FULL_SNAPSHOT',
      snapshotId: latest.snapshotId || snapshotId,
      targetCount: targetCandidateCount(latest),
      oppositeCount: oppositeCandidateCount(latest),
      createdAt: snapshotCreatedAt(latest)
    });
  }

  if (snapshotId) {
    const byId = await safeGetSnapshotJson(
      redis,
      snapshotKey(snapshotId),
      null
    );

    if (hasFullSnapshotShape(byId)) {
      candidates.push({
        snapshot: byId,
        snapshotSource: 'LONG_SCAN:SNAPSHOT_BY_ID',
        snapshotReason: 'SNAPSHOT_REFERENCED_BY_LATEST_ID',
        snapshotId,
        targetCount: targetCandidateCount(byId),
        oppositeCount: oppositeCandidateCount(byId),
        createdAt: snapshotCreatedAt(byId)
      });
    }
  }

  const recent = await loadRecentSnapshotCandidates(redis);

  for (const item of recent) {
    candidates.push({
      ...item,
      snapshotSource: item.source,
      snapshotReason: 'RECENT_SNAPSHOT_SEARCH'
    });
  }

  const sorted = dedupeSnapshotCandidates(candidates);

  const selectedTarget = sorted.find((item) => item.targetCount > 0);

  if (selectedTarget) {
    return {
      snapshot: normalizeSnapshot(
        selectedTarget.snapshot,
        selectedTarget.snapshotId,
        {
          snapshotSource: selectedTarget.snapshotSource,
          snapshotReason: 'NEWEST_LONG_SNAPSHOT_WITH_CANDIDATES'
        }
      ),
      snapshotSource: selectedTarget.snapshotSource,
      snapshotReason: 'NEWEST_LONG_SNAPSHOT_WITH_CANDIDATES',
      snapshotId: selectedTarget.snapshotId,
      rawTargetCount: selectedTarget.targetCount,
      rawOppositeCount: selectedTarget.oppositeCount,
      snapshotsScanned: sorted.length
    };
  }

  const selectedAny = sorted[0] || null;

  if (!selectedAny) {
    return {
      snapshot: null,
      snapshotSource: snapshotId ? 'LONG_SNAPSHOT_NOT_FOUND' : 'NO_LONG_SNAPSHOT_ID',
      snapshotReason: snapshotId ? 'LATEST_REFERENCED_MISSING_LONG_SNAPSHOT' : 'NO_LATEST_LONG_SNAPSHOT_ID',
      snapshotId: snapshotId || null,
      rawTargetCount: 0,
      rawOppositeCount: 0,
      snapshotsScanned: 0
    };
  }

  return {
    snapshot: normalizeSnapshot(
      selectedAny.snapshot,
      selectedAny.snapshotId,
      {
        snapshotSource: selectedAny.snapshotSource,
        snapshotReason: 'NO_LONG_SNAPSHOT_FOUND_USING_NEWEST_AVAILABLE'
      }
    ),
    snapshotSource: selectedAny.snapshotSource,
    snapshotReason: 'NO_LONG_SNAPSHOT_FOUND_USING_NEWEST_AVAILABLE',
    snapshotId: selectedAny.snapshotId,
    rawTargetCount: selectedAny.targetCount,
    rawOppositeCount: selectedAny.oppositeCount,
    snapshotsScanned: sorted.length
  };
}

function emptyStats() {
  return {
    candidates: 0,
    cleanCandidates: 0,
    fakeBreakouts: 0,
    fakeRiskCandidates: 0,

    scannerGateCandidates: 0,
    analyzeOnlyCandidates: 0,

    longCandidates: 0,
    shortCandidates: 0,
    unknownSideCandidates: 0,

    bullCandidates: 0,
    bearCandidates: 0,

    rawCandidates: 0,
    rawLongCandidates: 0,
    rawShortCandidatesIgnored: 0,
    rawUnknownSideCandidatesIgnored: 0,

    avgScannerScore: 0
  };
}

function buildSummary({
  latest,
  snapshot,
  candidates,
  rawTargetCount,
  rawOppositeCount,
  snapshotsScanned
}) {
  const safeCandidates = asArray(candidates);

  return {
    ...modeFlags(),

    taxonomy: taxonomyMeta(),

    latestSnapshotId: latest?.snapshotId || null,
    selectedSnapshotId: snapshot?.snapshotId || null,

    snapshotsScanned: num(snapshotsScanned, 0),

    candidates: safeCandidates.length,
    longCandidates: safeCandidates.length,
    shortCandidates: 0,

    rawTargetCount: num(rawTargetCount, 0),
    rawOppositeCount: num(rawOppositeCount, 0),

    rawCandidates: num(snapshot?.rawCandidatesCount, 0),
    rawShortCandidatesIgnored: num(snapshot?.rawShortCandidatesIgnored, 0),
    rawUnknownSideCandidatesIgnored: num(snapshot?.rawUnknownSideCandidatesIgnored, 0),

    scannerGateCandidates: num(snapshot?.scannerGateCandidatesCount, 0),
    analyzeOnlyCandidates: num(snapshot?.analyzeOnlyCandidatesCount, 0),

    avgScannerScore: averageScannerScore(safeCandidates),

    topSymbols: topSymbols(safeCandidates)
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Scanner-Build-Id', ADMIN_SCANNER_BUILD_ID);
  res.setHeader('X-Admin-Scanner-Mode', 'long-only-scanner-discovery-75-child-contract-v1');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Long-Only', 'true');
  res.setHeader('X-Short-Disabled', 'true');
  res.setHeader('X-Scanner-Side', TARGET_SCANNER_SIDE);
  res.setHeader('X-Scanner-Only', 'true');
  res.setHeader('X-Scanner-Fingerprints-Metadata-Only', 'true');
  res.setHeader('X-Scanner-Fingerprints-Used-As-Learning-Family', 'false');
  res.setHeader('X-True-Micro-Family-Schema', TRUE_MICRO_SCHEMA);
  res.setHeader('X-Learning-Granularity', LEARNING_GRANULARITY);
  res.setHeader('X-Selectable-Child-Micro-Families', '75');
  res.setHeader('X-Parent-Micro-Families', '15');
  res.setHeader('X-Manual-Selection-Match-Mode', 'EXACT_TRUE_MICRO_FAMILY_ID');
  res.setHeader('X-Discord-Selection-Rule', 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY');
  res.setHeader('X-Real-Orders-Disabled', 'true');
  res.setHeader('X-Bitget-Orders-Disabled', 'true');
  res.setHeader('X-Exchange-Calls-Disabled', 'true');
  res.setHeader('X-Virtual-Learning-Forced', 'true');
  res.setHeader('X-Redis-Namespace', LONG_NAMESPACE);
  res.setHeader('X-Short-Root-Touched', 'false');

  if (req.method !== 'GET') {
    return methodNotAllowed(res);
  }

  try {
    const redis = getVolatileRedis();
    const latestRaw = await getJson(redis, LONG_KEYS.scan.latest, null);

    const {
      snapshot,
      snapshotSource,
      snapshotReason,
      snapshotId,
      rawTargetCount,
      rawOppositeCount,
      snapshotsScanned
    } = await loadSnapshot(redis, latestRaw);

    const candidates = asArray(snapshot?.candidates);

    const latest = normalizeLatest(latestRaw, snapshot, {
      snapshotId,
      snapshotSource,
      snapshotReason
    });

    return res.status(200).json({
      ok: true,

      ...modeFlags(),

      taxonomy: taxonomyMeta(),

      longKeys: {
        namespace: LONG_NAMESPACE,
        prefix: LONG_KEY_PREFIX,
        scanLatest: LONG_KEYS.scan.latest,
        snapshotPattern: LONG_KEYS.scan.snapshotPattern
      },

      latest,
      snapshot,
      candidates,

      snapshotId,
      snapshotSource,
      snapshotReason,

      candidatesCount: candidates.length,
      longCandidatesCount: candidates.length,
      shortCandidatesCount: 0,

      rawTargetCount,
      rawOppositeCount,
      snapshotsScanned,

      stats: snapshot?.stats || emptyStats(),

      summary: buildSummary({
        latest,
        snapshot,
        candidates,
        rawTargetCount,
        rawOppositeCount,
        snapshotsScanned
      }),

      warnings: uniqueStrings([
        !snapshot ? 'NO_LONG_SCANNER_SNAPSHOT_AVAILABLE' : null,
        snapshot?.isStale8m ? 'LONG_SCANNER_SNAPSHOT_STALE_8M' : null,
        snapshot?.isStale30m ? 'LONG_SCANNER_SNAPSHOT_STALE_30M' : null,
        rawOppositeCount > 0 ? `SHORT_CANDIDATES_IGNORED:${rawOppositeCount}` : null,
        snapshot?.rawUnknownSideCandidatesIgnored > 0
          ? `UNKNOWN_SIDE_CANDIDATES_IGNORED:${snapshot.rawUnknownSideCandidatesIgnored}`
          : null,
        snapshot && candidates.length <= 0
          ? 'NO_LONG_CANDIDATES_IN_SELECTED_SNAPSHOT'
          : null
      ].filter(Boolean)),

      debug: {
        buildId: ADMIN_SCANNER_BUILD_ID,
        latestShape: shapeOf(latestRaw),
        snapshotShape: shapeOf(snapshot),
        candidatesShape: shapeOf(candidates),
        stackVisibleOnError: true
      },

      serverTs: Date.now()
    });
  } catch (error) {
    return res.status(200).json({
      ok: false,
      recoveredHttpStatus: 500,
      adminScannerFailed: true,

      ...modeFlags(),

      error: error?.message || String(error),
      name: error?.name || null,
      details: error?.details || null,
      stack: error?.stack || null,

      debug: {
        buildId: ADMIN_SCANNER_BUILD_ID,
        source: 'api/admin/scanner.js',
        stackVisible: true,
        reason: 'TEMP_DEBUG_ADMIN_SCANNER_SAFE_CATCH'
      },

      warnings: [
        'ADMIN_SCANNER_ROUTE_FAILED_BUT_RETURNED_200_TO_PREVENT_UI_HARD_CRASH'
      ],

      serverTs: Date.now()
    });
  }
}