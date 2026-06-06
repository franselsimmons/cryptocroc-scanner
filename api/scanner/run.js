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

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';

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

function parseJson(text) {
  const raw = String(text || '').trim();

  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('INVALID_JSON_BODY');
    error.statusCode = 400;
    throw error;
  }
}

async function readBody(req) {
  if (req.method === 'GET') return {};

  if (req.body) {
    if (typeof req.body === 'string') return parseJson(req.body);
    if (Buffer.isBuffer(req.body)) return parseJson(req.body.toString('utf8'));

    return req.body;
  }

  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return parseJson(Buffer.concat(chunks).toString('utf8'));
}

function firstValue(value, fallback = null) {
  if (Array.isArray(value)) return value[0] ?? fallback;
  if (value === undefined || value === null || value === '') return fallback;

  return value;
}

function isTrue(value) {
  const normalized = String(value ?? '').trim().toLowerCase();

  return (
    value === true ||
    value === 1 ||
    ['true', '1', 'yes', 'y', 'on'].includes(normalized)
  );
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

function sourceLabel(req, body = {}) {
  const manual = (
    isTrue(firstValue(req.query?.force, false)) ||
    isTrue(firstValue(req.query?.manual, false)) ||
    isTrue(body.force) ||
    isTrue(body.manual)
  );

  return manual
    ? 'ADMIN_MANUAL_RUN'
    : 'CRON_OR_API_RUN';
}

function normalizeTradeSide(value) {
  const raw = String(value || '').trim().toUpperCase();

  if (['LONG', 'BULL', 'BULLISH', 'BUY'].includes(raw)) return 'LONG';
  if (['SHORT', 'BEAR', 'BEARISH', 'SELL'].includes(raw)) return 'SHORT';

  return 'UNKNOWN';
}

function inferSideFromText(value) {
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

  return inferSideFromText(haystack);
}

function isLongCandidate(row = {}) {
  return rowSide(row) === TARGET_TRADE_SIDE;
}

function isFakeBreakoutCandidate(row = {}) {
  if (row.fakeBreakout === true) return true;
  if (row.fakeBreakoutRisk === true && CONFIG.scanner?.blockFakeBreakout === true) return true;

  const reason = String(
    row.fakeBreakoutReason ||
    row.breakoutType ||
    row.scannerReason ||
    row.reason ||
    ''
  ).toUpperCase();

  return (
    CONFIG.scanner?.blockFakeBreakout === true &&
    (
      reason.includes('FAKE_BREAKOUT') ||
      reason.includes('FAKE BO') ||
      reason.includes('FAILED_BREAKOUT')
    )
  );
}

function shouldKeepCandidate(row = {}) {
  if (!isLongCandidate(row)) return false;
  if (isFakeBreakoutCandidate(row)) return false;

  return true;
}

function normalizeLongCandidate(candidate = {}) {
  return {
    ...candidate,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    scannerSide: TARGET_TRADE_SIDE,
    actualScannerSide: TARGET_TRADE_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    isMirrorMicroFamily: false,
    observationMirror: false,
    analysisMirror: false,
    mirrorAnalysisOnly: false
  };
}

function enforceLongOnlySnapshot(snapshot = {}) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;

  const rawCandidates = Array.isArray(snapshot.candidates)
    ? snapshot.candidates
    : [];

  const rawLongCandidates = rawCandidates.filter((candidate) => rowSide(candidate) === 'LONG');
  const rawShortCandidates = rawCandidates.filter((candidate) => rowSide(candidate) === 'SHORT');
  const rawUnknownSideCandidates = rawCandidates.filter((candidate) => rowSide(candidate) === 'UNKNOWN');
  const rawFakeBreakouts = rawCandidates.filter(isFakeBreakoutCandidate);

  const candidates = rawCandidates
    .filter(shouldKeepCandidate)
    .map(normalizeLongCandidate);

  const scannerGateCandidates = candidates.filter((candidate) => candidate.scannerGatePassed);
  const analyzeOnlyCandidates = candidates.filter((candidate) => (
    candidate.tradeDiscoveryOnly ||
    candidate.discoveryOnly ||
    candidate.analyzeOnly
  ));

  const snapshotId = (
    snapshot.snapshotId ||
    snapshot.id ||
    snapshot.scanId ||
    `scan_${now()}`
  );

  const createdAt = Number(
    snapshot.createdAt ||
    snapshot.ts ||
    snapshot.scannerTs ||
    now()
  );

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

    candidates,
    candidatesCount: candidates.length,

    longCandidatesCount: candidates.length,
    shortCandidatesCount: 0,

    scannerGateCandidatesCount: scannerGateCandidates.length,
    analyzeOnlyCandidatesCount: analyzeOnlyCandidates.length,

    rawCandidatesCount: rawCandidates.length,
    rawLongCandidatesCount: rawLongCandidates.length,
    rawShortCandidatesIgnored: rawShortCandidates.length,
    rawUnknownSideCandidatesIgnored: rawUnknownSideCandidates.length,
    rawFakeBreakoutCandidatesIgnored: rawFakeBreakouts.length,

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
      .filter(Boolean),

    stats: {
      ...(snapshot.stats || {}),

      candidates: candidates.length,
      cleanCandidates: candidates.length,

      scannerGateCandidates: scannerGateCandidates.length,
      analyzeOnlyCandidates: analyzeOnlyCandidates.length,

      longCandidates: candidates.length,
      shortCandidates: 0,
      unknownSideCandidates: 0,

      bullCandidates: candidates.length,
      bearCandidates: 0,

      rawCandidates: rawCandidates.length,
      rawLongCandidates: rawLongCandidates.length,
      rawShortCandidatesIgnored: rawShortCandidates.length,
      rawUnknownSideCandidatesIgnored: rawUnknownSideCandidates.length,
      rawFakeBreakoutCandidatesIgnored: rawFakeBreakouts.length
    }
  };
}

