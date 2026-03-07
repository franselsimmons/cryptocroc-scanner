export const config = { runtime: "nodejs" };

const fetchFn = globalThis.fetch;

export default async function handler(req, res) {
  const START = Date.now();
  const MAX_MS = 25_000; // max 25 seconden

  function ensureTime() {
    if (Date.now() - START > MAX_MS) {
      throw new Error("run-all exceeded safe time budget");
    }
  }

  try {
    const { token } = req.query; // mode wordt genegeerd, altijd beide modes

    if (!token || token !== process.env.CRON_SECRET) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
    }

    const base = process.env.BASE_URL || `https://${req.headers.host}`;

    const t = Date.now();

    // === 2-pass warmup flow ===
    // Eerste scan om funnel te vullen (beide modes)
    const scanBull1Res = await fetchFn(`${base}/api/moon/scan?mode=bull&token=${token}&_t=${t}`);
    const scanBull1Text = await scanBull1Res.text();

    const scanBear1Res = await fetchFn(`${base}/api/moon/scan?mode=bear&token=${token}&_t=${t}`);
    const scanBear1Text = await scanBear1Res.text();

    // Korte pauze
    await sleep(2000);
    ensureTime();

    // OB sampler warmt de gevonden kandidaten op
    const obRes = await fetchFn(`${base}/api/moon/ob-sampler?token=${token}&_t=${t}`);
    const obText = await obRes.text();
    const obData = safeJson(obText);

    // Nog een pauze
    await sleep(2000);
    ensureTime();

    // Tweede scan met verse OB-data
    const scanBull2Res = await fetchFn(`${base}/api/moon/scan?mode=bull&token=${token}&_t=${t}`);
    const scanBull2Text = await scanBull2Res.text();

    const scanBear2Res = await fetchFn(`${base}/api/moon/scan?mode=bear&token=${token}&_t=${t}`);
    const scanBear2Text = await scanBear2Res.text();

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({
      ok: true,
      scope: "bull+bear",
      steps: {
        scanBull1: { ok: scanBull1Res.ok, status: scanBull1Res.status, preview: scanBull1Text.slice(0, 200) },
        scanBear1: { ok: scanBear1Res.ok, status: scanBear1Res.status, preview: scanBear1Text.slice(0, 200) },
        obSampler: { ok: obRes.ok, status: obRes.status, data: obData },
        scanBull2: { ok: scanBull2Res.ok, status: scanBull2Res.status, preview: scanBull2Text.slice(0, 200) },
        scanBear2: { ok: scanBear2Res.ok, status: scanBear2Res.status, preview: scanBear2Text.slice(0, 200) },
      },
    }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
  }
}

function safeJson(text) { try { return JSON.parse(text); } catch { return { raw: String(text).slice(0, 400) }; } }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }