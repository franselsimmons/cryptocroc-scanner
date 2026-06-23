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

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = TRUE_MICRO_SCHEMA;
const LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_V1';

const REDIS_BUILD_ID = 'LONG_REDIS_REST_FALLBACK_2026_06_23_V1';

const ROOT_KEY_PREFIXES = [
  'SCAN:',
  'LIVE:',
  'TRADE:',
  'ANALYZE:',
  'CIRCUIT:',
  'DISCORD:',
  'RESET:'
];

const PUBLIC_MARKET_KEY_PREFIXES = [
  'MARKET:WEATHER',
  'MARKET:UNIVERSE',
  'MARKET:SCANNER:UNIVERSE'
];

const BLOCKED_KEY_PREFIXES = [
  `${OPPOSITE_TRADE_SIDE}:`,
  'SHORT:',
  'SHORT_SCAN:',
  'SHORT_TRADE:',
  'SHORT_ANALYZE:',
  'SHORT_DISCORD:',
  'SHORT_RESET:',
  'SHORT_LIVE:',
  'BEAR:',
  'BEARISH:',
  'SELL:'
];

const LONG_FIXED_SETUP_TYPES = Object.freeze([
  'BREAKOUT',
  'RETEST',
  'SWEEP_REVERSAL',
  'CONTINUATION',
  'COMPRESSION'
]);

const LONG_FIXED_REGIME_BUCKETS = Object.freeze([
  'TREND',
  'CHOP',
  'SQUEEZE'
]);

const LONG_CONFIRMATION_PROFILES = Object.freeze([
  'A_STRONG_ALIGN',
  'B_FLOW_ALIGN',
  'C_VOLUME_ALIGN',
  'D_MIXED_OK',
  'E_WEAK_CONTRA'
]);

function taxonomyFlags() {
  return {
    trueMicroSchema: TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,

    parentTrueMicroSchema: PARENT_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,

    childTrueMicroSchema: CHILD_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,

    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

    fixedTaxonomyPreferred: true,
    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    exactTrueMicroFamilyRequired: true,

    parentLearningEnabled: true,
    childLearningEnabled: true,
    selectionGranularity: 'EXACT_75_CHILD',
    fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED',

    selectableFamilyCount: 75,
    parentFamilyCount: 15,
    parentSelectable: false,
    childSelectable: true,

    setupTypes: LONG_FIXED_SETUP_TYPES,
    regimeBuckets: LONG_FIXED_REGIME_BUCKETS,
    confirmationProfiles: LONG_CONFIRMATION_PROFILES
  };
}

function modeFlags() {
  return {
    redisBuildId: REDIS_BUILD_ID,

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
    scannerSide: TARGET_SCANNER_SIDE,
    actualScannerSide: TARGET_SCANNER_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    virtualOnly: true,
    virtualLearning: true,
    virtualTracked: true,
    source: 'VIRTUAL',
    outcomeSource: 'VIRTUAL',

    noRealOrders: true,
    noExchangeOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    exchangeCallsDisabled: true,

    noGlobalMaxOpenPositionsBlock: true,
    oneOpenPositionPerSymbol: true,

    manualDiscordSelectionExactTrueMicroOnly: true,
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    discordOnlyForExactTrueMicroMatch: true,
    discordOnlyForSelectedMicroFamilies: true,

    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,

    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',

    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    rankingUsesBalancedScore: true,
    noBareWinrateRanking: true,
    balancedRankingFields: [
      'balancedScore',
      'dashboardBalancedScore',
      'fairWinrate',
      'totalR',
      'avgR',
      'avgCostR'
    ],

    noResetCron: true,
    noActivateCron: true,
    noFreezeCron: true,
    manualSelectionPreserved: true,

    shortRootTouched: false,

    ...taxonomyFlags()
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
    automaticDeserialization: false
  });
}

