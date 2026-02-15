// /api/moon-cron.js
import { RUNTIME_CONFIG, requireSecret } from "./_moon_core.js";

export const config = RUNTIME_CONFIG;

async function hit(url, secret) {
  const r = await fetch(url, { headers: secret ? { authorization: `Bearer ${secret}` } : {} });
  return { ok: r.ok, status: r.status };
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const secret = process.env.CRON_SECRET || "";
    const base = `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host}`;

    // 1) scan bull + bear
    const a = await hit(`${base}/api/moon-scan?mode=bull`, secret);
    const b = await hit(`${base}/api/moon-scan?mode=bear`, secret);

    // 2) ob sampler (na scan)
    const c = await hit(`${base}/api/moon-ob-sampler`, secret);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, ts: Date.now(), scanBull: a, scanBear: b, ob: c }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e) }));
  }
}
