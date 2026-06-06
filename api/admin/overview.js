// ================= FILE: api/admin/overview.js =================

import { KEYS } from '../../src/keys.js';
import {
  getDurableRedis,
  getVolatileRedis,
  getJson,
  readJsonLogs
} from '../../src/redis.js';
import {
  getIsoWeekKey,
  getPreviousIsoWeekKey,
  safeNumber,
  sideToTradeSide
} from '../../src/utils.js';
import { getOpenPositions } from '../../src/trade/positionEngine.js';
import { getWeekMicros } from '../../src/analyze/analyzeEngine.js';
import { getRotationDashboard } from '../../src/analyze/rotationEngine.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

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
  if (value && typeof value === 'object') return Object.values(value);

  return [];
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
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

function inferTradeSide(input = {}) {
  if (typeof input === 'string') {
    const value = upper(input);

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
    input.tradeSide ||
    input.side ||
    input.positionSide ||
    input.direction ||
    input.signalSide ||
    input.scannerSide ||
    input.entrySide ||
    input.bias ||
    input.marketBias
  );

  if (direct !== 'UNKNOWN') return direct;

  const rawSide = upper(input.side);

  if (['LONG', 'BULL', 'BULLISH', 'BUY'].includes(rawSide)) return 'LONG';
  if (['SHORT', 'BEAR', 'BEARISH', 'SELL'].includes(rawSide)) return 'SHORT';

  const familyId = upper(input.familyId || input.family || input.baseFamilyId);

  const macroFamilyId = upper(
    input.parentMacroFamilyId ||
    input.macroFamilyId ||
    input.parentMicroFamilyId ||
    input.parentFamilyId ||
    input.macroId
  );

  const microFamilyId = upper(
    input.microFamilyId ||
    input.trueMicroFamilyId ||
    input.id ||
    input.key
  );

  if (familyId.startsWith('LONG_')) return 'LONG';
  if (familyId.startsWith('SHORT_')) return 'SHORT';

  if (macroFamilyId.includes('LONG')) return 'LONG';
  if (macroFamilyId.includes('SHORT')) return 'SHORT';

  if (microFamilyId.includes('MICRO_LONG_')) return 'LONG';
  if (microFamilyId.includes('MICRO_SHORT_')) return 'SHORT';

  if (microFamilyId.includes('TRADESIDE=LONG')) return 'LONG';
  if (microFamilyId.includes('TRADESIDE=SHORT')) return 'SHORT';

  const definition = getDefinitionHaystack(input);

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
  return inferTradeSide(row) === OPPOSITE_TRADE_SIDE;
}

function isLongId(id = '') {
  return inferTradeSide(String(id || '')) === TARGET_TRADE_SIDE;
}

function filterLongRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .filter(Boolean)
    .filter(isLongRow);
}

function countMapOrArray(value) {
  if (Array.isArray(value)) {
    return filterLongRows(value).length;
  }

  if (value && typeof value === 'object') {
    return Object.values(value).filter(isLongRow).length;
  }

  return 0;
}

function countShortMapOrArray(value) {
  if (Array.isArray(value)) {
    return value.filter(isShortRow).length;
  }

  if (value && typeof value === 'object') {
    return Object.values(value).filter(isShortRow).length;
  }

  return 0;
}

function normalizeLongSide(row = {}) {
  return {
    ...row,
    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE
  };
}

