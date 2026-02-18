// /api/orderbook.js
import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, keyObResult, SETTINGS, requireSecret } from "./_core.js";

export const config = RUNTIME_CONFIG;

function normPair(input) {
  const s = String(input || "").trim().toUpperCase();
  if (!s) return null;
  // Als iemand al BTCUSDT geeft: laat zo
  if (s.endsWith("USDT")) return s;
  // Anders: BTC -> BTCUSDT
  return `${s}USDT`;
}

export default async function handler(req, res) {
  try {
    // ✅ security (zelfde als scan endpoints)
    if (!requireSecret(req, res)) return;

    const u = new URL(req.url, "http://localhost");
    const symbolRaw = u.searchParams.get("symbol") || req.query?.symbol;
    const sideRaw = u.searchParams.get("side") || req.query?.side || "bull";
    const raw = (u.searchParams.get("raw") || req.query?.raw) === "1";

    const side = String(sideRaw || "").toLowerCase();
    if (side !== "bull" && side !== "bear") throw new Error("side must be bull/bear");

    if (!symbolRaw) throw new Error("Missing symbol");

    // ✅ Pair fix
    const pair = normPair(symbolRaw);
    if (!pair) throw new Error("Invalid symbol");

    // Base symbool voor KV keys: BTCUSDT -> BTC
    const symbol = pair.replace(/USDT$/, "");

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");

    // ✅ RAW mode: live orderbook ophalen (voor testen)
    // Let op: jouw screenshot liet Bybit v5 JSON zien, dus we pakken Bybit spot orderbook.
    if (raw) {
      const url = `https://api.bybit.com/v5/market/orderbook?category=spot&symbol=${encodeURIComponent(pair)}&limit=50`;
      const r = await fetch(url, { headers: { accept: "application/json" } });
      const text = await r.text();

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        // Soms geeft een provider HTML (bv. blokkade / WAF). Dan zie je meteen wat er terugkomt.
        res.statusCode = 502;
        return res.end(
          JSON.stringify({
            ok: false,
            error: "Bybit returned non-JSON",
            preview: text.slice(0, 200),
          })
        );
      }

      return res.end(
        JSON.stringify({
          ok: true,
          symbol,
          pair,
          side,
          raw: true,
          bybit: data,
        })
      );
    }

    // ✅ KV mode: resultaat lezen van sampler
    const ob = await kv.get(keyObResult(side, symbol));

    if (!ob) {
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

    return res.end(JSON.stringify({ ok: true, symbol, pair, side, ...ob }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}