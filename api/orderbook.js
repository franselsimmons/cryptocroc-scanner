// /api/orderbook.js
import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, keyObResult, SETTINGS } from "./_core.js";

export const config = RUNTIME_CONFIG;

export default async function handler(req, res) {
  try {
    const u = new URL(req.url, "http://localhost");
    const symbol = u.searchParams.get("symbol");
    const side = (u.searchParams.get("side") || "bull").toLowerCase();

    if (!symbol) throw new Error("Missing symbol");
    if (side !== "bull" && side !== "bear") throw new Error("side must be bull/bear");

    const r = await kv.get(keyObResult(side, symbol.toUpperCase()));

    if (!r) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        ok: true,
        symbol,
        side,
        status: "validating",
        need: SETTINGS.entry.samplesNeed,
        windowSec: SETTINGS.entry.samplesWindowSec,
        tip: "Nog geen geldige OB (3 samples/90s). Wacht ±1 minuut."
      }));
      return;
    }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, symbol, side, ...r }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e) }));
  }
}