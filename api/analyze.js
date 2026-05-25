import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getLatestScan } from "../lib/scanStore.js";

const SYSTEM_PROFILE = "RUNNER";

const ENDPOINT = "/api/analyze";
const OBJECTIVE = "RUNNER_PNL_FIRST";
const STRATEGY = "50_LONG_FAMILIES_PLUS_50_SHORT_FAMILIES";

const STORE_KEY = "runner:analyze:store:v1:events";
const LEGACY_STORE_KEY = "runner:analyze:store:v1";
const STORE_PATH =
  process.env.RUNNER_ANALYZE_STORE_PATH ||
  path.join(os.tmpdir(), "runner-analyze-events.json");

const MAX_STORED_EVENTS = 50000;
const MAX_EXAMPLES_PER_FAMILY = 8;

const DEFAULT_MIN_CLOSED = 10;
const DEFAULT_BREAKEVEN_R_EPS = 0.05;
const DEFAULT_MIN_WINRATE = 0.35;

const QUALITY_BUCKETS = [
  { index: 1, key: "Q1_WEAK", conf: "CONF_0_50", sniper: "SNIPER_0_50", rr: "RR_LT_1p00", score: "SCORE_0_50" },
  { index: 2, key: "Q2_LOW", conf: "CONF_50_65", sniper: "SNIPER_50_65", rr: "RR_1p00_1p20", score: "SCORE_50_65" },
  { index: 3, key: "Q3_BASE", conf: "CONF_65_75", sniper: "SNIPER_65_75", rr: "RR_1p20_1p50", score: "SCORE_65_75" },
  { index: 4, key: "Q4_STRONG", conf: "CONF_75_85", sniper: "SNIPER_75_85", rr: "RR_1p50_2p00", score: "SCORE_75_85" },
  { index: 5, key: "Q5_ELITE", conf: "CONF_85_100", sniper: "SNIPER_85_100", rr: "RR_2p00_PLUS", score: "SCORE_85_100" },
];

const MARKET_BUCKETS = [
  { index: 1, key: "M1_DIRTY", ob: "OB_REL_AGAINST", spread: "SPREAD_GT_25BPS", depth: "DEPTH_LT_10K", btc: "BTC_REL_COUNTER", funding: "FUNDING_CROWDED" },
  { index: 2, key: "M2_WEAK", ob: "OB_REL_AGAINST_OR_NEUTRAL", spread: "SPREAD_16_25BPS", depth: "DEPTH_10K_50K", btc: "BTC_REL_COUNTER", funding: "FUNDING_EDGE_WEAK" },
  { index: 3, key: "M3_NORMAL", ob: "OB_REL_NEUTRAL", spread: "SPREAD_8_16BPS", depth: "DEPTH_50K_100K", btc: "BTC_REL_NEUTRAL", funding: "FUNDING_NEUTRAL" },
  { index: 4, key: "M4_CLEAN", ob: "OB_REL_WITH_OR_NEUTRAL", spread: "SPREAD_5_12BPS", depth: "DEPTH_100K_250K", btc: "BTC_REL_WITH_OR_NEUTRAL", funding: "FUNDING_OK" },
  { index: 5, key: "M5_PREMIUM", ob: "OB_REL_WITH", spread: "SPREAD_LT_8BPS", depth: "DEPTH_GT_250K", btc: "BTC_REL_WITH", funding: "FUNDING_OPTIMAL" },
];

