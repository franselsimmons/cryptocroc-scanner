import { kv } from "@vercel/kv";

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

function topCoins(list, limit = 15) {
  return safeArray(list)
    .sort((a, b) => n(b?.perfectCandidateScore, 0) - n(a?.perfectCandidateScore, 0))
    .slice(0, limit)
    .map((c) => ({
      symbol: c.symbol,
      stage: c.stage,
      score: n(c.perfectCandidateScore, 0),
      confidence: n(c.confidence, 0),
      entryQuality: n(c.entryQuality, 0),
      spreadPct: n(c?.ob?.spreadPct, 0),
      depth: n(c?.ob?.depthMinUsd1p, 0),
      reason: c?.entry?.reason || c?.stageWhy || "",
    }));
}

export default async function handler(req, res) {
  try {
    const bull = await kv.get("main:latest:bull");
    const bear = await kv.get("main:latest:bear");

    const out = {
      ok: true,
      bull: bull
        ? {
            mode: "bull",
            regime: bull.regime || "",
            btc: bull.btc || null,
            counts: bull.counts || {},
            tradeReadyTop: topCoins(bull?.funnel?.trade_ready, 20),
            almostTop: topCoins(bull?.funnel?.almost, 20),
            buildupTop: topCoins(bull?.funnel?.buildup, 20),
          }
        : null,
      bear: bear
        ? {
            mode: "bear",
            regime: bear.regime || "",
            btc: bear.btc || null,
            counts: bear.counts || {},
            tradeReadyTop: topCoins(bear?.funnel?.trade_ready, 20),
            almostTop: topCoins(bear?.funnel?.almost, 20),
            buildupTop: topCoins(bear?.funnel?.buildup, 20),
          }
        : null,
      ts: Date.now(),
    };

    res.status(200).json(out);
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err?.message || String(err),
    });
  }
}