import { kv } from "@vercel/kv";
import { CFG, fetchJSON, mapCoin, json } from "./_core.js";

export const config = { runtime: "nodejs" };

async function getCoinGeckoMarkets() {
  const all = [];
  for (let page = 1; page <= CFG.cgPages; page++) {
    const url =
      `https://api.coingecko.com/api/v3/coins/markets` +
      `?vs_currency=usd&order=volume_desc&per_page=${CFG.cgPerPage}&page=${page}` +
      `&price_change_percentage=24h`;
    const part = await fetchJSON(url);
    if (Array.isArray(part)) all.push(...part);
  }
  return all;
}

// Dit is de “kern” functie: cron gebruikt deze ook
export async function runScan(mode) {
  const markets = await getCoinGeckoMarkets();
  const mapped = markets.map(mapCoin).filter(c => c.symbol);

  // basis filters (jouw “pool”)
  const pool = mapped.filter(c =>
    c.volume >= CFG.minVolumeUsd &&
    c.marketCap >= CFG.minMarketCap &&
    c.vm >= CFG.minVmRatio
  );

  // Funnel buckets
  const radar = [];
  const buildup = [];
  const entry = [];

  for (const c of pool) {
    // Radar = alles dat door basis komt
    radar.push(c);

    // Buildup = richting van de mode
    if (mode === "bull" && c.change24 > 0) buildup.push(c);
    if (mode === "bear" && c.change24 < 0) buildup.push(c);

    // Entry = strengere VM
    if (mode === "bull" && c.change24 > 0 && c.vm >= CFG.entryVm) entry.push(c);
    if (mode === "bear" && c.change24 < 0 && c.vm >= CFG.entryVm) entry.push(c);
  }

  // Sort: Entry bovenaan “hardste”
  entry.sort((a, b) => (b.vm - a.vm));
  buildup.sort((a, b) => (b.vm - a.vm));
  radar.sort((a, b) => (b.vm - a.vm));

  // (optioneel) beperk UI payload
  const cap = (arr, n) => arr.slice(0, n);

  const result = {
    ok: true,
    ts: Date.now(),
    mode,
    counts: {
      pool: pool.length,
      radar: radar.length,
      buildup: buildup.length,
      entry: entry.length
    },
    funnel: {
      entry: cap(entry, 80),
      buildup: cap(buildup, 120),
      radar: cap(radar, 160)
    }
  };

  await kv.set(`latest:${mode}`, result);
  return result;
}

export default async function handler(req, res) {
  try {
    const u = new URL(req.url, "http://localhost");
    const mode = (u.searchParams.get("mode") || "bull").toLowerCase();
    if (mode !== "bull" && mode !== "bear") return json(res, 400, { ok: false, error: "mode must be bull or bear" });

    const out = await runScan(mode);
    return json(res, 200, out);
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e?.message || e) });
  }
}
