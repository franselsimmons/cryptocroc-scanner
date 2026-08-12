// ================= FILE: api/analyze/weekly-freeze.js =================
// LONG weekly-freeze hotfix:
// - Vercel cron GET can run the freeze again.
// - Manual GET ?run=1 can run it from a browser.
// - POST always runs it.
// - Uses the authoritative rotationEngine instead of a second, divergent generator.
// - The authoritative generator creates exactly three week-composition proposals.
// - Optional ?activate=1&plan=BALANCED performs freeze + forced activation + plan activation.

import { KEYS } from '../../src/keys.js';
import { getDurableRedis } from '../../src/redis.js';
import { withRedisLock } from '../../src/lock.js';
import {
  freezeWeeklyRotation,
  activateNextRotation,
  activateWeekComposition,
  getRotationDashboard
} from '../../src/analyze/rotationEngine.js';

export const config = {
  maxDuration: 300
};

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const TARGET_SCANNER_SIDE = 'bull';
const REDIS_NAMESPACE = 'LONG';
const REDIS_PREFIX = 'LONG:';
const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';
const DEFAULT_PLAN = 'BALANCED';
const DEFAULT_LOCK_TTL_SEC = 600;
const ALLOWED_PLANS = new Set(['CONSERVATIVE', 'BALANCED', 'PERFORMANCE']);

function now() {
  return Date.now();
}

function header(req, name) {
  const key = String(name || '').toLowerCase();
  const headers = req?.headers || {};
  const direct = headers[key] ?? headers[name];
  if (Array.isArray(direct)) return direct[0] ?? '';
  return String(direct ?? '');
}

function requestUrl(req) {
  try {
    return new URL(String(req?.url || '/'), 'https://localhost');
  } catch {
    return new URL('https://localhost/');
  }
}

function first(value, fallback = null) {
  if (Array.isArray(value)) return value.length ? value[0] : fallback;
  return value === undefined || value === null || value === '' ? fallback : value;
}

function bool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === 0) return value === 1;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on', 'run', 'force', 'enabled'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off', 'disabled'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizePlan(value, fallback = DEFAULT_PLAN) {
  const normalized = String(value || fallback).trim().toUpperCase();
  return ALLOWED_PLANS.has(normalized) ? normalized : fallback;
}

function isVercelCron(req) {
  const userAgent = header(req, 'user-agent').toLowerCase();
  return (
    userAgent.includes('vercel-cron') ||
    bool(header(req, 'x-vercel-cron'), false) ||
    bool(header(req, 'x-vercel-scheduled'), false)
  );
}

function isAuthorized(req, url) {
  const secret = String(process.env.CRON_SECRET || '').trim();
  if (!secret) return true;

  const authorization = header(req, 'authorization');
  const querySecret = String(url.searchParams.get('secret') || '').trim();

  return (
    authorization === `Bearer ${secret}` ||
    querySecret === secret
  );
}

function shouldRun(req, url, body = {}) {
  if (String(req?.method || '').toUpperCase() === 'POST') return true;
  if (isVercelCron(req)) return true;

  const action = String(
    first(body.action, url.searchParams.get('action')) || ''
  ).trim().toUpperCase();

  return (
    bool(first(body.run, url.searchParams.get('run')), false) ||
    bool(first(body.force, url.searchParams.get('force')), false) ||
    ['RUN', 'FREEZE', 'WEEKLY_FREEZE', 'RUN_NOW'].includes(action)
  );
}

function shouldActivate(req, url, body = {}) {
  if (isVercelCron(req)) {
    // Sunday freeze cron builds READY only. Monday activation cron uses the
    // activate-rotation endpoint.
    return false;
  }
  return bool(first(body.activate, url.searchParams.get('activate')), false);
}

function freezeLockKey() {
  // Route-level lock must be different from the authoritative engine lock.
  // This prevents PREVIOUS_LONG_RUN_STILL_ACTIVE when an older engine also
  // protects freezeWeeklyRotation() with ANALYZE:WEEKLY_FREEZE_LOCK.
  return `${REDIS_PREFIX}API:ANALYZE:WEEKLY_FREEZE_ROUTE_LOCK`;
}

