// /api/moon/run-all.js
export const config = { runtime: "nodejs" };

const fetchFn = globalThis.fetch;

export default async function handler(req, res) {
  try {
    const { mode = "bull", token } = req.query;

    if (!token || token !== process.env.CRON_SECRET) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
    }

    const base = process.env.BASE_URL || `https://${req.headers.host}`;

    const t = Date.now();

    const scanRes = await fetchFn(`${base}/api/moon/scan?mode=${mode}&token=${token}&_t=${t}`);
    const scanText = await scanRes.text();
    const scanData = safeJson(scanText);

    await sleep(1200);

    const obRes = await fetchFn(`${base}/api/moon/ob-sampler?token=${token}&_t=${t}`);
    const obText = await obRes.text();
    const obData = safeJson(obText);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({
      ok: true,
      mode,
      scanOk: scanRes.ok,
      obOk: obRes.ok,
      scan: scanData,
      ob: obData,
    }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
  }
}

function safeJson(text) { try { return JSON.parse(text); } catch { return { raw: String(text).slice(0, 400) }; } }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }