import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG } from "../lib/_runtime.js";

export const config = RUNTIME_CONFIG;

export default async function handler(req, res) {
  try {
    const now = Date.now();
    const out = { ok: true, ts: now, modes: {} };

    for (const mode of ["bull", "bear"]) {
      const core = await import(`../lib/_core_${mode}.js`);
      const latest = await kv.get(core.keyLatest(mode));
      const obMapTs = await kv.get(core.keyObResultMapTs(mode));
      const state = await kv.get(core.keyState(mode));

      out.modes[mode] = {
        latestTs: latest?.ts || null,
        obMapTs: obMapTs || null,
        obMapAgeMin: obMapTs ? (now - obMapTs) / 1000 / 60 : null,
        stateCount: state ? Object.keys(state).length : 0,
        entryCount: latest?.funnel?.entry?.length || 0
      };
    }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(out, null, 2));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}