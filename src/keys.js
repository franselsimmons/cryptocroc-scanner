// ================= FILE: src/keys.js =================

const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const TARGET_SCANNER_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = TRUE_MICRO_SCHEMA;
const LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_V1';

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
  FACTORY_RESET: 'FACTORY_RESET',
  RESET_LEARNING: 'RESET_LEARNING',
  RESET_ROTATION: 'RESET_ROTATION'
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

const taxonomyFlags = () => ({
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

  parentSelectable: false,
  childSelectable: true,
  selectableFamilyCount: 75,
  parentFamilyCount: 15,

  setupTypes: LONG_FIXED_SETUP_TYPES,
  regimeBuckets: LONG_FIXED_REGIME_BUCKETS,
  confirmationProfiles: LONG_CONFIRMATION_PROFILES
});

const longIdentityFlags = () => ({
  namespace: LONG_NAMESPACE,
  keyPrefix: LONG_KEY_PREFIX,
  redisNamespace: LONG_NAMESPACE,
  redisKeyPrefix: LONG_KEY_PREFIX,
  persistentLearningKey: PERSISTENT_LEARNING_KEY,

  targetTradeSide: TARGET_TRADE_SIDE,
  dashboardSide: TARGET_DASHBOARD_SIDE,
  scannerSide: TARGET_SCANNER_SIDE,
  targetScannerSide: TARGET_SCANNER_SIDE,
  oppositeTradeSide: OPPOSITE_TRADE_SIDE,

  longOnly: true,
  shortDisabled: true,
  shortOnly: false,
  longDisabled: false,

  virtualLearning: true,
  virtualOnly: true,
  virtualTracked: true,

  realOrdersDisabled: true,
  bitgetOrdersDisabled: true,
  exchangeOrdersDisabled: true,
  exchangeCallsDisabled: true,
  noRealOrders: true,
  noExchangeOrders: true,

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

  manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
  discordOnlyForExactTrueMicroMatch: true,

  completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
  scoringRSource: 'netR',
  winsLossesFlatsSource: 'netR',
  winrateDefinition: 'netR > 0',
  avgRSource: 'netR',
  totalRSource: 'netR',
  avgCostRShown: true,

  shortRootTouched: false,

  ...taxonomyFlags()
});

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
  ...longIdentityFlags()
});

