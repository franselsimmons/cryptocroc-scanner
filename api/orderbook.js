// /api/orderbook.js
import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, keyObResult, SETTINGS, requireSecret } from "./_core.js";

export const config = RUNTIME_CONFIG;

function normalizeBaseSymbol(input) {
  const s = String(input || "").trim().toUpperCase();
  if (!s) return "";
  const cleaned = s.replace("/", "").replace("-", "");
  return cleaned.endsWith("USDT") ? cleaned.slice(0, -4) : cleaned;
}

async function fetchBitgetDepthRaw(baseSymbol, limit = 50) {
  const base = String(baseSymbol || "").toUpperCase();
  if (!base) return { ok: false, error: "Missing base symbol" };

  const sym = `${base}USDT_SPBL`;
  const url = `https://api.bitget.com/api/spot/v1/market/depth?symbol=${encodeURIComponent(sym)}&limit=${encodeURIComponent(
    String(limit)
  )}`;

  const r = await fetch(url, { headers: { accept: "application/json" } });
  const text = await r.text();

  let json = null;
  try { json = JSON.parse(text); } catch {}

  if (!r.ok) {
    return {
      ok: false,
      error: "Bitget depth failed",
      status: r.status,
      url,
      preview: text.slice(0, 400),
    };
  }

  if (!json) {
    return {
      ok: false,
      error: "Bitget returned non-JSON",
      status: r.status,
      url,
      preview: text.slice(0, 400),
    };
  }

  return { ok: true, url, bitget: json };
}

export default async function handler(req, res) {
  try {
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
    // RAW mode: live Bitget depth debug
    // =========================
    if (String(rawFlag) === "1") {
      const limit = Math.max(1, Math.min(200, Number(limitRaw) || 50));
      const live = await fetchBitgetDepthRaw(base, limit);
      return res.end(JSON.stringify({ ok: true, symbol: base, pair, side, ...live }));
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
            "Nog geen geldige OB in KV. Run eerst /api/ob-sampler (liefst nadat /api/scan coins heeft) zodat er samples worden verzameld (bv. 3 samples/90s).",
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