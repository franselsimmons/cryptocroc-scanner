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

const MEASUREMENT_FIX_VERSION = 'LONG_MEASUREMENT_FIX_TRIGGER_BOUNDARY_EXIT_FILL_V2';
const EXIT_FILL_MODEL_VERSION = 'LONG_TRIGGER_BOUNDARY_FILL_PLUS_COST_MODEL_V1';
const EMPIRICAL_VETO_POLICY_VERSION = 'LONG_EXACT_75_CHILD_NET_EDGE_VETO_V1';
const OUTCOME_MEASUREMENT_GATE_MODE = 'STRICT_EXACT_VERSION';
const MIN_COMPLETED_EMPIRICAL_GATE = 35;
const TEMPORAL_CONTEXT_VERSION = 'LONG_TEMPORAL_CONTEXT_UTC_V1';
const WEEKEND_POLICY_VERSION = 'LONG_WEEKEND_OBSERVE_DISCORD_BLOCK_V1';
const SESSION_POLICY_VERSION = 'LONG_SESSION_OBSERVE_V1';
const WEEKEND_MODE = 'OBSERVE';
const SESSION_MODE = 'OBSERVE';


const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = TRUE_MICRO_SCHEMA;


const LEARNING_GRANULARITY =
     'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';


const PARENT_LEARNING_GRANULARITY =
     'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_V1';


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


/*
 * Geldige REST-combinaties.
 *
 * Belangrijk:
 * - KV_URL en REDIS_URL worden bewust NIET gebruikt.
 * - Die variabelen bevatten meestal rediss:// TCP-URL's.
 * - @upstash/redis vereist een https:// REST-URL en REST-token.
 * - URL en token worden altijd uit dezelfde configuratieset gehaald.
 */
const VOLATILE_REDIS_ENV_PAIRS = Object.freeze([
     {
         urlName: 'VOLATILE_REDIS_REST_URL',
       tokenName: 'VOLATILE_REDIS_REST_TOKEN'
  },
  {
       urlName: 'KV_REST_API_URL',
       tokenName: 'KV_REST_API_TOKEN'
  },
  {
       urlName: 'KV_REST_API_URL',
       tokenName: 'KV_REST_TOKEN'
  },
  {
       urlName: 'UPSTASH_REDIS_REST_URL',
       tokenName: 'UPSTASH_REDIS_REST_TOKEN'
  }
]);


const DURABLE_REDIS_ENV_PAIRS = Object.freeze([
  {
       urlName: 'DURABLE_REDIS_REST_URL',
       tokenName: 'DURABLE_REDIS_REST_TOKEN'
  },
  {
       urlName: 'KV_REST_API_URL',
       tokenName: 'KV_REST_API_TOKEN'
  },
  {
       urlName: 'KV_REST_API_URL',
       tokenName: 'KV_REST_TOKEN'
  },
  {
       urlName: 'UPSTASH_REDIS_REST_URL',
       tokenName: 'UPSTASH_REDIS_REST_TOKEN'
  }
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
         fallbackRankingGranularity:
           'PARENT_15_UNTIL_CHILD_MIN_COMPLETED',


         selectableFamilyCount: 75,
         parentFamilyCount: 15,
         parentSelectable: false,
         childSelectable: true,


         parentFamilyRule:
           'MICRO_LONG_{SETUP}_{REGIME}',


         selectableFamilyRule:
           'MICRO_LONG_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',


         setupTypes: LONG_FIXED_SETUP_TYPES,
         regimeBuckets: LONG_FIXED_REGIME_BUCKETS,
         confirmationProfiles: LONG_CONFIRMATION_PROFILES
    };
}


function longRiskFlags() {
    return {
         riskGeometryRule: 'LONG: sl < entry < tp',
         tpHitRule: 'LONG: price >= tp',
         slHitRule: 'LONG: price <= sl',


         grossRFormula:
           '(exitPrice - entry) / (entry - initialSl)',


         currentRFormula:
           '(currentPrice - entry) / (entry - initialSl)',


         validLongRiskShape: true,
         longRiskFormula: 'sl < entry < tp',
         longTpExitRule: 'price >= tp',
         longSlExitRule: 'price <= sl',
         longTimeStopExitRule: 'TIME_STOP',


         longGrossRFormula:
           '(exitPrice - entry) / (entry - initialSl)',


         longCurrentRFormula:
           '(currentPrice - entry) / (entry - initialSl)'
    };
}


