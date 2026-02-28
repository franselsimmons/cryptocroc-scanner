// /api/portfolio/tick.js
import { RUNTIME_CONFIG, requireSecret } from "../../lib/_runtime.js";

export const config = RUNTIME_CONFIG;

// Portfolio werkt uit latest snapshots, dus tick is niet nodig.
// We laten hem bestaan zodat je cron/monitoring niet stuk gaat.
export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.end(JSON.stringify({ ok: true, ts: Date.now(), did: "noop", why: "portfolio is derived from latest snapshots" }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}