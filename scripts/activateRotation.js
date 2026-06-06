// ================= FILE: scripts/activateRotation.js =================

import { CONFIG } from '../src/config.js';
import { KEYS } from '../src/keys.js';
import {
  getDurableRedis,
  setJson
} from '../src/redis.js';
import { getIsoWeekKey } from '../src/utils.js';
import {
  activateNextRotation,
  activateSelectedMicroFamilies,
  buildRotationFromWeek
} from '../src/analyze/rotationEngine.js';

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

function normalizeTradeSide(value) {
  const raw = upper(value);

  if (['LONG', 'BULL', 'BULLISH', 'BUY'].includes(raw)) return 'LONG';
  if (['SHORT', 'BEAR', 'BEARISH', 'SELL'].includes(raw)) return 'SHORT';

  return 'UNKNOWN';
}

function getArray(value) {
  return Array.isArray(value) ? value : [];
}

function getDefinitionHaystack(row = {}) {
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

  const haystack = getDefinitionHaystack(row);

  const longSignal = (
    haystack.includes('MICRO_LONG_') ||
    haystack.includes('TRADESIDE=LONG') ||
    haystack.includes('TRADE_SIDE=LONG') ||
    haystack.includes('SIDE=LONG') ||
    haystack.includes('SIDE=BULL') ||
    haystack.includes('DIRECTION=LONG') ||
    haystack.includes('DIRECTION=BULL') ||
    haystack.includes('SIDE=BUY') ||
    haystack.includes('DIRECTION=BUY') ||
    haystack.startsWith('LONG_') ||
    haystack.includes('_LONG_') ||
    haystack.endsWith('_LONG') ||
    haystack.startsWith('BULL_') ||
    haystack.includes('_BULL_') ||
    haystack.endsWith('_BULL') ||
    haystack.startsWith('BUY_') ||
    haystack.includes('_BUY_') ||
    haystack.endsWith('_BUY')
  );

  const shortSignal = (
    haystack.includes('MICRO_SHORT_') ||
    haystack.includes('TRADESIDE=SHORT') ||
    haystack.includes('TRADE_SIDE=SHORT') ||
    haystack.includes('SIDE=SHORT') ||
    haystack.includes('SIDE=BEAR') ||
    haystack.includes('DIRECTION=SHORT') ||
    haystack.includes('DIRECTION=BEAR') ||
    haystack.includes('SIDE=SELL') ||
    haystack.includes('DIRECTION=SELL') ||
    haystack.startsWith('SHORT_') ||
    haystack.includes('_SHORT_') ||
    haystack.endsWith('_SHORT') ||
    haystack.startsWith('BEAR_') ||
    haystack.includes('_BEAR_') ||
    haystack.endsWith('_BEAR') ||
    haystack.startsWith('SELL_') ||
    haystack.includes('_SELL_') ||
    haystack.endsWith('_SELL')
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

function filterTargetIds(ids = []) {
  return uniqueStrings(ids).filter((id) => inferTradeSide(id) === TARGET_TRADE_SIDE);
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
      value.id ||
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

function asRows(value) {
  return Array.isArray(value) ? value : [];
}

function unwrapActiveRotation(result = {}) {
  return (
    result?.activeRotation ||
    result?.active ||
    result?.rotation ||
    result?.result?.activeRotation ||
    result?.result?.active ||
    result?.result?.rotation ||
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

function normalizeTargetRow(row = {}, index = 0) {
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
    shortDisabled: true
  };
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

function parentMacroFamilyId(row = {}) {
  return String(
    row.parentMacroFamilyId ||
    row.parentMicroFamilyId ||
    row.macroFamilyId ||
    row.familyId ||
    ''
  ).trim();
}

function buildSelectionIndexes(microFamilies = []) {
  const targetRows = asRows(microFamilies)
    .filter(isTargetSideRow);

  const microFamilyIds = filterTargetIds(
    targetRows.map((row) => row.microFamilyId || row.trueMicroFamilyId || row.id)
  );

  const macroFamilyIds = uniqueStrings(
    targetRows.map(parentMacroFamilyId)
  ).filter((id) => inferTradeSide(id) === TARGET_TRADE_SIDE || upper(id).includes('LONG'));

  const microToMacroFamilyId = {};
  const macroToMicroFamilyIds = {};

  for (const row of targetRows) {
    const micro = String(row.microFamilyId || row.trueMicroFamilyId || row.id || '').trim();
    const macro = parentMacroFamilyId(row);

    if (!micro || !macro) continue;

    microToMacroFamilyId[micro] = macro;

    if (!macroToMicroFamilyIds[macro]) {
      macroToMicroFamilyIds[macro] = [];
    }

    macroToMicroFamilyIds[macro].push(micro);
  }

  for (const macro of Object.keys(macroToMicroFamilyIds)) {
    macroToMicroFamilyIds[macro] = uniqueStrings(macroToMicroFamilyIds[macro]);
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

function bestLong(rows = []) {
  return asRows(rows).find(isTargetSideRow) || null;
}

function sanitizeRotationForLongOnly(rotation = {}, source = null) {
  const originalRows = asRows(rotation?.microFamilies);

  const microFamilies = originalRows
    .filter(isTargetSideRow)
    .map(normalizeTargetRow)
    .filter(Boolean);

  const indexes = buildSelectionIndexes(microFamilies);
  const empty = microFamilies.length === 0;

  const selectedRow = rotation.selectedRow && isTargetSideRow(rotation.selectedRow)
    ? normalizeTargetRow(rotation.selectedRow, 0)
    : bestLong(microFamilies);

  return {
    ...rotation,

    source: source || rotation.source || null,

    targetTradeSide: TARGET_TRADE_SIDE,
    requestedTradeSide: TARGET_TRADE_SIDE,
    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,
    disableShort: true,

    shortOnly: false,
    longDisabled: false,

    trueMicroOnly: rotation.trueMicroOnly !== false,
    usedLegacyFallback: Boolean(rotation.usedLegacyFallback),
    usedSoftFallback: Boolean(rotation.usedSoftFallback),
    usedObservationFallback: Boolean(rotation.usedObservationFallback),

    bestLong: selectedRow || bestLong(microFamilies),
    bestShort: null,
    preservedOppositeRow: null,

    missingSides: empty ? [TARGET_TRADE_SIDE] : [],

    empty,
    emptyReason: empty
      ? rotation.emptyReason || 'NO_LONG_MICRO_FAMILIES_AVAILABLE_FOR_ROTATION'
      : null,

    ...indexes,

    selectedRow,
    selectedMicroFamilyId: selectedRow?.microFamilyId || null,
    selectedMacroFamilyId: selectedRow?.macroFamilyId || parentMacroFamilyId(selectedRow || {}) || null,

    microFamilies,

    rawMicroFamiliesCount: originalRows.length,
    ignoredShortMicroFamilies: originalRows.filter(isOppositeSideRow).length,
    ignoredUnknownSideMicroFamilies: originalRows.filter((row) => inferTradeSide(row) === 'UNKNOWN').length
  };
}

async function persistActiveLongRotation(redis, rotation = {}, source = null) {
  const activeRotation = sanitizeRotationForLongOnly(rotation, source);

  await setJson(
    redis,
    KEYS.analyze.activeRotation,
    activeRotation
  );

  return activeRotation;
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
    null
  );
}

function getSourceWeekKey(result, fallback = null) {
  const activeRotation = unwrapActiveRotation(result);

  return (
    result?.sourceWeekKey ||
    activeRotation?.sourceWeekKey ||
    fallback ||
    null
  );
}

function getActiveWeekKey(result, fallback = null) {
  const activeRotation = unwrapActiveRotation(result);

  return (
    result?.activeWeekKey ||
    activeRotation?.activeWeekKey ||
    fallback ||
    null
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

function getActiveWeekKeyArg(fallbackWeekKey) {
  return String(
    firstValue(
      getArgValue('activeWeekKey'),
      getArgValue('nextWeekKey'),
      fallbackWeekKey,
      getIsoWeekKey()
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

function shouldBuildFreshRotation(requested = {}) {
  if (requested.acceptedLongMicroFamilyIds.length > 0) return false;

  return (
    requested.force ||
    hasFlag('build') ||
    hasFlag('activateBest') ||
    hasFlag('buildFresh')
  );
}

function shouldAutoBuildIfMissing() {
  return (
    hasFlag('autoBuildIfMissing') ||
    hasFlag('auto-build-if-missing')
  );
}

function buildRequestedOptions() {
  const weekKey = getWeekKey();
  const requestedMicroFamilyIds = getRequestedMicroFamilyIds();
  const acceptedLongMicroFamilyIds = filterTargetIds(requestedMicroFamilyIds);

  return {
    force: hasFlag('force'),

    build: hasFlag('build') || hasFlag('buildFresh'),
    activateBest: hasFlag('activateBest'),
    autoBuildIfMissing: shouldAutoBuildIfMissing(),

    weekKey,
    sourceWeekKey: getArgValue('sourceWeekKey') || weekKey,
    activeWeekKey: getActiveWeekKeyArg(weekKey),

    mode: getMode(),

    targetTradeSide: TARGET_TRADE_SIDE,
    longOnly: true,
    shortDisabled: true,

    requestedMicroFamilyIds,
    acceptedLongMicroFamilyIds,
    ignoredShortOrUnknownMicroFamilyIds: uniqueStrings(requestedMicroFamilyIds)
      .filter((id) => !acceptedLongMicroFamilyIds.includes(id))
  };
}

function isMissingNextRotation(result = {}) {
  return (
    result?.ok === false &&
    String(result?.reason || '').toUpperCase() === 'NEXT_ROTATION_MISSING'
  );
}

async function buildFreshRotationAndActivate({
  weekKey,
  activeWeekKey,
  mode
}) {
  const redis = getDurableRedis();

  const builtRotationRaw = await buildRotationFromWeek({
    weekKey,
    activeWeekKey,
    mode,

    targetTradeSide: TARGET_TRADE_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    side: TARGET_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,
    disableShort: true
  });

  const builtRotation = sanitizeRotationForLongOnly(
    builtRotationRaw,
    'CLI_BUILD_ROTATION_LONG_ONLY'
  );

  await setJson(
    redis,
    KEYS.analyze.nextRotation,
    builtRotation
  );

  await setJson(
    redis,
    KEYS.analyze.rotationValidFrom,
    {
      validFrom: 'IMMEDIATE_CLI_ACTIVATION',
      ts: now(),
      sourceWeekKey: weekKey,
      activeWeekKey,
      rotationId: builtRotation.rotationId,
      mode,

      targetTradeSide: TARGET_TRADE_SIDE,
      longOnly: true,
      shortDisabled: true,

      selectedMicroFamilies: builtRotation.microFamilyIds?.length || 0,
      selectedMacroFamilies: builtRotation.macroFamilyIds?.length || 0,
      bestLong: builtRotation.bestLong?.microFamilyId || null,
      bestShort: null,
      missingSides: builtRotation.missingSides || []
    }
  );

  const activated = await activateNextRotation();

  const activeRotation = await persistActiveLongRotation(
    redis,
    activated?.activeRotation || builtRotation,
    'CLI_NEXT_ROTATION_ACTIVATED_LONG_ONLY'
  );

  return {
    ok: activated?.ok !== false,
    type: 'CLI_BUILT_AND_ACTIVATED_LONG_ROTATION',

    targetTradeSide: TARGET_TRADE_SIDE,
    longOnly: true,
    shortDisabled: true,

    weekKey,
    sourceWeekKey: weekKey,
    activeWeekKey,
    mode,

    rotationId:
      activeRotation.rotationId ||
      activated?.rotationId ||
      builtRotation.rotationId ||
      null,

    activatedCount: activeRotation.microFamilyIds?.length || 0,

    builtRotation,
    activeRotation,
    reason: activeRotation.emptyReason || activated?.reason || null,

    result: activated
  };
}

async function activateManualSelection({
  microFamilyIds,
  requestedMicroFamilyIds,
  weekKey,
  mode
}) {
  const redis = getDurableRedis();

  const activeRotationRaw = await activateSelectedMicroFamilies({
    microFamilyIds,
    weekKey,
    mode: mode || 'manual',

    targetTradeSide: TARGET_TRADE_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    side: TARGET_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,
    disableShort: true
  });

  const activeRotation = await persistActiveLongRotation(
    redis,
    activeRotationRaw,
    'CLI_MANUAL_SELECTION_LONG_ONLY'
  );

  const ignoredShortOrUnknownMicroFamilyIds = uniqueStrings(requestedMicroFamilyIds)
    .filter((id) => !microFamilyIds.includes(id));

  return {
    ok: true,
    type: 'CLI_MANUAL_LONG_MICRO_FAMILY_ROTATION_ACTIVATED',

    targetTradeSide: TARGET_TRADE_SIDE,
    longOnly: true,
    shortDisabled: true,

    weekKey,
    sourceWeekKey: weekKey,
    activeWeekKey: activeRotation.activeWeekKey || getIsoWeekKey(),
    mode: mode || 'manual',

    rotationId: activeRotation.rotationId || null,
    activatedCount: activeRotation.microFamilyIds?.length || 0,

    requestedMicroFamilyIds,
    acceptedLongMicroFamilyIds: microFamilyIds,
    ignoredShortOrUnknownMicroFamilyIds,

    activeRotation,
    reason: activeRotation.emptyReason || null
  };
}

async function activateExistingNextRotation({
  weekKey,
  activeWeekKey,
  mode,
  autoBuildIfMissing
}) {
  const redis = getDurableRedis();
  const activated = await activateNextRotation();

  if (
    isMissingNextRotation(activated) &&
    autoBuildIfMissing
  ) {
    return buildFreshRotationAndActivate({
      weekKey,
      activeWeekKey,
      mode
    });
  }

  const activeRotation = activated?.activeRotation
    ? await persistActiveLongRotation(
      redis,
      activated.activeRotation,
      'CLI_EXISTING_NEXT_ROTATION_ACTIVATED_LONG_ONLY'
    )
    : null;

  return {
    ok: activated?.ok !== false,
    type: 'CLI_NEXT_LONG_ROTATION_ACTIVATED',

    targetTradeSide: TARGET_TRADE_SIDE,
    longOnly: true,
    shortDisabled: true,

    weekKey,
    sourceWeekKey: activeRotation?.sourceWeekKey || null,
    activeWeekKey: activeRotation?.activeWeekKey || activeWeekKey,
    mode: activeRotation?.mode || mode,

    rotationId:
      activeRotation?.rotationId ||
      activated?.rotationId ||
      null,

    activatedCount:
      activeRotation?.microFamilyIds?.length ||
      0,

    activeRotation,
    reason: activeRotation?.emptyReason || activated?.reason || null,

    result: activated
  };
}

async function runActivation(requested = {}) {
  if (requested.requestedMicroFamilyIds.length > 0) {
    return activateManualSelection({
      microFamilyIds: requested.acceptedLongMicroFamilyIds,
      requestedMicroFamilyIds: requested.requestedMicroFamilyIds,
      weekKey: requested.weekKey,
      mode: requested.mode
    });
  }

  if (shouldBuildFreshRotation(requested)) {
    return buildFreshRotationAndActivate({
      weekKey: requested.sourceWeekKey || requested.weekKey,
      activeWeekKey: requested.activeWeekKey,
      mode: requested.mode
    });
  }

  return activateExistingNextRotation({
    weekKey: requested.sourceWeekKey || requested.weekKey,
    activeWeekKey: requested.activeWeekKey,
    mode: requested.mode,
    autoBuildIfMissing: requested.autoBuildIfMissing
  });
}

function getActivatedMicroCount(result = {}) {
  const activeRotation = unwrapActiveRotation(result);
  const ids = extractMicroFamilyIds(activeRotation);

  return (
    result?.activatedMicroFamilies ||
    result?.activatedCount ||
    ids.length ||
    0
  );
}

function getActivatedMacroCount(result = {}) {
  const activeRotation = unwrapActiveRotation(result);
  const ids = extractMacroFamilyIds(activeRotation);

  return ids.length || 0;
}

function buildCliResponse({
  result,
  requested,
  startedAt
}) {
  const activeRotation = unwrapActiveRotation(result);
  const microFamilyIds = extractMicroFamilyIds(activeRotation);
  const macroFamilyIds = extractMacroFamilyIds(activeRotation);

  return {
    ok: result?.ok !== false,

    source: 'CLI_ACTIVATE_LONG_ROTATION',

    argv: argv(),
    requested,

    type: result?.type || null,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    longOnly: true,
    shortDisabled: true,

    weekKey: getResultWeekKey(result, requested.weekKey || null),
    sourceWeekKey: getSourceWeekKey(
      result,
      requested.sourceWeekKey || requested.weekKey || null
    ),
    activeWeekKey: getActiveWeekKey(
      result,
      requested.activeWeekKey || null
    ),

    mode: result?.mode || activeRotation?.mode || requested.mode,

    rotationId: getResultRotationId(result),

    activatedMicroFamilies: getActivatedMicroCount(result),
    activatedMacroFamilies: getActivatedMacroCount(result),

    microFamilyIds,
    macroFamilyIds,

    empty: Boolean(activeRotation?.empty),
    emptyReason: activeRotation?.emptyReason || result?.reason || null,
    reason: result?.reason || null,

    trueMicroOnly: activeRotation?.trueMicroOnly !== false,
    usedLegacyFallback: Boolean(activeRotation?.usedLegacyFallback),
    usedSoftFallback: Boolean(activeRotation?.usedSoftFallback),
    usedObservationFallback: Boolean(activeRotation?.usedObservationFallback),

    selectedTier: activeRotation?.selectedTier || result?.selectedTier || null,
    missingSides: Array.isArray(activeRotation?.missingSides)
      ? activeRotation.missingSides
      : [],

    bestLong: activeRotation?.bestLong || null,
    bestShort: null,

    ignoredShortMicroFamilies: activeRotation?.ignoredShortMicroFamilies || 0,
    ignoredUnknownSideMicroFamilies: activeRotation?.ignoredUnknownSideMicroFamilies || 0,

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

    source: 'CLI_ACTIVATE_LONG_ROTATION',

    argv: argv(),
    requested,

    targetTradeSide: TARGET_TRADE_SIDE,
    longOnly: true,
    shortDisabled: true,

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