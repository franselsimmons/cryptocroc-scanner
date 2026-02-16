// /api/moon-scan.js
import { kv } from "@vercel/kv";
import {
  RUNTIME_CONFIG,
  requireSecret,
  MOON,
  keyMoonLatest,
  fetchBTCGateCached,
  fetchCoinGeckoTopCached,
  getBitgetSpotUsdtSymbols,
  passRadarMoon,
} from "./_moon_core.js";

export const config = RUNTIME_CONFIG;

export default async function handler(req, res) {
  try {
    // ✅ beveiliging (token of x-vercel-cron)
    if (!requireSecret(req, res)) return;

    const modeRaw = String(req.query?.mode || "bull").toLowerCase();
    const mode = modeRaw === "bear" ? "bear" : "bull";

    // ===============================
    // 1) BTC GATE (cached, % range)
    // ===============================
    const btc = await fetchBTCGateCached(); // { state, chg24, range24 }

    // ===============================
    // 2) COINGECKO SLICE (250 coins vanaf pagina 5)
    // ===============================
    const cg = await fetchCoinGeckoTopCached(); // gebruikt MOON.CG_START_PAGE/CG_PER_PAGE/CG_PAGES

    // ===============================
    // 3) BITGET SPOT USDT SYMBOLS (filter: alleen coins die op Bitget bestaan)
    // ===============================
    const bitgetSet = await getBitgetSpotUsdtSymbols();

    // ===============================
    // 4) RADAR (jouw moon radar filter)
    // ===============================
    const radar = cg
      .filter((c) => bitgetSet.has(String(c.symbol || "").toUpperCase()))
      .filter((c) => passRadarMoon(c, mode))
      .slice(0, MOON.RADAR_LIMIT);

    // ===============================
    // 5) BUILDUP / ALMOST / ELITE
    // (Moon funnel wordt vooral “echt” zodra OB-sampler heeft gedraaid.
    // Voor nu: we laten coins doorstromen op basis van simpele regels,
    // en OB/confidence komen later via moon-ob-sampler + extra KV state.)
    // ===============================
    const buildup = radar.filter((c) => Math.abs(Number(c.change24 || 0)) >= 1.5);

    const almost = buildup.filter((c) => {
      const vm = Number(c.vm || 0);
      const rng = Number(c.range24 || 0);
      const chg = Math.abs(Number(c.change24 || 0));
      return vm >= 0.20 && chg >= 2.0 && rng >= 4.0;
    });

    const elite = almost.filter((c) => {
      const vm = Number(c.vm || 0);
      const chg = Math.abs(Number(c.change24 || 0));
      return vm >= 0.28 && chg >= 3.0;
    });

    // ===============================
    // 6) RESULT OBJECT (exact wat moon.js verwacht)
    // ===============================
    const result = {
      ok: true,
      ts: Date.now(),
      mode,
      btc, // { state, chg24, range24 }
      counts: {
        radar: radar.length,
        buildup: buildup.length,
        almost: almost.length,
        elite: elite.length,
      },
      funnel: {
        radar,
        buildup,
        almost,
        elite,
      },
    };

    // ✅ DIT WAS JE BUG: hier moet hij naar moon:latest:${mode}
    await kv.set(keyMoonLatest(mode), result);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result));
  } catch (e) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}