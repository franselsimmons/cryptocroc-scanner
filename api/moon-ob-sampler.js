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

// ============================
// Bitget depth fetch
// ============================
async function fetchBitgetDepth(symbolUpper) {
  const base = String(symbolUpper || "").toUpperCase();
  if (!base) return null;

  // Bitget spot depth endpoint (legacy v1)
  const sym = `${base}USDT_SPBL`;
  const url = `https://api.bitget.com/api/spot/v1/market/depth?symbol=${encodeURIComponent(sym)}&limit=50`;

  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) return null;

  const j = await r.json();
  const d = j?.data || null;
  if (!d?.bids?.length || !d?.asks?.length) return null;
  return d;
}

// ============================
// Helpers: depth math
// ============================
function sumDepth(levels, mid, pct, isBid) {
  const limit = isBid ? mid * (1 - pct) : mid * (1 + pct);
  let total = 0;
  let biggest = 0;

  for (const row of levels) {
    const p = Number(row?.[0]);
    const s = Number(row?.[1]);
    if (!Number.isFinite(p) || !Number.isFinite(s)) continue;

    // bids dalen, asks stijgen (Bitget levert meestal sorted)
    if (isBid && p < limit) break;
    if (!isBid && p > limit) break;

    const usd = p * s;
    total += usd;
    if (usd > biggest) biggest = usd;
  }
  return { total, biggest };
}

// Sample bevat genoeg info om later rolling trend + stability te meten
function computeObSample(depth) {
  const bids = depth?.bids || [];
  const asks = depth?.asks || [];
  if (!bids.length || !asks.length) return null;

  const bid = Number(bids[0]?.[0]);
  const ask = Number(asks[0]?.[0]);
  if (!(bid > 0) || !(ask > 0)) return null;

  const mid = (bid + ask) / 2;
  const spreadPct = ((ask - bid) / mid) * 100;

  // 0.2% band (micro depth)
  const pct = 0.002;
  const bidRes = sumDepth(bids, mid, pct, true);
  const askRes = sumDepth(asks, mid, pct, false);

  const bidUsd = bidRes.total;
  const askUsd = askRes.total;

  const denom = bidUsd + askUsd;
  const score = denom > 0 ? (bidUsd - askUsd) / denom : 0; // -1..+1

  const biggest = Math.max(bidRes.biggest, askRes.biggest);
  const lor = denom > 0 ? biggest / denom : 1; // largest order ratio (spoof hint)

  // 1% band depth (robust floor)
  const bid1 = sumDepth(bids, mid, 0.01, true);
  const ask1 = sumDepth(asks, mid, 0.01, false);
  const depthMinUsd1p = Math.min(bid1.total, ask1.total);

  return { ts: Date.now(), score, spreadPct, lor, bidUsd, askUsd, mid, depthMinUsd1p };
}

function directionOk(mode, score) {
  return mode === "bull" ? score > 0 : score < 0;
}

// ============================
// Rolling window + metrics
// ============================
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
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
      depthMinUsd1p: Number(s?.depthMinUsd1p ?? 0),
    }))
    .filter((s) => s.ts > 0 && Number.isFinite(s.score))
    .filter((s) => now - s.ts <= winMs)
    .sort((a, b) => a.ts - b.ts);

  // compact houden
  return fresh.slice(-30);
}

// Simple slope over last N (average per step)
function calcSlope(lastN) {
  if (!Array.isArray(lastN) || lastN.length < 2) return 0;
  const first = lastN[0].score;
  const last = lastN[lastN.length - 1].score;
  const steps = lastN.length - 1;
  return steps > 0 ? (last - first) / steps : 0;
}

// Stability = hoe “wild” was score? (std-ish, maar simpel)
function calcStability(lastN) {
  if (!Array.isArray(lastN) || lastN.length < 2) return { std: 0, ok: true };
  const scores = lastN.map((s) => Number(s.score || 0));
  const mean = scores.reduce((a, x) => a + x, 0) / scores.length;
  const varr = scores.reduce((a, x) => a + (x - mean) * (x - mean), 0) / scores.length;
  const std = Math.sqrt(varr);

  // crypto: 0.00..0.20 realistisch; spoofing vaak “spiky”
  const ok = std <= 0.12;
  return { std, ok };
}

