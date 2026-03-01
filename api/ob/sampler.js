import { RUNTIME_CONFIG, requireSecret } from "../../lib/_runtime.js";
import { putObSnapshot } from "../../lib/obStore.js";

export const config = RUNTIME_CONFIG;

async function fetchBitgetOrderbook(symbol) {
  const pair = `${symbol.toUpperCase()}USDT`;
  const url = `https://api.bitget.com/api/v2/spot/market/orderbook?symbol=${pair}&type=step0&limit=100`;

  const r = await fetch(url);
  const j = await r.json().catch(() => null);

  if (!r.ok || !j || j.code !== "00000") {
    return { ok: false };
  }

  return { ok: true, depth: j.data };
}

function compute(depth) {
  const bids = depth?.bids || [];
  const asks = depth?.asks || [];
  if (!bids.length || !asks.length) return null;

  const bid = Number(bids[0][0]);
  const ask = Number(asks[0][0]);
  if (!bid || !ask) return null;

  const mid = (bid + ask) / 2;
  const spreadPct = ((ask - bid) / mid) * 100;

  const bidUsd = bids.slice(0, 10).reduce((a, x) => a + Number(x[0]) * Number(x[1]), 0);
  const askUsd = asks.slice(0, 10).reduce((a, x) => a + Number(x[0]) * Number(x[1]), 0);

  const depthMinUsd1p = Math.min(bidUsd, askUsd);
  const score = (bidUsd - askUsd) / (bidUsd + askUsd || 1);

  return {
    ts: Date.now(),
    spreadPct,
    depthMinUsd1p,
    pressureDeltaUsd: bidUsd - askUsd,
    score,
  };
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const mode = String(req.query.mode || "bull");
    const symbols = String(req.query.symbols || "")
      .split(",")
      .map(s => s.trim().toUpperCase())
      .filter(Boolean);

    const processed = [];

    for (const symbol of symbols) {
      const live = await fetchBitgetOrderbook(symbol);
      if (!live.ok) continue;

      const snap = compute(live.depth);
      if (!snap) continue;

      await putObSnapshot(mode, symbol, snap);
      processed.push(symbol);
    }

    return res.status(200).json({
      ok: true,
      mode,
      processed,
      count: processed.length,
      ts: Date.now(),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}