// /api/moon-cron.js
import { requireSecret, RUNTIME_CONFIG } from "./_moon_core.js";

export const config = RUNTIME_CONFIG;

async function hit(req, path) {
  // Altijd exact dezelfde host gebruiken als waar deze cron op draait
  const base = `https://${req.headers.host}`;
  const url = new URL(path, base);

  // Belangrijk: interne calls moeten ook “cron” zijn, anders krijg je 401
  const r = await fetch(url.toString(), {
    method: "GET",
    headers: {
      accept: "application/json",
      "x-vercel-cron": "1",     // ✅ DE FIX
      "cache-control": "no-store",
    },
  });

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
    // Cron-job zelf mag door (x-vercel-cron: 1)
    if (!requireSecret(req, res)) return;

    // 1) scan bull + bear
    const scanBull = await hit(req, "/api/moon-scan?mode=bull");
    const scanBear = await hit(req, "/api/moon-scan?mode=bear");

    // 2) sampler (pakt candidates uit latest)
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