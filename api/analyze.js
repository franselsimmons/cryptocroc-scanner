// /api/analyze.js
import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, requireSecret, keyDiagList, keyDiagSnap } from "./_core.js";

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

    const mode = String(req.query?.mode || "bear").toLowerCase();
    const limit = Math.max(5, Math.min(200, Number(req.query?.limit || 50)));

    let diags = [];

    // Prefer list history
    if (typeof kv.lrange === "function") {
      const raw = await kv.lrange(keyDiagList(mode), 0, limit - 1);
      diags = (raw || [])
        .map((x) => {
          try { return typeof x === "string" ? JSON.parse(x) : x; } catch { return null; }
        })
        .filter(Boolean);
    } else {
      const snap = await kv.get(keyDiagSnap(mode));
      if (snap) diags = [snap];
    }

    if (!diags.length) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ok: true, mode, note: "No diagnostics yet. Run /api/scan a few times first." }));
    }

    // Aggregate
    let total = 0;
    let entrySum = 0;
    let almostSum = 0;
    let buildupSum = 0;
    let radarSum = 0;

    let entryGate = {};
    let obReason = {};
    let desiredWhy = {};
    let radarOut = {};

    let last = diags[0];

    for (const d of diags) {
      total += 1;
      entrySum += Number(d?.counts?.entry || 0);
      almostSum += Number(d?.counts?.almost || 0);
      buildupSum += Number(d?.counts?.buildup || 0);
      radarSum += Number(d?.counts?.radar || 0);

      entryGate = mergeCountMaps(entryGate, d?.reasons?.entryGate);
      obReason = mergeCountMaps(obReason, d?.reasons?.obReason);
      desiredWhy = mergeCountMaps(desiredWhy, d?.reasons?.desiredWhy);
      radarOut = mergeCountMaps(radarOut, d?.reasons?.radarOut);
    }

    const avg = {
      entry: entrySum / total,
      almost: almostSum / total,
      buildup: buildupSum / total,
      radar: radarSum / total,
    };

    // Biggest bottleneck hint (simpel maar handig)
    const topEntryGate = topN(entryGate, 5);
    const topObReason = topN(obReason, 5);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      ok: true,
      mode,
      scansUsed: total,
      lastTs: last?.ts || null,
      avgCountsPerScan: avg,
      top: {
        entryGate: topEntryGate,
        obReason: topObReason,
        desiredWhy: topN(desiredWhy, 8),
        radarOut: topN(radarOut, 5),
      },
      lastSettings: last?.settings || null,
      note:
        "Gebruik dit om te zien waar coins vastlopen. Als 'Depth too thin' bovenaan staat: depth threshold is te streng voor jouw coins.",
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e) }));
  }
}