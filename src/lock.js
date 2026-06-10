// ================= FILE: src/lock.js =================

import { randomUUID } from 'node:crypto';

const DEFAULT_LOCK_TTL_SEC = 180;
const MIN_LOCK_TTL_SEC = 5;

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const TARGET_SCANNER_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;

const RELEASE_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

const RAW_ROOT_KEY_PREFIXES = [
  'SCAN:',
  'LIVE:',
  'TRADE:',
  'ANALYZE:',
  'CIRCUIT:',
  'DISCORD:',
  'RESET:'
];

function modeFlags() {
  return {
    namespace: LONG_NAMESPACE,
    redisNamespace: LONG_NAMESPACE,
    keyPrefix: LONG_KEY_PREFIX,
    redisKeyPrefix: LONG_KEY_PREFIX,

    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_SCANNER_SIDE,
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

    virtualOnly: true,
    virtualLearning: true,

    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,

    noResetCron: true,
    noActivateCron: true,
    noFreezeCron: true,
    manualSelectionPreserved: true,

    noGlobalMaxOpenPositionsBlock: true,
    oneOpenPositionPerSymbol: true
  };
}

function normalizeTtlSec(ttlSec) {
  const n = Number(ttlSec);

  if (!Number.isFinite(n)) return DEFAULT_LOCK_TTL_SEC;

  return Math.max(MIN_LOCK_TTL_SEC, Math.floor(n));
}

