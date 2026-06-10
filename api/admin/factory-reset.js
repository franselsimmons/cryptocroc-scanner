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
import { sideToTradeSide } from '../../src/utils.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;

const LOCK_TTL_SEC = 300;
const DEFAULT_CONFIRM_TEXT = 'LONG_FACTORY_RESET_CONFIRMED';
const DEFAULT_ROTATION_CONFIRM_TEXT = 'LONG_RESET_ROTATION_CONFIRMED';

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
  scan: {
    lock: namespacedLongKey(
      KEYS.long?.scan?.lock ||
        KEYS.scan?.longLock ||
        KEYS.scan?.lock,
      'SCAN:LOCK'
    ),
    snapshotPattern: namespacedLongPattern(
      KEYS.long?.scan?.snapshotPattern ||
        KEYS.scan?.longSnapshotPattern,
      'SCAN:SNAPSHOT:*'
    ),
    latest: namespacedLongKey(
      KEYS.long?.scan?.latest ||
        KEYS.scan?.longLatest ||
        KEYS.scan?.latest,
      'SCAN:LATEST'
    ),
    runMeta: namespacedLongKey(
      KEYS.long?.scan?.runMeta ||
        KEYS.scan?.longRunMeta ||
        KEYS.scan?.runMeta,
      'SCAN:RUN_META'
    )
  },

  trade: {
    lock: namespacedLongKey(
      KEYS.long?.trade?.lock ||
        KEYS.trade?.longLock ||
        KEYS.trade?.lock,
      'TRADE:LOCK'
    ),
    openPattern: namespacedLongPattern(
      KEYS.long?.trade?.openPattern ||
        KEYS.trade?.longOpenPattern,
      'TRADE:OPEN:*'
    ),
    lastProcessedSnapshot: namespacedLongKey(
      KEYS.long?.trade?.lastProcessedSnapshot ||
        KEYS.trade?.longLastProcessedSnapshot ||
        KEYS.trade?.lastProcessedSnapshot,
      'TRADE:LAST_PROCESSED_SNAPSHOT'
    ),
    runMeta: namespacedLongKey(
      KEYS.long?.trade?.runMeta ||
        KEYS.trade?.longRunMeta ||
        KEYS.trade?.runMeta,
      'TRADE:RUN_META'
    )
  },

  analyze: {
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
    ),
    weekPattern: namespacedLongPattern(
      KEYS.long?.analyze?.weekPattern ||
        KEYS.analyze?.longWeekPattern,
      'ANALYZE:WEEK:*'
    ),
    microPattern: namespacedLongPattern(
      KEYS.long?.analyze?.microPattern ||
        KEYS.analyze?.longMicroPattern,
      'ANALYZE:MICRO:*'
    ),
    obsLastPattern: namespacedLongPattern(
      KEYS.long?.analyze?.obsLastPattern ||
        KEYS.analyze?.longObsLastPattern,
      'ANALYZE:OBS:LAST:*'
    ),
    shadowPattern: namespacedLongPattern(
      KEYS.long?.analyze?.shadowPattern ||
        KEYS.analyze?.longShadowPattern,
      'ANALYZE:SHADOW:*'
    ),
    outcomePattern: namespacedLongPattern(
      KEYS.long?.analyze?.outcomePattern ||
        KEYS.analyze?.longOutcomePattern,
      'ANALYZE:OUTCOME:*'
    )
  },

  reset: {
    logList: namespacedLongKey(
      KEYS.long?.reset?.logList ||
        KEYS.reset?.longLogList ||
        KEYS.reset?.logList,
      'RESET:LOGS'
    )
  },

  circuit: {
    pausedPattern: namespacedLongPattern(
      KEYS.long?.circuit?.pausedPattern ||
        KEYS.circuit?.longPausedPattern,
      'CIRCUIT:PAUSED:*'
    )
  },

  cache: {
    livePattern: namespacedLongPattern(
      KEYS.long?.cache?.livePattern ||
        KEYS.cache?.longLivePattern,
      'LIVE:CACHE:*'
    ),
    marketPattern: namespacedLongPattern(
      KEYS.long?.cache?.marketPattern ||
        KEYS.cache?.longMarketPattern,
      'MARKET:CACHE:*'
    ),
    bitgetPattern: namespacedLongPattern(
      KEYS.long?.cache?.bitgetPattern ||
        KEYS.cache?.longBitgetPattern,
      'BITGET:CACHE:*'
    )
  },

  discord: {
    logList: namespacedLongKey(
      KEYS.long?.discord?.logList ||
        KEYS.discord?.longLogList ||
        KEYS.discordLong?.logList ||
        KEYS.discord?.logList,
      'DISCORD:LOGS'
    )
  }
};

