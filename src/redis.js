// ================= FILE: src/redis.js =================

import { Redis } from '@upstash/redis';

const DEFAULT_SCAN_COUNT = 100;
const DEFAULT_DELETE_BATCH_SIZE = 100;

function envValue(...names) {
  for (const name of names) {
    const value = process.env[name];

    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return value;
    }
  }

  return '';
}

function makeRedis(url, token, label) {
  if (!url || !token) {
    throw new Error(`${label}_REDIS_ENV_MISSING`);
  }

  return new Redis({
    url,
    token,

    // Belangrijk:
    // Wij serializen JSON zelf met JSON.stringify/JSON.parse.
    // Daardoor zijn locks, logs en stats voorspelbaar.
    automaticDeserialization: false
  });
}

function getVolatileEnv() {
  return {
    url: envValue(
      'VOLATILE_REDIS_REST_URL',
      'KV_REST_API_URL',
      'UPSTASH_REDIS_REST_URL'
    ),
    token: envValue(
      'VOLATILE_REDIS_REST_TOKEN',
      'KV_REST_API_TOKEN',
      'UPSTASH_REDIS_REST_TOKEN'
    )
  };
}

function getDurableEnv() {
  return {
    url: envValue(
      'DURABLE_REDIS_REST_URL',
      'KV_REST_API_URL',
      'UPSTASH_REDIS_REST_URL'
    ),
    token: envValue(
      'DURABLE_REDIS_REST_TOKEN',
      'KV_REST_API_TOKEN',
      'UPSTASH_REDIS_REST_TOKEN'
    )
  };
}

let volatileRedis = null;
let durableRedis = null;

export function getVolatileRedis() {
  if (!volatileRedis) {
    const { url, token } = getVolatileEnv();
    volatileRedis = makeRedis(url, token, 'VOLATILE');
  }

  return volatileRedis;
}

export function getDurableRedis() {
  if (!durableRedis) {
    const { url, token } = getDurableEnv();
    durableRedis = makeRedis(url, token, 'DURABLE');
  }

  return durableRedis;
}

export function hasVolatileRedisEnv() {
  const { url, token } = getVolatileEnv();

  return Boolean(url && token);
}

export function hasDurableRedisEnv() {
  const { url, token } = getDurableEnv();

  return Boolean(url && token);
}

export function hasRedisEnv() {
  return hasVolatileRedisEnv() && hasDurableRedisEnv();
}

export async function getJson(redis, key, fallback = null) {
  if (!redis || !key) return fallback;

  const value = await redis.get(key);

  if (value === null || value === undefined) return fallback;

  if (typeof value !== 'string') return value;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export async function setJson(redis, key, value, options = undefined) {
  if (!redis || !key) {
    throw new Error('SET_JSON_INVALID_REDIS_OR_KEY');
  }

  if (value === undefined) {
    throw new Error(`SET_JSON_UNDEFINED_VALUE:${key}`);
  }

  return redis.set(key, JSON.stringify(value), options);
}

export async function setNxJson(redis, key, value, options = {}) {
  if (!redis || !key) {
    throw new Error('SET_NX_JSON_INVALID_REDIS_OR_KEY');
  }

  if (value === undefined) {
    throw new Error(`SET_NX_JSON_UNDEFINED_VALUE:${key}`);
  }

  return redis.set(key, JSON.stringify(value), {
    ...options,
    nx: true
  });
}

export async function delPattern(redis, pattern, max = 5000) {
  if (!redis || !pattern) return 0;

  let cursor = 0;
  let deleted = 0;

  do {
    const [nextCursor, keys = []] = await redis.scan(cursor, {
      match: pattern,
      count: DEFAULT_SCAN_COUNT
    });

    cursor = Number(nextCursor);

    if (!Array.isArray(keys) || keys.length === 0) {
      continue;
    }

    const remaining = Math.max(0, max - deleted);
    const limitedKeys = keys.slice(0, remaining);

    for (let i = 0; i < limitedKeys.length; i += DEFAULT_DELETE_BATCH_SIZE) {
      const batch = limitedKeys.slice(i, i + DEFAULT_DELETE_BATCH_SIZE);

      if (batch.length > 0) {
        await redis.del(...batch);
        deleted += batch.length;
      }

      if (deleted >= max) break;
    }

    if (deleted >= max) break;
  } while (cursor !== 0);

  return deleted;
}

export async function getKeys(redis, pattern, max = 1000) {
  if (!redis || !pattern) return [];

  let cursor = 0;
  const out = [];

  do {
    const [nextCursor, keys = []] = await redis.scan(cursor, {
      match: pattern,
      count: DEFAULT_SCAN_COUNT
    });

    cursor = Number(nextCursor);

    if (Array.isArray(keys) && keys.length > 0) {
      out.push(...keys);
    }

    if (out.length >= max) break;
  } while (cursor !== 0);

  return out.slice(0, max);
}

export async function pushJsonLog(redis, key, value, limit = 250) {
  if (!redis || !key) {
    throw new Error('PUSH_JSON_LOG_INVALID_REDIS_OR_KEY');
  }

  if (value === undefined) {
    throw new Error(`PUSH_JSON_LOG_UNDEFINED_VALUE:${key}`);
  }

  const safeLimit = Math.max(1, Number(limit) || 250);

  await redis.lpush(key, JSON.stringify(value));
  await redis.ltrim(key, 0, safeLimit - 1);

  return true;
}

export async function readJsonLogs(redis, key, limit = 100) {
  if (!redis || !key) return [];

  const safeLimit = Math.max(1, Number(limit) || 100);
  const rows = await redis.lrange(key, 0, safeLimit - 1);

  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      if (row === null || row === undefined) return null;
      if (typeof row !== 'string') return row;

      try {
        return JSON.parse(row);
      } catch {
        return { raw: row };
      }
    })
    .filter(Boolean);
}

export async function pingRedis(redis) {
  if (!redis) return false;

  try {
    const result = await redis.ping();

    return result === 'PONG' || result === 'pong' || result === true;
  } catch {
    return false;
  }
}