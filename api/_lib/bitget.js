import { fetchJson } from "./utils.js";
import { n } from "./utils.js";

// V2: symbols lijst (USDT spot)
export async function loadBitgetSpotUsdtMap(redis) {
  const key = "bitget:spot:usdt:symbolmap:v1";
  const cached = await redis.get(key);
  if (cached?.ts && cached?.map && (Date.now() - cached.ts) < 24 * 60 * 60 * 1000) return cached.map;

  // Bitget Spot V2 public symbols
  const j = await fetchJson("https://api.bitget.com/api/v2/spot/public/symbols", 4);
  const list = j?.data || [];
  const map = {};

  for (const it of list) {
    const base = (it?.baseCoin || "").toString().toUpperCase();
    const quote = (it?.quoteCoin || "").toString().toUpperCase();
    const symbol = (it?.symbol || "").toString().toUpperCase(); // bijv: BTCUSDT
    const status = (it?.status || "").toString().toLowerCase(); // online/offline

    if (!base || quote !== "USDT" || !symbol) continue;
    if (status && status !== "online") continue;

    // map op BASE zodat "PEPE" -> "PEPEUSDT"
    map[base] = symbol;
  }

  await redis.set(key, { ts: Date.now(), mapCount: Object.keys(map).length, map });
  return map;
}

// V2: orderbook depth
export async function fetchBitgetOrderbook(symbol, limit = 20) {
  const url = `https://api.bitget.com/api/v2/spot/market/orderbook?symbol=${encodeURIComponent(symbol)}&type=step0&limit=${encodeURIComponent(String(limit))}`;
  const j = await fetchJson(url, 3);
  const d = j?.data || {};
  // V2 geeft arrays terug (bids/asks). We normaliseren naar [{price,size}]
  return { bids: d?.bids || [], asks: d?.asks || [] };
}

export function calcObMetrics(ob, midPrice, depthPct = 0.02) {
  const mid = n(midPrice);
  if (mid == null || mid <= 0) return null;

  const minBid = mid * (1 - depthPct);
  const maxAsk = mid * (1 + depthPct);

  let bidUsd = 0, askUsd = 0;

  for (const b of ob?.bids || []) {
    const p = n(b?.[0]), sz = n(b?.[1]);
    if (p == null || sz == null) continue;
    if (p >= minBid && p <= mid) bidUsd += p * sz;
  }
  for (const a of ob?.asks || []) {
    const p = n(a?.[0]), sz = n(a?.[1]);
    if (p == null || sz == null) continue;
    if (p <= maxAsk && p >= mid) askUsd += p * sz;
  }

  const score = (bidUsd + askUsd) > 0 ? (bidUsd - askUsd) / (bidUsd + askUsd) : 0;

  const bestBid = ob?.bids?.[0]?.[0] ? n(ob.bids[0][0]) : null;
  const bestAsk = ob?.asks?.[0]?.[0] ? n(ob.asks[0][0]) : null;
  const spreadPct = (bestBid && bestAsk && bestAsk > 0)
    ? ((bestAsk - bestBid) / ((bestAsk + bestBid) / 2)) * 100
    : null;

  return { score, spreadPct, bidUsd, askUsd };
}
