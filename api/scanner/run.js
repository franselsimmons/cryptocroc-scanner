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
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false
  });
}

function isAllowedMethod(method) {
  return method === 'GET' || method === 'POST';
}

function getLockTtlSec() {
  const ttl = Number(CONFIG.scanner?.lockTtlSec || 540);

  return Number.isFinite(ttl) && ttl > 0 ? ttl : 540;
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

function rowSide(row = {}) {
  const direct = normalizeTradeSide(
    row.tradeSide ||
    row.positionSide ||
    row.direction ||
    row.scannerSide ||
    row.analysisSide ||
    row.side
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

  if (
    haystack.includes('MICRO_LONG_') ||
    haystack.includes('TRADESIDE=LONG') ||
    haystack.includes('TRADE_SIDE=LONG') ||
    haystack.includes('SIDE=LONG') ||
    haystack.includes('SIDE=BULL') ||
    haystack.includes('DIRECTION=LONG') ||
    haystack.includes('DIRECTION=BULL') ||
    haystack.includes('SIDE=BUY') ||
    haystack.includes('DIRECTION=BUY') ||
    haystack.includes('LONG_') ||
    haystack.includes('_LONG') ||
    haystack.includes('BULL_') ||
    haystack.includes('_BULL') ||
    haystack.includes('BUY_') ||
    haystack.includes('_BUY')
  ) {
    return 'LONG';
  }

  if (
    haystack.includes('MICRO_SHORT_') ||
    haystack.includes('TRADESIDE=SHORT') ||
    haystack.includes('TRADE_SIDE=SHORT') ||
    haystack.includes('SIDE=SHORT') ||
    haystack.includes('SIDE=BEAR') ||
    haystack.includes('DIRECTION=SHORT') ||
    haystack.includes('DIRECTION=BEAR') ||
    haystack.includes('SIDE=SELL') ||
    haystack.includes('DIRECTION=SELL') ||
    haystack.includes('SHORT_') ||
    haystack.includes('_SHORT') ||
    haystack.includes('BEAR_') ||
    haystack.includes('_BEAR') ||
    haystack.includes('SELL_') ||
    haystack.includes('_SELL')
  ) {
    return 'SHORT';
  }

  return 'UNKNOWN';
}

function isLongCandidate(row = {}) {
  return rowSide(row) === TARGET_TRADE_SIDE;
}

function normalizeLongCandidate(candidate = {}) {
  return {
    ...candidate,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false
  };
}

function enforceLongOnlySnapshot(snapshot = {}) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;

  const rawCandidates = Array.isArray(snapshot.candidates)
    ? snapshot.candidates
    : [];

  const candidates = rawCandidates
    .filter(isLongCandidate)
    .map(normalizeLongCandidate);

  const scannerGateCandidates = candidates.filter((candidate) => candidate.scannerGatePassed);
  const analyzeOnlyCandidates = candidates.filter((candidate) => candidate.tradeDiscoveryOnly);

  return {
    ...snapshot,

    sideMode: 'LONG_ONLY',
    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: 'bull',
    dashboardSide: TARGET_DASHBOARD_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    candidates,
    candidatesCount: candidates.length,

    longCandidatesCount: candidates.length,
    shortCandidatesCount: 0,

    scannerGateCandidatesCount: scannerGateCandidates.length,
    analyzeOnlyCandidatesCount: analyzeOnlyCandidates.length,

    rawCandidatesCount: rawCandidates.length,
    rawShortCandidatesIgnored: rawCandidates.filter((candidate) => rowSide(candidate) === 'SHORT').length,
    rawUnknownSideCandidatesIgnored: rawCandidates.filter((candidate) => rowSide(candidate) === 'UNKNOWN').length,

    bullCandidates: candidates.length,
    bearCandidates: 0,

    topSymbols: candidates
      .slice(0, 20)
      .map((candidate) => candidate.symbol)
      .filter(Boolean),

    scannerGateSymbols: scannerGateCandidates
      .slice(0, 20)
      .map((candidate) => candidate.symbol)
      .filter(Boolean),

    analyzeOnlySymbols: analyzeOnlyCandidates
      .slice(0, 20)
      .map((candidate) => candidate.symbol)
      .filter(Boolean)
  };
}

function normalizeLockResult(rawResult = {}) {
  if (!rawResult || typeof rawResult !== 'object') return rawResult;

  if (rawResult.result && typeof rawResult.result === 'object') {
    return {
      ...rawResult,
      result: enforceLongOnlySnapshot(rawResult.result)
    };
  }

  return enforceLongOnlySnapshot(rawResult);
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

    const result = normalizeLockResult(rawResult);

    return res.status(200).json({
      ok: result?.ok !== false,

      source: sourceLabel(req),

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      longOnly: true,
      shortDisabled: true,
      shortOnly: false,
      longDisabled: false,

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
      shortOnly: false,
      longDisabled: false,

      error: error?.message || String(error),
      durationMs: Date.now() - startedAt,
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}