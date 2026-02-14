import { kv } from "@vercel/kv";
import { json } from "./_core.js";

export default async function handler(req, res) {
  try {
    const u = new URL(req.url, "http://localhost");
    const mode = (u.searchParams.get("mode") || "bull").toLowerCase();
    const data = await kv.get(`latest:${mode}`);
    return json(res, 200, data || { ts: Date.now(), mode, funnel: { entry:[], hold:[], buildup:[], radar:[], sell:[] } });
  } catch (e) {
    return json(res, 500, { error: String(e) });
  }
}
