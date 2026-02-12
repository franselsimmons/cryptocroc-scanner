export default async function handler(req, res) {
  try {
    const symbol = (req.query.symbol || "").toString().toUpperCase();
    if (!symbol) return res.status(400).json({ ok: false, error: "Missing symbol" });

    // Bitget SPOT orderbook endpoint (kan per tijd veranderen, dus: fail-safe)
    // Als Bitget niet lukt -> ok:false, UI blijft gewoon werken.
    const url = `https://api.bitget.com/api/v2/spot/market/orderbook?symbol=${encodeURIComponent(symbol)}&limit=50`;

    const r = await fetch(url, { headers: { "accept": "application/json" } });
    if (!r.ok) return res.status(200).json({ ok: false, error: `Orderbook HTTP ${r.status}` });

    const j = await r.json();

    // We proberen bids/asks te vinden in een paar bekende vormen
    const bids = j?.data?.bids || j?.data?.bid || j?.bids || [];
    const asks = j?.data?.asks || j?.data?.ask || j?.asks || [];

    return res.status(200).json({
      ok: true,
      symbol,
      bids,
      asks,
      raw: j
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
