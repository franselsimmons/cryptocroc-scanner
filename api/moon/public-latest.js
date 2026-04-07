// api/moon/public-latest.js
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

function setNoCache(res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
}

export default async function handler(req, res) {
  try {
    setNoCache(res);

    const mode =
      String(req.query?.mode || "bull").toLowerCase() === "bear" ? "bear" : "bull";

    const latest = (await kv.get(keyMoonLatest(mode))) || null;

    if (!latest) {
      return res.status(200).json({
        ok: true,
        mode,
        ts: 0,
        scannedAt: 0,
        snapshotAgeMs: null,
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

    const scannedAt = n(latest?.scannedAt, n(latest?.ts, 0));
    const ts = scannedAt || n(latest?.ts, 0);
    const snapshotAgeMs = scannedAt > 0 ? Math.max(0, Date.now() - scannedAt) : null;

    return res.status(200).json({
      ...latest,
      ok: true,
      mode,
      ts,
      scannedAt,
      snapshotAgeMs,
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
    });
  } catch (e) {
    setNoCache(res);
    return res.status(500).json({
      ok: false,
      error: e?.message || "moon_public_latest_failed",
    });
  }
}