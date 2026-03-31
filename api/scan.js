import { kv } from "@vercel/kv";

import {
  RUNTIME_CONFIG,
  requireSecret,
  keyMainLatest,
  keyMainPortfolio,
  keyMainPositions,
  keyMainState,
  fetchBTCGateFromUniverse,
  fetchCoinGeckoTopCached,
  getBitgetSpotUsdtSymbols,
  getTierForMcap,
  depthFloorUsd,
  computeMoonRisk,
  isBlockedMoonAsset,
  MAIN_V2,
  computeVelocity,
  computeCompression,
  computeBreakoutPressure,
  computePersistenceScore,
  computeMarketRegime,
  adjustMoonConfigForRegime,
  computeEliteQuality,
  computeBullMoveScore,
  computeBearMoveScore,
  isBullExhausted,
  isBearBounceTrap,
  isLateBullEntry,
  isLateBearEntry,
  computeMoonProbabilities,
  computeBtcAlignmentScore,
  computeQualityScore,
  computeLiquidityScore,
  computeTimingScore,
  computeMarketScore,
  computePerfectCandidateScore,
} from "../lib/_moon_core.js";

import { pushEvent, uid } from "../lib/_analytics.js";
import { sendSignal } from "../lib/discordRouter.js";

import { buildCoinProfile, buildMainExecutionDecision } from "../lib/_trade_engine.js";

export const config = RUNTIME_CONFIG;

const BITGET_OB = "https://api.bitget.com/api/v2/spot/market/orderbook";

// ======================================================
// Helpers
// ======================================================
function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function up(x) {
  return String(x || "").toUpperCase();
}
function sideFromMode(mode) {
  return String(mode || "bull").toLowerCase() === "bear" ? "SHORT" : "LONG";
}

// ======================================================
// Hulpfunctie voor timeouts
// ======================================================
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

// ======================================================
// Veilige wrappers
// ======================================================
async function safePushEvent(name, payload) {
  try {
    await pushEvent(name, payload);
  } catch (e) {
    console.error(`pushEvent failed (${name}):`, e?.message || e);
  }
}
async function safeSendSignal(payload) {
  try {
    await sendSignal(payload);
  } catch (e) {
    console.error("sendSignal failed:", e?.message || e);
  }
}

// ======================================================
// Constantes – Main specifiek
// ======================================================
const COOLDOWN_SL_SEC = 4 * 60 * 60;
const COOLDOWN_TP_SEC = 90 * 60;
const COOLDOWN_TIMEOUT_SEC = 2 * 60 * 60;
const COOLDOWN_EARLY_EXIT_SEC = 90 * 60;

const MAX_OPEN_TRADES = 6;

const ENTRY_HISTORY_KEEP = 40;
const ENTRY_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MIN_RECENT_ENTRIES_TARGET = 3;

const POSITION_SIZE_USD = 50;

// ======================================================
// ✅ HARPOEN A+ GATE (MAIN) — FIXED (minder streng)
// ======================================================
// Macro alignment iets realistischer
const APLUS_BTC_ALIGN = 62;

// A+ thresholds iets omlaag (nog steeds elite)
const APLUS_LIQ = 68;
const APLUS_PERF = 78;
const APLUS_TIMING = 72;

// near-A+ WATCH thresholds
const NEAR_LIQ = 64;
const NEAR_PERF = 74;
const NEAR_TIMING = 68;

// OPEN sneller
const WATCH_CONFIRM_TO_OPEN = 2;
const IMMEDIATE_OPEN_TIMING = 80;

// Regime allowlist: alles behalve “bad regimes”
function isMacroRegimeOk(regime) {
  const r = String(regime || "").toUpperCase();
  if (!r) return false;
  if (r === "HEADWIND") return false;
  if (r === "CHOP") return false;
  return true; // EXPANSION / NEUTRAL / RECOVERY / etc. -> ok
}

function isMainEliteStage(stage) {
  const s = up(stage);
  return s === "ELITE_IGNITION" || s === "ELITE_EXPANSION" || s === "ELITE_CASCADE";
}

// ======================================================
// BTC fallback helpers
// ======================================================
function isUsableBtc(btc) {
  if (!btc) return false;
  const price = n(btc.price, 0);
  const chg24 = n(btc.chg24, 0);
  const range24 = n(btc.range24, 0);
  const state = String(btc.state || "").toUpperCase();
  if (price > 0 && (Math.abs(chg24) > 0 || Math.abs(range24) > 0)) return true;
  if (price > 0 && (state === "BULL" || state === "BEAR")) return true;
  return false;
}
async function resolveBtcForMode(mode) {
  const fresh = await fetchBTCGateFromUniverse();
  if (isUsableBtc(fresh)) return fresh;
  try {
    const prevLatest = await kv.get(keyMainLatest(mode));
    if (isUsableBtc(prevLatest?.btc)) {
      console.warn("Main BTC fallback -> using previous latest snapshot BTC");
      return prevLatest.btc;
    }
  } catch {}
  return {
    price: n(fresh?.price, 0),
    chg24: n(fresh?.chg24, 0),
    chg1h: n(fresh?.chg1h, 0),
    range24: n(fresh?.range24, 0),
    state: String(fresh?.state || "NEUTRAL").toUpperCase(),
  };
}

