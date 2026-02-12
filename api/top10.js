import { json } from "./_util.js";
import { runScan } from "./_scanCore.js";

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    const reset = url.searchParams.get("reset") === "1";

    // BTC regime
    const btc = await fetch("http://localhost/api/btc").catch(() => null);
    // In Vercel werkt bovenstaande localhost niet.
    // Dus: regime simpel in scanCore: HIGH_VOL default via ratio? -> we doen hier safe fallback:
    // We laten scanCore beslissen op regime input; hier zetten we op "HIGH_VOL" als default.
    const regime = "HIGH_VOL";

    const out = await runScan("BULL", regime, reset);
    json(res, 200, out);
  } catch (e) {
    json(res, 200, { ok: false, error: String(e?.message || e) });
  }
}
