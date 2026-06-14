// ================= FILE: src/trade/positionSizing.js =================
//
// Long-only virtual position sizing.
// Risk contribution = fraction of equity lost if a virtual LONG position hits initial SL.
// Required LONG risk geometry: sl < entry < tp.
// No real orders. No SHORT sizing. Exact 75-child trueMicroFamilyId is the selectable identity.

import { CONFIG } from '../config.js';
import {
  clamp,
  safeNumber,
  sideToTradeSide
} from '../utils.js';

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
const LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_V1';

const MIN_COMPLETED_ACTIVE_LEARNING = 20;

const SETUP_ORDER = Object.freeze([
  'BREAKOUT',
  'RETEST',
  'SWEEP_REVERSAL',
  'CONTINUATION',
  'COMPRESSION'
]);

const REGIME_ORDER = Object.freeze([
  'TREND',
  'CHOP',
  'SQUEEZE'
]);

const CONFIRMATION_PROFILE_ORDER = Object.freeze([
  'A_STRONG_ALIGN',
  'B_FLOW_ALIGN',
  'C_VOLUME_ALIGN',
  'D_MIXED_OK',
  'E_WEAK_CONTRA'
]);

const LONG_FIXED_SETUP_TYPES = new Set(SETUP_ORDER);
const LONG_FIXED_REGIME_BUCKETS = new Set(REGIME_ORDER);
const LONG_CONFIRMATION_PROFILES = new Set(CONFIRMATION_PROFILE_ORDER);

const LONG_DIRECT = new Set([
  'LONG',
  'BULL',
  'BULLISH',
  'BUY',
  'BID',
  'UP',
  'UPSIDE',
  'GREEN'
]);

const SHORT_DIRECT = new Set([
  'SHORT',
  'BEAR',
  'BEARISH',
  'SELL',
  'ASK',
  'DOWN',
  'DOWNSIDE',
  'RED'
]);

function round6(value) {
  return Number(safeNumber(value, 0).toFixed(6));
}

function upper(value, fallback = '') {
  const text = String(value ?? '').trim();

  return text ? text.toUpperCase() : fallback;
}

function sizingConfig() {
  return {
    enabled: CONFIG.sizing?.enabled !== false,

    baseRiskPct: Math.max(
      0,
      safeNumber(CONFIG.sizing?.baseRiskPct, 0.0025)
    ),

    minMult: Math.max(
      0,
      safeNumber(CONFIG.sizing?.minMult, 0.5)
    ),

    maxMult: Math.max(
      0,
      safeNumber(CONFIG.sizing?.maxMult, 1.25)
    ),

    maxTotalRiskPct: Math.max(
      0,
      safeNumber(CONFIG.sizing?.maxTotalRiskPct, 0.03)
    ),

    maxSameSideRiskPct: Math.max(
      0,
      safeNumber(CONFIG.sizing?.maxSameSideRiskPct, 0.015)
    ),

    maxCounterBtcRiskPct: Math.max(
      0,
      safeNumber(CONFIG.sizing?.maxCounterBtcRiskPct, 0.0075)
    ),

    priorTrades: Math.max(
      1,
      safeNumber(
        CONFIG.long?.rotation?.priorTrades ??
          CONFIG.rotation?.priorTrades,
        24
      )
    )
  };
}

function baseModeFlags() {
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

    virtualLearning: true,
    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: true,
    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    exchangeCallsDisabled: true,
    noRealOrders: true,
    noExchangeOrders: true,

    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
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
    fixedTaxonomyPreferred: true,

    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    discordOnlyForExactTrueMicroMatch: true,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

    parentLearningEnabled: true,
    childLearningEnabled: true,
    selectionGranularity: 'EXACT_75_CHILD',
    fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED',

    minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,

    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    shortRootTouched: false
  };
}

