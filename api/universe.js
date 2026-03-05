import { kv } from "@vercel/kv";
import { createHash } from "crypto";
import { RUNTIME_CONFIG, requireSecret } from "../lib/_runtime.js";

export const config = RUNTIME_CONFIG;

// ======================================================
// Universe scan settings
// ======================================================
const UNIVERSE_PAGES = 6;         // 6 * 250 = 1500 coins
const PER_PAGE = 250;
const UNIVERSE_TTL_SEC = 60 * 45; // 45 min cache (past bij 30m cadence)

// 30 min lock (shared for both bull/bear)
const SCAN_INTERVAL_SEC = 30 * 60;

// KV keys (100% vast)
export const K_UNIVERSE_LATEST = "universe:latest";
export const K_LOCK_UNIVERSE = "scan:lock:universe";

// --------------------
// Helpers
// --------------------
function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  return res.end(JSON.stringify(obj));
}

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}
function up(x) {
  return String(x || "").toUpperCase();
}

// --------------------
// Lock (atomisch) – NU BOUNDARY‑BASED
// --------------------
async function tryAcquireUniverseLock() {
  const now = Date.now();

  // ✅ lock loopt altijd tot de volgende :00 of :30
  const d = new Date(now);
  const m = d.getMinutes();

  const next = new Date(d);
  next.setSeconds(0, 0);

  if (m < 30) {
    next.setMinutes(30);
  } else {
    next.setMinutes(0);
    next.setHours(d.getHours() + 1);
  }

  const nextUntil = next.getTime();
  const ttlSec = Math.max(60, Math.ceil((nextUntil - now) / 1000));

  const ok = await kv.set(
    K_LOCK_UNIVERSE,
    { until: nextUntil, setAt: now },
    { nx: true, ex: ttlSec }
  );

  if (ok) return { ok: true, until: nextUntil, now, waitMs: 0 };

  const cur = await kv.get(K_LOCK_UNIVERSE);
  const until = Number(cur?.until || 0);

  if (until > now) return { ok: false, until, now, waitMs: until - now };

  // stale → refresh
  await kv.set(K_LOCK_UNIVERSE, { until: nextUntil, setAt: now }, { ex: ttlSec });
  return { ok: true, until: nextUntil, now, waitMs: 0 };
}

// --------------------
// CoinGecko cache (per URL)
// --------------------
function cgKey(url) {
  const h = createHash("sha1").update(String(url || "")).digest("hex");
  return `cg:${h}`;
}

const CG_FRESH_TTL_SEC = 60;
const CG_STALE_TTL_SEC = 10 * 60;

async function fetchJson(url) {
  const key = cgKey(url);
  const staleKey = `${key}:stale`;

  const cached = await kv.get(key);
  if (cached) return cached;

  const headers = { accept: "application/json" };

  // Demo key support (Vercel env: CG_DEMO_API_KEY or CG_API_KEY)
  const demoKey = process.env.CG_DEMO_API_KEY || process.env.CG_API_KEY || "";
  if (demoKey) headers["x-cg-demo-api-key"] = demoKey;

  const r = await fetch(url, { headers });
  const t = await r.text();

  if (r.status === 429) {
    const stale = await kv.get(staleKey);
    if (stale) return stale;
    throw new Error(`CoinGecko 429 and no stale cache: ${t.slice(0, 200)}`);
  }

  let j = null;
  try {
    j = JSON.parse(t);
  } catch {}

  if (!r.ok) throw new Error(`CoinGecko ${r.status}: ${t.slice(0, 160)}`);

  await kv.set(key, j, { ex: CG_FRESH_TTL_SEC });
  await kv.set(staleKey, j, { ex: CG_STALE_TTL_SEC });
  return j;
}

