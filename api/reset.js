// /api/reset.js
// CryptoCroc Scanner – Full Memory Reset
// Node 20 compatible

import { kv } from "@vercel/kv";

export const config = {
  runtime: "nodejs20.x"
};

export default async function handler(req, res) {
  try {
    const secret = req.query.secret;

    if (!secret || secret !== process.env.CRON_SECRET) {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized"
      });
    }

    // Verwijder alle keys
    const keys = await kv.keys("*");

    if (keys.length > 0) {
      await kv.del(...keys);
    }

    return res.status(200).json({
      ok: true,
      message: "CryptoCroc memory fully reset",
      deletedKeys: keys.length,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
}