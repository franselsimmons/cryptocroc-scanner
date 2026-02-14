import { kv } from "@vercel/kv";
export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  const u = new URL(req.url, "http://localhost");
  const mode = (u.searchParams.get("mode") || "bull").toLowerCase();

  const data = await kv.get(`latest:${mode}`);

  res.statusCode = 200;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data || {}));
}
