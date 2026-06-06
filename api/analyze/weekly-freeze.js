// ================= FILE: api/analyze/weekly-freeze.js =================

import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import { getDurableRedis } from '../../src/redis.js';
import { withRedisLock } from '../../src/lock.js';
import {
  getIsoWeekKey,
  getNextIsoWeekKey
} from '../../src/utils.js';
import { freezeWeeklyRotation } from '../../src/analyze/rotationEngine.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';

function now() {
  return Date.now();
}

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

  const text = Buffer.concat(chunks).toString('utf8');

  return parseJson(text);
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

function firstValue(value) {
  if (Array.isArray(value)) return value[0];

  return value;
}

function query(req = {}) {
  return req.query || {};
}

function getParam(req, body, key, fallback = undefined) {
  const q = query(req);

  const bodyValue = firstValue(body?.[key]);
  const queryValue = firstValue(q?.[key]);

  if (bodyValue !== undefined && bodyValue !== null && bodyValue !== '') {
    return bodyValue;
  }

  if (queryValue !== undefined && queryValue !== null && queryValue !== '') {
    return queryValue;
  }

  return fallback;
}

function getFreezeLockTtlSec() {
  const ttl = Number(CONFIG.analyze?.freezeLockTtlSec || 600);

  return Number.isFinite(ttl) && ttl > 0
    ? Math.floor(ttl)
    : 600;
}

function getRotationMode(req, body = {}) {
  return String(
    getParam(
      req,
      body,
      'mode',
      CONFIG.rotation?.mode || 'balanced'
    ) || 'balanced'
  ).trim();
}

function getWeekKey(req, body = {}) {
  return String(
    getParam(
      req,
      body,
      'weekKey',
      getIsoWeekKey()
    ) || getIsoWeekKey()
  ).trim();
}

function getActiveWeekKey(req, body = {}) {
  const explicit =
    getParam(req, body, 'activeWeekKey', null) ||
    getParam(req, body, 'nextWeekKey', null);

  if (explicit) {
    return String(explicit).trim();
  }

  return getNextIsoWeekKey();
}

function isManualRun(req, body = {}) {
  return (
    isTrue(getParam(req, body, 'force', false)) ||
    isTrue(getParam(req, body, 'manual', false)) ||
    Boolean(getParam(req, body, 'weekKey', null)) ||
    Boolean(getParam(req, body, 'activeWeekKey', null)) ||
    Boolean(getParam(req, body, 'nextWeekKey', null)) ||
    Boolean(getParam(req, body, 'mode', null))
  );
}

function unwrapLockResult(lockResult) {
  if (
    lockResult &&
    typeof lockResult === 'object' &&
    Object.prototype.hasOwnProperty.call(lockResult, 'result')
  ) {
    return lockResult.result;
  }

  return lockResult || null;
}

