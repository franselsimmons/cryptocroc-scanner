// ================= FILE: api/admin/reset-learning.js =================

import { randomUUID } from 'node:crypto';

import { KEYS } from '../../src/keys.js';
import {
  getIsoWeekKey,
  getPreviousIsoWeekKey
} from '../../src/utils.js';
import {
  getDurableRedis,
  pushJsonLog
} from '../../src/redis.js';
import { sendResetReport } from '../../src/discord/discord.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';

const CONFIRM_TEXT = 'RESET_LEARNING';
const LOCK_TTL_SEC = 180;

const LOCK_KEYS = {
  resetLearning: 'ADMIN:LONG:RESET_LEARNING:LOCK',
  trade: KEYS.trade?.lock || 'LONG:TRADE:LOCK',
  freeze: KEYS.analyze?.freezeLock || 'LONG:ANALYZE:WEEKLY_FREEZE_LOCK',
  activate: KEYS.analyze?.activateLock || 'LONG:ANALYZE:ROTATION_ACTIVATE_LOCK'
};

function methodNotAllowed(res) {
  res.setHeader('Allow', 'POST');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['POST'],

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
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

function isConfirmed(body) {
  return (
    body.confirm === CONFIRM_TEXT ||
    body.confirmed === CONFIRM_TEXT
  );
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

async function acquireOneLock({ redis, key, token, reason, acquired }) {
  const ok = await acquireLock(redis, key, token);

  if (!ok) {
    return {
      ok: false,
      reason,
      acquired
    };
  }

  acquired.push(key);

  return {
    ok: true,
    acquired
  };
}

async function acquireResetLearningLocks(redis, token) {
  const acquired = [];

  const steps = [
    {
      key: LOCK_KEYS.resetLearning,
      reason: 'LONG_RESET_LEARNING_ALREADY_RUNNING'
    },
    {
      key: LOCK_KEYS.trade,
      reason: 'LONG_TRADE_RUN_ACTIVE'
    },
    {
      key: LOCK_KEYS.freeze,
      reason: 'LONG_WEEKLY_FREEZE_ACTIVE'
    },
    {
      key: LOCK_KEYS.activate,
      reason: 'LONG_ROTATION_ACTIVATE_ACTIVE'
    }
  ];

  for (const step of steps) {
    const result = await acquireOneLock({
      redis,
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

async function releaseLocks(redis, keys, token) {
  const released = [];

  for (const key of [...keys].reverse()) {
    const ok = await releaseLock(redis, key, token);

    released.push({
      key,
      released: ok
    });
  }

  return released;
}

async function delKey(redis, key) {
  if (!key) return 0;

  return redis.del(key).catch(() => 0);
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function firstValue(value, fallback = null) {
  if (Array.isArray(value)) return value[0] ?? fallback;
  if (value === undefined || value === null || value === '') return fallback;

  return value;
}

function getWeekKeyCandidates(body = {}) {
  return uniqueStrings([
    getPreviousIsoWeekKey(),
    getIsoWeekKey(),
    firstValue(body.weekKey, null),
    firstValue(body.currentWeekKey, null),
    firstValue(body.previousWeekKey, null),
    ...(Array.isArray(body.weekKeys) ? body.weekKeys : [])
  ]);
}

function getWeekStorageKeys(weekKey) {
  const base = KEYS.analyze.weekMicros(weekKey);

  return [
    base,
    `${base}:INDEX`,
    KEYS.analyze.weekMeta(weekKey)
  ].filter(Boolean);
}

async function deleteExactKeys(redis, keys = []) {
  const safeKeys = uniqueStrings(keys);

  if (!safeKeys.length) return 0;

  let deleted = 0;

  for (const key of safeKeys) {
    deleted += await delKey(redis, key);
  }

  return deleted;
}

async function runLearningDeleteSteps(redis, body = {}) {
  const weekKeys = getWeekKeyCandidates(body);
  const weekMainKeys = weekKeys.flatMap(getWeekStorageKeys);

  const deleted = {
    weekKeys,

    // Fast reset:
    // - delete visible week base/index/meta keys
    // - sharded ROW keys are intentionally not scanned/deleted here
    // - once INDEX is gone, getWeekMicros() cannot read orphan rows
    // - orphan rows expire through TTL from analyzeEngine
    weekMainKeys: await deleteExactKeys(redis, weekMainKeys),

    // Active rotation blijft staan, zodat TradeSystem niet direct zonder gate draait.
    // Next rotation moet weg, want die is gebaseerd op learning-data die nu verwijderd is.
    nextRotation: await delKey(
      redis,
      KEYS.analyze?.nextRotation
    ),

    rotationValidFrom: await delKey(
      redis,
      KEYS.analyze?.rotationValidFrom
    )
  };

  return deleted;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Reset-Learning-Mode', 'long-only');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Short-Disabled', 'true');

  const token = randomUUID();
  let redis = null;
  let acquiredLocks = [];

  try {
    if (req.method !== 'POST') {
      return methodNotAllowed(res);
    }

    const body = await readBody(req);

    if (!isConfirmed(body)) {
      return res.status(400).json({
        ok: false,
        blocked: true,
        reason: 'CONFIRMATION_REQUIRED',
        required: CONFIRM_TEXT,

        targetTradeSide: TARGET_TRADE_SIDE,
        dashboardSide: TARGET_DASHBOARD_SIDE,
        longOnly: true,
        shortDisabled: true
      });
    }

    redis = getDurableRedis();

    const lockResult = await acquireResetLearningLocks(redis, token);
    acquiredLocks = lockResult.acquired || [];

    if (!lockResult.ok) {
      const released = await releaseLocks(redis, acquiredLocks, token);
      acquiredLocks = [];

      return res.status(409).json({
        ok: false,
        blocked: true,
        reason: lockResult.reason,
        released,

        targetTradeSide: TARGET_TRADE_SIDE,
        dashboardSide: TARGET_DASHBOARD_SIDE,
        longOnly: true,
        shortDisabled: true
      });
    }

    const deleted = await runLearningDeleteSteps(redis, body);

    const report = {
      ok: true,
      type: 'RESET_LEARNING_FAST',

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      longOnly: true,
      shortDisabled: true,

      deleted,

      preserved: {
        activeRotation: true,
        openPositions: true,
        scannerSnapshots: true,
        tradeMemory: true,
        resetLogs: true,
        discordLogs: true,
        orphanWeekRowsExpireByTtl: true
      },

      resetAt: Date.now()
    };

    await pushJsonLog(
      redis,
      KEYS.reset?.logList || 'LONG:RESET:LOGS',
      report,
      100
    ).catch(() => null);

    await sendResetReport(report).catch(() => null);

    return res.status(200).json(report);
  } catch (error) {
    const status = error.statusCode || 500;

    return res.status(status).json({
      ok: false,

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      longOnly: true,
      shortDisabled: true,

      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  } finally {
    if (redis && acquiredLocks.length > 0) {
      await releaseLocks(redis, acquiredLocks, token);
    }
  }
}