export const config = { runtime: "nodejs" };

export const CFG = {
  minVolumeUsd: 500000,
  minMarketCap: 2000000,
  minVmRatio: 0.25,
  obDepthPct: 0.002,
  obMinSamples: 5,
  obZ: 1.2
};

export async function fetchJSON(url){
  const r = await fetch(url);
  if(!r.ok) throw new Error("Fetch failed");
  return r.json();
}

export function vmRatio(c){
  return c.total_volume / c.market_cap;
}

export function mapCoin(c){
  return {
    symbol: c.symbol.toUpperCase(),
    price: c.current_price,
    volume: c.total_volume,
    marketCap: c.market_cap,
    change24: c.price_change_percentage_24h,
    vm: vmRatio(c)
  };
}