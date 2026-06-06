// ================= FILE: scripts/runTradeSystem.js =================

import { runTradeSystem } from '../src/trade/tradeSystem.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

const VALID_TRADE_SIDES = new Set(['LONG', 'SHORT']);

function now() {
  return Date.now();
}

function argv() {
  return process.argv.slice(2);
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function getArgValue(name) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));

  if (!match) return null;

  return match.slice(prefix.length).trim() || null;
}

function shouldForceProcessSnapshot() {
  return (
    hasFlag('--force') ||
    hasFlag('--forceProcessSnapshot') ||
    hasFlag('--force-process-snapshot')
  );
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .flatMap((value) => Array.isArray(value) ? value : [value])
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

function getArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeTradeSide(side) {
  const raw = upper(side, 'UNKNOWN');

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
    row.activeMicroFamilyId,
    row.liveMicroFamilyId,
    row.realMicroFamilyId,
    row.executionMicroFamilyId,
    row.id,
    row.key,

    row.activeMacroFamilyId,
    row.macroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId,
    row.parentFamilyId,
    row.legacyMicroFamilyId,
    row.coarseMicroFamilyId,
    row.familyMacroId,
    row.macroId,

    row.reason,
    row.waitReason,
    row.exitReason,
    row.scannerReason,
    row.signalReason,
    row.actionReason,

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

function inferSideFromText(value) {
  const text = upper(value);

  if (!text) return 'UNKNOWN';

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
    text.includes('UPSIDE') ||
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
    text.includes('DOWNSIDE') ||
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

function getSide(row = {}) {
  if (typeof row === 'string') {
    return inferSideFromText(row);
  }

  const direct = normalizeTradeSide(
    row?.tradeSide ||
    row?.side ||
    row?.positionSide ||
    row?.direction ||
    row?.scannerSide ||
    row?.analysisSide ||
    row?.signalSide ||
    row?.entrySide
  );

  if (VALID_TRADE_SIDES.has(direct)) return direct;

  return inferSideFromText(collectSideText(row));
}

function isTargetRow(row = {}) {
  return getSide(row) === TARGET_TRADE_SIDE;
}

function isOppositeRow(row = {}) {
  return getSide(row) === OPPOSITE_TRADE_SIDE;
}

function actionType(row = {}) {
  return upper(row?.action || row?.type || 'UNKNOWN', 'UNKNOWN');
}

function waitReason(row = {}) {
  return upper(row?.reason || row?.waitReason || 'UNKNOWN', 'UNKNOWN');
}

function getMicroFamilyId(row = {}) {
  return (
    row?.microFamilyId ||
    row?.trueMicroFamilyId ||
    row?.activeMicroFamilyId ||
    row?.liveMicroFamilyId ||
    row?.realMicroFamilyId ||
    row?.executionMicroFamilyId ||
    row?.id ||
    null
  );
}

function getMacroFamilyId(row = {}) {
  return (
    row?.activeMacroFamilyId ||
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

function getFamilyId(row = {}) {
  return row?.familyId || row?.family || null;
}

function getSymbol(row = {}) {
  return (
    row?.symbol ||
    row?.baseSymbol ||
    row?.contractSymbol ||
    null
  );
}

function countBy(rows = [], selector) {
  return rows.reduce((acc, row) => {
    const key = selector(row);

    if (!key) return acc;

    acc[key] = (acc[key] || 0) + 1;

    return acc;
  }, {});
}

function unwrapRunResult(result = {}) {
  return result?.result || result || {};
}

function extractActions(result = {}) {
  const payload = unwrapRunResult(result);

  return asArray(
    payload.actions ||
    payload.tradeActions ||
    result.actions ||
    []
  );
}

function extractRealExits(result = {}) {
  const payload = unwrapRunResult(result);

  return asArray(
    payload.realExits ||
    result.realExits ||
    []
  );
}

function extractShadowExits(result = {}) {
  const payload = unwrapRunResult(result);

  return asArray(
    payload.shadowExits ||
    result.shadowExits ||
    []
  );
}

function splitByTargetSide(rows = []) {
  const sourceRows = asArray(rows);

  const targetRows = [];
  const oppositeRows = [];
  const unknownRows = [];

  for (const row of sourceRows) {
    const side = getSide(row);

    if (side === TARGET_TRADE_SIDE) {
      targetRows.push(row);
      continue;
    }

    if (side === OPPOSITE_TRADE_SIDE) {
      oppositeRows.push(row);
      continue;
    }

    unknownRows.push(row);
  }

  return {
    targetRows,
    oppositeRows,
    unknownRows
  };
}

function forceLongRow(row = {}) {
  return {
    ...row,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    targetTradeSide: TARGET_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,

    shortOnly: false,
    longDisabled: false
  };
}

function targetRows(rows = []) {
  return splitByTargetSide(rows)
    .targetRows
    .map(forceLongRow);
}

function getActionCounts(result = {}, actions = []) {
  const payload = unwrapRunResult(result);

  if (payload.actionCounts && typeof payload.actionCounts === 'object') {
    return payload.actionCounts;
  }

  return countBy(actions, actionType);
}

function summarizeEntries(actions = []) {
  const entries = actions.filter((row) => actionType(row) === 'ENTRY');

  return {
    count: entries.length,

    symbols: uniqueStrings(entries.map(getSymbol)),
    microFamilyIds: uniqueStrings(entries.map(getMicroFamilyId)),
    macroFamilyIds: uniqueStrings(entries.map(getMacroFamilyId)),
    familyIds: uniqueStrings(entries.map(getFamilyId)),

    bySide: countBy(entries, getSide),
    byMicroFamily: countBy(entries, getMicroFamilyId),
    byMacroFamily: countBy(entries, getMacroFamilyId),
    byFamily: countBy(entries, getFamilyId)
  };
}

function summarizeWaits(actions = []) {
  const waits = actions.filter((row) => actionType(row) === 'WAIT');

  return {
    count: waits.length,

    byReason: countBy(waits, waitReason),
    bySide: countBy(waits, getSide),
    byMicroFamily: countBy(waits, getMicroFamilyId),
    byMacroFamily: countBy(waits, getMacroFamilyId),

    shadowOnly: waits.filter((row) => Boolean(row.shadowOnly)).length,
    liveEligibleFalse: waits.filter((row) => row.liveEligible === false).length
  };
}

function summarizeExits(result = {}) {
  const realExitsRaw = extractRealExits(result);
  const shadowExitsRaw = extractShadowExits(result);

  const realSplit = splitByTargetSide(realExitsRaw);
  const shadowSplit = splitByTargetSide(shadowExitsRaw);

  const realExits = realSplit.targetRows.map(forceLongRow);
  const shadowExits = shadowSplit.targetRows.map(forceLongRow);
  const allExits = [...realExits, ...shadowExits];

  return {
    total: allExits.length,

    real: realExits.length,
    shadow: shadowExits.length,

    rawReal: realExitsRaw.length,
    rawShadow: shadowExitsRaw.length,

    ignoredShortReal: realSplit.oppositeRows.length,
    ignoredShortShadow: shadowSplit.oppositeRows.length,
    ignoredUnknownReal: realSplit.unknownRows.length,
    ignoredUnknownShadow: shadowSplit.unknownRows.length,

    byReason: countBy(
      allExits,
      (row) => upper(row?.exitReason || row?.reason || 'UNKNOWN', 'UNKNOWN')
    ),

    bySide: countBy(allExits, getSide),
    byMicroFamily: countBy(allExits, getMicroFamilyId),
    byMacroFamily: countBy(allExits, getMacroFamilyId),

    realIds: uniqueStrings(realExits.map((row) => row?.tradeId || row?.id)),
    shadowIds: uniqueStrings(shadowExits.map((row) => (
      row?.tradeId ||
      row?.id ||
      row?.shadowId
    )))
  };
}

function normalizePayloadForLongOnly(payload = {}) {
  if (!payload || typeof payload !== 'object') return payload;

  const rawActions = extractActions(payload);
  const actionSplit = splitByTargetSide(rawActions);
  const actions = actionSplit.targetRows.map(forceLongRow);

  const realExitsRaw = extractRealExits(payload);
  const shadowExitsRaw = extractShadowExits(payload);

  const realExitSplit = splitByTargetSide(realExitsRaw);
  const shadowExitSplit = splitByTargetSide(shadowExitsRaw);

  const realExits = realExitSplit.targetRows.map(forceLongRow);
  const shadowExits = shadowExitSplit.targetRows.map(forceLongRow);

  return {
    ...payload,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    longOnly: true,
    shortDisabled: true,

    shortOnly: false,
    longDisabled: false,

    actions,
    tradeActions: actions,
    actionsCount: actions.length,
    actionCounts: countBy(actions, actionType),

    rawActionsCount: rawActions.length,
    ignoredShortActions: actionSplit.oppositeRows.length,
    ignoredUnknownSideActions: actionSplit.unknownRows.length,

    realExits,
    shadowExits,
    realExitsCount: realExits.length,
    shadowExitsCount: shadowExits.length,

    rawRealExitsCount: realExitsRaw.length,
    rawShadowExitsCount: shadowExitsRaw.length,

    ignoredShortRealExits: realExitSplit.oppositeRows.length,
    ignoredShortShadowExits: shadowExitSplit.oppositeRows.length,
    ignoredUnknownRealExits: realExitSplit.unknownRows.length,
    ignoredUnknownShadowExits: shadowExitSplit.unknownRows.length
  };
}

function buildRequestedOptions() {
  return {
    forceProcessSnapshot: shouldForceProcessSnapshot(),
    snapshotId: getArgValue('snapshotId') || undefined
  };
}

function buildRunOptions(requested = {}) {
  return {
    forceProcessSnapshot: Boolean(requested.forceProcessSnapshot),
    snapshotId: requested.snapshotId,

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

function buildCliResponse({
  result,
  requested,
  startedAt
}) {
  const rawPayload = unwrapRunResult(result);
  const payload = normalizePayloadForLongOnly(rawPayload);

  const actions = targetRows(extractActions(payload));
  const actionCounts = getActionCounts(payload, actions);
  const entries = summarizeEntries(actions);
  const waits = summarizeWaits(actions);
  const exits = summarizeExits(payload);

  return {
    ok: payload?.ok !== false,

    source: 'CLI_RUN_LONG_TRADE_SYSTEM',

    argv: argv(),
    requested,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    longOnly: true,
    shortDisabled: true,

    forceProcessSnapshot: Boolean(requested.forceProcessSnapshot),

    runId: payload?.runId || null,

    snapshotId: payload?.snapshotId || requested.snapshotId || null,
    snapshotCreatedAt: payload?.snapshotCreatedAt || null,
    snapshotAgeSec: payload?.snapshotAgeSec ?? null,

    skippedNewEntries: Boolean(payload?.skippedNewEntries),
    reason: payload?.reason || null,

    candidates: payload?.candidates ?? null,
    processed: payload?.processed ?? null,
    earlyActions: payload?.earlyActions ?? null,

    liveRows: payload?.liveRows ?? null,
    actualLiveRows: payload?.actualLiveRows ?? null,
    mirrorRows: payload?.mirrorRows ?? null,

    analyzedRows: payload?.analyzedRows ?? null,
    analyzedActualRows: payload?.analyzedActualRows ?? null,
    analyzedMirrorRows: payload?.analyzedMirrorRows ?? null,

    activeRotationId: payload?.activeRotationId || null,
    activeMicroFamilies: payload?.activeMicroFamilies ?? null,
    activeMacroFamilies: payload?.activeMacroFamilies ?? null,
    trueMicroOnly: payload?.trueMicroOnly ?? null,
    usedLegacyFallback: Boolean(payload?.usedLegacyFallback),

    actions: actions.length,
    longActions: actions.length,
    rawActions: payload?.rawActionsCount ?? actions.length,
    ignoredShortActions: payload?.ignoredShortActions || 0,
    ignoredUnknownSideActions: payload?.ignoredUnknownSideActions || 0,

    actionCounts,

    entries,
    waits,
    exits,

    scannerSnapshotStats: payload?.scannerSnapshotStats || null,

    durationMs: now() - startedAt,

    result: payload
  };
}

function buildCliError({
  error,
  requested,
  startedAt
}) {
  return {
    ok: false,

    source: 'CLI_RUN_LONG_TRADE_SYSTEM',

    argv: argv(),
    requested,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    longOnly: true,
    shortDisabled: true,

    forceProcessSnapshot: Boolean(requested.forceProcessSnapshot),

    error: error?.message || String(error),
    stack: error?.stack,

    durationMs: now() - startedAt
  };
}

async function main() {
  const startedAt = now();
  const requested = buildRequestedOptions();

  try {
    const result = await runTradeSystem(
      buildRunOptions(requested)
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