const NON_LONG_WRITE_DENY_PATTERNS = [
  pattern('SCAN:*'),
  pattern('LIVE:*'),
  pattern('TRADE:*'),
  pattern('ANALYZE:*'),
  pattern('CIRCUIT:*'),
  pattern('DISCORD:*'),
  pattern('RESET:*'),
  pattern('SHORT:*'),
  pattern('SHORT:*:*'),
  pattern('SHORT_LIVE:*')
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
const ANALYZE_PARENT_PREFIX = longKey('ANALYZE:PARENT:');
const ANALYZE_CHILD_PREFIX = longKey('ANALYZE:CHILD:');

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
    description: 'LONG scanner run mag uitsluitend LONG scanner snapshot/latest/meta schrijven. Scanner selecteert geen microfamilies, triggert geen Discord en schrijft geen learning-family.',
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
    description: 'LONG trade run mag LONG virtual trade state schrijven en Analyze alleen via partial learning updates. Geen scanner overwrite, geen rotation overwrite, geen echte orders.',
    allowed: [
      exact(TRADE_RUN_META_KEY),
      exact(TRADE_LAST_PROCESSED_SNAPSHOT_KEY),
      prefix(TRADE_OPEN_PREFIX),
      exact(TRADE_EVENT_LOG_KEY),
      exact(TRADE_ENTRY_LOG_KEY),
      exact(TRADE_EXIT_LOG_KEY),

      prefix(ANALYZE_OBS_LAST_PREFIX),
      prefix(ANALYZE_WEEK_PREFIX),
      prefix(ANALYZE_SHADOW_PREFIX),
      prefix(ANALYZE_MICRO_PREFIX),
      prefix(ANALYZE_PARENT_PREFIX),
      prefix(ANALYZE_CHILD_PREFIX)
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
    description: 'LONG Analyze mag observations/outcomes cumulatief bijwerken op exact 75-child trueMicroFamilyId en parent 15 context, maar geen rotation/manual selectie overschrijven.',
    allowed: [
      prefix(ANALYZE_OBS_LAST_PREFIX),
      prefix(ANALYZE_WEEK_PREFIX),
      prefix(ANALYZE_SHADOW_PREFIX),
      prefix(ANALYZE_MICRO_PREFIX),
      prefix(ANALYZE_PARENT_PREFIX),
      prefix(ANALYZE_CHILD_PREFIX)
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
    description: 'Alleen expliciete LONG admin manual selection mag LONG rotation/Discord selectie aanpassen. Alleen exact 75-child trueMicroFamilyId is selecteerbaar.',
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
      prefix(ANALYZE_PARENT_PREFIX),
      prefix(ANALYZE_CHILD_PREFIX),
      prefix(ANALYZE_SHADOW_PREFIX),

      pattern(longKey('RESET:*'))
    ]
  }),

  factoryReset: buildKeyScope({
    name: WRITE_SCOPE_NAMES.FACTORY_RESET,
    description: 'Alleen LONG factory reset endpoints met expliciete bevestiging mogen LONG keys verwijderen/schrijven.',
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
  }),

  resetLearning: buildKeyScope({
    name: WRITE_SCOPE_NAMES.RESET_LEARNING,
    description: 'Reset alleen LONG learning/analyze data. Rotation, manual selection, scanner, trade state, open virtual positions en Discord blijven bewaard.',
    allowed: [
      prefix(ANALYZE_OBS_LAST_PREFIX),
      prefix(ANALYZE_WEEK_PREFIX),
      prefix(ANALYZE_SHADOW_PREFIX),
      prefix(ANALYZE_MICRO_PREFIX),
      prefix(ANALYZE_PARENT_PREFIX),
      prefix(ANALYZE_CHILD_PREFIX),
      exact(RESET_LOGS_KEY)
    ],
    denied: [
      ...NON_LONG_WRITE_DENY_PATTERNS,

      pattern(longKey('SCAN:*')),
      pattern(longKey('LIVE:*')),
      pattern(longKey('TRADE:*')),

      exact(ANALYZE_ACTIVE_ROTATION_KEY),
      exact(ANALYZE_NEXT_ROTATION_KEY),
      exact(ANALYZE_ROTATION_VALID_FROM_KEY),
      exact(ANALYZE_MANUAL_SELECTION_LOG_KEY),
      exact(ANALYZE_ROTATION_HISTORY_KEY),
      exact(ANALYZE_FREEZE_LOCK_KEY),
      exact(ANALYZE_ACTIVATE_LOCK_KEY),

      pattern(longKey('DISCORD:*'))
    ]
  }),

  resetRotation: buildKeyScope({
    name: WRITE_SCOPE_NAMES.RESET_ROTATION,
    description: 'Reset alleen LONG active/next rotation en manual selection metadata. Learning/outcomes/open positions/scanner blijven bewaard.',
    allowed: [
      exact(ANALYZE_ACTIVE_ROTATION_KEY),
      exact(ANALYZE_NEXT_ROTATION_KEY),
      exact(ANALYZE_ROTATION_VALID_FROM_KEY),
      exact(ANALYZE_MANUAL_SELECTION_LOG_KEY),
      exact(ANALYZE_ROTATION_HISTORY_KEY),
      exact(ANALYZE_FREEZE_LOCK_KEY),
      exact(ANALYZE_ACTIVATE_LOCK_KEY),
      exact(RESET_LOGS_KEY)
    ],
    denied: [
      ...NON_LONG_WRITE_DENY_PATTERNS,

      pattern(longKey('SCAN:*')),
      pattern(longKey('LIVE:*')),
      pattern(longKey('TRADE:*')),

      prefix(ANALYZE_WEEK_PREFIX),
      prefix(ANALYZE_OBS_LAST_PREFIX),
      prefix(ANALYZE_MICRO_PREFIX),
      prefix(ANALYZE_PARENT_PREFIX),
      prefix(ANALYZE_CHILD_PREFIX),
      prefix(ANALYZE_SHADOW_PREFIX),

      pattern(longKey('DISCORD:*'))
    ]
  })
});

