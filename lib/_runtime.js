// lib/_runtime.js
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
    res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
    return false;
  }
  return true;
}