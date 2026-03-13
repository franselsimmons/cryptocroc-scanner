// api/cron-bear.js
import mainScan from "./scan.js";

export default async function handler(req, res) {
  try {
    req.query = {
      ...(req.query || {}),
      mode: "bear",
      token: process.env.CRON_SECRET,
    };

    req.headers = {
      ...(req.headers || {}),
      authorization: `Bearer ${process.env.CRON_SECRET || ""}`,
    };

    return await mainScan(req, res);
  } catch (e) {
    console.error("api/cron-bear.js error:", e);
    return res.status(500).json({
      ok: false,
      error: e?.message || "cron bear failed",
    });
  }
}