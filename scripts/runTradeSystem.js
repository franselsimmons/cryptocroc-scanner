// ================= FILE: scripts/runTradeSystem.js =================

import { CONFIG } from '../src/config.js';
import { runTradeSystem } from '../src/trade/tradeSystem.js';

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

function hasFlag(flag) {
  const name = String(flag || '').replace(/^--/, '');

  return (
    process.argv.includes(name) ||
    process.argv.includes(`--${name}`)
  );
}

function getArgValue(name) {
  const normalizedName = String(name || '').replace(/^--/, '');
  const prefix = `--${normalizedName}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));

  if (!match) return null;

  return match.slice(prefix.length).trim() || null;
}

function isTrue(value) {
  if (value === true || value === 1) return true;

  const raw = String(value ?? '').trim().toLowerCase();

  return ['true', '1', 'yes', 'y', 'on', 'force', 'forced'].includes(raw);
}

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }

  return null;
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);

  return Number.isFinite(n) ? n : fallback;
}

function getPositionTimeStopMin() {
  const value = Number(CONFIG.trade?.positionTimeStopMin);

  if (!Number.isFinite(value) || value <= 0) return DEFAULT_POSITION_TIME_STOP_MIN;

  return Math.floor(value);
}

function baseFlags() {
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

    source: 'VIRTUAL',
    sourceMode: 'VIRTUAL',
    outcomeSource: 'VIRTUAL',
    virtualOnly: true,
    virtualTracked: true,
    virtualLearningForced: true,
    shadowOnly: true,

    realOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    noExchangeOrders: true,
    noRealOrders: true,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    learningOnly: true,
    microFamilyLearning: true,
    allowLearningWithoutActiveRotation: true,
    ignoreMaxOpenPositionsForLearning: true,
    globalMaxOpenPositionsBlockDisabled: true,
    ignoreRiskCapsForLearning: true,
    oneOpenPositionPerSymbol: true,
    maxOneOpenPositionPerSymbol: true,

    manualSelectionOnly: true,
    autoSelectionDisabled: true,
    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForManualSelection: true,
    discordOnlyForExactTrueMicroMatch: true,
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',

    observationFirst: true,
    observationFirstAnalyze: true,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsHiddenFromLearning: true,
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

    bucketGranularity: 'LOW_MID_HIGH',
    bucketsCoarseOnly: true,

    positionTimeStopMin: getPositionTimeStopMin(),
    positionTimeStopMinDefault: DEFAULT_POSITION_TIME_STOP_MIN,

    validLongRiskShape: 'entry > 0 && sl < entry && tp > entry',
    longGrossRFormula: '(exitPrice - entry) / (entry - initialSl)',
    longCurrentRFormula: '(currentPrice - entry) / (entry - initialSl)',
    longExitPriority: ['TP', 'SL', 'TIME_STOP'],

    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    redisKeysSeparatedFromShortRoot: true,
    shortRootTouched: false,

    resetCronDisabled: true,
    activateFreezeCronDisabled: true
  };
}

function shouldForceProcessSnapshot() {
  return (
    hasFlag('force') ||
    hasFlag('forced') ||
    hasFlag('forceProcessSnapshot') ||
    hasFlag('force-process-snapshot') ||
    isTrue(getArgValue('force')) ||
    isTrue(getArgValue('forced')) ||
    isTrue(getArgValue('forceProcessSnapshot')) ||
    isTrue(getArgValue('force-process-snapshot'))
  );
}

function shouldMonitorOnly() {
  return (
    hasFlag('monitorOnly') ||
    hasFlag('monitor-only') ||
    isTrue(getArgValue('monitorOnly')) ||
    isTrue(getArgValue('monitor-only'))
  );
}

function shouldManualRun() {
  return (
    hasFlag('manual') ||
    shouldForceProcessSnapshot() ||
    isTrue(getArgValue('manual'))
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

function asArray(value) {
  if (Array.isArray(value)) return value;

  if (value && typeof value === 'object') {
    return Object.values(value);
  }

  return [];
}

function upper(value, fallback = '') {
  const text = String(value || '').trim();

  return text ? text.toUpperCase() : fallback;
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

function normalizeTradeSide(side) {
  const raw = cleanSideText(side);

  if (['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'UPSIDE'].includes(raw)) {
    return TARGET_TRADE_SIDE;
  }

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE'].includes(raw)) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
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
    text.includes('DOWNSIDE')
  );
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
    text.includes('UPSIDE')
  );
}

function inferSideFromText(value = '') {
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
    if (text.includes('TRADE_SIDE=LONG') || text.includes('TRADESIDE=LONG')) return TARGET_TRADE_SIDE;
    if (text.includes('TRADE_SIDE=SHORT') || text.includes('TRADESIDE=SHORT')) return OPPOSITE_TRADE_SIDE;

    return TARGET_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function getDefinitionHaystack(row = {}) {
  return [
    row.familyId,
    row.family,
    row.baseFamilyId,

    row.microFamilyId,
    row.trueMicroFamilyId,
    row.activeMicroFamilyId,
    row.coarseMicroFamilyId,
    row.baseMicroFamilyId,
    row.legacyMicroFamilyId,
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
    row.waitReason,
    row.signalReason,
    row.actionReason,
    row.exitReason,
    row.rejectionReason,

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

function getSide(row = {}) {
  if (typeof row === 'string') {
    return inferSideFromText(row);
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

  const inferred = inferSideFromText(getDefinitionHaystack(row));

  if (inferred === TARGET_TRADE_SIDE || inferred === OPPOSITE_TRADE_SIDE) {
    return inferred;
  }

  if (row.longOnly === true || row.shortDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  if (row.shortOnly === true || row.longDisabled === true) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function isLongRow(row = {}) {
  return getSide(row) === TARGET_TRADE_SIDE;
}

function isShortRow(row = {}) {
  return getSide(row) === OPPOSITE_TRADE_SIDE;
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

function normalizeSymbolToken(value = '') {
  return String(value || '')
    .toUpperCase()
    .replace(/USDT|USDC|USD|PERP|SWAP|FUTURES|SPOT/g, '')
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function symbolTokensFromRow(row = {}) {
  return [
    row.symbol,
    row.baseSymbol,
    row.contractSymbol
  ]
    .map(normalizeSymbolToken)
    .filter(Boolean)
    .filter((token) => token.length >= 2);
}

function stripSymbolTokensFromFamilyId(id = '', row = {}) {
  const raw = String(id || '').trim();

  if (!raw) return raw;

  const tokens = symbolTokensFromRow(row);
  if (!tokens.length) return raw;

  let next = raw;

  for (const token of tokens) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    next = next
      .replace(new RegExp(`(^|[_|:=\\-])${escaped}([_|:=\\-]|$)`, 'gi'), '$1ASSET$2')
      .replace(new RegExp(`(^|[_|:=\\-])${escaped}USDT([_|:=\\-]|$)`, 'gi'), '$1ASSET$2')
      .replace(new RegExp(`(^|[_|:=\\-])${escaped}USDC([_|:=\\-]|$)`, 'gi'), '$1ASSET$2');
  }

  return next
    .replace(/_{2,}/g, '_')
    .replace(/\|{2,}/g, '|')
    .replace(/^[_|:=\-\s]+|[_|:=\-\s]+$/g, '') || raw;
}

function cleanLearningFamilyId(id = '', row = {}) {
  const raw = String(id || '').trim();

  if (!raw) return '';
  if (isScannerFingerprintId(raw)) return '';

  return stripSymbolTokensFromFamilyId(raw, row);
}

function getMicroFamilyId(row = {}) {
  return cleanLearningFamilyId(
    row?.trueMicroFamilyId ||
      row?.microFamilyId ||
      row?.activeMicroFamilyId ||
      row?.liveMicroFamilyId ||
      row?.realMicroFamilyId ||
      row?.executionMicroFamilyId ||
      row?.id ||
      '',
    row
  ) || null;
}

function getTrueMicroFamilyId(row = {}) {
  return cleanLearningFamilyId(
    row?.trueMicroFamilyId ||
      row?.microFamilyId ||
      row?.executionMicroFamilyId ||
      row?.id ||
      '',
    row
  ) || null;
}

function getCoarseMicroFamilyId(row = {}) {
  return cleanLearningFamilyId(
    row?.coarseMicroFamilyId ||
      row?.baseMicroFamilyId ||
      row?.legacyMicroFamilyId ||
      row?.trueMicroFamilyId ||
      row?.microFamilyId ||
      '',
    row
  ) || getTrueMicroFamilyId(row);
}

function getMacroFamilyId(row = {}) {
  return (
    row?.parentMacroFamilyId ||
    row?.activeMacroFamilyId ||
    row?.macroFamilyId ||
    row?.parentMicroFamilyId ||
    row?.parentFamilyId ||
    row?.familyMacroId ||
    row?.macroId ||
    row?.familyId ||
    null
  );
}

function getFamilyId(row = {}) {
  return row?.familyId || row?.family || row?.baseFamilyId || null;
}

function getSymbol(row = {}) {
  return (
    row?.symbol ||
    row?.baseSymbol ||
    row?.contractSymbol ||
    row?.instId ||
    row?.instrumentId ||
    null
  );
}

function forceLongRow(row = {}) {
  const trueMicroFamilyId = getTrueMicroFamilyId(row);
  const microFamilyId = trueMicroFamilyId || getMicroFamilyId(row);
  const coarseMicroFamilyId = getCoarseMicroFamilyId(row) || microFamilyId;

  return {
    ...row,

    ...baseFlags(),

    microFamilyId,
    trueMicroFamilyId: microFamilyId,
    coarseMicroFamilyId,

    inferredTradeSide: TARGET_TRADE_SIDE,

    source: row.source || 'VIRTUAL',
    sourceMode: 'VIRTUAL',
    outcomeSource: row.outcomeSource || row.source || 'VIRTUAL',
    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: row.shadowOnly !== false,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false
  };
}

function onlyLongRows(rows = []) {
  return asArray(rows)
    .filter(isLongRow)
    .map(forceLongRow);
}

function actionType(row = {}) {
  return upper(row?.action || row?.type || 'UNKNOWN', 'UNKNOWN');
}

function isEntryAction(row = {}) {
  const type = actionType(row);

  return (
    type === 'ENTRY' ||
    type === 'VIRTUAL_ENTRY' ||
    type === 'SHADOW_ENTRY' ||
    type === 'OPEN' ||
    type === 'VIRTUAL_OPEN'
  );
}

function isWaitAction(row = {}) {
  return actionType(row) === 'WAIT';
}

function waitReason(row = {}) {
  return upper(row?.reason || row?.waitReason || 'UNKNOWN', 'UNKNOWN');
}

function exitReason(row = {}) {
  return upper(row?.exitReason || row?.reason || row?.type || 'UNKNOWN', 'UNKNOWN');
}

function netR(row = {}) {
  const value = Number(
    row.netR ??
    row.r ??
    row.finalNetR ??
    row.outcomeNetR ??
    row.resultNetR ??
    row.rNet ??
    0
  );

  return Number.isFinite(value) ? value : 0;
}

function grossR(row = {}) {
  const value = Number(
    row.grossR ??
    row.finalGrossR ??
    row.outcomeGrossR ??
    row.resultGrossR ??
    row.rGross ??
    row.netR ??
    row.r ??
    0
  );

  return Number.isFinite(value) ? value : 0;
}

function costR(row = {}) {
  const explicit = Number(
    row.costR ??
    row.totalCostR ??
    row.feeCostR ??
    row.executionCostR
  );

  if (Number.isFinite(explicit)) return explicit;

  return Math.max(0, grossR(row) - netR(row));
}

function countBy(rows = [], selector) {
  return rows.reduce((acc, row) => {
    const key = selector(row);

    if (!key) return acc;

    acc[key] = (acc[key] || 0) + 1;

    return acc;
  }, {});
}

function sum(rows = [], selector) {
  return rows.reduce((total, row) => {
    const value = Number(selector(row));

    return total + (Number.isFinite(value) ? value : 0);
  }, 0);
}

function avg(rows = [], selector) {
  if (!rows.length) return 0;

  return sum(rows, selector) / rows.length;
}

function round(value, decimals = 4) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  return Number(n.toFixed(decimals));
}

function unwrapRunResult(result = {}) {
  if (!result || typeof result !== 'object') return {};

  if (result.result?.result?.result) return result.result.result.result;
  if (result.result?.result) return result.result.result;
  if (result.result) return result.result;

  return result;
}

function extractActions(payload = {}) {
  return asArray(
    payload.actions ||
    payload.tradeActions ||
    payload.result?.actions ||
    []
  );
}

function extractVirtualExits(payload = {}) {
  return asArray([
    ...asArray(payload.virtualExits),
    ...asArray(payload.shadowExits),
    ...asArray(payload.exits),
    ...asArray(payload.closedPositions),
    ...asArray(payload.outcomes),
    ...asArray(payload.learningShadowExits),
    ...asArray(payload.result?.virtualExits),
    ...asArray(payload.result?.shadowExits),
    ...asArray(payload.result?.exits),
    ...asArray(payload.result?.closedPositions)
  ]);
}

function extractOpenPositions(payload = {}) {
  return asArray(
    payload.openPositions ||
    payload.positions ||
    payload.virtualPositions ||
    payload.result?.openPositions ||
    []
  );
}

function getActionCounts(actions = []) {
  return countBy(onlyLongRows(actions), actionType);
}

function summarizeEntries(actions = []) {
  const entries = onlyLongRows(actions).filter(isEntryAction);

  return {
    count: entries.length,

    symbols: uniqueStrings(entries.map(getSymbol)),
    microFamilyIds: uniqueStrings(entries.map(getMicroFamilyId)),
    trueMicroFamilyIds: uniqueStrings(entries.map(getTrueMicroFamilyId)),
    coarseMicroFamilyIds: uniqueStrings(entries.map(getCoarseMicroFamilyId)),
    macroFamilyIds: uniqueStrings(entries.map(getMacroFamilyId)),
    familyIds: uniqueStrings(entries.map(getFamilyId)),

    byMicroFamily: countBy(entries, getMicroFamilyId),
    byTrueMicroFamily: countBy(entries, getTrueMicroFamilyId),
    byCoarseMicroFamily: countBy(entries, getCoarseMicroFamilyId),
    byMacroFamily: countBy(entries, getMacroFamilyId),
    byFamily: countBy(entries, getFamilyId)
  };
}

function summarizeWaits(actions = []) {
  const waits = onlyLongRows(actions).filter(isWaitAction);

  return {
    count: waits.length,

    byReason: countBy(waits, waitReason),
    byMicroFamily: countBy(waits, getMicroFamilyId),
    byTrueMicroFamily: countBy(waits, getTrueMicroFamilyId),
    byCoarseMicroFamily: countBy(waits, getCoarseMicroFamilyId),
    byMacroFamily: countBy(waits, getMacroFamilyId),

    observationOnly: waits.filter((row) => Boolean(row.observationOnly)).length,
    riskInvalid: waits.filter((row) => Boolean(row.riskInvalid || row.invalidRisk)).length,
    symbolAlreadyOpen: waits.filter((row) => waitReason(row).includes('SYMBOL_ALREADY_OPEN')).length,
    nonSelectedSilent: waits.filter((row) => Boolean(row.nonSelectedSilent || row.discordAlertEligible === false)).length
  };
}

function normalizeExitRow(row = {}) {
  const normalized = forceLongRow(row);
  const nR = netR(row);

  return {
    ...normalized,

    action: 'VIRTUAL_EXIT',
    source: 'VIRTUAL',
    outcomeSource: 'VIRTUAL',

    grossR: grossR(row),
    costR: costR(row),
    netR: nR,
    realizedR: nR,

    win: nR > 0,
    loss: nR < 0,
    flat: nR === 0,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true
  };
}

function summarizeVirtualExits(payload = {}) {
  const rawExits = extractVirtualExits(payload);
  const exits = onlyLongRows(rawExits).map(normalizeExitRow);

  return {
    total: exits.length,

    virtual: exits.filter((row) => row.virtualOnly !== false).length,
    selectedForDiscord: exits.filter((row) => Boolean(row.discordAlertEligible || row.selectedForDiscord)).length,

    wins: exits.filter((row) => netR(row) > 0).length,
    losses: exits.filter((row) => netR(row) < 0).length,
    flats: exits.filter((row) => netR(row) === 0).length,

    totalGrossR: round(sum(exits, grossR), 4),
    totalCostR: round(sum(exits, costR), 4),
    totalNetR: round(sum(exits, netR), 4),

    avgGrossR: round(avg(exits, grossR), 4),
    avgCostR: round(avg(exits, costR), 4),
    avgNetR: round(avg(exits, netR), 4),

    byReason: countBy(exits, exitReason),
    byMicroFamily: countBy(exits, getMicroFamilyId),
    byTrueMicroFamily: countBy(exits, getTrueMicroFamilyId),
    byCoarseMicroFamily: countBy(exits, getCoarseMicroFamilyId),
    byMacroFamily: countBy(exits, getMacroFamilyId),

    tradeIds: uniqueStrings(exits.map((row) => row?.tradeId || row?.positionId || row?.id)),

    rows: exits
  };
}

function getPositionEntry(row = {}) {
  return safeNumber(row.entry ?? row.entryPrice ?? row.openPrice, 0);
}

function getPositionSl(row = {}) {
  return safeNumber(row.initialSl ?? row.sl ?? row.stopLoss, 0);
}

function getPositionTp(row = {}) {
  return safeNumber(row.tp ?? row.takeProfit, 0);
}

function getPositionCurrentPrice(row = {}) {
  return safeNumber(
    row.currentPrice ??
      row.lastPrice ??
      row.markPrice ??
      row.price,
    0
  );
}

function getPositionAgeSec(row = {}) {
  const explicit = Number(row.ageSec);

  if (Number.isFinite(explicit) && explicit >= 0) return explicit;

  const openedAt = Number(row.openedAt || row.createdAt || row.ts);

  if (!Number.isFinite(openedAt) || openedAt <= 0) return 0;

  return Math.max(0, Math.floor((now() - openedAt) / 1000));
}

function validLongRiskShape(row = {}) {
  const entry = getPositionEntry(row);
  const sl = getPositionSl(row);
  const tp = getPositionTp(row);

  return entry > 0 && sl > 0 && tp > 0 && sl < entry && tp > entry;
}

function calcLongCurrentR(row = {}) {
  const entry = getPositionEntry(row);
  const initialSl = getPositionSl(row);
  const currentPrice = getPositionCurrentPrice(row);
  const distance = entry - initialSl;

  if (!(entry > 0 && distance > 0 && currentPrice > 0)) return null;

  return (currentPrice - entry) / distance;
}

function buildExitFlags(row = {}) {
  const entry = getPositionEntry(row);
  const sl = getPositionSl(row);
  const tp = getPositionTp(row);
  const currentPrice = getPositionCurrentPrice(row);
  const ageSec = getPositionAgeSec(row);
  const timeStopSec = getPositionTimeStopMin() * 60;
  const riskValid = validLongRiskShape(row);

  const tpHitNow = riskValid && currentPrice >= tp;
  const slHitNow = riskValid && currentPrice <= sl;
  const timeStopHitNow = ageSec >= timeStopSec;

  let exitReasonNow = null;

  if (tpHitNow) {
    exitReasonNow = 'TP';
  } else if (slHitNow) {
    exitReasonNow = 'SL';
  } else if (timeStopHitNow) {
    exitReasonNow = 'TIME_STOP';
  }

  return {
    entry,
    sl,
    initialSl: sl,
    tp,
    currentPrice,
    lastPrice: safeNumber(row.lastPrice ?? currentPrice, currentPrice),
    ageSec,

    longRiskShapeValid: riskValid,

    currentR: row.currentR !== undefined && Number.isFinite(Number(row.currentR))
      ? Number(row.currentR)
      : calcLongCurrentR(row),

    mfeR: Number.isFinite(Number(row.mfeR)) ? Number(row.mfeR) : null,
    maeR: Number.isFinite(Number(row.maeR)) ? Number(row.maeR) : null,

    reachedHalfR: Boolean(row.reachedHalfR),
    reachedOneR: Boolean(row.reachedOneR),
    nearTpSeen: Boolean(row.nearTpSeen),

    tpHitNow,
    slHitNow,
    timeStopHitNow,

    tpExitArmed: tpHitNow,
    slExitArmed: slHitNow,
    timeStopExitArmed: timeStopHitNow,

    exitReadyNow: Boolean(exitReasonNow),
    exitReasonNow,

    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,

    formulas: {
      grossR: '(exitPrice - entry) / (entry - initialSl)',
      currentR: '(currentPrice - entry) / (entry - initialSl)'
    }
  };
}

function summarizeOpenPositions(payload = {}) {
  const positions = onlyLongRows(extractOpenPositions(payload));
  const debugRows = positions.map((row) => ({
    ...forceLongRow(row),
    ...buildExitFlags(row)
  }));

  return {
    count: positions.length,

    symbols: uniqueStrings(positions.map(getSymbol)),
    microFamilyIds: uniqueStrings(positions.map(getMicroFamilyId)),
    trueMicroFamilyIds: uniqueStrings(positions.map(getTrueMicroFamilyId)),
    coarseMicroFamilyIds: uniqueStrings(positions.map(getCoarseMicroFamilyId)),
    macroFamilyIds: uniqueStrings(positions.map(getMacroFamilyId)),

    byMicroFamily: countBy(positions, getMicroFamilyId),
    byTrueMicroFamily: countBy(positions, getTrueMicroFamilyId),
    byCoarseMicroFamily: countBy(positions, getCoarseMicroFamilyId),
    byMacroFamily: countBy(positions, getMacroFamilyId),

    selectedForDiscord: positions.filter((row) => Boolean(row.discordAlertEligible || row.selectedForDiscord)).length,
    virtualOnly: positions.filter((row) => row.virtualOnly !== false).length,

    invalidLongRiskShape: debugRows.filter((row) => !row.longRiskShapeValid).length,
    tpReady: debugRows.filter((row) => row.tpHitNow).length,
    slReady: debugRows.filter((row) => row.slHitNow).length,
    timeStopReady: debugRows.filter((row) => row.timeStopHitNow).length,
    exitReady: debugRows.filter((row) => row.exitReadyNow).length,

    debugRows
  };
}

function summarizeIgnoredSides(payload = {}, actions = []) {
  const allActions = asArray(actions);
  const allExits = extractVirtualExits(payload);
  const allPositions = extractOpenPositions(payload);

  return {
    shortActionsIgnored: allActions.filter(isShortRow).length,
    unknownSideActionsIgnored: allActions.filter((row) => getSide(row) === 'UNKNOWN').length,

    shortExitsIgnored: allExits.filter(isShortRow).length,
    unknownSideExitsIgnored: allExits.filter((row) => getSide(row) === 'UNKNOWN').length,

    shortPositionsIgnored: allPositions.filter(isShortRow).length,
    unknownSidePositionsIgnored: allPositions.filter((row) => getSide(row) === 'UNKNOWN').length
  };
}

function buildRequestedOptions() {
  const forceProcessSnapshot = shouldForceProcessSnapshot();
  const monitorOnly = shouldMonitorOnly();

  return {
    force: forceProcessSnapshot,
    forceProcessSnapshot,
    monitorOnly,

    snapshotId: firstValue(
      getArgValue('snapshotId'),
      getArgValue('snapshot')
    ) || undefined,

    runSource: shouldManualRun()
      ? 'CLI_MANUAL_TRADE_RUN_LONG_ONLY'
      : 'CLI_TRADE_RUN_LONG_ONLY',

    ...baseFlags()
  };
}

function buildRunOptions(requested = {}) {
  return {
    force: Boolean(requested.force),
    forceProcessSnapshot: Boolean(requested.forceProcessSnapshot),
    monitorOnly: Boolean(requested.monitorOnly),

    monitorOpenPositionsFirst: true,
    monitorOpenPositions: true,
    processScannerSnapshot: !requested.monitorOnly,

    snapshotId: requested.snapshotId,

    targetTradeSide: TARGET_TRADE_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    side: TARGET_DASHBOARD_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
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

    source: 'VIRTUAL',
    sourceMode: 'VIRTUAL',
    outcomeSource: 'VIRTUAL',
    virtualOnly: true,
    virtualTracked: true,
    virtualLearningForced: true,
    shadowOnly: true,

    realOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    noExchangeOrders: true,
    noRealOrders: true,

    learningOnly: true,
    microFamilyLearning: true,
    allowLearningWithoutActiveRotation: true,
    ignoreMaxOpenPositionsForLearning: true,
    ignoreGlobalMaxOpenPositions: true,
    globalMaxOpenPositionsBlockDisabled: true,
    ignoreRiskCapsForLearning: true,
    oneOpenPositionPerSymbol: true,
    maxOneOpenPositionPerSymbol: true,

    manualSelectionOnly: true,
    autoSelectionDisabled: true,
    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForManualSelection: true,
    discordOnlyForExactTrueMicroMatch: true,
    exactTrueMicroFamilyRequired: true,

    observationFirst: true,
    observationFirstAnalyze: true,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsHiddenFromLearning: true,
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

    bucketGranularity: 'LOW_MID_HIGH',
    bucketsCoarseOnly: true,

    positionTimeStopMin: getPositionTimeStopMin(),

    longRiskShape: {
      entryGtZero: true,
      slBelowEntry: true,
      tpAboveEntry: true
    },

    longExitRules: {
      tp: 'currentPrice >= tp',
      sl: 'currentPrice <= sl',
      timeStop: 'ageSec >= CONFIG.trade.positionTimeStopMin * 60',
      priority: ['TP', 'SL', 'TIME_STOP']
    }
  };
}

function sanitizePayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return payload;

  const rawActions = extractActions(payload);
  const rawExits = extractVirtualExits(payload);
  const rawPositions = extractOpenPositions(payload);

  const actions = onlyLongRows(rawActions);
  const exits = onlyLongRows(rawExits).map(normalizeExitRow);
  const openPositions = onlyLongRows(rawPositions).map((row) => ({
    ...forceLongRow(row),
    ...buildExitFlags(row)
  }));

  const entryRowsList = actions.filter(isEntryAction);
  const waitRowsList = actions.filter(isWaitAction);

  const actionCounts = countBy([
    ...actions,
    ...exits
  ], actionType);

  return {
    ...payload,

    ...baseFlags(),

    actions,
    actionCounts,
    actionsCount: actions.length,

    virtualActions: actions,
    virtualActionsCount: actions.length,

    entryRows: Array.isArray(payload.entryRows)
      ? entryRowsList.length
      : safeNumber(payload.entryRows ?? payload.entries ?? entryRowsList.length, entryRowsList.length),

    waitRows: Array.isArray(payload.waitRows)
      ? waitRowsList.length
      : safeNumber(payload.waitRows ?? payload.waits ?? waitRowsList.length, waitRowsList.length),

    virtualCreatedRows: Array.isArray(payload.virtualCreatedRows)
      ? onlyLongRows(payload.virtualCreatedRows).length
      : safeNumber(
        payload.virtualCreatedRows ??
          payload.shadowCreatedRows ??
          payload.entries ??
          entryRowsList.length,
        entryRowsList.length
      ),

    entryRowsList,
    waitRowsList,
    virtualCreatedRowsList: entryRowsList,

    virtualExits: exits,
    exits,
    realExits: [],
    shadowExits: exits,
    virtualExitsCount: exits.length,
    virtualExitRows: exits.length,
    exitsCount: exits.length,
    realExitsCount: 0,
    realExitRows: 0,
    shadowExitsCount: exits.length,
    shadowExitRows: exits.length,

    openPositions,
    positions: openPositions,
    virtualPositions: openPositions,
    openPositionsCount: openPositions.length,

    shortActionsBlockedOrIgnored: rawActions.filter(isShortRow).length,
    unknownSideActionsIgnored: rawActions.filter((row) => getSide(row) === 'UNKNOWN').length,

    shortExitsBlockedOrIgnored: rawExits.filter(isShortRow).length,
    unknownSideExitsIgnored: rawExits.filter((row) => getSide(row) === 'UNKNOWN').length,

    shortPositionsBlockedOrIgnored: rawPositions.filter(isShortRow).length,
    unknownSidePositionsIgnored: rawPositions.filter((row) => getSide(row) === 'UNKNOWN').length,

    realTradesOnly: false,
    virtualLearningOnly: true,
    shadowDataMode: 'VIRTUAL_LEARNING_OUTCOMES_COUNTED',

    scannerFingerprintsUsedAsLearningFamily: 0
  };
}

function buildCliResponse({
  result,
  requested,
  runOptions,
  startedAt
}) {
  const rawPayload = unwrapRunResult(result);
  const payload = sanitizePayload(rawPayload);

  const actions = extractActions(payload);
  const actionCounts = getActionCounts(actions);
  const entries = summarizeEntries(actions);
  const waits = summarizeWaits(actions);
  const exits = summarizeVirtualExits(payload);
  const positions = summarizeOpenPositions(payload);
  const ignoredSides = summarizeIgnoredSides(rawPayload, extractActions(rawPayload));

  return {
    ok: payload?.ok !== false,
    skipped: Boolean(payload?.skipped || payload?.skippedNewEntries),
    reason: payload?.reason || null,
    skipReason: payload?.skipReason || payload?.reason || null,

    source: 'CLI_RUN_TRADE_SYSTEM_LONG_ONLY',
    runSource: requested.runSource,

    argv: argv(),
    requested,
    runOptions,

    ...baseFlags(),

    force: Boolean(requested.force),
    forceProcessSnapshot: Boolean(requested.forceProcessSnapshot),
    monitorOnly: Boolean(requested.monitorOnly),
    monitorOpenPositionsFirst: true,
    monitorOpenPositions: true,
    processScannerSnapshot: !requested.monitorOnly,

    runId: payload?.runId || null,

    snapshotId: payload?.snapshotId || null,
    snapshotCreatedAt: payload?.snapshotCreatedAt || null,
    snapshotAgeSec: payload?.snapshotAgeSec ?? null,

    skippedNewEntries: Boolean(payload?.skippedNewEntries),

    candidates: payload?.candidates ?? payload?.candidatesCount ?? null,
    longCandidateCount:
      payload?.longCandidateCount ??
      payload?.targetCandidateCount ??
      payload?.longCandidatesCount ??
      null,

    nonLongCandidateCount:
      payload?.nonLongCandidateCount ??
      payload?.nonTargetCandidateCount ??
      payload?.selectedOppositeCandidateCount ??
      null,

    selectedTargetCandidateCount: payload?.selectedTargetCandidateCount ?? null,
    selectedOppositeCandidateCount: 0,

    processed: payload?.processed ?? null,
    earlyActions: payload?.earlyActions ?? null,

    observationsWritten: payload?.observationsWritten ?? payload?.analyzedRows ?? null,
    analyzedRows: payload?.analyzedRows ?? null,
    analyzedRiskValidRows: payload?.analyzedRiskValidRows ?? null,

    liveRows: payload?.liveRows ?? null,
    actualLiveRows: payload?.actualLiveRows ?? null,
    analyzeInputRows: payload?.analyzeInputRows ?? null,
    observationOnlyRows: payload?.observationOnlyRows ?? null,
    learningOnlyRows: payload?.learningOnlyRows ?? null,
    riskValidRows: payload?.riskValidRows ?? payload?.analyzedRiskValidRows ?? null,
    riskInvalidRows: payload?.riskInvalidRows ?? null,

    entryRows: safeNumber(payload?.entryRows, entries.count),
    waitRows: safeNumber(payload?.waitRows, waits.count),
    virtualCreatedRows: safeNumber(payload?.virtualCreatedRows, entries.count),

    entryRowsList: Array.isArray(payload?.entryRowsList) ? payload.entryRowsList : [],
    waitRowsList: Array.isArray(payload?.waitRowsList) ? payload.waitRowsList : [],
    virtualCreatedRowsList: Array.isArray(payload?.virtualCreatedRowsList) ? payload.virtualCreatedRowsList : [],

    virtualPositionsOpened:
      payload?.virtualPositionsOpened ??
      payload?.virtualOpenedRows ??
      payload?.shadowCreatedRows ??
      entries.count,

    virtualPositionsSkipped:
      payload?.virtualPositionsSkipped ??
      payload?.virtualSkippedRows ??
      payload?.shadowSkippedRows ??
      null,

    virtualPositionsFailed:
      payload?.virtualPositionsFailed ??
      payload?.virtualFailedRows ??
      payload?.shadowFailedRows ??
      null,

    virtualExits: Array.isArray(payload?.virtualExits) ? payload.virtualExits : [],
    shadowExits: Array.isArray(payload?.shadowExits) ? payload.shadowExits : [],
    realExits: [],

    virtualExitRows: safeNumber(payload?.virtualExitRows, exits.total),
    shadowExitRows: safeNumber(payload?.shadowExitRows, exits.total),
    realExitRows: 0,

    activeRotationId: payload?.activeRotationId || null,
    activeMicroFamilies: payload?.activeMicroFamilies ?? null,
    activeMacroFamilies: payload?.activeMacroFamilies ?? null,
    activeMicroFamilyIds: Array.isArray(payload?.activeMicroFamilyIds)
      ? payload.activeMicroFamilyIds
      : [],

    trueMicroOnly: payload?.trueMicroOnly ?? true,
    manualSelectionOnly: payload?.manualSelectionOnly ?? true,
    autoSelectionDisabled: true,

    discordEligibleEntries: payload?.discordEligibleEntries ?? null,
    discordSkippedNotSelected: payload?.discordSkippedNotSelected ?? null,

    actions: actions.length,
    actionCounts,

    entries,
    waits,
    exits,
    positions,

    closeDebug: {
      positionTimeStopMin: getPositionTimeStopMin(),
      rules: {
        tp: 'currentPrice >= tp',
        sl: 'currentPrice <= sl',
        timeStop: 'ageSec >= CONFIG.trade.positionTimeStopMin * 60',
        priority: ['TP', 'SL', 'TIME_STOP']
      },
      validLongRiskShape: 'entry > 0 && sl < entry && tp > entry',
      grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
      currentRFormula: '(currentPrice - entry) / (entry - initialSl)',
      openPositionDebugRows: positions.debugRows
    },

    ignoredSides,

    scannerSnapshotStats: payload?.scannerSnapshotStats || null,

    durationMs: now() - startedAt,

    result: payload
  };
}

function buildCliError({
  error,
  requested,
  runOptions,
  startedAt
}) {
  return {
    ok: false,

    source: 'CLI_RUN_TRADE_SYSTEM_LONG_ONLY',

    argv: argv(),
    requested,
    runOptions,

    ...baseFlags(),

    force: Boolean(requested.force),
    forceProcessSnapshot: Boolean(requested.forceProcessSnapshot),
    monitorOnly: Boolean(requested.monitorOnly),
    monitorOpenPositionsFirst: true,
    monitorOpenPositions: true,

    error: error?.message || String(error),
    stack: error?.stack,

    durationMs: now() - startedAt
  };
}

async function main() {
  const startedAt = now();
  const requested = buildRequestedOptions();
  const runOptions = buildRunOptions(requested);

  try {
    const result = await runTradeSystem(runOptions);

    const response = buildCliResponse({
      result,
      requested,
      runOptions,
      startedAt
    });

    console.log(JSON.stringify(response, null, 2));

    process.exitCode = response.ok ? 0 : 1;
  } catch (error) {
    console.error(JSON.stringify(
      buildCliError({
        error,
        requested,
        runOptions,
        startedAt
      }),
      null,
      2
    ));

    process.exitCode = 1;
  }
}

await main();