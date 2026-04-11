import { kv } from "@vercel/kv";
import { resolveFunnelConflicts, computeFunnelGate } from "../lib/_trade_engine_core.js";

async function processInBatches(items, batchSize, processor) {
  let results =;
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(processor));
    results.push(...batchResults);
  }
  return results;
}

async function fetchDeepOb(symbol) {
  try {
    const res = await fetch(`https://api.bitget.com/api/v2/mix/market/orderbook?productType=USDT-FUTURES&limit=15&symbol=${symbol}USDT`);
    const json = await res.json();
    return json.data;
  } catch { return null; }
}

export default async function handler(req, res) {
  const mode = req.query?.mode |

| "bull";
  const now = Date.now();
  const rawKey = `trade_funnel:raw_queue:${mode}`;
  
  try {
    const rawItems = await kv.lrange(rawKey, 0, -1);
    await kv.del(rawKey); 
    if (!rawItems.length) return res.status(200).json({ processed: 0 });

    const resolvedItems = resolveFunnelConflicts(rawItems, now);
    
    const enriched = await processInBatches(resolvedItems, 8, async (item) => {
      const deepObData = await fetchDeepOb(item.symbol);
      
      // Correct parsing for array structure in books15 / L15 depth
      if (deepObData && deepObData.bids && deepObData.bids.length > 0 && deepObData.asks && deepObData.asks.length > 0) {
        const bidVol = deepObData.bids.reduce((acc, val) => acc + (parseFloat(val) * parseFloat(val[1])), 0);
        const askVol = deepObData.asks.reduce((acc, val) => acc + (parseFloat(val) * parseFloat(val[1])), 0);
        
        const bestBid = parseFloat(deepObData.bids);
        const bestAsk = parseFloat(deepObData.asks);

        item.ob = {
          bestBid, bestAsk,
          spreadPct: ((bestAsk - bestBid) / bestBid) * 100,
          score: (bidVol - askVol) / (bidVol + askVol),
          depthMinUsd1p: Math.min(bidVol, askVol)
        };
      }

      item.engineGate = computeFunnelGate(item);
      if (item.engineGate === "WATCH") item.lifecycleState = "WATCH";
      if (item.engineGate === "OPEN") item.lifecycleState = "ALLOW_ENTRY";
      item.updatedAt = now;
      return item;
    });

    const finalCandidates = enriched.filter(i => i.engineGate === "WATCH" |

| i.engineGate === "OPEN");
    const existingCands = await kv.get(`engine:candidates:${mode}`) ||;
    
    const merged = [...finalCandidates,...existingCands]
      .filter(c => c.lifecycleState!== "OPENED" && c.lifecycleState!== "CANCELLED")
      .filter(c => now - c.queuedAt < 60 * 60 * 1000); 

    await kv.set(`engine:candidates:${mode}`, merged);
    res.status(200).json({ ok: true, readyForEngine: finalCandidates.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
