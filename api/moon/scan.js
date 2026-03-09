import { kv } from "@vercel/kv";

import {
  keyMoonLatest,
  keyMoonPortfolio,
  keyMoonPositions,
  keyMoonState,
  requireSecret,
} from "../../lib/_moon_core.js";

import {
  pushEvent,
  uid,
} from "../../lib/_analytics.js";

import { computeInstability } from "../../lib/_moon_run_all.js";

const COINGECKO =
  "https://api.coingecko.com/api/v3/coins/markets";

const BITGET_OB =
  "https://api.bitget.com/api/v2/spot/market/orderbook";

const CG_PER_PAGE = 250;
const CG_PAGES = 4;

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchCoins() {
  const all = [];

  for (let page = 1; page <= CG_PAGES; page++) {
    const url =
      `${COINGECKO}?vs_currency=usd&order=volume_desc` +
      `&per_page=${CG_PER_PAGE}&page=${page}` +
      `&sparkline=false&price_change_percentage=24h`;

    const r = await fetch(url, {
      headers: { accept: "application/json" },
    });

    if (!r.ok) {
      throw new Error(`CoinGecko fetch failed on page ${page}`);
    }

    const j = await r.json();
    if (Array.isArray(j)) {
      all.push(...j);
    }

    await sleep(300);
  }

  return all;
}

function basicFilter(c) {
  const vol = n(c.total_volume);
  const cap = n(c.market_cap);

  if (vol < 200000) return false;
  if (cap < 800000) return false;

  return true;
}

function computeVM(c) {
  const vol = n(c.total_volume);
  const cap = n(c.market_cap);

  if (!cap) return 0;

  return vol / cap;
}

// --- Nieuwe detectiefuncties -------------------------------------------------

function computeVolumeSpike(coin) {
  const vol = n(coin.total_volume);
  const cap = n(coin.market_cap);
  if (!cap) return 0;

  const vm = vol / cap;

  if (vm > 0.35) return 1;
  if (vm > 0.25) return 0.7;
  if (vm > 0.15) return 0.4;
  return 0;
}

function computeMomentum(coin) {
  const ch = n(coin.price_change_percentage_24h);

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

// --- Verbeterde confidence met spike/momentum/whale -------------------------
function computeConfidence({
  coin,
  mode,
  vm,
  obScore,
  spreadPct,
  whale,            // nieuwe parameter
}) {
  let score = 0;

  const ch24 = n(coin.price_change_percentage_24h);
  const vol = n(coin.total_volume);
  const cap = n(coin.market_cap);

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
// ----------------------------------------------------------------------------

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

function normalizeCoin(raw, mode, ob) {
  const price = n(raw.current_price);
  const vm = computeVM(raw);
  const obx = computeObScore(ob);

  // Nieuwe signalen
  const whale = ob ? whalePressure(ob) : 0;

  const confidence = computeConfidence({
    coin: raw,
    mode,
    vm,
    obScore: obx.score,
    spreadPct: obx.spreadPct,
    whale,
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

  // MoonScore = combinatie van confidence, volume spike en momentum
  const moonScore =
    confidence * 0.5 +
    computeVolumeSpike(raw) * 0.3 +
    Math.abs(computeMomentum(raw)) * 0.2;

  return {
    id: raw.id,
    symbol: String(raw.symbol || "").toUpperCase(),
    name: raw.name || "",
    image: raw.image || "",
    price,
    marketCap: n(raw.market_cap),
    volume: n(raw.total_volume),
    change24: n(raw.price_change_percentage_24h),
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
    moonScore: Number(moonScore.toFixed(3)),          // nieuw veld
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
  const ch24 = n(c.price_change_percentage_24h);

  if (mode === "bull") {
    return ch24 > -2;
  }

  return ch24 < 2;
}

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

  // Sorteer op moonScore (hoogste eerst)
  funnel.elite.sort((a, b) => b.moonScore - a.moonScore);
  funnel.almost.sort((a, b) => b.moonScore - a.moonScore);
  funnel.buildup.sort((a, b) => b.moonScore - a.moonScore);
  funnel.radar.sort((a, b) => b.moonScore - a.moonScore);

  // Beperk de grootte van de funnels
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

  const filtered = rawCoins
    .filter(basicFilter)
    .filter((c) => passModeFilter(c, mode))
    .slice(0, 600);

  const out = [];

  for (const coin of filtered) {
    let ob = null;
    if (coin.total_volume > 1000000) {
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

    const normalized = normalizeCoin(coin, mode, ob);
    out.push(normalized);

    await sleep(80);
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

    const universe = await buildUniverse(mode);
    const funnel = splitFunnels(universe);

    const prevPositions = (await kv.get(keyMoonPositions(mode))) || {
      open: [],
      closed: [],
    };

    const positions = {
      open: Array.isArray(prevPositions?.open) ? [...prevPositions.open] : [],
      closed: Array.isArray(prevPositions?.closed) ? [...prevPositions.closed] : [],
    };

    const eliteSymbols = new Set(funnel.elite.map((x) => x.symbol));
    const almostSymbols = new Set(funnel.almost.map((x) => x.symbol));
    const buildupSymbols = new Set(funnel.buildup.map((x) => x.symbol));
    const radarSymbols = new Set(funnel.radar.map((x) => x.symbol));

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
      const coin = universe.find((c) => c.symbol === trade.symbol);

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
    };

    await kv.set(keyMoonLatest(mode), latest, { ex: 60 * 60 });
    await kv.set(keyMoonState(mode), nextState, { ex: 60 * 60 * 24 });
    await kv.set(keyMoonPortfolio(mode), portfolio, { ex: 60 * 60 * 24 });
    await kv.set(keyMoonPositions(mode), positions, { ex: 60 * 60 * 24 });

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(latest));
  } catch (e) {
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