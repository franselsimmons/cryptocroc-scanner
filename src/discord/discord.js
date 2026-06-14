// ================= FILE: src/discord/discord.js =================

import { CONFIG } from '../config.js';
import { KEYS } from '../keys.js';
import { getDurableRedis, pushJsonLog } from '../redis.js';
import {
  normalizeBaseSymbol,
  safeNumber,
  sideToTradeSide
} from '../utils.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const TARGET_SCANNER_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = TRUE_MICRO_SCHEMA;
const LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'LONG_FIXED_TAXONOMY_SETUP_X_REGIME_V1';

const SOURCE_VIRTUAL = 'VIRTUAL';
const SOURCE_REAL = 'REAL';
const SOURCE_LIVE = 'LIVE';
const SOURCE_TRADE = 'TRADE';
const SOURCE_SHADOW = 'SHADOW';

const DISCORD_LIMITS = {
  fieldName: 256,
  fieldValue: 1024
};

const LONG_TOKENS = new Set([
  'LONG',
  'BULL',
  'BULLISH',
  'BUY',
  'UP',
  'UPSIDE'
]);

const SHORT_TOKENS = new Set([
  'SHORT',
  'BEAR',
  'BEARISH',
  'SELL',
  'DOWN',
  'DOWNSIDE'
]);

const REAL_ORDER_SOURCES = new Set([
  SOURCE_REAL,
  SOURCE_LIVE,
  SOURCE_TRADE,
  'ENTRY',
  'ORDER',
  'BITGET'
]);

const SETUP_ORDER = Object.freeze([
  'BREAKOUT',
  'RETEST',
  'SWEEP_REVERSAL',
  'CONTINUATION',
  'COMPRESSION'
]);

const REGIME_ORDER = Object.freeze([
  'TREND',
  'CHOP',
  'SQUEEZE'
]);

const CONFIRMATION_PROFILE_ORDER = Object.freeze([
  'A_STRONG_ALIGN',
  'B_FLOW_ALIGN',
  'C_VOLUME_ALIGN',
  'D_MIXED_OK',
  'E_WEAK_CONTRA'
]);

const LONG_FIXED_SETUP_TYPES = new Set(SETUP_ORDER);
const LONG_FIXED_REGIME_BUCKETS = new Set(REGIME_ORDER);
const LONG_CONFIRMATION_PROFILES = new Set(CONFIRMATION_PROFILE_ORDER);

function namespacedLongKey(key, fallback) {
  const raw = String(key || fallback || '').trim();
  const safe = raw || String(fallback || '').trim();

  if (!safe) return `${LONG_KEY_PREFIX}DISCORD:LOGS`;
  if (safe.startsWith(LONG_KEY_PREFIX)) return safe;

  return `${LONG_KEY_PREFIX}${safe}`;
}

