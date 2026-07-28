// ================= FILE: api/admin/discord-logs.js =================
import { KEYS } from '../../src/keys.js';
import { getDurableRedis, readJsonLogs } from '../../src/redis.js';
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
const TRUE_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'n', 'off']);
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
function methodNotAllowed(res) {
 res.setHeader('Allow', 'GET');
 return res.status(405).json({
   ok: false,
   error: 'METHOD_NOT_ALLOWED',
   allowed: ['GET'],
   ...baseModePayload()
 });
}
function firstQueryValue(value, fallback = null) {
 if (Array.isArray(value)) return value[0] ?? fallback;
 if (value === undefined || value === null || value === '') return fallback;
 return value;
}
function firstDefined(...values) {
 return values.find((value) => value !== undefined && value !== null);
}
function bool(value, fallback = false) {
 if (value === undefined || value === null || value === '') return fallback;
 if (typeof value === 'boolean') return value;
 const raw = String(value).trim().toLowerCase();
 if (TRUE_VALUES.has(raw)) return true;
 if (FALSE_VALUES.has(raw)) return false;
 return fallback;
}
function maybeBool(value) {
 if (value === undefined || value === null || value === '') return null;
 if (typeof value === 'boolean') return value;
 const raw = String(value).trim().toLowerCase();
 if (TRUE_VALUES.has(raw)) return true;
 if (FALSE_VALUES.has(raw)) return false;
 return null;
}
function upper(value) {
 return String(value || '').trim().toUpperCase();
}
function cleanText(value = '') {
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
 return cleanText(value)
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
function clampLimit(value, fallback = 100) {
 const limit = Number(value);
 if (!Number.isFinite(limit)) return fallback;
 if (limit < 1) return 1;
 if (limit > 500) return 500;
 return Math.floor(limit);
}
function safeArray(value) {
 return Array.isArray(value) ? value : [];
}
function safeObject(value) {
 return value && typeof value === 'object' && !Array.isArray(value)
   ? value
   : {};
}
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
function normalizeSideToken(value) {
 const raw = cleanText(value);
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
function idLooksLong(id = '') {
 const value = String(id || '').trim();
 if (!validLearningId(value)) return false;
 if (parseLongTaxonomyMicroId(value).valid) return true;
 return hasLongSignal(value);
}
function idLooksShort(id = '') {
 const value = String(id || '').trim();
 if (!validLearningId(value)) return false;
 return hasShortSignal(value);
}
function isSelectableTrueMicroId(id = '') {
 const value = String(id || '').trim();
 if (!validLearningId(value)) return false;
 if (idLooksShort(value) && !idLooksLong(value)) return false;
 return isFixedLongChildMicroId(value);
}
function payloadResult(row = {}) {
 const payload = safeObject(row.payload);
 const result = safeObject(row.result || payload.result);
 return {
   payload,
   result
 };
}
function firstIdentityValue(row = {}, keys = []) {
 const { payload, result } = payloadResult(row);
 for (const key of keys) {
   const value = firstDefined(
     row[key],
     payload[key],
     result[key]
   );
   if (value !== undefined && value !== null && value !== '') {
     return value;
   }
 }
 return null;
}
function firstMetricValue(row = {}, keys = []) {
 const { payload, result } = payloadResult(row);
 for (const key of keys) {
   const value = firstDefined(
     row[key],
     payload[key],
     result[key]
   );
   if (value !== undefined && value !== null && value !== '') {
     return value;
   }
 }
 return null;
}
function firstFiniteMetric(row = {}, keys = []) {
 const { payload, result } = payloadResult(row);
 for (const key of keys) {
   const n = firstFiniteNumber([
     row[key],
     payload[key],
     result[key]
   ]);
   if (n !== null) return n;
 }
 return null;
}
function firstBooleanMetric(row = {}, keys = []) {
 const { payload, result } = payloadResult(row);
 for (const key of keys) {
   const value = maybeBool(firstDefined(
     row[key],
     payload[key],
     result[key]
   ));
   if (value !== null) return value;
 }
 return null;
}
function selectedIdentityValue(row = {}) {
 return firstIdentityValue(row, [
   'selectedTrueMicroFamilyId',
   'selectedMicroFamilyId',
   'manualSelectedTrueMicroFamilyId',
   'manualSelectedMicroFamilyId',
   'activeTrueMicroFamilyId',
   'activeMicroFamilyId'
 ]);
}
function trueMicroFamilyValue(row = {}) {
 return firstIdentityValue(row, [
   'trueMicroFamilyId',
   'learningMicroFamilyId',
   'analyzeMicroFamilyId',
   'microFamilyId',
   'id',
   'key'
 ]);
}
function parentMicroFamilyValue(row = {}) {
 return firstIdentityValue(row, [
   'parentTrueMicroFamilyId',
   'coarseMicroFamilyId',
   'baseMicroFamilyId',
   'legacyMicroFamilyId',
   'macroFamilyId',
   'parentMacroFamilyId',
   'parentMicroFamilyId',
   'familyId'
 ]);
}
function sideHaystack(row = {}) {
 const { payload, result } = payloadResult(row);
 return [
   row.rawInferredTradeSide,
   row.inferredTradeSide,
   row.side,
   row.tradeSide,
   row.positionSide,
   row.direction,
   row.signalSide,
   row.scannerSide,
   row.actualScannerSide,
   row.analysisSide,
   payload.side,
   payload.tradeSide,
   payload.positionSide,
   payload.direction,
   payload.signalSide,
   payload.scannerSide,
   payload.actualScannerSide,
   payload.analysisSide,
   result.side,
   result.tradeSide,
   result.positionSide,
   result.direction,
   row.familyId,
   row.macroFamilyId,
   row.parentMacroFamilyId,
   row.parentTrueMicroFamilyId,
   row.microFamilyId,
   row.trueMicroFamilyId,
   row.learningMicroFamilyId,
   row.analyzeMicroFamilyId,
   row.coarseMicroFamilyId,
   payload.familyId,
   payload.macroFamilyId,
   payload.parentMacroFamilyId,
   payload.parentTrueMicroFamilyId,
   payload.microFamilyId,
   payload.trueMicroFamilyId,
   payload.learningMicroFamilyId,
   payload.analyzeMicroFamilyId,
   payload.coarseMicroFamilyId,
   result.familyId,
   result.macroFamilyId,
   result.parentMacroFamilyId,
   result.parentTrueMicroFamilyId,
   result.microFamilyId,
   result.trueMicroFamilyId,
   result.learningMicroFamilyId,
   result.analyzeMicroFamilyId,
   result.coarseMicroFamilyId,
   row.type,
   row.reason,
   row.message,
   payload.type,
   payload.reason,
   payload.message,
   result.type,
   result.reason,
   result.message,
   ...safeArray(row.definitionParts),
   ...safeArray(payload.definitionParts),
   ...safeArray(result.definitionParts),
   ...safeArray(row.microDefinitionParts),
   ...safeArray(payload.microDefinitionParts),
   ...safeArray(result.microDefinitionParts),
   ...safeArray(row.executionFingerprintParts),
   ...safeArray(payload.executionFingerprintParts),
   ...safeArray(result.executionFingerprintParts)
 ]
   .map((value) => cleanText(value))
   .filter(Boolean)
   .join(' | ');
}
function marketBiasHaystack(row = {}) {
 const { payload, result } = payloadResult(row);
 return [
   row.currentMarketBias,
   row.marketBias,
   row.bias,
   row.regime,
   row.regimeCoarse,
   row.btcState,
   row.btcRelation,
   row.scannerSide,
   row.actualScannerSide,
   row.analysisSide,
   payload.currentMarketBias,
   payload.marketBias,
   payload.bias,
   payload.regime,
   payload.regimeCoarse,
   payload.btcState,
   payload.btcRelation,
   payload.scannerSide,
   payload.actualScannerSide,
   payload.analysisSide,
   result.currentMarketBias,
   result.marketBias,
   result.bias,
   result.regime,
   result.regimeCoarse,
   result.btcState,
   result.btcRelation,
   result.scannerSide,
   result.actualScannerSide,
   result.analysisSide
 ]
   .map((value) => cleanText(value))
   .filter(Boolean)
   .join(' | ');
}
function getLongCurrentFit(row = {}) {
 const explicitLongFit = firstFiniteMetric(row, [
   'longCurrentFit',
   'currentLongFit',
   'bullCurrentFit',
   'bullishCurrentFit',
   'longFit',
   'bullFit',
   'bullishFit'
 ]);
 if (explicitLongFit !== null) return explicitLongFit;
 const explicitShortFit = firstFiniteMetric(row, [
   'shortCurrentFit',
   'currentShortFit',
   'bearCurrentFit',
   'bearishCurrentFit',
   'shortFit',
   'bearFit',
   'bearishFit'
 ]);
 if (explicitShortFit !== null) return -explicitShortFit;
 const rawFit = firstFiniteMetric(row, [
   'currentFit',
   'marketCurrentFit',
   'marketFit',
   'fitScore'
 ]);
 if (rawFit === null) return 0;
 const text = marketBiasHaystack(row);
 const bullish = hasLongSignal(text);
 const bearish = hasShortSignal(text);
 if (bullish && !bearish) return Math.abs(rawFit);
 if (bearish && !bullish) return -Math.abs(rawFit);
 return -rawFit;
}
function getLongRiskGeometry(row = {}) {
 const entry = firstFiniteMetric(row, [
   'entryPrice',
   'entry',
   'avgEntryPrice',
   'averageEntryPrice',
   'averageEntry',
   'openPrice'
 ]);
 const initialSl = firstFiniteMetric(row, [
   'initialSl',
   'initialSL',
   'initialStopLoss',
   'initialStopLossPrice',
   'stopLoss',
   'stopLossPrice',
   'sl',
   'slPrice'
 ]);
 const tp = firstFiniteMetric(row, [
   'tp',
   'takeProfit',
   'takeProfitPrice',
   'targetPrice',
   'finalTp',
   'finalTakeProfit'
 ]);
 const exitPrice = firstFiniteMetric(row, [
   'exitPrice',
   'closePrice',
   'closedPrice',
   'outcomePrice',
   'fillExitPrice',
   'exit'
 ]);
 const currentPrice = firstFiniteMetric(row, [
   'currentPrice',
   'markPrice',
   'lastPrice',
   'price'
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
 const explicitLongTpHit = firstBooleanMetric(row, [
   'longTpHit',
   'longTakeProfitHit'
 ]);
 const explicitLongSlHit = firstBooleanMetric(row, [
   'longSlHit',
   'longStopLossHit'
 ]);
 const longTpHit =
   validGeometry &&
   (
     explicitLongTpHit === true ||
     (Number.isFinite(exitPrice) && exitPrice >= tp) ||
     (Number.isFinite(currentPrice) && currentPrice >= tp)
   );
 const longSlHit =
   validGeometry &&
   (
     explicitLongSlHit === true ||
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
function inferTradeSide(row = {}) {
 const rawInferredTradeSide = normalizeSideToken(row.rawInferredTradeSide);
 const inferredTradeSide = normalizeSideToken(row.inferredTradeSide);
 if (rawInferredTradeSide === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
 if (rawInferredTradeSide === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
 if (inferredTradeSide === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
 if (inferredTradeSide === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
 const { payload, result } = payloadResult(row);
 const directSources = [
   row.tradeSide,
   row.positionSide,
   row.direction,
   row.side,
   payload.tradeSide,
   payload.positionSide,
   payload.direction,
   payload.side,
   result.tradeSide,
   result.positionSide,
   result.direction,
   result.side
 ];
 for (const source of directSources) {
   const side = normalizeSideToken(source);
   if (side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE) return side;
 }
 const trueMicroFamilyId = cleanText(trueMicroFamilyValue(row));
 const parentTrueMicroFamilyId = cleanText(parentMicroFamilyValue(row));
 if (parseLongTaxonomyMicroId(trueMicroFamilyId).valid) return 
TARGET_TRADE_SIDE;
 if (parseLongTaxonomyMicroId(parentTrueMicroFamilyId).valid) return 
TARGET_TRADE_SIDE;
 if (trueMicroFamilyId.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
 if (parentTrueMicroFamilyId.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
 const text = sideHaystack(row);
 const shortSignal = hasShortSignal(text);
 const longSignal = hasLongSignal(text);
 if (longSignal && !shortSignal) return TARGET_TRADE_SIDE;
 if (shortSignal && !longSignal) return OPPOSITE_TRADE_SIDE;
 if (shortSignal && longSignal) {
   if (trueMicroFamilyId.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
   if (trueMicroFamilyId.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
 }
 if (row.longOnly === true || payload.longOnly === true || result.longOnly === 
true) {
   return TARGET_TRADE_SIDE;
 }
 if (row.shortDisabled === true || payload.shortDisabled === true || 
result.shortDisabled === true) {
   return TARGET_TRADE_SIDE;
 }
 if (row.shortOnly === true || payload.shortOnly === true || result.shortOnly === 
true) {
   return OPPOSITE_TRADE_SIDE;
 }
 if (row.longDisabled === true || payload.longDisabled === true || 
result.longDisabled === true) {
   return OPPOSITE_TRADE_SIDE;
 }
 return 'UNKNOWN';
}
function logHasInvalidLearningId(row = {}) {
 const trueMicroFamilyId = trueMicroFamilyValue(row);
 const parentTrueMicroFamilyId = parentMicroFamilyValue(row);
 return (
   isScannerFingerprintId(trueMicroFamilyId) ||
   isScannerFingerprintId(parentTrueMicroFamilyId) ||
   isExecutionFingerprintId(trueMicroFamilyId) ||
   isExecutionFingerprintId(parentTrueMicroFamilyId)
 );
}
function isLongLog(row = {}) {
 if (!row || typeof row !== 'object') return false;
 if (logHasInvalidLearningId(row)) return false;
 return inferTradeSide(row) === TARGET_TRADE_SIDE;
}
function isShortLog(row = {}) {
 if (!row || typeof row !== 'object') return false;
 return inferTradeSide(row) === OPPOSITE_TRADE_SIDE;
}
function normalizeType(row = {}) {
 const { payload, result } = payloadResult(row);
 return upper(
   row.type ||
   payload.type ||
   result.type ||
   row.level ||
   payload.level ||
   result.level ||
   'UNKNOWN'
 );
}
function normalizeReason(row = {}) {
 const { payload, result } = payloadResult(row);
 return (
   row.reason ||
   payload.reason ||
   result.reason ||
   row.error ||
   payload.error ||
   result.error ||
   null
 );
}
function normalizeResult(row = {}) {
 const { payload, result } = payloadResult(row);
 if (Object.keys(result).length > 0) {
   return result;
 }
 return null;
}
function normalizeSource(row = {}) {
 const { payload, result } = payloadResult(row);
 const raw = upper(
   row.source ||
   row.positionSource ||
   row.tradeSource ||
   row.outcomeSource ||
   payload.source ||
   payload.positionSource ||
   payload.tradeSource ||
   payload.outcomeSource ||
   result.source ||
   result.positionSource ||
   result.tradeSource ||
   result.outcomeSource ||
   ''
 );
 if (!raw) return null;
 if (raw === 'VIRTUAL' || raw === 'SHADOW') return raw;
 if (raw === 'PAPER') return 'VIRTUAL';
 if (
   raw === 'REAL' ||
   raw === 'LIVE' ||
   raw === 'BITGET' ||
   raw === 'EXCHANGE' ||
   raw.startsWith('REAL_') ||
   raw.startsWith('LIVE_') ||
   raw.startsWith('BITGET_') ||
   raw.startsWith('EXCHANGE_')
 ) {
   return 'REAL';
 }
 return raw;
}
function isRealLog(row = {}) {
 const { payload, result } = payloadResult(row);
 return (
   row.source === 'REAL' ||
   normalizeSource(row) === 'REAL' ||
   row.realOrder === true ||
   payload.realOrder === true ||
   result.realOrder === true ||
   row.realPosition === true ||
   payload.realPosition === true ||
   result.realPosition === true ||
   row.exchangeOrder === true ||
   payload.exchangeOrder === true ||
   result.exchangeOrder === true ||
   row.bitgetOrder === true ||
   payload.bitgetOrder === true ||
   result.bitgetOrder === true
 );
}
function normalizeLog(row = {}) {
 const { payload, result } = payloadResult(row);
 const resultObject = safeObject(normalizeResult(row));
 const rawInferredTradeSide = inferTradeSide(row);
 const type = normalizeType(row);
 const reason = normalizeReason(row);
 const source = normalizeSource(row);
 const symbol =
   row.symbol ||
   row.contractSymbol ||
   payload.symbol ||
   payload.contractSymbol ||
   resultObject.symbol ||
   resultObject.contractSymbol ||
   null;
 const rawTrueMicroFamilyId = trueMicroFamilyValue(row);
 const rawParentTrueMicroFamilyId = parentMicroFamilyValue(row);
 const trueParsed = parseLongTaxonomyMicroId(rawTrueMicroFamilyId);
 const parentParsed = parseLongTaxonomyMicroId(rawParentTrueMicroFamilyId);
 const trueMicroFamilyId =
   trueParsed.trueMicroFamilyId ||
   row.trueMicroFamilyId ||
   payload.trueMicroFamilyId ||
   resultObject.trueMicroFamilyId ||
   row.microFamilyId ||
   payload.microFamilyId ||
   resultObject.microFamilyId ||
   null;
 const parentTrueMicroFamilyId =
   trueParsed.parentTrueMicroFamilyId ||
   parentParsed.parentTrueMicroFamilyId ||
   row.parentTrueMicroFamilyId ||
   payload.parentTrueMicroFamilyId ||
   resultObject.parentTrueMicroFamilyId ||
   row.coarseMicroFamilyId ||
   payload.coarseMicroFamilyId ||
   resultObject.coarseMicroFamilyId ||
   null;
 const selectedTrueMicroFamilyId = selectedIdentityValue(row);
 const microFamilyId = trueMicroFamilyId;
 const familyId =
   row.familyId ||
   payload.familyId ||
   resultObject.familyId ||
   null;
 const macroFamilyId =
   parentTrueMicroFamilyId ||
   row.macroFamilyId ||
   row.parentMacroFamilyId ||
   payload.macroFamilyId ||
   payload.parentMacroFamilyId ||
   resultObject.macroFamilyId ||
   resultObject.parentMacroFamilyId ||
   null;
 const discordAlertEligible = Boolean(firstDefined(
   row.discordAlertEligible,
   payload.discordAlertEligible,
   resultObject.discordAlertEligible,
   false
 ));
 const selectedMicroFamilyAlert = Boolean(firstDefined(
   row.selectedMicroFamilyAlert,
   payload.selectedMicroFamilyAlert,
   resultObject.selectedMicroFamilyAlert,
   false
 ));
 const virtualOnlyFlag = Boolean(firstDefined(
   row.virtualOnly,
   payload.virtualOnly,
   resultObject.virtualOnly,
   row.virtualTracked,
   payload.virtualTracked,
   resultObject.virtualTracked,
   row.shadowOnly,
   payload.shadowOnly,
   resultObject.shadowOnly,
   false
 ));
 const virtualOnly = Boolean(source === 'VIRTUAL' || source === 'SHADOW' || 
virtualOnlyFlag);
 const skipped = Boolean(firstDefined(
   row.skipped,
   payload.skipped,
   resultObject.skipped,
   false
 ));
 const failed = Boolean(firstDefined(
   row.failed,
   payload.failed,
   resultObject.failed,
   resultObject.ok === false ? true : undefined,
   false
 ));
 const explicitSent = firstDefined(
   row.sent,
   payload.sent,
   resultObject.sent
 );
 const sent = explicitSent !== undefined
   ? Boolean(explicitSent)
   : Boolean(
     !skipped &&
     !failed &&
     (
       type.includes('SENT') ||
       resultObject.ok === true
     )
   );
 const entryAlert = (
   type.includes('ENTRY') ||
   String(reason || '').toUpperCase().includes('ENTRY')
 );
 const exitAlert = (
   type.includes('EXIT') ||
   String(reason || '').toUpperCase().includes('EXIT')
 );
 const riskGeometry = getLongRiskGeometry(row);
 const longCurrentFit = getLongCurrentFit(row);
 const explicitLongGrossR = firstFiniteMetric(row, [
   'longGrossR',
   'grossLongR'
 ]);
 const explicitLongCurrentR = firstFiniteMetric(row, [
   'longCurrentR',
   'currentLongR'
 ]);
 const selectableTrueMicroFamily = isSelectableTrueMicroId(trueMicroFamilyId);
 const parentTrueMicroFamily = Boolean(parentTrueMicroFamilyId && 
isFixedLongParentMicroId(parentTrueMicroFamilyId));
 const selectedTrueMicroIsChild = 
isSelectableTrueMicroId(selectedTrueMicroFamilyId);
 const exactSelectedTrueMicroMatch = Boolean(
   selectableTrueMicroFamily &&
   selectedMicroFamilyAlert === true &&
   (
     !selectedTrueMicroFamilyId ||
     String(selectedTrueMicroFamilyId).trim() === 
String(trueMicroFamilyId).trim()
   )
 );
 const explicitSelectedIdMismatch = Boolean(
   selectedTrueMicroFamilyId &&
   selectedTrueMicroIsChild &&
   trueMicroFamilyId &&
   String(selectedTrueMicroFamilyId).trim() !== String(trueMicroFamilyId).trim()
 );
 const parentOnlyMatch = Boolean(
   parentTrueMicroFamilyId &&
   selectedTrueMicroFamilyId &&
   isFixedLongParentMicroId(selectedTrueMicroFamilyId) &&
   String(selectedTrueMicroFamilyId).trim() === 
String(parentTrueMicroFamilyId).trim()
 );
 const alertAllowed = exactSelectedTrueMicroMatch;
 const blockedByManualSelection = discordAlertEligible === true && !alertAllowed;
 const blockedByParentOnlyMatch = discordAlertEligible === true && 
parentOnlyMatch;
 const policyViolation = sent === true && !alertAllowed;
 const realBlocked = isRealLog(row);
 const temporalAudit = temporalRowPayload(row);
 const weekendEntryBlocked = Boolean(entryAlert && temporalAudit.entryIsWeekend);
 const weekendDiscordEntryAllowed = !weekendEntryBlocked;
 const sessionDiscordEntryAllowed = true;
 const temporalPolicyViolation = Boolean(sent && weekendEntryBlocked);
 return {
   ...row,
   ...temporalRowPayload(row),
   type,
   payload,
   result,
   reason,
   source,
   symbol,
   side: TARGET_DASHBOARD_SIDE,
   tradeSide: TARGET_TRADE_SIDE,
   positionSide: TARGET_TRADE_SIDE,
   direction: TARGET_TRADE_SIDE,
   targetTradeSide: TARGET_TRADE_SIDE,
   dashboardSide: TARGET_DASHBOARD_SIDE,
   scannerSide: TARGET_SCANNER_SIDE,
   oppositeTradeSide: OPPOSITE_TRADE_SIDE,
   longOnly: true,
   shortDisabled: true,
   shortOnly: false,
   longDisabled: false,
   realOrdersDisabled: true,
   bitgetOrdersDisabled: true,
   exchangeCallsDisabled: true,
   realOutcomesExcluded: true,
   virtualLearning: true,
   virtualLearningForced: true,
   virtualOutcomesIncluded: true,
   shadowOutcomesIncluded: true,
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
   riskTradeSide: TARGET_TRADE_SIDE,
   riskGeometryRule: riskGeometry.riskGeometryRule,
   tpHitRule: riskGeometry.tpHitRule,
   slHitRule: riskGeometry.slHitRule,
   grossRFormula: riskGeometry.grossRFormula,
   currentRFormula: riskGeometry.currentRFormula,
   validLongGeometry: Boolean(riskGeometry.validGeometry),
   longValidGeometry: Boolean(riskGeometry.validGeometry),
   longTpHit: riskGeometry.longTpHit,
   longSlHit: riskGeometry.longSlHit,
   tpHit: riskGeometry.longTpHit,
   slHit: riskGeometry.longSlHit,
   longGrossR: riskGeometry.longGrossR ?? explicitLongGrossR,
   longCurrentR: riskGeometry.longCurrentR ?? explicitLongCurrentR,
   currentR: riskGeometry.longCurrentR ?? explicitLongCurrentR,
   entryPrice: riskGeometry.entry ?? firstMetricValue(row, ['entryPrice', 
'entry']),
   initialSl: riskGeometry.initialSl ?? firstMetricValue(row, ['initialSl', 
'initialSL', 'stopLoss', 'sl']),
   tp: riskGeometry.tp ?? firstMetricValue(row, ['tp', 'takeProfit', 
'takeProfitPrice']),
   currentFit: longCurrentFit,
   longCurrentFit,
   bullCurrentFit: longCurrentFit,
   bearishCurrentFit: -longCurrentFit,
   currentFitPolarity: 'BULLISH_POSITIVE_BEARISH_NEGATIVE',
   currentFitDefinition: 'LONG_MIRRORED_CURRENT_FIT',
   rawInferredTradeSide,
   inferredTradeSide: rawInferredTradeSide,
   microFamilyId,
   trueMicroFamilyId,
   parentTrueMicroFamilyId,
   coarseMicroFamilyId: parentTrueMicroFamilyId || trueMicroFamilyId || null,
   familyId,
   macroFamilyId,
   taxonomySetup: trueParsed.setup || parentParsed.setup || null,
   taxonomyRegime: trueParsed.regime || parentParsed.regime || null,
   confirmationProfile: trueParsed.confirmationProfile || null,
   selectableTrueMicroFamily,
   parentTrueMicroFamily,
   discordSelectable: selectableTrueMicroFamily,
   selectedTrueMicroFamilyId: selectedTrueMicroFamilyId || null,
   selectedTrueMicroIsChild,
   selectedMicroFamilyAlert,
   exactSelectedTrueMicroMatch,
   explicitSelectedIdMismatch,
   parentOnlyMatch,
   virtualOnly,
   virtualTracked: virtualOnly,
   shadowOnly: source === 'SHADOW' || virtualOnly,
   realBlocked,
   discordAlertEligible,
   manualSelectionRequired: true,
   manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
   discordOnlyForSelectedMicroFamilies: true,
   discordOnlyForExactTrueMicroMatch: true,
   parentMatchDoesNotTriggerDiscord: true,
   macroMatchDoesNotTriggerDiscord: true,
   alertAllowed,
   blockedByManualSelection,
   blockedByParentOnlyMatch,
   policyViolation,
   weekendEntryBlocked,
   weekendDiscordEntryAllowed,
   sessionDiscordEntryAllowed,
   temporalPolicyViolation,
   entryAlert,
   exitAlert,
   sent,
   skipped,
   failed,
   ts:
     row.ts ||
     row.createdAt ||
     payload.ts ||
     payload.createdAt ||
     resultObject.ts ||
     resultObject.createdAt ||
     null
 };
}
function filterByType(logs = [], type = null) {
 if (!type) return logs;
 const wanted = String(type).toUpperCase();
 return logs.filter((log) => String(log.type || '').toUpperCase() === wanted);
}
function filterBySymbol(logs = [], symbol = null) {
 if (!symbol) return logs;
 const wanted = String(symbol).trim().toUpperCase();
 return logs.filter((log) => (
   String(log.symbol || '').trim().toUpperCase() === wanted ||
   String(log.contractSymbol || '').trim().toUpperCase() === wanted ||
   String(log.payload?.symbol || '').trim().toUpperCase() === wanted ||
   String(log.payload?.contractSymbol || '').trim().toUpperCase() === wanted ||
   String(log.result?.symbol || '').trim().toUpperCase() === wanted ||
   String(log.result?.contractSymbol || '').trim().toUpperCase() === wanted
 ));
}
function filterByMicroFamilyId(logs = [], microFamilyId = null) {
 if (!microFamilyId) return logs;
 const wanted = String(microFamilyId).trim();
 return logs.filter((log) => (
   String(log.trueMicroFamilyId || '').trim() === wanted ||
   String(log.microFamilyId || '').trim() === wanted ||
   String(log.parentTrueMicroFamilyId || '').trim() === wanted ||
   String(log.payload?.trueMicroFamilyId || '').trim() === wanted ||
   String(log.payload?.microFamilyId || '').trim() === wanted ||
   String(log.payload?.parentTrueMicroFamilyId || '').trim() === wanted ||
   String(log.result?.trueMicroFamilyId || '').trim() === wanted ||
   String(log.result?.microFamilyId || '').trim() === wanted ||
   String(log.result?.parentTrueMicroFamilyId || '').trim() === wanted
 ));
}
function filterSelectedOnly(logs = [], selectedOnly = false) {
 if (!selectedOnly) return logs;
 return logs.filter((log) => log.alertAllowed === true);
}
function buildSummary(logs = []) {
 return logs.reduce((acc, log) => {
   const type = String(log.type || 'UNKNOWN').toUpperCase();
   const reason = String(log.reason || 'NO_REASON').toUpperCase();
   acc.total += 1;
   acc.byType[type] = (acc.byType[type] || 0) + 1;
   acc.byReason[reason] = (acc.byReason[reason] || 0) + 1;
   if (log.sent) acc.sent += 1;
   if (log.failed) acc.failed += 1;
   if (log.skipped) acc.skipped += 1;
   if (log.entryAlert) acc.entryAlerts += 1;
   if (log.exitAlert) acc.exitAlerts += 1;
   if (log.virtualOnly || log.virtualTracked || log.source === 'VIRTUAL') {
     acc.virtual += 1;
   }
   if (log.shadowOnly || log.source === 'SHADOW') {
     acc.shadow += 1;
   }
   if (log.realBlocked || log.source === 'REAL') {
     acc.realBlocked += 1;
   }
   if (log.discordAlertEligible) acc.eligible += 1;
   if (log.selectedMicroFamilyAlert) acc.selected += 1;
   if (log.selectableTrueMicroFamily) acc.selectableChildFamilyLogs += 1;
   if (log.parentTrueMicroFamily && !log.selectableTrueMicroFamily) 
acc.parentOnlyLogs += 1;
   if (log.alertAllowed) acc.alertAllowed += 1;
   if (log.blockedByManualSelection) acc.blockedByManualSelection += 1;
   if (log.blockedByParentOnlyMatch) acc.blockedByParentOnlyMatch += 1;
   if (log.explicitSelectedIdMismatch) acc.explicitSelectedIdMismatches += 1;
   if (log.policyViolation) acc.policyViolations += 1;
   if (log.rawInferredTradeSide === OPPOSITE_TRADE_SIDE || log.inferredTradeSide 
=== OPPOSITE_TRADE_SIDE) {
     acc.shortFilteredLeaks += 1;
   }
   if (log.validLongGeometry) acc.validLongGeometry += 1;
   if (log.longTpHit) acc.longTpHits += 1;
   if (log.longSlHit) acc.longSlHits += 1;
   return acc;
 }, {
   total: 0,
   sent: 0,
   failed: 0,
   skipped: 0,
   entryAlerts: 0,
   exitAlerts: 0,
   virtual: 0,
   shadow: 0,
   realBlocked: 0,
   eligible: 0,
   selected: 0,
   selectableChildFamilyLogs: 0,
   parentOnlyLogs: 0,
   alertAllowed: 0,
   blockedByManualSelection: 0,
   blockedByParentOnlyMatch: 0,
   explicitSelectedIdMismatches: 0,
   policyViolations: 0,
   shortFilteredLeaks: 0,
   validLongGeometry: 0,
   longTpHits: 0,
   longSlHits: 0,
   byType: {},
   byReason: {}
 });
}
function getLongDiscordLogKey() {
 return namespacedLongKey(
   KEYS.discord?.longLogList ||
     KEYS.discordLong?.logList ||
     KEYS.long?.discord?.logList ||
     KEYS.discord?.logList,
   'DISCORD:LOGS'
 );
}
function baseModePayload() {
 return {
   ...temporalPolicyPayload(Date.now()),
   targetTradeSide: TARGET_TRADE_SIDE,
   dashboardSide: TARGET_DASHBOARD_SIDE,
   scannerSide: TARGET_SCANNER_SIDE,
   oppositeTradeSide: OPPOSITE_TRADE_SIDE,
   longOnly: true,
   shortDisabled: true,
   shortOnly: false,
   longDisabled: false,
   realOrdersDisabled: true,
   bitgetOrdersDisabled: true,
   exchangeCallsDisabled: true,
   realOutcomesExcluded: true,
   virtualLearning: true,
   virtualLearningForced: true,
   virtualPositionsOnly: true,
   virtualOutcomesIncluded: true,
   shadowPositionsVisible: true,
   shadowOutcomesIncluded: true,
   maxOneOpenPositionPerSymbol: true,
   globalMaxOpenPositionsBlockDisabled: true,
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
   persistentLearningKey: PERSISTENT_LEARNING_KEY,
   weekResetDisabled: true,
   isoWeekLearningDisabled: true,
   redisNamespace: LONG_NAMESPACE,
   redisKeyPrefix: LONG_KEY_PREFIX,
   discordLogKeyNamespace: LONG_NAMESPACE,
   redisKeysSeparatedFromShortRoot: true,
   shortRootTouched: false
 };
}
function classifyLogs(logs = []) {
 return logs.reduce((acc, log) => {
   if (logHasInvalidLearningId(log)) {
     acc.metadataBlockedCount += 1;
     return acc;
   }
   if (isRealLog(log)) {
     acc.realBlockedCount += 1;
     return acc;
   }
   if (isLongLog(log)) {
     acc.longOnlyLogs.push(log);
     return acc;
   }
   if (isShortLog(log)) {
     acc.shortBlockedCount += 1;
     return acc;
   }
   acc.unknownBlockedCount += 1;
   return acc;
 }, {
   longOnlyLogs: [],
   shortBlockedCount: 0,
   metadataBlockedCount: 0,
   realBlockedCount: 0,
   unknownBlockedCount: 0
 });
}
export default async function handler(req, res) {
 res.setHeader('Cache-Control', 'no-store, max-age=0');
 res.setHeader('X-Temporal-Context-Version', TEMPORAL_CONTEXT_VERSION);
 res.setHeader('X-Weekend-Policy-Version', WEEKEND_POLICY_VERSION);
 res.setHeader('X-Session-Policy-Version', SESSION_POLICY_VERSION);
 res.setHeader('X-Weekend-Mode', WEEKEND_MODE);
 res.setHeader('X-Session-Mode', SESSION_MODE);
 res.setHeader('X-Admin-Discord-Logs-Mode', 'long-only-75-child-exact-discord-logs-v1');
 res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
 res.setHeader('X-Long-Only', 'true');
 res.setHeader('X-Short-Disabled', 'true');
 res.setHeader('X-Manual-Selection-Required', 'true');
 res.setHeader('X-Manual-Selection-Match-Mode', 'EXACT_TRUE_MICRO_FAMILY_ID');
 res.setHeader('X-Discord-Selection-Rule', 
'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY');
 res.setHeader('X-True-Micro-Family-Schema', TRUE_MICRO_SCHEMA);
 res.setHeader('X-Learning-Granularity', LEARNING_GRANULARITY);
 res.setHeader('X-Real-Orders-Disabled', 'true');
 res.setHeader('X-Bitget-Orders-Disabled', 'true');
 res.setHeader('X-Virtual-Learning-Forced', 'true');
 res.setHeader('X-Redis-Namespace', LONG_NAMESPACE);
 res.setHeader('X-Short-Root-Touched', 'false');
 try {
   if (req.method !== 'GET') {
     return methodNotAllowed(res);
   }
   const limit = clampLimit(firstQueryValue(req.query?.limit, 100), 100);
   const type = firstQueryValue(req.query?.type, null);
   const symbol = firstQueryValue(req.query?.symbol, null);
   const microFamilyId = firstQueryValue(req.query?.microFamilyId, null);
   const selectedOnly = bool(firstQueryValue(req.query?.selectedOnly, false), 
false);
   const includeShortRequested = bool(firstQueryValue(req.query?.includeShort, 
false), false);
   const hasPostFilters = Boolean(type || symbol || microFamilyId || 
selectedOnly);
   const fetchLimit = hasPostFilters
     ? Math.min(500, Math.max(limit, limit * 5))
     : limit;
   const redis = getDurableRedis();
   const discordLogKey = getLongDiscordLogKey();
   const rawLogs = await readJsonLogs(
     redis,
     discordLogKey,
     fetchLimit
   );
   const normalized = (Array.isArray(rawLogs) ? rawLogs : [])
     .map(normalizeLog);
   const {
     longOnlyLogs,
     shortBlockedCount,
     metadataBlockedCount,
     realBlockedCount,
     unknownBlockedCount
   } = classifyLogs(normalized);
   const filteredLogs = filterSelectedOnly(
     filterByMicroFamilyId(
       filterBySymbol(
         filterByType(longOnlyLogs, type),
         symbol
       ),
       microFamilyId
     ),
     selectedOnly
   );
   const logs = filteredLogs.slice(0, limit);
   return res.status(200).json({
     ok: true,
     ...baseModePayload(),
     limit,
     fetchLimit,
     type,
     symbol,
     microFamilyId,
     selectedOnly,
     includeShortRequested,
     includeShortIgnored: includeShortRequested,
     shortHardBlocked: true,
     discordLogKey,
     count: logs.length,
     totalMatched: filteredLogs.length,
     totalFetched: Array.isArray(rawLogs) ? rawLogs.length : 0,
     totalAfterLongFilter: longOnlyLogs.length,
     shortBlockedCount,
     metadataBlockedCount,
     realBlockedCount,
     unknownBlockedCount,
     summary: buildSummary(logs),
     logs,
     serverTs: Date.now()
   });
 } catch (error) {
   return res.status(500).json({
     ok: false,
     ...baseModePayload(),
     error: error?.message || String(error),
     stack: process.env.NODE_ENV === 'production'
       ? undefined
       : error?.stack
   });
 }
}
