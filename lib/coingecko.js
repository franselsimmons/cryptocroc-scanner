import { fetchJson, safeNum } from "./utils.js";

const CG = "https://api.coingecko.com/api/v3";

export async function getMarkets({ perPage = 250, page = 1 } = {}) {
  const url =
    `${CG}/coins/markets?vs_currency=usd&order=volume_desc&per_page=${perPage}&page=${page}` +
    `&sparkline=false&price_change_percentage=1h,24h,7d`;

  const r = await fetchJson(url);
  if (!r.ok || !Array.isArray(r.data)) {
    return [];
  }

  return r.data.map(c => ({
    id: c.id,
    symbol: String(c.symbol || "").toUpperCase(),
    name: c.name,
    price: safeNum(c.current_price),
    mcap: safeNum(c.market_cap),
    vol: safeNum(c.total_volume),
    ch1h: safeNum(c.price_change_percentage_1h_in_currency),
    ch24: safeNum(c.price_change_percentage_24h_in_currency),
    ch7d: safeNum(c.price_change_percentage_7d_in_currency),
    athChange: safeNum(c.ath_change_percentage),
    updatedAt: c.last_updated || null
  }));
}
