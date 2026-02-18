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

// ================== BINANCE DEPTH (SPOT) ==================
// We proberen meerdere endpoints, omdat api.binance.com soms blokkeert op Vercel.
const BINANCE_BASES = [
  "https://api.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com",
  "https://api3.binance.com",
  "https://data-api.binance.vision",
];

async function fetchJsonBestEffort(url) {
  const r = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "user-agent": "CryptoCrocScanner/1.0 (+vercel)",
    },
  });

  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}

  return {
    ok: r.ok && !!json,
    status: r.status,
    contentType: (r.headers.get("content-type") || "").toLowerCase(),
    textPreview: text.slice(0, 240),
    json,
  };
}

async function fetchBinanceDepth(symbolUpper, limit = 100) {
  const base = String(symbolUpper || "").toUpperCase().trim();
  if (!base) return { ok: false, reason: "Missing symbol" };

  const pair = `${base}USDT`;
  const lim = Math.max(5, Math.min(1000, Number(limit) || 100));

  let lastErr = null;

  for (const baseUrl of BINANCE_BASES) {
    const url = `${baseUrl}/api/v3/depth?symbol=${encodeURIComponent(pair)}&limit=${encodeURIComponent(String(lim))}`;
    const r = await fetchJsonBestEffort(url);

    if (r.ok && r.json?.bids?.length && r.json?.asks?.length) {
      return { ok: true, url, pair, depth: r.json };
    }

    // Binance geeft vaak JSON error zoals: {"code":-1121,"msg":"Invalid symbol."}
    const msg = r.json?.msg || r.json?.message || null;

    lastErr = {
      ok: false,
      url,
      pair,
      status: r.status,
      msg: msg || null,
      preview: r.textPreview,
      contentType: r.contentType,
    };

    // Als het “Invalid symbol” is: dan heeft verder proberen geen zin
    if (String(msg || "").toLowerCase().includes("invalid symbol")) {
      break;
    }
  }

  return lastErr || { ok: false, reason: "Unknown depth error" };
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

  const pct = 0.002; // 0.2% band
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

  return { ts: Date.now(), score, spreadPct, lor, bidUsd, askUsd, mid, depthMinUsd1p };
}

function pruneSamples(samples) {
  const now = Date.now();
  const winMs = SETTINGS.entry.samplesWindowSec * 1000;

  const arr = Array.isArray(samples) ? samples : [];
  return arr
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
    .sort((a, b) => a.ts - b.ts)
    .slice(-20);
}

function validateSamples(mode, samples) {
  if (samples.length < SETTINGS.entry.samplesNeed) {
    return { valid: false, reason: "Not enough samples" };
  }

  const lastN = samples.slice(-SETTINGS.entry.samplesNeed);
  const agree = lastN.filter((s) => (mode === "bull" ? s.score > 0 : s.score < 0)).length;

  if (agree < SETTINGS.entry.minAgree) {
    return { valid: false, reason: "Direction not consistent", agree };
  }

  const avgScore = lastN.reduce((a, s) => a + s.score, 0) / lastN.length;
  return { valid: true, reason: "OK", avgScore, agree };
}

async function processCandidate(mode, symbol) {
  const depthRes = await fetchBinanceDepth(symbol, 100);

  if (!depthRes?.ok) {
    return {
      ok: false,
      symbol,
      fail: {
        status: depthRes?.status ?? null,
        msg: depthRes?.msg ?? null,
        url: depthRes?.url ?? null,
        preview: depthRes?.preview ?? null,
      },
    };
  }

  const sample = computeObSample(depthRes.depth);
  if (!sample) {
    return {
      ok: false,
      symbol,
      fail: {
        status: 200,
        msg: "Depth JSON ok but sample compute failed",
        url: depthRes.url,
        preview: null,
      },
    };
  }

  const kSamples = keyObSamples(mode, symbol);
  const prev = (await kv.get(kSamples)) || [];
  const merged = Array.isArray(prev) ? prev.concat([sample]) : [sample];
  const pruned = pruneSamples(merged);

  await kv.set(kSamples, pruned);

  const v = validateSamples(mode, pruned);

  const result = {
    symbol,
    side: mode,
    valid: v.valid,
    reason: v.reason,
    stale: false,

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

  return { ok: true, symbol, valid: v.valid };
}

function pickCandidatesFromLatest(latest) {
  const almost = (latest?.funnel?.almost || []).slice(0, SETTINGS.obPickAlmost);
  const buildup = (latest?.funnel?.buildup || []).slice(0, SETTINGS.obPickBuildup);

  let picked = [...almost, ...buildup];

  // fallback: als almost/buildup leeg zijn -> pak radar top 20
  if (!picked.length) {
    const radar = (latest?.funnel?.radar || []).slice(0, 20);
    picked = radar;
  }

  return picked.map((x) => String(x?.symbol || "").toUpperCase()).filter(Boolean);
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

    let totalTried = 0;
    let totalProcessed = 0;
    let totalValid = 0;
    let failed = 0;

    const failedDetails = [];

    for (const sym of candidates) {
      totalTried++;
      const r = await processCandidate(mode, sym);

      if (r?.ok) {
        totalProcessed++;
        if (r.valid) totalValid++;
      } else {
        failed++;
        if (failedDetails.length < 12) {
          failedDetails.push({ symbol: sym, ...r.fail });
        }
      }
    }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    return res.end(
      JSON.stringify({
        ok: true,
        mode,
        ts: Date.now(),
        candidates,
        totalTried,
        totalProcessed,
        totalValid,
        failed,
        failedDetails,
      })
    );
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}