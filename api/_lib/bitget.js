import { fetchJson, n } from "./utils.js";

export async function loadUsdtSpotMap(redis) {
  // cache in redis 24h
  const key = "bitget:spotmap:usdt:v1";
  const cached = await redis.get(key);
  if (cached?.ts && cached?.map && (Date.now() - cached.ts) < 24 * 60 * 60 * 1000) {
    return cached.map;
  }

  // Stable endpoint (spot products)
  const j = await fetchJson("https://api.bitget.com/api/spot/v1/public/products", 4);
  const list = j?.data || [];
  const map = {};

  for (const p of list) {
    const base = (p?.baseCoin || p?.baseCoinName || "").toString().toUpperCase();
    const quote = (p?.quoteCoin || "").toString().toUpperCase();
    const sname = (p?.symbolName || p?.symbol || "").toString(); // e.g. btcusdt_spbl
    if (!base || quote !== "USDT") continue;
    if (!sname.toLowerCase().endsWith("_spbl")) continue;
    map[base] = sname;
  }

  await redis.set(key, { ts: Date.now(), map });
  return map;
}

export async function fetchOB(symbolName, limit = 20) {
  const url = `https://api.bitget.com/api/spot/v1/market/depth?symbol=${encodeURIComponent(symbolName)}&limit=${limit}`;
  const j = await fetchJson(url, 3);
  const d = j?.data || {};
  return { bids: d?.bids || [], asks: d?.asks || [] };
}

export function calcObMetrics(ob, midPrice, depthPct = 0.02) {
  const mid = n(midPrice);
  if (mid == null || mid <= 0) return null;

  const minBid = mid * (1 - depthPct);
  const maxAsk = mid * (1 + depthPct);

  let bidUsd = 0, askUsd = 0;

  for (const b of ob.bids || []) {
    const p = n(b[0]), sz = n(b[1]);
    if (p == null || sz == null) continue;
    if (p >= minBid && p <= mid) bidUsd += p * sz;
  }
  for (const a of ob.asks || []) {
    const p = n(a[0]), sz = n(a[1]);
    if (p == null || sz == null) continue;
    if (p <= maxAsk && p >= mid) askUsd += p * sz;
  }

  const score = (bidUsd + askUsd) > 0 ? (bidUsd - askUsd) / (bidUsd + askUsd) : 0;

  const bestBid = ob.bids?.[0]?.[0] ? n(ob.bids[0][0]) : null;
  const bestAsk = ob.asks?.[0]?.[0] ? n(ob.asks[0][0]) : null;
  const spreadPct = (bestBid && bestAsk && bestAsk > 0)
    ? ((bestAsk - bestBid) / ((bestAsk + bestBid) / 2)) * 100
    : null;

  return { score, spreadPct, bidUsd, askUsd };
}
