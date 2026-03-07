import { requireSecret, RUNTIME_CONFIG } from "../../lib/_moon_core.js";

export const config = RUNTIME_CONFIG;

const fetchFn = globalThis.fetch;

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: String(text || "").slice(0, 500) };
  }
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const base = process.env.BASE_URL || `https://${req.headers.host}`;
    const cronSecret = String(process.env.CRON_SECRET || "");
    const bypassSecret = String(process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "");
    const t = Date.now();

    if (!cronSecret) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({
        ok: false,
        error: "Missing CRON_SECRET env var",
      }));
    }

    const headers = {
      authorization: `Bearer ${cronSecret}`,
      "content-type": "application/json",
    };

    if (bypassSecret) {
      headers["x-vercel-protection-bypass"] = bypassSecret;
    }

    const url =
      `${base}/api/moon/run-all?_t=${t}` +
      (bypassSecret
        ? `&x-vercel-protection-bypass=${encodeURIComponent(bypassSecret)}`
        : "");

    const runRes = await fetchFn(url, {
      method: "GET",
      headers,
    });

    const runText = await runRes.text();
    const runJson = safeJson(runText);

    res.statusCode = runRes.ok ? 200 : 500;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({
      ok: runRes.ok,
      cron: true,
      upstreamStatus: runRes.status,
      result: runJson,
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({
      ok: false,
      error: String(e?.message || e),
    }));
  }
}