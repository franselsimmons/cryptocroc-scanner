import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs" };

function inspectUrl(value) {
  const raw = String(value || "");
  const trimmed = raw.trim();

  if (!trimmed) {
    return { present: false, valid: false, preview: "" };
  }

  try {
    const u = new URL(trimmed);
    return {
      present: true,
      valid: u.protocol === "http:" || u.protocol === "https:",
      preview: trimmed.slice(0, 80),
    };
  } catch {
    return {
      present: true,
      valid: false,
      preview: trimmed.slice(0, 80),
    };
  }
}

export default async function handler(req, res) {
  try {
    const env = {
      BASE_URL: inspectUrl(process.env.BASE_URL),
      KV_REST_API_URL: inspectUrl(process.env.KV_REST_API_URL),
      KV_URL: inspectUrl(process.env.KV_URL),
      DISCORD_WEBHOOK_ELITE_MOON: inspectUrl(process.env.DISCORD_WEBHOOK_ELITE_MOON),
      DISCORD_WEBHOOK_ALMOST_MOON: inspectUrl(process.env.DISCORD_WEBHOOK_ALMOST_MOON),
      DISCORD_WEBHOOK_BUILDUP_MOON: inspectUrl(process.env.DISCORD_WEBHOOK_BUILDUP_MOON),
      DISCORD_WEBHOOK_PORTFOLIO_MOON: inspectUrl(process.env.DISCORD_WEBHOOK_PORTFOLIO_MOON),

      has_CRON_SECRET: !!process.env.CRON_SECRET,
      has_KV_REST_API_TOKEN: !!process.env.KV_REST_API_TOKEN,
      has_KV_REST_API_READ_ONLY_TOKEN: !!process.env.KV_REST_API_READ_ONLY_TOKEN,
    };

    let kvWriteOk = false;
    let kvReadOk = false;
    let kvError = null;

    try {
      await kv.set("moon:health:test", { ts: Date.now() }, { ex: 60 });
      kvWriteOk = true;

      const v = await kv.get("moon:health:test");
      kvReadOk = !!v;
    } catch (e) {
      kvError = String(e?.message || e);
    }

    res.status(200).json({
      ok: true,
      env,
      kvWriteOk,
      kvReadOk,
      kvError,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: String(e?.message || e),
    });
  }
}