export function isLongNamespacedKey(key) {
  return normalizeKey(key).startsWith(LONG_KEY_PREFIX);
}

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
    scannerSide: TARGET_SCANNER_SIDE,
    shortDisabled: true,
    shortRootTouched: false,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    ...taxonomyFlags()
  };

  throw error;
}

const scanKeys = {
  latest: SCAN_LATEST_KEY,
  lock: SCAN_LOCK_KEY,

  snapshot: (snapshotId) => `${SCAN_SNAPSHOT_PREFIX}${keyPart(snapshotId)}`,
  snapshotPattern: `${SCAN_SNAPSHOT_PREFIX}*`,

  runMeta: SCAN_RUN_META_KEY,
  runMetaPattern: longKey('SCAN:RUN:*'),

  metadataOnly: true,
  scannerDoesNotTrade: true,
  scannerDoesNotSelectMicroFamilies: true,
  scannerDoesNotSendDiscord: true,
  scannerDoesNotWriteLearningFamilies: true
};

const liveKeys = {
  cache: (symbol, type) => `${LIVE_CACHE_PREFIX}${symbolPart(symbol)}:${keyPart(type)}`,
  cachePattern: `${LIVE_CACHE_PREFIX}*`,

  marketDataOnly: true,
  exchangeCallsReadOnly: true
};

const tradeKeys = {
  lock: TRADE_LOCK_KEY,
  runMeta: TRADE_RUN_META_KEY,

  lastProcessedSnapshot: TRADE_LAST_PROCESSED_SNAPSHOT_KEY,

  open: (symbol) => `${TRADE_OPEN_PREFIX}${symbolPart(symbol)}`,
  openPattern: `${TRADE_OPEN_PREFIX}*`,

  eventLog: TRADE_EVENT_LOG_KEY,
  entryLog: TRADE_ENTRY_LOG_KEY,
  exitLog: TRADE_EXIT_LOG_KEY,

  pattern: longKey('TRADE:*'),

  virtualOnly: true,
  realOrdersDisabled: true,
  oneOpenPositionPerSymbol: true,
  closeRules: {
    tp: 'price >= tp',
    sl: 'price <= sl',
    timeStop: 'TIME_STOP'
  },
  validRiskShape: 'sl < entry < tp',
  outcomeRSource: 'netR'
};

