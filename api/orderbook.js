import { CFG, fetchJSON, json } from "./_core.js";

function sumDepth(levels, mid, pct, isBid) {
  const limit = isBid ? mid * (1 - pct) : mid * (1 + pct);
  let total = 0;

  for (const lv of levels) {
    const price = Number(lv?.[0]);
    const size  = Number(lv?.[1]);
    if (!(price > 0 && size > 0)) continue;

    if (isBid && price < limit) break;
    if (!isBid && price > limit) break;

    total += price * size;
  }
  return total;
}

export default async function handler(req, res) {
  try {
    const u = new URL(req.url, "http://localhost");
    const symbol = (u.searchParams.get("symbol") || "").toUpperCase();
    if (!symbol) return json(res, 400, { error: "Missing symbol" });

    // Bitget depth endpoint (spot)
    const url = `https://api.bitget.com/api/spot/v1/market/depth?symbol=${symbol}USDT&limit=50`;
    const j = await fetchJSON(url);

    const data = j?.data;
    const bids = data?.bids;
    const asks = data?.asks;
    if (!Array.isArray(bids) || !Array.isArray(asks) || bids.length === 0 || asks.length === 0) {
      return json(res, 404, { error: "No orderbook (coin niet op Bitget USDT of endpoint blokkeert)" });
    }

    const bid = Number(bids[0][0]);
    const ask = Number(asks[0][0]);
    const mid = (bid + ask) / 2;
    if (!(mid > 0)) return json(res, 500, { error: "Bad mid" });

    const bidUsd = sumDepth(bids, mid, CFG.obDepthPct, true);
    const askUsd = sumDepth(asks, mid, CFG.obDepthPct, false);
    const score = (bidUsd + askUsd) > 0 ? (bidUsd - askUsd) / (bidUsd + askUsd) : 0;

    return json(res, 200, { symbol, mid, bidUsd, askUsd, score });
  } catch (e) {
    return json(res, 500, { error: String(e) });
  }
}
