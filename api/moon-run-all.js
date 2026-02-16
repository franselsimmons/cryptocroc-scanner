// /api/moon-run-all.js
import { requireSecret } from "./_moon_core.js";

export const config = { runtime: "nodejs20.x" };

const fetchFn = globalThis.fetch;

async function hit(req, path) {
  const base = `https://${req.headers.host}`;
  const url = new URL(path, base);

  const r = await fetchFn(url.toString(), {
    method: "GET",
    headers: {
      accept: "application/json",
      // Als dit endpoint door cron wordt geraakt: doorgeven zodat de subcalls nooit 401 krijgen
      ...(String(req.headers?.["x-vercel-cron"] || "") === "1"
        ? { "x-vercel-cron": "1" }
        : {}),
      "cache-control": "no-store",
    },
  });

  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}

  return { ok: r.ok, status: r.status, path: url.pathname + url.search, json, text: json ? null : text.slice(0, 300) };
}

export default async function handler(req, res) {
  try {
    // Laat cron door (x-vercel-cron:1), of token/secret
    if (!requireSecret(req, res)) return;

    const mode = (req.query?.mode || "bull").toLowerCase();
    const m = mode === "bear" ? "bear" : "bull";

    // 1) Scan
    const scan = await hit(req, `/api/moon-scan?mode=${m}`);

    // 2) kleine pauze zodat KV write zeker klaar is
    await new Promise((r) => setTimeout(r, 800));

    // 3) OB sampler
    const ob = await hit(req, `/api/moon-ob-sampler`);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, ts: Date.now(), mode: m, scan, ob }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e) }));
  }
}