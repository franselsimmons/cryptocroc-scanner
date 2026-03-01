// api/obmap.js
import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs" };

function safeObj(x) {
  return x && typeof x === "object" ? x : null;
}

export default async function handler(req, res) {
  try {
    const mode = String(req.query?.mode || "bull").toLowerCase();
    if (mode !== "bull" && mode !== "bear") {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      return res.end(JSON.stringify({ ok: false, error: "mode must be bull/bear" }));
    }

    // secret check (zelfde als de rest)
    const rt = await import("../lib/_runtime.js");
    if (!rt.requireSecret(req, res)) return;

    const key = `ob:map:${mode}`;
    const blob = await kv.get(key);

    const obj = safeObj(blob);
    const map = obj && safeObj(obj.map) ? obj.map : null;

    // Optioneel: ?symbol=PEPE → alleen die entry
    const symbol = String(req.query?.symbol || "").toUpperCase().trim();

    // Optioneel: ?flat=1 → alleen map object terug (makkelijk voor UI)
    const flat = String(req.query?.flat || "") === "1";

    const out = {
      ok: true,
      mode,
      key,
      ts: obj?.ts || null,
      size: obj?.size ?? (map ? Object.keys(map).length : 0),
      wrapper: obj ? Object.keys(obj) : null,
      sample: map ? Object.keys(map).slice(0, 20) : [],
    };

    if (!map) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      return res.end(JSON.stringify({ ...out, ok: false, error: "No ob map in KV yet. Run /api/ob/map_refresh first." }));
    }

    if (symbol) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      return res.end(JSON.stringify({
        ...out,
        symbol,
        exists: !!map[symbol],
        entry: map[symbol] || null,
      }));
    }

    if (flat) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      return res.end(JSON.stringify({ ok: true, mode, key, ts: obj?.ts || null, size: out.size, map }));
    }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    return res.end(JSON.stringify({ ...out, hasMap: true }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}