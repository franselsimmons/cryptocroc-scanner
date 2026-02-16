// /api/moon-cron.js
import { requireSecret, RUNTIME_CONFIG } from "./_moon_core.js";

export const config = RUNTIME_CONFIG;

function getBaseUrl(req) {
  // 1) Als je BASE_URL gezet hebt in env, gebruik die (aanrader)
  if (process.env.BASE_URL) return process.env.BASE_URL;

  // 2) Anders: gebruik VERCEL_URL
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;

  // 3) Fallback lokaal
  const host = req?.headers?.host || "localhost:3000";
  return `https://${host}`;
}

async function hit(req, path) {
  const base = getBaseUrl(req);
  const secret = process.env.CRON_SECRET || "";

  const url = new URL(path, base);

  const headers = { accept: "application/json" };
  // ✅ SUPER BELANGRIJK: interne calls authenticeren met Bearer
  if (secret) headers.authorization = `Bearer ${secret}`;

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
    // ✅ Cron zelf mag door via x-vercel-cron of Bearer/token
    if (!requireSecret(req, res)) return;

    // 1) scan bull + bear
    const scanBull = await hit(req, "/api/moon-scan?mode=bull");
    const scanBear = await hit(req, "/api/moon-scan?mode=bear");

    // 2) sampler pakt candidates uit latest
    const ob = await hit(req, "/api/moon-ob-sampler");

    const out = {
      ok: true,
      ts: Date.now(),
      scanBull,
      scanBear,
      moonObSampler: ob,
    };

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(out));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e) }));
  }
}