// --------------------
// Fetch universe (6 pages)
// --------------------
async function fetchUniverseCoins(pages = UNIVERSE_PAGES) {
  const maxPages = Math.max(1, Math.min(10, Number(pages) || UNIVERSE_PAGES));
  let all = [];

  for (let page = 1; page <= maxPages; page++) {
    const url =
      `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd` +
      `&order=volume_desc&per_page=${PER_PAGE}&page=${page}` +
      `&sparkline=false&price_change_percentage=1h,24h`;

    const arr = await fetchJson(url);
    if (!Array.isArray(arr) || arr.length === 0) break;

    const mapped = arr.map((c) => {
      const high = n(c?.high_24h, 0);
      const low = n(c?.low_24h, 0);
      const range24 = low > 0 ? ((high - low) / low) * 100 : 0;

      const change24 = n(
        c?.price_change_percentage_24h_in_currency ?? c?.price_change_percentage_24h ?? 0,
        0
      );
      const change1h = n(
        c?.price_change_percentage_1h_in_currency ?? c?.price_change_percentage_1h ?? 0,
        0
      );

      return {
        id: c?.id,
        symbol: up(c?.symbol),
        name: c?.name,
        price: n(c?.current_price, 0),
        volume: n(c?.total_volume, 0),
        marketCap: n(c?.market_cap, 0),
        change24,
        change1h,
        range24,
      };
    });

    all = all.concat(mapped);

    if (mapped.length < PER_PAGE) break;
    if (page < maxPages) await new Promise((r) => setTimeout(r, 220));
  }

  return all;
}

// --------------------
// Fetch BTC (apart maar via dezelfde cache)
// --------------------
async function fetchBtc() {
  const url =
    "https://api.coingecko.com/api/v3/coins/markets" +
    "?vs_currency=usd&ids=bitcoin&order=market_cap_desc&per_page=1&page=1" +
    "&sparkline=false&price_change_percentage=1h,24h";

  const arr = await fetchJson(url);
  const b = arr?.[0] || {};

  const chg1h = n(b?.price_change_percentage_1h_in_currency ?? b?.price_change_percentage_1h ?? 0, 0);
  const chg24 = n(b?.price_change_percentage_24h_in_currency ?? b?.price_change_percentage_24h ?? 0, 0);

  const high = n(b?.high_24h, 0);
  const low = n(b?.low_24h, 0);
  const range24 = low > 0 ? ((high - low) / low) * 100 : 0;

  return {
    chg1h: +chg1h.toFixed(3),
    chg24: +chg24.toFixed(3),
    range24: +range24.toFixed(3),
  };
}

// ======================================================
// MAIN
// ======================================================
export default async function handler(req, res) {
  const startedAt = Date.now();

  try {
    if (!requireSecret(req, res)) return;

    const lock = await tryAcquireUniverseLock();
    if (!lock.ok) {
      const latest = await kv.get(K_UNIVERSE_LATEST);
      return send(res, 200, {
        ok: true,
        skipped: true,
        reason: "universe lock active",
        ts: Date.now(),
        lock: { key: K_LOCK_UNIVERSE, active: true, until: lock.until, waitMs: lock.waitMs },
        universe: latest
          ? { ts: latest.ts, pages: latest.pages, perPage: latest.perPage, count: latest.count }
          : null,
      });
    }

    // Haal zowel coins als BTC parallel op
    const [coins, btc] = await Promise.all([
      fetchUniverseCoins(UNIVERSE_PAGES),
      fetchBtc(),
    ]);

    const out = {
      ok: true,
      ts: Date.now(),
      pages: UNIVERSE_PAGES,
      perPage: PER_PAGE,
      count: coins.length,
      btc,                    // ✅ toegevoegd voor scan.js
      coins,
      meta: {
        key: K_UNIVERSE_LATEST,
        lock: { key: K_LOCK_UNIVERSE, active: false, until: lock.until, waitMs: 0 },
      },
    };

    await kv.set(K_UNIVERSE_LATEST, out, { ex: UNIVERSE_TTL_SEC });

    return send(res, 200, { ...out, tookMs: Date.now() - startedAt });
  } catch (e) {
    return send(res, 200, { ok: false, error: String(e?.message || e) });
  }
}