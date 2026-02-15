// /api/moon-ob-sampler.js
import { kv } from "@vercel/kv";
import {
  RUNTIME_CONFIG,
  requireSecret,
  MOON,
  keyMoonLatest,
  keyMoonObSamples,
  keyMoonObResult,
} from "./_moon_core.js";

export const config = RUNTIME_CONFIG;

// Bitget depth (spot)
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

// OB sample binnen 0.2% (zelfde band als score)
function computeObSample(depth) {
  const bids = depth?.bids || [];
  const asks = depth?.asks || [];
  if (!bids.length || !asks.length) return null;

  const bid = Number(bids[0]?.[0]);
  const ask = Number(asks[0]?.[0]);
  if (!(bid > 0) || !(ask > 0)) return null;

  const mid = (bid + ask) / 2;
  const spreadPct = ((ask - bid) / mid) * 100;

  const pct = 0.002; // 0.2%
  const bidRes = sumDepth(bids, mid, pct, true);
  const askRes = sumDepth(asks, mid, pct, false);

  const bidUsd = bidRes.total;
  const askUsd = askRes.total;

  const denom = bidUsd + askUsd;
  const score = denom > 0 ? (bidUsd - askUsd) / denom : 0;

  const biggest = Math.max(bidRes.biggest, askRes.biggest);
  const lor = denom > 0 ? biggest / denom : 1;

  return {
    ts: Date.now(),
    score,
    spreadPct,
    lor,
    bidUsd,
    askUsd,
    mid,
  };
}

function directionOk(mode, score) {
  return mode === "bull" ? score > 0 : score < 0;
}

function pruneSamples(samples) {
  const now = Date.now();
  const winMs = MOON.elite.samplesWindowSec * 1000;

  const arr = Array.isArray(samples) ? samples : [];
  const fresh = arr
    .map((s) => ({
      ts: Number(s?.ts || 0),
      score: Number(s?.score ?? 0),
      spreadPct: Number(s?.spreadPct ?? 999),
      lor: Number(s?.lor ?? 1),
      bidUsd: Number(s?.bidUsd ?? 0),
      askUsd: Number(s?.askUsd ?? 0),
      mid: Number(s?.mid ?? 0),
    }))
    .filter((s) => s.ts > 0 && Number.isFinite(s.score))
    .filter((s) => now - s.ts <= winMs)
    .sort((a, b) => a.ts - b.ts);

  return fresh.slice(-20);
}

function validateSamples(mode, samplesFresh) {
  const fresh = pruneSamples(samplesFresh);
  if (fresh.length < MOON.elite.samplesNeed) {
    return { valid: false, reason: "Not enough samples", fresh };
  }

  const lastN = fresh.slice(-MOON.elite.samplesNeed);
  const agree = lastN.filter((s) => directionOk(mode, s.score)).length;

  if (agree < MOON.elite.minAgree) {
    return { valid: false, reason: "Direction not consistent", fresh: lastN, agree };
  }

  const avgScore = lastN.reduce((a, s) => a + s.score, 0) / lastN.length;
  return { valid: true, reason: "OK", fresh: lastN, avgScore, agree };
}

async function processCandidate(mode, symbol) {
  const depth = await fetchBitgetDepth(symbol);
  const sample = depth ? computeObSample(depth) : null;
  if (!sample) return { ok: false, symbol, reason: "no depth" };

  const kS = keyMoonObSamples(mode, symbol);
  const prev = (await kv.get(kS)) || [];
  const merged = Array.isArray(prev) ? prev.concat([sample]) : [sample];

  const pruned = pruneSamples(merged);
  await kv.set(kS, pruned);

  const v = validateSamples(mode, pruned);
  const stale = (Date.now() - sample.ts) / 1000 > 15;

  await kv.set(keyMoonObResult(mode, symbol), {
    symbol,
    side: mode,
    valid: v.valid,
    reason: v.reason,
    avgScore: v.avgScore ?? null,
    agree: v.agree ?? null,
    ob: {
      ts: sample.ts,
      mid: sample.mid,
      spreadPct: sample.spreadPct,
      bidUsd: sample.bidUsd,
      askUsd: sample.askUsd,
      score: sample.score,
      lor: sample.lor,
    },
    stale,
  });

  return { ok: true, symbol, valid: v.valid };
}

async function runBatched(list, batchSize, fn) {
  const out = [];
  for (let i = 0; i < list.length; i += batchSize) {
    const chunk = list.slice(i, i + batchSize);
    const results = await Promise.allSettled(chunk.map(fn));
    for (const r of results) {
      if (r.status === "fulfilled") out.push(r.value);
      else out.push({ ok: false, reason: String(r.reason || "rejected") });
    }
  }
  return out;
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    // Kandidaten komen uit moon latest
    const bull = await kv.get(keyMoonLatest("bull"));
    const bear = await kv.get(keyMoonLatest("bear"));

    const tasks = [];
    if (bull?.funnel) tasks.push({ mode: "bull", data: bull });
    if (bear?.funnel) tasks.push({ mode: "bear", data: bear });

    let totalProcessed = 0;
    let totalValid = 0;

    for (const t of tasks) {
      const mode = t.mode;

      // We samplen OB vooral voor ALMOST + top BUILDUP
      const almost = (t.data?.funnel?.almost || []).slice(0, 14);
      const buildup = (t.data?.funnel?.buildup || []).slice(0, 10);

      const candidates = [...almost, ...buildup]
        .map((x) => String(x?.symbol || "").toUpperCase())
        .filter(Boolean);

      const results = await runBatched(candidates, 6, (sym) => processCandidate(mode, sym));

      for (const r of results) {
        if (r?.ok) {
          totalProcessed++;
          if (r.valid) totalValid++;
        }
      }
    }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, ts: Date.now(), totalProcessed, totalValid }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e) }));
  }
}
