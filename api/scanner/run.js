// ================= FILE: api/scanner/run.js =================

import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import {
  getVolatileRedis,
  setJson
} from '../../src/redis.js';
import { withRedisLock } from '../../src/lock.js';
import { runScanner } from '../../src/market/scanner.js';
import { analyzeCandidatesBatch } from '../../src/analyze/analyzeEngine.js';
import {
  normalizeBaseSymbol,
  normalizeContractSymbol,
  safeNumber
} from '../../src/utils.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

function now() {
  return Date.now();
}

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

function firstValue(value, fallback = null) {
  if (Array.isArray(value)) return value[0] ?? fallback;
  if (value === undefined || value === null || value === '') return fallback;

  return value;
}

function isTrue(value) {
  if (value === true || value === 1) return true;

  const raw = String(value ?? '').trim().toLowerCase();

  return ['true', '1', 'yes', 'y', 'on', 'force'].includes(raw);
}

function getLockTtlSec() {
  const ttl = Number(CONFIG.scanner?.lockTtlSec || 540);

  return Number.isFinite(ttl) && ttl > 0
    ? Math.floor(ttl)
    : 540;
}

function getSnapshotTtlSec() {
  const ttl = Number(CONFIG.scanner?.snapshotTtlSec || 30 * 60);

  return Number.isFinite(ttl) && ttl > 0
    ? Math.floor(ttl)
    : 30 * 60;
}

function getAnalyzeMaxCandidates() {
  const max = Number(
    CONFIG.scanner?.analyzeMaxCandidates ||
    CONFIG.scanner?.maxCandidates ||
    300
  );

  return Number.isFinite(max) && max > 0
    ? Math.floor(max)
    : 300;
}

function sourceLabel(req) {
  return isTrue(firstValue(req.query?.force, false)) ||
    isTrue(firstValue(req.query?.manual, false))
    ? 'ADMIN_MANUAL_RUN'
    : 'CRON_OR_API_RUN';
}

function normalizeTradeSide(value) {
  const raw = String(value || '').trim().toUpperCase();

  if (['LONG', 'BULL', 'BULLISH', 'BUY', 'BID', 'UP', 'UPSIDE', 'GREEN'].includes(raw)) {
    return 'LONG';
  }

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'ASK', 'DOWN', 'DOWNSIDE', 'RED'].includes(raw)) {
    return 'SHORT';
  }

  return 'UNKNOWN';
}

function inferTradeSideFromText(value) {
  const text = String(value || '').toUpperCase();

  if (!text) return 'UNKNOWN';

  const longHit = (
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
  );

  const shortHit = (
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
  );

  if (longHit && !shortHit) return 'LONG';
  if (shortHit && !longHit) return 'SHORT';

  return 'UNKNOWN';
}

function rowSide(row = {}) {
  const direct = normalizeTradeSide(
    row.tradeSide ||
    row.targetTradeSide ||
    row.positionSide ||
    row.direction ||
    row.scannerSide ||
    row.actualScannerSide ||
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
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : []),
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : [])
  ]
    .map((value) => String(value || '').toUpperCase())
    .filter(Boolean)
    .join('|');

  return inferTradeSideFromText(haystack);
}

function isLongCandidate(row = {}) {
  const side = rowSide(row);

  if (side === TARGET_TRADE_SIDE) return true;
  if (side === OPPOSITE_TRADE_SIDE) return false;

  return Boolean(
    row.longOnly === true ||
    row.shortDisabled === true ||
    row.targetTradeSide === TARGET_TRADE_SIDE ||
    row.dashboardSide === TARGET_DASHBOARD_SIDE ||
    row.side === TARGET_DASHBOARD_SIDE
  );
}

function normalizeCandidateSymbol(candidate = {}) {
  const contractSymbol = normalizeContractSymbol(
    candidate.contractSymbol ||
    candidate.symbol ||
    candidate.baseSymbol
  );

  const baseSymbol =
    normalizeBaseSymbol(candidate.baseSymbol || candidate.symbol || contractSymbol) ||
    normalizeBaseSymbol(contractSymbol);

  return {
    ...candidate,
    symbol: baseSymbol,
    baseSymbol,
    contractSymbol
  };
}

function normalizeLongCandidate(candidate = {}) {
  const normalized = normalizeCandidateSymbol(candidate);

  return {
    ...normalized,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    scannerSide: TARGET_TRADE_SIDE,
    actualScannerSide: TARGET_TRADE_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    isMirrorMicroFamily: false,
    observationMirror: false,
    analysisMirror: false,
    mirrorAnalysisOnly: false,

    longOnly: true,
    shortDisabled: true,

    shortOnly: false,
    longDisabled: false
  };
}

function unwrapLockResult(lockResult) {
  if (!lockResult) return null;

  if (lockResult.result?.result) return lockResult.result.result;
  if (lockResult.result) return lockResult.result;

  return lockResult;
}

