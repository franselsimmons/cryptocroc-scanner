// /api/analyze.js
import { kv } from "@vercel/kv";
import { requireSecret } from "../lib/_core_bull.js";

export const config = { runtime: "nodejs" };

function topN(map, n = 10) {
  const arr = Object.entries(map || {}).map(([k, v]) => ({ key: k, count: v }));
  arr.sort((a, b) => b.count - a.count);
  return arr.slice(0, n);
}

function mergeCountMaps(target, src) {
  const out = target || {};
  const s = src || {};
  for (const k of Object.keys(s)) {
    out[k] = (out[k] || 0) + Number(s[k] || 0);
  }
  return out;
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const mode = String(req.query?.mode || "bull").toLowerCase();
    const key = `latest:${mode}`;

    const latest = await kv.get(key);

    if (!latest) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({
        ok: true,
        note: "No scan data yet. Run /api/scan first."
      }));
    }

    const funnel = latest.funnel || {};
    const entry = funnel.entry || [];
    const almost = funnel.almost || [];
    const buildup = funnel.buildup || [];
    const radar = funnel.radar || [];

    const gateMap = {};
    const obReasonMap = {};

    const allCoins = [...entry, ...almost, ...buildup, ...radar];

    for (const c of allCoins) {
      if (c?.why?.entryGate)
        mergeCountMaps(gateMap, { [c.why.entryGate]: 1 });

      if (c?.ob?.reason)
        mergeCountMaps(obReasonMap, { [c.ob.reason]: 1 });
    }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      ok: true,
      mode,
      ts: latest.ts,
      counts: {
        entry: entry.length,
        almost: almost.length,
        buildup: buildup.length,
        radar: radar.length
      },
      top: {
        entryGate: topN(gateMap, 5),
        obReason: topN(obReasonMap, 5)
      }
    }));

  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}