import { CFG, fetchJSON, mapCoin } from "./_core.js";
import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs" };

// ===== cron-only auth =====
function requireCronAuth(req) {
  const secret = process.env.CRON_SECRET ? String(process.env.CRON_SECRET).trim() : "";
  if (!secret) return;
  const auth = req.headers?.authorization || req.headers?.Authorization || "";
  if (auth !== `Bearer ${secret}`) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }
}

// ===== BTC Gate (STRICT) =====
function ema(values, period) {
  const k = 2 / (period + 1);
  let e = values[0] ?? 0;
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

async function getBTCGateStrict() {
  const j = await fetchJSON(
    "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=1&interval=hourly"
  );

  const prices = (j?.prices || [])
    .map(x => Number(x?.[1]))
    .filter(n => n > 0);

  if (prices.length < 15) {
    return { activeMode: "off", reason: "btc data too small" };
  }

  const last = prices[prices.length - 1];
  const p1h  = prices[prices.length - 2]  || last;
  const p4h  = prices[prices.length - 5]  || last;
  const p12h = prices[prices.length - 13] || last;

  const btc1h  = ((last - p1h) / p1h) * 100;
  const btc4h  = ((last - p4h) / p4h) * 100;
  const btc12h = ((last - p12h) / p12h) * 100;

  // EMA trend check
  const window = prices.slice(-24);
  const fast = ema(window, 5);
  const slow = ema(window, 13);
  const trendUp = fast > slow;
  const trendDown = fast < slow;

  const bullOk =
    btc1h  >= CFG.btcBull1hMin &&
    btc4h  >= CFG.btcBull4hMin &&
    btc12h >= CFG.btcBull12hMin &&
    trendUp;

  const bearOk =
    btc1h  <= CFG.btcBear1hMax &&
    btc4h  <= CFG.btcBear4hMax &&
    btc12h <= CFG.btcBear12hMax &&
    trendDown;

  const activeMode = bullOk ? "bull" : (bearOk ? "bear" : "off");

  return {
    activeMode,
    btc1h, btc4h, btc12h,
    emaFast: fast,
    emaSlow: slow
  };
}

// ===== Bitget symbols cache (zelfde als eerder) =====
async function fetchBitgetUsdtSymbols() {
  try {
    const r = await fetch("https://api.bitget.com/api/v2/spot/public/symbols", {
      headers: { "accept": "application/json" }
    });
    const j = await r.json().catch(() => ({}));
    const arr = j?.data;
    if (Array.isArray(arr) && arr.length) {
      const out = [];
      for (const it of arr) {
        const s = String(it?.symbol || it?.symbolName || "").toUpperCase();
        if (!s.includes("USDT")) continue;
        out.push(s.replace("_SPBL", ""));
      }
      if (out.length) return out;
    }
  } catch {}

  try {
    const r = await fetch("https://api.bitget.com/api/spot/v1/public/products", {
      headers: { "accept": "application/json" }
    });
    const j = await r.json().catch(() => ({}));
    const arr = j?.data;
    if (Array.isArray(arr) && arr.length) {
      const out = [];
      for (const it of arr) {
        const s = String(it?.symbolName || it?.symbol || "").toUpperCase();
        if (s.endsWith("USDT")) out.push(s);
      }
      if (out.length) return out;
    }
  } catch {}

  return [];
}

async function getBitgetUsdtSet() {
  const cacheKey = "bitget:usdt:symbols:v1";
  const cached = await kv.get(cacheKey);

  if (Array.isArray(cached) && cached.length) {
    return new Set(cached.map(s => String(s).toUpperCase()));
  }

  const symbols = await fetchBitgetUsdtSymbols();
  await kv.set(cacheKey, symbols);
  await kv.expire(cacheKey, 60 * 60 * 6);

  return new Set(symbols.map(s => String(s).toUpperCase()));
}

// ===== Orderbook score =====
async function fetchBitgetOrderbook(symbolUSDT) {
  const url = `https://api.bitget.com/api/v2/spot/market/orderbook?symbol=${encodeURIComponent(symbolUSDT)}&limit=50`;
  const r = await fetch(url, { headers: { "accept": "application/json" } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Bitget HTTP ${r.status}`);
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

async function calcObScore(symbolUSDT) {
  const data = await fetchBitgetOrderbook(symbolUSDT);
  const bids = data?.bids;
  const asks = data?.asks;
  if (!Array.isArray(bids) || !Array.isArray(asks) || !bids.length || !asks.length) {
    throw new Error("Bitget: empty bids/asks");
  }
  const bid = Number(bids[0][0]);
  const ask = Number(asks[0][0]);
  const mid = (bid + ask) / 2;
  if (!(mid > 0)) throw new Error("Bitget: invalid mid");

  const bidUsd = sumDepth(bids, mid, CFG.obDepthPct, true);
  const askUsd = sumDepth(asks, mid, CFG.obDepthPct, false);
  const score = (bidUsd + askUsd) > 0 ? (bidUsd - askUsd) / (bidUsd + askUsd) : 0;
  return { score };
}

// ===== filters =====
function range24hPct(c) {
  const hi = Number(c.high24) || 0;
  const lo = Number(c.low24) || 0;
  if (!(hi > 0 && lo > 0) || hi < lo) return 999;
  return ((hi - lo) / lo) * 100;
}

function basePass(c) {
  return (
    c.volume >= CFG.minVolumeUsd &&
    c.marketCap >= CFG.minMarketCap &&
    c.vm >= CFG.minVmRatio &&
    range24hPct(c) <= CFG.maxRange24hPct
  );
}

function dirOk(mode, c) {
  return mode === "bull" ? c.change24 > 0 : c.change24 < 0;
}

// ===== main =====
async function getMarketsTop() {
  return fetchJSON(
    "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=250&page=1&price_change_percentage=24h&sparkline=false"
  );
}

export default async function handler(req, res) {
  try {
    requireCronAuth(req);

    const gate = await getBTCGateStrict();
    const activeMode = gate.activeMode; // bull/bear/off

    // Als gate off is: we zetten beide uit => iedereen ziet dezelfde “geen update”
    const bullEnabled = activeMode === "bull";
    const bearEnabled = activeMode === "bear";

    const bitgetSet = await getBitgetUsdtSet();

    const raw = await getMarketsTop();
    const mapped = raw.map(mapCoin);

    // 1) Base filters + bitget pair check (dus geen 400’s)
    const pool = [];
    for (const c of mapped) {
      if (!basePass(c)) continue;
      const symbolUSDT = `${c.symbol}USDT`;
      if (!bitgetSet.has(symbolUSDT)) continue;
      pool.push({ ...c, bitgetOk: true, symbolUSDT });
    }

    // 2) beperk OB calls: top 70 op vm
    const candidates = [...pool].sort((a, b) => b.vm - a.vm).slice(0, 70);

    // 3) OB score erbij
    const withOB = [];
    for (const c of candidates) {
      try {
        const ob = await calcObScore(c.symbolUSDT);
        withOB.push({ ...c, obScore: ob.score });
      } catch {}
    }

    function build(mode, enabled) {
      if (!enabled) {
        return {
          ok: true,
          disabled: true,
          ts: Date.now(),
          mode,
          gate,
          reason: activeMode === "off" ? "BTC gate: OFF (geen duidelijke trend)" : `BTC gate: ${activeMode.toUpperCase()}`
        };
      }

      const radar = [];
      const buildup = [];
      const entry = [];
      const hold = [];
      const sell = [];

      for (const c of withOB) {
        radar.push(c);
        if (!dirOk(mode, c)) continue;

        buildup.push(c);

        const vmOK = c.vm >= CFG.entryVmMin;
        const obOK = mode === "bull" ? (c.obScore >= CFG.obBullMin) : (c.obScore <= CFG.obBearMax);

        if (vmOK && obOK) {
          entry.push(c);

          // simpele exit logica:
          // als 24h al mega is -> sell bucket
          if (Math.abs(c.change24) >= 25) sell.push(c);
          else hold.push(c);
        }
      }

      const byPower = (a, b) => (b.vm - a.vm) || (Math.abs(b.obScore) - Math.abs(a.obScore));
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
        gate,
        counts: {
          pool: pool.length,
          candidates: candidates.length,
          obOk: withOB.length,
          radar: radar.length,
          buildup: buildup.length,
          entry: entry.length,
          hold: hold.length,
          sell: sell.length
        },
        funnel: { entry, hold, sell, buildup, radar }
      };
    }

    const bullData = build("bull", bullEnabled);
    const bearData = build("bear", bearEnabled);

    await kv.set("latest:bull", bullData);
    await kv.set("latest:bear", bearData);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: true, activeMode, gate }));
  } catch (e) {
    res.statusCode = e?.statusCode || 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}
