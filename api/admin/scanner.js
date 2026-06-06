// ================= FILE: api/admin/scanner.js =================

import { KEYS } from '../../src/keys.js';
import { getVolatileRedis, getJson, getKeys } from '../../src/redis.js';
import { sideToTradeSide, safeNumber } from '../../src/utils.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

const SNAPSHOT_SEARCH_LIMIT = 80;

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET'],

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    longOnly: true,
    shortDisabled: true
  });
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function extractSnapshotId(latest) {
  if (!latest) return null;

  if (typeof latest === 'string') return latest;

  if (typeof latest === 'object') {
    return (
      latest.snapshotId ||
      latest.id ||
      latest.latestSnapshotId ||
      latest.scanId ||
      null
    );
  }

  return null;
}

function hasFullSnapshotShape(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    Array.isArray(value.candidates)
  );
}

function snapshotCreatedAt(snapshot = {}) {
  return safeNumber(
    snapshot.createdAt ||
    snapshot.completedAt ||
    snapshot.ts ||
    snapshot.scannerTs,
    0
  );
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
    .map((value) => upper(value))
    .join(' | ');
}

function inferTradeSide(row = {}) {
  if (typeof row === 'string') {
    const value = upper(row);

    if (!value) return 'UNKNOWN';

    if (
      value.includes('MICRO_LONG_') ||
      value.includes('TRADESIDE=LONG') ||
      value.includes('TRADE_SIDE=LONG') ||
      value.includes('SIDE=LONG') ||
      value.includes('SIDE=BULL') ||
      value.includes('DIRECTION=LONG') ||
      value.includes('DIRECTION=BULL') ||
      value.includes('_LONG_') ||
      value.startsWith('LONG_')
    ) {
      return 'LONG';
    }

    if (
      value.includes('MICRO_SHORT_') ||
      value.includes('TRADESIDE=SHORT') ||
      value.includes('TRADE_SIDE=SHORT') ||
      value.includes('SIDE=SHORT') ||
      value.includes('SIDE=BEAR') ||
      value.includes('DIRECTION=SHORT') ||
      value.includes('DIRECTION=BEAR') ||
      value.includes('_SHORT_') ||
      value.startsWith('SHORT_')
    ) {
      return 'SHORT';
    }

    return 'UNKNOWN';
  }

  const direct = sideToTradeSide(
    row.tradeSide ||
    row.positionSide ||
    row.direction ||
    row.signalSide ||
    row.scannerSide ||
    row.actualScannerSide ||
    row.analysisSide ||
    row.entrySide ||
    row.bias ||
    row.marketBias ||
    row.side
  );

  if (direct !== 'UNKNOWN') return direct;

  const rawSide = upper(row.side);

  if (['LONG', 'BULL', 'BULLISH', 'BUY'].includes(rawSide)) return 'LONG';
  if (['SHORT', 'BEAR', 'BEARISH', 'SELL'].includes(rawSide)) return 'SHORT';

  const familyId = upper(row.familyId || row.family || row.baseFamilyId);

  const macroFamilyId = upper(
    row.parentMacroFamilyId ||
    row.macroFamilyId ||
    row.parentMicroFamilyId ||
    row.parentFamilyId ||
    row.macroId
  );

  const microFamilyId = upper(
    row.microFamilyId ||
    row.trueMicroFamilyId ||
    row.id ||
    row.key
  );

  if (familyId.startsWith('LONG_')) return 'LONG';
  if (familyId.startsWith('SHORT_')) return 'SHORT';

  if (macroFamilyId.includes('MICRO_LONG_') || macroFamilyId.includes('_LONG_')) return 'LONG';
  if (macroFamilyId.includes('MICRO_SHORT_') || macroFamilyId.includes('_SHORT_')) return 'SHORT';

  if (microFamilyId.includes('MICRO_LONG_') || microFamilyId.includes('_LONG_')) return 'LONG';
  if (microFamilyId.includes('MICRO_SHORT_') || microFamilyId.includes('_SHORT_')) return 'SHORT';

  if (microFamilyId.includes('TRADESIDE=LONG')) return 'LONG';
  if (microFamilyId.includes('TRADESIDE=SHORT')) return 'SHORT';

  const scannerReason = upper(
    row.scannerReason ||
    row.reason ||
    row.signalReason ||
    row.actionReason
  );

  if (
    scannerReason.includes('LONG') ||
    scannerReason.includes('BULL') ||
    scannerReason.includes('BUY') ||
    scannerReason.includes('UPSIDE')
  ) {
    return 'LONG';
  }

  if (
    scannerReason.includes('SHORT') ||
    scannerReason.includes('BEAR') ||
    scannerReason.includes('SELL') ||
    scannerReason.includes('DOWNSIDE')
  ) {
    return 'SHORT';
  }

  const definition = getDefinitionHaystack(row);

  if (
    definition.includes('TRADESIDE=LONG') ||
    definition.includes('TRADE_SIDE=LONG') ||
    definition.includes('SIDE=LONG') ||
    definition.includes('SIDE=BULL') ||
    definition.includes('DIRECTION=LONG') ||
    definition.includes('DIRECTION=BULL') ||
    definition.includes('SIDE=BUY') ||
    definition.includes('DIRECTION=BUY')
  ) {
    return 'LONG';
  }

  if (
    definition.includes('TRADESIDE=SHORT') ||
    definition.includes('TRADE_SIDE=SHORT') ||
    definition.includes('SIDE=SHORT') ||
    definition.includes('SIDE=BEAR') ||
    definition.includes('DIRECTION=SHORT') ||
    definition.includes('DIRECTION=BEAR') ||
    definition.includes('SIDE=SELL') ||
    definition.includes('DIRECTION=SELL')
  ) {
    return 'SHORT';
  }

  return 'UNKNOWN';
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
    shortDisabled: true
  };
}

