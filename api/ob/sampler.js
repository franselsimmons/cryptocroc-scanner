// /api/ob/sampler.js
import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, requireSecret } from "../../lib/_runtime.js";
import { putObSnapshot } from "../../lib/obStore.js";

export const config = RUNTIME_CONFIG;

// --------------------
// Helpers
// --------------------
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
    .map((x) => ({
      p: n(x?.[0], 0),
      q: n(x?.[1], 0),
    }))
    .filter((r) => r.p > 0 && r.q > 0);
}

// depth binnen +-1% van mid (dit is wat je “Depth 1%” eigenlijk hoort te zijn)
function depthUsdWithinPct(side, mid, pct) {
  const list = Array.isArray(side) ? side : [];
  if (!(mid > 0)) return { usd: 0, largestUsd: 0 };

  const band = mid * (pct / 100);

  let usd = 0;
  let largestUsd = 0;

  for (const lvl of list) {
    const levelUsd = lvl.p * lvl.q;
    usd += levelUsd;
    if (levelUsd > largestUsd) largestUsd = levelUsd;
  }

  return { usd, largestUsd, band };
}

function computeFromDepth(depth) {
  const bids = parseSide(depth?.bids);
  const asks = parseSide(depth?.asks);
  if (!bids.length || !asks.length) return null;

  // Bitget geeft bids meestal hoog→laag en asks laag→hoog, maar we vertrouwen dat niet blind.
  // Pak beste bid = hoogste price, beste ask = laagste price.
  const bestBid = bids.reduce((m, x) => (x.p > m ? x.p : m), 0);
  const bestAsk = asks.reduce((m, x) => (m === 0 ? x.p : Math.min(m, x.p)), 0);
  if (!(bestBid > 0) || !(bestAsk > 0) || !(bestAsk > bestBid)) return null;

  const mid = (bestBid + bestAsk) / 2;
  const spreadPct = ((bestAsk - bestBid) / mid) * 100;

  // Neem alleen levels binnen 1% van mid
  const bandPct = 1.0;

  const bidsInBand = bids.filter((x) => x.p >= mid * (1 - bandPct / 100));
  const asksInBand = asks.filter((x) => x.p <= mid * (1 + bandPct / 100));

  const bidBand = depthUsdWithinPct(bidsInBand, mid, bandPct);
  const askBand = depthUsdWithinPct(asksInBand, mid, bandPct);

  const bidUsd1p = bidBand.usd;
  const askUsd1p = askBand.usd;

  const depthMinUsd1p = Math.min(bidUsd1p, askUsd1p);
  const pressureDeltaUsd = bidUsd1p - askUsd1p;

  // score: -1..+1 (koopdruk vs verkoopdruk)
  const denom = bidUsd1p + askUsd1p;
  const score = denom > 0 ? pressureDeltaUsd / denom : 0;

  // Largest Order Ratio (LOR): grootste order (usd) / totale depth (usd) binnen 1%
  const largestUsd = Math.max(bidBand.largestUsd, askBand.largestUsd);
  const lor = denom > 0 ? largestUsd / denom : 0;

  return {
    ts: Date.now(),
    mid,
    spreadPct,
    // depth metrics
    bidUsd1p,
    askUsd1p,
    depthMinUsd1p,
    // pressure
    pressureDeltaUsd,
    score,
    // anti “één dikke order”
    lor,
    // extra: hoeveel levels we gebruikten (handig debug)
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
    r = await fetch(url, {
      headers: { accept: "application/json" },
      signal: ac.signal,
    });
    txt = await r.text();
    try {
      j = JSON.parse(txt);
    } catch {
      j = null;
    }
  } catch (e) {
    clearTimeout(t);
    return {
      ok: false,
      status: 0,
      msg: "fetch_failed",
      preview: String(e?.message || e).slice(0, 200),
      url,
    };
  } finally {
    clearTimeout(t);
  }

  if (!r?.ok || !j || String(j.code) !== "00000") {
    return {
      ok: false,
      status: r?.status || 0,
      msg: j?.msg || "bitget_failed",
      preview: String(txt || "").slice(0, 200),
      url,
      code: j?.code,
    };
  }

  return { ok: true, depth: j.data, url, pair };
}

// --------------------
// Handler
// --------------------
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
    const symbols = raw
      .split(",")
      .map((s) => up(s))
      .filter(Boolean);

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

    // bewust SEQUENTIEEL: Bitget rate limits + stabieler op Vercel
    for (const symbol of symbols) {
      const live = await fetchBitgetOrderbook(symbol);
      if (!live.ok) {
        failed.push({ symbol, step: "fetch", ...live });
        continue;
      }

      const snap = computeFromDepth(live.depth);
      if (!snap) {
        failed.push({ symbol, step: "compute", ok: false, msg: "compute_failed", pair: live.pair, url: live.url });
        continue;
      }

      // 1) snapshot voor scan + /api/orderbook endpoint
      const put = await putObSnapshot(mode, symbol, snap, ttlSec);
      if (!put.ok) {
        failed.push({
          symbol,
          step: "put_snapshot",
          ok: false,
          msg: "put_snapshot_failed",
          why: put.why,
        });
        continue;
      }

      // 2) samples voor slope gate (scan gebruikt deze)
      const sKey = core.keyObSamples(mode, symbol);
      const prev = (await kv.get(sKey)) || [];
      const arr = Array.isArray(prev) ? prev : [];

      const cutoff = Date.now() - windowSec * 1000;
      const next = arr
        .filter((x) => Number(x?.ts || 0) >= cutoff)
        .concat([
          {
            ts: snap.ts,
            spreadPct: snap.spreadPct,
            depthMinUsd1p: snap.depthMinUsd1p,
            pressureDeltaUsd: snap.pressureDeltaUsd,
            score: snap.score,
            // extra (kan later handig zijn)
            lor: snap.lor,
            bidUsd1p: snap.bidUsd1p,
            askUsd1p: snap.askUsd1p,
          },
        ])
        .slice(-keep);

      await kv.set(sKey, next, { ex: ttlSec });

      processed.push({
        symbol,
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

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.end(
      JSON.stringify({
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
        note:
          "Depth1% = USD depth binnen +-1% van mid. Dit voorkomt dat Depth altijd 0 of raar wordt door top-10-only.",
      })
    );
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}