import { kv } from "@vercel/kv";

import {
  keyMoonLatest,
  keyMoonPortfolio,
  keyMoonPositions,
  keyMoonState,
  requireSecret,
  fetchCoinGeckoTopCached,          // FIX 2: gebruik dezelfde CoinGecko functie als in core
} from "../../lib/_moon_core.js";

import {
  pushEvent,
  uid,
} from "../../lib/_analytics.js";

import { computeInstability } from "../../lib/_moon_run_all.js";

const BITGET_OB = "https://api.bitget.com/api/v2/spot/market/orderbook";

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Telegram alert helper ---------------------------------------------------
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
// ----------------------------------------------------------------------------

// --- Exchange flows / whale activity (global risk) ---------------------------
async function fetchExchangeFlows() {
  try {
    const r = await fetch("https://api.binance.com/api/v3/ticker/24hr");
    if (!r.ok) return 0;
    const data = await r.json();
    // Tel paren met quoteVolume > 200M USD
    return data.filter((x) => Number(x.quoteVolume) > 200_000_000).length;
  } catch {
    return 0;
  }
}
// ----------------------------------------------------------------------------

// --- Binance universe --------------------------------------------------------
async function fetchBinanceUniverse() {
  const r = await fetch("https://api.binance.com/api/v3/ticker/24hr");
  if (!r.ok) throw new Error("Binance universe failed");
  const data = await r.json();
  return data
    .filter((x) => String(x.symbol).endsWith("USDT"))
    .map((x) => ({
      symbol: x.symbol.replace("USDT", ""),
      volume: Number(x.quoteVolume || 0),
      priceChange: Number(x.priceChangePercent || 0),
    }))
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 800);
}
// ----------------------------------------------------------------------------

// --- Dump signals ------------------------------------------------------------
function sellPressure(ob) {
  const bid = n(ob.depthBidUsd);
  const ask = n(ob.depthAskUsd);
  if (!bid && !ask) return 0;
  const ratio = ask / Math.max(bid, 1);
  if (ratio > 3) return 1;
  if (ratio > 2) return 0.7;
  if (ratio > 1.4) return 0.4;
  return 0;
}

function crashMomentum(coin) {
  const ch = n(coin.change24);
  if (ch < -15) return 1;
  if (ch < -10) return 0.7;
  if (ch < -6) return 0.4;
  return 0;
}

function liquidityCollapse(ob) {
  const bid = n(ob.depthBidUsd);
  if (bid < 20000) return 1;
  if (bid < 50000) return 0.6;
  return 0;
}

// --- Liquidity sweep ---------------------------------------------------------
function liquiditySweep(ob) {
  const bid = n(ob.depthBidUsd);
  const ask = n(ob.depthAskUsd);
  if (!bid || !ask) return 0;
  const imbalance = Math.abs(bid - ask) / Math.max(bid + ask, 1);
  if (imbalance > 0.6) return 1;
  if (imbalance > 0.4) return 0.6;
  return 0;
}
// ----------------------------------------------------------------------------

// --- Binance volume spike ----------------------------------------------------
function volumeSpikeBinance(coin) {
  const vol = n(coin.binanceVolume);
  const cap = n(coin.marketCap);
  if (!cap) return 0;
  const ratio = vol / cap;
  if (ratio > 0.45) return 1;
  if (ratio > 0.30) return 0.7;
  if (ratio > 0.20) return 0.4;
  return 0;
}

// --- fetchCoins met CoinGecko (via core) + Binance data ---------------------
async function fetchCoins() {
  // FIX 2: gebruik de gecachte CoinGecko top van _moon_core
  const cgCoins = await fetchCoinGeckoTopCached();

  let binanceArr = [];
  try {
    binanceArr = await fetchBinanceUniverse();
  } catch (e) {
    console.error("Binance universe fallback:", String(e?.message || e));
    binanceArr = [];
  }

  const binanceMap = new Map();
  for (const b of binanceArr) {
    binanceMap.set(b.symbol, b);
  }

  const result = [];
  for (const c of cgCoins) {
    const sym = String(c.symbol || "").toUpperCase().trim();
    if (!sym) continue;
    const b = binanceMap.get(sym);
    result.push({
      ...c,
      binanceVolume: b?.volume || 0,
      binanceMomentum: b?.priceChange || 0,
    });
  }
  return result;
}

