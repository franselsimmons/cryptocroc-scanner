// ================= FILE: src/keys.js =================

const keyPart = (value, fallback = 'UNKNOWN') => {
  const raw = value === undefined || value === null || value === ''
    ? fallback
    : value;

  return String(raw)
    .trim()
    .replaceAll(':', '_')
    .replaceAll('|', '_')
    .replace(/\s+/g, '_');
};

const symbolPart = (value, fallback = 'UNKNOWN') => {
  return keyPart(value, fallback)
    .toUpperCase()
    .replace(/[^A-Z0-9_.-]/g, '_');
};

const deepFreeze = (object) => {
  Object.freeze(object);

  for (const value of Object.values(object)) {
    if (
      value &&
      typeof value === 'object' &&
      !Object.isFrozen(value)
    ) {
      deepFreeze(value);
    }
  }

  return object;
};

export const KEYS = deepFreeze({
  scan: {
    latest: 'SCAN:LATEST',
    lock: 'SCAN:LOCK',

    snapshot: (snapshotId) => `SCAN:SNAPSHOT:${keyPart(snapshotId)}`,
    snapshotPattern: 'SCAN:SNAPSHOT:*'
  },

  live: {
    cache: (symbol, type) => `LIVE:CACHE:${symbolPart(symbol)}:${keyPart(type)}`,
    cachePattern: 'LIVE:CACHE:*'
  },

  trade: {
    lock: 'TRADE:LOCK',
    runMeta: 'TRADE:RUN:META',

    lastProcessedSnapshot: 'TRADE:LAST_PROCESSED_SNAPSHOT',

    open: (symbol) => `TRADE:OPEN:${symbolPart(symbol)}`,
    openPattern: 'TRADE:OPEN:*'
  },

  analyze: {
    obsLast: (snapshotId, symbol, microFamilyId) => (
      `ANALYZE:OBS:LAST:${keyPart(snapshotId)}:${symbolPart(symbol)}:${keyPart(microFamilyId)}`
    ),
    obsLastPattern: 'ANALYZE:OBS:LAST:*',

    shadowLast: (symbol, microFamilyId) => (
      `ANALYZE:SHADOW:LAST:${symbolPart(symbol)}:${keyPart(microFamilyId)}`
    ),
    shadowLastPattern: 'ANALYZE:SHADOW:LAST:*',

    shadowOpen: (id) => `ANALYZE:SHADOW:OPEN:${keyPart(id)}`,
    shadowOpenPattern: 'ANALYZE:SHADOW:OPEN:*',
    shadowPattern: 'ANALYZE:SHADOW:*',

    microStats: (microFamilyId) => `ANALYZE:MICRO:${keyPart(microFamilyId)}:STATS`,
    microRegimeStats: (microFamilyId) => `ANALYZE:MICRO:${keyPart(microFamilyId)}:REGIME`,
    microPattern: 'ANALYZE:MICRO:*',

    weekMicros: (weekKey) => `ANALYZE:WEEK:${keyPart(weekKey)}:MICROS`,
    weekMeta: (weekKey) => `ANALYZE:WEEK:${keyPart(weekKey)}:META`,
    weekPattern: 'ANALYZE:WEEK:*',

    activeRotation: 'ANALYZE:ACTIVE_ROTATION',
    nextRotation: 'ANALYZE:NEXT_ROTATION',
    rotationValidFrom: 'ANALYZE:ROTATION_VALID_FROM',

    freezeLock: 'ANALYZE:WEEKLY_FREEZE_LOCK',
    activateLock: 'ANALYZE:ROTATION_ACTIVATE_LOCK'
  },

  circuit: {
    paused: (microFamilyId) => `CIRCUIT:PAUSED:${keyPart(microFamilyId)}`,
    pausedPattern: 'CIRCUIT:PAUSED:*'
  },

  discord: {
    logList: 'DISCORD:LOGS'
  },

  reset: {
    logList: 'RESET:LOGS'
  }
});