// ================= FILE: api/analyze/activate-rotation.js =================

import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import { getDurableRedis, setJson } from '../../src/redis.js';
import { withRedisLock } from '../../src/lock.js';
import { getIsoWeekKey } from '../../src/utils.js';
import {
  activateNextRotation,
  activateSelectedMicroFamilies,
  buildRotationFromWeek
} from '../../src/analyze/rotationEngine.js';

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

function query(req = {}) {
  return req.query || {};
}

function getParam(req, body, key, fallback = undefined) {
  const q = query(req);

  if (body?.[key] !== undefined) return body[key];
  if (q?.[key] !== undefined) return q[key];

  return fallback;
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function parseIdList(value) {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item?.microFamilyId) return item.microFamilyId;
        if (item?.id) return item.id;

        return '';
      })
      .filter(Boolean);
  }

  if (typeof value === 'string') {
    return value
      .split(/[\s,;\n\r]+/g)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  if (typeof value === 'object') {
    return parseIdList(
      value.microFamilyIds ||
      value.ids ||
      value.activeMicroFamilyIds ||
      []
    );
  }

  return [];
}

function extractMicroFamilyIds(req, body = {}) {
  const q = query(req);

  return uniqueStrings([
    ...parseIdList(body.microFamilyIds),
    ...parseIdList(body.ids),
    ...parseIdList(body.activeMicroFamilyIds),
    ...parseIdList(q.microFamilyIds),
    ...parseIdList(q.ids),
    ...parseIdList(q.activeMicroFamilyIds)
  ]);
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
    text.startsWith('LONG_') ||
    text.includes('_LONG_') ||
    text.endsWith('_LONG') ||
    text.startsWith('BULL_') ||
    text.includes('_BULL_') ||
    text.endsWith('_BULL')
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
    text.startsWith('SHORT_') ||
    text.includes('_SHORT_') ||
    text.endsWith('_SHORT') ||
    text.startsWith('BEAR_') ||
    text.includes('_BEAR_') ||
    text.endsWith('_BEAR')
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

  const values = [
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
  ];

  for (const value of values) {
    const side = inferTradeSideFromText(value);

    if (side !== 'UNKNOWN') return side;
  }

  return 'UNKNOWN';
}

function isTargetSideRow(row = {}) {
  return inferRowTradeSide(row) === TARGET_TRADE_SIDE;
}

function filterTargetIds(ids = []) {
  return uniqueStrings(ids).filter((id) => (
    inferRowTradeSide(id) === TARGET_TRADE_SIDE
  ));
}

function getActivateLockTtlSec() {
  const ttl = Number(CONFIG.analyze?.activateLockTtlSec || 600);

  return Number.isFinite(ttl) && ttl > 0
    ? Math.floor(ttl)
    : 600;
}

