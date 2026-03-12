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
  computeMoonRisk,
  calcPnlPct,
  hitStopOrTp,
  isBlockedMoonAsset,
  MOON_V2,
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
  computeMoonProbabilities,
} from "../../lib/_moon_core.js";

import { pushEvent, uid } from "../../lib/_analytics.js";
import { sendSignal } from "../../lib/discordRouter.js";

export const config = RUNTIME_CONFIG;

const BITGET_OB = "https://api.bitget.com/api/v2/spot/market/orderbook";

// ======================================================
// V7 / V8 SAFE ADDITIONS
// ======================================================
const SCAN_LOCK_TTL_SEC = 12 * 60;

const COOLDOWN_SL_SEC = 4 * 60 * 60;
const COOLDOWN_TP_SEC = 90 * 60;
const COOLDOWN_TIMEOUT_SEC = 60 * 60;

const MAX_OPEN_TRADES = 4;
const TIMEOUT_BARS = 16;
const TIMEOUT_MIN_PNL_PCT = 1.0;

const ENTRY_HISTORY_KEEP = 40;
const ENTRY_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MIN_RECENT_ENTRIES_TARGET = 2;

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

function scanLockKey(mode) {
  return `moon:scan:lock:${String(mode || "bull").toLowerCase()}`;
}

function cooldownKey(mode, symbol) {
  return `moon:cooldown:${String(mode || "bull").toLowerCase()}:${up(symbol)}`;
}

function entryHistoryKey(mode) {
  return `moon:entry:history:${String(mode || "bull").toLowerCase()}`;
}

async function acquireScanLock(mode) {
  const key = scanLockKey(mode);
  const ok = await kv.set(key, { ts: Date.now(), mode }, { nx: true, ex: SCAN_LOCK_TTL_SEC });
  return { ok: !!ok, key };
}

async function releaseScanLock(mode) {
  try {
    await kv.del(scanLockKey(mode));
  } catch {}
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

function isMoonEliteStage(stage) {
  const s = up(stage);
  return s === "ELITE_IGNITION" || s === "ELITE_EXPANSION" || s === "ELITE_CASCADE";
}

function isMoonSignalStage(stage) {
  const s = up(stage);
  return s === "ALMOST" || isMoonEliteStage(s);
}

function displayStageForCoin(rawStage, hasOpenPosition) {
  return hasOpenPosition ? "HOLD" : up(rawStage);
}

async function sendTelegram(msg) {
  const token = process.env.TELEGRAM_TOKEN;
  const chat = process.env.TELEGRAM_CHAT;
  if (!token || !chat) return;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: msg }),
    });
  } catch (e) {
    console.error("Telegram send failed:", e);
  }
}

async function fetchExchangeFlows() {
  try {
    const r = await fetch("https://api.binance.com/api/v3/ticker/24hr");
    if (!r.ok) return 0;
    const data = await r.json();
    return data.filter((x) => Number(x.quoteVolume) > 200_000_000).length;
  } catch {
    return 0;
  }
}

function stageToScanFunnel(stage, eliteType = null) {
  if (eliteType === "expansion") return "scan_entry_expansion";
  if (eliteType === "ignition") return "scan_entry_ignition";
  if (eliteType === "cascade") return "scan_entry_cascade";

  const s = up(stage);
  if (s === "ELITE_EXPANSION" || s === "ELITE_CASCADE") return "scan_entry";
  if (s === "ELITE_IGNITION") return "scan_entry_ignition";
  if (s === "ALMOST") return "scan_almost";
  if (s === "BUILDUP") return "scan_buildup";
  return "scan_radar";
}

async function fetchOrderbook(symbol) {
  try {
    const url = `${BITGET_OB}?symbol=${symbol}&type=step0&limit=20`;
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) return null;
    const j = await r.json();
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
    posUsd: 50,
    openCount: open.length,
    closedCount: closed.length,
    realizedUsd: Number(realizedUsd.toFixed(2)),
    avgRealizedPct: Number(avgRealizedPct.toFixed(2)),
    updatedAt: Date.now(),
  };
}

function isLateBullEntry(coin) {
  const ch1h = n(coin?.change1h, 0);
  const ch24 = n(coin?.change24, 0);
  const vm = n(coin?.vm, 0);

  if (ch1h >= 15 && ch24 >= 38) return true;
  if (ch1h >= 11 && ch24 >= 48) return true;
  if (ch24 >= 65 && vm < 1.1) return true;

  return false;
}

