// ================= FILE: api/admin/reset-learning.js =================

import { randomUUID } from 'node:crypto';

import { KEYS } from '../../src/keys.js';
import {
  getIsoWeekKey,
  getPreviousIsoWeekKey
} from '../../src/utils.js';
import {
  getDurableRedis,
  pushJsonLog,
  delPattern
} from '../../src/redis.js';
import { sendResetReport } from '../../src/discord/discord.js';

const CONFIRM_TEXT = 'RESET_LEARNING_LONG';
const LOCK_TTL_SEC = 180;

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;

// Vaste leer-sleutel voor de aparte LONG-root.
// Geen ISO-week reset meer. Alleen dit expliciete write-endpoint wist LONG analyze data.
const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';

const MIN_COMPLETED_ACTIVE_LEARNING = 20;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;

const DELETE_SCAN_COUNT = 10_000;

function namespacedLongKey(key, fallback = null) {
  const raw = String(key || fallback || '').trim();

  if (!raw) return null;
  if (raw.startsWith(LONG_KEY_PREFIX)) return raw;

  return `${LONG_KEY_PREFIX}${raw}`;
}

function namespacedLongPattern(pattern, fallback = null) {
  return namespacedLongKey(pattern, fallback);
}

const LONG_KEYS = {
  reset: {
    logList: namespacedLongKey(
      KEYS.long?.reset?.logList ||
        KEYS.reset?.longLogList ||
        KEYS.reset?.logList,
      'RESET:LOGS'
    )
  },

  trade: {
    lock: namespacedLongKey(
      KEYS.long?.trade?.lock ||
        KEYS.trade?.longLock ||
        KEYS.trade?.lock,
      'TRADE:LOCK'
    )
  },

  analyze: {
    resetLearningLock: namespacedLongKey('ADMIN:RESET_LEARNING:LOCK'),

    freezeLock: namespacedLongKey(
      KEYS.long?.analyze?.freezeLock ||
        KEYS.analyze?.longFreezeLock ||
        KEYS.analyze?.freezeLock,
      'ANALYZE:WEEKLY_FREEZE_LOCK'
    ),

    activateLock: namespacedLongKey(
      KEYS.long?.analyze?.activateLock ||
        KEYS.analyze?.longActivateLock ||
        KEYS.analyze?.activateLock,
      'ANALYZE:ROTATION_ACTIVATE_LOCK'
    ),

    nextRotation: namespacedLongKey(
      KEYS.long?.analyze?.nextRotation ||
        KEYS.analyze?.longNextRotation ||
        KEYS.analyze?.nextRotation,
      'ANALYZE:NEXT_ROTATION'
    ),

    rotationValidFrom: namespacedLongKey(
      KEYS.long?.analyze?.rotationValidFrom ||
        KEYS.analyze?.longRotationValidFrom ||
        KEYS.analyze?.rotationValidFrom,
      'ANALYZE:ROTATION_VALID_FROM'
    ),

    activeRotation: namespacedLongKey(
      KEYS.long?.analyze?.activeRotation ||
        KEYS.analyze?.longActiveRotation ||
        KEYS.analyze?.activeRotation,
      'ANALYZE:ACTIVE_ROTATION'
    ),

    obsLastPattern: namespacedLongPattern(
      KEYS.long?.analyze?.obsLastPattern ||
        KEYS.analyze?.longObsLastPattern,
      'ANALYZE:OBS:LAST:*'
    ),

    outcomePattern: namespacedLongPattern(
      KEYS.long?.analyze?.outcomePattern ||
        KEYS.analyze?.longOutcomePattern,
      'ANALYZE:OUTCOME:*'
    ),

    shadowPattern: namespacedLongPattern(
      KEYS.long?.analyze?.shadowPattern ||
        KEYS.analyze?.longShadowPattern,
      'ANALYZE:SHADOW:*'
    ),

    microPattern: namespacedLongPattern(
      KEYS.long?.analyze?.microPattern ||
        KEYS.analyze?.longMicroPattern,
      'ANALYZE:MICRO:*'
    ),

    weekPattern: namespacedLongPattern(
      KEYS.long?.analyze?.weekPattern ||
        KEYS.analyze?.longWeekPattern,
      'ANALYZE:WEEK:*'
    )
  }
};

const LOCK_KEYS = {
  resetLearning: LONG_KEYS.analyze.resetLearningLock,
  trade: LONG_KEYS.trade.lock,
  freeze: LONG_KEYS.analyze.freezeLock,
  activate: LONG_KEYS.analyze.activateLock
};

function now() {
  return Date.now();
}