async function readBody(req) {
  if (!req || !['POST', 'PUT', 'PATCH'].includes(String(req.method || '').toUpperCase())) {
    return {};
  }

  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }

  if (typeof req.body === 'string' && req.body.trim()) {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  if (typeof req[Symbol.asyncIterator] !== 'function') return {};

  let raw = '';
  for await (const chunk of req) {
    raw += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (raw.length > 1_000_000) {
      const error = new Error('REQUEST_BODY_TOO_LARGE');
      error.statusCode = 413;
      throw error;
    }
  }

  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('INVALID_JSON_BODY');
    error.statusCode = 400;
    throw error;
  }
}

function unwrapLockResult(lockResult) {
  if (
    lockResult &&
    typeof lockResult === 'object' &&
    Object.prototype.hasOwnProperty.call(lockResult, 'result')
  ) {
    return lockResult.result;
  }
  return lockResult || null;
}

function statusForError(error) {
  if (Number.isFinite(error?.statusCode)) return Number(error.statusCode);
  const message = String(error?.message || error || '').toUpperCase();
  if (message.includes('LOCK')) return 409;
  if (
    message.includes('VALIDATION') ||
    message.includes('GENERATION') ||
    message.includes('COMPOSITION') ||
    message.includes('TAXONOMY')
  ) {
    return 422;
  }
  if (
    message.includes('REDIS') ||
    message.includes('UPSTASH') ||
    message.includes('ENV_MISSING') ||
    message.includes('FETCH')
  ) {
    return 503;
  }
  return 500;
}

function responseBase() {
  return {
    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,
    longOnly: true,
    shortDisabled: true,
    virtualOnly: true,
    realOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    redisNamespace: REDIS_NAMESPACE,
    redisKeyPrefix: REDIS_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY
  };
}


function compactFreezeResult(freezeResult = {}) {
  const generation = freezeResult?.rotation?.temporalGeneration || null;
  const proposals = Array.isArray(generation?.weekCompositionProposals)
    ? generation.weekCompositionProposals
    : [];
  return {
    ok: freezeResult?.ok !== false,
    type: freezeResult?.type || null,
    weekKey: freezeResult?.weekKey || null,
    activeWeekKey: freezeResult?.activeWeekKey || null,
    mode: freezeResult?.mode || null,
    rotationId: freezeResult?.rotationId || null,
    temporalGenerationId: freezeResult?.temporalGenerationId || generation?.generationId || null,
    temporalGenerationStatus: freezeResult?.temporalGenerationStatus || generation?.status || null,
    temporalGenerationIntegrity: freezeResult?.temporalGenerationIntegrity || generation?.integrity || null,
    generatedProposalCount: proposals.length,
    generatedProposalModes: proposals.map((proposal) => proposal?.mode).filter(Boolean),
    candidateMicroFamilies: freezeResult?.candidateMicroFamilies ?? null,
    candidateTrueMicroFamilies: freezeResult?.candidateTrueMicroFamilies ?? null,
    empiricalVetoCount: freezeResult?.empiricalVetoCount ?? null,
    nextRotationStorage: freezeResult?.nextRotationStorage || null,
    validFromStorage: freezeResult?.validFromStorage || null
  };
}

function compactActivationResult(activation = {}) {
  return {
    ok: activation?.ok !== false,
    skipped: Boolean(activation?.skipped),
    changed: Boolean(activation?.changed),
    reason: activation?.reason || null,
    generationId: activation?.generationId || null,
    previousGenerationId: activation?.previousGenerationId || null,
    activationWindow: activation?.activationWindow || null
  };
}

function compactCompositionActivation(result = {}) {
  const composition = result?.activeWeekComposition || null;
  return {
    ok: result?.ok !== false,
    changed: Boolean(result?.changed),
    generationId: result?.generationId || null,
    activeWeekCompositionId: result?.activeWeekCompositionId || composition?.compositionId || null,
    activeWeekCompositionMode: composition?.mode || null,
    activeWeekCompositionSummary: composition?.summary || null,
    rotationActivationError: result?.rotationActivationError || null
  };
}