// Rolling validation = consensus + slope + stability + spread/lor sanity
function validateSamples(mode, samplesFresh) {
  const freshAll = pruneSamples(samplesFresh);

  // minimum samples voor beslissing
  const need = Number(MOON?.elite?.samplesNeed || 3);
  if (freshAll.length < need) {
    return {
      valid: false,
      reason: "Not enough samples",
      agree: 0,
      avgScore: null,
      slope: 0,
      stabilityStd: null,
      stable: false,
      fresh: freshAll,
      windowN: need,
    };
  }

  const lastN = freshAll.slice(-need);

  // direction agreement
  const agree = lastN.filter((s) => directionOk(mode, s.score)).length;
  if (agree < Number(MOON?.elite?.minAgree || 2)) {
    const avgScore = lastN.reduce((a, s) => a + s.score, 0) / lastN.length;
    const slope = calcSlope(lastN);
    const stab = calcStability(lastN);
    return {
      valid: false,
      reason: "Direction not consistent",
      agree,
      avgScore,
      slope,
      stabilityStd: stab.std,
      stable: stab.ok,
      fresh: lastN,
      windowN: need,
    };
  }

  // average score
  const avgScore = lastN.reduce((a, s) => a + s.score, 0) / lastN.length;

  // slope check (rolling) — default: >0 for bull, <0 for bear
  const slope = calcSlope(lastN);
  let slopeOk = true;
  if (MOON?.elite?.obSlopeEnabled) {
    if (mode === "bull") slopeOk = slope >= Number(MOON?.elite?.obSlopeMinBull ?? 0);
    else slopeOk = slope <= Number(MOON?.elite?.obSlopeMaxBear ?? 0);
  }

  // stability check
  const stab = calcStability(lastN);
  const stableOk = stab.ok;

  // spread/lor sanity (rolling: pak laatste sample)
  const last = lastN[lastN.length - 1];
  const spreadOk = Number(last.spreadPct || 999) <= Number(MOON?.elite?.spreadMaxPct ?? 0.7);
  const lorOk = Number(last.lor || 1) <= Number(MOON?.elite?.largestOrderRatioMax ?? 0.4);

  const valid = !!(agree >= (MOON?.elite?.minAgree || 2) && slopeOk && stableOk && spreadOk && lorOk);

  // reason text
  let reason = "OK";
  if (!slopeOk) reason = "Slope not ok";
  else if (!stableOk) reason = "OB too spiky (stability fail)";
  else if (!spreadOk) reason = "Spread too wide";
  else if (!lorOk) reason = "Largest order suspicious";

  return {
    valid,
    reason,
    agree,
    avgScore,
    slope,
    stabilityStd: stab.std,
    stable: stableOk,
    fresh: lastN,
    windowN: need,
  };
}

// ============================
// Candidate processing
// ============================
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

  // stale check = sample zelf te oud (moet “vers” zijn)
  const stale = (Date.now() - sample.ts) / 1000 > 15;

  // Result is wat moon-scan leest als obView
  await kv.set(keyMoonObResult(mode, symbol), {
    symbol,
    side: mode,
    valid: v.valid,
    reason: v.reason,

    // rolling metrics
    avgScore: v.avgScore ?? null,
    agree: v.agree ?? null,
    slope: v.slope ?? 0,
    stable: !!v.stable,
    stabilityStd: v.stabilityStd ?? null,
    windowN: v.windowN ?? null,

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
    stale,
  });

  return { ok: true, symbol, valid: v.valid, reason: v.reason };
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

// unique list helper
function uniqSymbols(arr) {
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    const x = String(s || "").toUpperCase().trim();
    if (!x) continue;
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const bull = await kv.get(keyMoonLatest("bull"));
    const bear = await kv.get(keyMoonLatest("bear"));

    const tasks = [];
    if (bull?.funnel) tasks.push({ mode: "bull", data: bull });
    if (bear?.funnel) tasks.push({ mode: "bear", data: bear });

    // Beter: ook radar top meepakken, anders krijg je “OB komt nooit op gang”
    // We pakken: elite+almost+buildup + top radar (op volAcc/conf) zodat rolling sneller “warm” wordt.
    let totalTried = 0;
    let totalOk = 0;
    let totalValid = 0;
    const sampleErrors = [];

    for (const t of tasks) {
      const mode = t.mode;

      const elite  = (t.data?.funnel?.elite  || []).slice(0, 8);
      const almost = (t.data?.funnel?.almost || []).slice(0, 14);
      const buildup= (t.data?.funnel?.buildup|| []).slice(0, 12);
      const radar  = (t.data?.funnel?.radar  || []).slice(0, 18);

      // candidates pool
      const candidates = uniqSymbols([
        ...elite.map((x) => x?.symbol),
        ...almost.map((x) => x?.symbol),
        ...buildup.map((x) => x?.symbol),
        ...radar.map((x) => x?.symbol),
      ]);

      totalTried += candidates.length;

      // batchSize: let op Vercel + Bitget; 6 is safe
      const results = await runBatched(candidates, 6, (sym) => processCandidate(mode, sym));

      for (const r of results) {
        if (r?.ok) {
          totalOk++;
          if (r.valid) totalValid++;
        } else if (r?.symbol) {
          sampleErrors.push({ symbol: r.symbol, reason: r.reason || "unknown" });
        }
      }
    }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        ok: true,
        ts: Date.now(),
        totalTried,
        totalOk,
        totalValid,
        note:
          "Rolling OB: consensus + slope + stability + spread + LOR. Also warms up from RADAR so OB can start building early.",
        sampleErrors,
      })
    );
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e) }));
  }
}