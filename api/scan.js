import { CFG, fetchJSON, mapCoin } from "./_core.js";
import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs" };

/**
 * CRON-ONLY beveiliging:
 * - Als CRON_SECRET bestaat: dan moet Authorization header exact kloppen
 */
function requireCronAuth(req) {
  const secret = process.env.CRON_SECRET ? String(process.env.CRON_SECRET).trim() : "";
  if (!secret) return; // als je hem niet zet: dan is scan niet beveiligd (maar jij zet hem wél)

  const auth = req.headers?.authorization || req.headers?.Authorization || "";
  if (auth !== `Bearer ${secret}`) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }
}

async function getBTC24h() {
  const j = await fetchJSON(
    "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin&price_change_percentage=24h"
  );
  const btc = Array.isArray(j) ? j[0] : null;
  const pct = Number(btc?.price_change_percentage_24h) || 0;
  return pct;
}

async function getMarketsTop() {
  return fetchJSON(
    "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=250&page=1&price_change_percentage=24h&sparkline=false"
  );
}

/** Bitget V2 spot orderbook (zelfde als api/orderbook.js) */
async function fetchBitgetOrderbook(symbol) {
  const s = String(symbol || "").toUpperCase();
  const url = `https://api.bitget.com/api/v2/spot/market/orderbook?symbol=${encodeURIComponent(s)}USDT&limit=50`;
  const r = await fetch(url, { headers: { "accept": "application/json" } });
  const j = await r.json().catch(() => ({}));

  if (!r.ok) throw new Error(`Bitget HTTP ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);

  const data = Array.isArray(j?.data) ? j.data[0] : j?.data;
  if (!data) throw new Error("Bitget: no data");
  return data;
}

function sumDepth(levels, mid, pct, isBid) {
  const limit = isBid ? mid * (1 - pct) : mid * (1 + pct);
  let total = 0;

  for (const lv of levels) {
    const price = Number(lv?.[0]);
    const size = Number(lv?.[1]);
    if (!(price > 0 && size > 0)) continue;

    if (isBid && price < limit) break;
    if (!isBid && price > limit) break;

    total += price * size;
  }
  return total;
}

async function calcObScore(symbol) {
  const data = await fetchBitgetOrderbook(symbol);
  const bids = data?.bids;
  const asks = data?.asks;
  if (!Array.isArray(bids) || !Array.isArray(asks) || bids.length === 0 || asks.length === 0) {
    throw new Error("Bitget: empty bids/asks");
  }
  const bid = Number(bids[0][0]);
  const ask = Number(asks[0][0]);
  const mid = (bid + ask) / 2;
  if (!(mid > 0)) throw new Error("Bitget: invalid mid");

  const bidUsd = sumDepth(bids, mid, CFG.obDepthPct, true);
  const askUsd = sumDepth(asks, mid, CFG.obDepthPct, false);
  const score = (bidUsd + askUsd) > 0 ? (bidUsd - askUsd) / (bidUsd + askUsd) : 0;

  return { score, bidUsd, askUsd, mid };
}

/**
 * JOUW "super systeem" filters (basis + risk):
 * - volume, marketcap, vm ratio
 * - 24h range filter: geen extreme spikes (range%)
 * - direction gate: bull alleen positive coins, bear alleen negative coins
 * - orderbook poort: moet Bitget USDT pair hebben + score goed
 */
function basePass(c) {
  return (
    c.volume >= CFG.minVolumeUsd &&
    c.marketCap >= CFG.minMarketCap &&
    c.vm >= CFG.minVmRatio
  );
}

function rangePctFromCG(raw) {
  const hi = Number(raw?.high_24h) || 0;
  const lo = Number(raw?.low_24h) || 0;
  if (!(hi > 0 && lo > 0) || hi < lo) return 999;
  return ((hi - lo) / lo) * 100;
}

export default async function handler(req, res) {
  try {
    requireCronAuth(req);

    const u = new URL(req.url, "http://localhost");
    const requestedMode = (u.searchParams.get("mode") || "auto").toLowerCase();

    // 1) BTC gate bepaalt active mode
    const btc24h = await getBTC24h();

    // Simpel en duidelijk:
    // - btc >= 0 => bull actief
    // - btc < 0  => bear actief
    const activeMode = (btc24h >= 0) ? "bull" : "bear";

    // Als iemand “bull” vraagt terwijl bear actief is → dan schrijven we bull als disabled
    // En andersom.
    const bullEnabled = activeMode === "bull";
    const bearEnabled = activeMode === "bear";

    // 2) Markets ophalen + mappen
    const markets = await getMarketsTop();
    const mapped = markets.map(mapCoin);

    // 3) Base filters + range filter
    const pool = [];
    for (let i = 0; i < mapped.length; i++) {
      const c = mapped[i];
      const raw = markets[i];

      if (!basePass(c)) continue;

      // Range-filter (anti extreme spikes). Jij kan later aan knopjes sleutelen.
      const rangePct = rangePctFromCG(raw);
      if (rangePct > 60) continue;

      pool.push({ ...c, rangePct });
    }

    // 4) Selecteer kandidaten per mode
    function dirOk(mode, c) {
      return mode === "bull" ? c.change24 > 0 : c.change24 < 0;
    }

    // We willen niet 200x Bitget callen.
    // Dus: pak top 60 (op vm) als kandidaten voor orderbook.
    const candidates = [...pool].sort((a,b)=>b.vm-a.vm).slice(0, 60);

    // 5) Orderbook poort (Bitget)
    // We voegen obScore toe aan coin (alleen als Bitget bestaat)
    const withOB = [];
    for (const c of candidates) {
      try {
        const ob = await calcObScore(c.symbol);
        withOB.push({ ...c, obScore: ob.score });
      } catch {
        // als Bitget pair niet bestaat → coin valt af
      }
    }

    // 6) Bouw funnels (alleen met OB coins)
    function buildForMode(mode, enabled) {
      if (!enabled) {
        return {
          ok: true,
          disabled: true,
          ts: Date.now(),
          mode,
          gate: { btc24h, activeMode },
          reason: `BTC gate: ${activeMode.toUpperCase()} actief`
        };
      }

      const radar = [];
      const buildup = [];
      const entry = [];
      const hold = [];
      const sell = [];

      // Radar: OB coins die door base filters komen (en bestaan op Bitget)
      for (const c of withOB) {
        radar.push(c);

        if (!dirOk(mode, c)) continue;
        buildup.push(c);

        // ENTRY: vm threshold + OB score threshold in juiste richting
        // bull: obScore positief genoeg
        // bear: obScore negatief genoeg
        const obOK = mode === "bull" ? (c.obScore >= 0.08) : (c.obScore <= -0.08);
        const vmOK = c.vm >= 0.5;

        if (vmOK && obOK) {
          entry.push(c);

          // Hold / Sell (simpel, maar werkt):
          // als 24h move al mega is → SELL, anders HOLD
          const bigMove = Math.abs(c.change24) >= 25;
          if (bigMove) sell.push(c);
          else hold.push(c);
        }
      }

      // sort: beste boven
      const byPower = (a,b) => (b.vm - a.vm) || (Math.abs(b.obScore) - Math.abs(a.obScore));
      radar.sort(byPower);
      buildup.sort(byPower);
      entry.sort(byPower);
      hold.sort(byPower);
      sell.sort(byPower);

      return {
        ok: true,
        disabled: false,
        ts: Date.now(),
        mode,
        gate: { btc24h, activeMode },
        counts: {
          pool: pool.length,
          bitgetPairs: withOB.length,
          radar: radar.length,
          buildup: buildup.length,
          entry: entry.length,
          hold: hold.length,
          sell: sell.length
        },
        funnel: { entry, hold, sell, buildup, radar }
      };
    }

    const bullData = buildForMode("bull", bullEnabled);
    const bearData = buildForMode("bear", bearEnabled);

    // 7) Opslaan (iedereen ziet hetzelfde)
    await kv.set("latest:bull", bullData);
    await kv.set("latest:bear", bearData);

    // response is alleen voor cron (maar we geven wat debug terug)
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({
      ok: true,
      activeMode,
      btc24h,
      wrote: ["latest:bull", "latest:bear"]
    }));
  } catch (e) {
    res.statusCode = e?.statusCode || 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}
