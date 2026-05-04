// lib/funding.js

const FUNDING_CACHE = new Map();
const FUNDING_IN_FLIGHT = new Map();

const FUNDING_CACHE_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 7_000;

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeSymbol(symbol) {
  const clean = String(symbol || "")
    .trim()
    .toUpperCase()
    .replace(/_UMCBL$/, "")
    .replace(/_DMCBL$/, "")
    .replace(/_CMCBL$/, "")
    .replace(/-UMCBL$/, "")
    .replace(/-DMCBL$/, "")
    .replace(/-CMCBL$/, "");

  if (!clean) return "";

  return clean.endsWith("USDT")
    ? clean
    : `${clean}USDT`;
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

    const json = await res.json().catch(() => null);

    if (!res.ok) {
      throw new Error(`funding_http_${res.status}`);
    }

    return json;
  } finally {
    clearTimeout(timeout);
  }
}

function extractFundingRate(json) {
  return safeNumber(
    json?.data?.fundingRate ??
      json?.data?.currentFundRate ??
      json?.data?.fundRate ??
      json?.data?.[0]?.fundingRate ??
      0,
    0
  );
}

function buildFundingContext(rate, side = null) {
  const normalizedSide = String(side || "").toLowerCase();

  let bias = "NEUTRAL";
  let runnerScore = 0;

  if (normalizedSide === "bull") {
    if (rate < 0) {
      bias = "BULLISH_CONTRARIAN";
      runnerScore = 6;
    } else if (rate > 0.015) {
      bias = "LONG_CROWDED";
      runnerScore = -6;
    }
  }

  if (normalizedSide === "bear") {
    if (rate > 0) {
      bias = "BEARISH_CONTRARIAN";
      runnerScore = 6;
    } else if (rate < -0.015) {
      bias = "SHORT_CROWDED";
      runnerScore = -6;
    }
  }

  if (Math.abs(rate) > 0.03) {
    runnerScore -= 4;
  }

  return {
    rate,
    bias,
    runnerScore,
    extreme: Math.abs(rate) > 0.03
  };
}

// ================= FUNDING DATA =================
export async function fetchFunding(symbol, options = {}) {
  const clean = normalizeSymbol(symbol);

  if (!clean) {
    return { rate: 0, bias: "UNKNOWN", runnerScore: 0, extreme: false };
  }

  const side = options.side || null;
  const now = Date.now();

  const cached = FUNDING_CACHE.get(clean);
  if (cached && now - cached.ts < FUNDING_CACHE_MS) {
    return {
      ...cached.data,
      ...buildFundingContext(cached.data.rate, side)
    };
  }

  if (FUNDING_IN_FLIGHT.has(clean)) {
    return FUNDING_IN_FLIGHT.get(clean);
  }

  const promise = (async () => {
    try {
      const url = [
        "https://api.bitget.com/api/v2/mix/market/current-fund-rate",
        `?symbol=${encodeURIComponent(clean)}`,
        "&productType=usdt-futures"
      ].join("");

      const json = await fetchJsonWithTimeout(url);

      if (!json || (json.code !== undefined && json.code !== "00000")) {
        return buildFundingContext(0, side);
      }

      const rate = extractFundingRate(json);
      const data = buildFundingContext(rate, side);

      FUNDING_CACHE.set(clean, {
        ts: Date.now(),
        data
      });

      return data;
    } catch {
      return buildFundingContext(0, side);
    } finally {
      FUNDING_IN_FLIGHT.delete(clean);
    }
  })();

  FUNDING_IN_FLIGHT.set(clean, promise);

  return promise;
}

export function clearFundingCache() {
  FUNDING_CACHE.clear();
  FUNDING_IN_FLIGHT.clear();

  return {
    ok: true,
    cleared: true,
    at: Date.now()
  };
}