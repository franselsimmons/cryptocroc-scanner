// /api/orderbook.js
import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs" };

function normalizeBaseSymbol(input) {
  const s = String(input || "").trim().toUpperCase();
  if (!s) return "";
  // accepteer BTC, BTCUSDT, BTC/USDT, BTC-USDT
  const cleaned = s.replaceAll("/", "").replaceAll("-", "");
  return cleaned.endsWith("USDT") ? cleaned.slice(0, -4) : cleaned;
}

async function fetchBinanceDepthRaw(baseSymbol, limit = 100) {
  const base = String(baseSymbol || "").toUpperCase();
  if (!base) return { ok: false, error: "Missing base symbol" };

  const pair = `${base}USDT`;
  const safeLimit = Math.max(5, Math.min(1000, Number(limit) || 100));

  const url = `https://api.binance.com/api/v3/depth?symbol=${encodeURIComponent(
    pair
  )}&limit=${encodeURIComponent(String(safeLimit))}`;

  const r = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "user-agent": "CryptoCrocScanner/1.0 (+vercel)",
    },
  });

  const text = await r.text();

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}

  if (!r.ok) {
    return {
      ok: false,
      error: "Binance depth failed",
      status: r.status,
      url,
      preview: text.slice(0, 400),
    };
  }

  if (!json) {
    return {
      ok: false,
      error: "Binance returned non-JSON",
      status: r.status,
      url,
      preview: text.slice(0, 400),
    };
  }

  return { ok: true, url, binance: json };
}

export default async function handler(req, res) {
  try {
    const u = new URL(req.url, "http://localhost");

    const symbolRaw = u.searchParams.get("symbol") ?? req.query?.symbol;
    const sideRaw = u.searchParams.get("side") ?? req.query?.side ?? "bull";
    const rawFlag = u.searchParams.get("raw") ?? req.query?.raw ?? "0";
    const limitRaw = u.searchParams.get("limit") ?? req.query?.limit ?? "100";

    const side = String(sideRaw || "").toLowerCase();
    if (side !== "bull" && side !== "bear") {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "side must be bull/bear" }));
    }

    // ✅ dynamische import uit /lib (correct pad)
    const core = await import(`../lib/_core_${side}.js`);
    const { keyObResult, SETTINGS } = core;

    // ✅ requireSecret komt uit _runtime via core export
    const { requireSecret } = await import("../lib/_runtime.js");
    if (!requireSecret(req, res)) return;

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

    // ====================================================
    // RAW mode → direct Binance depth ophalen (debug)
    // ====================================================
    if (String(rawFlag) === "1") {
      const live = await fetchBinanceDepthRaw(base, limitRaw);
      return res.end(JSON.stringify({ symbol: base, pair, side, ...live }));
    }

    // ====================================================
    // NORMAL mode → KV lookup (sampler vult dit)
    // ====================================================
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
            "Nog geen geldige OB in KV. Run eerst /api/ob-sampler zodat samples worden verzameld.",
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