function normalizeLatestScan(latestScan) {
  if (!latestScan || typeof latestScan !== 'object') {
    return null;
  }

  const rawCandidates = Array.isArray(latestScan.candidates)
    ? latestScan.candidates
    : [];

  const candidates = filterLongRows(rawCandidates).map(normalizeLongSide);

  const createdAt = safeNumber(
    latestScan.createdAt ||
    latestScan.ts ||
    latestScan.scannerTs,
    0
  );

  const snapshotAgeSec = createdAt > 0
    ? Math.max(0, Math.floor((Date.now() - createdAt) / 1000))
    : null;

  const topSymbols = rawCandidates.length > 0
    ? candidates.slice(0, 20).map((row) => row.symbol).filter(Boolean)
    : Array.isArray(latestScan.topSymbols)
      ? latestScan.topSymbols
      : [];

  return {
    ...latestScan,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    longOnly: true,
    shortDisabled: true,

    snapshotId: extractSnapshotId(latestScan),

    createdAt: createdAt || null,
    snapshotAgeSec,

    rawCandidatesCount: rawCandidates.length,

    candidatesCount: rawCandidates.length > 0
      ? candidates.length
      : safeNumber(
        latestScan.longCandidatesCount ??
        latestScan.scannerGateCandidatesCount ??
        latestScan.candidatesCount ??
        latestScan.count,
        0
      ),

    longCandidatesCount: candidates.length,

    shortCandidatesIgnored: rawCandidates.filter(isShortRow).length,

    topSymbols,

    candidates
  };
}

function normalizeRotation(rotation) {
  if (!rotation || typeof rotation !== 'object') {
    return null;
  }

  const rawMicroFamilies = Array.isArray(rotation.microFamilies)
    ? rotation.microFamilies
    : [];

  const microFamilies = rawMicroFamilies
    .filter(isLongRow)
    .map(normalizeLongSide);

  const rowIds = microFamilies
    .map((row) => row.microFamilyId || row.trueMicroFamilyId || row.id)
    .filter(Boolean);

  const explicitIds = Array.isArray(rotation.microFamilyIds)
    ? rotation.microFamilyIds.filter(isLongId)
    : [];

  const microFamilyIds = uniqueStrings([
    ...explicitIds,
    ...rowIds
  ]);

  const macroFamilyIds = uniqueStrings([
    ...(Array.isArray(rotation.macroFamilyIds) ? rotation.macroFamilyIds : []),
    ...(Array.isArray(rotation.activeMacroFamilyIds) ? rotation.activeMacroFamilyIds : []),
    ...microFamilies.map((row) => (
      row.parentMacroFamilyId ||
      row.parentMicroFamilyId ||
      row.macroFamilyId
    ))
  ])
    .filter((id) => isLongId(id) || upper(id).includes('LONG'));

  const bestLongRaw =
    rotation.bestLong ||
    microFamilies.find((row) => isLongRow(row)) ||
    null;

  const bestLong = bestLongRaw
    ? normalizeLongSide(bestLongRaw)
    : null;

  return {
    ...rotation,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    longOnly: true,
    shortDisabled: true,

    sideMode: 'long_only',

    bestShort: null,
    bestLong,

    microFamilyIds,
    activeMicroFamilyIds: microFamilyIds,
    trueMicroFamilyIds: microFamilyIds,

    macroFamilyIds,
    activeMacroFamilyIds: macroFamilyIds,

    microFamilies,

    count: microFamilyIds.length || microFamilies.length,

    rawMicroFamiliesCount: rawMicroFamilies.length,
    shortMicroFamiliesIgnored: rawMicroFamilies.filter(isShortRow).length,

    missingSides: microFamilyIds.length || microFamilies.length
      ? []
      : [TARGET_TRADE_SIDE]
  };
}

function buildLongActionCounts(actions = [], fallbackCounts = {}) {
  const longActions = filterLongRows(actions);

  if (!longActions.length && !actions.length) {
    return fallbackCounts || {};
  }

  return longActions.reduce((acc, row) => {
    const key = row?.action || row?.type || 'UNKNOWN';

    acc[key] = (acc[key] || 0) + 1;

    return acc;
  }, {});
}

