// lib/_runtime.js

// ✅ Vercel Node runtime config (wordt door api/* gebruikt)
export const RUNTIME_CONFIG = { runtime: "nodejs" };

// ✅ mode helper: bull/bear uit query halen (default bull)
export function getMode(req) {
  const m = String(req?.query?.mode || "bull").toLowerCase();
  return m === "bear" ? "bear" : "bull";
}

// ✅ secret check (accepteert óók Authorization: Bearer <secret>)
// ✅ accepteert MEERDERE mogelijke secrets (CC_SECRET / CRON_SECRET / etc)
export function requireSecret(req, res) {
  const expectedList = [
    process.env.CC_SECRET,
    process.env.SECRET,
    process.env.API_SECRET,
    process.env.CRON_SECRET,
  ].filter(Boolean);

  // Als je geen secret hebt gezet, blokkeren we niet.
  if (expectedList.length === 0) return true;

  const headers = req?.headers || {};
  const auth = headers["authorization"] || headers["Authorization"] || "";

  let bearer = "";
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    bearer = auth.slice(7).trim();
  }

  const got =
    req?.query?.secret ||
    headers["x-secret"] ||
    headers["x-api-key"] ||
    bearer;

  const ok = expectedList.includes(got);

  if (!ok) {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
    return false;
  }
  return true;
}