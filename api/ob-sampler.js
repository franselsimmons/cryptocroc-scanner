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
async function fetchBinanceDepth(baseSymbol, limit = 200) {
  const base = String(baseSymbol || "").toUpperCase();
  if (!base) return null;

  const pair = `${base}USDT`;
  const safeLimit = Math.max(5, Math.min(1000, Number(limit) || 200));

  const url = `https://api.binance.com/api/v3/depth?symbol=${encodeURIComponent(
    pair
  )}&limit=${encodeURIComponent(String(safeLimit))}`;

  const r = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "CryptoCrocScanner/1.0 (+vercel)",
    },
  });

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

    // Binance bids/asks zijn normaal al “best to worst”.
    // We gebruiken break zodra we buiten de band vallen.
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

  // score = imbalance binnen 0.2%
  const pct = 0.002; // 0.2%
  const bidRes = sumDepth(bids, mid, pct, true);
  const askRes = sumDepth(asks, mid, pct, false);

  const bidUsd = bidRes.total;
  const askUsd = askRes.total;

  const denom = bidUsd + askUsd;
  const score = denom > 0 ? (bidUsd - askUsd) / denom : 0;

  const biggest = Math.max(bidRes.biggest, askRes.biggest);
  const lor = denom > 0 ? biggest / denom : 1;

  // liquiditeit binnen 1% (floor check)
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
      depthMinUsd1p: Number(s?.depthMinUsd1p ?? 0),
    }))
    .filter((s) => s.ts > 0 && Number.isFinite(s.score))
    .filter((s) => now - s.ts <= winMs)
    .sort((a, b) => a.ts - b.ts);

  return fresh.slice(-20);
}

function validateSamples(mode, samples) {
  const fresh = pruneSamples(samples);

  if (fresh.length < SETTINGS.entry.samplesNeed) {
    return { valid: false, reason: "Not enough samples", freshCount: fresh.length };
  }

  const lastN = fresh.slice(-SETTINGS.entry.samplesNeed);

  const agree = lastN.filter((s) => (mode === "bull" ? s.score > 0 : s.score < 0)).length;
  if (agree < SETTINGS.entry.minAgree) {
    return { valid: false, reason: "Direction not consistent", agree };
  }

  const avgScore = lastN.reduce((a, s) => a + s.score, 0) / lastN.length;

  return { valid: true, reason: "OK", avgScore, agree };
}

async function processCandidate(mode, symbolUpper) {
  const symbol = String(symbolUpper || "").toUpperCase();
  if (!symbol) return { tried: false, ok: false, symbol: "", reason: "missing symbol" };

  const depth = await fetchBinanceDepth(symbol, 200);
  const sample = depth ? computeObSample(depth) : null;

  if (!sample) return { tried: true, ok: false, symbol, reason: "no depth" };

  const kSamples = keyObSamples(mode, symbol);
  const prev = (await kv.get(kSamples)) || [];
  const merged = Array.isArray(prev) ? prev.concat([sample]) : [sample];
  const pruned = pruneSamples(merged);

  await kv.set(kSamples, pruned);

  const v = validateSamples(mode, pruned);
  const stale = (Date.now() - sample.ts) / 1000 > 15;

  const result = {
    symbol,
    side: mode,
    valid: v.valid,
    reason: v.reason,
    stale,

    score: sample.score,
    spreadPct: sample.spreadPct,
    lor: sample.lor,
    depthMinUsd1p: sample.depthMinUsd1p,
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
      depthMinUsd1p: sample.depthMinUsd1p,
    },

    ts: Date.now(),
  };

  await kv.set(keyObResult(mode, symbol), result);

  return { tried: true, ok: true, symbol, valid: v.valid };
}

function pickCandidatesFromLatest(latest) {
  const almost = (latest?.funnel?.almost || []).slice(0, SETTINGS.obPickAlmost);
  const buildup = (latest?.funnel?.buildup || []).slice(0, SETTINGS.obPickBuildup);

  let picked = [...almost, ...buildup];

  // ✅ fallback: als buildup/almost leeg zijn → pak radar top N
  if (!picked.length) {
    const n = Number(SETTINGS.obPickRadarFallback || 20);
    const radar = (latest?.funnel?.radar || []).slice(0, n);
    picked = radar;
  }

  return picked
    .map((x) => String(x?.symbol || "").toUpperCase())
    .filter(Boolean);
}

async function runBatched(list, batchSize, fn) {
  const out = [];
  for (let i = 0; i < list.length; i += batchSize) {
    const chunk = list.slice(i, i + batchSize);
    const results = await Promise.allSettled(chunk.map(fn));
    for (const r of results) {
      if (r.status === "fulfilled") out.push(r.value);
      else out.push({ tried: true, ok: false, reason: String(r.reason || "rejected") });
    }
  }
  return out;
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const mode = String(req.query?.mode || "bull").toLowerCase();
    if (mode !== "bull" && mode !== "bear") {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "mode must be bull/bear" }));
    }

    const latest = await kv.get(keyLatest(mode));
    const candidates = pickCandidatesFromLatest(latest);

    if (!candidates.length) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ok: true, mode, totalTried: 0, totalProcessed: 0, totalValid: 0, failed: 0 }));
    }

    // batch parallel
    const results = await runBatched(candidates, 6, (sym) => processCandidate(mode, sym));

    let totalTried = 0;
    let totalProcessed = 0;
    let totalValid = 0;
    let failed = 0;

    for (const r of results) {
      if (r?.tried) totalTried++;
      if (r?.ok) {
        totalProcessed++;
        if (r.valid) totalValid++;
      } else {
        failed++;
      }
    }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        ok: true,
        mode,
        ts: Date.now(),
        candidates: candidates.slice(0, 25), // klein debug lijstje
        totalTried,
        totalProcessed,
        totalValid,
        failed,
      })
    );
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}