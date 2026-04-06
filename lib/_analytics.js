// lib/_analytics.js
import { kv } from "@vercel/kv";

const KEEP = 5000;
const EVENTS_KEY = (funnel) => `cc:events:${String(funnel || "misc").toLowerCase()}:list`;
const DEDUPE_TTL_SEC = 60 * 60 * 6; // 6 uur

const SUMMARY_KEY = (mode) => `cc:analytics:summary:${String(mode || "all").toLowerCase()}`;
const SYMBOL_STATS_KEY = (mode, symbol) =>
  `cc:analytics:symbol:${String(mode || "all").toLowerCase()}:${String(symbol || "?").toUpperCase()}`;
const EXIT_REASON_STATS_KEY = (mode, reason) =>
  `cc:analytics:exit_reason:${String(mode || "all").toLowerCase()}:${String(reason || "unknown").toLowerCase()}`;
const STAGE_STATS_KEY = (mode, stage) =>
  `cc:analytics:stage:${String(mode || "all").toLowerCase()}:${String(stage || "unknown").toUpperCase()}`;
const DAILY_SUMMARY_KEY = (mode, day) =>
  `cc:analytics:daily:${String(mode || "all").toLowerCase()}:${String(day || "unknown")}`;

// ======================================================
// Hulpfuncties
// ======================================================
function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function up(x) {
  return String(x || "").toUpperCase();
}

function low(x) {
  return String(x || "").toLowerCase();
}

function todayKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

function normalizeReason(x) {
  return low(x || "unknown").replace(/\s+/g, "_").slice(0, 80);
}

function normalizeMode(x) {
  return low(x || "all");
}

function normalizeStage(x) {
  return up(x || "unknown");
}

function cloneObj(x) {
  return x && typeof x === "object" && !Array.isArray(x) ? { ...x } : {};
}

function toWinBucket(pnlPct) {
  const p = n(pnlPct, 0);
  if (p > 0.000001) return "win";
  if (p < -0.000001) return "loss";
  return "breakeven";
}

// ======================================================
// Hulpfunctie voor UID
// ======================================================
export function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
}

// ======================================================
// Deduplicatie key
// ======================================================
function dedupeKey(funnel, item) {
  const f = String(funnel || "").toLowerCase();
  const symbol = String(item?.symbol || "?").toUpperCase();

  // Speciale gevallen voor trade_opened en trade_closed:
  // gebruik trade ID zodat meerdere trades voor zelfde symbool mogen
  if (f === "trade_opened") {
    return `cc:dedupe:${f}:${symbol}:${String(item?.id || "")}`;
  }

  if (f === "trade_closed") {
    return `cc:dedupe:${f}:${symbol}:${String(item?.id || "")}:${String(item?.reason || "")}`;
  }

  if (f === "scan_transition") {
    const from = String(item?.from || "").toUpperCase();
    const to = String(item?.to || "").toUpperCase();
    const reason = String(item?.reason || "").slice(0, 120);
    return `cc:dedupe:${f}:${symbol}:${from}->${to}:${reason}`;
  }

  if (f.startsWith("scan_")) {
    const stage = String(item?.stage || "").toUpperCase();
    const prevStage = String(item?.prevStage || "").toUpperCase();
    const reason = String(item?.reason || "").slice(0, 120);
    return `cc:dedupe:${f}:${symbol}:${prevStage}->${stage}:${reason}`;
  }

  const exitReason = String(item?.exitReason || item?.reason || "").slice(0, 120);
  return `cc:dedupe:${f}:${symbol}:${exitReason}`;
}

// ======================================================
// KV helpers
// ======================================================
async function getJson(key, fallback = {}) {
  try {
    const data = await kv.get(key);
    if (data && typeof data === "object" && !Array.isArray(data)) return data;
    return fallback;
  } catch {
    return fallback;
  }
}

async function setJson(key, value, exSec = null) {
  try {
    if (exSec && Number.isFinite(exSec)) {
      await kv.set(key, value, { ex: exSec });
    } else {
      await kv.set(key, value);
    }
  } catch {}
}

function mergeTradeStats(base, patch) {
  const cur = cloneObj(base);
  return {
    tradesOpened: n(cur.tradesOpened) + n(patch.tradesOpened),
    tradesClosed: n(cur.tradesClosed) + n(patch.tradesClosed),

    wins: n(cur.wins) + n(patch.wins),
    losses: n(cur.losses) + n(patch.losses),
    breakevens: n(cur.breakevens) + n(patch.breakevens),

    grossPnlPct: n(cur.grossPnlPct) + n(patch.grossPnlPct),
    grossPnlUsd: n(cur.grossPnlUsd) + n(patch.grossPnlUsd),

    avgWinPct: n(cur.avgWinPct),
    avgLossPct: n(cur.avgLossPct),
    biggestWinPct: Math.max(n(cur.biggestWinPct, -999999), n(patch.biggestWinPct, -999999)),
    biggestLossPct: Math.min(n(cur.biggestLossPct, 999999), n(patch.biggestLossPct, 999999)),

    updatedAt: Date.now(),
  };
}

