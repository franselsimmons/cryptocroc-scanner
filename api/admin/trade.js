// ================= FILE: api/admin/trade.js =================

import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import {
  getDurableRedis,
  getVolatileRedis,
  getJson
} from '../../src/redis.js';
import { getOpenPositions } from '../../src/trade/positionEngine.js';
import {
  safeNumber,
  sideToTradeSide,
  normalizeBaseSymbol,
  normalizeContractSymbol
} from '../../src/utils.js';
import { getActiveRotation } from '../../src/analyze/rotationEngine.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;

const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';
const MIN_COMPLETED_ACTIVE_LEARNING = 20;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;

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
  scan: {
    latest: namespacedLongKey(
      KEYS.long?.scan?.latest ||
        KEYS.scan?.longLatest ||
        KEYS.scan?.latest,
      'SCAN:LATEST'
    )
  },

  trade: {
    runMeta: namespacedLongKey(
      KEYS.long?.trade?.runMeta ||
        KEYS.trade?.longRunMeta ||
        KEYS.trade?.runMeta,
      'TRADE:RUN_META'
    ),

    lastProcessedSnapshot: namespacedLongKey(
      KEYS.long?.trade?.lastProcessedSnapshot ||
        KEYS.trade?.longLastProcessedSnapshot ||
        KEYS.trade?.lastProcessedSnapshot,
      'TRADE:LAST_PROCESSED_SNAPSHOT'
    )
  }
};

function modeFlags() {
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

    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,

    globalMaxOpenPositionsBlockDisabled: true,
    maxOneOpenPositionPerSymbol: true,

    positionTimeStopMinDefault: DEFAULT_POSITION_TIME_STOP_MIN,

    scannerSide: TARGET_DASHBOARD_SIDE,
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,

    bucketsCoarseOnly: true,
    bucketGranularity: 'LOW_MID_HIGH',

    learningMode: 'MICRO_FAMILY_LONG_ONLY_VIRTUAL',
    discordOnlyForManualSelection: true,
    manualSelectionOnly: true,
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    autoRotationActivationDisabled: true,
    activateFreezeCronDisabled: true,
    resetCronDisabled: true,
    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForExactTrueMicroMatch: true,

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
    shortRootTouched: false,

    adminReadOnly: true
  };
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

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);

  return [];
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function num(value, fallback = 0) {
  const n = safeNumber(value, fallback);

  return Number.isFinite(n) ? n : fallback;
}

function round(value, decimals = 4) {
  return Number(num(value, 0).toFixed(decimals));
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
      .flatMap((value) => String(value || '').split(/[\s,;\n\r]+/g))
      .map((part) => part.trim())
      .filter(Boolean)
  )];
}

function getArray(value) {
  return Array.isArray(value) ? value : [];
}

