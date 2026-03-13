// api/cron-bull.js
import mainScan from "./scan.js";

export default async function handler(req, res) {
  try {
    req.query = {
      ...(req.query || {}),
      mode: "bull",
      token: process.env.CRON_SECRET,
    };

    req.headers = {
      ...(req.headers || {}),
      authorization: `Bearer ${process.env.CRON_SECRET || ""}`,
    };

    return await mainScan(req, res);
  } catch (e) {
    console.error("api/cron-bull.js error:", e);
    return res.status(500).json({
      ok: false,
      error: e?.message || "cron bull failed",
    });
  }
}