const LONG_KEYS = {
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

function nowIso() {
  return new Date().toISOString();
}

function discordConfig() {
  const cfg = CONFIG.long?.discord || CONFIG.discord || {};

  return {
    enabled: cfg.enabled !== false,
    webhookUrl: cfg.webhookUrl || '',
    timeoutMs: Math.max(500, safeNumber(cfg.timeoutMs, 2500)),
    logLimit: Math.max(1, Math.floor(safeNumber(cfg.logLimit, 250))),

    sendRotationReports: cfg.sendRotationReports === true,
    sendResetReports: cfg.sendResetReports !== false
  };
}

function truncate(value, max = 1024) {
  const text = String(value ?? '');

  if (text.length <= max) return text;

  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function field(name, value, inline = true) {
  return {
    name: truncate(name || 'Field', DISCORD_LIMITS.fieldName),
    value: truncate(value ?? 'NA', DISCORD_LIMITS.fieldValue) || 'NA',
    inline
  };
}

function fmtPrice(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 'NA';

  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(6);

  return n.toFixed(10);
}

function fmtPct(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 'NA';

  return `${(n * 100).toFixed(2)}%`;
}

function fmtPctSmart(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 'NA';

  const ratio = Math.abs(n) > 1 ? n / 100 : n;

  return `${(ratio * 100).toFixed(1)}%`;
}

function fmtR(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 'NA';

  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}R`;
}

function fmtNumber(value, decimals = 2) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 'NA';

  return n.toFixed(decimals);
}

function upper(value, fallback = '') {
  const text = String(value ?? '').trim();

  return text ? text.toUpperCase() : fallback;
}

function cleanSideText(value = '') {
  return upper(value)
    .replaceAll('SHORT_DISABLED_FALSE', '')
    .replaceAll('SHORTDISABLED_FALSE', '')
    .replaceAll('BLOCK_SHORT_FALSE', '')
    .replaceAll('SHORT_ENABLED_FALSE', '')
    .replaceAll('SHORT_ONLY_FALSE', '')
    .replaceAll('LONG_DISABLED_FALSE', '')
    .replaceAll('SHORT_DISABLED_LONG_ONLY', '')
    .replaceAll('SHORTDISABLED_LONG_ONLY', '')
    .replaceAll('BLOCK_SHORT', '')
    .replaceAll('SHORT_DISABLED', '')
    .replaceAll('SHORTDISABLED', '')
    .replaceAll('LONG_ONLY_MODE', 'LONG')
    .replaceAll('LONG_ONLY', 'LONG')
    .replaceAll('LONG-ONLY', 'LONG')
    .replaceAll('SHORT_ONLY_MODE', 'SHORT')
    .replaceAll('SHORT_ONLY', 'SHORT')
    .replaceAll('SHORT-ONLY', 'SHORT');
}

function normalizeSource(value) {
  const raw = upper(value || SOURCE_VIRTUAL, SOURCE_VIRTUAL);

  if (raw === SOURCE_VIRTUAL) return SOURCE_VIRTUAL;
  if (raw === SOURCE_SHADOW) return SOURCE_SHADOW;
  if (raw === SOURCE_REAL) return SOURCE_REAL;
  if (raw === SOURCE_LIVE) return SOURCE_LIVE;
  if (raw === SOURCE_TRADE) return SOURCE_TRADE;

  return raw;
}

function normalizeSideToken(value) {
  const direct = sideToTradeSide(value);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  const raw = cleanSideText(value);

  if (!raw) return 'UNKNOWN';
  if (LONG_TOKENS.has(raw)) return TARGET_TRADE_SIDE;
  if (SHORT_TOKENS.has(raw)) return OPPOSITE_TRADE_SIDE;

  const normalized = raw
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  const longPatterns = [
    'LONG',
    'BULL',
    'BULLISH',
    'BUY',
    'SIDE_LONG',
    'TRADE_SIDE_LONG',
    'TRADESIDE_LONG',
    'POSITION_SIDE_LONG',
    'POSITIONSIDE_LONG',
    'DIRECTION_LONG',
    'SIDE_BULL',
    'TRADE_SIDE_BULL',
    'DIRECTION_BULL',
    'SIDE_BUY',
    'DIRECTION_BUY',
    'MICRO_LONG',
    'FAMILY_LONG'
  ];

  const shortPatterns = [
    'SHORT',
    'BEAR',
    'BEARISH',
    'SELL',
    'SIDE_SHORT',
    'TRADE_SIDE_SHORT',
    'TRADESIDE_SHORT',
    'POSITION_SIDE_SHORT',
    'POSITIONSIDE_SHORT',
    'DIRECTION_SHORT',
    'SIDE_BEAR',
    'TRADE_SIDE_BEAR',
    'DIRECTION_BEAR',
    'SIDE_SELL',
    'DIRECTION_SELL',
    'MICRO_SHORT',
    'FAMILY_SHORT'
  ];

  const hit = (patterns) => patterns.some((pattern) => (
    normalized === pattern ||
    normalized.startsWith(`${pattern}_`) ||
    normalized.endsWith(`_${pattern}`) ||
    normalized.includes(`_${pattern}_`)
  ));

  const longHit = hit(longPatterns);
  const shortHit = hit(shortPatterns);

  if (longHit && !shortHit) return TARGET_TRADE_SIDE;
  if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;

  if (shortHit && longHit) {
    if (raw.includes('TRADE_SIDE=LONG') || raw.includes('TRADESIDE=LONG')) return TARGET_TRADE_SIDE;
    if (raw.includes('TRADE_SIDE=SHORT') || raw.includes('TRADESIDE=SHORT')) return OPPOSITE_TRADE_SIDE;
    if (raw.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
    if (raw.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function flattenValues(values = []) {
  const stack = Array.isArray(values) ? [...values] : [values];
  const out = [];

  while (stack.length > 0) {
    const value = stack.shift();

    if (Array.isArray(value)) {
      stack.unshift(...value);
      continue;
    }

    out.push(value);
  }

  return out;
}

function uniqueStrings(values = []) {
  return [...new Set(
    flattenValues(values)
      .flatMap((value) => {
        if (typeof value === 'string') {
          return value
            .split(/[\s,;\n\r]+/g)
            .map((part) => part.trim());
        }

        return [value];
      })
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function isScannerFamilyId(id = '') {
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
    value.includes('|XR|') ||
    value.includes('EXECUTION_FINGERPRINT') ||
    value.includes('EXECUTION_MICRO') ||
    value.includes('EXECUTIONMICRO') ||
    value.includes('REFINED_EXECUTION')
  );
}

function parseLongTaxonomyMicroId(id = '') {
  const rawId = String(id || '').trim();
  const value = upper(rawId);

  if (!value.startsWith('MICRO_LONG_')) {
    return {
      valid: false,
      selectable: false,
      isParent: false,
      isChild: false,
      rawId
    };
  }

  if (isScannerFamilyId(value) || isExecutionFingerprintId(value)) {
    return {
      valid: false,
      selectable: false,
      isParent: false,
      isChild: false,
      rawId
    };
  }

  if (
    value.includes('_MF_V1_') ||
    value.includes('_MF_V2_') ||
    value.includes('_MF_V3_')
  ) {
    return {
      valid: false,
      selectable: false,
      isParent: false,
      isChild: false,
      rawId
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

  for (const candidateRegime of REGIME_ORDER) {
    const suffix = `_${candidateRegime}`;

    if (body.endsWith(suffix)) {
      regime = candidateRegime;
      setup = body.slice(0, -suffix.length);
      break;
    }
  }

  const parentId = setup && regime ? `MICRO_LONG_${setup}_${regime}` : null;
  const childId = parentId && confirmationProfile ? `${parentId}_${confirmationProfile}` : null;

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
    rawId,
    setup,
    regime,
    setupType: setup,
    regimeBucket: regime,
    confirmationProfile,
    parentTrueMicroFamilyId: validParent ? parentId : null,
    trueMicroFamilyId: validChild ? childId : validParent ? parentId : null,
    childTrueMicroFamilyId: validChild ? childId : null,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY
  };
}

function isSelectableTrueMicroFamilyId(id = '') {
  return parseLongTaxonomyMicroId(id).isChild === true;
}

function isParentTrueMicroFamilyId(id = '') {
  return parseLongTaxonomyMicroId(id).isParent === true;
}

function validLearningChildId(id = '') {
  const value = String(id || '').trim();

  if (!value) return false;
  if (isScannerFamilyId(value)) return false;
  if (isExecutionFingerprintId(value)) return false;

  return isSelectableTrueMicroFamilyId(value);
}

function definitionParts(payload = {}) {
  return [
    payload.definition,
    payload.microDefinition,
    payload.macroDefinition,
    payload.parentDefinition,

    ...(Array.isArray(payload.definitionParts) ? payload.definitionParts : []),
    ...(Array.isArray(payload.microDefinitionParts) ? payload.microDefinitionParts : []),
    ...(Array.isArray(payload.macroDefinitionParts) ? payload.macroDefinitionParts : []),
    ...(Array.isArray(payload.parentDefinitionParts) ? payload.parentDefinitionParts : []),
    ...(Array.isArray(payload.executionFingerprintParts) ? payload.executionFingerprintParts : [])
  ]
    .map((value) => upper(value))
    .filter(Boolean);
}

function idHaystack(payload = {}) {
  return [
    payload.familyId,
    payload.family,
    payload.baseFamilyId,

    payload.microFamilyId,
    payload.trueMicroFamilyId,
    payload.childTrueMicroFamilyId,
    payload.id,
    payload.key,

    payload.coarseMicroFamilyId,
    payload.parentTrueMicroFamilyId,
    payload.baseMicroFamilyId,
    payload.legacyMicroFamilyId,

    payload.macroFamilyId,
    payload.parentMacroFamilyId,
    payload.parentMicroFamilyId,
    payload.parentFamilyId,
    payload.macroId,
    payload.activeMacroFamilyId
  ]
    .map((value) => upper(value))
    .filter(Boolean)
    .join('|');
}

function hasLongIdSignal(value = '') {
  const raw = upper(value);

  return (
    raw.includes('MICRO_LONG_') ||
    raw.startsWith('LONG_') ||
    raw.includes('_LONG_') ||
    raw.endsWith('_LONG') ||
    raw.includes('|LONG_') ||
    raw.includes('TRADESIDE=LONG') ||
    raw.includes('TRADE_SIDE=LONG') ||
    raw.includes('SIDE=LONG') ||
    raw.includes('SIDE=BULL') ||
    raw.includes('DIRECTION=LONG') ||
    raw.includes('DIRECTION=BULL') ||
    raw.includes('POSITION_SIDE=LONG') ||
    raw.includes('POSITIONSIDE=LONG') ||
    raw.includes('SIDE=BUY') ||
    raw.includes('DIRECTION=BUY')
  );
}

function hasShortIdSignal(value = '') {
  const raw = upper(value);

  return (
    raw.includes('MICRO_SHORT_') ||
    raw.startsWith('SHORT_') ||
    raw.includes('_SHORT_') ||
    raw.endsWith('_SHORT') ||
    raw.includes('|SHORT_') ||
    raw.includes('TRADESIDE=SHORT') ||
    raw.includes('TRADE_SIDE=SHORT') ||
    raw.includes('SIDE=SHORT') ||
    raw.includes('SIDE=BEAR') ||
    raw.includes('DIRECTION=SHORT') ||
    raw.includes('DIRECTION=BEAR') ||
    raw.includes('POSITION_SIDE=SHORT') ||
    raw.includes('POSITIONSIDE=SHORT') ||
    raw.includes('SIDE=SELL') ||
    raw.includes('DIRECTION=SELL')
  );
}

function hasLongDefinitionSignal(parts = []) {
  const haystack = parts.join('|');

  return (
    haystack.includes('TRADESIDE=LONG') ||
    haystack.includes('TRADE_SIDE=LONG') ||
    haystack.includes('SIDE=LONG') ||
    haystack.includes('SIDE=BULL') ||
    haystack.includes('DIRECTION=LONG') ||
    haystack.includes('DIRECTION=BULL') ||
    haystack.includes('POSITION_SIDE=LONG') ||
    haystack.includes('POSITIONSIDE=LONG') ||
    haystack.includes('SIDE=BUY') ||
    haystack.includes('DIRECTION=BUY') ||
    haystack.includes('MICRO_LONG_')
  );
}

function hasShortDefinitionSignal(parts = []) {
  const haystack = parts.join('|');

  return (
    haystack.includes('TRADESIDE=SHORT') ||
    haystack.includes('TRADE_SIDE=SHORT') ||
    haystack.includes('SIDE=SHORT') ||
    haystack.includes('SIDE=BEAR') ||
    haystack.includes('DIRECTION=SHORT') ||
    haystack.includes('DIRECTION=BEAR') ||
    haystack.includes('POSITION_SIDE=SHORT') ||
    haystack.includes('POSITIONSIDE=SHORT') ||
    haystack.includes('SIDE=SELL') ||
    haystack.includes('DIRECTION=SELL') ||
    haystack.includes('MICRO_SHORT_')
  );
}

function inferTradeSide(payload = {}) {
  if (typeof payload !== 'object' || payload === null) {
    return normalizeSideToken(payload);
  }

  const directSources = [
    payload.tradeSide,
    payload.positionSide,
    payload.direction,
    payload.signalSide,
    payload.scannerSide,
    payload.actualScannerSide,
    payload.analysisSide,
    payload.entrySide,
    payload.side
  ];

  for (const value of directSources) {
    const side = normalizeSideToken(value);

    if (side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE) {
      return side;
    }
  }

  const ids = idHaystack(payload);
  const longId = hasLongIdSignal(ids);
  const shortId = hasShortIdSignal(ids);

  if (longId && !shortId) return TARGET_TRADE_SIDE;
  if (shortId && !longId) return OPPOSITE_TRADE_SIDE;
  if (longId) return TARGET_TRADE_SIDE;
  if (shortId) return OPPOSITE_TRADE_SIDE;

  const parts = definitionParts(payload);
  const longDefinition = hasLongDefinitionSignal(parts);
  const shortDefinition = hasShortDefinitionSignal(parts);

  if (longDefinition && !shortDefinition) return TARGET_TRADE_SIDE;
  if (shortDefinition && !longDefinition) return OPPOSITE_TRADE_SIDE;
  if (longDefinition) return TARGET_TRADE_SIDE;
  if (shortDefinition) return OPPOSITE_TRADE_SIDE;

  if (payload.longOnly === true || payload.shortDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  if (payload.shortOnly === true || payload.longDisabled === true) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function isLongPayload(payload = {}) {
  return inferTradeSide(payload) === TARGET_TRADE_SIDE;
}

function normalizeSideLabel(payload = {}) {
  return isLongPayload(payload) ? TARGET_TRADE_SIDE : 'NON_LONG_SKIPPED';
}

function discordColorForSide(payload = {}) {
  return isLongPayload(payload) ? 0x22c55e : 0x64748b;
}

function discordColorForResult(value) {
  const r = safeNumber(value, 0);

  if (r > 0) return 0x2563eb;
  if (r < 0) return 0xdc2626;

  return 0x94a3b8;
}

function extractExitPrice(outcome = {}) {
  return (
    outcome.exit ??
    outcome.exitPrice ??
    outcome.close ??
    outcome.closePrice ??
    outcome.price ??
    outcome.lastPrice ??
    null
  );
}

function extractResultR(outcome = {}) {
  return (
    outcome.netR ??
    outcome.exitR ??
    outcome.realizedNetR ??
    outcome.realizedR ??
    outcome.r ??
    null
  );
}

function trueMicroFamilyId(payload = {}) {
  const candidates = [
    payload.trueMicroFamilyId,
    payload.childTrueMicroFamilyId,
    payload.microFamilyId,
    payload.analyzeMicroFamilyId,
    payload.learningMicroFamilyId
  ];

  for (const candidate of candidates) {
    const value = upper(candidate);

    if (validLearningChildId(value)) return value;
  }

  return null;
}

function childTrueMicroFamilyId(payload = {}) {
  return trueMicroFamilyId(payload);
}

function parentTrueMicroFamilyId(payload = {}) {
  const childId = trueMicroFamilyId(payload);
  const parsedChild = parseLongTaxonomyMicroId(childId);

  if (parsedChild.parentTrueMicroFamilyId) return parsedChild.parentTrueMicroFamilyId;

  const candidates = [
    payload.parentTrueMicroFamilyId,
    payload.coarseMicroFamilyId,
    payload.parentMacroFamilyId,
    payload.parentMicroFamilyId,
    payload.macroFamilyId,
    payload.activeMacroFamilyId
  ];

  for (const candidate of candidates) {
    const value = upper(candidate);

    if (isParentTrueMicroFamilyId(value)) return value;

    const parsed = parseLongTaxonomyMicroId(value);

    if (parsed.parentTrueMicroFamilyId) return parsed.parentTrueMicroFamilyId;
  }

  return null;
}

function microFamilyId(payload = {}) {
  return trueMicroFamilyId(payload);
}

function macroFamilyId(payload = {}) {
  return parentTrueMicroFamilyId(payload);
}

function weeklyStats(payload = {}) {
  return payload.weeklyStats || payload.microStats || payload.stats || {};
}

function statValue(payload = {}, key, fallbackKey = null) {
  const stats = weeklyStats(payload);

  return (
    stats?.[key] ??
    (fallbackKey ? stats?.[fallbackKey] : undefined) ??
    payload?.[key] ??
    (fallbackKey ? payload?.[fallbackKey] : undefined) ??
    null
  );
}

function completedSample(payload = {}) {
  const stats = weeklyStats(payload);

  const virtualCompleted = safeNumber(stats.virtualCompleted ?? payload.virtualCompleted, 0);
  const shadowCompleted = safeNumber(stats.shadowCompleted ?? payload.shadowCompleted, 0);
  const closed = virtualCompleted + shadowCompleted;

  if (closed > 0) return closed;

  return (
    statValue(payload, 'completed') ??
    statValue(payload, 'winrateSample') ??
    0
  );
}

function bestWinrate(payload = {}) {
  return (
    statValue(payload, 'fairWinrate') ??
    statValue(payload, 'sampleAdjustedWinrate') ??
    statValue(payload, 'bayesianWinrate') ??
    statValue(payload, 'wilsonLowerBound') ??
    statValue(payload, 'winrate') ??
    0
  );
}

function fingerprint(payload = {}) {
  return (
    payload.executionFingerprintHash ||
    payload.fingerprintHash ||
    payload.microFingerprintHash ||
    'NA'
  );
}

function isRealOrderSource(payload = {}) {
  const sources = [
    payload.source,
    payload.sourceMode,
    payload.outcomeSource,
    payload.positionSource,
    payload.orderSource
  ]
    .map(normalizeSource)
    .filter(Boolean);

  if (sources.some((source) => REAL_ORDER_SOURCES.has(source))) return true;

  return Boolean(
    payload.realTrade === true ||
    payload.realOrder === true ||
    payload.exchangeOrder === true ||
    payload.bitgetOrderPlaced === true ||
    payload.liveOrder === true ||
    payload.orderPlaced === true
  );
}

function isVirtualSource(payload = {}) {
  const sources = [
    payload.source,
    payload.sourceMode,
    payload.outcomeSource,
    payload.positionSource
  ].map(normalizeSource);

  return (
    sources.includes(SOURCE_VIRTUAL) ||
    payload.virtualOnly === true ||
    payload.virtualTracked === true ||
    payload.paperTrade === true ||
    payload.paperPosition === true
  );
}

function isMirrorPayload(payload = {}) {
  const source = normalizeSource(payload.source);

  return Boolean(
    source === SOURCE_SHADOW ||
    payload.observationMirror === true ||
    payload.analysisMirror === true ||
    payload.mirrorAnalysisOnly === true ||
    payload.isMirrorMicroFamily === true ||
    payload.mirrorOfSide
  );
}

function isAnalysisOnlyPayload(payload = {}) {
  return Boolean(
    payload.observationOnly === true ||
    payload.analysisInputOnly === true ||
    payload.learningOnly === true ||
    payload.analyzeOnly === true ||
    payload.discoveryOnly === true ||
    payload.tradeDiscoveryOnly === true ||
    payload.scannerOnly === true
  );
}

function hasValidLongTradeShape(entry = {}) {
  const entryPrice = safeNumber(entry.entry, 0);
  const sl = safeNumber(entry.sl ?? entry.stopLoss, 0);
  const tp = safeNumber(entry.tp ?? entry.takeProfit, 0);

  if (entryPrice <= 0) return false;
  if (sl <= 0 || sl >= entryPrice) return false;
  if (tp <= entryPrice) return false;

  return true;
}

function selectedTrueMicroIdsFromPayload(payload = {}) {
  return uniqueStrings([
    payload.selectedTrueMicroFamilyId,
    payload.selectedMicroFamilyId,
    payload.activeTrueMicroFamilyId,
    payload.activeMicroFamilyId,
    payload.rotationTrueMicroFamilyId,
    payload.rotationMicroFamilyId,

    payload.selectedTrueMicroFamilyIds || [],
    payload.selectedMicroFamilyIds || [],
    payload.activeTrueMicroFamilyIds || [],
    payload.activeMicroFamilyIds || [],
    payload.trueMicroFamilyIds || [],
    payload.microFamilyIds || []
  ])
    .map(upper)
    .filter(validLearningChildId);
}

function matchTypeIsExactChildTrueMicro(entry = {}) {
  const matchType = upper(entry.rotationMatchType || entry.matchType || '');

  if (!matchType) {
    return Boolean(
      entry.discordAlertEligible === true ||
      entry.selectedForDiscord === true
    );
  }

  if (
    matchType.includes('MACRO') ||
    matchType.includes('PARENT') ||
    matchType.includes('COARSE') ||
    matchType.includes('SCANNER') ||
    matchType.includes('EXECUTION') ||
    matchType.includes('XR')
  ) {
    return false;
  }

  return (
    matchType === 'TRUE_MICRO_EXACT' ||
    matchType === 'EXACT_TRUE_MICRO' ||
    matchType === 'EXACT_75_CHILD' ||
    matchType === 'EXACT_75_CHILD_TRUE_MICRO' ||
    matchType === 'SELECTED_TRUE_MICRO_EXACT' ||
    matchType.includes('TRUE_MICRO_EXACT') ||
    matchType.includes('EXACT_TRUE_MICRO') ||
    matchType.includes('EXACT_75_CHILD') ||
    matchType.includes('CHILD_TRUE_MICRO')
  );
}

function hasSelectedMicroRotationMatch(entry = {}) {
  const microId = trueMicroFamilyId(entry);

  if (!microId) return false;
  if (!validLearningChildId(microId)) return false;
  if (!entry.activeRotationId && !entry.rotationId) return false;

  const selected = Boolean(
    entry.discordAlertEligible === true ||
    entry.selectedForDiscord === true ||
    entry.liveEligible === true
  );

  if (!selected) return false;
  if (!matchTypeIsExactChildTrueMicro(entry)) return false;

  const selectedIds = selectedTrueMicroIdsFromPayload(entry);

  if (selectedIds.length > 0 && !selectedIds.includes(microId)) {
    return false;
  }

  return true;
}

function shouldSendEntryAlert(entry = {}) {
  if (!isLongPayload(entry)) return false;
  if (isMirrorPayload(entry)) return false;
  if (isAnalysisOnlyPayload(entry)) return false;
  if (isRealOrderSource(entry)) return false;
  if (!isVirtualSource(entry)) return false;

  if (entry.action && upper(entry.action) !== 'ENTRY') return false;

  if (!hasSelectedMicroRotationMatch(entry)) return false;
  if (!hasValidLongTradeShape(entry)) return false;

  return true;
}

function shouldSendExitAlert(outcome = {}) {
  if (!isLongPayload(outcome)) return false;
  if (isMirrorPayload(outcome)) return false;
  if (isAnalysisOnlyPayload(outcome)) return false;
  if (isRealOrderSource(outcome)) return false;
  if (!isVirtualSource(outcome)) return false;

  const microId = trueMicroFamilyId(outcome);

  if (!microId) return false;
  if (!validLearningChildId(microId)) return false;
  if (!hasSelectedMicroRotationMatch(outcome)) return false;

  return true;
}

function compactPayload(payload = {}) {
  const tradeSide = inferTradeSide(payload);
  const trueId = trueMicroFamilyId(payload);
  const parentId = parentTrueMicroFamilyId(payload);
  const parsed = parseLongTaxonomyMicroId(trueId);

  return {
    symbol: payload.symbol || null,
    contractSymbol: payload.contractSymbol || null,

    side: tradeSide === TARGET_TRADE_SIDE
      ? TARGET_DASHBOARD_SIDE
      : payload.side || null,

    tradeSide,

    action: payload.action || null,
    reason: payload.reason || null,
    exitReason: payload.exitReason || null,

    source: normalizeSource(payload.source),
    sourceMode: payload.sourceMode || null,
    outcomeSource: payload.outcomeSource || null,
    positionSource: payload.positionSource || null,

    liveEligible: Boolean(payload.liveEligible),
    discordAlertEligible: Boolean(payload.discordAlertEligible),
    selectedForDiscord: Boolean(payload.selectedForDiscord),

    virtualOnly: payload.virtualOnly !== false,
    virtualTracked: payload.virtualTracked !== false,
    shadowOnly: Boolean(payload.shadowOnly),

    observationOnly: Boolean(payload.observationOnly),
    analysisInputOnly: Boolean(payload.analysisInputOnly),
    learningOnly: Boolean(payload.learningOnly),

    rotationMatchType: payload.rotationMatchType || null,

    microFamilyId: trueId,
    trueMicroFamilyId: trueId,
    childTrueMicroFamilyId: trueId,
    parentTrueMicroFamilyId: parentId,
    coarseMicroFamilyId: parentId,

    setupType: parsed.setupType || payload.setupType || null,
    regimeBucket: parsed.regimeBucket || payload.regimeBucket || null,
    confirmationProfile: parsed.confirmationProfile || payload.confirmationProfile || null,

    familyId: payload.familyId || null,
    macroFamilyId: parentId,

    activeRotationId: payload.activeRotationId || payload.rotationId || null,

    executionFingerprintHash: payload.executionFingerprintHash || null,
    executionFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintRole: payload.scannerFingerprintRole || 'METADATA_ONLY',

    entry: payload.entry ?? null,
    exit: extractExitPrice(payload),
    sl: payload.sl ?? null,
    tp: payload.tp ?? null,
    rr: payload.rr ?? null,

    currentPrice: payload.currentPrice ?? payload.lastPrice ?? null,
    currentR: payload.currentR ?? null,
    mfeR: payload.mfeR ?? null,
    maeR: payload.maeR ?? null,

    reachedHalfR: Boolean(payload.reachedHalfR),
    reachedOneR: Boolean(payload.reachedOneR),
    nearTpSeen: Boolean(payload.nearTpSeen),

    winrate: bestWinrate(payload),
    completed: completedSample(payload),
    avgR: statValue(payload, 'avgR'),
    totalR: statValue(payload, 'totalR'),
    profitFactor: statValue(payload, 'profitFactor'),
    avgCostR: statValue(payload, 'avgCostR'),

    exitR: payload.exitR ?? null,
    netR: payload.netR ?? null,
    grossR: payload.grossR ?? null,
    costR: payload.costR ?? null,
    pnlPct: payload.pnlPct ?? payload.netPnlPct ?? null,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,

    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,

    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    discordOnlyForExactTrueMicroMatch: true,
    selectionGranularity: 'EXACT_75_CHILD',

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,

    ts: Date.now()
  };
}

async function postDiscord(content) {
  const cfg = discordConfig();

  if (!cfg.enabled || !cfg.webhookUrl) {
    return {
      ok: true,
      skipped: true,
      reason: 'DISCORD_DISABLED'
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  try {
    const response = await fetch(cfg.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(content),
      signal: controller.signal
    });

    const responseText = await response.text().catch(() => '');

    return {
      ok: response.ok,
      status: response.status,
      response: response.ok ? undefined : truncate(responseText, 500)
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.name === 'AbortError'
        ? 'DISCORD_TIMEOUT'
        : error?.message || String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function logDiscord(type, payload, result) {
  try {
    const cfg = discordConfig();
    const redis = getDurableRedis();

    await pushJsonLog(
      redis,
      LONG_KEYS.discord.logList,
      {
        type,
        payload: compactPayload(payload),
        result,
        longOnly: true,
        shortDisabled: true,
        redisNamespace: LONG_NAMESPACE,
        redisKeyPrefix: LONG_KEY_PREFIX,
        redisKey: LONG_KEYS.discord.logList,
        persistentLearningKey: PERSISTENT_LEARNING_KEY,
        shortRootTouched: false,
        ts: Date.now()
      },
      cfg.logLimit
    );
  } catch {
    // Discord logging mag trade execution nooit blokkeren.
  }
}

async function skipDiscord(type, payload = {}, reason = 'DISCORD_SKIPPED') {
  const result = {
    ok: true,
    skipped: true,
    reason,
    detectedTradeSide: inferTradeSide(payload),
    source: normalizeSource(payload.source),
    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    discordOnlyForExactTrueMicroMatch: true,
    selectionGranularity: 'EXACT_75_CHILD',
    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    shortRootTouched: false
  };

  await logDiscord(type, payload, result);

  return result;
}

function entrySkipReason(entry = {}) {
  if (!isLongPayload(entry)) return 'DISCORD_LONG_ONLY_SKIPPED_NON_LONG';
  if (isMirrorPayload(entry)) return 'DISCORD_SKIPPED_MIRROR_PAYLOAD';
  if (isAnalysisOnlyPayload(entry)) return 'DISCORD_SKIPPED_ANALYSIS_ONLY';
  if (isRealOrderSource(entry)) return 'DISCORD_REAL_ORDER_SOURCE_BLOCKED';
  if (!isVirtualSource(entry)) return 'DISCORD_VIRTUAL_SOURCE_REQUIRED';
  if (entry.action && upper(entry.action) !== 'ENTRY') return 'DISCORD_SKIPPED_NOT_ENTRY_ACTION';
  if (!trueMicroFamilyId(entry)) return 'ENTRY_EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_MISSING';
  if (!validLearningChildId(trueMicroFamilyId(entry))) return 'ENTRY_ONLY_EXACT_75_CHILD_TRUE_MICRO_ALLOWED';
  if (!hasSelectedMicroRotationMatch(entry)) return 'ENTRY_NOT_SELECTED_MANUAL_75_CHILD_TRUE_MICRO_MATCH';
  if (!hasValidLongTradeShape(entry)) return 'ENTRY_INVALID_LONG_TRADE_SHAPE_SL_ENTRY_TP_REQUIRED';

  return 'ENTRY_NOT_ELIGIBLE';
}

function exitSkipReason(outcome = {}) {
  if (!isLongPayload(outcome)) return 'DISCORD_LONG_ONLY_SKIPPED_NON_LONG';
  if (isMirrorPayload(outcome)) return 'DISCORD_SKIPPED_MIRROR_PAYLOAD';
  if (isAnalysisOnlyPayload(outcome)) return 'DISCORD_SKIPPED_ANALYSIS_ONLY';
  if (isRealOrderSource(outcome)) return 'DISCORD_REAL_ORDER_SOURCE_BLOCKED';
  if (!isVirtualSource(outcome)) return 'DISCORD_VIRTUAL_SOURCE_REQUIRED';
  if (!trueMicroFamilyId(outcome)) return 'EXIT_EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_MISSING';
  if (!validLearningChildId(trueMicroFamilyId(outcome))) return 'EXIT_ONLY_EXACT_75_CHILD_TRUE_MICRO_ALLOWED';
  if (!hasSelectedMicroRotationMatch(outcome)) return 'EXIT_NOT_SELECTED_MANUAL_75_CHILD_TRUE_MICRO_MATCH';

  return 'EXIT_NOT_ELIGIBLE';
}

function entryReasonText(entry = {}) {
  const statsSample = completedSample(entry);
  const wr = bestWinrate(entry);
  const avgR = statValue(entry, 'avgR');
  const totalR = statValue(entry, 'totalR');
  const avgCostR = statValue(entry, 'avgCostR');

  return [
    'MANUAL_75_CHILD_TRUE_MICRO_MATCH',
    `SOURCE=${SOURCE_VIRTUAL}`,
    `WR=${fmtPctSmart(wr)}`,
    `SAMPLE=${fmtNumber(statsSample, 2)}`,
    `AVG_R=${fmtR(avgR)}`,
    `TOTAL_R=${fmtR(totalR)}`,
    `AVG_COST_R=${fmtR(avgCostR)}`
  ].join(' | ');
}

export async function sendEntryAlert(entry = {}) {
  if (!shouldSendEntryAlert(entry)) {
    return skipDiscord(
      'ENTRY_SKIPPED',
      entry,
      entrySkipReason(entry)
    );
  }

  const symbol = normalizeBaseSymbol(entry.symbol || entry.contractSymbol);
  const side = normalizeSideLabel(entry);

  const stats = weeklyStats(entry);
  const sample = completedSample(entry);
  const wr = bestWinrate(entry);
  const avgR = statValue(entry, 'avgR');
  const totalR = statValue(entry, 'totalR');
  const profitFactor = statValue(entry, 'profitFactor');
  const directSLPct = statValue(entry, 'directSLPct');
  const sampleReliability = statValue(entry, 'sampleReliability');
  const avgCostR = statValue(entry, 'avgCostR');
  const parsed = parseLongTaxonomyMicroId(trueMicroFamilyId(entry));

  const content = {
    username: 'Micro-Family Trader',
    embeds: [
      {
        title: `${symbol || 'UNKNOWN'} ${side} VIRTUAL SNIPER ENTRY`,
        color: discordColorForSide(entry),
        description: truncate(entryReasonText(entry), 300),
        fields: [
          field('Source', SOURCE_VIRTUAL, true),
          field('Entry', fmtPrice(entry.entry), true),
          field('TP', fmtPrice(entry.tp), true),
          field('SL', fmtPrice(entry.sl), true),
          field('RR', fmtR(entry.rr), true),
          field('Risk', fmtPct(entry.riskPct), true),
          field('Spread', fmtPct(entry.spreadPct ?? entry.liveSpreadPct), true),

          field('True micro 75-child', trueMicroFamilyId(entry) || 'NA', false),
          field('Parent 15', parentTrueMicroFamilyId(entry) || 'NA', false),
          field('Setup', parsed.setupType || entry.setupType || 'NA', true),
          field('Regime', parsed.regimeBucket || entry.regimeBucket || 'NA', true),
          field('Confirmation', parsed.confirmationProfile || entry.confirmationProfile || 'NA', true),

          field('Fingerprint metadata', fingerprint(entry), true),
          field('Rotation', entry.activeRotationId || entry.rotationId || 'NA', true),
          field('Match', entry.rotationMatchType || 'TRUE_MICRO_EXACT_75_CHILD', true),

          field('Winrate fair', fmtPctSmart(wr), true),
          field('Completed', fmtNumber(sample, 2), true),
          field('Reliability', fmtPctSmart(sampleReliability), true),
          field('Avg R', fmtR(avgR), true),
          field('Total R', fmtR(totalR), true),
          field('Avg cost', fmtR(avgCostR), true),
          field('Profit factor', fmtNumber(profitFactor, 2), true),
          field('Direct SL', fmtPctSmart(directSLPct), true),

          field(
            'Confluence',
            [
              `RSI=${entry.rsiZone || stats.rsiZone || 'NA'}`,
              `FLOW=${entry.flow || stats.flow || 'NA'}`,
              `OB=${entry.obRelation || stats.obRelation || 'NA'}`,
              `BTC=${entry.btcRelation || stats.btcRelation || 'NA'}`,
              `REGIME=${entry.regime || stats.regime || 'NA'}`
            ].join(' | '),
            false
          )
        ],
        timestamp: nowIso()
      }
    ]
  };

  const result = await postDiscord(content);
  await logDiscord('ENTRY', {
    ...entry,
    source: SOURCE_VIRTUAL,
    outcomeSource: SOURCE_VIRTUAL,
    virtualOnly: true,
    virtualTracked: true,
    longOnly: true,
    shortDisabled: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA
  }, result);

  return result;
}

export async function sendExitAlert(outcome = {}) {
  if (!shouldSendExitAlert(outcome)) {
    return skipDiscord(
      'EXIT_SKIPPED',
      outcome,
      exitSkipReason(outcome)
    );
  }

  const symbol = normalizeBaseSymbol(outcome.symbol || outcome.contractSymbol);
  const side = normalizeSideLabel(outcome);
  const exitPrice = extractExitPrice(outcome);
  const resultR = extractResultR(outcome);
  const parsed = parseLongTaxonomyMicroId(trueMicroFamilyId(outcome));

  const content = {
    username: 'Micro-Family Trader',
    embeds: [
      {
        title: `${symbol || 'UNKNOWN'} ${side} VIRTUAL EXIT`,
        color: discordColorForResult(resultR),
        fields: [
          field('Source', SOURCE_VIRTUAL, true),
          field('Exit', fmtPrice(exitPrice), true),
          field('Result net', fmtR(resultR), true),
          field('Reason', outcome.exitReason || 'EXIT', true),
          field('Cost', fmtR(outcome.costR), true),
          field('PnL net', fmtPct(outcome.pnlPct ?? outcome.netPnlPct), true),
          field('Gross R', fmtR(outcome.grossR), true),
          field('MFE', fmtR(outcome.mfeR), true),
          field('MAE', fmtR(outcome.maeR), true),

          field('True micro 75-child', trueMicroFamilyId(outcome) || 'NA', false),
          field('Parent 15', parentTrueMicroFamilyId(outcome) || 'NA', false),
          field('Setup', parsed.setupType || outcome.setupType || 'NA', true),
          field('Regime', parsed.regimeBucket || outcome.regimeBucket || 'NA', true),
          field('Confirmation', parsed.confirmationProfile || outcome.confirmationProfile || 'NA', true),

          field('Fingerprint metadata', fingerprint(outcome), true),
          field('Rotation', outcome.activeRotationId || outcome.rotationId || 'NA', true)
        ],
        timestamp: nowIso()
      }
    ]
  };

  const result = await postDiscord(content);
  await logDiscord('EXIT', {
    ...outcome,
    source: SOURCE_VIRTUAL,
    outcomeSource: SOURCE_VIRTUAL,
    virtualOnly: true,
    virtualTracked: true,
    longOnly: true,
    shortDisabled: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA
  }, result);

  return result;
}

function exactChildIdsFromRotation(rotation = {}) {
  return uniqueStrings([
    rotation.trueMicroFamilyIds || [],
    rotation.childTrueMicroFamilyIds || [],
    rotation.microFamilyIds || [],
    rotation.activeMicroFamilyIds || [],
    rotation.activeTrueMicroFamilyIds || [],
    Array.isArray(rotation.microFamilies)
      ? rotation.microFamilies.map((row) => trueMicroFamilyId(row))
      : []
  ])
    .map(upper)
    .filter(validLearningChildId);
}

function bestLongId(rotation = {}) {
  const candidates = [
    trueMicroFamilyId(rotation.bestLong || {}),
    rotation.selectedTrueMicroFamilyId,
    rotation.selectedMicroFamilyId,
    ...exactChildIdsFromRotation(rotation)
  ];

  for (const candidate of candidates) {
    const value = upper(candidate);

    if (validLearningChildId(value)) return value;
  }

  return 'NA';
}

function shouldSendRotationReport(rotation = {}, label = '') {
  const cfg = discordConfig();

  if (!cfg.sendRotationReports) return false;

  const normalizedLabel = upper(label);

  if (normalizedLabel.includes('NEXT_ROTATION_READY')) return false;
  if (rotation.autoRotation === true && rotation.liveSelectable !== true) return false;
  if (rotation.empty === true) return false;

  const childIds = exactChildIdsFromRotation(rotation);

  if (childIds.length === 0) return false;

  return Boolean(
    rotation.manualOnly === true ||
    rotation.adminSelected === true ||
    rotation.liveSelectable === true
  );
}

export async function sendWeeklyRotationReport(rotationInput = {}, label = 'WEEKLY_ROTATION') {
  const rotation =
    rotationInput.rotation ||
    rotationInput.activeRotation ||
    rotationInput.nextRotation ||
    rotationInput;

  if (!shouldSendRotationReport(rotation, label)) {
    return skipDiscord(
      'WEEKLY_ROTATION_SKIPPED',
      {
        ...rotation,
        bestShort: null,
        longOnly: true,
        shortDisabled: true,
        shortOnly: false,
        longDisabled: false
      },
      'ROTATION_REPORT_DISABLED_OR_NOT_MANUAL_LIVE_SELECTABLE_EXACT_75_CHILD'
    );
  }

  const childIds = exactChildIdsFromRotation(rotation);
  const parentIds = uniqueStrings(
    childIds
      .map((id) => parseLongTaxonomyMicroId(id).parentTrueMicroFamilyId)
      .filter(Boolean)
  );

  const week =
    rotation.sourceWeekKey ||
    rotation.activeWeekKey ||
    rotation.weekKey ||
    PERSISTENT_LEARNING_KEY;

  const content = {
    username: 'Micro-Family Trader',
    embeds: [
      {
        title: `${label} LONG MANUAL 75-CHILD MICRO SET`,
        color: 0x7c3aed,
        fields: [
          field('75-child count', String(childIds.length), true),
          field('Parent-15 count', String(parentIds.length), true),
          field('Mode', rotation.mode || 'NA', true),
          field('Week', week, true),
          field('Best LONG 75-child', bestLongId(rotation), false),
          field('Manual only', String(Boolean(rotation.manualOnly)), true),
          field('Live selectable', String(Boolean(rotation.liveSelectable)), true),
          field('Short disabled', 'true', true),
          field('Schema', TRUE_MICRO_SCHEMA, true),
          field('Learning key', PERSISTENT_LEARNING_KEY, true)
        ],
        timestamp: nowIso()
      }
    ]
  };

  const result = await postDiscord(content);
  await logDiscord('WEEKLY_ROTATION', {
    ...rotation,
    bestShort: null,
    trueMicroFamilyIds: childIds,
    childTrueMicroFamilyIds: childIds,
    parentTrueMicroFamilyIds: parentIds,
    macroFamilyIds: parentIds,
    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA
  }, result);

  return result;
}

export async function sendResetReport(report = {}) {
  const cfg = discordConfig();

  if (!cfg.sendResetReports) {
    return skipDiscord('RESET_SKIPPED', report, 'RESET_REPORTS_DISABLED');
  }

  const deletedCount = Object.keys(report.deleted || {}).length;

  const content = {
    username: 'Micro-Family Trader',
    embeds: [
      {
        title: `RESET ${report.type || 'UNKNOWN'}`,
        color: report.ok ? 0xf59e0b : 0xdc2626,
        fields: [
          field('OK', String(Boolean(report.ok)), true),
          field('Reason', report.reason || 'OK', true),
          field('Deleted', String(deletedCount), true),
          field('Long only', 'true', true),
          field('Short disabled', 'true', true),
          field('Redis namespace', LONG_NAMESPACE, true),
          field('Learning key', PERSISTENT_LEARNING_KEY, true)
        ],
        timestamp: nowIso()
      }
    ]
  };

  const result = await postDiscord(content);
  await logDiscord('RESET', {
    ...report,
    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    shortRootTouched: false
  }, result);

  return result;
}