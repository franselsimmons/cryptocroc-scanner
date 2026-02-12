import { kv } from "@vercel/kv";

export const fetchFn = globalThis.fetch;

export function json(res, code, body) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

export function percentile(sorted, p) {
  // sorted: oplopend, p: 0..1
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

export function nowTs() {
  return Date.now();
}

export async function kvGetJson(key, fallback) {
  const v = await kv.get(key);
  if (!v) return fallback;
  try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return fallback; }
}

export async function kvSetJson(key, obj, ttlSec = null) {
  const s = JSON.stringify(obj);
  if (ttlSec) return kv.set(key, s, { ex: ttlSec });
  return kv.set(key, s);
}

export function cleanSymbol(sym) {
  return (sym || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function asNum(x, d = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
}
