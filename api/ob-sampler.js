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

// ================== BITGET DEPTH ==================
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
    const price = row?.[0];
    const size = row?.[1];

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

function computeObSample(depth) {
  const bids = depth?.bids || [];
  const asks = depth?.asks || [];
  if (!bids.length || !asks.length) return null;

  const bid = Number(bids[0]?.[0]);
  const ask = Number(asks[0]?.[0]);
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

  return {
    ts: Date.now(),
    score,          // <-- scan gebruikt dit voor gate + slope
    spreadPct,
    lor,
    bidUsd,
    askUsd,
    mid,
  };
}

// ================== VALIDATION ==================
function directionOk(mode, score) {
  return mode === "bull" ? score > 0 : score < 0;
}

function pruneSamples(samples) {
  const now = Date.now();
  const winMs = SETTINGS.entry.samplesWindowSec * 1000;

  const arr = Array.isArray(samples) ? samples : [];
  const fresh = arr
    .map((s) => ({
      ts: Number(s?.ts || 0),
      score: Number(s?.score ?? s?.obScore ?? s?.avgScore ?? 0),
      spreadPct: Number(s?.spreadPct ?? 999),
      lor: Number(s?.lor ?? 1),
      bidUsd: Number(s?.bidUsd ?? 0),
      askUsd: Number(s?.askUsd ?? 0),
      mid: Number(s?.mid ?? 0),
    }))
    .filter((s) => s.ts > 0 && Number.isFinite(s.score))
    .filter((s) => now - s.ts <= winMs)
    .sort((a, b) => a.ts - b.ts);

  // hard cap: hou max 20 samples
  return fresh.slice(-20);
}

function validateSamples(mode, samplesFresh) {
  const fresh = pruneSamples(samplesFresh);

  if (fresh.length < SETTINGS.entry.samplesNeed) {
    return { valid: false, reason: "Not enough samples", fresh };
  }

  const lastN = fresh.slice(-SETTINGS.entry.samplesNeed);
  const agree = lastN.filter((s) => directionOk(mode, s.score)).length;

  if (agree < SETTINGS.entry.minAgree) {
    return { valid: false, reason: "Direction not consistent", fresh: lastN, agree };
  }

  const avgScore = lastN.reduce((a, s) => a + s.score, 0) / lastN.length;
  return { valid: true, reason: "OK", fresh: lastN, avgScore, agree };
}

// ================== MAIN ==================
async function processCandidate(mode, symbol) {
  const depth = await fetchBitgetDepth(symbol);
  const sample = depth ? computeObSample(depth) : null;
  if (!sample) return { ok: false, symbol, reason: "no depth" };

  const kS = keyObSamples(mode, symbol);
  const prev = (await kv.get(kS)) || [];
  const merged = Array.isArray(prev) ? prev.concat([sample]) : [sample];

  // prune op window + hardcap
  const pruned = pruneSamples(merged);
  await kv.set(kS, pruned);

  // validate
  const v = validateSamples(mode, pruned);

  // stale = sample ouder dan 15s (meestal false)
  const stale = (Date.now() - sample.ts) / 1000 > 15;

  // schrijf result — scan leest dit
  await kv.set(keyObResult(mode, symbol), {
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

// simpele batch-runner zodat je niet 50 fetches tegelijk doet
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

    const bull = await kv.get(keyLatest("bull"));
    const bear = await kv.get(keyLatest("bear"));

    const tasks = [];
    if (bull?.funnel) tasks.push({ mode: "bull", data: bull });
    if (bear?.funnel) tasks.push({ mode: "bear", data: bear });

    let totalProcessed = 0;
    let totalValid = 0;

    for (const t of tasks) {
      const mode = t.mode;

      const almost = (t.data?.funnel?.almost || []).slice(0, SETTINGS.obPickAlmost);
      const buildup = (t.data?.funnel?.buildup || []).slice(0, SETTINGS.obPickBuildup);

      const candidates = [...almost, ...buildup]
        .map((x) => String(x?.symbol || "").toUpperCase())
        .filter(Boolean);

      // batchSize 6 is safe voor Vercel + Bitget
      const results = await runBatched(
        candidates,
        6,
        (sym) => processCandidate(mode, sym)
      );

      for (const r of results) {
        if (r?.ok) {
          totalProcessed++;
          if (r.valid) totalValid++;
        }
      }
    }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      ok: true,
      ts: Date.now(),
      totalProcessed,
      totalValid
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e) }));
  }
}