import { kv } from "@vercel/kv";

import {
  keyMoonLatest,
  keyMoonPortfolio,
  keyMoonPositions,
  keyMoonState,
  requireSecret,
  tryAcquireMoonScanLock,
  releaseMoonScanLock,
} from "../../lib/_moon_core.js";

import {
  pushEvent,
  uid,
} from "../../lib/_analytics.js";

import { computeInstability } from "../../lib/_moon_run_all.js";

const COINGECKO = "https://api.coingecko.com/api/v3/coins/markets";
const BITGET_OB = "https://api.bitget.com/api/v2/spot/market/orderbook";

export const config = {
  runtime: "nodejs",
  maxDuration: 300,
};

const CG_PER_PAGE = 250;
const CG_PAGES = 3;

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

function liquiditySweep(ob) {
  const bid = n(ob.depthBidUsd);
  const ask = n(ob.depthAskUsd);
  if (!bid || !ask) return 0;
  const imbalance = Math.abs(bid - ask) / Math.max(bid + ask, 1);
  if (imbalance > 0.6) return 1;
  if (imbalance > 0.4) return 0.6;
  return 0;
}

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

async function fetchCoins() {
  const cg = [];
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

  for (let page = 1; page <= CG_PAGES; page++) {
    const url =
      `${COINGECKO}?vs_currency=usd&order=volume_desc` +
      `&per_page=${CG_PER_PAGE}&page=${page}` +
      `&sparkline=false&price_change_percentage=24h,1h`;

    let ok = false;
    let lastErr = "";

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await fetch(url, {
          headers: { accept: "application/json" },
        });

        if (r.ok) {
          const j = await r.json();
          if (Array.isArray(j)) {
            cg.push(...j);
          }
          ok = true;
          break;
        }

        lastErr = `status ${r.status}`;
      } catch (e) {
        lastErr = String(e?.message || e);
      }

      await sleep(1200);
    }

    if (!ok) {
      console.error(`CoinGecko page failed: ${page} (${lastErr})`);
      break;
    }

    await sleep(1200);
  }

  if (!cg.length) {
    throw new Error("CoinGecko returned 0 coins");
  }

  const map = new Map();
  for (const c of cg) {
    const sym = String(c.symbol || "").toUpperCase().trim();
    if (!sym) continue;

    const b = binanceMap.get(sym);

    const high = n(c.high_24h);
    const low = n(c.low_24h);
    const range24 = high > 0 && low > 0 ? ((high - low) / ((high + low) / 2)) * 100 : 0;
    const volume = n(c.total_volume);
    const marketCap = n(c.market_cap);
    const vm = marketCap > 0 ? volume / marketCap : 0;

    map.set(sym, {
      id: c.id,
      symbol: sym,
      name: c.name || "",
      image: c.image || "",
      price: n(c.current_price),
      marketCap,
      volume,
      change24: n(c.price_change_percentage_24h),
      change1h: n(c.price_change_percentage_1h_in_currency),
      range24,
      vm,
      binanceVolume: b?.volume || 0,
      binanceMomentum: b?.priceChange || 0,
    });
  }

  return Array.from(map.values());
}

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

function stageFromScore(score) {
  if (score >= 0.72) return "ELITE";
  if (score >= 0.55) return "ALMOST";
  if (score >= 0.35) return "BUILDUP";
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
  spreadPct,
  whale,
}) {
  let score = 0;

  const vol = n(coin.volume);
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
    return { entry: p, sl, tp, rr };
  }

  const sl = p * (1 + riskPct);
  const tp = p * (1 - rewardPct);
  const rr = rewardPct / riskPct;

  return { entry: p, sl, tp, rr };
}