const TIMING_BUCKETS = [
  { index: 1, key: "T1_EARLY_OR_NOISY" },
  { index: 2, key: "T2_TIMED" },
];

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeNumber(value, fallback = 0) {
  if (typeof value === "string") {
    const n = Number(value.replace("%", "").replace(",", ".").trim());
    return Number.isFinite(n) ? n : fallback;
  }

  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, decimals = 3) {
  const p = 10 ** decimals;
  return Math.round(safeNumber(value, 0) * p) / p;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getRequestUrl(req) {
  const host = req?.headers?.host || "localhost";
  const proto = req?.headers?.["x-forwarded-proto"] || "https";
  return new URL(req?.url || "/", `${proto}://${host}`);
}

function getQueryParam(req, key, fallback = "") {
  try {
    return getRequestUrl(req).searchParams.get(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;

  const v = String(value).trim().toLowerCase();

  if (["true", "1", "yes", "y", "on"].includes(v)) return true;
  if (["false", "0", "no", "n", "off"].includes(v)) return false;

  return fallback;
}

function normalizeSide(value) {
  const s = String(value || "").trim().toUpperCase();

  if (["BULL", "LONG", "BUY"].includes(s)) return "LONG";
  if (["BEAR", "SHORT", "SELL"].includes(s)) return "SHORT";

  return "";
}

function normalizeSymbol(value) {
  return String(value || "")
    .toUpperCase()
    .trim()
    .replace(/_UMCBL$/, "")
    .replace(/_DMCBL$/, "")
    .replace(/_CMCBL$/, "")
    .replace(/-UMCBL$/, "")
    .replace(/-DMCBL$/, "")
    .replace(/-CMCBL$/, "")
    .replace(/USDT$/, "")
    .replace(/USDC$/, "");
}

function normalizeAction(value) {
  return String(value || "").trim().toUpperCase();
}

function parseJsonLoose(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return fallback;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function extractEventsFromContainer(value) {
  const parsed = parseJsonLoose(value, value);

  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") return [];

  for (const key of ["events", "records", "rows", "trades", "actions", "data", "items"]) {
    if (Array.isArray(parsed[key])) return parsed[key];
  }

  return [];
}

function normalizeEventArray(value) {
  return extractEventsFromContainer(value)
    .map(item => parseJsonLoose(item, item))
    .filter(item => item && typeof item === "object" && !Array.isArray(item));
}

function eventKey(event) {
  const symbol = normalizeSymbol(event?.symbol);
  const side = normalizeSide(event?.side);
  const action = normalizeAction(event?.action);

  return [
    event?.tradeId || event?.id || "",
    event?.runId || "",
    symbol,
    side,
    action,
    event?.entryType || event?.runnerEntryType || "",
    event?.setupClass || "",
    event?.entry ?? "",
    event?.exit ?? event?.exitPrice ?? "",
    event?.exitReason || event?.reason || "",
    event?.resultR ?? event?.realizedR ?? event?.exitR ?? event?.pnlR ?? "",
    event?.pnlPct ?? "",
    event?.ts || event?.closedAt || event?.createdAt || event?.updatedAt || "",
  ].join("|");
}

function uniqueEvents(events) {
  const out = [];
  const seen = new Set();

  for (const event of safeArray(events)) {
    const key = eventKey(event);
    if (seen.has(key)) continue;

    seen.add(key);
    out.push(event);
  }

  return out;
}

function getRedisConfig() {
  const url =
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.REDIS_REST_API_URL ||
    "";

  const token =
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.REDIS_REST_API_TOKEN ||
    "";

  if (!url || !token) return null;

  return {
    url: url.replace(/\/+$/, ""),
    token,
  };
}

async function redisPost(command) {
  const cfg = getRedisConfig();
  if (!cfg) return null;

  const response = await fetch(cfg.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(command),
  });

  if (!response.ok) {
    throw new Error(`redis_command_failed_${response.status}`);
  }

  return response.json();
}

async function redisGet(key) {
  const payload = await redisPost(["GET", key]);
  return payload?.result ?? null;
}

async function redisSet(key, value) {
  const payload = await redisPost(["SET", key, value]);
  return payload?.result ?? null;
}

async function redisDel(key) {
  const payload = await redisPost(["DEL", key]);
  return payload?.result ?? null;
}

async function loadJsonFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return parseJsonLoose(raw, null);
  } catch {
    return null;
  }
}

async function writeJsonFile(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload), "utf8");
}

async function deleteFileIfExists(filePath) {
  try {
    await fs.unlink(filePath);
  } catch {
    // ignore
  }
}

async function loadRunnerAnalyzeStore() {
  const redisEnabled = Boolean(getRedisConfig());
  const fileEnabled = true;
  const loadedAt = Date.now();

  const redisEvents = [];
  let redisError = null;

  if (redisEnabled) {
    try {
      redisEvents.push(...normalizeEventArray(await redisGet(STORE_KEY)));
      redisEvents.push(...normalizeEventArray(await redisGet(LEGACY_STORE_KEY)));
    } catch (error) {
      redisError = error?.message || String(error);
    }
  }

  const filePayload = await loadJsonFile(STORE_PATH);
  const fileEvents = normalizeEventArray(filePayload);

  const events = uniqueEvents([...redisEvents, ...fileEvents]).slice(-MAX_STORED_EVENTS);

  return {
    ok: true,
    mode: "RUNNER_ANALYZE_STORE",
    storeSource: "runner_analyze_store",
    redisKey: STORE_KEY,
    legacyRedisKey: LEGACY_STORE_KEY,
    path: STORE_PATH,
    redisEnabled,
    fileEnabled,
    redisError,
    loadedAt,
    lastPersistAt: safeNumber(filePayload?.lastPersistAt, 0),
    events,
  };
}

async function persistRunnerAnalyzeStore(events) {
  const payload = {
    ok: true,
    version: 1,
    profile: SYSTEM_PROFILE,
    lastPersistAt: Date.now(),
    maxStoredEvents: MAX_STORED_EVENTS,
    events: uniqueEvents(events).slice(-MAX_STORED_EVENTS),
  };

  const redisEnabled = Boolean(getRedisConfig());
  let redisError = null;

  if (redisEnabled) {
    try {
      await redisSet(STORE_KEY, JSON.stringify(payload));
    } catch (error) {
      redisError = error?.message || String(error);
    }
  }

  await writeJsonFile(STORE_PATH, payload);

  return {
    ok: true,
    count: payload.events.length,
    redisEnabled,
    redisError,
    filePath: STORE_PATH,
    persistedAt: payload.lastPersistAt,
  };
}

async function resetRunnerAnalyzeStore() {
  const redisEnabled = Boolean(getRedisConfig());

  if (redisEnabled) {
    await Promise.allSettled([
      redisDel(STORE_KEY),
      redisDel(LEGACY_STORE_KEY),
    ]);
  }

  await deleteFileIfExists(STORE_PATH);

  return {
    ok: true,
    resetAt: Date.now(),
    redisEnabled,
    filePath: STORE_PATH,
  };
}

