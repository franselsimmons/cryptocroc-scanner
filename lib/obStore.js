// lib/obStore.js
import { kv } from "@vercel/kv";

export function obKey(mode, symbol) {
  return `cc:ob:last:${mode}:${symbol}`;
}

export function obMapKey(mode) {
  return `cc:ob:map:${mode}`;
}

/**
 * Snapshot schema (altijd hetzelfde):
 * {
 *   ts: number (ms),
 *   symbol: string,
 *   mode: "bull"|"bear",
 *   spreadPct: number,
 *   depthMinUsd1p: number,
 *   pressureDeltaUsd: number,
 *   score: number
 * }
 */

export async function putObSnapshot(mode, symbol, snap, ttlSec = 6 * 3600) {
  const clean = {
    ts: Number(snap?.ts ?? Date.now()),
    symbol: String(symbol).toUpperCase(),
    mode,
    spreadPct: Number(snap?.spreadPct ?? NaN),
    depthMinUsd1p: Number(snap?.depthMinUsd1p ?? NaN),
    pressureDeltaUsd: Number(snap?.pressureDeltaUsd ?? 0),
    score: Number(snap?.score ?? NaN),
  };

  // Sla alleen op als het echt bruikbare cijfers zijn
  const ok =
    Number.isFinite(clean.spreadPct) &&
    Number.isFinite(clean.depthMinUsd1p) &&
    Number.isFinite(clean.score) &&
    clean.spreadPct >= 0 &&
    clean.depthMinUsd1p >= 0;

  if (!ok) return { ok: false, why: "invalid_numbers", clean };

  await kv.set(obKey(mode, clean.symbol), clean, { ex: ttlSec });

  // Optioneel: map met “laatste ts per symbol” (handig voor debug)
  await kv.hset(obMapKey(mode), { [clean.symbol]: String(clean.ts) });
  await kv.expire(obMapKey(mode), ttlSec);

  return { ok: true, clean };
}

export async function getObSnapshot(mode, symbol, maxAgeSec = 3 * 3600) {
  const sym = String(symbol).toUpperCase();
  const v = await kv.get(obKey(mode, sym));

  if (!v || !v.ts) {
    return { ok: true, valid: false, fresh: false, stale: true, reason: "missing_snapshot", ageSec: null, snap: null };
  }

  const ageSec = Math.floor((Date.now() - Number(v.ts)) / 1000);

  const numbersOk =
    Number.isFinite(Number(v.spreadPct)) &&
    Number.isFinite(Number(v.depthMinUsd1p)) &&
    Number.isFinite(Number(v.score));

  if (!numbersOk) {
    return { ok: true, valid: false, fresh: false, stale: true, reason: "bad_numbers_in_snapshot", ageSec, snap: v };
  }

  if (ageSec > maxAgeSec) {
    return { ok: true, valid: false, fresh: false, stale: true, reason: `stale_age_${ageSec}s`, ageSec, snap: v };
  }

  return { ok: true, valid: true, fresh: true, stale: false, reason: "OK", ageSec, snap: v };
}