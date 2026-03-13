// api/moon/cron-bear.js
import moonHandler from "./scan.js";

export default async function cronBear(req, res) {
  req.query = {
    ...(req.query || {}),
    mode: "bear",
    token: process.env.CRON_SECRET,
  };

  return moonHandler(req, res);
}