function splitCandidatesBySide(candidates = []) {
  const rows = Array.isArray(candidates) ? candidates : [];

  const longCandidates = [];
  const shortCandidates = [];
  const unknownSideCandidates = [];

  for (const candidate of rows) {
    const tradeSide = inferTradeSide(candidate);

    if (tradeSide === 'LONG') {
      longCandidates.push(candidate);
      continue;
    }

    if (tradeSide === 'SHORT') {
      shortCandidates.push(candidate);
      continue;
    }

    unknownSideCandidates.push(candidate);
  }

  return {
    longCandidates,
    shortCandidates,
    unknownSideCandidates
  };
}

function countCandidatesBySide(candidates = []) {
  const {
    longCandidates,
    shortCandidates,
    unknownSideCandidates
  } = splitCandidatesBySide(candidates);

  return {
    longCandidates: longCandidates.length,
    shortCandidates: shortCandidates.length,
    unknownSideCandidates: unknownSideCandidates.length,

    bullCandidates: longCandidates.length,
    bearCandidates: shortCandidates.length,

    rawLongCandidates: longCandidates.length,
    rawShortCandidates: shortCandidates.length,
    rawUnknownSideCandidates: unknownSideCandidates.length
  };
}

function averageScannerScore(candidates = []) {
  if (!candidates.length) return 0;

  const total = candidates.reduce((sum, candidate) => {
    return sum + safeNumber(candidate?.scannerScore ?? candidate?.moveScore, 0);
  }, 0);

  return Number((total / candidates.length).toFixed(2));
}

function normalizeSnapshot(snapshot, fallbackId = null, source = 'UNKNOWN') {
  if (!snapshot || typeof snapshot !== 'object') {
    return null;
  }

  const rawCandidates = Array.isArray(snapshot.candidates)
    ? snapshot.candidates
    : [];

  const {
    longCandidates,
    shortCandidates,
    unknownSideCandidates
  } = splitCandidatesBySide(rawCandidates);

  const candidates = longCandidates.map(normalizeLongCandidate);

  const createdAt = snapshotCreatedAt(snapshot);

  const snapshotAgeSec = createdAt > 0
    ? Math.max(0, Math.floor((Date.now() - createdAt) / 1000))
    : null;

  const cleanCandidates = candidates.filter((candidate) => !candidate.fakeBreakout);
  const fakeBreakouts = candidates.filter((candidate) => candidate.fakeBreakout);
  const fakeRiskCandidates = candidates.filter((candidate) => candidate.fakeBreakoutRisk);
  const scannerGateCandidates = candidates.filter((candidate) => candidate.scannerGatePassed);
  const analyzeOnlyCandidates = candidates.filter((candidate) => (
    candidate.tradeDiscoveryOnly ||
    candidate.discoveryOnly ||
    candidate.analyzeOnly
  ));

  const sideCounts = countCandidatesBySide(rawCandidates);

  const topSymbols = candidates
    .slice(0, 20)
    .map((candidate) => candidate.symbol)
    .filter(Boolean);

  const scannerGateSymbols = scannerGateCandidates
    .slice(0, 20)
    .map((candidate) => candidate.symbol)
    .filter(Boolean);

  return {
    ...snapshot,

    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_DASHBOARD_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    snapshotId: snapshot.snapshotId || fallbackId || null,
    snapshotSource: source,

    rawCandidatesCount: rawCandidates.length,
    rawShortCandidatesIgnored: shortCandidates.length,
    rawUnknownSideCandidatesIgnored: unknownSideCandidates.length,

    candidates,
    candidatesCount: candidates.length,
    longCandidatesCount: candidates.length,
    shortCandidatesCount: 0,

    scannerGateCandidatesCount: scannerGateCandidates.length,
    analyzeOnlyCandidatesCount: analyzeOnlyCandidates.length,

    topSymbols,
    scannerGateSymbols,

    stats: {
      candidates: candidates.length,
      cleanCandidates: cleanCandidates.length,
      fakeBreakouts: fakeBreakouts.length,
      fakeRiskCandidates: fakeRiskCandidates.length,

      scannerGateCandidates: scannerGateCandidates.length,
      analyzeOnlyCandidates: analyzeOnlyCandidates.length,

      ...sideCounts,

      avgScannerScore: averageScannerScore(candidates),

      rawCandidates: rawCandidates.length,
      rawShortCandidatesIgnored: shortCandidates.length,
      rawUnknownSideCandidatesIgnored: unknownSideCandidates.length
    },

    snapshotAgeSec,
    isStale8m: snapshotAgeSec === null ? null : snapshotAgeSec > 8 * 60,
    isStale30m: snapshotAgeSec === null ? null : snapshotAgeSec > 30 * 60
  };
}