async function loadLatestEvents({ includeLatest = true } = {}) {
  if (!includeLatest) {
    return {
      ok: true,
      count: 0,
      events: [],
      note: "includeLatest=false",
    };
  }

  try {
    const latest = await getLatestScan();

    if (!latest?.ok) {
      return {
        ok: false,
        count: 0,
        events: [],
        error: "latest_scan_not_ok",
      };
    }

    const events = uniqueEvents([
      ...safeArray(latest?.tradeSystemResult?.actions),
      ...safeArray(latest?.tradeSystemResult?.openPositions).map(row => ({
        ...row,
        action: row?.action || "HOLD",
        closed: false,
      })),
      ...safeArray(latest?.trades),
      ...safeArray(latest?.dashboardStats?.tradeRows),
      ...safeArray(latest?.dashboardStats?.entryRows),
    ]);

    return {
      ok: true,
      count: events.length,
      updatedAt: latest?.updatedAt || latest?.tradeFunnelUpdatedAt || latest?.scannerUpdatedAt || 0,
      events,
      note: "latest scan OK",
    };
  } catch (error) {
    return {
      ok: false,
      count: 0,
      events: [],
      error: error?.message || String(error),
    };
  }
}

function bucketScore01To5(value) {
  const n = safeNumber(value, 0);

  if (n >= 85) return 5;
  if (n >= 75) return 4;
  if (n >= 65) return 3;
  if (n >= 50) return 2;

  return 1;
}

function bucketRr(value) {
  const n = safeNumber(value, 0);

  if (n >= 2) return 5;
  if (n >= 1.5) return 4;
  if (n >= 1.2) return 3;
  if (n >= 1) return 2;

  return 1;
}

function getPlannedR(row) {
  return safeNumber(
    row?.plannedRR ??
      row?.targetR ??
      row?.rr ??
      row?.riskReward ??
      row?.rMultiple,
    0
  );
}

function getQualityIndex(row) {
  const confluence = bucketScore01To5(row?.confluence);
  const sniper = bucketScore01To5(row?.sniperScore);
  const rr = bucketRr(getPlannedR(row));
  const score = bucketScore01To5(row?.score ?? row?.moveScore);

  return clamp(Math.min(confluence, sniper, rr, score), 1, 5);
}

function getSpreadBps(row) {
  if (Number.isFinite(Number(row?.spreadBps))) return Number(row.spreadBps);
  if (Number.isFinite(Number(row?.spreadPct))) return Number(row.spreadPct) * 10000;

  return 999;
}

function getSpreadIndex(row) {
  const bps = getSpreadBps(row);

  if (bps <= 5) return 5;
  if (bps <= 12) return 4;
  if (bps <= 16) return 3;
  if (bps <= 25) return 2;

  return 1;
}

function getDepthIndex(row) {
  const depth = safeNumber(row?.depthMinUsd1p ?? row?.depthUsd ?? row?.depth, 0);

  if (depth >= 250000) return 5;
  if (depth >= 100000) return 4;
  if (depth >= 50000) return 3;
  if (depth >= 10000) return 2;

  return 1;
}

function getObIndex(row, side) {
  const ob = String(row?.obBias || row?.orderbookBias || "NEUTRAL").toUpperCase();

  if (ob === "NEUTRAL") return 3;

  const withSide =
    (side === "LONG" && ob === "BULLISH") ||
    (side === "SHORT" && ob === "BEARISH");

  return withSide ? 5 : 1;
}

function getBtcIndex(row, side) {
  const rel = String(row?.btcRel || row?.btcRelation || "").toUpperCase();

  if (["WITH", "ALIGNED"].includes(rel)) return 5;
  if (["COUNTER", "AGAINST"].includes(rel)) return 1;
  if (["NEUTRAL", "FLAT"].includes(rel)) return 3;

  const state = String(row?.btcState || row?.btc?.state || "NEUTRAL").toUpperCase();

  if (state === "NEUTRAL" || state === "UNKNOWN") return 3;

  const withSide =
    (side === "LONG" && state.includes("BULL")) ||
    (side === "SHORT" && state.includes("BEAR"));

  return withSide ? 5 : 1;
}

function getFundingIndex(row, side) {
  const funding = safeNumber(row?.fundingRate ?? row?.funding, 0);
  const directional = side === "SHORT" ? -funding : funding;

  if (directional <= -0.00035) return 5;
  if (directional <= -0.0001) return 4;
  if (Math.abs(directional) <= 0.00015) return 3;
  if (directional <= 0.0004) return 2;

  return 1;
}

function getMarketIndex(row, side) {
  const parts = [
    getObIndex(row, side),
    getSpreadIndex(row),
    getDepthIndex(row),
    getBtcIndex(row, side),
    getFundingIndex(row, side),
  ];

  const avg = parts.reduce((sum, n) => sum + n, 0) / parts.length;

  return clamp(Math.round(avg), 1, 5);
}