function unwrapLockResult(rawResult = {}) {
  if (!rawResult || typeof rawResult !== 'object') return rawResult;

  return rawResult.result || rawResult;
}

function hasSnapshotShape(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    Array.isArray(value.candidates)
  );
}

function extractSnapshot(rawResult = {}) {
  const payload = unwrapLockResult(rawResult);

  if (hasSnapshotShape(payload)) return payload;
  if (hasSnapshotShape(payload?.snapshot)) return payload.snapshot;
  if (hasSnapshotShape(payload?.result)) return payload.result;

  return null;
}

function normalizeScannerPayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return payload;

  if (hasSnapshotShape(payload)) {
    return enforceLongOnlySnapshot(payload);
  }

  if (hasSnapshotShape(payload.snapshot)) {
    const snapshot = enforceLongOnlySnapshot(payload.snapshot);

    return {
      ...payload,

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      longOnly: true,
      shortDisabled: true,
      shortOnly: false,
      longDisabled: false,

      snapshot,
      snapshotId: snapshot.snapshotId,

      candidates: snapshot.candidates,
      candidatesCount: snapshot.candidatesCount,
      longCandidatesCount: snapshot.longCandidatesCount,
      shortCandidatesCount: 0,

      scannerGateCandidatesCount: snapshot.scannerGateCandidatesCount,
      analyzeOnlyCandidatesCount: snapshot.analyzeOnlyCandidatesCount
    };
  }

  if (hasSnapshotShape(payload.result)) {
    return {
      ...payload,
      result: enforceLongOnlySnapshot(payload.result)
    };
  }

  return {
    ...payload,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false
  };
}

function normalizeLockResult(rawResult = {}) {
  if (!rawResult || typeof rawResult !== 'object') return rawResult;

  if (rawResult.result && typeof rawResult.result === 'object') {
    return {
      ...rawResult,
      result: normalizeScannerPayload(rawResult.result)
    };
  }

  return normalizeScannerPayload(rawResult);
}

async function persistLongOnlySnapshot(redis, snapshot = null) {
  if (!hasSnapshotShape(snapshot)) return null;

  const clean = enforceLongOnlySnapshot(snapshot);
  const ttlSec = getSnapshotTtlSec();

  await setJson(
    redis,
    KEYS.scan.snapshot(clean.snapshotId),
    clean,
    { ex: ttlSec }
  );

  await setJson(
    redis,
    KEYS.scan.latest,
    {
      ok: true,

      snapshotId: clean.snapshotId,
      createdAt: clean.createdAt,

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      longOnly: true,
      shortDisabled: true,
      shortOnly: false,
      longDisabled: false,

      candidatesCount: clean.candidatesCount,
      longCandidatesCount: clean.longCandidatesCount,
      shortCandidatesCount: 0,

      scannerGateCandidatesCount: clean.scannerGateCandidatesCount,
      analyzeOnlyCandidatesCount: clean.analyzeOnlyCandidatesCount,

      topSymbols: clean.topSymbols,
      scannerGateSymbols: clean.scannerGateSymbols,
      analyzeOnlySymbols: clean.analyzeOnlySymbols,

      updatedAt: now()
    },
    { ex: ttlSec }
  );

  return clean;
}

function directAnalyzeEnabled() {
  return CONFIG.scanner?.directAnalyzeEnabled !== false;
}

function getDirectAnalyzeMaxCandidates() {
  const n = Number(
    CONFIG.scanner?.directAnalyzeMaxCandidates ||
    CONFIG.scanner?.analyzeMaxCandidates ||
    CONFIG.scanner?.maxCandidates ||
    300
  );

  return Number.isFinite(n)
    ? Math.max(1, Math.min(1000, Math.floor(n)))
    : 300;
}

