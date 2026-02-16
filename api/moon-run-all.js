// /api/moon-run-all.js
// Combined Moon Scan + OB Sampler
// Runs sequentially to avoid race conditions

export const config = { runtime: "nodejs" };

const fetchFn = globalThis.fetch;

export default async function handler(req, res) {
  try {
    const { mode = "bull", token } = req.query;

    if (!token || token !== process.env.CRON_SECRET) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const base = process.env.BASE_URL || `https://${req.headers.host}`;

    // 1️⃣ Run Moon Scan
    const scanRes = await fetchFn(
      `${base}/api/moon-scan?mode=${mode}&token=${token}`
    );
    const scanData = await scanRes.json();

    // 2️⃣ Small delay (wait for data write)
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 3️⃣ Run OB Sampler
    const obRes = await fetchFn(
      `${base}/api/moon-ob-sampler?token=${token}`
    );
    const obData = await obRes.json();

    return res.status(200).json({
      ok: true,
      mode,
      scan: scanData,
      ob: obData
    });

  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
}