function modeFlags() {
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

    virtualOnly: true,
    virtualLearning: true,
    virtualLearningForced: true,
    virtualTracked: true,
    shadowOnly: true,
    virtualOutcomesIncluded: true,
    shadowOutcomesIncluded: true,
    realOutcomesExcluded: true,
    learningOutcomesOnly: true,
    outcomesSourceMode: 'VIRTUAL_AND_SHADOW_NET_OUTCOMES',
    outcomeSource: 'VIRTUAL',

    observationFirst: true,
    observationFirstAnalyze: true,
    netOutcomesOnly: true,
    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',

    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,

    globalMaxOpenPositionsBlockDisabled: true,
    maxOneOpenPositionPerSymbol: true,

    positionTimeStopMinDefault: DEFAULT_POSITION_TIME_STOP_MIN,

    scannerSide: TARGET_DASHBOARD_SIDE,
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,

    bucketsCoarseOnly: true,
    bucketGranularity: 'LOW_MID_HIGH',

    manualSelectionOnly: true,
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    manualSelectionPreserved: true,
    activeRotationPreserved: true,
    autoRotationActivationDisabled: true,
    activateFreezeCronDisabled: true,
    resetCronDisabled: true,
    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForExactTrueMicroMatch: true,

    minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,
    statusRules: {
      OBSERVING: 'completed == 0',
      EARLY_OUTCOMES: `completed > 0 && completed < ${MIN_COMPLETED_ACTIVE_LEARNING}`,
      ACTIVE_LEARNING: `completed >= ${MIN_COMPLETED_ACTIVE_LEARNING}`
    },

    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    weekResetDisabled: true,
    isoWeekLearningDisabled: true,

    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    redisKeysSeparatedFromShortRoot: true,
    shortRootTouched: false
  };
}

function methodNotAllowed(res) {
  res.setHeader('Allow', 'POST');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['POST'],
    ...modeFlags()
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

function isConfirmed(body = {}) {
  return (
    body.confirm === CONFIRM_TEXT ||
    body.confirmed === CONFIRM_TEXT ||
    body.confirmation === CONFIRM_TEXT
  );
}

function isTrue(value) {
  return (
    value === true ||
    value === 'true' ||
    value === 'TRUE' ||
    value === 1 ||
    value === '1' ||
    value === 'yes' ||
    value === 'YES' ||
    value === 'on' ||
    value === 'ON'
  );
}

function wantsForbiddenRotationReset(body = {}) {
  return (
    isTrue(body.resetRotation) ||
    isTrue(body.clearRotation) ||
    isTrue(body.resetManualSelection) ||
    isTrue(body.clearManualSelection) ||
    isTrue(body.wipeRotation)
  );
}

async function acquireLock(redis, key, token) {
  if (!redis || !key || !token) return true;

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
  if (!key) {
    return {
      ok: true,
      acquired
    };
  }

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
  if (!redis || !key) return 0;

  return redis.del(key).catch(() => 0);
}

async function delPatternSafe(redis, pattern, count = DELETE_SCAN_COUNT) {
  if (!redis || !pattern) return 0;

  return delPattern(redis, pattern, count).catch(() => 0);
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .flatMap((value) => Array.isArray(value) ? value : [value])
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
    PERSISTENT_LEARNING_KEY,
    getPreviousIsoWeekKey(),
    getIsoWeekKey(),
    firstValue(body.weekKey, null),
    firstValue(body.currentWeekKey, null),
    firstValue(body.previousWeekKey, null),
    ...(Array.isArray(body.weekKeys) ? body.weekKeys : [])
  ]);
}

function baseWeekMicrosKey(weekKey) {
  if (typeof KEYS.long?.analyze?.weekMicros === 'function') {
    return KEYS.long.analyze.weekMicros(weekKey);
  }

  if (typeof KEYS.analyze?.longWeekMicros === 'function') {
    return KEYS.analyze.longWeekMicros(weekKey);
  }

  if (typeof KEYS.analyze?.weekMicros === 'function') {
    return KEYS.analyze.weekMicros(weekKey);
  }

  return `ANALYZE:WEEK:${weekKey}:MICROS`;
}

function baseWeekMetaKey(weekKey) {
  if (typeof KEYS.long?.analyze?.weekMeta === 'function') {
    return KEYS.long.analyze.weekMeta(weekKey);
  }

  if (typeof KEYS.analyze?.longWeekMeta === 'function') {
    return KEYS.analyze.longWeekMeta(weekKey);
  }

  if (typeof KEYS.analyze?.weekMeta === 'function') {
    return KEYS.analyze.weekMeta(weekKey);
  }

  return `ANALYZE:WEEK:${weekKey}:META`;
}

function weekMicrosKey(weekKey) {
  return namespacedLongKey(baseWeekMicrosKey(weekKey));
}

function weekMetaKey(weekKey) {
  return namespacedLongKey(baseWeekMetaKey(weekKey));
}

function getWeekStorageKeys(weekKey) {
  const base = weekMicrosKey(weekKey);

  return [
    base,
    `${base}:INDEX`,
    `${base}:TOP`,
    weekMetaKey(weekKey)
  ].filter(Boolean);
}