function isRawRootKey(key = '') {
  return RAW_ROOT_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function normalizeLockKey(key) {
  const raw = String(key || '').trim();

  if (!raw) return '';

  if (raw.startsWith(`${OPPOSITE_TRADE_SIDE}:`)) {
    const error = new Error('LONG_LOCK_REFUSED_SHORT_NAMESPACE_KEY');

    error.details = {
      key: raw,
      namespace: LONG_NAMESPACE,
      oppositeTradeSide: OPPOSITE_TRADE_SIDE,
      ...modeFlags()
    };

    throw error;
  }

  if (raw.startsWith(LONG_KEY_PREFIX)) {
    return raw;
  }

  if (isRawRootKey(raw)) {
    return `${LONG_KEY_PREFIX}${raw}`;
  }

  return `${LONG_KEY_PREFIX}${raw}`;
}

function createLockToken() {
  return `${LONG_NAMESPACE}_${TARGET_TRADE_SIDE}_${Date.now()}_${randomUUID()}`;
}

function isLockAcquiredResult(value) {
  if (value === true) return true;
  if (value === 'OK') return true;
  if (value === 'ok') return true;
  if (value === 1) return true;

  return false;
}

async function atomicRelease(redis, key, token) {
  if (typeof redis.eval === 'function') {
    const result = await redis.eval(RELEASE_LOCK_SCRIPT, [key], [token]);

    return Number(result) === 1;
  }

  if (typeof redis.evalsha === 'function') {
    // Kept out of the hot path; scripts are not preloaded in this app.
    return false;
  }

  return null;
}

async function fallbackRelease(redis, key, token) {
  const current = await redis.get(key);

  if (String(current || '') !== token) {
    return {
      ok: false,
      released: false,
      reason: current ? 'LOCK_TOKEN_MISMATCH' : 'LOCK_ALREADY_EXPIRED',
      key,
      ...modeFlags()
    };
  }

  const deleted = await redis.del(key);

  return {
    ok: Number(deleted) > 0,
    released: Number(deleted) > 0,
    reason: Number(deleted) > 0 ? 'LOCK_RELEASED' : 'LOCK_DELETE_NOOP',
    key,
    ...modeFlags()
  };
}

export async function acquireRedisLock(redis, key, ttlSec = DEFAULT_LOCK_TTL_SEC) {
  const lockKey = normalizeLockKey(key);

  if (!redis || !lockKey) {
    throw new Error('ACQUIRE_LONG_LOCK_INVALID_REDIS_OR_KEY');
  }

  const token = createLockToken();
  const ttl = normalizeTtlSec(ttlSec);

  const acquired = await redis.set(lockKey, token, {
    nx: true,
    ex: ttl
  });

  if (!isLockAcquiredResult(acquired)) {
    return {
      ok: false,
      acquired: false,
      key: lockKey,
      ttlSec: ttl,
      token: null,
      reason: 'PREVIOUS_LONG_RUN_STILL_ACTIVE',
      ...modeFlags()
    };
  }

  return {
    ok: true,
    acquired: true,
    key: lockKey,
    ttlSec: ttl,
    token,
    ...modeFlags()
  };
}

export async function releaseRedisLock(redis, key, token) {
  let lockKey = '';

  try {
    lockKey = normalizeLockKey(key);
  } catch (error) {
    return {
      ok: false,
      released: false,
      reason: error?.message || 'RELEASE_LONG_LOCK_INVALID_KEY',
      key: String(key || '').trim(),
      error: error?.message || String(error),
      details: error?.details || null,
      ...modeFlags()
    };
  }

  const lockToken = String(token || '').trim();

  if (!redis || !lockKey || !lockToken) {
    return {
      ok: false,
      released: false,
      reason: 'RELEASE_LONG_LOCK_INVALID_INPUT',
      key: lockKey || key,
      ...modeFlags()
    };
  }

  try {
    const atomic = await atomicRelease(redis, lockKey, lockToken);

    if (atomic === true) {
      return {
        ok: true,
        released: true,
        reason: 'LONG_LOCK_RELEASED_ATOMIC',
        key: lockKey,
        ...modeFlags()
      };
    }

    if (atomic === false) {
      return {
        ok: false,
        released: false,
        reason: 'LONG_LOCK_TOKEN_MISMATCH_OR_ALREADY_EXPIRED',
        key: lockKey,
        ...modeFlags()
      };
    }

    return await fallbackRelease(redis, lockKey, lockToken);
  } catch (error) {
    try {
      return await fallbackRelease(redis, lockKey, lockToken);
    } catch (fallbackError) {
      return {
        ok: false,
        released: false,
        reason: 'LONG_LOCK_RELEASE_FAILED',
        key: lockKey,
        error: fallbackError?.message || error?.message || String(fallbackError || error),
        ...modeFlags()
      };
    }
  }
}

export async function withRedisLock(redis, key, ttlSec, task) {
  if (typeof task !== 'function') {
    throw new Error('WITH_LONG_REDIS_LOCK_TASK_MUST_BE_FUNCTION');
  }

  const lockKey = normalizeLockKey(key);
  const lock = await acquireRedisLock(redis, lockKey, ttlSec);

  if (!lock.acquired) {
    return {
      ok: false,
      skipped: true,
      reason: lock.reason,
      lockKey,
      ttlSec: lock.ttlSec,
      ...modeFlags()
    };
  }

  let taskResult;
  let taskError;
  let releaseResult;

  try {
    taskResult = await task({
      lockKey,
      lockToken: lock.token,
      lockTtlSec: lock.ttlSec,
      ...modeFlags()
    });
  } catch (error) {
    taskError = error;
  }

  releaseResult = await releaseRedisLock(redis, lockKey, lock.token);

  if (taskError) {
    taskError.lockReleased = Boolean(releaseResult?.released);
    taskError.lockReleaseReason = releaseResult?.reason || null;
    taskError.lockKey = lockKey;
    taskError.lockNamespace = LONG_NAMESPACE;
    taskError.tradeSide = TARGET_TRADE_SIDE;

    throw taskError;
  }

  return {
    ok: true,
    skipped: false,
    lockKey,
    ttlSec: lock.ttlSec,
    lockReleased: Boolean(releaseResult?.released),
    lockReleaseReason: releaseResult?.reason || null,
    result: taskResult,
    ...modeFlags()
  };
}