export const config = { runtime: "nodejs" };

export const CFG = {
  minVolumeUsd: 500000,
  minMarketCap: 2000000,
  minVmRatio: 0.25,

  // Orderbook
  obDepthPct: 0.002,
};

export async function fetchJSON(url) {
  const r = await fetch(url, {
    headers: { "accept": "application/json" },
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Fetch failed ${r.status} ${r.statusText}: ${txt.slice(0, 200)}`);
  }
  return r.json();
}

export function vmRatio(c) {
  const mc = Number(c.market_cap) || 0;
  const vol = Number(c.total_volume) || 0;
  if (mc <= 0) return 0;
  return vol / mc;
}

export function mapCoin(c) {
  return {
    id: c.id,
    symbol: String(c.symbol || "").toUpperCase(),
    name: c.name,
    price: Number(c.current_price) || 0,
    volume: Number(c.total_volume) || 0,
    marketCap: Number(c.market_cap) || 0,
    change24: Number(c.price_change_percentage_24h) || 0,
    vm: vmRatio(c)
  };
}
