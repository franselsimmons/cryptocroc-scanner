import { kv } from "@vercel/kv";
import {
  fetchCoinGeckoTopCached,
  fetchContractConfigs,
  fetchFuturesTickers,
  generateShallowOb,
  calculateFuturesSize
} from "../lib/_main_shared.js";

export default async function handler(req, res) {
  const mode = req.query?.mode || "bull";
  const CORE = mode === "bear"
    ? await import("../lib/_core_bear.js")
    : await import("../lib/_core_bull.js");

  const [coins, tickers, configs] = await Promise.all([
    fetchCoinGeckoTopCached(),
    fetchFuturesTickers(),
    fetchContractConfigs()
  ]);

  const queue = [];

  for (const coin of coins) {
    const sym = coin.symbol.toUpperCase();
    const t = tickers.get(`${sym}USDT`);
    const cfg = configs.get(`${sym}USDT`);
    if (!t || !cfg) continue;

    const ob = generateShallowOb(t);
    if (ob.spreadPct > 2.5) continue;

    const score = CORE.preScoreCoin(coin);

    if (score.stage === "ENTRY_READY") {
      const entry = coin.current_price;
      const sl = entry * 0.95;
      const tp = entry * 1.1;

      const size = calculateFuturesSize(entry, sl, 50, cfg);

      if (size > 0) {
        queue.push({
          symbol: sym,
          side: "LONG",
          sourceSystem: "main",
          stage: score.stage,
          confidence: score.confidence,
          ob,
          tradePlan: { entry, sl, tp, size },
          queuedAt: Date.now()
        });
      }
    }
  }

  if (queue.length) {
    await kv.lpush(`trade_funnel:raw_queue:${mode}`, ...queue);
  }

  res.json({ ok: true, forwarded: queue.length });
}