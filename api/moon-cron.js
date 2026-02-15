// /api/moon-cron.js
import { RUNTIME_CONFIG, requireSecret } from "./_moon_core.js";

export const config = RUNTIME_CONFIG;

export default async function handler(req, res) {
  try {
    // zelfde beveiliging als de rest
    if (!requireSecret(req, res)) return;

    const base = `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host}`;
    const token = process.env.CRON_SECRET ? `&token=${encodeURIComponent(process.env.CRON_SECRET)}` : "";

    const bullUrl = `${base}/api/moon-scan?mode=bull${token}`;
    const bearUrl = `${base}/api/moon-scan?mode=bear${token}`;

    const [bullR, bearR] = await Promise.all([
      fetch(bullUrl, { cache: "no-store" }),
      fetch(bearUrl, { cache: "no-store" }),
    ]);

    const bullText = await bullR.text();
    const bearText = await bearR.text();

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        ok: true,
        ran: ["bull", "bear"],
        bull: { status: bullR.status, body: safeJson(bullText) },
        bear: { status: bearR.status, body: safeJson(bearText) },
      })
    );
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e) }));
  }
}

function safeJson(t) {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}