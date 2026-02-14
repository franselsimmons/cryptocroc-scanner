import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs" };

// Zelfde secret als cron (makkelijk): CRON_SECRET
function requireSecret(req) {
  const secret = process.env.CRON_SECRET ? String(process.env.CRON_SECRET).trim() : "";
  if (!secret) return; // als je geen secret wil, laat leeg (maar ik raad dat af)

  // 1) Header (veilig)
  const auth = req.headers?.authorization || req.headers?.Authorization || "";
  if (auth === `Bearer ${secret}`) return;

  // 2) Query param (handig als “klik-link”)
  const u = new URL(req.url, "http://localhost");
  const q = String(u.searchParams.get("secret") || "").trim();
  if (q && q === secret) return;

  const err = new Error("Unauthorized");
  err.statusCode = 401;
  throw err;
}

export default async function handler(req, res) {
  try {
    requireSecret(req);

    // Dit is jouw “geheugen” nu:
    // - laatste resultaten
    // - Bitget symbol cache
    await kv.del("latest:bull");
    await kv.del("latest:bear");
    await kv.del("bitget:usdt:symbols:v1");

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({
      ok: true,
      cleared: ["latest:bull", "latest:bear", "bitget:usdt:symbols:v1"],
      note: "Wacht daarna op de volgende cron (max 10 min) voor nieuwe vulling."
    }));
  } catch (e) {
    res.statusCode = e?.statusCode || 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}
