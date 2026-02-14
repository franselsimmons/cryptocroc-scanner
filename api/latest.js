import { kv } from "@vercel/kv";
import { json } from "./_core.js";

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  try {
    const u = new URL(req.url, "http://localhost");
    const mode = (u.searchParams.get("mode") || "bull").toLowerCase();
    const data = await kv.get(`latest:${mode}`);

    // Altijd dezelfde shape teruggeven
    if (!data) {
      return json(res, 200, {
        ok: true,
        ts: Date.now(),
        mode,
        counts: { pool: 0, radar: 0, buildup: 0, entry: 0 },
        funnel: { entry: [], buildup: [], radar: [] }
      });
    }

    return json(res, 200, data);
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e?.message || e) });
  }
}
