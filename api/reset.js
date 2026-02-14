// /api/reset.js
import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs20.x" };

export default async function handler(req, res) {
  try {
    const secret = req.query.secret;

    if (!secret || secret !== process.env.CRON_SECRET) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    // 🔥 Alles verwijderen
    await kv.flushall();

    return res.status(200).json({
      ok: true,
      message: "CryptoCroc system fully reset.",
      timestamp: Date.now()
    });

  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
}