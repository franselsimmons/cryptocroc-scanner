// /api/orderbook.js

import { RUNTIME_CONFIG } from "./_core.js";

export const config = RUNTIME_CONFIG;

const BYBIT_URL = "https://api.bybit.com/v5/market/orderbook";

function normalizeBaseSymbol(raw) {
  const s = String(raw || "").trim().toUpperCase();
  if (!s) return "";
  if (s.endsWith("USDT")) return s.slice(0, -4);
  return s;
}

async function fetchOrderbook(pair) {
  const url = `${BYBIT_URL}?category=linear&symbol=${pair}&limit=50`;
  const r = await fetch(url);
  const j = await r.json();
  if (!j.result) throw new Error("Invalid OB response");
  return j.result;
}

function calcDepthUsd(levels) {
  let total = 0;

  for (const lvl of levels) {
    const price = Number(lvl[0]);
    const size = Number(lvl[1]);

    if (!price || !size) continue;

    total += price * size;
  }

  return total;
}

export default async function handler(req, res) {
  try {
    const u = new URL(req.url, "http://localhost");
    const symbolRaw = u.searchParams.get("symbol");
    const side = (u.searchParams.get("side") || "bull").toLowerCase();

    if (!symbolRaw) throw new Error("Missing symbol");

    const base = normalizeBaseSymbol(symbolRaw);
    const pair = `${base}USDT`;

    const ob = await fetchOrderbook(pair);

    const askDepth = calcDepthUsd(ob.a);
    const bidDepth = calcDepthUsd(ob.b);

    const depthUsd = Math.min(askDepth, bidDepth);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");

    res.end(JSON.stringify({
      ok: true,
      symbol: base,
      pair,
      side,
      askDepthUsd: Math.round(askDepth),
      bidDepthUsd: Math.round(bidDepth),
      depthUsd: Math.round(depthUsd),
      note: "Depth = min(askDepth, bidDepth)"
    }));

  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e.message) }));
  }
}