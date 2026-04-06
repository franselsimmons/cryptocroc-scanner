// api/analyze-reset.js
import { kv } from "@vercel/kv";

function requireSecret(req, res) {
  const qToken = String(req.query?.token || "");
  const bearer = String(req.headers?.authorization || "");
  const headerToken = bearer.toLowerCase().startsWith("bearer ") ? bearer.slice(7).trim() : "";

  const ok =
    (process.env.CRON_SECRET && qToken && qToken === String(process.env.CRON_SECRET)) ||
    (process.env.SCAN_SECRET && qToken && qToken === String(process.env.SCAN_SECRET)) ||
    (process.env.CRON_SECRET && headerToken && headerToken === String(process.env.CRON_SECRET)) ||
    (process.env.SCAN_SECRET && headerToken && headerToken === String(process.env.SCAN_SECRET));

  if (ok) return true;

  res.statusCode = 401;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
  return false;
}

export default async function handler(req, res) {
  if (!requireSecret(req, res)) return;

  try {
    const keys = [
      "cc:events:trade_opened:list",
      "cc:events:trade_closed:list",
      "cc:events:scan_transition:list",
      "cc:events:scan_main:list",
      "cc:events:scan_moon:list",
    ];

    for (const key of keys) {
      try {
        await kv.del(key);
      } catch {}
    }

    res.status(200).json({
      ok: true,
      reset: keys,
      note: "Event lists zijn geleegd. Dedupe keys lopen vanzelf af via TTL.",
      ts: Date.now(),
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err?.message || String(err),
    });
  }
}