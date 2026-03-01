// /api/orderbook.js
import { RUNTIME_CONFIG, requireSecret } from "../lib/_runtime.js";
import { getObSnapshot } from "../lib/obStore.js";

export const config = RUNTIME_CONFIG;

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
  try {
    j = JSON.parse(text);
  } catch {}

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
    const u = new URL(req.url, "http://localhost");

    const symbolRaw = u.searchParams.get("symbol") ?? req.query?.symbol;
    const modeRaw = u.searchParams.get("mode") ?? req.query?.mode ?? "bull";
    const rawFlag = u.searchParams.get("raw") ?? req.query?.raw ?? "0";
    const limitRaw = u.searchParams.get("limit") ?? req.query?.limit ?? "100";
    const maxAgeSecRaw = u.searchParams.get("maxAgeSec") ?? req.query?.maxAgeSec ?? "";

    const mode = String(modeRaw || "").toLowerCase();
    if (mode !== "bull" && mode !== "bear") {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      return res.end(JSON.stringify({ ok: false, error: "mode must be bull/bear" }));
    }

    const base = normalizeBaseSymbol(symbolRaw);
    if (!base) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      return res.end(JSON.stringify({ ok: false, error: "Missing symbol" }));
    }

    const pair = `${base}USDT`;

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");

    // ====================================================
    // RAW mode → live Bitget depth (DEBUG) → secret protected
    // ====================================================
    if (String(rawFlag) === "1") {
      if (!requireSecret(req, res)) return;
      const live = await fetchBitgetOrderbookRaw(base, limitRaw);
      return res.end(JSON.stringify({ ok: true, symbol: base, pair, mode, ...live }));
    }

    // ====================================================
    // NORMAL mode → obStore snapshot (PUBLIC read)
    // ====================================================
    const maxAgeSec =
      String(maxAgeSecRaw).trim() !== "" ? Math.max(60, n(maxAgeSecRaw, 0)) : 3 * 3600;

    const snapRes = await getObSnapshot(mode, base, maxAgeSec);

    // snapRes = { ok, valid, fresh, stale, reason, ageSec, snap }
    const snap = snapRes.snap;

    return res.end(
      JSON.stringify({
        ok: true,
        symbol: base,
        pair,
        mode,
        valid: !!snapRes.valid,
        fresh: !!snapRes.fresh,
        stale: !!snapRes.stale,
        reason: String(snapRes.reason || ""),
        ageSec: snapRes.ageSec ?? null,
        ts: snap ? n(snap.ts, 0) : null,
        snap: snap
          ? {
              ts: n(snap.ts, 0),
              symbol: String(snap.symbol || base).toUpperCase(),
              mode: String(snap.mode || mode),
              spreadPct: n(snap.spreadPct, null),
              depthMinUsd1p: n(snap.depthMinUsd1p, null),
              pressureDeltaUsd: n(snap.pressureDeltaUsd, 0),
              score: n(snap.score, null),
            }
          : null,
        tip:
          snapRes.valid
            ? "OK"
            : "Nog geen verse snapshot. Laat je OB sampler draaien zodat obStore gevuld wordt.",
      })
    );
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}