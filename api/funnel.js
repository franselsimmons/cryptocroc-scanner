// api/funnel.js
import { kv } from "@vercel/kv";
import { resolveFunnelConflicts, computeFunnelGate } from "../lib/_funnel_policy.js";
import pLimit from "p-limit";

const BITGET_L15 = "https://api.bitget.com/api/v2/mix/market/orderbook?productType=USDT-FUTURES&limit=15";

async function fetchDeepOb(symbol) {
  try {
    const res = await fetch(`${BITGET_L15}&symbol=${symbol}USDT`);
    const json = await res.json();
    return json.data;
  } catch { return null; }
}

export default async function funnelHandler(req, res) {
  const mode = req.query?.mode |

| "bull";
  const now = Date.now();
  const rawKey = `trade_funnel:raw_queue:${mode}`;
  
  try {
    const rawItems = await kv.lrange(rawKey, 0, -1);
    await kv.del(rawKey); 
    if (!rawItems.length) return res.status(200).json({ processed: 0 });

    const resolvedItems = resolveFunnelConflicts(rawItems, now);
    
    const limit = pLimit(8); // Bitget rate-limit protectie
    const enriched = await Promise.all(resolvedItems.map(item => limit(async () => {
        const deepObArray = await fetchDeepOb(item.symbol);
        
        // Correcte parsing van Bitget's array of arrays (e.g. data.bids)
        if (deepObArray && deepObArray.length > 0) {
            const obData = deepObArray;
            if (obData.bids && obData.bids.length > 0 && obData.asks && obData.asks.length > 0) {
                const bidVol = obData.bids.reduce((acc, val) => acc + (parseFloat(val) * parseFloat(val[1])), 0);
                const askVol = obData.asks.reduce((acc, val) => acc + (parseFloat(val) * parseFloat(val[1])), 0);
                
                const bestBid = parseFloat(obData.bids);
                const bestAsk = parseFloat(obData.asks);

                item.ob = {
                    bestBid, bestAsk,
                    spreadPct: ((bestAsk - bestBid) / bestBid) * 100,
                    score: (bidVol - askVol) / (bidVol + askVol),
                    depthMinUsd1p: Math.min(bidVol, askVol)
                };
            }
        }

        item.engineGate = computeFunnelGate(item);
        if (item.engineGate === "WATCH") item.lifecycleState = "WATCH";
        if (item.engineGate === "OPEN") item.lifecycleState = "ALLOW_ENTRY";

        item.updatedAt = now;
        return item;
    })));

    const finalCandidates = enriched.filter(i => i.engineGate === "WATCH" |

| i.engineGate === "OPEN");
    
    const existingCands = await kv.get(`engine:candidates:${mode}`) ||;
    // Voeg nieuwe toe, verwijder oude die expired (1h) zijn of al geconsumeerd
    const merged = [...finalCandidates,...existingCands]
       .filter(c => c.lifecycleState!== "OPENED" && c.lifecycleState!== "CANCELLED")
       .filter(c => now - c.queuedAt < 60 * 60 * 1000); 

    await kv.set(`engine:candidates:${mode}`, merged);

    res.status(200).json({ ok: true, readyForEngine: finalCandidates.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
