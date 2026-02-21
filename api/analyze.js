// /api/analyze.js
import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs20.x" };

// MAIN (bestaand)
import { requireSecret, keyDiagList, keyDiagSnap } from "./_core_bull.js";

// MOON (nieuw, alleen gebruikt als ?funnel=moon)
import { keyMoonDiagList, keyMoonDiagSnap } from "./_moon_core.js";

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

function parseMaybeJson(x) {
  try {
    if (typeof x === "string") return JSON.parse(x);
    return x;
  } catch {
    return null;
  }
}

async function loadDiags({ funnel, mode, limit }) {
  const isMoon = funnel === "moon";

  const listKey = isMoon ? keyMoonDiagList(mode) : keyDiagList(mode);
  const snapKey = isMoon ? keyMoonDiagSnap(mode) : keyDiagSnap(mode);

  let diags = [];

  // Prefer list history
  if (typeof kv.lrange === "function") {
    const raw = await kv.lrange(listKey, 0, limit - 1);
    diags = (raw || []).map(parseMaybeJson).filter(Boolean);
  } else {
    const snap = await kv.get(snapKey);
    if (snap) diags = [snap];
  }

  return diags;
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    // ✅ default blijft MAIN
    const funnelRaw = String(req.query?.funnel || "main").toLowerCase();
    const funnel = funnelRaw === "moon" ? "moon" : "main";

    const mode = String(req.query?.mode || "bear").toLowerCase();
    const limit = Math.max(5, Math.min(200, Number(req.query?.limit || 50)));

    const diags = await loadDiags({ funnel, mode, limit });

    if (!diags.length) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      return res.end(
        JSON.stringify({
          ok: true,
          funnel,
          mode,
          note:
            funnel === "moon"
              ? "No MOON diagnostics yet. Run /api/moon-scan a few times first."
              : "No diagnostics yet. Run /api/scan a few times first.",
        })
      );
    }

    const last = diags[0];

    // =========================
    // MAIN AGGREGATION (zoals je nu hebt)
    // =========================
    if (funnel === "main") {
      let total = 0;
      let entrySum = 0;
      let almostSum = 0;
      let buildupSum = 0;
      let radarSum = 0;

      let entryGate = {};
      let obReason = {};
      let desiredWhy = {};
      let radarOut = {};

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

      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      return res.end(
        JSON.stringify({
          ok: true,
          funnel: "main",
          mode,
          scansUsed: total,
          lastTs: last?.ts || null,
          avgCountsPerScan: avg,
          top: {
            entryGate: topN(entryGate, 5),
            obReason: topN(obReason, 5),
            desiredWhy: topN(desiredWhy, 8),
            radarOut: topN(radarOut, 5),
          },
          lastSettings: last?.settings || null,
          note:
            "Main analyze. Als 'Depth too thin' bovenaan staat: depth threshold is te streng voor jouw coins.",
        })
      );
    }

    // =========================
    // MOON AGGREGATION (nieuw)
    // =========================
    let total = 0;
    let eliteSum = 0;
    let almostSum = 0;
    let buildupSum = 0;
    let radarSum = 0;

    let obReason = {};
    let buildupWhy = {};
    let almostWhy = {};
    let eliteWhy = {};
    let eliteExtraFail = {};
    let radarOut = {};

    for (const d of diags) {
      total += 1;

      eliteSum += Number(d?.counts?.elite || 0);
      almostSum += Number(d?.counts?.almost || 0);
      buildupSum += Number(d?.counts?.buildup || 0);
      radarSum += Number(d?.counts?.radar || 0);

      obReason = mergeCountMaps(obReason, d?.reasons?.obReason);
      buildupWhy = mergeCountMaps(buildupWhy, d?.reasons?.buildupWhy);
      almostWhy = mergeCountMaps(almostWhy, d?.reasons?.almostWhy);
      eliteWhy = mergeCountMaps(eliteWhy, d?.reasons?.eliteWhy);
      eliteExtraFail = mergeCountMaps(eliteExtraFail, d?.reasons?.eliteExtraFail);
      radarOut = mergeCountMaps(radarOut, d?.reasons?.radarOut);
    }

    const avg = {
      elite: eliteSum / total,
      almost: almostSum / total,
      buildup: buildupSum / total,
      radar: radarSum / total,
    };

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    return res.end(
      JSON.stringify({
        ok: true,
        funnel: "moon",
        mode,
        scansUsed: total,
        lastTs: last?.ts || null,
        avgCountsPerScan: avg,
        top: {
          obReason: topN(obReason, 6),
          buildupWhy: topN(buildupWhy, 6),
          almostWhy: topN(almostWhy, 6),
          eliteWhy: topN(eliteWhy, 6),
          eliteExtraFail: topN(eliteExtraFail, 6),
          radarOut: topN(radarOut, 6),
        },
        lastSettings: last?.settings || null,
        note:
          "MOON analyze. Kijk vooral naar 'eliteWhy' en 'eliteExtraFail' om te zien welke drempel het vaakst blokkeert.",
      })
    );
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}