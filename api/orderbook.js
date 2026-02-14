import { CFG } from "./_core.js";

export const config = { runtime: "nodejs" };

// Bitget V2 spot orderbook endpoint (nieuw)
async function fetchBitgetOrderbook(symbol) {
  const s = String(symbol || "").toUpperCase();
  // Let op: dit werkt alleen als de coin echt een SPOT USDT pair heeft op Bitget
  const url = `https://api.bitget.com/api/v2/spot/market/orderbook?symbol=${encodeURIComponent(s)}USDT&limit=50`;

  const r = await fetch(url, { headers: { "accept": "application/json" } });
  const j = await r.json().catch(() => ({}));

  if (!r.ok) {
    throw new Error(`Bitget HTTP ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  }

  // V2: data is meestal array met 1 object
  const data = Array.isArray(j?.data) ? j.data[0] : j?.data;
  if (!data) throw new Error("Bitget: no data");

  return data;
}

function sumDepth(levels, mid, pct, isBid) {
  const limit = isBid ? mid * (1 - pct) : mid * (1 + pct);
  let total = 0;

  for (const lv of levels) {
    const price = Number(lv?.[0]);
    const size = Number(lv?.[1]);
    if (!(price > 0 && size > 0)) continue;

    if (isBid && price < limit) break;
    if (!isBid && price > limit) break;

    total += price * size;
  }
  return total;
}

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

export default async function handler(req, res) {
  try {
    const u = new URL(req.url, "http://localhost");
    const symbol = u.searchParams.get("symbol");
    if (!symbol) return json(res, 400, { ok: false, error: "Missing symbol" });

    const data = await fetchBitgetOrderbook(symbol);

    const bids = data?.bids;
    const asks = data?.asks;
    if (!Array.isArray(bids) || !Array.isArray(asks) || bids.length === 0 || asks.length === 0) {
      return json(res, 500, { ok: false, error: "Bitget: empty bids/asks (pair bestaat niet?)" });
    }

    const bid = Number(bids[0][0]);
    const ask = Number(asks[0][0]);
    const mid = (bid + ask) / 2;
    if (!(mid > 0)) return json(res, 500, { ok: false, error: "Bitget: invalid mid" });

    const bidUsd = sumDepth(bids, mid, CFG.obDepthPct, true);
    const askUsd = sumDepth(asks, mid, CFG.obDepthPct, false);
    const score = (bidUsd + askUsd) > 0 ? (bidUsd - askUsd) / (bidUsd + askUsd) : 0;

    return json(res, 200, {
      ok: true,
      symbol: String(symbol).toUpperCase(),
      mid,
      bidUsd,
      askUsd,
      score
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e?.message || e) });
  }
}
