import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs" };

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

  // 0.2% band voor imbalance score
  const pct = 0.002;
  const bidRes = sumDepth(bids, mid, pct, true);
  const askRes = sumDepth(asks, mid, pct, false);

  const bidUsd = bidRes.total;
  const askUsd = askRes.total;

  const denom = bidUsd + askUsd;
  const score = denom > 0 ? (bidUsd - askUsd) / denom : 0;

  const biggest = Math.max(bidRes.biggest, askRes.biggest);
  const lor = denom > 0 ? biggest / denom : 1;

  // depth within 1% (min van beide kanten)
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
    depthMinUsd1p
  };
}

function pruneSamples(samples, SETTINGS) {
  const now = Date.now();
  const winMs = Number(SETTINGS?.entry?.samplesWindowSec || 5400) * 1000; // default 90 min
  const maxKeep = Math.max(6, Math.min(60, Number(SETTINGS?.entry?.samplesMax || 18)));

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
    .slice(-maxKeep);
}

function validateSamples(mode, samplesFresh, SETTINGS) {
  const fresh = pruneSamples(samplesFresh, SETTINGS);

  const need = Number(SETTINGS?.entry?.samplesNeed || 8);
  const minAgree = Number(SETTINGS?.entry?.minAgree || 6);

  if (fresh.length < need) {
    return { valid: false, reason: "Not enough samples", fresh };
  }

  const lastN = fresh.slice(-need);
  const agree = lastN.filter((s) => (mode === "bull" ? s.score > 0 : s.score < 0)).length;
  const avgScore = lastN.reduce((a, s) => a + s.score, 0) / lastN.length;

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

async function pickCandidatesSmart(mode, latest, maxPerRun, radarFallback, SETTINGS) {
  const almost = (latest?.funnel?.almost || []).slice(0, Number(SETTINGS?.obPickAlmost || 25));
  const buildup = (latest?.funnel?.buildup || []).slice(0, Number(SETTINGS?.obPickBuildup || 25));

  let picked = [...almost, ...buildup];
  if (!picked.length) picked = (latest?.funnel?.radar || []).slice(0, radarFallback);

  const pool = uniqueUpper(picked.map((x) => x?.symbol));
  return pool.slice(0, maxPerRun);
}

async function processCandidate(core, mode, symbol, SETTINGS, keyObSamples, keyObResult) {
  const live = await fetchBitgetOrderbookRaw(symbol, 100);
  if (!live.ok) return { ok: false, symbol, ...live };

  const sample = computeObSample(live.depth);
  if (!sample) {
    return { ok: false, symbol, status: 200, msg: "Could not compute sample", url: live.url };
  }

  const kS = keyObSamples(mode, symbol);
  const prev = (await kv.get(kS)) || [];
  const merged = Array.isArray(prev) ? prev.concat([sample]) : [sample];

  const pruned = pruneSamples(merged, SETTINGS);

  // ✅ TTL zodat KV niet vol blijft hangen
  const samplesEx = Math.max(3600, Number(SETTINGS?.entry?.samplesTtlSec || 60 * 60 * 48));
  await kv.set(kS, pruned, { ex: samplesEx });

  // basis valid (direction)
  const v = validateSamples(mode, pruned, SETTINGS);

  // ✅ slope gate ook al in sampler meenemen (zodat ob.valid echt klopt)
  const slopeCheck = typeof core.checkObSlopeGate === "function"
    ? core.checkObSlopeGate({ stage: "sampler", mode, obSamples: pruned, settings: SETTINGS })
    : { ok: true, slope: 0, points: [] };

  const finalValid = !!v.valid && !!slopeCheck.ok;
  const finalReason = finalValid
    ? "OK"
    : (v.valid ? (slopeCheck.reason || "OB slope failed") : (v.reason || "OB invalid"));

  const result = {
    symbol,
    side: mode,
    valid: finalValid,
    reason: finalReason,
    stale: false,

    // laatste sample (voor snelle UI)
    score: sample.score,
    spreadPct: sample.spreadPct,
    lor: sample.lor,
    depthMinUsd1p: sample.depthMinUsd1p,

    // sampler checks
    avgScore: v.avgScore ?? null,
    agree: v.agree ?? null,
    slope: slopeCheck.slope ?? null,

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

  // ✅ TTL zodat oude results zichzelf opruimen
  const resultEx = Math.max(900, Number(SETTINGS?.entry?.resultTtlSec || 60 * 20)); // default 20 min
  await kv.set(keyObResult(mode, symbol), result, { ex: resultEx });

  return { ok: true, symbol, valid: finalValid, reason: finalReason };
}

export default async function handler(req, res) {
  try {
    const mode = String(req.query?.mode || "bull").toLowerCase();
    if (mode !== "bull" && mode !== "bear") {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "mode must be bull/bear" }));
    }

    // ✅ correct pad: api -> lib
    const core = await import(`../lib/_core_${mode}.js`);
    const { SETTINGS, keyLatest, keyObSamples, keyObResult } = core;

    // ✅ requireSecret komt uit _runtime (niet uit core)
    const rt = await import("../lib/_runtime.js");
    if (!rt.requireSecret(req, res)) return;

    const maxPerRun = Math.max(1, Math.min(80, Number(req.query?.max || 12) || 12));
    const radarFallback = Math.max(5, Math.min(120, Number(req.query?.radar || 25) || 25));

    const latest = await kv.get(keyLatest(mode));
    const candidates = await pickCandidatesSmart(mode, latest, maxPerRun, radarFallback, SETTINGS);

    let totalTried = 0;
    let totalProcessed = 0;
    let totalValid = 0;
    let failed = 0;

    const processed = [];
    const failedDetails = [];

    for (const sym of candidates) {
      totalTried++;
      const r = await processCandidate(core, mode, sym, SETTINGS, keyObSamples, keyObResult);
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
    return res.end(JSON.stringify({
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
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}