// ================= FILE: src/keys.js =================
// Redis key generation & write-scope guard for LONG-only system.
//
// Namespace: LONG:
// - SCAN:* → scanner fingerprints
// - LIVE:* → live position tracking
// - TRADE:* → trade execution
// - ANALYZE:* → virtual outcome learning
// - CIRCUIT:* → circuit breakers
// - DISCORD:* → webhook state
// - RESET:* → reset management
//
// All keys are LONG-namespaced. SHORT: prefixes are refused.


const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;

const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';
const TEMPORAL_CONTEXT_VERSION = 'LONG_TEMPORAL_CONTEXT_UTC_V1';
const WEEKEND_POLICY_VERSION = 'LONG_WEEKEND_OBSERVE_DISCORD_BLOCK_V1';
const SESSION_POLICY_VERSION = 'LONG_SESSION_OBSERVE_V1';
const WEEKEND_MODE = 'OBSERVE';
const SESSION_MODE = 'OBSERVE';


const ALLOWED_WRITE_SCOPES = {
     SCAN_PARTIAL: 'SCAN_PARTIAL',
     LIVE_PARTIAL: 'LIVE_PARTIAL',
     TRADE_PARTIAL: 'TRADE_PARTIAL',
     ANALYZE_PARTIAL: 'ANALYZE_PARTIAL',
     CIRCUIT_PARTIAL: 'CIRCUIT_PARTIAL',
     DISCORD_PARTIAL: 'DISCORD_PARTIAL',
     RESET_PARTIAL: 'RESET_PARTIAL',
     MARKET_PARTIAL: 'MARKET_PARTIAL',
     LONG_ANALYZE_PARTIAL: 'LONG_ANALYZE_PARTIAL',
     ANALYZE_LONG_PARTIAL: 'ANALYZE_LONG_PARTIAL',
     TRADE_RUN: 'TRADE_RUN'
};


const SCOPE_PREFIX_MAP = {
     SCAN_PARTIAL: `${LONG_KEY_PREFIX}SCAN:`,
     LIVE_PARTIAL: `${LONG_KEY_PREFIX}LIVE:`,
     TRADE_PARTIAL: `${LONG_KEY_PREFIX}TRADE:`,
     ANALYZE_PARTIAL: `${LONG_KEY_PREFIX}ANALYZE:`,
     CIRCUIT_PARTIAL: `${LONG_KEY_PREFIX}CIRCUIT:`,
     DISCORD_PARTIAL: `${LONG_KEY_PREFIX}DISCORD:`,
     RESET_PARTIAL: `${LONG_KEY_PREFIX}RESET:`,
     MARKET_PARTIAL: `${LONG_KEY_PREFIX}MARKET:`,
     LONG_ANALYZE_PARTIAL: `${LONG_KEY_PREFIX}ANALYZE:`,
     ANALYZE_LONG_PARTIAL: `${LONG_KEY_PREFIX}ANALYZE:`,
     TRADE_RUN: `${LONG_KEY_PREFIX}TRADE:`
};


function validateWriteScope(scopeName, key) {
     const allowedPrefix = SCOPE_PREFIX_MAP[scopeName];


     if (!allowedPrefix) {
       const error = new Error('INVALID_WRITE_SCOPE_NAME');
       error.details = {
         scopeName,
              key,
              validScopes: Object.keys(ALLOWED_WRITE_SCOPES),
              namespace: LONG_NAMESPACE,
              keyPrefix: LONG_KEY_PREFIX
         };
         throw error;
    }


    if (!key.startsWith(allowedPrefix)) {
         const error = new Error('WRITE_SCOPE_VIOLATION');
         error.details = {
              scopeName,
              key,
              requiredPrefix: allowedPrefix,
              namespace: LONG_NAMESPACE,
              keyPrefix: LONG_KEY_PREFIX,
              shortRootTouched: false
         };
         throw error;
    }


    return true;
}


export function assertKeyAllowedForWriteScope(scopeName, key) {
    const normalizedKey = String(key || '').trim();


    if (!normalizedKey) {
         throw new Error('ASSERT_KEY_EMPTY');
    }


    return validateWriteScope(scopeName, normalizedKey);
}


