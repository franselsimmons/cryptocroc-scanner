// api/moon/cron-bull.js
import moonHandler from "./scan.js";

export default async function cronBull(req, res) {
  req.query = {
    ...(req.query || {}),
    mode: "bull",
    token: process.env.CRON_SECRET,
  };

  return moonHandler(req, res);
}