function getPositionTimeStopMin() {
  const value = num(CONFIG.trade?.positionTimeStopMin, DEFAULT_POSITION_TIME_STOP_MIN);

  if (!Number.isFinite(value) || value <= 0) return DEFAULT_POSITION_TIME_STOP_MIN;

  return value;
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

function isScannerFingerprintId(id = '') {
  const value = upper(id);

  return (
    value.startsWith('MICRO_LONG_SCANNER__') ||
    value.includes('MICRO_LONG_SCANNER__') ||
    value.startsWith('LONG_SCANNER_') ||
    value.startsWith('MICRO_SHORT_SCANNER__') ||
    value.includes('MICRO_SHORT_SCANNER__') ||
    value.startsWith('SHORT_SCANNER_') ||
    value.includes('__SCANNER__') ||
    value.includes('SCANNER_GATE_PASS') ||
    value.includes('SCANNER_GATE_FAIL')
  );
}

function normalizeDirectSide(value) {
  const raw = cleanSideText(value);

  if (!raw) return 'UNKNOWN';

  const converted = sideToTradeSide(raw);

  if (converted === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (converted === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

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
    if (hasLongToken(row)) return TARGET_TRADE_SIDE;
    if (hasShortToken(row)) return OPPOSITE_TRADE_SIDE;

    return 'UNKNOWN';
  }

  const explicitSourceSide = normalizeDirectSide(
    row.rawInferredTradeSide ||
    row.originalTradeSide ||
    null
  );

  if (explicitSourceSide === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (explicitSourceSide === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  const inferredSide = normalizeDirectSide(row.inferredTradeSide);

  if (inferredSide === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (inferredSide === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

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
    row.parentMacroFamilyId,
    row.macroFamilyId,
    row.parentMicroFamilyId,
    row.parentFamilyId,
    row.macroId,
    row.macroFamily,
    row.originalMicroFamilyId,
    row.microFamilyId,
    row.trueMicroFamilyId,
    row.liveMicroFamilyId,
    row.realMicroFamilyId,
    row.executionMicroFamilyId,
    row.coarseMicroFamilyId,
    row.id,
    row.key
  ]
    .map((value) => cleanSideText(value))
    .filter(Boolean)
    .join(' | ');

  const familyLong = hasLongToken(familyText);
  const familyShort = hasShortToken(familyText);

  if (familyLong && !familyShort) return TARGET_TRADE_SIDE;
  if (familyShort && !familyLong) return OPPOSITE_TRADE_SIDE;

  if (familyLong && familyShort) {
    const microText = cleanSideText(
      row.trueMicroFamilyId ||
      row.microFamilyId ||
      row.liveMicroFamilyId ||
      row.realMicroFamilyId ||
      row.executionMicroFamilyId ||
      row.coarseMicroFamilyId ||
      row.id ||
      row.key
    );

    if (hasLongToken(microText)) return TARGET_TRADE_SIDE;
    if (hasShortToken(microText)) return OPPOSITE_TRADE_SIDE;
  }

  const reasonText = [
    row.scannerReason,
    row.reason,
    row.signalReason,
    row.actionReason,
    row.exitReason,
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

function isLongRow(row = {}) {
  return inferTradeSide(row) !== OPPOSITE_TRADE_SIDE;
}

function isShortRow(row = {}) {
  return inferTradeSide(row) === OPPOSITE_TRADE_SIDE;
}

function isUnknownSideRow(row = {}) {
  return inferTradeSide(row) === 'UNKNOWN';
}

function isAllowedLongId(id = '') {
  const value = String(id || '').trim();

  if (!value) return false;
  if (isScannerFingerprintId(value)) return false;

  return inferTradeSide(value) !== OPPOSITE_TRADE_SIDE;
}

function forceLongRow(row = {}) {
  return {
    ...row,
    ...modeFlags(),

    source: row.source || 'VIRTUAL',
    outcomeSource: row.outcomeSource || row.source || 'VIRTUAL',

    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: Boolean(row.shadowOnly),

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    realOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    noRealOrders: true,

    inferredTradeSide: TARGET_TRADE_SIDE
  };
}

function calcAgeSec(ts) {
  const value = num(ts, 0);

  if (value <= 0) return null;

  return Math.max(0, Math.floor((now() - value) / 1000));
}

function calcRiskDistance(entry, initialSl) {
  const e = num(entry, 0);
  const sl = num(initialSl, 0);

  if (e <= 0 || sl <= 0 || sl >= e) return 0;

  return e - sl;
}

function calcRewardDistance(entry, tp) {
  const e = num(entry, 0);
  const target = num(tp, 0);

  if (e <= 0 || target <= e) return 0;

  return target - e;
}

function calcCurrentR({
  entry,
  initialSl,
  currentPrice,
  fallback = 0
} = {}) {
  const e = num(entry, 0);
  const sl = num(initialSl, 0);
  const price = num(currentPrice, 0);
  const riskDistance = calcRiskDistance(e, sl);

  if (e <= 0 || sl <= 0 || price <= 0 || riskDistance <= 0) {
    return num(fallback, 0);
  }

  return (price - e) / riskDistance;
}

function getFamilyId(row = {}) {
  return (
    row.familyId ||
    row.family ||
    row.baseFamilyId ||
    null
  );
}

function getMacroFamilyId(row = {}) {
  return (
    row.parentMacroFamilyId ||
    row.macroFamilyId ||
    row.parentMicroFamilyId ||
    row.parentFamilyId ||
    row.macroId ||
    row.macroFamily ||
    row.originalMicroFamilyId ||
    null
  );
}

function getMicroFamilyId(row = {}) {
  return (
    row.trueMicroFamilyId ||
    row.microFamilyId ||
    row.liveMicroFamilyId ||
    row.realMicroFamilyId ||
    row.executionMicroFamilyId ||
    row.coarseMicroFamilyId ||
    row.id ||
    row.key ||
    null
  );
}

function getCoarseMicroFamilyId(row = {}) {
  return (
    row.coarseMicroFamilyId ||
    row.baseMicroFamilyId ||
    row.legacyMicroFamilyId ||
    row.trueMicroFamilyId ||
    row.microFamilyId ||
    null
  );
}

function normalizeDefinitionParts(value) {
  if (Array.isArray(value)) return value;

  if (typeof value === 'string') {
    return value
      .split('|')
      .map((part) => part.trim())
      .filter(Boolean);
  }

  return [];
}

function safeBaseSymbol(value) {
  try {
    return normalizeBaseSymbol(value);
  } catch {
    return String(value || '').trim();
  }
}

function safeContractSymbol(value) {
  try {
    return normalizeContractSymbol(value);
  } catch {
    return String(value || '').trim();
  }
}

function getRawPositionSide(position = {}) {
  return inferTradeSide({
    ...position,
    rawInferredTradeSide: null,
    inferredTradeSide: null
  });
}

function validLongRiskShape({
  entry,
  initialSl,
  sl,
  tp
} = {}) {
  const e = num(entry, 0);
  const stop = num(sl ?? initialSl, 0);
  const initialStop = num(initialSl ?? sl, 0);
  const target = num(tp, 0);

  return e > 0 && stop > 0 && initialStop > 0 && stop < e && initialStop < e && target > e;
}

function buildExitDebug({
  entry,
  sl,
  initialSl,
  tp,
  currentPrice,
  openedAt
} = {}) {
  const ageSec = calcAgeSec(openedAt);
  const timeStopMin = getPositionTimeStopMin();
  const timeStopSec = timeStopMin * 60;

  const tpHitNow = currentPrice > 0 && tp > 0 && currentPrice >= tp;
  const slHitNow = currentPrice > 0 && sl > 0 && currentPrice <= sl;
  const timeStopHitNow = ageSec !== null && ageSec >= timeStopSec;

  let exitReasonNow = null;

  if (tpHitNow) exitReasonNow = 'TP';
  else if (slHitNow) exitReasonNow = 'SL';
  else if (timeStopHitNow) exitReasonNow = 'TIME_STOP';

  return {
    tpHitNow,
    slHitNow,
    timeStopHitNow,
    exitReadyNow: Boolean(exitReasonNow),
    exitReasonNow,

    longExitPriority: ['TP', 'SL', 'TIME_STOP'],
    tpSlIndependentFromTimeStop: true,

    timeStopMin,
    timeStopSec,
    ageSec,
    secondsUntilTimeStop: ageSec === null
      ? null
      : Math.max(0, timeStopSec - ageSec),

    grossRIfClosedNow: round(
      calcCurrentR({
        entry,
        initialSl,
        currentPrice,
        fallback: 0
      }),
      4
    )
  };
}

function normalizePosition(position = {}) {
  const rawSymbol =
    position.symbol ||
    position.baseSymbol ||
    position.contractSymbol ||
    position.instId ||
    position.instrumentId ||
    null;

  const symbol = safeBaseSymbol(rawSymbol);

  const contractSymbol = safeContractSymbol(
    position.contractSymbol ||
    position.symbol ||
    position.instId ||
    position.instrumentId ||
    symbol
  );

  const microFamilyId = getMicroFamilyId(position);
  const trueMicroFamilyId = position.trueMicroFamilyId || microFamilyId;
  const coarseMicroFamilyId = getCoarseMicroFamilyId(position);
  const macroFamilyId = getMacroFamilyId(position) || position.parentMacroFamilyId || microFamilyId;
  const familyId = getFamilyId(position);

  const rawInferredTradeSide = getRawPositionSide({
    ...position,
    microFamilyId,
    trueMicroFamilyId,
    coarseMicroFamilyId,
    macroFamilyId,
    familyId
  });

  const entry = num(position.entry ?? position.entryPrice, 0);
  const sl = num(position.sl ?? position.stopLoss, 0);
  const initialSl = num(
    position.initialSl ??
    position.initialStopLoss ??
    sl,
    sl
  );
  const tp = num(position.tp ?? position.takeProfit, 0);

  const lastPrice = num(
    position.lastPrice ??
    position.currentPrice ??
    position.markPrice ??
    position.price,
    0
  );

  const currentPrice = num(
    position.currentPrice ??
    position.lastPrice ??
    position.markPrice ??
    position.price,
    lastPrice
  );

  const riskDistance = calcRiskDistance(entry, initialSl);
  const rewardDistance = calcRewardDistance(entry, tp);

  const rr = num(
    position.rr,
    riskDistance > 0 ? rewardDistance / riskDistance : 0
  );

  const currentR = calcCurrentR({
    entry,
    initialSl,
    currentPrice,
    fallback: position.currentR
  });

  const openedAt = num(
    position.openedAt ??
    position.createdAt ??
    position.ts,
    0
  );

  const macroDefinitionParts = normalizeDefinitionParts(
    position.macroDefinitionParts ||
    position.parentDefinitionParts ||
    position.macroDefinition ||
    position.parentDefinition
  );

  const definitionParts = normalizeDefinitionParts(
    position.definitionParts ||
    position.microDefinitionParts ||
    position.definition ||
    position.microDefinition
  );

  const riskShapeValid = validLongRiskShape({
    entry,
    sl,
    initialSl,
    tp
  });

  const exitDebug = buildExitDebug({
    entry,
    sl,
    initialSl,
    tp,
    currentPrice,
    openedAt
  });

  return {
    ...position,

    symbol: symbol || position.symbol || null,
    baseSymbol: symbol || position.baseSymbol || null,
    contractSymbol,

    ...modeFlags(),

    rawInferredTradeSide,
    inferredTradeSide: rawInferredTradeSide === 'UNKNOWN'
      ? TARGET_TRADE_SIDE
      : rawInferredTradeSide,
    inferredFromLongOnlyMode: rawInferredTradeSide === 'UNKNOWN',

    source: 'VIRTUAL',
    outcomeSource: position.outcomeSource || 'VIRTUAL',
    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: Boolean(position.shadowOnly),
    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    realOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    noRealOrders: true,

    entry,
    sl,
    initialSl,
    tp,
    rr: round(rr, 4),

    longRiskShapeValid: riskShapeValid,

    lastPrice,
    currentPrice,
    currentR: round(currentR, 4),
    mfeR: round(position.mfeR, 4),
    maeR: round(position.maeR, 4),

    riskPct: round(position.riskPct, 6),
    riskFraction: round(position.riskFraction, 6),

    familyId,
    macroFamilyId,
    parentMacroFamilyId: position.parentMacroFamilyId || macroFamilyId || null,
    microFamilyId,
    trueMicroFamilyId,
    coarseMicroFamilyId,

    macroDefinition: position.macroDefinition || position.parentDefinition || null,
    macroDefinitionParts,

    definition: position.definition || position.microDefinition || null,
    definitionParts,
    microDefinitionParts: normalizeDefinitionParts(
      position.microDefinitionParts ||
      position.definitionParts ||
      position.microDefinition ||
      position.definition
    ),

    activeRotationId: position.activeRotationId || null,
    selectedRotationId: position.selectedRotationId || position.activeRotationId || null,

    discordAlertEligible: Boolean(position.discordAlertEligible),
    selectedMicroFamilyAlert: Boolean(position.selectedMicroFamilyAlert),
    discordEntryAlertSent: Boolean(position.discordEntryAlertSent),
    discordExitAlertEligible: Boolean(position.discordExitAlertEligible),
    discordExitAlertSent: Boolean(position.discordExitAlertSent),

    openedAt,
    ageSec: exitDebug.ageSec,

    riskDistance: round(riskDistance, 10),
    rewardDistance: round(rewardDistance, 10),

    ticksObserved: num(position.ticksObserved, 0),
    favorableTicks: num(position.favorableTicks, 0),
    adverseTicks: num(position.adverseTicks, 0),

    priceFetchFailures: num(position.priceFetchFailures, 0),
    lastPriceFetchFailedAt: position.lastPriceFetchFailedAt || null,

    reachedHalfR: Boolean(position.reachedHalfR),
    reachedOneR: Boolean(position.reachedOneR),
    nearTpSeen: Boolean(position.nearTpSeen),

    beArmed: Boolean(position.beArmed),
    beWouldExit: Boolean(position.beWouldExit),
    beExitR: num(position.beExitR, 0),

    gaveBackAfterHalfR: Boolean(position.gaveBackAfterHalfR),
    gaveBackAfterOneR: Boolean(position.gaveBackAfterOneR),
    nearTpThenLoss: Boolean(position.nearTpThenLoss),

    liveManaged: Boolean(position.liveManaged),
    beLiveApplied: Boolean(position.beLiveApplied),
    trailLiveApplied: Boolean(position.trailLiveApplied),
    slManagementSource: position.slManagementSource || null,

    breakEvenArmed: Boolean(position.beArmed || position.breakEvenArmed),
    trailingActive: Boolean(
      position.trailLiveApplied ||
      position.trailingActive ||
      upper(position.slManagementSource) === 'TRAIL'
    ),

    ...exitDebug
  };
}

function sum(rows, selector) {
  return rows.reduce((total, row) => total + num(selector(row), 0), 0);
}

function average(rows, selector) {
  if (!rows.length) return 0;

  return sum(rows, selector) / rows.length;
}

function countBy(rows, selector) {
  return rows.reduce((acc, row) => {
    const key = selector(row) || 'unknown';
    acc[key] = (acc[key] || 0) + 1;

    return acc;
  }, {});
}

function buildPositionStats(positions = [], ignored = {}) {
  const longRows = positions.filter(isLongRow);

  const totalCurrentR = sum(longRows, (p) => p.currentR);
  const totalMfeR = sum(longRows, (p) => p.mfeR);
  const totalMaeR = sum(longRows, (p) => p.maeR);
  const totalRiskFraction = sum(longRows, (p) => p.riskFraction);

  const profitable = longRows.filter((p) => num(p.currentR, 0) > 0);
  const losing = longRows.filter((p) => num(p.currentR, 0) < 0);

  const uniqueMacroFamilies = uniqueStrings(
    longRows.map((position) => position.macroFamilyId)
  );

  const uniqueMicroFamilies = uniqueStrings(
    longRows.map((position) => position.microFamilyId)
  );

  const discordEligiblePositions = longRows.filter((position) => position.discordAlertEligible);
  const selectedMicroFamilyPositions = longRows.filter((position) => position.selectedMicroFamilyAlert);
  const invalidRiskShapePositions = longRows.filter((position) => !position.longRiskShapeValid);

  return {
    ...modeFlags(),

    openPositions: longRows.length,
    openVirtualPositions: longRows.length,

    bullPositions: longRows.length,
    bearPositions: 0,
    unknownSidePositions: num(ignored.unknownSidePositionsTreatedAsLong, 0),

    longPositions: longRows.length,
    shortPositions: 0,

    rawOpenPositions: num(ignored.rawOpenPositions, longRows.length),
    ignoredShortPositions: num(ignored.ignoredShortPositions, 0),
    ignoredUnknownSidePositions: 0,
    unknownSidePositionsTreatedAsLong: num(ignored.unknownSidePositionsTreatedAsLong, 0),

    invalidLongRiskShapePositions: invalidRiskShapePositions.length,

    profitablePositions: profitable.length,
    losingPositions: losing.length,
    flatPositions: longRows.length - profitable.length - losing.length,

    exitReadyNow: longRows.filter((p) => p.exitReadyNow).length,
    tpHitNow: longRows.filter((p) => p.tpHitNow).length,
    slHitNow: longRows.filter((p) => p.slHitNow).length,
    timeStopHitNow: longRows.filter((p) => p.timeStopHitNow).length,

    totalCurrentR: round(totalCurrentR, 4),
    avgCurrentR: round(average(longRows, (p) => p.currentR), 4),

    totalMfeR: round(totalMfeR, 4),
    avgMfeR: round(average(longRows, (p) => p.mfeR), 4),

    totalMaeR: round(totalMaeR, 4),
    avgMaeR: round(average(longRows, (p) => p.maeR), 4),

    totalRiskFraction: round(totalRiskFraction, 6),
    longRiskFraction: round(totalRiskFraction, 6),
    shortRiskFraction: 0,

    reachedHalfR: longRows.filter((p) => p.reachedHalfR).length,
    reachedOneR: longRows.filter((p) => p.reachedOneR).length,
    nearTpSeen: longRows.filter((p) => p.nearTpSeen).length,

    beArmed: longRows.filter((p) => p.beArmed).length,
    beWouldExit: longRows.filter((p) => p.beWouldExit).length,

    breakEvenArmed: longRows.filter((p) => p.breakEvenArmed).length,
    trailingActive: longRows.filter((p) => p.trailingActive).length,

    gaveBackAfterHalfR: longRows.filter((p) => p.gaveBackAfterHalfR).length,
    gaveBackAfterOneR: longRows.filter((p) => p.gaveBackAfterOneR).length,
    nearTpThenLoss: longRows.filter((p) => p.nearTpThenLoss).length,

    discordEligiblePositions: discordEligiblePositions.length,
    selectedMicroFamilyPositions: selectedMicroFamilyPositions.length,
    silentLearningPositions: longRows.length - discordEligiblePositions.length,

    uniqueMacroFamilies: uniqueMacroFamilies.length,
    uniqueMicroFamilies: uniqueMicroFamilies.length,

    byMacroFamily: countBy(longRows, (p) => p.macroFamilyId),
    byMicroFamily: countBy(longRows, (p) => p.microFamilyId),

    bySide: {
      bull: longRows.length,
      bear: 0,
      unknown: num(ignored.unknownSidePositionsTreatedAsLong, 0)
    }
  };
}

function extractSnapshotId(value) {
  if (!value) return null;

  if (typeof value === 'string') return value;

  if (typeof value === 'object') {
    return (
      value.snapshotId ||
      value.id ||
      value.latestSnapshotId ||
      value.scanId ||
      null
    );
  }

  return null;
}

function normalizeLastProcessed(lastProcessed) {
  const snapshotId = extractSnapshotId(lastProcessed);

  if (!lastProcessed) {
    return {
      snapshotId: null,
      raw: null,
      ...modeFlags()
    };
  }

  if (typeof lastProcessed === 'string') {
    return {
      snapshotId: lastProcessed,
      raw: lastProcessed,
      ...modeFlags()
    };
  }

  return {
    ...lastProcessed,
    ...modeFlags(),
    snapshotId,
    raw: lastProcessed
  };
}

function getRawActionSide(action = {}) {
  return inferTradeSide({
    ...action,
    rawInferredTradeSide: null,
    inferredTradeSide: null
  });
}

function normalizeAction(action = {}) {
  const microFamilyId = getMicroFamilyId(action);
  const trueMicroFamilyId = action.trueMicroFamilyId || microFamilyId;
  const coarseMicroFamilyId = getCoarseMicroFamilyId(action);
  const macroFamilyId = getMacroFamilyId(action) || action.parentMacroFamilyId || microFamilyId;
  const familyId = getFamilyId(action);

  const rawInferredTradeSide = getRawActionSide({
    ...action,
    microFamilyId,
    trueMicroFamilyId,
    coarseMicroFamilyId,
    macroFamilyId,
    familyId
  });

  const virtualOnly = action.virtualOnly !== false;
  const shadowOnly = action.shadowOnly !== false;

  return {
    ...action,

    ...modeFlags(),

    rawInferredTradeSide,
    inferredTradeSide: rawInferredTradeSide === 'UNKNOWN'
      ? TARGET_TRADE_SIDE
      : rawInferredTradeSide,
    inferredFromLongOnlyMode: rawInferredTradeSide === 'UNKNOWN',

    source: action.source || 'VIRTUAL',
    outcomeSource: action.outcomeSource || action.source || 'VIRTUAL',
    virtualOnly,
    virtualTracked: true,
    shadowOnly,
    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,

    familyId,
    macroFamilyId,
    parentMacroFamilyId: action.parentMacroFamilyId || macroFamilyId || null,
    microFamilyId,
    trueMicroFamilyId,
    coarseMicroFamilyId,

    scannerScore: action.scannerScore ?? action.moveScore ?? null,

    confluence: round(action.confluence, 4),
    sniperScore: round(action.sniperScore, 4),

    rr: round(action.rr, 4),
    spreadPct: round(action.spreadPct, 6),
    depthMinUsd1p: round(action.depthMinUsd1p, 2),

    liveEligible: Boolean(action.liveEligible),
    riskValid: Boolean(action.riskValid || action.liveRiskValid),

    discordAlertEligible: Boolean(action.discordAlertEligible),
    selectedMicroFamilyAlert: Boolean(action.selectedMicroFamilyAlert),
    discordAlertSent: Boolean(action.discordAlertSent),
    discordEntryAlertSent: Boolean(action.discordEntryAlertSent),
    discordExitAlertEligible: Boolean(action.discordExitAlertEligible),
    discordExitAlertSent: Boolean(action.discordExitAlertSent)
  };
}

function normalizeExit(row = {}) {
  const action = normalizeAction(row);
  const netR = hasValue(row.netR) ? row.netR : row.r;

  return {
    ...action,

    action: 'VIRTUAL_EXIT',

    source: 'VIRTUAL',
    outcomeSource: 'VIRTUAL',
    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: true,
    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,

    grossR: round(row.grossR, 4),
    costR: round(row.costR ?? row.totalCostR, 4),
    avgCostR: round(row.avgCostR ?? row.costR ?? row.totalCostR, 4),
    netR: round(netR, 4),
    r: round(netR, 4),
    realizedR: round(row.realizedR ?? netR, 4),

    pnlPct: round(row.pnlPct ?? row.netPnlPct, 4),
    grossPnlPct: round(row.grossPnlPct, 4),
    totalCostR: round(row.totalCostR ?? row.costR, 4),

    exitPrice: round(row.exitPrice ?? row.currentPrice ?? row.lastPrice, 10),
    entry: round(row.entry ?? row.entryPrice, 10),
    initialSl: round(row.initialSl ?? row.initialStopLoss ?? row.sl ?? row.stopLoss, 10),
    sl: round(row.sl ?? row.stopLoss, 10),
    tp: round(row.tp ?? row.takeProfit, 10),

    exitReason: row.exitReason || row.reason || null,
    exitedAt: row.exitedAt || row.closedAt || row.ts || null,

    win: Boolean(row.win ?? num(netR, 0) > 0),
    loss: Boolean(row.loss ?? num(netR, 0) < 0),
    flat: Boolean(row.flat ?? num(netR, 0) === 0)
  };
}

function actionCounts(actions = []) {
  return actions.reduce((acc, action) => {
    const key = action.action || action.type || 'UNKNOWN';
    acc[key] = (acc[key] || 0) + 1;

    return acc;
  }, {});
}

function mergeActionCounts(...counts) {
  return counts.reduce((acc, row) => {
    for (const [key, value] of Object.entries(row || {})) {
      acc[key] = num(acc[key], 0) + num(value, 0);
    }

    return acc;
  }, {});
}

function selectRunExitRows(runMeta = {}) {
  if (Array.isArray(runMeta.virtualExits)) return runMeta.virtualExits;
  if (Array.isArray(runMeta.shadowExits)) return runMeta.shadowExits;
  if (Array.isArray(runMeta.exits)) return runMeta.exits;
  if (Array.isArray(runMeta.closedPositions)) return runMeta.closedPositions;
  if (Array.isArray(runMeta.outcomes)) return runMeta.outcomes;
  if (Array.isArray(runMeta.realExits)) return runMeta.realExits;

  return [];
}

function normalizeRunMeta(runMeta) {
  if (!runMeta || typeof runMeta !== 'object') return null;

  const rawActionRows = asArray(runMeta.actions);
  const normalizedActions = rawActionRows.map(normalizeAction);

  const allLongActions = normalizedActions
    .filter(isLongRow)
    .map(forceLongRow);

  const ignoredShortActions = normalizedActions.filter(isShortRow).length;
  const unknownSideActionsTreatedAsLong = normalizedActions.filter(isUnknownSideRow).length;

  const entryActions = allLongActions.filter((action) => (
    action.action === 'VIRTUAL_ENTRY' ||
    action.action === 'ENTRY'
  ));

  const waitActions = allLongActions.filter((action) => action.action === 'WAIT');

  const observationActions = allLongActions.filter((action) => (
    action.action === 'OBSERVATION' ||
    action.observationWritten ||
    action.analysisInputOnly ||
    action.observationOnly
  ));

  const skippedActions = allLongActions.filter((action) => (
    action.action === 'SKIP' ||
    action.skipped ||
    (
      action.reason &&
      action.action !== 'VIRTUAL_ENTRY' &&
      action.action !== 'ENTRY'
    )
  ));

  const runVirtualExitsRaw = selectRunExitRows(runMeta);
  const normalizedExitRows = runVirtualExitsRaw.map(normalizeExit);

  const virtualExits = normalizedExitRows
    .filter(isLongRow)
    .map(forceLongRow);

  const exitActionCounts = virtualExits.length
    ? { VIRTUAL_EXIT: virtualExits.length }
    : {};

  const normalizedActionCounts = mergeActionCounts(
    runMeta.actionCounts || {},
    actionCounts(allLongActions),
    exitActionCounts
  );

  const discordEntryAlerts = allLongActions.filter((action) => (
    action.discordAlertEligible &&
    (
      action.discordEntryAlertSent ||
      action.discordAlertSent ||
      action.discordAlertQueued ||
      action.action === 'VIRTUAL_ENTRY' ||
      action.action === 'ENTRY'
    )
  ));

  const discordExitAlerts = virtualExits.filter((exit) => (
    exit.discordAlertEligible &&
    (
      exit.discordExitAlertSent ||
      exit.discordAlertSent
    )
  ));

  return {
    ...runMeta,

    ...modeFlags(),

    ok: runMeta.ok !== false,
    runId: runMeta.runId || null,

    actions: allLongActions,
    actionsCount: allLongActions.length,

    virtualActions: allLongActions,
    virtualActionsCount: allLongActions.length,

    rawActionsCount: rawActionRows.length,

    ignoredShortActions,
    ignoredUnknownSideActions: 0,
    unknownSideActionsTreatedAsLong,

    actionCounts: normalizedActionCounts,
    rawActionCounts: runMeta.actionCounts || actionCounts(normalizedActions),

    entryRows: num(runMeta.entryRows ?? entryActions.length, entryActions.length),
    waitRows: num(runMeta.waitRows ?? waitActions.length, waitActions.length),
    virtualCreatedRows: num(
      runMeta.virtualCreatedRows ??
      runMeta.shadowCreatedRows ??
      entryActions.length,
      entryActions.length
    ),

    virtualSkippedRows: num(runMeta.virtualSkippedRows ?? runMeta.shadowSkippedRows, 0),
    virtualFailedRows: num(runMeta.virtualFailedRows ?? runMeta.shadowFailedRows, 0),

    entries: entryActions,
    entriesCount: entryActions.length,

    waits: waitActions,
    waitsCount: waitActions.length,

    observations: observationActions,
    observationsCount: observationActions.length,

    skippedActions,
    skippedActionsCount: skippedActions.length,

    virtualExits,
    virtualExitsCount: virtualExits.length,
    virtualExitRows: virtualExits.length,

    exits: virtualExits,
    exitsCount: virtualExits.length,

    realExits: [],
    realExitsCount: 0,

    shadowExits: virtualExits,
    shadowExitsCount: virtualExits.length,
    shadowExitRows: virtualExits.length,

    rawExitRowsCount: runVirtualExitsRaw.length,
    ignoredShortExitRows: normalizedExitRows.filter(isShortRow).length,
    ignoredUnknownSideExitRows: 0,
    unknownSideExitRowsTreatedAsLong: normalizedExitRows.filter(isUnknownSideRow).length,

    discordEntryAlerts: discordEntryAlerts.length,
    discordExitAlerts: discordExitAlerts.length,

    macroFamiliesSeen: uniqueStrings(
      allLongActions.map((action) => action.macroFamilyId)
    ).length,

    microFamiliesSeen: uniqueStrings(
      allLongActions.map((action) => action.microFamilyId)
    ).length,

    startedAt: runMeta.startedAt || null,
    completedAt: runMeta.completedAt || null,
    durationMs: runMeta.durationMs ?? null,

    snapshotId: runMeta.snapshotId || null,
    snapshotAgeSec: runMeta.snapshotAgeSec ?? null,

    skippedNewEntries: Boolean(runMeta.skippedNewEntries),
    skipReason: runMeta.skipReason || runMeta.reason || null,
    reason: runMeta.reason || runMeta.skipReason || null
  };
}

function idsFromRotation(rotation = {}) {
  const rows = Array.isArray(rotation.microFamilies)
    ? rotation.microFamilies
    : [];

  const normalizedRows = rows.map(normalizeAction);

  const longRows = normalizedRows
    .filter(isLongRow)
    .map(forceLongRow)
    .filter((row) => !isScannerFingerprintId(row.microFamilyId));

  const explicitMicroFamilyIds = uniqueStrings([
    rotation.microFamilyIds,
    rotation.activeMicroFamilyIds,
    rotation.trueMicroFamilyIds,
    rotation.ids
  ]).filter(isAllowedLongId);

  const explicitMacroFamilyIds = uniqueStrings([
    rotation.macroFamilyIds,
    rotation.activeMacroFamilyIds,
    rotation.macroIds
  ]).filter(isAllowedLongId);

  const rowMicroFamilyIds = uniqueStrings(
    longRows.map((row) => row.trueMicroFamilyId || row.microFamilyId)
  ).filter(isAllowedLongId);

  const rowMacroFamilyIds = uniqueStrings(
    longRows.map((row) => (
      row.macroFamilyId ||
      row.parentMacroFamilyId ||
      row.parentMicroFamilyId ||
      row.microFamilyId
    ))
  ).filter(isAllowedLongId);

  const microFamilyIds = uniqueStrings([
    rowMicroFamilyIds,
    explicitMicroFamilyIds
  ]).filter(isAllowedLongId);

  const macroFamilyIds = uniqueStrings([
    rowMacroFamilyIds,
    explicitMacroFamilyIds
  ]).filter(isAllowedLongId);

  return {
    microFamilyIds,
    macroFamilyIds: macroFamilyIds.length
      ? macroFamilyIds
      : microFamilyIds,
    longRows,
    rawRows: normalizedRows
  };
}

function normalizeActiveRotation(activeRotation) {
  if (!activeRotation) {
    return {
      ...modeFlags(),

      rotationId: null,
      activeMicroFamilyIds: [],
      activeMacroFamilyIds: [],
      activeMicroCount: 0,
      activeMacroCount: 0,
      microFamilies: [],

      manualSelectionActive: false,
      discordAlertsEnabled: false,

      bestLong: null,
      bestShort: null,
      raw: null
    };
  }

  const ids = idsFromRotation(activeRotation);
  const longRows = ids.longRows;

  const manualSelectionActive = ids.microFamilyIds.length > 0;

  return {
    ...modeFlags(),

    rotationId: activeRotation.rotationId || null,

    activeMicroFamilyIds: ids.microFamilyIds,
    activeMacroFamilyIds: ids.macroFamilyIds,

    microFamilyIds: ids.microFamilyIds,
    trueMicroFamilyIds: ids.microFamilyIds,
    macroFamilyIds: ids.macroFamilyIds,

    activeMicroCount: ids.microFamilyIds.length,
    activeMacroCount: ids.macroFamilyIds.length,

    sourceWeekKey: activeRotation.sourceWeekKey || PERSISTENT_LEARNING_KEY,
    activeWeekKey: activeRotation.activeWeekKey || PERSISTENT_LEARNING_KEY,
    mode: activeRotation.mode || null,
    source: activeRotation.source || null,

    manualSelectionActive,
    discordAlertsEnabled: manualSelectionActive,

    trueMicroOnly: activeRotation.trueMicroOnly !== false,
    usedLegacyFallback: Boolean(activeRotation.usedLegacyFallback),
    usedSoftFallback: Boolean(activeRotation.usedSoftFallback),
    usedObservationFallback: Boolean(activeRotation.usedObservationFallback),
    usedRawFallback: Boolean(activeRotation.usedRawFallback),
    usedPreviousWeekMerge: Boolean(activeRotation.usedPreviousWeekMerge),

    microFamilies: longRows,
    bestLong: longRows[0] || null,
    bestShort: null,

    rawRowsCount: ids.rawRows.length,
    ignoredShortRows: ids.rawRows.filter(isShortRow).length,
    ignoredUnknownSideRows: 0,
    unknownSideRowsTreatedAsLong: ids.rawRows.filter(isUnknownSideRow).length,

    raw: {
      ...activeRotation,

      ...modeFlags(),

      microFamilies: longRows,
      microFamilyIds: ids.microFamilyIds,
      activeMicroFamilyIds: ids.microFamilyIds,
      trueMicroFamilyIds: ids.microFamilyIds,
      macroFamilyIds: ids.macroFamilyIds,
      activeMacroFamilyIds: ids.macroFamilyIds,
      bestLong: longRows[0] || null,
      bestShort: null
    }
  };
}

function buildRotationMatchStats(positions = [], activeRotationMeta = {}) {
  const activeMicroSet = new Set(activeRotationMeta.activeMicroFamilyIds || []);
  const activeMacroSet = new Set(activeRotationMeta.activeMacroFamilyIds || []);

  const selectedMicroPositions = positions.filter((position) => (
    position.trueMicroFamilyId &&
    activeMicroSet.has(position.trueMicroFamilyId)
  ));

  const selectedMacroPositions = positions.filter((position) => (
    position.macroFamilyId &&
    activeMacroSet.has(position.macroFamilyId)
  ));

  const silentLearningPositions = positions.filter((position) => (
    !position.trueMicroFamilyId ||
    !activeMicroSet.has(position.trueMicroFamilyId)
  ));

  return {
    ...modeFlags(),

    manualSelectionActive: activeMicroSet.size > 0,
    discordAlertsEnabled: activeMicroSet.size > 0,

    selectedMicroPositions: selectedMicroPositions.length,
    selectedMacroPositions: selectedMacroPositions.length,

    discordEligiblePositions: selectedMicroPositions.length,
    silentLearningPositions: silentLearningPositions.length,

    silentLearningSymbols: silentLearningPositions
      .map((position) => position.symbol)
      .filter(Boolean),

    activeMicroFamilyIds: [...activeMicroSet],
    activeMacroFamilyIds: [...activeMacroSet]
  };
}

function normalizeLatestScan(latestScan) {
  if (!latestScan || typeof latestScan !== 'object') return latestScan;

  const candidates = Array.isArray(latestScan.candidates)
    ? latestScan.candidates
    : [];

  const longCandidates = candidates
    .filter(isLongRow)
    .map(forceLongRow);

  const shortCandidates = candidates.filter(isShortRow);
  const unknownSideCandidates = candidates.filter(isUnknownSideRow);

  return {
    ...latestScan,

    ...modeFlags(),

    candidates: longCandidates,
    candidatesCount: longCandidates.length,
    longCandidatesCount: longCandidates.length,
    shortCandidatesCount: shortCandidates.length,
    rawCandidatesCount: candidates.length,

    ignoredShortCandidates: shortCandidates.length,
    ignoredUnknownSideCandidates: 0,
    unknownSideCandidatesTreatedAsLong: unknownSideCandidates.length
  };
}

function buildSummary({
  positions = [],
  runMeta = null,
  activeRotation = null,
  latestScannerSnapshotId = null,
  lastProcessedSnapshotId = null
} = {}) {
  return {
    ...modeFlags(),

    openVirtualPositions: positions.length,

    virtualEntriesLastRun: num(runMeta?.entryRows ?? runMeta?.entriesCount, 0),
    virtualExitsLastRun: num(runMeta?.virtualExitsCount, 0),
    shadowExitsLastRun: num(runMeta?.shadowExitsCount, 0),
    observationsLastRun: num(runMeta?.observationsCount, 0),
    skippedActionsLastRun: num(runMeta?.skippedActionsCount, 0),
    waitRowsLastRun: num(runMeta?.waitRows ?? runMeta?.waitsCount, 0),

    actionCountsLastRun: runMeta?.actionCounts || {},

    exitReadyNow: positions.filter((position) => position.exitReadyNow).length,
    tpHitNow: positions.filter((position) => position.tpHitNow).length,
    slHitNow: positions.filter((position) => position.slHitNow).length,
    timeStopHitNow: positions.filter((position) => position.timeStopHitNow).length,

    activeMicroFamilies: num(activeRotation?.activeMicroCount, 0),
    activeMacroFamilies: num(activeRotation?.activeMacroCount, 0),
    manualSelectionActive: Boolean(activeRotation?.manualSelectionActive),
    discordAlertsEnabled: Boolean(activeRotation?.discordAlertsEnabled),

    latestScannerSnapshotId,
    lastProcessedSnapshotId,
    scannerAndTradeInSync: Boolean(
      latestScannerSnapshotId &&
      lastProcessedSnapshotId &&
      latestScannerSnapshotId === lastProcessedSnapshotId
    )
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Trade-Mode', 'long-only-virtual-learning-v2');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Long-Only', 'true');
  res.setHeader('X-Short-Disabled', 'true');
  res.setHeader('X-Virtual-Only', 'true');
  res.setHeader('X-Virtual-Learning-Forced', 'true');
  res.setHeader('X-No-Real-Orders', 'true');
  res.setHeader('X-Real-Orders-Disabled', 'true');
  res.setHeader('X-Bitget-Orders-Disabled', 'true');
  res.setHeader('X-Exchange-Calls-Disabled', 'true');
  res.setHeader('X-Admin-Read-Only', 'true');
  res.setHeader('X-Redis-Namespace', LONG_NAMESPACE);
  res.setHeader('X-Short-Root-Touched', 'false');

  if (req.method !== 'GET') {
    return methodNotAllowed(res);
  }

  try {
    const durable = getDurableRedis();
    const volatile = getVolatileRedis();

    const [
      rawPositions,
      runMetaRaw,
      lastProcessedRaw,
      latestScanRaw,
      activeRotationRaw
    ] = await Promise.all([
      getOpenPositions({
        tradeSide: TARGET_TRADE_SIDE,
        side: TARGET_DASHBOARD_SIDE,
        namespace: LONG_NAMESPACE,
        keyPrefix: LONG_KEY_PREFIX,
        virtualOnly: true
      }),
      getJson(durable, LONG_KEYS.trade.runMeta, null),
      getJson(durable, LONG_KEYS.trade.lastProcessedSnapshot, null),
      getJson(volatile, LONG_KEYS.scan.latest, null),
      getActiveRotation({
        tradeSide: TARGET_TRADE_SIDE,
        side: TARGET_DASHBOARD_SIDE,
        weekKey: PERSISTENT_LEARNING_KEY,
        namespace: LONG_NAMESPACE,
        keyPrefix: LONG_KEY_PREFIX
      }).catch(() => null)
    ]);

    const allPositions = asArray(rawPositions).map(normalizePosition);

    const positions = allPositions
      .filter(isLongRow)
      .map(forceLongRow);

    const ignoredShortPositions = allPositions.filter(isShortRow).length;
    const unknownSidePositionsTreatedAsLong = allPositions.filter(isUnknownSideRow).length;

    const stats = buildPositionStats(positions, {
      rawOpenPositions: allPositions.length,
      ignoredShortPositions,
      unknownSidePositionsTreatedAsLong
    });

    const runMeta = normalizeRunMeta(runMetaRaw);
    const lastProcessed = normalizeLastProcessed(lastProcessedRaw);

    const latestScan = normalizeLatestScan(latestScanRaw);
    const latestScannerSnapshotId = extractSnapshotId(latestScanRaw);

    const scannerAndTradeInSync =
      Boolean(latestScannerSnapshotId) &&
      Boolean(lastProcessed.snapshotId) &&
      latestScannerSnapshotId === lastProcessed.snapshotId;

    const activeRotation = normalizeActiveRotation(activeRotationRaw);

    const rotationMatchStats = buildRotationMatchStats(
      positions,
      activeRotation
    );

    const summary = buildSummary({
      positions,
      runMeta,
      activeRotation,
      latestScannerSnapshotId,
      lastProcessedSnapshotId: lastProcessed.snapshotId
    });

    return res.status(200).json({
      ok: true,

      ...modeFlags(),

      longKeys: {
        namespace: LONG_NAMESPACE,
        prefix: LONG_KEY_PREFIX,
        tradeRunMeta: LONG_KEYS.trade.runMeta,
        tradeLastProcessedSnapshot: LONG_KEYS.trade.lastProcessedSnapshot,
        scanLatest: LONG_KEYS.scan.latest
      },

      positions,
      openPositions: positions,
      virtualPositions: positions,
      openVirtualPositions: positions.length,

      positionsCount: positions.length,
      rawPositionsCount: allPositions.length,
      ignoredShortPositions,
      ignoredUnknownSidePositions: 0,
      unknownSidePositionsTreatedAsLong,

      stats,
      rotationMatchStats,
      summary,

      runMeta,
      lastRunMeta: runMeta
        ? {
          runId: runMeta.runId || null,
          shadowExits: runMeta.shadowExits || [],
          virtualExits: runMeta.virtualExits || [],
          actionCounts: runMeta.actionCounts || {},
          skipReason: runMeta.skipReason || runMeta.reason || null,
          entryRows: runMeta.entryRows,
          waitRows: runMeta.waitRows,
          virtualCreatedRows: runMeta.virtualCreatedRows
        }
        : null,

      lastProcessed,
      lastProcessedSnapshotId: lastProcessed.snapshotId,

      latestScan,
      latestScannerSnapshotId,
      scannerAndTradeInSync,

      activeRotationId: activeRotation.rotationId,
      activeMicroFamilyIds: activeRotation.activeMicroFamilyIds,
      activeMacroFamilyIds: activeRotation.activeMacroFamilyIds,
      activeMicroCount: activeRotation.activeMicroCount,
      activeMacroCount: activeRotation.activeMacroCount,
      activeRotation,

      debugFields: {
        longPositionExitChecks: [
          'currentPrice',
          'lastPrice',
          'entry',
          'sl',
          'initialSl',
          'tp',
          'ageSec',
          'currentR',
          'mfeR',
          'maeR',
          'reachedHalfR',
          'reachedOneR',
          'nearTpSeen',
          'tpHitNow',
          'slHitNow',
          'timeStopHitNow',
          'exitReadyNow',
          'exitReasonNow',
          'discordExitAlertEligible',
          'discordExitAlertSent',
          'realOrdersDisabled',
          'bitgetOrdersDisabled'
        ],
        longExitRules: {
          validRiskShape: 'entry > 0 && sl < entry && tp > entry',
          tp: 'currentPrice >= tp',
          sl: 'currentPrice <= sl',
          timeStop: `ageSec >= ${getPositionTimeStopMin() * 60}`,
          grossR: '(exitPrice - entry) / (entry - initialSl)',
          currentR: '(currentPrice - entry) / (entry - initialSl)',
          outcomeSource: 'VIRTUAL'
        },
        runMetaExitFields: [
          'virtualExits',
          'shadowExits',
          'virtualExitsCount',
          'shadowExitsCount',
          'actionCounts'
        ]
      },

      warnings: uniqueStrings([
        activeRotation.activeMicroCount <= 0
          ? 'NO_MANUAL_MICRO_FAMILY_SELECTION_ACTIVE_DISCORD_DISABLED'
          : null,
        ignoredShortPositions > 0
          ? `SHORT_POSITIONS_IGNORED:${ignoredShortPositions}`
          : null,
        unknownSidePositionsTreatedAsLong > 0
          ? `UNKNOWN_SIDE_POSITIONS_TREATED_AS_LONG:${unknownSidePositionsTreatedAsLong}`
          : null,
        runMeta?.ignoredShortActions > 0
          ? `SHORT_ACTIONS_IGNORED:${runMeta.ignoredShortActions}`
          : null,
        runMeta?.unknownSideActionsTreatedAsLong > 0
          ? `UNKNOWN_SIDE_ACTIONS_TREATED_AS_LONG:${runMeta.unknownSideActionsTreatedAsLong}`
          : null,
        runMeta?.ignoredShortExitRows > 0
          ? `SHORT_EXIT_ROWS_IGNORED:${runMeta.ignoredShortExitRows}`
          : null,
        runMeta?.unknownSideExitRowsTreatedAsLong > 0
          ? `UNKNOWN_SIDE_EXIT_ROWS_TREATED_AS_LONG:${runMeta.unknownSideExitRowsTreatedAsLong}`
          : null,
        stats.invalidLongRiskShapePositions > 0
          ? `INVALID_LONG_RISK_SHAPE_POSITIONS:${stats.invalidLongRiskShapePositions}`
          : null,
        stats.exitReadyNow > 0
          ? `LONG_POSITIONS_READY_TO_CLOSE_ON_NEXT_TRADE_RUN:${stats.exitReadyNow}`
          : null
      ].filter(Boolean)),

      serverTs: Date.now()
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,

      ...modeFlags(),

      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}