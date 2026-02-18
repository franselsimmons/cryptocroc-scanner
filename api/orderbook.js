// /api/orderbook.js
import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, keyObResult, SETTINGS } from "./_core.js";

export const config = RUNTIME_CONFIG;

// Normaliseert input:
// - "bb" -> "BB"
// - "BBUSDT" -> "BB"
// - "btc" -> "BTC"
function normalizeBaseSymbol(raw) {
  const s = String(raw || "").trim().toUpperCase();
  if (!s) return "";
  if (s.endsWith("USDT")) return s.slice(0, -4);
  return s;
}

export default async function handler(req, res) {
  try {
    const u = new URL(req.url, "http://localhost");
    const symbolRaw = u.searchParams.get("symbol");
    const side = (u.searchParams.get("side") || "bull").toLowerCase();

    if (!symbolRaw) throw new Error("Missing symbol");
    if (side !== "bull" && side !== "bear") throw new Error("side must be bull/bear");

    const base = normalizeBaseSymbol(symbolRaw);
    if (!base) throw new Error("Invalid symbol");

    const pair = `${base}USDT`;

    // Dit endpoint toont de LAATSTE berekende OB uit KV (sampler/cron vult dit).
    // Hier doen we geen Bybit-fetch; dat hoort in de sampler.
    const r = await kv.get(keyObResult(side, base));

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");

    if (!r) {
      return res.end(
        JSON.stringify({
          ok: true,
          symbol: base,         // base symbol (KV key)
          pair,                // wat Bybit verwacht
          side,
          status: "validating",
          need: SETTINGS.entry.samplesNeed,
          windowSec: SETTINGS.entry.samplesWindowSec,
          tip:
            "Nog geen geldige OB in KV. Dit endpoint leest alleen KV. " +
            "Run eerst /api/ob-sampler of /api/cron zodat er samples worden verzameld (bv. 3 samples/90s).",
        })
      );
    }

    // r komt uit KV en kan {valid, stale, ob:{...}, agree, reason, ...} bevatten
    return res.end(
      JSON.stringify({
        ok: true,
        symbol: base,
        pair,
        side,
        ...r,
      })
    );
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}