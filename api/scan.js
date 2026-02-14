import { CFG, fetchJSON, mapCoin } from "./_core.js";
import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs" };

async function getMarkets() {
  // 250 coins (volume_desc). Later kunnen we pagina 2/3 toevoegen als je wil.
  return fetchJSON(
    "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=250&page=1&price_change_percentage=24h"
  );
}

function passesBaseFilters(c) {
  return (
    c.volume > CFG.minVolumeUsd &&
    c.marketCap > CFG.minMarketCap &&
    c.vm > CFG.minVmRatio
  );
}

export default async function handler(req, res) {
  try {
    const u = new URL(req.url, "http://localhost");
    const mode = (u.searchParams.get("mode") || "bull").toLowerCase();
    if (mode !== "bull" && mode !== "bear") {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: "mode must be bull or bear" }));
      return;
    }

    const markets = await getMarkets();
    const mapped = markets.map(mapCoin);

    const pool = mapped.filter(passesBaseFilters);

    // 4 “blokken”:
    // 1) ENTRY (intern: entry/hold/sell tabs)
    // 2) BUILDUP
    // 3) RADAR
    // 4) (ENTRY is boven, RADAR onder, precies zoals jij wil in UI)
    const radar = [];
    const buildup = [];
    const entry = [];
    const hold = [];
    const sell = [];

    for (const c of pool) {
      radar.push(c);

      const dirOk = (mode === "bull") ? (c.change24 > 0) : (c.change24 < 0);
      if (dirOk) buildup.push(c);

      // ENTRY threshold (jouw snelle variant)
      if (dirOk && c.vm >= 0.5) {
        // simpele exit/hold logica op basis van 24h move:
        // bull: huge pump => sell
        // bear: huge dump => sell (take profit)
        const bigMove = Math.abs(c.change24) >= 25;

        if (bigMove) sell.push(c);
        else hold.push(c);

        entry.push(c); // entry is “alles wat entry-level haalt”
      }
    }

    // Sort (mooi in UI): hoogste VM eerst
    const byVmDesc = (a, b) => (b.vm - a.vm);
    radar.sort(byVmDesc);
    buildup.sort(byVmDesc);
    entry.sort(byVmDesc);
    hold.sort(byVmDesc);
    sell.sort(byVmDesc);

    const result = {
      ok: true,
      ts: Date.now(),
      mode,
      counts: {
        pool: pool.length,
        radar: radar.length,
        buildup: buildup.length,
        entry: entry.length,
        hold: hold.length,
        sell: sell.length
      },
      funnel: {
        entry,
        hold,
        sell,
        buildup,
        radar
      }
    };

    await kv.set(`latest:${mode}`, result);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(result));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}
