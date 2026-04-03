// api/cron-bull.js
import mainScan from "./scan.js";

export default async function cronBull(req, res) {
  req.query = req.query || {};
  req.headers = req.headers || {};

  // ✅ force mode
  req.query.mode = "bull";

  // ✅ token path
  req.query.token = process.env.CRON_SECRET;

  // ✅ also mark it as cron
  req.headers["x-vercel-cron"] = "1";

  return mainScan(req, res);
}