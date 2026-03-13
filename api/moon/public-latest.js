// api/moon/public-latest.js
import { kv } from "@vercel/kv";
import {
  RUNTIME_CONFIG,
  keyMoonLatest,
} from "../../lib/_moon_core.js";

export const config = RUNTIME_CONFIG;

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function normalizeMoonLatest(latest, mode) {
  const safe = latest && typeof latest === "object" ? latest : {};
  const funnel = safe.funnel && typeof safe.funnel === "object" ? safe.funnel : {};

  const elite_expansion = Array.isArray(funnel.elite_expansion) ? funnel.elite_expansion : [];
  const elite_ignition = Array.isArray(funnel.elite_ignition) ? funnel.elite_ignition : [];
  const almost = Array.isArray(funnel.almost) ? funnel.almost : [];
  const buildup = Array.isArray(funnel.buildup) ? funnel.buildup : [];
  const radar = Array.isArray(funnel.radar) ? funnel.radar : [];
  const hold = Array.isArray(funnel.hold) ? funnel.hold : [];

  const ts =
    n(safe.ts, 0) ||
    n(safe.scannedAt, 0) ||
    n(safe.meta?.ts, 0) ||
    Date.now();

  return {
    ok: safe.ok !== false,
    mode,
    ts,
    scannedAt: ts,
    btc: safe.btc || null,
    regime: safe.regime || null,
    whaleFlow: n(safe.whaleFlow, 0),
    funnel: {
      elite_expansion,
      elite_ignition,
      almost,
      buildup,
      radar,
      hold,
    },
    portfolio: safe.portfolio || null,
    positions: safe.positions || null,
    counts: {
      elite_expansion: elite_expansion.length,
      elite_ignition: elite_ignition.length,
      almost: almost.length,
      buildup: buildup.length,
      radar: radar.length,
      hold: hold.length,
      ...(safe.counts || {}),
    },
    meta: safe.meta || {},
  };
}

export default async function handler(req, res) {
  try {
    const mode =
      String(req.query?.mode || "bull").toLowerCase() === "bear"
        ? "bear"
        : "bull";

    const latest = await kv.get(keyMoonLatest(mode));

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");

    if (!latest) {
      return res.end(
        JSON.stringify({
          ok: true,
          mode,
          ts: 0,
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
          meta: {
            reason: "no_latest_snapshot",
          },
        })
      );
    }

    return res.end(JSON.stringify(normalizeMoonLatest(latest, mode)));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    return res.end(
      JSON.stringify({
        ok: false,
        error: e?.message || "moon_public_latest_failed",
      })
    );
  }
}