// /api/latest.js
import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, keyLatest } from "./_core.js";

export const config = RUNTIME_CONFIG;

export default async function handler(req, res) {
  try {
    const mode = (req.query?.mode || "bull").toLowerCase();
    const data = await kv.get(keyLatest(mode));

    if (!data) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      return res.end(
        JSON.stringify({
          ok: true,
          ts: null,
          mode,
          counts: { entry: 0, almost: 0, buildup: 0, radar: 0 },
          funnel: { entry: [], almost: [], buildup: [], radar: [] },
        })
      );
    }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(data));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e) }));
  }
}