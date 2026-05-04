// lib/marketContext.js

const CACHE_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 7_000;

let cached = null;
let expiresAt = 0;
let inFlight = null;

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function fetchJsonWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json"
      }
    });

    if (!res.ok) {
      throw new Error(`market_context_http_${res.status}`);
    }

    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

function buildContext(dominance) {
  let trend = "NEUTRAL";
  let runnerBias = "BALANCED";

  if (dominance > 54) {
    trend = "BTC_STRONG";
    runnerBias = "BTC_HEAVY";
  } else if (dominance < 48) {
    trend = "ALTS_STRONG";
    runnerBias = "ALT_RUNNER_OK";
  } else if (dominance < 50) {
    trend = "ALTS_FIRM";
    runnerBias = "ALT_RUNNER_FRIENDLY";
  }

  return {
    dominance,
    trend,
    runnerBias,
    profile: "RUNNER",
    updatedAt: Date.now()
  };
}

export async function getMarketContext() {
  const now = Date.now();

  if (cached && expiresAt > now) {
    return cached;
  }

  if (inFlight) {
    return inFlight;
  }

  inFlight = (async () => {
    try {
      const data = await fetchJsonWithTimeout("https://api.coingecko.com/api/v3/global");

      const dominance = safeNumber(
        data?.data?.market_cap_percentage?.btc,
        50
      );

      cached = buildContext(dominance);
      expiresAt = Date.now() + CACHE_MS;

      return cached;
    } catch {
      cached = cached || buildContext(50);
      return cached;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

export function getCachedMarketContext() {
  return cached || buildContext(50);
}

export function clearMarketContextCache() {
  cached = null;
  expiresAt = 0;
  inFlight = null;

  return {
    ok: true,
    cleared: true,
    at: Date.now()
  };
}