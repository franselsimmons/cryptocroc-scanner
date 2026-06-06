// ================= FILE: api/scanner/run.js =================

import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import { getVolatileRedis } from '../../src/redis.js';
import { withRedisLock } from '../../src/lock.js';
import { runScanner } from '../../src/market/scanner.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET, POST');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET', 'POST'],

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    longOnly: true,
    shortDisabled: true
  });
}

function isAllowedMethod(method) {
  return method === 'GET' || method === 'POST';
}

function getLockTtlSec() {
  const ttl = Number(CONFIG.scanner?.lockTtlSec || 240);

  return Number.isFinite(ttl) && ttl > 0 ? ttl : 240;
}

function sourceLabel(req) {
  if (req.query?.force === 'true') return 'ADMIN_MANUAL_RUN';

  return 'CRON_OR_API_RUN';
}

function normalizeTradeSide(value) {
  const raw = String(value || '').trim().toUpperCase();

  if (['LONG', 'BULL', 'BULLISH', 'BUY'].includes(raw)) return 'LONG';
  if (['SHORT', 'BEAR', 'BEARISH', 'SELL'].includes(raw)) return 'SHORT';

  return 'UNKNOWN';
}

function inferTradeSideFromText(value) {
  const text = String(value || '').toUpperCase();

  if (!text) return 'UNKNOWN';

  if (
    text.includes('MICRO_LONG_') ||
    text.includes('TRADESIDE=LONG') ||
    text.includes('TRADE_SIDE=LONG') ||
    text.includes('SIDE=LONG') ||
    text.includes('SIDE=BULL') ||
    text.includes('DIRECTION=LONG') ||
    text.includes('DIRECTION=BULL') ||
    text.includes('SIDE=BUY') ||
    text.includes('DIRECTION=BUY') ||
    text.includes('LONG_') ||
    text.includes('_LONG') ||
    text.includes('BULL_') ||
    text.includes('_BULL') ||
    text.includes('BUY_') ||
    text.includes('_BUY')
  ) {
    return 'LONG';
  }

  if (
    text.includes('MICRO_SHORT_') ||
    text.includes('TRADESIDE=SHORT') ||
    text.includes('TRADE_SIDE=SHORT') ||
    text.includes('SIDE=SHORT') ||
    text.includes('SIDE=BEAR') ||
    text.includes('DIRECTION=SHORT') ||
    text.includes('DIRECTION=BEAR') ||
    text.includes('SIDE=SELL') ||
    text.includes('DIRECTION=SELL') ||
    text.includes('SHORT_') ||
    text.includes('_SHORT') ||
    text.includes('BEAR_') ||
    text.includes('_BEAR') ||
    text.includes('SELL_') ||
    text.includes('_SELL')
  ) {
    return 'SHORT';
  }

  return 'UNKNOWN';
}

function rowSide(row = {}) {
  const direct = normalizeTradeSide(
    row.tradeSide ||
    row.side ||
    row.positionSide ||
    row.direction ||
    row.scannerSide ||
    row.analysisSide
  );

  if (direct === 'LONG' || direct === 'SHORT') return direct;

  const haystack = [
    row.familyId,
    row.family,
    row.baseFamilyId,

    row.microFamilyId,
    row.trueMicroFamilyId,
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

    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts : []),
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : [])
  ]
    .map((value) => String(value || '').toUpperCase())
    .filter(Boolean)
    .join('|');

  return inferTradeSideFromText(haystack);
}

function isLongCandidate(row = {}) {
  return rowSide(row) === TARGET_TRADE_SIDE;
}

function isShortCandidate(row = {}) {
  return rowSide(row) === 'SHORT';
}

function normalizeLongCandidate(candidate = {}) {
  return {
    ...candidate,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    targetTradeSide: TARGET_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true
  };
}

function enforceLongOnlyResult(result = {}) {
  if (!result || typeof result !== 'object') return result;

  const rawCandidates = Array.isArray(result.candidates)
    ? result.candidates
    : [];

  const candidates = rawCandidates
    .filter(isLongCandidate)
    .map(normalizeLongCandidate);

  const scannerGateCandidates = candidates.filter((candidate) => candidate.scannerGatePassed);
  const analyzeOnlyCandidates = candidates.filter((candidate) => candidate.tradeDiscoveryOnly);

  const shortCandidatesIgnored = rawCandidates.filter(isShortCandidate).length;
  const unknownSideCandidatesIgnored = rawCandidates.filter((candidate) => (
    rowSide(candidate) === 'UNKNOWN'
  )).length;

  return {
    ...result,

    longOnly: true,
    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    shortDisabled: true,

    candidates,
    candidatesCount: candidates.length,

    longCandidatesCount: candidates.length,
    shortCandidatesCount: 0,

    scannerGateCandidatesCount: scannerGateCandidates.length,
    analyzeOnlyCandidatesCount: analyzeOnlyCandidates.length,

    rawCandidatesCount: rawCandidates.length,
    rawShortCandidatesIgnored: shortCandidatesIgnored,
    rawUnknownSideCandidatesIgnored: unknownSideCandidatesIgnored,

    // Backwards-compatible namen voor admin.html.
    bullCandidates: candidates.length,
    bearCandidates: 0,

    topSymbols: candidates
      .slice(0, 20)
      .map((candidate) => candidate.symbol)
      .filter(Boolean),

    scannerGateSymbols: scannerGateCandidates
      .slice(0, 20)
      .map((candidate) => candidate.symbol)
      .filter(Boolean)
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Scanner-Target-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Short-Disabled', 'true');

  const startedAt = Date.now();

  try {
    if (!isAllowedMethod(req.method)) {
      return methodNotAllowed(res);
    }

    const redis = getVolatileRedis();
    const lockKey = KEYS.scan?.lock || 'SCAN:LOCK';
    const lockTtlSec = getLockTtlSec();

    const rawResult = await withRedisLock(
      redis,
      lockKey,
      lockTtlSec,
      async () => runScanner()
    );

    const result = enforceLongOnlyResult(rawResult);

    return res.status(200).json({
      ok: result?.ok !== false,

      source: sourceLabel(req),

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      longOnly: true,
      shortDisabled: true,

      durationMs: Date.now() - startedAt,
      result
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      longOnly: true,
      shortDisabled: true,

      error: error?.message || String(error),
      durationMs: Date.now() - startedAt,
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}