function buildAnalyzeRows(snapshot = {}) {
  const rows = Array.isArray(snapshot.candidates)
    ? snapshot.candidates
    : [];

  return rows
    .filter(shouldKeepCandidate)
    .slice(0, getDirectAnalyzeMaxCandidates())
    .map((candidate) => normalizeLongCandidate({
      ...candidate,

      snapshotId: snapshot.snapshotId,
      scannerTs: snapshot.createdAt || now(),
      createdAt: now(),

      btcState: candidate.btcState || snapshot.btcState || null,
      regime: candidate.regime || snapshot.regime || null,

      source: 'SCANNER_DIRECT_ANALYZE',
      analyzeSource: 'SCANNER_DIRECT_ANALYZE',

      scannerGatePassed: candidate.scannerGatePassed !== false,
      analyzeEligible: candidate.analyzeEligible !== false,

      tradeDiscoveryOnly: Boolean(
        candidate.tradeDiscoveryOnly ||
        candidate.discoveryOnly ||
        candidate.analyzeOnly
      )
    }));
}

async function directAnalyzeSnapshot(snapshot = null) {
  if (!directAnalyzeEnabled()) {
    return {
      enabled: false,
      attempted: false,
      rows: 0,
      analyzedRows: 0,
      reason: 'SCANNER_DIRECT_ANALYZE_DISABLED'
    };
  }

  if (!hasSnapshotShape(snapshot)) {
    return {
      enabled: true,
      attempted: false,
      rows: 0,
      analyzedRows: 0,
      reason: 'NO_SNAPSHOT_FOR_DIRECT_ANALYZE'
    };
  }

  const rows = buildAnalyzeRows(snapshot);

  if (!rows.length) {
    return {
      enabled: true,
      attempted: false,
      rows: 0,
      analyzedRows: 0,
      reason: 'NO_LONG_ROWS_FOR_DIRECT_ANALYZE'
    };
  }

  try {
    const analyzed = await analyzeCandidatesBatch(rows);

    return {
      enabled: true,
      attempted: true,
      rows: rows.length,
      analyzedRows: Array.isArray(analyzed) ? analyzed.length : 0,
      reason: null
    };
  } catch (error) {
    return {
      enabled: true,
      attempted: true,
      rows: rows.length,
      analyzedRows: 0,
      reason: 'DIRECT_ANALYZE_FAILED',
      error: error?.message || String(error)
    };
  }
}

function buildRunOptions(req, body = {}) {
  return {
    force: (
      isTrue(firstValue(req.query?.force, false)) ||
      isTrue(body.force)
    ),

    targetTradeSide: TARGET_TRADE_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    side: TARGET_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,
    disableShort: true
  };
}

function resolveStatus(error) {
  if (Number.isFinite(error?.statusCode)) {
    return error.statusCode;
  }

  if (
    error?.reason === 'LOCK_NOT_ACQUIRED' ||
    error?.message === 'LOCK_NOT_ACQUIRED' ||
    error?.message?.includes?.('LOCK')
  ) {
    return 409;
  }

  return 500;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Scanner-Target-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Short-Disabled', 'true');

  const startedAt = now();

  try {
    if (!isAllowedMethod(req.method)) {
      return methodNotAllowed(res);
    }

    const body = await readBody(req);
    const runOptions = buildRunOptions(req, body);

    const redis = getVolatileRedis();
    const lockKey = KEYS.scan?.lock || 'SCAN:LOCK';
    const lockTtlSec = getLockTtlSec();

    const rawResult = await withRedisLock(
      redis,
      lockKey,
      lockTtlSec,
      async () => runScanner(runOptions)
    );

    const normalizedResult = normalizeLockResult(rawResult);
    const rawSnapshot = extractSnapshot(normalizedResult);
    const persistedSnapshot = await persistLongOnlySnapshot(redis, rawSnapshot);

    const directAnalyze = await directAnalyzeSnapshot(
      persistedSnapshot || rawSnapshot
    );

    return res.status(200).json({
      ok: normalizedResult?.ok !== false,

      source: sourceLabel(req, body),

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      longOnly: true,
      shortDisabled: true,
      shortOnly: false,
      longDisabled: false,

      force: runOptions.force,

      snapshotId: persistedSnapshot?.snapshotId || rawSnapshot?.snapshotId || null,
      candidatesCount: persistedSnapshot?.candidatesCount || 0,
      longCandidatesCount: persistedSnapshot?.longCandidatesCount || 0,
      shortCandidatesCount: 0,

      scannerGateCandidatesCount: persistedSnapshot?.scannerGateCandidatesCount || 0,
      analyzeOnlyCandidatesCount: persistedSnapshot?.analyzeOnlyCandidatesCount || 0,

      directAnalyze,

      durationMs: now() - startedAt,
      result: normalizedResult
    });
  } catch (error) {
    return res.status(resolveStatus(error)).json({
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