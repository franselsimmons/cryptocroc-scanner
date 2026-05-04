// lib/dominance.js

const DOMINANCE_CACHE_TTL_MS = 5 * 60 * 1000;

let cachedDominance = 50;
let expiresAt = 0;
let inFlight = null;

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function fetchGlobalData() {
  const res = await fetch("https://api.coingecko.com/api/v3/global", {
    headers: { accept: "application/json" }
  });

  if (!res.ok) {
    throw new Error(`coingecko_global_http_${res.status}`);
  }

  return res.json();
}

export async function fetchBtcDominance() {
  const now = Date.now();

  if (expiresAt > now) {
    return cachedDominance;
  }

  if (inFlight) {
    return inFlight;
  }

  inFlight = (async () => {
    try {
      const json = await fetchGlobalData();
      const dominance = safeNumber(json?.data?.market_cap_percentage?.btc, cachedDominance);

      cachedDominance = dominance > 0 ? dominance : cachedDominance;
      expiresAt = Date.now() + DOMINANCE_CACHE_TTL_MS;

      return cachedDominance;
    } catch (err) {
      console.error("BTC DOMINANCE ERROR:", err?.message || err);
      return cachedDominance;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

// Compat: oude code kan btcDominance() sync blijven gebruiken.
// Deze geeft de laatst bekende waarde terug.
export function btcDominance() {
  return cachedDominance;
}

export function getDominanceContext() {
  const dominance = btcDominance();

  let state = "NEUTRAL";

  if (dominance >= 55) state = "BTC_HEAVY";
  else if (dominance <= 45) state = "ALT_FRIENDLY";

  return {
    dominance,
    state,
    updated: expiresAt > Date.now(),
    expiresAt
  };
}