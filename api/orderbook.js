import { kv } from "@vercel/kv";
export const config = { runtime: "nodejs" };

const fetchFn = globalThis.fetch;

function json(res, code, obj){
  res.setHeader("Content-Type","application/json");
  res.setHeader("Cache-Control","no-store");
  res.status(code).end(JSON.stringify(obj));
}

function mean(arr){ return arr.reduce((a,b)=>a+b,0)/(arr.length||1); }
function std(arr){
  const m = mean(arr);
  const v = mean(arr.map(x => (x-m)*(x-m)));
  return Math.sqrt(v);
}

function parseLevels(levels){
  // levels: [ [price, size], ... ]
  return (levels || []).map(x => ({ price:Number(x[0]), size:Number(x[1]) })).filter(x=>x.price>0 && x.size>0);
}

async function fetchBitgetOB(symbol){
  // Spot orderbook endpoints verschillen per Bitget versie; we proberen 2 varianten.
  // Verwacht symbol als "BTCUSDT".
  const tries = [
    `https://api.bitget.com/api/spot/v1/market/depth?symbol=${encodeURIComponent(symbol)}&type=step0&limit=50`,
    `https://api.bitget.com/api/v2/spot/market/orderbook?symbol=${encodeURIComponent(symbol)}&type=step0&limit=50`
  ];

  for(const url of tries){
    const r = await fetchFn(url, { cache:"no-store" });
    if(!r.ok) continue;
    const j = await r.json();

    // v1: { data: { bids:[], asks:[] } }
    if(j?.data?.bids && j?.data?.asks){
      return { bids: j.data.bids, asks: j.data.asks, raw:j };
    }
    // v2: { data: { bids:[], asks:[] } } of { data: { bids, asks } }
    if(j?.data?.bids && j?.data?.asks){
      return { bids: j.data.bids, asks: j.data.asks, raw:j };
    }
  }
  throw new Error("Bitget orderbook not available for this symbol (or endpoint changed).");
}

export default async function handler(req,res){
  try{
    const url = new URL(req.url, "http://localhost");
    const symbol = (url.searchParams.get("symbol") || "").toUpperCase().trim();
    const mid = Number(url.searchParams.get("mid") || 0);
    const depthPct = Number(url.searchParams.get("depthPct") || 2);

    if(!symbol) return json(res, 400, { ok:false, error:"Missing symbol" });

    const ob = await fetchBitgetOB(symbol);
    const bids = parseLevels(ob.bids);
    const asks = parseLevels(ob.asks);

    if(!bids.length || !asks.length) throw new Error("Empty orderbook");

    const bestBid = bids[0].price;
    const bestAsk = asks[0].price;
    const midPx = mid>0 ? mid : (bestBid + bestAsk)/2;

    const minBid = midPx * (1 - depthPct/100);
    const maxAsk = midPx * (1 + depthPct/100);

    const bidUsd = bids.filter(x => x.price >= minBid).reduce((s,x)=> s + x.price*x.size, 0);
    const askUsd = asks.filter(x => x.price <= maxAsk).reduce((s,x)=> s + x.price*x.size, 0);

    const obScore = (bidUsd - askUsd) / ((bidUsd + askUsd) || 1);
    const spreadPct = ((bestAsk - bestBid) / midPx) * 100;

    // history -> zscore
    const HKEY = `ob:hist:${symbol}`;
    const hist = (await kv.get(HKEY)) || [];
    const next = Array.isArray(hist) ? hist.slice(-49) : [];
    next.push({ ts: Date.now(), obScore });

    await kv.set(HKEY, next);

    const arr = next.map(x=>x.obScore);
    const m = mean(arr);
    const s = std(arr) || 1e-9;
    const z = (obScore - m) / s;

    return json(res, 200, {
      ok:true,
      symbol,
      bestBid, bestAsk, mid: midPx,
      bidUsd, askUsd,
      obScore,
      zScore: z,
      mean: m,
      std: s,
      spreadPct,
      depthPct
    });

  }catch(e){
    return json(res, 200, { ok:false, error:e.message }); // UI wil "netjes" kunnen tonen zonder crash
  }
}
