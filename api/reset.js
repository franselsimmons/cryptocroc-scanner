import { kv } from "@vercel/kv";

export const config = {
  runtime: "nodejs"
};

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const secret = url.searchParams.get("secret");

    if (!secret || secret !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    await kv.flushall();

    return res.status(200).json({
      success: true,
      message: "Scanner volledig gereset. Alles begint opnieuw."
    });
  } catch (err) {
    return res.status(500).json({
      error: "Reset failed",
      details: err.message
    });
  }
}