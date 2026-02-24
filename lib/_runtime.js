// /lib/_runtime.js

// =====================================================
// 1) Runtime config (nodig voor Vercel Node runtime)
// =====================================================
export const RUNTIME_CONFIG = {
  runtime: "nodejs"
};

// =====================================================
// 2) Mode helper (?mode=bull of ?mode=bear)
// =====================================================
export function getMode(req) {
  const m = String(req?.query?.mode || "").toLowerCase();
  if (m === "bear") return "bear";
  return "bull"; // default
}

// =====================================================
// 3) Secret check
// =====================================================
export function requireSecret(req, res) {
  const expected =
    process.env.CC_SECRET ||
    process.env.SECRET ||
    process.env.API_SECRET;

  // Als je geen secret hebt gezet, blokkeren we niet.
  if (!expected) return true;

  const got =
    req.query?.secret ||
    req.headers["x-secret"] ||
    req.headers["x-api-key"];

  if (got !== expected) {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({
      ok: false,
      error: "unauthorized"
    }));
    return false;
  }

  return true;
}