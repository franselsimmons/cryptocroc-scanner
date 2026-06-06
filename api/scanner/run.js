// ================= FILE: api/scanner/run.js =================

import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import { getVolatileRedis } from '../../src/redis.js';
import { withRedisLock } from '../../src/lock.js';
import { runScanner } from '../../src/market/scanner.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET, POST');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET', 'POST'],

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false
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

function normalizeShortScanResult(result = {}) {
  if (!result || typeof result !== 'object') return result;

  const scan = result.result && typeof result.result === 'object'
    ? result.result
    : null;

  if (scan) {
    return {
      ...result,
      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      shortOnly: true,
      longDisabled: true,
      longOnly: false,
      shortDisabled: false,

      result: {
        ...scan,
        sideMode: 'SHORT_ONLY',
        targetTradeSide: TARGET_TRADE_SIDE,
        targetScannerSide: TARGET_DASHBOARD_SIDE,
        dashboardSide: TARGET_DASHBOARD_SIDE,

        shortOnly: true,
        longDisabled: true,
        longOnly: false,
        shortDisabled: false
      }
    };
  }

  return {
    ...result,
    sideMode: 'SHORT_ONLY',
    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_DASHBOARD_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false
  };
}

function extractScanPayload(lockResult = {}) {
  if (lockResult?.result && typeof lockResult.result === 'object') {
    return lockResult.result;
  }

  return null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Scanner-Target-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Short-Only', 'true');
  res.setHeader('X-Long-Disabled', 'true');

  const startedAt = Date.now();

  try {
    if (!isAllowedMethod(req.method)) {
      return methodNotAllowed(res);
    }

    const redis = getVolatileRedis();
    const lockKey = KEYS.scan?.lock || 'SCAN:LOCK';
    const lockTtlSec = getLockTtlSec();

    const lockResult = await withRedisLock(
      redis,
      lockKey,
      lockTtlSec,
      async () => runScanner()
    );

    const normalizedResult = normalizeShortScanResult(lockResult);
    const scan = extractScanPayload(lockResult);

    return res.status(200).json({
      ok: lockResult?.ok !== false,

      source: sourceLabel(req),

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      shortOnly: true,
      longDisabled: true,
      longOnly: false,
      shortDisabled: false,

      durationMs: Date.now() - startedAt,

      snapshotId: scan?.snapshotId || null,
      candidatesCount: scan?.candidatesCount ?? null,
      scannerGateCandidatesCount: scan?.scannerGateCandidatesCount ?? null,
      analyzeOnlyCandidatesCount: scan?.analyzeOnlyCandidatesCount ?? null,
      topSymbols: scan?.topSymbols || [],
      scannerGateSymbols: scan?.scannerGateSymbols || [],

      result: normalizedResult
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      shortOnly: true,
      longDisabled: true,
      longOnly: false,
      shortDisabled: false,

      error: error?.message || String(error),
      durationMs: Date.now() - startedAt,
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}