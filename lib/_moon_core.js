// /lib/_moon_core.js

export const RUNTIME_CONFIG = { runtime: "nodejs" };

export function requireSecret(req, res) {
  const authHeader = String(req.headers?.authorization || "");
  const bearer = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : "";

  const token =
    String(req.query?.token || "").trim() ||
    bearer ||
    String(req.headers?.["x-cron-secret"] || "").trim() ||
    String(req.headers?.["x-token"] || "").trim();

  const secret = String(process.env.CRON_SECRET || "").trim();

  if (!secret) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "Missing CRON_SECRET env var" }));
    return false;
  }

  if (!token || token !== secret) {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      ok: false,
      error: "Unauthorized",
      hint: "Use ?token=CRON_SECRET or Authorization: Bearer CRON_SECRET",
    }));
    return false;
  }

  return true;
}

const NS = "cc:moon";

export const keyMoonLatest = (mode) => `${NS}:latest:${String(mode).toLowerCase() === "bear" ? "bear" : "bull"}`;
export const keyMoonState = (mode) => `${NS}:state:${String(mode).toLowerCase() === "bear" ? "bear" : "bull"}`;
export const keyMoonReset = (mode) => `${NS}:reset:${String(mode).toLowerCase() === "bear" ? "bear" : "bull"}`;
export const keyMoonPortfolio = (mode) => `${NS}:portfolio:${String(mode).toLowerCase() === "bear" ? "bear" : "bull"}`;
export const keyMoonPositions = (mode) => `${NS}:positions:${String(mode).toLowerCase() === "bear" ? "bear" : "bull"}`;
export const keyMoonObSamples = (mode, symbol) =>
  `${NS}:ob:samples:${String(mode).toLowerCase() === "bear" ? "bear" : "bull"}:${String(symbol).toUpperCase()}`;
export const keyMoonObResult = (mode, symbol) =>
  `${NS}:ob:result:${String(mode).toLowerCase() === "bear" ? "bear" : "bull"}:${String(symbol).toUpperCase()}`;
export const keyMoonDiagList = (mode) => `${NS}:diag:list:${String(mode).toLowerCase() === "bear" ? "bear" : "bull"}`;
export const keyMoonDiagSnap = (mode) => `${NS}:diag:snap:${String(mode).toLowerCase() === "bear" ? "bear" : "bull"}`;
export const keyMoonScanLock = (mode) => `${NS}:scan_lock:${String(mode).toLowerCase() === "bear" ? "bear" : "bull"}`;
export const keyMoonCooldown = (mode, symbol) =>
  `${NS}:cooldown:${String(mode).toLowerCase() === "bear" ? "bear" : "bull"}:${String(symbol).toUpperCase()}`;