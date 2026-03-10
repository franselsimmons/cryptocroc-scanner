import { requireSecret, RUNTIME_CONFIG } from "../../lib/_moon_core.js";
import { runMoonAll } from "../../lib/_moon_run_all.js";

export const config = {
  ...RUNTIME_CONFIG,
  maxDuration: 300,
};

const fetchFn = globalThis.fetch;

export default async function handler(req, res) {
  const startedAt = Date.now();

  try {
    if (!requireSecret(req, res)) return;

    let base = String(process.env.BASE_URL || "").trim();

    if (!base) {
      const host = req.headers.host;
      if (!host) throw new Error("Missing BASE_URL and no host header");
      base = `https://${host}`;
    } else if (!base.startsWith("http://") && !base.startsWith("https://")) {
      base = `https://${base}`;
    }

    if (base.endsWith("/")) base = base.slice(0, -1);

    const token = String(process.env.CRON_SECRET || "").trim();
    if (!token) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      return res.end(
        JSON.stringify({
          ok: false,
          cron: true,
          error: "Missing CRON_SECRET env var",
        })
      );
    }

    console.log("[moon/run-all] start", { base });

    const result = await runMoonAll({
      base,
      token,
      fetchFn,
      sleepMs: 900,
      maxMs: 240_000,
    });

    const durationMs = Date.now() - startedAt;

    console.log("[moon/run-all] done", {
      durationMs,
      result,
    });

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    return res.end(
      JSON.stringify({
        ok: true,
        cron: true,
        durationMs,
        result,
      })
    );
  } catch (e) {
    const durationMs = Date.now() - startedAt;

    console.error("[moon/run-all] error", {
      durationMs,
      error: String(e?.message || e),
    });

    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    return res.end(
      JSON.stringify({
        ok: false,
        cron: true,
        durationMs,
        error: String(e?.message || e),
      })
    );
  }
}