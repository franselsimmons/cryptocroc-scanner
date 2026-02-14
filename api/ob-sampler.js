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

async function fetchBitgetDepth(symbol) {
  // Bitget v1 depth werkt stabiel; base is al USDT spot universe
  const url = `https://api.bitget.com/api/spot/v1/market/depth?symbol=${encodeURIComponent(symbol)}USDT&limit=50`;
  const r = await fetch(url, { headers: { accept: "application/json" } });
  const j = await r.json();
  return j?.data || null;
}

function sumDepth(levels, mid, pct, isBid) {
  const limit = isBid ? mid * (1 - pct) : mid * (1 + pct);
  let total = 0;
  let biggest = 0;

  for (const [price, size] of levels) {
    const p = Number(price);
    const s = Number(size);
    if (!Number.isFinite(p) || !Number.isFinite(s)) continue;

    if (isBid && p < limit) break;
    if (!isBid && p > limit) break;

    const usd = p * s;
    total += usd;
    if (usd > biggest) biggest = usd;
  }
  return { total, biggest };
}

function computeOb(depth) {
  const bids = depth?.bids || [];
  const asks = depth?.asks || [];
  if (!bids.length || !asks.length) return null;

  const bid = Number(bids[0][0]);
  const ask = Number(asks[0][0]);
  if (!(bid > 0) || !(ask > 0)) return null;

  const mid = (bid + ask) / 2;
  const spreadPct = ((ask - bid) / mid) * 100;

  const pct = 0.002; // 0.2% depth
  const bidRes = sumDepth(bids, mid, pct, true);
  const askRes = sumDepth(asks, mid, pct, false);

  const bidUsd = bidRes.total;
  const askUsd = askRes.total;

  const denom = bidUsd + askUsd;
  const score = denom > 0 ? (bidUsd - askUsd) / denom : 0;

  const biggest = Math.max(bidRes.biggest, askRes.biggest);
  const lor = denom > 0 ? biggest / denom : 1;

  return { ts: Date.now(), mid, spreadPct, bidUsd, askUsd, score, lor };
}

function directionOk(mode, score) {
  return mode === "bull" ? score > 0 : score < 0;
}

function validateSamples(mode, samples) {
  const winMs = SETTINGS.entry.samplesWindowSec * 1000;
  const now = Date.now();
  const fresh = (samples || []).filter((s) => now - s.ts <= winMs);

  if (fresh.length < SETTINGS.entry.samplesNeed) {
    return { valid: false, reason: "Not enough samples", fresh };
  }

  const last3 = fresh.slice(-SETTINGS.entry.samplesNeed);
  const agree = last3.filter((s) => directionOk(mode, s.score)).length;

  if (agree < SETTINGS.entry.minAgree) {
    return { valid: false, reason: "Direction not consistent", fresh: last3 };
  }

  const avgScore = last3.reduce((a, s) => a + s.score, 0) / last3.length;
  return { valid: true, reason: "OK", fresh: last3, avgScore, agree };
}

export default async function handler(req, res) {
  try {
    // bescherming: ob-sampler ook via secret
    if (!requireSecret(req, res)) return;

    // pak latest bull/bear en kies kandidaten: top ALMOST + BUILDUP
    const bull = await kv.get(keyLatest("bull"));
    const bear = await kv.get(keyLatest("bear"));

    const tasks = [];

    if (bull?.funnel) tasks.push({ mode: "bull", data: bull });
    if (bear?.funnel) tasks.push({ mode: "bear", data: bear });

    let totalProcessed = 0;

    for (const t of tasks) {
      const mode = t.mode;
      const sideKey = mode; // bull/bear

      const almost = (t.data?.funnel?.almost || []).slice(0, SETTINGS.obPickAlmost);
      const buildup = (t.data?.funnel?.buildup || []).slice(0, SETTINGS.obPickBuildup);

      const candidates = [...almost, ...buildup];

      for (const c of candidates) {
        const symbol = c.symbol;
        const depth = await fetchBitgetDepth(symbol);
        const ob = depth ? computeOb(depth) : null;
        if (!ob) continue;

        // store samples
        const kS = keyObSamples(sideKey, symbol);
        const prev = (await kv.get(kS)) || [];
        const next = Array.isArray(prev) ? prev.slice(-10) : [];
        next.push(ob);
        await kv.set(kS, next);

        // validate
        const v = validateSamples(mode, next);
        const stale = (Date.now() - ob.ts) / 1000 > 15;

        await kv.set(keyObResult(sideKey, symbol), {
          symbol,
          side: sideKey,
          valid: v.valid,
          reason: v.reason,
          avgScore: v.avgScore ?? null,
          agree: v.agree ?? null,
          ob: { ...ob },
          stale
        });

        totalProcessed++;
      }
    }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, ts: Date.now(), totalProcessed }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e) }));
  }
}