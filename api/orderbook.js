import { fetchFn, json, kvGetJson, kvSetJson, cleanSymbol, asNum } from "./_util.js";

const DEPTH_PCT = 0.02;      // 2%
const LIMIT = 50;            // depth levels
const OB_HIST_MAX = 50;      // voor z-score
const TTL_SEC = 60 * 60 * 24; // 1 dag

function sumWithinPct(levels, mid, pct, side /*"bid"|"ask"*/) {
  let usd = 0;
  const lo = mid * (1 - pct);
  const hi = mid * (1 + pct);

  for (const lv of levels) {
    const px = asNum(lv?.[0]);
    const sz = asNum(lv?.[1]);
    if (!px || !sz) continue;

    if (px < lo || px > hi) continue;

    // bids: px <= mid, asks: px >= mid (niet keihard nodig maar netter)
    if (side === "bid" && px > mid) continue;
    if (side === "ask" && px < mid) continue;

    usd += px * sz;
  }
  return usd;
}

function meanStd(arr) {
  if (!arr.length) return { mean: 0, std: 0 };
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const v = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
  return { mean, std: Math.sqrt(v) };
}

async function bitgetDepth(symbolUSDT) {
  // Multi-fallback (Bitget wisselt endpoints per versie)
  const endpoints = [
    // Spot v1
    `https://api.bitget.com/api/spot/v1/market/depth?symbol=${symbolUSDT}&type=step0&limit=${LIMIT}`,
    // Spot v2 (soms)
    `https://api.bitget.com/api/v2/spot/market/orderbook?symbol=${symbolUSDT}&limit=${LIMIT}`,
    // Mix (soms voor perp)
    `https://api.bitget.com/api/mix/v1/market/depth?symbol=${symbolUSDT}&limit=${LIMIT}`
  ];

  let lastErr = null;

  for (const url of endpoints) {
    try {
      const r = await fetchFn(url, { headers: { "accept": "application/json" } });
      if (!r.ok) {
        lastErr = `HTTP ${r.status}`;
        continue;
      }
      const j = await r.json();

      // Normaliseer bids/asks
      const data = j?.data || j?.result || j;
      const bids = data?.bids || data?.bid || data?.b || [];
      const asks = data?.asks || data?.ask || data?.a || [];

      if (Array.isArray(bids) && Array.isArray(asks) && bids.length && asks.length) {
        return { ok: true, bids, asks, source: url };
      }

      lastErr = "No bids/asks in response";
    } catch (e) {
      lastErr = String(e?.message || e);
    }
  }

  return { ok: false, error: lastErr || "Bitget depth failed" };
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    const sym = cleanSymbol(url.searchParams.get("symbol") || "");
    if (!sym) return json(res, 400, { ok: false, error: "Missing symbol" });

    const symbolUSDT = `${sym}USDT`;

    const depth = await bitgetDepth(symbolUSDT);
    if (!depth.ok) {
      // Belangrijk: geen "OB err", maar nette reden terug
      return json(res, 200, {
        ok: false,
        symbol: sym,
        symbolUSDT,
        reason: "NO_BITGET_ORDERBOOK",
        error: depth.error || "Orderbook not available"
      });
    }

    const bestBid = asNum(depth.bids?.[0]?.[0], 0);
    const bestAsk = asNum(depth.asks?.[0]?.[0], 0);
    if (!bestBid || !bestAsk || bestAsk <= bestBid) {
      return json(res, 200, {
        ok: false,
        symbol: sym,
        reason: "BAD_SPREAD_DATA"
      });
    }

    const mid = (bestBid + bestAsk) / 2;
    const spreadPct = (bestAsk - bestBid) / mid;

    const bidUsd = sumWithinPct(depth.bids, mid, DEPTH_PCT, "bid");
    const askUsd = sumWithinPct(depth.asks, mid, DEPTH_PCT, "ask");
    const denom = bidUsd + askUsd;
    const obScore = denom > 0 ? (bidUsd - askUsd) / denom : 0;

    const key = `ob:${sym}`;
    const hist = await kvGetJson(key, { scores: [] });
    const scores = Array.isArray(hist.scores) ? hist.scores : [];
    scores.push(obScore);
    while (scores.length > OB_HIST_MAX) scores.shift();

    const { mean, std } = meanStd(scores);
    const z = std > 0 ? (obScore - mean) / std : null;

    await kvSetJson(key, { scores }, TTL_SEC);

    return json(res, 200, {
      ok: true,
      symbol: sym,
      mid,
      spreadPct,
      bidUsd,
      askUsd,
      obScore,
      zScore: z,
      depthPct: DEPTH_PCT,
      source: depth.source
    });
  } catch (e) {
    return json(res, 200, { ok: false, reason: "SERVER_ERROR", error: String(e?.message || e) });
  }
}