function dashboardSummary(dashboard = {}) {
  const proposals = Array.isArray(dashboard.weekCompositionProposals)
    ? dashboard.weekCompositionProposals
    : [];

  return {
    activeTemporalGenerationId: dashboard.activeTemporalGenerationId || null,
    pendingTemporalGenerationId: dashboard.pendingTemporalGenerationId || null,
    pendingTemporalGenerationStatus: dashboard.pendingTemporalGenerationStatus || null,
    temporalGenerationValidation: dashboard.temporalGenerationValidation || null,
    weekCompositionProposalCount: proposals.length,
    weekCompositionProposals: proposals.map((proposal) => ({
      compositionId: proposal?.compositionId || null,
      mode: proposal?.mode || null,
      title: proposal?.title || null,
      generationId: proposal?.generationId || null,
      familyCount: proposal?.summary?.familyCount ?? proposal?.summary?.familyUnion?.length ?? null,
      activeSlots: proposal?.summary?.activeSlots ?? null
    })),
    activeWeekCompositionId: dashboard.activeWeekCompositionId || null,
    activeWeekCompositionMode: dashboard.activeWeekComposition?.mode || null,
    activeWeekCompositionValidation: dashboard.activeWeekCompositionValidation || null
  };
}

async function getSafeDashboard() {
  try {
    return {
      ok: true,
      dashboard: await getRotationDashboard()
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error),
      details: error?.details || null
    };
  }
}

async function runFreeze({ req, url, body }) {
  const redis = getDurableRedis();
  const cutoffTs = finiteNumber(
    first(body.cutoffTs, url.searchParams.get('cutoffTs')),
    now()
  );
  const freezeSequence = finiteNumber(
    first(body.freezeSequence, url.searchParams.get('freezeSequence')),
    null
  );
  const weekKey = String(
    first(body.weekKey, url.searchParams.get('weekKey')) || PERSISTENT_LEARNING_KEY
  ).trim() || PERSISTENT_LEARNING_KEY;
  const activeWeekKey = first(body.activeWeekKey, url.searchParams.get('activeWeekKey'));
  const mode = first(body.mode, url.searchParams.get('mode'));

  const options = {
    weekKey,
    cutoffTs
  };
  if (activeWeekKey) options.activeWeekKey = String(activeWeekKey).trim();
  if (mode) options.mode = String(mode).trim();
  if (freezeSequence !== null) options.freezeSequence = freezeSequence;

  const lockResult = await withRedisLock(
    redis,
    freezeLockKey(),
    DEFAULT_LOCK_TTL_SEC,
    async () => freezeWeeklyRotation(options)
  );

  if (lockResult?.ok === false) {
    const error = new Error(lockResult.reason || 'WEEKLY_FREEZE_LOCK_NOT_ACQUIRED');
    error.statusCode = 409;
    error.details = lockResult;
    throw error;
  }

  const freezeResult = unwrapLockResult(lockResult);
  if (!freezeResult || freezeResult.ok === false) {
    const error = new Error(
      freezeResult?.reason ||
      freezeResult?.temporalGenerationStatus ||
      'WEEKLY_FREEZE_FAILED'
    );
    error.statusCode = 422;
    error.details = freezeResult;
    throw error;
  }

  let activationResult = null;
  let compositionResult = null;

  if (shouldActivate(req, url, body)) {
    activationResult = await activateNextRotation({
      nowTs: now(),
      force: true,
      expectedActiveGenerationId:
        first(body.expectedActiveGenerationId, url.searchParams.get('expectedActiveGenerationId')) || null
    });

    if (!activationResult?.ok) {
      const error = new Error(
        activationResult?.reason || 'TEMPORAL_GENERATION_FORCE_ACTIVATION_FAILED'
      );
      error.statusCode = 409;
      error.details = activationResult;
      throw error;
    }

    const plan = normalizePlan(
      first(body.plan, url.searchParams.get('plan')),
      DEFAULT_PLAN
    );

    compositionResult = await activateWeekComposition({
      compositionId: plan,
      activatedBy: 'API_WEEKLY_FREEZE_RUN_NOW',
      nowTs: now()
    });
  }

  const dashboardState = await getSafeDashboard();
  const generation = freezeResult?.rotation?.temporalGeneration || null;
  const proposals = Array.isArray(generation?.weekCompositionProposals)
    ? generation.weekCompositionProposals
    : [];

  return {
    freezeResult,
    activationResult,
    compositionResult,
    generatedProposalCount: proposals.length,
    generatedProposalModes: proposals.map((proposal) => proposal?.mode).filter(Boolean),
    dashboardState
  };
}

