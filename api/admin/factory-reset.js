// ================= FILE: api/admin/factory-reset.js =================

import { randomUUID } from 'node:crypto';

import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import {
  getDurableRedis,
  getVolatileRedis,
  delPattern,
  pushJsonLog
} from '../../src/redis.js';
import { getOpenPositions } from '../../src/trade/positionEngine.js';
import { sendResetReport } from '../../src/discord/discord.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

const LOCK_TTL_SEC = 300;
const DEFAULT_CONFIRM_TEXT = 'FACTORY_RESET_CONFIRMED';
const DEFAULT_ROTATION_CONFIRM_TEXT = 'RESET_ROTATION_CONFIRMED';

const LONG_KEYS = {
  scan: KEYS.long?.scan || KEYS.scanLong || KEYS.scan?.long || {},
  trade: KEYS.long?.trade || KEYS.tradeLong || KEYS.trade?.long || {},
  analyze: KEYS.long?.analyze || KEYS.analyzeLong || KEYS.analyze?.long || {},
  reset: KEYS.long?.reset || KEYS.resetLong || KEYS.reset?.long || {}
};

const LOCK_KEYS = {
  admin: 'LONG:ADMIN:FACTORY_RESET:LOCK',
  scanner: LONG_KEYS.scan?.lock || 'LONG:SCAN:LOCK',
  trade: LONG_KEYS.trade?.lock || 'LONG:TRADE:LOCK',
  freeze: LONG_KEYS.analyze?.freezeLock || 'LONG:ANALYZE:WEEKLY_FREEZE_LOCK',
  activate: LONG_KEYS.analyze?.activateLock || 'LONG:ANALYZE:ROTATION_ACTIVATE_LOCK'
};

const LONG_PATTERNS = {
  scanSnapshots: 'LONG:SCAN:SNAPSHOT:*',
  tradeOpenVirtualPositions: 'LONG:TRADE:OPEN:*',
  circuitPaused: 'LONG:CIRCUIT:PAUSED:*',
  analyzeWeeks: 'LONG:ANALYZE:WEEK:*',
  analyzeMicros: 'LONG:ANALYZE:MICRO:*',
  analyzeObsLast: 'LONG:ANALYZE:OBS:LAST:*',
  analyzeShadow: 'LONG:ANALYZE:SHADOW:*',
  analyzeOutcomeDedupe: 'LONG:ANALYZE:OUTCOME:*',
  liveCache: 'LONG:LIVE:CACHE:*',
  marketCache: 'LONG:MARKET:CACHE:*',
  bitgetCache: 'LONG:BITGET:CACHE:*'
};

function now() {
  return Date.now();
}

function modePayload() {
  return {
    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    virtualPositionsOnly: true,
    virtualLearning: true,
    virtualOnly: true,

    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,

    manualSelectionRequired: true,
    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForExactTrueMicroMatch: true,

    autoRotationActivationDisabled: true,
    manualRotationPreservedByDefault: true,
    explicitRotationResetRequired: true,

    redisNamespace: 'LONG',
    isolatedFromShortRoot: true
  };
}

function methodNotAllowed(res) {
  res.setHeader('Allow', 'POST');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['POST'],
    ...modePayload()
  });
}

function parseJson(text) {
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    const error = new Error('INVALID_JSON_BODY');
    error.statusCode = 400;
    throw error;
  }
}

async function readBody(req) {
  if (req.body) {
    if (typeof req.body === 'string') {
      return parseJson(req.body.trim());
    }

    if (Buffer.isBuffer(req.body)) {
      return parseJson(req.body.toString('utf8').trim());
    }

    return req.body;
  }

  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const text = Buffer.concat(chunks).toString('utf8').trim();

  return parseJson(text);
}

function isTrue(value) {
  if (value === true || value === 1) return true;

  const raw = String(value || '').trim().toLowerCase();

  return ['true', '1', 'yes', 'y', 'on'].includes(raw);
}

function isConfirmed(body = {}, requiredText) {
  return (
    body.confirm === requiredText ||
    body.confirmed === requiredText ||
    body.confirmation === requiredText
  );
}

function wantsRotationReset(body = {}) {
  return (
    isTrue(body.resetRotation) ||
    isTrue(body.resetManualSelection) ||
    isTrue(body.clearManualSelection) ||
    isTrue(body.wipeRotation)
  );
}