// --- Basis filters -----------------------------------------------------------
function basicFilter(c) {
  const vol = n(c.volume);
  const cap = n(c.marketCap);
  if (vol < 200000) return false;
  if (cap < 800000) return false;
  if (cap > 800000000) return false;
  return true;
}

function computeVM(c) {
  const vol = n(c.volume);
  const cap = n(c.marketCap);
  if (!cap) return 0;
  return vol / cap;
}

// --- Signaalfuncties ---------------------------------------------------------
function computeVolumeSpike(coin) {
  const vol = n(coin.volume);
  const cap = n(coin.marketCap);
  if (!cap) return 0;
  const vm = vol / cap;
  if (vm > 0.35) return 1;
  if (vm > 0.25) return 0.7;
  if (vm > 0.15) return 0.4;
  return 0;
}

function computeMomentum(coin) {
  const ch = n(coin.change24);
  if (ch > 12) return 1;
  if (ch > 8) return 0.7;
  if (ch > 5) return 0.5;
  if (ch < -12) return -1;
  if (ch < -8) return -0.7;
  if (ch < -5) return -0.5;
  return 0;
}

function whalePressure(ob) {
  const bid = n(ob.depthBidUsd);
  const ask = n(ob.depthAskUsd);
  if (!bid && !ask) return 0;
  const total = bid + ask;
  const ratio = (bid - ask) / Math.max(total, 1);
  if (ratio > 0.4) return 1;
  if (ratio > 0.2) return 0.6;
  if (ratio < -0.4) return -1;
  if (ratio < -0.2) return -0.6;
  return 0;
}

function volumeExplosion(coin) {
  const vol = n(coin.volume);
  const cap = n(coin.marketCap);
  if (!cap) return 0;
  const vm = vol / cap;
  if (vm > 0.40) return 1;
  if (vm > 0.30) return 0.8;
  if (vm > 0.20) return 0.6;
  if (vm > 0.12) return 0.4;
  return 0;
}

function momentumAcceleration(coin) {
  const ch = n(coin.change24);
  if (ch > 15) return 1;
  if (ch > 10) return 0.8;
  if (ch > 6) return 0.6;
  if (ch < -15) return -1;
  if (ch < -10) return -0.8;
  if (ch < -6) return -0.6;
  return 0;
}

function liquidityTrap(ob) {
  const bid = n(ob.depthBidUsd);
  const ask = n(ob.depthAskUsd);
  if (!bid || !ask) return 0;
  const ratio = bid / Math.max(ask, 1);
  if (ratio > 2.5) return 1;
  if (ratio > 1.8) return 0.7;
  if (ratio < 0.4) return -1;
  if (ratio < 0.6) return -0.7;
  return 0;
}

function whalePressure2(ob) {
  const bid = n(ob.depthBidUsd);
  const ask = n(ob.depthAskUsd);
  if (!bid && !ask) return 0;
  const ratio = (bid - ask) / Math.max(bid + ask, 1);
  if (ratio > 0.4) return 1;
  if (ratio > 0.25) return 0.7;
  if (ratio < -0.4) return -1;
  if (ratio < -0.25) return -0.7;
  return 0;
}

function binanceMomentum(coin) {
  const m = n(coin.binanceMomentum);
  if (m > 10) return 1;
  if (m > 6) return 0.7;
  if (m > 3) return 0.4;
  if (m < -10) return -1;
  if (m < -6) return -0.7;
  if (m < -3) return -0.4;
  return 0;
}

function liquidityVacuum(ob) {
  const ask = n(ob.depthAskUsd);
  if (ask < 20000) return 1;
  if (ask < 50000) return 0.6;
  return 0;
}
// ----------------------------------------------------------------------------

function stageFromScores(conf) {
  if (conf >= 0.72) return "ELITE";
  if (conf >= 0.55) return "ALMOST";
  if (conf >= 0.35) return "BUILDUP";
  return "RADAR";
}