function buildTradeSummary(tradeMeta) {
  if (!tradeMeta || typeof tradeMeta !== 'object') {
    return {
      lastRunAt: null,
      actionCounts: {},
      realExits: 0,
      shadowExits: 0,
      skippedNewEntries: null,
      reason: null,

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      longOnly: true,
      shortDisabled: true
    };
  }

  const actions = Array.isArray(tradeMeta.actions)
    ? tradeMeta.actions
    : [];

  const longActions = filterLongRows(actions);
  const shortActionsIgnored = actions.filter(isShortRow).length;

  const realExits = Array.isArray(tradeMeta.realExits)
    ? filterLongRows(tradeMeta.realExits)
    : [];

  const shadowExits = Array.isArray(tradeMeta.shadowExits)
    ? filterLongRows(tradeMeta.shadowExits)
    : [];

  return {
    lastRunAt: tradeMeta.completedAt || tradeMeta.startedAt || tradeMeta.ts || null,
    durationMs: tradeMeta.durationMs ?? null,

    snapshotId: tradeMeta.snapshotId || null,
    snapshotAgeSec: tradeMeta.snapshotAgeSec ?? null,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    longOnly: true,
    shortDisabled: true,

    actionCounts: buildLongActionCounts(actions, tradeMeta.actionCounts || {}),

    actions: longActions.length,
    rawActions: actions.length,
    shortActionsIgnored,

    realExits: realExits.length,
    shadowExits: shadowExits.length,

    skippedNewEntries: Boolean(tradeMeta.skippedNewEntries),
    reason: tradeMeta.reason || null,

    activeRotationId: tradeMeta.activeRotationId || null,
    activeMicroFamilies: tradeMeta.activeMicroFamilies ?? null
  };
}

function compactRotationDashboard(rotationDashboard = {}) {
  const active = normalizeRotation(
    rotationDashboard.active ||
    rotationDashboard.activeRotation ||
    null
  );

  const next = normalizeRotation(
    rotationDashboard.next ||
    rotationDashboard.nextRotation ||
    null
  );

  return {
    ...rotationDashboard,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    longOnly: true,
    shortDisabled: true,

    active,
    next,
    activeRotation: active,
    nextRotation: next,

    activeRows: filterLongRows(rotationDashboard.activeRows || []).map(normalizeLongSide),
    nextRows: filterLongRows(rotationDashboard.nextRows || []).map(normalizeLongSide),

    activeCount: active?.count || 0,
    nextCount: next?.count || 0,

    activeMicroFamilyIds: active?.microFamilyIds || [],
    nextMicroFamilyIds: next?.microFamilyIds || [],

    activeMacroFamilyIds: active?.macroFamilyIds || active?.activeMacroFamilyIds || [],
    nextMacroFamilyIds: next?.macroFamilyIds || next?.activeMacroFamilyIds || [],

    bestShort: null,
    bestLong: active?.bestLong || null,

    nextBestShort: null,
    nextBestLong: next?.bestLong || null,

    missingSides: active?.missingSides || [],
    nextMissingSides: next?.missingSides || []
  };
}