// ======================================================
// Boundary-based lock (30 min)
// ======================================================
function scanLockKey(mode) {
  return `main:scan:lock:${String(mode || "bull").toLowerCase()}`;
}
async function acquireScanLock(mode) {
  const key = scanLockKey(mode);
  const now = Date.now();
  const d = new Date(now);
  const next = new Date(d);
  next.setSeconds(0, 0);
  if (d.getMinutes() < 30) next.setMinutes(30);
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

// ======================================================
// Cooldown helpers
// ======================================================
function cooldownKey(mode, symbol) {
  return `main:cooldown:${String(mode || "bull").toLowerCase()}:${up(symbol)}`;
}
function entryHistoryKey(mode) {
  return `main:entry:history:${String(mode || "bull").toLowerCase()}`;
}
async function readRecentEntryCount(mode, lookbackMs = ENTRY_LOOKBACK_MS) {
  const key = entryHistoryKey(mode);
  const now = Date.now();
  const prev = (await kv.get(key)) || [];
  const arr = Array.isArray(prev) ? prev : [];
  const filtered = arr.filter((ts) => n(ts, 0) >= now - lookbackMs).slice(0, ENTRY_HISTORY_KEEP);
  await kv.set(key, filtered, { ex: 60 * 60 * 24 * 3 });
  return filtered.length;
}
async function appendEntryHistory(mode) {
  const key = entryHistoryKey(mode);
  const now = Date.now();
  const prev = (await kv.get(key)) || [];
  const arr = Array.isArray(prev) ? prev : [];
  const next = [now, ...arr].slice(0, ENTRY_HISTORY_KEEP);
  await kv.set(key, next, { ex: 60 * 60 * 24 * 3 });
}

// --- anti flip: cooldowns uit closed trades ---
function parseExitReason(p) {
  const r = String(p?.exitReason || p?.reason || p?.closedReason || p?.closeReason || "").toLowerCase();
  if (r.includes("stop") || r.includes("sl")) return "sl";
  if (r.includes("tp") || r.includes("take")) return "tp";
  if (r.includes("timeout")) return "timeout";
  if (r.includes("early")) return "early";
  if (r.includes("thesis")) return "thesis";
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
  for (const p of closed) {
    const sym = up(p?.symbol);
    if (!sym) continue;

    const closedAt = Number(p?.closedAt || p?.exitAt || p?.updatedAt || p?.ts || 0) || 0;
    if (closedAt <= 0) continue;
    if (closedAt < now - lookbackMs) continue;

    const reasonKey = parseExitReason(p);
    const cdSec = cooldownSecondsForExitReason(reasonKey);
    const until = closedAt + cdSec * 1000;
    if (until <= now) continue;

    const cdKey = cooldownKey(mode, sym);
    const prevUntil = Number((await kv.get(cdKey)) || 0);
    if (prevUntil >= until) continue;

    await kv.set(cdKey, until, { ex: cdSec });
  }
}

// ======================================================
// Externe data met timeouts
// ======================================================
async function fetchExchangeFlows() {
  try {
    const data = await fetchJsonWithTimeout("https://api.binance.com/api/v3/ticker/24hr", {}, 8000);
    return data.filter((x) => Number(x.quoteVolume) > 200_000_000).length;
  } catch {
    return 0;
  }
}
async function fetchOrderbook(symbol) {
  try {
    const url = `${BITGET_OB}?symbol=${symbol}&type=step0&limit=20`;
    const j = await fetchJsonWithTimeout(url, { headers: { accept: "application/json" } }, 6000);
    if (String(j?.code || "") !== "00000") return null;
    const bids = j?.data?.bids || [];
    const asks = j?.data?.asks || [];
    if (!bids.length || !asks.length) return null;

    const bestBid = n(bids[0]?.[0], 0);
    const bestAsk = n(asks[0]?.[0], 0);
    if (!(bestBid > 0 && bestAsk > 0)) return null;

    const spreadPct = ((bestAsk - bestBid) / bestBid) * 100;
    const depthBidUsd = bids.slice(0, 8).reduce((a, b) => a + n(b?.[1]) * n(b?.[0]), 0);
    const depthAskUsd = asks.slice(0, 8).reduce((a, b) => a + n(b?.[1]) * n(b?.[0]), 0);

    const total = depthBidUsd + depthAskUsd;
    const score = total > 0 ? (depthBidUsd - depthAskUsd) / total : 0;

    const largestBidUsd = Math.max(...bids.slice(0, 8).map((b) => n(b?.[1]) * n(b?.[0])), 0);
    const largestAskUsd = Math.max(...asks.slice(0, 8).map((b) => n(b?.[1]) * n(b?.[0])), 0);
    const largestOrderRatio = total > 0 ? Math.max(largestBidUsd, largestAskUsd) / total : 0;

    return {
      status: "ok",
      valid: true,
      fresh: true,
      stale: false,
      reason: "",
      bestBid,
      bestAsk,
      spreadPct,
      depthBidUsd,
      depthAskUsd,
      depthMinUsd1p: Math.min(depthBidUsd, depthAskUsd),
      score,
      lor: largestOrderRatio,
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
  return {
    bestBid: n(ob.bestBid, 0),
    bestAsk: n(ob.bestAsk, 0),
    spreadPct: n(ob.spreadPct, 999),
    depthBidUsd: n(ob.depthBidUsd, 0),
    depthAskUsd: n(ob.depthAskUsd, 0),
    depthMinUsd1p: n(ob.depthMinUsd1p, 0),
    score: n(ob.score, 0),
    lor: n(ob.lor, 0),
    valid: !!ob.valid,
    fresh: !!ob.fresh,
    stale: !!ob.stale,
    reason: String(ob.reason || ""),
    status: String(ob.status || "ok"),
  };
}

// ======================================================
// tradePlan, funnel, portfolio
// ======================================================
function buildTradePlan({ price, mode, confidence, range24, depthOk, tier, regime, persistenceScore }) {
  const risk = computeMoonRisk({
    mode,
    price,
    range24,
    confidence,
    depthOk,
    tier,
    regime,
    persistenceScore,
  });
  if (!risk) return null;
  return {
    entry: Number(price.toFixed(8)),
    sl: Number(risk.sl.toFixed(8)),
    tp: Number(risk.tp3.toFixed(8)),
    rr: Number((risk.tpPct / Math.max(risk.slPct, 0.0001)).toFixed(2)),
    tpPct: Number(risk.tpPct.toFixed(2)),
    slPct: Number(risk.slPct.toFixed(2)),
  };
}
function sortByStageScore() {
  return (a, b) =>
    n(b?.entryQuality || b?.confidence, 0) - n(a?.entryQuality || a?.confidence, 0) ||
    n(b?.confidence, 0) - n(a?.confidence, 0) ||
    n(b?.moonProbability || b?.dumpProbability || 0, 0) - n(a?.moonProbability || a?.dumpProbability || 0, 0) ||
    n(b?.vm, 0) - n(a?.vm, 0);
}
function splitFunnels(coins) {
  const funnel = {
    elite_expansion: [],
    elite_ignition: [],
    almost: [],
    buildup: [],
    radar: [],
  };
  for (const c of coins) {
    if (c.stage === "ELITE_EXPANSION" || c.stage === "ELITE_CASCADE") funnel.elite_expansion.push(c);
    else if (c.stage === "ELITE_IGNITION") funnel.elite_ignition.push(c);
    else if (c.stage === "ALMOST") funnel.almost.push(c);
    else if (c.stage === "BUILDUP") funnel.buildup.push(c);
    else funnel.radar.push(c);
  }
  const sorter = sortByStageScore();
  funnel.elite_expansion.sort(sorter);
  funnel.elite_ignition.sort(sorter);
  funnel.almost.sort(sorter);
  funnel.buildup.sort(sorter);
  funnel.radar.sort(sorter);

  funnel.elite_expansion = funnel.elite_expansion.slice(0, 12);
  funnel.elite_ignition = funnel.elite_ignition.slice(0, 12);
  funnel.almost = funnel.almost.slice(0, 20);
  funnel.buildup = funnel.buildup.slice(0, 35);
  funnel.radar = funnel.radar.slice(0, 80);
  return funnel;
}
function makePortfolio(mode, positions) {
  const open = Array.isArray(positions?.open) ? positions.open : [];
  const closed = Array.isArray(positions?.closed) ? positions.closed : [];
  let realizedUsd = 0;
  let avgRealizedPct = 0;
  if (closed.length) {
    realizedUsd = closed.reduce((a, b) => a + n(b.pnlUsd), 0);
    avgRealizedPct = closed.reduce((a, b) => a + n(b.pnlPct), 0) / closed.length;
  }
  return {
    mode,
    posUsd: POSITION_SIZE_USD,
    openCount: open.length,
    closedCount: closed.length,
    realizedUsd: Number(realizedUsd.toFixed(2)),
    avgRealizedPct: Number(avgRealizedPct.toFixed(2)),
    updatedAt: Date.now(),
  };
}

// ======================================================
// hasEliteFollowThrough
// ======================================================
function hasEliteFollowThrough(prev, currentStage) {
  const curr = up(currentStage);
  if (curr === "ELITE_EXPANSION" || curr === "ELITE_CASCADE") return true;
  const prevStage = up(prev?.stage || "");
  if (curr === "ELITE_IGNITION" && (prevStage === "ALMOST" || prevStage === "BUILDUP")) return true;
  const hist = Array.isArray(prev?.stageHist) ? prev.stageHist : [];
  const tail = hist.slice(-2);
  const eliteLike = tail.filter((s) => {
    const x = up(s);
    return x === "ELITE_IGNITION" || x === "ELITE_EXPANSION" || x === "ELITE_CASCADE";
  }).length;
  return eliteLike >= 1;
}

// ======================================================
// Main stage decision
// (ongewijzigd: jouw decideMainStageV6 blijft hetzelfde)
// ======================================================
function decideMainStageV6({ mode, coin, obx, priceHist, volHist, btc, prev, whaleFlow, regime }) {
  const baseCfg = MAIN_V2[mode];
  const cfg = adjustMoonConfigForRegime(baseCfg, regime);

  const velocity = computeVelocity(coin.change1h, coin.change24);
  const compression = computeCompression(priceHist);
  const breakout = computeBreakoutPressure(priceHist);

  const prevVolAcc = prev?.volAcc || { short: 1, medium: 1 };
  const volAcc = {
    short: n(prevVolAcc.short, 1),
    medium: n(prevVolAcc.medium, 1),
  };

  const persistenceScore = computePersistenceScore({
    priceHist,
    volHist,
    stageHist: prev?.stageHist || [],
    mode,
  });

  if (mode === "bull" && isBullExhausted(coin)) {
    return { stage: "RADAR", stageWhy: "bull_exhausted", moveScore: 0, velocity, compression, breakout, eliteType: null, persistenceScore, entryQuality: 0 };
  }
  if (mode === "bear" && isBearBounceTrap(coin)) {
    return { stage: "RADAR", stageWhy: "bear_bounce_trap", moveScore: 0, velocity, compression, breakout, eliteType: null, persistenceScore, entryQuality: 0 };
  }
  if (mode === "bull" && isLateBullEntry(coin)) {
    return { stage: "ALMOST", stageWhy: "late_bull_entry", moveScore: 0, velocity, compression, breakout, eliteType: null, persistenceScore, entryQuality: 0 };
  }
  if (mode === "bear" && isLateBearEntry(coin)) {
    return { stage: "ALMOST", stageWhy: "late_bear_entry", moveScore: 0, velocity, compression, breakout, eliteType: null, persistenceScore, entryQuality: 0 };
  }

  const moveScore = mode === "bull" ? computeBullMoveScore(coin, obx) : computeBearMoveScore(coin, obx);

  const entryQuality = computeEliteQuality({
    moveScore,
    velocity,
    vm: coin.vm,
    obScore: obx.score,
    compression,
    volAcc,
    persistenceScore,
    regime,
    breakoutReady: breakout.ready,
  });

  const btcMomentumOk =
    mode === "bull"
      ? n(btc?.chg24, 0) >= 0.8 && n(btc?.range24, 0) >= 2.8
      : n(btc?.chg24, 0) <= -0.8 && n(btc?.range24, 0) >= 2.8;

  if (volAcc.short < 1.01 && volAcc.medium < 1.06 && moveScore < 70 && !breakout.ready && persistenceScore < 56) {
    return { stage: "ALMOST", stageWhy: "volume_not_accelerating", moveScore, velocity, compression, breakout, eliteType: null, persistenceScore, entryQuality };
  }

  let stage = "RADAR";
  let eliteType = null;

  if (mode === "bull") {
    if (
      n(coin.change1h, 0) >= n(cfg.minCh1hExpansion, 0) &&
      n(coin.change24, 0) >= n(cfg.minCh24Expansion, 0) &&
      n(coin.vm, 0) >= n(cfg.minVmElite, 0) &&
      n(obx.score, 0) >= n(cfg.minObStrong, 0) &&
      velocity >= n(cfg.explosiveVelocity, 0) &&
      entryQuality >= 76 &&
      persistenceScore >= n(cfg.minPersistenceExpansion, 70)
    ) {
      stage = "ELITE_EXPANSION";
      eliteType = "expansion";
    } else if (
      n(coin.change1h, 0) >= n(cfg.minCh1hIgnition, 0) &&
      n(coin.change24, 0) >= n(cfg.minCh24Ignition, 0) &&
      n(coin.vm, 0) >= n(cfg.minVmElite, 0) &&
      n(obx.score, 0) >= n(cfg.minObStrong, 0) &&
      velocity >= n(cfg.strongVelocity, 0) &&
      entryQuality >= 66 &&
      persistenceScore >= n(cfg.minPersistenceIgnition, 60)
    ) {
      stage = "ELITE_IGNITION";
      eliteType = "ignition";
    } else if (
      n(coin.change1h, 0) >= Math.max(0.7, n(cfg.minCh1hAlmost, 0) - 0.25) &&
      n(coin.change24, 0) >= Math.max(4.8, n(cfg.minCh24Almost, 0) - 1.2) &&
      n(coin.vm, 0) >= Math.max(0.17, n(cfg.minVmAlmost, 0) - 0.03) &&
      velocity >= Math.max(0.09, n(cfg.strongVelocity, 0) - 0.02)
    ) {
      stage = "ALMOST";
    } else if (
      n(coin.change1h, 0) >= n(cfg.minCh1hBuildup, 0) &&
      n(coin.change24, 0) >= n(cfg.minCh24Buildup, 0) &&
      n(coin.vm, 0) >= n(cfg.minVmBuildup, 0) &&
      velocity >= n(cfg.minVelocity, 0)
    ) {
      stage = "BUILDUP";
    }
  } else {
    if (
      n(coin.change1h, 0) <= n(cfg.maxCh1hCascade, 0) &&
      n(coin.change24, 0) <= n(cfg.maxCh24Cascade, 0) &&
      n(coin.vm, 0) >= n(cfg.minVmElite, 0) &&
      Math.abs(n(obx.score, 0)) >= n(cfg.minObStrongAbs, 0) &&
      n(obx.score, 0) <= 0 &&
      velocity >= n(cfg.explosiveVelocity, 0) &&
      entryQuality >= 76 &&
      persistenceScore >= n(cfg.minPersistenceExpansion, 70)
    ) {
      stage = "ELITE_CASCADE";
      eliteType = "cascade";
    } else if (
      n(coin.change1h, 0) <= n(cfg.maxCh1hIgnition, 0) &&
      n(coin.change24, 0) <= n(cfg.maxCh24Ignition, 0) &&
      n(coin.vm, 0) >= n(cfg.minVmElite, 0) &&
      Math.abs(n(obx.score, 0)) >= n(cfg.minObStrongAbs, 0) &&
      n(obx.score, 0) <= 0 &&
      velocity >= n(cfg.strongVelocity, 0) &&
      entryQuality >= 66 &&
      persistenceScore >= n(cfg.minPersistenceIgnition, 60)
    ) {
      stage = "ELITE_IGNITION";
      eliteType = "ignition";
    } else if (
      n(coin.change1h, 0) <= Math.min(-0.7, n(cfg.maxCh1hAlmost, 0) + 0.25) &&
      n(coin.change24, 0) <= Math.min(-4.8, n(cfg.maxCh24Almost, 0) + 1.2) &&
      n(coin.vm, 0) >= Math.max(0.17, n(cfg.minVmAlmost, 0) - 0.03) &&
      velocity >= Math.max(0.09, n(cfg.strongVelocity, 0) - 0.02)
    ) {
      stage = "ALMOST";
    } else if (
      n(coin.change1h, 0) <= n(cfg.maxCh1hBuildup, 0) &&
      n(coin.change24, 0) <= n(cfg.maxCh24Buildup, 0) &&
      n(coin.vm, 0) >= n(cfg.minVmBuildup, 0) &&
      velocity >= n(cfg.minVelocity, 0)
    ) {
      stage = "BUILDUP";
    }
  }

  if (isMainEliteStage(stage) && !breakout.ready && entryQuality < 82) {
    stage = "ALMOST";
    eliteType = null;
  }

  if (isMainEliteStage(stage) && !btcMomentumOk && regime !== "EXPANSION") {
    return { stage: "ALMOST", stageWhy: "btc_not_expanding", moveScore, velocity, compression, breakout, eliteType: null, persistenceScore, entryQuality };
  }

  if (isMainEliteStage(stage) && !hasEliteFollowThrough(prev, stage)) {
    return { stage: "ALMOST", stageWhy: "elite_needs_followthrough", moveScore, velocity, compression, breakout, eliteType: null, persistenceScore, entryQuality };
  }

  return { stage, stageWhy: "ok", moveScore, velocity, compression, breakout, eliteType, persistenceScore, entryQuality };
}

// ======================================================
// Universe bouwen (scanner)
// ======================================================
async function buildUniverse(mode, whaleFlow, btc, now) {
  const regime = computeMarketRegime({ btc, whaleFlow, mode });

  const rawCoins = await fetchCoinGeckoTopCached();
  const bitgetSymbols = await getBitgetSpotUsdtSymbols();

  const step1 = rawCoins.filter((c) => !isBlockedMoonAsset(c));
  const step2 = step1.filter((c) => bitgetSymbols.has(up(c.symbol)));

  console.log("🔍 MAIN V6 DEBUG", {
    regime,
    rawCoins: rawCoins.length,
    afterBlocked: step1.length,
    bitgetSymbols: bitgetSymbols.size,
    afterBitget: step2.length,
  });

  const filtered = step2.slice(0, 160);
  const out = [];
  const state = (await kv.get(keyMainState(mode))) || {};

  for (const coin of filtered) {
    const sym = up(coin.symbol);
    const prev = state?.[sym] || {};

    let ob = null;
    if (n(coin.volume, 0) >= 600_000) {
      ob = await fetchOrderbook(`${sym}USDT`);
    }
    const obx = computeObScore(ob);

    const tier = getTierForMcap(coin.marketCap);
    const floorUsd = depthFloorUsd(coin.marketCap, tier, prev?.depthHist);

    const depthUsd = n(obx.depthMinUsd1p, 0);
    const depthOk = depthUsd >= floorUsd;

    const priceHist = Array.isArray(prev?.priceHist) ? [...prev.priceHist] : [];
    const volHist = Array.isArray(prev?.volHist) ? [...prev.volHist] : [];

    priceHist.push(n(coin.price, 0));
    volHist.push(n(coin.volume, 0));

    const priceHistNext = priceHist.slice(-120);
    const volHistNext = volHist.slice(-120);

    const volAcc = { short: 1, medium: 1 };
    if (volHistNext.length >= 5) {
      const nowVol = volHistNext[volHistNext.length - 1];
      const shortAgo = volHistNext[volHistNext.length - 1 - 5] || nowVol;
      const mediumAgo = volHistNext[volHistNext.length - 1 - 20] || nowVol;
      volAcc.short = nowVol / Math.max(shortAgo, 1e-9);
      volAcc.medium = nowVol / Math.max(mediumAgo, 1e-9);
    }

    const stageDecision = decideMainStageV6({
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

    const stage = stageDecision.stage;
    const stageWhy = stageDecision.stageWhy;
    const eliteType = stageDecision.eliteType;
    const velocity = stageDecision.velocity;
    const compression = stageDecision.compression;
    const breakout = stageDecision.breakout;
    const moveScore = stageDecision.moveScore;
    const persistenceScore = stageDecision.persistenceScore;
    const entryQuality = stageDecision.entryQuality;

    const probs = computeMoonProbabilities({
      mode,
      coin: { ...coin, ob: obx },
      moveScore,
      velocity,
      compression,
      persistenceScore,
    });

    const tradePlan = buildTradePlan({
      price: n(coin.price, 0),
      mode,
      confidence: entryQuality || moveScore,
      range24: n(coin.range24, 0),
      depthOk,
      tier,
      regime,
      persistenceScore,
    });

    const qualityScore = computeQualityScore({
      coin,
      moveScore,
      entryQuality,
      persistenceScore,
      velocity,
      compression,
      breakout,
    });

    const liquidityScore = computeLiquidityScore({
      ob: obx,
      depthOk,
      spreadPct: obx.spreadPct,
      depthMinUsd1p: obx.depthMinUsd1p,
    });

    const timingScore = computeTimingScore({
      mode,
      stage,
      breakout,
      volAcc,
      strongScans: prev?.strongScans || 0,
      eliteScans: prev?.eliteScans || 0,
      lateEntry: mode === "bull" ? isLateBullEntry(coin) : isLateBearEntry(coin),
      exhausted: mode === "bull" ? isBullExhausted(coin) : false,
      bounceTrap: mode === "bear" ? isBearBounceTrap(coin) : false,
    });

    const marketScore = computeMarketScore({ btc, mode, regime, whaleFlow });

    const btcAlignmentScore = computeBtcAlignmentScore({ btc, mode, regime });

    const perfectCandidateScore = computePerfectCandidateScore({
      qualityScore,
      liquidityScore,
      timingScore,
      marketScore,
    });

    // ✅ FIX: macroOk minder binair
    const macroOk =
      isMacroRegimeOk(regime) &&
      n(btcAlignmentScore, 0) >= APLUS_BTC_ALIGN;

    const aPlus =
      macroOk === true &&
      liquidityScore >= APLUS_LIQ &&
      perfectCandidateScore >= APLUS_PERF &&
      timingScore >= APLUS_TIMING &&
      tradePlan != null;

    const nearAPlus =
      macroOk === true &&
      liquidityScore >= NEAR_LIQ &&
      perfectCandidateScore >= NEAR_PERF &&
      timingScore >= NEAR_TIMING &&
      tradePlan != null;

    const isEliteStageForDesk =
      stage === "ELITE_IGNITION" ||
      stage === "ELITE_EXPANSION" ||
      stage === "ELITE_CASCADE" ||
      stage === "ALMOST";

    const superScannerCoin = aPlus;
    const tradeCandidate = aPlus;
    const scannerOnly = !superScannerCoin;

    let tradeDeskStatus = "IGNORE";

    const immediateOpen = aPlus && isEliteStageForDesk && timingScore >= IMMEDIATE_OPEN_TIMING;

    const confirmOpen =
      aPlus &&
      prev?.tradeDeskStatus === "WATCH" &&
      (prev?.watchScans || 0) >= (WATCH_CONFIRM_TO_OPEN - 1);

    if (immediateOpen || confirmOpen) tradeDeskStatus = "OPEN";
    else if (nearAPlus) tradeDeskStatus = "WATCH";
    else tradeDeskStatus = "IGNORE";

    const coinForDecision = {
      ...coin,
      side: sideFromMode(mode),
      stage,
      stageWhy,
      eliteType,
      tradeCandidate,
      superScannerCoin,
      scannerOnly,
      qualityScore,
      liquidityScore,
      timingScore,
      marketScore,
      btcAlignmentScore,
      perfectCandidateScore,
      ob: {
        bestBid: Number(n(obx.bestBid, 0).toFixed(8)),
        bestAsk: Number(n(obx.bestAsk, 0).toFixed(8)),
        spreadPct: Number(obx.spreadPct.toFixed(4)),
        depthBidUsd: Math.round(obx.depthBidUsd),
        depthAskUsd: Math.round(obx.depthAskUsd),
        score: Number(obx.score.toFixed(5)),
        depthMinUsd1p: Math.round(obx.depthMinUsd1p),
        valid: obx.valid,
        fresh: obx.fresh,
        stale: obx.stale,
        reason: obx.reason,
        lor: Number(n(obx.lor, 0).toFixed(4)),
      },
      thresholds: {
        depthFloorUsd: Math.round(floorUsd),
        depthOk,
      },
      breakout: {
        ready: !!breakout?.ready,
        breakoutPct: Number(n(breakout?.breakoutPct, 0).toFixed(3)),
        pressure: Number(n(breakout?.pressure, 0).toFixed(2)),
      },
      compression: {
        isCompressed: compression.isCompressed,
        flatPct: compression.flatPct,
      },
      volAcc: {
        short: Number(volAcc.short.toFixed(3)),
        medium: Number(volAcc.medium.toFixed(3)),
      },
      velocity: Number(velocity.toFixed(3)),
      entryQuality,
      persistenceScore,
      tradePlan,
      range24: n(coin.range24, 0),
    };

    const coinProfile = buildCoinProfile({ systemType: "main", coin: coinForDecision });

    const prevPositionState = prev?.positionState || {};
    const positionState = {
      inPosition: !!prev?.entryActive,
      cyclesInTrade: n(prevPositionState.cyclesInTrade, 0),
      minHoldCycles: n(prevPositionState.minHoldCycles, 5),
      weakHoldCount: n(prevPositionState.weakHoldCount, 0),
      maxWeakHoldCycles: n(prevPositionState.maxWeakHoldCycles, 2),
    };

    const execution = buildMainExecutionDecision({
      coin: coinForDecision,
      btc,
      regime,
      mode,
      coinProfile,
      positionState,
      scannerGate: tradeDeskStatus,
    });

    execution.scannerGate = tradeDeskStatus;
    execution.scannerReady = tradeDeskStatus === "OPEN";
    execution.scannerWatch = tradeDeskStatus === "WATCH";
    execution.scannerIgnore = tradeDeskStatus === "IGNORE";

    out.push({
      id: coin.id,
      symbol: sym,
      name: coin.name || "",
      image: coin.image || "",
      side: sideFromMode(mode),
      price: n(coin.price, 0),
      marketCap: n(coin.marketCap, 0),
      volume: n(coin.volume, 0),
      change24: n(coin.change24, 0),
      change1h: n(coin.change1h, 0),
      vm: n(coin.vm, 0),
      confidence: moveScore,
      entryQuality,
      persistenceScore,
      marketRegime: regime,
      stage,
      stageWhy,
      eliteType,
      tier: tier?.name || "unknown",
      ob: coinForDecision.ob,
      thresholds: coinForDecision.thresholds,
      compression: coinForDecision.compression,
      breakout: coinForDecision.breakout,
      volAcc: coinForDecision.volAcc,
      moveScore,
      velocity: Number(velocity.toFixed(3)),
      moonProbability: probs.moonProbability,
      dumpProbability: probs.dumpProbability,
      tradePlan: tradePlan
        ? {
            entry: Number(tradePlan.entry.toFixed(8)),
            sl: Number(tradePlan.sl.toFixed(8)),
            tp: Number(tradePlan.tp.toFixed(8)),
            rr: Number(tradePlan.rr.toFixed(2)),
            tpPct: Number(n(tradePlan.tpPct, 0).toFixed(2)),
            slPct: Number(n(tradePlan.slPct, 0).toFixed(2)),
          }
        : null,
      qualityScore,
      liquidityScore,
      timingScore,
      marketScore,
      btcAlignmentScore,
      perfectCandidateScore,
      superScannerCoin,
      tradeCandidate,
      scannerOnly,
      tradeDeskStatus,
      deskGate: tradeDeskStatus,
      deskMeta: null,
      systemType: "main",
      coinProfile,
      execution,
      range24: n(coin.range24, 0),
      _state: {
        priceHist: priceHistNext,
        volHist: volHistNext,
        stageHist: (prev?.stageHist || []).concat([stage]).slice(-12),
        volAcc,
      },
    });

    await sleep(8);
  }

  return { regime, coins: out };
}

// ======================================================
// Funnel balancer (UI only)
// (ongewijzigd)
// ======================================================
function canPromoteBalancedEntry(coin, mode, regime) {
  if (!coin) return false;
  if (coin.tradePlan == null) return false;
  if (up(coin.stage) !== "ALMOST") return false;
  if (String(regime || "").toUpperCase() === "HEADWIND") return false;
  const eq = n(coin.entryQuality, 0);
  const ps = n(coin.persistenceScore, 0);
  const brReady = !!coin?.breakout?.ready;
  const v1 = n(coin?.volAcc?.short, 1);
  const v2 = n(coin?.volAcc?.medium, 1);
  const ob = n(coin?.ob?.score, 0);
  if (eq < 68) return false;
  if (ps < 55) return false;
  if (!brReady) return false;
  if (v1 < 1.02 && v2 < 1.06) return false;
  if (mode === "bull" && ob < -0.01) return false;
  if (mode === "bear" && ob > 0.01) return false;
  return true;
}
function applyFunnelBalancer({ funnel, mode, regime, openCount, recentEntryCount }) {
  if (!funnel) return funnel;
  if (openCount >= MAX_OPEN_TRADES) return funnel;
  if (recentEntryCount >= MIN_RECENT_ENTRIES_TARGET) return funnel;
  if ((funnel.elite_expansion?.length || 0) + (funnel.elite_ignition?.length || 0) > 0) return funnel;
  const almost = Array.isArray(funnel.almost) ? [...funnel.almost] : [];
  if (!almost.length) return funnel;
  const idx = almost.findIndex((coin) => canPromoteBalancedEntry(coin, mode, regime));
  if (idx === -1) return funnel;
  const promoted = {
    ...almost[idx],
    stage: "ELITE_IGNITION",
    eliteType: "ignition",
    stageWhy: "funnel_balancer_promoted",
  };
  almost.splice(idx, 1);
  return {
    ...funnel,
    almost,
    elite_ignition: [promoted, ...(funnel.elite_ignition || [])].slice(0, 12),
  };
}

function calculateThesisDamage(coin, prevState, mode) {
  let damage = 0;
  const reasons = {};
  const obScore = n(coin?.ob?.score, 0);
  if (mode === "bull" && obScore < -0.02) {
    damage += 2;
    reasons.obContra = true;
  }
  if (mode === "bear" && obScore > 0.02) {
    damage += 2;
    reasons.obContra = true;
  }
  const v1 = n(coin?.volAcc?.short, 1);
  const v2 = n(coin?.volAcc?.medium, 1);
  if (v1 < 1.01 && v2 < 1.04) {
    damage += 1;
    reasons.volDead = true;
  }
  if (!coin?.breakout?.ready) {
    damage += 1;
    reasons.breakoutLost = true;
  }
  const ps = n(coin?.persistenceScore, 0);
  const prevPs = n(prevState?.persistenceScore, 0);
  if (ps < prevPs - 15) {
    damage += 2;
    reasons.persistDrop = true;
  }
  return { damage, reasons };
}

// ======================================================
// Handler
// ======================================================
export default async function handler(req, res) {
  let mode = "bull";
  let lockAcquired = false;

  try {
    if (!requireSecret(req, res)) return;

    mode = String(req.query?.mode || "bull").toLowerCase() === "bear" ? "bear" : "bull";

    const lock = await acquireScanLock(mode);
    if (!lock.ok) {
      const latest = await kv.get(keyMainLatest(mode));
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      if (latest) {
        return res.end(
          JSON.stringify({
            ...latest,
            meta: {
              ...(latest.meta || {}),
              scanLock: { active: true, until: lock.until || null },
            },
          })
        );
      }
      return res.end(JSON.stringify({ ok: true, skipped: true, reason: "scan_lock_active", mode }));
    }

    lockAcquired = true;

    const now = Date.now();
    const whaleFlow = await fetchExchangeFlows();
    const btc = await resolveBtcForMode(mode);

    const prevPositions = (await kv.get(keyMainPositions(mode))) || { open: [], closed: [] };
    const positions = {
      open: Array.isArray(prevPositions?.open) ? [...prevPositions.open] : [],
      closed: Array.isArray(prevPositions?.closed) ? [...prevPositions.closed] : [],
    };

    await applyCooldownsFromClosed(mode, positions, now);

    const built = await buildUniverse(mode, whaleFlow, btc, now);
    const universe = built.coins;
    const regime = built.regime;

    const prevState = (await kv.get(keyMainState(mode))) || {};
    const nextState = {};

    const universeMap = new Map();
    for (const c of universe) universeMap.set(c.symbol, c);

    const openMap = new Map(positions.open.map((p) => [up(p.symbol), p]));

    let funnel = splitFunnels(universe);
    const recentEntryCount = await readRecentEntryCount(mode);

    funnel = applyFunnelBalancer({
      funnel,
      mode,
      regime,
      openCount: positions.open.length,
      recentEntryCount,
    });

    for (const coin of universe) {
      const sym = up(coin.symbol);
      const prev = prevState?.[sym] || null;
      const hasOpenPosition = openMap.has(sym);
      if (hasOpenPosition) continue;

      const rawStage = up(coin.stage || "");

      let strongScans = 0;
      let weakScans = prev?.weakScans || 0;
      let thesisInvalidScans = prev?.thesisInvalidScans || 0;
      let entryLocked = prev?.entryLocked || false;
      let eliteScans = 0;
      let candidateSince = prev?.candidateSince || null;
      let eliteSince = prev?.eliteSince || null;
      let watchScans = prev?.watchScans || 0;

      if (rawStage === "RADAR") {
        weakScans = 0;
        thesisInvalidScans = 0;
        candidateSince = null;
        eliteSince = null;
        entryLocked = false;
        watchScans = 0;
      } else {
        if (isMainEliteStage(rawStage)) {
          strongScans = (prev?.strongScans || 0) + 1;
          eliteScans = (prev?.eliteScans || 0) + 1;
        } else {
          strongScans = 0;
          eliteScans = 0;
        }

        if (rawStage === "RADAR") weakScans = (prev?.weakScans || 0) + 1;
        else if (rawStage === "BUILDUP") weakScans = prev?.weakScans || 0;
        else weakScans = 0;

        if (rawStage === "RADAR") {
          candidateSince = null;
        } else {
          candidateSince = prev?.candidateSince;
          if (!candidateSince && (rawStage === "BUILDUP" || rawStage === "ALMOST" || isMainEliteStage(rawStage))) {
            candidateSince = now;
          }
        }

        if (isMainEliteStage(rawStage)) {
          if (!prev?.eliteSince || !isMainEliteStage(prev?.stage || "")) eliteSince = now;
          else eliteSince = prev.eliteSince;
        } else {
          eliteSince = null;
        }

        thesisInvalidScans = prev?.thesisInvalidScans || 0;
        entryLocked = prev?.entryLocked || false;

        if (coin.tradeDeskStatus === "WATCH") watchScans = (prev?.watchScans || 0) + 1;
        else if (prev?.tradeDeskStatus === "WATCH") watchScans = Math.max(0, (prev?.watchScans || 0) - 1);
        else watchScans = 0;
      }

      const btcAlign = n(coin.btcAlignmentScore, 0);
      const macroOkNow = isMacroRegimeOk(regime) && btcAlign >= APLUS_BTC_ALIGN;
      if (!macroOkNow) watchScans = 0;

      let depthHist = Array.isArray(prev?.depthHist) ? [...prev.depthHist] : [];
      const currentDepth = n(coin.ob?.depthMinUsd1p, 0);
      if (currentDepth > 0) depthHist.push(currentDepth);
      depthHist = depthHist.slice(-20);

      const thesisInfo = calculateThesisDamage(coin, prev, mode);
      const tradePlan = coin.tradePlan;

      let entryReady = false;
      if (!hasOpenPosition) {
        entryReady = coin.tradeDeskStatus === "OPEN" && entryLocked === false && coin.tradePlan != null;
      }

      const execMeta = coin.execution?.meta || {};
      const positionStateForStore = {
        inPosition: !!prev?.entryActive,
        cyclesInTrade: !!prev?.entryActive ? n((prev?.positionState?.cyclesInTrade || 0) + 1, 1) : 0,
        minHoldCycles: n(prev?.positionState?.minHoldCycles, 5),
        weakHoldCount:
          execMeta.action === "WEAK_HOLD"
            ? n(execMeta.weakHoldCount, 1)
            : execMeta.action === "HOLD"
              ? 0
              : n(prev?.positionState?.weakHoldCount, 0),
        maxWeakHoldCycles: n(prev?.positionState?.maxWeakHoldCycles, 2),
      };

      nextState[sym] = {
        ...prev,
        stage: rawStage,
        stageWhy: coin.stageWhy,
        eliteType: coin.eliteType,
        side: coin.side || sideFromMode(mode),

        price: coin.price,
        marketCap: coin.marketCap,
        volume: coin.volume,
        change24: coin.change24,
        change1h: coin.change1h,
        vm: coin.vm,

        confidence: coin.confidence,
        entryQuality: coin.entryQuality,
        persistenceScore: coin.persistenceScore,
        moveScore: coin.moveScore,
        velocity: coin.velocity,

        moonProbability: coin.moonProbability,
        dumpProbability: coin.dumpProbability,

        ob: coin.ob,
        thresholds: coin.thresholds,
        compression: coin.compression,
        breakout: coin.breakout,
        volAcc: coin.volAcc,

        tradePlan,

        thesisDamage: thesisInfo.damage,
        thesisReasons: thesisInfo.reasons,

        priceHist: coin._state.priceHist,
        volHist: coin._state.volHist,
        stageHist: coin._state.stageHist,
        depthHist,

        strongScans,
        weakScans,
        thesisInvalidScans,
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
        scannerOnly: !!coin.scannerOnly,

        tradeDeskStatus: coin.tradeDeskStatus || "IGNORE",
        deskGate: coin.tradeDeskStatus || "IGNORE",
        deskMeta: null,

        name: coin.name,
        image: coin.image,

        watchScans,
        positionState: positionStateForStore,
      };

      const isElitePreTrade = coin.tradeDeskStatus === "WATCH" && watchScans >= 2;

      if (!hasOpenPosition && isElitePreTrade) {
        await safeSendSignal({
          source: "main",
          stage: rawStage,
          mode,
          coin,
          btcState: btc?.state || "NEUTRAL",
          kind: "elite_watch",
          reason: "WATCH bevestigd — klaar voor OPEN bij volgende confirm",
        });
      }

      if (!hasOpenPosition && coin.tradeDeskStatus === "OPEN") {
        await safeSendSignal({
          source: "main",
          stage: "ENTRY",
          mode,
          coin,
          btcState: btc?.state || "NEUTRAL",
          kind: "signal",
          reason: "Scanner OPEN gate — trade engine mag activeren",
        });
      }
    }

    const entryCandidates = [];

    for (const sym of Object.keys(nextState)) {
      const state = nextState[sym];
      if (state.entryReady && state.tradeCandidate === true && state.tradeDeskStatus === "OPEN" && !openMap.has(sym)) {
        const coin = universeMap.get(sym);
        if (!coin || !coin.tradePlan) continue;

        const cdKey = cooldownKey(mode, sym);
        const cdUntil = await kv.get(cdKey);
        if (n(cdUntil, 0) > now) continue;

        entryCandidates.push({ sym, state, coin });
      }
    }

    entryCandidates.sort((a, b) => (b.coin.entryQuality || 0) - (a.coin.entryQuality || 0));

    const slotsLeft = MAX_OPEN_TRADES - positions.open.length;
    const toOpen = entryCandidates.slice(0, Math.min(slotsLeft, 1));

    for (const candidate of toOpen) {
      const { sym, coin, state } = candidate;

      const id = uid("main");

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
        stage: coin.stage,
        eliteType: coin.eliteType,
      };

      positions.open.push(newPos);

      nextState[sym] = {
        ...state,
        entryActive: true,
        entryLocked: true,
        entryReady: false,
        lastEntryAt: now,
        positionState: {
          inPosition: true,
          cyclesInTrade: 0,
          minHoldCycles: 5,
          weakHoldCount: 0,
          maxWeakHoldCycles: 2,
        },
      };

      await appendEntryHistory(mode);

      await safePushEvent("trade_opened", {
        id,
        mode,
        side: newPos.side,
        symbol: sym,
        entry: newPos.entryPrice,
        size: newPos.sizeUsd,
        tp: newPos.tp,
        sl: newPos.sl,
        rr: newPos.rr,
        stage: newPos.stage,
        eliteType: newPos.eliteType,
      });

      await safeSendSignal({
        source: "main",
        stage: coin.stage,
        mode,
        coin,
        btcState: btc?.state || "NEUTRAL",
        kind: "trade_opened",
      });
    }

    const portfolio = makePortfolio(mode, positions);
    await kv.set(keyMainPortfolio(mode), portfolio, { ex: 60 * 60 * 24 * 7 });

    positions.closed = positions.closed.slice(-1000);

    await kv.set(keyMainState(mode), nextState, { ex: 60 * 60 * 24 * 3 });
    await kv.set(keyMainPositions(mode), positions, { ex: 60 * 60 * 24 * 7 });

    const responseFunnel = { ...funnel, hold: [] };

    const premiumCandidates = universe
      .filter((c) => c.superScannerCoin === true)
      .sort((a, b) => (b.perfectCandidateScore || 0) - (a.perfectCandidateScore || 0))
      .slice(0, 12);

    const tradeReadyCandidates = universe
      .filter((c) => c.tradeDeskStatus === "OPEN")
      .sort((a, b) => (b.perfectCandidateScore || 0) - (a.perfectCandidateScore || 0))
      .slice(0, 20);

    const watchCandidates = universe
      .filter((c) => c.tradeDeskStatus === "WATCH")
      .sort((a, b) => (b.perfectCandidateScore || 0) - (a.perfectCandidateScore || 0))
      .slice(0, 20);

    const scannerOnlyCandidates = universe
      .filter((c) => c.superScannerCoin !== true)
      .sort((a, b) => (b.perfectCandidateScore || 0) - (a.perfectCandidateScore || 0))
      .slice(0, 20);

    const latest = {
      ok: true,
      mode,
      regime,
      btc: {
        price: n(btc?.price, 0),
        chg24: n(btc?.chg24, 0),
        chg1h: n(btc?.chg1h, 0),
        range24: n(btc?.range24, 0),
        state: String(btc?.state || "NEUTRAL").toUpperCase(),
      },
      whaleFlow: n(whaleFlow, 0),
      funnel: responseFunnel,
      counts: {
        elite_expansion: responseFunnel.elite_expansion?.length || 0,
        elite_ignition: responseFunnel.elite_ignition?.length || 0,
        almost: responseFunnel.almost?.length || 0,
        buildup: responseFunnel.buildup?.length || 0,
        radar: responseFunnel.radar?.length || 0,
        hold: 0,
      },
      candidates: {
        premium: premiumCandidates,
        tradeReady: tradeReadyCandidates,
        watch: watchCandidates,
        scannerOnly: scannerOnlyCandidates,
      },
      portfolio,
      positions: {
        open: positions.open.length,
        closed: positions.closed.length,
        openItems: positions.open.map((p) => ({
          id: p.id,
          symbol: p.symbol,
          mode: p.mode,
          side: p.side || sideFromMode(mode),
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
          eliteType: p.eliteType,
        })),
      },
      ts: now,
      scannedAt: now,
    };

    await kv.set(keyMainLatest(mode), latest, { ex: 60 * 60 });
    res.status(200).json(latest);
  } catch (err) {
    console.error("Main scan error:", err);
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    if (lockAcquired) await releaseScanLock(mode);
  }
}