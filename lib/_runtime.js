export const RUNTIME_CONFIG = { runtime: "nodejs" };

export function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(obj));
}

export function getMode(req, fallback = "bull") {
  const m = String(req.query?.mode || fallback).toLowerCase();
  return m === "bear" ? "bear" : "bull";
}

export function requireSecret(req, res) {
  const secret = String(process.env.CRON_SECRET || "").trim();

  // Als je geen secret hebt gezet, laat dan alles door (handig bij lokaal testen)
  if (!secret) return true;

  // 1) Authorization: Bearer <secret>
  const h = String(req.headers?.authorization || "");
  if (h.startsWith("Bearer ") && h.slice(7).trim() === secret) return true;

  // 2) ?token=<secret>
  const q = String(req.query?.token || "");
  if (q && q === secret) return true;

  json(res, 401, { ok: false, error: "Unauthorized (missing/invalid CRON_SECRET)" });
  return false;
}