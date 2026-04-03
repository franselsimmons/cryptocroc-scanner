// api/cron-bear.js
import mainScan from "./scan.js";

export default async function cronBear(req, res) {
  req.query = req.query || {};
  req.headers = req.headers || {};

  // ✅ force mode
  req.query.mode = "bear";

  // ✅ token path (works even if x-vercel-cron header isn't present)
  req.query.token = process.env.CRON_SECRET;

  // ✅ also mark it as cron (scan.js accepts either)
  req.headers["x-vercel-cron"] = "1";

  return mainScan(req, res);
}