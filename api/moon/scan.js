// /api/moon/scan.js
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
  computeBullMoveScore,
  computeBearMoveScore,
  isBullExhausted,
  isBearBounceTrap,
  computeMoonProbabilities,
} from "../../lib/_moon_core.js";

import {
  pushEvent,
  uid,
} from "../../lib/_analytics.js";

import { sendSignal } from "../../lib/discordRouter.js";

export const config = RUNTIME_CONFIG;

const BITGET_OB = "https://api.bitget.com/api/v2/spot/market/orderbook";

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
  if (eliteType === 'expansion') return "scan_entry_expansion";
  if (eliteType === 'ignition') return "scan_entry_ignition";
  if (eliteType === 'cascade') return "scan_entry_cascade";
  const s = String(stage || "").toUpperCase();
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
    const bestBid = n(bids[0]?.[0]);
    const bestAsk = n(asks[0]?.[0]);
    if (!(bestBid > 0 && bestAsk > 0)) return null;
    const spreadPct = ((bestAsk - bestBid) / bestBid) * 100;
    const depthBidUsd = bids.slice(0,8).reduce((a,b) => a + n(b?.[1]) * n(b?.[0]), 0);
    const depthAskUsd = asks.slice(0,8).reduce((a,b) => a + n(b?.[1]) * n(b?.[0]), 0);
    const total = depthBidUsd + depthAskUsd;
    const score = total > 0 ? (depthBidUsd - depthAskUsd) / total : 0;
    const largestBidUsd = Math.max(...bids.slice(0,8).map(b => n(b?.[1]) * n(b?.[0])), 0);
    const largestAskUsd = Math.max(...asks.slice(0,8).map(b => n(b?.[1]) * n(b?.[0])), 0);
    const largestOrderRatio = total > 0 ? Math.max(largestBidUsd, largestAskUsd) / total : 0;
    return {
      status: "ok", valid: true, fresh: true, stale: false, reason: "",
      spreadPct, depthBidUsd, depthAskUsd, depthMinUsd1p: Math.min(depthBidUsd, depthAskUsd),
      score, lor: largestOrderRatio,
    };
  } catch {
    return null;
  }
}

