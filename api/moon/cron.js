import { requireSecret, RUNTIME_CONFIG } from "../../lib/_moon_core.js";

export const config = RUNTIME_CONFIG;

const fetchFn = globalThis.fetch;

export default async function handler(req, res) {
  try {
    // Deze functie accepteert nu ook de Authorization: Bearer header
    if (!requireSecret(req, res)) return;

    const base = process.env.BASE_URL || `https://${req.headers.host}`;
    const token = String(process.env.CRON_SECRET || "");
    const t = Date.now();

    // Roep je bestaande run-all aan met token in de query (interne call)
    const runRes = await fetchFn(`${base}/api/moon/run-all?token=${encodeURIComponent(token)}&_t=${t}`);
    const runText = await runRes.text();

    let runJson = null;
    try {
      runJson = JSON.parse(runText);
    } catch {
      runJson = { raw: runText.slice(0, 400) };
    }

    res.statusCode = runRes.ok ? 200 : 500;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({
      ok: runRes.ok,
      cron: true,
      result: runJson,
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}