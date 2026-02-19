// /api/moon-analyze.js
import { kv } from "@vercel/kv";
import {
  RUNTIME_CONFIG,
  requireSecret,
} from "./_moon_core.js";

import {
  keyMoonDiagList,
  keyMoonDiagSnap,
} from "./_moon_core.js";

export const config = RUNTIME_CONFIG;

function mergeCountMaps(target, src) {
  const out = target || {};
  const s = src || {};
  for (const k of Object.keys(s)) {
    out[k] = (out[k] || 0) + Number(s[k] || 0);
  }
  return out;
}

function topN(map, n = 10) {
  const arr = Object.entries(map || {}).map(([k, v]) => ({ key: k, count: v }));
  arr.sort((a, b) => b.count - a.count);
  return arr.slice(0, n);
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const mode = String(req.query?.mode || "bull").toLowerCase();
    const limit = Math.max(5, Math.min(200, Number(req.query?.limit || 50)));

    let diags = [];

    if (typeof kv.lrange === "function") {
      const raw = await kv.lrange(keyMoonDiagList(mode), 0, limit - 1);
      diags = (raw || [])
        .map((x) => {
          try { return typeof x === "string" ? JSON.parse(x) : x; } catch { return null; }
        })
        .filter(Boolean);
    } else {
      const snap = await kv.get(keyMoonDiagSnap(mode));
      if (snap) diags = [snap];
    }

    if (!diags.length) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({
        ok: true,
        mode,
        note: "No moon diagnostics yet. Run /api/moon-scan a few times first."
      }));
    }

    let total = 0;
    let radarSum = 0;
    let buildupSum = 0;
    let almostSum = 0;
    let eliteSum = 0;

    let radarOut = {};
    let buildupWhy = {};
    let almostWhy = {};
    let eliteWhy = {};
    let eliteExtraFail = {};
    let obReason = {};

    let last = diags[0];

    for (const d of diags) {
      total += 1;
      radarSum += Number(d?.counts?.radar || 0);
      buildupSum += Number(d?.counts?.buildup || 0);
      almostSum += Number(d?.counts?.almost || 0);
      eliteSum += Number(d?.counts?.elite || 0);

      radarOut = mergeCountMaps(radarOut, d?.reasons?.radarOut);
      buildupWhy = mergeCountMaps(buildupWhy, d?.reasons?.buildupWhy);
      almostWhy = mergeCountMaps(almostWhy, d?.reasons?.almostWhy);
      eliteWhy = mergeCountMaps(eliteWhy, d?.reasons?.eliteWhy);
      eliteExtraFail = mergeCountMaps(eliteExtraFail, d?.reasons?.eliteExtraFail);
      obReason = mergeCountMaps(obReason, d?.reasons?.obReason);
    }

    const avg = {
      radar: radarSum / total,
      buildup: buildupSum / total,
      almost: almostSum / total,
      elite: eliteSum / total,
    };

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      ok: true,
      mode,
      scansUsed: total,
      lastTs: last?.ts || null,
      avgCountsPerScan: avg,
      top: {
        radarOut: topN(radarOut, 5),
        buildupWhy: topN(buildupWhy, 5),
        almostWhy: topN(almostWhy, 5),
        eliteWhy: topN(eliteWhy, 5),
        eliteExtraFail: topN(eliteExtraFail, 5),
        obReason: topN(obReason, 5),
      },
      lastSettings: last?.settings || null,
      note: "Use this to see where MOON funnel blocks coins.",
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e) }));
  }
}