function isRunnerTrendFlow(flow) {
  const f = String(flow || "").toUpperCase();

  return ["SQUEEZE", "RUNNING", "BREAKOUT", "BUILDING", "TREND", "TRENDING"].includes(f);
}

function isStageEntryOrAlmost(stage, action) {
  const s = String(stage || "").toLowerCase();

  if (s === "entry" || s === "almost") return true;

  return ["ENTRY", "HOLD", "PARTIAL_TP", "MOVE_BE", "TRAIL", "EXIT"].includes(action);
}

function isRsiTimed(row, side) {
  const zone = String(row?.rsiZone || "").toUpperCase();
  const rsi = safeNumber(row?.rsi, 50);

  if (side === "LONG") {
    if (zone.includes("LOWER") || zone === "MID") return true;
    return rsi <= 65;
  }

  if (zone.includes("UPPER") || zone === "MID") return true;
  return rsi >= 35;
}

function isTfAligned(row, side) {
  if (row?.tfAligned === false) return false;

  const tfScore = safeNumber(row?.tfScore, 0);
  const tfStrength = safeNumber(row?.tfStrength, Math.abs(tfScore));

  if (tfStrength >= 3) return true;
  if (side === "LONG" && tfScore > 0) return true;
  if (side === "SHORT" && tfScore < 0) return true;

  return false;
}

function hasPullbackOrConfirmation(row) {
  if (row?.pullbackOk === false) return false;
  if (row?.confirmationOk === false) return false;

  return true;
}

function getTimingIndex(row, side) {
  const action = normalizeAction(row?.action);
  const stage = String(row?.stage || row?.scannerStage || "").toLowerCase();
  const flow = String(row?.flow || row?.scannerFlow || "NEUTRAL").toUpperCase();

  const timed =
    isStageEntryOrAlmost(stage, action) &&
    isRunnerTrendFlow(flow) &&
    isRsiTimed(row, side) &&
    isTfAligned(row, side) &&
    hasPullbackOrConfirmation(row);

  return timed ? 2 : 1;
}

function familyIndex({ qualityIndex, marketIndex, timingIndex }) {
  return ((qualityIndex - 1) * 10) + ((marketIndex - 1) * 2) + timingIndex;
}

function getFamilyId(row) {
  const side = normalizeSide(row?.side);
  if (!side) return null;

  const qualityIndex = getQualityIndex(row);
  const marketIndex = getMarketIndex(row, side);
  const timingIndex = getTimingIndex(row, side);
  const index = familyIndex({ qualityIndex, marketIndex, timingIndex });

  return `${side}_${index}`;
}

function buildTimingLabels(side, timingIndex) {
  if (timingIndex === 1) {
    return ["STAGE_ANY", "FLOW_ANY", "RSI_ANY", "TF_ANY", "PULLBACK_NOT_REQUIRED"];
  }

  return [
    "STAGE_ENTRY_OR_ALMOST",
    "FLOW_TREND_OR_BUILDING",
    side === "SHORT" ? "RSI_UPPER_OR_MID" : "RSI_LOWER_OR_MID",
    "TF_ALIGNED",
    "PULLBACK_OR_CONFIRMATION_OK",
  ];
}

function buildDefinition({ side, qualityIndex, marketIndex, timingIndex }) {
  const q = QUALITY_BUCKETS[qualityIndex - 1];
  const m = MARKET_BUCKETS[marketIndex - 1];
  const t = TIMING_BUCKETS[timingIndex - 1];
  const timingLabels = buildTimingLabels(side, timingIndex);

  return [
    q.key,
    m.key,
    t.key,
    q.conf,
    q.sniper,
    q.rr,
    q.score,
    timingLabels[0],
    timingLabels[1],
    timingLabels[2],
    m.ob,
    m.spread,
    m.depth,
    m.btc,
    m.funding,
    timingLabels[3],
    timingLabels[4],
  ];
}

function buildFamily(side, qualityIndex, marketIndex, timingIndex) {
  const index = familyIndex({ qualityIndex, marketIndex, timingIndex });
  const id = `${side}_${index}`;
  const labels = buildDefinition({ side, qualityIndex, marketIndex, timingIndex });

  return {
    id,
    familyId: id,
    index,
    side,
    quality: QUALITY_BUCKETS[qualityIndex - 1].key,
    qualityBucket: QUALITY_BUCKETS[qualityIndex - 1].key,
    qualityIndex,
    market: MARKET_BUCKETS[marketIndex - 1].key,
    marketBucket: MARKET_BUCKETS[marketIndex - 1].key,
    marketIndex,
    timing: TIMING_BUCKETS[timingIndex - 1].key,
    timingBucket: TIMING_BUCKETS[timingIndex - 1].key,
    timingIndex,
    definition: labels.join(" | "),
    labels,

    observed: 0,
    trades: 0,
    closed: 0,
    open: 0,
    pending: 0,
    pendingOutcome: 0,

    wins: 0,
    losses: 0,
    breakeven: 0,

    winrate: "0%",
    winrateNum: 0,

    totalR: 0,
    avgR: 0,
    totalPnlPct: 0,
    avgPnlPct: 0,

    grossWinR: 0,
    grossLossR: 0,
    profitFactor: 0,
    profitFactorR: 0,
    pf: 0,

    avgMfeR: 0,
    avgMaeR: 0,

    status: "EMPTY",
    score: 0,
    examples: [],
  };
}