function isLateBearEntry(coin) {
  const ch1h = n(coin?.change1h, 0);
  const ch24 = n(coin?.change24, 0);
  const vm = n(coin?.vm, 0);

  if (ch1h <= -15 && ch24 <= -38) return true;
  if (ch1h <= -11 && ch24 <= -48) return true;
  if (ch24 <= -65 && vm < 1.1) return true;

  return false;
}

function hasEliteFollowThrough(prev, currentStage) {
  const hist = Array.isArray(prev?.stageHist) ? prev.stageHist : [];
  const tail = hist.concat([currentStage]).slice(-3);
  const eliteLike = tail.filter((s) => {
    const x = up(s);
    return x === "ELITE_IGNITION" || x === "ELITE_EXPANSION" || x === "ELITE_CASCADE";
  }).length;

  return eliteLike >= 1 || up(currentStage) === "ELITE_EXPANSION" || up(currentStage) === "ELITE_CASCADE";
}

function decideMoonStageV6({ mode, coin, obx, priceHist, volHist, btc, prev, whaleFlow, regime }) {
  const baseCfg = MOON_V2[mode];
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
    return {
      stage: "RADAR",
      stageWhy: "bull_exhausted",
      moveScore: 0,
      velocity,
      compression,
      breakout,
      eliteType: null,
      persistenceScore,
      entryQuality: 0,
    };
  }

  if (mode === "bear" && isBearBounceTrap(coin)) {
    return {
      stage: "RADAR",
      stageWhy: "bear_bounce_trap",
      moveScore: 0,
      velocity,
      compression,
      breakout,
      eliteType: null,
      persistenceScore,
      entryQuality: 0,
    };
  }

  if (mode === "bull" && isLateBullEntry(coin)) {
    return {
      stage: "ALMOST",
      stageWhy: "late_bull_entry",
      moveScore: 0,
      velocity,
      compression,
      breakout,
      eliteType: null,
      persistenceScore,
      entryQuality: 0,
    };
  }

  if (mode === "bear" && isLateBearEntry(coin)) {
    return {
      stage: "ALMOST",
      stageWhy: "late_bear_entry",
      moveScore: 0,
      velocity,
      compression,
      breakout,
      eliteType: null,
      persistenceScore,
      entryQuality: 0,
    };
  }

  const moveScore =
    mode === "bull"
      ? computeBullMoveScore(coin, obx)
      : computeBearMoveScore(coin, obx);

  const entryQuality = computeEliteQuality({
    moveScore,
    velocity,
    vm: coin.vm,
    obScore: obx.score,
    compression,
    volAcc,
    persistenceScore,
    regime,
  });

  const btcMomentumOk =
    mode === "bull"
      ? n(btc?.chg24, 0) >= 0.8 && n(btc?.range24, 0) >= 2.8
      : n(btc?.chg24, 0) <= -0.8 && n(btc?.range24, 0) >= 2.8;

  if (volAcc.short < 1.04 && volAcc.medium < 1.12 && moveScore < 76) {
    return {
      stage: "ALMOST",
      stageWhy: "volume_not_accelerating",
      moveScore,
      velocity,
      compression,
      breakout,
      eliteType: null,
      persistenceScore,
      entryQuality,
    };
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
      entryQuality >= 76
    ) {
      stage = "ELITE_EXPANSION";
      eliteType = "expansion";
    } else if (
      n(coin.change1h, 0) >= n(cfg.minCh1hIgnition, 0) &&
      n(coin.change24, 0) >= n(cfg.minCh24Ignition, 0) &&
      n(coin.vm, 0) >= n(cfg.minVmElite, 0) &&
      n(obx.score, 0) >= n(cfg.minObStrong, 0) &&
      velocity >= n(cfg.strongVelocity, 0) &&
      entryQuality >= 66
    ) {
      stage = "ELITE_IGNITION";
      eliteType = "ignition";
    } else if (
      n(coin.change1h, 0) >= n(cfg.minCh1hAlmost, 0) &&
      n(coin.change24, 0) >= n(cfg.minCh24Almost, 0) &&
      n(coin.vm, 0) >= n(cfg.minVmAlmost, 0) &&
      velocity >= n(cfg.strongVelocity, 0)
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
      entryQuality >= 76
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
      entryQuality >= 66
    ) {
      stage = "ELITE_IGNITION";
      eliteType = "ignition";
    } else if (
      n(coin.change1h, 0) <= n(cfg.maxCh1hAlmost, 0) &&
      n(coin.change24, 0) <= n(cfg.maxCh24Almost, 0) &&
      n(coin.vm, 0) >= n(cfg.minVmAlmost, 0) &&
      velocity >= n(cfg.strongVelocity, 0)
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

  if (isMoonEliteStage(stage) && !breakout.ready && entryQuality < 86) {
    stage = "ALMOST";
    eliteType = null;
  }

  if (isMoonEliteStage(stage) && !btcMomentumOk && regime !== "EXPANSION") {
    return {
      stage: "ALMOST",
      stageWhy: "btc_not_expanding",
      moveScore,
      velocity,
      compression,
      breakout,
      eliteType: null,
      persistenceScore,
      entryQuality,
    };
  }

  if (isMoonEliteStage(stage) && !hasEliteFollowThrough(prev, stage)) {
    return {
      stage: "ALMOST",
      stageWhy: "elite_needs_followthrough",
      moveScore,
      velocity,
      compression,
      breakout,
      eliteType: null,
      persistenceScore,
      entryQuality,
    };
  }

  return {
    stage,
    stageWhy: "ok",
    moveScore,
    velocity,
    compression,
    breakout,
    eliteType,
    persistenceScore,
    entryQuality,
  };
}

