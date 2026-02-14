import { kv } from "@vercel/kv";
import { CFG, kvSet } from "./_core.js";

export const config = { runtime: "nodejs" };

function requireCron(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${secret}`) {
    res.statusCode = 401;
    res.end("Unauthorized");
    return false;
  }
  return true;
}

async function fetchBitgetDepth(symbol) {
  // Bitget spot depth
  const url = `https://api.bitget.com/api/spot/v1/market/depth?symbol=${symbol}USDT&limit=50`;
  const r = await fetch(url);
  const j = await r.json();
  return j?.data;
}

function sumDepth(levels, mid, pct, isBid) {
  const limit = isBid ? mid * (1 - pct) : mid * (1 + pct);
  let total = 0;
  for (const [price, size] of levels) {
    const p = Number(price);
    const s = Number(size);
    if (!p || !s) continue;
    if (isBid && p < limit) break;
    if (!isBid && p > limit) break;
    total += p * s;
  }
  return total;
}

function largestOrderRatio(levels, mid, pct, isBid) {
  const limit = isBid ? mid * (1 - pct) : mid * (1 + pct);
  let total = 0;
  let maxOne = 0;
  for (const [price, size] of levels) {
    const p = Number(price);
    const s = Number(size);
    if (!p || !s) continue;
    if (isBid && p < limit) break;
    if (!isBid && p > limit) break;
    const usd = p * s;
    total += usd;
    if (usd > maxOne) maxOne = usd;
  }
  if (total <= 0) return 1;
  return maxOne / total;
}

function computeOB(data) {
  const bid = Number(data.bids?.[0]?.[0] || 0);
  const ask = Number(data.asks?.[0]?.[0] || 0);
  if (!bid || !ask) throw new Error("No top of book");

  const mid = (bid + ask) / 2;
  const spreadPct = ((ask - bid) / mid) * 100;

  const bidUsd = sumDepth(data.bids, mid, CFG.obDepthPct, true);
  const askUsd = sumDepth(data.asks, mid, CFG.obDepthPct, false);
  const score = (bidUsd - askUsd) / Math.max(1e-9, (bidUsd + askUsd));

  const lorBid = largestOrderRatio(data.bids, mid, CFG.obDepthPct, true);
  const lorAsk = largestOrderRatio(data.asks, mid, CFG.obDepthPct, false);
  const lor = Math.max(lorBid, lorAsk);

  return { ts: Date.now(), bid, ask, mid, spreadPct, bidUsd, askUsd, score, lor };
}

function evaluateSamples(samples, side) {
  // samples: newest last
  const now = Date.now();
  const fresh = samples.filter(s => (now - s.ts) <= CFG.obWindowSec * 1000);
  if (fresh.length < CFG.obNeedSamples) return { valid: false, reason: "not_enough_samples" };

  const last3 = fresh.slice(-CFG.obNeedSamples);

  const dirOk = (s) => side === "bull" ? (s.score >= CFG.obScoreMin) : (s.score <= -CFG.obScoreMin);
  const good = last3.filter(dirOk).length;

  const spreadOk = last3.every(s => s.spreadPct <= CFG.spreadMaxEntry);
  const lorOk = last3.every(s => s.lor <= CFG.largestOrderRatioMax);

  if (!spreadOk) return { valid: false, reason: "spread" };
  if (!lorOk) return { valid: false, reason: "largest_order_ratio" };
  if (good < CFG.obNeedDirection) return { valid: false, reason: "direction" };

  // we nemen “avg score” als stabieler
  const avg = last3.reduce((a, s) => a + s.score, 0) / last3.length;

  return { valid: true, reason: "ok", avgScore: avg, last: last3[last3.length - 1] };
}

export default async function handler(req, res) {
  try {
    if (!requireCron(req, res)) return;

    // Kandidaten worden door scan.js gezet (max 20 per mode)
    const bull = (await kv.get("ob:candidates:bull")) || [];
    const bear = (await kv.get("ob:candidates:bear")) || [];

    async function processList(list, side) {
      for (const symbol of list) {
        try {
          const data = await fetchBitgetDepth(symbol);
          if (!data?.bids || !data?.asks) continue;

          const ob = computeOB(data);

          const keySamples = `ob:samples:${side}:${symbol}`;
          const prev = (await kv.get(keySamples)) || [];
          const next = [...prev, ob].slice(-30); // keep last 30
          await kvSet(keySamples, next);

          const evald = evaluateSamples(next, side);
          const keyRes = `ob:result:${side}:${symbol}`;
          await kvSet(keyRes, { ...evald, ts: Date.now(), symbol, side, ob });
        } catch {
          // skip per coin
        }
      }
    }

    await processList(bull, "bull");
    await processList(bear, "bear");

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, bull: bull.length, bear: bear.length, ts: Date.now() }));
  } catch (e) {
    res.statusCode = 500;
    res.end(String(e));
  }
}
