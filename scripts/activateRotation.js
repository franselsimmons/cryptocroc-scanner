// ================= FILE: scripts/activateRotation.js =================

import { activateSelectedMicroFamilies } from '../src/analyze/rotationEngine.js';

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

  if (typeof value === 'object') {
    return parseIdList(
      value.microFamilyIds ||
      value.activeMicroFamilyIds ||
      value.trueMicroFamilyIds ||
      value.ids ||
      value.microFamilyId ||
      value.trueMicroFamilyId ||
      value.id ||
      value.key ||
      []
    );
  }

  return uniqueStrings(
    String(value)
      .split(/[\s,;\n\r]+/g)
      .map((part) => part.trim())
      .filter(Boolean)
  );
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

function inferTradeSideFromId(id = '') {
  const text = cleanSideText(id);
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

function isLongMicroFamilyId(id = '') {
  if (isScannerFingerprintId(id)) return false;

  return inferTradeSideFromId(id) === TARGET_TRADE_SIDE;
}

function isAllowedLongOrUnknownMacroId(id = '') {
  if (isScannerFingerprintId(id)) return false;

  return inferTradeSideFromId(id) !== OPPOSITE_TRADE_SIDE;
}

function normalizeManualMicroFamilyIds(ids = []) {
  const requestedIds = uniqueStrings(ids);
  const acceptedMicroFamilyIds = [];
  const ignoredIds = [];

  for (const id of requestedIds) {
    const side = inferTradeSideFromId(id);

    if (isScannerFingerprintId(id)) {
      ignoredIds.push({
        id,
        side,
        reason: 'SCANNER_FINGERPRINT_METADATA_ONLY_NOT_SELECTABLE'
      });
      continue;
    }

    if (side === TARGET_TRADE_SIDE) {
      acceptedMicroFamilyIds.push(id);
      continue;
    }

    ignoredIds.push({
      id,
      side,
      reason: side === OPPOSITE_TRADE_SIDE
        ? 'SHORT_DISABLED_LONG_ONLY'
        : 'UNKNOWN_OR_NON_LONG_ID_REJECTED'
    });
  }

  return {
    requestedMicroFamilyIds: requestedIds,
    acceptedMicroFamilyIds: uniqueStrings(acceptedMicroFamilyIds),

    ignoredIds,
    ignoredShortIds: ignoredIds
      .filter((row) => row.reason === 'SHORT_DISABLED_LONG_ONLY')
      .map((row) => row.id),
    ignoredUnknownIds: ignoredIds
      .filter((row) => row.reason === 'UNKNOWN_OR_NON_LONG_ID_REJECTED')
      .map((row) => row.id),
    ignoredScannerFingerprintIds: ignoredIds
      .filter((row) => row.reason === 'SCANNER_FINGERPRINT_METADATA_ONLY_NOT_SELECTABLE')
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

    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,

    manualSelectionOnly: true,
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    exactTrueMicroFamilyRequired: true,
    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForExactTrueMicroMatch: true,

    autoRotation: false,
    autoRotationDisabled: true,
    activateNextDisabled: true,
    buildFreshDisabled: true,
    activateFreezeCronDisabled: true,
    resetCronDisabled: true,

    observationFirst: true,
    observationFirstAnalyze: true,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
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
    shortRootTouched: false
  };
}

function buildRequestedOptions() {
  const weekKey = getWeekKey();
  const requestedMicroFamilyIds = getRequestedMicroFamilyIds();
  const normalized = normalizeManualMicroFamilyIds(requestedMicroFamilyIds);
  const mode = getMode();

  return {
    argv: argv(),

    weekKey,
    sourceWeekKey: weekKey,

    activeWeekKey: String(
      firstValue(
        getArgValue('activeWeekKey'),
        getArgValue('nextWeekKey'),
        weekKey,
        PERSISTENT_LEARNING_KEY
      )
    ).trim(),

    mode,

    ...modeFlags(),

    manualOnly: true,
    adminSelected: true,
    discordOnly: true,

    requestedMicroFamilyIds: normalized.requestedMicroFamilyIds,

    microFamilyIds: normalized.acceptedMicroFamilyIds,
    activeMicroFamilyIds: normalized.acceptedMicroFamilyIds,
    trueMicroFamilyIds: normalized.acceptedMicroFamilyIds,

    acceptedMicroFamilyIds: normalized.acceptedMicroFamilyIds,

    ignoredIds: normalized.ignoredIds,
    ignoredShortIds: normalized.ignoredShortIds,
    ignoredUnknownIds: normalized.ignoredUnknownIds,
    ignoredScannerFingerprintIds: normalized.ignoredScannerFingerprintIds,

    disabledAutoFlagPresent: hasDisabledAutoFlag()
  };
}

function asRows(value) {
  return Array.isArray(value) ? value : [];
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
  ]).filter(isLongMicroFamilyId);
}