function isRotationResetConfirmed(body = {}, requiredText) {
  return (
    body.confirmRotation === requiredText ||
    body.rotationConfirm === requiredText ||
    body.rotationConfirmation === requiredText ||
    body.confirmResetRotation === requiredText
  );
}

function getLongKey(...candidates) {
  return candidates.find(Boolean) || null;
}

function getScanLatestKey() {
  return getLongKey(
    LONG_KEYS.scan?.latest,
    LONG_KEYS.scan?.latestSnapshot,
    'LONG:SCAN:LATEST'
  );
}

function getScanRunMetaKey() {
  return getLongKey(
    LONG_KEYS.scan?.runMeta,
    'LONG:SCAN:RUN_META'
  );
}

function getTradeLastProcessedKey() {
  return getLongKey(
    LONG_KEYS.trade?.lastProcessedSnapshot,
    'LONG:TRADE:LAST_PROCESSED_SNAPSHOT'
  );
}

function getTradeRunMetaKey() {
  return getLongKey(
    LONG_KEYS.trade?.runMeta,
    'LONG:TRADE:RUN_META'
  );
}

function getActiveRotationKey() {
  return getLongKey(
    LONG_KEYS.analyze?.activeRotation,
    'LONG:ANALYZE:ACTIVE_ROTATION'
  );
}

function getNextRotationKey() {
  return getLongKey(
    LONG_KEYS.analyze?.nextRotation,
    'LONG:ANALYZE:NEXT_ROTATION'
  );
}

function getRotationValidFromKey() {
  return getLongKey(
    LONG_KEYS.analyze?.rotationValidFrom,
    'LONG:ANALYZE:ROTATION_VALID_FROM'
  );
}

function getResetLogListKey() {
  return getLongKey(
    LONG_KEYS.reset?.logList,
    'LONG:RESET:LOGS'
  );
}

async function delKey(redis, key) {
  if (!redis || !key) return 0;

  return redis.del(key).catch(() => 0);
}

async function delPatternSafe(redis, pattern, count = 10000) {
  if (!redis || !pattern) return 0;

  return delPattern(redis, pattern, count).catch(() => 0);
}

async function acquireLock(redis, key, token) {
  if (!redis || !key || !token) return false;

  const acquired = await redis.set(key, token, {
    nx: true,
    ex: LOCK_TTL_SEC
  });

  return Boolean(acquired);
}

async function releaseLock(redis, key, token) {
  try {
    if (!redis || !key || !token) return false;

    const current = await redis.get(key);

    if (current !== token) return false;

    await redis.del(key);

    return true;
  } catch {
    return false;
  }
}

async function acquireOneLock({
  redis,
  key,
  token,
  reason,
  acquired
}) {
  const ok = await acquireLock(redis, key, token);

  if (!ok) {
    return {
      ok: false,
      reason,
      acquired
    };
  }

  acquired.push({
    redis,
    key
  });

  return {
    ok: true,
    acquired
  };
}

async function acquireResetLocks({
  durable,
  volatile,
  token
}) {
  const acquired = [];

  const steps = [
    {
      redis: durable,
      key: LOCK_KEYS.admin,
      reason: 'LONG_FACTORY_RESET_ALREADY_RUNNING'
    },
    {
      redis: volatile,
      key: LOCK_KEYS.scanner,
      reason: 'LONG_SCANNER_RUN_ACTIVE'
    },
    {
      redis: durable,
      key: LOCK_KEYS.trade,
      reason: 'LONG_TRADE_RUN_ACTIVE'
    },
    {
      redis: durable,
      key: LOCK_KEYS.freeze,
      reason: 'LONG_WEEKLY_FREEZE_ACTIVE'
    },
    {
      redis: durable,
      key: LOCK_KEYS.activate,
      reason: 'LONG_ROTATION_ACTIVATE_ACTIVE'
    }
  ];

  for (const step of steps) {
    const result = await acquireOneLock({
      redis: step.redis,
      key: step.key,
      token,
      reason: step.reason,
      acquired
    });

    if (!result.ok) return result;
  }

  return {
    ok: true,
    acquired
  };
}

async function releaseResetLocks(acquired = [], token) {
  const released = [];

  for (const lock of [...acquired].reverse()) {
    const ok = await releaseLock(lock.redis, lock.key, token);

    released.push({
      key: lock.key,
      released: ok
    });
  }

  return released;
}

function openPositionSymbols(openPositions = []) {
  return openPositions
    .map((position) => (
      position.symbol ||
      position.baseSymbol ||
      position.contractSymbol ||
      null
    ))
    .filter(Boolean);
}

