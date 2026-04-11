// api/scan.js
import { kv } from "@vercel/kv";
import { fetchBTCGateFromUniverse, fetchCoinGeckoTopCached } from "../lib/_moon_core.js";
import { generateShallowOb, calculateFuturesSize, preScoreMainCoin } from "../lib/_scanner_helpers.js";

import MOON_CORE_BULL from "../lib/_moon_core_bull.js";
import MOON_CORE_BEAR from "../lib/_moon_core_bear.js";
import MAIN_CORE_BULL from "../lib/_core_bull.js";
import MAIN_CORE_BEAR from "../lib/_core_bear.js";

const BITGET_FUTURES_TICKERS = "https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES";
const BITGET_FUTURES_CONTRACTS = "https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES";

export default async function scannerHandler(req, res) {
  const mode = req.query?.mode || "bull";
  const now = Date.now();

  try {
    const MOON_CORE = mode === "bull" ? MOON_CORE_BULL : MOON_CORE_BEAR;
    const MAIN_CORE = mode === "bull" ? MAIN_CORE_BULL : MAIN_CORE_BEAR;

    const btc = await fetchBTCGateFromUniverse();
    const cg = await fetchCoinGeckoTopCached(300);

    const [tickersRes, contractsRes] = await Promise.all([
      fetch(BITGET_FUTURES_TICKERS).then(r => r.json()),
      fetch(BITGET_FUTURES_CONTRACTS).then(r => r.json())
    ]);

    const validFutures = new Map((tickersRes?.data || []).map(t => [t.symbol, t]));
    const contractConfigs = new Map((contractsRes?.data || []).map(c => [c.symbol, c]));

    const tradable = (cg?.coins || []).filter(c =>
      validFutures.has(`${c.symbol.toUpperCase()}USDT`)
    );

    const funnelQueue = [];
    const eventQueue = [];

    for (const coin of tradable) {
      const sym = coin.symbol.toUpperCase();
      const symbolUsdt = `${sym}USDT`;

      const ticker = validFutures.get(symbolUsdt);
      const config = contractConfigs.get(symbolUsdt);

      if (!ticker || !config) continue;

      const shallowObx = generateShallowOb(ticker);

      // HARD FILTER (V4 stricter)
      if (!shallowObx || shallowObx.spreadPct > 2.5) continue;

      // =========================
      // 🔵 MAIN SYSTEM (V4 IMPROVED)
      // =========================
      const mainScore = preScoreMainCoin(coin, mode, MAIN_CORE);

      if (mainScore.stage === "ENTRY_READY" || mainScore.stage === "SETUP") {
        const tradePlan = {
          entry: coin.price,
          sl: coin.price * (mode === "bull" ? 0.97 : 1.03),
          tp: coin.price * (mode === "bull" ? 1.06 : 0.94)
        };

        tradePlan.size = calculateFuturesSize(
          tradePlan.entry,
          tradePlan.sl,
          50,
          config
        );

        funnelQueue.push({
          symbol: sym,
          side: mode === "bull" ? "LONG" : "SHORT",
          sourceSystem: "main",
          sourceMode: mode,
          stage: mainScore.stage,
          confidence: mainScore.confidence,
          ob: shallowObx,
          tradePlan,
          queuedAt: now,
          lifecycleState: "NEW"
        });
      }

      // =========================
      // 🌙 MOON SYSTEM (V4 SAFE)
      // =========================
      if (shallowObx.spreadPct < 1.8) {
        const prevState =
          (await kv.get(`state:moon:${mode}:${sym}`)) || {};

        const moonResult = MOON_CORE.decideMoonStage({
          CORE: MOON_CORE,
          mode,
          coin,
          obx: shallowObx,
          priceHist: prevState.priceHist || [],
          volHist: prevState.volHist || [],
          btc,
          prev: prevState,
          whaleFlow: 0,
          regime: "TREND"
        });

        if (
          moonResult?.stage?.includes("ELITE") ||
          moonResult?.stage === "ALMOST"
        ) {
          const tradePlan = MOON_CORE.buildMoonTradePlan({
            ...moonResult,
            price: coin.price,
            CORE: MOON_CORE,
            mode,
            depthOk: true,
            tier: null,
            regime: "TREND"
          });

          if (tradePlan) {
            tradePlan.size = calculateFuturesSize(
              tradePlan.entry,
              tradePlan.sl,
              50,
              config
            );
          }

          funnelQueue.push({
            symbol: sym,
            side: mode === "bull" ? "LONG" : "SHORT",
            sourceSystem: "moon",
            sourceMode: mode,
            stage: moonResult.stage,
            confidence: moonResult.entryQuality,
            entryQuality: moonResult.entryQuality,
            persistenceScore: moonResult.persistenceScore,
            ob: shallowObx,
            tradePlan,
            queuedAt: now,
            lifecycleState: "NEW"
          });

          eventQueue.push({
            priority: 3,
            type: "STAGE_UPGRADE",
            symbol: sym,
            data: {
              stage: moonResult.stage,
              price: coin.price
            }
          });
        }
      }
    }

    // =========================
    // 📦 SAVE FUNNEL
    // =========================
    if (funnelQueue.length > 0) {
      await kv.lpush(`trade_funnel:raw_queue:${mode}`, ...funnelQueue);
    }

    // =========================
    // ⚡ EVENTS
    // =========================
    if (eventQueue.length > 0) {
      const multi = kv.multi();
      let nonce = 0;

      for (const ev of eventQueue) {
        const score =
          ev.priority * 1e13 + now * 1000 + (nonce++ % 1000);

        multi.zadd("system:events:queue", {
          score,
          member: JSON.stringify(ev)
        });
      }

      await multi.exec();
    }

    res.status(200).json({
      ok: true,
      forwarded: funnelQueue.length
    });

  } catch (err) {
    console.error("Scan error:", err);
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
}