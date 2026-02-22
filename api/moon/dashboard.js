// /api/moon/dashboard.js
import { kv } from "@vercel/kv";
import { requireSecret } from "../../lib/_moon_core.js";

export const config = { runtime: "nodejs" };

const NS = "cc:moon";
const KEY_LIST = `${NS}:signal:list`;

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

export default async function handler(req, res) {
  if (!requireSecret(req, res)) return;

  const limit = Math.max(1, Math.min(500, parseInt(String(req.query?.limit || "150"), 10) || 150));

  // pak laatste N IDs via de rolling index
  let ids = [];
  if (typeof kv.lrange === "function") {
    ids = (await kv.lrange(KEY_LIST, 0, limit - 1)) || [];
  }

  const signals = [];
  for (const id of ids) {
    const s = await kv.get(id);
    if (s) signals.push(s);
  }

  const regimes = { low: [], mid: [], high: [] };
  const bull = [];
  const bear = [];

  for (const s of signals) {
    if (regimes[s.market_regime]) regimes[s.market_regime].push(s);
    if (s.direction === "bull") bull.push(s);
    if (s.direction === "bear") bear.push(s);
  }

  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({
    totalSignals: signals.length,
    byRegime: { low: regimes.low.length, mid: regimes.mid.length, high: regimes.high.length },
    bull: bull.length,
    bear: bear.length,
    topInstability: [...signals]
      .sort((a, b) => n(b.instability_score_raw) - n(a.instability_score_raw))
      .slice(0, 10),
  }));
}