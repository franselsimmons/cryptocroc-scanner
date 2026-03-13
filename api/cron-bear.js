// api/cron-bear.js
import mainScan from "./scan.js";

export default async function cronBear(req, res) {
  req.query = {
    ...(req.query || {}),
    mode: "bear",
    token: process.env.CRON_SECRET,
  };

  return mainScan(req, res);
}