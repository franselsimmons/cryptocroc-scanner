/* EOF: /api/obmap.js */

import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  try {
    const mode = String(req.query.mode || "bull").toLowerCase();

    if (mode !== "bull" && mode !== "bear") {
      return res.status(400).json({ ok: false, error: "mode must be bull or bear" });
    }

    const key = `ob:map:${mode}`;
    const raw = await kv.get(key);

    // jouw KV structuur is: { ts, size, map }
    const innerMap =
      raw && typeof raw === "object" && raw.map && typeof raw.map === "object"
        ? raw.map
        : null;

    const pairs = innerMap ? Object.keys(innerMap) : [];

    return res.status(200).json({
      ok: true,
      mode,
      key,
      wrapper: raw ? Object.keys(raw) : null, // laat zien dat wrapper ts/size/map is
      size: pairs.length,
      sample: pairs.slice(0, 20),
      ts: Date.now(),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

/* EOF */