async function fetchOrderbook(symbol) {
  try {
    const url = `${BITGET_OB}?symbol=${symbol}&type=step0&limit=20`;

    const r = await fetch(url, {
      headers: { accept: "application/json" },
    });

    if (!r.ok) return null;

    const j = await r.json();
    if (String(j?.code || "") !== "00000") return null;

    const bids = j?.data?.bids || [];
    const asks = j?.data?.asks || [];

    if (!bids.length || !asks.length) return null;

    const bestBid = n(bids[0][0]);
    const bestAsk = n(asks[0][0]);
    if (!(bestBid > 0 && bestAsk > 0)) return null;

    const spread = (bestAsk - bestBid) / bestBid;

    const depthBid =
      bids.slice(0, 5).reduce((a, b) => a + n(b[1]) * n(b[0]), 0);

    const depthAsk =
      asks.slice(0, 5).reduce((a, b) => a + n(b[1]) * n(b[0]), 0);

    return {
      spreadPct: spread * 100,
      depthBidUsd: depthBid,
      depthAskUsd: depthAsk,
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
      score: 0,
    };
  }

  const bid = n(ob.depthBidUsd);
  const ask = n(ob.depthAskUsd);
  const total = bid + ask;

  let score = 0;
  if (total > 0) {
    score = (bid - ask) / total;
  }

  return {
    spreadPct: n(ob.spreadPct, 999),
    depthBidUsd: bid,
    depthAskUsd: ask,
    score,
  };
}

function computeConfidence({
  coin,
  mode,
  vm,
  obScore,
  spreadPct,
  whale,
}) {
  let score = 0;

  const ch24 = n(coin.change24);
  const vol = n(coin.volume);
  const cap = n(coin.marketCap);

  const volSpike = computeVolumeSpike(coin);
  const momentum = computeMomentum(coin);

  if (vm >= 0.05) score += 0.12;
  if (vm >= 0.12) score += 0.10;

  if (vol >= 2000000) score += 0.05;

  if (spreadPct <= 0.4) score += 0.08;

  score += volSpike * 0.25;
  score += Math.abs(momentum) * 0.25;
  score += Math.abs(whale) * 0.15;

  if (mode === "bull") {
    if (momentum > 0) score += 0.10;
  } else {
    if (momentum < 0) score += 0.10;
  }

  return Math.max(0, Math.min(1, score));
}

function makeTradePlan(price, mode, confidence) {
  const p = n(price);
  if (!p) return null;

  const conf = n(confidence);

  const riskPct =
    conf >= 0.8 ? 0.035 :
    conf >= 0.65 ? 0.03 :
    0.025;

  const rewardPct =
    conf >= 0.8 ? 0.09 :
    conf >= 0.65 ? 0.07 :
    0.05;

  if (mode === "bull") {
    const sl = p * (1 - riskPct);
    const tp = p * (1 + rewardPct);
    const rr = rewardPct / riskPct;

    return {
      entry: p,
      sl,
      tp,
      rr,
    };
  }

  const sl = p * (1 + riskPct);
  const tp = p * (1 - rewardPct);
  const rr = rewardPct / riskPct;

  return {
    entry: p,
    sl,
    tp,
    rr,
  };
}

