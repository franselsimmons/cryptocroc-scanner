// /api/moon-latest.js
import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, keyMoonLatest } from "./_moon_core.js";

export const config = RUNTIME_CONFIG;

export default async function handler(req, res) {
  const modeRaw = String(req.query?.mode || "bull").toLowerCase();
  const mode = modeRaw === "bear" ? "bear" : "bull";

  const data = (await kv.get(keyMoonLatest(mode))) || {
    ok: true,
    ts: Date.now(),
    mode,
    btc: null,
    counts: { radar: 0, buildup: 0, almost: 0, elite: 0 },
    funnel: { radar: [], buildup: [], almost: [], elite: [] },
    note: "No data yet. Run /api/moon-scan?mode=bull (or bear) first.",
  };

  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(data));
}