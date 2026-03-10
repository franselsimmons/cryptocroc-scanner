import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, keyMoonLatest } from "../../lib/_moon_core.js";

export const config = RUNTIME_CONFIG;

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  return res.end(JSON.stringify(obj));
}

function getMode(req) {
  return String(req.query?.mode || "bull").toLowerCase() === "bear"
    ? "bear"
    : "bull";
}

export default async function handler(req, res) {
  try {
    const mode = getMode(req);
    const key = keyMoonLatest(mode);
    const data = await kv.get(key);

    if (!data || typeof data !== "object") {
      return send(res, 200, {
        ok: true,
        ts: Date.now(),
        mode,
        btc: { state: "NEUTRAL", chg24: 0, range24: 0, chg1h: 0 },
        counts: { elite: 0, almost: 0, buildup: 0, radar: 0 },
        funnel: { elite: [], almost: [], buildup: [], radar: [] },
        portfolio: null,
        positions: { open: [], closed: [] },
        whaleFlow: 0,
        note: "No moon latest in KV yet. Run /api/moon/scan or /api/moon/cron first.",
      });
    }

    return send(res, 200, data);
  } catch (e) {
    return send(res, 500, {
      ok: false,
      error: String(e?.message || e),
    });
  }
}