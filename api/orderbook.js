// /api/orderbook.js
import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, keyObResult, SETTINGS, requireSecret } from "./_core.js";

export const config = RUNTIME_CONFIG;

function normalizeBaseSymbol(input) {
  const s = String(input || "").trim().toUpperCase();
  if (!s) return "";
  // accepteer BTC, BTCUSDT, BTC/USDT, BTC-USDT
  const cleaned = s.replace("/", "").replace("-", "");
  return cleaned.endsWith("USDT") ? cleaned.slice(0, -4) : cleaned;
}

async function fetchBybitOrderbookSpot(pair, limit = 50) {
  // Bybit V5: GET /v5/market/orderbook?category=spot&symbol=BTCUSDT&limit=...
  const url = `https://api.bybit.com/v5/market/orderbook?category=spot&symbol=${encodeURIComponent(
    pair
  )}&limit=${encodeURIComponent(String(limit))}`;

  const r = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "user-agent": "CryptoCrocScanner/1.0 (+vercel)",
    },
  });

  const ct = (r.headers.get("content-type") || "").toLowerCase();
  const text = await r.text();

  // Bybit hoort JSON te geven. Als je HTML krijgt, wil je dat meteen zien.
  if (!ct.includes("application/json")) {
    return {
      ok: false,
      error: "Bybit returned non-JSON",
      status: r.status,
      url,
      preview: text.slice(0, 400),
      contentType: ct || "unknown",
    };
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: "Bybit JSON parse failed",
      status: r.status,
      url,
      preview: text.slice(0, 400),
    };
  }

  return { ok: true, url, bybit: json };
}

export default async function handler(req, res) {
  try {
    // ✅ security (zelfde als scan endpoints)
    if (!requireSecret(req, res)) return;

    const u = new URL(req.url, "http://localhost");

    const symbolRaw = u.searchParams.get("symbol") ?? req.query?.symbol;
    const sideRaw = u.searchParams.get("side") ?? req.query?.side ?? "bull";
    const rawFlag = u.searchParams.get("raw") ?? req.query?.raw ?? "0";
    const limitRaw = u.searchParams.get("limit") ?? req.query?.limit ?? "50";

    const side = String(sideRaw || "").toLowerCase();
    if (side !== "bull" && side !== "bear") {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "side must be bull/bear" }));
    }

    const base = normalizeBaseSymbol(symbolRaw);
    if (!base) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "Missing symbol" }));
    }

    const pair = `${base}USDT`;

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");

    // =========================
    // RAW mode: live Bybit debug
    // =========================
    if (String(rawFlag) === "1") {
      const limit = Math.max(1, Math.min(200, Number(limitRaw) || 50));
      const live = await fetchBybitOrderbookSpot(pair, limit);
      return res.end(JSON.stringify({ symbol: base, pair, side, ...live }));
    }

    // =========================
    // NORMAL mode: KV lookup
    // =========================
    const r = await kv.get(keyObResult(side, base));

    if (!r) {
      return res.end(
        JSON.stringify({
          ok: true,
          symbol: base,
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

    return res.end(JSON.stringify({ ok: true, symbol: base, pair, side, ...r }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}