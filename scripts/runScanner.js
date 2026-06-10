// ================= FILE: scripts/runScanner.js =================

import { runScanner } from '../src/market/scanner.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';

const MIN_COMPLETED_ACTIVE_LEARNING = 20;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;

function now() {
  return Date.now();
}

function argv() {
  return process.argv.slice(2);
}

function getArgValue(name) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));

  if (!match) return null;

  return match.slice(prefix.length).trim() || null;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function isTrue(value) {
  if (value === true || value === 1) return true;

  const raw = String(value ?? '').trim().toLowerCase();

  return ['true', '1', 'yes', 'y', 'on', 'force', 'forced'].includes(raw);
}

function baseFlags() {
  return {
    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_DASHBOARD_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    scannerSide: TARGET_DASHBOARD_SIDE,
    actualScannerSide: TARGET_DASHBOARD_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    scannerOnly: true,
    scannerDecidesTrade: false,
    scannerDoesNotTrade: true,
    scannerDoesNotSelectMicroFamilies: true,
    scannerDoesNotSendDiscord: true,

    noTradeExecution: true,
    noMicroFamilySelection: true,
    noDiscord: true,

    virtualLearning: true,
    virtualLearningForced: true,
    virtualOnly: true,
    virtualTracked: true,

    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,

    observationFirst: true,
    observationFirstAnalyze: true,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    exactTrueMicroFamilyRequired: true,
    symbolExcludedFromFamilyId: true,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    statusRules: {
      OBSERVING: 'completed == 0',
      EARLY_OUTCOMES: `completed > 0 && completed < ${MIN_COMPLETED_ACTIVE_LEARNING}`,
      ACTIVE_LEARNING: `completed >= ${MIN_COMPLETED_ACTIVE_LEARNING}`
    },

    defaultRanking: 'dashboardBalancedScore|balancedScore|fairWinrate',
    bareWinrateRankingDisabled: true,

    globalMaxOpenPositionsBlockDisabled: true,
    maxOneOpenPositionPerSymbol: true,
    positionTimeStopMinDefault: DEFAULT_POSITION_TIME_STOP_MIN,

    validLongRiskShape: 'entry > 0 && sl < entry && tp > entry',
    longGrossRFormula: '(exitPrice - entry) / (entry - initialSl)',
    longCurrentRFormula: '(currentPrice - entry) / (entry - initialSl)',
    outcomeSource: 'VIRTUAL',

    bucketGranularity: 'LOW_MID_HIGH',
    bucketsCoarseOnly: true,

    manualSelectionOnly: true,
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForExactTrueMicroMatch: true,

    resetCronDisabled: true,
    activateFreezeCronDisabled: true,

    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    redisKeysSeparatedFromShortRoot: true,
    shortRootTouched: false
  };
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
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

function normalizeTradeSide(value) {
  const raw = cleanSideText(value);

  if (['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'UPSIDE'].includes(raw)) {
    return TARGET_TRADE_SIDE;
  }

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE'].includes(raw)) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function hasShortSignal(value = '') {
  const text = cleanSideText(value);

  return (
    text.includes('MICRO_SHORT_') ||
    text.includes('TRADESIDE=SHORT') ||
    text.includes('TRADE_SIDE=SHORT') ||
    text.includes('POSITION_SIDE=SHORT') ||
    text.includes('POSITIONSIDE=SHORT') ||
    text.includes('SIDE=SHORT') ||
    text.includes('SIDE=BEAR') ||
    text.includes('SIDE=SELL') ||
    text.includes('DIRECTION=SHORT') ||
    text.includes('DIRECTION=BEAR') ||
    text.includes('DIRECTION=SELL') ||
    text.startsWith('SHORT_') ||
    text.includes('_SHORT_') ||
    text.endsWith('_SHORT') ||
    text.startsWith('BEAR_') ||
    text.includes('_BEAR_') ||
    text.endsWith('_BEAR') ||
    text.startsWith('SELL_') ||
    text.includes('_SELL_') ||
    text.endsWith('_SELL') ||
    text.includes('|SHORT|') ||
    text.includes('|BEAR|') ||
    text.includes('|SELL|') ||
    text.includes(':SHORT') ||
    text.includes(':BEAR') ||
    text.includes(':SELL') ||
    text.includes('=SHORT') ||
    text.includes('=BEAR') ||
    text.includes('=SELL') ||
    text.includes('DOWNSIDE')
  );
}

function hasLongSignal(value = '') {
  const text = cleanSideText(value);

  return (
    text.includes('MICRO_LONG_') ||
    text.includes('TRADESIDE=LONG') ||
    text.includes('TRADE_SIDE=LONG') ||
    text.includes('POSITION_SIDE=LONG') ||
    text.includes('POSITIONSIDE=LONG') ||
    text.includes('SIDE=LONG') ||
    text.includes('SIDE=BULL') ||
    text.includes('SIDE=BUY') ||
    text.includes('DIRECTION=LONG') ||
    text.includes('DIRECTION=BULL') ||
    text.includes('DIRECTION=BUY') ||
    text.startsWith('LONG_') ||
    text.includes('_LONG_') ||
    text.endsWith('_LONG') ||
    text.startsWith('BULL_') ||
    text.includes('_BULL_') ||
    text.endsWith('_BULL') ||
    text.startsWith('BUY_') ||
    text.includes('_BUY_') ||
    text.endsWith('_BUY') ||
    text.includes('|LONG|') ||
    text.includes('|BULL|') ||
    text.includes('|BUY|') ||
    text.includes(':LONG') ||
    text.includes(':BULL') ||
    text.includes(':BUY') ||
    text.includes('=LONG') ||
    text.includes('=BULL') ||
    text.includes('=BUY') ||
    text.includes('UPSIDE')
  );
}

function inferTradeSideFromText(value) {
  const text = cleanSideText(value);

  if (!text) return 'UNKNOWN';

  const direct = normalizeTradeSide(text);

  if (direct === TARGET_TRADE_SIDE || direct === OPPOSITE_TRADE_SIDE) {
    return direct;
  }

  const longHit = hasLongSignal(text);
  const shortHit = hasShortSignal(text);

  if (longHit && !shortHit) return TARGET_TRADE_SIDE;
  if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;

  if (longHit && shortHit) {
    if (text.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
    if (text.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
    if (text.includes('TRADE_SIDE=LONG') || text.includes('TRADESIDE=LONG')) return TARGET_TRADE_SIDE;
    if (text.includes('TRADE_SIDE=SHORT') || text.includes('TRADESIDE=SHORT')) return OPPOSITE_TRADE_SIDE;

    return TARGET_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function getDefinitionHaystack(row = {}) {
  return [
    row.familyId,
    row.family,
    row.baseFamilyId,

    row.microFamilyId,
    row.trueMicroFamilyId,
    row.coarseMicroFamilyId,
    row.baseMicroFamilyId,
    row.legacyMicroFamilyId,
    row.liveMicroFamilyId,
    row.realMicroFamilyId,
    row.executionMicroFamilyId,
    row.id,
    row.key,

    row.macroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId,
    row.parentFamilyId,
    row.macroId,

    row.definition,
    row.microDefinition,
    row.macroDefinition,
    row.parentDefinition,

    row.scannerReason,
    row.reason,
    row.signalReason,
    row.actionReason,
    row.rejectionReason,

    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts : []),
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : []),
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : [])
  ]
    .map((value) => cleanSideText(value))
    .filter(Boolean)
    .join('|');
}

function inferTradeSide(row = {}) {
  if (typeof row === 'string') {
    return inferTradeSideFromText(row);
  }

  if (!row || typeof row !== 'object') {
    return 'UNKNOWN';
  }

  const direct = normalizeTradeSide(
    row.tradeSide ||
    row.positionSide ||
    row.direction ||
    row.scannerSide ||
    row.actualScannerSide ||
    row.analysisSide ||
    row.signalSide ||
    row.entrySide ||
    row.side ||
    row.bias ||
    row.marketBias
  );

  if (direct === TARGET_TRADE_SIDE || direct === OPPOSITE_TRADE_SIDE) {
    return direct;
  }

  const reasonSide = inferTradeSideFromText(
    [
      row.scannerReason,
      row.reason,
      row.signalReason,
      row.actionReason,
      row.rejectionReason
    ]
      .map((value) => cleanSideText(value))
      .filter(Boolean)
      .join('|')
  );

  if (reasonSide === TARGET_TRADE_SIDE || reasonSide === OPPOSITE_TRADE_SIDE) {
    return reasonSide;
  }

  const haystackSide = inferTradeSideFromText(getDefinitionHaystack(row));

  if (haystackSide === TARGET_TRADE_SIDE || haystackSide === OPPOSITE_TRADE_SIDE) {
    return haystackSide;
  }

  if (row.longOnly === true || row.shortDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  if (row.shortOnly === true || row.longDisabled === true) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function isLongCandidate(row = {}) {
  return inferTradeSide(row) === TARGET_TRADE_SIDE;
}

function isShortCandidate(row = {}) {
  return inferTradeSide(row) === OPPOSITE_TRADE_SIDE;
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);

  return Number.isFinite(n) ? n : fallback;
}

function normalizeBaseSymbol(value = '') {
  let symbol = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

  const suffixes = [
    'USDTUMCBL',
    'USDCUMCBL',
    'USDTPERP',
    'USDCPERP',
    'USDT',
    'USDC',
    'BUSD',
    'PERP',
    'SWAP',
    'USD'
  ];

  for (const suffix of suffixes) {
    if (symbol.endsWith(suffix) && symbol.length > suffix.length) {
      symbol = symbol.slice(0, -suffix.length);
      break;
    }
  }

  return symbol;
}

function normalizeContractSymbol(value = '') {
  const raw = String(value || '').trim().toUpperCase();

  if (!raw) return '';

  if (raw.endsWith('USDT')) return raw;

  return `${normalizeBaseSymbol(raw)}USDT`;
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

function scannerMetadataFrom(candidate = {}) {
  const ids = [
    candidate.scannerMicroFamilyId,
    candidate.scannerFamilyId,
    candidate.microFamilyId,
    candidate.trueMicroFamilyId,
    candidate.familyId,
    candidate.baseFamilyId,
    candidate.id,
    candidate.key
  ].filter(Boolean);

  const scannerId = ids.find(isScannerFingerprintId) || null;

  return {
    scannerMicroFamilyId: candidate.scannerMicroFamilyId || scannerId,
    scannerFamilyId: candidate.scannerFamilyId || null,
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintOnlyMetadata: Boolean(scannerId),
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false
  };
}

function normalizeLongCandidate(candidate = {}) {
  const symbol = normalizeBaseSymbol(
    candidate.symbol ||
    candidate.baseSymbol ||
    candidate.contractSymbol ||
    candidate.instId ||
    candidate.instrumentId
  );

  const contractSymbol = normalizeContractSymbol(
    candidate.contractSymbol ||
    candidate.symbol ||
    candidate.instId ||
    candidate.instrumentId ||
    symbol
  );

  return {
    ...candidate,

    symbol,
    baseSymbol: symbol,
    contractSymbol,

    ...baseFlags(),
    ...scannerMetadataFrom(candidate),

    directionalSide: TARGET_DASHBOARD_SIDE,
    inferredDirectionalSide: TARGET_DASHBOARD_SIDE,
    marketSide: TARGET_DASHBOARD_SIDE,

    scannerScore: safeNumber(candidate.scannerScore ?? candidate.moveScore, 0),
    moveScore: safeNumber(candidate.moveScore ?? candidate.scannerScore, 0),

    change1h: safeNumber(candidate.change1h ?? candidate.priceChange1hPct, 0),
    change24h: safeNumber(candidate.change24h ?? candidate.priceChange24hPct, 0),
    volume24h: safeNumber(candidate.volume24h ?? candidate.quoteVolume24h ?? candidate.quoteVolume, 0),

    btcState: candidate.btcState || null,
    regime: candidate.regime || null,

    fakeBreakout: Boolean(candidate.fakeBreakout),
    fakeBreakoutRisk: Boolean(candidate.fakeBreakoutRisk),

    scannerReason: candidate.scannerReason || candidate.reason || 'LONG_SCANNER_CANDIDATE',

    createdAt: safeNumber(
      candidate.createdAt ||
      candidate.ts ||
      candidate.scannerTs ||
      now(),
      now()
    ),

    isMirrorMicroFamily: false,
    observationMirror: false,
    analysisMirror: false,
    mirrorAnalysisOnly: false,

    source: candidate.source || 'SCANNER'
  };
}

function scannerGatePassed(candidate = {}) {
  return Boolean(candidate.scannerGatePassed);
}

function isAnalyzeOnly(candidate = {}) {
  return Boolean(
    candidate.tradeDiscoveryOnly ||
    candidate.discoveryOnly ||
    candidate.analyzeOnly ||
    !scannerGatePassed(candidate)
  );
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function topSymbols(candidates = [], limit = 20) {
  return uniqueStrings(
    candidates
      .slice(0, limit)
      .map((candidate) => candidate.symbol || candidate.baseSymbol || candidate.contractSymbol)
      .filter(Boolean)
  );
}

function enforceLongOnlyPayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return payload;

  const rawCandidates = Array.isArray(payload.candidates)
    ? payload.candidates
    : [];

  const candidates = rawCandidates
    .filter(isLongCandidate)
    .map(normalizeLongCandidate)
    .filter((candidate) => candidate.symbol && candidate.contractSymbol);

  const scannerGateCandidates = candidates.filter(scannerGatePassed);
  const analyzeOnlyCandidates = candidates.filter(isAnalyzeOnly);

  const rawShortCandidatesIgnored = rawCandidates.filter(isShortCandidate).length;
  const rawUnknownSideCandidatesIgnored = rawCandidates.filter((candidate) => (
    inferTradeSide(candidate) === 'UNKNOWN'
  )).length;

  const rawScannerFingerprintCandidatesMetadataOnly = rawCandidates.filter((candidate) => (
    isScannerFingerprintId(candidate?.microFamilyId) ||
    isScannerFingerprintId(candidate?.trueMicroFamilyId) ||
    isScannerFingerprintId(candidate?.id) ||
    isScannerFingerprintId(candidate?.key)
  )).length;

  const analyze = payload.analyze && typeof payload.analyze === 'object'
    ? {
      ...payload.analyze,
      ...baseFlags()
    }
    : payload.analyze || null;

  return {
    ...payload,

    ...baseFlags(),

    sideMode: 'LONG_ONLY',

    candidates,
    candidatesCount: candidates.length,

    longCandidatesCount: candidates.length,
    shortCandidatesCount: 0,

    scannerGateCandidatesCount: scannerGateCandidates.length,
    analyzeOnlyCandidatesCount: analyzeOnlyCandidates.length,

    rawCandidatesCount: rawCandidates.length,
    rawShortCandidatesIgnored,
    rawUnknownSideCandidatesIgnored,
    rawScannerFingerprintCandidatesMetadataOnly,

    bullCandidates: candidates.length,
    bearCandidates: 0,

    topSymbols: topSymbols(candidates),
    scannerGateSymbols: topSymbols(scannerGateCandidates),
    analyzeOnlySymbols: topSymbols(analyzeOnlyCandidates),

    analyze
  };
}

function normalizeResult(rawResult = {}) {
  if (!rawResult || typeof rawResult !== 'object') {
    return rawResult;
  }

  if (Array.isArray(rawResult.candidates)) {
    return enforceLongOnlyPayload(rawResult);
  }

  if (rawResult.result && typeof rawResult.result === 'object') {
    return {
      ...rawResult,
      ...baseFlags(),
      result: normalizeResult(rawResult.result)
    };
  }

  return {
    ...rawResult,
    ...baseFlags()
  };
}

function unwrapPayload(result) {
  if (!result) return null;

  if (Array.isArray(result.candidates)) return result;
  if (Array.isArray(result.result?.candidates)) return result.result;
  if (Array.isArray(result.result?.result?.candidates)) return result.result.result;
  if (Array.isArray(result.result?.result?.result?.candidates)) return result.result.result.result;

  if (result.result?.result?.result) return result.result.result.result;
  if (result.result?.result) return result.result.result;
  if (result.result) return result.result;

  return result;
}

function shouldForce() {
  return (
    hasFlag('force') ||
    hasFlag('forced') ||
    isTrue(getArgValue('force')) ||
    isTrue(getArgValue('forced'))
  );
}

function isManualRun() {
  return (
    hasFlag('manual') ||
    hasFlag('force') ||
    hasFlag('forced') ||
    isTrue(getArgValue('manual')) ||
    isTrue(getArgValue('force')) ||
    isTrue(getArgValue('forced'))
  );
}

function buildScannerOptions() {
  const force = shouldForce();

  return {
    force,
    forced: force,

    source: isManualRun()
      ? 'CLI_MANUAL_SCANNER_RUN_LONG_ONLY'
      : 'CLI_SCANNER_RUN_LONG_ONLY',

    targetTradeSide: TARGET_TRADE_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    side: TARGET_DASHBOARD_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    targetScannerSide: TARGET_DASHBOARD_SIDE,

    scannerSide: TARGET_DASHBOARD_SIDE,
    actualScannerSide: TARGET_DASHBOARD_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,
    disableShort: true,

    shortOnly: false,
    longDisabled: false,

    namespace: LONG_NAMESPACE,
    keyPrefix: LONG_KEY_PREFIX,
    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,

    scannerOnly: true,
    scannerDecidesTrade: false,
    scannerDoesNotTrade: true,
    scannerDoesNotSelectMicroFamilies: true,
    scannerDoesNotSendDiscord: true,

    noTradeExecution: true,
    noMicroFamilySelection: true,
    noDiscord: true,

    virtualLearning: true,
    virtualLearningForced: true,
    virtualOnly: true,

    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,

    observationFirst: true,
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    exactTrueMicroFamilyRequired: true,
    symbolExcludedFromFamilyId: true,

    bucketGranularity: 'LOW_MID_HIGH',
    maxOneOpenPositionPerSymbol: true,
    globalMaxOpenPositionsBlockDisabled: true
  };
}

function buildSuccessPayload({
  result,
  startedAt,
  scannerOptions
}) {
  const normalizedResult = normalizeResult(result);
  const payload = unwrapPayload(normalizedResult) || {};
  const candidates = Array.isArray(payload.candidates)
    ? payload.candidates
    : [];

  const scannerGateCandidates = candidates.filter(scannerGatePassed);
  const analyzeOnlyCandidates = candidates.filter(isAnalyzeOnly);

  return {
    ok: normalizedResult?.ok !== false && payload?.ok !== false,
    skipped: Boolean(normalizedResult?.skipped || payload?.skipped),
    reason: normalizedResult?.reason || payload?.reason || null,

    source: 'CLI_RUN_SCANNER_LONG_ONLY',
    runSource: scannerOptions.source,

    argv: argv(),
    options: scannerOptions,

    ...baseFlags(),

    force: scannerOptions.force,

    persisted: payload.persisted ?? normalizedResult?.persisted ?? null,
    snapshotId: payload.snapshotId || normalizedResult?.snapshotId || null,

    candidatesCount: Number(payload.candidatesCount || candidates.length || 0),
    longCandidatesCount: Number(payload.longCandidatesCount || candidates.length || 0),
    shortCandidatesCount: 0,

    scannerGateCandidatesCount: Number(
      payload.scannerGateCandidatesCount ||
      scannerGateCandidates.length ||
      0
    ),

    analyzeOnlyCandidatesCount: Number(
      payload.analyzeOnlyCandidatesCount ||
      analyzeOnlyCandidates.length ||
      0
    ),

    rawCandidatesCount: Number(payload.rawCandidatesCount || 0),
    rawShortCandidatesIgnored: Number(payload.rawShortCandidatesIgnored || 0),
    rawUnknownSideCandidatesIgnored: Number(payload.rawUnknownSideCandidatesIgnored || 0),
    rawScannerFingerprintCandidatesMetadataOnly: Number(payload.rawScannerFingerprintCandidatesMetadataOnly || 0),

    topSymbols: Array.isArray(payload.topSymbols)
      ? payload.topSymbols
      : topSymbols(candidates),

    scannerGateSymbols: Array.isArray(payload.scannerGateSymbols)
      ? payload.scannerGateSymbols
      : topSymbols(scannerGateCandidates),

    analyzeOnlySymbols: Array.isArray(payload.analyzeOnlySymbols)
      ? payload.analyzeOnlySymbols
      : topSymbols(analyzeOnlyCandidates),

    analyze: payload.analyze || null,

    durationMs: now() - startedAt,

    result: normalizedResult
  };
}

function buildErrorPayload({
  error,
  startedAt,
  scannerOptions
}) {
  return {
    ok: false,

    source: 'CLI_RUN_SCANNER_LONG_ONLY',
    runSource: scannerOptions?.source || 'CLI_SCANNER_RUN_LONG_ONLY',

    argv: argv(),
    options: scannerOptions || null,

    ...baseFlags(),

    error: error?.message || String(error),
    stack: error?.stack,

    durationMs: now() - startedAt
  };
}

function exitCodeFromResult(result) {
  return result?.ok === false ? 1 : 0;
}

async function main() {
  const startedAt = now();
  const scannerOptions = buildScannerOptions();

  try {
    const result = await runScanner(scannerOptions);

    const response = buildSuccessPayload({
      result,
      startedAt,
      scannerOptions
    });

    console.log(JSON.stringify(response, null, 2));

    process.exitCode = exitCodeFromResult(response);
  } catch (error) {
    console.error(JSON.stringify(
      buildErrorPayload({
        error,
        startedAt,
        scannerOptions
      }),
      null,
      2
    ));

    process.exitCode = 1;
  }
}

await main();