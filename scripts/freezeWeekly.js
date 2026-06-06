// ================= FILE: scripts/freezeWeekly.js =================

import { CONFIG } from '../src/config.js';
import {
  getIsoWeekKey,
  getNextIsoWeekKey
} from '../src/utils.js';
import { freezeWeeklyRotation } from '../src/analyze/rotationEngine.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

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
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function asRows(value) {
  return Array.isArray(value) ? value : [];
}

function getArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeTradeSide(value) {
  const raw = upper(value);

  if (['LONG', 'BULL', 'BULLISH', 'BUY'].includes(raw)) return 'LONG';
  if (['SHORT', 'BEAR', 'BEARISH', 'SELL'].includes(raw)) return 'SHORT';

  return 'UNKNOWN';
}

function collectSideText(row = {}) {
  if (typeof row === 'string') return upper(row);

  return [
    row.tradeSide,
    row.side,
    row.positionSide,
    row.direction,
    row.signalSide,
    row.scannerSide,
    row.analysisSide,
    row.entrySide,
    row.bias,
    row.marketBias,

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

    ...getArray(row.definitionParts),
    ...getArray(row.microDefinitionParts),
    ...getArray(row.macroDefinitionParts),
    ...getArray(row.parentDefinitionParts)
  ]
    .map(upper)
    .filter(Boolean)
    .join('|');
}

function inferTradeSide(row = {}) {
  if (typeof row !== 'string') {
    const direct = normalizeTradeSide(
      row.tradeSide ||
      row.side ||
      row.positionSide ||
      row.direction ||
      row.signalSide ||
      row.scannerSide ||
      row.analysisSide ||
      row.entrySide ||
      row.bias ||
      row.marketBias
    );

    if (direct === 'LONG' || direct === 'SHORT') return direct;
  }

  const text = collectSideText(row);

  const longSignal = (
    text.includes('MICRO_LONG_') ||
    text.includes('TRADESIDE=LONG') ||
    text.includes('TRADE_SIDE=LONG') ||
    text.includes('SIDE=LONG') ||
    text.includes('SIDE=BULL') ||
    text.includes('DIRECTION=LONG') ||
    text.includes('DIRECTION=BULL') ||
    text.includes('SIDE=BUY') ||
    text.includes('DIRECTION=BUY') ||
    text.startsWith('LONG_') ||
    text.includes('_LONG_') ||
    text.endsWith('_LONG') ||
    text.startsWith('BULL_') ||
    text.includes('_BULL_') ||
    text.endsWith('_BULL') ||
    text.startsWith('BUY_') ||
    text.includes('_BUY_') ||
    text.endsWith('_BUY')
  );

  const shortSignal = (
    text.includes('MICRO_SHORT_') ||
    text.includes('TRADESIDE=SHORT') ||
    text.includes('TRADE_SIDE=SHORT') ||
    text.includes('SIDE=SHORT') ||
    text.includes('SIDE=BEAR') ||
    text.includes('DIRECTION=SHORT') ||
    text.includes('DIRECTION=BEAR') ||
    text.includes('SIDE=SELL') ||
    text.includes('DIRECTION=SELL') ||
    text.startsWith('SHORT_') ||
    text.includes('_SHORT_') ||
    text.endsWith('_SHORT') ||
    text.startsWith('BEAR_') ||
    text.includes('_BEAR_') ||
    text.endsWith('_BEAR') ||
    text.startsWith('SELL_') ||
    text.includes('_SELL_') ||
    text.endsWith('_SELL')
  );

  if (longSignal && !shortSignal) return 'LONG';
  if (shortSignal && !longSignal) return 'SHORT';

  if (longSignal) return 'LONG';
  if (shortSignal) return 'SHORT';

  return 'UNKNOWN';
}

function isTargetSideRow(row = {}) {
  return inferTradeSide(row) === TARGET_TRADE_SIDE;
}

function isOppositeSideRow(row = {}) {
  return inferTradeSide(row) === OPPOSITE_TRADE_SIDE;
}

function unwrapRotation(result = {}) {
  return (
    result?.rotation ||
    result?.nextRotation ||
    result?.activeRotation ||
    result?.active ||
    result?.result?.rotation ||
    result?.result?.nextRotation ||
    result?.result?.activeRotation ||
    null
  );
}

function microId(row = {}) {
  return (
    row?.microFamilyId ||
    row?.trueMicroFamilyId ||
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
    row?.legacyMicroFamilyId ||
    row?.coarseMicroFamilyId ||
    row?.familyMacroId ||
    row?.familyId ||
    null
  );
}