function hasSnapshotShape(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    Array.isArray(value.candidates)
  );
}

function extractSnapshotPayload(rawResult = {}) {
  const payload = unwrapLockResult(rawResult);

  if (hasSnapshotShape(payload)) return payload;

  if (hasSnapshotShape(payload?.snapshot)) return payload.snapshot;
  if (hasSnapshotShape(payload?.result)) return payload.result;

  return payload;
}

function buildSnapshotId(snapshot = {}) {
  return (
    snapshot.snapshotId ||
    snapshot.id ||
    snapshot.scanId ||
    `scan_${now()}`
  );
}

function enforceLongOnlySnapshot(snapshot = {}) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;

  const rawCandidates = Array.isArray(snapshot.candidates)
    ? snapshot.candidates
    : [];

  const longCandidates = rawCandidates
    .filter(isLongCandidate)
    .map(normalizeLongCandidate);

  const scannerGateCandidates = longCandidates.filter((candidate) => candidate.scannerGatePassed);
  const analyzeOnlyCandidates = longCandidates.filter((candidate) => (
    candidate.tradeDiscoveryOnly ||
    candidate.discoveryOnly ||
    candidate.analyzeOnly
  ));

  const createdAt = safeNumber(
    snapshot.createdAt ||
    snapshot.completedAt ||
    snapshot.ts ||
    snapshot.scannerTs,
    now()
  );

  const snapshotId = buildSnapshotId(snapshot);

  return {
    ...snapshot,

    snapshotId,
    createdAt,

    sideMode: 'LONG_ONLY',
    mode: 'LONG_ONLY',

    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_DASHBOARD_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    longOnly: true,
    shortDisabled: true,

    shortOnly: false,
    longDisabled: false,

    candidates: longCandidates,
    candidatesCount: longCandidates.length,

    longCandidatesCount: longCandidates.length,
    shortCandidatesCount: 0,

    scannerGateCandidatesCount: scannerGateCandidates.length,
    analyzeOnlyCandidatesCount: analyzeOnlyCandidates.length,

    rawCandidatesCount: rawCandidates.length,
    rawLongCandidates: rawCandidates.filter((candidate) => rowSide(candidate) === TARGET_TRADE_SIDE).length,
    rawShortCandidatesIgnored: rawCandidates.filter((candidate) => rowSide(candidate) === OPPOSITE_TRADE_SIDE).length,
    rawUnknownSideCandidatesIgnored: rawCandidates.filter((candidate) => rowSide(candidate) === 'UNKNOWN').length,

    bullCandidates: longCandidates.length,
    bearCandidates: 0,

    topSymbols: longCandidates
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
      .filter(Boolean),

    normalizedAt: now()
  };
}

function buildAnalyzeRowsFromSnapshot(snapshot = {}) {
  const maxRows = getAnalyzeMaxCandidates();

  const candidates = Array.isArray(snapshot.candidates)
    ? snapshot.candidates
    : [];

  return candidates
    .slice(0, maxRows)
    .filter(isLongCandidate)
    .map((candidate) => {
      const normalized = normalizeLongCandidate(candidate);

      return {
        ...normalized,

        type: 'SCANNER_OBSERVATION',

        snapshotId: snapshot.snapshotId,
        scannerTs: normalized.scannerTs || snapshot.createdAt || now(),
        createdAt: normalized.createdAt || snapshot.createdAt || now(),

        btcState: normalized.btcState || snapshot.btcState || null,
        regime: normalized.regime || snapshot.regime || null,

        scannerScore: safeNumber(
          normalized.scannerScore ??
          normalized.moveScore,
          0
        ),

        moveScore: safeNumber(
          normalized.moveScore ??
          normalized.scannerScore,
          0
        ),

        confluence: safeNumber(
          normalized.confluence ??
          normalized.scannerScore ??
          normalized.moveScore,
          0
        ),

        sniperScore: safeNumber(
          normalized.sniperScore ??
          normalized.scannerScore ??
          normalized.moveScore,
          0
        ),

        scannerReason: normalized.scannerReason || normalized.reason || null,
        scannerReasonCoarse: normalized.scannerReasonCoarse || null,

        rsiZone: normalized.rsiZone || null,
        rsiCoarse: normalized.rsiCoarse || null,

        flow: normalized.flow || null,
        flowCoarse: normalized.flowCoarse || null,

        obRelation: normalized.obRelation || null,
        btcRelation: normalized.btcRelation || null,

        spreadPct: safeNumber(
          normalized.spreadPct ??
          normalized.liveSpreadPct,
          CONFIG.cost?.fallbackSpreadPct || 0.0008
        ),

        depthMinUsd1p: safeNumber(normalized.depthMinUsd1p, 0),
        fundingRate: safeNumber(normalized.fundingRate, 0),

        rr: safeNumber(normalized.rr, 0),
        entry: safeNumber(normalized.entry, 0),
        sl: safeNumber(normalized.sl, 0),
        tp: safeNumber(normalized.tp, 0),

        scannerGatePassed: normalized.scannerGatePassed !== false,

        analyzeEligible: normalized.analyzeEligible !== false,
        analyzeOnly: Boolean(normalized.analyzeOnly),
        discoveryOnly: Boolean(normalized.discoveryOnly),
        tradeDiscoveryOnly: Boolean(normalized.tradeDiscoveryOnly),

        learningOnly: true,
        liveRiskValid: false,
        liveEntryBlockedReason: 'SCANNER_OBSERVATION_ONLY',

        source: 'SCANNER',
        analysisSource: 'SCANNER_RUN',

        longOnly: true,
        shortDisabled: true,

        shortOnly: false,
        longDisabled: false
      };
    });
}

