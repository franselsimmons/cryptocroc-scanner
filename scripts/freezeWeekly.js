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
const OPPOSITE_TRADE_SIDE = 'SHORT';

const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';

const MIN_COMPLETED_ACTIVE_LEARNING = 20;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;

function now() {
  return Date.now();
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

function idLooksLikeLong(id = '') {
  const value = cleanSideText(id);

  if (!value) return false;

  return (
    value.includes('MICRO_LONG_') ||
    value.includes('TRADESIDE=LONG') ||
    value.includes('TRADE_SIDE=LONG') ||
    value.includes('POSITION_SIDE=LONG') ||
    value.includes('POSITIONSIDE=LONG') ||
    value.includes('SIDE=LONG') ||
    value.includes('SIDE=BULL') ||
    value.includes('DIRECTION=LONG') ||
    value.includes('DIRECTION=BULL') ||
    value.includes('SIDE=BUY') ||
    value.includes('DIRECTION=BUY') ||
    value.startsWith('LONG_') ||
    value.includes('_LONG_') ||
    value.endsWith('_LONG') ||
    value.startsWith('BULL_') ||
    value.includes('_BULL_') ||
    value.endsWith('_BULL') ||
    value.startsWith('BUY_') ||
    value.includes('_BUY_') ||
    value.endsWith('_BUY') ||
    value.includes('|LONG|') ||
    value.includes('|BULL|') ||
    value.includes('|BUY|') ||
    value.includes('=LONG') ||
    value.includes('=BULL') ||
    value.includes('=BUY')
  );
}

function idLooksLikeShort(id = '') {
  const value = cleanSideText(id);

  if (!value) return false;

  return (
    value.includes('MICRO_SHORT_') ||
    value.includes('TRADESIDE=SHORT') ||
    value.includes('TRADE_SIDE=SHORT') ||
    value.includes('POSITION_SIDE=SHORT') ||
    value.includes('POSITIONSIDE=SHORT') ||
    value.includes('SIDE=SHORT') ||
    value.includes('SIDE=BEAR') ||
    value.includes('DIRECTION=SHORT') ||
    value.includes('DIRECTION=BEAR') ||
    value.includes('SIDE=SELL') ||
    value.includes('DIRECTION=SELL') ||
    value.startsWith('SHORT_') ||
    value.includes('_SHORT_') ||
    value.endsWith('_SHORT') ||
    value.startsWith('BEAR_') ||
    value.includes('_BEAR_') ||
    value.endsWith('_BEAR') ||
    value.startsWith('SELL_') ||
    value.includes('_SELL_') ||
    value.endsWith('_SELL') ||
    value.includes('|SHORT|') ||
    value.includes('|BEAR|') ||
    value.includes('|SELL|') ||
    value.includes('=SHORT') ||
    value.includes('=BEAR') ||
    value.includes('=SELL')
  );
}

function inferTradeSideFromText(value = '') {
  const text = cleanSideText(value);
  const longHit = idLooksLikeLong(text);
  const shortHit = idLooksLikeShort(text);

  if (longHit && !shortHit) return TARGET_TRADE_SIDE;
  if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;

  if (longHit && shortHit) {
    if (text.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
    if (text.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
    if (text.includes('TRADE_SIDE=LONG') || text.includes('TRADESIDE=LONG')) return TARGET_TRADE_SIDE;
    if (text.includes('TRADE_SIDE=SHORT') || text.includes('TRADESIDE=SHORT')) return OPPOSITE_TRADE_SIDE;

    return TARGET_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function normalizeTradeSide(value) {
  const raw = cleanSideText(value);

  if (['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'UPSIDE'].includes(raw)) return TARGET_TRADE_SIDE;
  if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE'].includes(raw)) return OPPOSITE_TRADE_SIDE;

  return inferTradeSideFromText(raw);
}

function modeFlags() {
  return {
    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    scannerSide: TARGET_DASHBOARD_SIDE,
    actualScannerSide: TARGET_DASHBOARD_SIDE,
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

    freezeOnly: true,
    nextRotationOnly: true,
    activeRotationPreserved: true,
    manualSelectionPreserved: true,
    activeOverwriteDisabled: true,
    autoActivationDisabled: true,
    activateNextRotationDisabled: true,
    activateFreezeCronDisabled: true,
    resetCronDisabled: true,

    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,

    manualSelectionOnly: true,
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForExactTrueMicroMatch: true,

    observationFirst: true,
    observationFirstAnalyze: true,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    exactTrueMicroFamilyRequired: true,
    symbolExcludedFromFamilyId: true,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    statusRules: {
      OBSERVING: 'completed == 0',
      EARLY_OUTCOMES: `completed > 0 && completed < ${MIN_COMPLETED_ACTIVE_LEARNING}`,
      ACTIVE_LEARNING: `completed >= ${MIN_COMPLETED_ACTIVE_LEARNING}`
    },

    defaultRanking: 'dashboardBalancedScore|balancedScore|fairWinrate',
    bareWinrateRankingDisabled: true,

    globalMaxOpenPositionsBlockDisabled: true,
    maxOneOpenPositionPerSymbol: true,
    positionTimeStopMinDefault: DEFAULT_POSITION_TIME_STOP_MIN,

    validLongRiskShape: 'entry > 0 && sl < entry && tp > entry',
    longGrossRFormula: '(exitPrice - entry) / (entry - initialSl)',
    longCurrentRFormula: '(currentPrice - entry) / (entry - initialSl)',
    outcomeSource: 'VIRTUAL',

    bucketGranularity: 'LOW_MID_HIGH',
    bucketsCoarseOnly: true,

    persistentLearningKey: PERSISTENT_LEARNING_KEY,
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
    row?.liveMicroFamilyId ||
    row?.realMicroFamilyId ||
    row?.executionMicroFamilyId ||
    row?.id ||
    row?.key ||
    null
  );
}

function macroId(row = {}) {
  return (
    row?.parentMacroFamilyId ||
    row?.macroFamilyId ||
    row?.parentMicroFamilyId ||
    row?.parentFamilyId ||
    row?.macroId ||
    row?.legacyMicroFamilyId ||
    row?.coarseMicroFamilyId ||
    row?.familyMacroId ||
    row?.familyId ||
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

    row.microFamilyId,
    row.trueMicroFamilyId,
    row.liveMicroFamilyId,
    row.realMicroFamilyId,
    row.executionMicroFamilyId,
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

  if (haystackSide === TARGET_TRADE_SIDE || haystackSide === OPPOSITE_TRADE_SIDE) {
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

function isAllowedLongId(id = '') {
  if (isScannerFingerprintId(id)) return false;

  const side = inferTradeSideFromText(id);

  if (side === OPPOSITE_TRADE_SIDE) return false;
  if (side === TARGET_TRADE_SIDE) return true;

  return idLooksLikeLong(id);
}

function isAllowedLongOrUnknownId(id = '') {
  if (isScannerFingerprintId(id)) return false;

  return inferTradeSideFromText(id) !== OPPOSITE_TRADE_SIDE;
}

function isLongRow(row = {}) {
  return inferRowTradeSide(row) === TARGET_TRADE_SIDE;
}

function forceLongRow(row = {}, index = 0) {
  const trueMicroFamilyId = microId(row);
  const parentMacroFamilyId = macroId(row);
  const completed = Number(row.completed || row.outcomeSample || 0);
  const learningStatus = completed >= MIN_COMPLETED_ACTIVE_LEARNING
    ? 'ACTIVE_LEARNING'
    : completed > 0
      ? 'EARLY_OUTCOMES'
      : 'OBSERVING';

  return {
    ...row,

    rank: Number.isFinite(Number(row.rank))
      ? Number(row.rank)
      : index + 1,

    ...modeFlags(),

    microFamilyId: trueMicroFamilyId,
    trueMicroFamilyId,
    coarseMicroFamilyId: row.coarseMicroFamilyId || trueMicroFamilyId,

    macroFamilyId: parentMacroFamilyId || row.macroFamilyId || null,
    parentMacroFamilyId: row.parentMacroFamilyId || parentMacroFamilyId || null,
    parentMicroFamilyId: row.parentMicroFamilyId || parentMacroFamilyId || null,

    familyId: familyId(row),

    completed,
    outcomeSample: completed,

    learningStatus,
    status: learningStatus,
    tooEarly: completed < MIN_COMPLETED_ACTIVE_LEARNING,
    tooEarlyReason: completed < MIN_COMPLETED_ACTIVE_LEARNING
      ? `completed ${completed}/${MIN_COMPLETED_ACTIVE_LEARNING}`
      : null,

    avgR: Number(row.avgR ?? row.avgNetR ?? row.netAvgR ?? 0),
    totalR: Number(row.totalR ?? row.netTotalR ?? row.totalNetR ?? 0),
    avgCostR: Number(row.avgCostR ?? row.costR ?? row.totalCostR ?? 0),

    fairWinrate: Number(row.fairWinrate ?? row.sampleAdjustedWinrate ?? row.wilsonLowerBound ?? row.bayesianWinrate ?? 0),
    dashboardBalancedScore: Number(row.dashboardBalancedScore ?? row.balancedScore ?? row.learningQualityRank ?? 0),

    bestShort: null,
    preservedOppositeRow: null
  };
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

  const microFamilies = rawRows
    .filter(isLongRow)
    .map(forceLongRow)
    .filter((row) => isAllowedLongId(microId(row)));

  const microFamilyIds = uniqueStrings([
    rotation.microFamilyIds || [],
    rotation.activeMicroFamilyIds || [],
    rotation.trueMicroFamilyIds || [],
    rotation.ids || [],
    microFamilies.map(microId)
  ]).filter(isAllowedLongId);

  const macroFamilyIds = uniqueStrings([
    rotation.macroFamilyIds || [],
    rotation.activeMacroFamilyIds || [],
    rotation.macroIds || [],
    microFamilies.map(macroId)
  ]).filter(isAllowedLongOrUnknownId);

  const bestLongRaw =
    rotation.bestLong ||
    microFamilies.find((row) => isLongRow(row)) ||
    null;

  const bestLong = bestLongRaw
    ? forceLongRow(bestLongRaw, 0)
    : null;

  const empty = microFamilyIds.length === 0 && microFamilies.length === 0;

  return {
    ...rotation,

    source: rotation.source || 'CLI_WEEKLY_FREEZE_NEXT_ROTATION_LONG_ONLY',
    mode: rotation.mode || getMode(),
    sideMode: 'long_only',

    ...modeFlags(),

    trueMicroOnly: true,
    exactTrueMicroFamilyOnly: true,

    bestLong,
    bestShort: null,
    preservedOppositeRow: null,

    microFamilyIds,
    activeMicroFamilyIds: microFamilyIds,
    trueMicroFamilyIds: microFamilyIds,

    macroFamilyIds,
    activeMacroFamilyIds: macroFamilyIds,

    microFamilies,

    count: microFamilyIds.length || microFamilies.length,
    activeCount: microFamilyIds.length || microFamilies.length,
    microCount: rotation.microCount ?? microFamilyIds.length,
    macroCount: rotation.macroCount ?? macroFamilyIds.length,
    trueMicroCount: microFamilyIds.length,
    legacyMacroCount: 0,

    rawMicroFamiliesCount: rawRows.length,
    ignoredShortMicroFamilies: rawRows.filter((row) => inferRowTradeSide(row) === OPPOSITE_TRADE_SIDE).length,

    empty,
    emptyReason: empty
      ? rotation.emptyReason || 'NO_LONG_MICRO_FAMILIES_FOR_NEXT_ROTATION'
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
  ]).filter(isAllowedLongId);
}

function extractMacroFamilyIds(rotation = {}) {
  const sanitized = sanitizeRotation(rotation);

  if (!sanitized) return [];

  return uniqueStrings([
    sanitized.macroFamilyIds || [],
    sanitized.activeMacroFamilyIds || [],
    sanitized.macroIds || [],
    asRows(sanitized.microFamilies).map(macroId),
    sanitized.bestLong ? macroId(sanitized.bestLong) : null,
    sanitized.selectedRow ? macroId(sanitized.selectedRow) : null
  ]).filter(isAllowedLongOrUnknownId);
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

function getSelectedMacroCount(result = {}) {
  const rotation = sanitizeRotation(unwrapRotation(result) || {});
  const ids = extractMacroFamilyIds(rotation);

  return ids.length || 0;
}

function getMode() {
  return String(
    getArgValue('mode') ||
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

    scannerSide: TARGET_DASHBOARD_SIDE,
    actualScannerSide: TARGET_DASHBOARD_SIDE,
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
    exactTrueMicroFamilyOnly: true,
    macroActivationExpansionDisabled: true,

    virtualOnly: true,
    virtualLearning: true,
    virtualLearningForced: true,

    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,

    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,

    rankingSource: 'dashboardBalancedScore|balancedScore|fairWinrate',
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
      activeRotationRemovedBecauseFreezeCreatedIt: activeAfter !== null && activeAfter !== undefined,
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

    source: 'CLI_WEEKLY_FREEZE_NEXT_ONLY_ACTIVE_NOT_TOUCHED_LONG_ONLY',

    sourceWeekKey: requested.weekKey,
    activeWeekKey: requested.activeWeekKey,
    mode: requested.mode,

    rotationId: nextRotation.rotationId || null,

    ...modeFlags(),

    selectedMicroFamilies: nextRotation.microFamilyIds.length,
    selectedMacroFamilies: nextRotation.macroFamilyIds.length,

    bestLong: nextRotation.bestLong?.microFamilyId || null,
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
  const activeBefore = await getJson(redis, activeRotationKey(), null).catch(() => null);

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
    type: rawResult?.type || 'WEEKLY_FREEZE_NEXT_ROTATION_ONLY_LONG',

    ...modeFlags(),

    weekKey: requested.weekKey,
    sourceWeekKey: requested.sourceWeekKey,
    activeWeekKey: requested.activeWeekKey,
    mode: requested.mode,

    rotationId: nextRotation?.rotationId || rawResult?.rotationId || null,

    selectedMicroFamilies: nextRotation?.microFamilyIds?.length || 0,
    selectedMacroFamilies: nextRotation?.macroFamilyIds?.length || 0,

    microFamilyIds: nextRotation?.microFamilyIds || [],
    activeMicroFamilyIds: nextRotation?.microFamilyIds || [],
    trueMicroFamilyIds: nextRotation?.microFamilyIds || [],

    macroFamilyIds: nextRotation?.macroFamilyIds || [],
    activeMacroFamilyIds: nextRotation?.macroFamilyIds || [],

    empty: Boolean(nextRotation?.empty),
    emptyReason: nextRotation?.emptyReason || rawResult?.emptyReason || rawResult?.reason || null,

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
  const macroFamilyIds = extractMacroFamilyIds(rotation);

  return {
    ok: result?.ok !== false,

    source: 'CLI_FREEZE_WEEKLY_NEXT_ROTATION_LONG_ONLY',

    argv: argv(),
    requested,

    type: result?.type || 'WEEKLY_FREEZE_NEXT_ROTATION_ONLY_LONG',

    ...modeFlags(),

    weekKey: getResultWeekKey(result, requested.weekKey || null),
    sourceWeekKey: getResultWeekKey(result, requested.sourceWeekKey || null),
    activeWeekKey: getResultActiveWeekKey(result, requested.activeWeekKey || null),

    mode: result?.mode || rotation?.mode || requested.mode,

    rotationId: getResultRotationId(result),

    selectedMicroFamilies: getSelectedMicroCount(result),
    selectedMacroFamilies: getSelectedMacroCount(result),

    microFamilyIds,
    activeMicroFamilyIds: microFamilyIds,
    trueMicroFamilyIds: microFamilyIds,

    macroFamilyIds,
    activeMacroFamilyIds: macroFamilyIds,

    empty: Boolean(rotation?.empty || microFamilyIds.length === 0),
    emptyReason: rotation?.emptyReason || result?.emptyReason || result?.reason || null,

    eligibleCount: rotation?.eligibleCount ?? null,
    rankedCount: rotation?.rankedCount ?? null,
    allRankedCount: rotation?.allRankedCount ?? null,

    microCount: rotation?.microCount ?? microFamilyIds.length,
    macroCount: rotation?.macroCount ?? macroFamilyIds.length,
    trueMicroCount: rotation?.trueMicroCount ?? microFamilyIds.length,
    legacyMacroCount: 0,

    trueMicroOnly: true,
    exactTrueMicroFamilyOnly: true,
    usedLegacyFallback: false,
    usedSoftFallback: Boolean(rotation?.usedSoftFallback),
    usedObservationFallback: Boolean(rotation?.usedObservationFallback),
    usedRawFallback: Boolean(rotation?.usedRawFallback),

    selectedTier: rotation?.selectedTier || null,
    missingSides: Array.isArray(rotation?.missingSides)
      ? rotation.missingSides.filter((side) => normalizeTradeSide(side) === TARGET_TRADE_SIDE)
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

    source: 'CLI_FREEZE_WEEKLY_NEXT_ROTATION_LONG_ONLY',

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