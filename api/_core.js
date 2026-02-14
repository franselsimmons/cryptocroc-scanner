export const config = { runtime: "nodejs" };

export const CFG = {
  // --- BTC gate (v1 defaults) ---
  btcBullChange24: 0.8,     // bull als >= +0.8%
  btcBearChange24: 0.8,     // bear als <= -0.8%
  btcRangeMin: 2.0,         // minimaal 2% range24
  btcBullRangeMax: 8.0,     // bull max range
  btcBearRangeMax: 10.0,    // bear max range

  // --- Pool / RADAR ---
  pool: {
    mcapMin: 5_000_000,
    volMinRadar: 500_000,
    vmMinRadar: 0.15,
    maxAbsChange24: 35,
    maxRange24: 30,
    radarMax: 160
  },

  // --- Stages ---
  stage: {
    buildupChangeMin: 1.2,
    buildupVmMin: 0.22,
    buildupVolMin: 1_200_000,

    almostVmMin: 0.26,
    almostVolMin: 2_000_000,

    entryAbsMin: 2,
    entryAbsMax: 22,
    entryLateAbsMax: 35,
    entryLateVmMin: 0.35,
    entryLateObMin: 0.12
  },

  // --- Orderbook gates ---
  ob: {
    // jouw v1 keuze: killers maar niet te extreem
    scoreMinAbs: 0.06,
    spreadMaxEntry: 0.55,
    largestOrderRatioMax: 0.35,

    // stale
    obStaleSec: 15
  }
};

// helpers (laat je bestaande staan)
export async function fetchJSON(url){
  const r = await fetch(url);
  if(!r.ok) throw new Error(`Fetch failed (${r.status})`);
  return r.json();
}

export function vmRatio(c){
  return c.total_volume / c.market_cap;
}

export function mapCoin(c){
  return {
    symbol: c.symbol.toUpperCase(),
    price: c.current_price,
    volume: c.total_volume,
    marketCap: c.market_cap,
    change24: c.price_change_percentage_24h,
    vm: vmRatio(c)
  };
}