function normalizeOpenPosition(position = {}) {
  const source = String(position.source || 'VIRTUAL').toUpperCase();

  return {
    tradeId: position.tradeId || null,

    symbol: position.symbol || position.baseSymbol || null,
    baseSymbol: position.baseSymbol || position.symbol || null,
    contractSymbol: position.contractSymbol || null,

    microFamilyId: position.microFamilyId || position.trueMicroFamilyId || null,
    trueMicroFamilyId: position.trueMicroFamilyId || position.microFamilyId || null,
    familyId: position.familyId || null,
    macroFamilyId:
      position.parentMacroFamilyId ||
      position.macroFamilyId ||
      position.parentMicroFamilyId ||
      null,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    source: source === 'VIRTUAL' ? 'VIRTUAL' : source,
    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: position.shadowOnly !== false,

    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,

    exchangeTouched: false,
    bitgetOrdersTouched: false,
    realOrdersTouched: false,

    openedAt: position.openedAt || position.createdAt || null,
    updatedAt: position.updatedAt || null
  };
}

async function runDeleteSteps({
  durable,
  volatile,
  resetRotation = false
}) {
  const deleted = {};
  const preserved = {};

  // Scanner volatile data: LONG namespace only.
  deleted.scanSnapshots = await delPatternSafe(
    volatile,
    LONG_PATTERNS.scanSnapshots,
    10000
  );

  deleted.scanLatest = await delKey(
    volatile,
    getScanLatestKey()
  );

  deleted.scanRunMeta = await delKey(
    volatile,
    getScanRunMetaKey()
  );

  // Trade durable data: LONG virtual open positions only.
  deleted.tradeOpenVirtualPositions = await delPatternSafe(
    durable,
    LONG_PATTERNS.tradeOpenVirtualPositions,
    10000
  );

  deleted.tradeLastProcessed = await delKey(
    durable,
    getTradeLastProcessedKey()
  );

  deleted.tradeMeta = await delKey(
    durable,
    getTradeRunMetaKey()
  );

  deleted.tradeLocks = 0;

  // Circuit breakers / optional safety state: LONG namespace only.
  deleted.circuitPaused = await delPatternSafe(
    durable,
    LONG_PATTERNS.circuitPaused,
    10000
  );

  // Analyze learning data: LONG namespace only.
  deleted.analyzeWeeks = await delPatternSafe(
    durable,
    LONG_PATTERNS.analyzeWeeks,
    10000
  );

  deleted.analyzeMicros = await delPatternSafe(
    durable,
    LONG_PATTERNS.analyzeMicros,
    10000
  );

  deleted.analyzeObsLast = await delPatternSafe(
    durable,
    LONG_PATTERNS.analyzeObsLast,
    10000
  );

  deleted.analyzeShadow = await delPatternSafe(
    durable,
    LONG_PATTERNS.analyzeShadow,
    10000
  );

  deleted.analyzeOutcomeDedupe = await delPatternSafe(
    durable,
    LONG_PATTERNS.analyzeOutcomeDedupe,
    10000
  );

  // Rotation policy:
  // - activeRotation = handmatige exacte trueMicroFamilyId selectie, standaard bewaren.
  // - nextRotation/validFrom = pending/legacy state, altijd verwijderen tegen auto-activatie.
  if (resetRotation) {
    deleted.activeRotation = await delKey(
      durable,
      getActiveRotationKey()
    );
  } else {
    deleted.activeRotation = 0;
    preserved.activeRotation = true;
  }

  deleted.nextRotation = await delKey(
    durable,
    getNextRotationKey()
  );

  deleted.rotationValidFrom = await delKey(
    durable,
    getRotationValidFromKey()
  );

  // Volatile live cache: LONG namespace only.
  deleted.liveCache = await delPatternSafe(
    volatile,
    LONG_PATTERNS.liveCache,
    10000
  );

  deleted.marketCache = await delPatternSafe(
    volatile,
    LONG_PATTERNS.marketCache,
    10000
  );

  deleted.bitgetCache = await delPatternSafe(
    volatile,
    LONG_PATTERNS.bitgetCache,
    10000
  );

  return {
    deleted,
    preserved
  };
}

