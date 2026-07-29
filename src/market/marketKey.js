// ================= FILE: src/market/marketKey.js =================
// LONG-root market key management
//
// Verantwoordelijkheid van dit bestand:
// - alle market-gerelateerde Redis-keys onder de afzonderlijke LONG-root houden;
// - voorkomen dat een bestaande SHORT:- of LONG:-prefix dubbel wordt toegevoegd;
// - compatibele key-hooks aanbieden voor UTC temporal context, dagtype- en sessiestatistieken;
// - geen scanner-, Analyze-, position-, outcome- of Discordbeleid uitvoeren.

export const TARGET_TRADE_SIDE = 'LONG';
export const TARGET_DASHBOARD_SIDE = 'bull';
export const TARGET_SCANNER_SIDE = 'bull';
export const OPPOSITE_TRADE_SIDE = 'SHORT';

export const LONG_NAMESPACE = 'LONG';
export const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;
export const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';

export const TEMPORAL_CONTEXT_VERSION =
  'LONG_TEMPORAL_CONTEXT_UTC_V1';

export const WEEKEND_POLICY_VERSION =
  'LONG_WEEKEND_OBSERVE_DISCORD_BLOCK_V1';

export const SESSION_POLICY_VERSION =
  'LONG_SESSION_OBSERVE_V1';

export const WEEKEND_MODE = 'OBSERVE';
export const SESSION_MODE = 'OBSERVE';

function cleanKeyPart(value = '', fallback = '') {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;

  return raw
    .replace(/^LONG:/i, '')
    .replace(/^SHORT:/i, '')
    .replace(/^:+|:+$/g, '')
    .trim() || fallback;
}

function withLongNamespace(key = '') {
  const raw = cleanKeyPart(key);
  if (!raw) return LONG_NAMESPACE;
  return `${LONG_KEY_PREFIX}${raw}`;
}

export function getMarketSnapshotKey(symbol = '') {
  const normalizedSymbol = cleanKeyPart(symbol, 'UNKNOWN');
  return withLongNamespace(`MARKET:SNAPSHOT:${normalizedSymbol}`);
}

export function getMarketHistoryKey(symbol = '', timeframe = '1H') {
  const normalizedSymbol = cleanKeyPart(symbol, 'UNKNOWN');
  const normalizedTimeframe = cleanKeyPart(timeframe, '1H').toUpperCase();
  return withLongNamespace(
    `MARKET:HISTORY:${normalizedSymbol}:${normalizedTimeframe}`
  );
}

export function getMarketCandlesKey(symbol = '') {
  const normalizedSymbol = cleanKeyPart(symbol, 'UNKNOWN');
  return withLongNamespace(`MARKET:CANDLES:${normalizedSymbol}`);
}

export function getMarketIndicesKey(symbol = '') {
  const normalizedSymbol = cleanKeyPart(symbol, 'UNKNOWN');
  return withLongNamespace(`MARKET:INDICES:${normalizedSymbol}`);
}

export function getAllMarketsKey() {
  return withLongNamespace('MARKET:ALL:SYMBOLS');
}

export function getMarketAlertKey(symbol = '') {
  const normalizedSymbol = cleanKeyPart(symbol, 'UNKNOWN');
  return withLongNamespace(`MARKET:ALERT:${normalizedSymbol}`);
}

// Storage hook voor de UTC-context die bij een market snapshot hoort.
// De daadwerkelijke tijdsberekening wordt uitgevoerd door scanner/Analyze/runtime.
export function getMarketTemporalContextKey(symbol = '') {
  const normalizedSymbol = cleanKeyPart(symbol, 'UNKNOWN');
  return withLongNamespace(`MARKET:TEMPORAL_CONTEXT:${normalizedSymbol}`);
}

// Eén algemene dagtype-aggregatie per opgegeven scope, zonder family-ID's op te splitsen.
export function getMarketContextStatsKey(scope = 'GLOBAL') {
  const normalizedScope = cleanKeyPart(scope, 'GLOBAL').toUpperCase();
  return withLongNamespace(`MARKET:CONTEXT_STATS:${normalizedScope}`);
}

// Eén algemene primaire-sessiebucketaggregatie per opgegeven scope.
export function getMarketSessionStatsKey(scope = 'GLOBAL') {
  const normalizedScope = cleanKeyPart(scope, 'GLOBAL').toUpperCase();
  return withLongNamespace(`MARKET:SESSION_STATS:${normalizedScope}`);
}

// Optionele policy-key voor admin/runtime-inspectie.
// Deze key voert zelf geen blokkade uit.
export function getMarketTemporalPolicyKey() {
  return withLongNamespace('MARKET:TEMPORAL_POLICY');
}

export function getMarketKeyModeFlags() {
  return {
    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisKeysSeparatedFromShortRoot: true,
    shortRootTouched: false,
    preventsLongShortDoublePrefix: true,

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

    temporalContextCalculatedHere: false,
    temporalContextStoredByRuntime: true,
    familyIdsRemainUnchanged: true,
    temporalContextExcludedFromFamilyId: true
  };
}

export default {
  getMarketSnapshotKey,
  getMarketHistoryKey,
  getMarketCandlesKey,
  getMarketIndicesKey,
  getAllMarketsKey,
  getMarketAlertKey,
  getMarketTemporalContextKey,
  getMarketContextStatsKey,
  getMarketSessionStatsKey,
  getMarketTemporalPolicyKey,
  getMarketKeyModeFlags
};