function filterTargetIds(ids = []) {
  return uniqueStrings(ids).filter((id) => inferTradeSide(id) === TARGET_TRADE_SIDE);
}

function extractMicroFamilyIds(rotation = {}) {
  const rows = asRows(rotation?.microFamilies)
    .filter(isTargetSideRow);

  return filterTargetIds([
    rotation?.microFamilyIds || [],
    rotation?.activeMicroFamilyIds || [],
    rotation?.trueMicroFamilyIds || [],
    rotation?.ids || [],
    rows.map(microId),
    rotation?.bestLong ? microId(rotation.bestLong) : null,
    rotation?.selectedRow ? microId(rotation.selectedRow) : null
  ]);
}

function extractMacroFamilyIds(rotation = {}) {
  const rows = asRows(rotation?.microFamilies)
    .filter(isTargetSideRow);

  return uniqueStrings([
    rotation?.macroFamilyIds || [],
    rotation?.activeMacroFamilyIds || [],
    rotation?.macroIds || [],
    rows.map(macroId),
    rotation?.bestLong ? macroId(rotation.bestLong) : null,
    rotation?.selectedRow ? macroId(rotation.selectedRow) : null
  ]).filter((id) => inferTradeSide(id) === TARGET_TRADE_SIDE || upper(id).includes('LONG'));
}

function normalizeLongRow(row = {}, index = 0) {
  const id = microId(row);

  if (!id) return null;
  if (!isTargetSideRow({ ...row, microFamilyId: id })) return null;

  return {
    ...row,

    rank: row.rank || index + 1,

    microFamilyId: id,
    trueMicroFamilyId: id,
    macroFamilyId: macroId(row),

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    targetTradeSide: TARGET_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,

    shortOnly: false,
    longDisabled: false
  };
}

function sanitizeRotationForLongOnly(rotation = {}) {
  if (!rotation || typeof rotation !== 'object') return null;

  const rawRows = asRows(rotation.microFamilies);

  const microFamilies = rawRows
    .map(normalizeLongRow)
    .filter(Boolean);

  const microFamilyIds = extractMicroFamilyIds({
    ...rotation,
    microFamilies
  });

  const macroFamilyIds = extractMacroFamilyIds({
    ...rotation,
    microFamilies
  });

  const selectedRow =
    normalizeLongRow(rotation.selectedRow || {}, 0) ||
    normalizeLongRow(rotation.bestLong || {}, 0) ||
    microFamilies[0] ||
    null;

  const empty = microFamilies.length === 0 && microFamilyIds.length === 0;

  return {
    ...rotation,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,
    disableShort: true,

    shortOnly: false,
    longDisabled: false,

    trueMicroOnly: rotation.trueMicroOnly !== false,

    microFamilyIds,
    activeMicroFamilyIds: microFamilyIds,
    trueMicroFamilyIds: microFamilyIds,

    macroFamilyIds,
    activeMacroFamilyIds: macroFamilyIds,

    microFamilies,

    bestLong: selectedRow,
    bestShort: null,
    selectedRow,

    selectedMicroFamilyId: selectedRow?.microFamilyId || null,
    selectedMacroFamilyId: selectedRow?.macroFamilyId || null,

    empty,
    emptyReason: empty
      ? rotation.emptyReason || 'NO_LONG_MICRO_FAMILIES_AVAILABLE_FOR_ROTATION'
      : rotation.emptyReason || null,

    missingSides: empty ? [TARGET_TRADE_SIDE] : [],

    rawMicroFamiliesCount: rawRows.length,
    ignoredShortMicroFamilies: rawRows.filter(isOppositeSideRow).length,
    ignoredUnknownSideMicroFamilies: rawRows.filter((row) => inferTradeSide(row) === 'UNKNOWN').length
  };
}

function getResultWeekKey(result, fallback = null) {
  const rotation = unwrapRotation(result);

  return (
    result?.weekKey ||
    result?.sourceWeekKey ||
    rotation?.sourceWeekKey ||
    fallback ||
    null
  );
}

function getResultActiveWeekKey(result, fallback = null) {
  const rotation = unwrapRotation(result);

  return (
    result?.activeWeekKey ||
    rotation?.activeWeekKey ||
    fallback ||
    null
  );
}

function getResultRotationId(result = {}) {
  const rotation = unwrapRotation(result);

  return (
    result?.rotationId ||
    rotation?.rotationId ||
    null
  );
}

function getSelectedMicroCount(result = {}) {
  const rotation = sanitizeRotationForLongOnly(unwrapRotation(result));
  const ids = extractMicroFamilyIds(rotation);

  return (
    result?.selectedMicroFamilies ||
    result?.selectedCount ||
    ids.length ||
    0
  );
}

