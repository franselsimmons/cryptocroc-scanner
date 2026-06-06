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

const LOCK_TTL_SEC = 300;

const LOCK_KEYS = {
  admin: 'ADMIN:FACTORY_RESET:LONG:LOCK',
  scanner: KEYS.scan?.lock || 'SCAN:LONG:LOCK',
  trade: KEYS.trade?.lock || 'TRADE:LONG:LOCK',
  freeze: KEYS.analyze?.freezeLock || 'ANALYZE:LONG:WEEKLY_FREEZE_LOCK',
  activate: KEYS.analyze?.activateLock || 'ANALYZE:LONG:ROTATION_ACTIVATE_LOCK'
};

function methodNotAllowed(res) {
  res.setHeader('Allow', 'POST');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['POST'],

    targetTradeSide: TARGET_TRADE_SIDE,
    longOnly: true,
    shortDisabled: true
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
    if (typeof req.body === 'string') return parseJson(req.body.trim());
    if (Buffer.isBuffer(req.body)) return parseJson(req.body.toString('utf8').trim());

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

function isConfirmed(body, requiredText) {
  return (
    body.confirm === requiredText ||
    body.confirmed === requiredText
  );
}

async function delKey(redis, key) {
  if (!key) return 0;

  return redis.del(key);
}

async function acquireLock(redis, key, token) {
  const acquired = await redis.set(key, token, {
    nx: true,
    ex: LOCK_TTL_SEC
  });

  return Boolean(acquired);
}

async function releaseLock(redis, key, token) {
  try {
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

async function releaseResetLocks(acquired, token) {
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

async function runDeleteSteps({
  durable,
  volatile
}) {
  const deleted = {};

  // Scanner volatile data.
  deleted.scanSnapshots = await delPattern(
    volatile,
    'SCAN:SNAPSHOT:*',
    10000
  );

  deleted.scanLatest = await delKey(
    volatile,
    KEYS.scan?.latest
  );

  // Trade durable data.
  deleted.tradeOpen = await delPattern(
    durable,
    'TRADE:OPEN:*',
    10000
  );

  deleted.tradeLastProcessed = await delKey(
    durable,
    KEYS.trade?.lastProcessedSnapshot
  );

  deleted.tradeMeta = await delKey(
    durable,
    KEYS.trade?.runMeta
  );

  // Circuit breakers / optional future safety state.
  deleted.circuitPaused = await delPattern(
    durable,
    'CIRCUIT:PAUSED:*',
    10000
  );

  // Analyze learning data.
  deleted.analyzeWeeks = await delPattern(
    durable,
    'ANALYZE:WEEK:*',
    10000
  );

  deleted.analyzeMicros = await delPattern(
    durable,
    'ANALYZE:MICRO:*',
    10000
  );

  deleted.analyzeObsLast = await delPattern(
    durable,
    'ANALYZE:OBS:LAST:*',
    10000
  );

  deleted.analyzeShadow = await delPattern(
    durable,
    'ANALYZE:SHADOW:*',
    10000
  );

  // Rotation.
  deleted.activeRotation = await delKey(
    durable,
    KEYS.analyze?.activeRotation
  );

  deleted.nextRotation = await delKey(
    durable,
    KEYS.analyze?.nextRotation
  );

  deleted.rotationValidFrom = await delKey(
    durable,
    KEYS.analyze?.rotationValidFrom
  );

  // Volatile live cache.
  deleted.liveCache = await delPattern(
    volatile,
    'LIVE:CACHE:*',
    10000
  );

  return deleted;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Factory-Reset-Mode', 'long-only');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Short-Disabled', 'true');

  const token = randomUUID();
  let acquiredLocks = [];

  try {
    if (req.method !== 'POST') {
      return methodNotAllowed(res);
    }

    const body = await readBody(req);

    const requiredConfirmText =
      CONFIG.reset?.confirmText || 'FACTORY_RESET_CONFIRMED';

    const confirmed = isConfirmed(body, requiredConfirmText);

    const force =
      isTrue(body.force) ||
      isTrue(body.forceClosePositions);

    if (!confirmed) {
      return res.status(400).json({
        ok: false,
        blocked: true,
        reason: 'CONFIRMATION_REQUIRED',
        required: requiredConfirmText,

        targetTradeSide: TARGET_TRADE_SIDE,
        targetDashboardSide: TARGET_DASHBOARD_SIDE,
        longOnly: true,
        shortDisabled: true
      });
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

      return res.status(409).json({
        ok: false,
        blocked: true,
        reason: lockResult.reason,
        released,

        targetTradeSide: TARGET_TRADE_SIDE,
        targetDashboardSide: TARGET_DASHBOARD_SIDE,
        longOnly: true,
        shortDisabled: true
      });
    }

    const openPositions = await getOpenPositions();

    if (openPositions.length > 0 && !force) {
      return res.status(409).json({
        ok: false,
        blocked: true,
        reason: 'OPEN_LONG_POSITIONS_EXIST',
        count: openPositions.length,
        symbols: openPositionSymbols(openPositions),

        targetTradeSide: TARGET_TRADE_SIDE,
        targetDashboardSide: TARGET_DASHBOARD_SIDE,
        longOnly: true,
        shortDisabled: true
      });
    }

    const deleted = await runDeleteSteps({
      durable,
      volatile
    });

    const report = {
      ok: true,
      type: 'LONG_FACTORY_RESET',

      targetTradeSide: TARGET_TRADE_SIDE,
      targetDashboardSide: TARGET_DASHBOARD_SIDE,
      longOnly: true,
      shortDisabled: true,

      force,

      openPositionsCount: openPositions.length,
      openPositionSymbols: openPositionSymbols(openPositions),

      deleted,

      preserved: {
        resetLogs: true,
        discordLogs: true
      },

      resetAt: Date.now()
    };

    await pushJsonLog(
      durable,
      KEYS.reset?.logList || 'RESET:LOGS',
      report,
      100
    );

    await sendResetReport(report).catch(() => null);

    return res.status(200).json(report);
  } catch (error) {
    const status = error.statusCode || 500;

    return res.status(status).json({
      ok: false,

      targetTradeSide: TARGET_TRADE_SIDE,
      targetDashboardSide: TARGET_DASHBOARD_SIDE,
      longOnly: true,
      shortDisabled: true,

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