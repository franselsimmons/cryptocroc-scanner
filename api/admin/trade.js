// ================= FILE: api/admin/trade.js =================

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

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET'],

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    longOnly: true,
    shortDisabled: true
  });
}

function asArray(value) {
  if (Array.isArray(value)) return value;

  if (value && typeof value === 'object') {
    return Object.values(value);
  }

  return [];
}

function num(value, fallback = 0) {
  return safeNumber(value, fallback);
}

function round(value, decimals = 4) {
  return Number(num(value, 0).toFixed(decimals));
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .flatMap((value) => String(value || '').split(/[\s,]+/g))
      .map((part) => part.trim())
      .filter(Boolean)
  )];
}

function getDefinitionHaystack(row = {}) {
  return [
    row.definition,
    row.microDefinition,
    row.macroDefinition,
    row.parentDefinition,
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts : []),
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : [])
  ]
    .map((value) => upper(value))
    .join(' | ');
}

function inferTradeSide(row = {}) {
  if (typeof row === 'string') {
    const value = upper(row);

    if (!value) return 'UNKNOWN';

    if (
      value.includes('MICRO_LONG_') ||
      value.includes('TRADESIDE=LONG') ||
      value.includes('TRADE_SIDE=LONG') ||
      value.includes('SIDE=LONG') ||
      value.includes('SIDE=BULL') ||
      value.includes('DIRECTION=LONG') ||
      value.includes('DIRECTION=BULL') ||
      value.includes('LONG')
    ) {
      return 'LONG';
    }

    if (
      value.includes('MICRO_SHORT_') ||
      value.includes('TRADESIDE=SHORT') ||
      value.includes('TRADE_SIDE=SHORT') ||
      value.includes('SIDE=SHORT') ||
      value.includes('SIDE=BEAR') ||
      value.includes('DIRECTION=SHORT') ||
      value.includes('DIRECTION=BEAR') ||
      value.includes('SHORT')
    ) {
      return 'SHORT';
    }

    return 'UNKNOWN';
  }

  const direct = sideToTradeSide(
    row.tradeSide ||
    row.side ||
    row.positionSide ||
    row.direction ||
    row.signalSide ||
    row.scannerSide ||
    row.entrySide ||
    row.bias ||
    row.marketBias
  );

  if (direct !== 'UNKNOWN') return direct;

  const rawSide = upper(row.side);

  if (['BULL', 'LONG', 'BUY', 'BULLISH'].includes(rawSide)) return 'LONG';
  if (['BEAR', 'SHORT', 'SELL', 'BEARISH'].includes(rawSide)) return 'SHORT';

  const familyId = upper(row.familyId || row.family || row.baseFamilyId);

  const macroFamilyId = upper(
    row.parentMacroFamilyId ||
    row.macroFamilyId ||
    row.parentMicroFamilyId ||
    row.parentFamilyId ||
    row.macroId ||
    row.macroFamily ||
    row.originalMicroFamilyId
  );

  const microFamilyId = upper(
    row.microFamilyId ||
    row.trueMicroFamilyId ||
    row.liveMicroFamilyId ||
    row.realMicroFamilyId ||
    row.executionMicroFamilyId ||
    row.id ||
    row.key
  );

  if (familyId.startsWith('LONG_')) return 'LONG';
  if (familyId.startsWith('SHORT_')) return 'SHORT';

  if (macroFamilyId.includes('MICRO_LONG_') || macroFamilyId.startsWith('LONG_')) return 'LONG';
  if (macroFamilyId.includes('MICRO_SHORT_') || macroFamilyId.startsWith('SHORT_')) return 'SHORT';

  if (macroFamilyId.includes('TRADESIDE=LONG') || macroFamilyId.includes('SIDE=LONG')) return 'LONG';
  if (macroFamilyId.includes('TRADESIDE=SHORT') || macroFamilyId.includes('SIDE=SHORT')) return 'SHORT';

  if (microFamilyId.includes('MICRO_LONG_')) return 'LONG';
  if (microFamilyId.includes('MICRO_SHORT_')) return 'SHORT';

  if (microFamilyId.includes('TRADESIDE=LONG') || microFamilyId.includes('SIDE=LONG')) return 'LONG';
  if (microFamilyId.includes('TRADESIDE=SHORT') || microFamilyId.includes('SIDE=SHORT')) return 'SHORT';

  const reason = upper(
    row.scannerReason ||
    row.reason ||
    row.signalReason ||
    row.actionReason ||
    row.exitReason
  );

  if (
    reason.includes('LONG') ||
    reason.includes('BULL') ||
    reason.includes('BUY') ||
    reason.includes('UPSIDE')
  ) {
    return 'LONG';
  }

  if (
    reason.includes('SHORT') ||
    reason.includes('BEAR') ||
    reason.includes('SELL') ||
    reason.includes('DOWNSIDE')
  ) {
    return 'SHORT';
  }

  const definition = getDefinitionHaystack(row);

  if (
    definition.includes('TRADESIDE=LONG') ||
    definition.includes('TRADE_SIDE=LONG') ||
    definition.includes('SIDE=LONG') ||
    definition.includes('SIDE=BULL') ||
    definition.includes('DIRECTION=LONG') ||
    definition.includes('DIRECTION=BULL') ||
    definition.includes('SIDE=BUY') ||
    definition.includes('DIRECTION=BUY')
  ) {
    return 'LONG';
  }

  if (
    definition.includes('TRADESIDE=SHORT') ||
    definition.includes('TRADE_SIDE=SHORT') ||
    definition.includes('SIDE=SHORT') ||
    definition.includes('SIDE=BEAR') ||
    definition.includes('DIRECTION=SHORT') ||
    definition.includes('DIRECTION=BEAR') ||
    definition.includes('SIDE=SELL') ||
    definition.includes('DIRECTION=SELL')
  ) {
    return 'SHORT';
  }

  if (microFamilyId.includes('LONG')) return 'LONG';
  if (microFamilyId.includes('SHORT')) return 'SHORT';

  return 'UNKNOWN';
}

