// /api/moon-cron.js
import { requireSecret, RUNTIME_CONFIG } from "./_moon_core.js";

export const config = RUNTIME_CONFIG;

async function hit(path) {
  const base =
    process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "http://localhost:3000";

  const secret = process.env.CRON_SECRET || "";

  // interne call: voeg token toe zodat requireSecret nooit kan blokkeren
  const url = new URL(path, base);
  if (secret) url.searchParams.set("token", secret);

  const r = await fetch(url.toString(), {
    method: "GET",
    headers: { accept: "application/json" },
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
    // Vercel cron komt met header x-vercel-cron: 1 (jij laat die al door in _moon_core)
    if (!requireSecret(req, res)) return;

    // 1) scan bull + bear
    const scanBull = await hit("/api/moon-scan?mode=bull");
    const scanBear = await hit("/api/moon-scan?mode=bear");

    // 2) sampler (pakt candidates uit latest)
    const ob = await hit("/api/moon-ob-sampler");

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