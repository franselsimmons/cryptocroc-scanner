import { kv } from "@vercel/kv";
import { CFG, json, avg, std } from "./_core.js";

const fetchFn = globalThis.fetch;

function meanMid(bids, asks){
  const bid = bids?.[0]?.[0] ? Number(bids[0][0]) : 0;
  const ask = asks?.[0]?.[0] ? Number(asks[0][0]) : 0;
  if(bid>0 && ask>0) return (bid+ask)/2;
  return bid || ask || 0;
}

function depthSum(levels, mid, pct, isBid){
  // levels: [[price, size], ...]
  const lim = mid * (1 + (isBid ? -pct : pct));
  let usd = 0;
  for(const lv of (levels||[])){
    const p = Number(lv[0]);
    const s = Number(lv[1]);
    if(!(p>0 && s>0)) continue;
    if(isBid){
      if(p < lim) break;
    }else{
      if(p > lim) break;
    }
    usd += p*s;
  }
  return usd;
}

export default async function handler(req){
  try{
    const url = new URL(req.url);
    const side = (url.searchParams.get("side") || "bull").toLowerCase();
    const symbol = (url.searchParams.get("symbol") || "").toLowerCase();
    if(!symbol) return json({ ok:false, error:"missing symbol" }, 400);

    // Bitget symbol: XXXUSDT
    const bitgetSymbol = symbol.toUpperCase() + "USDT";

    const obUrl = `https://api.bitget.com/api/v2/spot/market/orderbook?symbol=${encodeURIComponent(bitgetSymbol)}&limit=100`;
    const r = await fetchFn(obUrl);
    const j = await r.json();

    const data = j?.data;
    const bids = data?.bids;
    const asks = data?.asks;
    if(!Array.isArray(bids) || !Array.isArray(asks) || bids.length===0 || asks.length===0){
      return json({ ok:false, error:`Bitget orderbook missing for ${bitgetSymbol}` }, 502);
    }

    const mid = meanMid(bids, asks);
    if(!(mid>0)) return json({ ok:false, error:"mid price invalid" }, 502);

    const bidUsd = depthSum(bids, mid, CFG.depthPct, true);
    const askUsd = depthSum(asks, mid, CFG.depthPct, false);

    const obScore = (bidUsd + askUsd) > 0 ? (bidUsd - askUsd) / (bidUsd + askUsd) : 0;

    // store history for z-score
    const hKey = `ob:${side}:${symbol}`;
    const hist = (await kv.get(hKey)) || [];
    const newHist = Array.isArray(hist) ? hist.concat([obScore]).slice(-CFG.obHistMax) : [obScore];
    await kv.set(hKey, newHist);

    const sdev = std(newHist);
    const mean = avg(newHist);
    const zScore = (sdev>0) ? (obScore - mean)/sdev : 0;

    const passed = side==="bull" ? (zScore >= CFG.obZBull) : (zScore <= CFG.obZBear);

    // note voor UI
    let note = "ok";
    if(newHist.length < CFG.obMinSamples) note = `warming up (${newHist.length}/${CFG.obMinSamples})`;

    return json({
      ok:true,
      data: {
        symbol,
        bitgetSymbol,
        obScore,
        zScore,
        passed,
        note
      }
    });
  }catch(e){
    return json({ ok:false, error: e.message || String(e) }, 500);
  }
}
