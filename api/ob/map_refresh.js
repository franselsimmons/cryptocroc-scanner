// /api/ob/map_refresh.js
import { kv } from "@vercel/kv";
import { requireSecret } from "../../lib/_runtime.js";
import { obMapKey } from "../../lib/obStore.js";

export const config = { runtime: "nodejs" };

const MAP_TTL_SEC = 60 * 60 * 6; // 6 uur

async function fetchJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch {}
  if (!r.ok) throw new Error(`Fetch failed ${r.status}: ${t.slice(0, 200)}`);
  return j;
}

function extractUsdtBasesFromBitget(payload) {
  const data = Array.isArray(payload?.data) ? payload.data : [];
  const bases = new Set();

  for (const row of data) {
    const sym =
      row?.symbol ||
      row?.symbolName ||
      row?.symbolId ||
      row?.symbolCode ||
      row?.name;

    const s = String(sym || "").toUpperCase().trim();
    if (!s) continue;

    if (s.endsWith("USDT") && s.length > 4) {
      const base = s.slice(0, -4);
      if (base) bases.add(base);
    }
  }
  return Array.from(bases);
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const mode = String(req.query?.mode || "bull").toLowerCase();
    if (mode !== "bull" && mode !== "bear") {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "mode must be bull/bear" }));
    }

    const url = "https://api.bitget.com/api/v2/spot/public/symbols";
    const j = await fetchJson(url);

    const code = String(j?.code || "");
    if (code && code !== "00000") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({
        ok: false,
        error: "Bitget returned non-success code",
        code,
        msg: j?.msg,
      }));
    }

    const bases = extractUsdtBasesFromBitget(j);
    const map = {};
    for (const b of bases) map[b] = true;

    const blob = { ts: Date.now(), size: bases.length, map };

    await kv.set(obMapKey(mode), blob, { ex: MAP_TTL_SEC });
    await kv.set(`ob:mapts:${mode}`, blob.ts, { ex: MAP_TTL_SEC });

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    return res.end(JSON.stringify({ ok: true, mode, ts: blob.ts, size: blob.size, ttlSec: MAP_TTL_SEC }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}