function currentFitFlags() {
    return {
         currentFitSoftOnly: true,
         currentFitBlocksLearning: false,
         currentFitBlocksVirtualLearning: false,
         currentFitBlocksShadowLearning: false,


         currentFitPolarity:
           'BULLISH_POSITIVE_BEARISH_NEGATIVE',


         currentFitDefinition:
           'LONG_MIRRORED_CURRENT_FIT'
    };
}


function modeFlags() {
    return {
         namespace: LONG_NAMESPACE,
         redisNamespace: LONG_NAMESPACE,
         keyPrefix: LONG_KEY_PREFIX,
         redisKeyPrefix: LONG_KEY_PREFIX,
         persistentLearningKey: PERSISTENT_LEARNING_KEY,
         measurementFixVersion: MEASUREMENT_FIX_VERSION,
         acceptedOutcomeMeasurementVersion: MEASUREMENT_FIX_VERSION,
         exitFillModelVersion: EXIT_FILL_MODEL_VERSION,
         outcomeMeasurementGateMode: OUTCOME_MEASUREMENT_GATE_MODE,
         empiricalVetoPolicyVersion: EMPIRICAL_VETO_POLICY_VERSION,
         empiricalVetoMinCompleted: MIN_COMPLETED_EMPIRICAL_GATE,
         temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
         weekendPolicyVersion: WEEKEND_POLICY_VERSION,
         sessionPolicyVersion: SESSION_POLICY_VERSION,
         weekendMode: WEEKEND_MODE,
         sessionMode: SESSION_MODE,
         weekendLearningAllowed: true,
         weekendVirtualEntryAllowed: true,
         weekendDiscordEntryAllowed: false,
         weekendExitMonitoringAllowed: true,
         weekendOutcomeRecordingAllowed: true,
         sessionLearningAllowed: true,
         sessionVirtualEntryAllowed: true,
         sessionDiscordEntryAllowed: true,
         sessionPolicyObservedOnly: true,
         redisKeysSeparatedFromShortRoot: true,


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
shadowOnly: true,
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


manualSelectionMatchMode:
  'EXACT_TRUE_MICRO_FAMILY_ID',


discordOnlyForExactTrueMicroMatch: true,
discordOnlyForSelectedMicroFamilies: true,


scannerFingerprintsMetadataOnly: true,
scannerFingerprintsUsedAsLearningFamily: false,
scannerBucketsMetadataOnly: true,
legacy25BucketsMetadataOnly: true,


executionFingerprintsMetadataOnly: true,
executionFingerprintsUsedAsLearningFamily: false,


analyzeMicroFamiliesOnly: true,


learningIdentitySource:
  'ANALYZE_TRUE_MICRO_FAMILY',


symbolExcludedFromFamilyId: true,
coinNameExcludedFromFamilyId: true,
hashesExcludedFromFamilyId: true,
         completedDefinition:
              'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',


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


         ...taxonomyFlags(),
         ...longRiskFlags(),
         ...currentFitFlags()
    };
}


function envValue(...names) {
    for (const name of names) {
         const value = process.env[name];


         if (
              value !== undefined &&
              value !== null &&
              String(value).trim() !== ''
         ) {
              return String(value).trim();
         }
    }
    return '';
}


function isValidHttpsRedisUrl(value) {
    const raw = String(value || '').trim();


    if (!raw) return false;


    try {
        const parsed = new URL(raw);


        return (
             parsed.protocol === 'https:' &&
             Boolean(parsed.hostname) &&
             !parsed.username &&
             !parsed.password
        );
    } catch {
        return false;
    }
}


