export const config = { runtime: "nodejs" };

export const CFG = {
  // CoinGecko filters
  minVolumeUsd: 500_000,
  minMarketCap: 2_000_000,
  minVmRatio: 0.25,

  // Entry streng
  entryVm: 0.50,

  // Orderbook
  obDepthPct: 0.002,      // 0.2%
  obMinSamples: 5,
  obZ: 1.2,

  // Safety
  cgPages: 2,             // 2*250 = 500 coins
  cgPerPage: 250,
  httpTimeoutMs: 12_000
};

export async function fetchJSON(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), CFG.httpTimeoutMs);

  const r = await fetch(url, {
    signal: ctrl.signal,
    headers: {
      "accept": "application/json",
      "user-agent": "CryptoCrocScanner/1.0 (Vercel)"
    },
    cache: "no-store"
  }).catch((e) => {
    throw new Error(`Fetch failed: ${e?.message || String(e)}`);
  });

  clearTimeout(t);

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status} on ${url}${txt ? ` :: ${txt.slice(0, 120)}` : ""}`);
  }

  return r.json();
}

export function vmRatio(c) {
  const v = Number(c?.total_volume || 0);
  const mc = Number(c?.market_cap || 0);
  if (!(v > 0) || !(mc > 0)) return 0;
  return v / mc;
}

export function mapCoin(c) {
  const price = Number(c?.current_price || 0);
  const volume = Number(c?.total_volume || 0);
  const marketCap = Number(c?.market_cap || 0);
  const change24 = Number(c?.price_change_percentage_24h || 0);

  return {
    symbol: String(c?.symbol || "").toUpperCase(),
    price,
    volume,
    marketCap,
    change24,
    vm: vmRatio(c)
  };
}

export function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(obj));
}

export function mean(arr) {
  if (!arr?.length) return 0;
  let s = 0;
  for (const x of arr) s += Number(x) || 0;
  return s / arr.length;
}

export function std(arr) {
  if (!arr?.length || arr.length < 2) return 0;
  const m = mean(arr);
  let v = 0;
  for (const x of arr) {
    const d = (Number(x) || 0) - m;
    v += d * d;
  }
  return Math.sqrt(v / (arr.length - 1));
}
