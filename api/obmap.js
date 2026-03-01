/* EOF: /api/obmap.js */

import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  try {
    const mode = String(req.query.mode || "bull").toLowerCase();

    if (mode !== "bull" && mode !== "bear") {
      return res.status(400).json({
        ok: false,
        error: "mode must be bull or bear",
      });
    }

    // 👉 Moet exact matchen met je sampler
    const key = `ob:map:${mode}`;

    const raw = await kv.get(key);

    const map = raw && typeof raw === "object" ? raw : null;
    const keys = map ? Object.keys(map) : [];

    return res.status(200).json({
      ok: true,
      mode,
      key,
      size: keys.length,
      sample: keys.slice(0, 20), // preview eerste 20
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