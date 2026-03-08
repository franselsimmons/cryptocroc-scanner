import { requireSecret, RUNTIME_CONFIG } from "../../lib/_moon_core.js";
import { runMoonAll } from "../../lib/_moon_run_all.js";

export const config = RUNTIME_CONFIG;

const fetchFn = globalThis.fetch;

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const base = process.env.BASE_URL || `https://${req.headers.host}`;
    const token = String(process.env.CRON_SECRET || "");

    if (!token) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "Missing CRON_SECRET env var" }));
    }

    const result = await runMoonAll({
      base,
      token,
      fetchFn,
      sleepMs: 2000,
      maxMs: 25_000,
    });

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({
      ok: true,
      cron: true,
      result,
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({
      ok: false,
      cron: true,
      error: String(e?.message || e),
    }));
  }
}