import { kvDelAllIndexed } from "./_core.js";

export const config = { runtime: "nodejs" };

function okAuth(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  // 1) Cron header (Vercel style)
  const auth = req.headers.authorization || "";
  if (auth === `Bearer ${secret}`) return true;

  // 2) Reset link (handig voor jou): /api/reset?k=...
  // LET OP: dit is een "admin link", niet delen.
  const u = new URL(req.url, "http://localhost");
  const k = u.searchParams.get("k");
  if (k && k === secret) return true;

  return false;
}

export default async function handler(req, res) {
  try {
    if (!okAuth(req)) {
      res.statusCode = 401;
      res.end("Unauthorized");
      return;
    }

    await kvDelAllIndexed();

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, reset: true, ts: Date.now() }));
  } catch (e) {
    res.statusCode = 500;
    res.end(String(e));
  }
}
