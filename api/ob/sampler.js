// /api/ob/sampler.js
import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, requireSecret } from "../../lib/_runtime.js";
import { putObSnapshot } from "../../lib/obStore.js";

export const config = RUNTIME_CONFIG;

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}
function up(x) {
  return String(x || "").trim().toUpperCase();
}

function parseSide(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  return arr
    .map((x) => ({ p: n(x?.[0], 0), q: n(x?.[1], 0) }))
    .filter((r) => r.p > 0 && r.q > 0);
}

function depthUsdWithinPct(side, mid, pct) {
  const list = Array.isArray(side) ? side : [];
  if (!(mid > 0)) return { usd: 0, largestUsd: 0 };

  let usd = 0;
  let largestUsd = 0;

  for (const lvl of list) {
    const levelUsd = lvl.p * lvl.q;
    usd += levelUsd;
    if (levelUsd > largestUsd) largestUsd = levelUsd;
  }

  return { usd, largestUsd };
}

function computeFromDepth(depth) {
  const bids = parseSide(depth?.bids);
  const asks = parseSide(depth?.asks);
  if (!bids.length || !asks.length) return null;

  const bestBid = bids.reduce((m, x) => (x.p > m ? x.p : m), 0);
  const bestAsk = asks.reduce((m, x) => (m === 0 ? x.p : Math.min(m, x.p)), 0);
  if (!(bestBid > 0) || !(bestAsk > 0) || !(bestAsk > bestBid)) return null;

  const mid = (bestBid + bestAsk) / 2;
  const spreadPct = ((bestAsk - bestBid) / mid) * 100;

  const bandPct = 1.0;
  const bidsInBand = bids.filter((x) => x.p >= mid * (1 - bandPct / 100));
  const asksInBand = asks.filter((x) => x.p <= mid * (1 + bandPct / 100));

  const bidBand = depthUsdWithinPct(bidsInBand, mid, bandPct);
  const askBand = depthUsdWithinPct(asksInBand, mid, bandPct);

  const bidUsd1p = bidBand.usd;
  const askUsd1p = askBand.usd;

  const depthMinUsd1p = Math.min(bidUsd1p, askUsd1p);
  const pressureDeltaUsd = bidUsd1p - askUsd1p;

  const denom = bidUsd1p + askUsd1p;
  const score = denom > 0 ? pressureDeltaUsd / denom : 0;

  const largestUsd = Math.max(bidBand.largestUsd, askBand.largestUsd);
  const lor = denom > 0 ? largestUsd / denom : 0;

  return {
    ts: Date.now(),
    mid,
    spreadPct,
    bidUsd1p,
    askUsd1p,
    depthMinUsd1p,
    pressureDeltaUsd,
    score,
    lor,
    levels: { bids1p: bidsInBand.length, asks1p: asksInBand.length },
  };
}

async function fetchBitgetOrderbook(symbol) {
  const pair = `${up(symbol)}USDT`;
  const url =
    `https://api.bitget.com/api/v2/spot/market/orderbook?` +
    `symbol=${encodeURIComponent(pair)}&type=step0&limit=100`;

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 9000);

  let r, txt, j;
  try {
    r = await fetch(url, { headers: { accept: "application/json" }, signal: ac.signal });
    txt = await r.text();
    try { j = JSON.parse(txt); } catch { j = null; }
  } catch (e) {
    clearTimeout(t);
    return { ok: false, status: 0, msg: "fetch_failed", preview: String(e?.message || e).slice(0, 200), url, pair };
  } finally {
    clearTimeout(t);
  }

  if (!r?.ok || !j || String(j.code) !== "00000") {
    return { ok: false, status: r?.status || 0, msg: j?.msg || "bitget_failed", preview: String(txt || "").slice(0, 200), url, pair, code: j?.code };
  }

  return { ok: true, depth: j.data, url, pair };
}

