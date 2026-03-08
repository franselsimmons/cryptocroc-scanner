import { runMoonAll } from "../../lib/_moon_run_all.js";

export const config = { runtime: "nodejs" };

const fetchFn = globalThis.fetch;

export default async function handler(req, res) {
  try {
    const { token } = req.query;

    if (!token || token !== process.env.CRON_SECRET) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
    }

    const base = process.env.BASE_URL || `https://${req.headers.host}`;

    const result = await runMoonAll({
      base,
      token: String(token),
      fetchFn,
      sleepMs: 2000,
      maxMs: 25_000,
    });

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(result));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
  }
}