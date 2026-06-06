// ================= FILE: api/admin/discord-logs.js =================

import { KEYS } from '../../src/keys.js';
import { getDurableRedis, readJsonLogs } from '../../src/redis.js';
import { sideToTradeSide } from '../../src/utils.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';

const TRADE_LOG_TYPES = new Set([
  'ENTRY',
  'EXIT',
  'TRADE',
  'POSITION',
  'ORDER'
]);

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET']
  });
}

function firstQueryValue(value, fallback = null) {
  if (Array.isArray(value)) return value[0] ?? fallback;
  if (value === undefined || value === null || value === '') return fallback;

  return value;
}

function clampLimit(value, fallback = 100) {
  const limit = Number(value);

  if (!Number.isFinite(limit)) return fallback;
  if (limit < 1) return 1;
  if (limit > 500) return 500;

  return Math.floor(limit);
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function getArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeSideToken(value) {
  const raw = upper(value);

  if (!raw) return 'UNKNOWN';

  const direct = sideToTradeSide(raw);

  if (direct === 'LONG' || direct === 'SHORT') return direct;

  if (['LONG', 'BULL', 'BULLISH', 'BUY', 'BID', 'UP', 'UPSIDE', 'GREEN'].includes(raw)) {
    return 'LONG';
  }

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'ASK', 'DOWN', 'DOWNSIDE', 'RED'].includes(raw)) {
    return 'SHORT';
  }

  return 'UNKNOWN';
}

function collectSideText(input = {}) {
  if (typeof input === 'string') return input;

  return [
    input.tradeSide,
    input.side,
    input.positionSide,
    input.direction,
    input.signalSide,
    input.scannerSide,
    input.entrySide,
    input.bias,
    input.marketBias,

    input.familyId,
    input.family,
    input.baseFamilyId,

    input.microFamilyId,
    input.trueMicroFamilyId,
    input.id,
    input.key,

    input.macroFamilyId,
    input.parentMacroFamilyId,
    input.parentMicroFamilyId,
    input.parentFamilyId,
    input.macroId,

    input.definition,
    input.microDefinition,
    input.macroDefinition,
    input.parentDefinition,

    ...getArray(input.definitionParts),
    ...getArray(input.microDefinitionParts),
    ...getArray(input.macroDefinitionParts),
    ...getArray(input.parentDefinitionParts)
  ]
    .map((value) => upper(value))
    .filter(Boolean)
    .join(' | ');
}

function hasLongSignal(text = '') {
  const raw = ` ${upper(text)} `;

  return (
    raw.includes('TRADE_SIDE=LONG') ||
    raw.includes('TRADESIDE=LONG') ||
    raw.includes('SIDE=LONG') ||
    raw.includes('DIRECTION=LONG') ||
    raw.includes('POSITION_SIDE=LONG') ||
    raw.includes('POSITIONSIDE=LONG') ||
    raw.includes('SIDE=BULL') ||
    raw.includes('DIRECTION=BULL') ||
    raw.includes('SIDE=BUY') ||
    raw.includes('DIRECTION=BUY') ||

    raw.includes('MICRO_LONG_') ||
    raw.includes('LONG_') ||
    raw.includes('_LONG') ||
    raw.includes('|LONG|') ||
    raw.includes(':LONG') ||
    raw.includes('=LONG') ||

    raw.includes(' BULL ') ||
    raw.includes('_BULL') ||
    raw.includes('BULL_') ||
    raw.includes('|BULL|') ||
    raw.includes(':BULL') ||
    raw.includes('=BULL') ||

    raw.includes(' BUY ') ||
    raw.includes('_BUY') ||
    raw.includes('BUY_') ||
    raw.includes('|BUY|') ||
    raw.includes(':BUY') ||
    raw.includes('=BUY')
  );
}

function hasShortSignal(text = '') {
  const raw = ` ${upper(text)} `;

  return (
    raw.includes('TRADE_SIDE=SHORT') ||
    raw.includes('TRADESIDE=SHORT') ||
    raw.includes('SIDE=SHORT') ||
    raw.includes('DIRECTION=SHORT') ||
    raw.includes('POSITION_SIDE=SHORT') ||
    raw.includes('POSITIONSIDE=SHORT') ||
    raw.includes('SIDE=BEAR') ||
    raw.includes('DIRECTION=BEAR') ||
    raw.includes('SIDE=SELL') ||
    raw.includes('DIRECTION=SELL') ||

    raw.includes('MICRO_SHORT_') ||
    raw.includes('SHORT_') ||
    raw.includes('_SHORT') ||
    raw.includes('|SHORT|') ||
    raw.includes(':SHORT') ||
    raw.includes('=SHORT') ||

    raw.includes(' BEAR ') ||
    raw.includes('_BEAR') ||
    raw.includes('BEAR_') ||
    raw.includes('|BEAR|') ||
    raw.includes(':BEAR') ||
    raw.includes('=BEAR') ||

    raw.includes(' SELL ') ||
    raw.includes('_SELL') ||
    raw.includes('SELL_') ||
    raw.includes('|SELL|') ||
    raw.includes(':SELL') ||
    raw.includes('=SELL')
  );
}

