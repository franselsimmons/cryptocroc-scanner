import { kv } from "@vercel/kv";
export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    const mode = (url.searchParams.get("mode") || "bull").toLowerCase();
    const key = `cc:${mode}:latest`;
    const data = (await kv.get(key)) || { ok: true, mode, ts: 0, counts: {}, funnel: { entry: [], almost: [], buildup: [], radar: [] } };
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(data));
  } catch (e) {
    res.statusCode = 500;
    res.end(String(e));
  }
}