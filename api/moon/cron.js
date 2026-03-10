import { RUNTIME_CONFIG, requireSecret } from "../../lib/_moon_core.js";

export const config = RUNTIME_CONFIG;

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  return res.end(JSON.stringify(obj));
}

async function runInternal(req) {
  const proto =
    String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || "https";
  const host =
    String(req.headers["x-forwarded-host"] || "").split(",")[0].trim() ||
    String(req.headers.host || "").trim();

  if (!host) throw new Error("Missing host header");

  const token = String(process.env.CRON_SECRET || "");
  if (!token) throw new Error("Missing CRON_SECRET env var");

  const url = `${proto}://${host}/api/moon/run-all?token=${encodeURIComponent(token)}`;

  const r = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "cache-control": "no-store",
    },
  });

  const text = await r.text();
  let json = null;

  try {
    json = JSON.parse(text);
  } catch {
    json = { ok: false, raw: text };
  }

  return {
    ok: r.ok && !!json?.ok,
    status: r.status,
    url,
    body: json,
  };
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const result = await runInternal(req);
    return send(res, result.ok ? 200 : 500, {
      ok: result.ok,
      cron: true,
      ts: Date.now(),
      result,
    });
  } catch (e) {
    return send(res, 500, {
      ok: false,
      cron: true,
      error: String(e?.message || e),
    });
  }
}