// /api/moon/cron.js

import { RUNTIME_CONFIG, requireSecret } from "../../lib/_moon_core.js";

export const config = RUNTIME_CONFIG;

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  return res.end(JSON.stringify(obj));
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const proto = req.headers["x-forwarded-proto"] || "https";

    if (!host) {
      return send(res, 500, {
        ok: false,
        error: "Missing host header",
      });
    }

    const base = `${proto}://${host}`;
    const secret = String(process.env.CRON_SECRET || "");

    if (!secret) {
      return send(res, 500, {
        ok: false,
        error: "Missing CRON_SECRET env var",
      });
    }

    const headers = {
      "x-cron-secret": secret,
      "content-type": "application/json",
      "cache-control": "no-cache, no-store, max-age=0",
    };

    const results = {};

    const bullRes = await fetch(`${base}/api/moon/scan?mode=bull`, {
      method: "GET",
      headers,
      cache: "no-store",
    });
    results.bull = await bullRes.json().catch(() => ({
      ok: false,
      error: `Bull scan returned non-JSON (${bullRes.status})`,
    }));

    const bearRes = await fetch(`${base}/api/moon/scan?mode=bear`, {
      method: "GET",
      headers,
      cache: "no-store",
    });
    results.bear = await bearRes.json().catch(() => ({
      ok: false,
      error: `Bear scan returned non-JSON (${bearRes.status})`,
    }));

    return send(res, 200, {
      ok: true,
      cron: true,
      base,
      ranAt: Date.now(),
      results,
    });
  } catch (e) {
    return send(res, 500, {
      ok: false,
      cron: true,
      error: String(e?.message || e),
    });
  }
}