function cleanSideText(value = '') {
  return upper(value)
    .replaceAll('SHORT_DISABLED_FALSE', '')
    .replaceAll('SHORTDISABLED_FALSE', '')
    .replaceAll('BLOCK_SHORT_FALSE', '')
    .replaceAll('SHORT_ENABLED_FALSE', '')
    .replaceAll('SHORT_ONLY_FALSE', '')
    .replaceAll('LONG_DISABLED_FALSE', '')
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

  for (const candidateRegime of REGIME_ORDER) {
    const suffix = `_${candidateRegime}`;

    if (body.endsWith(suffix)) {
      regime = candidateRegime;
      setup = body.slice(0, -suffix.length);
      break;
    }
  }

  const parentId = setup && regime ? `MICRO_LONG_${setup}_${regime}` : null;
  const childId = parentId && confirmationProfile ? `${parentId}_${confirmationProfile}` : null;

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
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY
  };
}

function isExactLongChildTrueMicroId(id = '') {
  const parsed = parseLongTaxonomyMicroId(id);

  return Boolean(parsed.valid && parsed.selectable && parsed.isChild);
}

function normalizeTradeSide(value) {
  const raw = cleanSideText(value);

  if (!raw) return 'UNKNOWN';

  const direct = sideToTradeSide(raw);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  if (LONG_DIRECT.has(raw)) return TARGET_TRADE_SIDE;
  if (SHORT_DIRECT.has(raw)) return OPPOSITE_TRADE_SIDE;

  const normalized = raw
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  const longHit =
    normalized === 'LONG' ||
    normalized === 'BULL' ||
    normalized === 'BUY' ||
    normalized.includes('MICRO_LONG_') ||
    normalized.includes('TRADESIDE_LONG') ||
    normalized.includes('TRADE_SIDE_LONG') ||
    normalized.includes('POSITION_SIDE_LONG') ||
    normalized.includes('POSITIONSIDE_LONG') ||
    normalized.includes('SIDE_LONG') ||
    normalized.includes('SIDE_BULL') ||
    normalized.includes('DIRECTION_LONG') ||
    normalized.includes('DIRECTION_BULL') ||
    normalized.includes('SIDE_BUY') ||
    normalized.includes('DIRECTION_BUY') ||
    normalized.startsWith('LONG_') ||
    normalized.includes('_LONG_') ||
    normalized.endsWith('_LONG') ||
    normalized.startsWith('BULL_') ||
    normalized.includes('_BULL_') ||
    normalized.endsWith('_BULL') ||
    normalized.startsWith('BUY_') ||
    normalized.includes('_BUY_') ||
    normalized.endsWith('_BUY');

  const shortHit =
    normalized === 'SHORT' ||
    normalized === 'BEAR' ||
    normalized === 'SELL' ||
    normalized.includes('MICRO_SHORT_') ||
    normalized.includes('TRADESIDE_SHORT') ||
    normalized.includes('TRADE_SIDE_SHORT') ||
    normalized.includes('POSITION_SIDE_SHORT') ||
    normalized.includes('POSITIONSIDE_SHORT') ||
    normalized.includes('SIDE_SHORT') ||
    normalized.includes('SIDE_BEAR') ||
    normalized.includes('DIRECTION_SHORT') ||
    normalized.includes('DIRECTION_BEAR') ||
    normalized.includes('SIDE_SELL') ||
    normalized.includes('DIRECTION_SELL') ||
    normalized.startsWith('SHORT_') ||
    normalized.includes('_SHORT_') ||
    normalized.endsWith('_SHORT') ||
    normalized.startsWith('BEAR_') ||
    normalized.includes('_BEAR_') ||
    normalized.endsWith('_BEAR') ||
    normalized.startsWith('SELL_') ||
    normalized.includes('_SELL_') ||
    normalized.endsWith('_SELL');

  if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;
  if (longHit && !shortHit) return TARGET_TRADE_SIDE;

  if (longHit && shortHit) {
    if (normalized.includes('TRADE_SIDE_LONG') || normalized.includes('TRADESIDE_LONG')) return TARGET_TRADE_SIDE;
    if (normalized.includes('TRADE_SIDE_SHORT') || normalized.includes('TRADESIDE_SHORT')) return OPPOSITE_TRADE_SIDE;
    if (normalized.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
    if (normalized.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
  }

  if (longHit) return TARGET_TRADE_SIDE;
  if (shortHit) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function textParts(row = {}) {
  return [
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
    .map((value) => upper(value))
    .filter(Boolean);
}

function idText(row = {}) {
  return [
    row.familyId,
    row.family,
    row.baseFamilyId,

    row.childTrueMicroFamilyId,
    row.trueMicroFamilyId,
    row.microFamilyId,
    row.analyzeMicroFamilyId,
    row.learningMicroFamilyId,
    row.fixedTaxonomyMicroFamilyId,
    row.id,
    row.key,

    row.parentTrueMicroFamilyId,
    row.coarseMicroFamilyId,
    row.macroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId,
    row.parentFamilyId,
    row.macroId,

    row.scannerMicroFamilyId,
    row.scannerFamilyId,
    row.executionMicroFamilyId
  ]
    .map((value) => upper(value))
    .filter(Boolean)
    .join('|');
}

function hasLongIdSignal(text = '') {
  const raw = upper(text);

  return (
    raw.includes('MICRO_LONG_') ||
    raw.includes('LONG_') ||
    raw.includes('_LONG_') ||
    raw.endsWith('_LONG') ||
    raw.includes('|LONG_') ||
    raw.includes('TRADESIDE=LONG') ||
    raw.includes('TRADE_SIDE=LONG') ||
    raw.includes('SIDE=LONG') ||
    raw.includes('SIDE=BULL') ||
    raw.includes('DIRECTION=LONG') ||
    raw.includes('DIRECTION=BULL') ||
    raw.includes('POSITION_SIDE=LONG') ||
    raw.includes('POSITIONSIDE=LONG')
  );
}

function hasShortIdSignal(text = '') {
  const raw = upper(text);

  return (
    raw.includes('MICRO_SHORT_') ||
    raw.includes('SHORT_') ||
    raw.includes('_SHORT_') ||
    raw.endsWith('_SHORT') ||
    raw.includes('|SHORT_') ||
    raw.includes('TRADESIDE=SHORT') ||
    raw.includes('TRADE_SIDE=SHORT') ||
    raw.includes('SIDE=SHORT') ||
    raw.includes('SIDE=BEAR') ||
    raw.includes('DIRECTION=SHORT') ||
    raw.includes('DIRECTION=BEAR') ||
    raw.includes('POSITION_SIDE=SHORT') ||
    raw.includes('POSITIONSIDE=SHORT')
  );
}

function hasLongDefinitionSignal(parts = []) {
  const haystack = parts.join('|');

  return (
    haystack.includes('TRADESIDE=LONG') ||
    haystack.includes('TRADE_SIDE=LONG') ||
    haystack.includes('SIDE=LONG') ||
    haystack.includes('SIDE=BULL') ||
    haystack.includes('DIRECTION=LONG') ||
    haystack.includes('DIRECTION=BULL') ||
    haystack.includes('POSITION_SIDE=LONG') ||
    haystack.includes('POSITIONSIDE=LONG') ||
    haystack.includes('SIDE=BUY') ||
    haystack.includes('DIRECTION=BUY') ||
    haystack.includes('MICRO_LONG_')
  );
}

function hasShortDefinitionSignal(parts = []) {
  const haystack = parts.join('|');

  return (
    haystack.includes('TRADESIDE=SHORT') ||
    haystack.includes('TRADE_SIDE=SHORT') ||
    haystack.includes('SIDE=SHORT') ||
    haystack.includes('SIDE=BEAR') ||
    haystack.includes('DIRECTION=SHORT') ||
    haystack.includes('DIRECTION=BEAR') ||
    haystack.includes('POSITION_SIDE=SHORT') ||
    haystack.includes('POSITIONSIDE=SHORT') ||
    haystack.includes('SIDE=SELL') ||
    haystack.includes('DIRECTION=SELL') ||
    haystack.includes('MICRO_SHORT_')
  );
}

function inferTradeSideFromIds(row = {}) {
  const haystack = idText(row);

  if (!haystack) return 'UNKNOWN';

  const longHit = hasLongIdSignal(haystack);
  const shortHit = hasShortIdSignal(haystack);

  if (longHit && !shortHit) return TARGET_TRADE_SIDE;
  if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;

  if (longHit && shortHit) {
    if (haystack.includes('TRADE_SIDE=LONG') || haystack.includes('TRADESIDE=LONG')) return TARGET_TRADE_SIDE;
    if (haystack.includes('TRADE_SIDE=SHORT') || haystack.includes('TRADESIDE=SHORT')) return OPPOSITE_TRADE_SIDE;
    if (haystack.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
    if (haystack.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferTradeSideFromDefinitions(row = {}) {
  const parts = textParts(row);

  if (!parts.length) return 'UNKNOWN';

  const longHit = hasLongDefinitionSignal(parts);
  const shortHit = hasShortDefinitionSignal(parts);
  const haystack = parts.join('|');

  if (longHit && !shortHit) return TARGET_TRADE_SIDE;
  if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;

  if (longHit && shortHit) {
    if (haystack.includes('TRADE_SIDE=LONG') || haystack.includes('TRADESIDE=LONG')) return TARGET_TRADE_SIDE;
    if (haystack.includes('TRADE_SIDE=SHORT') || haystack.includes('TRADESIDE=SHORT')) return OPPOSITE_TRADE_SIDE;
    if (haystack.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
    if (haystack.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferTradeSide(row = {}) {
  if (typeof row !== 'object' || row === null) {
    return normalizeTradeSide(row);
  }

  const directSources = [
    row.tradeSide,
    row.positionSide,
    row.direction,
    row.signalSide,
    row.scannerSide,
    row.actualScannerSide,
    row.analysisSide,
    row.side
  ];

  for (const value of directSources) {
    const side = normalizeTradeSide(value);

    if (side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE) return side;
  }

  const fromIds = inferTradeSideFromIds(row);

  if (fromIds === TARGET_TRADE_SIDE || fromIds === OPPOSITE_TRADE_SIDE) return fromIds;

  const fromDefinitions = inferTradeSideFromDefinitions(row);

  if (fromDefinitions === TARGET_TRADE_SIDE || fromDefinitions === OPPOSITE_TRADE_SIDE) {
    return fromDefinitions;
  }

  if (row.longOnly === true && row.shortDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  if (row.shortOnly === true || row.longDisabled === true) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function extractTrueMicroFamilyId(row = {}) {
  const id = String(
    row.childTrueMicroFamilyId ||
    row.trueMicroFamilyId ||
    row.microFamilyId ||
    row.analyzeMicroFamilyId ||
    row.learningMicroFamilyId ||
    row.fixedTaxonomyMicroFamilyId ||
    ''
  ).trim().toUpperCase();

  if (!validLearningId(id)) return '';

  return id;
}

function taxonomyIdentity(row = {}) {
  const id = extractTrueMicroFamilyId(row);
  const parsed = parseLongTaxonomyMicroId(id);

  if (!parsed.valid) {
    return {
      exactChild: false,
      parentTrueMicroFamilyId: null,
      childTrueMicroFamilyId: null,
      trueMicroFamilyId: id || null,
      setupType: null,
      regimeBucket: null,
      confirmationProfile: null
    };
  }

  return {
    exactChild: Boolean(parsed.selectable && parsed.isChild),
    parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
    childTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
    trueMicroFamilyId: parsed.childTrueMicroFamilyId || parsed.trueMicroFamilyId,
    setupType: parsed.setup,
    regimeBucket: parsed.regime,
    confirmationProfile: parsed.confirmationProfile
  };
}

function exactChildRequiredButMissing(row = {}) {
  const id = extractTrueMicroFamilyId(row);

  if (!id) return false;

  return !isExactLongChildTrueMicroId(id);
}

function completedCount(row = {}) {
  const virtualCompleted = safeNumber(row.virtualCompleted, 0);
  const shadowCompleted = safeNumber(row.shadowCompleted, 0);
  const explicitCompleted = safeNumber(row.completed, 0);

  const closed = virtualCompleted + shadowCompleted;

  return closed > 0 ? closed : Math.max(0, explicitCompleted);
}

function learningStatus(row = {}) {
  const completed = completedCount(row);

  if (completed <= 0) return 'OBSERVING';
  if (completed < MIN_COMPLETED_ACTIVE_LEARNING) return 'EARLY_OUTCOMES';

  return 'ACTIVE_LEARNING';
}

function normalizeBtcRelation(value) {
  const relation = upper(value, 'BTC_UNKNOWN');

  if (relation === 'BTC_WITH' || relation === 'WITH') return 'BTC_WITH';
  if (relation === 'BTC_AGAINST' || relation === 'AGAINST') return 'BTC_AGAINST';
  if (relation === 'BTC_NEUTRAL' || relation === 'NEUTRAL') return 'BTC_NEUTRAL';
  if (relation === 'BTC_UNKNOWN' || relation === 'UNKNOWN') return 'BTC_UNKNOWN';

  if (relation === 'BULLISH' || relation === 'STRONG_BULL') return 'BTC_WITH';
  if (relation === 'BEARISH' || relation === 'STRONG_BEAR') return 'BTC_AGAINST';

  return 'BTC_UNKNOWN';
}

function relationFromDefinitionParts(definitionParts = []) {
  const parts = Array.isArray(definitionParts) ? definitionParts : [];

  const directMatch = parts.find((part) => {
    const text = upper(part);

    return (
      text.startsWith('BTCRELATION=') ||
      text.startsWith('BTC_RELATION=') ||
      text.startsWith('BTC=') ||
      text.startsWith('BTC_STATE=')
    );
  });

  if (!directMatch) return 'BTC_UNKNOWN';

  return normalizeBtcRelation(String(directMatch).split('=').at(1));
}

function btcRelationFromRow(row = {}) {
  return normalizeBtcRelation(
    row.btcRelation ||
    row.btcStateRelation ||
    row.btcState ||
    relationFromDefinitionParts(row.definitionParts)
  );
}

function validLongRiskGeometry(row = {}) {
  const hasGeometry =
    row.entry !== undefined ||
    row.sl !== undefined ||
    row.tp !== undefined ||
    row.stopLoss !== undefined ||
    row.takeProfit !== undefined;

  if (!hasGeometry) return true;

  const entry = safeNumber(row.entry, 0);
  const sl = safeNumber(row.sl ?? row.stopLoss, 0);
  const tp = safeNumber(row.tp ?? row.takeProfit, 0);

  return entry > 0 && sl > 0 && tp > 0 && sl < entry && entry < tp;
}

function positionRiskFraction(position = {}) {
  const cfg = sizingConfig();
  const direct = safeNumber(position.riskFraction, NaN);

  if (Number.isFinite(direct) && direct > 0) {
    return direct;
  }

  return cfg.baseRiskPct;
}

function normalizeRiskFraction(value) {
  const cfg = sizingConfig();
  const risk = safeNumber(value, cfg.baseRiskPct);

  return clamp(
    risk,
    0,
    Math.max(
      cfg.maxTotalRiskPct,
      cfg.maxSameSideRiskPct,
      cfg.baseRiskPct,
      0
    )
  );
}

function buildStatsSideProbe({
  weeklyStats,
  side,
  tradeSide
} = {}) {
  return {
    ...(weeklyStats || {}),

    side: side ?? weeklyStats?.side,
    tradeSide: tradeSide ?? weeklyStats?.tradeSide,
    positionSide: tradeSide ?? weeklyStats?.positionSide,
    direction: tradeSide ?? weeklyStats?.direction
  };
}

function longModeFlags(extra = {}) {
  const taxonomy = taxonomyIdentity(extra);

  return {
    ...baseModeFlags(),

    parentTrueMicroFamilyId: taxonomy.parentTrueMicroFamilyId,
    childTrueMicroFamilyId: taxonomy.childTrueMicroFamilyId,
    trueMicroFamilyId: taxonomy.exactChild ? taxonomy.childTrueMicroFamilyId : taxonomy.trueMicroFamilyId,
    microFamilyId: taxonomy.exactChild ? taxonomy.childTrueMicroFamilyId : taxonomy.trueMicroFamilyId,

    setupType: taxonomy.setupType,
    regimeBucket: taxonomy.regimeBucket,
    confirmationProfile: taxonomy.confirmationProfile,

    exact75ChildTrueMicro: taxonomy.exactChild,
    learningStatus: learningStatus(extra),
    status: learningStatus(extra),
    activeLearningUsable: completedCount(extra) >= MIN_COMPLETED_ACTIVE_LEARNING,
    tooEarly: completedCount(extra) < MIN_COMPLETED_ACTIVE_LEARNING
  };
}

export function riskFractionForEntry({
  weeklyStats,
  side = null,
  tradeSide = null
} = {}) {
  const cfg = sizingConfig();

  const explicitSideProvided =
    side !== null ||
    tradeSide !== null ||
    weeklyStats?.tradeSide ||
    weeklyStats?.side ||
    weeklyStats?.positionSide ||
    weeklyStats?.direction;

  const statsSide = inferTradeSide(
    buildStatsSideProbe({
      weeklyStats,
      side,
      tradeSide
    })
  );

  if (explicitSideProvided && statsSide !== TARGET_TRADE_SIDE) {
    return 0;
  }

  if (exactChildRequiredButMissing(weeklyStats)) {
    return 0;
  }

  if (!validLongRiskGeometry(weeklyStats)) {
    return 0;
  }

  if (!cfg.enabled) {
    return round6(cfg.baseRiskPct);
  }

  const completed = completedCount(weeklyStats);

  const balanced = safeNumber(
    weeklyStats?.dashboardBalancedScore ??
      weeklyStats?.balancedScore,
    0
  );

  const fairWinrate = safeNumber(
    weeklyStats?.fairWinrate ??
      weeklyStats?.sampleAdjustedWinrate ??
      weeklyStats?.sampleWilsonLowerBound ??
      weeklyStats?.wilsonLowerBound,
    0
  );

  const avgR = safeNumber(weeklyStats?.avgR, 0);
  const totalR = safeNumber(weeklyStats?.totalR, 0);
  const avgCostR = Math.max(0, safeNumber(weeklyStats?.avgCostR, 0));

  const sampleConf = clamp(
    completed / cfg.priorTrades,
    0,
    1
  );

  const qualityConf = clamp(
    balanced / 100,
    0,
    1
  );

  const winrateConf = fairWinrate > 0
    ? clamp((fairWinrate - 0.45) / 0.25, 0, 1)
    : 0;

  const avgRConf = clamp(
    (avgR + 0.25) / 1.25,
    0,
    1
  );

  const totalRConf = clamp(
    totalR / 10,
    0,
    1
  );

  const costPenalty = clamp(
    avgCostR / 0.5,
    0,
    1
  );

  const confidence =
    sampleConf * 0.30 +
    qualityConf * 0.30 +
    winrateConf * 0.20 +
    avgRConf * 0.10 +
    totalRConf * 0.10 -
    costPenalty * 0.15;

  const maxMult = Math.max(cfg.minMult, cfg.maxMult);

  const mult = clamp(
    cfg.minMult + (maxMult - cfg.minMult) * clamp(confidence, 0, 1),
    cfg.minMult,
    maxMult
  );

  return round6(cfg.baseRiskPct * mult);
}

export function summarizeOpenRisk(openPositions = []) {
  const rows = Array.isArray(openPositions) ? openPositions : [];

  let total = 0;
  let longRisk = 0;
  let nonLongRisk = 0;
  let unknownSideRisk = 0;
  let counterBtcRisk = 0;
  let exactChildPositions = 0;
  let invalidIdentityPositions = 0;
  let invalidRiskGeometryPositions = 0;

  const trueMicroFamilyIds = new Set();
  const parentTrueMicroFamilyIds = new Set();

  for (const position of rows) {
    const tradeSide = inferTradeSide(position);
    const identity = taxonomyIdentity(position);
    const risk = positionRiskFraction(position);

    total += risk;

    if (tradeSide === TARGET_TRADE_SIDE) {
      longRisk += risk;
    } else if (tradeSide === 'UNKNOWN') {
      unknownSideRisk += risk;
      nonLongRisk += risk;
    } else {
      nonLongRisk += risk;
    }

    if (identity.exactChild) {
      exactChildPositions += 1;
      trueMicroFamilyIds.add(identity.childTrueMicroFamilyId);
      parentTrueMicroFamilyIds.add(identity.parentTrueMicroFamilyId);
    } else if (extractTrueMicroFamilyId(position)) {
      invalidIdentityPositions += 1;
    }

    if (!validLongRiskGeometry(position)) {
      invalidRiskGeometryPositions += 1;
    }

    if (btcRelationFromRow(position) === 'BTC_AGAINST') {
      counterBtcRisk += risk;
    }
  }

  return {
    total: round6(total),

    longRisk: round6(longRisk),

    shortRisk: 0,

    nonLongRisk: round6(nonLongRisk),
    nonShortRisk: round6(nonLongRisk),
    unknownSideRisk: round6(unknownSideRisk),
    counterBtcRisk: round6(counterBtcRisk),

    exactChildPositions,
    invalidIdentityPositions,
    invalidRiskGeometryPositions,

    trueMicroFamilyIds: [...trueMicroFamilyIds],
    childTrueMicroFamilyIds: [...trueMicroFamilyIds],
    parentTrueMicroFamilyIds: [...parentTrueMicroFamilyIds],

    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,

    ...baseModeFlags()
  };
}

export function checkRiskCaps({
  openPositions = [],
  side,
  tradeSide = side,
  btcRelation,
  riskFraction,
  weeklyStats,
  entry,
  sl,
  tp,
  stopLoss,
  takeProfit,
  trueMicroFamilyId,
  childTrueMicroFamilyId,
  microFamilyId,
  parentTrueMicroFamilyId
} = {}) {
  const cfg = sizingConfig();

  const requestRow = {
    ...(weeklyStats || {}),
    entry: entry ?? weeklyStats?.entry,
    sl: sl ?? stopLoss ?? weeklyStats?.sl ?? weeklyStats?.stopLoss,
    tp: tp ?? takeProfit ?? weeklyStats?.tp ?? weeklyStats?.takeProfit,
    trueMicroFamilyId:
      childTrueMicroFamilyId ||
      trueMicroFamilyId ||
      weeklyStats?.childTrueMicroFamilyId ||
      weeklyStats?.trueMicroFamilyId ||
      microFamilyId ||
      weeklyStats?.microFamilyId,
    childTrueMicroFamilyId:
      childTrueMicroFamilyId ||
      weeklyStats?.childTrueMicroFamilyId ||
      trueMicroFamilyId ||
      weeklyStats?.trueMicroFamilyId ||
      microFamilyId ||
      weeklyStats?.microFamilyId,
    microFamilyId:
      microFamilyId ||
      childTrueMicroFamilyId ||
      trueMicroFamilyId ||
      weeklyStats?.microFamilyId ||
      weeklyStats?.trueMicroFamilyId,
    parentTrueMicroFamilyId:
      parentTrueMicroFamilyId ||
      weeklyStats?.parentTrueMicroFamilyId ||
      weeklyStats?.coarseMicroFamilyId,
    side,
    tradeSide,
    positionSide: tradeSide,
    direction: tradeSide,
    longOnly: true,
    shortDisabled: true
  };

  const want = normalizeRiskFraction(riskFraction);
  const open = summarizeOpenRisk(openPositions);

  const requestedTradeSide = inferTradeSide(requestRow);
  const relation = normalizeBtcRelation(btcRelation);
  const identity = taxonomyIdentity(requestRow);

  if (requestedTradeSide !== TARGET_TRADE_SIDE) {
    return {
      ok: false,
      reason: 'LONG_ONLY_SYSTEM_REJECTED_NON_LONG_RISK',
      side,
      tradeSide: requestedTradeSide,
      riskFraction: 0,
      want,
      riskState: open,

      ...longModeFlags(requestRow)
    };
  }

  if (extractTrueMicroFamilyId(requestRow) && !identity.exactChild) {
    return {
      ok: false,
      reason: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_REQUIRED',
      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      riskFraction: 0,
      want,
      riskState: open,

      ...longModeFlags(requestRow)
    };
  }

  if (!validLongRiskGeometry(requestRow)) {
    return {
      ok: false,
      reason: 'LONG_RISK_GEOMETRY_INVALID_SL_LT_ENTRY_LT_TP_REQUIRED',
      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      riskFraction: 0,
      want,
      riskState: open,

      ...longModeFlags(requestRow)
    };
  }

  if (want <= 0) {
    return {
      ok: false,
      reason: 'ZERO_RISK_FRACTION',
      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      riskFraction: 0,
      want,
      riskState: open,

      ...longModeFlags(requestRow)
    };
  }

  if (!cfg.enabled) {
    return {
      ok: true,
      reason: 'SIZING_DISABLED',
      riskFraction: want,
      openRiskBefore: open.total,
      openRiskAfter: round6(open.total + want),
      sideRiskAfter: round6(open.longRisk + want),
      riskState: open,

      ...longModeFlags(requestRow)
    };
  }

  if (open.total + want > cfg.maxTotalRiskPct) {
    return {
      ok: false,
      reason: 'MAX_TOTAL_RISK',
      open: open.total,
      want,
      cap: cfg.maxTotalRiskPct,
      riskState: open,

      ...longModeFlags(requestRow)
    };
  }

  if (open.longRisk + want > cfg.maxSameSideRiskPct) {
    return {
      ok: false,
      reason: 'MAX_LONG_SIDE_RISK',
      side: TARGET_TRADE_SIDE,
      open: open.longRisk,
      want,
      cap: cfg.maxSameSideRiskPct,
      riskState: open,

      ...longModeFlags(requestRow)
    };
  }

  if (
    relation === 'BTC_AGAINST' &&
    open.counterBtcRisk + want > cfg.maxCounterBtcRiskPct
  ) {
    return {
      ok: false,
      reason: 'MAX_COUNTER_BTC_RISK',
      open: open.counterBtcRisk,
      want,
      cap: cfg.maxCounterBtcRiskPct,
      riskState: open,

      ...longModeFlags(requestRow)
    };
  }

  return {
    ok: true,
    riskFraction: want,
    openRiskBefore: open.total,
    openRiskAfter: round6(open.total + want),
    sideRiskAfter: round6(open.longRisk + want),
    counterBtcRiskAfter: relation === 'BTC_AGAINST'
      ? round6(open.counterBtcRisk + want)
      : open.counterBtcRisk,
    riskState: open,

    ...longModeFlags(requestRow)
  };
}