function getVolatileEnv() {
  return {
    label: 'VOLATILE',
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
    label: 'DURABLE',
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

function uniqueRedisRestConfigs() {
  const configs = [
    getVolatileEnv(),
    getDurableEnv()
  ]
    .filter((config) => config.url && config.token);

  const seen = new Set();
  const out = [];

  for (const config of configs) {
    const key = `${config.url}|${config.token}`;

    if (seen.has(key)) continue;

    seen.add(key);
    out.push(config);
  }

  return out;
}

let volatileRedis = null;
let durableRedis = null;

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function isBlockedShortKey(key = '') {
  const value = upper(key);

  return BLOCKED_KEY_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function isRootAppKey(key = '') {
  const value = String(key || '').trim();

  return ROOT_KEY_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function isPublicMarketKey(key = '') {
  const value = String(key || '').trim();

  return PUBLIC_MARKET_KEY_PREFIXES.some((prefix) => (
    value === prefix ||
    value.startsWith(`${prefix}:`)
  ));
}

function isLongKey(key = '') {
  return String(key || '').trim().startsWith(LONG_KEY_PREFIX);
}

function buildNamespaceError(message, payload = {}) {
  const error = new Error(message);

  error.details = {
    ...payload,
    namespace: LONG_NAMESPACE,
    redisNamespace: LONG_NAMESPACE,
    keyPrefix: LONG_KEY_PREFIX,
    redisKeyPrefix: LONG_KEY_PREFIX,
    targetTradeSide: TARGET_TRADE_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,
    shortRootTouched: false,
    ...taxonomyFlags()
  };

  return error;
}

function normalizeKey(key) {
  const raw = String(key || '').trim();

  if (!raw) return '';

  if (isBlockedShortKey(raw)) {
    throw buildNamespaceError('LONG_REDIS_REFUSED_SHORT_NAMESPACE_KEY', {
      key: raw
    });
  }

  if (isLongKey(raw)) return raw;

  if (isPublicMarketKey(raw)) return raw;

  if (isRootAppKey(raw)) return `${LONG_KEY_PREFIX}${raw}`;

  return `${LONG_KEY_PREFIX}${raw}`;
}

function normalizePattern(pattern) {
  const raw = String(pattern || '').trim();

  if (!raw) return '';

  if (isBlockedShortKey(raw)) {
    throw buildNamespaceError('LONG_REDIS_REFUSED_SHORT_NAMESPACE_PATTERN', {
      pattern: raw
    });
  }

  if (raw.startsWith(LONG_KEY_PREFIX)) return raw;

  if (isPublicMarketKey(raw)) return raw;

  if (isRootAppKey(raw)) return `${LONG_KEY_PREFIX}${raw}`;

  if (raw === '*') return `${LONG_KEY_PREFIX}*`;

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

function assertLongNormalizedKey(key) {
  const value = String(key || '').trim();

  if (
    !value.startsWith(LONG_KEY_PREFIX) &&
    !isPublicMarketKey(value)
  ) {
    throw buildNamespaceError('LONG_REDIS_REFUSED_NON_LONG_KEY', {
      key: value
    });
  }

  return true;
}

function shouldUseRestFallback(error) {
  const message = String(error?.message || error || '');

  return (
    message.includes('res.map is not a function') ||
    message.includes('Pipeline.exec') ||
    message.includes('AutoPipelineExecutor') ||
    message.includes('UPSTASH') ||
    message.includes('fetch failed') ||
    message.includes('Response') ||
    message.includes('Unexpected token')
  );
}

function cleanRestUrl(url = '') {
  return String(url || '').trim().replace(/\/+$/u, '');
}

function encodeCommandPart(value) {
  return encodeURIComponent(String(value));
}

function unwrapPipelineResult(json) {
  if (Array.isArray(json)) {
    const first = json[0];

    if (first && typeof first === 'object' && 'result' in first) {
      return first.result;
    }

    if (first && typeof first === 'object' && 'error' in first) {
      throw new Error(String(first.error));
    }

    return first ?? null;
  }

  if (Array.isArray(json?.result)) {
    const first = json.result[0];

    if (first && typeof first === 'object' && 'result' in first) {
      return first.result;
    }

    if (first && typeof first === 'object' && 'error' in first) {
      throw new Error(String(first.error));
    }

    return first ?? null;
  }

  if (json && typeof json === 'object' && 'result' in json) {
    return json.result;
  }

  return json ?? null;
}

function unwrapRestResult(json) {
  if (json?.error) {
    throw new Error(String(json.error));
  }

  if (json && typeof json === 'object' && 'result' in json) {
    return json.result;
  }

  return json ?? null;
}

async function restPipelineCommand(config, command = []) {
  const url = cleanRestUrl(config.url);

  if (!url || !config.token) {
    throw new Error('UPSTASH_REST_ENV_MISSING');
  }

  const response = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify([command])
  });

  const json = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(`UPSTASH_REST_PIPELINE_HTTP_${response.status}`);
    error.details = json;
    throw error;
  }

  return unwrapPipelineResult(json);
}

async function restPathCommand(config, command = []) {
  const url = cleanRestUrl(config.url);

  if (!url || !config.token) {
    throw new Error('UPSTASH_REST_ENV_MISSING');
  }

  const path = command.map(encodeCommandPart).join('/');

  const response = await fetch(`${url}/${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${config.token}`
    }
  });

  const json = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(`UPSTASH_REST_PATH_HTTP_${response.status}`);
    error.details = json;
    throw error;
  }

  return unwrapRestResult(json);
}

