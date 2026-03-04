// /api/ob.js
import { requireSecret } from "../lib/_runtime.js";
import { getObSnapshot, obKey, obMapKey } from "../lib/obStore.js";

export const config = { runtime: "nodejs" };

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const mode = String(req.query?.mode || "bull").toLowerCase();
    if (mode !== "bull" && mode !== "bear") {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      return res.end(JSON.stringify({ ok: false, error: "mode must be bull/bear" }));
    }

    const symbol = String(req.query?.symbol || "").toUpperCase().trim();
    if (!symbol) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      return res.end(JSON.stringify({ ok: false, error: "Missing ?symbol=PEPE" }));
    }

    const maxAgeSec = Math.max(60, n(req.query?.maxAgeSec, 3 * 3600));
    const r = await getObSnapshot(mode, symbol, maxAgeSec);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");

    return res.end(JSON.stringify({
      ok: true,
      mode,
      symbol,
      keys: { obKey: obKey(mode, symbol), obMapKey: obMapKey(mode) },
      maxAgeSec,
      result: r,
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}