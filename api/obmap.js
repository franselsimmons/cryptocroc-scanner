import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs" };

function pickMode(raw) {
  const m = String(raw || "bull").toLowerCase();
  return m === "bear" ? "bear" : "bull";
}

export default async function handler(req, res) {
  try {
    const mode = pickMode(req.query.mode);
    const secret = String(req.query.secret || "");

    // als jij een secret wil afdwingen:
    const expected = process.env.CC_SECRET || "";
    if (expected && secret !== expected) {
      return res.status(401).json({ ok: false, error: "bad secret" });
    }

    const key = `ob:map:${mode}`;
    const wrapper = await kv.get(key);

    // wrapper hoort te zijn: { ts, size, map }
    if (!wrapper || typeof wrapper !== "object") {
      return res.status(200).json({
        ok: true,
        mode,
        key,
        wrapper: null,
        size: 0,
        ts: Date.now(),
        note: "No ob map in KV yet. Run /api/ob/map_refresh first.",
      });
    }

    const map = wrapper.map || {};
    const symbols = Object.keys(map);

    return res.status(200).json({
      ok: true,
      mode,
      key,
      wrapper: ["ts", "size", "map"],
      size: wrapper.size ?? symbols.length,
      sample: symbols.slice(0, 20),
      ts: wrapper.ts ?? Date.now(),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}