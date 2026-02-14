import { CFG, fetchJSON } from "./_core.js";

export const config = { runtime: "nodejs" };

function sumDepth(levels, mid, pct, isBid) {
  const limit = isBid ? mid * (1 - pct) : mid * (1 + pct);
  let total = 0;
  let largest = 0;

  for (const [price, size] of levels) {
    const p = Number(price);
    const s = Number(size);
    if (!p || !s) continue;

    if (isBid && p < limit) break;
    if (!isBid && p > limit) break;

    const usd = p * s;
    total += usd;
    if (usd > largest) largest = usd;
  }
  return { total, largest };
}

export default async function handler(req, res) {
  try {
    const u = new URL(req.url, "http://localhost");
    const symbol = (u.searchParams.get("symbol") || "").toUpperCase().trim();
    if (!symbol) throw new Error("Missing symbol");

    // Bitget spot depth (v1)
    const url = `https://api.bitget.com/api/spot/v1/market/depth?symbol=${symbol}USDT&limit=${CFG.ob.depthLimit}`;
    const j = await fetchJSON(url, { timeoutMs: 12_000 });

    const data = j?.data;
    const bids = data?.bids;
    const asks = data?.asks;
    if (!bids?.length || !asks?.length) throw new Error("No OB data");

    const bid = Number(bids[0][0]);
    const ask = Number(asks[0][0]);
    const mid = (bid + ask) / 2;
    const spreadPct = ((ask - bid) / mid) * 100;

    const b = sumDepth(bids, mid, CFG.ob.depthPct, true);
    const a = sumDepth(asks, mid, CFG.ob.depthPct, false);

    const score = (b.total - a.total) / (b.total + a.total);
    const largestRatio = Math.max(b.largest, a.largest) / Math.max(1, (b.total + a.total));

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({
      symbol,
      mid,
      spreadPct,
      bidUsd: Math.round(b.total),
      askUsd: Math.round(a.total),
      score,
      largestOrderRatio: largestRatio
    }));
  } catch (e) {
    res.statusCode = 200; // UI-friendly
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: String(e) }));
  }
}
