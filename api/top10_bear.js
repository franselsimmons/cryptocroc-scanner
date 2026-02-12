import { json } from "./_util.js";
import { runScan } from "./_scanCore.js";

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    const reset = url.searchParams.get("reset") === "1";

    const regime = "HIGH_VOL"; // zelfde reden als bull; UI kan dit later tonen/verbeteren
    const out = await runScan("BEAR", regime, reset);
    json(res, 200, out);
  } catch (e) {
    json(res, 200, { ok: false, error: String(e?.message || e) });
  }
}
