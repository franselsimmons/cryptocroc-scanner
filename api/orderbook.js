// /api/orderbook.js
import { kv } from "@vercel/kv";
import { CFG, RUNTIME_CONFIG } from "./_core.js";

export const config = RUNTIME_CONFIG;

export default async function handler(req, res) {
  try {
    const u = new URL(req.url, "http://localhost");
    const symbol = u.searchParams.get("symbol");
    const side = u.searchParams.get("side") || "bull";
    if (!symbol) throw new Error("Missing symbol");

    const keyRes = `ob:result:${side}:${symbol}`;
    const r = await kv.get(keyRes);

    if (!r) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          ok: true,
          symbol,
          side,
          status: "validating",
          tip: "Nog geen OB-result. Wacht even (sampler draait elke minuut).",
        })
      );
      return;
    }

    const ageSec = r?.ob?.ts ? (Date.now() - r.ob.ts) / 1000 : 999;
    const stale = ageSec > CFG.obStaleSec;

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        ok: true,
        symbol,
        side,
        valid: !!r.valid,
        reason: r.reason,
        avgScore: r.avgScore ?? null,
        spreadPct: r?.ob?.spreadPct ?? null,
        lor: r?.ob?.lor ?? null,
        score: r?.ob?.score ?? null,
        bidUsd: r?.ob?.bidUsd ?? null,
        askUsd: r?.ob?.askUsd ?? null,
        stale,
      })
    );
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e) }));
  }
}