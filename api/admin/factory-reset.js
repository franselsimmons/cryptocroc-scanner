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
const TARGET_SCANNER_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';
const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';

const TEMPORAL_CONTEXT_VERSION = 'LONG_TEMPORAL_CONTEXT_UTC_V1';
const WEEKEND_POLICY_VERSION = 'LONG_WEEKEND_OBSERVE_DISCORD_BLOCK_V1';
const SESSION_POLICY_VERSION = 'LONG_SESSION_OBSERVE_V1';
const WEEKEND_MODE = 'OBSERVE';
const SESSION_MODE = 'OBSERVE';

const DAY_NAMES_UTC = Object.freeze([
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY'
]);

const PRIMARY_SESSION_BUCKETS = Object.freeze([
  'ASIA',
  'EUROPE',
  'US',
  'ASIA_EU_OVERLAP',
  'EU_US_OVERLAP',
  'OFF_HOURS'
]);

function normalizeTimestampMs(value, fallback = Date.now()) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return Number(fallback);
  return n < 10_000_000_000 ? n * 1000 : n;
}

function buildTemporalContext(timestamp = Date.now()) {
  const contextTs = normalizeTimestampMs(timestamp, Date.now());
  const date = new Date(contextTs);
  const dayIndex = date.getUTCDay();
  const hourUtc = date.getUTCHours();
  const dayOfWeekUtc = DAY_NAMES_UTC[dayIndex] || 'UNKNOWN';
  const isWeekend = dayIndex === 0 || dayIndex === 6;

  const asiaActive = hourUtc >= 0 && hourUtc < 8;
  const europeActive = hourUtc >= 7 && hourUtc < 16;
  const usActive = hourUtc >= 13 && hourUtc < 22;

  const sessionTags = [];
  if (asiaActive) sessionTags.push('ASIA');
  if (europeActive) sessionTags.push('EUROPE');
  if (usActive) sessionTags.push('US');

  let primarySessionBucket = 'OFF_HOURS';
  if (europeActive && usActive) primarySessionBucket = 'EU_US_OVERLAP';
  else if (asiaActive && europeActive) primarySessionBucket = 'ASIA_EU_OVERLAP';
  else if (asiaActive) primarySessionBucket = 'ASIA';
  else if (europeActive) primarySessionBucket = 'EUROPE';
  else if (usActive) primarySessionBucket = 'US';

  return {
    temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
    contextTs,
    hourUtc,
    dayOfWeekUtc,
    dayType: isWeekend ? 'WEEKEND' : 'WEEKDAY',
    isWeekend,
    sessionTags,
    primarySessionBucket,
    sessionOverlap: sessionTags.length > 1,
    offHours: sessionTags.length === 0
  };
}

