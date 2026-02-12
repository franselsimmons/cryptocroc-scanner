import { json } from "./_lib/utils.js";
import { redis, acquireLock, releaseLock } from "./_lib/redis.js";
import { runFullScan } from "./_lib/scanCore.js";

export default async function handler(req, res) {
  try {
    const secret = (req.query?.secret || "").toString();
    const envSecret = (process.env.CRON_SECRET || "").toString();

    if (envSecret && secret !== envSecret) {
      return json(res, { ok: false, error: "unauthorized" }, 401);
    }

    const lockKey = "scan:lock:v1";
    const locked = await acquireLock(lockKey, 180);
    if (!locked) {
      return json(res, { ok: true, skipped: true, reason: "locked" }, 200);
    }

    try {
      const r = redis();
      const result = await runFullScan(r);
      return json(res, result, 200);
    } finally {
      await releaseLock(lockKey);
    }
  } catch (e) {
    return json(res, { ok: false, error: String(e?.message || e) }, 500);
  }
}
