// /api/moon-run-all.js
export const config = { runtime: "nodejs" };

const fetchFn = globalThis.fetch;

function getBaseUrl(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return `https://${req.headers.host}`;
}

export default async function handler(req, res) {
  try {
    const mode = String(req.query?.mode || "bull").toLowerCase();
    const token = String(req.query?.token || "");

    if (!token || token !== String(process.env.CRON_SECRET || "")) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
    }

    const base = getBaseUrl(req);
    const headers = {
      accept: "application/json",
      authorization: `Bearer ${process.env.CRON_SECRET}`,
    };

    const scanRes = await fetchFn(`${base}/api/moon-scan?mode=${encodeURIComponent(mode)}`, { headers });
    const scanText = await scanRes.text();
    let scanData = null;
    try { scanData = JSON.parse(scanText); } catch { scanData = { raw: scanText }; }

    // kleine pauze is ok, maar hoeft niet groot
    await new Promise((r) => setTimeout(r, 600));

    const obRes = await fetchFn(`${base}/api/moon-ob-sampler`, { headers });
    const obText = await obRes.text();
    let obData = null;
    try { obData = JSON.parse(obText); } catch { obData = { raw: obText }; }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({
      ok: true,
      mode,
      scanOk: scanRes.ok,
      scanStatus: scanRes.status,
      obOk: obRes.ok,
      obStatus: obRes.status,
      scan: scanData,
      ob: obData,
      ts: Date.now(),
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ ok: false, error: String(e) }));
  }
}