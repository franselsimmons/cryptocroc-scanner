// /api/moon-latest.js
import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, keyMoonLatest } from "./_moon_core.js";

export const config = RUNTIME_CONFIG;

export default async function handler(req, res) {
  const mode = (req.query?.mode || "bull").toLowerCase();
  const m = mode === "bear" ? "bear" : "bull";

  const data = (await kv.get(keyMoonLatest(m))) || {
    ok: true,
    ts: Date.now(),
    mode: m,
    counts: { elite: 0, almost: 0, buildup: 0 },
    funnel: { elite: [], almost: [], buildup: [] },
    note: "No data yet. Run /api/moon-scan?mode=bull first.",
  };

  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(data));
}