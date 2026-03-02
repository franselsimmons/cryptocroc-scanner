// /api/latest.js
import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, getMode } from "../lib/_runtime.js";

export const config = RUNTIME_CONFIG;

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  // latest is snapshot -> je mag no-store laten staan (dit triggert geen scan)
  res.setHeader("cache-control", "no-store");
  return res.end(JSON.stringify(obj));
}

export default async function handler(req, res) {
  try {
    const mode = getMode(req); // bull/bear
    const data = await kv.get(`latest:${mode}`);

    if (!data) {
      return send(res, 200, {
        ok: true,
        ts: Date.now(),
        mode,
        btc: null,
        counts: { entry: 0, almost: 0, buildup: 0, radar: 0, openTrades: 0, recentSells: 0 },
        funnel: { entry: [], almost: [], buildup: [], radar: [] },
        trading: { openTrades: [], recentSells: [], stats: {} },
        note: "No latest yet. Run /api/scan with secret once (cron).",
      });
    }

    return send(res, 200, data);
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e?.message || e) });
  }
}