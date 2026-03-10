import { kv } from "@vercel/kv";

// ======================================================
// Keys voor Moon‑funnel (gebaseerd op main, maar met moon prefix)
// ======================================================
export function keyMoonLatest(mode) {
  return `moon:latest:${String(mode).toLowerCase()}`;
}

export function keyMoonState(mode) {
  return `moon:state:${String(mode).toLowerCase()}`;
}

export function keyMoonPortfolio(mode) {
  return `moon:portfolio:${String(mode).toLowerCase()}`;
}

export function keyMoonPositions(mode) {
  return `moon:positions:${String(mode).toLowerCase()}`;
}

export function keyMoonObMap(mode) {
  return `moon:obmap:${String(mode).toLowerCase()}`;
}

// Keys voor orderbook samples en resultaten (kunnen gedeeld worden met main,
// maar we gebruiken moon‑specifieke om conflicten te voorkomen)
export function keyObSamples(mode, sym) {
  return `moon:ob:samples:${String(mode).toLowerCase()}:${String(sym).toUpperCase()}`;
}

export function keyObResult(mode, sym) {
  return `moon:ob:result:${String(mode).toLowerCase()}:${String(sym).toUpperCase()}`;
}

export function keyObResultMapTs(mode) {
  return `moon:ob:mapts:${String(mode).toLowerCase()}`;
}

// ======================================================
// Secret checker (identiek aan main)
// ======================================================
export function requireSecret(req, res) {
  const secret = process.env.CRON_SECRET || process.env.CC_SECRET || process.env.API_SECRET;
  if (!secret) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "Missing CRON_SECRET environment variable" }));
    return false;
  }

  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();

  // Vercel Cron stuurt automatisch Bearer <CRON_SECRET>
  if (token === secret) return true;

  // Fallback: query parameter secret (voor handmatig testen)
  if (req.query?.secret === secret) return true;

  res.statusCode = 401;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
  return false;
}

// ======================================================
// Lock voor moon scan (TTL‑based, 10 minuten)
// ======================================================
const MOON_SCAN_LOCK_PREFIX = "moon:scan:lock";

export async function tryAcquireMoonScanLock(mode, ttlSec = 600) {
  const key = `${MOON_SCAN_LOCK_PREFIX}:${String(mode).toLowerCase()}`;
  const now = Date.now();
  const until = now + ttlSec * 1000;

  const ok = await kv.set(key, { until, setAt: now }, { nx: true, ex: ttlSec });
  if (ok) return { ok: true, key, until, now };

  const cur = await kv.get(key);
  const curUntil = Number(cur?.until || 0);
  if (curUntil > now) {
    return { ok: false, key, until: curUntil, now, waitMs: curUntil - now };
  }

  // Lock is stale, overschrijven
  await kv.set(key, { until, setAt: now }, { ex: ttlSec });
  return { ok: true, key, until, now };
}

export async function releaseMoonScanLock(mode) {
  const key = `${MOON_SCAN_LOCK_PREFIX}:${String(mode).toLowerCase()}`;
  await kv.del(key);
}

// ======================================================
// Instability calculator (afkomstig uit _moon_run_all.js)
// ======================================================
export function computeInstability({
  direction,
  volumeRoc5m,
  obSlope,
  obStability,
  depthBidUsd,
  depthAskUsd,
}) {
  // Deze functie is een voorbeeld; pas aan indien nodig
  const dir = String(direction || "").toLowerCase();
  const vol = Math.abs(Number(volumeRoc5m) || 0);
  const slope = Math.abs(Number(obSlope) || 0);
  const stab = Math.abs(Number(obStability) || 0);
  const bid = Math.max(0, Number(depthBidUsd) || 0);
  const ask = Math.max(0, Number(depthAskUsd) || 0);
  const totalLiq = bid + ask;

  let score = 0;
  score += Math.min(1, vol / 200) * 0.3;          // volume verandering
  score += Math.min(1, slope * 100) * 0.3;        // ob slope
  score += Math.min(1, stab * 5) * 0.2;           // spread stabiliteit
  score += totalLiq < 50_000 ? 0.2 : totalLiq < 150_000 ? 0.1 : 0; // liquiditeit

  return Math.min(1, score);
}