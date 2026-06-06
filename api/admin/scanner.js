// ================= FILE: api/admin/scanner.js =================

import { KEYS } from '../../src/keys.js';
import { getVolatileRedis, getJson } from '../../src/redis.js';
import { sideToTradeSide, safeNumber } from '../../src/utils.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';

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

  if (typeof latest === 'string') {
    return latest;
  }

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

function getDefinitionHaystack(row = {}) {
  return [
    row.definition,
    row.microDefinition,
    row.macroDefinition,
    row.parentDefinition,
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts : []),
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : [])
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
      value.includes('LONG')
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
      value.includes('SHORT')
    ) {
      return 'SHORT';
    }

    return 'UNKNOWN';
  }

  const direct = sideToTradeSide(
    row.tradeSide ||
    row.side ||
    row.positionSide ||
    row.direction ||
    row.signalSide ||
    row.scannerSide ||
    row.entrySide ||
    row.bias ||
    row.marketBias
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

  if (macroFamilyId.includes('LONG')) return 'LONG';
  if (macroFamilyId.includes('SHORT')) return 'SHORT';

  if (microFamilyId.includes('MICRO_LONG_')) return 'LONG';
  if (microFamilyId.includes('MICRO_SHORT_')) return 'SHORT';

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

  if (microFamilyId.includes('LONG')) return 'LONG';
  if (microFamilyId.includes('SHORT')) return 'SHORT';

  return 'UNKNOWN';
}

function isLongCandidate(candidate = {}) {
  return inferTradeSide(candidate) === TARGET_TRADE_SIDE;
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

    // Backwards-compatible namen voor admin.html.
    bullCandidates: longCandidates.length,
    bearCandidates: 0,

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

function normalizeLatest(latest, snapshot = null) {
  if (!latest || typeof latest !== 'object') return latest;

  const candidates = Array.isArray(snapshot?.candidates)
    ? snapshot.candidates
    : [];

  const scannerGateCandidates = candidates.filter((candidate) => candidate.scannerGatePassed);
  const analyzeOnlyCandidates = candidates.filter((candidate) => candidate.tradeDiscoveryOnly);

  return {
    ...latest,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    longOnly: true,
    shortDisabled: true,

    candidatesCount: candidates.length || safeNumber(latest.longCandidatesCount, 0),
    longCandidatesCount: candidates.length || safeNumber(latest.longCandidatesCount, 0),
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

function normalizeSnapshot(snapshot, fallbackId = null) {
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

  const createdAt = safeNumber(
    snapshot.createdAt ||
    snapshot.ts ||
    snapshot.scannerTs,
    0
  );

  const snapshotAgeSec = createdAt > 0
    ? Math.max(0, Math.floor((Date.now() - createdAt) / 1000))
    : null;

  const cleanCandidates = candidates.filter((candidate) => !candidate.fakeBreakout);
  const fakeBreakouts = candidates.filter((candidate) => candidate.fakeBreakout);
  const fakeRiskCandidates = candidates.filter((candidate) => candidate.fakeBreakoutRisk);
  const scannerGateCandidates = candidates.filter((candidate) => candidate.scannerGatePassed);
  const analyzeOnlyCandidates = candidates.filter((candidate) => candidate.tradeDiscoveryOnly);

  const sideCounts = countCandidatesBySide(candidates);

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
    dashboardSide: TARGET_DASHBOARD_SIDE,
    longOnly: true,
    shortDisabled: true,

    snapshotId: snapshot.snapshotId || fallbackId || null,

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

async function loadSnapshot(redis, latest) {
  const snapshotId = extractSnapshotId(latest);

  if (hasFullSnapshotShape(latest)) {
    const snapshot = normalizeSnapshot(latest, snapshotId);

    return {
      snapshot,
      snapshotSource: 'SCAN:LATEST_FULL_SNAPSHOT',
      snapshotId
    };
  }

  if (!snapshotId) {
    return {
      snapshot: null,
      snapshotSource: 'NO_SNAPSHOT_ID',
      snapshotId: null
    };
  }

  const snapshot = await getJson(
    redis,
    KEYS.scan.snapshot(snapshotId),
    null
  );

  return {
    snapshot: normalizeSnapshot(snapshot, snapshotId),
    snapshotSource: 'SCAN:SNAPSHOT_BY_ID',
    snapshotId
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
    const latestRaw = await getJson(redis, KEYS.scan.latest, null);

    const {
      snapshot,
      snapshotSource,
      snapshotId
    } = await loadSnapshot(redis, latestRaw);

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

      latest,
      snapshot,
      candidates,

      snapshotId,
      snapshotSource,

      candidatesCount: candidates.length,
      longCandidatesCount: candidates.length,
      shortCandidatesCount: 0,

      stats: snapshot?.stats || emptyStats(),

      serverTs: Date.now()
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,

      targetTradeSide: TARGET_TRADE_SIDE,
      longOnly: true,
      shortDisabled: true,

      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}