export default async function handler(req, res) {
  const startedAt = now();
  const method = String(req?.method || 'GET').toUpperCase();
  const url = requestUrl(req);

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Redis-Namespace', REDIS_NAMESPACE);
  res.setHeader('X-Real-Orders-Disabled', 'true');
  res.setHeader('X-Weekly-Freeze-Core', 'rotationEngine.freezeWeeklyRotation');
  res.setHeader('X-Weekly-Freeze-Route-Lock', `${REDIS_PREFIX}API:ANALYZE:WEEKLY_FREEZE_ROUTE_LOCK`);

  if (!['GET', 'POST'].includes(method)) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({
      ok: false,
      error: 'METHOD_NOT_ALLOWED',
      ...responseBase()
    });
  }

  try {
    const body = await readBody(req);

    if (!isAuthorized(req, url)) {
      return res.status(401).json({
        ok: false,
        error: 'UNAUTHORIZED',
        ...responseBase(),
        durationMs: now() - startedAt
      });
    }

    if (!shouldRun(req, url, body)) {
      const dashboardState = await getSafeDashboard();
      const status = dashboardState.ok ? 200 : 503;
      return res.status(status).json({
        ok: dashboardState.ok,
        skipped: true,
        reason: dashboardState.ok
          ? 'STATUS_ONLY_ADD_RUN_1_TO_EXECUTE'
          : 'STATUS_READ_FAILED',
        runNowUrl: '/api/analyze/weekly-freeze?run=1&activate=1&plan=BALANCED',
        ...responseBase(),
        ...(dashboardState.ok
          ? dashboardSummary(dashboardState.dashboard)
          : { error: dashboardState.error, details: dashboardState.details }),
        durationMs: now() - startedAt,
        serverTs: now()
      });
    }

    const result = await runFreeze({ req, url, body });
    const dashboard = result.dashboardState?.dashboard || {};
    const proposalCount = result.dashboardState?.ok
      ? dashboardSummary(dashboard).weekCompositionProposalCount
      : result.generatedProposalCount;

    return res.status(200).json({
      ok: true,
      skipped: false,
      reason: 'LONG_WEEKLY_FREEZE_COMPLETED',
      ...responseBase(),
      freeze: compactFreezeResult(result.freezeResult),
      activation: compactActivationResult(result.activationResult),
      compositionActivation: compactCompositionActivation(result.compositionResult),
      generatedProposalCount: result.generatedProposalCount,
      generatedProposalModes: result.generatedProposalModes,
      activeProposalCount: proposalCount,
      ...(result.dashboardState?.ok
        ? dashboardSummary(dashboard)
        : {
            dashboardReadError: result.dashboardState?.error || null,
            dashboardReadErrorDetails: result.dashboardState?.details || null
          }),
      durationMs: now() - startedAt,
      serverTs: now()
    });
  } catch (error) {
    const status = statusForError(error);
    return res.status(status).json({
      ok: false,
      skipped: false,
      reason: 'LONG_WEEKLY_FREEZE_ERROR',
      error: error?.message || String(error),
      details: error?.details || null,
      ...responseBase(),
      durationMs: now() - startedAt,
      serverTs: now()
    });
  }
}
