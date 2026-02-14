import { kv } from "@vercel/kv";
import { CFG, fetchJSON, json, mean, std } from "./_core.js";

export const config = { runtime: "nodejs" };

async function fetchBitgetDepth(symbol) {
  // Bitget spot depth (jouw variant)
  const url = `https://api.bitget.com/api/spot/v1/market/depth?symbol=${encodeURIComponent(symbol)}USDT&limit=50`;
  const j = await fetchJSON(url);
  return j?.data;
}

function sumDepth(levels, mid, pct, isBid) {
  const limit = isBid ? mid * (1 - pct) : mid * (1 + pct);
  let total = 0;

  for (const lv of levels) {
    const p = Number(lv?.[0]);
    const s = Number(lv?.[1]);
    if (!(p > 0) || !(s > 0)) continue;

    if (isBid && p < limit) break;
    if (!isBid && p > limit) break;

    total += p * s;
  }
  return total;
}

export default async function handler(req, res) {
  try {
    const u = new URL(req.url, "http://localhost");
    const symbol = (u.searchParams.get("symbol") || "").toUpperCase();
    const mode = (u.searchParams.get("mode") || "bull").toLowerCase();

    if (!symbol) return json(res, 400, { ok: false, error: "Missing symbol" });

    const data = await fetchBitgetDepth(symbol);
    if (!data?.bids?.length || !data?.asks?.length) {
      return json(res, 200, { ok: false, error: "No orderbook (coin not on Bitget USDT?)", symbol });
    }

    const bid = Number(data.bids[0][0]);
    const ask = Number(data.asks[0][0]);
    const mid = (bid + ask) / 2;
    if (!(mid > 0)) return json(res, 200, { ok: false, error: "Bad OB mid", symbol });

    const bidUsd = sumDepth(data.bids, mid, CFG.obDepthPct, true);
    const askUsd = sumDepth(data.asks, mid, CFG.obDepthPct, false);

    const score = (bidUsd + askUsd) > 0 ? (bidUsd - askUsd) / (bidUsd + askUsd) : 0;

    // z-score history in KV
    const hKey = `ob:${mode}:${symbol}`;
    const hist = (await kv.get(hKey)) || [];
    const next = Array.isArray(hist) ? hist.slice(-50) : [];
    next.push(score);
    await kv.set(hKey, next);

    const m = mean(next);
    const sdev = std(next);
    const zScore = (sdev > 0) ? (score - m) / sdev : 0;

    const passed = next.length >= CFG.obMinSamples ? (Math.abs(zScore) >= CFG.obZ) : false;

    return json(res, 200, {
      ok: true,
      symbol,
      mode,
      bidUsd,
      askUsd,
      score,
      zScore,
      samples: next.length,
      passed,
      note: next.length < CFG.obMinSamples ? `Need ${CFG.obMinSamples} samples for stable z-score` : "ok"
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e?.message || e) });
  }
}
