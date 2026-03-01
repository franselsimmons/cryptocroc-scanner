// api/ob.js
import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  try {
    const mode = String(req.query?.mode || "bull").toLowerCase();
    if (mode !== "bull" && mode !== "bear") {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      return res.end(JSON.stringify({ ok: false, error: "mode must be bull/bear" }));
    }

    const symbol = String(req.query?.symbol || "").toUpperCase().trim();
    if (!symbol) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      return res.end(JSON.stringify({ ok: false, error: "Missing ?symbol=PEPE" }));
    }

    const rt = await import("../lib/_runtime.js");
    if (!rt.requireSecret(req, res)) return;

    // Gebruik exact dezelfde key-logica als de core
    const core = await import(`../lib/_core_${mode}.js`);
    const { keyObResult } = core;

    const key = keyObResult(mode, symbol);
    const data = await kv.get(key);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");

    if (!data) {
      return res.end(JSON.stringify({
        ok: false,
        mode,
        symbol,
        key,
        error: "No OB result yet. Run sampler first.",
      }));
    }

    return res.end(JSON.stringify({
      ok: true,
      mode,
      symbol,
      key,
      data,
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}