function isLongRow(row = {}) {
  return inferTradeSide(row) === TARGET_TRADE_SIDE;
}

function isShortRow(row = {}) {
  return inferTradeSide(row) === 'SHORT';
}

function forceLongRow(row = {}) {
  return {
    ...row,
    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    targetTradeSide: TARGET_TRADE_SIDE,
    longOnly: true,
    shortDisabled: true
  };
}

function normalizeDashboardSide(row = {}) {
  return inferTradeSide(row) === TARGET_TRADE_SIDE
    ? TARGET_DASHBOARD_SIDE
    : 'unknown';
}

function calcAgeSec(ts) {
  const value = num(ts, 0);

  if (value <= 0) return null;

  return Math.max(0, Math.floor((Date.now() - value) / 1000));
}

function calcRiskDistance(entry, initialSl) {
  const e = num(entry, 0);
  const sl = num(initialSl, 0);

  if (e <= 0 || sl <= 0) return 0;

  return Math.abs(e - sl);
}

function calcRewardDistance(entry, tp) {
  const e = num(entry, 0);
  const target = num(tp, 0);

  if (e <= 0 || target <= 0) return 0;

  return Math.abs(target - e);
}

function calcCurrentR({
  side,
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

  const tradeSide = inferTradeSide({ side });

  if (tradeSide === 'LONG') {
    return (price - e) / riskDistance;
  }

  return num(fallback, 0);
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
    row.microFamilyId ||
    row.trueMicroFamilyId ||
    row.liveMicroFamilyId ||
    row.realMicroFamilyId ||
    row.executionMicroFamilyId ||
    row.id ||
    row.key ||
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

function normalizePosition(position = {}) {
  const symbol = normalizeBaseSymbol(
    position.symbol ||
    position.baseSymbol ||
    position.contractSymbol
  );

  const contractSymbol = normalizeContractSymbol(
    position.contractSymbol ||
    position.symbol ||
    symbol
  );

  const microFamilyId = getMicroFamilyId(position);
  const macroFamilyId = getMacroFamilyId(position) || microFamilyId;
  const familyId = getFamilyId(position);

  const tradeSide = inferTradeSide({
    ...position,
    microFamilyId,
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

  const currentPrice = num(
    position.lastPrice ??
    position.currentPrice ??
    position.markPrice ??
    position.price,
    null
  );

  const riskDistance = calcRiskDistance(entry, initialSl);
  const rewardDistance = calcRewardDistance(entry, tp);

  const rr = num(
    position.rr,
    riskDistance > 0 ? rewardDistance / riskDistance : 0
  );

  const currentR = calcCurrentR({
    side: tradeSide,
    entry,
    initialSl,
    currentPrice,
    fallback: position.currentR
  });

  const openedAt = num(
    position.openedAt ??
    position.createdAt ??
    position.ts,
    null
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

  return {
    ...position,

    symbol: symbol || position.symbol || null,
    baseSymbol: symbol || position.baseSymbol || null,
    contractSymbol,

    side: tradeSide === TARGET_TRADE_SIDE
      ? TARGET_DASHBOARD_SIDE
      : normalizeDashboardSide({ ...position, tradeSide }),

    tradeSide,

    targetTradeSide: TARGET_TRADE_SIDE,
    longOnly: true,
    shortDisabled: true,

    entry,
    sl,
    initialSl,
    tp,
    rr: round(rr, 4),

    currentPrice,
    currentR: round(currentR, 4),
    mfeR: round(position.mfeR, 4),
    maeR: round(position.maeR, 4),

    riskPct: round(position.riskPct, 6),
    riskFraction: round(position.riskFraction, 6),

    familyId,
    macroFamilyId,
    microFamilyId,

    macroDefinition: position.macroDefinition || position.parentDefinition || null,
    macroDefinitionParts,

    definition: position.definition || position.microDefinition || null,
    definitionParts,

    activeRotationId: position.activeRotationId || null,

    openedAt,
    ageSec: calcAgeSec(openedAt),

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
    )
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
  const longRows = positions.filter((position) => isLongRow(position));

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

  return {
    targetTradeSide: TARGET_TRADE_SIDE,
    longOnly: true,
    shortDisabled: true,

    openPositions: longRows.length,

    bullPositions: longRows.length,
    bearPositions: 0,
    unknownSidePositions: 0,

    longPositions: longRows.length,
    shortPositions: 0,

    rawOpenPositions: num(ignored.rawOpenPositions, longRows.length),
    ignoredShortPositions: num(ignored.ignoredShortPositions, 0),
    ignoredUnknownSidePositions: num(ignored.ignoredUnknownSidePositions, 0),

    profitablePositions: profitable.length,
    losingPositions: losing.length,
    flatPositions: longRows.length - profitable.length - losing.length,

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

    uniqueMacroFamilies: uniqueMacroFamilies.length,
    uniqueMicroFamilies: uniqueMicroFamilies.length,

    byMacroFamily: countBy(longRows, (p) => p.macroFamilyId),
    byMicroFamily: countBy(longRows, (p) => p.microFamilyId),
    bySide: {
      bull: longRows.length,
      bear: 0,
      unknown: 0
    }
  };
}

function extractSnapshotId(value) {
  if (!value) return null;

  if (typeof value === 'string') {
    return value;
  }

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
      raw: null
    };
  }

  if (typeof lastProcessed === 'string') {
    return {
      snapshotId: lastProcessed,
      raw: lastProcessed
    };
  }

  return {
    ...lastProcessed,

    targetTradeSide: TARGET_TRADE_SIDE,
    longOnly: true,
    shortDisabled: true,

    snapshotId,
    raw: lastProcessed
  };
}

function normalizeAction(action = {}) {
  const microFamilyId = getMicroFamilyId(action);
  const macroFamilyId = getMacroFamilyId(action) || microFamilyId;
  const familyId = getFamilyId(action);

  const tradeSide = inferTradeSide({
    ...action,
    microFamilyId,
    macroFamilyId,
    familyId
  });

  return {
    ...action,

    side: tradeSide === TARGET_TRADE_SIDE
      ? TARGET_DASHBOARD_SIDE
      : normalizeDashboardSide({
        ...action,
        tradeSide,
        microFamilyId,
        macroFamilyId,
        familyId
      }),

    tradeSide,

    targetTradeSide: TARGET_TRADE_SIDE,
    longOnly: true,
    shortDisabled: true,

    familyId,
    macroFamilyId,
    microFamilyId,

    scannerScore: action.scannerScore ?? action.moveScore ?? null,

    confluence: round(action.confluence, 4),
    sniperScore: round(action.sniperScore, 4),

    rr: round(action.rr, 4),
    spreadPct: round(action.spreadPct, 6),
    depthMinUsd1p: round(action.depthMinUsd1p, 2),

    liveEligible: Boolean(action.liveEligible),
    shadowOnly: Boolean(action.shadowOnly)
  };
}

function actionCounts(actions = []) {
  return actions.reduce((acc, action) => {
    const key = action.action || action.type || 'UNKNOWN';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function normalizeRunMeta(runMeta) {
  if (!runMeta || typeof runMeta !== 'object') return null;

  const rawActions = Array.isArray(runMeta.actions)
    ? runMeta.actions.map(normalizeAction)
    : [];

  const actions = rawActions
    .filter(isLongRow)
    .map(forceLongRow);

  const ignoredShortActions = rawActions.filter(isShortRow).length;
  const ignoredUnknownSideActions = rawActions.filter((action) => (
    inferTradeSide(action) === 'UNKNOWN'
  )).length;

  const realExitsRaw = Array.isArray(runMeta.realExits)
    ? runMeta.realExits.map(normalizeAction)
    : [];

  const shadowExitsRaw = Array.isArray(runMeta.shadowExits)
    ? runMeta.shadowExits.map(normalizeAction)
    : [];

  const realExits = realExitsRaw
    .filter(isLongRow)
    .map(forceLongRow);

  const shadowExits = shadowExitsRaw
    .filter(isLongRow)
    .map(forceLongRow);

  const entryActions = actions.filter((action) => action.action === 'ENTRY');
  const waitActions = actions.filter((action) => action.action === 'WAIT');

  return {
    ...runMeta,

    targetTradeSide: TARGET_TRADE_SIDE,
    longOnly: true,
    shortDisabled: true,

    actionCounts: actionCounts(actions),
    rawActionCounts: runMeta.actionCounts || actionCounts(rawActions),

    actions,
    actionsCount: actions.length,

    rawActionsCount: rawActions.length,
    ignoredShortActions,
    ignoredUnknownSideActions,

    entriesCount: entryActions.length,
    waitsCount: waitActions.length,

    realExits,
    shadowExits,

    realExitsCount: realExits.length,
    shadowExitsCount: shadowExits.length,

    rawRealExitsCount: realExitsRaw.length,
    rawShadowExitsCount: shadowExitsRaw.length,

    ignoredShortRealExits: realExitsRaw.filter(isShortRow).length,
    ignoredShortShadowExits: shadowExitsRaw.filter(isShortRow).length,

    macroFamiliesSeen: uniqueStrings(
      actions.map((action) => action.macroFamilyId)
    ).length,

    microFamiliesSeen: uniqueStrings(
      actions.map((action) => action.microFamilyId)
    ).length
  };
}

function idsFromRotation(rotation = {}) {
  const rows = Array.isArray(rotation.microFamilies)
    ? rotation.microFamilies
    : [];

  const normalizedRows = rows.map(normalizeAction);
  const longRows = normalizedRows
    .filter(isLongRow)
    .map(forceLongRow);

  const explicitMicroFamilyIds = uniqueStrings([
    rotation.microFamilyIds,
    rotation.activeMicroFamilyIds,
    rotation.trueMicroFamilyIds,
    rotation.ids
  ]).filter((id) => inferTradeSide(id) === TARGET_TRADE_SIDE);

  const explicitMacroFamilyIds = uniqueStrings([
    rotation.macroFamilyIds,
    rotation.activeMacroFamilyIds,
    rotation.macroIds
  ]).filter((id) => inferTradeSide(id) === TARGET_TRADE_SIDE);

  const rowMicroFamilyIds = uniqueStrings(
    longRows.map((row) => row.microFamilyId)
  );

  const rowMacroFamilyIds = uniqueStrings(
    longRows.map((row) => (
      row.macroFamilyId ||
      row.parentMacroFamilyId ||
      row.parentMicroFamilyId ||
      row.microFamilyId
    ))
  );

  const microFamilyIds = uniqueStrings([
    rowMicroFamilyIds,
    explicitMicroFamilyIds
  ]);

  const macroFamilyIds = uniqueStrings([
    rowMacroFamilyIds,
    explicitMacroFamilyIds
  ]);

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
      targetTradeSide: TARGET_TRADE_SIDE,
      longOnly: true,
      shortDisabled: true,

      rotationId: null,
      activeMicroFamilyIds: [],
      activeMacroFamilyIds: [],
      activeMicroCount: 0,
      activeMacroCount: 0,
      microFamilies: [],
      bestLong: null,
      bestShort: null,
      raw: null
    };
  }

  const ids = idsFromRotation(activeRotation);
  const longRows = ids.longRows;

  return {
    targetTradeSide: TARGET_TRADE_SIDE,
    longOnly: true,
    shortDisabled: true,

    rotationId: activeRotation.rotationId || null,

    activeMicroFamilyIds: ids.microFamilyIds,
    activeMacroFamilyIds: ids.macroFamilyIds,

    activeMicroCount: ids.microFamilyIds.length,
    activeMacroCount: ids.macroFamilyIds.length,

    sourceWeekKey: activeRotation.sourceWeekKey || null,
    activeWeekKey: activeRotation.activeWeekKey || null,
    mode: activeRotation.mode || null,
    source: activeRotation.source || null,

    trueMicroOnly: activeRotation.trueMicroOnly !== false,
    usedLegacyFallback: Boolean(activeRotation.usedLegacyFallback),
    usedSoftFallback: Boolean(activeRotation.usedSoftFallback),
    usedObservationFallback: Boolean(activeRotation.usedObservationFallback),

    microFamilies: longRows,
    bestLong: longRows[0] || null,
    bestShort: null,

    rawRowsCount: ids.rawRows.length,
    ignoredShortRows: ids.rawRows.filter(isShortRow).length,
    ignoredUnknownSideRows: ids.rawRows.filter((row) => inferTradeSide(row) === 'UNKNOWN').length,

    raw: {
      ...activeRotation,
      targetTradeSide: TARGET_TRADE_SIDE,
      longOnly: true,
      shortDisabled: true,
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

  const activeMicroPositions = positions.filter((position) => (
    position.microFamilyId &&
    activeMicroSet.has(position.microFamilyId)
  ));

  const activeMacroPositions = positions.filter((position) => (
    position.macroFamilyId &&
    activeMacroSet.has(position.macroFamilyId)
  ));

  const outsideRotation = positions.filter((position) => (
    !activeMicroSet.has(position.microFamilyId) &&
    !activeMacroSet.has(position.macroFamilyId)
  ));

  return {
    targetTradeSide: TARGET_TRADE_SIDE,
    longOnly: true,
    shortDisabled: true,

    activeMicroPositions: activeMicroPositions.length,
    activeMacroPositions: activeMacroPositions.length,
    outsideRotationPositions: outsideRotation.length,

    outsideRotationSymbols: outsideRotation.map((position) => position.symbol).filter(Boolean)
  };
}

function normalizeLatestScan(latestScan) {
  if (!latestScan || typeof latestScan !== 'object') return latestScan;

  return {
    ...latestScan,
    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    longOnly: true,
    shortDisabled: true
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Trade-Mode', 'long-only');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Short-Disabled', 'true');

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
      getOpenPositions(),
      getJson(durable, KEYS.trade.runMeta, null),
      getJson(durable, KEYS.trade.lastProcessedSnapshot, null),
      getJson(volatile, KEYS.scan.latest, null),
      getActiveRotation().catch(() => null)
    ]);

    const allPositions = asArray(rawPositions).map(normalizePosition);

    const positions = allPositions
      .filter(isLongRow)
      .map(forceLongRow);

    const ignoredShortPositions = allPositions.filter(isShortRow).length;
    const ignoredUnknownSidePositions = allPositions.filter((position) => (
      inferTradeSide(position) === 'UNKNOWN'
    )).length;

    const stats = buildPositionStats(positions, {
      rawOpenPositions: allPositions.length,
      ignoredShortPositions,
      ignoredUnknownSidePositions
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

    return res.status(200).json({
      ok: true,

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      longOnly: true,
      shortDisabled: true,

      positions,
      openPositions: positions,
      positionsCount: positions.length,

      rawPositionsCount: allPositions.length,
      ignoredShortPositions,
      ignoredUnknownSidePositions,

      stats,
      rotationMatchStats,

      runMeta,
      lastProcessed,

      latestScan,
      latestScannerSnapshotId,
      scannerAndTradeInSync,

      activeRotationId: activeRotation.rotationId,
      activeMicroFamilyIds: activeRotation.activeMicroFamilyIds,
      activeMacroFamilyIds: activeRotation.activeMacroFamilyIds,
      activeMicroCount: activeRotation.activeMicroCount,
      activeMacroCount: activeRotation.activeMacroCount,
      activeRotation,

      serverTs: Date.now()
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,

      targetTradeSide: TARGET_TRADE_SIDE,
      longOnly: true,
      shortDisabled: true,

      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}