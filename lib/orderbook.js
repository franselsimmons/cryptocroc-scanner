import { fetchJson } from "./utils.js";

function obScoreFromDepth(depth) {
  // depth: { bids:[[p,q]..], asks:[[p,q]..] }
  if (!depth?.bids?.length || !depth?.asks?.length) return null;

  const topB = depth.bids.slice(0, 20).reduce((s, [p,q]) => s + (Number(p)*Number(q)), 0);
  const topA = depth.asks.slice(0, 20).reduce((s, [p,q]) => s + (Number(p)*Number(q)), 0);
  const imbalance = (topB - topA) / Math.max(1, (topB + topA)); // -1..+1

  const bestBid = Number(depth.bids[0][0]);
  const bestAsk = Number(depth.asks[0][0]);
  const spread = bestAsk > 0 ? (bestAsk - bestBid) / bestAsk : null;

  return {
    imbalance,                // >0 = bids sterker
    spread,                   // kleiner = beter
    topBidUsd: topB,
    topAskUsd: topA
  };
}

async function binanceDepth(symbol, limit = 50) {
  const url = `https://api.binance.com/api/v3/depth?symbol=${encodeURIComponent(symbol)}&limit=${limit}`;
  const r = await fetchJson(url);
  if (!r.ok) return null;
  if (!r.data?.bids || !r.data?.asks) return null;
  return { bids: r.data.bids, asks: r.data.asks, src: "binance" };
}

async function bitgetDepth(symbol, limit = 50) {
  // Bitget spot orderbook endpoint (best effort)
  // Sommige symbols zijn anders (bijv. PEPEUSDT kan bestaan, maar veel smallcaps niet)
  const url = `https://api.bitget.com/api/v2/spot/market/orderbook?symbol=${encodeURIComponent(symbol)}&limit=${limit}`;
  const r = await fetchJson(url);
  if (!r.ok) return null;
  const d = r.data?.data;
  if (!d?.bids || !d?.asks) return null;
  return { bids: d.bids, asks: d.asks, src: "bitget" };
}

export async function getOrderbook(symbolUSDT) {
  const b = await binanceDepth(symbolUSDT);
  if (b) return { ...b, score: obScoreFromDepth(b) };

  const g = await bitgetDepth(symbolUSDT);
  if (g) return { ...g, score: obScoreFromDepth(g) };

  return null;
}
