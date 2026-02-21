import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs" };

function safeArr(x) { return Array.isArray(x) ? x : []; }

export default async function handler(req, res) {
  try {
    const mode = String(req.query?.mode || "bull").toLowerCase();
    if (mode !== "bull" && mode !== "bear") {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "mode must be bull/bear" }));
    }

    const core = await import(`../../lib/_core_${mode}.js`);
    const { requireSecret, keyLatest, keyObResult, keyObResultMapTs } = core;

    if (!requireSecret(req, res)) return;

    const latest = await kv.get(keyLatest(mode));
    const f = latest?.funnel || {};

    const coins = [
      ...safeArr(f.entry),
      ...safeArr(f.almost),
      ...safeArr(f.buildup),
      ...safeArr(f.radar),
    ];

    const symbols = Array.from(new Set(
      coins.map(c => String(c?.symbol || "").toUpperCase()).filter(Boolean)
    ));

    const map = {};
    for (const sym of symbols) {
      const r = await kv.get(keyObResult(mode, sym));
      if (r) map[sym] = r;
    }

    const ts = Date.now();

    // Als jouw core keyObResultMapTs bestaat, gebruiken we die. Anders fallback.
    if (typeof keyObResultMapTs === "function") {
      await kv.set(keyObResultMapTs(mode), ts);
    } else {
      await kv.set(`ob:map:ts:${mode}`, ts);
    }

    // Optioneel: de map zelf opslaan (handig voor debug)
    await kv.set(`ob:map:${mode}`, { ts, size: Object.keys(map).length, map });

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({
      ok: true,
      mode,
      ts,
      symbols: symbols.length,
      stored: Object.keys(map).length
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}