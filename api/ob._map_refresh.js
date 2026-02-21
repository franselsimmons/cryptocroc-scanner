// /api/ob_map_refresh.js
import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG } from "./_core_bull.js";

export const config = RUNTIME_CONFIG;

// simpele concurrency helper (niet te veel tegelijk)
async function mapLimit(list, limit, fn) {
  const res = [];
  let i = 0;
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (i < list.length) {
      const idx = i++;
      res[idx] = await fn(list[idx], idx);
    }
  });
  await Promise.all(workers);
  return res;
}

export default async function handler(req, res) {
  try {
    const mode = String(req.query?.mode || "bull").toLowerCase();
    if (mode !== "bull" && mode !== "bear") {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "mode must be bull or bear" }));
    }

    const core = await import(`./_core_${mode}.js`);
    const {
      requireSecret,
      keyState,
      keyObResult,
      keyObResultMap,
      keyObResultMapTs,
    } = core;

    if (!requireSecret(req, res)) return;

    const state = (await kv.get(keyState(mode))) || {};
    const symbols = Object.keys(state || {});

    // Pak alleen coins die “serieus” zijn (minder KV reads)
    const wanted = [];
    for (const sym of symbols) {
      const st = state?.[sym]?.stage;
      if (st === "ALMOST" || st === "ENTRY") wanted.push(String(sym).toUpperCase());
    }

    // Hard cap zodat dit altijd snel blijft
    const pick = wanted.slice(0, 220);

    const map = {};
    await mapLimit(pick, 10, async (sym) => {
      const ob = await kv.get(keyObResult(mode, sym));
      if (ob) map[sym] = ob;
    });

    const ts = Date.now();
    await kv.set(keyObResultMap(mode), map, { ex: 60 * 20 }); // 20 min
    await kv.set(keyObResultMapTs(mode), ts, { ex: 60 * 20 });

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      ok: true,
      mode,
      ts,
      symbolsInMap: Object.keys(map).length,
      picked: pick.length,
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e) }));
  }
}