export default async function handler(req, res) {
  const startedAt = Date.now();
  let wrote = 0;
  let failedCount = 0;

  try {
    if (!requireSecret(req, res)) return;

    const mode = String(req.query?.mode || "bull").toLowerCase();
    if (mode !== "bull" && mode !== "bear") {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      return res.end(JSON.stringify({ ok: false, error: "mode must be bull/bear" }));
    }

    const raw = String(req.query?.symbols || "");
    const symbols = raw.split(",").map((s) => up(s)).filter(Boolean);

    if (!symbols.length) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      return res.end(JSON.stringify({ ok: false, error: "Missing ?symbols=PEPE,TURBO" }));
    }

    const coreMod = await import(`../../lib/_core_${mode}.js`);
    const core = coreMod?.default ? coreMod.default : coreMod;

    const entryCfg = core?.SETTINGS?.entry || {};
    const windowSec = Math.max(60, n(entryCfg.samplesWindowSec, 3 * 3600));
    const need = Math.max(2, n(entryCfg.samplesNeed, 4));
    const keep = Math.max(6, need * 3);

    const ttlSec = Math.max(3600, windowSec * 2);

    const processed = [];
    const failed = [];

    for (const symbol of symbols) {
      const live = await fetchBitgetOrderbook(symbol);
      if (!live.ok) {
        failedCount++;
        failed.push({ symbol, step: "fetch", ...live });
        continue;
      }

      const snap = computeFromDepth(live.depth);
      if (!snap) {
        failedCount++;
        failed.push({ symbol, step: "compute", ok: false, msg: "compute_failed", pair: live.pair, url: live.url });
        continue;
      }

      // 1) snapshot storage (DEZE MOET MATCHEN met getObSnapshot)
      const put = await putObSnapshot(mode, symbol, snap, ttlSec);
      if (!put.ok) {
        failedCount++;
        failed.push({ symbol, step: "put_snapshot", ok: false, msg: "put_snapshot_failed", why: put.why });
        continue;
      }
      wrote++;

      // 2) samples voor slope gate
      const sKey = core.keyObSamples(mode, symbol);
      const prev = (await kv.get(sKey)) || [];
      const arr = Array.isArray(prev) ? prev : [];

      const cutoff = Date.now() - windowSec * 1000;
      const next = arr
        .filter((x) => Number(x?.ts || 0) >= cutoff)
        .concat([{
          ts: snap.ts,
          spreadPct: snap.spreadPct,
          depthMinUsd1p: snap.depthMinUsd1p,
          pressureDeltaUsd: snap.pressureDeltaUsd,
          score: snap.score,
          lor: snap.lor,
          bidUsd1p: snap.bidUsd1p,
          askUsd1p: snap.askUsd1p,
        }])
        .slice(-keep);

      await kv.set(sKey, next, { ex: ttlSec });

      // extra debug per sym
      await kv.set(`ob:samples:last:${mode}:${up(symbol)}`, { ts: snap.ts, key: sKey, count: next.length }, { ex: ttlSec });

      processed.push({
        symbol: up(symbol),
        pair: live.pair,
        spreadPct: snap.spreadPct,
        depthMinUsd1p: snap.depthMinUsd1p,
        bidUsd1p: snap.bidUsd1p,
        askUsd1p: snap.askUsd1p,
        pressureDeltaUsd: snap.pressureDeltaUsd,
        score: snap.score,
        lor: snap.lor,
        levels: snap.levels,
      });
    }

    // ✅ HEARTBEAT: hiermee zie je direct “sampler draaide / schreef X snapshots”
    await kv.set(
      `ob:sampler:last:${mode}`,
      { ts: Date.now(), ok: true, wrote, failed: failedCount, symbols: symbols.slice(0, 50) },
      { ex: 60 * 60 }
    );

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.end(JSON.stringify({
      ok: true,
      mode,
      count: processed.length,
      wrote,
      failedCount,
      processed,
      failed: failed.slice(0, 20),
      windowSec,
      need,
      keep,
      ttlSec,
      tookMs: Date.now() - startedAt,
    }));
  } catch (e) {
    try {
      const mode = String(req.query?.mode || "bull").toLowerCase();
      await kv.set(`ob:sampler:last:${mode}`, { ts: Date.now(), ok: false, error: String(e?.message || e) }, { ex: 60 * 60 });
    } catch {}

    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}