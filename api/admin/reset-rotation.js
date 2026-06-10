// ================= FILE: api/admin/reset-rotation.js =================

import { randomUUID } from 'node:crypto';

import { KEYS } from '../../src/keys.js';
import {
  getDurableRedis,
  pushJsonLog
} from '../../src/redis.js';
import { sendResetReport } from '../../src/discord/discord.js';

const CONFIRM_TEXT = 'RESET_ROTATION_LONG';
const LOCK_TTL_SEC = 180;

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;

const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';
const MIN_COMPLETED_ACTIVE_LEARNING = 20;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;

function namespacedLongKey(key, fallback = null) {
  const raw = String(key || fallback || '').trim();

  if (!raw) return null;
  if (raw.startsWith(LONG_KEY_PREFIX)) return raw;

  return `${LONG_KEY_PREFIX}${raw}`;
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
    resetRotationLock: namespacedLongKey('ADMIN:RESET_ROTATION:LOCK'),

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

    activeRotation: namespacedLongKey(
      KEYS.long?.analyze?.activeRotation ||
        KEYS.analyze?.longActiveRotation ||
        KEYS.analyze?.activeRotation,
      'ANALYZE:ACTIVE_ROTATION'
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
    )
  }
};

const LOCK_KEYS = {
  resetRotation: LONG_KEYS.analyze.resetRotationLock,
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
    netOutcomesOnly: true,
    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

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
    manualSelectionResetEndpoint: true,
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForExactTrueMicroMatch: true,

    autoRotationActivationDisabled: true,
    activateFreezeCronDisabled: true,
    resetCronDisabled: true,

    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    weekResetDisabled: true,
    isoWeekLearningDisabled: true,

    minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,
    statusRules: {
      OBSERVING: 'completed == 0',
      EARLY_OUTCOMES: `completed > 0 && completed < ${MIN_COMPLETED_ACTIVE_LEARNING}`,
      ACTIVE_LEARNING: `completed >= ${MIN_COMPLETED_ACTIVE_LEARNING}`
    },

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
  const clean = String(text || '').trim();

  if (!clean) return {};

  try {
    return JSON.parse(clean);
  } catch {
    const error = new Error('INVALID_JSON_BODY');
    error.statusCode = 400;
    throw error;
  }
}

async function readBody(req) {
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

function isConfirmed(body = {}) {
  return (
    body.confirm === CONFIRM_TEXT ||
    body.confirmed === CONFIRM_TEXT ||
    body.confirmation === CONFIRM_TEXT
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

async function acquireResetRotationLocks(redis, token) {
  const acquired = [];

  const steps = [
    {
      key: LOCK_KEYS.resetRotation,
      reason: 'LONG_RESET_ROTATION_ALREADY_RUNNING'
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

async function deleteRotationKeys(redis) {
  const deleted = {};

  deleted.activeRotation = await delKey(
    redis,
    LONG_KEYS.analyze.activeRotation
  );

  deleted.nextRotation = await delKey(
    redis,
    LONG_KEYS.analyze.nextRotation
  );

  deleted.rotationValidFrom = await delKey(
    redis,
    LONG_KEYS.analyze.rotationValidFrom
  );

  return deleted;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Reset-Rotation-Mode', 'long-only-manual-selection-reset-v2');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Long-Only', 'true');
  res.setHeader('X-Short-Disabled', 'true');
  res.setHeader('X-Virtual-Only', 'true');
  res.setHeader('X-Virtual-Learning-Forced', 'true');
  res.setHeader('X-Auto-Rotation-Disabled', 'true');
  res.setHeader('X-Manual-Selection-Reset', 'true');
  res.setHeader('X-Manual-Selection-Match-Mode', 'EXACT_TRUE_MICRO_FAMILY_ID');
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
        acceptedFields: ['confirm', 'confirmed', 'confirmation'],
        ...modeFlags()
      });
    }

    redis = getDurableRedis();

    const lockResult = await acquireResetRotationLocks(redis, token);
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

    const deleted = await deleteRotationKeys(redis);

    const report = {
      ok: true,
      type: 'RESET_ROTATION_LONG_ONLY_MANUAL_SELECTION',

      ...modeFlags(),

      exchangeTouched: false,
      bitgetOrdersTouched: false,
      realOrdersTouched: false,

      deleted,

      effect: {
        discordEntryAlertsDisabledUntilManualSelection: true,
        activeManualSelectionCleared: true,
        nextRotationCleared: true,
        rotationValidFromCleared: true,
        autoRotationNotActivated: true,
        systemWillContinueLearning: true,
        manualSelectionMustUseExactTrueMicroFamilyId: true
      },

      preserved: {
        shortRoot: true,
        shortRedisKeys: true,
        learning: true,
        weeklyStats: true,
        microFamilies: true,
        observations: true,
        outcomes: true,
        outcomeDedupe: true,
        openVirtualPositions: true,
        scannerSnapshots: true,
        scannerLatest: true,
        tradeMemory: true,
        tradeRunMeta: true,
        resetLogs: true,
        discordLogs: true,
        environmentVariables: true,
        deploymentConfig: true
      },

      removed: {
        activeRotation: true,
        manualSelection: true,
        nextRotation: true,
        rotationValidFrom: true,
        learning: false,
        microFamilies: false,
        observations: false,
        outcomes: false,
        openVirtualPositions: false,
        scannerSnapshots: false,
        tradeMemory: false,
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