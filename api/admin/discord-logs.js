// ================= FILE: api/admin/discord-logs.js =================

import { KEYS } from '../../src/keys.js';
import { getDurableRedis, readJsonLogs } from '../../src/redis.js';

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET']
  });
}

function firstQueryValue(value, fallback = null) {
  if (Array.isArray(value)) return value[0] ?? fallback;
  if (value === undefined || value === null || value === '') return fallback;

  return value;
}

function clampLimit(value, fallback = 100) {
  const limit = Number(value);

  if (!Number.isFinite(limit)) return fallback;
  if (limit < 1) return 1;
  if (limit > 500) return 500;

  return Math.floor(limit);
}

function normalizeLog(row = {}) {
  const payload = row.payload || {};

  return {
    ...row,

    type: row.type || row.level || 'UNKNOWN',

    payload,

    symbol:
      row.symbol ||
      payload.symbol ||
      payload.contractSymbol ||
      null,

    side:
      row.side ||
      payload.side ||
      null,

    microFamilyId:
      row.microFamilyId ||
      payload.microFamilyId ||
      null,

    familyId:
      row.familyId ||
      payload.familyId ||
      null,

    result: row.result || null,

    ts: row.ts || row.createdAt || null
  };
}

function filterByType(logs = [], type = null) {
  if (!type) return logs;

  const wanted = String(type).toUpperCase();

  return logs.filter((log) => String(log.type || '').toUpperCase() === wanted);
}

function buildSummary(logs = []) {
  return logs.reduce((acc, log) => {
    const type = String(log.type || 'UNKNOWN').toUpperCase();

    acc.total += 1;
    acc.byType[type] = (acc.byType[type] || 0) + 1;

    if (log.result?.ok === false) {
      acc.failed += 1;
    }

    if (log.result?.skipped) {
      acc.skipped += 1;
    }

    return acc;
  }, {
    total: 0,
    failed: 0,
    skipped: 0,
    byType: {}
  });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  try {
    if (req.method !== 'GET') {
      return methodNotAllowed(res);
    }

    const limit = clampLimit(req.query?.limit, 100);
    const type = firstQueryValue(req.query?.type, null);

    const redis = getDurableRedis();

    const rawLogs = await readJsonLogs(
      redis,
      KEYS.discord.logList,
      limit
    );

    const normalized = (Array.isArray(rawLogs) ? rawLogs : [])
      .map(normalizeLog);

    const logs = filterByType(normalized, type);

    return res.status(200).json({
      ok: true,

      limit,
      type,

      count: logs.length,
      totalFetched: normalized.length,

      summary: buildSummary(logs),

      logs,

      serverTs: Date.now()
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}
