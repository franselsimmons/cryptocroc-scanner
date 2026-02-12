import { getRedis } from "./_lib/redis.js";
import { json } from "./_lib/utils.js";

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  try {
    const redis = getRedis();
    const data = await redis.get("out:bear");
    if (!data) return json(res, { ok: false, error: "no data yet. call /api/scan first" }, 404);
    return json(res, data, 200);
  } catch (e) {
    return json(res, { ok: false, error: String(e?.message || e) }, 500);
  }
}
