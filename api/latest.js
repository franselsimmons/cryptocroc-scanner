// api/latest.js
import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, keyMainLatest } from "../lib/_moon_core.js";

export const config = RUNTIME_CONFIG;

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function arr(x) {
  return Array.isArray(x) ? x : [];
}

export default async function handler(req, res) {
  try {
    const mode = String(req.query?.mode || "bull").toLowerCase() === "bear" ? "bear" : "bull";
    const latest = (await kv.get(keyMainLatest(mode))) || null;

    if (!latest) {
      return res.status(200).json({
        ok: true,
        mode,
        ts: 0,
        scannedAt: 0,
        btc: { state: "NEUTRAL", chg24: 0, range24: 0 },
        funnel: {
          elite_expansion: [],
          elite_ignition: [],
          almost: [],
          buildup: [],
          radar: [],
          hold: [],
          sell: [],
        },
        counts: {
          elite_expansion: 0,
          elite_ignition: 0,
          almost: 0,
          buildup: 0,
          radar: 0,
          hold: 0,
          sell: 0,
          entry: 0,
        },
        portfolio: {
          openCount: 0,
          closedCount: 0,
          realizedUsd: 0,
          avgRealizedPct: 0,
        },
        positions: { open: 0, closed: 0 },
      });
    }

    const funnel = latest?.funnel || {};
    const eliteExpansion = arr(funnel.elite_expansion);
    const eliteIgnition = arr(funnel.elite_ignition);
    const almost = arr(funnel.almost);
    const buildup = arr(funnel.buildup);
    const radar = arr(funnel.radar);
    const hold = arr(funnel.hold);
    const sell = arr(funnel.sell);

    const ts = n(latest?.ts, n(latest?.scannedAt, 0));

    return res.status(200).json({
      ...latest,
      ts,
      scannedAt: n(latest?.scannedAt, ts),
      btc: latest?.btc || { state: "NEUTRAL", chg24: 0, range24: 0 },
      funnel: {
        elite_expansion: eliteExpansion,
        elite_ignition: eliteIgnition,
        almost,
        buildup,
        radar,
        hold,
        sell,
      },
      counts: {
        elite_expansion: eliteExpansion.length,
        elite_ignition: eliteIgnition.length,
        almost: almost.length,
        buildup: buildup.length,
        radar: radar.length,
        hold: hold.length,
        sell: sell.length,
        entry: eliteExpansion.length + eliteIgnition.length,
      },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || "latest_failed",
    });
  }
}