function extractMacroFamilyIds(rotation = {}) {
  const rows = asRows(rotation?.microFamilies);

  return uniqueStrings([
    rotation?.macroFamilyIds || [],
    rotation?.activeMacroFamilyIds || [],
    rotation?.macroIds || [],
    rows.map(macroId),
    rotation?.bestLong ? macroId(rotation.bestLong) : null,
    rotation?.selectedRow ? macroId(rotation.selectedRow) : null
  ]).filter(isAllowedLongOrUnknownMacroId);
}

function buildManualRow(id, index = 0) {
  return {
    rank: index + 1,

    microFamilyId: id,
    trueMicroFamilyId: id,
    coarseMicroFamilyId: id,

    familyId: null,
    macroFamilyId: null,
    parentMacroFamilyId: null,
    parentMicroFamilyId: null,

    ...modeFlags(),

    source: 'CLI_MANUAL_SELECTION_LONG_ONLY',
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

    definitionParts: [
      `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
      'CLI_MANUAL_SELECTION=true'
    ],
    definition: `TRADE_SIDE=${TARGET_TRADE_SIDE} | CLI_MANUAL_SELECTION=true`
  };
}

function forceLongRow(row = {}, index = 0) {
  const rowMicroId = microId(row);
  const rowMacroId = macroId(row);
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

    microFamilyId: rowMicroId,
    trueMicroFamilyId: row.trueMicroFamilyId || rowMicroId,
    coarseMicroFamilyId: row.coarseMicroFamilyId || rowMicroId,

    macroFamilyId: rowMacroId,
    parentMacroFamilyId: row.parentMacroFamilyId || rowMacroId || null,
    parentMicroFamilyId: row.parentMicroFamilyId || rowMacroId || null,

    ...modeFlags(),

    source: row.source || 'CLI_MANUAL_SELECTION_LONG_ONLY',
    selectedTier: row.selectedTier || row.rotationEligibilityTier || 'MANUAL',
    rotationEligibilityTier: row.rotationEligibilityTier || row.selectedTier || 'MANUAL',

    manualOnly: true,
    adminSelected: true,

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

    dashboardBalancedScore: Number(row.dashboardBalancedScore ?? row.balancedScore ?? row.learningQualityRank ?? 0),
    fairWinrate: Number(row.fairWinrate ?? row.sampleAdjustedWinrate ?? row.wilsonLowerBound ?? row.bayesianWinrate ?? 0),

    bestShort: null
  };
}

function forceLongRotation(rotation = {}, requested = {}) {
  const baseRotation = unwrapActiveRotation(rotation) || rotation || {};
  const requestedIds = requested.microFamilyIds || requested.acceptedMicroFamilyIds || [];

  const rowsById = new Map();

  for (const [index, row] of asRows(baseRotation.microFamilies).entries()) {
    const id = microId(row);

    if (!id || !isLongMicroFamilyId(id)) continue;

    rowsById.set(id, forceLongRow(row, index));
  }

  for (const [index, id] of requestedIds.entries()) {
    if (!id || rowsById.has(id)) continue;

    rowsById.set(id, buildManualRow(id, rowsById.size || index));
  }

  const rows = [...rowsById.values()]
    .map((row, index) => forceLongRow({
      ...row,
      rank: index + 1
    }, index));

  const microFamilyIds = uniqueStrings([
    baseRotation.microFamilyIds || [],
    baseRotation.activeMicroFamilyIds || [],
    baseRotation.trueMicroFamilyIds || [],
    requestedIds,
    rows.map(microId)
  ]).filter(isLongMicroFamilyId);

  const macroFamilyIds = uniqueStrings([
    baseRotation.macroFamilyIds || [],
    baseRotation.activeMacroFamilyIds || [],
    rows.map(macroId)
  ]).filter(isAllowedLongOrUnknownMacroId);

  const empty = microFamilyIds.length === 0;

  return {
    ...baseRotation,

    rotationId: baseRotation.rotationId || null,
    source: baseRotation.source || 'CLI_MANUAL_SELECTION_LONG_ONLY',
    mode: requested.mode || baseRotation.mode || 'selected',
    sideMode: 'long_only',

    sourceWeekKey: baseRotation.sourceWeekKey || requested.sourceWeekKey || requested.weekKey || PERSISTENT_LEARNING_KEY,
    activeWeekKey: baseRotation.activeWeekKey || requested.activeWeekKey || requested.weekKey || PERSISTENT_LEARNING_KEY,

    generatedAt: baseRotation.generatedAt || now(),
    activatedAt: baseRotation.activatedAt || now(),

    ...modeFlags(),

    trueMicroOnly: true,
    exactTrueMicroFamilyOnly: true,
    manualOnly: true,
    adminSelected: true,
    discordOnly: true,
    autoRotation: false,

    bestShort: null,
    preservedOppositeRow: null,

    microFamilyIds,
    activeMicroFamilyIds: microFamilyIds,
    trueMicroFamilyIds: microFamilyIds,

    macroFamilyIds,
    activeMacroFamilyIds: macroFamilyIds,

    microFamilies: rows,

    bestLong: rows[0] || null,
    selectedRow: rows[0] || null,
    selectedMicroFamilyId: rows[0]?.microFamilyId || null,
    selectedMacroFamilyId: rows[0]?.macroFamilyId || null,

    activeCount: microFamilyIds.length,
    count: microFamilyIds.length,
    microCount: microFamilyIds.length,
    trueMicroCount: microFamilyIds.length,
    macroCount: macroFamilyIds.length,

    empty,
    emptyReason: empty
      ? baseRotation.emptyReason || 'NO_MANUAL_LONG_TRUE_MICRO_FAMILY_IDS_ACTIVE'
      : null,

    missingSides: empty ? [TARGET_TRADE_SIDE] : []
  };
}

async function activateManualSelection(requested = {}) {
  if (requested.microFamilyIds.length <= 0) {
    return {
      ok: requested.requestedMicroFamilyIds.length === 0,
      skipped: true,
      changed: false,
      type: 'CLI_MANUAL_LONG_TRUE_MICRO_SELECTION_REQUIRED',

      reason: requested.requestedMicroFamilyIds.length > 0
        ? 'NO_VALID_LONG_TRUE_MICRO_FAMILY_IDS'
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
      ignoredIds: requested.ignoredIds,
      ignoredShortIds: requested.ignoredShortIds,
      ignoredUnknownIds: requested.ignoredUnknownIds,
      ignoredScannerFingerprintIds: requested.ignoredScannerFingerprintIds
    };
  }

  const engineResult = await activateSelectedMicroFamilies({
    microFamilyIds: requested.microFamilyIds,
    activeMicroFamilyIds: requested.microFamilyIds,
    trueMicroFamilyIds: requested.microFamilyIds,
    macroFamilyIds: [],

    weekKey: requested.weekKey,
    sourceWeekKey: requested.sourceWeekKey,
    activeWeekKey: requested.activeWeekKey,
    mode: requested.mode || 'selected',

    source: 'CLI_MANUAL_SELECTION_LONG_ONLY',

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

    manualOnly: true,
    adminSelected: true,
    discordOnly: true,
    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForExactTrueMicroMatch: true,

    exactTrueMicroFamilyOnly: true,
    trueMicroOnly: true,
    macroActivationExpansionDisabled: true,

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
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,

    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true
  });

  const activeRotation = forceLongRotation(engineResult, requested);

  return {
    ok: true,
    skipped: false,
    changed: true,
    type: 'CLI_MANUAL_LONG_TRUE_MICRO_FAMILY_DISCORD_SELECTION_ACTIVATED',

    source: 'CLI_MANUAL_SELECTION_LONG_ONLY',

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
    activatedMacroFamilies: activeRotation.macroFamilyIds?.length || 0,

    requestedMicroFamilyIds: requested.requestedMicroFamilyIds,
    acceptedMicroFamilyIds: requested.microFamilyIds,
    ignoredIds: requested.ignoredIds,
    ignoredShortIds: requested.ignoredShortIds,
    ignoredUnknownIds: requested.ignoredUnknownIds,
    ignoredScannerFingerprintIds: requested.ignoredScannerFingerprintIds,

    microFamilyIds: activeRotation.microFamilyIds || [],
    activeMicroFamilyIds: activeRotation.activeMicroFamilyIds || [],
    trueMicroFamilyIds: activeRotation.trueMicroFamilyIds || [],

    macroFamilyIds: activeRotation.macroFamilyIds || [],
    activeMacroFamilyIds: activeRotation.activeMacroFamilyIds || [],

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

function getActiveWeekKey(result, fallback = null) {
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
  const macroFamilyIds = extractMacroFamilyIds(normalizedActiveRotation || {});

  return {
    ok: result?.ok !== false,
    skipped: Boolean(result?.skipped),
    changed: Boolean(result?.changed),

    source: 'CLI_MANUAL_LONG_TRUE_MICRO_FAMILY_DISCORD_SELECTION',

    argv: argv(),
    requested,

    type: result?.type || null,

    weekKey: getResultWeekKey(result, requested.weekKey || null),
    sourceWeekKey: getSourceWeekKey(
      result,
      requested.sourceWeekKey || requested.weekKey || null
    ),
    activeWeekKey: getActiveWeekKey(
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
      result?.activatedCount ||
      microFamilyIds.length ||
      0,

    activatedMacroFamilies:
      result?.activatedMacroFamilies ||
      macroFamilyIds.length ||
      0,

    requestedMicroFamilyIds: requested.requestedMicroFamilyIds,
    acceptedMicroFamilyIds: requested.microFamilyIds,

    ignoredIds: requested.ignoredIds,
    ignoredShortIds: requested.ignoredShortIds,
    ignoredUnknownIds: requested.ignoredUnknownIds,
    ignoredScannerFingerprintIds: requested.ignoredScannerFingerprintIds,

    microFamilyIds,
    activeMicroFamilyIds: microFamilyIds,
    trueMicroFamilyIds: microFamilyIds,

    macroFamilyIds,
    activeMacroFamilyIds: macroFamilyIds,

    empty: Boolean(normalizedActiveRotation?.empty || microFamilyIds.length === 0),
    emptyReason: normalizedActiveRotation?.emptyReason || result?.reason || null,
    reason: result?.reason || null,

    trueMicroOnly: true,
    exactTrueMicroFamilyOnly: true,
    macroActivationExpansionDisabled: true,

    usedLegacyFallback: false,
    usedSoftFallback: Boolean(normalizedActiveRotation?.usedSoftFallback),
    usedObservationFallback: Boolean(normalizedActiveRotation?.usedObservationFallback),
    usedRawFallback: Boolean(normalizedActiveRotation?.usedRawFallback),

    selectedTier: normalizedActiveRotation?.selectedTier || result?.selectedTier || null,
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

    source: 'CLI_MANUAL_LONG_TRUE_MICRO_FAMILY_DISCORD_SELECTION',

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