function sanitizeRedisRestUrl(value) {
    const raw = String(value || '').trim();


    if (!isValidHttpsRedisUrl(raw)) {
        return '';
    }


    return raw.replace(/\/+$/u, '');
}


function resolveRedisEnvironment(pairs = []) {
    const invalidUrlVariables = [];
    const incompletePairs = [];


    for (const pair of pairs) {
        const urlRaw = envValue(pair.urlName);
        const token = envValue(pair.tokenName);


        if (!urlRaw && !token) {
             continue;
        }


        const url = sanitizeRedisRestUrl(urlRaw);
         if (urlRaw && !url) {
              invalidUrlVariables.push(pair.urlName);
         }


         if (!url || !token) {
              incompletePairs.push({
                urlName: pair.urlName,
                tokenName: pair.tokenName,
                urlSet: Boolean(urlRaw),
                tokenSet: Boolean(token),
                validHttpsUrl: Boolean(url)
              });


              continue;
         }


         return {
              url,
              token,


              urlName: pair.urlName,
              tokenName: pair.tokenName,


              valid: true,
              invalidUrlVariables,
              incompletePairs
         };
    }


    return {
         url: '',
         token: '',


         urlName: null,
         tokenName: null,


         valid: false,
         invalidUrlVariables,
         incompletePairs
    };
}


function makeRedis(environment, label) {
    const url = environment?.url || '';
    const token = environment?.token || '';


    if (!url || !token) {
         const invalidVariables = Array.isArray(
              environment?.invalidUrlVariables
         )
              ? environment.invalidUrlVariables.join(',')
              : '';


         throw new Error(
              [
                  `${label}_REDIS_REST_ENV_MISSING`,
                  'Expected one complete HTTPS REST pair',
                  'Supported URL variables:',
                  label === 'VOLATILE'
                    ? 'VOLATILE_REDIS_REST_URL,KV_REST_API_URL,UPSTASH_REDIS_REST_URL'
                    : 'DURABLE_REDIS_REST_URL,KV_REST_API_URL,UPSTASH_REDIS_REST_URL',
                  invalidVariables
                    ? `Invalid non-HTTPS URL variables ignored:${invalidVariables}`
                    : null,
                  'KV_URL and REDIS_URL are intentionally ignored'
              ]
                  .filter(Boolean)
                  .join(':')
         );
    }


    if (!isValidHttpsRedisUrl(url)) {
         throw new Error(
              `${label}_REDIS_REST_URL_INVALID:URL_MUST_START_WITH_HTTPS`
         );
    }


    return new Redis({
         url,
         token,
         automaticDeserialization: false
    });
}


function getVolatileEnv() {
    return resolveRedisEnvironment(
         VOLATILE_REDIS_ENV_PAIRS
    );
}


function getDurableEnv() {
    return resolveRedisEnvironment(
         DURABLE_REDIS_ENV_PAIRS
    );
}


let volatileRedis = null;
let durableRedis = null;


function upper(value) {
    return String(value || '')
         .trim()
         .toUpperCase();
}


function isBlockedShortKey(key = '') {
    const value = upper(key);


    return BLOCKED_KEY_PREFIXES.some(
         (prefix) => value.startsWith(prefix)
    );
}


function isRootAppKey(key = '') {
    const value = String(key || '').trim();


    return ROOT_KEY_PREFIXES.some(
         (prefix) => value.startsWith(prefix)
    );
}


function isPublicMarketKey(key = '') {
    const value = String(key || '').trim();


    return PUBLIC_MARKET_KEY_PREFIXES.some(
         (prefix) => (
             value === prefix ||
             value.startsWith(`${prefix}:`)
         )
    );
}


function isLongKey(key = '') {
    return String(key || '')
         .trim()
         .startsWith(LONG_KEY_PREFIX);
}


function buildNamespaceError(
    message,
    payload = {}
) {
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


         ...taxonomyFlags(),
         ...longRiskFlags(),
         ...currentFitFlags()
    };


    return error;
}


