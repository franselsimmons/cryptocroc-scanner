import { requireSecret, RUNTIME_CONFIG, fetchCoinGeckoTopCached } from "../../lib/_moon_core.js";
export const config = RUNTIME_CONFIG;

async function hit(base, path) {
  const secret = process.env.CRON_SECRET || "";

  const url = new URL(path, base);
  if (secret) url.searchParams.set("token", secret);

  const r = await fetch(url.toString(), { method: "GET", headers: { accept: "application/json" } });
  const text = await r.text();

  let json = null;
  try { json = JSON.parse(text); } catch {}

  return { ok: r.ok, status: r.status, path: url.pathname + url.search, json, text: json ? null : text.slice(0, 300) };
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const base = `https://${req.headers.host}`;

    // 🔁 Haal CoinGecko-data één keer op en zet in cache
    await fetchCoinGeckoTopCached();

    // Roep de scans aan (bull en bear)
    const scanBull = await hit(base, "/api/moon/scan?mode=bull");
    const scanBear = await hit(base, "/api/moon/scan?mode=bear");
    const ob = await hit(base, "/api/moon/ob-sampler");

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, ts: Date.now(), scanBull, scanBear, moonObSampler: ob }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e) }));
  }
}