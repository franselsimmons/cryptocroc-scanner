import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, keyMoonLatest } from "../../lib/_moon_core.js";

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
    const mode =
      String(req.query?.mode || "bull").toLowerCase() === "bear" ? "bear" : "bull";

    const latest = (await kv.get(keyMoonLatest(mode))) || null;

    if (!latest) {
      return res.status(200).json({
        ok: true,
        mode,
        ts: 0,
        scannedAt: 0,
        btc: { state: "NEUTRAL", chg24: 0, range24: 0 },
        whaleFlow: 0,
        funnel: {
          elite_expansion: [],
          elite_ignition: [],
          almost: [],
          buildup: [],
          radar: [],
          hold: [],
        },
        counts: {
          elite_expansion: 0,
          elite_ignition: 0,
          almost: 0,
          buildup: 0,
          radar: 0,
          hold: 0,
        },
        candidates: {
          premium: [],
          tradeReady: [],
          watch: [],
          scannerOnly: [],
        },
        debug: {
          universeCount: 0,
          premiumCount: 0,
          tradeReadyCount: 0,
          watchCount: 0,
          scannerOnlyCount: 0,
        },
        portfolio: {
          openCount: 0,
          closedCount: 0,
          realizedUsd: 0,
          avgRealizedPct: 0,
        },
        positions: { open: 0, closed: 0, openItems: [] },
      });
    }

    const funnel = latest?.funnel || {};

    const eliteExpansion = arr(funnel.elite_expansion);
    const eliteIgnition = arr(funnel.elite_ignition);
    const almost = arr(funnel.almost);
    const buildup = arr(funnel.buildup);
    const radar = arr(funnel.radar);
    const hold = arr(funnel.hold);

    const ts = n(latest?.scannedAt, n(latest?.ts, 0));

    return res.status(200).json({
      ...latest,
      ts,
      scannedAt: n(latest?.scannedAt, ts),
      btc: latest?.btc || { state: "NEUTRAL", chg24: 0, range24: 0 },
      whaleFlow: n(latest?.whaleFlow, 0),
      funnel: {
        elite_expansion: eliteExpansion,
        elite_ignition: eliteIgnition,
        almost,
        buildup,
        radar,
        hold,
      },
      counts: {
        elite_expansion: eliteExpansion.length,
        elite_ignition: eliteIgnition.length,
        almost: almost.length,
        buildup: buildup.length,
        radar: radar.length,
        hold: hold.length,
      },
      candidates: {
        premium: arr(latest?.candidates?.premium),
        tradeReady: arr(latest?.candidates?.tradeReady),
        watch: arr(latest?.candidates?.watch),
        scannerOnly: arr(latest?.candidates?.scannerOnly),
      },
      debug: {
        universeCount: n(latest?.debug?.universeCount, 0),
        premiumCount: n(latest?.debug?.premiumCount, 0),
        tradeReadyCount: n(latest?.debug?.tradeReadyCount, 0),
        watchCount: n(latest?.debug?.watchCount, 0),
        scannerOnlyCount: n(latest?.debug?.scannerOnlyCount, 0),
      },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || "moon_public_latest_failed",
    });
  }
}