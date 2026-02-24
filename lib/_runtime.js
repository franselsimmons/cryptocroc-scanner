// lib/_runtime.js

// ✅ Vercel Node runtime config (wordt door api/* gebruikt)
export const RUNTIME_CONFIG = { runtime: "nodejs" };

// ✅ mode helper: bull/bear uit query halen (default bull)
export function getMode(req) {
  const m = String(req?.query?.mode || "bull").toLowerCase();
  return m === "bear" ? "bear" : "bull";
}

// ✅ secret check (accepteert óók Authorization: Bearer <secret>)
export function requireSecret(req, res) {
  const expected =
    process.env.CC_SECRET ||
    process.env.SECRET ||
    process.env.API_SECRET ||
    process.env.CRON_SECRET;

  // Als je geen secret hebt gezet, blokkeren we niet.
  if (!expected) return true;

  const headers = req?.headers || {};
  const auth =
    headers["authorization"] ||
    headers["Authorization"] ||
    "";

  // Bearer parsing
  let bearer = "";
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    bearer = auth.slice(7).trim();
  }

  const got =
    req?.query?.secret ||
    headers["x-secret"] ||
    headers["x-api-key"] ||
    bearer;

  if (got !== expected) {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
    return false;
  }
  return true;
}