const analyzeKeys = {
  persistentLearningKey: PERSISTENT_LEARNING_KEY,

  obsLast: (snapshotId, symbol, trueMicroFamilyId) => (
    `${ANALYZE_OBS_LAST_PREFIX}${keyPart(snapshotId)}:${symbolPart(symbol)}:${keyPart(trueMicroFamilyId)}`
  ),
  obsLastPattern: `${ANALYZE_OBS_LAST_PREFIX}*`,

  shadowLast: (symbol, trueMicroFamilyId) => (
    `${longKey('ANALYZE:SHADOW:LAST:')}${symbolPart(symbol)}:${keyPart(trueMicroFamilyId)}`
  ),
  shadowLastPattern: longKey('ANALYZE:SHADOW:LAST:*'),

  shadowOpen: (id) => `${longKey('ANALYZE:SHADOW:OPEN:')}${keyPart(id)}`,
  shadowOpenPattern: longKey('ANALYZE:SHADOW:OPEN:*'),
  shadowPattern: longKey('ANALYZE:SHADOW:*'),

  microStats: (trueMicroFamilyId) => `${ANALYZE_MICRO_PREFIX}${keyPart(trueMicroFamilyId)}:STATS`,
  microRegimeStats: (trueMicroFamilyId) => `${ANALYZE_MICRO_PREFIX}${keyPart(trueMicroFamilyId)}:REGIME`,
  microOutcomes: (trueMicroFamilyId) => `${ANALYZE_MICRO_PREFIX}${keyPart(trueMicroFamilyId)}:OUTCOMES`,
  microExamples: (trueMicroFamilyId) => `${ANALYZE_MICRO_PREFIX}${keyPart(trueMicroFamilyId)}:EXAMPLES`,
  microPattern: `${ANALYZE_MICRO_PREFIX}*`,

  childStats: (childTrueMicroFamilyId) => `${ANALYZE_CHILD_PREFIX}${keyPart(childTrueMicroFamilyId)}:STATS`,
  childOutcomes: (childTrueMicroFamilyId) => `${ANALYZE_CHILD_PREFIX}${keyPart(childTrueMicroFamilyId)}:OUTCOMES`,
  childPattern: `${ANALYZE_CHILD_PREFIX}*`,

  parentStats: (parentTrueMicroFamilyId) => `${ANALYZE_PARENT_PREFIX}${keyPart(parentTrueMicroFamilyId)}:STATS`,
  parentOutcomes: (parentTrueMicroFamilyId) => `${ANALYZE_PARENT_PREFIX}${keyPart(parentTrueMicroFamilyId)}:OUTCOMES`,
  parentPattern: `${ANALYZE_PARENT_PREFIX}*`,

  weekMicros: (weekKey = PERSISTENT_LEARNING_KEY) => `${ANALYZE_WEEK_PREFIX}${keyPart(weekKey)}:MICROS`,
  weekParents: (weekKey = PERSISTENT_LEARNING_KEY) => `${ANALYZE_WEEK_PREFIX}${keyPart(weekKey)}:PARENTS`,
  weekChildren: (weekKey = PERSISTENT_LEARNING_KEY) => `${ANALYZE_WEEK_PREFIX}${keyPart(weekKey)}:CHILDREN`,
  weekMeta: (weekKey = PERSISTENT_LEARNING_KEY) => `${ANALYZE_WEEK_PREFIX}${keyPart(weekKey)}:META`,
  weekPattern: `${ANALYZE_WEEK_PREFIX}*`,

  activeRotation: ANALYZE_ACTIVE_ROTATION_KEY,
  nextRotation: ANALYZE_NEXT_ROTATION_KEY,
  rotationValidFrom: ANALYZE_ROTATION_VALID_FROM_KEY,

  manualSelectionLog: ANALYZE_MANUAL_SELECTION_LOG_KEY,
  rotationHistory: ANALYZE_ROTATION_HISTORY_KEY,

  freezeLock: ANALYZE_FREEZE_LOCK_KEY,
  activateLock: ANALYZE_ACTIVATE_LOCK_KEY,

  pattern: longKey('ANALYZE:*'),

  completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
  scoringRSource: 'netR',
  statsKeyMode: 'EXACT_75_CHILD_TRUE_MICRO_ONLY',

  ...taxonomyFlags()
};

const circuitKeys = {
  paused: (trueMicroFamilyId) => `${CIRCUIT_PAUSED_PREFIX}${keyPart(trueMicroFamilyId)}`,
  pausedPattern: `${CIRCUIT_PAUSED_PREFIX}*`
};

const discordKeys = {
  logList: DISCORD_LOGS_KEY,
  pattern: longKey('DISCORD:*'),

  selectedMicroOnly: true,
  exactTrueMicroFamilyMatchOnly: true,
  exact75ChildTrueMicroMatchOnly: true,
  allowParentMatch: false,
  allowMacroMatch: false,
  allowScannerFingerprintMatch: false,
  allowExecutionFingerprintMatch: false
};