async function redisRestCommand(command = [], options = {}) {
  const configs = uniqueRedisRestConfigs();

  if (!configs.length) {
    throw new Error('UPSTASH_REST_ENV_MISSING');
  }

  const readOnly = Boolean(options.readOnly);
  const allowNull = Boolean(options.allowNull);
  let lastError = null;
  let sawNull = false;

  for (const config of configs) {
    try {
      const result = await restPipelineCommand(config, command);

      if (readOnly && result === null && !allowNull) {
        sawNull = true;
        continue;
      }

      return result;
    } catch (error) {
      lastError = error;

      if (!readOnly) continue;

      try {
        const result = await restPathCommand(config, command);

        if (readOnly && result === null && !allowNull) {
          sawNull = true;
          continue;
        }

        return result;
      } catch (pathError) {
        lastError = pathError;
      }
    }
  }

  if (readOnly && sawNull) return null;

  throw lastError || new Error('UPSTASH_REST_COMMAND_FAILED');
}

function buildSetCommand(redisKey, payload, options = {}) {
  const command = ['SET', redisKey, payload];

  if (options?.ex !== undefined && options?.ex !== null) {
    command.push('EX', String(options.ex));
  }

  if (options?.px !== undefined && options?.px !== null) {
    command.push('PX', String(options.px));
  }

  if (options?.nx === true) {
    command.push('NX');
  }

  if (options?.xx === true) {
    command.push('XX');
  }

  return command;
}

