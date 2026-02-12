import { json } from "./_lib/utils.js";
import { runFullScan } from "./_lib/scanCore.js";

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  try {
    const secret = (req.query?.secret || "").toString();
    const envSecret = (process.env.CRON_SECRET || "").toString();

    if (envSecret && secret !== envSecret) {
      return json(res, { ok: false, error: "unauthorized" }, 401);
    }

    const result = await runFullScan();
    return json(res, result, 200);
  } catch (e) {
    console.error("scan error:", e);
    return json(res, { ok: false, error: String(e?.message || e) }, 500);
  }
}
