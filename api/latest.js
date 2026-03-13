import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  try {
    const mode =
      String(req.query?.mode || "bull").toLowerCase() === "bear"
        ? "bear"
        : "bull";

    const key = `main:latest:${mode}`;

    const latest = await kv.get(key);

    if (!latest) {
      return res.status(200).json({
        ok: true,
        mode,
        ts: 0,
        scannedAt: 0,
        funnel: {
          entry: [],
          hold: [],
          sell: [],
          almost: [],
          buildup: [],
          radar: [],
        },
      });
    }

    return res.status(200).json(latest);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || "latest_failed",
    });
  }
}