function buildFamilies() {
  const long = [];
  const short = [];

  for (const side of ["LONG", "SHORT"]) {
    for (const q of QUALITY_BUCKETS) {
      for (const m of MARKET_BUCKETS) {
        for (const t of TIMING_BUCKETS) {
          const family = buildFamily(side, q.index, m.index, t.index);

          if (side === "LONG") long.push(family);
          else short.push(family);
        }
      }
    }
  }

  const all = [...long, ...short];
  const byId = new Map(all.map(family => [family.id, family]));

  return { all, long, short, byId };
}

function isPerformanceEvent(row) {
  const action = normalizeAction(row?.action);

  if (!row || typeof row !== "object") return false;
  if (!normalizeSide(row?.side)) return false;
  if (!normalizeSymbol(row?.symbol)) return false;

  if (row?.closed === true) return true;

  if (["ENTRY", "HOLD", "PARTIAL_TP", "MOVE_BE", "TRAIL", "ADD", "EXIT", "TP", "SL"].includes(action)) {
    return true;
  }

  if (
    row?.exitReason ||
    row?.resultR !== undefined ||
    row?.realizedR !== undefined ||
    row?.exitR !== undefined
  ) {
    return true;
  }

  return false;
}

function isClosedEvent(row) {
  const action = normalizeAction(row?.action);

  if (row?.closed === true) return true;
  if (["EXIT", "TP", "SL"].includes(action)) return true;
  if (row?.exitReason && row?.exitReason !== "RUNNING") return true;

  return false;
}

function isOpenEvent(row) {
  const action = normalizeAction(row?.action);

  if (isClosedEvent(row)) return false;

  return ["ENTRY", "HOLD", "PARTIAL_TP", "MOVE_BE", "TRAIL", "ADD"].includes(action);
}

function getResultR(row, closed) {
  for (const value of [row?.resultR, row?.realizedR, row?.exitR, row?.pnlR, row?.r]) {
    const n = safeNumber(value, Number.NaN);
    if (Number.isFinite(n)) return n;
  }

  if (closed) {
    const currentR = safeNumber(row?.currentR, Number.NaN);
    if (Number.isFinite(currentR)) return currentR;
  }

  return 0;
}

function getPnlPct(row) {
  for (const value of [row?.pnlPct, row?.totalPnlPct, row?.profitPct, row?.pnlPercent]) {
    const n = safeNumber(value, Number.NaN);
    if (Number.isFinite(n)) return n;
  }

  return 0;
}

function compactExample(row, normalized) {
  return {
    tradeId: row?.tradeId || row?.id || normalized.tradeId,
    symbol: normalized.symbol,
    side: normalized.side,
    action: normalizeAction(row?.action),
    closed: normalized.closed,
    resultR: normalized.resultR,
    pnlPct: normalized.pnlPct,
    exitReason: row?.exitReason || row?.reason || null,
    entryType: row?.entryType || row?.runnerEntryType || null,
    setupClass: row?.setupClass || null,
    ts: row?.ts || row?.closedAt || row?.createdAt || null,
  };
}

function normalizePerformanceEvent(row) {
  const symbol = normalizeSymbol(row?.symbol);
  const side = normalizeSide(row?.side);
  const familyId = getFamilyId(row);

  if (!symbol || !side || !familyId) return null;

  const closed = isClosedEvent(row);
  const open = isOpenEvent(row);
  const resultR = getResultR(row, closed);
  const pnlPct = getPnlPct(row);

  const tradeId =
    row?.tradeId ||
    row?.id ||
    `RUNNER_${symbol}_${side}_${row?.entry || ""}_${row?.ts || row?.closedAt || ""}`;

  return {
    raw: row,
    tradeId,
    symbol,
    side,
    familyId,
    closed,
    open,
    pending: !closed && !open,
    resultR,
    pnlPct,
    mfeR: safeNumber(row?.mfeR, 0),
    maeR: safeNumber(row?.maeR, 0),
  };
}

function classifyFamilyStatus(family, config) {
  if (family.observed <= 0) return "EMPTY";
  if (family.closed < config.minClosed) return "COLLECTING";

  if (family.totalR <= 0 || family.avgR <= 0 || family.totalPnlPct <= 0) return "BAD";

  if (
    family.closed >= Math.max(config.minClosed * 4, 40) &&
    family.totalPnlPct >= 25 &&
    family.avgR >= 0.25 &&
    family.winrateNum >= 0.48 &&
    family.pf >= 1.8
  ) {
    return "HOT";
  }

  if (
    family.winrateNum >= config.minWinrate &&
    family.avgR >= 0.1 &&
    family.pf >= 1.15
  ) {
    return "GOOD";
  }

  if (family.winrateNum >= 0.25 && family.avgR > 0 && family.totalR > 0) {
    return "STABLE";
  }

  return "BAD";
}