export const KEYS = {
    namespace: LONG_NAMESPACE,
    keyPrefix: LONG_KEY_PREFIX,


    scopes: ALLOWED_WRITE_SCOPES,


    scan: {
         fingerprints: (snapshotId) =>
              `${LONG_KEY_PREFIX}SCAN:FINGERPRINTS:${snapshotId}`,


         buckets: (snapshotId) =>
              `${LONG_KEY_PREFIX}SCAN:BUCKETS:${snapshotId}`
    },
live: {
     positions: (symbol) =>
       `${LONG_KEY_PREFIX}LIVE:POSITIONS:${symbol}`,


     openCount: () =>
       `${LONG_KEY_PREFIX}LIVE:OPEN_COUNT`,


     microState: (microId) =>
       `${LONG_KEY_PREFIX}LIVE:MICRO_STATE:${microId}`
},


trade: {
     execution: (tradeId) =>
       `${LONG_KEY_PREFIX}TRADE:EXECUTION:${tradeId}`,


     history: (symbol) =>
       `${LONG_KEY_PREFIX}TRADE:HISTORY:${symbol}`,


     active: () =>
       `${LONG_KEY_PREFIX}TRADE:ACTIVE`,


     pending: () =>
       `${LONG_KEY_PREFIX}TRADE:PENDING`
},


analyze: {
     // Last observation snapshot for deduplication
     obsLast: (snapshotId, symbol, microId) =>
       `${LONG_KEY_PREFIX}ANALYZE:OBS_LAST:${snapshotId}:${symbol}:${microId}`,


     // Weekly aggregates for micro-families
     weekMicros: (weekKey) =>
       `${LONG_KEY_PREFIX}ANALYZE:WEEK_MICROS:${weekKey}`,


     // Weekly aggregates for parent families
     weekParents: (weekKey) =>
       `${LONG_KEY_PREFIX}ANALYZE:WEEK_PARENTS:${weekKey}`,


     // Persistent stats for a micro-family
     microStats: (microId) =>
       `${LONG_KEY_PREFIX}ANALYZE:MICRO_STATS:${microId}`,


     // Persistent stats for a parent family
     parentStats: (parentId) =>
       `${LONG_KEY_PREFIX}ANALYZE:PARENT_STATS:${parentId}`,
          // Recent closed outcomes for a micro-family
          microOutcomes: (microId) =>
            `${LONG_KEY_PREFIX}ANALYZE:MICRO_OUTCOMES:${microId}`,


          // Outcome deduplication key
          outcomeDedup: (outcomeId) =>
            `${LONG_KEY_PREFIX}ANALYZE:OUTCOME_DEDUP:${outcomeId}`
     },


     circuit: {
          breaker: (circuitName) =>
            `${LONG_KEY_PREFIX}CIRCUIT:BREAKER:${circuitName}`,


          state: (circuitName) =>
            `${LONG_KEY_PREFIX}CIRCUIT:STATE:${circuitName}`
     },


     discord: {
          webhook: (webhookId) =>
            `${LONG_KEY_PREFIX}DISCORD:WEBHOOK:${webhookId}`,


          queue: (channelId) =>
            `${LONG_KEY_PREFIX}DISCORD:QUEUE:${channelId}`,


          sent: (messageId) =>
            `${LONG_KEY_PREFIX}DISCORD:SENT:${messageId}`
     },


     reset: {
          state: () =>
            `${LONG_KEY_PREFIX}RESET:STATE`,


          timestamp: () =>
            `${LONG_KEY_PREFIX}RESET:TIMESTAMP`,


          reason: () =>
            `${LONG_KEY_PREFIX}RESET:REASON`
     }

};

// Compatibility and temporal-context keys used across the separate LONG root.
Object.assign(KEYS.scan, {
     latest: `${LONG_KEY_PREFIX}SCAN:LATEST`,
     longLatest: `${LONG_KEY_PREFIX}SCAN:LATEST`,
     snapshot: (snapshotId) => `${LONG_KEY_PREFIX}SCAN:SNAPSHOT:${snapshotId}`,
     longSnapshot: (snapshotId) => `${LONG_KEY_PREFIX}SCAN:SNAPSHOT:${snapshotId}`,
     snapshotPattern: `${LONG_KEY_PREFIX}SCAN:SNAPSHOT:*`,
     runMeta: `${LONG_KEY_PREFIX}SCAN:RUN_META`,
     universeLatest: `${LONG_KEY_PREFIX}MARKET:UNIVERSE:LATEST`,
     weatherLatest: `${LONG_KEY_PREFIX}MARKET:WEATHER:LATEST`,
     temporalContext: (snapshotId) => `${LONG_KEY_PREFIX}SCAN:TEMPORAL_CONTEXT:${snapshotId}`,
     longUniverseLatest: `${LONG_KEY_PREFIX}MARKET:UNIVERSE:LATEST`,
     longWeatherLatest: `${LONG_KEY_PREFIX}MARKET:WEATHER:LATEST`
});

