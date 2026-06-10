// ================= FILE: api/admin/overview.js =================

import { KEYS } from '../../src/keys.js';
import {
  getDurableRedis,
  getVolatileRedis,
  getJson,
  readJsonLogs
} from '../../src/redis.js';
import {
  safeNumber,
  sideToTradeSide
} from '../../src/utils.js';
import { getOpenPositions } from '../../src/trade/positionEngine.js';
import { getWeekMicros } from '../../src/analyze/analyzeEngine.js';
import { getRotationDashboard } from '../../src/analyze/rotationEngine.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;

// Vaste leer-sleutel: overview leest dezelfde doorlopende leerbak als analyzeEngine.js.
// Geen ISO-week reset meer. Alleen handmatige LONG factory-reset wist LONG ANALYZE:*.
const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';

const MIN_COMPLETED_ACTIVE_LEARNING = 20;

function now() {
  return Date.now();
}

function namespacedLongKey(key, fallback = null) {
  const raw = String(key || fallback || '').trim();

  if (!raw) return null;
  if (raw.startsWith(LONG_KEY_PREFIX)) return raw;

  return `${LONG_KEY_PREFIX}${raw}`;
}

const LONG_KEYS = {
  scan: {
    latest: namespacedLongKey(
      KEYS.long?.scan?.latest ||
        KEYS.scan?.longLatest ||
        KEYS.scan?.latest,
      'SCAN:LATEST'
    )
  },

  trade: {
    runMeta: namespacedLongKey(
      KEYS.long?.trade?.runMeta ||
        KEYS.trade?.longRunMeta ||
        KEYS.trade?.runMeta,
      'TRADE:RUN_META'
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

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET'],
    ...modeFlags()
  });
}

function modeFlags() {
  return {
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    weekResetDisabled: true,
    isoWeekLearningDisabled: true,

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

    virtualOnly: true,
    virtualLearning: true,
    virtualLearningForced: true,
    virtualTracked: true,
    shadowOnly: true,
    virtualOutcomesIncluded: true,
    shadowOutcomesIncluded: true,
    realOutcomesExcluded: true,
    learningOutcomesOnly: true,
    outcomesSourceMode: 'VIRTUAL_AND_SHADOW_NET_OUTCOMES',
    outcomeSource: 'VIRTUAL',

    observationFirst: true,
    netOutcomesOnly: true,
    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winrateDefinition: 'netR > 0',

    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,

    globalMaxOpenPositionsBlockDisabled: true,
    maxOneOpenPositionPerSymbol: true,

    tradePositionTimeStopMinDefault: 720,

    scannerSide: TARGET_DASHBOARD_SIDE,
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,

    bucketsCoarseOnly: true,
    bucketGranularity: 'LOW_MID_HIGH',

    manualSelectionOnly: true,
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    autoRotationActivationDisabled: true,
    activateFreezeCronDisabled: true,
    resetCronDisabled: true,
    discordOnlyForSelectedMicroFamilies: true,

    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    redisKeysSeparatedFromShortRoot: true,
    shortRootTouched: false
  };
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);

  return [];
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function sourceEntries(value = {}) {
  if (Array.isArray(value)) {
    return value.map((row, index) => [
      row?.trueMicroFamilyId || row?.microFamilyId || row?.id || row?.key || String(index),
      row
    ]);
  }

  if (value && typeof value === 'object') {
    return Object.entries(value);
  }

  return [];
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function num(value, fallback = 0) {
  const n = safeNumber(value, fallback);

  return Number.isFinite(n) ? n : fallback;
}

function round(value, decimals = 4) {
  return Number(num(value, 0).toFixed(decimals));
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

function isScannerFingerprintId(id = '') {
  const value = upper(id);

  return (
    value.startsWith('MICRO_LONG_SCANNER__') ||
    value.includes('MICRO_LONG_SCANNER__') ||
    value.startsWith('LONG_SCANNER_') ||
    value.startsWith('MICRO_SHORT_SCANNER__') ||
    value.includes('MICRO_SHORT_SCANNER__') ||
    value.startsWith('SHORT_SCANNER_') ||
    value.includes('__SCANNER__') ||
    value.includes('SCANNER_GATE_PASS') ||
    value.includes('SCANNER_GATE_FAIL')
  );
}

function extractSnapshotId(value) {
  if (!value) return null;

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'object') {
    return (
      value.snapshotId ||
      value.id ||
      value.latestSnapshotId ||
      value.scanId ||
      null
    );
  }

  return null;
}

function normalizeSideToken(value) {
  const raw = cleanSideText(value);

  if (!raw) return 'UNKNOWN';

  const direct = sideToTradeSide(raw);

  if (direct === TARGET_TRADE_SIDE || direct === OPPOSITE_TRADE_SIDE) {
    return direct;
  }

  if (['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'UPSIDE'].includes(raw)) {
    return TARGET_TRADE_SIDE;
  }

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE'].includes(raw)) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function getDefinitionHaystack(row = {}) {
  return [
    row.definition,
    row.microDefinition,
    row.macroDefinition,
    row.parentDefinition,
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts : []),
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : []),
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : [])
  ]
    .map((value) => cleanSideText(value))
    .join(' | ');
}

function hasLongSignal(text = '') {
  const value = ` ${cleanSideText(text)} `;

  return (
    value.includes('MICRO_LONG_') ||
    value.includes('TRADESIDE=LONG') ||
    value.includes('TRADE_SIDE=LONG') ||
    value.includes('SIDE=LONG') ||
    value.includes('SIDE=BULL') ||
    value.includes('SIDE=BUY') ||
    value.includes('DIRECTION=LONG') ||
    value.includes('DIRECTION=BULL') ||
    value.includes('DIRECTION=BUY') ||
    value.includes('POSITION_SIDE=LONG') ||
    value.includes('POSITIONSIDE=LONG') ||
    value.includes(' LONG_') ||
    value.includes('_LONG ') ||
    value.includes('_LONG_') ||
    value.includes('|LONG|') ||
    value.includes(':LONG') ||
    value.includes('=LONG') ||
    value.includes(' BULL ') ||
    value.includes('_BULL') ||
    value.includes('BULL_') ||
    value.includes('|BULL|') ||
    value.includes(':BULL') ||
    value.includes('=BULL') ||
    value.includes(' BUY ') ||
    value.includes('_BUY') ||
    value.includes('BUY_') ||
    value.includes('|BUY|') ||
    value.includes(':BUY') ||
    value.includes('=BUY')
  );
}