function normalizeLatest(latest, snapshot = null) {
  if (!latest || typeof latest !== 'object') return latest;

  const candidates = Array.isArray(snapshot?.candidates)
    ? snapshot.candidates
    : [];

  const scannerGateCandidates = candidates.filter((candidate) => candidate.scannerGatePassed);
  const analyzeOnlyCandidates = candidates.filter((candidate) => (
    candidate.tradeDiscoveryOnly ||
    candidate.discoveryOnly ||
    candidate.analyzeOnly
  ));

  return {
    ...latest,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    selectedSnapshotId: snapshot?.snapshotId || latest.snapshotId || null,
    selectedSnapshotSource: snapshot?.snapshotSource || null,

    candidatesCount: candidates.length,
    longCandidatesCount: candidates.length,
    shortCandidatesCount: 0,

    scannerGateCandidatesCount: scannerGateCandidates.length,
    analyzeOnlyCandidatesCount: analyzeOnlyCandidates.length,

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

function snapshotPattern() {
  try {
    return KEYS.scan.snapshot('*');
  } catch {
    return 'SCAN:SNAPSHOT:*';
  }
}

async function safeGetJson(redis, key, fallback = null) {
  return getJson(redis, key, fallback).catch(() => fallback);
}

async function loadSnapshotById(redis, snapshotId) {
  if (!snapshotId) return null;

  return safeGetJson(
    redis,
    KEYS.scan.snapshot(snapshotId),
    null
  );
}

async function loadRecentSnapshots(redis) {
  const pattern = snapshotPattern();

  const keys = await getKeys(
    redis,
    pattern,
    SNAPSHOT_SEARCH_LIMIT
  ).catch(() => []);

  if (!keys.length) return [];

  const rows = await Promise.all(
    keys.map(async (key) => {
      const snapshot = await safeGetJson(redis, key, null);

      if (!hasFullSnapshotShape(snapshot)) return null;

      return {
        key,
        snapshot
      };
    })
  );

  return rows.filter(Boolean);
}

function targetCount(snapshot = {}) {
  const rawCandidates = Array.isArray(snapshot.candidates)
    ? snapshot.candidates
    : [];

  return splitCandidatesBySide(rawCandidates).longCandidates.length;
}

async function resolveTargetSnapshot(redis, latestRaw) {
  const candidates = [];

  const latestSnapshotId = extractSnapshotId(latestRaw);

  if (hasFullSnapshotShape(latestRaw)) {
    candidates.push({
      source: 'SCAN:LATEST_FULL_SNAPSHOT',
      snapshotId: latestSnapshotId || latestRaw.snapshotId || null,
      snapshot: latestRaw
    });
  }

  const latestById = await loadSnapshotById(redis, latestSnapshotId);

  if (hasFullSnapshotShape(latestById)) {
    candidates.push({
      source: 'SCAN:SNAPSHOT_BY_LATEST_ID',
      snapshotId: latestSnapshotId,
      snapshot: latestById
    });
  }

  const recent = await loadRecentSnapshots(redis);

  for (const row of recent) {
    candidates.push({
      source: `SCAN:RECENT_SEARCH:${row.key}`,
      snapshotId: row.snapshot.snapshotId || null,
      snapshot: row.snapshot
    });
  }

  const unique = new Map();

  for (const item of candidates) {
    const id = item.snapshot?.snapshotId || item.snapshotId || item.source;

    if (!id) continue;

    const previous = unique.get(id);

    if (!previous) {
      unique.set(id, item);
      continue;
    }

    const previousTarget = targetCount(previous.snapshot);
    const currentTarget = targetCount(item.snapshot);

    if (currentTarget > previousTarget) {
      unique.set(id, item);
    }
  }

  const rows = [...unique.values()]
    .filter((item) => hasFullSnapshotShape(item.snapshot))
    .sort((a, b) => snapshotCreatedAt(b.snapshot) - snapshotCreatedAt(a.snapshot));

  const newestTarget = rows.find((item) => targetCount(item.snapshot) > 0);

  if (newestTarget) {
    return {
      rawSnapshot: newestTarget.snapshot,
      snapshotId: newestTarget.snapshot.snapshotId || newestTarget.snapshotId || null,
      snapshotSource: newestTarget.source,
      selectedReason: 'NEWEST_LONG_SNAPSHOT_WITH_CANDIDATES',
      searchedSnapshots: rows.length
    };
  }

  const newestAny = rows[0] || null;

  if (newestAny) {
    return {
      rawSnapshot: newestAny.snapshot,
      snapshotId: newestAny.snapshot.snapshotId || newestAny.snapshotId || null,
      snapshotSource: newestAny.source,
      selectedReason: 'NO_LONG_SNAPSHOT_FOUND_USING_NEWEST_AVAILABLE',
      searchedSnapshots: rows.length
    };
  }

  return {
    rawSnapshot: null,
    snapshotId: latestSnapshotId || null,
    snapshotSource: 'NO_SNAPSHOT_FOUND',
    selectedReason: 'NO_SNAPSHOT_FOUND',
    searchedSnapshots: rows.length
  };
}

function emptyStats() {
  return {
    candidates: 0,
    cleanCandidates: 0,
    fakeBreakouts: 0,
    fakeRiskCandidates: 0,

    scannerGateCandidates: 0,
    analyzeOnlyCandidates: 0,

    longCandidates: 0,
    shortCandidates: 0,
    unknownSideCandidates: 0,

    bullCandidates: 0,
    bearCandidates: 0,

    avgScannerScore: 0,

    rawCandidates: 0,
    rawShortCandidatesIgnored: 0,
    rawUnknownSideCandidatesIgnored: 0
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Scanner-Mode', 'long-only');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Short-Disabled', 'true');

  if (req.method !== 'GET') {
    return methodNotAllowed(res);
  }

  try {
    const redis = getVolatileRedis();
    const latestRaw = await safeGetJson(redis, KEYS.scan.latest, null);

    const resolved = await resolveTargetSnapshot(redis, latestRaw);

    const snapshot = normalizeSnapshot(
      resolved.rawSnapshot,
      resolved.snapshotId,
      resolved.snapshotSource
    );

    const candidates = Array.isArray(snapshot?.candidates)
      ? snapshot.candidates
      : [];

    const latest = normalizeLatest(latestRaw, snapshot);

    return res.status(200).json({
      ok: true,

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      longOnly: true,
      shortDisabled: true,
      shortOnly: false,
      longDisabled: false,

      latest,
      snapshot,
      candidates,

      snapshotId: snapshot?.snapshotId || resolved.snapshotId || null,
      snapshotSource: resolved.snapshotSource,
      selectedReason: resolved.selectedReason,
      searchedSnapshots: resolved.searchedSnapshots,

      candidatesCount: candidates.length,
      longCandidatesCount: candidates.length,
      shortCandidatesCount: 0,

      rawCandidatesCount: snapshot?.rawCandidatesCount || 0,
      rawShortCandidatesIgnored: snapshot?.rawShortCandidatesIgnored || 0,
      rawUnknownSideCandidatesIgnored: snapshot?.rawUnknownSideCandidatesIgnored || 0,

      stats: snapshot?.stats || emptyStats(),

      warning: candidates.length
        ? null
        : 'NO_LONG_CANDIDATES_IN_SELECTED_SNAPSHOT',

      serverTs: Date.now()
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      longOnly: true,
      shortDisabled: true,

      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}