function finalizeFamily(family, config) {
  family.pendingOutcome = Math.max(0, family.observed - family.closed - family.open);
  family.pending = family.pendingOutcome;

  family.winrateNum = family.closed > 0 ? family.wins / family.closed : 0;
  family.winrate = `${round(family.winrateNum * 100, 1)}%`;

  family.totalR = round(family.totalR, 3);
  family.avgR = family.closed > 0 ? round(family.totalR / family.closed, 3) : 0;

  family.totalPnlPct = round(family.totalPnlPct, 3);
  family.avgPnlPct = family.closed > 0 ? round(family.totalPnlPct / family.closed, 3) : 0;

  family.grossWinR = round(family.grossWinR, 3);
  family.grossLossR = round(family.grossLossR, 3);

  family.profitFactor =
    family.grossLossR > 0
      ? round(family.grossWinR / family.grossLossR, 3)
      : family.grossWinR > 0
        ? round(family.grossWinR, 3)
        : 0;

  family.pf = family.profitFactor;
  family.profitFactorR = family.profitFactor;

  family.avgMfeR = family.closed > 0 ? round(family.avgMfeR / family.closed, 3) : 0;
  family.avgMaeR = family.closed > 0 ? round(family.avgMaeR / family.closed, 3) : 0;

  family.status = classifyFamilyStatus(family, config);

  family.score = round(
    family.totalPnlPct * 5 +
      family.totalR * 3 +
      family.avgR * 50 +
      family.winrateNum * 25 +
      Math.log10(Math.max(family.closed, 1)) * 8 +
      family.pf * 6,
    3
  );

  return family;
}

function rankPnlFirst(a, b) {
  const pnl = safeNumber(b.totalPnlPct, 0) - safeNumber(a.totalPnlPct, 0);
  if (pnl !== 0) return pnl;

  const totalR = safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0);
  if (totalR !== 0) return totalR;

  const avgR = safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0);
  if (avgR !== 0) return avgR;

  const pf = safeNumber(b.pf ?? b.profitFactor, 0) - safeNumber(a.pf ?? a.profitFactor, 0);
  if (pf !== 0) return pf;

  const closed = safeNumber(b.closed, 0) - safeNumber(a.closed, 0);
  if (closed !== 0) return closed;

  return String(a.id).localeCompare(String(b.id));
}

function rankFamilyTable(a, b) {
  const statusRank = {
    HOT: 6,
    GOOD: 5,
    STABLE: 4,
    COLLECTING: 3,
    BAD: 2,
    EMPTY: 1,
  };

  const status = (statusRank[b.status] || 0) - (statusRank[a.status] || 0);
  if (status !== 0) return status;

  return rankPnlFirst(a, b);
}

function summarizeStatuses(rows) {
  const out = {
    count: safeArray(rows).length,
    total: safeArray(rows).length,
    HOT: 0,
    GOOD: 0,
    STABLE: 0,
    BAD: 0,
    COLLECTING: 0,
    EMPTY: 0,
  };

  for (const row of safeArray(rows)) {
    const status = String(row.status || "EMPTY").toUpperCase();
    if (out[status] === undefined) out[status] = 0;
    out[status] += 1;
  }

  out.text = `HOT ${out.HOT} | GOOD ${out.GOOD} | STABLE ${out.STABLE} | BAD ${out.BAD} | COLLECTING ${out.COLLECTING} | EMPTY ${out.EMPTY}`;

  return out;
}

function buildFilterValues() {
  return {
    trackedFields: [
      "side",
      "quality",
      "market",
      "timing",
      "confluence",
      "sniperScore",
      "rr",
      "score",
      "stage",
      "flow",
      "rsiZone",
      "obBias",
      "spreadBps",
      "depthMinUsd1p",
      "btcState",
      "funding",
      "tfScore",
    ],
    qualityBuckets: Object.fromEntries(QUALITY_BUCKETS.map(b => [b.key, b])),
    marketBuckets: Object.fromEntries(MARKET_BUCKETS.map(b => [b.key, b])),
    timingBuckets: Object.fromEntries(TIMING_BUCKETS.map(b => [b.key, b])),
  };
}

