import { kv } from "@vercel/kv";
import { fetchBTCGateFromUniverse, fetchCoinGeckoTopCached, fetchContractConfigs, fetchFuturesTickers, generateShallowOb, calculateFuturesSize } from "../../lib/_main_shared.js";

export default async function handler(req, res) {
  const mode = req.query?.mode |

| "bull";
  const now = Date.now();
  try {
    const CORE = mode === "bear"? await import("../../lib/_moon_core_bear.js") : await import("../../lib/_moon_core_bull.js");
    
    const btcRaw = await fetchBTCGateFromUniverse();
    const btc = {...btcRaw, state: CORE.computeMarketRegime({ btc: btcRaw, whaleFlow: 0, mode }) };
    
    const cgCoins = await fetchCoinGeckoTopCached(300);
    const validFutures = await fetchFuturesTickers();
    const contractConfigs = await fetchContractConfigs();

    const tradable = cgCoins.filter(c => validFutures.has(`${c.symbol.toUpperCase()}USDT`));
    const funnelQueue =;
    const eventQueue =;

    for (const cgCoin of tradable) {
      const sym = cgCoin.symbol.toUpperCase();
      const symbolUsdt = `${sym}USDT`;
      const ticker = validFutures.get(symbolUsdt);
      const config = contractConfigs.get(symbolUsdt);
      
      const shallowObx = generateShallowOb(ticker);
      if (shallowObx.spreadPct > 2.0) continue;

      const coin = {
        symbol: sym, price: Number(cgCoin.current_price), marketCap: Number(cgCoin.market_cap),
        volume: Number(cgCoin.total_volume), change24: Number(cgCoin.price_change_percentage_24h),
        change1h: Number(cgCoin.price_change_percentage_1h),
        range24: cgCoin.high_24h && cgCoin.low_24h? ((cgCoin.high_24h - cgCoin.low_24h) / cgCoin.low_24h) * 100 : 0,
        vm: CORE.computeVm(cgCoin.total_volume, cgCoin.market_cap)
      };

      const prevState = (await kv.get(`state:moon:${mode}:${sym}`)) |

| {};
      const moonResult = CORE.decideMoonStage({
        CORE, mode, coin, obx: shallowObx, 
        priceHist: prevState.priceHist ||, volHist: prevState.volHist ||, 
        btc, prev: prevState, whaleFlow: 0, regime: "TREND"
      });

      if (moonResult.stage.includes("ELITE") |

| moonResult.stage === "ALMOST") {
        const tradePlan = CORE.buildMoonTradePlan({
          CORE, price: coin.price, mode, confidence: moonResult.entryQuality, 
          range24: coin.range24, depthOk: true, tier: null, regime: "TREND", persistenceScore: moonResult.persistenceScore
        });

        if (tradePlan) {
          tradePlan.size = calculateFuturesSize(tradePlan.entry, tradePlan.sl, 50, config);
          funnelQueue.push({
            symbol: sym, side: mode === "bull"? "LONG" : "SHORT", sourceSystem: "moon", sourceMode: mode,
            stage: moonResult.stage, confidence: moonResult.entryQuality, entryQuality: moonResult.entryQuality,
            persistenceScore: moonResult.persistenceScore, tradePlan, queuedAt: now, lifecycleState: "NEW"
          });
          eventQueue.push({ priority: 3, type: "STAGE_UPGRADE", symbol: sym, data: { stage: moonResult.stage, price: coin.price }});
        }
      }
    }

    if (funnelQueue.length > 0) await kv.lpush(`trade_funnel:raw_queue:${mode}`,...funnelQueue);
    if (eventQueue.length > 0) {
      const multi = kv.multi();
      let nonce = 0;
      for (const ev of eventQueue) {
        const score = (ev.priority * 1e13) + (now * 1000) + (nonce++ % 1000);
        multi.zadd("system:events:queue", { score, member: JSON.stringify(ev) });
      }
      await multi.exec();
    }

    res.status(200).json({ ok: true, forwarded: funnelQueue.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
