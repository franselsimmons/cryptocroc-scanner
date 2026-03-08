import { requireSecret, RUNTIME_CONFIG } from "../../lib/_moon_core.js";
import { runMoonAll } from "../../lib/_moon_run_all.js";

export const config = RUNTIME_CONFIG;

const fetchFn = globalThis.fetch;

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    let base = process.env.BASE_URL;
    if (!base) {
      const host = req.headers.host;
      if (!host) throw new Error("Missing BASE_URL and no host header");
      base = `https://${host}`;
    } else if (!base.startsWith("http://") && !base.startsWith("https://")) {
      base = "https://" + base;
    }

    if (base.endsWith("/")) base = base.slice(0, -1);

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
    res.end(JSON.stringify({
      ok: true,
      cron: true,
      result,
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      ok: false,
      cron: true,
      error: String(e?.message || e),
    }));
  }
}