function hasShortSignal(text = '') {
  const value = ` ${cleanSideText(text)} `;

  return (
    value.includes('MICRO_SHORT_') ||
    value.includes('TRADESIDE=SHORT') ||
    value.includes('TRADE_SIDE=SHORT') ||
    value.includes('SIDE=SHORT') ||
    value.includes('SIDE=BEAR') ||
    value.includes('SIDE=SELL') ||
    value.includes('DIRECTION=SHORT') ||
    value.includes('DIRECTION=BEAR') ||
    value.includes('DIRECTION=SELL') ||
    value.includes('POSITION_SIDE=SHORT') ||
    value.includes('POSITIONSIDE=SHORT') ||
    value.includes(' SHORT_') ||
    value.includes('_SHORT ') ||
    value.includes('_SHORT_') ||
    value.includes('|SHORT|') ||
    value.includes(':SHORT') ||
    value.includes('=SHORT') ||
    value.includes(' BEAR ') ||
    value.includes('_BEAR') ||
    value.includes('BEAR_') ||
    value.includes('|BEAR|') ||
    value.includes(':BEAR') ||
    value.includes('=BEAR') ||
    value.includes(' SELL ') ||
    value.includes('_SELL') ||
    value.includes('SELL_') ||
    value.includes('|SELL|') ||
    value.includes(':SELL') ||
    value.includes('=SELL')
  );
}

