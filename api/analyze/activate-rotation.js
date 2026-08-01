// ================= FILE: api/analyze/activate-rotation.js =================
// LONG activation hotfix:
// - Vercel cron GET activates again.
// - Manual GET ?run=1&force=1&plan=BALANCED works from a browser.
// - POST always activates.
// - Uses rotationEngine.activateNextRotation as the sole generation activator.
// - Activates one of the three authoritative week-composition proposals.

import { KEYS } from '../../src/keys.js';
import { getDurableRedis } from '../../src/redis.js';
import { withRedisLock } from '../../src/lock.js';
import {
  activateNextRotation,
  activateWeekComposition,
  getRotationDashboard
} from '../../src/analyze/rotationEngine.js';

export const config = {
  maxDuration: 60
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
  return authorization === `Bearer ${secret}` || querySecret === secret;
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
    ['RUN', 'ACTIVATE', 'ACTIVATE_ROTATION', 'ACTIVATE_TEMPORAL_GENERATION', 'RUN_NOW'].includes(action)
  );
}

function activateLockKey() {
  const candidate =
    KEYS?.long?.analyze?.activateLock ||
    KEYS?.analyze?.longActivateLock ||
    KEYS?.analyze?.activateLock ||
    `${REDIS_PREFIX}ANALYZE:ACTIVATE_ROTATION_LOCK`;

  const value = typeof candidate === 'function' ? candidate() : candidate;
  const text = String(value || '').trim();
  if (!text) return `${REDIS_PREFIX}ANALYZE:ACTIVATE_ROTATION_LOCK`;
  if (text.startsWith(REDIS_PREFIX)) return text;
  if (text.startsWith('SHORT:')) return `${REDIS_PREFIX}${text.slice('SHORT:'.length)}`;
  return `${REDIS_PREFIX}${text.replace(/^:+/, '')}`;
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
  if (message.includes('LOCK') || message.includes('CAS') || message.includes('WINDOW')) {
    return 409;
  }
  if (
    message.includes('VALIDATION') ||
    message.includes('GENERATION') ||
    message.includes('COMPOSITION') ||
    message.includes('PROPOSAL')
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
    return { ok: true, dashboard: await getRotationDashboard() };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error),
      details: error?.details || null
    };
  }
}

async function runActivation({ url, body }) {
  const redis = getDurableRedis();
  const force = bool(first(body.force, url.searchParams.get('force')), true);
  const plan = normalizePlan(first(body.plan, url.searchParams.get('plan')), DEFAULT_PLAN);
  const activatePlan = bool(
    first(body.activatePlan, url.searchParams.get('activatePlan')),
    true
  );
  const expectedActiveGenerationId =
    first(body.expectedActiveGenerationId, url.searchParams.get('expectedActiveGenerationId')) || null;

  const lockResult = await withRedisLock(
    redis,
    activateLockKey(),
    DEFAULT_LOCK_TTL_SEC,
    async () => {
      const activation = await activateNextRotation({
        nowTs: now(),
        force,
        expectedActiveGenerationId
      });

      let dashboardAfterGeneration = await getRotationDashboard();
      const activeGenerationAvailable = Boolean(
        dashboardAfterGeneration?.activeTemporalGenerationId &&
        dashboardAfterGeneration?.temporalGenerationValidation?.valid
      );

      if (!activation?.ok && !activeGenerationAvailable) {
        const error = new Error(
          activation?.reason || 'TEMPORAL_GENERATION_ACTIVATION_FAILED'
        );
        error.statusCode = 409;
        error.details = activation;
        throw error;
      }

      let compositionActivation = null;
      if (activatePlan) {
        compositionActivation = await activateWeekComposition({
          compositionId: plan,
          activatedBy: 'API_ACTIVATE_ROTATION_RUN_NOW',
          nowTs: now()
        });
      }

      const dashboard = await getRotationDashboard();
      return {
        activation,
        compositionActivation,
        requestedPlan: plan,
        dashboard
      };
    }
  );

  if (lockResult?.ok === false) {
    const error = new Error(lockResult.reason || 'ACTIVATION_LOCK_NOT_ACQUIRED');
    error.statusCode = 409;
    error.details = lockResult;
    throw error;
  }

  return unwrapLockResult(lockResult);
}

export default async function handler(req, res) {
  const startedAt = now();
  const method = String(req?.method || 'GET').toUpperCase();
  const url = requestUrl(req);

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Redis-Namespace', REDIS_NAMESPACE);
  res.setHeader('X-Real-Orders-Disabled', 'true');
  res.setHeader('X-Activation-Core', 'rotationEngine.activateNextRotation');

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
        runNowUrl: '/api/analyze/activate-rotation?run=1&force=1&plan=BALANCED',
        ...responseBase(),
        ...(dashboardState.ok
          ? dashboardSummary(dashboardState.dashboard)
          : { error: dashboardState.error, details: dashboardState.details }),
        durationMs: now() - startedAt,
        serverTs: now()
      });
    }

    const result = await runActivation({ url, body });
    const summary = dashboardSummary(result?.dashboard || {});
    const complete = Boolean(
      summary.activeTemporalGenerationId &&
      summary.weekCompositionProposalCount === 3 &&
      summary.activeWeekCompositionId
    );

    return res.status(complete ? 200 : 422).json({
      ok: complete,
      skipped: false,
      reason: complete
        ? 'LONG_TEMPORAL_GENERATION_AND_WEEK_PLAN_ACTIVE'
        : 'ACTIVATION_COMPLETED_BUT_DASHBOARD_CONTRACT_INCOMPLETE',
      ...responseBase(),
      activation: result?.activation || null,
      compositionActivation: result?.compositionActivation || null,
      requestedPlan: result?.requestedPlan || DEFAULT_PLAN,
      ...summary,
      durationMs: now() - startedAt,
      serverTs: now()
    });
  } catch (error) {
    const status = statusForError(error);
    return res.status(status).json({
      ok: false,
      skipped: false,
      reason: 'LONG_ACTIVATE_ROTATION_ERROR',
      error: error?.message || String(error),
      details: error?.details || null,
      ...responseBase(),
      durationMs: now() - startedAt,
      serverTs: now()
    });
  }
}
