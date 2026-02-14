export const config = { runtime: "nodejs" };

export const CFG = {
  // ===== Basis filters =====
  minVolumeUsd: 800000,      // strenger dan 500k
  minMarketCap: 5000000,     // strenger dan 2m
  minVmRatio: 0.30,          // iets strenger dan 0.25

  // ===== Anti “te gek” spikes (CG range filter in scan.js gebruikt dit) =====
  maxRange24hPct: 55,        // coins met extreme 24h range skippen

  // ===== Orderbook =====
  obDepthPct: 0.002,
  obMinSamples: 5,

  // OB drempels (strenger)
  obBullMin: 0.10,           // was 0.08
  obBearMax: -0.10,          // was -0.08

  // ===== Entry drempel =====
  entryVmMin: 0.60,          // was 0.50 (strenger)

  // ===== BTC Gate (STRIKT) =====
  // Bull alleen als ALLES bull is:
  // - 1h >= +0.20%
  // - 4h >= +0.40%
  // - 12h >= +0.80%
  // - EMA fast boven EMA slow
  btcBull1hMin: 0.20,
  btcBull4hMin: 0.40,
  btcBull12hMin: 0.80,

  // Bear alleen als ALLES bear is:
  // - 1h <= -0.20%
  // - 4h <= -0.40%
  // - 12h <= -0.80%
  // - EMA fast onder EMA slow
  btcBear1hMax: -0.20,
  btcBear4hMax: -0.40,
  btcBear12hMax: -0.80
};

export async function fetchJSON(url) {
  const r = await fetch(url, { headers: { "accept": "application/json" } });
  const txt = await r.text();
  let j = {};
  try { j = JSON.parse(txt); } catch {}
  if (!r.ok) throw new Error(`Fetch failed ${r.status}: ${txt.slice(0, 180)}`);
  return j;
}

export function vmRatio(c) {
  return (Number(c.total_volume) || 0) / (Number(c.market_cap) || 1);
}

export function mapCoin(c) {
  return {
    id: c.id,
    symbol: String(c.symbol || "").toUpperCase(),
    name: c.name || "",
    price: Number(c.current_price) || 0,
    volume: Number(c.total_volume) || 0,
    marketCap: Number(c.market_cap) || 0,
    change24: Number(c.price_change_percentage_24h) || 0,
    vm: vmRatio(c),
    high24: Number(c.high_24h) || 0,
    low24: Number(c.low_24h) || 0
  };
}
