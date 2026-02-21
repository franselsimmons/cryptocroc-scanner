// /api/health.js
import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  try {
    const now = Date.now();
    const modes = ["bull", "bear"];
    const status = { ok: true, ts: now, modes: {} };

    for (const mode of modes) {
      // ✅ dynamische import uit /lib
      const core = await import(`../lib/_core_${mode}.js`);
      const { keyLatest, keyObResultMapTs, keyState } = core;

      const latest = await kv.get(keyLatest(mode));
      const obMapTs = await kv.get(keyObResultMapTs(mode));
      const state = await kv.get(keyState(mode));

      const stateCount = state ? Object.keys(state).length : 0;
      const entryCount = latest?.funnel?.entry?.length || 0;

      status.modes[mode] = {
        latestTs: latest?.ts || null,
        obMapTs: obMapTs || null,
        obMapAge: obMapTs ? (now - obMapTs) / 1000 / 60 : null,
        stateCount,
        entryCount,
      };
    }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(status, null, 2));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e) }));
  }
}