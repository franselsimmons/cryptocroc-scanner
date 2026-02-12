import { CFG } from "./_core.js";

export const config = { runtime: "nodejs" };

async function fetchBitget(symbol){
  const url = `https://api.bitget.com/api/spot/v1/market/depth?symbol=${symbol}USDT&limit=50`;
  const r = await fetch(url);
  const j = await r.json();
  return j?.data;
}

function sumDepth(levels, mid, pct, isBid){
  const limit = isBid ? mid*(1-pct) : mid*(1+pct);
  let total = 0;
  for(const [price,size] of levels){
    const p = Number(price);
    const s = Number(size);
    if(isBid && p < limit) break;
    if(!isBid && p > limit) break;
    total += p*s;
  }
  return total;
}

export default async function handler(req,res){
  try{
    const u = new URL(req.url,"http://localhost");
    const symbol = u.searchParams.get("symbol");
    if(!symbol) throw new Error("Missing symbol");

    const data = await fetchBitget(symbol);
    if(!data?.bids || !data?.asks) throw new Error("No OB");

    const bid = Number(data.bids[0][0]);
    const ask = Number(data.asks[0][0]);
    const mid = (bid+ask)/2;

    const bidUsd = sumDepth(data.bids,mid,CFG.obDepthPct,true);
    const askUsd = sumDepth(data.asks,mid,CFG.obDepthPct,false);

    const score = (bidUsd-askUsd)/(bidUsd+askUsd);

    res.statusCode=200;
    res.end(JSON.stringify({score,bidUsd,askUsd}));
  }catch(e){
    res.statusCode=500;
    res.end(JSON.stringify({error:String(e)}));
  }
}