// /api/reset.js
import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, requireSecret, keyLatest, keyState, keyReset } from "../lib/_core.js";

export const config = RUNTIME_CONFIG;

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const mode = (req.query?.mode || "all").toLowerCase();
    const now = Date.now();
    const modes = mode === "all" ? ["bull", "bear"] : [mode];

    for (const m of modes) {
      if (m !== "bull" && m !== "bear") continue;

      await kv.set(keyReset(m), now);
      await kv.del(keyState(m));
      await kv.del(keyLatest(m));
    }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, resetAt: now, mode }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok:false, error:String(e) }));
  }
}