// api/cron-bull.js
import mainScan from "./scan.js";

export default async function cronBull(req, res) {
  req.query = {
    ...(req.query || {}),
    mode: "bull",
    token: process.env.CRON_SECRET,
  };

  return mainScan(req, res);
}