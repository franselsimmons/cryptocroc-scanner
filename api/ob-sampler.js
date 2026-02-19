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

// ================== BITGET V2 ORDERBOOK (SPOT) ==================
// Docs: GET /api/v2/spot/market/orderbook?symbol=BTCUSDT&type=step0&limit=100   [oai_citation:1‡Bitget](https://www.bitget.com/api-doc/spot/market/Get-Orderbook)
async function fetchBitgetOrderbookRaw(baseSymbol, limit = 100) {
  const base = String(baseSymbol || "").toUpperCase();
  if (!base) return { ok: false, status: 400, msg: "Missing symbol" };

  const pair = `${base}USDT`;
  const safeLimit = Math.max(5, Math.min(150, Number(limit) || 100)); // max 150  [oai_citation:2‡Bitget](https://www.bitget.com/api-doc/spot/market/Get-Orderbook)
  const type = "step0";

  const url =
    `https://api.bitget.com/api/v2/spot/market/orderbook?` +
    `symbol=${encodeURIComponent(pair)}&type=${encodeURIComponent(type)}&limit=${encodeURIComponent(String(safeLimit))}`;

  const r = await fetch(url, { headers: { accept: "application/json" } });
  const text = await r.text();

  let j = null;
  try { j = JSON.parse(text); } catch {}

  if (!r.ok) {
    return {
      ok: false,
      status: r.status,
      msg: j?.msg || "Bitget orderbook failed",
      url,
      preview: text.slice(0, 200),
    };
  }

  // Bitget success code = "00000"
  if (String(j?.code || "") !== "00000") {
    return {
      ok: false,
      status: 400,
      msg: j?.msg || "Bitget returned non-success code",
      url,
      preview: text.slice(0, 200),
    };
  }

  const depth = j?.data;
  if (!depth?.bids?.length || !depth?.asks?.length) {
    return {
      ok: false,
      status: 200,
      msg: "Empty orderbook",
      url,
      preview: text.slice(0, 200),
    };
  }

  // depth format is { asks: [[price, size], ...], bids: [[price, size], ...] }
  return { ok: true, url, depth };
}

function sumDepth(levels, mid, pct, isBid) {
  const limit = isBid ? mid * (1 - pct) : mid * (1 + pct);
  let total = 0;
  let biggest = 0;

  for (const row of levels) {
    const p = Number(row?.[0]);
    const s = Number(row?.[1]);
    if (!Number.isFinite(p) || !Number.isFinite(s)) continue;

    // Bitget levels are typically already sorted best->worse, but we still break safely:
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

  const pct = 0.002; // 0.2%
  const bidRes = sumDepth(bids, mid, pct, true);
  const askRes = sumDepth(asks, mid, pct, false);

  const bidUsd = bidRes.total;
  const askUsd = askRes.total;

  const denom = bidUsd + askUsd;
  const score = denom > 0 ? (bidUsd - askUsd) / denom : 0;

  const biggest = Math.max(bidRes.biggest, askRes.biggest);
  const lor = denom > 0 ? biggest / denom : 1;

  // depth within 1%
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

function validateSamples(mode, samplesFresh) {
  const fresh = pruneSamples(samplesFresh);

  if (fresh.length < SETTINGS.entry.samplesNeed) {
    return { valid: false, reason: "Not enough samples", fresh };
  }

  const lastN = fresh.slice(-SETTINGS.entry.samplesNeed);
  const agree = lastN.filter((s) => (mode === "bull" ? s.score > 0 : s.score < 0)).length;

  if (agree < SETTINGS.entry.minAgree) {
    return { valid: false, reason: "Direction not consistent", fresh: lastN, agree };
  }

  const avgScore = lastN.reduce((a, s) => a + s.score, 0) / lastN.length;
  return { valid: true, reason: "OK", fresh: lastN, avgScore, agree };
}

function pickCandidatesFromLatest(latest, maxPerRun = 12, radarFallback = 25) {
  const almost = (latest?.funnel?.almost || []).slice(0, SETTINGS.obPickAlmost);
  const buildup = (latest?.funnel?.buildup || []).slice(0, SETTINGS.obPickBuildup);

  let picked = [...almost, ...buildup];

  // fallback: RADAR top N als buildup/almost leeg
  if (!picked.length) picked = (latest?.funnel?.radar || []).slice(0, radarFallback);

  return picked
    .map((x) => String(x?.symbol || "").toUpperCase())
    .filter(Boolean)
    .slice(0, maxPerRun);
}

async function processCandidate(mode, symbol) {
  const live = await fetchBitgetOrderbookRaw(symbol, 100);
  if (!live.ok) {
    return { ok: false, symbol, ...live };
  }

  const sample = computeObSample(live.depth);
  if (!sample) {
    return { ok: false, symbol, status: 200, msg: "Could not compute sample", url: live.url };
  }

  const kS = keyObSamples(mode, symbol);
  const prev = (await kv.get(kS)) || [];
  const merged = Array.isArray(prev) ? prev.concat([sample]) : [sample];

  const pruned = pruneSamples(merged);
  await kv.set(kS, pruned);

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

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const mode = String(req.query?.mode || "bull").toLowerCase();
    if (mode !== "bull" && mode !== "bear") {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "mode must be bull/bear" }));
    }

    // ✅ regelbaar via URL:
    // /api/ob-sampler?mode=bear&max=30&token=...
    const maxPerRun = Math.max(1, Math.min(80, Number(req.query?.max || 12) || 12));
    const radarFallback = Math.max(5, Math.min(80, Number(req.query?.radar || 25) || 25));

    const latest = await kv.get(keyLatest(mode));
    const candidates = pickCandidatesFromLatest(latest, maxPerRun, radarFallback);

    let totalTried = 0;
    let totalProcessed = 0;
    let totalValid = 0;
    let failed = 0;
    const failedDetails = [];

    for (const sym of candidates) {
      totalTried++;
      const r = await processCandidate(mode, sym);
      if (r.ok) {
        totalProcessed++;
        if (r.valid) totalValid++;
      } else {
        failed++;
        failedDetails.push({
          symbol: r.symbol,
          status: r.status,
          msg: r.msg || r.error || "failed",
          url: r.url,
          preview: r.preview,
        });
      }
    }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      ok: true,
      mode,
      ts: Date.now(),
      maxPerRun,
      radarFallback,
      candidates,
      totalTried,
      totalProcessed,
      totalValid,
      failed,
      failedDetails: failedDetails.slice(0, 20),
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}