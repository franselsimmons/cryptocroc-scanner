// /api/latest.js
import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, getMode } from "../lib/_runtime.js";

export const config = RUNTIME_CONFIG;

export default async function handler(req, res) {
  try {
    const mode = getMode(req); // bull/bear
    const data = await kv.get(`latest:${mode}`);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");

    // anti-cache
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");

    if (!data) {
      return res.end(JSON.stringify({
        ok: true,
        ts: Date.now(),
        mode,
        btc: null,
        counts: { entry: 0, almost: 0, buildup: 0, radar: 0, openTrades: 0, recentSells: 0 },
        funnel: { entry: [], almost: [], buildup: [], radar: [] },
        trading: { openTrades: [], recentSells: [], stats: {} },
      }));
    }

    return res.end(JSON.stringify(data));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}