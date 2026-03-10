// /api/moon/latest.js

import { kv } from "@vercel/kv";
import {
  RUNTIME_CONFIG,
  requireSecret,
  keyMoonLatest,
} from "../../lib/_moon_core.js";

export const config = RUNTIME_CONFIG;

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  return res.end(JSON.stringify(obj));
}

function getMode(req) {
  return String(req.query?.mode || "bull").toLowerCase() === "bear"
    ? "bear"
    : "bull";
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const mode = getMode(req);
    const key = keyMoonLatest(mode);
    const data = await kv.get(key);

    return send(res, 200, {
      ok: true,
      mode,
      key,
      hasData: !!data,
      data: data || null,
    });
  } catch (e) {
    return send(res, 500, {
      ok: false,
      error: String(e?.message || e),
    });
  }
}