function inferTradeSide(input = {}) {
  if (typeof input === 'string') {
    const value = cleanSideText(input);

    if (!value) return 'UNKNOWN';

    const direct = normalizeSideToken(value);

    if (direct === TARGET_TRADE_SIDE || direct === OPPOSITE_TRADE_SIDE) {
      return direct;
    }

    const longSignal = hasLongSignal(value);
    const shortSignal = hasShortSignal(value);

    if (longSignal && !shortSignal) return TARGET_TRADE_SIDE;
    if (shortSignal && !longSignal) return OPPOSITE_TRADE_SIDE;

    if (longSignal && shortSignal) {
      if (value.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
      if (value.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
    }

    if (
      value.includes('LONG') ||
      value.includes('BULL') ||
      value.includes('BUY')
    ) {
      return TARGET_TRADE_SIDE;
    }

    if (
      value.includes('SHORT') ||
      value.includes('BEAR') ||
      value.includes('SELL')
    ) {
      return OPPOSITE_TRADE_SIDE;
    }

    return 'UNKNOWN';
  }

  const directSources = [
    input.tradeSide,
    input.side,
    input.positionSide,
    input.direction,
    input.signalSide,
    input.scannerSide,
    input.actualScannerSide,
    input.analysisSide,
    input.entrySide,
    input.bias,
    input.marketBias
  ];

  for (const source of directSources) {
    const side = normalizeSideToken(source);

    if (side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE) {
      return side;
    }
  }

  const familyId = cleanSideText(input.familyId || input.family || input.baseFamilyId);

  const macroFamilyId = cleanSideText(
    input.parentMacroFamilyId ||
    input.macroFamilyId ||
    input.parentMicroFamilyId ||
    input.parentFamilyId ||
    input.macroId
  );

  const microFamilyId = cleanSideText(
    input.trueMicroFamilyId ||
    input.microFamilyId ||
    input.coarseMicroFamilyId ||
    input.baseMicroFamilyId ||
    input.legacyMicroFamilyId ||
    input.id ||
    input.key
  );

  if (familyId.startsWith('LONG_')) return TARGET_TRADE_SIDE;
  if (familyId.startsWith('SHORT_')) return OPPOSITE_TRADE_SIDE;

  if (macroFamilyId.includes('MICRO_LONG_') || macroFamilyId.startsWith('LONG_')) return TARGET_TRADE_SIDE;
  if (macroFamilyId.includes('MICRO_SHORT_') || macroFamilyId.startsWith('SHORT_')) return OPPOSITE_TRADE_SIDE;

  if (macroFamilyId.includes('TRADESIDE=LONG') || macroFamilyId.includes('SIDE=LONG')) return TARGET_TRADE_SIDE;
  if (macroFamilyId.includes('TRADESIDE=SHORT') || macroFamilyId.includes('SIDE=SHORT')) return OPPOSITE_TRADE_SIDE;

  if (microFamilyId.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
  if (microFamilyId.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;

  if (microFamilyId.includes('TRADESIDE=LONG') || microFamilyId.includes('SIDE=LONG')) return TARGET_TRADE_SIDE;
  if (microFamilyId.includes('TRADESIDE=SHORT') || microFamilyId.includes('SIDE=SHORT')) return OPPOSITE_TRADE_SIDE;

  const definition = getDefinitionHaystack(input);

  const longSignal = hasLongSignal(definition);
  const shortSignal = hasShortSignal(definition);

  if (longSignal && !shortSignal) return TARGET_TRADE_SIDE;
  if (shortSignal && !longSignal) return OPPOSITE_TRADE_SIDE;

  if (longSignal && shortSignal) {
    if (microFamilyId.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
    if (microFamilyId.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
    if (familyId.startsWith('LONG_')) return TARGET_TRADE_SIDE;
    if (familyId.startsWith('SHORT_')) return OPPOSITE_TRADE_SIDE;
  }

  if (microFamilyId.includes('LONG')) return TARGET_TRADE_SIDE;
  if (microFamilyId.includes('SHORT')) return OPPOSITE_TRADE_SIDE;

  if (macroFamilyId.includes('LONG')) return TARGET_TRADE_SIDE;
  if (macroFamilyId.includes('SHORT')) return OPPOSITE_TRADE_SIDE;

  if (input.longOnly === true || input.shortDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  if (input.shortOnly === true || input.longDisabled === true) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function isLongRow(row = {}) {
  if (!row) return false;

  const id = String(
    row.trueMicroFamilyId ||
    row.microFamilyId ||
    row.coarseMicroFamilyId ||
    row.id ||
    row.key ||
    ''
  ).trim();

  if (id && isScannerFingerprintId(id)) return false;
  if (isScannerFingerprintId(row.trueMicroFamilyId)) return false;
  if (isScannerFingerprintId(row.coarseMicroFamilyId)) return false;

  return inferTradeSide(row) !== OPPOSITE_TRADE_SIDE;
}

function isShortRow(row = {}) {
  return inferTradeSide(row) === OPPOSITE_TRADE_SIDE;
}

function isAllowedLongId(id = '') {
  const value = String(id || '').trim();

  if (!value) return false;
  if (isScannerFingerprintId(value)) return false;

  return inferTradeSide(value) !== OPPOSITE_TRADE_SIDE;
}

function filterLongRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .filter(Boolean)
    .filter(isLongRow);
}

function normalizeLongSide(row = {}) {
  return {
    ...row,
    ...modeFlags(),

    source: row.source || 'VIRTUAL',

    inferredTradeSide: TARGET_TRADE_SIDE
  };
}

function countMapOrArray(value) {
  return sourceEntries(value)
    .filter(([key, row]) => isLongRow({
      ...(row || {}),
      microFamilyId: row?.microFamilyId || row?.trueMicroFamilyId || key
    }))
    .length;
}

function countShortMapOrArray(value) {
  return sourceEntries(value)
    .filter(([key, row]) => isShortRow({
      ...(row || {}),
      microFamilyId: row?.microFamilyId || row?.trueMicroFamilyId || key
    }))
    .length;
}

function getMicroFamilyId(row = {}, key = '') {
  return (
    row.trueMicroFamilyId ||
    row.microFamilyId ||
    row.id ||
    row.key ||
    key ||
    null
  );
}

function getMacroFamilyId(row = {}) {
  return (
    row.parentMacroFamilyId ||
    row.macroFamilyId ||
    row.parentMicroFamilyId ||
    row.parentFamilyId ||
    row.familyId ||
    row.macroId ||
    null
  );
}

function virtualKeyFromReal(realKey = '') {
  if (!realKey || !String(realKey).startsWith('real')) return null;

  return `virtual${String(realKey).slice(4)}`;
}

function shadowKeyFromReal(realKey = '') {
  if (!realKey || !String(realKey).startsWith('real')) return null;

  return `shadow${String(realKey).slice(4)}`;
}

function getLearningCount(row = {}, aggregateKey, realKey = null, shadowKey = null) {
  if (aggregateKey && hasValue(row[aggregateKey])) {
    return num(row[aggregateKey], 0);
  }

  const virtualKey = virtualKeyFromReal(realKey);
  const resolvedShadowKey = shadowKey || shadowKeyFromReal(realKey);

  return num(virtualKey ? row[virtualKey] : 0, 0) +
    num(resolvedShadowKey ? row[resolvedShadowKey] : 0, 0);
}

function getOutcomeCounts(row = {}) {
  const wins = getLearningCount(row, 'wins', 'realWins', 'shadowWins');
  const losses = getLearningCount(row, 'losses', 'realLosses', 'shadowLosses');
  const flats = getLearningCount(row, 'flats', 'realFlats', 'shadowFlats');

  const explicitCompleted = Math.max(
    num(row.completed, 0),
    num(row.outcomeSample, 0),
    num(row.virtualCompleted, 0) + num(row.shadowCompleted, 0),
    0
  );

  const countedTotal = wins + losses + flats;
  const total = Math.max(countedTotal, explicitCompleted, 0);
  const inferredFlats = Math.max(0, total - wins - losses);

  return {
    wins,
    losses,
    flats: Math.max(flats, inferredFlats),
    total
  };
}

function getOutcomeSample(row = {}) {
  return getOutcomeCounts(row).total;
}

function getObservationSample(row = {}) {
  return Math.max(
    num(row.seen, 0),
    num(row.observations, 0),
    getOutcomeSample(row),
    0
  );
}

function getTotalR(row = {}) {
  const completed = getOutcomeSample(row);

  if (completed <= 0) return 0;

  if (hasValue(row.netTotalR)) return num(row.netTotalR, 0);
  if (hasValue(row.totalNetR)) return num(row.totalNetR, 0);
  if (hasValue(row.totalR)) return num(row.totalR, 0);

  return num(row.virtualTotalR, 0) + num(row.shadowTotalR, 0);
}

function getTotalCostR(row = {}) {
  const completed = getOutcomeSample(row);

  if (completed <= 0) return 0;

  if (hasValue(row.totalCostR)) return num(row.totalCostR, 0);

  const combined = num(row.virtualTotalCostR, 0) + num(row.shadowTotalCostR, 0);

  if (combined > 0) return combined;
  if (hasValue(row.avgCostR)) return num(row.avgCostR, 0) * completed;

  return 0;
}

function tierForMicro(row = {}) {
  const existing = upper(row.tier || row.rotationEligibilityTier || row.selectedTier);

  if (['HARD', 'SOFT', 'OBSERVATION', 'RAW'].includes(existing)) {
    return existing;
  }

  const completed = getOutcomeSample(row);
  const observed = getObservationSample(row);

  if (completed >= MIN_COMPLETED_ACTIVE_LEARNING) return 'HARD';
  if (completed > 0) return 'SOFT';
  if (observed > 0) return 'OBSERVATION';

  return 'RAW';
}

function statusForMicro(row = {}) {
  const existing = upper(row.status || row.learningStatus);

  if (['ACTIVE_LEARNING', 'EARLY_OUTCOMES', 'OBSERVING'].includes(existing)) {
    return existing;
  }

  const completed = getOutcomeSample(row);

  if (completed >= MIN_COMPLETED_ACTIVE_LEARNING) return 'ACTIVE_LEARNING';
  if (completed > 0) return 'EARLY_OUTCOMES';

  return 'OBSERVING';
}

function summarizeMicros(micros = {}) {
  const rows = sourceEntries(micros)
    .map(([key, row]) => ({
      ...(row || {}),
      microFamilyId: getMicroFamilyId(row, key)
    }))
    .filter(isLongRow);

  const summary = rows.reduce((acc, row) => {
    const tier = tierForMicro(row);
    const status = statusForMicro(row);
    const completed = getOutcomeSample(row);
    const observed = getObservationSample(row);

    acc.rows += 1;
    acc.seen += num(row.seen, 0);
    acc.observations += num(row.observations, 0);
    acc.completed += completed;
    acc.totalR += getTotalR(row);
    acc.totalCostR += getTotalCostR(row);

    acc.tierCounts[tier] = (acc.tierCounts[tier] || 0) + 1;
    acc.statusCounts[status] = (acc.statusCounts[status] || 0) + 1;

    if (completed > 0) acc.completedFamilies += 1;
    if (observed > 0 && completed <= 0) acc.observationOnlyFamilies += 1;

    return acc;
  }, {
    rows: 0,
    seen: 0,
    observations: 0,
    completed: 0,
    totalR: 0,
    totalCostR: 0,
    completedFamilies: 0,
    observationOnlyFamilies: 0,
    tierCounts: {
      HARD: 0,
      SOFT: 0,
      OBSERVATION: 0,
      RAW: 0
    },
    statusCounts: {
      ACTIVE_LEARNING: 0,
      EARLY_OUTCOMES: 0,
      OBSERVING: 0
    }
  });

  return {
    ...summary,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    weekResetDisabled: true,
    seen: round(summary.seen, 4),
    observations: round(summary.observations, 4),
    completed: round(summary.completed, 4),
    totalR: round(summary.totalR, 4),
    totalCostR: round(summary.totalCostR, 4),
    avgR: summary.completed > 0 ? round(summary.totalR / summary.completed, 4) : 0,
    avgCostR: summary.completed > 0 ? round(summary.totalCostR / summary.completed, 4) : 0
  };
}

function normalizeLatestScan(latestScan) {
  if (!latestScan || typeof latestScan !== 'object') {
    return null;
  }

  const rawCandidates = Array.isArray(latestScan.candidates)
    ? latestScan.candidates
    : [];

  const candidates = filterLongRows(rawCandidates)
    .map((row) => normalizeLongSide({
      ...row,
      source: row.source || 'SCANNER',
      scannerOnly: true
    }));

  const createdAt = safeNumber(
    latestScan.createdAt ||
    latestScan.completedAt ||
    latestScan.ts ||
    latestScan.scannerTs,
    0
  );

  const snapshotAgeSec = createdAt > 0
    ? Math.max(0, Math.floor((now() - createdAt) / 1000))
    : null;

  const fallbackCandidatesCount = safeNumber(
    latestScan.longCandidatesCount ??
    latestScan.selectedTargetCandidateCount ??
    latestScan.scannerGateCandidatesCount ??
    latestScan.candidatesCount ??
    latestScan.count,
    0
  );

  const topSymbols = candidates.length > 0
    ? candidates
      .slice(0, 20)
      .map((row) => row.symbol || row.contractSymbol)
      .filter(Boolean)
    : Array.isArray(latestScan.topSymbols)
      ? latestScan.topSymbols.slice(0, 20)
      : [];

  return {
    ...latestScan,
    ...modeFlags(),

    snapshotId: extractSnapshotId(latestScan),

    createdAt: createdAt || null,
    snapshotAgeSec,

    rawCandidatesCount: rawCandidates.length,

    candidatesCount: rawCandidates.length > 0
      ? candidates.length
      : fallbackCandidatesCount,

    longCandidatesCount: rawCandidates.length > 0
      ? candidates.length
      : fallbackCandidatesCount,

    shortCandidatesIgnored: rawCandidates.filter(isShortRow).length,

    topSymbols,
    candidates
  };
}

function normalizeRotation(rotation) {
  if (!rotation || typeof rotation !== 'object') {
    return null;
  }

  const rawMicroFamilies = Array.isArray(rotation.microFamilies)
    ? rotation.microFamilies
    : [];

  const microFamilies = rawMicroFamilies
    .filter(isLongRow)
    .map(normalizeLongSide);

  const rowIds = microFamilies
    .map((row) => getMicroFamilyId(row))
    .filter(Boolean);

  const explicitIds = uniqueStrings([
    ...(Array.isArray(rotation.microFamilyIds) ? rotation.microFamilyIds : []),
    ...(Array.isArray(rotation.activeMicroFamilyIds) ? rotation.activeMicroFamilyIds : []),
    ...(Array.isArray(rotation.trueMicroFamilyIds) ? rotation.trueMicroFamilyIds : []),
    ...(Array.isArray(rotation.ids) ? rotation.ids : [])
  ]).filter(isAllowedLongId);

  const microFamilyIds = uniqueStrings([
    ...explicitIds,
    ...rowIds
  ]);

  const macroFamilyIds = uniqueStrings([
    ...(Array.isArray(rotation.macroFamilyIds) ? rotation.macroFamilyIds : []),
    ...(Array.isArray(rotation.activeMacroFamilyIds) ? rotation.activeMacroFamilyIds : []),
    ...(Array.isArray(rotation.macroIds) ? rotation.macroIds : []),
    ...microFamilies.map(getMacroFamilyId)
  ]).filter(isAllowedLongId);

  const bestLongRaw =
    rotation.bestLong ||
    microFamilies.find((row) => isLongRow(row)) ||
    null;

  const bestLong = bestLongRaw
    ? normalizeLongSide(bestLongRaw)
    : null;

  return {
    ...rotation,
    ...modeFlags(),

    sideMode: 'long_only',

    manualOnly: true,
    adminSelected: rotation.adminSelected === true || rotation.manualOnly === true,
    autoRotation: false,
    autoActivationDisabled: true,
    liveSelectable: Boolean(rotation.liveSelectable && microFamilyIds.length > 0),

    bestLong,
    bestShort: null,

    microFamilyIds,
    activeMicroFamilyIds: microFamilyIds,
    trueMicroFamilyIds: microFamilyIds,

    macroFamilyIds,
    activeMacroFamilyIds: macroFamilyIds,

    microFamilies,

    count: microFamilyIds.length || microFamilies.length,

    rawMicroFamiliesCount: rawMicroFamilies.length,
    shortMicroFamiliesIgnored: rawMicroFamilies.filter(isShortRow).length,

    missingSides: microFamilyIds.length || microFamilies.length
      ? []
      : [TARGET_TRADE_SIDE]
  };
}

function actionIsLearningVirtual(action = {}) {
  return Boolean(
    action.virtualOnly !== false ||
    action.virtualTracked !== false ||
    action.shadowOnly !== false ||
    action.learningOnly ||
    action.observationOnly ||
    action.analysisInputOnly ||
    action.source === 'VIRTUAL' ||
    action.source === 'SHADOW' ||
    action.shadowResult ||
    action.reason === 'LONG_RISK_INVALID' ||
    action.reason === 'RISK_ENGINE_EMPTY_LONG_RISK_OBSERVATION_ONLY'
  );
}

function normalizeTradeAction(action = {}) {
  return normalizeLongSide({
    ...action,

    source: action.source || 'VIRTUAL',

    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: true,
    learningOnly: true,
    realOrderPlaced: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    scannerScore: action.scannerScore ?? action.moveScore ?? null,

    learningAction: actionIsLearningVirtual(action),
    discordAlertEligible: Boolean(action.discordAlertEligible),
    selectedMicroFamilyAlert: Boolean(action.selectedMicroFamilyAlert),
    discordAlertSent: Boolean(action.discordAlertSent)
  });
}

function buildActionCounts(actions = []) {
  return actions.reduce((acc, row) => {
    const key = row?.action || row?.type || 'UNKNOWN';

    acc[key] = (acc[key] || 0) + 1;

    return acc;
  }, {});
}

function buildTradeSummary(tradeMeta) {
  if (!tradeMeta || typeof tradeMeta !== 'object') {
    return {
      lastRunAt: null,
      actionCounts: {},

      actions: 0,
      learningActions: 0,

      virtualEntries: 0,
      virtualWaits: 0,
      virtualExits: 0,
      shadowExits: 0,

      discordEligibleActions: 0,
      selectedMicroFamilyActions: 0,
      discordAlertsSent: 0,

      skippedNewEntries: null,
      reason: null,
      skipReason: null,

      ...modeFlags()
    };
  }

  const rawActions = Array.isArray(tradeMeta.actions)
    ? tradeMeta.actions
    : [];

  const rawLongActions = filterLongRows(rawActions);
  const allLongActions = rawLongActions.map(normalizeTradeAction);
  const learningActions = allLongActions.filter((row) => row.learningAction || row.virtualOnly || row.shadowOnly);
  const shortActionsIgnored = rawActions.filter(isShortRow).length;

  const entries = allLongActions.filter((row) => (
    row.action === 'ENTRY' ||
    row.action === 'VIRTUAL_ENTRY'
  ));

  const waits = allLongActions.filter((row) => row.action === 'WAIT');

  const exitArrays = [
    ...(Array.isArray(tradeMeta.exits) ? tradeMeta.exits : []),
    ...(Array.isArray(tradeMeta.virtualExits) ? tradeMeta.virtualExits : []),
    ...(Array.isArray(tradeMeta.realExits) ? tradeMeta.realExits : []),
    ...(Array.isArray(tradeMeta.shadowExits) ? tradeMeta.shadowExits : []),
    ...(Array.isArray(tradeMeta.outcomes) ? tradeMeta.outcomes : [])
  ];

  const virtualExits = filterLongRows(exitArrays).map((row) => normalizeLongSide({
    ...row,
    source: row.source || 'VIRTUAL',
    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: true,
    learningOnly: true,
    realOrderPlaced: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false
  }));

  const shadowExits = filterLongRows(
    Array.isArray(tradeMeta.shadowExits) ? tradeMeta.shadowExits : []
  ).map((row) => normalizeLongSide({
    ...row,
    source: row.source || 'VIRTUAL',
    shadowOnly: true,
    virtualOnly: true
  }));

  const discordEligibleActions = allLongActions.filter((row) => row.discordAlertEligible);
  const selectedMicroFamilyActions = allLongActions.filter((row) => row.selectedMicroFamilyAlert);
  const discordAlertsSent = allLongActions.filter((row) => row.discordAlertSent);

  return {
    lastRunAt: tradeMeta.completedAt || tradeMeta.startedAt || tradeMeta.ts || null,
    durationMs: tradeMeta.durationMs ?? null,

    runId: tradeMeta.runId || null,
    snapshotId: tradeMeta.snapshotId || null,
    snapshotAgeSec: tradeMeta.snapshotAgeSec ?? null,

    ...modeFlags(),

    actionCounts: buildActionCounts(allLongActions),
    rawActionCounts: tradeMeta.actionCounts || buildActionCounts(rawActions),
    learningActionCounts: buildActionCounts(learningActions),

    actions: allLongActions.length,
    rawActions: rawActions.length,
    allLongActions: allLongActions.length,
    learningActions: learningActions.length,
    shortActionsIgnored,

    virtualEntries: entries.length,
    virtualWaits: waits.length,
    virtualExits: virtualExits.length,
    shadowExits: shadowExits.length,

    entries: entries.length,
    waits: waits.length,
    exits: virtualExits.length,

    entryRows: entries,
    waitRows: waits,
    virtualCreatedRows: entries,
    virtualExitsRows: virtualExits,
    shadowExitsRows: shadowExits,

    discordEligibleActions: discordEligibleActions.length,
    selectedMicroFamilyActions: selectedMicroFamilyActions.length,
    discordAlertsSent: discordAlertsSent.length,

    skippedNewEntries: Boolean(tradeMeta.skippedNewEntries),
    reason: tradeMeta.reason || tradeMeta.skipReason || null,
    skipReason: tradeMeta.skipReason || tradeMeta.reason || null,

    activeRotationId: tradeMeta.activeRotationId || null,
    activeMicroFamilies: tradeMeta.activeMicroFamilies ?? null,

    entriesSymbols: entries
      .map((row) => row.symbol || row.contractSymbol)
      .filter(Boolean)
      .slice(0, 20),

    exitSymbols: virtualExits
      .map((row) => row.symbol || row.contractSymbol)
      .filter(Boolean)
      .slice(0, 20)
  };
}

function compactRotationDashboard(rotationDashboard = {}) {
  const active = normalizeRotation(
    rotationDashboard.active ||
    rotationDashboard.activeRotation ||
    null
  );

  const nextRaw =
    rotationDashboard.next ||
    rotationDashboard.nextRotation ||
    null;

  const next = normalizeRotation(nextRaw);

  const activeRows = filterLongRows(rotationDashboard.activeRows || []).map(normalizeLongSide);
  const nextRows = filterLongRows(rotationDashboard.nextRows || []).map((row) => normalizeLongSide({
    ...row,
    autoActivationDisabled: true
  }));

  return {
    ...rotationDashboard,
    ...modeFlags(),

    active,
    next,
    activeRotation: active,
    nextRotation: next,

    activeRows,
    nextRows,

    activeCount: active?.count || activeRows.length || 0,
    nextCount: next?.count || nextRows.length || 0,

    activeMicroFamilyIds: active?.microFamilyIds || [],
    nextMicroFamilyIds: next?.microFamilyIds || [],

    activeMacroFamilyIds: active?.macroFamilyIds || active?.activeMacroFamilyIds || [],
    nextMacroFamilyIds: next?.macroFamilyIds || next?.activeMacroFamilyIds || [],

    bestLong: active?.bestLong || null,
    bestShort: null,

    nextBestLong: next?.bestLong || null,
    nextBestShort: null,

    missingSides: active?.missingSides || [],
    nextMissingSides: next?.missingSides || [],

    autoRotationActivationDisabled: true
  };
}

function normalizePosition(position = {}) {
  const entry = num(position.entry ?? position.entryPrice, 0);
  const sl = num(position.sl ?? position.stopLoss ?? position.initialSl, 0);
  const tp = num(position.tp ?? position.takeProfit, 0);
  const initialSl = num(position.initialSl ?? position.sl ?? position.stopLoss, sl);
  const currentPrice = num(position.currentPrice ?? position.lastPrice, 0);
  const risk = entry > 0 && initialSl < entry
    ? entry - initialSl
    : 0;

  const currentR = risk > 0 && currentPrice > 0
    ? (currentPrice - entry) / risk
    : null;

  return normalizeLongSide({
    ...position,

    source: position.source || 'VIRTUAL',

    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: true,

    realOrderPlaced: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    entry,
    sl,
    tp,
    initialSl,

    validLongRiskShape: entry > 0 && sl < entry && tp > entry,

    currentPrice: currentPrice || null,
    lastPrice: currentPrice || null,

    ageSec: position.ageSec ?? null,
    currentR: position.currentR ?? currentR,
    mfeR: position.mfeR ?? null,
    maeR: position.maeR ?? null,

    reachedHalfR: Boolean(position.reachedHalfR),
    reachedOneR: Boolean(position.reachedOneR),
    nearTpSeen: Boolean(position.nearTpSeen),

    tpExitArmed: currentPrice > 0 && tp > 0 && currentPrice >= tp,
    slExitArmed: currentPrice > 0 && sl > 0 && currentPrice <= sl,
    timeStopExitArmed: Boolean(position.timeStopExitArmed),

    selectedMicroFamily: Boolean(
      position.selectedMicroFamily ||
      position.selectedMicroFamilyAlert
    ),
    discordAlertEligible: Boolean(position.discordAlertEligible),
    selectedMicroFamilyAlert: Boolean(position.selectedMicroFamilyAlert),
    discordEntryAlertSent: Boolean(position.discordEntryAlertSent),
    discordExitAlertEligible: Boolean(position.discordExitAlertEligible),
    discordExitAlertSent: Boolean(position.discordExitAlertSent)
  });
}

function buildPositionSummary(rawPositions = []) {
  const positions = filterLongRows(rawPositions).map(normalizePosition);
  const ignoredShortPositions = rawPositions.filter(isShortRow).length;
  const unknownPositions = rawPositions.filter((row) => inferTradeSide(row) === 'UNKNOWN').length;

  return {
    positions,
    positionsCount: positions.length,
    rawPositionsCount: rawPositions.length,
    ignoredShortPositions,
    unknownPositionsTreatedAsLong: unknownPositions,
    ignoredUnknownPositions: 0,

    virtualPositions: positions.length,
    selectedPositions: positions.filter((row) => row.selectedMicroFamily || row.selectedMicroFamilyAlert).length,
    discordEntryAlertSentPositions: positions.filter((row) => row.discordEntryAlertSent).length,
    discordExitAlertEligiblePositions: positions.filter((row) => row.discordExitAlertEligible).length
  };
}

function normalizeDiscordLog(row = {}) {
  const payload = safeObject(row.payload);
  const result = safeObject(row.result || payload.result);
  const rawInferredTradeSide = inferTradeSide({
    ...row,
    ...payload,
    ...result,
    microFamilyId: row.microFamilyId || payload.microFamilyId || result.microFamilyId,
    trueMicroFamilyId: row.trueMicroFamilyId || payload.trueMicroFamilyId || result.trueMicroFamilyId
  });

  const selectedMicroFamilyAlert = Boolean(
    row.selectedMicroFamilyAlert ||
    payload.selectedMicroFamilyAlert ||
    result.selectedMicroFamilyAlert ||
    row.alertAllowed ||
    payload.alertAllowed ||
    result.alertAllowed
  );

  const discordAlertEligible = Boolean(
    row.discordAlertEligible ||
    payload.discordAlertEligible ||
    result.discordAlertEligible
  );

  const trueMicroFamilyId =
    row.trueMicroFamilyId ||
    payload.trueMicroFamilyId ||
    result.trueMicroFamilyId ||
    row.microFamilyId ||
    payload.microFamilyId ||
    result.microFamilyId ||
    null;

  return {
    ...row,
    payload,
    result,

    type: row.type || payload.type || result.type || row.level || payload.level || 'UNKNOWN',

    rawInferredTradeSide,

    symbol:
      row.symbol ||
      payload.symbol ||
      payload.contractSymbol ||
      result.symbol ||
      result.contractSymbol ||
      null,

    microFamilyId: trueMicroFamilyId,
    trueMicroFamilyId,

    familyId:
      row.familyId ||
      payload.familyId ||
      result.familyId ||
      null,

    macroFamilyId:
      row.macroFamilyId ||
      row.parentMacroFamilyId ||
      payload.macroFamilyId ||
      payload.parentMacroFamilyId ||
      result.macroFamilyId ||
      result.parentMacroFamilyId ||
      null,

    discordAlertEligible,
    selectedMicroFamilyAlert,

    selectedOnly: selectedMicroFamilyAlert,

    manualSelectionRequired: true,
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    alertAllowed: selectedMicroFamilyAlert,

    sent: Boolean(
      row.sent ||
      payload.sent ||
      result.sent ||
      result.ok === true
    ),

    failed: Boolean(
      row.failed ||
      payload.failed ||
      result.failed ||
      result.ok === false
    ),

    skipped: Boolean(
      row.skipped ||
      payload.skipped ||
      result.skipped
    ),

    source:
      row.source ||
      payload.source ||
      result.source ||
      null,

    ts:
      row.ts ||
      row.createdAt ||
      payload.ts ||
      payload.createdAt ||
      result.ts ||
      result.createdAt ||
      null
  };
}

function summarizeDiscordLogs(logs = []) {
  const normalized = logs
    .map(normalizeDiscordLog)
    .filter((log) => log.rawInferredTradeSide !== OPPOSITE_TRADE_SIDE);

  return normalized.reduce((acc, log) => {
    const type = upper(log.type || 'UNKNOWN');

    acc.total += 1;
    acc.byType[type] = (acc.byType[type] || 0) + 1;

    if (log.discordAlertEligible) acc.eligible += 1;
    if (log.selectedOnly || log.selectedMicroFamilyAlert) acc.selectedOnly += 1;
    if (log.sent) acc.sent += 1;
    if (log.failed) acc.failed += 1;
    if (log.skipped) acc.skipped += 1;

    return acc;
  }, {
    total: 0,
    eligible: 0,
    selectedOnly: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    byType: {}
  });
}

async function safeRead(label, fn, fallback) {
  try {
    const value = await fn();

    return {
      ok: true,
      label,
      value
    };
  } catch (error) {
    return {
      ok: false,
      label,
      value: fallback,
      error: error?.message || String(error)
    };
  }
}

export default async function handler(req, res) {
  const startedAt = now();

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Overview-Mode', 'long-only-persistent-virtual-learning-v3');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Long-Only', 'true');
  res.setHeader('X-Short-Disabled', 'true');
  res.setHeader('X-Virtual-Only', 'true');
  res.setHeader('X-Virtual-Learning-Forced', 'true');
  res.setHeader('X-Net-Outcomes-Only', 'true');
  res.setHeader('X-Manual-Selection-Only', 'true');
  res.setHeader('X-Manual-Selection-Match-Mode', 'EXACT_TRUE_MICRO_FAMILY_ID');
  res.setHeader('X-Real-Orders-Disabled', 'true');
  res.setHeader('X-Bitget-Orders-Disabled', 'true');
  res.setHeader('X-Persistent-Learning-Key', PERSISTENT_LEARNING_KEY);
  res.setHeader('X-Week-Reset-Disabled', 'true');
  res.setHeader('X-Redis-Namespace', LONG_NAMESPACE);
  res.setHeader('X-Short-Root-Touched', 'false');

  if (req.method !== 'GET') {
    return methodNotAllowed(res);
  }

  try {
    const durable = getDurableRedis();
    const volatile = getVolatileRedis();

    const weekKey = PERSISTENT_LEARNING_KEY;
    const currentWeekKey = PERSISTENT_LEARNING_KEY;
    const previousWeekKey = PERSISTENT_LEARNING_KEY;

    const [
      latestScanRead,
      tradeMetaRead,
      positionsRead,
      currentMicrosRead,
      previousMicrosRead,
      rotationRead,
      discordLogsRead
    ] = await Promise.all([
      safeRead(
        'latestScan',
        () => getJson(volatile, LONG_KEYS.scan.latest, null),
        null
      ),

      safeRead(
        'tradeMeta',
        () => getJson(durable, LONG_KEYS.trade.runMeta, null),
        null
      ),

      safeRead(
        'openPositions',
        () => getOpenPositions({
          tradeSide: TARGET_TRADE_SIDE,
          side: TARGET_DASHBOARD_SIDE,
          namespace: LONG_NAMESPACE,
          keyPrefix: LONG_KEY_PREFIX,
          virtualOnly: true
        }),
        []
      ),

      safeRead(
        'persistentLearningMicros',
        () => getWeekMicros(PERSISTENT_LEARNING_KEY),
        {}
      ),

      safeRead(
        'previousWeekMicrosDisabledPersistentLearning',
        () => getWeekMicros(PERSISTENT_LEARNING_KEY),
        {}
      ),

      safeRead(
        'rotationDashboard',
        () => getRotationDashboard({
          tradeSide: TARGET_TRADE_SIDE,
          side: TARGET_DASHBOARD_SIDE,
          weekKey: PERSISTENT_LEARNING_KEY,
          namespace: LONG_NAMESPACE,
          keyPrefix: LONG_KEY_PREFIX
        }),
        {
          active: null,
          next: null,
          validFrom: null,
          activeRows: [],
          nextRows: [],
          activeCount: 0,
          nextCount: 0
        }
      ),

      safeRead(
        'discordLogs',
        () => readJsonLogs(durable, LONG_KEYS.discord.logList, 10),
        []
      )
    ]);

    const latestScan = normalizeLatestScan(latestScanRead.value);
    const tradeMeta = tradeMetaRead.value || null;
    const tradeSummary = buildTradeSummary(tradeMeta);

    const rawPositions = asArray(positionsRead.value);
    const positionSummary = buildPositionSummary(rawPositions);

    const currentMicros = currentMicrosRead.value || {};
    const previousMicros = previousMicrosRead.value || {};

    const currentMicroSummary = summarizeMicros(currentMicros);
    const previousMicroSummary = summarizeMicros(previousMicros);

    const rawRotationDashboard = rotationRead.value || {};
    const rotationDashboard = compactRotationDashboard(rawRotationDashboard);

    const activeRotation = rotationDashboard.active || null;
    const nextRotation = rotationDashboard.next || null;

    const rawDiscordLogs = Array.isArray(discordLogsRead.value)
      ? discordLogsRead.value
      : [];

    const discordLogs = rawDiscordLogs
      .map(normalizeDiscordLog)
      .filter((log) => log.rawInferredTradeSide !== OPPOSITE_TRADE_SIDE)
      .map((log) => normalizeLongSide(log));

    const warnings = [
      latestScanRead,
      tradeMetaRead,
      positionsRead,
      currentMicrosRead,
      previousMicrosRead,
      rotationRead,
      discordLogsRead
    ]
      .filter((row) => !row.ok)
      .map((row) => ({
        source: row.label,
        error: row.error
      }));

    const shortIgnored = {
      positions: positionSummary.ignoredShortPositions,
      currentWeekMicroFamilies: countShortMapOrArray(currentMicros),
      previousWeekMicroFamilies: countShortMapOrArray(previousMicros),
      scannerCandidates: latestScan?.shortCandidatesIgnored || 0,
      tradeActions: tradeSummary.shortActionsIgnored || 0,
      discordLogs: rawDiscordLogs.filter((row) => inferTradeSide(normalizeDiscordLog(row)) === OPPOSITE_TRADE_SIDE).length,
      activeRotationRows: activeRotation?.shortMicroFamiliesIgnored || 0,
      nextRotationRows: nextRotation?.shortMicroFamiliesIgnored || 0
    };

    return res.status(200).json({
      ok: true,
      ...modeFlags(),

      weekKey,
      currentWeekKey: weekKey,
      previousWeekKey,

      persistentLearningKey: PERSISTENT_LEARNING_KEY,
      requestedLearningKey: PERSISTENT_LEARNING_KEY,
      activeLearningStoreKey: `${LONG_KEY_PREFIX}ANALYZE:WEEK:${PERSISTENT_LEARNING_KEY}:MICROS`,
      weekResetDisabled: true,
      isoWeekLearningDisabled: true,
      previousWeekComparisonDisabled: true,

      longKeys: {
        namespace: LONG_NAMESPACE,
        prefix: LONG_KEY_PREFIX,
        scanLatest: LONG_KEYS.scan.latest,
        tradeRunMeta: LONG_KEYS.trade.runMeta,
        discordLogList: LONG_KEYS.discord.logList
      },

      latestScan,
      latestScannerSnapshotId: latestScan?.snapshotId || null,

      scannerCandidates: latestScan?.candidatesCount || 0,
      longScannerCandidates: latestScan?.longCandidatesCount || latestScan?.candidatesCount || 0,

      tradeMeta,
      tradeSummary,

      runMeta: tradeMeta,
      latestRunMeta: tradeMeta
        ? {
          runId: tradeMeta.runId || null,
          shadowExits: tradeMeta.shadowExits || [],
          virtualExits: tradeMeta.virtualExits || tradeMeta.exits || [],
          actionCounts: tradeSummary.actionCounts || {},
          skipReason: tradeSummary.skipReason || null
        }
        : null,

      openPositions: positionSummary.positionsCount,
      positionsCount: positionSummary.positionsCount,
      rawPositionsCount: positionSummary.rawPositionsCount,

      virtualPositions: positionSummary.virtualPositions,
      selectedPositions: positionSummary.selectedPositions,

      ignoredShortPositions: positionSummary.ignoredShortPositions,
      ignoredUnknownPositions: positionSummary.ignoredUnknownPositions,
      unknownPositionsTreatedAsLong: positionSummary.unknownPositionsTreatedAsLong,

      positions: positionSummary.positions,

      currentWeekMicroFamilies: currentMicroSummary.rows,
      previousWeekMicroFamilies: previousMicroSummary.rows,

      persistentMicroFamilies: currentMicroSummary.rows,
      persistentMicroSummary: currentMicroSummary,

      currentMicroSummary,
      previousMicroSummary,

      observingMicroFamilies: currentMicroSummary.observationOnlyFamilies,
      completedMicroFamilies: currentMicroSummary.completedFamilies,

      activeRotation,
      nextRotation,

      activeRotationId: activeRotation?.rotationId || null,
      nextRotationId: nextRotation?.rotationId || null,

      activeRotationCount: activeRotation?.count || 0,
      nextRotationCount: nextRotation?.count || 0,

      activeMicroFamilyIds: activeRotation?.microFamilyIds || [],
      nextMicroFamilyIds: nextRotation?.microFamilyIds || [],

      activeMacroFamilyIds: activeRotation?.macroFamilyIds || [],
      nextMacroFamilyIds: nextRotation?.macroFamilyIds || [],

      bestLong: activeRotation?.bestLong || null,
      bestShort: null,
      nextBestLong: nextRotation?.bestLong || null,
      nextBestShort: null,

      rotationDashboard,

      discordLogs,
      discordSummary: summarizeDiscordLogs(discordLogs),

      shortIgnored,
      warnings,

      perf: {
        durationMs: now() - startedAt,
        source: 'long_only_persistent_virtual_learning_overview'
      },

      serverTs: Date.now()
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      ...modeFlags(),

      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}