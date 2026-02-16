// /api/moon-scan.js
import { kv } from "@vercel/kv";
import {
  MOON,
  requireSecret,
  fetchCoinGeckoTopCached,
  fetchBTCGateCached,
  passRadarMoon,
  keyMoonLatest
} from "./_moon_core.js";

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  try {
    // ================= AUTH =================
    if (!requireSecret(req, res)) return;

    const mode = String(req.query.mode || "bull").toLowerCase();

    // ================= BTC GATE =================
    let btc;
    try {
      btc = await fetchBTCGateCached();
    } catch (e) {
      // Als CoinGecko 429 geeft → crash niet
      btc = { state: "NEUTRAL", chg24: 0, range24: 0 };
    }

    // ================= COINS =================
    let coins = [];
    try {
      coins = await fetchCoinGeckoTopCached();
    } catch (e) {
      return res.status(200).json({
        ok: false,
        error: "CoinGecko markets failed (rate limit?)"
      });
    }

    const radar = [];

    for (const c of coins) {
      if (!passRadarMoon(c, mode)) continue;
      radar.push(c);
      if (radar.length >= MOON.RADAR_LIMIT) break;
    }

    const result = {
      ok: true,
      ts: Date.now(),
      mode,
      btc,
      counts: {
        radar: radar.length
      },
      funnel: {
        radar
      }
    };

    await kv.set(keyMoonLatest(mode), result, { ex: 60 * 15 });

    res.status(200).json(result);

  } catch (err) {
    res.status(200).json({
      ok: false,
      error: String(err?.message || err)
    });
  }
}