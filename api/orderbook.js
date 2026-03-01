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

export default async function handler(req, res) {
  try {
    const u = new URL(req.url, "http://localhost");

    const symbolRaw = u.searchParams.get("symbol") ?? req.query?.symbol;
    const sideRaw = u.searchParams.get("side") ?? req.query?.side ?? "bull";
    const rawFlag = u.searchParams.get("raw") ?? req.query?.raw ?? "0";

    const side = String(sideRaw || "").toLowerCase();
    if (side !== "bull" && side !== "bear") {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      return res.end(JSON.stringify({ ok: false, error: "side must be bull/bear" }));
    }

    const base = normalizeBaseSymbol(symbolRaw);
    if (!base) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      return res.end(JSON.stringify({ ok: false, error: "Missing symbol" }));
    }

    // RAW debug: alleen met secret
    if (String(rawFlag) === "1") {
      if (!requireSecret(req, res)) return;
      // raw is optioneel; jij gebruikt vooral snapshots
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      return res.end(JSON.stringify({ ok: true, note: "raw=1 is disabled in this build", symbol: base, side }));
    }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");

    // ✅ Lees uit dezelfde storage als scan.js (obStore)
    const maxAgeSec = 120 * 60; // 120 min (zelfde idee als scan)
    const ob = await getObSnapshot(side, base, maxAgeSec);

    // Maak antwoord “plat” (handig voor je UI)
    const snap = ob?.snap || null;

    return res.end(
      JSON.stringify({
        ok: true,
        side,
        symbol: base,
        pair: `${base}USDT`,

        valid: !!ob?.valid,
        fresh: !!ob?.fresh,
        stale: !!ob?.stale,
        reason: String(ob?.reason || ""),
        ageSec: ob?.ageSec ?? null,

        ts: n(snap?.ts, 0) || null,
        spreadPct: Number.isFinite(Number(snap?.spreadPct)) ? Number(snap.spreadPct) : null,
        depthMinUsd1p: Number.isFinite(Number(snap?.depthMinUsd1p)) ? Number(snap.depthMinUsd1p) : null,
        pressureDeltaUsd: Number.isFinite(Number(snap?.pressureDeltaUsd)) ? Number(snap.pressureDeltaUsd) : 0,
        score: Number.isFinite(Number(snap?.score)) ? Number(snap.score) : null,
      })
    );
  } catch (e) {
    res.statusCode = 200; // ✅ geen 500 meer naar je UI
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}