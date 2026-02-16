// /api/moon-run-all.js
export const config = { runtime: "nodejs" };

const fetchFn = globalThis.fetch;

export default async function handler(req, res) {
  try {
    const mode = String(req.query?.mode || "bull").toLowerCase();
    const token = String(req.query?.token || "");

    const secret = process.env.CRON_SECRET || "";
    if (!secret || token !== secret) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      return res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
    }

    const base = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : `https://${req.headers.host}`;

    // ✅ gebruik Bearer header zodat moon-scan/moon-ob-sampler nooit 401 kunnen geven
    const headers = { accept: "application/json", authorization: `Bearer ${secret}` };

    const scanRes = await fetchFn(`${base}/api/moon-scan?mode=${encodeURIComponent(mode)}`, { headers });
    const scanData = await scanRes.json();

    await new Promise((r) => setTimeout(r, 1200));

    const obRes = await fetchFn(`${base}/api/moon-ob-sampler`, { headers });
    const obData = await obRes.json();

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    return res.end(JSON.stringify({ ok: true, mode, scan: scanData, ob: obData, ts: Date.now() }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    return res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
  }
}