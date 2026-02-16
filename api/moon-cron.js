// /api/moon-cron.js
import { requireSecret, RUNTIME_CONFIG } from "./_moon_core.js";

export const config = RUNTIME_CONFIG;

function baseUrlFromEnv(req) {
  // ✅ in Vercel is dit altijd goed voor production
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  // fallback
  return `https://${req.headers.host}`;
}

async function hit(req, path) {
  const base = baseUrlFromEnv(req);
  const secret = process.env.CRON_SECRET || "";

  const url = new URL(path, base);

  // ✅ Belangrijk: stuur Bearer header (meest “hard”)
  const headers = { accept: "application/json" };
  if (secret) headers.authorization = `Bearer ${secret}`;

  // (optioneel) token in query ook, mag blijven voor debug
  if (secret) url.searchParams.set("token", secret);

  const r = await fetch(url.toString(), { method: "GET", headers });

  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}

  return {
    ok: r.ok,
    status: r.status,
    path: url.pathname + url.search,
    json,
    text: json ? null : text.slice(0, 300),
  };
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const scanBull = await hit(req, "/api/moon-scan?mode=bull");
    const scanBear = await hit(req, "/api/moon-scan?mode=bear");
    const ob = await hit(req, "/api/moon-ob-sampler");

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify({ ok: true, ts: Date.now(), scanBull, scanBear, moonObSampler: ob }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify({ ok: false, error: String(e) }));
  }
}