function getSelectedMacroCount(result = {}) {
  const rotation = sanitizeRotationForLongOnly(unwrapRotation(result));
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
      getIsoWeekKey()
    )
  ).trim();
}

function getActiveWeekKey() {
  return String(
    firstValue(
      getArgValue('activeWeekKey'),
      getArgValue('nextWeekKey'),
      getNextIsoWeekKey()
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

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    longOnly: true,
    shortDisabled: true
  };
}

function buildFreezeOptions(requested = {}) {
  return {
    weekKey: requested.weekKey,
    activeWeekKey: requested.activeWeekKey,
    mode: requested.mode,

    targetTradeSide: TARGET_TRADE_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    side: TARGET_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,
    disableShort: true,

    shortOnly: false,
    longDisabled: false
  };
}

function normalizeResult(result = {}) {
  const rotation = sanitizeRotationForLongOnly(unwrapRotation(result));

  if (!rotation) {
    return {
      ...result,
      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      longOnly: true,
      shortDisabled: true,
      bestLong: null,
      bestShort: null
    };
  }

  return {
    ...result,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    longOnly: true,
    shortDisabled: true,

    shortOnly: false,
    longDisabled: false,

    rotation,
    nextRotation: result.nextRotation ? rotation : result.nextRotation,

    rotationId: result.rotationId || rotation.rotationId || null,

    selectedMicroFamilies: rotation.microFamilyIds.length,
    selectedMacroFamilies: rotation.macroFamilyIds.length,

    microFamilyIds: rotation.microFamilyIds,
    macroFamilyIds: rotation.macroFamilyIds,

    bestLong: rotation.bestLong,
    bestShort: null,

    empty: rotation.empty,
    emptyReason: rotation.emptyReason
  };
}

function buildCliResponse({
  result,
  requested,
  startedAt
}) {
  const normalizedResult = normalizeResult(result);
  const rotation = sanitizeRotationForLongOnly(unwrapRotation(normalizedResult));
  const microFamilyIds = extractMicroFamilyIds(rotation);
  const macroFamilyIds = extractMacroFamilyIds(rotation);

  return {
    ok: normalizedResult?.ok !== false,

    source: 'CLI_FREEZE_WEEKLY_LONG_ROTATION',

    argv: argv(),
    requested,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    longOnly: true,
    shortDisabled: true,

    weekKey: getResultWeekKey(normalizedResult, requested.weekKey || null),
    sourceWeekKey: getResultWeekKey(normalizedResult, requested.sourceWeekKey || null),
    activeWeekKey: getResultActiveWeekKey(normalizedResult, requested.activeWeekKey || null),

    mode: normalizedResult?.mode || rotation?.mode || requested.mode,

    rotationId: getResultRotationId(normalizedResult),

    selectedMicroFamilies: getSelectedMicroCount(normalizedResult),
    selectedMacroFamilies: getSelectedMacroCount(normalizedResult),

    microFamilyIds,
    macroFamilyIds,

    empty: Boolean(rotation?.empty),
    emptyReason: rotation?.emptyReason || normalizedResult?.emptyReason || normalizedResult?.reason || null,

    eligibleCount: rotation?.eligibleCount ?? null,
    rankedCount: rotation?.rankedCount ?? null,
    allRankedCount: rotation?.allRankedCount ?? null,

    microCount: rotation?.microCount ?? microFamilyIds.length,
    macroCount: rotation?.macroCount ?? macroFamilyIds.length,

    trueMicroOnly: rotation?.trueMicroOnly !== false,
    usedLegacyFallback: Boolean(rotation?.usedLegacyFallback),
    usedSoftFallback: Boolean(rotation?.usedSoftFallback),
    usedObservationFallback: Boolean(rotation?.usedObservationFallback),

    selectedTier: rotation?.selectedTier || null,
    missingSides: Array.isArray(rotation?.missingSides)
      ? rotation.missingSides
      : [],

    bestLong: rotation?.bestLong || null,
    bestShort: null,

    ignoredShortMicroFamilies: rotation?.ignoredShortMicroFamilies || 0,
    ignoredUnknownSideMicroFamilies: rotation?.ignoredUnknownSideMicroFamilies || 0,

    durationMs: now() - startedAt,

    result: normalizedResult
  };
}

function buildCliError({
  error,
  requested,
  startedAt
}) {
  return {
    ok: false,

    source: 'CLI_FREEZE_WEEKLY_LONG_ROTATION',

    argv: argv(),
    requested,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    longOnly: true,
    shortDisabled: true,

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
    const result = await freezeWeeklyRotation(
      buildFreezeOptions(requested)
    );

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