// --- normalizeCoin (zonder 5m momentum) -------------------------------------
async function normalizeCoin(raw, mode, ob) {
  const price = n(raw.price);
  const vm = computeVM(raw);
  const obx = computeObScore(ob);

  const whaleOld = ob ? whalePressure(ob) : 0;
  const confidence = computeConfidence({
    coin: raw,
    mode,
    vm,
    obScore: obx.score,
    spreadPct: obx.spreadPct,
    whale: whaleOld,
  });

  const stage = stageFromScores(confidence);

  const instability = computeInstability({
    direction: mode,
    volumeRoc5m: vm * 100,
    obSlope: Math.abs(obx.score),
    obStability: obx.spreadPct / 100,
    depthBidUsd: obx.depthBidUsd,
    depthAskUsd: obx.depthAskUsd,
  });

  const tradePlan = makeTradePlan(price, mode, confidence);

  // Bestaande signalen
  const volExp = volumeExplosion(raw);
  const momentumAcc = momentumAcceleration(raw);
  const trap = ob ? liquidityTrap(ob) : 0;
  const whaleNew = ob ? whalePressure2(ob) : 0;
  const binMomentum = binanceMomentum(raw);
  const vacuum = ob ? liquidityVacuum(ob) : 0;

  // FIX 4: 5-min momentum verwijderd
  const volSpikeBn = volumeSpikeBinance(raw);

  // Dump signalen
  const sellP = ob ? sellPressure(ob) : 0;
  const crash = crashMomentum(raw);
  const collapse = ob ? liquidityCollapse(ob) : 0;

  // Liquidity sweep
  const sweep = ob ? liquiditySweep(ob) : 0;

  // Pump probability (zonder shortMomentum)
  const rawMoonProbability =
    confidence * 0.28 +
    volExp * 0.18 +
    volSpikeBn * 0.16 +
    Math.max(0, momentumAcc) * 0.12 +
    // shortMomentum weg
    Math.max(0, binMomentum) * 0.08 +
    Math.abs(whaleNew) * 0.04 +
    vacuum * 0.02 +
    sweep * 0.02;

  const moonProbability = Math.max(0, Math.min(1, rawMoonProbability));

  // Dump probability
  const rawDumpProbability =
    Math.abs(crash) * 0.30 +
    sellP * 0.25 +
    collapse * 0.20 +
    Math.abs(whaleNew) * 0.15 +
    Math.abs(binMomentum < 0 ? binMomentum : 0) * 0.10 +
    sweep * 0.05;

  const dumpProbability = Math.max(0, Math.min(1, rawDumpProbability));

  return {
    id: raw.id,
    symbol: String(raw.symbol || "").toUpperCase(),
    name: raw.name || "",
    image: raw.image || "",
    price,
    marketCap: n(raw.marketCap),
    volume: n(raw.volume),
    change24: n(raw.change24),
    vm,
    confidence: Number(confidence.toFixed(4)),
    stage,
    ob: {
      spreadPct: Number(obx.spreadPct.toFixed(4)),
      depthBidUsd: Math.round(obx.depthBidUsd),
      depthAskUsd: Math.round(obx.depthAskUsd),
      score: Number(obx.score.toFixed(5)),
      depthMinUsd1p: Math.round(
        Math.min(obx.depthBidUsd, obx.depthAskUsd)
      ),
    },
    instability_score_raw: Number(instability.toFixed(8)),
    edgeScore: Number((confidence * 100).toFixed(1)),
    moonProbability: Number(moonProbability.toFixed(3)),
    dumpProbability: Number(dumpProbability.toFixed(3)),
    tradePlan: tradePlan
      ? {
          entry: Number(tradePlan.entry.toFixed(8)),
          sl: Number(tradePlan.sl.toFixed(8)),
          tp: Number(tradePlan.tp.toFixed(8)),
          rr: Number(tradePlan.rr.toFixed(2)),
        }
      : null,
  };
}

function passModeFilter(c, mode) {
  const ch24 = n(c.change24);
  if (mode === "bull") return ch24 > -2;
  return ch24 < 2;
}

// --- splitFunnels -----------------------------------------------------------
function splitFunnels(coins) {
  const funnel = {
    elite: [],
    almost: [],
    buildup: [],
    radar: [],
  };

  for (const c of coins) {
    if (c.stage === "ELITE") funnel.elite.push(c);
    else if (c.stage === "ALMOST") funnel.almost.push(c);
    else if (c.stage === "BUILDUP") funnel.buildup.push(c);
    else funnel.radar.push(c);
  }

  const sortByMaxProb = (a, b) => {
    const aMax = Math.max(a.moonProbability, a.dumpProbability);
    const bMax = Math.max(b.moonProbability, b.dumpProbability);
    return bMax - aMax;
  };

  funnel.elite.sort(sortByMaxProb);
  funnel.almost.sort(sortByMaxProb);
  funnel.buildup.sort(sortByMaxProb);
  funnel.radar.sort(sortByMaxProb);

  funnel.radar = funnel.radar.slice(0, 200);
  funnel.buildup = funnel.buildup.slice(0, 80);
  funnel.almost = funnel.almost.slice(0, 30);
  funnel.elite = funnel.elite.slice(0, 10);

  return funnel;
}