async function normalizeCoin(raw, mode, ob, whaleFlow = 0) {
  const price = n(raw.price);
  const vm = computeVM(raw);
  const obx = computeObScore(ob);

  const whaleOld = ob ? whalePressure(ob) : 0;
  const confidence = computeConfidence({
    coin: raw,
    mode,
    vm,
    spreadPct: obx.spreadPct,
    whale: whaleOld,
  });

  const volExp = volumeExplosion(raw);
  const momentumAcc = momentumAcceleration(raw);
  const binMomentumVal = binanceMomentum(raw);
  const volSpikeBn = volumeSpikeBinance(raw);
  const whaleNew = ob ? whalePressure2(ob) : 0;
  const vacuum = ob ? liquidityVacuum(ob) : 0;
  const sweep = ob ? liquiditySweep(ob) : 0;

  const rawMoonProbability =
    confidence * 0.26 +
    volExp * 0.16 +
    volSpikeBn * 0.14 +
    Math.max(0, momentumAcc) * 0.12 +
    Math.max(0, binMomentumVal) * 0.08 +
    Math.abs(whaleNew) * 0.04 +
    vacuum * 0.02 +
    sweep * 0.02 +
    (whaleFlow >= 8 ? 0.04 : 0);

  const moonProbability = Math.max(0, Math.min(1, rawMoonProbability));

  const sellP = ob ? sellPressure(ob) : 0;
  const crash = crashMomentum(raw);
  const collapse = ob ? liquidityCollapse(ob) : 0;

  const rawDumpProbability =
    Math.abs(crash) * 0.34 +
    sellP * 0.24 +
    collapse * 0.16 +
    Math.abs(whaleNew < 0 ? whaleNew : 0) * 0.12 +
    Math.abs(binMomentumVal < 0 ? binMomentumVal : 0) * 0.09 +
    sweep * 0.02 +
    (whaleFlow >= 8 ? 0.02 : 0);

  const dumpProbability = Math.max(0, Math.min(1, rawDumpProbability));

  const scoreProbability = mode === "bear" ? dumpProbability : moonProbability;
  const stage = stageFromScore(scoreProbability);

  const instability = computeInstability({
    direction: mode,
    volumeRoc5m: vm * 100,
    obSlope: Math.abs(obx.score),
    obStability: obx.spreadPct / 100,
    depthBidUsd: obx.depthBidUsd,
    depthAskUsd: obx.depthAskUsd,
  });

  const tradePlan = makeTradePlan(price, mode, confidence);

  return {
    id: raw.id,
    symbol: raw.symbol,
    name: raw.name || "",
    image: raw.image || "",
    price,
    marketCap: n(raw.marketCap),
    volume: n(raw.volume),
    change24: n(raw.change24),
    change1h: n(raw.change1h),
    vm,
    confidence: Number(confidence.toFixed(4)),
    stage,
    ob: {
      spreadPct: Number(obx.spreadPct.toFixed(4)),
      depthBidUsd: Math.round(obx.depthBidUsd),
      depthAskUsd: Math.round(obx.depthAskUsd),
      score: Number(obx.score.toFixed(5)),
      depthMinUsd1p: Math.round(Math.min(obx.depthBidUsd, obx.depthAskUsd)),
    },
    instability_score_raw: Number(instability.toFixed(8)),
    edgeScore: Number((confidence * 100).toFixed(1)),
    moonProbability: Number(moonProbability.toFixed(3)),
    dumpProbability: Number(dumpProbability.toFixed(3)),
    scoreProbability: Number(scoreProbability.toFixed(3)),
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
  return ch24 < 0.5;
}

function splitFunnels(coins, mode) {
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

  const sortByModeProb = (a, b) => {
    const aScore = mode === "bear" ? Number(a.dumpProbability || 0) : Number(a.moonProbability || 0);
    const bScore = mode === "bear" ? Number(b.dumpProbability || 0) : Number(b.moonProbability || 0);
    return bScore - aScore;
  };

  funnel.elite.sort(sortByModeProb);
  funnel.almost.sort(sortByModeProb);
  funnel.buildup.sort(sortByModeProb);
  funnel.radar.sort(sortByModeProb);

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

async function buildUniverse(mode, whaleFlow) {
  const rawCoins = await fetchCoins();

  const filtered = rawCoins
    .filter(basicFilter)
    .filter((c) => passModeFilter(c, mode))
    .slice(0, 180);

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

    const normalized = await normalizeCoin(coin, mode, ob, whaleFlow);
    out.push(normalized);

    await sleep(35);
  }

  return out;
}

export default async function handler(req, res) {
  let mode = "bull";
  let lockAcquired = false;

  try {
    if (!requireSecret(req, res)) return;

    mode = String(req.query?.mode || "bull").toLowerCase() === "bear"
      ? "bear"
      : "bull";

    const lock = await tryAcquireMoonScanLock(mode, 600);
    lockAcquired = !!lock?.ok;

    if (!lockAcquired) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      return res.end(
        JSON.stringify({
          ok: true,
          mode,
          skipped: true,
          reason: "scan already running",
        })
      );
    }

    const now = Date.now();
    const whaleFlow = await fetchExchangeFlows();

    const universe = await buildUniverse(mode, whaleFlow);
    const funnel = splitFunnels(universe, mode);

    const btc24h = universe.length
      ? universe.reduce((a, c) => a + Number(c.change24 || 0), 0) / universe.length
      : 0;

    const btcState =
      btc24h >= 1 ? "BULL" :
      btc24h <= -1 ? "BEAR" :
      "NEUTRAL";

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
        await pushEvent(stageToScanFunnel(stage), {
          symbol: coin.symbol,
          mode,
          stage,
          prevStage: "",
          price: coin.price,
          confidence: coin.confidence,
          change24: coin.change24,
          change1h: coin.change1h,
          ob: coin.ob,
          tradePlan: coin.tradePlan,
          btcState,
          reason: "new_in_scan",
        });

        await pushEvent("scan_transition", {
          symbol: coin.symbol,
          mode,
          from: "-",
          to: stage,
          reason: "new_in_scan",
        });

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
          change1h: coin.change1h,
          ob: coin.ob,
          tradePlan: coin.tradePlan,
          btcState,
          reason: "stage_changed",
        });

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
        change1h: coin.change1h,
        ob: coin.ob,
        tradePlan: coin.tradePlan,
        btcState,
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
        (mode === "bull" ? coin.price >= n(trade.tp) : coin.price <= n(trade.tp));

      const hitSl =
        trade.sl != null &&
        (mode === "bull" ? coin.price <= n(trade.sl) : coin.price >= n(trade.sl));

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
          change1h: coin.change1h,
          ob: coin.ob,
          tradePlan: coin.tradePlan,
          btcState,
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
          change1h: coin.change1h,
          ob: coin.ob,
          tradePlan: coin.tradePlan,
          btcState,
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
        change1h: coin.change1h,
        ob: coin.ob,
        tradePlan: coin.tradePlan,
        btcState,
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
        state: btcState,
        chg24: Number(btc24h.toFixed(2)),
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
  } finally {
    if (lockAcquired) {
      await releaseMoonScanLock(mode);
    }
  }
}

function stageToScanFunnel(stage) {
  const s = String(stage || "").toUpperCase();
  if (s === "ELITE") return "scan_entry";
  if (s === "ALMOST") return "scan_almost";
  if (s === "BUILDUP") return "scan_buildup";
  return "scan_radar";
}