// ================= FILE: api/trade/run.js =================

import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import { getDurableRedis } from '../../src/redis.js';
import { withRedisLock } from '../../src/lock.js';
import { runTradeSystem } from '../../src/trade/tradeSystem.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET, POST');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET', 'POST'],

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    longOnly: true,
    shortDisabled: true
  });
}

function isAllowedMethod(method) {
  return method === 'GET' || method === 'POST';
}

function parseJson(text) {
  const raw = String(text || '').trim();

  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('INVALID_JSON_BODY');
    error.statusCode = 400;
    throw error;
  }
}

async function readBody(req) {
  if (req.method === 'GET') return {};

  if (req.body) {
    if (typeof req.body === 'string') return parseJson(req.body);
    if (Buffer.isBuffer(req.body)) return parseJson(req.body.toString('utf8'));

    return req.body;
  }

  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return parseJson(Buffer.concat(chunks).toString('utf8'));
}

function firstValue(value, fallback = null) {
  if (Array.isArray(value)) return value[0] ?? fallback;
  if (value === undefined || value === null || value === '') return fallback;

  return value;
}

function isTrue(value) {
  return (
    value === true ||
    value === 'true' ||
    value === 'TRUE' ||
    value === 1 ||
    value === '1' ||
    value === 'yes' ||
    value === 'YES'
  );
}

function getLockTtlSec() {
  const ttl = Number(CONFIG.trade?.lockTtlSec || 180);

  return Number.isFinite(ttl) && ttl > 0
    ? Math.floor(ttl)
    : 180;
}

function shouldForceProcessSnapshot(req, body = {}) {
  return (
    isTrue(firstValue(req.query?.force, false)) ||
    isTrue(firstValue(req.query?.forceProcessSnapshot, false)) ||
    isTrue(body.force) ||
    isTrue(body.forceProcessSnapshot)
  );
}

function getRunSource(req, body = {}) {
  const manual = (
    isTrue(firstValue(req.query?.manual, false)) ||
    isTrue(firstValue(req.query?.force, false)) ||
    isTrue(firstValue(req.query?.forceProcessSnapshot, false)) ||
    isTrue(body.manual) ||
    isTrue(body.force) ||
    isTrue(body.forceProcessSnapshot)
  );

  return manual
    ? 'ADMIN_MANUAL_RUN'
    : 'CRON_OR_API_RUN';
}

function unwrapLockResult(lockResult) {
  return lockResult?.result || lockResult || null;
}

function responseOk(lockResult) {
  const payload = unwrapLockResult(lockResult);

  return (
    lockResult?.ok !== false &&
    payload?.ok !== false
  );
}

function responseSkipped(lockResult) {
  const payload = unwrapLockResult(lockResult);

  return Boolean(
    lockResult?.skipped ||
    payload?.skippedNewEntries ||
    payload?.skipped ||
    false
  );
}

function responseReason(lockResult) {
  const payload = unwrapLockResult(lockResult);

  return (
    lockResult?.reason ||
    payload?.reason ||
    null
  );
}

function responseRunId(lockResult) {
  const payload = unwrapLockResult(lockResult);

  return payload?.runId || null;
}

function responseSnapshotId(lockResult) {
  const payload = unwrapLockResult(lockResult);

  return payload?.snapshotId || null;
}

function normalizeTradeSide(value) {
  const raw = String(value || '').trim().toUpperCase();

  if (['LONG', 'BULL', 'BULLISH', 'BUY'].includes(raw)) return 'LONG';
  if (['SHORT', 'BEAR', 'BEARISH', 'SELL'].includes(raw)) return 'SHORT';

  return 'UNKNOWN';
}

