import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, requireSecret, getMode } from "../../lib/_runtime.js";

export const config = RUNTIME_CONFIG;

// Bitget v2 orderbook spot
async function fetchBitgetOrderbookRaw(baseSymbol, limit = 100) {
  const base = String(baseSymbol || "").toUpperCase().trim();
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

  if (!r.ok) return { ok: false, status: r.status, msg: "Bitget failed", url, preview: text.slice(0, 200) };
  if (String(j?.code || "") !== "00000") return { ok: false, status: 400, msg: j?.msg || "Bitget non-success", url, preview: text.slice(0,200) };

  const depth = j?.data;
  if (!depth?.bids?.length || !depth?.asks?.length) return { ok: false, status: 200, msg: "Empty orderbook", url };

  return { ok: true, depth, url };
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

function prune(samples, windowSec) {
  const now = Date.now();
  const winMs = Number(windowSec || 900) * 1000;
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
      depthMinUsd1p: Number(s?.depthMinUsd1p ?? 0)
    }))
    .filter((s) => s.ts > 0 && Number.isFinite(s.score))
    .filter((s) => now - s.ts <= winMs)
    .sort((a,b)=>a.ts-b.ts)
    .slice(-60);
}

function validate(mode, fresh, need, minAgree) {
  if (fresh.length < need) return { valid: false, reason: "Not enough samples", agree: 0, avgScore: 0 };

  const lastN = fresh.slice(-need);
  const agree = lastN.filter((s) => (mode === "bull" ? s.score > 0 : s.score < 0)).length;
  const avgScore = lastN.reduce((a,s)=>a+s.score,0) / lastN.length;

  const avgOk = mode === "bull" ? avgScore > 0 : avgScore < 0;
  if (!avgOk || agree < minAgree) return { valid:false, reason:"Direction not consistent", agree, avgScore };

  return { valid:true, reason:"OK", agree, avgScore };
}

function uniqueUpper(list) {
  const out = [];
  const seen = new Set();
  for (const x of list || []) {
    const s = String(x || "").toUpperCase().trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const mode = getMode(req);
    const core = await import(`../../lib/_core_${mode}.js`);
    const E = core.SETTINGS.entry;

    const maxPerRun = Math.max(1, Math.min(80, Number(req.query?.max || 12) || 12));
    const radarFallback = Math.max(5, Math.min(120, Number(req.query?.radar || 25) || 25));

    const latest = await kv.get(core.keyLatest(mode));
    const pool =
      uniqueUpper([
        ...(latest?.funnel?.almost || []).map((x) => x.symbol),
        ...(latest?.funnel?.buildup || []).map((x) => x.symbol),
        ...(latest?.funnel?.radar || []).slice(0, radarFallback).map((x) => x.symbol)
      ]);

    const candidates = pool.slice(0, maxPerRun);

    let totalTried = 0, totalProcessed = 0, totalValid = 0, failed = 0;
    const processed = [];
    const failedDetails = [];

    for (const sym of candidates) {
      totalTried++;

      const live = await fetchBitgetOrderbookRaw(sym, 100);
      if (!live.ok) {
        failed++;
        failedDetails.push({ symbol: sym, status: live.status, msg: live.msg, url: live.url, preview: live.preview });
        continue;
      }

      const sample = computeObSample(live.depth);
      if (!sample) {
        failed++;
        failedDetails.push({ symbol: sym, status: 200, msg: "Could not compute sample", url: live.url });
        continue;
      }

      const kS = core.keyObSamples(mode, sym);
      const prev = (await kv.get(kS)) || [];
      const merged = Array.isArray(prev) ? prev.concat([sample]) : [sample];
      const fresh = prune(merged, E.samplesWindowSec);
      await kv.set(kS, fresh);

      const v = validate(mode, fresh, E.samplesNeed, E.minAgree);

      const result = {
        symbol: sym,
        side: mode,
        valid: v.valid,
        reason: v.reason,
        stale: false,
        score: sample.score,
        spreadPct: sample.spreadPct,
        lor: sample.lor,
        depthMinUsd1p: sample.depthMinUsd1p,
        avgScore: v.avgScore,
        agree: v.agree,
        ob: sample,
        ts: Date.now()
      };

      await kv.set(core.keyObResult(mode, sym), result);

      totalProcessed++;
      if (v.valid) totalValid++;
      processed.push({ symbol: sym, valid: v.valid, reason: v.reason });
    }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
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
      failedDetails: failedDetails.slice(0, 20)
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}