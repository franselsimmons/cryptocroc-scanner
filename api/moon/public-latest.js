import { kv } from "@vercel/kv";
import {
  keyMoonLatest,
  keyMoonPortfolio,
  keyMoonPositions,
} from "../../lib/_moon_core.js";

export const config = { runtime: "nodejs" };

function safeBase(mode) {
  return {
    ok: true,
    ts: Date.now(),
    mode,
    btc: null,
    counts: { radar: 0, buildup: 0, almost: 0, elite: 0 },
    funnel: { radar: [], buildup: [], almost: [], elite: [] },
    note: "No data yet. Wait for cron scan.",
  };
}

export default async function handler(req, res) {
  try {
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

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(out));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    return res.end(
      JSON.stringify({
        ok: false,
        where: "api/moon/public-latest.js",
        error: String(e?.message || e),
      })
    );
  }
}