async function persistSnapshot(redis, snapshot = {}) {
  if (!snapshot?.snapshotId) return false;

  const ttlSec = getSnapshotTtlSec();

  await setJson(
    redis,
    KEYS.scan.snapshot(snapshot.snapshotId),
    snapshot,
    { ex: ttlSec }
  );

  await setJson(
    redis,
    KEYS.scan.latest,
    {
      snapshotId: snapshot.snapshotId,
      createdAt: snapshot.createdAt,
      candidatesCount: snapshot.candidatesCount,

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,

      longOnly: true,
      shortDisabled: true,

      shortOnly: false,
      longDisabled: false,

      topSymbols: snapshot.topSymbols || [],
      scannerGateSymbols: snapshot.scannerGateSymbols || [],

      updatedAt: now()
    },
    { ex: ttlSec }
  );

  return true;
}

async function runScannerAnalyze(snapshot = {}) {
  const rows = buildAnalyzeRowsFromSnapshot(snapshot);

  if (!rows.length) {
    return {
      ok: true,
      skipped: true,
      reason: 'NO_LONG_CANDIDATES_FOR_ANALYZE',
      inputRows: 0,
      analyzedRows: 0
    };
  }

  const analyzed = await analyzeCandidatesBatch(rows)
    .catch((error) => {
      return {
        __analyzeError: true,
        error: error?.message || String(error)
      };
    });

  if (analyzed?.__analyzeError) {
    return {
      ok: false,
      skipped: false,
      reason: 'ANALYZE_FAILED',
      error: analyzed.error,
      inputRows: rows.length,
      analyzedRows: 0
    };
  }

  return {
    ok: true,
    skipped: false,
    reason: null,
    inputRows: rows.length,
    analyzedRows: Array.isArray(analyzed) ? analyzed.length : 0,
    microFamilyIds: Array.isArray(analyzed)
      ? [...new Set(
        analyzed
          .map((row) => row.microFamilyId || row.trueMicroFamilyId)
          .filter(Boolean)
      )].slice(0, 50)
      : []
  };
}

function normalizeLockResult(rawResult = {}, snapshot = {}, analyze = {}) {
  if (!rawResult || typeof rawResult !== 'object') {
    return {
      ok: true,
      result: snapshot,
      analyze
    };
  }

  if (rawResult.result?.result) {
    return {
      ...rawResult,
      result: {
        ...rawResult.result,
        result: snapshot,
        analyze
      }
    };
  }

  if (rawResult.result && typeof rawResult.result === 'object') {
    return {
      ...rawResult,
      result: snapshot,
      analyze
    };
  }

  return {
    ...rawResult,
    result: snapshot,
    analyze
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Scanner-Target-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Dashboard-Side', TARGET_DASHBOARD_SIDE);
  res.setHeader('X-Long-Only', 'true');
  res.setHeader('X-Short-Disabled', 'true');

  const startedAt = now();

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

    const rawSnapshot = extractSnapshotPayload(rawResult);
    const snapshot = enforceLongOnlySnapshot(rawSnapshot);

    const analyze = await runScannerAnalyze(snapshot);

    const finalSnapshot = {
      ...snapshot,
      scannerAnalyze: analyze,
      scannerAnalyzeInputRows: analyze.inputRows,
      scannerAnalyzeRows: analyze.analyzedRows,
      scannerAnalyzeOk: analyze.ok,
      scannerAnalyzeReason: analyze.reason,
      scannerAnalyzeAt: now()
    };

    const persisted = await persistSnapshot(redis, finalSnapshot);

    const result = normalizeLockResult(
      rawResult,
      finalSnapshot,
      analyze
    );

    return res.status(200).json({
      ok: result?.ok !== false,

      source: sourceLabel(req),

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,

      longOnly: true,
      shortDisabled: true,

      shortOnly: false,
      longDisabled: false,

      persisted,

      snapshotId: finalSnapshot.snapshotId,
      candidatesCount: finalSnapshot.candidatesCount,
      longCandidatesCount: finalSnapshot.longCandidatesCount,

      analyze,

      durationMs: now() - startedAt,
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
      durationMs: now() - startedAt,
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}