function finalizeDerivedStats(obj) {
  const out = cloneObj(obj);

  const wins = n(out.wins);
  const losses = n(out.losses);
  const breakevens = n(out.breakevens);
  const tradesClosed = n(out.tradesClosed);

  out.winRate = tradesClosed > 0 ? Number(((wins / tradesClosed) * 100).toFixed(2)) : 0;
  out.lossRate = tradesClosed > 0 ? Number(((losses / tradesClosed) * 100).toFixed(2)) : 0;
  out.breakevenRate = tradesClosed > 0 ? Number(((breakevens / tradesClosed) * 100).toFixed(2)) : 0;
  out.avgPnlPct = tradesClosed > 0 ? Number((n(out.grossPnlPct) / tradesClosed).toFixed(4)) : 0;
  out.avgPnlUsd = tradesClosed > 0 ? Number((n(out.grossPnlUsd) / tradesClosed).toFixed(4)) : 0;

  if (n(out.biggestWinPct, -999999) === -999999) out.biggestWinPct = 0;
  if (n(out.biggestLossPct, 999999) === 999999) out.biggestLossPct = 0;

  return out;
}

async function bumpStatKey(key, patch) {
  const current = await getJson(key, {});
  const next = finalizeDerivedStats(mergeTradeStats(current, patch));
  await setJson(key, next);
  return next;
}

async function updateTradeAnalyticsFromEvent(funnel, event) {
  const f = low(funnel);
  const mode = normalizeMode(event?.mode);
  const symbol = up(event?.symbol || "?");
  const stage = normalizeStage(event?.stage);
  const day = todayKey(event?.ts || Date.now());

  if (f === "trade_opened") {
    const patch = {
      tradesOpened: 1,
      tradesClosed: 0,
      wins: 0,
      losses: 0,
      breakevens: 0,
      grossPnlPct: 0,
      grossPnlUsd: 0,
      biggestWinPct: -999999,
      biggestLossPct: 999999,
    };

    await bumpStatKey(SUMMARY_KEY(mode), patch);
    await bumpStatKey(SYMBOL_STATS_KEY(mode, symbol), patch);
    await bumpStatKey(STAGE_STATS_KEY(mode, stage), patch);
    await bumpStatKey(DAILY_SUMMARY_KEY(mode, day), patch);
    return;
  }

  if (f !== "trade_closed") return;

  const pnlPct = n(event?.pnlPct, 0);
  const pnlUsd = n(event?.pnlUsd, 0);
  const bucket = toWinBucket(pnlPct);
  const exitReason = normalizeReason(event?.exitReason || event?.reason);

  const patch = {
    tradesOpened: 0,
    tradesClosed: 1,
    wins: bucket === "win" ? 1 : 0,
    losses: bucket === "loss" ? 1 : 0,
    breakevens: bucket === "breakeven" ? 1 : 0,
    grossPnlPct: pnlPct,
    grossPnlUsd: pnlUsd,
    biggestWinPct: bucket === "win" ? pnlPct : -999999,
    biggestLossPct: bucket === "loss" ? pnlPct : 999999,
  };

  await bumpStatKey(SUMMARY_KEY(mode), patch);
  await bumpStatKey(SYMBOL_STATS_KEY(mode, symbol), patch);
  await bumpStatKey(EXIT_REASON_STATS_KEY(mode, exitReason), patch);
  await bumpStatKey(STAGE_STATS_KEY(mode, stage), patch);
  await bumpStatKey(DAILY_SUMMARY_KEY(mode, day), patch);
}

// ======================================================
// Push event
// Slaat analytics/logging op in KV.
// ======================================================
export async function pushEvent(funnel, eventData) {
  const dedupe = dedupeKey(funnel, eventData);

  try {
    const ok = await kv.set(dedupe, "1", { nx: true, ex: DEDUPE_TTL_SEC });
    if (!ok) return null;
  } catch {}

  const key = EVENTS_KEY(funnel);

  const event = {
    id: uid("evt"),
    ts: Date.now(),
    ...eventData,
  };

  if (typeof kv.lpush === "function" && typeof kv.ltrim === "function") {
    await kv.lpush(key, JSON.stringify(event));
    await kv.ltrim(key, 0, KEEP - 1);
  } else {
    const prev = (await kv.get(key)) || [];
    const arr = Array.isArray(prev) ? prev : [];
    arr.unshift(event);
    await kv.set(key, arr.slice(0, KEEP));
  }

  await updateTradeAnalyticsFromEvent(funnel, event);

  return event.id;
}

// ======================================================
// Read events
// ======================================================
export async function readEvents(funnel, limit = 2000) {
  const key = EVENTS_KEY(funnel);

  try {
    if (typeof kv.lrange === "function") {
      const raw = await kv.lrange(key, 0, Math.max(0, limit - 1));
      return (raw || [])
        .map((x) => {
          try {
            return typeof x === "string" ? JSON.parse(x) : x;
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    }
  } catch {}

  const data = await kv.get(key);
  return Array.isArray(data) ? data.slice(0, limit) : [];
}

// ======================================================
// Read analytics summary
// ======================================================
export async function readAnalyticsSummary(mode = "all") {
  const summary = await getJson(SUMMARY_KEY(mode), {});
  return finalizeDerivedStats(summary);
}

export async function readSymbolAnalytics(mode = "all", symbol) {
  return finalizeDerivedStats(await getJson(SYMBOL_STATS_KEY(mode, symbol), {}));
}

export async function readExitReasonAnalytics(mode = "all", reason) {
  return finalizeDerivedStats(await getJson(EXIT_REASON_STATS_KEY(mode, normalizeReason(reason)), {}));
}

export async function readStageAnalytics(mode = "all", stage) {
  return finalizeDerivedStats(await getJson(STAGE_STATS_KEY(mode, stage), {}));
}

export async function readDailyAnalytics(mode = "all", day) {
  return finalizeDerivedStats(await getJson(DAILY_SUMMARY_KEY(mode, day), {}));
}