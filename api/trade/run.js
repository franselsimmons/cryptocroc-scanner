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
  if (value === true || value === 1) return true;

  const raw = String(value ?? '').trim().toLowerCase();

  return ['true', '1', 'yes', 'y', 'on', 'force'].includes(raw);
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
    isTrue(firstValue(req.query?.forced, false)) ||
    isTrue(firstValue(req.query?.forceProcessSnapshot, false)) ||
    isTrue(firstValue(req.query?.force_process_snapshot, false)) ||

    isTrue(body.force) ||
    isTrue(body.forced) ||
    isTrue(body.forceProcessSnapshot) ||
    isTrue(body.force_process_snapshot)
  );
}

function shouldMonitorOnly(req, body = {}) {
  return (
    isTrue(firstValue(req.query?.monitorOnly, false)) ||
    isTrue(firstValue(req.query?.monitor_only, false)) ||

    isTrue(body.monitorOnly) ||
    isTrue(body.monitor_only)
  );
}

function getRunSource(req, body = {}) {
  const manual = (
    isTrue(firstValue(req.query?.manual, false)) ||
    isTrue(firstValue(req.query?.force, false)) ||
    isTrue(firstValue(req.query?.forced, false)) ||
    isTrue(firstValue(req.query?.forceProcessSnapshot, false)) ||
    isTrue(firstValue(req.query?.force_process_snapshot, false)) ||

    isTrue(body.manual) ||
    isTrue(body.force) ||
    isTrue(body.forced) ||
    isTrue(body.forceProcessSnapshot) ||
    isTrue(body.force_process_snapshot)
  );

  return manual
    ? 'ADMIN_MANUAL_RUN'
    : 'CRON_OR_API_RUN';
}

function unwrapLockResult(lockResult) {
  if (!lockResult) return null;

  if (lockResult.result?.result) return lockResult.result.result;
  if (lockResult.result) return lockResult.result;

  return lockResult;
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
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : []),
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : [])
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
    dashboardSide: TARGET_DASHBOARD_SIDE,

    longOnly: true,
    shortDisabled: true,

    shortOnly: false,
    longDisabled: false
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

  if (rawActions.length > 0) {
    const longActions = rawActions
      .filter(isLongAction)
      .map(forceLongAction);

    return {
      ...countActionsByType(longActions),

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      longOnly: true,
      shortDisabled: true
    };
  }

  return {
    ...(payload?.actionCounts || {}),

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
    longCandidateCount: Number(payload?.longCandidateCount || 0),
    nonLongCandidateCount: Number(payload?.nonLongCandidateCount || 0),

    processed: Number(payload?.processed || 0),
    earlyActions: Number(payload?.earlyActions || 0),

    liveRows: Number(payload?.liveRows || 0),
    actualLiveRows: Number(payload?.actualLiveRows || 0),
    mirrorRows: Number(payload?.mirrorRows || 0),
    learningOnlyRows: Number(payload?.learningOnlyRows || 0),
    riskValidRows: Number(payload?.riskValidRows || 0),

    analyzedRowsRaw: Number(payload?.analyzedRowsRaw || 0),
    analyzedRows: Number(payload?.analyzedRows || 0),
    analyzedActualRows: Number(payload?.analyzedActualRows || 0),
    analyzedMirrorRows: Number(payload?.analyzedMirrorRows || 0),

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

  const actionCounts = Array.isArray(actions)
    ? countActionsByType(actions)
    : payload.actionCounts;

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
    actionCounts,

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
  const forceProcessSnapshot = shouldForceProcessSnapshot(req, body);
  const monitorOnly = shouldMonitorOnly(req, body);

  return {
    force: forceProcessSnapshot,
    forceProcessSnapshot,
    monitorOnly,

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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Trade-Target-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Dashboard-Side', TARGET_DASHBOARD_SIDE);
  res.setHeader('X-Long-Only', 'true');
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

      shortOnly: false,
      longDisabled: false,

      force: runOptions.force,
      forceProcessSnapshot: runOptions.forceProcessSnapshot,
      monitorOnly: runOptions.monitorOnly,

      runId: responseRunId(result),
      snapshotId: responseSnapshotId(result),

      actionCounts: responseActionCounts(result),
      counts: responseCounts(result),

      activeRotationId: payload?.activeRotationId || null,
      activeMicroFamilies: Number(payload?.activeMicroFamilies || 0),
      activeMacroFamilies: Number(payload?.activeMacroFamilies || 0),

      selectedSnapshotSource: payload?.selectedSnapshotSource || null,
      selectedSnapshotReason: payload?.selectedSnapshotReason || null,
      selectedTargetCandidateCount: Number(payload?.selectedTargetCandidateCount || 0),
      selectedOppositeCandidateCount: Number(payload?.selectedOppositeCandidateCount || 0),

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

      shortOnly: false,
      longDisabled: false,

      error: error?.message || String(error),
      durationMs: Date.now() - startedAt,
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}