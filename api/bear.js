import { json } from "./_lib/utils.js";
import { redis } from "./_lib/redis.js";

export default async function handler(req, res) {
  const r = redis();
  const data = await r.get("out:bear:v1");
  if (!data) return json(res, { ok: false, error: "no data yet. call /api/scan" }, 404);
  return json(res, data, 200);
}
