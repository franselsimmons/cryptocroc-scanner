import { kv } from "@vercel/kv";

import {
  RUNTIME_CONFIG,
  requireSecret,
  keyMoonLatest,
  keyMoonPortfolio,
  keyMoonPositions,
  keyMoonState,
  fetchBTCGateFromUniverse,
  fetchCoinGeckoTopCached,
  getBitgetSpotUsdtSymbols,
  getTierForMcap,
  depthFloorUsd,
  isBlockedMoonAsset,
} from "../../lib/_moon_core.js";

import { pushEvent, uid } from "../../lib/_analytics.js";
import { sendSignal } from "../../lib/discordRouter.js";
import { buildCoinProfile, buildMoonExecutionDecision } from "../../lib/_trade_engine.js";
import { logTradeOpened, logTradeClosed } from "../../lib/tradeAnalytics.js";

export const config = RUNTIME_CONFIG;

// ========== helpers ==========
function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function up(x) {
  return String(x || "").toUpperCase();
}

function arr(x) {
  return Array.isArray(x) ? x : [];
}

function sideFromMode(mode) {
  return String(mode || "bull").toLowerCase() === "bear" ? "SHORT" : "LONG";
}

function uniqBySymbol(list) {
  const out = [];
  const seen = new Set();

  for (const item of arr(list)) {
    const key = up(item?.symbol || item?.id || "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

function sortMoonCoins(a, b) {
  return (
    n(b?.perfectCandidateScore, 0) - n(a?.perfectCandidateScore, 0) ||
    n(b?.entryQuality, 0) - n(a?.entryQuality, 0) ||
    n(b?.persistenceScore, 0) - n(a?.persistenceScore, 0) ||
    n(b?.qualityScore, 0) - n(a?.qualityScore, 0) ||
    n(b?.liquidityScore, 0) - n(a?.liquidityScore, 0) ||
    n(a?.ob?.spreadPct, 999) - n(b?.ob?.spreadPct, 999) ||
    n(b?.marketCap, 0) - n(a?.marketCap, 0)
  );
}

function stageOf(c) {
  return up(c?.stage);
}

function execActionOf(c) {
  return up(c?.execution?.action);
}

function isEliteStage(stage) {
  const st = up(stage);
  return st === "ELITE_IGNITION" || st === "ELITE_EXPANSION" || st === "ELITE_CASCADE";
}

function isStableLikeSymbol(symbol) {
  const s = up(symbol);
  if (!s) return true;

  const blocked = [
    "USDT",
    "USDC",
    "USDE",
    "FDUSD",
    "PYUSD",
    "TUSD",
    "BUSD",
    "DAI",
    "USDS",
    "USD0",
    "USDY",
    "EURC",
    "EURI",
    "EURR",
    "AEUR",
    "WBTC",
    "WETH",
    "PAXG",
  ];

  if (blocked.includes(s)) return true;
  if (s.endsWith("USD")) return true;
  if (s.endsWith("EUR")) return true;

  return false;
}

function passesHardMoonUniverseFilter(coin) {
  const symbol = up(coin?.symbol);
  const mc = n(coin?.marketCap, 0);
  const vol = n(coin?.volume, 0);
  const price = n(coin?.price, 0);
  const ch1 = Math.abs(n(coin?.change1h, 0));
  const ch24 = Math.abs(n(coin?.change24, 0));
  const range24 = n(coin?.range24, 0);

  if (!symbol || isStableLikeSymbol(symbol)) return false;
  if (!(price > 0)) return false;

  // moon is niet voor mega caps en niet voor dode coins
  if (mc <= 0 || mc > 900_000_000) return false;
  if (vol < 500_000) return false;

  // filter micro-moves eruit
  if (ch1 < 0.35 && ch24 < 3.0) return false;
  if (range24 < 3.0) return false;

  // extreme rotzooi eruit
  if (ch24 > 120) return false;

  return true;
}

function passesMoonEntryGate(coin, mode) {
  const stage = up(coin?.stage);
  const gate = up(coin?.engineGate || coin?.tradeDeskStatus || "");
  const entryQuality = n(coin?.entryQuality, 0);
  const persistenceScore = n(coin?.persistenceScore, 0);
  const perfectCandidateScore = n(coin?.perfectCandidateScore, 0);
  const qualityScore = n(coin?.qualityScore, 0);
  const liquidityScore = n(coin?.liquidityScore, 0);
  const timingScore = n(coin?.timingScore, 0);
  const spreadPct = n(coin?.ob?.spreadPct, 999);
  const obScore = n(coin?.ob?.score, 0);
  const depth = n(coin?.ob?.depthMinUsd1p, 0);
  const breakoutReady = !!coin?.breakout?.ready;
  const breakoutPressure = n(coin?.breakout?.pressure, 0);
  const tradePlan = !!coin?.tradePlan;

  if (!tradePlan) return false;
  if (gate !== "WATCH" && gate !== "OPEN") return false;

  if (mode === "bull") {
    if (spreadPct > 0.95) return false;
    if (depth < 4000) return false;
    if (obScore < 0.03) return false;

    if (stage === "ELITE_EXPANSION" || stage === "ELITE_IGNITION") {
      return (
        entryQuality >= 74 &&
        persistenceScore >= 64 &&
        perfectCandidateScore >= 72 &&
        qualityScore >= 70 &&
        liquidityScore >= 58 &&
        timingScore >= 64 &&
        breakoutPressure >= 54
      );
    }

    if (stage === "ALMOST") {
      return (
        breakoutReady &&
        entryQuality >= 82 &&
        persistenceScore >= 72 &&
        perfectCandidateScore >= 78 &&
        qualityScore >= 74 &&
        liquidityScore >= 60 &&
        timingScore >= 68 &&
        breakoutPressure >= 60
      );
    }

    return false;
  }

  // bear
  if (spreadPct > 1.05) return false;
  if (depth < 3500) return false;
  if (obScore > -0.03) return false;

  if (stage === "ELITE_CASCADE" || stage === "ELITE_IGNITION") {
    return (
      entryQuality >= 74 &&
      persistenceScore >= 62 &&
      perfectCandidateScore >= 72 &&
      qualityScore >= 70 &&
      liquidityScore >= 56 &&
      timingScore >= 64 &&
      breakoutPressure >= 52
    );
  }

  if (stage === "ALMOST") {
    return (
      breakoutReady &&
      entryQuality >= 82 &&
      persistenceScore >= 70 &&
      perfectCandidateScore >= 78 &&
      qualityScore >= 74 &&
      liquidityScore >= 58 &&
      timingScore >= 68 &&
      breakoutPressure >= 58
    );
  }

  return false;
}

function isTradeReadyCoin(c) {
  return passesMoonEntryGate(c, c?.side === "SHORT" ? "bear" : "bull");
}

function coinForDiscord({ coin, position }) {
  const plan = coin?.tradePlan || coin?.execution?.meta?.tradePlan || null;
  const entry = position?.entryPrice ?? plan?.entry ?? coin?.entry ?? coin?.price ?? null;
  const tp = position?.tp ?? plan?.tp ?? coin?.tp ?? null;
  const sl = position?.sl ?? plan?.sl ?? coin?.sl ?? null;
  return { ...coin, entry, tp, sl, tradePlan: plan };
}

async function safeSendSignal(payload) {
  try {
    await sendSignal(payload);
  } catch (e) {
    console.error("sendSignal failed:", e?.message || e);
  }
}

async function safePushEvent(name, payload) {
  try {
    await pushEvent(name, payload);
  } catch (e) {
    console.error(`pushEvent failed (${name}):`, e?.message || e);
  }
}

async function safePushStageTransition(payload) {
  try {
    await pushEvent("scan_transition", payload);
  } catch (e) {
    console.error("pushEvent failed (scan_transition):", e?.message || e);
  }
}

async function mapLimit(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const out = new Array(list.length);
  let index = 0;

  async function run() {
    while (true) {
      const i = index++;
      if (i >= list.length) break;
      out[i] = await worker(list[i], i);
    }
  }

  const runners = [];
  const size = Math.max(1, Math.min(limit, list.length || 1));
  for (let i = 0; i < size; i++) runners.push(run());
  await Promise.all(runners);
  return out;
}

const REQUIRED_MOON_FNS = [
  "getCfg",
  "computeMarketRegime",
  "computeVelocity",
  "computeCompression",
  "computeBreakoutPressure",
  "computePersistenceScore",
  "computeEliteQuality",
  "computeMoonProbabilities",
  "computeMoonRisk",
  "computeBtcAlignmentScore",
  "computeQualityScore",
  "computeLiquidityScore",
  "computeTimingScore",
  "computeMarketScore",
  "computePerfectCandidateScore",
  "computeDeskGate",
  "computeThesisDamage",
  "decideMoonStage",
  "buildMoonTradePlan",
  "computeBullMoveScore",
  "computeBearMoveScore",
  "isBullExhausted",
  "isBearBounceTrap",
  "isLateBullEntry",
  "isLateBearEntry",
];

function resolveMoonCore(mod, mode) {
  const core = {
    ...(mod || {}),
    ...((mod?.default && typeof mod.default === "object") ? mod.default : {}),
  };

  const missing = REQUIRED_MOON_FNS.filter((k) => typeof core?.[k] !== "function");

  if (missing.length) {
    throw new Error(
      `Invalid moon core module for mode=${mode}. Missing functions: ${missing.join(", ")}`
    );
  }

  return core;
}

// ========== constants ==========
const COOLDOWN_SL_SEC = 5 * 60 * 60;
const COOLDOWN_TP_SEC = 2 * 60 * 60;
const COOLDOWN_TIMEOUT_SEC = 3 * 60 * 60;
const COOLDOWN_EARLY_EXIT_SEC = 2 * 60 * 60;

const MAX_OPEN_TRADES = 2;
const POSITION_SIZE_USD = 50;
const ENTRY_HISTORY_KEEP = 40;
const UI_ENTRY_LOCK_MS_MOON = 12 * 60 * 60 * 1000;

const MAX_UNIVERSE_COINS = 45;
const UNIVERSE_CONCURRENCY = 6;
const STATE_EVENT_SAMPLE_LIMIT = 6;

const LIMIT_ENTRY = 8;
const LIMIT_ALMOST = 12;
const LIMIT_BUILDUP = 12;
const LIMIT_RADAR = 15;

function keyMoonConfigSnapshot(mode) {
  return `moon:config:snapshot:${String(mode || "bull").toLowerCase()}`;
}

// ========== lock ==========
function scanLockKey(mode) {
  return `moon:scan:lock:${String(mode || "bull").toLowerCase()}`;
}

async function acquireScanLock(mode) {
  const key = scanLockKey(mode);
  const now = Date.now();
  const d = new Date(now);
  const next = new Date(d);
  next.setSeconds(0, 0);
  const m = d.getMinutes();

  if (m < 15) next.setMinutes(15);
  else if (m < 30) next.setMinutes(30);
  else if (m < 45) next.setMinutes(45);
  else {
    next.setMinutes(0);
    next.setHours(d.getHours() + 1);
  }

  const until = next.getTime();
  const ttlSec = Math.max(60, Math.ceil((until - now) / 1000));
  const ok = await kv.set(key, { ts: now, until, mode }, { nx: true, ex: ttlSec });

  if (ok) return { ok: true, key, until };

  const cur = await kv.get(key);
  const curUntil = Number(cur?.until || 0);
  if (curUntil > now) return { ok: false, key, until: curUntil };

  await kv.set(key, { ts: now, until, mode }, { ex: ttlSec });
  return { ok: true, key, until };
}

async function releaseScanLock(mode) {
  try {
    await kv.del(scanLockKey(mode));
  } catch {}
}

// ========== cooldown helpers ==========
function cooldownKey(mode, symbol) {
  return `moon:cooldown:${String(mode || "bull").toLowerCase()}:${up(symbol)}`;
}

async function appendEntryHistory(mode) {
  const key = `moon:entry:history:${mode}`;
  const now = Date.now();
  const prev = (await kv.get(key)) || [];
  const list = Array.isArray(prev) ? prev : [];
  const next = [now, ...list].slice(0, ENTRY_HISTORY_KEEP);
  await kv.set(key, next, { ex: 60 * 60 * 24 * 3 });
}

function parseExitReason(p) {
  const r = String(
    p?.exitReason || p?.reason || p?.closedReason || p?.closeReason || ""
  ).toLowerCase();

  if (r.includes("stop") || r.includes("sl")) return "sl";
  if (r.includes("tp") || r.includes("take")) return "tp";
  if (r.includes("timeout")) return "timeout";
  if (r.includes("early")) return "early";
  if (r.includes("thesis")) return "thesis";
  if (r.includes("sell_break") || r.includes("hard_break")) return "early";
  return "other";
}

function cooldownSecondsForExitReason(reasonKey) {
  if (reasonKey === "sl") return COOLDOWN_SL_SEC;
  if (reasonKey === "tp") return COOLDOWN_TP_SEC;
  if (reasonKey === "timeout") return COOLDOWN_TIMEOUT_SEC;
  if (reasonKey === "early") return COOLDOWN_EARLY_EXIT_SEC;
  if (reasonKey === "thesis") return COOLDOWN_EARLY_EXIT_SEC;
  return COOLDOWN_EARLY_EXIT_SEC;
}

async function applyCooldownsFromClosed(mode, positions, now) {
  const closed = Array.isArray(positions?.closed) ? positions.closed : [];
  const lookbackMs = 24 * 60 * 60 * 1000;

  await mapLimit(closed, 8, async (p) => {
    const sym = up(p?.symbol);
    if (!sym) return;

    const closedAt = Number(p?.closedAt || p?.exitAt || p?.updatedAt || p?.ts || 0) || 0;
    if (closedAt <= 0 || closedAt < now - lookbackMs) return;

    const reasonKey = parseExitReason(p);
    const cdSec = cooldownSecondsForExitReason(reasonKey);
    const until = closedAt + cdSec * 1000;
    if (until <= now) return;

    const cdKey = cooldownKey(mode, sym);
    const prevUntil = Number((await kv.get(cdKey)) || 0);
    if (prevUntil >= until) return;

    await kv.set(cdKey, until, { ex: cdSec });
  });
}

// ========== external data ==========
async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(id);
  }
}

async function fetchExchangeFlows() {
  try {
    const data = await fetchJsonWithTimeout(
      "https://api.binance.com/api/v3/ticker/24hr",
      {},
      8000
    );
    return data.filter((x) => Number(x.quoteVolume) > 200_000_000).length;
  } catch {
    return 0;
  }
}

const BITGET_OB = "https://api.bitget.com/api/v2/spot/market/orderbook";

async function fetchOrderbook(symbol) {
  try {
    const url = `${BITGET_OB}?symbol=${symbol}&type=step0&limit=20`;
    const j = await fetchJsonWithTimeout(
      url,
      { headers: { accept: "application/json" } },
      5000
    );

    if (String(j?.code || "") !== "00000") return null;

    const bids = j?.data?.bids || [];
    const asks = j?.data?.asks || [];
    if (!bids.length || !asks.length) return null;

    const bestBid = n(bids[0]?.[0], 0);
    const bestAsk = n(asks[0]?.[0], 0);
    if (!(bestBid > 0 && bestAsk > 0)) return null;

    const spreadPct = ((bestAsk - bestBid) / bestBid) * 100;
    const depthBidUsd = bids
      .slice(0, 8)
      .reduce((a, b) => a + n(b?.[1]) * n(b?.[0]), 0);

    const depthAskUsd = asks
      .slice(0, 8)
      .reduce((a, b) => a + n(b?.[1]) * n(b?.[0]), 0);

    const total = depthBidUsd + depthAskUsd;
    const score = total > 0 ? (depthBidUsd - depthAskUsd) / total : 0;

    const largestBidUsd = Math.max(
      ...bids.slice(0, 8).map((b) => n(b?.[1]) * n(b?.[0])),
      0
    );

    const largestAskUsd = Math.max(
      ...asks.slice(0, 8).map((b) => n(b?.[1]) * n(b?.[0])),
      0
    );

    const lor = total > 0 ? Math.max(largestBidUsd, largestAskUsd) / total : 0;

    return {
      bestBid,
      bestAsk,
      spreadPct,
      depthBidUsd,
      depthAskUsd,
      depthMinUsd1p: Math.min(depthBidUsd, depthAskUsd),
      score,
      lor,
      valid: true,
      fresh: true,
      stale: false,
      reason: "",
      status: "ok",
    };
  } catch {
    return null;
  }
}

function computeObScore(ob) {
  if (!ob) {
    return {
      bestBid: 0,
      bestAsk: 0,
      spreadPct: 999,
      depthBidUsd: 0,
      depthAskUsd: 0,
      depthMinUsd1p: 0,
      score: 0,
      lor: 1,
      valid: false,
      fresh: false,
      stale: true,
      reason: "missing_snapshot",
      status: "none",
    };
  }
  return { ...ob, valid: !!ob.valid, fresh: !!ob.fresh, stale: !!ob.stale };
}

// ========== universe builder ==========
async function buildUniverse({ CORE, mode, whaleFlow, btc, now }) {
  const regime = CORE.computeMarketRegime({ btc, whaleFlow, mode });

  const cg = await fetchCoinGeckoTopCached();
  const rawCoins = Array.isArray(cg?.coins) ? cg.coins : Array.isArray(cg) ? cg : [];

  const bitgetSymbols = await getBitgetSpotUsdtSymbols();
  const step1 = rawCoins.filter((c) => !isBlockedMoonAsset(c));
  const step2 = step1.filter((c) => bitgetSymbols.has(up(c.symbol)));
  const step3 = step2.filter((c) => passesHardMoonUniverseFilter(c));
  const filtered = step3.slice(0, MAX_UNIVERSE_COINS);

  const state = (await kv.get(keyMoonState(mode))) || {};

  const results = await mapLimit(filtered, UNIVERSE_CONCURRENCY, async (coin) => {
    const sym = up(coin.symbol);
    const prev = state?.[sym] || {};

    let ob = null;
    if (n(coin.volume, 0) >= 500_000) {
      ob = await fetchOrderbook(`${sym}USDT`);
    }

    const obx = computeObScore(ob);

    const tier = getTierForMcap(coin.marketCap);
    const floorUsd = Math.max(
      depthFloorUsd(coin.marketCap, tier, prev?.depthHist),
      n(coin.marketCap, 0) <= 80_000_000 ? 4000 : 2500
    );

    const depthOk = n(obx.depthMinUsd1p, 0) >= floorUsd;

    const priceHist = Array.isArray(prev?.priceHist) ? [...prev.priceHist] : [];
    const volHist = Array.isArray(prev?.volHist) ? [...prev.volHist] : [];

    priceHist.push(n(coin.price, 0));
    volHist.push(n(coin.volume, 0));

    const priceHistNext = priceHist.slice(-120);
    const volHistNext = volHist.slice(-120);

    const volAcc = { short: 1, medium: 1 };
    if (volHistNext.length >= 5) {
      const nowVol = volHistNext[volHistNext.length - 1];
      const shortAgo = volHistNext[Math.max(0, volHistNext.length - 1 - 5)] || nowVol;
      const mediumAgo = volHistNext[Math.max(0, volHistNext.length - 1 - 20)] || nowVol;
      volAcc.short = nowVol / Math.max(shortAgo, 1e-9);
      volAcc.medium = nowVol / Math.max(mediumAgo, 1e-9);
    }

    const stageDecision = CORE.decideMoonStage({
      CORE,
      mode,
      coin,
      obx,
      priceHist: priceHistNext,
      volHist: volHistNext,
      btc,
      prev: { ...prev, volAcc },
      whaleFlow,
      regime,
    });

    const {
      stage,
      stageWhy,
      eliteType,
      moveScore,
      velocity,
      compression,
      breakout,
      persistenceScore,
      entryQuality,
    } = stageDecision;

    const probs = CORE.computeMoonProbabilities({
      mode,
      coin: { ...coin, ob: obx },
      moveScore,
      velocity,
      compression,
      persistenceScore,
    });

    const tradePlan = CORE.buildMoonTradePlan({
      CORE,
      price: coin.price,
      mode,
      confidence: entryQuality || moveScore,
      range24: coin.range24,
      depthOk,
      tier,
      regime,
      persistenceScore,
    });

    const qualityScore = CORE.computeQualityScore({
      coin,
      moveScore,
      entryQuality,
      persistenceScore,
      velocity,
      compression,
      breakout,
    });

    const liquidityScore = CORE.computeLiquidityScore({
      ob: obx,
      depthOk,
      spreadPct: obx.spreadPct,
      depthMinUsd1p: obx.depthMinUsd1p,
    });

    const timingScore = CORE.computeTimingScore({
      mode,
      stage,
      breakout,
      volAcc,
      strongScans: prev?.strongScans || 0,
      eliteScans: prev?.eliteScans || 0,
      lateEntry: mode === "bull" ? CORE.isLateBullEntry(coin) : CORE.isLateBearEntry(coin),
      exhausted: mode === "bull" ? CORE.isBullExhausted(coin) : false,
      bounceTrap: mode === "bear" ? CORE.isBearBounceTrap(coin) : false,
    });

    const marketScore = CORE.computeMarketScore({ btc, mode, regime, whaleFlow });
    const btcAlignmentScore = CORE.computeBtcAlignmentScore({ btc, mode, regime });

    const perfectCandidateScore = CORE.computePerfectCandidateScore({
      qualityScore,
      liquidityScore,
      timingScore,
      marketScore,
    });

    const { engineGate, uiGate, deskMeta } = CORE.computeDeskGate({
      mode,
      stage,
      entryQuality,
      persistenceScore,
      breakout,
      obScore: obx.score,
      tradePlan: !!tradePlan,
      now,
      prevGate: prev?.engineGate,
      prevMeta: prev?.deskMeta,
      isEliteStageForDesk: isEliteStage(stage),
    });

    const uiLockUntil = Math.max(
      n(prev?.uiLockUntil, 0),
      engineGate === "WATCH" ? now + UI_ENTRY_LOCK_MS_MOON : 0
    );

    const coinForOutput = {
      ...coin,
      side: sideFromMode(mode),
      stage,
      stageWhy,
      eliteType,
      moveScore,
      confidence: entryQuality || moveScore,
      moonProbability: probs?.moonProbability ?? 0,
      dumpProbability: probs?.dumpProbability ?? 0,
      tradeCandidate: passesMoonEntryGate(
        {
          stage,
          engineGate,
          tradeDeskStatus: uiGate,
          entryQuality,
          persistenceScore,
          perfectCandidateScore,
          qualityScore,
          liquidityScore,
          timingScore,
          breakout,
          ob: obx,
          tradePlan,
        },
        mode
      ),
      superScannerCoin: isEliteStage(stage),
      qualityScore,
      liquidityScore,
      timingScore,
      marketScore,
      btcAlignmentScore,
      perfectCandidateScore,
      ob: {
        bestBid: obx.bestBid,
        bestAsk: obx.bestAsk,
        spreadPct: obx.spreadPct,
        depthBidUsd: obx.depthBidUsd,
        depthAskUsd: obx.depthAskUsd,
        score: obx.score,
        depthMinUsd1p: obx.depthMinUsd1p,
        valid: obx.valid,
        lor: obx.lor,
      },
      thresholds: {
        depthFloorUsd: floorUsd,
        depthOk,
      },
      breakout: {
        ready: breakout.ready,
        breakoutPct: breakout.breakoutPct,
        pressure: breakout.pressure,
      },
      compression: {
        isCompressed: compression.isCompressed,
        flatPct: compression.flatPct,
      },
      volAcc: {
        short: volAcc.short,
        medium: volAcc.medium,
      },
      velocity,
      entryQuality,
      persistenceScore,
      tradePlan,
      range24: coin.range24,
      engineGate,
      tradeDeskStatus: uiGate,
      deskGate: uiGate,
      deskMeta,
      uiLockUntil,
      filterSnapshot: {
        system: "moon",
        mode,
        regime,
        stage,
        engineGate,
        tradeDeskStatus: uiGate,
        entryQuality: n(entryQuality, 0),
        persistenceScore: n(persistenceScore, 0),
        qualityScore: n(qualityScore, 0),
        liquidityScore: n(liquidityScore, 0),
        timingScore: n(timingScore, 0),
        marketScore: n(marketScore, 0),
        btcAlignmentScore: n(btcAlignmentScore, 0),
        perfectCandidateScore: n(perfectCandidateScore, 0),
        spreadPct: n(obx?.spreadPct, 999),
        obScore: n(obx?.score, 0),
        depthMinUsd1p: n(obx?.depthMinUsd1p, 0),
        breakoutReady: !!breakout?.ready,
        breakoutPressure: n(breakout?.pressure, 0),
      },
      _state: {
        priceHist: priceHistNext,
        volHist: volHistNext,
        stageHist: (prev?.stageHist || []).concat([stage]).slice(-12),
        volAcc,
      },
    };

    const coinProfile = buildCoinProfile({
      systemType: "moon",
      coin: coinForOutput,
    });

    const execution = buildMoonExecutionDecision({
      coin: coinForOutput,
      btc,
      regime,
      mode,
      coinProfile,
      positionState: prev?.positionState || {
        inPosition: false,
        cyclesInTrade: 0,
        minHoldCycles: 6,
        weakHoldCount: 0,
        maxWeakHoldCycles: 3,
      },
      scannerGate: engineGate,
    });

    coinForOutput.coinProfile = coinProfile;
    coinForOutput.execution = execution;

    return coinForOutput;
  });

  return { regime, coins: results.filter(Boolean) };
}

function shouldSendUpgradeSignal(oldStage, newStage) {
  if (oldStage === newStage) return false;
  const order = [
    "RADAR",
    "BUILDUP",
    "ALMOST",
    "ELITE_IGNITION",
    "ELITE_EXPANSION",
    "ELITE_CASCADE",
  ];
  const oldIdx = order.indexOf(oldStage);
  const newIdx = order.indexOf(newStage);
  return newIdx > oldIdx;
}

export default async function handler(req, res) {
  let mode = "bull";
  let lockAcquired = false;

  try {
    if (!requireSecret(req, res)) return;

    mode = String(req.query?.mode || "bull").toLowerCase() === "bear" ? "bear" : "bull";

    const mod =
      mode === "bear"
        ? await import("../../lib/_moon_core_bear.js")
        : await import("../../lib/_moon_core_bull.js");

    const CORE = resolveMoonCore(mod, mode);

    const lock = await acquireScanLock(mode);
    if (!lock.ok) {
      const latest = await kv.get(keyMoonLatest(mode));
      return res
        .status(200)
        .json(latest || { ok: true, skipped: true, reason: "scan_lock_active", mode });
    }
    lockAcquired = true;

    const now = Date.now();

    const [whaleFlow, btc, prevPositions] = await Promise.all([
      fetchExchangeFlows(),
      fetchBTCGateFromUniverse(),
      kv.get(keyMoonPositions(mode)),
    ]);

    const positions = {
      open: [...(prevPositions?.open || [])],
      closed: [...(prevPositions?.closed || [])],
    };

    await applyCooldownsFromClosed(mode, positions, now);

    const { regime, coins: universe } = await buildUniverse({
      CORE,
      mode,
      whaleFlow,
      btc,
      now,
    });

    const prevState = (await kv.get(keyMoonState(mode))) || {};
    const nextState = {};

    const universeMap = new Map(universe.map((c) => [c.symbol, c]));
    const openMap = new Map(positions.open.map((p) => [up(p.symbol), p]));

    const signalJobs = [];
    let stateSampleCount = 0;

    for (const coin of universe) {
      const sym = up(coin.symbol);
      const prev = prevState?.[sym] || {};
      const hasOpen = openMap.has(sym);

      const rawStage = coin.stage;
      const oldStage = prev.stage || "RADAR";

      if (rawStage !== oldStage) {
        signalJobs.push(
          safePushStageTransition({
            system: "moon",
            mode,
            symbol: sym,
            from: oldStage,
            to: rawStage,
            price: coin.price,
            entryQuality: coin.entryQuality,
            persistenceScore: coin.persistenceScore,
            perfectCandidateScore: coin.perfectCandidateScore,
            spreadPct: coin?.ob?.spreadPct ?? null,
            obScore: coin?.ob?.score ?? null,
            depthMinUsd1p: coin?.ob?.depthMinUsd1p ?? null,
            scannerGate: coin.engineGate || null,
            tradeDeskStatus: coin.tradeDeskStatus || null,
            regime,
            btcState: btc?.state || "NEUTRAL",
            filterSnapshot: coin.filterSnapshot || null,
            ts: now,
          })
        );
      }

      if (!hasOpen && shouldSendUpgradeSignal(oldStage, rawStage) && isEliteStage(rawStage)) {
        signalJobs.push(
          safeSendSignal({
            source: "moon",
            action: "STAGE_UPGRADE",
            symbol: sym,
            price: coin.price,
            stage: rawStage,
            oldStage,
            mode,
            coin: coinForDiscord({ coin }),
            btcState: btc?.state || "NEUTRAL",
            kind: "elite_watch",
            reason: `Stage upgrade: ${oldStage} → ${rawStage}`,
          })
        );
      }

      const strongScans = rawStage !== "RADAR" ? (prev.strongScans || 0) + 1 : 0;
      const weakScans = rawStage === "RADAR" ? (prev.weakScans || 0) + 1 : 0;
      const eliteScans = rawStage.includes("ELITE") ? (prev.eliteScans || 0) + 1 : 0;
      const watchScans =
        coin.engineGate === "WATCH"
          ? (prev.watchScans || 0) + 1
          : Math.max(0, (prev.watchScans || 0) - 1);

      let candidateSince = prev.candidateSince;
      if (rawStage !== "RADAR" && !candidateSince) candidateSince = now;

      const eliteSince = rawStage.includes("ELITE") ? prev.eliteSince || now : null;
      const entryLocked = prev.entryLocked || false;

      const entryReady =
        !hasOpen &&
        coin.execution?.action === "ALLOW_ENTRY" &&
        !entryLocked &&
        coin.tradePlan != null &&
        passesMoonEntryGate(coin, mode);

      const uiLockUntil = Math.max(coin.uiLockUntil, n(prev.uiLockUntil, 0));

      const depthHist = [...(prev.depthHist || []), coin.ob?.depthMinUsd1p]
        .filter((v) => v > 0)
        .slice(-20);

      const thesisDamage = CORE.computeThesisDamage(coin, prev, mode);

      const prevPositionState = prev.positionState || {
        inPosition: false,
        cyclesInTrade: 0,
        minHoldCycles: 6,
        weakHoldCount: 0,
        maxWeakHoldCycles: 3,
        entryTicketActive: false,
        entryTicketSince: 0,
        entryTicketTtlMs: 90 * 60 * 1000,
      };

      const nextPositionState = {
        ...prevPositionState,
        inPosition: false,
        cyclesInTrade: prevPositionState.inPosition
          ? prevPositionState.cyclesInTrade || 0
          : 0,
      };

      if (!hasOpen) {
        if (coin.execution?.action === "ARM_ENTRY" && passesMoonEntryGate(coin, mode)) {
          nextPositionState.entryTicketActive = true;
          nextPositionState.entryTicketSince =
            prevPositionState.entryTicketActive && prevPositionState.entryTicketSince
              ? prevPositionState.entryTicketSince
              : now;
          nextPositionState.entryTicketTtlMs =
            coin.execution?.meta?.entryTicketTtlMs ||
            prevPositionState.entryTicketTtlMs ||
            90 * 60 * 1000;
        } else if (
          coin.execution?.action === "CANCEL_ENTRY" ||
          coin.execution?.action === "NO_TRADE" ||
          coin.execution?.action === "WATCH" ||
          !passesMoonEntryGate(coin, mode)
        ) {
          nextPositionState.entryTicketActive = false;
          nextPositionState.entryTicketSince = 0;
        } else if (coin.execution?.action === "ALLOW_ENTRY" && passesMoonEntryGate(coin, mode)) {
          nextPositionState.entryTicketActive = true;
          nextPositionState.entryTicketSince = prevPositionState.entryTicketSince || now;
          nextPositionState.entryTicketTtlMs =
            coin.execution?.meta?.entryTicketTtlMs ||
            prevPositionState.entryTicketTtlMs ||
            90 * 60 * 1000;
        }
      }

      nextState[sym] = {
        ...prev,
        stage: rawStage,
        stageWhy: coin.stageWhy,
        eliteType: coin.eliteType,
        price: coin.price,
        marketCap: coin.marketCap,
        volume: coin.volume,
        change24: coin.change24,
        change1h: coin.change1h,
        vm: coin.vm,
        confidence: coin.moveScore,
        entryQuality: coin.entryQuality,
        persistenceScore: coin.persistenceScore,
        moveScore: coin.moveScore,
        velocity: coin.velocity,
        moonProbability: coin.moonProbability,
        ob: coin.ob,
        thresholds: coin.thresholds,
        compression: coin.compression,
        breakout: coin.breakout,
        volAcc: coin.volAcc,
        tradePlan: coin.tradePlan,
        thesisDamage: thesisDamage.damage,
        thesisReasons: thesisDamage.reasons,
        priceHist: coin._state.priceHist,
        volHist: coin._state.volHist,
        stageHist: coin._state.stageHist,
        depthHist,
        strongScans,
        weakScans,
        eliteScans,
        candidateSince,
        eliteSince,
        entryLocked,
        entryReady,
        lastSeen: now,
        qualityScore: coin.qualityScore,
        liquidityScore: coin.liquidityScore,
        timingScore: coin.timingScore,
        marketScore: coin.marketScore,
        btcAlignmentScore: coin.btcAlignmentScore,
        perfectCandidateScore: coin.perfectCandidateScore,
        superScannerCoin: !!coin.superScannerCoin,
        tradeCandidate: !!coin.tradeCandidate,
        scannerOnly: !coin.superScannerCoin,
        tradeDeskStatus: coin.tradeDeskStatus,
        engineGate: coin.engineGate,
        deskGate: coin.deskGate,
        deskMeta: coin.deskMeta,
        uiLockUntil,
        watchScans,
        positionState: nextPositionState,
        execution: coin.execution,
        coinProfile: coin.coinProfile,
        filterSnapshot: coin.filterSnapshot || null,
      };

      if (stateSampleCount < STATE_EVENT_SAMPLE_LIMIT) {
        stateSampleCount += 1;
        signalJobs.push(
          safePushEvent("scan_coin_state", {
            system: "moon",
            mode,
            symbol: sym,
            stage: rawStage,
            price: coin.price,
            entryQuality: coin.entryQuality,
            persistenceScore: coin.persistenceScore,
            perfectCandidateScore: coin.perfectCandidateScore,
            spreadPct: coin?.ob?.spreadPct ?? null,
            obScore: coin?.ob?.score ?? null,
            depthMinUsd1p: coin?.ob?.depthMinUsd1p ?? null,
            scannerGate: coin.engineGate || null,
            tradeDeskStatus: coin.tradeDeskStatus || null,
            regime,
            btcState: btc?.state || "NEUTRAL",
            filterSnapshot: coin.filterSnapshot || null,
            ts: now,
          })
        );
      }
    }

    // -------------------------------
    // 2. Evaluate open positions
    // -------------------------------
    const stillOpen = [];

    for (const pos of positions.open) {
      const sym = up(pos.symbol);
      const liveCoin = universeMap.get(sym);

      if (!liveCoin) {
        stillOpen.push(pos);
        continue;
      }

      const coinProfile = buildCoinProfile({ systemType: "moon", coin: liveCoin });

      const evalCoin = {
        ...liveCoin,
        entryPrice: pos.entryPrice,
        tradePlan: liveCoin.tradePlan || {
          entry: pos.entryPrice,
          sl: pos.sl,
          tp: pos.tp,
          rr: pos.rr,
          tpPct: pos.tpPct,
          slPct: pos.slPct,
        },
      };

      const execution = buildMoonExecutionDecision({
        coin: evalCoin,
        btc,
        regime,
        mode,
        coinProfile,
        positionState: {
          ...(nextState[sym]?.positionState || {}),
          inPosition: true,
          cyclesInTrade: n(pos.cyclesInTrade, 0) + 1,
        },
        scannerGate: liveCoin.engineGate || liveCoin.tradeDeskStatus,
      });

      if (execution.action === "EXIT") {
        const closedPos = {
          ...pos,
          closedAt: now,
          exitPrice: liveCoin.price,
          pnlPct: execution.meta?.pnlPct ?? 0,
          pnlUsd: ((execution.meta?.pnlPct ?? 0) / 100) * POSITION_SIZE_USD,
          exitReason: execution.meta?.exitReason || execution.meta?.reason,
          entryStage: pos.stage || "ENTRY",
          sourceStage: pos.sourceStage || liveCoin.stage || "UNKNOWN",
          exitStage: liveCoin.stage || "UNKNOWN",
        };

        positions.closed.push(closedPos);

        signalJobs.push(
          safePushEvent("trade_closed", {
            id: pos.id,
            system: "moon",
            mode,
            symbol: sym,
            side: pos.side,
            stage: pos.stage || "ENTRY",
            sourceStage: pos.sourceStage || liveCoin.stage || "UNKNOWN",
            exitStage: liveCoin.stage || "UNKNOWN",
            exitPrice: liveCoin.price,
            pnlPct: closedPos.pnlPct,
            pnlUsd: closedPos.pnlUsd,
            reason: closedPos.exitReason,
            entryQuality: pos.entryQuality ?? null,
            persistenceScore: pos.persistenceScore ?? null,
            spreadPct: liveCoin?.ob?.spreadPct ?? pos?.filterSnapshot?.spreadPct ?? null,
            obScore: liveCoin?.ob?.score ?? pos?.filterSnapshot?.obScore ?? null,
            depthMinUsd1p:
              liveCoin?.ob?.depthMinUsd1p ?? pos?.filterSnapshot?.depthMinUsd1p ?? null,
            perfectCandidateScore:
              liveCoin?.perfectCandidateScore ??
              pos?.filterSnapshot?.perfectCandidateScore ??
              null,
            filterSnapshot: pos.filterSnapshot || liveCoin.filterSnapshot || null,
            ts: now,
          })
        );

        signalJobs.push(
          logTradeClosed({
            system: "moon",
            tradeId: pos.id,
            symbol: sym,
            exitAt: now,
            exitPrice: liveCoin.price,
            pnlPct: closedPos.pnlPct,
            pnlUsd: closedPos.pnlUsd,
            exitReason: closedPos.exitReason,
          })
        );

        signalJobs.push(
          safeSendSignal({
            source: "moon",
            action: "TRADE_CLOSED",
            symbol: sym,
            price: liveCoin.price,
            side: pos.side,
            mode,
            coin: coinForDiscord({ coin: liveCoin, position: pos }),
            position: closedPos,
            btcState: btc?.state || "NEUTRAL",
            kind: "trade_closed",
            pnl: closedPos.pnlPct,
            reason: closedPos.exitReason,
          })
        );

        if (nextState[sym]) {
          nextState[sym].positionState = {
            ...nextState[sym].positionState,
            inPosition: false,
            cyclesInTrade: 0,
            weakHoldCount: 0,
          };
        }
      } else {
        const updatedPos = {
          ...pos,
          lastPrice: liveCoin.price,
          pnlPct: execution.meta?.pnlPct ?? pos.pnlPct ?? 0,
          execution,
          cyclesInTrade: n(pos.cyclesInTrade, 0) + 1,
        };

        stillOpen.push(updatedPos);

        if (nextState[sym]) {
          nextState[sym].positionState = {
            inPosition: true,
            cyclesInTrade: n(pos.cyclesInTrade, 0) + 1,
            minHoldCycles: 6,
            weakHoldCount: 0,
            maxWeakHoldCycles: 3,
          };
        }
      }
    }

    positions.open = stillOpen;
    const refreshedOpenMap = new Map(positions.open.map((p) => [up(p.symbol), p]));

    // -------------------------------
    // 3. Nieuwe entries openen
    // -------------------------------
    const entryCandidates = [];

    for (const sym of Object.keys(nextState)) {
      const state = nextState[sym];
      const coin = universeMap.get(sym);
      if (!coin) continue;

      if (state.entryReady && !refreshedOpenMap.has(sym) && passesMoonEntryGate(coin, mode)) {
        const cdKey = cooldownKey(mode, sym);
        const cdUntil = await kv.get(cdKey);
        if (n(cdUntil, 0) <= now) {
          entryCandidates.push({ sym, state, coin });
        }
      }
    }

    entryCandidates.sort((a, b) => sortMoonCoins(a.coin, b.coin));

    const slotsLeft = MAX_OPEN_TRADES - positions.open.length;
    const toOpen = entryCandidates.slice(0, Math.max(0, Math.min(slotsLeft, 1)));

    for (const cand of toOpen) {
      const { sym, coin, state } = cand;
      if (!coin?.tradePlan) continue;
      if (!passesMoonEntryGate(coin, mode)) continue;

      const id = uid("moon");

      const newPos = {
        id,
        symbol: sym,
        mode,
        side: sideFromMode(mode),
        status: "OPEN",
        entryAt: now,
        entryPrice: coin.tradePlan.entry,
        lastPrice: coin.price,
        sizeUsd: POSITION_SIZE_USD,
        pnlPct: 0,
        pnlUsd: 0,
        tp: coin.tradePlan.tp,
        sl: coin.tradePlan.sl,
        rr: coin.tradePlan.rr,
        tpPct: coin.tradePlan.tpPct,
        slPct: coin.tradePlan.slPct,
        entryQuality: coin.entryQuality,
        persistenceScore: coin.persistenceScore,
        regime,
        stage: "ENTRY",
        sourceStage: coin.stage,
        eliteType: coin.eliteType,
        system: "moon",
        filterSnapshot: coin.filterSnapshot || null,
      };

      positions.open.push(newPos);

      nextState[sym] = {
        ...state,
        entryActive: true,
        entryLocked: true,
        entryReady: false,
        lastEntryAt: now,
        uiLockUntil: Math.max(state.uiLockUntil, now + UI_ENTRY_LOCK_MS_MOON),
        positionState: {
          inPosition: true,
          cyclesInTrade: 0,
          minHoldCycles: 6,
          weakHoldCount: 0,
          maxWeakHoldCycles: 3,
        },
      };

      await appendEntryHistory(mode);

      signalJobs.push(
        safePushEvent("trade_opened", {
          id,
          system: "moon",
          mode,
          side: newPos.side,
          symbol: sym,
          entry: newPos.entryPrice,
          size: newPos.sizeUsd,
          tp: newPos.tp,
          sl: newPos.sl,
          rr: newPos.rr,
          stage: newPos.stage,
          sourceStage: newPos.sourceStage,
          eliteType: newPos.eliteType,
          regime,
          scannerStageAtOpen: coin.stage,
          engineGateAtOpen: coin.engineGate || coin.tradeDeskStatus,
          stageWhy: coin.stageWhy || null,
          entryQuality: coin.entryQuality,
          persistenceScore: coin.persistenceScore,
          qualityScore: coin.qualityScore,
          timingScore: coin.timingScore,
          marketScore: coin.marketScore,
          perfectCandidateScore: coin.perfectCandidateScore,
          spreadPct: coin?.ob?.spreadPct ?? null,
          obScore: coin?.ob?.score ?? null,
          depthMinUsd1p: coin?.ob?.depthMinUsd1p ?? null,
          filterSnapshot: coin.filterSnapshot || null,
        })
      );

      signalJobs.push(
        logTradeOpened({
          system: "moon",
          tradeId: id,
          symbol: sym,
          mode,
          side: newPos.side,
          entryAt: now,
          entryPrice: newPos.entryPrice,
          sizeUsd: newPos.sizeUsd,
          tp: newPos.tp,
          sl: newPos.sl,
          rr: newPos.rr,
          tpPct: newPos.tpPct,
          slPct: newPos.slPct,
          scannerStageAtOpen: coin.stage,
          engineGateAtOpen: coin.engineGate || coin.tradeDeskStatus,
          entryQuality: coin.entryQuality,
          persistenceScore: coin.persistenceScore,
          qualityScore: coin.qualityScore,
          timingScore: coin.timingScore,
          marketScore: coin.marketScore,
          perfectCandidateScore: coin.perfectCandidateScore,
          spreadAtOpen: coin?.ob?.spreadPct,
          obScoreAtOpen: coin?.ob?.score,
          depthAtOpen: coin?.ob?.depthMinUsd1p,
          btcState: btc?.state || "NEUTRAL",
          regime,
          meta: {
            eliteType: coin.eliteType || null,
            source: "moon_scan",
          },
          entryFilters: {
            spreadMaxPct: coin?.execution?.meta?.entryTicketMaxSpreadPct ?? null,
            minBreakoutPressure: coin?.execution?.meta?.minBreakoutPressure ?? null,
            entryQuality: coin?.entryQuality ?? null,
            persistenceScore: coin?.persistenceScore ?? null,
            spreadAtOpen: coin?.ob?.spreadPct ?? null,
            obScoreAtOpen: coin?.ob?.score ?? null,
            depthAtOpen: coin?.ob?.depthMinUsd1p ?? null,
          },
        })
      );

      signalJobs.push(
        safeSendSignal({
          source: "moon",
          action: "OPEN_TRADE",
          symbol: sym,
          price: newPos.entryPrice,
          side: newPos.side,
          stage: "ENTRY",
          mode,
          coin: coinForDiscord({ coin, position: newPos }),
          position: newPos,
          btcState: btc?.state || "NEUTRAL",
          kind: "trade_opened",
          reason: "Nieuwe positie geopend door Moon engine",
        })
      );
    }

    // -------------------------------
    // 4. Funnel bouwen voor UI
    // -------------------------------
    const funnel = {
      entry: uniqBySymbol(universe.filter((c) => passesMoonEntryGate(c, mode)))
        .sort(sortMoonCoins)
        .slice(0, LIMIT_ENTRY),

      almost: uniqBySymbol(
        universe.filter(
          (c) =>
            stageOf(c) === "ALMOST" &&
            n(c.entryQuality, 0) >= 68 &&
            n(c.persistenceScore, 0) >= 58 &&
            n(c.perfectCandidateScore, 0) >= 66
        )
      )
        .sort(sortMoonCoins)
        .slice(0, LIMIT_ALMOST),

      buildup: uniqBySymbol(
        universe.filter(
          (c) =>
            stageOf(c) === "BUILDUP" &&
            n(c.entryQuality, 0) >= 58 &&
            n(c.persistenceScore, 0) >= 48 &&
            n(c.perfectCandidateScore, 0) >= 56
        )
      )
        .sort(sortMoonCoins)
        .slice(0, LIMIT_BUILDUP),

      radar: uniqBySymbol(
        universe.filter(
          (c) =>
            stageOf(c) === "RADAR" &&
            n(c.entryQuality, 0) >= 45 &&
            n(c.perfectCandidateScore, 0) >= 44
        )
      )
        .sort(sortMoonCoins)
        .slice(0, LIMIT_RADAR),
    };

    // -------------------------------
    // 5. Portfolio & opslag
    // -------------------------------
    const portfolio = {
      mode,
      posUsd: POSITION_SIZE_USD,
      openCount: positions.open.length,
      closedCount: positions.closed.length,
      realizedUsd: positions.closed.reduce((a, b) => a + n(b.pnlUsd), 0),
      avgRealizedPct: positions.closed.length
        ? positions.closed.reduce((a, b) => a + n(b.pnlPct), 0) / positions.closed.length
        : 0,
      updatedAt: now,
    };

    const configSnapshot = {
      system: "moon",
      mode,
      regime,
      engine: {
        maxOpenTrades: MAX_OPEN_TRADES,
        positionSizeUsd: POSITION_SIZE_USD,
        cooldownSlSec: COOLDOWN_SL_SEC,
        cooldownTpSec: COOLDOWN_TP_SEC,
        cooldownTimeoutSec: COOLDOWN_TIMEOUT_SEC,
        cooldownEarlyExitSec: COOLDOWN_EARLY_EXIT_SEC,
        uiEntryLockMs: UI_ENTRY_LOCK_MS_MOON,
      },
      limits: {
        entry: LIMIT_ENTRY,
        almost: LIMIT_ALMOST,
        buildup: LIMIT_BUILDUP,
        radar: LIMIT_RADAR,
        universeTop: MAX_UNIVERSE_COINS,
      },
      updatedAt: now,
    };

    const latest = {
      ok: true,
      mode,
      regime,
      btc: {
        price: btc.price,
        chg24: btc.chg24,
        chg1h: btc.chg1h,
        range24: btc.range24,
        state: btc.state,
      },
      whaleFlow,
      funnel,
      counts: {
        entry: funnel.entry.length,
        almost: funnel.almost.length,
        buildup: funnel.buildup.length,
        radar: funnel.radar.length,
      },
      debug: {
        universeCount: universe.length,
        entryCount: funnel.entry.length,
        almostCount: funnel.almost.length,
        buildupCount: funnel.buildup.length,
        radarCount: funnel.radar.length,
      },
      portfolio,
      positions: {
        open: positions.open.length,
        closed: positions.closed.length,
        openItems: positions.open.map((p) => ({
          id: p.id,
          symbol: p.symbol,
          mode: p.mode,
          side: p.side,
          status: p.status,
          entryAt: p.entryAt,
          entryPrice: p.entryPrice,
          lastPrice: p.lastPrice,
          pnlPct: p.pnlPct,
          pnlUsd: p.pnlUsd,
          tp: p.tp,
          sl: p.sl,
          rr: p.rr,
          stage: p.stage,
          sourceStage: p.sourceStage,
          eliteType: p.eliteType,
        })),
      },
      ts: now,
      scannedAt: now,
    };

    await Promise.all([
      kv.set(keyMoonPortfolio(mode), portfolio, { ex: 60 * 60 * 24 * 7 }),
      kv.set(keyMoonState(mode), nextState, { ex: 60 * 60 * 24 * 3 }),
      kv.set(
        keyMoonPositions(mode),
        { ...positions, closed: positions.closed.slice(-1000) },
        { ex: 60 * 60 * 24 * 7 }
      ),
      kv.set(keyMoonConfigSnapshot(mode), configSnapshot, { ex: 60 * 60 * 24 * 7 }),
      kv.set(keyMoonLatest(mode), latest, { ex: 60 * 60 }),
    ]);

    await Promise.allSettled(signalJobs);

    return res.status(200).json(latest);
  } catch (err) {
    console.error("Moon scan error:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message || String(err),
    });
  } finally {
    if (lockAcquired) {
      await releaseScanLock(mode);
    }
  }
}