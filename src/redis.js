// ================= FILE: src/redis.js =================

import { Redis } from '@upstash/redis';

const DEFAULT_SCAN_COUNT = 100;
const DEFAULT_DELETE_BATCH_SIZE = 100;
const DEFAULT_LOG_LIMIT = 250;

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const TARGET_SCANNER_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';

const ROOT_KEY_PREFIXES = [
  'SCAN:',
  'LIVE:',
  'TRADE:',
  'ANALYZE:',
  'CIRCUIT:',
  'DISCORD:',
  'RESET:'
];

const BLOCKED_KEY_PREFIXES = [
  `${OPPOSITE_TRADE_SIDE}:`,
  'SHORT:',
  'SHORT_SCAN:',
  'SHORT_TRADE:',
  'SHORT_ANALYZE:',
  'SHORT_DISCORD:',
  'SHORT_RESET:'
];

function modeFlags() {
  return {
    namespace: LONG_NAMESPACE,
    redisNamespace: LONG_NAMESPACE,
    keyPrefix: LONG_KEY_PREFIX,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,

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
    source: 'VIRTUAL',
    outcomeSource: 'VIRTUAL',

    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,

    noGlobalMaxOpenPositionsBlock: true,
    oneOpenPositionPerSymbol: true,

    manualDiscordSelectionExactTrueMicroOnly: true,
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    noResetCron: true,
    noActivateCron: true,
    noFreezeCron: true,
    manualSelectionPreserved: true,

    shortRootTouched: false
  };
}

