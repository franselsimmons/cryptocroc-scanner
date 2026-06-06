// ================= FILE: scripts/runScanner.js =================

import { runScanner } from '../src/market/scanner.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

function now() {
  return Date.now();
}

function argv() {
  return process.argv.slice(2);
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function getArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeTradeSide(value) {
  const raw = upper(value);

  if (['LONG', 'BULL', 'BULLISH', 'BUY'].includes(raw)) return 'LONG';
  if (['SHORT', 'BEAR', 'BEARISH', 'SELL'].includes(raw)) return 'SHORT';

  return 'UNKNOWN';
}

function collectSideText(row = {}) {
  if (typeof row === 'string') return upper(row);

  return [
    row.tradeSide,
    row.side,
    row.positionSide,
    row.direction,
    row.signalSide,
    row.scannerSide,
    row.analysisSide,
    row.entrySide,
    row.bias,
    row.marketBias,

    row.familyId,
    row.family,
    row.baseFamilyId,

    row.microFamilyId,
    row.trueMicroFamilyId,
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

    row.scannerReason,
    row.reason,
    row.signalReason,
    row.actionReason,

    row.definition,
    row.microDefinition,
    row.macroDefinition,
    row.parentDefinition,

    ...getArray(row.definitionParts),
    ...getArray(row.microDefinitionParts),
    ...getArray(row.macroDefinitionParts),
    ...getArray(row.parentDefinitionParts)
  ]
    .map(upper)
    .filter(Boolean)
    .join('|');
}

function inferTradeSide(row = {}) {
  if (typeof row !== 'string') {
    const direct = normalizeTradeSide(
      row.tradeSide ||
      row.side ||
      row.positionSide ||
      row.direction ||
      row.signalSide ||
      row.scannerSide ||
      row.analysisSide ||
      row.entrySide ||
      row.bias ||
      row.marketBias
    );

    if (direct === 'LONG' || direct === 'SHORT') return direct;
  }

  const text = collectSideText(row);

  const longSignal = (
    text.includes('MICRO_LONG_') ||
    text.includes('TRADESIDE=LONG') ||
    text.includes('TRADE_SIDE=LONG') ||
    text.includes('SIDE=LONG') ||
    text.includes('SIDE=BULL') ||
    text.includes('DIRECTION=LONG') ||
    text.includes('DIRECTION=BULL') ||
    text.includes('SIDE=BUY') ||
    text.includes('DIRECTION=BUY') ||
    text.includes('UPSIDE') ||
    text.startsWith('LONG_') ||
    text.includes('_LONG_') ||
    text.endsWith('_LONG') ||
    text.startsWith('BULL_') ||
    text.includes('_BULL_') ||
    text.endsWith('_BULL') ||
    text.startsWith('BUY_') ||
    text.includes('_BUY_') ||
    text.endsWith('_BUY')
  );

  const shortSignal = (
    text.includes('MICRO_SHORT_') ||
    text.includes('TRADESIDE=SHORT') ||
    text.includes('TRADE_SIDE=SHORT') ||
    text.includes('SIDE=SHORT') ||
    text.includes('SIDE=BEAR') ||
    text.includes('DIRECTION=SHORT') ||
    text.includes('DIRECTION=BEAR') ||
    text.includes('SIDE=SELL') ||
    text.includes('DIRECTION=SELL') ||
    text.includes('DOWNSIDE') ||
    text.startsWith('SHORT_') ||
    text.includes('_SHORT_') ||
    text.endsWith('_SHORT') ||
    text.startsWith('BEAR_') ||
    text.includes('_BEAR_') ||
    text.endsWith('_BEAR') ||
    text.startsWith('SELL_') ||
    text.includes('_SELL_') ||
    text.endsWith('_SELL')
  );

  if (longSignal && !shortSignal) return 'LONG';
  if (shortSignal && !longSignal) return 'SHORT';

  if (longSignal) return 'LONG';
  if (shortSignal) return 'SHORT';

  return 'UNKNOWN';
}

function isTargetCandidate(row = {}) {
  return inferTradeSide(row) === TARGET_TRADE_SIDE;
}

function isOppositeCandidate(row = {}) {
  return inferTradeSide(row) === OPPOSITE_TRADE_SIDE;
}

function normalizeLongCandidate(candidate = {}) {
  return {
    ...candidate,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    targetTradeSide: TARGET_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,

    shortOnly: false,
    longDisabled: false
  };
}

function enforceLongOnlyResult(result = {}) {
  if (!result || typeof result !== 'object') return result;

  const rawCandidates = Array.isArray(result.candidates)
    ? result.candidates
    : [];

  const candidates = rawCandidates
    .filter(isTargetCandidate)
    .map(normalizeLongCandidate);

  const scannerGateCandidates = candidates.filter((candidate) => candidate.scannerGatePassed);
  const analyzeOnlyCandidates = candidates.filter((candidate) => candidate.tradeDiscoveryOnly);

  const ignoredShortCandidates = rawCandidates.filter(isOppositeCandidate).length;
  const ignoredUnknownSideCandidates = rawCandidates.filter((candidate) => (
    inferTradeSide(candidate) === 'UNKNOWN'
  )).length;

  return {
    ...result,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    longOnly: true,
    shortDisabled: true,

    shortOnly: false,
    longDisabled: false,

    candidates,
    candidatesCount: candidates.length,

    longCandidatesCount: candidates.length,
    shortCandidatesCount: 0,

    rawCandidatesCount: rawCandidates.length,
    ignoredShortCandidates,
    ignoredUnknownSideCandidates,

    scannerGateCandidatesCount: scannerGateCandidates.length,
    analyzeOnlyCandidatesCount: analyzeOnlyCandidates.length,

    topSymbols: candidates
      .slice(0, 20)
      .map((candidate) => candidate.symbol)
      .filter(Boolean),

    scannerGateSymbols: scannerGateCandidates
      .slice(0, 20)
      .map((candidate) => candidate.symbol)
      .filter(Boolean),

    stats: {
      ...(result.stats || {}),

      candidates: candidates.length,
      longCandidates: candidates.length,
      shortCandidates: 0,
      bullCandidates: candidates.length,
      bearCandidates: 0,

      rawCandidates: rawCandidates.length,
      ignoredShortCandidates,
      ignoredUnknownSideCandidates
    }
  };
}

function buildRunOptions() {
  return {
    targetTradeSide: TARGET_TRADE_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    side: TARGET_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,
    disableShort: true,

    shortOnly: false,
    longDisabled: false
  };
}

function buildSuccessPayload({
  result,
  startedAt
}) {
  const normalizedResult = enforceLongOnlyResult(result);

  return {
    ok: normalizedResult?.ok !== false,

    source: 'CLI_RUN_LONG_SCANNER',

    argv: argv(),

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    longOnly: true,
    shortDisabled: true,

    candidatesCount: normalizedResult?.candidatesCount || 0,
    longCandidatesCount: normalizedResult?.longCandidatesCount || 0,
    shortCandidatesCount: 0,

    rawCandidatesCount: normalizedResult?.rawCandidatesCount || 0,
    ignoredShortCandidates: normalizedResult?.ignoredShortCandidates || 0,
    ignoredUnknownSideCandidates: normalizedResult?.ignoredUnknownSideCandidates || 0,

    durationMs: now() - startedAt,

    result: normalizedResult
  };
}

function buildErrorPayload({
  error,
  startedAt
}) {
  return {
    ok: false,

    source: 'CLI_RUN_LONG_SCANNER',

    argv: argv(),

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    longOnly: true,
    shortDisabled: true,

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

  try {
    const result = await runScanner(buildRunOptions());
    const payload = buildSuccessPayload({
      result,
      startedAt
    });

    console.log(JSON.stringify(payload, null, 2));

    process.exitCode = exitCodeFromResult(payload);
  } catch (error) {
    console.error(JSON.stringify(
      buildErrorPayload({
        error,
        startedAt
      }),
      null,
      2
    ));

    process.exitCode = 1;
  }
}

await main();