const LOCK_KEYS = {
  admin: namespacedLongKey('ADMIN:FACTORY_RESET:LOCK'),
  scanner: LONG_KEYS.scan.lock,
  trade: LONG_KEYS.trade.lock,
  freeze: LONG_KEYS.analyze.freezeLock,
  activate: LONG_KEYS.analyze.activateLock
};

function now() {
  return Date.now();
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

    virtualLearningForced: true,
    virtualPositionsOnly: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,

    maxOneOpenPositionPerSymbol: true,
    globalMaxOpenPositionsBlockDisabled: true,

    manualSelectionRequired: true,
    discordOnlyForSelectedMicroFamilies: true,
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',

    scannerSide: TARGET_DASHBOARD_SIDE,
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsUsedAsLearningFamily: false,

    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    analyzeMicroFamiliesOnly: true,
    symbolExcludedFromFamilyId: true,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winrateDefinition: 'netR > 0',

    autoRotationActivationDisabled: true,
    manualRotationPreservedByDefault: true,
    explicitRotationResetRequired: true,
    resetCronDisabled: true,
    activateFreezeCronDisabled: true,

    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    redisKeysSeparatedFromShortRoot: true,
    shortRootTouched: false
  };
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

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function cleanSideText(value = '') {
  return upper(value)
    .replaceAll('SHORT_DISABLED', '')
    .replaceAll('SHORTDISABLED', '')
    .replaceAll('BLOCK_SHORT', '')
    .replaceAll('SHORT_ENABLED_FALSE', '')
    .replaceAll('SHORT_ONLY_FALSE', '')
    .replaceAll('LONG_DISABLED_FALSE', '')
    .replaceAll('LONG_ENABLED_FALSE', '')
    .replaceAll('LONG_ONLY_FALSE', '')
    .replaceAll('LONG_ONLY_MODE', 'LONG')
    .replaceAll('LONG_ONLY', 'LONG')
    .replaceAll('LONG-ONLY', 'LONG');
}

