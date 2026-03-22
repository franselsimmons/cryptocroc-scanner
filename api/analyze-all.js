import { kv } from "@vercel/kv";

const SECRET = process.env.SECRET || "lara-roos";
const BASE = process.env.BASE_URL;

// =============================
// AUTH
// =============================
function requireSecret(req, res) {
  const s = req.query?.secret;
  if (!s || s !== SECRET) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}

// =============================
// SCORE ENGINE (LERAAR)
// =============================
function scoreField(value, min, good) {
  if (value >= good) return 9;
  if (value >= min) return 6;
  return 3;
}

function analyzeCoin(coin) {
  if (!coin) return null;

  const scores = {
    quality: scoreField(coin.qualityScore || 0, 60, 75),
    liquidity: scoreField(coin.liquidityScore || 0, 55, 70),
    timing: scoreField(coin.timingScore || 0, 55, 70),
    market: scoreField(coin.marketScore || 0, 40, 60),
  };

  const bottlenecks = [];
  const advice = [];

  if (scores.quality < 7) {
    bottlenecks.push("kwaliteit te laag");
    advice.push("wacht op sterkere setup (entryQuality ↑)");
  }

  if (scores.liquidity < 7) {
    bottlenecks.push("liquiditeit zwak");
    advice.push("vermijd lage depth / slechte orderbook");
  }

  if (scores.timing < 7) {
    bottlenecks.push("timing niet goed");
    advice.push("wacht op breakout of volume confirmatie");
  }

  if (scores.market < 7) {
    bottlenecks.push("markt tegen");
    advice.push("trade alleen met BTC richting mee");
  }

  return {
    symbol: coin.symbol,
    stage: coin.stage,
    score: Math.round(
      (scores.quality + scores.liquidity + scores.timing + scores.market) / 4
    ),
    bottlenecks,
    advice,
  };
}

// =============================
// FILTER → alleen problemen
// =============================
function extractProblems(list) {
  if (!Array.isArray(list)) return [];

  return list
    .map(analyzeCoin)
    .filter(x => x && x.score < 8) // alleen zwakke plekken
    .slice(0, 15);
}

// =============================
// FETCH HELPER
// =============================
async function safeFetch(url) {
  try {
    const res = await fetch(url);
    return await res.json();
  } catch {
    return null;
  }
}

// =============================
// MAIN HANDLER
// =============================
export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    // =============================
    // DATA OPHALEN
    // =============================
    const main = await safeFetch(
      `${BASE}/api/analyze-main?secret=${SECRET}`
    );

    const moonBull = await safeFetch(
      `${BASE}/api/moon?mode=bull&secret=${SECRET}`
    );

    const moonBear = await safeFetch(
      `${BASE}/api/moon?mode=bear&secret=${SECRET}`
    );

    const trade = await safeFetch(
      `${BASE}/api/trade?secret=${SECRET}`
    );

    // =============================
    // ANALYSE PER SYSTEEM
    // =============================
    const result = {
      ok: true,
      ts: Date.now(),

      main: {
        problems: extractProblems(main?.candidates?.premium),
      },

      moon: {
        bull: {
          problems: extractProblems(moonBull?.candidates?.premium),
        },
        bear: {
          problems: extractProblems(moonBear?.candidates?.premium),
        },
      },

      trade: {
        problems: extractProblems(trade?.candidates?.premium),
      },
    };

    res.status(200).json(result);

  } catch (err) {
    console.error("analyze-all error:", err);
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
}