import { CFG, fetchJSON, mapCoin } from "./_core.js";
import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs" };

async function getMarkets(){
  return fetchJSON(
    "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=250&page=1"
  );
}

export default async function handler(req,res){
  try{
    const u = new URL(req.url,"http://localhost");
    const mode = u.searchParams.get("mode") || "bull";

    const markets = await getMarkets();
    const mapped = markets.map(mapCoin);

    const filtered = mapped.filter(c =>
      c.volume > CFG.minVolumeUsd &&
      c.marketCap > CFG.minMarketCap &&
      c.vm > CFG.minVmRatio
    );

    const radar = [];
    const buildup = [];
    const entry = [];

    for(const c of filtered){
      if(mode==="bull" && c.change24 > 0){
        buildup.push(c);
        if(c.vm > 0.5) entry.push(c);
      }
      if(mode==="bear" && c.change24 < 0){
        buildup.push(c);
        if(c.vm > 0.5) entry.push(c);
      }
    }

    const result = {
      ts: Date.now(),
      mode,
      radar,
      buildup,
      entry
    };

    await kv.set(`latest:${mode}`,result);

    res.statusCode=200;
    res.end(JSON.stringify(result));
  }catch(e){
    res.statusCode=500;
    res.end(JSON.stringify({error:String(e)}));
  }
}