async function buildUniverse(mode, whaleFlow, btc) {
  const regime = computeMarketRegime({ btc, whaleFlow, mode });

  const rawCoins = await fetchCoinGeckoTopCached();
  const bitgetSymbols = await getBitgetSpotUsdtSymbols();

  const step1 = rawCoins.filter((c) => !isBlockedMoonAsset(c));
  const step2 = step1.filter((c) => bitgetSymbols.has(up(c.symbol)));

  console.log("🔍 MOON V6 DEBUG", {
    regime,
    rawCoins: rawCoins.length,
    afterBlocked: step1.length,
    bitgetSymbols: bitgetSymbols.size,
    afterBitget: step2.length,
    sampleCg: step1.slice(0, 10).map((c) => c.symbol),
    sampleBitget: Array.from(bitgetSymbols).slice(0, 20),
  });

  const filtered = step2.slice(0, 220);
  const out = [];
  const state = (await kv.get(keyMoonState(mode))) || {};

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

    const stageDecision = decideMoonStageV6({
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

    out.push({
      id: coin.id,
      symbol: sym,
      name: coin.name || "",
      image: coin.image || "",
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
      ob: {
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
      compression: {
        isCompressed: compression.isCompressed,
        flatPct: compression.flatPct,
      },
      breakout: {
        ready: !!breakout?.ready,
        breakoutPct: Number(n(breakout?.breakoutPct, 0).toFixed(3)),
        pressure: Number(n(breakout?.pressure, 0).toFixed(2)),
      },
      volAcc: {
        short: Number(volAcc.short.toFixed(3)),
        medium: Number(volAcc.medium.toFixed(3)),
      },
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
      _state: {
        priceHist: priceHistNext,
        volHist: volHistNext,
        stageHist: (prev?.stageHist || []).concat([stage]).slice(-12),
        volAcc,
      },
    });

    await sleep(40);
  }

  return { regime, coins: out };
}

// ======================================================
// FUNNEL BALANCER
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

  if (eq < 62) return false;
  if (ps < 50) return false;
  if (!brReady && eq < 72) return false;
  if (v1 < 1.01 && v2 < 1.05) return false;

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

export default async function handler(req, res) {
  let mode = "bull";
  let lockAcquired = false;

  try {
    if (!requireSecret(req, res)) return;
    mode = String(req.query?.mode || "bull").toLowerCase() === "bear" ? "bear" : "bull";

    const lock = await acquireScanLock(mode);
    if (!lock.ok) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      return res.end(
        JSON.stringify({
          ok: true,
          skipped: true,
          reason: "scan_lock_active",
          mode,
        })
      );
    }
    lockAcquired = true;

    const now = Date.now();
    const whaleFlow = await fetchExchangeFlows();
    const btc = await fetchBTCGateFromUniverse();

    const built = await buildUniverse(mode, whaleFlow, btc);
    const universe = built.coins;
    const regime = built.regime;

    const prevPositions = (await kv.get(keyMoonPositions(mode))) || { open: [], closed: [] };
    const positions = {
      open: Array.isArray(prevPositions?.open) ? [...prevPositions.open] : [],
      closed: Array.isArray(prevPositions?.closed) ? [...prevPositions.closed] : [],
    };

    const prevState = (await kv.get(keyMoonState(mode))) || {};
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

      const prevStage = up(prev?.stage || "");
      const rawStage = up(coin.stage || "");
      const hasOpenPosition = openMap.has(sym);
      const publicStage = displayStageForCoin(rawStage, hasOpenPosition);

      nextState[sym] = {
        symbol: sym,
        stage: publicStage,
        rawStage,
        lastSeenAt: now,
        confidence: coin.confidence,
        entryQuality: coin.entryQuality,
        persistenceScore: coin.persistenceScore,
        marketRegime: coin.marketRegime,
        price: coin.price,
        priceHist: coin?._state?.priceHist || [],
        volHist: coin?._state?.volHist || [],
        stageHist: coin?._state?.stageHist || [],
        entryActive: hasOpenPosition,
        volAcc: coin?._state?.volAcc || { short: 1, medium: 1 },
      };

      if (!prevStage) {
        await pushEvent(stageToScanFunnel(rawStage, coin.eliteType), {
          symbol: sym,
          mode,
          stage: rawStage,
          prevStage: "",
          price: coin.price,
          confidence: coin.entryQuality || coin.confidence,
          change24: coin.change24,
          change1h: coin.change1h,
          ob: coin.ob,
          tradePlan: coin.tradePlan,
          btcState: btc.state,
          reason: "new_in_scan",
        });

        if (!hasOpenPosition && isMoonSignalStage(rawStage)) {
          await sendSignal({
            source: "moon",
            stage: rawStage,
            mode,
            coin,
            btcState: btc.state,
            kind: "signal",
          });

          await sendTelegram(
            `🆕 Nieuwe ${rawStage}${coin.eliteType ? ` (${coin.eliteType})` : ""} moon coin: ${sym}\nPrijs: $${coin.price}\nEntry quality: ${coin.entryQuality}\nRegime: ${coin.marketRegime}`
          );
        }
      } else if (prevStage !== publicStage && !hasOpenPosition) {
        await pushEvent("scan_transition", {
          symbol: sym,
          mode,
          from: prevStage,
          to: publicStage,
          reason: "stage_changed",
        });

        if (isMoonSignalStage(rawStage)) {
          await sendSignal({
            source: "moon",
            stage: rawStage,
            mode,
            coin,
            btcState: btc.state,
            kind: "signal",
          });
        }

        if (prevStage === "BUILDUP" && rawStage === "ALMOST") {
          await sendTelegram(
            `🚀 BUILDUP → ALMOST: ${sym}\nPrijs: $${coin.price}\nEntry quality: ${coin.entryQuality}`
          );
        } else if (prevStage === "ALMOST" && isMoonEliteStage(rawStage)) {
          await sendTelegram(
            `🔥 ALMOST → ${rawStage}${coin.eliteType ? ` (${coin.eliteType})` : ""}: ${sym}\nPrijs: $${coin.price}\nEntry quality: ${coin.entryQuality}`
          );
        }
      }
    }

    for (const coin of [...funnel.elite_expansion, ...funnel.elite_ignition]) {
      if (positions.open.length >= MAX_OPEN_TRADES) break;

      const sym = up(coin.symbol);
      if (openMap.has(sym)) continue;
      if (!coin.tradePlan) continue;

      const cooldown = await kv.get(cooldownKey(mode, sym));
      if (cooldown) continue;

      const trade = {
        id: uid("moon"),
        symbol: sym,
        mode,
        status: "OPEN",
        stage: coin.stage,
        eliteType: coin.eliteType,
        regime: coin.marketRegime,
        entryAt: now,
        entryPrice: coin.price,
        lastPrice: coin.price,
        pnlPct: 0,
        pnlUsd: 0,
        barsOpen: 0,
        tp: coin.tradePlan?.tp ?? null,
        sl: coin.tradePlan?.sl ?? null,
        rr: coin.tradePlan?.rr ?? null,
        tpPct: coin.tradePlan?.tpPct ?? null,
        slPct: coin.tradePlan?.slPct ?? null,
        entryQuality: coin.entryQuality,
        persistenceScore: coin.persistenceScore,
      };

      positions.open.push(trade);
      openMap.set(sym, trade);

      await pushEvent("scan_entry", {
        symbol: sym,
        mode,
        stage: "ENTRY",
        prevStage: coin.stage,
        price: coin.price,
        confidence: coin.entryQuality || coin.confidence,
        change24: coin.change24,
        change1h: coin.change1h,
        ob: coin.ob,
        tradePlan: coin.tradePlan,
        btcState: btc.state,
        reason: coin.stageWhy === "funnel_balancer_promoted" ? "elite_entry_balanced" : "elite_entry",
      });

      await appendEntryHistory(mode);

      nextState[sym] = {
        ...(nextState[sym] || {}),
        symbol: sym,
        stage: "HOLD",
        rawStage: up(coin.stage),
        lastSeenAt: now,
        confidence: coin.confidence,
        entryQuality: coin.entryQuality,
        persistenceScore: coin.persistenceScore,
        marketRegime: coin.marketRegime,
        price: coin.price,
        priceHist: coin?._state?.priceHist || nextState[sym]?.priceHist || [],
        volHist: coin?._state?.volHist || nextState[sym]?.volHist || [],
        stageHist: coin?._state?.stageHist || nextState[sym]?.stageHist || [],
        entryActive: true,
        entryAt: now,
        entryPrice: coin.price,
        volAcc: coin?._state?.volAcc || { short: 1, medium: 1 },
      };
    }

    const survivors = [];

    for (const trade of positions.open) {
      const sym = up(trade.symbol);
      const coin = universeMap.get(sym);

      if (!coin) {
        survivors.push(trade);

        if (!nextState[sym]) {
          nextState[sym] = {
            symbol: sym,
            stage: "HOLD",
            rawStage: trade.stage || "RADAR",
            lastSeenAt: now,
            entryActive: true,
            price: trade.lastPrice,
            priceHist: [],
            volHist: [],
            stageHist: [],
            volAcc: { short: 1, medium: 1 },
          };
        } else {
          nextState[sym].stage = "HOLD";
          nextState[sym].entryActive = true;
        }
        continue;
      }

      trade.lastPrice = coin.price;
      trade.barsOpen = n(trade.barsOpen, 0) + 1;

      const pnlPct = calcPnlPct({
        mode,
        entryPrice: trade.entryPrice,
        priceNow: coin.price,
      });

      trade.pnlPct = Number(pnlPct.toFixed(2));
      trade.pnlUsd = Number(((50 * pnlPct) / 100).toFixed(2));

      if (trade.barsOpen >= TIMEOUT_BARS && trade.pnlPct < TIMEOUT_MIN_PNL_PCT) {
        const closed = {
          ...trade,
          status: "CLOSED",
          exitAt: now,
          exitPrice: coin.price,
          exitReason: "timeout",
        };

        positions.closed.unshift(closed);

        await kv.set(cooldownKey(mode, sym), Date.now(), { ex: COOLDOWN_TIMEOUT_SEC });

        await pushEvent("trade_timeout", {
          symbol: closed.symbol,
          entryPrice: closed.entryPrice,
          exitPrice: closed.exitPrice,
          pnlPct: closed.pnlPct,
          barsOpen: closed.barsOpen,
        });

        await pushEvent("scan_sell", {
          symbol: coin.symbol,
          mode,
          stage: "SELL",
          prevStage: "HOLD",
          price: coin.price,
          confidence: coin.entryQuality || coin.confidence,
          change24: coin.change24,
          change1h: coin.change1h,
          ob: coin.ob,
          tradePlan: coin.tradePlan,
          btcState: btc.state,
          reason: "timeout",
        });

        nextState[sym] = {
          ...(nextState[sym] || {}),
          symbol: sym,
          stage: "SELL",
          rawStage: up(coin.stage),
          lastSeenAt: now,
          entryActive: false,
          confidence: coin.confidence,
          entryQuality: coin.entryQuality,
          persistenceScore: coin.persistenceScore,
          marketRegime: coin.marketRegime,
          price: coin.price,
          priceHist: coin?._state?.priceHist || nextState[sym]?.priceHist || [],
          volHist: coin?._state?.volHist || nextState[sym]?.volHist || [],
          stageHist: coin?._state?.stageHist || nextState[sym]?.stageHist || [],
          volAcc: coin?._state?.volAcc || { short: 1, medium: 1 },
        };

        continue;
      }

      const hit = hitStopOrTp({
        mode,
        priceNow: coin.price,
        sl: trade.sl,
        tp3: trade.tp,
      });

      if (hit.hit) {
        const closed = {
          ...trade,
          status: "CLOSED",
          exitAt: now,
          exitPrice: coin.price,
          exitReason: hit.kind,
        };

        positions.closed.unshift(closed);

        const cooldownSec = hit.kind === "SL" ? COOLDOWN_SL_SEC : COOLDOWN_TP_SEC;
        await kv.set(cooldownKey(mode, sym), Date.now(), { ex: cooldownSec });

        await pushEvent(`trade_${hit.kind.toLowerCase()}`, {
          symbol: closed.symbol,
          entryPrice: closed.entryPrice,
          exitPrice: closed.exitPrice,
          pnlPct: closed.pnlPct,
          barsOpen: closed.barsOpen,
        });

        await pushEvent("scan_sell", {
          symbol: coin.symbol,
          mode,
          stage: "SELL",
          prevStage: "HOLD",
          price: coin.price,
          confidence: coin.entryQuality || coin.confidence,
          change24: coin.change24,
          change1h: coin.change1h,
          ob: coin.ob,
          tradePlan: coin.tradePlan,
          btcState: btc.state,
          reason: `${hit.kind}_hit`,
        });

        nextState[sym] = {
          ...(nextState[sym] || {}),
          symbol: sym,
          stage: "SELL",
          rawStage: up(coin.stage),
          lastSeenAt: now,
          entryActive: false,
          confidence: coin.confidence,
          entryQuality: coin.entryQuality,
          persistenceScore: coin.persistenceScore,
          marketRegime: coin.marketRegime,
          price: coin.price,
          priceHist: coin?._state?.priceHist || nextState[sym]?.priceHist || [],
          volHist: coin?._state?.volHist || nextState[sym]?.volHist || [],
          stageHist: coin?._state?.stageHist || nextState[sym]?.stageHist || [],
          volAcc: coin?._state?.volAcc || { short: 1, medium: 1 },
        };

        continue;
      }

      await pushEvent("scan_hold", {
        symbol: coin.symbol,
        mode,
        stage: "HOLD",
        prevStage: coin.stage,
        price: coin.price,
        confidence: coin.entryQuality || coin.confidence,
        change24: coin.change24,
        change1h: coin.change1h,
        ob: coin.ob,
        tradePlan: coin.tradePlan,
        btcState: btc.state,
        reason: "position_open",
      });

      nextState[sym] = {
        ...(nextState[sym] || {}),
        symbol: sym,
        stage: "HOLD",
        rawStage: up(coin.stage),
        lastSeenAt: now,
        entryActive: true,
        confidence: coin.confidence,
        entryQuality: coin.entryQuality,
        persistenceScore: coin.persistenceScore,
        marketRegime: coin.marketRegime,
        price: coin.price,
        priceHist: coin?._state?.priceHist || nextState[sym]?.priceHist || [],
        volHist: coin?._state?.volHist || nextState[sym]?.volHist || [],
        stageHist: coin?._state?.stageHist || nextState[sym]?.stageHist || [],
        entryAt: trade.entryAt,
        entryPrice: trade.entryPrice,
        volAcc: coin?._state?.volAcc || { short: 1, medium: 1 },
      };

      survivors.push(trade);
    }

    positions.open = survivors;
    positions.closed = positions.closed.slice(0, 1000);

    const portfolio = makePortfolio(mode, positions);

    const latest = {
      ok: true,
      ts: now,
      mode,
      regime,
      btc: {
        state: btc.state,
        chg24: Number(n(btc.chg24, 0).toFixed(2)),
        chg1h: Number(n(btc.chg1h, 0).toFixed(2)),
        range24: Number(n(btc.range24, 0).toFixed(2)),
      },
      counts: {
        elite_expansion: funnel.elite_expansion.length,
        elite_ignition: funnel.elite_ignition.length,
        almost: funnel.almost.length,
        buildup: funnel.buildup.length,
        radar: funnel.radar.length,
      },
      meta: {
        recentEntryCount,
        maxOpenTrades: MAX_OPEN_TRADES,
        timeoutBars: TIMEOUT_BARS,
      },
      funnel,
      portfolio,
      positions,
      whaleFlow,
    };

    await kv.set(keyMoonLatest(mode), latest, { ex: 60 * 60 });
    await kv.set(keyMoonState(mode), nextState, { ex: 60 * 60 * 24 });
    await kv.set(keyMoonPortfolio(mode), portfolio, { ex: 60 * 60 * 24 });
    await kv.set(keyMoonPositions(mode), positions, { ex: 60 * 60 * 24 });

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(latest));
  } catch (e) {
    console.error("MOON SCAN ERROR:", e);
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    return res.end(
      JSON.stringify({
        ok: false,
        where: "api/moon/scan.js",
        mode,
        error: String(e?.message || e),
      })
    );
  } finally {
    if (lockAcquired) {
      await releaseScanLock(mode);
    }
  }
}