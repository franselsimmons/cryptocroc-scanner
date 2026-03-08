import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, requireSecret, keyMoonReset } from "../../lib/_moon_core.js"; // FIX: pad gecorrigeerd

export const config = RUNTIME_CONFIG;

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const mode = (req.query?.mode || "bull").toLowerCase();
    const m = mode === "bear" ? "bear" : "bull";

    const now = Date.now();
    await kv.set(keyMoonReset(m), now);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, ts: now, mode: m }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e) }));
  }
}