function buildBlockedResponse({
  reason,
  extra = {}
} = {}) {
  return {
    ok: false,
    blocked: true,
    reason,

    ...modePayload(),

    ...extra
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Factory-Reset-Mode', 'long-only-virtual-learning-v1');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Short-Disabled', 'true');
  res.setHeader('X-Real-Orders-Disabled', 'true');
  res.setHeader('X-Bitget-Orders-Disabled', 'true');
  res.setHeader('X-Virtual-Positions-Only', 'true');
  res.setHeader('X-Manual-Rotation-Preserved-By-Default', 'true');
  res.setHeader('X-Redis-Namespace', 'LONG');

  const token = randomUUID();
  let acquiredLocks = [];

  try {
    if (req.method !== 'POST') {
      return methodNotAllowed(res);
    }

    const body = await readBody(req);

    const requiredConfirmText =
      CONFIG.reset?.confirmText || DEFAULT_CONFIRM_TEXT;

    const requiredRotationConfirmText =
      CONFIG.reset?.rotationConfirmText || DEFAULT_ROTATION_CONFIRM_TEXT;

    const confirmed = isConfirmed(body, requiredConfirmText);
    const resetRotation = wantsRotationReset(body);

    const forceDeleteVirtualPositions =
      isTrue(body.force) ||
      isTrue(body.forceDeleteVirtualPositions) ||
      isTrue(body.forceClosePositions);

    if (!confirmed) {
      return res.status(400).json(
        buildBlockedResponse({
          reason: 'CONFIRMATION_REQUIRED',
          extra: {
            required: requiredConfirmText
          }
        })
      );
    }

    if (resetRotation && !isRotationResetConfirmed(body, requiredRotationConfirmText)) {
      return res.status(400).json(
        buildBlockedResponse({
          reason: 'ROTATION_RESET_CONFIRMATION_REQUIRED',
          extra: {
            required: requiredRotationConfirmText,
            note: 'activeRotation bevat je handmatige LONG true micro-family selectie en wordt standaard bewaard.'
          }
        })
      );
    }

    const durable = getDurableRedis();
    const volatile = getVolatileRedis();

    const lockResult = await acquireResetLocks({
      durable,
      volatile,
      token
    });

    acquiredLocks = lockResult.acquired || [];

    if (!lockResult.ok) {
      const released = await releaseResetLocks(acquiredLocks, token);
      acquiredLocks = [];

      return res.status(409).json(
        buildBlockedResponse({
          reason: lockResult.reason,
          extra: {
            released
          }
        })
      );
    }

    const openPositions = await getOpenPositions();

    if (openPositions.length > 0 && !forceDeleteVirtualPositions) {
      return res.status(409).json(
        buildBlockedResponse({
          reason: 'OPEN_VIRTUAL_LONG_POSITIONS_EXIST',
          extra: {
            count: openPositions.length,
            symbols: openPositionSymbols(openPositions),
            openPositions: openPositions.map(normalizeOpenPosition),
            requiredForceFlag: 'forceDeleteVirtualPositions=true',
            deprecatedAcceptedForceFlag: 'forceClosePositions=true',
            exchangeTouched: false,
            bitgetOrdersTouched: false,
            realOrdersTouched: false
          }
        })
      );
    }

    const deleteResult = await runDeleteSteps({
      durable,
      volatile,
      resetRotation
    });

    const report = {
      ok: true,
      type: 'FACTORY_RESET',

      ...modePayload(),

      force: forceDeleteVirtualPositions,
      forceDeleteVirtualPositions,

      resetRotation,
      manualRotationPreserved: !resetRotation,
      pendingRotationStateCleared: true,

      exchangeTouched: false,
      bitgetOrdersTouched: false,
      realOrdersTouched: false,

      openPositionsCount: openPositions.length,
      openPositionSymbols: openPositionSymbols(openPositions),
      openPositions: openPositions.map(normalizeOpenPosition),

      deleted: deleteResult.deleted,

      preserved: {
        ...deleteResult.preserved,
        resetLogs: true,
        discordLogs: true,
        environmentVariables: true,
        deploymentConfig: true,
        activeRotation: !resetRotation
      },

      resetAt: now()
    };

    await pushJsonLog(
      durable,
      getResetLogListKey(),
      report,
      100
    ).catch(() => null);

    await sendResetReport(report).catch(() => null);

    return res.status(200).json(report);
  } catch (error) {
    const status = error.statusCode || 500;

    return res.status(status).json({
      ok: false,

      ...modePayload(),

      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  } finally {
    if (acquiredLocks.length > 0) {
      await releaseResetLocks(acquiredLocks, token);
    }
  }
}