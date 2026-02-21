// /api/ob-sampler.js
import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs20.x" };

// ================== BITGET V2 ORDERBOOK (SPOT) ==================
async function fetchBitgetOrderbookRaw(baseSymbol, limit = 100) {
  const base = String(baseSymbol || "").toUpperCase();
  if (!base) return { ok: false, status: 400, msg: "Missing symbol" };

  const pair = `${base}USDT`;
  const safeLimit = Math.max(5, Math.min(150, Number(limit) || 100));
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

function pruneSamples(samples, SETTINGS) {
  const now = Date.now();
  const winMs = Number(SETTINGS?.entry?.samplesWindowSec || 3600) * 1000;

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
    .slice(-60); // PRO: meer geschiedenis bewaren
}

function validateSamples(mode, samplesFresh, SETTINGS) {
  const fresh = pruneSamples(samplesFresh, SETTINGS);

  const need = Number(SETTINGS?.entry?.samplesNeed || 3);
  const minAgree = Number(SETTINGS?.entry?.minAgree || 2);

  if (fresh.length < need) {
    return { valid: false, reason: "Not enough samples", fresh };
  }

  const lastN = fresh.slice(-need);
  const agree = lastN.filter((s) => (mode === "bull" ? s.score > 0 : s.score < 0)).length;
  const avgScore = lastN.reduce((a, s) => a + s.score, 0) / lastN.length;

  // PRO: beide moeten kloppen: average richting + agree
  const avgOk = mode === "bull" ? avgScore > 0 : avgScore < 0;
  if (!avgOk || agree < minAgree) {
    return { valid: false, reason: "Direction not consistent", fresh: lastN, avgScore, agree };
  }

  return { valid: true, reason: "OK", fresh: lastN, avgScore, agree };
}

function uniqueUpper(list) {
  const out = [];
  const seen = new Set();
  for (const x of list) {
    const s = String(x || "").toUpperCase().trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * PRO Candidate picking:
 * 1) Build pool: ALMOST + BUILDUP + RADAR fallback
 * 2) Sticky: coins met weinig samples eerst (0,1,2) totdat ze valid kunnen worden
 * 3) Rotatie: cursor over de rest zodat je door je radar heen “loopt”
 */
async function pickCandidatesSmart(
  mode,
  latest,
  maxPerRun,
  radarFallback,
  SETTINGS,
  keyObSamples,
  keyObQueue,
  keyObCursor,
  keyObQueueTs
) {
  const almost = (latest?.funnel?.almost || []).slice(0, SETTINGS.obPickAlmost);
  const buildup = (latest?.funnel?.buildup || []).slice(0, SETTINGS.obPickBuildup);
  let picked = [...almost, ...buildup];

  if (!picked.length) picked = (latest?.funnel?.radar || []).slice(0, radarFallback);
  const pool = uniqueUpper(picked.map((x) => x?.symbol));

  if (!pool.length) return [];

  // 1) Sticky low-sample first
  const need = Number(SETTINGS?.entry?.samplesNeed || 3);
  const sampleCounts = [];

  for (const sym of pool) {
    const s = await kv.get(keyObSamples(mode, sym));
    const pruned = pruneSamples(s, SETTINGS);
    sampleCounts.push({ sym, n: pruned.length });
  }

  const sticky = sampleCounts
    .filter((x) => x.n < need)
    .sort((a, b) => a.n - b.n)
    .map((x) => x.sym);

  // 2) Rest rotatie queue
  const rest = sampleCounts
    .filter((x) => x.n >= need)
    .map((x) => x.sym);

  // We houden een queue + cursor per mode in KV, zodat “rest” niet steeds dezelfde top is
  const qKey = keyObQueue(mode);
  const cKey = keyObCursor(mode);
  const tsKey = keyObQueueTs(mode);

  const now = Date.now();
  const lastTs = Number((await kv.get(tsKey)) || 0);

  // queue refresh elke 10 minuten of als leeg
  let queue = await kv.get(qKey);
  if (!Array.isArray(queue) || !queue.length || now - lastTs > 10 * 60 * 1000) {
    queue = uniqueUpper(rest);
    await kv.set(qKey, queue);
    await kv.set(tsKey, now);
    await kv.set(cKey, 0);
  }

  let cursor = Number((await kv.get(cKey)) || 0);
  if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;
  if (cursor >= queue.length) cursor = 0;

  const rotated = [];
  for (let i = 0; i < queue.length && rotated.length < maxPerRun; i++) {
    const idx = (cursor + i) % queue.length;
    rotated.push(queue[idx]);
  }

  // cursor vooruit zetten (zodat volgende run andere coins pakt)
  const nextCursor = queue.length ? (cursor + rotated.length) % queue.length : 0;
  await kv.set(cKey, nextCursor);

  // 3) Combine: sticky eerst, dan rotatie
  const out = uniqueUpper([...sticky, ...rotated]).slice(0, maxPerRun);
  return out;
}

async function processCandidate(mode, symbol, SETTINGS, keyObSamples, keyObResult) {
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

  const pruned = pruneSamples(merged, SETTINGS);
  await kv.set(kS, pruned);

  const v = validateSamples(mode, pruned, SETTINGS);

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
  return { ok: true, symbol, valid: v.valid, reason: v.reason };
}

export default async function handler(req, res) {
  try {
    const mode = String(req.query?.mode || "bull").toLowerCase();
    if (mode !== "bull" && mode !== "bear") {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "mode must be bull/bear" }));
    }

    const core = await import(`./_core_${mode}.js`);
    const {
      requireSecret,
      SETTINGS,
      keyLatest,
      keyObSamples,
      keyObResult,
      keyObQueue,
      keyObCursor,
      keyObQueueTs,
    } = core;

    if (!requireSecret(req, res)) return;

    // /api/ob-sampler?mode=bear&max=30&radar=40&token=...
    const maxPerRun = Math.max(1, Math.min(80, Number(req.query?.max || 12) || 12));
    const radarFallback = Math.max(5, Math.min(120, Number(req.query?.radar || 25) || 25));

    const latest = await kv.get(keyLatest(mode));
    const candidates = await pickCandidatesSmart(
      mode,
      latest,
      maxPerRun,
      radarFallback,
      SETTINGS,
      keyObSamples,
      keyObQueue,
      keyObCursor,
      keyObQueueTs
    );

    let totalTried = 0;
    let totalProcessed = 0;
    let totalValid = 0;
    let failed = 0;
    const failedDetails = [];
    const processed = [];

    for (const sym of candidates) {
      totalTried++;
      const r = await processCandidate(mode, sym, SETTINGS, keyObSamples, keyObResult);
      if (r.ok) {
        totalProcessed++;
        if (r.valid) totalValid++;
        processed.push({ symbol: sym, valid: r.valid, reason: r.reason });
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
      processed,
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
