import { kv } from "@vercel/kv";
import { fetchBTCGateFromUniverse, fetchCoinGeckoTopCached, fetchContractConfigs, fetchFuturesTickers, generateShallowOb, calculateFuturesSize } from "../lib/_main_shared.js";
import { preScoreCoin } from "../lib/_core_bull.js"; // Core import (Bull/Bear resolved dynamically in prod)

export default async function handler(req, res) {
  const mode = req.query?.mode |

| "bull";
  const now = Date.now();
  
  try {
    const CORE = mode === "bear"? await import("../lib/_core_bear.js") : await import("../lib/_core_bull.js");
    const [cgCoins, validFutures, contractConfigs] = await Promise.all();

    const tradable = cgCoins.filter(c => validFutures.has(`${c.symbol.toUpperCase()}USDT`));
    const funnelQueue =;

    for (const coin of tradable) {
      const sym = coin.symbol.toUpperCase();
      const symbolUsdt = `${sym}USDT`;
      const config = contractConfigs.get(symbolUsdt);
      const ticker = validFutures.get(symbolUsdt);
      
      const shallowObx = generateShallowOb(ticker);
      if (shallowObx.spreadPct > 2.5) continue; 

      const score = CORE.preScoreCoin(coin, mode);
      
      if (score.stage === "ENTRY_READY" |

| score.stage === "SETUP") {
        const currentPrice = Number(coin.current_price);
        const slPrice = currentPrice * (mode === "bull"? 0.95 : 1.05);
        const tpPrice = currentPrice * (mode === "bull"? 1.1 : 0.9);
        
        const tradePlan = {
          entry: currentPrice, sl: slPrice, tp: tpPrice, tpPct: 10, slPct: 5, rr: 2,
          size: calculateFuturesSize(currentPrice, slPrice, 50, config)
        };

        if (tradePlan.size > 0) {
          funnelQueue.push({
            symbol: sym, side: mode === "bull"? "LONG" : "SHORT", sourceSystem: "main", sourceMode: mode,
            stage: score.stage, confidence: score.confidence, ob: shallowObx, tradePlan, queuedAt: now, lifecycleState: "NEW"
          });
        }
      }
    }

    if (funnelQueue.length > 0) await kv.lpush(`trade_funnel:raw_queue:${mode}`,...funnelQueue);
    res.status(200).json({ ok: true, forwarded: funnelQueue.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
}