function buildReport(events, config) {
  const familySet = buildFamilies();

  const normalizedEvents = safeArray(events)
    .filter(isPerformanceEvent)
    .map(normalizePerformanceEvent)
    .filter(Boolean);

  for (const event of normalizedEvents) {
    const family = familySet.byId.get(event.familyId);
    if (!family) continue;

    family.observed += 1;
    family.trades += 1;

    if (event.closed) {
      family.closed += 1;
      family.totalR += event.resultR;
      family.totalPnlPct += event.pnlPct;
      family.avgMfeR += event.mfeR;
      family.avgMaeR += event.maeR;

      if (event.resultR > config.breakevenREps) {
        family.wins += 1;
        family.grossWinR += event.resultR;
      } else if (event.resultR < -config.breakevenREps) {
        family.losses += 1;
        family.grossLossR += Math.abs(event.resultR);
      } else {
        family.breakeven += 1;
      }
    } else if (event.open) {
      family.open += 1;
    }

    if (family.examples.length < config.maxExamplesPerFamily) {
      family.examples.push(compactExample(event.raw, event));
    }
  }

  const all = familySet.all.map(family => finalizeFamily(family, config));
  const long = familySet.long;
  const short = familySet.short;

  const closed = all.reduce((sum, row) => sum + row.closed, 0);
  const open = all.reduce((sum, row) => sum + row.open, 0);
  const pendingOutcome = all.reduce((sum, row) => sum + row.pendingOutcome, 0);
  const wins = all.reduce((sum, row) => sum + row.wins, 0);
  const losses = all.reduce((sum, row) => sum + row.losses, 0);
  const breakeven = all.reduce((sum, row) => sum + row.breakeven, 0);
  const totalR = round(all.reduce((sum, row) => sum + row.totalR, 0), 3);
  const totalPnlPct = round(all.reduce((sum, row) => sum + row.totalPnlPct, 0), 3);

  const longSummary = summarizeStatuses(long);
  const shortSummary = summarizeStatuses(short);

  const ranked = [...all].sort(rankFamilyTable);

  const topPnlFamilies = all
    .filter(row => row.closed > 0)
    .sort(rankPnlFirst)
    .slice(0, 25);

  const topTotalRFamilies = all
    .filter(row => row.closed > 0)
    .sort((a, b) => {
      const totalRDiff = safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0);
      if (totalRDiff !== 0) return totalRDiff;
      return rankPnlFirst(a, b);
    })
    .slice(0, 25);

  const topWinrateFamilies = all
    .filter(row => row.closed >= config.minClosed)
    .sort((a, b) => {
      const wr = safeNumber(b.winrateNum, 0) - safeNumber(a.winrateNum, 0);
      if (wr !== 0) return wr;
      return rankPnlFirst(a, b);
    })
    .slice(0, 25);

  const winnerCandidates = all
    .filter(row => row.closed >= config.minClosed)
    .filter(row => row.avgR > 0)
    .filter(row => row.totalR > 0)
    .filter(row => row.totalPnlPct > 0)
    .filter(row => row.winrateNum >= config.minWinrate)
    .sort(rankPnlFirst)
    .slice(0, 12);

  const winnerFamilies = winnerCandidates
    .filter(row => ["HOT", "GOOD", "STABLE"].includes(row.status))
    .slice(0, 8);

  const summary = {
    actions: normalizedEvents.length,
    trades: normalizedEvents.length,
    observed: normalizedEvents.length,
    open,
    closed,
    pendingOutcome,
    wins,
    losses,
    breakeven,
    winrateNum: closed > 0 ? wins / closed : 0,
    winrate: closed > 0 ? `${round((wins / closed) * 100, 1)}%` : "0%",
    totalR,
    avgR: closed > 0 ? round(totalR / closed, 3) : 0,
    totalPnlPct,
    avgPnlPct: closed > 0 ? round(totalPnlPct / closed, 3) : 0,
    longFamilies: longSummary,
    shortFamilies: shortSummary,
    familiesWithData: all.filter(row => row.observed > 0).length,
  };

  return {
    summary,
    diagnostics: {
      inputEvents: safeArray(events).length,
      performanceEvents: normalizedEvents.length,
      droppedEvents: Math.max(0, safeArray(events).length - normalizedEvents.length),
    },
    config,
    families: {
      all,
      long,
      short,
      ranked,
      best: winnerCandidates,
      worst: [...all]
        .filter(row => row.closed > 0)
        .sort((a, b) => safeNumber(a.totalPnlPct, 0) - safeNumber(b.totalPnlPct, 0))
        .slice(0, 25),
      topPnl: topPnlFamilies,
      topTotalR: topTotalRFamilies,
      topWinrate: topWinrateFamilies,
    },
    filterValues: buildFilterValues(),
    familyPerformanceMatrix: {
      long: { total: long.length, summary: longSummary },
      short: { total: short.length, summary: shortSummary },
    },
    best: {
      bestLongByPnl: long.filter(row => row.closed > 0).sort(rankPnlFirst)[0] || null,
      bestShortByPnl: short.filter(row => row.closed > 0).sort(rankPnlFirst)[0] || null,
      topPnlFamily: topPnlFamilies[0] || null,
      topTotalRFamily: topTotalRFamilies[0] || null,
      topWinrateFamily: topWinrateFamilies[0] || null,
    },
    winnerCandidates,
    winnerCandidateSummary: {
      count: winnerCandidates.length,
      objective: "highest_total_pnl_pct_then_total_r",
      message: "Runner candidates gerankt op Total PnL% en daarna Total R, Avg R, PF en sample-size.",
    },
    winnerFamilies,
    winnerFamilySummary: {
      count: winnerFamilies.length,
      rule: "HOT/GOOD/STABLE families met voldoende closed trades, positieve Avg R, positieve Total R en redelijke winrate.",
    },
    leaderboards: {
      topPnlFamilies,
      topTotalRFamilies,
      topWinrateFamilies,
    },
  };
}

