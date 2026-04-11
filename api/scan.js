import { kv } from "@vercel/kv";
import { fetchBTCGateFromUniverse, fetchCoinGeckoTopCached, fetchContractConfigs, fetchFuturesTickers, generateShallowOb, calculateFuturesSize } from "../lib/_main_shared.js";

function preScoreMainCoin(coin, CORE, mode) {
  const marketCap = Number(coin.market_cap |

| 0);
  const volume = Number(coin.total_volume |

| 0);
  const change24 = Number(coin.price_change_percentage_24h |

| 0);
  const range24 = coin.high_24h && coin.low_24h? ((coin.high_24h - coin.low_24h) / coin.low_24h) * 100 : 0;
  
  const vm = CORE.computeVm(volume, marketCap);
  const confidence = CORE.computeConfidence({ vm, change24, range24, obValid: false });
  
  const isSetup = confidence >= 30 && volume > 100000;
  return {
      stage: isSetup? "ENTRY_READY" : "RADAR",
      confidence, entryQuality: confidence * 0.9, persistenceScore: 50
  };
}

export default async function handler(req, res) {
  const mode = req.query?.mode |

| "bull";
  const now = Date.now();
  try {
    const CORE = mode === "bear"? await import("../lib/_core_bear.js") : await import("../lib/_core_bull.js");
    const CFG = CORE.getCfg();

    const btcRaw = await fetchBTCGateFromUniverse();
    const btc = {...btcRaw, state: CORE.computeBtcState(btcRaw, CFG) };
    
    const cgCoins = await fetchCoinGeckoTopCached(300);
    const validFutures = await fetchFuturesTickers();
    const contractConfigs = await fetchContractConfigs();

    const tradable = cgCoins.filter(c => validFutures.has(`${c.symbol.toUpperCase()}USDT`));
    const funnelQueue =;

    for (const coin of tradable) {
      const sym = coin.symbol.toUpperCase();
      const symbolUsdt = `${sym}USDT`;
      const ticker = validFutures.get(symbolUsdt);
      const config = contractConfigs.get(symbolUsdt);
      
      const shallowObx = generateShallowOb(ticker);
      if (shallowObx.spreadPct > 2.5) continue;

      const score = preScoreMainCoin(coin, CORE, mode);
      
      if (score.stage === "ENTRY_READY" |

| score.stage === "SETUP") {
        const currentPrice = Number(coin.current_price);
        const tradePlan = {
          entry: currentPrice,
          sl: currentPrice * (mode === "bull"? 0.95 : 1.05),
          tp: currentPrice * (mode === "bull"? 1.1 : 0.9),
          tpPct: 10, slPct: 5, rr: 2
        };
        tradePlan.size = calculateFuturesSize(tradePlan.entry, tradePlan.sl, 50, config);

        funnelQueue.push({
          symbol: sym, side: mode === "bull"? "LONG" : "SHORT", sourceSystem: "main", sourceMode: mode,
          stage: score.stage, confidence: score.confidence, ob: shallowObx, tradePlan, queuedAt: now, lifecycleState: "NEW"
        });
      }
    }

    if (funnelQueue.length > 0) await kv.lpush(`trade_funnel:raw_queue:${mode}`,...funnelQueue);
    res.status(200).json({ ok: true, forwarded: funnelQueue.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