function inferTradeSide(input = {}) {
  if (typeof input === 'string') {
    const direct = normalizeSideToken(input);

    if (direct === 'LONG' || direct === 'SHORT') return direct;

    const longSignal = hasLongSignal(input);
    const shortSignal = hasShortSignal(input);

    if (longSignal && !shortSignal) return 'LONG';
    if (shortSignal && !longSignal) return 'SHORT';

    return 'UNKNOWN';
  }

  const payload = input.payload || {};

  const directSources = [
    input.tradeSide,
    input.side,
    input.positionSide,
    input.direction,
    payload.tradeSide,
    payload.side,
    payload.positionSide,
    payload.direction
  ];

  for (const source of directSources) {
    const normalized = normalizeSideToken(source);

    if (normalized === 'LONG' || normalized === 'SHORT') return normalized;
  }

  const text = collectSideText({
    ...payload,
    ...input,
    definitionParts: [
      ...getArray(payload.definitionParts),
      ...getArray(input.definitionParts)
    ],
    microDefinitionParts: [
      ...getArray(payload.microDefinitionParts),
      ...getArray(input.microDefinitionParts)
    ],
    macroDefinitionParts: [
      ...getArray(payload.macroDefinitionParts),
      ...getArray(input.macroDefinitionParts)
    ],
    parentDefinitionParts: [
      ...getArray(payload.parentDefinitionParts),
      ...getArray(input.parentDefinitionParts)
    ]
  });

  const longSignal = hasLongSignal(text);
  const shortSignal = hasShortSignal(text);

  if (longSignal && !shortSignal) return 'LONG';
  if (shortSignal && !longSignal) return 'SHORT';

  return 'UNKNOWN';
}

function dashboardSideFromTradeSide(tradeSide) {
  if (tradeSide === 'LONG') return 'bull';
  if (tradeSide === 'SHORT') return 'bear';

  return 'unknown';
}

function normalizeLog(row = {}) {
  const payload = row.payload || {};
  const type = upper(row.type || row.level || 'UNKNOWN');
  const tradeSide = inferTradeSide(row);

  const side = tradeSide === TARGET_TRADE_SIDE
    ? TARGET_DASHBOARD_SIDE
    : dashboardSideFromTradeSide(tradeSide);

  return {
    ...row,

    type,

    payload,

    symbol:
      row.symbol ||
      payload.symbol ||
      payload.contractSymbol ||
      null,

    side:
      side ||
      row.side ||
      payload.side ||
      null,

    tradeSide,

    positionSide: tradeSide === TARGET_TRADE_SIDE
      ? TARGET_TRADE_SIDE
      : row.positionSide || payload.positionSide || null,

    direction: tradeSide === TARGET_TRADE_SIDE
      ? TARGET_TRADE_SIDE
      : row.direction || payload.direction || null,

    microFamilyId:
      row.microFamilyId ||
      payload.microFamilyId ||
      payload.trueMicroFamilyId ||
      null,

    trueMicroFamilyId:
      row.trueMicroFamilyId ||
      payload.trueMicroFamilyId ||
      payload.microFamilyId ||
      null,

    familyId:
      row.familyId ||
      payload.familyId ||
      null,

    macroFamilyId:
      row.macroFamilyId ||
      payload.macroFamilyId ||
      payload.parentMacroFamilyId ||
      payload.parentMicroFamilyId ||
      null,

    result: row.result || null,

    longOnly: true,
    shortDisabled: true,

    ts: row.ts || row.createdAt || null
  };
}

function isTradeLog(log = {}) {
  return TRADE_LOG_TYPES.has(upper(log.type));
}

function filterTargetLogs(logs = []) {
  return logs.filter((log) => {
    if (log.tradeSide === 'SHORT') return false;
    if (log.tradeSide === TARGET_TRADE_SIDE) return true;

    // System logs zoals RESET/WEEKLY_ROTATION hebben vaak geen side.
    return !isTradeLog(log);
  });
}

function filterByType(logs = [], type = null) {
  if (!type) return logs;

  const wanted = upper(type);

  return logs.filter((log) => upper(log.type) === wanted);
}

function buildSummary(logs = []) {
  return logs.reduce((acc, log) => {
    const type = upper(log.type || 'UNKNOWN');
    const tradeSide = upper(log.tradeSide || 'UNKNOWN');

    acc.total += 1;
    acc.byType[type] = (acc.byType[type] || 0) + 1;
    acc.byTradeSide[tradeSide] = (acc.byTradeSide[tradeSide] || 0) + 1;

    if (log.result?.ok === false) {
      acc.failed += 1;
    }

    if (log.result?.skipped) {
      acc.skipped += 1;
    }

    return acc;
  }, {
    total: 0,
    failed: 0,
    skipped: 0,
    byType: {},
    byTradeSide: {}
  });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Discord-Logs-Mode', 'long-only');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Short-Disabled', 'true');

  try {
    if (req.method !== 'GET') {
      return methodNotAllowed(res);
    }

    const limit = clampLimit(req.query?.limit, 100);
    const type = firstQueryValue(req.query?.type, null);

    const redis = getDurableRedis();

    const rawLogs = await readJsonLogs(
      redis,
      KEYS.discord.logList,
      limit
    );

    const normalized = (Array.isArray(rawLogs) ? rawLogs : [])
      .map(normalizeLog);

    const targetLogs = filterTargetLogs(normalized);
    const logs = filterByType(targetLogs, type);

    return res.status(200).json({
      ok: true,

      targetTradeSide: TARGET_TRADE_SIDE,
      longOnly: true,
      shortDisabled: true,

      limit,
      type,

      count: logs.length,
      totalFetched: normalized.length,
      totalAfterSideFilter: targetLogs.length,

      summary: buildSummary(logs),

      logs,

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