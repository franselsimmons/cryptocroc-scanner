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

    let base = process.env.BASE_URL;
    if (!base) {
      const host = req.headers.host;
      if (!host) throw new Error("Missing BASE_URL and no host header");
      base = `https://${host}`;
    } else if (!base.startsWith("http://") && !base.startsWith("https://")) {
      base = "https://" + base;
    }

    if (base.endsWith("/")) base = base.slice(0, -1);

    const result = await runMoonAll({
      base,
      token: String(token),
      fetchFn,
      sleepMs: 2000,
      maxMs: 25_000,
    });

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
  }
}