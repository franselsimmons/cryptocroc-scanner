import { kv } from "@vercel/kv";
import {
  RUNTIME_CONFIG,
  requireSecret,
  keyMoonLatest,
  keyMoonPortfolio,
  keyMoonPositions,
} from "../../lib/_moon_core.js";

export const config = RUNTIME_CONFIG;

function safeBase(mode) {
  return {
    ok: true,
    ts: Date.now(),
    mode,
    btc: null,
    counts: { radar: 0, buildup: 0, almost: 0, elite: 0 },
    funnel: { radar: [], buildup: [], almost: [], elite: [] },
    note: "No data yet. Run /api/moon/scan?mode=bull (or bear) first.",
  };
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const modeRaw = String(req.query?.mode || "bull").toLowerCase();
    const mode = modeRaw === "bear" ? "bear" : "bull";

    const latest = (await kv.get(keyMoonLatest(mode))) || safeBase(mode);
    const portfolio = (await kv.get(keyMoonPortfolio(mode))) || null;
    const positions = (await kv.get(keyMoonPositions(mode))) || null;

    const out = {
      ...latest,
      portfolio: latest.portfolio || portfolio,
      positions: positions || null,
    };

    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({
      ok: false,
      where: "api/moon/latest.js",
      error: String(e?.message || e),
    });
  }
}