function normalizeKey(key) {
    const raw = String(key || '').trim();


    if (!raw) return '';


    if (isBlockedShortKey(raw)) {
         throw buildNamespaceError(
              'LONG_REDIS_REFUSED_SHORT_NAMESPACE_KEY',
              {
                  key: raw
              }
         );
    }


    if (isLongKey(raw)) {
         return raw;
    }


    if (isPublicMarketKey(raw)) {
         return `${LONG_KEY_PREFIX}${raw}`;
    }


    if (isRootAppKey(raw)) {
         return `${LONG_KEY_PREFIX}${raw}`;
    }


    return `${LONG_KEY_PREFIX}${raw}`;
}


function normalizePattern(pattern) {
    const raw = String(pattern || '').trim();


    if (!raw) return '';


    if (isBlockedShortKey(raw)) {
         throw buildNamespaceError(
              'LONG_REDIS_REFUSED_SHORT_NAMESPACE_PATTERN',
              {
                  pattern: raw
              }
         );
    }


    if (raw.startsWith(LONG_KEY_PREFIX)) {
         return raw;
    }


    if (isPublicMarketKey(raw)) {
         return `${LONG_KEY_PREFIX}${raw}`;
    }


    if (isRootAppKey(raw)) {
         return `${LONG_KEY_PREFIX}${raw}`;
    }


    if (raw === '*') {
         return `${LONG_KEY_PREFIX}*`;
    }


    return `${LONG_KEY_PREFIX}${raw}`;
}


function normalizeLimit(
    value,
    fallback = DEFAULT_LOG_LIMIT
) {
    const number = Math.floor(
         Number(value)
    );
    if (
         !Number.isFinite(number) ||
         number <= 0
    ) {
         return fallback;
    }


    return number;
}


function normalizeScanCount(
    value = DEFAULT_SCAN_COUNT
) {
    const number = Math.floor(
         Number(value)
    );


    if (
         !Number.isFinite(number) ||
         number <= 0
    ) {
         return DEFAULT_SCAN_COUNT;
    }


    return Math.max(
         1,
         Math.min(1000, number)
    );
}


