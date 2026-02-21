// /api/latest.js
import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs20.x" };

export default async function handler(req, res) {
  try {
    const mode = String(req.query?.mode || "bull").toLowerCase();
    if (mode !== "bull" && mode !== "bear") {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "mode must be bull or bear" }));
    }

    const core = await import(`./_core_${mode}.js`);
    const data = await kv.get(core.keyLatest(mode));

    if (!data) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      return res.end(
        JSON.stringify({
          ok: true,
          counts: { entry: 0, almost: 0, buildup: 0, radar: 0 },
          funnel: { entry: [], almost: [], buildup: [], radar: [] },
        })
      );
    }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(data));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ ok: false, error: String(e) }));
  }
}