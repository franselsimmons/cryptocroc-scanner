// /api/moon-scan.js
import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs" };

const CRON_SECRET = process.env.CRON_SECRET;

export default async function handler(req, res) {
  try {
    const { mode = "bull", token } = req.query;

    if (token !== CRON_SECRET) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const isBear = mode === "bear";

    // ===============================
    // 1. BTC TREND CHECK
    // ===============================
    const btcRes = await fetch(
      "https://api.coingecko.com/api/v3/coins/bitcoin?localization=false&tickers=false&market_data=true"
    );

    if (!btcRes.ok) {
      return res.json({ ok: false, error: "BTC fetch failed" });
    }

    const btcData = await btcRes.json();
    const btcChg = btcData.market_data.price_change_percentage_24h || 0;
    const btcRange =
      btcData.market_data.high_24h.usd -
      btcData.market_data.low_24h.usd;

    const btcState = btcChg < 0 ? "BEAR" : "BULL";

    // ===============================
    // 2. 250 COINS VANAF PAGINA 5
    // ===============================
    const marketRes = await fetch(
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=5&price_change_percentage=24h"
    );

    if (!marketRes.ok) {
      return res.json({ ok: false, error: "Markets fetch failed (rate limit?)" });
    }

    const coins = await marketRes.json();

    // ===============================
    // 3. RADAR (lichte selectie)
    // ===============================
    const radar = coins
      .map(c => {
        const vm = (c.total_volume || 0) / (c.market_cap || 1);
        const range24 =
          ((c.high_24h || 0) - (c.low_24h || 0)) /
          (c.low_24h || 1) * 100;

        return {
          id: c.id,
          symbol: c.symbol.toUpperCase(),
          name: c.name,
          price: c.current_price,
          change24: c.price_change_percentage_24h || 0,
          range24,
          volume: c.total_volume,
          marketCap: c.market_cap,
          vm,
        };
      })
      .filter(c =>
        c.marketCap > 5_000_000 &&
        c.marketCap < 150_000_000 &&
        c.vm > 0.15 &&
        c.range24 > 3
      );

    // ===============================
    // 4. BUILDUP (iets strenger)
    // ===============================
    const buildup = radar.filter(c =>
      c.vm >= 0.20 &&
      Math.abs(c.change24) > 1.5
    );

    // ===============================
    // 5. ALMOST (nog strenger)
    // ===============================
    const almost = buildup.filter(c =>
      c.vm >= 0.28 &&
      Math.abs(c.change24) > 2.5 &&
      c.range24 > 5
    );

    // ===============================
    // 6. ELITE (OB vereist)
    // ===============================
    // Tijdelijk simpele OB simulatie
    const elite = almost.filter(c =>
      c.vm >= 0.35 &&
      Math.abs(c.change24) > 3
    );

    const result = {
      ok: true,
      ts: Date.now(),
      mode,
      btc: {
        state: btcState,
        chg24: btcChg,
        range24: btcRange
      },
      counts: {
        radar: radar.length,
        buildup: buildup.length,
        almost: almost.length,
        elite: elite.length
      },
      funnel: {
        radar,
        buildup,
        almost,
        elite
      }
    };

    await kv.set(`moon:${mode}`, result);

    return res.json(result);

  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
}