function inferTradeSideFromText(value) {
  const text = String(value || '').toUpperCase();

  if (!text) return 'UNKNOWN';

  if (
    text.includes('MICRO_LONG_') ||
    text.includes('TRADESIDE=LONG') ||
    text.includes('TRADE_SIDE=LONG') ||
    text.includes('SIDE=LONG') ||
    text.includes('SIDE=BULL') ||
    text.includes('DIRECTION=LONG') ||
    text.includes('DIRECTION=BULL') ||
    text.includes('SIDE=BUY') ||
    text.includes('DIRECTION=BUY') ||
    text.includes('LONG_') ||
    text.includes('_LONG') ||
    text.includes('BULL_') ||
    text.includes('_BULL') ||
    text.includes('BUY_') ||
    text.includes('_BUY')
  ) {
    return 'LONG';
  }

  if (
    text.includes('MICRO_SHORT_') ||
    text.includes('TRADESIDE=SHORT') ||
    text.includes('TRADE_SIDE=SHORT') ||
    text.includes('SIDE=SHORT') ||
    text.includes('SIDE=BEAR') ||
    text.includes('DIRECTION=SHORT') ||
    text.includes('DIRECTION=BEAR') ||
    text.includes('SIDE=SELL') ||
    text.includes('DIRECTION=SELL') ||
    text.includes('SHORT_') ||
    text.includes('_SHORT') ||
    text.includes('BEAR_') ||
    text.includes('_BEAR') ||
    text.includes('SELL_') ||
    text.includes('_SELL')
  ) {
    return 'SHORT';
  }

  return 'UNKNOWN';
}

function inferActionTradeSide(row = {}) {
  if (typeof row === 'string') {
    return inferTradeSideFromText(row);
  }

  const direct = normalizeTradeSide(
    row.tradeSide ||
    row.side ||
    row.positionSide ||
    row.direction ||
    row.scannerSide ||
    row.analysisSide
  );

  if (direct !== 'UNKNOWN') return direct;

  const haystack = [
    row.familyId,
    row.family,
    row.baseFamilyId,

    row.microFamilyId,
    row.trueMicroFamilyId,
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
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : [])
  ]
    .map((value) => String(value || '').toUpperCase())
    .filter(Boolean)
    .join('|');

  return inferTradeSideFromText(haystack);
}

function isLongAction(row = {}) {
  return inferActionTradeSide(row) === TARGET_TRADE_SIDE;
}

function isShortAction(row = {}) {
  return inferActionTradeSide(row) === 'SHORT';
}

function forceLongAction(row = {}) {
  return {
    ...row,
    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    targetTradeSide: TARGET_TRADE_SIDE,
    longOnly: true,
    shortDisabled: true
  };
}

function countActionsByType(actions = []) {
  return actions.reduce((acc, row) => {
    const key = row?.action || row?.type || 'UNKNOWN';
    acc[key] = (acc[key] || 0) + 1;

    return acc;
  }, {});
}

function responseActionCounts(lockResult) {
  const payload = unwrapLockResult(lockResult);

  const rawActions = Array.isArray(payload?.actions)
    ? payload.actions
    : [];

  const longActions = rawActions
    .filter(isLongAction)
    .map(forceLongAction);

  const targetCounts = longActions.length > 0
    ? countActionsByType(longActions)
    : payload?.actionCounts || {};

  return {
    ...targetCounts,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    longOnly: true,
    shortDisabled: true
  };
}

function responseCounts(lockResult) {
  const payload = unwrapLockResult(lockResult);

  const actions = Array.isArray(payload?.actions)
    ? payload.actions
    : [];

  const longActions = actions.filter(isLongAction);
  const shortActions = actions.filter(isShortAction);
  const unknownActions = actions.filter((row) => inferActionTradeSide(row) === 'UNKNOWN');

  const realExits = Array.isArray(payload?.realExits)
    ? payload.realExits
    : [];

  const shadowExits = Array.isArray(payload?.shadowExits)
    ? payload.shadowExits
    : [];

  const longRealExits = realExits.filter(isLongAction);
  const longShadowExits = shadowExits.filter(isLongAction);

  return {
    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    longOnly: true,
    shortDisabled: true,

    candidates: Number(payload?.candidates || 0),
    liveRows: Number(payload?.liveRows || 0),

    actions: actions.length || Number(payload?.actionsCount || 0),
    longActions: longActions.length,
    shortActionsBlockedOrIgnored: shortActions.length,
    unknownSideActionsIgnored: unknownActions.length,

    entries: longActions.filter((row) => row?.action === 'ENTRY').length,
    waits: longActions.filter((row) => row?.action === 'WAIT').length,

    realExits: longRealExits.length || Number(payload?.realExitsCount || 0),
    shadowExits: longShadowExits.length || Number(payload?.shadowExitsCount || 0),

    shortRealExitsIgnored: realExits.filter(isShortAction).length,
    shortShadowExitsIgnored: shadowExits.filter(isShortAction).length,

    activeMicroFamilies: Number(payload?.activeMicroFamilies || 0),
    activeMacroFamilies: Number(payload?.activeMacroFamilies || 0)
  };
}

function sanitizeRunPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;

  const actions = Array.isArray(payload.actions)
    ? payload.actions.filter(isLongAction).map(forceLongAction)
    : payload.actions;

  const realExits = Array.isArray(payload.realExits)
    ? payload.realExits.filter(isLongAction).map(forceLongAction)
    : payload.realExits;

  const shadowExits = Array.isArray(payload.shadowExits)
    ? payload.shadowExits.filter(isLongAction).map(forceLongAction)
    : payload.shadowExits;

  return {
    ...payload,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    longOnly: true,
    shortDisabled: true,

    shortOnly: false,
    longDisabled: false,

    actions,
    realExits,
    shadowExits,

    actionsCount: Array.isArray(actions) ? actions.length : payload.actionsCount,
    realExitsCount: Array.isArray(realExits) ? realExits.length : payload.realExitsCount,
    shadowExitsCount: Array.isArray(shadowExits) ? shadowExits.length : payload.shadowExitsCount
  };
}

function resolveStatus(error) {
  if (Number.isFinite(error?.statusCode)) {
    return error.statusCode;
  }

  if (
    error?.reason === 'LOCK_NOT_ACQUIRED' ||
    error?.message === 'LOCK_NOT_ACQUIRED' ||
    error?.message?.includes?.('LOCK')
  ) {
    return 409;
  }

  return 500;
}

function buildRunOptions(req, body = {}) {
  return {
    forceProcessSnapshot: shouldForceProcessSnapshot(req, body),

    targetTradeSide: TARGET_TRADE_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    side: TARGET_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,
    disableShort: true
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Trade-Target-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Short-Disabled', 'true');

  const startedAt = Date.now();

  try {
    if (!isAllowedMethod(req.method)) {
      return methodNotAllowed(res);
    }

    const body = await readBody(req);
    const runOptions = buildRunOptions(req, body);

    const redis = getDurableRedis();
    const lockKey = KEYS.trade?.lock || 'TRADE:LOCK';
    const lockTtlSec = getLockTtlSec();

    const result = await withRedisLock(
      redis,
      lockKey,
      lockTtlSec,
      async () => runTradeSystem(runOptions)
    );

    const payload = sanitizeRunPayload(unwrapLockResult(result));

    return res.status(200).json({
      ok: responseOk(result),
      skipped: responseSkipped(result),
      reason: responseReason(result),

      source: getRunSource(req, body),

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      longOnly: true,
      shortDisabled: true,

      forceProcessSnapshot: runOptions.forceProcessSnapshot,

      runId: responseRunId(result),
      snapshotId: responseSnapshotId(result),

      actionCounts: responseActionCounts(result),
      counts: responseCounts(result),

      activeRotationId: payload?.activeRotationId || null,
      activeMicroFamilies: Number(payload?.activeMicroFamilies || 0),
      activeMacroFamilies: Number(payload?.activeMacroFamilies || 0),

      durationMs: Date.now() - startedAt,

      run: payload,
      result
    });
  } catch (error) {
    return res.status(resolveStatus(error)).json({
      ok: false,

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      longOnly: true,
      shortDisabled: true,

      error: error?.message || String(error),
      durationMs: Date.now() - startedAt,
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}