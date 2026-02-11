import { kv } from "@vercel/kv";

export const KEYS = {
  bull: "cryptocroc:bull",
  bear: "cryptocroc:bear",
  memory: "cryptocroc:memory",
  portfolio: "cryptocroc:portfolio",
  trades: "cryptocroc:trades"
};

export async function getJson(key, fallback=null){
  const v = await kv.get(key);
  return v ?? fallback;
}
export async function setJson(key, obj){
  await kv.set(key, obj);
}
export async function pushTrade(lineObj){
  // trades als array (simpel en betrouwbaar)
  const arr = (await kv.get(KEYS.trades)) ?? [];
  arr.push(lineObj);
  // cap op 2000 regels
  if(arr.length > 2000) arr.splice(0, arr.length-2000);
  await kv.set(KEYS.trades, arr);
}
export async function ensurePortfolio(){
  let p = await kv.get(KEYS.portfolio);
  if(!p){
    p = {
      version:1,
      baseCurrency:"USD",
      startingBalance:1000,
      currentBalance:1000,
      peakBalance:1000,
      maxDrawdownPct:-8,
      maxTotalOpenRiskPct:4,
      maxOpenExplosie:2,
      maxOpenAccu:3,
      positions:[]
    };
    await kv.set(KEYS.portfolio, p);
  }
  let t = await kv.get(KEYS.trades);
  if(!t) await kv.set(KEYS.trades, []);
  return p;
}
