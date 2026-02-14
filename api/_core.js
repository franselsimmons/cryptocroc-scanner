import { kv } from "@vercel/kv";

export const CFG = {
  // CoinGecko filters
  minVolumeUsd: 500000,
  minMarketCap: 2000000,
  minVmRatio: 0.25,

  // Bitget orderbook score
  obDepthPct: 0.002,
  obMinSamples: 5,
  obZ: 1.2,

  // caching
  bitgetSymbolsCacheMs: 6 * 60 * 60 * 1000 // 6 uur
};

export async function fetchJSON(url, { timeoutMs = 12000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "accept": "application/json" } });
    if (!r.ok) throw new Error(`Fetch failed ${r.status} for ${url}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

export function vmRatio(c) {
  const v = Number(c?.total_volume || 0);
  const mc = Number(c?.market_cap || 0);
  if (mc <= 0) return 0;
  return v / mc;
}

export function mapCoin(c) {
  return {
    id: c.id,
    symbol: String(c.symbol || "").toUpperCase(),
    price: Number(c.current_price || 0),
    volume: Number(c.total_volume || 0),
    marketCap: Number(c.market_cap || 0),
    change24: Number(c.price_change_percentage_24h || 0),
    vm: vmRatio(c)
  };
}

/**
 * Bitget USDT symbols ophalen zodat we ALLEEN coins tonen waarvan OB werkt.
 * Endpoint is "public/products". Als Bitget ooit wijzigt: we fail-safe (geen crash).
 */
export async function getBitgetUsdtSet() {
  const key = "bitget:usdtSet:v1";
  const cached = await kv.get(key);
  const cachedTs = await kv.get(key + ":ts");
  if (cached && cachedTs && (Date.now() - Number(cachedTs)) < CFG.bitgetSymbolsCacheMs) {
    return new Set(cached);
  }

  try {
    const j = await fetchJSON("https://api.bitget.com/api/spot/v1/public/products");
    const arr = j?.data || j?.result || [];
    const set = new Set();

    for (const p of arr) {
      // Bitget heeft meerdere veldnamen; we pakken wat er is.
      const sym = (p?.symbolName || p?.symbol || p?.baseCoin || "").toString();
      const quote = (p?.quoteCoin || p?.quote || "").toString().toUpperCase();
      const status = (p?.status || p?.state || "").toString().toUpperCase();

      // We willen spot USDT paren die actief zijn
      if (quote === "USDT" && sym) {
        // sym kan bv "BTCUSDT" of "BTC" zijn; wij willen base symbol (BTC)
        if (sym.toUpperCase().endsWith("USDT")) set.add(sym.toUpperCase().replace("USDT",""));
        else set.add(sym.toUpperCase());
      } else if (sym && sym.toUpperCase().endsWith("USDT")) {
        set.add(sym.toUpperCase().replace("USDT",""));
      }

      // status check doen we niet hard, want veld kan missen.
      void status;
    }

    const list = Array.from(set);
    await kv.set(key, list);
    await kv.set(key + ":ts", String(Date.now()));
    return new Set(list);
  } catch (e) {
    // fail-safe: geen crash, maar dan is Bitget-only filtering uit
    return null;
  }
}

export function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}
