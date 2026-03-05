// /api/analyze-reset.js
import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, requireSecret } from "../lib/_runtime.js";

export const config = RUNTIME_CONFIG;

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(obj));
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    if (req.method !== "POST") {
      return send(res, 405, { ok: false, error: "Method not allowed" });
    }

    const now = Date.now();
    await kv.set("analyze:sessionStartMs", now, { ex: 60 * 60 * 24 * 365 }); // 1 jaar

    return send(res, 200, { ok: true, sessionStartMs: now });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e?.message || e) });
  }
}