async function deleteKeys(redis, keys = []) {
  const rows = Array.isArray(keys)
    ? keys
      .filter(Boolean)
      .map(normalizeKey)
      .filter((key) => (
        key.startsWith(LONG_KEY_PREFIX) ||
        isPublicMarketKey(key)
      ))
    : [];

  if (!rows.length) return 0;

  let deleted = 0;

  for (let i = 0; i < rows.length; i += DEFAULT_DELETE_BATCH_SIZE) {
    const batch = rows.slice(i, i + DEFAULT_DELETE_BATCH_SIZE);

    if (!batch.length) continue;

    try {
      const result = await redis.del(...batch);
      const count = Number(result);

      deleted += Number.isFinite(count) ? count : batch.length;
    } catch (error) {
      if (!shouldUseRestFallback(error)) throw error;

      const result = await redisRestCommand(['DEL', ...batch], {
        readOnly: false
      });

      const count = Number(result);
      deleted += Number.isFinite(count) ? count : batch.length;
    }
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

export function normalizeRedisKey(key) {
  return normalizeKey(key);
}

export function normalizeRedisPattern(pattern) {
  return normalizePattern(pattern);
}

export function isLongRedisKey(key) {
  return isLongKey(key);
}

export function isPublicMarketRedisKey(key) {
  return isPublicMarketKey(key);
}

export function redisModeFlags() {
  return modeFlags();
}

export async function getJson(redis, key, fallback = null) {
  const redisKey = normalizeKey(key);

  if (!redis || !redisKey) return fallback;

  assertLongNormalizedKey(redisKey);

  try {
    const value = await redis.get(redisKey);
    return parseJsonValue(value, fallback);
  } catch (error) {
    if (!shouldUseRestFallback(error)) return fallback;

    try {
      const value = await redisRestCommand(['GET', redisKey], {
        readOnly: true
      });

      return parseJsonValue(value, fallback);
    } catch {
      return fallback;
    }
  }
}

export async function setJson(redis, key, value, options = undefined) {
  const redisKey = normalizeKey(key);

  if (!redis || !redisKey) {
    throw new Error('SET_LONG_JSON_INVALID_REDIS_OR_KEY');
  }

  assertLongNormalizedKey(redisKey);

  const payload = stringifyJsonValue(withLongMeta(value), redisKey);

  try {
    return await redis.set(redisKey, payload, options);
  } catch (error) {
    if (!shouldUseRestFallback(error)) throw error;

    return redisRestCommand(buildSetCommand(redisKey, payload, options || {}), {
      readOnly: false
    });
  }
}

export async function setNxJson(redis, key, value, options = {}) {
  const redisKey = normalizeKey(key);

  if (!redis || !redisKey) {
    throw new Error('SET_NX_LONG_JSON_INVALID_REDIS_OR_KEY');
  }

  assertLongNormalizedKey(redisKey);

  const payload = stringifyJsonValue(withLongMeta(value), redisKey);

  const nxOptions = {
    ...options,
    nx: true
  };

  try {
    return await redis.set(redisKey, payload, nxOptions);
  } catch (error) {
    if (!shouldUseRestFallback(error)) throw error;

    return redisRestCommand(buildSetCommand(redisKey, payload, nxOptions), {
      readOnly: false
    });
  }
}

export async function delJson(redis, key) {
  const redisKey = normalizeKey(key);

  if (!redis || !redisKey) return 0;

  assertLongNormalizedKey(redisKey);

  try {
    return await redis.del(redisKey);
  } catch (error) {
    if (!shouldUseRestFallback(error)) return 0;

    try {
      const result = await redisRestCommand(['DEL', redisKey], {
        readOnly: false
      });

      const n = Number(result);
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }
}

export async function delPattern(redis, pattern, max = 5000) {
  const redisPattern = normalizePattern(pattern);

  if (!redis || !redisPattern) return 0;

  assertLongNormalizedKey(redisPattern.replace(/\*.*$/u, '') || LONG_KEY_PREFIX);

  const maxDelete = normalizeMax(max, 5000);
  const keys = await getKeys(redis, redisPattern, maxDelete);

  return deleteKeys(redis, keys);
}

export async function getKeys(redis, pattern, max = 1000) {
  const redisPattern = normalizePattern(pattern);

  if (!redis || !redisPattern) return [];

  assertLongNormalizedKey(redisPattern.replace(/\*.*$/u, '') || LONG_KEY_PREFIX);

  const maxKeys = normalizeMax(max, 1000);

  let cursor = 0;
  const out = [];
  const seen = new Set();

  async function scanWithSdk(currentCursor) {
    return redis.scan(currentCursor, {
      match: redisPattern,
      count: normalizeScanCount()
    });
  }

  async function scanWithRest(currentCursor) {
    return redisRestCommand([
      'SCAN',
      String(currentCursor),
      'MATCH',
      redisPattern,
      'COUNT',
      String(normalizeScanCount())
    ], {
      readOnly: true,
      allowNull: true
    });
  }

  do {
    let scanResult;

    try {
      scanResult = await scanWithSdk(cursor);
    } catch (error) {
      if (!shouldUseRestFallback(error)) return out;

      try {
        scanResult = await scanWithRest(cursor);
      } catch {
        return out;
      }
    }

    const normalized = normalizeScanResult(scanResult);

    cursor = normalized.cursor;

    for (const key of normalized.keys) {
      if (!key || seen.has(key)) continue;

      if (
        !String(key).startsWith(LONG_KEY_PREFIX) &&
        !isPublicMarketKey(key)
      ) {
        continue;
      }

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

  assertLongNormalizedKey(redisKey);

  const safeLimit = normalizeLimit(limit, DEFAULT_LOG_LIMIT);
  const payload = stringifyJsonValue(withLongMeta(value), redisKey);

  try {
    await redis.lpush(redisKey, payload);
    await redis.ltrim(redisKey, 0, safeLimit - 1);
    return true;
  } catch (error) {
    if (!shouldUseRestFallback(error)) throw error;

    await redisRestCommand(['LPUSH', redisKey, payload], {
      readOnly: false
    });

    await redisRestCommand(['LTRIM', redisKey, '0', String(safeLimit - 1)], {
      readOnly: false
    });

    return true;
  }
}

export async function readJsonLogs(redis, key, limit = 100) {
  const redisKey = normalizeKey(key);

  if (!redis || !redisKey) return [];

  assertLongNormalizedKey(redisKey);

  const safeLimit = normalizeLimit(limit, 100);

  let rows = [];

  try {
    const result = await redis.lrange(redisKey, 0, safeLimit - 1);
    rows = Array.isArray(result) ? result : [];
  } catch (error) {
    if (!shouldUseRestFallback(error)) return [];

    try {
      const result = await redisRestCommand([
        'LRANGE',
        redisKey,
        '0',
        String(safeLimit - 1)
      ], {
        readOnly: true,
        allowNull: true
      });

      rows = Array.isArray(result) ? result : [];
    } catch {
      rows = [];
    }
  }

  return rows
    .map((row) => {
      if (row === null || row === undefined) return null;

      if (typeof row !== 'string') {
        return withLongMeta(row);
      }

      const parsed = parseJsonValue(row, null);

      return parsed === null
        ? {
          raw: row,
          ...modeFlags()
        }
        : withLongMeta(parsed);
    })
    .filter(Boolean);
}

export async function pingRedis(redis) {
  if (!redis) return false;

  try {
    const result = await redis.ping();

    return result === 'PONG' || result === 'pong' || result === true;
  } catch (error) {
    if (!shouldUseRestFallback(error)) return false;

    try {
      const result = await redisRestCommand(['PING'], {
        readOnly: true,
        allowNull: true
      });

      return result === 'PONG' || result === 'pong' || result === true;
    } catch {
      return false;
    }
  }
}