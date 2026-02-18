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

// ================== BINANCE DEPTH ==================
async function fetchBinanceDepth(symbolUpper) {
  const base = String(symbolUpper || "").toUpperCase();
  if (!base) return null;

  const pair = `${base}USDT`;
  const url = `https://api.binance.com/api/v3/depth?symbol=${pair}&limit=100`;

  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) return null;

  const j = await r.json();
  if (!j?.bids?.length || !j?.asks?.length) return null;

  return j;
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

  const bid = Number(bids[0][0]);
  const ask = Number(asks[0][0]);
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

  const bid1 = sumDepth(bids, mid, 0.01, true);
  const ask1 = sumDepth(asks, mid, 0.01, false);
  const depthMinUsd1p = Math.min(bid1.total, ask1.total);

  return {
    ts: Date.now(),
    score,
    spreadPct,
    lor,
    bidUsd,
    askUsd,
    mid,
    depthMinUsd1p,
  };
}

function pruneSamples(samples) {
  const now = Date.now();
  const winMs = SETTINGS.entry.samplesWindowSec * 1000;

  return (samples || [])
    .filter(s => now - s.ts <= winMs)
    .slice(-20);
}

function validateSamples(mode, samples) {
  if (samples.length < SETTINGS.entry.samplesNeed) {
    return { valid: false, reason: "Not enough samples" };
  }

  const lastN = samples.slice(-SETTINGS.entry.samplesNeed);
  const agree = lastN.filter(s =>
    mode === "bull" ? s.score > 0 : s.score < 0
  ).length;

  if (agree < SETTINGS.entry.minAgree) {
    return { valid: false, reason: "Direction not consistent", agree };
  }

  const avgScore = lastN.reduce((a, s) => a + s.score, 0) / lastN.length;

  return { valid: true, avgScore, agree };
}

async function processCandidate(mode, symbol) {
  const depth = await fetchBinanceDepth(symbol);
  const sample = depth ? computeObSample(depth) : null;
  if (!sample) return { ok: false };

  const kSamples = keyObSamples(mode, symbol);
  const prev = (await kv.get(kSamples)) || [];
  const merged = [...prev, sample];
  const pruned = pruneSamples(merged);

  await kv.set(kSamples, pruned);

  const v = validateSamples(mode, pruned);

  const result = {
    symbol,
    side: mode,
    valid: v.valid,
    score: sample.score,
    spreadPct: sample.spreadPct,
    lor: sample.lor,
    depthMinUsd1p: sample.depthMinUsd1p,
    avgScore: v.avgScore ?? null,
    agree: v.agree ?? null,
    ts: Date.now(),
  };

  await kv.set(keyObResult(mode, symbol), result);

  return { ok: true, valid: v.valid };
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const mode = String(req.query?.mode || "bull").toLowerCase();
    const latest = await kv.get(keyLatest(mode));
    if (!latest?.funnel) {
      return res.end(JSON.stringify({ ok: true, totalTried: 0 }));
    }

    const candidates = [
      ...(latest.funnel.almost || []).slice(0, SETTINGS.obPickAlmost),
      ...(latest.funnel.buildup || []).slice(0, SETTINGS.obPickBuildup),
    ].map(x => x.symbol);

    let totalProcessed = 0;
    let totalValid = 0;

    for (const sym of candidates) {
      const r = await processCandidate(mode, sym);
      if (r.ok) {
        totalProcessed++;
        if (r.valid) totalValid++;
      }
    }

    res.end(JSON.stringify({
      ok: true,
      totalProcessed,
      totalValid
    }));

  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok:false, error:String(e) }));
  }
}