function getWeekRowPatterns(weekKey) {
  const base = weekMicrosKey(weekKey);

  return [
    `${base}:ROW:*`
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

async function deletePatterns(redis, patterns = []) {
  const safePatterns = uniqueStrings(patterns);

  if (!safePatterns.length) return 0;

  let deleted = 0;

  for (const pattern of safePatterns) {
    deleted += await delPatternSafe(redis, pattern);
  }

  return deleted;
}

async function runLearningDeleteSteps(redis, body = {}) {
  const allWeeks = isTrue(body.allWeeks ?? body.full ?? true);
  const weekKeys = getWeekKeyCandidates(body);

  const weekMainKeys = weekKeys.flatMap(getWeekStorageKeys);
  const weekRowPatterns = weekKeys.flatMap(getWeekRowPatterns);

  const deleted = {
    weekKeys,
    allWeeks,

    exactWeekStorageKeys: await deleteExactKeys(redis, weekMainKeys),
    shardedWeekRows: await deletePatterns(redis, weekRowPatterns),

    observationDedupe: await delPatternSafe(
      redis,
      LONG_KEYS.analyze.obsLastPattern
    ),

    outcomeDedupe: await delPatternSafe(
      redis,
      LONG_KEYS.analyze.outcomePattern
    ),

    shadowAnalyzeData: await delPatternSafe(
      redis,
      LONG_KEYS.analyze.shadowPattern
    ),

    legacyMicroData: await delPatternSafe(
      redis,
      LONG_KEYS.analyze.microPattern
    )
  };

  if (allWeeks) {
    deleted.allWeekAnalyzeData = await delPatternSafe(
      redis,
      LONG_KEYS.analyze.weekPattern
    );
  } else {
    deleted.allWeekAnalyzeData = 0;
  }

  // Active rotation is manual selection and stays preserved.
  // Pending/legacy rotation state is cleared only in LONG namespace to prevent auto activation.
  deleted.nextRotation = await delKey(
    redis,
    LONG_KEYS.analyze.nextRotation
  );

  deleted.rotationValidFrom = await delKey(
    redis,
    LONG_KEYS.analyze.rotationValidFrom
  );

  deleted.activeRotation = 0;

  return deleted;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Reset-Learning-Mode', 'long-only-virtual-learning-v2');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Long-Only', 'true');
  res.setHeader('X-Short-Disabled', 'true');
  res.setHeader('X-Virtual-Only', 'true');
  res.setHeader('X-Virtual-Learning-Forced', 'true');
  res.setHeader('X-Net-Outcomes-Only', 'true');
  res.setHeader('X-Manual-Selection-Preserved', 'true');
  res.setHeader('X-Manual-Selection-Match-Mode', 'EXACT_TRUE_MICRO_FAMILY_ID');
  res.setHeader('X-Active-Rotation-Preserved', 'true');
  res.setHeader('X-Real-Orders-Disabled', 'true');
  res.setHeader('X-Bitget-Orders-Disabled', 'true');
  res.setHeader('X-Exchange-Calls-Disabled', 'true');
  res.setHeader('X-Redis-Namespace', LONG_NAMESPACE);
  res.setHeader('X-Short-Root-Touched', 'false');

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
        reason: 'LONG_CONFIRMATION_REQUIRED',
        required: CONFIRM_TEXT,
        ...modeFlags()
      });
    }

    if (wantsForbiddenRotationReset(body)) {
      return res.status(400).json({
        ok: false,
        blocked: true,
        reason: 'LONG_ROTATION_RESET_NOT_ALLOWED_HERE',
        note: 'reset-learning wist alleen LONG leerdata. Handmatige LONG selectie blijft bewaard.',
        ...modeFlags()
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
        ...modeFlags()
      });
    }

    const deleted = await runLearningDeleteSteps(redis, body);

    const report = {
      ok: true,
      type: 'RESET_LEARNING_LONG_ONLY_VIRTUAL',

      ...modeFlags(),

      exchangeTouched: false,
      bitgetOrdersTouched: false,
      realOrdersTouched: false,

      deleted,

      preserved: {
        shortRoot: true,
        shortRedisKeys: true,
        activeRotation: true,
        manualSelection: true,
        openVirtualPositions: true,
        scannerSnapshots: true,
        tradeRunMeta: true,
        resetLogs: true,
        discordLogs: true,
        environmentVariables: true,
        deploymentConfig: true
      },

      removed: {
        weekMicros: true,
        weekMeta: true,
        weekTopSnapshots: true,
        shardedWeekRows: true,
        observationDedupe: true,
        outcomeDedupe: true,
        shadowAnalyzeData: true,
        legacyMicroData: true,
        nextRotation: true,
        rotationValidFrom: true,
        activeRotation: false,
        manualSelection: false,
        openVirtualPositions: false,
        scannerSnapshots: false,
        tradeRunMeta: false,
        discordLogs: false
      },

      longKeys: {
        namespace: LONG_NAMESPACE,
        prefix: LONG_KEY_PREFIX,
        resetLogList: LONG_KEYS.reset.logList,
        locks: LOCK_KEYS,
        analyze: LONG_KEYS.analyze
      },

      resetAt: now()
    };

    await pushJsonLog(
      redis,
      LONG_KEYS.reset.logList,
      report,
      100
    ).catch(() => null);

    await sendResetReport(report).catch(() => null);

    return res.status(200).json(report);
  } catch (error) {
    const status = error.statusCode || 500;

    return res.status(status).json({
      ok: false,
      ...modeFlags(),

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