function firstTemporalValue(row = {}, keys = []) {
  for (const key of keys) {
    const value = row?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function buildEntryTemporalContext(row = {}, fallbackTs = Date.now()) {
  const entryTs = normalizeTimestampMs(
    firstTemporalValue(row, [
      'entryTs',
      'openedAt',
      'openTs',
      'entryAt',
      'createdAt',
      'ts'
    ]),
    fallbackTs
  );
  const context = buildTemporalContext(entryTs);
  return {
    entryTs: context.contextTs,
    entryHourUtc: context.hourUtc,
    entryDayOfWeekUtc: context.dayOfWeekUtc,
    entryDayType: context.dayType,
    entryIsWeekend: context.isWeekend,
    entrySessionTags: context.sessionTags,
    entrySessionBucket: context.primarySessionBucket,
    entrySessionOverlap: context.sessionOverlap,
    entryOffHours: context.offHours
  };
}

function buildExitTemporalContext(row = {}, fallbackTs = null) {
  const rawExitTs = firstTemporalValue(row, [
    'exitTs',
    'closedAt',
    'closeTs',
    'exitAt',
    'completedAt',
    'updatedAt'
  ]);
  if (rawExitTs === null && fallbackTs === null) {
    return {
      exitTs: null,
      exitHourUtc: null,
      exitDayOfWeekUtc: null,
      exitDayType: null,
      exitIsWeekend: null,
      exitSessionTags: [],
      exitSessionBucket: null,
      exitSessionOverlap: false,
      exitOffHours: null
    };
  }
  const context = buildTemporalContext(
    normalizeTimestampMs(rawExitTs, fallbackTs ?? Date.now())
  );
  return {
    exitTs: context.contextTs,
    exitHourUtc: context.hourUtc,
    exitDayOfWeekUtc: context.dayOfWeekUtc,
    exitDayType: context.dayType,
    exitIsWeekend: context.isWeekend,
    exitSessionTags: context.sessionTags,
    exitSessionBucket: context.primarySessionBucket,
    exitSessionOverlap: context.sessionOverlap,
    exitOffHours: context.offHours
  };
}

function emptyTemporalMetricBucket() {
  return {
    seen: 0,
    observations: 0,
    completed: 0,
    wins: 0,
    losses: 0,
    flats: 0,
    totalR: 0,
    avgR: 0,
    grossWinR: 0,
    grossLossR: 0,
    profitFactor: 0,
    directSLCount: 0,
    directSLPct: 0,
    totalCostR: 0,
    avgCostR: 0
  };
}

function normalizeTemporalMetricBucket(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
  const base = emptyTemporalMetricBucket();
  const output = { ...base };
  for (const key of Object.keys(base)) {
    const n = Number(source[key]);
    output[key] = Number.isFinite(n) ? n : base[key];
  }
  return output;
}

function normalizeTemporalStats(row = {}) {
  const contextSource = row.contextStats || row.dayTypeStats || {};
  const sessionSource = row.sessionStats || row.primarySessionStats || {};
  const available = Boolean(
    row.contextStats ||
    row.dayTypeStats ||
    row.sessionStats ||
    row.primarySessionStats
  );
  return {
    temporalStatsAvailable: available,
    temporalStatsSource: available ? 'ANALYZE_AGGREGATE' : 'NOT_YET_AVAILABLE',
    contextStats: {
      WEEKDAY: normalizeTemporalMetricBucket(contextSource.WEEKDAY),
      WEEKEND: normalizeTemporalMetricBucket(contextSource.WEEKEND)
    },
    sessionStats: Object.fromEntries(
      PRIMARY_SESSION_BUCKETS.map((bucket) => [
        bucket,
        normalizeTemporalMetricBucket(sessionSource[bucket])
      ])
    )
  };
}

function temporalPolicyPayload(timestamp = Date.now()) {
  const context = buildTemporalContext(timestamp);
  return {
    temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
    weekendPolicyVersion: WEEKEND_POLICY_VERSION,
    sessionPolicyVersion: SESSION_POLICY_VERSION,
    weekendMode: WEEKEND_MODE,
    sessionMode: SESSION_MODE,
    ...context,
    weekendLearningAllowed: true,
    weekendVirtualEntryAllowed: true,
    weekendDiscordEntryAllowed: !context.isWeekend,
    weekendExitMonitoringAllowed: true,
    weekendOutcomeRecordingAllowed: true,
    sessionLearningAllowed: true,
    sessionVirtualEntryAllowed: true,
    sessionDiscordEntryAllowed: true,
    sessionPolicyObservedOnly: true,
    weekendBlocksNewDiscordEntriesOnly: true,
    existingPositionMonitoringNeverBlockedByWeekend: true,
    temporalContextExcludedFromFamilyId: true,
    sessionContextExcludedFromFamilyId: true
  };
}

function temporalRowPayload(row = {}, fallbackTs = Date.now()) {
  const contextTs = normalizeTimestampMs(
    firstTemporalValue(row, [
      'contextTs',
      'entryTs',
      'openedAt',
      'createdAt',
      'ts',
      'updatedAt'
    ]),
    fallbackTs
  );
  const context = buildTemporalContext(contextTs);
  const entry = buildEntryTemporalContext(row, contextTs);
  const exit = buildExitTemporalContext(row, null);
  return {
    temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
    weekendPolicyVersion: WEEKEND_POLICY_VERSION,
    sessionPolicyVersion: SESSION_POLICY_VERSION,
    weekendMode: WEEKEND_MODE,
    sessionMode: SESSION_MODE,
    ...context,
    ...entry,
    ...exit,
    weekendLearningAllowed: true,
    weekendVirtualEntryAllowed: true,
    weekendDiscordEntryAllowed: !entry.entryIsWeekend,
    weekendExitMonitoringAllowed: true,
    weekendOutcomeRecordingAllowed: true,
    sessionLearningAllowed: true,
    sessionVirtualEntryAllowed: true,
    sessionDiscordEntryAllowed: true,
    sessionPolicyObservedOnly: true,
    weekendBlocksNewDiscordEntriesOnly: true,
    existingPositionMonitoringNeverBlockedByWeekend: true,
    temporalContextExcludedFromFamilyId: true,
    sessionContextExcludedFromFamilyId: true,
    ...normalizeTemporalStats(row)
  };
}

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY';
const LEARNING_GRANULARITY = 
'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const LOCK_TTL_SEC = 300;
const DEFAULT_CONFIRM_TEXT = 'LONG_FACTORY_RESET_CONFIRMED';
const DEFAULT_ROTATION_CONFIRM_TEXT = 'LONG_RESET_ROTATION_CONFIRMED';
const LONG_FIXED_SETUP_TYPES = new Set([
 'BREAKOUT',
 'RETEST',
 'SWEEP_REVERSAL',
 'CONTINUATION',
 'COMPRESSION'
]);
const LONG_FIXED_REGIME_BUCKETS = new Set([
 'TREND',
 'CHOP',
 'SQUEEZE'
]);
const LONG_CONFIRMATION_PROFILES = new Set([
 'A_STRONG_ALIGN',
 'B_FLOW_ALIGN',
 'C_VOLUME_ALIGN',
 'D_MIXED_OK',
 'E_WEAK_CONTRA'
]);
const CONFIRMATION_PROFILE_ORDER = [
 'A_STRONG_ALIGN',
 'B_FLOW_ALIGN',
 'C_VOLUME_ALIGN',
 'D_MIXED_OK',
 'E_WEAK_CONTRA'
];
function callMaybeKey(value, fallback = null) {
 if (typeof value === 'function') {
   try {
     return value();
   } catch {
     return fallback;
   }
 }
 return value || fallback;
}
function namespacedLongKey(key, fallback = null) {
 let raw = String(callMaybeKey(key, fallback) || '').trim();
 if (!raw) return null;
 if (raw.startsWith(LONG_KEY_PREFIX)) return raw;
 if (raw.startsWith('SHORT:')) raw = raw.slice('SHORT:'.length);
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
   ...temporalPolicyPayload(now()),
   targetTradeSide: TARGET_TRADE_SIDE,
   dashboardSide: TARGET_DASHBOARD_SIDE,
   scannerSide: TARGET_SCANNER_SIDE,
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
   virtualPositionsOnly: true,
   virtualTracked: true,
   shadowPositionsVisible: true,
   shadowOutcomesIncluded: true,
   realOrdersDisabled: true,
   bitgetOrdersDisabled: true,
   exchangeOrdersDisabled: true,
   exchangeCallsDisabled: true,
   realOutcomesExcluded: true,
   noRealOrders: true,
   noExchangeOrders: true,
   maxOneOpenPositionPerSymbol: true,
   globalMaxOpenPositionsBlockDisabled: true,
   scannerSide: TARGET_SCANNER_SIDE,
   scannerFingerprintRole: 'METADATA_ONLY',
   scannerFingerprintsMetadataOnly: true,
   scannerFingerprintsUsedAsLearningFamily: false,
   executionFingerprintRole: 'METADATA_ONLY',
   executionFingerprintsMetadataOnly: true,
   executionFingerprintsUsedAsLearningFamily: false,
   analyzeMicroFamiliesOnly: true,
   learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
   symbolExcludedFromFamilyId: true,
   trueMicroOnly: true,
   exactTrueMicroOnly: true,
   exactTrueMicroFamilyRequired: true,
   trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
   broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
   fixedTaxonomyPreferred: true,
   learningGranularity: LEARNING_GRANULARITY,
   parentMicroFamilyCount: 15,
   selectableChildMicroFamilyCount: 75,
   parentFamilyRule: 'MICRO_LONG_{SETUP}_{REGIME}',
   selectableFamilyRule: 'MICRO_LONG_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',
   manualSelectionRequired: true,
   discordOnlyForSelectedMicroFamilies: true,
   discordOnlyForExactTrueMicroMatch: true,
   manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
   discordSelectionRule: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY',
   parentMatchDoesNotTriggerDiscord: true,
   macroMatchDoesNotTriggerDiscord: true,
   persistentLearningKey: PERSISTENT_LEARNING_KEY,
   weekResetDisabled: true,
   isoWeekLearningDisabled: true,
   completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
   scoringRSource: 'netR',
   winsLossesFlatsSource: 'netR',
   winrateDefinition: 'netR > 0',
   avgRSource: 'netR',
   totalRSource: 'netR',
   avgCostRShown: true,
   riskTradeSide: TARGET_TRADE_SIDE,
   riskGeometryRule: 'LONG: sl < entry < tp',
   tpHitRule: 'LONG: price >= tp',
   slHitRule: 'LONG: price <= sl',
   grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
   currentRFormula: '(currentPrice - entry) / (entry - initialSl)',
   currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
   currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
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
   .replaceAll('SHORT_DISABLED_FALSE', '')
   .replaceAll('SHORTDISABLED_FALSE', '')
   .replaceAll('BLOCK_SHORT_FALSE', '')
   .replaceAll('SHORT_ENABLED_FALSE', '')
   .replaceAll('SHORT_ONLY_FALSE', '')
   .replaceAll('LONG_DISABLED_FALSE', '')
   .replaceAll('LONGDISABLED_FALSE', '')
   .replaceAll('BLOCK_LONG_FALSE', '')
   .replaceAll('LONG_ENABLED_FALSE', '')
   .replaceAll('LONG_ONLY_FALSE', '')
   .replaceAll('SHORT_DISABLED_LONG_ONLY', 'LONG')
   .replaceAll('SHORTDISABLED_LONG_ONLY', 'LONG')
   .replaceAll('BLOCK_SHORT', 'LONG')
   .replaceAll('SHORT_DISABLED', 'LONG')
   .replaceAll('SHORTDISABLED', 'LONG')
   .replaceAll('LONG_DISABLED_SHORT_ONLY', 'SHORT')
   .replaceAll('LONGDISABLED_SHORT_ONLY', 'SHORT')
   .replaceAll('BLOCK_LONG', 'SHORT')
   .replaceAll('LONG_DISABLED', 'SHORT')
   .replaceAll('LONGDISABLED', 'SHORT')
   .replaceAll('SHORT_ONLY_MODE', 'SHORT')
   .replaceAll('SHORT_ONLY', 'SHORT')
   .replaceAll('SHORT-ONLY', 'SHORT')
   .replaceAll('LONG_ONLY_MODE', 'LONG')
   .replaceAll('LONG_ONLY', 'LONG')
   .replaceAll('LONG-ONLY', 'LONG');
}
function normalizeSignalText(value = '') {
 return cleanSideText(value)
   .replace(/[^A-Z0-9=:_|]+/g, '_')
   .replace(/^_+|_+$/g, '');
}
function hasSignalPattern(value = '', patterns = []) {
 const text = normalizeSignalText(value);
 if (!text) return false;
 return patterns.some((pattern) => (
   text === pattern ||
   text.startsWith(`${pattern}_`) ||
   text.endsWith(`_${pattern}`) ||
   text.includes(`_${pattern}_`) ||
   text.includes(`=${pattern}`) ||
   text.includes(`:${pattern}`) ||
   text.includes(`|${pattern}|`)
 ));
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
 const shortHit = hasShortSignal(raw);
 const longHit = hasLongSignal(raw);
 if (longHit && !shortHit) return TARGET_TRADE_SIDE;
 if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;
 if (shortHit && longHit) {
   if (raw.includes('TRADE_SIDE=LONG') || raw.includes('TRADESIDE=LONG')) 
return TARGET_TRADE_SIDE;
   if (raw.includes('TRADE_SIDE=SHORT') || raw.includes('TRADESIDE=SHORT')) return 
OPPOSITE_TRADE_SIDE;
   if (raw.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
   if (raw.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
 }
 return 'UNKNOWN';
}
function hasShortSignal(text = '') {
 return hasSignalPattern(text, [
   'SHORT',
   'BEAR',
   'BEARISH',
   'SELL',
   'DOWN',
   'DOWNSIDE',
   'MICRO_SHORT',
   'SIDE_SHORT',
   'SIDE_BEAR',
   'SIDE_SELL',
   'TRADE_SIDE_SHORT',
   'TRADESIDE_SHORT',
   'POSITION_SIDE_SHORT',
   'POSITIONSIDE_SHORT',
   'DIRECTION_SHORT',
   'DIRECTION_BEAR',
   'DIRECTION_SELL'
 ]);
}
function hasLongSignal(text = '') {
 return hasSignalPattern(text, [
   'LONG',
   'BULL',
   'BULLISH',
   'BUY',
   'UP',
   'UPSIDE',
   'MICRO_LONG',
   'SIDE_LONG',
   'SIDE_BULL',
   'SIDE_BUY',
   'TRADE_SIDE_LONG',
   'TRADESIDE_LONG',
   'POSITION_SIDE_LONG',
   'POSITIONSIDE_LONG',
   'DIRECTION_LONG',
   'DIRECTION_BULL',
   'DIRECTION_BUY'
 ]);
}
function isScannerFingerprintId(id = '') {
 const value = upper(id);
 return (
   value.startsWith('MICRO_LONG_SCANNER__') ||
   value.includes('MICRO_LONG_SCANNER__') ||
   value.startsWith('LONG_SCANNER_') ||
   value.includes('LONG_SCANNER_') ||
   value.startsWith('MICRO_SHORT_SCANNER__') ||
   value.includes('MICRO_SHORT_SCANNER__') ||
   value.startsWith('SHORT_SCANNER_') ||
   value.includes('SHORT_SCANNER_') ||
   value.includes('__SCANNER__') ||
   value.includes('SCANNER_GATE_PASS') ||
   value.includes('SCANNER_GATE_FAIL')
 );
}
function isExecutionFingerprintId(id = '') {
 const value = upper(id);
 return (
   value.includes('_XR_') ||
   value.includes('__XR__') ||
   value.includes('EXECUTION_FINGERPRINT') ||
   value.includes('EXECUTION_MICRO') ||
   value.includes('REFINED_EXECUTION')
 );
}
function validLearningId(id = '') {
 const value = String(id || '').trim();
 if (!value) return false;
 if (isScannerFingerprintId(value)) return false;
 if (isExecutionFingerprintId(value)) return false;
 return true;
}
function parseLongTaxonomyMicroId(id = '') {
 const value = upper(id);
 if (!value.startsWith('MICRO_LONG_')) {
   return {
     valid: false,
     selectable: false,
     isParent: false,
     isChild: false,
     rawId: String(id || '').trim()
   };
 }
 let body = value.slice('MICRO_LONG_'.length);
 let confirmationProfile = null;
 for (const profile of CONFIRMATION_PROFILE_ORDER) {
   const suffix = `_${profile}`;
   if (body.endsWith(suffix)) {
     confirmationProfile = profile;
     body = body.slice(0, -suffix.length);
     break;
   }
 }
 let setup = null;
 let regime = null;
 for (const candidateRegime of LONG_FIXED_REGIME_BUCKETS) {
   const suffix = `_${candidateRegime}`;
   if (body.endsWith(suffix)) {
     regime = candidateRegime;
     setup = body.slice(0, -suffix.length);
     break;
   }
 }
 const parentId = setup && regime
   ? `MICRO_LONG_${setup}_${regime}`
   : null;
 const childId = parentId && confirmationProfile
   ? `${parentId}_${confirmationProfile}`
   : null;
 const validParent =
   Boolean(parentId) &&
   LONG_FIXED_SETUP_TYPES.has(setup) &&
   LONG_FIXED_REGIME_BUCKETS.has(regime);
 const validChild =
   validParent &&
   Boolean(confirmationProfile) &&
   LONG_CONFIRMATION_PROFILES.has(confirmationProfile);
 return {
   valid: validParent || validChild,
   selectable: validChild,
   isParent: validParent && !validChild,
   isChild: validChild,
   rawId: String(id || '').trim(),
   setup,
   regime,
   confirmationProfile,
   parentTrueMicroFamilyId: validParent ? parentId : null,
   trueMicroFamilyId: validChild ? childId : validParent ? parentId : null,
   childTrueMicroFamilyId: validChild ? childId : null,
   trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
   learningGranularity: LEARNING_GRANULARITY
 };
}
function isFixedLongParentMicroId(id = '') {
 const parsed = parseLongTaxonomyMicroId(id);
 return parsed.valid && parsed.isParent;
}
function isFixedLongChildMicroId(id = '') {
 const parsed = parseLongTaxonomyMicroId(id);
 return parsed.valid && parsed.isChild;
}
function flattenValues(values = []) {
 const stack = Array.isArray(values) ? [...values] : [values];
 const output = [];
 while (stack.length > 0) {
   const value = stack.shift();
   if (Array.isArray(value)) {
     stack.unshift(...value);
     continue;
   }
   output.push(value);
 }
 return output;
}
function firstFiniteNumber(values = []) {
 for (const value of flattenValues(values)) {
   if (value === undefined || value === null || value === '') continue;
   const n = Number(value);
   if (Number.isFinite(n)) return n;
 }
 return null;
}
function marketBiasHaystack(input = {}) {
 return [
   input.currentMarketBias,
   input.marketBias,
   input.bias,
   input.regime,
   input.regimeCoarse,
   input.btcState,
   input.btcRelation,
   input.scannerSide,
   input.actualScannerSide,
   input.analysisSide,
   input.side,
   input.tradeSide,
   input.positionSide,
   input.direction
 ]
   .map((value) => cleanSideText(value))
   .filter(Boolean)
   .join(' | ');
}
function getLongCurrentFit(input = {}) {
 const explicitLongFit = firstFiniteNumber([
   input.longCurrentFit,
   input.currentLongFit,
   input.bullCurrentFit,
   input.bullishCurrentFit,
   input.longFit,
   input.bullFit,
   input.bullishFit
 ]);
 if (explicitLongFit !== null) return explicitLongFit;
 const explicitShortFit = firstFiniteNumber([
   input.shortCurrentFit,
   input.currentShortFit,
   input.bearCurrentFit,
   input.bearishCurrentFit,
   input.shortFit,
   input.bearFit,
   input.bearishFit
 ]);
 if (explicitShortFit !== null) return -explicitShortFit;
 const rawFit = firstFiniteNumber([
   input.currentFit,
   input.marketCurrentFit,
   input.marketFit,
   input.fitScore
 ]);
 if (rawFit === null) return 0;
 const text = marketBiasHaystack(input);
 const bullish = hasLongSignal(text);
 const bearish = hasShortSignal(text);
 if (bullish && !bearish) return Math.abs(rawFit);
 if (bearish && !bullish) return -Math.abs(rawFit);
 return -rawFit;
}
function getLongRiskGeometry(input = {}) {
 const entry = firstFiniteNumber([
   input.entryPrice,
   input.entry,
   input.avgEntryPrice,
   input.averageEntryPrice,
   input.averageEntry,
   input.openPrice
 ]);
 const initialSl = firstFiniteNumber([
   input.initialSl,
   input.initialSL,
   input.initialStopLoss,
   input.initialStopLossPrice,
   input.stopLoss,
   input.stopLossPrice,
   input.sl,
   input.slPrice
 ]);
 const tp = firstFiniteNumber([
   input.tp,
   input.takeProfit,
   input.takeProfitPrice,
   input.targetPrice,
   input.finalTp,
   input.finalTakeProfit
 ]);
 const exitPrice = firstFiniteNumber([
   input.exitPrice,
   input.closePrice,
   input.closedPrice,
   input.outcomePrice,
   input.fillExitPrice,
   input.exit
 ]);
 const currentPrice = firstFiniteNumber([
   input.currentPrice,
   input.markPrice,
   input.lastPrice,
   input.price
 ]);
 const denominator =
   Number.isFinite(entry) && Number.isFinite(initialSl)
     ? entry - initialSl
     : 0;
 const validGeometry =
   Number.isFinite(entry) &&
   Number.isFinite(initialSl) &&
   Number.isFinite(tp) &&
   denominator > 0 &&
   initialSl < entry &&
   entry < tp;
 const longGrossR =
   validGeometry && Number.isFinite(exitPrice)
     ? (exitPrice - entry) / denominator
     : null;
 const longCurrentR =
   validGeometry && Number.isFinite(currentPrice)
     ? (currentPrice - entry) / denominator
     : null;
 const longTpHit =
   validGeometry &&
   (
     input.longTpHit === true ||
     input.tpHit === true ||
     (Number.isFinite(exitPrice) && exitPrice >= tp) ||
     (Number.isFinite(currentPrice) && currentPrice >= tp)
   );
 const longSlHit =
   validGeometry &&
   (
     input.longSlHit === true ||
     input.slHit === true ||
     (Number.isFinite(exitPrice) && exitPrice <= initialSl) ||
     (Number.isFinite(currentPrice) && currentPrice <= initialSl)
   );
 return {
   entry,
   initialSl,
   tp,
   exitPrice,
   currentPrice,
   denominator,
   validGeometry,
   longTpHit: Boolean(longTpHit),
   longSlHit: Boolean(longSlHit),
   longGrossR,
   longCurrentR,
   riskGeometryRule: 'LONG: sl < entry < tp',
   tpHitRule: 'LONG: price >= tp',
   slHitRule: 'LONG: price <= sl',
   grossRFormula: '(exitPrice - entry) / (entry - initialSl)',
   currentRFormula: '(currentPrice - entry) / (entry - initialSl)'
 };
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
   position.parentTrueMicroFamilyId,
   position.parentMicroFamilyId,
   position.microFamilyId,
   position.trueMicroFamilyId,
   position.learningMicroFamilyId,
   position.analyzeMicroFamilyId,
   position.coarseMicroFamilyId,
   position.baseMicroFamilyId,
   position.legacyMicroFamilyId,
   position.tradeId,
   position.key,
   position.redisKey,
   position.positionKey
 ]
   .map((value) => cleanSideText(value))
   .filter(Boolean)
   .join(' | ');
 const shortSignal = hasShortSignal(text);
 const longSignal = hasLongSignal(text);
 if (longSignal && !shortSignal) return TARGET_TRADE_SIDE;
 if (shortSignal && !longSignal) return OPPOSITE_TRADE_SIDE;
 if (shortSignal && longSignal) {
   const microId = cleanSideText(
     position.trueMicroFamilyId ||
       position.microFamilyId ||
       position.parentTrueMicroFamilyId ||
       position.coarseMicroFamilyId ||
       ''
   );
   if (parseLongTaxonomyMicroId(microId).valid) return TARGET_TRADE_SIDE;
   if (microId.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
 }
 if (position.longOnly === true || position.shortDisabled === true) return 
TARGET_TRADE_SIDE;
 if (position.shortOnly === true || position.longDisabled === true) return 
OPPOSITE_TRADE_SIDE;
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
function isVirtualOrShadowPosition(position = {}) {
 const source = String(position.source || position.positionSource || 
'VIRTUAL').toUpperCase();
 if (
   position.realOrder === true ||
   position.realPosition === true ||
   position.exchangeOrder === true ||
   position.bitgetOrder === true ||
   source === 'REAL' ||
   source === 'LIVE' ||
   source === 'BITGET' ||
   source === 'EXCHANGE'
 ) {
   return false;
 }
 return source === 'VIRTUAL' || source === 'SHADOW' || source === 'PAPER' || 
source === '';
}
function isLongPosition(position = {}) {
 const side = inferPositionTradeSide(position);
 if (side === TARGET_TRADE_SIDE) return isVirtualOrShadowPosition(position);
 if (side === OPPOSITE_TRADE_SIDE) return false;
 return isLongNamespacedPosition(position) && 
isVirtualOrShadowPosition(position);
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
 const source = String(position.source || position.positionSource || 
'VIRTUAL').toUpperCase();
 const rawTrueMicroFamilyId =
   position.trueMicroFamilyId ||
   position.learningMicroFamilyId ||
   position.analyzeMicroFamilyId ||
   position.microFamilyId ||
   null;
 const parsedTrue = parseLongTaxonomyMicroId(rawTrueMicroFamilyId);
 const rawParentTrueMicroFamilyId =
   parsedTrue.parentTrueMicroFamilyId ||
   position.parentTrueMicroFamilyId ||
   position.coarseMicroFamilyId ||
   position.baseMicroFamilyId ||
   position.legacyMicroFamilyId ||
   position.parentMacroFamilyId ||
   position.macroFamilyId ||
   position.parentMicroFamilyId ||
   null;
 const parsedParent = parseLongTaxonomyMicroId(rawParentTrueMicroFamilyId);
 const trueMicroFamilyId =
   parsedTrue.trueMicroFamilyId ||
   rawTrueMicroFamilyId ||
   null;
 const parentTrueMicroFamilyId =
   parsedTrue.parentTrueMicroFamilyId ||
   parsedParent.parentTrueMicroFamilyId ||
   rawParentTrueMicroFamilyId ||
   null;
 const riskGeometry = getLongRiskGeometry(position);
 const longCurrentFit = getLongCurrentFit(position);
 return {
   ...temporalRowPayload(position),
   tradeId: position.tradeId || null,
   symbol: position.symbol || position.baseSymbol || null,
   baseSymbol: position.baseSymbol || position.symbol || null,
   contractSymbol: position.contractSymbol || null,
   microFamilyId: trueMicroFamilyId,
   trueMicroFamilyId,
   parentTrueMicroFamilyId,
   coarseMicroFamilyId: parentTrueMicroFamilyId || trueMicroFamilyId || null,
   familyId: position.familyId || null,
   macroFamilyId: parentTrueMicroFamilyId || position.parentMacroFamilyId || 
position.macroFamilyId || position.parentMicroFamilyId || null,
   taxonomySetup: parsedTrue.setup || parsedParent.setup || null,
   taxonomyRegime: parsedTrue.regime || parsedParent.regime || null,
   confirmationProfile: parsedTrue.confirmationProfile || null,
   selectableTrueMicroFamily: Boolean(trueMicroFamilyId && 
isFixedLongChildMicroId(trueMicroFamilyId)),
   parentTrueMicroFamily: Boolean(parentTrueMicroFamilyId && 
isFixedLongParentMicroId(parentTrueMicroFamilyId)),
   trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
   learningGranularity: LEARNING_GRANULARITY,
   side: TARGET_DASHBOARD_SIDE,
   tradeSide: TARGET_TRADE_SIDE,
   positionSide: TARGET_TRADE_SIDE,
   direction: TARGET_TRADE_SIDE,
   longOnly: true,
   shortDisabled: true,
   shortOnly: false,
   longDisabled: false,
   source: source === 'VIRTUAL' || source === 'SHADOW' || source === 'PAPER'
     ? source === 'SHADOW' ? 'SHADOW' : 'VIRTUAL'
     : source,
   outcomeSource: source === 'SHADOW' ? 'SHADOW' : 'VIRTUAL',
   virtualOnly: source !== 'SHADOW',
   virtualTracked: true,
   shadowOnly: source === 'SHADOW' || position.shadowOnly !== false,
   exchangeTouched: false,
   bitgetOrdersTouched: false,
   realOrdersTouched: false,
   entry: riskGeometry.entry ?? position.entry ?? position.entryPrice ?? null,
   entryPrice: riskGeometry.entry ?? position.entryPrice ?? position.entry ?? 
null,
   sl: riskGeometry.initialSl ?? position.sl ?? position.stopLoss ?? 
position.initialSl ?? null,
   tp: riskGeometry.tp ?? position.tp ?? position.takeProfit ?? null,
   initialSl: riskGeometry.initialSl ?? position.initialSl ?? position.sl ?? 
position.stopLoss ?? null,
   validLongRiskShape: Boolean(riskGeometry.validGeometry),
   validLongGeometry: Boolean(riskGeometry.validGeometry),
   riskGeometryRule: riskGeometry.riskGeometryRule,
   tpHitRule: riskGeometry.tpHitRule,
   slHitRule: riskGeometry.slHitRule,
   grossRFormula: riskGeometry.grossRFormula,
   currentRFormula: riskGeometry.currentRFormula,
   longTpHit: riskGeometry.longTpHit,
   longSlHit: riskGeometry.longSlHit,
   tpHit: riskGeometry.longTpHit,
   slHit: riskGeometry.longSlHit,
   longGrossR: riskGeometry.longGrossR ?? position.longGrossR ?? null,
   longCurrentR: riskGeometry.longCurrentR ?? position.longCurrentR ?? 
position.currentR ?? null,
   currentPrice: riskGeometry.currentPrice ?? position.currentPrice ?? 
position.lastPrice ?? null,
   lastPrice: position.lastPrice ?? position.currentPrice ?? null,
   ageSec: position.ageSec ?? null,
   currentR: riskGeometry.longCurrentR ?? position.longCurrentR ?? 
position.currentR ?? null,
   mfeR: position.longMfeR ?? position.mfeR ?? null,
   maeR: position.longMaeR ?? position.maeR ?? null,
   currentFit: longCurrentFit,
   longCurrentFit,
   bullCurrentFit: longCurrentFit,
   bearishCurrentFit: -longCurrentFit,
   currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
   currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
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
 deleted.circuitPaused = await delPatternSafe(
   durable,
   LONG_KEYS.circuit.pausedPattern,
   10000
 );
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
 deleted.analyzeTemporalContext = await delPatternSafe(
   durable,
   LONG_KEYS.analyze.temporalPattern,
   10000
 );
 deleted.analyzeContextStats = await delPatternSafe(
   durable,
   LONG_KEYS.analyze.contextStatsPattern,
   10000
 );
 deleted.analyzeSessionStats = await delPatternSafe(
   durable,
   LONG_KEYS.analyze.sessionStatsPattern,
   10000
 );
 if (resetRotation) {
   deleted.activeRotation = await delKey(
     durable,
     LONG_KEYS.analyze.activeRotation
   );
 } else {
   deleted.activeRotation = 0;
   preserved.activeRotation = true;
   preserved.manualDiscordSelection = true;
 }
 deleted.nextRotation = await delKey(
   durable,
   LONG_KEYS.analyze.nextRotation
 );
 deleted.rotationValidFrom = await delKey(
   durable,
   LONG_KEYS.analyze.rotationValidFrom
 );
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
 res.setHeader('X-Temporal-Context-Version', TEMPORAL_CONTEXT_VERSION);
 res.setHeader('X-Weekend-Policy-Version', WEEKEND_POLICY_VERSION);
 res.setHeader('X-Session-Policy-Version', SESSION_POLICY_VERSION);
 res.setHeader('X-Weekend-Mode', WEEKEND_MODE);
 res.setHeader('X-Session-Mode', SESSION_MODE);
 res.setHeader('X-Admin-Factory-Reset-Mode', 'long-only-75-child-virtual-learning-v1');
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
 res.setHeader('X-Discord-Selection-Rule', 
'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY');
 res.setHeader('X-True-Micro-Family-Schema', TRUE_MICRO_SCHEMA);
 res.setHeader('X-Learning-Granularity', LEARNING_GRANULARITY);
 res.setHeader('X-Persistent-Learning-Key', PERSISTENT_LEARNING_KEY);
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
   if (resetRotation && !isRotationResetConfirmed(body, 
requiredRotationConfirmText)) {
     return res.status(400).json(
       buildBlockedResponse({
         reason: 'LONG_ROTATION_RESET_CONFIRMATION_REQUIRED',
         extra: {
           required: requiredRotationConfirmText,
           note: 'activeRotation bevat je handmatige LONG 75-child trueMicroFamilyId Discord-selectie en wordt standaard bewaard.'
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
     type: 'LONG_FACTORY_RESET',
     ...modePayload(),
     force: forceDeleteVirtualPositions,
     forceDeleteVirtualPositions,
     resetRotation,
     manualRotationPreserved: !resetRotation,
     manualDiscordSelectionPreserved: !resetRotation,
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
       activeRotation: !resetRotation,
       manualDiscordSelection: !resetRotation
     },
     longKeys: {
       namespace: LONG_NAMESPACE,
       prefix: LONG_KEY_PREFIX,
       persistentLearningKey: PERSISTENT_LEARNING_KEY,
       scan: LONG_KEYS.scan,
       trade: LONG_KEYS.trade,
       analyze: LONG_KEYS.analyze,
       reset: LONG_KEYS.reset,
       discord: LONG_KEYS.discord
     },
     ...temporalPolicyPayload(now()),
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
