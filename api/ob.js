/* EOF: /api/ob.js */

import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  try {
    const mode = String(req.query.mode || "bull").toLowerCase();
    const keyParam = String(req.query.key || "").toUpperCase();

    if (!keyParam) {
      return res.status(400).json({
        ok: false,
        error: "Provide ?key=PAIR (example: PEPEUSDT)",
      });
    }

    if (mode !== "bull" && mode !== "bear") {
      return res.status(400).json({
        ok: false,
        error: "mode must be bull or bear",
      });
    }

    // 👉 Moet exact matchen met je sampler
    const snapKey = `ob:snap:${mode}:${keyParam}`;

    const data = await kv.get(snapKey);

    return res.status(200).json({
      ok: true,
      mode,
      key: snapKey,
      exists: !!data,
      data: data || null,
      ts: Date.now(),
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String(e?.message || e),
    });
  }
}

/* EOF */