import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  try {
    const out = {
      has_BASE_URL: !!process.env.BASE_URL,
      has_CRON_SECRET: !!process.env.CRON_SECRET,
      has_KV_REST_API_URL: !!process.env.KV_REST_API_URL,
      has_KV_REST_API_TOKEN: !!process.env.KV_REST_API_TOKEN,
      has_KV_URL: !!process.env.KV_URL,
      has_KV_REST_API_READ_ONLY_TOKEN: !!process.env.KV_REST_API_READ_ONLY_TOKEN,
      has_DISCORD_WEBHOOK_ELITE_MOON: !!process.env.DISCORD_WEBHOOK_ELITE_MOON,
    };

    let kvOk = false;
    let kvError = null;

    try {
      await kv.set("moon:health:test", { ts: Date.now() }, { ex: 60 });
      const v = await kv.get("moon:health:test");
      kvOk = !!v;
    } catch (e) {
      kvError = String(e?.message || e);
    }

    res.status(200).json({
      ok: true,
      env: out,
      kvOk,
      kvError,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: String(e?.message || e),
    });
  }
}