function normalizeSideToken(value) {
  const raw = cleanSideText(value);

  if (!raw) return 'UNKNOWN';

  const direct = sideToTradeSide(raw);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  if (['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'UPSIDE'].includes(raw)) {
    return TARGET_TRADE_SIDE;
  }

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE'].includes(raw)) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function hasLongSignal(text = '') {
  const raw = ` ${cleanSideText(text)} `;

  return (
    raw.includes('TRADE_SIDE=LONG') ||
    raw.includes('TRADESIDE=LONG') ||
    raw.includes('SIDE=LONG') ||
    raw.includes('POSITION_SIDE=LONG') ||
    raw.includes('POSITIONSIDE=LONG') ||
    raw.includes('DIRECTION=LONG') ||
    raw.includes('SIDE=BULL') ||
    raw.includes('DIRECTION=BULL') ||
    raw.includes('SIDE=BUY') ||
    raw.includes('DIRECTION=BUY') ||
    raw.includes('MICRO_LONG_') ||
    raw.includes(' LONG_') ||
    raw.includes('_LONG ') ||
    raw.includes('_LONG_') ||
    raw.includes('|LONG|') ||
    raw.includes(':LONG') ||
    raw.includes('=LONG') ||
    raw.includes(' BULL ') ||
    raw.includes('_BULL') ||
    raw.includes('BULL_') ||
    raw.includes('|BULL|') ||
    raw.includes(':BULL') ||
    raw.includes('=BULL') ||
    raw.includes(' BUY ') ||
    raw.includes('_BUY') ||
    raw.includes('BUY_') ||
    raw.includes('|BUY|') ||
    raw.includes(':BUY') ||
    raw.includes('=BUY')
  );
}

function hasShortSignal(text = '') {
  const raw = ` ${cleanSideText(text)} `;

  return (
    raw.includes('TRADE_SIDE=SHORT') ||
    raw.includes('TRADESIDE=SHORT') ||
    raw.includes('SIDE=SHORT') ||
    raw.includes('POSITION_SIDE=SHORT') ||
    raw.includes('POSITIONSIDE=SHORT') ||
    raw.includes('DIRECTION=SHORT') ||
    raw.includes('SIDE=BEAR') ||
    raw.includes('DIRECTION=BEAR') ||
    raw.includes('SIDE=SELL') ||
    raw.includes('DIRECTION=SELL') ||
    raw.includes('MICRO_SHORT_') ||
    raw.includes(' SHORT_') ||
    raw.includes('_SHORT ') ||
    raw.includes('_SHORT_') ||
    raw.includes('|SHORT|') ||
    raw.includes(':SHORT') ||
    raw.includes('=SHORT') ||
    raw.includes(' BEAR ') ||
    raw.includes('_BEAR') ||
    raw.includes('BEAR_') ||
    raw.includes('|BEAR|') ||
    raw.includes(':BEAR') ||
    raw.includes('=BEAR') ||
    raw.includes(' SELL ') ||
    raw.includes('_SELL') ||
    raw.includes('SELL_') ||
    raw.includes('|SELL|') ||
    raw.includes(':SELL') ||
    raw.includes('=SELL')
  );
}

function inferPositionTradeSide(position = {}) {
  const directSources = [
    position.tradeSide,
    position.positionSide,
    position.direction,
    position.side,
    position.signalSide,
    position.scannerSide,
    position.analysisSide
  ];

  for (const source of directSources) {
    const side = normalizeSideToken(source);

    if (side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE) return side;
  }

  const text = [
    position.tradeSide,
    position.positionSide,
    position.direction,
    position.side,
    position.signalSide,
    position.scannerSide,
    position.analysisSide,

    position.familyId,
    position.macroFamilyId,
    position.parentMacroFamilyId,
    position.parentMicroFamilyId,
    position.microFamilyId,
    position.trueMicroFamilyId,
    position.coarseMicroFamilyId,

    position.tradeId,
    position.key,
    position.redisKey,
    position.positionKey
  ]
    .map((value) => cleanSideText(value))
    .filter(Boolean)
    .join(' | ');

  const longSignal = hasLongSignal(text);
  const shortSignal = hasShortSignal(text);

  if (longSignal && !shortSignal) return TARGET_TRADE_SIDE;
  if (shortSignal && !longSignal) return OPPOSITE_TRADE_SIDE;

  if (longSignal && shortSignal) {
    const microId = cleanSideText(
      position.trueMicroFamilyId ||
        position.microFamilyId ||
        position.coarseMicroFamilyId ||
        ''
    );

    if (microId.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
    if (microId.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
  }

  if (position.longOnly === true || position.shortDisabled === true) return TARGET_TRADE_SIDE;
  if (position.shortOnly === true || position.longDisabled === true) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function isLongNamespacedPosition(position = {}) {
  return [
    position.key,
    position.redisKey,
    position.positionKey
  ]
    .filter(Boolean)
    .some((key) => String(key).startsWith(LONG_KEY_PREFIX));
}

function isLongPosition(position = {}) {
  const side = inferPositionTradeSide(position);

  if (side === TARGET_TRADE_SIDE) return true;
  if (side === OPPOSITE_TRADE_SIDE) return false;

  return isLongNamespacedPosition(position);
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

async function getLongOpenPositions() {
  const rawPositions = await getOpenPositions({
    tradeSide: TARGET_TRADE_SIDE,
    side: TARGET_DASHBOARD_SIDE,
    namespace: LONG_NAMESPACE,
    keyPrefix: LONG_KEY_PREFIX,
    virtualOnly: true
  });

  return (Array.isArray(rawPositions) ? rawPositions : [])
    .filter(isLongPosition);
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

    microFamilyId: position.trueMicroFamilyId || position.microFamilyId || null,
    trueMicroFamilyId: position.trueMicroFamilyId || position.microFamilyId || null,
    coarseMicroFamilyId:
      position.coarseMicroFamilyId ||
      position.trueMicroFamilyId ||
      position.microFamilyId ||
      null,

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

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    source: source === 'VIRTUAL' || source === 'SHADOW' || source === 'PAPER'
      ? 'VIRTUAL'
      : source,

    outcomeSource: 'VIRTUAL',
    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: position.shadowOnly !== false,

    exchangeTouched: false,
    bitgetOrdersTouched: false,
    realOrdersTouched: false,

    entry: position.entry ?? position.entryPrice ?? null,
    sl: position.sl ?? position.stopLoss ?? position.initialSl ?? null,
    tp: position.tp ?? position.takeProfit ?? null,
    initialSl: position.initialSl ?? position.sl ?? position.stopLoss ?? null,

    currentPrice: position.currentPrice ?? position.lastPrice ?? null,
    lastPrice: position.lastPrice ?? position.currentPrice ?? null,

    ageSec: position.ageSec ?? null,
    currentR: position.currentR ?? null,
    mfeR: position.mfeR ?? null,
    maeR: position.maeR ?? null,

    reachedHalfR: Boolean(position.reachedHalfR),
    reachedOneR: Boolean(position.reachedOneR),
    nearTpSeen: Boolean(position.nearTpSeen),

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

  // Scanner volatile data — LONG namespace only.
  deleted.scanSnapshots = await delPatternSafe(
    volatile,
    LONG_KEYS.scan.snapshotPattern,
    10000
  );

  deleted.scanLatest = await delKey(
    volatile,
    LONG_KEYS.scan.latest
  );

  deleted.scanRunMeta = await delKey(
    volatile,
    LONG_KEYS.scan.runMeta
  );

  // Trade durable data — LONG virtual open positions only.
  deleted.tradeOpenVirtualPositions = await delPatternSafe(
    durable,
    LONG_KEYS.trade.openPattern,
    10000
  );

  deleted.tradeLastProcessed = await delKey(
    durable,
    LONG_KEYS.trade.lastProcessedSnapshot
  );

  deleted.tradeMeta = await delKey(
    durable,
    LONG_KEYS.trade.runMeta
  );

  deleted.tradeLocks = 0;

  // Circuit breakers / optional safety state — LONG namespace only.
  deleted.circuitPaused = await delPatternSafe(
    durable,
    LONG_KEYS.circuit.pausedPattern,
    10000
  );

  // Analyze learning data — LONG namespace only.
  deleted.analyzeWeeks = await delPatternSafe(
    durable,
    LONG_KEYS.analyze.weekPattern,
    10000
  );

  deleted.analyzeMicros = await delPatternSafe(
    durable,
    LONG_KEYS.analyze.microPattern,
    10000
  );

  deleted.analyzeObsLast = await delPatternSafe(
    durable,
    LONG_KEYS.analyze.obsLastPattern,
    10000
  );

  deleted.analyzeShadow = await delPatternSafe(
    durable,
    LONG_KEYS.analyze.shadowPattern,
    10000
  );

  deleted.analyzeOutcomeDedupe = await delPatternSafe(
    durable,
    LONG_KEYS.analyze.outcomePattern,
    10000
  );

  // Rotation policy:
  // - activeRotation = handmatige Discord/selectie, standaard bewaren.
  // - nextRotation/validFrom = pending/legacy state, altijd verwijderen tegen auto-activatie.
  if (resetRotation) {
    deleted.activeRotation = await delKey(
      durable,
      LONG_KEYS.analyze.activeRotation
    );
  } else {
    deleted.activeRotation = 0;
    preserved.activeRotation = true;
  }

  deleted.nextRotation = await delKey(
    durable,
    LONG_KEYS.analyze.nextRotation
  );

  deleted.rotationValidFrom = await delKey(
    durable,
    LONG_KEYS.analyze.rotationValidFrom
  );

  // Volatile live cache — LONG namespace only.
  deleted.liveCache = await delPatternSafe(
    volatile,
    LONG_KEYS.cache.livePattern,
    10000
  );

  deleted.marketCache = await delPatternSafe(
    volatile,
    LONG_KEYS.cache.marketPattern,
    10000
  );

  deleted.bitgetCache = await delPatternSafe(
    volatile,
    LONG_KEYS.cache.bitgetPattern,
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
  res.setHeader('X-Admin-Factory-Reset-Mode', 'long-only-virtual-learning-v3');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Long-Only', 'true');
  res.setHeader('X-Short-Disabled', 'true');
  res.setHeader('X-Real-Orders-Disabled', 'true');
  res.setHeader('X-Bitget-Orders-Disabled', 'true');
  res.setHeader('X-Exchange-Calls-Disabled', 'true');
  res.setHeader('X-Virtual-Learning-Forced', 'true');
  res.setHeader('X-Virtual-Positions-Only', 'true');
  res.setHeader('X-Manual-Rotation-Preserved-By-Default', 'true');
  res.setHeader('X-Manual-Selection-Match-Mode', 'EXACT_TRUE_MICRO_FAMILY_ID');
  res.setHeader('X-Redis-Namespace', LONG_NAMESPACE);
  res.setHeader('X-Short-Root-Touched', 'false');

  const token = randomUUID();
  let acquiredLocks = [];

  try {
    if (req.method !== 'POST') {
      return methodNotAllowed(res);
    }

    const body = await readBody(req);

    const requiredConfirmText =
      CONFIG.long?.reset?.confirmText ||
      CONFIG.reset?.longConfirmText ||
      DEFAULT_CONFIRM_TEXT;

    const requiredRotationConfirmText =
      CONFIG.long?.reset?.rotationConfirmText ||
      CONFIG.reset?.longRotationConfirmText ||
      DEFAULT_ROTATION_CONFIRM_TEXT;

    const confirmed = isConfirmed(body, requiredConfirmText);
    const resetRotation = wantsRotationReset(body);

    const forceDeleteVirtualPositions =
      isTrue(body.force) ||
      isTrue(body.forceDeleteVirtualPositions) ||
      isTrue(body.forceClosePositions);

    if (!confirmed) {
      return res.status(400).json(
        buildBlockedResponse({
          reason: 'LONG_CONFIRMATION_REQUIRED',
          extra: {
            required: requiredConfirmText
          }
        })
      );
    }

    if (resetRotation && !isRotationResetConfirmed(body, requiredRotationConfirmText)) {
      return res.status(400).json(
        buildBlockedResponse({
          reason: 'LONG_ROTATION_RESET_CONFIRMATION_REQUIRED',
          extra: {
            required: requiredRotationConfirmText,
            note: 'activeRotation bevat je handmatige LONG micro-family keuze en wordt standaard bewaard.'
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

    const openPositions = await getLongOpenPositions();

    if (openPositions.length > 0 && !forceDeleteVirtualPositions) {
      return res.status(409).json(
        buildBlockedResponse({
          reason: 'LONG_OPEN_VIRTUAL_POSITIONS_EXIST',
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
        shortRoot: true,
        shortRedisKeys: true,
        resetLogs: true,
        discordLogs: true,
        discordLogKey: LONG_KEYS.discord.logList,
        environmentVariables: true,
        deploymentConfig: true,
        activeRotation: !resetRotation
      },

      longKeys: {
        namespace: LONG_NAMESPACE,
        prefix: LONG_KEY_PREFIX,
        scan: LONG_KEYS.scan,
        trade: LONG_KEYS.trade,
        analyze: LONG_KEYS.analyze,
        reset: LONG_KEYS.reset,
        discord: LONG_KEYS.discord
      },

      resetAt: now()
    };

    await pushJsonLog(
      durable,
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