export default async function handler(req, res) {
  const startedAt = Date.now();

  try {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Content-Type", "application/json; charset=utf-8");

    const reset = normalizeBoolean(getQueryParam(req, "reset", ""), false);
    const includeLatest = normalizeBoolean(getQueryParam(req, "includeLatest", "true"), true);
    const persistLatest = normalizeBoolean(getQueryParam(req, "persistLatest", "true"), true);

    const config = {
      minClosed: Math.max(0, Math.round(safeNumber(getQueryParam(req, "minClosed", DEFAULT_MIN_CLOSED), DEFAULT_MIN_CLOSED))),
      breakevenREps: safeNumber(getQueryParam(req, "breakevenREps", DEFAULT_BREAKEVEN_R_EPS), DEFAULT_BREAKEVEN_R_EPS),
      minWinrate: safeNumber(getQueryParam(req, "minWinrate", DEFAULT_MIN_WINRATE), DEFAULT_MIN_WINRATE),
      maxExamplesPerFamily: MAX_EXAMPLES_PER_FAMILY,
      familyCountPerSide: 50,
      totalFamilyCount: 100,
    };

    if (reset) {
      await resetRunnerAnalyzeStore();
    }

    const storeBefore = await loadRunnerAnalyzeStore();
    const latest = await loadLatestEvents({ includeLatest });

    const storeEventsBefore = safeArray(storeBefore.events);
    const latestEvents = safeArray(latest.events);

    const mergedForStorage =
      includeLatest && persistLatest
        ? uniqueEvents([...storeEventsBefore, ...latestEvents]).slice(-MAX_STORED_EVENTS)
        : storeEventsBefore;

    const persistResult =
      includeLatest && persistLatest && latestEvents.length
        ? await persistRunnerAnalyzeStore(mergedForStorage)
        : {
            ok: true,
            count: storeEventsBefore.length,
            skipped: true,
          };

    const storeEvents = mergedForStorage;
    const mergedEvents = includeLatest
      ? uniqueEvents([...storeEvents, ...latestEvents])
      : storeEvents;

    const report = buildReport(mergedEvents, config);
    const latencyMs = Date.now() - startedAt;
    const dataState = mergedEvents.length > 0 ? "READY" : "EMPTY";

    return res.status(200).json({
      ok: true,
      profile: SYSTEM_PROFILE,
      scannerProfile: SYSTEM_PROFILE,
      endpoint: ENDPOINT,
      objective: OBJECTIVE,
      strategy: STRATEGY,
      dataState,
      latencyMs,
      generatedAt: Date.now(),
      servedAt: Date.now(),

      sources: {
        mode: "RUNNER_ANALYZE_STORE_PLUS_LATEST",
        storedEvents: storeEvents.length,
        latestEvents: latestEvents.length,
        mergedEvents: mergedEvents.length,
        persistLatest,
        persistResult,
        store: {
          ok: true,
          count: storeEvents.length,
          beforeCount: storeEventsBefore.length,
          addedApprox: Math.max(0, storeEvents.length - storeEventsBefore.length),
          path: storeBefore.path,
          redisEnabled: storeBefore.redisEnabled,
          fileEnabled: storeBefore.fileEnabled,
          redisError: storeBefore.redisError || persistResult.redisError || null,
          loadedAt: storeBefore.loadedAt,
          lastPersistAt: persistResult.persistedAt || storeBefore.lastPersistAt,
          maxStoredEvents: MAX_STORED_EVENTS,
        },
        latest: {
          ok: latest.ok,
          count: latestEvents.length,
          updatedAt: latest.updatedAt || 0,
          note: latest.note || latest.error || null,
        },
      },

      report,

      source: {
        mode: storeBefore.mode,
        storeSource: storeBefore.storeSource,
        redisKey: storeBefore.redisKey,
        legacyRedisKey: storeBefore.legacyRedisKey,
        path: storeBefore.path,
        redisEnabled: storeBefore.redisEnabled,
        fileEnabled: storeBefore.fileEnabled,
        loadedAt: storeBefore.loadedAt,
        lastPersistAt: persistResult.persistedAt || storeBefore.lastPersistAt,
      },
      store: {
        ok: true,
        count: storeEvents.length,
        beforeCount: storeEventsBefore.length,
        trades: report.summary.trades,
        open: report.summary.open,
        closed: report.summary.closed,
        maxStoredEvents: MAX_STORED_EVENTS,
      },
      latest: {
        ok: latest.ok,
        count: latestEvents.length,
        note: latest.note || latest.error || null,
      },
      merged: {
        count: mergedEvents.length,
        source: includeLatest ? "runner_analyze_store_plus_latest" : "runner_analyze_store_only",
      },
      stats: report.summary,
      familyPerformanceMatrix: report.familyPerformanceMatrix,
      best: report.best,
      winnerCandidates: report.winnerCandidates,
      winnerCandidateSummary: report.winnerCandidateSummary,
      winnerFamilies: report.winnerFamilies,
      winnerFamilySummary: report.winnerFamilySummary,
      leaderboards: report.leaderboards,
      families: report.families,
    });
  } catch (error) {
    console.error("RUNNER ANALYZE ERROR:", error);

    return res.status(500).json({
      ok: false,
      profile: SYSTEM_PROFILE,
      endpoint: ENDPOINT,
      error: error?.message || "runner_analyze_failed",
      stack: process.env.NODE_ENV === "production" ? undefined : error?.stack,
      latencyMs: Date.now() - startedAt,
      servedAt: Date.now(),
    });
  }
}