Object.assign(KEYS.trade, {
     open: (symbol) => `${LONG_KEY_PREFIX}TRADE:OPEN:${symbol}`,
     longOpen: (symbol) => `${LONG_KEY_PREFIX}TRADE:OPEN:${symbol}`,
     openPattern: `${LONG_KEY_PREFIX}TRADE:OPEN:*`,
     runMeta: `${LONG_KEY_PREFIX}TRADE:RUN_META`,
     longRunMeta: `${LONG_KEY_PREFIX}TRADE:RUN_META`,
     lastProcessedSnapshot: `${LONG_KEY_PREFIX}TRADE:LAST_PROCESSED_SNAPSHOT`,
     longLastProcessedSnapshot: `${LONG_KEY_PREFIX}TRADE:LAST_PROCESSED_SNAPSHOT`,
     snapshotProgress: `${LONG_KEY_PREFIX}TRADE:SNAPSHOT_PROGRESS`,
     longOpenPattern: `${LONG_KEY_PREFIX}TRADE:OPEN:*`,
     longSnapshotProgress: `${LONG_KEY_PREFIX}TRADE:SNAPSHOT_PROGRESS`,
     entryTemporalContext: (tradeId) => `${LONG_KEY_PREFIX}TRADE:ENTRY_CONTEXT:${tradeId}`,
     exitTemporalContext: (tradeId) => `${LONG_KEY_PREFIX}TRADE:EXIT_CONTEXT:${tradeId}`
});

Object.assign(KEYS.analyze, {
     activeRotation: `${LONG_KEY_PREFIX}ANALYZE:ACTIVE_ROTATION`,
     nextRotation: `${LONG_KEY_PREFIX}ANALYZE:NEXT_ROTATION`,
     rotationValidFrom: `${LONG_KEY_PREFIX}ANALYZE:ROTATION_VALID_FROM`,
     observationDedup: (id) => `${LONG_KEY_PREFIX}ANALYZE:OBSERVATION_DEDUP:${id}`,
     contextStats: (microId, dayType) => `${LONG_KEY_PREFIX}ANALYZE:CONTEXT_STATS:${microId}:${dayType}`,
     sessionStats: (microId, sessionBucket) => `${LONG_KEY_PREFIX}ANALYZE:SESSION_STATS:${microId}:${sessionBucket}`,
     temporalContext: (id) => `${LONG_KEY_PREFIX}ANALYZE:TEMPORAL_CONTEXT:${id}`
});

Object.assign(KEYS.discord, {
     logList: `${LONG_KEY_PREFIX}DISCORD:LOGS`,
     longLogList: `${LONG_KEY_PREFIX}DISCORD:LOGS`,
     cooldown: (symbol) => `${LONG_KEY_PREFIX}DISCORD:COOLDOWN:${symbol}`,
     dedupe: (id) => `${LONG_KEY_PREFIX}DISCORD:DEDUPE:${id}`
});

Object.assign(KEYS.reset, {
     logList: `${LONG_KEY_PREFIX}RESET:LOGS`
});

KEYS.market = {
     universeLatest: `${LONG_KEY_PREFIX}MARKET:UNIVERSE:LATEST`,
     weatherLatest: `${LONG_KEY_PREFIX}MARKET:WEATHER:LATEST`,
     temporalContext: (id) => `${LONG_KEY_PREFIX}MARKET:TEMPORAL_CONTEXT:${id}`,
     universe: `${LONG_KEY_PREFIX}MARKET:UNIVERSE:LATEST`,
     weather: `${LONG_KEY_PREFIX}MARKET:WEATHER:LATEST`,
     longUniverseLatest: `${LONG_KEY_PREFIX}MARKET:UNIVERSE:LATEST`,
     longWeatherLatest: `${LONG_KEY_PREFIX}MARKET:WEATHER:LATEST`,
     longWeather: `${LONG_KEY_PREFIX}MARKET:WEATHER:LATEST`
};

KEYS.long = {
     namespace: LONG_NAMESPACE,
     keyPrefix: LONG_KEY_PREFIX,
     persistentLearningKey: PERSISTENT_LEARNING_KEY,
     temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
     weekendPolicyVersion: WEEKEND_POLICY_VERSION,
     sessionPolicyVersion: SESSION_POLICY_VERSION,
     weekendMode: WEEKEND_MODE,
     sessionMode: SESSION_MODE,
     scan: KEYS.scan,
     live: KEYS.live,
     trade: KEYS.trade,
     analyze: KEYS.analyze,
     circuit: KEYS.circuit,
     discord: KEYS.discord,
     reset: KEYS.reset,
     market: KEYS.market
};


// Backward compatibility aliases
export const keys = KEYS;


export default {
     KEYS,
     keys,
     assertKeyAllowedForWriteScope,
     validateWriteScope,
     SCOPE_PREFIX_MAP,
     ALLOWED_WRITE_SCOPES
};