function payloadOk(lockResult, payload) {
  if (lockResult?.ok === false) return false;
  if (payload?.ok === false) return false;

  return true;
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

function inferRowTradeSide(row = {}) {
  if (typeof row === 'string') {
    return inferTradeSideFromText(row);
  }

  const direct = normalizeTradeSide(
    row.tradeSide ||
    row.side ||
    row.positionSide ||
    row.direction ||
    row.signalSide ||
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

function isTargetRow(row = {}) {
  return inferRowTradeSide(row) === TARGET_TRADE_SIDE;
}

function rotationFromPayload(payload = {}) {
  return (
    payload?.rotation ||
    payload?.nextRotation ||
    payload?.activeRotation ||
    payload ||
    {}
  );
}

function targetRotationRows(payload = {}) {
  const rotation = rotationFromPayload(payload);
  const rows = Array.isArray(rotation?.microFamilies)
    ? rotation.microFamilies
    : [];

  return rows.filter(isTargetRow);
}

function responseWeekKey(payload, fallbackWeekKey = null) {
  return (
    payload?.weekKey ||
    payload?.rotation?.sourceWeekKey ||
    fallbackWeekKey ||
    null
  );
}

function responseActiveWeekKey(payload, fallbackActiveWeekKey = null) {
  return (
    payload?.activeWeekKey ||
    payload?.rotation?.activeWeekKey ||
    fallbackActiveWeekKey ||
    null
  );
}

function responseRotationId(payload) {
  return (
    payload?.rotationId ||
    payload?.rotation?.rotationId ||
    null
  );
}

function responseMicroFamilyIds(payload) {
  const rotation = rotationFromPayload(payload);
  const rows = targetRotationRows(payload);

  if (rows.length > 0) {
    return rows
      .map((row) => row.microFamilyId || row.trueMicroFamilyId || row.id || row.key)
      .filter(Boolean);
  }

  const ids = Array.isArray(rotation?.microFamilyIds)
    ? rotation.microFamilyIds
    : [];

  return ids.filter((id) => inferRowTradeSide(id) === TARGET_TRADE_SIDE);
}

function responseMacroFamilyIds(payload) {
  const rotation = rotationFromPayload(payload);
  const rows = targetRotationRows(payload);

  if (rows.length > 0) {
    return [...new Set(
      rows
        .map((row) => (
          row.parentMacroFamilyId ||
          row.parentMicroFamilyId ||
          row.macroFamilyId ||
          row.familyId
        ))
        .filter(Boolean)
    )];
  }

  const ids = Array.isArray(rotation?.macroFamilyIds)
    ? rotation.macroFamilyIds
    : [];

  return ids.filter((id) => inferRowTradeSide(id) === TARGET_TRADE_SIDE);
}

function responseSelectedCount(payload) {
  return responseMicroFamilyIds(payload).length;
}

function responseEligibleCount(payload) {
  return (
    payload?.rotation?.longEligibleCount ||
    payload?.rotation?.eligibleLongCount ||
    payload?.rotation?.eligibleCount ||
    0
  );
}

function responseRankedCount(payload) {
  return (
    payload?.rotation?.longRankedCount ||
    payload?.rotation?.rankedLongCount ||
    payload?.rotation?.rankedCount ||
    0
  );
}

function responseEmptyReason(payload) {
  return (
    payload?.rotation?.emptyReason ||
    payload?.emptyReason ||
    payload?.reason ||
    null
  );
}

function errorStatus(error) {
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

async function runFreeze({
  req,
  body
}) {
  const weekKey = getWeekKey(req, body);
  const activeWeekKey = getActiveWeekKey(req, body);
  const mode = getRotationMode(req, body);

  return freezeWeeklyRotation({
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
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Rotation-Target-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Short-Disabled', 'true');

  const startedAt = now();

  try {
    if (!isAllowedMethod(req.method)) {
      return methodNotAllowed(res);
    }

    const body = await readBody(req);

    const redis = getDurableRedis();
    const lockKey = KEYS.analyze?.freezeLock || 'ANALYZE:WEEKLY_FREEZE_LOCK';
    const lockTtlSec = getFreezeLockTtlSec();

    const weekKey = getWeekKey(req, body);
    const activeWeekKey = getActiveWeekKey(req, body);
    const mode = getRotationMode(req, body);

    const lockResult = await withRedisLock(
      redis,
      lockKey,
      lockTtlSec,
      async () => runFreeze({
        req,
        body
      })
    );

    const payload = unwrapLockResult(lockResult);
    const microFamilyIds = responseMicroFamilyIds(payload);
    const macroFamilyIds = responseMacroFamilyIds(payload);

    return res.status(200).json({
      ok: payloadOk(lockResult, payload),
      skipped: Boolean(lockResult?.skipped || payload?.skipped),

      source: isManualRun(req, body)
        ? 'ADMIN_MANUAL_FREEZE'
        : 'CRON_OR_API_FREEZE',

      type: payload?.type || 'NEXT_ROTATION_READY',

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      longOnly: true,
      shortDisabled: true,

      weekKey: responseWeekKey(payload, weekKey),
      activeWeekKey: responseActiveWeekKey(payload, activeWeekKey),
      mode,

      rotationId: responseRotationId(payload),

      selectedMicroFamilies: responseSelectedCount(payload),
      selectedMacroFamilies: macroFamilyIds.length,

      eligibleCount: responseEligibleCount(payload),
      rankedCount: responseRankedCount(payload),

      empty: microFamilyIds.length === 0 || Boolean(payload?.rotation?.empty),
      emptyReason: responseEmptyReason(payload),

      microFamilyIds,
      macroFamilyIds,

      durationMs: now() - startedAt,

      result: payload,
      lock: {
        ok: lockResult?.ok !== false,
        skipped: Boolean(lockResult?.skipped),
        reason: lockResult?.reason || null
      }
    });
  } catch (error) {
    return res.status(errorStatus(error)).json({
      ok: false,

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      longOnly: true,
      shortDisabled: true,

      error: error?.message || String(error),
      durationMs: now() - startedAt,
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}