function computeObScore(ob) {
  if (!ob) {
    return {
      spreadPct: 999, depthBidUsd: 0, depthAskUsd: 0, depthMinUsd1p: 0,
      score: 0, lor: 1, valid: false, fresh: false, stale: true,
      reason: "missing_snapshot", status: "none",
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

function buildTradePlan(price, mode, confidence, range24, depthOk, tier) {
  const risk = computeMoonRisk({ mode, price, range24, confidence, depthOk, tier });
  if (!risk) return null;
  return {
    entry: Number(price.toFixed(8)),
    sl: Number(risk.sl.toFixed(8)),
    tp: Number(risk.tp3.toFixed(8)),
    rr: Number((risk.tpPct / Math.max(risk.slPct, 0.0001)).toFixed(2)),
  };
}

function sortByStageScore(mode) {
  return (a, b) => {
    return (
      n(b?.confidence, 0) - n(a?.confidence, 0) ||
      n(b?.moonProbability || b?.dumpProbability || 0, 0) - n(a?.moonProbability || a?.dumpProbability || 0, 0) ||
      n(b?.vm, 0) - n(a?.vm, 0)
    );
  };
}

function splitFunnels(coins, mode) {
  const funnel = {
    elite_expansion: [],
    elite_ignition: [],
    almost: [],
    buildup: [],
    radar: [],
  };

  for (const c of coins) {
    if (c.stage === "ELITE_EXPANSION" || c.stage === "ELITE_CASCADE") {
      funnel.elite_expansion.push(c);
    } else if (c.stage === "ELITE_IGNITION") {
      funnel.elite_ignition.push(c);
    } else if (c.stage === "ALMOST") {
      funnel.almost.push(c);
    } else if (c.stage === "BUILDUP") {
      funnel.buildup.push(c);
    } else {
      funnel.radar.push(c);
    }
  }

  const sorter = sortByStageScore(mode);

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
  let realizedUsd = 0, avgRealizedPct = 0;
  if (closed.length) {
    realizedUsd = closed.reduce((a,b) => a + n(b.pnlUsd), 0);
    avgRealizedPct = closed.reduce((a,b) => a + n(b.pnlPct), 0) / closed.length;
  }
  return {
    mode, posUsd: 50,
    openCount: open.length, closedCount: closed.length,
    realizedUsd: Number(realizedUsd.toFixed(2)),
    avgRealizedPct: Number(avgRealizedPct.toFixed(2)),
    updatedAt: Date.now(),
  };
}

// ======================================================
// NIEUWE UPGRADE 2: LATE-ENTRY BLOCKER
// ======================================================
function isLateBullEntry(coin) {
  const ch1h = Number(coin?.change1h || 0);
  const ch24 = Number(coin?.change24 || 0);
  const vm = Number(coin?.vm || 0);

  if (ch1h >= 12 && ch24 >= 30) return true;
  if (ch1h >= 9 && ch24 >= 40) return true;
  if (ch24 >= 55 && vm < 1.2) return true;

  return false;
}

function isLateBearEntry(coin) {
  const ch1h = Number(coin?.change1h || 0);
  const ch24 = Number(coin?.change24 || 0);
  const vm = Number(coin?.vm || 0);

  if (ch1h <= -12 && ch24 <= -30) return true;
  if (ch1h <= -9 && ch24 <= -40) return true;
  if (ch24 <= -55 && vm < 1.2) return true;

  return false;
}

// ======================================================
// NIEUWE UPGRADE 3: MULTI-SCAN FOLLOW-THROUGH
// ======================================================
function hasEliteFollowThrough(prev, currentStage) {
  const hist = Array.isArray(prev?.stageHist) ? prev.stageHist : [];
  const tail = hist.concat([currentStage]).slice(-3);
  const eliteLike = tail.filter(s =>
    s === "ELITE_IGNITION" || s === "ELITE_EXPANSION" || s === "ELITE_CASCADE"
  ).length;

  return eliteLike >= 2;
}

// ======================================================
// NIEUWE stage-bepaling op basis van MOON_V2 thresholds + upgrades
// ======================================================
function decideMoonStageV2({ mode, coin, obx, priceHist, btc, prev }) {
  const velocity = computeVelocity(coin.change1h, coin.change24);
  const compression = computeCompression(priceHist);

  // Eerst uitsluiten op basis van exhaustion / bounce trap
  if (mode === "bull" && isBullExhausted(coin)) {
    return { stage: "RADAR", stageWhy: "bull_exhausted", moveScore: 0, velocity, compression, eliteType: null };
  }
  if (mode === "bear" && isBearBounceTrap(coin)) {
    return { stage: "RADAR", stageWhy: "bear_bounce_trap", moveScore: 0, velocity, compression, eliteType: null };
  }

  // Upgrade 2: late-entry check
  if (mode === "bull" && isLateBullEntry(coin)) {
    return { stage: "ALMOST", stageWhy: "late_bull_entry", moveScore: 0, velocity, compression, eliteType: null };
  }
  if (mode === "bear" && isLateBearEntry(coin)) {
    return { stage: "ALMOST", stageWhy: "late_bear_entry", moveScore: 0, velocity, compression, eliteType: null };
  }

  const cfg = MOON_V2[mode];
  const moveScore = mode === "bull" ? computeBullMoveScore(coin, obx) : computeBearMoveScore(coin, obx);

  // Upgrade 1: BTC momentum gate
  const btcMomentumOk = mode === "bull"
    ? Number(btc?.chg24 || 0) >= 1.2 && Number(btc?.range24 || 0) >= 3.5
    : Number(btc?.chg24 || 0) <= -1.2 && Number(btc?.range24 || 0) >= 3.5;

  let stage, eliteType;

  if (mode === "bull") {
    // ELITE_EXPANSION (sterkste)
    if (
      coin.change1h >= cfg.minCh1hExpansion &&
      coin.change24 >= cfg.minCh24Expansion &&
      coin.vm >= cfg.minVmElite &&
      obx.score >= cfg.minObStrong &&
      velocity >= cfg.explosiveVelocity
    ) {
      stage = "ELITE_EXPANSION";
      eliteType = "expansion";
    }
    // ELITE_IGNITION
    else if (
      coin.change1h >= cfg.minCh1hIgnition &&
      coin.change24 >= cfg.minCh24Ignition &&
      coin.vm >= cfg.minVmElite &&
      obx.score >= cfg.minObStrong &&
      velocity >= cfg.strongVelocity
    ) {
      stage = "ELITE_IGNITION";
      eliteType = "ignition";
    }
    // ALMOST
    else if (
      coin.change1h >= cfg.minCh1hAlmost &&
      coin.change24 >= cfg.minCh24Almost &&
      coin.vm >= cfg.minVmAlmost &&
      velocity >= cfg.strongVelocity
    ) {
      stage = "ALMOST";
      eliteType = null;
    }
    // BUILDUP
    else if (
      coin.change1h >= cfg.minCh1hBuildup &&
      coin.change24 >= cfg.minCh24Buildup &&
      coin.vm >= cfg.minVmBuildup &&
      velocity >= cfg.minVelocity
    ) {
      stage = "BUILDUP";
      eliteType = null;
    } else {
      stage = "RADAR";
      eliteType = null;
    }
  } else {
    // BEAR
    if (
      coin.change1h <= cfg.maxCh1hCascade &&
      coin.change24 <= cfg.maxCh24Cascade &&
      coin.vm >= cfg.minVmElite &&
      Math.abs(obx.score) >= cfg.minObStrongAbs &&
      obx.score <= 0 &&
      velocity >= cfg.explosiveVelocity
    ) {
      stage = "ELITE_CASCADE";
      eliteType = "cascade";
    }
    else if (
      coin.change1h <= cfg.maxCh1hIgnition &&
      coin.change24 <= cfg.maxCh24Ignition &&
      coin.vm >= cfg.minVmElite &&
      Math.abs(obx.score) >= cfg.minObStrongAbs &&
      obx.score <= 0 &&
      velocity >= cfg.strongVelocity
    ) {
      stage = "ELITE_IGNITION";
      eliteType = "ignition";
    }
    else if (
      coin.change1h <= cfg.maxCh1hAlmost &&
      coin.change24 <= cfg.maxCh24Almost &&
      coin.vm >= cfg.minVmAlmost &&
      velocity >= cfg.strongVelocity
    ) {
      stage = "ALMOST";
      eliteType = null;
    }
    else if (
      coin.change1h <= cfg.maxCh1hBuildup &&
      coin.change24 <= cfg.maxCh24Buildup &&
      coin.vm >= cfg.minVmBuildup &&
      velocity >= cfg.minVelocity
    ) {
      stage = "BUILDUP";
      eliteType = null;
    } else {
      stage = "RADAR";
      eliteType = null;
    }
  }

  // Upgrade 1: BTC momentum gate (downgrade elite if BTC not expanding)
  if ((stage === "ELITE_EXPANSION" || stage === "ELITE_IGNITION" || stage === "ELITE_CASCADE") && !btcMomentumOk) {
    stage = "ALMOST";
    eliteType = null;
    return { stage, stageWhy: "btc_not_expanding", moveScore, velocity, compression, eliteType };
  }

  // Upgrade 3: follow-through check (downgrade elite if not enough follow-through)
  if ((stage === "ELITE_EXPANSION" || stage === "ELITE_IGNITION" || stage === "ELITE_CASCADE") && !hasEliteFollowThrough(prev, stage)) {
    stage = "ALMOST";
    eliteType = null;
    return { stage, stageWhy: "elite_needs_followthrough", moveScore, velocity, compression, eliteType };
  }

  return { stage, stageWhy: "ok", moveScore, velocity, compression, eliteType };
}

// ======================================================
// Bouw het universum (coins met OB en stage)
// ======================================================
async function buildUniverse(mode, whaleFlow, btc) {
  const rawCoins = await fetchCoinGeckoTopCached();
  const bitgetSymbols = await getBitgetSpotUsdtSymbols();

  // Basis filter (blocked en Bitget)
  const step1 = rawCoins.filter(c => !isBlockedMoonAsset(c));
  const step2 = step1.filter(c => bitgetSymbols.has(String(c.symbol || "").toUpperCase()));

  console.log("🔍 MOON V2 DEBUG", {
    rawCoins: rawCoins.length,
    afterBlocked: step1.length,
    bitgetSymbols: bitgetSymbols.size,
    afterBitget: step2.length,
    sampleCg: step1.slice(0,10).map(c => c.symbol),
    sampleBitget: Array.from(bitgetSymbols).slice(0,20),
  });

  const filtered = step2.slice(0, 220);
  const out = [];
  const state = (await kv.get(keyMoonState(mode))) || {};

  for (const coin of filtered) {
    const sym = String(coin.symbol || "").toUpperCase();
    const prev = state?.[sym] || {};

    // Orderbook
    let ob = null;
    if (n(coin.volume, 0) >= 600_000) {
      ob = await fetchOrderbook(`${sym}USDT`);
    }
    const obx = computeObScore(ob);
    const tier = getTierForMcap(coin.marketCap);
    const floorUsd = depthFloorUsd(coin.marketCap, tier, prev?.depthHist);
    const depthUsd = n(obx.depthMinUsd1p, 0);
    const depthOk = depthUsd >= floorUsd;

    // Historie
    const priceHist = Array.isArray(prev?.priceHist) ? [...prev.priceHist] : [];
    const volHist = Array.isArray(prev?.volHist) ? [...prev.volHist] : [];
    priceHist.push(n(coin.price, 0));
    volHist.push(n(coin.volume, 0));
    const priceHistNext = priceHist.slice(-120);
    const volHistNext = volHist.slice(-120);

    // Volume acceleratie (kort en medium) – optioneel
    const volAcc = { short: 1, medium: 1 };
    if (volHistNext.length >= 5) {
      const now = volHistNext[volHistNext.length-1];
      const shortAgo = volHistNext[volHistNext.length-1-5] || now;
      const mediumAgo = volHistNext[volHistNext.length-1-20] || now;
      volAcc.short = now / Math.max(shortAgo, 1e-9);
      volAcc.medium = now / Math.max(mediumAgo, 1e-9);
    }

    // ----- Nieuwe stage bepaling (gebruikt MOON_V2 + upgrades) -----
    const stageDecision = decideMoonStageV2({
      mode,
      coin,
      obx,
      priceHist: priceHistNext,
      btc,
      prev,
    });

    const stage = stageDecision.stage;
    const stageWhy = stageDecision.stageWhy;
    const eliteType = stageDecision.eliteType;
    const velocity = stageDecision.velocity;
    const compression = stageDecision.compression;
    const moveScore = stageDecision.moveScore;

    // Probabilities
    const probs = computeMoonProbabilities({
      mode,
      coin: { ...coin, ob: obx },
      moveScore,
      velocity,
      compression,
    });

    // Tradeplan (gebruik moveScore als confidence)
    const tradePlan = buildTradePlan(
      n(coin.price, 0), mode, moveScore, n(coin.range24, 0), depthOk, tier
    );

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
      confidence: moveScore, // moveScore = confidence
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
      volAcc: {
        short: Number(volAcc.short.toFixed(3)),
        medium: Number(volAcc.medium.toFixed(3)),
      },
      moveScore,
      velocity: Number(velocity.toFixed(3)),
      moonProbability: probs.moonProbability,
      dumpProbability: probs.dumpProbability,
      tradePlan: tradePlan ? {
        entry: Number(tradePlan.entry.toFixed(8)),
        sl: Number(tradePlan.sl.toFixed(8)),
        tp: Number(tradePlan.tp.toFixed(8)),
        rr: Number(tradePlan.rr.toFixed(2)),
      } : null,
      _state: {
        priceHist: priceHistNext,
        volHist: volHistNext,
        stageHist: (prev?.stageHist || []).concat([stage]).slice(-12),
      },
    });

    await sleep(40);
  }

  return out;
}

// ======================================================
// MAIN HANDLER (ongewijzigd, behalve dat btc wordt doorgegeven)
// ======================================================
export default async function handler(req, res) {
  let mode = "bull";
  try {
    if (!requireSecret(req, res)) return;
    mode = String(req.query?.mode || "bull").toLowerCase() === "bear" ? "bear" : "bull";

    const now = Date.now();
    const whaleFlow = await fetchExchangeFlows();
    const btc = await fetchBTCGateFromUniverse();

    const universe = await buildUniverse(mode, whaleFlow, btc);
    const funnel = splitFunnels(universe, mode);

    const prevPositions = (await kv.get(keyMoonPositions(mode))) || { open: [], closed: [] };
    const positions = {
      open: Array.isArray(prevPositions?.open) ? [...prevPositions.open] : [],
      closed: Array.isArray(prevPositions?.closed) ? [...prevPositions.closed] : [],
    };

    const prevState = (await kv.get(keyMoonState(mode))) || {};
    const nextState = {};

    const universeMap = new Map();
    for (const c of universe) universeMap.set(c.symbol, c);

    for (const coin of universe) {
      const prev = prevState?.[coin.symbol] || null;
      const prevStage = String(prev?.stage || "");
      const stage = String(coin.stage || "");
      nextState[coin.symbol] = {
        symbol: coin.symbol,
        stage,
        lastSeenAt: now,
        confidence: coin.confidence,
        price: coin.price,
        priceHist: coin?._state?.priceHist || [],
        volHist: coin?._state?.volHist || [],
        stageHist: coin?._state?.stageHist || [],
      };

      if (!prevStage) {
        await pushEvent(stageToScanFunnel(stage, coin.eliteType), {
          symbol: coin.symbol, mode, stage, prevStage: "", price: coin.price,
          confidence: coin.confidence, change24: coin.change24, change1h: coin.change1h,
          ob: coin.ob, tradePlan: coin.tradePlan, btcState: btc.state, reason: "new_in_scan",
        });

        if (stage === "ALMOST" || stage.startsWith("ELITE")) {
          await sendSignal({
            source: "moon",
            stage,
            mode,
            coin,
            btcState: btc.state,
            kind: "signal",
          });
          await sendTelegram(
            `🆕 Nieuwe ${stage}${coin.eliteType ? ' ('+coin.eliteType+')' : ''} moon coin: ${coin.symbol}\nPrijs: $${coin.price}\nConfidence: ${coin.confidence}`
          );
        }
      } else if (prevStage !== stage) {
        await pushEvent("scan_transition", { symbol: coin.symbol, mode, from: prevStage, to: stage, reason: "stage_changed" });

        if (stage === "ALMOST" || stage.startsWith("ELITE")) {
          await sendSignal({
            source: "moon",
            stage,
            mode,
            coin,
            btcState: btc.state,
            kind: "signal",
          });
        }

        if (prevStage === "BUILDUP" && stage === "ALMOST") {
          await sendTelegram(`🚀 BUILDUP → ALMOST: ${coin.symbol}\nPrijs: $${coin.price}\nConfidence: ${coin.confidence}`);
        } else if (prevStage === "ALMOST" && stage.startsWith("ELITE")) {
          await sendTelegram(`🔥 ALMOST → ${stage} (${coin.eliteType}): ${coin.symbol}\nPrijs: $${coin.price}\nConfidence: ${coin.confidence}`);
        }
      }
    }

    // Posities openen vanuit ELITE (beide typen)
    const openMap = new Map(positions.open.map(p => [String(p.symbol || "").toUpperCase(), p]));
    for (const coin of [...funnel.elite_expansion, ...funnel.elite_ignition]) {
      const sym = coin.symbol;
      if (openMap.has(sym)) continue;
      if (!coin.tradePlan) continue;
      const trade = {
        id: uid("moon"),
        symbol: sym,
        mode,
        status: "OPEN",
        stage: coin.stage,
        eliteType: coin.eliteType,
        entryAt: now,
        entryPrice: coin.price,
        lastPrice: coin.price,
        pnlPct: 0,
        pnlUsd: 0,
        barsOpen: 0,
        tp: coin.tradePlan?.tp ?? null,
        sl: coin.tradePlan?.sl ?? null,
        rr: coin.tradePlan?.rr ?? null,
      };
      positions.open.push(trade);
      openMap.set(sym, trade);
      await pushEvent("scan_entry", {
        symbol: sym, mode, stage: "ENTRY", prevStage: coin.stage,
        price: coin.price, confidence: coin.confidence,
        change24: coin.change24, change1h: coin.change1h,
        ob: coin.ob, tradePlan: coin.tradePlan,
        btcState: btc.state, reason: "elite_entry",
      });
    }

    // Posities bijwerken en sluiten
    const survivors = [];
    for (const trade of positions.open) {
      const coin = universeMap.get(trade.symbol);
      if (!coin) {
        const exitPrice = n(trade.lastPrice || trade.entryPrice);
        const pnlPct = calcPnlPct({ mode, entryPrice: trade.entryPrice, priceNow: exitPrice });
        const closed = { ...trade, status: "CLOSED", exitAt: now, exitPrice,
          pnlPct: Number(pnlPct.toFixed(2)), pnlUsd: Number(((50 * pnlPct) / 100).toFixed(2)),
          exitReason: "missing_from_universe" };
        positions.closed.unshift(closed);
        await pushEvent("trade_exit", { symbol: closed.symbol, entryPrice: closed.entryPrice, exitPrice: closed.exitPrice, pnlPct: closed.pnlPct, exitReason: closed.exitReason });
        continue;
      }
      trade.lastPrice = coin.price;
      trade.barsOpen = n(trade.barsOpen) + 1;
      const pnlPct = calcPnlPct({ mode, entryPrice: trade.entryPrice, priceNow: coin.price });
      trade.pnlPct = Number(pnlPct.toFixed(2));
      trade.pnlUsd = Number(((50 * pnlPct) / 100).toFixed(2));
      const hit = hitStopOrTp({ mode, priceNow: coin.price, sl: trade.sl, tp3: trade.tp });
      if (hit.hit) {
        const closed = { ...trade, status: "CLOSED", exitAt: now, exitPrice: coin.price, exitReason: hit.kind };
        positions.closed.unshift(closed);
        await pushEvent(`trade_${hit.kind.toLowerCase()}`, { symbol: closed.symbol, entryPrice: closed.entryPrice, exitPrice: closed.exitPrice, pnlPct: closed.pnlPct, barsOpen: closed.barsOpen });
        await pushEvent("scan_sell", { symbol: coin.symbol, mode, stage: "SELL", prevStage: "HOLD", price: coin.price, confidence: coin.confidence, change24: coin.change24, change1h: coin.change1h, ob: coin.ob, tradePlan: coin.tradePlan, btcState: btc.state, reason: `${hit.kind}_hit` });
        await sendSignal({
          source: "moon",
          stage: "SELL",
          mode,
          coin: {
            ...coin,
            tradePlan: {
              entry: trade.entryPrice,
              sl: trade.sl,
              tp: trade.tp,
              rr: trade.rr,
            },
            pnlPct: closed.pnlPct,
            pnlUsd: closed.pnlUsd,
          },
          btcState: btc.state,
          kind: "portfolio",
        });
        continue;
      }
      await pushEvent("scan_hold", { symbol: coin.symbol, mode, stage: "HOLD", prevStage: coin.stage, price: coin.price, confidence: coin.confidence, change24: coin.change24, change1h: coin.change1h, ob: coin.ob, tradePlan: coin.tradePlan, btcState: btc.state, reason: "position_open" });
      await sendSignal({
        source: "moon",
        stage: "HOLD",
        mode,
        coin: {
          ...coin,
          tradePlan: {
            entry: trade.entryPrice,
            sl: trade.sl,
            tp: trade.tp,
            rr: trade.rr,
          },
          pnlPct: trade.pnlPct,
          pnlUsd: trade.pnlUsd,
        },
        btcState: btc.state,
        kind: "portfolio",
      });
      survivors.push(trade);
    }
    positions.open = survivors;
    positions.closed = positions.closed.slice(0, 1000);

    const portfolio = makePortfolio(mode, positions);

    const latest = {
      ok: true,
      ts: now,
      mode,
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
    return res.end(JSON.stringify({ ok: false, where: "api/moon/scan.js", mode, error: String(e?.message || e) }));
  }
}