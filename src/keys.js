// ================= FILE: src/keys.js =================

const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const TARGET_SCANNER_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';

const keyPart = (value, fallback = 'UNKNOWN') => {
  const raw = value === undefined || value === null || value === ''
    ? fallback
    : value;

  const normalized = String(raw)
    .trim()
    .replaceAll(':', '_')
    .replaceAll('|', '_')
    .replaceAll('/', '_')
    .replaceAll('\\', '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  return normalized || fallback;
};

const symbolPart = (value, fallback = 'UNKNOWN') => {
  return keyPart(value, fallback)
    .toUpperCase()
    .replace(/[^A-Z0-9_.-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || fallback;
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

const longKey = (value = '') => {
  const raw = String(value || '').trim();

  if (!raw) return LONG_KEY_PREFIX;
  if (raw.startsWith(LONG_KEY_PREFIX)) return raw;

  return `${LONG_KEY_PREFIX}${raw}`;
};

const WRITE_SCOPE_NAMES = {
  SCANNER_RUN: 'SCANNER_RUN',
  TRADE_RUN: 'TRADE_RUN',
  ANALYZE_PARTIAL: 'ANALYZE_PARTIAL',
  ADMIN_READONLY: 'ADMIN_READONLY',
  MANUAL_ROTATION: 'MANUAL_ROTATION',
  FACTORY_RESET: 'FACTORY_RESET'
};

const exact = (key) => ({
  type: 'exact',
  value: key
});

const prefix = (value) => ({
  type: 'prefix',
  value
});

const pattern = (value) => ({
  type: 'pattern',
  value
});

const normalizeKey = (key) => String(key || '').trim();

const ruleMatches = (rule, key) => {
  const value = normalizeKey(key);

  if (!value || !rule) return false;

  if (rule.type === 'exact') return value === rule.value;
  if (rule.type === 'prefix') return value.startsWith(rule.value);

  if (rule.type === 'pattern') {
    const raw = String(rule.value || '');

    if (raw.endsWith('*')) {
      return value.startsWith(raw.slice(0, -1));
    }

    return value === raw;
  }

  return false;
};

const buildKeyScope = ({
  name,
  description,
  allowed = [],
  denied = [],
  readonly = false
}) => ({
  name,
  description,
  readonly,
  allowed,
  denied,

  namespace: LONG_NAMESPACE,
  keyPrefix: LONG_KEY_PREFIX,
  targetTradeSide: TARGET_TRADE_SIDE,
  dashboardSide: TARGET_DASHBOARD_SIDE,
  scannerSide: TARGET_SCANNER_SIDE,
  oppositeTradeSide: OPPOSITE_TRADE_SIDE,

  longOnly: true,
  shortDisabled: true,
  shortOnly: false,
  longDisabled: false,

  virtualOnly: true,
  realOrdersDisabled: true,
  bitgetOrdersDisabled: true,
  exchangeOrdersDisabled: true
});

const NON_LONG_WRITE_DENY_PATTERNS = [
  pattern('SCAN:*'),
  pattern('LIVE:*'),
  pattern('TRADE:*'),
  pattern('ANALYZE:*'),
  pattern('CIRCUIT:*'),
  pattern('DISCORD:*'),
  pattern('RESET:*'),
  pattern('SHORT:*')
];

const SCAN_LATEST_KEY = longKey('SCAN:LATEST');
const SCAN_LOCK_KEY = longKey('SCAN:LOCK');
const SCAN_RUN_META_KEY = longKey('SCAN:RUN:META');
const SCAN_SNAPSHOT_PREFIX = longKey('SCAN:SNAPSHOT:');

const LIVE_CACHE_PREFIX = longKey('LIVE:CACHE:');

const TRADE_LOCK_KEY = longKey('TRADE:LOCK');
const TRADE_RUN_META_KEY = longKey('TRADE:RUN:META');
const TRADE_LAST_PROCESSED_SNAPSHOT_KEY = longKey('TRADE:LAST_PROCESSED_SNAPSHOT');
const TRADE_OPEN_PREFIX = longKey('TRADE:OPEN:');
const TRADE_EVENT_LOG_KEY = longKey('TRADE:EVENTS');
const TRADE_ENTRY_LOG_KEY = longKey('TRADE:ENTRIES');
const TRADE_EXIT_LOG_KEY = longKey('TRADE:EXITS');

const ANALYZE_OBS_LAST_PREFIX = longKey('ANALYZE:OBS:LAST:');
const ANALYZE_WEEK_PREFIX = longKey('ANALYZE:WEEK:');
const ANALYZE_SHADOW_PREFIX = longKey('ANALYZE:SHADOW:');
const ANALYZE_MICRO_PREFIX = longKey('ANALYZE:MICRO:');

const ANALYZE_ACTIVE_ROTATION_KEY = longKey('ANALYZE:ACTIVE_ROTATION');
const ANALYZE_NEXT_ROTATION_KEY = longKey('ANALYZE:NEXT_ROTATION');
const ANALYZE_ROTATION_VALID_FROM_KEY = longKey('ANALYZE:ROTATION_VALID_FROM');
const ANALYZE_MANUAL_SELECTION_LOG_KEY = longKey('ANALYZE:MANUAL_SELECTION_LOG');
const ANALYZE_ROTATION_HISTORY_KEY = longKey('ANALYZE:ROTATION_HISTORY');
const ANALYZE_FREEZE_LOCK_KEY = longKey('ANALYZE:WEEKLY_FREEZE_LOCK');
const ANALYZE_ACTIVATE_LOCK_KEY = longKey('ANALYZE:ROTATION_ACTIVATE_LOCK');

const CIRCUIT_PAUSED_PREFIX = longKey('CIRCUIT:PAUSED:');

const DISCORD_LOGS_KEY = longKey('DISCORD:LOGS');
const RESET_LOGS_KEY = longKey('RESET:LOGS');

const LONG_PATTERNS = {
  scan: longKey('SCAN:*'),
  live: longKey('LIVE:*'),
  trade: longKey('TRADE:*'),
  analyze: longKey('ANALYZE:*'),
  circuit: longKey('CIRCUIT:*'),
  discord: longKey('DISCORD:*'),
  reset: longKey('RESET:*')
};

export const WRITE_SCOPES = deepFreeze({
  names: WRITE_SCOPE_NAMES,

  scannerRun: buildKeyScope({
    name: WRITE_SCOPE_NAMES.SCANNER_RUN,
    description: 'LONG scanner run mag uitsluitend LONG scanner snapshot/latest/meta schrijven.',
    allowed: [
      exact(SCAN_LATEST_KEY),
      exact(SCAN_RUN_META_KEY),
      prefix(SCAN_SNAPSHOT_PREFIX)
    ],
    denied: [
      ...NON_LONG_WRITE_DENY_PATTERNS,

      pattern(longKey('TRADE:*')),
      pattern(longKey('ANALYZE:*')),
      pattern(longKey('CIRCUIT:*')),
      pattern(longKey('DISCORD:*')),
      pattern(longKey('RESET:*')),
      pattern(longKey('LIVE:*'))
    ]
  }),

  tradeRun: buildKeyScope({
    name: WRITE_SCOPE_NAMES.TRADE_RUN,
    description: 'LONG trade run mag LONG trade state schrijven en Analyze alleen via partial learning updates.',
    allowed: [
      exact(TRADE_RUN_META_KEY),
      exact(TRADE_LAST_PROCESSED_SNAPSHOT_KEY),
      prefix(TRADE_OPEN_PREFIX),
      exact(TRADE_EVENT_LOG_KEY),
      exact(TRADE_ENTRY_LOG_KEY),
      exact(TRADE_EXIT_LOG_KEY),

      prefix(ANALYZE_OBS_LAST_PREFIX),
      prefix(ANALYZE_WEEK_PREFIX),
      prefix(ANALYZE_SHADOW_PREFIX)
    ],
    denied: [
      ...NON_LONG_WRITE_DENY_PATTERNS,

      exact(SCAN_LATEST_KEY),
      prefix(SCAN_SNAPSHOT_PREFIX),
      exact(SCAN_RUN_META_KEY),

      exact(ANALYZE_ACTIVE_ROTATION_KEY),
      exact(ANALYZE_NEXT_ROTATION_KEY),
      exact(ANALYZE_ROTATION_VALID_FROM_KEY),
      exact(ANALYZE_MANUAL_SELECTION_LOG_KEY),
      exact(ANALYZE_ROTATION_HISTORY_KEY),
      exact(ANALYZE_FREEZE_LOCK_KEY),
      exact(ANALYZE_ACTIVATE_LOCK_KEY),

      pattern(longKey('DISCORD:*')),
      pattern(longKey('RESET:*'))
    ]
  }),

  analyzePartial: buildKeyScope({
    name: WRITE_SCOPE_NAMES.ANALYZE_PARTIAL,
    description: 'LONG Analyze mag observations/outcomes cumulatief bijwerken, maar geen rotation/manual selectie overschrijven.',
    allowed: [
      prefix(ANALYZE_OBS_LAST_PREFIX),
      prefix(ANALYZE_WEEK_PREFIX),
      prefix(ANALYZE_SHADOW_PREFIX),
      prefix(ANALYZE_MICRO_PREFIX)
    ],
    denied: [
      ...NON_LONG_WRITE_DENY_PATTERNS,

      exact(SCAN_LATEST_KEY),
      prefix(SCAN_SNAPSHOT_PREFIX),
      pattern(longKey('TRADE:*')),

      exact(ANALYZE_ACTIVE_ROTATION_KEY),
      exact(ANALYZE_NEXT_ROTATION_KEY),
      exact(ANALYZE_ROTATION_VALID_FROM_KEY),
      exact(ANALYZE_MANUAL_SELECTION_LOG_KEY),
      exact(ANALYZE_ROTATION_HISTORY_KEY),
      exact(ANALYZE_FREEZE_LOCK_KEY),
      exact(ANALYZE_ACTIVATE_LOCK_KEY),

      pattern(longKey('DISCORD:*')),
      pattern(longKey('RESET:*'))
    ]
  }),

  adminReadonly: buildKeyScope({
    name: WRITE_SCOPE_NAMES.ADMIN_READONLY,
    description: 'Admin GET/API read-only endpoints mogen niets schrijven.',
    readonly: true,
    allowed: [],
    denied: [
      ...NON_LONG_WRITE_DENY_PATTERNS,

      pattern(longKey('SCAN:*')),
      pattern(longKey('LIVE:*')),
      pattern(longKey('TRADE:*')),
      pattern(longKey('ANALYZE:*')),
      pattern(longKey('CIRCUIT:*')),
      pattern(longKey('DISCORD:*')),
      pattern(longKey('RESET:*'))
    ]
  }),

  manualRotation: buildKeyScope({
    name: WRITE_SCOPE_NAMES.MANUAL_ROTATION,
    description: 'Alleen expliciete LONG admin manual selection mag LONG rotation/Discord selectie aanpassen.',
    allowed: [
      exact(ANALYZE_ACTIVE_ROTATION_KEY),
      exact(ANALYZE_NEXT_ROTATION_KEY),
      exact(ANALYZE_ROTATION_VALID_FROM_KEY),
      exact(ANALYZE_MANUAL_SELECTION_LOG_KEY),
      exact(ANALYZE_ROTATION_HISTORY_KEY),
      exact(ANALYZE_FREEZE_LOCK_KEY),
      exact(ANALYZE_ACTIVATE_LOCK_KEY),
      exact(DISCORD_LOGS_KEY)
    ],
    denied: [
      ...NON_LONG_WRITE_DENY_PATTERNS,

      exact(SCAN_LATEST_KEY),
      prefix(SCAN_SNAPSHOT_PREFIX),
      pattern(longKey('TRADE:*')),
      prefix(ANALYZE_WEEK_PREFIX),
      prefix(ANALYZE_OBS_LAST_PREFIX),
      prefix(ANALYZE_MICRO_PREFIX),
      prefix(ANALYZE_SHADOW_PREFIX),
      pattern(longKey('RESET:*'))
    ]
  }),

  factoryReset: buildKeyScope({
    name: WRITE_SCOPE_NAMES.FACTORY_RESET,
    description: 'Alleen LONG reset endpoints met expliciete bevestiging mogen LONG keys verwijderen/schrijven.',
    allowed: [
      pattern(longKey('SCAN:*')),
      pattern(longKey('LIVE:*')),
      pattern(longKey('TRADE:*')),
      pattern(longKey('ANALYZE:*')),
      pattern(longKey('CIRCUIT:*')),
      pattern(longKey('DISCORD:*')),
      pattern(longKey('RESET:*'))
    ],
    denied: [
      ...NON_LONG_WRITE_DENY_PATTERNS
    ]
  })
});

export function isKeyAllowedForWriteScope(scopeName, key) {
  const scope = Object.values(WRITE_SCOPES)
    .find((entry) => entry && typeof entry === 'object' && entry.name === scopeName);

  if (!scope) return false;
  if (scope.readonly) return false;

  const normalized = normalizeKey(key);

  if (!normalized.startsWith(LONG_KEY_PREFIX)) {
    return false;
  }

  const denied = Array.isArray(scope.denied)
    ? scope.denied.some((rule) => ruleMatches(rule, normalized))
    : false;

  if (denied) return false;

  return Array.isArray(scope.allowed)
    ? scope.allowed.some((rule) => ruleMatches(rule, normalized))
    : false;
}

export function assertKeyAllowedForWriteScope(scopeName, key) {
  if (isKeyAllowedForWriteScope(scopeName, key)) {
    return true;
  }

  const error = new Error('WRITE_SCOPE_VIOLATION_LONG_ONLY');

  error.details = {
    scopeName,
    key: normalizeKey(key),
    namespace: LONG_NAMESPACE,
    keyPrefix: LONG_KEY_PREFIX,
    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    shortDisabled: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true
  };

  throw error;
}

const scanKeys = {
  latest: SCAN_LATEST_KEY,
  lock: SCAN_LOCK_KEY,

  snapshot: (snapshotId) => `${SCAN_SNAPSHOT_PREFIX}${keyPart(snapshotId)}`,
  snapshotPattern: `${SCAN_SNAPSHOT_PREFIX}*`,

  runMeta: SCAN_RUN_META_KEY,
  runMetaPattern: longKey('SCAN:RUN:*')
};

const liveKeys = {
  cache: (symbol, type) => `${LIVE_CACHE_PREFIX}${symbolPart(symbol)}:${keyPart(type)}`,
  cachePattern: `${LIVE_CACHE_PREFIX}*`
};

const tradeKeys = {
  lock: TRADE_LOCK_KEY,
  runMeta: TRADE_RUN_META_KEY,

  lastProcessedSnapshot: TRADE_LAST_PROCESSED_SNAPSHOT_KEY,

  open: (symbol) => `${TRADE_OPEN_PREFIX}${symbolPart(symbol)}`,
  openPattern: `${TRADE_OPEN_PREFIX}*`,

  /*
    Append-only logs. Alleen diagnostisch/admin.
    Posities zelf blijven onder LONG:TRADE:OPEN:<SYMBOL>.
  */
  eventLog: TRADE_EVENT_LOG_KEY,
  entryLog: TRADE_ENTRY_LOG_KEY,
  exitLog: TRADE_EXIT_LOG_KEY,

  pattern: longKey('TRADE:*')
};

const analyzeKeys = {
  persistentLearningKey: PERSISTENT_LEARNING_KEY,

  obsLast: (snapshotId, symbol, microFamilyId) => (
    `${ANALYZE_OBS_LAST_PREFIX}${keyPart(snapshotId)}:${symbolPart(symbol)}:${keyPart(microFamilyId)}`
  ),
  obsLastPattern: `${ANALYZE_OBS_LAST_PREFIX}*`,

  shadowLast: (symbol, microFamilyId) => (
    `${longKey('ANALYZE:SHADOW:LAST:')}${symbolPart(symbol)}:${keyPart(microFamilyId)}`
  ),
  shadowLastPattern: longKey('ANALYZE:SHADOW:LAST:*'),

  shadowOpen: (id) => `${longKey('ANALYZE:SHADOW:OPEN:')}${keyPart(id)}`,
  shadowOpenPattern: longKey('ANALYZE:SHADOW:OPEN:*'),
  shadowPattern: longKey('ANALYZE:SHADOW:*'),

  microStats: (microFamilyId) => `${ANALYZE_MICRO_PREFIX}${keyPart(microFamilyId)}:STATS`,
  microRegimeStats: (microFamilyId) => `${ANALYZE_MICRO_PREFIX}${keyPart(microFamilyId)}:REGIME`,
  microPattern: `${ANALYZE_MICRO_PREFIX}*`,

  weekMicros: (weekKey = PERSISTENT_LEARNING_KEY) => `${ANALYZE_WEEK_PREFIX}${keyPart(weekKey)}:MICROS`,
  weekMeta: (weekKey = PERSISTENT_LEARNING_KEY) => `${ANALYZE_WEEK_PREFIX}${keyPart(weekKey)}:META`,
  weekPattern: `${ANALYZE_WEEK_PREFIX}*`,

  activeRotation: ANALYZE_ACTIVE_ROTATION_KEY,
  nextRotation: ANALYZE_NEXT_ROTATION_KEY,
  rotationValidFrom: ANALYZE_ROTATION_VALID_FROM_KEY,

  /*
    Manual-only rotation support.
    Het systeem mag dit nooit automatisch overschrijven.
  */
  manualSelectionLog: ANALYZE_MANUAL_SELECTION_LOG_KEY,
  rotationHistory: ANALYZE_ROTATION_HISTORY_KEY,

  freezeLock: ANALYZE_FREEZE_LOCK_KEY,
  activateLock: ANALYZE_ACTIVATE_LOCK_KEY,

  pattern: longKey('ANALYZE:*')
};

const circuitKeys = {
  paused: (microFamilyId) => `${CIRCUIT_PAUSED_PREFIX}${keyPart(microFamilyId)}`,
  pausedPattern: `${CIRCUIT_PAUSED_PREFIX}*`
};

const discordKeys = {
  logList: DISCORD_LOGS_KEY,
  pattern: longKey('DISCORD:*')
};

const resetKeys = {
  logList: RESET_LOGS_KEY,
  pattern: longKey('RESET:*')
};

export const KEYS = deepFreeze({
  namespace: LONG_NAMESPACE,
  keyPrefix: LONG_KEY_PREFIX,
  redisNamespace: LONG_NAMESPACE,
  redisKeyPrefix: LONG_KEY_PREFIX,

  targetTradeSide: TARGET_TRADE_SIDE,
  dashboardSide: TARGET_DASHBOARD_SIDE,
  scannerSide: TARGET_SCANNER_SIDE,
  oppositeTradeSide: OPPOSITE_TRADE_SIDE,

  longOnly: true,
  shortDisabled: true,
  shortOnly: false,
  longDisabled: false,

  virtualOnly: true,
  realOrdersDisabled: true,
  bitgetOrdersDisabled: true,
  exchangeOrdersDisabled: true,

  persistentLearningKey: PERSISTENT_LEARNING_KEY,

  scopes: WRITE_SCOPE_NAMES,

  scan: scanKeys,
  live: liveKeys,
  trade: tradeKeys,
  analyze: analyzeKeys,
  circuit: circuitKeys,
  discord: discordKeys,
  reset: resetKeys,

  /*
    Alias voor code die expliciet naar KEYS.long zoekt.
    Alle waarden zijn identiek aan de root keys en blijven LONG-prefixed.
  */
  long: {
    namespace: LONG_NAMESPACE,
    keyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,

    scan: scanKeys,
    live: liveKeys,
    trade: tradeKeys,
    analyze: analyzeKeys,
    circuit: circuitKeys,
    discord: discordKeys,
    reset: resetKeys
  },

  /*
    Centrale patterns voor factory reset/admin cleanup.
    Gebruik selectief; niet blind verwijderen in normale runs.
    Alle patterns zijn LONG-namespaced.
  */
  patterns: {
    scan: LONG_PATTERNS.scan,
    live: LONG_PATTERNS.live,
    trade: LONG_PATTERNS.trade,
    analyze: LONG_PATTERNS.analyze,
    circuit: LONG_PATTERNS.circuit,
    discord: LONG_PATTERNS.discord,
    reset: LONG_PATTERNS.reset,

    volatile: [
      LONG_PATTERNS.scan,
      LONG_PATTERNS.live
    ],

    durableLearning: [
      LONG_PATTERNS.analyze
    ],

    durableTrade: [
      LONG_PATTERNS.trade
    ],

    durableRotation: [
      ANALYZE_ACTIVE_ROTATION_KEY,
      ANALYZE_NEXT_ROTATION_KEY,
      ANALYZE_ROTATION_VALID_FROM_KEY,
      ANALYZE_MANUAL_SELECTION_LOG_KEY,
      ANALYZE_ROTATION_HISTORY_KEY
    ],

    durableDiscord: [
      LONG_PATTERNS.discord
    ],

    all: [
      LONG_PATTERNS.scan,
      LONG_PATTERNS.live,
      LONG_PATTERNS.trade,
      LONG_PATTERNS.analyze,
      LONG_PATTERNS.circuit,
      LONG_PATTERNS.discord,
      LONG_PATTERNS.reset
    ],

    /*
      Expliciet non-LONG. Alleen gebruiken als guard/diagnose; nooit als cleanup target
      vanuit deze LONG-root.
    */
    nonLongDenied: [
      'SCAN:*',
      'LIVE:*',
      'TRADE:*',
      'ANALYZE:*',
      'CIRCUIT:*',
      'DISCORD:*',
      'RESET:*',
      'SHORT:*'
    ]
  }
});