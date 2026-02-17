// /api/logs.js
import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, requireSecret, keyEntryLog } from "./_core.js";

export const config = RUNTIME_CONFIG;

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const limit = Math.max(1, Math.min(200, Number(req.query?.limit || 50)));

    if (typeof kv.lrange === "function") {
      const raw = await kv.lrange(keyEntryLog, 0, limit - 1);
      const items = (raw || []).map((x) => {
        try { return JSON.parse(x); } catch { return { raw: String(x) }; }
      });

      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ok: true, limit, items }));
    }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      ok: true,
      items: [],
      note: "KV list functies niet beschikbaar. Scan.js gebruikt fallback keys log:entry:*"
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e) }));
  }
}