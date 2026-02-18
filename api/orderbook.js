// /api/orderbook.js
import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, keyObResult, SETTINGS, requireSecret } from "./_core.js";

export const config = RUNTIME_CONFIG;

export default async function handler(req, res) {
  try {
    // ✅ security (zelfde als scan endpoints)
    if (!requireSecret(req, res)) return;

    // Vercel geeft meestal req.query; maar URL parse is ook prima
    const u = new URL(req.url, "http://localhost");
    const symbolRaw = u.searchParams.get("symbol") || req.query?.symbol;
    const sideRaw = u.searchParams.get("side") || req.query?.side || "bull";

    const symbol = String(symbolRaw || "").trim().toUpperCase();
    const side = String(sideRaw || "").toLowerCase();

    if (!symbol) throw new Error("Missing symbol");
    if (side !== "bull" && side !== "bear") throw new Error("side must be bull/bear");

    // Voor UI / debug: welke pair verwachten we op Bitget?
    const pair = `${symbol}USDT`;

    const r = await kv.get(keyObResult(side, symbol));

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");

    // ✅ Als er nog niks in KV staat: duidelijke uitleg wat je eerst moet runnen
    if (!r) {
      return res.end(
        JSON.stringify({
          ok: true,
          symbol,
          pair,
          side,
          status: "validating",
          need: SETTINGS.entry.samplesNeed,
          windowSec: SETTINGS.entry.samplesWindowSec,
          tip:
            "Nog geen geldige OB in KV. Run eerst /api/ob-sampler of /api/cron zodat er samples worden verzameld (bv. 3 samples/90s).",
        })
      );
    }

    // ✅ Bestaat wel: geef alles terug (incl valid/stale/ob/agree/reason etc.)
    return res.end(JSON.stringify({ ok: true, symbol, pair, side, ...r }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}