// /api/orderbook.js
import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, keyObResult, SETTINGS } from "./_core.js";

export const config = RUNTIME_CONFIG;

export default async function handler(req, res) {
  res.setHeader("content-type", "application/json");

  try {
    const u = new URL(req.url, "http://localhost");

    const symbolRaw = u.searchParams.get("symbol");
    const sideRaw = u.searchParams.get("side") || "bull";

    if (!symbolRaw) {
      res.status(400).json({
        ok: false,
        error: "Missing symbol"
      });
      return;
    }

    const symbol = symbolRaw.toUpperCase().trim();
    const side = sideRaw.toLowerCase().trim();

    if (side !== "bull" && side !== "bear") {
      res.status(400).json({
        ok: false,
        error: "side must be bull or bear"
      });
      return;
    }

    const key = keyObResult(side, symbol);
    const result = await kv.get(key);

    // Nog geen samples in KV
    if (!result) {
      res.status(200).json({
        ok: true,
        symbol,
        pair: symbol + "USDT",
        side,
        status: "validating",
        need: SETTINGS.entry.samplesNeed,
        windowSec: SETTINGS.entry.samplesWindowSec,
        tip:
          "Nog geen geldige OB in KV. Run eerst /api/ob-sampler of /api/cron zodat er samples worden verzameld (bv. 3 samples/90s)."
      });
      return;
    }

    // Resultaat gevonden in KV
    res.status(200).json({
      ok: true,
      symbol,
      pair: symbol + "USDT",
      side,
      ...result
    });

  } catch (e) {
    console.error("ORDERBOOK ERROR:", e);

    res.status(500).json({
      ok: false,
      error: String(e?.message || e)
    });
  }
}