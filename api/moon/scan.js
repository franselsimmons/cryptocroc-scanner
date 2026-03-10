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
  computeConfidence,
  passRadarMoon,
  passBuildupMoon,
  passAlmostMoon,
  passEliteMoon,
  computeMoonRisk,
  calcPnlPct,
  hitStopOrTp,
  isBlockedMoonAsset,
} from "../../lib/_moon_core.js";

import {
  pushEvent,
  uid,
} from "../../lib/_analytics.js";

import { computeInstability } from "../../lib/_moon_run_all.js";

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

function stageToScanFunnel(stage) {
  const s = String(stage || "").toUpperCase();
  if (s === "ELITE") return "scan_entry";
  if (s === "ALMOST") return "scan_almost";
  if (s === "BUILDUP") return "scan_buildup";
  return "scan_radar";
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

    const bestBid = n(bids[0]?.[0]);
    const bestAsk = n(asks[0]?.[0]);
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

function consistencyFromHistory(hist, currentStage, need = 2, minAgree = 1) {
  const arr = Array.isArray(hist) ? hist : [];
  const cur = String(currentStage || "").toUpperCase();
  const tail = arr.concat([cur]).slice(-Math.max(need, 6));
  const same = tail.filter((x) => String(x || "").toUpperCase() === cur).length;
  const total = tail.length;
  const ratio = total > 0 ? same / total : 0;
  return {
    ok: total >= need && same >= minAgree,
    ratio,
    same,
    total,
    need,
    minAgree,
    hist: tail,
  };
}

function buildTradePlan(price, mode, confidence, range24, depthOk, tier) {
  const risk = computeMoonRisk({
    mode,
    price,
    range24,
    confidence,
    depthOk,
    tier,
  });

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
    const aScore =
      mode === "bear"
        ? n(a?.dumpProbability, 0)
        : n(a?.moonProbability, 0);
    const bScore =
      mode === "bear"
        ? n(b?.dumpProbability, 0)
        : n(b?.moonProbability, 0);

    return (
      bScore - aScore ||
      n(b?.confidence, 0) - n(a?.confidence, 0) ||
      n(b?.vm, 0) - n(a?.vm, 0) ||
      n(b?.volume, 0) - n(a?.volume, 0)
    );
  };
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

  const sorter = sortByStageScore(mode);

  funnel.elite.sort(sorter);
  funnel.almost.sort(sorter);
  funnel.buildup.sort(sorter);
  funnel.radar.sort(sorter);

  funnel.radar = funnel.radar.slice(0, 160);
  funnel.buildup = funnel.buildup.slice(0, 70);
  funnel.almost = funnel.almost.slice(0, 24);
  funnel.elite = funnel.elite.slice(0, 8);

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

async function buildUniverse(mode, whaleFlow, btc) {
  const rawCoins = await fetchCoinGeckoTopCached();
  const bitgetSymbols = await getBitgetSpotUsdtSymbols();

  // ---- DEBUG STAPPEN ----
  const step1 = rawCoins.filter((c) => !isBlockedMoonAsset(c));
  const step2 = step1.filter((c) =>
    bitgetSymbols.has(String(c.symbol || "").toUpperCase())
  );
  const step3 = step2.filter((c) => passRadarMoon(c, mode, btc));

  console.log("🔍 MOON DEBUG", {
    rawCoins: rawCoins.length,
    afterBlocked: step1.length,
    bitgetSymbols: bitgetSymbols.size,
    afterBitget: step2.length,
    afterRadar: step3.length,
    sampleCg: step1.slice(0, 10).map((c) => c.symbol),
    sampleBitget: Array.from(bitgetSymbols).slice(0, 20),
  });

  // Gebruik step3 voor de verdere verwerking
  const filtered = step3.slice(0, 220);

  // OPTIONEEL: als je de Bitget-filter tijdelijk wilt uitschakelen,
  // vervang dan filtered door:
  // const filtered = step1.filter((c) => passRadarMoon(c, mode, btc)).slice(0, 220);
  // (en comment de bovenstaande filtered-regel)

  const out = [];
  const state = (await kv.get(keyMoonState(mode))) || {};

  for (const coin of filtered) {
    const sym = String(coin.symbol || "").toUpperCase();
    const prev = state?.[sym] || {};

    let ob = null;
    if (n(coin.volume, 0) >= 600_000) {
      ob = await fetchOrderbook(`${sym}USDT`);
    }

    const obx = computeObScore(ob);
    const tier = getTierForMcap(coin.marketCap);
    const floorUsd = depthFloorUsd(coin.marketCap, tier);
    const depthUsd = n(obx.depthMinUsd1p, 0);

    const priceHist = Array.isArray(prev?.priceHist) ? [...prev.priceHist] : [];
    const volHist = Array.isArray(prev?.volHist) ? [...prev.volHist] : [];

    priceHist.push(n(coin.price, 0));
    volHist.push(n(coin.volume, 0));

    const priceHistNext = priceHist.slice(-120);
    const volHistNext = volHist.slice(-120);

    const volAcc =
      volHistNext.length >= 2 && n(volHistNext[0], 0) > 0
        ? n(volHistNext[volHistNext.length - 1], 0) / Math.max(n(volHistNext[0], 0), 1e-9)
        : 1;

    const prevHist = Array.isArray(prev?.stageHist) ? prev.stageHist : [];
    const consistencyPreview = consistencyFromHistory(
      prevHist,
      "BUILDUP",
      2,
      1
    );

    const confidence = computeConfidence({
      obScore: obx.score,
      obAgree: consistencyPreview.ratio,
      vm: coin.vm,
      volAcc,
      btc,
      change24: coin.change24,
      range24: coin.range24,
    });

    const buildupRes = passBuildupMoon({
      c: coin,
      volAcc,
      confidence,
    });

    let stage = "RADAR";
    let stageWhy = "radar_passed";

    if (buildupRes.ok) {
      stage = "BUILDUP";
      stageWhy = "buildup_passed";
    }

    const consistencyBuildup = consistencyFromHistory(prevHist, stage, 2, 1);

    const almostRes =
      stage === "BUILDUP"
        ? passAlmostMoon({
            priceHist: priceHistNext,
            volAcc,
            confidence,
            consistencyRatio: consistencyBuildup.ratio,
            c: coin,
          })
        : { ok: false, why: "not_in_buildup" };

    if (almostRes.ok) {
      stage = "ALMOST";
      stageWhy = "almost_passed";
    }

    const consistencyAlmost = consistencyFromHistory(prevHist, stage, 2, 1);

    const eliteRes =
      stage === "ALMOST"
        ? passEliteMoon({
            mode,
            obView: obx,
            confidence,
            consistencyRatio: consistencyAlmost.ratio,
            depthUsd,
            floorUsd,
            range24: coin.range24,
            tier,
          })
        : { ok: false, why: "not_in_almost" };

    if (eliteRes.ok) {
      stage = "ELITE";
      stageWhy = "elite_passed";
    }

    const finalConsistency = consistencyFromHistory(prevHist, stage, 2, 1);

    const tradePlan = buildTradePlan(
      n(coin.price, 0),
      mode,
      confidence,
      n(coin.range24, 0),
      depthUsd >= floorUsd,
      tier
    );

    const instability = computeInstability({
      direction: mode,
      volumeRoc5m: coin.vm * 100,
      obSlope: Math.abs(obx.score),
      obStability: obx.spreadPct / 100,
      depthBidUsd: obx.depthBidUsd,
      depthAskUsd: obx.depthAskUsd,
    });

    const moonProbabilityRaw =
      confidence / 100 * 0.45 +
      Math.min(coin.vm / 1.5, 1) * 0.18 +
      Math.min(Math.abs(coin.change24) / 20, 1) * 0.14 +
      Math.min(Math.abs(obx.score) / 0.10, 1) * 0.13 +
      Math.min(depthUsd / Math.max(floorUsd, 1), 1.2) * 0.10;

    const dumpProbabilityRaw =
      Math.max(0, -coin.change24) / 20 * 0.30 +
      Math.max(0, -obx.score) / 0.10 * 0.20 +
      (depthUsd < floorUsd ? 0.22 : 0) +
      Math.min(Math.abs(instability) / 100, 1) * 0.18 +
      (btc?.state === "BEAR" ? 0.10 : 0);

    const moonProbability = Math.max(0, Math.min(1, moonProbabilityRaw));
    const dumpProbability = Math.max(0, Math.min(1, dumpProbabilityRaw));
    const scoreProbability = mode === "bear" ? dumpProbability : moonProbability;

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
      confidence: Number(confidence.toFixed(2)),
      stage,
      stageWhy,
      tier: tier?.name || "unknown",
      consistency: {
        ok: finalConsistency.ok,
        ratio: Number(finalConsistency.ratio.toFixed(3)),
        same: finalConsistency.same,
        total: finalConsistency.total,
        need: finalConsistency.need,
        minAgree: finalConsistency.minAgree,
      },
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
        depthOk: depthUsd >= floorUsd,
      },
      instability_score_raw: Number(instability.toFixed(8)),
      edgeScore: Number(confidence.toFixed(1)),
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
      _state: {
        priceHist: priceHistNext,
        volHist: volHistNext,
        stageHist: prevHist.concat([stage]).slice(-12),
      },
    });

    await sleep(40);
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
    const btc = await fetchBTCGateFromUniverse();

    const universe = await buildUniverse(mode, whaleFlow, btc);
    const funnel = splitFunnels(universe, mode);

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
          btcState: btc.state,
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
            `🆕 Nieuwe ${stage} moon coin: ${coin.symbol}\nPrijs: $${coin.price}\nConfidence: ${coin.confidence}`
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
          btcState: btc.state,
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
      if (!coin.tradePlan) continue;

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
        btcState: btc.state,
        reason: "elite_entry",
      });
    }

    const survivors = [];
    for (const trade of positions.open) {
      const coin = universeMap.get(trade.symbol);

      if (!coin) {
        const exitPrice = n(trade.lastPrice || trade.entryPrice);
        const pnlPct = calcPnlPct({
          mode,
          entryPrice: trade.entryPrice,
          priceNow: exitPrice,
        });

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

      const pnlPct = calcPnlPct({
        mode,
        entryPrice: trade.entryPrice,
        priceNow: coin.price,
      });

      trade.pnlPct = Number(pnlPct.toFixed(2));
      trade.pnlUsd = Number(((50 * pnlPct) / 100).toFixed(2));

      const hit = hitStopOrTp({
        mode,
        priceNow: coin.price,
        sl: trade.sl,
        tp3: trade.tp,
      });

      if (hit.hit && hit.kind === "TP") {
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
          btcState: btc.state,
          reason: "take_profit_hit",
        });

        continue;
      }

      if (hit.hit && hit.kind === "SL") {
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
          btcState: btc.state,
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
        btcState: btc.state,
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
        state: btc.state,
        chg24: Number(n(btc.chg24, 0).toFixed(2)),
        chg1h: Number(n(btc.chg1h, 0).toFixed(2)),
        range24: Number(n(btc.range24, 0).toFixed(2)),
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