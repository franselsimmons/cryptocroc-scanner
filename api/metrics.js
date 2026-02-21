import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, requireSecret } from "../lib/_runtime.js";

export const config = RUNTIME_CONFIG;

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const bull = await kv.get("latest:bull");
    const bear = await kv.get("latest:bear");

    const out = {
      ok: true,
      ts: Date.now(),
      latest: {
        bull: { ts: bull?.ts || null, counts: bull?.counts || null },
        bear: { ts: bear?.ts || null, counts: bear?.counts || null }
      }
    };

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(out, null, 2));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}