function getMode(req, body = {}) {
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

function getActiveWeekKey(req, body = {}, fallbackWeekKey) {
  return String(
    getParam(
      req,
      body,
      'activeWeekKey',
      fallbackWeekKey || getIsoWeekKey()
    ) || fallbackWeekKey || getIsoWeekKey()
  ).trim();
}

function isManualRun(req, body = {}, ids = []) {
  return (
    ids.length > 0 ||
    isTrue(getParam(req, body, 'manual', false)) ||
    isTrue(getParam(req, body, 'force', false)) ||
    isTrue(getParam(req, body, 'activateBest', false))
  );
}

function shouldBuildFreshRotation(req, body = {}, ids = []) {
  if (ids.length > 0) return false;

  return (
    isTrue(getParam(req, body, 'build', false)) ||
    isTrue(getParam(req, body, 'force', false)) ||
    isTrue(getParam(req, body, 'activateBest', false))
  );
}

function shouldAutoBuildIfMissing(req, body = {}) {
  return isTrue(getParam(req, body, 'autoBuildIfMissing', false));
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
  const microFamilyIds = uniqueStrings(
    microFamilies.map((row) => row.microFamilyId || row.trueMicroFamilyId || row.id)
  );

  const macroFamilyIds = uniqueStrings(
    microFamilies.map(parentMacroFamilyId)
  );

  const microToMacroFamilyId = {};
  const macroToMicroFamilyIds = {};

  for (const row of microFamilies) {
    const microId = String(row.microFamilyId || row.trueMicroFamilyId || row.id || '').trim();
    const macroId = parentMacroFamilyId(row);

    if (!microId || !macroId) continue;

    microToMacroFamilyId[microId] = macroId;

    if (!macroToMicroFamilyIds[macroId]) {
      macroToMicroFamilyIds[macroId] = [];
    }

    macroToMicroFamilyIds[macroId].push(microId);
  }

  for (const macroId of Object.keys(macroToMicroFamilyIds)) {
    macroToMicroFamilyIds[macroId] = uniqueStrings(macroToMicroFamilyIds[macroId]);
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
  return rows.find(isTargetSideRow) || rows[0] || null;
}

function sanitizeRankingRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .filter(isTargetSideRow)
    .map((row, index) => ({
      ...row,
      rank: index + 1,
      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE
    }));
}

function sanitizeRankings(rankings = {}) {
  if (!rankings || typeof rankings !== 'object') return {};

  return Object.fromEntries(
    Object.entries(rankings).map(([mode, rows]) => [
      mode,
      sanitizeRankingRows(rows)
    ])
  );
}

function sanitizeRotationForLongOnly(rotation = {}, source = null) {
  const originalRows = Array.isArray(rotation?.microFamilies)
    ? rotation.microFamilies
    : [];

  const microFamilies = originalRows
    .filter(isTargetSideRow)
    .map((row, index) => ({
      ...row,
      rank: index + 1,
      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE
    }));

  const indexes = buildSelectionIndexes(microFamilies);
  const empty = microFamilies.length === 0;

  return {
    ...rotation,

    source: source || rotation.source || null,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    longOnly: true,
    shortDisabled: true,

    trueMicroOnly: true,
    usedLegacyFallback: false,

    bestLong: bestLong(microFamilies),
    bestShort: null,

    missingSides: empty ? [TARGET_TRADE_SIDE] : [],

    empty,
    emptyReason: empty
      ? rotation.emptyReason || 'NO_LONG_MICRO_FAMILIES_AVAILABLE_FOR_ROTATION'
      : null,

    ...indexes,

    microFamilies,

    rankings: sanitizeRankings(rotation.rankings),
    macroRankings: sanitizeRankings(rotation.macroRankings),
    allRankings: sanitizeRankings(rotation.allRankings)
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

function responseRotationId(payload) {
  return (
    payload?.activeRotation?.rotationId ||
    payload?.active?.rotationId ||
    payload?.rotationId ||
    payload?.builtRotation?.rotationId ||
    null
  );
}

function responseActivatedCount(payload) {
  return (
    payload?.activatedCount ||
    payload?.activeRotation?.microFamilyIds?.length ||
    payload?.active?.microFamilyIds?.length ||
    payload?.microFamilyIds?.length ||
    0
  );
}

function responseReason(lockResult, payload) {
  return (
    lockResult?.reason ||
    payload?.reason ||
    payload?.emptyReason ||
    payload?.activeRotation?.emptyReason ||
    null
  );
}

function lockOk(lockResult, payload) {
  if (lockResult?.ok === false) return false;
  if (payload?.ok === false) return false;

  return true;
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

async function buildFreshRotationAndActivate({
  redis,
  weekKey,
  activeWeekKey,
  mode
}) {
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
    'ANALYZE_WEEKLY_RANKING_LONG_ONLY'
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
      validFrom: 'IMMEDIATE_ADMIN_ACTIVATION',
      ts: now(),
      sourceWeekKey: weekKey,
      activeWeekKey,
      rotationId: builtRotation.rotationId,
      mode,

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
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
    'ANALYZE_NEXT_ROTATION_ACTIVATED_LONG_ONLY'
  );

  return {
    ok: activated?.ok !== false,
    type: 'BUILT_AND_ACTIVATED_ROTATION',

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    longOnly: true,
    shortDisabled: true,

    weekKey,
    activeWeekKey,
    mode,

    rotationId:
      activeRotation.rotationId ||
      activated?.rotationId ||
      builtRotation.rotationId,

    activatedCount: activeRotation.microFamilyIds?.length || 0,

    builtRotation,
    activeRotation,
    reason: activeRotation.emptyReason || activated?.reason || null,

    result: activated
  };
}

async function activateManualSelection({
  redis,
  microFamilyIds,
  requestedMicroFamilyIds,
  weekKey,
  mode
}) {
  const activeRotationRaw = await activateSelectedMicroFamilies({
    microFamilyIds,
    weekKey,
    mode,

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
    'ADMIN_MANUAL_SELECTION_LONG_ONLY'
  );

  const ignoredShortOrUnknownIds = uniqueStrings(requestedMicroFamilyIds)
    .filter((id) => !microFamilyIds.includes(id));

  return {
    ok: true,
    type: 'MANUAL_MICRO_FAMILY_ROTATION_ACTIVATED',

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    longOnly: true,
    shortDisabled: true,

    weekKey,
    activeWeekKey: activeRotation.activeWeekKey || getIsoWeekKey(),
    mode,

    rotationId: activeRotation.rotationId,
    activatedCount: activeRotation.microFamilyIds?.length || 0,

    requestedMicroFamilyIds,
    acceptedMicroFamilyIds: microFamilyIds,
    ignoredShortOrUnknownIds,

    activeRotation,
    reason: activeRotation.emptyReason || null
  };
}

async function activateExistingNextRotation({
  redis,
  weekKey,
  activeWeekKey,
  mode,
  autoBuildIfMissing
}) {
  const activated = await activateNextRotation();

  if (
    activated?.ok === false &&
    activated?.reason === 'NEXT_ROTATION_MISSING' &&
    autoBuildIfMissing
  ) {
    return buildFreshRotationAndActivate({
      redis,
      weekKey,
      activeWeekKey,
      mode
    });
  }

  const activeRotation = activated?.activeRotation
    ? await persistActiveLongRotation(
      redis,
      activated.activeRotation,
      'NEXT_ROTATION_ACTIVATED_LONG_ONLY'
    )
    : null;

  return {
    ok: activated?.ok !== false,
    type: 'NEXT_ROTATION_ACTIVATED',

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    longOnly: true,
    shortDisabled: true,

    weekKey,
    activeWeekKey,
    mode,

    rotationId:
      activeRotation?.rotationId ||
      activated?.rotationId ||
      null,

    activatedCount: activeRotation?.microFamilyIds?.length || 0,

    activeRotation,
    reason: activeRotation?.emptyReason || activated?.reason || null,

    result: activated
  };
}

async function runActivation({
  req,
  body,
  redis
}) {
  const requestedMicroFamilyIds = extractMicroFamilyIds(req, body);
  const microFamilyIds = filterTargetIds(requestedMicroFamilyIds);

  const weekKey = getWeekKey(req, body);
  const activeWeekKey = getActiveWeekKey(req, body, weekKey);
  const mode = getMode(req, body);

  if (requestedMicroFamilyIds.length > 0) {
    return activateManualSelection({
      redis,
      microFamilyIds,
      requestedMicroFamilyIds,
      weekKey,
      mode: mode || 'manual'
    });
  }

  if (shouldBuildFreshRotation(req, body, microFamilyIds)) {
    return buildFreshRotationAndActivate({
      redis,
      weekKey,
      activeWeekKey,
      mode
    });
  }

  return activateExistingNextRotation({
    redis,
    weekKey,
    activeWeekKey,
    mode,
    autoBuildIfMissing: shouldAutoBuildIfMissing(req, body)
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
    const lockKey = KEYS.analyze?.activateLock || 'ANALYZE:ROTATION_ACTIVATE_LOCK';
    const lockTtlSec = getActivateLockTtlSec();

    const requestedMicroFamilyIds = extractMicroFamilyIds(req, body);
    const acceptedLongMicroFamilyIds = filterTargetIds(requestedMicroFamilyIds);

    const lockResult = await withRedisLock(
      redis,
      lockKey,
      lockTtlSec,
      async () => runActivation({
        req,
        body,
        redis
      })
    );

    const payload = unwrapLockResult(lockResult);

    return res.status(200).json({
      ok: lockOk(lockResult, payload),
      skipped: Boolean(lockResult?.skipped || payload?.skipped),

      source: isManualRun(req, body, requestedMicroFamilyIds)
        ? 'ADMIN_MANUAL_ACTIVATE_ROTATION'
        : 'CRON_OR_API_ACTIVATE_ROTATION',

      type: payload?.type || null,

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      longOnly: true,
      shortDisabled: true,

      weekKey: payload?.weekKey || getWeekKey(req, body),
      activeWeekKey: payload?.activeWeekKey || null,
      mode: payload?.mode || getMode(req, body),

      rotationId: responseRotationId(payload),
      activatedCount: responseActivatedCount(payload),
      reason: responseReason(lockResult, payload),

      requestedMicroFamilyIds,
      acceptedLongMicroFamilyIds,

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