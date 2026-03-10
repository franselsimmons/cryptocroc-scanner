// /api/moon/run_all_cron.js

import { RUNTIME_CONFIG, requireSecret } from "../../lib/_moon_core.js";
import { runMoonAll } from "../../lib/_moon_run_all.js";

export const config = RUNTIME_CONFIG;

function getBaseFromReq(req) {
  const xfProto = String(req.headers["x-forwarded-proto"] || "").trim();
  const proto = xfProto || "https";
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").trim();

  if (!host) {
    throw new Error("Missing host header");
  }

  return `${proto}://${host}`.replace(/\/+$/, "");
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const base = getBaseFromReq(req);
    const token = String(process.env.CRON_SECRET || "");

    if (!token) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "Missing CRON_SECRET env var" }));
    }

    const result = await runMoonAll({
      base,
      token,
      fetchFn: globalThis.fetch,
      sleepMs: 1200,
      maxMs: 55_000,
    });

    res.statusCode = result.ok ? 200 : 500;
    res.setHeader("content-type", "application/json");
    return res.end(
      JSON.stringify({
        ok: result.ok,
        cron: true,
        result,
      })
    );
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    return res.end(
      JSON.stringify({
        ok: false,
        cron: true,
        error: String(e?.message || e),
      })
    );
  }
}