function envValue(...names) {
  for (const name of names) {
    const value = process.env[name];

    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
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

    // Wij serializen JSON zelf.
    // Dit houdt locks, logs, stats en nested objects voorspelbaar.
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

function isBlockedShortKey(key = '') {
  const value = String(key || '').trim().toUpperCase();

  return BLOCKED_KEY_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function isRootAppKey(key = '') {
  const value = String(key || '').trim();

  return ROOT_KEY_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function isLongKey(key = '') {
  return String(key || '').trim().startsWith(LONG_KEY_PREFIX);
}

function normalizeKey(key) {
  const raw = String(key || '').trim();

  if (!raw) return '';

  if (isBlockedShortKey(raw)) {
    const error = new Error('LONG_REDIS_REFUSED_SHORT_NAMESPACE_KEY');

    error.details = {
      key: raw,
      ...modeFlags()
    };

    throw error;
  }

  if (isLongKey(raw)) return raw;

  if (isRootAppKey(raw)) return `${LONG_KEY_PREFIX}${raw}`;

  return `${LONG_KEY_PREFIX}${raw}`;
}

function normalizePattern(pattern) {
  const raw = String(pattern || '').trim();

  if (!raw) return '';

  if (isBlockedShortKey(raw)) {
    const error = new Error('LONG_REDIS_REFUSED_SHORT_NAMESPACE_PATTERN');

    error.details = {
      pattern: raw,
      ...modeFlags()
    };

    throw error;
  }

  if (raw.startsWith(LONG_KEY_PREFIX)) return raw;

  if (isRootAppKey(raw)) return `${LONG_KEY_PREFIX}${raw}`;

  return `${LONG_KEY_PREFIX}${raw}`;
}

function normalizeLimit(value, fallback = DEFAULT_LOG_LIMIT) {
  const n = Math.floor(Number(value));

  if (!Number.isFinite(n) || n <= 0) return fallback;

  return n;
}

function normalizeScanCount(value = DEFAULT_SCAN_COUNT) {
  const n = Math.floor(Number(value));

  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SCAN_COUNT;

  return Math.max(1, Math.min(1000, n));
}

function normalizeMax(value, fallback = 1000) {
  const n = Math.floor(Number(value));

  if (!Number.isFinite(n) || n <= 0) return fallback;

  return n;
}

function parseJsonValue(value, fallback = null) {
  if (value === null || value === undefined) return fallback;

  if (typeof value !== 'string') return value;

  const text = value.trim();

  if (!text) return fallback;
  if (text === 'null') return null;
  if (text === 'undefined') return fallback;

  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function stringifyJsonValue(value, keyForError = 'UNKNOWN_KEY') {
  if (value === undefined) {
    throw new Error(`JSON_UNDEFINED_VALUE:${keyForError}`);
  }

  try {
    return JSON.stringify(value);
  } catch (error) {
    throw new Error(`JSON_STRINGIFY_FAILED:${keyForError}:${error?.message || String(error)}`);
  }
}

function normalizeScanResult(result) {
  if (!Array.isArray(result)) {
    return {
      cursor: 0,
      keys: []
    };
  }

  const [nextCursor, keys] = result;

  return {
    cursor: Number(nextCursor) || 0,
    keys: Array.isArray(keys) ? keys.filter(Boolean) : []
  };
}

function withLongMeta(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  return {
    ...value,
    ...modeFlags()
  };
}

async function deleteKeys(redis, keys = []) {
  const rows = Array.isArray(keys)
    ? keys.filter(Boolean).map(normalizeKey)
    : [];

  if (!rows.length) return 0;

  let deleted = 0;

  for (let i = 0; i < rows.length; i += DEFAULT_DELETE_BATCH_SIZE) {
    const batch = rows.slice(i, i + DEFAULT_DELETE_BATCH_SIZE);

    if (!batch.length) continue;

    const result = await redis.del(...batch);
    const count = Number(result);

    deleted += Number.isFinite(count) ? count : batch.length;
  }

  return deleted;
}

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
  const redisKey = normalizeKey(key);

  if (!redis || !redisKey) return fallback;

  const value = await redis.get(redisKey);

  return parseJsonValue(value, fallback);
}

export async function setJson(redis, key, value, options = undefined) {
  const redisKey = normalizeKey(key);

  if (!redis || !redisKey) {
    throw new Error('SET_LONG_JSON_INVALID_REDIS_OR_KEY');
  }

  const payload = stringifyJsonValue(withLongMeta(value), redisKey);

  return redis.set(redisKey, payload, options);
}

export async function setNxJson(redis, key, value, options = {}) {
  const redisKey = normalizeKey(key);

  if (!redis || !redisKey) {
    throw new Error('SET_NX_LONG_JSON_INVALID_REDIS_OR_KEY');
  }

  const payload = stringifyJsonValue(withLongMeta(value), redisKey);

  return redis.set(redisKey, payload, {
    ...options,
    nx: true
  });
}

export async function delPattern(redis, pattern, max = 5000) {
  const redisPattern = normalizePattern(pattern);

  if (!redis || !redisPattern) return 0;

  const maxDelete = normalizeMax(max, 5000);

  let cursor = 0;
  let deleted = 0;

  do {
    const scanResult = await redis.scan(cursor, {
      match: redisPattern,
      count: normalizeScanCount()
    });

    const normalized = normalizeScanResult(scanResult);

    cursor = normalized.cursor;

    if (!normalized.keys.length) continue;

    const longOnlyKeys = normalized.keys
      .filter((key) => String(key || '').startsWith(LONG_KEY_PREFIX));

    const remaining = Math.max(0, maxDelete - deleted);
    const limitedKeys = longOnlyKeys.slice(0, remaining);

    deleted += await deleteKeys(redis, limitedKeys);

    if (deleted >= maxDelete) break;
  } while (cursor !== 0);

  return deleted;
}

export async function getKeys(redis, pattern, max = 1000) {
  const redisPattern = normalizePattern(pattern);

  if (!redis || !redisPattern) return [];

  const maxKeys = normalizeMax(max, 1000);

  let cursor = 0;
  const out = [];
  const seen = new Set();

  do {
    const scanResult = await redis.scan(cursor, {
      match: redisPattern,
      count: normalizeScanCount()
    });

    const normalized = normalizeScanResult(scanResult);

    cursor = normalized.cursor;

    for (const key of normalized.keys) {
      if (!key || seen.has(key)) continue;
      if (!String(key).startsWith(LONG_KEY_PREFIX)) continue;

      seen.add(key);
      out.push(key);

      if (out.length >= maxKeys) break;
    }

    if (out.length >= maxKeys) break;
  } while (cursor !== 0);

  return out;
}

export async function pushJsonLog(redis, key, value, limit = DEFAULT_LOG_LIMIT) {
  const redisKey = normalizeKey(key);

  if (!redis || !redisKey) {
    throw new Error('PUSH_LONG_JSON_LOG_INVALID_REDIS_OR_KEY');
  }

  const safeLimit = normalizeLimit(limit, DEFAULT_LOG_LIMIT);
  const payload = stringifyJsonValue(withLongMeta(value), redisKey);

  await redis.lpush(redisKey, payload);
  await redis.ltrim(redisKey, 0, safeLimit - 1);

  return true;
}

export async function readJsonLogs(redis, key, limit = 100) {
  const redisKey = normalizeKey(key);

  if (!redis || !redisKey) return [];

  const safeLimit = normalizeLimit(limit, 100);
  const rows = await redis.lrange(redisKey, 0, safeLimit - 1);

  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      if (row === null || row === undefined) return null;

      if (typeof row !== 'string') return row;

      const parsed = parseJsonValue(row, null);

      return parsed === null
        ? {
          raw: row,
          ...modeFlags()
        }
        : {
          ...parsed,
          ...modeFlags()
        };
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