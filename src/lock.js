// ================= FILE: src/lock.js =================

import { randomUUID } from 'node:crypto';

const DEFAULT_LOCK_TTL_SEC = 180;
const MIN_LOCK_TTL_SEC = 5;

function normalizeTtlSec(ttlSec) {
  const n = Number(ttlSec);

  if (!Number.isFinite(n)) return DEFAULT_LOCK_TTL_SEC;

  return Math.max(MIN_LOCK_TTL_SEC, Math.floor(n));
}

function createLockToken() {
  return `${Date.now()}_${randomUUID()}`;
}

export async function acquireRedisLock(redis, key, ttlSec = DEFAULT_LOCK_TTL_SEC) {
  if (!redis || !key) {
    throw new Error('ACQUIRE_LOCK_INVALID_REDIS_OR_KEY');
  }

  const token = createLockToken();
  const ttl = normalizeTtlSec(ttlSec);

  const acquired = await redis.set(key, token, {
    nx: true,
    ex: ttl
  });

  if (!acquired) {
    return {
      ok: false,
      acquired: false,
      key,
      ttlSec: ttl,
      token: null,
      reason: 'PREVIOUS_RUN_STILL_ACTIVE'
    };
  }

  return {
    ok: true,
    acquired: true,
    key,
    ttlSec: ttl,
    token
  };
}

export async function releaseRedisLock(redis, key, token) {
  if (!redis || !key || !token) {
    return {
      ok: false,
      released: false,
      reason: 'RELEASE_LOCK_INVALID_INPUT',
      key
    };
  }

  try {
    const current = await redis.get(key);

    if (current !== token) {
      return {
        ok: false,
        released: false,
        reason: 'LOCK_TOKEN_MISMATCH',
        key
      };
    }

    await redis.del(key);

    return {
      ok: true,
      released: true,
      key
    };
  } catch (error) {
    return {
      ok: false,
      released: false,
      reason: 'LOCK_RELEASE_FAILED',
      key,
      error: error?.message || String(error)
    };
  }
}

export async function withRedisLock(redis, key, ttlSec, task) {
  if (typeof task !== 'function') {
    throw new Error('WITH_REDIS_LOCK_TASK_MUST_BE_FUNCTION');
  }

  const lock = await acquireRedisLock(redis, key, ttlSec);

  if (!lock.acquired) {
    return {
      ok: false,
      skipped: true,
      reason: lock.reason,
      lockKey: key,
      ttlSec: lock.ttlSec
    };
  }

  try {
    const result = await task({
      lockKey: key,
      lockToken: lock.token,
      lockTtlSec: lock.ttlSec
    });

    return {
      ok: true,
      skipped: false,
      lockKey: key,
      ttlSec: lock.ttlSec,
      result
    };
  } finally {
    await releaseRedisLock(redis, key, lock.token);
  }
}