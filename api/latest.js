import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, getMode } from "../lib/_runtime.js";

export const config = RUNTIME_CONFIG;

export default async function handler(req, res) {
  try {
    const mode = getMode(req);

    const core = await import(`../lib/_core_${mode}.js`);
    const data = await kv.get(core.keyLatest(mode));

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");

    if (!data) {
      return res.end(JSON.stringify({
        ok: true,
        ts: Date.now(),
        mode,
        btc: null,
        counts: { entry: 0, almost: 0, buildup: 0, radar: 0 },
        funnel: { entry: [], almost: [], buildup: [], radar: [] }
      }));
    }

    return res.end(JSON.stringify(data));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}