function makePortfolio(mode, positions) {
  const open = Array.isArray(positions?.open) ? positions.open : [];
  const closed = Array.isArray(positions?.closed) ? positions.closed : [];

  let realizedUsd = 0;
  let avgRealizedPct = 0;

  if (closed.length) {
    realizedUsd = closed.reduce((a, b) => a + n(b.pnlUsd), 0);
    avgRealizedPct =
      closed.reduce((a, b) => a + n(b.pnlPct), 0) / closed.length;
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

async function buildUniverse(mode) {
  const rawCoins = await fetchCoins();

  // FIX 3: verlaagd naar 200 i.p.v. 250
  const filtered = rawCoins
    .filter(basicFilter)
    .filter((c) => passModeFilter(c, mode))
    .slice(0, 200);

  const out = [];

  for (const coin of filtered) {
    let ob = null;
    if (coin.volume > 8000000) {
      const symbol = `${String(coin.symbol || "").toUpperCase()}USDT`;
      ob = await fetchOrderbook(symbol);
    }

    if (!ob) {
      ob = {
        spreadPct: 0.6,
        depthBidUsd: 0,
        depthAskUsd: 0,
      };
    }

    const normalized = await normalizeCoin(coin, mode, ob);
    out.push(normalized);

    // FIX 6: verwijder de oude alerts op moon/dump probability
    // (hier komen later alerts op stage change, in de hoofdhandler)
    await sleep(30);
  }

  return out;
}

export default async function handler(req, res) {
  let mode = "bull";

  try {
    if (!requireSecret(req, res)) return;

    mode = String(req.query?.mode || "bull").toLowerCase() === "bear"
      ? "bear"
      : "bull";

    const now = Date.now();

    const whaleFlow = await fetchExchangeFlows();

    const universe = await buildUniverse(mode);
    const funnel = splitFunnels(universe);

    const universeMap = new Map();
    for (const c of universe) {
      universeMap.set(c.symbol, c);
    }

    const prevPositions = (await kv.get(keyMoonPositions(mode))) || {
      open: [],
      closed: [],
    };

    const positions = {
      open: Array.isArray(prevPositions?.open) ? [...prevPositions.open] : [],
      closed: Array.isArray(prevPositions?.closed) ? [...prevPositions.closed] : [],
    };

    const prevState = (await kv.get(keyMoonState(mode))) || {};
    const nextState = {};

    // FIX 6: alerts bij stage change
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
      };

      if (!prevStage) {
        // Nieuw in scan
        await pushEvent(stageToScanFunnel(stage), {
          symbol: coin.symbol,
          mode,
          stage,
          prevStage: "",
          price: coin.price,
          confidence: coin.confidence,
          change24: coin.change24,
          ob: coin.ob,
          tradePlan: coin.tradePlan,
          btcState: "NEUTRAL",
          reason: "new_in_scan",
        });

        await pushEvent("scan_transition", {
          symbol: coin.symbol,
          mode,
          from: "-",
          to: stage,
          reason: "new_in_scan",
        });

        // Alleen Telegram bij ALMOST of ELITE bij eerste verschijning (optioneel)
        if (stage === "ALMOST" || stage === "ELITE") {
          await sendTelegram(
            `🆕 Nieuwe ${stage} munt: ${coin.symbol}\nPrijs: $${coin.price}\nConfidence: ${coin.confidence}`
          );
        }
      } else if (prevStage !== stage) {
        await pushEvent("scan_transition", {
          symbol: coin.symbol,
          mode,
          from: prevStage,
          to: stage,
          reason: "stage_changed",
        });

        await pushEvent(stageToScanFunnel(stage), {
          symbol: coin.symbol,
          mode,
          stage,
          prevStage,
          price: coin.price,
          confidence: coin.confidence,
          change24: coin.change24,
          ob: coin.ob,
          tradePlan: coin.tradePlan,
          btcState: "NEUTRAL",
          reason: "stage_changed",
        });

        // FIX 6: Telegram alerts bij specifieke overgangen
        if (prevStage === "BUILDUP" && stage === "ALMOST") {
          await sendTelegram(
            `🚀 BUILDUP → ALMOST: ${coin.symbol}\nPrijs: $${coin.price}\nConfidence: ${coin.confidence}`
          );
        } else if (prevStage === "ALMOST" && stage === "ELITE") {
          await sendTelegram(
            `🔥 ALMOST → ELITE: ${coin.symbol}\nPrijs: $${coin.price}\nConfidence: ${coin.confidence}`
          );
        }
      }
    }

    const openMap = new Map(
      positions.open.map((p) => [String(p.symbol || "").toUpperCase(), p])
    );

    for (const coin of funnel.elite) {
      const sym = coin.symbol;
      if (openMap.has(sym)) continue;

      const trade = {
        id: uid("moon"),
        symbol: sym,
        mode,
        status: "OPEN",
        stage: "ELITE",
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
        symbol: sym,
        mode,
        stage: "ENTRY",
        prevStage: "ELITE",
        price: coin.price,
        confidence: coin.confidence,
        change24: coin.change24,
        ob: coin.ob,
        tradePlan: coin.tradePlan,
        btcState: "NEUTRAL",
        reason: "elite_entry",
      });
    }

    const survivors = [];
    for (const trade of positions.open) {
      const coin = universeMap.get(trade.symbol);

      if (!coin) {
        const exitPrice = n(trade.lastPrice || trade.entryPrice);
        const pnlPct =
          mode === "bull"
            ? ((exitPrice - n(trade.entryPrice)) / Math.max(n(trade.entryPrice), 1e-12)) * 100
            : ((n(trade.entryPrice) - exitPrice) / Math.max(n(trade.entryPrice), 1e-12)) * 100;

        const closed = {
          ...trade,
          status: "CLOSED",
          exitAt: now,
          exitPrice,
          pnlPct: Number(pnlPct.toFixed(2)),
          pnlUsd: Number(((50 * pnlPct) / 100).toFixed(2)),
          exitReason: "missing_from_universe",
        };

        positions.closed.unshift(closed);

        await pushEvent("trade_exit", {
          symbol: closed.symbol,
          entryPrice: closed.entryPrice,
          exitPrice: closed.exitPrice,
          pnlPct: closed.pnlPct,
          exitReason: closed.exitReason,
        });

        continue;
      }

      trade.lastPrice = coin.price;
      trade.barsOpen = n(trade.barsOpen) + 1;

      const pnlPct =
        mode === "bull"
          ? ((coin.price - n(trade.entryPrice)) / Math.max(n(trade.entryPrice), 1e-12)) * 100
          : ((n(trade.entryPrice) - coin.price) / Math.max(n(trade.entryPrice), 1e-12)) * 100;

      trade.pnlPct = Number(pnlPct.toFixed(2));
      trade.pnlUsd = Number(((50 * pnlPct) / 100).toFixed(2));

      const hitTp =
        trade.tp != null &&
        (
          mode === "bull"
            ? coin.price >= n(trade.tp)
            : coin.price <= n(trade.tp)
        );

      const hitSl =
        trade.sl != null &&
        (
          mode === "bull"
            ? coin.price <= n(trade.sl)
            : coin.price >= n(trade.sl)
        );

      if (hitTp) {
        const closed = {
          ...trade,
          status: "CLOSED",
          exitAt: now,
          exitPrice: coin.price,
          exitReason: "TP",
        };

        positions.closed.unshift(closed);

        await pushEvent("trade_tp", {
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
          confidence: coin.confidence,
          change24: coin.change24,
          ob: coin.ob,
          tradePlan: coin.tradePlan,
          btcState: "NEUTRAL",
          reason: "take_profit_hit",
        });

        continue;
      }

      if (hitSl) {
        const closed = {
          ...trade,
          status: "CLOSED",
          exitAt: now,
          exitPrice: coin.price,
          exitReason: "SL",
        };

        positions.closed.unshift(closed);

        await pushEvent("trade_sl", {
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
          confidence: coin.confidence,
          change24: coin.change24,
          ob: coin.ob,
          tradePlan: coin.tradePlan,
          btcState: "NEUTRAL",
          reason: "stop_loss_hit",
        });

        continue;
      }

      await pushEvent("scan_hold", {
        symbol: coin.symbol,
        mode,
        stage: "HOLD",
        prevStage: coin.stage,
        price: coin.price,
        confidence: coin.confidence,
        change24: coin.change24,
        ob: coin.ob,
        tradePlan: coin.tradePlan,
        btcState: "NEUTRAL",
        reason: "position_open",
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
        state: "NEUTRAL",
        chg24: 0,
      },
      counts: {
        elite: funnel.elite.length,
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
    return res.end(
      JSON.stringify({
        ok: false,
        where: "api/moon/scan.js",
        mode,
        error: String(e?.message || e),
      })
    );
  }
}

function stageToScanFunnel(stage) {
  const s = String(stage || "").toUpperCase();
  if (s === "ELITE") return "scan_entry";
  if (s === "ALMOST") return "scan_almost";
  if (s === "BUILDUP") return "scan_buildup";
  return "scan_radar";
}