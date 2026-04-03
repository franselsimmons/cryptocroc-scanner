// api/latest.js
import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG } from "../lib/_runtime.js";

export const config = RUNTIME_CONFIG;

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}
function arr(x) {
  return Array.isArray(x) ? x : [];
}

function keyMainLatest(mode) {
  return `main:latest:${String(mode || "bull").toLowerCase()}`;
}

export default async function handler(req, res) {
  try {
    const mode = String(req.query?.mode || "bull").toLowerCase() === "bear" ? "bear" : "bull";

    const latest = (await kv.get(keyMainLatest(mode))) || null;

    if (!latest) {
      return res.status(200).json({
        ok: true,
        mode,
        ts: 0,
        scannedAt: 0,
        btc: { state: "NEUTRAL", chg24: 0, range24: 0 },
        funnel: { entry: [], almost: [], buildup: [], radar: [] },
        counts: { entry: 0, almost: 0, buildup: 0, radar: 0 },
      });
    }

    const funnel = latest?.funnel || {};
    const entry = arr(funnel.entry);
    const almost = arr(funnel.almost);
    const buildup = arr(funnel.buildup);
    const radar = arr(funnel.radar);

    const ts = n(latest?.scannedAt, n(latest?.ts, 0));

    return res.status(200).json({
      ...latest,
      mode,
      ts,
      scannedAt: ts,
      btc: latest?.btc || { state: "NEUTRAL", chg24: 0, range24: 0 },
      funnel: { entry, almost, buildup, radar },
      counts: {
        entry: entry.length,
        almost: almost.length,
        buildup: buildup.length,
        radar: radar.length,
      },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || "latest_failed",
    });
  }
}