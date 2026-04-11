import { kv } from "@vercel/kv";
import { fetchBTCGateFromUniverse, fetchCoinGeckoTopCached, fetchContractConfigs, fetchFuturesTickers, generateShallowOb, calculateFuturesSize } from "../../lib/_main_shared.js";
import { queueDiscordEvent } from "../../lib/discordRouter.js";

export default async function handler(req, res) {
  const mode = req.query?.mode |

| "bull";
  const now = Date.now();
  
  try {
    const CORE = mode === "bear"? await import("../../lib/_moon_core_bear.js") : await import("../../lib/_moon_core_bull.js");
    const btc = await fetchBTCGateFromUniverse();
    
    const [cgCoins, validFutures, contractConfigs] = await Promise.all();

    const tradable = cgCoins.filter(c => validFutures.has(`${c.symbol.toUpperCase()}USDT`));
    const funnelQueue =;

    for (const cgCoin of tradable) {
      const sym = cgCoin.symbol.toUpperCase();
      const symbolUsdt = `${sym}USDT`;
      const config = contractConfigs.get(symbolUsdt);
      const ticker = validFutures.get(symbolUsdt);
      
      const shallowObx = generateShallowOb(ticker);
      if (shallowObx.spreadPct > 1.8) continue; 

      const coin = {
        symbol: sym, price: Number(cgCoin.current_price), marketCap: Number(cgCoin.market_cap),
        volume: Number(cgCoin.total_volume), change24: Number(cgCoin.price_change_percentage_24h),
        change1h: Number(cgCoin.price_change_percentage_1h),
        range24: cgCoin.high_24h && cgCoin.low_24h? ((cgCoin.high_24h - cgCoin.low_24h) / cgCoin.low_24h) * 100 : 0,
        vm: (Number(cgCoin.total_volume) / Number(cgCoin.market_cap)) |

| 0
      };

      const prevState = (await kv.get(`state:moon:${mode}:${sym}`)) |

| {};
      const moonResult = CORE.decideMoonStage({
        CORE, mode, coin, obx: shallowObx, priceHist: prevState.priceHist ||, volHist: prevState.volHist ||, btc, prev: prevState, whaleFlow: 0, regime: "TREND"
      });

      if (moonResult.stage.includes("ELITE") |

| moonResult.stage === "ALMOST") {
        const tradePlan = CORE.buildMoonTradePlan({ CORE, price: coin.price, mode, confidence: moonResult.entryQuality, range24: coin.range24, depthOk: true, tier: null, regime: "TREND", persistenceScore: moonResult.persistenceScore });
        if (tradePlan) {
          tradePlan.size = calculateFuturesSize(tradePlan.entry, tradePlan.sl, 50, config);
          if (tradePlan.size > 0) {
            funnelQueue.push({
              symbol: sym, side: mode === "bull"? "LONG" : "SHORT", sourceSystem: "moon", sourceMode: mode,
              stage: moonResult.stage, confidence: moonResult.entryQuality, entryQuality: moonResult.entryQuality,
              persistenceScore: moonResult.persistenceScore, tradePlan, queuedAt: now, lifecycleState: "NEW", ob: shallowObx
            });
            await queueDiscordEvent(3, "STAGE_UPGRADE", sym, { stage: moonResult.stage, price: coin.price });
          }
        }
      }
    }

    if (funnelQueue.length > 0) await kv.lpush(`trade_funnel:raw_queue:${mode}`,...funnelQueue);
    res.status(200).json({ ok: true, forwarded: funnelQueue.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
}