async function safeRead(label, fn, fallback) {
  try {
    const value = await fn();

    return {
      ok: true,
      label,
      value
    };
  } catch (error) {
    return {
      ok: false,
      label,
      value: fallback,
      error: error?.message || String(error)
    };
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Overview-Mode', 'long-only');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Short-Disabled', 'true');

  if (req.method !== 'GET') {
    return methodNotAllowed(res);
  }

  try {
    const durable = getDurableRedis();
    const volatile = getVolatileRedis();

    const weekKey = getIsoWeekKey();
    const previousWeekKey = getPreviousIsoWeekKey();

    const [
      latestScanRead,
      tradeMetaRead,
      positionsRead,
      currentMicrosRead,
      previousMicrosRead,
      rotationRead,
      discordLogsRead
    ] = await Promise.all([
      safeRead(
        'latestScan',
        () => getJson(volatile, KEYS.scan.latest, null),
        null
      ),

      safeRead(
        'tradeMeta',
        () => getJson(durable, KEYS.trade.runMeta, null),
        null
      ),

      safeRead(
        'openPositions',
        () => getOpenPositions(),
        []
      ),

      safeRead(
        'currentWeekMicros',
        () => getWeekMicros(weekKey),
        {}
      ),

      safeRead(
        'previousWeekMicros',
        () => getWeekMicros(previousWeekKey),
        {}
      ),

      safeRead(
        'rotationDashboard',
        () => getRotationDashboard(),
        {
          active: null,
          next: null,
          validFrom: null,
          activeRows: [],
          nextRows: [],
          activeCount: 0,
          nextCount: 0
        }
      ),

      safeRead(
        'discordLogs',
        () => readJsonLogs(durable, KEYS.discord.logList, 10),
        []
      )
    ]);

    const latestScan = normalizeLatestScan(latestScanRead.value);
    const tradeMeta = tradeMetaRead.value || null;
    const tradeSummary = buildTradeSummary(tradeMeta);

    const rawPositions = asArray(positionsRead.value);
    const positions = filterLongRows(rawPositions).map(normalizeLongSide);

    const currentMicros = currentMicrosRead.value || {};
    const previousMicros = previousMicrosRead.value || {};

    const rawRotationDashboard = rotationRead.value || {};
    const rotationDashboard = compactRotationDashboard(rawRotationDashboard);

    const activeRotation = rotationDashboard.active || null;
    const nextRotation = rotationDashboard.next || null;

    const discordLogs = Array.isArray(discordLogsRead.value)
      ? discordLogsRead.value
      : [];

    const warnings = [
      latestScanRead,
      tradeMetaRead,
      positionsRead,
      currentMicrosRead,
      previousMicrosRead,
      rotationRead,
      discordLogsRead
    ]
      .filter((row) => !row.ok)
      .map((row) => ({
        source: row.label,
        error: row.error
      }));

    const shortIgnored = {
      positions: rawPositions.filter(isShortRow).length,
      currentWeekMicroFamilies: countShortMapOrArray(currentMicros),
      previousWeekMicroFamilies: countShortMapOrArray(previousMicros),
      scannerCandidates: latestScan?.shortCandidatesIgnored || 0,
      activeRotationRows: activeRotation?.shortMicroFamiliesIgnored || 0,
      nextRotationRows: nextRotation?.shortMicroFamiliesIgnored || 0
    };

    return res.status(200).json({
      ok: true,

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      longOnly: true,
      shortDisabled: true,

      weekKey,
      currentWeekKey: weekKey,
      previousWeekKey,

      latestScan,
      latestScannerSnapshotId: latestScan?.snapshotId || null,

      scannerCandidates: latestScan?.candidatesCount || 0,
      longScannerCandidates: latestScan?.longCandidatesCount || latestScan?.candidatesCount || 0,

      tradeMeta,
      tradeSummary,

      openPositions: positions.length,
      positionsCount: positions.length,
      rawPositionsCount: rawPositions.length,
      positions,

      currentWeekMicroFamilies: countMapOrArray(currentMicros),
      previousWeekMicroFamilies: countMapOrArray(previousMicros),

      activeRotation,
      nextRotation,

      activeRotationId: activeRotation?.rotationId || null,
      nextRotationId: nextRotation?.rotationId || null,

      activeRotationCount: activeRotation?.count || 0,
      nextRotationCount: nextRotation?.count || 0,

      activeMicroFamilyIds: activeRotation?.microFamilyIds || [],
      nextMicroFamilyIds: nextRotation?.microFamilyIds || [],

      activeMacroFamilyIds: activeRotation?.macroFamilyIds || [],
      nextMacroFamilyIds: nextRotation?.macroFamilyIds || [],

      bestShort: null,
      bestLong: activeRotation?.bestLong || null,
      nextBestShort: null,
      nextBestLong: nextRotation?.bestLong || null,

      rotationDashboard,

      discordLogs,

      shortIgnored,
      warnings,

      serverTs: Date.now()
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      longOnly: true,
      shortDisabled: true,

      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production' ? undefined : error?.stack
    });
  }
}