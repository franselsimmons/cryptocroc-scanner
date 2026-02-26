// /api/orderbook.js
import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, requireSecret } from "../lib/_runtime.js";

export const config = RUNTIME_CONFIG;

// ===== helpers =====
function normalizeBaseSymbol(input) {
  const s = String(input || "").trim().toUpperCase();
  if (!s) return "";
  const cleaned = s.replaceAll("/", "").replaceAll("-", "");
  return cleaned.endsWith("USDT") ? cleaned.slice(0, -4) : cleaned;
}

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

// ✅ publiek lezen (KV-result) mag zonder secret
// ✅ RAW debug (live Bitget) blijft wél achter secret
function wantsSecret(req) {
  // raw=1 of debug=1 => secret vereist
  try {
    const u = new URL(req.url, "http://localhost");
    const rawFlag = u.searchParams.get("raw") ?? req.query?.raw ?? "0";
    const dbgFlag = u.searchParams.get("debug") ?? req.query?.debug ?? "0";
    return String(rawFlag) === "1" || String(dbgFlag) === "1";
  } catch {
    const rawFlag = req.query?.raw ?? "0";
    const dbgFlag = req.query?.debug ?? "0";
    return String(rawFlag) === "1" || String(dbgFlag) === "1";
  }
}

// (optioneel) raw debug: Bitget depth, want sampler gebruikt Bitget
async function fetchBitgetOrderbookRaw(baseSymbol, limit = 100) {
  const base = String(baseSymbol || "").toUpperCase();
  if (!base) return { ok: false, status: 400, msg: "Missing symbol" };

  const pair = `${base}USDT`;
  const safeLimit = Math.max(5, Math.min(150, Number(limit) || 100));
  const type = "step0";

  const url =
    `https://api.bitget.com/api/v2/spot/market/orderbook?` +
    `symbol=${encodeURIComponent(pair)}&type=${encodeURIComponent(type)}&limit=${encodeURIComponent(String(safeLimit))}`;

  const r = await fetch(url, { headers: { accept: "application/json" } });
  const text = await r.text();

  let j = null;
  try { j = JSON.parse(text); } catch {}

  if (!r.ok) {
    return {
      ok: false,
      status: r.status,
      msg: j?.msg || "Bitget orderbook failed",
      url,
      preview: text.slice(0, 400),
    };
  }

  if (String(j?.code || "") !== "00000") {
    return {
      ok: false,
      status: 400,
      msg: j?.msg || "Bitget returned non-success code",
      url,
      preview: text.slice(0, 400),
    };
  }

  const depth = j?.data;
  if (!depth?.bids?.length || !depth?.asks?.length) {
    return {
      ok: false,
      status: 200,
      msg: "Empty orderbook",
      url,
      preview: text.slice(0, 400),
    };
  }

  return { ok: true, url, depth };
}

export default async function handler(req, res) {
  try {
    // ✅ Alleen secret eisen bij RAW/live calls (anders krijgt je frontend 401)
    if (wantsSecret(req)) {
      if (!requireSecret(req, res)) return;
    }

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

    const core = await import(`../lib/_core_${side}.js`);
    const { keyObResult, SETTINGS } = core;

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
    // RAW mode → direct Bitget depth ophalen (debug)
    // (sampler gebruikt Bitget, dus dit klopt)
    // ====================================================
    if (String(rawFlag) === "1") {
      const live = await fetchBitgetOrderbookRaw(base, limitRaw);
      return res.end(JSON.stringify({ ok: true, symbol: base, pair, side, ...live }));
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
          need: n(SETTINGS?.entry?.samplesNeed, 0),
          windowSec: n(SETTINGS?.entry?.samplesWindowSec, 0),
          tip: "Nog geen OB result in KV. Laat /api/ob/sampler?mode=bull of bear draaien zodat samples worden opgebouwd.",
        })
      );
    }

    // UI verwacht velden: valid, stale, reason, ob{spreadPct,lor,depthMinUsd1p,ts}
    // r heeft dit al; we geven het door + wat extra top-level aliases voor gemak.
    const obTs = n(r?.ob?.ts ?? r?.ts, 0);

    return res.end(
      JSON.stringify({
        ok: true,
        symbol: base,
        pair,
        side,
        ...r,
        // handige aliases (maakt frontend checks simpel)
        valid: !!r.valid,
        stale: !!r.stale,
        reason: String(r.reason || ""),
        ts: n(r.ts, 0) || obTs,
      })
    );
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}