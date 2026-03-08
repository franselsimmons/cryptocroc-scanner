import { runMoonAll } from "../../lib/_moon_run_all.js";

export const config = { runtime: "nodejs" };

const fetchFn = globalThis.fetch;

export default async function handler(req, res) {
  try {
    const token = String(req.query?.token || "");

    if (!token || token !== String(process.env.CRON_SECRET || "")) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
    }

    let base = String(process.env.BASE_URL || "").trim();

    if (!base) {
      const host = String(req.headers.host || "").trim();
      if (!host) throw new Error("Missing BASE_URL and no host header");
      base = `https://${host}`;
    }

    if (!base.startsWith("http://") && !base.startsWith("https://")) {
      base = `https://${base}`;
    }

    if (base.endsWith("/")) base = base.slice(0, -1);

    const result = await runMoonAll({
      base,
      token,
      fetchFn,
      sleepMs: 2000,
      maxMs: 25000,
    });

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    return res.end(
      JSON.stringify({
        ok: true,
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