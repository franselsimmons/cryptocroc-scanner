// /api/ob-sampler.js
import { kv } from "@vercel/kv";
import {
  RUNTIME_CONFIG,
  requireSecret,
  SETTINGS,
  keyLatest,
  keyObSamples,
  keyObResult,
} from "./_core.js";

export const config = RUNTIME_CONFIG;

async function fetchBitgetDepth(symbolUpper) {
  const sym = `${String(symbolUpper || "").toUpperCase()}USDT`;
  const url = `https://api.bitget.com/api/spot/v1/market/depth?symbol=${encodeURIComponent(sym)}&limit=50`;
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) return null;
  const j = await r.json();
  return j?.data || null;
}

function sumDepth(levels, mid, pct, isBid) {
  const limit = isBid ? mid * (1 - pct) : mid * (1 + pct);
  let total = 0;
  let biggest = 0;

  for (const row of levels) {
    const p = Number(row?.[0]);
    const s = Number(row?.[1]);
    if (!Number.isFinite(p) || !Number.isFinite(s)) continue;

    if (isBid && p < limit) break;
    if (!isBid && p > limit) break;

    const usd = p * s;
    total += usd;
    if (usd > biggest) biggest = usd;
  }
  return { total, biggest };
}

function computeObSample(depth) {
  const bids = depth?.bids || [];
  const asks = depth?.asks || [];
  if (!bids.length || !asks.length) return null;

  const bid = Number(bids[0]?.[0]);
  const ask = Number(asks[0]?.[0]);
  if (!(bid > 0) || !(ask > 0)) return null;

  const mid = (bid + ask) / 2;
  const spreadPct = ((ask - bid) / mid) * 100;

  // 0.2% score
  const bid02 = sumDepth(bids, mid, 0.002, true);
  const ask02 = sumDepth(asks, mid, 0.002, false);

  const denom = bid02.total + ask02.total;
  const score = denom > 0 ? (bid02.total - ask02.total) / denom : 0;
  const biggest = Math.max(bid02.biggest, ask02.biggest);
  const lor = denom > 0 ? biggest / denom : 1;

  // ✅ NIEUW – 1% liquiditeit
  const bid1 = sumDepth(bids, mid, 0.01, true);
  const ask1 = sumDepth(asks, mid, 0.01, false);
  const depthMinUsd1p = Math.min(bid1.total, ask1.total);

  return {
    ts: Date.now(),
    score,
    spreadPct,
    lor,
    bidUsd: bid02.total,
    askUsd: ask02.total,
    mid,
    depthMinUsd1p,
  };
}