import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs" };

function safeArr(x) { return Array.isArray(x) ? x : []; }
function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

const OB_MAX_AGE_MS = 180000;      // 3 min
const MAP_TTL_SEC = 60 * 10;       // 10 min (genoeg voor dashboard/debug)

function slimOb(r) {
  // Maak het object klein en voorspelbaar voor KV
  const obTs = n(r?.ob?.ts ?? r?.ts, 0);
  return {
    symbol: String(r?.symbol || "").toUpperCase(),
    valid: !!r?.valid,
    reason: String(r?.reason || ""),
    ts: n(r?.ts, 0),
    slope: r?.slope ?? null,

    // kern metrics
    score: n(r?.score, 0),
    spreadPct: n(r?.spreadPct, 999),
    lor: n(r?.lor, 1),
    depthMinUsd1p: n(r?.depthMinUsd1p, 0),

    // ob snapshot kern
    ob: {
      ts: obTs,
      mid: n(r?.ob?.mid, 0),
      spreadPct: n(r?.ob?.spreadPct, 999),
      bidUsd: n(r?.ob?.bidUsd, 0),
      askUsd: n(r?.ob?.askUsd, 0),
      score: n(r?.ob?.score, 0),
      lor: n(r?.ob?.lor, 1),
      depthMinUsd1p: n(r?.ob?.depthMinUsd1p, 0),
    },
  };
}

export default async function handler(req, res) {
  try {
    const mode = String(req.query?.mode || "bull").toLowerCase();
    if (mode !== "bull" && mode !== "bear") {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "mode must be bull/bear" }));
    }

    // ✅ correct pad + runtime secret (niet core)
    const core = await import(`../../lib/_core_${mode}.js`);
    const { keyLatest, keyObResult, keyObResultMapTs } = core;

    const rt = await import("../../lib/_runtime.js");
    if (!rt.requireSecret(req, res)) return;

    const latest = await kv.get(keyLatest(mode));
    const f = latest?.funnel || {};

    // pak funnel coins (in volgorde van belang)
    const coins = [
      ...safeArr(f.entry),
      ...safeArr(f.almost),
      ...safeArr(f.buildup),
      ...safeArr(f.radar),
    ];

    const symbols = Array.from(new Set(
      coins.map(c => String(c?.symbol || "").toUpperCase()).filter(Boolean)
    ));

    const now = Date.now();
    const map = {};
    let fetched = 0;
    let stored = 0;
    let staleSkipped = 0;
    let invalidSkipped = 0;

    for (const sym of symbols) {
      fetched++;
      const r = await kv.get(keyObResult(mode, sym));
      if (!r) continue;

      // ✅ stale filter (alleen verse OB)
      const obTs = n(r?.ob?.ts ?? r?.ts, 0);
      const age = obTs > 0 ? (now - obTs) : Number.POSITIVE_INFINITY;
      const fresh = obTs > 0 && age <= OB_MAX_AGE_MS;

      if (!fresh) { staleSkipped++; continue; }
      if (!r?.valid) { invalidSkipped++; continue; }

      map[sym] = slimOb(r);
      stored++;
    }

    const ts = Date.now();

    // timestamp key
    if (typeof keyObResultMapTs === "function") {
      await kv.set(keyObResultMapTs(mode), ts, { ex: MAP_TTL_SEC });
    } else {
      await kv.set(`ob:map:ts:${mode}`, ts, { ex: MAP_TTL_SEC });
    }

    // ✅ slanke map met TTL (veilig voor KV size)
    await kv.set(
      `ob:map:${mode}`,
      { ts, size: stored, map },
      { ex: MAP_TTL_SEC }
    );

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({
      ok: true,
      mode,
      ts,
      symbols: symbols.length,
      fetched,
      stored,
      staleSkipped,
      invalidSkipped,
      ttlSec: MAP_TTL_SEC,
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}