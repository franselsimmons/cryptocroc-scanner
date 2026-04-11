import { kv } from "@vercel/kv";
import { fetchBTCGateFromUniverse, fetchCoinGeckoTopCached } from "../lib/_data_fetchers.js";
import { generateShallowOb, toFunnelCoin, preScoreMainCoin } from "../lib/_scanner_helpers.js";
import { decideMoonStage } from "../lib/_moon_core.js";

const BITGET_FUTURES_TICKERS =
  "https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES";

export default async function handler(req, res) {
  const mode = req.query?.mode || "bull";
  const now = Date.now();

  try {
    const btc = await fetchBTCGateFromUniverse();
    const cg = await fetchCoinGeckoTopCached(300);

    const tickersRes = await fetch(BITGET_FUTURES_TICKERS).then(r => r.json());
    const validFutures = new Map(
      tickersRes.data.map(t => [t.symbol.replace("USDT", ""), t])
    );

    const tradable = cg.coins.filter(c =>
      validFutures.has(c.symbol.toUpperCase())
    );

    const funnelQueue = [];
    const eventQueue = [];

    for (const coin of tradable) {
      const sym = coin.symbol.toUpperCase();
      const ticker = validFutures.get(sym);

      const ob = generateShallowOb(ticker);

      if (ob.spreadPct > 2.5) continue;

      // ===== MAIN =====
      const main = preScoreMainCoin(coin, mode);
      if (main.stage === "ENTRY_READY") {
        funnelQueue.push(
          toFunnelCoin(
            { ...coin, ...main, ob },
            "main",
            mode,
            now
          )
        );
      }

      // ===== MOON =====
      if (ob.spreadPct < 1.8) {
        const moon = decideMoonStage({ coin, btc, mode, obx: ob });

        if (moon.stage.includes("ELITE") || moon.stage === "ALMOST") {
          funnelQueue.push(
            toFunnelCoin(
              { ...coin, ...moon, ob },
              "moon",
              mode,
              now
            )
          );

          eventQueue.push({
            priority: 3,
            type: "STAGE_UPGRADE",
            symbol: sym,
            data: {
              stage: moon.stage,
              price: coin.price,
              system: "moon"
            }
          });
        }
      }
    }

    if (funnelQueue.length) {
      await kv.lpush(`trade_funnel:raw_queue:${mode}`, ...funnelQueue);
    }

    if (eventQueue.length) {
      const multi = kv.multi();
      let nonce = 0;

      for (const ev of eventQueue) {
        const score = (ev.priority * 1e13) + (now * 1000) + (nonce++ % 1000);
        multi.zadd("system:events:queue", {
          score,
          member: JSON.stringify(ev)
        });
      }

      await multi.exec();
    }

    res.status(200).json({
      ok: true,
      scanned: tradable.length,
      forwarded: funnelQueue.length
    });

  } catch (err) {
    console.error("Scanner error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
}