const resetKeys = {
  logList: RESET_LOGS_KEY,
  pattern: longKey('RESET:*'),

  factoryConfirmText: 'LONG_FACTORY_RESET_CONFIRMED',
  learningConfirmText: 'RESET_LEARNING_LONG',
  rotationConfirmText: 'RESET_ROTATION_LONG'
};

const taxonomyKeys = {
  setupTypes: LONG_FIXED_SETUP_TYPES,
  regimeBuckets: LONG_FIXED_REGIME_BUCKETS,
  confirmationProfiles: LONG_CONFIRMATION_PROFILES,

  parentTrueMicroFamily: (setup, regime) => (
    `MICRO_LONG_${keyPart(setup).toUpperCase()}_${keyPart(regime).toUpperCase()}`
  ),

  childTrueMicroFamily: (setup, regime, confirmationProfile) => (
    `MICRO_LONG_${keyPart(setup).toUpperCase()}_${keyPart(regime).toUpperCase()}_${keyPart(confirmationProfile).toUpperCase()}`
  ),

  ...taxonomyFlags()
};

export const KEYS = deepFreeze({
  namespace: LONG_NAMESPACE,
  keyPrefix: LONG_KEY_PREFIX,
  redisNamespace: LONG_NAMESPACE,
  redisKeyPrefix: LONG_KEY_PREFIX,

  targetTradeSide: TARGET_TRADE_SIDE,
  dashboardSide: TARGET_DASHBOARD_SIDE,
  scannerSide: TARGET_SCANNER_SIDE,
  targetScannerSide: TARGET_SCANNER_SIDE,
  oppositeTradeSide: OPPOSITE_TRADE_SIDE,

  longOnly: true,
  shortDisabled: true,
  shortOnly: false,
  longDisabled: false,

  virtualOnly: true,
  virtualLearning: true,
  realOrdersDisabled: true,
  bitgetOrdersDisabled: true,
  exchangeOrdersDisabled: true,
  exchangeCallsDisabled: true,
  noRealOrders: true,
  noExchangeOrders: true,

  persistentLearningKey: PERSISTENT_LEARNING_KEY,

  trueMicroSchema: TRUE_MICRO_SCHEMA,
  parentTrueMicroSchema: PARENT_TRUE_MICRO_SCHEMA,
  childTrueMicroSchema: CHILD_TRUE_MICRO_SCHEMA,
  learningGranularity: LEARNING_GRANULARITY,
  parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

  scopes: WRITE_SCOPE_NAMES,

  scan: scanKeys,
  live: liveKeys,
  trade: tradeKeys,
  analyze: analyzeKeys,
  circuit: circuitKeys,
  discord: discordKeys,
  reset: resetKeys,
  taxonomy: taxonomyKeys,

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
    reset: resetKeys,
    taxonomy: taxonomyKeys
  },

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

    nonLongDenied: [
      'SCAN:*',
      'LIVE:*',
      'TRADE:*',
      'ANALYZE:*',
      'CIRCUIT:*',
      'DISCORD:*',
      'RESET:*',
      'SHORT:*',
      'SHORT:*:*',
      'SHORT_LIVE:*'
    ]
  },

  guards: {
    scannerWritesLearning: false,
    scannerWritesDiscord: false,
    scannerWritesTrade: false,
    scannerBucketsAreMetadataOnly: true,
    old25BucketsAreMetadataOnly: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    tradeWritesRealOrders: false,
    tradeWritesVirtualPositionsOnly: true,

    discordRequiresManualExact75ChildMatch: true,
    parentIdsAreContextOnly: true,
    scannerFingerprintsAreMetadataOnly: true,
    executionFingerprintsAreMetadataOnly: true,

    completedOnlyClosedVirtualOrShadow: true,
    scoringWritesBackToExactTrueMicroFamilyId: true,
    learningKey: PERSISTENT_LEARNING_KEY
  },

  ...longIdentityFlags()
});