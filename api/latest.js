// api/latest.js
import { kv } from "@vercel/kv";
import {
  RUNTIME_CONFIG,
  keyMainLatest,
} from "../lib/_moon_core.js";

export const config = RUNTIME_CONFIG;

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function normalizeMainLatest(latest, mode) {
  const safe = latest && typeof latest === "object" ? latest : {};
  const funnel = safe.funnel && typeof safe.funnel === "object" ? safe.funnel : {};

  const entry = Array.isArray(funnel.entry) ? funnel.entry : [];
  const hold = Array.isArray(funnel.hold) ? funnel.hold : [];
  const sell = Array.isArray(funnel.sell) ? funnel.sell : [];
  const almost = Array.isArray(funnel.almost) ? funnel.almost : [];
  const buildup = Array.isArray(funnel.buildup) ? funnel.buildup : [];
  const radar = Array.isArray(funnel.radar) ? funnel.radar : [];

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
    cap: safe.cap || null,
    regime: safe.regime || null,
    funnel: {
      entry,
      hold,
      sell,
      almost,
      buildup,
      radar,
    },
    portfolio: safe.portfolio || null,
    positions: safe.positions || null,
    meta: {
      ...(safe.meta || {}),
      counts: {
        entry: entry.length,
        hold: hold.length,
        sell: sell.length,
        almost: almost.length,
        buildup: buildup.length,
        radar: radar.length,
        ...(safe.meta?.counts || {}),
      },
    },
  };
}

export default async function handler(req, res) {
  try {
    const mode =
      String(req.query?.mode || "bull").toLowerCase() === "bear"
        ? "bear"
        : "bull";

    const latest = await kv.get(keyMainLatest(mode));

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
            entry: [],
            hold: [],
            sell: [],
            almost: [],
            buildup: [],
            radar: [],
          },
          meta: {
            counts: {
              entry: 0,
              hold: 0,
              sell: 0,
              almost: 0,
              buildup: 0,
              radar: 0,
            },
            reason: "no_latest_snapshot",
          },
        })
      );
    }

    return res.end(JSON.stringify(normalizeMainLatest(latest, mode)));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    return res.end(
      JSON.stringify({
        ok: false,
        error: e?.message || "latest_failed",
      })
    );
  }
}