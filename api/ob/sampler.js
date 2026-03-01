// /api/ob/sampler.js
import { kv } from "@vercel/kv";
import { requireSecret } from "../../lib/_runtime.js";
import { putObSnapshot } from "../../lib/obStore.js";

export const config = { runtime: "nodejs" };

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

async function fetchBitgetOrderbook(symbol) {
  const pair = `${symbol.toUpperCase()}USDT`;
  const url =
    `https://api.bitget.com/api/v2/spot/market/orderbook?` +
    `symbol=${encodeURIComponent(pair)}&type=step0&limit=100`;

  const r = await fetch(url, { headers: { accept: "application/json" } });
  const txt = await r.text();

  let j = null;
  try { j = JSON.parse(txt); } catch {}

  if (!r.ok || !j || String(j.code) !== "00000") {
    return {
      ok: false,
      status: r.status,
      msg: j?.msg || "bitget_failed",
      preview: txt.slice(0, 200),
      url,
    };
  }

  return { ok: true, depth: j.data, url };
}

function compute(depth) {
  const bids = depth?.bids || [];
  const asks = depth?.asks || [];
  if (!bids.length || !asks.length) return null;

  const bid = Number(bids[0][0]);
  const ask = Number(asks[0][0]);
  if (!(bid > 0) || !(ask > 0)) return null;

  const mid = (bid + ask) / 2;
  const spreadPct = ((ask - bid) / mid) * 100;

  const bidUsd = bids.slice(0, 10).reduce((a, x) => a + Number(x[0]) * Number(x[1]), 0);
  const askUsd = asks.slice(0, 10).reduce((a, x) => a + Number(x[0]) * Number(x[1]), 0);

  const depthMinUsd1p = Math.min(bidUsd, askUsd);
  const score = (bidUsd - askUsd) / (bidUsd + askUsd || 1);

  return {
    ts: Date.now(),
    spreadPct,
    depthMinUsd1p,
    pressureDeltaUsd: bidUsd - askUsd,
    score,
  };
}

export default async function handler(req, res) {
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
    const symbols = raw.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);

    if (!symbols.length) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      return res.end(JSON.stringify({ ok: false, error: "Missing ?symbols=PEPE,TURBO" }));
    }

    // core nodig voor keyObSamples (slope gate in scan)
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
        failed.push({ symbol, step: "fetch", ...live });
        continue;
      }

      const snap = compute(live.depth);
      if (!snap) {
        failed.push({ symbol, step: "compute", ok: false, msg: "compute_failed" });
        continue;
      }

      // 1) snapshot voor scan + orderbook endpoint
      const put = await putObSnapshot(mode, symbol, snap, ttlSec);
      if (!put.ok) {
        failed.push({ symbol, step: "put_snapshot", ok: false, msg: "put_snapshot_failed", why: put.why });
        continue;
      }

      // 2) samples voor slope gate
      const sKey = core.keyObSamples(mode, symbol);
      const prev = (await kv.get(sKey)) || [];
      const arr = Array.isArray(prev) ? prev : [];

      const cutoff = Date.now() - windowSec * 1000;
      const next = arr
        .filter(x => Number(x?.ts || 0) >= cutoff)
        .concat([{
          ts: snap.ts,
          spreadPct: snap.spreadPct,
          depthMinUsd1p: snap.depthMinUsd1p,
          pressureDeltaUsd: snap.pressureDeltaUsd,
          score: snap.score,
        }])
        .slice(-keep);

      await kv.set(sKey, next, { ex: ttlSec });

      processed.push({
        symbol,
        spreadPct: snap.spreadPct,
        depthMinUsd1p: snap.depthMinUsd1p,
        pressureDeltaUsd: snap.pressureDeltaUsd,
        score: snap.score,
      });
    }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.end(JSON.stringify({
      ok: true,
      mode,
      count: processed.length,
      processed,
      failed: failed.slice(0, 20),
      windowSec,
      need,
      keep,
      ttlSec,
      ts: Date.now(),
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}