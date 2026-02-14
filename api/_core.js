import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs" };

// ====== V1 DEFAULTS (zoals besproken) ======
export const CFG = {
  // RADAR (breed)
  radarVolMin: 500_000,
  radarVmMin: 0.15,
  maxAbsChange24: 35,     // %
  maxRange24: 30,         // %

  // POOL
  mcapMin: 5_000_000,
  // mcapMax optioneel; als je 'm wil: zet bv 1_000_000_000

  // BUILDUP
  buildupChangeMin: 1.2,  // bull >= +1.2 / bear <= -1.2
  buildupVolMin: 1_200_000,
  buildupVmMin: 0.22,
  consistencyNeed: 0.67,  // 4/6

  // ALMOST (verplicht, met fast-track)
  almostVolMin: 2_000_000,
  almostVmMin: 0.26,
  priceFlatMax: 6.5,      // % range laatste 6 scans
  volAccMin: 0.12,        // (last3/prev3) - 1 >= 0.12

  // ENTRY
  entryAbsChangeMin: 2,   // %
  entryAbsChangeMax: 22,  // %
  lateMoveAbsMax: 35,     // uitzonder max
  lateMoveVmMin: 0.35,
  lateMoveObMin: 0.12,    // strenger dan 0.10

  // BTC gate (simple & Vercel-proof)
  btcChangeGate: 0.8,     // %
  btcRangeMin: 2,         // %
  btcRangeBullMax: 8,     // %
  btcRangeBearMax: 10,    // %

  // ORDERBOOK sampling (90 sec echt)
  obDepthPct: 0.002,        // 0.2%
  obStaleSec: 15,           // OB data ouder dan 15s => stale
  obWindowSec: 90,          // 3 samples binnen 90s
  obNeedSamples: 3,         // exact 3
  obNeedDirection: 2,       // 2/3 zelfde richting
  obScoreMin: 0.06,         // bull >= +0.06 ; bear <= -0.06
  spreadMaxEntry: 0.55,     // %
  largestOrderRatioMax: 0.35 // anti “1 mega order”
};

// ====== helpers ======
export async function fetchJSON(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { "accept": "application/json", ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`Fetch failed ${r.status} for ${url}`);
  return r.json();
}

export function vmRatio(c) {
  const mc = Number(c.market_cap || 0);
  const vol = Number(c.total_volume || 0);
  if (!mc) return 0;
  return vol / mc;
}

export function mapCoin(c) {
  const price = Number(c.current_price || 0);
  const high24 = Number(c.high_24h || 0);
  const low24 = Number(c.low_24h || 0);
  const range24 = price > 0 ? ((high24 - low24) / price) * 100 : 0;

  return {
    id: c.id,
    symbol: String(c.symbol || "").toUpperCase(),
    name: c.name,
    price,
    volume: Number(c.total_volume || 0),
    marketCap: Number(c.market_cap || 0),
    change24: Number(c.price_change_percentage_24h || 0),
    high24,
    low24,
    range24,
    vm: vmRatio(c)
  };
}

// ====== KV index (voor reset) ======
// we houden een set bij met alle keys die we gebruiken,
// zodat reset echt alles kan wissen.
const INDEX_KEY = "idx:keys";

export async function kvIndexAdd(key) {
  await kv.sadd(INDEX_KEY, key);
}

export async function kvSet(key, value, opts = {}) {
  await kv.set(key, value, opts);
  await kvIndexAdd(key);
}

export async function kvDelAllIndexed() {
  const keys = await kv.smembers(INDEX_KEY);
  if (keys && keys.length) {
    // delete in chunks
    const chunkSize = 200;
    for (let i = 0; i < keys.length; i += chunkSize) {
      const chunk = keys.slice(i, i + chunkSize);
      await kv.del(...chunk);
    }
  }
  // delete index itself
  await kv.del(INDEX_KEY);
}
