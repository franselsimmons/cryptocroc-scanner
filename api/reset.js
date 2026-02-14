import { kv } from "@vercel/kv";
export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  try {
    const u = new URL(req.url, "http://localhost");

    const secret = u.searchParams.get("secret") || "";
    const mode = (u.searchParams.get("mode") || "all").toLowerCase();

    // beveiliging: RESET_SECRET > CRON_SECRET
    const expected = process.env.RESET_SECRET || process.env.CRON_SECRET;
    if (expected && secret !== expected) {
      res.statusCode = 401;
      res.end("Unauthorized");
      return;
    }

    const keys = [];
    if (mode === "bull" || mode === "all") {
      keys.push("latest:bull", "state:bull");
    }
    if (mode === "bear" || mode === "all") {
      keys.push("latest:bear", "state:bear");
    }
    // optional: Bitget symbol cache ook wissen
    keys.push("bitget:symbols:usdt");

    for (const k of keys) await kv.del(k);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: true, cleared: keys }));
  } catch (e) {
    res.statusCode = 500;
    res.end(String(e));
  }
}
