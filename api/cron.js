import { json } from "./_core.js";
import { runScan } from "./scan.js";

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  try {
    // Beveiliging (aanrader)
    const secret = process.env.CRON_SECRET;
    if (secret) {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${secret}`) {
        res.statusCode = 401;
        return res.end("Unauthorized");
      }
    }

    const bull = await runScan("bull");
    const bear = await runScan("bear");

    return json(res, 200, { ok: true, ts: Date.now(), bull: bull.counts, bear: bear.counts });
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e?.message || e) });
  }
}