function normalizeMax(
    value,
    fallback = 1000
) {
    const number = Math.floor(
         Number(value)
    );


    if (
         !Number.isFinite(number) ||
         number <= 0
    ) {
         return fallback;
    }


    return number;
}
function parseJsonValue(
    value,
    fallback = null
) {
    if (
        value === null ||
        value === undefined
    ) {
        return fallback;
    }


    if (typeof value !== 'string') {
        return value;
    }


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


function stringifyJsonValue(
    value,
    keyForError = 'UNKNOWN_KEY'
) {
    if (value === undefined) {
        throw new Error(
             `JSON_UNDEFINED_VALUE:${keyForError}`
        );
    }


    try {
        return JSON.stringify(value);
    } catch (error) {
        throw new Error(
             `JSON_STRINGIFY_FAILED:${keyForError}:${error?.message || String(error)}`
        );
    }
}
function normalizeScanResult(result) {
    if (!Array.isArray(result)) {
         return {
              cursor: 0,
              keys: []
         };
    }


    const [
         nextCursor,
         keys
    ] = result;


    return {
         cursor: Number(nextCursor) || 0,


         keys: Array.isArray(keys)
              ? keys.filter(Boolean)
              : []
    };
}


function withLongMeta(value) {
    if (
         !value ||
         typeof value !== 'object' ||
         Array.isArray(value)
    ) {
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
         throw buildNamespaceError(
              'LONG_REDIS_REFUSED_NON_LONG_KEY',
             {
                 key: value
             }
        );
    }


    return true;
}


async function deleteKeys(
    redis,
    keys = []
) {
    const rows = Array.isArray(keys)
        ? keys
                 .filter(Boolean)
                 .map(normalizeKey)
                 .filter(
                     (key) => (
                         key.startsWith(
                           LONG_KEY_PREFIX
                         ) ||
                         isPublicMarketKey(key)
                     )
                 )
        : [];


    if (!rows.length) {
        return 0;
    }


    let deleted = 0;


    for (
        let index = 0;
        index < rows.length;
        index += DEFAULT_DELETE_BATCH_SIZE
    ) {
        const batch = rows.slice(
             index,
             index + DEFAULT_DELETE_BATCH_SIZE
        );


        if (!batch.length) {
             continue;
        }
        const result = await redis.del(
             ...batch
        );


        const count = Number(result);


        deleted += Number.isFinite(count)
             ? count
             : batch.length;
    }


    return deleted;
}


export function getVolatileRedis() {
    if (!volatileRedis) {
        const environment =
             getVolatileEnv();


        volatileRedis = makeRedis(
             environment,
             'VOLATILE'
        );
    }


    return volatileRedis;
}


export function getDurableRedis() {
    if (!durableRedis) {
        const environment =
             getDurableEnv();


        durableRedis = makeRedis(
             environment,
             'DURABLE'
        );
    }


    return durableRedis;
}


export function hasVolatileRedisEnv() {
    const environment =
        getVolatileEnv();


    return Boolean(
         environment.valid &&
         environment.url &&
         environment.token
    );
}


export function hasDurableRedisEnv() {
    const environment =
         getDurableEnv();


    return Boolean(
         environment.valid &&
         environment.url &&
         environment.token
    );
}


export function hasRedisEnv() {
    return (
         hasVolatileRedisEnv() &&
         hasDurableRedisEnv()
    );
}


export function normalizeRedisKey(key) {
    return normalizeKey(key);
}


export function normalizeRedisPattern(
    pattern
) {
    return normalizePattern(pattern);
}


export function isLongRedisKey(key) {
    return isLongKey(key);
}


export function isPublicMarketRedisKey(
    key
) {
    return isPublicMarketKey(key);
}


export function redisModeFlags() {
    return modeFlags();
}
export async function getJson(
    redis,
    key,
    fallback = null
) {
    const redisKey = normalizeKey(key);


    if (!redis || !redisKey) {
         return fallback;
    }


    assertLongNormalizedKey(
         redisKey
    );


    const value = await redis.get(
         redisKey
    );


    return parseJsonValue(
         value,
         fallback
    );
}


export async function setJson(
    redis,
    key,
    value,
    options = undefined
) {
    const redisKey = normalizeKey(key);


    if (!redis || !redisKey) {
         throw new Error(
              'SET_LONG_JSON_INVALID_REDIS_OR_KEY'
         );
    }


    assertLongNormalizedKey(
         redisKey
    );


    const payload =
         stringifyJsonValue(
              withLongMeta(value),
              redisKey
         );


    return redis.set(
         redisKey,
         payload,
         options
    );
}


export async function setNxJson(
    redis,
    key,
    value,
    options = {}
) {
    const redisKey = normalizeKey(key);


    if (!redis || !redisKey) {
         throw new Error(
              'SET_NX_LONG_JSON_INVALID_REDIS_OR_KEY'
         );
    }


    assertLongNormalizedKey(
         redisKey
    );


    const payload =
         stringifyJsonValue(
              withLongMeta(value),
              redisKey
         );


    return redis.set(
         redisKey,
         payload,
         {
              ...options,
              nx: true
         }
    );
}


export async function delJson(
    redis,
    key
) {
    const redisKey = normalizeKey(key);


    if (!redis || !redisKey) {
         return 0;
    }


    assertLongNormalizedKey(
         redisKey
    );


    return redis.del(
         redisKey
    );
}


export async function delPattern(
    redis,
    pattern,
    max = 5000
) {
    const redisPattern =
         normalizePattern(pattern);


    if (!redis || !redisPattern) {
         return 0;
    }


    assertLongNormalizedKey(
         redisPattern.replace(
           /\*.*$/u,
           ''
         ) || LONG_KEY_PREFIX
    );


    const maxDelete =
         normalizeMax(max, 5000);


    let cursor = 0;
    let deleted = 0;


    do {
         const scanResult =
           await redis.scan(
                cursor,
                {
                    match: redisPattern,
                 count: normalizeScanCount()
            }
       );


  const normalized =
       normalizeScanResult(
            scanResult
       );


  cursor = normalized.cursor;


  if (!normalized.keys.length) {
       continue;
  }


  const allowedKeys =
       normalized.keys.filter(
            (key) => (
                 String(key || '')
                   .startsWith(
                     LONG_KEY_PREFIX
                   ) ||
                 isPublicMarketKey(key)
            )
       );


  const remaining = Math.max(
       0,
       maxDelete - deleted
  );


  const limitedKeys =
       allowedKeys.slice(
            0,
            remaining
       );


  deleted += await deleteKeys(
       redis,
       limitedKeys
  );


  if (deleted >= maxDelete) {
       break;
  }
} while (cursor !== 0);
    return deleted;
}


export async function getKeys(
    redis,
    pattern,
    max = 1000
) {
    const redisPattern =
         normalizePattern(pattern);


    if (!redis || !redisPattern) {
         return [];
    }


    assertLongNormalizedKey(
         redisPattern.replace(
           /\*.*$/u,
           ''
         ) || LONG_KEY_PREFIX
    );


    const maxKeys =
         normalizeMax(max, 1000);


    let cursor = 0;


    const output = [];
    const seen = new Set();


    do {
         const scanResult =
           await redis.scan(
                cursor,
                {
                    match: redisPattern,
                    count: normalizeScanCount()
                }
           );


         const normalized =
           normalizeScanResult(
                scanResult
           );


         cursor = normalized.cursor;
      for (const key of normalized.keys) {
           if (
               !key ||
               seen.has(key)
           ) {
               continue;
           }


           if (
               !String(key).startsWith(
                  LONG_KEY_PREFIX
               ) &&
               !isPublicMarketKey(key)
           ) {
               continue;
           }


           seen.add(key);
           output.push(key);


           if (
               output.length >= maxKeys
           ) {
               break;
           }
      }


      if (
           output.length >= maxKeys
      ) {
           break;
      }
    } while (cursor !== 0);


    return output;
}


export async function pushJsonLog(
    redis,
    key,
    value,
    limit = DEFAULT_LOG_LIMIT
) {
    const redisKey = normalizeKey(key);


    if (!redis || !redisKey) {
      throw new Error(
              'PUSH_LONG_JSON_LOG_INVALID_REDIS_OR_KEY'
         );
    }


    assertLongNormalizedKey(
         redisKey
    );


    const safeLimit =
         normalizeLimit(
              limit,
              DEFAULT_LOG_LIMIT
         );


    const payload =
         stringifyJsonValue(
              withLongMeta(value),
              redisKey
         );


    await redis.lpush(
         redisKey,
         payload
    );


    await redis.ltrim(
         redisKey,
         0,
         safeLimit - 1
    );


    return true;
}


export async function readJsonLogs(
    redis,
    key,
    limit = 100
) {
    const redisKey = normalizeKey(key);


    if (!redis || !redisKey) {
         return [];
    }


    assertLongNormalizedKey(
         redisKey
);


const safeLimit =
     normalizeLimit(
          limit,
          100
     );


const rows =
     await redis.lrange(
          redisKey,
          0,
          safeLimit - 1
     );


return (
     Array.isArray(rows)
          ? rows
          : []
)
     .map((row) => {
          if (
               row === null ||
               row === undefined
          ) {
               return null;
          }


          if (
               typeof row !== 'string'
          ) {
               return withLongMeta(row);
          }


          const parsed =
               parseJsonValue(
                    row,
                    null
               );


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
    if (!redis) {
        return false;
    }


    try {
        const result =
             await redis.ping();


        return (
             result === 'PONG' ||
             result === 'pong' ||
             result === true
        );
    } catch {
        return false;
    }
}


export default {
    getVolatileRedis,
    getDurableRedis,


    hasVolatileRedisEnv,
    hasDurableRedisEnv,
    hasRedisEnv,


    normalizeRedisKey,
    normalizeRedisPattern,


    isLongRedisKey,
    isPublicMarketRedisKey,


    redisModeFlags,


    getJson,
    setJson,
    setNxJson,
    delJson,
    delPattern,
    getKeys,


    pushJsonLog,
    readJsonLogs,
     pingRedis
};
