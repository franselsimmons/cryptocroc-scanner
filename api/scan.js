import { kv } from "@vercel/kv";
import { CFG, fetchJSON, mapCoin, getBitgetUsdtSet, json } from "./_core.js";

async function getMarkets(page = 1) {
  // volume_desc + 250 is prima. Je kan later pages uitbreiden.
  const url =
    "https://api.coingecko.com/api/v3/coins/markets" +
    "?vs_currency=usd&order=volume_desc&per_page=250&page=" + page +
    "&price_change_percentage=24h";
  return fetchJSON(url);
}

function passesBaseFilters(c) {
  return (
    c.volume >= CFG.minVolumeUsd &&
    c.marketCap >= CFG.minMarketCap &&
    c.vm >= CFG.minVmRatio
  );
}

export default async function handler(req, res) {
  try {
    const u = new URL(req.url, "http://localhost");
    const mode = (u.searchParams.get("mode") || "bull").toLowerCase();
    if (mode !== "bull" && mode !== "bear") return json(res, 400, { error: "mode must be bull|bear" });

    const raw = await getMarkets(1);
    const mapped = (Array.isArray(raw) ? raw : []).map(mapCoin).filter(Boolean);

    // Bitget-only filter
    const bitgetSet = await getBitgetUsdtSet();
    const bitgetFiltered = bitgetSet
      ? mapped.filter(c => bitgetSet.has(c.symbol))
      : mapped;

    const filtered = bitgetFiltered.filter(passesBaseFilters);

    // Funnel (simpel en strak, jij kan later uitbreiden)
    const radar = [];
    const buildup = [];
    const entry = [];
    const hold = [];
    const sell = [];

    for (const c of filtered) {
      const dirOk = mode === "bull" ? (c.change24 > 0) : (c.change24 < 0);
      if (!dirOk) continue;

      // radar = basis kandidaat
      radar.push(c);

      // buildup = sterker (vm hoger + volume)
      if (c.vm >= 0.35) buildup.push(c);

      // entry = agressiever
      if (c.vm >= 0.50) entry.push(c);

      // hold/sell heuristiek (super simpel, maar bruikbaar)
      if (mode === "bull") {
        if (c.change24 >= 8) hold.push(c);
        if (c.change24 <= -2) sell.push(c);
      } else {
        if (c.change24 <= -8) hold.push(c);
        if (c.change24 >= 2) sell.push(c);
      }
    }

    const result = {
      ts: Date.now(),
      mode,
      bitgetOnly: Boolean(bitgetSet),
      counts: {
        pool: mapped.length,
        filtered: filtered.length
      },
      funnel: { entry, hold, buildup, radar, sell }
    };

    await kv.set(`latest:${mode}`, result);
    return json(res, 200, result);
  } catch (e) {
    return json(res, 500, { error: String(e) });
  }
}
